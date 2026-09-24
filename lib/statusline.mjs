#!/usr/bin/env node
// nomArmy in Claude Code's status line.
//
// Claude Code runs a status-line command each time it redraws, passing the
// session (model, working directory) as JSON on stdin, and shows the one
// line it prints. This prints the session's model and repo, then what
// nomArmy is doing across every session on the machine:
//
//   Opus 5.5 · rayson-senti │ 🍪 sr-dev codex/gpt-6-astra 9m 10f │ run 3/40 $0.41
//   Opus 5.5 · rayson-senti │ 🍪 2: scout claude 20s · sr-dev-action-wr… codex 20s │ run 5/14 $2.16
//
// Kept short: Claude Code cuts a long status line off. Job names lose
// their date/time/hash suffix, models show only for a single job, and
// the whole line is capped (NOMARMY_STATUSLINE_MAX, default 90), with
// jobs that don't fit collapsing to "+N" so the run summary survives.
//
// Deliberately Node built-ins only, reading nothing but the job leases,
// their status files and this repo's open runs: it runs on every redraw.
// `nomarmy connect claude` installs it (unless a status line is already
// configured); `nomarmy statusline` runs the same thing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
/** "scout-20260924-143127-49f447" -> "scout"; long names shortened. */
export function shortJobName(name, max = 18) {
  const bare = String(name ?? "job").replace(/-\d{8}-\d{6}-[0-9a-f]{4,}$/i, "");
  return bare.length > max ? `${bare.slice(0, max - 1)}…` : bare;
}

const minutes = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3600000 ? `${Math.round(ms / 60000)}m` : `${Math.floor(ms / 3600000)}h${String(Math.round((ms % 3600000) / 60000)).padStart(2, "0")}`);

/**
 * The status line's text.
 * @param {{ session?: object, stateRoot?: string, now?: number }} input
 */
export function statusLineText({ session = {}, stateRoot, now = Date.now(), maxLength = Number(process.env.NOMARMY_STATUSLINE_MAX) || 90 } = {}) {
  const root = stateRoot ?? (process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents"));
  const cwd = session.workspace?.current_dir ?? session.cwd ?? process.cwd();
  const repoName = path.basename(cwd);
  const head = [session.model?.display_name, repoName.length > 16 ? `${repoName.slice(0, 15)}…` : repoName].filter(Boolean).join(" · ");

  const leasesDir = path.join(root, "leases");
  let leases = [];
  try { leases = fs.readdirSync(leasesDir).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(leasesDir, f))).filter((l) => l && pidAlive(l.pid)); } catch { /* none */ }
  const single = leases.length === 1;
  const jobs = leases.map((l) => {
    const status = readJson(path.join(root, "jobs", l.jobId, "status.json")) ?? {};
    const name = shortJobName(l.role ?? status.workerId ?? l.jobId);
    const who = l.agent ? `${l.agent}${single && l.model ? `/${l.model}` : ""}` : "local";
    const started = Date.parse(status.startedAt ?? l.startedAt ?? "") || now;
    const files = Number.isFinite(status.filesChangedLive) && status.filesChangedLive > 0 ? ` ${status.filesChangedLive}f` : "";
    const phase = status.phase && status.phase !== "worker" ? ` ${status.phase}` : "";
    return `${name} ${who} ${minutes(now - started)}${files}${phase}`;
  });

  let runPart = "";
  try {
    const runsDir = path.join(root, "runs");
    const open = fs.readdirSync(runsDir).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(runsDir, f)))
      .filter((r) => r?.status === "running" && r.repo === cwd).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const run = open[0];
    if (run) {
      const inFlight = leases.filter((l) => l.runId === run.id).length;
      const spent = run.jobs.reduce((s, j) => s + (j.kind === "api" && Number.isFinite(j.costUsd) ? j.costUsd : 0), 0);
      const warn = Object.keys(run.pausedAgents ?? {}).length ? " ⚠ agent paused" : "";
      runPart = ` │ run ${run.jobs.length + inFlight}/${run.limits.max_jobs}${spent ? ` $${spent.toFixed(2)}` : ""}${warn}`;
    }
  } catch { /* no runs */ }
  // As many jobs as fit, then "+N": the run summary is never what gets cut.
  const prefix = `${head ? `${head} │ ` : ""}🍪 `;
  const count = jobs.length > 1 ? `${jobs.length}: ` : "";
  let shown = jobs.length, army;
  for (;;) {
    const rest = jobs.length - shown;
    army = !jobs.length ? "idle" : `${count}${jobs.slice(0, shown).join(" · ")}${rest ? `${shown ? " " : ""}+${rest}` : ""}`;
    if (shown === 0 || [...`${prefix}${army}${runPart}`].length <= maxLength) break;
    shown--;
  }
  return `${prefix}${army}${runPart}`;
}

const isMain = (() => { try { return path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  let session = {};
  if (!process.stdin.isTTY) { try { session = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { /* no session JSON */ } }
  process.stdout.write(`${statusLineText({ session })}\n`);
}
