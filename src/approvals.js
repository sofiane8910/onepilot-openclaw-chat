// Approval forwarding bridge.
//
// OpenClaw's exec-approval-forwarder routes exec-approval requests to
// configured channel targets via the channel's `outbound.sendText`. The
// payload carries the canonical marker `channelData.execApproval =
// { approvalId, approvalSlug, allowedDecisions }` (see
// openclaw/src/infra/exec-approval-reply.ts:120). When the marker is
// present, this module hijacks the outbound and broadcasts an
// `approval_requested` event on the iOS Supabase Realtime channel so
// Onepilot can render an actionable bubble.
//
// Decision flow (no out-of-band IPC):
//   iOS bubble tap → app posts a chat message containing the literal
//   `/approve <id> <decision>` text into Supabase. The plugin's existing
//   inbound subscriber dispatches it to the gateway as a regular user
//   message; OpenClaw's auto-reply pipeline (commands-approve.ts) matches
//   `/approve …` and calls `exec.approval.resolve` JSON-RPC against the
//   in-process ExecApprovalManager. No CLI, no socket, no upstream forks.

import { broadcast } from "./progress.js";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ENABLED_FLAG_FILE = path.join(
  process.env.HOME || "/tmp",
  ".openclaw-onepilot",
  "approvals.enabled",
);

const BACKUP_FILE = path.join(
  process.env.HOME || "/tmp",
  ".openclaw-onepilot",
  "approvals.backup.json",
);

/**
 * Resolve the active OpenClaw config path. The gateway is normally launched
 * with `--profile <name>` which sets OPENCLAW_CONFIG_PATH; we honor that
 * first, then fall back to walking up from this file's location
 * (`<stateDir>/plugins/openclaw-onepilot-channel/src/approvals.js` →
 * `<stateDir>/openclaw.json`). That's reliable because the plugin is
 * always installed inside the active profile's state dir.
 */
function resolveConfigPath() {
  const env = process.env;
  if (env.OPENCLAW_CONFIG_PATH) return env.OPENCLAW_CONFIG_PATH;
  const here = fileURLToPath(import.meta.url);
  // here = .../<stateDir>/plugins/<plugin>/src/approvals.js → up 3 → <stateDir>
  const stateDir = path.resolve(path.dirname(here), "..", "..", "..");
  return path.join(stateDir, "openclaw.json");
}

/**
 * Patch object the iOS toggle wants whenever it's ON. Captures all three
 * upstream surfaces:
 *   - tools.exec.security: "allowlist"  → only allowlisted commands run silent
 *   - tools.exec.ask:      "always"     → everything else asks the user
 *   - approvals.exec.{enabled,mode,targets} → forwarder routes through onepilot
 *
 * The values pre-existing in the user's config are saved to BACKUP_FILE on
 * the first ON-toggle so OFF restores them rather than guessing defaults.
 */
const APPROVALS_ON_PATCH = {
  tools: { exec: { security: "allowlist", ask: "always" } },
  approvals: {
    exec: {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "onepilot", to: "main" }],
    },
  },
};

async function readJsonOrEmpty(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return {};
  }
}

function getDeep(obj, dottedPath) {
  return dottedPath.split(".").reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);
}

function setDeep(obj, dottedPath, value) {
  const keys = dottedPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

const TRACKED_PATHS = [
  "tools.exec.security",
  "tools.exec.ask",
  "approvals.exec.enabled",
  "approvals.exec.mode",
  "approvals.exec.targets",
];

async function applyOpenClawConfigForToggle(enabled, log) {
  const cfgPath = resolveConfigPath();
  let cfg;
  try {
    cfg = JSON.parse(await fs.readFile(cfgPath, "utf8"));
  } catch (err) {
    log?.(`config read failed at ${cfgPath} — skipping config patch`, err);
    return false;
  }

  if (enabled) {
    // First time enabling — capture original values for clean rollback.
    try {
      await fs.access(BACKUP_FILE);
      // Backup already exists; don't overwrite (toggle was on previously).
    } catch {
      const backup = {};
      for (const p of TRACKED_PATHS) {
        const v = getDeep(cfg, p);
        if (v !== undefined) backup[p] = v;
      }
      await fs.mkdir(path.dirname(BACKUP_FILE), { recursive: true }).catch(() => {});
      await fs.writeFile(BACKUP_FILE, JSON.stringify(backup, null, 2), "utf8");
      log?.(`captured config backup with ${Object.keys(backup).length} keys`);
    }

    // Apply the ON patch.
    setDeep(cfg, "tools.exec.security", APPROVALS_ON_PATCH.tools.exec.security);
    setDeep(cfg, "tools.exec.ask", APPROVALS_ON_PATCH.tools.exec.ask);
    setDeep(cfg, "approvals.exec.enabled", true);
    setDeep(cfg, "approvals.exec.mode", "targets");
    setDeep(cfg, "approvals.exec.targets", [{ channel: "onepilot", to: "main" }]);
  } else {
    // Restore from backup. An empty backup ({}) means none of the tracked
    // keys existed before we toggled ON, so we should remove ALL of them
    // for a pristine OFF state. A populated backup restores each saved
    // value and removes any key that wasn't in the original. Either way
    // the backup file is consumed (deleted) so the next ON re-captures.
    let backup = null;
    try {
      backup = JSON.parse(await fs.readFile(BACKUP_FILE, "utf8"));
    } catch {
      backup = null;
    }
    if (backup === null) {
      // No backup at all (e.g. someone deleted the file). Most conservative
      // option: just turn forwarding off, leave the rest as-is.
      setDeep(cfg, "approvals.exec.enabled", false);
    } else {
      for (const p of TRACKED_PATHS) {
        if (Object.prototype.hasOwnProperty.call(backup, p)) {
          setDeep(cfg, p, backup[p]);
        } else {
          // Wasn't in original config — delete the key we added.
          const keys = p.split(".");
          let cur = cfg;
          for (let i = 0; i < keys.length - 1; i++) cur = cur?.[keys[i]];
          if (cur && typeof cur === "object") delete cur[keys[keys.length - 1]];
        }
      }
      // Prune empty parents (e.g. tools.exec became {}).
      if (cfg?.tools?.exec && Object.keys(cfg.tools.exec).length === 0) delete cfg.tools.exec;
      if (cfg?.tools && Object.keys(cfg.tools).length === 0) delete cfg.tools;
      if (cfg?.approvals?.exec && Object.keys(cfg.approvals.exec).length === 0) delete cfg.approvals.exec;
      if (cfg?.approvals && Object.keys(cfg.approvals).length === 0) delete cfg.approvals;
      await fs.unlink(BACKUP_FILE).catch(() => {});
      log?.("restored config from backup");
    }
  }

  // Atomic write: tmp + rename.
  const tmp = cfgPath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
  await fs.rename(tmp, cfgPath);
  log?.(`patched ${cfgPath} (enabled=${enabled})`);
  return true;
}

/**
 * Returns true when the user has opted into approval forwarding via the
 * iOS wizard / agent detail toggle. Default false. Flipped via
 * `bin/approvals-cli.js enable|disable`, called from the iOS adapter.
 */
export async function isApprovalsForwardingEnabled() {
  try {
    await fs.access(ENABLED_FLAG_FILE);
    return true;
  } catch {
    return false;
  }
}

export async function setApprovalsForwardingEnabled(enabled, opts = {}) {
  const dir = path.dirname(ENABLED_FLAG_FILE);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  if (enabled) {
    await fs.writeFile(ENABLED_FLAG_FILE, String(Date.now()), "utf8");
  } else {
    await fs.unlink(ENABLED_FLAG_FILE).catch(() => {});
  }
  // Patch the OpenClaw config so the upstream actually demands approvals
  // (or restores the user's previous policy on OFF). Forwarder reads config
  // fresh on each request — no gateway restart required.
  await applyOpenClawConfigForToggle(enabled, opts.log).catch((err) => {
    opts.log?.(`config patch failed (toggle still recorded in flag file)`, err);
  });
}

/**
 * Detect an exec-approval payload by the canonical upstream marker
 * `channelData.execApproval`. The forwarder always sets this — see
 * openclaw/src/infra/exec-approval-reply.ts:120 (buildExecApprovalPendingReplyPayload).
 */
export function extractApproval(ctx) {
  const channelData =
    ctx?.payload?.channelData ||
    ctx?.message?.channelData ||
    ctx?.channelData ||
    null;
  return channelData?.execApproval || null;
}

/**
 * Channel outbound hook. Returns true if the payload was an approval and
 * we handled it (caller MUST NOT forward as a regular text message).
 * Returns false to let the regular sendOnepilotText path run.
 */
export async function maybeHandleApproval({ ctx, account, log }) {
  const approval = extractApproval(ctx);
  if (!approval) return false;
  const enabled = await isApprovalsForwardingEnabled();
  if (!enabled) {
    log?.(`approval received but forwarding disabled — dropping (default off) id=${String(approval.approvalId).slice(0, 8)}`);
    return true;
  }

  const sessionId =
    ctx?.sessionId ||
    ctx?.session_id ||
    ctx?.payload?.sessionId ||
    "main";

  const text = ctx?.payload?.text || ctx?.message?.text || "";

  // Mirror the schema in onepilot-hermes-chat/approvals.py and the iOS
  // ApprovalRequest decoder. Keep the keys snake_case so both plugins
  // hit one decoder.
  const body = {
    approval_id: String(approval.approvalId || ""),
    approval_slug: String(approval.approvalSlug || ""),
    framework: "openclaw",
    tool_name: "system.run",
    command: text,
    argv: [],
    cwd: null,
    session_key: sessionId,
    agent_id: null,
    security: "medium",
    expires_at_ms: null,
    allowed_decisions: Array.isArray(approval.allowedDecisions)
      ? approval.allowedDecisions
      : ["allow-once", "allow-always", "deny"],
  };

  await broadcast(account, sessionId, "approval_requested", body, log);
  log?.(`forwarded approval_requested id=${body.approval_id.slice(0, 8)}`);
  return true;
}
