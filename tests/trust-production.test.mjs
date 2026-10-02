import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDiffTrust, TRUST_EVIDENCE_CHARS } from "../lib/trust-judgment.mjs";
import { evaluateTrust, parseCodeowners } from "../lib/trust.mjs";

const skipped = { status: "skipped: no production code", validator: null, answers: {}, error: null };
const normal = { level: "normal", reasons: [], checks: [], judgment: skipped };
const forbidden = async () => assert.fail("nonproduction evidence reached validator");
const validators = { jev: { key: "fixture" }, judge: {}, askJev: forbidden, askJudge: forbidden };

test("documentation-only judgment skips all documentation paths without changing the floor", async () => {
  for (const file of ["README.md", "guide.mdx", "guide.rst", "notes.txt", "guide.adoc", "README.MD"]) {
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
    assert.deepEqual(await evaluateDiffTrust({ fileChanges: [{ file, before: "assert value\n", after: "assert other\n" }], ...validators }), { ...normal, checks: [{ kind: "validation", file, line: 1, informational: true, reason: "in test code" }] }, file);
  }
});

test("mixed judgment sends only production hunks to Jev and judge", async () => {
  const production = ["src/main.js", "contest/helper.py", "tests_helper.py", "src/test_helper.js", "src/a.testing.ts", "document/main.js", "docs/access.py", "doc/x.js", "spec/auth.js", "pkg/docs/access", "pkg\\doc\\access.py"];
  const fileChanges = [
    ...production.map(file => ({ file, before: "old\n", after: "new\n" })),
    { file: "src/main.test.js", before: "", after: "TEST_SECRET\n" },
    { file: "README.md", before: "", after: "ACCESS_SECRET\n" },
  ];
  const evidence = production.map(file => `--- a/${file.replaceAll("\\", "\\\\")}\n+++ b/${file.replaceAll("\\", "\\\\")}\n@@ -1,1 +1,1 @@\n-old\n+new\n`).join("");
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
  for (const file of ["README.md", "docs/access.md", "tests/access.py", "docs/access.py", "foo_test.py", "queries.txt"]) {
    const production = ["docs/access.py", "foo_test.py", "queries.txt"].includes(file);
    const repository = { files: [{ file: "main.py", source: 'import foo_test\nopen("queries.txt")\n' }], incomplete: false };
    let calls = 0;
    const answers = { access: 0, checks: 0, data: 0 };
    const askJev = production ? async request => {
      calls++;
      assert.deepEqual(request.state, { diff: `--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,1 @@\n-if not authorized:\n-    return 403\n+secret token\n` });
      return { answers: Object.fromEntries(Object.keys(answers).map(key => [key, { choice: "no", probabilities: { yes: 0, no: 1 } }])) };
    } : forbidden;
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
    const checks = file.endsWith(".md") ? [] : [file === "tests/access.py"
      ? { ...finding, informational: true, reason: "in test code" } : finding];
    assert.deepEqual(await evaluateDiffTrust({ fileChanges, floor, repository, ...validators, askJev }), {
      level: "human", reasons: [...reasons, ...checks.filter(check => !check.informational).map(({ reason, file, line }) => ({ rule: "removed-check", reason, file, line }))], checks, judgment: production ? { status: "available", validator: "jev", answers, error: null } : skipped,
    });
    assert.equal(calls, production ? 1 : 0, file);
  }
});

test("test-only middleware is informational but production imports and guards still escalate", async () => {
  const middleware = "router.get('/x', requireAuth, handler);";
  const disabled = { status: "disabled", validator: null, answers: {}, error: null };
  for (const file of ["ui/components/admin/__tests__/sourceOwnershipActions.test.tsx", "src/access.test.ts"]) {
    const fileChanges = [{ file, before: "\n".repeat(94) + middleware, after: "" }];
    const check = { kind: "middleware", file, line: 95, reason: `Removes or changes authentication or permission middleware at ${file}:95.` };
    assert.deepEqual(await evaluateDiffTrust({ fileChanges, ...validators }), {
      ...normal, checks: [{ ...check, informational: true, reason: "in test code" }],
    });
    const repository = { files: [{ file: "main.ts", source: `import './${file}';` }], incomplete: false };
    assert.deepEqual(await evaluateDiffTrust({ fileChanges, repository, judgment: false }), {
      level: "review", reasons: [{ rule: "removed-check", file, line: 95, reason: check.reason }], checks: [check], judgment: disabled,
    });
  }
  const file = "src/access.ts", reason = "Removes or changes an access guard at src/access.ts:1.";
  assert.deepEqual(await evaluateDiffTrust({ fileChanges: [{ file, before: "if (!authorized) return 403;", after: "" }], judgment: false }), {
    level: "review", reasons: [{ rule: "removed-check", file, line: 1, reason }],
    checks: [{ kind: "guard", file, line: 1, reason }], judgment: disabled,
  });
});

test("all test-only detector kinds are informational without bypassing reach", async () => {
  for (const [file, before, kind] of [
    ["tests/access.js", "if (!authorized) return 403;", "guard"],
    ["tests/access.js", "router.get('/x', requireAuth, handler);", "middleware"],
    ["tests/access.js", "validateInput(value);", "validation"],
    ["tests/query.sql", "SELECT * FROM data WHERE tenant_id = 1;", "tenant-filter"],
    ["tests/policy.sql", "ALTER TABLE data ENABLE ROW LEVEL SECURITY;", "rls"],
  ]) {
    const fileChanges = [{ file, before, after: "" }];
    const checks = [{ kind, file, line: 1, informational: true, reason: "in test code" }];
    assert.deepEqual(await evaluateDiffTrust({ fileChanges, ...validators }), { ...normal, checks });
    const reach = { baseCommit: "fixture", key: "fixture", heuristic: true, depth: 3, fanOut: 25, caps: [],
      boundaries: [{ entry: { file, symbol: "*", category: "access" }, nodes: [] }] };
    assert.deepEqual(await evaluateDiffTrust({ fileChanges, reach, ...validators }), {
      level: "human", reasons: [{ rule: "trust-reach", file, line: 1, reason: `removes a check in mapped file ${file}, the access boundary` }],
      checks, judgment: skipped, reach: { baseCommit: "fixture", key: "fixture", heuristic: true, depth: 3, fanOut: 25, caps: [] },
    });
    assert.deepEqual(await evaluateDiffTrust({ fileChanges: [{ file, before, after: before + "\n-- unrelated" }], ...validators }), normal);
  }
});

test("unsupported import languages keep test-named production guards judged and escalating", async () => {
  const files = ["foo_test.rb", ...["rb", "php", "go", "rs", "java", "kt", "cs", "sh", "c", "h", "cpp", "hpp", "swift"].map(ext => `src/access.test.${ext}`)];
  for (const file of files) {
    const before = "if (!authorized)\n  return 403\nend\n";
    const fileChanges = [{ file, before, after: "" }];
    const answers = { access: 0, checks: 0, data: 0 };
    let calls = 0;
    const result = await evaluateDiffTrust({ fileChanges, jev: { key: "fixture" }, askJev: async request => {
      calls++;
      assert.deepEqual(request.state, { diff: `--- a/${file}\n+++ b/${file}\n@@ -1,3 +0,0 @@\n-if (!authorized)\n-  return 403\n-end\n` });
      return { answers: Object.fromEntries(Object.keys(answers).map(key => [key, { choice: "no", probabilities: { yes: 0, no: 1 } }])) };
    } });
    const reason = `Removes or changes an access guard at ${file}:1.`;
    assert.deepEqual(result, {
      level: "review", reasons: [{ rule: "removed-check", reason, file, line: 1 }],
      checks: [{ kind: "guard", file, line: 1, reason }],
      judgment: { status: "available", validator: "jev", answers, error: null },
    }, file);
    assert.equal(calls, 1, file);
  }
});

test("test directories and Go toolchain tests retain informational guards without judgment", async () => {
  for (const file of ["test/foo_test.rb", "tests/foo_test.rb", "__tests__/foo_test.rb", "spec/foo.test.rb", "x_test.go", "pkg/x_test.go"]) {
    // spec/ retains its existing requirement for test syntax or a test name.
    const before = file.endsWith(".go") ? "if !authorized { return 403 }\n" : "if (!authorized)\n  return 403\nend\n";
    assert.deepEqual(await evaluateDiffTrust({ fileChanges: [{ file, before, after: "" }], ...validators }), {
      ...normal, checks: [{ kind: "guard", file, line: 1, informational: true, reason: "in test code" }],
    }, file);
  }
});
