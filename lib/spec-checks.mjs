// The spec-gap checks of a finished implement job, in one place: removed or
// loosened assertions (lib/assertions.mjs), the surface map
// (lib/surface-map.mjs), the scope guard (lib/scope-guard.mjs) and the
// reload prompt (lib/reload-check.mjs). Each reads only the Git record and
// the worktree; none runs the worker's code. A check that fails to run says
// so in its own note and never blocks a commit by crashing.

import { assertionChanges, assertionVerdict } from "./assertions.mjs";
import { ACCOUNTING_FILE, accountFor, changedSurface, surfaceUses, surfaceVerdict } from "./surface-map.mjs";
import { scopeVerdict, unrequestedChanges } from "./scope-guard.mjs";
import { reloadCheck } from "./reload-check.mjs";

const MAX_FILES = 200;
const MAX_TEXT = 1_000_000;

/**
 * @param {object} p
 * @param {object} p.record collectGitRecord() before the commit
 * @param {(file: string) => Promise<string>} p.diffOf `git diff -U0 base -- file`
 * @param {(file: string) => Promise<string|null>} p.readBase the file at the base commit
 * @param {(file: string) => string|null} p.readHead the file in the worktree (no symlinks)
 * @param {(name: string) => object} p.references whole-word uses in the worktree
 * @param {(file: string) => boolean} p.isTestPath
 * @param {string} p.brief task, acceptance and evidence
 * @param {string} p.note the worker's NOTE
 * @param {boolean} p.allowTestRemoval
 */
export async function runSpecChecks({ record, diffOf, readBase, readHead, references, isTestPath, brief = "", note = "", allowTestRemoval = false, skip = [] }) {
  const notes = [];
  const entries = (record?.nameStatus ?? []).slice(0, MAX_FILES);
  if ((record?.nameStatus ?? []).length > MAX_FILES) notes.push(`spec checks read the first ${MAX_FILES} changed files only`);
  const clip = (t) => (t != null && t.length > MAX_TEXT ? null : t);
  const files = [];
  for (const e of entries) {
    const status = e.status[0];
    const f = { file: e.path, status, diff: "", content: null, headText: null, baseText: null };
    try {
      if (status === "A") f.content = f.headText = clip(readHead(e.path));
      else if (status === "D") f.content = f.baseText = clip(await readBase(e.path));
      else {
        f.diff = await diffOf(e.path);
        f.headText = clip(readHead(e.path));
        f.baseText = clip(await readBase(e.oldPath ?? e.path));
      }
    } catch (error) { notes.push(`${e.path}: not read (${String(error?.message ?? error).slice(0, 120)})`); }
    files.push(f);
  }
  const tests = files.filter((f) => isTestPath(f.file));
  const production = files.filter((f) => !isTestPath(f.file));
  let accounting = "";
  try { accounting = readHead(ACCOUNTING_FILE) ?? ""; } catch { /* none written */ }
  const accountingText = `${accounting}\n${note ?? ""}`;
  const out = { notes };

  if (!skip.includes("assertions")) {
    try {
      out.assertions = assertionChanges(tests.map((f) => ({ file: f.file, status: f.status, diff: f.diff, content: f.content })));
      out.assertionVerdict = assertionVerdict(out.assertions, { allowTestRemoval });
    } catch (error) { notes.push(`assertion check failed to run: ${error.message}`); }
  }
  let eventsChanged = false;
  if (!skip.includes("surface")) {
    try {
      const forSurface = production.filter((f) => f.status !== "A" || f.headText);
      eventsChanged = forSurface.some((f) => changedSurface(f).events.length > 0);
      const items = surfaceUses({ files: forSurface, changedFiles: files.flatMap((f) => [f.file]), references, isTestPath });
      const unaccounted = accountFor(items, accountingText);
      out.surface = { items, unaccounted, accounting: accounting ? ACCOUNTING_FILE : null };
      out.surfaceVerdict = surfaceVerdict(items, unaccounted);
    } catch (error) { notes.push(`surface map failed to run: ${error.message}`); }
  }
  if (!skip.includes("scope")) {
    try {
      out.unrequested = unrequestedChanges({ files: production.filter((f) => f.diff).map((f) => ({ file: f.file, diff: f.diff })), brief });
      out.scopeVerdict = scopeVerdict(out.unrequested);
    } catch (error) { notes.push(`scope guard failed to run: ${error.message}`); }
  }
  if (!skip.includes("reload")) {
    try { out.reload = reloadCheck({ files, isTestPath, eventsChanged, accountingText }); }
    catch (error) { notes.push(`reload check failed to run: ${error.message}`); }
  }
  return out;
}

/**
 * Fold the checks into the outcome: removed assertions refuse the commit
 * (unless allowed), the rest raise review. Unrequested changes are their own
 * section, separate from the main diff.
 */
export function applySpecChecks(outcome, checks, { done = [] } = {}) {
  if (!checks) return outcome;
  let next = { ...outcome, reasons: [...(outcome.reasons ?? [])] };
  const flag = (line) => { next.reviewRequired = true; next.reasons.push(line); };
  const a = checks.assertionVerdict;
  if (a) {
    flag(`ASSERTIONS ${a.block ? "REMOVED" : "REMOVED (ALLOWED)"}: ${a.reason}:\n${a.lines.map((l) => `  - ${l}`).join("\n")}`);
    if (a.block) {
      const why = `test assertions removed or loosened: ${a.reason}`;
      next = { ...next, ...(done.includes(next.outcome) ? { outcome: "NEEDS_REVIEW" } : {}), commitBlockedReason: next.commitAllowed ? why : next.commitBlockedReason ?? why, commitAllowed: false };
    }
  }
  if (checks.surfaceVerdict) flag(`SURFACE NOT ACCOUNTED FOR: ${checks.surfaceVerdict.reason}`);
  if (checks.reload && !checks.reload.satisfied) flag(`RELOAD NOT COVERED: ${checks.reload.reason}`);
  if (checks.scopeVerdict) flag(`UNREQUESTED CHANGES: ${checks.scopeVerdict.reason}`);
  return next;
}

/** The compact record kept on the job. */
export function specChecksRecord(checks) {
  if (!checks) return null;
  const found = checks.assertions?.removed?.length || checks.assertions?.loosened?.length || checks.surface?.items?.length
    || checks.unrequested?.length || checks.reload || checks.notes?.length;
  if (!found) return null;
  return {
    assertions: checks.assertions ? { removed: checks.assertions.removed, loosened: checks.assertions.loosened, moved: checks.assertions.moved, replaced: checks.assertions.replaced, blocked: Boolean(checks.assertionVerdict?.block) } : null,
    surface: checks.surface ? { uses: checks.surface.items, unaccounted: checks.surface.unaccounted, accounting: checks.surface.accounting } : null,
    unrequestedChanges: checks.unrequested ?? null,
    reload: checks.reload ?? null,
    ...(checks.notes.length ? { notes: checks.notes } : {}),
  };
}
