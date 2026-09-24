// Budget tests: text limits derived from context, admission derived from free
// memory, and the source order for finding out how much context a nom has.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CALIBRATED, BUDGET_RULES,
  deriveBudgets, checkBrief, parseLlamaProps, resolveContextPerNom, assessAdmission, describeBudgets, deriveTimeBudget
} from "../lib/budget.mjs";
import { DEFAULT_TARGET_CONTEXT_PER_NOM, RESERVES, GIB } from "../lib/sizing.mjs";

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

const NO_ENV = {};

// --- deriveBudgets ----------------------------------------------------------
test("deriveBudgets: at the design target the brief ceiling equals the calibrated value", () => {
  const b = deriveBudgets({ contextPerNom: DEFAULT_TARGET_CONTEXT_PER_NOM, source: "test", env: NO_ENV });
  assert.equal(b.brief.maxTaskChars, CALIBRATED.taskChars);
  assert.equal(b.brief.maxAcceptanceItemChars, CALIBRATED.acceptanceItemChars);
  assert.equal(b.report.implement.hardCapTokens, 512);
  assert.equal(b.report.implement.targetTokens, 256);
  assert.equal(b.source, "test");
  assert.equal(b.tooSmall, false);
});

test("deriveBudgets: no context means the default target, labeled as such", () => {
  const b = deriveBudgets({ env: NO_ENV });
  assert.equal(b.contextPerNom, DEFAULT_TARGET_CONTEXT_PER_NOM);
  assert.equal(b.source, "default");
  assert.equal(deriveBudgets({ contextPerNom: 0, source: "x", env: NO_ENV }).source, "default");
});

test("deriveBudgets: the decompose report field has the correct shape at the design target", () => {
  const b = deriveBudgets({ contextPerNom: 32768, source: "test", env: NO_ENV });
  assert.ok(b.report.decompose);
  const cap = Math.floor(32768 * BUDGET_RULES.decomposeReportFraction);
  const target = Math.floor(cap * 0.6);
  assert.equal(b.report.decompose.targetTokens, target);
  assert.equal(b.report.decompose.hardCapTokens, cap);
  assert.equal(b.decompose.maxSubtasks, clamp(Math.floor((cap - 40) / 150), BUDGET_RULES.decomposeSubtasksMin, BUDGET_RULES.decomposeSubtasksMax));
});

test("deriveBudgets: the decompose top-level object has the correct shape at the design target", () => {
  const b = deriveBudgets({ contextPerNom: DEFAULT_TARGET_CONTEXT_PER_NOM, source: "test", env: NO_ENV });
  assert.ok(b.decompose);
  assert.equal(typeof b.decompose.maxSubtasks, "number");
  assert.equal(b.decompose.maxAcceptancePerSubtask, BUDGET_RULES.decomposeAcceptancePerSubtask);
  assert.equal(b.decompose.maxFilesPerSubtask, BUDGET_RULES.decomposeFilesPerSubtask);
  assert.equal(b.decompose.maxSubtaskChars, BUDGET_RULES.decomposeSubtaskChars);
});

test("deriveBudgets: a small context shrinks every budget and flags itself below the floor", () => {
  const b = deriveBudgets({ contextPerNom: 4096, source: "test", env: NO_ENV });
  assert.equal(b.brief.maxTaskChars, BUDGET_RULES.briefTokensMin * CALIBRATED.charsPerToken);
  assert.ok(b.brief.maxAcceptanceItemChars < CALIBRATED.acceptanceItemChars);
  assert.equal(b.report.implement.hardCapTokens, BUDGET_RULES.implementReportCapMin);
  assert.equal(b.report.scout.hardCapTokens, BUDGET_RULES.scoutReportCapMin);
  assert.ok(b.scout.maxFindings >= BUDGET_RULES.scoutFindingsMin && b.scout.maxFindings < BUDGET_RULES.scoutFindingsMax);
  assert.equal(b.scout.maxExcerptLinesTotal, BUDGET_RULES.scoutExcerptLinesTotalMin);
  assert.equal(b.report.decompose.hardCapTokens, BUDGET_RULES.decomposeReportCapMin);
  assert.ok(b.decompose.maxSubtasks >= BUDGET_RULES.decomposeSubtasksMin && b.decompose.maxSubtasks < BUDGET_RULES.decomposeSubtasksMax);
  assert.equal(b.tooSmall, true);
});

test("deriveBudgets: a huge context never raises the brief above the calibrated ceiling", () => {
  const b = deriveBudgets({ contextPerNom: 262144, source: "test", env: NO_ENV });
  assert.equal(b.brief.maxTaskChars, CALIBRATED.taskChars);
  assert.equal(b.report.scout.hardCapTokens, BUDGET_RULES.scoutReportCapMax);
  assert.equal(b.scout.maxFindings, BUDGET_RULES.scoutFindingsMax);
  assert.equal(b.scout.maxExcerptLinesTotal, BUDGET_RULES.scoutExcerptLinesTotalMax);
  assert.equal(b.report.decompose.hardCapTokens, BUDGET_RULES.decomposeReportCapMax);
  assert.equal(b.decompose.maxSubtasks, BUDGET_RULES.decomposeSubtasksMax);
});

test("deriveBudgets: explicit environment overrides win and are named", () => {
  const b = deriveBudgets({ contextPerNom: 4096, source: "test", env: { NOMARMY_MAX_TASK_CHARS: "5000", NOMARMY_SCOUT_MAX_EXCERPT_LINES: "10" } });
  assert.equal(b.brief.maxTaskChars, 5000);
  assert.equal(b.scout.maxExcerptLinesTotal, 10);
  assert.deepEqual(b.overrides, ["NOMARMY_MAX_TASK_CHARS", "NOMARMY_SCOUT_MAX_EXCERPT_LINES"]);
  assert.equal(deriveBudgets({ env: { NOMARMY_MAX_TASK_CHARS: "nonsense" } }).overrides.length, 0);
});

test("describeBudgets: readable lines name the source and warn below the floor", () => {
  const lines = describeBudgets(deriveBudgets({ contextPerNom: 4096, source: "llama-server /props", env: NO_ENV }));
  assert.match(lines[0], /^local model: 4096-token context \(llama-server \/props\)/);
  const frontier = describeBudgets(deriveBudgets({ contextPerNom: 272000, source: "openclaw model catalog (openai/gpt-6-astra)", tier: "frontier", reportSize: "full" }));
  assert.match(frontier[0], /^frontier agent: 272000-token context \(openclaw model catalog \(openai\/gpt-6-astra\)\), full report/);
  assert.ok(lines.some(l => /WARNING/.test(l)));
});

// --- checkBrief -------------------------------------------------------------
test("checkBrief: reports each violation against the derived budget", () => {
  const b = deriveBudgets({ contextPerNom: 4096, source: "test", env: NO_ENV });
  assert.deepEqual(checkBrief({ task: "ok", acceptance: ["fine"] }, b), []);
  const problems = checkBrief({ task: "x".repeat(b.brief.maxTaskChars + 1), acceptance: ["y".repeat(b.brief.maxAcceptanceItemChars + 1)] }, b);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /4096-token context \(test\) allows/);
  assert.match(problems[1], /acceptance item 1/);
});

// --- llama-server props -----------------------------------------------------
test("parseLlamaProps: n_ctx is the per-slot context, total_slots the slot count", () => {
  const p = parseLlamaProps(JSON.stringify({ default_generation_settings: { n_ctx: 32768 }, total_slots: 2, model_path: "/m/x.gguf" }));
  assert.deepEqual(p, { contextPerNom: 32768, slots: 2, modelPath: "/m/x.gguf" });
  assert.equal(parseLlamaProps("not json"), null);
  assert.equal(parseLlamaProps({ total_slots: 2 }), null);
  assert.equal(parseLlamaProps({ default_generation_settings: { n_ctx: 8192 } }).slots, null);
});

// --- resolveContextPerNom ---------------------------------------------------
test("resolveContextPerNom: profile export beats profile arithmetic beats the server beats the default", async () => {
  const probe = async () => ({ contextPerNom: 16384, slots: 4, modelPath: null });
  assert.equal((await resolveContextPerNom({ env: { NOMARMY_CONTEXT_PER_NOM: "40000" }, probe })).contextPerNom, 40000);
  const arith = await resolveContextPerNom({ env: { NOMARMY_LLAMA_CONTEXT: "65536", NOMARMY_LLAMA_PARALLEL: "2" }, probe });
  assert.equal(arith.contextPerNom, 32768); assert.equal(arith.slots, 2);
  const probed = await resolveContextPerNom({ env: {}, probe });
  assert.equal(probed.contextPerNom, 16384); assert.equal(probed.source, "llama-server /props");
  const none = await resolveContextPerNom({ env: {}, probe: async () => null });
  assert.equal(none.contextPerNom, DEFAULT_TARGET_CONTEXT_PER_NOM); assert.match(none.source, /assumed/);
});

test("resolveContextPerNom: a cloud execution never probes a local llama-server", async () => {
  let probed = false;
  const r = await resolveContextPerNom({ env: { NOMARMY_EXECUTION: "bedrock" }, probe: async () => { probed = true; return { contextPerNom: 1 }; } });
  assert.equal(probed, false);
  assert.equal(r.contextPerNom, DEFAULT_TARGET_CONTEXT_PER_NOM);
});

// --- assessAdmission --------------------------------------------------------
const hw = (totalGiB, availGiB) => ({ memory: { totalBytes: totalGiB * GIB, availableBytes: availGiB * GIB } });

test("assessAdmission: plenty of memory and a free slot admits", () => {
  const a = assessAdmission({ hardware: hw(64, 40), runningJobs: 0, slots: 4, maxWorkers: 4 });
  assert.equal(a.admit, true); assert.equal(a.level, "ok"); assert.deepEqual(a.reasons, []);
});

test("assessAdmission: at NOMARMY_MAX_WORKERS or at the slot count, refuse on capacity", () => {
  const a = assessAdmission({ hardware: hw(64, 40), runningJobs: 1, slots: 4, maxWorkers: 1 });
  assert.equal(a.admit, false); assert.equal(a.level, "capacity"); assert.match(a.reasons[0], /NOMARMY_MAX_WORKERS is 1/);
  const s = assessAdmission({ hardware: hw(64, 40), runningJobs: 2, slots: 2, maxWorkers: 8 });
  assert.equal(s.admit, false); assert.match(s.reasons[0], /2 llama-server slot/);
});

test("assessAdmission: below the sandbox reserve plus floor is critical and refused", () => {
  const need = (RESERVES.sandboxPerNomBytes + BUDGET_RULES.admissionFloorBytes) / GIB;
  const a = assessAdmission({ hardware: hw(32, need - 0.1), runningJobs: 0, slots: null, maxWorkers: 2 });
  assert.equal(a.admit, false); assert.equal(a.level, "critical"); assert.match(a.reasons[0], /Free memory before starting/);
});

test("assessAdmission: tight memory admits with a warning; unknown memory admits on capacity alone", () => {
  const tight = assessAdmission({ hardware: hw(32, 4), runningJobs: 0, slots: null, maxWorkers: 2 });
  assert.equal(tight.admit, true); assert.equal(tight.level, "tight"); assert.match(tight.reasons[0], /the next may not/);
  const unknown = assessAdmission({ hardware: null, runningJobs: 0, maxWorkers: 2 });
  assert.equal(unknown.admit, true); assert.match(unknown.reasons[0], /could not be read/);
});

// --- deriveTimeBudget --------------------------------------------------------
test("deriveTimeBudget: work + reserve always equals what the caller asked for", () => {
  for (const timeoutSeconds of [30, 45, 100, 600, 1500, 1800]) {
    const b = deriveTimeBudget({ timeoutSeconds, env: NO_ENV });
    assert.equal(b.workTimeoutSeconds + b.reportReserveSeconds, timeoutSeconds, `mismatch at ${timeoutSeconds}s`);
  }
});

test("deriveTimeBudget: reserve is clamped between its floor and ceiling for a typical job", () => {
  const b = deriveTimeBudget({ timeoutSeconds: 1500, env: NO_ENV });
  assert.equal(b.reportReserveSeconds, BUDGET_RULES.reportReserveMax);
  assert.equal(b.workTimeoutSeconds, 1500 - BUDGET_RULES.reportReserveMax);
});

test("deriveTimeBudget: at the schema's minimum timeout, the work phase still gets its floor", () => {
  const b = deriveTimeBudget({ timeoutSeconds: 30, env: NO_ENV });
  assert.equal(b.workTimeoutSeconds, BUDGET_RULES.workTimeoutMin);
  assert.equal(b.reportReserveSeconds, 30 - BUDGET_RULES.workTimeoutMin);
});

test("deriveTimeBudget: NOMARMY_REPORT_RESERVE_SECONDS overrides the derived reserve", () => {
  const b = deriveTimeBudget({ timeoutSeconds: 600, env: { NOMARMY_REPORT_RESERVE_SECONDS: "50" } });
  assert.equal(b.reportReserveSeconds, 50);
  assert.equal(b.workTimeoutSeconds, 550);
});

test("deriveTimeBudget: idle-break threshold never exceeds the work phase it bounds", () => {
  const b = deriveTimeBudget({ timeoutSeconds: 30, env: NO_ENV });
  assert.ok(b.idleBreakSeconds <= b.workTimeoutSeconds);
  assert.ok(b.idleMinElapsedSeconds <= b.workTimeoutSeconds);
});

test("deriveTimeBudget: NOMARMY_IDLE_BREAK_SECONDS overrides the derived idle threshold", () => {
  const b = deriveTimeBudget({ timeoutSeconds: 600, env: { NOMARMY_IDLE_BREAK_SECONDS: "45" } });
  assert.equal(b.idleBreakSeconds, 45);
});

// ---------------------------------------------------------------------------
// Tiers: the calibrated caps were measured on a small local model; a
// frontier agent (api or subscription) gets its own, larger ceilings.
// ---------------------------------------------------------------------------

test("deriveBudgets: the local tier is exactly today's calibrated caps, at any report size", () => {
  for (const reportSize of ["brief", "standard", "full"]) {
    const b = deriveBudgets({ contextPerNom: 65536, reportSize });
    assert.equal(b.tier, "local");
    assert.equal(b.brief.maxTaskChars, 3000);
    assert.equal(b.brief.maxAcceptanceItemChars, 300);
    assert.equal(b.brief.maxEvidenceChars, 6000);
    assert.equal(b.report.implement.hardCapTokens, 512);
    assert.equal(b.report.scout.hardCapTokens, 1536);
  }
});

test("deriveBudgets: a frontier agent gets 16k-character briefs, 24k of evidence, and report ceilings by size", () => {
  const standard = deriveBudgets({ contextPerNom: 272000, tier: "frontier" });
  assert.deepEqual(standard.brief, { maxTaskChars: 16000, maxAcceptanceItemChars: 600, maxAcceptanceItems: 20, maxEvidenceChars: 24000 });
  assert.equal(standard.report.implement.hardCapTokens, 1024);
  assert.equal(standard.report.scout.hardCapTokens, 2048);
  const full = deriveBudgets({ contextPerNom: 272000, tier: "frontier", reportSize: "full" });
  assert.equal(full.report.implement.hardCapTokens, 2048);
  assert.equal(full.report.scout.hardCapTokens, 4096);
  assert.equal(full.reportSize, "full");
  const brief = deriveBudgets({ contextPerNom: 272000, tier: "frontier", reportSize: "brief" });
  assert.equal(brief.report.implement.hardCapTokens, 512, "brief is the local-sized report, for a job the coordinator wants terse");
});

test("deriveBudgets: a frontier model with a small context still scales down, and the local env overrides don't reach it", () => {
  const small = deriveBudgets({ contextPerNom: 32000, tier: "frontier" });
  assert.equal(small.brief.maxTaskChars, 6400, "5% of a 32k context, not the 16k ceiling");
  const env = { NOMARMY_MAX_TASK_CHARS: "1200", NOMARMY_MAX_EVIDENCE_CHARS: "900" };
  assert.equal(deriveBudgets({ contextPerNom: 65536, env }).brief.maxTaskChars, 1200);
  assert.equal(deriveBudgets({ contextPerNom: 65536, env }).brief.maxEvidenceChars, 900);
  assert.equal(deriveBudgets({ contextPerNom: 272000, tier: "frontier", env }).brief.maxTaskChars, 16000);
});

test("checkBrief: evidence is checked against the job's own tier, and a local job is still refused past 3000 characters", () => {
  const local = deriveBudgets({ contextPerNom: 65536 });
  const frontier = deriveBudgets({ contextPerNom: 272000, tier: "frontier" });
  const task = "x".repeat(5000);
  assert.match(checkBrief({ task }, local)[0], /objective is 5000 characters; this nom's 65536-token context .* allows 3000/);
  assert.deepEqual(checkBrief({ task }, frontier), []);
  assert.match(checkBrief({ task: "t", evidence: "e".repeat(7000) }, local)[0], /evidence is 7000 characters; this nom allows 6000/);
  assert.deepEqual(checkBrief({ task: "t", evidence: "e".repeat(7000) }, frontier), []);
  assert.match(checkBrief({ task: "t", evidence: "e".repeat(25000) }, frontier)[0], /this agent's model allows 24000/);
});
