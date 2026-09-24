// Desktop notifications from nomArmy itself, so the person watching hears
// about a finished job, a failure or a run limit no matter which
// coordinator (Claude Code, Codex, Cursor) is running the General.
//
// macOS: nomArmy.app (lib/notifier-app.mjs), which shows nomArmy's own icon,
// or osascript's `display notification` when the app isn't built (that one
// shows Script Editor's icon). Linux: notify-send. Anything else, or
// NOMARMY_NOTIFY=0: nothing. Fire-and-forget: a notification must never
// delay or fail the job that triggered it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { notifierPaths, stateRoot } from "./notifier-app.mjs";

/** An AppleScript string literal: backslashes and double quotes escaped, newlines flattened. */
export function appleScriptString(text) {
  return `"${String(text ?? "").replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The command that would show this notification here, or null. */
export function notificationCommand(title, message, { platform = process.platform, env = process.env, app = null } = {}) {
  if (env.NOMARMY_NOTIFY === "0") return null;
  const t = String(title).slice(0, 120), m = String(message).slice(0, 400);
  if (platform === "darwin" && app) return ["open", ["-g", app.app, "--args", app.spool]];
  if (platform === "darwin") return ["osascript", ["-e", `display notification ${appleScriptString(m)} with title ${appleScriptString(t)}`]];
  if (platform === "linux") return ["notify-send", ["--app-name=nomArmy", t, m]];
  return null;
}

/** The built notifier app, or null. */
export function notifierApp(root = stateRoot()) {
  const p = notifierPaths(root);
  return fs.existsSync(p.binary) ? p : null;
}

/**
 * Queue one notification for nomArmy.app: title and message on two lines,
 * written under a temp name and renamed, so the app never reads half a file.
 */
export function spoolNotification(spool, title, message) {
  fs.mkdirSync(spool, { recursive: true });
  // A notifier that can't run (denied, broken) mustn't let the folder grow.
  try { if (fs.readdirSync(spool).length > 50) return false; } catch { /* fresh */ }
  const flat = (s, n) => String(s ?? "").replace(/[\r\n]+/g, " ").slice(0, n);
  const name = `${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  const tmp = path.join(spool, `${name}.part`);
  fs.writeFileSync(tmp, `${flat(title, 120)}\n${flat(message, 400)}\n`);
  fs.renameSync(tmp, path.join(spool, `${name}.txt`));
  return true;
}

export function notify(title, message, { platform = process.platform, env = process.env, run = spawn, root = stateRoot(env) } = {}) {
  if (env.NOMARMY_NOTIFY === "0") return false;
  let app = platform === "darwin" ? notifierApp(root) : null;
  try { if (app && !spoolNotification(app.spool, title, message)) return false; } catch { app = null; }
  const cmd = notificationCommand(title, message, { platform, env, app });
  if (!cmd) return false;
  try {
    const child = run(cmd[0], cmd[1], { stdio: "ignore", detached: true });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch { return false; }
}
