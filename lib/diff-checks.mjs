// ---------------------------------------------------------------------------
// Test-change classification (plan 16). One tunable constant, on purpose:
// every heuristic about what counts as a test file lives here and nowhere else.
// ---------------------------------------------------------------------------
export const TEST_PATH_PATTERNS = Object.freeze([
  { name: "test-directory", re: /(^|\/)(tests?|__tests__|specs?|testing)\//i },
  { name: "dot-test-suffix", re: /(^|\/)[^/]+\.(test|spec)\.[A-Za-z0-9]+$/i },
  { name: "go-test", re: /(^|\/)[^/]+_test\.go$/ },
  { name: "python-test", re: /(^|\/)(test_[^/]+|[^/]+_test)\.py$/ },
  { name: "python-conftest", re: /(^|\/)conftest\.py$/ },
  { name: "ruby-elixir-test", re: /(^|\/)[^/]+_(test|spec)\.(rb|exs?)$/ },
  { name: "jvm-dotnet-test", re: /(^|\/)[^/]+(Test|Tests|Spec|Specs|TestCase)\.(java|kt|kts|cs|scala|groovy)$/ }
]);
// Documentation: prose, not code. A change to it can't be proven by a
// failing test, so the revert check (which reverts a job's code and expects
// its tests to fail) skips these. Without that, a docs-only job always read
// as "no test catches this" and, under policy.require_verification, could
// never commit (found by a real job adding a code map to CONTRIBUTING.md).
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".rst", ".adoc", ".txt"]);
const DOC_BASENAMES = new Set(["LICENSE", "NOTICE", "AUTHORS", "CODEOWNERS", "CHANGELOG", "COPYING"]);
export function isDocumentationPath(file) {
  const base = String(file).split("/").pop();
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
  // Python dependency lists end in .txt too, and they're code.
  if (/^(requirements|constraints)[\w.-]*\.txt$/i.test(base)) return false;
  return DOC_EXTENSIONS.has(ext) || DOC_BASENAMES.has(dot > 0 ? base.slice(0, dot) : base);
}

export function isTestPath(file) {
  const normalized = String(file ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return false;
  return TEST_PATH_PATTERNS.some(p => p.re.test(normalized));
}
export function testPatternFor(file) {
  const normalized = String(file ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  return TEST_PATH_PATTERNS.find(p => p.re.test(normalized))?.name ?? null;
}
// Classification rules, deliberately conservative:
//  - a renamed/copied file whose SOURCE was a test counts as an existing test
//    modification (the coverage surface moved), not as a brand new test;
//  - anything that is not a test path is production, whatever its status.
// Nothing here rejects a test change. It only makes one impossible to miss.
export function classifyTestChanges(entries) {
  const buckets = { production_files_changed: [], new_tests_added: [], existing_tests_modified: [], existing_tests_deleted: [] };
  for (const entry of entries ?? []) {
    const code = String(entry?.status ?? "").toUpperCase();
    const letter = code[0] ?? "";
    const file = entry?.path;
    if (!file) continue;
    const destIsTest = isTestPath(file);
    const srcIsTest = entry.oldPath ? isTestPath(entry.oldPath) : destIsTest;
    if (letter === "R" || letter === "C") {
      if (srcIsTest) buckets.existing_tests_modified.push(file);
      else if (destIsTest) buckets.new_tests_added.push(file);
      else buckets.production_files_changed.push(file);
      continue;
    }
    if (!destIsTest) { buckets.production_files_changed.push(file); continue; }
    if (letter === "A") buckets.new_tests_added.push(file);
    else if (letter === "D") buckets.existing_tests_deleted.push(file);
    else buckets.existing_tests_modified.push(file);
  }
  for (const key of Object.keys(buckets)) buckets[key] = [...new Set(buckets[key])].sort();
  const reviewFlags = [];
  if (buckets.existing_tests_modified.length) reviewFlags.push(`existing tests modified: ${buckets.existing_tests_modified.join(", ")}`);
  if (buckets.existing_tests_deleted.length) reviewFlags.push(`existing tests deleted: ${buckets.existing_tests_deleted.join(", ")}`);
  return { ...buckets, reviewRequired: reviewFlags.length > 0, reviewFlags, heuristic: TEST_PATH_PATTERNS.map(p => p.name) };
}

// ---------------------------------------------------------------------------
// Scoped test-selection risk: a real incident this closes. `classifyResults`
// (lib/verify.mjs) only ever checks exit codes -- a verification command
// whose test-selection flag (-k, -m, --testNamePattern, --grep, -run...)
// happens to exclude the exact test(s) covering THIS diff still reports an
// honest, green pass, because plenty of OTHER tests genuinely ran and
// passed. That is not a bug in classifyResults; exit-code checking cannot
// see the difference on its own. verify_regression (now on by default
// whenever a verification profile is set) catches this too, eventually --
// this check is the cheap, fast, always-on companion: no sandbox run, no
// wall-clock cost, just cross-referencing the CONFIGURED command strings
// against the diff's own test-file changes. Deliberately narrow, not a
// general "your -k looks suspicious" linter: a selection flag alone is
// completely normal (most `.nomarmy.yml` profiles that use one use it on
// purpose, every run) -- it is only worth a human's attention when paired
// with a test file THIS diff itself touched, the one case that flag could
// plausibly be excluding by accident.
const TEST_SELECTION_FLAG_PATTERNS = Object.freeze([
  { name: "pytest -k", re: /(^|\s)-k(\s|=)/ },
  // A real, confirmed false positive on day one: `python3 -m pytest` (the
  // standard, extremely common way to invoke pytest as a module) matches
  // "-m" preceded and followed by whitespace exactly like a genuine marker
  // filter does -- this fired on the SAME command written specifically to
  // fix the risk it was warning about. `-m pytest` (module invocation) is a
  // fixed, unambiguous idiom to exclude; a real marker filter is never
  // literally the bare word "pytest" right after -m.
  { name: "pytest -m", re: /(^|\s)-m(?:\s+|=)(?!pytest\b)/ },
  // --testNamePattern only, not the bare "-t" jest/vitest alias: "-t" is a
  // single generic letter shared by docker (-t <image>), ssh (-t), tar (-t),
  // curl (-t) and more, with no single idiom to exclude the way `-m pytest`
  // has -- keeping it would trade one confirmed false positive for another,
  // less obvious one. Narrower recall (misses the short form) beats a
  // chronically noisy flag.
  { name: "jest/vitest --testNamePattern", re: /(^|\s)--testNamePattern(\s|=)/ },
  { name: "go test -run", re: /(^|\s)-run(\s|=)/ },
  { name: "--grep", re: /(^|\s)--grep(\s|=)/ },
  { name: "--filter", re: /(^|\s)--filter(\s|=)/ },
]);
export function detectScopedTestSelectionRisk({ commands = [], testChanges = null } = {}) {
  const touchedTestFiles = [...(testChanges?.new_tests_added ?? []), ...(testChanges?.existing_tests_modified ?? [])];
  if (touchedTestFiles.length === 0) return null;
  const flagged = [];
  for (const command of commands) {
    const match = TEST_SELECTION_FLAG_PATTERNS.find((p) => p.re.test(String(command ?? "")));
    if (match) flagged.push({ command, flag: match.name });
  }
  if (flagged.length === 0) return null;
  const flagNames = [...new Set(flagged.map((f) => f.flag))].join(", ");
  return {
    flagged,
    reason: `verification command(s) use a test-selection flag (${flagNames}) and this diff also touches test file(s) ${touchedTestFiles.join(", ")} -- a scoped filter like this can silently exclude exactly those tests while unrelated tests still run and pass. Confirm they're actually included in the selection before trusting this as coverage.`,
  };
}

// ---------------------------------------------------------------------------
// Unwired new definitions: a real, recurring incident today -- three separate
// times, a worker introduced a new function or class in this diff that no
// real (non-test) code anywhere in the repository actually calls. "Built but
// wired to nothing" was caught three times by luck (a human reading the
// diff); this makes it a standing, automatic check instead.
// ---------------------------------------------------------------------------

// `git diff -U0 <baseSha> -- <file>` emits zero context lines, so every line
// inside a hunk body is either added or removed -- no ` ` context lines to
// tell apart. A hunk header `@@ -oldStart,oldCount +newStart,newCount @@`
// gives the starting line number IN THE NEW FILE; only `+` lines advance
// that counter (a `-` line refers to the OLD file's numbering, which this
// does not track, since only "what's new" matters here).
export function parseAddedLineNumbers(diffText) {
  const added = new Set();
  let newLineNum = null;
  for (const line of String(diffText ?? "").split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { newLineNum = Number(hunk[1]); continue; }
    if (newLineNum === null) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) { added.add(newLineNum); newLineNum++; }
    // a "-" line (old-file only) or a "\ No newline..." marker never
    // advances the new-file counter.
  }
  return added;
}

/**
 * Which of a file's definitions (via lib/repo-query.mjs's outlineFile, the
 * same heuristic-per-language-family patterns definitions/references/outline
 * already share) are themselves NEW in this diff -- their own definition
 * line is an added line, not a pre-existing one this diff merely sits near.
 * A file with many already-used helpers that happens to be touched must
 * never flag all of them; only a genuinely new declaration counts.
 */
function newDefinitionsInFile({ outlineFn, cwd, file, addedLines }) {
  if (addedLines.size === 0) return [];
  const outline = outlineFn(cwd, file);
  if (!outline.exists) return [];
  return outline.items.filter((item) => (item.kind === "function" || item.kind === "class") && addedLines.has(item.line));
}

/**
 * For each production file this diff touched, find definitions newly added
 * BY this diff, then check whether any real (non-test) file anywhere in the
 * repository actually references that name. Heuristic like everything else
 * repo-query.mjs does (a whole-word grep, per-language regex definitions) --
 * a dynamic-dispatch or decorator-registered caller a static grep cannot see
 * will false-positive here, so this is always a review flag, never a block.
 *
 * @param {{ cwd: string, productionFiles: string[], gitDiffFn: (file: string) => Promise<string>, outlineFn: Function, referencesFn: Function, isTestPathFn: (path: string) => boolean }} input
 */
export async function detectUnwiredNewDefinitions({ cwd, productionFiles = [], gitDiffFn, outlineFn, referencesFn, isTestPathFn }) {
  const flagged = [];
  for (const file of productionFiles) {
    let diffText;
    try { diffText = await gitDiffFn(file); } catch { continue; }
    const addedLines = parseAddedLineNumbers(diffText);
    const newDefs = newDefinitionsInFile({ outlineFn, cwd, file, addedLines });
    for (const def of newDefs) {
      let refs;
      try { refs = referencesFn(cwd, def.name); } catch { continue; }
      const realCallers = (refs?.hits ?? []).filter((h) => !isTestPathFn(h.path));
      if (realCallers.length === 0) {
        flagged.push({ file, line: def.line, name: def.name, kind: def.kind, testOnlyReferences: (refs?.hits ?? []).length > 0 });
      }
    }
  }
  if (flagged.length === 0) return null;
  return {
    flagged,
    reason: `new ${flagged.length === 1 ? "definition" : "definitions"} added by this diff with no reference outside a test file: ${flagged.map((f) => `${f.name} (${f.file}:${f.line})`).join(", ")} -- built, but nothing outside its own test calls it yet. A dynamic-dispatch or decorator-registered caller can look like this too (a grep-based heuristic, stated as such); confirm before trusting this as wired in.`,
  };
}

// ---------------------------------------------------------------------------
// Mislabeled test names: a real, recurring pattern -- four separate times, a
// worker's new test carried a name naming a specific route/handler it never
// actually exercised (the sharpest instance: test_edit_draft_not_found
// posted an unrelated action and never touched the edit_request_draft route
// its own name claims). A green suite that includes a test like this means
// less than it looks; this was caught each time only by a human rereading
// the diff, the same luck-dependent gap detectUnwiredNewDefinitions closed
// for "built but wired to nothing".
//
// The check: does this diff's new test's NAME claim a SPECIFIC identifier
// this same diff just added to production code (real word overlap, not a
// vague guess), and if so, does the test's own BODY ever reference that
// identifier (a plain whole-word text search, matching the identifier's
// literal name as a function call OR as a string/action value -- either
// shows the test actually reached it)? A name too generic to name anything
// specific is never flagged; there is no claim to check. Like
// detectUnwiredNewDefinitions, this is a heuristic (word overlap over a
// per-language regex outline) and always a review flag, never a block.
// ---------------------------------------------------------------------------
const TEST_NAME_STOPWORDS = new Set([
  "test", "tests", "testing", "should", "when", "then", "given", "and", "or", "the", "a", "an", "for", "to",
  "from", "on", "off", "with", "without", "not", "no", "none", "null", "nil", "empty", "missing", "invalid",
  "valid", "success", "successful", "fail", "fails", "failed", "failure", "error", "errors", "exception",
  "raises", "raise", "returns", "return", "response", "request", "case", "cases", "handles", "handling",
  "before", "after", "new", "old", "ok", "found", "unfound", "it", "is", "does", "doesnt", "dont", "cant",
  "cannot", "will", "would", "that", "this", "of", "in", "at", "by", "as", "if", "true", "false", "default",
  "expected", "actual", "result", "end", "start", "one", "two", "three",
]);
function tokenizeIdentifier(name) {
  return String(name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}
function meaningfulTokens(name) {
  return tokenizeIdentifier(name).filter((t) => t.length >= 3 && !TEST_NAME_STOPWORDS.has(t));
}
const TEST_NAME_PATTERN = /^test[_A-Za-z]/i;
const MIN_CLAIM_OVERLAP = 2; // fewer shared, meaningful words is not a specific-enough claim to check
const escRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param {{ cwd: string, productionFiles: string[], testFiles: string[], gitDiffFn: (file: string) => Promise<string>, outlineFn: Function, readFileFn: (cwd: string, file: string) => string }} input
 */
export async function detectMislabeledTestNames({ cwd, productionFiles = [], testFiles = [], gitDiffFn, outlineFn, readFileFn }) {
  // Candidates: identifiers THIS diff itself just added to production code --
  // the same universe detectUnwiredNewDefinitions computes, scoped to what a
  // test in this same diff could plausibly be claiming to be about.
  const candidates = [];
  for (const file of productionFiles) {
    let diffText;
    try { diffText = await gitDiffFn(file); } catch { continue; }
    const addedLines = parseAddedLineNumbers(diffText);
    for (const def of newDefinitionsInFile({ outlineFn, cwd, file, addedLines })) {
      const tokens = meaningfulTokens(def.name);
      if (tokens.length > 0) candidates.push({ file, name: def.name, tokens: new Set(tokens) });
    }
  }
  if (candidates.length === 0) return null;

  const flagged = [];
  for (const file of testFiles) {
    let diffText;
    try { diffText = await gitDiffFn(file); } catch { continue; }
    const addedLines = parseAddedLineNumbers(diffText);
    const outline = outlineFn(cwd, file);
    if (!outline.exists) continue;
    const newTests = newDefinitionsInFile({ outlineFn, cwd, file, addedLines })
      .filter((def) => def.kind === "function" && TEST_NAME_PATTERN.test(def.name));
    if (newTests.length === 0) continue;
    let text;
    try { text = readFileFn(cwd, file); } catch { continue; }
    const lines = String(text ?? "").split(/\r?\n/);
    for (const t of newTests) {
      const testTokens = new Set(meaningfulTokens(t.name));
      if (testTokens.size < MIN_CLAIM_OVERLAP) continue; // too generic a name to name anything specific
      let best = null, bestOverlap = 0;
      for (const c of candidates) {
        const overlap = [...c.tokens].filter((tok) => testTokens.has(tok)).length;
        if (overlap > bestOverlap) { bestOverlap = overlap; best = c; }
      }
      if (!best || bestOverlap < MIN_CLAIM_OVERLAP) continue; // no specific-enough claim to check
      // Body span: from this test's own definition line to the line before
      // the next top-level definition (or end of file) -- outlineFile gives
      // no end line, so the next item's start is the only boundary available.
      const after = outline.items
        .filter((it) => it.line > t.line && (it.kind === "function" || it.kind === "class"))
        .sort((a, b) => a.line - b.line)[0];
      const bodyEnd = after ? after.line - 1 : lines.length;
      const body = lines.slice(t.line - 1, bodyEnd).join("\n");
      const referenced = new RegExp(`\\b${escRegex(best.name)}\\b`).test(body);
      if (!referenced) flagged.push({ file, line: t.line, name: t.name, claims: best.name, claimedIn: best.file });
    }
  }
  if (flagged.length === 0) return null;
  return {
    flagged,
    reason: `test name${flagged.length === 1 ? "" : "s"} appear to claim a specific route/handler this diff just added, but the test body never references it: ${flagged.map((f) => `${f.name} (${f.file}:${f.line}) names ${f.claims} (${f.claimedIn}) but never calls it`).join(", ")} -- a name-vs-body heuristic (word overlap, whole-word text search over the test's own body), stated as such; confirm the test actually exercises what its name claims before trusting it as coverage for that path.`,
  };
}

// ---------------------------------------------------------------------------
// Secret scanning: SECURITY.md's own documented, unmitigated gap -- the diff
// and report are the one channel that always leaves the sandbox (network is
// none, but the coordinator still reads and commits what a worker wrote).
//
// Backed by secretlint's recommended rule preset (a real, maintained scanner
// -- AWS/GCP/Azure, GitHub/GitLab, Slack, Stripe, OpenAI/Anthropic, npm,
// private key blocks and more), not a hand-rolled pattern list: verified
// live against this codebase's own real dependency that a hand-rolled list
// would only ever be a worse, staler subset of. It does NOT solve the
// harder, genuinely open half of SECURITY.md's gap: adversarially steered
// content with no recognizable secret shape. Say so, don't overclaim.
//
// Unlike testSelectionRisk/unwiredNewDefinitions, this is a HARD BLOCK, not
// a review nudge -- the asymmetry runs the other way: a missed weak test
// costs a review cycle, a leaked credential that reaches a real commit is
// often irreversible the moment it's pushed.
const SECRETLINT_CONFIG = Object.freeze({ rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }] });
let cachedSecretlintEngine;
async function secretlintEngine() {
  if (cachedSecretlintEngine === undefined) {
    try {
      const { createEngine } = await import("@secretlint/node");
      cachedSecretlintEngine = await createEngine({ color: false, formatter: "json", configFileJSON: SECRETLINT_CONFIG });
    } catch { cachedSecretlintEngine = null; } // secretlint unavailable -- callers treat absence of a signal honestly, never as proof of safety
  }
  return cachedSecretlintEngine;
}

/**
 * Which secretlint rule(s) fired on `text`, by ruleId/messageId ONLY.
 *
 * NEVER reads `message` or `data.*` from secretlint's own result: verified
 * live that engine.executeOnContent's raw messages embed the ACTUAL matched
 * credential value in both fields, unmasked -- the CLI's masking is a
 * formatter-layer feature (`--no-maskSecrets`), never applied by the engine
 * itself. Surfacing either field here would leak the very secret this
 * exists to catch into coordinator.log, the job manifest, and a chat
 * transcript. Only the rule identifier and line number are safe to keep.
 */
export async function scanTextForSecrets(text, filePath = "content") {
  const value = String(text ?? "");
  if (!value.trim()) return [];
  const engine = await secretlintEngine();
  if (!engine) return [];
  let parsed;
  try {
    const result = await engine.executeOnContent({ content: value, filePath });
    parsed = JSON.parse(result.output);
  } catch { return []; }
  const found = new Set();
  for (const file of parsed ?? []) for (const m of file?.messages ?? []) found.add(m.messageId || m.ruleId || "unknown");
  return [...found];
}

// `git diff -U0`'s hunk body lines are either "+added" or "-removed" (no
// context lines). Joined back into ONE multi-line blob per file, not
// scanned line by line: a private-key block or a multi-line JSON credential
// spans several lines, and scanning one line at a time would never let a
// multi-line rule match at all. Line NUMBERS (parseAddedLineNumbers, this
// deliberately does not change) and line TEXT are two different needs, kept
// as two small functions rather than reshaping an already-shipped one.
export function extractAddedLinesBlob(diffText) {
  const lines = [];
  let inHunk = false;
  for (const line of String(diffText ?? "").split("\n")) {
    if (/^@@ /.test(line)) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) lines.push(line.slice(1));
  }
  return lines.join("\n");
}

/**
 * Scan every changed file's ADDED content (not the whole file -- a secret
 * already sitting in the repo before this job is not this job's leak to
 * flag) plus the worker's own report text, for the known secret shapes
 * above. Deletions are skipped -- nothing new to read there.
 *
 * @param {{ cwd: string, changedFiles: {path: string, status: string}[], gitDiffFn: (file: string) => Promise<string>, reportText?: string }} input
 */
export async function detectPossibleSecrets({ cwd, changedFiles = [], gitDiffFn, reportText = "" }) {
  const flagged = [];
  for (const entry of changedFiles) {
    if (String(entry?.status ?? "").toUpperCase().startsWith("D")) continue; // a deletion has no new content to scan
    let diffText;
    try { diffText = await gitDiffFn(entry.path); } catch { continue; }
    const blob = extractAddedLinesBlob(diffText);
    if (!blob.trim()) continue;
    const patterns = await scanTextForSecrets(blob, entry.path);
    if (patterns.length > 0) flagged.push({ file: entry.path, patterns });
  }
  const reportPatterns = await scanTextForSecrets(reportText, "worker-report.txt");
  if (reportPatterns.length > 0) flagged.push({ file: "(worker report)", patterns: reportPatterns });
  if (flagged.length === 0) return null;
  return {
    flagged,
    reason: `pattern(s) matching a known secret shape found in ${flagged.map((f) => `${f.file} (${f.patterns.join(", ")})`).join("; ")} -- the diff/report is the one channel that always leaves the sandbox regardless of network isolation. Never auto-committed; rotate the credential if this is real, then review by hand. This is a deterministic pattern match for well-known secret shapes (AWS/GitHub/Slack/Stripe/OpenAI-shaped keys, PEM headers, JWTs), not a general content scan -- it cannot see a secret shaped like ordinary text.`,
  };
}

// `git diff` against the base SHA cannot see files the worker created but that
// were never committed, and a retained worktree is exactly that case. Fold the
// untracked paths in as additions so a retained job's test changes are still
// visible to review.
export function mergeUntrackedIntoNameStatus(nameStatus, untrackedFiles) {
  const seen = new Set((nameStatus ?? []).map(e => e.path));
  const extra = (untrackedFiles ?? [])
    .filter(f => f && !seen.has(f))
    .map(f => ({ status: "A", path: f, oldPath: null, untracked: true }));
  return [...(nameStatus ?? []), ...extra];
}

