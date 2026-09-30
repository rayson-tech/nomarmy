// The repository's deterministic trust floor. No model can lower this result.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { globToRegex } from "./repo-query.mjs";
import { parseYaml, CONFIG_FILENAMES } from "./config.mjs";

export const CODEOWNERS_FILES = Object.freeze([".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]);
const normalize = (file) => path.posix.normalize(file.replace(/\\/g, "/")).replace(/^(?:\.\/|\/)+/, "");
const sentence = (text) => text.replace(/\s+/g, " ").trim();

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

/** Snapshots contain unfiltered base bytes and on-disk worktree bytes. */
export function evaluateTrust({ rules = [], changedFiles = [], fileChanges = [], codeowners = [] }) {
  const reasons = [];
  const snapshots = fileChanges.map(({ file, before, after }) => ({
    file: normalize(file), before: decodeTrustBytes(before), after: decodeTrustBytes(after),
  }));
  const files = [...new Set([...changedFiles.map(normalize), ...snapshots.map((change) => change.file)])];
  for (const file of files) {
    const folded = file.toLowerCase();
    if (CODEOWNERS_FILES.some((name) => name.toLowerCase() === folded)) reasons.push({ rule: "trust", reason: "changes the repository's trust rules", file });
    if (CONFIG_FILENAMES.some((name) => name.toLowerCase() === folded)) {
      const snapshot = snapshots.find((change) => change.file === file);
      // Missing or unreadable snapshots must never relax the floor.
      if (!snapshot || trustDiffers(snapshot.before, snapshot.after)) {
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
  for (const snapshot of snapshots) {
    const before = linesOf(snapshot.before), after = linesOf(snapshot.after);
    for (const [verb, lines] of [["removes", changedLines(before, after)], ["adds", changedLines(after, before)]]) {
      // Collapse whitespace across changed lines as well as within each line.
      const nonempty = lines.filter(({ content }) => sentence(content));
      if (!nonempty.length) continue;
      const pieces = nonempty.map(({ content }) => sentence(content));
      const text = pieces.join(" ");
      for (const [index, rule] of rules.entries()) {
        const matches = (rule.content ?? []).map((literal) => text.indexOf(sentence(literal))).filter((offset) => offset >= 0);
        if (!matches.length || !lines.length) continue;
        const offset = Math.min(...matches);
        let start = 0, lineIndex = 0;
        while (lineIndex < pieces.length - 1 && start + pieces[lineIndex].length < offset) start += pieces[lineIndex++].length + 1;
        const line = nonempty[lineIndex].line;
        reasons.push({ rule: index, reason: `${verb} sensitive content at ${snapshot.file}:${line}, which the repo marks sensitive: ${sentence(rule.reason)}`, file: snapshot.file, line });
      }
    }
  }
  return { level: reasons.length ? "human" : "normal", reasons };
}
