// Bounded heuristic dependency reach over the untouched base snapshot.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { listFiles, outlineFile, findReferences } from "./repo-query.mjs";
import { readTrustWorktreeFile, decodeTrustBytes } from "./trust.mjs";
import { lineDiff } from "./trust-judgment.mjs";
import { escRegex } from "./diff-checks.mjs";

const identity = n => `${n.file}:${n.line}:${n.symbol}`;
function endLine(lines, start, file) {
  if (/\.pyi?$/.test(file)) {
    const indent = lines[start].match(/^\s*/)[0].length;
    let end = start + 1;
    while (end < lines.length && (!lines[end].trim() || /^\s*#/.test(lines[end]) || lines[end].match(/^\s*/)[0].length > indent)) end++;
    return end;
  }
  // Preserve line positions while ignoring braces inside strings and comments.
  const tail = lines.slice(start).join("\n").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, s => s.replace(/[^\n]/g, " "));
  let depth = 0, opened = false, line = start + 1;
  for (let index = 0; index < tail.length; index++) {
    const ch = tail[index];
    if (ch === "{") { depth++; opened = true; }
    if (ch === "}" && opened && --depth === 0) return line;
    if (!opened && (ch === ";" || ch === "\n" && !/[({=,]\s*$/.test(lines[start]) && !tail.slice(index + 1).trimStart().startsWith("{"))) return line;
    if (ch === "\n") line++;
  }
  return lines.length;
}

// Static import bindings only. Never execute modules or consult the worker view.
function importBindings(file, lines, files) {
  const source = lines.join("\n");
  const bindings = [];
  const add = (local, symbol, module, python = false) => {
    let bases;
    if (python) {
      const dots = module.match(/^\.+/)?.[0].length ?? 0;
      const suffix = module.slice(dots).replaceAll(".", "/");
      bases = dots ? [path.posix.join(path.posix.dirname(file), ...Array(dots - 1).fill(".."), suffix)]
        : [suffix, path.posix.join(path.posix.dirname(file), suffix), "src/" + suffix];
    } else bases = module.startsWith(".") ? [path.posix.join(path.posix.dirname(file), module)] : [];
    const targets = bases.flatMap(base => [base, ...[".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".pyi"].map(ext => base + ext),
      ...["index.js", "index.mjs", "index.cjs", "index.ts", "__init__.py"].map(name => base + "/" + name)]).filter(f => files.has(f));
    bindings.push({ local, symbol, targets });
  };
  if (/\.pyi?$/.test(file)) {
    const code = source.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\n]*/g, s => s.replace(/[^\n]/g, " "));
    for (const m of code.matchAll(/(?:^|[;\n])\s*(?:from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^;\n]+)|import\s+([^;\n]+))/g)) {
      for (const part of (m[2] ?? m[3]).replace(/[()]/g, "").split(",")) {
        const binding = part.trim().match(/^([\w.]+)(?:\s+as\s+(\w+))?$/);
        if (binding) add(binding[2] ?? binding[1], m[1] ? binding[1] : null, m[1] ?? binding[1], true);
      }
    }
  } else {
    // Tokenization keeps import-looking strings and comments from becoming syntax.
    const tokens = (source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g) ?? []).filter(t => !t.startsWith("/*") && !t.startsWith("//"));
    const literal = t => t && /^["']/.test(t) ? t.slice(1, -1) : null;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "import") {
        if (tokens[i + 1] === "*" && tokens[i + 2] === "as" && tokens[i + 4] === "from" && literal(tokens[i + 5])) add(tokens[i + 3], null, literal(tokens[i + 5]));
        if (tokens[i + 1] !== "{") continue;
        const end = tokens.indexOf("}", i + 2);
        if (end < 0 || tokens[end + 1] !== "from" || !literal(tokens[end + 2])) continue;
        for (const part of tokens.slice(i + 2, end).join(" ").split(",")) {
          const m = part.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
          if (m) add(m[2] ?? m[1], m[1], literal(tokens[end + 2]));
        }
      }
      if (["const", "let", "var"].includes(tokens[i]) && tokens[i + 1] === "{") {
        const end = tokens.indexOf("}", i + 2);
        if (end < 0 || tokens[end + 1] !== "=" || tokens[end + 2] !== "require" || tokens[end + 3] !== "(" || !literal(tokens[end + 4]) || tokens[end + 5] !== ")") continue;
        for (const part of tokens.slice(i + 2, end).join(" ").split(",")) {
          const m = part.trim().match(/^([\w$]+)(?:\s*:\s*([\w$]+))?$/);
          if (m) add(m[2] ?? m[1], m[1], literal(tokens[end + 4]));
        }
      }
    }
  }
  return bindings;
}

export function computeTrustReach({ baseDir, entries, depth = 3, fanOut = 25 }) {
  if (!Number.isInteger(depth) || depth < 0 || depth > 10 || !Number.isInteger(fanOut) || fanOut < 1 || fanOut > 100) throw new Error("Invalid trust reach bounds");
  const listing = listFiles(baseDir);
  const nodes = [], caps = [], texts = new Map();
  if (listing.truncated) caps.push({ kind: "files", symbol: null, file: null, limit: 20000 });
  for (const file of listing.files) {
    if (!/\.(?:[cm]?[jt]sx?|pyi?|go|rs|java|kt|cs|rb|php|sh|c|h|cpp|hpp|swift)$/.test(file)) continue;
    const snap = readTrustWorktreeFile(baseDir, file);
    if (!snap.regular || snap.problem) { caps.push({ kind: "unreadable", symbol: null, file, limit: null }); continue; }
    const lines = snap.bytes.toString("utf8").split(/\r?\n/);
    texts.set(file, lines);
    const outline = outlineFile(baseDir, file);
    if (outline.reason) caps.push({ kind: "unreadable", symbol: null, file, limit: null });
    for (const item of outline.items) nodes.push({ symbol: item.name, file, line: item.line, end: endLine(lines, item.line - 1, file) });
  }
  const byName = new Map();
  for (const node of nodes) { if (!byName.has(node.symbol)) byName.set(node.symbol, []); byName.get(node.symbol).push(node); }
  const imports = new Map([...texts].map(([file, lines]) => [file, importBindings(file, lines, texts)]));
  const edgeCache = new Map();
  const edges = node => {
    if (edgeCache.has(identity(node))) return edgeCache.get(identity(node));
    const body = texts.get(node.file).slice(node.line - 1, node.end).join("\n");
    const tokens = new Set(body.match(/[A-Za-z_$][\w$]*/g) ?? []);
    const deps = [], bound = new Set();
    let unboundBody = body;
    for (const binding of imports.get(node.file) ?? []) {
      const escaped = escRegex(binding.local);
      const members = binding.symbol ? (tokens.has(binding.local) ? [binding.symbol] : [])
        : [...body.matchAll(new RegExp(`\\b${escaped}\\s*\\.\\s*([\\w$]+)`, "g"))].map(m => m[1]);
      bound.add(binding.local);
      if (!binding.symbol) unboundBody = unboundBody.replace(new RegExp(`\\b${escaped}\\s*\\.\\s*([\\w$]+)`, "g"), match => match.replace(/[^\n]/g, " "));
      for (const symbol of members) {
        const targets = (byName.get(symbol) ?? []).filter(n => binding.targets.includes(n.file));
        if (!targets.length) caps.push({ kind: "unresolved-import", symbol, file: node.file, limit: null });
        deps.push(...targets.filter(n => identity(n) !== identity(node)));
      }
    }
    for (const token of new Set(unboundBody.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      if (bound.has(token) || !byName.has(token)) continue;
      const refs = findReferences(baseDir, token, { glob: node.file, maxResults: 10000 });
      if (refs.truncated) caps.push({ kind: "references", symbol: token, file: node.file, limit: 10000 });
      // repo-query excludes definition lines; a one-line function can call
      // another symbol on that same line, so retain that reference too.
      const first = texts.get(node.file)[node.line - 1];
      if (!refs.hits.some(h => h.path === node.file && h.line >= node.line && h.line <= node.end) && !(token !== node.symbol && new RegExp(`\\b${escRegex(token)}\\b`).test(first))) continue;
      deps.push(...byName.get(token).filter(n => identity(n) !== identity(node)));
    }
    const unique = [...new Map(deps.map(n => [identity(n), n])).values()].sort((a, b) => identity(a).localeCompare(identity(b)));
    edgeCache.set(identity(node), unique);
    return unique;
  };
  const boundaries = entries.map(entry => {
    if (entry.symbol === "*") return { entry, nodes: [] };
    const roots = (byName.get(entry.symbol) ?? []).filter(n => n.file === entry.file);
    if (!roots.length) caps.push({ kind: "unresolved", symbol: entry.symbol, file: entry.file, limit: null });
    const reached = new Map(), queue = roots.map(n => ({ ...n, depth: 0, via: [] }));
    while (queue.length) {
      const node = queue.shift();
      if (reached.has(identity(node))) continue;
      reached.set(identity(node), node);
      const children = edges(node).filter(n => !reached.has(identity(n)));
      if (children.length && node.depth === depth) { caps.push({ kind: "depth", symbol: node.symbol, file: node.file, limit: depth }); continue; }
      if (children.length > fanOut) caps.push({ kind: "fan-out", symbol: node.symbol, file: node.file, limit: fanOut });
      for (const child of children.slice(0, fanOut)) queue.push({ ...child, depth: node.depth + 1, via: [...node.via, { symbol: node.symbol, file: node.file, line: node.line }] });
    }
    return { entry, nodes: [...reached.values()] };
  });
  return { heuristic: true, depth, fanOut, caps: [...new Map(caps.map(c => [JSON.stringify(c), c])).values()], boundaries };
}

export function cachedTrustReach({ baseDir, baseCommit, stateDir, entries, depth = 3, fanOut = 25 }) {
  const key = createHash("sha256").update(JSON.stringify({ version: 3, baseCommit, entries, depth, fanOut })).digest("hex");
  const dir = path.join(stateDir, "trust-reach");
  const cacheFile = path.join(dir, `${key}.json`);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (cached.key === key && cached.baseCommit === baseCommit) return cached;
  } catch (e) { if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e; }
  const result = { key, baseCommit, ...computeTrustReach({ baseDir, entries, depth, fanOut }) };
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${cacheFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(result), { flag: "wx" });
  try { fs.renameSync(temp, cacheFile); } finally { fs.rmSync(temp, { force: true }); }
  return result;
}

function changedBaseLines(before, after) {
  const edits = lineDiff(decodeTrustBytes(before).split("\n"), decodeTrustBytes(after).split("\n"));
  let line = 1;
  const changed = new Set();
  for (const edit of edits) {
    if (edit.prefix === "-") changed.add(line);
    // Insertions are anchored to the next base line, including insertions
    // immediately before a function's closing brace or return.
    if (edit.prefix === "+") changed.add(line);
    if (edit.prefix !== "+") line++;
  }
  return changed;
}
export function evaluateReachTrust({ reach, fileChanges, checks = [] }) {
  if (!reach) return { level: "normal", reasons: [] };
  const reasons = [];
  // Bypasses report the added exit's after-line, while reach nodes use the base.
  const locatedChecks = checks.map(check => {
    if (check.kind !== "bypass") return check;
    const change = fileChanges.find(c => c.file === check.file);
    if (!change) return check;
    let baseLine = 1, afterLine = 1;
    for (const edit of lineDiff(decodeTrustBytes(change.before).split("\n"), decodeTrustBytes(change.after).split("\n"))) {
      if (edit.prefix !== "-" && afterLine === check.line) return { ...check, line: baseLine };
      if (edit.prefix !== "+") baseLine++;
      if (edit.prefix !== "-") afterLine++;
    }
    return check;
  });
  let human = false;
  for (const { entry, nodes } of reach.boundaries) {
    const root = nodes.find(n => n.depth === 0);
    for (const change of fileChanges) {
      if (entry.symbol === "*" && change.file === entry.file && decodeTrustBytes(change.before) !== decodeTrustBytes(change.after)) {
        const removed = locatedChecks.some(check => check.file === entry.file);
        human ||= removed;
        reasons.push({ rule: "trust-reach", file: entry.file, line: 1, reason: `${removed ? "removes a check in" : "changes"} mapped file ${entry.file}, the ${entry.category} boundary` });
      }
      const changed = changedBaseLines(change.before, change.after);
      for (const node of nodes.filter(n => n.file === change.file && [...changed].some(line => line >= n.line && line <= n.end))) {
        const removed = locatedChecks.some(c => c.file === node.file && c.line >= node.line && c.line <= node.end);
        human ||= removed;
        const trail = node.via.map(n => `\`${n.symbol}\` (${n.file}:${n.line})`).join(" -> ");
        reasons.push({ rule: "trust-reach", file: node.file, line: node.line,
          reason: `${removed ? "removes a check in" : "changes"} ${node.depth ? "helper" : "mapped symbol"} \`${node.symbol}\` (${node.file}:${node.line}), ${node.depth ? `which \`${entry.symbol}\` (${entry.file}:${root?.line ?? 1}), the ${entry.category} boundary, depends on via ${trail}` : `the ${entry.category} boundary`}` });
      }
    }
  }
  // A bounded or unresolved graph is not evidence that remaining code is safe.
  if (reach.caps.length && fileChanges.some(c => decodeTrustBytes(c.before) !== decodeTrustBytes(c.after))) reasons.push({ rule: "trust-reach-cap", reason: `trust reach is incomplete: ${reach.caps.map(c => `${c.kind} at ${c.file ?? "repository"}${c.symbol ? `:${c.symbol}` : ""}${c.limit === null ? "" : ` (limit ${c.limit})`}`).join("; ")}` });
  return { level: human ? "human" : reasons.length ? "review" : "normal", reasons: [...new Map(reasons.map(r => [JSON.stringify(r), r])).values()] };
}
