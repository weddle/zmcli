import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';
import { readActivity } from '../src/chat-activity.mjs';
import { messageContent, openChatTransport } from '../src/chat-transport.mjs';
import { messageWire, parseXml, xml } from '../src/chat-xml.mjs';
import { AppError } from '../src/session.mjs';

const jid = 'room@conference.xmpp.zoom.us';
const identity = { user: { userId: 'actor', accountId: 'auth' }, account: { accountId: 'auth' } };
const metadata = { name: 'Fixture', account: 'resource', owner: 'owner', type: 2, e2e: '0', memberCount: 3, optionStr: 'opaque' };
const rich = { type: 'Page', children: [{ type: 'Paragraph', content: [{ data: 'body' }] }] };
const record = (id, timestamp, extra = '', content = rich, type = '17') => ({ msg_id: id, timestamp,
  message: `<message id="${id}" from="native-sender@xmpp.zoom.us/resource" to="${jid}" type="groupchat"><body>body</body><zmrt>${xml(JSON.stringify(content))}</zmrt><zmext><msg_type>${type}</msg_type>${extra}</zmext></message>` });
const fixture = request => ({ openChat: async () => ({ identity, from: 'actor@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
  parseMessages: async records => records.map(row => messageContent(row, messageWire(row))),
  request: async (path, args) => path === '/xms/channel/infos' ? { result: 0, data: { [jid]: metadata } } : request(path, args) }) });

test('inspect saturated preview exposes identity, uncertainty and unresolved native senders', async () => {
  const result = await runChat(fixture(async () => ({ data: [{ session: jid, messages: [record('one', 1000)] }] })), 'inspect', { channel: 'room', limit: 1 });
  assert.equal(result.diagnostics.requestedChannelId, 'room');
  assert.equal(result.diagnostics.authoritativeChannelId, jid);
  assert.equal(result.channel.channelAccountId, 'resource');
  assert.equal(result.channel.authenticatedAccountId, 'auth');
  assert.equal(result.pagination.complete, false);
  assert.equal(result.coverage.pagination.status, 'incomplete');
  assert.equal(result.coverage.category.exhaustive, false);
  assert.equal(result.freshness.snapshot.status, 'non-atomic');
  assert.ok(result.diagnostics.unsupportedOperations.includes('mutation-authorization-by-inspection'));
  assert.deepEqual(result.senderEvidence.unresolvedNativeSenders, [{ nativeId: 'native-sender@xmpp.zoom.us', messageCount: 1, identity: null }]);
});

test('inspect reports history denial without claiming absence or complete empty content', async () => {
  const result = await runChat(fixture(async () => { throw new AppError('FORBIDDEN', 'denied'); }), 'inspect', { channel: jid });
  assert.deepEqual(result.diagnostics.exactFailure, { stage: 'history', code: 'FORBIDDEN' });
  assert.deepEqual(result.diagnostics.history, { attempted: true, returned: false, messageCount: null });
  assert.equal(result.diagnostics.discovery.absenceInferred, false);
  assert.equal(result.diagnostics.discovery.attempted, false);
  assert.equal(result.diagnostics.discovery.matchedChannelId, null);
  assert.equal(result.diagnostics.metadata.returned, true);
  assert.equal(result.diagnostics.metadata.authoritative, true);
  assert.equal(result.diagnostics.metadata.exactChannelIdMatched, true);
  assert.deepEqual(result.diagnostics.lookup, result.diagnostics.metadata);
  assert.equal(result.coverage.content.status, 'unknown');
  assert.equal(result.coverage.pagination.status, 'incomplete');
});

test('inspect retains malformed raw records and rejects duplicate or oversized native pages', async () => {
  const malformed = { message: '<broken', msg_id: 'bad', timestamp: 1000 };
  const result = await runChat(fixture(async () => ({ data: [{ session: jid, messages: [malformed] }] })), 'inspect', { channel: jid });
  assert.equal(result.pagination.complete, false);
  assert.deepEqual(result.unsupportedItems[0].record, malformed);
  for (const data of [[{ session: jid, messages: [] }, { session: 'room', messages: [] }], [{ session: jid, messages: [record('one', 1), record('two', 2)] }]]) {
    const bad = await runChat(fixture(async () => ({ data })), 'inspect', { channel: jid, limit: 1 });
    assert.equal(bad.diagnostics.exactFailure.code, 'UNSUPPORTED_CONTENT');
    assert.equal(bad.pagination.complete, false);
  }
});

const range = { since: '1970-01-01T00:00:00.500Z', until: '1970-01-01T00:00:02.000Z', timezone: 'UTC' };
const callbacks = history => ({ channelId: () => ({ jid }), channelInfo: async () => metadata, summary: () => ({ id: jid }), history,
  thread: async () => { throw Error('Unexpected thread read'); } });

test('activity preserves supported and raw unsupported records on a blocked page', async () => {
  const root = { id: 'root', timestamp: 1000, from: 'native', replyCount: 0, contentComplete: false,
    raw: { xml: '<message/>' }, contentCoverage: { reasons: ['UNSUPPORTED_MESSAGE_TYPE', 'UNSUPPORTED_RICH_NODE'] } };
  const malformed = { reason: 'MALFORMED_MESSAGE_XML', record: { message: '<broken' } };
  const result = await readActivity({ identity }, { timeRange: range }, callbacks(async () => ({ messages: [root], unsupportedItems: [malformed] })));
  assert.deepEqual(result.messages.map(row => row.id), ['root']);
  assert.deepEqual(result.unsupportedItems[0], malformed);
  assert.deepEqual(result.unsupportedItems[1].reasons, root.contentCoverage.reasons);
  assert.equal(result.pagination.complete, false);
  assert.equal(result.sourceExhaustive, false);
});

test('activity binds absolute interval and timezone while draining encountered older-root replies', async () => {
  const hit = { id: 'reply', timestamp: 1000, replyTo: { id: 'older', thread: '100' }, to: jid, contentComplete: true };
  const seen = [];
  const cb = callbacks(async (chat, id, limit, before, start) => { seen.push([before, start]); return { messages: [hit] }; });
  cb.thread = async (chat, id, thread, limit, before, start) => {
    seen.push([thread, before, start]);
    return { parent: { id: 'older', timestamp: 100 }, messages: [hit] };
  };
  const first = await readActivity({ identity }, { timeRange: range, 'max-pages': 1, 'older-root-pages': 0 }, cb);
  assert.equal(first.pagination.complete, false);
  for (const change of [{ timezone: 'Europe/London' }, { until: '1970-01-01T00:00:03.000Z' }]) {
    await assert.rejects(readActivity({ identity }, { timeRange: { ...range, ...change }, cursor: first.nextCursor, 'older-root-pages': 0 }, cb), { code: 'INVALID_INPUT' });
  }
  const second = await readActivity({ identity }, { timeRange: range, cursor: first.nextCursor, 'older-root-pages': 0 }, cb);
  assert.deepEqual(seen, [[1999, 500], [100, 1999, 500]]);
  assert.equal(second.messages[0].activityKind, 'reply');
  assert.deepEqual(second.messages[0].replyTo, hit.replyTo);
  assert.deepEqual(second.parents, [{ id: 'older', timestamp: 100, channelId: jid }]);
  assert.equal(second.pagination.complete, true);
  assert.equal(second.coverage.category.status, 'unknown');
  assert.ok(second.coverage.category.reasons.includes('LATE_OR_BACKDATED_ARRIVALS_NOT_RECOVERED'));
});

test('activity rejects out-of-range records and mismatched native reply parents', async () => {
  await assert.rejects(readActivity({ identity }, { timeRange: range }, callbacks(async () => ({ messages: [{ id: 'late', timestamp: 2000 }] }))), { code: 'HISTORY_RANGE_MISMATCH' });
  const cb = callbacks(async () => ({ messages: [{ id: 'root', timestamp: 1000, replyCount: 1, contentComplete: true }] }));
  cb.thread = async () => ({ parent: { id: 'root', timestamp: 1000 }, messages: [{ id: 'reply', timestamp: 1100, to: jid, replyTo: { id: 'wrong', thread: '1000' } }] });
  await assert.rejects(readActivity({ identity }, { timeRange: range }, cb), { code: 'UNSUPPORTED_CONTENT' });
});

test('unknown numeric message and rich node types remain opaque despite body text', () => {
  for (const type of ['902', '123456']) {
    const raw = record('opaque', 1000, '<deleted deleter="native"/>', { type: 99, content: [{ type: 123 }] }, type);
    const parsed = messageContent(raw, messageWire(raw));
    assert.equal(parsed.messageType, type);
    assert.equal(parsed.contentComplete, false);
    assert.ok(!parsed.contentCoverage.reasons.includes('SYSTEM_MESSAGE'));
    for (const reason of ['DELETED_MESSAGE', 'UNSUPPORTED_MESSAGE_TYPE', 'UNSUPPORTED_RICH_ROOT', 'UNSUPPORTED_RICH_NODE']) assert.ok(parsed.contentCoverage.reasons.includes(reason));
    assert.deepEqual(parsed.richText, { type: 99, content: [{ type: 123 }] });
    assert.equal(parsed.raw.xml, raw.message);
    const plain = record('opaque', 1000, '', rich, type);
    assert.equal(messageWire(plain).contentKind, 'unsupported');
    assert.equal(messageContent(plain, messageWire(plain)).contentComplete, false);
  }
});

test('XML allows only one safe leading declaration and keeps size failures explicit', () => {
  assert.equal(parseXml('\ufeff<?xml version=\'1.0\' encoding=\'utf-8\' standalone=\'yes\'?><message/>').localName, 'message');
  for (const unsafe of [' <?xml version="1.0"?><message/>', '<?XML version="1.0"?><message/>', '<?xml version="1.0" encoding="UTF-16"?><message/>',
    '<?xml version="1.0"?><?xml version="1.0"?><message/>', '<message><?xml version="1.0"?></message>',
    '<!DOCTYPE message SYSTEM "https://example.invalid/external"><message/>', '<!ENTITY x SYSTEM "file:///not-read"><message/>', '<message>&external;</message>', '<message/><other/>']) {
    assert.throws(() => parseXml(unsafe), { code: 'UNSUPPORTED_CONTENT' });
  }
  assert.throws(() => parseXml(`<message>${'x'.repeat(1024 * 1024)}</message>`), error => error.details.reason === 'MESSAGE_XML_TOO_LARGE');
});

test('conflicting authenticated account identities fail during cookie bootstrap', async () => {
  const config = { uid: 'actor', accountId: 'auth', jid: 'actor@xmpp.zoom.us' };
  const token = { jid: config.jid, zak: 'fixture', xmppToken: 'fixture', resourceId: 'resource', deviceId: 'device' };
  await assert.rejects(openChatTransport({ identity: { ...identity, account: { accountId: 'other' } }, http: {
    request: async url => new Response(JSON.stringify({ status: true, result: url.includes('/newchat/token') ? token : config })),
  } }), { code: 'TENANT_MISMATCH' });
});

test('global message search does not claim channel scoping', async () => {
  const result = await runChat({ openChat: async () => ({ identity, from: 'actor@xmpp.zoom.us/resource', messageSearchEnabled: true, unlimitedSearchRetention: true,
    request: async () => ({ errorCode: 0, msgResults: [], totalSize: 0, searchAfter: '' }) }) }, 'search', { query: 'fixture' });
  assert.equal(result.channelScoped, false);
  assert.equal(result.channelScopeReason, 'NATIVE_CHANNEL_SCOPED_SEARCH_NOT_PROVEN');
});

test('inspect cannot bypass group audience or encrypted history contracts', async () => {
  for (const [change, code] of [[{ type: 3 }, 'UNSUPPORTED_CONVERSATION'], [{ e2e: '1' }, 'UNSUPPORTED_ENCRYPTION']]) {
    let historyCalls = 0;
    const result = await runChat({ openChat: async () => ({ identity, channelSuffix: '@conference.xmpp.zoom.us',
      request: async path => {
        if (path === '/xms/channel/infos') return { result: 0, data: { [jid]: { ...metadata, ...change } } };
        historyCalls++; throw Error('History must not be requested');
      } }) }, 'inspect', { channel: jid });
    assert.equal(result.diagnostics.exactFailure.code, code);
    assert.equal(result.diagnostics.history.attempted, false);
    assert.equal(historyCalls, 0);
  }
});

test('exact-title ambiguity and bounded search cannot choose an arbitrary channel', async () => {
  for (const [data, hasMore, code] of [
    [[{ channelId: 'first', name: 'Fixture' }, { channelId: 'second', name: 'Fixture' }], false, 'AMBIGUOUS_CHANNEL'],
    [[{ channelId: 'first', name: 'Fixture' }], true, 'RESOLUTION_INCOMPLETE'],
  ]) {
    let metadataCalls = 0;
    const session = { openChat: async () => ({ identity, channelSuffix: '@conference.xmpp.zoom.us',
      request: async (path, { body }) => {
        if (path !== '/xms/channel/search') { metadataCalls++; throw Error('No arbitrary selection'); }
        return { result: 0, keyword: body.keyword, page: 1, total: data.length, hasMore, data };
      } }) };
    await assert.rejects(runChat(session, 'resolve', { query: 'Fixture' }), { code });
    assert.equal(metadataCalls, 0);
  }
});

test('search retains resource account aliases and rejects conflicting ownership metadata', async () => {
  for (const field of ['account', 'accountId']) {
    const session = fixture(async () => ({}));
    const chat = await session.openChat();
    chat.request = async (path, { body }) => ({ result: 0, keyword: body.keyword, page: 1, total: 1, hasMore: false,
      data: [{ channelId: 'room', name: 'Fixture', [field]: 'resource' }] });
    const result = await runChat({ openChat: async () => chat }, 'find', { query: 'Fixture' });
    assert.equal(result.items[0].channelAccountId, 'resource');
    assert.equal(result.items[0].authenticatedAccountId, 'auth');
  }
  const chat = await fixture(async () => ({})).openChat();
  chat.request = async (path, { body }) => ({ result: 0, keyword: body.keyword, page: 1, total: 1, hasMore: false,
    data: [{ channelId: 'room', name: 'Fixture', account: 'resource', accountId: 'other' }] });
  await assert.rejects(runChat({ openChat: async () => chat }, 'find', { query: 'Fixture' }), { code: 'UNSUPPORTED_CONTENT' });
});

test('exact-message native ID and timestamp alias conflicts are rejected', async () => {
  const base = record('one', 1000);
  for (const conflict of [{ msgid: 'other' }, { t: 1001 }, { stanza: '<message/>' }]) {
    await assert.rejects(runChat(fixture(async () => ({ data: [{ session: jid, messages: [{ ...base, ...conflict }] }] })),
      'message', { messageLink: { channel: jid, message: 'one', time: 1000 } }), { code: 'UNSUPPORTED_CONTENT' });
  }
});

test('inspect reports mismatched authoritative IDs without routing to the returned resource', async () => {
  let calls = 0;
  await assert.rejects(runChat({ openChat: async () => ({ identity, channelSuffix: '@conference.xmpp.zoom.us',
    request: async path => {
      calls++;
      assert.equal(path, '/xms/channel/infos');
      return { result: 0, data: { [jid]: { ...metadata, groupJid: 'other@conference.xmpp.zoom.us' } } };
    } }) }, 'inspect', { channel: 'room' }), error => {
    assert.equal(error.code, 'CHANNEL_IDENTITY_MISMATCH');
    const diagnostics = error.details.diagnostics;
    assert.equal(diagnostics.requestedChannelId, 'room');
    assert.equal(diagnostics.authoritativeChannelId, 'other@conference.xmpp.zoom.us');
    assert.equal(diagnostics.lookup.returned, true);
    assert.equal(diagnostics.lookup.exactChannelIdMatched, false);
    assert.equal(diagnostics.history.attempted, false);
    return true;
  });
  assert.equal(calls, 1);
});

test('inspect propagates authentication, approval, cancellation, session and route gates at each native stage', async t => {
  for (const stage of ['metadata', 'history']) {
    for (const code of ['PROVIDER_APPROVAL_REQUIRED', 'AUTH_REQUIRED', 'REAUTHENTICATION_REQUIRED',
      'REQUEST_CANCELLED', 'SESSION_CLOSED', 'UNEXPECTED_REDIRECT']) {
      await t.test(`${stage}: ${code}`, async () => {
        const native = new AppError(code, 'Native gate', { retryable: false, cause: { code: 'NATIVE_GATE' } });
        const calls = [];
        const session = { openChat: async () => ({ identity, channelSuffix: '@conference.xmpp.zoom.us',
          request: async path => {
            calls.push(path);
            if (stage === 'metadata' || path === '/history/fetch2') throw native;
            return { result: 0, data: { [jid]: metadata } };
          } }) };
        await assert.rejects(runChat(session, 'inspect', { channel: 'room' }), error => {
          assert.equal(error, native);
          assert.equal(error.details.retryable, false);
          assert.deepEqual(error.details.cause, { code: 'NATIVE_GATE' });
          const diagnostics = error.details.diagnostics;
          assert.deepEqual(diagnostics.exactFailure, { stage, code });
          assert.equal(diagnostics.discovery.attempted, false);
          assert.equal(diagnostics.discovery.absenceInferred, false);
          assert.equal(diagnostics.discovery.matchedChannelId, null);
          assert.equal(diagnostics.metadata.source, '/xms/channel/infos');
          assert.equal(diagnostics.metadata.attempted, true);
          assert.equal(diagnostics.metadata.returned, stage === 'history');
          assert.equal(diagnostics.metadata.authoritative, stage === 'history');
          assert.equal(diagnostics.history.attempted, stage === 'history');
          assert.equal(diagnostics.history.returned, false);
          assert.deepEqual(diagnostics.lookup, diagnostics.metadata);
          return true;
        });
        assert.deepEqual(calls, stage === 'metadata' ? ['/xms/channel/infos'] : ['/xms/channel/infos', '/history/fetch2']);
      });
    }
  }
});

test('inspect metadata denial is a precise failure rather than discovery absence or a history attempt', async () => {
  await assert.rejects(runChat({ openChat: async () => ({ identity, channelSuffix: '@conference.xmpp.zoom.us',
    request: async () => { throw new AppError('FORBIDDEN', 'Native metadata denial'); } }) }, 'inspect', { channel: 'room' }), error => {
    assert.equal(error.code, 'FORBIDDEN');
    const diagnostics = error.details.diagnostics;
    assert.deepEqual(diagnostics.exactFailure, { stage: 'metadata', code: 'FORBIDDEN' });
    assert.equal(diagnostics.discovery.attempted, false);
    assert.equal(diagnostics.discovery.absenceInferred, false);
    assert.equal(diagnostics.metadata.attempted, true);
    assert.equal(diagnostics.metadata.returned, false);
    assert.equal(diagnostics.history.attempted, false);
    return true;
  });
});
