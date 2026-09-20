// Scout contract tests. Pure functions only: the report parser, citation
// verification against an injected file map, the outcome rules, and the
// rendering the frontier reads.
import test from "node:test";
import assert from "node:assert/strict";

import {
  SCOUT_OUTCOMES, SCOUT_STATUS_BY_OUTCOME, DEFAULT_SCOUT_LIMITS,
  scoutPrompt, parseCitation, parseCitationToken, extractCitations, parseScoutReport, verifyCitations, resolveScoutOutcome, renderScoutReport,
  distinctiveTerms,
} from "../lib/scout.mjs";

const FILES = {
  "lib/auth.mjs": Array.from({ length: 40 }, (_, i) => `auth line ${i + 1}`).join("\n") + "\n",
  "src/routes/users.js": "import { requireAuth } from '../../lib/auth.mjs';\nrouter.use(requireAuth);\nexport default router;\n",
  "README.md": "# demo\n",
};
const readFile = async p => (p in FILES ? FILES[p] : null);

const GOOD = `SCOUT REPORT
QUESTION: Where is authentication enforced?
CONFIDENCE: high
FINDING: requireAuth is defined in the auth module. [lib/auth.mjs:10-14]
FINDING: The users router applies it to every route. [src/routes/users.js:1-2] [lib/auth.mjs:3]
NOT_FOUND: none
END`;

// --- prompt -----------------------------------------------------------------
test("scoutPrompt: read-only rules, citation requirement and caps are stated", () => {
  const p = scoutPrompt({ question: "q", mustCover: ["a", "b"], baseRef: "HEAD", baseSha: "abc123", workerId: "s1",
    limits: { ...DEFAULT_SCOUT_LIMITS, maxFindings: 7 }, report: { targetTokens: 500, hardCapTokens: 900 } });
  assert.match(p, /You read; you never write/);
  assert.match(p, /NEVER run git commands/);
  assert.match(p, /\[src\/example\.js:10-24\]/);
  assert.match(p, /never write the words "path", "start" or "end"/);
  assert.match(p, /read the source files that implement it/);
  assert.match(p, /At most 7 findings/);
  assert.match(p, /one short sentence of orientation is fine; do not restate your plan at length/);
  assert.match(p, /Target 500 tokens; 900 is the hard cap/);
  assert.match(p, /MUST COVER\n- a\n- b/);
  assert.doesNotMatch(p, /STATUS: done/, "the implement contract must not leak into the scout brief");
});

// --- citations --------------------------------------------------------------
test("parseCitation: accepts relative paths, strips /workspace and ./, rejects escapes", () => {
  assert.deepEqual(parseCitation("lib/a.mjs", 3, 9), { path: "lib/a.mjs", start: 3, end: 9, granularity: "lines" });
  assert.equal(parseCitation("/workspace/lib/a.mjs", 3).path, "lib/a.mjs");
  assert.equal(parseCitation("./lib/a.mjs", 3).path, "lib/a.mjs");
  assert.equal(parseCitation("lib\\a.mjs", 3).path, "lib/a.mjs");
  assert.deepEqual(parseCitation("lib/a.mjs"), { path: "lib/a.mjs", start: null, end: null, granularity: "file" });
  assert.equal(parseCitation("lib/a.mjs", 3).end, 3, "single line means start == end");
  assert.equal(parseCitation("../etc/passwd", 1), null);
  assert.equal(parseCitation("lib/../../x", 1), null);
  assert.equal(parseCitation("/etc/passwd", 1), null);
  assert.equal(parseCitation("C:/Windows/x", 1), null);
  assert.equal(parseCitation("https://example.com/x", 1), null);
  assert.equal(parseCitation("lib/a.mjs", 0), null, "lines are 1-based");
  assert.equal(parseCitation("lib/a.mjs", 9, 3), null, "end before start");
});

test("parseCitationToken: a template copied literally is salvaged to a weak file-level citation, never lines", () => {
  // Observed verbatim from a 4B model on the first live scout run.
  const c = parseCitationToken("path:AGENTS.md:start-55");
  assert.equal(c.path, "AGENTS.md");
  assert.equal(c.granularity, "file");
  assert.equal(c.lineSpecInvalid, "start-55");
  assert.equal(parseCitationToken("file: lib/a.mjs:12-14").granularity, "lines");
  assert.equal(parseCitationToken("lib/a.mjs:L12-L14").end, 14);
  assert.equal(parseCitationToken("see the discussion above"), null);
  assert.equal(parseCitationToken("../../etc/passwd:1"), null);
});

test("extractCitations: every bracketed token is an attempt; garbled ones are reported, not dropped", () => {
  const cs = extractCitations("x [lib/a.mjs:1-2] y [path:README.md:start-end] z [no idea]");
  assert.equal(cs.length, 3);
  assert.equal(cs[0].granularity, "lines");
  assert.equal(cs[1].granularity, "file"); assert.equal(cs[1].path, "README.md");
  assert.equal(cs[2].granularity, "invalid"); assert.equal(cs[2].raw, "[no idea]");
});

test("verifyCitations: a salvaged file-level citation is weak; an unparseable one is labelled as such", async () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: low\nFINDING: a [path:README.md:start-55]\nFINDING: b [see above]\nNOT_FOUND: none\nEND");
  const v = await verifyCitations(r.findings, { readFile });
  assert.equal(v.findings[0].supported, true); assert.equal(v.findings[0].weak, true);
  assert.equal(v.findings[1].supported, false); assert.equal(v.findings[1].citations[0].status, "unparseable");
  const text = renderScoutReport({ report: r, verified: v, outcome: resolveScoutOutcome({ report: r, verified: v }), baseSha: "abc" });
  assert.match(text, /line spec "start-55" was unreadable/);
  assert.match(text, /\[see above\]: unparseable/);
});

// --- parsing ----------------------------------------------------------------
test("parseScoutReport: a conforming report is strict with every citation extracted", () => {
  const r = parseScoutReport(GOOD);
  assert.equal(r.present, true);
  assert.equal(r.strict, true);
  assert.equal(r.parseMode, "strict");
  assert.equal(r.truncated, false);
  assert.equal(r.question, "Where is authentication enforced?");
  assert.equal(r.confidence, "high");
  assert.equal(r.notFound, "none");
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[0].text, "requireAuth is defined in the auth module.");
  assert.deepEqual(r.findings[0].citations.map(c => [c.path, c.start, c.end]), [["lib/auth.mjs", 10, 14]]);
  assert.equal(r.findings[1].citations.length, 2);
  assert.deepEqual(r.missingFields, []);
});

test("parseScoutReport: markdown decoration and a missing END are recovered leniently and marked truncated", () => {
  const r = parseScoutReport("Here is what I found:\n\n**SCOUT REPORT**\n- **Question**: q\n- Confidence: medium.\n- Finding: thing [lib/auth.mjs:1]\n");
  assert.equal(r.strict, false);
  assert.equal(r.lenient, true);
  assert.equal(r.truncated, true);
  assert.equal(r.confidence, "medium");
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.missingFields, ["NOT_FOUND", "END"]);
  assert.match(r.reason, /truncated/);
});

test("parseScoutReport: echoing the confidence menu yields no confidence", () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: high | medium | low\nFINDING: x [a.js:1]\nNOT_FOUND: none\nEND");
  assert.equal(r.confidence, null);
  assert.equal(r.strict, false);
});

test("parseScoutReport: findings beyond the cap are dropped and counted, never silently", () => {
  const many = Array.from({ length: 6 }, (_, i) => `FINDING: f${i} [a.js:${i + 1}]`).join("\n");
  const r = parseScoutReport(`SCOUT REPORT\nQUESTION: q\nCONFIDENCE: low\n${many}\nNOT_FOUND: none\nEND`, { maxFindings: 4 });
  assert.equal(r.findings.length, 4);
  assert.equal(r.droppedFindings, 2);
  assert.equal(r.strict, false, "a capped report is not a clean one");
});

test("parseScoutReport: a finding with no citation is kept so it can be listed as hearsay", () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: low\nFINDING: I believe caching is disabled.\nNOT_FOUND: none\nEND");
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.findings[0].citations, []);
});

test("parseScoutReport: empty and content-free input", () => {
  assert.equal(parseScoutReport("").present, false);
  const r = parseScoutReport("I could not do that.");
  assert.equal(r.present, true);
  assert.equal(r.findings.length, 0);
  assert.match(r.reason, /no scout report fields/);
});

// --- verification -----------------------------------------------------------
test("verifyCitations: resolves against the snapshot and attaches the cited lines", async () => {
  const r = parseScoutReport(GOOD);
  const v = await verifyCitations(r.findings, { readFile });
  assert.equal(v.supported, 2);
  assert.equal(v.unsupported, 0);
  const c = v.findings[0].citations[0];
  assert.equal(c.status, "ok");
  assert.equal(c.lineCount, 40);
  assert.deepEqual(c.excerpt.map(e => e.line), [10, 11, 12, 13, 14]);
  assert.equal(c.excerpt[0].text, "auth line 10");
  assert.equal(v.excerptLinesUsed, 5 + 2 + 1);
});

test("verifyCitations: missing files, out-of-range lines and bad paths leave a finding unsupported", async () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: low\nFINDING: a [lib/nope.mjs:1-3]\nFINDING: b [lib/auth.mjs:400-410]\nFINDING: c [../x:1]\nFINDING: d\nFINDING: e [lib/auth.mjs:38-45]\nNOT_FOUND: none\nEND");
  const v = await verifyCitations(r.findings, { readFile });
  assert.deepEqual(v.findings.map(f => f.supported), [false, false, false, false, true]);
  assert.equal(v.findings[0].citations[0].status, "missing_file");
  assert.equal(v.findings[1].citations[0].status, "out_of_range");
  assert.equal(v.findings[2].citations[0].status, "unparseable");
  const e = v.findings[4].citations[0];
  assert.equal(e.end, 40, "an end past EOF is clamped, not rejected");
  assert.equal(e.endClamped, true);
  assert.equal(v.unsupported, 4);
});

test("verifyCitations: excerpt budgets clip per citation and stop attaching when the total is spent", async () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: low\nFINDING: a [lib/auth.mjs:1-30]\nFINDING: b [lib/auth.mjs:31-40]\nNOT_FOUND: none\nEND");
  const v = await verifyCitations(r.findings, { readFile, limits: { maxExcerptLinesPerCitation: 6, maxExcerptLinesTotal: 8 } });
  const [a, b] = v.findings.map(f => f.citations[0]);
  assert.equal(a.excerpt.length, 6); assert.equal(a.clipped, true);
  assert.equal(b.excerpt.length, 2); assert.equal(b.clipped, true);
  assert.equal(v.excerptLinesUsed, 8);
  assert.equal(a.status, "ok"); assert.equal(b.status, "ok", "a clipped excerpt is still verified");
  assert.equal(v.supported, 2);
});

test("verifyCitations: a file-level citation is supported but weak", async () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: low\nFINDING: the readme exists [README.md]\nNOT_FOUND: none\nEND");
  const v = await verifyCitations(r.findings, { readFile });
  assert.equal(v.supported, 1);
  assert.equal(v.weak, 1);
  assert.equal(v.findings[0].citations[0].excerpt, null);
});

test("verifyCitations: a throwing reader is a missing file, not a crash", async () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: low\nFINDING: a [x.js:1]\nNOT_FOUND: none\nEND");
  const v = await verifyCitations(r.findings, { readFile: async () => { throw new Error("git show failed"); } });
  assert.equal(v.findings[0].citations[0].status, "missing_file");
});

test("verifyCitations: a real range that never mentions the finding's terms is weak and labelled unrelated", async () => {
  // The second live run verbatim in shape: three claims about commit gates, all citing five delegation lines.
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: medium\nFINDING: A commit is blocked unless STATUS is done and VERIFICATION passes. [src/routes/users.js:1-3]\nFINDING: The users router applies requireAuth to every route. [src/routes/users.js:1-2]\nNOT_FOUND: none\nEND");
  const v = await verifyCitations(r.findings, { readFile });
  assert.equal(v.findings[0].supported, true);
  assert.equal(v.findings[0].weak, true);
  assert.equal(v.findings[0].unrelated, true);
  assert.equal(v.findings[0].citations[0].related, false);
  assert.equal(v.findings[1].weak, false);
  assert.equal(v.findings[1].citations[0].related, true);
  assert.ok(v.findings[1].citations[0].overlapTerms.includes("requireauth"));
  const text = renderScoutReport({ report: r, verified: v, outcome: resolveScoutOutcome({ report: r, verified: v }), baseSha: "abc" });
  assert.match(text, /\[WEAK: the cited lines do not mention this finding's terms\]/);
  assert.match(text, /\(no shared terms with the finding\)/);
});

test("verifyCitations: a finding with no distinctive terms is not penalised for relatedness", async () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: low\nFINDING: see [lib/auth.mjs:1-2]\nNOT_FOUND: none\nEND");
  const v = await verifyCitations(r.findings, { readFile });
  assert.equal(v.findings[0].citations[0].related, null);
  assert.equal(v.findings[0].weak, false);
});

test("resolveScoutOutcome: all findings unrelated to their cited lines is SCOUT_WEAK", async () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: high\nFINDING: Commits require VERIFICATION pass. [README.md:1]\nFINDING: Timeouts block the commit. [README.md:1]\nNOT_FOUND: none\nEND");
  const v = await verifyCitations(r.findings, { readFile });
  assert.equal(resolveScoutOutcome({ report: r, verified: v }).outcome, SCOUT_OUTCOMES.SCOUT_WEAK);
});

test("scoutPrompt: the evidence tool section appears only when the tool was placed in the sandbox", () => {
  const without = scoutPrompt({ question: "q", baseRef: "HEAD", baseSha: "abc", workerId: "s" });
  assert.doesNotMatch(without, /EVIDENCE TOOL/);
  const with_ = scoutPrompt({ question: "q", baseRef: "HEAD", baseSha: "abc", workerId: "s", evidenceTool: ".openclaw/nomarmy-evidence.mjs" });
  assert.match(with_, /EVIDENCE TOOL/);
  assert.match(with_, /node \.openclaw\/nomarmy-evidence\.mjs definitions <symbol>/);
  assert.match(with_, /copy verbatim into a FINDING/);
});

test("scoutPrompt: requires rereading each citation before reporting, anchored to a real wrong claim", () => {
  // Found live: a scout claimed padStart(1, "0") would turn "10" into "01",
  // which is false -- padStart never shortens a string already long enough.
  // Rereading the cited call against real output would have caught it.
  const p = scoutPrompt({ question: "q", baseRef: "HEAD", baseSha: "abc", workerId: "s" });
  assert.match(p, /re-check each FINDING: reread the exact cited lines one more time/);
  assert.match(p, /padStart\(1, "0"\)/, "the real wrong claim must be quoted, not a generic hypothetical");
  assert.match(p, /weaken it to NOT_FOUND rather than assert it/);
  assert.ok(p.indexOf("re-check each FINDING") < p.indexOf("FINAL REPORT"), "self-review must come before the report section, not after");
});

// --- outcome ----------------------------------------------------------------
async function verifiedGood() { const r = parseScoutReport(GOOD); return { report: r, verified: await verifyCitations(r.findings, { readFile }) }; }

test("resolveScoutOutcome: supported findings complete; unsupported ones only flag review", async () => {
  const { report, verified } = await verifiedGood();
  const o = resolveScoutOutcome({ report, verified });
  assert.equal(o.outcome, SCOUT_OUTCOMES.SCOUT_DONE);
  assert.equal(o.coordinatorStatus, "complete");
  assert.equal(o.reviewRequired, false);
  assert.equal(o.retainWorktree, false, "a clean scout worktree holds no work");
});

test("resolveScoutOutcome: zero supported findings is incomplete, not a quiet success", async () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: high\nFINDING: confident nonsense [lib/nope.mjs:1]\nNOT_FOUND: none\nEND");
  const v = await verifyCitations(r.findings, { readFile });
  const o = resolveScoutOutcome({ report: r, verified: v });
  assert.equal(o.outcome, SCOUT_OUTCOMES.SCOUT_UNSUPPORTED);
  assert.equal(o.coordinatorStatus, "incomplete");
  assert.equal(o.reviewRequired, true);
});

test("resolveScoutOutcome: a dirty snapshot is tainted and retained whatever else happened", async () => {
  const { report, verified } = await verifiedGood();
  const tainted = resolveScoutOutcome({ report, verified, dirty: true });
  assert.equal(tainted.outcome, SCOUT_OUTCOMES.SCOUT_TAINTED);
  assert.equal(tainted.coordinatorStatus, "needs_review");
  assert.equal(tainted.retainWorktree, true);
  const failedDirty = resolveScoutOutcome({ report, verified, workerFailed: true, dirty: true });
  assert.equal(failedDirty.outcome, "WORKER_FAILED");
  assert.equal(failedDirty.retainWorktree, true);
  assert.equal(resolveScoutOutcome({ report, verified, workerTimedOut: true }).outcome, "WORKER_TIMEOUT");
});

test("resolveScoutOutcome: missing report is invalid; truncated-but-supported completes with review", async () => {
  assert.equal(resolveScoutOutcome({ report: parseScoutReport(""), verified: null }).outcome, SCOUT_OUTCOMES.SCOUT_REPORT_INVALID);
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: high\nFINDING: the auth module starts here [lib/auth.mjs:1-2]\n");
  const v = await verifyCitations(r.findings, { readFile });
  const o = resolveScoutOutcome({ report: r, verified: v });
  assert.equal(o.outcome, SCOUT_OUTCOMES.SCOUT_DONE);
  assert.equal(o.reviewRequired, true);
  assert.match(o.reasons.join(" "), /truncated/);
});

test("resolveScoutOutcome: file-level-only support is SCOUT_WEAK and needs review, not complete", async () => {
  // The first live run verbatim: template citations salvaged to file level, so nothing to read.
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: high\nFINDING: a [path:README.md:start-55]\nFINDING: b [README.md]\nFINDING: c [nowhere.md:3]\nNOT_FOUND: none\nEND");
  const v = await verifyCitations(r.findings, { readFile });
  assert.equal(v.supported, 2); assert.equal(v.weak, 2);
  const o = resolveScoutOutcome({ report: r, verified: v });
  assert.equal(o.outcome, SCOUT_OUTCOMES.SCOUT_WEAK);
  assert.equal(o.coordinatorStatus, "needs_review");
  assert.equal(o.reviewRequired, true);
  assert.match(o.reasons[0], /cites a file, not lines/);
  assert.match(o.reasons[1], /1 finding\(s\) had no resolvable citation/);
  // One real line citation among weak ones is enough to be DONE again.
  const r2 = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: high\nFINDING: a [README.md]\nFINDING: b [lib/auth.mjs:1-2]\nNOT_FOUND: none\nEND");
  const v2 = await verifyCitations(r2.findings, { readFile });
  assert.equal(resolveScoutOutcome({ report: r2, verified: v2 }).outcome, SCOUT_OUTCOMES.SCOUT_DONE);
});

// --- rendering --------------------------------------------------------------
test("renderScoutReport: claim and evidence side by side, hearsay fenced off, confidence labelled", async () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: medium\nFINDING: users router applies auth [src/routes/users.js:1-2]\nFINDING: caching is off\nNOT_FOUND: no rate limiter\nEND");
  const v = await verifyCitations(r.findings, { readFile });
  const text = renderScoutReport({ report: r, verified: v, outcome: resolveScoutOutcome({ report: r, verified: v }), baseSha: "0123456789abcdef" });
  assert.match(text, /verified against 0123456789/);
  assert.match(text, /CONFIDENCE: medium  \(the scout's own estimate, not evidence\)/);
  assert.match(text, /SUPPORTED FINDINGS \(1\)/);
  assert.match(text, /src\/routes\/users\.js:1-2/);
  assert.match(text, /\| 1  import \{ requireAuth \}/);
  assert.match(text, /UNSUPPORTED FINDINGS \(1\)  -- no citation resolved; treat as hearsay/);
  assert.match(text, /- caching is off  \[no citation given\]/);
  assert.match(text, /NOT_FOUND: no rate limiter/);
  assert.match(text, /NOTE: 1 finding\(s\) had no resolvable citation/);
});

// --- a well-formed zero-findings report is a negative result, not a broken one ---
test("parseScoutReport: zero findings with a real NOT_FOUND is a strict, well-formed report", () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: does auth.mjs leak secrets in logs?\nCONFIDENCE: high\nNOT_FOUND: no logging of secret values found anywhere in the file\nEND");
  assert.equal(r.present, true);
  assert.equal(r.findings.length, 0);
  assert.equal(r.strict, true, "zero FINDING lines must not by itself make the shape non-strict");
  assert.equal(r.missingFields.includes("FINDING"), false, "FINDING is not missing when NOT_FOUND legitimately explains the negative result");
  assert.equal(r.reason, null);
});

test("parseScoutReport: zero findings AND no NOT_FOUND is genuinely incomplete, not a quiet negative", () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: high\nEND");
  assert.equal(r.strict, false);
  assert.ok(r.missingFields.includes("FINDING"));
  assert.match(r.reason, /no FINDING lines recovered and no NOT_FOUND given/);
});

test("resolveScoutOutcome: a well-formed zero-findings report is SCOUT_NOT_FOUND, not SCOUT_REPORT_INVALID", () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: are there race conditions in mapLimit?\nCONFIDENCE: high\nNOT_FOUND: read the full function; found no shared-state race\nEND");
  const o = resolveScoutOutcome({ report: r, verified: null });
  assert.equal(o.outcome, SCOUT_OUTCOMES.SCOUT_NOT_FOUND);
  assert.equal(o.coordinatorStatus, SCOUT_STATUS_BY_OUTCOME.SCOUT_NOT_FOUND);
  assert.equal(o.coordinatorStatus, "needs_review");
  assert.equal(o.reviewRequired, true, "an unverifiable negative claim always needs a human's eyes");
});

// ---------------------------------------------------------------------------
// cleanValue (via parseScoutReport's finding.text): must not destroy
// identifiers. Reported live: cleanValue stripped every underscore, so
// "row_key" became "row key" and "_validate_tabular_mapping" became
// "validate tabular mapping" -- exactly the tokens distinctiveTerms()'s
// `/_|\./.test(t)` check exists to recognise, gutted before it ever ran.
// ---------------------------------------------------------------------------

test("parseScoutReport: a snake_case identifier in a finding survives cleanValue intact", () => {
  const r = parseScoutReport(
    "SCOUT REPORT\nQUESTION: q\nCONFIDENCE: high\n" +
    "FINDING: The row_key uniqueness rule is enforced in _validate_tabular_mapping [lib/x.py:1]\n" +
    "NOT_FOUND: none\nEND"
  );
  assert.equal(r.findings[0].text, "The row_key uniqueness rule is enforced in _validate_tabular_mapping");
});

test("distinctiveTerms: row_key stays one distinctive term, not shattered into row + key", () => {
  const terms = distinctiveTerms("The row_key uniqueness rule is enforced in _validate_tabular_mapping");
  assert.ok(terms.has("row_key"), "row_key must survive as its own identifier token");
  assert.ok(terms.has("_validate_tabular_mapping"));
  // row/key alone are 3 letters and not identifier-shaped -- they must never
  // appear as if cleanValue had split row_key into two ordinary words.
  assert.ok(!terms.has("row"));
  assert.ok(!terms.has("key"));
});

test("cleanValue (via parseScoutReport): real markdown emphasis is still cleaned, only mid-identifier underscores are spared", () => {
  const r = parseScoutReport(
    "SCOUT REPORT\nQUESTION: q\nCONFIDENCE: high\n" +
    "FINDING: This is *very* important and uses `row_key` for lookups [lib/x.py:1]\n" +
    "NOT_FOUND: none\nEND"
  );
  assert.equal(r.findings[0].text, "This is very important and uses row_key for lookups");
});

// ---------------------------------------------------------------------------
// Citation stripping from a finding's body: only an actually-resolved
// citation should be removed, never code syntax that merely looks
// bracketed. Reported live: `descriptor["mapping"]["columns"]` lost the
// entire expression because the citation-stripping regex matched every
// `[...]` span, subscripts included.
// ---------------------------------------------------------------------------

test("parseScoutReport: a dict/list subscript in a finding is not eaten as a phantom citation", () => {
  const r = parseScoutReport(
    "SCOUT REPORT\nQUESTION: q\nCONFIDENCE: high\n" +
    'FINDING: the executor reads descriptor["mapping"]["columns"] at [lib/x.py:5-6]\n' +
    "NOT_FOUND: none\nEND"
  );
  assert.equal(r.findings[0].text, 'the executor reads descriptor["mapping"]["columns"] at');
  // The real citation is still extracted correctly, exactly once.
  assert.equal(r.findings[0].citations.length, 3, "the two subscripts are still reported as citation attempts, just not removed from the body");
  const real = r.findings[0].citations.find((c) => c.path === "lib/x.py");
  assert.ok(real, "the real [lib/x.py:5-6] citation must still resolve");
  assert.equal(real.start, 5);
  assert.equal(real.end, 6);
});

test("resolveScoutOutcome: a genuinely empty report (no findings, no NOT_FOUND) stays SCOUT_REPORT_INVALID", () => {
  const r = parseScoutReport("SCOUT REPORT\nQUESTION: q\nCONFIDENCE: high\nEND");
  const o = resolveScoutOutcome({ report: r, verified: null });
  assert.equal(o.outcome, SCOUT_OUTCOMES.SCOUT_REPORT_INVALID);
});
