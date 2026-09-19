#!/usr/bin/env node
// Deterministic repository evidence. No model, no network, no dependencies.
//
// Most "scout-shaped" questions are not questions for a language model:
// where is X defined, who references it, what does this file declare, which
// files match this pattern. Answering them by reading files into a frontier
// model's context is the most expensive way to do it, and answering them with
// a small local model adds latency and invented citations on top. This module
// answers them from the files, in milliseconds, with an exact [path:line] on
// every hit.
//
// It runs in two places with the same code: on the host as the coordinator's
// `repo_evidence` MCP tool, and inside the worker sandbox as a CLI a scout can
// call. Inside the sandbox the output lines ARE citations in the scout
// contract's syntax, so the model copies real locations instead of a template.
//
// Definitions are found heuristically per language family. That is stated in
// every result; a heuristic hit is still a real line in a real file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_IGNORES = Object.freeze([
  "node_modules", ".git", ".openclaw", ".npm", ".npm-cache", "dist", "build", "out", "coverage", ".next", ".nuxt",
  "target", "vendor", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".cache", ".idea", ".vscode",
]);
export const LIMITS = Object.freeze({ maxFiles: 20000, maxFileBytes: 2 * 1024 * 1024, maxResults: 200, maxLineChars: 200, binarySniffBytes: 8192 });

const TEXT_EXT_HINT = /\.(mjs|cjs|js|jsx|ts|tsx|py|go|rs|java|kt|kts|cs|rb|php|sh|bash|zsh|ps1|c|h|cpp|hpp|cc|swift|m|scala|sql|yml|yaml|json|toml|ini|cfg|env|md|txt|html|css|scss|vue|svelte|tf|hcl|dockerfile|make|gradle|xml|proto|graphql)$/i;

// ---------------------------------------------------------------------------
// File walk
// ---------------------------------------------------------------------------
function globToRegex(glob) {
  // Minimal glob: ** any path, * within a segment, ? one char, {a,b} alternation.
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") { if (glob[i + 1] === "*") { re += "(?:.*\\/)?"; i++; if (glob[i + 1] === "/") { i++; } } else re += "[^/]*"; }
    else if (ch === "?") re += "[^/]";
    else if (ch === "{") { const j = glob.indexOf("}", i); if (j > i) { re += "(" + glob.slice(i + 1, j).split(",").map(s => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|") + ")"; i = j; } else re += "\\{"; }
    else if (/[.+^$()|[\]\\]/.test(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp("^(?:.*/)?" + re + "$");
}
export function matchesGlob(rel, glob) {
  if (!glob) return true;
  return globToRegex(glob.replace(/\\/g, "/")).test(rel);
}

export function listFiles(root, { glob = null, ignores = DEFAULT_IGNORES, maxFiles = LIMITS.maxFiles } = {}) {
  const files = [];
  const ignore = new Set(ignores);
  const stack = [""];
  let truncated = false;
  while (stack.length && !truncated) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (ignore.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(r);
      else if (e.isFile()) {
        if (glob && !matchesGlob(r, glob)) continue;
        files.push(r);
        if (files.length >= maxFiles) { truncated = true; break; }
      }
    }
  }
  return { files: files.sort(), truncated };
}

function readTextFile(root, rel) {
  const abs = path.join(root, rel);
  let stat;
  try { stat = fs.statSync(abs); } catch { return null; }
  if (stat.size > LIMITS.maxFileBytes) return null;
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return null; }
  const sniff = buf.subarray(0, LIMITS.binarySniffBytes);
  if (sniff.includes(0) && !TEXT_EXT_HINT.test(rel)) return null;
  return buf.toString("utf8");
}

function clip(text, max = LIMITS.maxLineChars) {
  const t = text.replace(/\t/g, "  ").trimEnd();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------
export function grepRepo(root, { pattern, regex = true, ignoreCase = false, wholeWord = false, glob = null, maxResults = LIMITS.maxResults, ignores = DEFAULT_IGNORES } = {}) {
  if (!pattern) throw new Error("grep needs a pattern");
  let src = regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (wholeWord) src = `\\b(?:${src})\\b`;
  let re;
  try { re = new RegExp(src, ignoreCase ? "i" : ""); } catch (e) { throw new Error(`invalid pattern: ${e.message}`); }
  const { files, truncated: filesTruncated } = listFiles(root, { glob, ignores });
  const hits = [];
  let filesScanned = 0, truncated = false;
  for (const rel of files) {
    const text = readTextFile(root, rel);
    if (text === null) continue;
    filesScanned++;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      hits.push({ path: rel, line: i + 1, text: clip(lines[i]) });
      if (hits.length >= maxResults) { truncated = true; break; }
    }
    if (truncated) break;
  }
  return { hits, truncated: truncated || filesTruncated, filesScanned };
}

// ---------------------------------------------------------------------------
// definitions / references / outline (heuristic, per language family)
// ---------------------------------------------------------------------------
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Definition patterns. `S` is the escaped symbol, or a capture for outline. */
export function definitionPatterns(S) {
  const n = S; // already escaped or a capture group
  return [
    { kind: "function", lang: "js", re: `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${n}\\s*[(<]` },
    { kind: "const", lang: "js", re: `^\\s*(?:export\\s+)?(?:const|let|var)\\s+${n}\\s*(?::[^=]+)?=` },
    { kind: "class", lang: "js", re: `^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${n}\\b` },
    { kind: "type", lang: "ts", re: `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:interface|type|enum)\\s+${n}\\b` },
    { kind: "method", lang: "js", re: `^\\s+(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+|override\\s+)*${n}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{` },
    { kind: "function", lang: "py", re: `^\\s*(?:async\\s+)?def\\s+${n}\\s*\\(` },
    { kind: "class", lang: "py", re: `^\\s*class\\s+${n}\\s*[(:]` },
    { kind: "function", lang: "go", re: `^func\\s+(?:\\([^)]*\\)\\s*)?${n}\\s*[(\\[]` },
    { kind: "type", lang: "go", re: `^type\\s+${n}\\s+` },
    { kind: "function", lang: "rust", re: `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:unsafe\\s+)?fn\\s+${n}\\s*[(<]` },
    { kind: "type", lang: "rust", re: `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|trait|type)\\s+${n}\\b` },
    // A typed declaration `Type name(`; the lookahead stops `return foo(` and
    // `await foo(` from reading as a definition named foo.
    { kind: "method", lang: "jvm", re: `^\\s*(?!(?:return|new|throw|await|yield|else|case|typeof|delete|void|if|while|for|switch|catch|const|let|var|import|export|from|not|and|or|is|print|assert|raise|in|of|do|goto|defer|go)\\s)(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|open|suspend)\\s+)*(?:[\\w<>\\[\\],.?]+\\s+)${n}\\s*\\(` },
    { kind: "class", lang: "jvm", re: `^\\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open|partial)\\s+)*(?:class|interface|enum|record|object|struct)\\s+${n}\\b` },
    { kind: "function", lang: "rb", re: `^\\s*def\\s+(?:self\\.)?${n}\\b` },
    { kind: "class", lang: "rb", re: `^\\s*(?:class|module)\\s+${n}\\b` },
    { kind: "function", lang: "sh", re: `^\\s*(?:function\\s+)?${n}\\s*\\(\\)\\s*\\{` },
  ];
}

export function findDefinitions(root, symbol, { glob = null, maxResults = LIMITS.maxResults, ignores = DEFAULT_IGNORES } = {}) {
  if (!symbol) throw new Error("definitions needs a symbol");
  const pats = definitionPatterns(esc(symbol)).map(p => ({ ...p, rx: new RegExp(p.re) }));
  const { files, truncated: filesTruncated } = listFiles(root, { glob, ignores });
  const hits = [];
  let truncated = false;
  for (const rel of files) {
    const text = readTextFile(root, rel);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && !truncated; i++) {
      const p = pats.find(p => p.rx.test(lines[i]));
      if (!p) continue;
      hits.push({ path: rel, line: i + 1, text: clip(lines[i]), kind: p.kind, lang: p.lang });
      if (hits.length >= maxResults) truncated = true;
    }
    if (truncated) break;
  }
  return { symbol, hits, truncated: truncated || filesTruncated, heuristic: true };
}

export function findReferences(root, symbol, { glob = null, maxResults = LIMITS.maxResults, ignores = DEFAULT_IGNORES } = {}) {
  if (!symbol) throw new Error("references needs a symbol");
  const defs = findDefinitions(root, symbol, { glob, maxResults: LIMITS.maxResults, ignores });
  const defKeys = new Set(defs.hits.map(h => `${h.path}:${h.line}`));
  const all = grepRepo(root, { pattern: esc(symbol), wholeWord: true, glob, maxResults: maxResults + defKeys.size, ignores });
  const hits = all.hits.filter(h => !defKeys.has(`${h.path}:${h.line}`)).slice(0, maxResults);
  return { symbol, hits, definitions: defs.hits, truncated: all.truncated || hits.length >= maxResults, filesScanned: all.filesScanned };
}

export function outlineFile(root, rel) {
  if (!rel) throw new Error("outline needs a path");
  const clean = String(rel).replace(/\\/g, "/").replace(/^\.\//, "");
  if (clean.startsWith("/") || clean.split("/").includes("..")) throw new Error("outline path must be inside the repository");
  const text = readTextFile(root, clean);
  if (text === null) return { path: clean, exists: fs.existsSync(path.join(root, clean)), items: [], reason: "not a readable text file" };
  const pats = definitionPatterns("([A-Za-z_$][\\w$]*)").map(p => ({ ...p, rx: new RegExp(p.re) }));
  const lines = text.split(/\r?\n/);
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*(\/\/|#|\*|\/\*)/.test(line)) continue;
    for (const p of pats) {
      const m = line.match(p.rx);
      if (!m) continue;
      // Methods and nested definitions are kept, but only shallowly indented
      // ones, so an outline is an outline and not every callback.
      const indent = line.match(/^\s*/)[0].length;
      if (indent > 4 && p.kind !== "method") break;
      const exported = /^\s*(export|pub|public)\b/.test(line);
      items.push({ line: i + 1, kind: p.kind, name: m[1], exported, text: clip(line, 120) });
      break;
    }
  }
  return { path: clean, exists: true, lines: lines.length, items, heuristic: true };
}

// ---------------------------------------------------------------------------
// Dispatcher and citation formatting
// ---------------------------------------------------------------------------
export const OPS = Object.freeze(["grep", "definitions", "references", "outline", "files"]);

export function runQuery(root, op, args = {}) {
  const max = Math.max(1, Math.min(Number(args.max_results) || LIMITS.maxResults, 1000));
  switch (op) {
    case "grep": return { op, ...grepRepo(root, { pattern: args.query, regex: args.regex !== false, ignoreCase: Boolean(args.ignore_case), wholeWord: Boolean(args.whole_word), glob: args.glob ?? null, maxResults: max }) };
    case "definitions": return { op, ...findDefinitions(root, args.query, { glob: args.glob ?? null, maxResults: max }) };
    case "references": return { op, ...findReferences(root, args.query, { glob: args.glob ?? null, maxResults: max }) };
    case "outline": return { op, ...outlineFile(root, args.path ?? args.query) };
    case "files": { const r = listFiles(root, { glob: args.glob ?? args.query ?? null, maxFiles: max }); return { op, files: r.files, truncated: r.truncated }; }
    default: throw new Error(`unknown op '${op}'; expected one of ${OPS.join(", ")}`);
  }
}

/** Render results as lines the scout contract accepts verbatim: [path:line] text. */
export function formatCitations(result) {
  const out = [];
  if (result.op === "files") {
    for (const f of result.files) out.push(`[${f}]`);
    if (!result.files.length) out.push("(no files matched)");
  } else if (result.op === "outline") {
    if (!result.items?.length) out.push(result.exists ? `(no definitions recognised in ${result.path}; ${result.lines ?? "?"} lines)` : `(no such file: ${result.path})`);
    for (const it of result.items ?? []) out.push(`[${result.path}:${it.line}] ${it.kind}${it.exported ? " (exported)" : ""} ${it.name}`);
  } else {
    if (result.op === "references" && result.definitions?.length) {
      out.push(`definitions of ${result.symbol}:`);
      for (const h of result.definitions) out.push(`[${h.path}:${h.line}] ${h.text}`);
      out.push(`references:`);
    }
    for (const h of result.hits) out.push(`[${h.path}:${h.line}] ${h.text}`);
    if (!result.hits.length) out.push(`(no matches${result.op === "grep" ? "" : ` for ${result.symbol}`})`);
  }
  if (result.truncated) out.push("(results truncated; narrow the query or add --glob)");
  if (result.heuristic) out.push("(definitions are matched heuristically by language family)");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// CLI: node repo-query.mjs <op> <query|path> [--glob <g>] [--max <n>] [--json] [--root <dir>]
// ---------------------------------------------------------------------------
const isMain = (() => { try { return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = n => argv.includes(`--${n}`);
  const val = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const op = argv[0], query = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
  if (!op || !OPS.includes(op)) {
    console.log(`usage: node repo-query.mjs <${OPS.join("|")}> <query|path> [--glob <pattern>] [--max <n>] [--ignore-case] [--json]\n\n` +
      `  grep <regex>          lines matching a pattern\n  definitions <symbol>  where a symbol is defined (heuristic)\n` +
      `  references <symbol>   where a symbol is used, definitions listed first\n  outline <path>        what one file declares\n  files <glob>          files matching a glob\n\n` +
      `Every output line starts with a [path:line] citation you can copy verbatim.`);
    process.exit(op ? 2 : 0);
  }
  try {
    const root = path.resolve(val("root", process.cwd()));
    const result = runQuery(root, op, { query, path: query, glob: val("glob"), max_results: val("max"), ignore_case: flag("ignore-case"), whole_word: flag("word") });
    console.log(flag("json") ? JSON.stringify(result, null, 2) : formatCitations(result));
  } catch (err) { console.error(`repo-query ${op}: ${err.message}`); process.exit(1); }
}
