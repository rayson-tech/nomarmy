// The spec-gap gates on a real git repository through the real executor,
// with a scripted worker: frozen tests, removed assertions, tests-first
// jobs, the surface map and the judge's vendor.
import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createVerificationFlow } from "../lib/verification-flow.mjs";
import { createExecutor } from "../lib/execute.mjs";
import { createGitRecord } from "../lib/git-record.mjs";
import { execHostGitSync } from "../lib/worktree-pointer.mjs";
import { createJobRuntime } from "../lib/admission.mjs";
import { deriveBudgets } from "../lib/budget.mjs";

const gitText = (cwd, args) => execHostGitSync(cwd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const DONE_PASS = "STATUS: done\nTESTS: pass\nNOT_DONE: none\nNOTE: implemented";

function fixture(t, files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-spec-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "repo"), jobsRoot = path.join(root, "jobs");
  fs.mkdirSync(projectDir); fs.mkdirSync(jobsRoot);
  gitText(projectDir, ["init", "-q"]);
  gitText(projectDir, ["config", "user.email", "test@example.com"]);
  gitText(projectDir, ["config", "user.name", "Test"]);
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(projectDir, file)), { recursive: true }); fs.writeFileSync(path.join(projectDir, file), text); }
  gitText(projectDir, ["add", "."]); gitText(projectDir, ["commit", "-qm", "base"]);
  const baseSha = gitText(projectDir, ["rev-parse", "HEAD"]).trim();
  const run = async (cmd, args, options = {}) => {
    assert.equal(cmd, "git");
    const out = execHostGitSync(options.cwd ?? projectDir, args, { ...options, encoding: options.encoding === null ? null : "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { stdout: options.trim === false || Buffer.isBuffer(out) ? out : out.trim(), stderr: "", exitCode: 0 };
  };
  const git = async (args, cwd = projectDir) => gitText(cwd, args).trim();
  const gitRaw = async (args, cwd = projectDir) => gitText(cwd, args);
  const records = createGitRecord({ run, git, gitRaw });
  const flow = createVerificationFlow({ run, git, projectDir, VERSION: "test", ...records, ensureJobsRoot: () => jobsRoot });
  return { root, projectDir, jobsRoot, baseSha, run, git, gitRaw, ...records, flow };
}

function executorFor(f, { worker, verification = "pass", extra = {} }) {
  f.flow.registerVerificationRunner(async (context) => ({ status: typeof verification === "function" ? verification(context) : verification, basis: "fixture" }));
  return createExecutor({ ...f, ...f.flow, verificationFlow: f.flow, VERSION: "test",
    ensureJobsRoot: () => f.jobsRoot, assertRepo: async () => {}, resolveBase: async (ref) => ({ ref: ref ?? "main", sha: ref ? gitText(f.projectDir, ["rev-parse", ref]).trim() : f.baseSha }),
    sweepStaleSandboxContainers: async () => {}, repoPolicy: () => ({}),
    runOpenClaw: async ({ cwd, task }) => ({ final: worker(cwd, task) ?? DONE_PASS, provider: "openai", model: "gpt-6-sol" }),
    execution: {}, budgetState: { budgets: { report: { implement: 256 } } },
    buildMetrics: () => ({}), recordedBudgets: () => ({}), resolveReasoningApplied: () => "off",
    ...extra,
  });
}

const write = (cwd, file, text) => { fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); fs.writeFileSync(path.join(cwd, file), text); };
const BASE = {
  "src/total.js": "export function total(votes) {\n  return votes.length;\n}\n",
  "src/page.js": "import { total } from './total.js';\nexport const page = () => total([]);\n",
  "tests/total.test.js": "import { total } from '../src/total.js';\ntest('counts', () => {\n  expect(total([1, 2])).toBe(2);\n  expect(total([])).toBe(0);\n});\n",
};

test("a worker that edits a frozen test can't commit, even with verification passing", async (t) => {
  const f = fixture(t, BASE);
  const executor = executorFor(f, { worker: (cwd) => {
    write(cwd, "src/total.js", "export function total(votes) {\n  return votes.length + 0;\n}\n");
    write(cwd, "tests/total.test.js", BASE["tests/total.test.js"].replace("toBe(2)", "toBe(2) // ok"));
  } });
  const r = await executor.executeJob({ jobId: "frozen-edit", task: "Keep totals", verification: "quick", frozenTests: ["tests/total.test.js"] });
  assert.equal(r.manifest.commit.created, false, r.report);
  assert.match(r.manifest.commit.reason ?? r.manifest.issues.join("\n"), /frozen/);
  assert.ok(r.manifest.issues.some((i) => i.startsWith("FROZEN TEST CHANGED:")));
  assert.deepEqual(r.manifest.frozenTests, ["tests/total.test.js"]);
});

test("frozen tests that don't exist at the base refuse the job before any worker runs", async (t) => {
  const f = fixture(t, BASE);
  let ran = false;
  const executor = executorFor(f, { worker: () => { ran = true; } });
  await assert.rejects(executor.executeJob({ jobId: "frozen-missing", task: "x", verification: "quick", frozenTests: ["tests/none.test.js"] }), /not in the base commit/);
  assert.equal(ran, false);
});

test("a deleted protective assertion refuses the commit unless the brief allows it", async (t) => {
  const f = fixture(t, BASE);
  const worker = (cwd) => {
    write(cwd, "src/total.js", "export function total(votes) {\n  return votes.filter(Boolean).length;\n}\n");
    write(cwd, "tests/total.test.js", BASE["tests/total.test.js"].replace("  expect(total([])).toBe(0);\n", ""));
    write(cwd, ".openclaw/accounting.md", "src/page.js: not affected because it only counts an empty list\n");
  };
  const blocked = await executorFor(f, { worker }).executeJob({ jobId: "assert-gone", task: "Ignore empty votes", verification: "quick" });
  assert.equal(blocked.manifest.commit.created, false, blocked.report);
  const section = blocked.manifest.issues.find((i) => i.startsWith("ASSERTIONS REMOVED:"));
  assert.match(section, /tests\/total\.test\.js: removed `expect\(total\(\[\]\)\)\.toBe\(0\);` with no replacement/);
  assert.equal(blocked.manifest.specChecks.assertions.blocked, true);
  assert.equal(blocked.manifest.specChecks.surface.unaccounted.length, 0, "accounted for in .openclaw/accounting.md");

  const allowed = await executorFor(f, { worker }).executeJob({ jobId: "assert-allowed", task: "Ignore empty votes", verification: "quick", allowTestRemoval: true });
  assert.equal(allowed.manifest.commit.created, true, allowed.report);
  assert.ok(allowed.manifest.issues.some((i) => i.startsWith("ASSERTIONS REMOVED (ALLOWED):")));
});

test("a changed export used elsewhere is flagged when the worker doesn't account for it", async (t) => {
  const f = fixture(t, BASE);
  const executor = executorFor(f, { worker: (cwd) => {
    write(cwd, "src/total.js", "export function total(votes, { unique = false } = {}) {\n  return unique ? new Set(votes).size : votes.length;\n}\n");
    write(cwd, "tests/total.test.js", BASE["tests/total.test.js"].replace("});\n", "  expect(total([1, 1], { unique: true })).toBe(1);\n});\n"));
  } });
  const r = await executor.executeJob({ jobId: "surface", task: "Count unique votes when asked", verification: "quick" });
  assert.equal(r.manifest.commit.created, true, "a review flag, not a block");
  assert.equal(r.manifest.reviewRequired, true);
  assert.match(r.manifest.issues.find((i) => i.startsWith("SURFACE NOT ACCOUNTED FOR:")), /total \(changed in src\/total\.js\) is also used in src\/page\.js/);
});

test("a tests-first job commits failing tests, and the build job is frozen to them from that commit", async (t) => {
  const f = fixture(t, BASE);
  const tf = executorFor(f, { verification: "fail", worker: (cwd, task) => {
    assert.match(task, /^TESTS-FIRST JOB: write failing tests only\./);
    write(cwd, "tests/unique.test.js", "import { total } from '../src/total.js';\ntest('unique', () => {\n  expect(total([1, 1], { unique: true })).toBe(1);\n});\n");
    return "STATUS: done\nTESTS: fail\nNOT_DONE: none\nNOTE: unique test fails as intended";
  } });
  const first = await tf.executeJob({ jobId: "tf", task: "Count unique votes when asked", verification: "quick", testsFirst: true });
  assert.equal(first.manifest.commit.created, true, first.report);
  assert.equal(first.manifest.testsFirst, true);
  assert.equal(first.manifest.objective, "Count unique votes when asked");

  const build = executorFor(f, { worker: (cwd) => {
    assert.ok(fs.existsSync(path.join(cwd, "tests/unique.test.js")), "starts from the tests-first commit");
    write(cwd, "src/total.js", "export function total(votes, { unique = false } = {}) {\n  return unique ? new Set(votes).size : votes.length;\n}\n");
    write(cwd, ".openclaw/accounting.md", "src/page.js: not affected because it doesn't pass options\n");
  } });
  const second = await build.executeJob({ jobId: "build", task: "Count unique votes when asked", verification: "quick", frozenFrom: "tf" });
  assert.equal(second.manifest.commit.created, true, second.report);
  assert.deepEqual(second.manifest.frozenTests, ["tests/unique.test.js"]);
  assert.equal(second.manifest.frozenFrom.jobId, "tf");
  assert.ok(second.manifest.issues.some((i) => i.startsWith("TESTS AND CODE FROM ONE VENDOR:")), "both ran on openai in this fixture");

  const passing = executorFor(f, { verification: "pass", worker: (cwd) => { write(cwd, "tests/more.test.js", "test('x', () => { expect(1).toBe(1) })\n"); return "STATUS: done\nTESTS: fail\nNOT_DONE: none\nNOTE: x"; } });
  const weak = await passing.executeJob({ jobId: "tf-weak", task: "x", verification: "quick", testsFirst: true });
  assert.equal(weak.manifest.commit.created, false);
  assert.match(weak.manifest.issues.join("\n"), /already pass on the base/);
});

test("the judge runs on a vendor other than the worker's and the General's", async (t) => {
  const f = fixture(t, BASE);
  let judgedBy = null;
  const executor = executorFor(f, {
    worker: (cwd) => { write(cwd, "src/page.js", "export const page = () => 0;\n"); },
    extra: {
      generalIdentity: () => ({ agent: "claude", vendor: "anthropic" }),
      judgeSettings: () => ({ agent: "claude", model: "claude-opus-5-5", provider: "anthropic", checks: ["acceptance"], candidates: [
        { agent: "claude", model: "claude-opus-5-5", provider: "anthropic" }, { agent: "codex", model: "gpt-6-sol", provider: "openai" }, { agent: "grok", model: "grok-4.7", provider: "xai" }] }),
      runJudge: async ({ settings }) => { judgedBy = settings.agent; return { answer: {}, flags: [], error: null, skipped: false }; },
    },
  });
  const r = await executor.executeJob({ jobId: "judged", task: "Simplify page", acceptance: ["page returns 0"], verification: "quick" });
  assert.equal(judgedBy, "grok");
  assert.equal(r.manifest.validators.judge.agent, "grok");
  assert.equal(r.manifest.issues.some((i) => i.startsWith("JUDGE NOT INDEPENDENT")), false);
});

test("a done/pass report that fails verification is marked for one correction round", async (t) => {
  const f = fixture(t, BASE);
  const executor = executorFor(f, { verification: "fail", worker: (cwd) => { write(cwd, "src/page.js", "export const page = () => 1;\n"); } });
  const r = await executor.executeJob({ jobId: "mismatch", task: "Change page", verification: "quick" });
  assert.deepEqual(r.manifest.autoCorrection, { state: "pending" });
  const off = await executor.executeJob({ jobId: "mismatch-off", task: "Change page", verification: "quick", autoCorrect: false });
  assert.equal(off.manifest.autoCorrection, undefined);
});

// ---- the correction round through the job runtime -------------------------

function runtimeFor(t, executeJob) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".spec-gaps-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, ".nomarmy.yml"), "verification:\n  quick:\n    commands: ['true']\n");
  const jobsRoot = path.join(root, "jobs");
  fs.mkdirSync(jobsRoot);
  const budgets = deriveBudgets({ env: {} });
  let n = 0;
  const runtime = createJobRuntime({ env: {}, projectDir: root, projectDirProblem: () => null, stateRoot: root, jobsRoot,
    leasesRoot: path.join(root, "leases"), slotsRoot: path.join(root, "slots"), budgetState: { hardwareSnapshot: null, contextInfo: { slots: 3 }, budgets, refresh: async () => {} },
    currentMaxWorkers: () => 3, budgetsForJob: () => budgets, subscriptionJobFieldProblems: () => [], repoPolicy: () => ({}),
    slug: (prefix) => `${prefix}-${++n}`, agentsConfig: () => ({ agents: {} }), executeJob,
    jobArgs: (args) => ({ task: args.task, mode: args.mode, verification: args.verification, continueFrom: args.continue_from ?? null, autoCorrect: args.auto_correct !== false, autoCorrectionOf: args.autoCorrectionOf ?? null, frozenTests: args.frozen_tests ?? null }) });
  return { runtime, root, jobsRoot };
}

test("a job that failed verification after done/pass returns its correction round's result", async (t) => {
  const calls = [];
  let ctx;
  const executeJob = async (args) => {
    calls.push(args);
    const jobDir = path.join(ctx.jobsRoot, args.jobId);
    fs.mkdirSync(path.join(jobDir, "worktree"), { recursive: true });
    const manifest = calls.length === 1
      ? { mode: "implement", projectDir: ctx.root, objective: args.task, worktree: path.join(jobDir, "worktree"), git: { baseSha: "abc" }, outcome: "NEEDS_REVIEW", verificationProfile: "quick",
          reportMismatch: { report: "STATUS done, TESTS pass", verification: "fail", failingTests: ["t1"] }, commit: { created: false }, autoCorrection: { state: "pending" }, frozenTests: ["tests/a.test.js"] }
      : { mode: "implement", outcome: "WORKER_DONE", commit: { created: true, sha: "def" }, autoCorrectionOf: args.autoCorrectionOf, issues: [] };
    fs.writeFileSync(path.join(jobDir, "metadata.json"), JSON.stringify(manifest));
    return { ok: calls.length > 1, report: calls.length > 1 ? "fixed" : "failed", manifest, jobDir };
  };
  ctx = runtimeFor(t, executeJob);
  const entry = ctx.runtime.launch({ task: "Show totals", mode: "implement", verification: "quick" });
  const result = await entry.promise;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].continueFrom, entry.jobId);
  assert.equal(calls[1].autoCorrectionOf, entry.jobId);
  assert.equal(calls[1].autoCorrect, false);
  assert.deepEqual(calls[1].frozenTests, ["tests/a.test.js"]);
  assert.match(calls[1].task, /ORIGINAL OBJECTIVE\nShow totals/);
  assert.match(result.report, /^AUTO-CORRECTED: job worker-1 /);
  assert.equal(result.manifest.commit.sha, "def");
  const first = JSON.parse(fs.readFileSync(path.join(ctx.jobsRoot, entry.jobId, "metadata.json"), "utf8"));
  assert.equal(first.autoCorrection.state, "finished");
  assert.equal(first.autoCorrection.jobId, calls[1].jobId);
});

test("a correction round admission refuses is recorded as skipped, and the failed job comes back", async (t) => {
  let ctx, calls = 0;
  const executeJob = async (args) => {
    calls++;
    const jobDir = path.join(ctx.jobsRoot, args.jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    // No worktree: continue_from can't pick the work up.
    const manifest = { mode: "implement", projectDir: ctx.root, objective: args.task, worktree: path.join(jobDir, "worktree"), git: { baseSha: "abc" }, reportMismatch: { report: "STATUS done, TESTS pass", verification: "fail" }, commit: { created: false }, autoCorrection: { state: "pending" } };
    fs.writeFileSync(path.join(jobDir, "metadata.json"), JSON.stringify(manifest));
    return { ok: false, report: "failed", manifest, jobDir };
  };
  ctx = runtimeFor(t, executeJob);
  const entry = ctx.runtime.launch({ task: "Show totals", mode: "implement", verification: "quick" });
  const result = await entry.promise;
  assert.equal(calls, 1);
  assert.match(result.report, /^AUTO-CORRECTION NOT STARTED: continue_from "worker-1": its worktree is gone/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.jobsRoot, entry.jobId, "metadata.json"), "utf8")).autoCorrection.state, "skipped");
});

test("admission checks the new fields", async (t) => {
  const { runtime } = runtimeFor(t, async () => ({}));
  const problems = async (job) => (await runtime.admit([{ task: "x", mode: "implement", ...job }])).problems.join("\n");
  assert.match(await problems({ tests_first: true }), /tests-first job needs a `verification` profile/);
  assert.match(await problems({ frozen_tests: ["tests/a.test.js"] }), /frozen tests need a `verification` profile/);
  assert.match(await problems({ verification: "quick", frozen_tests: ["../x.test.js"] }), /must be a path inside the repository/);
  assert.match(await problems({ verification: "quick", frozen_tests_from: "nope" }), /frozen_tests_from "nope": no record/);
  assert.match(await problems({ verification: "quick", frozen_tests_from: "nope", base_ref: "main" }), /leave base_ref out/);
  assert.match(await problems({ verification: "quick", visual: { routes: ["votes"] } }), /must be a path starting with \//);
  assert.match(await problems({ mode: "scout", visual: { routes: ["/"] } }), /visual is for implement jobs/);
});
