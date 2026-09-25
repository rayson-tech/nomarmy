import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// How much of each subscription's usage limit is used, as its vendor reports
// it: Codex writes rate_limits into every job's session log, and Claude Code
// passes them to the status line. Kept per OpenClaw provider id (one host
// login per provider) in <stateRoot>/usage-limits.json. Admission holds a job
// on an agent that's over its limit until the General confirms.

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => typeof value === "number" && Number.isFinite(value);
const windowName = minutes => ({ 300: "5h", 10080: "week", 1440: "day" })[minutes] ?? `${minutes}m`;
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

export function readUsageSnapshots(stateRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(stateRoot, "usage-limits.json"), "utf8"));
    if (!object(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([, s]) => object(s) && ["codex", "claude"].includes(s.source)
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
  return { level, text, resetsAt: level === "over" ? highest?.resetsAt ?? null : null,
    ageMinutes: Math.max(0, Math.floor((now - snapshot.observedAt) / 60000)) };
}
