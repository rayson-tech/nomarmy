import "./helpers/isolate-global-config.mjs";
// Tests for lib/sabotage.mjs, built from the real Senti jobs that did this
// (project details replaced). Run: node --test tests/sabotage.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { addedLinesOf, detectTestSabotage, loadDependencyNames } from "../lib/sabotage.mjs";

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
