// Tests for the independent verification runner.
// Run: node --test tests/verify.test.mjs
//
// Node built-ins only, and NO Podman: every test injects a fake executor, so
// the state machine is provable on a machine that has never built the sandbox.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  DEFAULT_AGENT_IMAGE,
  DEFAULT_CONTAINER_USER,
  DEFAULT_WORKDIR,
  TRUNCATION_MARKER,
  buildPodmanArgs,
  capOutput,
  classifyResults,
  createVerificationRunner,
  resolveNodeModulesMount,
  resolveProfile,
} from "../lib/verify.mjs";

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

const tempDirs = [];

function tempRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-verify-"));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents, "utf8");
  }
  return dir;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake sandbox executor that records every call it receives. */
function fakeExecutor({ available = true, probeReason = null, responses = {}, fallback = null } = {}) {
  const calls = { probe: [], run: [] };
  return {
    calls,
    async probe(input) {
      calls.probe.push(input);
      return { available, reason: probeReason };
    },
    async run(input) {
      calls.run.push(input);
      const reply = Object.prototype.hasOwnProperty.call(responses, input.command)
        ? responses[input.command]
        : fallback;
      const resolved = typeof reply === "function" ? await reply(input) : reply;
      return resolved ?? { started: true, timedOut: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    },
  };
}

/** A `loadConfig` stand-in returning a fixed, already-validated config. */
function fixedConfig(config) {
  return () => ({
    found: config !== null,
    path: config !== null ? "/fake/.nomarmy.yml" : null,
    config,
    elevated: { shared: [], remote: [] },
  });
}

const CONTEXT = {
  profile: "standard",
  cwd: "/jobs/j1/worktree",
  jobId: "j1",
  baseSha: "abc123",
  branch: "agent/j1",
  mode: "implement",
  record: {},
};

const STANDARD = {
  verification: {
    standard: { environment: "none", commands: ["npm run lint", "npm test"] },
  },
};

// --------------------------------------------------------------------------
// resolveProfile — pure
// --------------------------------------------------------------------------

test("resolveProfile finds a declared profile", () => {
  const resolved = resolveProfile({ config: STANDARD, profile: "standard" });
  assert.equal(resolved.found, true);
  assert.equal(resolved.name, "standard");
  assert.equal(resolved.environment, "none");
  assert.deepEqual(resolved.commands, ["npm run lint", "npm test"]);
  assert.equal(resolved.reason, null);
});

test("resolveProfile reports missing config, missing block and unknown name distinctly", () => {
  const noConfig = resolveProfile({ config: null, profile: "standard" });
  const noBlock = resolveProfile({ config: { environment_retention: {} }, profile: "standard" });
  const unknown = resolveProfile({ config: STANDARD, profile: "browser" });

  for (const r of [noConfig, noBlock, unknown]) assert.equal(r.found, false);

  assert.match(noConfig.reason, /no \.nomarmy\.yml/);
  assert.match(noBlock.reason, /no 'verification' block/);
  assert.match(unknown.reason, /defines no verification profile 'browser'/);
  assert.match(unknown.reason, /known profiles: standard/);

  // Three genuinely different explanations, not one message reused.
  assert.equal(new Set([noConfig.reason, noBlock.reason, unknown.reason]).size, 3);
});

test("resolveProfile requires a requested profile name", () => {
  const resolved = resolveProfile({ config: STANDARD, profile: null });
  assert.equal(resolved.found, false);
  assert.match(resolved.reason, /no verification profile was requested/);
});

test("resolveProfile does no I/O and defaults environment to none", () => {
  const resolved = resolveProfile({ config: { verification: { quick: { commands: ["make check"] } } }, profile: "quick" });
  assert.equal(resolved.environment, "none");
  assert.deepEqual(resolved.commands, ["make check"]);
});

// --------------------------------------------------------------------------
// classifyResults — pure
// --------------------------------------------------------------------------

test("classifyResults passes only when every command exited zero", () => {
  const verdict = classifyResults([
    { command: "a", started: true, exitCode: 0 },
    { command: "b", started: true, exitCode: 0 },
  ]);
  assert.equal(verdict.status, "pass");
  assert.match(verdict.detail, /2 of 2 commands passed/);
});

test("classifyResults names the failing command and its exit code", () => {
  const verdict = classifyResults([
    { command: "npm run lint", started: true, exitCode: 0 },
    { command: "npm test", started: true, exitCode: 3, stderr: "2 failing" },
  ]);
  assert.equal(verdict.status, "fail");
  assert.match(verdict.detail, /npm test/);
  assert.match(verdict.detail, /exit code 3/);
});

test("classifyResults treats an empty list as not_run, never pass", () => {
  assert.deepEqual(classifyResults([]).status, "not_run");
  assert.equal(classifyResults(undefined).status, "not_run");
  assert.match(classifyResults([]).detail, /no commands were executed/);
});

test("classifyResults is not_run when nothing started, fail when something did", () => {
  const nothing = classifyResults([{ command: "a", started: false, reason: "no container" }]);
  assert.equal(nothing.status, "not_run");

  const partial = classifyResults([
    { command: "a", started: true, exitCode: 0 },
    { command: "b", started: false, reason: "container failed to start" },
  ]);
  assert.equal(partial.status, "fail");
  assert.match(partial.detail, /never started/);
});

// --------------------------------------------------------------------------
// capOutput — pure
// --------------------------------------------------------------------------

test("capOutput truncates and records the number of bytes dropped", () => {
  const capped = capOutput("x".repeat(1000), 100);
  assert.equal(capped.truncated, true);
  assert.equal(capped.dropped, 900);
  assert.match(capped.text, new RegExp(TRUNCATION_MARKER.replace(/[[\]]/g, "\\$&")));
  assert.match(capped.text, /900 of 1000 bytes dropped/);

  const small = capOutput("hello", 100);
  assert.equal(small.truncated, false);
  assert.equal(small.dropped, 0);
  assert.equal(small.text, "hello");
});

// --------------------------------------------------------------------------
// buildPodmanArgs — the sandbox invocation
// --------------------------------------------------------------------------

test("buildPodmanArgs isolates the container and passes the command as one argv element", () => {
  const args = buildPodmanArgs({
    cwd: "/jobs/j1/worktree",
    command: "npm test; echo $(whoami)",
    jobId: "j1",
  });

  assert.equal(args[0], "run");
  assert.ok(args.includes("--rm"));
  assert.ok(args.includes("--network=none"), "network must be disabled by default");
  assert.ok(args.includes(`--user=${DEFAULT_CONTAINER_USER}`), "must run as the non-root sandbox user");
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--security-opt=no-new-privileges"));
  assert.ok(args.includes(`--workdir=${DEFAULT_WORKDIR}`));
  assert.ok(args.includes(`type=bind,source=/jobs/j1/worktree,target=${DEFAULT_WORKDIR}`));
  assert.ok(args.includes(DEFAULT_AGENT_IMAGE));

  // The repo-controlled string is the last argv element, handed to the shell
  // INSIDE the container. It is never spliced into a host command line.
  assert.equal(args.at(-1), "npm test; echo $(whoami)");
  assert.equal(args.at(-2), "-c");
  assert.equal(args.at(-3), DEFAULT_AGENT_IMAGE);
  assert.equal(args.filter((a) => a === "npm test; echo $(whoami)").length, 1);
});

test("buildPodmanArgs adds a read-only node_modules mount only when a source is given", () => {
  const without = buildPodmanArgs({ cwd: "/jobs/j1/worktree", command: "npm test" });
  assert.ok(!without.some((a) => typeof a === "string" && a.includes("node_modules")));

  const withMount = buildPodmanArgs({ cwd: "/jobs/j1/worktree", command: "npm test", nodeModulesSource: "/host/node_modules" });
  assert.ok(withMount.includes(`type=bind,source=/host/node_modules,target=${DEFAULT_WORKDIR}/node_modules,readonly`));
});

// --------------------------------------------------------------------------
// resolveNodeModulesMount — pure-ish (real fs, temp dirs)
// --------------------------------------------------------------------------

test("resolveNodeModulesMount: no host node_modules at all is a no-op, not a block", () => {
  const host = tempRepo({});
  const worktree = tempRepo({});
  const result = resolveNodeModulesMount({ hostProjectDir: host, worktreeCwd: worktree });
  assert.equal(result.source, null);
  assert.equal(result.blockedReason, null);
});

test("resolveNodeModulesMount: host node_modules with no lockfile anywhere to compare is offered", () => {
  const host = tempRepo({});
  fs.mkdirSync(path.join(host, "node_modules"), { recursive: true });
  const worktree = tempRepo({});
  const result = resolveNodeModulesMount({ hostProjectDir: host, worktreeCwd: worktree });
  assert.equal(result.source, path.join(host, "node_modules"));
  assert.equal(result.blockedReason, null);
});

test("resolveNodeModulesMount: matching package-lock.json on both sides is offered", () => {
  const lock = '{"name":"nomarmy","lockfileVersion":3}';
  const host = tempRepo({ "package-lock.json": lock });
  fs.mkdirSync(path.join(host, "node_modules"), { recursive: true });
  const worktree = tempRepo({ "package-lock.json": lock });
  const result = resolveNodeModulesMount({ hostProjectDir: host, worktreeCwd: worktree });
  assert.equal(result.source, path.join(host, "node_modules"));
  assert.equal(result.blockedReason, null);
});

test("resolveNodeModulesMount: a worktree that changed package-lock.json is blocked, not mounted", () => {
  const host = tempRepo({ "package-lock.json": '{"lockfileVersion":3,"deps":"old"}' });
  fs.mkdirSync(path.join(host, "node_modules"), { recursive: true });
  const worktree = tempRepo({ "package-lock.json": '{"lockfileVersion":3,"deps":"new"}' });
  const result = resolveNodeModulesMount({ hostProjectDir: host, worktreeCwd: worktree });
  assert.equal(result.source, null);
  assert.match(result.blockedReason, /package-lock\.json differs/);
});

test("createVerificationRunner: dependency drift is reported not_run, never silently mounted or run", async () => {
  const host = tempRepo({ "package-lock.json": '{"deps":"old"}' });
  fs.mkdirSync(path.join(host, "node_modules"), { recursive: true });
  const worktree = tempRepo({ "package-lock.json": '{"deps":"new"}' });
  const executor = fakeExecutor({ fallback: { started: true, exitCode: 0, stdout: "ok", stderr: "" } });
  const run = createVerificationRunner({ loadConfig: fixedConfig(STANDARD), executor, hostProjectDir: host });

  const verdict = await run({ ...CONTEXT, cwd: worktree });

  assert.equal(verdict.status, "not_run");
  assert.equal(verdict.basis, "dependency-drift");
  assert.equal(executor.calls.run.length, 0, "no command may run against a mismatched dependency tree");
});

test("createVerificationRunner: a matching node_modules is mounted into every command", async () => {
  const lock = '{"deps":"same"}';
  const host = tempRepo({ "package-lock.json": lock });
  fs.mkdirSync(path.join(host, "node_modules"), { recursive: true });
  const worktree = tempRepo({ "package-lock.json": lock });
  const executor = fakeExecutor({ fallback: { started: true, exitCode: 0, stdout: "ok", stderr: "" } });
  const run = createVerificationRunner({ loadConfig: fixedConfig(STANDARD), executor, hostProjectDir: host });

  const verdict = await run({ ...CONTEXT, cwd: worktree });

  assert.equal(verdict.status, "pass");
  assert.ok(executor.calls.run.every((c) => c.nodeModulesSource === path.join(host, "node_modules")));
});

// --------------------------------------------------------------------------
// runner — happy path
// --------------------------------------------------------------------------

test("all commands passing yields pass with a basis naming the profile", async () => {
  const executor = fakeExecutor({ fallback: { started: true, exitCode: 0, stdout: "ok", stderr: "" } });
  const run = createVerificationRunner({ loadConfig: fixedConfig(STANDARD), executor, image: "test-image:1" });

  const verdict = await run(CONTEXT);

  assert.equal(verdict.status, "pass");
  assert.match(verdict.basis, /2 commands in profile 'standard'/);
  assert.match(verdict.detail, /2 of 2 commands passed/);
  assert.equal(executor.calls.run.length, 2);
  assert.deepEqual(executor.calls.run.map((c) => c.command), ["npm run lint", "npm test"]);
  // Every command ran in the sandbox, against the job worktree.
  for (const call of executor.calls.run) {
    assert.equal(call.image, "test-image:1");
    assert.equal(call.cwd, CONTEXT.cwd);
    assert.equal(call.network, "none");
  }
});

test("a non-zero exit yields fail naming the command and exit code, and stops there", async () => {
  const executor = fakeExecutor({
    responses: {
      "npm run lint": { started: true, exitCode: 0, stdout: "", stderr: "" },
      "npm test": { started: true, exitCode: 7, stdout: "", stderr: "1 test failed" },
    },
  });
  const run = createVerificationRunner({ loadConfig: fixedConfig(STANDARD), executor });

  const verdict = await run(CONTEXT);

  assert.equal(verdict.status, "fail");
  assert.match(verdict.detail, /npm test/);
  assert.match(verdict.detail, /exit code 7/);
  assert.equal(executor.calls.run.length, 2, "execution stops at the first failure");
});

// --------------------------------------------------------------------------
// runner — absence of a contract is not_run, never an error
// --------------------------------------------------------------------------

test("no .nomarmy.yml, no verification block and an unknown profile are each not_run with a distinct reason", async () => {
  const reasons = [];

  for (const config of [null, { environment_retention: {} }, STANDARD]) {
    const executor = fakeExecutor();
    const run = createVerificationRunner({ loadConfig: fixedConfig(config), executor });
    const verdict = await run({ ...CONTEXT, profile: config === STANDARD ? "browser" : "standard" });

    assert.equal(verdict.status, "not_run");
    assert.equal(executor.calls.run.length, 0, "nothing may execute when there is no profile to run");
    reasons.push(verdict.reason);
  }

  assert.match(reasons[0], /no \.nomarmy\.yml/);
  assert.match(reasons[1], /no 'verification' block/);
  assert.match(reasons[2], /defines no verification profile 'browser'/);
  assert.equal(new Set(reasons).size, 3);
});

test("a real repository without a config file resolves to not_run through the real loader", async () => {
  const repo = tempRepo({ "README.md": "# empty\n" });
  const executor = fakeExecutor();
  const run = createVerificationRunner({ executor });

  const verdict = await run({ ...CONTEXT, cwd: repo });

  assert.equal(verdict.status, "not_run");
  assert.match(verdict.reason, /no \.nomarmy\.yml/);
  assert.equal(executor.calls.probe.length, 0);
  assert.equal(executor.calls.run.length, 0);
});

test("a real repository with a config file is read through the real loader", async () => {
  const repo = tempRepo({
    ".nomarmy.yml": [
      "verification:",
      "  quick:",
      "    environment: none",
      "    commands:",
      "      - node --test",
      "",
    ].join("\n"),
  });
  const executor = fakeExecutor({ fallback: { started: true, exitCode: 0, stdout: "", stderr: "" } });
  const run = createVerificationRunner({ executor });

  const verdict = await run({ ...CONTEXT, cwd: repo, profile: "quick" });

  assert.equal(verdict.status, "pass");
  assert.deepEqual(executor.calls.run.map((c) => c.command), ["node --test"]);
});

test("an empty command list is not_run rather than a vacuous pass", async () => {
  const executor = fakeExecutor();
  const run = createVerificationRunner({
    loadConfig: fixedConfig({ verification: { standard: { environment: "none", commands: [] } } }),
    executor,
  });

  const verdict = await run(CONTEXT);

  assert.equal(verdict.status, "not_run");
  assert.match(verdict.reason, /lists no commands/);
  assert.equal(executor.calls.run.length, 0);
});

// --------------------------------------------------------------------------
// runner — unmet environment requirements
// --------------------------------------------------------------------------

test("environment: integration is not_run naming the unmet requirement, NOT fail", async () => {
  const executor = fakeExecutor();
  const run = createVerificationRunner({
    loadConfig: fixedConfig({
      verification: { standard: { environment: "integration", commands: ["npm run test:int"] } },
    }),
    executor,
  });

  const verdict = await run(CONTEXT);

  assert.equal(verdict.status, "not_run", "an unprovisioned environment must never be reported as a failure");
  assert.match(verdict.reason, /integration/);
  assert.match(verdict.reason, /services/);
  assert.equal(verdict.basis, "environment-not-provisioned");
  assert.equal(executor.calls.run.length, 0, "commands must not run without their dependencies");
});

// --------------------------------------------------------------------------
// runner — the sandbox is mandatory
// --------------------------------------------------------------------------

test("Podman unavailable is not_run and NOTHING is executed on the host", async () => {
  const executor = fakeExecutor({ available: false, probeReason: "podman is not usable" });
  const run = createVerificationRunner({ loadConfig: fixedConfig(STANDARD), executor });

  const verdict = await run(CONTEXT);

  assert.equal(verdict.status, "not_run");
  assert.equal(verdict.basis, "sandbox-unavailable");
  assert.match(verdict.reason, /podman is not usable/);
  assert.match(verdict.reason, /never executed on the host/);

  // The security property under test: no execution path was attempted at all.
  assert.equal(executor.calls.probe.length, 1);
  assert.equal(executor.calls.run.length, 0, "there must be no host fallback");
});

test("a missing sandbox image is not_run, not a fabricated failure", async () => {
  const executor = fakeExecutor({
    available: false,
    probeReason: "sandbox image 'openclaw-nomarmy-coder:bookworm' is not present locally",
  });
  const run = createVerificationRunner({ loadConfig: fixedConfig(STANDARD), executor });

  const verdict = await run(CONTEXT);
  assert.equal(verdict.status, "not_run");
  assert.match(verdict.reason, /not present locally/);
  assert.equal(executor.calls.run.length, 0);
});

test("a probe that throws is not_run, never a host fallback", async () => {
  const calls = [];
  const executor = {
    async probe() { throw new Error("podman socket exploded"); },
    async run(input) { calls.push(input); return { started: true, exitCode: 0 }; },
  };
  const run = createVerificationRunner({ loadConfig: fixedConfig(STANDARD), executor });

  const verdict = await run(CONTEXT);
  assert.equal(verdict.status, "not_run");
  assert.match(verdict.reason, /podman socket exploded/);
  assert.equal(calls.length, 0);
});

test("a container that never starts is not_run when nothing ran at all", async () => {
  const executor = fakeExecutor({
    fallback: { started: false, reason: "container failed to start: podman exit 125" },
  });
  const run = createVerificationRunner({ loadConfig: fixedConfig(STANDARD), executor });

  const verdict = await run(CONTEXT);
  assert.equal(verdict.status, "not_run");
  assert.match(verdict.reason, /container failed to start/);
});

// --------------------------------------------------------------------------
// runner — timeouts
// --------------------------------------------------------------------------

test("a command that times out is a fail and the runner returns promptly", { timeout: 5000 }, async () => {
  const executor = fakeExecutor({
    responses: {
      "npm run lint": { started: true, exitCode: 0 },
      "npm test": async () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ started: true, timedOut: true, exitCode: null, stdout: "", stderr: "killed", durationMs: 20 }),
            10,
          ),
        ),
    },
  });
  const run = createVerificationRunner({
    loadConfig: fixedConfig(STANDARD),
    executor,
    commandTimeoutMs: 50,
  });

  const verdict = await run(CONTEXT);

  assert.equal(verdict.status, "fail");
  assert.match(verdict.detail, /timed out/);
  assert.match(verdict.detail, /npm test/);
  // The per-command budget is what was handed to the sandbox.
  assert.equal(executor.calls.run.at(-1).timeoutMs, 50);
});

test("the overall budget stops later commands and the runner reports fail", { timeout: 5000 }, async () => {
  let clock = 0;
  const executor = fakeExecutor({
    fallback: () => {
      clock += 1000; // each command consumes the whole remaining budget
      return { started: true, exitCode: 0, durationMs: 1000 };
    },
  });
  const run = createVerificationRunner({
    loadConfig: fixedConfig(STANDARD),
    executor,
    overallTimeoutMs: 900,
    now: () => clock,
  });

  const verdict = await run(CONTEXT);

  assert.equal(executor.calls.run.length, 1, "the second command must not start past the deadline");
  assert.equal(verdict.status, "fail");
  assert.match(verdict.detail, /timed out|budget/);
});

test("the per-command budget never exceeds the remaining overall budget", async () => {
  let clock = 0;
  const executor = fakeExecutor({ fallback: () => { clock += 400; return { started: true, exitCode: 0 }; } });
  const run = createVerificationRunner({
    loadConfig: fixedConfig(STANDARD),
    executor,
    commandTimeoutMs: 10_000,
    overallTimeoutMs: 500,
    now: () => clock,
  });

  await run(CONTEXT);

  assert.equal(executor.calls.run[0].timeoutMs, 500);
});

// --------------------------------------------------------------------------
// runner — output capping
// --------------------------------------------------------------------------

test("oversized command output is capped and the drop is recorded in the verdict", async () => {
  const executor = fakeExecutor({
    responses: {
      "npm run lint": { started: true, exitCode: 0, stdout: "x".repeat(500_000), stderr: "" },
      "npm test": { started: true, exitCode: 0, stdout: "", stderr: "y".repeat(500_000) },
    },
  });
  const run = createVerificationRunner({
    loadConfig: fixedConfig(STANDARD),
    executor,
    maxOutputBytes: 1024,
  });

  const verdict = await run(CONTEXT);

  assert.equal(verdict.status, "pass");
  assert.match(verdict.detail, /bytes of output dropped/);
  assert.match(verdict.detail, /1024-byte cap/);
  // The cap is also handed down so a real executor stops buffering at source.
  assert.equal(executor.calls.run[0].maxOutputBytes, 1024);
});

test("a failure detail carrying huge stderr stays bounded", async () => {
  const executor = fakeExecutor({
    responses: {
      "npm run lint": { started: true, exitCode: 0 },
      "npm test": { started: true, exitCode: 1, stdout: "", stderr: "z".repeat(200_000) },
    },
  });
  const run = createVerificationRunner({ loadConfig: fixedConfig(STANDARD), executor, maxOutputBytes: 2048 });

  const verdict = await run(CONTEXT);

  assert.equal(verdict.status, "fail");
  assert.match(verdict.detail, /exit code 1/);
  assert.ok(verdict.detail.length < 2000, `detail should stay bounded, got ${verdict.detail.length} chars`);
});

// --------------------------------------------------------------------------
// runner — contract shape
// --------------------------------------------------------------------------

test("the runner always returns a normalisable verdict and never throws", async () => {
  const cases = [
    {},
    { ...CONTEXT, cwd: null },
    { ...CONTEXT, profile: undefined },
  ];
  const run = createVerificationRunner({
    loadConfig: fixedConfig(STANDARD),
    executor: fakeExecutor(),
  });

  for (const context of cases) {
    const verdict = await run(context);
    assert.ok(["pass", "fail", "not_run"].includes(verdict.status), JSON.stringify(verdict));
    assert.equal(typeof verdict.basis, "string");
  }
});

test("a broken .nomarmy.yml is not_run, not an exception", async () => {
  const repo = tempRepo({ ".nomarmy.yml": "verification:\n  standard:\n    commands: 5\n" });
  const executor = fakeExecutor();
  const run = createVerificationRunner({ executor });

  const verdict = await run({ ...CONTEXT, cwd: repo });

  assert.equal(verdict.status, "not_run");
  assert.equal(verdict.basis, "config-error");
  assert.equal(executor.calls.run.length, 0);
});
