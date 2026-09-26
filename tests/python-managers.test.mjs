import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as images from "../lib/sandbox-images.mjs";
import { buildConfigProposal } from "../lib/propose.mjs";

function repo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-python-managers-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
const project = '[project]\nname = "sample"\nversion = "0.1.0"\ndependencies = ["requests>=2", "typing-extensions; python_version < \'3.12\'"]\n[project.optional-dependencies]\ntest = ["pytest==8.3.5"]\ndev = ["ruff"]\ndocs = ["sphinx"]\n';
const poetry = '[tool.poetry]\nname = "sample"\nversion = "0.1.0"\n';

for (const [manager, manifest, lock, dev] of [
  ["uv", project, "uv.lock", false],
  ["poetry", poetry + '[tool.poetry.group.dev.dependencies]\npytest = "*"\n', "poetry.lock", true],
  ["poetry", poetry, "poetry.lock", false],
  ["poetry", poetry, null, false],
  ["pyproject", project, null, false],
]) {
  test(`Python ${manager} composition (${lock ?? "unlocked"}, dev=${dev}) installs offline runtime dependencies`, (t) => {
    const inputs = { "pyproject.toml": manifest, ...(lock ? { [lock]: "# fixture lock\n" } : {}) };
    const dir = repo(t, inputs);
    const result = images.composeSandboxImage(dir);
    assert.deepEqual(Object.keys(result).sort(), ["dockerfile", "files", "image", "pathEntries"]);
    assert.deepEqual(result.files, Object.keys(inputs).map((source) => ({ source, destination: `py/${source}` })));
    assert.deepEqual(result.pathEntries, ["/deps/python/.venv/bin"]);
    assert.match(result.dockerfile, /python3 -m venv \/deps\/python\/\.venv/);
    assert.match(result.dockerfile, /ENV VIRTUAL_ENV=\/deps\/python\/\.venv\nENV PATH="\/deps\/python\/\.venv\/bin:\$\{PATH\}"\nUSER node/);
    assert.ok(result.dockerfile.includes(`|| touch .nomarmy-${manager}-install-failed)`));
    if (manager === "uv") {
      assert.match(result.dockerfile, /pip3 install --no-cache-dir --break-system-packages uv && uv sync --frozen --no-install-project --all-groups/);
      assert.match(result.dockerfile, /ENV UV_PROJECT_ENVIRONMENT=\/deps\/python\/\.venv/);
    } else if (manager === "poetry") {
      assert.match(result.dockerfile, /ENV POETRY_VIRTUALENVS_CREATE=false/);
      assert.match(result.dockerfile, /export VIRTUAL_ENV=\/deps\/python\/\.venv && pip3 install .* poetry && poetry install --no-root --no-interaction/);
      const script = result.dockerfile.match(/\$\(python3 -c '([^']+)'\)/)[1];
      const run = spawnSync("python3", ["-c", script], { cwd: dir, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, dev ? "--with dev\n" : "\n");
    } else {
      const script = result.dockerfile.match(/&& python3 -c '([^']+)' \|\|/)[1];
      // Execute the actual TOML extraction, replacing only the pip subprocess
      // with an argument recorder: no network or project build backend runs.
      const run = spawnSync("python3", ["-c", 'import subprocess, json; subprocess.check_call=lambda args: print(json.dumps(args)); ' + script], { cwd: dir, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), ["/deps/python/.venv/bin/python", "-m", "pip", "install", "--no-cache-dir", "--", "requests>=2", "typing-extensions; python_version < '3.12'", "pytest==8.3.5", "ruff"]);
    }
    for (const [source, content] of Object.entries(inputs)) {
      fs.writeFileSync(path.join(dir, source), content + "\n");
      assert.notEqual(images.composeSandboxImage(dir).image, result.image, source);
      fs.writeFileSync(path.join(dir, source), content);
    }
    let builds = 0;
    const tag = images.ensureComposedImageBuilt(dir, null, { run: (cmd, args) => {
      assert.equal(cmd, "podman");
      if (args[0] === "images") return "";
      assert.equal(args[0], "build");
      builds++;
      const context = args.at(-1);
      assert.deepEqual(fs.readdirSync(context).sort(), ["Dockerfile", "py"]);
      assert.deepEqual(fs.readdirSync(path.join(context, "py")).sort(), Object.keys(inputs).sort());
      for (const [source, content] of Object.entries(inputs)) assert.equal(fs.readFileSync(path.join(context, "py", source), "utf8"), content);
      assert.equal(fs.readFileSync(path.join(context, "Dockerfile"), "utf8"), result.dockerfile);
      return "";
    } });
    assert.equal(tag, result.image);
    assert.equal(builds, 1);
  });
}

test("Python precedence, explicit override and unchanged requirements recipe", (t) => {
  const dir = repo(t, { "uv.lock": "", "poetry.lock": "", "pyproject.toml": project, "requirements.txt": "pytest\n" });
  assert.deepEqual(images.pythonRequirementsFor(dir), []);
  assert.match(images.composeSandboxImage(dir).dockerfile, /uv sync --frozen/);
  fs.unlinkSync(path.join(dir, "uv.lock"));
  assert.match(images.composeSandboxImage(dir).dockerfile, /poetry install --no-root/);
  fs.unlinkSync(path.join(dir, "poetry.lock"));
  assert.match(images.composeSandboxImage(dir).dockerfile, /nomarmy-pyproject-install-failed/);
  const config = { environment: { python: { requirements: ["requirements.txt"] } } };
  assert.deepEqual(images.pythonRequirementsFor(dir, config), ["requirements.txt"]);
  const overridden = images.composeSandboxImage(dir, config);
  assert.equal(overridden.dockerfile.replace("USER root\n# harness: python\n", ""), images.dependencyDockerfile({ requirements: ["requirements.txt"] }));
  assert.deepEqual(overridden.pathEntries, []);
  fs.unlinkSync(path.join(dir, "pyproject.toml"));
  assert.deepEqual(images.composeSandboxImage(dir), overridden);
});

test("Python venv PATH stays first in mixed images and worker exec", (t) => {
  const dir = repo(t, { "pyproject.toml": project, "go.mod": "module sample\n", "package.json": "{}", "package-lock.json": "{}" });
  const result = images.composeSandboxImage(dir);
  assert.deepEqual(result.pathEntries, ["/deps/python/.venv/bin", "/usr/local/go/bin", "/home/node/go/bin", "/deps/node_modules/.bin"]);
  assert.equal(result.dockerfile.match(/^ENV PATH=.*$/gm).at(-1), 'ENV PATH="/deps/python/.venv/bin:${PATH}"');
});

for (const source of ["uv.lock", "poetry.lock", "pyproject.toml"]) {
  test(`Python proposals recognize ${source} and do not override it with pip`, () => {
    const result = buildConfigProposal({ files: { items: [{ path: source }] }, tooling: { items: [{ name: "pip", category: "package-manager", source: "requirements.txt" }] } });
    assert.equal(result.valid, true);
    assert.equal(result.proposal.environment, undefined);
    assert.deepEqual(result.proposal.verification, { quick: { environment: "none", commands: ["pytest"] } });
    const fixture = buildConfigProposal({ files: { items: [{ path: source }] }, fixturePaths: [source] });
    assert.deepEqual(fixture.proposal.verification.quick.commands, ["echo 'REPLACE ME: no verification command configured yet' && exit 1"]);
  });
}
