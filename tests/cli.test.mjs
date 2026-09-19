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
