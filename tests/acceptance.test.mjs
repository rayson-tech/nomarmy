// Contract checks must fail on drift, not silently lose a feature's evidence.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
import { contractSchema, loadContract, loadContracts, checkContract, contractDisplayPath } from "../lib/acceptance.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "bin/nomarmy.mjs");
const env = { ...process.env, NOMARMY_WINDOWS_ENGINE: "native" };
delete env.NODE_TEST_CONTEXT;
const criterion = (id, proven_by = [], extra = {}) => ({ id, text: `Promise ${id}`, proven_by, status: "met", ...extra });
const contract = (criteria) => ({ feature: "Example", criteria });
const expected = (id, status, failures = [], security = false) => ({ id, text: `Promise ${id}`, status, security, failures });
const ref = (name) => ({ file: "tests/example.test.mjs", test: name });
const totals = (changes = {}) => ({ met: 0, broken: 0, missing: 0, unproven: 0, retired: 0, ...changes });

function fixture(t) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-acceptance-"));
  t.after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoDir, "tests"));
  fs.writeFileSync(path.join(repoDir, "tests/example.test.mjs"), `
import test from "node:test";
import assert from "node:assert/strict";
test('passes: (a+b) [x]. "quoted"', () => assert.equal(2 + 2, 4));
test("fails", () => assert.equal(2 + 2, 5));
test("passes but must not be selected", () => assert.fail("unrelated"));
for (const name of ["alpha", "beta"]) test(\`loop: \${name} (works)\`, () => assert.equal(true, true));
test.skip("skipped", () => assert.fail("skipped"));
// ghost name appears in source, but is not a test.
`);
  const write = (data, name = "example.yml") => {
    fs.mkdirSync(path.join(repoDir, "acceptance"), { recursive: true });
    const file = path.join(repoDir, "acceptance", name);
    fs.writeFileSync(file, YAML.stringify(data));
    return file;
  };
  const invoke = (...args) => spawnSync(process.execPath, [cli, "acceptance", "check", ...args], {
    cwd: repoDir, env, encoding: "utf8",
  });
  return { repoDir, write, invoke };
}

const literal = 'passes: (a+b) [x]. "quoted"';

test("acceptance schema validates fields and reports file and criterion IDs", (t) => {
  const f = fixture(t);
  const valid = { ...contract([criterion("ACC-1", [ref(literal), { command: "echo ok", cwd: "." }], { security: true, note: "context" })]), run: "run-1", pr: 118 };
  assert.deepEqual(contractSchema.parse(valid), valid);
  assert.deepEqual(loadContract(f.write(valid)), { file: path.join(f.repoDir, "acceptance/example.yml"), ...valid });
  const invalid = [
    [criterion("ACC-1", [], { status: "unknown" })],
    [criterion("ACC-1", [], { security: "yes" })],
    [criterion("ACC-1", [], { text: 42 })],
    [criterion("ACC-1", [{ file: "x" }])],
    [criterion("ACC-1", [{ command: "ok", test: "mixed" }])],
    [criterion("ACC-1"), criterion("ACC-1")],
    [criterion("bad-id")],
  ];
  for (const criteria of invalid) {
    const file = f.write(contract(criteria));
    assert.throws(() => loadContract(file), (error) => {
      assert.equal(error.message.includes(file), true);
      assert.equal(error.message.includes(criteria[0].id), true);
      return true;
    });
  }
  const file = f.write(contract([criterion("ACC-1")]));
  fs.writeFileSync(file, "criteria: [");
  assert.throws(() => loadContract(file), (error) => error.message.includes(file));
});

test("acceptance loading handles missing folders and sorts only yml contracts", (t) => {
  const f = fixture(t);
  assert.deepEqual(loadContracts(f.repoDir), []);
  const b = contract([criterion("B-1")]), a = contract([criterion("A-1")]);
  const bFile = f.write(b, "b.yml"), aFile = f.write(a, "a.yml");
  f.write({ deliberately: "invalid" }, "ignored.yaml");
  assert.deepEqual(loadContracts(f.repoDir), [{ file: aFile, ...a }, { file: bFile, ...b }]);
});

test("acceptance runs literal names with punctuation and loop prefixes only", (t) => {
  const f = fixture(t);
  const criteria = [criterion("ACC-1", [ref(literal)], { status: "broken", security: true }), criterion("ACC-2", [ref("loop: ${name} (works)")])];
  assert.deepEqual(checkContract(contract(criteria), f), [expected("ACC-1", "met", [], true), expected("ACC-2", "met")]);
});

test("acceptance detects failing tests and zero executed tests", (t) => {
  const f = fixture(t);
  for (const name of ["fails", "ghost name", "skipped"]) {
    const [result] = checkContract(contract([criterion("ACC-1", [ref(name)])]), f);
    assert.deepEqual(Object.keys(result).sort(), ["failures", "id", "security", "status", "text"]);
    assert.equal(result.status, "broken");
    assert.equal(result.failures.length, 1);
    assert.deepEqual(Object.keys(result.failures[0]).sort(), ["detail", "file", "test"]);
    assert.equal(result.failures[0].file, ref(name).file);
    assert.equal(result.failures[0].test, name);
    if (name === "fails") assert.match(result.failures[0].detail, /not ok \d+ - fails/);
    else assert.equal(result.failures[0].detail, "no tests passed (zero tests ran or all were skipped/todo)");
  }
  const [mixed] = checkContract(contract([criterion("ACC-1", [ref(literal), ref("fails")])]), f);
  assert.equal(mixed.status, "broken");
  assert.deepEqual(mixed.failures.map(({ file, test }) => ({ file, test })), [ref("fails")]);
});

test("acceptance detects renamed tests and deleted files before running", (t) => {
  const f = fixture(t);
  const reference = ref("old test name");
  const data = contract([criterion("ACC-3", [reference])]);
  const run = () => assert.fail("missing references must not execute");
  assert.deepEqual(checkContract(data, { ...f, run }), [expected("ACC-3", "missing", [{
    ...reference, detail: "ACC-3: tests/example.test.mjs: old test name: test name is absent from the source",
  }])]);
  fs.unlinkSync(path.join(f.repoDir, reference.file));
  const [result] = checkContract(data, { ...f, run });
  assert.equal(result.status, "missing");
  assert.equal(result.failures.length, 1);
  assert.deepEqual(Object.keys(result.failures[0]).sort(), ["detail", "file", "test"]);
  assert.equal(result.failures[0].file, reference.file);
  assert.equal(result.failures[0].test, reference.test);
  assert.match(result.failures[0].detail, /^ACC-3: tests\/example.test.mjs: old test name: ENOENT/);
});

test("acceptance preserves retired criteria and computes unproven without execution", (t) => {
  const f = fixture(t);
  const data = contract([criterion("ACC-1"), criterion("ACC-2", [{ command: "never run" }], { status: "retired", security: true })]);
  assert.deepEqual(checkContract(data, { ...f, run: () => assert.fail("must not execute") }), [
    expected("ACC-1", "unproven"), expected("ACC-2", "retired", [], true),
  ]);
});

test("acceptance executes command evidence with the shell and requested cwd", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repoDir, "tests/command.cjs"), 'if (!process.cwd().endsWith("tests")) process.exit(9);\n');
  const command = 'node command.cjs';
  const bad = 'node -e "process.exit(7)"';
  const data = contract([criterion("ACC-1", [{ command, cwd: "tests" }]), criterion("ACC-2", [{ command: bad }])]);
  assert.deepEqual(checkContract(data, f), [expected("ACC-1", "met"), expected("ACC-2", "broken", [{ command: bad, detail: "process exited 7" }])]);
});

test("acceptance batches node references once per criterion and exposes spawn failures", (t) => {
  const f = fixture(t);
  const calls = [];
  const run = (...args) => { calls.push(args); return { status: 0, stdout: `ok 1 - ${literal}\nok 2 - loop: alpha (works)\n# pass 2\n` }; };
  const data = contract([criterion("ACC-1", [ref(literal), ref("loop: ${name} (works)"), { command: "echo ok" }])]);
  assert.deepEqual(checkContract(data, { ...f, run }), [expected("ACC-1", "met")]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], ["--test", "--test-reporter=tap", "--test-name-pattern", '^passes: \\(a\\+b\\) \\[x\\]\\. "quoted"$|^loop: ', path.join(f.repoDir, ref(literal).file)]);
  assert.deepEqual(Object.keys(calls[0][2]).sort(), ["cwd", "encoding", "env", "maxBuffer"]);
  assert.equal(calls[0][2].cwd, f.repoDir);
  assert.equal(calls[0][2].encoding, "utf8");
  assert.equal(calls[0][2].env.NODE_TEST_CONTEXT, undefined);
  assert.equal(calls[0][2].maxBuffer, 16 * 1024 * 1024);
  assert.deepEqual(calls[1], ["echo ok", [], { ...calls[0][2], shell: true }]);
  for (const run of [() => ({ status: null, error: new Error("spawn failed") }), () => { throw new Error("spawn failed"); }]) {
    assert.deepEqual(checkContract(contract([criterion("ACC-1", [ref(literal)])]), { ...f, run }), [expected("ACC-1", "broken", [{ ...ref(literal), detail: "spawn failed" }])]);
  }
});

test("acceptance CLI JSON and plain output agree; strict fails on unproven", (t) => {
  assert.equal(contractDisplayPath(root, path.join(root, "acceptance\\example.yml")), "acceptance/example.yml");
  const f = fixture(t);
  const data = contract([criterion("ACC-1", [ref(literal)]), criterion("ACC-2", [], { note: "manual review" }), criterion("ACC-3", [], { status: "retired" })]);
  f.write(data);
  const json = f.invoke("--json");
  assert.equal(json.status, 0, json.stderr || json.stdout);
  const report = { contracts: [{ file: "acceptance/example.yml", feature: "Example", criteria: [expected("ACC-1", "met"), expected("ACC-2", "unproven"), expected("ACC-3", "retired")] }], totals: totals({ met: 1, unproven: 1, retired: 1 }) };
  assert.deepEqual(JSON.parse(json.stdout), report);
  const plain = f.invoke();
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, `acceptance/example.yml: Example\nACC-1  met\nACC-2  unproven  manual review\nACC-3  retired\nTotal: 1 met, 0 broken, 0 missing, 1 unproven, 1 retired\n`);
  const strict = f.invoke("--strict", "--json");
  assert.equal(strict.status, 1);
  assert.deepEqual(JSON.parse(strict.stdout), report);
});

test("acceptance CLI aligns status columns per contract without non-TTY colors", (t) => {
  assert.equal(contractDisplayPath(root, path.join(root, "acceptance\\first.yml")), "acceptance/first.yml");
  const f = fixture(t);
  f.write(contract([criterion("A-1", [ref(literal)]), criterion("LONG-22", [])]), "first.yml");
  f.write(contract([criterion("SECOND-1", [ref(literal)]), criterion("B-2", [])]), "second.yml");
  const plain = f.invoke();
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, `acceptance/first.yml: Example\nA-1      met\nLONG-22  unproven\nacceptance/second.yml: Example\nSECOND-1  met\nB-2       unproven\nTotal: 2 met, 0 broken, 0 missing, 2 unproven, 0 retired\n`);
  assert.equal(/\x1b\[/.test(plain.stdout), false);
});

test("acceptance CLI fails broken and missing criteria and honors explicit files", (t) => {
  assert.equal(contractDisplayPath(root, path.join(root, "acceptance\\good.yml")), "acceptance/good.yml");
  const f = fixture(t);
  f.write(contract([criterion("BAD-1", [ref("fails")])]), "broken.yml");
  f.write(contract([criterion("MISS-1", [ref("renamed")])]), "missing.yml");
  f.write(contract([criterion("GOOD-1", [ref(literal)])]), "good.yml");
  for (const [file, id, name, status] of [["broken.yml", "BAD-1", "fails", "broken"], ["missing.yml", "MISS-1", "renamed", "missing"]]) {
    const selected = `acceptance/${file}`;
    const result = f.invoke(selected, "--json");
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(report).sort(), ["contracts", "totals"]);
    assert.equal(report.contracts.length, 1);
    assert.deepEqual(Object.keys(report.contracts[0]).sort(), ["criteria", "feature", "file"]);
    assert.equal(report.contracts[0].file, selected);
    assert.equal(report.contracts[0].criteria.length, 1);
    assert.equal(report.contracts[0].criteria[0].id, id);
    assert.equal(report.contracts[0].criteria[0].status, status);
    assert.equal(report.contracts[0].criteria[0].failures[0].test, name);
    assert.deepEqual(report.totals, totals({ [status]: 1 }));
    const plain = f.invoke(selected);
    assert.equal(plain.status, 1);
    assert.equal(plain.stdout, `${selected}: Example\n${id}  ${status.toUpperCase()}  tests/example.test.mjs: ${name}\nTotal: ${Object.entries(totals({ [status]: 1 })).map(([key, count]) => `${count} ${key}`).join(", ")}\n`);
  }
  const good = f.invoke("acceptance/good.yml", "--strict", "--json");
  assert.equal(good.status, 0);
  assert.deepEqual(JSON.parse(good.stdout), { contracts: [{ file: "acceptance/good.yml", feature: "Example", criteria: [expected("GOOD-1", "met")] }], totals: totals({ met: 1 }) });
});

test("acceptance CLI handles empty repos and validation errors", (t) => {
  const f = fixture(t);
  const empty = f.invoke("--json");
  assert.equal(empty.status, 0);
  assert.deepEqual(JSON.parse(empty.stdout), { contracts: [], totals: totals() });
  f.write(contract([criterion("ACC-1", [], { status: "invalid" })]));
  const invalid = f.invoke("--json");
  assert.equal(invalid.status, 1);
  const report = JSON.parse(invalid.stdout);
  assert.deepEqual(Object.keys(report), ["error"]);
  assert.equal(report.error.includes(path.join(f.repoDir, "acceptance/example.yml")), true);
  assert.equal(report.error.includes("ACC-1"), true);
});

test("acceptance real Windows contract returns 13 met and only WIN-12 unproven", () => {
  const data = loadContract(path.join(root, "acceptance/windows-first-class.yml"));
  const results = checkContract(data, { repoDir: root });
  assert.deepEqual(results, data.criteria.map((item) => ({
    id: item.id, text: item.text, status: item.id === "WIN-12" ? "unproven" : "met", security: item.security ?? false, failures: [],
  })));
  assert.equal(results.filter((item) => item.status === "met").length, 13);
  assert.deepEqual(results.filter((item) => item.status === "unproven").map((item) => item.id), ["WIN-12"]);
});

test("acceptance CI checks every platform job", () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"));
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["test", "windows"]);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job["runs-on"], name === "windows" ? "windows-latest" : "ubuntu-latest");
    assert.equal(job.steps.filter((step) => step.run === "node bin/nomarmy.mjs acceptance check").length, 1, name);
  }
});

test("acceptance validates proof platforms for both reference types", (t) => {
  const f = fixture(t);
  const valid = contract([criterion("ACC-7", [
    { ...ref(literal), platforms: ["darwin", "linux", "win32", "posix"] },
    { command: "echo ok", platforms: ["aix"] },
  ])]);
  assert.deepEqual(contractSchema.parse(valid), valid);
  for (const reference of [{ ...ref(literal), platforms: ["unknown"] }, { command: "echo ok", platforms: ["unknown"] }]) {
    const file = f.write(contract([criterion("ACC-7", [reference])]));
    assert.throws(() => loadContract(file), (error) => {
      assert.match(error.message, /ACC-7/);
      assert.equal(error.message.includes(file), true);
      assert.match(error.message, /proven_by/);
      return true;
    });
  }
});

test("acceptance skips out-of-platform proofs without reading or running them", (t) => {
  const f = fixture(t);
  const skippedTest = { file: "tests/absent.test.mjs", test: "absent", platforms: ["darwin"] };
  const skippedCommand = { command: "exit 9", platforms: ["darwin"] };
  const activeCommand = { command: "echo ok", platforms: ["linux"] };
  const calls = [];
  const run = (...args) => { calls.push(args[0]); return { status: 0, stdout: "" }; };
  const result = checkContract(contract([criterion("ACC-7", [skippedTest, skippedCommand, activeCommand])]), { ...f, run, platform: "linux" });
  assert.deepEqual(result, [{ ...expected("ACC-7", "met"), notApplicable: [skippedTest, skippedCommand] }]);
  assert.deepEqual(calls, ["echo ok"]);
});

test("acceptance makes wholly scoped-out criteria unproven, including posix on win32", (t) => {
  const f = fixture(t);
  const reference = { ...ref("skipped"), platforms: ["posix"] };
  const command = { command: "exit 9", platforms: ["posix"] };
  const data = contract([criterion("ACC-7", [reference, command])]);
  const run = () => assert.fail("out-of-platform proof must not run");
  assert.deepEqual(checkContract(data, { ...f, run, platform: "win32" }), [{
    ...expected("ACC-7", "unproven"), notApplicable: [reference, command], note: "no proof applies on win32",
  }]);
  const linux = checkContract(contract([criterion("ACC-7", [{ ...ref(literal), platforms: ["posix"] }])]), { ...f, platform: "linux" });
  assert.deepEqual(linux, [expected("ACC-7", "met")]);
});

test("acceptance keeps unscoped and applicable zero-pass proofs broken", (t) => {
  const f = fixture(t);
  const skipped = { command: "exit 9", platforms: ["darwin"] };
  const data = contract([criterion("ACC-7", [ref("skipped"), { ...ref("skipped"), platforms: ["linux"] }, skipped])]);
  const result = checkContract(data, { ...f, platform: "linux" });
  assert.deepEqual(result, [{ ...expected("ACC-7", "broken", [
    { ...ref("skipped"), detail: "no tests passed (zero tests ran or all were skipped/todo)" },
    { ...ref("skipped"), detail: "no tests passed (zero tests ran or all were skipped/todo)" },
  ]), notApplicable: [skipped] }]);
});

test("acceptance CLI reports skipped proofs and strict rejects scoped-out criteria", (t) => {
  const f = fixture(t);
  const other = process.platform === "win32" ? "linux" : "win32";
  const skipped = { command: "exit 9", platforms: [other] };
  const data = contract([
    criterion("ACC-7", [skipped]),
    criterion("ACC-8", [ref(literal), skipped]),
  ]);
  f.write(data);
  const report = { contracts: [{ file: "acceptance/example.yml", feature: "Example", criteria: [
    { ...expected("ACC-7", "unproven"), notApplicable: [skipped], note: `no proof applies on ${process.platform}` },
    { ...expected("ACC-8", "met"), notApplicable: [skipped] },
  ] }], totals: totals({ met: 1, unproven: 1 }) };
  const json = f.invoke("--json");
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), report);
  const plain = f.invoke();
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, `acceptance/example.yml: Example\nACC-7  unproven (1 proofs not run on ${process.platform})  no proof applies on ${process.platform}\nACC-8  met (1 proofs not run on ${process.platform})\nTotal: 1 met, 0 broken, 0 missing, 1 unproven, 0 retired\n`);
  const strict = f.invoke("--strict", "--json");
  assert.equal(strict.status, 1);
  assert.deepEqual(JSON.parse(strict.stdout), report);
});
