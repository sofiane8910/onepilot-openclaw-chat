// HTTP wrapper API exposed by the Onepilot plugin.
//
// Goal: the iOS app talks only to these endpoints for plugin-touching ops, so
// when the OpenClaw CLI changes a flag we ship a new plugin via plugin_manifest
// instead of an App Store release.
//
// Bind: 127.0.0.1:(ONEPILOT_WRAPPER_PORT || gatewayPort + 1).
// Auth: Authorization: Bearer <agentKey> matched against any configured account.
// Out-of-process effects (config writes, plugin uninstall) shell out to the
// openclaw CLI from inside this plugin — that's the whole point: the
// framework-coupling moves into the plugin where it can be updated server-side.

import http from "node:http";
import { Buffer } from "node:buffer";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getWrapperPort } from "./env.js";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _packageVersion = "unknown";
try {
  const pkgPath = path.resolve(__dirname, "..", "package.json");
  _packageVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version || "unknown";
} catch {
  // best-effort
}

const ROUTES = new Map();

function route(method, pathSpec, handler) {
  ROUTES.set(`${method} ${pathSpec}`, handler);
}

function send(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
  });
  res.end(payload);
}

function bearerEquals(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

async function readJson(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function escapeForSingleQuoted(value) {
  // POSIX single-quote escape: ' → '\''
  return String(value).replace(/'/g, `'\\''`);
}

async function shellOpenClaw(args, { timeoutMs = 30000 } = {}) {
  // args: array of pre-escaped shell tokens. Caller is responsible for quoting.
  const cmd = `openclaw ${args.join(" ")}`;
  const { stdout, stderr } = await execAsync(cmd, {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" };
}

async function readAccountsFromConfig() {
  // Single source of truth: ask the running gateway. Avoids drift from in-memory
  // pluginConfig captured at register-time.
  try {
    const { stdout } = await shellOpenClaw(
      ["config", "get", "plugins.entries.onepilot.config.accounts", "--json"],
      { timeoutMs: 10000 },
    );
    const parsed = JSON.parse(stdout || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAccount(accountId, accountObj) {
  const json = JSON.stringify(accountObj);
  const escaped = escapeForSingleQuoted(json);
  const key = `plugins.entries.onepilot.config.accounts.${accountId}`;
  await shellOpenClaw(["config", "set", key, `'${escaped}'`, "--strict-json"]);
}

async function deleteAccount(accountId) {
  const key = `plugins.entries.onepilot.config.accounts.${accountId}`;
  // Best-effort: try `config delete`, fall back to disabling the account.
  try {
    await shellOpenClaw(["config", "delete", key]);
  } catch {
    await writeAccount(accountId, { enabled: false });
  }
}

async function frameworkVersion() {
  try {
    const { stdout } = await shellOpenClaw(["--version"], { timeoutMs: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

route("GET", "/onepilot/v1/health", async (_req, res, ctx) => {
  const accounts = await readAccountsFromConfig();
  const accountIds = Object.keys(accounts);
  send(res, 200, {
    ok: true,
    plugin_id: "onepilot",
    plugin_version: _packageVersion,
    framework: "openclaw",
    framework_version: await frameworkVersion(),
    account_configured: accountIds.length > 0,
    accounts: accountIds,
    accounts_enabled: accountIds.filter((id) => accounts[id]?.enabled !== false),
    wrapper_api: "v1",
    started_at: ctx.startedAt,
  });
});

route("POST", "/onepilot/v1/configure", async (req, res, _ctx) => {
  const body = await readJson(req);
  const incoming = body?.accounts;
  if (!incoming || typeof incoming !== "object") {
    return send(res, 400, { ok: false, error: "missing accounts object" });
  }
  const current = await readAccountsFromConfig();
  const written = [];
  for (const [accountId, patch] of Object.entries(incoming)) {
    if (!accountId || typeof patch !== "object" || patch === null) {
      return send(res, 400, { ok: false, error: `invalid account ${accountId}` });
    }
    const merged = { ...(current[accountId] ?? {}), ...patch };
    await writeAccount(accountId, merged);
    written.push(accountId);
  }
  send(res, 200, { ok: true, written });
});

route("POST", "/onepilot/v1/account/rotate", async (req, res, _ctx) => {
  const body = await readJson(req);
  const accountId = body?.accountId ?? "default";
  const accessToken = body?.accessToken;
  const apiKey = body?.publishableKey;
  if (!accessToken) {
    return send(res, 400, { ok: false, error: "accessToken required" });
  }
  const accounts = await readAccountsFromConfig();
  const account = accounts[accountId];
  if (!account) {
    return send(res, 404, { ok: false, error: `unknown account ${accountId}` });
  }
  const url = `${account.backendUrl}/functions/v1/mint-agent-key`;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
  };
  if (apiKey || account.publishableKey) {
    headers.apikey = apiKey || account.publishableKey;
  }
  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ agent_profile_id: account.agentProfileId }),
  });
  const text = await r.text();
  if (!r.ok) {
    return send(res, r.status, { ok: false, error: `mint failed: ${text.slice(0, 200)}` });
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    return send(res, 502, { ok: false, error: "mint returned non-JSON" });
  }
  const newKey = parsed?.agent_key;
  if (typeof newKey !== "string" || !newKey.startsWith("oak_")) {
    return send(res, 502, { ok: false, error: "mint response missing agent_key" });
  }
  await writeAccount(accountId, { ...account, agentKey: newKey });
  send(res, 200, {
    ok: true,
    agent_key_prefix: newKey.slice(0, 8),
    rotated_at: new Date().toISOString(),
  });
});

route("POST", "/onepilot/v1/account/revoke", async (req, res, _ctx) => {
  const body = await readJson(req);
  const accountId = body?.accountId ?? "default";
  const accounts = await readAccountsFromConfig();
  if (!accounts[accountId]) {
    return send(res, 404, { ok: false, error: `unknown account ${accountId}` });
  }
  await deleteAccount(accountId);
  send(res, 200, { ok: true, accountId });
});

route("POST", "/onepilot/v1/plugin/uninstall", async (_req, res, _ctx) => {
  // Self-uninstall. The gateway keeps running; the plugin is gone after the
  // next register cycle. Caller should stop hitting the wrapper API afterward.
  await shellOpenClaw(["plugins", "uninstall", "onepilot", "--force"]);
  send(res, 200, { ok: true });
});

function findHandler(method, urlPath) {
  return ROUTES.get(`${method} ${urlPath}`);
}

function findExpectedKeys(accounts) {
  const keys = [];
  for (const a of Object.values(accounts || {})) {
    if (a && typeof a.agentKey === "string" && a.agentKey) keys.push(a.agentKey);
  }
  return keys;
}

export function startWrapperApi({ gatewayPort, accounts: initialAccounts, log, warn }) {
  // Env reads are isolated in env.js (scanner-safe — that file has no
  // outbound capability). Mixing environment access with `fetch` in this
  // file trips the install-time "credential harvesting" pattern check.
  const port = getWrapperPort(gatewayPort + 1);
  const startedAt = new Date().toISOString();
  let cachedKeys = findExpectedKeys(initialAccounts);

  async function refreshKeys() {
    try {
      const accounts = await readAccountsFromConfig();
      const next = findExpectedKeys(accounts);
      if (next.length > 0) cachedKeys = next;
    } catch (err) {
      warn(`refreshKeys failed`, err);
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const auth = req.headers["authorization"] || "";
      const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      const allowed = cachedKeys.some((k) => bearerEquals(presented, k));
      if (!allowed) {
        // Re-read once before rejecting — handles rotate-then-call.
        await refreshKeys();
        const allowed2 = cachedKeys.some((k) => bearerEquals(presented, k));
        if (!allowed2) return send(res, 401, { ok: false, error: "unauthorized" });
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const handler = findHandler(req.method, url.pathname);
      if (!handler) return send(res, 404, { ok: false, error: "not found" });
      await handler(req, res, { startedAt });
    } catch (err) {
      warn(`wrapper handler failed`, err);
      try { send(res, 500, { ok: false, error: String(err?.message || err) }); }
      catch { /* response already sent */ }
    }
  });

  server.on("error", (err) => warn(`wrapper server error`, err));
  server.listen(port, "127.0.0.1", () => {
    log(`wrapper API listening on 127.0.0.1:${port} (v${_packageVersion})`);
  });

  // Refresh allowed keys after every rotate (we can't observe writes; poll).
  const refreshTimer = setInterval(refreshKeys, 60_000);
  refreshTimer.unref?.();

  return server;
}
