// Locks the realtime topic + payload shape to the Hermes contract so the iOS
// chat UI renders OpenClaw and Hermes the same way without iOS changes.

import test from "node:test";
import assert from "node:assert/strict";
import { broadcast, progressUpsert, progressClear, channelForSession } from "../src/progress.js";

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

test("progressUpsert posts merge-duplicates with lowercase ids", async () => {
  const f = captureFetch();
  try {
    await progressUpsert(
      ACCOUNT,
      SESSION_ID,
      "USER-AAAA",
      "AGENT-BBBB",
      "trail so far\n",
    );
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, "https://example.test/rest/v1/agent_session_progress");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Prefer, "resolution=merge-duplicates,return=minimal");
    const body = JSON.parse(init.body);
    assert.deepEqual(body, {
      session_id: SESSION_ID.toLowerCase(),
      user_id: "user-aaaa",
      agent_profile_id: "agent-bbbb",
      reasoning_text: "trail so far\n",
    });
  } finally {
    f.restore();
  }
});

test("progressClear DELETEs the row by session_id", async () => {
  const f = captureFetch();
  try {
    await progressClear(ACCOUNT, SESSION_ID);
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(
      url,
      `https://example.test/rest/v1/agent_session_progress?session_id=eq.${SESSION_ID.toLowerCase()}`,
    );
    assert.equal(init.method, "DELETE");
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
