import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as images from "../lib/sandbox-images.mjs";
import { loadHarnesses } from "../lib/harnesses.mjs";

function repo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-compose-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
const nodeFiles = { "package.json": "{}", "package-lock.json": "{}" };
const layerNames = (dockerfile) => [...dockerfile.matchAll(/^# harness: (.+)$/gm)].map((m) => m[1]);

// Exercise the public resolver as well as the recipe: a first-match selector
// must fail even if a standalone composer looks correct.
test("mixed Go and nested Node: one cached image, exact context, PATH union and cleanup", (t) => {
  const dir = repo(t, { "go.mod": "module example.com/mixed\n", "ui/package.json": "{}", "ui/package-lock.json": "{}" });
  let context, recipe, builds = 0, cached = false;
  const run = (cmd, args) => {
    assert.equal(cmd, "podman");
    if (args[0] === "images") return cached ? "cached\n" : "";
    assert.equal(args[0], "build");
    builds++;
    context = args.at(-1);
    recipe = fs.readFileSync(path.join(context, "Dockerfile"), "utf8");
    assert.deepEqual(fs.readdirSync(context).sort(), ["Dockerfile", "node"]);
    assert.deepEqual(fs.readdirSync(path.join(context, "node/ui")).sort(), ["package-lock.json", "package.json"]);
    assert.equal(fs.readFileSync(path.join(context, "node/ui/package-lock.json"), "utf8"), "{}");
    cached = true;
    return "";
  };
  const options = { cwd: dir, defaultImage: "base", run };
  const tag = images.resolveSandboxImage(options);
  assert.deepEqual(layerNames(recipe), ["go", "node"]);
  assert.equal(recipe.split("FROM ").length - 1, 1);
  assert.ok(recipe.indexOf("ENV GO_VERSION=1.27.1") < recipe.indexOf("npm ci"));
  assert.match(recipe, /ENV GOPATH=\/home\/node\/go/);
  assert.match(recipe, /RUN cd \/deps\/ui && \(npm ci --no-audit --no-fund \|\| touch .nomarmy-npm-ci-failed\) && npm cache clean --force/);
  assert.deepEqual(images.sandboxPathEntries(dir), ["/usr/local/go/bin", "/home/node/go/bin", "/deps/node_modules/.bin"]);
  assert.equal(fs.existsSync(context), false);
  assert.equal(images.resolveSandboxImage(options), tag);
  assert.equal(builds, 1);
  assert.deepEqual(images.linkNodePackages(dir, null, { env: {} }), ["ui/node_modules"]);
  assert.equal(fs.readlinkSync(path.join(dir, "ui/node_modules")), "/deps/ui/node_modules");
});

test("single-ecosystem recipes preserve installers and resolution fallbacks", (t) => {
  const node = repo(t, nodeFiles);
  const python = repo(t, { "custom.txt": "requests==2.32.0\n" });
  const config = { environment: { python: { requirements: ["custom.txt"] } } };
  const n = images.composeSandboxImage(node);
  // Strip only composition's root reset and layer label; the old installer
  // recipe itself must be byte-for-byte the same.
  assert.equal(n.dockerfile.replace("USER root\n# harness: node\n", ""), images.dependencyDockerfile({ nodeFiles: Object.keys(nodeFiles), nodePackages: ["."] }));
  const p = images.composeSandboxImage(python, config);
  assert.equal(p.dockerfile.replace("USER root\n# harness: python\n", ""), images.dependencyDockerfile({ requirements: ["custom.txt"] }));
  assert.deepEqual(p.files, [{ source: "custom.txt", destination: "py/req-0.txt" }]);
  assert.deepEqual(p.pathEntries, []);
  const shrinkwrap = repo(t, { "package.json": "{}", "npm-shrinkwrap.json": "{}" });
  assert.deepEqual(layerNames(images.composeSandboxImage(shrinkwrap).dockerfile), ["node"]);
  for (const [file, name, paths] of [["go.mod", "go", ["/usr/local/go/bin", "/home/node/go/bin"]], ["Cargo.toml", "rust", ["/home/node/.cargo/bin"]]]) {
    const dir = repo(t, { [file]: "" });
    const composed = images.composeSandboxImage(dir);
    assert.deepEqual(layerNames(composed.dockerfile), [name]);
    assert.deepEqual(composed.pathEntries, paths);
    if (name === "rust") assert.match(composed.dockerfile, /USER node\nENV RUSTUP_HOME=\/home\/node\/.rustup[\s\S]*--profile minimal --default-toolchain stable/);
    assert.equal(images.resolveSandboxImage({ cwd: dir, defaultImage: "base", run: () => "cached" }), composed.image);
  }
  const empty = repo(t, {});
  assert.equal(images.composeSandboxImage(repo(t, { "package-lock.json": "{}" })), null);
  assert.equal(images.composeSandboxImage(node, { environment: { node: { install: false } } }), null);
  const never = () => assert.fail("must not build or inspect an image");
  assert.equal(images.resolveSandboxImage({ cwd: empty, defaultImage: "base", run: never }), "base");
  assert.equal(images.resolveSandboxImage({ cwd: node, explicitImage: "custom", defaultImage: "base", run: never }), "custom");
});

test("composition order honors after and declarative commands run as root with named failures", (t) => {
  const dir = repo(t, { ...nodeFiles, "requirements.txt": "requests\n", "go.mod": "", "Cargo.toml": "" });
  const harnesses = loadHarnesses().harnesses;
  harnesses.zeta = { after: ["node"], image: { apt: ["libexample-dev"], run: ["printf '%s\\n' 'first'\nprintf '%s\\n' 'second'", "exit 7"] } };
  harnesses.alpha = { after: ["zeta"], image: { apt: [], run: ["true"] } };
  const selection = { harnesses, matched: ["alpha", "node", "python", "rust", "zeta", "go"] };
  const composed = images.composeSandboxImage(dir, null, selection);
  assert.deepEqual(layerNames(composed.dockerfile), ["go", "rust", "python", "node", "zeta", "alpha"]);
  let user = "root";
  const commands = [];
  for (const line of composed.dockerfile.split("\n")) {
    if (line.startsWith("USER ")) user = line.slice(5);
    if (line.startsWith("RUN [")) { assert.equal(user, "root"); commands.push(JSON.parse(line.slice(4))); }
  }
  assert.equal(user, "node");
  assert.equal(commands.length, 4);
  assert.match(commands[0][2], /apt-get install -y --no-install-recommends/);
  assert.match(commands[0][2], /libexample-dev/);
  const success = spawnSync(commands[1][0], commands[1].slice(1), { encoding: "utf8" });
  assert.equal(success.status, 0);
  assert.equal(success.stdout, "first\nsecond\n");
  const failure = spawnSync(commands[2][0], commands[2].slice(1), { encoding: "utf8" });
  assert.equal(failure.status, 1);
  assert.equal(failure.stderr, "sandbox harness zeta failed\n");
  // after must override even the preferred ecosystem priority.
  harnesses.go.after = ["alpha"];
  assert.deepEqual(layerNames(images.composeSandboxImage(dir, null, selection).dockerfile), ["rust", "python", "node", "zeta", "alpha", "go"]);
});

test("composed tags hash recipe plus every copied path and content, not unrelated source", (t) => {
  const dir = repo(t, nodeFiles);
  const first = images.composeSandboxImage(dir);
  assert.deepEqual(Object.keys(first).sort(), ["dockerfile", "files", "image", "pathEntries"]);
  assert.deepEqual(first.files, [
    { source: "package.json", destination: "node/package.json" },
    { source: "package-lock.json", destination: "node/package-lock.json" },
  ]);
  const hash = crypto.createHash("sha256").update(first.dockerfile).update("\0");
  for (const file of first.files) hash.update(file.source).update("\0").update(file.destination).update("\0").update("{}").update("\0");
  assert.equal(first.image, `openclaw-nomarmy-coder-deps-${hash.digest("hex").slice(0, 8)}:bookworm`);
  assert.equal(images.composeSandboxImage(dir).image, first.image);
  fs.writeFileSync(path.join(dir, "unrelated.js"), "changed");
  assert.equal(images.composeSandboxImage(dir).image, first.image);
  fs.writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3}');
  assert.notEqual(images.composeSandboxImage(dir).image, first.image);
  const harnesses = loadHarnesses().harnesses;
  harnesses.extra = { after: [], image: { apt: [], run: ["true"] } };
  const selection = { harnesses, matched: ["node", "extra"] };
  const before = images.composeSandboxImage(dir, null, selection);
  harnesses.extra.image.run = ["echo changed"];
  const after = images.composeSandboxImage(dir, null, selection);
  assert.deepEqual(after.files, before.files);
  assert.notEqual(after.image, before.image);
  const python = repo(t, { "a.txt": "same", "b.txt": "same" });
  const pyConfig = (file) => ({ environment: { python: { requirements: [file] } } });
  const a = images.composeSandboxImage(python, pyConfig("a.txt")), b = images.composeSandboxImage(python, pyConfig("b.txt"));
  assert.equal(a.dockerfile, b.dockerfile);
  assert.notEqual(a.image, b.image);
});

test("composed build errors propagate and the isolated context is removed", (t) => {
  const dir = repo(t, { "go.mod": "", ...nodeFiles });
  let context;
  assert.throws(() => images.resolveSandboxImage({ cwd: dir, defaultImage: "base", run: (_cmd, args) => {
    if (args[0] === "images") return "";
    context = args.at(-1);
    throw new Error("build rejected");
  } }), /failed to build sandbox harness image .*build rejected/);
  assert.equal(fs.existsSync(context), false);
});
