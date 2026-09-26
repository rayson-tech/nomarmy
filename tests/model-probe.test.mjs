import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { probeModel } from "../lib/model-probe.mjs";

function stateRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// A fake exec: records calls, answers the OpenClaw call with `reply`, and
// plants a sandbox workspace so the reaper has a container to remove.
function fakeExec(reply) {
  const calls = [];
  const exec = async (file, args, opts) => {
    calls.push([file, ...args]);
    if (file === "openclaw") {
      const stateDir = args[args.indexOf("--state-dir") + 1];
      fs.mkdirSync(path.join(stateDir, "sandbox", "skills-workspaces", "workspace-0123456789abcdef"), { recursive: true });
      return { error: null, stdout: "", stderr: "", ...reply };
    }
    if (args[0] === "ps") return { error: null, stdout: "openclaw-sbx-0123456789abcdef\n", stderr: "" };
    return { error: null, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("probeModel: an answer is ok, on the job's route, and the sandbox it left is removed", async (t) => {
  const root = stateRoot(t);
  const { exec, calls } = fakeExec({ stdout: JSON.stringify({ ok: true, status: "ok", final: "ok" }) });
  const r = await probeModel({ provider: "openai", model: "gpt-6-astra", stateRoot: root, openclawCmd: "openclaw", exec });
  assert.deepEqual(r, { ok: true, refused: false, reason: null });
  const call = calls.find((c) => c[0] === "openclaw");
  assert.ok(call.includes("openai/gpt-6-astra") && call.includes("--no-auth-env-only") && !call.includes("--isolated"));
  assert.ok(calls.some((c) => c[0] === "podman" && c[1] === "rm" && c.includes("openclaw-sbx-0123456789abcdef")));
  assert.deepEqual(fs.readdirSync(root), [], "its scratch dir is gone");
});

test("probeModel: a vendor refusal is refused, with the vendor's reason", async (t) => {
  const { exec } = fakeExec({ stderr: "FailoverError: The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account." });
  const r = await probeModel({ provider: "openai", model: "gpt-6-sol", stateRoot: stateRoot(t), openclawCmd: "openclaw", exec });
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.reason, /not supported/);
});

test("probeModel: a timeout is inconclusive, not a refusal", async (t) => {
  const { exec } = fakeExec({ error: Object.assign(new Error("timed out"), { killed: true }) });
  const r = await probeModel({ provider: "openai", model: "gpt-6-astra", stateRoot: stateRoot(t), openclawCmd: "openclaw", exec });
  assert.deepEqual(r, { ok: false, refused: false, reason: "the test call timed out" });
});

import { createJobRuntime } from "../lib/admission.mjs";
import { deriveBudgets } from "../lib/budget.mjs";
import { modelProven, modelRefusals, recordProbeSuccess } from "../lib/health.mjs";

function runtimeWith(t, probeModel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-probe-admit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const budgets = deriveBudgets({ env: {} });
  const runtime = createJobRuntime({ env: { NOMARMY_EXECUTION: "hosted" }, projectDir: root, stateRoot: root, jobsRoot: path.join(root, "jobs"), leasesRoot: path.join(root, "leases"),
    budgetState: { hardwareSnapshot: null, contextInfo: { slots: 1 }, budgets, refresh: async () => {} },
    currentMaxWorkers: () => 1, budgetsForJob: () => budgets, subscriptionJobFieldProblems: () => [], repoPolicy: () => ({}), modelCatalogReady: async () => {},
    agentsConfig: () => ({ agents: { codex: { kind: "subscription", provider: "openai", owner: "me@example.com" } } }),
    resolveSubscriptionSelection: () => ({}), projectDirProblem: () => null, sandboxProblem: () => null, probeModel });
  return { runtime, root };
}
const job = (model) => ({ task: "t", mode: "scout", agentName: "codex", model, subscription_worker: "codex", on_behalf_of: "me@example.com" });

test("admission: a refused test call refuses the job before it starts, and remembers the refusal", async (t) => {
  const probed = [];
  const { runtime, root } = runtimeWith(t, async ({ provider, model }) => { probed.push(`${provider}/${model}`); return { ok: false, refused: true, reason: "not supported with a ChatGPT account" }; });
  const { problems } = await runtime.admit([job("gpt-6-sol"), job("gpt-6-sol")]);
  assert.deepEqual(probed, ["openai/gpt-6-sol"], "one test call per model, not per job");
  assert.equal(problems.filter((p) => /refused a test call before this job was sent \(not supported with a ChatGPT account\)/.test(p)).length, 2);
  assert.ok(modelRefusals(root)["openai/gpt-6-sol"], "the refusal is remembered");
});

test("admission: an answering model is proven once and never probed again; an inconclusive probe lets the job through", async (t) => {
  let calls = 0;
  const { runtime, root } = runtimeWith(t, async () => { calls++; return { ok: true, refused: false, reason: null }; });
  assert.deepEqual((await runtime.admit([job("gpt-6-astra")])).problems, []);
  assert.equal(modelProven(root, "openai/gpt-6-astra"), true);
  await runtime.admit([job("gpt-6-astra")]);
  assert.equal(calls, 1);
  const flaky = runtimeWith(t, async () => ({ ok: false, refused: false, reason: "the test call timed out" }));
  assert.deepEqual((await flaky.runtime.admit([job("gpt-5.6-sol")])).problems, []);
  assert.equal(modelProven(flaky.root, "openai/gpt-5.6-sol"), false);
  // A model proven some other way (army assign, a finished job) is never probed.
  const proven = runtimeWith(t, async () => { throw new Error("must not probe"); });
  recordProbeSuccess(proven.root, "openai/gpt-5.6-terra");
  assert.deepEqual((await proven.runtime.admit([job("gpt-5.6-terra")])).problems, []);
});
