import './helpers/isolate-global-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { harnessSchema } from '../lib/harness-schema.mjs';
import { validateConfig, loadConfig } from '../lib/config.mjs';
import { loadHarnesses, matchHarnesses, validateEnabledHarnesses } from '../lib/harnesses.mjs';
import { sandboxHarnesses } from '../lib/sandbox-images.mjs';
import { createPodmanExecutor, createVerificationRunner } from '../lib/verify.mjs';

const service = { name: 'mock-oidc', image: 'example/mock:1.2', port: 8080, env: { MODE: 'fake' }, health: '/default/.well-known/openid-configuration' };
const spec = { name: 'example', summary: 'Example', detect: [], image: { apt: [], run: [] }, network: 'services', services: [service], env: { OIDC_ISSUER: 'http://mock-oidc:8080/default' } };
function temporary(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nomarmy-services-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test('service schema accepts exact specs and rejects unpinned images and invalid boundaries', () => {
  assert.deepEqual(harnessSchema.parse(spec), { ...spec, after: [], verification: {}, artifacts: [], requires: {}, docs: 'README.md' });
  for (const image of ['mock', 'mock:latest', 'registry:5000/mock', 'registry:5000/mock:latest', 'mock@sha256:bad']) {
    assert.equal(harnessSchema.safeParse({ ...spec, services: [{ ...service, image }] }).success, false, image);
  }
  for (const image of ['registry:5000/mock:1', `example/mock@sha256:${'a'.repeat(64)}`]) {
    assert.equal(harnessSchema.parse({ ...spec, services: [{ ...service, image }] }).services[0].image, image);
  }
  for (const change of [{ network: 'none' }, { services: [service, service] }, { services: [{ ...service, port: 65536 }] }, { services: [{ ...service, health: 'https://outside/' }] }, { services: [{ ...service, health: '//outside/' }] }, { env: { 'BAD=KEY': 'value' } }]) {
    assert.equal(harnessSchema.safeParse({ ...spec, ...change }).success, false);
  }
});

test('committed harness opt-in adds undetected services and refuses unknown and allowlist names', (t) => {
  const cwd = temporary(t), { harnesses } = loadHarnesses();
  fs.writeFileSync(path.join(cwd, '.nomarmy.yml'), 'harnesses: [mock-oidc]\n');
  const loaded = loadConfig(cwd);
  assert.deepEqual(loaded.config, { harnesses: ['mock-oidc'], environment_retention: { success: 'destroy', failure: 'logs', debug: 'retain' } });
  assert.deepEqual(matchHarnesses(cwd, harnesses), []);
  assert.deepEqual(sandboxHarnesses(cwd, loaded.config).matched, ['mock-oidc']);
  const bad = validateConfig({ harnesses: ['missing'] });
  assert.deepEqual(bad, { valid: false, config: null, elevated: { shared: [], remote: [] }, errors: [`unknown harness 'missing'; available harnesses: ${Object.keys(harnesses).sort().join(', ')}`] });
  const elevated = { ...harnesses, elevated: { ...spec, name: 'elevated', network: 'allowlist' } };
  assert.throws(() => validateEnabledHarnesses(['elevated'], elevated), { message: "harness 'elevated' requires allowlist; .nomarmy.yml cannot enable it (operator-local opt-in required)" });
  assert.throws(() => matchHarnesses(cwd, elevated, ['elevated']), /operator-local opt-in required/);
});

test('verification services lifecycle is internal, ordered, bounded and cleaned on every failure', async (t) => {
  const cwd = temporary(t);
  for (const failure of [null, 'health', 'service', 'pull', 'verification', 'throw', 'network']) {
    const calls = [];
    const collect = async (file, args, options) => {
      assert.equal(file, 'stub-podman');
      calls.push({ args, options });
      let code = 0;
      if (args[0] === 'image' && args[1] === 'exists') code = 1;
      if (failure === 'network' && args[0] === 'network' && args[1] === 'create') code = 125;
      if (failure === 'pull' && args[0] === 'pull') code = 125;
      if (failure === 'service' && args.includes('--detach')) code = 125;
      if (failure === 'health' && args.includes('--input-type=module')) code = 1;
      if (args.includes('/bin/sh')) {
        if (failure === 'verification') code = 2;
        if (failure === 'throw') throw new Error('test execution exception');
      }
      return { spawned: true, code, stdout: '', stderr: '', timedOut: false };
    };
    const runner = createVerificationRunner({
      executor: createPodmanExecutor({ podman: 'stub-podman', collect, healthTimeoutMs: 37, healthIntervalMs: 1 }),
      image: 'sandbox:1',
      loadConfig: () => ({ found: true, config: { harnesses: ['mock-oidc'], verification: { quick: { commands: ['node test.mjs', 'node second.mjs'] } } } }),
    });
    const result = await runner({ cwd, jobId: 'job-42', profile: 'quick' });
    assert.equal(result.status, failure === 'verification' ? 'fail' : failure ? 'not_run' : 'pass', failure);
    const args = calls.map((call) => call.args);
    assert.deepEqual(args[2], ['network', 'create', '--internal', 'nomarmy-job-42']);
    if (failure === 'network') { assert.equal(args.length, 3); continue; }
    assert.deepEqual(args[3], ['image', 'exists', 'ghcr.io/navikt/mock-oauth2-server:2.1.10']);
    assert.deepEqual(args[4], ['pull', 'ghcr.io/navikt/mock-oauth2-server:2.1.10']);
    assert.deepEqual(args.at(-1), ['network', 'rm', 'nomarmy-job-42']);
    if (failure === 'pull') { assert.equal(args.length, 6); continue; }
    assert.deepEqual(args[5], ['run', '--detach', '--name', 'nomarmy-job-42-service-mock-oidc', '--network', 'nomarmy-job-42', '--network-alias', 'mock-oidc', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=512', '--env', 'SERVER_PORT=8080', 'ghcr.io/navikt/mock-oauth2-server:2.1.10']);
    assert.deepEqual(args.at(-2), ['rm', '--force', '--ignore', 'nomarmy-job-42-service-mock-oidc']);
    if (failure === 'service') { assert.equal(args.length, 8); continue; }
    assert.deepEqual(args[6].slice(0, -1), ['run', '--rm', '--name', 'nomarmy-job-42-health-mock-oidc', '--network', 'nomarmy-job-42', '--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--entrypoint', 'node', 'sandbox:1', '--input-type=module', '-e']);
    assert.match(args[6].at(-1), /http:\/\/mock-oidc:8080\/default\/\.well-known\/openid-configuration/);
    assert.match(args[6].at(-1), /r.status>=200&&r.status<300/);
    assert.equal(calls[6].options.timeoutMs, 5037);
    assert.deepEqual(args.at(-3), ['rm', '--force', '--ignore', 'nomarmy-job-42-health-mock-oidc']);
    const commands = args.filter((a) => a.includes('/bin/sh'));
    assert.equal(commands.length, failure === 'health' ? 0 : failure ? 1 : 2);
    for (const command of commands) {
      assert.equal(command.includes('--network=nomarmy-job-42'), true);
      assert.equal(command.includes('OIDC_ISSUER=http://mock-oidc:8080/default'), true);
      assert.equal(command.includes('OAUTH2_ISSUER=http://mock-oidc:8080/default'), true);
    }
    assert.equal(args.flat().some((a) => a === '-p' || a.startsWith('--publish')), false);
    if (failure === 'health') assert.equal(result.reason, 'service setup failed: service mock-oidc did not become healthy within 37ms (http://mock-oidc:8080/default/.well-known/openid-configuration)');
  }
  const calls = [];
  const runner = createVerificationRunner({ image: 'sandbox:1',
    executor: createPodmanExecutor({ collect: async (_file, args) => { calls.push(args); return { spawned: true, code: 0, stdout: '', stderr: '' }; } }),
    loadConfig: () => ({ found: true, config: { verification: { quick: { commands: ['true'] } } } }),
  });
  assert.equal((await runner({ cwd, profile: 'quick' })).status, 'pass');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].includes('--network=none'), true);
});


test('multiple services use distinct container names and local images without pulls', async () => {
  const calls = [];
  const executor = createPodmanExecutor({ collect: async (_file, args) => {
    calls.push(args);
    return { spawned: true, code: 0, stdout: '', stderr: '', timedOut: false };
  } });
  const run = await executor.startServices({ jobId: 'multi', image: 'sandbox:1', services: [service, { ...service, name: 'mock-oidc-health', health: undefined }] });
  assert.deepEqual(Object.keys(run).sort(), ['cleanup', 'network']);
  assert.equal(run.network, 'nomarmy-multi');
  await run.cleanup();
  assert.deepEqual(calls.map((args) => args[0]), ['network', 'image', 'run', 'image', 'run', 'run', 'rm', 'rm', 'rm', 'network']);
  assert.deepEqual(calls.filter((args) => args[0] === 'run').map((args) => args[args.indexOf('--name') + 1]), ['nomarmy-multi-service-mock-oidc', 'nomarmy-multi-service-mock-oidc-health', 'nomarmy-multi-health-mock-oidc']);
  assert.deepEqual(calls.slice(-4), [
    ['rm', '--force', '--ignore', 'nomarmy-multi-health-mock-oidc'],
    ['rm', '--force', '--ignore', 'nomarmy-multi-service-mock-oidc-health'],
    ['rm', '--force', '--ignore', 'nomarmy-multi-service-mock-oidc'],
    ['network', 'rm', 'nomarmy-multi'],
  ]);
});


test('mock OIDC fixture consumes exported verification env without real network', async (t) => {
  const cwd = temporary(t);
  const fixture = new URL('../harnesses/mock-oidc/fixture/discovery.test.mjs', import.meta.url).href;
  let cleaned = false;
  const runner = createVerificationRunner({ image: 'sandbox:1',
    loadConfig: () => ({ found: true, config: { harnesses: ['mock-oidc'], verification: { quick: { commands: ['fixture'] } } } }),
    executor: {
      probe: async () => ({ available: true }),
      startServices: async () => ({ network: 'nomarmy-fixture', cleanup: async () => { cleaned = true; } }),
      run: async ({ env }) => {
        const script = `import assert from 'node:assert/strict';
          globalThis.fetch = async (url) => {
            assert.equal(url, 'http://mock-oidc:8080/default/.well-known/openid-configuration');
            return {status:200,json:async()=>({issuer:'http://mock-oidc:8080/default',jwks_uri:'http://mock-oidc:8080/default/jwks',authorization_endpoint:'http://mock-oidc:8080/default/authorize',token_endpoint:'http://mock-oidc:8080/default/token'})};
          };
          await import(${JSON.stringify(fixture)});`;
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
        return { started: true, exitCode: child.status, stdout: child.stdout, stderr: child.stderr };
      },
    },
  });
  const result = await runner({ cwd, profile: 'quick', jobId: 'fixture' });
  assert.equal(result.status, 'pass', result.output);
  assert.equal(cleaned, true);
});
