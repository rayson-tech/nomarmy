// OpenClaw 2026.10 guards its state database with an owner lock. With no
// Gateway running, a CLI command that opens it (models list --refresh,
// models auth list, config get) holds the lock as "sqlite-maintenance", and
// every other OpenClaw process exits 1 with "OpenClaw state at ... is
// undergoing offline maintenance; retry when it finishes." until it's done.
// So two nomArmy calls at once (health's checks, the MCP server's catalog
// refresh, a job starting), or one alongside the user's own, fail for a few
// seconds. Found by a user: health read a refused `models auth list` as
// "Codex import missing", and each suggested re-import left another
// credential-bearing backup in ~/.openclaw-backups.
export const OPENCLAW_STATE_BUSY = /undergoing offline maintenance|StateDatabase(?:OfflineMaintenance|AdmissionPending)Error/;

export function openclawStateBusy(text) {
  return OPENCLAW_STATE_BUSY.test(String(text ?? ""));
}

const SERIAL = Symbol("serialOpenclawRun");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `run` (lib/health.mjs runBounded's shape: resolves { ok, stdout, stderr })
 * with this process's OpenClaw calls made one at a time, each retried while
 * the state database is busy. Other commands pass straight through.
 */
export function serialOpenclawRun(run, openclawCmd, { retries = 4, delayMs = 2000, sleep = pause } = {}) {
  if (run[SERIAL]) return run;
  let tail = Promise.resolve();
  const wrapped = (cmd, args, opts) => {
    if (cmd !== openclawCmd) return run(cmd, args, opts);
    const attempt = async () => {
      for (let i = 1; ; i++) {
        const result = await run(cmd, args, opts);
        if (result.ok || i > retries || !openclawStateBusy(`${result.stderr ?? ""}\n${result.out ?? ""}\n${result.stdout ?? ""}`)) return result;
        await sleep(delayMs * i);
      }
    };
    const next = tail.then(attempt, attempt);
    tail = next.catch(() => {});
    return next;
  };
  wrapped[SERIAL] = true;
  return wrapped;
}

/** The first line of OpenClaw's output worth showing, for an issue's detail. */
export function openclawErrorLine(result) {
  try {
    const message = JSON.parse(result?.stdout ?? "")?.error?.message;
    if (typeof message === "string" && message.trim()) return message.trim().split("\n")[0];
  } catch { /* not a JSON envelope */ }
  const lines = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => openclawStateBusy(l)) ?? lines.find((l) => !/^\[openclaw\] (The CLI command failed|For help, run)/.test(l)) ?? null;
}
