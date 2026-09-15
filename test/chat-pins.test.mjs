import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';

const jid = 'fixture@conference.xmpp.zoom.us';
test('pin and unpin never replace or remove a different current shared pin', async () => {
  let sends = 0;
  const session = { openChat: async () => ({
    from: 'owner@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
    identity: { user: { userId: 'owner', accountId: 'account' } },
    sendIq: async () => { sends++; },
    parseMessages: async () => [{ id: 'target', timestamp: 10, to: jid, from: 'owner@xmpp.zoom.us', type: 'groupchat' }],
    request: async path => {
      if (path === '/xms/channel/infos') return { data: { [jid]: { name: 'Fixture', account: 'account', type: 2, e2e: '0', memberCount: 2 } } };
      if (path === '/xms/pin/top') return { data: [{ sessionId: jid, msg_id: 'unrelated', timestamp: 9, type: 2 }] };
      if (path === '/history/fetchbymsgid') return { data: [{ session: jid, messages: [{ stanza: '<message/>', msgid: 'target', t: 10 }] }] };
      if (path === '/bffapi/channel/members/client') return { result: 0, data: { memberResponse: { data: ['owner', 'member'].map(user => ({ userJid: `${user}@xmpp.zoom.us`, name: user, isZccQ: false })), total: 2, haveMore: false } } };
      throw Error(`Unexpected path ${path}`);
    },
  }) };
  for (const action of ['pin', 'unpin']) await assert.rejects(runChat(session, action, { channel: jid, message: 'target', time: 10, 'expect-users': 'owner,member' }), { code: 'PIN_CHANGED' });
  assert.equal(sends, 0);
});
