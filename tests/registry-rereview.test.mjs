import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { composeSandboxImage, ensureComposedImageBuilt } from '../lib/sandbox-images.mjs';

function fixture(t, files, ecosystem = 'pip') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-rereview-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), content);
  }
  fs.writeFileSync(path.join(cwd, 'credential'), 'synthetic');
  fs.writeFileSync(path.join(cwd, '.nomarmy.local.yml'), `registries:\n  ${ecosystem}: ./credential\n`);
  return cwd;
}
const cases = [
  ['git+https://hidden/x', 'VCS requirement'], ['hg+https://hidden/x', 'VCS requirement'],
  ['svn+https://hidden/x', 'VCS requirement'], ['bzr+https://hidden/x', 'VCS requirement'],
  ['pkg @ https://hidden/x', 'URL requirement'], ['https://hidden/x', 'URL requirement'],
  ['./hidden', 'path requirement'], ['pkg.tar.gz', 'path requirement'],
  ['local-package', 'path requirement'],
  ['-e ./hidden', 'editable requirement'], ['--editable=./hidden', 'editable requirement'],
  ['--no-binary=:all:', 'requirements option'], ['--only-binary=:none:', 'requirements option'],
  ['--find-links http://hidden/x', 'requirements option'],
  ['pkg; python_version > \"3\" --no-binary=:all:', 'requirements option'],
  ['-r ../hidden', 'escaping requirements include'], ['-c /hidden', 'escaping requirements include'],
];
for (const [line, kind] of cases) test(`credentialed pip refuses ${line}`, t => {
  const cwd = fixture(t, { 'requirements.txt': `# heading\n${line}\n`, 'local-package/setup.py': 'raise RuntimeError(\"must not execute\")' });
  const calls = [];
  assert.throws(() => ensureComposedImageBuilt(cwd, null, { trustedDir: cwd, run: (...args) => { calls.push(args); return ''; } }), {
    message: `registries: Python line 2: ${kind} is not allowed with credentials`,
  });
  assert.deepEqual(calls, []);
});
for (const flag of ['-r', '-c']) test(`credentialed pip validates nested ${flag} inputs`, t => {
  const cwd = fixture(t, { 'requirements.txt': `${flag} nested/deps.txt`, 'nested/deps.txt': 'ok==1\n--no-binary=:all:' });
  const calls = [];
  assert.throws(() => ensureComposedImageBuilt(cwd, null, { trustedDir: cwd, run: (...args) => calls.push(args) }), {
    message: 'registries: Python line 2: requirements option is not allowed with credentials',
  });
  assert.deepEqual(calls, []);
});
test('safe includes are copied, rewritten and covered by trusted input comparison', t => {
  const cwd = fixture(t, { 'requirements.txt': '-r nested/deps.txt', 'nested/deps.txt': '--index-url https://example.test/simple\n--extra-index-url https://example.test/more\n--find-links https://example.test/wheels\n--trusted-host example.test\n--require-hashes\npkg==1 --hash=sha256:abcd' });
  const recipe = composeSandboxImage(cwd, null, undefined, { trustedDir: cwd });
  assert.deepEqual(recipe.files, [
    { source: 'requirements.txt', destination: 'py/req-0.txt', content: '-r req-1.txt' },
    { source: 'nested/deps.txt', destination: 'py/req-1.txt' },
  ]);
  assert.match(recipe.dockerfile, /COPY py\/req-1.txt \/deps\/requirements\/req-1.txt/);
  assert.match(recipe.dockerfile, /--only-binary=:all: -r \/deps\/requirements\/req-0.txt/);
  const job = fixture(t, { 'requirements.txt': '-r nested/deps.txt', 'nested/deps.txt': 'changed==1' });
  const changed = composeSandboxImage(job, null, undefined, { trustedDir: cwd });
  assert.equal(changed.note, 'private-registry credentials were not used: this job changed dependency inputs (nested/deps.txt)');
  assert.equal(changed.dockerfile.includes('--mount=type=secret'), false);
});
for (const section of ['dependencies=["pkg @ https://hidden/x"]', '[project.optional-dependencies]\ndev=["pkg @ https://hidden/x"]']) test(`pyproject URL refused: ${section}`, t => {
  const cwd = fixture(t, { 'pyproject.toml': `[project]\n${section}\n` });
  const calls = [];
  assert.throws(() => ensureComposedImageBuilt(cwd, null, { trustedDir: cwd, run: (...args) => calls.push(args) }), {
    message: 'registries: Python line dependency list: URL requirement is not allowed with credentials',
  });
  assert.deepEqual(calls, []);
});
for (const source of ['git', 'url', 'path']) test(`uv lock refuses ${source}`, t => {
  const cwd = fixture(t, { 'pyproject.toml': '[project]\n', 'uv.lock': `[[package]]\nname="pkg"\nsource={${source}="hidden"}\n` });
  const calls = [];
  assert.throws(() => ensureComposedImageBuilt(cwd, null, { trustedDir: cwd, run: (...args) => calls.push(args) }), {
    message: 'registries: Python line uv.lock: git/url/path source is not allowed with credentials',
  });
  assert.deepEqual(calls, []);
});
for (const manager of ['pnpm', 'yarn']) for (const pinned of [false, true]) test(`${manager} preparation pinned=${pinned}`, t => {
  const cwd = fixture(t, { 'package.json': JSON.stringify(pinned ? { packageManager: `${manager}@${manager === 'yarn' ? '1.22.22' : '10.15.0'}` } : {}), [manager === 'pnpm' ? 'pnpm-lock.yaml' : 'yarn.lock']: '{}' }, 'npm');
  const lines = composeSandboxImage(cwd, null, undefined, { trustedDir: cwd }).dockerfile.split('\n');
  const mountIndex = lines.findIndex(line => line.includes('--mount=type=secret'));
  assert.equal(lines[mountIndex - 1], `RUN cd '/deps' && ${pinned ? 'corepack install' : manager === 'yarn' ? 'corepack prepare yarn@1 --activate && yarn --version' : 'pnpm --version'}`);
  assert.equal(lines.slice(0, mountIndex).filter(line => line.startsWith('USER ')).at(-1), 'USER node');
  assert.match(lines[mountIndex], /COREPACK_ENABLE_NETWORK=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0/);
  assert.doesNotMatch(lines[mountIndex], /COREPACK_HOME=|target=\/home\/node\/\.cache/);
});
test('uv bootstrap and venv creation precede the mount', t => {
  const cwd = fixture(t, { 'pyproject.toml': '[project]\n', 'uv.lock': '' });
  const lines = composeSandboxImage(cwd, null, undefined, { trustedDir: cwd }).dockerfile.split('\n');
  const index = lines.findIndex(line => line.includes('--mount=type=secret'));
  assert.equal(lines[index - 2], 'RUN python3 -m venv /deps/python/.venv');
  assert.equal(lines[index - 1], 'RUN pip3 install --no-cache-dir --break-system-packages --only-binary=:all: --index-url https://pypi.org/simple uv==0.8.22');
  assert.match(lines[index], /; cd \/deps\/python && \(uv sync --frozen --no-install-project --all-groups --no-build \|\| touch .nomarmy-uv-install-failed\)/);
  assert.doesNotMatch(lines[index], /pip3|python3|venv &&/);
});
test('null-options preview never inspects credential paths', t => {
  const cwd = fixture(t, { 'requirements.txt': 'pkg==1' });
  const accesses = [];
  for (const method of ['statSync', 'readFileSync', 'existsSync', 'lstatSync', 'realpathSync']) {
    const original = fs[method];
    t.mock.method(fs, method, function(file, ...args) {
      if (String(file) === path.join(cwd, 'credential')) { accesses.push(method); throw new Error('forbidden read'); }
      return original.call(this, file, ...args);
    });
  }
  const recipe = composeSandboxImage(cwd, null, undefined, null);
  assert.deepEqual(Object.keys(recipe).sort(), ['dockerfile', 'files', 'image', 'pathEntries']);
  assert.equal(recipe.dockerfile.includes('--mount=type=secret'), false);
  assert.deepEqual(accesses, []);
});
