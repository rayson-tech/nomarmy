import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";

import { deriveBudgets } from "../lib/budget.mjs";
import { createJobBudgets } from "../lib/job-budgets.mjs";
import { expandJobs } from "../mcp/server.mjs";

const agents = {
  local: { kind: "local", slot: "coder" },
  api: { kind: "api", provider: "xai", model: "frontier-model", auth_env: "API_KEY", context_window: 128000 },
  sub: { kind: "subscription", provider: "openai", model: "frontier-model", owner: "owner@example.com", context_window: 128000 },
};

const budgetState = {
  budgets: deriveBudgets({ contextPerNom: 65536, tier: "local" }),
  contextInfo: { contextPerNom: 65536 },
};
const jobBudgets = createJobBudgets({
  budgetState,
  dispatchConfig: () => ({ found: true, config: { pools: { api: [{ id: "api", provider: "xai", model: "frontier-model", weight: 1, context_window: 128000 }] } } }),
  subscriptionConfig: () => ({ found: true, config: { workers: { sub: { provider: "openai", model: "frontier-model", owner: "owner@example.com", context_window: 128000 } } } }),
  modelCatalog: () => new Map(),
});

const expand = (job) => expandJobs([job], { getAgents: () => agents, getActiveRun: () => null }).jobs[0];

test("frontier scouts default to full reports while explicit, local, and implement report sizes are unchanged", () => {
  const apiScout = expand({ task: "research", mode: "scout", agent: "api" });
  const subscriptionScout = expand({ task: "research", mode: "scout", agent: "sub", on_behalf_of: "owner@example.com" });
  const explicitScout = expand({ task: "research", mode: "scout", agent: "api", report: "brief" });
  const localScout = expand({ task: "research", mode: "scout" });
  const apiImplement = expand({ task: "build", mode: "implement", agent: "api" });

  assert.deepEqual([apiScout.report, subscriptionScout.report, explicitScout.report, localScout.report, apiImplement.report], ["full", "full", "brief", undefined, undefined]);
  assert.deepEqual([
    jobBudgets.budgetsForJob(apiScout).reportSize,
    jobBudgets.budgetsForJob(subscriptionScout).reportSize,
    jobBudgets.budgetsForJob(explicitScout).reportSize,
    jobBudgets.budgetsForJob(localScout).reportSize,
    jobBudgets.budgetsForJob(apiImplement).reportSize,
  ], ["full", "full", "brief", "standard", "standard"]);
});
