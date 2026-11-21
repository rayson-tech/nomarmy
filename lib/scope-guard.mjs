// Scope guard: edits the brief doesn't justify.
//
// Found in a real session: a worker fixing one thing in a shared component
// also removed an unrelated CSS class from it. Tests passed; the General only
// saw it reading every line. This lists, separately from the main diff, the
// kinds of small edit that slip past a skim:
//
//   * a CSS class removed from markup (className, class, clsx/cn, classList)
//     or a CSS rule removed from a stylesheet;
//   * a default value changed (a parameter default, a `default:` or
//     `defaultValue`, an ALL_CAPS constant);
//   * an accessibility or test hook removed (aria-*, role, data-testid).
//
// One the brief names (the token, the setting or its new value) is
// justified and not listed. Review only: a heuristic never blocks a commit.

import { diffLines } from "./assertions.mjs";

const MARKUP = /\.(?:[cm]?[jt]sx|vue|svelte|html?|erb|hbs|astro|php)$/;
const STYLES = /\.(?:css|scss|sass|less|styl)$/;
const CLASS_SOURCES = [
  /\bclass(?:Name)?\s*=\s*\{?\s*(['"`])([^'"`]*)\1/g,
  /\b(?:clsx|cn|classNames|cx|twMerge)\(([^)]*)\)/g,
  /\bclassList\.(?:add|remove|toggle)\(([^)]*)\)/g,
  /\b:class\s*=\s*"([^"]*)"/g,
];
const HOOK_ATTR = /\s((?:aria-[\w-]+|role|data-testid|data-test|data-cy|tabIndex|tabindex|alt|htmlFor|for))\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*')/g;
const LITERAL = String.raw`(-?\d[\d_.]*|true|false|null|None|undefined|'[^']*'|"[^"]*"|\`[^\`]*\`)`;
const DEFAULT_SITES = [
  new RegExp(String.raw`[(,{]\s*([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>[\]|. ]+)?\s*=\s*${LITERAL}`, "g"),          // param default
  new RegExp(String.raw`\b(default(?:Value|Checked|Props|_value)?|[A-Za-z_$][\w$]*Default|default[A-Z]\w*)\s*[:=]\s*\{?\s*${LITERAL}`, "g"),
  new RegExp(String.raw`\b([A-Z][A-Z0-9_]{2,})\s*[:=]\s*${LITERAL}`, "g"),                                      // constants
];

function classTokens(line) {
  const out = new Set();
  for (const re of CLASS_SOURCES) {
    for (const m of line.matchAll(re)) {
      const raw = m[2] ?? m[1] ?? "";
      for (const s of raw.match(/['"`]([^'"`]*)['"`]/g)?.map((q) => q.slice(1, -1)) ?? [raw]) {
        for (const t of s.split(/\s+/)) if (/^[A-Za-z_-][\w:/.[\]-]*$/.test(t) && t.length > 1) out.add(t);
      }
    }
  }
  return out;
}
function cssSelectors(line) {
  const out = new Set();
  if (!/[{,]\s*$/.test(line.trim()) && !/\{/.test(line)) return out;
  for (const m of line.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) out.add(m[1]);
  return out;
}
function defaults(line) {
  const out = new Map();
  for (const re of DEFAULT_SITES) for (const m of line.matchAll(re)) out.set(m[1], m[2]);
  return out;
}
function hooks(line) {
  const out = new Map();
  for (const m of line.matchAll(HOOK_ATTR)) out.set(m[1], m[2]);
  return out;
}

/**
 * Edits the brief doesn't mention.
 * @param {{ files: { file: string, diff: string }[], brief: string }} p
 * @returns {{ file: string, kind: string, detail: string }[]}
 */
export function unrequestedChanges({ files = [], brief = "" }) {
  const said = String(brief ?? "").toLowerCase();
  const named = (...words) => words.some((w) => w != null && String(w).length > 1 && said.includes(String(w).toLowerCase().replace(/^['"`]|['"`]$/g, "")));
  const out = [];
  for (const { file, diff } of files) {
    const lines = diffLines(diff);
    const removed = lines.filter((l) => l.sign === "-").map((l) => l.text);
    const added = lines.filter((l) => l.sign === "+").map((l) => l.text);
    if (MARKUP.test(file)) {
      const gone = new Set(removed.flatMap((l) => [...classTokens(l)]));
      const kept = new Set(added.flatMap((l) => [...classTokens(l)]));
      for (const t of gone) if (!kept.has(t) && !named(t)) out.push({ file, kind: "class removed", detail: `CSS class "${t}" removed` });
      const hooksGone = new Map(removed.flatMap((l) => [...hooks(l)]));
      const hooksKept = new Map(added.flatMap((l) => [...hooks(l)]));
      for (const [attr, value] of hooksGone) {
        if (hooksKept.has(attr) || named(attr, value)) continue;
        out.push({ file, kind: "hook removed", detail: `${attr}=${value.slice(0, 60)} removed` });
      }
    }
    if (STYLES.test(file)) {
      const gone = new Set(removed.flatMap((l) => [...cssSelectors(l)]));
      const kept = new Set(added.flatMap((l) => [...cssSelectors(l)]));
      for (const t of gone) if (!kept.has(t) && !named(t)) out.push({ file, kind: "rule removed", detail: `CSS rule for ".${t}" removed` });
    }
    const before = new Map(removed.flatMap((l) => [...defaults(l)]));
    const after = new Map(added.flatMap((l) => [...defaults(l)]));
    for (const [name, value] of before) {
      if (!after.has(name) || after.get(name) === value || named(name, after.get(name))) continue;
      out.push({ file, kind: "default changed", detail: `${name}: ${value.slice(0, 40)} became ${after.get(name).slice(0, 40)}` });
    }
  }
  return out;
}

/** The separate "unrequested changes" section, or null. */
export function scopeVerdict(items) {
  if (!items.length) return null;
  const shown = items.slice(0, 12).map((i) => `${i.file}: ${i.detail}`);
  return {
    reason: `${items.length} edit(s) the brief doesn't mention: ${shown.join("; ")}${items.length > 12 ? `; +${items.length - 12} more` : ""}. Confirm each was intended (a heuristic: the brief may justify one in other words)`,
    items,
  };
}
