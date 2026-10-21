import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createJobRuntime } from "../lib/admission.mjs";
import { deriveBudgets } from "../lib/budget.mjs";
import { recordServerStop, SERVER_STOP_REASONS } from "../lib/server-stop.mjs";

function runtimeAt(root) {
  const budgets = deriveBudgets({ env: {} });
  return createJobRuntime({ env: {}, projectDir: root, projectDirProblem: () => null, stateRoot: root, jobsRoot: root,
    leasesRoot: path.join(root, "leases"), budgetState: { hardwareSnapshot: null, contextInfo: { slots: 3 }, budgets, refresh: async () => {} },
    currentMaxWorkers: () => 3, budgetsForJob: () => budgets, subscriptionJobFieldProblems: () => [], repoPolicy: () => ({}) });
}
const tmp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphaned-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test("a job another live coordinator session runs is running, not orphaned (Base's 'orphaned' scouts)", async (t) => {
  const root = tmp(t);
  // A real, live process standing in for another session's MCP server.
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => other.kill());
  const summary = await runtimeAt(root).summarize(null, { status: { jobId: "j1", state: "running", serverPid: other.pid, mode: "scout" } });
  assert.equal(summary.state, "running");
  assert.match(summary.runningIn, new RegExp(`another coordinator session \\(MCP server pid ${other.pid}\\)`));
  assert.equal(summary.error, undefined);
});

test("a job whose server is gone is orphaned, and says how it stopped when the server recorded it", async (t) => {
  const root = tmp(t);
  const dead = 2 ** 22 + 12345; // beyond any pid this test machine hands out
  const runtime = runtimeAt(root);
  const silent = await runtime.summarize(null, { status: { jobId: "j1", state: "running", serverPid: dead } });
  assert.equal(silent.state, "orphaned");
  assert.match(silent.error, /is gone, without recording why .*closing or restarting that session ends them/);
  const told = await runtime.summarize(null, { status: { jobId: "j2", state: "running", serverPid: dead, serverStopped: { reason: SERVER_STOP_REASONS.SIGTERM, at: "2026-10-20T10:00:00.000Z" } } });
  assert.match(told.error, /stopped: its coordinator session closed or restarted the MCP server \(SIGTERM\) at 2026-10-20T10:00:00.000Z/);
});

test("recordServerStop marks only this server's running jobs", (t) => {
  const root = tmp(t);
  const write = (name, status) => { fs.mkdirSync(path.join(root, name)); fs.writeFileSync(path.join(root, name, "status.json"), JSON.stringify(status)); };
  write("mine", { jobId: "mine", state: "running", serverPid: 100 });
  write("done", { jobId: "done", state: "finished", serverPid: 100 });
  write("theirs", { jobId: "theirs", state: "running", serverPid: 200 });
  fs.writeFileSync(path.join(root, "stray-file"), "x");
  const marked = recordServerStop(root, SERVER_STOP_REASONS.stdin, { pid: 100, now: new Date("2026-10-20T10:00:00Z") });
  assert.deepEqual(marked, ["mine"]);
  const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name, "status.json"), "utf8"));
  assert.deepEqual(read("mine").serverStopped, { reason: SERVER_STOP_REASONS.stdin, at: "2026-10-20T10:00:00.000Z" });
  assert.equal(read("done").serverStopped, undefined);
  assert.equal(read("theirs").serverStopped, undefined);
  assert.deepEqual(recordServerStop(path.join(root, "missing"), "x"), []);
});
