import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCookieHttp } from '../src/cookie-http.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zoom-cookie-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'cookies.json');
  await writeFile(path, JSON.stringify([
    { name: 'cred', value: 'apex-only', domain: 'zoom.us', path: '/', secure: true },
    { name: 'session', value: 'shared', domain: '.zoom.us', path: '/', secure: true },
    { name: 'scoped', value: 'attachment-only', domain: '.zoom.us', path: '/api/attachment', secure: true },
    { name: '_zm_docs_nak', value: 'cached-service-credential', domain: '.zoom.us', path: '/' },
    { name: 'partitioned', value: 'not-widened', domain: '.zoom.us', path: '/', partitionKey: { topLevelSite: 'https://zoom.us' } },
    { name: 'expired', value: 'stale', domain: '.zoom.us', path: '/', expires: 1 },
  ]));
  const http = await createCookieHttp(path);
  t.after(() => http.close());
  return { http, path };
}

test('exported host-only and path cookies do not widen or reuse cached service credentials', async t => {
  const { http } = await fixture(t);
  assert.equal(await http.cookieHeader('https://zoom.us/'), 'cred=apex-only; session=shared');
  assert.equal(await http.cookieHeader('https://docs.zoom.us/api/user/me'), 'session=shared');
  assert.equal(await http.cookieHeader('https://docs.zoom.us/api/attachment/file'), 'scoped=attachment-only; session=shared');
  assert.equal(await http.cookieHeader('https://docs.zoom.us/api/attachment-other'), 'session=shared');
  await assert.rejects(http.cookieHeader('https://zoom.us.attacker.invalid/'), { code: 'INVALID_ARGUMENT' });
});

test('redirected writes and provider challenges are never replayed', async t => {
  const { http } = await fixture(t);
  let attempts = 0;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { attempts++; return new Response('', { status: 307, headers: { location: 'https://docs.zoom.us/other' } }); };
  await assert.rejects(http.request('https://docs.zoom.us/api/write', { method: 'POST', body: '{}', redirect: 'follow' }), { code: 'UNEXPECTED_REDIRECT' });
  assert.equal(attempts, 1);
  globalThis.fetch = async () => { attempts++; return new Response('', { status: 403, headers: { 'cf-mitigated': 'challenge' } }); };
  await assert.rejects(http.request('https://docs.zoom.us/api/user/me'), { code: 'PROVIDER_APPROVAL_REQUIRED' });
  assert.equal(attempts, 2);
});

test('Set-Cookie renewals and deletion stay in memory while the export remains immutable', async t => {
  const { http, path } = await fixture(t);
  const original = await readFile(path, 'utf8');
  let remove = false;
  t.mock.method(globalThis, 'fetch', async () => new Response('', { headers: {
    'set-cookie': `session=${remove ? '' : 'renewed'}; Domain=.zoom.us; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${remove ? 0 : 3600}`,
  } }));

  await http.request('https://ai.zoom.us/api/read');
  assert.equal(await http.cookieHeader('https://docs.zoom.us/'), 'session=renewed');
  assert.equal(await readFile(path, 'utf8'), original);

  remove = true;
  await http.request('https://ai.zoom.us/api/read');
  assert.equal(await http.cookieHeader('https://docs.zoom.us/'), '');
  assert.equal(await readFile(path, 'utf8'), original);

  const reopened = await createCookieHttp(path);
  t.after(() => reopened.close());
  assert.equal(await reopened.cookieHeader('https://docs.zoom.us/'), 'session=shared');
});

test('independent clients load the immutable export without sharing in-memory credentials', async t => {
  const { path } = await fixture(t);
  const first = await createCookieHttp(path);
  const second = await createCookieHttp(path);
  t.after(() => Promise.all([first.close(), second.close()]));
  const original = await readFile(path, 'utf8');

  t.mock.method(globalThis, 'fetch', async () => new Response('', {
    headers: { 'set-cookie': 'session=first-only; Domain=.zoom.us; Path=/; Secure' },
  }));
  await first.request('https://ai.zoom.us/api/read');
  assert.equal(await first.cookieHeader('https://docs.zoom.us/'), 'session=first-only');
  assert.equal(await second.cookieHeader('https://docs.zoom.us/'), 'session=shared');
  assert.equal(await readFile(path, 'utf8'), original);
});
