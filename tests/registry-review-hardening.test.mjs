import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { composeSandboxImage, ensureComposedImageBuilt, pythonRequirementsFor } from '../lib/sandbox-images.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-hardening-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'requirements.txt'), 'example==1');
  return { root, repo };
}
const sourceError = { message: 'sandbox dependency source must be a repository-contained regular file (no absolute or escaping paths)' };
for (const kind of ['absolute', 'parent', 'symlink', 'directory-symlink']) {
  test(`requirements reject ${kind} sources before composing`, t => {
    const { root, repo } = fixture(t);
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'example==1');
    fs.symlinkSync(outside, path.join(repo, 'linked.txt'));
    fs.symlinkSync(root, path.join(repo, 'linked-dir'));
    const source = { absolute: outside, parent: '../outside.txt', symlink: 'linked.txt', 'directory-symlink': 'linked-dir/outside.txt' }[kind];
    const config = { environment: { python: { requirements: [source] } } };
    assert.throws(() => pythonRequirementsFor(repo, config), sourceError);
    assert.throws(() => composeSandboxImage(repo, config), sourceError);
    assert.throws(() => ensureComposedImageBuilt(repo, config, { trustedDir: repo, run: () => assert.fail('no build') }), sourceError);
  });
}

test('recipe sources reject an escaping Node manifest symlink even without credentials', t => {
  const { root, repo } = fixture(t);
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.symlinkSync(path.join(root, 'package.json'), path.join(repo, 'package.json'));
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}');
  assert.throws(() => composeSandboxImage(repo), sourceError);
});

for (const declaration of ['npm: ./do-not-read', 'pip:\n    netrc: ./do-not-read', '{}']) {
  test(`no trustedDir inspects only the YAML key: ${declaration}`, t => {
    const { repo } = fixture(t);
    const forbidden = path.join(repo, 'do-not-read');
    fs.writeFileSync(path.join(repo, '.nomarmy.local.yml'), `registries: ${declaration === '{}' ? '{}' : '\n  ' + declaration}\n`);
    const accesses = [];
    for (const method of ['statSync', 'readFileSync', 'existsSync', 'lstatSync', 'realpathSync']) {
      const original = fs[method];
      t.mock.method(fs, method, function(file, ...args) {
        if (path.resolve(String(file)) === forbidden) {
          accesses.push(method);
          throw new Error('credential path must not be inspected');
        }
        return original.call(this, file, ...args);
      });
    }
    const expected = 'private-registry credentials were not used: this job changed dependency inputs (trusted checkout unavailable)';
    const preview = composeSandboxImage(repo, null, undefined, {});
    assert.deepEqual(Object.keys(preview).sort(), ['dockerfile', 'files', 'image', 'note', 'pathEntries']);
    assert.equal(preview.note, expected);
    assert.equal(preview.dockerfile.includes('--mount=type=secret'), false);
    const notes = [], builds = [];
    ensureComposedImageBuilt(repo, null, { onNote: note => notes.push(note), run: (_cmd, args) => {
      if (args[0] === 'build') builds.push(args);
      return '';
    } });
    assert.equal(builds.length, 1);
    assert.equal(builds[0].includes('--secret'), false);
    assert.deepEqual(notes, [expected]);
    assert.deepEqual(accesses, []);
  });
}
