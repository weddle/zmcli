import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AppError, connectSession, recoverSafeRead, retryAfterMs } from '../src/session.mjs';
import { openChatTransport } from '../src/chat-transport.mjs';
import { validateZakExpiryEvidence } from '../src/zak-expiry-evidence.mjs';

const jwt = suffix => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.${suffix}`;
const identity = { user: { userId: 'actor', accountId: 'account' }, account: { accountId: 'account' }, homeClusterApiPrefix: 'https://us01docs.zoom.us' };

async function cookieFile() {
  const directory = await mkdtemp(join(tmpdir(), 'zoom-recovery-'));
  const path = join(directory, 'cookies.json');
  await writeFile(path, JSON.stringify([{ name: 'session', value: 'initial', domain: '.zoom.us', path: '/', secure: true }]));
  return path;
}

async function withFetch(handler, action) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await action(); }
  finally { globalThis.fetch = original; }
}

function response(body, init = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), init);
}

test('Retry-After seconds and dates preserve the provider delay and ignore malformed values', () => {
  assert.equal(retryAfterMs('2', 0), 2000);
  assert.equal(retryAfterMs('20', 0), 20000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:03 GMT', 1000), 2000);
  assert.equal(retryAfterMs('not-a-delay', 0), null);
});

test('safe reads honor bounded rate-limit delays and retry state is per invocation', async () => {

  const delays = [];
  let attempts = 0;
  const result = await recoverSafeRead(async () => {
    attempts++;
    if (attempts < 3) throw new AppError('RATE_LIMITED', 'limited', { retryAfterMs: attempts * 100 });
    return 'ok';
  }, { sleep: async delay => delays.push(delay) });
  assert.equal(result, 'ok');
  assert.deepEqual(delays, [100, 200]);
  await assert.rejects(recoverSafeRead(async () => { throw new AppError('RATE_LIMITED', 'limited'); }, { sleep: async () => {} }),
    error => error.code === 'RATE_LIMITED' && error.details.attempts === 3 && error.details.retryExhausted === true && error.details.partial === false);
  assert.equal(await recoverSafeRead(async () => 'fresh'), 'fresh');
});

test('safe reads defer a Retry-After beyond the wait budget without retrying early', async () => {
  let attempts = 0, sleeps = 0;
  await assert.rejects(recoverSafeRead(async () => {
    attempts++;
    throw new AppError('RATE_LIMITED', 'limited', { retryAfterMs: 60000 });
  }, { maxWaitMs: 30000, sleep: async () => { sleeps++; } }), error =>
    error.code === 'RATE_LIMITED' && error.details.retryDeferred === true
      && error.details.attempts === 1 && error.details.maxWaitMs === 30000);
  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
});

test('safe read transport failures use bounded backoff without poisoning later calls', async () => {
  const delays = [];
  let attempts = 0;
  const result = await recoverSafeRead(async () => {
    if (++attempts === 1) throw new AppError('REQUEST_FAILED', 'timed out');
    return 'recovered';
  }, { sleep: async delay => delays.push(delay), random: () => 0 });
  assert.equal(result, 'recovered');
  assert.deepEqual(delays, [1000]);
  assert.equal(await recoverSafeRead(async () => 'independent'), 'independent');
});
test('cancelled safe reads stop before any request attempt', async () => {
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;
  await assert.rejects(recoverSafeRead(async () => { attempts++; }, { signal: controller.signal }), {
    code: 'REQUEST_CANCELLED',
  });
  assert.equal(attempts, 0);
});

test('cancellation interrupts a pending retry wait before replay', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const pending = recoverSafeRead(async () => {
    attempts++;
    throw new AppError('REQUEST_FAILED', 'timed out');
  }, { signal: controller.signal, random: () => 0 });
  queueMicrotask(() => controller.abort());
  await assert.rejects(pending, { code: 'REQUEST_CANCELLED' });
  assert.equal(attempts, 1);
});

test('credential expiry remints once, then returns explicit reauthentication when still rejected', async () => {
  let attempts = 0, remints = 0;
  assert.equal(await recoverSafeRead(async () => {
    if (++attempts === 1) throw new AppError('CHAT_CREDENTIAL_EXPIRED', 'expired');
    return 'recovered';
  }, { remint: async () => { remints++; } }), 'recovered');
  assert.equal(remints, 1);
  await assert.rejects(recoverSafeRead(async () => { throw new AppError('CHAT_CREDENTIAL_EXPIRED', 'expired'); },
    { remint: async () => {} }), error => error.code === 'REAUTHENTICATION_REQUIRED' && error.details.partial === false);
});

test('Docs safe POST retries 429 with renewed cookies while an ambiguous POST is never replayed', async () => {
  const path = await cookieFile();
  let targetCalls = 0;
  await withFetch(async (url, options) => {
    if (String(url).includes('/nws/common/2.0/nak')) return response(jwt('one'));
    if (String(url).endsWith('/api/user/me')) return response(identity);
    if (++targetCalls === 1) return response({}, { status: 429, headers: { 'Retry-After': '0', 'Set-Cookie': 'renewed=yes; Domain=.zoom.us; Path=/; Secure' } });
    assert.match(options.headers.get('cookie'), /(?:^|; )renewed=yes(?:;|$)/);
    return response({ value: 'recovered' });
  }, async () => {
    const session = await connectSession({ cookies: path });
    try {
      assert.deepEqual(await session.request('/api/read-query', { method: 'POST', safeRead: true, body: {} }), { value: 'recovered' });
    } finally { await session.close(); }
  });
  assert.equal(targetCalls, 2);

  targetCalls = 0;
  await withFetch(async url => {
    if (String(url).includes('/nws/common/2.0/nak')) return response(jwt('two'));
    if (String(url).endsWith('/api/user/me')) return response(identity);
    targetCalls++;
    return response({}, { status: 429, headers: { 'Retry-After': '0' } });
  }, async () => {
    const session = await connectSession({ cookies: path });
    try { await assert.rejects(session.request('/api/write', { method: 'POST', body: {} }), { code: 'RATE_LIMITED' }); }
    finally { await session.close(); }
  });
  assert.equal(targetCalls, 1);
});

test('Docs safe read remints after auth rejection and does not return empty success', async () => {
  const path = await cookieFile();
  let mints = 0, reads = 0;
  await withFetch(async (url, options) => {
    if (String(url).includes('/nws/common/2.0/nak')) return response(jwt(`mint${++mints}`));
    if (String(url).endsWith('/api/user/me')) return response(identity);
    reads++;
    if (reads === 1) return response({}, { status: 401 });
    assert.match(options.headers.get('authorization'), /mint2$/);
    return response({ items: ['real'] });
  }, async () => {
    const session = await connectSession({ cookies: path });
    try { assert.deepEqual(await session.request('/api/read'), { items: ['real'] }); }
    finally { await session.close(); }
  });
  assert.equal(mints, 2);
  assert.equal(reads, 2);
});

function chatConfig() {
  return { uid: 'actor', accountId: 'account', jid: 'actor@xmpp.zoom.us', searchInChatEnabled: true,
    channelLocalStorageTime: '-1;', p2pMucLocalStorageTime: '-1;', selfChatStorageTimeResult: '-1;',
    domainList: { channelSessionDomain: '@conference.xmpp.zoom.us', microServiceDomain: 'xms.zoom.us',
      bffCFServerDomain: 'bff.zoom.us', ucsDomain: 'ucs.zoom.us', asyncImDomain: 'async.zoom.us',
      fileServerDomain: 'file.zoom.us', xmppWsDomain: 'xmpp.zoom.us',
      chatCdnPath: 'https://st1.zoom.us/fe-static/nx-chat/7.0.5.19571.0828' } };
}

const chatToken = suffix => ({ jid: 'actor@xmpp.zoom.us', zak: `zak-${suffix}`, xmppToken: `xmpp-${suffix}`,
  resourceId: `resource-${suffix}`, deviceId: `device-${suffix}` });

async function capturedChatRequest(path, options, result = { result: 0 }) {
  let captured;
  const http = { close: async () => {}, request: async (url, requestOptions) => {
    if (url.includes('/newchat/token')) return response({ status: true, result: chatToken('header') });
    if (url.endsWith('/chat/config')) return response({ status: true, result: chatConfig() });
    captured = { url, options: requestOptions };
    return response(result);
  } };
  const chat = await openChatTransport({ http });
  try { await chat.request(path, options); }
  finally { await chat.dispose(); }
  return captured;
}

test('zak-only message search labels its encoded JSON body', async () => {
  const request = await capturedChatRequest('/nws/asyncim/1.0/api/search/message', { body: { keyword: 'fixture' } });
  assert.equal(request.options.headers.zak, 'zak-header');
  assert.equal(request.options.headers.authorization, undefined);
  assert.equal(request.options.headers['content-type'], 'application/json');
  assert.equal(request.options.body, JSON.stringify({ keyword: 'fixture' }));
});

test('GET requests remain bodyless without a JSON content type', async () => {
  const request = await capturedChatRequest('/xms/emoji/listWithDisplayname', { method: 'GET', body: { ignored: true } });
  assert.equal(request.options.body, undefined);
  assert.equal(request.options.headers['content-type'], undefined);
});

test('bodyless non-GET requests remain bodyless without a JSON content type', async () => {
  const request = await capturedChatRequest('/xms/login/recent/list', { method: 'POST' });
  assert.equal(request.options.body, undefined);
  assert.equal(request.options.headers['content-type'], undefined);
});

test('zak-only contact search labels its encoded JSON body', async () => {
  const request = await capturedChatRequest('/nws/asyncim/1.0/api/search/contact', { body: { key: 'fixture' } },
    { status: true, result: [] });
  assert.equal(request.options.headers.zak, 'zak-header');
  assert.equal(request.options.headers.authorization, undefined);
  assert.equal(request.options.headers['content-type'], 'application/json');
  assert.equal(request.options.body, JSON.stringify({ key: 'fixture' }));
});

test('Chat 490 remints once for a safe service read and persistent 490 requires reauthentication', async () => {
  let tokenMints = 0, configReads = 0, reads = 0;
  const http = { close: async () => {}, request: async (url, options) => {
    if (url.includes('/newchat/token')) return response({ status: true, result: chatToken(++tokenMints) });
    if (url.endsWith('/chat/config')) { configReads++; return response({ status: true, result: chatConfig() }); }
    if (url.includes('/api/v1/ucs/contact/vcard/batch')) {
      return response({ result: 0, vcardUsers: [{ jid: 'actor@xmpp.zoom.us', userId: 'actor' }] });
    }
    reads++;
    if (reads === 1) return response({}, { status: 490 });
    assert.equal(options.headers.authorization, 'Bearer zak-2');
    return response({ result: 0, data: { recovered: true } });
  } };
  const chat = await openChatTransport({ http });
  try { assert.deepEqual(await chat.request('/xms/login/recent/list', { body: {} }), { result: 0, data: { recovered: true } }); }
  finally { await chat.dispose(); }
  assert.equal(tokenMints, 2);
  assert.equal(reads, 2);
  assert.equal(configReads, 2);

  tokenMints = 0; configReads = 0; reads = 0;
  const rejected = { close: async () => {}, request: async url => {
    if (url.includes('/newchat/token')) return response({ status: true, result: chatToken(++tokenMints) });
    if (url.endsWith('/chat/config')) { configReads++; return response({ status: true, result: chatConfig() }); }
    if (url.includes('/api/v1/ucs/contact/vcard/batch')) {
      return response({ result: 0, vcardUsers: [{ jid: 'actor@xmpp.zoom.us', userId: 'actor' }] });
    }
    reads++;
    return response({}, { status: 490 });
  } };
  const expired = await openChatTransport({ http: rejected });
  try { await assert.rejects(expired.request('/xms/login/recent/list', { body: {} }),
    error => error.code === 'REAUTHENTICATION_REQUIRED' && error.details.partial === false); }
  finally { await expired.dispose(); }
  assert.equal(tokenMints, 2);
  assert.equal(reads, 2);
  assert.equal(configReads, 2);
});

test('Chat 490 remint refuses a changed actor or account before replay', async () => {
  let tokenMints = 0, configReads = 0, serviceReads = 0, profileReads = 0;
  const http = { close: async () => {}, request: async url => {
    if (url.includes('/newchat/token')) return response({ status: true, result: chatToken(++tokenMints) });
    if (url.endsWith('/chat/config')) {
      const result = chatConfig();
      if (++configReads === 2) result.accountId = 'different-account';
      return response({ status: true, result });
    }
    if (url.includes('/api/v1/ucs/contact/vcard/batch')) {
      profileReads++;
      return response({ result: 0, vcardUsers: [{ jid: 'actor@xmpp.zoom.us', userId: 'actor' }] });
    }
    serviceReads++;
    return response({}, { status: 490 });
  } };
  const chat = await openChatTransport({ http });
  try {
    await assert.rejects(chat.request('/xms/login/recent/list', { body: {} }),
      error => error.code === 'REAUTHENTICATION_REQUIRED' && error.details.partial === false);
  } finally { await chat.dispose(); }
  assert.equal(tokenMints, 2);
  assert.equal(configReads, 2);
  assert.equal(serviceReads, 1);
  assert.equal(profileReads, 0);
});

test('Chat 490 remint refuses a native profile identity mismatch before replay', async () => {
  let tokenMints = 0, serviceReads = 0;
  const http = { close: async () => {}, request: async url => {
    if (url.includes('/newchat/token')) return response({ status: true, result: chatToken(++tokenMints) });
    if (url.endsWith('/chat/config')) return response({ status: true, result: chatConfig() });
    if (url.includes('/api/v1/ucs/contact/vcard/batch')) {
      return response({ result: 0, vcardUsers: [{ jid: 'actor@xmpp.zoom.us', userId: 'different-actor' }] });
    }
    serviceReads++;
    return response({}, { status: 490 });
  } };
  const chat = await openChatTransport({ http });
  try {
    await assert.rejects(chat.request('/xms/login/recent/list', { body: {} }),
      error => error.code === 'REAUTHENTICATION_REQUIRED' && error.details.partial === false);
  } finally { await chat.dispose(); }
  assert.equal(tokenMints, 2);
  assert.equal(serviceReads, 1);
});

test('a pre-auth socket disconnect is retried only for the safe unread index', async () => {
  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances = 0;
    constructor() {
      this.instance = ++FakeSocket.instances;
      this.readyState = FakeSocket.CONNECTING;
      this.listeners = new Map();
      queueMicrotask(() => { this.readyState = FakeSocket.OPEN; this.emit('open', {}); });
    }
    addEventListener(name, listener) {
      const values = this.listeners.get(name) ?? [];
      values.push(listener); this.listeners.set(name, values);
    }
    once(name, listener) {
      const wrapper = value => { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== wrapper)); listener(value); };
      this.addEventListener(name, wrapper);
    }
    emit(name, value) { for (const listener of [...(this.listeners.get(name) ?? [])]) listener(value); }
    send(value) {
      if (value.startsWith('<open')) {
        queueMicrotask(() => this.emit('message', { data: '<features xmlns=\"urn:ietf:params:xml:ns:xmpp-framing\"/>' }));
      } else if (value.includes('jabber:iq:auth')) {
        if (this.instance === 1) { queueMicrotask(() => this.close()); return; }
        const id = value.match(/ id=\"([^\"]+)\"/)?.[1];
        queueMicrotask(() => {
          this.emit('message', { data: `<iq id=\"${id}\" type=\"result\"/>` });
          this.emit('message', { data: '<iq from=\"actor@xmpp.zoom.us/resource-1\" to=\"actor@xmpp.zoom.us/resource-1\" type=\"result\"><zoom xmlns=\"zoom:iq:ext\" type=\"offline\" version=\"1\"><conference jid=\"conference.xmpp.zoom.us\"/></zoom></iq>' });
        });
      }
    }
    close() {
      if (this.readyState === FakeSocket.CLOSED) return;
      this.readyState = FakeSocket.CLOSED; this.emit('close', {});
    }
    terminate() { this.close(); }
  }
  let tokenMints = 0;
  const http = { close: async () => {}, request: async url => {
    if (url.includes('/newchat/token')) return response({ status: true, result: chatToken(++tokenMints) });
    if (url.endsWith('/chat/config')) return response({ status: true, result: chatConfig() });
    throw new Error('Unexpected HTTP request');
  } };
  const chat = await openChatTransport({ http, WebSocketClass: FakeSocket, recovery: { sleep: async () => {} } });
  try { assert.equal(await chat.unreadResource(), 'resource-1'); }
  finally { await chat.dispose(); }
  assert.equal(FakeSocket.instances, 2);
  assert.equal(tokenMints, 1);
});

test('CLI returns JSON exit 3 when bounded Docs remint cannot restore authentication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zoom-cli-recovery-'));
  const cookies = join(directory, 'cookies.json'), preload = join(directory, 'fake-fetch.mjs');
  await writeFile(cookies, JSON.stringify([{ name: 'session', value: 'initial', domain: '.zoom.us', path: '/', secure: true }]));
  await writeFile(preload, `
const token = '${jwt('fake')}';
globalThis.fetch = async url => {
  if (String(url).includes('/nws/common/2.0/nak')) return new Response(token);
  if (String(url).endsWith('/api/user/me')) return Response.json(${JSON.stringify(identity)});
  return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
};
`);
  const result = spawnSync(process.execPath, ['--import', preload, 'src/cli.mjs', '--cookies', cookies, 'docs', 'read', '--id', 'synthetic-doc'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.equal(result.status, 3);
  assert.equal(result.stdout, '');
  const output = JSON.parse(result.stderr);
  assert.equal(output.ok, false);
  assert.equal(output.error.code, 'REAUTHENTICATION_REQUIRED');
  assert.equal(output.error.details.partial, false);
});

test('sanitized natural-expiry evidence requires ordered bounded recovery without login or mutation', () => {
  const evidence = {
    version: 1,
    service: 'chat',
    scenario: 'natural_zak_expiry_490_remint_resume',
    outcome: 'verified_recovery',
    startedAt: '2026-09-08T00:00:00.000Z',
    initialZakIssuedAt: '2026-09-08T00:00:01.000Z',
    initialZakExpiresAt: '2026-09-08T01:00:00.000Z',
    boundedPostExpiryDeadline: '2026-09-08T01:30:00.000Z',
    first490At: '2026-09-08T01:01:00.000Z',
    remintAt: '2026-09-08T01:01:01.000Z',
    rotatedCredentialAt: '2026-09-08T01:01:02.000Z',
    identityInvariantVerifiedAt: '2026-09-08T01:01:03.000Z',
    replayAt: '2026-09-08T01:01:04.000Z',
    resumedReadAt: '2026-09-08T01:01:05.000Z',
    stoppedAt: '2026-09-08T01:01:06.000Z',
    interactiveLoginDuringObservation: false,
    syntheticExpiry: false,
    mutationsEnabled: false,
  };
  assert.equal(validateZakExpiryEvidence(evidence).accepted, true);
  assert.throws(() => validateZakExpiryEvidence({ ...evidence, syntheticExpiry: true }), { code: 'INVALID_ZAK_EXPIRY_EVIDENCE' });
  assert.throws(() => validateZakExpiryEvidence({ ...evidence, replayAt: '2026-09-08T01:00:59.000Z' }), { code: 'INVALID_ZAK_EXPIRY_EVIDENCE' });
  assert.throws(() => validateZakExpiryEvidence({ ...evidence, first490At: '2026-09-08T01:31:00.000Z' }), { code: 'INVALID_ZAK_EXPIRY_EVIDENCE' });
});
