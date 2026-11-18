import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliFile = fileURLToPath(new URL("../bin/nomarmy.mjs", import.meta.url));
const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// Answered before the Windows forward to WSL, so this runs everywhere.
test("nomarmy --version, -v and version print the installed version (they printed the help)", () => {
  for (const arg of ["--version", "-v", "version"]) {
    const result = spawnSync(process.execPath, [cliFile, arg], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), version, arg);
  }
  const asJson = spawnSync(process.execPath, [cliFile, "--version", "--json"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(asJson.stdout), { version });
});
