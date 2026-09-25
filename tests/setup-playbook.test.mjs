import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setupSteps, formatSetupSteps, runSetupPlaybook } from '../lib/setup-steps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const initial = () => ({
  mode: () => ({ profile: null }), install: () => ({ marker: null, version: '', registered: false }),
  agents: () => ['local'], army: () => null, repo: () => ({ inside: false, configured: false }),
});

test('setup checklist covers exact statuses, commands and profile transitions', () => {
  const probes = initial();
  const baseline = [
    { id: 'mode', title: 'Where models run', status: 'todo', detail: 'choose where models run', command: ['setup', '--choose'] },
    { id: 'install', title: 'Installed', status: 'todo', detail: 'OpenClaw not found', command: ['install'] },
    { id: 'agents', title: 'Agents', status: 'skipped', detail: 'optional: the local model works without one', command: ['agents', 'add'] },
    { id: 'roles', title: 'Roles', status: 'todo', detail: 'add an agent first', command: ['army', 'init', '--agent', 'local', '--force'] },
    { id: 'repo', title: 'This repo', status: 'skipped', detail: 'run nomarmy setup inside a project to set it up', command: ['init'] },
    { id: 'check', title: 'Check', status: 'todo', detail: 'verify the installation', command: ['doctor'] },
  ];
  assert.deepEqual(setupSteps(probes), baseline);
  assert.equal(formatSetupSteps(baseline), '→ Where models run: choose where models run\n  Installed: OpenClaw not found\n– Agents: optional: the local model works without one\n  Roles: add an agent first\n– This repo: run nomarmy setup inside a project to set it up\n  Check: verify the installation');
  probes.mode = () => ({ profile: 'hosted' });
  probes.army = () => ({ roles: { dev: { agent: 'local' } } });
  let steps = setupSteps(probes);
  assert.deepEqual(steps[0], { ...baseline[0], status: 'done', detail: 'hosted' });
  assert.deepEqual(steps[2], { ...baseline[2], status: 'todo', detail: 'add a hosted agent' });
  assert.deepEqual(steps[3], baseline[3]);
  probes.agents = () => ['local', 'api', 'subscription'];
  steps = setupSteps(probes);
  assert.deepEqual(steps[2], { ...baseline[2], status: 'done', detail: 'api, subscription' });
  assert.deepEqual(steps[3], { ...baseline[3], detail: 'roles must use a hosted agent', command: ['army', 'init', '--agent', 'api', '--force'] });
  probes.army = () => ({ roles: { dev: { agent: 'api' } } });
  assert.deepEqual(setupSteps(probes)[3], { ...steps[3], status: 'done', detail: '1 roles' });
  probes.mode = () => ({ profile: 'cpu-linux' });
  probes.army = () => ({ roles: { dev: { agent: 'local' } } });
  assert.deepEqual(setupSteps(probes)[0], { ...baseline[0], status: 'done', detail: 'local cpu-linux' });
  assert.equal(setupSteps(probes)[3].status, 'done');
  probes.mode = () => ({ profile: 'remote', host: 'server', port: '8080' });
  assert.deepEqual(setupSteps(probes)[0], { ...baseline[0], status: 'done', detail: 'remote server:8080' });
  probes.mode = () => ({ profile: 'bedrock' });
  assert.deepEqual(setupSteps(probes)[0], { ...baseline[0], status: 'done', detail: 'bedrock' });
  probes.repo = () => ({ inside: true, configured: false });
  assert.deepEqual(setupSteps(probes)[4], { ...baseline[4], status: 'todo', detail: 'configure this project' });
  probes.repo = () => ({ inside: true, configured: true });
  assert.deepEqual(setupSteps(probes)[4], { ...baseline[4], status: 'done', detail: '.nomarmy.yml exists' });
  for (const [marker, version, registered, status] of [
    [{ profile: 'bedrock' }, '', false, 'done'], [{ profile: 'hosted' }, '1.0', true, 'todo'],
    [null, '1.0', true, 'done'], [null, '1.0', false, 'todo'], [null, '', true, 'todo'],
  ]) {
    probes.install = () => ({ marker, version, registered });
    assert.deepEqual(setupSteps(probes)[1], { ...baseline[1], status, detail: version || 'OpenClaw not found' });
  }
});

test('setup runner re-evaluates, stops on refusal or failure, and completes after doctor once', async () => {
  for (const scenario of ['complete', 'refuse', 'fail']) {
    let evaluations = 0;
    const commands = [], printed = [], prompts = [];
    const code = await runSetupPlaybook({
      evaluate: () => {
        evaluations++;
        return [
          { id: 'mode', title: 'Mode', status: commands.length ? 'done' : 'todo', detail: '', command: ['setup', '--choose'] },
          { id: 'check', title: 'Check', status: 'todo', detail: '', command: ['doctor'] },
        ];
      },
      ask: async (prompt) => { prompts.push(prompt); return scenario === 'refuse' ? 'n' : ''; },
      run: async (args) => { commands.push(args); return scenario === 'fail' ? 7 : 0; },
      print: (message) => printed.push(message),
    });
    assert.equal(code, scenario === 'fail' ? 7 : 0);
    assert.equal(evaluations, scenario === 'complete' ? 2 : 1);
    assert.deepEqual(prompts, Array(scenario === 'complete' ? 2 : 1).fill('Run it now? [Y/n] '));
    assert.deepEqual(commands, scenario === 'refuse' ? [] : scenario === 'fail' ? [['setup', '--choose']] : [['setup', '--choose'], ['doctor']]);
    assert.deepEqual(printed, scenario === 'complete' ? ['→ Mode: \n  Check: ', '✓ Mode: \n→ Check: ', 'Setup complete', 'Restart Claude Code in the project and ask it to use nomArmy.'] : scenario === 'refuse' ? ['→ Mode: \n  Check: ', 'Resume with: nomarmy setup'] : ['→ Mode: \n  Check: ', 'Setup step failed: Mode (exit 7)']);
  }
});

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, '.setup-test-')));
  const copy = (source, target) => {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.isDirectory()) copy(path.join(source, entry.name), path.join(target, entry.name));
      else fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name));
    }
  };
  for (const name of ['bin', 'lib']) copy(path.join(root, name), path.join(dir, name));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.mkdirSync(path.join(dir, 'home'));
  fs.mkdirSync(path.join(dir, 'fake-bin'));
  const env = { ...process.env, HOME: path.join(dir, 'home'), NOMARMY_CONFIG_DIR: path.join(dir, 'config'), NOMARMY_INSTALL_ROOT: path.join(dir, 'installed'), PATH: `${path.join(dir, 'fake-bin')}:${process.env.PATH}` };
  for (const name of ['openclaw', 'claude', 'codex']) fs.writeFileSync(path.join(dir, 'fake-bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const run = (args) => spawnSync(process.execPath, [path.join(dir, 'bin', 'nomarmy.mjs'), ...args], { cwd: dir, env, encoding: 'utf8' });
  return { dir, env, run };
}

test('setup CLI status, persisted profiles, legacy probes and stub installer', () => {
  const { dir, env, run } = fixture();
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    const clean = run(['setup', '--status', '--json']);
    const steps = setupSteps({ ...initial(), repo: () => ({ inside: true, configured: false }) });
    assert.equal(clean.status, 0, clean.stderr);
    assert.deepEqual(JSON.parse(clean.stdout), steps);
    for (const args of [['setup'], ['setup', '--status']]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, formatSetupSteps(steps) + '\n');
    }
    assert.equal(run(['setup', '--hosted', '--json']).status, 0);
    assert.equal(fs.readFileSync(path.join(dir, 'config/common.env'), 'utf8'), 'NOMARMY_EXECUTION=hosted\nNOMARMY_SETUP_PROFILE=hosted\n');
    fs.writeFileSync(path.join(dir, 'install.sh'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$HOME/install-args"\nexit 9\n');
    const installed = run(['install', '--no-claude']);
    assert.equal(installed.status, 9);
    assert.equal(fs.readFileSync(path.join(dir, 'home/install-args'), 'utf8'), '--profile\nhosted\n--no-claude\n');
    assert.equal(run(['install', '--profile', 'remote']).status, 9);
    assert.equal(fs.readFileSync(path.join(dir, 'home/install-args'), 'utf8'), '--profile\nremote\n');
    fs.mkdirSync(env.NOMARMY_INSTALL_ROOT);
    fs.writeFileSync(path.join(env.NOMARMY_INSTALL_ROOT, 'install.json'), JSON.stringify({ profile: 'hosted' }));
    assert.deepEqual(JSON.parse(run(['setup', '--status', '--json']).stdout)[1], { id: 'install', title: 'Installed', status: 'done', detail: 'OpenClaw not found', command: ['install'] });
    fs.unlinkSync(path.join(env.NOMARMY_INSTALL_ROOT, 'install.json'));
    fs.writeFileSync(path.join(dir, 'fake-bin/openclaw'), '#!/bin/sh\necho OpenClaw-1.0\n');
    fs.writeFileSync(path.join(dir, 'fake-bin/codex'), '#!/bin/sh\necho nomarmy-local-worker\n');
    assert.deepEqual(JSON.parse(run(['setup', '--status', '--json']).stdout)[1], { id: 'install', title: 'Installed', status: 'done', detail: 'OpenClaw-1.0', command: ['install'] });
    fs.writeFileSync(path.join(dir, 'config/config.yml'), 'army:\n  roles:\n    dev:\n      agent: local\n');
    fs.writeFileSync(path.join(dir, '.nomarmy.yml'), 'army:\n  roles:\n    dev:\n      description: project override\n');
    assert.equal(JSON.parse(run(['setup', '--status', '--json']).stdout)[3].status, 'todo');
    fs.writeFileSync(path.join(dir, 'config/agents.yml'), 'agents:\n  coder:\n    kind: subscription\n    provider: codex\n    owner: me\n');
    fs.writeFileSync(path.join(dir, '.nomarmy.yml'), 'army:\n  roles:\n    dev:\n      agent: local\n');
    assert.deepEqual(JSON.parse(run(['setup', '--status', '--json']).stdout)[3].command, ['army', 'init', '--agent', 'coder', '--force', '--project']);
    const repair = JSON.parse(run(['setup', '--status', '--json']).stdout)[3].command;
    assert.equal(run(repair).status, 0);
    const remaining = JSON.parse(run(['setup', '--status', '--json']).stdout)[3];
    assert.equal(remaining.status, 'todo');
    assert.deepEqual(remaining.command, ['army', 'init', '--agent', 'coder', '--force']);
    assert.equal(run(remaining.command).status, 0);
    assert.equal(JSON.parse(run(['setup', '--status', '--json']).stdout)[3].status, 'done');
    const local = run(['setup', '--json', '--profile-name', 'test-local', '--model', 'default']);
    assert.equal(local.status, 0, local.stderr);
    assert.equal(JSON.parse(local.stdout).installCommand, 'nomarmy install');
    assert.match(fs.readFileSync(path.join(dir, 'config/common.env'), 'utf8'), /^NOMARMY_SETUP_PROFILE=test-local$/m);
    assert.match(fs.readFileSync(path.join(dir, 'config/common.env'), 'utf8'), /^NOMARMY_EXECUTION=local$/m);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installer marker is written only after successful verification with exact metadata', () => {
  const dir = fs.mkdtempSync(path.join(root, '.setup-marker-'));
  try {
    const source = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
    const verify = source.indexOf('"$ROOT/scripts/verify-install.sh" "$NOMARMY_PROFILE"');
    const marker = source.indexOf('# Record only a completed, verified installation.');
    assert.ok(verify > 0 && marker > verify);
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"9.8.7"}');
    fs.writeFileSync(path.join(dir, 'scripts/verify-install.sh'), '#!/bin/sh\nexit "$VERIFY_CODE"\n', { mode: 0o755 });
    const script = 'set -euo pipefail\nnomarmy_is_cloud(){ return 1; }\nnomarmy_execution_mode(){ echo hosted; }\n' + source.slice(verify);
    for (const code of [4, 0]) {
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ROOT: dir, NOMARMY_PROFILE: 'hosted', NOMARMY_INSTALL_ROOT: dir, VERIFY_CODE: String(code) } });
      assert.equal(result.status, code, result.stderr);
      assert.equal(fs.existsSync(path.join(dir, 'install.json')), code === 0);
    }
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'install.json'), 'utf8'));
    assert.deepEqual(record, { profile: 'hosted', execution: 'hosted', installedAt: record.installedAt, version: '9.8.7' });
    assert.equal(new Date(record.installedAt).toISOString(), record.installedAt);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
