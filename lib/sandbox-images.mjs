// nomArmy per-language sandbox images (v1.3).
//
// The base sandbox (docker/Dockerfile) has python3/pip, but not any
// third-party PACKAGE a real repo needs (boto3, pandas, ...) -- and it can't,
// since those are repo-specific. A worker or verification run against a Go
// or Rust repository needs `go`/`cargo` inside the sandbox for the same
// underlying reason (the base image can't carry every toolchain), though
// there the fix is simpler: the toolchain itself is repo-independent, so one
// static image covers every Go repo and every Rust repo. None of this is
// worth baking into the one image every job uses regardless of language --
// a native compiler or a repo's own dependency set is real, non-trivial
// memory pressure competing with the same tight local-inference budget
// lib/sizing.mjs already fights to protect, and most installs will never
// touch Go, Rust, or a Python repo with real third-party dependencies.
//
// So these images are built lazily, on first use, and cached by Podman from
// then on (an ordinary tagged image, indistinguishable from one built by
// hand). The build itself needs network access to fetch packages/rustup/pip
// packages -- that happens once, on the HOST, via `podman build`; the
// resulting container a job actually runs in still gets --network none like
// every other sandbox (this is the actual fix for "pip install has no
// network in the sandbox": install at BUILD time, which has network, never
// at run time, which never does). This only ever affects which image
// nomArmy's OWN independent verification runs against (lib/verify.mjs) -- it
// does not change what sandbox the worker's own tool calls execute in, which
// is still whatever OpenClaw is configured with (see docs/experiments for
// why: `openclaw agent exec` has no per-call sandbox override today).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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

/**
 * Extra PATH entries a language's image needs for OpenClaw's own `exec` tool
 * to find that toolchain -- verified live: `podman exec` on a freshly built
 * Go image resolves `go` fine (the image's own baked ENV PATH includes it),
 * but the SAME container driven through `openclaw agent exec` reported
 * "go: not found" until `tools.exec.pathPrepend` carried these paths
 * explicitly. OpenClaw's exec tool does not inherit a sandbox image's own
 * ENV PATH on its own; this is the config knob that closes that gap. Paths
 * match each Dockerfile's own ENV lines (Dockerfile.go's GOPATH=/home/node/go,
 * Dockerfile.rust's CARGO_HOME=/home/node/.cargo). Python needs nothing here:
 * `pip3 install --break-system-packages` (no --user) puts entry-point
 * scripts on the image's already-default PATH.
 */
// Where a Node repo's installed packages live in its dependency image
// (nodeDependencyFiles below). /node_modules links here: Node's resolver,
// TypeScript's and `npm run`'s PATH all search parent folders up to /, so
// /workspace resolves packages from it without touching the worktree.
export const NODE_DEPS_DIR = "/deps/node_modules";
export const NODE_DEPS_BIN = `${NODE_DEPS_DIR}/.bin`;

export const EXEC_PATH_PREPEND = Object.freeze({
  go: ["/usr/local/go/bin", "/home/node/go/bin"],
  rust: ["/home/node/.cargo/bin"],
  node: [NODE_DEPS_BIN],
  "python+node": [NODE_DEPS_BIN],
});

/**
 * Which requirements file(s) a Python repo's sandbox image should install:
 * `.nomarmy.yml`'s `environment.python.requirements` if declared (a repo
 * with several requirements files -- app, dev, a sub-package's own -- has no
 * single conventional name this could guess), otherwise bare
 * `requirements.txt` if that file actually exists. Never fabricated: a repo
 * with neither declares nothing to install and gets the base image, same as
 * before this existed.
 */
export function pythonRequirementsFor(cwd, config) {
  const declared = config?.environment?.python?.requirements;
  if (Array.isArray(declared) && declared.length > 0) return declared;
  return cwd && fs.existsSync(path.join(cwd, "requirements.txt")) ? ["requirements.txt"] : [];
}

/**
 * A Node repo's lockfile install: { files, reason }. `files` is what `npm ci`
 * needs (package.json plus package-lock.json or npm-shrinkwrap.json), or []
 * with `reason` saying why nothing will be installed. The sandbox has no
 * network, so without this every JS/TS repo's tsc and tests failed on their
 * first import (a real Senti review before publishing). npm workspaces,
 * yarn and pnpm aren't handled yet: their installs need more than the root.
 * `environment.node.install: false` in .nomarmy.yml turns it off.
 */
export function nodeDependencyFiles(cwd, config) {
  if (!cwd || !fs.existsSync(path.join(cwd, "package.json"))) return { files: [], reason: "no package.json" };
  if (config?.environment?.node?.install === false) return { files: [], reason: "environment.node.install is false" };
  const lock = ["package-lock.json", "npm-shrinkwrap.json"].find((f) => fs.existsSync(path.join(cwd, f)));
  if (!lock) {
    const other = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"].find((f) => fs.existsSync(path.join(cwd, f)));
    return { files: [], reason: other ? `${other} isn't supported yet (npm lockfiles only)` : "no package-lock.json" };
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (pkg.workspaces) return { files: [], reason: "npm workspaces aren't supported yet" };
  } catch { return { files: [], reason: "package.json doesn't parse" }; }
  return { files: ["package.json", lock], reason: null };
}

/** Which of LANGUAGE_IMAGES' languages this worktree root looks like, or
 * "python" if it declares/has installable Python dependencies, or null for
 * anything else (including Node, which uses the default image and needs no
 * detection at all). `config` is the already-loaded, already-validated
 * .nomarmy.yml (or null) -- this never loads or parses it itself. */
export function detectPrimaryLanguage(cwd, config = null) {
  if (!cwd || typeof cwd !== "string") return null;
  for (const [lang, spec] of Object.entries(LANGUAGE_IMAGES)) {
    if (spec.markers.some((m) => fs.existsSync(path.join(cwd, m)))) return lang;
  }
  const python = pythonRequirementsFor(cwd, config).length > 0;
  const node = nodeDependencyFiles(cwd, config).files.length > 0;
  if (python && node) return "python+node";
  if (python) return "python";
  if (node) return "node";
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
 * Unlike Go/Rust (one static image for every repo, since the toolchain is
 * repo-independent), Python's problem is the repo's OWN dependencies -- a
 * generic python3/pip image still fails on `import boto3`. So the image is
 * built FROM the worktree as its context (so a Dockerfile COPY can reach the
 * real requirements files at their real relative paths) and tagged by a hash
 * of their content, not a fixed name: a dependency change is a cache miss
 * (rebuilds once, then cached like every other job), and an unchanged
 * requirements file across different repos or branches is a cache hit
 * against the exact same tag, no coordination needed to make that happen.
 */
export function pythonImageTag(cwd, requirements) {
  const hash = crypto.createHash("sha256");
  for (const rel of requirements) {
    hash.update(rel);
    hash.update("\0");
    // A requirements file the tag-computation can't read is not this
    // function's problem to solve -- the build step right after will fail
    // on the same missing file, with a real, specific error, instead of
    // this one guessing at a substitute hash.
    try { hash.update(fs.readFileSync(path.join(cwd, rel))); } catch { /* surfaces at build time */ }
    hash.update("\0");
  }
  return `openclaw-nomarmy-coder-python-${hash.digest("hex").slice(0, 8)}:bookworm`;
}

function pythonDockerfile(requirements) {
  const copies = requirements.map((rel, i) => `COPY ${rel} /tmp/reqs/req-${i}.txt`).join("\n");
  const reqFlags = requirements.map((_, i) => `-r /tmp/reqs/req-${i}.txt`).join(" ");
  // Same base as docker/Dockerfile plus build-essential: pandas/pyarrow/
  // psycopg2-binary all ship manylinux wheels so compiling should not be
  // needed, but a requirements file this hasn't been tested against might
  // need it -- cheap insurance, same reasoning as the Rust image. bookworm's
  // packaged pip refuses to install into the system environment at all
  // (PEP 668) without --break-system-packages; this container IS the
  // dedicated environment, there is no venv to prefer it over.
  return `FROM node:24-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \\
    bash ca-certificates curl git jq python3 python3-pip python3-venv ripgrep build-essential \\
    && rm -rf /var/lib/apt/lists/*
${copies}
RUN pip3 install --no-cache-dir --break-system-packages ${reqFlags}
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
`;
}

/** Builds this worktree's Python dependency image if Podman doesn't already
 * have it tagged. Returns null (never throws) when there is nothing to
 * install -- the caller falls back to the default image, unchanged from
 * before this existed. A build failure DOES throw, same as
 * ensureLanguageImageBuilt and for the same reason: running against the
 * wrong image would look like a genuine test failure, not the
 * infrastructure gap it actually is. */
export function ensurePythonImageBuilt(cwd, config, { run = defaultRun } = {}) {
  const requirements = pythonRequirementsFor(cwd, config);
  if (!requirements.length) return null;
  const image = pythonImageTag(cwd, requirements);
  if (imageExists(image, run)) return image;
  const dockerfilePath = path.join(os.tmpdir(), `nomarmy-python-${crypto.randomBytes(6).toString("hex")}.Dockerfile`);
  fs.writeFileSync(dockerfilePath, pythonDockerfile(requirements));
  try {
    run("podman", ["build", "-t", image, "-f", dockerfilePath, cwd]);
  } catch (error) {
    throw new Error(`failed to build the python sandbox image (${image}) from ${requirements.join(", ")}: ${error.message}`);
  } finally {
    fs.rmSync(dockerfilePath, { force: true });
  }
  return image;
}

/**
 * A repo's dependency image for Node, or Python and Node together: npm ci
 * (and pip) at build time, on the host, which has network. Tagged by a hash
 * of every dependency file, like pythonImageTag. The build context is a
 * temp folder holding only those files, never the repo (whose own
 * node_modules alone can be gigabytes).
 */
export function dependencyImageTag(cwd, files) {
  const hash = crypto.createHash("sha256");
  for (const rel of files) {
    hash.update(rel); hash.update("\0");
    try { hash.update(fs.readFileSync(path.join(cwd, rel))); } catch { /* surfaces at build time */ }
    hash.update("\0");
  }
  return `openclaw-nomarmy-coder-deps-${hash.digest("hex").slice(0, 8)}:bookworm`;
}

export function dependencyDockerfile({ requirements = [], nodeFiles = [] }) {
  const reqCopies = requirements.map((_, i) => `COPY py/req-${i}.txt /tmp/reqs/req-${i}.txt`).join("\n");
  const pip = requirements.length ? `RUN pip3 install --no-cache-dir --break-system-packages ${requirements.map((_, i) => `-r /tmp/reqs/req-${i}.txt`).join(" ")}` : "";
  const nodeCopies = nodeFiles.map((f) => `COPY node/${f} /deps/${f}`).join("\n");
  // Installed as root, then handed to the sandbox's "node" user, so a tool
  // that writes a cache under node_modules (vite, babel) still can.
  const npm = nodeFiles.length ? `RUN cd /deps && npm ci --no-audit --no-fund && npm cache clean --force \\
    && ln -s ${NODE_DEPS_DIR} /node_modules && chown -R node:node /deps
ENV PATH=${NODE_DEPS_BIN}:$PATH` : "";
  return `FROM node:24-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \\
    bash ca-certificates curl git jq python3 python3-pip python3-venv ripgrep build-essential \\
    && rm -rf /var/lib/apt/lists/*
${[reqCopies, pip, nodeCopies, npm].filter(Boolean).join("\n")}
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
`;
}

/** Builds the dependency image if Podman doesn't have it; null when there's nothing to install. Throws on a failed build, like ensurePythonImageBuilt. */
export function ensureDependencyImageBuilt(cwd, config, { run = defaultRun } = {}) {
  const requirements = pythonRequirementsFor(cwd, config);
  const nodeFiles = nodeDependencyFiles(cwd, config).files;
  if (!nodeFiles.length) return requirements.length ? ensurePythonImageBuilt(cwd, config, { run }) : null;
  const all = [...requirements, ...nodeFiles];
  const image = dependencyImageTag(cwd, all);
  if (imageExists(image, run)) return image;
  const context = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-deps-"));
  try {
    fs.mkdirSync(path.join(context, "py")); fs.mkdirSync(path.join(context, "node"));
    requirements.forEach((rel, i) => fs.copyFileSync(path.join(cwd, rel), path.join(context, "py", `req-${i}.txt`)));
    for (const f of nodeFiles) fs.copyFileSync(path.join(cwd, f), path.join(context, "node", f));
    fs.writeFileSync(path.join(context, "Dockerfile"), dependencyDockerfile({ requirements, nodeFiles }));
    run("podman", ["build", "-t", image, "-f", path.join(context, "Dockerfile"), context]);
  } catch (error) {
    throw new Error(`failed to build the dependency sandbox image (${image}) from ${all.join(", ")}: ${error.message}`);
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
  return image;
}

/**
 * The image a verification run against `cwd` should use: an explicit
 * override always wins (matches every other explicit-config-beats-
 * auto-detect choice in this codebase); otherwise a detected Go/Rust repo
 * gets its language image, a Python repo with real dependencies gets its
 * own dependency-hashed image (both built lazily), and everything else gets
 * `defaultImage` unchanged -- zero behavior change for Node repos, or
 * Python repos that declare nothing to install.
 */
export function resolveSandboxImage({ cwd, explicitImage, defaultImage, config = null, run = defaultRun }) {
  if (explicitImage) return explicitImage;
  const lang = detectPrimaryLanguage(cwd, config);
  if (!lang) return defaultImage;
  if (lang === "python") return ensurePythonImageBuilt(cwd, config, { run }) ?? defaultImage;
  if (lang === "node" || lang === "python+node") return ensureDependencyImageBuilt(cwd, config, { run }) ?? defaultImage;
  return ensureLanguageImageBuilt(lang, { run });
}
