import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as images from "../lib/sandbox-images.mjs";
import * as verify from "../lib/verify.mjs";
import { loadHarnesses } from "../lib/harnesses.mjs";
import { createVerificationFlow } from "../lib/verification-flow.mjs";
import { collectVerificationArtifacts } from "../lib/verification-artifacts.mjs";

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
RUN (cd '/deps${prefix ? "/" + prefix.slice(0, -1) : ""}' && npx --no-install playwright install --with-deps chromium) || touch /ms-playwright/.nomarmy-playwright-install-failed
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

test("independent implement and verify runners retain exact screenshot evidence and report caps", async (t) => {
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
