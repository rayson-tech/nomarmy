// Verification-only egress boundary. Built-ins only; safe to mount in the base image.
import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

export function target(value, defaultPort = 443) {
  if (typeof value !== 'string' || value.length > 260) throw new Error('invalid target');
  const match = /^([a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value);
  if (!match) throw new Error('invalid target');
  const host = match[1].toLowerCase(), port = Number(match[2] ?? defaultPort);
  const labels = host.split('.');
  if (net.isIP(host) || labels.length < 2 || labels.some(l => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) ||
      !/^[a-z]{2,63}$/.test(labels.at(-1)) ||
      /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|private|corp|lan|home|test|invalid|onion|arpa)$/.test(host) ||
      port < 1 || port > 65535) throw new Error('invalid target');
  return { host, port, authority: `${host}:${port}` };
}

// Conservative globally routable unicast only. Reject IPv6 transition/mapped
// forms too: they can encode IPv4 private destinations or depend on a relay.
export function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || address === "168.63.129.16" ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(address) !== 6) return false;
  // 2000::/3, excluding special-purpose 2001::/23 and 2002::/16.
  const parts = address.toLowerCase().split(':');
  const first = parseInt(parts[0], 16), second = parseInt(parts[1] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
    !(first === 0x3fff && second <= 0xfff);
}

export function createEgressProxy({ allow, resolve = host => lookup(host, { all: true }), log = () => {}, connect = opts => net.connect(opts), request = opts => http.request(opts) }) {
  const allowed = new Set(allow.map(v => target(v).authority));
  async function authorize(value, port) {
    let parsed;
    try {
      parsed = target(value, port);
      if (!allowed.has(parsed.authority)) throw new Error('unlisted');
      const addresses = await resolve(parsed.host);
      if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('private address');
      log(`${parsed.authority} allowed`);
      return { ...parsed, address: addresses[0].address };
    } catch {
      // Never echo malformed input (it may contain a URL password or payload).
      log(`${parsed?.authority ?? 'invalid:0'} denied`);
      throw new Error('denied');
    }
  }
  const server = http.createServer(async (req, res) => {
    let destination, url, checking = false;
    try {
      url = new URL(req.url);
      if (url.protocol !== 'http:' || url.username || url.password || url.hash) throw new Error('invalid');
      checking = true;
      destination = await authorize(url.host, 80);
    } catch { if (!checking) log("invalid:0 denied"); res.writeHead(403); res.end(); return; }
    const headers = { ...req.headers, host: destination.authority };
    for (const name of String(req.headers.connection ?? '').split(',').map(s => s.trim().toLowerCase())) delete headers[name];
    for (const name of ['proxy-authorization', 'proxy-authenticate', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer']) delete headers[name];
    headers.host = destination.authority;
    const upstream = request({ hostname: destination.address, port: destination.port, method: req.method, path: url.pathname + url.search, headers, agent: false });
    upstream.on('response', reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.setTimeout(30_000, () => upstream.destroy());
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    let destination;
    try { destination = await authorize(req.url, 443); }
    catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    if (client.destroyed) return;
    const upstream = connect({ host: destination.address, port: destination.port });
    upstream.setTimeout(30_000, () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createEgressProxy({ allow: JSON.parse(process.env.NOMARMY_EGRESS_ALLOW), log: line => process.stdout.write(`${line}\n`) }).listen(3128, '0.0.0.0');
}
