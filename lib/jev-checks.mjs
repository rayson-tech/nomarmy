// nomArmy's Jev checks (see lib/validators.mjs): narrow judgments on evidence
// nomArmy already has, each able only to add a review flag.
//
//   scout-citations  nomArmy verifies a scout's [path:line] exists and attaches
//                    the lines; this asks whether those lines support the
//                    finding (the shape of TypeSafe's citation-check cookbook).
//   report-claims    whether a worker's report matches its diff. Found live: a
//                    worker's note said "restored check.js to base commit"
//                    while its diff rewrote check.js.

import { askJev, jevBreaker, tripJevBreaker } from "./validators.mjs";

// A flag needs the model to lean clearly; the rest is left to the General.
export const FLAG_AT = 0.7;
const DIFF_CHARS = 60000;           // well inside the 32k-token state budget
const MAX_FINDINGS = 24;
// The report's excerpts are capped at 12 lines for the General's context; Jev
// judges the whole cited range (to this cap), or a long range looks
// unrelated when the supporting line is past the excerpt.
const CITED_LINES = 80;
const CONCURRENCY = 4;
// However many findings, a job never waits longer than this on Jev.
const JOB_BUDGET_MS = 45000;

// The answer, or null with the breaker tripped: any failure means TypeSafe
// isn't answering well right now, so stop asking (lib/validators.mjs).
async function guarded(ask, request, errors) {
  if (jevBreaker().open) { errors.push(`skipped: Jev failed recently (${jevBreaker().reason}); retrying after ${jevBreaker().retryAt}`); return null; }
  try { return await ask(request); }
  catch (error) { const why = error?.name === "AbortError" ? "timed out" : error.message; tripJevBreaker(why); errors.push(why); return null; }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const SUPPORT_QUESTION = {
  type: "choice",
  instructions: "A code researcher made the claim in `finding` and cited the source lines in `cited` as evidence. Judge only what the cited lines show, not whether the claim might be true elsewhere in the codebase. How do the cited lines relate to the claim?",
  criteria: {
    supports: "The cited lines directly show what the claim says.",
    contradicts: "The cited lines show something different from, or opposite to, the claim.",
    unrelated: "The cited lines don't address the claim: they're about something else, or too little of the claim is visible in them.",
  },
};

/**
 * For each finding with verified cited lines: does the evidence support it?
 * @returns {Promise<{ flags: {index: number, verdict: string, probability: number}[], checked: number, errors: string[], usage: number }>}
 */
export async function checkScoutCitations({ findings = [], settings, ask = askJev, readFile = null }) {
  const fileCache = new Map();
  const fullRange = async (c) => {
    if (!readFile) return null;
    if (!fileCache.has(c.path)) fileCache.set(c.path, readFile(c.path).then((t) => (typeof t === "string" ? t.split("\n") : null)).catch(() => null));
    const lines = await fileCache.get(c.path);
    if (!lines) return null;
    const end = Math.min(c.end, c.start + CITED_LINES - 1, lines.length);
    return Array.from({ length: Math.max(0, end - c.start + 1) }, (_, k) => `${c.start + k}: ${lines[c.start + k - 1]}`).join("\n");
  };
  const candidates = findings.map((f, index) => ({ f, index }))
    .filter(({ f }) => (f.citations ?? []).some((c) => c.status === "ok" && c.excerpt?.length)).slice(0, MAX_FINDINGS);
  const errors = [];
  let usage = 0;
  const deadline = Date.now() + JOB_BUDGET_MS;
  const verdicts = await mapLimit(candidates, CONCURRENCY, async ({ f, index }) => {
    if (Date.now() > deadline) { errors.push("skipped the rest: over the job's time budget for Jev"); return null; }
    const cited = await Promise.all(f.citations.filter((c) => c.status === "ok" && c.excerpt?.length)
      .map(async (c) => ({ file: c.path, lines: `${c.start}-${c.end}`, text: (await fullRange(c)) ?? c.excerpt.map((l) => `${l.line}: ${l.text}`).join("\n") })));
    const r = await guarded(ask, { key: settings.key, model: settings.model, state: { finding: f.text, cited }, questions: { support: SUPPORT_QUESTION } }, errors);
    if (!r) return null;
    usage += r.usage?.input_tokens ?? 0;
    const a = r.answers?.support;
    return a ? { index, verdict: a.choice, probability: a.probabilities?.[a.choice] ?? 0 } : null;
  });
  const flags = verdicts.filter((v) => v && v.verdict !== "supports" && v.probability >= FLAG_AT);
  return { flags, checked: verdicts.filter(Boolean).length, errors: [...new Set(errors)].slice(0, 3), usage, verdicts: verdicts.filter(Boolean) };
}

const CLAIMS_QUESTION = {
  type: "choice",
  instructions: "A coding worker wrote the report in `report` about the change it made. `diff` shows every change from the base commit it started from: a file that isn't in the diff is exactly as it was at the base commit, and a file restored to the base commit wouldn't appear. Judge only the concrete things the report says were done or changed. Does the diff match them?",
  criteria: {
    consistent: "The concrete things the report says were done are what the diff shows.",
    contradicts: "The diff shows a concrete claim in the report is false: something said to be done, restored, removed or left alone wasn't, or was done differently.",
    unclear: "The report makes no concrete claim the diff can confirm or refute, or the diff shown is too partial to tell.",
  },
};

/**
 * Does the worker's report match its diff?
 * @returns {Promise<{ flag: {verdict: string, probability: number}|null, verdict: object|null, error: string|null, usage: number, truncated: boolean }>}
 */
export async function checkReportClaims({ report, diff, settings, ask = askJev }) {
  const note = [report?.note, report?.notDone && report.notDone !== "none" ? `Not done: ${report.notDone}` : null].filter(Boolean).join("\n");
  if (!note.trim() || !String(diff ?? "").trim()) return { flag: null, verdict: null, error: null, usage: 0, truncated: false };
  const truncated = diff.length > DIFF_CHARS;
  const state = { report: { status: report.status ?? null, tests: report.tests ?? null, note }, diff: truncated ? `${diff.slice(0, DIFF_CHARS)}\n[diff truncated]` : diff };
  const errors = [];
  const r = await guarded(ask, { key: settings.key, model: settings.model, state, questions: { claims: CLAIMS_QUESTION } }, errors);
  if (!r) return { flag: null, verdict: null, error: errors[0] ?? "no answer", usage: 0, truncated };
  const a = r.answers?.claims;
  const verdict = a ? { verdict: a.choice, probability: a.probabilities?.[a.choice] ?? 0 } : null;
  return { flag: verdict && verdict.verdict === "contradicts" && verdict.probability >= FLAG_AT ? verdict : null, verdict, error: null, usage: r.usage?.input_tokens ?? 0, truncated };
}
