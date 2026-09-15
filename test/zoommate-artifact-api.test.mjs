import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../src/session.mjs';
import { readZoomMateArtifact, saveZoomMateArtifact, exportZoomMateArtifact, readZoomMateSnapshot } from '../src/zoommate-artifact-api.mjs';

const file = { key: 'file:f1', kind: 'file', id: 'f1', sessionId: 's1', title: 'verification.md' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('native text previews allow empty Markdown but do not reinterpret binary previews', async () => {
  const transport = { request: async () => ({ type: 'text', text: '' }) };
  assert.equal((await readZoomMateArtifact(transport, file)).markdown, '');
  transport.request = async () => ({ type: 'binary', contentB64: 'dGV4dA==' });
  await assert.rejects(readZoomMateArtifact(transport, file), { code: 'UNSUPPORTED_PREVIEW' });
});

test('an existing document opens its original identity without an import mutation', async () => {
  const result = await exportZoomMateArtifact({ request() { assert.fail('Existing Docs must not be copied.'); } }, { kind: 'document', id: 'doc1' });
  assert.equal(result.url, 'https://docs.zoom.us/doc/doc1');
});

test('a fresh process can reconcile a known pending conversion using metadata reads only', async () => {
  let reads = 0;
  const transport = { request: async (path, options = {}) => {
    assert.notEqual(options.method, 'POST', 'A resumed task must not create a second document.');
    assert.equal(path, '/api/v2/assets/s1/all-files');
    return [{ id: 'f1', ai_office_url: ++reads > 1 ? 'https://docs.zoom.us/doc/converted' : null }];
  } };
  const result = await exportZoomMateArtifact(transport, file, { task: 'known-task' });
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.url, 'https://docs.zoom.us/doc/converted');
});

test('read-only export checks never import or prevent a subsequent explicit export', async () => {
  let writes = 0;
  const transport = { request: async (_path, options = {}) => {
    if (options.method === 'POST') { writes++; return { status: 'completed', editUrl: 'https://docs.zoom.us/doc/new-export' }; }
    return [{ id: 'f1' }];
  } };
  const checked = await exportZoomMateArtifact(transport, file, { reconcileOnly: true });
  assert.equal(checked.outcome, 'unavailable');
  assert.equal(writes, 0);
  const exported = await exportZoomMateArtifact(transport, file);
  assert.equal(exported.url, 'https://docs.zoom.us/doc/new-export');
  assert.equal(writes, 1);
});

test('a resumed pending conversion remains read-only on subsequent checks without its task argument', async () => {
  let reads = 0, completeAfter = Infinity;
  const transport = { request: async (_path, options = {}) => {
    assert.notEqual(options.method, 'POST', 'A known pending conversion cannot be submitted again.');
    return [{ id: 'f1', ...(++reads >= completeAfter ? { ai_office_url: 'https://docs.zoom.us/doc/resumed-export' } : {}) }];
  } };
  const pending = await exportZoomMateArtifact(transport, file, { task: 'native-pending-task' });
  assert.equal(pending.outcome, 'pending');
  completeAfter = reads + 2;
  const completed = await exportZoomMateArtifact(transport, file);
  assert.equal(completed.url, 'https://docs.zoom.us/doc/resumed-export');
});

test('a lost conversion acknowledgement is reconciled without replaying its write', async () => {
  let reads = 0, writes = 0;
  const transport = { request: async (_path, options = {}) => {
    if (options.method === 'POST') { writes++; throw new AppError('NETWORK_ERROR', 'Lost acknowledgement'); }
    return [{ id: 'f1', ai_office_url: ++reads >= 3 ? 'https://docs.zoom.us/doc/converted' : null }];
  } };
  await assert.rejects(exportZoomMateArtifact(transport, file), { code: 'WRITE_UNCONFIRMED' });
  const result = await exportZoomMateArtifact(transport, file);
  assert.equal(result.url, 'https://docs.zoom.us/doc/converted');
  assert.equal(writes, 1);
});

test('Markdown saves exact native bytes exclusively in private mode', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-save-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'verification.md'), content = '# Saved\n\n- Value\n';
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, 'error');
    return new Response(content, { headers: { 'content-type': 'text/markdown' } });
  });
  const transport = { request: async () => ({ fileUrl: 'https://file.zoom.us/file/f1?jwt=private-capability' }) };
  const result = await saveZoomMateArtifact(transport, file, { out });
  assert.equal(result.out, out);
  assert.equal(result.mode, '0600');
  assert.equal(await readFile(out, 'utf8'), content);
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  await assert.rejects(saveZoomMateArtifact(transport, file, { out }), { code: 'EEXIST' });
  assert.equal(await readFile(out, 'utf8'), content);
});

test('existing Markdown files and symlinks remain untouched', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-existing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'existing.md'), link = join(dir, 'linked.md'), original = 'Original content that must survive.';
  await writeFile(out, original, { mode: 0o640 });
  await symlink(out, link);
  const transport = { request: async () => ({ fileUrl: 'https://file.zoom.us/file/f1' }) };
  t.mock.method(globalThis, 'fetch', async () => new Response('# New\n', { headers: { 'content-type': 'text/markdown' } }));
  await assert.rejects(saveZoomMateArtifact(transport, file, { out }), { code: 'EEXIST' });
  await assert.rejects(saveZoomMateArtifact(transport, file, { out: link }), { code: 'EEXIST' });
  assert.equal(await readFile(out, 'utf8'), original);
  assert.equal((await stat(out)).mode & 0o777, 0o640);
});

test('concurrent exports cannot create two native documents while metadata reads overlap', async () => {
  let reads = 0, writes = 0;
  const initialReads = Promise.withResolvers();
  const transport = { request: async (_path, options = {}) => {
    if (options.method === 'POST') { writes++; return { status: 'completed', editUrl: 'https://docs.zoom.us/doc/only-copy' }; }
    const read = ++reads;
    if (read <= 2) {
      if (read === 2) initialReads.resolve();
      await initialReads.promise;
      return [{ id: 'f1' }];
    }
    return [{ id: 'f1', ai_office_url: 'https://docs.zoom.us/doc/only-copy' }];
  } };
  const results = await Promise.all([exportZoomMateArtifact(transport, file), exportZoomMateArtifact(transport, file)]);
  assert.deepEqual(results.map(result => result.url), ['https://docs.zoom.us/doc/only-copy', 'https://docs.zoom.us/doc/only-copy']);
  assert.equal(writes, 1);
});

test('screenshots decode real image headers and reject unsafe download origins', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(png, { headers: { 'content-type': 'application/octet-stream' } }));
  const transport = { request: async () => ({ fileUrl: 'https://file.zoom.us/file/image1' }) };
  const image = await readZoomMateSnapshot(transport, { fileId: 'image1' });
  assert.deepEqual([image.width, image.height, image.mimeType], [1, 1, 'image/png']);
  await assert.rejects(readZoomMateSnapshot({}, { url: 'https://untrusted.invalid/file/image' }), { code: 'UNSUPPORTED_DOWNLOAD' });
  await assert.rejects(readZoomMateSnapshot({}, { base64: Buffer.from('not an image').toString('base64') }), { code: 'INVALID_MEDIA' });
});
