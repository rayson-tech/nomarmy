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
function get(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: proxyPort, path: url }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body }));
    }); req.on('error', reject);
  });
}

test('HTTP egress pins public DNS, denies private and unlisted targets, logs no payload', async t => {
  const seen = [];
  const upstreamPort = await listening(t, http.createServer((req, res) => { seen.push({ host: req.headers.host, url: req.url }); res.end('ok'); }));
  const logs = [], resolved = [], destinations = [];
  let address = '93.184.216.34';
  const proxy = createEgressProxy({ allow: ['example.com:80'], log: l => logs.push(l),
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
  assert.deepEqual(logs, ['example.com:80 allowed', 'evil.com:80 denied', ...Array(12).fill('example.com:80 denied'), 'invalid:0 denied']);
  assert.deepEqual(resolved, Array(13).fill('example.com'));
  assert.equal(destinations.length, 1);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const ip of ['0.0.0.0', '224.0.0.1', '198.18.0.1', '2001:db8::1', '2001::1', '64:ff9b::7f00:1']) assert.equal(publicAddress(ip), false, ip);
});

function tunnel(port, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.once('data', data => { socket.destroy(); resolve(data.toString()); });
  });
}
test('CONNECT egress enforces exact ports and rejects mixed private DNS answers', async t => {
  const upstream = net.createServer(s => { s.on('error', () => {}); });
  const upstreamPort = await listening(t, upstream);
  const logs = [], destinations = [];
  let addresses = [{ address: '93.184.216.34' }];
  const proxyPort = await listening(t, createEgressProxy({ allow: ['example.com'], log: l => logs.push(l), resolve: async () => addresses,
    connect: opts => { destinations.push(opts); return net.connect(upstreamPort, '127.0.0.1'); },
  }));
  assert.equal(await tunnel(proxyPort, 'example.com'), 'HTTP/1.1 200 Connection Established\r\n\r\n');
  for (const authority of ['evil.com:443', 'example.com:80', '127.0.0.1:443', '[::1]:443']) assert.equal(await tunnel(proxyPort, authority), 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  addresses = [{ address: '93.184.216.34' }, { address: '10.0.0.1' }];
  assert.equal(await tunnel(proxyPort, 'example.com:443'), 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  assert.deepEqual(destinations, [{ host: '93.184.216.34', port: 443 }]);
  assert.deepEqual(logs, ['example.com:443 allowed', 'evil.com:443 denied', 'example.com:80 denied', 'invalid:0 denied', 'invalid:0 denied', 'example.com:443 denied']);
});

test('verification egress isolates credentials, networks, redaction and cleanup', async t => {
  const cwd = temporary(t), calls = [];
  const collect = async (_file, args) => {
    calls.push(args);
    return { spawned: true, code: 0, stdout: args[0] === 'logs' ? 'dev-12345.okta.com:443 allowed\nunsafe payload\n' : args.includes('/bin/sh') ? `result ${secret}` : '', stderr: args.includes('/bin/sh') ? secret : '' };
  };
  const runner = createVerificationRunner({ image: 'sandbox:1', hostProjectDir: cwd,
    loadVerificationNetwork: () => policy, hostEnv: { NOMARMY_TEST_OKTA_SECRET: secret },
    loadConfig: () => ({ found: true, config: { ...config, harnesses: ['mock-oidc'] } }),
    executor: createPodmanExecutor({ collect }),
  });
  const result = await runner({ cwd, profile: 'quick', jobId: 'egress-test' });
  assert.deepEqual(Object.keys(result).sort(), ['basis', 'detail', 'issues', 'network', 'output', 'reason', 'status']);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.network, { allowlist: policy.allow, credentials: ['OKTA_CLIENT_SECRET'] });
  assert.deepEqual(result.issues, ['verification had network access to dev-12345.okta.com:443, api.stripe.com:80']);
  assert.equal(result.output, 'dev-12345.okta.com:443 allowed\n\n$ check  (exit 0)\nresult ***\n[stderr]\n***');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(calls.find(a => a[0] === 'stop'), ['stop', '--time', '2', 'nomarmy-egress-test-egress']);
  assert.equal(calls.findIndex(a => a[0] === 'stop') < calls.findIndex(a => a[0] === 'logs'), true);
  const verify = calls.find(a => a.includes('/bin/sh'));
  assert.equal(verify.includes('--network=nomarmy-egress-test'), true);
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) assert.equal(verify.includes(`${name}=http://egress:3128`), true);
  assert.equal(verify.includes('NO_PROXY=mock-oidc'), true);
  assert.equal(verify.includes('no_proxy=mock-oidc'), true);
  assert.equal(verify.includes(`OKTA_CLIENT_SECRET=${secret}`), true);
  assert.deepEqual(calls.filter(a => a.join(' ').includes(secret)), [verify]);
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
  assert.deepEqual(missing, { status: 'not_run', basis: 'missing-credential', reason: 'missing host environment variable NOMARMY_TEST_OKTA_SECRET', detail: null, network: { allowlist: policy.allow, credentials: ['OKTA_CLIENT_SECRET'] } });
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
