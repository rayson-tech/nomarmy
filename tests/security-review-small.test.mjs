import './helpers/isolate-global-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestJobStop, STOP_REQUEST_FILE } from '../lib/openclaw-run.mjs';
import { linkCodex } from '../lib/codex-link.mjs';
import { runHealthChecks } from '../lib/health.mjs';
import { connectClaude, connectCursor } from '../lib/connect.mjs';
import { createExecutor } from '../lib/execute.mjs';
import { createJobRuntime } from '../lib/admission.mjs';
import { deriveBudgets } from '../lib/budget.mjs';
import { HIGH_STAKES_NOTE } from '../lib/outcome.mjs';
import { plantWorktreePointer } from './helpers/worktree-fixture.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nomarmy-small-security-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(root, name, value) {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
const id = 'worker-20261002-163910-52ff3b';
test('stop refuses the exact .. id and symlink escapes, and names another project', t => {
  const root = fixture(t), jobsRoot = path.join(root, 'jobs'); fs.mkdirSync(jobsRoot);
  write(root, 'status.json', { state: 'running', phase: 'worker' });
  for (const jobId of ['..', '.', '../outside', 'worker', '/outside', 'worker-20261002-163910-zzzzzz']) {
    assert.deepEqual(requestJobStop({ jobsRoot, jobId }), { ok: false, message: 'not a job id' });
  }
  assert.equal(fs.existsSync(path.join(root, STOP_REQUEST_FILE)), false);
  const outside = path.join(root, 'outside');
  write(outside, 'status.json', { state: 'running', phase: 'worker' });
  fs.symlinkSync(outside, path.join(jobsRoot, id), 'dir');
  assert.deepEqual(requestJobStop({ jobsRoot, jobId: id }), { ok: false, message: 'job directory is not a direct child of the jobs root' });
  assert.equal(fs.existsSync(path.join(outside, STOP_REQUEST_FILE)), false);
  fs.unlinkSync(path.join(jobsRoot, id));
  write(jobsRoot, `${id}/status.json`, { state: 'running', phase: 'worker', projectDir: '/another/repository' });
  const message = `stop requested for ${id}: its worker ends within about 15 seconds, verification is skipped, and the worktree is kept uncommitted, so continue_from can pick the work up (on another model too) (project: /another/repository)`;
  assert.deepEqual(requestJobStop({ jobsRoot, jobId: id, now: new Date('2026-10-02T00:00:00Z') }), { ok: true, projectDir: '/another/repository', message });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(jobsRoot, id, STOP_REQUEST_FILE))), { at: '2026-10-02T00:00:00.000Z', reason: null });
});

test('project writes warn and health flags a tampered .cursor/mcp.json and Claude registration', async t => {
  const root = fixture(t), projectDir = path.join(root, 'repo'), nomarmyRoot = path.join(root, 'source');
  write(nomarmyRoot, 'package.json', { name: 'nomarmy', version: '0.1.0' });
  write(nomarmyRoot, 'mcp/server.mjs', '// fixture');
  fs.mkdirSync(path.join(nomarmyRoot, 'lib')); fs.mkdirSync(path.join(nomarmyRoot, 'playbooks'));
  const warnings = [];
  const options = { nomarmyRoot, installDir: path.join(root, 'install'), configDir: path.join(root, 'config'), projectDir, scope: 'project', run: (cmd) => cmd === 'git' ? '.git/info/exclude' : '', warn: s => warnings.push(s) };
  connectCursor(options); connectClaude(options);
  const warning = 'Warning: a project MCP registration is executable configuration committed to the repository. Other developers run its command when they open this repo. Review it before committing.';
  assert.deepEqual(warnings, [warning, warning]);
  const check = async () => (await runHealthChecks({ projectDir, run: async () => ({ ok: false, stdout: '' }) })).issues.filter(i => i.id.startsWith('project-mcp:'));
  assert.deepEqual(await check(), []);
  for (const [target, relative] of [['cursor', '.cursor/mcp.json'], ['claude', '.mcp.json']]) {
    for (const entry of [{ command: 'sh', args: ['-c', 'malicious'] }, { command: 'nomarmy', args: ['mcp', '--extra'] }, { command: 'nomarmy', args: [] }]) {
      write(projectDir, relative, { mcpServers: { 'nomarmy-local-worker': entry } });
      const file = path.join(projectDir, relative);
      assert.deepEqual(await check(), [{ id: `project-mcp:${target}`, severity: 'warn', title: `Unexpected project MCP registration in ${relative}`, detail: `${file} is executable repository configuration; its command and args do not match what nomarmy connect writes today.`, fix: `nomarmy connect ${target} --scope project (rewrite it), or review ${file} by hand`, short: 'project MCP changed' }]);
    }
    write(projectDir, relative, { mcpServers: { 'nomarmy-local-worker': { command: 'nomarmy', args: ['mcp'] } } });
    assert.deepEqual(await check(), []);
  }
});

test('Codex import requires explicit noninteractive consent and asks once in a terminal', async () => {
  const question = "Import your Codex login into OpenClaw? This copies the ChatGPT credential Codex stores into OpenClaw's auth store";
  for (const scenario of [{}, { removeEmailProfiles: true }, { isTTY: true, answer: false }, { isTTY: true, answer: true }, { importLogin: true }]) {
    const calls = [], questions = [], printed = []; let profiles = [];
    const allowed = scenario.importLogin === true || scenario.answer === true;
    const result = await linkCodex({ ...scenario, codexDir: '/fixture/codex', print: s => printed.push(s), confirm: async (...args) => { questions.push(args); return scenario.answer; }, run: async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'migrate') { profiles = [{ id: 'openai:account-test', provider: 'openai', type: 'oauth', label: '(Codex import)', expiresAt: '2099-01-01T00:00:00Z' }]; return { ok: true, stdout: 'SECRET_SENTINEL' }; }
      return { ok: true, stdout: JSON.stringify({ profiles }) };
    } });
    assert.equal(result, allowed);
    assert.deepEqual(questions, scenario.isTTY ? [[question, { defaultYes: true }]] : []);
    const list = ['models', 'auth', 'list', '--json'];
    assert.deepEqual(calls, allowed ? [list, ['migrate', 'apply', 'codex', '--from', '/fixture/codex', '--agent', 'main', '--include-secrets', '--item', 'auth:openai', '--yes'], list] : [list]);
    assert.deepEqual(printed, allowed ? ['Linking OpenClaw: openclaw migrate apply codex --from ~/.codex --agent main --include-secrets --item auth:openai --yes', "Imported the ChatGPT credential stored by Codex into OpenClaw's auth store.", 'Confirmed an unexpired openai:account- (Codex import) profile.'] : ['Nothing imported; use --link-openclaw to authorize the Codex login import non-interactively.']);
  }
});

// Build sealed pointer fixtures without launching Git or a worker.
function pointer(projectDir, worktree, name) {
  const gitdir = path.join(projectDir, '.git/worktrees', name);
  write(gitdir, 'gitdir', path.join(worktree, '.git'));
  const text = `gitdir: ${gitdir}\n`; write(worktree, '.git', text);
  return Buffer.from(text).toString('base64');
}
test('continuation of high work without stakes records high and retains independent review', async t => {
  const root = fixture(t), projectDir = path.join(root, 'repo'), jobsRoot = path.join(root, 'jobs');
  const oldTree = path.join(jobsRoot, id, 'worktree');
  const bytes = pointer(projectDir, oldTree, 'old');
  const record = { mode: 'implement', projectDir, worktree: oldTree, baseSha: 'base', stakes: 'high', worktreePointerBefore: { bytes } };
  const gitRecord = { repoStatusFiles: ['README.md'], changedFiles: ['README.md'], nameStatus: [], filesChanged: 1, additions: 1, deletions: 0, ignoredRuntimeJunk: [], testChanges: { production_files_changed: [], new_tests_added: [], existing_tests_modified: [], reviewRequired: false, reviewFlags: [] } };
  const executor = createExecutor({ VERSION: 'test', execution: 'local', projectDir, jobsRoot, assertRepo: async () => {}, ensureJobsRoot: () => {}, sweepStaleSandboxContainers: async () => {}, resolveBase: async () => ({ ref: 'base', sha: 'base' }),
    run: async (_cmd, args) => { if (args[0] === 'worktree') pointer(projectDir, args[4], path.basename(path.dirname(args[4]))); return { stdout: '' }; },
    gitRaw: async () => '', runOpenClaw: async () => ({ final: 'STATUS: done\nTESTS: pass\nNOT_DONE: none\nNOTE: done' }), collectGitRecord: async () => gitRecord,
    normalizeVerification: x => x, verificationFlow: { verificationRunner: true }, runIndependentVerification: async () => ({ status: 'pass', issues: [] }), repoPolicy: () => ({}),
    createCoordinatorCommit: async () => ({ created: false, sha: null, reason: 'fixture' }), buildMetrics: () => ({}), recordedBudgets: () => ({}), resolveReasoningApplied: () => 'high',
  });
  for (const [retained, brief, expected] of [['high', undefined, 'high'], ['high', 'normal', 'high'], ['normal', 'high', 'high'], ['normal', 'normal', 'normal']]) {
    write(jobsRoot, `${id}/metadata.json`, { ...record, stakes: retained });
    const jobId = `new-${retained}-${brief}`;
    const result = await executor.executeJob({ task: 'finish', continueFrom: id, ...(brief ? { stakes: brief } : {}), verification: 'quick', jobId });
    assert.deepEqual(Object.keys(result).sort(), ['jobDir', 'manifest', 'ok', 'report']);
    assert.deepEqual(Object.keys(result.manifest).sort(), ['version', 'jobId', 'workerId', 'mode', 'projectDir', 'worktree', 'branch', 'startedAt', 'finishedAt', 'objective', 'acceptance', 'verificationProfile', 'continuedFrom', 'stakes', 'outcome', 'recovered', 'recoveryAttempted', 'reportRecoveryAttempted', 'reportRecovered', 'reviewRequired', 'coordinatorStatus', 'issues', 'runnerNotes', 'reportValidation', 'independentVerification', 'regressionCheck', 'testSelectionRisk', 'trust', 'unwiredDefinitions', 'testChanges', 'metrics', 'worktreePointerBefore', 'worktreePointerAfterWorker', 'worktreeRetained', 'commit', 'gitBeforeCoordinatorCommit', 'git', 'worker', 'workerError', 'workerStopReason', 'budgets', 'timeBudget', 'requestedProfile', 'requestedReasoning', 'reasoningApplied', 'execution'].sort());
    assert.equal(result.manifest.stakes, expected);
    assert.equal(result.manifest.reviewRequired, expected === 'high');
    assert.equal(result.manifest.issues.includes(HIGH_STAKES_NOTE), expected === 'high');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.jobDir, 'metadata.json'))), result.manifest);
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.jobDir, 'status.json'))).projectDir, projectDir);
  }
});

test('admission inherits high stakes before enforcing verification policy', async t => {
  const root = fixture(t), jobsRoot = path.join(root, 'jobs');
  const worktree = path.join(jobsRoot, id, 'worktree'); fs.mkdirSync(worktree, { recursive: true });
  write(jobsRoot, `${id}/metadata.json`, { mode: 'implement', projectDir: root, worktree, baseSha: 'base', stakes: 'high' });
  const budgets = deriveBudgets({ env: {} });
  const runtime = createJobRuntime({ env: { NOMARMY_EXECUTION: 'hosted' }, projectDir: root, projectDirProblem: () => null, stateRoot: root, jobsRoot, leasesRoot: path.join(root, 'leases'), budgetState: { hardwareSnapshot: null, contextInfo: { slots: 3 }, budgets, refresh: async () => {} }, currentMaxWorkers: () => 2, agentsConfig: () => ({ agents: { local: { kind: 'local', slot: 'coder' } } }), budgetsForJob: () => budgets, subscriptionJobFieldProblems: () => [], repoPolicy: () => ({}) });
  const job = { task: 'finish', continue_from: id, agentName: 'local' };
  const result = await runtime.admit([job]);
  assert.deepEqual(Object.keys(result).sort(), ['admission', 'problems']);
  assert.equal(job.stakes, 'high');
  assert.deepEqual(result.problems, ['a stakes: high job needs a `verification` profile: its result is only as good as the tests that prove it']);
});
