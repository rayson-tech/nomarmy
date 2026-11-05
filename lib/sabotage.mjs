// Detecting a worker that made the tests pass instead of making the code
// work.
//
// A real Senti job: the sandbox had no sqlglot, so the local worker stubbed
// it out of production code and skipped 5 test classes to get a green
// result, and another left `.sampling-gate-backup/` copies of source files
// in the repo. Each is a review flag here, not a verdict -- a new skip
// marker can be legitimate -- so the coordinator looks before it accepts:
//
//   skip marker      a test newly marked skip/xfail/ignore/todo
//   focus marker     a JS test newly marked .only/fit/fdescribe, which
//                    silently drops every other test in the run
//   deleted test     a test file removed outright
//   stubbed import   production code newly catching ImportError or writing
//                    sys.modules, i.e. carrying on without a dependency
//   shadow module    a new file named like one of the project's own
//                    dependencies (a local sqlglot.py, pytest.py, or a
//                    package sqlglot/__init__.py, sqlglot/index.js)
//   stray backup     a new file or directory named like a backup copy

import fs from "node:fs";
import path from "node:path";

// Skip markers, checked only in test files. Python: pytest/unittest marks
// (decorated or assigned, as in a module-level `pytestmark = ...`), the
// imperative pytest.skip/importorskip/self.skipTest and `raise SkipTest`.
// JS: it/test/describe .skip/.skipIf/.todo (also chained, `.skip.each`), the
// x-prefixed forms, mocha's this.skip(), node:test's t.skip()/t.todo() and a
// `{ skip: true }` / `{ skip: "why" }` / `{ todo: ... }` option on the same
// line as the test call (a bare `skip: 10` is pagination, `todo: "x"` is
// fixture data in a todo app, so the option needs the call beside it). Go:
// t.Skip/Skipf/SkipNow. Rust #[ignore], JUnit @Disabled/@Ignore.
export const SKIP_MARKER_RE = /(\bpytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|importorskip)\(|@unittest\.skip|\bunittest\.skip(?:If|Unless)?\(|\bself\.skipTest\(|\braise\s+(?:[\w.]+\.)?SkipTest\b|\b(?:it|test|describe|suite|context|specify)\.(?:skip|skipIf|todo)\b(?=\s*[(.`])|\bx(?:it|describe|test)\(|\bthis\.skip\s*\(|\bt\.(?:skip|todo)\s*\(|\b(?:it|test|describe|suite)\s*\(.*[{,]\s*(?:skip\s*:\s*(?:true\b|["'`])|todo\s*:)|\b[tb]\.Skip(?:f|Now)?\(|#\[ignore\]|@Disabled\b|@Ignore\b)/;
// Focus markers, checked only in JS/TS test files (the frameworks that have
// them): `.only` on it/test/describe/suite/context (also `.only.each`), and
// jasmine/jest's fit/fdescribe as a call with a string title, never a method
// (`model.fit(`) or a longer name (`fitModel(`). Focus doesn't skip a test, it
// silently drops every other one from the run.
export const FOCUS_MARKER_RE = /(\b(?:it|test|describe|suite|context|specify)\.only\b(?=\s*[(.`])|(?<![\w$.])f(?:it|describe)\s*\(\s*["'`])/;
export const STUB_IMPORT_RE = /(\bsys\.modules\s*\[|\bexcept\s*\(?\s*(?:ModuleNotFoundError|ImportError)\b)/;
const IMPORT_LINE_RE = /^\s*(?:import\s+[A-Za-z_]|from\s+[A-Za-z_][\w.]*\s+import\b)/;
const EXCEPT_LINE_RE = /^\s*except\b/;
const TRY_LINE_RE = /^\s*try\s*:(.*)$/;
const CODE_EXT_RE = /\.(py|js|mjs|cjs|ts|tsx|jsx)$/;
const JS_EXT_RE = /\.(js|mjs|cjs|ts|tsx|jsx)$/;
const TEST_CODE_EXT_RE = /\.(py|[cm]?[jt]sx?|go|rs|java|kt|rb|cs|php|swift)$/;

// Stray backups: a path segment (file or directory) is a backup copy when
//  - it ends in "~" (editor backup: foo.py~), or
//  - one of its dot-separated extensions is exactly bak, orig, backup or old,
//    optionally numbered (foo.py.bak, foo.bak, app.py.orig, foo.backup,
//    foo.old, foo.bak2); `.origins` or `.backups` is a longer word, not one, or
//  - the last word of its name, after a non-empty first word, is backup, bak
//    or orig, optionally followed by a number (foo_backup.py, fooBackup.py,
//    .sampling-gate-backup/, foo-backup-2.py), or
//  - it is a file manager copy: "foo copy.py", "foo copy 2.py",
//    "foo - Copy.py", "foo - Copy (2).py".
// So "backup" as the leading word of a feature name (backup-scheduler.ts,
// BackupService.ts) or a plural (backups.py) is not a backup copy. A feature
// module named with backup last (db_backup.py) still is: an accepted false
// positive, since the flag only asks for a look.
const BACKUP_EXT_RE = /^(?:bak|orig|backup|old)\d*$/;
const BACKUP_WORD_RE = /^(?:backup|bak|orig)$/;
export function isBackupSegment(segment) {
  const seg = String(segment);
  if (seg.endsWith("~")) return true;
  const tokens = seg.replace(/^\.+/, "").split(".");
  if (tokens.slice(1).some((t) => BACKUP_EXT_RE.test(t.toLowerCase()))) return true;
  const stem = tokens[0];
  if (/\s(?:-\s+)?copy(?:\s+\(?\d+\)?)?$/i.test(stem)) return true;
  const words = stem.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/).filter(Boolean).map((w) => w.toLowerCase());
  while (words.length && /^\d+$/.test(words.at(-1))) words.pop();
  return words.length >= 2 && BACKUP_WORD_RE.test(words.at(-1));
}
const isBackupPath = (p) => String(p).split("/").filter(Boolean).some(isBackupSegment);

// The module name a new file would be imported as: its basename without the
// extension, or for a package entry (__init__.py, __init__.pyi, index.js and
// friends) the directory it makes importable.
function moduleNameOf(p) {
  const base = path.posix.basename(p);
  if (/^__init__\.pyi?$/.test(base) || /^index\.(?:js|mjs|cjs|ts)$/.test(base)) return path.posix.basename(path.posix.dirname(p));
  return base.replace(CODE_EXT_RE, "");
}

const normalize = (name) => String(name).toLowerCase().replace(/[-.]/g, "_");

// Separates hunks in addedLinesOf output, so lines from two unrelated hunks
// never read as adjacent (an import added at the top of a file and an
// `except` changed far below it were flagged as a stubbed import). It
// matches none of the line patterns below.
export const HUNK_BREAK = "\u0000@@";

/** Added lines (without the leading "+") from `git diff -U0` output, with HUNK_BREAK between hunks. */
export function addedLinesOf(diffText) {
  const out = [];
  for (const l of String(diffText ?? "").split("\n")) {
    if (l.startsWith("@@")) { if (out.length && out.at(-1) !== HUNK_BREAK) out.push(HUNK_BREAK); }
    else if (l.startsWith("+") && !l.startsWith("+++")) out.push(l.slice(1));
  }
  if (out.at(-1) === HUNK_BREAK) out.pop();
  return out;
}

/**
 * The project's declared dependency names, normalized (lowercase, "-" and
 * "." as "_"), from requirements*.txt, pyproject.toml and package.json at
 * the repo root and one level down (Senti keeps its Python ones in lambda/).
 */
export function loadDependencyNames(cwd) {
  const names = new Set();
  const dirs = [cwd];
  try { for (const e of fs.readdirSync(cwd, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") dirs.push(path.join(cwd, e.name)); } catch { /* unreadable */ }
  for (const dir of dirs) {
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        if (/^requirements.*\.txt$/.test(f)) {
          for (const line of fs.readFileSync(file, "utf8").split("\n")) {
            const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line.replace(/#.*/, ""));
            if (m) names.add(normalize(m[1]));
          }
        } else if (f === "pyproject.toml") {
          const text = fs.readFileSync(file, "utf8");
          for (const m of text.matchAll(/^\s*["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*[<>=~!\[;,"']/gm)) names.add(normalize(m[1]));
        } else if (f === "package.json") {
          const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
          for (const k of ["dependencies", "devDependencies", "peerDependencies"]) for (const n of Object.keys(pkg[k] ?? {})) names.add(normalize(n.replace(/^@[^/]+\//, "")));
        }
      } catch { /* one bad manifest never stops the rest */ }
    }
  }
  return names;
}

/**
 * Production-code lines that carry on without an import: any `except`
 * around a try that holds only imports (see guardsOnlyImports), or an explicit
 * ImportError/sys.modules workaround, or a dependency's own name set to
 * None. The real stub was `try: import sqlglot` / `except Exception:` /
 * `sqlglot = None`, so catching only ImportError missed it.
 */
// Whether the `except` at addedLines[i] guards nothing but imports. A try
// that also does the work -- `try: from table_catalog_embed import
// clear_missing_marks; clear_missing_marks(...)` / `except Exception as e:
// print("... (non-fatal)")`, a Senti file's own lazy-import idiom -- keeps
// a failure non-fatal; it isn't carrying on without a dependency, and was
// flagged as a stub (a false positive a reviewer had to clear).
function guardsOnlyImports(addedLines, i) {
  let hunk = i - 1; while (hunk >= 0 && addedLines[hunk] !== HUNK_BREAK) hunk--;
  const start = Math.max(hunk + 1, i - 8);
  let tryAt = -1;
  for (let k = i - 1; k >= start; k--) if (TRY_LINE_RE.test(addedLines[k])) { tryAt = k; break; }
  // The try itself isn't in the added lines: only an import right above counts.
  if (tryAt === -1) return addedLines.slice(Math.max(start, i - 4), i).some((l) => IMPORT_LINE_RE.test(l));
  // A one-line `try: import sqlglot` carries its body after the colon.
  const inline = TRY_LINE_RE.exec(addedLines[tryAt])[1];
  const body = [inline, ...addedLines.slice(tryAt + 1, i)].filter((l) => l.trim() && !/^\s*#/.test(l));
  return body.length > 0 && onlyImports(body);
}

// Whether every line is an import, counting the continuation lines of a
// parenthesized `from x import (` / `    a,` / `)` as part of it.
function onlyImports(lines) {
  let open = 0;
  const depth = (code) => (code.match(/\(/g) ?? []).length - (code.match(/\)/g) ?? []).length;
  for (const l of lines) {
    const code = l.replace(/#.*/, "");
    if (open === 0 && !IMPORT_LINE_RE.test(l)) return false;
    open = Math.max(0, open + depth(code));
  }
  return true;
}

// The JS form of the same stub: a `catch` whose `try` block holds nothing but
// require() or import() of a module (`try { x = require('sqlglot') } catch`),
// on one line or across the lines of one hunk.
const JS_LOAD_STMT_RE = /^(?:(?:const|let|var)\s+[\w${}\s,:]+=\s*|[\w$.]+\s*=\s*)?(?:await\s+)?(?:require|import)\s*\(\s*["'`][^"'`]+["'`]\s*\)(?:\.[\w$]+)*$/;
function jsStubbedImportLines(addedLines) {
  const hits = [];
  addedLines.forEach((line, i) => {
    if (!/\bcatch\b\s*(?:\(|\{)/.test(line)) return;
    let hunk = i - 1; while (hunk >= 0 && addedLines[hunk] !== HUNK_BREAK) hunk--;
    const from = Math.max(hunk + 1, i - 8);
    let text = null;
    for (let k = i; k >= from && text === null; k--) {
      const tries = [...addedLines[k].matchAll(/\btry\s*\{/g)];
      if (tries.length) text = [addedLines[k].slice(tries.at(-1).index), ...addedLines.slice(k + 1, i + 1)].join("\n");
    }
    if (text === null) return;
    const m = /\btry\s*\{([\s\S]*)\}\s*catch\b/.exec(text);
    if (!m) return;
    const stmts = m[1].split(/[;\n]/).map((t) => t.trim()).filter((t) => t && !t.startsWith("//"));
    if (stmts.length && stmts.every((t) => JS_LOAD_STMT_RE.test(t))) hits.push(line);
  });
  return hits;
}

function stubbedImportLines(addedLines, deps) {
  const hits = [];
  addedLines.forEach((line, i) => {
    if (STUB_IMPORT_RE.test(line)) hits.push(line);
    else if (EXCEPT_LINE_RE.test(line) && guardsOnlyImports(addedLines, i)) hits.push(line);
    else {
      const m = /^\s*([A-Za-z_]\w*)\s*=\s*None\b/.exec(line);
      if (m && deps.has(normalize(m[1]))) hits.push(line);
    }
  });
  return hits;
}

/**
 * @param {{ changes: { status: string, path: string, addedLines: string[] }[], isTestPathFn: (p: string) => boolean, dependencyNames?: Set<string>|string[] }} input
 * @returns {{ flags: string[], reason: string } | null}
 */
export function detectTestSabotage({ changes = [], isTestPathFn, dependencyNames = [] }) {
  const deps = dependencyNames instanceof Set ? dependencyNames : new Set([...dependencyNames].map(normalize));
  const flags = [];
  const clip = (s) => { const t = String(s).trim(); return t.length > 100 ? `${t.slice(0, 99)}…` : t; };
  for (const c of changes) {
    const isTest = isTestPathFn(c.path);
    const addedLines = c.addedLines ?? [];
    if (isTest) {
      if (String(c.status).startsWith("D")) {
        if (TEST_CODE_EXT_RE.test(c.path)) flags.push(`deleted test: ${c.path} removed`);
        continue;
      }
      const skips = addedLines.filter((l) => SKIP_MARKER_RE.test(l));
      if (skips.length) flags.push(`skip marker: ${c.path} newly skips ${skips.length} test(s) (${clip(skips[0])})`);
      const focus = JS_EXT_RE.test(c.path) ? addedLines.filter((l) => FOCUS_MARKER_RE.test(l)) : [];
      if (focus.length) flags.push(`focus marker: ${c.path} runs only these tests, dropping the rest (${clip(focus[0])})`);
    } else if (CODE_EXT_RE.test(c.path)) {
      const stubs = [...stubbedImportLines(addedLines, deps), ...(JS_EXT_RE.test(c.path) ? jsStubbedImportLines(addedLines) : [])];
      if (stubs.length) flags.push(`stubbed import: production code in ${c.path} newly carries on without an import (${clip(stubs[0])})`);
    }
    if (c.status === "A") {
      const isModule = CODE_EXT_RE.test(c.path) || /(^|\/)__init__\.pyi$/.test(c.path);
      const base = normalize(moduleNameOf(c.path));
      if (isModule && deps.has(base) && !isTest) flags.push(`shadow module: new file ${c.path} is named like the dependency "${base}", which would hide the real package`);
      if (isBackupPath(c.path)) flags.push(`stray backup: new file ${c.path} looks like a backup copy, not part of the change`);
    }
  }
  if (!flags.length) return null;
  return { flags, reason: `${flags.length} sign(s) the tests may have been made to pass rather than the code made to work: ${flags.join("; ")}` };
}
