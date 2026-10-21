// Jobs run inside the MCP server process of the coordinator session that
// started them. When that server stops, its running jobs end with it; this
// records why on each one, so the job reads "orphaned: its session closed"
// rather than an unexplained death.
import fs from "node:fs";
import path from "node:path";

/** Mark this server's running jobs with `reason`. Best-effort; returns the job ids marked. */
export function recordServerStop(jobsRoot, reason, { pid = process.pid, now = new Date() } = {}) {
  let names = [];
  try { names = fs.readdirSync(jobsRoot); } catch { return []; }
  const marked = [];
  for (const name of names) {
    const file = path.join(jobsRoot, name, "status.json");
    try {
      const status = JSON.parse(fs.readFileSync(file, "utf8"));
      if (status?.state !== "running" || status.serverPid !== pid) continue;
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...status, serverStopped: { reason, at: now.toISOString() } }, null, 2));
      fs.renameSync(`${file}.tmp`, file);
      marked.push(status.jobId ?? name);
    } catch { /* not a job directory, or unreadable */ }
  }
  return marked;
}

/** What each way of stopping means for the operator. */
export const SERVER_STOP_REASONS = Object.freeze({
  stdin: "its coordinator session closed or disconnected the MCP server",
  SIGTERM: "its coordinator session closed or restarted the MCP server (SIGTERM)",
  SIGINT: "it was interrupted (SIGINT)",
  SIGHUP: "its terminal closed (SIGHUP)",
});
