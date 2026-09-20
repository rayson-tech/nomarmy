// nomArmy per-language sandbox images (v1.3).
//
// The base sandbox (docker/Dockerfile) covers Node and Python. A worker or
// verification run against a Go or Rust repository needs `go`/`cargo` inside
// the sandbox, and neither is worth baking into the one image every job
// uses -- a native compiler is real, non-trivial memory pressure competing
// with the same tight local-inference budget lib/sizing.mjs already fights
// to protect, and most installs will never touch Go or Rust at all.
//
// So these images are built lazily, on first use, and cached by Podman from
// then on (an ordinary tagged image, indistinguishable from one built by
// hand). The build itself needs network access to fetch packages/rustup --
// that happens once, on the HOST, via `podman build`; the resulting
// container a job actually runs in still gets --network none like every
// other sandbox. This only ever affects which image nomArmy's OWN
// independent verification runs against (lib/verify.mjs) -- it does not
// change what sandbox the worker's own tool calls execute in, which is
// still whatever OpenClaw is configured with (see docs/experiments for why:
// `openclaw agent exec` has no per-call sandbox override today).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// lib/ and docker/ are always siblings, whether running from the dev
// checkout or the installed copy under ~/.local/share/nomarmy-local-worker
// (installMcpCopy copies both) -- resolving relative to this file's own
// location works in either case with no extra configuration.
const DOCKER_DIR = path.join(HERE, "..", "docker");

/** Marker files, checked at the worktree root only (cheap, no recursive
 * walk) -- this decides which SANDBOX IMAGE a job needs, a narrower and
 * hotter-path question than lib/scan.mjs's full evidence-gathering pass. */
export const LANGUAGE_IMAGES = Object.freeze({
  go: { image: "openclaw-nomarmy-coder-go:bookworm", dockerfile: "Dockerfile.go", markers: ["go.mod"] },
  rust: { image: "openclaw-nomarmy-coder-rust:bookworm", dockerfile: "Dockerfile.rust", markers: ["Cargo.toml"] },
});

/** Which of LANGUAGE_IMAGES' languages this worktree root looks like, or
 * null for anything else (including Node/Python, which use the default
 * image and need no detection at all). */
export function detectPrimaryLanguage(cwd) {
  if (!cwd || typeof cwd !== "string") return null;
  for (const [lang, spec] of Object.entries(LANGUAGE_IMAGES)) {
    if (spec.markers.some((m) => fs.existsSync(path.join(cwd, m)))) return lang;
  }
  return null;
}

function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

function imageExists(image, run) {
  try {
    return run("podman", ["images", "-q", image]).trim().length > 0;
  } catch {
    // Podman missing/unreachable is not this function's problem to solve --
    // the caller's own sandbox-start path already handles that absence.
    return false;
  }
}

/** Builds LANGUAGE_IMAGES[lang]'s image if Podman doesn't already have it
 * tagged. Idempotent and safe to call on every job -- the existence check
 * is what makes repeat calls a no-op, not a memoized flag, so it is
 * correct even across separate processes/restarts. Throws with a clear
 * reason on failure; never silently falls back to a different image, since
 * running Go/Rust commands in an image without that toolchain would look
 * like a genuine test failure rather than the infrastructure gap it is. */
export function ensureLanguageImageBuilt(lang, { run = defaultRun } = {}) {
  const spec = LANGUAGE_IMAGES[lang];
  if (!spec) throw new Error(`unknown sandbox language: ${lang}`);
  if (imageExists(spec.image, run)) return spec.image;
  const dockerfilePath = path.join(DOCKER_DIR, spec.dockerfile);
  try {
    run("podman", ["build", "-t", spec.image, "-f", dockerfilePath, DOCKER_DIR]);
  } catch (error) {
    throw new Error(`failed to build the ${lang} sandbox image (${spec.image}): ${error.message}`);
  }
  return spec.image;
}

/**
 * The image a verification run against `cwd` should use: an explicit
 * override always wins (matches every other explicit-config-beats-
 * auto-detect choice in this codebase); otherwise a detected Go/Rust repo
 * gets its language image (built lazily), and everything else gets
 * `defaultImage` unchanged -- zero behavior change for Node/Python repos.
 */
export function resolveSandboxImage({ cwd, explicitImage, defaultImage, run = defaultRun }) {
  if (explicitImage) return explicitImage;
  const lang = detectPrimaryLanguage(cwd);
  if (!lang) return defaultImage;
  return ensureLanguageImageBuilt(lang, { run });
}
