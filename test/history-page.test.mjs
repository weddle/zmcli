import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeHistoryPage } from '../src/history-page.mjs';
import { cursorScope, decodeCursor, encodeCursor } from '../src/cursor.mjs';
import { documentPage, runDocs } from '../src/docs.mjs';
import { runChat } from '../src/chat.mjs';
import { AppError } from '../src/session.mjs';
import { messageContent } from '../src/chat-transport.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scope = cursorScope('chat read', { channel: 'synthetic-channel' });
const record = (id, timestamp, text = id) => ({ id, timestamp, text });

test('a boundary bucket is drained before advancing past equal timestamps', () => {
  const a = record('a', 11), b = record('b', 10), c = record('c', 10), d = record('d', 9);
  const first = completeHistoryPage({ messages: [a, b] }, { messages: [c, b] }, 2, scope);
  assert.deepEqual(first.messages.map(m => m.id), ['a', 'b', 'c']);
  assert.equal(decodeCursor(first.nextCursor, scope).before, 9);
  const last = completeHistoryPage({ messages: [d] }, undefined, 2, scope);
  assert.deepEqual([...first.messages, ...last.messages].map(m => m.id), ['a', 'b', 'c', 'd']);
  assert.equal(last.pagination.complete, true);
  assert.equal(last.nextCursor, null);
});

test('a saturated or changing boundary never advertises safe continuation', () => {
  const corpus = Array.from({ length: 101 }, (_, i) => record(`tied-${i}`, 10));
  const saturated = completeHistoryPage({ messages: [corpus[0]] }, { messages: corpus.slice(0, 100) }, 1, scope);
  assert.equal(saturated.pagination.status, 'incomplete');
  assert.equal(saturated.pagination.complete, false);
  assert.equal(saturated.nextCursor, null);
  const changed = completeHistoryPage({ messages: [record('a', 10, 'before')] }, { messages: [record('a', 10, 'after')] }, 1, scope);
  assert.equal(changed.pagination.reason, 'HISTORY_CHANGED_DURING_READ');
  assert.equal(changed.nextCursor, null);
});

test('empty terminal pages and scoped cursors are unambiguous', () => {
  const empty = completeHistoryPage({ messages: [] }, undefined, 1, scope);
  assert.equal(empty.pagination.status, 'end');
  assert.equal(empty.pagination.complete, true);
  const cursor = encodeCursor(scope, { before: 10 });
  assert.throws(() => decodeCursor(cursor, cursorScope('chat read', { channel: 'another-channel' })), { code: 'INVALID_INPUT' });
  const thread = cursorScope('chat thread', { channel: 'synthetic-channel', thread: '5' });
  assert.throws(() => decodeCursor(cursor, thread), { code: 'INVALID_INPUT' });
  const search = encodeCursor(cursorScope('docs find', { query: 'one' }), { token: 'opaque-service-position', seen: [] });
  assert.throws(() => decodeCursor(search, cursorScope('docs find', { query: 'two' })), { code: 'INVALID_INPUT' });
});

test('moving search results stop incomplete instead of repeating records', () => {
  const result = documentPage([{ id: 'already-seen' }, { id: 'new' }], 'next-native-token',
    cursorScope('docs find', { query: 'synthetic' }), ['already-seen']);
  assert.deepEqual(result.items.map(item => item.id), ['new']);
  assert.equal(result.pagination.status, 'incomplete');
  assert.equal(result.pagination.complete, false);
  assert.equal(result.nextCursor, null);
});

test('a saturated directory result stays incomplete despite a terminal service envelope', async () => {
  const session = { openChat: async () => ({
    identity: { user: { accountId: 'synthetic-account' } },
    channelSuffix: '@conference.xmpp.zoom.us',
    request: async () => ({ result: 0, keyword: 'fixture', page: 1, total: 1, hasMore: false,
      data: [{ channelId: 'one', name: 'fixture' }] }),
  }) };
  const result = await runChat(session, 'find', { query: 'fixture', limit: 1 });
  assert.equal(result.pagination.complete, false);
  assert.equal(result.pagination.reason, 'SEARCH_RESULT_LIMIT');
  assert.equal(result.nextCursor, null);
});

test('an unavailable document root is an error, not a successful empty tree', async () => {
  await assert.rejects(
    runDocs({ request: async () => ({ successItems: [] }) }, 'read', { id: 'unavailable' }),
    { code: 'NOT_FOUND_OR_FORBIDDEN' },
  );
});

test('bounded or unknown search retention cannot issue an unfiltered query', async () => {
  for (const retention of [false, undefined]) {
    let sent = false;
    const session = { openChat: async () => ({ messageSearchEnabled: true, unlimitedSearchRetention: retention,
      request: async () => { sent = true; throw new Error('Unexpected search'); } }) };
    await assert.rejects(runChat(session, 'search', { query: 'synthetic' }), { code: 'UNSUPPORTED_SEARCH_RETENTION' });
    assert.equal(sent, false);
  }
});

function roleSession({ extraUser = false, loseReadback = false } = {}) {
  const grant = (id, role) => ({ user: { id }, role: { role, newRole: role },
    isInherited: false, isExternal: false, isEmailInvitee: false });
  const permission = { collaborators: [grant('owner', 'owner'), grant('member', 'editor')],
    disabledExternalCollaborators: [], sharingMeetings: [], spacePermissionSetting: { role: 'unspecified', newRole: 'unspecified' },
    meetingDocRole: null, linkAccess: { settingItem: 'accountPermissionSetting', role: { role: 'noAccess', newRole: 'noAccess' } },
    emailInviteIsClosed: false };
  if (extraUser) permission.collaborators.push(grant('unexpected-user', 'viewer'));
  const capabilities = Object.fromEntries(['access', 'edit', 'seeCollaborators', 'addCollaborators', 'removeCollaborators', 'modifyCollaboratorRole']
    .map(name => [name, { hasPermission: true, reasonCode: '' }]));
  const state = { writes: 0 };
  const session = {
    identity: { user: { userId: 'owner', accountId: 'account' } },
    async request(path, options = {}) {
      if (path === '/api/file/files/action/batch_get') return { successItems: [{
        id: 'doc', fileType: 'doc', parentId: 'my-docs', ownerId: 'owner', fileClusterApiPrefix: 'https://docs.zoom.us',
        privilege: { role: { role: 'owner', newRole: 'owner' }, permissionWithReason: capabilities },
      }] };
      if (path === '/api/file/files/doc/permission') {
        if (state.writes && loseReadback) throw new Error('Readback unavailable after acceptance');
        return structuredClone(permission);
      }
      if (path.includes('/ancestors/permission')) return { ancestorPermissionInfos: [
        { id: 'doc', fileType: 'doc', supportPermissionSetting: true, canSeeCollaborators: true, permissionInfo: permission },
        { id: 'my-docs', fileType: 'space', supportPermissionSetting: false },
      ] };
      if (path.endsWith('/batch_get_children')) return { successItems: [{ parentId: 'doc', children: [] }] };
      if (path.endsWith('/collaborators') && options.method === 'PATCH') {
        state.writes++;
        permission.collaborators[1].role = { role: 'viewer', newRole: 'viewer' };
        return {};
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  };
  return { session, state };
}

function anchoredWriteSession({ lostThreadAck = false, changedAfterThread = false } = {}) {
  const { session } = roleSession(), request = session.request;
  const state = { threadPosts: 0, annotationPosts: 0 };
  session.request = async (path, options = {}) => {
    if (path === '/api/file/files/action/batch_get') {
      const value = await request(path, options);
      value.successItems[0].privilege.permissionWithReason.comment = { hasPermission: true, reasonCode: '' };
      return value;
    }
    if (path.startsWith('/api/page/')) return { content: { data: Buffer.from(JSON.stringify({ blocks: {
      doc: { id: 'doc', type: 'BLOCK_TYPE_PAGE', version: state.threadPosts && changedAfterThread ? 2 : 1 },
      paragraph: { id: 'paragraph', type: 'BLOCK_TYPE_PARAGRAPH', parentId: 'doc', content: { title: JSON.stringify([[0, 'café 𝄞 bold', 'thread-prior:true']]) } },
    } })).toString('base64') } };
    if (path === '/api/comment/threads?fileId=doc') {
      state.threadPosts++; state.threadId = options.body.threadId;
      if (lostThreadAck) throw new AppError('REQUEST_FAILED', 'Response lost after submission');
      return { thread: { threadId: state.threadId, fileId: 'doc', rootBlockId: 'doc', commentType: 1, threadStatus: 'open',
        blockIds: ['paragraph'], selectContent: '𝄞' }, comment: { commentId: options.body.commentId, threadId: state.threadId, createdBy: 'owner', content: '{"text":"Review"}' } };
    }
    if (path === '/api/block/transactions?fileId=doc') { state.annotationPosts++; throw new Error('Annotation must not be sent in this fixture'); }
    return request(path, options);
  };
  return { session, state };
}

const anchoredOptions = { id: 'doc', block: 'paragraph', offset: 5, length: 2, quote: '𝄞', 'if-version': 1, text: 'Review', 'expect-users': 'owner,member' };

test('lost thread creation acknowledgement never sends an annotation or recreates the comment', async () => {
  const { session, state } = anchoredWriteSession({ lostThreadAck: true });
  await assert.rejects(runDocs(session, 'comment-create', anchoredOptions), error => {
    assert.equal(error.code, 'WRITE_UNCONFIRMED');
    assert.equal(error.details.threadId, state.threadId);
    assert.equal(error.details.phase, 'thread_submitted');
    assert.equal(error.details.annotationAcceptance, 'not_sent');
    return true;
  });
  assert.equal(state.threadPosts, 1);
  assert.equal(state.annotationPosts, 0);
});

test('a page change after acknowledged comment creation preserves the partial thread without annotating', async () => {
  const { session, state } = anchoredWriteSession({ changedAfterThread: true });
  await assert.rejects(runDocs(session, 'comment-create', anchoredOptions), error => {
    assert.equal(error.details.cause.code, 'VERSION_CONFLICT');
    assert.equal(error.details.outcome, 'unknown');
    assert.equal(error.details.threadId, state.threadId);
    assert.equal(error.details.threadAcceptance, 'accepted');
    assert.equal(error.details.annotationAcceptance, 'not_sent');
    return true;
  });
  assert.equal(state.threadPosts, 1);
  assert.equal(state.annotationPosts, 0);
});

test('a matching half-surrogate quote still cannot create a native anchor', async () => {
  const { session, state } = anchoredWriteSession();
  await assert.rejects(runDocs(session, 'comment-create', { ...anchoredOptions, length: 1, quote: '\uD834' }),
    error => error.code === 'ANCHOR_CHANGED' && error.details.outcome === 'not_sent');
  assert.equal(state.threadPosts, 0);
});

function replyWriteSession({ lostAck = false, resolved = false, changedParent = false } = {}) {
  const { session } = anchoredWriteSession(), request = session.request;
  const state = { replyPosts: 0 };
  const original = { commentId: 'original', threadId: 'prior', createdBy: 'member', createAt: '100',
    content: '{"text":"Original café 𝄞."}', parentComment: '', parentId: '', isEdited: false };
  const thread = () => ({ threadId: 'prior', fileId: 'doc', rootBlockId: 'doc', threadStatus: 'open', commentType: 1,
    createdBy: 'member', createAt: '100', modifyAt: '100', newestCommentCreateAt: state.replyPosts ? '101' : '100',
    commentCount: String(1 + state.replyPosts), blockIds: ['paragraph'], selectContent: 'café 𝄞 bold' });
  session.request = async (path, options = {}) => {
    if (path === '/api/comment/threads:batchGet?fileId=doc') {
      if (resolved) return { threads: [], users: {} };
      const comments = [{ comment: { ...original, parentId: state.replyPosts && changedParent ? 'different-parent' : '' }, reactions: [] }];
      if (state.reply) comments.unshift({ comment: state.reply, reactions: [] });
      return { threads: [{ thread: thread(), comments, nextCursor: '' }], users: {} };
    }
    if (path === '/api/comment/comments?fileId=doc' && options.method === 'POST') {
      state.replyPosts++;
      state.reply = { commentId: options.body.commentId, threadId: 'prior', createdBy: 'owner', createAt: '101',
        content: options.body.commentContent, parentComment: '', parentId: '', isEdited: false };
      if (lostAck) throw new AppError('REQUEST_FAILED', 'Reply response lost after submission');
      return { thread: thread(), comment: state.reply };
    }
    return request(path, options);
  };
  return { session, state };
}

const replyOptions = { id: 'doc', thread: 'prior', text: 'Exact reply', 'expect-users': 'owner,member' };

test('a lost reply acknowledgement retains reconciliation identities without replay', async () => {
  const { session, state } = replyWriteSession({ lostAck: true });
  await assert.rejects(runDocs(session, 'comment-reply', replyOptions), error => error.code === 'WRITE_UNCONFIRMED'
    && error.details.outcome === 'unknown' && error.details.threadId === 'prior' && error.details.commentId === state.reply.commentId);
  assert.equal(state.replyPosts, 1);
});

test('an unavailable open thread cannot receive a reply or be implicitly reopened', async () => {
  const { session, state } = replyWriteSession({ resolved: true });
  await assert.rejects(runDocs(session, 'comment-reply', replyOptions), error => error.code === 'THREAD_NOT_RETURNED_FOR_STATUS'
    && error.details.outcome === 'not_sent');
  assert.equal(state.replyPosts, 0);
});

test('an acknowledged reply cannot claim confirmation when an original parent changes', async () => {
  const { session, state } = replyWriteSession({ changedParent: true });
  await assert.rejects(runDocs(session, 'comment-reply', replyOptions), error => error.code === 'WRITE_UNCONFIRMED'
    && error.details.outcome === 'unknown' && error.details.cause.code === 'REPLY_READBACK_MISMATCH'
    && error.details.acceptance === 'accepted');
  assert.equal(state.replyPosts, 1);
});

function mentionContacts(session, userIds = ['member']) {
  const request = session.request;
  session.request = async (path, options = {}) => {
    if (path === '/api/user/contact') return { userContacts: userIds.map(userId => ({
      isExternal: false, userInfo: { userId, accountId: 'account', displayName: 'Canonical Person' },
    })) };
    if (path === '/api/file/files/user/vcard') return { isExternal: false,
      vcard: { userId: options.body.userId, email: 'mention@example.test' } };
    return request(path, options);
  };
}

test('a canonical same-account contact outside the private Doc audience cannot be mentioned', async () => {
  const { session, state } = replyWriteSession();
  mentionContacts(session, ['outside']);
  await assert.rejects(runDocs(session, 'comment-reply', { ...replyOptions, 'mention-email': 'mention@example.test' }),
    error => error.code === 'MENTION_AUDIENCE_MISMATCH' && error.details.outcome === 'not_sent');
  assert.equal(state.replyPosts, 0);
});

test('an ambiguous full-email resolution cannot choose an arbitrary mention recipient', async () => {
  const { session, state } = replyWriteSession();
  mentionContacts(session, ['member', 'duplicate']);
  await assert.rejects(runDocs(session, 'comment-reply', { ...replyOptions, 'mention-email': 'mention@example.test' }),
    error => error.code === 'AMBIGUOUS_USER' && error.details.outcome === 'not_sent');
  assert.equal(state.replyPosts, 0);
});

test('unchanged visible text cannot confirm an acknowledgement targeting a different mentioned user', async () => {
  const { session, state } = replyWriteSession();
  mentionContacts(session);
  const request = session.request;
  session.request = async (path, options = {}) => {
    const result = await request(path, options);
    if (path === '/api/comment/comments?fileId=doc') {
      const content = JSON.parse(result.comment.content);
      content.doc[0].content[0].data.person.userId = 'different-user';
      result.comment = { ...result.comment, content: JSON.stringify(content) };
    }
    return result;
  };
  await assert.rejects(runDocs(session, 'comment-reply', { ...replyOptions, 'mention-email': 'mention@example.test' }),
    error => error.code === 'WRITE_UNCONFIRMED' && error.details.outcome === 'unknown'
      && error.details.cause.code === 'REPLY_ACKNOWLEDGEMENT_MISMATCH');
  assert.equal(state.replyPosts, 1);
});

test('unrecognized structured-person metadata cannot claim a complete recipient interpretation', async () => {
  const { session } = replyWriteSession(), request = session.request;
  const content = { text: 'Canonical Person', doc: [{ type: 'BLOCK_TYPE_PARAGRAPH', content: [{ data: {
    person: { userId: 'member', mentionId: 'mention', name: 'Canonical Person', notify: true, audience: 'unknown-future-scope' },
  } }] }] };
  session.request = async (path, options) => {
    const result = await request(path, options);
    if (path === '/api/comment/threads:batchGet?fileId=doc') result.threads[0].comments[0].comment.content = JSON.stringify(content);
    return result;
  };
  const result = await runDocs(session, 'comment-thread', { id: 'doc', thread: 'prior' });
  assert.equal(result.items[0].coverage.complete, false);
  assert.equal(result.items[0].mentions, null);
  assert.deepEqual(result.items[0].structuredContent, content);
});

function stateWriteSession({ status = 'open', lostAck = false, commentPermission = true, loseHistory = false } = {}) {
  const { session } = replyWriteSession(), request = session.request;
  const state = { patches: 0, status, resolveAt: status === 'resolved' ? '180' : '0' };
  const currentThread = async () => {
    const response = await request('/api/comment/threads:batchGet?fileId=doc', { body: { threadIds: ['prior'], threadStatus: 'open' } });
    Object.assign(response.threads[0].thread, { threadStatus: state.status, resolveAt: state.resolveAt, modifyAt: state.patches ? '200' : '100' });
    return response;
  };
  session.request = async (path, options = {}) => {
    if (path === '/api/file/files/action/batch_get') {
      const response = await request(path, options);
      response.successItems[0].privilege.permissionWithReason.comment.hasPermission = commentPermission;
      return response;
    }
    if (path === '/api/comment/threads:batchGet?fileId=doc') {
      return options.body.threadStatus === state.status ? currentThread() : { threads: [], users: {} };
    }
    if (path === '/api/comment/threads/prior?fileId=doc' && options.method === 'PATCH') {
      state.patches++; state.status = options.body.threadStatus;
      if (state.status === 'resolved') state.resolveAt = '200';
      else if (loseHistory) state.resolveAt = '0';
      if (lostAck) throw new AppError('REQUEST_FAILED', 'State transition response lost after submission');
      return { thread: (await currentThread()).threads[0].thread };
    }
    return request(path, options);
  };
  return { session, state };
}

const stateOptions = { id: 'doc', thread: 'prior', 'expect-users': 'owner,member' };

test('an already-resolved thread refuses another state write without assuming idempotency', async () => {
  const { session, state } = stateWriteSession({ status: 'resolved' });
  await assert.rejects(runDocs(session, 'comment-resolve', stateOptions), error => error.code === 'THREAD_STATE_MISMATCH'
    && error.details.observedStatus === 'resolved' && error.details.outcome === 'not_sent');
  assert.equal(state.patches, 0);
});

test('missing comment capability prevents a thread-state write', async () => {
  const { session, state } = stateWriteSession({ commentPermission: false });
  await assert.rejects(runDocs(session, 'comment-resolve', stateOptions), error => error.code === 'FORBIDDEN' && error.details.outcome === 'not_sent');
  assert.equal(state.patches, 0);
});

test('lost thread-state acknowledgement retains exact reconciliation state without replay', async () => {
  const { session, state } = stateWriteSession({ lostAck: true });
  await assert.rejects(runDocs(session, 'comment-resolve', stateOptions), error => error.code === 'WRITE_UNCONFIRMED'
    && error.details.threadId === 'prior' && error.details.requestedStatus === 'resolved' && error.details.outcome === 'unknown');
  assert.equal(state.patches, 1);
});

test('reopening cannot claim confirmation if native last-resolution history disappears', async () => {
  const { session, state } = stateWriteSession({ status: 'resolved', loseHistory: true });
  await assert.rejects(runDocs(session, 'comment-reopen', stateOptions), error => error.code === 'WRITE_UNCONFIRMED'
    && error.details.cause.code === 'THREAD_STATE_READBACK_MISMATCH' && error.details.acceptance === 'accepted');
  assert.equal(state.patches, 1);
});

test('a newly visible collaborator prevents a role mutation before submission', async () => {
  const { session, state } = roleSession({ extraUser: true });
  await assert.rejects(runDocs(session, 'set-role', { id: 'doc', user: 'member', role: 'viewer', 'expect-users': 'owner,member' }),
    error => error.code === 'AUDIENCE_MISMATCH' && error.details.outcome === 'not_sent');
  assert.equal(state.writes, 0);
});

test('accepted role mutation with unavailable permission readback stays unknown without replay', async () => {
  const { session, state } = roleSession({ loseReadback: true });
  await assert.rejects(runDocs(session, 'set-role', { id: 'doc', user: 'member', role: 'viewer', 'expect-users': 'owner,member' }),
    error => error.code === 'WRITE_UNCONFIRMED' && error.details.outcome === 'unknown'
      && error.details.acceptance === 'accepted' && error.details.documentId === 'doc' && error.details.userId === 'member');
  assert.equal(state.writes, 1);
});

test('lost attachment upload retains asset identity and never submits or replays the comment', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'docs-attachment-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const attachment = join(dir, 'proof.bin');
  await writeFile(attachment, Buffer.from([0, 255, 1]));
  const { session, state } = replyWriteSession(), request = session.request;
  session.request = async (path, options) => {
    if (path.startsWith('/api/attachment/getUploadFileUrl')) return { attachmentId: 'allocated-asset',
      signedPutUrl: 'https://file.zoom.us/zoomfile/upload', putHeaders: { 'x-zm-auth': 'synthetic' } };
    const result = await request(path, options);
    if (path === '/api/file/files/action/batch_get') result.successItems[0].privilege.permissionWithReason.upload = { hasPermission: true, reasonCode: '' };
    return result;
  };
  let uploads = 0;
  t.mock.method(globalThis, 'fetch', async () => { uploads++; throw new TypeError('Upload response lost'); });
  await assert.rejects(runDocs(session, 'comment-reply', { ...replyOptions, attachment }), error =>
    error.code === 'WRITE_UNCONFIRMED' && error.details.outcome === 'unknown'
    && error.details.attachment.attachmentId === 'allocated-asset'
    && error.details.phase === 'attachment_upload_submitted');
  assert.equal(uploads, 1);
  assert.equal(state.replyPosts, 0);
});

test('page change during attachment upload cannot create a stale anchored thread', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'docs-attachment-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const attachment = join(dir, 'proof.bin');
  await writeFile(attachment, Buffer.from([0, 255, 1]));
  const { session, state } = anchoredWriteSession(), request = session.request;
  let uploaded = false;
  session.request = async (path, options) => {
    if (path.startsWith('/api/attachment/getUploadFileUrl')) return { attachmentId: 'allocated-asset',
      signedPutUrl: 'https://file.zoom.us/zoomfile/upload', putHeaders: { 'x-zm-auth': 'synthetic' } };
    const result = await request(path, options);
    if (path === '/api/file/files/action/batch_get') result.successItems[0].privilege.permissionWithReason.upload = { hasPermission: true, reasonCode: '' };
    if (uploaded && path.startsWith('/api/page/')) {
      const page = JSON.parse(Buffer.from(result.content.data, 'base64'));
      page.blocks.doc.version = 2;
      result.content.data = Buffer.from(JSON.stringify(page)).toString('base64');
    }
    return result;
  };
  t.mock.method(globalThis, 'fetch', async () => {
    uploaded = true;
    return new Response('', { headers: { 'zoom-file-id': 'allocated-asset' } });
  });
  await assert.rejects(runDocs(session, 'comment-create', { ...anchoredOptions, attachment }), error =>
    error.code === 'WRITE_UNCONFIRMED' && error.details.cause.code === 'VERSION_CONFLICT'
    && error.details.uploadAcceptance === 'confirmed' && error.details.threadAcceptance === 'not_sent'
    && error.details.attachment.attachmentId === 'allocated-asset');
  assert.equal(state.threadPosts, 0);
  assert.equal(state.annotationPosts, 0);
});

test('message-search overlap stops continuation without duplicating a prior result', async () => {
  const row = id => ({ msgId: id, sendTime: 10, parentTime: 0, content: id,
    chatType: { type: 1, receiverJid: 'channel@conference.xmpp.zoom.us' } });
  let requests = 0;
  const session = { openChat: async () => ({ messageSearchEnabled: true, unlimitedSearchRetention: true,
    from: 'owner@xmpp.zoom.us/resource', identity: { user: { accountId: 'account' } },
    channelSuffix: '@conference.xmpp.zoom.us', request: async path => path === '/xms/channel/infos'
      ? { data: { 'channel@conference.xmpp.zoom.us': { name: 'Fixture', account: 'account', type: 2 } } }
      : ++requests === 1
        ? { errorCode: 0, totalSize: 1, searchAfter: 'first-position', msgResults: [row('one')] }
        : { errorCode: 0, totalSize: 2, searchAfter: 'second-position', msgResults: [row('one'), row('two')] },
  }) };
  const first = await runChat(session, 'search', { query: 'fixture', limit: 1 });
  assert.equal(first.pagination.status, 'more');
  assert.throws(() => decodeCursor(first.nextCursor, cursorScope('chat search', { query: 'different' })), { code: 'INVALID_INPUT' });
  const second = await runChat(session, 'search', { query: 'fixture', limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.id), ['two']);
  assert.equal(second.pagination.complete, false);
  assert.equal(second.pagination.status, 'incomplete');
  assert.equal(second.nextCursor, null);
});

test('direct history rejects records outside the resolved actor pair', async () => {
  const peer = 'member@xmpp.zoom.us';
  const chat = {
    from: 'owner@xmpp.zoom.us/resource',
    identity: { user: { accountId: 'account' } },
    async request(path) {
      if (path.endsWith('/search/contact')) return { errorCode: 0, result: [{
        snsEmail: 'member@example.test', userId: 'member', jid: peer, displayName: 'Member',
        isSameAccount: 1, externalFriend: false, inactiveStatus: 0, type: 0,
      }] };
      if (path.endsWith('/vcard/batch')) return { vcardUsers: [{
        userId: 'member', jid: peer, email: 'member@example.test', organization: ['account'],
      }] };
      return { data: [{ session: peer, messages: [{ id: 'cross-conversation-record' }] }] };
    },
    async parseMessages() {
      return [{ id: 'cross-conversation-record', type: 'chat', from: peer,
        to: 'unrelated@xmpp.zoom.us', timestamp: 10, text: 'Not this conversation' }];
    },
  };
  await assert.rejects(runChat({ openChat: async () => chat }, 'dm-read', { email: 'member@example.test' }),
    { code: 'UNSUPPORTED_CONTENT' });
});

test('batch cards do not pair reordered or missing profiles with the wrong input', async () => {
  const chat = { from: 'owner@xmpp.zoom.us/resource',
    identity: { user: { userId: 'owner', accountId: 'account' } },
    request: async () => ({ vcardUsers: [
      { userId: 'Member', jid: 'member@xmpp.zoom.us', nickName: 'Member' },
      { userId: 'Owner', jid: 'owner@xmpp.zoom.us', nickName: 'Owner' },
    ], hiddenUsers: ['hidden@xmpp.zoom.us'] }),
  };
  const result = await runChat({ openChat: async () => chat }, 'cards',
    { users: 'Owner,hidden,member@xmpp.zoom.us' });
  assert.deepEqual(result.items.map(item => [item.input, item.userId, item.status]), [
    ['Owner', 'Owner', 'resolved'], ['hidden', null, 'unresolved'],
    ['member@xmpp.zoom.us', 'Member', 'resolved'],
  ]);
  assert.equal(result.items[1].profile, null);
  assert.equal(result.complete, false);
  assert.equal(result.absentProfileProvesNonexistence, false);
});

test('direct encryption mode blocks transmission before any message send', async () => {
  let sends = 0;
  const chat = { from: 'owner@xmpp.zoom.us/resource', identity: { user: { accountId: 'account' } },
    directEncryptionMode: async () => 'ace',
    sendIq: async () => { sends++; },
    request: async path => path.endsWith('/search/contact')
      ? { errorCode: 0, result: [{ snsEmail: 'member@example.test', userId: 'member',
        jid: 'member@xmpp.zoom.us', displayName: 'Member', isSameAccount: 1,
        externalFriend: false, inactiveStatus: 0, type: 0 }] }
      : { vcardUsers: [{ userId: 'Member', jid: 'member@xmpp.zoom.us',
        email: 'member@example.test', organization: ['account'] }] },
  };
  await assert.rejects(runChat({ openChat: async () => chat }, 'dm-send',
    { email: 'member@example.test', text: 'Must not be transmitted' }),
    error => error.code === 'UNSUPPORTED_ENCRYPTION' && error.details.outcome === 'not_sent');
  assert.equal(sends, 0);
});

test('lost direct acknowledgement followed by denied readback stays unknown without replay', async () => {
  let sends = 0;
  const chat = { from: 'owner@xmpp.zoom.us/resource', identity: { user: { accountId: 'account' } },
    directEncryptionMode: async () => 'none', getDisplayName: async () => 'Owner',
    sendIq: async () => { sends++; throw new AppError('WRITE_UNCONFIRMED', 'Acknowledgement lost'); },
    request: async path => {
      if (path.endsWith('/search/contact')) return { errorCode: 0, result: [{
        snsEmail: 'member@example.test', userId: 'member', jid: 'member@xmpp.zoom.us',
        displayName: 'Member', isSameAccount: 1, externalFriend: false, inactiveStatus: 0, type: 0,
      }] };
      if (path.endsWith('/vcard/batch')) return { vcardUsers: [{
        userId: 'Member', jid: 'member@xmpp.zoom.us', email: 'member@example.test', organization: ['account'],
      }] };
      throw new AppError('FORBIDDEN', 'Readback unavailable');
    },
  };
  await assert.rejects(runChat({ openChat: async () => chat }, 'dm-send',
    { email: 'member@example.test', text: 'Uncertain write' }),
    error => error.code === 'WRITE_UNCONFIRMED' && error.details.outcome === 'unknown'
      && error.details.id && error.details.peerJid === 'member@xmpp.zoom.us');
  assert.equal(sends, 1);
});

test('unavailable reply totals stay unknown while native zero and positive totals remain accurate', () => {
  const wire = { text: 'A root with a separately fetched reply', messageType: '17', rawRichText: null };
  assert.equal(messageContent({}, wire).replyCount, null);
  assert.equal(messageContent({ comment_total: 0 }, wire).replyCount, 0);
  assert.equal(messageContent({ comment_total: 2 }, wire).replyCount, 2);
  assert.equal(messageContent({ comment_total: -1 }, wire).replyCount, null);
});

test('native rich runs and link metadata survive while unsupported content stays explicit and raw', () => {
  const rich = { type: 'Page', style: {}, children: [{ type: 'Paragraph', content: [
    { data: 'Bold café ', attrs: { bold: true } },
    { data: { link: { source: { type: 'link', link: 'https://zoom.us', text: 'Zoom' } } }, attrs: { italic: true } },
  ] }] };
  const wire = { text: 'Bold café Zoom', messageType: '17', rawRichText: JSON.stringify(rich) };
  const supported = messageContent({ message: '<message>original wire</message>' }, wire);
  assert.deepEqual(supported.richText, rich);
  assert.equal(supported.contentCoverage.complete, true);
  assert.equal(supported.contentCoverage.lossless, false);
  rich.children.push({ type: 'UnmappedAttachment', fileId: 'native-file-id' });
  const unsupported = messageContent({ message: '<message>original wire</message>' }, { ...wire, rawRichText: JSON.stringify(rich) });
  assert.equal(unsupported.contentComplete, false);
  assert.deepEqual(unsupported.richText.children[1], rich.children[1]);
  assert.equal(unsupported.raw.xml, '<message>original wire</message>');
  assert.equal(messageContent({}, { ...wire, rawRichText: null }).contentComplete, false);
  assert.equal(messageContent({}, { ...wire, rawRichText: '{malformed' }).raw.zmrt, '{malformed');
});

test('direct exact links reject unrelated actors and non-native encryption before history', async () => {
  const makeLink = sid2 => `https://zoom.us/launch/chat/v2/${Buffer.from(JSON.stringify({
    sid: 'member@xmpp.zoom.us', sid2, mid: 'native-id', time: 10,
  })).toString('base64')}`;
  let historyRequests = 0;
  const session = { openChat: async () => ({
    from: 'owner@xmpp.zoom.us/resource', identity: { user: { accountId: 'account' } },
    async request(path) {
      if (path.startsWith('/history/')) historyRequests++;
      return { vcardUsers: [{ jid: 'member@xmpp.zoom.us', userId: 'Member', organization: ['account'] }] };
    },
    directEncryptionMode: async () => 'ace',
  }) };
  await assert.rejects(runChat(session, 'message', { link: makeLink('unrelated@xmpp.zoom.us') }), { code: 'UNSUPPORTED_DIRECT_PAIR' });
  await assert.rejects(runChat(session, 'message', { link: makeLink('owner@xmpp.zoom.us') }), { code: 'UNSUPPORTED_ENCRYPTION' });
  assert.equal(historyRequests, 0);
});

test('composed reader fetches unknown-count threads and retains messages when author cards are unavailable', async () => {
  const jid = 'channel@conference.xmpp.zoom.us';
  const root = { id: 'root', timestamp: 10, from: 'owner@xmpp.zoom.us', to: jid, type: 'groupchat',
    text: 'Root', replyTo: null, replyCount: null, contentComplete: true };
  const reply = { id: 'reply', timestamp: 20, from: 'member@xmpp.zoom.us', to: jid, type: 'groupchat',
    text: 'Actual reply', replyTo: { id: 'root', owner: 'owner', thread: '10' }, replyCount: null, contentComplete: true };
  const session = { openChat: async () => ({
    from: 'owner@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
    identity: { user: { accountId: 'account' } },
    async request(path) {
      if (path === '/xms/channel/infos') return { data: { [jid]: { name: 'Private', account: 'account', type: 2, e2e: '0' } } };
      if (path === '/history/fetch2') return { data: [{ session: jid, messages: [{ message: 'root' }] }] };
      if (path === '/xms/thread/fetch') return { data: [{ session: jid, thread: 10, thread_id: 'root', message: 'root', total: 1, comments: [{ msg: 'reply' }] }] };
      if (path === '/api/v1/ucs/contact/vcard/batch') return { vcardUsers: [], unknownUsers: ['owner@xmpp.zoom.us', 'member@xmpp.zoom.us'] };
      throw new Error(`Unexpected request ${path}`);
    },
    async parseMessages(records) {
      return records.map(record => ({ ...(record.message === 'root' ? root : reply), replyCount: record.comment_total ?? null }));
    },
  }) };
  const result = await runChat(session, 'conversation', { channel: jid });
  assert.deepEqual(result.messages.map(message => message.id), ['reply', 'root']);
  assert.equal(result.messages.find(message => message.id === 'root').replyCount, 1);
  assert.deepEqual(result.threads[0].replyIds, ['reply']);
  assert.equal(result.coverage.threadsComplete, true);
  assert.equal(result.coverage.profilesComplete, false);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.profiles[0].items.map(item => item.status), ['unresolved', 'unresolved']);
});
