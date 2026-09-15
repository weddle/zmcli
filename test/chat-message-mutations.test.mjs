import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';
import { AppError } from '../src/session.mjs';

const jid = 'fixture@conference.xmpp.zoom.us';
const options = { channel: jid, message: 'message', time: 10, 'if-text': 'Before', text: 'After', 'expect-users': 'owner,member' };
function fixture(author, sendIq) {
  return { openChat: async () => ({
    from: 'owner@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
    identity: { user: { userId: 'owner', accountId: 'account' } }, sendIq,
    getDisplayName: async () => 'Owner',
    parseMessages: async () => [{ id: 'message', timestamp: 10, to: jid, from: `${author}@xmpp.zoom.us`, type: 'groupchat', messageType: '17', contentComplete: true, text: 'Before', replyTo: null }],
    request: async path => {
      if (path === '/xms/channel/infos') return { data: { [jid]: { name: 'Fixture', account: 'account', type: 2, e2e: '0', memberCount: 2 } } };
      if (path === '/history/fetchbymsgid') return { data: [{ session: jid, messages: [{ stanza: '<message/>', msgid: 'message', t: 10 }] }] };
      if (path === '/bffapi/channel/members/client') return { result: 0, data: { memberResponse: { data: ['owner', 'member'].map(user => ({ userJid: `${user}@xmpp.zoom.us`, name: user, isZccQ: false })), total: 2, haveMore: false } } };
      throw Error(`Unexpected path ${path}`);
    },
  }) };
}

test('editing and deletion cannot transmit against another author', async () => {
  let sends = 0;
  for (const action of ['edit', 'delete']) await assert.rejects(runChat(fixture('member', async () => { sends++; }), action, options), { code: 'FORBIDDEN' });
  assert.equal(sends, 0);
});

test('lost edit acknowledgement keeps original target identity and never resends', async () => {
  let sends = 0;
  await assert.rejects(runChat(fixture('owner', async () => { sends++; throw new AppError('WRITE_UNCONFIRMED', 'Lost acknowledgement'); }), 'edit', options), error => {
    assert.equal(error.code, 'WRITE_UNCONFIRMED');
    assert.equal(error.details.outcome, 'unknown');
    assert.equal(error.details.messageId, 'message');
    assert.equal(error.details.timestamp, 10);
    assert.ok(error.details.requestId);
    return true;
  });
  assert.equal(sends, 1);
});
