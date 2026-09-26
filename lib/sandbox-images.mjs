// nomArmy's sandbox images, composed from the harnesses a repo matches.
//
// The base sandbox has python3/pip and Node, but not a repo's own packages
// (boto3, pandas, a lockfile's dependencies) or other toolchains (Go, Rust),
// and it can't: those are repo-specific. So each repo gets one image built
// from a shared base plus a layer per matching harness (harnesses/, loaded
// by lib/harnesses.mjs): toolchains first, so Podman's layer cache shares
// them across repos, then Python, then Node, then declarative harnesses,
// respecting each harness's `after`. A Go backend with a Node frontend gets
// both.
//
// Images are built lazily, on first use, and tagged by a hash of the
// Dockerfile and every file copied into it, so a lockfile change rebuilds
// once and is cached from then on. The build needs network to fetch
// packages; that happens once, on the HOST, via `podman build`. The
// containers jobs and verification run in still get --network none: install
// at build time, which has network, never at run time, which doesn't.
import crypto from "node:crypto";
import { readRegistrySecrets, assertNoRegistryCopies, registryInstallRun } from "./registry-secrets.mjs";
import { parse as parseYaml } from "yaml";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarnesses, matchHarnesses } from "./harnesses.mjs";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// lib/ and docker/ are always siblings, whether running from the dev
// checkout or the installed copy under ~/.local/share/nomarmy-local-worker
// (installMcpCopy copies both) -- resolving relative to this file's own
// location works in either case with no extra configuration.
const DOCKER_DIR = path.join(HERE, "..", "docker");

/** Legacy standalone toolchain builders; resolution uses composed harnesses. */
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
 * Dockerfile.rust's CARGO_HOME=/home/node/.cargo). Python project managers use /deps/python/.venv/bin; requirements-only
 * repos retain their system pip entry points.
 */
// Where a Node repo's installed packages live in its dependency image
// (nodeDependencyFiles below). /node_modules links here: Node's resolver,
// TypeScript's and `npm run`'s PATH all search parent folders up to /, so
// /workspace resolves packages from it without touching the worktree.
export const NODE_DEPS_ROOT = "/deps";
export const NODE_DEPS_DIR = `${NODE_DEPS_ROOT}/node_modules`;
export const NODE_DEPS_BIN = `${NODE_DEPS_DIR}/.bin`;
// npm inside a sandbox: its cache in /tmp, never the worktree, and no
// update check. With the cache resolving relative to the working directory,
// `cd lambda/x && npx tsc` left lambda/x/.npm/_update-notifier-last-checked
// in a real Senti commit. Environment variables beat any .npmrc.
export const SANDBOX_NPM_ENV = Object.freeze({
  NPM_CONFIG_CACHE: "/tmp/.npm", npm_config_cache: "/tmp/.npm",
  NPM_CONFIG_UPDATE_NOTIFIER: "false", npm_config_update_notifier: "false",
});

export const EXEC_PATH_PREPEND = Object.freeze({
  go: ["/usr/local/go/bin", "/home/node/go/bin"],
  rust: ["/home/node/.cargo/bin"],
  python: ["/deps/python/.venv/bin"],
  node: [NODE_DEPS_BIN],
  "python+node": [NODE_DEPS_BIN],
});

/**
 * Which requirements file(s) a Python repo's sandbox image should install:
 * `.nomarmy.yml`'s `environment.python.requirements` if declared (a repo
 * with several requirements files -- app, dev, a sub-package's own -- has no
 * single conventional name this could guess), otherwise bare
 * `requirements.txt` if no higher-priority root project manager applies.
 * Project manifests are handled separately by the composed Python layer;
 * they must never be passed to the legacy pip -r builders.
 */
export function pythonRequirementsFor(cwd, config) {
  const declared = config?.environment?.python?.requirements;
  if (Array.isArray(declared) && declared.length > 0) return declared;
  if (pythonProjectManager(cwd)) return [];
  return cwd && fs.existsSync(path.join(cwd, "requirements.txt")) ? ["requirements.txt"] : [];
}

/** Root manager precedence; explicit requirements are resolved by the caller. */
function pythonProjectManager(cwd) {
  if (!cwd || typeof cwd !== "string" || !fs.existsSync(cwd)) return null;
  if (repositoryFile(cwd, "uv.lock")) return "uv";
  const manifest = repositoryFile(cwd, "pyproject.toml")
    ? fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf8") : "";
  if (repositoryFile(cwd, "poetry.lock") || /^\s*\[tool\.poetry\]\s*(?:#.*)?$/m.test(manifest)) return "poetry";
  return /^\s*\[project\]\s*(?:#.*)?$/m.test(manifest) ? "pyproject" : null;
}

function pythonProjectLayer(cwd, manager, files, secrets = []) {
  for (const source of ["pyproject.toml", ...(manager === "uv" ? ["uv.lock"] : manager === "poetry" ? ["poetry.lock"] : [])]) {
    if (repositoryFile(cwd, source)) files.push({ source, destination: `py/${source}` });
  }
  // Parse TOML with Python 3.11's standard library, not shell interpolation or
  // an approximation of dependency strings. Never install the project itself.
  const readProject = 'import tomllib; d=tomllib.load(open("pyproject.toml", "rb")); ';
  let install;
  if (manager === "uv") {
    install = "pip3 install --no-cache-dir --break-system-packages uv && uv sync --frozen --no-install-project --all-groups";
  } else if (manager === "poetry") {
    const dev = readProject + 'p=d.get("tool", {}).get("poetry", {}); print("--with dev" if "dev" in p.get("group", {}) else "")';
    install = `pip3 install --no-cache-dir --break-system-packages poetry && poetry install --no-root --no-interaction $(python3 -c ${shellQuote(dev)})`;
  } else {
    const deps = readProject + 'import subprocess; p=d.get("project", {}); extras=p.get("optional-dependencies", {}); deps=p.get("dependencies", []) + [dep for name in ("test", "tests", "dev") for dep in extras.get(name, [])]; subprocess.check_call(["/deps/python/.venv/bin/python", "-m", "pip", "install", "--no-cache-dir", "--", *deps]) if deps else None';
    install = `python3 -c ${shellQuote(deps)}`;
  }
  return `COPY py/ /deps/python/
ENV UV_PROJECT_ENVIRONMENT=/deps/python/.venv
ENV POETRY_VIRTUALENVS_CREATE=false
${registryInstallRun(`cd /deps/python && (python3 -m venv /deps/python/.venv && ${manager === "poetry" ? "export VIRTUAL_ENV=/deps/python/.venv && " : ""}${install} || touch .nomarmy-${manager}-install-failed)`, "pip", secrets)}
RUN chown -R node:node /deps/python`;
}

const NODE_LOCKS = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json"];

/** Resolve workspace globs against real directories, never following symlinks. */
function workspaceMembers(root, patterns) {
  if (!patterns.length) return [];
  const regex = (glob) => {
    let out = "";
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === "*" && glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; out += "(?:.*/)?"; }
        else out += ".*";
      } else if (c === "*") out += "[^/]*";
      else if (c === "?") out += "[^/]";
      else if (c === "{") out += "(?:";
      else if (c === "}") out += ")";
      else if (c === ",") out += "|";
      else out += c.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    }
    return new RegExp("^" + out + "$");
  };
  const globs = patterns.filter((p) => typeof p === "string").map((p) => ({
    exclude: p.startsWith("!"), re: regex(p.replace(/^!/, "").replace(/^\.\//, "").replace(/\/$/, "")),
  }));
  const members = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
      const rel = dir ? dir + "/" + e.name : e.name;
      if (globs.some((g) => !g.exclude && g.re.test(rel)) &&
          !globs.some((g) => g.exclude && g.re.test(rel)) &&
          fs.existsSync(path.join(root, rel, "package.json"))) members.push(rel);
      walk(rel);
    }
  };
  walk("");
  return members;
}

function nodePackageAt(cwd, dir) {
  const at = (f) => path.join(cwd, dir, f), rel = (f) => (dir === "." ? f : dir + "/" + f);
  if (!fs.existsSync(at("package.json"))) return { files: [], reason: "no package.json" };
  const lock = NODE_LOCKS.find((f) => fs.existsSync(at(f)));
  if (!lock) return { files: [], reason: "no package-lock.json" };
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(at("package.json"), "utf8")); }
  catch { return { files: [], reason: "package.json doesn't parse" }; }
  const manager = lock === "pnpm-lock.yaml" ? "pnpm" : lock === "yarn.lock"
    ? (fs.existsSync(at(".yarnrc.yml")) || /^__metadata:/m.test(fs.readFileSync(at(lock), "utf8")) ? "yarn-berry" : "yarn")
    : lock.startsWith("bun.") ? "bun" : "npm";
  const files = [rel("package.json"), rel(lock)];
  let patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
  const workspace = Boolean(pkg.workspaces) || fs.existsSync(at("pnpm-workspace.yaml"));
  if (fs.existsSync(at("pnpm-workspace.yaml"))) {
    files.push(rel("pnpm-workspace.yaml"));
    patterns = parseYaml(fs.readFileSync(at("pnpm-workspace.yaml"), "utf8"))?.packages ?? [];
  }
  if (fs.existsSync(at(".yarnrc.yml"))) files.push(rel(".yarnrc.yml"));
  const members = workspaceMembers(at("."), Array.isArray(patterns) ? patterns : []).map(rel);
  files.push(...members.map((m) => m + "/package.json"));
  return { files, manager, workspace, members, yarnFallback: !pkg.packageManager && manager.startsWith("yarn") ? (manager === "yarn" ? "1" : "stable") : null, reason: null };
}

// Every directory holding a supported lockfile: git's tracked files when this is
// a checkout (which skips node_modules and anything ignored), else a
// shallow walk.
function lockfileDirs(cwd) {
  const isLock = (f) => NODE_LOCKS.includes(path.posix.basename(f)) && !/(^|\/)node_modules\//.test(f);
  let files = null;
  try {
    files = execFileSync("git", ["ls-files", "-z", "--", ...NODE_LOCKS.map((name) => "*" + name)], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
  } catch { /* not a checkout */ }
  if (files === null) {
    files = [];
    const walk = (dir, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(path.join(cwd, dir), { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const rel = dir === "." ? e.name : `${dir}/${e.name}`;
        if (e.isDirectory()) { if (depth < 4 && e.name !== "node_modules" && !e.name.startsWith(".")) walk(rel, depth + 1); }
        else files.push(rel);
      }
    };
    walk(".", 0);
  }
  return [...new Set(files.filter(isLock).map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".")))].sort();
}

/**
 * A Node repo's lockfile installs: { files, packages, skipped, reason }.
 * The sandbox has no network, so without this every JS/TS repo's tsc and
 * tests failed on their first import (a real Senti review). Every package
 * with its own npm lockfile is installed, not just the root: a frontend in
 * ui/ and backends under lambda/, each with its own lockfile and no npm
 * workspaces, is a common layout, and installing only the root left
 * `cd ui && tsc` failing on every file (the same review, one step later).
 *
 * `packages` are the directories ("." for the root) that will install;
 * `files` their package.json and lockfile paths; `skipped` those that
 * won't, each with its reason. Workspace members share their root install.
 * `installs` selects each root's manager; `links` includes workspace members.
 * `environment.node.install: false` turns it off.
 */
export function nodeDependencyFiles(cwd, config) {
  const none = (reason) => ({ files: [], packages: [], skipped: [], reason });
  if (!cwd) return none("no package.json");
  if (config?.environment?.node?.install === false) return none("environment.node.install is false");
  const dirs = lockfileDirs(cwd);
  if (!dirs.includes(".")) dirs.unshift(".");
  const packages = [], skipped = [], files = [], installs = [], links = [];
  const covered = new Set();
  for (const dir of dirs) {
    if (covered.has(dir)) continue;
    const found = nodePackageAt(cwd, dir);
    if (found.files.length) {
      packages.push(dir); files.push(...found.files);
      installs.push({ dir, manager: found.manager, yarnFallback: found.yarnFallback });
      links.push(...(dir !== "." || found.workspace ? [dir] : []), ...found.members);
      for (const member of found.members) covered.add(member);
    }
    else if (dir !== "." || fs.existsSync(path.join(cwd, "package.json"))) skipped.push({ dir, reason: found.reason });
  }
  const reason = packages.length ? null : (skipped[0]?.reason ?? "no package.json");
  return { files: [...new Set(files)], packages, skipped, reason, installs, links: [...new Set(links)] };
}

/**
 * Give each non-root package and workspace root/member a node_modules that resolves to
 * its install in the dependency image: a symlink to /deps/<dir>/node_modules,
 * dangling on the host, valid in the sandbox (both mount the worktree at
 * /workspace). Node and TypeScript look for node_modules beside the package
 * first, and /node_modules only covers the root. Never replaces a
 * node_modules that's already there; nomArmy never commits these (see
 * isRuntimeJunk in mcp/server.mjs). Returns the links it made.
 */
export function linkNodePackages(worktree, config, { env = process.env } = {}) {
  if (env.NOMARMY_AGENT_IMAGE) return []; // someone else's image: /deps may not exist
  const made = [];
  for (const dir of nodeDependencyFiles(worktree, config).links ?? []) {
    const link = path.join(worktree, dir, "node_modules");
    try { fs.lstatSync(link); continue; } catch { /* nothing there yet */ }
    try { fs.symlinkSync(dir === "." ? NODE_DEPS_DIR : `${NODE_DEPS_ROOT}/${dir}/node_modules`, link, "dir"); made.push(dir === "." ? "node_modules" : `${dir}/node_modules`); } catch { /* best-effort */ }
  }
  return made;
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
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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

export function dependencyDockerfile({ requirements = [], nodeFiles = [], nodePackages = null, nodeInstalls = null, secrets = [] }) {
  const reqRoot = secrets.some((s) => s.ecosystem === "pip") ? "/deps/requirements" : "/tmp/reqs";
  const reqCopies = requirements.map((_, i) => `COPY py/req-${i}.txt ${reqRoot}/req-${i}.txt`).join("\n");
  const pip = requirements.length ? registryInstallRun(`pip3 install --no-cache-dir --break-system-packages ${requirements.map((_, i) => `-r ${reqRoot}/req-${i}.txt`).join(" ")}`, "pip", secrets) : "";
  const packages = nodePackages ?? (nodeFiles.length ? ["."] : []);
  // Owned by the sandbox's "node" user from the start and installed as it,
  // so a tool that writes a cache under node_modules (vite, babel) can, and
  // no chown -R layer doubles the image.
  const managers = nodeInstalls ?? packages.map((dir) => ({ dir, manager: "npm" }));
  const setup = [
    ...(managers.some(({ manager }) => manager === "pnpm" || manager.startsWith("yarn")) ? ["RUN npm install -g corepack && corepack enable"] : []),
    ...(managers.some(({ manager }) => manager === "bun") ? ["RUN npm install -g bun"] : []),
  ];
  const nodeCopies = packages.length ? [...setup, `RUN mkdir -p ${NODE_DEPS_ROOT} && chown node:node ${NODE_DEPS_ROOT}`, ...nodeFiles.map((f) => `COPY --chown=node:node node/${f} ${NODE_DEPS_ROOT}/${f}`), "USER node"].join("\n") : "";
  // One layer per package, each laid out at its repo path under /deps. A
  // package that can't install (a private registry, say) leaves a marker
  // instead of failing the image, so the others still work.
  const installs = managers.map(({ dir, manager, yarnFallback }) => {
    if (manager === "yarn-berry" && secrets.some((secret) => secret.ecosystem === "npm")) {
      throw new Error("registries: Yarn Berry does not read .npmrc; private registry builds currently require Yarn Classic");
    }
    const at = dir === "." ? NODE_DEPS_ROOT : `${NODE_DEPS_ROOT}/${dir}`;
    const command = { pnpm: "pnpm install --frozen-lockfile", yarn: "yarn install --frozen-lockfile",
      "yarn-berry": "YARN_NODE_LINKER=node-modules yarn install --immutable", bun: "bun install --frozen-lockfile" }[manager];
    if (command) return registryInstallRun(`cd ${shellQuote(at)} && (${yarnFallback ? `corepack prepare yarn@${yarnFallback} --activate && ` : ""}${command} || touch .nomarmy-${manager}-install-failed)`, "npm", secrets);
    return registryInstallRun(`cd ${at} && (npm ci --no-audit --no-fund || touch .nomarmy-npm-ci-failed) && npm cache clean --force`, "npm", secrets);
  }).join("\n");
  // The root's packages are reachable from anywhere under /workspace via
  // /node_modules; each other package gets a worktree link (linkNodePackages).
  const root = packages.length ? ["USER root", ...(packages.includes(".") ? [`RUN ln -s ${NODE_DEPS_DIR} /node_modules`, `ENV PATH=${NODE_DEPS_BIN}:$PATH`] : [])].join("\n") : "";
  return `FROM node:24-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \\
    bash ca-certificates curl git jq python3 python3-pip python3-venv ripgrep build-essential \\
    && rm -rf /var/lib/apt/lists/*
${[reqCopies, pip, nodeCopies, installs, root].filter(Boolean).join("\n")}
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
`;
}

/** Builds the dependency image if Podman doesn't have it; null when there's nothing to install. Throws on a failed build, like ensurePythonImageBuilt. */
export function ensureDependencyImageBuilt(cwd, config, { run = defaultRun } = {}) {
  const requirements = pythonRequirementsFor(cwd, config);
  const node = nodeDependencyFiles(cwd, config), nodeFiles = node.files;
  if (!nodeFiles.length) return requirements.length ? ensurePythonImageBuilt(cwd, config, { run }) : null;
  const all = [...requirements, ...nodeFiles];
  const image = dependencyImageTag(cwd, all);
  if (imageExists(image, run)) return image;
  const context = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-deps-"));
  try {
    fs.mkdirSync(path.join(context, "py")); fs.mkdirSync(path.join(context, "node"));
    requirements.forEach((rel, i) => fs.copyFileSync(path.join(cwd, rel), path.join(context, "py", `req-${i}.txt`)));
    for (const f of nodeFiles) {
      fs.mkdirSync(path.dirname(path.join(context, "node", f)), { recursive: true });
      fs.copyFileSync(path.join(cwd, f), path.join(context, "node", f));
    }
    fs.writeFileSync(path.join(context, "Dockerfile"), dependencyDockerfile({ requirements, nodeFiles, nodePackages: node.packages, nodeInstalls: node.installs }));
    run("podman", ["build", "-t", image, "-f", path.join(context, "Dockerfile"), context]);
  } catch (error) {
    throw new Error(`failed to build the dependency sandbox image (${image}) from ${all.join(", ")}: ${error.message}`);
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
  return image;
}

/** Matched registry layers plus the existing config-only Python and shrinkwrap installs. */
export function sandboxHarnesses(cwd, config = null, harnesses = loadHarnesses().harnesses) {
  if (!cwd || typeof cwd !== "string") return { harnesses, matched: [] };
  const matched = matchHarnesses(cwd, harnesses, config?.harnesses ?? []);
  for (const [name, needed] of [["python", pythonRequirementsFor(cwd, config).length], ["node", nodeDependencyFiles(cwd, config).files.length]]) {
    if (needed && harnesses[name] && !matched.includes(name)) matched.push(name);
  }
  return { harnesses, matched };
}

// A priority topological sort: explicit after edges take precedence over
// cache-friendly defaults. Unmatched predecessors do not force an install.
function imageHarnessOrder(harnesses, matched) {
  const rank = (name) => ({ go: 0, rust: 1, python: 2, node: 3 }[harnesses[name].image.builtin] ?? 4);
  const pending = new Set(matched), order = [];
  while (pending.size) {
    const ready = [...pending].filter((name) => !(harnesses[name].after ?? []).some((parent) => pending.has(parent)));
    ready.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    if (!ready.length) throw new Error(`sandbox harness after cycle: ${[...pending].join(", ")}`);
    order.push(ready[0]); pending.delete(ready[0]);
  }
  return order;
}

export function sandboxPathEntries(cwd, config = null, selection = sandboxHarnesses(cwd, config)) {
  const entries = [...new Set(imageHarnessOrder(selection.harnesses, selection.matched)
    .flatMap((name) => {
      const builtin = selection.harnesses[name].image.builtin;
      if (builtin === "python" && (pythonRequirementsFor(cwd, config).length || !pythonProjectManager(cwd))) return [];
      return EXEC_PATH_PREPEND[builtin] ?? [];
    }))];
  const pythonBin = EXEC_PATH_PREPEND.python[0];
  return entries.includes(pythonBin) ? [pythonBin, ...entries.filter((entry) => entry !== pythonBin)] : entries;
}

const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

// Only regular, repository-contained inputs enter the build context. In
// particular, workspace paths must not pull files from outside the checkout.
function repositoryFile(cwd, rel) {
  const root = fs.realpathSync(cwd);
  const target = path.resolve(cwd, rel);
  if (path.isAbsolute(rel) || !target.startsWith(path.resolve(cwd) + path.sep)) return false;
  try {
    return fs.realpathSync(target).startsWith(root + path.sep) && fs.statSync(target).isFile();
  } catch { return false; }
}

function goDependencyLayer(cwd, files, secrets = []) {
  const offline = "ENV GOPROXY=off\nENV GOSUMDB=off";
  if (fs.existsSync(path.join(cwd, "vendor"))) return offline;
  const inputs = new Set(["go.mod", "go.sum", "go.work", "go.work.sum"]);
  if (repositoryFile(cwd, "go.work")) {
    // Go work files allow use ./dir, use ( ... ), and quoted paths.
    const tokens = fs.readFileSync(path.join(cwd, "go.work"), "utf8")
      .match(/"(?:\\.|[^"\\])*"|`[^`]*`|\/\/[^\n]*|[^\s()]+|[()]/g) ?? [];
    let use = false, block = false;
    for (const token of tokens) {
      if (token.startsWith("//")) continue;
      if (token === "use") { use = true; continue; }
      if (!use) continue;
      if (token === "(") { block = true; continue; }
      if (token === ")") { use = block = false; continue; }
      let dir = token;
      if (token.startsWith('"')) { try { dir = JSON.parse(token); } catch { continue; } }
      else if (token.startsWith("`")) dir = token.slice(1, -1);
      for (const name of ["go.mod", "go.sum"]) inputs.add(path.posix.join(dir, name));
      if (!block) use = false;
    }
  }
  const copied = [...inputs].filter((rel) => repositoryFile(cwd, rel));
  if (!copied.some((rel) => rel === "go.mod" || rel === "go.work")) return offline;
  for (const source of copied) files.push({ source, destination: `go/${source}` });
  return `COPY --chown=node:node go/ /deps/go/
USER node
${registryInstallRun("cd /deps/go && (go mod download || touch .nomarmy-go-mod-download-failed)", "go", secrets)}
${offline}`;
}

function rustDependencyLayer(cwd, files, secrets = []) {
  const manifests = [];
  const walk = (dir, depth) => {
    for (const entry of fs.readdirSync(path.join(cwd, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory() && depth < 4 && entry.name !== "target" && !entry.name.startsWith(".")) walk(rel, depth + 1);
      else if (entry.isFile() && entry.name === "Cargo.toml") manifests.push(rel);
    }
  };
  walk("", 0);
  for (const source of manifests) files.push({ source, destination: `rust/${source}` });
  // Private registry names/indexes are project metadata, not credentials.
  for (const source of [".cargo/config", ".cargo/config.toml"]) {
    if (repositoryFile(cwd, source)) files.push({ source, destination: `rust/${source}` });
  }
  const locked = repositoryFile(cwd, "Cargo.lock");
  if (locked) files.push({ source: "Cargo.lock", destination: "rust/Cargo.lock" });
  const stubs = new Map();
  for (const manifest of manifests) {
    const text = fs.readFileSync(path.join(cwd, manifest), "utf8");
    if (!/^\s*\[package\]/m.test(text)) continue; // virtual workspace
    const dir = path.posix.dirname(manifest);
    const add = (target, content) => {
      const rel = path.posix.normalize(path.posix.join(dir, target));
      if (path.posix.isAbsolute(target) || rel === ".." || rel.startsWith("../")) return;
      stubs.set(`rust/${rel}`, content);
    };
    add("src/lib.rs", "// Dependency-fetch placeholder.\n");
    add("src/main.rs", "fn main() {}\n");
    // Explicit lib/bin/example/test/bench targets may live outside src/.
    let section = "";
    for (const line of text.split("\n")) {
      const header = line.match(/^\s*\[\[?([^\]]+)\]\]?/);
      if (header) section = header[1].trim();
      if (!["lib", "bin", "example", "test", "bench"].includes(section)) continue;
      const target = line.match(/^\s*path\s*=\s*(?:"([^"\n]+)"|'([^'\n]+)')/);
      if (target) add(target[1] ?? target[2], section === "lib" ? "// Dependency-fetch placeholder.\n" : "fn main() {}\n");
    }
  }
  for (const [destination, content] of stubs) {
    if (!files.some((file) => file.destination === destination)) files.push({ destination, content });
  }
  return `${manifests.length ? `COPY --chown=node:node rust/ /deps/rust/
USER node
${registryInstallRun(`cd /deps/rust && (cargo fetch${locked ? " --locked" : ""} || touch .nomarmy-cargo-fetch-failed)`, "cargo", secrets)}
` : ""}ENV CARGO_NET_OFFLINE=true`;
}

/** Pure recipe composition except for reading its input files. No image builds.
 * files maps repository paths to their small, isolated build-context paths.
 */
export function composeSandboxImage(cwd, config = null, selection = sandboxHarnesses(cwd, config), options = null) {
  // No options means a recipe preview (never a build). Build callers must
  // supply options, even when trustedDir is unavailable: that fails closed.
  const secrets = readRegistrySecrets(cwd);
  if (options === null) return composeWithRegistrySecrets(cwd, config, selection, secrets);
  return trustedComposition(cwd, config, selection, secrets, options.trustedDir).composed;
}

function trustedComposition(cwd, config, selection, secrets, trustedDir) {
  const plain = composeWithRegistrySecrets(cwd, config, selection, []);
  if (!plain || !secrets.length) return { composed: plain, secrets: [] };
  // Even an uncredentialed build must never COPY a declared credential.
  assertNoRegistryCopies(cwd, plain.files, secrets);
  let changed;
  if (!trustedDir) changed = ["trusted checkout unavailable"];
  else {
    const trusted = composeWithRegistrySecrets(trustedDir, config, sandboxHarnesses(trustedDir, config), []);
    const inputs = (recipe) => new Set((recipe?.files ?? []).filter(f => f.source).map(f => f.source));
    const actual = inputs(plain), expected = inputs(trusted);
    changed = [...new Set([...actual, ...expected])].sort().filter(source => {
      if (!actual.has(source) || !expected.has(source)) return true;
      try {
        return !fs.readFileSync(path.join(cwd, source)).equals(fs.readFileSync(path.join(trustedDir, source)));
      } catch { return true; }
    });
  }
  if (!changed.length) return { composed: composeWithRegistrySecrets(trustedDir, config, sandboxHarnesses(trustedDir, config), secrets), secrets };
  const note = `private-registry credentials were not used: this job changed dependency inputs (${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", ..." : ""})`;
  return { composed: { ...plain, note }, secrets: [] };
}

function composeWithRegistrySecrets(cwd, config, selection, secrets) {
  const order = imageHarnessOrder(selection.harnesses, selection.matched);
  if (!order.length) return null;
  const footer = 'USER node\nWORKDIR /workspace\nCMD ["sleep", "infinity"]\n';
  const base = dependencyDockerfile({}).slice(0, -footer.length).trimEnd() + "\n";
  const dependencyLayer = (options) => dependencyDockerfile({ ...options, secrets }).slice(base.length, -footer.length).trim();
  const layers = [], files = [];
  let pythonVenv = false;
  for (const name of order) {
    const { image } = selection.harnesses[name];
    let layer = "";
    if (image.builtin === "go" || image.builtin === "rust") {
      const source = fs.readFileSync(path.join(DOCKER_DIR, `Dockerfile.${image.builtin}`), "utf8");
      const begin = image.builtin === "go" ? "ENV GO_VERSION=" : "USER node";
      layer = source.slice(source.indexOf(begin), source.indexOf("WORKDIR /workspace")).trim();
      layer += "\n" + (image.builtin === "go" ? goDependencyLayer(cwd, files, secrets) : rustDependencyLayer(cwd, files, secrets));
    } else if (image.builtin === "python") {
      const requirements = pythonRequirementsFor(cwd, config);
      const manager = requirements.length ? null : pythonProjectManager(cwd);
      if (manager) {
        layer = pythonProjectLayer(cwd, manager, files, secrets);
        pythonVenv = true;
      } else {
        requirements.forEach((source, i) => files.push({ source, destination: `py/req-${i}.txt` }));
        layer = dependencyLayer({ requirements });
      }
    } else if (image.builtin === "node") {
      const node = nodeDependencyFiles(cwd, config);
      node.files.forEach((source) => files.push({ source, destination: `node/${source}` }));
      layer = dependencyLayer({ nodeFiles: node.files, nodePackages: node.packages, nodeInstalls: node.installs });
    } else if (image.builtin === "playwright") {
      const node = nodeDependencyFiles(cwd, config);
      const dirs = [...new Set([...node.packages, ...(node.links ?? [])])].filter((dir) => {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(cwd, dir, "package.json"), "utf8"));
          return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((field) => pkg[field]?.["@playwright/test"]);
        } catch { return false; }
      });
      const marker = "/ms-playwright/.nomarmy-playwright-install-failed";
      layer = "ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright\nRUN mkdir -p /ms-playwright\n";
      layer += dirs.length ? dirs.map((dir) =>
        `RUN (cd ${shellQuote(path.posix.join("/deps", dir))} && npx --no-install playwright install --with-deps chromium) || touch ${marker}`
      ).join("\n") : `RUN touch ${marker}`;
      layer += "\nRUN chmod -R a+rX /ms-playwright";
    } else if (image.builtin) {
      throw new Error(`unknown sandbox builtin for harness ${name}: ${image.builtin}`);
    } else {
      // Run a child shell so even an explicit exit produces a named failure.
      const commands = [
        ...(image.apt.length ? [`apt-get update && apt-get install -y --no-install-recommends ${image.apt.map(shellQuote).join(" ")} && rm -rf /var/lib/apt/lists/*`] : []),
        ...image.run,
      ];
      layer = commands.map((command) => `RUN ${JSON.stringify(["/bin/sh", "-ec", `/bin/sh -ec ${shellQuote(command)} || { echo ${shellQuote(`sandbox harness ${name} failed`)} >&2; exit 1; }`])}`).join("\n");
    }
    if (layer) layers.push(`USER root\n# harness: ${name}\n${layer}`);
  }
  if (!layers.length) return null; // Matched metadata may have no supported install.
  const runtime = pythonVenv ? 'ENV VIRTUAL_ENV=/deps/python/.venv\nENV PATH="/deps/python/.venv/bin:${PATH}"\n' : "";
  assertNoRegistryCopies(cwd, files, secrets);
  const dockerfile = (secrets.length ? "# syntax=docker/dockerfile:1\n" : "") + base + layers.join("\n") + "\n" + runtime + footer;
  const hash = crypto.createHash("sha256").update(dockerfile).update("\0");
  for (const { ecosystem, source, format, privatePatterns, digest } of secrets) {
    hash.update(JSON.stringify({ ecosystem, source, format, privatePatterns, digest })).update("\0");
  }
  for (const { source, destination, content } of files) {
    hash.update(source ?? "").update("\0").update(destination).update("\0")
      .update(content ?? fs.readFileSync(path.join(cwd, source))).update("\0");
  }
  return { dockerfile, files, image: `openclaw-nomarmy-coder-deps-${hash.digest("hex").slice(0, 8)}:bookworm`, pathEntries: sandboxPathEntries(cwd, config, selection) };
}

export function ensureComposedImageBuilt(cwd, config, { run = defaultRun, trustedDir, onNote = () => {} } = {}) {
  const declared = readRegistrySecrets(cwd);
  const { composed, secrets } = trustedComposition(cwd, config, sandboxHarnesses(cwd, config), declared, trustedDir);
  if (!composed) return null;
  if (composed.note) onNote(composed.note);
  if (imageExists(composed.image, run)) return composed.image;
  const context = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-harnesses-"));
  try {
    for (const { source, destination, content } of composed.files) {
      const target = path.join(context, destination);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (content !== undefined) fs.writeFileSync(target, content);
      else fs.copyFileSync(path.join(secrets.length ? trustedDir : cwd, source), target);
    }
    fs.writeFileSync(path.join(context, "Dockerfile"), composed.dockerfile);
    run("podman", ["build", ...secrets.flatMap(({ id, source }) => ["--secret", `id=${id},src=${source}`]), "-t", composed.image, "-f", path.join(context, "Dockerfile"), context]);
  } catch (error) {
    throw new Error(`failed to build sandbox harness image (${composed.image}): ${declared.length ? "credentialed build failed (output withheld)" : error.message}${composed.note ? "; " + composed.note : ""}`);
  } finally {
    fs.rmSync(context, { recursive: true, force: true });
  }
  return composed.image;
}

/** Worker and verification share this resolver; explicit overrides always win. */
export function resolveSandboxImage({ cwd, explicitImage, defaultImage, config = null, run = defaultRun, trustedDir, onNote }) {
  if (explicitImage) return explicitImage;
  return ensureComposedImageBuilt(cwd, config, { run, trustedDir, onNote }) ?? defaultImage;
}

/** What each npm package's node_modules is right now: "link", "dir" or "none", by package dir ("." is the root). */
export function nodeModulesState(worktree, config) {
  const out = {};
  const node = nodeDependencyFiles(worktree, config);
  for (const dir of new Set([...node.packages, ...(node.links ?? [])])) {
    try { out[dir] = fs.lstatSync(path.join(worktree, dir, "node_modules")).isSymbolicLink() ? "link" : "dir"; } catch { out[dir] = "none"; }
  }
  return out;
}

/**
 * Packages whose node_modules became a real directory during the job. In
 * the sandbox nothing can install (no network), so a new real node_modules
 * means a tool ran outside it: a real Senti job on the Claude CLI ran
 * `npm install` on the host, replacing the dependency link with macOS
 * binaries, and verification then failed on them. The directories are
 * removed and the links restored so verification runs against the image
 * (they're never committed either way); the caller flags the job for review.
 */
export function repairHostInstalls(worktree, config, before) {
  const after = nodeModulesState(worktree, config);
  const replaced = Object.keys(after).filter((dir) => after[dir] === "dir" && before?.[dir] !== "dir");
  for (const dir of replaced) fs.rmSync(path.join(worktree, dir, "node_modules"), { recursive: true, force: true });
  if (replaced.length) linkNodePackages(worktree, config);
  return replaced.map((dir) => (dir === "." ? "node_modules" : `${dir}/node_modules`));
}

