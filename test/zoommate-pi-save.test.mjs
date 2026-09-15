import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { markdownDestination } from '../src/zoommate-pi-artifacts.mjs';

const artifact = { kind: 'file', id: 'f1', title: 'Report.md' };

test('Save Markdown prompts for and confirms an absolute destination without rewriting it', async () => {
  const calls = [];
  const ctx = { cwd: '/tmp/zoommate-save-ui', ui: {
    input: async prompt => { calls.push(['input', prompt]); return '/var/tmp/chosen.md'; },
    confirm: async (prompt, detail) => { calls.push(['confirm', prompt, detail]); return true; },
  } };
  const destination = await markdownDestination(ctx, artifact);
  assert.deepEqual(destination, { out: '/var/tmp/chosen.md' });
  assert.equal(calls[0][0], 'input');
  assert.equal(calls[1][0], 'confirm');
  assert.match(calls[1][2], /\/var\/tmp\/chosen\.md/);
  assert.match(calls[1][2], /mode 0600/);
  assert.match(calls[1][2], /Existing files and symlinks will not be replaced/);
});

test('Save Markdown resolves a relative destination and performs no write when confirmation is cancelled', async () => {
  let confirmed = false;
  const ctx = { cwd: '/tmp/zoommate-save-ui', ui: {
    input: async () => 'nested/chosen.md',
    confirm: async () => { confirmed = true; return false; },
  } };
  assert.equal(await markdownDestination(ctx, artifact), null);
  assert.equal(confirmed, true);
  assert.equal(resolve(ctx.cwd, 'nested/chosen.md'), '/tmp/zoommate-save-ui/nested/chosen.md');
});
test('Save Markdown keeps an explicitly selected existing destination instead of choosing a collision copy', async () => {
  const ctx = { cwd: '/tmp/zoommate-save-ui', ui: {
    input: async () => '/tmp/zoommate-save-ui/existing.md',
    confirm: async (_prompt, detail) => { assert.match(detail, /Existing files and symlinks will not be replaced/); return true; },
  } };
  assert.deepEqual(await markdownDestination(ctx, artifact), { out: '/tmp/zoommate-save-ui/existing.md' });
});
