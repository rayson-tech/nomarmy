// Removing finished jobs' runtime/ directories: each job's npm cache and
// harness state (Codex's, OpenClaw's transcript), about 100 MB a job, and
// 2 GB after a busy day of real runs. Shared by `nomarmy jobs --prune` and
// the health check's automatic prune (lib/health.mjs).
//
// Only a job with a final record (metadata.json with finishedAt) and no
// live lease is touched. A running job's status.json heartbeat is always in
// the past, and treating it as a finish time deleted a live job's state
// with --older-than 0. The record, logs, report and any kept worktree stay.

import fs from "node:fs";
import path from "node:path";

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

function sizeOf(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { n += fs.lstatSync(p).size; } catch { /* gone */ } }
    }
  }
  return n;
}

/**
 * @param {{ stateRoot: string, olderThanMs: number, now?: number }} input
 * @returns {{ pruned: number, freedBytes: number }}
 */
export function pruneJobRuntime({ stateRoot, olderThanMs, now = Date.now() }) {
  const jobsRoot = path.join(stateRoot, "jobs"), leasesRoot = path.join(stateRoot, "leases");
  const cutoff = now - olderThanMs;
  let pruned = 0, freedBytes = 0, names = [];
  try { names = fs.readdirSync(jobsRoot); } catch { return { pruned, freedBytes }; }
  for (const name of names) {
    const dir = path.join(jobsRoot, name), runtime = path.join(dir, "runtime");
    if (!fs.existsSync(runtime)) continue;
    const finishedAt = Date.parse(readJson(path.join(dir, "metadata.json"))?.finishedAt ?? "");
    if (!Number.isFinite(finishedAt) || finishedAt > cutoff) continue;
    if (fs.existsSync(path.join(leasesRoot, `${name}.json`))) continue;
    freedBytes += sizeOf(runtime);
    fs.rmSync(runtime, { recursive: true, force: true });
    pruned++;
  }
  return { pruned, freedBytes };
}

/**
 * How old a finished job must be before the health check prunes it on its
 * own: NOMARMY_AUTO_PRUNE_HOURS (default 24, the window a report recovery
 * could still want the transcript), or null when set to 0 or "off".
 */
export function autoPruneAgeMs(env = process.env) {
  const raw = env.NOMARMY_AUTO_PRUNE_HOURS;
  if (raw === undefined || raw === "") return 24 * 3600000;
  if (/^(0|off|false|no)$/i.test(String(raw).trim())) return null;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours * 3600000 : 24 * 3600000;
}
