// Tests for lib/doctor.mjs.
//
// The check functions are pure: they take a facts object and return a
// verdict. Facts are hand-built here rather than collected from the real
// filesystem/network/subprocess, so these tests need no live
// podman/llama-server/AWS. Fact collection uses a virtual filesystem below.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import * as doctor from "../lib/doctor.mjs";

import {
  parseNodeVersion,
  checkNodeVersion,
  findExecutable,
  checkGit,
  checkGitLongPaths,
  checkPodmanPresent,
  checkPodmanDaemon,
  checkEndpoint,
  collectEndpointFacts,
  probeRemoteEndpoint,
  evaluateChecks,
  checkPrivateTmp,
  runDoctor,
} from "../lib/doctor.mjs";

// --- parseNodeVersion / checkNodeVersion ------------------------------------

test("parseNodeVersion reads major/minor/patch from a v-prefixed string", () => {
  assert.deepEqual(parseNodeVersion("v20.11.3"), { major: 20, minor: 11, patch: 3 });
});

test("parseNodeVersion accepts a version without the v prefix", () => {
  assert.deepEqual(parseNodeVersion("18.0.0"), { major: 18, minor: 0, patch: 0 });
});

test("parseNodeVersion returns null for garbage input", () => {
  assert.equal(parseNodeVersion("not-a-version"), null);
  assert.equal(parseNodeVersion(""), null);
  assert.equal(parseNodeVersion(undefined), null);
});

test("checkNodeVersion passes at the minimum supported major", () => {
  const result = checkNodeVersion("v18.0.0");
  assert.equal(result.ok, true);
  assert.match(result.message, /v18\.0\.0 is OK/);
});

test("checkNodeVersion fails below the minimum major with a concrete fix", () => {
  const result = checkNodeVersion("v16.20.0");
  assert.equal(result.ok, false);
  assert.match(result.message, /too old/);
  assert.match(result.fix, /Upgrade Node\.js to v18/);
});

test("checkNodeVersion fails on unparseable input with a fix", () => {
  const result = checkNodeVersion("banana");
  assert.equal(result.ok, false);
  assert.ok(result.fix);
});

// --- findExecutable ----------------------------------------------------------
// This is the fix for defect #3 (only .exe was tried). It is tested with an
// injected PATH, PATHEXT and file-existence predicate so it never touches
// the real filesystem.

test("findExecutable finds a *nix-style binary with no extension appended", { skip: process.platform === "win32" ? "extensionless executable lookup is POSIX-only" : false }, () => {
  // findExecutable joins with node:path and path.delimiter, which are
  // platform-native rather than posix-specific (as they should be - doctor
  // only ever runs against the real host's own PATH), so this builds the
  // expected candidate the same way rather than hardcoding a separator that
  // would only be correct on one host OS.
  const dirA = path.join(path.sep, "usr", "bin");
  const dirB = path.join(path.sep, "usr", "local", "bin");
  const target = path.join(dirB, "git");
  const found = findExecutable("git", {
    platform: "linux", // isWin=false -> no PATHEXT extension is tried
    pathEnv: [dirA, dirB].join(path.delimiter),
    existsFile: (candidate) => candidate === target,
  });
  assert.equal(found, target);
});

test("findExecutable on Windows finds a .cmd shim, not just .exe", () => {
  const found = findExecutable("podman", {
    platform: "win32",
    pathEnv: "C:\\tools;C:\\Windows\\System32",
    pathExt: ".COM;.EXE;.BAT;.CMD",
    existsFile: (candidate) => candidate === "C:\\tools\\podman.cmd",
  });
  assert.equal(found, "C:\\tools\\podman.cmd");
});

test("findExecutable on Windows finds a .bat shim", () => {
  const found = findExecutable("nom", {
    platform: "win32",
    pathEnv: "C:\\tools",
    pathExt: ".COM;.EXE;.BAT;.CMD",
    existsFile: (candidate) => candidate === "C:\\tools\\nom.bat",
  });
  assert.equal(found, "C:\\tools\\nom.bat");
});

test("findExecutable returns null when nothing on PATH matches", () => {
  const found = findExecutable("missing-tool", {
    platform: "linux",
    pathEnv: "/usr/bin",
    existsFile: () => false,
  });
  assert.equal(found, null);
});

test("findExecutable ignores PATH casing/precedence traps (defect #2)", () => {
  // Regression for `process.env.PATH || os.platform() === "win32" ? a : b`:
  // a populated PATH must be used as-is, not overridden by platform checks.
  const found = findExecutable("git", {
    platform: "win32",
    pathEnv: "C:\\Git\\bin",
    pathExt: ".COM;.EXE;.BAT;.CMD",
    existsFile: (candidate) => candidate === "C:\\Git\\bin\\git.exe",
  });
  assert.equal(found, "C:\\Git\\bin\\git.exe");
});

// --- checkGit / checkPodmanPresent / checkPodmanDaemon ----------------------

test("checkGit ok when present", () => {
  assert.equal(checkGit({ gitFound: true }).ok, true);
});

test("checkGit fails with a concrete fix when absent", () => {
  const result = checkGit({ gitFound: false });
  assert.equal(result.ok, false);
  assert.match(result.fix, /Install Git/);
});

test("checkPodmanPresent fails with a concrete fix when absent", () => {
  const result = checkPodmanPresent({ podmanFound: false });
  assert.equal(result.ok, false);
  assert.match(result.fix, /Install Podman/);
});

test("checkPodmanDaemon distinguishes 'not installed' from 'not usable' (the CLI vs actually working)", () => {
  const notInstalled = checkPodmanDaemon({ podmanFound: false, podmanDaemonReachable: false });
  assert.match(notInstalled.message, /executable not found/);

  const installedButDown = checkPodmanDaemon({
    podmanFound: true,
    podmanDaemonReachable: false,
    podmanDaemonError: "connection refused",
  });
  assert.equal(installedButDown.ok, false);
  assert.match(installedButDown.message, /connection refused/);
  assert.match(installedButDown.fix, /podman machine start/);
});

test("checkPodmanDaemon ok when podman answers", () => {
  const result = checkPodmanDaemon({ podmanFound: true, podmanDaemonReachable: true });
  assert.equal(result.ok, true);
});

// --- checkEndpoint: local vs bedrock branch (defect #5) ---------------------

test("checkEndpoint (local) ok when llama-server health check succeeds", () => {
  const result = checkEndpoint({
    execution: "local",
    endpoint: { mode: "local", url: "http://127.0.0.1:8080/health", healthy: true, error: null },
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /127\.0\.0\.1:8080/);
});

test("checkEndpoint (local) fails with a concrete fix when unreachable", () => {
  const result = checkEndpoint({
    execution: "local",
    endpoint: { mode: "local", url: "http://127.0.0.1:8080/health", healthy: false, error: "connect ECONNREFUSED" },
    platform: "linux",
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /ECONNREFUSED/);
  assert.deepEqual(result, {
    ok: false,
    message: "llama-server health check failed at http://127.0.0.1:8080/health: connect ECONNREFUSED",
    fix: "Run 'nomarmy setup --hosted' if your jobs run on API keys or subscriptions. To run a model on this machine: 'nomarmy start <profile>'. Then re-run 'nomarmy doctor'.",
  });
});

test("checkEndpoint (hosted) passes because there is no local model by design", () => {
  assert.deepEqual(checkEndpoint({ execution: "hosted", endpoint: { mode: "hosted" } }), {
    ok: true,
    message: "No local model by design; jobs run on API and subscription agents (run 'nomarmy agents list' to see them).",
  });
});

test("remote endpoint probes its configured health URL and reports it as remote", async () => {
  const calls = [];
  const endpoint = await probeRemoteEndpoint("http://gpu.example:9090", async (url, opts) => {
    calls.push({ url, hasSignal: opts.signal instanceof AbortSignal });
    return { ok: true, status: 200 };
  });
  assert.deepEqual(calls, [{ url: "http://gpu.example:9090/health", hasSignal: true }]);
  assert.deepEqual(endpoint, { mode: "remote", url: "http://gpu.example:9090/health", healthy: true, error: null });
  assert.deepEqual(checkEndpoint({ execution: "remote", endpoint }), {
    ok: true,
    message: "Remote model server is healthy at http://gpu.example:9090/health.",
  });
});

test("endpoint fact collection derives remote mode and URL from injected env", async () => {
  const calls = [];
  const facts = await collectEndpointFacts({ NOMARMY_EXECUTION: "local", NOMARMY_LLAMA_HOST: "gpu.internal", NOMARMY_LLAMA_PORT: "8181" }, async (url) => {
    calls.push(url);
    return { ok: true, status: 200 };
  });
  assert.deepEqual(calls, ["http://gpu.internal:8181/health"]);
  assert.deepEqual(facts, {
    execution: "remote",
    endpoint: { mode: "remote", url: "http://gpu.internal:8181/health", healthy: true, error: null },
  });
});

test("remote endpoint failure names the remote server without a local startup instruction", () => {
  const result = checkEndpoint({ execution: "remote", endpoint: { mode: "remote", url: "http://gpu.example:9090/health", healthy: false, error: "connect ECONNREFUSED" } });
  assert.deepEqual(result, {
    ok: false,
    message: "Remote model server health check failed at http://gpu.example:9090/health: connect ECONNREFUSED",
    fix: "Check that the remote server is running and reachable from this machine, then re-run 'nomarmy doctor'.",
  });
  assert.doesNotMatch(result.fix, /start-inference|start llama-server/i);
});

test("checkEndpoint (bedrock) fails when region is unset", () => {
  const result = checkEndpoint({
    execution: "bedrock",
    endpoint: { mode: "bedrock", region: null, baseUrl: null, regionValid: false, credentialsPresent: true },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /NOMARMY_BEDROCK_REGION is not set/);
});

test("checkEndpoint (bedrock) fails on a malformed region", () => {
  const result = checkEndpoint({
    execution: "bedrock",
    endpoint: { mode: "bedrock", region: "not-a-region", baseUrl: null, regionValid: false, credentialsPresent: true },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /not a valid AWS region/);
});

test("checkEndpoint (bedrock) fails when no AWS credentials are discoverable", () => {
  const result = checkEndpoint({
    execution: "bedrock",
    endpoint: { mode: "bedrock", region: "eu-west-2", baseUrl: "https://x", regionValid: true, credentialsPresent: false },
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /No AWS credentials/);
});

test("checkEndpoint (bedrock) ok with a valid region and credentials", () => {
  const result = checkEndpoint({
    execution: "bedrock",
    endpoint: {
      mode: "bedrock",
      region: "eu-west-2",
      baseUrl: "https://bedrock-runtime.eu-west-2.amazonaws.com/openai/v1",
      regionValid: true,
      credentialsPresent: true,
    },
  });
  assert.equal(result.ok, true);
});

test("checkEndpoint rejects an unrecognized NOMARMY_EXECUTION value", () => {
  const result = checkEndpoint({ execution: "carrier-pigeon", endpoint: {} });
  assert.equal(result.ok, false);
  assert.equal(result.fix, "Set NOMARMY_EXECUTION to 'local', 'remote', 'hosted', or 'bedrock' (nomarmy setup --choose, or ~/.config/nomarmy/common.env).");
});

test("checkEndpoint never references NOMARMY_MODEL_ENDPOINT (defect #5 - it does not exist)", () => {
  const local = checkEndpoint({
    execution: "local",
    endpoint: { mode: "local", url: "http://127.0.0.1:8080/health", healthy: true, error: null },
  });
  const bedrock = checkEndpoint({
    execution: "bedrock",
    endpoint: { mode: "bedrock", region: "eu-west-2", baseUrl: "https://x", regionValid: true, credentialsPresent: true },
  });
  for (const result of [local, bedrock]) {
    assert.doesNotMatch(result.message, /NOMARMY_MODEL_ENDPOINT/);
    assert.doesNotMatch(result.fix ?? "", /NOMARMY_MODEL_ENDPOINT/);
  }
});

// --- checkGitLongPaths -------------------------------------------------------

test("checkGitLongPaths is a no-op off Windows and when git is absent", () => {
  assert.equal(checkGitLongPaths({ platform: "darwin", gitFound: true, gitLongPaths: null }).ok, true);
  assert.equal(checkGitLongPaths({ platform: "linux", gitFound: true, gitLongPaths: false }).ok, true);
  assert.equal(checkGitLongPaths({ platform: "win32", gitFound: false, gitLongPaths: null }).ok, true);
});

test("checkGitLongPaths on Windows passes only when core.longpaths is true, with the exact fix", () => {
  assert.equal(checkGitLongPaths({ platform: "win32", gitFound: true, gitLongPaths: true }).ok, true);
  for (const value of [false, null]) {
    const r = checkGitLongPaths({ platform: "win32", gitFound: true, gitLongPaths: value });
    assert.equal(r.ok, false);
    assert.match(r.message, /260-character/);
    assert.equal(r.fix, "git config --global core.longpaths true");
  }
});

// --- evaluateChecks / runDoctor: whole-report behavior ---------------------

function passingFacts() {
  return {
    nodeVersion: "v20.11.3",
    platform: "linux",
    gitFound: true,
    gitLongPaths: null,
    podmanFound: true,
    podmanInitFound: true,
    podmanDaemonReachable: true,
    podmanDaemonError: null,
    execution: "local",
    endpoint: { mode: "local", url: "http://127.0.0.1:8080/health", healthy: true, error: null },
  };
}

test("evaluateChecks reports overall ok when every check passes", () => {
  const checks = evaluateChecks(passingFacts());
  assert.equal(checks.length, 12);
  assert.ok(checks.every((c) => c.ok));
  assert.deepEqual(checks.map((c) => c.id), ["node", "git", "git-longpaths", "podman", "podman-daemon", "podman-init", "podman-vm-memory", "podman-vm-jobs", "podman-idmap", "podman-dns", "private-tmp", "endpoint"]);
});

test("evaluateChecks fails the whole report when one check fails (defect #4 - no contradictory output)", () => {
  const facts = { ...passingFacts(), gitFound: false };
  const checks = evaluateChecks(facts);
  assert.equal(checks.some((c) => !c.ok), true);
  const failing = checks.filter((c) => !c.ok);
  for (const c of failing) assert.ok(c.fix, `check '${c.id}' failed without a fix`);
});

test("runDoctor with injected facts returns ok:true and does not print contradictory text", async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (msg) => lines.push(String(msg));
  try {
    const result = await runDoctor({ facts: passingFacts() });
    assert.equal(result.ok, true);
    const text = lines.join("\n");
    assert.match(text, /All checks passed\./);
    assert.doesNotMatch(text, /Some checks failed\./);
  } finally {
    console.log = originalLog;
  }
});

test("runDoctor with injected facts returns ok:false and reports only the failing text (not both)", async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (msg) => lines.push(String(msg));
  try {
    const result = await runDoctor({ facts: { ...passingFacts(), podmanFound: false, podmanDaemonReachable: false } });
    assert.equal(result.ok, false);
    const text = lines.join("\n");
    assert.match(text, /Some checks failed\./);
    assert.doesNotMatch(text, /All checks passed\./);
  } finally {
    console.log = originalLog;
  }
});

test("runDoctor --json (injected facts) produces machine-readable, consistent output", async () => {
  const originalLog = console.log;
  let printed = null;
  console.log = (msg) => { printed = String(msg); };
  try {
    const result = await runDoctor({ json: true, facts: passingFacts() });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(printed);
    assert.equal(parsed.ok, true);
    assert.ok(Array.isArray(parsed.checks));
    assert.equal(parsed.checks.length, 12);
  } finally {
    console.log = originalLog;
  }
});

test("runDoctor does not call process.exit when exit is not requested", async () => {
  const originalLog = console.log;
  console.log = () => {};
  const originalExit = process.exit;
  let called = false;
  process.exit = () => { called = true; };
  try {
    await runDoctor({ facts: passingFacts() });
    assert.equal(called, false);
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
  }
});


import { installPodmanHint } from "../lib/doctor.mjs";
test("doctor's Podman and local-model advice fits the platform (Windows got brew and a bash script)", () => {
  assert.match(installPodmanHint("win32"), /winget install RedHat\.Podman.*podman machine init --memory 8192.*WSL2/);
  assert.match(installPodmanHint("darwin"), /brew install podman.*podman machine init --memory 8192/);
  assert.match(installPodmanHint("linux"), /package manager/);
  const r = checkEndpoint({ execution: "local", endpoint: { url: "http://127.0.0.1:8080", healthy: false, error: "fetch failed" }, platform: "win32" });
  assert.match(r.fix, /^Run 'nomarmy setup --hosted' if your jobs run on API keys or subscriptions/);
  assert.match(r.fix, /docs\/install\.md#windows/);
  assert.doesNotMatch(r.fix, /\.sh/);
});


test("doctor JSON fails overall when an OpenClaw postflight check fails", async () => {
  const originalLog = console.log;
  let printed = null;
  console.log = (text) => { printed = text; };
  const check = { id: "openclaw-plugin:codex", ok: false, message: "Codex is missing.", fix: "openclaw plugins install clawhub:@openclaw/codex" };
  try {
    const result = await runDoctor({ json: true, facts: passingFacts(), additionalChecks: [check] });
    assert.deepEqual(result, { ok: false, checks: [...evaluateChecks(passingFacts()), check] });
    assert.deepEqual(JSON.parse(printed), result);
  } finally {
    console.log = originalLog;
  }
});

// --- Linux init helper and hosted-only fact collection -----------------------

test("checkPodmanInit diagnoses missing catatonit and is wired after podman-daemon", () => {
  const facts = { ...passingFacts(), podmanInitFound: false };
  const expected = {
    ok: false,
    message: 'Podman init helper not found; sandboxes fail with SandboxProvisioningError: lookup init binary: exec: "catatonit".',
    fix: "sudo apt install catatonit (or your distro's catatonit package), then re-run 'nomarmy doctor'",
  };
  assert.deepEqual(doctor.checkPodmanInit(facts), expected);
  const checks = evaluateChecks(facts);
  const index = checks.findIndex((check) => check.id === "podman-daemon");
  assert.deepEqual(checks[index + 1], { id: "podman-init", ...expected });
});

test("checkPodmanInit passes for executable helpers and skips VM platforms or missing podman", () => {
  assert.deepEqual(doctor.checkPodmanInit(passingFacts()), { ok: true, message: "Podman init helper is available." });
  for (const platform of ["darwin", "win32"]) {
    assert.deepEqual(doctor.checkPodmanInit({ platform, podmanFound: true, podmanInitFound: false }), {
      ok: true, message: "Podman init helper: not needed on this platform.",
    });
  }
  assert.deepEqual(doctor.checkPodmanInit({ platform: "linux", podmanFound: false, podmanInitFound: null }), {
    ok: true, message: "Podman init helper: skipped, podman not found.",
  });
});

test("checkEndpoint accepts an unhealthy local endpoint only for hosted-only roles", () => {
  const facts = {
    execution: "local", platform: "linux", hostedOnly: true,
    endpoint: { url: "http://127.0.0.1:8080/health", healthy: false, error: "connect ECONNREFUSED" },
  };
  assert.deepEqual(checkEndpoint(facts), {
    ok: true,
    message: "No local model running; every role runs on api or subscription agents, so none is needed. Run 'nomarmy setup --hosted' to make that explicit.",
  });
  assert.deepEqual(checkEndpoint({ ...facts, hostedOnly: false }), {
    ok: false,
    message: "llama-server health check failed at http://127.0.0.1:8080/health: connect ECONNREFUSED",
    fix: "Run 'nomarmy setup --hosted' if your jobs run on API keys or subscriptions. To run a model on this machine: 'nomarmy start <profile>'. Then re-run 'nomarmy doctor'.",
  });
});

// Virtual files keep fact collection away from host config, subprocesses and network.
async function virtualFacts(t, { platform = "linux", podman = true, files = {}, executable = [], xdg = "/doctor/config" } = {}) {
  const originalPath = process.env.PATH;
  const originalConfig = process.env.NOMARMY_CONFIG_DIR;
  process.env.PATH = "/doctor/bin";
  process.env.NOMARMY_CONFIG_DIR = "/doctor/config/nomarmy";
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalConfig === undefined) delete process.env.NOMARMY_CONFIG_DIR; else process.env.NOMARMY_CONFIG_DIR = originalConfig;
  });
  t.mock.method(os, "platform", () => platform);
  t.mock.method(os, "homedir", () => "/doctor/home");
  t.mock.method(process, "cwd", () => "/doctor/project");
  const podmanFile = platform === "win32" ? "\\doctor\\bin\\podman.exe" : "/doctor/bin/podman";
  const present = (file) => Object.hasOwn(files, file) || executable.includes(file) || (podman && file === podmanFile);
  const reads = [];
  const accesses = [];
  t.mock.method(fs, "existsSync", present);
  t.mock.method(fs, "statSync", (file) => {
    if (!present(file)) throw new Error("ENOENT");
    return { isFile: () => true, uid: process.getuid?.(), mode: 0o600 };
  });
  t.mock.method(fs, "accessSync", (file, mode) => {
    accesses.push({ file, mode });
    if (!executable.includes(file)) throw new Error("EACCES");
  });
  t.mock.method(fs, "readFileSync", (file) => {
    reads.push(file);
    if (!Object.hasOwn(files, file)) throw new Error("ENOENT");
    return files[file];
  });
  const facts = await doctor.collectFacts({ NOMARMY_EXECUTION: "hosted", PATH: "/doctor/bin", ...(xdg ? { XDG_CONFIG_HOME: xdg } : {}) });
  assert.deepEqual(Object.keys(facts).sort(), [
    "nodeVersion", "platform", "gitFound", "gitLongPaths", "podmanFound", "podmanInitFound",
    "podmanDaemonReachable", "podmanDaemonError", "podmanMachineMemoryMb", "maxJobs",
    "podmanIdMappings", "hostedOnly", "execution", "endpoint", "privateTmp", "podmanNetwork",
  ].sort());
  assert.equal(facts.podmanFound, podman);
  return { facts, reads, accesses };
}

const posixPaths = { skip: process.platform === "win32" && "virtual POSIX paths, but path.join builds backslash paths on Windows" };

test("collectFacts finds executable catatonit in each helper directory and on PATH", posixPaths, async (t) => {
  for (const dir of ["/usr/local/libexec/podman", "/usr/local/lib/podman", "/usr/libexec/podman", "/usr/lib/podman", "/doctor/bin"]) {
    await t.test(dir, async (t) => {
      const { facts } = await virtualFacts(t, { executable: [`${dir}/catatonit`] });
      assert.equal(facts.podmanInitFound, true);
    });
  }
});

test("collectFacts rejects missing or non-executable catatonit", async (t) => {
  const { facts } = await virtualFacts(t, { files: { "/usr/lib/podman/catatonit": "not executable", "/doctor/bin/catatonit": "not executable" } });
  assert.equal(facts.podmanInitFound, false);
});

test("collectFacts honors executable init_path in system, XDG and fallback containers.conf", posixPaths, async (t) => {
  for (const file of ["/etc/containers/containers.conf", "/usr/share/containers/containers.conf", "/doctor/config/containers/containers.conf", "/doctor/home/.config/containers/containers.conf"]) {
    await t.test(file, async (t) => {
      const { facts } = await virtualFacts(t, {
        files: { [file]: '# init_path = "/ignored"\n[engine]\ninit_path = "/doctor/custom-init"\n' },
        executable: ["/doctor/custom-init"],
        xdg: file.includes("/.config/") ? null : "/doctor/config",
      });
      assert.equal(facts.podmanInitFound, true);
    });
  }
});

test("collectFacts rejects non-executable configured init_path", async (t) => {
  const { facts } = await virtualFacts(t, { files: {
    "/etc/containers/containers.conf": 'init_path = "/doctor/custom-init"',
    "/doctor/custom-init": "not executable",
  } });
  assert.equal(facts.podmanInitFound, false);
});

test("collectFacts does no catatonit probing on VM platforms or without podman", async (t) => {
  for (const options of [{ platform: "darwin" }, { platform: "win32" }, { podman: false }]) {
    await t.test(JSON.stringify(options), async (t) => {
      const { facts, reads, accesses } = await virtualFacts(t, options);
      assert.equal(facts.podmanInitFound, null);
      assert.deepEqual(accesses, []);
      assert.deepEqual(reads.filter((file) => file.endsWith("containers.conf")), []);
    });
  }
});

const hostedAgents = {
  "/doctor/config/nomarmy/agents.yml": "agents:\n  api-worker:\n    kind: api\n    provider: openai\n    auth_env: TEST_API_KEY\n  subscriber:\n    kind: subscription\n    provider: codex\n    owner: tester\n  custom-local:\n    kind: local\n",
};

test("collectFacts recognizes API and subscription armies without local roles", posixPaths, async (t) => {
  for (const agent of ["api-worker", "subscriber"]) {
    await t.test(agent, async (t) => {
      const { facts } = await virtualFacts(t, { files: { ...hostedAgents,
        "/doctor/config/nomarmy/config.yml": `army:\n  roles:\n    builder:\n      agent: ${agent}\n`,
      } });
      assert.equal(facts.hostedOnly, true);
    });
  }
});

test("collectFacts requires a hosted agent and refuses built-in or custom local roles", async (t) => {
  for (const agent of [null, "local", "custom-local"]) {
    await t.test(String(agent), async (t) => {
      const files = agent ? { ...hostedAgents, "/doctor/config/nomarmy/config.yml": `army:\n  roles:\n    builder:\n      agent: api-worker\n    reviewer:\n      agent: ${agent}\n` }
        : { "/doctor/config/nomarmy/agents.yml": "agents:\n  custom-local:\n    kind: local\n" };
      const { facts } = await virtualFacts(t, { files });
      assert.equal(facts.hostedOnly, false);
    });
  }
});

test("collectFacts keeps hostedOnly false if either config load throws", async (t) => {
  for (const file of ["agents.yml", "config.yml"]) {
    await t.test(file, async (t) => {
      const { facts } = await virtualFacts(t, { files: { ...hostedAgents, [`/doctor/config/nomarmy/${file}`]: "[invalid yaml" } });
      assert.equal(facts.hostedOnly, false);
    });
  }
});
