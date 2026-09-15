import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, chmod, symlink, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProfile, runProfileCommand, importProfileCookies, persistProfileCookies } from '../src/profiles.mjs';

const cookies = value => JSON.stringify([{ name: '_zm_ssid', value, domain: '.zoom.us', path: '/', secure: true, httpOnly: true }]);
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zmcli-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { 'config-dir': join(dir, 'home') };
  return { dir, options };
}

test('default profile lives at the root and named profiles isolate settings and storage', async t => {
  const { options } = await fixture(t);
  const before = await runProfileCommand('show', options);
  assert.equal(before.initialized, false);
  await assert.rejects(stat(options['config-dir']), { code: 'ENOENT' });
  const base = await runProfileCommand('init', { ...options, cdp: 'http://127.0.0.1:9227' });
  const work = await runProfileCommand('init', { ...options, profile: 'work' });
  assert.equal(base.directory, options['config-dir']);
  assert.equal(work.directory, join(base.directory, 'profiles', 'work'));
  assert.equal(base.effectiveCdp, 'http://127.0.0.1:9227');
  assert.equal(work.effectiveCdp, 'http://127.0.0.1:9222');
  assert.notEqual(base.cacheDir, work.cacheDir);
  assert.notEqual(base.agentDir, work.agentDir);
  for (const profile of [base, work]) {
    for (const path of [profile.directory, profile.cacheDir, profile.agentDir]) assert.equal((await stat(path)).mode & 0o777, 0o700);
    assert.equal((await stat(profile.configFile)).mode & 0o777, 0o600);
  }
  await runProfileCommand('set', { ...options, profile: 'work', cdp: 'http://localhost:9444' });
  assert.equal((await resolveProfile(options)).cdp, 'http://127.0.0.1:9227');
  const overridden = await resolveProfile({ ...options, profile: 'work', cookies: join(base.directory, 'explicit.json'), cdp: 'http://127.0.0.1:9555' });
  assert.equal(overridden.cookies, join(base.directory, 'explicit.json'));
  assert.equal(overridden.cdp, 'http://127.0.0.1:9555');
  assert.equal(overridden.config.cdp, 'http://localhost:9444');
  assert.deepEqual((await runProfileCommand('list', options)).profiles.map(item => item.name), ['default', 'work']);
});

test('missing or invalid named profiles never fall back to default credentials', async t => {
  const { options } = await fixture(t);
  await runProfileCommand('init', options);
  await assert.rejects(resolveProfile({ ...options, profile: 'unknown' }), { code: 'PROFILE_NOT_FOUND' });
  for (const profile of ['../default', '/tmp/other', '.', 'work/name', '']) {
    await assert.rejects(resolveProfile({ ...options, profile }), { code: 'INVALID_INPUT' });
  }
  await assert.rejects(runProfileCommand('set', { ...options, cdp: 'http://user:secret@127.0.0.1:9222' }), { code: 'INVALID_INPUT' });
  await assert.rejects(runProfileCommand('set', { ...options, cdp: 'https://example.com' }), { code: 'INVALID_INPUT' });
});

test('explicit cookie import survives a fresh browser-independent process', async t => {
  const { dir, options } = await fixture(t), source = join(dir, 'input.json');
  await writeFile(source, cookies('synthetic-session'), { mode: 0o600 });
  const profile = await resolveProfile(options, { create: true });
  const imported = await importProfileCookies(profile, source);
  assert.equal(imported.cookieFile, join(options['config-dir'], 'cookies.json'));
  assert.equal((await stat(imported.cookieFile)).mode & 0o777, 0o600);
  assert.equal(await readFile(source, 'utf8'), cookies('synthetic-session'));
  const script = `
    import assert from 'node:assert/strict';
    import { resolveProfile } from ${JSON.stringify(new URL('../src/profiles.mjs', import.meta.url).href)};
    import { createCookieHttp } from ${JSON.stringify(new URL('../src/cookie-http.mjs', import.meta.url).href)};
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.headers.get('cookie'), '_zm_ssid=synthetic-session');
      return new Response('{}');
    };
    const profile = await resolveProfile();
    const http = await createCookieHttp(profile.cookies);
    await http.request('https://docs.zoom.us/api/test');
    await http.close();
    console.log(JSON.stringify({profile: profile.name, browserIndependent: true}));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ZMCLI_HOME: options['config-dir'] }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { profile: 'default', browserIndependent: true });
});

test('managed cookie replacement is explicit and failed acquisition retains existing cookies', async t => {
  const { options } = await fixture(t), profile = await resolveProfile(options, { create: true });
  const producer = value => path => writeFile(path, cookies(value), { mode: 0o600, flag: 'wx' });
  await persistProfileCookies(profile, producer('original'));
  let contacted = false;
  await assert.rejects(persistProfileCookies(profile, async () => { contacted = true; }), { code: 'PROFILE_FILE_EXISTS' });
  assert.equal(contacted, false);
  await assert.rejects(persistProfileCookies(profile, async path => {
    await writeFile(path, 'not cookies');
    throw new Error('acquisition cancelled');
  }, { replace: true }), /acquisition cancelled/);
  await assert.rejects(persistProfileCookies(profile, path => writeFile(path, '{}'), { replace: true }), { code: 'COOKIE_FILE_ERROR' });
  assert.equal(await readFile(profile.cookieFile, 'utf8'), cookies('original'));
  await persistProfileCookies(profile, producer('replacement'), { replace: true });
  assert.equal(await readFile(profile.cookieFile, 'utf8'), cookies('replacement'));
  assert.equal((await stat(profile.cookieFile)).mode & 0o777, 0o600);
  assert.equal((await readdir(profile.dir)).some(name => name.startsWith('.auth-')), false);
});

test('concurrent first-time cookie installs cannot overwrite each other', async t => {
  const { options } = await fixture(t), profile = await resolveProfile(options, { create: true });
  const results = await Promise.allSettled(['one', 'two'].map(value => persistProfileCookies(profile,
    path => writeFile(path, cookies(value), { flag: 'wx', mode: 0o600 }))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'PROFILE_FILE_EXISTS');
  assert.ok([cookies('one'), cookies('two')].includes(await readFile(profile.cookieFile, 'utf8')));
});

test('unsafe profile storage is rejected without changing permissions or symlink targets', async t => {
  const { dir, options } = await fixture(t);
  const profile = await resolveProfile(options, { create: true });
  const outside = join(dir, 'outside.json');
  await writeFile(outside, cookies('outside'), { mode: 0o600 });
  await symlink(outside, profile.cookieFile);
  await assert.rejects(resolveProfile(options), { code: 'PROFILE_SECURITY_ERROR' });
  await assert.rejects(persistProfileCookies(profile, () => assert.fail('No acquisition allowed'), { replace: true }), { code: 'PROFILE_SECURITY_ERROR' });
  assert.equal(await readFile(outside, 'utf8'), cookies('outside'));
  await chmod(profile.dir, 0o755);
  await assert.rejects(resolveProfile(options), { code: 'PROFILE_SECURITY_ERROR' });
  assert.equal((await stat(profile.dir)).mode & 0o777, 0o755);
});
