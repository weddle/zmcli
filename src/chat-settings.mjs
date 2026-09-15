import { randomUUID } from 'node:crypto';
import { AppError, writeFailure } from './session.mjs';
import { attr, child, parseXml, xml } from './chat-xml.mjs';

async function notificationSettings(chat, target) {
  const requestId = randomUUID();
  const result = await chat.sendIq(`<iq from="${xml(chat.from)}" id="${requestId}" type="get" xmlns="jabber:client"><query xmlns="zoom:iq:notify"><mucnotify xmlns="zoom:notify:mucnotify"/></query></iq>`, requestId, { responseXml: true });
  const root = parseXml(result.stanza), query = child(root, 'query', 'zoom:iq:notify'), list = child(query, 'mucnotify', 'zoom:notify:mucnotify');
  if (!list) throw new AppError('UNSUPPORTED_CONTENT', 'Native notification override catalog is missing. No default was inferred.');
  const seen = new Set();
  let mode = 'inherit';
  for (let item = list.firstChild; item; item = item.nextSibling) {
    if (item.nodeType !== 1) continue;
    const jid = attr(item, 'v'), type = attr(item, 'type');
    if (item.localName !== 'item' || !jid || !['all', 'mention', 'off'].includes(type) || seen.has(jid) || seen.size >= 1000) {
      throw new AppError('UNSUPPORTED_CONTENT', 'Native notification override identity or mode is unrecognized.');
    }
    seen.add(jid);
    if (jid === target) mode = type;
  }
  return { conversationId: target, mode, scope: 'native-per-conversation-notification-override',
    effectiveNotifications: 'unknown', exclusions: ['global-notifications', 'muted-conversations', 'operating-system-notifications', 'presence'], snapshot: false };
}

export async function runNotificationSettings(chat, action, options, target) {
  const before = await notificationSettings(chat, target);
  if (action === 'notification-settings') return before;
  if (!['all', 'mention', 'off', 'inherit'].includes(options.mode)) throw new AppError('INVALID_INPUT', 'Notification mode must be all, mention, off or inherit.');
  if (before.mode !== options['if-mode']) throw new AppError('SETTINGS_CHANGED', 'The native override no longer matches --if-mode. Nothing sent.');
  if (before.mode === options.mode) return { ...before, outcome: 'unchanged' };
  const requestId = randomUUID(), removing = options.mode === 'inherit';
  const context = { operation: `chat.${action}`, requestId, conversationId: target };
  let accepted = false;
  try {
    await chat.sendIq(`<iq from="${xml(chat.from)}" id="${requestId}" to="${xml(chat.from.split('/')[0])}" type="set" xmlns="jabber:client"><query sync="true" xmlns="zoom:iq:notify"><mucnotify storage="${removing ? 'remove' : 'update'}" xmlns="zoom:notify:mucnotify"><item type="${removing ? before.mode : options.mode}" v="${xml(target)}"/></mucnotify></query></iq>`, requestId);
    accepted = true;
    const after = await notificationSettings(chat, target);
    if (after.mode !== options.mode) throw new AppError('READBACK_MISMATCH', 'Requested notification override was not observed. Reconcile before retrying.');
    return { ...context, ...after, outcome: 'confirmed', acceptance: 'native-iq-and-override-readback', concurrency: 'non-atomic-mode-precondition' };
  } catch (error) { throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }); }
}
