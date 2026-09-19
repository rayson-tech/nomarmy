// Deterministic repository evidence. A temp fixture tree stands in for a repo.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listFiles, matchesGlob, grepRepo, findDefinitions, findReferences, outlineFile, runQuery, formatCitations, OPS } from "../lib/repo-query.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-rq-"));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w("lib/auth.mjs", [
    "import { spawn } from \"node:child_process\";",
    "export function requireAuth(req) {",
    "  return check(req);",
    "}",
    "const helper = (x) => x;",
    "export class Session {",
    "  refresh() {",
    "    return spawn(\"id\");",
    "  }",
    "}",
    "",
  ].join("\n"));
  w("src/routes.js", "import { requireAuth } from '../lib/auth.mjs';\nrouter.use(requireAuth);\nrequireAuthLater();\n");
  w("app/main.py", "import os\n\nclass Service:\n    def requireAuth(self):\n        return os.spawn(1)\n\ndef run():\n    pass\n");
  w("cmd/main.go", "package main\n\nfunc requireAuth(w http.ResponseWriter) {}\nfunc (s *Server) Start() {}\n");
  w("node_modules/dep/index.js", "export function requireAuth() {}\n");
  w("bin.dat", Buffer.from([0, 1, 2, 3, 0, 5]).toString("binary"));
  w("README.md", "# demo\nrequireAuth is documented here.\n");
  return root;
}

test("matchesGlob: ** and * and alternation behave", () => {
  assert.equal(matchesGlob("lib/auth.mjs", "**/*.mjs"), true);
  assert.equal(matchesGlob("lib/auth.mjs", "*.mjs"), true);
  assert.equal(matchesGlob("lib/auth.mjs", "src/*.js"), false);
  assert.equal(matchesGlob("src/routes.js", "src/*.{js,ts}"), true);
  assert.equal(matchesGlob("a/b/c.py", "a/**/*.py"), true);
  assert.equal(matchesGlob("src/barfoo", "**/foo"), false, "barfoo must not match **/foo");
  assert.equal(matchesGlob("src/nested/foo", "**/foo"), true);
  assert.equal(matchesGlob("foo", "**/foo"), true);
  assert.equal(matchesGlob("src/foo.txt", "**/foo"), false);
});

test("listFiles: skips ignored directories, honours globs, sorted", () => {
  const root = fixture();
  try {
    const { files } = listFiles(root);
    assert.ok(files.includes("lib/auth.mjs"));
    assert.ok(!files.some(f => f.startsWith("node_modules/")), "node_modules is ignored");
    assert.deepEqual(listFiles(root, { glob: "**/*.py" }).files, ["app/main.py"]);
    assert.deepEqual([...files], [...files].sort());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("grepRepo: hits carry path and 1-based line, binaries are skipped, results cap and report truncation", () => {
  const root = fixture();
  try {
    const r = grepRepo(root, { pattern: "spawn" });
    assert.deepEqual(r.hits.map(h => `${h.path}:${h.line}`), ["app/main.py:5", "lib/auth.mjs:1", "lib/auth.mjs:8"]);
    assert.ok(!r.hits.some(h => h.path === "bin.dat"));
    const capped = grepRepo(root, { pattern: "requireAuth", maxResults: 2 });
    assert.equal(capped.hits.length, 2); assert.equal(capped.truncated, true);
    assert.equal(grepRepo(root, { pattern: "REQUIREAUTH", ignoreCase: true, glob: "**/*.md" }).hits.length, 1);
    assert.throws(() => grepRepo(root, { pattern: "(" }), /invalid pattern/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("findDefinitions: finds the symbol across language families and labels the kind", () => {
  const root = fixture();
  try {
    const r = findDefinitions(root, "requireAuth");
    const where = r.hits.map(h => `${h.path}:${h.line}:${h.kind}`);
    assert.deepEqual(where, ["app/main.py:4:function", "cmd/main.go:3:function", "lib/auth.mjs:2:function"]);
    assert.equal(r.heuristic, true);
    assert.equal(findDefinitions(root, "Session").hits[0].kind, "class");
    assert.equal(findDefinitions(root, "helper").hits[0].kind, "const");
    assert.equal(findDefinitions(root, "Start").hits[0].lang, "go");
    assert.equal(findDefinitions(root, "requireAuthLater").hits.length, 0, "a call is not a definition");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("findReferences: word-boundary uses excluding the definition lines, definitions listed alongside", () => {
  const root = fixture();
  try {
    const r = findReferences(root, "requireAuth");
    assert.deepEqual(r.hits.map(h => `${h.path}:${h.line}`), ["README.md:2", "src/routes.js:1", "src/routes.js:2"]);
    assert.equal(r.definitions.length, 3);
    assert.ok(!r.hits.some(h => h.line === 3 && h.path === "src/routes.js"), "requireAuthLater is a different word");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("outlineFile: top-level declarations with export flag; refuses paths outside the repo", () => {
  const root = fixture();
  try {
    const o = outlineFile(root, "./lib/auth.mjs");
    assert.deepEqual(o.items.map(i => `${i.line}:${i.kind}:${i.name}:${i.exported}`), ["2:function:requireAuth:true", "5:const:helper:false", "6:class:Session:true", "7:method:refresh:false"]);
    assert.throws(() => outlineFile(root, "../etc/passwd"), /inside the repository/);
    assert.equal(outlineFile(root, "nope.js").exists, false);
    assert.equal(outlineFile(root, "bin.dat").items.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("runQuery + formatCitations: every output line is a copyable [path:line] citation", () => {
  const root = fixture();
  try {
    const text = formatCitations(runQuery(root, "references", { query: "requireAuth" }));
    const lines = text.split("\n").filter(l => l.startsWith("["));
    assert.ok(lines.length >= 5);
    for (const l of lines) assert.match(l, /^\[[^\]\s:]+:\d+\] /);
    assert.match(formatCitations(runQuery(root, "files", { glob: "**/*.py" })), /^\[app\/main\.py\]$/m);
    assert.match(formatCitations(runQuery(root, "outline", { path: "lib/auth.mjs" })), /\[lib\/auth\.mjs:2\] function \(exported\) requireAuth/);
    assert.match(formatCitations(runQuery(root, "grep", { query: "nothing-here" })), /no matches/);
    assert.throws(() => runQuery(root, "explode", {}), /unknown op/);
    assert.deepEqual(OPS, ["grep", "definitions", "references", "outline", "files"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
