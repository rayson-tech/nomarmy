import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createJobRuntime } from "../lib/admission.mjs";
import { createProcess } from "../lib/process.mjs";
import { createExecutor } from "../lib/execute.mjs";
import { deriveBudgets } from "../lib/budget.mjs";
import { processErrorSummary } from "../lib/process-error.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".base-ref-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"), remote = path.join(root, "remote.git");
  const state = path.join(root, "state"), jobsRoot = path.join(state, "jobs");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "no-global-config"), LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, "content"), "original\n");
  fs.writeFileSync(path.join(repo, ".nomarmy.yml"), "verification:\n  quick:\n    commands: ['true']\n");
  git("add", "."); git("commit", "-qm", "initial");
  git("init", "--bare", "-q", remote);
  git("remote", "add", "origin", remote);
  // Seed a remote-only branch without creating a local tracking ref.
  git("push", remote, "HEAD:refs/heads/topic/nested");
  fs.writeFileSync(path.join(repo, "content"), "operator's uncommitted work\n");
  fs.writeFileSync(path.join(repo, "untracked"), "keep me\n");
  const before = { head: git("rev-parse", "HEAD"), branch: git("symbolic-ref", "HEAD"), status: git("status", "--porcelain=v1") };
  const runner = createProcess({ projectDir: repo, jobsRoot });
  const calls = [];
  const run = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return runner.run(cmd, args, opts); };
  const budgets = deriveBudgets({ env: {} });
  const runtime = createJobRuntime({ projectDir: repo, stateRoot: state, jobsRoot, leasesRoot: path.join(state, "leases"),
    env: { NOMARMY_LLAMA_HOST: "gpu.internal" }, run, projectDirProblem: () => null,
    budgetState: { hardwareSnapshot: null, contextInfo: { slots: 3 }, budgets, refresh: async () => {} },
    currentMaxWorkers: () => 3, budgetsForJob: () => budgets, subscriptionJobFieldProblems: () => [], repoPolicy: () => ({}) });
  const unchanged = () => {
    assert.deepEqual({ head: git("rev-parse", "HEAD"), branch: git("symbolic-ref", "HEAD"), status: git("status", "--porcelain=v1") }, before);
    assert.equal(fs.readFileSync(path.join(repo, "content"), "utf8"), "operator's uncommitted work\n");
    assert.equal(fs.readFileSync(path.join(repo, "untracked"), "utf8"), "keep me\n");
    assert.equal(git("worktree", "list", "--porcelain").split("\n").filter(l => l.startsWith("worktree ")).length, 1);
  };
  return { root, repo, remote, state, jobsRoot, git, run, calls, runtime, unchanged };
}
const job = (mode, base_ref) => ({ task: "Check the change", mode, verification: "quick", ...(base_ref === undefined ? {} : { base_ref }) });

for (const mode of ["implement", "scout", "decompose", "verify"]) {
  test(`${mode} refuses a missing remote base at admission without creating job state`, async t => {
    const f = fixture(t);
    const result = await f.runtime.admit([job(mode, "origin/missing")]);
    assert.deepEqual(Object.keys(result).sort(), ["admission", "problems"]);
    assert.deepEqual(result.problems, ["base_ref origin/missing not found in this checkout; run: git fetch origin missing; git exited 128: fatal: couldn't find remote ref missing"]);
    assert.equal(f.runtime.refusal(result.problems).content[0].text,
      "REFUSED - nothing was started.\n- " + result.problems[0]);
    assert.equal(f.runtime.activeJobs.size, 0);
    assert.equal(fs.existsSync(f.jobsRoot), false);
    assert.equal(f.calls.filter(c => c.args[0] === "fetch").length, 1);
    f.unchanged();
  });
}

test("batch admission fetches each missing remote base once, notes it, and leaves HEAD jobs alone", async t => {
  const f = fixture(t);
  const result = await f.runtime.admit(["implement", "scout", "decompose", "verify"].map(mode => job(mode, "origin/topic/nested")));
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.admission.reasons.filter(n => n.startsWith("fetched ")), ["fetched origin/topic/nested"]);
  const fetches = f.calls.filter(c => c.args[0] === "fetch");
  assert.equal(fetches.length, 1);
  assert.deepEqual(Object.keys(fetches[0]).sort(), ["args", "cmd", "opts"]);
  assert.equal(fetches[0].cmd, "git");
  assert.deepEqual(fetches[0].args, ["fetch", "--", "origin", "topic/nested"]);
  assert.deepEqual(Object.keys(fetches[0].opts).sort(), ["cwd", "env", "timeoutMs"]);
  assert.equal(fetches[0].opts.cwd, f.repo);
  assert.equal(fetches[0].opts.timeoutMs, 60000);
  assert.equal(fetches[0].opts.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(f.git("rev-parse", "origin/topic/nested"), f.git("rev-parse", "HEAD"));
  f.calls.length = 0;
  assert.deepEqual((await f.runtime.admit([job("verify"), job("verify", "origin/topic/nested")])).problems, []);
  assert.deepEqual(f.calls.map(c => c.args), [["rev-parse", "--verify", "--end-of-options", "origin/topic/nested^{commit}"]]);
  assert.equal(fs.existsSync(f.jobsRoot), false);
  f.unchanged();
});

test("batch admission refuses nonremote revisions without fetching and keeps continuation validation", async t => {
  const f = fixture(t);
  const refs = ["missing", "unknown/topic", "origin/topic~1", "origin/topic:other", "--help"];
  const result = await f.runtime.admit(refs.map(ref => job("verify", ref)));
  assert.deepEqual(result.problems, refs.map((ref, i) => `job ${i + 1}: base_ref ${ref} not found in this checkout; use a ref present in this checkout, or run: git fetch <remote> <branch>`));
  assert.equal(f.calls.filter(c => c.args[0] === "fetch").length, 0);
  f.calls.length = 0;
  const continuation = await f.runtime.admit([{ ...job("implement", "origin/missing"), continue_from: "old-job" }]);
  assert.equal(continuation.problems.length, 1);
  assert.match(continuation.problems[0], /base_ref/);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.jobsRoot), false);
  f.unchanged();
});

test("git diagnostics retain the fatal reason, redact credentials, and cap long output", async t => {
  const f = fixture(t);
  await assert.rejects(f.run("git", ["rev-parse", "--verify", "missing^{commit}"], { cwd: f.repo }), error => {
    assert.equal(error.message, "git exited 128: fatal: Needed a single revision");
    assert.equal(error.stderr, "fatal: Needed a single revision\n");
    assert.equal(processErrorSummary(error), error.message);
    return true;
  });
  const secret = new Error("git exited 128\nSTDERR:\nprogress\nfatal: cannot access https://user:password@example.com/repo?token=secret\nextra output\nSTDOUT:\nprivate");
  assert.equal(processErrorSummary(secret), "git exited 128: fatal: cannot access https://<redacted>@example.com/repo?token=<redacted>");
  const huge = new Error("git exited 128");
  huge.stderr = "fatal: " + "word ".repeat(400) + "\nerror: hidden";
  const summary = processErrorSummary(huge);
  assert.ok(summary.length <= 600);
  assert.equal(summary.includes("\n"), false);
  assert.equal(summary.includes("hidden"), false);
});

test("a missing git ref reaches failure issues and the finished event", async t => {
  const f = fixture(t);
  const executor = createExecutor({ VERSION: "test", projectDir: f.repo, jobsRoot: f.jobsRoot,
    run: f.run, assertRepo: async () => {}, ensureJobsRoot: () => fs.mkdirSync(f.jobsRoot, { recursive: true }),
    sweepStaleSandboxContainers: async () => {}, resolveBase: async () => ({ ref: "missing", sha: "missing" }) });
  const id = "git-failure", dir = path.join(f.jobsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ jobId: id, phase: "worktree", state: "running", serverPid: process.pid, projectDir: f.repo, startedAt: new Date().toISOString() }));
  const watcher = spawn(process.execPath, ["bin/nomarmy.mjs", "jobs", "--events", "--until-done", "--json", "--interval", "1"],
    { cwd: process.cwd(), env: { ...process.env, NOMARMY_AGENT_STATE: f.state } });
  t.after(() => watcher.kill());
  const events = [];
  let result, stderr = "";
  watcher.stderr.on("data", d => { stderr += d; });
  const lines = createInterface({ input: watcher.stdout });
  const code = await new Promise((resolve, reject) => {
    watcher.once("error", reject);
    watcher.once("close", resolve);
    lines.on("line", async line => {
      try {
        const event = JSON.parse(line);
        events.push(event);
        if (event.event === "running") result = await executor.executeJob({ mode: "implement", task: "test", jobId: id });
      } catch (error) { watcher.kill(); reject(error); }
    });
  });
  assert.equal(code, 0, stderr);
  assert.equal(result.ok, false);
  // git's wording and exit code vary by version ("invalid reference" with 128,
  // "not a valid object name" with 255); what matters is that its own fatal:
  // reason, naming the ref, comes through everywhere.
  const issue = result.manifest.issues[0];
  assert.match(issue, /^git exited \d+: fatal: [^\n]*missing/);
  assert.deepEqual(result.manifest.issues, [issue]);
  assert.equal(result.manifest.error, "Error: " + issue);
  const failure = JSON.parse(fs.readFileSync(path.join(dir, "failure.json")));
  assert.deepEqual(failure.issues, [issue]);
  assert.deepEqual(events.map(e => e.event), ["scope", "running", "finished", "done"]);
  const finished = events[2];
  assert.deepEqual(Object.keys(finished).sort(), ["agent", "at", "detail", "event", "jobId", "model", "phase"]);
  assert.equal(finished.phase, "WORKER_FAILED");
  assert.match(finished.detail, /^WORKER_FAILED after \d+s: /);
  assert.equal(finished.detail.replace(/^WORKER_FAILED after \d+s: /, ""), issue);
  f.unchanged();
});
