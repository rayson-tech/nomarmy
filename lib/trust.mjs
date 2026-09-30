// The repository's deterministic trust floor. No model can lower this result.
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { globToRegex } from "./repo-query.mjs";
import { parseYaml, CONFIG_FILENAMES } from "./config.mjs";

export const CODEOWNERS_FILES = Object.freeze([".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]);
const normalize = (file) => file.replace(/\\/g, "/").replace(/^\.\//, "");
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
    const body = pattern.replace(/^\//, "").replace(/\/$/, "");
    if (!body) continue;
    const anchored = pattern.startsWith("/") || body.includes("/");
    // CODEOWNERS treats a matching directory as covering its descendants;
    // a trailing slash specifically requires a directory, not a same-name file.
    const directory = pattern.endsWith("/");
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

function diffPath(value) {
  let file = value.split("\t")[0];
  if (file.startsWith('"')) { try { file = JSON.parse(file); } catch { /* keep the literal path */ } }
  return file === "/dev/null" ? null : normalize(file.replace(/^[ab]\//, ""));
}

// Parse hunks, not arbitrary +/- text. Old and new line numbers stay separate
// so removed checks point to their location in the base, not in the new file.
function diffChanges(text) {
  const files = [];
  let current = null, inHunk = false, oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) { current = null; inHunk = false; }
    else if (!inHunk && line.startsWith("--- ")) {
      current = { file: diffPath(line.slice(4)), before: [], after: [], changes: [] };
      files.push(current);
    } else if (!inHunk && current && line.startsWith("+++ ")) {
      current.file = diffPath(line.slice(4)) ?? current.file;
    } else if (line.startsWith("@@ ")) {
      const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunk) {
        oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
        oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
        inHunk = true;
      }
    } else if (current && inHunk) {
      const sign = line[0], content = line.slice(1);
      if (sign === " " || sign === "-") current.before.push(content);
      if (sign === " " || sign === "+") current.after.push(content);
      if (sign === "+" || sign === "-") current.changes.push({ content, line: sign === "+" ? newLine : oldLine, sign });
      if (sign === " " || sign === "-") { oldLine++; oldRemaining--; }
      if (sign === " " || sign === "+") { newLine++; newRemaining--; }
      if (oldRemaining === 0 && newRemaining === 0) inHunk = false;
    }
  }
  return files;
}

function trustDiffers(before, after) {
  try { return !isDeepStrictEqual(parseYaml(before)?.trust, parseYaml(after)?.trust); }
  catch { return true; } // An unreadable edited contract cannot relax the floor.
}

/**
 * rules is trust.sensitive; codeowners is parseCodeowners's result.
 * configChanges optionally supplies complete { file, before, after } snapshots.
 * Executors must supply these for partial diffs; standalone full-context diffs
 * can reconstruct the same comparison without filesystem access.
 */
export function evaluateTrust({ rules = [], changedFiles = [], diffText = "", codeowners = [], configChanges = null }) {
  const reasons = [];
  const changes = diffChanges(diffText);
  const files = [...new Set([...changedFiles.map(normalize), ...changes.map((change) => change.file).filter(Boolean)])];
  for (const file of files) {
    if (CODEOWNERS_FILES.includes(file)) reasons.push({ rule: "trust", reason: "changes the repository's trust rules", file });
    if (CONFIG_FILENAMES.includes(file)) {
      const snapshot = configChanges?.find((change) => change.file === file);
      const diff = changes.find((change) => change.file === file);
      if (snapshot ? trustDiffers(snapshot.before, snapshot.after)
        : diff && trustDiffers(diff.before.join("\n"), diff.after.join("\n"))) {
        reasons.push({ rule: "trust", reason: "changes the repository's trust rules", file });
      }
    }
    for (const [index, rule] of rules.entries()) {
      if (rule.paths?.some((glob) => globToRegex(normalize(glob), { anchored: true }).test(file))) {
        reasons.push({ rule: index, reason: `changes ${file}, which the repo marks sensitive: ${sentence(rule.reason)}`, file });
      }
    }
    const owner = codeowners.findLast((rule) => rule.matcher.test(file));
    if (owner?.owners.length) reasons.push({ rule: "codeowners", reason: `changes ${file}, owned in CODEOWNERS by ${owner.owners.join(" ")}`, file });
  }
  for (const diff of changes) {
    for (const change of diff.changes) {
      for (const [index, rule] of rules.entries()) {
        if (rule.content?.some((literal) => change.content.includes(literal))) {
          reasons.push({ rule: index, reason: `${change.sign === "+" ? "adds" : "removes"} sensitive content at ${diff.file}:${change.line}, which the repo marks sensitive: ${sentence(rule.reason)}`, file: diff.file, line: change.line });
        }
      }
    }
  }
  return { level: reasons.length ? "human" : "normal", reasons };
}
