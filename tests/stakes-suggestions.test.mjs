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
  metrics: { worker_provider: "openai", worker_model: "gpt-6-astra", worker_tokens_in: 80_000, worker_tokens_out: 20_000, worker_tokens_cache_read: 900_000, worker_tokens_total: 1_000_000 }, ...over });
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
    ...Array.from({ length: 6 }, (_, i) => impl({ jobId: `b${i}`, labels: { role: "jr-dev" }, metrics: { worker_provider: "openai", worker_model: "gpt-5.6-sol", worker_tokens_in: 25_000, worker_tokens_out: 5_000 } })),
    ...Array.from({ length: 4 }, (_, i) => scout({ jobId: `c${i}`, labels: { role: "pm" }, outcome: i < 2 ? "SCOUT_UNSUPPORTED" : "SCOUT_DONE", metrics: { worker_provider: "xai", worker_model: "grok-4.7", worker_cost_usd: 3 } })),
    impl({ jobId: "h1", stakes: "high", labels: { role: "sr-dev" }, commit: { created: true } }),
    impl({ jobId: "h2", stakes: "high", labels: { role: "ui-ux" }, outcome: "WORKER_PARTIAL" }),
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
  assert.equal(byKey("lighter:"), undefined, "gpt-5.6-sol did jr-dev work: across roles the numbers don't compare");
  assert.match(byKey("spend:grok-4.7").title, /grok-4\.7 is 100% of API spend \(\$12\.00/);
  assert.match(byKey("unreviewed:").title, /1 high-stakes job\(s\) committed without an independent review: h1$/, "an uncommitted partial isn't accepted work");
  assert.equal(list[0].level, "act", "what needs the operator comes first");
  // Too few jobs: no verdict.
  assert.equal(computeSuggestions(records.slice(0, 3)).filter((s) => s.key.startsWith("low-success")).length, 0);
  assert.match(formatSuggestions([]).join("\n"), /nothing in the records suggests a routing change/);
});

test("recentSuggestions uses only this repo's last 14 days, and stats reports high stakes", () => {
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  const records = [impl({ jobId: "h1", stakes: "high", startedAt: old }), impl({ jobId: "h2", stakes: "high", projectDir: "/other" })];
  assert.equal(recentSuggestions(records, { projectDir: "/r" }).length, 0, "the old one is out of the window, the other repo's isn't ours");
  const s = computeStats([impl({ jobId: "h3", stakes: "high", commit: { created: true } }), scout({ jobId: "s3", reviews: "h3" })], { repo: "/r" });
  assert.deepEqual(s.highStakes, { jobs: 1, reviewed: 1 });
  // From Senti: a review scout that timed out was counted as a review.
  const failedReview = computeStats([impl({ jobId: "h4", stakes: "high", commit: { created: true } }), scout({ jobId: "s4", reviews: "h4", outcome: "WORKER_FAILED" })], { repo: "/r" });
  assert.deepEqual(failedReview.highStakes, { jobs: 1, reviewed: 0 });
  assert.equal(agentLookup({ codex: { provider: "openai" }, grok: { provider: "xai" }, other: { provider: "openai" } }, (a) => a.provider)("xai"), "grok");
  assert.equal(agentLookup({ codex: { provider: "openai" }, other: { provider: "openai" } }, (a) => a.provider)("openai"), null, "ambiguous: name no agent");
});

test("runner failures are reported apart and left out of the model's rate", () => {
  const failed = (i) => scout({ jobId: `f${i}`, metrics: { worker_provider: "llama-cpp", worker_model: "qwen3.6-27b" }, outcome: "WORKER_FAILED", issues: ["scout process failed", "scout error: Error: openclaw exited 2"] });
  const list = computeSuggestions([0, 1, 2].map(failed).concat(scout({ jobId: "t1", metrics: { worker_provider: "llama-cpp", worker_model: "qwen3.6-27b" }, outcome: "WORKER_TIMEOUT" })));
  assert.equal(list.length, 1);
  assert.match(list[0].title, /scouts with no role on qwen3\.6-27b: the runner failed on 3 of 4 scouts before any report/);
  assert.match(list[0].evidence, /say nothing about the model's work/);
  // With enough rated jobs, the rate excludes the runner failures and says so.
  const rated = Array.from({ length: 5 }, (_, i) => impl({ jobId: `r${i}`, labels: { role: "sr-dev" }, outcome: i < 2 ? "WORKER_DONE" : "WORKER_PARTIAL" }));
  const crashes = Array.from({ length: 2 }, (_, i) => impl({ jobId: `x${i}`, labels: { role: "sr-dev" }, outcome: "WORKER_FAILED", issues: ["worker process failed"] }));
  const low = computeSuggestions([...rated, ...crashes]).find((s) => s.key.startsWith("low-success"));
  assert.match(low.title, /finished 2 of 5 implement jobs \(40%\) \(plus 2 the runner failed on, not counted\)/);
});

test("a lighter model is suggested only within one role, on new tokens, with a command that reaches it", () => {
  const heavy = Array.from({ length: 5 }, (_, i) => impl({ jobId: `h${i}`, labels: { role: "jr-dev", agent: "codex" } }));
  const light = Array.from({ length: 5 }, (_, i) => impl({ jobId: `l${i}`, labels: { role: "jr-dev", agent: "codex" },
    metrics: { worker_provider: "openai", worker_model: "gpt-5.6-sol", worker_tokens_in: 20_000, worker_tokens_out: 5_000, worker_tokens_cache_read: 5_000_000 } }));
  const s = computeSuggestions([...heavy, ...light]).find((x) => x.key.startsWith("lighter:"));
  assert.match(s.title, /jr-dev: gpt-5\.6-sol finished 100% of its jobs on 25k new tokens a job; gpt-6-astra finished 100% on 100k/);
  assert.equal(s.command, "nomarmy army assign jr-dev codex gpt-5.6-sol");
  // A local model is reached through the local agent, which takes no model.
  const local = light.map((r) => ({ ...r, labels: { role: "jr-dev" }, metrics: { ...r.metrics, worker_provider: "llama-cpp", worker_model: "gpt-oss-20b" } }));
  const l = computeSuggestions([...heavy, ...local]).find((x) => x.key.startsWith("lighter:"));
  assert.equal(l.command, "nomarmy army assign jr-dev local");
  assert.match(l.evidence, /runs whichever model is loaded; these ran on gpt-oss-20b/);
  // Jobs with no token counts can't be compared.
  const untracked = local.map((r) => ({ ...r, metrics: { worker_provider: "llama-cpp", worker_model: "gpt-oss-20b" } }));
  assert.equal(computeSuggestions([...heavy, ...untracked]).filter((x) => x.key.startsWith("lighter:")).length, 0);
});

test("stats: a done claim with nothing changed has its own row, and untracked tokens are counted", () => {
  const empty = impl({ jobId: "e1", reportValidation: { status: "done", tests: "pass" }, independentVerification: { status: "not_run", basis: "not-applicable" }, metrics: {} });
  const s = computeStats([empty], { repo: "/r" });
  assert.equal(s.claimVsEvidence.changedNothing, 1);
  assert.equal(s.tokens.untracked, 1);
});

test("suggestions about pairings not used lately are counted, not listed", () => {
  const old = new Date(Date.now() - 6 * 86400000).toISOString();
  const stale = Array.from({ length: 6 }, (_, i) => impl({ jobId: `o${i}`, startedAt: old, labels: { role: "sr-dev" }, outcome: "WORKER_TIMEOUT" }));
  const list = computeSuggestions(stale);
  assert.equal(list.filter((s) => s.key.startsWith("low-success")).length, 0);
  assert.match(list.find((s) => s.key === "stale").title, /^2 more about role and model pairings you haven't used in 3 days/);
  assert.ok(computeSuggestions(stale, { includeStale: true }).some((s) => s.key.startsWith("low-success")));
});

import { formatStatsSummary } from "../lib/stats.mjs";

test("the default stats view leads with what was caught and what needs review, on one screen", () => {
  const done = (over) => impl({ reportValidation: { status: "done", tests: "pass" }, independentVerification: { status: "pass" }, regressionCheck: { status: "pass" }, commit: { created: true }, ...over });
  const records = [
    ...Array.from({ length: 6 }, (_, i) => done({ jobId: `d${i}`, testChanges: { new_tests_added: ["t.test.js"], existing_tests_modified: [], existing_tests_deleted: [], production_files_changed: [] } })),
    done({ jobId: "f1", independentVerification: { status: "fail" } }),
    done({ jobId: "r1", regressionCheck: { status: "fail" } }),
    done({ jobId: "h1", stakes: "high" }),
  ];
  const text = formatStatsSummary(computeStats(records, { repo: "/r" }));
  const lines = text.split("\n");
  assert.match(lines[2], /^CAUGHT +█+░+  7 of 9 "done, tests pass" claims held up · 2 didn't$/);
  assert.match(text, /1 failed when nomArmy ran the tests itself · 1 had tests that pass with the change reverted/);
  assert.match(text, /PROVEN +✓ 6 new test files fail without their change/);
  assert.match(text, /⚠ REVIEW BEFORE MERGING  1 high-stakes job\(s\) committed without an independent review\n   h1\n/);
  assert.match(text, /nomarmy stats --details/);
  assert.ok(lines.length < 30, "one screen");
});

test("the General's stats tool defaults to the one-screen summary", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../mcp/server.mjs", import.meta.url), "utf8");
  assert.match(src, /details \? formatStats\(stats\) : formatStatsSummary\(stats\)/);
});
