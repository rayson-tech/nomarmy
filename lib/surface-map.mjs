// Surface map: every other use of what a diff changed.
//
// Found in a real session: a worker changed a component and its tests, all
// green, without knowing the component was also rendered on another page,
// which it left broken. When a diff changes an exported function, class,
// component, type or server-sent event, this finds every other file that
// uses it (deterministic, the same whole-word search repo_evidence runs) and
// requires the worker to account for each one: changed, or "not affected
// because...". A use the worker didn't account for marks the job for review.
//
// The worker accounts in .openclaw/accounting.md (one line per file), which
// the Git record ignores, or in its report NOTE. Grep-based: a use through a
// re-export under another name isn't found, and a common name can match
// unrelated files; both are stated in the flag.

import { diffLines } from "./assertions.mjs";

export const ACCOUNTING_FILE = ".openclaw/accounting.md";
const MAX_USES = 40;

// Exported definitions, by language. Group 1 is the name.
const EXPORT_PATTERNS = [
  { lang: /\.(?:[cm]?[jt]sx?)$/, re: /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/ },
  { lang: /\.(?:[cm]?[jt]sx?)$/, re: /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/ },
  { lang: /\.py$/, re: /^(?:async\s+)?(?:def|class)\s+([A-Za-z][\w]*)/ },
  { lang: /\.go$/, re: /^(?:func(?:\s+\([^)]*\))?|type)\s+([A-Z][\w]*)/ },
  { lang: /\.rs$/, re: /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+([A-Za-z_][\w]*)/ },
  { lang: /\.(?:vue|svelte)$/, re: /^\s*export\s+(?:default\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/ },
];
// Any top-level definition (exported or not) ends the previous one's range.
const TOP_LEVEL = /^(?:export\s+|pub\s+|async\s+|def\s|class\s|func\s|type\s|function\s|const\s|let\s|var\s|interface\s|enum\s|module\.exports|exports\.)/;
// Server-sent events: a name the server sends or a client listens for.
const SSE_FILE = /EventSource|text\/event-stream|\bsse\b|ServerSentEvent/i;
const SSE_EVENT = [
  /\bevent\s*[:=]\s*['"`]([A-Za-z][\w.:-]{1,60})['"`]/,
  /^\s*event:\s*([A-Za-z][\w.:-]{1,60})\s*$/,
  /`event:\s*([A-Za-z][\w.:-]{1,60})\\n/,
  /\baddEventListener\(\s*['"`]([A-Za-z][\w.:-]{1,60})['"`]/,
  /\b(?:sendEvent|emitEvent|writeEvent|sseSend|send_event)\(\s*(?:\w+\s*,\s*)?['"`]([A-Za-z][\w.:-]{1,60})['"`]/,
];
const GENERIC_EVENTS = new Set(["message", "error", "open", "close", "ping", "data"]);
// A use counts in code of the same family as the definition (a server-sent
// event in any code file): mentions in docs, or a same-named Python symbol
// beside a TypeScript one, were most of the noise on a real Senti replay.
const FAMILIES = [
  /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/,
  /\.(?:py|pyi)$/,
  /\.go$/,
  /\.rs$/,
  /\.(?:rb|erb)$/,
  /\.(?:java|kt|kts|scala)$/,
  /\.(?:cs|fs)$/,
  /\.(?:php)$/,
  /\.(?:swift)$/,
];
const CODE = new RegExp(FAMILIES.map((f) => f.source).join("|"));
export function sameFamily(definedIn, usedIn, kind = "symbol") {
  if (kind === "event") return CODE.test(usedIn);
  const family = FAMILIES.find((f) => f.test(definedIn));
  return family ? family.test(usedIn) : CODE.test(usedIn);
}

/** Old and new line numbers a -U0 diff touches. */
export function touchedLines(diffText) {
  const oldLines = [], newLines = [];
  for (const line of String(diffText ?? "").split("\n")) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const [os, oc, ns, nc] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    for (let i = 0; i < oc; i++) oldLines.push(os + i);
    for (let i = 0; i < nc; i++) newLines.push(ns + i);
  }
  return { oldLines, newLines };
}

/** Exported definitions in a file, each with the line range it spans. */
export function exportedRanges(file, text) {
  const patterns = EXPORT_PATTERNS.filter((p) => p.lang.test(file));
  if (!patterns.length || text == null) return [];
  const lines = String(text).split("\n");
  const starts = [];
  lines.forEach((line, i) => { if (TOP_LEVEL.test(line)) starts.push(i + 1); });
  const out = [];
  lines.forEach((line, i) => {
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (!m) continue;
      if (/\.py$/.test(file) && m[1].startsWith("_")) continue;
      const next = starts.find((s) => s > i + 1) ?? lines.length + 1;
      out.push({ name: m[1], start: i + 1, end: next - 1 });
      break;
    }
  });
  return out;
}

/**
 * Exported names and SSE events a file's change touched.
 * @returns {{ symbols: string[], events: string[] }}
 */
export function changedSurface({ file, diff, headText = null, baseText = null }) {
  const { oldLines, newLines } = touchedLines(diff);
  const symbols = new Set();
  for (const [text, touched] of [[headText, newLines], [baseText, oldLines]]) {
    for (const r of exportedRanges(file, text)) {
      if (touched.some((n) => n >= r.start && n <= r.end)) symbols.add(r.name);
    }
  }
  const events = new Set();
  if (SSE_FILE.test(`${headText ?? ""}\n${baseText ?? ""}`)) {
    for (const l of diffLines(diff)) {
      for (const re of SSE_EVENT) {
        const m = re.exec(l.text);
        if (m && !GENERIC_EVENTS.has(m[1])) events.add(m[1]);
      }
    }
  }
  return { symbols: [...symbols], events: [...events] };
}

/**
 * Every use of the changed surface outside the diff.
 * @param {object} p
 * @param {{ file: string, diff: string, headText?: string|null, baseText?: string|null }[]} p.files changed production files
 * @param {string[]} p.changedFiles every file the diff touches (uses there are already "changed")
 * @param {(name: string) => { hits: { path: string, line: number }[], truncated?: boolean }} p.references
 * @param {(file: string) => boolean} p.isTestPath
 */
export function surfaceUses({ files = [], changedFiles = [], references, isTestPath = () => false }) {
  const changed = new Set(changedFiles);
  const items = [];
  const seen = new Set();
  for (const f of files) {
    const { symbols, events } = changedSurface(f);
    for (const [kind, names] of [["symbol", symbols], ["event", events]]) {
      for (const name of names) {
        const key = `${kind}:${name}`;
        if (seen.has(key) || (kind === "symbol" && name.length < 3)) continue;
        seen.add(key);
        let found;
        try { found = references(name); } catch { continue; }
        const usedIn = [...new Set((found?.hits ?? []).map((h) => h.path))]
          .filter((p) => !changed.has(p) && !isTestPath(p) && !p.startsWith(".openclaw/") && sameFamily(f.file, p, kind));
        if (usedIn.length) items.push({ kind, name, definedIn: f.file, usedIn: usedIn.slice(0, MAX_USES), truncated: usedIn.length > MAX_USES || Boolean(found?.truncated) });
      }
    }
  }
  return items;
}

/** Which uses the worker accounted for, from its accounting file and report. */
export function accountFor(items, accountingText = "") {
  const text = String(accountingText ?? "");
  const mentioned = (p) => text.includes(p);
  const unaccounted = [];
  for (const item of items) {
    const missing = item.usedIn.filter((p) => !mentioned(p));
    if (missing.length) unaccounted.push({ ...item, usedIn: missing });
  }
  return unaccounted;
}

/** The review flag, or null when every use is accounted for. */
export function surfaceVerdict(items, unaccounted) {
  if (!unaccounted.length) return null;
  const parts = unaccounted.slice(0, 8).map((u) => `${u.kind === "event" ? "event" : ""} ${u.name} (changed in ${u.definedIn}) is also used in ${u.usedIn.slice(0, 6).join(", ")}${u.usedIn.length > 6 ? `, +${u.usedIn.length - 6} more` : ""}`.trim());
  const files = new Set(unaccounted.flatMap((u) => u.usedIn));
  return {
    reason: `${files.size} file(s) use what this diff changed and the worker didn't say whether they're affected: ${parts.join("; ")}${unaccounted.length > 8 ? "; ..." : ""}. Each needs "changed" or "not affected because..." (a whole-word search: a common name can match unrelated files, and a use through a re-export under another name isn't found)`,
    files: [...files],
    total: items.reduce((n, i) => n + i.usedIn.length, 0),
  };
}

/** The worker's instruction for accounting, added to every implement brief. */
export const ACCOUNTING_RULE = `- If you change an exported function, class, component, type or a server-sent event that other files use, find every other file that uses it and write ${ACCOUNTING_FILE} with one line per such file: "<path>: changed" or "<path>: not affected because <reason>". nomArmy finds these uses itself and flags any you leave out.`;
