// Detecting a worker that made the tests pass instead of making the code
// work.
//
// A real Senti job: the sandbox had no sqlglot, so the local worker stubbed
// it out of production code and skipped 5 test classes to get a green
// result, and another left `.sampling-gate-backup/` copies of source files
// in the repo. Each is a review flag here, not a verdict -- a new skip
// marker can be legitimate -- so the coordinator looks before it accepts:
//
//   skip marker      a test newly marked skip/xfail/ignore
//   stubbed import   production code newly catching ImportError or writing
//                    sys.modules, i.e. carrying on without a dependency
//   shadow module    a new file named like one of the project's own
//                    dependencies (a local sqlglot.py, pytest.py)
//   stray backup     a new file or directory named like a backup copy

import fs from "node:fs";
import path from "node:path";

export const SKIP_MARKER_RE = /(@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|importorskip)\(|@unittest\.skip|\bunittest\.skip(?:If|Unless)?\(|\bself\.skipTest\(|\b(?:it|test|describe)\.skip\(|\bx(?:it|describe|test)\(|\bt\.Skip(?:Now)?\(|#\[ignore\]|@Disabled\b|@Ignore\b)/;
export const STUB_IMPORT_RE = /(\bsys\.modules\s*\[|\bexcept\s*\(?\s*(?:ModuleNotFoundError|ImportError)\b)/;
const IMPORT_LINE_RE = /^\s*(?:import\s+[A-Za-z_]|from\s+[A-Za-z_][\w.]*\s+import\b)/;
const EXCEPT_LINE_RE = /^\s*except\b/;
const BACKUP_RE = /(^|\/)[^/]*(?:backup|\.bak|\.orig)[^/]*(\/|$)|~$/i;
const CODE_EXT_RE = /\.(py|js|mjs|cjs|ts|tsx|jsx)$/;

const normalize = (name) => String(name).toLowerCase().replace(/[-.]/g, "_");

/** Added lines (without the leading "+") from `git diff -U0` output. */
export function addedLinesOf(diffText) {
  return String(diffText ?? "").split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
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
  const start = Math.max(0, i - 8);
  let tryAt = -1;
  for (let k = i - 1; k >= start; k--) if (/^\s*try\s*:/.test(addedLines[k])) { tryAt = k; break; }
  // The try itself isn't in the added lines: only an import right above counts.
  if (tryAt === -1) return addedLines.slice(Math.max(0, i - 4), i).some((l) => IMPORT_LINE_RE.test(l));
  const body = addedLines.slice(tryAt + 1, i).filter((l) => l.trim() && !/^\s*#/.test(l));
  return body.length > 0 && body.every((l) => IMPORT_LINE_RE.test(l));
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
    if (isTest) {
      const skips = c.addedLines.filter((l) => SKIP_MARKER_RE.test(l));
      if (skips.length) flags.push(`skip marker: ${c.path} newly skips ${skips.length} test(s) (${clip(skips[0])})`);
    } else {
      const stubs = stubbedImportLines(c.addedLines, deps);
      if (stubs.length && CODE_EXT_RE.test(c.path)) flags.push(`stubbed import: production code in ${c.path} newly carries on without an import (${clip(stubs[0])})`);
    }
    if (c.status === "A") {
      const base = normalize(path.basename(c.path).replace(CODE_EXT_RE, ""));
      if (CODE_EXT_RE.test(c.path) && deps.has(base) && !isTest) flags.push(`shadow module: new file ${c.path} is named like the dependency "${base}", which would hide the real package`);
      if (BACKUP_RE.test(c.path)) flags.push(`stray backup: new file ${c.path} looks like a backup copy, not part of the change`);
    }
  }
  if (!flags.length) return null;
  return { flags, reason: `${flags.length} sign(s) the tests may have been made to pass rather than the code made to work: ${flags.join("; ")}` };
}
