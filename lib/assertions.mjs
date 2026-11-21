// Removed and weakened assertions in a job's test changes.
//
// "existing tests modified" was only a review flag, and the judge's "did a
// test get weaker?" is a model's opinion. A real session lost a protective
// test this way: the worker deleted it, the suite went green, and only the
// General reading the diff line by line saw it. This compares assertions
// themselves, deterministically:
//
//   * an assertion line removed from a test file counts as MOVED when the
//     same assertion (whitespace aside) was added anywhere in the diff;
//   * otherwise an assertion added in the same hunk is its REPLACEMENT, and a
//     replacement that only checks presence or truthiness where the old one
//     checked an exact value is LOOSENED;
//   * an assertion with neither is REMOVED.
//
// Removed or loosened assertions refuse the commit unless the brief allows
// it (allow_test_removal). Line-based and per-language regexes, so a
// multi-line assertion counts by its first line; stated as such.

// One line counts once. Comment lines never count.
const ASSERTION_LINE = new RegExp([
  String.raw`\bexpect\s*\(`,                       // jest, vitest, chai expect, rspec
  String.raw`\bexpectTypeOf\s*\(`,
  String.raw`\bassert(?:\s*\(|\s*\.|\s+\S|_\w+\s*\(|[A-Z]\w*\s*\(|!\s*\(|_eq!|_ne!)`, // node:assert, python assert, assertEquals, assert_eq!
  String.raw`\bself\.assert\w*\s*\(`,
  String.raw`\b(?:pytest|unittest)\.\w*(?:raises|warns|approx)\s*\(`,
  String.raw`\bt\.(?:is|not|deepEqual|notDeepEqual|true|false|truthy|falsy|throws|throwsAsync|notThrows|regex|like|snapshot|equal|ok|same|match|Error|Errorf|Fatal|Fatalf)\s*\(`,
  String.raw`\b(?:require|assert)\.\w+\s*\(`,       // testify
  String.raw`\.should\b`,
  String.raw`\b(?:debug_)?assert(?:_eq|_ne)?!`,     // rust
  String.raw`\bverify\s*\(`,                        // mockito
].join("|"));
const COMMENT_LINE = /^\s*(?:\/\/|#(?!\[)|\*|\/\*|--|;)/;

export function isAssertionLine(line) {
  const text = String(line ?? "");
  return !COMMENT_LINE.test(text) && ASSERTION_LINE.test(text);
}

const normalize = (line) => String(line).replace(/\s+/g, "").replace(/[;,]+$/, "");

// Matchers that pin an exact value, and ones that only check presence.
const STRICT = /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveLength|toHaveBeenCalledWith|toHaveBeenCalledTimes|toThrow\w*\(\s*\S|toMatchInlineSnapshot)\s*\(|\bassert(?:\.(?:equal|strictEqual|deepEqual|deepStrictEqual|match)|Equals?|Equal|ThrowsError|Raises)\s*\(|\bassert_(?:eq|equal)\w*|assert_eq!|\bassert\b[^\n]*(?:==|!=|\bin\b|\bis\b)|\bt\.(?:is|deepEqual|equal|same)\s*\(|\b(?:require|assert)\.(?:Equal|EqualValues|ErrorIs|Len)\s*\(/;
const WEAK = /\.(?:toBeTruthy|toBeDefined|toBeFalsy|toBeUndefined|toBeNull|toBeInstanceOf|toHaveBeenCalled|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toContain|toMatch)\s*\(\s*\)?|\.not\.toBe(?:Null|Undefined)\b|\bassert(?:\.ok|True|False|IsNotNone|IsNone|IsInstance|\.exists)?\s*\(|\bassert\s+(?:not\s+)?[\w.()[\]'"]+\s*$|\bt\.(?:true|false|truthy|falsy|ok|pass)\s*\(|\b(?:require|assert)\.(?:NotNil|Nil|True|False|NotEmpty|Error|NoError)\s*\(/;
const isStrict = (line) => STRICT.test(line);
const isWeak = (line) => WEAK.test(line) && !STRICT.test(line);

/**
 * Removed and added lines of a unified diff, by hunk.
 * @returns {{ hunk: number, sign: "-"|"+", text: string }[]}
 */
export function diffLines(diffText) {
  const out = [];
  let hunk = -1;
  for (const line of String(diffText ?? "").split("\n")) {
    if (line.startsWith("@@")) { hunk += 1; continue; }
    if (hunk < 0 || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-") || line.startsWith("+")) out.push({ hunk, sign: line[0], text: line.slice(1) });
  }
  return out;
}

/**
 * Assertion changes across a job's test files.
 * @param {{ file: string, status: "A"|"M"|"D"|string, diff?: string, content?: string }[]} files
 *   M: `diff` is `git diff -U0`; A: `content` is the new file; D: `content` is the base file.
 * @returns {{ removed: object[], loosened: object[], moved: number, replaced: number, added: number }}
 */
export function assertionChanges(files = []) {
  const removed = [], added = [];
  for (const f of files) {
    if (f.status === "D" || f.status === "A") {
      const lines = String(f.content ?? "").split("\n");
      lines.forEach((text, i) => {
        if (!isAssertionLine(text)) return;
        (f.status === "D" ? removed : added).push({ file: f.file, hunk: f.status === "D" ? "deleted" : "new", text: text.trim(), line: i + 1 });
      });
      continue;
    }
    for (const l of diffLines(f.diff)) {
      if (!isAssertionLine(l.text)) continue;
      (l.sign === "-" ? removed : added).push({ file: f.file, hunk: l.hunk, text: l.text.trim() });
    }
  }
  // Moved or reindented: the same assertion added anywhere in the diff.
  const addedByText = new Map();
  for (const a of added) addedByText.set(normalize(a.text), [...(addedByText.get(normalize(a.text)) ?? []), a]);
  const used = new Set();
  let moved = 0;
  const unmatched = [];
  for (const r of removed) {
    const twin = (addedByText.get(normalize(r.text)) ?? []).find((a) => !used.has(a));
    if (twin) { used.add(twin); moved += 1; } else unmatched.push(r);
  }
  // Replaced in place: the next unused assertion added in the same hunk.
  const gone = [], loosened = [];
  let replaced = 0;
  for (const r of unmatched) {
    const replacement = r.hunk === "deleted" ? null
      : added.find((a) => !used.has(a) && a.file === r.file && a.hunk === r.hunk);
    if (!replacement) { gone.push({ file: r.file, removed: r.text, replacement: null }); continue; }
    used.add(replacement);
    replaced += 1;
    if (isStrict(r.text) && isWeak(replacement.text)) loosened.push({ file: r.file, removed: r.text, replacement: replacement.text });
  }
  return { removed: gone, loosened, moved, replaced, added: added.filter((a) => !used.has(a)).length };
}

/**
 * The review section and, unless the brief allows it, the commit refusal.
 * @returns {null | { block: boolean, reason: string, lines: string[] }}
 */
export function assertionVerdict(changes, { allowTestRemoval = false } = {}) {
  if (!changes || (!changes.removed.length && !changes.loosened.length)) return null;
  const clip = (s) => (s.length > 160 ? `${s.slice(0, 157)}...` : s);
  const lines = [
    ...changes.removed.map((c) => `${c.file}: removed \`${clip(c.removed)}\` with no replacement`),
    ...changes.loosened.map((c) => `${c.file}: \`${clip(c.removed)}\` became \`${clip(c.replacement)}\` (checks less)`),
  ];
  const count = changes.removed.length + changes.loosened.length;
  const what = [changes.removed.length ? `${changes.removed.length} removed` : "", changes.loosened.length ? `${changes.loosened.length} loosened` : ""].filter(Boolean).join(", ");
  return {
    block: !allowTestRemoval,
    reason: `${count} assertion${count === 1 ? "" : "s"} (${what}) without an equal or stronger replacement${allowTestRemoval ? " (the brief allows it: allow_test_removal)" : ""}`,
    lines,
  };
}
