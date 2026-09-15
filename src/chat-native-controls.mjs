import { randomUUID } from 'node:crypto';
import { AppError, writeFailure } from './session.mjs';
import { attr, child, parseXml, xml } from './chat-xml.mjs';

export const nativeControlActions = new Set([
  'private-chat-info',
  'shared-spaces', 'shared-space-channels', 'shared-space-members',
  'shared-space-create', 'shared-space-rename', 'shared-space-delete', 'shared-space-add-member', 'shared-space-remove-member', 'shared-space-add-channel', 'shared-space-remove-channel',
  'channel-delete', 'channel-leave', 'channel-admin', 'channel-permission', 'channel-transfer-owner',
  'mark-read', 'mark-unread', 'read-watermark', 'reminders', 'reminder-set', 'reminder-edit', 'reminder-close',
  'draft-create', 'draft-edit', 'draft-delete', 'schedule-create', 'schedule-edit', 'schedule-delete', 'status-message',
  'presence', 'presence-set', 'available', 'away', 'busy', 'out-of-office', 'ooo',
]);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f\p{Cs}\ufffe\uffff]/u.test(value);
const integer = (value, name, minimum = 0) => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < minimum) throw new AppError('INVALID_INPUT', `${name} must be a safe integer >= ${minimum}.`);
  return n;
};
const required = (value, name) => { if (!text(value)) throw new AppError('INVALID_INPUT', `${name} is required.`); return value; };
const parseItems = (root, name) => { const node = child(root, name); const result = []; for (let item = node?.firstChild; item; item = item.nextSibling) if (item.nodeType === 1) result.push(item); return result; };
const ack = (result, operation) => {
  if (!result?.stanza) throw new AppError('WRITE_UNCONFIRMED', `Native ${operation} acknowledgement was not retained.`);
  const root = parseXml(result.stanza);
  if (root.localName !== 'iq' || attr(root, 'type') === 'error' || child(root, 'error')) throw new AppError('CHAT_SERVICE_ERROR', `Native ${operation} was rejected.`);
  return root;
};
async function iq(chat, to, body, operation) {
  const requestId = randomUUID();
  const stanza = `<iq from="${xml(chat.from)}"${to ? ` to="${xml(to)}"` : ''} id="${requestId}" type="set" xmlns="jabber:client">${body}</iq>`;
  let accepted = false;
  try { const result = await chat.sendIq(stanza, requestId, { responseXml: true }); accepted = true; return { requestId, root: ack(result, operation) }; }
  catch (error) { throw writeFailure(error, { operation: `chat.${operation}`, requestId, acceptance: accepted ? 'accepted' : 'unobserved' }); }
}
function csv(value, name, maximum = 100) {
  if (typeof value !== 'string') throw new AppError('INVALID_INPUT', `${name} must be comma-separated IDs.`);
  const values = value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  if (!values.length || values.length > maximum || new Set(values).size !== values.length || values.some(item => !/^[a-z0-9_-]+(?:@[^@/]+)?$/.test(item))) {
    throw new AppError('INVALID_INPUT', `${name} contains invalid or duplicate IDs.`);
  }
  return values;
}
function spaceRows(response, kind) {
  if (response.result !== 0 || !response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new AppError('UNSUPPORTED_CONTENT', `Native ${kind} response is unrecognized.`);
  const data = response.data, list = data.spaces ?? data.items ?? data.members;
  if (!Array.isArray(list) || list.length > 1000 || typeof data.haveMore !== 'boolean' || (data.lastValue !== undefined && typeof data.lastValue !== 'string')) throw new AppError('UNSUPPORTED_CONTENT', `Native ${kind} page is unrecognized.`);
  return { list, haveMore: data.haveMore, lastValue: data.lastValue ?? '', version: data.version };
}
async function spaces(chat, action, options) {
  const maxPages = integer(options['max-pages'] ?? 5, 'Max pages', 1); if (maxPages > 10) throw new AppError('INVALID_INPUT', 'Max pages must not exceed 10.');
  const out = []; let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const response = await chat.request('/xms/space/fetch/userId', { body: { limit: 50, ...(cursor ? { lastValue: cursor } : {}) } });
    const current = spaceRows(response, 'shared-space'); out.push(...current.list); if (!current.haveMore) return { items: out, nextCursor: null, pagination: { complete: true, pages: page + 1 }, scope: 'native-shared-spaces' };
    if (!current.lastValue || current.lastValue === cursor) throw new AppError('UNSUPPORTED_CONTENT', 'Native shared-space continuation did not advance.'); cursor = current.lastValue;
  }
  return { items: out, nextCursor: cursor, pagination: { complete: false, pages: maxPages, reason: 'PAGE_BOUND' }, scope: 'native-shared-spaces' };
}
async function spaceCollection(chat, action, options) {
  const spaceId = required(options.space, 'Space ID'); const isMembers = action === 'shared-space-members';
  const path = isMembers ? '/xms/space/fetch/members' : '/xms/space/fetch/items';
  const response = await chat.request(path, { body: { spaceId, limit: isMembers ? 200 : 50, ...(options.cursor ? { lastValue: options.cursor } : {}) } });
  const current = spaceRows(response, isMembers ? 'shared-space members' : 'shared-space channels');
  return { spaceId, items: current.list, nextCursor: current.haveMore ? current.lastValue : null, version: current.version,
    pagination: { complete: !current.haveMore, status: current.haveMore ? 'more' : 'end' }, scope: isMembers ? 'native-shared-space-members' : 'native-shared-space-channels' };
}
async function sharedSpaceMutation(chat, action, options) {
  if (action === 'shared-space-create') {
    const name = required(options.name, 'Space name'), general = required(options.general, 'General channel name');
    const spaceOption = integer(options['space-option'], 'Space option', 0), channelOption = integer(options['channel-option'], 'Channel option', 0);
    const body = `<zoom xmlns="zoom:iq:space" action="create"><space name="${xml(name)}" option="${spaceOption}" desc="${xml(options.description ?? '')}"/><room natural="${xml(general)}" subject="${xml(general)}" option="${channelOption}" e2e="0"/></zoom>`;
    const { requestId, root } = await iq(chat, chat.channelSuffix.slice(1), body, action); const space = child(root, 'space', 'zoom:iq:space') ?? child(root, 'space');
    const id = attr(space, 'id') ?? attr(space, 'uuid'); if (!id) throw new AppError('WRITE_UNCONFIRMED', 'Shared-space creation acknowledgement supplied no space identity.');
    return { requestId, spaceId: id, name, outcome: 'confirmed', acceptance: 'native-iq-acknowledgement', verified: true };
  }
  const spaceId = required(options.space, 'Space ID'), actionName = { 'shared-space-rename': 'edit', 'shared-space-delete': 'delete', 'shared-space-add-member': 'invite', 'shared-space-remove-member': 'kick', 'shared-space-add-channel': 'link', 'shared-space-remove-channel': 'unlink' }[action];
  if (!actionName) throw new AppError('INVALID_INPUT', 'Unsupported shared-space mutation.');
  let inner = '';
  if (action === 'shared-space-rename') inner = `<space name="${xml(required(options.name, 'Space name'))}" option="${integer(options['space-option'], 'Space option', 0)}" desc="${xml(options.description ?? '')}"/>`;
  if (action === 'shared-space-add-member') inner = `<buddylist>${csv(options.members, 'Members').map(jid => `<item role="30">${xml(jid.includes('@') ? jid : `${jid}@${chat.from.split('@')[1].split('/')[0]}`)}</item>`).join('')}</buddylist>`;
  if (action === 'shared-space-remove-member') inner = `<buddylist>${csv(options.members, 'Members').map(jid => `<item>${xml(jid)}</item>`).join('')}</buddylist>`;
  if (action === 'shared-space-add-channel') inner = `<room option="${integer(options['channel-option'], 'Channel option', 0)}">${xml(required(options.channel, 'Channel ID'))}</room>`;
  if (action === 'shared-space-remove-channel') inner = `<room>${xml(required(options.channel, 'Channel ID'))}</room>`;
  const { requestId } = await iq(chat, spaceId, `<zoom xmlns="zoom:iq:space" action="${actionName}">${inner}</zoom>`, action);
  return { requestId, spaceId, outcome: 'accepted', acceptance: 'native-iq-acknowledgement', verified: false, reconciliation: 'Re-read shared-space members/channels before retrying.' };
}
async function lifecycle(chat, action, options, deps) {
  const id = required(options.channel, 'Channel ID'), info = await deps.writeChannelInfo(chat, deps.channelId(id, chat.channelSuffix));
  const actor = chat.identity.user.userId.toLowerCase();
  if (action === 'channel-delete' && info.owner !== actor) throw new AppError('FORBIDDEN', 'Channel deletion requires the verified owner.');
  if (action === 'channel-transfer-owner' || action === 'channel-admin' || action === 'channel-permission') {
    const member = required(options.member, 'Member JID'), display = options.name ?? member.split('@')[0];
    const nativeAction = action === 'channel-transfer-owner' ? 'transfer' : options.role === 'admin' ? 'add_admin' : options.role === 'member' ? 'del_admin' : null;
    if (!nativeAction) throw new AppError('INVALID_INPUT', 'Role must be admin or member.');
    const { requestId } = await iq(chat, id, `<zoom action="${nativeAction}" xmlns="zoom:iq:room"><buddylist><item displayName="${xml(display)}">${xml(member)}</item></buddylist></zoom>`, action);
    return { requestId, channelId: id, member, role: action === 'channel-transfer-owner' ? 'owner' : options.role, outcome: 'accepted', acceptance: 'native-iq-acknowledgement', verified: false, reconciliation: 'Re-read channel membership before retrying.' };
  }
  const nativeAction = action === 'channel-delete' ? 'delete' : 'quit';
  const { requestId } = await iq(chat, id, `<zoom action="${nativeAction}" xmlns="zoom:iq:room"/>`, action);
  return { requestId, channelId: id, outcome: 'accepted', acceptance: 'native-iq-acknowledgement', verified: false, reconciliation: 'Re-read channel info and membership before retrying.' };
}
function manualUnreadRows(response) {
  if (response.result !== 0 || !Array.isArray(response.data)) throw new AppError('UNSUPPORTED_CONTENT', 'Native manual unread index is unrecognized.');
  return response.data;
}
async function markState(chat, action, options, target) {
  const timestamp = integer(options.timestamp, 'Message timestamp', 1), before = manualUnreadRows(await chat.request('/xms/murd/fetch', { body: { sessions: [target] } }));
  const present = before.some(row => Array.isArray(row?.[target]) && row[target].map(String).includes(String(timestamp)));
  if (action === 'mark-unread' && present) return { conversationId: target, timestamp, outcome: 'unchanged', verified: true };
  if (action === 'mark-read' && !present) return { conversationId: target, timestamp, outcome: 'unchanged', verified: true };
  const nativeAction = action === 'mark-unread' ? 'mark' : 'unmark', requestId = randomUUID();
  let accepted = false;
  try { await chat.sendIq(`<iq from="${xml(chat.from)}" id="${requestId}" type="set" xmlns="jabber:client"><query action="${nativeAction}" xmlns="zoom:iq:mark"><session id="${xml(target)}" timeframe="${timestamp}" type="${target.includes('@conference.') ? 'groupchat' : 'chat'}"/></query></iq>`, requestId); accepted = true;
    const after = manualUnreadRows(await chat.request('/xms/murd/fetch', { body: { sessions: [target] } }));
    const nowPresent = after.some(row => Array.isArray(row?.[target]) && row[target].map(String).includes(String(timestamp)));
    if (nowPresent !== (action === 'mark-unread')) throw new AppError('READBACK_MISMATCH', 'Manual unread transition was not observed.');
    return { requestId, conversationId: target, timestamp, outcome: 'confirmed', acceptance: 'native-iq-and-unread-index-readback', verified: true };
  } catch (error) { throw writeFailure(error, { operation: `chat.${action}`, requestId, acceptance: accepted ? 'accepted' : 'unobserved' }); }
}
async function watermark(chat, options, target) {
  const timestamp = integer(options.timestamp ?? Date.now(), 'Read timestamp', 1), requestId = randomUUID();
  const id = target.split('@')[0], group = target.includes('@conference.') ? ' group="1"' : '';
  let accepted = false;
  try { await chat.sendIq(`<iq from="${xml(chat.from)}" id="${requestId}" type="get" xmlns="jabber:client"><zoom xmlns="zoom:iq:read" from="${xml(id)}"${group}><item time="${timestamp}"/></zoom></iq>`, requestId); accepted = true; return { requestId, conversationId: target, timestamp, outcome: 'accepted', acceptance: 'native-read-watermark-acknowledgement', verified: false }; }
  catch (error) { throw writeFailure(error, { operation: 'chat.read-watermark', requestId, acceptance: accepted ? 'accepted' : 'unobserved' }); }
}
async function reminders(chat, action, options, target) {
  const limit = integer(options.limit ?? 20, 'Limit', 1); if (limit > 100) throw new AppError('INVALID_INPUT', 'Reminder limit must not exceed 100.');
  if (action === 'reminders') {
    const response = await chat.request('/xms/reminder/fetch', { body: { limit, sessionId: target ?? 'all', ...(options.cursor ? { lastValue: options.cursor } : {}) } });
    if (response.result !== 0 || !response.data || !Array.isArray(response.data.items) || response.data.items.length > limit || typeof response.data.haveMore !== 'boolean') throw new AppError('UNSUPPORTED_CONTENT', 'Native reminder page is unrecognized.');
    return { items: response.data.items, nextCursor: response.data.haveMore ? response.data.lastValue ?? null : null, version: response.data.version, scope: 'native-reminder-index', pagination: { complete: !response.data.haveMore } };
  }
  const timestamp = integer(options.timestamp, 'Message timestamp', 1), session = required(target, 'Conversation ID');
  let body;
  if (action === 'reminder-set') body = `<query xmlns="zoom:iq:reminder" action="set"><item session="${xml(session)}" t="${timestamp}" reminder_t="${integer(options['reminder-t'], 'Reminder seconds', 1)}" note="${xml(options.note ?? '')}" display_t="${integer(options['display-t'] ?? timestamp, 'Display timestamp', 1)}" msg_id="${xml(options.message ?? '')}" content="${xml(options.content ?? '')}"><sns><format>%1$@</format><args><arg>${xml(options.content ?? '')}</arg></args></sns></item></query>`;
  else if (action === 'reminder-edit') body = `<query xmlns="zoom:iq:reminder" action="edit"><item session="${xml(session)}" t="${timestamp}" reminder_t="${integer(options['reminder-t'], 'Reminder seconds', 1)}" note="${xml(options.note ?? '')}"/></query>`;
  else if (action === 'reminder-close') body = `<query xmlns="zoom:iq:reminder" action="close"><item session="${xml(session)}" t="${timestamp}"/></query>`;
  else throw new AppError('INVALID_INPUT', 'Unsupported reminder action.');
  const { requestId } = await iq(chat, null, body, action); return { requestId, conversationId: session, timestamp, outcome: 'accepted', acceptance: 'native-iq-acknowledgement', verified: false, reconciliation: 'Re-read reminders before retrying.' };
}
function draftMessage(chat, session, options) {
  const id = options['message-id'] ?? options.message ?? (options['draft-id'] ? `${options['draft-id']}-message` : randomUUID());
  const body = required(options.text, 'Draft text');
  const page = { type: 'Page', children: [{ type: 'Paragraph', content: [{ data: body }] }] };
  return `<message xmlns="jabber:client" from="${xml(chat.from)}" id="${xml(id)}" to="${xml(session)}" type="${session.includes('@conference.') ? 'groupchat' : 'chat'}"><zmrt>${xml(JSON.stringify(page))}</zmrt><body>${xml(body)}</body><zmext><msg_type>17</msg_type><visible>true</visible><msg_feature>32768</msg_feature></zmext></message>`;
}
async function drafts(chat, action, options, target) {
  if (action === 'drafts') throw new AppError('UNSUPPORTED_CAPABILITY', 'Native network draft listing is unavailable.');
  const creating = action === 'draft-create' || action === 'schedule-create';
  const draftId = options['draft-id'] ?? options.draft ?? (creating ? randomUUID() : null);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(draftId ?? '')) throw new AppError('INVALID_INPUT', 'Supply an exact native draft ID.');
  const session = required(target, 'Conversation ID'), type = integer(options['draft-type'] ?? 0, 'Draft type', 0);
  if (type > 1) throw new AppError('INVALID_INPUT', 'Draft type must be 0 or 1.');
  if (action === 'draft-delete' || action === 'schedule-delete') {
    const { requestId } = await iq(chat, null, `<query xmlns="zoom:iq:draft" action="delete"><item id="${xml(draftId)}" session="${xml(session)}"/></query>`, action);
    return { requestId, draftId, outcome: 'accepted', acceptance: 'native-iq-acknowledgement', verified: false, reconciliation: 'Re-read network drafts before retrying.' };
  }
  const sendTime = integer(options['send-time'] ?? 0, 'Send time', 0);
  if (action === 'schedule-create' && sendTime <= Date.now()) throw new AppError('INVALID_INPUT', 'Scheduled send time must be in the future.');
  const sendSeconds = sendTime > 0 ? Math.max(0, Math.ceil((sendTime - Math.floor(Date.now() / 60000) * 60000) / 1000)) : 0;
  const message = draftMessage(chat, session, options), create = action === 'draft-create' || action === 'schedule-create', nativeAction = create ? 'create' : 'update';
  const itemAttrs = `id="${xml(draftId)}" type="${type}"${create ? ` create_t="${Date.now()}"` : ''} send_t="${sendSeconds}"${sendTime > 0 ? ` schedule_t="${sendTime}"` : ''}`;
  const { requestId } = await iq(chat, null, `<query xmlns="zoom:iq:draft" action="${nativeAction}"><item ${itemAttrs}>${message}</item></query>`, action);
  return { requestId, draftId, sessionId: session, sendTime, outcome: 'accepted', acceptance: 'native-iq-acknowledgement', verified: false, reconciliation: 'Re-read network drafts before retrying.' };
}
async function presence(chat, action, options) {
  const custom = action === 'status-message';
  const mode = custom ? (options.mode ?? 'available') : action === 'presence-set' || action === 'presence' ? required(options.mode, 'Presence mode') : action === 'ooo' || action === 'out-of-office' ? 'ooo' : action;
  const map = { available: { show: 'available', status: custom ? required(options.message, 'Status message') : 'NA', manual: 1 }, away: { show: 'away', status: custom ? required(options.message, 'Status message') : 'NA', manual: 1 }, busy: { show: 'away', status: custom ? required(options.message, 'Status message') : 'BUSY', manual: 0 }, ooo: { show: 'away', status: custom ? required(options.message, 'Status message') : 'OOO', manual: 0 } };
  const state = map[mode]; if (!state || state.status.length > 140) throw new AppError('INVALID_INPUT', 'Presence mode must be available, away, busy or ooo and status messages must be <=140 characters.');
  const requestId = randomUUID(), now = Math.floor(Date.now() / 1000), policy = custom ? '' : mode === 'busy'
    ? JSON.stringify({ type: 'reportpolicy', id: randomUUID(), action: 'set', scope: 'busy', prespolicy: { busy: { from: now, to: now + 86400 } } })
    : mode === 'ooo' ? JSON.stringify({ type: 'reportpolicy', id: randomUUID(), action: 'set', scope: 'ooo', prespolicy: { ooo: { from: now, to: now + 2592000 } } })
      : mode === 'available' && ['busy', 'ooo'].includes(options.previous)
        ? JSON.stringify({ type: 'reportpolicy', id: randomUUID(), action: 'del', scope: options.previous, prespolicy: {} }) : '';
  const json = JSON.stringify({ type: 'updatepres', id: requestId, pres: state });
  const stanza = `<presence from="${xml(chat.from)}" xmlns="jabber:client">${state.show === 'away' ? '<show>away</show>' : ''}<status>${xml(state.status)}</status><priority>15</priority>${state.manual ? '<manual>1</manual>' : '<zcap>e2e:none</zcap>'}</presence>`;
  try { if (policy) await chat.sendStanza(policy); await chat.sendStanza(json); await chat.sendStanza(stanza); return { requestId, mode, status: state.status, outcome: 'accepted', acceptance: custom ? 'native-presence-status-transmission' : 'native-presence-transmission', verified: false, reconciliation: 'Presence readback requires the native client/session presence observer; no retransmission is attempted.' }; }
  catch (error) { throw writeFailure(error, { operation: `chat.${action}`, requestId, acceptance: 'unobserved' }); }
}
async function privateChatInfo(chat, options, deps) {
  const target = await deps.target(options, 'read'), info = await deps.readChannelInfo(chat, deps.channelId(target, chat.channelSuffix));
  if (Number(info.type) !== 0 && Number(info.type) !== 1) throw new AppError('UNSUPPORTED_PRIVATE_CHAT', 'Native target is not a two-person private chat.');
  return { conversationId: target, type: 'private-chat', title: info.name ?? null, encrypted: info.e2e !== '0', memberCount: info.memberCount ?? null, scope: 'native-private-chat-info' };
}
export async function runNativeControl(chat, action, options, deps) {
  if (action === 'shared-spaces') return spaces(chat, action, options);
  if (action === 'shared-space-channels' || action === 'shared-space-members') return spaceCollection(chat, action, options);
  if (action.startsWith('shared-space-')) return sharedSpaceMutation(chat, action, options);
  if (['channel-delete', 'channel-leave', 'channel-admin', 'channel-permission', 'channel-transfer-owner'].includes(action)) return lifecycle(chat, action, options, deps);
  if (action === 'mark-read' || action === 'mark-unread') return markState(chat, action, options, await deps.target(options, 'write'));
  if (action === 'read-watermark') return watermark(chat, options, await deps.target(options, 'write'));
  if (action.startsWith('reminder')) {
    const target = action === 'reminders' && options.channel === undefined && options.group === undefined
      && options.email === undefined && options.session === undefined ? undefined : await deps.target(options, action === 'reminders' ? 'read' : 'write');
    return reminders(chat, action, options, target);
  }
  if (action.startsWith('draft') || action.startsWith('schedule')) {
    return drafts(chat, action, options, action === 'drafts' ? undefined : await deps.target(options, 'write'));
  }
  if (['presence', 'presence-set', 'available', 'away', 'busy', 'out-of-office', 'ooo', 'status-message'].includes(action)) return presence(chat, action, options);
  if (action === 'private-chat-info') return privateChatInfo(chat, options, deps);
  throw new AppError('INVALID_INPUT', 'Unsupported native Chat control.');
}
