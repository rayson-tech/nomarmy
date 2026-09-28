import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { maxJobs, setMaxJobs, jobsThatFit, vmGibFor, DEFAULT_MAX_JOBS } from "../lib/limits.mjs";
import { readArmyFile } from "../lib/army.mjs";
import { checkPodmanVmFitsJobs } from "../lib/doctor.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-limits-"));

test("max_jobs: config.yml wins, then NOMARMY_MAX_POOL_WORKERS, then the default", () => {
  const filePath = path.join(tmp(), "config.yml");
  assert.deepEqual(maxJobs({ env: {}, filePath }), { value: DEFAULT_MAX_JOBS, source: "default", path: null });
  assert.equal(maxJobs({ env: { NOMARMY_MAX_POOL_WORKERS: "6" }, filePath }).source, "env");
  assert.equal(maxJobs({ env: { NOMARMY_MAX_POOL_WORKERS: "99" }, filePath }).value, 32);
  setMaxJobs(8, { filePath });
  assert.deepEqual(maxJobs({ env: { NOMARMY_MAX_POOL_WORKERS: "6" }, filePath }), { value: 8, source: "config", path: filePath },
    "a stale value left in a registration can't override the one setting");
});

test("setMaxJobs keeps the rest of config.yml, comments included, and the file still loads", () => {
  const filePath = path.join(tmp(), "config.yml");
  fs.writeFileSync(filePath, "# mine\narmy:\n  general: claude  # the General\n");
  setMaxJobs(8, { filePath });
  const text = fs.readFileSync(filePath, "utf8");
  assert.match(text, /# mine/); assert.match(text, /general: claude +# the General/); assert.match(text, /limits:\n  max_jobs: 8/);
  assert.equal(readArmyFile(filePath, { armyOnly: true }).general, "claude");
  assert.throws(() => setMaxJobs(0, { filePath }), /whole number from 1 to 32/);
  assert.throws(() => setMaxJobs(33, { filePath }), /whole number from 1 to 32/);
});

test("limits belong in the global config only, and a bad value is a clear error", () => {
  const dir = tmp();
  const local = path.join(dir, ".nomarmy.local.yml");
  fs.writeFileSync(local, "limits:\n  max_jobs: 8\n");
  assert.throws(() => readArmyFile(local, { armyOnly: true }), /unexpected field\(s\) "limits"/);
  const global = path.join(dir, "config.yml");
  fs.writeFileSync(global, "limits:\n  max_jobs: 100\n");
  assert.throws(() => readArmyFile(global, { armyOnly: true }), /limits\.max_jobs/);
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
