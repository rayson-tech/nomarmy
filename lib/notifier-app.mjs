// Builds nomArmy.app, the macOS notifier (notifier/main.swift), so
// notifications carry nomArmy's icon instead of Script Editor's.
//
// Built on this machine by `nomarmy connect` (swiftc, sips, iconutil and an
// ad-hoc codesign, all part of Xcode's command-line tools), into nomArmy's
// state directory, and only rebuilt when the source or icon changes. Two
// things found live on macOS 26: an AppleScript applet's notifications were
// dropped (it never registered with Notification Center), and macOS refused
// a bundle id it had already seen refused. The bundle id below is the one
// the person was asked about and allowed; changing it asks them again.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const NOTIFIER_BUNDLE_ID = "com.rayson-tech.nomarmy.notifier2";
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** nomArmy's state directory (job records, leases, and the notifier). */
export function stateRoot(env = process.env) {
  return env.NOMARMY_AGENT_STATE || path.join(env.HOME || os.homedir(), ".local", "share", "nomarmy-local-agents");
}
/** Where the notifier app and its spool folder live. */
export function notifierPaths(root = stateRoot()) {
  const dir = path.join(root, "notifier");
  const app = path.join(dir, "nomArmy.app");
  return { dir, app, binary: path.join(app, "Contents", "MacOS", "nomArmy"), spool: path.join(dir, "spool") };
}

export function notifierInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${NOTIFIER_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>nomArmy</string>
  <key>CFBundleDisplayName</key><string>nomArmy</string>
  <key>CFBundleExecutable</key><string>nomArmy</string>
  <key>CFBundleIconFile</key><string>nomArmy</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict></plist>
`;
}

/**
 * Build (or keep) the notifier app. Never throws: a missing toolchain or a
 * failed step leaves notifications on osascript, which still works.
 * @returns {{ status: "built"|"current"|"skipped"|"failed", app?: string, reason?: string }}
 */
export function buildNotifierApp({ nomarmyRoot, root = stateRoot(), platform = process.platform, env = process.env, run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }) } = {}) {
  if (platform !== "darwin") return { status: "skipped", reason: "not macOS" };
  if (env.NOMARMY_NOTIFY === "0") return { status: "skipped", reason: "notifications are off (NOMARMY_NOTIFY=0)" };
  const source = path.join(nomarmyRoot, "notifier", "main.swift"), icon = path.join(nomarmyRoot, "notifier", "nomarmy-icon.png");
  const p = notifierPaths(root);
  let digest;
  try { digest = crypto.createHash("sha256").update(fs.readFileSync(source)).update(fs.readFileSync(icon)).update(notifierInfoPlist()).digest("hex"); }
  catch (error) { return { status: "failed", reason: `notifier source missing: ${error.message}` }; }
  const stamp = path.join(p.app, "Contents", "Resources", "nomarmy-build.sha256");
  try { if (fs.existsSync(p.binary) && fs.readFileSync(stamp, "utf8").trim() === digest) return { status: "current", app: p.app }; } catch { /* rebuild */ }
  // Built beside its final place: a rename from the system temp folder
  // crosses volumes on macOS (EXDEV).
  fs.mkdirSync(p.dir, { recursive: true });
  const work = fs.mkdtempSync(path.join(p.dir, "build-"));
  try {
    const next = path.join(work, "nomArmy.app"), contents = path.join(next, "Contents");
    fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
    fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
    fs.writeFileSync(path.join(contents, "Info.plist"), notifierInfoPlist());
    run("swiftc", ["-O", "-o", path.join(contents, "MacOS", "nomArmy"), source]);
    const iconset = path.join(work, "nomArmy.iconset");
    fs.mkdirSync(iconset);
    for (const s of [16, 32, 128, 256, 512]) {
      run("sips", ["-z", String(s), String(s), icon, "--out", path.join(iconset, `icon_${s}x${s}.png`)]);
      run("sips", ["-z", String(s * 2), String(s * 2), icon, "--out", path.join(iconset, `icon_${s}x${s}@2x.png`)]);
    }
    run("iconutil", ["-c", "icns", iconset, "-o", path.join(contents, "Resources", "nomArmy.icns")]);
    run("codesign", ["--force", "-s", "-", next]);
    fs.writeFileSync(path.join(contents, "Resources", "nomarmy-build.sha256"), `${digest}\n`);
    // Swap in place: same path and bundle id, so the permission the person
    // gave carries over.
    fs.mkdirSync(p.spool, { recursive: true });
    fs.rmSync(p.app, { recursive: true, force: true });
    fs.renameSync(next, p.app);
    try { run(LSREGISTER, ["-f", p.app]); } catch { /* registers on first launch anyway */ }
    return { status: "built", app: p.app };
  } catch (error) {
    return { status: "failed", reason: String(error.stderr ?? error.message).split("\n")[0].slice(0, 200) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
