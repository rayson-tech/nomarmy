import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDetachedJob, readDetachedJob } from "../lib/detached-job.mjs";

test("startDetachedJob: saves the admitted arguments, starts `server.mjs --run-job <id>` detached, and marks the job running under its pid", (t) => {
  const jobsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "detached-"));
  t.after(() => fs.rmSync(jobsRoot, { recursive: true, force: true }));
  const calls = [];
  const spawnFn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: 4242, unref() { calls.push("unref"); } }; };
  const args = { task: "Review it", mode: "scout", reviews: "worker-1", agentName: "meta", on_behalf_of: "me@example.com" };
  const pid = startDetachedJob({ args, jobId: "scout-1", jobsRoot, serverFile: "/x/mcp/server.mjs", cwd: "/repo", env: { A: "1" }, spawnFn, now: new Date("2026-10-21T00:00:00Z") });
  assert.equal(pid, 4242);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, ["/x/mcp/server.mjs", "--run-job", "scout-1"]);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.cwd, "/repo");
  assert.deepEqual(calls[0].opts.env, { A: "1" });
  assert.equal(calls[1], "unref", "the session doesn't wait on it");
  assert.deepEqual(readDetachedJob(jobsRoot, "scout-1"), { args, jobId: "scout-1" });
  const status = JSON.parse(fs.readFileSync(path.join(jobsRoot, "scout-1", "status.json"), "utf8"));
  assert.deepEqual({ ...status, updatedAt: null }, { jobId: "scout-1", mode: "scout", phase: "starting", state: "running", serverPid: 4242, detached: true, startedAt: "2026-10-21T00:00:00.000Z", updatedAt: null });
  assert.ok(fs.existsSync(path.join(jobsRoot, "scout-1", "detached.log")));
  assert.throws(() => readDetachedJob(jobsRoot, "../escape"), /is not a job id/);
});
