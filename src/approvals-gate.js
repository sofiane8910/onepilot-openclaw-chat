// Approval gate that runs entirely inside this plugin.
//
// Why not OpenClaw's exec-approvals:
//   - exec.approval.resolve requires `operator.approvals` scope, which is
//     stripped from any handshake without a device-signed identity (see
//     openclaw/src/gateway/server/ws-connection/message-handler.ts:542-550).
//   - The plugin runs in the gateway process but doesn't have a paired
//     device, and self-pairing-from-plugin is a sizable detour.
//
// Instead we hook `before_tool_call` (a public plugin SDK seam) and own the
// gate ourselves: broadcast `approval_requested` to iOS, await the user's
// `/approve <id> <decision>` chat reply via an in-memory promise map,
// return `{block, blockReason}` to OpenClaw. Clean and scope-free.

import { randomUUID } from "node:crypto";
import { broadcast } from "./progress.js";
import { isApprovalsForwardingEnabled } from "./approvals.js";

// Tool-name allowlist for "this is an exec-shaped tool that should ask".
// Mirrors the upstream allowlist intent without depending on its config.
const EXEC_TOOL_NAMES = new Set([
  "system.run",
  "exec",
  "bash",
  "shell",
  "run",
]);

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min, matches upstream

const _pending = new Map(); // approvalId → { resolve, timer, sessionId, account }

/**
 * Submit a decision for a pending approval. Called by the `/approve`
 * interceptor in messaging.js when the user types or taps the button.
 * Returns true if the decision was applied, false if no matching
 * approval was pending (timeout or already resolved).
 */
export function applyDecision(approvalId, decision) {
  const entry = _pending.get(approvalId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  _pending.delete(approvalId);
  entry.resolve(decision);
  return true;
}

/**
 * Run the gate for one tool call. Returns the user's decision string,
 * or rejects on timeout. Caller maps decision → {block, blockReason}.
 */
async function awaitDecision({ approvalId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(approvalId);
      reject(new Error("approval timeout"));
    }, timeoutMs);
    _pending.set(approvalId, { resolve, timer });
  });
}

/**
 * Build the broadcast payload. Mirrors the schema iOS already decodes
 * (see ApprovalRequest in OpenClawChatTransport.swift).
 */
function buildPayload({ approvalId, event, ctx }) {
  const argv = Array.isArray(event.params?.argv) ? event.params.argv : [];
  const command =
    typeof event.params?.command === "string"
      ? event.params.command
      : argv.join(" ");
  return {
    approval_id: approvalId,
    framework: "openclaw",
    tool_name: event.toolName,
    command,
    argv,
    cwd: typeof event.params?.cwd === "string" ? event.params.cwd : null,
    session_key: ctx.sessionKey ?? null,
    agent_id: ctx.agentId ?? null,
    security: "medium",
    expires_at_ms: Date.now() + DEFAULT_TIMEOUT_MS,
    allowed_decisions: ["allow-once", "allow-always", "deny"],
  };
}

/**
 * The actual hook. Resolves the routing context (account + sessionId for
 * Realtime broadcast) from the channel registry — `lookupSessionId` and
 * `accounts` are passed in to keep the gate decoupled from index.js'
 * private state.
 */
export function buildBeforeToolCallHook({ accounts, lookupSessionId, lookupAnySessionForAccount, log }) {
  return async function beforeToolCallHook(event, ctx) {
    if (!EXEC_TOOL_NAMES.has(event.toolName)) return undefined;
    if (!(await isApprovalsForwardingEnabled())) return undefined;

    // Resolve account + sessionId for the broadcast. The hook ctx exposes
    // an *agent-internal* sessionKey (e.g. `agent:claw1:onepilot:direct:<userId>`)
    // — that's NOT the chat sessionKey iOS messages use ("main"). Look up
    // by the account's configured chat sessionKey, not ctx.sessionKey.
    const accountId = "default";
    const account = accounts?.[accountId];
    if (!account) {
      log?.(`[gate] no account configured — letting tool through (open)`);
      return undefined;
    }
    const chatSessionKey = account.sessionKey || "main";
    let sessionId = lookupSessionId(accountId, chatSessionKey);
    // Final fallback: any cached session_id for this account. The cache is
    // populated by inbound user-message rows, so a recent message in any
    // session means iOS is listening on something we know about. Better
    // than letting tool through silently.
    if (!sessionId) {
      const anySession = lookupAnySessionForAccount(accountId);
      if (anySession) {
        log?.(`[gate] no sessionId for chat sessionKey="${chatSessionKey}" — falling back to most-recently-cached session=${String(anySession).slice(0, 8)}`);
        sessionId = anySession;
      }
    }
    if (!sessionId) {
      log?.(`[gate] no cached session_id for account "${accountId}" — letting tool through to avoid deadlock (send any iOS message first to populate cache)`);
      return undefined;
    }

    const approvalId = randomUUID();
    const payload = buildPayload({ approvalId, event, ctx });
    log?.(`[gate] approval_requested id=${approvalId.slice(0, 8)} tool=${event.toolName} cmd="${String(payload.command).slice(0, 80)}"`);
    try {
      await broadcast(account, sessionId, "approval_requested", payload, log);
    } catch (err) {
      log?.(`[gate] broadcast failed — letting tool through`, err);
      return undefined;
    }

    let decision;
    try {
      decision = await awaitDecision({ approvalId });
    } catch (err) {
      log?.(`[gate] approval timeout id=${approvalId.slice(0, 8)} — denying`);
      // Fire-and-forget resolved broadcast so iOS dismisses the bubble.
      broadcast(account, sessionId, "approval_resolved",
        { approval_id: approvalId, decision: "deny", reason: "timeout" }, log).catch(() => {});
      return { block: true, blockReason: "Approval timed out (30 min)" };
    }

    log?.(`[gate] approval_resolved id=${approvalId.slice(0, 8)} decision=${decision}`);
    broadcast(account, sessionId, "approval_resolved",
      { approval_id: approvalId, decision }, log).catch(() => {});

    if (decision === "deny") {
      return { block: true, blockReason: "Denied by user" };
    }
    // allow-once and allow-always both proceed. allow-always could be
    // persisted to a per-(agentId, command-pattern) allowlist for future
    // calls; deferred — single-tap UX matters more than power-user feature.
    return undefined;
  };
}
