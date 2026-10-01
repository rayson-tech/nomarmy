// Later jobs use the operator's promises and the worker's import graph.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createVerificationRunner } from "./verify.mjs";
import { acceptanceEvidence } from "./acceptance-result.mjs";
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

/** Snapshot operator contracts outside the worker tree and check inside verification's sandbox. */
export async function runContractChecks({ contracts, worktree, projectDir, jobDir, jobId,
  timeoutMs, verify = createVerificationRunner({ hostProjectDir: projectDir,
    ...(timeoutMs === undefined ? {} : { commandTimeoutMs: timeoutMs, overallTimeoutMs: timeoutMs }) }) }) {
  const directory = fs.mkdtempSync(path.join(jobDir ?? os.tmpdir(), "acceptance-contracts-"));
  try {
    fs.chmodSync(directory, 0o755);
    contracts.forEach(({ file, ...contract }, index) => {
      fs.writeFileSync(path.join(directory, `${index}.yml`), JSON.stringify(contract), { mode: 0o644 });
    });
    const checked = acceptanceEvidence(await verify({ cwd: worktree, jobId,
      profile: "acceptance-contracts", acceptanceContractsDir: directory }));
    // The checker reports mount-relative paths. Match by snapshot filename, not
    // criterion IDs (IDs need only be unique within each contract).
    if (checked.contracts.length !== contracts.length) throw new Error("incomplete acceptance result");
    return contracts.map((contract, index) => {
      const result = checked.contracts.find(entry => typeof entry.file === "string" && path.posix.basename(entry.file) === `${index}.yml`);
      if (!result || JSON.stringify(result.criteria.map(c => c.id)) !== JSON.stringify(contract.criteria.map(c => c.id))) {
        throw new Error("incomplete acceptance result");
      }
      return { file: contract.file, results: result.criteria };
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

/** No contracts or affected criteria means no sandbox run. */
export async function checkJobContracts({ projectDir, worktree, changedFiles, timeoutMs, jobDir, jobId, verify, run = runContractChecks }) {
  const impact = affectedContracts({ contracts: loadContracts(projectDir), worktree, changedFiles });
  const criteria = impact.contracts.flatMap(contract => contract.criteria.map(({ id, text }) => ({
    id, text, file: contractDisplayPath(projectDir, contract.file),
  })));
  const record = { affected: criteria.map(criterion => criterion.id), broken: [], ...(impact.bounded ? { bounded: impact.bounded } : {}) };
  if (!criteria.length) return { record, criteria, issues: [] };
  let checked;
  try { checked = await run({ contracts: impact.contracts, worktree, projectDir, timeoutMs, jobDir, jobId, verify }); }
  catch (error) {
    checked = impact.contracts.map(contract => ({ file: contract.file, results: contract.criteria.map(criterion => ({
      id: criterion.id, status: "broken", failures: [{ detail: `couldn't run: ${error.message}` }],
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
