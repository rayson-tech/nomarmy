// Which .nomarmy.yml a job's verification runs. The commands run inside the
// job's worktree, which sits at the job's starting commit, so they have to
// be that commit's: the operator's checkout can be newer (a continue_from
// job keeps its original base; a base_ref job starts wherever it names). In
// BASE-79 the checkout's profile ran `node scripts/ci/quiet-test.mjs`
// against a commit that had no such script, so verification could never
// pass. The starting commit is fixed and outside the worker's diff, so a
// worker still can't change the checks that judge it (the reason the
// contract never comes from the worktree's own copy).
//
// When the base is the checkout's HEAD, the checkout's file is used as is,
// uncommitted edits included, as before. When the base has no file, an
// invalid one, or no such profile, the checkout's is used and the job says so.
import path from "node:path";
import { CONFIG_FILENAMES, configFromText, loadConfig } from "./config.mjs";

export const CONTRACT_FROM_CHECKOUT = "VERIFICATION CONTRACT FROM CHECKOUT";

/**
 * @param {{ projectDir: string, baseSha?: string|null, profile?: string|null,
 *   git: (args: string[]) => Promise<string>, loadCheckout?: typeof loadConfig }} input
 * @returns {Promise<{ loaded: object, source: "checkout"|"base", note: string|null }>}
 */
export async function loadJobContract({ projectDir, baseSha = null, profile = null, git, loadCheckout = loadConfig }) {
  const checkout = (note = null) => ({ loaded: loadCheckout(projectDir), source: "checkout", note });
  if (!baseSha) return checkout();
  let head = null;
  try { head = String(await git(["rev-parse", "HEAD"])).trim(); } catch { /* no HEAD: use the base */ }
  if (head === baseSha) return checkout();
  const short = baseSha.slice(0, 12);
  for (const name of CONFIG_FILENAMES) {
    let text;
    try { text = await git(["show", `${baseSha}:${name}`]); } catch { continue; }
    let loaded;
    try { loaded = configFromText(String(text), path.join(projectDir, name)); }
    catch (error) {
      return checkout(`${CONTRACT_FROM_CHECKOUT}: base ${short}'s ${name} isn't valid for this nomArmy (${String(error.message).split("\n")[0]}), so the checkout's ran; its commands may not match that commit's files`);
    }
    if (profile && !Object.hasOwn(loaded.config?.verification ?? {}, profile)) {
      return checkout(`${CONTRACT_FROM_CHECKOUT}: base ${short} has no verification profile ${profile}, so the checkout's ran; its commands may not match that commit's files`);
    }
    return { loaded, source: "base", note: null };
  }
  return checkout(`${CONTRACT_FROM_CHECKOUT}: base ${short} has no .nomarmy.yml, so the checkout's ran; its commands may not match that commit's files`);
}

/**
 * Admission's note for a job whose base isn't the checkout's HEAD and whose
 * profile there differs from the checkout's (or is missing), or null.
 */
export async function contractAtBaseNote({ projectDir, baseSha, profile, git, label, loadCheckout = loadConfig }) {
  if (!baseSha || !profile) return null;
  let current;
  try { current = loadCheckout(projectDir)?.config?.verification?.[profile]; } catch { return null; }
  const picked = await loadJobContract({ projectDir, baseSha, profile, git, loadCheckout: () => ({ found: true, config: { verification: { [profile]: current } } }) });
  if (picked.source === "checkout" && !picked.note) return null;
  const short = baseSha.slice(0, 12);
  if (picked.note) return `${label} starts at ${short}, which predates the current verification profile ${profile}: it will verify with the checkout's commands, which may not match that commit's files. Redo it on the current head with reference_commits instead`;
  if (JSON.stringify(picked.loaded.config.verification[profile]) === JSON.stringify(current)) return null;
  return `${label} starts at ${short}, whose verification profile ${profile} differs from the checkout's: it verifies with ${short}'s own commands. To verify against the current profile, redo it on the current head with reference_commits`;
}
