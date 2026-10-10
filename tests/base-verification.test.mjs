import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseTestFailures, verificationEvidence, compareBaseVerification, failureList } from "../lib/base-verification.mjs";
import { createVerificationFlow } from "../lib/verification-flow.mjs";
import { createVerificationRunner } from "../lib/verify.mjs";
import { createExecutor } from "../lib/execute.mjs";
import { createGitRecord } from "../lib/git-record.mjs";
import { execHostGitSync, sealWorktree } from "../lib/worktree-pointer.mjs";
import { computeStats, formatStats } from "../lib/stats.mjs";

const py = (names = ["tests/a.py::test_old"], reason = "AssertionError: old bug") =>
  names.map(n => `${n} FAILED [100%]\nFAILED ${n} - ${reason}`).join("\n") + `\n${names.length} failed, 100 passed, 4 skipped\n`;
const tap = error => `TAP version 13
# Subtest: old test
not ok 1 - old test
  ---
  duration_ms: 1.2
  failureType: 'testCodeFailure'
  error: '${error}'
  code: 'ERR_ASSERTION'
  ...
1..1
# tests 1
# pass 0
# fail 1
# cancelled 0
`;
const env = { image: "fixture:image", fingerprint: "fixture-policy" };
const evidence = output => verificationEvidence([{ command: "pytest", started: true, timedOut: false, exitCode: 1, stdout: output, stderr: "", truncated: { stdout: 0, stderr: 0 } }]);
const failed = (output = py()) => ({ status: "fail", profile: "quick", environment: env, failureEvidence: evidence(output) });
const gitText = (cwd, args) => execHostGitSync(cwd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-base-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "repo"), jobsRoot = path.join(root, "jobs");
  fs.mkdirSync(projectDir); fs.mkdirSync(jobsRoot);
  gitText(projectDir, ["init", "-q"]);
  gitText(projectDir, ["config", "user.email", "test@example.com"]);
  gitText(projectDir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(projectDir, "code.py"), "value = 1\n");
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

function workerTree(f) {
  const cwd = path.join(f.jobsRoot, "job", "worktree");
  fs.mkdirSync(path.dirname(cwd));
  gitText(f.projectDir, ["worktree", "add", "--detach", cwd, f.baseSha]);
  sealWorktree(cwd, f.projectDir);
  fs.writeFileSync(path.join(cwd, "code.py"), "value = 2\n");
  return { cwd, baseSha: f.baseSha, profile: "quick", jobId: "job", mode: "implement", captureBaseEvidence: true, record: {} };
}

test("failure parser attributes pytest and both node reporters, and rejects incomplete counts", () => {
  assert.equal(failureList(["one", "two", "three", "four", "five", "six"]), "one, two, three, four, five, ...");
  assert.deepEqual(parseTestFailures(py()), { complete: true, format: "pytest", failures: [{ id: "tests/a.py::test_old", reason: "AssertionError: old bug" }] });
  for (const output of ["not ok 1 - old test\n# fail 1\n", "✖ old test (1.25ms)\nℹ fail 1\n✖ failing tests:\n✖ old test (1.25ms)\n"]) {
    assert.deepEqual(parseTestFailures(output), { complete: true, format: "node", failures: [{ id: "old test", reason: "" }] });
  }
  assert.deepEqual(parseTestFailures(tap("old bug")), { complete: true, format: "node", failures: [{ id: "old test", reason: JSON.stringify([["code", "'ERR_ASSERTION'"], ["error", "'old bug'"], ["failureType", "'testCodeFailure'"]]) }] });
  assert.deepEqual(compareBaseVerification(failed(tap("new bug")), failed(tap("old bug"))), { classification: "failure", preexistingFailures: [], newFailures: ["old test"] });
  for (const output of [tap("old bug").replace("# cancelled 0", "# cancelled 1"), "make failed", "FAILED tests/a.py::test_old", py().replace("1 failed", "2 failed"), py() + "\n1 error", py() + "\n[nomarmy] output truncated", "not ok 1 - suite\nnot ok 2 - child\n# fail 1\n"]) {
    assert.deepEqual(parseTestFailures(output), { complete: false, format: null, failures: [] });
  }
  assert.deepEqual(compareBaseVerification(failed(), failed()), { classification: "preexisting", preexistingFailures: ["tests/a.py::test_old"], newFailures: [] });
  assert.deepEqual(compareBaseVerification(failed(py(undefined, "AssertionError: new bug")), failed()), { classification: "failure", preexistingFailures: [], newFailures: ["tests/a.py::test_old"] });
});

test("real detached base comparison classifies all verdicts and keeps the job bytes unchanged", async t => {
  const cases = [
    ["preexisting", failed(), failed(), "pass", ["tests/a.py::test_old"], []],
    ["subset", failed(), failed(py(["tests/a.py::test_old", "tests/a.py::test_other"])), "pass", ["tests/a.py::test_old"], []],
    ["new test", failed(py(["tests/a.py::test_old", "tests/a.py::test_new"])), failed(), "fail", ["tests/a.py::test_old"], ["tests/a.py::test_new"]],
    ["node preexisting", failed(tap("old bug")), failed(tap("old bug")), "pass", ["old test"], []],
    ["different reason", failed(py(undefined, "AssertionError: new bug")), failed(), "fail", [], ["tests/a.py::test_old"]],
    ["unknown", failed("unknown failure"), failed(), "fail", [], []],
    ["count mismatch", failed(py().replace("1 failed", "2 failed")), failed(), "fail", [], []],
    ["base passed", failed(), { status: "pass" }, "fail", [], []],
    ["base unavailable", failed(), { status: "not_run" }, "fail", [], []],
    ["different command", failed(), { ...failed(), failureEvidence: { ...evidence(py()), command: "different test command" } }, "fail", ["tests/a.py::test_old"], []],
    ["different policy", failed(), { ...failed(), environment: { ...env, fingerprint: "changed" } }, "fail", ["tests/a.py::test_old"], []],
  ];
  for (const [name, job, base, status, preexistingFailures, newFailures] of cases) {
    const f = fixture(t), context = workerTree(f);
    let count = 0, snapshot;
    f.flow.registerVerificationRunner(async input => {
      count++;
      assert.notEqual(input.cwd, context.cwd);
      assert.equal(fs.readFileSync(path.join(input.cwd, "code.py"), "utf8"), "value = 1\n");
      assert.equal(gitText(input.cwd, ["rev-parse", "HEAD"]).trim(), f.baseSha);
      assert.equal(fs.readFileSync(path.join(input.cwd, ".git"), "utf8").startsWith("gitdir:"), true);
      assert.equal(gitText(input.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "HEAD");
      assert.equal(input.profile, "quick"); assert.equal(input.verificationImage, env.image);
      snapshot = input.cwd;
      return base;
    });
    const result = await f.flow.compareWithBase(context, job);
    assert.equal(result.status, status, name);
    assert.deepEqual(result.baseComparison, { baseSha: f.baseSha, cached: false, baseStatus: base.status, classification: status === "pass" ? "preexisting" : "failure", preexistingFailures, newFailures }, name);
    assert.equal(count, 1); assert.equal(fs.existsSync(snapshot), false);
    assert.equal(fs.readFileSync(path.join(context.cwd, "code.py"), "utf8"), "value = 2\n");
    assert.equal(result.issues.length, 1);
    if (status === "pass") assert.equal(result.issues[0], `1 tests already failing on the base: ${preexistingFailures[0]}`);
    if (newFailures.length) assert.equal(result.issues[0], `base comparison kept verification failed (${base.status}): new failures: ${newFailures.join(", ")}`);
  }
});

test("base cache reuses trusted results, isolates environment keys and rejects poisoned paths", async t => {
  const f = fixture(t), context = workerTree(f);
  let calls = 0;
  f.flow.registerVerificationRunner(async input => { calls++; return { ...failed(), environment: { ...env, image: input.verificationImage } }; });
  const first = await f.flow.compareWithBase(context, failed());
  assert.equal(first.status, "pass"); assert.equal(first.baseComparison.cached, false);
  // A fresh flow is a later process/job, not an in-memory memoization hit.
  const next = createVerificationFlow({ projectDir: f.projectDir, ensureJobsRoot: () => f.jobsRoot });
  next.registerVerificationRunner(async () => { throw new Error("cache should avoid rerun"); });
  const cached = await next.compareWithBase(context, failed());
  assert.equal(cached.status, "pass"); assert.equal(cached.baseComparison.cached, true); assert.equal(calls, 1);
  const image = await f.flow.compareWithBase(context, { ...failed(), environment: { ...env, image: "fixture:other" } });
  assert.equal(image.status, "pass"); assert.equal(image.baseComparison.cached, false); assert.equal(calls, 2);
  const profile = await f.flow.compareWithBase({ ...context, profile: "full" }, failed());
  assert.equal(profile.baseComparison.cached, false); assert.equal(calls, 3);
  const original = { status: "pass" };
  assert.equal(await f.flow.compareWithBase(context, original), original); assert.equal(calls, 3);
  // Changing the base itself must create a fresh cache entry.
  fs.writeFileSync(path.join(f.projectDir, "other.txt"), "base changed\n");
  gitText(f.projectDir, ["add", "."]); gitText(f.projectDir, ["commit", "-qm", "next base"]);
  const nextSha = gitText(f.projectDir, ["rev-parse", "HEAD"]).trim();
  const changedBase = await f.flow.compareWithBase({ ...context, baseSha: nextSha }, failed());
  assert.equal(changedBase.baseComparison.cached, false); assert.equal(calls, 4);
  const cacheDir = path.join(f.jobsRoot, ".base-verification");
  const entry = fs.readdirSync(cacheDir).find(file => {
    const value = JSON.parse(fs.readFileSync(path.join(cacheDir, file), "utf8"));
    return value.identity.baseSha === f.baseSha && value.identity.profile === "quick" && value.identity.image === env.image;
  });
  const entryFile = path.join(cacheDir, entry), bytes = fs.readFileSync(entryFile);
  const forgedFile = path.join(context.cwd, "forged-result.json");
  fs.writeFileSync(forgedFile, bytes); fs.unlinkSync(entryFile); fs.symlinkSync(forgedFile, entryFile);
  const symlinkResult = await f.flow.compareWithBase(context, failed());
  assert.equal(symlinkResult.status, "fail"); assert.equal(symlinkResult.baseComparison.baseStatus, "not_run"); assert.equal(calls, 4);
  fs.unlinkSync(entryFile); fs.writeFileSync(entryFile, bytes);
  const corrupt = JSON.parse(bytes); corrupt.result.failureEvidence.failures = [null];
  fs.writeFileSync(entryFile, JSON.stringify(corrupt));
  const malformed = await f.flow.compareWithBase(context, failed());
  assert.equal(malformed.status, "fail"); assert.equal(calls, 4);
  fs.writeFileSync(entryFile, bytes);
  const poisoned = path.join(context.cwd, "forged-cache");
  fs.renameSync(cacheDir, poisoned); fs.symlinkSync(poisoned, cacheDir, "dir");
  const refused = await f.flow.compareWithBase(context, failed());
  assert.equal(refused.status, "fail"); assert.equal(refused.baseComparison.baseStatus, "not_run"); assert.equal(calls, 4);
  fs.unlinkSync(cacheDir); fs.renameSync(poisoned, cacheDir);
  f.flow.registerVerificationRunner(async input => {
    fs.writeFileSync(path.join(input.cwd, ".git"), "gitdir: forged-pointer\n");
    return failed();
  });
  const tampered = await f.flow.compareWithBase({ ...context, profile: "tamper" }, failed());
  assert.equal(tampered.status, "fail"); assert.equal(tampered.baseComparison.baseStatus, "not_run");
  assert.equal(fs.readdirSync(f.jobsRoot).filter(name => name.startsWith(".base-run-")).length, 1, "unsafe worktree retained, never removed through a forged pointer");
});

test("runner preserves parsed evidence and pins image and policy for the base", async t => {
  const f = fixture(t), context = workerTree(f), calls = [];
  const runner = createVerificationRunner({ hostProjectDir: f.projectDir, image: "fixture:default",
    loadConfig: () => ({ found: true, config: { verification: { quick: { commands: ["pytest"] } } } }),
    loadVerificationNetwork: () => null,
    executor: { probe: async () => ({ available: true }), run: async input => { calls.push(input); return { started: true, exitCode: 1, stdout: py() }; } },
  });
  f.flow.registerVerificationRunner(runner);
  const job = await f.flow.runIndependentVerification(context);
  assert.deepEqual(job.failureEvidence, { command: "pytest", exitCode: 1, complete: true, format: "pytest", failures: [{ id: "tests/a.py::test_old", reason: "AssertionError: old bug" }] });
  const result = await f.flow.compareWithBase(context, job);
  assert.equal(result.status, "pass"); assert.equal(calls.length, 2);
  assert.equal(calls[0].image, "fixture:default"); assert.equal(calls[1].image, calls[0].image);
  assert.equal(calls[1].network, "none"); assert.equal(calls[0].network, "none");
  const pinned = await runner({ ...context, verificationImage: "fixture:pinned" });
  assert.equal(pinned.environment.image, "fixture:pinned"); assert.equal(calls[2].image, "fixture:pinned");
  // The runner snapshots the operator network policy, not the base checkout.
  const serviceCalls = [], networkCalls = [];
  let policyLoads = 0;
  const policy = { allow: ["tests.example.com:443"], env: {}, keep_output: true };
  const networkRunner = createVerificationRunner({ hostProjectDir: f.projectDir, image: "fixture:network",
    loadConfig: () => ({ found: true, config: { verification: { quick: { commands: ["pytest"] } } } }),
    loadVerificationNetwork: () => { policyLoads++; return policy; },
    executor: { probe: async () => ({ available: true }),
      startServices: async input => { serviceCalls.push(input); return { network: "isolated-service", cleanup: async () => {}, logs: async () => "tests.example.com:443 connected" }; },
      run: async input => { networkCalls.push(input); return { started: true, exitCode: 1, stdout: py() }; },
    },
  });
  f.flow.registerVerificationRunner(networkRunner);
  const networkJob = await f.flow.runIndependentVerification(context);
  const networkResult = await f.flow.compareWithBase(context, networkJob);
  assert.equal(networkResult.status, "pass"); assert.equal(policyLoads, 1); assert.equal(serviceCalls.length, 2);
  assert.deepEqual(serviceCalls.map(c => c.allow), [policy.allow, policy.allow]);
  assert.deepEqual(networkCalls.map(c => [c.image, c.network]), [["fixture:network", "isolated-service"], ["fixture:network", "isolated-service"]]);
});

test("implement jobs commit pre-existing-only failures, retain the revert gate and report separate stats", async t => {
  const f = fixture(t);
  let reruns = 0;
  f.flow.registerVerificationRunner(createVerificationRunner({ hostProjectDir: f.projectDir, image: "fixture:default",
    loadConfig: () => ({ found: true, config: { verification: { quick: { commands: ["pytest"] } } } }),
    loadVerificationNetwork: () => null,
    executor: { probe: async () => ({ available: true }), run: async input => {
      const reverted = input.jobId.endsWith("-regression-check");
      if (reverted) reruns++;
      return { started: true, exitCode: 1, stdout: py(reverted && !input.jobId.startsWith("revert-bad")
        ? ["tests/a.py::test_old", "tests/a.py::test_new"] : undefined) };
    } },
  }));
  const executor = createExecutor({ ...f, ...f.flow, verificationFlow: f.flow, VERSION: "test",
    ensureJobsRoot: () => f.jobsRoot, assertRepo: async () => {}, resolveBase: async () => ({ ref: "main", sha: f.baseSha }),
    sweepStaleSandboxContainers: async () => {}, repoPolicy: () => ({ require_verification: true }),
    runOpenClaw: async ({ cwd }) => { fs.writeFileSync(path.join(cwd, "code.py"), "value = 2\n"); return { final: "STATUS: done\nTESTS: pass\nNOT_DONE: none\nNOTE: implemented" }; },
    execution: {}, budgetState: { budgets: { report: { implement: 256 } } },
    buildMetrics: () => ({}), recordedBudgets: () => ({}), resolveReasoningApplied: () => "off",
  });
  const good = await executor.executeJob({ jobId: "good", task: "Update value", verification: "quick", verifyRegression: true });
  assert.equal(good.ok, true, good.report);
  const m = good.manifest;
  assert.equal(m.commit.created, true); assert.equal(m.reviewRequired, true);
  assert.equal(m.independentVerification.status, "pass"); assert.equal(m.regressionCheck.status, "pass");
  assert.equal(m.issues.includes("1 tests already failing on the base: tests/a.py::test_old"), true);
  const bad = await executor.executeJob({ jobId: "revert-bad", task: "Update value", verification: "quick", verifyRegression: true });
  assert.equal(bad.manifest.commit.created, false, bad.report); assert.equal(bad.manifest.regressionCheck.status, "fail");
  assert.equal(reruns, 2);
  const stats = computeStats([m]);
  assert.deepEqual(stats.claimVsEvidence, { claimedDone: 1, verificationFailed: 0, failedOnlyOnBase: 1, revertStillPassed: 0, passedBoth: 0, changedNothing: 0, flaggedAfterPassing: 0, provenTestFiles: 0 });
  assert.match(formatStats(stats), /Failed only on tests failing at base\s+1 \(100%\)/);
  assert.match(formatStats(stats), /all 1 "done, tests pass" claims held up/);
  assert.equal(JSON.parse(JSON.stringify(stats)).claimVsEvidence.failedOnlyOnBase, 1);
});


test("preexisting regression gate requires complete runner evidence with a new failing test id", async t => {
  const f = fixture(t), context = workerTree(f);
  const onlyOld = "reverted run failed only on tests already failing on the base -- no test demonstrably catches this regression";
  const incomplete = "cannot rule out that the reverted run failed only on tests already failing on the base: failure evidence could not be parsed completely";
  const caught = "reverting the production change failed a test not already failing on the base -- a test catches this regression";
  const cases = [
    ["old only", py(), {}, "fail", onlyOld],
    ["same id different reason", py(undefined, "AssertionError: changed"), {}, "fail", onlyOld],
    ["old and new", py(["tests/a.py::test_old", "tests/a.py::test_new"]), {}, "pass", caught],
    ["new only", py(["tests/a.py::test_new"]), {}, "pass", caught],
    ["unknown output", "pytest crashed", {}, "fail", incomplete],
    ["incomplete count", py(["tests/a.py::test_new"]).replace("1 failed", "2 failed"), {}, "fail", incomplete],
    ["truncated output", py(["tests/a.py::test_new"]) + "\n[nomarmy] output truncated", {}, "fail", incomplete],
  ];
  for (const [name, stdout, extra, status, reason] of cases) {
    let calls = 0;
    f.flow.registerVerificationRunner(createVerificationRunner({ hostProjectDir: f.projectDir, image: "fixture:default",
      loadConfig: () => ({ found: true, config: { verification: { quick: { commands: ["pytest"] } } } }),
      loadVerificationNetwork: () => null,
      executor: { probe: async () => ({ available: true }), run: async input => {
        calls++;
        assert.equal(input.jobId, "job-regression-check");
        assert.equal(fs.readFileSync(path.join(context.cwd, "code.py"), "utf8"), "value = 1\n");
        return { started: true, exitCode: 1, stdout, ...extra };
      } },
    }));
    const result = await f.flow.runRegressionCheck({ ...context, productionFiles: ["code.py"],
      nameStatus: [{ status: "M", path: "code.py" }],
      verificationResult: { status: "pass", baseComparison: {
        classification: "preexisting", preexistingFailures: ["tests/a.py::test_old"], newFailures: [],
      } },
    });
    assert.deepEqual(Object.keys(result).sort(), ["basis", "detail", "rawRerunStatus", "reason", "status"], name);
    assert.equal(result.status, status, name);
    assert.equal(result.rawRerunStatus, "fail", name);
    assert.equal(result.reason, reason, name);
    assert.equal(calls, 1, name);
    assert.equal(fs.readFileSync(path.join(context.cwd, "code.py"), "utf8"), "value = 2\n", name);
  }
});
