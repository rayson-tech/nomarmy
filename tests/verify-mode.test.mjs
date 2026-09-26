import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandJobs, jobSchema } from "../mcp/server.mjs";
import { createExecutor } from "../lib/execute.mjs";
import { createVerificationFlow } from "../lib/verification-flow.mjs";
import { createJobRuntime, jobLane } from "../lib/admission.mjs";
import { createRun, loadRun } from "../lib/runs.mjs";
import { compactJobRecord, formatResult } from "../lib/job-format.mjs";

test("verify is model-free from expansion through admission, execution and reporting", async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".verify-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const forbidden = () => { throw Error("model path called"); };
  assert.equal(jobSchema.shape.mode.parse("verify"), "verify");
  for (const role of [null, "po"]) {
    const job = { task: "tests", mode: "verify", verification: "quick", ...(role ? { army_role: role, agent: "missing", model: "missing" } : {}) };
    assert.deepEqual(expandJobs([job], { getActiveRun: () => null, getArmy: forbidden, getAgents: forbidden, env: { NOMARMY_EXECUTION: "hosted" } }),
      { jobs: [{ task: "tests", mode: "verify", verification: "quick", ...(role ? { armyRole: role } : {}) }], problems: [] });
  }
  fs.writeFileSync(path.join(root, ".nomarmy.yml"), "verification:\n  quick:\n    commands: ['true']\n");
  let repoProblem = null;
  const runtime = createJobRuntime({ projectDir: root, stateRoot: root, jobsRoot: root, leasesRoot: path.join(root, "leases"),
    budgetState: { refresh: forbidden }, modelCatalogReady: forbidden, budgetsForJob: forbidden,
    runsRoot: path.join(root, "runs"), agentsConfig: forbidden, subscriptionJobFieldProblems: forbidden, repoPolicy: () => ({}),
    projectDirProblem: () => repoProblem, currentMaxWorkers: () => 0 });
  const job = { task: "tests", mode: "verify", verification: "quick", agentName: "missing", model: "missing" };
  assert.equal(jobLane(job), "remote");
  assert.deepEqual((await runtime.admit([job])).problems, []);
  assert.deepEqual((await runtime.admit([{ ...job, verification: undefined }])).problems,
    ["verify requires a verification profile from .nomarmy.yml; available profiles: quick"]);
  assert.deepEqual((await runtime.admit([{ ...job, verification: "unknown" }])).problems,
    ["verify requires a verification profile from .nomarmy.yml; available profiles: quick"]);
  repoProblem = "not a git repository";
  assert.deepEqual((await runtime.admit([job])).problems, ["not a git repository"]);

  repoProblem = null;
  const run = createRun(path.join(root, "runs"), { name: "acceptance", repo: root, limits: { max_jobs: 1, max_api_usd: 100, max_hours: 1 } });
  const runJob = { ...job, run_id: run.id, armyRole: "po" };
  assert.deepEqual((await runtime.admit([runJob])).problems, []);
  runtime.recordJobInRun(runJob, "verified", { manifest: { outcome: "VERIFIED" } });
  const recorded = loadRun(path.join(root, "runs"), run.id).jobs[0];
  const { recordedAt, ...fields } = recorded;
  assert.equal(typeof recordedAt, "string");
  assert.deepEqual(fields, { jobId: "verified", agent: null, kind: "verify", model: null, role: "po", mode: "verify",
    outcome: "VERIFIED", costUsd: 0, tokens: 0, usageLimit: null });
  assert.deepEqual((await runtime.admit([runJob])).problems, [`run "${run.id}" has used all 1 of its jobs`]);

  for (const [status, outcome, coordinatorStatus] of [
    ["pass", "VERIFIED", "complete"], ["fail", "VERIFICATION_FAILED", "failed"], ["not_run", "VERIFICATION_NOT_RUN", "incomplete"]
  ]) {
    const calls = [];
    const flow = createVerificationFlow({});
    if (status !== "not_run") flow.registerVerificationRunner(async context => {
      assert.equal(context.mode, "verify");
      assert.equal(context.baseSha, "selected-sha");
      assert.equal(fs.readFileSync(path.join(context.cwd, "content"), "utf8"), "selected content");
      return { status, detail: { tail: "test output" } };
    });
    const executor = createExecutor({ VERSION: "test", projectDir: root, jobsRoot: root,
      assertRepo: async () => {}, ensureJobsRoot: () => root, resolveBase: async ref => { assert.equal(ref, "selected"); return { ref, sha: "selected-sha" }; },
      runOpenClaw: forbidden, sweepStaleSandboxContainers: forbidden,
      collectGitRecord: async () => ({ baseSha: "selected-sha" }), ...flow,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[1] === "add") { fs.mkdirSync(args[3]); fs.writeFileSync(path.join(args[3], "content"), "selected content"); }
        else fs.rmSync(args[3], { recursive: true });
      }
    });
    const r = await executor.executeJob({ task: "tests", mode: "verify", verification: "quick", baseRef: "selected", jobId: status });
    const wt = path.join(root, status, "worktree");
    assert.deepEqual(calls, [["git", "worktree", "add", "--detach", wt, "selected-sha"], ["git", "worktree", "remove", "--force", wt]]);
    assert.equal(fs.existsSync(wt), false);
    assert.equal(r.ok, status === "pass");
    assert.equal(r.manifest.outcome, outcome);
    assert.equal(r.manifest.coordinatorStatus, coordinatorStatus);
    assert.equal(r.manifest.verification.status, status);
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.jobDir, "metadata.json"))).outcome, outcome);
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.jobDir, "status.json"))).phase, "finished");
    const compact = compactJobRecord(r.manifest);
    assert.deepEqual(Object.keys(compact).sort(), ["jobId", "workerId", "mode", "outcome", "coordinatorStatus", "baseRef", "baseSha", "verification", "elapsedSeconds", "worktreeRetained", "error"].sort());
    assert.equal(compact.baseRef, "selected");
    assert.equal(compact.baseSha, "selected-sha");
    assert.equal(formatResult(r), `OUTCOME: ${outcome}\n\n--- VERIFICATION RECORD ---\n${JSON.stringify(compact, null, 2)}\n\nJob artifacts: ${r.jobDir}`);
  }
});

// Against a real repository: a fresh server module pointed at a throwaway
// repo (the same pattern as the union-branch tests in worker-contract).
test("verify against a real git repo: checks the named commit's content, maps pass/fail/not_run, and removes its worktree", async () => {
  const { execFileSync } = await import("node:child_process");
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-verify-repo-")));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-verify-state-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  const prev = { dir: process.env.CLAUDE_PROJECT_DIR, state: process.env.NOMARMY_AGENT_STATE };
  try {
    git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "result.txt"), "pass\n");
    git("add", "-A"); git("commit", "-q", "-m", "passing");
    const passing = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, "result.txt"), "fail\n");
    git("commit", "-qam", "failing");
    process.env.CLAUDE_PROJECT_DIR = repo; process.env.NOMARMY_AGENT_STATE = state;
    const mod = await import(`../mcp/server.mjs?verify-test=${process.hrtime.bigint()}`);
    // No runner registered yet: nothing ran, and it says so.
    const notRun = await mod.executeJob({ mode: "verify", verification: "quick", task: "check", baseRef: passing, workerId: "v0" });
    assert.equal(notRun.manifest.outcome, "VERIFICATION_NOT_RUN");
    assert.equal(notRun.manifest.coordinatorStatus, "incomplete");
    // The stub stands in for the sandboxed runner: it reads the checked-out commit.
    const seen = [];
    mod.registerVerificationRunner(({ cwd, profile }) => {
      const content = fs.readFileSync(path.join(cwd, "result.txt"), "utf8").trim();
      seen.push({ content, profile });
      return { status: content === "pass" ? "pass" : "fail", detail: `saw ${content}` };
    });
    const ok = await mod.executeJob({ mode: "verify", verification: "quick", task: "check", baseRef: passing, workerId: "v1" });
    assert.equal(ok.manifest.outcome, "VERIFIED");
    assert.equal(ok.manifest.coordinatorStatus, "complete");
    assert.equal(ok.manifest.baseSha, passing, "base_ref is honored");
    const bad = await mod.executeJob({ mode: "verify", verification: "quick", task: "check", workerId: "v2" });
    assert.equal(bad.manifest.outcome, "VERIFICATION_FAILED", "default is HEAD, the failing commit");
    assert.equal(bad.manifest.coordinatorStatus, "failed");
    assert.deepEqual(seen, [{ content: "pass", profile: "quick" }, { content: "fail", profile: "quick" }]);
    for (const r of [notRun, ok, bad]) {
      assert.equal(r.manifest.worktree, null);
      assert.ok(!fs.existsSync(path.join(r.jobDir, "worktree")), "the worktree is removed");
      assert.equal(r.manifest.metrics.worker_tokens_total, 0);
    }
    assert.equal(git("worktree", "list").split("\n").length, 1, "no worktree left registered");
  } finally {
    if (prev.dir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prev.dir;
    if (prev.state === undefined) delete process.env.NOMARMY_AGENT_STATE; else process.env.NOMARMY_AGENT_STATE = prev.state;
    for (const dir of [repo, state]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
