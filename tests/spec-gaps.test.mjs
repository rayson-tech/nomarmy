// Catching workers that pass their own tests but miss the spec: removed or
// loosened assertions, frozen tests, tests-first jobs, the surface map, the
// scope guard, the reload prompt, the judge's vendor, visual verification
// and the automatic correction round.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertionChanges, assertionVerdict, isAssertionLine } from "../lib/assertions.mjs";
import { applyFrozenTests, frozenFromTestsFirst, frozenViolations, missingFrozen, normalizeFrozenPaths, testsFirstOutcome, testsFirstReport } from "../lib/frozen-tests.mjs";
import { accountFor, changedSurface, exportedRanges, surfaceUses, surfaceVerdict, touchedLines } from "../lib/surface-map.mjs";
import { scopeVerdict, unrequestedChanges } from "../lib/scope-guard.mjs";
import { reloadCheck } from "../lib/reload-check.mjs";
import { judgeOverlapWarning, judgeSettings, pickJudge } from "../lib/validators.mjs";
import { expectedShots, prepareVisual, routeSlug, screenshotsFrom, visualIssue, visualProblems, visualSpec } from "../lib/visual.mjs";
import { correctedResult, correctionArgs, recordAutoCorrection, wantsAutoCorrection } from "../lib/auto-correct.mjs";
import { applySpecChecks, runSpecChecks, specChecksRecord } from "../lib/spec-checks.mjs";
import { parseWorkerReport } from "../lib/report.mjs";
import { isTestPath } from "../lib/diff-checks.mjs";
import { referenceNote } from "../lib/reference-commits.mjs";

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "spec-gaps-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

// ---- assertions ------------------------------------------------------------

test("assertion lines are recognized across languages, comments aren't", () => {
  for (const line of ["expect(x).toBe(1)", "  assert total == 3", "assert.equal(a, b)", "self.assertEqual(a, b)", "assert_eq!(a, b);", "t.is(a, 1)", "require.Equal(t, a, b)", "assertThat(x).isEqualTo(1)", "x.should.equal(1)"]) {
    assert.equal(isAssertionLine(line), true, line);
  }
  for (const line of ["// expect(x).toBe(1)", "# assert x", "const assertion = 1", "it(\"adds\", () => {"]) assert.equal(isAssertionLine(line), false, line);
});

test("a removed assertion with no replacement and a loosened one are both reported; moved ones aren't", () => {
  const diff = [
    "@@ -3,2 +3,1 @@",
    "-  expect(total).toBe(42)",
    "-  expect(saved).toEqual({ a: 1 })",
    "+  expect(total).toBeDefined()",
    "@@ -10 +9 @@",
    "-    expect(x).toBe(2)",
    "+  expect(x).toBe(2)",
  ].join("\n");
  const changes = assertionChanges([
    { file: "a.test.js", status: "M", diff },
    { file: "b.test.js", status: "D", content: "test('kept', () => { expect(y).toBe(3) })\n" },
  ]);
  assert.deepEqual(changes.removed.map((r) => [r.file, r.removed]), [["a.test.js", "expect(saved).toEqual({ a: 1 })"], ["b.test.js", "test('kept', () => { expect(y).toBe(3) })"]]);
  assert.deepEqual(changes.loosened, [{ file: "a.test.js", removed: "expect(total).toBe(42)", replacement: "expect(total).toBeDefined()" }]);
  assert.equal(changes.moved, 1);
  const verdict = assertionVerdict(changes);
  assert.equal(verdict.block, true);
  assert.match(verdict.reason, /^3 assertions \(2 removed, 1 loosened\)/);
  assert.equal(verdict.lines.length, 3);
  assert.equal(assertionVerdict(changes, { allowTestRemoval: true }).block, false);
});

test("an assertion moved to a new test file, or replaced by an equally strict one, is fine", () => {
  const changes = assertionChanges([
    { file: "old.test.js", status: "D", content: "expect(sum(1, 2)).toBe(3)\n" },
    { file: "new.test.js", status: "A", content: "  expect(sum(1, 2)).toBe(3)\n" },
    { file: "c.test.js", status: "M", diff: "@@ -1 +1 @@\n-expect(f()).toBe(1)\n+expect(f()).toBe(2)\n" },
  ]);
  assert.equal(assertionVerdict(changes), null);
});

test("removed assertions refuse the commit through applySpecChecks; allowed ones only flag", () => {
  const checks = { notes: [], assertionVerdict: { block: true, reason: "1 assertion (1 removed)", lines: ["a.test.js: removed `expect(x).toBe(1)` with no replacement"] } };
  const done = { outcome: "WORKER_DONE", commitAllowed: true, reviewRequired: false, reasons: [] };
  const blocked = applySpecChecks(done, checks, { done: ["WORKER_DONE"] });
  assert.equal(blocked.commitAllowed, false);
  assert.equal(blocked.outcome, "NEEDS_REVIEW");
  assert.match(blocked.commitBlockedReason, /assertions removed or loosened/);
  assert.match(blocked.reasons[0], /^ASSERTIONS REMOVED: .*\n  - a\.test\.js: removed/);
  const allowed = applySpecChecks(done, { notes: [], assertionVerdict: { ...checks.assertionVerdict, block: false } }, { done: ["WORKER_DONE"] });
  assert.equal(allowed.commitAllowed, true);
  assert.equal(allowed.reviewRequired, true);
});

// ---- frozen tests and tests-first ------------------------------------------

test("frozen paths must stay inside the repository", () => {
  assert.deepEqual(normalizeFrozenPaths(["./tests/a.test.js", "tests/e2e/", "tests/a.test.js"]).paths, ["tests/a.test.js", "tests/e2e/"]);
  assert.equal(normalizeFrozenPaths(["../x.test.js", "/etc/passwd"]).problems.length, 2);
  assert.deepEqual(missingFrozen(["tests/a.test.js", "tests/e2e/", "tests/gone.test.js"], ["tests/a.test.js", "tests/e2e/b.spec.ts"]), ["tests/gone.test.js"]);
});

test("editing, renaming or deleting a frozen test refuses the commit", () => {
  const frozen = ["tests/a.test.js", "tests/e2e/"];
  const nameStatus = [
    { status: "M", path: "tests/a.test.js" },
    { status: "D", path: "tests/e2e/flow.spec.ts" },
    { status: "R100", path: "tests/moved.spec.ts", oldPath: "tests/e2e/other.spec.ts" },
    { status: "M", path: "src/app.js" },
  ];
  assert.deepEqual(frozenViolations(frozen, nameStatus), [
    { file: "tests/a.test.js", how: "edited" },
    { file: "tests/e2e/flow.spec.ts", how: "deleted" },
    { file: "tests/e2e/other.spec.ts", how: "renamed to tests/moved.spec.ts" },
  ]);
  const outcome = applyFrozenTests({ outcome: "WORKER_DONE", commitAllowed: true, reasons: [] }, { frozen, nameStatus, verificationStatus: "pass", done: ["WORKER_DONE"] });
  assert.equal(outcome.commitAllowed, false);
  assert.equal(outcome.outcome, "NEEDS_REVIEW");
  assert.match(outcome.reasons[0], /^FROZEN TEST CHANGED: frozen tests changed: tests\/a\.test\.js \(edited\)/);
});

test("frozen tests untouched but not shown passing still refuse; passing and untouched commits", () => {
  const ok = { outcome: "WORKER_DONE", commitAllowed: true, reasons: [] };
  const nameStatus = [{ status: "M", path: "src/app.js" }];
  assert.equal(applyFrozenTests(ok, { frozen: ["tests/a.test.js"], nameStatus, verificationStatus: "not_run", done: ["WORKER_DONE"] }).commitAllowed, false);
  assert.equal(applyFrozenTests(ok, { frozen: ["tests/a.test.js"], nameStatus, verificationStatus: "pass", done: ["WORKER_DONE"] }), ok);
  assert.equal(applyFrozenTests(ok, { frozen: [], nameStatus, verificationStatus: "fail" }), ok);
});

test("a tests-first report is valid with done and TESTS fail, and nothing else changes", () => {
  const report = parseWorkerReport("STATUS: done\nTESTS: fail\nNOT_DONE: none\nNOTE: three tests fail on the missing total");
  assert.equal(report.valid, false);
  assert.equal(testsFirstReport(report).valid, true);
  const passing = parseWorkerReport("STATUS: done\nTESTS: pass\nNOT_DONE: none\nNOTE: x");
  assert.equal(testsFirstReport(passing), passing);
});

test("a tests-first job commits only failing tests with no production change", () => {
  const report = testsFirstReport(parseWorkerReport("STATUS: done\nTESTS: fail\nNOT_DONE: none\nNOTE: x"));
  const tests = { new_tests_added: ["tests/total.test.js"], existing_tests_modified: [], production_files_changed: [] };
  const good = testsFirstOutcome({ report, testChanges: tests, verification: { status: "fail" } });
  assert.equal(good.outcome, "WORKER_DONE");
  assert.equal(good.commitAllowed, true);
  const cases = [
    [{ ...tests, production_files_changed: ["src/total.js"] }, { status: "fail" }, /production files changed \(src\/total\.js\)/],
    [{ new_tests_added: [], existing_tests_modified: [], production_files_changed: [] }, { status: "fail" }, /no test file/],
    [tests, { status: "pass" }, /already pass/],
    [tests, { status: "not_run" }, /aren't shown to fail/],
  ];
  for (const [testChanges, verification, why] of cases) {
    const outcome = testsFirstOutcome({ report, testChanges, verification });
    assert.equal(outcome.commitAllowed, false);
    assert.match(outcome.commitBlockedReason, why);
  }
  assert.equal(testsFirstOutcome({ report, testChanges: tests, verification: { status: "fail" }, workerTimedOut: true }).outcome, "WORKER_TIMEOUT");
});

test("frozen_tests_from takes a finished tests-first job's commit and tests", () => {
  const record = { testsFirst: true, commit: { created: true, sha: "abc123" }, testChanges: { new_tests_added: ["tests/a.test.js"], existing_tests_modified: ["tests/b.test.js"] }, worker: { provider: "xai", model: "grok-4.7" } };
  assert.deepEqual(frozenFromTestsFirst(record), { commit: "abc123", tests: ["tests/a.test.js", "tests/b.test.js"], vendor: { provider: "xai", model: "grok-4.7" } });
  assert.match(frozenFromTestsFirst({ ...record, testsFirst: undefined }).problem, /isn't a tests-first job/);
  assert.match(frozenFromTestsFirst({ ...record, commit: { created: false } }).problem, /no commit/);
  assert.match(frozenFromTestsFirst(null).problem, /no record/);
});

// ---- surface map -----------------------------------------------------------

test("a changed exported definition is found by its line range, before or after", () => {
  const head = "import x from 'y';\nexport function VoteButton(p) {\n  return 1;\n}\nexport const other = 2;\n";
  assert.deepEqual(exportedRanges("src/VoteButton.tsx", head).map((r) => [r.name, r.start, r.end]), [["VoteButton", 2, 4], ["other", 5, 6]]);
  assert.deepEqual(touchedLines("@@ -3 +3 @@\n-  return 0;\n+  return 1;\n"), { oldLines: [3], newLines: [3] });
  assert.deepEqual(changedSurface({ file: "src/VoteButton.tsx", diff: "@@ -3 +3 @@\n-  return 0;\n+  return 1;\n", headText: head, baseText: head }).symbols, ["VoteButton"]);
  assert.deepEqual(changedSurface({ file: "app.py", diff: "@@ -2 +2 @@\n-    return 0\n+    return 1\n", headText: "def tally(v):\n    return 1\n", baseText: "def tally(v):\n    return 0\n" }).symbols, ["tally"]);
});

test("changed SSE events are found in files that use server-sent events", () => {
  const head = "const es = new EventSource('/stream');\nes.addEventListener('vote.cast', on);\n";
  const surface = changedSurface({ file: "client.js", diff: "@@ -2 +2 @@\n-es.addEventListener('vote.added', on);\n+es.addEventListener('vote.cast', on);\n", headText: head, baseText: head });
  assert.deepEqual(surface.events.sort(), ["vote.added", "vote.cast"]);
  assert.deepEqual(changedSurface({ file: "x.js", diff: "@@ -1 +1 @@\n-emit('a')\n+emit('b')\n", headText: "emit('b')\n", baseText: "emit('a')\n" }).events, []);
});

test("uses outside the diff need the worker's account; the flag names each unaccounted file", () => {
  const head = "export function VoteButton(p) {\n  return 1;\n}\n";
  const items = surfaceUses({
    files: [{ file: "src/VoteButton.tsx", diff: "@@ -2 +2 @@\n-  return 0;\n+  return 1;\n", headText: head, baseText: head }],
    changedFiles: ["src/VoteButton.tsx", "src/Page.tsx"],
    references: () => ({ hits: [{ path: "src/Page.tsx", line: 3 }, { path: "src/Results.tsx", line: 9 }, { path: "src/Admin.tsx", line: 1 }, { path: "src/VoteButton.test.tsx", line: 1 }] }),
    isTestPath,
  });
  assert.deepEqual(items, [{ kind: "symbol", name: "VoteButton", definedIn: "src/VoteButton.tsx", usedIn: ["src/Results.tsx", "src/Admin.tsx"], truncated: false }]);
  const unaccounted = accountFor(items, "src/Results.tsx: not affected because it only reads the label\n");
  assert.deepEqual(unaccounted[0].usedIn, ["src/Admin.tsx"]);
  assert.match(surfaceVerdict(items, unaccounted).reason, /^1 file\(s\) use what this diff changed .*VoteButton \(changed in src\/VoteButton\.tsx\) is also used in src\/Admin\.tsx/);
  assert.equal(surfaceVerdict(items, accountFor(items, "src/Results.tsx: changed\nsrc/Admin.tsx: changed")), null);
});

// ---- scope guard -----------------------------------------------------------

test("a removed class, a removed hook and a changed default are listed unless the brief names them", () => {
  const diff = [
    "@@ -3 +3 @@",
    "-  <div className=\"vote-row sticky-header\" aria-label=\"Votes\" data-testid=\"votes\">",
    "+  <div className=\"vote-row\" data-testid=\"votes\">",
    "@@ -9 +9 @@",
    "-function Votes({ limit = 10, compact = false }) {",
    "+function Votes({ limit = 20, compact = false }) {",
  ].join("\n");
  const items = unrequestedChanges({ files: [{ file: "src/Votes.tsx", diff }, { file: "src/votes.css", diff: "@@ -1,3 +0,0 @@\n-.sticky-header {\n-  position: sticky;\n-}\n" }], brief: "Show the vote count next to each option" });
  assert.deepEqual(items.map((i) => i.detail), ['CSS class "sticky-header" removed', 'aria-label="Votes" removed', "limit: 10 became 20", 'CSS rule for ".sticky-header" removed']);
  assert.deepEqual(unrequestedChanges({ files: [{ file: "src/Votes.tsx", diff }], brief: "Drop the sticky-header class, remove aria-label and raise limit to 20" }), []);
  assert.match(scopeVerdict(items).reason, /^4 edit\(s\) the brief doesn't mention/);
  assert.equal(scopeVerdict([]), null);
});

// ---- reload ----------------------------------------------------------------

test("a UI change touching saved data needs a reload test or a written reason", () => {
  const ui = { file: "src/components/Votes.tsx", status: "M", diff: "@@ -1 +1 @@\n-const v = useState(0)\n+const v = useQuery(['votes'], fetchVotes)\n" };
  const missing = reloadCheck({ files: [ui], isTestPath });
  assert.equal(missing.satisfied, false);
  assert.match(missing.reason, /src\/components\/Votes\.tsx/);
  const withTest = reloadCheck({ files: [ui, { file: "src/components/Votes.test.tsx", status: "M", diff: "@@ -5 +5,2 @@\n+  it('shows saved votes after reload', async () => {\n+    await page.reload()\n" }], isTestPath });
  assert.deepEqual(withTest, { required: true, satisfied: true, by: ["src/components/Votes.test.tsx"] });
  assert.equal(reloadCheck({ files: [ui], isTestPath, accountingText: "RELOAD: no test because the view has no saved state yet" }).satisfied, true);
  assert.equal(reloadCheck({ files: [{ file: "src/components/Label.tsx", status: "M", diff: "@@ -1 +1 @@\n-<b>a</b>\n+<b>b</b>\n" }], isTestPath }), null);
  assert.equal(reloadCheck({ files: [{ file: "src/components/Label.tsx", status: "M", diff: "@@ -1 +1 @@\n-<b>a</b>\n+<b>b</b>\n" }], isTestPath, eventsChanged: true }).satisfied, false);
});

// ---- spec checks end to end (in-memory repository) ---------------------------

test("runSpecChecks reads the record and reports each gap", async () => {
  const head = { "src/Votes.tsx": "export function Votes({ limit = 20 }) {\n  return <div className=\"row\">{fetchVotes()}</div>;\n}\n", ".openclaw/accounting.md": "src/Page.tsx: changed\n" };
  const base = { "src/Votes.tsx": "export function Votes({ limit = 10 }) {\n  return <div className=\"row pinned\">{fetchVotes()}</div>;\n}\n", "tests/votes.test.js": "test('pins', () => { expect(pinned()).toBe(true) })\n" };
  const diffs = { "src/Votes.tsx": "@@ -1,2 +1,2 @@\n-export function Votes({ limit = 10 }) {\n-  return <div className=\"row pinned\">{fetchVotes()}</div>;\n+export function Votes({ limit = 20 }) {\n+  return <div className=\"row\">{fetchVotes()}</div>;\n" };
  const checks = await runSpecChecks({
    record: { nameStatus: [{ status: "M", path: "src/Votes.tsx" }, { status: "D", path: "tests/votes.test.js" }] },
    diffOf: async (f) => diffs[f], readBase: async (f) => base[f] ?? null, readHead: (f) => head[f] ?? null,
    references: () => ({ hits: [{ path: "src/Page.tsx", line: 2 }, { path: "src/Other.tsx", line: 4 }] }),
    isTestPath, brief: "Show the vote count",
  });
  assert.equal(checks.assertionVerdict.block, true);
  assert.deepEqual(checks.surface.unaccounted.map((u) => u.usedIn), [["src/Other.tsx"]]);
  assert.deepEqual(checks.unrequested.map((u) => u.detail), ['CSS class "pinned" removed', "limit: 10 became 20"]);
  assert.equal(checks.reload.satisfied, false);
  const outcome = applySpecChecks({ outcome: "WORKER_DONE", commitAllowed: true, reviewRequired: false, reasons: [] }, checks, { done: ["WORKER_DONE"] });
  assert.deepEqual(outcome.reasons.map((r) => r.split(":")[0]), ["ASSERTIONS REMOVED", "SURFACE NOT ACCOUNTED FOR", "RELOAD NOT COVERED", "UNREQUESTED CHANGES"]);
  assert.equal(outcome.commitAllowed, false);
  const record = specChecksRecord(checks);
  assert.equal(record.assertions.blocked, true);
  assert.equal(record.surface.accounting, ".openclaw/accounting.md");
  assert.equal(specChecksRecord({ notes: [], assertions: { removed: [], loosened: [] }, surface: { items: [] }, unrequested: [], reload: null }), null);
});

// ---- judge -----------------------------------------------------------------

test("the judge for a job is the first candidate on neither the worker's nor the General's vendor", () => {
  const settings = { agent: "claude", model: "claude-opus-5-5", provider: "anthropic", candidates: [
    { agent: "claude", model: "claude-opus-5-5", provider: "anthropic" },
    { agent: "grok", model: "grok-4.7", provider: "xai" },
    { agent: "codex", model: "gpt-6-sol", provider: "openai-codex" },
  ] };
  const a = pickJudge(settings, { workerVendor: "openai", generalVendor: "anthropic" });
  assert.equal(a.settings.agent, "grok");
  assert.equal(a.overlap, null);
  assert.equal(judgeOverlapWarning(a), null);
  const b = pickJudge({ ...settings, candidates: settings.candidates.slice(0, 2) }, { workerVendor: "xai", generalVendor: "anthropic" });
  assert.equal(b.settings.agent, "claude", "prefers sharing the General's vendor over grading its own vendor's work");
  assert.deepEqual(b.overlap, { vendor: "anthropic", with: ["General"] });
  assert.match(judgeOverlapWarning(b), /^JUDGE NOT INDEPENDENT: claude\/claude-opus-5-5 shares the General's vendor \(anthropic\)\. Add a judge on another vendor under judge\.alternates/);
  assert.equal(pickJudge({ agent: "j", model: "m", provider: "xai" }, { workerVendor: "openai" }).overlap, null, "a judge without alternates still works");
});

test("judge alternates load from validators.yml, skipping unusable agents", (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "validators.yml"), "judge:\n  agent: claude\n  model: claude-opus-5-5\n  alternates:\n    - { agent: grok, model: grok-4.7 }\n    - { agent: local, model: x }\n    - { agent: missing, model: y }\n");
  const agents = { claude: { kind: "api", provider: "anthropic" }, grok: { kind: "subscription", provider: "xai" }, local: { kind: "local" } };
  const s = judgeSettings({ configDir: dir, agents, providerOf: (a) => a.provider, runsOnHost: () => false });
  assert.deepEqual(s.candidates.map((c) => c.agent), ["claude", "grok"]);
  assert.equal(s.skippedAlternates.length, 2);
});

// ---- visual ----------------------------------------------------------------

test("visual routes are checked, and the spec takes four screenshots per route", () => {
  assert.deepEqual(visualProblems({ routes: ["/votes", "votes", "/a b"] }).length, 2);
  assert.deepEqual(visualProblems({ routes: [] }).length, 1);
  assert.equal(routeSlug("/votes?tab=open"), "votes-tab-open");
  assert.equal(routeSlug("/"), "root");
  const spec = visualSpec({ routes: ["/votes"] });
  assert.match(spec, /colorScheme: s\.scheme/);
  assert.match(spec, /test-results\/nomarmy-visual\//);
  assert.deepEqual(expectedShots(["/votes"]), ["votes--light--desktop.png", "votes--dark--desktop.png", "votes--light--phone.png", "votes--dark--phone.png"]);
});

test("visual setup uses the repository's playwright config, or needs a server and URL", (t) => {
  const dir = tmp(t);
  assert.match(prepareVisual({ worktree: dir, visual: { routes: ["/"] } }).problem, /no playwright\.config/);
  assert.match(prepareVisual({ worktree: dir, visual: { routes: ["/"], server: "npm run dev" } }).problem, /base_url/);
  fs.writeFileSync(path.join(dir, "playwright.config.ts"), "export default {}\n");
  const prepared = prepareVisual({ worktree: dir, visual: { routes: ["/"] } });
  assert.equal(prepared.command, "npx --no-install playwright test --config .openclaw/nomarmy-visual/visual.config.ts");
  assert.match(fs.readFileSync(path.join(dir, ".openclaw/nomarmy-visual/visual.config.ts"), "utf8"), /import base from "\.\.\/\.\.\/playwright\.config";/);
});

test("the visual issue lists screenshots, missing ones and the reference", () => {
  const shots = screenshotsFrom({ artifacts: ["artifacts/test-results/nomarmy-visual/votes--light--desktop.png", "artifacts/test-results/other.txt"] }, "/jobs/j/visual");
  assert.deepEqual(shots, ["/jobs/j/visual/artifacts/test-results/nomarmy-visual/votes--light--desktop.png"]);
  const issue = visualIssue({ shots, expected: expectedShots(["/votes"]), reference: "design/votes.png", status: "pass" });
  assert.match(issue, /^VISUAL REVIEW: 1 screenshot\(s\).*3 didn't render.*approved design \(design\/votes\.png\)/);
  assert.match(visualIssue({ shots: [], expected: [], status: "not_run", reason: "no playwright.config" }), /^VISUAL CHECK DIDN'T RUN: no playwright\.config/);
});

test("a review scout is told to list every visible difference", () => {
  const note = referenceNote([{ visual: true, jobId: "j1", files: ["visual-j1/votes--dark--phone.png", "visual-j1/reference.png"], reference: ".openclaw/reference/visual-j1/reference.png" }]);
  assert.match(note, /VISUAL REVIEW: the reviewed job's screenshots are in \.openclaw\/reference\/visual-j1\/votes--dark--phone\.png, and the approved design is \.openclaw\/reference\/visual-j1\/reference\.png/);
  assert.match(note, /list every visible difference/);
});

// ---- auto correction -------------------------------------------------------

const mismatch = { mode: "implement", objective: "Show vote totals", reportMismatch: { report: "STATUS done, TESTS pass", verification: "fail", failingTests: ["votes total"] }, commit: { created: false }, verificationProfile: "quick" };

test("only a done/pass report that failed verification gets a correction round", () => {
  assert.equal(wantsAutoCorrection(mismatch), true);
  assert.equal(wantsAutoCorrection(mismatch, { autoCorrect: false }), false);
  assert.equal(wantsAutoCorrection(mismatch, { isCorrection: true }), false);
  assert.equal(wantsAutoCorrection({ ...mismatch, testsFirst: true }), false);
  assert.equal(wantsAutoCorrection({ ...mismatch, reportMismatch: null }), false);
});

test("the correction continues the failed job with the failing output, frozen tests kept", (t) => {
  const dir = tmp(t);
  const log = path.join(dir, "verification.log");
  fs.writeFileSync(log, `${"x".repeat(5000)}\nFAIL votes total: expected 3, got 2\n`);
  const args = { mode: "implement", task: "Show vote totals", evidence: "old", base_ref: "main", frozen_tests_from: "tf-1", auto_correct: true, verification: "quick", agentName: "grok", subscription_worker: "grok", on_behalf_of: "a@b.c", run_id: "run-x", acceptance: ["totals show"] };
  const corr = correctionArgs(args, "job-1", { ...mismatch, frozenTests: ["tests/votes.test.js"], independentVerification: { log } });
  assert.equal(corr.continue_from, "job-1");
  assert.equal(corr.autoCorrectionOf, "job-1");
  assert.equal(corr.auto_correct, false);
  assert.equal(corr.base_ref, undefined);
  assert.equal(corr.frozen_tests_from, undefined);
  assert.deepEqual(corr.frozen_tests, ["tests/votes.test.js"]);
  assert.deepEqual([corr.agentName, corr.on_behalf_of, corr.run_id, corr.verification], ["grok", "a@b.c", "run-x", "quick"]);
  assert.deepEqual(corr.acceptance, ["totals show"]);
  assert.match(corr.task, /Make verification profile 'quick' pass.*Failing: votes total\.\n\nORIGINAL OBJECTIVE\nShow vote totals$/s);
  assert.match(corr.evidence, /FAIL votes total: expected 3, got 2/);
  assert.ok(corr.evidence.length <= 6000);
});

test("the correction's state lands on the failed job's record, and the caller gets the correction's result", (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify({ outcome: "NEEDS_REVIEW", autoCorrection: { state: "pending" } }));
  assert.equal(recordAutoCorrection(dir, { state: "running", jobId: "job-2" }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8")).autoCorrection.jobId, "job-2");
  const r = correctedResult({ report: "first" }, { report: "second", manifest: { issues: ["x"] } }, "job-1");
  assert.match(r.report, /^AUTO-CORRECTED: job job-1 .*\n\nsecond$/s);
  assert.equal(r.manifest.autoCorrectionOf, "job-1");
  assert.equal(r.manifest.issues.length, 2);
});

test("test boilerplate doesn't count as a reload test, and uses count only in code of the same family", async () => {
  const ui = { file: "src/components/Votes.tsx", status: "M", diff: "@@ -1 +1 @@\n-const v = 0\n+const v = useQuery(['votes'], fetchVotes)\n" };
  const boilerplate = { file: "src/components/Votes.test.tsx", status: "A", content: "afterEach(() => { cleanup(); vi.restoreAllMocks(); });\nit('shows votes', () => { view.unmount(); });\n" };
  assert.equal(reloadCheck({ files: [ui, boilerplate], isTestPath }).satisfied, false, "a real Senti job passed on restoreAllMocks and unmount");
  const titled = { file: "src/components/Votes.test.tsx", status: "A", content: "it(\"reload reconstructs the chosen meaning from saved history\", () => {});\n" };
  assert.equal(reloadCheck({ files: [ui, titled], isTestPath }).satisfied, true);
  const { sameFamily } = await import("../lib/surface-map.mjs");
  assert.equal(sameFamily("ui/A.tsx", "ui/B.ts"), true);
  assert.equal(sameFamily("ui/A.tsx", "docs/A.md"), false);
  assert.equal(sameFamily("ui/A.tsx", "tools/a.py"), false);
  assert.equal(sameFamily("ui/A.tsx", "server/stream.py", "event"), true, "an event name crosses languages");
});
