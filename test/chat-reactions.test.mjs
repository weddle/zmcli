import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';
import { AppError } from '../src/session.mjs';

const jid = 'fixture@conference.xmpp.zoom.us';
function fixture(sendIq, actors = ['owner', 'member']) {
  const chat = {
    from: 'owner@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
    identity: { user: { userId: 'owner', accountId: 'account' } }, sendIq,
    parseMessages: async () => [{ id: 'message', timestamp: 10, to: jid, from: 'member@xmpp.zoom.us', type: 'groupchat', messageType: '17' }],
    request: async path => {
      if (path === '/xms/channel/infos') return { data: { [jid]: { name: 'Fixture', account: 'account', type: 2, e2e: '0', memberCount: 2 } } };
      if (path === '/history/fetchbymsgid') return { data: [{ session: jid, messages: [{ stanza: '<message/>', msgid: 'message', t: 10 }] }] };
      if (path === '/bffapi/channel/members/client') return { result: 0, data: { memberResponse: { data: ['owner', 'member'].map(user => ({ userJid: `${user}@xmpp.zoom.us`, name: user, isZccQ: false })), total: 2, haveMore: false } } };
      if (path === '/xms/emoji/listWithDisplayname') return { result: 0, data: [{ session: jid, msg_id: 'message', msg_timestamp: 10, emojis: { '8J+RjQ==': actors.map(user => ({ jid: `${user}@xmpp.zoom.us` })) } }] };
      throw Error(`Unexpected path ${path}`);
    },
  };
  return { openChat: async () => chat };
}
const options = { channel: jid, message: 'message', time: 10, emoji: '\u{1f44d}', 'expect-users': 'owner,member' };

test('reaction removal refuses another actor-only reaction before transmission', async () => {
  let sends = 0;
  await assert.rejects(runChat(fixture(async () => { sends++; }, ['member']), 'unreact', options), { code: 'NO_SELF_REACTION' });
  assert.equal(sends, 0);
});

test('lost reaction acknowledgement retains operation identity without resend', async () => {
  let sends = 0;
  await assert.rejects(runChat(fixture(async () => { sends++; throw new AppError('WRITE_UNCONFIRMED', 'Lost acknowledgement'); }), 'unreact', options), error => {
    assert.equal(error.code, 'WRITE_UNCONFIRMED');
    assert.equal(error.details.outcome, 'unknown');
    assert.equal(error.details.messageId, 'message');
    assert.equal(error.details.channelId, jid);
    assert.ok(error.details.requestId);
    return true;
  });
  assert.equal(sends, 1);
});
