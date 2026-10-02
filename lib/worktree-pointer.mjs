import { execFileSync, spawnSync } from "node:child_process";
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
// Windows: git writes long, forward-slash paths while os.tmpdir() can be an
// 8.3 short name, and the filesystem ignores case. Only the native realpath
// expands 8.3 names; comparisons fold case there.
const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
function realPath(p) { return fs.realpathSync.native(p); }

const jobsRoots = new Set();
export function registerJobsRoot(root) {
  if (root) for (const key of registryKeys(root)) jobsRoots.add(key);
}
registerJobsRoot(path.join(process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), ".local", "share", "nomarmy-local-agents"), "jobs"));
function within(root, target) {
  const rel = path.relative(root, target);
  return !rel || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function integrity(reason) { return new Error(`worktree Git pointer integrity failure: ${reason}`); }


function registryKeys(worktree) {
  const resolved = path.resolve(worktree);
  const keys = [fold(resolved)];
  try {
    const real = fold(realPath(resolved));
    if (!keys.includes(real)) keys.push(real);
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
  try { return realPath(dir); } catch { return path.resolve(dir); }
}

function insideOperatorWorktrees(repoRoot, gitdir) {
  const root = realDir(path.resolve(repoRoot, ".git", "worktrees"));
  let target = path.resolve(gitdir);
  try { target = realPath(target); } catch { /* compare the spelling git wrote */ }
  const rel = path.relative(fold(root), fold(target));
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
  try { if (fs.lstatSync(worktree).isSymbolicLink()) return "symlinked worktree root"; }
  catch { return "missing worktree"; }
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
  const record = { worktree: path.resolve(worktree), expectedBytes: bytes, repoRoot: path.resolve(repoRoot) };
  for (const key of registryKeys(worktree)) registry.set(key, record);
  return { applicable: true, exists: true, kind: "file", bytes: bytes.toString("base64") };
}

export function registerWorktreePointer(worktree, { expectedBytes, repoRoot }) {
  const bytes = toPointerBytes(expectedBytes);
  if (!bytes) throw new Error("worktree Git pointer integrity failure: no recorded pointer bytes");
  const record = { worktree: path.resolve(worktree), expectedBytes: bytes, repoRoot: path.resolve(repoRoot) };
  for (const key of registryKeys(worktree)) registry.set(key, record);
}

export function registeredWorktree(cwd) {
  if (!cwd) return null;
  // Match the lexical spelling first, so an escaping symlink cannot turn a
  // worker path into an unchecked operator path.
  for (const key of registryKeys(cwd)) {
    const matches = [...registry].filter(([root]) => within(root, key)).sort((a, b) => b[0].length - a[0].length);
    if (matches.length) return matches[0][1];
  }
  return null;
}

/** Only trusted job records can restore registration, never the live .git. */
export function registerJobWorktree(record, { worktree = record?.worktree, repoRoot = record?.projectDir } = {}) {
  if (!worktree || !repoRoot) throw integrity("no recorded worktree or operator repository");
  const expectedBytes = record?.worktreePointerBefore?.bytes;
  registerWorktreePointer(worktree, { expectedBytes, repoRoot });
  assertWorktreePointer({ worktree, expectedBytes, repoRoot });
  return registeredWorktree(worktree);
}

export function assertRegisteredWorktree(worktree) {
  const registered = registeredWorktree(worktree);
  if (!registered || !registryKeys(worktree).some(key => registryKeys(registered.worktree).includes(key))) throw integrity("unregistered worktree");
  assertWorktreePointer(registered);
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
  return ["-c", `core.hooksPath=${gitHooksPath()}`, "-c", "core.fsmonitor=false"];
}

export function gitSafetyEnv(env = process.env) {
  return { ...env, GIT_CONFIG_NOSYSTEM: "1" };
}

/**
 * Before a host git command in a registered worker or continuation worktree:
 * verify the pointer (throw, so the caller runs no git) and return the
 * defense-in-depth flags. Operator-repo commands are not registered and pass.
 */
export function prepareHostGit(cwd = process.cwd(), args = []) {
  // Removal runs from the operator repo, but its target is worker-controlled.
  const remove = args.indexOf("worktree");
  if (remove >= 0 && args[remove + 1] === "remove") {
    const target = args.slice(remove + 2).find(arg => !arg.startsWith("-"));
    if (target) {
      const full = path.resolve(cwd, target);
      if (registeredWorktree(full) || registryKeys(full).some(key => [...jobsRoots].some(root => within(root, key)))) assertRegisteredWorktree(full);
    }
  }
  const registered = registeredWorktree(cwd);
  if (!registered) {
    if (registryKeys(cwd).some(key => [...jobsRoots].some(root => within(root, key)))) throw integrity("unregistered worktree under jobs root");
    return null;
  }
  assertWorktreePointer(registered);
  const gitdir = parseGitdir(registered.expectedBytes, registered.worktree);
  if (!gitdir || !insideOperatorWorktrees(registered.repoRoot, gitdir)) throw integrity("recorded gitdir is outside operator worktrees");
  return { argsPrefix: [...gitSafetyArgs(), `--git-dir=${realPath(gitdir)}`, `--work-tree=${registered.worktree}`,
    ...(args[0] === "status" ? ["--no-optional-locks"] : [])], env: gitSafetyEnv };
}

export function execHostGitSync(cwd, args, options = {}) {
  const prep = prepareHostGit(cwd, args);
  return execFileSync("git", [...(prep?.argsPrefix ?? []), ...args], { ...options, cwd, env: prep ? prep.env(options.env ?? process.env) : options.env ?? process.env });
}
export function spawnHostGitSync(cwd, args, options = {}) {
  const prep = prepareHostGit(cwd, args);
  return spawnSync("git", [...(prep?.argsPrefix ?? []), ...args], { ...options, cwd, env: prep ? prep.env(options.env ?? process.env) : options.env ?? process.env });
}
