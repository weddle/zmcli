import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';
import { AppError } from '../src/session.mjs';
import { messageWire, xml } from '../src/chat-xml.mjs';
import { messageContent } from '../src/chat-transport.mjs';

const channel = 'room@conference.xmpp.zoom.us', actor = 'actor@xmpp.zoom.us', author = 'peer@xmpp.zoom.us';
function record(id, timestamp, mentionType = 1, to = channel) {
  const jid = mentionType === 1 ? actor : mentionType === 2 ? 'all' : 'mention-group';
  const rich = { type: 'Page', children: [{ type: 'Paragraph', content: [{ data: { 'custom-inline': {
    type: 'mention', mentionType, jid, label: 'Actor', prefix: '@',
  } } }] }] };
  return { msg_id: id, timestamp, comment_total: 0, message: `<message id="${id}" from="${author}" to="${to}" type="groupchat"><body>@Actor</body><zmrt>${xml(JSON.stringify(rich))}</zmrt><zmext><msg_type>17</msg_type><at><user jid="${jid}" t="${mentionType}" s="0" e="5"/></at></zmext></message>` };
}
function sessionFor(records, { cardError } = {}) {
  const requests = [];
  return { requests, openChat: async () => ({
    identity: { user: { userId: 'actor', accountId: 'tenant' } }, from: `${actor}/resource`, channelSuffix: '@conference.xmpp.zoom.us',
    messageSearchEnabled: true, unlimitedSearchRetention: true,
    parseMessages: async rows => rows.map(row => messageContent(row, messageWire(row))),
    request: async (path, { body } = {}) => {
      requests.push(path);
      if (path === '/xms/channel/infos') return { data: { [channel]: { name: 'Fixture', account: 'tenant', type: 2, e2e: '0' } } };
      if (path === '/history/fetch2') return { result: 0, data: [{ session: channel, messages: records }] };
      if (path === '/bffapi/mentions/list/client') return { result: 0, data: records.map(row => ({ msgid: row.msg_id, t: row.timestamp, sessionId: channel, stanza: row.message })), searchAfter: '' };
      if (path === '/api/v1/ucs/contact/vcard/batch') {
        if (cardError) throw cardError;
        return { vcardUsers: body.userJids.map(jid => ({ jid, userId: jid.split('@')[0], nickName: 'Fixture author', organization: ['tenant'] })) };
      }
      throw Error(`Unexpected fixture request ${path}`);
    },
  }) };
}

test('activity refuses roots addressed to another conversation before fetching replies', async () => {
  const session = sessionFor([record('wrong-room', 1000, 1, 'other@conference.xmpp.zoom.us')]);
  await assert.rejects(runChat(session, 'activity', { channel, since: '1970-01-01T00:00:00.500Z', until: '1970-01-01T00:00:02Z' }), { code: 'UNSUPPORTED_CONTENT' });
  assert.ok(!session.requests.includes('/xms/thread/fetch'));
});

test('strict empty native mention pages distinguish zero returned content from unknown source exhaustiveness', async () => {
  const result = await runChat(sessionFor([]), 'mentions', { state: 'all', strict: true, 'resolve-identities': true });
  assert.deepEqual(result.items, []);
  assert.equal(result.coverage.content.status, 'complete');
  assert.equal(result.coverage.category.exhaustive, false);
  assert.equal(result.freshness.alreadyReadCoverage, 'unknown');
});

test('strict timezone periods assess only returned content and respect both edges across a DST fold', async () => {
  const since = '2026-11-01T01:00:00-04:00', until = '2026-11-01T01:00:00-05:00';
  const excluded = record('before', Date.parse(since) - 1, 99);
  const result = await runChat(sessionFor([excluded, record('inside', Date.parse(since)), record('until', Date.parse(until))]), 'mentions', {
    state: 'all', since, until, timezone: 'America/New_York', strict: true, 'resolve-identities': true,
  });
  assert.deepEqual(result.items.map(item => item.id), ['inside']);
  assert.equal(result.timeRange.since, '2026-11-01T05:00:00.000Z');
  assert.equal(result.timeRange.until, '2026-11-01T06:00:00.000Z');
  assert.equal(result.timeRange.filterLocation, 'local');
  assert.equal(result.timeRange.sourceExhaustive, false);
});

test('optional identity failure preserves content and becomes strict partial evidence, not a lost result', async () => {
  const options = { state: 'all', 'resolve-identities': true };
  const fixture = () => sessionFor([record('kept', 1000)], { cardError: new AppError('FORBIDDEN', 'Private upstream detail') });
  const result = await runChat(fixture(), 'mentions', options);
  assert.equal(result.items[0].id, 'kept');
  assert.equal(result.coverage.identity.status, 'incomplete');
  assert.equal(result.items[0].message.fromIdentity, null);
  await assert.rejects(runChat(fixture(), 'mentions', { ...options, strict: true }), error => {
    assert.equal(error.code, 'INCOMPLETE_COVERAGE');
    assert.equal(error.details.partial.returnedCount, 1);
    assert.ok(!JSON.stringify(error).includes('Private upstream detail'));
    return true;
  });
  await assert.rejects(runChat(sessionFor([record('gate', 1000)], { cardError: new AppError('PROVIDER_APPROVAL_REQUIRED', 'Approval required') }), 'mentions', options), { code: 'PROVIDER_APPROVAL_REQUIRED' });
});

test('direct and broad native mention views do not collapse all or mention-group targeting into direct', async () => {
  const records = [record('direct', 1000), record('all', 1001, 2), record('group', 1002, 4)];
  const broad = await runChat(sessionFor(records), 'mentions', { state: 'all', 'mention-scope': 'any' });
  assert.deepEqual(broad.items.map(item => item.mentionKinds), [['direct'], ['all'], ['mention-group']]);
  const direct = await runChat(sessionFor(records), 'mentions', { state: 'all', 'mention-scope': 'direct' });
  assert.deepEqual(direct.items.map(item => item.id), ['direct']);
  assert.equal(direct.items[0].message.readState, 'unknown');
  assert.equal(direct.items[0].notificationExpectation, 'unknown');
  const unknown = await runChat(sessionFor([record('unknown', 1000, 99)]), 'mentions', { state: 'all' });
  assert.deepEqual(unknown.items[0].mentionKinds, ['unknown']);
  assert.equal(unknown.coverage.content.status, 'incomplete');
});

test('one exact contact remains non-exhaustive and duplicate exact names cannot authorize a DM read', async () => {
  let historyReads = 0;
  const rows = ['peer', 'second'].map(userId => ({ userId, jid: `${userId}@xmpp.zoom.us`, snsEmail: `${userId}@example.test`, displayName: 'Same Name', isSameAccount: 1, externalFriend: false, inactiveStatus: 0, type: 0 }));
  const session = { openChat: async () => ({ identity: { user: { userId: 'actor', accountId: 'tenant' } }, from: `${actor}/resource`, request: async path => {
    if (path === '/nws/asyncim/1.0/api/search/contact') return { errorCode: 0, result: rows };
    historyReads++;
    throw Error('No resolution-dependent request should run');
  } }) };
  await assert.rejects(runChat(session, 'dm-read', { name: 'Same Name', 'expect-user': rows[0].jid }), { code: 'AMBIGUOUS_USER' });
  rows.pop();
  const found = await runChat(session, 'users', { query: 'Same Name' });
  assert.equal(found.items[0].matchQuality, 'exact-name');
  assert.equal(found.searchExhaustive, false);
  assert.equal(found.globalUniqueness, 'unknown');
  assert.equal(historyReads, 0);
});
