// Verification for nomArmy's lazy, per-language sandbox image resolution.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LANGUAGE_IMAGES, detectPrimaryLanguage, ensureLanguageImageBuilt, resolveSandboxImage,
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
