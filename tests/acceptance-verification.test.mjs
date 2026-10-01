import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { createExecutor } from "../lib/execute.mjs";
import { createVerificationFlow } from "../lib/verification-flow.mjs";
import { createVerificationRunner, buildPodmanArgs } from "../lib/verify.mjs";
import * as classification from "../lib/diff-checks.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const contract = proof => JSON.stringify({ feature: "fixture", criteria: [{ id: "EX-1", text: "proof passes", status: "met", proven_by: [{ file: "tests/proof.test.mjs", test: proof }] }] });

async function job(t, { proof = "good", code = false, timeout = false, profileStatus = "pass", baseContract = null, headContract = contract(proof) } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-contract-verification-"));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const jobsRoot = path.join(repo, "jobs"), calls = [], regressions = [];
  const files = ["acceptance/changed.yaml", "README.md", ".github/workflows/ci.yml", ...(code ? ["lib/code.mjs"] : [])];
  const record = { repoStatusFiles: files, changedFiles: files, nameStatus: files.map(path => ({ status: "A", path })),
    testChanges: { production_files_changed: files, new_tests_added: [], existing_tests_modified: [], existing_tests_deleted: [], reviewRequired: false },
    ignoredRuntimeJunk: [], issues: [], additions: 1, deletions: 0 };
  const runner = createVerificationRunner({
    loadConfig: () => ({ found: false }), image: "fixture", commandTimeoutMs: 4321,
    executor: {
      probe: async () => ({ available: true }),
      run: async input => {
        calls.push(input);
        if (timeout) return { started: true, timedOut: true, exitCode: null, stdout: "", stderr: "deadline exceeded" };
        // The real CLI runs asynchronously against fixture proofs. Only the
        // container mount path is translated for this sandbox-free unit test.
        const env = { ...process.env, NOMARMY_WINDOWS_ENGINE: "native" };
        delete env.NODE_TEST_CONTEXT;
        const args = [path.join(input.acceptanceToolDir, "bin/nomarmy.mjs"), "acceptance", "check", "--json", ...(input.command.includes(" --strict") ? ["--strict"] : []), "acceptance/changed.yaml"];
        try {
          const result = await exec(process.execPath, args, { cwd: input.cwd, env, timeout: input.timeoutMs });
          return { started: true, exitCode: 0, ...result };
        } catch (error) { return { started: true, exitCode: error.code, stdout: error.stdout, stderr: error.stderr }; }
      },
    },
  });
  const flow = createVerificationFlow({});
  flow.registerVerificationRunner(context => context.acceptanceFiles ? runner(context) : { status: profileStatus });
  const executor = createExecutor({ VERSION: "test", projectDir: repo, jobsRoot,
    assertRepo: async () => {}, ensureJobsRoot: () => fs.mkdirSync(jobsRoot, { recursive: true }), resolveBase: async () => ({ ref: "base", sha: "base" }),
    sweepStaleSandboxContainers: async () => {},
    run: async (_cmd, args) => {
      const cwd = args[4];
      fs.mkdirSync(path.join(cwd, "acceptance"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "tests"));
      fs.writeFileSync(path.join(cwd, ".git"), "gitdir: synthetic\n");
      if (headContract !== null) fs.writeFileSync(path.join(cwd, "acceptance/changed.yaml"), headContract);
      fs.writeFileSync(path.join(cwd, "acceptance/unrelated.yml"), "invalid: [");
      fs.writeFileSync(path.join(cwd, "tests/proof.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; test("good", () => assert.equal(2 + 2, 4)); test("bad", () => assert.fail("broken criterion"));');
      return { stdout: "" };
    },
    gitRaw: async args => { if (args[0] === "show") { if (baseContract === null) throw new Error("not in base"); return baseContract; } return ""; }, collectGitRecord: async () => record,
    runOpenClaw: async () => ({ final: "STATUS: done\nTESTS: pass\nNOT_DONE: none\nNOTE: implemented" }),
    normalizeVerification: flow.normalizeVerification, verificationFlow: flow, runIndependentVerification: flow.runIndependentVerification,
    runRegressionCheck: async input => { regressions.push(input.productionFiles); return { status: "pass" }; },
    createCoordinatorCommit: async ({ outcome }) => ({ created: outcome.commitAllowed, sha: "synthetic" }),
    repoPolicy: () => ({}), buildMetrics: () => ({}), recordedBudgets: () => ({}), resolveReasoningApplied: () => "medium",
  });
  const result = await executor.executeJob({ task: "Check contracts", mode: "implement", verification: "quick", verifyRegression: true, jobId: "job-contract" });
  const manifest = JSON.parse(fs.readFileSync(path.join(result.jobDir, "metadata.json"), "utf8"));
  return { manifest, calls, regressions };
}

test("changed contracts skip reverting and run only their acceptance checks", async t => {
  const { manifest, calls, regressions } = await job(t);
  assert.deepEqual(regressions, []);
  assert.equal(manifest.regressionCheck, null);
  assert.equal(manifest.commit.created, true);
  assert.equal(manifest.independentVerification.status, "pass");
  const check = manifest.independentVerification.contractCheck;
  assert.deepEqual(Object.keys(check).sort(), ["status", "profile", "basis", "reason", "detail", "log", "artifacts", "artifactsCapped", "files", "weakened"].sort());
  assert.equal(check.status, "pass");
  assert.deepEqual(check.files, ["acceptance/changed.yaml"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/usr/local/bin/node /nomarmy-acceptance/bin/nomarmy.mjs acceptance check --json --strict 'acceptance/changed.yaml'");
  assert.equal(calls[0].timeoutMs, 4321);
  assert.equal(calls[0].cwd, manifest.worktree);
  assert.equal(calls[0].acceptanceToolDir, root);
  assert.match(fs.readFileSync(check.log, "utf8"), /"met": 1/);
});

for (const proof of ["bad", "missing"]) {
  test(`changed contract ${proof} criterion fails job verification`, async t => {
    const { manifest, calls, regressions } = await job(t, { proof });
    assert.equal(calls.length, 1);
    assert.deepEqual(regressions, []);
    assert.equal(manifest.independentVerification.status, "fail");
    assert.equal(manifest.independentVerification.contractCheck.status, "fail");
    assert.equal(manifest.commit.created, false);
    assert.match(fs.readFileSync(manifest.independentVerification.contractCheck.log, "utf8"), new RegExp(`"status": "${proof === "bad" ? "broken" : "missing"}"`));
  });
}

test("changed contracts plus code revert-check only real code", async t => {
  const { manifest, regressions, calls } = await job(t, { code: true });
  assert.deepEqual(regressions, [["lib/code.mjs"]]);
  assert.equal(calls.length, 1);
  assert.equal(manifest.independentVerification.contractCheck.status, "pass");
  assert.equal(manifest.commit.created, true);
});

test("changed contract timeout fails verification and prevents committing", async t => {
  const { manifest, calls } = await job(t, { timeout: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 4321);
  assert.equal(manifest.independentVerification.status, "fail");
  assert.equal(manifest.independentVerification.contractCheck.status, "fail");
  assert.equal(manifest.commit.created, false);
});

test("passing contracts do not mask unavailable code verification", async t => {
  const { manifest, regressions } = await job(t, { code: true, profileStatus: "not_run" });
  assert.equal(manifest.independentVerification.contractCheck.status, "pass");
  assert.equal(manifest.independentVerification.status, "not_run");
  assert.deepEqual(regressions, []);
  assert.equal(manifest.reviewRequired, true);
});

test("contract classification is limited to top-level acceptance YAML and checker mounts are read-only", () => {
  for (const file of ["acceptance/a.yml", "acceptance/a.yaml", "./acceptance/a.yml", "acceptance\\a.yaml"]) assert.equal(classification.isAcceptanceContractPath(file), true, file);
  for (const file of ["acceptance/a.mjs", "lib/a.yml", "acceptance/nested/a.yml", "notacceptance/a.yaml"]) assert.equal(classification.isAcceptanceContractPath(file), false, file);
  assert.deepEqual(classification.planRegressionProductionFiles(["acceptance/a.yml", "acceptance/b.yaml", "README.md", ".github/workflows/ci.yml", "lib/a.mjs"]), ["lib/a.mjs"]);
  const args = buildPodmanArgs({ cwd: "/work", command: "check", acceptanceToolDir: root });
  assert.deepEqual(args.filter((arg, index) => args[index - 1] === "--mount"), [
    "type=bind,source=/work,target=/workspace",
    ...["bin", "lib", "node_modules"].map(dir => `type=bind,source=${path.join(root, dir)},target=/nomarmy-acceptance/${dir},readonly`),
  ]);
});

const manual = { manual: "inspected behavior", checked_by: "Reviewer", date: "2026-09-30" };
const declared = (criteria) => JSON.stringify({ feature: "fixture", criteria });
const promise = { id: "EX-1", text: "retains the promise", status: "met", proven_by: [manual] };
for (const [kind, criteria, changes] of [
  ["removed", [], ["criterion removed"]],
  ["retired", [{ ...promise, status: "retired" }], ["criterion retired"]],
  ["proof removed", [{ ...promise, proven_by: [] }], ["proofs removed"]],
  ["one proof dropped", [{ ...promise, proven_by: [manual] }], ["proofs removed"]],
  ["met to unproven", [{ ...promise, status: "unproven" }], ["met status changed to unproven"]],
  ["met to none", [{ ...promise, status: "unproven", proven_by: [] }], ["proofs removed", "met status changed to unproven"]],
  ["file removed", null, ["criterion removed"]],
]) {
  test(`changed contract weakening requires review: ${kind}`, async t => {
    const base = kind === "one proof dropped" ? { ...promise, proven_by: [manual, { ...manual, manual: "second check" }] } : promise;
    const { manifest } = await job(t, { baseContract: declared([base]), headContract: criteria === null ? null : declared(criteria) });
    assert.equal(manifest.reviewRequired, true);
    assert.deepEqual(manifest.independentVerification.contractCheck.weakened, [{ id: "EX-1", file: "acceptance/changed.yaml", changes }]);
    assert.deepEqual(manifest.issues.filter(issue => issue.startsWith("CONTRACT WEAKENED:")), [
      `CONTRACT WEAKENED: EX-1 (acceptance/changed.yaml): ${changes.join("; ")}`,
    ]);
  });
}

test("changed contracts additive criteria and manual proofs pass strict verification", async t => {
  const { manifest, calls } = await job(t, {
    baseContract: declared([promise]),
    headContract: declared([{ ...promise, proven_by: [manual, { ...manual, manual: "additional inspection" }] }, { ...promise, id: "EX-2" }]),
  });
  assert.equal(calls[0].command, "/usr/local/bin/node /nomarmy-acceptance/bin/nomarmy.mjs acceptance check --json --strict 'acceptance/changed.yaml'");
  assert.deepEqual(manifest.independentVerification.contractCheck.weakened, []);
  assert.equal(manifest.independentVerification.status, "pass");
  assert.equal(manifest.reviewRequired, false);
  assert.equal(manifest.commit.created, true);
});

test("changed contracts without proofs fail strict verification and report unproven", async t => {
  const { manifest } = await job(t, { headContract: declared([{ ...promise, status: "unproven", proven_by: [] }]) });
  assert.equal(manifest.independentVerification.status, "fail");
  assert.equal(manifest.reviewRequired, true);
  assert.equal(manifest.commit.created, false);
  assert.match(fs.readFileSync(manifest.independentVerification.contractCheck.log, "utf8"), /"unproven": 1/);
});

for (const mode of ["changed", "summary", "snapshot"]) {
  test(`sandbox checker cannot be shadowed by a dependency node bin: ${mode}`, async t => {
    const repo = fs.mkdtempSync(path.join(root, ".checker-path-"));
    t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
    const depsBin = path.join(repo, "deps/node_modules/.bin");
    fs.mkdirSync(depsBin, { recursive: true });
    fs.writeFileSync(path.join(depsBin, "node"), '#!/bin/sh\necho "{\\"contracts\\": []}"\n', { mode: 0o755 });
    fs.mkdirSync(path.join(repo, "acceptance"));
    fs.writeFileSync(path.join(repo, "acceptance/changed.yaml"), declared([promise]));
    fs.writeFileSync(path.join(repo, "acceptance/example.yml"), declared([promise]));
    const snapshots = path.join(repo, "snapshots");
    fs.mkdirSync(snapshots);
    fs.writeFileSync(path.join(snapshots, "0.yml"), declared([promise]));
    const suffix = mode === "changed" ? " --strict 'acceptance/changed.yaml'" : mode === "snapshot" ? " '/nomarmy-contracts/0.yml'" : "";
    const expected = "/usr/local/bin/node /nomarmy-acceptance/bin/nomarmy.mjs acceptance check --json" + suffix;
    let invoked;
    const verify = createVerificationRunner({ image: "fixture", loadConfig: () => ({ found: false }), executor: {
      probe: async () => ({ available: true }),
      run: async input => {
        // Model execvp: a bare node resolves the dependency's hostile package bin.
        const command = input.command.split(" ")[0];
        const searchPath = [depsBin, "/usr/local/bin", "/usr/bin"];
        const resolve = name => name.includes("/") ? name : searchPath.map(dir => path.join(dir, name)).find(file => fs.existsSync(file));
        assert.equal(resolve("node"), path.join(depsBin, "node"), "fixture really shadows bare node");
        invoked = resolve(command);
        assert.equal(invoked, "/usr/local/bin/node");
        assert.equal(input.command, expected);
        const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
        const args = [path.join(input.acceptanceToolDir, "bin/nomarmy.mjs"), "acceptance", "check", "--json",
          ...(mode === "changed" ? ["--strict", "acceptance/changed.yaml"] : mode === "snapshot" ? [path.join(snapshots, "0.yml")] : [])];
        const checked = await exec(process.execPath, args, { env: { ...env, PATH: searchPath.join(path.delimiter), NOMARMY_WINDOWS_ENGINE: "native" }, cwd: repo });
        assert.deepEqual(JSON.parse(checked.stdout).totals, { met: 1, broken: 0, missing: 0, unproven: 0, retired: 0 });
        return { started: true, exitCode: 0, ...checked };
      },
    } });
    const context = mode === "changed" ? { acceptanceFiles: ["acceptance/changed.yaml"] }
      : mode === "snapshot" ? { acceptanceContractsDir: snapshots } : { acceptanceCheck: true };
    const result = await verify({ cwd: repo, ...context });
    assert.equal(result.status, "pass", result.reason);
    assert.equal(invoked, "/usr/local/bin/node");
  });
}
