import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openChatTransport } from '../src/chat-transport.mjs';

test('a fresh standalone unreadIndex initializes its resource before decoding the offline stanza', async () => {
  class Socket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 0;
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
    addEventListener(name, callback) { this.on(name, callback); }
    send(value) {
      if (value.startsWith('<open')) queueMicrotask(() => this.emit('message', { data: '<features/>' }));
      else if (value.includes('jabber:iq:auth')) {
        const id = value.match(/ id="([^"]+)"/)[1];
        queueMicrotask(() => {
          this.emit('message', { data: `<iq id="${id}" type="result"/>` });
          this.emit('message', { data: '<iq from="actor@xmpp.zoom.us/resource" to="actor@xmpp.zoom.us/resource" type="result"><zoom xmlns="zoom:iq:ext" type="offline" version="15"><conference jid="conference.xmpp.zoom.us"/><acktime session="peer" type="1" count="1" read="100" lastunread="200"/></zoom></iq>' });
        });
      }
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  }
  const config = { uid: 'actor', accountId: 'account', jid: 'actor@xmpp.zoom.us', domainList: {
    channelSessionDomain: '@conference.xmpp.zoom.us', microServiceDomain: 'xms.zoom.us', bffCFServerDomain: 'bff.zoom.us',
    ucsDomain: 'ucs.zoom.us', asyncImDomain: 'async.zoom.us', fileServerDomain: 'file.zoom.us', xmppWsDomain: 'xmpp.zoom.us',
  } };
  const token = { jid: config.jid, zak: 'fixture', xmppToken: 'fixture', resourceId: 'resource', deviceId: 'fixture' };
  const chat = await openChatTransport({ WebSocketClass: Socket, http: { request: async url => new Response(JSON.stringify({ status: true, result: url.includes('/newchat/token') ? token : config })) } });
  try {
    const index = await chat.unreadIndex();
    assert.equal(index.sessions[0].unreadCount, 1);
    assert.equal(index.sessions[0].lastReadTime, 100);
    assert.equal(index.sessions[0].lastUnreadTime, 200);
  } finally { await chat.dispose(); }
});
