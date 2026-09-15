import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket, { WebSocketServer } from 'ws';
import { createCookieHttp } from '../src/cookie-http.mjs';
import { openZoomMateTransport } from '../src/zoommate-transport.mjs';

const response = (payload, status = 200) => Response.json(payload, { status });
const mintUrl = 'https://zoom.us/nws/common/2.0/nak?pms=AICW%2CUser%3ABase&src=aicw';
const jwt = (exp = Math.floor(Date.now() / 1000) + 3600, marker = 'nak') => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'ES256', typ: 'JWT' })}.${encode({ exp, marker })}.signature`;
};
const login = (nak, userId = 'user', accountId = 'account') => response({ success: true, data: {
  nak, user_profile: { user_id: userId, account_id: accountId, user_name: 'Actor' },
  api_root: 'ai.zoom.us/ai-computer', synora_cluster: 'us01', permissions: [],
} });
const mint = (nak, status = 200) => status === 200 ? new Response(nak, { status }) : response({}, status);
const isMint = url => url === mintUrl;

function authHttp({ tokens = [jwt()], loginUsers, onRequest } = {}) {
  let mintIndex = 0, loginIndex = 0;
  return {
    async request(url, options = {}) {
      if (isMint(url)) return mint(tokens[Math.min(mintIndex++, tokens.length - 1)]);
      if (url.includes('/login/')) {
        const token = tokens[Math.min(loginIndex++, tokens.length - 1)];
        const user = loginUsers?.[Math.min(loginIndex - 1, loginUsers.length - 1)];
        return login(token, user?.[0] ?? 'user', user?.[1] ?? 'account');
      }
      return onRequest?.(url, options) ?? response({ data: {} });
    },
    get mintCount() { return mintIndex; },
    get loginCount() { return loginIndex; },
  };
}

test('HTTP 200 unsuccessful login is not an empty authenticated session', async () => {
  const nak = jwt();
  const http = { request: async url => isMint(url) ? mint(nak) : response({ success: false, status_code: 30010201, error: 'User not logged in' }) };
  await assert.rejects(openZoomMateTransport({ http }), { code: 'REAUTHENTICATION_REQUIRED' });
});

test('browser-cookie scoped mint enables bearer bootstrap and authenticated product reads', async () => {
  const nak = jwt();
  const bootstrapUrl = 'https://ai.zoom.us/ai-computer/api/v1/login/?continue=https%3A%2F%2Fzoommate.zoom.us%2F';
  const http = { async request(url, options = {}) {
    const headers = new Headers(options.headers);
    if (url === mintUrl && (options.method ?? 'GET') === 'GET' && headers.get('X-Requested-With') === 'XMLHttpRequest') return mint(nak);
    if (url === bootstrapUrl && headers.get('authorization') === `Bearer ${nak}`) return login(nak);
    if (url === 'https://ai.zoom.us/ai-computer/api/v1/skills' && headers.get('authorization') === `Bearer ${nak}`) {
      return response({ data: { items: [{ id: 'native-skill' }] } });
    }
    throw new Error('Request did not follow the observed browser-cookie authentication contract.');
  } };
  const transport = await openZoomMateTransport({ http });
  try {
    assert.equal(transport.identity.user.userId, 'user');
    assert.deepEqual(await transport.request('/api/v1/skills'), { items: [{ id: 'native-skill' }] });
  } finally { transport.close(); }
});
 
test('mint rejects malformed and expired JWTs, and bootstrap token mismatch', async () => {
  for (const [nak, code] of [['not-a-jwt', 'AUTH_RESPONSE_ERROR'], [jwt(Math.floor(Date.now() / 1000) - 1), 'REAUTHENTICATION_REQUIRED']]) {
    const http = { request: async url => isMint(url) ? mint(nak) : login(nak) };
    await assert.rejects(openZoomMateTransport({ http }), { code });
  }
  const minted = jwt(undefined, 'minted'), bootstrap = jwt(undefined, 'unexpected-bootstrap');
  const http = { request: async url => isMint(url) ? mint(minted) : login(bootstrap) };
  await assert.rejects(openZoomMateTransport({ http }), { code: 'AUTH_RESPONSE_ERROR' });
});

test('concurrent expiry refreshes share one mint and preserve authenticated reads', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });
  const tokens = [jwt(2000000001), jwt(2000003600)];
  const http = authHttp({ tokens, onRequest: async () => response({ data: { ok: true } }) });
  const transport = await openZoomMateTransport({ http }); t.after(() => transport.close());
  const [first, second] = await Promise.all([transport.request('/api/v1/skills'), transport.request('/api/v1/skills')]);
  assert.deepEqual(first, { ok: true }); assert.deepEqual(second, { ok: true }); assert.equal(http.mintCount, 2);
});

test('auth refresh is actor-bound and write rejection is never replayed', async () => {
  const tokens = [jwt(), jwt(), jwt()];
  let writes = 0;
  const http = authHttp({ tokens, loginUsers: [['user', 'account'], ['other', 'account']], onRequest: async (_url, options) => {
    if (options.method === 'POST') writes++;
    return response({ success: false, status_code: 30010201 });
  } });
  const transport = await openZoomMateTransport({ http });
  try {
    await assert.rejects(transport.request('/api/v1/session/list', { method: 'POST', body: {} }), { code: 'AUTH_REQUIRED' });
    assert.equal(writes, 1);
    assert.equal(http.mintCount, 1);
    await assert.rejects(transport.request('/api/v1/skills'), { code: 'TENANT_MISMATCH' });
  } finally { transport.close(); }
});

test('credentials are never exposed or sent to an arbitrary absolute URL', async () => {
  const nak = jwt(); let authenticatedRequests = 0;
  const http = authHttp({ tokens: [nak], onRequest: async () => { authenticatedRequests++; return response({ data: {} }); } });
  const transport = await openZoomMateTransport({ http });
  try {
    await assert.rejects(transport.request('https://other.zoom.us/api/v1/private'), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(transport.request('/api/../../outside'), { code: 'INVALID_ARGUMENT' });
    assert.equal(authenticatedRequests, 0);
    assert.equal(JSON.stringify(transport.bootstrap).includes(nak), false);
  } finally { transport.close(); }
});

test('native HTTP200 denial and real HTTP errors are never decoded as successful data', async () => {
  let rejection = response({ status_code: 403, data: {} });
  const http = authHttp({ onRequest: async () => rejection });
  const transport = await openZoomMateTransport({ http });
  try {
    await assert.rejects(transport.request('/api/v1/skills'), { code: 'FORBIDDEN' });
    rejection = response({ success: true, data: { success: false, status_code: 403, result: [], has_more: false } });
    await assert.rejects(transport.request('/api/v1/resource-panel/items/page', { method: 'POST', body: {} }), { code: 'FORBIDDEN' });
    rejection = response({ data: {} }, 500);
    await assert.rejects(transport.request('/api/v1/skills'), { code: 'HTTP_ERROR' });
  } finally { transport.close(); }
});

test('real socket disconnect after a sent mutation reports unknown and never resends', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  t.after(() => new Promise(resolve => { for (const client of server.clients) client.terminate(); server.close(resolve); }));
  let runCount = 0, connections = 0;
  server.on('connection', socket => { connections++; socket.on('message', raw => {
    const frame = JSON.parse(raw);
    if (frame.method === 'session.start') socket.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { connection_id: 'connection', capabilities: ['agent.run'] } }));
    if (frame.method === 'agent.run') { runCount++; socket.terminate(); }
  }); });
  const http = authHttp({ onRequest: async () => response({ data: { ticket: 'one-use' } }) });
  const transport = await openZoomMateTransport({ http, webSocket: () => new WebSocket(`ws://127.0.0.1:${server.address().port}`) });
  t.after(() => transport.close());
  await Promise.all([transport.connect(), transport.connect()]);
  await assert.rejects(transport.send('agent.run', { request_id: 'run' }), error => error.code === 'WRITE_UNCONFIRMED' && error.details.outcome === 'unknown');
  assert.equal(runCount, 1); assert.equal(connections, 1);
});
test('fresh clients remint from an unchanged read-only SSO export after short-lived credentials expire', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zoommate-frozen-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'cookies.json');
  let now = Date.now(), nak, mints = 0;
  t.mock.method(Date, 'now', () => now);
  const source = JSON.stringify([
    { name: 'cred', value: 'durable', domain: 'zoom.us', path: '/', secure: true, httpOnly: true },
    { name: '_zm_ssid', value: 'short-lived', domain: '.zoom.us', path: '/', secure: true, httpOnly: true, expires: now / 1000 + 60 },
  ]);
  await writeFile(path, source, { mode: 0o400 });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.href === mintUrl) {
      assert.match(options.headers.get('cookie'), /cred=durable/u);
      if (mints) assert.doesNotMatch(options.headers.get('cookie'), /_zm_ssid/u);
      nak = jwt(Math.floor(now / 1000) + 3600, `mint-${++mints}`);
      const result = mint(nak);
      result.headers.append('set-cookie', `_zm_ssid=memory-only; Domain=.zoom.us; Path=/; Secure; Expires=${new Date(now + 3600000).toUTCString()}`);
      return result;
    }
    assert.equal(url.hostname, 'ai.zoom.us');
    assert.equal(options.headers.get('authorization'), `Bearer ${nak}`);
    assert.match(options.headers.get('cookie'), /_zm_ssid=memory-only/u);
    assert.doesNotMatch(options.headers.get('cookie'), /cred=/u);
    return login(nak);
  });
  const firstHttp = await createCookieHttp(path);
  const first = await openZoomMateTransport({ http: firstHttp });
  first.close(); await firstHttp.close();
  now += 2 * 3600000;
  const nextHttp = await createCookieHttp(path);
  t.after(() => nextHttp.close());
  const next = await openZoomMateTransport({ http: nextHttp });
  t.after(() => next.close());
  assert.equal(next.identity.user.userId, 'user');
  assert.equal(mints, 2);
  assert.equal((await stat(path)).mode & 0o777, 0o400);
  assert.equal(await readFile(path, 'utf8'), source);
});

test('idle sessions refresh at token expiry minus 60 seconds and closed timers do not refresh', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const tokens = [jwt(2000003600), jwt(2000007140), jwt(2000010680)];
  const http = authHttp({ tokens, loginUsers: [['user', 'account'], ['user', 'account'], ['other', 'account']], onRequest: async () => response({ data: {} }) });
  const transport = await openZoomMateTransport({ http }); t.after(() => transport.close());
  t.mock.timers.tick(58 * 60000); await new Promise(resolve => setImmediate(resolve)); assert.equal(http.mintCount, 1);
  t.mock.timers.tick(60000); await new Promise(resolve => setImmediate(resolve)); assert.equal(http.mintCount, 2);
  t.mock.timers.tick(59 * 60000); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(transport.request('/api/v1/session/list', { method: 'POST', body: {} }), { code: 'TENANT_MISMATCH' });
  const count = http.mintCount; transport.close(); t.mock.timers.tick(120 * 60000); assert.equal(http.mintCount, count);
});

test('a refresh returning the same rejected credential does not replay the read', async t => {
  const nak = jwt(); let reads = 0;
  const http = authHttp({ tokens: [nak, nak], onRequest: async () => { reads++; return response({ success: false, status_code: 401 }); } });
  const transport = await openZoomMateTransport({ http }); t.after(() => transport.close());
  await assert.rejects(transport.request('/api/v1/skills'), { code: 'AUTH_REQUIRED' }); assert.equal(reads, 1);
});

function flakyMintHttp(initialSeconds = 3600) {
  return {
    failures: 0, loginFailures: 0, offline: false, mints: 0, writes: 0, nak: undefined,
    async request(url, options = {}) {
      if (isMint(url)) {
        this.mints++;
        if (this.rateLimited) return Response.json({}, { status: 429, headers: { 'retry-after': '120' } });
        if (this.offline || this.failures > 0) {
          this.failures = Math.max(0, this.failures - 1);
          throw new Error('Network unavailable');
        }
        this.nak = jwt(Math.floor(Date.now() / 1000) + (this.mints === 1 ? initialSeconds : 3600), String(this.mints));
        return mint(this.nak);
      }
      if (url.includes('/login/')) {
        if (this.loginFailures > 0) {
          this.loginFailures--;
          return new Response('Temporarily unavailable', { status: 503 });
        }
        return login(this.nak);
      }
      assert.equal(options.headers.authorization, `Bearer ${this.nak}`);
      if (options.method === 'POST') this.writes++;
      return response({ data: { authenticated: true } });
    },
  };
}

test('wake-time renewal tolerates two transient failures without disconnecting a healthy session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const http = flakyMintHttp();
  const transport = await openZoomMateTransport({ http });
  t.after(() => transport.close());
  const events = [];
  transport.subscribe(event => events.push(event));
  http.failures = 2;
  t.mock.timers.tick(59 * 60000); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1250); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(2250); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await transport.request('/api/v1/skills'), { authenticated: true });
  assert.equal(http.mints, 4);
  assert.deepEqual(events, []);
});

test('exhausted offline renewal is bounded and a later operation recovers before sending one write', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const http = flakyMintHttp();
  const transport = await openZoomMateTransport({ http });
  t.after(() => transport.close());
  http.offline = true;
  t.mock.timers.tick(59 * 60000); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1250); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(2250); await new Promise(resolve => setImmediate(resolve));
  assert.equal(http.mints, 4);
  t.mock.timers.tick(60000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(http.mints, 4);
  http.offline = false;
  assert.deepEqual(await transport.request('/api/v1/session/list', { method: 'POST', body: {} }), { authenticated: true });
  assert.equal(http.mints, 5);
  assert.equal(http.writes, 1);
});

test('cancelling cookie-backed recovery does not poison subsequent operations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const http = flakyMintHttp(1);
  const transport = await openZoomMateTransport({ http });
  t.after(() => transport.close());
  http.failures = 1;
  const controller = new AbortController();
  const pending = transport.request('/api/v1/skills', { signal: controller.signal })
    .then(result => ({ result }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const { error } = await pending;
  assert.equal(error.code, 'REQUEST_CANCELLED');
  assert.equal(error.details.outcome, 'not_sent');
  assert.deepEqual(await transport.request('/api/v1/skills'), { authenticated: true });
  assert.equal(http.mints, 3);
});

test('cookie mint respects a provider delay beyond the recovery budget instead of retrying early', async () => {
  let attempts = 0;
  const http = { async request() {
    attempts++;
    return Response.json({}, { status: 429, headers: { 'retry-after': '120' } });
  } };
  await assert.rejects(openZoomMateTransport({ http }), error => error.code === 'RATE_LIMITED'
    && error.details.retryDeferred === true && error.details.retryAfterMs === 120000);
  assert.equal(attempts, 1);
});

test('non-JSON bootstrap outages recover instead of becoming permanent malformed-response failures', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const http = flakyMintHttp();
  http.loginFailures = 2;
  const opening = openZoomMateTransport({ http }).then(transport => ({ transport }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1250); await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(2250); await new Promise(resolve => setImmediate(resolve));
  const { transport, error } = await opening;
  assert.ifError(error);
  t.after(() => transport.close());
  assert.deepEqual(await transport.request('/api/v1/skills'), { authenticated: true });
  assert.equal(http.mints, 3);
});

test('deferred renewal can recover after Retry-After without retrying on intervening operations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2000000000000 });
  const http = flakyMintHttp();
  const transport = await openZoomMateTransport({ http });
  t.after(() => transport.close());
  http.rateLimited = true;
  t.mock.timers.tick(59 * 60000); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(transport.request('/api/v1/skills'), { code: 'RATE_LIMITED' });
  http.rateLimited = false;
  t.mock.timers.tick(119999);
  await assert.rejects(transport.request('/api/v1/skills'), { code: 'RATE_LIMITED' });
  assert.equal(http.mints, 2);
  t.mock.timers.tick(1);
  assert.deepEqual(await transport.request('/api/v1/skills'), { authenticated: true });
  assert.equal(http.mints, 3);
});

test('native Docs access stays actor-bound and never replays a rejected write', async t => {
  const nak = jwt(); let writes = 0;
  const http = authHttp({ tokens: [nak], onRequest: async (url, options) => {
    if (url.endsWith('/api/user/me')) return response({ user: { userId: 'user', accountId: 'account' }, homeClusterApiPrefix: 'https://us01docs.zoom.us' });
    if (url === 'https://us01docs.zoom.us/api/block/transactions?fileId=doc') {
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${nak}`);
      writes++; return response({ message: 'Unauthorized' }, 401);
    }
    if (url.endsWith('/api/v1/skills')) return response({ data: { items: [] } });
    assert.fail(`Unexpected credential destination: ${url}`);
  } });
  const transport = await openZoomMateTransport({ http }); t.after(() => transport.close());
  const docs = await transport.openDocs();
  await assert.rejects(docs.request('/api/block/transactions?fileId=doc', { method: 'POST', body: {} }), { code: 'AUTH_REQUIRED' });
  assert.equal(writes, 1);
  assert.equal(http.mintCount, 1);
  await assert.rejects(docs.request('/api/private', { base: 'https://untrusted.invalid' }), { code: 'INVALID_ARGUMENT' });
  docs.close();
  await assert.rejects(docs.request('/api/user/me'), { code: 'SESSION_CLOSED' });
  assert.deepEqual(await transport.request('/api/v1/skills'), { items: [] });
});

test('Docs identity mismatch prevents document access through the ZoomMate credential', async t => {
  const http = authHttp({ onRequest: async url => {
    assert.equal(url, 'https://docs.zoom.us/api/user/me');
    return response({ user: { userId: 'another-user', accountId: 'account' }, homeClusterApiPrefix: 'https://docs.zoom.us' });
  } });
  const transport = await openZoomMateTransport({ http }); t.after(() => transport.close());
  await assert.rejects(transport.openDocs(), { code: 'TENANT_MISMATCH' });
});
