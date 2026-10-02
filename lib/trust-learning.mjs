// Operator decisions and escaped-defect evidence live outside the checkout.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadTrustMap, loadTrustProposal, reviewTrustProposal } from "./trust-map.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const safeFile = file => typeof file === "string" && file.length > 0 && !/[\\:\r\n\0]/.test(file) && !file.startsWith("/") && !file.split("/").some(p => !p || p === "." || p === "..");
const provider = record => record.metrics?.worker_provider ?? record.worker?.provider;
const sameRepo = (record, repo) => typeof record.projectDir === "string" && path.resolve(record.projectDir) === path.resolve(repo);
export const trustAcknowledgment = trust => Array.isArray(trust?.ack) ? trust.ack.at(-1) ?? null : null;
export const pendingHumanReview = record => record.trust?.level === "human" && !trustAcknowledgment(record.trust);

function canonical(file) {
  try { return fs.realpathSync(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; return path.join(canonical(path.dirname(file)), path.basename(file)); }
}
export function trustEvidenceFile({ stateDir, operatorDir }) {
  const repo = canonical(path.resolve(operatorDir)), state = canonical(path.resolve(stateDir));
  const relative = path.relative(repo, state);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Trust evidence state directory must be outside the repository");
  const file = path.join(state, "trust-learning", digest(repo), "evidence.jsonl");
  if (canonical(file) !== file) throw new Error("Trust evidence path must not contain symlinks");
  return file;
}
function locked(file, action) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  try { fs.mkdirSync(lock); } catch (error) { if (error.code === "EEXIST") throw new Error("Trust record is busy; retry after the other operator finishes"); throw error; }
  try { return action(); } finally { fs.rmdirSync(lock); }
}
function readEvents(file) {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
export const loadTrustEvidence = options => readEvents(trustEvidenceFile(options)).filter(event => event.type !== "drop");
function appendEvidence(options, event) {
  const file = trustEvidenceFile(options);
  return locked(file, () => {
    if (readEvents(file).some(previous => previous.id === event.id)) return false;
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return true;
  });
}
export function operatorIdentity(operatorDir, readEmail = () => execFileSync("git", ["config", "--get", "user.email"], { cwd: operatorDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) {
  try { const email = readEmail(); if (email?.trim()) return email.trim(); } catch { /* No repository identity configured. */ }
  return os.userInfo().username;
}
export function acknowledgeTrust({ jobsRoot, operatorDir, stateDir = path.dirname(jobsRoot), jobId, decision, reason = "", who, when = new Date().toISOString() }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(jobId ?? "")) throw new Error("Invalid job id");
  if (!["accept", "reject"].includes(decision)) throw new Error("Choose exactly one of --accept or --reject");
  if (typeof reason !== "string") throw new Error("Reason must be text");
  const file = path.join(jobsRoot, jobId, "metadata.json");
  if (!fs.existsSync(file)) throw new Error(`No finished job ${jobId}`);
  return locked(file, () => {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!sameRepo(record, operatorDir)) throw new Error(`Job ${jobId} belongs to a different repository`);
    if (record.trust?.level !== "human") throw new Error(`Job ${jobId} is not human-level; trust ack only signs off human-level jobs`);
    const ack = { decision, who: who ?? operatorIdentity(operatorDir), when, reason };
    const history = record.trust.ack ?? [];
    if (!Array.isArray(history)) throw new Error("Invalid trust acknowledgment history");
    if (decision === "reject") {
      const reasons = record.trust.reasons ?? [];
      const files = [...new Set(record.git?.changedFiles ?? [])].filter(safeFile);
      const targets = files.map(file => {
        const cited = reasons.flatMap(r => [...String(r.reason).matchAll(/`([A-Za-z_$][\w$]*)`\s*\(([^():]+):(\d+)\)/g)]).filter(m => m[2] === file);
        return { file, symbols: [...new Set(cited.map(m => m[1]))], line: cited.length ? Number(cited[0][3]) : 1 };
      });
      appendEvidence({ stateDir, operatorDir }, { id: `reject:${jobId}:${history.length}`, type: "reject", jobId, when, ack, targets, reasons });
    }
    record.trust.ack = [...history, ack];
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), { flag: "wx" });
    try { fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); }
    return { status: "acknowledged", jobId, ack, trust: record.trust };
  });
}

// A completed review is not itself a defect. Keep only supported, relevant
// findings with explicit defect language, never positive findings or hearsay.
function defectFinding(finding) {
  return finding.supported === true && !finding.weak && !finding.unrelated
    && !/\b(?:no|without)\s+(?:known\s+)?(?:defects?|bugs?|issues?|vulnerabilit\w*)\b/i.test(finding.text)
    && /\b(?:defect|bug|broken|incorrect|fails?|missing|bypass\w*|leak\w*|vulnerab\w*|regression|allows? unauthorized|does not|doesn't|never checks)\b/i.test(finding.text);
}
export function recordReviewEvidence({ stateDir, operatorDir, review, job }) {
  if (!job || !sameRepo(job, operatorDir) || !sameRepo(review, operatorDir) || review.mode !== "scout" || review.reviews !== job.jobId
    || review.outcome !== "SCOUT_DONE" || !provider(job) || !provider(review) || provider(job) === provider(review)) return false;
  const changed = new Set(job.git?.changedFiles ?? []), targets = [], findings = [];
  for (const finding of review.scout?.findings ?? []) {
    if (!defectFinding(finding)) continue;
    const cited = [];
    for (const citation of finding.citations ?? []) {
      if (citation.status !== "ok" || citation.related === false || !safeFile(citation.path) || !changed.has(citation.path)) continue;
      const excerpt = (citation.excerpt ?? []).map(line => line.text).join("\n");
      const symbols = [...new Set([
        ...[...excerpt.matchAll(/\b(?:def|function|fn)\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]),
        ...[...String(finding.text).matchAll(/`([A-Za-z_$][\w$]*)`/g)].map(m => m[1]).filter(symbol => excerpt.includes(symbol)),
      ])];
      const target = { file: citation.path, symbols, line: citation.start ?? 1 };
      targets.push(target); cited.push(target);
    }
    if (cited.length) findings.push({ text: finding.text, targets: cited });
  }
  if (!targets.length) return false;
  return appendEvidence({ stateDir, operatorDir }, { id: `review:${review.jobId}`, type: "defect", jobId: job.jobId, reviewJobId: review.jobId,
    when: review.finishedAt ?? review.startedAt, targets, findings });
}
export function collectReviewEvidence({ records, ...options }) {
  const jobs = new Map(records.map(record => [record.jobId, record]));
  for (const review of records) if (review.reviews) recordReviewEvidence({ ...options, review, job: jobs.get(review.reviews) });
}
const targetKey = entry => `${entry.file}:${entry.symbol}`;
export function trustSuggestions(options) {
  const events = readEvents(trustEvidenceFile(options)), evidence = events.filter(event => event.type !== "drop");
  const accepted = loadTrustMap(options.operatorDir), stored = loadTrustProposal(options.operatorDir);
  const occupied = new Set([...accepted, ...stored].map(targetKey));
  const groups = new Map();
  for (const event of evidence) for (const target of event.targets) {
    for (const symbol of ["*", ...target.symbols]) {
      const entry = { file: target.file, symbol };
      const key = targetKey(entry);
      if (!groups.has(key)) groups.set(key, { ...entry, line: target.line, events: new Map() });
      groups.get(key).events.set(event.id, event);
    }
  }
  const candidates = [...groups.values()].filter(group => group.events.size >= 2);
  return candidates.filter(group => !occupied.has(targetKey(group)) && !occupied.has(`${group.file}:*`)
    && !(group.symbol === "*" && candidates.some(other => other.file === group.file && other.symbol !== "*")))
    .sort((a, b) => targetKey(a).localeCompare(targetKey(b))).flatMap(group => {
      const ids = [...group.events.keys()].sort(), fingerprint = digest(JSON.stringify(ids)), key = targetKey(group);
      if (events.some(event => event.type === "drop" && event.key === key && event.fingerprint === fingerprint)) return [];
      const jobIds = [...new Set([...group.events.values()].map(event => event.jobId))].sort();
      const label = group.symbol === "*" ? group.file : `${group.file}: ${group.symbol}`;
      const summary = `${ids.length} of ${evidence.length} recorded defects or rejections touched \`${label}\``;
      return [{ entry: { symbol: group.symbol, file: group.file, category: "access", reason: summary, line: group.line },
        evidence: { summary, jobIds, eventIds: ids }, key, fingerprint }];
    });
}
export function reviewTrustLearning({ stateDir, operatorDir, decisions, acceptAll = false, expected = null }) {
  const suggestions = trustSuggestions({ stateDir, operatorDir });
  const stored = loadTrustProposal(operatorDir);
  if (expected !== null && JSON.stringify(expected) !== JSON.stringify([...stored, ...suggestions.map(s => s.entry)])) {
    throw new Error("Trust proposals changed while being reviewed; list them again before deciding");
  }
  const result = reviewTrustProposal({ operatorDir, decisions, acceptAll, suggestions: suggestions.map(s => s.entry) });
  for (const [index, suggestion] of suggestions.entries()) if (decisions?.[stored.length + index]?.action === "drop") {
    appendEvidence({ stateDir, operatorDir }, { id: `drop:${suggestion.key}:${suggestion.fingerprint}`, type: "drop", key: suggestion.key, fingerprint: suggestion.fingerprint });
  }
  return result;
}
