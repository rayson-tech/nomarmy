// Reload and persistence: a UI change that touches saved data or a
// server-sent event needs a test that rebuilds the view from saved data.
//
// Found in a real session: a state shown after an action was lost on page
// reload, because the view only ever got it from the live event and never
// from what the server saved. Every test drove the live path. This asks for
// at least one test that rebuilds the view from saved data (a reload, a
// fresh mount from stored state), or a written reason there isn't one:
// "RELOAD: no test because ..." in .openclaw/accounting.md or the NOTE.
// Heuristic, so a review flag, never a block.

import { diffLines } from "./assertions.mjs";
import { ACCOUNTING_FILE } from "./surface-map.mjs";

const UI_FILE = /\.(?:[cm]?[jt]sx|vue|svelte|astro)$|(?:^|\/)(?:components|pages|views|ui|screens|routes|app)\/.*\.(?:[cm]?[jt]s)$/;
const SAVED_OR_LIVE = /\b(?:localStorage|sessionStorage|indexedDB|IDBDatabase|useLocalStorage|persist\w*|hydrat\w*|fetch\w*\(|axios|useQuery|useSWR|useMutation|mutate\(|\.(?:post|put|patch|delete)\(|EventSource|onmessage|text\/event-stream|useEventSource|subscribe\(|\bsse\b|saved?\w*|store\.(?:set|save)|db\.|prisma\.|supabase\.)/i;
// A test about rebuilding from saved data says so in its title, or reloads
// for real. Boilerplate like vi.restoreAllMocks() or cleanup's unmount()
// matched a looser pattern on a real Senti job.
const RELOAD_TITLE = /\b(?:it|test|describe|context|scenario)(?:\.\w+)?\(\s*['"`][^'"`]*\b(?:reload\w*|rehydrat\w*|restor\w*\s+from|persist\w*|refresh\w*|saved|stored|rebuil\w*|reconstruct\w*|remount\w*|fresh\s+(?:mount|render|load|page)|from\s+(?:the\s+)?(?:server|database|db|storage|history))/i;
const RELOAD_CALL = /\b(?:page|location|window\.location)\.reload\(|\brerender\(\s*<[^>]*(?:initial|saved|stored)/i;
const RELOAD_TEST = { test: (line) => RELOAD_TITLE.test(line) || RELOAD_CALL.test(line) };
export const RELOAD_REASON = /^\s*[-*]?\s*RELOAD:\s*\S.{5,}/im;

/**
 * @param {object} p
 * @param {{ file: string, diff: string, status?: string, content?: string }[]} p.files every changed file (diff for M, content for A)
 * @param {(f: string) => boolean} p.isTestPath
 * @param {boolean} p.eventsChanged the surface map found a changed SSE event
 * @param {string} p.accountingText the worker's accounting file and NOTE
 */
export function reloadCheck({ files = [], isTestPath = () => false, eventsChanged = false, accountingText = "" }) {
  const touchedLines = (f) => (f.status === "A" ? String(f.content ?? "").split("\n") : diffLines(f.diff).map((l) => l.text));
  const ui = files.filter((f) => !isTestPath(f.file) && UI_FILE.test(f.file));
  if (!ui.length) return null;
  const production = files.filter((f) => !isTestPath(f.file));
  const savedOrLive = eventsChanged || production.some((f) => touchedLines(f).some((l) => SAVED_OR_LIVE.test(l)));
  if (!savedOrLive) return null;
  const tests = files.filter((f) => isTestPath(f.file) && f.status !== "D");
  const covered = tests.filter((f) => (f.status === "A" ? String(f.content ?? "") : diffLines(f.diff).filter((l) => l.sign === "+").map((l) => l.text).join("\n")).split("\n").some((l) => RELOAD_TEST.test(l)));
  if (covered.length) return { required: true, satisfied: true, by: covered.map((f) => f.file) };
  if (RELOAD_REASON.test(String(accountingText ?? ""))) return { required: true, satisfied: true, by: ["the worker's RELOAD reason"] };
  return {
    required: true, satisfied: false,
    reason: `a UI change (${ui.slice(0, 4).map((f) => f.file).join(", ")}${ui.length > 4 ? ", ..." : ""}) touches saved data or a live event, and no changed test rebuilds the view from saved data (a reload or a fresh mount from stored state). A state that only arrives live is lost on reload. Add one, or have the worker write "RELOAD: no test because <reason>" in ${ACCOUNTING_FILE}`,
  };
}

export const RELOAD_RULE = `- If you change UI that shows saved data or reacts to a server-sent event, add at least one test that rebuilds the view from saved data (a reload, or a fresh mount from stored state), so a state that only arrives live isn't lost on reload. If there can't be one, write "RELOAD: no test because <reason>" in ${ACCOUNTING_FILE}.`;
