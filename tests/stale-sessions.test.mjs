import assert from "node:assert/strict";
import test from "node:test";

import { parsePs, staleSessions, appName, listProcesses, formatStaleSessions } from "../lib/stale-sessions.mjs";

// The shape of a real afternoon: one session restarted after the update, others days old.
const PS = [
  "40538     1 ttys001  Sun Sep 27 21:33:09 2026     claude --resume",
  "40636 40538 ttys001  Sun Sep 27 21:33:11 2026     node /Users/me/.local/share/nomarmy-local-worker/mcp/server.mjs",
  "18718     1 ttys003  Sat Sep 26 21:56:28 2026     claude --resume",
  "19097 18718 ttys003  Sat Sep 26 21:56:39 2026     node /Users/me/.local/share/nomarmy-local-worker/mcp/server.mjs",
  "  700     1 ??       Sat Sep 26 08:00:00 2026     /usr/local/bin/codex",
  "  701   700 ??       Sat Sep 26 08:00:01 2026     node /usr/local/bin/nomarmy mcp",
  "  900     1 ttys009  Fri Sep 25 10:00:00 2026     node server.mjs --not-ours",
  "garbage line",
].join("\n");

test("parsePs reads pid, parent, terminal, start time and command", () => {
  const procs = parsePs(PS);
  assert.equal(procs.length, 7);
  assert.deepEqual({ ...procs[1], startedAt: new Date(procs[1].startedAt).getHours() }, { pid: 40636, ppid: 40538, tty: "ttys001", startedAt: 21, args: "node /Users/me/.local/share/nomarmy-local-worker/mcp/server.mjs" });
  assert.equal(procs[4].tty, null, "no terminal reads as null");
});

test("staleSessions names the servers that started before the install, with their app", () => {
  const installedAt = new Date("Sep 27 2026 21:27:08").getTime();
  const stale = staleSessions(parsePs(PS), { installedAt });
  assert.deepEqual(stale.map((s) => [s.app, s.appPid, s.tty]), [["Codex", 700, null], ["Claude Code", 18718, "ttys003"]], "oldest first; the restarted session and unrelated node processes left out");
  assert.deepEqual(staleSessions(parsePs(PS), { installedAt: NaN }), []);
  assert.match(formatStaleSessions(stale, { now: installedAt })[1], /^  Claude Code on ttys003, started Sat 9:56 PM \(\d+[hd] ago\), pid 18718$/);
});

test("appName and platforms without ps", () => {
  assert.equal(appName("/Applications/Cursor.app/Contents/MacOS/Cursor Helper"), "Cursor");
  assert.equal(appName("claude --resume"), "Claude Code");
  assert.equal(listProcesses({ platform: "win32" }), null);
  assert.equal(listProcesses({ platform: "darwin", run: () => ({ status: 1, stdout: "" }) }), null);
});
