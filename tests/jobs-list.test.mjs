import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliFile = fileURLToPath(new URL("../bin/nomarmy.mjs", import.meta.url));

test("nomarmy jobs: nomArmy's own cache folders (.base-verification) aren't listed as jobs", (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-list-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const jobsRoot = path.join(stateDir, "jobs");
  const when = "2026-11-09T00:00:00.000Z";
  fs.mkdirSync(path.join(jobsRoot, "worker-20261109-000000-abc123"), { recursive: true });
  fs.writeFileSync(path.join(jobsRoot, "worker-20261109-000000-abc123", "metadata.json"),
    JSON.stringify({ jobId: "worker-20261109-000000-abc123", mode: "implement", outcome: "WORKER_DONE", startedAt: when, finishedAt: when }));
  fs.mkdirSync(path.join(jobsRoot, ".base-verification", "cache"), { recursive: true });
  const listing = spawnSync(process.execPath, [cliFile, "jobs", "--json"], { encoding: "utf8", env: { ...process.env, NOMARMY_AGENT_STATE: stateDir } });
  assert.equal(listing.status, 0, listing.stderr);
  const { running, recent } = JSON.parse(listing.stdout);
  assert.deepEqual([...running, ...recent].map((j) => j.jobId ?? j.id), ["worker-20261109-000000-abc123"]);
});
