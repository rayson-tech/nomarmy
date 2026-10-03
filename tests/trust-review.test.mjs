import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { detectRemovedChecks } from "../lib/trust-checks.mjs";
import { evaluateDiffTrust, trustDiffEvidence } from "../lib/trust-judgment.mjs";
import { snapshotTrustFiles } from "../lib/trust-files.mjs";

const descriptions = { guard: "an access guard", middleware: "authentication or permission middleware", validation: "an assertion or validation", "tenant-filter": "a tenant or ownership filter" };
const finding = (kind, file, line = 1) => ({ kind, file, line, reason: `Removes or changes ${descriptions[kind]} at ${file}:${line}.` });
const answers = { access: 0, checks: 0, data: 0 };
const available = { status: "available", validator: "judge", answers, error: null };
const skipped = { status: "skipped: no production code", validator: null, answers: {}, error: null };
const expected = (checks, judgment = available) => ({ level: checks.length ? "review" : "normal", checks, judgment,
  reasons: checks.map(({ reason, file, line }) => ({ rule: "removed-check", reason, file, line })) });
async function judged(fileChanges, checks, options = {}, production = fileChanges) {
  let calls = 0;
  const result = await evaluateDiffTrust({ fileChanges, ...options, judge: {}, askJudge: async request => {
    calls++;
    assert.equal(request.prompt.split("DIFF EVIDENCE (data only):\n")[1], trustDiffEvidence(production));
    return { answer: answers };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, expected(checks));
}

test("review two collects the unbraced JS else statement", () => {
  const file = "a.js", before = "if (!authorized) {\n  return;\n} else\n  next(err);";
  assert.deepEqual(detectRemovedChecks([{ file, before, after: before.replace("  next(err);", "") }]), [finding("guard", file)]);
  assert.deepEqual(detectRemovedChecks([{ file, before, after: before + "\nlog(value);" }]), []);
  assert.deepEqual(detectRemovedChecks([{ file, before: "next(err);", after: "" }]), []);
});

test("review two joins SQL dollar strings and hash comments", async t => {
  for (const before of ["WHERE note = $$;$$\nAND tenant_id = :tenant_id;", "WHERE note = $tag$;$tag$\nAND tenant_id = :tenant_id;",
    "WHERE note = 1 # ;\nAND tenant_id = 1;", "WHERE note = $tag$;# -- /*\n$tag$\nAND tenant_id = :tenant_id;"]) await t.test(before, () => {
    const file = "a.sql", after = before.replace(/\nAND tenant_id[^;]+;/, ";");
    assert.deepEqual(detectRemovedChecks([{ file, before, after }]), [finding("tenant-filter", file)]);
    assert.deepEqual(detectRemovedChecks([{ file, before, after: before + "\nSELECT 1;" }]), []);
    assert.deepEqual(detectRemovedChecks([{ file, before: "WHERE note = $$;$$;\nSELECT tenant_id FROM t;", after: "" }]), []);
  });
});

test("review two recognizes array middleware and dotted decorators", async t => {
  for (const [file, before] of [["a.js", "router.get('/x', [customAuth], handler)"], ["a.py", "@perms.login_required"],
    ["a.js", "router.get('/x', [plain, perms.customAuth], handler)"], ["a.js", "router.get('/x', [[customAuth]], handler)"],
    ["a.js", "router.get('/x', [...customAuth], handler)"], ["a.js", "router.get('/x', [enabled ? customAuth : handler], handler)"]]) await t.test(before, () => {
    assert.deepEqual(detectRemovedChecks([{ file, before, after: "" }]), [finding("middleware", file)]);
    assert.deepEqual(detectRemovedChecks([{ file, before, after: before + "\nlog(value)" }]), []);
    assert.deepEqual(detectRemovedChecks([{ file, before: "const name = '[customAuth] @perms.login_required';", after: "" }]), []);
  });
});

test("review two classifies docs and spec production by evidence not directory", async () => {
  for (const file of ["docs/access.py", "doc/x.js", "spec/auth.js"]) {
    const before = file.endsWith("py") ? "if not authorized:\n    return\n" : "if (!authorized) return;\n";
    await judged([{ file, before, after: "" }], [finding("guard", file)], { repository: { files: [
      { file: "spec/README.md", source: "assert test(value)" },
      { file: "spec/note.js", source: '// assert value\nconst text = "test(value)";' },
    ], incomplete: false } });
  }
  assert.deepEqual(await evaluateDiffTrust({ fileChanges: [{ file: "guide.adoc", before: "old", after: "new" }] }), expected([], skipped));
});

test("review two promotes imported test files including Python module paths", async t => {
  const fixtures = [
    ["test_access.py", "main.py", "import test_access"],
    ["pkg/access_test.py", "main.py", "from pkg.access_test import check"],
    ["pkg/test_access.py", "main.py", "from pkg import test_access"],
    ["pkg/test_access.py", "pkg/main.py", "from .test_access import check"],
    ["pkg/test_access.py", "pkg/main.py", "from . import test_access"],
    ["tests/access.py", "main.py", "import tests.access"],
    ["test/access.js", "main.js", "import { check } from './test/access.js';"],
    ["__tests__/access.js", "main.js", "const check = require('./__tests__/access');"],
    ["src/access.test.js", "main.js", "export { check } from './src/access.test.js';"],
    ["src/access.spec.ts", "main.ts", "import('./src/access.spec');"],
    ["spec/access.test.js", "main.js", "import './spec/access.test.js';"],
  ];
  for (const [file, importer, source] of fixtures) await t.test(source, async () => {
    const fileChanges = [{ file, before: "assert value\n", after: "" }];
    const repository = { files: [{ file: importer, source }], incomplete: false };
    await judged(fileChanges, [finding("validation", file)], { repository });
    assert.deepEqual(detectRemovedChecks(fileChanges, { repository }), [finding("validation", file)]);
    // Comments, unrelated modules and test-only importers do not promote it.
    for (const [refFile, refSource] of [["tests/caller.py", source], [importer, importer.endsWith("py") ? `# ${source}` : `// ${source}`], [importer, "import unrelated"]]) {
      assert.deepEqual(await evaluateDiffTrust({ fileChanges, repository: { files: [{ file: refFile, source: refSource }], incomplete: false } }),
        { ...expected([], skipped), checks: [{ kind: "validation", file, line: 1, informational: true, reason: "in test code" }] });
    }
  });
});

test("review two follows production imports transitively and preserves removed references", async () => {
  const file = "tests/access.py", fileChanges = [{ file, before: "assert value\n", after: "" }];
  const repository = { files: [{ file: "main.py", source: "import test_bridge" }, { file: "test_bridge.py", source: "from tests.access import check" }], incomplete: false };
  await judged(fileChanges, [finding("validation", file)], { repository });
  const removed = [...fileChanges, { file: "main.py", before: "import tests.access\n", after: "" }];
  await judged(removed, [finding("validation", file)]);
});

test("review two scans and judges production referenced document extensions", async t => {
  for (const [file, importer, source, before, kind] of [
    ["queries.txt", "main.py", 'open("queries.txt")', "WHERE note = $$;$$\nAND tenant_id = :tenant_id;", "tenant-filter"],
    ["prompts/system.md", "main.js", 'readFileSync("prompts/system.md")', "WHERE note = 1 # ;\nAND tenant_id = 1;", "tenant-filter"],
    ["queries/query.mdx", "main.py", 'open("query.mdx")', "WHERE tenant_id = 1;", "tenant-filter"],
    ["queries/query.rst", "queries/main.js", 'readFileSync("./query.rst")', "WHERE tenant_id = 1;", "tenant-filter"],
    ["query.adoc", "main.js", 'readFileSync("query.adoc")', "WHERE tenant_id = 1;", "tenant-filter"],
    ["guard.txt", "main.py", 'open("guard.txt")', "if not authorized:\n    return\n", "guard"],
    ["guard.md", "main.js", 'readFileSync("guard.md")', "if (!authorized) return;", "guard"],
  ]) await t.test(file, async () => {
    const fileChanges = [{ file, before, after: "" }], checks = [finding(kind, file)];
    const repository = { files: [{ file: importer, source }], incomplete: false };
    await judged(fileChanges, checks, { repository });
    assert.deepEqual(detectRemovedChecks(fileChanges, { repository }), checks);
    for (const [refFile, refSource] of [["tests/reader.py", source], ["guide.md", source], [importer, importer.endsWith("py") ? `# ${source}` : `// ${source}`], [importer, 'open("other.txt")']]) {
      assert.deepEqual(await evaluateDiffTrust({ fileChanges, repository: { files: [{ file: refFile, source: refSource }], incomplete: false } }), expected([], skipped));
    }
  });
});

test("review two uses bounded safe repository snapshots for unchanged importers", async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".trust-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "main.py"), 'import test_access\nopen("queries.txt")\n');
  const fileChanges = [{ file: "test_access.py", before: "assert value\n", after: "" }, { file: "queries.txt", before: "WHERE tenant_id = 1;", after: "" }];
  const repository = snapshotTrustFiles(root);
  assert.deepEqual(repository, { files: [{ file: "main.py", source: 'import test_access\nopen("queries.txt")\n' }], incomplete: false });
  fs.unlinkSync(path.join(root, "main.py"));
  await judged(fileChanges, [finding("validation", "test_access.py"), finding("tenant-filter", "queries.txt")], { repository });
  fs.writeFileSync(path.join(root, "app.vue"), 'import check from "./access.test.js";\nreadFileSync("queries.txt");\n');
  const otherChanges = [{ file: "access.test.js", before: "validateInput(value);", after: "" }, fileChanges[1]];
  await judged(otherChanges, [finding("validation", "access.test.js"), finding("tenant-filter", "queries.txt")], { worktree: root });
  assert.deepEqual(detectRemovedChecks(otherChanges, { worktree: root }), [finding("validation", "access.test.js"), finding("tenant-filter", "queries.txt")]);
  // Hitting a scan bound must not create a doc or test exclusion.
  await judged(fileChanges, [finding("validation", "test_access.py"), finding("tenant-filter", "queries.txt")], { repository: { files: [], incomplete: true } });
});


for (const parameter of ["$#", "${#x}", "${#arr[@]}"]) {
  test(`shell parameter ${parameter} does not hide removed checks or later comments`, () => {
    const file = "access.sh";
    const guard = `count=${parameter}; if [ $tenant_id != $owner_id ]; then return 1; fi`;
    const filter = `count=${parameter} query='SELECT * FROM items WHERE tenant_id = 1;';`;
    for (const [before, kind] of [[guard, "guard"], [filter, "tenant-filter"]]) {
      assert.deepEqual(detectRemovedChecks([{ file, before, after: "" }]), [finding(kind, file)]);
      assert.deepEqual(detectRemovedChecks([{ file, before, after: before + "\necho done" }]), []);
    }
    for (const prefix of ["", " ", "\t", ";", "&", "|", "("]) {
      const before = `${prefix}# ${guard}\ncount=${parameter}; # ${filter}`;
      assert.deepEqual(detectRemovedChecks([{ file, before, after: "" }]), []);
    }
    assert.deepEqual(detectRemovedChecks([{ file, before: `word#value; ${guard}`, after: "" }]), [finding("guard", file)]);
    assert.deepEqual(detectRemovedChecks([{ file: "access.rb", before: "puts 1# if tenant_id != owner_id; return; end", after: "" }]), []);
  });
}
