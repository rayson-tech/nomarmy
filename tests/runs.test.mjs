import "./helpers/isolate-global-config.mjs";
// Tests for lib/runs.mjs: /feature runs, their limits, and usage-limit
// detection. Run: node --test tests/runs.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { createRun, detectUsageLimit, finishRun, loadRun, recordRunJob, resolveRunLimits, runAdmissionProblems, runTotals, DEFAULT_RUN_LIMITS } from "../lib/runs.mjs";
import { armySchema, loadArmy } from "../lib/army.mjs";

const dirs = [];
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-runs-")); dirs.push(d); return d; }
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const LIMITS = { max_jobs: 4, max_api_usd: 2, max_hours: 6, warn_at: 0.8 };

test("resolveRunLimits: defaults, then the configured limits, which the General can lower but never raise", () => {
  assert.deepEqual(resolveRunLimits(), DEFAULT_RUN_LIMITS);
  assert.equal(resolveRunLimits({ max_api_usd: 5 }).max_api_usd, 5);
  assert.equal(resolveRunLimits({ max_api_usd: 5 }, { max_api_usd: 2 }).max_api_usd, 2, "lowering is fine");
  assert.equal(resolveRunLimits({ max_api_usd: 5 }, { max_api_usd: 50 }).max_api_usd, 5, "raising is ignored");
  assert.equal(resolveRunLimits({}, { max_jobs: -1 }).max_jobs, DEFAULT_RUN_LIMITS.max_jobs);
});

test("createRun/loadRun: a run belongs to a repo, starts running, and has a log path beside it", () => {
  const dir = tmp();
  const run = createRun(dir, { name: "Join partners in schema context!", repo: "/r/senti", limits: LIMITS });
  assert.match(run.id, /^run-join-partners-in-schema-context-[0-9a-f]{6}$/);
  assert.equal(run.status, "running");
  assert.equal(run.logPath, path.join(dir, `${run.id}.md`));
  assert.deepEqual(loadRun(dir, run.id).limits, LIMITS);
  assert.throws(() => loadRun(dir, "run-nope"), /unknown run/);
  assert.throws(() => loadRun(dir, "../../etc/passwd"), /not a run id/);
});

test("runTotals: counts only api spend as dollars, tallies per agent, and warns at 80%", () => {
  const dir = tmp();
  const { id } = createRun(dir, { name: "f", repo: "/r", limits: LIMITS });
  recordRunJob(dir, id, { jobId: "a", agent: "grok", kind: "api", costUsd: 1.1, tokens: 500 });
  recordRunJob(dir, id, { jobId: "b", agent: "codex", kind: "subscription", costUsd: 0.9, tokens: 2000 });
  recordRunJob(dir, id, { jobId: "c", agent: "grok", kind: "api", costUsd: 0.5, tokens: 100 });
  const totals = runTotals(loadRun(dir, id));
  assert.equal(totals.used.max_api_usd, 1.6, "a subscription's API-equivalent figure isn't money spent");
  assert.deepEqual(totals.byAgent.grok, { jobs: 2, apiUsd: 1.6, tokens: 600 });
  assert.equal(totals.byAgent.codex.tokens, 2000);
  assert.ok(totals.warnings.some((w) => /80% of its api spend/.test(w)), totals.warnings.join("; "));
});

test("runAdmissionProblems: refuses at the job, spend and time caps, and once the run is closed", () => {
  const dir = tmp();
  const { id } = createRun(dir, { name: "f", repo: "/r", limits: LIMITS, now: Date.parse("2026-09-24T00:00:00Z") });
  assert.deepEqual(runAdmissionProblems(loadRun(dir, id), { now: Date.parse("2026-09-24T01:00:00Z") }), []);
  assert.match(runAdmissionProblems(loadRun(dir, id), { now: Date.parse("2026-09-24T07:00:00Z") })[0], /run \d+(\.\d+)? of its 6 hours/);
  for (const j of ["a", "b", "c", "d"]) recordRunJob(dir, id, { jobId: j, agent: "local", kind: "local" });
  assert.match(runAdmissionProblems(loadRun(dir, id), { now: Date.parse("2026-09-24T01:00:00Z") })[0], /used all 4 of its jobs/);
  const other = createRun(dir, { name: "g", repo: "/r", limits: LIMITS });
  recordRunJob(dir, other.id, { jobId: "x", agent: "grok", kind: "api", costUsd: 2.5 });
  assert.match(runAdmissionProblems(loadRun(dir, other.id))[0], /spent \$2.5 of its \$2 api limit/);
  finishRun(dir, other.id, { status: "complete", summary: "done" });
  assert.match(runAdmissionProblems(loadRun(dir, other.id))[0], /is complete/);
});

test("recordRunJob: a usage-limit error pauses that agent for the run -- and only that agent", () => {
  const dir = tmp();
  const { id } = createRun(dir, { name: "f", repo: "/r", limits: { ...LIMITS, max_jobs: 40 } });
  recordRunJob(dir, id, { jobId: "a", agent: "codex", kind: "subscription", usageLimit: "You've hit your usage limit. Try again in 3 hours." });
  const run = loadRun(dir, id);
  assert.match(runAdmissionProblems(run, { agentName: "codex" })[0], /agent "codex" is paused .* rather than moving this role to a different vendor/);
  assert.deepEqual(runAdmissionProblems(run, { agentName: "grok" }), []);
  assert.ok(runTotals(run).warnings.some((w) => /agent "codex" is paused/.test(w)));
});

test("detectUsageLimit: vendor limit errors, not other failures", () => {
  assert.match(detectUsageLimit("Error: 429 Too Many Requests from api.x.ai"), /429 Too Many Requests/);
  assert.match(detectUsageLimit("\u001b[33m[openai-codex]\u001b[39m You've hit your usage limit. Upgrade or try again later."), /^\[openai-codex\] You've hit your usage limit/);
  assert.ok(detectUsageLimit("insufficient_quota: You exceeded your current quota"));
  assert.ok(detectUsageLimit("rate_limited: slow down"));
  assert.equal(detectUsageLimit("Unknown model: openai/gpt-6-sol"), null);
  assert.equal(detectUsageLimit("openclaw exited 1"), null);
  assert.equal(detectUsageLimit(null), null);
});

test("army run_limits: validated, and personal -- refused in a committed .nomarmy.yml, fine globally or locally", () => {
  assert.equal(armySchema.safeParse({ run_limits: { max_jobs: 20, max_api_usd: 3.5, warn_at: 0.75 } }).success, true);
  assert.equal(armySchema.safeParse({ run_limits: { max_api_usd: -1 } }).success, false);
  assert.equal(armySchema.safeParse({ run_limits: { warn_at: 1.5 } }).success, false);
  assert.equal(armySchema.safeParse({ run_limits: { max_dollars: 5 } }).success, false);
  const globalDir = tmp(), repo = tmp();
  const env = { NOMARMY_CONFIG_DIR: globalDir };
  fs.writeFileSync(path.join(globalDir, "config.yml"), "army:\n  run_limits:\n    max_api_usd: 5\n");
  fs.writeFileSync(path.join(repo, ".nomarmy.local.yml"), "army:\n  run_limits:\n    max_jobs: 12\n");
  const loaded = loadArmy({ projectDir: repo, env });
  assert.deepEqual(loaded.army.runLimits, { max_api_usd: 5, max_jobs: 12 });
  fs.writeFileSync(path.join(repo, ".nomarmy.yml"), "army:\n  run_limits:\n    max_api_usd: 500\n");
  assert.throws(() => loadArmy({ projectDir: repo, env }), /sets army.run_limits, which is personal/);
  fs.writeFileSync(path.join(repo, ".nomarmy.yml"), "army:\n  general: claude\n");
  assert.throws(() => loadArmy({ projectDir: repo, env }), /sets army.general, which is personal/);
});
