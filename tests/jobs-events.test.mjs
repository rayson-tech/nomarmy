import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInterface } from "node:readline";
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

test("jobs --events --until-done scopes a run and a repository while another job keeps running", async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-events-scoped-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const repoA = path.join(state, "repo-a");
  const repoB = path.join(state, "repo-b");
  const makeJob = (id, runId, repo) => {
    const dir = path.join(state, "jobs", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ jobId: id, state: "running", phase: "worker", serverPid: process.pid, startedAt: new Date().toISOString() }));
    fs.mkdirSync(path.join(state, "leases"), { recursive: true });
    fs.writeFileSync(path.join(state, "leases", `${id}.json`), JSON.stringify({ runId, repo }));
    return () => {
      fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ outcome: "WORKER_DONE", finishedAt: new Date().toISOString(), labels: { runId }, projectDir: repo }));
      fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ jobId: id, state: "finished", phase: "finished", serverPid: process.pid, startedAt: new Date().toISOString() }));
      fs.rmSync(path.join(state, "leases", `${id}.json`));
    };
  };
  const finishA = makeJob("job-a", "run-a", repoA);
  makeJob("job-b", "run-b", repoB);
  for (const filter of [["--run", "run-a"], ["--repo", repoA]]) {
    const watcher = spawn(process.execPath, [CLI, "jobs", "--events", "--until-done", "--json", ...filter, "--interval", "1"], { env: { ...process.env, NOMARMY_AGENT_STATE: state } });
    t.after(() => watcher.kill());
    const events = [];
    let stderr = "";
    watcher.stderr.on("data", data => { stderr += data; });
    const lines = createInterface({ input: watcher.stdout });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        watcher.kill();
        reject(new Error(`scoped watcher timed out: ${JSON.stringify(events)}; ${stderr}`));
      }, 60_000);
      const fail = error => { clearTimeout(timer); watcher.kill(); reject(error); };
      watcher.once("error", fail);
      // close, unlike exit, waits until stdout has been drained.
      watcher.once("close", code => { clearTimeout(timer); resolve(code); });
      lines.on("line", line => {
        try {
          const event = JSON.parse(line);
          events.push(event);
          // The CLI must observe running before we publish the finished record.
          // No startup delay or polling interval can race this handshake.
          if (event.event === "running" && event.jobId === "job-a") finishA();
        } catch (error) { fail(error); }
      });
    });
    assert.equal(code, 0, stderr);
    assert.deepEqual(events.map(({ event, jobId }) => ({ event, jobId })), [
      { event: "running", jobId: "job-a" },
      { event: "finished", jobId: "job-a" },
      { event: "done", jobId: undefined },
    ]);
    assert.equal(events[2].detail, "every job seen running has finished");
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, "jobs", "job-b", "status.json"), "utf8")).state, "running");
    // Restore the job for the next filter.
    if (filter[0] === "--run") makeJob("job-a", "run-a", repoA);
  }
});

test("unscoped jobs --events warns that it watches every machine job", async (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-events-warning-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const watcher = spawn(process.execPath, [CLI, "jobs", "--events", "--until-done", "--interval", "1"], { env: { ...process.env, NOMARMY_AGENT_STATE: state } });
  let output = "";
  watcher.stdout.on("data", (d) => { output += d; });
  await new Promise((resolve) => watcher.stdout.once("data", resolve));
  watcher.kill();
  assert.equal(output.split("\n")[0], "watching every job on this machine; use --wait <ids> or --run <id> to scope the watch");
});
