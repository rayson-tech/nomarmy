#!/usr/bin/env node
// Measure phase-2 trust against a corpus kept outside this repository.
// Usage: node scripts/trust-measure.mjs <corpus-dir> [--judgment off|jev|judge] [--json]
// <corpus-dir>/corpus.json is an array of { "kind": "defect" | "harmless",
// "diff": "diffs/<name>.diff", ... }. Optional free-form fields such as fix,
// introduced_by, what, subject and commit are echoed, never interpreted.
// Each diff is a git-show-style unified diff of one or more files. Only the
// hunk's removed/context lines form before and added/context lines form after;
// new and deleted files use an empty snapshot on the absent side.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { evaluateDiffTrust } from '../lib/trust-judgment.mjs';
import { jevSettings, judgeSettings, askJev } from '../lib/validators.mjs';
import { askJudge } from '../lib/judge.mjs';
import { loadAgents, agentProviderId, agentRunsToolsOnHost } from '../lib/agents.mjs';
import { globalConfigDir } from '../lib/army.mjs';

export function fileChangesFromDiff(diff) {
  const changes = [];
  let current = null, hunk = null;
  const flush = () => {
    if (!current) return;
    if (!current.hunks) throw new Error(`No hunks for ${current.file}`);
    if (hunk && (hunk.old !== 0 || hunk.new !== 0)) throw new Error(`Incomplete hunk for ${current.file}`);
    changes.push({ file: current.file, before: current.before.join('\n'), after: current.after.join('\n') });
    current = null;
  };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) { flush(); current = { file: null, before: [], after: [], hunks: 0 }; hunk = null; continue; }
    if (!current) continue;
    if (line.startsWith('+++ ')) {
      const name = line.slice(4);
      if (name !== '/dev/null') current.file = name.startsWith('b/') ? name.slice(2) : name;
      continue;
    }
    if (line.startsWith('--- ') && !current.file) {
      const name = line.slice(4);
      if (name !== '/dev/null') current.file = name.startsWith('a/') ? name.slice(2) : name;
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      if (!current.file) throw new Error('Hunk has no file name');
      if (hunk && (hunk.old !== 0 || hunk.new !== 0)) throw new Error(`Incomplete hunk for ${current.file}`);
      const oldStart = Number(match[1]), newStart = Number(match[3]);
      if (oldStart > 0 && current.before.length > oldStart - 1 || newStart > 0 && current.after.length > newStart - 1) throw new Error(`Overlapping hunks for ${current.file}`);
      while (current.before.length < oldStart - 1) current.before.push('');
      while (current.after.length < newStart - 1) current.after.push('');
      hunk = { old: Number(match[2] ?? 1), new: Number(match[4] ?? 1) };
      current.hunks++;
      continue;
    }
    if (!hunk || (hunk.old === 0 && hunk.new === 0)) continue;
    const prefix = line[0];
    if (prefix === ' ' || prefix === '-') { current.before.push(line.slice(1)); hunk.old--; }
    if (prefix === ' ' || prefix === '+') { current.after.push(line.slice(1)); hunk.new--; }
    if (![' ', '-', '+', '\\'].includes(prefix) || hunk.old < 0 || hunk.new < 0) throw new Error(`Invalid hunk for ${current.file}`);
    // Accept Git's no-newline marker; snapshots are assembled from hunk lines.
    if (prefix === '\\' && line !== '\\ No newline at end of file') throw new Error(`Invalid hunk marker for ${current.file}`);
  }
  if (hunk && (hunk.old !== 0 || hunk.new !== 0)) throw new Error(`Incomplete hunk for ${current.file}`);
  flush();
  if (!changes.length) throw new Error('Diff contains no file changes');
  return changes;
}

function options(argv) {
  let dir, judgment = 'off', json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--judgment' && i + 1 < argv.length) judgment = argv[++i];
    else if (!argv[i].startsWith('-') && !dir) dir = argv[i];
    else throw new Error(`Unexpected argument: ${argv[i]}`);
  }
  if (!dir || !['off', 'jev', 'judge'].includes(judgment)) throw new Error('Usage: node scripts/trust-measure.mjs <corpus-dir> [--judgment off|jev|judge] [--json]');
  return { dir: path.resolve(dir), judgment, json };
}

function validatorFor(mode) {
  if (mode === 'off') return { judgment: false };
  if (mode === 'jev') {
    const jev = jevSettings();
    if (!jev) throw new Error('Skipped: Jev is not configured with a readable key.');
    return { jev, askJev };
  }
  const configDir = globalConfigDir();
  let agents;
  try { agents = loadAgents(configDir).agents; } catch (error) { throw new Error(`Skipped: judge agents are not configured: ${error.message}`); }
  const judge = judgeSettings({ configDir, agents, providerOf: agentProviderId, runsOnHost: agentRunsToolsOnHost });
  if (!judge || judge.problem) throw new Error(`Skipped: judge is not configured: ${judge?.problem ?? 'no enabled judge'}`);
  return { judge, askJudge, stateRoot: process.env.NOMARMY_AGENT_STATE || path.join(os.homedir(), '.local', 'share', 'nomarmy-local-agents') };
}

export async function measure(dir, mode = 'off', validator = validatorFor(mode)) {
  const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  if (!Array.isArray(corpus)) throw new Error('corpus.json must be an array');
  const items = [];
  for (const [index, item] of corpus.entries()) {
    if (!item || !['defect', 'harmless'].includes(item.kind) || typeof item.diff !== 'string') throw new Error(`Invalid corpus item ${index + 1}`);
    const diffPath = path.resolve(dir, item.diff);
    if (!diffPath.startsWith(`${dir}${path.sep}`)) throw new Error(`Diff path escapes corpus directory: ${item.diff}`);
    const fileChanges = fileChangesFromDiff(fs.readFileSync(diffPath, 'utf8'));
    const trust = await evaluateDiffTrust({ floor: { level: 'normal', reasons: [] }, fileChanges, ...validator });
    const { kind, diff, ...metadata } = item;
    items.push({ kind, label: path.basename(diff, path.extname(diff)), diff, ...metadata, judgment: trust.judgment, level: trust.level, findings: trust.checks.length, reason: trust.reasons[0]?.reason ?? null });
  }
  const count = (kind, caught) => items.filter(i => i.kind === kind && (i.level !== 'normal') === caught).length;
  const defects = count('defect', true) + count('defect', false);
  const harmless = count('harmless', true) + count('harmless', false);
  return { items, judged: items.filter(item => item.judgment.status === 'available').length, confusion: {
    defects: { caught: count('defect', true), missed: count('defect', false), catchRate: defects ? count('defect', true) / defects : null },
    harmless: { normal: count('harmless', false), falsePositives: count('harmless', true), falsePositiveRate: harmless ? count('harmless', true) / harmless : null },
  } };
}

export function measurementLine(item) {
  const { kind, label, level, findings, reason, diff, judgment, ...metadata } = item;
  const unavailable = judgment.status === 'unavailable' ? `\tjudgment unavailable: ${judgment.error}` : '';
  return `${kind}\t${label}\t${level}\t${findings}\t${reason ?? 'none'}${unavailable}${Object.keys(metadata).length ? `\t${JSON.stringify(metadata)}` : ''}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { dir, judgment, json } = options(process.argv.slice(2));
    const result = await measure(dir, judgment);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const item of result.items) console.log(measurementLine(item));
      console.log(`judged\t${result.judged}/${result.items.length}`);
      const { defects, harmless } = result.confusion;
      console.log('kind\tcaught/normal\tmissed/false positives\trate');
      console.log(`defects\t${defects.caught}\t${defects.missed}\t${defects.catchRate === null ? 'n/a' : (100 * defects.catchRate).toFixed(1) + '%'}`);
      console.log(`harmless\t${harmless.normal}\t${harmless.falsePositives}\t${harmless.falsePositiveRate === null ? 'n/a' : (100 * harmless.falsePositiveRate).toFixed(1) + '%'}`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
