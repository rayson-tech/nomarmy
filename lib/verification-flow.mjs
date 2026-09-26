import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { collectVerificationArtifacts } from "./verification-artifacts.mjs";

// ---------------------------------------------------------------------------
// Production-file revert/restore helpers. These operate on plain
// {cwd, baseSha, entries} inputs -- no closure over module state -- so they
// can be driven against a base SHA and a worktree's current on-disk state
// without any job bookkeeping.
//
// Exported (unlike createCoordinatorCommit's equivalent private pattern)
// solely so the worker-contract test suite can exercise it directly against
// a real temporary git repository; it is still called only from within this
// module's own handler code, never from outside callers of the MCP server.
// ---------------------------------------------------------------------------

// Buffer-safe: never route file content through gitRaw's string-based stdout,
// which would corrupt binary content on the UTF-8 round-trip (gitRaw
// accumulates child-process stdout via `d.toString()`, i.e. as text).
// Only needed for D-status files (base content must be restored to revert
// a deletion); M/A files only ever need the CURRENT worktree bytes, which
// fs.readFileSync already returns as a Buffer -- no risk there.
export function gitShowBuffer(cwd, sha, relPath) {
  return execFileSync("git", ["show", `${sha}:${relPath}`], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
}
export function gitModeAtBase(cwd, sha, relPath) {
  const out = execFileSync("git", ["ls-tree", sha, "--", relPath], { cwd, encoding: "utf8", timeout: 30000 });
  return out.split(/\s+/, 1)[0] === "100755" ? 0o755 : 0o644;
}

// One plan item per file, everything captured up front before any mutation,
// so a crash mid-loop never leaves us not knowing what we still owe a
// restore. `entries` are nameStatus-shaped records ({status, path, oldPath}).
export function planProductionRevert({ cwd, baseSha, entries }) {
  return entries.map(e => {
    const full = path.join(cwd, e.path);
    const current = fs.existsSync(full) ? { content: fs.readFileSync(full), mode: fs.statSync(full).mode & 0o777 } : null;
    const letter = e.status[0];
    let base = null;
    if (letter === "M" || letter === "D" || letter === "R" || letter === "C") {
      const basePath = e.oldPath ?? e.path;
      try { base = { content: gitShowBuffer(cwd, baseSha, basePath), mode: gitModeAtBase(cwd, baseSha, basePath) }; }
      catch { base = null; }
    }
    return { path: e.path, letter, full, current, base };
  });
}

// "How this file looked before the worker touched it."
export function revertToBase(item) {
  if (item.letter === "A") { fs.rmSync(item.full, { force: true }); return; }
  if (item.letter === "M" || item.letter === "D") {
    if (!item.base) throw new Error(`no base content resolvable for ${item.path}`);
    fs.mkdirSync(path.dirname(item.full), { recursive: true });
    fs.writeFileSync(item.full, item.base.content, { mode: item.base.mode });
    return;
  }
  // R/C: remove the new path (its "A" half). Practically unreachable
  // pre-commit -- git diff --name-status never rename-pairs an untracked
  // path, and workers never run git add -- but handled for completeness.
  fs.rmSync(item.full, { force: true });
}

// "Put back exactly what the worker actually produced." A deterministic
// overwrite, never a merge -- nothing anything else wrote to this path in
// between can produce a conflict; it only gets clobbered back to the
// worker's real bytes, which is the correct outcome.
export function restoreWorkerVersion(item) {
  if (item.current) {
    fs.mkdirSync(path.dirname(item.full), { recursive: true });
    fs.writeFileSync(item.full, item.current.content, { mode: item.current.mode });
  } else {
    fs.rmSync(item.full, { force: true }); // worker had deleted it (letter === "D"); keep it deleted
  }
}

// git's own blob-hashing scheme, so the restore-verification check is
// meaningful even for "file absent" (encoded as a sentinel) without a full
// content diff.
export function blobHash(buf) {
  if (buf === null) return "ABSENT";
  const h = crypto.createHash("sha1");
  h.update(`blob ${buf.length}\0`);
  h.update(buf);
  return h.digest("hex");
}
export function currentBlobHash(full) {
  return fs.existsSync(full) ? blobHash(fs.readFileSync(full)) : blobHash(null);
}

// Selects which jobs from a local_workers batch are eligible to be
// mechanically merged into one union branch: only committed, valid-done
// implement jobs whose changed files are pairwise disjoint from every other
// accepted job's. This is deliberately NOT judgment -- it is set membership,
// checked once, left-to-right, in dispatch order (which `results` is already
// guaranteed to preserve via mapLimit's index-preserving assignment), so the
// same batch outcome always produces the same accept/exclude split.
//
// Uses `git.nameStatus`, not `git.changedFiles`, on purpose: `changedFiles`
// comes from `git diff --name-only`, which for a renamed file reports ONLY
// the new path -- the old path silently vanishes from that list. A job that
// renames a.txt -> b.txt and another job that edits a.txt in place would
// show zero overlap under changedFiles, yet merging both is a real
// modify/delete interaction git's own heuristics would then resolve
// silently. nameStatus (already computed via parseNameStatusZ) keeps the old
// path on every rename/copy entry, so both paths get claimed correctly.
//
// Paths are also compared case-folded (lower-cased) to catch two jobs
// touching what only differs by case (e.g. Utils.js vs utils.js) on a
// case-insensitive filesystem -- git itself would not flag that as a
// conflict at all, since it treats them as fully distinct tree entries, but
// checkout onto a case-insensitive volume can silently collide.
export function selectUnionCandidates(results) {
  const accepted = [], excluded = [], claimed = new Map(); // lower-cased path -> jobId

  for (const r of results) {
    const m = r.manifest;
    if (m.mode !== "implement") {
      excluded.push({ jobId: m.jobId, workerId: m.workerId, reason: `mode "${m.mode}" is not eligible for union` });
      continue;
    }
    if (m.coordinatorStatus !== "complete" || m.commit?.created !== true) {
      excluded.push({ jobId: m.jobId, workerId: m.workerId, reason: `outcome "${m.outcome}" / coordinatorStatus "${m.coordinatorStatus}" is not a committed, valid-done job` });
      continue;
    }
    const nameStatus = m.git?.nameStatus ?? [];
    if (nameStatus.length === 0) {
      excluded.push({ jobId: m.jobId, workerId: m.workerId, reason: "no changed files recorded despite a created commit (unexpected; excluded defensively)" });
      continue;
    }

    const claims = new Set();
    for (const entry of nameStatus) {
      claims.add(entry.path);
      if (entry.oldPath && /^[RC]/.test(entry.status)) claims.add(entry.oldPath);
    }
    const claimsFold = new Set([...claims].map(p => p.toLowerCase()));

    const collisions = [...claimsFold].filter(p => claimed.has(p));
    if (collisions.length > 0) {
      const owners = [...new Set(collisions.map(p => claimed.get(p)))];
      excluded.push({ jobId: m.jobId, workerId: m.workerId, reason: `changed-file overlap with already-accepted job(s) ${owners.join(", ")} on: ${collisions.join(", ")}` });
      continue;
    }

    for (const p of claimsFold) claimed.set(p, m.jobId);
    accepted.push({ jobId: m.jobId, workerId: m.workerId, branch: m.branch, commit: m.commit.sha, claims: [...claims] });
  }
  return { accepted, excluded };
}

export function createVerificationFlow(deps) {
  const { run, git, projectDir, VERSION, collectGitRecord, ensureJobsRoot } = deps;

  // Orchestrates the capture/revert/rerun/restore sequence above into one
  // verdict. `status` here is deliberately the inverse of the underlying
  // rerun's own pass/fail: "pass" means the regression check passed -- coverage
  // is PROVEN, because the rerun (with the fix reverted) FAILED as expected.
  // "fail" means the rerun still passed with the fix gone: no test catches
  // this regression. `rawRerunStatus` carries the underlying run's own actual
  // verdict so the inversion is never ambiguous in the record. A fourth value,
  // "restore_failed", is not an ordinary verdict at all -- it means the
  // worktree may not be provably back to the worker's real edit, which the
  // caller must treat as a hard, unconditional block, never as just another
  // failed check (see the call site in executeImplement).
  async function runRegressionCheck({ cwd, jobId, productionFiles, nameStatus, profile, baseSha, branch, mode }) {
    if (!productionFiles || productionFiles.length === 0) {
      return { status: "not_run", rawRerunStatus: null, basis: "not-applicable", reason: "no production files changed", detail: null };
    }
    const entries = (nameStatus ?? []).filter(e => productionFiles.includes(e.path));
    let plan;
    try { plan = planProductionRevert({ cwd, baseSha, entries }); }
    catch (error) { return { status: "not_run", rawRerunStatus: null, basis: "plan-error", reason: `could not plan production revert: ${error.message}`, detail: null }; }

    // Fingerprint the expected post-restore state BEFORE any mutation -- this
    // is the ground truth "worker's real edit" that must exist again,
    // byte-for-byte, no matter what happens below.
    const expectedAfterRestore = new Map(plan.map(item => [item.full, currentBlobHash(item.full)]));

    const revertErrors = [];
    for (const item of plan) { try { revertToBase(item); } catch (error) { revertErrors.push({ path: item.path, error: error.message }); } }

    let rerun = { status: "not_run", reason: "revert did not complete" };
    if (revertErrors.length === 0) {
      // Local only -- must never be assigned to the manifest's own `git` or
      // `gitBeforeCoordinatorCommit` fields, which describe the real,
      // non-reverted job.
      const revertedRecord = await collectGitRecord({ cwd, baseSha, branch, baseRef: null, jobId });
      rerun = await runIndependentVerification({ profile, cwd, jobId: `${jobId}-regression-check`, baseSha, branch, mode, record: revertedRecord });
    }

    // ALWAYS restore, unconditionally, regardless of what happened above --
    // each file's restore attempted independently so one failure never skips
    // another.
    const restoreErrors = [];
    for (const item of plan) { try { restoreWorkerVersion(item); } catch (error) { restoreErrors.push({ path: item.path, error: error.message }); } }

    const mismatches = [...expectedAfterRestore].filter(([full, hash]) => currentBlobHash(full) !== hash).map(([full]) => full);
    if (restoreErrors.length > 0 || mismatches.length > 0) {
      return { status: "restore_failed", rawRerunStatus: rerun.status, basis: "restore-error",
        reason: `production files may not be fully restored after regression check: ${[...restoreErrors.map(e => e.path), ...mismatches].join(", ")}`, detail: null };
    }
    if (revertErrors.length > 0) {
      return { status: "not_run", rawRerunStatus: null, basis: "revert-error", reason: `failed to revert ${revertErrors.length} file(s): ${revertErrors.map(e => e.path).join(", ")}`, detail: null };
    }
    if (rerun.status === "fail") return { status: "pass", rawRerunStatus: "fail", basis: rerun.basis, reason: "reverting the production change made the same verification profile fail, as expected -- a test catches this regression", detail: rerun.detail };
    if (rerun.status === "pass") return { status: "fail", rawRerunStatus: "pass", basis: rerun.basis, reason: "verification still passed with the production change reverted -- no test demonstrably catches this regression", detail: rerun.detail };
    return { status: "not_run", rawRerunStatus: "not_run", basis: rerun.basis, reason: `regression rerun was inconclusive: ${rerun.reason}`, detail: rerun.detail };
  }

  // ---------------------------------------------------------------------------
  // Independent verification hook.
  // Profile EXECUTION is owned by another component. This module only plumbs the
  // profile name through and consumes a registered runner's verdict. With no
  // runner the honest answer is `not_run` - never a synthesised pass.
  // ---------------------------------------------------------------------------
  let verificationRunner = null;
  function registerVerificationRunner(fn) { verificationRunner = typeof fn === "function" ? fn : null; }
  function normalizeVerification(value, profile = null) {
    const status = ["pass", "fail", "not_run"].includes(value?.status) ? value.status : "not_run";
    return {
      status, profile: value?.profile ?? profile ?? null,
      basis: value?.basis ?? (verificationRunner ? "registered-runner" : "none"),
      reason: value?.reason ?? null, detail: value?.detail ?? null
    };
  }
  async function runIndependentVerification(context) {
    if (!verificationRunner) {
      return normalizeVerification({ status: "not_run", basis: "none",
        reason: "no verification runner registered; profile execution is owned by the verification component" }, context.profile);
    }
    try {
      const value = await verificationRunner(context);
      const normalized = normalizeVerification(value, context.profile);
      // A caller that asks for a log (mode: verify) gets the full output kept.
      if (context.logFile && typeof value?.output === "string") {
        try { fs.writeFileSync(context.logFile, value.output); normalized.log = context.logFile; } catch { /* best-effort */ }
      }
      const jobDir = context.jobDir ?? (context.logFile ? path.dirname(context.logFile) :
        context.jobId && ensureJobsRoot ? path.join(ensureJobsRoot(), context.jobId) : null);
      if (jobDir && context.cwd) {
        try {
          Object.assign(normalized, collectVerificationArtifacts(context.cwd, jobDir));
          if (normalized.artifactsCapped) normalized.detail = [normalized.detail, "artifact collection capped at 200 files / 50 MB"].filter(Boolean).join("; ");
        } catch (error) {
          normalized.artifacts = [];
          normalized.artifactsError = error.message;
        }
      }
      return normalized;
    }
    catch (error) {
      // A crashed runner produced no evidence. `not_run` is the truthful state:
      // it can never promote a recovery to success, and it never fabricates a
      // test failure that did not actually happen.
      return normalizeVerification({ status: "not_run", basis: "runner-error", reason: `verification runner threw: ${error.message}` }, context.profile);
    }
  }


  // Actually performs the union: one new branch, off the same base SHA every
  // accepted job started from, built by sequentially `git merge --no-ff`-ing
  // each accepted job's branch into it. Never merges into the developer's own
  // branch -- this new branch is exactly the same kind of artifact a single
  // job's own branch already is: retained for the frontier to review and
  // integrate explicitly, not integrated automatically by anything here.
  //
  // A merge that fails (should be rare given selectUnionCandidates already
  // enforced disjoint changed files, but git can still refuse on a
  // directory/file-type collision, or a branch that went missing between
  // selection and this call) demotes just that one job to "failed" and
  // continues with the rest -- one bad merge must never discard every other
  // job's already-verified work.
  //
  // Every return path -- including "nothing to union" and "every merge
  // failed" -- returns a plain manifest object rather than throwing, and
  // never deletes a worktree it already created. A caller that wraps this in
  // its own try/catch is still protected against a genuinely unexpected
  // throw (e.g. `git worktree add` itself failing), but every anticipated
  // outcome here is a normal return, not an exception.
  //
  // Exported (unlike createCoordinatorCommit's equivalent private pattern)
  // solely so the worker-contract test suite can exercise it directly against
  // a real temporary git repository; it is still called only from within this
  // module's own handler code, never from outside callers of the MCP server.
  async function buildUnionBranch({ batchId, baseSha, baseRef, accepted, unionVerification }) {
    const unionJobId = `${batchId}-union`, branch = `union/${batchId}`;
    const jobDir = path.join(ensureJobsRoot(), unionJobId), worktree = path.join(jobDir, "worktree");

    if (accepted.length < 2) {
      return { version: VERSION, jobId: unionJobId, mode: "union", batchId, createdAt: new Date().toISOString(),
        status: "no_union",
        reason: accepted.length === 0 ? "no job had a valid, non-overlapping outcome to union" : "only one job had a mergeable outcome; nothing to union -- review its own branch directly",
        baseSha, branch: null, worktree: null, jobsUnioned: [],
        verification: normalizeVerification({ status: "not_run", basis: "not-applicable", reason: "no union branch was formed" }, unionVerification ?? null) };
    }

    fs.mkdirSync(jobDir, { recursive: true });
    await run("git", ["worktree", "add", "-b", branch, worktree, baseSha], { cwd: projectDir });

    const merged = [], failed = [];
    for (const job of accepted) {
      try {
        await git(["merge", "--no-ff", "-m", `merge ${job.branch} (${job.jobId})`, job.branch], worktree);
        merged.push(job);
      } catch (error) {
        await git(["merge", "--abort"], worktree).catch(() => {});
        const stderrMatch = /STDERR:\n([^\n]*)/.exec(error.message);
        failed.push({ jobId: job.jobId, reason: `merge failed: ${stderrMatch?.[1] || error.message.split("\n")[0]}` });
      }
    }

    if (merged.length === 0) {
      return { version: VERSION, jobId: unionJobId, mode: "union", batchId, createdAt: new Date().toISOString(),
        status: "union_failed", baseSha, branch, worktree, jobsUnioned: [], jobsMergeFailed: failed,
        verification: normalizeVerification({ status: "not_run", basis: "not-applicable", reason: "every accepted job failed to merge" }, unionVerification ?? null) };
    }

    const record = await collectGitRecord({ cwd: worktree, baseSha, branch, baseRef, jobId: unionJobId });
    const verification = await runIndependentVerification({ profile: unionVerification ?? null, cwd: worktree, jobId: unionJobId, baseSha, branch, mode: "implement", record });

    const status = verification.status === "fail" ? "union_verification_failed" : failed.length > 0 ? "union_partial" : "unioned";
    const manifest = { version: VERSION, jobId: unionJobId, mode: "union", batchId, createdAt: new Date().toISOString(),
      status, baseSha, branch, worktree,
      jobsUnioned: merged.map(j => ({ jobId: j.jobId, workerId: j.workerId, branch: j.branch, commit: j.commit })),
      jobsMergeFailed: failed, verification, git: record };
    fs.writeFileSync(path.join(jobDir, "metadata.json"), JSON.stringify(manifest, null, 2));
    return manifest;
  }


  return { registerVerificationRunner, normalizeVerification, runIndependentVerification, runRegressionCheck, selectUnionCandidates, buildUnionBranch,
    get verificationRunner() { return verificationRunner; } };
}
