import test from "node:test";
import assert from "node:assert/strict";
import { failingTestNames } from "../lib/verify.mjs";
import { claimsNoChange, parseWorkerReport } from "../lib/report.mjs";
import { resolveOutcome } from "../lib/outcome.mjs";

test("failingTestNames: names from node, TAP, jest, vitest and pytest output, deduplicated and capped", () => {
  const node = "✔ keeps working (1.2ms)\n✖ rejects an empty name (3.4ms)\n✖ failing tests:\n\n✖ rejects an empty name (3.4ms)";
  assert.deepEqual(failingTestNames(node), ["rejects an empty name"]);
  assert.deepEqual(failingTestNames("ok 1 - a\nnot ok 2 - b fails\nnot ok 3 - c # SKIP later"), ["b fails"]);
  assert.deepEqual(failingTestNames("  ● parser › handles unicode\n"), ["parser › handles unicode"]);
  assert.deepEqual(failingTestNames(" FAIL  src/city.test.ts > routes > 404s\n"), ["src/city.test.ts > routes > 404s"]);
  assert.deepEqual(failingTestNames("FAILED tests/test_api.py::test_login - AssertionError"), ["tests/test_api.py::test_login"]);
  assert.equal(failingTestNames(Array.from({ length: 9 }, (_, i) => `not ok ${i} - t${i}`).join("\n")).length, 5);
  // A crash or a cleanup failure names no test.
  assert.deepEqual(failingTestNames("npm error Lifecycle script `test` failed with error:\nnpm error code 1"), []);
});

test("a done/pass report with failed verification carries a structured mismatch with the failing tests", () => {
  const report = parseWorkerReport("STATUS: done\nTESTS: pass\nNOT_DONE: none\nNOTE: fixed");
  const out = resolveOutcome({ report, repositoryChanged: true, independentVerification: { status: "fail", detail: "npm test failed", failingTests: ["rejects an empty name"] } });
  assert.deepEqual(out.reportMismatch, { report: "STATUS done, TESTS pass", verification: "fail", failingTests: ["rejects an empty name"] });
  assert.equal(out.commitAllowed, false);
});

test("claimsNoChange: catches 'No code changed' and its variants, not ordinary notes", () => {
  for (const note of ["No code changed.", "no changes needed", "Nothing was changed", "I did not change anything", "no files changed"]) assert.equal(claimsNoChange({ NOTE: note }), true, note);
  for (const note of ["Changed the parser", "no regressions", "Added tests; no new dependencies"]) assert.equal(claimsNoChange({ NOTE: note }), false, note);
  assert.equal(claimsNoChange({ NOT_DONE: "none" }), false);
});
