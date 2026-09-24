// What did the worker actually read, and was it worth it?
//
// OpenClaw keeps its session transcript in a sqlite database under the state
// directory nomArmy now gives it. From that transcript two things can be
// derived that the model's own report cannot be trusted to state:
//
//   * which tools it called and which files it read, and
//   * how much repository content came back through those tool results.
//
// The second number is the one this project exists for. It is roughly what
// the frontier coordinator would have carried in its own context to do the
// same reading. Compared with the size of the verified report it receives
// instead, it says whether a scout displaced frontier context or added to it.
// Estimates are labeled as such and use the same 4-chars-per-token rule as
// the budgets; the point is the sign and the order of magnitude.
import fs from "node:fs";
import path from "node:path";
import { CALIBRATED } from "./budget.mjs";

/** Locate OpenClaw's transcript database under a state directory. */
export function findTranscriptDb(stateDir) {
  const stack = [stateDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name === "openclaw-agent.sqlite") return p;
    }
  }
  return null;
}

/**
 * Reduce raw transcript events to what the coordinator cares about. Pure:
 * takes the parsed `event_json` objects in order.
 */
/** Tools whose results are repository content the coordinator would otherwise have read itself. */
export const REPO_READ_TOOLS = Object.freeze(["read", "cat", "view", "open", "ls", "glob", "grep", "search", "exec", "bash", "shell"]);

export function summarizeTranscriptEvents(events) {
  const out = { modelCalls: 0, toolCalls: [], toolResultChars: 0, repoReadChars: 0, harnessChars: 0, assistantChars: 0, filesRead: [], commands: [],
    // The most recent tool result's own text, overwritten as later ones
    // arrive -- makeAbandonedBackgroundProcessTick reads this to tell "the
    // worker's last known state was a backgrounded process handle" from
    // anything else, without re-deriving it from raw events itself.
    lastToolResultText: null,
    // The final assistant message's text, which is the worker's report.
    // Kept so a run whose work finished but whose exit failed (OpenClaw's
    // own cleanup erroring after stopReason=stop, seen live with Codex)
    // can still be salvaged instead of discarded.
    lastAssistantText: null,
    // Summed over assistant messages that carry it; null when none did.
    usage: null };
  const pending = []; // tool calls awaiting their result, in order
  for (const e of events ?? []) {
    if (e?.type !== "message") continue;
    const m = e.message ?? {};
    const content = Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      out.modelCalls++;
      if (m.usage && typeof m.usage === "object") {
        const u = (out.usage ??= { input: 0, output: 0, cacheRead: 0 });
        for (const k of ["input", "output", "cacheRead"]) if (Number.isFinite(m.usage[k])) u[k] += m.usage[k];
      }
      const texts = content.filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text);
      if (texts.length) out.lastAssistantText = texts.join("\n");
      for (const c of content) {
        if (c.type === "toolCall" || c.type === "tool_call" || c.type === "tool_use") {
          const input = c.input ?? c.arguments ?? c.args ?? {};
          const tool = c.name ?? null;
          const call = { tool, path: typeof input.path === "string" ? input.path : typeof input.file === "string" ? input.file : null,
            command: typeof input.command === "string" ? input.command : null, resultChars: 0,
            repoRead: REPO_READ_TOOLS.includes(String(tool ?? "").toLowerCase()) };
          out.toolCalls.push(call);
          pending.push(call);
          if (call.path && /^(read|cat|view|open)$/i.test(tool ?? "")) out.filesRead.push(call.path);
          if (call.command) out.commands.push(call.command);
        } else if (c.type === "text" && typeof c.text === "string") {
          out.assistantChars += c.text.length;
        }
      }
    } else if (m.role === "toolResult" || m.role === "tool") {
      let chars = 0, text = "";
      for (const c of content) {
        if (typeof c.text === "string") { chars += c.text.length; text += c.text; }
        else if (typeof c.content === "string") { chars += c.content.length; text += c.content; }
      }
      out.toolResultChars += chars;
      out.lastToolResultText = text;
      // Results arrive in call order. A result for tool_search, sessions_* or
      // any other harness tool is the agent framework talking to itself, not
      // repository content, and must not be counted as displaced reading.
      const call = pending.shift();
      if (call) { call.resultChars = chars; if (call.repoRead) out.repoReadChars += chars; else out.harnessChars += chars; }
      else out.harnessChars += chars;
    }
  }
  out.filesRead = [...new Set(out.filesRead)];
  return out;
}

/**
 * Read and summarize the transcript. Never throws: a missing database, a
 * Node without `node:sqlite`, or a locked file yields `available:false` with
 * the reason, and the caller records that instead of a fabricated number.
 */
export async function readOpenClawTranscript(stateDir) {
  const dbPath = stateDir ? cachedTranscriptDb(stateDir) : null;
  if (!dbPath) return { available: false, reason: "no transcript database under the state directory", dbPath: null };
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { return { available: false, reason: "node:sqlite is not available in this Node version", dbPath }; }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("select event_json from transcript_events order by seq, rowid").all();
      const events = [];
      for (const r of rows) { try { events.push(JSON.parse(r.event_json)); } catch { /* skip a torn row */ } }
      return { available: true, reason: null, dbPath, events: events.length, ...summarizeTranscriptEvents(events) };
    } finally { db.close(); }
  } catch (error) {
    return { available: false, reason: `could not read transcript: ${error.message}`, dbPath };
  }
}

// The transcript database never moves once created, and finding it walks
// the whole state tree (for a Codex job, Codex's entire harness home), so
// the found path is cached per state directory.
const dbPathCache = new Map();
function cachedTranscriptDb(stateDir) {
  const hit = dbPathCache.get(stateDir);
  if (hit && fs.existsSync(hit)) return hit;
  const found = findTranscriptDb(stateDir);
  if (found) dbPathCache.set(stateDir, found);
  return found;
}

/**
 * A cheap read of part of the transcript, for watchers that run every few
 * seconds while a job is live. The full read (readOpenClawTranscript)
 * parsed every event synchronously on the server's only thread, and the
 * heartbeat and idle watcher each did it every tick -- on a long Codex job
 * that froze the server long enough for a status call to hang for 35
 * minutes (a real Senti run).
 *
 * `limit`: the last N events (insertion order). `sinceEvent`: every event
 * after the first N, i.e. only what a call that started at event N wrote.
 * `events` is always the total count.
 */
export async function readOpenClawTranscriptTail(stateDir, { limit = 40, sinceEvent = null } = {}) {
  const dbPath = stateDir ? cachedTranscriptDb(stateDir) : null;
  if (!dbPath) return { available: false, reason: "no transcript database under the state directory", dbPath: null, events: 0 };
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch { return { available: false, reason: "node:sqlite is not available in this Node version", dbPath, events: 0 }; }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const total = Number(db.prepare("select count(*) as n from transcript_events").get()?.n ?? 0);
      const rows = sinceEvent !== null
        ? db.prepare("select event_json from transcript_events order by rowid limit -1 offset ?").all(sinceEvent)
        : limit > 0 ? db.prepare("select event_json from transcript_events order by rowid desc limit ?").all(limit).reverse() : [];
      const events = [];
      for (const r of rows) { try { events.push(JSON.parse(r.event_json)); } catch { /* skip a torn row */ } }
      return { available: true, reason: null, dbPath, events: total, ...summarizeTranscriptEvents(events) };
    } finally { db.close(); }
  } catch (error) {
    return { available: false, reason: `could not read transcript: ${error.message}`, dbPath, events: 0 };
  }
}

/**
 * The number this project is for. `readChars` is repository content the
 * worker pulled through tool results; `deliveredChars` is what the coordinator
 * receives instead (the rendered report plus its record).
 */
export function estimateDisplacement({ readChars, deliveredChars, charsPerToken = CALIBRATED.charsPerToken }) {
  const read = Number.isFinite(readChars) ? Math.round(readChars / charsPerToken) : null;
  const delivered = Number.isFinite(deliveredChars) ? Math.round(deliveredChars / charsPerToken) : null;
  if (read === null || delivered === null) {
    return { frontier_read_tokens_est: read, delivered_tokens_est: delivered, displaced_tokens_est: null, ratio: null,
      verdict: "unknown", note: "transcript unavailable; displacement cannot be estimated" };
  }
  const displaced = read - delivered;
  const ratio = delivered > 0 ? +(read / delivered).toFixed(2) : null;
  let verdict, note;
  if (displaced <= 0) { verdict = "negative"; note = "the report is at least as large as what the scout read; asking the coordinator to read it directly would have cost less context"; }
  else if (ratio !== null && ratio < 2) { verdict = "marginal"; note = "less than a 2x reduction; a point lookup the coordinator could have done itself"; }
  else if (ratio !== null) { verdict = "positive"; note = `about ${ratio}x less coordinator context than reading the same material directly (estimate)`; }
  else { verdict = "positive"; note = "the scout read content but the report delivered none; context was displaced"; }
  return { frontier_read_tokens_est: read, delivered_tokens_est: delivered, displaced_tokens_est: displaced, ratio, verdict, note };
}
