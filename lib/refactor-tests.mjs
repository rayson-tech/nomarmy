import path from "node:path";
import { isTestPath } from "./diff-checks.mjs";
import { readWorktreeFile } from "./worktree-write.mjs";

// ---------------------------------------------------------------------------
// Behavior-neutral test changes for the refactor contract. A module move
// drags its test along (bar.test.ts follows bar.ts) and re-points imports and
// jest.mock paths, without changing a single assertion. Refusing those forced
// a mode switch on every slice of a split. This proves neutrality mechanically:
// the old and new test text must be identical line for line, except lines
// whose only difference is a module specifier. Anything else (an assertion, an
// added or removed line, a deleted test, a new test with novel content) is not
// shown neutral, and the refactor contract blocks it as before.
// ---------------------------------------------------------------------------

const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
// What may come right before a changed string literal for it to count as a
// module specifier: an import/export source, require(), dynamic import(), or
// a test double's module path (jest/vi mock, Python mock.patch).
const SPECIFIER_CONTEXT = /(?:(?:^|[\s}*])from|\bimport|\bimport\s*\(|\brequire\s*\(|\brequire\.resolve\s*\(|\.(?:mock|doMock|unmock|requireActual|importActual|requireMock|importMock|setMock)\s*\(|\bpatch\s*\()\s*$/;
const SPECIFIER_TEXT = /^[\w@~.$:#/+-]+$/;
// Unquoted module paths: Python `from a.b import c` / `import a.b as c`,
// Java/Kotlin/Go `package` and `import`, Rust `use`.
const PY_FROM = /^(\s*)from\s+([\w.]+)\s+(import\s+.+)$/;
const KEYWORD_PATH = /^(\s*)(package|import|use)\s+(static\s+)?([\w.:*]+)(\s+as\s+\w+)?(\s*;)?\s*$/;

function skeleton(line) {
  const literals = [];
  const text = line.replace(STRING_LITERAL, (whole, quote, body) => { literals.push({ quote, body }); return `\u0000${literals.length - 1}\u0000`; });
  return { text, literals };
}

/** True when two lines differ only in module specifiers. Equal lines are true too. */
export function specifierOnlyChange(before, after, file = "") {
  if (before === after) return true;
  const pyA = PY_FROM.exec(before), pyB = PY_FROM.exec(after);
  if (pyA && pyB) return pyA[1] === pyB[1] && pyA[3] === pyB[3];
  const kwA = KEYWORD_PATH.exec(before), kwB = KEYWORD_PATH.exec(after);
  if (kwA && kwB) return kwA[1] === kwB[1] && kwA[2] === kwB[2] && kwA[3] === kwB[3] && kwA[5] === kwB[5] && kwA[6] === kwB[6];
  const a = skeleton(before), b = skeleton(after);
  if (a.text !== b.text || a.literals.length !== b.literals.length) return false;
  // A Go import block line: an optional alias and the quoted path alone.
  const goImportLine = file.endsWith(".go") && /^\s*(?:[\w.]+\s+)?\u00000\u0000\s*$/.test(a.text);
  let changed = 0;
  for (let i = 0; i < a.literals.length; i++) {
    const x = a.literals[i], y = b.literals[i];
    if (x.quote !== y.quote) return false;
    if (x.body === y.body) continue;
    changed++;
    if (!SPECIFIER_TEXT.test(x.body) || !SPECIFIER_TEXT.test(y.body)) return false;
    if (goImportLine) continue;
    const marker = `\u0000${i}\u0000`;
    const prefix = a.text.slice(0, a.text.indexOf(marker));
    if (!SPECIFIER_CONTEXT.test(prefix)) return false;
  }
  return changed > 0;
}

/**
 * Compare a test file's old and new text. Neutral only when both have the
 * same lines in the same order, except lines whose sole change is a module
 * specifier. Returns { neutral, identical, changedLines, why }.
 */
export function neutralTestEdit(beforeText, afterText, file = "") {
  if (beforeText === afterText) return { neutral: true, identical: true, changedLines: 0, why: null };
  const a = String(beforeText).split(/\r?\n/), b = String(afterText).split(/\r?\n/);
  if (a.length !== b.length) return { neutral: false, identical: false, changedLines: null, why: `lines were added or removed (${a.length} -> ${b.length})` };
  let changedLines = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (!specifierOnlyChange(a[i], b[i], file)) return { neutral: false, identical: false, changedLines: null, why: `line ${i + 1} changes more than a module path` };
    changedLines++;
  }
  return { neutral: true, identical: changedLines === 0, changedLines, why: null };
}

function asText(content) {
  if (content == null) return null;
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  if (buf.includes(0)) return null;
  return buf.toString("utf8");
}

/**
 * Which of a diff's test changes are provably behavior-neutral. `nameStatus`
 * is the git record's entry list (untracked files included as "A"), so a test
 * moved without `git mv` shows as a delete plus an add and is paired here by
 * content. Returns { files: [{ path, from, kind }], blocking: [{ path, why }] }
 * where kind is "rename" (identical text), "move" (moved, specifiers
 * re-pointed) or "imports" (edited in place, specifiers only).
 */
export async function analyzeRefactorTestChanges({ cwd, baseSha, nameStatus = [], gitRaw, readBase, readCurrent }) {
  const base = readBase ?? (async (file) => { try { return await gitRaw(["show", `${baseSha}:${file}`], cwd); } catch { return null; } });
  const current = readCurrent ?? ((file) => readWorktreeFile(cwd, path.join(cwd, file))?.content ?? null);
  const deleted = [], added = [], modified = [];
  for (const entry of nameStatus ?? []) {
    const letter = String(entry?.status ?? "")[0]?.toUpperCase() ?? "";
    const file = entry?.path;
    if (!file) continue;
    if (letter === "R" || letter === "C") {
      const srcIsTest = entry.oldPath ? isTestPath(entry.oldPath) : false;
      if (letter === "R" && srcIsTest) deleted.push(entry.oldPath);
      if (srcIsTest || isTestPath(file)) added.push(file);
      continue;
    }
    if (!isTestPath(file)) continue;
    if (letter === "A") added.push(file);
    else if (letter === "D") deleted.push(file);
    else modified.push(file);
  }
  const files = [], blocking = [];
  const read = async (fn, file) => { try { return asText(await fn(file)); } catch { return null; } };

  for (const file of modified) {
    const [before, after] = [await read(base, file), await read(current, file)];
    if (before == null || after == null) { blocking.push({ path: file, why: "could not read both versions" }); continue; }
    const result = neutralTestEdit(before, after, file);
    if (result.neutral) { if (!result.identical) files.push({ path: file, from: null, kind: "imports" }); }
    else blocking.push({ path: file, why: result.why });
  }

  const deletedText = new Map();
  for (const file of deleted) deletedText.set(file, await read(base, file));
  const used = new Set();
  for (const file of [...added].sort()) {
    const after = await read(current, file);
    if (after == null) { blocking.push({ path: file, why: "could not read the new file" }); continue; }
    // Prefer the deleted test with the same file name: the common move.
    const candidates = [...deletedText.keys()].filter(d => !used.has(d))
      .sort((x, y) => Number(path.basename(y) === path.basename(file)) - Number(path.basename(x) === path.basename(file)) || x.localeCompare(y));
    let match = null;
    for (const from of candidates) {
      const before = deletedText.get(from);
      if (before == null) continue;
      const result = neutralTestEdit(before, after, file);
      if (result.neutral) { match = { from, identical: result.identical }; break; }
    }
    if (!match) { blocking.push({ path: file, why: "new test content that is not a move of a deleted test" }); continue; }
    used.add(match.from);
    files.push({ path: file, from: match.from, kind: match.identical ? "rename" : "move" });
  }
  for (const file of deleted) if (!used.has(file)) blocking.push({ path: file, why: "test deleted" });
  return { files, blocking };
}
