// Keeps OpenClaw current on its own. New models arrive in OpenClaw and its
// vendor plugins, and waiting for a person to run `nomarmy doctor --fix`
// left machines weeks behind. On the "latest" channel (the default), each
// coordinator's MCP server checks about once a day and, when no job is
// running, starts `nomarmy doctor --fix --auto` in the background. That runs
// lib/openclaw-channel.mjs's upgradeOpenclaw: test-call the models the roles
// use, upgrade, test again, and roll back to the exact earlier release if one
// that answered stops.
//
// One update at a time, machine-wide: a lock file in nomArmy's state. While
// it's held, admission refuses new jobs, so none starts on a half-installed
// OpenClaw. The updater waits a moment after taking it and backs off if a
// job got its lease in between.
//
// Off with `nomarmy config openclaw-auto off` (openclaw_auto: false in
// limits.yml); `nomarmy config openclaw tested` keeps the tested release.

import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import YAML from "yaml";
import { limitsPath } from "./limits.mjs";
import { openclawChannel } from "./openclaw-channel.mjs";
import { liveLeases, pidAlive } from "./slots.mjs";

export const AUTO_UPDATE_INTERVAL_MS = 24 * 3600000;
// An upgrade with its model checks takes a few minutes; one holding the lock
// this long died without releasing it.
export const LOCK_STALE_MS = 45 * 60000;
export const SETTLE_MS = 20000;
const LOCK_FILE = "openclaw-updating.json";
const STATE_FILE = "openclaw-auto-update.json";
export const AUTO_UPDATE_LOG = "openclaw-auto-update.log";

/** Whether automatic updates are on: openclaw_auto in limits.yml, on unless set to false. */
export function openclawAutoEnabled({ filePath = limitsPath() } = {}) {
  try { return YAML.parse(fs.readFileSync(filePath, "utf8"))?.openclaw_auto !== false; } catch { return true; }
}

/** Write `openclaw_auto: <on>`, keeping the rest of limits.yml (comments included). */
export function setOpenclawAuto(on, { filePath = limitsPath() } = {}) {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "# Machine-wide settings for nomArmy.\n";
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new Error(`${filePath} is not valid YAML: ${doc.errors[0].message}`);
  if (doc.contents === null) doc.contents = doc.createNode({});
  doc.set("openclaw_auto", Boolean(on));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(doc));
  return Boolean(on);
}

/** The last automatic attempt and its result, or {}. */
export function readAutoUpdateState(stateRoot) {
  try { const s = JSON.parse(fs.readFileSync(path.join(stateRoot, STATE_FILE), "utf8")); return s && typeof s === "object" ? s : {}; } catch { return {}; }
}
function writeAutoUpdateState(stateRoot, state) {
  fs.mkdirSync(stateRoot, { recursive: true });
  const file = path.join(stateRoot, STATE_FILE);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/** Whether an automatic update should run now. */
export function autoUpdateDue({ channel, enabled, state = {}, now = Date.now() }) {
  if (channel !== "latest" || !enabled) return false;
  const last = Date.parse(state.lastAttempt ?? "");
  return !Number.isFinite(last) || now - last >= AUTO_UPDATE_INTERVAL_MS;
}

/** The update in progress ({ pid, startedAt }), or null. A dead or very old holder's lock is removed. */
export function updateInProgress(stateRoot, { now = Date.now(), alive = pidAlive } = {}) {
  const file = path.join(stateRoot, LOCK_FILE);
  let lock;
  try { lock = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  const started = Date.parse(lock?.startedAt ?? "");
  if (!alive(lock?.pid) || !Number.isFinite(started) || now - started > LOCK_STALE_MS) {
    try { fs.unlinkSync(file); } catch { /* another reader got it */ }
    return null;
  }
  return lock;
}

/** Admission's refusal while OpenClaw is updating, or null. */
export function updateInProgressProblem(stateRoot, opts = {}) {
  const lock = updateInProgress(stateRoot, opts);
  if (!lock) return null;
  const minutes = Math.max(1, Math.round(((opts.now ?? Date.now()) - Date.parse(lock.startedAt)) / 60000));
  return `OpenClaw is updating (started ${minutes} minute${minutes === 1 ? "" : "s"} ago; it checks your models and rolls back if one breaks). Try again in a few minutes; nothing was started.`;
}

/** Take the machine-wide lock; a release function, or null when another update holds it. */
export function takeUpdateLock(stateRoot, { now = Date.now(), pid = process.pid, alive = pidAlive } = {}) {
  updateInProgress(stateRoot, { now, alive });
  fs.mkdirSync(stateRoot, { recursive: true });
  const file = path.join(stateRoot, LOCK_FILE);
  try { fs.writeFileSync(file, JSON.stringify({ pid, startedAt: new Date(now).toISOString() }), { flag: "wx" }); }
  catch (error) { if (error.code === "EEXIST") return null; throw error; }
  return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
}

const LOG_MAX_BYTES = 1024 * 1024;

/**
 * From an MCP server's periodic check: when an update is due, nothing runs,
 * and no update holds the lock, start `nomarmy doctor --fix --auto` detached,
 * logging to the state directory. That process checks all of it again under
 * the lock, so two sessions starting one at once is harmless.
 * @returns {boolean} whether it started one
 */
export function maybeStartAutoUpdate({
  stateRoot, leasesDir, projectDir, nomarmyBin, env = process.env, platform = process.platform,
  spawn = nodeSpawn, channel = openclawChannel(), enabled = openclawAutoEnabled(), now = Date.now(), alive = pidAlive,
}) {
  // Native Windows reaches OpenClaw through WSL, whose own nomArmy updates it.
  if (platform === "win32") return false;
  if (!autoUpdateDue({ channel, enabled, state: readAutoUpdateState(stateRoot), now })) return false;
  if (updateInProgress(stateRoot, { now, alive }) || liveLeases(leasesDir, { alive }).length) return false;
  const logPath = path.join(stateRoot, AUTO_UPDATE_LOG);
  let size = 0;
  try { size = fs.statSync(logPath).size; } catch { /* new log */ }
  const fd = fs.openSync(logPath, size > LOG_MAX_BYTES ? "w" : "a");
  try {
    const child = spawn(process.execPath, [nomarmyBin, "doctor", "--fix", "--auto"], { cwd: projectDir, env, detached: true, stdio: ["ignore", fd, fd] });
    child.on?.("error", () => {});
    child.unref?.();
  } finally { fs.closeSync(fd); }
  return true;
}

/** What happened, from upgradeOpenclaw's result. */
export function outcomeOf(result) {
  if (result.keptNewer) return "kept-newer";
  // A rollback with no broken model was a step that failed part-way.
  if (result.rolledBack && result.broke?.length) return "rolled-back";
  if (!result.ok) return "failed";
  return result.changed?.length ? "upgraded" : "current";
}

/**
 * One automatic update, if it's due and nothing runs. `upgrade()` runs the
 * upgrade and returns upgradeOpenclaw's result. Never throws for the
 * upgrade's own failure: that's recorded for health to report.
 * @returns {Promise<{ ran: boolean, skipped?: string, outcome?: string }>}
 */
export async function runAutoUpdate({
  stateRoot, leasesDir, channel, enabled, upgrade, force = false,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), settleMs = SETTLE_MS, alive = pidAlive,
}) {
  if (!force && !autoUpdateDue({ channel, enabled, state: readAutoUpdateState(stateRoot), now: now() })) return { ran: false, skipped: "not due" };
  if (liveLeases(leasesDir, { alive }).length) return { ran: false, skipped: "jobs running" };
  const release = takeUpdateLock(stateRoot, { now: now(), alive });
  if (!release) return { ran: false, skipped: "another update is running" };
  try {
    // A job admitted just before the lock appeared writes its lease within moments.
    await sleep(settleMs);
    if (liveLeases(leasesDir, { alive }).length) return { ran: false, skipped: "jobs running" };
    const startedAt = new Date(now()).toISOString();
    let result;
    try { result = await upgrade(); } catch (error) { result = { ok: false, changed: [], error: error.message }; }
    const outcome = outcomeOf(result);
    writeAutoUpdateState(stateRoot, {
      lastAttempt: startedAt,
      result: {
        at: new Date(now()).toISOString(), outcome, from: result.previous ?? null, to: result.target ?? null,
        broke: result.broke ?? [], fixed: result.fixed ?? [], failed: result.failed ?? result.error ?? null, restored: result.rolledBack === true,
      },
    });
    return { ran: true, outcome };
  } finally { release(); }
}

/**
 * Health issues from the last automatic update: a rollback, a failure, or a
 * newer release kept because the older one can't read its state. An upgrade
 * or "already current" says nothing.
 */
export function autoUpdateIssues(state, { logPath = null } = {}) {
  const r = state?.result;
  if (!r) return [];
  const log = logPath ? ` Its log: ${logPath}.` : "";
  const models = (r.broke ?? []).map((b) => b.model).join(", ");
  if (r.outcome === "rolled-back") return [{
    id: `openclaw-auto:rolled-back:${r.to}`, severity: "info",
    title: `OpenClaw ${r.to} broke ${models || "a model"}; nomArmy rolled back to ${r.from}`,
    detail: `The automatic update test-called your roles' models after upgrading, and ${models || "one"} stopped answering, so it put back the exact earlier release. It skips ${r.to} and tries the next newer one.${log}`,
    fix: "Nothing to do; the next OpenClaw release is tried automatically", short: null,
  }];
  if (r.outcome === "kept-newer") return [{
    id: `openclaw-auto:kept-newer:${r.to}`, severity: "warn",
    title: `OpenClaw ${r.to} broke ${models || "a model"}, and the earlier release can't read its state`,
    detail: `It migrated OpenClaw's state on its first run, so ${r.from} no longer starts; OpenClaw stays on ${r.to}.${log}`,
    fix: `nomarmy army assign <role> <agent> [model]  (move the roles on ${models || "the broken model"} until a fix)`, short: "openclaw kept newer",
  }];
  if (r.outcome === "failed") return [{
    id: `openclaw-auto:failed:${r.to}`, severity: "warn",
    title: `The automatic OpenClaw update to ${r.to ?? "the latest release"} didn't finish`,
    detail: `${r.failed ? `It stopped at: ${r.failed}. ` : ""}${r.restored ? `OpenClaw and its plugins were put back to ${r.from}.` : "Run the fix to see where OpenClaw is now."}${log}`,
    fix: "nomarmy doctor --fix  (shows each step; it tries again on its own tomorrow)", short: "openclaw update failed",
  }];
  return [];
}
