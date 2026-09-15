import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';
import { messageWire, xml } from '../src/chat-xml.mjs';
import { messageContent } from '../src/chat-transport.mjs';
import { AppError } from '../src/session.mjs';

function record(type, end, extra = '') {
  const rich = { type: 'Page', children: [{ type: 'Paragraph', content: [{ data: { 'custom-inline': { type: 'mention', mentionType: type, jid: 'mention-fixture', label: '𝄞', prefix: '@' } } }] }] };
  return { msg_id: 'message', timestamp: 1, message: `<message id="message" type="groupchat"><zmrt>${xml(JSON.stringify(rich))}</zmrt><body>@𝄞</body><zmext><msg_type>17</msg_type><at><user jid="mention-fixture" t="${type}" s="0" e="${end}" ${extra}/></at></zmext></message>` };
}

test('mention ranges use inclusive UTF-16 positions, not code point counts', () => {
  const valid = record(4, 2), outside = record(4, 3);
  assert.equal(messageContent(valid, messageWire(valid)).contentComplete, true);
  assert.equal(messageContent(outside, messageWire(outside)).contentComplete, false);
});

test('unknown mention metadata stays inspectable without claiming complete content', () => {
  const input = record(99, 2, 'future="opaque"');
  const output = messageContent(input, messageWire(input));
  assert.equal(output.contentComplete, false);
  assert.equal(output.mentionCoverage.complete, false);
  assert.ok(output.mentionCoverage.reasons.includes('UNSUPPORTED_MENTION_METADATA'));
  assert.ok(output.mentionCoverage.reasons.includes('UNSUPPORTED_MENTION_FIELDS'));
  assert.equal(output.mentions[0].type, 99);
  assert.equal(output.raw.xml, input.message);
});

const channelId = 'fixture@conference.xmpp.zoom.us';
function sessionFor(member, haveMore = false) {
  let sends = 0;
  return {
    get sends() { return sends; },
    openChat: async () => ({
      from: 'owner@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
      identity: { user: { userId: 'owner', accountId: 'account' } },
      sendStanza: async () => { sends++; },
      sendIq: async () => { sends++; },
      request: async path => {
        if (path === '/xms/channel/infos') return { data: { [channelId]: { name: 'Fixture', account: 'account', type: 2, e2e: '0', memberCount: 2, owner: 'owner' } } };
        if (path === '/bffapi/channel/members/client') return { result: 0, data: { memberResponse: { total: 2, haveMore: false, data: ['owner', 'peer'].map(user => ({ userJid: `${user}@xmpp.zoom.us`, name: user, isZccQ: false })) } } };
        if (path === '/xms/channel/mentiongroups') return { result: 0, data: { groupId: channelId, mentionGroups: [{ groupId: channelId, mgroupId: 'mention-fixture', name: 'Fixture mentions', desc: '', version: 1 }] } };
        if (path === '/bffapi/channel/mentionGroup/members/client') return { result: 0, data: { 'mention-fixture': { result: 0, haveMore, members: [{ username: member, mgroupId: 'mention-fixture' }] } } };
        throw Error(`Unexpected path ${path}`);
      },
    }),
  };
}
const options = { channel: channelId, 'mention-group': 'mention-fixture', 'if-name': 'Fixture mentions', 'expect-users': 'owner,peer', 'expect-members': 'peer', text: 'Must not notify stale or unknown recipients.' };

test('membership changes invalidate a previously approved mention recipient set', async () => {
  const session = sessionFor('owner');
  await assert.rejects(runChat(session, 'mention-group-send', options), { code: 'MENTION_GROUP_CHANGED' });
  assert.equal(session.sends, 0);
});

test('a mention group cannot notify anyone outside the complete private audience', async () => {
  const session = sessionFor('outsider');
  await assert.rejects(runChat(session, 'mention-group-send', options), { code: 'AUDIENCE_MISMATCH' });
  assert.equal(session.sends, 0);
});

test('an unfinished mention membership page cannot authorize notifications', async () => {
  const session = sessionFor('peer', true);
  await assert.rejects(runChat(session, 'mention-group-send', options), { code: 'AUDIENCE_INCOMPLETE' });
  assert.equal(session.sends, 0);
});

function inboxRecord(id = 'message') {
  return { msgid: id, sessionId: channelId, t: 1,
    stanza: record(4, 2).message.replace('<message id="message" type="groupchat">',
      `<message id="${id}" type="groupchat" from="peer@xmpp.zoom.us" to="${channelId}">`) };
}

function inboxSession(response, { actor = 'owner', channelError, readyError } = {}) {
  const requests = [];
  return { requests, openChat: async () => ({
    from: `${actor}@xmpp.zoom.us/resource`, channelSuffix: '@conference.xmpp.zoom.us',
    identity: { user: { userId: actor, accountId: 'account' } },
    messageSearchEnabled: true, unlimitedSearchRetention: true,
    unreadResource: async () => { if (readyError) throw readyError; return 'resource'; },
    parseMessages: async records => records.map(input => messageContent(input, messageWire(input))),
    request: async path => {
      requests.push(path);
      if (path === '/bffapi/mentions/list/client' || path === '/xms/message/unreadMentions') return response;
      if (path === '/xms/channel/infos') {
        if (channelError) throw channelError;
        return { data: { [channelId]: { name: 'Fixture', account: 'account', type: 2, e2e: '0' } } };
      }
      throw Error(`Unexpected path ${path}`);
    },
  }) };
}

test('mention index identity disagreements are preserved without a wrong actionable link', async () => {
  const input = inboxRecord();
  input.msgid = 'another-message';
  const session = inboxSession({ result: 0, data: [input], searchAfter: '' });
  const output = await runChat(session, 'mentions', { state: 'all' });
  assert.deepEqual(output.items, []);
  assert.equal(output.pagination.status, 'incomplete');
  assert.equal(output.unsupportedItems[0].record.stanza, input.stanza);
  assert.equal(output.unsupportedItems[0].reason, 'UNSUPPORTED_CONTENT');
});

test('mention continuation cannot be reused for another state or authenticated actor', async () => {
  const response = { result: 0, data: [inboxRecord()], searchAfter: 'next-native-page' };
  const first = await runChat(inboxSession(response), 'mentions', { state: 'all' });
  for (const [actor, state] of [['peer', 'all'], ['owner', 'unread']]) {
    const session = inboxSession(response, { actor });
    await assert.rejects(runChat(session, 'mentions', { state, cursor: first.nextCursor }), { code: 'INVALID_INPUT' });
    assert.deepEqual(session.requests, []);
  }
});

test('an unread resource that never initializes cannot be reported as an empty inbox', async () => {
  const session = inboxSession({ result: 0, items: [], haveMore: false, total_count: 0, lastValue: 0 },
    { readyError: new AppError('CHAT_INDEX_NOT_READY', 'Native resource did not initialize.') });
  await assert.rejects(runChat(session, 'mentions', { state: 'unread' }), { code: 'CHAT_INDEX_NOT_READY' });
  assert.deepEqual(session.requests, []);
});

test('a provider approval gate aborts the index instead of fetching further rooms', async () => {
  const session = inboxSession({ result: 0, data: [inboxRecord('one'), inboxRecord('two')], searchAfter: '' },
    { channelError: new AppError('PROVIDER_APPROVAL_REQUIRED', 'Interactive approval required.') });
  await assert.rejects(runChat(session, 'mentions', { state: 'all' }), { code: 'PROVIDER_APPROVAL_REQUIRED' });
  assert.equal(session.requests.filter(path => path === '/xms/channel/infos').length, 1);
});
