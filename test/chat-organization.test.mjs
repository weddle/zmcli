import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';
import { AppError } from '../src/session.mjs';
import { readFileSync } from 'node:fs';

const starredNative = JSON.parse(readFileSync(new URL('./fixtures/chat-starred-native.json', import.meta.url), 'utf8'));
const starredLiveEmpty = JSON.parse(readFileSync(new URL('./fixtures/chat-starred-live-empty.json', import.meta.url), 'utf8'));
const starredOrderingAbsent = JSON.parse(readFileSync(new URL('./fixtures/chat-starred-ordering-absent.json', import.meta.url), 'utf8'));

const channel = 'fixture@conference.xmpp.zoom.us';
const row = () => ({ folderID: 'folder', username: 'owner', type: 0, name: 'Folder', index: '1', version: 1, sortType: 3,
  members: [{ objid: channel, index: '0', channelName: 'Fixture' }] });
function fixture(rows = [row()], sendError, actor = 'owner') {
  let writes = 0;
  const session = { get writes() { return writes; }, rows, openChat: async () => ({
    from: `${actor}@xmpp.zoom.us/resource`, identity: { user: { userId: actor, accountId: 'tenant' } },
    request: async () => ({ result: 0, data: session.rows }),
    sendIq: async () => { writes++; throw sendError ?? new AppError('WRITE_UNCONFIRMED', 'Timeout'); },
  }) };
  return session;
}
test('starred sessions normalize only verified identities without inventing order or completeness', async () => {
  const session = fixture(starredNative.data, undefined, 'user-self');
  const result = await runChat(session, 'starred');
  assert.deepEqual(result.items.map(({ id, type, index, order, identity, unknownFields }) => ({ id, type, index, order, identity, unknownFields })), [
    {
      id: 'user-peer@xmpp.zoom.us',
      type: 'chat',
      index: '0',
      order: { field: 'i', value: '0' },
      identity: { kind: 'peer-jid', source: 'hsession_id-and-peer_contact_user_id', actorRelation: 'unknown', sessionVariant: 'repeated-peer' },
      unknownFields: [],
    },
    {
      id: 'channel-native-id@conference.xmpp.zoom.us',
      type: 'groupchat',
      index: '10',
      order: { field: 'i', value: '10' },
      identity: { kind: 'channel-jid', source: 'channel_id-and-hsession_id', actorRelation: 'not-applicable', sessionVariant: 'channel-local-id' },
      unknownFields: [],
    },
  ]);
  assert.deepEqual(result.ordering, { fields: ['i'], direction: 'unknown', responseOrderPreserved: true });
  assert.equal(result.snapshot, false);
  assert.match(result.state, /^[a-f0-9]{64}$/);
});
test('starred sessions preserve native response order when explicit ordering is absent', async () => {
  const result = await runChat(fixture(starredOrderingAbsent.data, undefined, 'user-self'), 'starred');
  assert.deepEqual(result.items.map(({ id, index, order, identity }) => ({ id, index, order, identity })), [{
    id: 'user-peer@xmpp.zoom.us',
    index: null,
    order: { field: null, value: null },
    identity: { kind: 'peer-jid', source: 'hsession_id-and-peer_contact_user_id', actorRelation: 'unknown', sessionVariant: 'repeated-peer' },
  }]);
  assert.deepEqual(result.ordering, { fields: [], direction: 'unknown', responseOrderPreserved: true });
  assert.deepEqual(result.pagination, { complete: null, status: 'unknown', continuation: 'none', snapshot: false, recordsBound: 1000 });
  assert.equal(result.snapshot, false);
});
test('starred live empty state stays bounded and malformed, unknown, duplicate or oversized data is explicit', async () => {
  const empty = await runChat(fixture(starredLiveEmpty.data, undefined, 'user-self'), 'starred');
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.ordering, { fields: [], direction: 'unknown', responseOrderPreserved: true });
  assert.deepEqual(empty.pagination, { complete: null, status: 'unknown', continuation: 'none', snapshot: false, recordsBound: 1000 });
  const direct = starredNative.data[0], channelRow = starredNative.data[1];
  for (const data of [
    [null],
    [{ ...direct, hsession_id: 'someone:else' }],
    [{ ...direct, i: 'first' }],
    [{ ...direct, i: undefined }],
    [{ ...direct, index: '0' }],
    [{ ...direct, order: 0 }],
    [{ ...direct, i: null }],
    [{ ...direct, type: 'unknown' }],
    [direct, { ...direct }],
    Array.from({ length: 1001 }, (_, index) => ({ ...channelRow, hsession_id: `channel-${index}`,
      channel_id: `channel-${index}@conference.xmpp.zoom.us`, i: String(index) })),
  ]) {
    await assert.rejects(runChat(fixture(data, undefined, 'user-self'), 'starred'), { code: 'UNSUPPORTED_CONTENT' });
  }
});
test('starred rows expose unknown field names without leaking unknown values', async () => {
  const [direct] = starredNative.data;
  const result = await runChat(fixture([{ ...direct, future_provider_field: 'private-value' }], undefined, 'user-self'), 'starred');
  assert.deepEqual(result.items[0].unknownFields, ['future_provider_field']);
  assert.equal(JSON.stringify(result).includes('private-value'), false);
});
test('folder state ignores native JSON key order and unrelated display metadata, not membership or order', async () => {
  const session = fixture();
  const before = await runChat(session, 'folders');
  session.rows[0].members = [{ index: '0', channelName: 'New display name', objid: channel }];
  const reordered = await runChat(session, 'folders');
  assert.equal(reordered.state, before.state);
  session.rows[0].members[0].index = '1';
  assert.notEqual((await runChat(session, 'folders')).state, before.state);
  session.rows[0].members = [];
  assert.notEqual((await runChat(session, 'folders')).state, before.state);
});
test('folder deletion refuses nonempty and system folders before any write', async () => {
  for (const data of [row(), { ...row(), type: 1, members: [] }]) {
    const session = fixture([data]), current = await runChat(session, 'folders');
    await assert.rejects(runChat(session, 'folder-delete', { folder: 'folder', 'if-state': current.state }), { code: data.type ? 'FORBIDDEN' : 'FOLDER_NOT_EMPTY' });
    assert.equal(session.writes, 0);
  }
});
test('stale folder state refuses mutation and uncertain acceptance is never retried', async () => {
  const session = fixture([{ ...row(), members: [] }]), before = await runChat(session, 'folders');
  session.rows[0].version++;
  await assert.rejects(runChat(session, 'folder-delete', { folder: 'folder', 'if-state': before.state }), { code: 'ORGANIZATION_CHANGED' });
  assert.equal(session.writes, 0);
  const fresh = await runChat(session, 'folders');
  await assert.rejects(runChat(session, 'folder-delete', { folder: 'folder', 'if-state': fresh.state }), { code: 'WRITE_UNCONFIRMED' });
  assert.equal(session.writes, 1);
});
test('native permission and rate-limit rejection remain explicit without replay', async () => {
  for (const code of ['FORBIDDEN', 'RATE_LIMITED']) {
    const session = fixture([{ ...row(), members: [] }], new AppError(code, 'Rejected'));
    const before = await runChat(session, 'folders');
    await assert.rejects(runChat(session, 'folder-delete', { folder: 'folder', 'if-state': before.state }), { code });
    assert.equal(session.writes, 1);
  }
});
