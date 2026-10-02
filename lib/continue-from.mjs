// continue_from: a corrective job that starts from a retained job's
// unfinished work, so the finished whole goes through nomArmy's checks.
//
// From a real run: a builder's code was right but came back partial (one
// expected value in its own test was wrong). nomArmy never commits partial
// work, and a new job from the branch couldn't see the uncommitted changes, so
// the General fixed the number by hand and committed the foundation itself,
// outside verification. Now the General dispatches the correction with
// continue_from: the new worktree starts with the old job's changes, and the
// new job's diff, verification and revert check cover all of it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRuntimeJunk } from "./git-record.mjs";
import { assertWorktreePointer, gitSafetyArgs, gitSafetyEnv } from "./worktree-pointer.mjs";
import { removeWorktreeEntry } from "./worktree-write.mjs";

const JOB_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * Why `continueFrom` can't be continued, or null with the retained job's
 * record. Checked at admission, before anything starts.
 * @returns {{ problem: string|null, record: object|null }}
 */
export function continuationProblem({ continueFrom, mode = "implement", baseRef = null, jobsRoot, projectDir, isRunning = () => false }) {
  const refuse = (problem) => ({ problem: `continue_from "${continueFrom}": ${problem}`, record: null });
  if (!JOB_ID_RE.test(String(continueFrom ?? ""))) return refuse("not a job id");
  if (mode !== "implement") return refuse("only an implement job can continue another job's work");
  if (baseRef) return refuse("starts from that job's own base commit; leave base_ref out");
  if (isRunning(continueFrom)) return refuse("that job is still running; wait for it to finish");
  const jobDir = path.join(jobsRoot, continueFrom);
  const record = readJson(path.join(jobDir, "metadata.json"));
  if (!record) return refuse("no finished job by that id (see local_worker_jobs)");
  if (record.mode !== "implement") return refuse(`that job is a ${record.mode} job; only implement work can be continued`);
  if (record.projectDir && path.resolve(record.projectDir) !== path.resolve(projectDir)) return refuse("that job belongs to another repository");
  if (record.commit?.created || record.commit?.sha) return refuse(`its work is already committed on ${record.branch}; start a new job with base_ref: "${record.branch}" instead`);
  const worktree = record.worktree ?? path.join(jobDir, "worktree");
  if (!fs.existsSync(worktree)) return refuse("its worktree is gone (cleaned up), so there's no unfinished work to continue");
  if (!record.git?.baseSha && !record.gitBeforeCoordinatorCommit?.baseSha && !record.baseSha) return refuse("its record has no base commit");
  return { problem: null, record: { ...record, worktree } };
}

/** The retained job's base commit, however its record spells it. */
export function continuationBase(record) {
  return record.git?.baseSha ?? record.gitBeforeCoordinatorCommit?.baseSha ?? record.baseSha;
}

/**
 * Snapshot the retained worktree's changes against its base as a dangling
 * commit, without touching that worktree or its index: a temporary index
 * starts from the base, takes every change (new files and deletions too),
 * and drops runtime junk. Worktrees share one object store, so the new
 * worktree can check the commit out.
 * @returns {Promise<{ commit: string, files: string[] }>}
 */
function guardedGit(git, { worktree, repoRoot, expectedPointer }) {
  return async (args, opts = {}) => {
    assertWorktreePointer({ worktree, expectedBytes: expectedPointer, repoRoot });
    return git([...gitSafetyArgs(), ...args], { ...opts, env: gitSafetyEnv(opts.env ?? process.env) });
  };
}

export async function snapshotRetainedWork({ worktree, baseSha, jobId, git, repoRoot, expectedPointer }) {
  const hostGit = guardedGit(git, { worktree, repoRoot, expectedPointer });
  const indexFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-continue-")), "index");
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    await hostGit(["read-tree", baseSha], { cwd: worktree, env });
    await hostGit(["add", "-A"], { cwd: worktree, env });
    const staged = (await hostGit(["diff", "--cached", "--name-only", "-z", baseSha], { cwd: worktree, env })).split("\0").filter(Boolean);
    const junk = staged.filter(isRuntimeJunk);
    for (const file of junk) await hostGit(["rm", "--cached", "-q", "-r", "--ignore-unmatch", "--", file], { cwd: worktree, env });
    const tree = (await hostGit(["write-tree"], { cwd: worktree, env })).trim();
    const commit = (await hostGit(["commit-tree", tree, "-p", baseSha, "-m", `nomArmy: unfinished work of ${jobId}`], { cwd: worktree, env })).trim();
    return { commit, files: staged.filter((f) => !junk.includes(f)) };
  } finally {
    fs.rmSync(path.dirname(indexFile), { recursive: true, force: true });
  }
}

/**
 * Lay a snapshot into a fresh worktree at the same base as uncommitted
 * changes: the files from the snapshot, deletions removed, index back at the
 * base. The new job's git record then counts them as its own diff.
 */
export async function applyRetainedWork({ worktree, baseSha, commit, git, repoRoot, expectedPointer }) {
  const hostGit = guardedGit(git, { worktree, repoRoot, expectedPointer });
  await hostGit(["checkout", commit, "--", "."], { cwd: worktree });
  const deleted = (await hostGit(["diff", "--name-only", "-z", "--diff-filter=D", baseSha, commit], { cwd: worktree })).split("\0").filter(Boolean);
  for (const file of deleted) removeWorktreeEntry(worktree, path.join(worktree, file));
  await hostGit(["reset", "-q"], { cwd: worktree });
}

/** The brief's note, so the worker builds on the work instead of redoing it. */
export function continuationNote({ continueFrom, record, files }) {
  const listed = files.slice(0, 20).join(", ") + (files.length > 20 ? `, and ${files.length - 20} more` : "");
  // What stopped the work, for the worker: its own NOT DONE, a failed
  // verification, a timeout. Not the notes addressed to the General (review
  // flags, "accept only after an independent review"): a worker handed those
  // took the pending review as its own unfinished task and reported partial.
  const reasons = [];
  const notDone = record.reportValidation?.notDone;
  if (notDone && !/^none\.?$/i.test(String(notDone).trim())) reasons.push(`its worker's NOT DONE: ${notDone}`);
  if (record.independentVerification?.status === "fail") reasons.push(`its verification failed: ${record.independentVerification.detail ?? record.independentVerification.reason ?? "see the job record"}`);
  if (record.outcome === "WORKER_TIMEOUT") reasons.push("it ran out of time");
  if (!reasons.length && record.outcome) reasons.push(`it ended as ${record.outcome}`);
  const why = reasons.map((r) => `- ${String(r).slice(0, 300)}`).join("\n");
  return `This worktree already holds the unfinished work of job ${continueFrom} (${files.length} file(s): ${listed}). Build on it; don't redo it. Your finished diff is verified as a whole, that work included.${why ? `\nThat job stopped because:\n${why}` : ""}`;
}
