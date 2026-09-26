// Verification for nomArmy's lazy, per-language sandbox image resolution.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as images from "../lib/sandbox-images.mjs";

import {
  LANGUAGE_IMAGES, detectPrimaryLanguage, ensureLanguageImageBuilt, resolveSandboxImage,
  pythonRequirementsFor, pythonImageTag, ensurePythonImageBuilt,
  nodeDependencyFiles, ensureDependencyImageBuilt, dependencyImageTag, EXEC_PATH_PREPEND, NODE_DEPS_BIN,
  dependencyDockerfile, linkNodePackages, nodeModulesState, repairHostInstalls,
} from "../lib/sandbox-images.mjs";

function fakeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-sandbox-images-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test("detectPrimaryLanguage: recognizes go.mod", () => {
  const dir = fakeRepo({ "go.mod": "module example.com/x\n" });
  try {
    assert.equal(detectPrimaryLanguage(dir), "go");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectPrimaryLanguage: recognizes Cargo.toml", () => {
  const dir = fakeRepo({ "Cargo.toml": "[package]\nname = \"x\"\n" });
  try {
    assert.equal(detectPrimaryLanguage(dir), "rust");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectPrimaryLanguage: a Node/Python repo (neither marker) is null, not misdetected", () => {
  const dir = fakeRepo({ "package.json": "{}" });
  try {
    assert.equal(detectPrimaryLanguage(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectPrimaryLanguage: missing/invalid cwd is null, never throws", () => {
  assert.equal(detectPrimaryLanguage(null), null);
  assert.equal(detectPrimaryLanguage(path.join(os.tmpdir(), "does-not-exist-nomarmy-xyz")), null);
});

test("ensureLanguageImageBuilt: a no-op when the image already exists -- never calls build", () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args].join(" ")); return "sha256:existing\n"; };
  const image = ensureLanguageImageBuilt("go", { run });
  assert.equal(image, LANGUAGE_IMAGES.go.image);
  assert.equal(calls.length, 1, "only the existence check should run");
  assert.match(calls[0], /^podman images -q/);
});

test("ensureLanguageImageBuilt: builds with the right Dockerfile and context when missing", () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "images") return "";
    return "";
  };
  const image = ensureLanguageImageBuilt("rust", { run });
  assert.equal(image, LANGUAGE_IMAGES.rust.image);
  const build = calls.find((c) => c[1] === "build");
  assert.ok(build, "must call podman build");
  assert.ok(build.includes("-t"));
  assert.ok(build.includes(LANGUAGE_IMAGES.rust.image));
  assert.ok(build.some((a) => a.endsWith("Dockerfile.rust")));
});

test("ensureLanguageImageBuilt: a failed build throws with a clear reason, not a generic error", () => {
  const run = (cmd, args) => {
    if (args[0] === "images") return "";
    throw new Error("podman build exited 1");
  };
  assert.throws(() => ensureLanguageImageBuilt("go", { run }), /failed to build the go sandbox image.*podman build exited 1/s);
});

test("ensureLanguageImageBuilt: an unknown language is rejected up front", () => {
  assert.throws(() => ensureLanguageImageBuilt("cobol", { run: () => "" }), /unknown sandbox language/);
});

test("resolveSandboxImage: an explicit image always wins, no detection or build attempted", () => {
  const dir = fakeRepo({ "go.mod": "module example.com/x\n" });
  const run = () => { throw new Error("must not be called"); };
  try {
    assert.equal(resolveSandboxImage({ cwd: dir, explicitImage: "custom:image", defaultImage: "default:image", run }), "custom:image");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxImage: no language detected falls back to defaultImage untouched", () => {
  const dir = fakeRepo({ "package.json": "{}" });
  const run = () => { throw new Error("must not be called"); };
  try {
    assert.equal(resolveSandboxImage({ cwd: dir, explicitImage: null, defaultImage: "default:image", run }), "default:image");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxImage: a detected Go repo resolves to the composed image", () => {
  const dir = fakeRepo({ "go.mod": "module example.com/x\n" });
  const run = (cmd, args) => (args[0] === "images" ? "sha256:existing\n" : "");
  try {
    assert.equal(resolveSandboxImage({ cwd: dir, explicitImage: null, defaultImage: "default:image", run }), images.composeSandboxImage(dir).image);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Python: unlike Go/Rust, dependencies are the repo's own, not the
// toolchain's, so the image is built from the worktree and tagged by a hash
// of the requirements content, not a fixed name.
// ---------------------------------------------------------------------------

test("pythonRequirementsFor: bare requirements.txt is used when nothing is declared", () => {
  const dir = fakeRepo({ "requirements.txt": "boto3\n" });
  try {
    assert.deepEqual(pythonRequirementsFor(dir, null), ["requirements.txt"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pythonRequirementsFor: no requirements.txt and nothing declared is genuinely nothing, not a guess", () => {
  const dir = fakeRepo({ "pyproject.toml": "[project]\nname = \"x\"\n" });
  try {
    assert.deepEqual(pythonRequirementsFor(dir, null), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pythonRequirementsFor: environment.python.requirements overrides the bare-file default", () => {
  const dir = fakeRepo({ "requirements.txt": "ignored\n" });
  const config = { environment: { python: { requirements: ["requirements-dev.txt", "lambda/requirements.txt"] } } };
  try {
    assert.deepEqual(pythonRequirementsFor(dir, config), ["requirements-dev.txt", "lambda/requirements.txt"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectPrimaryLanguage: a bare requirements.txt is detected as python", () => {
  const dir = fakeRepo({ "requirements.txt": "boto3\n" });
  try {
    assert.equal(detectPrimaryLanguage(dir, null), "python");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectPrimaryLanguage: declared environment.python.requirements is detected as python even with no requirements.txt", () => {
  const dir = fakeRepo({ "lambda-src.py": "# not a requirements file\n" });
  const config = { environment: { python: { requirements: ["lambda/requirements.txt"] } } };
  try {
    assert.equal(detectPrimaryLanguage(dir, config), "python");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pythonImageTag: deterministic for the same content, changes when a requirements file's content changes", () => {
  const dir = fakeRepo({ "requirements.txt": "boto3==1.0\n" });
  try {
    const tagA = pythonImageTag(dir, ["requirements.txt"]);
    const tagB = pythonImageTag(dir, ["requirements.txt"]);
    assert.equal(tagA, tagB, "same content must hash the same every time");
    assert.match(tagA, /^openclaw-nomarmy-coder-python-[0-9a-f]{8}:bookworm$/);
    fs.writeFileSync(path.join(dir, "requirements.txt"), "boto3==2.0\n");
    const tagC = pythonImageTag(dir, ["requirements.txt"]);
    assert.notEqual(tagA, tagC, "a dependency change must be a different tag, not a stale cache hit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensurePythonImageBuilt: nothing to install returns null, never a fabricated image", () => {
  const dir = fakeRepo({ "package.json": "{}" });
  const run = () => { throw new Error("must not be called"); };
  try {
    assert.equal(ensurePythonImageBuilt(dir, null, { run }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensurePythonImageBuilt: a no-op when the tagged image already exists -- never calls build", () => {
  const dir = fakeRepo({ "requirements.txt": "boto3\n" });
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return "sha256:existing\n"; };
  try {
    const image = ensurePythonImageBuilt(dir, null, { run });
    assert.equal(image, pythonImageTag(dir, ["requirements.txt"]));
    assert.equal(calls.length, 1, "only the existence check should run");
    assert.equal(calls[0][1], "images");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensurePythonImageBuilt: builds with the worktree as context and a generated Dockerfile that COPYs the real paths", () => {
  const dir = fakeRepo({});
  fs.mkdirSync(path.join(dir, "lambda"), { recursive: true });
  fs.writeFileSync(path.join(dir, "requirements-dev.txt"), "pytest\n");
  fs.writeFileSync(path.join(dir, "lambda", "requirements.txt"), "boto3\n");
  const config = { environment: { python: { requirements: ["requirements-dev.txt", "lambda/requirements.txt"] } } };
  const calls = [];
  let dockerfileContent = null;
  const run = (cmd, args) => {
    calls.push(args);
    if (args[0] === "images") return "";
    if (args[0] === "build") dockerfileContent = fs.readFileSync(args[args.indexOf("-f") + 1], "utf8");
    return "";
  };
  try {
    const image = ensurePythonImageBuilt(dir, config, { run });
    assert.equal(image, pythonImageTag(dir, ["requirements-dev.txt", "lambda/requirements.txt"]));
    const build = calls.find((a) => a[0] === "build");
    assert.ok(build, "must call podman build");
    assert.equal(build[build.length - 1], dir, "the worktree itself must be the build context, so COPY can reach real paths");
    assert.match(dockerfileContent, /COPY requirements-dev\.txt \/tmp\/reqs\/req-0\.txt/);
    assert.match(dockerfileContent, /COPY lambda\/requirements\.txt \/tmp\/reqs\/req-1\.txt/);
    assert.match(dockerfileContent, /pip3 install --no-cache-dir --break-system-packages -r \/tmp\/reqs\/req-0\.txt -r \/tmp\/reqs\/req-1\.txt/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensurePythonImageBuilt: a failed build throws with a clear reason, not a generic error", () => {
  const dir = fakeRepo({ "requirements.txt": "boto3\n" });
  const run = (cmd, args) => {
    if (args[0] === "images") return "";
    throw new Error("pip install exited 1: no matching distribution");
  };
  try {
    assert.throws(() => ensurePythonImageBuilt(dir, null, { run }), /failed to build the python sandbox image.*no matching distribution/s);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxImage: a Python repo with real dependencies resolves to its own dependency image", () => {
  const dir = fakeRepo({ "requirements.txt": "boto3\n" });
  const run = (cmd, args) => (args[0] === "images" ? "sha256:existing\n" : "");
  try {
    const image = resolveSandboxImage({ cwd: dir, explicitImage: null, defaultImage: "default:image", run });
    assert.equal(image, images.composeSandboxImage(dir).image);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSandboxImage: a Python repo with nothing to install still gets the default image, unchanged", () => {
  const dir = fakeRepo({ "pyproject.toml": "[project]\nname = \"x\"\n" });
  const run = () => { throw new Error("must not be called"); };
  try {
    assert.equal(resolveSandboxImage({ cwd: dir, explicitImage: null, defaultImage: "default:image", run }), "default:image");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nodeDependencyFiles: package.json plus an npm lockfile installs; other lockfiles, workspaces and opt-out say why not", () => {
  const cases = [
    [{ "package.json": "{}", "package-lock.json": "{}" }, null, ["package.json", "package-lock.json"], null],
    [{ "package.json": "{}", "npm-shrinkwrap.json": "{}" }, null, ["package.json", "npm-shrinkwrap.json"], null],
    [{ "package.json": "{}" }, null, [], "no package-lock.json"],
    [{ "package.json": "{}", "pnpm-lock.yaml": "" }, null, [], "pnpm-lock.yaml isn't supported yet (npm lockfiles only)"],
    [{ "package.json": JSON.stringify({ workspaces: ["pkgs/*"] }), "package-lock.json": "{}" }, null, [], "npm workspaces aren't supported yet"],
    [{ "package.json": "{}", "package-lock.json": "{}" }, { environment: { node: { install: false } } }, [], "environment.node.install is false"],
  ];
  for (const [files, config, expected, reason] of cases) {
    const dir = fakeRepo(files);
    try {
      const got = nodeDependencyFiles(dir, config);
      assert.deepEqual({ files: got.files, reason: got.reason }, { files: expected, reason }, JSON.stringify(files));
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("detectPrimaryLanguage: a Node repo with a lockfile is node; with Python requirements too, python+node", () => {
  const node = fakeRepo({ "package.json": "{}", "package-lock.json": "{}" });
  const both = fakeRepo({ "package.json": "{}", "package-lock.json": "{}", "requirements.txt": "boto3\n" });
  try {
    assert.equal(detectPrimaryLanguage(node, null), "node");
    assert.equal(detectPrimaryLanguage(both, null), "python+node");
    assert.deepEqual(EXEC_PATH_PREPEND.node, [NODE_DEPS_BIN]);
  } finally { for (const d of [node, both]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("ensureDependencyImageBuilt: builds from a context of only the dependency files, tagged by their hash, once", () => {
  const dir = fakeRepo({ "package.json": "{}", "package-lock.json": '{"lockfileVersion":3}', "requirements.txt": "boto3\n", "big.js": "x" });
  const calls = [];
  let built = false, context = null;
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "images") return built ? "abc123\n" : "";
    if (args[0] === "build") { built = true; context = fs.readdirSync(args[args.length - 1]).sort(); const df = fs.readFileSync(args[args.indexOf("-f") + 1], "utf8"); assert.match(df, /npm ci/); assert.match(df, /pip3 install/); assert.match(df, /ln -s \/deps\/node_modules \/node_modules/); }
    return "";
  };
  try {
    const image = ensureDependencyImageBuilt(dir, null, { run });
    assert.equal(image, dependencyImageTag(dir, ["requirements.txt", "package.json", "package-lock.json"]));
    assert.match(image, /^openclaw-nomarmy-coder-deps-[0-9a-f]{8}:bookworm$/);
    assert.deepEqual(context, ["Dockerfile", "node", "py"], "never the repo itself");
    assert.equal(ensureDependencyImageBuilt(dir, null, { run }), image);
    assert.equal(calls.filter((c) => c[1] === "build").length, 1, "cached after the first build");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("nodeDependencyFiles: every package with its own npm lockfile installs, not just the root (the Senti ui/ + lambda/ layout)", () => {
  const dir = fakeRepo({
    "package.json": "{}", "package-lock.json": "{}",
    "ui/package.json": "{}", "ui/package-lock.json": "{}",
    "lambda/mcp_server/package.json": "{}", "lambda/mcp_server/package-lock.json": "{}",
    "lambda/mcp_server/widgets/package.json": "{}", "lambda/mcp_server/widgets/package-lock.json": "{}",
    "web/package.json": "{}", "web/yarn.lock": "",
    "ws/package.json": JSON.stringify({ workspaces: ["a"] }), "ws/package-lock.json": "{}",
    "node_modules/dep/package.json": "{}", "node_modules/dep/package-lock.json": "{}",
  });
  try {
    const got = nodeDependencyFiles(dir, null);
    assert.deepEqual(got.packages, [".", "lambda/mcp_server", "lambda/mcp_server/widgets", "ui"]);
    assert.ok(got.files.includes("ui/package-lock.json") && got.files.includes("lambda/mcp_server/widgets/package.json"));
    assert.deepEqual(got.skipped, [{ dir: "ws", reason: "npm workspaces aren't supported yet" }], "a lockfile-less yarn package isn't a lockfile dir at all; node_modules is never searched");
    // No root package at all: the others still install.
    const noRoot = fakeRepo({ "ui/package.json": "{}", "ui/package-lock.json": "{}" });
    try { assert.deepEqual(nodeDependencyFiles(noRoot, null).packages, ["ui"]); } finally { fs.rmSync(noRoot, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("dependencyDockerfile: each package installs at its repo path under /deps as the sandbox user; a failed install leaves a marker, not a failed image", () => {
  const df = dependencyDockerfile({ nodeFiles: ["package.json", "package-lock.json", "ui/package.json", "ui/package-lock.json"], nodePackages: [".", "ui"] });
  assert.match(df, /COPY --chown=node:node node\/ui\/package-lock\.json \/deps\/ui\/package-lock\.json/);
  assert.match(df, /RUN cd \/deps && \(npm ci --no-audit --no-fund \|\| touch \.nomarmy-npm-ci-failed\)/);
  assert.match(df, /RUN cd \/deps\/ui && \(npm ci/);
  assert.ok(df.indexOf("USER node") < df.indexOf("npm ci"), "installed as the sandbox user");
  assert.match(df, /ln -s \/deps\/node_modules \/node_modules/);
  assert.doesNotMatch(df, /chown -R/, "no chown layer doubling the image");
  assert.doesNotMatch(dependencyDockerfile({ nodeFiles: ["ui/package.json", "ui/package-lock.json"], nodePackages: ["ui"] }), /ln -s/, "no root package, no /node_modules link");
});

test("linkNodePackages: each non-root package gets a node_modules link into the image, never over an existing one, and not with a custom image", () => {
  const dir = fakeRepo({ "package.json": "{}", "package-lock.json": "{}", "ui/package.json": "{}", "ui/package-lock.json": "{}", "api/package.json": "{}", "api/package-lock.json": "{}", "api/node_modules/.keep": "" });
  try {
    assert.deepEqual(linkNodePackages(dir, null, { env: {} }), ["ui/node_modules"]);
    assert.equal(fs.readlinkSync(path.join(dir, "ui", "node_modules")), "/deps/ui/node_modules");
    assert.ok(fs.lstatSync(path.join(dir, "api", "node_modules")).isDirectory(), "an existing node_modules is left alone");
    assert.equal(fs.existsSync(path.join(dir, "node_modules")), false, "the root uses /node_modules, so the worktree root is untouched");
    assert.deepEqual(linkNodePackages(dir, null, { env: {} }), [], "idempotent");
    const custom = fakeRepo({ "ui/package.json": "{}", "ui/package-lock.json": "{}" });
    try { assert.deepEqual(linkNodePackages(custom, null, { env: { NOMARMY_AGENT_IMAGE: "mine:latest" } }), []); } finally { fs.rmSync(custom, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("repairHostInstalls: a node_modules that became a real directory during the job is removed and relinked; one that was already real is left alone", () => {
  const dir = fakeRepo({ "package.json": "{}", "package-lock.json": "{}", "ui/package.json": "{}", "ui/package-lock.json": "{}", "api/package.json": "{}", "api/package-lock.json": "{}", "api/node_modules/own/index.js": "" });
  try {
    linkNodePackages(dir, null, { env: {} });
    const before = nodeModulesState(dir, null);
    assert.deepEqual(before, { ".": "none", api: "dir", ui: "link" });
    // What the Claude CLI did on the host: npm install replaced the link with macOS binaries, and made a root one.
    fs.rmSync(path.join(dir, "ui", "node_modules"));
    fs.mkdirSync(path.join(dir, "ui", "node_modules", "@rollup", "rollup-darwin-arm64"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
    const replaced = repairHostInstalls(dir, null, before);
    assert.deepEqual(replaced.sort(), ["node_modules", "ui/node_modules"]);
    assert.equal(fs.readlinkSync(path.join(dir, "ui", "node_modules")), "/deps/ui/node_modules", "the link is back");
    assert.equal(fs.existsSync(path.join(dir, "node_modules")), false, "the root's host install is gone; /node_modules serves the root");
    assert.ok(fs.existsSync(path.join(dir, "api", "node_modules", "own", "index.js")), "a node_modules that was there before the job is never touched");
    assert.deepEqual(repairHostInstalls(dir, null, nodeModulesState(dir, null)), [], "nothing to do the second time");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
