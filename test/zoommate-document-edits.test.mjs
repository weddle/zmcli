import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/session.mjs';
import { prepareZoomMateDocumentEdit, commitZoomMateDocumentEdit } from '../src/zoommate-document-edits.mjs';

const page = () => ({ blocks: {
  d1: { id: 'd1', version: 3, type: 'BLOCK_TYPE_PAGE', content: { title: 'Verification' }, parentId: null, seq: '0', style: {} },
  abc123: { id: 'abc123', version: 1, type: 'BLOCK_TYPE_BULLET', content: { title: JSON.stringify([[0, 'First value: alpha', '26:"actor"']]) }, parentId: 'd1', seq: 'a0', style: {} },
  neighbor: { id: 'neighbor', version: 1, type: 'BLOCK_TYPE_PARAGRAPH', content: { title: JSON.stringify([[0, { link: { source: { type: 'link', text: 'Unchanged link', link: 'https://example.com/' } } }, '26:"actor"']]) }, parentId: 'd1', seq: 'a1', style: { indent: 1 } },
} });
const artifact = xml => ({ id: 'd1', update: { editId: 'edit1', transactionId: 'native-transaction', xml } });
function backend() {
  const current = page(), writes = [];
  const docs = { identity: { user: { userId: 'actor', accountId: 'account' } }, current, writes,
    request: async (path, options = {}) => {
      if (path === '/api/file/files/action/batch_get') return { successItems: [{ id: 'd1', fileType: 'doc', title: 'Verification', fileClusterApiPrefix: 'https://docs.zoom.us', privilege: { permissionWithReason: { edit: { hasPermission: true } } } }] };
      if (path.includes('/content?')) return { content: { data: Buffer.from(JSON.stringify(current)).toString('base64') } };
      if (path.startsWith('/api/block/transactions?')) {
        writes.push(options.body);
        assert.deepEqual(options.body.transactions, [{ id: 'native-transaction', ops: [{ command: 'COMMAND_TYPE_UPDATE', blockId: 'abc123', args: { delta: JSON.stringify([[0, 'First value: gamma', '26:"actor"'], [1, 18]]) } }], extra: { editsSourceType: 'EDIT_SOURCE_TYPE_AI_PANEL', transactionId: 'native-transaction' } }]);
        current.blocks.abc123.content.title = JSON.stringify([[0, 'First value: gamma', '26:"actor"']]);
        current.blocks.d1.version = 4;
        return {};
      }
      assert.fail(`Unexpected native route: ${path}`);
    },
  };
  return docs;
}

test('a captured native update preserves block identity and unrelated embedded rich content', async () => {
  const docs = backend(), neighbor = structuredClone(docs.current.blocks.neighbor);
  const plan = await prepareZoomMateDocumentEdit(docs, artifact('<update id="abc"><uli>First value: gamma</uli></update>'));
  assert.match(plan.beforeMarkdown, /First value: alpha/);
  assert.match(plan.afterMarkdown, /First value: gamma/);
  const result = await commitZoomMateDocumentEdit(docs, plan);
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.version, 4);
  assert.deepEqual(docs.current.blocks.neighbor, neighbor);
  await assert.rejects(commitZoomMateDocumentEdit(docs, plan), { code: 'INVALID_INPUT' });
  assert.equal(docs.writes.length, 1);
});

test('a document changed during human review is rejected before any mutation', async () => {
  const docs = backend();
  const plan = await prepareZoomMateDocumentEdit(docs, artifact('<update id="abc"><text>Changed</text></update>'));
  docs.current.blocks.d1.version++;
  await assert.rejects(commitZoomMateDocumentEdit(docs, plan), { code: 'VERSION_CONFLICT' });
  assert.equal(docs.writes.length, 0);
});

test('ambiguous prefixes and unsupported formatting fail before document mutation', async () => {
  const docs = backend();
  docs.current.blocks.abc456 = { ...structuredClone(docs.current.blocks.abc123), id: 'abc456', seq: 'a2' };
  await assert.rejects(prepareZoomMateDocumentEdit(docs, artifact('<delete id="abc"/>')), { code: 'AMBIGUOUS_EDIT_TARGET' });
  await assert.rejects(prepareZoomMateDocumentEdit(docs, artifact('<update id="abc123"><uli color="red">Changed</uli></update>')), { code: 'UNSUPPORTED_EDIT' });
  assert.equal(docs.writes.length, 0);
});

test('an uncertain native transaction retains its IDs and cannot be submitted again', async () => {
  const docs = backend(), original = docs.request;
  let submitted = 0;
  docs.request = async (path, options) => {
    if (path.startsWith('/api/block/transactions?')) { submitted++; throw new AppError('NETWORK_ERROR', 'Acknowledgement lost'); }
    return original(path, options);
  };
  const plan = await prepareZoomMateDocumentEdit(docs, artifact('<update id="abc"><uli>First value: gamma</uli></update>'));
  await assert.rejects(commitZoomMateDocumentEdit(docs, plan), error => error.code === 'WRITE_UNCONFIRMED' && error.details.transactionId === 'native-transaction');
  await assert.rejects(commitZoomMateDocumentEdit(docs, plan), { code: 'INVALID_INPUT' });
  assert.equal(submitted, 1);
});

test('inline formatting metadata cannot be silently discarded during approval', async () => {
  await assert.rejects(prepareZoomMateDocumentEdit(backend(), artifact('<update id="abc"><uli><b color="red">Changed</b></uli></update>')), { code: 'UNSUPPORTED_EDIT' });
});

test('unknown or conflicting insertion coordinates cannot silently change placement', async () => {
  await assert.rejects(prepareZoomMateDocumentEdit(backend(), artifact('<insert after="abc"><text>Added</text></insert>')), { code: 'UNSUPPORTED_EDIT' });
  await assert.rejects(prepareZoomMateDocumentEdit(backend(), artifact('<insert above="abc" below="neighbor"><text>Added</text></insert>')), { code: 'UNSUPPORTED_EDIT' });
});

test('native insertion and whole-block range replacement preserve outside content and order', async () => {
  const docs = backend(), original = docs.request;
  const outside = { id: 'outside', version: 1, type: 'BLOCK_TYPE_PARAGRAPH', parentId: 'd1', seq: 'a2',
    content: { title: JSON.stringify([[0, 'Outside', '26:"actor"']]) }, style: { indent: 2 } };
  docs.current.blocks.outside = structuredClone(outside);
  docs.request = async (path, options) => {
    if (!path.startsWith('/api/block/transactions?')) return original(path, options);
    const ops = options.body.transactions[0].ops, introductionId = ops[0].blockId, replacementId = ops[3].blockId;
    const introduction = { id: introductionId, type: 'BLOCK_TYPE_HEADING2', parentId: 'd1', seq: 'a0',
      content: { title: JSON.stringify([[0, 'Introduction', '26:"actor"']]) }, style: {} };
    const replacement = { id: replacementId, type: 'BLOCK_TYPE_BULLET', parentId: 'd1', seq: 'a1',
      content: { title: JSON.stringify([[0, 'Replacement', '26:"actor"']]) }, style: {} };
    assert.deepEqual(ops, [
      { command: 'COMMAND_TYPE_CREATE', blockId: introductionId, args: { type: introduction.type, content: introduction.content, style: {}, parentBlockId: 'd1', afterBlockId: null } },
      { command: 'COMMAND_TYPE_DELETE', blockId: 'abc123' },
      { command: 'COMMAND_TYPE_DELETE', blockId: 'neighbor' },
      { command: 'COMMAND_TYPE_CREATE', blockId: replacementId, args: { type: replacement.type, content: replacement.content, style: {}, parentBlockId: 'd1', afterBlockId: introductionId } },
    ]);
    docs.current.blocks = { d1: { ...docs.current.blocks.d1, version: 4 }, [introductionId]: introduction, [replacementId]: replacement, outside };
    return {};
  };
  const plan = await prepareZoomMateDocumentEdit(docs, artifact('<insert above="block-0"><h2>Introduction</h2></insert><replace-range start-id="abc123" end-id="neighbor"><uli>Replacement</uli></replace-range>'));
  assert.match(plan.afterMarkdown, /Introduction[\s\S]*Replacement[\s\S]*Outside/);
  assert.doesNotMatch(plan.afterMarkdown, /First value|Unchanged link/);
  assert.equal((await commitZoomMateDocumentEdit(docs, plan)).outcome, 'confirmed');
});
