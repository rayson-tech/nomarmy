// Budget tests: text limits derived from context, admission derived from free
// memory, and the source order for finding out how much context a nom has.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CALIBRATED, BUDGET_RULES,
  deriveBudgets, checkBrief, parseLlamaProps, resolveContextPerNom, assessAdmission, describeBudgets
} from "../lib/budget.mjs";
import { DEFAULT_TARGET_CONTEXT_PER_NOM, RESERVES, GIB } from "../lib/sizing.mjs";

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

test("deriveBudgets: no context means the default target, labelled as such", () => {
  const b = deriveBudgets({ env: NO_ENV });
  assert.equal(b.contextPerNom, DEFAULT_TARGET_CONTEXT_PER_NOM);
  assert.equal(b.source, "default");
  assert.equal(deriveBudgets({ contextPerNom: 0, source: "x", env: NO_ENV }).source, "default");
});

test("deriveBudgets: a small context shrinks every budget and flags itself below the floor", () => {
  const b = deriveBudgets({ contextPerNom: 4096, source: "test", env: NO_ENV });
  assert.equal(b.brief.maxTaskChars, BUDGET_RULES.briefTokensMin * CALIBRATED.charsPerToken);
  assert.ok(b.brief.maxAcceptanceItemChars < CALIBRATED.acceptanceItemChars);
  assert.equal(b.report.implement.hardCapTokens, BUDGET_RULES.implementReportCapMin);
  assert.equal(b.report.scout.hardCapTokens, BUDGET_RULES.scoutReportCapMin);
  assert.ok(b.scout.maxFindings >= BUDGET_RULES.scoutFindingsMin && b.scout.maxFindings < BUDGET_RULES.scoutFindingsMax);
  assert.equal(b.scout.maxExcerptLinesTotal, BUDGET_RULES.scoutExcerptLinesTotalMin);
  assert.equal(b.tooSmall, true);
});

test("deriveBudgets: a huge context never raises the brief above the calibrated ceiling", () => {
  const b = deriveBudgets({ contextPerNom: 262144, source: "test", env: NO_ENV });
  assert.equal(b.brief.maxTaskChars, CALIBRATED.taskChars);
  assert.equal(b.report.scout.hardCapTokens, BUDGET_RULES.scoutReportCapMax);
  assert.equal(b.scout.maxFindings, BUDGET_RULES.scoutFindingsMax);
  assert.equal(b.scout.maxExcerptLinesTotal, BUDGET_RULES.scoutExcerptLinesTotalMax);
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
  assert.match(lines[0], /4096 tokens \(llama-server \/props\)/);
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
