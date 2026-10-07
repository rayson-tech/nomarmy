import { processErrorSummary } from "./process-error.mjs";

const shellWord = value => /^[A-Za-z0-9_./-]+$/.test(value) && !value.startsWith("-")
  ? value : "'" + value.replace(/'/g, "'\\''") + "'";

// Admission only: no job directories, worktrees, or branch switches. All
// commands use the same run() host-git safeguards as operator-repo calls.
export async function checkBaseRefs(jobs, { run, projectDir }) {
  const problems = [], notes = [], checked = new Map();
  let remotes;
  const git = async args => (await run("git", args, { cwd: projectDir })).stdout;
  for (const [i, job] of jobs.entries()) {
    if (job.base_ref == null || job.continue_from) continue;
    const ref = job.base_ref;
    if (!checked.has(ref)) {
      let problem = null;
      try { await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]); }
      catch {
        let remote = null, branch = null, detail = null;
        try {
          remotes ??= (await git(["remote"])).split(/\r?\n/).filter(Boolean).sort((a, b) => b.length - a.length);
          remote = remotes.find(name => ref.startsWith(name + "/")) ?? null;
          branch = remote ? ref.slice(remote.length + 1) : null;
          if (remote) {
            // Reject revisions, refspecs, options and wildcard patterns.
            try { await git(["check-ref-format", `refs/heads/${branch}`]); }
            catch { remote = null; }
          }
          if (remote) {
            await run("git", ["fetch", "--", remote, branch], {
              cwd: projectDir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 60000,
            });
            await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
            notes.push(`fetched ${ref}`);
          }
        } catch (error) { detail = processErrorSummary(error); }
        if (!remote || detail) {
          const fix = remote
            ? `run: git fetch ${shellWord(remote)} ${shellWord(branch)}`
            : "use a ref present in this checkout, or run: git fetch <remote> <branch>";
          problem = `base_ref ${ref} not found in this checkout; ${fix}${detail ? `; ${detail}` : ""}`;
        }
      }
      checked.set(ref, problem);
    }
    if (checked.get(ref)) problems.push(`${jobs.length > 1 ? `job ${i + 1}: ` : ""}${checked.get(ref)}`);
  }
  return { problems, notes };
}
