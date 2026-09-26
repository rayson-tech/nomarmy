// Whether the nomArmy a coordinator runs is current. Claude Code, Codex and
// Cursor run a copy of the server that `nomarmy connect` puts in the install
// dir, and each session keeps the code it started with. So an upgrade can
// stall at three points, each checked here:
//
//   nomarmy-update  npm's alpha release is newer than the installed CLI
//   nomarmy-copy    the CLI is newer than the copy coordinators run
//                   (`nomarmy connect` wasn't re-run)
//   restart         the copy on disk changed after this server started
//                   (the session wasn't restarted); per session, so it is
//                   reported by that session's server, not in health.json

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Written into the install dir by `nomarmy connect`: where the copy came from. */
export const SOURCE_FILE = "source.json";

export function readPackageVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? null; }
  catch { return null; }
}

/** The checkout's commit, for a git install; null for an npm install. */
export function readSourceCommit(root) {
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
  catch { return null; }
}

export function recordCopySource(installDir, nomarmyRoot) {
  const commit = readSourceCommit(nomarmyRoot);
  fs.writeFileSync(path.join(installDir, SOURCE_FILE), JSON.stringify({ root: nomarmyRoot, version: readPackageVersion(nomarmyRoot), ...(commit ? { commit } : {}) }, null, 2) + "\n");
}

/**
 * Whether the copy in installDir is behind the checkout or package at
 * nomarmyRoot: an older version, a different commit (a git install moves on
 * without a version bump), or no record of its source at all.
 */
export function copyIsStale(installDir, nomarmyRoot) {
  let source = null;
  try { source = JSON.parse(fs.readFileSync(path.join(installDir, SOURCE_FILE), "utf8")); } catch { return true; }
  const copyVersion = readPackageVersion(installDir), rootVersion = readPackageVersion(nomarmyRoot);
  if (!copyVersion || !rootVersion || copyVersion !== rootVersion) return true;
  const commit = readSourceCommit(nomarmyRoot);
  return Boolean(commit && source.commit !== commit);
}

/** The copy's version and, when connect recorded it, the version now at its source. */
export function readInstallVersions(installDir) {
  let source = null;
  try { source = JSON.parse(fs.readFileSync(path.join(installDir, SOURCE_FILE), "utf8")); } catch { /* connected before source.json existed */ }
  return { copyVersion: readPackageVersion(installDir), sourceVersion: source?.root ? readPackageVersion(source.root) : null };
}

/** Semver order, prerelease included (0.1.0-alpha.7 < 0.1.0-alpha.10 < 0.1.0). */
export function compareVersions(a, b) {
  const split = (v) => { const [main, pre] = String(v).trim().replace(/^v/, "").split("-", 2); return { main: main.split(".").map(Number), pre: pre ? pre.split(".") : null }; };
  const x = split(a), y = split(b);
  for (let i = 0; i < 3; i++) if ((x.main[i] || 0) !== (y.main[i] || 0)) return (x.main[i] || 0) < (y.main[i] || 0) ? -1 : 1;
  if (!x.pre || !y.pre) return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const valid = (v) => typeof v === "string" && /^v?\d+\.\d+\.\d+/.test(v.trim());

/** Health issues for a stale CLI, a stale installed copy, or a copy missing its harnesses. */
export function freshnessIssues({ copyVersion = null, sourceVersion = null, latestVersion = null, copyHarnesses = null }) {
  const issues = [];
  if (valid(copyVersion) && copyHarnesses === 0) {
    issues.push({ id: `nomarmy-harnesses:${copyVersion}`, severity: "error", title: "The nomArmy your coordinators run has no harnesses",
      detail: "Jobs match no harness, so they run in the plain base image: no dependencies, fake services, browser tests or artifacts.",
      fix: "nomarmy connect claude (and codex, cursor), then restart those sessions", short: "no harnesses" });
  }
  if (valid(latestVersion) && valid(sourceVersion) && compareVersions(sourceVersion, latestVersion) < 0) {
    const latest = latestVersion.trim();
    issues.push({ id: `nomarmy-update:${latest}`, severity: "info", title: `nomArmy ${latest} is out (you have ${sourceVersion})`,
      detail: "Updating installs it, reconnects your coordinators and tells you which sessions to restart.",
      fix: "nomarmy update", short: "nomarmy update" });
  }
  if (valid(sourceVersion) && valid(copyVersion) && compareVersions(copyVersion, sourceVersion) < 0) {
    issues.push({ id: `nomarmy-copy:${sourceVersion}`, severity: "warn", title: `Your coordinators run nomArmy ${copyVersion}, but ${sourceVersion} is installed`,
      detail: "Claude Code, Codex and Cursor run a copy of nomArmy that only `nomarmy connect` refreshes.",
      fix: "nomarmy connect claude (and codex, cursor), then restart those sessions", short: "nomarmy reconnect" });
  }
  return issues;
}

/**
 * For the running server: a notice when its copy on disk changed after it
 * started, so this session still runs the old code. Null when current.
 */
export function restartNotice({ serverFile, startedAtMs, runningVersion, stat = fs.statSync, readVersion = readPackageVersion }) {
  let changedMs;
  try { changedMs = stat(serverFile).mtimeMs; } catch { return null; }
  if (!(changedMs > startedAtMs)) return null;
  const onDisk = readVersion(path.join(path.dirname(serverFile), ".."));
  const versions = onDisk && onDisk !== runningVersion ? ` (this session runs ${runningVersion}; ${onDisk} is installed)` : "";
  return `nomArmy was updated after this session started${versions}. Restart this session to use the new version; until then it runs the old code.`;
}
