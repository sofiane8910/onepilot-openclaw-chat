// Run a user message through the gateway, deliver the reply via the backend.

import { getAgentId } from "./env.js";
import { broadcast, progressUpsert, progressFinalize } from "./progress.js";

const HISTORY_LIMIT = 20;

// Heartbeat thresholds for silent-think models. iOS marks a session
// "stalled" after ~25s of broadcast silence (AgentChatViewModel
// stallThresholdSeconds). When the openclaw runtime is firing events
// for our session but none of them are tool/thinking (e.g. a long
// pre-tool plan, or assistant-stream-only models), we keep the iOS
// heartbeat warm by broadcasting an empty `reasoning_delta` — iOS's
// extendReplyDeadline() runs before its empty-text guard
// (AgentChatViewModel.swift:321), so trail rendering is unchanged.
const HEARTBEAT_CHECK_INTERVAL_MS = 5_000;
const HEARTBEAT_BROADCAST_AFTER_MS = 18_000;
const HEARTBEAT_LIVENESS_WINDOW_MS = 20_000;

/**
 * @param {{
 *   api: any,
 *   accountId: string,
 *   account: {
 *     backendUrl: string,
 *     streamUrl: string,
 *     publishableKey: string,
 *     agentKey: string,
 *     userId: string,
 *     agentProfileId: string,
 *     sessionKey: string,
 *   },
 *   userMessageRow: any,
 *   gatewayPort: number,
 *   gatewayToken: string,
 *   log: (msg: string, err?: unknown) => void,
 * }} params
 */
// Match `/approve <id> <decision>` regardless of leading/trailing whitespace.
// `id` accepts UUIDs, short codes (8-char prefix), and any token shape the
// upstream lookupPendingId knows how to resolve.
const APPROVE_REGEX = /^\s*\/approve\s+([\w-]+)\s+(allow-once|allow-always|deny)\b/i;

async function maybeHandleApproveCommand({ account, userMessageRow, gatewayPort, gatewayToken, log }) {
  const text = (function extract(c) {
    if (typeof c === "string") {
      try { return extract(JSON.parse(c)); } catch { return c; }
    }
    if (Array.isArray(c)) {
      const part = c.find((p) => p && (p.type === "text" || !p.type) && typeof p.text === "string");
      return part?.text ?? "";
    }
    if (c && typeof c === "object" && typeof c.text === "string") return c.text;
    return "";
  })(userMessageRow.content);

  const m = APPROVE_REGEX.exec(text || "");
  if (!m) return false;
  const approvalId = m[1];
  const decision = m[2].toLowerCase();

  log(`/approve detected: id=${approvalId.slice(0, 8)} decision=${decision} — resolving via in-memory gate`);

  // Approval gate is in approvals-gate.js. Resolution unblocks the awaiting
  // promise registered by the before_tool_call hook.
  const { applyDecision } = await import("./approvals-gate.js");
  const matched = applyDecision(approvalId, decision);
  const resultText = matched
    ? `✅ Approval ${decision} submitted for \`${approvalId.slice(0, 8)}\`.`
    : `⚠️ Approval \`${approvalId.slice(0, 8)}\` was already resolved or expired.`;
  log(`/approve ${matched ? "matched and resolved" : "no pending entry"}`);

  // Post the confirmation as an assistant reply so the user sees feedback in chat.
  const userIdLc = String(account.userId).toLowerCase();
  const agentProfileIdLc = String(account.agentProfileId).toLowerCase();
  try {
    const url = `${account.backendUrl}/functions/v1/agent-message-ingest`;
    const body = JSON.stringify({
      userId: userIdLc,
      agentProfileId: agentProfileIdLc,
      sessionKey: userMessageRow.session_key ?? account.sessionKey,
      role: "assistant",
      content: [{ type: "text", text: resultText }],
      timestamp: Date.now(),
    });
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${account.agentKey}`,
      },
      body,
    });
  } catch (err) {
    log(`/approve confirmation post failed`, err);
  }
  return true;
}

export async function handleUserMessage(params) {
  const { api, accountId, account, userMessageRow, gatewayPort, gatewayToken, log } = params;
  const sessionId = userMessageRow.session_id;
  if (!sessionId) {
    log(`user row missing session_id, skipping`);
    return;
  }

  // Intercept `/approve <id> <decision>` before dispatching to the model.
  // Without this, OpenClaw's auto-reply pipeline never runs (we go directly
  // to /v1/chat/completions which bypasses commands-approve.ts) and the
  // model treats the approval text as a regular question. Resolves via
  // `exec.approval.resolve` JSON-RPC against the local gateway.
  if (await maybeHandleApproveCommand({ account, userMessageRow, gatewayPort, gatewayToken, log })) {
    return;
  }

  let history;
  try {
    history = await loadHistory(account, sessionId);
  } catch (err) {
    log(`failed to load history`, err);
    return;
  }

  // Skip if a foreground client (open Onepilot app) already replied.
  const userCreatedAt = userMessageRow.created_at;
  if (Array.isArray(history)) {
    const hasNewerAssistant = history.some(
      (row) =>
        row?.role === "assistant" &&
        typeof row?.created_at === "string" &&
        typeof userCreatedAt === "string" &&
        row.created_at > userCreatedAt,
    );
    if (hasNewerAssistant) {
      log(`session ${String(sessionId).slice(0, 8)} already has an assistant reply — skipping`);
      return;
    }
  }

  const messages = normalizeHistory(history);

  // The x-openclaw-* headers route this turn through the `onepilot` channel
  // so any cron the agent sets up inherits the right delivery channel
  // (vs the default `webchat` which the gateway hard-blocks for delivery).
  // peerSessionKey shape (`<channel>:direct:<peerId>`) lets the cron tool
  // auto-fill `delivery: { mode: "announce", channel, to }`.
  const agentId = getAgentId();
  const peerId = String(account.userId).trim().toLowerCase();
  const peerSessionKey = `agent:${agentId}:onepilot:direct:${peerId}`;

  // --- Live progress fan-out (mirrors Hermes) -------------------------------
  // Subscribe to the in-process agent event bus and forward reasoning/tool
  // deltas to Supabase Realtime so the iOS chat UI can render the agent's
  // chain-of-thought live. Best-effort: a broadcast or upsert failure must
  // never block the canonical assistant ingest path.
  const userIdLc = String(account.userId).toLowerCase();
  const agentProfileIdLc = String(account.agentProfileId).toLowerCase();
  // Live state mirrors the Hermes plugin (onepilot-hermes-chat/__init__.py).
  // The row carries everything iOS needs to rebuild the in-flight UI on
  // app-reopen / scenePhase=.active / conversation-reopen — Lottie spinner,
  // status pill, partial response, reasoning trail.
  const trail = { text: "" };
  const partial = { text: "" };
  const status = { text: "Thinking…" };
  const progressLog = (m, err) => log(err ? `[progress] ${m}: ${String(err)}` : `[progress] ${m}`);
  const upsertTrail = async (line) => {
    if (!line || trail.text.endsWith(line)) return;
    trail.text += line;
    await progressUpsert(
      account, sessionId, userIdLc, agentProfileIdLc,
      { reasoningText: trail.text, isActive: true },
      progressLog,
    );
  };
  const upsertStatus = async (next) => {
    if (!next || next === status.text) return;
    status.text = next;
    await progressUpsert(
      account, sessionId, userIdLc, agentProfileIdLc,
      { statusLabel: status.text, isActive: true },
      progressLog,
    );
  };
  const upsertPartial = async (delta) => {
    if (!delta) return;
    partial.text += delta;
    await progressUpsert(
      account, sessionId, userIdLc, agentProfileIdLc,
      { partialResponse: partial.text, isActive: true },
      progressLog,
    );
  };
  // OpenClawPluginApi exposes the agent-event bus at api.runtime.events
  // (see openclaw plugins/types.ts:1330). If a future shape drops it the
  // listener no-ops and the turn still delivers the final assistant reply.
  const subscribe = api?.runtime?.events?.onAgentEvent;
  // Build a verbose label from the tool's args so iOS shows
  // `exec ls -la /etc` instead of just `exec`. Bounded so a giant arg
  // string can't blow up the broadcast payload.
  const buildToolLabel = (name, args) => {
    if (!args || typeof args !== "object") return name;
    const pickFirst = (...keys) => {
      for (const k of keys) {
        const v = args[k];
        if (typeof v === "string" && v.trim()) return v.trim();
        if (typeof v === "number") return String(v);
      }
      return null;
    };
    const detail = pickFirst(
      "cmd", "command", "shell",                // exec/process/shell tools
      "url", "href",                            // web_fetch / web_search
      "path", "filepath", "file", "filename",   // file ops
      "query", "q",                             // search
      "pattern",                                // grep/glob
      "to", "channel",                          // messaging
      "name",                                   // generic
    );
    if (!detail) return name;
    return `${name} ${detail.length > 80 ? detail.slice(0, 80) + "…" : detail}`;
  };
  // Single end-of-turn diagnostic line — kept because it's the cheapest
  // way to tell whether the listener still works if streaming regresses.
  const counters = { received: 0, tool: 0, thinking: 0, other: 0, heartbeat: 0 };
  // Liveness tracking. `lastAgentEventAt` proves the openclaw runtime is
  // still producing output for our turn (tool, thinking, OR assistant /
  // lifecycle / context — anything with our sessionKey). `lastBroadcastAt`
  // tracks when iOS last received something from us — the value the
  // heartbeat keeps fresh so iOS's stall flag doesn't false-positive.
  let lastAgentEventAt = Date.now();
  let lastBroadcastAt = Date.now();
  const unsubscribe = typeof subscribe === "function"
    ? subscribe((evt) => {
        if (!evt || evt.sessionKey !== peerSessionKey) return;
        counters.received++;
        lastAgentEventAt = Date.now();
        if (evt.stream === "thinking") {
          counters.thinking++;
          const data = evt.data ?? {};
          const text = typeof data.delta === "string" && data.delta
            ? data.delta
            : (typeof data.text === "string" ? data.text : "");
          if (!text) return;
          void broadcast(account, sessionId, "reasoning_delta", { text }, progressLog);
          lastBroadcastAt = Date.now();
          void upsertTrail(text);
        } else if (evt.stream === "tool") {
          counters.tool++;
          const data = evt.data ?? {};
          // OpenClaw fires tool events at three phases (start / update /
          // end). We broadcast only `start` so iOS shows one row per
          // actual tool invocation rather than three.
          if (data.phase && data.phase !== "start") return;
          const name = typeof data.name === "string"
            ? data.name
            : (typeof data.tool === "string" ? data.tool : "tool");
          const emoji = typeof data.emoji === "string" ? data.emoji : "→";
          const label = typeof data.label === "string" && data.label
            ? data.label
            : buildToolLabel(name, data.args);
          void broadcast(account, sessionId, "tool_progress", { tool: name, emoji, label }, progressLog);
          lastBroadcastAt = Date.now();
          void upsertTrail(`${emoji} ${label}\n`);
          void upsertStatus(name ? `Running ${name}…` : (label || "Working…"));
        } else {
          counters.other++;
        }
      })
    : () => {};

  await broadcast(account, sessionId, "started", {}, progressLog);
  lastBroadcastAt = Date.now();
  // Seed the live state row so iOS can render the Lottie + status pill
  // even before the first reasoning/tool event arrives. Subsequent
  // upserts merge-duplicate on session_id (the PK).
  await progressUpsert(
    account, sessionId, userIdLc, agentProfileIdLc,
    {
      reasoningText: "",
      partialResponse: "",
      statusLabel: status.text,
      isActive: true,
      setStartedAt: true,
    },
    progressLog,
  );

  // Heartbeat: when the agent is alive (lastAgentEventAt is recent) but
  // we haven't broadcast anything to iOS in a while, fire an empty
  // reasoning_delta so iOS's extendReplyDeadline() resets and the spinner
  // doesn't false-positive into the stalled state. Event-driven: if the
  // gateway truly hangs, lastAgentEventAt freezes and the heartbeat goes
  // silent — iOS's 25s stall flag still fires for genuine hangs.
  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const agentAlive = now - lastAgentEventAt < HEARTBEAT_LIVENESS_WINDOW_MS;
    const broadcastStale = now - lastBroadcastAt > HEARTBEAT_BROADCAST_AFTER_MS;
    if (agentAlive && broadcastStale) {
      counters.heartbeat++;
      lastBroadcastAt = now;
      void broadcast(account, sessionId, "reasoning_delta", { text: "" }, progressLog);
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);
  heartbeatTimer.unref?.();

  // Wrap the entire turn so the in-process listener is always torn down and
  // the agent_session_progress row is always cleared, regardless of success
  // path, error path, or early return.
  let cleanedUp = false;
  const finalize = async (kind, errMessage) => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { unsubscribe(); } catch { /* noop */ }
    clearInterval(heartbeatTimer);
    log(`[turn] received=${counters.received} tool=${counters.tool} thinking=${counters.thinking} other=${counters.other} heartbeat=${counters.heartbeat} trail=${trail.text.length}b`);
    if (kind === "error") {
      await broadcast(account, sessionId, "error", { message: errMessage ?? "" }, progressLog);
    } else {
      await broadcast(account, sessionId, "done", {}, progressLog);
    }
    await progressFinalize(account, sessionId, userIdLc, agentProfileIdLc, progressLog);
  };

  try {
    // stream:true keeps the connection alive across long thinks even though
    // we accumulate the whole reply locally and POST once at end-of-stream.
    let reply;
    try {
      const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${gatewayToken}`,
          "x-openclaw-message-channel": "onepilot",
          "x-openclaw-account-id": accountId,
          "x-openclaw-message-to": userMessageRow.session_key ?? account.sessionKey,
          "x-openclaw-session-key": peerSessionKey,
          "Accept": "text/event-stream",
        },
        body: JSON.stringify({
          model: "openclaw",
          messages,
          stream: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        const errMsg = `gateway /v1/chat/completions returned ${res.status}: ${body.slice(0, 200)}`;
        log(errMsg);
        await finalize("error", errMsg);
        return;
      }
      reply = await readSseAssistantText(res, log, (delta) => {
        // Forward visible content as it streams so iOS can rebuild the
        // partial-response bubble after a disconnect. The final assistant
        // INSERT still lands via the canonical ingest path; this is purely
        // the in-flight snapshot.
        void upsertPartial(delta);
      });
    } catch (err) {
      log(`gateway call failed`, err);
      await finalize("error", `gateway call failed: ${String(err?.message ?? err)}`);
      return;
    }

    if (!reply) {
      log(`gateway returned no assistant text`);
      await finalize("error", "gateway returned no assistant text");
      return;
    }

    try {
      const url = `${account.backendUrl}/functions/v1/agent-message-ingest`;
      const deliverBody = JSON.stringify({
        userId: userIdLc,
        agentProfileId: agentProfileIdLc,
        sessionKey: userMessageRow.session_key ?? account.sessionKey,
        role: "assistant",
        content: [{ type: "text", text: reply }],
        timestamp: Date.now(),
      });
      const deliverRes = await postIngestWithRetry(url, account.agentKey, deliverBody, log);
      if (!deliverRes.ok) {
        const body = await deliverRes.text();
        log(`message POST returned ${deliverRes.status} after retries: ${body.slice(0, 200)} — sending user-visible fallback`);
        await sendDeliveryFailureNotice({
          url,
          agentKey: account.agentKey,
          userIdLc,
          agentProfileIdLc,
          sessionKey: userMessageRow.session_key ?? account.sessionKey,
          log,
        });
        return;
      }
      log(`assistant reply delivered (${reply.length} chars)`);
    } catch (err) {
      log(`message POST failed`, err);
      try {
        const url = `${account.backendUrl}/functions/v1/agent-message-ingest`;
        await sendDeliveryFailureNotice({
          url,
          agentKey: account.agentKey,
          userIdLc,
          agentProfileIdLc,
          sessionKey: userMessageRow.session_key ?? account.sessionKey,
          log,
        });
      } catch (notifyErr) {
        log(`fallback notice also failed`, notifyErr);
      }
    }
  } finally {
    // Successful path or any other early return lands here as `done`. The
    // error paths above call finalize("error", …) explicitly before returning,
    // so cleanedUp is already true and this falls through.
    await finalize("done");
  }
}

async function sendDeliveryFailureNotice({ url, agentKey, userIdLc, agentProfileIdLc, sessionKey, log }) {
  const noticeBody = JSON.stringify({
    userId: userIdLc,
    agentProfileId: agentProfileIdLc,
    sessionKey,
    role: "assistant",
    content: [{
      type: "text",
      text: "⚠ I generated a reply but couldn't reach the server to deliver it. Please send your message again.",
    }],
    timestamp: Date.now(),
  });
  const delays = [500, 1500];
  let lastRes;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      lastRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${agentKey}`,
        },
        body: noticeBody,
      });
    } catch (err) {
      if (attempt === delays.length) {
        log(`fallback notice network error, giving up: ${err?.message ?? err}`);
        return;
      }
      await new Promise((r) => setTimeout(r, delays[attempt]));
      continue;
    }
    if (lastRes.ok) {
      log(`fallback notice delivered to user`);
      return;
    }
    if (lastRes.status < 500 || attempt === delays.length) {
      log(`fallback notice failed: ${lastRes.status} (final)`);
      return;
    }
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }
}

async function loadHistory(account, sessionId) {
  const url = `${account.backendUrl}/functions/v1/agent-message-history?session_id=${encodeURIComponent(sessionId)}&limit=${HISTORY_LIMIT}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${account.agentKey}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`history load failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return Array.isArray(json?.messages) ? json.messages : [];
}

function normalizeHistory(rows) {
  return rows
    .slice()
    .reverse()
    .map((row) => ({ role: row.role, content: extractText(row.content) }))
    .filter((m) => m.content);
}

function extractText(content) {
  if (content == null) return "";
  if (typeof content === "string") {
    try {
      return extractText(JSON.parse(content));
    } catch {
      return content;
    }
  }
  if (Array.isArray(content)) {
    const textPart = content.find(
      (p) => p && typeof p === "object" && (p.type === "text" || !p.type) && typeof p.text === "string",
    );
    return textPart?.text ?? "";
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

async function readSseAssistantText(res, log, onDelta) {
  const decoder = new TextDecoder();
  let buf = "";
  let acc = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const delta = j?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          acc += delta;
          if (typeof onDelta === "function") {
            try { onDelta(delta); } catch { /* best-effort */ }
          }
        }
      } catch (err) {
        log(`sse parse error (skipping line): ${err?.message ?? err}`);
      }
    }
  }
  return acc;
}

async function postIngestWithRetry(url, agentKey, body, log) {
  // ~60s budget across 8 attempts to ride out worker recycles + brief drops.
  const delays = [500, 1000, 2000, 4000, 8000, 15000, 30000];
  let lastRes;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      lastRes = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${agentKey}`,
        },
        body,
      });
    } catch (err) {
      if (attempt === delays.length) throw err;
      log(`ingest network error (attempt ${attempt + 1}), retrying: ${err?.message ?? err}`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
      continue;
    }
    if (lastRes.status < 500 || attempt === delays.length) return lastRes;
    log(`ingest got ${lastRes.status} (attempt ${attempt + 1}), retrying`);
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }
  return lastRes;
}
