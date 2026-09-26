import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { composeSandboxImage, ensureComposedImageBuilt } from "../lib/sandbox-images.mjs";
import { loadConfig, validateConfig } from "../lib/config.mjs";

const TOKEN = "registry-canary-123456789-secret";
function fixture(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), content);
  }
  const secret = path.join(root, "credential file");
  fs.writeFileSync(secret, TOKEN);
  const local = (registries) => {
    fs.writeFileSync(path.join(repo, ".nomarmy.local.yml"), YAML.stringify({ registries }));
    // Preview must remain credential-free even for invalid declarations. Each
    // build assertion below explicitly opts into the trusted checkout instead.
    const preview = composeSandboxImage(repo);
    assert.equal(preview?.dockerfile.includes("--mount=type=secret") ?? false, false);
  };
  return { root, repo, secret, local };
}
const npmFiles = { "package.json": "{}", "package-lock.json": "{}" };

test("registry declarations are local-only, validated and excluded from the loaded job contract", (t) => {
  const f = fixture(t, { ...npmFiles, ".nomarmy.yml": "{}" });
  f.local({ npm: f.secret });
  const baseline = loadConfig(f.repo);
  assert.deepEqual(Object.keys(baseline).sort(), ["config", "elevated", "found", "path"]);
  assert.equal(JSON.stringify(baseline).includes(f.secret), false);
  assert.equal(JSON.stringify(baseline).includes(TOKEN), false);
  assert.equal(Object.hasOwn(baseline.config, "registries"), false);
  const expected = "registries: allowed only in .nomarmy.local.yml, never in committed repository configuration";
  assert.deepEqual(validateConfig({ registries: {} }), {
    valid: false, config: null, errors: [expected], elevated: { shared: [], remote: [] },
  });
  for (const name of [".nomarmy.yml", ".nomarmy.yaml"]) {
    fs.writeFileSync(path.join(f.repo, name), "registries: {}\n");
    assert.throws(() => loadConfig(f.repo), { message: expected });
    assert.throws(() => composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo }), { message: expected });
    fs.writeFileSync(path.join(f.repo, name), "{}");
  }
});

test("registry paths reject inline values, malformed declarations, missing files and directories without echoing input", (t) => {
  const f = fixture(t, npmFiles);
  for (const declaration of [
    TOKEN, [], null, { npm: TOKEN }, { npm: { token: TOKEN } }, { unknown: f.secret },
    { npm: f.root }, { npm: path.join(f.root, "absent") },
    { pip: { netrc: f.secret, password: TOKEN } }, { go: f.secret },
    { go: { netrc: f.secret, private: "\$(echo unsafe)" } },
    { npm: f.secret + ",type=env" },
  ]) {
    f.local(declaration);
    assert.throws(() => loadConfig(f.repo), (error) => {
      assert.match(error.message, /^registries:/);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    });
  }
  fs.writeFileSync(path.join(f.repo, ".nomarmy.local.yml"), "registries: [\n" + TOKEN);
  assert.throws(() => composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo }), { message: "registries: cannot parse .nomarmy.local.yml" });
  f.local({ npm: "../credential file" });
  assert.match(composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo }).dockerfile, /--mount=type=secret,id=npm,/);
});

test("registry tilde expansion resolves only the path, never returns credential contents", (t) => {
  const f = fixture(t, npmFiles);
  // HOME remains untouched: resolve ~/../... to a synthetic fixture in tmpdir.
  const tilde = "~/" + path.relative(os.homedir(), f.secret);
  f.local({ npm: tilde });
  let buildArgs;
  ensureComposedImageBuilt(f.repo, null, { trustedDir: f.repo, run: (_cmd, args) => {
    if (args[0] === "images") return "";
    buildArgs = args;
    return "";
  } });
  assert.deepEqual(buildArgs.slice(0, 3), ["build", "--secret", "id=npm,src=" + f.secret]);
  assert.equal(JSON.stringify(buildArgs).includes(TOKEN), false);
  assertUntrustedBuild(f);
});

for (const [manager, lock, install] of [
  ["npm", "package-lock.json", "npm ci --no-audit --no-fund"],
  ["pnpm", "pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["yarn", "yarn.lock", "yarn install --frozen-lockfile"],
  ["bun", "bun.lock", "bun install --frozen-lockfile"],
]) {
  test("registry mount is confined to the " + manager + " install RUN", (t) => {
    const f = fixture(t, { "package.json": "{}", [lock]: "{}" });
    f.local({ npm: f.secret });
    const composed = composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo });
    assert.deepEqual(Object.keys(composed).sort(), ["dockerfile", "files", "image", "pathEntries"]);
    assert.equal(composed.dockerfile.startsWith("# syntax=docker/dockerfile:1\n"), true);
    const mounts = composed.dockerfile.split("\n").filter((line) => line.includes("--mount=type=secret"));
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].startsWith("RUN --mount=type=secret,id=npm,target=/home/node/.npmrc,uid=1000,required=true "), true);
    assert.equal(mounts[0].includes(install + " --ignore-scripts"), true);
    const lines = composed.dockerfile.split("\n");
    const next = lines[lines.indexOf(mounts[0]) + 1];
    const marker = manager === "npm" ? ".nomarmy-npm-ci-failed" : `.nomarmy-${manager}-install-failed`;
    assert.equal(mounts[0].includes(`|| touch ${marker}`), true);
    assert.equal(next, `RUN cd '/deps' && ((test ! -e /home/node/.npmrc && test ! -L /home/node/.npmrc) || { touch ${marker}; exit 1; }) && (${manager === "pnpm" ? "pnpm rebuild" : "npm rebuild"} || touch ${marker})`);
    assert.equal(mounts[0].endsWith(" >/dev/null 2>&1"), true);
    assert.equal(composed.dockerfile.includes(TOKEN), false);
    assert.equal(composed.dockerfile.includes(f.secret), false);
  });
}

for (const [manager, files, install] of [
  ["pip", { "requirements.txt": "example-private==1" }, "pip3 install --no-cache-dir --break-system-packages --only-binary=:all: -r /deps/requirements/req-0.txt"],
  ["pyproject", { "pyproject.toml": '[project]\nname="demo"\nversion="1"\ndependencies=[]' }, "python3 -c"],
  ["uv", { "pyproject.toml": "[project]\n", "uv.lock": "" }, "uv sync --frozen"],
  ["poetry", { "pyproject.toml": "[tool.poetry]\n", "poetry.lock": "" }, "poetry install --no-root"],
]) {
  test("registry Python " + manager + " install has build-only config and netrc mounts", (t) => {
    const f = fixture(t, files);
    for (const [declaration, target] of [[f.secret, "/etc/pip.conf"], [{ netrc: f.secret }, "/root/.netrc"]]) {
      f.local({ pip: declaration });
      if (manager === "poetry") {
        assert.throws(() => composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo }), {
          message: "registries: poetry installs can't be made build-free; use uv, or wheels via pip",
        });
        continue;
      }
      const composed = composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo });
      const lines = composed.dockerfile.split("\n").filter((line) => line.includes("--mount=type=secret"));
      assert.equal(lines.length, 1);
      assert.equal(lines[0].startsWith("RUN --mount=type=secret,id=pip,target=" + target + ",uid=0,required=true "), true);
      assert.equal(lines[0].includes(install), true);
      assert.equal((manager === "uv" ? composed.dockerfile : lines[0]).includes("--only-binary=:all:"), true);
      if (manager === "uv") assert.equal(lines[0].includes("pip3 install"), false);
      const allLines = composed.dockerfile.split("\n");
      if (manager === "pyproject") assert.equal(allLines[allLines.indexOf(lines[0]) - 1], "RUN python3 -m venv /deps/python/.venv");
      assert.equal(allLines[allLines.indexOf(lines[0]) + 1], `RUN (test ! -e ${target} && test ! -L ${target}) || { touch /deps/.nomarmy-pip-install-failed; exit 1; }`);
      assert.equal(lines[0].includes(`.nomarmy-${manager}-install-failed`), true);
      if (manager === "uv") assert.equal(lines[0].includes("uv sync --frozen --no-install-project --all-groups --no-build"), true);
      assert.equal(lines[0].endsWith(" >/dev/null 2>&1"), true);
      assert.equal(composed.dockerfile.includes(TOKEN), false);
      assert.equal(composed.dockerfile.includes(f.secret), false);
      assert.equal(composed.dockerfile.includes("COPY " + f.secret), false);
      assert.equal(composed.dockerfile.includes("ADD " + f.secret), false);
    }
  });
}

test("registry Go and cargo use exact mounts and private patterns only during download", (t) => {
  const f = fixture(t, { "go.mod": "module example.com/a\n", "Cargo.toml": '[package]\nname="a"\nversion="0.1.0"\n' });
  f.local({ go: { netrc: f.secret, private: "github.com/acme/*,example.com/private" }, cargo: f.secret });
  const recipe = composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo }).dockerfile;
  const lines = recipe.split("\n").filter((line) => line.includes("--mount=type=secret"));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].startsWith("RUN --mount=type=secret,id=go-netrc,target=/home/node/.netrc,uid=1000,required=true "), true);
  assert.equal(lines[0].includes("export GOPRIVATE='github.com/acme/*,example.com/private' GONOSUMDB='github.com/acme/*,example.com/private'; cd /deps/go && (go mod download"), true);
  assert.equal(lines[1].startsWith("RUN --mount=type=secret,id=cargo,target=/home/node/.cargo/credentials.toml,uid=1000,required=true "), true);
  assert.equal(lines[1].includes("cargo fetch"), true);
  assert.doesNotMatch(recipe, /^ENV (GOPRIVATE|GONOSUMDB)=/m);
  assert.equal(recipe.includes(TOKEN), false);
});

test("registry build uses only secret file args, exact isolated context and sanitized errors", (t) => {
  const f = fixture(t, { ...npmFiles, "go.mod": "module example.com/a\n", "requirements.txt": "example==1", "Cargo.toml": "[workspace]\n" });
  f.local({ npm: f.secret, pip: f.secret, go: { netrc: f.secret, private: "example.com/*" }, cargo: f.secret });
  let context, calls = [], contextFiles, contextContents, buildArgs;
  const run = (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === "images") return "";
    buildArgs = args;
    context = args.at(-1);
    contextFiles = fs.readdirSync(context, { recursive: true }).filter((rel) => fs.statSync(path.join(context, rel)).isFile()).sort();
    contextContents = contextFiles.map((rel) => fs.readFileSync(path.join(context, rel), "utf8"));
    throw new Error(TOKEN);
  };
  const expectedImage = composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo }).image;
  assert.throws(() => ensureComposedImageBuilt(f.repo, null, { run, trustedDir: f.repo }), {
    message: "failed to build sandbox harness image (" + expectedImage + "): credentialed build failed (output withheld)",
  });
  // Keep assertions outside the stub: the builder intentionally sanitizes ALL
  // thrown errors, including an AssertionError from a test double.
  assert.deepEqual(buildArgs, ["build",
    "--secret", "id=npm,src=" + f.secret, "--secret", "id=pip,src=" + f.secret,
    "--secret", "id=go-netrc,src=" + f.secret, "--secret", "id=cargo,src=" + f.secret,
    "-t", expectedImage, "-f", path.join(context, "Dockerfile"), context]);
  assert.deepEqual(contextFiles, ["Dockerfile", "go/go.mod", "node/package-lock.json", "node/package.json", "py/req-0.txt", "rust/Cargo.toml"]);
  for (const content of contextContents) {
    assert.equal(content.includes(TOKEN), false);
    assert.equal(content.includes(f.secret), false);
  }
  assert.equal(fs.existsSync(context), false);
  assert.equal(JSON.stringify(calls).includes(TOKEN), false);
  assert.deepEqual(calls.map(({ cmd, args }) => [cmd, args[0]]), [["podman", "images"], ["podman", "build"]]);
  assertUntrustedBuild(f);
});

test("registry tag hashes declarations and rotation without exposing secret bytes", (t) => {
  const f = fixture(t, npmFiles);
  f.local({ npm: f.secret });
  const first = composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo });
  const hash = crypto.createHash("sha256").update(first.dockerfile).update("\0");
  hash.update(JSON.stringify({
    ecosystem: "npm", source: f.secret, format: "config", privatePatterns: "",
    digest: crypto.createHash("sha256").update(TOKEN).digest("hex"),
  })).update("\0");
  for (const file of first.files) hash.update(file.source).update("\0").update(file.destination).update("\0").update("{}").update("\0");
  assert.equal(first.image, "openclaw-nomarmy-coder-deps-" + hash.digest("hex").slice(0, 8) + ":bookworm");
  assert.equal(composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo }).image, first.image);
  fs.writeFileSync(f.secret, TOKEN + "-rotated");
  const rotated = composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo });
  assert.notEqual(rotated.image, first.image);
  assert.notEqual(rotated.dockerfile, first.dockerfile);
  const other = path.join(f.root, "other");
  fs.copyFileSync(f.secret, other);
  f.local({ npm: other });
  assert.notEqual(composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo }).image, rotated.image);
  f.local({ npm: f.secret });
  fs.writeFileSync(path.join(f.repo, "package-lock.json"), '{"new-private-dependency":true}');
  assert.notEqual(composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo }).image, rotated.image);
  assert.equal(JSON.stringify(first).includes(TOKEN), false);
  assert.equal(JSON.stringify(first).includes(f.secret), false);
});

test("registry credential cannot enter the build context via a manifest, symlink or hardlink", (t) => {
  const f = fixture(t, npmFiles);
  f.local({ npm: f.secret });
  const lock = path.join(f.repo, "package-lock.json");
  for (const link of ["direct", "symlink", "hardlink"]) {
    fs.rmSync(lock, { force: true });
    if (link === "direct") {
      fs.writeFileSync(lock, TOKEN);
      f.local({ npm: lock });
    } else {
      f.local({ npm: f.secret });
      if (link === "symlink") fs.symlinkSync(f.secret, lock);
      else fs.linkSync(f.secret, lock);
    }
    assert.throws(() => ensureComposedImageBuilt(f.repo, null, { trustedDir: f.repo, run: () => assert.fail("must reject before Podman") }), {
      message: link === "symlink" ? "sandbox dependency source must be a repository-contained regular file (no absolute or escaping paths)" : "registries: a credential file cannot also be a build-context input",
    });
  }
});


test("registry Yarn Berry fails explicitly instead of pretending to read npmrc", (t) => {
  const f = fixture(t, { "package.json": "{}", "yarn.lock": "__metadata:\n  version: 8\n" });
  f.local({ npm: f.secret });
  assert.throws(() => composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo }), {
    message: "registries: Yarn Berry does not read .npmrc; private registry builds currently require Yarn Classic",
  });
});

test("registry Cargo indexes are copied as metadata but credentials remain mount-only", (t) => {
  const config = '[registries.private]\nindex = "sparse+https://registry.example.com/"\n';
  const f = fixture(t, { "Cargo.toml": "[workspace]\n", ".cargo/config.toml": config });
  f.local({ cargo: f.secret });
  const composed = composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo });
  assert.deepEqual(composed.files, [
    { source: "Cargo.toml", destination: "rust/Cargo.toml" },
    { source: ".cargo/config.toml", destination: "rust/.cargo/config.toml" },
  ]);
  const first = composed.image;
  fs.writeFileSync(path.join(f.repo, ".cargo/config.toml"), config + "# changed\n");
  assert.notEqual(composeSandboxImage(f.repo, null, undefined, { trustedDir: f.repo }).image, first);
  assert.equal(JSON.stringify(composed).includes(TOKEN), false);
});

function assertUntrustedBuild(f) {
  const notes = [];
  let buildArgs, dockerfile;
  ensureComposedImageBuilt(f.repo, null, { onNote: note => notes.push(note), run: (_cmd, args) => {
    if (args[0] === "images") return "";
    buildArgs = args;
    dockerfile = fs.readFileSync(args[args.indexOf("-f") + 1], "utf8");
    return "";
  } });
  assert.equal(buildArgs.includes("--secret"), false);
  assert.equal(dockerfile.includes("--mount=type=secret"), false);
  assert.deepEqual(notes, ["private-registry credentials were not used: this job changed dependency inputs (trusted checkout unavailable)"]);
}
