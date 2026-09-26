import "./helpers/isolate-global-config.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { harnessSchemaFor } from "../lib/harness-schema.mjs";
import { HARNESS_ROOT, loadHarnesses, matchHarnesses } from "../lib/harnesses.mjs";
import { HARNESS_DOCS, generateHarnessDocs, checkHarnessDocs } from "../scripts/generate-harness-docs.mjs";

const minimal = (name = "example") => ({ name, summary: "Example", detect: [], image: { builtin: "node" } });
function temporary(t) {
  // Outside any checkout: inside one, package discovery asks git, which
  // lists only committed files and would miss a fixture's lockfile.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-harness-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
function harness(root, name, changes = {}) {
  write(root, `${name}/harness.yml`, stringify({ ...minimal(name), ...changes }));
}

test("harness schema defaults and supported declarations are exact", () => {
  const schema = harnessSchemaFor("example");
  assert.deepEqual(schema.parse(minimal()), {
    ...minimal(), after: [], verification: {}, artifacts: [], requires: {}, network: "none", docs: "README.md",
  });
  for (const network of ["services", "allowlist"]) {
    const spec = { ...minimal(), detect: [{ file: "config.ts" }, { package: "@scope/test" }, { lockfile: "test.lock" }],
      after: ["node"], image: { apt: ["chromium"], run: ["install-browser"] },
      verification: { quick: "test", full: ["lint", "test"] }, artifacts: ["results/**"],
      requires: { memoryMb: 1024, shmMb: 512, kvm: false }, network, services: ["mock"],
      suggestedRole: { name: "browser-qa", description: "Runs tests" }, docs: "guide.md" };
    assert.deepEqual(schema.parse(spec), spec);
    assert.deepEqual(schema.parse({ ...spec, services: [] }), { ...spec, services: [] });
  }
});

test("harness schema rejects forbidden declarations", () => {
  const schema = harnessSchemaFor("example");
  const bad = [
    { ...minimal(), name: "different" }, { ...minimal(), name: "Bad_Name" },
    ...["unknown", "mounts", "hostPaths", "privileged", "capabilities", "devices", "env", "secrets", "credentials"].map((key) => ({ ...minimal(), [key]: true })),
    { ...minimal(), services: [] }, { ...minimal(), services: ["mock"] },
    { ...minimal(), image: { builtin: "node", apt: [], run: [] } },
    { ...minimal(), image: { apt: [], run: [], privileged: true } },
    { ...minimal(), requires: { memoryMb: -1 } }, { ...minimal(), requires: { devices: [] } },
    { ...minimal(), detect: [{ file: "a", package: "b" }] },
    { ...minimal(), detect: [{ file: "/etc/passwd" }] },
    { ...minimal(), docs: "../README.md" },
    { ...minimal(), suggestedRole: { name: "qa", description: "tests", env: {} } },
    { ...minimal(), network: "host" },
    { ...minimal(), services: [{ name: "mock", credentials: "secret" }], network: "services" },
  ];
  for (const spec of bad) assert.equal(schema.safeParse(spec).success, false, JSON.stringify(spec));
});

test("registry loads exactly four built-ins and ignores template", () => {
  const result = loadHarnesses();
  assert.deepEqual(Object.keys(result).sort(), ["harnesses", "problems"]);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(Object.keys(result.harnesses).sort(), ["go", "node", "python", "rust"]);
  for (const [name, spec] of Object.entries(result.harnesses)) {
    assert.equal(spec.name, name);
    assert.deepEqual(spec.image, { builtin: name });
    assert.equal(spec.network, "none");
  }
});

test("registry reports and skips invalid graphs and YAML independently", (t) => {
  const root = temporary(t);
  harness(root, "good");
  write(root, "_template/harness.yml", "invalid: [");
  write(root, "broken/harness.yml", "invalid: [");
  harness(root, "wrong-folder", { name: "other" });
  harness(root, "unknown", { after: ["missing"] });
  harness(root, "cycle-a", { after: ["cycle-b"] });
  harness(root, "cycle-b", { after: ["cycle-a"] });
  harness(root, "dependent", { after: ["cycle-a"] });
  harness(root, "broken-dependent", { after: ["broken"] });
  const result = loadHarnesses(root);
  assert.deepEqual(Object.keys(result).sort(), ["harnesses", "problems"]);
  assert.deepEqual(result.harnesses, { good: harnessSchemaFor("good").parse(minimal("good")) });
  assert.deepEqual(result.problems.map(({ name }) => name).sort(), ["broken", "broken-dependent", "cycle-a", "cycle-b", "dependent", "unknown", "wrong-folder"]);
  const reasons = Object.fromEntries(result.problems.map((problem) => {
    assert.deepEqual(Object.keys(problem).sort(), ["name", "reason"]);
    return [problem.name, problem.reason];
  }));
  assert.match(reasons.broken, /Flow sequence/);
  assert.match(reasons["wrong-folder"], /name must equal its folder name/);
  assert.equal(reasons.unknown, "unknown after harness: missing");
  assert.equal(reasons["broken-dependent"], "unknown after harness: broken");
  assert.equal(reasons["cycle-a"], "after cycle: cycle-a -> cycle-b -> cycle-a");
  assert.equal(reasons["cycle-b"], reasons["cycle-a"]);
  assert.equal(reasons.dependent, "invalid after harness: cycle-a");
});

test("matching fixtures selects exact ecosystems and respects after order", (t) => {
  const root = temporary(t), { harnesses } = loadHarnesses();
  for (const [marker, expected] of [["package-lock.json", "node"], ["requirements.txt", "python"], ["go.mod", "go"], ["Cargo.toml", "rust"]]) {
    const repo = path.join(root, expected);
    write(repo, marker, "");
    assert.deepEqual(matchHarnesses(repo, harnesses), [expected]);
  }
  const mixed = path.join(root, "mixed");
  write(mixed, "go.mod", "module example\n");
  write(mixed, "ui/package.json", '{"devDependencies":{"@example/test":"1"}}');
  write(mixed, "ui/package-lock.json", "{}");
  assert.deepEqual(matchHarnesses(mixed, harnesses), ["go", "node"]);
  assert.deepEqual(matchHarnesses(mixed, { ...harnesses, go: { ...harnesses.go, after: ["node"] } }), ["node", "go"]);
  const plugin = harnessSchemaFor("plugin").parse({ ...minimal("plugin"), detect: [{ package: "@example/test" }], after: ["node"] });
  assert.deepEqual(matchHarnesses(mixed, { plugin, ...harnesses }), ["go", "node", "plugin"]);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    write(mixed, "ui/package.json", JSON.stringify({ [field]: { "@example/test": "1" } }));
    assert.deepEqual(matchHarnesses(mixed, { plugin, ...harnesses }), ["go", "node", "plugin"]);
  }
  write(mixed, "ui/package.json", '{"name":"@example/test"}');
  assert.deepEqual(matchHarnesses(mixed, { plugin, ...harnesses }), ["go", "node"]);
  write(mixed, "ui/package.json", "broken json");
  assert.deepEqual(matchHarnesses(mixed, { plugin, ...harnesses }), ["go", "node"]);
  assert.deepEqual(matchHarnesses(temporary(t), harnesses), []);
});

test("generated harness docs match the committed page and detect stale metadata", (t) => {
  assert.equal(generateHarnessDocs(), fs.readFileSync(HARNESS_DOCS, "utf8"));
  assert.doesNotThrow(() => checkHarnessDocs());
  const root = temporary(t), copy = path.join(root, "harnesses"), output = path.join(root, "harnesses.md");
  for (const name of fs.readdirSync(HARNESS_ROOT)) {
    for (const file of ["harness.yml", "README.md"]) {
      write(copy, `${name}/${file}`, fs.readFileSync(path.join(HARNESS_ROOT, name, file), "utf8"));
    }
  }
  fs.copyFileSync(HARNESS_DOCS, output);
  assert.doesNotThrow(() => checkHarnessDocs(copy, output));
  const file = path.join(copy, "node/harness.yml");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Node dependencies installed with npm ci", "Changed summary | with <markup>"));
  assert.throws(() => checkHarnessDocs(copy, output), { message: "Harness docs are stale. Run npm run docs:harnesses." });
  const generated = generateHarnessDocs(copy);
  assert.match(generated, /Changed summary &#124; with &lt;markup&gt;/);
  fs.writeFileSync(output, generated);
  assert.doesNotThrow(() => checkHarnessDocs(copy, output));
  write(copy, "bad/harness.yml", "bad: [");
  assert.throws(() => generateHarnessDocs(copy), /bad:/);
});
