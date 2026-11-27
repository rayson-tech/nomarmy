import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { hostDepsRoot, hostDepsSupported, linkNodePackages, restoreSandboxLinks, sweepHostDeps, HOST_DEPS_MAX_IDLE_MS } from "../lib/sandbox-images.mjs";

const tmp = (t) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hostdeps-"))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const IMAGE = "openclaw-nomarmy-coder-deps-deadbeef:bookworm";
const COPY = "openclaw-nomarmy-coder-deps-deadbeef-bookworm";
const NOW = Date.parse("2026-11-27T12:00:00Z");
// A fake podman; async like lib/process.mjs's run, resolving { stdout }.
function podman({ failCp = false } = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args[0]);
    if (args[0] === "create") return { stdout: "ctr1\n" };
    if (args[0] === "cp") { if (failCp) throw new Error("cp failed"); fs.mkdirSync(path.join(args[2], "node_modules/yaml"), { recursive: true }); }
    return { stdout: "" };
  };
  return { run, calls };
}

test("hostDepsRoot copies the image's /deps once, reuses it, and accepts a synchronous run too", async (t) => {
  const cache = tmp(t), p = podman();
  const root = await hostDepsRoot(`localhost/${IMAGE}`, cache, { run: p.run, platform: "linux", now: NOW });
  assert.equal(root, path.join(cache, COPY, "deps"));
  assert.ok(fs.existsSync(path.join(root, "node_modules/yaml")));
  assert.deepEqual(p.calls, ["create", "cp", "rm"]);
  assert.equal(await hostDepsRoot(IMAGE, cache, { run: p.run, platform: "linux", now: NOW + 1000 }), root);
  assert.deepEqual(p.calls, ["create", "cp", "rm"], "the second job reuses the copy");
  assert.equal(fs.statSync(path.join(cache, COPY, ".complete")).mtimeMs, NOW + 1000, "each use marks the copy as used");
  assert.deepEqual(fs.readdirSync(cache).filter((n) => n.startsWith(".staging")), []);
  const sync = tmp(t);
  const syncRun = (cmd, args) => { if (args[0] === "create") return "ctr2\n"; if (args[0] === "cp") fs.mkdirSync(path.join(args[2], "node_modules"), { recursive: true }); return ""; };
  assert.equal(await hostDepsRoot(IMAGE, sync, { run: syncRun, platform: "linux" }), path.join(sync, COPY, "deps"));
});

test("hostDepsRoot declines non-Linux hosts and images without dependencies", async (t) => {
  const run = () => { throw new Error("must not run podman"); };
  assert.equal(await hostDepsRoot(IMAGE, tmp(t), { run, platform: "darwin" }), null);
  assert.equal(await hostDepsRoot("openclaw-nomarmy-coder:bookworm", tmp(t), { run, platform: "linux" }), null);
  assert.equal(await hostDepsRoot(null, tmp(t), { run, platform: "linux" }), null);
  assert.equal(hostDepsSupported("linux"), true);
  assert.equal(hostDepsSupported("darwin"), false);
  assert.equal(hostDepsSupported("win32"), false);
});

test("a failed copy leaves no partial cache and removes the container", async (t) => {
  const cache = tmp(t), p = podman({ failCp: true });
  await assert.rejects(hostDepsRoot(IMAGE, cache, { run: p.run, platform: "linux" }), /cp failed/);
  assert.deepEqual(p.calls, ["create", "cp", "rm"]);
  assert.deepEqual(fs.readdirSync(cache), []);
});

test("a copy a crash left half-done is replaced, not trusted and not a permanent failure", async (t) => {
  const cache = tmp(t);
  fs.mkdirSync(path.join(cache, COPY, "deps/node_modules/half"), { recursive: true }); // no .complete
  const p = podman();
  const root = await hostDepsRoot(IMAGE, cache, { run: p.run, platform: "linux", now: NOW });
  assert.deepEqual(p.calls, ["create", "cp", "rm"]);
  assert.ok(fs.existsSync(path.join(root, "node_modules/yaml")));
  assert.equal(fs.existsSync(path.join(root, "node_modules/half")), false);
});

test("sweepHostDeps removes copies unused for a week and leftover staging, never the one in use", (t) => {
  const cache = tmp(t);
  const copy = (name, usedAt) => { fs.mkdirSync(path.join(cache, name, "deps"), { recursive: true }); fs.writeFileSync(path.join(cache, name, ".complete"), "x"); fs.utimesSync(path.join(cache, name, ".complete"), new Date(usedAt), new Date(usedAt)); };
  const old = NOW - HOST_DEPS_MAX_IDLE_MS - 1;
  copy("openclaw-nomarmy-coder-deps-00000001-bookworm", old);
  copy("openclaw-nomarmy-coder-deps-00000002-bookworm", NOW - 3600000);
  copy(COPY, old);
  fs.mkdirSync(path.join(cache, ".staging-abc")); fs.utimesSync(path.join(cache, ".staging-abc"), new Date(old), new Date(old));
  fs.mkdirSync(path.join(cache, ".staging-new")); fs.utimesSync(path.join(cache, ".staging-new"), new Date(NOW), new Date(NOW));
  const removed = sweepHostDeps(cache, { keep: path.join(cache, COPY), now: NOW }).sort();
  assert.deepEqual(removed, [".staging-abc", "openclaw-nomarmy-coder-deps-00000001-bookworm"]);
  assert.deepEqual(fs.readdirSync(cache).sort(), [".staging-new", "openclaw-nomarmy-coder-deps-00000002-bookworm", COPY].sort(), "a recent copy, a copy in progress, and the kept one stay");
  assert.deepEqual(sweepHostDeps(path.join(cache, "missing")), []);
});

test("workspace links point at the host copy, then back at /deps for verification", (t) => {
  const wt = tmp(t), deps = path.join(tmp(t), "deps");
  fs.writeFileSync(path.join(wt, "package.json"), JSON.stringify({ name: "r", workspaces: ["cli"] }));
  fs.writeFileSync(path.join(wt, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  fs.mkdirSync(path.join(wt, "cli")); fs.writeFileSync(path.join(wt, "cli/package.json"), JSON.stringify({ name: "cli" }));
  const made = linkNodePackages(wt, null, { depsRoot: deps, env: {} });
  assert.ok(made.includes("node_modules"), JSON.stringify(made));
  assert.equal(fs.readlinkSync(path.join(wt, "node_modules")), `${deps}/node_modules`);
  restoreSandboxLinks(wt, null, deps);
  assert.equal(fs.readlinkSync(path.join(wt, "node_modules")), "/deps/node_modules");
});

test("restoreSandboxLinks leaves links it didn't make, and real directories, alone", (t) => {
  const wt = tmp(t), deps = path.join(tmp(t), "deps");
  fs.writeFileSync(path.join(wt, "package.json"), JSON.stringify({ name: "r", workspaces: ["cli", "web"] }));
  fs.writeFileSync(path.join(wt, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  for (const d of ["cli", "web"]) { fs.mkdirSync(path.join(wt, d)); fs.writeFileSync(path.join(wt, d, "package.json"), JSON.stringify({ name: d })); }
  fs.symlinkSync("/elsewhere/node_modules", path.join(wt, "cli", "node_modules"), "dir");
  fs.mkdirSync(path.join(wt, "web", "node_modules"));
  linkNodePackages(wt, null, { depsRoot: deps, env: {} });
  restoreSandboxLinks(wt, null, deps);
  assert.equal(fs.readlinkSync(path.join(wt, "cli", "node_modules")), "/elsewhere/node_modules");
  assert.equal(fs.lstatSync(path.join(wt, "web", "node_modules")).isDirectory(), true);
});

test("live podman: a host-tools worker resolves packages from the copy", { skip: !process.env.LIVE_PODMAN && "set LIVE_PODMAN=1" }, async (t) => {
  const root = await hostDepsRoot(IMAGE, tmp(t), { platform: "linux" });
  const wt = tmp(t);
  fs.writeFileSync(path.join(wt, "package.json"), JSON.stringify({ name: "r" }));
  fs.writeFileSync(path.join(wt, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  linkNodePackages(wt, null, { depsRoot: root, env: {} });
  restoreSandboxLinks(wt, null, root);
  assert.equal(fs.existsSync(path.join(wt, "node_modules")), false, "a plain root package goes back to /node_modules in the sandbox");
  linkNodePackages(wt, null, { depsRoot: root, env: {} });
  assert.ok(createRequire(path.join(wt, "x.js")).resolve("yaml"));
});
