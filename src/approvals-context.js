// Approval-context injection for the model.
//
// When our before_tool_call gate approves a tool, we record the decision
// here. The tool_result_persist hook (registered separately in index.js)
// reads this map and prepends a marker to the tool's result message before
// it lands in the session transcript. The model reads the transcript on
// its next inference, so the marker becomes natural context — no system
// prompt change, no upstream OpenClaw modification.
//
// In production we observed the model hallucinating "approvals aren't
// active" because it inspected upstream openclaw.json (which v0.9 no
// longer patches) and didn't find an `approvals.exec.*` block. The
// marker tells the model in-band that a gate ran and the user explicitly
// allowed the run.

// (sessionKey:toolName:toolCallId) → {decision, decidedAtMs}
const _recentApprovals = new Map();
const TTL_MS = 5 * 60 * 1000; // GC bound; way longer than any tool roundtrip

function key(sessionKey, toolName, toolCallId) {
  return `${sessionKey ?? ""}:${toolName ?? ""}:${toolCallId ?? ""}`;
}

function gc() {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of _recentApprovals) {
    if (v.decidedAtMs < cutoff) _recentApprovals.delete(k);
  }
}

/**
 * Called from approvals-gate after `awaitDecision` resolves with allow.
 * Stores the decision so the persist hook can find it by the same triple
 * (sessionKey, toolName, toolCallId).
 */
export function recordApproval({ sessionKey, toolName, toolCallId, decision }) {
  _recentApprovals.set(key(sessionKey, toolName, toolCallId), {
    decision,
    decidedAtMs: Date.now(),
  });
  gc();
}

/**
 * Build the tool_result_persist hook. Matches the recorded approval (one-shot
 * — the entry is deleted on consumption) and prepends a brief marker to the
 * tool result content so the model sees it on its next inference. Returns
 * undefined when no approval is on file → the hook is a no-op for tools
 * that didn't go through our gate.
 */
export function buildToolResultPersistHook({ log }) {
  return function toolResultPersistHook(event, ctx) {
    const k = key(ctx?.sessionKey, event?.toolName, event?.toolCallId);
    const approval = _recentApprovals.get(k);
    if (!approval) return undefined;
    _recentApprovals.delete(k);

    const msg = event?.message;
    if (!msg) return undefined;

    const marker =
      `[Onepilot: this command was explicitly approved by the user via the mobile app ` +
      `(${approval.decision}) before it ran.]`;

    let nextContent;
    if (typeof msg.content === "string") {
      nextContent = `${marker}\n\n${msg.content}`;
    } else if (Array.isArray(msg.content)) {
      nextContent = [{ type: "text", text: marker }, ...msg.content];
    } else {
      // Unknown shape — skip rather than break the persist path.
      return undefined;
    }

    log?.(`injected approval marker into tool result toolCallId=${String(event.toolCallId).slice(0, 8)}`);
    return { message: { ...msg, content: nextContent } };
  };
}
