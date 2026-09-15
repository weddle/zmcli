import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';
import { messageWire, parseXml, unreadWire } from '../src/chat-xml.mjs';
import { messageContent } from '../src/chat-transport.mjs';

const from = 'owner@xmpp.zoom.us/resource', suffix = '@conference.xmpp.zoom.us';
const offline = `<iq from="${from}" to="${from}" type="result"><zoom xmlns="zoom:iq:ext" type="offline" version="15"><conference jid="conference.xmpp.zoom.us"/><acktime session="peer" type="1" count="1" read="10" lastunread="11"/></zoom></iq>`;

test('an absent native unread count cannot become a zero-count conversation', () => {
  assert.throws(() => unreadWire(parseXml(offline.replace(' count="1"', '')), from, suffix), { code: 'UNSUPPORTED_CONTENT' });
});

test('native preview timestamps fill only a missing outer timestamp and reject unsafe precision', () => {
  const message = '<message id="message" type="chat"><zmext t="42"/><body>Preview</body></message>';
  assert.equal(messageWire({ message }).timestamp, 42);
  assert.equal(messageWire({ message, timestamp: 43 }).timestamp, 43);
  assert.equal(messageWire({ message: message.replace('t="42"', 't="9007199254740992"') }).timestamp, null);
});

function inboxFixture(ids, wrongPeer = false) {
  const profileReads = [];
  return { ids, profileReads, openChat: async () => ({
    from, channelSuffix: suffix, identity: { user: { userId: 'owner', accountId: 'account' } },
    unreadIndex: async () => ({ sessions: [], version: 15, receivedAt: 100 }),
    directEncryptionMode: async () => 'none',
    parseMessages: async records => records.map(record => messageContent(record, messageWire(record))),
    request: async (path, { body } = {}) => {
      if (path === '/xms/login/recent/list') return { result: 0, data: Object.fromEntries(ids.map(id => [`${id}@xmpp.zoom.us`, { type: 0, sType: 'chat' }])) };
      if (path === '/xms/murd/fetch') return { result: 0, data: [] };
      if (path === '/api/v1/ucs/contact/vcard/batch') {
        profileReads.push(...body.userJids);
        return { vcardUsers: body.userJids.map(jid => ({ jid, userId: jid.split('@')[0], email: `${jid.split('@')[0]}@example.test`, organization: ['account'] })) };
      }
      if (path === '/history/fetch') return { result: 0, data: body.sessions.map(session => ({ session: Object.keys(session)[0], messages: wrongPeer
        ? ['<message id="message" type="chat" from="outsider@xmpp.zoom.us" to="owner@xmpp.zoom.us"><zmext t="50"/><body>Wrong pair</body></message>'] : [] })) };
      throw Error(`Unexpected request ${path}`);
    },
  }) };
}

test('a latest preview cannot broaden discovery to a different peer or emit that peer’s link', async () => {
  const session = inboxFixture(['peer'], true);
  const result = await runChat(session, 'dm-inbox', { state: 'all', kind: 'direct' });
  assert.equal(result.items[0].latest, null);
  assert.equal(result.unsupportedItems[0].reason, 'UNSUPPORTED_CONVERSATION_INDEX');
  assert.deepEqual(session.profileReads, ['peer@xmpp.zoom.us']);
});

test('a changed native identity set invalidates local inbox continuation before page enrichment', async () => {
  const ids = ['peer', 'second'], session = inboxFixture(ids);
  const first = await runChat(session, 'dm-inbox', { state: 'all', kind: 'direct', limit: 1 });
  ids.shift();
  await assert.rejects(runChat(session, 'dm-inbox', { state: 'all', kind: 'direct', limit: 1, cursor: first.nextCursor }), { code: 'CURSOR_INDEX_CHANGED' });
  assert.deepEqual(session.profileReads, ['peer@xmpp.zoom.us']);
});
