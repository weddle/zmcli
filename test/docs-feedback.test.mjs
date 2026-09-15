import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { runDocs, validateDocsOptions } from '../src/docs.mjs';
import { AppError } from '../src/session.mjs';

const identity = { user: { userId: 'receiver', accountId: 'tenant' } };
const notification = (id, extra = {}) => ({ notificationId: id, templateType: 'docComment',
  templateData: JSON.stringify({ fromType: 'mention', commentContent: ['private fixture text'] }),
  sender: { id: 'sender', name: 'private display name' }, fileId: 'doc',
  link: 'https://docs.zoom.us/doc/doc?comment=thread&commentReply=reply',
  createTime: '2026-09-10T12:00:00Z', read: false, ...extra });
const notificationGroup = (latestNotification, extra = {}) => ({
  fileId: latestNotification.fileId,
  fileType: 'doc',
  icon: '',
  title: 'Fixture document',
  fileClusterApiPrefix: 'https://us01docs.zoom.us',
  latestNotification,
  unreadCount: latestNotification.read === false ? 1 : 0,
  notificationLevel: 'forMe',
  hasFilePermission: true,
  file: { id: latestNotification.fileId, title: 'Fixture document', fileType: 'doc' },
  ...extra,
});
function inboxSession(responses) {
  const calls = [];
  return { identity, calls, request: async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/file/files/user/vcard') return { isExternal: false,
      vcard: { userId: options.body.userId, nickName: 'native profile', email: 'private@example.test' } };
    assert.ok(path.startsWith('/api/notification'));
    return responses.shift();
  } };
}

test('regional native content mention links resolve their block fragment without allowing unrelated origins', async () => {
  const session = inboxSession([{ notifications: [
    notification('content', { templateType: 'docMention', link: 'https://us01docs.zoom.us/doc/doc?notificationId=content#block' }),
    notification('foreign', { link: 'https://unrelated.zoom.us/doc/doc#foreign' }),
  ] }]);
  session.identity = { ...identity, homeClusterApiPrefix: 'https://us01docs.zoom.us/' };
  const result = await runDocs(session, 'notifications', { id: 'doc' });
  assert.equal(result.items[0].category, 'content-mention');
  assert.equal(result.items[0].target.blockId, 'block');
  assert.deepEqual(result.unsupportedItems.map(item => item.id), ['foreign']);
});
test('global grouped envelope stays distinct from document For-me and preserves continuation', async () => {
  const session = inboxSession([{
    fileNotifications: [notificationGroup(notification('global'))],
    nextPagingToken: 'next',
    unreadCount: 1,
  }]);
  const result = await runDocs(session, 'notifications', { limit: 2 });
  assert.equal(result.source, '/api/notification/groupByFile');
  assert.equal(result.scope, 'native-global-notification-center');
  assert.equal(result.items[0].category, 'comment-reply');
  assert.equal(result.items[0].mentionScope, 'unknown');
  assert.equal(result.nativeUnreadCount, 1);
  assert.ok(result.nextCursor);
  assert.equal(session.calls[0].path, '/api/notification/groupByFile?limit=2&listType=all');
  assert.equal(session.calls[0].options.body, undefined);
});

test('structured notification person elements expose mentions without using reply metadata', async () => {
  const row = notification('structured', {
    templateData: JSON.stringify({
      fromType: 'comment',
      commentContentElements: [
        { type: 'text', text: '𝄞 Please review ' },
        { type: 'person', text: 'Canonical Person', meta: {
          mentionId: 'mention', userId: 'member', name: 'Canonical Person', notify: true,
          offset: 17, length: 16, units: 'UTF-16',
        } },
        { type: 'text', text: '.' },
      ],
    }),
  });
  const session = inboxSession([{ fileNotifications: [notificationGroup(row)], nextPagingToken: '', unreadCount: 1 }]);
  const result = await runDocs(session, 'notifications', { limit: 2 });
  const item = result.items[0];
  assert.equal(item.category, 'comment-reply');
  assert.equal(item.nativeMentionKind, 'comment');
  assert.equal(item.mentionScope, 'direct');
  assert.deepEqual(item.mentions, [{
    mentionId: 'mention', userId: 'member', name: 'Canonical Person', notify: true,
    offset: 17, length: 16, units: 'UTF-16', scope: 'direct',
    notificationExpectation: 'requested-not-delivery-proof',
  }]);
  assert.deepEqual(item.context, JSON.parse(row.templateData));
  assert.deepEqual(item.raw, row);
  assert.equal(result.coverage.content.status, 'incomplete');
  assert.ok(result.coverage.content.reasons.includes('LATEST_NOTIFICATION_PER_DOCUMENT_ONLY'));
  assert.equal(result.coverage.mentions.status, 'incomplete');
  assert.ok(result.coverage.mentions.reasons.includes('STRUCTURED_MENTION_DATA_NOT_AVAILABLE_FOR_ALL_NOTIFICATION_TYPES'));
});
test('Docs notifications mirror the observed UI feed contract', async () => {
  const records = [
    notification('older', { sender: { id: 'actor-older', name: 'Older actor' },
      link: 'https://docs.zoom.us/doc/doc?comment=thread&commentReply=older-reply', read: true }),
    notification('newer', { sender: { id: 'actor-newer', name: 'Newer actor' },
      templateType: 'docMention', link: 'https://docs.zoom.us/doc/doc?blockId=block-newer', read: false }),
  ];
  const calls = [];
  let page = 0;
  const session = { identity, request: async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/file/files/user/vcard') {
      return { isExternal: false, vcard: { userId: options.body.userId, nickName: `profile-${options.body.userId}` } };
    }
    const url = new URL(`https://docs.zoom.us${path}`);
    assert.equal(url.pathname, '/api/notification/groupByFile');
    assert.equal(url.searchParams.get('limit'), '2');
    assert.equal(url.searchParams.get('listType'), 'all');
    assert.equal(url.searchParams.get('fileId'), null);
    if (page++ === 0) {
      assert.equal(url.searchParams.get('pagingToken'), null);
      assert.doesNotMatch(path, /(?:^|&)pagingToken=/);
      return {
        fileNotifications: records.map(notificationGroup),
        nextPagingToken: 'cursor +/= token',
        unreadCount: 1,
      };
    }
    assert.match(path, /[?&]pagingToken=cursor\+%2B%2F%3D\+token(?:&|$)/);
    assert.equal(url.searchParams.get('pagingToken'), 'cursor +/= token');
    return { fileNotifications: [], nextPagingToken: '', unreadCount: 0 };
  } };
  const result = await runDocs(session, 'notifications', { limit: 2 });
  assert.deepEqual(result.items.map(item => item.id), ['older', 'newer']);
  assert.equal(result.items[0].readState, 'read');
  assert.deepEqual(result.items[0].target, {
    documentId: 'doc', blockId: null, threadId: 'thread', commentId: 'older-reply',
  });
  assert.equal(result.items[0].category, 'comment-reply');
  assert.equal(result.items[0].actor.identity.id, 'actor-older');
  assert.equal(result.items[0].actor.identity.provenance.source, '/api/file/files/user/vcard');
  assert.equal(result.items[1].readState, 'unread');
  assert.deepEqual(result.items[1].target, {
    documentId: 'doc', blockId: 'block-newer', threadId: null, commentId: null,
  });
  assert.equal(result.items[1].category, 'content-mention');
  assert.equal(result.nativeUnreadCount, 1);
  assert.ok(result.nextCursor);
  assert.equal(calls.filter(call => call.path === '/api/file/files/user/vcard').length, 2);
  const terminal = await runDocs(session, 'notifications', { limit: 2, cursor: result.nextCursor });
  assert.deepEqual(terminal.items, []);
  assert.equal(terminal.nextCursor, null);
  assert.equal(terminal.nativeUnreadCount, 0);
  assert.equal(page, 2);

  const unreadSession = inboxSession([{
    fileNotifications: [notificationGroup(records[1])],
    nextPagingToken: '',
    unreadCount: 1,
  }]);
  const unread = await runDocs(unreadSession, 'notifications', { state: 'unread', limit: 2 });
  assert.equal(unreadSession.calls[0].path, '/api/notification/groupByFile?limit=2&listType=unread');
  assert.deepEqual(unread.items.map(item => item.id), ['newer']);
  assert.equal(unread.filterLocation, 'native-listType');

  const documentSession = inboxSession([{ notifications: [notification('document')], unreadCount: 1 }]);
  const document = await runDocs(documentSession, 'notifications', { id: 'doc', limit: 1 });
  const documentRequest = documentSession.calls.find(call => call.path.startsWith('/api/notification/forMe?'));
  assert.ok(documentRequest);
  const documentUrl = new URL(`https://docs.zoom.us${documentRequest.path}`);
  assert.equal(documentUrl.pathname, '/api/notification/forMe');
  assert.equal(documentUrl.searchParams.get('fileId'), 'doc');
  assert.equal(documentUrl.searchParams.get('limit'), '1');
  assert.equal(documentUrl.searchParams.get('pagingToken'), '');
  assert.equal(document.items[0].id, 'document');
});

test('malformed notification records remain unsupported without becoming feed items', async () => {
  const session = inboxSession([{ notifications: [
    { notificationId: 'valid', templateType: 'docComment', templateData: '{}',
      sender: { id: 'sender' }, fileId: 'doc', link: 'https://docs.zoom.us/doc/doc',
      createTime: '2026-09-10T12:00:00Z', read: false },
    { notificationId: 'bad id', templateType: 'docComment' },
    null,
  ] }]);
  const result = await runDocs(session, 'notifications', { id: 'doc' });
  assert.deepEqual(result.items.map(item => item.id), ['valid']);
  assert.deepEqual(result.unsupportedItems.map(item => item.reason ?? item.reasons?.[0]), ['MALFORMED_NOTIFICATION_ID', 'MALFORMED_NOTIFICATION_ID']);
});
test('global notification envelopes require native groups and unreadCount', async () => {
  for (const response of [
    { notifications: [notification('legacy')], unreadCount: 1 },
    { fileNotifications: [notificationGroup(notification('global'))] },
  ]) {
    const session = inboxSession([response]);
    await assert.rejects(runDocs(session, 'notifications', {}), error => {
      assert.equal(error.code, 'UNSUPPORTED_RESPONSE');
      assert.equal(error.details.operation, 'docs.notifications');
      assert.equal(error.details.phase, 'decode');
      return true;
    });
  }
});

test('malformed global notification groups remain unsupported beside usable groups', async () => {
  const session = inboxSession([{
    fileNotifications: [notificationGroup(notification('valid')), { fileId: 'doc' }],
    nextPagingToken: '',
    unreadCount: 1,
  }]);
  const result = await runDocs(session, 'notifications', {});
  assert.deepEqual(result.items.map(item => item.id), ['valid']);
  assert.equal(result.unsupportedItems[0].reason, 'MALFORMED_NOTIFICATION_GROUP');
});

test('global HTTP 403 remains a typed notification error', async () => {
  const session = { identity, request: async path => {
    assert.equal(path, '/api/notification/groupByFile?limit=50&listType=all');
    throw new AppError('FORBIDDEN', 'access denied', { status: 403 });
  } };
  await assert.rejects(runDocs(session, 'notifications', {}), error => {
    assert.equal(error.code, 'FORBIDDEN');
    assert.equal(error.details.operation, 'docs.notifications');
    assert.equal(error.details.phase, 'native-inbox');
    assert.equal(error.details.cause.code, 'FORBIDDEN');
    assert.equal(error.details.cause.status, 403);
    return true;
  });
});


test('notification auth, access, approval, and cancellation failures stay typed', async () => {
  for (const code of ['AUTH_REQUIRED', 'ACCESS_DENIED', 'PROVIDER_APPROVAL_REQUIRED', 'REQUEST_CANCELLED']) {
    const session = { identity, request: async path => {
      assert.match(path, /^\/api\/notification(?:\/forMe|\/groupByFile)?\?/);
      throw new AppError(code, 'sanitized failure');
    } };
    await assert.rejects(runDocs(session, 'notifications', { id: code === 'ACCESS_DENIED' ? 'doc' : undefined }), error => {
      assert.equal(error.code, code);
      assert.equal(error.details.operation, 'docs.notifications');
      assert.equal(error.details.phase, 'native-inbox');
      return true;
    });
  }
});



test('a native limit violation stays bounded and retains excess records as unsupported', async () => {
  const session = inboxSession([{ notifications: [notification('one'), notification('two')], nextPagingToken: 'next' }]);
  const result = await runDocs(session, 'notifications', { id: 'doc', limit: 1 });
  assert.deepEqual(result.items.map(item => item.id), ['one']);
  assert.equal(result.unsupportedItems[0].id, 'two');
  assert.equal(result.nextCursor, null);
  assert.ok(result.coverage.pagination.reasons.includes('NATIVE_LIMIT_NOT_RESPECTED'));
});

test('native unread filters only evidenced state and preserves unknown records without comment scans', async () => {
  const session = inboxSession([{ notifications: [notification('unread'), notification('read', { read: true }),
    notification('unknown', { read: undefined, templateType: 'futureType' })] }]);
  const result = await runDocs(session, 'notifications', { id: 'doc', state: 'unread' });
  assert.deepEqual(result.items.map(item => item.id), ['unread']);
  assert.equal(result.items[0].category, 'comment-reply');
  assert.deepEqual(result.items[0].target, { documentId: 'doc', blockId: null, threadId: 'thread', commentId: 'reply' });
  assert.equal(result.items[0].actor.identity.provenance.source, '/api/file/files/user/vcard');
  assert.equal(result.items[0].actor.observations[0].relationship, 'unknown');
  assert.equal(result.unsupportedItems[0].id, 'unknown');
  assert.ok(result.unsupportedItems[0].reasons.includes('UNKNOWN_READ_STATE'));
  assert.equal(result.coverage.category.exhaustive, false);
  assert.equal(result.readEffects.explicitReadMarkerSent, false);
});

test('notification pagination stops on overlap and refuses actor or tenant reuse', async () => {
  const session = inboxSession([{ notifications: [notification('one')], nextPagingToken: 'next' },
    { notifications: [notification('one')], nextPagingToken: 'later' }]);
  const first = await runDocs(session, 'notifications', { id: 'doc', limit: 1 });
  const foreign = { ...session, identity: { user: { userId: 'receiver', accountId: 'other' } } };
  const before = session.calls.length;
  await assert.rejects(runDocs(foreign, 'notifications', { id: 'doc', limit: 1, cursor: first.nextCursor }), { code: 'INVALID_INPUT' });
  assert.equal(session.calls.length, before);
  const next = await runDocs(session, 'notifications', { id: 'doc', limit: 1, cursor: first.nextCursor });
  assert.equal(next.nextCursor, null);
  assert.deepEqual(next.items, []);
  assert.ok(next.coverage.pagination.reasons.includes('REPEATED_NOTIFICATION_ID'));
});
test('notification pagination rejects a repeated native cursor without fallback', async () => {
  const session = inboxSession([{ notifications: [notification('first')], nextPagingToken: 'same' },
    { notifications: [], nextPagingToken: 'same' }]);
  const first = await runDocs(session, 'notifications', { id: 'doc', limit: 1 });
  const next = await runDocs(session, 'notifications', { id: 'doc', limit: 1, cursor: first.nextCursor });
  assert.equal(next.nextCursor, null);
  assert.ok(next.coverage.pagination.reasons.includes('NONADVANCING_NATIVE_CURSOR'));
  assert.equal(session.calls.filter(call => call.path.startsWith('/api/notification/forMe')).length, 2);
});

test('today spans the actual DST civil day and notification continuation freezes the interval', async () => {
  const session = inboxSession([{ notifications: [], nextPagingToken: 'next' }, { notifications: [] }]);
  const options = { id: 'doc', since: 'today', timezone: 'America/New_York', commandStartedAt: Date.parse('2026-03-08T15:00:00Z') };
  const first = await runDocs(session, 'notifications', options);
  assert.equal(first.timeRange.since, '2026-03-08T05:00:00.000Z');
  assert.equal(first.timeRange.until, '2026-03-09T04:00:00.000Z');
  const next = await runDocs(session, 'notifications', { ...options, commandStartedAt: Date.parse('2026-03-09T15:00:00Z'), cursor: first.nextCursor });
  assert.deepEqual(next.timeRange, first.timeRange);
});

test('invalid or reversed dates fail in pre-auth validation', () => {
  for (const options of [{ since: '2026-02-30T00:00:00Z' }, { since: 'today' },
    { since: '2026-09-10T12:00:00' }, { since: '2026-09-10T12:00:00Z', until: '2026-09-09T12:00:00Z' }]) {
    assert.throws(() => validateDocsOptions('notifications', options), { code: 'INVALID_INPUT' });
  }
});

test('strict native inbox failure preserves log-safe partial coverage without private content', async () => {
  const session = inboxSession([{ notifications: [notification('one')] }]);
  await assert.rejects(runDocs(session, 'notifications', { id: 'doc', strict: true }), error => {
    assert.equal(error.code, 'INCOMPLETE_COVERAGE');
    assert.deepEqual(error.details.partial.itemIds, ['one']);
    assert.equal(error.details.partial.coverage.category.status, 'unknown');
    assert.doesNotMatch(JSON.stringify(error.details), /private fixture|private display|private@example/);
    return true;
  });
});

test('a grouped global HTTP 500 becomes typed unavailable while document For-me remains working', async () => {
  const calls = [];
  const session = { identity, request: async (path, options) => {
    calls.push(path);
    if (path.startsWith('/api/notification/groupByFile?')) {
      throw new AppError('HTTP_ERROR', 'private native body', { status: 500, attempts: 3 });
    }
    if (path.startsWith('/api/notification/forMe?')) return { notifications: [notification('doc')] };
    if (path === '/api/file/files/user/vcard') return { isExternal: false, vcard: { userId: options.body.userId } };
    throw new Error(`Unexpected fallback request ${path}`);
  } };
  const global = await runDocs(session, 'notifications', {});
  assert.equal(global.availability, 'unavailable');
  assert.equal(global.disposition, 'source-unavailable');
  assert.deepEqual(global.unavailable, {
    source: '/api/notification/groupByFile', provider: { status: 500, result: null, attempts: 3 },
    noFallback: true, reason: 'NATIVE_NOTIFICATION_SOURCE_UNAVAILABLE',
  });
  assert.equal(global.coverage.pagination.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(global), /private native body/);
  const document = await runDocs(session, 'notifications', { id: 'doc' });
  assert.equal(document.scope, 'native-document-for-me');
  assert.equal(document.items[0].category, 'comment-reply');
  assert.equal(calls.filter(path => path.startsWith('/api/notification/groupByFile?')).length, 1);
  assert.equal(calls.filter(path => path.startsWith('/api/notification/forMe?')).length, 1);
});

test('a provider rejection after bounded retries retains sanitized global evidence', async () => {
  const calls = [];
  const session = { identity, request: async path => {
    calls.push(path);
    throw new AppError('HTTP_ERROR', 'private provider body', { status: 503, result: 9, attempts: 3 });
  } };
  const result = await runDocs(session, 'notifications', {});
  assert.deepEqual(result.unavailable.provider, { status: 503, result: 9, attempts: 3 });
  assert.equal(result.unavailable.noFallback, true);
  assert.deepEqual(calls, ['/api/notification/groupByFile?limit=50&listType=all']);
});

test('Recent preserves native ID ranking while reconciling current titles independently', async () => {
  const files = [{ id: 'older-modification', title: 'indexed title', fileType: 'doc' }, { id: 'newer-modification', title: 'second', fileType: 'doc' }];
  const session = { identity, request: async path => path.startsWith('/api/file/recent')
    ? { recentFiles: files.map((file, index) => ({ file, operationType: 'view', lastOperatedTime: String(200 - index), ancestors: [{ id: 'parent' }] })) }
    : { successItems: [...files].reverse().map(file => ({ ...file, title: file.id === 'older-modification' ? 'current title' : file.title })) } };
  const result = await runDocs(session, 'recent', {});
  assert.deepEqual(result.items.map(item => item.id), files.map(file => file.id));
  assert.equal(result.items[0].indexedTitle, 'indexed title');
  assert.equal(result.items[0].currentTitle, 'current title');
  assert.equal(result.items[0].titleReconciliation, 'changed');
  assert.equal(result.items[0].operationType, 'view');
  assert.equal(result.order, 'native-recent');
});

test('modified ordering is local over explicit IDs and missing IDs remain partial', async () => {
  const session = { identity, request: async () => ({ successItems: [
    { id: 'older', fileType: 'doc', updatedInfo: { time: '2026-09-09T00:00:00Z' } },
    { id: 'newer', fileType: 'doc', updatedInfo: { time: '2026-09-10T00:00:00Z' } },
  ] }) };
  const result = await runDocs(session, 'modified', { ids: 'older,newer,missing' });
  assert.deepEqual(result.items.map(item => item.id), ['newer', 'older']);
  assert.equal(result.scope, 'explicit-document-ids');
  assert.equal(result.unsupportedItems[0].id, 'missing');
  assert.equal(result.coverage.content.status, 'incomplete');
});

function treeSession() {
  const blocks = { doc: { id: 'doc', type: 'BLOCK_TYPE_PAGE', seq: 'a', version: 1, content: { title: 'title' } },
    embedded: { id: 'embedded', type: 'BLOCK_TYPE_UNSUPPORTED', seq: 'a', parentId: 'doc', content: { title: '[]' } } };
  return { identity, request: async path => {
    if (path === '/api/file/files/action/batch_get') return { successItems: [{ id: 'doc', fileType: 'doc', title: 'title', parentId: 'my-docs' }] };
    if (path.startsWith('/api/page/')) return { content: { data: Buffer.from(JSON.stringify({ blocks })).toString('base64') } };
    if (path.endsWith('batch_get_children')) return { successItems: [{ parentId: 'doc', children: [{ id: 'unread', fileType: 'database' }] }] };
    throw Error('Unexpected endpoint');
  } };
}

test('tree exposes unread descendants and unsupported blocks separately from loaded pages', async () => {
  const result = await runDocs(treeSession(), 'read', { id: 'doc' });
  assert.deepEqual(result.unresolvedDescendants.knownUnreadPageIds, ['unread']);
  assert.equal(result.loadedPages[0].pageId, 'doc');
  assert.ok(result.unsupportedItems.some(item => item.blockId === 'embedded'));
  assert.equal(result.coverage.content.status, 'incomplete');
  await assert.rejects(runDocs(treeSession(), 'read', { id: 'doc', strict: true }), { code: 'INCOMPLETE_COVERAGE' });
});

test('folder discovery uses bounded native parent children and keeps nonfolders distinct', async () => {
  const session = { identity, request: async path => path === '/api/file/my_space'
    ? { mySpace: { id: 'space', fileType: 'space' } }
    : { children: [{ id: 'folder', fileType: 'folder' }, { id: 'doc', fileType: 'doc' }], nextPageToken: 'more' } };
  const result = await runDocs(session, 'folders', { limit: 2 });
  assert.deepEqual(result.items.map(item => item.id), ['folder']);
  assert.deepEqual(result.otherChildren.map(item => item.id), ['doc']);
  assert.equal(result.coverage.pagination.status, 'incomplete');
  assert.equal(result.coverage.category.exhaustive, false);
});

test('permission batches bound concurrency and retain successes alongside per-document failures', async () => {
  let active = 0, maximum = 0;
  const session = { identity, request: async (path, options) => {
    active++; maximum = Math.max(active, maximum);
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (path === '/api/file/files/action/batch_get') {
        const id = options.body.ids[0];
        if (id === 'forbidden') throw new AppError('FORBIDDEN', 'not accessible');
        return { successItems: [{ id, fileType: 'doc', parentId: 'my-docs', fileClusterApiPrefix: 'https://docs.zoom.us' }] };
      }
      return {};
    } finally { active--; }
  } };
  const result = await runDocs(session, 'permissions-batch', { ids: 'one,forbidden,two', concurrency: 2 });
  assert.ok(maximum <= 2);
  assert.deepEqual(result.items.map(item => item.status), ['received', 'failed', 'received']);
  assert.equal(result.items[0].result.visibility.effective, 'unknown');
  assert.equal(result.items[0].result.collaborators.complete, false);
  assert.equal(result.coverage.content.status, 'incomplete');
});

test('cancelled permission batches do not start queued documents', async () => {
  const controller = new AbortController();
  let calls = 0;
  const session = { identity, request: async () => { calls++; controller.abort(); throw new AppError('REQUEST_CANCELLED', 'cancelled'); } };
  const result = await runDocs(session, 'permissions-batch', { ids: 'one,two,three', concurrency: 1, signal: controller.signal });
  assert.equal(calls, 1);
  assert.deepEqual(result.items.map(item => item.status), ['cancelled', 'cancelled', 'cancelled']);
});

test('Recent and folders enforce native page bounds and preserve unsupported overflow', async () => {
  const recent = { identity, request: async path => path.startsWith('/api/file/recent')
    ? { recentFiles: [{ file: { id: 'one', fileType: 'doc' } }, { file: { id: 'excess', fileType: 'doc' } }], nextPagingToken: 'next' }
    : { successItems: [{ id: 'one', fileType: 'doc' }] } };
  const first = await runDocs(recent, 'recent', { limit: 1 });
  assert.deepEqual(first.items.map(item => item.id), ['one']);
  assert.equal(first.nextCursor, null);
  assert.ok(first.unsupportedItems.some(item => item.reason === 'NATIVE_LIMIT_NOT_RESPECTED'));
  const folders = { identity, request: async path => path === '/api/file/my_space'
    ? { mySpace: { id: 'space', fileType: 'space' } }
    : { children: [{ id: 'one', fileType: 'folder' }, { id: 'excess', fileType: 'folder' }], nextPageToken: 'next' } };
  const second = await runDocs(folders, 'folders', { limit: 1 });
  assert.deepEqual(second.items.map(item => item.id), ['one']);
  assert.equal(second.nextCursor, null);
  assert.equal(second.coverage.content.status, 'incomplete');
  assert.ok(second.unsupportedItems.some(item => item.reason === 'NATIVE_LIMIT_NOT_RESPECTED'));
});

test('malformed Recent rows and unknown folder child types remain visible as incomplete metadata', async () => {
  const recent = { identity, request: async () => ({ recentFiles: [null] }) };
  const first = await runDocs(recent, 'recent', {});
  assert.equal(first.unsupportedItems[0].reason, 'MALFORMED_RECENT_FILE');
  assert.equal(first.coverage.content.status, 'incomplete');
  const folders = { identity, request: async path => path === '/api/file/my_space'
    ? { mySpace: { id: 'space', fileType: 'space' } }
    : { children: [{ id: 'future', fileType: 'future-native-type' }], nextPageToken: '' } };
  const second = await runDocs(folders, 'folders', {});
  assert.equal(second.otherChildren[0].id, 'future');
  assert.equal(second.unsupportedItems[0].reason, 'UNSUPPORTED_CHILD_FILE_TYPE');
  assert.equal(second.coverage.content.status, 'incomplete');
});

test('unread child metadata leaves that child descendant scope unknown in normal and strict reads', async () => {
  const session = treeSession(), request = session.request;
  session.request = async (path, options) => {
    if (path.endsWith('batch_get_children')) return { successItems: [{ parentId: 'doc', children: [{ id: 'hidden', fileType: 'doc' }] }] };
    if (path.endsWith('batch_get') && options.body.ids[0] === 'hidden') throw new AppError('FORBIDDEN', 'unavailable');
    return request(path, options);
  };
  const result = await runDocs(session, 'read', { id: 'doc' });
  assert.deepEqual(result.unresolvedDescendants.unknownBelowPageIds, ['hidden']);
  assert.equal(result.coverage.pagination.status, 'incomplete');
  await assert.rejects(runDocs(session, 'read', { id: 'doc', strict: true }), error => {
    assert.deepEqual(error.details.partial.unresolvedDescendants.unknownBelowPageIds, ['hidden']);
    assert.equal(error.details.partial.loadedPages[0].pageId, 'doc');
    return error.code === 'INCOMPLETE_COVERAGE';
  });
});

test('discussion content coverage rejects unknown rich content and resolves both thread and reply authors', async () => {
  const session = treeSession(), request = session.request;
  session.request = async (path, options) => {
    if (path.startsWith('/api/comment/discussions:batchGet')) return { nextCursor: '', users: {},
      threads: [{ thread: { threadId: 'thread', fileId: 'doc', rootBlockId: 'doc', threadStatus: 'open',
        createdBy: 'thread-author', commentType: 2, commentCount: '1', createAt: '100' },
        comments: [{ comment: { commentId: 'reply', threadId: 'thread', createdBy: 'reply-author',
          content: '{"text":"preserved","futureRichContent":true}', createAt: '200' } }], nextCursor: '' }] };
    if (path === '/api/file/files/user/vcard') return { isExternal: false,
      vcard: { userId: options.body.userId, nickName: `profile-${options.body.userId}` } };
    return request(path, options);
  };
  const result = await runDocs(session, 'discussions', { id: 'doc' });
  assert.equal(result.coverage.pagination.status, 'complete');
  assert.equal(result.coverage.content.status, 'incomplete');
  assert.equal(result.items[0].actor.identity.displayName, 'profile-thread-author');
  assert.equal(result.items[0].comments[0].actor.identity.displayName, 'profile-reply-author');
  assert.equal(result.items[0].actor.observations[0].relationship, 'unknown');
  assert.equal(result.unsupportedItems[0].id, 'reply');
});

function permissionSession(permission, hook) {
  return { identity, request: async (path, options) => {
    if (path.endsWith('batch_get')) return { successItems: [{ id: options.body.ids[0], fileType: 'doc',
      parentId: 'my-docs', fileClusterApiPrefix: 'https://docs.zoom.us' }] };
    const replacement = hook?.(path, options);
    if (replacement !== undefined) return replacement;
    return path.endsWith('/permission') ? permission : { ancestorPermissionInfos: [] };
  } };
}

test('unknown link roles and explicitly absent current grants cannot establish visibility', async () => {
  const unknown = await runDocs(permissionSession({ linkAccess: {
    settingItem: 'linkPermissionSetting', role: { newRole: 'future-role' },
  } }), 'permissions', { id: 'doc' });
  assert.equal(unknown.visibility.effective, 'unknown');
  assert.equal(unknown.visibility.rawFlags.linkAccess.role.newRole, 'future-role');
  const noCurrent = await runDocs(permissionSession({ currentLinkAccess: null, linkAccess: {
    settingItem: 'linkPermissionSetting', role: { newRole: 'viewer' },
  } }), 'permissions', { id: 'doc' });
  assert.equal(noCurrent.visibility.effective, 'unknown');
  const known = await runDocs(permissionSession({ currentLinkAccess: {
    settingItem: 'accountPermissionSetting', role: { newRole: 'viewer' },
  } }), 'permissions', { id: 'doc' });
  assert.equal(known.visibility.effective, 'account');
});

test('rate-limited sharing source retains sibling success and sanitized retry evidence', async () => {
  const session = permissionSession({}, path => {
    if (path.endsWith('/permission')) throw new AppError('RATE_LIMITED', 'private response', { attempts: 3, retryAfterMs: 120000, status: 429 });
  });
  const result = await runDocs(session, 'permissions-batch', { ids: 'doc' });
  const sources = result.items[0].result.sources;
  assert.equal(sources.permission.code, 'RATE_LIMITED');
  assert.equal(sources.permission.attempts, 3);
  assert.equal(sources.permission.retryAfterMs, 120000);
  assert.equal(sources.ancestors.status, 'received');
  assert.equal(result.coverage.content.status, 'incomplete');
  assert.doesNotMatch(JSON.stringify(result), /private response/);
});

test('cancellation after one sharing read retains its result and cancels queued documents', async () => {
  const controller = new AbortController();
  const session = permissionSession({ collaborators: [] }, path => {
    if (path.includes('/ancestors/')) {
      controller.abort();
      throw new AppError('REQUEST_CANCELLED', 'cancelled');
    }
  });
  const result = await runDocs(session, 'permissions-batch', { ids: 'one,two', concurrency: 1, signal: controller.signal });
  assert.deepEqual(result.items.map(item => item.status), ['cancelled', 'cancelled']);
  assert.equal(result.items[0].result.sources.permission.status, 'received');
  assert.equal(result.items[0].result.sources.ancestors.status, 'cancelled');
});

test('identity cancellation stops later native lookups and unknown tenants remain explicit', async () => {
  const controller = new AbortController();
  let calls = 0;
  const session = { identity, request: async (path, options) => {
    calls++; controller.abort();
    return { isExternal: true, vcard: { userId: options.body.userId } };
  } };
  const result = await runDocs(session, 'identities', { ids: 'one,two,three', signal: controller.signal });
  assert.equal(calls, 1);
  assert.equal(result.items[0].identity.accountId, null);
  assert.deepEqual(result.unsupportedItems.map(item => item.reason), ['REQUEST_CANCELLED', 'REQUEST_CANCELLED']);
  assert.ok(result.coverage.identity.reasons.includes('GLOBAL_IDENTITY_TENANT_UNVERIFIED'));
});

test('capabilities preserve separate global and document notification dispositions without fallbacks', async () => {
  const result = await runDocs(undefined, 'capabilities', {});
  assert.equal(result.browserFallback.automatic, false);
  assert.equal(result.browserFallback.relay.automatic, false);
  assert.equal(result.browserFallback.relay.implemented, false);
  assert.equal(result.browserFallback.requiresApproval, true);
  assert.equal(result.browserFallback.readStateRisk, true);
  assert.equal(result.capabilities.notifications.source, '/api/notification/groupByFile');
  assert.equal(result.capabilities.notifications.scope, 'native-global-notification-center');
  assert.equal(result.capabilities.notifications.availability, 'implemented');
  assert.equal(result.capabilities.notifications.disposition, 'implemented');
  assert.equal(result.capabilities.notifications.fallback, false);
  assert.equal(Object.hasOwn(result.capabilities.notifications, 'provider'), false);
  assert.ok(result.capabilities.notifications.excludes.includes('comment-scans'));
  assert.ok(result.capabilities.documentForMe.excludes.includes('global-notification-center'));
});

test('an exact comment continuation cannot be reused under a different tenant', async () => {
  const session = treeSession(), request = session.request;
  session.request = async (path, options) => {
    if (path.startsWith('/api/comment/threads:batchGet')) return { users: {}, threads: [{
      thread: { threadId: 'thread', fileId: 'doc', rootBlockId: 'doc', threadStatus: 'open',
        commentType: 2, commentCount: '2', createdBy: 'author' }, nextCursor: '',
      comments: ['one', 'two'].map(commentId => ({ comment: { commentId, threadId: 'thread',
        createdBy: 'author', content: '{"text":"comment"}' } })),
    }] };
    if (path === '/api/file/files/user/vcard') return { isExternal: false, vcard: { userId: options.body.userId } };
    return request(path, options);
  };
  const first = await runDocs(session, 'comment-thread', { id: 'doc', thread: 'thread', limit: 1 });
  let calls = 0;
  const foreign = { identity: { user: { ...identity.user, accountId: 'other' } }, request: async () => { calls++; } };
  await assert.rejects(runDocs(foreign, 'comment-thread', { id: 'doc', thread: 'thread', limit: 1, cursor: first.nextCursor }),
    { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
});

test('an invalid inline actor ID cannot count as a resolved global identity', async () => {
  const session = inboxSession([{ notifications: [notification('one', { sender: { id: 'not a native id', accountId: 'tenant' } })] }]);
  const result = await runDocs(session, 'notifications', { id: 'doc' });
  assert.equal(result.coverage.identity.status, 'incomplete');
  assert.ok(result.coverage.identity.reasons.includes('INVALID_OR_MISSING_NATIVE_ACTOR_ID'));
  assert.equal(result.items[0].actor.identity.provenance.source, '/api/notification/forMe');
});

async function pageFixture(name) {
  return JSON.parse(await readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8'));
}

function encodedFixture(fixture) {
  const plain = Buffer.from(JSON.stringify(fixture.decoded));
  return { content: { data: (fixture.gzip ? gzipSync(plain) : plain).toString('base64'), gzip: fixture.gzip } };
}

function pageSession(responses, children = {}) {
  return { identity, request: async (path, options) => {
    if (path === '/api/file/files/action/batch_get') {
      const id = options.body.ids[0];
      return { successItems: [{ id, fileType: 'doc', parentId: id === 'root' ? null : 'root',
        fileClusterApiPrefix: 'https://docs.zoom.us' }] };
    }
    if (path.startsWith('/api/page/')) {
      const id = path.split('/')[3];
      return responses[id];
    }
    if (path === '/api/file/files/action/batch_get_children') {
      const id = options.body.parentIds[0];
      return { successItems: [{ parentId: id, children: children[id] ?? [] }] };
    }
    throw new Error(`Unexpected request ${path}`);
  } };
}

test('sanitized observed plain and gzip page envelopes decode with opaque evidence', async () => {
  const plain = await pageFixture('docs-page-plain.json');
  const gzip = await pageFixture('docs-page-gzip.json');
  for (const fixture of [plain, gzip]) {
    const result = await runDocs(pageSession({ [fixture.pageId]: encodedFixture(fixture) }), 'read', { id: fixture.pageId });
    assert.equal(result.loadedPageCount, 1);
    assert.equal(result.loadedPages[0].decodeEvidence.gzip, fixture.gzip);
    assert.equal(result.loadedPages[0].decodeEvidence.encodedSha256.length, 64);
    assert.equal(result.pages[0].text.includes('sanitized'), true);
  }
});

test('a decoded root plus unsupported child returns deterministic partial output and strict diagnostics', async () => {
  const plain = await pageFixture('docs-page-plain.json');
  const responses = { root: encodedFixture(plain), child: { content: { data: 'not-base64!', gzip: false } } };
  const children = { root: [{ id: 'child', fileType: 'doc', parentId: 'root' }] };
  const result = await runDocs(pageSession(responses, children), 'read', { id: 'root' });
  assert.equal(result.loadedPageCount, 1);
  assert.equal(result.coverage.content.status, 'incomplete');
  assert.equal(result.coverage.pagination.status, 'incomplete');
  assert.equal(result.unsupportedItems.some(item => item.pageId === 'child' && item.diagnostic === 'INVALID_PAGE_ENVELOPE'), true);
  assert.equal(result.diagnostics.complete, false);
  await assert.rejects(runDocs(pageSession(responses, children), 'read', { id: 'root', strict: true }), error => {
    assert.equal(error.code, 'INCOMPLETE_COVERAGE');
    assert.equal(error.details.partial.loadedPages.length, 1);
    assert.equal(error.details.partial.unsupportedItems[0].pageId, 'child');
    return true;
  });
});

test('zero decoded pages fail closed and distinguish the page decode failure', async () => {
  const session = pageSession({ root: { content: { data: 'not-base64!', gzip: false } } });
  await assert.rejects(runDocs(session, 'read', { id: 'root' }), error => {
    assert.equal(error.code, 'UNSUPPORTED_CONTENT');
    assert.equal(error.details.zeroDecoded, true);
    assert.equal(error.details.decodedPageCount, 0);
    assert.equal(error.details.failure.diagnostic, 'INVALID_PAGE_ENVELOPE');
    assert.equal(error.details.failure.opaqueEvidence.encodedLength, 11);
    assert.equal('data' in error.details.failure.opaqueEvidence, false);
    return true;
  });
});
