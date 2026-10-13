import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as images from "../lib/sandbox-images.mjs";
import * as verify from "../lib/verify.mjs";
import { loadHarnesses } from "../lib/harnesses.mjs";
import { createVerificationFlow } from "../lib/verification-flow.mjs";
import { collectVerificationArtifacts } from "../lib/verification-artifacts.mjs";
import { noSymlinks } from "./helpers/symlinks.mjs";

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-browser-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function write(dir, rel, data) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), data);
}
function packageAt(dir, prefix = "") {
  write(dir, prefix + "package.json", JSON.stringify({ devDependencies: { "@playwright/test": "1.55.1" } }));
  write(dir, prefix + "package-lock.json", "{}");
}

test("browser recipe uses the installed root or nested Playwright, after node, with offline runtime", (t) => {
  const spec = loadHarnesses().harnesses["browser-playwright"];
  assert.deepEqual(spec, {
    name: "browser-playwright", summary: "Offline Chromium end-to-end tests with the repository's Playwright version",
    detect: [{ package: "@playwright/test" }, { file: "playwright.config.ts" }, { file: "playwright.config.js" }, { file: "playwright.config.mjs" }],
    after: ["node"], image: { builtin: "playwright" }, verification: { browser: "npx playwright test" },
    artifacts: ["test-results/**", "playwright-report/**"], requires: { memoryMb: 1024, shmMb: 512 },
    network: "none", docs: "README.md",
  });
  for (const prefix of ["", "ui/", "packages/ui/"]) {
    const cwd = temporary(t);
    packageAt(cwd, prefix);
    if (prefix === "packages/ui/") {
      write(cwd, "package.json", '{"workspaces":["packages/*"]}');
      write(cwd, "package-lock.json", "{}");
    }
    const recipe = images.composeSandboxImage(cwd);
    const browser = recipe.dockerfile.slice(recipe.dockerfile.indexOf("# harness: browser-playwright"));
    assert.equal(browser, `# harness: browser-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /ms-playwright
COPY playwright/unzip-extract.cjs /opt/nomarmy-playwright-unzip.cjs
RUN (cd '/deps${prefix ? "/" + prefix.slice(0, -1) : ""}' && if node -e 'const v=s=>s.split(".").map(Number),[a,b]=v(require("playwright-core/package.json").version),[n,m]=v(process.versions.node);process.exit(a===1&&b<60&&(n>24||(n===24&&m>=16))?0:1)' 2>/dev/null; then export NODE_OPTIONS="--require=/opt/nomarmy-playwright-unzip.cjs"; command -v unzip >/dev/null || { apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*; }; fi; for attempt in 1 2; do timeout -k 30 300 npx --no-install playwright install --with-deps chromium && exit 0; done; exit 1) || touch /ms-playwright/.nomarmy-playwright-install-failed
RUN rm -f /opt/nomarmy-playwright-unzip.cjs
RUN chmod -R a+rX /ms-playwright
USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
`);
    assert.ok(recipe.dockerfile.indexOf("# harness: node") < recipe.dockerfile.indexOf("# harness: browser-playwright"));
    assert.ok(recipe.dockerfile.includes("USER root\n# harness: browser-playwright"));
    const calls = [];
    assert.equal(images.ensureComposedImageBuilt(cwd, null, { run(command, args) {
      calls.push([command, args[0]]);
      if (args[0] === "build") assert.equal(fs.readFileSync(path.join(args.at(-1), "Dockerfile"), "utf8"), recipe.dockerfile);
      return "";
    } }), recipe.image);
    assert.deepEqual(calls, [["podman", "images"], ["podman", "build"]]);
  }
});

test("verification forwards largest matched shared memory and omits undeclared shm", async (t) => {
  assert.equal(verify.verificationShmMb(null, null, { matched: ["small", "large", "none"],
    harnesses: { small: { requires: { shmMb: 128 } }, large: { requires: { shmMb: 1024 } }, none: { requires: {} } } }), 1024);
  const cwd = temporary(t);
  const calls = [];
  const runner = verify.createVerificationRunner({
    image: "stub", loadConfig: () => ({ found: true, config: { verification: { browser: { environment: "none", commands: ["npx playwright test"] } } } }),
    executor: { probe: async () => ({ available: true }), run: async (args) => { calls.push(args); return { exitCode: 0 }; } },
  });
  assert.equal((await runner({ cwd, profile: "browser" })).status, "pass");
  assert.equal(calls[0].shmMb, 0);
  assert.deepEqual(verify.buildPodmanArgs(calls[0]).filter((arg) => arg.startsWith("--shm-size")), []);
  packageAt(cwd);
  assert.equal((await runner({ cwd, profile: "browser" })).status, "pass");
  assert.equal(calls[1].shmMb, 512);
  assert.deepEqual(verify.buildPodmanArgs(calls[1]).filter((arg) => arg.startsWith("--shm-size")), ["--shm-size=512m"]);
});

test("independent implement and verify runners retain exact screenshot evidence and report caps", { skip: noSymlinks }, async (t) => {
  for (const mode of ["implement", "verify"]) {
    const root = temporary(t), cwd = path.join(root, "worktree"), jobDir = path.join(root, "job");
    write(cwd, "playwright.config.js", "");
    fs.mkdirSync(jobDir);
    const flow = createVerificationFlow({ ensureJobsRoot: () => root });
    flow.registerVerificationRunner(async () => {
      write(cwd, "test-results/page/screenshot.png", Buffer.from([137, 80, 78, 71]));
      write(cwd, "ignored.png", "not evidence");
      write(cwd, "playwright-report/index.html", "report");
      fs.symlinkSync(path.join(cwd, "ignored.png"), path.join(cwd, "test-results/link.png"));
      return { status: "pass", output: "browser passed" };
    });
    const result = await flow.runIndependentVerification({ cwd, jobId: "job", mode, profile: "browser",
      ...(mode === "verify" ? { logFile: path.join(jobDir, "verification.log") } : {}) });
    assert.deepEqual(result, { status: "pass", profile: "browser", basis: "registered-runner", reason: null, detail: null,
      ...(mode === "verify" ? { log: path.join(jobDir, "verification.log") } : {}),
      artifacts: ["artifacts/playwright-report/index.html", "artifacts/test-results/page/screenshot.png"], artifactsCapped: false });
    assert.deepEqual(fs.readFileSync(path.join(jobDir, result.artifacts[1])), Buffer.from([137, 80, 78, 71]));
    assert.equal(fs.readFileSync(path.join(jobDir, result.artifacts[0]), "utf8"), "report");
    assert.deepEqual(collectVerificationArtifacts(cwd, jobDir, { maxFiles: 1, maxBytes: 50 }), {
      artifacts: ["artifacts/playwright-report/index.html"], artifactsCapped: true });
    assert.deepEqual(collectVerificationArtifacts(cwd, jobDir, { maxFiles: 200, maxBytes: 4 }), {
      artifacts: ["artifacts/test-results/page/screenshot.png"], artifactsCapped: true });
    write(cwd, "test-results/oversized.png", "");
    fs.truncateSync(path.join(cwd, "test-results/oversized.png"), 50 * 1024 * 1024 + 1);
    assert.deepEqual(collectVerificationArtifacts(cwd, jobDir), {
      artifacts: ["artifacts/playwright-report/index.html", "artifacts/test-results/page/screenshot.png"], artifactsCapped: true });
    flow.registerVerificationRunner(async () => {
      for (let i = 0; i < 201; i++) write(cwd, `test-results/cap-${String(i).padStart(3, "0")}.png`, "x");
      return { status: "fail" };
    });
    const capped = await flow.runIndependentVerification({ cwd, jobId: "job", mode, profile: "browser" });
    assert.equal(capped.artifacts.length, 200);
    assert.equal(capped.artifactsCapped, true);
    assert.equal(capped.detail, "artifact collection capped at 200 files / 50 MB");
    assert.equal(capped.status, "fail");
  }
});

test("exclude_harnesses keeps a detected browser out of the image and is validated", async (t) => {
  const cwd = temporary(t);
  packageAt(cwd);
  write(cwd, "playwright.config.ts", "export default {};\n");
  assert.ok(images.sandboxHarnesses(cwd).matched.includes("browser-playwright"));
  const config = { exclude_harnesses: ["browser-playwright"] };
  assert.deepEqual(images.sandboxHarnesses(cwd, config).matched, ["node"]);
  const recipe = images.composeSandboxImage(cwd, config);
  assert.ok(recipe.dockerfile.includes("# harness: node"));
  assert.equal(recipe.dockerfile.includes("browser-playwright"), false);
  assert.equal(verify.verificationShmMb(cwd, config), 0);

  const { validateConfig } = await import("../lib/config.mjs");
  assert.equal(validateConfig({ exclude_harnesses: ["browser-playwright"] }).valid, true);
  assert.match(validateConfig({ exclude_harnesses: ["browser"] }).errors.join("\n"), /unknown harness 'browser' in exclude_harnesses/);
  assert.match(validateConfig({ harnesses: ["mock-oidc"], exclude_harnesses: ["mock-oidc"] }).errors.join("\n"), /both harnesses and exclude_harnesses/);
});

test("image builds are capped, 30 minutes unless NOMARMY_IMAGE_BUILD_TIMEOUT_MINUTES says otherwise", () => {
  assert.equal(images.imageBuildTimeoutMs({}), 30 * 60_000);
  assert.equal(images.imageBuildTimeoutMs({ NOMARMY_IMAGE_BUILD_TIMEOUT_MINUTES: "45" }), 45 * 60_000);
  assert.equal(images.imageBuildTimeoutMs({ NOMARMY_IMAGE_BUILD_TIMEOUT_MINUTES: "nope" }), 30 * 60_000);
  assert.equal(images.imageBuildTimeoutMs({ NOMARMY_IMAGE_BUILD_TIMEOUT_MINUTES: "0" }), 30 * 60_000);
});

test("Playwright before 1.60 extracts its browser with the system unzip, since its own extraction hangs on Node 26", async (t) => {
  const cwd = temporary(t);
  packageAt(cwd);
  const recipe = images.composeSandboxImage(cwd);
  const preload = recipe.files.find((f) => f.destination === "playwright/unzip-extract.cjs");
  assert.ok(preload, "the preload ships in the build context");
  assert.equal(String(preload.content), fs.readFileSync(new URL("../harnesses/browser-playwright/unzip-extract.cjs", import.meta.url), "utf8"));

  // The preload swaps only playwright-core's zipBundle extract for unzip.
  const dir = temporary(t);
  const core = path.join(dir, "node_modules", "playwright-core", "lib");
  fs.mkdirSync(path.join(core, "server"), { recursive: true });
  fs.writeFileSync(path.join(core, "zipBundle.js"), "exports.extract = () => 'yauzl'; exports.other = 1;");
  fs.writeFileSync(path.join(core, "server", "main.js"), "module.exports = require('../zipBundle');");
  fs.writeFileSync(path.join(dir, "elsewhere.js"), "module.exports = require('./node_modules/playwright-core/lib/zipBundle');");
  const { execFileSync } = await import("node:child_process");
  const probe = `const a=require(${JSON.stringify(path.join(core, "server", "main.js"))}),b=require(${JSON.stringify(path.join(dir, "elsewhere.js"))});console.log(JSON.stringify([a.extract.toString().includes("unzip"),a.other,b.extract()]))`;
  const out = execFileSync(process.execPath, ["--require", fileURLToPath(new URL("../harnesses/browser-playwright/unzip-extract.cjs", import.meta.url)), "-e", probe], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), [true, 1, "yauzl"], "playwright-core gets unzip; other importers are untouched");
});
