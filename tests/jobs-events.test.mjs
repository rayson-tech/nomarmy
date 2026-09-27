import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "nomarmy.mjs");

// A General ran the plain stream as a background command, which is only
// reported when it exits, so it never heard the jobs finish. --until-done
// exits once every job it saw running has finished.
test("jobs --events --until-done reports the finish and exits", async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-events-"));
  const server = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]); // stands in for a live MCP server
  t.after(() => { server.kill(); fs.rmSync(state, { recursive: true, force: true }); });
  const dir = path.join(state, "jobs", "worker-sim");
  fs.mkdirSync(dir, { recursive: true });
  const write = (st) => fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ jobId: "worker-sim", mode: "implement", state: st, phase: st === "running" ? "worker" : "finished", serverPid: server.pid, startedAt: new Date().toISOString() }));
  write("running");
  const watcher = spawn(process.execPath, [CLI, "jobs", "--events", "--until-done", "--interval", "1"], { env: { ...process.env, NOMARMY_AGENT_STATE: state } });
  let out = "";
  watcher.stdout.on("data", (d) => { out += d; });
  const exited = new Promise((resolve) => watcher.on("exit", resolve));
  await new Promise((r) => setTimeout(r, 1500));
  write("finished");
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ outcome: "WORKER_DONE", finishedAt: new Date().toISOString() }));
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 8000))]);
  if (code === "still running") watcher.kill();
  assert.equal(code, 0, "it exits on its own");
  assert.match(out, /running\s+worker-sim/);
  assert.match(out, /finished\s+worker-sim .*WORKER_DONE/);
  assert.match(out, /done\s+every job seen running has finished/);
});
