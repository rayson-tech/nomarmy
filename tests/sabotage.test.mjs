import "./helpers/isolate-global-config.mjs";
// Tests for lib/sabotage.mjs, built from the real Senti jobs that did this
// (project details replaced). Run: node --test tests/sabotage.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { addedLinesOf, detectTestSabotage, HUNK_BREAK, loadDependencyNames } from "../lib/sabotage.mjs";

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const isTest = (p) => /(^|\/)tests?\//.test(p) || /(^|\/)test_[^/]+\.py$/.test(p);

test("detectTestSabotage: the rejected Senti job -- a stubbed import, skipped tests and a fake pytest.py", () => {
  const out = detectTestSabotage({
    isTestPathFn: isTest,
    dependencyNames: ["sqlglot", "pytest"],
    changes: [
      { status: "M", path: "lambda/answer_table.py", addedLines: ["try:", "    import sqlglot", "    from sqlglot import exp", "except Exception:  # stub when sqlglot unavailable", "    sqlglot = None"] },
      { status: "M", path: "lambda/tests/test_answer_table.py", addedLines: ['SKIP = unittest.skip("Skipping due to missing sqlglot")'] },
      { status: "M", path: "lambda/tests/test_gate.py", addedLines: ["@unittest.skipIf('sqlglot' not in globals(), \"sqlglot not available\")"] },
      { status: "A", path: "pytest.py", addedLines: ["def main(): pass"] },
    ],
  });
  assert.equal(out.flags.length, 4, out.flags.join("\n"));
  assert.match(out.flags[0], /^stubbed import: production code in lambda\/answer_table\.py/);
  assert.match(out.flags[1], /^skip marker: lambda\/tests\/test_answer_table\.py/);
  assert.match(out.flags[3], /^shadow module: new file pytest\.py is named like the dependency "pytest"/);
  assert.match(out.reason, /made to pass rather than the code made to work/);
});

test("detectTestSabotage: stray backup copies left in the repo", () => {
  const out = detectTestSabotage({ isTestPathFn: isTest, changes: [
    { status: "A", path: ".sampling-gate-backup/athena_adapter.py", addedLines: ["x = 1"] },
    { status: "A", path: "src/app.py.orig", addedLines: [] },
    { status: "A", path: "notes~", addedLines: [] },
  ] });
  assert.equal(out.flags.filter((f) => f.startsWith("stray backup")).length, 3);
});

test("detectTestSabotage: skip markers across languages", () => {
  const lines = ["@pytest.mark.skip(reason='x')", "pytest.importorskip('sqlglot')", "it.skip('works', () => {})", "xit('works')", "t.Skip(\"later\")", "#[ignore]", "@Disabled"];
  for (const l of lines) {
    assert.ok(detectTestSabotage({ isTestPathFn: () => true, changes: [{ status: "M", path: "tests/t", addedLines: [l] }] }), l);
  }
});

test("detectTestSabotage: ordinary changes are not flagged", () => {
  assert.equal(detectTestSabotage({ isTestPathFn: isTest, dependencyNames: ["requests"], changes: [
    { status: "M", path: "src/app.py", addedLines: ["import requests", "def fetch():", "    try:", "        return requests.get(u)", "    finally:", "        log()"] },
    { status: "A", path: "tests/test_app.py", addedLines: ["def test_fetch(): assert fetch()"] },
    { status: "A", path: "src/client.py", addedLines: ["x = None"] },
    { status: "M", path: "tests/test_other.py", addedLines: ["# we used to skip this"] },
  ] }), null);
});

test("addedLinesOf: only added lines, never the file header", () => {
  assert.deepEqual(addedLinesOf("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n+more"), ["new", "more"]);
});

test("loadDependencyNames: requirements files, pyproject and package.json, at the root and one level down", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-deps-")); dirs.push(dir);
  fs.writeFileSync(path.join(dir, "requirements-dev.txt"), "pytest>=8\n# comment\nruff==0.6\n");
  fs.mkdirSync(path.join(dir, "lambda"));
  fs.writeFileSync(path.join(dir, "lambda", "requirements.txt"), "sqlglot[rs]~=25.0\nboto3\n");
  fs.writeFileSync(path.join(dir, "pyproject.toml"), '[project]\ndependencies = [\n  "pydantic>=2",\n]\n');
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { "@aws-sdk/client-s3": "1" }, devDependencies: { vitest: "1" } }));
  const names = loadDependencyNames(dir);
  for (const n of ["pytest", "ruff", "sqlglot", "boto3", "pydantic", "client_s3", "vitest"]) assert.ok(names.has(n), n);
});

test("detectTestSabotage: a lazy import inside a try that also does the work is not a stub (the Senti false positive)", () => {
  assert.equal(detectTestSabotage({ isTestPathFn: isTest, changes: [
    { status: "M", path: "lambda/discovery_complete.py", addedLines: [
      "    # Restore returning tables even when locked enrichment skips their upsert.",
      "    try:",
      "        from table_catalog_embed import clear_missing_marks",
      "",
      "        clear_missing_marks(org_id, warehouse_id, current_qualified)",
      "    except Exception as e:",
      "        print(f\"[complete] clear missing marks failed (non-fatal): {e}\")",
    ] },
  ] }), null);
});

test("addedLinesOf: a break between hunks, never before the first or after the last", () => {
  assert.deepEqual(addedLinesOf("--- a/x\n+++ b/x\n@@ -1 +1 @@\n+a\n@@ -9 +9 @@\n-old\n@@ -20 +20 @@\n+b"), ["a", HUNK_BREAK, "b"]);
});

test("detectTestSabotage: an import added in one hunk and an except changed in another is not a stub (the pin_library false positive)", () => {
  const diff = [
    "--- a/lambda/board_pins.py", "+++ b/lambda/board_pins.py",
    "@@ -3,0 +4 @@", "+from pin_library import load_pins",
    "@@ -40 +41 @@", "-    except Exception:", "+    except Exception as e:",
    "@@ -41 +42 @@", "-        return []", "+        log.warning(\"pins unavailable: %s\", e)",
  ].join("\n");
  assert.equal(detectTestSabotage({ isTestPathFn: isTest, changes: [{ status: "M", path: "lambda/board_pins.py", addedLines: addedLinesOf(diff) }] }), null);
  // The same except directly under an added import in one hunk is still a stub.
  const stub = ["--- a/x.py", "+++ b/x.py", "@@ -3,0 +4,3 @@", "+    import sqlglot", "+except Exception:", "+    sqlglot = None"].join("\n");
  const out = detectTestSabotage({ isTestPathFn: isTest, changes: [{ status: "M", path: "lambda/x.py", addedLines: addedLinesOf(stub) }] });
  assert.match(out.flags[0], /^stubbed import: production code in lambda\/x\.py/);
});

// Regressions from the detector audit: each case the detector missed, or
// flagged wrongly, next to a near miss that must stay quiet.
const flagsOf = (changes, dependencyNames = []) => detectTestSabotage({ isTestPathFn: isTest, dependencyNames, changes })?.flags ?? [];
const one = (p, addedLines, status = "M") => [{ status, path: p, addedLines }];

test("detectTestSabotage: a module-level pytestmark skip is a skip marker", () => {
  assert.match(flagsOf(one("tests/test_x.py", ["pytestmark = pytest.mark.skip(reason='flaky')"]))[0], /^skip marker: tests\/test_x\.py/);
  assert.match(flagsOf(one("tests/test_x.py", ["pytestmark = [pytest.mark.skipif(sys.platform == 'win32', reason='x')]"]))[0], /^skip marker/);
  assert.deepEqual(flagsOf(one("tests/test_x.py", ["pytestmark = pytest.mark.django_db", "def test_only_admins(): assert only_admins()"])), []);
});

test("detectTestSabotage: .only, fit and fdescribe are focus markers in JS tests", () => {
  for (const l of ["describe.only('suite', () => {", "it.only('x', () => {})", "test.only('x', () => {})", "test.only.each([1])('x', () => {})", "fit('x', () => {})", "fdescribe(\"suite\", () => {"]) {
    const flags = flagsOf(one("tests/a.test.ts", [l]));
    assert.equal(flags.length, 1, l);
    assert.match(flags[0], /^focus marker: tests\/a\.test\.ts runs only these tests/, l);
  }
  assert.deepEqual(flagsOf(one("tests/a.test.ts", [
    "it(\"only shows admins\", () => {", "describe(\"skip logic\", () => {", "const r = fitModel(data);", "model.fit('x');", "expect(only).toBe(true);",
  ])), []);
  // Python has no focus markers: a test named for "only" is just a name.
  assert.deepEqual(flagsOf(one("tests/test_x.py", ["def test_only_admins():", "    fit('x')"])), []);
});

test("detectTestSabotage: Go t.Skipf and t.SkipNow are skip markers", () => {
  assert.match(flagsOf(one("tests/a_test.go", ["\tt.Skipf(\"no db: %v\", err)"]))[0], /^skip marker/);
  assert.match(flagsOf(one("tests/a_test.go", ["\tt.SkipNow()"]))[0], /^skip marker/);
  assert.deepEqual(flagsOf(one("tests/a_test.go", ["\tif t.Skipped() { return }", "\tt.Logf(\"skip %d\", n)"])), []);
});

test("detectTestSabotage: vitest/jest skipIf, skip.each and todo are skip markers", () => {
  for (const l of ["test.skipIf(process.env.CI)('x', () => {})", "it.skipIf(!db)('x', () => {})", "describe.skip.each([1])('x', () => {})", "test.todo('later')"]) {
    assert.match(flagsOf(one("tests/a.test.ts", [l]))[0] ?? "", /^skip marker/, l);
  }
  assert.deepEqual(flagsOf(one("tests/a.test.ts", ["test('skips empty rows', () => {", "const todo = test.todoList;", "describe('todo list', () => {"])), []);
});

test("detectTestSabotage: node:test skip/todo options and t.skip()/t.todo() are skip markers", () => {
  for (const l of ["test('x', { skip: true }, () => {})", "test('x', { skip: 'no db' }, () => {})", "it('x', { todo: true }, () => {})", "  t.skip('later');", "  t.todo();"]) {
    assert.match(flagsOf(one("tests/a.test.mjs", [l]))[0] ?? "", /^skip marker/, l);
  }
  assert.deepEqual(flagsOf(one("tests/a.test.mjs", [
    "test('x', { skip: false }, () => {})", "const page = await list({ skip: 10, take: 5 });", "const items = [{ todo: 'buy milk' }];",
  ])), []);
  // Skip markers are only checked in test files: production code may skip.
  assert.deepEqual(flagsOf(one("src/pager.js", ["const skip = true;", "rows.skip(10);", "test('x', { skip: true })"])), []);
  assert.deepEqual(flagsOf(one("src/pager.py", ["skip = True", "pytestmark = pytest.mark.skip"])), []);
});

test("detectTestSabotage: raise SkipTest is a skip marker", () => {
  assert.match(flagsOf(one("tests/test_x.py", ["    raise unittest.SkipTest('no db')"]))[0], /^skip marker/);
  assert.match(flagsOf(one("tests/test_x.py", ["    raise SkipTest('no db')"]))[0], /^skip marker/);
  assert.deepEqual(flagsOf(one("tests/test_x.py", ["    raise SkipTestError('x')", "    # SkipTest was removed"])), []);
});

test("detectTestSabotage: a deleted test file is flagged", () => {
  assert.deepEqual(flagsOf([{ status: "D", path: "tests/test_auth.py", addedLines: [] }]), ["deleted test: tests/test_auth.py removed"]);
  // A deleted production file, or a deleted test fixture that is not code, is not.
  assert.deepEqual(flagsOf([{ status: "D", path: "src/auth.py", addedLines: [] }, { status: "D", path: "tests/fixtures/rows.json", addedLines: [] }]), []);
});

test("detectTestSabotage: a parenthesized multi-line import inside try is a stub", () => {
  const flags = flagsOf(one("app/x.py", ["try:", "    from sqlglot import (", "        parse,", "        exp,", "    )", "except Exception:", "    parse = None"]));
  assert.match(flags[0], /^stubbed import: production code in app\/x\.py/);
  // The same import followed by real work is a lazy import, not a stub.
  assert.deepEqual(flagsOf(one("app/x.py", ["try:", "    from sqlglot import (", "        parse,", "    )", "    parse(q)", "except Exception:", "    log()"])), []);
});

test("detectTestSabotage: a one-line try: import is a stub", () => {
  assert.match(flagsOf(one("app/x.py", ["try: import sqlglot", "except Exception:", "    pass"]))[0], /^stubbed import/);
  assert.deepEqual(flagsOf(one("app/x.py", ["try: run(job)", "except Exception:", "    log()"])), []);
});

test("detectTestSabotage: a new package named like a dependency shadows it", () => {
  for (const p of ["sqlglot/__init__.py", "src/sqlglot/__init__.pyi", "lib/sqlglot/index.js", "sqlglot/index.ts"]) {
    assert.match(flagsOf(one(p, ["x = 1"], "A"), ["sqlglot"])[0] ?? "", /^shadow module: new file .* "sqlglot"/, p);
  }
  assert.deepEqual(flagsOf([...one("app/__init__.py", ["x = 1"], "A"), ...one("src/index.ts", ["x"], "A"), ...one("sqlglot_helpers/__init__.py", ["x"], "A")], ["sqlglot"]), []);
});

test("detectTestSabotage: a JS try around only require() or import() is a stub", () => {
  const cases = [
    ["try { require('sqlglot') } catch {}"],
    ["let sqlglot;", "try {", "  sqlglot = require('sqlglot');", "} catch (e) {", "  sqlglot = null;", "}"],
    ["try {", "  const { parse } = await import(\"sqlglot\");", "} catch (e) {"],
  ];
  for (const lines of cases) assert.match(flagsOf(one("src/x.js", lines))[0] ?? "", /^stubbed import: production code in src\/x\.js/, lines.join(" / "));
  assert.match(flagsOf(one("src/x.ts", cases[1]))[0] ?? "", /^stubbed import/);
  // A try that also does the work, or one that never loads a module, is not a stub.
  assert.deepEqual(flagsOf(one("src/x.js", ["try {", "  const m = require('sqlglot');", "  m.parse(q);", "} catch (e) {", "  log(e);", "}"])), []);
  assert.deepEqual(flagsOf(one("src/x.js", ["try { JSON.parse(s) } catch { return null }"])), []);
  // JS-only: the same text in a Python or text file is not checked as JS.
  assert.deepEqual(flagsOf(one("docs/notes.md", cases[1])), []);
});

test("detectTestSabotage: backup copies are flagged, feature names that mention backup are not", () => {
  for (const p of ["src/foo.py.bak", "src/foo.bak", "src/foo.orig", "src/foo.py~", "src/foo.old", "src/foo.backup", "src/foo_backup.py", "src/fooBackup.ts", "src/foo-backup-2.py", "src/foo copy.py", "src/foo copy 2.py", "src/foo - Copy.py", ".sampling-gate-backup/athena_adapter.py"]) {
    assert.match(flagsOf(one(p, [], "A"))[0] ?? "", /^stray backup/, p);
  }
  assert.deepEqual(flagsOf(["src/services/backup-scheduler.ts", "src/cors.origins.ts", "src/backups.py", "src/BackupService.ts", "src/backup/restore.py", "src/clipboard-copy.ts", "src/deep_copy.py", "src/threshold.py"].flatMap((p) => one(p, ["x"], "A"))), []);
  // Only new files: an existing backup-looking file that was edited is not new.
  assert.deepEqual(flagsOf(one("src/foo.py.bak", ["x"], "M")), []);
});
