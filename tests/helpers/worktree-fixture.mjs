import fs from "node:fs";
import path from "node:path";

// Enough linked-worktree metadata for integrity tests, without running Git.
export function plantWorktreePointer(worktree, repoRoot) {
  const gitdir = path.join(repoRoot, ".git", "worktrees", path.basename(path.dirname(worktree)));
  fs.mkdirSync(gitdir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const bytes = `gitdir: ${gitdir}\n`;
  fs.writeFileSync(path.join(worktree, ".git"), bytes);
  fs.writeFileSync(path.join(gitdir, "gitdir"), `${worktree}/.git\n`);
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/main\n");
  for (const name of ["objects", "refs"]) fs.mkdirSync(path.join(repoRoot, ".git", name), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
  return { gitdir, bytes: Buffer.from(bytes).toString("base64") };
}
