// Verification for nomArmy's lazy, per-language sandbox image resolution.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LANGUAGE_IMAGES, detectPrimaryLanguage, ensureLanguageImageBuilt, resolveSandboxImage,
  pythonRequirementsFor, pythonImageTag, ensurePythonImageBuilt,
} from "../lib/sandbox-images.mjs";

function fakeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-sandbox-images-"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
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

test("resolveSandboxImage: a detected Go repo resolves to the Go image", () => {
  const dir = fakeRepo({ "go.mod": "module example.com/x\n" });
  const run = (cmd, args) => (args[0] === "images" ? "sha256:existing\n" : "");
  try {
    assert.equal(resolveSandboxImage({ cwd: dir, explicitImage: null, defaultImage: "default:image", run }), LANGUAGE_IMAGES.go.image);
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
    assert.equal(image, pythonImageTag(dir, ["requirements.txt"]));
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
