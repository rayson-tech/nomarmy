import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileChangesFromDiff, measure, measurementLine } from '../scripts/trust-measure.mjs';

const script = path.resolve('scripts/trust-measure.mjs');
const wrap = (file, hunk, old = `a/${file}`, next = `b/${file}`) => `commit fixture\n\ndiff --git a/${file} b/${file}\n--- ${old}\n+++ ${next}\n${hunk}\n`;

test('reconstructs context, multiple files, new and deleted files', () => {
  const diff = wrap('a.py', '@@ -1,3 +1,3 @@\n context\n-if not authorized:\n+if authorized:\n     return 403') + wrap('new.ts', '@@ -0,0 +1 @@\n+const value = 1;', '/dev/null') + wrap('gone.sql', '@@ -1 +0,0 @@\n-ALTER TABLE data ENABLE ROW LEVEL SECURITY;', 'a/gone.sql', '/dev/null');
  assert.deepEqual(fileChangesFromDiff(diff), [
    { file: 'a.py', before: 'context\nif not authorized:\n    return 403', after: 'context\nif authorized:\n    return 403' },
    { file: 'new.ts', before: '', after: 'const value = 1;' },
    { file: 'gone.sql', before: 'ALTER TABLE data ENABLE ROW LEVEL SECURITY;', after: '' },
  ]);
});

test('synthetic corpus reports exact levels and confusion in text and JSON without writing', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-measure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'diffs'));
  const fixtures = [
    ['guard', 'defect', wrap('auth.py', '@@ -1,2 +1 @@\n-if not authorized:\n-    raise Denied()\n+pass')],
    ['policy', 'defect', wrap('policy.sql', '@@ -1 +0,0 @@\n-ALTER TABLE data ENABLE ROW LEVEL SECURITY;', 'a/policy.sql', '/dev/null')],
    ['comment', 'harmless', wrap('auth.py', '@@ -1 +1 @@\n-# old note\n+# new note')],
    ['addition', 'harmless', wrap('new.ts', '@@ -0,0 +1 @@\n+validateInput(value);', '/dev/null')],
  ];
  for (const [name, , diff] of fixtures) fs.writeFileSync(path.join(dir, 'diffs', `${name}.diff`), diff);
  fs.writeFileSync(path.join(dir, 'corpus.json'), JSON.stringify(fixtures.map(([name, kind]) => ({ kind, diff: `diffs/${name}.diff`, subject: `case ${name}` }))));
  const expected = { items: [
    { kind: 'defect', label: 'guard', diff: 'diffs/guard.diff', subject: 'case guard', level: 'review', findings: 1, reason: 'Removes or changes an access guard at auth.py:1.' },
    { kind: 'defect', label: 'policy', diff: 'diffs/policy.diff', subject: 'case policy', level: 'review', findings: 1, reason: 'Removes or changes a row-level security policy at policy.sql:1.' },
    { kind: 'harmless', label: 'comment', diff: 'diffs/comment.diff', subject: 'case comment', level: 'normal', findings: 0, reason: null },
    { kind: 'harmless', label: 'addition', diff: 'diffs/addition.diff', subject: 'case addition', level: 'normal', findings: 0, reason: null },
  ].map(item => ({ ...item, judgment: { status: 'disabled', validator: null, answers: {}, error: null } })), judged: 0, confusion: { defects: { caught: 2, missed: 0, catchRate: 1 }, harmless: { normal: 2, falsePositives: 0, falsePositiveRate: 0 } } };
  assert.deepEqual(await measure(dir), expected);
  const json = spawnSync(process.execPath, [script, dir, '--json'], { encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), expected);
  const text = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, 'defect\tguard\treview\t1\tRemoves or changes an access guard at auth.py:1.\t{"subject":"case guard"}\n' +
    'defect\tpolicy\treview\t1\tRemoves or changes a row-level security policy at policy.sql:1.\t{"subject":"case policy"}\n' +
    'harmless\tcomment\tnormal\t0\tnone\t{"subject":"case comment"}\n' +
    'harmless\taddition\tnormal\t0\tnone\t{"subject":"case addition"}\n' +
    'judged\t0/4\n' +
    'kind\tcaught/normal\tmissed/false positives\trate\n' +
    'defects\t2\t0\t100.0%\n' + 'harmless\t2\t0\t0.0%\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['corpus.json', 'diffs']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'diffs')).sort(), ['addition.diff', 'comment.diff', 'guard.diff', 'policy.diff']);
});

test('unavailable corpus judgments retain reasons continue and count judged items', async (t) => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.measure-unavailable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cases = [
    ['huge', 'x'.repeat(60000)],
    ['offline', 'offline'],
    ['available', 'small'],
  ];
  fs.writeFileSync(path.join(dir, 'corpus.json'), JSON.stringify(cases.map(([name]) => ({ kind: 'harmless', diff: name + '.diff' }))));
  for (const [name, text] of cases) fs.writeFileSync(path.join(dir, name + '.diff'), wrap('a.txt', '@@ -0,0 +1 @@\n+' + text, '/dev/null'));
  let calls = 0;
  const result = await measure(dir, 'judge', { judge: {}, askJudge: async () => {
    calls++;
    if (calls === 1) throw Error('fixture offline');
    return { answer: { access: 0, checks: 0, data: 0 } };
  } });
  const unavailable = error => ({ status: 'unavailable', validator: 'judge', answers: {}, error });
  assert.deepEqual(result, {
    items: [
      { kind: 'harmless', label: 'huge', diff: 'huge.diff', level: 'review', findings: 0,
        reason: 'the diff is too large to judge (60070 characters); review it',
        judgment: unavailable('Trust evidence exceeds the validator budget.') },
      { kind: 'harmless', label: 'offline', diff: 'offline.diff', level: 'normal', findings: 0, reason: null, judgment: unavailable('fixture offline') },
      { kind: 'harmless', label: 'available', diff: 'available.diff', level: 'normal', findings: 0, reason: null,
        judgment: { status: 'available', validator: 'judge', answers: { access: 0, checks: 0, data: 0 }, error: null } },
    ],
    judged: 1,
    confusion: { defects: { caught: 0, missed: 0, catchRate: null }, harmless: { normal: 2, falsePositives: 1, falsePositiveRate: 1 / 3 } },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.items.map(measurementLine), [
    'harmless\thuge\treview\t0\tthe diff is too large to judge (60070 characters); review it\tjudgment unavailable: Trust evidence exceeds the validator budget.',
    'harmless\toffline\tnormal\t0\tnone\tjudgment unavailable: fixture offline',
    'harmless\tavailable\tnormal\t0\tnone',
  ]);
});
