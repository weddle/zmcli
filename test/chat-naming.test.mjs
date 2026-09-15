import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';
import { AppError } from '../src/session.mjs';

const jid = 'fixture@conference.xmpp.zoom.us';
function fixture({ owner = 'owner', fail, stale = false } = {}) {
  let name = 'Before', writes = 0;
  return { get writes() { return writes; }, openChat: async () => ({
    identity: { user: { userId: 'owner', accountId: 'tenant' } }, from: 'owner@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
    request: async path => {
      if (path === '/bffapi/channel/members/client') return { result: 0, data: { memberResponse: { data: [{ userJid: 'owner@xmpp.zoom.us', name: 'Owner', isZccQ: false }], total: 1, haveMore: false } } };
      if (path === '/xms/channel/infos') return { data: { [jid]: { name, owner, account: 'tenant', type: 2, e2e: '0', memberCount: 1 } } };
      throw Error('Unexpected request');
    },
    sendIq: async () => { writes++; if (fail) throw fail; if (!stale) name = 'After'; return {}; },
  }) };
}
const options = { channel: jid, name: 'After', 'if-name': 'Before', 'expect-users': 'owner' };
test('channel naming refuses stale names and nonowner actors before mutation', async () => {
  const stale = fixture();
  await assert.rejects(runChat(stale, 'channel-rename', { ...options, 'if-name': 'Changed' }), { code: 'CONVERSATION_CHANGED' });
  assert.equal(stale.writes, 0);
  const nonowner = fixture({ owner: 'someoneelse' });
  await assert.rejects(runChat(nonowner, 'channel-rename', options), { code: 'FORBIDDEN' });
  assert.equal(nonowner.writes, 0);
});
test('channel naming requires readback and never retransmits uncertain writes', async () => {
  const success = await runChat(fixture(), 'channel-rename', options);
  assert.equal(success.channel.title, 'After');
  assert.equal(success.outcome, 'confirmed');
  for (const session of [fixture({ stale: true }), fixture({ fail: new AppError('WRITE_UNCONFIRMED', 'Timeout') })]) {
    await assert.rejects(runChat(session, 'channel-rename', options));
    assert.equal(session.writes, 1);
  }
});
