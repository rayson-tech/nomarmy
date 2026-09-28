import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { requestJobStop, makeStopRequestTick, readStopRequest, STOP_REQUEST_FILE } from "../lib/openclaw-run.mjs";
import { run } from "../mcp/server.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "nomarmy.mjs");

function jobsRoot(t, jobs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-stop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [id, files] of Object.entries(jobs)) {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(root, id, name), JSON.stringify(value));
  }
  return root;
}

test("requestJobStop stops only a job still in its worker, once, and records why", (t) => {
  const root = jobsRoot(t, {
    running: { "status.json": { state: "running", phase: "worker" } },
    verifying: { "status.json": { state: "running", phase: "verification" } },
    done: { "status.json": { state: "finished", phase: "finished" } },
  });
  const r = requestJobStop({ jobsRoot: root, jobId: "running", reason: "wrong track, burning astra" });
  assert.equal(r.ok, true);
  assert.match(r.message, /ends within about 15 seconds.*continue_from/);
  assert.equal(readStopRequest(path.join(root, "running")).reason, "wrong track, burning astra");
  assert.match(requestJobStop({ jobsRoot: root, jobId: "running" }).message, /already requested/);
  assert.match(requestJobStop({ jobsRoot: root, jobId: "verifying" }).message, /past its worker.*spends no more model usage/);
  assert.equal(requestJobStop({ jobsRoot: root, jobId: "verifying" }).ok, false);
  assert.match(requestJobStop({ jobsRoot: root, jobId: "done" }).message, /isn't running \(it's finished\)/);
  assert.match(requestJobStop({ jobsRoot: root, jobId: "nope" }).message, /no job nope/);
  assert.equal(requestJobStop({ jobsRoot: root, jobId: "../etc" }).ok, false);
});

test("the stop-request tick ends a worker, and a requested stop isn't a timeout (so no report recovery)", async (t) => {
  const root = jobsRoot(t, { j: { "status.json": { state: "running", phase: "worker" } } });
  const dir = path.join(root, "j");
  const tick = makeStopRequestTick(dir);
  assert.deepEqual(await tick(0), { stop: false });
  fs.writeFileSync(path.join(dir, STOP_REQUEST_FILE), "{}");
  assert.deepEqual(await tick(0), { stop: true, reason: "stopped" });
  await assert.rejects(run(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { onTick: async () => ({ stop: true, reason: "stopped" }), tickMs: 50 }),
    (error) => { assert.equal(error.stopReason, "stopped"); assert.equal(error.timedOut, false); return true; });
  await assert.rejects(run(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { onTick: async () => ({ stop: true, reason: "idle_diff" }), tickMs: 50 }),
    (error) => { assert.equal(error.timedOut, true, "the idle breaker still invites recovery"); return true; });
});

test("jobs --wait prints a commit sha, never [object Object] for a job that made no commit", (t) => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-stop-state-"));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const jobs = {
    committed: { outcome: "WORKER_DONE", commit: { created: true, sha: "abc1234" } },
    uncommitted: { outcome: "NEEDS_REVIEW", commit: { created: false, sha: null, reason: "x" } },
  };
  for (const [id, meta] of Object.entries(jobs)) {
    fs.mkdirSync(path.join(stateRoot, "jobs", id), { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "jobs", id, "status.json"), JSON.stringify({ state: "finished" }));
    fs.writeFileSync(path.join(stateRoot, "jobs", id, "metadata.json"), JSON.stringify(meta));
  }
  const wait = (id) => spawnSync(process.execPath, [CLI, "jobs", "--wait", id, "--timeout", "5"], { encoding: "utf8", env: { ...process.env, NOMARMY_AGENT_STATE: stateRoot } }).stdout;
  assert.match(wait("committed"), /commit=abc1234/);
  assert.doesNotMatch(wait("uncommitted"), /object Object|commit=/);
});
