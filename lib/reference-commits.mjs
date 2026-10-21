// reference_commits: earlier commits a job's worker reads as patches. The
// sandbox can't read git history (the worktree's .git points outside
// /workspace), so a redo of reviewed work on a newer base had no way to see
// the reviewed commit (BASE-112). The patches are made once, into the job
// directory, then copied into the worktree's .openclaw/, which is never
// committed (lib/git-record.mjs).
import fs from "node:fs";
import path from "node:path";
import { patchText } from "./commit-diff.mjs";

export const REFERENCE_DIR = ".openclaw/reference";
const INDEX = "index.json";

/**
 * Write each reference's patch into <jobDir>/reference. `items` are
 * { ref, review? }: a commit or a job id, and whether it's the job a review
 * scout reviews. `diff(ref)` is lib/commit-diff.mjs's diffFor, bound.
 */
export async function prepareReferences({ items, jobDir, diff }) {
  const dir = path.join(jobDir, "reference");
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const { ref, review = false } of items) {
    const shown = await diff(ref);
    const file = `${review ? "reviewed-" : ""}${shown.jobId ?? shown.sha.slice(0, 12)}.patch`;
    fs.writeFileSync(path.join(dir, file), patchText(shown));
    const subject = shown.jobId ? null : (shown.header ?? "").split("\n").find((line, i, all) => i > 0 && all[i - 1] === "")?.trim() ?? null;
    written.push({ ref, sha: shown.sha, ...(shown.jobId ? { jobId: shown.jobId } : {}), ...(review ? { review: true } : {}), file, subject, files: shown.files.length,
      ...(shown.truncated ? { truncated: true } : {}),
      ...(shown.withheld.length ? { withheld: shown.withheld.map((w) => w.path) } : {}),
      ...(shown.notShown.length ? { notIncluded: shown.notShown } : {}) });
  }
  fs.writeFileSync(path.join(dir, INDEX), JSON.stringify(written, null, 2));
  return written;
}

/** Copy the job's prepared patches into the worktree; [] when the job has none. */
export function placeReferences({ jobDir, worktree }) {
  const dir = path.join(jobDir, "reference");
  let list;
  try { list = JSON.parse(fs.readFileSync(path.join(dir, INDEX), "utf8")); } catch { return []; }
  const target = path.join(worktree, REFERENCE_DIR);
  fs.mkdirSync(target, { recursive: true });
  for (const entry of list) fs.copyFileSync(path.join(dir, entry.file), path.join(target, entry.file));
  return list;
}

/** What the brief says about them. */
export function referenceNote(list) {
  if (!list.length) return "";
  const what = (r) => r.review ? `the change you are reviewing, job ${r.jobId}${r.sha ? ` (commit ${r.sha.slice(0, 12)})` : " (uncommitted)"}, against its base`
    : r.jobId ? `job ${r.jobId}'s change${r.sha ? ` (commit ${r.sha.slice(0, 12)})` : " (uncommitted)"}` : `commit ${r.sha.slice(0, 12)}${r.subject ? ` "${r.subject}"` : ""}`;
  const lines = list.map((r) => `- ${REFERENCE_DIR}/${r.file}: ${what(r)} (${r.files} file${r.files === 1 ? "" : "s"}${r.truncated ? ", TRUNCATED: see the file's header" : ""})${r.withheld?.length ? `; withheld for a possible secret: ${r.withheld.join(", ")}` : ""}${r.notIncluded?.length ? `; over the size cap, not included: ${r.notIncluded.join(", ")}` : ""}`);
  return [
    "",
    "REFERENCE COMMITS",
    "Changes your coordinator handed you as patch files in this workspace (git history isn't available here):",
    ...lines,
    ...(list.some((r) => r.review) ? ["Review against the patch: it shows exactly what the job added, removed and changed, including removed lines and edited test expectations."] : []),
    ...(list.some((r) => !r.review) ? ["To rebuild a change on this newer base, read its patch and make the same change to the current files; the code may have moved, so adapt it rather than forcing a patch that doesn't apply (`patch -p1 --dry-run < <file>` shows whether one still does)."] : []),
    "These files are never committed; don't copy them elsewhere.",
  ].join("\n");
}
