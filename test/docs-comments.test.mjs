import test from 'node:test';
import assert from 'node:assert/strict';
import { runDocs } from '../src/docs.mjs';

function commentSession() {
  const state = { count: '3', newest: '300' };
  const thread = () => ({ threadId: 'thread', fileId: 'doc', rootBlockId: 'doc', threadStatus: 'open',
    createdBy: 'author', commentType: 1, blockIds: ['paragraph'], selectContent: 'anchor',
    createAt: '100', modifyAt: '100', newestCommentCreateAt: state.newest, commentCount: state.count });
  const session = { identity: { user: { userId: 'reader' } }, request: async path => {
    if (path === '/api/file/files/action/batch_get') return { successItems: [{ id: 'doc', fileType: 'doc', fileClusterApiPrefix: 'https://docs.zoom.us' }] };
    if (path.startsWith('/api/page/')) return { content: { data: Buffer.from(JSON.stringify({ blocks: {
      doc: { id: 'doc', version: 1 }, paragraph: { id: 'paragraph', parentId: 'doc', content: { title: JSON.stringify([[0, 'anchor', 'thread-thread:true']]) } },
    } })).toString('base64') } };
    if (path.startsWith('/api/comment/threads:batchGet')) return { threads: [{ thread: thread(), nextCursor: '', firstComment: null,
      comments: ['third', 'second', 'root'].map((id, index) => ({ comment: { commentId: id, threadId: 'thread', createdBy: 'author',
        content: JSON.stringify({ text: id }), createAt: String(300 - index * 100), attachments: '', parentComment: '' }, reactions: [] })) }], users: {} };
    throw new Error(`Unexpected request ${path}`);
  } };
  return { session, state };
}

test('bounded native-batch windows recover each comment once and reject a changed thread', async () => {
  const { session, state } = commentSession();
  const options = { id: 'doc', thread: 'thread', limit: 1 };
  const pages = [];
  let cursor;
  do {
    const page = await runDocs(session, 'comment-thread', { ...options, cursor });
    assert.equal(page.items.length, 1);
    pages.push(page); cursor = page.nextCursor;
    assert.ok(pages.length <= 3);
  } while (cursor);
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.id)), ['third', 'second', 'root']);
  assert.equal(pages.at(-1).pagination.complete, true);
  state.newest = '400';
  await assert.rejects(runDocs(session, 'comment-thread', { ...options, cursor: pages[0].nextCursor }), { code: 'CURSOR_STALE' });
  state.count = undefined;
  const unknownCount = await runDocs(session, 'comment-thread', { ...options, limit: 3 });
  assert.equal(unknownCount.pagination.complete, false);
  assert.equal(unknownCount.pagination.reason, 'COMMENT_COUNT_UNVERIFIED');
});

test('native discussion continuation stops incomplete when the service repeats its boundary', async () => {
  const { session } = commentSession();
  session.identity.user.accountId = 'account';
  const request = session.request;
  session.request = async (path, options) => path.startsWith('/api/comment/discussions:batchGet') ? {
    threads: [{ thread: { threadId: 'page-thread', fileId: 'doc', rootBlockId: 'doc',
      threadStatus: 'open', commentType: 2, commentCount: '1', blockIds: [] },
      comments: [{ comment: { commentId: 'root', threadId: 'page-thread', content: '{"text":"Page review"}' } }], nextCursor: '' }],
    users: {}, nextCursor: 'native-boundary',
  } : request(path, options);
  const first = await runDocs(session, 'discussions', { id: 'doc', limit: 1 });
  const second = await runDocs(session, 'discussions', { id: 'doc', limit: 1, cursor: first.nextCursor });
  assert.deepEqual(first.items.map(item => item.id), ['page-thread']);
  assert.deepEqual(second.items, []);
  assert.equal(second.nextCursor, null);
  assert.equal(second.pagination.complete, false);
  assert.equal(second.pagination.reason, 'REPEATED_NATIVE_THREAD');
  assert.deepEqual(second.repeatedThreadIds, ['page-thread']);
});

function contextualSession(t, { runs, selected, markdown, duplicate = false, changingVersion = false, children = [] }) {
  const { session } = commentSession(), request = session.request;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(markdown, { headers: { 'content-disposition': 'attachment; filename="fixture.md"' } }));
  session.request = async (path, options) => {
    if (path === '/api/file/files/action/batch_get') return { successItems: [{ id: 'doc', fileType: 'doc', fileClusterApiPrefix: 'https://docs.zoom.us',
      privilege: { permissionWithReason: { export: { hasPermission: true } } } }] };
    if (path === '/api/file/files/action/batch_get_children') return { successItems: [{ parentId: 'doc', children }] };
    if (path.startsWith('/api/page/')) return { content: { data: Buffer.from(JSON.stringify({ blocks: {
      doc: { id: 'doc', version: changingVersion ? ++reads : 1 },
      paragraph: { id: 'paragraph', type: 'BLOCK_TYPE_PARAGRAPH', parentId: 'doc', content: { title: JSON.stringify(runs) } },
      ...(duplicate ? { duplicate: { id: 'duplicate', type: 'BLOCK_TYPE_PARAGRAPH', parentId: 'doc', content: { title: JSON.stringify(runs.map(run => [0, run[1]])) } } } : {}),
    } })).toString('base64') } };
    if (path.startsWith('/api/comment/threads:batchGet')) {
      const value = await request(path, options); value.threads[0].thread.selectContent = selected; return value;
    }
    if (path.startsWith('/api/bridge/export/create')) return { taskId: 'task' };
    if (path.startsWith('/api/bridge/export/status')) return { list: [{ taskId: 'task', status: 2, signedUrl: 'https://file.zoom.us/file/fixture' }] };
    return request(path, options);
  };
  return session;
}

test('contextual Markdown mapping keeps UTF16 positions through split emphasis runs', async t => {
  const session = contextualSession(t, { runs: [[0, 'café 𝄞 '], [0, 'bo', '8:1'], [0, 'ld', '8:1|thread-thread:true']],
    selected: 'ld', markdown: 'café 𝄞 **bold**\n' });
  const value = await runDocs(session, 'comment-context', { id: 'doc', thread: 'thread' });
  assert.equal(value.context.status, 'exact');
  assert.equal(value.context.ranges[0].offset, 10);
  const range = value.context.ranges[0].markdownRanges[0];
  assert.deepEqual(range.start, { offset: 12, line: 1, column: 13 });
  assert.equal(value.export.markdown.slice(range.start.offset, range.end.offset), 'ld');
});

test('contextual mapping uses native repeated-sentence offset, never an arbitrary matching block', async t => {
  const text = 'Unique. Same. Same. End.', offset = text.lastIndexOf('Same.');
  const runs = [[0, text.slice(0, offset)], [0, 'Same.', 'thread-thread:true'], [0, text.slice(offset + 5)]];
  const first = await runDocs(contextualSession(t, { runs, selected: 'Same.', markdown: `${text}\n` }), 'comment-context', { id: 'doc', thread: 'thread' });
  assert.equal(first.context.ranges[0].markdownRanges[0].start.offset, offset);
  const repeated = await runDocs(contextualSession(t, { runs, selected: 'Same.', markdown: `${text}\n\n${text}\n`, duplicate: true }), 'comment-context', { id: 'doc', thread: 'thread' });
  assert.equal(repeated.context.status, 'ambiguous');
  assert.equal(repeated.context.ranges[0].reason, 'REPEATED_SOURCE_BLOCK');
  assert.equal(repeated.context.ranges[0].markdownRanges, undefined);
});

test('changed native selection cannot be claimed as an exact current export anchor', async t => {
  const session = contextualSession(t, { runs: [[0, 'Replacement.', 'thread-thread:true']], selected: 'Original.', markdown: 'Replacement.\n' });
  const value = await runDocs(session, 'comment-context', { id: 'doc', thread: 'thread' });
  assert.equal(value.context.status, 'stale');
  assert.equal(value.context.reason, 'SELECTED_CONTENT_CHANGED');
  assert.equal(value.context.selectedText, 'Replacement.');
  assert.equal(value.context.ranges.some(range => range.markdownRanges), false);
});

test('contextual export refuses source changes and unverified descendant export scope', async t => {
  const fixture = { runs: [[0, 'anchor', 'thread-thread:true']], selected: 'anchor', markdown: 'anchor\n' };
  await assert.rejects(runDocs(contextualSession(t, { ...fixture, changingVersion: true }), 'comment-context', { id: 'doc', thread: 'thread' }),
    error => {
      assert.equal(error.code, 'WRITE_UNCONFIRMED');
      assert.equal(error.details.cause.code, 'VERSION_CONFLICT');
      assert.equal(error.details.taskId, 'task');
      assert.equal(error.details.outcome, 'unknown');
      return true;
    });
  await assert.rejects(runDocs(contextualSession(t, { ...fixture, children: [{ id: 'child' }] }), 'comment-context', { id: 'doc', thread: 'thread' }), { code: 'UNSUPPORTED_PERMISSION_SCOPE' });
});
