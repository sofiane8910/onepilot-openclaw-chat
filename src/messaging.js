// Run a user message through the gateway, deliver the reply via the backend.

import { getAgentId } from "./env.js";
import { broadcast, progressUpsert, progressClear } from "./progress.js";

const HISTORY_LIMIT = 20;

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
export async function handleUserMessage(params) {
  const { api, accountId, account, userMessageRow, gatewayPort, gatewayToken, log } = params;
  const sessionId = userMessageRow.session_id;
  if (!sessionId) {
    log(`user row missing session_id, skipping`);
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
  // Subscribe to in-process agent events for this turn and forward
  // reasoning/tool deltas to Supabase Realtime so the iOS chat UI can render
  // a chain-of-thought trail. Best-effort: a broadcast or upsert failure must
  // not block the canonical assistant ingest path.
  const userIdLc = String(account.userId).toLowerCase();
  const agentProfileIdLc = String(account.agentProfileId).toLowerCase();
  const trail = { text: "" };
  const progressLog = (m, err) => {
    if (err) log(`[progress] ${m}: ${String(err)}`);
    else log(`[progress] ${m}`);
  };
  const appendTrail = async (line) => {
    if (!line || trail.text.endsWith(line)) return;
    trail.text += line;
    await progressUpsert(account, sessionId, userIdLc, agentProfileIdLc, trail.text, progressLog);
  };
  // OpenClaw exposes the in-process agent-event bus to plugins through
  // `api.runtime.events.onAgentEvent` — the runtime sub-object on
  // OpenClawPluginApi (see plugins/types.ts:1330). Older shapes that exposed
  // `api.events` directly are also tolerated; if neither is present the
  // plugin no-ops the listener and falls back to delivering only the final
  // reply.
  const subscribe = api?.runtime?.events?.onAgentEvent ?? api?.events?.onAgentEvent;
  log(`[cot] subscribe-available=${typeof subscribe === "function"} peerSessionKey=${peerSessionKey} session=${String(sessionId).slice(0, 8)}`);
  // Diagnostic counters — logged at done/error so we can tell at a glance
  // whether events are arriving at all, whether the sessionKey filter is
  // dropping them, and whether the broadcast path is firing.
  const counters = { received: 0, matched: 0, thinking: 0, tool: 0, other: 0, dropped: 0, tool_starts: 0 };
  // Sample a few unmatched session keys so we can see if the filter is wrong.
  const seenSessionKeys = new Set();
  // Sample the first occurrence of each non-tool/thinking stream so we can
  // see what's in the "other" bucket without flooding the gateway log.
  const seenOtherStreams = new Map();
  // Build a verbose, useful label out of a tool's args so iOS shows
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
      "cmd", "command", "shell", // exec/process/shell tools
      "url", "href",              // web_fetch / web_search
      "path", "filepath", "file", "filename", // file ops
      "query", "q",               // search
      "pattern",                  // grep/glob
      "to", "channel",            // messaging
      "name",                     // generic
    );
    if (!detail) return name;
    const trimmed = detail.length > 80 ? detail.slice(0, 80) + "…" : detail;
    return `${name} ${trimmed}`;
  };
  const unsubscribe = typeof subscribe === "function"
    ? subscribe((evt) => {
    if (!evt) return;
    counters.received++;
    if (counters.received <= 5) {
      // Bounded: only log the first few to keep noise down on long runs.
      log(`[cot] evt #${counters.received} stream=${evt.stream} runId=${String(evt.runId ?? "").slice(0, 8)} sessionKey=${evt.sessionKey ?? "<none>"} dataKeys=${Object.keys(evt.data ?? {}).join(",")}`);
    }
    if (evt.sessionKey !== peerSessionKey) {
      counters.dropped++;
      if (evt.sessionKey && seenSessionKeys.size < 5 && !seenSessionKeys.has(evt.sessionKey)) {
        seenSessionKeys.add(evt.sessionKey);
        log(`[cot] dropped event with non-matching sessionKey=${evt.sessionKey} (expected=${peerSessionKey})`);
      }
      return;
    }
    counters.matched++;
    if (evt.stream === "thinking") {
      counters.thinking++;
      const data = evt.data ?? {};
      const text = typeof data.delta === "string" && data.delta
        ? data.delta
        : (typeof data.text === "string" ? data.text : "");
      if (!text) {
        log(`[cot] thinking event matched but no text/delta — keys=${Object.keys(data).join(",")}`);
        return;
      }
      void broadcast(account, sessionId, "reasoning_delta", { text }, progressLog);
      void appendTrail(text);
    } else if (evt.stream === "tool") {
      counters.tool++;
      const data = evt.data ?? {};
      // OpenClaw fires tool events at three phases: start / update / end.
      // We only broadcast on `start` so iOS shows one row per actual tool
      // invocation, not three. The other phases still increment the
      // counter for diagnostics.
      if (data.phase && data.phase !== "start") return;
      counters.tool_starts++;
      const name = typeof data.name === "string"
        ? data.name
        : (typeof data.tool === "string" ? data.tool : "tool");
      const emoji = typeof data.emoji === "string" ? data.emoji : "→";
      // Prefer an explicit upstream label, otherwise derive a verbose one
      // from args so iOS shows `exec ls -la` instead of bare `exec`.
      const label = typeof data.label === "string" && data.label
        ? data.label
        : buildToolLabel(name, data.args);
      log(`[cot] tool start name=${name} label=${label.slice(0, 80)}`);
      void broadcast(account, sessionId, "tool_progress", { tool: name, emoji, label }, progressLog);
      void appendTrail(`${emoji} ${label}\n`);
    } else {
      counters.other++;
      // Capture one sample per distinct non-tool/thinking stream so we can
      // tell what's in there (likely `assistant` deltas — but worth
      // confirming on each runtime version).
      if (evt.stream && !seenOtherStreams.has(evt.stream)) {
        const data = evt.data ?? {};
        seenOtherStreams.set(evt.stream, Object.keys(data).join(","));
        log(`[cot] other stream=${evt.stream} dataKeys=${seenOtherStreams.get(evt.stream)}`);
      }
    }
      })
    : () => {};
  // Surface counters at the end of the turn — both in the gateway log AND as
  // a broadcast event so the iOS app's broadcast log shows them next to the
  // existing `started`/`done` lines, no host SSH required to debug a
  // zero-event session.
  const sampleSessionKey = (() => {
    for (const k of seenSessionKeys) return k;
    return null;
  })();
  const logCotSummary = () => {
    log(`[cot] summary received=${counters.received} matched=${counters.matched} thinking=${counters.thinking} tool=${counters.tool} other=${counters.other} dropped=${counters.dropped} subscribe=${typeof subscribe === "function"} trail=${trail.text.length}b sample-key=${sampleSessionKey ?? "<none>"}`);
  };
  const cotDiagPayload = () => {
    // Build a `stream=keys|stream=keys` summary of the first few unique
    // non-tool/thinking streams we saw. Bounded length for the broadcast.
    const otherStreamsList = [];
    for (const [stream, keys] of seenOtherStreams) {
      otherStreamsList.push(`${stream}=${keys}`);
      if (otherStreamsList.length >= 3) break;
    }
    return {
      cot_subscribe_available: typeof subscribe === "function",
      cot_received: counters.received,
      cot_matched: counters.matched,
      cot_thinking: counters.thinking,
      cot_tool: counters.tool,
      cot_tool_starts: counters.tool_starts,
      cot_other: counters.other,
      cot_other_streams: otherStreamsList.join("|"),
      cot_dropped: counters.dropped,
      cot_trail_bytes: trail.text.length,
      cot_expected_session_key: peerSessionKey,
      cot_sample_dropped_session_key: sampleSessionKey ?? "",
    };
  };

  await broadcast(account, sessionId, "started", {}, progressLog);

  // Wrap the entire turn so the in-process listener is always torn down and
  // the agent_session_progress row is always cleared, regardless of success
  // path, error path, or early return.
  let cleanedUp = false;
  const finalize = async (kind, errMessage) => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { unsubscribe(); } catch { /* noop */ }
    logCotSummary();
    // Inline the counters into done/error payloads — iOS only subscribes to
    // a fixed list of event names (RealtimeMessageListener), so a separate
    // `cot_diag` event never reaches the app. The chat VM's done/error
    // handlers ignore unknown keys; flatten() surfaces them in the broadcast
    // log so they're visible without host-side SSH.
    const diag = cotDiagPayload();
    if (kind === "error") {
      await broadcast(account, sessionId, "error", { message: errMessage ?? "", ...diag }, progressLog);
    } else {
      await broadcast(account, sessionId, "done", diag, progressLog);
    }
    await progressClear(account, sessionId, progressLog);
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
      reply = await readSseAssistantText(res, log);
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

async function readSseAssistantText(res, log) {
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
        if (typeof delta === "string") acc += delta;
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
