// Shared, bounded classification. Names are hints, not evidence of isolation.
import path from "node:path";
import { listFiles } from "./repo-query.mjs";
import { decodeTrustBytes, readTrustWorktreeFile } from "./trust.mjs";

const normalize = file => path.posix.normalize(file.replaceAll("\\", "/"));
export const isDocFile = file => /\.(?:md|mdx|rst|txt|adoc)$/i.test(file);
const testName = file => /(?:^|\/)test_[^/]*\.py$|_test\.py$|\.(?:test|spec)\.[^/]+$/i.test(file);
const testDirectory = file => /(?:^|\/)(?:tests?|__tests__)\//i.test(file);
const sourceFile = file => /\.(?:[cm]?[jt]sx?|pyi?|rb|php|go|rs|java|kt|cs|sh|c|h|cpp|hpp|swift)$/i.test(file);
const MAX_FILES = 2000, MAX_BYTES = 16 * 1024 * 1024;

export function snapshotTrustFiles(worktree) {
  const listing = listFiles(worktree, { maxFiles: MAX_FILES });
  const files = [];
  let incomplete = listing.truncated, bytes = 0;
  for (const file of listing.files) {
    if (isDocFile(file)) continue;
    const snapshot = readTrustWorktreeFile(worktree, file);
    bytes += snapshot.bytes.length;
    if (snapshot.problem || !snapshot.regular) { incomplete = true; continue; }
    if (bytes > MAX_BYTES) { incomplete = true; break; }
    files.push({ file, source: decodeTrustBytes(snapshot.bytes) });
  }
  return { files, incomplete };
}

// Like acceptance-impact's static scan, tokenize comments and strings before
// looking for imports. Never execute source or follow a filesystem import.
function references(source, python) {
  const tokens = source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g) ?? [];
  const clean = tokens.filter(t => !t.startsWith("/*") && !t.startsWith("//") && !(python && t.startsWith("#")));
  const literal = token => token && /^["'`]/.test(token) ? token.slice(1, -1) : null;
  const strings = clean.map(literal).filter(value => value !== null);
  const imports = [];
  if (!python) for (let i = 0; i < clean.length; i++) {
    const token = clean[i];
    let specifier = null;
    if (["import", "require"].includes(token) && clean[i + 1] === "(" && clean[i + 3] === ")") specifier = literal(clean[i + 2]);
    else if (token === "import" || token === "export") {
      specifier = token === "import" ? literal(clean[i + 1]) : null;
      if (!specifier) for (let j = i + 1; j < clean.length && ![";", "import", "export"].includes(clean[j]); j++) {
        if (clean[j] === "from") { specifier = literal(clean[j + 1]); break; }
      }
    }
    if (specifier?.startsWith("./") || specifier?.startsWith("../")) imports.push(specifier);
  }
  // Mask strings and comments without losing newlines for syntax evidence.
  const code = source.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/g, s => s.replace(/[^\n]/g, " "));
  if (python) for (const match of code.matchAll(/(?:^|[;\n])\s*(?:from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^;\n]+)|import\s+([^;\n]+))/g)) {
    if (match[1]) {
      imports.push({ module: match[1] });
      for (const part of match[2].replace(/[()]/g, "").split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (/^\w+$/.test(name)) imports.push({ module: match[1] + (match[1].endsWith(".") ? "" : ".") + name });
      }
    } else for (const part of match[3].split(",")) imports.push({ module: part.trim().split(/\s+/)[0] });
  }
  return { imports, strings, code };
}

export function classifyTrustFiles(fileChanges = [], { repository = { files: [], incomplete: false }, worktree } = {}) {
  if (worktree) repository = snapshotTrustFiles(worktree);
  const sources = new Map();
  const add = (file, text) => {
    file = normalize(file);
    if (!sources.has(file)) sources.set(file, []);
    sources.get(file).push(decodeTrustBytes(text));
  };
  for (const { file, source } of repository.files) add(file, source);
  for (const { file, before, after } of fileChanges) { add(file, before); add(file, after); }
  const refs = new Map([...sources].map(([file, texts]) => [file, texts.map(text => references(text, /\.pyi?$/i.test(file)))]));
  // spec/ is a test directory only when its contents supply test evidence.
  const specs = new Set();
  for (const file of sources.keys()) {
    const directory = /^(.*?(?:^|\/)spec)\//i.exec(file)?.[1];
    if (directory && sourceFile(file) && (testName(file) || refs.get(file).some(({ code }) => /\b(?:describe|it|test|suite)\s*\(|\b(?:assert\b|pytest\b|unittest\b)|\bdef\s+test_/.test(code)))) specs.add(directory);
  }
  const tests = new Set([...sources.keys()].filter(file => testDirectory(file) || testName(file) || [...specs].some(dir => file.startsWith(dir + "/"))));
  const production = new Set([...sources.keys()].filter(file => !tests.has(file) && !isDocFile(file)));
  const imported = (file, specifier) => {
    let bases;
    if (typeof specifier === "string") bases = [path.posix.join(path.posix.dirname(file), specifier)];
    else {
      const module = specifier.module, dots = module.match(/^\.+/)?.[0].length ?? 0;
      const suffix = module.slice(dots).replaceAll(".", "/");
      bases = dots ? [path.posix.join(path.posix.dirname(file), ...Array(dots - 1).fill(".."), suffix)]
        : [suffix, path.posix.join(path.posix.dirname(file), suffix), "src/" + suffix];
    }
    return bases.flatMap(base => [base, ...[".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".pyi"].map(ext => base + ext),
      ...["index.js", "index.mjs", "index.cjs", "index.ts", "index.tsx", "__init__.py"].map(name => base + "/" + name)]).filter(candidate => sources.has(candidate));
  };
  const docs = [...sources.keys()].filter(isDocFile);
  // A work queue computes transitive production use, including test helpers
  // imported by other production-promoted helpers. Both diff sides count.
  const queue = [...production];
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    if (isDocFile(file)) continue;
    for (const ref of refs.get(file) ?? []) {
      const targets = ref.imports.flatMap(specifier => imported(file, specifier));
      for (const doc of docs) if (ref.strings.some(value => {
        const name = normalize(value);
        return name === doc || name === path.posix.basename(doc) || path.posix.join(path.posix.dirname(file), name) === doc;
      })) targets.push(doc);
      for (const target of targets) if (!production.has(target)) { production.add(target); queue.push(target); }
    }
  }
  // Incomplete evidence cannot justify excluding a possible production input.
  if (repository.incomplete) for (const file of sources.keys()) production.add(file);
  return {
    isProduction: file => production.has(normalize(file)),
    isTest: file => tests.has(normalize(file)) && !production.has(normalize(file)),
    isReferencedDoc: file => isDocFile(file) && production.has(normalize(file)),
  };
}

// Path-only hint for callers without evidence. Trust decisions use the classifier.
export const isTestFile = file => testDirectory(normalize(file)) || testName(normalize(file));
