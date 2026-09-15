import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';

const channel = 'fixture@conference.xmpp.zoom.us';
function fixture() {
  const sentIq = [], sentStanza = [];
  let unread = false;
  return {
    sentIq, sentStanza,
    openChat: async () => ({
      identity: { user: { userId: 'owner', accountId: 'tenant' } },
      from: 'owner@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
      request: async (path, { body } = {}) => {
        if (path === '/xms/space/fetch/userId') return { result: 0, data: { spaces: [], haveMore: false, lastValue: '' } };
        if (path === '/xms/space/fetch/items') return { result: 0, data: { items: [{ id: channel }], haveMore: false, lastValue: '' } };
        if (path === '/xms/space/fetch/members') return { result: 0, data: { members: [], haveMore: false, lastValue: '' } };
        if (path === '/xms/reminder/fetch') return { result: 0, data: { items: [], haveMore: false, lastValue: '' } };
        if (path === '/xms/drafts/fetch/userid') return { result: 0, data: [], haveMore: false, lastValue: '', version: 'v1' };
        if (path === '/xms/murd/fetch') return { result: 0, data: unread ? [{ [channel]: ['99'] }] : [] };
        if (path === '/xms/channel/infos') return { data: { [channel]: { name: 'Fixture', owner: 'owner', account: 'tenant', type: 2, e2e: '0', memberCount: 1 } } };
        if (path === '/bffapi/channel/members/client') return { result: 0, data: { memberResponse: { data: [{ userJid: 'owner@xmpp.zoom.us', name: 'Owner', isZccQ: false }], total: 1, haveMore: false } } };
        throw new Error(`Unexpected request ${path} ${JSON.stringify(body)}`);
      },
      sendIq: async (stanza, requestId, options = {}) => {
        sentIq.push(stanza);
        if (stanza.includes('action="mark"')) unread = true;
        if (stanza.includes('action="unmark"')) unread = false;
        return options.responseXml ? { stanza: `<iq id="${requestId}" type="result" xmlns="jabber:client"/>` } : { stanza: `<iq id="${requestId}" type="result" xmlns="jabber:client"/>` };
      },
      sendStanza: async stanza => { sentStanza.push(stanza); },
    }),
  };
}

test('native unread, reminders, drafts, and channel permissions use exact native operations', async () => {
  const session = fixture();
  const unreadResult = await runChat(session, 'mark-unread', { session: channel, timestamp: 99 });
  assert.equal(unreadResult.outcome, 'confirmed');
  assert.match(session.sentIq[0], /<query action="mark" xmlns="zoom:iq:mark">/);
  assert.match(session.sentIq[0], /type="groupchat"/);
  await runChat(session, 'reminder-set', { session: channel, timestamp: 99, 'reminder-t': 3600, message: 'm-1', content: 'Follow up' });
  assert.match(session.sentIq[1], /<query xmlns="zoom:iq:reminder" action="set">/);
  const sendTime = Date.now() + 3600000;
  await runChat(session, 'schedule-create', { session: channel, 'draft-id': 'd-1', 'message-id': 'm-1', text: 'later', 'send-time': sendTime });
  assert.match(session.sentIq[2], /<query xmlns="zoom:iq:draft" action="create">/);
  assert.match(session.sentIq[2], new RegExp(`schedule_t="${sendTime}"`));
  await runChat(session, 'schedule-delete', { session: channel, 'draft-id': 'd-1' });
  assert.match(session.sentIq[3], /action="delete"/);
  assert.match(session.sentIq[3], /id="d-1"/);
  await runChat(session, 'channel-permission', { channel, member: 'member@xmpp.zoom.us', role: 'admin' });
  assert.match(session.sentIq[4], /action="add_admin"/);
  assert.equal(unreadResult.verified, true);
});
test('shared-space reads and presence status preserve native boundaries', async () => {
  const session = fixture();
  const spaces = await runChat(session, 'shared-spaces');
  assert.deepEqual(spaces.items, []);
  const channels = await runChat(session, 'shared-space-channels', { space: 'space-1' });
  assert.deepEqual(channels.items, [{ id: channel }]);
  await runChat(session, 'status-message', { message: 'Heads down', mode: 'away' });
  assert.equal(session.sentStanza.length, 2);
  assert.match(session.sentStanza[0], /"type":"updatepres"/);
  assert.match(session.sentStanza[0], /"status":"Heads down"/);
  assert.match(session.sentStanza[1], /<status>Heads down<\/status>/);
});

test('shared-space creation requires explicit provider option bitfields', async () => {
  const session = fixture();
  await assert.rejects(runChat(session, 'shared-space-create', { name: 'Space', general: 'General' }), { code: 'INVALID_INPUT' });
  assert.equal(session.sentIq.length, 0);
});
