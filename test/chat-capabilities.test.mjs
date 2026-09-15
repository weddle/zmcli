import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCapabilities, runChat } from '../src/chat.mjs';
import { AppError } from '../src/session.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const draftsResultNine = JSON.parse(readFileSync(new URL('./fixtures/chat-drafts-result-9.json', import.meta.url), 'utf8'));

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const invoke = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });

test('Chat capability inventory exposes merged native and integrated controls without secrets', () => {
  const result = chatCapabilities();
  assert.equal(result.safety.automaticWriteReplay, false);
  assert.equal(result.safety.broadFallback, false);
  assert.equal(result.provenance.capturedSecrets, false);
  assert.deepEqual(result.capabilities.mentionGroups.commands, [
    'mention-groups', 'mention-group-create', 'mention-group-update', 'mention-group-delete', 'mention-group-send',
  ]);
  assert.ok(result.capabilities.organization.commands.includes('folder-move'));
  assert.ok(result.capabilities.sharedSpaces.commands.includes('shared-space-create'));
  assert.ok(result.capabilities.privateChats.commands.includes('dm-send'));
  assert.ok(result.capabilities.channels.commands.includes('channel-transfer-owner'));
  assert.ok(result.capabilities.members.commands.includes('remove-member'));
  assert.ok(result.capabilities.sharedPins.commands.includes('unpin'));
  assert.ok(result.capabilities.scheduledSends.commands.includes('schedule-delete'));
  assert.ok(result.capabilities.presence.commands.includes('out-of-office'));
  assert.deepEqual(result.capabilities.drafts.commands, ['draft-create', 'draft-edit', 'draft-delete']);
  assert.equal(result.capabilities.unsupported.drafts.evidence.providerResult, draftsResultNine.response.result);
  assert.equal(result.capabilities.unsupported.drafts.evidence.phase, draftsResultNine.phase);
});

test('permissions reports exact actor and opaque native roles without claiming effective authorization', async () => {
  const channel = 'room@conference.xmpp.zoom.us';
  const session = { openChat: async () => ({
    identity: { user: { userId: 'actor', accountId: 'tenant' }, account: { accountId: 'tenant' } },
    from: 'actor@xmpp.zoom.us/resource',
    channelSuffix: '@conference.xmpp.zoom.us',
    request: async (path, { body }) => {
      if (path === '/xms/channel/infos') {
        assert.equal(body[0].groupJid, channel);
        return { result: 0, data: { [channel]: { name: 'Fixture', account: 'tenant', owner: 'actor', type: 2, e2e: '0', role: 10, memberCount: 2 } } };
      }
      assert.equal(path, '/bffapi/channel/members/client');
      assert.equal(body.membersParams.groupJid, channel);
      return { result: 0, data: { memberResponse: { total: 2, haveMore: false, data: [
        { userJid: 'actor@xmpp.zoom.us', name: 'Actor', role: 10 },
        { userJid: 'peer@xmpp.zoom.us', name: 'Peer', role: 30 },
      ] } } };
    },
  }) };
  const result = await runChat(session, 'permissions', { chat: 'room' });
  assert.equal(result.actor.isOwner, true);
  assert.equal(result.actor.metadataRole, 10);
  assert.equal(result.actor.rosterRole, 10);
  assert.equal(result.members[1].role, 30);
  assert.equal(result.coverage.effectivePermissions, 'unknown');
  assert.equal(result.coverage.permissionAbsenceProvesDenied, false);
});

test('notification update uses one write and independently preserves other settings', async () => {
  const channel = 'room@conference.xmpp.zoom.us', other = 'other@conference.xmpp.zoom.us';
  let reads = 0, writes = 0;
  const session = { openChat: async () => ({
    identity: { user: { userId: 'actor', accountId: 'tenant' }, account: { accountId: 'tenant' } },
    from: 'actor@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
    request: async path => {
      assert.equal(path, '/xms/channel/infos');
      return { result: 0, data: { [channel]: { name: 'Fixture', account: 'tenant', type: 2, e2e: '0' } } };
    },
    sendIq: async stanza => {
      if (stanza.includes('type=\"get\"')) {
        reads++;
        return { notifies: [{ jid: channel, type: reads === 1 ? 'mention' : 'all' }, { jid: other, type: 'off' }] };
      }
      writes++;
      assert.match(stanza, /storage=\"update\"/);
      assert.match(stanza, new RegExp(`item type=\"all\" v=\"${channel.replaceAll('.', '\\.')}\"`));
      return { notifies: null };
    },
  }) };
  const result = await runChat(session, 'notifications-set', { chat: 'room', state: 'all' });
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.previous, 'mention');
  assert.equal(result.otherSettingsPreserved, true);
  assert.equal(reads, 2);
  assert.equal(writes, 1);
});

test('notification no-op and malformed readback never transmit a setting write', async () => {
  const channel = 'room@conference.xmpp.zoom.us';
  let writes = 0;
  const make = notifies => ({ openChat: async () => ({
    identity: { user: { userId: 'actor', accountId: 'tenant' }, account: { accountId: 'tenant' } },
    from: 'actor@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
    request: async () => ({ result: 0, data: { [channel]: { name: 'Fixture', account: 'tenant', type: 2, e2e: '0' } } }),
    sendIq: async stanza => {
      if (!stanza.includes('type=\"get\"')) writes++;
      return { notifies };
    },
  }) });
  await assert.rejects(runChat(make([{ jid: channel, type: 'off' }]), 'notifications-set', { chat: 'room', state: 'off' }), { code: 'ALREADY_SET' });
  await assert.rejects(runChat(make([{ jid: channel, type: 'invalid' }]), 'notifications', { chat: 'room' }), { code: 'UNSUPPORTED_CONTENT' });
  assert.equal(writes, 0);
});

test('mark unread binds the latest root timestamp and confirms the manual index without replay', async () => {
  const channel = 'room@conference.xmpp.zoom.us';
  let markReads = 0, writes = 0;
  const session = { openChat: async () => ({
    identity: { user: { userId: 'actor', accountId: 'tenant' }, account: { accountId: 'tenant' } },
    from: 'actor@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
    unreadIndex: async () => ({ sessions: [], version: 1 }),
    parseMessages: async () => [{ id: 'message', timestamp: 123, to: channel, type: 'groupchat', replyTo: null }],
    request: async path => {
      if (path === '/xms/channel/infos') return { result: 0, data: { [channel]: { name: 'Fixture', account: 'tenant', type: 2, e2e: '0' } } };
      if (path === '/xms/murd/fetch') return { result: 0, data: markReads++ ? [{ [channel]: [123] }] : [] };
      if (path === '/history/fetch2') return { result: 0, data: [{ session: channel, messages: [{ msg_id: 'message', timestamp: 123, message: '<message/>' }] }] };
      throw Error(`unexpected ${path}`);
    },
    sendIq: async stanza => {
      writes++;
      assert.match(stanza, /query action=\"mark\"/);
      assert.match(stanza, /timeframe=\"123\"/);
      return {};
    },
  }) };
  const result = await runChat(session, 'mark-unread', { chat: 'room' });
  assert.equal(result.outcome, 'confirmed');
  assert.deepEqual(result.timestamps, [123]);
  assert.equal(writes, 1);
});

test('mark read refuses mixed native/manual state before transmission', async () => {
  const channel = 'room@conference.xmpp.zoom.us';
  let writes = 0;
  const session = { openChat: async () => ({
    identity: { user: { userId: 'actor', accountId: 'tenant' }, account: { accountId: 'tenant' } },
    from: 'actor@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
    unreadIndex: async () => ({ sessions: [{ id: channel, unreadCount: 2, lastUnreadTime: 123 }], version: 1 }),
    request: async path => path === '/xms/channel/infos'
      ? { result: 0, data: { [channel]: { name: 'Fixture', account: 'tenant', type: 2, e2e: '0' } } }
      : { result: 0, data: [{ [channel]: [100] }] },
    sendIq: async () => { writes++; return {}; },
  }) };
  await assert.rejects(runChat(session, 'mark-read', { chat: 'room' }), { code: 'READ_STATE_AMBIGUOUS' });
  assert.equal(writes, 0);
});

test('draft create reuses the text encoder and requires exact correlated server-version acknowledgement', async () => {
  const channel = 'room@conference.xmpp.zoom.us';
  let writes = 0;
  const session = { openChat: async () => ({
    identity: { user: { userId: 'actor', accountId: 'tenant' }, account: { accountId: 'tenant' } },
    from: 'actor@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
    getDisplayName: async () => 'Actor',
    request: async () => ({ result: 0, data: { [channel]: { name: 'Fixture', account: 'tenant', type: 2, e2e: '0' } } }),
    sendIq: async stanza => {
      writes++;
      assert.match(stanza, /query xmlns=\"zoom:iq:draft\" action=\"create\"/);
      assert.match(stanza, /<message xmlns=\"jabber:client\"/);
      assert.match(stanza, /<body>draft text<\/body>/);
      const id = /<item id="([^"]+)"/.exec(stanza)[1], createdAt = /create_t="(\d+)"/.exec(stanza)[1];
      return { draft: { action: 'create', version: '14', item: {
        id, type: '0', createdAt, modifiedAt: String(Number(createdAt) + 1), sendAt: '0', version: '',
      } } };
    },
  }) };
  const result = await runChat(session, 'draft-create', { chat: 'room', text: 'draft text' });
  assert.equal(result.outcome, 'confirmed');
  assert.equal(result.draftVersion, '14');
  assert.equal(result.contentReadbackAvailable, false);
  assert.equal(writes, 1);
});

test('draft delete sends once and rejects an uncorrelated acknowledgement as unknown', async () => {
  const channel = 'room@conference.xmpp.zoom.us';
  let writes = 0;
  const session = { openChat: async () => ({
    identity: { user: { userId: 'actor', accountId: 'tenant' }, account: { accountId: 'tenant' } },
    from: 'actor@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
    request: async () => ({ result: 0, data: { [channel]: { name: 'Fixture', account: 'tenant', type: 2, e2e: '0' } } }),
    sendIq: async stanza => {
      writes++;
      assert.match(stanza, /action=\"delete\"/);
      assert.match(stanza, /item id=\"draft-id\" session=\"room@conference\\.xmpp\\.zoom\\.us\"/);
      return { draft: { action: 'create', version: '15', item: null } };
    },
  }) };
  await assert.rejects(runChat(session, 'draft-delete', { chat: 'room', draft: 'draft-id' }), error => {
    assert.equal(error.code, 'WRITE_UNCONFIRMED');
    assert.equal(error.details.outcome, 'unknown');
    assert.equal(error.details.draftId, 'draft-id');
    return true;
  });
  assert.equal(writes, 1);
});
test('draft listing preserves native result 9 disposition and never opens or mutates Chat', async () => {
  let opened = 0;
  const session = { openChat: async () => { opened++; throw new Error('must not open'); } };
  await assert.rejects(runChat(session, 'drafts'), error => {
    assert.equal(error.code, 'UNSUPPORTED_CAPABILITY');
    assert.equal(error.details.operation, 'chat.drafts');
    assert.equal(error.details.phase, draftsResultNine.phase);
    assert.equal(error.details.outcome, 'not_sent');
    assert.equal(error.details.sent, false);
    assert.equal(error.details.fallback, false);
    assert.equal(error.details.evidence.providerResult, draftsResultNine.response.result);
    assert.deepEqual(error.details.evidence.request, {
      path: draftsResultNine.request.path,
      userId: 'actor-user-id-without-jid-domain',
      limit: draftsResultNine.request.body.limit,
    });
    return true;
  });
  assert.equal(opened, 0);
});


test('JSON help is deterministic, auth-free, schema-versioned, and classifies native actions', () => {
  const first = invoke(['--help', '--json']);
  const second = invoke(['--json', '--help']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stderr, '');
  assert.equal(first.stdout, second.stdout);
  const document = JSON.parse(first.stdout);
  assert.equal(document.ok, true);
  assert.equal(document.data.schemaVersion, 1);
  assert.ok(document.data.commands.every(command => Array.isArray(command.arguments)
    && Array.isArray(command.options) && ['read-only', 'mutating'].includes(command.access.mode)));
  const chatHelp = new Map(document.data.commands.filter(command => command.group === 'chat').map(command => [command.action, command]));
  for (const capability of Object.values(chatCapabilities().capabilities)) {
    for (const action of capability.commands ?? []) assert.ok(chatHelp.has(action), `missing Chat JSON help for ${action}`);
  }
  for (const action of ['folder-move', 'shared-space-create', 'channel-permission', 'schedule-create', 'notification-set', 'mark-unread', 'reminder-edit', 'status-message', 'out-of-office']) {
    assert.equal(chatHelp.get(action)?.access.mode, 'mutating', `${action} must be classified as mutating`);
  }
  assert.equal(chatHelp.get('private-chat-info')?.access.mode, 'read-only');
  assert.equal(chatHelp.get('drafts')?.access.authentication, 'not-required');
  assert.equal(chatHelp.get('drafts')?.conditionalUnsupported?.code, 'UNSUPPORTED_CAPABILITY');
  assert.equal(chatHelp.get('drafts')?.conditionalUnsupported?.outcome, 'not_sent');

  const zoommateHelp = new Map(document.data.commands.filter(command => command.group === 'zoommate').map(command => [command.action, command]));
  assert.equal(zoommateHelp.get('query')?.access.mode, 'mutating');
  assert.equal(zoommateHelp.get('cancel')?.access.mode, 'mutating');
  assert.equal(zoommateHelp.get('watch')?.access.mode, 'read-only');
});

test('scoped JSON help is stable while ordinary human help remains unchanged in shape', () => {
  const machine = invoke(['chat', 'folders', '--help', '--json']);
  assert.equal(machine.status, 0, machine.stderr);
  const payload = JSON.parse(machine.stdout);
  assert.equal(payload.data.scope, 'chat folders');
  assert.equal(payload.data.commands.length, 1);
  assert.equal(payload.data.commands[0].conditionalUnsupported, undefined);
  assert.equal(payload.data.commands[0].access.authentication, 'cookie-file-required');

  const humanA = invoke(['chat', 'folders', '--help']);
  const humanB = invoke(['--help', 'chat', 'folders']);
  assert.equal(humanA.status, 0, humanA.stderr);
  assert.equal(humanA.stdout, humanB.stdout);
  const humanPayload = JSON.parse(humanA.stdout);
  assert.deepEqual(Object.keys(humanPayload.data), ['help']);
  assert.equal(typeof humanPayload.data.help, 'string');
  assert.equal(humanPayload.data.help.includes('--json'), false);
});
