import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';
import { messageWire, parseXml } from '../src/chat-xml.mjs';

const jid = 'shared@conference.xmpp.zoom.us';
const identity = { user: { userId: 'actor', accountId: 'authenticated-account' }, account: { accountId: 'authenticated-account' } };
const metadata = (account = 'resource-account', extra = {}) => ({
  name: 'Shared Fixture', account, owner: 'actor', type: 2, e2e: '0', memberCount: 2,
  optionStr: '864691197174611980', ...extra,
});
const baseChat = overrides => ({
  identity, from: 'actor@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
  ...overrides,
});
const session = chat => ({ openChat: async () => chat });

test('same-account channel reads expose distinct authenticated and resource accounts', async () => {
  const result = await runChat(session(baseChat({ request: async () => ({ result: 0, data: { [jid]: metadata('authenticated-account') } }) })), 'info', { channel: 'shared' });
  assert.equal(result.channel.channelAccountId, 'authenticated-account');
  assert.equal(result.channel.authenticatedAccountId, 'authenticated-account');
  assert.equal(result.channel.accessScope, 'same-account');
  assert.equal(result.channel.nativeOption, '864691197174611980');
  assert.equal(result.channel.encrypted, false);
  assert.deepEqual(result.channel.incompleteFields, []);
});

test('authoritative cross-tenant inspection reads bounded history without treating ownership as authorization', async () => {
  const calls = [];
  const chat = baseChat({
    request: async (path, { body }) => {
      calls.push(path);
      if (path === '/xms/channel/infos') {
        assert.equal(body[0].groupJid, jid);
        return { result: 0, data: { [jid]: metadata() } };
      }
      assert.equal(path, '/history/fetch2');
      assert.equal(body.sessions[0].session, 'shared');
      return { data: [{ session: jid, messages: [{ message: '<message/>', msg_id: 'history-message', timestamp: 10 }] }] };
    },
    parseMessages: async () => [{ id: 'history-message', timestamp: 10, to: jid, type: 'groupchat' }],
  });
  const result = await runChat(session(chat), 'inspect', { channel: 'shared', limit: 1 });
  assert.equal(result.channel.channelAccountId, 'resource-account');
  assert.equal(result.channel.authenticatedAccountId, 'authenticated-account');
  assert.equal(result.channel.accessScope, 'shared-cross-tenant');
  assert.deepEqual(result.diagnostics.verifiedOperations, ['authoritative-channel-metadata', 'bounded-channel-history']);
  assert.deepEqual(result.diagnostics.history, { attempted: true, returned: true, messageCount: 1 });
  assert.deepEqual(calls, ['/xms/channel/infos', '/history/fetch2']);
});

test('unavailable authoritative metadata reports the exact inspection stage and never claims absence', async () => {
  const chat = baseChat({ request: async () => ({ result: 0, data: {} }) });
  await assert.rejects(runChat(session(chat), 'inspect', { channel: 'shared' }), error => {
    assert.equal(error.code, 'NOT_FOUND_OR_FORBIDDEN');
    assert.equal(error.details.diagnostics.exactFailure.stage, 'metadata');
    assert.equal(error.details.diagnostics.discovery.absenceInferred, false);
    assert.equal(error.details.diagnostics.history.attempted, false);
    return true;
  });
});

test('search preserves an absent account as null and never infers it from channel options', async () => {
  const chat = baseChat({ request: async (_path, { body }) => ({ result: 0, keyword: body.keyword, page: 1, total: 1, hasMore: false,
    data: [{ channelId: 'shared', name: 'Shared Fixture', optionStr: 'tenant-looking-option', memberCount: 2 }] }) });
  const result = await runChat(session(chat), 'find', { query: 'Shared Fixture' });
  assert.equal(result.items[0].channelAccountId, null);
  assert.equal(result.items[0].accessScope, null);
  assert.equal(result.items[0].nativeOption, 'tenant-looking-option');
  assert.equal(result.absenceProven, false);
});

test('exact-title resolution accepts cross-tenant authoritative metadata and filtered zero stays incomplete', async () => {
  const resolvedChat = baseChat({ request: async (path, { body }) => path === '/xms/channel/search'
    ? { result: 0, keyword: body.keyword, page: 1, total: 1, hasMore: false,
      data: [{ channelId: 'shared', name: 'Shared Fixture', account: 'resource-account' }] }
    : { result: 0, data: { [jid]: metadata() } } });
  const resolved = await runChat(session(resolvedChat), 'resolve', { query: 'Shared Fixture' });
  assert.equal(resolved.channel.accessScope, 'shared-cross-tenant');

  const emptyChat = baseChat({ request: async (_path, { body }) => ({ result: 0, keyword: body.keyword, page: 1, total: 0, hasMore: false, data: [] }) });
  await assert.rejects(runChat(session(emptyChat), 'resolve', { query: 'Missing' }), error => {
    assert.equal(error.code, 'RESOLUTION_INCOMPLETE');
    assert.equal(error.details.absenceProven, false);
    return true;
  });
});

test('cross-tenant mutations use native operation guards rather than tenant equality', async () => {
  let writes = 0;
  const chat = baseChat({
    getDisplayName: async () => 'Actor',
    request: async () => ({ result: 0, data: { [jid]: metadata() } }),
    sendIq: async stanza => {
      writes++;
      const draftId = /<item id="([^"]+)"/.exec(stanza)[1];
      const createdAt = /create_t="(\d+)"/.exec(stanza)[1];
      return { draft: { action: 'create', version: '1', item: { id: draftId, type: '0', createdAt, modifiedAt: String(Number(createdAt) + 1), sendAt: '0' } } };
    },
  });
  const result = await runChat(session(chat), 'draft-create', { chat: 'shared', text: 'authorized cross-tenant draft' });
  assert.equal(result.outcome, 'confirmed');
  assert.equal(writes, 1);
});

test('cross-tenant mutations remain denied by the same owner and audience guards', async () => {
  let writes = 0;
  const chat = baseChat({
    request: async path => path === '/xms/channel/infos'
      ? { result: 0, data: { [jid]: metadata('resource-account', { owner: 'other' }) } }
      : { result: 0, data: { memberResponse: { total: 2, haveMore: false, data: [
        { userJid: 'actor@xmpp.zoom.us', name: 'Actor', isZccQ: false },
        { userJid: 'other@xmpp.zoom.us', name: 'Other', isZccQ: false },
      ] } } },
    sendIq: async () => { writes++; return {}; },
  });
  await assert.rejects(runChat(session(chat), 'channel-rename', {
    channel: 'shared', name: 'After', 'if-name': 'Shared Fixture', 'expect-users': 'actor,other',
  }), { code: 'FORBIDDEN' });
  assert.equal(writes, 0);
});

test('one safe leading XML declaration is stripped while declarations and entities remain fail-closed', () => {
  const safe = '<?xml version="1.0" encoding="UTF-8"?><message from="actor@xmpp.zoom.us/resource" to="shared@conference.xmpp.zoom.us" type="groupchat"><body>safe</body></message>';
  assert.equal(messageWire({ msg_id: 'message', timestamp: 10, message: safe }).text, 'safe');
  for (const unsafe of [
    '<?xml version="1.1"?><message/>',
    '<?xml version="1.0"?><?xml version="1.0"?><message/>',
    '<message/><?xml version="1.0"?>',
    '<!DOCTYPE message><message/>',
    '<!ENTITY external SYSTEM "file:///etc/passwd"><message/>',
  ]) assert.throws(() => parseXml(unsafe), { code: 'UNSUPPORTED_CONTENT' });
});

test('exact-message lookup normalizes native aliases and rejects conflicting identities', async () => {
  const xml = '<?xml version="1.0"?><message id="message" from="actor@xmpp.zoom.us/resource" to="shared@conference.xmpp.zoom.us" type="groupchat"><body>normalized</body></message>';
  const fixture = conflict => baseChat({
    request: async path => path === '/xms/channel/infos' ? { result: 0, data: { [jid]: metadata() } }
      : { data: [{ session: jid, messages: [conflict
        ? { stanza: xml, message: '<message/>', msgid: 'message', t: 10 }
        : { message: xml, msg_id: 'message', timestamp: 10 }] }] },
    parseMessages: async records => records.map(record => {
      assert.equal(record.stanza, record.message);
      assert.equal(record.msgid, record.msg_id);
      assert.equal(record.t, record.timestamp);
      return messageWire(record);
    }),
  });
  const result = await runChat(session(fixture(false)), 'message', { messageLink: { channel: jid, message: 'message', time: 10 } });
  assert.equal(result.message.text, 'normalized');
  await assert.rejects(runChat(session(fixture(true)), 'message', { messageLink: { channel: jid, message: 'message', time: 10 } }), { code: 'UNSUPPORTED_CONTENT' });
});
