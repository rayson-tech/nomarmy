import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deriveWorkerModelEnv } from "../lib/connect.mjs";
import { expandJobs } from "../mcp/server.mjs";
import { createJobRuntime } from "../lib/admission.mjs";
import { createBudgetState } from "../lib/budget-state.mjs";
import { assessAdmission, deriveBudgets } from "../lib/budget.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".mode-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("connect forwards execution and llama address keys only when present", (t) => {
  const root = fixture(t);
  assert.deepEqual(deriveWorkerModelEnv(root), {});
  fs.mkdirSync(path.join(root, "config"));
  const file = path.join(root, "config/common.env");
  fs.writeFileSync(file, 'NOMARMY_WORKER_MODEL=model\nNOMARMY_MODEL_THINKING=false\nUNRELATED=no\n');
  const base = { NOMARMY_WORKER_MODEL: "model", NOMARMY_WORKER_MODEL_THINKING: "false" };
  assert.deepEqual(deriveWorkerModelEnv(root), base);
  fs.appendFileSync(file, 'NOMARMY_EXECUTION=hosted\nNOMARMY_LLAMA_HOST=gpu.internal\nNOMARMY_LLAMA_PORT=9000\n');
  assert.deepEqual(deriveWorkerModelEnv(root), { ...base, NOMARMY_EXECUTION: "hosted", NOMARMY_LLAMA_HOST: "gpu.internal", NOMARMY_LLAMA_PORT: "9000" });
});

test("expandJobs refuses implicit local jobs only in hosted mode", () => {
  const job = { task: "t" };
  const deps = { getActiveRun: () => null, getArmy: () => { throw Error("unexpected army read"); }, getAgents: () => { throw Error("unexpected agents read"); } };
  for (const env of [{}, { NOMARMY_EXECUTION: "local" }, { NOMARMY_LLAMA_HOST: "gpu.internal" }, { NOMARMY_EXECUTION: "bedrock" }]) {
    assert.deepEqual(expandJobs([job], { ...deps, env }), { jobs: [{ task: "t", profile: "coder" }], problems: [] });
  }
  assert.deepEqual(expandJobs([job], { ...deps, env: { NOMARMY_EXECUTION: "hosted" } }), {
    jobs: [job], problems: ["this install has no local model (NOMARMY_EXECUTION=hosted): give the job an army_role or an agent (the army tool lists them)"],
  });
});

test("remote admission ignores machine memory but retains slots and maxWorkers", async (t) => {
  const root = fixture(t);
  const hardware = { memory: { totalBytes: 64 * 1024 ** 3, availableBytes: 1 } };
  const budgets = deriveBudgets({ env: {} });
  const env = { NOMARMY_LLAMA_HOST: "gpu.internal" };
  const budgetState = { hardwareSnapshot: hardware, contextInfo: { slots: 3 }, budgets, refresh: async () => {} };
  let maxWorkers = 2;
  const runtime = createJobRuntime({ env, projectDir: root, stateRoot: root, jobsRoot: root, leasesRoot: path.join(root, "leases"), budgetState,
    currentMaxWorkers: () => maxWorkers, budgetsForJob: () => budgets, subscriptionJobFieldProblems: () => [], repoPolicy: () => ({}),
  });
  for (const host of ["gpu.internal", "localhost"]) {
    env.NOMARMY_LLAMA_HOST = host;
    const expected = assessAdmission({ hardware: host === "localhost" ? hardware : null, runningJobs: 0, slots: 3, maxWorkers: 2 });
    assert.deepEqual(runtime.capacitySnapshot().admission, expected);
    assert.deepEqual(await runtime.admit([{ task: "t" }]), { admission: expected, problems: expected.admit ? [] : expected.reasons.map(r => `not admitted (${expected.level}): ${r}`) });
    assert.equal(expected.admit, host !== "localhost");
  }
  env.NOMARMY_LLAMA_HOST = "gpu.internal";
  maxWorkers = 0;
  const capped = assessAdmission({ hardware: null, runningJobs: 0, slots: 3, maxWorkers: 0 });
  assert.deepEqual(runtime.capacitySnapshot().admission, capped);
  assert.equal((await runtime.admit([{ task: "t" }])).admission.admit, false);
});

test("hosted budget refresh skips llama probing and retains defaults", async (t) => {
  let probes = 0;
  t.mock.method(globalThis, "fetch", async () => { probes++; return { ok: false }; });
  const state = createBudgetState({ env: { NOMARMY_EXECUTION: "hosted" } });
  const before = structuredClone(state.budgets);
  const contextBefore = structuredClone(state.contextInfo);
  assert.deepEqual(await state.refresh(), before);
  assert.deepEqual(state.contextInfo, contextBefore);
  assert.equal(probes, 0);
  await createBudgetState({ env: { NOMARMY_EXECUTION: "local" } }).refresh();
  assert.equal(probes, 1);
});
