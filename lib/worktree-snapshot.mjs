import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Verification commands may write inside the checkout (tsc -b, fixtures,
// caches). Whatever they leave must not reach the coordinator's commit, which
// stages every changed and untracked file, so the runner puts the worktree
// back the way it found it. Ignored files are left alone: git never stages them.

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

/** Paths git reports as changed or untracked, NUL-separated porcelain v1, renames as both sides. */
function changedPaths(cwd) {
  const parts = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).toString("utf8").split("\0");
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") paths.push(parts[++i]);
  }
  return [...new Set(paths)];
}

function readState(cwd, file) {
  try {
    const stat = fs.lstatSync(path.join(cwd, file));
    if (stat.isSymbolicLink()) return { link: fs.readlinkSync(path.join(cwd, file)) };
    if (!stat.isFile()) return null;
    return { data: fs.readFileSync(path.join(cwd, file)), mode: stat.mode };
  } catch { return { missing: true }; }
}

/** Records the worktree's changed and untracked files; null when cwd isn't a work tree or the changes are too large to keep. */
export function snapshotWorktree(cwd) {
  let paths;
  try { paths = changedPaths(cwd); } catch { return null; }
  const files = new Map();
  let bytes = 0;
  for (const file of paths) {
    const state = readState(cwd, file);
    if (state === null) continue; // A nested repository or directory entry.
    bytes += state.data?.length ?? 0;
    if (bytes > MAX_SNAPSHOT_BYTES) return null;
    files.set(file, state);
  }
  return { cwd, files };
}

function sameState(a, b) {
  if (a.missing || b.missing) return Boolean(a.missing && b.missing);
  if (a.link !== undefined || b.link !== undefined) return a.link === b.link;
  return a.data.equals(b.data);
}

function writeState(cwd, file, state) {
  const target = path.join(cwd, file);
  fs.rmSync(target, { force: true, recursive: true });
  if (state.missing) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (state.link !== undefined) fs.symlinkSync(state.link, target);
  else fs.writeFileSync(target, state.data, { mode: state.mode });
}

/** Undoes what happened in the worktree since the snapshot. Returns the paths it put back. */
export function restoreWorktree(snapshot) {
  if (!snapshot) return [];
  const { cwd, files } = snapshot;
  const restored = new Set();
  let now;
  try { now = changedPaths(cwd); } catch { return []; }
  // Tracked files first: a restored .gitignore changes what counts as untracked.
  const tracked = [];
  for (const file of new Set([...now, ...files.keys()])) {
    const before = files.get(file);
    if (before) {
      const current = readState(cwd, file);
      if (current && sameState(before, current)) continue;
      writeState(cwd, file, before);
      restored.add(file);
    } else if (inHead(cwd, file)) {
      // Clean before verification, so HEAD's version is the original.
      tracked.push(file);
      restored.add(file);
    }
  }
  if (tracked.length) {
    try { git(cwd, ["checkout", "HEAD", "--", ...tracked]); } catch { /* Reported by the caller's own git record. */ }
  }
  try { now = changedPaths(cwd); } catch { return [...restored]; }
  for (const file of now) {
    if (files.has(file) || inHead(cwd, file)) continue;
    fs.rmSync(path.join(cwd, file), { force: true, recursive: true });
    restored.add(file);
  }
  return [...restored];
}

function inHead(cwd, file) {
  try { git(cwd, ["cat-file", "-e", `HEAD:${file}`]); return true; } catch { return false; }
}
