import "./helpers/isolate-global-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createJobRuntime } from "../lib/admission.mjs";
import { deriveBudgets } from "../lib/budget.mjs";

test("an implement job naming a verification profile .nomarmy.yml doesn't define is refused before it runs", async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".admission-profile-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, ".nomarmy.yml"), "verification:\n  quick:\n    commands: ['true']\n");
  const budgets = deriveBudgets({ env: {} });
  const runtime = createJobRuntime({ env: { NOMARMY_LLAMA_HOST: "gpu.internal" }, projectDir: root, projectDirProblem: () => null, stateRoot: root, jobsRoot: root,
    leasesRoot: path.join(root, "leases"), budgetState: { hardwareSnapshot: null, contextInfo: { slots: 3 }, budgets, refresh: async () => {} },
    currentMaxWorkers: () => 3, budgetsForJob: () => budgets, subscriptionJobFieldProblems: () => [], repoPolicy: () => ({}) });
  const job = { task: "fix it", mode: "implement", verification: "quick" };
  const refusal = "verification profile 'standard' is not defined in .nomarmy.yml; available profiles: quick";
  assert.ok(!(await runtime.admit([job])).problems.some(p => p.includes("verification profile")));
  assert.ok((await runtime.admit([{ ...job, verification: "standard" }])).problems.includes(refusal));
  assert.ok((await runtime.admit([job, { ...job, verification: "standard" }])).problems.includes(`job 2: ${refusal}`));
  assert.ok(!(await runtime.admit([{ ...job, mode: "scout", verification: "standard" }])).problems.some(p => p.includes("verification profile")), "scouts ignore verification");
});
