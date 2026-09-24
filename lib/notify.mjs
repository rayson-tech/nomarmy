// Desktop notifications from nomArmy itself, so the person watching hears
// about a finished job, a failure or a run limit no matter which
// coordinator (Claude Code, Codex, Cursor) is running the General.
//
// macOS: osascript's `display notification`. Linux: notify-send. Anything
// else, or NOMARMY_NOTIFY=0: nothing. Fire-and-forget: a notification must
// never delay or fail the job that triggered it.

import { spawn } from "node:child_process";

/** An AppleScript string literal: backslashes and double quotes escaped, newlines flattened. */
export function appleScriptString(text) {
  return `"${String(text ?? "").replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The command that would show this notification here, or null. */
export function notificationCommand(title, message, { platform = process.platform, env = process.env } = {}) {
  if (env.NOMARMY_NOTIFY === "0") return null;
  const t = String(title).slice(0, 120), m = String(message).slice(0, 400);
  if (platform === "darwin") return ["osascript", ["-e", `display notification ${appleScriptString(m)} with title ${appleScriptString(t)}`]];
  if (platform === "linux") return ["notify-send", ["--app-name=nomArmy", t, m]];
  return null;
}

export function notify(title, message, { platform, env, run = spawn } = {}) {
  const cmd = notificationCommand(title, message, { platform, env });
  if (!cmd) return false;
  try {
    const child = run(cmd[0], cmd[1], { stdio: "ignore", detached: true });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch { return false; }
}
