import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';

const jid = 'fixture@conference.xmpp.zoom.us';
function sessionFor(group, roster) {
  let sends = 0;
  return {
    get sends() { return sends; },
    openChat: async () => ({
      from: 'owner@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
      identity: { user: { userId: 'owner', accountId: 'account' } },
      sendStanza: async () => { sends++; },
      request: async path => {
        if (path === '/xms/channel/infos') return { data: { [jid]: { name: 'Fixture', account: 'account', type: 3, e2e: '0', memberCount: 3, ...group } } };
        if (path === '/xms/newchat/muc/batchGet/members') return { result: 0, data: { [jid]: roster } };
        throw Error(`Unexpected path ${path}`);
      },
    }),
  };
}

test('group sending refuses a truncated participant list rather than trusting the expected audience', async () => {
  const session = sessionFor({}, ['owner', 'second'].map(user => ({ userJid: `${user}@xmpp.zoom.us`, inactive: 0, isZccQ: false })));
  await assert.rejects(runChat(session, 'group-send', { group: jid, 'expect-users': 'owner,second,third', text: 'must not send' }), { code: 'AUDIENCE_MISMATCH' });
  assert.equal(session.sends, 0);
});

test('group sending cannot target a private channel or an encrypted group', async () => {
  for (const group of [{ type: 2 }, { e2e: '1' }]) {
    const session = sessionFor(group);
    await assert.rejects(runChat(session, 'group-send', { group: jid, 'expect-users': 'owner,second,third', text: 'must not send' }), { code: 'UNSUPPORTED_GROUP_DIRECT' });
    assert.equal(session.sends, 0);
  }
});

test('generic channel sending cannot bypass the group-DM audience guard', async () => {
  const session = sessionFor({});
  await assert.rejects(runChat(session, 'send', { channel: jid, text: 'must not send' }), { code: 'UNSUPPORTED_GROUP_DIRECT' });
  assert.equal(session.sends, 0);
});

test('generic attachment inspection cannot route a group DM through channel-only APIs', async () => {
  const session = sessionFor({});
  await assert.rejects(runChat(session, 'files', { channel: jid, message: 'target', time: 10 }), { code: 'UNSUPPORTED_GROUP_DIRECT' });
});
