import "./helpers/isolate-global-config.mjs";
import { fixtureVerification, fixtureExecutor, assertChecker } from "./helpers/acceptance-sandbox.mjs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createVerificationFlow } from "../lib/verification-flow.mjs";
import { createPodmanExecutor, buildPodmanArgs } from "../lib/verify.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { affectedContracts, checkJobContracts } from "../lib/acceptance-impact.mjs";
import { judgePrompt, runJudge, resetJudgeBreaker } from "../lib/judge.mjs";
import { createExecutor } from "../lib/execute.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(root, ".acceptance-impact-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const projectDir = path.join(dir, "operator"), worktree = path.join(dir, "worker");
  fs.mkdirSync(projectDir); fs.mkdirSync(worktree);
  const write = (file, text, base = worktree) => {
    const full = path.join(base, file);
    fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text);
  };
  const contract = { file: path.join(projectDir, "acceptance/example.yml"), feature: "Example", criteria: [
    { id: "EX-1", text: "The answer is 42", status: "met", proven_by: [{ file: "tests/answer.test.mjs", test: "answer stays 42" }] },
    { id: "EX-2", text: "An unrelated promise", status: "met", proven_by: [{ file: "tests/other.test.mjs", test: "other stays true" }] },
  ] };
  const save = (value = contract, base = projectDir) => {
    const { file, ...data } = value;
    write("acceptance/example.yml", JSON.stringify(data), base);
  };
  save();
  write("tests/answer.test.mjs", 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { answer } from "../lib/bridge.mjs";\ntest("answer stays 42", () => assert.equal(answer, 42));\n');
  write("lib/bridge.mjs", 'export { answer } from "./answer.mjs";\n');
  write("lib/answer.mjs", "export const answer = 42;\n");
  // This would fail if the checker did not restrict criteria.
  write("tests/other.test.mjs", 'import test from "node:test"; test("other stays true", () => { throw Error("must not run"); });\n');
  const verificationCalls = [], runner = fixtureVerification(projectDir);
  const verify = context => { verificationCalls.push(context); return runner(context); };
  return { dir, projectDir, worktree, write, contract, save, verify, verificationCalls };
}
const empty = { record: { affected: [], broken: [] }, criteria: [], issues: [] };

test("contract impact follows static imports transitively with relative resolution and deleted files", t => {
  const f = fixture(t);
  f.write("lib/bridge.mjs", 'import value from "./esm"; export { value };\n');
  f.write("lib/esm.js", 'const a = import("./dynamic");\n');
  f.write("lib/dynamic.cjs", 'const a = require("./folder");\n');
  f.write("lib/folder/index.mjs", 'import "../last";\n');
  f.write("lib/last/index.js", 'const a = require("./leaf");\n');
  f.write("lib/last/leaf/index.cjs", "module.exports = 42;\n");
  const expected = { contracts: [{ ...f.contract, criteria: [f.contract.criteria[0]] }] };
  const select = changedFiles => affectedContracts({ contracts: [f.contract], worktree: f.worktree, changedFiles });
  assert.deepEqual(select(["lib/last/leaf/index.cjs"]), expected);
  fs.unlinkSync(path.join(f.worktree, "lib/last/leaf/index.cjs"));
  assert.deepEqual(select(["lib/last/leaf/index.cjs"]), expected);
  assert.deepEqual(select(["tests/answer.test.mjs"]), expected);
  assert.deepEqual(select(["README.md"]), { contracts: [] });
  f.write("lib/bridge.mjs", '// import x from "./answer.mjs";\nconst s = \'require("./answer.mjs")\';\nimport x from "package";\n');
  assert.deepEqual(select(["lib/answer.mjs"]), { contracts: [] });
});

test("unrelated changes and repositories without contracts run no contract child", async t => {
  const f = fixture(t);
  let calls = 0;
  const selected = await checkJobContracts({ ...f, changedFiles: ["lib/answer.mjs"], run: async ({ contracts }) => {
    calls++;
    assert.deepEqual(contracts, [{ ...f.contract, criteria: [f.contract.criteria[0]] }]);
    return [];
  } });
  assert.deepEqual(selected, { record: { affected: ["EX-1"], broken: [] }, criteria: [{ id: "EX-1", text: "The answer is 42", file: "acceptance/example.yml" }], issues: [] });
  assert.equal(calls, 1);
  calls = 0;
  const run = async () => { calls++; throw Error("must not run"); };
  assert.deepEqual(await checkJobContracts({ ...f, changedFiles: ["README.md"], run }), empty);
  assert.deepEqual(await checkJobContracts({ ...f, changedFiles: [], run }), empty);
  fs.rmSync(path.join(f.projectDir, "acceptance"), { recursive: true });
  assert.deepEqual(await checkJobContracts({ ...f, changedFiles: ["lib/answer.mjs"], run }), empty);
  assert.equal(calls, 0);
});

test("affected checks use operator contracts and report met broken and missing references", async t => {
  const f = fixture(t);
  f.save({ ...f.contract, criteria: [{ ...f.contract.criteria[0], text: "Worker replacement", proven_by: [{ file: "tests/other.test.mjs", test: "other stays true" }] }] }, f.worktree);
  const criteria = [{ id: "EX-1", text: "The answer is 42", file: "acceptance/example.yml" }];
  const options = { ...f, changedFiles: ["lib/answer.mjs", "acceptance/example.yml"] };
  assert.deepEqual(await checkJobContracts(options), { record: { affected: ["EX-1"], broken: [] }, criteria, issues: [] });
  f.write("lib/answer.mjs", "export const answer = 7;\n");
  const broken = await checkJobContracts(options);
  assert.deepEqual(Object.keys(broken).sort(), ["criteria", "issues", "record"]);
  assert.deepEqual(Object.keys(broken.record).sort(), ["affected", "broken"]);
  assert.deepEqual(broken.criteria, criteria);
  assert.deepEqual(broken.record.affected, ["EX-1"]);
  assert.equal(broken.record.broken.length, 1);
  const failure = broken.record.broken[0];
  assert.deepEqual(Object.keys(failure).sort(), ["failures", "file", "id"]);
  assert.equal(failure.id, "EX-1"); assert.equal(failure.file, "acceptance/example.yml");
  assert.equal(failure.failures.length, 1);
  assert.deepEqual(Object.keys(failure.failures[0]).sort(), ["detail", "file", "test"]);
  assert.equal(failure.failures[0].file, "tests/answer.test.mjs");
  assert.equal(failure.failures[0].test, "answer stays 42");
  assert.match(failure.failures[0].detail, /7 !== 42/);
  assert.deepEqual(broken.issues, ["CONTRACT BROKEN: EX-1 (acceptance/example.yml): tests/answer.test.mjs: answer stays 42"]);
  f.write("tests/answer.test.mjs", 'import "../lib/bridge.mjs";\n');
  const missing = await checkJobContracts(options);
  assert.deepEqual(missing, {
    record: { affected: ["EX-1"], broken: [{ id: "EX-1", file: "acceptance/example.yml", failures: [{
      file: "tests/answer.test.mjs", test: "answer stays 42",
      detail: "EX-1: tests/answer.test.mjs: answer stays 42: test name is absent from the source",
    }] }] }, criteria, issues: broken.issues,
  });
  fs.unlinkSync(path.join(f.worktree, "tests/answer.test.mjs"));
  const deleted = await checkJobContracts({ ...f, changedFiles: ["tests/answer.test.mjs"] });
  assert.deepEqual(deleted.record.affected, ["EX-1"]);
  assert.deepEqual(deleted.issues, broken.issues);
  assert.match(deleted.record.broken[0].failures[0].detail, /ENOENT/);
  assert.equal(f.verificationCalls.length, 4);
});

test("contract graph bounds depth eight and two thousand files and records conservative selection", async t => {
  const f = fixture(t);
  f.write("tests/answer.test.mjs", 'import "../chain/0.mjs";\n');
  for (let i = 0; i < 10; i++) f.write(`chain/${i}.mjs`, `import "./${i + 1}.mjs";\n`);
  f.write("chain/10.mjs", "");
  const selected = { ...f.contract, criteria: [f.contract.criteria[0]] };
  assert.deepEqual(affectedContracts({ contracts: [f.contract], worktree: f.worktree, changedFiles: ["chain/7.mjs"] }), { contracts: [selected] });
  const bounded = { depth: 8, files: 2000, hit: ["depth"] };
  assert.deepEqual(affectedContracts({ contracts: [f.contract], worktree: f.worktree, changedFiles: ["chain/10.mjs"] }), { contracts: [selected], bounded });
  const record = await checkJobContracts({ ...f, changedFiles: ["chain/10.mjs"], run: async () => [] });
  assert.deepEqual(record, { record: { affected: ["EX-1"], broken: [], bounded }, criteria: [{ id: "EX-1", text: "The answer is 42", file: "acceptance/example.yml" }], issues: [] });
  const refs = [];
  for (let i = 0; i < 2001; i++) {
    f.write(`wide/${i}.mjs`, "");
    refs.push(`import "../wide/${i}.mjs";`);
  }
  f.write("tests/answer.test.mjs", refs.join("\n"));
  assert.deepEqual(affectedContracts({ contracts: [selected], worktree: f.worktree, changedFiles: ["unrelated.mjs"] }), {
    contracts: [selected], bounded: { depth: 8, files: 2000, hit: ["files"] },
  });
});

test("contract checks stay asynchronous and time out hung proofs into review issues", async t => {
  const f = fixture(t);
  f.write("tests/answer.test.mjs", 'import test from "node:test";\ntest("answer stays 42", async () => { await new Promise(() => { setInterval(() => {}, 1000); }); });\n');
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 10);
  const checked = await checkJobContracts({ ...f, changedFiles: ["tests/answer.test.mjs"], timeoutMs: 400, verify: fixtureVerification(f.projectDir, { commandTimeoutMs: 400, executor: { probe: async () => ({ available: true }), run: async input => { assertChecker(input); assert.equal(input.timeoutMs, 400); await new Promise(resolve => setTimeout(resolve, 20)); return { started: true, timedOut: true }; } } }) });
  clearTimeout(timer);
  assert.equal(ticked, true);
  assert.deepEqual(checked, {
    record: { affected: ["EX-1"], broken: [{ id: "EX-1", file: "acceptance/example.yml", failures: [{ detail: "couldn't run: timed out after 400ms" }] }] },
    criteria: [{ id: "EX-1", text: "The answer is 42", file: "acceptance/example.yml" }],
    issues: ["CONTRACT BROKEN: EX-1 (acceptance/example.yml): couldn't run: timed out after 400ms"],
  });
});

test("judge receives affected promises and only adds behavior change flags", async () => {
  resetJudgeBreaker();
  const contracts = [{ id: "EX-1", file: "acceptance/example.yml", text: "The answer is 42" }];
  const input = { task: "Change answer", diff: "-42\n+7", contracts, settings: { checks: [] } };
  const prompt = judgePrompt({ ...input, checks: [] });
  assert.match(prompt, /AFFECTED CONTRACT PROMISES:\nEX-1 \(acceptance\/example.yml\): The answer is 42/);
  assert.match(prompt, /Does the diff change behavior any of these promises describe\?/);
  assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf('{'))), { contracts: [{ id: "EX-1", file: "acceptance/example.yml", verdict: "changed | unchanged | unclear", why: "one sentence" }] });
  for (const verdict of ["changed", "unchanged", "unclear"]) {
    const answer = { contracts: [{ ...contracts[0], verdict, why: "answer changed" }] };
    const result = await runJudge({ ...input, ask: async ({ prompt: received }) => {
      assert.equal(received, prompt);
      return { answer, error: null };
    } });
    assert.deepEqual(result, { flags: verdict === "changed" ? ["contract behavior may have changed: EX-1 (acceptance/example.yml): answer changed"] : [], answer, error: null, skipped: false });
  }
});

test("implement completion checks contracts after verification before commit and retains broken review", async t => {
  const f = fixture(t);
  const jobsRoot = path.join(f.dir, "jobs"), events = [];
  const record = { repoStatusFiles: ["lib/answer.mjs"], changedFiles: ["lib/answer.mjs"], nameStatus: [{ status: "M", path: "lib/answer.mjs" }],
    testChanges: { production_files_changed: ["lib/answer.mjs"], new_tests_added: [], existing_tests_modified: [], existing_tests_deleted: [], reviewRequired: false },
    ignoredRuntimeJunk: [], issues: [], additions: 1, deletions: 1 };
  const executor = createExecutor({
    VERSION: "test", projectDir: f.projectDir, jobsRoot,
    assertRepo: async () => {}, ensureJobsRoot: () => fs.mkdirSync(jobsRoot, { recursive: true }),
    resolveBase: async () => ({ ref: "base", sha: "base" }), sweepStaleSandboxContainers: async () => {},
    run: async (command, args) => {
      assert.equal(command, "git"); assert.deepEqual(args.slice(0, 3), ["worktree", "add", "-b"]);
      const copy = relative => {
        for (const entry of fs.readdirSync(path.join(f.worktree, relative), { withFileTypes: true })) {
          const file = path.join(relative, entry.name);
          if (entry.isDirectory()) copy(file);
          else f.write(file, fs.readFileSync(path.join(f.worktree, file)), args[4]);
        }
      };
      copy("");
      fs.writeFileSync(path.join(args[4], ".git"), "gitdir: synthetic\n");
      return { stdout: "" };
    },
    gitRaw: async () => "", collectGitRecord: async () => record,
    runOpenClaw: async () => ({ final: "STATUS: done\nTESTS: pass\nNOT_DONE: none\nNOTE: changed answer" }),
    normalizeVerification: value => value, verificationFlow: { verificationRunner: true },
    runIndependentVerification: async context => {
      const { cwd } = context;
      if (context.acceptanceContractsDir) {
        events.push("impact");
        assert.equal(context.jobId, "job-example-contract-impact");
        return f.verify(context);
      }
      events.push("verification");
      fs.writeFileSync(path.join(cwd, "lib/answer.mjs"), "export const answer = 7;\n");
      // If the checker rereads the worker contract, no criterion can be affected.
      f.save({ ...f.contract, criteria: [] }, cwd);
      return { status: "pass" };
    },
    judgeSettings: () => ({ agent: "judge", model: "synthetic", checks: [] }),
    runJudge: async ({ contracts }) => {
      events.push("judge");
      assert.deepEqual(contracts, [{ id: "EX-1", file: "acceptance/example.yml", text: "The answer is 42" }]);
      return { flags: [], answer: { contracts: [{ id: "EX-1", file: "acceptance/example.yml", verdict: "unchanged" }] }, error: null, skipped: false };
    },
    createCoordinatorCommit: async ({ outcome }) => {
      events.push("commit");
      assert.equal(outcome.commitAllowed, true);
      assert.equal(outcome.reviewRequired, true);
      assert.deepEqual(outcome.reasons, ["CONTRACT BROKEN: EX-1 (acceptance/example.yml): tests/answer.test.mjs: answer stays 42"]);
      return { created: true, sha: "synthetic" };
    },
    repoPolicy: () => ({}), buildMetrics: () => ({}), recordedBudgets: () => ({}), resolveReasoningApplied: () => "medium",
  });
  const result = await executor.executeJob({ task: "Change answer", verification: "quick", jobId: "job-example" });
  assert.equal(result.ok, true, JSON.stringify(result.manifest));
  assert.deepEqual(events, ["verification", "impact", "judge", "commit"]);
  assert.equal(result.manifest.reviewRequired, true);
  assert.deepEqual(result.manifest.issues, ["CONTRACT BROKEN: EX-1 (acceptance/example.yml): tests/answer.test.mjs: answer stays 42"]);
  assert.deepEqual(Object.keys(result.manifest.contract).sort(), ["affected", "broken"]);
  assert.deepEqual(result.manifest.contract.affected, ["EX-1"]);
  assert.equal(result.manifest.contract.broken[0].id, "EX-1");
  assert.equal(result.manifest.contract.broken[0].file, "acceptance/example.yml");
  assert.equal(result.manifest.contract.broken[0].failures[0].test, "answer stays 42");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.jobDir, "metadata.json"), "utf8")).contract, result.manifest.contract);
});

for (const available of [true, false]) {
  test(`impact checks use a read-only operator snapshot in the sandbox: ${available}`, async t => {
    const f = fixture(t), calls = [];
    f.save({ ...f.contract, criteria: [] }, f.worktree);
    const host = t.mock.method(childProcess, "spawn", () => { throw new Error("host spawn forbidden"); });
    syncBuiltinESMExports();
    t.after(() => { host.mock.restore(); syncBuiltinESMExports(); });
    let snapshot;
    const verify = fixtureVerification(f.projectDir, { commandTimeoutMs: 4321, executor: {
      probe: async () => ({ available }),
      run: async input => {
        calls.push(input); assertChecker(input);
        assert.equal(input.image, "fixture");
        assert.equal(input.network, "none");
        assert.equal(input.cwd, f.worktree);
        assert.equal(input.timeoutMs, 4321);
        snapshot = input.acceptanceContractsDir;
        assert.equal(path.dirname(snapshot), f.dir);
        // Windows does not expose POSIX permission bits; the mount below enforces read-only access.
        if (process.platform !== "win32") assert.equal(fs.statSync(snapshot).mode & 0o777, 0o755);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(snapshot, "0.yml"), "utf8")), {
          feature: f.contract.feature, criteria: [f.contract.criteria[0]],
        });
        assert.equal(input.command, "/usr/local/bin/node /nomarmy-acceptance/bin/nomarmy.mjs acceptance check --json '/nomarmy-contracts/0.yml'");
        assert.equal(buildPodmanArgs(input).includes(`type=bind,source=${snapshot},target=/nomarmy-contracts,readonly`), true);
        return fixtureExecutor().run(input);
      },
    } });
    const flow = createVerificationFlow({});
    flow.registerVerificationRunner(verify);
    const result = await checkJobContracts({ ...f, verify: flow.runIndependentVerification, jobDir: f.dir, changedFiles: ["lib/answer.mjs"] });
    const failures = [{ detail: "couldn't run: sandbox unavailable" }];
    assert.deepEqual(result, {
      record: { affected: ["EX-1"], broken: available ? [] : [{ id: "EX-1", file: "acceptance/example.yml", failures }] },
      criteria: [{ id: "EX-1", text: "The answer is 42", file: "acceptance/example.yml" }],
      issues: available ? [] : ["CONTRACT BROKEN: EX-1 (acceptance/example.yml): couldn't run: sandbox unavailable"],
    });
    assert.equal(calls.length, available ? 1 : 0);
    assert.equal(host.mock.callCount(), 0);
    if (snapshot) assert.equal(fs.existsSync(snapshot), false);
  });
}

test("Podman acceptance executor forwards the read-only contract snapshot mount", async () => {
  const calls = [];
  const executor = createPodmanExecutor({ collect: async (...args) => {
    calls.push(args);
    return { spawned: true, code: 0, stdout: "{}", stderr: "", timedOut: false };
  } });
  const input = { cwd: "/worker", image: "fixture", command: "check", jobId: "impact",
    acceptanceToolDir: "/installed", acceptanceContractsDir: "/job/contracts", timeoutMs: 4321, maxOutputBytes: 1024 };
  const result = await executor.run(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "podman");
  assert.deepEqual(calls[0][1], buildPodmanArgs(input));
  assert.equal(calls[0][1].includes("type=bind,source=/job/contracts,target=/nomarmy-contracts,readonly"), true);
  assert.deepEqual(calls[0][1].filter(arg => arg.includes("target=/nomarmy-acceptance/")), ["bin", "lib", "node_modules"].map(dir => `type=bind,source=${path.join(input.acceptanceToolDir, dir)},target=/nomarmy-acceptance/${dir},readonly`));
  assert.equal(calls[0][2].timeoutMs, 4321);
  assert.deepEqual(Object.keys(result).sort(), ["durationMs", "exitCode", "started", "stderr", "stdout", "timedOut"]);
  assert.deepEqual({ ...result, durationMs: 0 }, { started: true, timedOut: false, exitCode: 0, stdout: "{}", stderr: "", durationMs: 0 });
});
