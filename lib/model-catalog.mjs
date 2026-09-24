// Reads OpenClaw's own model catalog for a hosted model's real context
// window -- deliberately NOT a second, hand-maintained table of the same
// numbers inside nomArmy, which would only ever go stale (this is exactly
// the class of thing a sharp reviewer flags first). OpenClaw already tracks
// this per "<provider>/<model>" key, the same key nomArmy already composes
// for dispatch (see resolvePoolSelection in mcp/server.mjs), and refreshes
// it itself (`openclaw models list --refresh`) independently of nomArmy.
//
// A brand-new model (verified live: xai/grok-4.7, released the same day
// this was written) will not be in OpenClaw's CACHED catalog until that
// refresh runs -- lib/dispatch-config.mjs's context_window override exists
// specifically for that gap, not as a alternative to this lookup.
import { execFile, execFileSync } from "node:child_process";

// Bounded: this runs inside the MCP server, where a synchronous call with no
// timeout blocks every request the server handles until it returns.
const SYNC_TIMEOUT_MS = 20000;
const ASYNC_TIMEOUT_MS = 180000;

function defaultRun(cmd, args) {
  // "Gateway is not running..." and similar operational notices land on
  // OpenClaw's stderr, not stdout (verified live) -- stdout alone parses as
  // clean JSON regardless of whether that notice fires.
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: SYNC_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
}

function parseCatalog(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const byKey = new Map();
  for (const m of parsed?.models ?? []) {
    if (m?.key && Number.isFinite(m.contextWindow) && m.contextWindow > 0) byKey.set(m.key, m.contextWindow);
  }
  return byKey;
}

/**
 * The same query, off the caller's thread. `--refresh` contacts every
 * provider (about 15 seconds when they're healthy, unbounded when one
 * stalls), so the MCP server runs it this way: run synchronously, a stalled
 * provider froze the whole server -- the likeliest cause of a status call
 * that hung for 35 minutes in a real Senti run.
 * @returns {Promise<Map<string, number>|null>}
 */
export function queryModelCatalogAsync({ openclawCmd = process.env.NOMARMY_OPENCLAW_CMD || "openclaw", refresh = false, timeoutMs = ASYNC_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(openclawCmd, ["models", "list", "--all", "--json", ...(refresh ? ["--refresh"] : [])],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : parseCatalog(stdout)));
  });
}

/**
 * @returns {Map<string, number>|null} "<provider>/<model>" -> context window
 *   in tokens, or null if openclaw isn't reachable/installed/erroring. Never
 *   throws -- a missing catalog is a fallback case for the caller, not a
 *   failure of this function.
 */
// `refresh` asks OpenClaw to re-discover every provider's models first
// (about 15 seconds, confirmed live). Without it the cached catalog may hold
// no entries at all for a provider OpenClaw hasn't refreshed yet (seen live:
// openai, xai and meta all absent while claude-cli was present).
export function queryModelCatalog({ openclawCmd = process.env.NOMARMY_OPENCLAW_CMD || "openclaw", run = defaultRun, refresh = false } = {}) {
  let raw;
  try {
    raw = run(openclawCmd, ["models", "list", "--all", "--json", ...(refresh ? ["--refresh"] : [])]);
  } catch {
    return null;
  }
  return parseCatalog(raw);
}
