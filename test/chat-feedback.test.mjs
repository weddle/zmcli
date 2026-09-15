import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';
import { resolveChatTime } from '../src/chat-feedback.mjs';
import { readActivity } from '../src/chat-activity.mjs';
import { AppError } from '../src/session.mjs';
import { completeHistoryPage } from '../src/history-page.mjs';

const identity = { user: { userId: 'actor', accountId: 'tenant' } };
test('conversation index failures retain native step and sanitize secret-bearing causes', async () => {
  const session = { openChat: async () => ({ identity, from: 'actor@xmpp.zoom.us/resource', unreadIndex: async () => { throw new AppError('RATE_LIMITED', 'secret cookie', { status: 429, cookie: 'secret cookie', cause: { code: 'HTTP_ERROR', token: 'secret token' } }); } }) };
  await assert.rejects(runChat(session, 'dm-inbox', { state: 'unread' }), error => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.details.operation, 'chat.dm-inbox');
    assert.equal(error.details.phase, 'conversation-index.offline');
    assert.equal(error.details.cause.cause.code, 'HTTP_ERROR');
    assert.ok(!JSON.stringify(error).includes('secret'));
    return true;
  });
});

test('today observes spring and fall DST boundaries rather than a fixed 24 hours', () => {
  for (const [now, hours] of [['2026-03-08T16:00:00Z', 23], ['2026-11-01T16:00:00Z', 25]]) {
    const range = resolveChatTime({ since: 'today', timezone: 'America/New_York' }, Date.parse(now));
    assert.equal((Date.parse(range.until) - Date.parse(range.since)) / 3600000, hours);
  }
  assert.throws(() => resolveChatTime({ since: 'today' }), { code: 'INVALID_INPUT' });
});

test('invalid or reversed bounds fail before opening the service', async () => {
  let opened = false;
  await assert.rejects(runChat({ openChat: async () => { opened = true; } }, 'mentions', { state: 'all', since: '2026-09-11T00:00:00Z', until: '2026-09-10T00:00:00Z' }), { code: 'INVALID_INPUT' });
  assert.equal(opened, false);
});

test('malformed preserved history does not advertise an exhausted page', () => {
  const record = { message: '<broken' };
  const page = completeHistoryPage({ messages: [], unsupportedItems: [{ reason: 'MALFORMED_MESSAGE_XML', record }] }, null, 20, ['chat read', 'channel', null]);
  assert.equal(page.pagination.complete, false);
  assert.equal(page.unsupportedItems[0].record, record);
});

test('one bounded exact name requires explicit native recipient selection', async () => {
  let sends = 0;
  const chat = { identity, from: 'actor@xmpp.zoom.us/resource', request: async () => ({ errorCode: 0, result: [
    { userId: 'peer', jid: 'peer@xmpp.zoom.us', snsEmail: 'peer@example.test', displayName: 'Exact Name', isSameAccount: 1, externalFriend: false, inactiveStatus: 0, type: 0 },
  ] }), sendIq: async () => { sends++; } };
  await assert.rejects(runChat({ openChat: async () => chat }, 'dm-send', { name: 'Exact Name', text: 'Must not send' }), { code: 'RECIPIENT_CONFIRMATION_REQUIRED' });
  assert.equal(sends, 0);
});

test('activity continuation drains discovered replies before continuing roots and binds tenant', async () => {
  const jid = 'room@conference.xmpp.zoom.us';
  const root = { id: 'root', timestamp: 1000, replyCount: 1, contentComplete: true };
  const reply = { id: 'reply', timestamp: 1100, to: jid, replyTo: { id: 'root', thread: '1000' }, contentComplete: true };
  const calls = [];
  const callbacks = { channelId: () => ({ jid }), channelInfo: async () => ({ type: 2, e2e: '0' }), summary: () => ({ jid }),
    history: async () => { calls.push('roots'); return { messages: [root] }; },
    thread: async () => { calls.push('replies'); return { parent: root, messages: [reply], total: 1 }; } };
  const options = { channel: jid, 'max-pages': 1, 'older-root-pages': 0, timeRange: { since: '1970-01-01T00:00:00.500Z', until: '1970-01-01T00:00:02.000Z' } };
  const first = await readActivity({ identity }, options, callbacks);
  assert.deepEqual(first.messages.map(item => item.id), ['root']);
  const second = await readActivity({ identity }, { ...options, cursor: first.nextCursor }, callbacks);
  assert.deepEqual(second.messages.map(item => item.id), ['reply']);
  assert.deepEqual(calls, ['roots', 'replies']);
  assert.equal(second.nextCursor, null);
  await assert.rejects(readActivity({ identity: { user: { ...identity.user, accountId: 'other' } } }, { ...options, cursor: first.nextCursor }, callbacks), { code: 'INVALID_INPUT' });
});

test('ordinary history cannot be invoked as an unread answer', async () => {
  let opened = false;
  await assert.rejects(runChat({ openChat: async () => { opened = true; } }, 'dm-read', { state: 'unread', email: 'peer@example.test' }), { code: 'UNSUPPORTED_UNREAD_SOURCE' });
  assert.equal(opened, false);
});

test('calendar normalization cannot silently move a bounded query into another month', () => {
  assert.throws(() => resolveChatTime({ since: '2026-02-30T00:00:00Z', until: '2026-03-04T00:00:00Z' }), { code: 'INVALID_INPUT' });
});
