import fs from "node:fs";
import path from "node:path";
import { registerJobWorktree, assertRegisteredWorktree } from "./worktree-pointer.mjs";
import { coordinatorCommitMessage, wrapText } from "./git-record.mjs";

// ---------------------------------------------------------------------------
// local_worker_commit: the General commits a job the coordinator held back
// only because of the worker's own claim (STATUS partial or blocked, or an
// unrecoverable report) while nomArmy's independent verification passed.
//
// Before this, the only way to get such a job committed was a second job told
// to "change nothing and report done", which cost a worker turn and was then
// flagged "report contradicts diff". The acceptance decision was always the
// General's; this lets it act on that decision directly.
//
// Nothing here trusts the worker or the General's say-so about the bytes:
// the job record must say the job was eligible when it finished (every
// mechanical gate of the done path held, see generalCommitEligibility), the
// worktree pointer must still be the one nomArmy sealed, and the worktree must
// hash to the fingerprint taken right after verification. Anything else is
// refused, and the General can dispatch a continue_from job instead.
// ---------------------------------------------------------------------------

export const GENERAL_COMMIT_REASON_MIN = 10;

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** Why the General can't commit this job, or null when it can. */
export function generalCommitProblem(meta) {
  if (!meta) return "no finished job record (metadata.json); a running or failed job can't be committed";
  if ((meta.mode ?? "implement") !== "implement") return `a ${meta.mode} job has nothing to commit`;
  if (meta.commit?.created) return `already committed (${meta.commit.sha}${meta.commit.by === "general" ? ", by the General" : ""})`;
  const eligibility = meta.generalCommit;
  if (!eligibility) return "this job's record has no commit eligibility (it predates local_worker_commit, or it had no uncommitted change)";
  if (!eligibility.eligible) return eligibility.reason || "not eligible";
  if (!eligibility.fingerprint?.sha256) return "no worktree fingerprint was recorded after verification";
  if (!meta.worktree || !fs.existsSync(meta.worktree)) return "the job's worktree no longer exists";
  return null;
}

export async function commitVerifiedJob({ jobsRoot, projectDir, jobId, reason, git, createCoordinatorCommit, worktreeFingerprint, now = () => new Date() }) {
  const id = path.basename(String(jobId ?? ""));
  const jobDir = path.join(jobsRoot, id), metaPath = path.join(jobDir, "metadata.json");
  const why = String(reason ?? "").replace(/\s+/g, " ").trim();
  if (why.length < GENERAL_COMMIT_REASON_MIN) throw new Error(`give a reason of at least ${GENERAL_COMMIT_REASON_MIN} characters: what you reviewed and why it's acceptable (it goes in the commit message)`);
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { /* reported below */ }
  const problem = generalCommitProblem(meta);
  if (problem) throw new Error(`can't commit ${id}: ${problem}`);

  const worktree = meta.worktree;
  // The pointer nomArmy sealed at creation, then the registry check every
  // other worktree operation uses: a rewritten .git file never reaches git.
  registerJobWorktree(meta, { worktree, repoRoot: projectDir });
  assertRegisteredWorktree(worktree);
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], worktree)).trim();
  if (meta.branch && branch !== meta.branch) throw new Error(`can't commit ${id}: the worktree is on ${branch}, not the job's branch ${meta.branch}`);
  const current = await worktreeFingerprint(worktree);
  const expected = meta.generalCommit.fingerprint;
  if (current.head !== expected.head) throw new Error(`can't commit ${id}: the job branch moved since verification (HEAD ${current.head}, verified on ${expected.head})`);
  if (current.sha256 !== expected.sha256) throw new Error(`can't commit ${id}: the worktree changed after nomArmy verified it, so a commit wouldn't be the verified change. Dispatch a continue_from job to finish it instead`);

  // The review goes in the body, ahead of the trailers, so git still reads
  // the nomArmy-* lines as trailers.
  const base = coordinatorCommitMessage({ task: meta.objective ?? "", note: meta.reportValidation?.note ?? null, jobId: id, workerId: meta.workerId ?? null,
    provider: meta.worker?.provider ?? null, model: meta.worker?.model ?? null, continuedFrom: meta.continuedFrom?.jobId ?? null });
  const split = base.lastIndexOf("\n\nnomArmy-Job:");
  const message = [base.slice(0, split), "", ...wrapText(`General review: ${why}`, 72), base.slice(split + 1),
    `nomArmy-Accepted-By: General (worker reported ${meta.outcome}; independent verification passed)`].join("\n");
  const commit = await createCoordinatorCommit({ cwd: worktree, jobId: id, outcome: { commitAllowed: true, recovered: Boolean(meta.recovered) }, message });
  if (!commit.created) throw new Error(`can't commit ${id}: ${commit.reason}`);

  const at = now().toISOString();
  const updated = {
    ...meta,
    commit: { ...commit, by: "general", reason: why, at },
    generalCommit: { ...meta.generalCommit, committedAt: at, sha: commit.sha },
    coordinatorStatus: "complete",
    issues: (meta.issues ?? []).filter((issue) => !/^repository changes remain uncommitted/.test(String(issue))),
  };
  writeJsonAtomic(metaPath, updated);
  fs.appendFileSync(path.join(jobDir, "coordinator.log"), `${at} committed by the General (${commit.sha}): ${why}\n`);
  return { jobId: id, branch: meta.branch ?? null, sha: commit.sha, files: commit.stagedFiles ?? [], outcome: meta.outcome, by: "general", reason: why };
}
