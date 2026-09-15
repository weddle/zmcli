import test from 'node:test';
import assert from 'node:assert/strict';
import { runChat } from '../src/chat.mjs';

test('own-catalog filter cannot authorize deletion when native creator identity differs', async () => {
  let deletions = 0;
  const session = { openChat: async () => ({
    from: 'owner@xmpp.zoom.us/resource', identity: { user: { userId: 'owner', accountId: 'account' } },
    customEmoji: async operation => {
      if (operation === 'delete') { deletions++; return {}; }
      return { files: [{ fileId: 'asset', name: 'fixture.png', extName: 'png', attribute: { businessCode: 'fixture', userId: 'someoneElse' } }], searchAfter: '' };
    },
  }) };
  await assert.rejects(runChat(session, 'emoji-delete', { file: 'asset', name: 'fixture', 'expect-account': 'account' }), { code: 'FORBIDDEN' });
  assert.equal(deletions, 0);
});

test('moving custom catalog stops incomplete rather than hiding repeated identities', async () => {
  const asset = fileId => ({ fileId, attribute: { businessCode: fileId, userId: 'owner' } });
  const session = { openChat: async () => ({
    from: 'owner@xmpp.zoom.us/resource', identity: { user: { userId: 'owner', accountId: 'account' } },
    customEmoji: async (_operation, options) => options.searchAfter
      ? { files: [asset('first'), asset('second')], searchAfter: 'next' }
      : { files: [asset('first')], searchAfter: 'boundary' },
  }) };
  const first = await runChat(session, 'custom-emojis', {});
  const second = await runChat(session, 'custom-emojis', { cursor: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.fileId), ['second']);
  assert.equal(second.nextCursor, null);
  assert.equal(second.pagination.complete, false);
  assert.equal(second.pagination.reason, 'REPEATED_CATALOG_FILE');
});
