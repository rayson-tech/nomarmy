import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { loadContracts, checkContract, contractDisplayPath } from "./acceptance.mjs";
import { isTestPath } from "./diff-checks.mjs";
import { loadRun } from "./runs.mjs";
import { samePath } from "./same-path.mjs";

export function criteriaProblems(criteria, repoDir, mode = "implement") {
  if (!criteria?.length) return [];
  if (mode !== "implement") return ["criteria is only supported for implement jobs"];
  try {
    const contracts = loadContracts(repoDir);
    const defined = new Set(contracts.flatMap(c => c.criteria.map(c => c.id)));
    const unknown = [...new Set(criteria)].filter(id => !defined.has(id));
    return unknown.length ? [`Unknown acceptance criteria: ${unknown.join(", ")}. Contract files searched: ${contracts.map(c => contractDisplayPath(repoDir, c.file)).join(", ") || "acceptance/*.yml (none)"}`] : [];
  } catch (error) { return [`Could not load acceptance contracts: ${error.message}`]; }
}

// Tokenize without executing worker source. Comments and quoted text cannot
// impersonate calls. Full-context diffs let body-only edits select their test.
function tokens(source) {
  const re = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g;
  return [...source.matchAll(re)].filter(m => !m[0].startsWith("//") && !m[0].startsWith("/*")).map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
}
function literalName(raw) {
  if (!/^["'`]/.test(raw)) return null;
  let text = raw.slice(1, -1);
  // Keep the source template for review; checkContract matches only its fixed prefix.
  return text.replace(/\\(u\{[0-9a-f]+\}|u[0-9a-f]{4}|x[0-9a-f]{2}|\r?\n|.)/gi, (_, escape) => {
    if (/^u\{/.test(escape)) return String.fromCodePoint(parseInt(escape.slice(2, -1), 16));
    if (/^[ux]/.test(escape)) return String.fromCharCode(parseInt(escape.slice(1), 16));
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "\n": "", "\r\n": "" })[escape] ?? escape;
  });
}
export function proposalsFromDiff(diff, criteria) {
  const files = [];
  let file = null;
  for (const line of String(diff).split("\n")) {
    if (line.startsWith("diff --git ")) { file = null; continue; }
    if (!file && line.startsWith("+++ ")) {
      let name = line.slice(4).split("\t", 1)[0];
      if (name.startsWith('"')) { try { name = JSON.parse(name); } catch { continue; } }
      name = name.replace(/^b\//, "");
      file = { name, source: "", changes: [] };
      files.push(file);
    } else if (file && /^[ +\-]/.test(line)) {
      if (line[0] !== " ") file.changes.push({ offset: file.source.length, removed: line[0] === "-" });
      if (line[0] !== "-") file.source += line.slice(1) + "\n";
    }
  }
  const proposals = [];
  for (const f of files.filter(f => isTestPath(f.name) && /\.[cm]?[jt]sx?$/.test(f.name))) {
    const ts = tokens(f.source);
    for (let i = 0; i < ts.length - 3; i++) {
      if (!["test", "it"].includes(ts[i].text) || ts[i - 1]?.text === "." || ts[i + 1].text !== "(") continue;
      const name = literalName(ts[i + 2].text);
      if (!name || ts[i + 3].text !== ",") continue;
      let depth = 1, end = i + 2;
      for (; end < ts.length; end++) {
        if (ts[end].text === "(") depth++;
        if (ts[end].text === ")" && --depth === 0) break;
      }
      if (!ts[end] || !f.changes.some(({ offset, removed }) => (removed ? offset > ts[i].start : offset >= f.source.lastIndexOf("\n", ts[i].start - 1) + 1) && offset < ts[end].end)) continue;
      for (const criterion of criteria ?? []) {
        const proposal = { criterion, file: f.name, test: name };
        if (!proposals.some(p => JSON.stringify(p) === JSON.stringify(proposal))) proposals.push(proposal);
      }
    }
  }
  return proposals;
}

export async function jobAcceptanceProposals({ criteria, commit, regressionCheck, diff }) {
  if (!criteria?.length || !commit?.created || regressionCheck?.status !== "pass") return undefined;
  return proposalsFromDiff(await diff(), criteria);
}

export function gatherAcceptanceProposals({ id, repoDir, jobsRoot, runsRoot }) {
  if (!/^[A-Za-z0-9_-]+$/.test(id ?? "")) throw new Error("Expected a run ID or job ID");
  const run = id.startsWith("run-") ? loadRun(runsRoot, id) : null;
  if (run && !samePath(run.repo, repoDir)) throw new Error(`Run ${id} belongs to another repository`);
  const ids = run ? run.jobs.map(j => j.jobId) : [id];
  return ids.flatMap(jobId => {
    if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error("Invalid job ID in run");
    let job;
    try { job = JSON.parse(fs.readFileSync(path.join(jobsRoot, jobId, "metadata.json"), "utf8")); }
    catch (error) {
      // Failed jobs may have only failure.json, with no proposal record.
      if (run && error.code === "ENOENT") return [];
      throw error;
    }
    if (!samePath(job.projectDir, repoDir)) throw new Error(`Job ${jobId} belongs to another repository`);
    return job.acceptanceProposals ?? [];
  });
}

/** Edit only insertion points and an eligible status scalar, never stringify a contract. */
export function fillAcceptance({ repoDir, proposals, dryRun = false }) {
  const contracts = loadContracts(repoDir);
  const owners = new Map();
  for (const contract of contracts) for (const criterion of contract.criteria) {
    if (owners.has(criterion.id)) throw new Error(`Ambiguous acceptance criterion ${criterion.id}`);
    owners.set(criterion.id, contract);
  }
  for (const p of proposals) if (!owners.has(p.criterion)) throw new Error(`Unknown acceptance criterion ${p.criterion}`);
  const results = [], writes = [];
  for (const contract of contracts) {
    const source = fs.readFileSync(contract.file, "utf8");
    const doc = YAML.parseDocument(source);
    const edits = [];
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    for (const [index, criterion] of contract.criteria.entries()) {
      const proposed = proposals.filter(p => p.criterion === criterion.id);
      if (!proposed.length) continue;
      const added = [];
      for (const p of proposed) {
        const ref = { file: p.file, test: p.test };
        if (!criterion.proven_by.concat(added).some(r => r.file === ref.file && r.test === ref.test)) added.push(ref);
      }
      if (!added.length && criterion.status !== "unproven") continue;
      const node = doc.get("criteria").items[index];
      const seq = node.get("proven_by");
      if (!YAML.isSeq(seq)) throw new Error(`${criterion.id}: proven_by must be a literal YAML sequence`);
      const refs = added.map(r => `{ file: ${JSON.stringify(r.file)}, test: ${JSON.stringify(r.test)} }`);
      if (added.length && seq.flow) {
        const pos = seq.range[1] - 1;
        edits.push({ start: pos, end: pos, text: `${seq.items.length && !source.slice(seq.items.at(-1).range[1], pos).trimStart().startsWith(",") ? "," : ""} ${refs.join(", ")}` });
      } else if (added.length) {
        const pos = seq.range[2];
        const indent = seq.range[0] - source.lastIndexOf("\n", seq.range[0] - 1) - 1;
        edits.push({ start: pos, end: pos, text: `${pos && source[pos - 1] !== "\n" ? newline : ""}${refs.map(r => " ".repeat(indent) + "- " + r + newline).join("")}` });
      }
      const [checked] = checkContract({ ...contract, criteria: [{ ...criterion, proven_by: [...criterion.proven_by, ...added] }] }, { repoDir });
      const status = criterion.status === "unproven" && checked.status === "met" ? "met" : criterion.status;
      if (status !== criterion.status) {
        const scalar = node.get("status", true);
        edits.push({ start: scalar.range[0], end: scalar.range[1], text: status });
      }
      if (!added.length && status === criterion.status) continue;
      results.push({ criterion: criterion.id, file: contractDisplayPath(repoDir, contract.file), added, status });
    }
    if (edits.length) {
      let text = source;
      for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
      // Validate our surgical insertion before touching any file.
      const actual = YAML.parse(text);
      for (const result of results.filter(r => r.file === contractDisplayPath(repoDir, contract.file))) {
        const before = contract.criteria.find(c => c.id === result.criterion);
        const after = actual.criteria.find(c => c.id === result.criterion);
        if (JSON.stringify(after.proven_by) !== JSON.stringify([...before.proven_by, ...result.added])) throw new Error(`${result.criterion}: could not safely append proofs`);
      }
      writes.push({ file: contract.file, text });
    }
  }
  if (!dryRun) for (const write of writes) fs.writeFileSync(write.file, write.text);
  return { dryRun, criteria: results };
}
