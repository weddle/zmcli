import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('symlinked TUI executable validates arguments instead of silently exiting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zoompi-entry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'zoompi');
  await symlink(fileURLToPath(new URL('../src/zoommate-tui.mjs', import.meta.url)), executable);
  const result = spawnSync(process.execPath, [executable, '--unknown-option'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^INVALID_INPUT:/);
});

test('invalid local inputs fail before an unavailable browser is contacted', () => {
  const cases = [
    ['docs', 'read', '--id', 'INVALID!'],
    ['chat', 'send', '--channel', 'synthetic', '--text', 'invalid\u0001XML'],
    ['docs', 'recent', '--cursor', 'invalid\ncursor'],
    ['chat', 'thread', '--channel', 'synthetic', '--thread', '100', '--before', '99'],
    ['docs', 'append', '--id', 'synthetic', '--block', 'INVALID!', '--text', 'test'],
    ['docs', 'append', '--id', 'synthetic', '--if-version', '9007199254740992', '--text', 'test'],
    ['chat', 'message', '--link', 'https://example.com/launch/chat/v2/AAAA'],
    ['chat', 'message', '--link', `https://zoom.us/launch/chat/v2/${Buffer.from(JSON.stringify({
      sid: 'synthetic@conference.xmpp.zoom.us', sid2: 'another-user', mid: 'synthetic-message', time: 1,
    })).toString('base64')}`],
    ['chat', 'search', '--query', 'synthetic', '--limit', '100'],
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [cli, '--cdp', 'http://127.0.0.1:1', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
  }
});

test('unknown commands return relevant auth-free alternatives', () => {
  const failed = spawnSync(process.execPath, [cli, 'docs', 'unknown'], { encoding: 'utf8' });
  assert.equal(failed.status, 2, failed.stderr);
  const error = JSON.parse(failed.stderr).error;
  assert.equal(error.code, 'INVALID_INPUT');
  assert.ok(error.details.validCommands.includes('docs read'));
  assert.ok(error.details.validCommands.every(command => command.startsWith('docs ')));
});

test('Chat evidence options validate before authentication', () => {
  const help = spawnSync(process.execPath, [cli, 'chat', 'activity', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(JSON.parse(help.stdout).data.help, /chat activity --channel ID --since TIME/);
  const groupHelp = spawnSync(process.execPath, [cli, 'chat', '--help'], { encoding: 'utf8' });
  assert.equal(groupHelp.status, 0, groupHelp.stderr);
  const groupText = JSON.parse(groupHelp.stdout).data.help;
  assert.match(groupText, /Ordinary history, activity, counts, recent indexes, search, notification centers, folders, starred items, and browser-local state are not interchangeable unread sources/);
  assert.match(groupText, /Browser fallback is never automatic and requires explicit approval because opening content can change read state/);

  for (const args of [
    ['chat', 'activity', '--channel', 'synthetic'],
    ['chat', 'dm-read', '--name', 'Exact Name'],
    ['chat', 'mentions', '--state', 'all', '--mention-scope', 'guessed'],
    ['chat', 'list', '--identity-limit', '2'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
  }

  for (const args of [
    ['chat', 'activity', '--channel', 'synthetic', '--since', '2020-01-01T00:00:00Z', '--recover-older-roots'],
    ['chat', 'activity', '--channel', 'synthetic', '--since', '2020-01-01T00:00:00Z', '--older-root-since', '2019-12-01T00:00:00Z'],
    ['chat', 'activity', '--channel', 'synthetic', '--since', '2020-01-01T00:00:00Z', '--overlap-ms', '1000'],
    ['chat', 'activity', '--channel', 'synthetic', '--since', '2020-01-01T00:00:00Z', '--older-root-pages', '11', '--recover-older-roots', '--older-root-since', '2019-12-01T00:00:00Z'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
  }

  const validRecovery = spawnSync(process.execPath, [cli, 'chat', 'activity', '--channel', 'synthetic',
    '--since', '2020-01-01T00:00:00Z', '--recover-older-roots', '--older-root-since', '2019-12-01T00:00:00Z',
    '--older-root-pages', '0', '--older-root-requests', '1', '--older-root-threads', '1',
    '--older-root-checkpoint-limit', '1', '--older-root-checkpoint-bytes', '1024',
    '--overlap-rescans', '1', '--overlap-ms', '1000'], { encoding: 'utf8' });
  assert.equal(validRecovery.status, 3, validRecovery.stderr);
  assert.equal(JSON.parse(validRecovery.stderr).error.code, 'COOKIE_REQUIRED');
});

test('Docs evidence commands validate and describe capabilities without authentication', () => {
  const capabilities = spawnSync(process.execPath, [cli, 'docs', 'capabilities'], { encoding: 'utf8' });
  assert.equal(capabilities.status, 0, capabilities.stderr);
  const data = JSON.parse(capabilities.stdout).data;
  assert.equal(data.browserFallback.automatic, false);
  assert.equal(data.capabilities.unread.source, 'native-notification-read-boolean');
  assert.equal(data.capabilities.folders.scope, 'immediate-parent-children');
  assert.equal(data.browserFallback.requiresApproval, true);
  assert.equal(data.browserFallback.readStateRisk, true);
  assert.equal(data.browserFallback.relay.implemented, false);
  assert.equal(data.capabilities.renderer.status, 'outside-repository');
  assert.equal(data.capabilities.identityDatabase.status, 'unsupported');

  const help = spawnSync(process.execPath, [cli, 'docs', 'notifications', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(JSON.parse(help.stdout).data.help, /docs notifications/);

  for (const args of [
    ['docs', 'notifications', '--state', 'guessed'],
    ['docs', 'notifications', '--since', 'today'],
    ['docs', 'modified'],
    ['docs', 'identities', '--ids', 'INVALID!'],
    ['docs', 'permissions-batch', '--ids', 'synthetic', '--concurrency', '5'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
  }
});

test('unsupported browser relay host fails with an explicit safe outcome', () => {
  const result = spawnSync(process.execPath, [
    cli, 'auth', 'export', '--cdp', 'http://profile.relay.localhost:9222', '--out', '/tmp/unused-cookie-export.json',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.code, 'RELAY_COOKIE_EXPORT_UNSUPPORTED');
  assert.equal(error.details.operation, 'auth.export');
  assert.equal(error.details.phase, 'relay-cookie-acquisition');
  assert.equal(error.details.outcome, 'not_sent');
});

test('ZoomMate validates target exclusivity and UTF-8 byte bounds before authentication', () => {
  const boundary = Buffer.from('é'.repeat(131072));
  for (const [extra, input] of [
    [['--id', 'existing'], Buffer.from('Do not send this ambiguous prompt.')],
    [[], Buffer.from([0xc3, 0x28])],
    [[], Buffer.concat([boundary, Buffer.from('a')])],
  ]) {
    const result = spawnSync(process.execPath, [cli, 'zoommate', 'query', '--new', '--prompt-file', '-', ...extra],
      { input, encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
  }
  const valid = spawnSync(process.execPath, [cli, 'zoommate', 'query', '--new', '--prompt-file', '-'],
    { input: boundary, encoding: 'utf8' });
  assert.equal(valid.status, 3, valid.stderr);
  assert.equal(JSON.parse(valid.stderr).error.code, 'COOKIE_REQUIRED');
});

test('password acquisition rejects missing or ambiguous credential input', () => {
  for (const args of [
    ['auth', 'acquire', '--password'],
    ['auth', 'acquire', '--method', 'password-browser', '--output-cookie-file', '/tmp/unused'],
    ['auth', 'acquire', '--method', 'automatic', '--output-cookie-file', '/tmp/unused', '--username-fd', '3', '--password-fd', '4'],
    ['auth', 'acquire', '--method', 'password-browser', '--output-cookie-file', '/tmp/unused', '--username-fd', '3', '--password-fd', '3'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT');
  }
});
