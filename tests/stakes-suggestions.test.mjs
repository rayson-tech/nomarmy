import assert from "node:assert/strict";
import test from "node:test";

import { policyAdmissionProblems, HIGH_STAKES_NOTE } from "../lib/outcome.mjs";
import { computeSuggestions, reviewOf, recentSuggestions, formatSuggestions } from "../lib/suggestions.mjs";
import { computeStats, agentLookup } from "../lib/stats.mjs";

test("stakes: high needs a verification profile and keeps the revert check, whatever the repo's policy", () => {
  assert.deepEqual(policyAdmissionProblems({ mode: "implement", stakes: "high", verification: "quick" }, {}), []);
  assert.match(policyAdmissionProblems({ mode: "implement", stakes: "high" }, {})[0], /stakes: high job needs a `verification` profile/);
  assert.match(policyAdmissionProblems({ mode: "implement", stakes: "high", verification: "quick", verify_regression: false }, {})[0], /can't turn the revert check off/);
  assert.deepEqual(policyAdmissionProblems({ mode: "implement", verification: "quick", verify_regression: false }, {}), [], "normal stakes: the General's call");
  assert.match(HIGH_STAKES_NOTE, /independent review.*reviews: <this job id>/);
});

const impl = (over) => ({ mode: "implement", projectDir: "/r", startedAt: new Date().toISOString(), outcome: "WORKER_DONE", issues: [],
  metrics: { worker_provider: "openai", worker_model: "gpt-6-astra", worker_tokens_total: 1_000_000 }, ...over });
const scout = (over) => ({ mode: "scout", projectDir: "/r", startedAt: new Date().toISOString(), outcome: "SCOUT_DONE", issues: [], metrics: { worker_provider: "xai", worker_model: "grok-4.7" }, ...over });

test("reviewOf: a scout or judge on another vendor counts; the same vendor doesn't", () => {
  const job = impl({ jobId: "w1", stakes: "high" });
  assert.equal(reviewOf(job, [job]), null);
  assert.deepEqual(reviewOf(job, [job, scout({ jobId: "s1", reviews: "w1" })]), { by: "scout", jobId: "s1", provider: "xai" });
  assert.equal(reviewOf(job, [job, scout({ jobId: "s2", reviews: "w1", metrics: { worker_provider: "openai", worker_model: "gpt-5.6-sol" } })]), null, "same vendor reviewing itself");
  assert.equal(reviewOf({ ...job, validators: { judge: { provider: "claude-cli", answer: {} } } }, [job]).by, "judge");
  assert.equal(reviewOf({ ...job, validators: { judge: { provider: "openai", answer: {} } } }, [job]), null);
});

test("computeSuggestions: a failing pairing, empty scouts, a lighter model, spend and unreviewed high stakes", () => {
  const records = [
    ...Array.from({ length: 6 }, (_, i) => impl({ jobId: `a${i}`, labels: { role: "sr-dev" }, outcome: i < 2 ? "WORKER_DONE" : "WORKER_TIMEOUT" })),
    ...Array.from({ length: 6 }, (_, i) => impl({ jobId: `b${i}`, labels: { role: "jr-dev" }, metrics: { worker_provider: "openai", worker_model: "gpt-5.6-sol", worker_tokens_total: 300_000 } })),
    ...Array.from({ length: 4 }, (_, i) => scout({ jobId: `c${i}`, labels: { role: "pm" }, outcome: i < 2 ? "SCOUT_UNSUPPORTED" : "SCOUT_DONE", metrics: { worker_provider: "xai", worker_model: "grok-4.7", worker_cost_usd: 3 } })),
    impl({ jobId: "h1", stakes: "high", labels: { role: "sr-dev" } }),
  ];
  const list = computeSuggestions(records, { agentFor: (p) => ({ openai: "codex", xai: "grok" })[p] ?? null });
  const byKey = (prefix) => list.find((s) => s.key.startsWith(prefix));
  const low = byKey("low-success:sr-dev:gpt-6-astra");
  assert.equal(low.level, "warn");
  assert.match(low.title, /sr-dev on gpt-6-astra finished 3 of 7 implement jobs \(43%\)/);
  assert.match(low.evidence, /gpt-5\.6-sol finished 100% of its 6 implement jobs here \(as jr-dev\)/);
  assert.equal(low.command, "nomarmy army assign sr-dev codex gpt-5.6-sol");
  assert.match(byKey("timeouts:sr-dev").title, /timed out on 4 of 7/);
  assert.equal(byKey("scout-unsupported:pm").command, "nomarmy army assign pm grok <another model>");
  assert.match(byKey("lighter:sr-dev:gpt-6-astra:gpt-5.6-sol").command, /army assign sr-dev codex auto/);
  assert.match(byKey("spend:grok-4.7").title, /grok-4\.7 is 100% of API spend \(\$12\.00/);
  assert.match(byKey("unreviewed:").title, /1 high-stakes job\(s\) without an independent review: h1/);
  // Too few jobs: no verdict.
  assert.equal(computeSuggestions(records.slice(0, 3)).filter((s) => s.key.startsWith("low-success")).length, 0);
  assert.match(formatSuggestions([]).join("\n"), /nothing in the records suggests a routing change/);
});

test("recentSuggestions uses only this repo's last 14 days, and stats reports high stakes", () => {
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const records = [impl({ jobId: "h1", stakes: "high", startedAt: old }), impl({ jobId: "h2", stakes: "high", projectDir: "/other" })];
  assert.equal(recentSuggestions(records, { projectDir: "/r" }).length, 0, "the old one is out of the window, the other repo's isn't ours");
  const s = computeStats([impl({ jobId: "h3", stakes: "high" }), scout({ jobId: "s3", reviews: "h3" })], { repo: "/r" });
  assert.deepEqual(s.highStakes, { jobs: 1, reviewed: 1 });
  assert.equal(agentLookup({ codex: { provider: "openai" }, grok: { provider: "xai" }, other: { provider: "openai" } }, (a) => a.provider)("xai"), "grok");
  assert.equal(agentLookup({ codex: { provider: "openai" }, other: { provider: "openai" } }, (a) => a.provider)("openai"), null, "ambiguous: name no agent");
});
