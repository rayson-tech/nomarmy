// Decompose contract tests. Pure functions only: the report parser, citation
// verification (reused unchanged from lib/scout.mjs), the overlap check, the
// outcome rules, and the rendering the frontier reads.
import test from "node:test";
import assert from "node:assert/strict";

import {
  DECOMPOSE_OUTCOMES, DEFAULT_DECOMPOSE_LIMITS,
  decomposePrompt, parseDecomposeReport, buildDecomposeFindings, verifyCitations,
  checkDecompositionOverlap, resolveDecomposeOutcome, renderDecomposeReport,
} from "../lib/decompose.mjs";

const FILES = {
  "lib/auth.mjs": Array.from({ length: 40 }, (_, i) => `auth line ${i + 1}`).join("\n") + "\n",
  "src/routes/users.js": "import { requireAuth } from '../../lib/auth.mjs';\nrouter.use(requireAuth);\nexport default router;\n",
  "README.md": "# demo\n",
};
const readFile = async p => (p in FILES ? FILES[p] : null);

const GOOD = `DECOMPOSE REPORT
OBJECTIVE: Add auth enforcement and document it
CONFIDENCE: high
SUBTASK: Add requireAuth to the users router
ACCEPTANCE: every route under /users requires auth
FILES: src/routes/users.js [src/routes/users.js:1-2]
SUBTASK: Document authentication in the README
ACCEPTANCE: README explains how requireAuth is wired
FILES: README.md [README.md]
NOT_SPLITTABLE: none
END`;

async function verifiedGood() {
  const r = parseDecomposeReport(GOOD);
  return { report: r, verified: await verifyCitations(buildDecomposeFindings(r.subtasks), { readFile }) };
}

// --- prompt -------------------------------------------------------------
test("decomposePrompt: read-only rules, citation requirement and subtask range are stated", () => {
  const p = decomposePrompt({ objective: "o", constraints: ["a", "b"], baseRef: "HEAD", baseSha: "abc123", workerId: "d1",
    limits: { ...DEFAULT_DECOMPOSE_LIMITS, minSubtasks: 2, maxSubtasks: 5 }, report: { targetTokens: 500, hardCapTokens: 900 } });
  assert.match(p, /You read; you never write/);
  assert.match(p, /NEVER run git commands/);
  assert.match(p, /Propose 2-5 SUBTASKs/);
  assert.match(p, /NOT_SPLITTABLE instead of inventing a fake split/);
  assert.match(p, /Two subtasks should not need to touch the same file/);
  assert.match(p, /a worker generating a substantial new file in one turn can run out of output budget/);
  assert.match(p, /one short sentence of orientation is fine; do not restate your plan at length/);
  assert.match(p, /Target 500 tokens; 900 is the hard cap/);
  assert.match(p, /CONSTRAINTS\n- a\n- b/);
  assert.doesNotMatch(p, /STATUS: done/, "the implement contract must not leak into the decompose brief");
});

test("decomposePrompt: the evidence tool section appears only when the tool was placed in the sandbox", () => {
  const without = decomposePrompt({ objective: "o", baseRef: "HEAD", baseSha: "abc", workerId: "d" });
  assert.doesNotMatch(without, /EVIDENCE TOOL/);
  const with_ = decomposePrompt({ objective: "o", baseRef: "HEAD", baseSha: "abc", workerId: "d", evidenceTool: ".openclaw/nomarmy-evidence.mjs" });
  assert.match(with_, /EVIDENCE TOOL/);
  assert.match(with_, /node \.openclaw\/nomarmy-evidence\.mjs definitions <symbol>/);
  assert.match(with_, /copy verbatim into a FILES line/);
});

// --- parsing --------------------------------------------------------------
test("parseDecomposeReport: a conforming report is strict, with ACCEPTANCE/FILES grouped under the right SUBTASK", () => {
  const r = parseDecomposeReport(GOOD);
  assert.equal(r.present, true);
  assert.equal(r.strict, true);
  assert.equal(r.parseMode, "strict");
  assert.equal(r.truncated, false);
  assert.equal(r.objective, "Add auth enforcement and document it");
  assert.equal(r.confidence, "high");
  assert.equal(r.notSplittable, "none");
  assert.equal(r.subtasks.length, 2);
  assert.equal(r.subtasks[0].task, "Add requireAuth to the users router");
  assert.deepEqual(r.subtasks[0].acceptance, ["every route under /users requires auth"]);
  assert.equal(r.subtasks[0].files.length, 1);
  assert.equal(r.subtasks[0].files[0].path, "src/routes/users.js");
  assert.equal(r.subtasks[1].task, "Document authentication in the README");
  assert.equal(r.subtasks[1].files[0].path, "README.md");
  assert.deepEqual(r.missingFields, []);
});

test("parseDecomposeReport: markdown decoration and a missing END are recovered leniently and marked truncated", () => {
  const r = parseDecomposeReport("Here is my plan:\n\n**DECOMPOSE REPORT**\n- **Objective**: o\n- Confidence: medium.\n- Subtask: do the thing [lib/auth.mjs:1]\n- Acceptance: it works\n");
  assert.equal(r.strict, false);
  assert.equal(r.lenient, true);
  assert.equal(r.truncated, true);
  assert.equal(r.confidence, "medium");
  assert.equal(r.subtasks.length, 1);
  assert.equal(r.subtasks[0].acceptance.length, 1);
  assert.match(r.reason, /truncated/);
});

test("parseDecomposeReport: echoing the confidence menu yields no confidence", () => {
  const r = parseDecomposeReport("DECOMPOSE REPORT\nOBJECTIVE: o\nCONFIDENCE: high | medium | low\nSUBTASK: x\nFILES: a.js [a.js:1]\nNOT_SPLITTABLE: none\nEND");
  assert.equal(r.confidence, null);
  assert.equal(r.strict, false);
});

test("parseDecomposeReport: subtasks beyond the cap are dropped and counted, never silently", () => {
  const many = Array.from({ length: 6 }, (_, i) => `SUBTASK: s${i}\nFILES: a.js [a.js:${i + 1}]`).join("\n");
  const r = parseDecomposeReport(`DECOMPOSE REPORT\nOBJECTIVE: o\nCONFIDENCE: low\n${many}\nNOT_SPLITTABLE: none\nEND`, { ...DEFAULT_DECOMPOSE_LIMITS, maxSubtasks: 4 });
  assert.equal(r.subtasks.length, 4);
  assert.equal(r.droppedSubtasks, 2);
  assert.equal(r.strict, false, "a capped report is not a clean one");
});

test("parseDecomposeReport: ACCEPTANCE/FILES before any SUBTASK have nothing to attach to and are dropped", () => {
  const r = parseDecomposeReport("DECOMPOSE REPORT\nOBJECTIVE: o\nCONFIDENCE: low\nACCEPTANCE: orphaned\nFILES: a.js [a.js:1]\nSUBTASK: real one\nACCEPTANCE: real criterion\nNOT_SPLITTABLE: none\nEND");
  assert.equal(r.subtasks.length, 1);
  assert.deepEqual(r.subtasks[0].acceptance, ["real criterion"]);
  assert.equal(r.subtasks[0].files.length, 0);
});

test("parseDecomposeReport: a FILES line with no bracket citation contributes nothing -- citations are mandatory", () => {
  const r = parseDecomposeReport("DECOMPOSE REPORT\nOBJECTIVE: o\nCONFIDENCE: low\nSUBTASK: s\nFILES: lib/a.mjs, lib/b.mjs\nNOT_SPLITTABLE: none\nEND");
  assert.equal(r.subtasks[0].files.length, 0, "a bare path list with no [path:line] citation is not a claim the coordinator can verify");
});

test("parseDecomposeReport: a real NOT_SPLITTABLE reason with zero subtasks is a valid, non-degenerate answer", () => {
  const r = parseDecomposeReport("DECOMPOSE REPORT\nOBJECTIVE: o\nCONFIDENCE: high\nNOT_SPLITTABLE: this is one coherent one-line fix, splitting it would fragment a single change\nEND");
  assert.equal(r.subtasks.length, 0);
  assert.match(r.notSplittable, /fragment a single change/);
});

test("parseDecomposeReport: empty and content-free input", () => {
  assert.equal(parseDecomposeReport("").present, false);
  const r = parseDecomposeReport("I could not do that.");
  assert.equal(r.present, true);
  assert.equal(r.subtasks.length, 0);
  assert.match(r.reason, /no decompose report fields/);
});

// --- citation verification (reused from lib/scout.mjs) ---------------------
test("buildDecomposeFindings + verifyCitations: resolves against the snapshot and attaches the cited lines", async () => {
  const { report, verified } = await verifiedGood();
  assert.equal(verified.supported, 2);
  assert.equal(verified.unsupported, 0);
  const c = verified.findings[0].citations[0];
  assert.equal(c.status, "ok");
  assert.deepEqual(c.excerpt.map(e => e.line), [1, 2]);
  assert.equal(report.subtasks.length, verified.findings.length, "one pseudo-finding per subtask, same order");
});

test("buildDecomposeFindings + verifyCitations: an out-of-range or missing-file citation leaves a subtask unsupported", async () => {
  const r = parseDecomposeReport("DECOMPOSE REPORT\nOBJECTIVE: o\nCONFIDENCE: low\nSUBTASK: a\nFILES: lib/nope.mjs [lib/nope.mjs:1-3]\nSUBTASK: b\nFILES: lib/auth.mjs [lib/auth.mjs:400-410]\nNOT_SPLITTABLE: none\nEND");
  const v = await verifyCitations(buildDecomposeFindings(r.subtasks), { readFile });
  assert.deepEqual(v.findings.map(f => f.supported), [false, false]);
  assert.equal(v.findings[0].citations[0].status, "missing_file");
  assert.equal(v.findings[1].citations[0].status, "out_of_range");
});

// --- overlap check -----------------------------------------------------------
test("checkDecompositionOverlap: no shared files is no overlap", async () => {
  const { report, verified } = await verifiedGood();
  assert.deepEqual(checkDecompositionOverlap(report.subtasks, verified), []);
});

test("checkDecompositionOverlap: two subtasks claiming the same file are flagged, case-insensitively", async () => {
  const r = parseDecomposeReport("DECOMPOSE REPORT\nOBJECTIVE: o\nCONFIDENCE: high\nSUBTASK: a\nFILES: lib/auth.mjs [lib/auth.mjs:1-2]\nSUBTASK: b\nFILES: LIB/AUTH.MJS [lib/auth.mjs:3-4]\nNOT_SPLITTABLE: none\nEND");
  const v = await verifyCitations(buildDecomposeFindings(r.subtasks), { readFile });
  const overlaps = checkDecompositionOverlap(r.subtasks, v);
  assert.equal(overlaps.length, 1);
  assert.deepEqual(overlaps[0], { a: 0, b: 1, files: ["lib/auth.mjs"] });
});

test("checkDecompositionOverlap: an unresolved citation is never counted toward an overlap", async () => {
  const r = parseDecomposeReport("DECOMPOSE REPORT\nOBJECTIVE: o\nCONFIDENCE: high\nSUBTASK: a\nFILES: lib/nope.mjs [lib/nope.mjs:1]\nSUBTASK: b\nFILES: lib/nope.mjs [lib/nope.mjs:2]\nNOT_SPLITTABLE: none\nEND");
  const v = await verifyCitations(buildDecomposeFindings(r.subtasks), { readFile });
  assert.deepEqual(checkDecompositionOverlap(r.subtasks, v), [], "both citations are missing_file, never 'ok', so no overlap is claimed");
});

// --- outcome ------------------------------------------------------------
test("resolveDecomposeOutcome: supported subtasks complete; the outcome precedence matches scout's", async () => {
  const { report, verified } = await verifiedGood();
  const o = resolveDecomposeOutcome({ report, verified });
  assert.equal(o.outcome, DECOMPOSE_OUTCOMES.DECOMPOSE_DONE);
  assert.equal(o.coordinatorStatus, "complete");
  assert.equal(o.reviewRequired, false);
  assert.equal(o.retainWorktree, false, "a clean decompose worktree holds no work");
});

test("resolveDecomposeOutcome: workerTimedOut and workerFailed take precedence over everything else", async () => {
  const { report, verified } = await verifiedGood();
  assert.equal(resolveDecomposeOutcome({ report, verified, workerTimedOut: true }).outcome, "WORKER_TIMEOUT");
  assert.equal(resolveDecomposeOutcome({ report, verified, workerFailed: true }).outcome, "WORKER_FAILED");
});

test("resolveDecomposeOutcome: a dirty snapshot is tainted and retained whatever else happened", async () => {
  const { report, verified } = await verifiedGood();
  const tainted = resolveDecomposeOutcome({ report, verified, dirty: true });
  assert.equal(tainted.outcome, DECOMPOSE_OUTCOMES.DECOMPOSE_TAINTED);
  assert.equal(tainted.coordinatorStatus, "needs_review");
  assert.equal(tainted.retainWorktree, true);
});

test("resolveDecomposeOutcome: missing report is invalid", () => {
  assert.equal(resolveDecomposeOutcome({ report: parseDecomposeReport(""), verified: null }).outcome, DECOMPOSE_OUTCOMES.DECOMPOSE_REPORT_INVALID);
});

test("resolveDecomposeOutcome: a real NOT_SPLITTABLE answer is a legitimate complete result, not a failure", () => {
  const r = parseDecomposeReport("DECOMPOSE REPORT\nOBJECTIVE: o\nCONFIDENCE: high\nNOT_SPLITTABLE: one coherent one-line fix\nEND");
  const o = resolveDecomposeOutcome({ report: r, verified: null });
  assert.equal(o.outcome, DECOMPOSE_OUTCOMES.DECOMPOSE_UNSPLITTABLE);
  assert.equal(o.coordinatorStatus, "complete");
  assert.equal(o.reviewRequired, false);
});

test("resolveDecomposeOutcome: zero supported subtasks is invalid, not a quiet success", async () => {
  const r = parseDecomposeReport("DECOMPOSE REPORT\nOBJECTIVE: o\nCONFIDENCE: high\nSUBTASK: confident nonsense\nFILES: lib/nope.mjs [lib/nope.mjs:1]\nNOT_SPLITTABLE: none\nEND");
  const v = await verifyCitations(buildDecomposeFindings(r.subtasks), { readFile });
  const o = resolveDecomposeOutcome({ report: r, verified: v });
  assert.equal(o.outcome, DECOMPOSE_OUTCOMES.DECOMPOSE_REPORT_INVALID);
  assert.equal(o.coordinatorStatus, "incomplete");
  assert.equal(o.reviewRequired, true);
});

test("resolveDecomposeOutcome: file-level-only support is DECOMPOSE_WEAK and needs review, not complete", async () => {
  const r = parseDecomposeReport("DECOMPOSE REPORT\nOBJECTIVE: o\nCONFIDENCE: high\nSUBTASK: a\nFILES: README.md [README.md]\nSUBTASK: b\nFILES: README.md [README.md]\nNOT_SPLITTABLE: none\nEND");
  const v = await verifyCitations(buildDecomposeFindings(r.subtasks), { readFile });
  const o = resolveDecomposeOutcome({ report: r, verified: v });
  assert.equal(o.outcome, DECOMPOSE_OUTCOMES.DECOMPOSE_WEAK);
  assert.equal(o.coordinatorStatus, "needs_review");
});

test("resolveDecomposeOutcome: truncated-but-supported completes with review", async () => {
  const r = parseDecomposeReport("DECOMPOSE REPORT\nOBJECTIVE: o\nCONFIDENCE: high\nSUBTASK: a\nFILES: lib/auth.mjs [lib/auth.mjs:1-2]\nSUBTASK: b\nFILES: README.md [README.md:1]\n");
  const v = await verifyCitations(buildDecomposeFindings(r.subtasks), { readFile });
  const o = resolveDecomposeOutcome({ report: r, verified: v });
  assert.equal(o.outcome, DECOMPOSE_OUTCOMES.DECOMPOSE_DONE);
  assert.equal(o.reviewRequired, true);
  assert.match(o.reasons.join(" "), /truncated/);
});

// --- rendering ------------------------------------------------------------
test("renderDecomposeReport: claim and evidence side by side, overlap surfaced, confidence labeled", async () => {
  const r = parseDecomposeReport("DECOMPOSE REPORT\nOBJECTIVE: split the auth work\nCONFIDENCE: medium\nSUBTASK: wire auth into the users router\nACCEPTANCE: every route requires auth\nFILES: src/routes/users.js [src/routes/users.js:1-2]\nSUBTASK: also touch the same file again\nFILES: src/routes/users.js [src/routes/users.js:3]\nNOT_SPLITTABLE: none\nEND");
  const v = await verifyCitations(buildDecomposeFindings(r.subtasks), { readFile });
  const overlaps = checkDecompositionOverlap(r.subtasks, v);
  const outcome = resolveDecomposeOutcome({ report: r, verified: v });
  const text = renderDecomposeReport({ report: r, verified: v, subtasks: r.subtasks, overlaps, outcome, baseSha: "0123456789abcdef" });
  assert.match(text, /verified against 0123456789/);
  assert.match(text, /CONFIDENCE: medium  \(the decomposer's own estimate, not evidence\)/);
  assert.match(text, /SUBTASKS \(2\)/);
  assert.match(text, /ACCEPTANCE: every route requires auth/);
  assert.match(text, /src\/routes\/users\.js:1-2/);
  assert.match(text, /\| 1  import \{ requireAuth \}/);
  assert.match(text, /OVERLAP \(1\)/);
  assert.match(text, /subtask 1 and 2 both claim: src\/routes\/users\.js/);
  assert.match(text, /NOT_SPLITTABLE: none/);
});
