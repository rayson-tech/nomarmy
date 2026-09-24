#!/usr/bin/env node
// nomArmy in Claude Code's status line.
//
// Claude Code runs a status-line command each time it redraws, passing the
// session (model, working directory) as JSON on stdin, and shows the one
// line it prints. This prints the session's model and repo, then what
// nomArmy is doing across every session on the machine:
//
//   Opus 5.5 · rayson-senti │ 🍪 1 running: sr-dev codex/gpt-6-astra 9m 10f │ run safe-rescan 3/40 jobs $0.41
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
const minutes = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3600000 ? `${Math.round(ms / 60000)}m` : `${Math.floor(ms / 3600000)}h${String(Math.round((ms % 3600000) / 60000)).padStart(2, "0")}`);

/**
 * The status line's text.
 * @param {{ session?: object, stateRoot?: string, now?: number }} input
 */
export function statusLineText({ session = {}, stateRoot, now = Date.now() } = {}) {
  const root = stateRoot ?? (process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents"));
  const cwd = session.workspace?.current_dir ?? session.cwd ?? process.cwd();
  const head = [session.model?.display_name, path.basename(cwd)].filter(Boolean).join(" · ");

  const leasesDir = path.join(root, "leases");
  let leases = [];
  try { leases = fs.readdirSync(leasesDir).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(leasesDir, f))).filter((l) => l && pidAlive(l.pid)); } catch { /* none */ }
  const jobs = leases.map((l) => {
    const status = readJson(path.join(root, "jobs", l.jobId, "status.json")) ?? {};
    const name = l.role ?? status.workerId ?? l.jobId;
    const who = l.agent ? `${l.agent}${l.model ? `/${l.model}` : ""}` : "local";
    const started = Date.parse(status.startedAt ?? l.startedAt ?? "") || now;
    const files = Number.isFinite(status.filesChangedLive) && status.filesChangedLive > 0 ? ` ${status.filesChangedLive}f` : "";
    const phase = status.phase && status.phase !== "worker" ? ` ${status.phase}` : "";
    return `${name} ${who} ${minutes(now - started)}${files}${phase}`;
  });
  const army = jobs.length ? `🍪 ${jobs.length} running: ${jobs.slice(0, 3).join(" · ")}${jobs.length > 3 ? ` +${jobs.length - 3}` : ""}` : "🍪 idle";

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
      runPart = ` │ run ${run.name.slice(0, 24)} ${run.jobs.length + inFlight}/${run.limits.max_jobs} jobs${spent ? ` $${spent.toFixed(2)}` : ""}${warn}`;
    }
  } catch { /* no runs */ }
  return `${head ? `${head} │ ` : ""}${army}${runPart}`;
}

const isMain = (() => { try { return path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  let session = {};
  if (!process.stdin.isTTY) { try { session = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { /* no session JSON */ } }
  process.stdout.write(`${statusLineText({ session })}\n`);
}
