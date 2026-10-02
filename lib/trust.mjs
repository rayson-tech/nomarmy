// The repository's deterministic trust floor. No model can lower this result.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { globToRegex } from "./repo-query.mjs";
import { parseYaml, CONFIG_FILENAMES } from "./config.mjs";

export const CODEOWNERS_FILES = Object.freeze([".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]);
const normalize = (file) => path.posix.normalize(file.replace(/\\/g, "/")).replace(/^(?:\.\/|\/)+/, "");
const sentence = (text) => text.replace(/\s+/g, " ").trim();

export const MAX_TRUST_FILE_BYTES = 16 * 1024 * 1024;
export const UNCHECKABLE_TRUST_FILE = "is not a regular file or symlink";

/** Read Git's representation without following worktree symlinks or opening special files. */
export function readTrustWorktreeFile(cwd, file) {
  const empty = Buffer.alloc(0);
  const blocked = (problem) => ({ bytes: empty, problem });
  const parts = file.split(path.sep === "\\" ? /[\\/]/ : "/");
  if (path.isAbsolute(file) || parts.some((part) => !part || part === "." || part === "..")) {
    return blocked("is not a path inside the worktree");
  }
  let full = cwd;
  try {
    for (const part of parts.slice(0, -1)) {
      full = path.join(full, part);
      const parent = fs.lstatSync(full);
      if (parent.isSymbolicLink()) return blocked("has a symlinked parent directory");
      if (!parent.isDirectory()) return blocked(UNCHECKABLE_TRUST_FILE);
    }
    full = path.join(full, parts.at(-1));
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return { bytes: fs.readlinkSync(full, { encoding: "buffer" }), problem: null };
    if (!stat.isFile()) return blocked(UNCHECKABLE_TRUST_FILE);
    const oversized = `exceeds the ${MAX_TRUST_FILE_BYTES}-byte content limit`;
    if (stat.size > MAX_TRUST_FILE_BYTES) return blocked(oversized);
    // Recheck the opened descriptor and bound the actual read as well as stat's
    // size, in case the file changes. NOFOLLOW/NONBLOCK guard leaf replacements.
    const fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) return blocked(UNCHECKABLE_TRUST_FILE);
      if (opened.size > MAX_TRUST_FILE_BYTES) return blocked(oversized);
      const chunks = [];
      let total = 0;
      while (total <= MAX_TRUST_FILE_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_TRUST_FILE_BYTES + 1 - total));
        const count = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (!count) return { bytes: Buffer.concat(chunks, total), problem: null, regular: true };
        total += count;
        if (total > MAX_TRUST_FILE_BYTES) return blocked(oversized);
        chunks.push(chunk.subarray(0, count));
      }
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code === "ENOENT") return { bytes: empty, problem: null };
    return blocked(`could not be read (${error.code ?? "I/O error"})`);
  }
}

/** GitHub uses the last matching line, including ownerless overrides. */
export function parseCodeowners(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...rest] = line.split(/\s+/);
    // Unlike gitignore, GitHub does not support negation, character ranges,
    // or escaping a leading #. Braces are literal, not glob alternation.
    if (pattern.startsWith("!") || pattern.startsWith("\\#") || /[\[\]]/.test(pattern)) continue;
    const comment = rest.findIndex((part) => part.startsWith("#"));
    const owners = comment < 0 ? rest : rest.slice(0, comment);
    const normalized = normalize(pattern).toLowerCase();
    const body = normalized.replace(/\/$/, "");
    if (!body) continue;
    const anchored = pattern.startsWith("/") || body.includes("/");
    // CODEOWNERS treats a matching directory as covering its descendants;
    // a trailing slash specifically requires a directory, not a same-name file.
    const directory = normalized.endsWith("/");
    const matcher = globToRegex(directory ? `${body}/**` : body,
      { anchored, descendants: !directory, literalBraces: true });
    rules.push({ pattern, owners, matcher });
  }
  return rules;
}

/** First existing CODEOWNERS wins, even if it is empty. Read errors propagate. */
export function codeownersPaths(repoDir) {
  for (const file of CODEOWNERS_FILES) {
    try { return parseCodeowners(fs.readFileSync(path.join(repoDir, file), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return [];
}

/** Decode raw blobs without allowing binary classification or attributes to hide text. */
export function decodeTrustBytes(bytes) {
  if (typeof bytes === "string") return bytes;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return Buffer.from(bytes).toString("latin1"); }
}

function linesOf(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// Multiset subtraction preserves duplicate additions/removals and source lines.
function changedLines(source, other) {
  const counts = new Map();
  for (const line of other) counts.set(line, (counts.get(line) ?? 0) + 1);
  return source.flatMap((content, index) => {
    const count = counts.get(content) ?? 0;
    if (count) { counts.set(content, count - 1); return []; }
    return [{ content, line: index + 1 }];
  });
}

function trustDiffers(before, after) {
  try { return !isDeepStrictEqual(parseYaml(before)?.trust, parseYaml(after)?.trust); }
  catch { return true; } // An unreadable edited contract cannot relax the floor.
}

// Strip format controls before whitespace normalization. Also scan a boundary
// view: an invisible separator between words (DROP\u200bTABLE) must not hide SQL.
const contentSentence = (text) => sentence(text.replace(/\p{Cf}/gu, ""));
const boundaryView = (text) => text.replace(/\p{Cf}/gu, " ");
function occurrences(text, literal) {
  const offsets = [];
  if (!literal) return offsets;
  for (let offset = text.indexOf(literal); offset >= 0; offset = text.indexOf(literal, offset + 1)) offsets.push(offset);
  return offsets;
}
function contentLines(text, normalizeContent) {
  return linesOf(text).map((content, index) => ({ content: normalizeContent(content), line: index + 1 })).filter(({ content }) => content);
}
function sourceLine(pieces, offset) {
  let start = 0, index = 0;
  while (index < pieces.length - 1 && start + pieces[index].content.length <= offset) start += pieces[index++].content.length + 1;
  return pieces[index]?.line ?? 1;
}

/** Snapshots include both raw worktree bytes and Git's converted blob bytes. */
export function evaluateTrust({ rules = [], changedFiles = [], fileChanges = [], codeowners = [] }) {
  const reasons = [];
  const snapshots = fileChanges.map(({ file, before, after, problem }) => ({
    file: normalize(file), before: decodeTrustBytes(before), after: decodeTrustBytes(after), problem,
  }));
  const files = [...new Set([...changedFiles.map(normalize), ...snapshots.map((change) => change.file)])];
  for (const file of files) {
    const folded = file.toLowerCase();
    for (const snapshot of snapshots.filter((change) => change.file === file && change.problem)) {
      reasons.push({ rule: "trust", reason: `changes ${file}, which ${snapshot.problem}, so its content can't be checked`, file });
    }
    if (folded === ".nomarmy/trust-map.yml" || CODEOWNERS_FILES.some((name) => name.toLowerCase() === folded)) reasons.push({ rule: "trust", reason: "changes the repository's trust rules", file });
    if (CONFIG_FILENAMES.some((name) => name.toLowerCase() === folded)) {
      const snapshot = snapshots.find((change) => change.file === file);
      // Missing or unreadable snapshots must never relax the floor.
      if (!snapshot || snapshots.some((change) => change.file === file && trustDiffers(change.before, change.after))) {
        reasons.push({ rule: "trust", reason: "changes the repository's trust rules", file });
      }
    }
    for (const [index, rule] of rules.entries()) {
      if (rule.paths?.some((glob) => globToRegex(normalize(glob).toLowerCase(), { anchored: true, literalBraces: true }).test(folded))) {
        reasons.push({ rule: index, reason: `changes ${file}, which the repo marks sensitive: ${sentence(rule.reason)}`, file });
      }
    }
    const owner = codeowners.findLast((rule) => rule.matcher.test(folded));
    if (owner?.owners.length) reasons.push({ rule: "codeowners", reason: `changes ${file}, owned in CODEOWNERS by ${owner.owners.join(" ")}`, file });
  }
  // Keep the original view too: normalization must never lower the floor.
  const contentSnapshots = snapshots.flatMap((snapshot) => [
    { ...snapshot, normalizeContent: sentence },
    { ...snapshot, normalizeContent: contentSentence },
    { ...snapshot, before: boundaryView(snapshot.before), after: boundaryView(snapshot.after), normalizeContent: contentSentence },
  ]);
  for (const snapshot of contentSnapshots) {
    const normalizeContent = snapshot.normalizeContent;
    const reported = new Set();
    const report = (index, rule, verb, line) => {
      reported.add(`${index}:${verb}`);
      reasons.push({ rule: index, reason: `${verb} sensitive content at ${snapshot.file}:${line}, which the repo marks sensitive: ${sentence(rule.reason)}`, file: snapshot.file, line });
    };
    const literals = (rule) => (rule.content ?? []).map(normalizeContent);
    const before = linesOf(snapshot.before), after = linesOf(snapshot.after);
    for (const [verb, lines] of [["removes", changedLines(before, after)], ["adds", changedLines(after, before)]]) {
      // Collapse whitespace across changed lines as well as within each line.
      const nonempty = lines.filter(({ content }) => normalizeContent(content));
      if (!nonempty.length) continue;
      const pieces = nonempty.map(({ content }) => normalizeContent(content));
      const text = pieces.join(" ");
      for (const [index, rule] of rules.entries()) {
        const matches = literals(rule).map((literal) => text.indexOf(literal)).filter((offset) => offset >= 0);
        if (!matches.length || !lines.length) continue;
        const offset = Math.min(...matches);
        let start = 0, lineIndex = 0;
        while (lineIndex < pieces.length - 1 && start + pieces[lineIndex].length < offset) start += pieces[lineIndex++].length + 1;
        const line = nonempty[lineIndex].line;
        report(index, rule, verb, line);
      }
    }
    const oldPieces = contentLines(snapshot.before, normalizeContent), newPieces = contentLines(snapshot.after, normalizeContent);
    const oldText = normalizeContent(snapshot.before), newText = normalizeContent(snapshot.after);
    for (const [index, rule] of rules.entries()) {
      for (const literal of literals(rule)) {
        const oldMatches = occurrences(oldText, literal), newMatches = occurrences(newText, literal);
        if (oldMatches.length === newMatches.length) continue;
        const verb = newMatches.length > oldMatches.length ? "adds" : "removes";
        if (reported.has(`${index}:${verb}`)) continue;
        const pieces = verb === "adds" ? newPieces : oldPieces;
        const matches = verb === "adds" ? newMatches : oldMatches;
        // Prefer an occurrence spanning an edited line, even when its start
        // (such as DROP) is unchanged. Existing earlier matches are context.
        const edited = changedLines(verb === "adds" ? after : before, verb === "adds" ? before : after);
        const offset = matches.find((match) => {
          const start = sourceLine(pieces, match), end = sourceLine(pieces, match + literal.length - 1);
          return edited.some(({ line }) => line >= start && line <= end);
        }) ?? matches[0];
        report(index, rule, verb, sourceLine(pieces, offset));
      }
    }
  }
  const unique = [...new Map(reasons.map((reason) => [JSON.stringify(reason), reason])).values()];
  return { level: unique.length ? "human" : "normal", reasons: unique };
}
