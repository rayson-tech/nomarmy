import "./helpers/isolate-global-config.mjs";
// Tests for lib/podman-health.mjs: refusing jobs Podman can't start, and
// naming a VM restart as the cause of a failed job.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { podmanProblem, podmanVmStartedAt, vmRestartIssue } from "../lib/podman-health.mjs";
import { createJobRuntime } from "../lib/admission.mjs";
import { deriveBudgets } from "../lib/budget.mjs";

test("podmanProblem: null when Podman answers; otherwise its reason and how to start it", () => {
  assert.equal(podmanProblem({ run: () => ({ status: 0, stdout: "arm64" }) }), null);
  const down = podmanProblem({ run: () => ({ status: 125, stderr: "Cannot connect to Podman. Please verify your connection\nmore" }) });
  assert.match(down, /Podman isn't answering \(Cannot connect to Podman/);
  assert.match(down, /no job was sent/);
  assert.match(down, /podman machine start/);
});

test("podmanVmStartedAt: the running machine's LastUp on macOS and Windows; null on Linux", () => {
  const run = () => ({ stdout: JSON.stringify([{ State: "stopped", LastUp: "old" }, { State: "running", LastUp: "2026-09-25T23:11:22-05:00" }]) });
  assert.equal(podmanVmStartedAt({ run, platform: "darwin" }), "2026-09-25T23:11:22-05:00");
  assert.equal(podmanVmStartedAt({ run, platform: "linux" }), null);
  assert.equal(podmanVmStartedAt({ run: () => ({ stdout: "garbage" }), platform: "darwin" }), null);
});

test("vmRestartIssue: a restart or a stop mid-job is named; the same reading, or none before, isn't", () => {
  assert.equal(vmRestartIssue("t1", "t1"), null);
  assert.equal(vmRestartIssue(null, "t2"), null);
  assert.match(vmRestartIssue("t1", "t2"), /restarted during this job/);
  assert.match(vmRestartIssue("t1", null), /stopped during this job/);
});

test("admission refuses every job when the wired Podman check fails, and is silent when it passes", async (t) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".podman-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const budgets = deriveBudgets({ env: {} });
  let problem = "Podman isn't answering (down), so no job was sent.";
  const runtime = createJobRuntime({ env: { NOMARMY_EXECUTION: "hosted" }, projectDir: root, stateRoot: root, jobsRoot: root, leasesRoot: path.join(root, "leases"),
    budgetState: { hardwareSnapshot: null, contextInfo: { slots: 1 }, budgets, refresh: async () => {} },
    currentMaxWorkers: () => 1, budgetsForJob: () => budgets, subscriptionJobFieldProblems: () => [], repoPolicy: () => ({}), modelCatalogReady: async () => {},
    agentsConfig: () => ({ agents: {} }), projectDirProblem: () => null, sandboxProblem: () => problem });
  assert.ok((await runtime.admit([{ task: "t", mode: "scout" }])).problems.includes(problem));
  problem = null;
  assert.deepEqual((await runtime.admit([{ task: "t", mode: "scout" }])).problems, []);
});
