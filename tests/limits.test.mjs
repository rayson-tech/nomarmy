import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { maxJobs, setMaxJobs, jobsThatFit, vmGibFor, DEFAULT_MAX_JOBS } from "../lib/limits.mjs";
import { readArmyFile } from "../lib/army.mjs";
import { checkPodmanVmFitsJobs } from "../lib/doctor.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-limits-"));

test("max_jobs: limits.yml wins, then NOMARMY_MAX_POOL_WORKERS, then the default", () => {
  const filePath = path.join(tmp(), "limits.yml");
  assert.deepEqual(maxJobs({ env: {}, filePath }), { value: DEFAULT_MAX_JOBS, source: "default", path: null, problem: null });
  assert.equal(maxJobs({ env: { NOMARMY_MAX_POOL_WORKERS: "6" }, filePath }).source, "env");
  assert.equal(maxJobs({ env: { NOMARMY_MAX_POOL_WORKERS: "99" }, filePath }).value, 32);
  setMaxJobs(8, { filePath });
  assert.deepEqual(maxJobs({ env: { NOMARMY_MAX_POOL_WORKERS: "6" }, filePath }), { value: 8, source: "file", path: filePath, problem: null },
    "a stale value left in a registration can't override the one setting");
});

test("setMaxJobs keeps the rest of limits.yml, and a bad file is reported, not obeyed", () => {
  const filePath = path.join(tmp(), "limits.yml");
  fs.writeFileSync(filePath, "# mine\nmax_jobs: 3\nsomething_newer: true\n");
  setMaxJobs(8, { filePath });
  const text = fs.readFileSync(filePath, "utf8");
  assert.match(text, /# mine/); assert.match(text, /max_jobs: 8/); assert.match(text, /something_newer: true/, "a key from a newer version survives");
  assert.equal(maxJobs({ env: {}, filePath }).value, 8, "unknown keys don't break an older reader");
  assert.throws(() => setMaxJobs(0, { filePath }), /whole number from 1 to 32/);
  assert.throws(() => setMaxJobs(33, { filePath }), /whole number from 1 to 32/);
  fs.writeFileSync(filePath, "max_jobs: 100\n");
  const bad = maxJobs({ env: {}, filePath });
  assert.equal(bad.value, DEFAULT_MAX_JOBS);
  assert.match(bad.problem, /max_jobs must be a whole number from 1 to 32; ignored/);
  assert.equal(checkPodmanVmFitsJobs({ podmanMachineMemoryMb: 16384, maxJobs: bad }).ok, false);
});

test("limits stay out of config.yml: an older copy validates that file strictly and refused it whole", () => {
  const dir = tmp();
  const global = path.join(dir, "config.yml");
  fs.writeFileSync(global, "army:\n  general: claude\nlimits:\n  max_jobs: 8\n");
  assert.throws(() => readArmyFile(global, { armyOnly: true }), /unexpected field\(s\) "limits"/);
  const filePath = path.join(dir, "limits.yml");
  setMaxJobs(8, { filePath });
  fs.writeFileSync(global, "army:\n  general: claude\n");
  assert.equal(readArmyFile(global, { armyOnly: true }).general, "claude", "setting the limit never touches config.yml");
});

test("how many sandboxes a Podman VM fits, and the doctor check", () => {
  assert.equal(jobsThatFit(8192), 4, "the 8 GiB default fits the default 4");
  assert.equal(jobsThatFit(16384), 9);
  assert.equal(jobsThatFit(null), null);
  assert.equal(vmGibFor(8), 14);
  assert.equal(checkPodmanVmFitsJobs({ podmanMachineMemoryMb: 16384, maxJobs: { value: 8 } }).ok, true);
  const tight = checkPodmanVmFitsJobs({ podmanMachineMemoryMb: 8192, maxJobs: { value: 8 } });
  assert.equal(tight.ok, false);
  assert.match(tight.fix, /nomarmy sandbox --memory 14 .*nomarmy config max-jobs 4/);
  assert.equal(checkPodmanVmFitsJobs({ podmanMachineMemoryMb: null, maxJobs: { value: 8 } }).ok, true);
});
