import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';

const channel = 'fixture@conference.xmpp.zoom.us';
function fixture(initial = 'mention') {
  let mode = initial; const sent = [];
  return {
    sent,
    openChat: async () => ({
      identity: { user: { userId: 'owner', accountId: 'tenant' } }, from: 'owner@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
      sendIq: async (stanza, requestId, options = {}) => {
        sent.push(stanza);
        if (stanza.includes('type="set"')) {
          const next = stanza.match(/<item type="(all|mention|off)"/)?.[1];
          if (stanza.includes('storage="remove"')) mode = 'inherit'; else mode = next;
        }
        const item = mode === 'inherit' ? '' : `<item type="${mode}" v="${channel}"/>`;
        return options.responseXml ? { stanza: `<iq id="${requestId}" type="result" xmlns="jabber:client"><query xmlns="zoom:iq:notify"><mucnotify xmlns="zoom:notify:mucnotify">${item}</mucnotify></query></iq>` } : { stanza: `<iq id="${requestId}" type="result" xmlns="jabber:client"/>` };
      },
    }),
  };
}

test('notification settings reads native overrides and confirms a mode transition', async () => {
  const session = fixture();
  const before = await runChat(session, 'notification-settings', { session: channel });
  assert.equal(before.mode, 'mention');
  const result = await runChat(session, 'notification-set', { session: channel, mode: 'off', 'if-mode': 'mention' });
  assert.equal(result.mode, 'off');
  assert.equal(result.outcome, 'confirmed');
  assert.match(session.sent[2], /storage="update"/);
  assert.match(session.sent[2], /type="off"/);
  assert.equal(session.sent.length, 4);
});

test('notification mode preconditions stop before any native write', async () => {
  const session = fixture('all');
  await assert.rejects(runChat(session, 'notification-set', { session: channel, mode: 'off', 'if-mode': 'mention' }), { code: 'SETTINGS_CHANGED' });
  assert.equal(session.sent.length, 1);
});
