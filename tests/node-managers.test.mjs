import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { composeSandboxImage, ensureComposedImageBuilt, nodeDependencyFiles, linkNodePackages, nodeModulesState } from "../lib/sandbox-images.mjs";
import { loadHarnesses, matchHarnesses } from "../lib/harnesses.mjs";

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-managers-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}
const cases = [
  ["pnpm", "pnpm-lock.yaml", "", "pnpm install --frozen-lockfile", "pnpm"],
  ["yarn", "yarn.lock", "", "yarn install --frozen-lockfile", "yarn"],
  ["berry", "yarn.lock", "__metadata:\n  version: 8\n", "YARN_NODE_LINKER=node-modules yarn install --immutable", "yarn-berry"],
  ["berry-config", "yarn.lock", "", "YARN_NODE_LINKER=node-modules yarn install --immutable", "yarn-berry"],
  ["bun", "bun.lock", "{}", "bun install --frozen-lockfile", "bun"],
  ["bun-binary", "bun.lockb", "binary", "bun install --frozen-lockfile", "bun"],
  ["npm", "package-lock.json", "{}", "npm ci --no-audit --no-fund", "npm"],
  ["shrinkwrap", "npm-shrinkwrap.json", "{}", "npm ci --no-audit --no-fund", "npm"],
];
for (const [name, lock, content, command, manager] of cases) {
  test("manager recipe: " + name, (t) => {
    const root = fixture(t, { "app/package.json": JSON.stringify({ packageManager: manager.startsWith("yarn") ? (manager === "yarn" ? "yarn@1.22.22" : "yarn@4.5.0") : manager + "@1.0.0" }),
      ["app/" + lock]: content, ...(name === "berry-config" ? { "app/.yarnrc.yml": "nodeLinker: pnp\n" } : {}) });
    assert.deepEqual(matchHarnesses(root, loadHarnesses().harnesses), ["node"]);
    assert.deepEqual(nodeDependencyFiles(root).installs, [{ dir: "app", manager, yarnFallback: null }]);
    const recipe = composeSandboxImage(root);
    const marker = manager === "npm" ? ".nomarmy-npm-ci-failed" : ".nomarmy-" + manager + "-install-failed";
    const install = "RUN cd " + (manager === "npm" ? "/deps/app" : "'/deps/app'") + " && (" + command + " || touch " + marker + ")" + (manager === "npm" ? " && npm cache clean --force" : "");
    assert.deepEqual(recipe.dockerfile.split("\n").filter((line) => line.startsWith("RUN cd ")), [install]);
    assert.equal(recipe.dockerfile.slice(0, recipe.dockerfile.indexOf(install)).trimEnd().endsWith("USER node"), true);
    if (manager.startsWith("yarn") || manager === "pnpm") assert.equal(recipe.dockerfile.includes("RUN npm install -g corepack && corepack enable"), true);
    if (manager === "bun") assert.equal(recipe.dockerfile.includes("RUN npm install -g bun"), true);
    let builds = 0;
    assert.equal(ensureComposedImageBuilt(root, null, { run(cmd, args) {
      assert.equal(cmd, "podman");
      if (args[0] === "images") return "";
      assert.equal(args[0], "build"); builds++;
      const context = args.at(-1);
      assert.equal(fs.readFileSync(path.join(context, "node/app", lock), "utf8"), content);
      return "";
    } }), recipe.image);
    assert.equal(builds, 1);
    fs.appendFileSync(path.join(root, "app", lock), "\n");
    assert.notEqual(composeSandboxImage(root).image, recipe.image);
  });
}

for (const manager of ["npm", "pnpm"]) test("workspace recipe and links: " + manager, (t) => {
  const lock = manager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
  const root = fixture(t, {
    "package.json": JSON.stringify(manager === "npm" ? { workspaces: { packages: ["packages/**", "!packages/excluded"] } } : {}),
    [lock]: "{}",
    ...(manager === "pnpm" ? { "pnpm-workspace.yaml": "packages:\n  - 'packages/**'\n  - '!packages/excluded'\n" } : {}),
    "packages/a/package.json": '{"name":"a"}', ["packages/a/" + lock]: "{}",
    "packages/nested/b/package.json": '{"name":"b"}',
    "packages/excluded/package.json": "{}",
  });
  const found = nodeDependencyFiles(root);
  assert.deepEqual(Object.keys(found).sort(), ["files", "installs", "links", "packages", "reason", "skipped"]);
  assert.deepEqual(found.packages, ["."]);
  assert.deepEqual(found.links, [".", "packages/a", "packages/nested/b"]);
  assert.deepEqual(found.files, ["package.json", lock, ...(manager === "pnpm" ? ["pnpm-workspace.yaml"] : []), "packages/a/package.json", "packages/nested/b/package.json"]);
  const recipe = composeSandboxImage(root);
  assert.equal(recipe.dockerfile.split("\n").filter((line) => line.startsWith("RUN cd ")).length, 1);
  assert.equal(recipe.dockerfile.includes("RUN ln -s /deps/node_modules /node_modules"), true);
  assert.equal(recipe.dockerfile.includes("ENV PATH=/deps/node_modules/.bin:$PATH"), true);
  assert.deepEqual(recipe.files.map(({ source, destination }) => [source, destination]), found.files.map((f) => [f, "node/" + f]));
  assert.deepEqual(linkNodePackages(root, null, { env: {} }), ["node_modules", "packages/a/node_modules", "packages/nested/b/node_modules"]);
  for (const dir of found.links) {
    const target = dir === "." ? "/deps/node_modules" : "/deps/" + dir + "/node_modules";
    assert.equal(fs.readlinkSync(path.join(root, dir, "node_modules")), target);
  }
  assert.deepEqual(nodeModulesState(root), { ".": "link", "packages/a": "link", "packages/nested/b": "link" });
  // Emulate the image's /deps tree under tmp, preserving pnpm's relative
  // store links; rebase only the absolute mount prefix (no host /deps writes).
  const deps = fixture(t, { "node_modules/.pnpm/example/node_modules/example/index.js": "module.exports = 42;\n" });
  for (const dir of found.links) {
    fs.mkdirSync(path.join(deps, dir, "node_modules"), { recursive: true });
    const link = path.join(root, dir, "node_modules");
    const destination = fs.readlinkSync(link).replace(/^\/deps/, deps);
    fs.unlinkSync(link); fs.symlinkSync(destination, link);
  }
  fs.symlinkSync(path.relative(path.join(deps, "packages/nested/b/node_modules"), path.join(deps, "node_modules/.pnpm/example/node_modules/example")), path.join(deps, "packages/nested/b/node_modules/example"));
  assert.equal(createRequire(path.join(root, "packages/nested/b/package.json"))("example"), 42);
  for (const file of found.files) {
    const before = composeSandboxImage(root).image;
    fs.appendFileSync(path.join(root, file), " ");
    assert.notEqual(composeSandboxImage(root).image, before, file);
  }
});
