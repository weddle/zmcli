import test from 'node:test';
import assert from 'node:assert/strict';
import { messageWire, parseXml } from '../src/chat-xml.mjs';

test('standalone history preserves decoded text and exact reply identity without resolving entities', () => {
  const result = messageWire({ msg_id: 'reply-id', timestamp: 42, message: '<message from="alice@xmpp.zoom.us/resource" to="room@conference.xmpp.zoom.us" type="groupchat"><body>café &amp; &lt;safe&gt;</body><zmext><msg_type>17</msg_type><reply msg_id="parent-id" owner="bob@xmpp.zoom.us" thread_t="41"/></zmext></message>' });
  assert.equal(result.text, 'café & <safe>');
  assert.equal(result.from, 'alice@xmpp.zoom.us');
  assert.deepEqual(result.replyTo, { id: 'parent-id', owner: 'bob@xmpp.zoom.us', thread: '41' });
  assert.throws(() => parseXml('<!DOCTYPE message [<!ENTITY secret SYSTEM "file:///etc/passwd">]><message><body>&secret;</body></message>'), error => error.code === 'UNSUPPORTED_CONTENT');
  assert.throws(() => parseXml('<message><body>broken</message>'), error => error.code === 'UNSUPPORTED_CONTENT');
});
