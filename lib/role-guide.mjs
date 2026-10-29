// A role's guide: the repository's standing rules for one army role (where
// the CSS rules live, which components to reuse, how specs are named...),
// kept in a committed Markdown file and attached to every brief for that
// role. A role description says which hat a worker wears; a guide says how
// this repository expects that hat to be worn.
//
// The guide is read from the commit the job starts from, never from the
// job's own worktree, so a worker cannot loosen its rules by editing the
// file mid-job. A review scout gets the reviewed job's guide too, read at
// that job's base, so findings cite the rules the builder was given.

import { spawnHostGitSync } from "./worktree-pointer.mjs";

// Guides ride in every brief for the role, so they are capped like the
// description, only larger: enough for a page of real standards.
export const ROLE_GUIDE_MAX_CHARS = 12000;
export const ROLE_GUIDE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,200}\.md$/;

/**
 * Read `guidePath` at `ref` in the repository at `projectDir`.
 * Returns { text, truncated } or { missing: true } when the file is absent at that ref.
 */
export function readRoleGuide({ projectDir, ref, guidePath, git = spawnHostGitSync }) {
  if (!ROLE_GUIDE_PATH_RE.test(guidePath)) return { missing: true };
  const result = git(projectDir, ["show", `${ref}:${guidePath}`], { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0 || typeof result.stdout !== "string") return { missing: true };
  const text = result.stdout.trim();
  if (!text) return { missing: true };
  return text.length > ROLE_GUIDE_MAX_CHARS
    ? { text: text.slice(0, ROLE_GUIDE_MAX_CHARS), truncated: true }
    : { text, truncated: false };
}

/** The guide as a brief section. `heading` says whose rules these are. */
export function guideSection({ heading, guidePath, ref, guide }) {
  if (guide.missing) return `## ${heading}\n(${guidePath} was not found at ${shortRef(ref)}; follow the repository's existing conventions.)`;
  const note = guide.truncated ? `\n\n(Truncated at ${ROLE_GUIDE_MAX_CHARS} characters; read ${guidePath} for the rest.)` : "";
  return `## ${heading} (${guidePath} at ${shortRef(ref)}; read-only)\n${guide.text}${note}`;
}

const shortRef = (ref) => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref);
