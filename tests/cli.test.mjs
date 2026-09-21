// CLI integration tests for bin/nomarmy.mjs non-interactive (--json) paths.
// Spawns the real CLI as a subprocess against temporary scratch directories.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(here, "..", "bin", "nomarmy.mjs");

function runCLI(args, options = {}) {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "nomarmy-cli-test-"));
  try {
    const cwd = options.cwd ?? tmpDir;
    const result = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    return { exitCode: 0, stdout: result, stderr: "" };
  } catch (error) {
    return {
      exitCode: error.status ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      error,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function writeConfig(dir, config) {
  const configPath = path.join(dir, ".nomarmy.yml");
  fs.writeFileSync(configPath, config, "utf8");
}

test("validate --json on directory with no .nomarmy.yml returns found:false and exits 0", () => {
  const { exitCode, stdout } = runCLI(["validate", "--json"]);
  const output = JSON.parse(stdout);
  assert.equal(exitCode, 0);
  assert.equal(output.found, false);
});

test("validate --json on directory with valid .nomarmy.yml returns valid:true", () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "nomarmy-validate-test-"));
  try {
    const validConfig = `verification:
  quick:
    commands:
      - echo ok
`;
    writeConfig(tmpDir, validConfig);

    const result = execFileSync(process.execPath, [CLI_PATH, "validate", "--json", "--repo", tmpDir], {
      encoding: "utf8",
    });
    const output = JSON.parse(result);
    assert.equal(output.found, true);
    assert.equal(output.valid, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("init --json against existing .nomarmy.yml exits non-zero with error field", () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "nomarmy-init-exists-test-"));
  try {
    writeConfig(tmpDir, "verification:\n  quick:\n    commands:\n      - echo ok\n");

    try {
      execFileSync(process.execPath, [CLI_PATH, "init", "--json", "--repo", tmpDir], {
        encoding: "utf8",
      });
      assert.fail("Expected execFileSync to throw on non-zero exit");
    } catch (error) {
      assert.equal(error.status, 1);
      const output = JSON.parse(error.stdout);
      assert.ok(output.error);
      assert.ok(output.error.includes("already exists"));
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("init --json --write against fresh directory writes .nomarmy.yml and exits 0", () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "nomarmy-init-write-test-"));
  try {
    const result = execFileSync(process.execPath, [CLI_PATH, "init", "--json", "--write", "--repo", tmpDir], {
      encoding: "utf8",
    });
    const output = JSON.parse(result);
    assert.equal(output.written, path.join(tmpDir, ".nomarmy.yml"));
    assert.ok(fs.existsSync(output.written));

    const validateResult = execFileSync(process.execPath, [CLI_PATH, "validate", "--json", "--repo", tmpDir], {
      encoding: "utf8",
    });
    const validateOutput = JSON.parse(validateResult);
    assert.equal(validateOutput.found, true);
    assert.equal(validateOutput.valid, true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// uninstall --clear-models/--clear-agents: real removal is NOT exercised
// here. uninstall.sh unconditionally runs `claude mcp remove
// nomarmy-local-worker` -- this session's own live registration -- so any
// test that got past the refusal gate below would disconnect the real
// session running this suite. Only the safe-to-call-automatically part (the
// refusal that runs BEFORE uninstall.sh) is covered.
test("uninstall --clear-models --json without --force refuses before touching anything", () => {
  const { exitCode, stdout } = runCLI(["uninstall", "--clear-models", "--json"]);
  assert.notEqual(exitCode, 0);
  const output = JSON.parse(stdout);
  assert.match(output.error, /needs --force/);
});

test("uninstall --clear-agents --all --json without --force refuses before touching anything", () => {
  const { exitCode, stdout } = runCLI(["uninstall", "--clear-agents", "--json"]);
  assert.notEqual(exitCode, 0);
  assert.match(JSON.parse(stdout).error, /needs --force/);

  const allResult = runCLI(["uninstall", "--all", "--json"]);
  assert.notEqual(allResult.exitCode, 0);
  assert.match(JSON.parse(allResult.stdout).error, /needs --force/);
});

test("sizing --noms N --json sizes for the exact requested worker count", () => {
  const { exitCode, stdout } = runCLI(["sizing", "--noms", "4", "--json"]);
  assert.equal(exitCode, 0);
  const { recommendation } = JSON.parse(stdout);
  assert.equal(recommendation.requestedNoms, 4);
  assert.equal(recommendation.llamaParallel, 4);
  assert.equal(recommendation.maxWorkers, 4);
  assert.equal(recommendation.env.NOMARMY_LLAMA_PARALLEL, 4);
});

test("sizing --noms with a non-numeric value is refused with a clear error, not a crash", () => {
  const { exitCode, stdout } = runCLI(["sizing", "--noms", "banana", "--json"]);
  assert.notEqual(exitCode, 0);
  assert.match(JSON.parse(stdout).error, /--noms must be a positive number/);
});

test("sizing --noms an unreasonable count reports fits:false, not a crash or a silently smaller count", () => {
  const { exitCode, stdout } = runCLI(["sizing", "--noms", "9999", "--json"]);
  assert.equal(exitCode, 0);
  const { recommendation } = JSON.parse(stdout);
  assert.equal(recommendation.requestedNoms, 9999);
  assert.equal(recommendation.fits, false);
});

// `nomarmy providers` resolves config/providers.yml against nomarmyRoot (the
// CLI script's OWN location), not --repo/cwd -- the same way `setup`/`model`
// already resolve config/common.env. read-only subcommands (list/validate)
// are safe to exercise against the real checkout directly, since this repo
// ships no real config/providers.yml (only the .example template). The
// WRITE subcommands (add/remove) get their own tiny scratch copy of
// bin/+lib/+package.json (node_modules symlinked, not copied, to stay fast)
// so a test run never touches this actual repository's own files.

test("providers list --json against this real repo (no config/providers.yml shipped) reports found:false", () => {
  const result = execFileSync(process.execPath, [CLI_PATH, "providers", "list", "--json"], { encoding: "utf8" });
  const output = JSON.parse(result);
  assert.equal(output.found, false);
  assert.deepEqual(output.pools, {});
});

test("providers validate --json against this real repo reports valid:true, found:false", () => {
  const result = execFileSync(process.execPath, [CLI_PATH, "providers", "validate", "--json"], { encoding: "utf8" });
  const output = JSON.parse(result);
  assert.equal(output.valid, true);
  assert.equal(output.found, false);
});

function scratchNomarmyRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), "nomarmy-providers-cli-"));
  const repoRoot = path.join(here, "..");
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(dir, "node_modules"));
  fs.cpSync(path.join(repoRoot, "bin"), path.join(dir, "bin"), { recursive: true });
  fs.cpSync(path.join(repoRoot, "lib"), path.join(dir, "lib"), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(dir, "package.json"));
  return dir;
}

function runProvidersCLI(root, args) {
  try {
    const result = execFileSync(process.execPath, [path.join(root, "bin", "nomarmy.mjs"), "providers", ...args], {
      cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    return { exitCode: 0, stdout: result, stderr: "" };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("providers add --json (llama-cpp) writes a valid config/providers.yml under a scratch nomarmyRoot", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "llama-cpp", "--id", "local", "--weight", "10"]);
    assert.equal(exitCode, 0, stdout);
    const written = JSON.parse(stdout);
    assert.equal(written.entry.id, "local");
    assert.ok(fs.existsSync(path.join(root, "config", "providers.yml")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers add --json (hosted provider) requires --auth-env, refuses cleanly without it", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runProvidersCLI(root, ["add", "--json", "--pool", "capable", "--provider", "anthropic", "--id", "sonnet", "--model", "claude-sonnet-4-6"]);
    assert.notEqual(exitCode, 0);
    assert.match(JSON.parse(stdout).errors.join("\n"), /auth_env: is required/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers add --json twice accumulates entries in the same pool, then list --json shows both", () => {
  const root = scratchNomarmyRoot();
  try {
    runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "llama-cpp", "--id", "local", "--weight", "10"]);
    runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "deepinfra", "--id", "deepinfra-llama", "--model", "meta-llama/Llama-3.3-70B-Instruct-Turbo", "--auth-env", "NOMARMY_DEEPINFRA_API_KEY", "--weight", "3"]);
    const { exitCode, stdout } = runProvidersCLI(root, ["list", "--json"]);
    assert.equal(exitCode, 0, stdout);
    const output = JSON.parse(stdout);
    assert.equal(output.pools.cheap.length, 2);
    assert.equal(output.pools.cheap[1].auth_set, false, "NOMARMY_DEEPINFRA_API_KEY is not set in the test env");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers add --json refuses a duplicate id across pools, and does not corrupt the existing file", () => {
  const root = scratchNomarmyRoot();
  try {
    runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "llama-cpp", "--id", "local", "--weight", "10"]);
    const { exitCode, stdout } = runProvidersCLI(root, ["add", "--json", "--pool", "capable", "--provider", "anthropic", "--id", "local", "--model", "x", "--auth-env", "NOMARMY_X"]);
    assert.notEqual(exitCode, 0);
    assert.match(JSON.parse(stdout).errors.join("\n"), /already used by pool "cheap"/);
    const after = fs.readFileSync(path.join(root, "config", "providers.yml"), "utf8");
    assert.match(after, /cheap:/);
    assert.doesNotMatch(after, /capable:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers remove --json removes one entry; removing the last entry removes the whole pool", () => {
  const root = scratchNomarmyRoot();
  try {
    runProvidersCLI(root, ["add", "--json", "--pool", "cheap", "--provider", "llama-cpp", "--id", "local", "--weight", "10"]);
    const { exitCode, stdout } = runProvidersCLI(root, ["remove", "cheap", "local", "--json"]);
    assert.equal(exitCode, 0, stdout);
    const output = JSON.parse(stdout);
    assert.equal(output.removed, true);
    const after = fs.readFileSync(path.join(root, "config", "providers.yml"), "utf8");
    assert.doesNotMatch(after, /cheap:/, "an emptied pool must be removed entirely, not left as an empty list");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("providers remove --json on a nonexistent config/providers.yml refuses cleanly", () => {
  const root = scratchNomarmyRoot();
  try {
    const { exitCode, stdout } = runProvidersCLI(root, ["remove", "cheap", "local", "--json"]);
    assert.notEqual(exitCode, 0);
    assert.match(JSON.parse(stdout).error, /No config\/providers\.yml exists yet/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan --json against empty temp directory returns evidence with zero counts", () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "nomarmy-scan-empty-test-"));
  try {
    const result = execFileSync(process.execPath, [CLI_PATH, "scan", "--json", "--repo", tmpDir], {
      encoding: "utf8",
    });
    const output = JSON.parse(result);
    assert.ok(output.counts);
    for (const [category, count] of Object.entries(output.counts)) {
      assert.equal(count, 0, `category ${category} should be 0`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
