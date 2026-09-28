// Which open coordinator sessions still run an older nomArmy. Each Claude
// Code, Codex or Cursor session starts its own nomArmy server and keeps the
// code it started with, so after an update "restart your sessions" wasn't
// enough: one real afternoon had a session on alpha.14 for hours and four
// more, days old, on alpha.6 to alpha.12. This names each one.

import { spawnSync } from "node:child_process";
import path from "node:path";

// The installed copy's server, or the portable `nomarmy mcp` launcher.
const SERVER_RE = /nomarmy-local-worker[\\/]mcp[\\/]server\.mjs|\bnomarmy(?:\.mjs)?\s+mcp\b/;

/** `ps -A -o pid=,ppid=,tty=,lstart=,args=` lines. lstart reads "Sun Sep 27 21:33:11 2026" on macOS and Linux alike. */
export function parsePs(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const startedAt = new Date(`${m[4]} ${m[5]} ${m[7]} ${m[6]}`).getTime();
    if (!Number.isFinite(startedAt)) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), tty: /^\?+$/.test(m[3]) ? null : m[3], startedAt, args: m[8].trim() });
  }
  return out;
}

/** The app a server belongs to, from its parent's command line. */
export function appName(args) {
  const first = String(args ?? "").split(/\s+/)[0] ?? "";
  const base = path.basename(first).toLowerCase();
  if (base === "claude" || /claude/.test(base)) return "Claude Code";
  if (base === "codex" || /codex/.test(base)) return "Codex";
  if (/cursor/i.test(first)) return "Cursor";
  return base || "a session";
}

/** Servers that started before the copy they'd now load was installed. */
export function staleSessions(procs, { installedAt }) {
  if (!Number.isFinite(installedAt)) return [];
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return procs
    .filter((p) => SERVER_RE.test(p.args) && p.startedAt < installedAt)
    .map((p) => {
      const parent = byPid.get(p.ppid);
      return { pid: p.pid, appPid: parent?.pid ?? p.ppid, app: appName(parent?.args), tty: p.tty ?? parent?.tty ?? null, startedAt: p.startedAt };
    })
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Running processes, or null where `ps` isn't available (Windows). */
export function listProcesses({ run = spawnSync, platform = process.platform } = {}) {
  if (platform === "win32") return null;
  const res = run("ps", ["-A", "-o", "pid=,ppid=,tty=,lstart=,args="], { encoding: "utf8", timeout: 10000 });
  return res.status === 0 ? parsePs(res.stdout) : null;
}

export function formatStaleSessions(list, { now = Date.now() } = {}) {
  const when = (ms) => new Date(ms).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
  const age = (ms) => { const h = Math.round((now - ms) / 3600000); return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`; };
  return list.map((s) => `  ${s.app}${s.tty ? ` on ${s.tty}` : ""}, started ${when(s.startedAt)} (${age(s.startedAt)}), pid ${s.appPid}`);
}
