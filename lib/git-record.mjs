import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { classifyTestChanges, mergeUntrackedIntoNameStatus } from "./diff-checks.mjs";

// ---------------------------------------------------------------------------
// Git record parsing
// ---------------------------------------------------------------------------
export function parseStatusPorcelainZ(status) {
  if (!status) return [];
  const records = status.split("\0"), entries = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]; if (!record) continue;
    const match = record.match(/^(.{2}) (.*)$/s);
    if (!match) throw new Error(`Unexpected git status record: ${JSON.stringify(record)}`);
    const code = match[1], file = match[2]; let originalFile = null;
    if (code.includes("R") || code.includes("C")) originalFile = records[++i] || null;
    entries.push({ code, file, originalFile });
  }
  return entries;
}

// `git diff --name-status -z` emits NUL-separated fields: <status> <path>, and
// <status> <old> <new> for renames/copies.
export function parseNameStatusZ(raw) {
  const tokens = String(raw ?? "").split("\0").filter(t => t.length > 0);
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!/^[A-Z]/.test(status)) continue;
    if (/^[RC]/.test(status)) {
      const oldPath = tokens[++i], newPath = tokens[++i];
      if (!newPath) break;
      entries.push({ status, path: newPath, oldPath });
    } else {
      const file = tokens[++i];
      if (!file) break;
      entries.push({ status, path: file, oldPath: null });
    }
  }
  return entries;
}

// Tool caches a job leaves behind, never the worker's work. node_modules/
// .vite and .cache: with a Node dependency image the repo has no
// node_modules of its own, so vitest (and babel, eslint) create one just
// for their cache, which a repo that doesn't gitignore node_modules would
// otherwise commit.
// .npm at any depth: npx run inside a nested package (`cd lambda/x && npx
// tsc`) wrote lambda/x/.npm/_update-notifier-last-checked, and a root-only
// match let it into a real Senti commit.
export function isRuntimeJunk(file) {
  return /(^|\/)\.npm(\/|$)/.test(file) || file === ".openclaw" || file.startsWith(".openclaw/")
    || file.startsWith("node_modules/.vite/") || file.startsWith("node_modules/.cache/")
    // A package's node_modules link into the dependency image
    // (linkNodePackages): git lists a symlink as one entry, never its contents.
    || /(^|\/)node_modules$/.test(file) || /\/node_modules\/\.(vite|cache)\//.test(file);
}

/**
 * The worker branch's commit message, for whoever reviews the PR: what the
 * job set out to do and what the worker says it did. It used to be
 * `chore(local-agent): <job id>`, which a Senti reviewer reworded by hand on
 * every commit. The subject is the General's own `commit_subject` when it
 * gave one, else the task's first sentence (the army role header and an
 * "OBJECTIVE:" label dropped). The job id stays, as a trailer.
 */
export function coordinatorCommitMessage({ task = "", subject = null, note = null, jobId, workerId = null, recovered = false, provider = null, model = null }) {
  const oneLine = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
  let body = String(task ?? "");
  if (/^\[nomArmy role:/.test(body)) body = body.includes("\n\n") ? body.slice(body.indexOf("\n\n") + 2) : "";
  const firstSentence = oneLine(body.replace(/^\s*(objective|task|goal)\s*:\s*/i, "")).split(/(?<=[.!?])\s|:\s(?=[A-Z])/)[0].replace(/[.:;,]+$/, "");
  const clip = (t, max) => (t.length <= max ? t : `${t.slice(0, max).replace(/\s+\S*$/, "")}…`);
  const derived = firstSentence && firstSentence.charAt(0).toUpperCase() + firstSentence.slice(1);
  let head = clip(oneLine(subject) || derived || `nomArmy job ${workerId ?? jobId}`, 72);
  if (recovered) head = clip(`${head}`, 60) + " [recovered]";
  const lines = [head];
  const cleanNote = oneLine(note);
  if (cleanNote) lines.push("", ...wrapText(cleanNote, 72));
  lines.push("", `nomArmy-Job: ${jobId}`);
  if (provider || model) lines.push(`nomArmy-Worker: ${[provider, model].filter(Boolean).join("/")}`);
  return lines.join("\n");
}

export function wrapText(text, width) {
  const out = []; let line = "";
  for (const word of text.split(" ")) {
    if (line && `${line} ${word}`.length > width) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

export function worktreePointerState(worktree) {
  if (!worktree) return { applicable: false, exists: null, kind: null };
  const dotGit = path.join(worktree, ".git"); if (!fs.existsSync(dotGit)) return { applicable: true, exists: false, kind: "missing" };
  const stat = fs.lstatSync(dotGit); return { applicable: true, exists: true, kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other" };
}

export function createGitRecord({ run, git, gitRaw }) {
  async function collectGitRecord({ cwd, baseSha, branch, baseRef, jobId }) {
    const head = await git(["rev-parse", "HEAD"], cwd);
    const status = await gitRaw(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
    const entries = parseStatusPorcelainZ(status);
    const repoStatusFiles = entries.map(x => x.file).filter(f => !isRuntimeJunk(f));
    const ignoredRuntimeJunk = entries.map(x => x.file).filter(isRuntimeJunk);
    const names = (await git(["diff", "--name-only", baseSha, "--"], cwd)).split("\n").filter(Boolean);
    const numstat = (await git(["diff", "--numstat", baseSha, "--"], cwd)).split("\n").filter(Boolean);
    const diffNameStatus = parseNameStatusZ(await gitRaw(["diff", "--name-status", "-z", baseSha, "--"], cwd));
    const untracked = entries.filter(x => x.code === "??").map(x => x.file).filter(f => !isRuntimeJunk(f));
    const nameStatus = mergeUntrackedIntoNameStatus(diffNameStatus, untracked);
    let additions = 0, deletions = 0;
    for (const line of numstat) { const [a, d] = line.split("\t"); if (/^\d+$/.test(a)) additions += Number(a); if (/^\d+$/.test(d)) deletions += Number(d); }
    return { jobId, branch, baseRef, baseSha, head, filesChanged: names.length, additions, deletions,
      dirty: status.length > 0, changedFiles: names, nameStatus, testChanges: classifyTestChanges(nameStatus),
      repoStatusFiles, ignoredRuntimeJunk };
  }

  async function createCoordinatorCommit({ cwd, jobId, outcome, message = null }) {
    if (!outcome.commitAllowed) return { created: false, sha: null, reason: outcome.commitBlockedReason || `outcome ${outcome.outcome} does not permit a commit` };
    const status = await gitRaw(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
    const entries = parseStatusPorcelainZ(status);
    const files = [...new Set(entries.map(x => x.file).filter(f => !isRuntimeJunk(f)))];
    const junk = [...new Set(entries.map(x => x.file).filter(isRuntimeJunk))];
    if (files.length === 0) return { created: false, sha: null, reason: "no repository changes to commit", stagedFiles: [], ignoredRuntimeJunk: junk };
    await run("git", ["add", "--", ...files], { cwd });
    const stagedFiles = (await git(["diff", "--cached", "--name-only"], cwd)).split("\n").filter(Boolean);
    if (!stagedFiles.length) return { created: false, sha: null, reason: "nothing staged after explicit-path staging", stagedFiles: [], ignoredRuntimeJunk: junk };
    const subject = message ?? coordinatorCommitMessage({ jobId, recovered: Boolean(outcome.recovered) });
    try { await run("git", ["commit", "-m", subject], { cwd }); }
    catch (error) { await run("git", ["reset"], { cwd }).catch(() => {}); return { created: false, sha: null, reason: `coordinator commit failed: ${error.message}`, stagedFiles, ignoredRuntimeJunk: junk }; }
    return { created: true, sha: await git(["rev-parse", "HEAD"], cwd), reason: null, recovered: Boolean(outcome.recovered), stagedFiles, ignoredRuntimeJunk: junk };
  }

  // One tick of the idle-diff circuit breaker: has the worktree stopped
  // changing? Never fires before a change has been seen at all (a job that
  // hasn't started editing yet is not idle, it just hasn't started) or before
  // idleMinElapsedMs of the work phase has passed (an early snapshot mid-first-
  // edit looks identical to no edit at all). A worktree read failing mid-write
  // is expected, not an error; it just means "nothing to report this tick."
  function makeIdleDiffTick(cwd, { idleMs, minElapsedMs }) {
    let lastHash = null, lastChangeAtMs = 0, sawChange = false;
    return async elapsedMs => {
      let statusOut;
      try { statusOut = await gitRaw(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd); }
      catch { return { stop: false }; }
      // .npm/, .openclaw/ etc. are the sandbox's own runtime junk (see
      // isRuntimeJunk / collectGitRecord): a worker that has gone idle on the
      // actual objective can still have npm rewriting its cache under
      // /workspace continuously, which changed git status's raw output on
      // every tick and meant the idle-diff hash below never stabilized --
      // observed directly: filesChangedLive stuck reporting a live "change"
      // that was only .npm/. Hash the files that count, not the raw status.
      const relevantFiles = parseStatusPorcelainZ(statusOut).map(e => e.file).filter(f => !isRuntimeJunk(f)).sort();
      // A real, confirmed incident: hashing only the NAMES of changed files
      // (the previous version) cannot tell "still actively editing this file"
      // from "gone idle" -- once a file is already flagged dirty, git status
      // keeps reporting it on every poll regardless of further edits, so the
      // name-list hash never changes again even while a worker keeps making
      // real content edits to that same file. Observed live: a worker made
      // five more genuine, successful patches to a test file after it first
      // appeared in `git status`, methodically debugging it, and the breaker
      // killed the job 9.6 seconds after crossing the idle threshold measured
      // from that file's FIRST appearance -- not from its last real edit, six
      // seconds earlier. Hashing each file's actual current content (not just
      // its name) fixes this: any edit to any relevant file changes the digest.
      const hash = crypto.createHash("sha1");
      for (const file of relevantFiles) {
        hash.update(file);
        hash.update("\0");
        try { hash.update(fs.readFileSync(path.join(cwd, file))); }
        catch { /* deleted or unreadable mid-tick -- the name alone still contributes */ }
        hash.update("\0");
      }
      const digest = hash.digest("hex");
      if (digest !== lastHash) {
        lastHash = digest; lastChangeAtMs = elapsedMs;
        if (relevantFiles.length > 0) sawChange = true;
        return { stop: false };
      }
      if (!sawChange || elapsedMs < minElapsedMs) return { stop: false };
      const idleForMs = elapsedMs - lastChangeAtMs;
      if (idleForMs < idleMs) return { stop: false };
      return { stop: true, reason: "idle_diff", detail: `worktree unchanged for ${Math.round(idleForMs / 1000)}s` };
    };
  }

  return { collectGitRecord, createCoordinatorCommit, makeIdleDiffTick };
}
