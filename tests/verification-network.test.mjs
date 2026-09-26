import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { readArmyFile } from '../lib/army.mjs';
import { validateConfig } from '../lib/config.mjs';
import { validateVerificationNetwork, loadVerificationNetwork, redactCredentials } from '../lib/verification-network.mjs';
import { createEgressProxy, publicAddress } from '../lib/egress-proxy.mjs';
import { createPodmanExecutor, createVerificationRunner, DEFAULT_AGENT_IMAGE } from '../lib/verify.mjs';
import { createVerificationFlow } from '../lib/verification-flow.mjs';

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomarmy-egress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const config = { verification: { quick: { commands: ['check'] } } };
const policy = { allow: ['dev-12345.okta.com:443', 'api.stripe.com:80'], env: { OKTA_CLIENT_SECRET: 'NOMARMY_TEST_OKTA_SECRET' } };
const secret = 'throwaway-test-secret';
const token = 'test-proxy-token';
const auth = 'Basic ' + Buffer.from('nomarmy:' + token).toString('base64');

test('operator-local policy validates exact hosts and refuses committed authority', t => {
  assert.deepEqual(validateVerificationNetwork({ allow: ['Dev-12345.okta.com', 'api.stripe.com:80'], env: policy.env }), policy);
  for (const host of ['*.okta.com', '127.0.0.1', '2130706433', '0x7f000001', '[::1]', '10.1.2.3:443', 'localhost', 'foo.local', 'foo.internal', 'foo.lan', 'foo.home', 'metadata.google.internal', 'okta.com:0', 'okta.com:65536', 'okta.com/path', 'okta.com.', 'okta.com@evil.com']) {
    assert.throws(() => validateVerificationNetwork({ allow: [host] }), /exact public DNS hosts/, host);
  }
  for (const env of [{ SECRET: 'a secret!' }, { 'BAD=NAME': 'HOST' }, { SECRET: 7 }, { HTTP_PROXY: 'HOST' }]) assert.throws(() => validateVerificationNetwork({ allow: policy.allow, env }), /variable names/);
  assert.deepEqual(validateConfig({ verification_network: policy }), { valid: false, config: null, errors: ['verification_network is operator-local only: put it in gitignored .nomarmy.local.yml, never .nomarmy.yml'], elevated: { shared: [], remote: [] } });
  const dir = temporary(t);
  fs.writeFileSync(path.join(dir, '.nomarmy.local.yml'), 'verification_network:\n  allow: [dev-12345.okta.com, api.stripe.com:80]\n  env: {OKTA_CLIENT_SECRET: NOMARMY_TEST_OKTA_SECRET}\n');
  assert.equal(readArmyFile(path.join(dir, '.nomarmy.local.yml'), { armyOnly: true }), null);
  const calls = [];
  assert.deepEqual(loadVerificationNetwork(dir, { check: args => { calls.push(args); return { status: args[0] === 'ls-files' ? 1 : 0 }; } }), policy);
  assert.deepEqual(calls, [['ls-files', '--error-unmatch', '--', '.nomarmy.local.yml'], ['check-ignore', '-q', '--', '.nomarmy.local.yml']]);
  for (const status of [0, 128, null]) assert.throws(() => loadVerificationNetwork(dir, { check: () => ({ status }) }), /untracked, gitignored/);
  assert.equal(loadVerificationNetwork(null), null);
  fs.unlinkSync(path.join(dir, '.nomarmy.local.yml'));
  fs.symlinkSync('other.yml', path.join(dir, '.nomarmy.local.yml'));
  assert.throws(() => loadVerificationNetwork(dir), /regular operator-local file/);
});

async function listening(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  return server.address().port;
}
function get(proxyPort, url, authorization = auth) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: proxyPort, path: url, headers: authorization ? { 'Proxy-Authorization': authorization } : {} }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body }));
    }); req.on('error', reject);
  });
}

test('HTTP egress pins public DNS, denies private and unlisted targets, logs no payload', async t => {
  const seen = [];
  const upstreamPort = await listening(t, http.createServer((req, res) => { seen.push({ host: req.headers.host, url: req.url }); res.end('ok'); }));
  const logs = [], resolved = [], destinations = [];
  let address = '93.184.216.34';
  const proxy = createEgressProxy({ token, allow: ['example.com:80'], log: l => logs.push(l),
    resolve: async host => { resolved.push(host); return [{ address }]; },
    // Test transport reaches only our local server; production uses the pinned address.
    request: opts => { destinations.push(opts.hostname); return http.request({ ...opts, hostname: '127.0.0.1', port: upstreamPort }); },
  });
  const port = await listening(t, proxy);
  assert.deepEqual(await get(port, 'http://example.com/payload?secret=hidden'), { status: 200, body: 'ok' });
  assert.deepEqual(seen, [{ host: 'example.com:80', url: '/payload?secret=hidden' }]);
  assert.deepEqual(destinations, ['93.184.216.34']);
  assert.deepEqual(await get(port, 'http://evil.com/hidden'), { status: 403, body: '' });
  for (address of ['127.0.0.1', '10.2.3.4', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.100.100.200', '168.63.129.16', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::']) assert.deepEqual(await get(port, 'http://example.com/hidden'), { status: 403, body: '' }, address);
  assert.deepEqual(await get(port, 'http://127.0.0.1/hidden'), { status: 403, body: '' });
  assert.deepEqual(logs, ['example.com:80 connected', 'evil.com:80 denied', ...Array(12).fill('example.com:80 denied'), 'invalid:0 denied']);
  assert.deepEqual(resolved, Array(13).fill('example.com'));
  assert.equal(destinations.length, 1);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const ip of ['0.0.0.0', '224.0.0.1', '198.18.0.1', '2001:db8::1', '2001::1', '64:ff9b::7f00:1']) assert.equal(publicAddress(ip), false, ip);
});

function tunnel(port, authority, authorization = auth) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}\r\n`));
    socket.once('data', data => { socket.destroy(); resolve(data.toString()); });
  });
}
test('CONNECT egress enforces exact ports and rejects mixed private DNS answers', async t => {
  const upstream = net.createServer(s => { s.on('error', () => {}); });
  const upstreamPort = await listening(t, upstream);
  const logs = [], destinations = [];
  let addresses = [{ address: '93.184.216.34' }];
  const proxyPort = await listening(t, createEgressProxy({ token, allow: ['example.com'], log: l => logs.push(l), resolve: async () => addresses,
    connect: opts => { destinations.push(opts); return net.connect(upstreamPort, '127.0.0.1'); },
  }));
  assert.equal(await tunnel(proxyPort, 'example.com'), 'HTTP/1.1 200 Connection Established\r\n\r\n');
  for (const authority of ['evil.com:443', 'example.com:80', '127.0.0.1:443', '[::1]:443']) assert.equal(await tunnel(proxyPort, authority), 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  addresses = [{ address: '93.184.216.34' }, { address: '10.0.0.1' }];
  assert.equal(await tunnel(proxyPort, 'example.com:443'), 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  assert.deepEqual(destinations, [{ host: '93.184.216.34', port: 443 }]);
  assert.deepEqual(logs, ['example.com:443 connected', 'evil.com:443 denied', 'example.com:80 denied', 'invalid:0 denied', 'invalid:0 denied', 'example.com:443 denied']);
});

test('verification egress isolates credentials, networks, redaction and cleanup', async t => {
  const cwd = temporary(t), calls = [], environments = [];
  const collect = async (_file, args, options) => {
    calls.push(args); environments.push(options.env);
    return { spawned: true, code: 0, stdout: args[0] === 'logs' ? 'dev-12345.okta.com:443 connected\nunsafe payload\n' : args.includes('/bin/sh') ? `result ${secret}` : '', stderr: args.includes('/bin/sh') ? secret : '' };
  };
  const runner = createVerificationRunner({ image: 'sandbox:1', hostProjectDir: cwd,
    loadVerificationNetwork: () => policy, hostEnv: { NOMARMY_TEST_OKTA_SECRET: secret },
    loadConfig: () => ({ found: true, config: { ...config, harnesses: ['mock-oidc'] } }),
    executor: createPodmanExecutor({ collect }),
  });
  const result = await runner({ cwd, profile: 'quick', jobId: 'egress-test' });
  assert.deepEqual(Object.keys(result).sort(), ['artifacts', 'artifactsCapped', 'artifactsNote', 'basis', 'detail', 'issues', 'network', 'output', 'reason', 'status']);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.network, { allowlist: policy.allow, reached: ["dev-12345.okta.com:443"], credentials: ['OKTA_CLIENT_SECRET'] });
  assert.deepEqual(result.issues, ['verification had network access to dev-12345.okta.com:443, api.stripe.com:80']);
  assert.match(result.output, /^dev-12345.okta.com:443 connected\n\n\$ check  \(exit 0, \d+ms\)\noutput withheld: credentials were in use \(set verification_network.keep_output: true in .nomarmy.local.yml to keep it, redacted\)$/);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(calls.find(a => a[0] === 'stop'), ['stop', '--time', '2', 'nomarmy-egress-test-egress']);
  assert.equal(calls.findIndex(a => a[0] === 'stop') < calls.findIndex(a => a[0] === 'logs'), true);
  const verify = calls.find(a => a.includes('/bin/sh'));
  assert.equal(verify.includes('--network=nomarmy-egress-test'), true);
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) assert.equal(verify.includes(name), true);
  assert.equal(verify.includes('NO_PROXY=mock-oidc'), true);
  assert.equal(verify.includes('no_proxy=mock-oidc'), true);
  assert.equal(verify.includes('OKTA_CLIENT_SECRET'), true);
  assert.equal(environments[calls.indexOf(verify)].OKTA_CLIENT_SECRET, secret);
  const proxyToken = environments[calls.findIndex(a => a.includes('/egress-proxy.mjs'))].NOMARMY_EGRESS_TOKEN;
  assert.match(proxyToken, /^[a-f0-9]{64}$/);
  assert.equal(environments[calls.indexOf(verify)].HTTPS_PROXY, `http://nomarmy:${proxyToken}@egress:3128`);
  assert.equal(JSON.stringify(calls).includes(proxyToken), false);
  assert.deepEqual(calls.filter(a => a.join(' ').includes(secret)), []);
  const proxy = calls.find(a => a.includes('/egress-proxy.mjs'));
  assert.equal(proxy.includes('nomarmy-egress-test:alias=egress'), true);
  assert.equal(proxy.includes('nomarmy-egress-test-external'), true);
  for (const arg of ['--user=1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only', DEFAULT_AGENT_IMAGE]) assert.equal(proxy.includes(arg), true);
  assert.deepEqual(calls.filter(a => a[0] === 'network'), [
    ['network', 'create', '--internal', 'nomarmy-egress-test'], ['network', 'create', 'nomarmy-egress-test-external'],
    ['network', 'rm', 'nomarmy-egress-test-external'], ['network', 'rm', 'nomarmy-egress-test'],
  ]);
  assert.deepEqual(calls.filter(a => a[0] === 'rm').map(a => a.at(-1)).sort(), ['nomarmy-egress-test-egress', 'nomarmy-egress-test-egress-health', 'nomarmy-egress-test-health-mock-oidc', 'nomarmy-egress-test-service-mock-oidc']);
  assert.equal(redactCredentials(`x ${secret} ${secret.slice(0, 8)}`, [secret]), 'x *** ***');
  const missing = await createVerificationRunner({ image: 'sandbox:1', loadConfig: () => ({ found: true, config }), loadVerificationNetwork: () => policy, hostEnv: {}, executor: { probe: () => assert.fail('missing secret must not run') } })({ cwd, profile: 'quick' });
  assert.deepEqual(missing, { status: 'not_run', basis: 'missing-credential', reason: 'missing host environment variable NOMARMY_TEST_OKTA_SECRET', detail: null, network: { allowlist: policy.allow, reached: [], credentials: ['OKTA_CLIENT_SECRET'] } });
  // A local file created by the worker is not operator authority.
  fs.writeFileSync(path.join(cwd, '.nomarmy.local.yml'), 'verification_network: {allow: [evil.com]}');
  calls.length = 0;
  assert.equal((await createVerificationRunner({ image: 'sandbox:1', loadConfig: () => ({ found: true, config }), executor: createPodmanExecutor({ collect }) })({ cwd, profile: 'quick' })).status, 'pass');
  assert.equal(calls.find(a => a.includes('/bin/sh')).includes('--network=none'), true);
  assert.equal(calls.some(a => a[0] === 'network'), false);
  for (const failure of ['proxy', 'health', 'command', 'logs', 'log-cap']) {
    const failedCalls = [];
    const executor = createPodmanExecutor({ collect: async (_file, args) => {
      failedCalls.push(args);
      const fail = failure === 'proxy' && args.includes('/egress-proxy.mjs') || failure === 'health' && args.includes('--input-type=module') || failure === 'command' && args.includes('/bin/sh') || failure === 'logs' && args[0] === 'logs';
      return { spawned: true, code: fail ? 125 : 0, stdout: failure === 'log-cap' && args[0] === 'logs' ? 'x'.repeat(4 * 1024 * 1024) : '', stderr: '' };
    } });
    const failed = await createVerificationRunner({ image: 'sandbox:1', loadConfig: () => ({ found: true, config }), loadVerificationNetwork: () => policy, hostEnv: { NOMARMY_TEST_OKTA_SECRET: secret }, executor })({ cwd, profile: 'quick', jobId: 'failure' });
    assert.equal(failed.status, 'not_run', failure);
    if (failure === 'log-cap') assert.equal(failed.reason, 'could not capture egress verdict log');
    assert.deepEqual(failedCalls.slice(-2), [['network', 'rm', 'nomarmy-failure-external'], ['network', 'rm', 'nomarmy-failure']]);
    assert.equal(failedCalls.some(a => a[0] === 'rm' && a.at(-1) === 'nomarmy-failure-egress'), true);
  }
});

test('network verification records preserve authority and verdict logs', async t => {
  const dir = temporary(t);
  const flow = createVerificationFlow({ ensureJobsRoot: () => dir });
  const network = { allowlist: policy.allow, credentials: ['OKTA_CLIENT_SECRET'] };
  const issues = ['verification had network access to dev-12345.okta.com:443, api.stripe.com:80'];
  flow.registerVerificationRunner(async () => ({ status: 'pass', network, issues, output: 'dev-12345.okta.com:443 allowed\n***' }));
  assert.deepEqual(await flow.runIndependentVerification({ profile: 'quick', jobId: 'job' }), { status: 'pass', profile: 'quick', basis: 'registered-runner', reason: null, detail: null, network, issues, log: path.join(dir, 'job', 'verification.log') });
  assert.equal(fs.readFileSync(path.join(dir, 'job', 'verification.log'), 'utf8'), 'dev-12345.okta.com:443 allowed\n***');
  fs.writeFileSync(path.join(dir, 'blocked'), 'not a directory');
  assert.deepEqual(await flow.runIndependentVerification({ profile: 'quick', jobId: 'blocked' }), { status: 'not_run', profile: 'quick', basis: 'egress-log-failed', reason: 'could not retain verification network log', detail: null, network, issues });
});

test('security: local keep_output validates and encoded credentials are redacted', () => {
  assert.deepEqual(validateVerificationNetwork({ ...policy, keep_output: true }), { ...policy, keep_output: true });
  assert.throws(() => validateVerificationNetwork({ ...policy, keep_output: 'true' }), /boolean/);
  const value = 'sensitive/+?é';
  const forms = [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'),
    Buffer.from(value).toString('hex'), Buffer.from(value).toString('hex').toUpperCase(),
    encodeURIComponent(value), [...Buffer.from(value)].map(b => '%' + b.toString(16).padStart(2, '0')).join('')];
  for (const form of forms) assert.equal(redactCredentials('start ' + form + ' end!', [value]), 'start *** end!');
});

test('security: authentication precedes resolution for HTTP and CONNECT', async t => {
  let resolved = 0;
  const logs = [];
  const port = await listening(t, createEgressProxy({ token, allow: ['example.com'], resolve: async () => { resolved++; return []; }, log: s => logs.push(s) }));
  for (const authorization of [null, 'Basic wrong', 'Basic ' + Buffer.from('nomarmy:wrong').toString('base64')]) {
    assert.deepEqual(await get(port, 'http://example.com/', authorization), { status: 407, body: '' });
    assert.equal(await tunnel(port, 'example.com:443', authorization), 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="verification"\r\nConnection: close\r\n\r\n');
  }
  assert.equal(resolved, 0);
  assert.deepEqual(logs, []);
});

test('security: embedded IPv4 IPv6 addresses are refused', () => {
  for (const value of ['2001:470:1:0:0:5efe:7f00:1', '2001:470:1:0:5efe:0:7f00:1',
    '2001:470:1:0:0:5efe:127.0.0.1', '::127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '64:ff9b:1::7f00:1']) {
    assert.equal(publicAddress(value), false, value);
  }
  assert.equal(publicAddress('2001:470:1::1'), true);
});

test('security: upstream refusal never counts as connected', async t => {
  const logs = [];
  const { PassThrough } = await import('node:stream');
  const port = await listening(t, createEgressProxy({ token, allow: ['example.com:80'], log: s => logs.push(s),
    resolve: async () => [{ address: '93.184.216.34' }],
    request: () => {
      const stream = new PassThrough();
      stream.setTimeout = () => {};
      process.nextTick(() => stream.emit('error', new Error('refused')));
      return stream;
    },
  }));
  assert.deepEqual(await get(port, 'http://example.com/'), { status: 502, body: '' });
  assert.deepEqual(logs, ['example.com:80 denied']);
});

test('security: credentialed output and artifacts stay in disposable worktree', async t => {
  const cwd = temporary(t), jobs = temporary(t);
  fs.writeFileSync(path.join(cwd, 'playwright.config.js'), '');
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'original');
  const value = 'credential/+?unique';
  const forms = [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'),
    Buffer.from(value).toString('hex'), encodeURIComponent(value)];
  for (const keep_output of [false, true]) {
    let copy;
    const executor = {
      probe: async () => ({ available: true }),
      startServices: async () => ({ network: 'test', cleanup: async () => {}, logs: async () => 'api.stripe.com:80 connected' }),
      run: async args => {
        copy = args.cwd;
        assert.notEqual(copy, cwd);
        assert.equal(fs.readFileSync(path.join(copy, 'tracked.txt'), 'utf8'), 'original');
        fs.writeFileSync(path.join(copy, 'tracked.txt'), value);
        fs.mkdirSync(path.join(copy, 'test-results'));
        for (let i = 0; i < forms.length; i++) fs.writeFileSync(path.join(copy, 'test-results', i + '.bin'), Buffer.concat([Buffer.from([0, 255]), Buffer.from(forms[i])]));
        fs.writeFileSync(path.join(copy, 'test-results', 'safe.txt'), 'safe');
        return { started: true, exitCode: 7, durationMs: 12, stdout: 'ordinary output! ' + forms.join(' ') + '!', stderr: keep_output ? forms.join(' ') + '!' : value.split('').join('\n') };
      },
    };
    const flow = createVerificationFlow({ ensureJobsRoot: () => jobs });
    flow.registerVerificationRunner(createVerificationRunner({ image: 'sandbox:1', loadConfig: () => ({ found: true, config }),
      loadVerificationNetwork: () => ({ ...policy, keep_output }), hostEnv: { NOMARMY_TEST_OKTA_SECRET: value }, executor }));
    const result = await flow.runIndependentVerification({ cwd, jobId: String(keep_output), profile: 'quick' });
    assert.deepEqual(Object.keys(result).sort(), ['artifacts', 'artifactsCapped', 'artifactsNote', 'basis', 'detail', 'issues', 'log', 'network', 'profile', 'reason', 'status']);
    assert.equal(result.status, 'fail');
    assert.deepEqual(result.network, { allowlist: policy.allow, reached: ['api.stripe.com:80'], credentials: ['OKTA_CLIENT_SECRET'] });
    // No evidence is kept under credentials: a scan can't catch every encoding.
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.artifactsCapped, false);
    assert.equal(result.artifactsNote, 'artifacts not kept: credentials or a proxy token were in use');
    assert.equal(fs.existsSync(path.join(jobs, String(keep_output), 'artifacts')), false, 'no evidence folder is written');
    assert.equal(fs.existsSync(copy), false);
    assert.equal(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), 'original');
    assert.equal(fs.existsSync(path.join(cwd, 'test-results')), false);
    const output = fs.readFileSync(result.log, 'utf8');
    for (const form of forms) assert.equal((output + result.detail).includes(form), false);
    assert.match(output, /api.stripe.com:80 connected/);
    assert.match(output, /exit 7, 12ms/);
    if (keep_output) {
      assert.match(output, /ordinary output! \*\*\*/);
      assert.match(result.detail, /last output: \*\*\*/);
    } else {
      assert.equal(output.includes('ordinary output!'), false);
      assert.match(output, /output withheld: credentials were in use/);
      assert.match(result.detail, /output withheld: credentials were in use/);
    }
  }
});

test('security: timeout removes labeled verification containers before networks', async t => {
  const cwd = temporary(t), calls = [];
  const executor = createPodmanExecutor({ collect: async (_file, args) => {
    calls.push(args);
    return { spawned: true, code: args.includes('/bin/sh') ? null : 0, timedOut: args.includes('/bin/sh'),
      stdout: args[0] === 'ps' ? 'abc123\ndef456\n' : '', stderr: '' };
  } });
  const result = await createVerificationRunner({ image: 'sandbox:1', loadConfig: () => ({ found: true, config }),
    loadVerificationNetwork: () => ({ allow: policy.allow, env: {} }), executor })({ cwd, jobId: 'timeout', profile: 'quick' });
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /timed out/);
  assert.deepEqual(calls.find(a => a[0] === 'ps'), ['ps', '-aq', '--filter', 'label=nomarmy.job=timeout']);
  assert.deepEqual(calls.find(a => a[0] === 'rm'), ['rm', '--force', 'abc123', 'def456']);
  assert.equal(calls.findIndex(a => a[0] === 'rm' && a.includes('abc123')) < calls.findIndex(a => a[0] === 'rm' && a.includes('nomarmy-timeout-egress')), true);
  assert.equal(calls.findIndex(a => a[0] === 'rm' && a.includes('abc123')) < calls.findIndex(a => a[0] === 'network' && a[1] === 'rm'), true);
});

test('security: regression reached hosts and log merge into parent evidence', async t => {
  const cwd = temporary(t), jobs = temporary(t);
  fs.writeFileSync(path.join(cwd, 'new.mjs'), 'worker');
  const first = { allowlist: policy.allow, reached: ['dev-12345.okta.com:443'], credentials: [] };
  const second = { ...first, reached: ['api.stripe.com:80'] };
  const flow = createVerificationFlow({ ensureJobsRoot: () => jobs, collectGitRecord: async () => ({}) });
  flow.registerVerificationRunner(async context => ({ status: context.jobId.endsWith('-regression-check') ? 'fail' : 'pass',
    network: context.jobId.endsWith('-regression-check') ? second : first, output: context.jobId.endsWith('-regression-check') ? 'api.stripe.com:80 connected' : 'dev-12345.okta.com:443 connected' }));
  const original = await flow.runIndependentVerification({ cwd, jobId: 'job', profile: 'quick' });
  const regression = await flow.runRegressionCheck({ cwd, jobId: 'job', productionFiles: ['new.mjs'], nameStatus: [{ status: 'A', path: 'new.mjs' }], profile: 'quick', verificationResult: original });
  assert.deepEqual(Object.keys(regression).sort(), ['basis', 'detail', 'issues', 'log', 'network', 'rawRerunStatus', 'reason', 'status']);
  assert.equal(regression.status, 'pass');
  assert.deepEqual(regression.network, second);
  assert.deepEqual(original.network.reached, ['dev-12345.okta.com:443', 'api.stripe.com:80']);
  assert.equal(fs.readFileSync(original.log, 'utf8'), 'dev-12345.okta.com:443 connected\n\n[regression check]\napi.stripe.com:80 connected');
  assert.equal(fs.readFileSync(path.join(cwd, 'new.mjs'), 'utf8'), 'worker');
});

test('security: an allowlist with no credentials still runs on a disposable copy and keeps no artifacts', async t => {
  const cwd = temporary(t), jobs = temporary(t);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'original');
  let ranIn, tokenSeen;
  const executor = {
    probe: async () => ({ available: true }),
    startServices: async () => ({ network: 'test', cleanup: async () => {}, logs: async () => 'api.stripe.com:80 connected' }),
    run: async args => {
      ranIn = args.cwd;
      // A command writes the proxy URL (with its token) into a file.
      tokenSeen = String(args.env?.HTTPS_PROXY ?? '');
      fs.writeFileSync(path.join(args.cwd, 'tracked.txt'), tokenSeen);
      fs.mkdirSync(path.join(args.cwd, 'test-results'), { recursive: true });
      fs.writeFileSync(path.join(args.cwd, 'test-results', 'trace.txt'), tokenSeen);
      return { started: true, exitCode: 0, durationMs: 5, stdout: 'ok', stderr: '' };
    },
  };
  const flow = createVerificationFlow({ ensureJobsRoot: () => jobs });
  flow.registerVerificationRunner(createVerificationRunner({ image: 'sandbox:1', loadConfig: () => ({ found: true, config }),
    loadVerificationNetwork: () => ({ allow: policy.allow, env: {} }), hostEnv: {}, executor }));
  const result = await flow.runIndependentVerification({ cwd, jobId: 'token-only', profile: 'quick' });
  assert.notEqual(ranIn, cwd, 'commands ran on a copy, not the worktree');
  assert.match(tokenSeen, /^http:\/\/nomarmy:[0-9a-f]{64}@egress:3128$/, 'the proxy token was issued');
  assert.equal(fs.readFileSync(path.join(cwd, 'tracked.txt'), 'utf8'), 'original', 'nothing reached the worktree');
  assert.deepEqual(result.artifacts, []);
  assert.equal(fs.existsSync(path.join(jobs, 'token-only', 'artifacts')), false);
});
