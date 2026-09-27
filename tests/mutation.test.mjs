import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { lineMutants, pickMutants, runMutants, describeSurvivors, mutationLanguage } from "../lib/mutation.mjs";
import { validateConfig } from "../lib/config.mjs";

const ops = (line, lang) => lineMutants(line, lang).map((m) => `${m.from}→${m.to}`);

test("lineMutants mutates code, never strings, comments, imports, arrows or compound operators", () => {
  assert.deepEqual(ops("  if (count <= limit && active) return total + 3;", "c"), ["<=→<", "&&→||", " + → - ", "3→4"]);
  assert.deepEqual(ops("  const f = (a) => a >= 0;", "c"), [">=→>", "0→1"]);
  assert.deepEqual(ops('  log("a < b and x == y"); // x > 2', "c"), []);
  assert.deepEqual(ops('import { a } from "./b.js";', "c"), []);
  assert.deepEqual(ops("  i++; x += 1; y = a->b; if (a != b) {}", "c"), ["!=→==", "1→2"]);
  assert.deepEqual(ops("  const truthy = trueish && falsey;", "c"), ["&&→||"]);
  assert.deepEqual(ops("    if x >= 70 and not done: return price * 0.9", "python"), [">=→>", " and → or ", " * → / ", "70→71"]);
  assert.deepEqual(ops('    return f"{a} < {b}"  # 5 > 3', "python"), []);
  assert.equal(mutationLanguage("src/a.ts"), "c");
  assert.equal(mutationLanguage("app/b.py"), "python");
  assert.equal(mutationLanguage("README.md"), null);
});

function workdir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-mutation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test("pickMutants spreads mutants across files and lines, and only uses changed lines", (t) => {
  const dir = workdir(t, { "a.js": "const x = 1;\nif (a < b) go();\nreturn c && d;\n", "b.py": "ok = n >= 18\n" });
  const files = [{ path: "a.js", full: path.join(dir, "a.js"), lines: [2, 3] }, { path: "b.py", full: path.join(dir, "b.py"), lines: [1] }];
  const picked = pickMutants(files, 3);
  assert.deepEqual(picked.map((m) => `${m.path}:${m.line} ${m.from}→${m.to}`), ["a.js:2 <→<=", "a.js:3 &&→||", "b.py:1 >=→>"]);
  assert.equal(picked[0].mutated.split("\n")[1], "if (a <= b) go();");
  assert.equal(pickMutants(files, 20).some((m) => m.line === 1 && m.path === "a.js"), false, "line 1 wasn't changed");
});

test("runMutants: killed, survived and inconclusive are counted, and the worker's file is restored after every mutant", async (t) => {
  const dir = workdir(t, { "a.js": "if (a < b) go();\nreturn c && d;\nconst ok = true;\nlet n = x === y;\n" });
  const full = path.join(dir, "a.js"), before = fs.readFileSync(full, "utf8");
  const mutants = pickMutants([{ path: "a.js", full, lines: [1, 2, 3, 4] }], 4);
  const seen = [];
  const replies = ["fail", "pass", "not_run", "boom"];
  const result = await runMutants({ mutants, verify: async () => {
    seen.push(fs.readFileSync(full, "utf8"));
    const r = replies[seen.length - 1] ?? "fail";
    if (r === "boom") throw new Error("runner crashed");
    return { status: r };
  } });
  assert.notEqual(seen[0], before, "the mutant was in place during verification");
  assert.equal(fs.readFileSync(full, "utf8"), before, "restored after the last one, crash included");
  assert.equal(result.killed, 1);
  assert.equal(result.survived.length, 1);
  assert.equal(result.inconclusive, 2);
  assert.equal(result.status, "survivors");
  assert.match(describeSurvivors(result, "quick"), /MUTANTS SURVIVED: 1 of 4 .* profile 'quick'.*a\.js:1 `<` → `<=`|a\.js:2/);
});

test("runMutants stops at its deadline and says nothing ran when nothing did", async (t) => {
  const dir = workdir(t, { "a.js": "if (a < b) go();\n" });
  const mutants = pickMutants([{ path: "a.js", full: path.join(dir, "a.js"), lines: [1] }], 5);
  const late = await runMutants({ mutants, verify: async () => ({ status: "fail" }), deadlineMs: Date.now() - 1 });
  assert.equal(late.status, "not_run");
  assert.equal(late.skipped, mutants.length);
  assert.equal((await runMutants({ mutants: [], verify: async () => ({ status: "fail" }) })).status, "not_run");
});

test(".nomarmy.yml mutation: defaults and limits", () => {
  const ok = validateConfig({ verification: { quick: { commands: ["npm test"] } }, mutation: {} });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.config.mutation, { mutants: 5, max_seconds: 300 });
  const bad = validateConfig({ mutation: { mutants: 50, extra: true } });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => /mutation\.mutants: must be at most 20/.test(e)));
  assert.ok(bad.errors.some((e) => /unexpected field/.test(e)));
});
