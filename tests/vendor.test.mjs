import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { vendorOf } from "../lib/vendor.mjs";
import { generalIdentity, generalOverlap } from "../lib/army.mjs";
import { independentlyReviewedByJudge, highStakesNote, HIGH_STAKES_NOTE } from "../lib/outcome.mjs";
import { reviewOf, computeSuggestions, recentSuggestions } from "../lib/suggestions.mjs";
import { computeStats } from "../lib/stats.mjs";
import { judgeAgentChoices, chooseJudgeAgent } from "../lib/validators.mjs";
import { agentProviderId } from "../lib/agents.mjs";
import { createExecutor } from "../lib/execute.mjs";
import { plantWorktreePointer } from "./helpers/worktree-fixture.mjs";

const agents = {
  general: { kind: "subscription", provider: "claude-cli", owner: "me", model: "claude-sonnet-5-5" },
  api: { kind: "api", provider: "anthropic", model: "claude-opus-5" },
  codex: { kind: "api", provider: "openai", model: "gpt-6" },
  grok: { kind: "api", provider: "xai", model: "grok-4" },
};
const judge = (provider = "claude-cli", model = "claude-sonnet-5-5") => ({ agent: "claude", provider, model, answer: {} });
const job = (extra = {}) => ({ jobId: "work", mode: "implement", stakes: "high", projectDir: "/r", startedAt: new Date().toISOString(),
  outcome: "WORKER_DONE", commit: { created: true }, worker: { provider: "openai", model: "gpt-6" }, validators: { judge: judge() }, ...extra });
const scout = (provider = "claude-cli", model = "claude-sonnet-5-5") => ({ jobId: "review", reviews: "work", mode: "scout", outcome: "SCOUT_DONE", worker: { provider, model } });

test("vendorOf maps fixed providers, hosted models and unknown fallback", () => {
  for (const [provider, expected] of [
    ["claude-cli", "anthropic"], ["anthropic", "anthropic"], ["openai", "openai"], ["azure-openai", "openai"],
    ["xai", "xai"], ["muse-cli", "meta"], ["gemini-cli", "google"], ["google", "google"],
    ["llama-cpp", "local"], [null, "local"], [undefined, "local"], ["", "local"],
  ]) assert.equal(vendorOf(provider, "qwen-3"), expected, String(provider));
  for (const provider of ["bedrock", "deepinfra", "openai-compatible", "custom-openclaw", "unknown"]) {
    for (const [model, expected] of [
      ["anthropic.claude-sonnet-5-5", "anthropic"], ["anthropic/sonnet", "anthropic"], ["GPT-6", "openai"],
      ["o3", "openai"], ["o4-mini", "openai"], ["vendor/o5", "openai"], ["openai/custom", "openai"],
      ["grok-4", "xai"], ["meta-llama/Llama-4", "meta"], ["muse-spark", "meta"], ["gemini-3", "google"],
      ["Qwen/Qwen3", "alibaba"], ["mistral-large", "mistral"], ["mixtral-8x7b", "mistral"], ["codestral", "mistral"],
      ["DeepSeek-V3", "deepseek"], ["unrecognized", provider], [null, provider], ["foo2", provider],
    ]) assert.equal(vendorOf(provider, model), expected, `${provider}/${model}`);
  }
});

test("judge independence excludes both worker and recorded General vendor", () => {
  const record = job({ general: { agent: "general", vendor: "anthropic" } });
  const options = { record, workerModel: "gpt-6", generalVendor: "xai" };
  assert.equal(independentlyReviewedByJudge(judge(), "openai", options), false);
  assert.equal(independentlyReviewedByJudge(judge("xai", "grok-4"), "openai", options), true);
  assert.equal(independentlyReviewedByJudge(judge("anthropic"), "claude-cli"), false);
  assert.equal(independentlyReviewedByJudge(judge("bedrock"), "deepinfra", { workerModel: "anthropic/claude" }), false);
  assert.equal(independentlyReviewedByJudge(judge("azure-openai", "gpt-6"), "openai"), false);
  for (const invalid of [{ provider: null }, { answer: null }, { error: "failed" }, { skipped: true }]) {
    assert.equal(independentlyReviewedByJudge({ ...judge("xai", "grok-4"), ...invalid }, "openai", options), false);
  }
});

test("judge independence uses current General only for legacy records", () => {
  assert.equal(independentlyReviewedByJudge(judge(), "openai", { generalVendor: "anthropic" }), false);
  assert.equal(independentlyReviewedByJudge(judge(), "openai", { record: { general: null }, generalVendor: "anthropic" }), true);
  assert.equal(independentlyReviewedByJudge(judge(), "openai"), true);
});

test("high-stakes notes explain rejection by the General's vendor for recorded and legacy jobs", () => {
  const expected = "HIGH STAKES: judged by claude/claude-sonnet-5-5, the General's own vendor (anthropic), so not independent: review with a scout on another vendor.";
  assert.equal(highStakesNote(judge(), "openai", { record: { general: { vendor: "anthropic" } }, generalVendor: "xai" }), expected);
  assert.equal(highStakesNote(judge(), "openai", { generalVendor: "anthropic" }), expected);
  assert.equal(highStakesNote(judge("xai", "grok-4"), "openai", { generalVendor: "anthropic" }), "HIGH STAKES: independently reviewed by judge claude/grok-4. Still needs the General's acceptance.");
  assert.equal(highStakesNote({ ...judge(), error: "failed" }, "openai", { generalVendor: "anthropic" }), HIGH_STAKES_NOTE);
  assert.equal(highStakesNote(judge(), "anthropic", { generalVendor: "anthropic" }), HIGH_STAKES_NOTE);
});

test("reviewOf rejects General-vendor judges and scouts using recorded or current identity", () => {
  for (const extra of [{ general: { agent: "general", vendor: "anthropic" } }, {}]) {
    const work = job(extra);
    assert.equal(reviewOf(work, [scout()], "anthropic"), null);
    assert.deepEqual(reviewOf(work, [scout("xai", "grok-4")], "anthropic"), { by: "scout", jobId: "review", provider: "xai" });
    assert.deepEqual(reviewOf({ ...work, validators: { judge: judge("xai", "grok-4") } }, [], "anthropic"), { by: "judge", provider: "xai" });
    assert.equal(reviewOf(work, [{ ...scout("xai"), outcome: "WORKER_TIMEOUT" }], "anthropic"), null);
    assert.equal(reviewOf(work, [scout(null)], "anthropic"), null);
  }
  assert.equal(reviewOf(job({ worker: { provider: "anthropic" } }), [scout()]), null);
  assert.deepEqual(reviewOf(job({ general: null }), [], "anthropic"), { by: "judge", provider: "claude-cli" });
  assert.deepEqual(reviewOf(job({ general: { vendor: "xai" } }), [], "anthropic"), { by: "judge", provider: "claude-cli" });
});

test("stats and suggestions pass the current General vendor into legacy review accounting", () => {
  const work = job();
  assert.deepEqual(computeStats([work], { generalVendor: "anthropic" }).highStakes, { jobs: 1, reviewed: 0 });
  assert.deepEqual(computeStats([work], { generalVendor: () => "anthropic" }).highStakes, { jobs: 1, reviewed: 0 });
  const list = computeSuggestions([work], { generalVendor: "anthropic" });
  assert.deepEqual(list.map((s) => s.key), ["unreviewed:work"]);
  assert.deepEqual(Object.keys(list[0]).sort(), ["command", "evidence", "key", "level", "title"]);
  assert.deepEqual(recentSuggestions([work], { projectDir: "/r", generalVendor: "anthropic" }).map((s) => s.key), ["unreviewed:work"]);
  const independent = job({ validators: { judge: judge("xai", "grok-4") } });
  assert.deepEqual(computeStats([independent], { generalVendor: "anthropic" }).highStakes, { jobs: 1, reviewed: 1 });
  assert.deepEqual(computeSuggestions([independent], { generalVendor: "anthropic" }), []);
});

test("generalOverlap flags review agents on the General's vendor while preserving existing messages", () => {
  const army = { general: "general", roles: {
    same: { agent: "general", phase: "review" }, login: { agent: "other", phase: "review" },
    review: { agent: "api", phase: "review" }, build: { agent: "api", phase: "build" }, third: { agent: "grok", phase: "review" },
  } };
  assert.deepEqual(generalOverlap(army, { ...agents, other: { ...agents.general } }), {
    same: 'runs on the General\'s own agent "general": its work isn\'t independently reviewed, and it shares the General\'s usage',
    login: "shares the General's claude-cli login (me), so it draws from the same usage limit",
    review: "shares the General's vendor (anthropic); its reviews aren't independent of the General",
  });
});

test("judge choices sort and label the General's vendor as non-independent", async () => {
  const result = judgeAgentChoices({ agents, roles: { builder: { phase: "build", agent: "codex" } }, providerOf: agentProviderId,
    runsOnHost: () => false, generalVendor: "anthropic" });
  assert.deepEqual(result.choices.map((c) => c.name), ["grok", "api", "codex", "general"]);
  assert.equal(result.dominantBuilderVendor, "openai");
  assert.deepEqual(result.choices[1], { name: "api", agent: agents.api, vendor: "anthropic", hostTools: false, sharesBuilderVendor: false, sharesGeneralVendor: true });
  const lines = [];
  await chooseJudgeAgent({ choices: result.choices, ask: async () => "1", write: (line) => lines.push(line) });
  assert.deepEqual(lines, ["Configured judge agents:", "  1. grok (independent of your builders)",
    "  2. api (shares the General's vendor; verdicts are not independent)",
    "  3. codex (same vendor as builders; verdicts are not independent)",
    "  4. general (shares the General's vendor; verdicts are not independent)"]);
});

test("dispatch records snapshot the configured General agent and vendor, or null", async (t) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".vendor-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const army = { general: "general", roles: {} };
  assert.deepEqual(generalIdentity(army, agents), { agent: "general", vendor: "anthropic" });
  assert.equal(generalIdentity({ roles: {} }, agents), null);
  assert.deepEqual(generalIdentity({ general: "api" }, { api: { kind: "api", provider: "bedrock", model: "anthropic/claude" } }), { agent: "api", vendor: "anthropic" });
  let snapshot = generalIdentity(army, agents);
  const executor = createExecutor({ VERSION: "test", projectDir: root, jobsRoot: root,
    generalIdentity: () => snapshot, assertRepo: async () => {}, ensureJobsRoot: () => {},
    resolveBase: async () => ({ ref: "base", sha: "base" }), collectGitRecord: async () => ({}),
    runIndependentVerification: async () => { snapshot = { agent: "grok", vendor: "xai" }; return { status: "pass" }; },
    run: async (_cmd, args) => {
      if (args[1] === "add") { fs.mkdirSync(args[3]); plantWorktreePointer(args[3], root); }
      else fs.rmSync(args[3], { recursive: true });
    },
  });
  for (const [id, general] of [["configured", generalIdentity(army, agents)], ["none", null]]) {
    snapshot = general;
    const result = await executor.executeJob({ mode: "verify", task: "test", verification: "quick", jobId: id });
    assert.deepEqual(result.manifest.general, general);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, id, "metadata.json"))).general, general);
  }
});

test("generalVendorResolver loads config once per project and treats unreadable config as no General", async () => {
  const { generalVendorResolver } = await import("../lib/army.mjs");
  let armyLoads = 0, agentLoads = 0;
  const resolve = generalVendorResolver({
    loadArmyFor: (dir) => { armyLoads++; if (dir === "/broken") throw new Error("bad yaml"); return { general: "claude" }; },
    loadAgents: () => { agentLoads++; return { claude: { kind: "subscription", provider: "claude-cli", owner: "me" } }; },
    defaultProjectDir: "/repo",
  });
  for (let i = 0; i < 1000; i++) assert.equal(resolve({ projectDir: "/repo" }), "anthropic");
  assert.equal(resolve({}), "anthropic");
  assert.equal(resolve({ projectDir: "/broken" }), null);
  assert.equal(armyLoads, 2);
  assert.equal(agentLoads, 1);
});
