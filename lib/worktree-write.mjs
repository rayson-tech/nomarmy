import fs from "node:fs";
import path from "node:path";

// Host restores used to call writeFileSync, which follows symlinks. A sandbox
// can swap the file (or a parent directory) for a symlink to a host path
// between verify and the restore. Walk from the worktree root with lstat,
// refuse any symlinked component, and open the final path with O_NOFOLLOW.

export class WorktreeWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorktreeWriteError";
    this.restoreFailed = true;
  }
}

function lexicalInside(root, full) {
  const rootResolved = path.resolve(root);
  const target = path.resolve(full);
  const rel = path.relative(rootResolved, target);
  if (!rel || (rel === ".." || rel.startsWith(`..${path.sep}`)) || path.isAbsolute(rel)) {
    throw new WorktreeWriteError(`refusing path outside worktree: ${full}`);
  }
  return { rootResolved, parts: rel.split(path.sep) };
}

function walkParents(root, full, { createParents }) {
  const { rootResolved, parts } = lexicalInside(root, full);
  let current = rootResolved;
  const rootStat = fs.lstatSync(current);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new WorktreeWriteError(`refusing symlinked or non-directory worktree root ${current}`);
  for (let i = 0; i < parts.length - 1; i++) {
    current = path.join(current, parts[i]);
    let st;
    try { st = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== "ENOENT" || !createParents) {
        throw new WorktreeWriteError(`refusing missing parent ${current}`);
      }
      fs.mkdirSync(current);
      st = fs.lstatSync(current);
    }
    if (st.isSymbolicLink()) throw new WorktreeWriteError(`refusing symlinked parent ${current}`);
    if (!st.isDirectory()) throw new WorktreeWriteError(`refusing non-directory parent ${current}`);
  }
  return path.join(current, parts[parts.length - 1]);
}

function openNoFollow(finalPath, flags, mode) {
  try { return fs.openSync(finalPath, flags, mode); }
  catch (error) {
    if (error.code === "ELOOP" || error.code === "EPERM") {
      try { if (fs.lstatSync(finalPath).isSymbolicLink()) fs.unlinkSync(finalPath); } catch { /* already gone */ }
      throw new WorktreeWriteError(`refusing symlink at ${finalPath}; removed without following`);
    }
    throw error;
  }
}

/**
 * Write `data` to `full` inside `root`. A symlink at the target is removed
 * and the write fails; it is never followed. Symlinked parents fail too.
 */
export function writeWorktreeFile(root, full, data, { mode } = {}) {
  if (!root) throw new WorktreeWriteError("refusing worktree write without a root");
  const finalPath = walkParents(root, full, { createParents: true });
  let st = null;
  try { st = fs.lstatSync(finalPath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (st?.isSymbolicLink()) {
    fs.unlinkSync(finalPath);
    throw new WorktreeWriteError(`refusing symlink at ${finalPath}; removed without following`);
  }
  if (st && !st.isFile()) throw new WorktreeWriteError(`refusing non-regular file at ${finalPath}`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0);
  const fd = openNoFollow(finalPath, flags, mode ?? 0o666);
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;
    while (offset < buf.length) offset += fs.writeSync(fd, buf, offset);
    if (mode != null && process.platform !== "win32") fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

/** Remove a worktree path without following a symlink at the target or any parent. */
export function removeWorktreeEntry(root, full) {
  if (!root) throw new WorktreeWriteError("refusing worktree remove without a root");
  const finalPath = walkParents(root, full, { createParents: false });
  let st;
  try { st = fs.lstatSync(finalPath); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (st.isSymbolicLink() || st.isFile()) {
    fs.unlinkSync(finalPath);
    return;
  }
  if (st.isDirectory()) {
    fs.rmSync(finalPath, { recursive: true, force: true });
    return;
  }
  throw new WorktreeWriteError(`refusing to remove non-file ${finalPath}`);
}

/** Check every component, including the leaf, before host filesystem access. */
export function assertWorktreePath(root, full, { allowMissing = false } = {}) {
  const finalPath = walkParents(root, full, { createParents: false });
  try {
    if (fs.lstatSync(finalPath).isSymbolicLink()) throw new WorktreeWriteError(`refusing symlink at ${finalPath}`);
  } catch (error) { if (!(allowMissing && error.code === "ENOENT")) throw error; }
  return finalPath;
}

/** Capture contents and mode through one no-follow descriptor. Missing is null. */
export function readWorktreeFile(root, full) {
  if (!root) throw new WorktreeWriteError("refusing worktree read without a root");
  let fd;
  try {
    const finalPath = assertWorktreePath(root, full, { allowMissing: true });
    fd = fs.openSync(finalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new WorktreeWriteError(`refusing non-regular file at ${finalPath}`);
    return { content: fs.readFileSync(fd), mode: st.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
