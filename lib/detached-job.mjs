// detach: true on local_worker_start. A job normally runs inside the MCP
// server of the coordinator session that started it, so it ends when that
// session does; a headless General that sleeps between wakes had to stay
// open (and metered) for a whole review. A detached job runs in its own
// process, `node mcp/server.mjs --run-job <id>`, through the same launch
// path, and records its result in the job directory like any other job.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ARGS_FILE = "detached-job.json";

/**
 * Write the admitted job's arguments and start its process. Returns the
 * child's pid. `serverFile` is mcp/server.mjs (this install's copy).
 */
export function startDetachedJob({ args, jobId, jobsRoot, serverFile, cwd = process.cwd(), env = process.env, spawnFn = spawn, now = new Date() }) {
  const jobDir = path.join(jobsRoot, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, ARGS_FILE), JSON.stringify({ args, jobId }), { mode: 0o600 });
  const log = fs.openSync(path.join(jobDir, "detached.log"), "a");
  let child;
  try {
    child = spawnFn(process.execPath, [serverFile, "--run-job", jobId], { cwd, env, detached: true, stdio: ["ignore", log, log], windowsHide: true });
  } finally { fs.closeSync(log); }
  child.unref?.();
  // Until the job's own first status write, so a status call right away
  // sees a running job rather than nothing.
  fs.writeFileSync(path.join(jobDir, "status.json"), JSON.stringify({ jobId, mode: args.mode ?? "implement", phase: "starting", state: "running",
    serverPid: child.pid, detached: true, startedAt: now.toISOString(), updatedAt: now.toISOString() }, null, 2));
  return child.pid;
}

/** The arguments a detached job was admitted with. */
export function readDetachedJob(jobsRoot, jobId) {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(jobId))) throw new Error(`"${jobId}" is not a job id`);
  return JSON.parse(fs.readFileSync(path.join(jobsRoot, jobId, ARGS_FILE), "utf8"));
}
