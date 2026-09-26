import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseYaml } from './config.mjs';
import { target } from './egress-proxy.mjs';

export function validateVerificationNetwork(value) {
  const mapping = v => v && typeof v === 'object' && !Array.isArray(v);
  if (!mapping(value) || Object.keys(value).some(k => !['allow', 'env'].includes(k)) ||
      !Array.isArray(value.allow) || !value.allow.length || !mapping(value.env ?? {})) throw new Error('invalid verification_network: expected allow list and env name mapping');
  let allow;
  try { allow = [...new Set(value.allow.map(v => target(v).authority))]; }
  catch { throw new Error('verification_network.allow requires exact public DNS hosts with optional ports (no IPs or private names)'); }
  const env = {};
  for (const [name, source] of Object.entries(value.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof source !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source) ||
        /^(?:https?_proxy|no_proxy|all_proxy)$/i.test(name) || name === '__proto__') throw new Error('verification_network.env must map test variable names to host variable names; proxy variables are reserved');
    Object.defineProperty(env, name, { value: source, enumerable: true });
  }
  return { allow, env };
}

// Never call this on a job worktree. Only the coordinator supplies projectDir.
// Fail closed if Git cannot establish both untracked and ignored provenance.
export function loadVerificationNetwork(projectDir, { check = (args) => spawnSync('git', args, { cwd: projectDir, encoding: 'utf8', timeout: 5000 }) } = {}) {
  if (!projectDir) return null;
  const filename = '.nomarmy.local.yml', file = path.join(projectDir, filename);
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error('cannot read operator-local verification policy'); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('verification_network requires a regular operator-local file');
  const tracked = check(['ls-files', '--error-unmatch', '--', filename]);
  const ignored = check(['check-ignore', '-q', '--', filename]);
  if (tracked.status !== 1 || ignored.status !== 0) throw new Error('verification_network requires an untracked, gitignored .nomarmy.local.yml');
  // Do not include YAML parser errors: the document might contain a mistaken secret.
  let parsed;
  try { parsed = parseYaml(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('invalid operator-local YAML'); }
  return parsed?.verification_network === undefined ? null : validateVerificationNetwork(parsed.verification_network);
}

export function redactCredentials(value, secrets) {
  let text = String(value ?? '');
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('***');
    // Capturing may have cut the final chunk in the middle of a credential.
    for (let n = Math.min(secret.length - 1, text.length); n > 0; n--) {
      if (text.endsWith(secret.slice(0, n))) { text = text.slice(0, -n) + '***'; break; }
    }
  }
  return text;
}
