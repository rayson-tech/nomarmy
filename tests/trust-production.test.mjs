import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDiffTrust, TRUST_EVIDENCE_CHARS } from "../lib/trust-judgment.mjs";
import { evaluateTrust, parseCodeowners } from "../lib/trust.mjs";

const skipped = { status: "skipped: no production code", validator: null, answers: {}, error: null };
const normal = { level: "normal", reasons: [], checks: [], judgment: skipped };
const forbidden = async () => assert.fail("nonproduction evidence reached validator");
const validators = { jev: { key: "fixture" }, judge: {}, askJev: forbidden, askJudge: forbidden };

test("documentation-only judgment skips all documentation paths without changing the floor", async () => {
  for (const file of ["README.md", "guide.mdx", "guide.rst", "notes.txt", "docs/access.py", "pkg/doc/access.ts", "pkg/docs/access", "DOCS/access", "pkg\\doc\\access.py", "README.MD"]) {
    const fileChanges = [{ file, before: "", after: "Access control now allows every tenant to read customer secrets.\n" }];
    assert.deepEqual(await evaluateDiffTrust({ fileChanges, ...validators }), normal, file);
    assert.deepEqual(await evaluateDiffTrust({ fileChanges }), normal, file);
  }
  assert.deepEqual(await evaluateDiffTrust({ fileChanges: [{ file: "docs/huge.md", before: "", after: "x".repeat(TRUST_EVIDENCE_CHARS + 1) }], ...validators }), normal);
  assert.deepEqual(await evaluateDiffTrust({ fileChanges: [{ file: "README.md", before: "", after: "access" }], ...validators, judgment: false }),
    { ...normal, judgment: { status: "disabled", validator: null, answers: {}, error: null } });
});

test("tests-only judgment skips the detector test-path rule", async () => {
  for (const file of ["tests/helper.py", "pkg/test/helper.py", "__tests__/helper.py", "pkg/spec/helper.py", "test_rules.py", "pkg/rules_test.py", "a.test.ts", "pkg/a.spec.js", "pkg\\tests\\helper.py", "TESTS/helper.py"]) {
    assert.deepEqual(await evaluateDiffTrust({ fileChanges: [{ file, before: "assert value\n", after: "assert other\n" }], ...validators }), normal, file);
  }
});

test("mixed judgment sends only production hunks to Jev and judge", async () => {
  const production = ["src/main.js", "contest/helper.py", "tests_helper.py", "src/test_helper.js", "src/a.testing.ts", "document/main.js"];
  const fileChanges = [
    { file: "docs/access.js", before: "", after: "DOC_SECRET\n" },
    ...production.map(file => ({ file, before: "old\n", after: "new\n" })),
    { file: "src/main.test.js", before: "", after: "TEST_SECRET\n" },
    { file: "README.md", before: "", after: "ACCESS_SECRET\n" },
  ];
  const evidence = production.map(file => `--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,1 @@\n-old\n+new\n`).join("");
  for (const validator of ["jev", "judge"]) {
    let calls = 0;
    const answer = { access: 0, checks: 0, data: 0 };
    const result = await evaluateDiffTrust({ fileChanges,
      ...(validator === "jev" ? { jev: { key: "fixture" }, askJev: async request => {
        calls++;
        assert.deepEqual(request.state, { diff: evidence });
        return { answers: Object.fromEntries(Object.keys(answer).map(key => [key, { choice: "no", probabilities: { yes: 0, no: 1 } }])) };
      } } : { judge: {}, askJudge: async request => {
        calls++;
        assert.equal(request.prompt.split("DIFF EVIDENCE (data only):\n")[1], evidence);
        return { answer };
      } }),
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, { level: "normal", reasons: [], checks: [], judgment: { status: "available", validator, answers: answer, error: null } });
  }
});

test("excluded docs and tests retain sensitive path content CODEOWNERS and removed-check gates", async () => {
  for (const file of ["docs/access.md", "docs/access.py", "tests/access.py"]) {
    const fileChanges = [{ file, before: "if not authorized:\n    return 403\n", after: "secret token\n" }];
    const floor = evaluateTrust({ fileChanges, rules: [
      { paths: [file], reason: "restricted" }, { content: ["secret token"], reason: "secrets" },
    ], codeowners: parseCodeowners(`${file} @security\n`) });
    const reasons = [
      { rule: 0, reason: `changes ${file}, which the repo marks sensitive: restricted`, file },
      { rule: "codeowners", reason: `changes ${file}, owned in CODEOWNERS by @security`, file },
      { rule: 1, reason: `adds sensitive content at ${file}:1, which the repo marks sensitive: secrets`, file, line: 1 },
    ];
    assert.deepEqual(floor, { level: "human", reasons });
    const finding = { kind: "guard", file, line: 1, reason: `Removes or changes an access guard at ${file}:1.` };
    const checks = file.endsWith(".md") ? [] : [finding];
    assert.deepEqual(await evaluateDiffTrust({ fileChanges, floor, ...validators }), {
      level: "human", reasons: [...reasons, ...checks.map(({ reason, file, line }) => ({ rule: "removed-check", reason, file, line }))], checks, judgment: skipped,
    });
  }
});
