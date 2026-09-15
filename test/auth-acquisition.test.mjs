import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquirePasswordBrowserCookies } from '../src/auth-acquisition.mjs';
import { createCookieHttp } from '../src/cookie-http.mjs';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'zoom-auth-acquire-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function fakeConnection(states, calls = []) {
  return {
    calls,
    closed: false,
    async call(method, params, sessionId) {
      calls.push({ method, params: method === 'Runtime.callFunctionOn' ? { argumentCount: params.arguments.length } : params, sessionId });
      if (method === 'Target.createBrowserContext') return { browserContextId: 'isolated' };
      if (method === 'Target.createTarget') return { targetId: 'target' };
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method === 'Runtime.evaluate' && params.expression === 'document') return { result: { objectId: 'document' } };
      if (method === 'Runtime.evaluate') return { result: { value: states.shift() } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { submitted: true } } };
      if (method === 'Storage.getCookies') return { cookies: [
        { name: '_zm_ssid', value: randomBytes(18).toString('hex'), domain: '.zoom.us', path: '/', secure: true, httpOnly: true },
      ] };
      return {};
    },
    close() { this.closed = true; },
  };
}

function inputs() {
  return {
    username: Buffer.from(`sandbox-${randomBytes(6).toString('hex')}@example.test`),
    password: Buffer.from(randomBytes(24).toString('base64url')),
  };
}


test('password-browser acquisition isolates the login, writes mode 0600 metadata-only cookies, and wipes inputs', async t => {
  const root = await directory(t), out = join(root, 'cookies.json'), supplied = inputs(), calls = [];
  const connection = fakeConnection([
    { url: 'https://zoom.us/signin#/login', hasUsername: true, hasPassword: true, challenge: null },
    { url: 'https://zoom.us/profile', hasUsername: false, hasPassword: false, challenge: null },
  ], calls);
  const result = await acquirePasswordBrowserCookies({
    method: 'password-browser', outputCookieFile: out, usernameFd: 3, passwordFd: 4, timeoutMs: 10000,
  }, {
    connect: async () => connection,
    readDescriptor: async (_fd, label) => label === 'username' ? supplied.username : supplied.password,
    sleep: async () => {},
  });
  assert.deepEqual(result, { acquired: true, method: 'password-browser', outputCookieFile: out, cookieCount: 1, mode: '0600', credentialsPersisted: false });
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(out, 'utf8'))[0].name, '_zm_ssid');
  assert.equal(Buffer.from(supplied.username).every(byte => byte === 0), true);
  assert.equal(Buffer.from(supplied.password).every(byte => byte === 0), true);
  assert.equal(connection.closed, true);
  assert.ok(calls.some(call => call.method === 'Target.createBrowserContext'));
  assert.ok(calls.some(call => call.method === 'Target.disposeBrowserContext'));
  assert.doesNotMatch(JSON.stringify(result), /example\.test/);

  const http = await createCookieHttp(out);
  t.after(() => http.close());
  assert.match(await http.cookieHeader('https://zoom.us/'), /^_zm_ssid=/);
});

test('password-browser acquisition supports the staged account then password form', async t => {
  const root = await directory(t), out = join(root, 'cookies.json'), supplied = inputs(), calls = [];
  const connection = fakeConnection([
    { url: 'https://zoom.us/signin#/login', hasUsername: true, hasPassword: false, challenge: null },
    { url: 'https://zoom.us/signin#/login', hasUsername: false, hasPassword: true, challenge: null },
    { url: 'https://zoom.us/profile', hasUsername: false, hasPassword: false, challenge: null },
  ], calls);
  const result = await acquirePasswordBrowserCookies({
    method: 'password-browser', outputCookieFile: out, usernameFd: 3, passwordFd: 4, timeoutMs: 10000,
  }, {
    connect: async () => connection,
    readDescriptor: async (_fd, label) => label === 'username' ? supplied.username : supplied.password,
    sleep: async () => { throw new Error('unexpected authentication poll'); },
  });
  assert.equal(result.acquired, true);
  assert.deepEqual(calls.filter(call => call.method === 'Runtime.callFunctionOn').map(call => call.params.argumentCount), [1, 1]);
  assert.equal(supplied.username.every(byte => byte === 0), true);
  assert.equal(supplied.password.every(byte => byte === 0), true);
});

test('password-browser acquisition skips the optional sign-in phone prompt', async t => {
  const root = await directory(t), out = join(root, 'cookies.json'), supplied = inputs(), calls = [];
  const connection = fakeConnection([
    { url: 'https://zoom.us/signin#/login', hasUsername: true, hasPassword: false, canSkipPhone: false, challenge: null },
    { url: 'https://zoom.us/signin#/login', hasUsername: false, hasPassword: true, canSkipPhone: false, challenge: null },
    { url: 'https://zoom.us/signin?noRedirect=true#/login/bind-signin-phone', hasUsername: false, hasPassword: false, canSkipPhone: true, challenge: null },
    { url: 'https://zoom.us/profile', hasUsername: false, hasPassword: false, canSkipPhone: false, challenge: null },
  ], calls);
  const result = await acquirePasswordBrowserCookies({
    method: 'password-browser', outputCookieFile: out, usernameFd: 3, passwordFd: 4, timeoutMs: 10000,
  }, {
    connect: async () => connection,
    readDescriptor: async (_fd, label) => label === 'username' ? supplied.username : supplied.password,
    sleep: async () => { throw new Error('unexpected authentication poll'); },
  });
  assert.equal(result.acquired, true);
  assert.deepEqual(calls.filter(call => call.method === 'Runtime.callFunctionOn').map(call => call.params.argumentCount), [1, 1, 0]);
});

test('MFA, CAPTCHA, and SSO return typed handoffs without cookie output or retained credentials', async t => {
  const root = await directory(t);
  for (const [challenge, code] of [
    ['mfa', 'AUTH_INTERACTION_REQUIRED'],
    ['captcha', 'AUTH_INTERACTION_REQUIRED'],
    ['sso', 'AUTH_METHOD_UNSUPPORTED'],
  ]) {
    const out = join(root, `${challenge}.json`), supplied = inputs();
    const connection = fakeConnection([
      { url: challenge === 'sso' ? 'https://zoom.us/sso/' : 'https://zoom.us/signin#/login', hasUsername: false, hasPassword: false, challenge },
    ]);
    await assert.rejects(acquirePasswordBrowserCookies({
      method: 'password-browser', outputCookieFile: out, usernameFd: 3, passwordFd: 4, timeoutMs: 10000,
    }, {
      connect: async () => connection,
      readDescriptor: async (_fd, label) => label === 'username' ? supplied.username : supplied.password,
      sleep: async () => {},
    }), error => error.code === code && error.details.phase === challenge
      && error.details.outcome === 'not_acquired' && error.details.fallback === 'explicit-auth-export');
    await assert.rejects(stat(out), { code: 'ENOENT' });
    assert.equal(supplied.username.every(byte => byte === 0), true);
    assert.equal(supplied.password.every(byte => byte === 0), true);
    assert.equal(connection.closed, true);
  }
});

test('regular files are rejected as credential descriptors before browser access', async t => {
  const root = await directory(t), source = join(root, 'credential-input'), out = join(root, 'cookies.json');
  await writeFile(source, randomBytes(24));
  const handle = await import('node:fs/promises').then(fs => fs.open(source, 'r'));
  t.after(() => handle.close());
  let connected = false;
  await assert.rejects(acquirePasswordBrowserCookies({
    method: 'password-browser', outputCookieFile: out, usernameFd: handle.fd, passwordFd: handle.fd + 1, timeoutMs: 10000,
  }, { connect: async () => { connected = true; } }), { code: 'UNSAFE_CREDENTIAL_SOURCE' });
  assert.equal(connected, false);
  await assert.rejects(stat(out), { code: 'ENOENT' });
});

test('an existing output is refused before reading or submitting credentials', async t => {
  const root = await directory(t), out = join(root, 'cookies.json');
  await writeFile(out, 'preserve');
  let reads = 0, connected = false;
  await assert.rejects(acquirePasswordBrowserCookies({
    method: 'password-browser', outputCookieFile: out, usernameFd: 3, passwordFd: 4, timeoutMs: 10000,
  }, {
    readDescriptor: async () => { reads++; return randomBytes(16); },
    connect: async () => { connected = true; },
  }), { code: 'COOKIE_EXPORT_ERROR' });
  assert.equal(reads, 0);
  assert.equal(connected, false);
  assert.equal(await readFile(out, 'utf8'), 'preserve');
});
