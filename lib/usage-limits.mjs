import { execFile } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// How much of each subscription's usage limit is used, as its vendor reports
// it: Codex writes rate_limits into every job's session log, and Claude Code
// passes them to the status line. Kept per OpenClaw provider id (one host
// login per provider) in <stateRoot>/usage-limits.json. Admission holds a job
// on an agent that's over its limit until the General confirms.
//
// Those readings only update when a job finishes. A reading taken before a
// reset, or before the operator bought more usage, would then hold every
// job, and the reading would never refresh. A reading older than a few
// minutes is refreshed from `openclaw models status` before that hold, and
// again when health or the army/capacity views show it. The refresh is
// async: spawnSync would freeze the server's event loop.

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => typeof value === "number" && Number.isFinite(value);
const windowName = minutes => ({ 300: "5h", 10080: "week", 1440: "day" })[minutes] ?? `${minutes}m`;
const USAGE_SOURCES = ["codex", "claude", "openclaw"];
// Older than this, an over-limit reading is refreshed before it holds a job.
export const USAGE_STALE_MINUTES = 10;
export const USAGE_REFRESH_TIMEOUT_MS = 20000;
const RESET_UNIT_MS = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
function window(value, name, minutes, percentKey) {
  if (!object(value) || !finite(value[percentKey]) || value[percentKey] < 0) return null;
  return { name, usedPercent: value[percentKey], windowMinutes: minutes,
    resetsAt: finite(value.resets_at) ? value.resets_at * 1000 : null };
}

/** Read the last rate-limit event from the newest rollout (by modification time). */
export function readCodexRateLimits(jobDir) {
  try {
    const files = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push({ file, mtime: fs.statSync(file).mtimeMs });
      }
    }
    const agents = path.join(jobDir, "runtime/state/agents");
    for (const agent of fs.readdirSync(agents, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      const sessions = path.join(agents, agent.name, "agent/codex-home/sessions");
      if (fs.existsSync(sessions)) walk(sessions);
    }
    files.sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file));
    if (!files.length) return null;
    let last = null;
    for (const line of fs.readFileSync(files[0].file, "utf8").split(/\r?\n/)) {
      try {
        const event = JSON.parse(line);
        if (event.type === "event_msg" && event.payload?.type === "token_count" && object(event.payload.rate_limits)) last = event;
      } catch { /* A partial trailing write is not an event. */ }
    }
    if (!last) return null;
    const limits = last.payload.rate_limits;
    const windows = [limits.primary, limits.secondary].map(value => {
      const minutes = finite(value?.window_minutes) ? value.window_minutes : null;
      return window(value, minutes === null ? "unknown" : windowName(minutes), minutes, "used_percent");
    }).filter(Boolean);
    const limitReached = limits.rate_limit_reached_type != null || Boolean(limits.spend_control_reached);
    if (!windows.length && !limitReached) return null;
    const timestamp = Date.parse(last.timestamp);
    return { source: "codex", plan: typeof limits.plan_type === "string" ? limits.plan_type : null,
      limitReached, observedAt: Number.isFinite(timestamp) ? timestamp : files[0].mtime, windows };
  } catch { return null; }
}

export function normalizeClaudeRateLimits(rateLimits) {
  if (!object(rateLimits)) return null;
  const windows = [["five_hour", "5h", 300], ["seven_day", "week", 10080], ["spend_limit", "spend", null]]
    .map(([key, name, minutes]) => window(rateLimits[key], name, minutes, "used_percentage")).filter(Boolean);
  // Claude supplies percentages, not an independent provider-wide reached flag.
  return windows.length ? { source: "claude", plan: null, limitReached: false, observedAt: Date.now(), windows } : null;
}

/**
 * Combine a stored snapshot with a new reading that may be stale. Every
 * Claude Code window passes the status line the limits from its own last
 * response, so an idle window keeps reporting an old, lower figure. Usage
 * only rises within a window, so per window: a later reset wins, and at the
 * same reset the higher figure wins. A stored window the reading lacks is
 * kept while it's live. Returns the stored snapshot itself when nothing
 * changed, so callers can skip the write.
 */
export function mergeUsageSnapshot(previous, incoming, now = Date.now()) {
  if (!previous) return incoming;
  const key = (w) => [w.resetsAt ?? 0, w.usedPercent];
  const newer = (a, b) => { const [ra, pa] = key(a), [rb, pb] = key(b); return ra > rb || (ra === rb && pa > pb); };
  const byName = new Map(previous.windows.filter((w) => w.resetsAt === null || w.resetsAt > now).map((w) => [w.name, w]));
  let changed = byName.size !== previous.windows.length;
  for (const w of incoming.windows) {
    const stored = byName.get(w.name);
    if (!stored || newer(w, stored)) { byName.set(w.name, w); changed = true; }
  }
  const limitReached = incoming.limitReached || previous.limitReached;
  if (!changed && limitReached === previous.limitReached) return previous;
  return { ...incoming, limitReached, observedAt: now, windows: [...byName.values()] };
}

export function readUsageSnapshots(stateRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(stateRoot, "usage-limits.json"), "utf8"));
    if (!object(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([, s]) => object(s) && USAGE_SOURCES.includes(s.source)
      && finite(s.observedAt) && typeof s.limitReached === "boolean" && (s.plan === null || typeof s.plan === "string")
      && Array.isArray(s.windows) && s.windows.every(w => object(w) && typeof w.name === "string" && finite(w.usedPercent)
        && (w.windowMinutes === null || finite(w.windowMinutes)) && (w.resetsAt === null || finite(w.resetsAt)))));
  } catch { return {}; }
}

/** Save a provider's snapshot, unless the one on file is newer (jobs finish out of order). */
export function recordUsageSnapshot(stateRoot, provider, snapshot) {
  const current = readUsageSnapshots(stateRoot);
  if (current[provider]?.observedAt > snapshot.observedAt) return;
  const snapshots = { ...current, [provider]: snapshot };
  fs.mkdirSync(stateRoot, { recursive: true });
  const file = path.join(stateRoot, "usage-limits.json"), tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(snapshots, null, 2));
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

export function usageStatus(snapshot, now = Date.now()) {
  const live = snapshot.windows.filter(w => w.resetsAt === null || w.resetsAt > now).sort((a, b) => b.usedPercent - a.usedPercent);
  const reached = snapshot.limitReached && (snapshot.windows.length === 0 || live.length > 0);
  const highest = live[0];
  const level = reached || highest?.usedPercent >= 100 ? "over" : highest?.usedPercent >= 80 ? "high" : "ok";
  const text = live.length ? live.map(w => `${w.usedPercent}% of ${w.name}, resets ${w.resetsAt === null ? "unknown" : new Date(w.resetsAt).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })}`).join("; ") : reached ? "limit reached, reset unknown" : "no live usage windows";
  // A short label for tight spaces (status line, health): "85% wk".
  const short = highest ? `${highest.usedPercent}% ${highest.name === "week" ? "wk" : highest.name}` : reached ? "limit" : null;
  return { level, text, short, resetsAt: level === "over" ? highest?.resetsAt ?? null : null,
    ageMinutes: Math.max(0, Math.floor((now - snapshot.observedAt) / 60000)) };
}

/** An over-limit reading old enough that the window may already have reset. */
export function usageReadingIsStale(status) {
  return status?.level === "over" && status.ageMinutes >= USAGE_STALE_MINUTES;
}

/** View text. A stale over-limit reading is marked; a fresh one is unchanged. */
export function usageDisplayText(status) {
  if (!usageReadingIsStale(status)) return status.text;
  return `${status.text}; possibly stale (${status.ageMinutes} minutes old)`;
}

export function staleUsageRefreshedNote(provider) {
  return `stale usage reading for ${provider} was refreshed from OpenClaw`;
}

function refreshFailureMessage(error) {
  const message = String(error?.message ?? error ?? "");
  return /timed out|timeout/i.test(message) ? "OpenClaw usage refresh failed (timed out)" : "OpenClaw usage refresh failed";
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OpenClaw usage refresh timed out")), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Async `openclaw` runner. Never spawnSync: that blocks every other request. */
export function runOpenClawStatus(cmd, args, { timeoutMs = USAGE_REFRESH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, stdout: stdout ?? "", error: error ? String(error.message ?? error) : null });
    });
  });
}

function windowFromLabel(label) {
  const text = String(label ?? "").trim();
  const hours = /^(\d+(?:\.\d+)?)h$/i.exec(text);
  if (hours) {
    const minutes = Math.round(Number(hours[1]) * 60);
    return { name: windowName(minutes), windowMinutes: minutes };
  }
  const days = /^(\d+(?:\.\d+)?)d$/i.exec(text);
  if (days) {
    const minutes = Math.round(Number(days[1]) * 1440);
    return { name: windowName(minutes), windowMinutes: minutes };
  }
  const mins = /^(\d+(?:\.\d+)?)m$/i.exec(text);
  if (mins) {
    const minutes = Math.round(Number(mins[1]));
    return { name: windowName(minutes), windowMinutes: minutes };
  }
  const named = { week: 10080, day: 1440, "5h": 300, spend: null };
  if (Object.hasOwn(named, text)) return { name: text === "week" || text === "day" || text === "5h" ? windowName(named[text]) : text, windowMinutes: named[text] };
  return { name: text || "unknown", windowMinutes: null };
}

function resetAtFromDelay(delay, now) {
  if (delay == null || delay === "") return null;
  if (typeof delay === "number" && Number.isFinite(delay)) {
    if (delay > 1e12) return delay;
    if (delay > 1e9) return delay * 1000;
    return null;
  }
  const text = String(delay).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const iso = Date.parse(text);
    return Number.isFinite(iso) ? iso : null;
  }
  let ms = 0, matched = false;
  for (const part of text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) {
    matched = true;
    ms += Number(part[1]) * RESET_UNIT_MS[part[2].toLowerCase()];
  }
  return matched ? now + ms : null;
}

function snapshotFromWindows(windows, now) {
  if (!windows.length) return null;
  return { source: "openclaw", plan: null, limitReached: false, observedAt: now, windows };
}

function parseUsageRemainder(remainder, now) {
  const windows = [];
  const re = /(\S+)\s+(\d+(?:\.\d+)?)%\s+left(?:\s*⏱\uFE0F?\s*((?:\d+(?:\.\d+)?\s*[dhms]\s*)+))?/gi;
  for (const match of String(remainder).matchAll(re)) {
    const built = windowFromLabel(match[1]);
    const usedPercent = 100 - Number(match[2]);
    if (!Number.isFinite(usedPercent) || usedPercent < 0) continue;
    windows.push({ name: built.name, usedPercent, windowMinutes: built.windowMinutes, resetsAt: resetAtFromDelay(match[3] ?? null, now) });
  }
  return windows;
}

function parseTextUsage(raw, now) {
  const out = {};
  const lineRe = /(?:^|[\n"\s\u2500-\u257f])([A-Za-z0-9._-]+)\s+usage:\s+([^"\n]+)/g;
  for (const line of String(raw).matchAll(lineRe)) {
    const snapshot = snapshotFromWindows(parseUsageRemainder(line[2], now), now);
    if (snapshot) out[line[1]] = snapshot;
  }
  return out;
}

/**
 * OpenClaw usage from plain-text `models status`:
 * `- <provider> usage: <window> <N>% left ⏱<duration>`.
 * "N% left" becomes used percent (100 - N). Returns provider -> snapshot.
 * The JSON status output does not include usage readings.
 */
export function parseOpenClawUsageOutput(raw, now = Date.now()) {
  return parseTextUsage(stripVTControlCharacters(String(raw ?? "")), now);
}

/** Ask OpenClaw for current usage without blocking the event loop. */
export async function fetchOpenClawUsage({ run = runOpenClawStatus, now = Date.now(), timeoutMs = USAGE_REFRESH_TIMEOUT_MS, openclawCmd = process.env.NOMARMY_OPENCLAW_CMD || "openclaw" } = {}) {
  const failure = (error) => ({ ok: false, snapshots: {}, error: refreshFailureMessage(error) });
  try {
    return await withTimeout((async () => {
      const result = await run(openclawCmd, ["models", "status"], { timeoutMs });
      // Partial stdout from a failed command is not a fresh usage reading.
      if (!result?.ok) return failure(result?.error);
      const snapshots = parseOpenClawUsageOutput(result.stdout, now);
      return Object.keys(snapshots).length ? { ok: true, snapshots, error: null } : failure(null);
    })(), timeoutMs);
  } catch (error) { return failure(error); }
}

/**
 * Refresh over-limit readings older than USAGE_STALE_MINUTES. No OpenClaw
 * call when nothing is stale. A failed refresh leaves the stored readings
 * and says so. `snapshots` lets a caller pass what it already read.
 */
export async function refreshStaleOverLimitReadings(stateRoot, { run, now = Date.now(), snapshots = null, timeoutMs = USAGE_REFRESH_TIMEOUT_MS, openclawCmd } = {}) {
  const current = snapshots ?? (stateRoot ? readUsageSnapshots(stateRoot) : {});
  const stale = Object.entries(current).filter(([, snapshot]) => usageReadingIsStale(usageStatus(snapshot, now))).map(([provider]) => provider);
  if (!stale.length) return { called: false, ok: true, snapshots: current, error: null, failedProviders: [] };
  let fetched;
  try { fetched = await fetchOpenClawUsage({ run, now, timeoutMs, openclawCmd }); }
  catch (error) { return { called: true, ok: false, snapshots: current, error: refreshFailureMessage(error), failedProviders: stale }; }
  if (!fetched.ok) return { called: true, ok: false, snapshots: current, error: fetched.error ?? "OpenClaw usage refresh failed", failedProviders: stale };
  const updated = { ...current };
  const seen = new Set();
  for (const provider of stale) {
    const snapshot = fetched.snapshots[provider];
    if (!snapshot) continue;
    try {
      if (stateRoot) recordUsageSnapshot(stateRoot, provider, snapshot);
      // A job may have saved a newer observation while the refresh was pending.
      updated[provider] = stateRoot ? readUsageSnapshots(stateRoot)[provider] ?? snapshot : snapshot;
      seen.add(provider);
    } catch { /* Keep the hold if the fresh snapshot could not be recorded. */ }
  }
  const failedProviders = stale.filter((provider) => !seen.has(provider));
  return { called: true, ok: failedProviders.length === 0, snapshots: updated, error: failedProviders.length ? "OpenClaw usage refresh failed" : null, failedProviders };
}
