// Live agent-progress fan-out: realtime broadcasts + recoverable trail upsert.
//
// Mirrors the Hermes plugin's _broadcast / _progress_upsert / _progress_clear
// (onepilotapp/plugins/hermes/onepilot-platform/__init__.py:383-479) so the iOS
// chat UI sees identical event names, payload shapes, and topic routing for
// both frameworks. The iOS handler is framework-agnostic — keeping these
// helpers byte-for-byte aligned with the Hermes contract is what makes the
// rendering path "Just Work" without any iOS change.
//
// All three calls are best-effort: a failure here must NOT block the canonical
// assistant-reply ingest path. Debug-level logging only, never error-level —
// a missing realtime broadcast or progress row never warrants a user-visible
// alert because the final reply still ships through agent-message-ingest.

const BROADCAST_TIMEOUT_MS = 3000;

/**
 * iOS Realtime topic for a given session id. Must match the Swift client's
 * `messages_<UUID first-8 uppercase>` format (case-sensitive — Phoenix
 * matches topics literally). Also must match Hermes's _channel_for_session
 * exactly so a single shared listener works for either plugin.
 */
export function channelForSession(sessionId) {
  const s = String(sessionId).replace(/-/g, "").toUpperCase();
  return `messages_${s.slice(0, 8)}`;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget Realtime broadcast. Failures are swallowed — the canonical
 * reply still lands via the existing ingest path.
 */
export async function broadcast(account, sessionId, event, payload, log) {
  const url = `${account.backendUrl}/realtime/v1/api/broadcast`;
  const body = JSON.stringify({
    messages: [
      {
        topic: channelForSession(sessionId),
        event,
        payload,
        private: false,
      },
    ],
  });
  try {
    await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: account.publishableKey,
          Authorization: `Bearer ${account.publishableKey}`,
        },
        body,
      },
      BROADCAST_TIMEOUT_MS,
    );
  } catch (err) {
    log?.(`broadcast ${event} failed (best-effort)`, err);
  }
}

/**
 * UPSERT the in-flight reasoning trail so iOS can recover it on bootstrap if
 * the user reopens the chat mid-thought. PostgREST's resolution=merge-duplicates
 * makes session_id (PK) the conflict target. 4xx (e.g. table missing) is a
 * silent skip — chat still works without it.
 */
export async function progressUpsert(
  account,
  sessionId,
  userId,
  agentProfileId,
  reasoningText,
  log,
) {
  const url = `${account.backendUrl}/rest/v1/agent_session_progress`;
  const body = JSON.stringify({
    session_id: String(sessionId).toLowerCase(),
    user_id: String(userId).toLowerCase(),
    agent_profile_id: String(agentProfileId).toLowerCase(),
    reasoning_text: reasoningText,
  });
  try {
    const r = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: account.publishableKey,
          Authorization: `Bearer ${account.publishableKey}`,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body,
      },
      BROADCAST_TIMEOUT_MS,
    );
    if (r.status >= 400) {
      const txt = await r.text().catch(() => "");
      log?.(`progress upsert ${r.status}: ${txt.slice(0, 200)}`);
    }
  } catch (err) {
    log?.(`progress upsert failed (best-effort)`, err);
  }
}

/**
 * Drop the live progress row on done/error so the iOS hydrate path doesn't
 * resurface a stale trail next time the chat opens.
 */
export async function progressClear(account, sessionId, log) {
  const url =
    `${account.backendUrl}/rest/v1/agent_session_progress` +
    `?session_id=eq.${String(sessionId).toLowerCase()}`;
  try {
    await fetchWithTimeout(
      url,
      {
        method: "DELETE",
        headers: {
          apikey: account.publishableKey,
          Authorization: `Bearer ${account.publishableKey}`,
        },
      },
      BROADCAST_TIMEOUT_MS,
    );
  } catch (err) {
    log?.(`progress clear failed (best-effort)`, err);
  }
}
