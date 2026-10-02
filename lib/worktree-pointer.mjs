import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { samePath } from "./same-path.mjs";

// A worker worktree's `.git` is a file nomArmy creates, pointing at the
// operator repo's `.git/worktrees/<name>`. Host git trusts whatever that file
// says. Record the exact bytes at creation and refuse to run git unless they
// are still a regular file (not a symlink) with those bytes, and the gitdir
// they name is one of this repo's own worktrees pointing back here.

const registry = new Map();

function registryKeys(worktree) {
  const resolved = path.resolve(worktree);
  const keys = [resolved];
  try {
    const real = fs.realpathSync(resolved);
    if (real !== resolved) keys.push(real);
  } catch { /* a missing path still registers under its resolved spelling */ }
  return keys;
}

export function toPointerBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string" && value.length > 0) return Buffer.from(value, "base64");
  return null;
}

function readRegularFile(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd;
  try { fd = fs.openSync(file, flags); }
  catch (error) {
    if (error.code === "ELOOP" || error.code === "EPERM") return { ok: false, reason: "symlink" };
    if (error.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: `unreadable (${error.code ?? error.message})` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.isSymbolicLink()) return { ok: false, reason: "symlink" };
    if (!st.isFile()) return { ok: false, reason: "not a regular file" };
    return { ok: true, bytes: fs.readFileSync(fd) };
  } finally {
    fs.closeSync(fd);
  }
}

function parseGitdir(bytes, worktree) {
  const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  const line = text.split(/\r?\n/).find((item) => item.startsWith("gitdir:"));
  if (!line) return null;
  const raw = line.slice("gitdir:".length).trim();
  if (!raw) return null;
  return path.resolve(worktree, raw);
}

function realDir(dir) {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

function insideOperatorWorktrees(repoRoot, gitdir) {
  const root = realDir(path.resolve(repoRoot, ".git", "worktrees"));
  let target = path.resolve(gitdir);
  try { target = fs.realpathSync(target); } catch { /* compare the spelling git wrote */ }
  const rel = path.relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  return !rel.includes(path.sep);
}

/**
 * Why this worktree's `.git` pointer cannot be trusted, or null.
 * `expectedBytes` is the Buffer nomArmy read at creation, or its base64 record.
 */
export function worktreePointerProblem({ worktree, expectedBytes, repoRoot }) {
  if (!worktree) return "no worktree";
  if (!repoRoot) return "no operator repository";
  const expected = toPointerBytes(expectedBytes);
  if (!expected) return "no recorded pointer bytes";
  const dotGit = path.join(worktree, ".git");
  let lst;
  try { lst = fs.lstatSync(dotGit); }
  catch (error) {
    if (error.code === "ENOENT") return "missing";
    return `unreadable (${error.code ?? error.message})`;
  }
  if (lst.isSymbolicLink()) return "symlink";
  if (!lst.isFile()) return lst.isDirectory() ? "directory" : "not a regular file";
  const read = readRegularFile(dotGit);
  if (!read.ok) return read.reason;
  if (!expected.equals(read.bytes)) return "bytes mismatch";
  const gitdir = parseGitdir(read.bytes, worktree);
  if (!gitdir) return "pointer is not a gitdir file";
  if (!insideOperatorWorktrees(repoRoot, gitdir)) return "gitdir is not inside the operator repository worktrees directory";
  const backFile = path.join(gitdir, "gitdir");
  let backStat;
  try { backStat = fs.lstatSync(backFile); }
  catch { return "worktree back-reference missing"; }
  if (backStat.isSymbolicLink() || !backStat.isFile()) return "worktree back-reference is not a regular file";
  const backRead = readRegularFile(backFile);
  if (!backRead.ok) return `worktree back-reference ${backRead.reason}`;
  const backPath = path.resolve(gitdir, backRead.bytes.toString("utf8").trim());
  // Git's back-reference names the worktree by the path of its `.git` file.
  const namesWorktree = samePath(backPath, worktree) || samePath(backPath, path.join(worktree, ".git"));
  if (!namesWorktree) return "worktree back-reference does not name this worktree";
  return null;
}

export function assertWorktreePointer(options) {
  const why = worktreePointerProblem(options);
  if (why) throw new Error(`worktree Git pointer integrity failure: ${why}`);
}

/** Read the pointer nomArmy just created. Throws if it is not a regular file. */
export function captureWorktreePointer(worktree) {
  const dotGit = path.join(worktree, ".git");
  let lst;
  try { lst = fs.lstatSync(dotGit); }
  catch (error) {
    throw new Error(`worktree Git pointer integrity failure: ${error.code === "ENOENT" ? "missing" : error.message}`);
  }
  if (lst.isSymbolicLink()) throw new Error("worktree Git pointer integrity failure: symlink");
  if (!lst.isFile()) throw new Error("worktree Git pointer integrity failure: not a regular file");
  const read = readRegularFile(dotGit);
  if (!read.ok) throw new Error(`worktree Git pointer integrity failure: ${read.reason}`);
  return read.bytes;
}

/**
 * Remember a worktree's creation-time pointer so every later host git command
 * there can be checked. Returns the serializable record stored on the job.
 */
export function sealWorktree(worktree, repoRoot) {
  const bytes = captureWorktreePointer(worktree);
  assertWorktreePointer({ worktree, expectedBytes: bytes, repoRoot });
  const record = { expectedBytes: bytes, repoRoot: path.resolve(repoRoot) };
  for (const key of registryKeys(worktree)) registry.set(key, record);
  return { applicable: true, exists: true, kind: "file", bytes: bytes.toString("base64") };
}

export function registerWorktreePointer(worktree, { expectedBytes, repoRoot }) {
  const bytes = toPointerBytes(expectedBytes);
  if (!bytes) throw new Error("worktree Git pointer integrity failure: no recorded pointer bytes");
  const record = { expectedBytes: bytes, repoRoot: path.resolve(repoRoot) };
  for (const key of registryKeys(worktree)) registry.set(key, record);
}

export function registeredWorktree(cwd) {
  if (!cwd) return null;
  for (const key of registryKeys(cwd)) {
    const hit = registry.get(key);
    if (hit) return { worktree: path.resolve(cwd), ...hit };
  }
  return null;
}

let hooksDir = null;
export function gitHooksPath() {
  if (process.platform === "win32") {
    if (!hooksDir) hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-hooks-"));
    return hooksDir;
  }
  return "/dev/null";
}

export function gitSafetyArgs() {
  return ["-c", `core.hooksPath=${gitHooksPath()}`];
}

export function gitSafetyEnv(env = process.env) {
  return { ...env, GIT_CONFIG_NOSYSTEM: "1" };
}

/**
 * Before a host git command in a registered worker or continuation worktree:
 * verify the pointer (throw, so the caller runs no git) and return the
 * defense-in-depth flags. Operator-repo commands are not registered and pass.
 */
export function prepareHostGit(cwd) {
  const registered = registeredWorktree(cwd);
  if (!registered) return null;
  assertWorktreePointer(registered);
  return { argsPrefix: gitSafetyArgs(), env: gitSafetyEnv };
}
