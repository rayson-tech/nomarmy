// Later jobs use the operator's promises and the worker's import graph.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadContracts, contractDisplayPath } from "./acceptance.mjs";

const MAX_DEPTH = 8;
const MAX_FILES = 2000;

// Ignore comments and unrelated strings. Keep literal import/require operands;
// no module is evaluated while building this graph.
function imports(source) {
  const tokens = source.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g) ?? [];
  const result = [];
  const literal = token => token && /^["']/.test(token) ? token.slice(1, -1) : null;
  const clean = tokens.filter(t => !t.startsWith("//") && !t.startsWith("/*"));
  for (let i = 0; i < clean.length; i++) {
    const token = clean[i];
    let specifier = null;
    if ((token === "import" || token === "require") && clean[i + 1] === "(" && clean[i + 3] === ")") {
      specifier = literal(clean[i + 2]);
    } else if (token === "import") {
      specifier = literal(clean[i + 1]);
      if (!specifier) {
        for (let j = i + 1; j < clean.length && ![";", "import", "export"].includes(clean[j]); j++) {
          if (clean[j] === "from") { specifier = literal(clean[j + 1]); break; }
        }
      }
    } else if (token === "export") {
      for (let j = i + 1; j < clean.length && ![";", "import", "export"].includes(clean[j]); j++) {
        if (clean[j] === "from") { specifier = literal(clean[j + 1]); break; }
      }
    }
    if (specifier?.startsWith("./") || specifier?.startsWith("../")) result.push(specifier);
  }
  return result;
}

/** Bounds are shared across criteria. An incomplete traversal is conservatively affected. */
export function affectedContracts({ contracts, worktree, changedFiles }) {
  const root = path.resolve(worktree);
  const changed = new Set(changedFiles.map(file => path.resolve(root, file)));
  const cache = new Map();
  const hits = new Set();
  const inside = file => file === root || (!path.relative(root, file).startsWith(".." + path.sep) && path.relative(root, file) !== ".." && !path.isAbsolute(path.relative(root, file)));
  const resolve = (file, specifier) => {
    const base = path.resolve(path.dirname(file), specifier);
    const candidates = [base, ...[".mjs", ".js", ".cjs"].map(ext => base + ext), ...["index.mjs", "index.js", "index.cjs"].map(name => path.join(base, name))];
    for (const candidate of candidates) {
      if (!inside(candidate)) continue;
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* try fallbacks */ }
      // Deleted imports still connect their test to the change.
      if (changed.has(candidate)) return candidate;
    }
    return null;
  };
  const reachesChange = start => {
    const queue = [[path.resolve(root, start), 0]], visited = new Set();
    let incomplete = false;
    for (let index = 0; index < queue.length; index++) {
      const [file, depth] = queue[index];
      if (changed.has(file)) return true;
      if (visited.has(file) || !inside(file)) continue;
      visited.add(file);
      if (!cache.has(file)) {
        if (cache.size >= MAX_FILES) { hits.add("files"); incomplete = true; continue; }
        let source = "";
        try { source = fs.readFileSync(file, "utf8"); } catch { /* a missing reference is checked when affected */ }
        cache.set(file, imports(source).map(specifier => resolve(file, specifier)).filter(Boolean));
      }
      const next = cache.get(file).filter(dependency => !visited.has(dependency));
      if (depth >= MAX_DEPTH && next.length) { hits.add("depth"); incomplete = true; continue; }
      queue.push(...next.map(dependency => [dependency, depth + 1]));
    }
    return incomplete;
  };
  const selected = changed.size ? contracts.map(contract => ({
    ...contract,
    criteria: contract.criteria.filter(criterion => criterion.status !== "retired"
      && criterion.proven_by.some(ref => "file" in ref && reachesChange(ref.file))),
  })).filter(contract => contract.criteria.length) : [];
  return { contracts: selected, ...(hits.size ? { bounded: { depth: MAX_DEPTH, files: MAX_FILES, hit: [...hits].sort() } } : {}) };
}

/** Run the trusted checker in a child, never its synchronous test runner in the server. */
export function runContractChecks({ contracts, worktree, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [fileURLToPath(new URL("./acceptance-impact-child.mjs", import.meta.url))], {
      cwd: worktree, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", stderr = "", failure = null;
    const stop = error => {
      failure ??= error;
      if (process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      } else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop(new Error(`contract check timed out after ${timeoutMs}ms`)), timeoutMs);
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.length > 16 * 1024 * 1024) stop(new Error("contract check output exceeded 16 MiB"));
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.stdin.on("error", () => {}); // early child exit is handled below
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`contract checker exited ${code}: ${stderr.trim()}`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("contract checker returned invalid JSON")); }
    });
    child.stdin.end(JSON.stringify({ contracts, worktree, timeoutMs }));
  });
}

/** No contracts or affected criteria means no child at all. */
export async function checkJobContracts({ projectDir, worktree, changedFiles, timeoutMs, run = runContractChecks }) {
  const impact = affectedContracts({ contracts: loadContracts(projectDir), worktree, changedFiles });
  const criteria = impact.contracts.flatMap(contract => contract.criteria.map(({ id, text }) => ({
    id, text, file: contractDisplayPath(projectDir, contract.file),
  })));
  const record = { affected: criteria.map(criterion => criterion.id), broken: [], ...(impact.bounded ? { bounded: impact.bounded } : {}) };
  if (!criteria.length) return { record, criteria, issues: [] };
  let checked;
  try { checked = await run({ contracts: impact.contracts, worktree, timeoutMs }); }
  catch (error) {
    checked = impact.contracts.map(contract => ({ file: contract.file, results: contract.criteria.map(criterion => ({
      id: criterion.id, status: "broken", failures: [{ detail: error.message }],
    })) }));
  }
  for (const contract of checked) {
    for (const result of contract.results) {
      if (result.status === "broken" || result.status === "missing") record.broken.push({
        id: result.id, file: contractDisplayPath(projectDir, contract.file), failures: result.failures,
      });
    }
  }
  const issues = record.broken.map(({ id, file, failures }) =>
    `CONTRACT BROKEN: ${id} (${file}): ${failures.map(ref => ref.file ? `${ref.file}: ${ref.test}` : ref.command ?? ref.detail).join("; ")}`);
  return { record, criteria, issues };
}
