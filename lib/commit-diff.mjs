// One commit's diff (or the diff between two commits), for a General that
// has no shell (commit_show) and for a worker whose sandbox can't read git
// history (reference_commits). Read-only, size-capped, and a file whose diff
// matches a secret rule is withheld whole: the scanner says which rule
// fired, never where, so there's nothing narrower to mask.
import fs from "node:fs";
import path from "node:path";
import { scanTextForSecrets } from "./diff-checks.mjs";
import { isRuntimeJunk } from "./git-record.mjs";
import { registeredWorktree, registerJobWorktree } from "./worktree-pointer.mjs";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const COMMIT_SHOW_MAX_BYTES = 60000;
export const REFERENCE_MAX_BYTES = 200000;

/** The full SHA of `ref` as a commit in this repository, or an Error saying it isn't one. */
export async function resolveCommit(git, ref) {
  try {
    const sha = String(await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
    if (/^[0-9a-f]{40,64}$/.test(sha)) return sha;
  } catch { /* falls through */ }
  throw new Error(`"${ref}" is not a commit in this repository`);
}

/**
 * @param {{ git: (args: string[]) => Promise<string>, ref: string, base?: string|null, paths?: string[], maxBytes?: number, scan?: typeof scanTextForSecrets }} input
 * @returns {Promise<{ sha: string, base: string, header: string|null, files: object[], diff: string, bytes: number, truncated: boolean, notShown: string[], withheld: object[] }>}
 */
export async function commitDiff({ git, ref, base = null, paths = [], maxBytes = COMMIT_SHOW_MAX_BYTES, scan = scanTextForSecrets }) {
  const sha = await resolveCommit(git, ref);
  // A single commit is compared with its first parent (a root commit with
  // the empty tree), so a merge shows what it brought in, not a combined diff.
  let from;
  if (base) from = await resolveCommit(git, base);
  else {
    try { from = String(await git(["rev-parse", "--verify", "--quiet", `${sha}^1`])).trim() || EMPTY_TREE; }
    catch { from = EMPTY_TREE; }
  }
  const header = base ? null : String(await git(["show", "-s", "--format=commit %H%nAuthor: %an%nDate:   %aI%n%n%B", sha])).trim();
  const scope = paths.length ? ["--", ...paths] : [];
  const files = String(await git(["diff", "--numstat", "--no-renames", from, sha, ...scope])).split("\n").filter(Boolean).map((line) => {
    const [added, deleted, ...name] = line.split("\t");
    return { path: name.join("\t"), additions: added === "-" ? null : Number(added), deletions: deleted === "-" ? null : Number(deleted) };
  });
  const parts = [], notShown = [], withheld = [];
  let bytes = 0;
  for (const file of files) {
    const patch = String(await git(["diff", "--no-renames", "--no-color", from, sha, "--", file.path]));
    const rules = await scan(patch, file.path);
    if (rules.length) { withheld.push({ path: file.path, rules }); continue; }
    const size = Buffer.byteLength(patch);
    if (bytes + size > maxBytes) { notShown.push(file.path); continue; }
    parts.push(patch.endsWith("\n") ? patch : `${patch}\n`);
    bytes += size;
  }
  return { sha, base: from, header, files, diff: parts.join(""), bytes, truncated: notShown.length > 0, notShown, withheld };
}

const JOB_ID = /^[A-Za-z0-9._-]{1,120}$/;

/** A finished job's record when `ref` names one, else null. */
export function readJobRecord(jobsRoot, ref) {
  if (!jobsRoot || !JOB_ID.test(String(ref))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(jobsRoot, ref, "metadata.json"), "utf8")); } catch { return null; }
}

/**
 * What a job changed, against the base it started from: its commit when it
 * made one, otherwise its retained worktree's uncommitted changes (a job
 * held for review). `gitIn(cwd)` returns a git(args) for that directory.
 */
export async function jobDiff({ gitIn, projectDir, record, paths = [], maxBytes = COMMIT_SHOW_MAX_BYTES, scan = scanTextForSecrets, registerWorktree = () => {} }) {
  const baseSha = record.git?.baseSha ?? record.baseSha ?? null;
  const label = `job ${record.jobId} (${record.outcome ?? "unknown outcome"})`;
  if (record.commit?.created && record.commit.sha) {
    const shown = await commitDiff({ git: gitIn(projectDir), ref: record.commit.sha, base: baseSha, paths, maxBytes, scan });
    return { ...shown, header: `${label}, commit ${shown.sha} on ${record.branch ?? "its branch"}, against its base ${shown.base}` };
  }
  if (!record.worktree || !baseSha || !fs.existsSync(record.worktree)) {
    throw new Error(`${label} made no commit and its worktree is gone, so there is no diff to show`);
  }
  // nomArmy runs git in a job worktree only once it's registered as that
  // job's (lib/worktree-pointer.mjs); a fresh process hasn't seen it yet.
  registerWorktree(record);
  const git = gitIn(record.worktree);
  const scope = paths.length ? ["--", ...paths] : [];
  const tracked = String(await git(["diff", "--numstat", "--no-renames", baseSha, ...scope])).split("\n").filter(Boolean).map((line) => {
    const [added, deleted, ...name] = line.split("\t");
    return { path: name.join("\t"), additions: added === "-" ? null : Number(added), deletions: deleted === "-" ? null : Number(deleted) };
  });
  const untracked = String(await git(["ls-files", "--others", "--exclude-standard", "-z", ...scope])).split("\0").filter((f) => f && !isRuntimeJunk(f));
  const files = [...tracked, ...untracked.map((f) => ({ path: f, additions: null, deletions: 0, untracked: true }))];
  const parts = [], notShown = [], withheld = [];
  let bytes = 0;
  for (const file of files) {
    let patch;
    if (file.untracked) {
      const text = fs.readFileSync(path.join(record.worktree, file.path), "utf8");
      const lines = text.split("\n"); if (lines.at(-1) === "") lines.pop();
      file.additions = lines.length;
      patch = `diff --git a/${file.path} b/${file.path}\nnew file\n--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
    } else patch = String(await git(["diff", "--no-renames", "--no-color", baseSha, "--", file.path]));
    const rules = await scan(patch, file.path);
    if (rules.length) { withheld.push({ path: file.path, rules }); continue; }
    const size = Buffer.byteLength(patch);
    if (bytes + size > maxBytes) { notShown.push(file.path); continue; }
    parts.push(patch.endsWith("\n") ? patch : `${patch}\n`);
    bytes += size;
  }
  return { sha: null, base: baseSha, header: `${label}, uncommitted changes in its retained worktree, against its base ${baseSha}`,
    files, diff: parts.join(""), bytes, truncated: notShown.length > 0, notShown, withheld };
}

/** A job id or a commit: the job's diff, or the commit's. */
export async function diffFor({ ref, gitIn, projectDir, jobsRoot, base = null, paths = [], maxBytes, scan = scanTextForSecrets, registerWorktree }) {
  const record = base ? null : readJobRecord(jobsRoot, ref);
  if (record) return { ...(await jobDiff({ gitIn, projectDir, record, paths, maxBytes, scan, registerWorktree })), jobId: record.jobId };
  return commitDiff({ git: gitIn(projectDir), ref, base, paths, maxBytes, scan });
}

/** commitDiff as one patch file: header, then the diff, then what was left out and why. */
export function patchText(shown) {
  const notes = [
    ...(shown.truncated ? [`# TRUNCATED: ${shown.notShown.length} file(s) over the size cap are not included; pass paths to narrow it`] : []),
    ...shown.withheld.map((w) => `# withheld ${w.path}: it matches a secret rule (${w.rules.join(", ")})`),
    ...shown.notShown.map((p) => `# not included ${p}: over the size cap`),
  ];
  const head = shown.header ? shown.header.split("\n").map((line) => `# ${line}`.trimEnd()).join("\n") + "\n" : `# diff ${shown.base}..${shown.sha}\n`;
  return `${head}${notes.length ? `${notes.join("\n")}\n` : ""}\n${shown.diff}`;
}

/** registerWorktree for jobDiff: the job's own record proves the worktree is its. */
export function registerJobRecordWorktree(projectDir) {
  return (record) => { if (record.worktree && !registeredWorktree(record.worktree)) registerJobWorktree(record, { worktree: record.worktree, repoRoot: projectDir }); };
}
