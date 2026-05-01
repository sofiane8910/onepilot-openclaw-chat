// Locks the realtime topic + payload shape to the Hermes contract so the iOS
// chat UI renders OpenClaw and Hermes the same way without iOS changes.

import test from "node:test";
import assert from "node:assert/strict";
import { broadcast, progressUpsert, progressFinalize, channelForSession } from "../src/progress.js";

const ACCOUNT = {
  backendUrl: "https://example.test",
  publishableKey: "pk_test",
};
const SESSION_ID = "abcdef12-3456-7890-abcd-ef1234567890";

function captureFetch() {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response("", { status: 200 });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = orig;
    },
  };
}

test("channelForSession matches the Hermes _channel_for_session format", () => {
  // Hermes uses UPPERCASE first 8 chars of the UUID (no dashes). iOS subscribes
  // case-sensitively so a lowercase prefix would route to a topic nobody is on.
  assert.equal(channelForSession(SESSION_ID), "messages_ABCDEF12");
  assert.equal(channelForSession("abcdef12-0000"), "messages_ABCDEF12");
});

test("broadcast posts to /realtime/v1/api/broadcast with the right topic, event, payload", async () => {
  const f = captureFetch();
  try {
    await broadcast(ACCOUNT, SESSION_ID, "reasoning_delta", { text: "thinking..." });
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, "https://example.test/realtime/v1/api/broadcast");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(init.headers.apikey, "pk_test");
    assert.equal(init.headers.Authorization, "Bearer pk_test");
    const body = JSON.parse(init.body);
    assert.deepEqual(body, {
      messages: [
        {
          topic: "messages_ABCDEF12",
          event: "reasoning_delta",
          payload: { text: "thinking..." },
          private: false,
        },
      ],
    });
  } finally {
    f.restore();
  }
});

test("progressUpsert posts merge-duplicates with lowercase ids and selected fields", async () => {
  const f = captureFetch();
  try {
    await progressUpsert(
      ACCOUNT,
      SESSION_ID,
      "USER-AAAA",
      "AGENT-BBBB",
      { reasoningText: "trail so far\n", isActive: true, setStartedAt: true },
    );
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, "https://example.test/rest/v1/agent_session_progress");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Prefer, "resolution=merge-duplicates,return=minimal");
    const body = JSON.parse(init.body);
    assert.equal(body.session_id, SESSION_ID.toLowerCase());
    assert.equal(body.user_id, "user-aaaa");
    assert.equal(body.agent_profile_id, "agent-bbbb");
    assert.equal(body.is_active, true);
    assert.equal(body.reasoning_text, "trail so far\n");
    assert.ok(body.last_activity_at, "last_activity_at should be set");
    assert.ok(body.started_at, "started_at should be set when setStartedAt: true");
    // Fields not passed should NOT be present (so partial updates don't clobber).
    assert.ok(!("partial_response" in body));
    assert.ok(!("status_label" in body));
  } finally {
    f.restore();
  }
});

test("progressUpsert without setStartedAt omits started_at (no clobber)", async () => {
  const f = captureFetch();
  try {
    await progressUpsert(
      ACCOUNT,
      SESSION_ID,
      "u",
      "a",
      { statusLabel: "Running exec…" },
    );
    const body = JSON.parse(f.calls[0].init.body);
    assert.equal(body.status_label, "Running exec…");
    assert.ok(!("started_at" in body));
    assert.ok(!("reasoning_text" in body));
  } finally {
    f.restore();
  }
});

test("progressFinalize upserts is_active=false (replaces the old DELETE-based clear)", async () => {
  const f = captureFetch();
  try {
    await progressFinalize(ACCOUNT, SESSION_ID, "u", "a");
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, "https://example.test/rest/v1/agent_session_progress");
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.is_active, false);
    assert.equal(body.partial_response, "");
    assert.equal(body.status_label, "");
  } finally {
    f.restore();
  }
});

test("broadcast swallows network errors (best-effort fan-out)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("simulated network down");
  };
  try {
    // Should not throw.
    await broadcast(ACCOUNT, SESSION_ID, "started", {});
  } finally {
    globalThis.fetch = orig;
  }
});
