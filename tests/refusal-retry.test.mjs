import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJobRuntime } from "../lib/admission.mjs";
import { deriveBudgets } from "../lib/budget.mjs";
import { modelRefusals, recordModelRefusal, REFUSAL_RETRY_MS } from "../lib/health.mjs";
import { retryRefusedModelsInBackground } from "../lib/refusal-retry.mjs";

const key = "openai/gpt-6-sol";
const refusalMessage = "model_not_found: openai/gpt-6-sol was refused on an earlier job and hasn't worked since, so this job wasn't sent. Use another model or re-test with nomarmy army assign.";
const then = Date.parse("2026-09-28T12:00:00.000Z");
const job = { task: "test", mode: "scout", agentName: "codex", model: "gpt-6-sol", subscription_worker: "codex", on_behalf_of: "me@example.com" };
function rootFor(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-refusal-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function runtime(root, probeModel, now) {
  const budgets = deriveBudgets({ env: {} });
  return createJobRuntime({ env: { NOMARMY_EXECUTION: "hosted" }, projectDir: root, stateRoot: root,
    jobsRoot: path.join(root, "jobs"), leasesRoot: path.join(root, "leases"),
    budgetState: { hardwareSnapshot: null, contextInfo: { slots: 1 }, budgets, refresh: async () => {} },
    currentMaxWorkers: () => 1, budgetsForJob: () => budgets, subscriptionJobFieldProblems: () => [],
    repoPolicy: () => ({}), modelCatalogReady: async () => {},
    agentsConfig: () => ({ agents: { codex: { kind: "subscription", provider: "openai", owner: "me@example.com" } } }),
    resolveSubscriptionSelection: () => ({}), projectDirProblem: () => null, sandboxProblem: () => null,
    probeModel, now: () => now });
}

test("fresh refusal is refused without probing", async (t) => {
  const root = rootFor(t);
  recordModelRefusal(root, key, "old reason", { now: then });
  const result = await runtime(root, async () => { throw new Error("must not probe"); }, then + REFUSAL_RETRY_MS - 1).admit([job]);
  assert.deepEqual(Object.keys(result).sort(), ["admission", "problems"]);
  assert.deepEqual(result.problems, [refusalMessage]);
  assert.deepEqual(modelRefusals(root)[key], { at: new Date(then).toISOString(), reason: "old reason" });
});

test("old refusal is probed, admitted on success, and cleared", async (t) => {
  const root = rootFor(t), now = then + REFUSAL_RETRY_MS;
  recordModelRefusal(root, key, "old reason", { now: then });
  const calls = [];
  const result = await runtime(root, async (args) => { calls.push(args); return { ok: true, refused: false, reason: null }; }, now).admit([job]);
  assert.deepEqual(Object.keys(result).sort(), ["admission", "problems"]);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(calls, [{ provider: "openai", model: "gpt-6-sol", stateRoot: root }]);
  assert.deepEqual(modelRefusals(root), {});
});

test("refused again resets refusal time and refuses", async (t) => {
  const root = rootFor(t), now = then + REFUSAL_RETRY_MS;
  recordModelRefusal(root, key, "old reason", { now: then });
  const result = await runtime(root, async () => ({ ok: false, refused: true, reason: "still unavailable" }), now).admit([job]);
  assert.deepEqual(Object.keys(result).sort(), ["admission", "problems"]);
  assert.deepEqual(result.problems, [refusalMessage]);
  assert.deepEqual(modelRefusals(root)[key], { at: new Date(now).toISOString(), reason: "still unavailable" });
});

test("inconclusive retry keeps original refusal time and throttles another attempt", async (t) => {
  const root = rootFor(t), now = then + REFUSAL_RETRY_MS;
  recordModelRefusal(root, key, "old reason", { now: then });
  let calls = 0;
  const admit = runtime(root, async () => { calls++; return { ok: false, refused: false, reason: "timeout" }; }, now);
  assert.equal((await admit.admit([job])).problems.length, 1);
  assert.equal((await admit.admit([job])).problems.length, 1);
  assert.equal(calls, 1);
  assert.deepEqual(modelRefusals(root)[key], { at: new Date(then).toISOString(), reason: "old reason", retriedAt: new Date(now).toISOString() });
});

test("army retry starts once per day without waiting for probe completion", async (t) => {
  const root = rootFor(t), now = then + REFUSAL_RETRY_MS;
  recordModelRefusal(root, key, "old reason", { now: then });
  let calls = 0, finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const probeModel = async () => { calls++; return pending; };
  retryRefusedModelsInBackground(root, { probeModel, now });
  retryRefusedModelsInBackground(root, { probeModel, now });
  assert.deepEqual(modelRefusals(root)[key], { at: new Date(then).toISOString(), reason: "old reason", retriedAt: new Date(now).toISOString() });
  await Promise.resolve();
  assert.equal(calls, 1);
  retryRefusedModelsInBackground(root, { probeModel, now: now + REFUSAL_RETRY_MS - 1 });
  await Promise.resolve();
  assert.equal(calls, 1);
  finish({ ok: true, refused: false, reason: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(modelRefusals(root), {});
});
