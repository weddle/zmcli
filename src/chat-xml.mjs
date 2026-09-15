import { DOMParser } from '@xmldom/xmldom';
import { AppError } from './session.mjs';

export function xml(value) {
  return String(value).replace(/[&<>"'\r\n\t]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;', '\n': '&#10;', '\t': '&#9;' })[character]);
}
export function parseXml(source) {
  if (typeof source !== 'string') {
    throw new AppError('UNSUPPORTED_CONTENT', 'Chat XML is unavailable.', { reason: 'MESSAGE_XML_UNAVAILABLE' });
  }
  if (source.length > 1024 * 1024) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Chat XML exceeds the supported input bound.', { reason: 'MESSAGE_XML_TOO_LARGE' });
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Chat XML entity declarations are not supported.', { reason: 'XML_ENTITY_DECLARATION_UNSUPPORTED' });
  }
  let normalized = source;
  if (/^\ufeff?<\?xml/i.test(normalized)) {
    const declaration = normalized.match(/^\ufeff?<\?xml[ \t\r\n]+version=(["'])1\.0\1(?:[ \t\r\n]+encoding=(["'])[Uu][Tt][Ff]-8\2)?(?:[ \t\r\n]+standalone=(["'])(?:yes|no)\3)?[ \t\r\n]*\?>/);
    if (!declaration) throw new AppError('UNSUPPORTED_CONTENT', 'Chat XML declaration is not in the safe supported form.', { reason: 'XML_DECLARATION_UNSAFE' });
    normalized = normalized.slice(declaration[0].length);
  }
  if (/<\?xml/i.test(normalized)) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Chat XML contains a misplaced or repeated declaration.', { reason: 'XML_DECLARATION_UNSAFE' });
  }
  try {
    const document = new DOMParser({ onError() { throw new Error('Malformed XML'); } }).parseFromString(normalized, 'application/xml');
    if (!document.documentElement) throw new Error('Missing root');
    return document.documentElement;
  } catch { throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned malformed XML.', { reason: 'MALFORMED_MESSAGE_XML' }); }
}
export function child(node, name, namespace) {
  for (let item = node?.firstChild; item; item = item.nextSibling) {
    if (item.nodeType === 1 && item.localName === name && (namespace === undefined || item.namespaceURI === namespace)) return item;
  }
  return null;
}
export function attr(node, name) { return node?.hasAttribute(name) ? node.getAttribute(name) : null; }

export function messageWire(record) {
  const root = parseXml(record.message);
  if (root.localName !== 'message') throw new AppError('UNSUPPORTED_CONTENT', 'Chat history XML is not a message.', { reason: 'NON_MESSAGE_XML' });
  const extension = child(root, 'zmext'), body = child(root, 'body'), reply = child(extension, 'reply'), deleted = child(extension, 'deleted');
  const messageType = child(extension, 'msg_type')?.textContent ?? null;
  const mentions = [], mentionReasons = new Set(), at = child(extension, 'at');
  for (let item = at?.firstChild; item; item = item.nextSibling) {
    if (item.nodeType !== 1) continue;
    if (item.localName !== 'user') { mentionReasons.add('UNSUPPORTED_MENTION_NODE'); continue; }
    const numeric = name => {
      const value = attr(item, name);
      return value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : value;
    };
    const mention = { type: numeric('t'), jid: attr(item, 'jid'), start: numeric('s'), end: numeric('e') };
    if (![1, 2, 3, 4, 5].includes(mention.type) || typeof mention.jid !== 'string'
      || !/^[A-Za-z0-9_.@-]{1,512}$/.test(mention.jid)
      || !Number.isSafeInteger(mention.start) || !Number.isSafeInteger(mention.end)
      || mention.start < 0 || mention.end < mention.start || !body || mention.end >= body.textContent.length) {
      mentionReasons.add('UNSUPPORTED_MENTION_METADATA');
    }
    for (let index = 0; index < item.attributes.length; index++) {
      if (!['t', 'jid', 's', 'e'].includes(item.attributes[index].name)) mentionReasons.add('UNSUPPORTED_MENTION_FIELDS');
    }
    mentions.push(mention);
  }
  const nativeTime = attr(extension, 't');
  const timestamp = record.timestamp === undefined
    ? nativeTime !== null && /^\d+$/.test(nativeTime) && Number.isSafeInteger(Number(nativeTime)) && Number(nativeTime) > 0 ? Number(nativeTime) : null
    : record.timestamp;
  const id = record.msg_id || attr(root, 'id'), from = (attr(root, 'from') || '').split('/')[0];
  const label = attr(child(extension, 'from'), 'n');
  const messageLocalLabel = typeof label === 'string' && label.trim() && label.length <= 1024 && from && id
    && (!attr(root, 'id') || attr(root, 'id') === id)
    ? { displayName: label, senderJid: from, messageId: id, source: 'native-message-envelope', confidence: 'message-local' } : null;
  return { id: record.msg_id || attr(root, 'id'), timestamp,
    from, to: attr(root, 'to'), type: attr(root, 'type'), messageLocalLabel,
    text: body?.textContent ?? null, messageType, deleted: deleted ? { deleter: attr(deleted, 'deleter') } : null,
    mentions, mentionCoverage: { complete: mentionReasons.size === 0, offsetUnit: 'utf16-inclusive', reasons: [...mentionReasons] },
    rawRichText: child(root, 'zmrt')?.textContent ?? null,
    contentKind: deleted ? 'deleted' : ['0', '17'].includes(messageType) && body ? 'message' : 'unsupported',
    replyTo: reply ? { id: attr(reply, 'msg_id'), owner: attr(reply, 'owner'), thread: attr(reply, 'thread_t') } : null };
}

export function unreadWire(root, from, channelSuffix) {
  const zoom = child(root, 'zoom', 'zoom:iq:ext');
  if (root.localName !== 'iq' || attr(root, 'type') !== 'result' || attr(root, 'from') !== from
    || attr(root, 'to') !== from || attr(zoom, 'type') !== 'offline'
    || attr(child(zoom, 'conference'), 'jid') !== channelSuffix.slice(1)) {
    throw new AppError('CHAT_IDENTITY_ERROR', 'Native offline index does not match this authenticated resource and channel domain.');
  }
  const number = (node, key, minimum = 0, optional = false) => {
    const value = attr(node, key);
    if (value === null && optional) return null;
    if (value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
      throw new AppError('UNSUPPORTED_CONTENT', `Native offline index has an unsupported ${key} watermark or count.`);
    }
    return Number(value);
  };
  const domain = from.split('/')[0].split('@')[1], sessions = [], seen = new Set();
  for (let row = zoom.firstChild; row; row = row.nextSibling) {
    if (row.nodeType !== 1 || row.localName !== 'acktime') continue;
    const sid = attr(row, 'session'), type = number(row, 'type', 1);
    if (typeof sid !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(sid) || ![1, 2].includes(type)) {
      throw new AppError('UNSUPPORTED_CONTENT', 'Native offline index contains an unsupported conversation identity or type.');
    }
    const id = type === 2 ? `${sid}${channelSuffix}` : `${sid}@${domain}`;
    if (seen.has(id)) throw new AppError('UNSUPPORTED_CONTENT', 'Native offline index repeats a conversation identity.');
    seen.add(id);
    const threads = [], threadTimes = new Set();
    for (let thread = row.firstChild; thread; thread = thread.nextSibling) {
      if (thread.nodeType !== 1 || thread.localName !== 'thread') continue;
      const timestamp = number(thread, 'thread_t', 1);
      if (threadTimes.has(timestamp)) throw new AppError('UNSUPPORTED_CONTENT', 'Native offline index repeats a thread watermark.');
      threadTimes.add(timestamp);
      threads.push({ timestamp, lastReadTime: number(thread, 'read'), unreadCount: number(thread, 'count'),
        directMentions: number(thread, 'mcount', 0, true), groupMentions: number(thread, 'mgcount', 0, true) });
    }
    sessions.push({ id, type: type === 2 ? 'groupchat' : 'chat', unreadCount: number(row, 'count'),
      lastReadTime: number(row, 'read'), lastUnreadTime: number(row, 'lastunread'),
      nativeAckTime: number(row, 'ack', 0, true), directMentions: number(row, 'mcount', 0, true),
      groupMentions: number(row, 'mgcount', 0, true), threads, raw: row.toString() });
  }
  return { sessions, version: number(zoom, 'version'), scope: 'native-resource-offline-acktime-index' };
}

// Current native MapStyleOffset fields, restricted to one root file/image attachment.
function varint(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new AppError('INVALID_ARGUMENT', 'Attachment protobuf requires an unsigned safe integer.');
  const bytes = [];
  do { const low = value % 128; value = Math.floor(value / 128); bytes.push(low | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function integer(field, value) { return Buffer.concat([varint(field * 8), varint(value)]); }
function data(field, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
}
export function attachmentRichText(attachment, image) {
  const giphy = attachment.extra?.type === 'giphy' ? attachment.extra.data : null;
  const primary = giphy?.images.bigPicInfo, dimension = primary ?? attachment.dimension;
  const imageType = giphy ? 67108864 : attachment.type === 'image/gif' ? 16777216 : attachment.type === 'image/png' ? 8388608 : 1048576;
  const fields = [integer(1, image ? imageType : 33554432), integer(2, 0), integer(3, 0),
    data(4, attachment.attachmentId), data(5, giphy ? `${attachment.attachmentId}.gif` : attachment.name), integer(6, primary?.size ?? attachment.size)];
  if (image) fields.push(data(7, Buffer.concat([integer(1, dimension.width), integer(2, dimension.height)])));
  else fields.push(data(9, ''));
  if (giphy) {
    const info = ({ size, url, width, height }) => ({ size, url, width, height });
    fields.push(data(9, JSON.stringify({ url: giphy.url, bigPicInfo: info(primary),
      mobileInfo: info(giphy.images.mobilePicInfo), pcInfo: info(giphy.images.pcPicInfo) })), data(10, ''));
  }
  return data(1, Buffer.concat(fields)).toString('base64');
}
