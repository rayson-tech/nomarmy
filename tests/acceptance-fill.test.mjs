import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { criteriaProblems, proposalsFromDiff, jobAcceptanceProposals, fillAcceptance as runFill, gatherAcceptanceProposals } from "../lib/acceptance-fill.mjs";
import { loadContract } from "../lib/acceptance.mjs";
import { fixtureExecutor, fixtureWorktree, fixtureVerification } from "./helpers/acceptance-sandbox.mjs";
import { acceptanceSummary, shareMarkdown } from "../lib/share.mjs";
import { computeStats } from "../lib/stats.mjs";
import { reportView } from "../lib/job-format.mjs";
import { jobSchema } from "../mcp/server.mjs";
import { createJobRuntime } from "../lib/admission.mjs";
import { deriveBudgets } from "../lib/budget.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fillAcceptance = input => {
  const pending = runFill(input);
  assert.equal(pending instanceof Promise, true, "fill verification must be asynchronous");
  return pending;
};
const fixture = t => {
  const repoDir = fs.mkdtempSync(path.join(root, ".acceptance-fill-"));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoDir, "acceptance"));
  fs.mkdirSync(path.join(repoDir, "tests"));
  fs.writeFileSync(path.join(repoDir, "tests/example.test.mjs"), 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("old", () => {});\ntest("new", () => {});\ntest("bad", () => assert.fail("broken"));\nfor (const n of [1, 2]) test(`loop ${n}`, () => {});\n');
  const file = path.join(repoDir, "acceptance/example.yml");
  const source = '# keep header\nfeature: "Example" # keep quotes\ncriteria:\n  - id: ACC-1\n    text: first\n    proven_by:\n      # keep proof\n      - file: tests/example.test.mjs # keep inline\n        test: "old"\n    status: unproven # keep status\n  - id: ACC-2\n    text: second\n    proven_by: [] # keep empty\n    status: unproven\n';
  fs.writeFileSync(file, source);
  return { repoDir, file, source, verify: fixtureVerification(repoDir) };
};
const proof = (criterion, name = "new") => ({ criterion, file: "tests/example.test.mjs", test: name });
const result = (criterion, names, status) => ({ criterion, file: "acceptance/example.yml", added: names.map(test => ({ file: "tests/example.test.mjs", test })), status });

test("contract criteria schema, admission and report preserve IDs and name unknown IDs plus searched files", async t => {
  const f = fixture(t);
  assert.deepEqual(jobSchema.parse({ task: "t", criteria: ["ACC-1", "X9-8"] }).criteria, ["ACC-1", "X9-8"]);
  assert.equal(jobSchema.safeParse({ task: "t", criteria: ["bad"] }).success, false);
  const budgets = deriveBudgets({ env: {} });
  const runtime = createJobRuntime({ env: { NOMARMY_EXECUTION: "hosted" }, projectDir: f.repoDir, projectDirProblem: () => null,
    stateRoot: f.repoDir, jobsRoot: f.repoDir, leasesRoot: path.join(f.repoDir, "leases"), budgetState: { refresh: async () => {}, budgets, contextInfo: { slots: 3 } },
    currentMaxWorkers: () => 2, budgetsForJob: () => budgets, subscriptionJobFieldProblems: () => [], repoPolicy: () => ({}) });
  assert.deepEqual((await runtime.admit([{ task: "t", criteria: ["ACC-1"] }])).problems, []);
  assert.deepEqual((await runtime.admit([{ task: "t", criteria: ["ACC-8", "ACC-9", "ACC-8"] }])).problems,
    ["Unknown acceptance criteria: ACC-8, ACC-9. Contract files searched: acceptance/example.yml"]);
  assert.deepEqual(criteriaProblems(["ACC-1"], f.repoDir, "scout"), ["criteria is only supported for implement jobs"]);
  fs.unlinkSync(f.file);
  assert.deepEqual(criteriaProblems(["ACC-8"], f.repoDir), ["Unknown acceptance criteria: ACC-8. Contract files searched: acceptance/*.yml (none)"]);
  const meta = { jobId: "j", mode: "implement", outcome: "WORKER_DONE", coordinatorStatus: "complete", criteria: ["ACC-1"], acceptanceProposals: [proof("ACC-1")] };
  assert.deepEqual(reportView(meta), { ...meta, reviewRequired: false, issues: [], report: null, verification: null, revertCheck: null, commit: null, changedFiles: [], additions: null, deletions: null });
});

const diff = [
  'diff --git a/tests/example.test.mjs b/tests/example.test.mjs', '--- a/tests/example.test.mjs', '+++ b/tests/example.test.mjs', '@@ -1,10 +1,12 @@',
  '-test("removed entirely", () => {});',
  ' test("untouched", () => {});',
  ' test("deletion only", () => {', '-  obsolete();', ' });',
  ' test("body only", () => {', '-  assert.equal(answer, 1);', '+  assert.equal(answer, 2);', '+++ counter;', ' });',
  '-test("old name", () => {});', '+it(\'exact "quote"\', () => {});',
  '+for (const n of [1, 2]) test(`loop ${n} tail`, () => {});',
  '+test(', '+  "multiline",', '+  () => {}', '+);',
  '+// test("comment", () => {});', '+const example = \'test("string", () => {})\';', '+test(dynamic, () => {});',
  '+test("prefix" + dynamic, () => {});',
  'diff --git a/lib/code.mjs b/lib/code.mjs', '+++ b/lib/code.mjs', '+test("not a test file", () => {});',
].join("\n");
const names = ['deletion only', 'body only', 'exact "quote"', 'loop ${n} tail', 'multiline'];
const expectedProposals = names.flatMap(name => [proof("ACC-1", name), proof("ACC-2", name)]);

test("diff proposals include changed bodies, exact and template names, excluding untouched or nonliteral tests", () => {
  assert.deepEqual(proposalsFromDiff(diff, ["ACC-1", "ACC-2"]), expectedProposals);
  assert.deepEqual(proposalsFromDiff(diff, []), []);
});

test("job proposals require criteria, a commit and a passing revert check", async () => {
  const input = { criteria: ["ACC-1", "ACC-2"], commit: { created: true }, regressionCheck: { status: "pass" }, diff: async () => diff };
  assert.deepEqual(await jobAcceptanceProposals(input), expectedProposals);
  for (const change of [{ criteria: undefined }, { criteria: [] }, { commit: { created: false } }, { regressionCheck: null }, { regressionCheck: { status: "fail" } }, { regressionCheck: { status: "not_run" } }]) {
    assert.equal(await jobAcceptanceProposals({ ...input, ...change, diff: () => assert.fail("must not read diff") }), undefined);
  }
});

test("fill appends without rewriting comments or existing entries and flips only passing criteria", async t => {
  const f = fixture(t);
  const proposals = [proof("ACC-1"), proof("ACC-1"), proof("ACC-1", "old"), proof("ACC-2", "bad")];
  assert.deepEqual(await fillAcceptance({ ...f, proposals }), { dryRun: false, criteria: [result("ACC-1", ["new"], "met"), result("ACC-2", ["bad"], "unproven")] });
  const expected = f.source.replace('    status: unproven # keep status', '      - { file: "tests/example.test.mjs", test: "new" }\n    status: met # keep status')
    .replace('proven_by: []', 'proven_by: [ { file: "tests/example.test.mjs", test: "bad" }]');
  assert.equal(fs.readFileSync(f.file, "utf8"), expected);
  assert.deepEqual(await fillAcceptance({ ...f, proposals }), { dryRun: false, criteria: [] });
  assert.equal(fs.readFileSync(f.file, "utf8"), expected);
});

test("fill dry-run writes nothing and template prefix evidence passes the real checker", async t => {
  const f = fixture(t);
  const proposals = [proof("ACC-2", "loop ${n}")];
  assert.deepEqual(await fillAcceptance({ ...f, proposals, dryRun: true }), { dryRun: true, criteria: [result("ACC-2", ["loop ${n}"], "met")] });
  assert.equal(fs.readFileSync(f.file, "utf8"), f.source);
  assert.deepEqual(await fillAcceptance({ ...f, proposals }), { dryRun: false, criteria: [result("ACC-2", ["loop ${n}"], "met")] });
  assert.equal(loadContract(f.file).criteria[1].status, "met");
});

test("fill preserves flow entries, trailing commas, CRLF and retired statuses", async t => {
  const f = fixture(t);
  const source = 'feature: Example\r\ncriteria:\r\n  - id: ACC-1\r\n    text: first\r\n    proven_by: [{file: tests/example.test.mjs, test: old}, ] # tail\r\n    status: retired\r\n';
  fs.writeFileSync(f.file, source);
  assert.deepEqual(await fillAcceptance({ ...f, proposals: [proof("ACC-1")] }), { dryRun: false, criteria: [result("ACC-1", ["new"], "retired")] });
  assert.equal(fs.readFileSync(f.file, "utf8"), source.replace(', ]', ',  { file: "tests/example.test.mjs", test: "new" }]'));
});

test("fill rejects unknown and ambiguous IDs before writing", async t => {
  const f = fixture(t);
  await assert.rejects(() => fillAcceptance({ ...f, proposals: [proof("ACC-1"), proof("ACC-9")] }), { message: "Unknown acceptance criterion ACC-9" });
  assert.equal(fs.readFileSync(f.file, "utf8"), f.source);
  fs.writeFileSync(path.join(f.repoDir, "acceptance/other.yml"), f.source);
  await assert.rejects(() => fillAcceptance({ ...f, proposals: [proof("ACC-1")] }), { message: "Ambiguous acceptance criterion ACC-1" });
  assert.equal(fs.readFileSync(f.file, "utf8"), f.source);
});

test("acceptance fill CLI gathers a job or run, supports dry-run and JSON, and refuses another repo", t => {
  const f = fixture(t);
  const state = path.join(f.repoDir, "state"), jobsRoot = path.join(state, "jobs"), runsRoot = path.join(state, "runs");
  fs.mkdirSync(path.join(jobsRoot, "job-one"), { recursive: true });
  fs.mkdirSync(runsRoot);
  const metadata = { projectDir: f.repoDir, acceptanceProposals: [proof("ACC-1")] };
  fs.writeFileSync(path.join(jobsRoot, "job-one/metadata.json"), JSON.stringify(metadata));
  fs.writeFileSync(path.join(runsRoot, "run-example.json"), JSON.stringify({ repo: f.repoDir, jobs: [{ jobId: "job-one" }, { jobId: "job-failed", outcome: "WORKER_FAILED" }] }));
  const input = { repoDir: f.repoDir, jobsRoot, runsRoot };
  assert.deepEqual(gatherAcceptanceProposals({ ...input, id: "run-example" }), [proof("ACC-1")]);
  const env = { ...process.env, NOMARMY_AGENT_STATE: state, NOMARMY_WINDOWS_ENGINE: "native", PATH: f.repoDir, NOMARMY_AGENT_IMAGE: "fixture" };
  delete env.NODE_TEST_CONTEXT;
  const invoke = (...args) => spawnSync(process.execPath, [path.join(root, "bin/nomarmy.mjs"), "acceptance", "fill", ...args], { cwd: f.repoDir, env, encoding: "utf8" });
  const dry = invoke("run-example", "--dry-run", "--json");
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout), { dryRun: true, criteria: [result("ACC-1", ["new"], "unproven")], verificationError: "couldn't verify: sandbox unavailable" });
  assert.equal(fs.readFileSync(f.file, "utf8"), f.source);
  const filled = invoke("job-one");
  assert.equal(filled.status, 0, filled.stdout + filled.stderr);
  assert.equal(filled.stdout, 'ACC-1: added 1 proof(s) in acceptance/example.yml; status unproven\n  tests/example.test.mjs: new\ncouldn\'t verify: sandbox unavailable\n');
  const duplicate = invoke("run-example", "--json");
  assert.equal(duplicate.status, 0);
  assert.deepEqual(JSON.parse(duplicate.stdout), { dryRun: false, criteria: [], verificationError: "couldn't verify: sandbox unavailable" });
  fs.writeFileSync(path.join(jobsRoot, "job-one/metadata.json"), JSON.stringify({ ...metadata, projectDir: path.join(f.repoDir, "other") }));
  assert.throws(() => gatherAcceptanceProposals({ ...input, id: "job-one" }), { message: "Job job-one belongs to another repository" });
});

for (const [state, expected] of [["met", "1 met, 1 unproven (ACC-2)"], ["broken", "1 broken (ACC-1), 1 unproven (ACC-2)"], ["missing", "1 missing (ACC-1), 1 unproven (ACC-2)"], ["unproven", "2 unproven (ACC-1, ACC-2)"], ["retired", "1 unproven (ACC-2), 1 retired (ACC-1)"], ["none", null], ["error", "couldn't run"]]) {
  test(`PR Acceptance row runs real evidence for ${state}`, async t => {
    const f = fixture(t), gitCalls = [];
    const executor = fixtureExecutor(), execute = executor.run;
    let sandboxCalls = 0;
    executor.run = input => { sandboxCalls++; return execute(input); };
    if (state === "none") {
      assert.equal(shareMarkdown(computeStats([]), { acceptance: await acceptanceSummary(f.repoDir, { executor, run: fixtureWorktree(f.repoDir, gitCalls) }) }).includes("| Acceptance | 1 met, 1 unproven (ACC-2) |"), true);
      fs.unlinkSync(f.file);
    }
    if (state === "error") fs.writeFileSync(f.file, "invalid: [");
    if (state === "broken") fs.writeFileSync(f.file, f.source.replace('test: "old"', 'test: "bad"'));
    if (state === "missing") fs.writeFileSync(f.file, f.source.replace('test: "old"', 'test: "absent"'));
    if (state === "unproven") fs.writeFileSync(f.file, f.source.replace(/proven_by:\n[\s\S]*?    status:/, 'proven_by: []\n    status:'));
    if (state === "retired") fs.writeFileSync(f.file, f.source.replace("status: unproven #", "status: retired #"));
    const md = shareMarkdown(computeStats([]), { acceptance: await acceptanceSummary(f.repoDir, { executor, run: fixtureWorktree(f.repoDir, gitCalls) }) });
    assert.equal(sandboxCalls, state === "none" ? 2 : 1);
    assert.equal(gitCalls.length, state === "none" ? 4 : 2);
    const rows = md.split("\n").filter(l => l.startsWith("| Acceptance |"));
    if (state === "error") { assert.equal(rows.length, 1); assert.equal(rows[0].startsWith("| Acceptance | couldn't run: "), true); }
    else assert.deepEqual(rows, expected === null ? [] : [`| Acceptance | ${expected} |`]);
  });
}

test("implement executor persists criterion IDs and proposals from its full-context precommit diff", async t => {
  const { createExecutor } = await import("../lib/execute.mjs");
  const f = fixture(t);
  const jobsRoot = path.join(f.repoDir, "jobs");
  const calls = [];
  const testChanges = { production_files_changed: ["lib/code.mjs"], new_tests_added: [], existing_tests_modified: ["tests/example.test.mjs"], existing_tests_deleted: [], reviewRequired: false };
  const record = { repoStatusFiles: ["lib/code.mjs", "tests/example.test.mjs"], changedFiles: ["lib/code.mjs", "tests/example.test.mjs"], nameStatus: [{ status: "M", path: "lib/code.mjs" }, { status: "M", path: "tests/example.test.mjs" }], testChanges, ignoredRuntimeJunk: [], issues: [], additions: 2, deletions: 1 };
  const executor = createExecutor({ VERSION: "test", projectDir: f.repoDir, jobsRoot,
    assertRepo: async () => {}, ensureJobsRoot: () => fs.mkdirSync(jobsRoot, { recursive: true }), resolveBase: async () => ({ ref: "base", sha: "base" }),
    sweepStaleSandboxContainers: async () => {},
    run: async (cmd, args) => {
      assert.equal(cmd, "git");
      assert.deepEqual(args.slice(0, 3), ["worktree", "add", "-b"]);
      fs.mkdirSync(args[4], { recursive: true });
      fs.writeFileSync(path.join(args[4], ".git"), "gitdir: synthetic\n");
      return { stdout: "" };
    },
    gitRaw: async args => { calls.push(args); return diff; },
    collectGitRecord: async () => record,
    runOpenClaw: async () => ({ final: "STATUS: done\nTESTS: pass\nNOT_DONE: none\nNOTE: implemented" }),
    normalizeVerification: value => value, verificationFlow: { verificationRunner: true },
    runIndependentVerification: async () => ({ status: "pass" }), runRegressionCheck: async () => ({ status: "pass" }),
    createCoordinatorCommit: async ({ outcome }) => ({ created: outcome.commitAllowed, sha: "synthetic" }),
    repoPolicy: () => ({}), buildMetrics: () => ({}), recordedBudgets: () => ({}), resolveReasoningApplied: () => "medium",
  });
  const result = await executor.executeJob({ task: "Implement", mode: "implement", criteria: ["ACC-1", "ACC-2"], verification: "quick", verifyRegression: true, jobId: "job-example" });
  assert.equal(result.ok, true, JSON.stringify(result.manifest));
  const manifest = JSON.parse(fs.readFileSync(path.join(result.jobDir, "metadata.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), [
    "version", "jobId", "workerId", "mode", "projectDir", "worktree", "branch", "startedAt", "finishedAt",
    "objective", "acceptance", "criteria", "contract", "acceptanceProposals", "verificationProfile", "outcome", "recovered", "recoveryAttempted",
    "reportRecoveryAttempted", "reportRecovered", "reviewRequired", "coordinatorStatus", "issues", "runnerNotes", "reportValidation",
    "independentVerification", "regressionCheck", "testSelectionRisk", "unwiredDefinitions", "testChanges", "metrics",
    "worktreePointerBefore", "worktreePointerAfterWorker", "worktreeRetained", "commit", "gitBeforeCoordinatorCommit", "git", "worker",
    "workerError", "workerStopReason", "budgets", "timeBudget", "requestedProfile", "requestedReasoning", "reasoningApplied",
  ].sort());
  assert.deepEqual(manifest.criteria, ["ACC-1", "ACC-2"]);
  assert.deepEqual(manifest.acceptanceProposals, expectedProposals);
  assert.deepEqual(calls.filter(args => args.includes("--unified=1000000")), [["diff", "--unified=1000000", "base", "--"]]);
});


test("fill rechecks duplicate proofs after a failure without adding or rewriting entries", async t => {
  const f = fixture(t);
  const proposals = [proof("ACC-2", "bad")];
  await fillAcceptance({ ...f, proposals });
  const failed = fs.readFileSync(f.file, "utf8");
  assert.deepEqual(await fillAcceptance({ ...f, proposals }), { dryRun: false, criteria: [] });
  assert.equal(fs.readFileSync(f.file, "utf8"), failed);
  const testFile = path.join(f.repoDir, "tests/example.test.mjs");
  fs.writeFileSync(testFile, fs.readFileSync(testFile, "utf8").replace('assert.fail("broken")', 'assert.equal(1, 1)'));
  assert.deepEqual(await fillAcceptance({ ...f, proposals, dryRun: true }), { dryRun: true, criteria: [result("ACC-2", [], "met")] });
  assert.equal(fs.readFileSync(f.file, "utf8"), failed);
  assert.deepEqual(await fillAcceptance({ ...f, proposals }), { dryRun: false, criteria: [result("ACC-2", [], "met")] });
  assert.equal(fs.readFileSync(f.file, "utf8"), failed.replace('    status: unproven\n', '    status: met\n'));
});

test("fill unavailable sandbox appends proposals without executing host tests or changing status", async t => {
  const f = fixture(t), marker = path.join(f.repoDir, "host-executed");
  fs.writeFileSync(path.join(f.repoDir, "tests/example.test.mjs"),
    `import fs from "node:fs"; import test from "node:test"; fs.writeFileSync(${JSON.stringify(marker)}, "unsafe"); test("old", () => {}); test("new", () => {});`);
  const calls = [];
  const verify = fixtureVerification(f.repoDir, { executor: {
    probe: async () => { calls.push("probe"); return { available: false }; },
    run: async () => assert.fail("unavailable sandbox cannot run"),
  } });
  assert.deepEqual(await runFill({ ...f, verify, proposals: [proof("ACC-1")] }), {
    dryRun: false, criteria: [result("ACC-1", ["new"], "unproven")],
    verificationError: "couldn't verify: sandbox unavailable",
  });
  assert.deepEqual(calls, ["probe"]);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.source.replace("    status: unproven # keep status",
    '      - { file: "tests/example.test.mjs", test: "new" }\n    status: unproven # keep status'));
});

test("acceptance check help explicitly says tests run locally", () => {
  const checked = spawnSync(process.execPath, [path.join(root, "bin/nomarmy.mjs"), "acceptance", "check", "--help"],
    { encoding: "utf8", env: { ...process.env, NOMARMY_WINDOWS_ENGINE: "native" } });
  assert.equal(checked.status, 0);
  assert.equal(checked.stdout.includes("runs this repository's tests on this machine"), true);
});

for (const dryRun of [true, false]) {
  test(`fill promotes status only from sandbox evidence: ${dryRun}`, async t => {
    const f = fixture(t), marker = path.join(f.repoDir, "host-executed");
    fs.writeFileSync(path.join(f.repoDir, "tests/example.test.mjs"),
      `import fs from "node:fs"; import test from "node:test"; fs.writeFileSync(${JSON.stringify(marker)}, "unsafe"); test("old", () => { throw Error("host execution"); }); test("new", () => {});`);
    let runs = 0, snapshot;
    const verify = fixtureVerification(f.repoDir, { executor: {
      probe: async () => ({ available: true }),
      run: async input => {
        runs++;
        assert.equal(input.cwd, f.repoDir);
        assert.equal(input.network, "none");
        assert.equal(input.command, "/usr/local/bin/node /nomarmy-acceptance/bin/nomarmy.mjs acceptance check --json '/nomarmy-contracts/0.yml'");
        snapshot = input.acceptanceContractsDir;
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(snapshot, "0.yml"), "utf8")), {
          feature: "Example", criteria: [{
            id: "ACC-1", text: "first", status: "unproven",
            proven_by: [{ file: "tests/example.test.mjs", test: "old" }, { file: "tests/example.test.mjs", test: "new" }],
          }],
        });
        return { started: true, exitCode: 0, stdout: JSON.stringify({
          contracts: [{ file: "/nomarmy-contracts/0.yml", criteria: [{ id: "ACC-1", status: "met" }] }],
        }) };
      },
    } });
    assert.deepEqual(await runFill({ ...f, verify, dryRun, proposals: [proof("ACC-1")] }), {
      dryRun, criteria: [result("ACC-1", ["new"], "met")],
    });
    assert.equal(runs, 1);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(snapshot), false);
    assert.equal(fs.readFileSync(f.file, "utf8"), dryRun ? f.source : f.source.replace("    status: unproven # keep status",
      '      - { file: "tests/example.test.mjs", test: "new" }\n    status: met # keep status'));
  });
}
