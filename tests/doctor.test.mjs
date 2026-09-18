// Tests for lib/doctor.mjs.
//
// The check functions are pure: they take a facts object and return a
// verdict. Facts are hand-built here rather than collected from the real
// filesystem/network/subprocess, so these tests run with no node_modules and
// no live podman/llama-server/AWS.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  parseNodeVersion,
  checkNodeVersion,
  findExecutable,
  checkGit,
  checkGitLongPaths,
  checkPodmanPresent,
  checkPodmanDaemon,
  checkEndpoint,
  evaluateChecks,
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

test("findExecutable finds a *nix-style binary with no extension appended", () => {
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
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /ECONNREFUSED/);
  assert.match(result.fix, /start-inference\.sh/);
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

test("checkEndpoint rejects an unrecognised NOMARMY_EXECUTION value", () => {
  const result = checkEndpoint({ execution: "carrier-pigeon", endpoint: {} });
  assert.equal(result.ok, false);
  assert.match(result.fix, /local' or 'bedrock'/);
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

// --- evaluateChecks / runDoctor: whole-report behaviour ---------------------

function passingFacts() {
  return {
    nodeVersion: "v20.11.3",
    platform: "linux",
    gitFound: true,
    gitLongPaths: null,
    podmanFound: true,
    podmanDaemonReachable: true,
    podmanDaemonError: null,
    execution: "local",
    endpoint: { mode: "local", url: "http://127.0.0.1:8080/health", healthy: true, error: null },
  };
}

test("evaluateChecks reports overall ok when every check passes", () => {
  const checks = evaluateChecks(passingFacts());
  assert.equal(checks.length, 6);
  assert.ok(checks.every((c) => c.ok));
  assert.deepEqual(checks.map((c) => c.id), ["node", "git", "git-longpaths", "podman", "podman-daemon", "endpoint"]);
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
    assert.equal(parsed.checks.length, 6);
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
