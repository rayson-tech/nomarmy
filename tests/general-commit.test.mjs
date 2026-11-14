import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveOutcome, generalCommitEligibility, applyRefactorContract } from "../lib/outcome.mjs";
import { parseWorkerReport } from "../lib/report.mjs";
import { OUTCOMES } from "../lib/outcomes.mjs";
import { createGitRecord } from "../lib/git-record.mjs";
import { commitVerifiedJob, generalCommitProblem } from "../lib/general-commit.mjs";
import { registerJobsRoot, sealWorktree } from "../lib/worktree-pointer.mjs";

const report = (status, tests = "pass") => parseWorkerReport(`STATUS: ${status}\nTESTS: ${tests}\nNOT_DONE: ${status === "done" ? "none" : "the full UI suite needs Node 22, unavailable offline"}\nNOTE: raised a and added b`);
const pass = { status: "pass", basis: "profile" };
const eligibility = (outcome, extra = {}) => generalCommitEligibility({ outcome, mode: "implement", repositoryChanged: true, verificationStatus: "pass", ...extra });

test("a partial or blocked report is blocked by the claim alone; done is not", () => {
  for (const status of ["partial", "blocked"]) {
    const o = resolveOutcome({ report: report(status), repositoryChanged: true, independentVerification: pass });
    assert.equal(o.commitAllowed, false);
    assert.equal(o.claimBlocked, true, status);
  }
  const done = resolveOutcome({ report: report("done"), repositoryChanged: true, independentVerification: pass });
  assert.equal(done.commitAllowed, true);
  assert.equal(done.claimBlocked, undefined);
  const failed = resolveOutcome({ report: report("done"), repositoryChanged: true, independentVerification: { status: "fail" } });
  assert.equal(failed.claimBlocked, undefined, "a verification veto is not a claim block");
});

test("the General may commit a verified partial, and only when every other gate held", () => {
  const partial = resolveOutcome({ report: report("partial"), repositoryChanged: true, independentVerification: pass });
  assert.equal(eligibility(partial).eligible, true);
  assert.match(eligibility(partial).reason, /local_worker_commit/);
  const refusals = [
    [{ verificationStatus: "not_run" }, /not_run/],
    [{ verificationStatus: "fail" }, /fail/],
    [{ repositoryChanged: false }, /changed nothing/],
    [{ possibleSecret: true }, /secret/],
    [{ blockedInputs: 1 }, /verification runs/],
    [{ mutationStatus: "restore_failed" }, /mutation/],
    [{ regressionCheck: { status: "fail", basis: "reverted", reason: "still passed" } }, /regression check/],
    [{ workerStopReason: "stopped" }, /stopped/],
    [{ mode: "scout" }, /scout mode/],
  ];
  for (const [extra, why] of refusals) {
    const e = eligibility(partial, extra);
    assert.equal(e.eligible, false, JSON.stringify(extra));
    assert.match(e.reason, why);
  }
  assert.equal(eligibility(partial, { regressionCheck: { status: "not_run", basis: "not-applicable" } }).eligible, true);
  const refactorBlocked = applyRefactorContract(partial, { refactor: true, verificationStatus: "pass", testChanges: { existing_tests_modified: ["a.test.js"] } });
  assert.match(eligibility(refactorBlocked).reason, /^refactor: test files changed/);
  const refactorNote = applyRefactorContract(partial, { refactor: true, verificationStatus: "pass", testChanges: { existing_tests_modified: ["a.test.js"] },
    neutralTestChanges: { files: [{ path: "a.test.js", kind: "imports" }], blocking: [] } });
  assert.equal(eligibility(refactorNote).eligible, true, "a non-blocking refactor note doesn't block the General");
  const timedOut = resolveOutcome({ report: report("partial"), repositoryChanged: true, independentVerification: pass, workerTimedOut: true });
  assert.equal(eligibility(timedOut).eligible, false, "a timeout is not a claim block");
  const done = resolveOutcome({ report: report("done"), repositoryChanged: true, independentVerification: pass });
  assert.equal(eligibility(done).eligible, false, "the coordinator commits a done job itself");
});

test("an unrecoverable report whose change verified is a claim block too", () => {
  const o = resolveOutcome({ report: parseWorkerReport("garbled"), repositoryChanged: true, independentVerification: pass });
  assert.equal(o.outcome, OUTCOMES.NEEDS_REVIEW);
  assert.equal(eligibility(o).eligible, true);
});

// --- real Git ---------------------------------------------------------------
function sh(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim(); }
async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-general-commit-")));
  const repo = path.join(root, "repo"), jobsRoot = path.join(root, "jobs");
  fs.mkdirSync(repo); fs.mkdirSync(jobsRoot);
  registerJobsRoot(jobsRoot);
  sh(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "app.js"), "export const a = 1;\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "base");
  const base = sh(repo, "rev-parse", "HEAD");
  const jobId = "worker-20261114-120000-abcdef", jobDir = path.join(jobsRoot, jobId), worktree = path.join(jobDir, "worktree");
  fs.mkdirSync(jobDir);
  sh(repo, "worktree", "add", "-q", "-b", `agent/${jobId}`, worktree, base);
  const pointer = sealWorktree(worktree, repo);
  fs.writeFileSync(path.join(worktree, "app.js"), "export const a = 2;\n");
  fs.writeFileSync(path.join(worktree, "new.js"), "export const b = 3;\n");
  const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const run = async (cmd, args, { cwd, trim = true } = {}) => {
    const stdout = execFileSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
    return { stdout: trim ? stdout.trim() : stdout };
  };
  const git = async (args, cwd = repo) => (await run("git", args, { cwd })).stdout;
  const gitRaw = async (args, cwd = repo) => (await run("git", args, { cwd, trim: false })).stdout;
  const records = createGitRecord({ run, git, gitRaw });
  const partial = resolveOutcome({ report: report("partial"), repositoryChanged: true, independentVerification: pass });
  const generalCommit = { ...eligibility(partial), fingerprint: await records.worktreeFingerprint(worktree) };
  const meta = { jobId, workerId: jobId, mode: "implement", projectDir: repo, worktree, branch: `agent/${jobId}`, objective: "Raise a to 2 and add b.",
    outcome: partial.outcome, coordinatorStatus: "incomplete", reportValidation: report("partial"), worktreePointerBefore: pointer,
    commit: { created: false, sha: null, reason: "worker reported STATUS: partial" }, generalCommit,
    issues: ["worker reported partial", "repository changes remain uncommitted (2 file(s), +2/-1): worker reported STATUS: partial"] };
  fs.writeFileSync(path.join(jobDir, "metadata.json"), JSON.stringify(meta, null, 2));
  const commit = (reason = "NOT DONE was only the UI suite, which verification ran and passed") =>
    commitVerifiedJob({ jobsRoot, projectDir: repo, jobId, reason, git, createCoordinatorCommit: records.createCoordinatorCommit, worktreeFingerprint: records.worktreeFingerprint });
  return { root, repo, jobDir, worktree, jobId, commit, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("local_worker_commit commits exactly the verified worktree on the job branch and records who and why", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await assert.rejects(f.commit("ok"), /reason of at least/);
  const result = await f.commit();
  assert.equal(result.by, "general");
  assert.deepEqual([...result.files].sort(), ["app.js", "new.js"]);
  assert.equal(sh(f.worktree, "rev-parse", `agent/${f.jobId}`), result.sha);
  assert.equal(sh(f.worktree, "status", "--porcelain"), "");
  const message = sh(f.worktree, "log", "-1", "--format=%B");
  assert.match(message, /^Raise a to 2 and add b/);
  assert.match(message, /General review: NOT DONE was only the UI suite/);
  const trailers = sh(f.worktree, "log", "-1", "--format=%(trailers:only)");
  assert.match(trailers, /nomArmy-Job: worker-20261114-120000-abcdef/);
  assert.match(trailers, /nomArmy-Accepted-By: General/);
  const meta = JSON.parse(fs.readFileSync(path.join(f.jobDir, "metadata.json"), "utf8"));
  assert.equal(meta.commit.created, true);
  assert.equal(meta.commit.by, "general");
  assert.equal(meta.coordinatorStatus, "complete");
  assert.equal(meta.outcome, OUTCOMES.WORKER_PARTIAL, "the worker's claim stays on the record");
  assert.ok(!meta.issues.some((i) => /remain uncommitted/.test(i)));
  await assert.rejects(f.commit(), /already committed/);
});

test("local_worker_commit refuses a worktree that changed after verification", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  fs.appendFileSync(path.join(f.worktree, "app.js"), "// edited after verification\n");
  await assert.rejects(f.commit(), /changed after nomArmy verified it/);
  assert.equal(sh(f.worktree, "rev-list", "--count", "HEAD"), "1", "nothing committed");
});

test("local_worker_commit refuses a rewritten worktree pointer", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const dotGit = path.join(f.worktree, ".git");
  fs.writeFileSync(dotGit, `gitdir: ${path.join(f.root, "elsewhere")}\n`);
  await assert.rejects(f.commit(), /pointer integrity/);
});

test("local_worker_commit refuses a job whose record says it wasn't eligible", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const file = path.join(f.jobDir, "metadata.json");
  const meta = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...meta, generalCommit: { eligible: false, reason: "independent verification was fail" } }));
  await assert.rejects(f.commit(), /verification was fail/);
  assert.match(generalCommitProblem({ ...meta, generalCommit: undefined }), /no commit eligibility/);
  assert.match(generalCommitProblem(null), /no finished job record/);
});
