// Mutation testing on the lines a worker changed: plant one small mistake at
// a time and check the job's own verification profile catches it. The revert
// check proves a test notices the change disappearing; this proves the tests
// pin down what the changed lines do (a boundary, a condition, a constant).
// An operator found the same by hand, planting 14 mistakes in a worker's math
// and seeing its tests catch 12.
//
// Mutants are plain text edits nomArmy makes itself, outside strings and
// comments, so no mutation tool has to be installed in the offline sandbox.
// A surviving mutant raises review, never blocks a commit: some mutants
// can't change behavior at all. A file that can't be restored exactly is
// fatal, as with the revert check.

import crypto from "node:crypto";
import path from "node:path";
import { writeWorktreeFile, readWorktreeFile } from "./worktree-write.mjs";

const C_LIKE = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cc", ".cpp", ".cs", ".swift", ".scala"]);
const PYTHON = new Set([".py"]);

// Ordered so the first mutants picked are the most telling: boundaries,
// conditions, then arithmetic and constants.
const OPERATORS = {
  c: [
    ["<=", "<"], [">=", ">"], ["<", "<="], [">", ">="],
    ["===", "!=="], ["!==", "==="], ["==", "!="], ["!=", "=="],
    ["&&", "||"], ["||", "&&"], ["true", "false"], ["false", "true"],
    [" + ", " - "], [" - ", " + "], [" * ", " / "],
  ],
  python: [
    ["<=", "<"], [">=", ">"], ["<", "<="], [">", ">="],
    ["==", "!="], ["!=", "=="], [" and ", " or "], [" or ", " and "],
    ["True", "False"], ["False", "True"], [" + ", " - "], [" - ", " + "], [" * ", " / "],
  ],
};

export function mutationLanguage(file) {
  const ext = path.extname(file).toLowerCase();
  return C_LIKE.has(ext) ? "c" : PYTHON.has(ext) ? "python" : null;
}

/** Where code ends on this line (before a comment), with string literals blanked out. */
function codeView(line, language) {
  let out = "", quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { out += " "; if (ch === "\\") { out += " "; i++; } else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || (ch === "`" && language === "c")) { quote = ch; out += " "; continue; }
    if (language === "c" && ch === "/" && line[i + 1] === "/") break;
    if (language === "python" && ch === "#") break;
    out += ch;
  }
  return out;
}

const isWordChar = (ch) => /[A-Za-z0-9_$]/.test(ch ?? "");
const SKIP_LINE = /^\s*(import\b|from\s+\S+\s+import\b|export\s+\{|#include|package\s|use\s|\/\/|#|\*|\/\*)/;

/** Every single-edit mutant of one line (code only, never strings or comments). */
export function lineMutants(line, language) {
  if (!OPERATORS[language] || SKIP_LINE.test(line)) return [];
  const view = codeView(line, language);
  const found = [];
  const taken = new Set();
  for (const [from, to] of OPERATORS[language]) {
    let at = view.indexOf(from);
    while (at !== -1) {
      const before = view[at - 1], after = view[at + from.length];
      const wordOp = /^[A-Za-z]/.test(from); // " and " carries its own spaces
      const operatorClash = /[<>=!&|+\-*/]/.test(before ?? "") || /[<>=!&|+\-*/]/.test(after ?? "");
      const fine = wordOp ? !isWordChar(before) && !isWordChar(after) : !operatorClash || from.startsWith(" ");
      // `=>` and `->` aren't comparisons.
      const arrow = (from === ">" || from === ">=") && (before === "=" || before === "-");
      if (fine && !arrow && !taken.has(at)) {
        taken.add(at);
        found.push({ from, to, column: at + 1, text: line.slice(0, at) + to + line.slice(at + from.length) });
      }
      at = view.indexOf(from, at + from.length);
    }
  }
  for (const m of view.matchAll(/(?<![A-Za-z0-9_$.])(\d+)(?![A-Za-z0-9_.xX])/g)) {
    const n = Number(m[1]);
    if (!Number.isSafeInteger(n) || taken.has(m.index)) continue;
    found.push({ from: m[1], to: String(n + 1), column: m.index + 1, text: line.slice(0, m.index) + String(n + 1) + line.slice(m.index + m[1].length) });
  }
  return found;
}

/**
 * Up to `max` mutants across the changed lines, spread across files and
 * lines rather than piling onto the first one.
 * @param {{ path: string, full: string, lines: number[] }[]} files
 */
export function pickMutants(files, max, root = null) {
  const perLine = [];
  for (const f of files) {
    const language = mutationLanguage(f.path);
    if (!language) continue;
    let text;
    try {
      const fileRoot = root ?? path.resolve(f.full, ...f.path.split("/").map(() => ".."));
      text = readWorktreeFile(fileRoot, f.full)?.content.toString("utf8");
      if (text === undefined) continue;
    } catch { continue; }
    const lines = text.split("\n");
    for (const n of f.lines) {
      const options = lineMutants(lines[n - 1] ?? "", language);
      if (options.length) perLine.push({ file: f, line: n, options, lines });
    }
  }
  const picked = [];
  for (let round = 0; picked.length < max && perLine.some((p) => p.options[round]); round++) {
    for (const p of perLine) {
      if (picked.length >= max) break;
      const m = p.options[round];
      if (!m) continue;
      const mutatedLines = [...p.lines];
      mutatedLines[p.line - 1] = m.text;
      picked.push({ path: p.file.path, full: p.file.full, line: p.line, from: m.from, to: m.to, original: p.lines[p.line - 1].trim(), mutated: mutatedLines.join("\n") });
    }
  }
  return picked;
}

const hashOf = (root, full) => {
  try { const file = readWorktreeFile(root, full); return file ? crypto.createHash("sha256").update(file.content).digest("hex") : null; }
  catch { return null; }
};

/**
 * Run each mutant through the verification profile, restoring the worker's
 * file after every one. `verify()` resolves to { status: pass|fail|not_run }.
 * @returns {Promise<{ status: "pass"|"survivors"|"not_run"|"restore_failed", killed: number, survived: object[], inconclusive: number, tried: number, reason: string|null }>}
 */
export async function runMutants({ mutants, verify, deadlineMs = Infinity, root = null }) {
  const result = { killed: 0, survived: [], inconclusive: 0, tried: 0, skipped: 0 };
  for (const m of mutants) {
    if (Date.now() > deadlineMs) { result.skipped = mutants.length - result.tried; break; }
    let original;
    try {
      const file = readWorktreeFile(root, m.full);
      if (!file) throw new Error(`missing mutation target ${m.path}`);
      original = file.content;
    } catch (error) { return { ...result, status: "restore_failed", reason: error.message }; }
    const expected = crypto.createHash("sha256").update(original).digest("hex");
    let outcome, restoreError = null;
    try {
      writeWorktreeFile(root, m.full, m.mutated);
      outcome = await verify(m);
    } catch (error) {
      if (error?.restoreFailed) restoreError = error;
      else outcome = { status: "not_run", reason: error.message };
    } finally {
      try { writeWorktreeFile(root, m.full, original); }
      catch (error) { restoreError = restoreError ?? error; }
    }
    result.tried++;
    if (restoreError || hashOf(root, m.full) !== expected) {
      return { ...result, status: "restore_failed", reason: restoreError?.message ?? `${m.path} was not restored exactly after mutation testing` };
    }
    if (outcome?.status === "fail") result.killed++;
    else if (outcome?.status === "pass") result.survived.push({ path: m.path, line: m.line, from: m.from, to: m.to, original: m.original });
    else result.inconclusive++;
  }
  const status = result.tried === 0 ? "not_run" : result.survived.length ? "survivors" : result.killed ? "pass" : "not_run";
  return { ...result, status, reason: status === "not_run" ? (result.tried ? "every mutant's verification was inconclusive" : "no mutants were tried") : null };
}

/** One review line per survivor, and the headline. */
export function describeSurvivors(result, profile) {
  const each = result.survived.map((s) => `${s.path}:${s.line} \`${s.from}\` → \`${s.to}\` in \`${s.original.slice(0, 80)}\``);
  return `MUTANTS SURVIVED: ${result.survived.length} of ${result.tried} small mistakes planted in the changed lines still passed profile '${profile}', so no test pins down what those lines do: ${each.join("; ")}. Add a test for each, or confirm the change can't matter.`;
}
