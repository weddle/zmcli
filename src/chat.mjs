import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { AppError, writeFailure } from './session.mjs';
import { cursorScope, decodeCursor, encodeCursor } from './cursor.mjs';
import { BOUNDARY_LIMIT, completeHistoryPage } from './history-page.mjs';
import { inspectAttachmentMedia } from './chat-media.mjs';
import { stepError, resolveChatTime, finishChatRead, enforceChatStrict, dimension } from './chat-feedback.mjs';
import { readActivity } from './chat-activity.mjs';
import { organizationActions, runOrganization } from './chat-organization.mjs';
import { runNotificationSettings } from './chat-settings.mjs';
import { runNativeControl, nativeControlActions } from './chat-native-controls.mjs';

// Current native recent-store preview allowlist, not all Chat event types.
const PREVIEW_MESSAGE_TYPES = [0, 1, 2, 3, 5, 6, 7, 10, 12, 13, 17, 18, 81, 87, 101, 102, 103, 104, 105, 900, 55, 212, 213, 214, 211, 65536, 65537, 65538, 65541, 65542, 65543, 65546, 65549, 65553, 65554, 65617, 65637, 65638, 65639, 65640, 65641];

export function validateChannelId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+(?:@conference\.[A-Za-z0-9.-]+\.zoom\.us)?$/.test(value)) {
    throw new AppError('INVALID_INPUT', 'Use a bare channel ID or a full Zoom channel JID.');
  }
}

export function parseMessageLink(value) {
  const invalid = () => new AppError('INVALID_INPUT', 'Supply a canonical HTTPS Zoom channel or two-person message link from Copy message link.');
  if (typeof value !== 'string' || value.length > 4096) throw invalid();
  const match = /^https:\/\/zoom\.us\/launch\/chat\/v2\/([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[0] !== value) throw invalid();
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.toString('base64') !== match[1]) throw invalid();
  let text, payload;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    payload = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || ![3, 4].includes(Object.keys(payload).length)
    || !Object.hasOwn(payload, 'sid') || !Object.hasOwn(payload, 'mid') || !Object.hasOwn(payload, 'time')
    || JSON.stringify(payload) !== text
    || typeof payload.sid !== 'string'
    || typeof payload.mid !== 'string' || !/^[A-Za-z0-9_-]+(?![\s\S])/.test(payload.mid)
    || !Number.isSafeInteger(payload.time) || payload.time <= 0) throw invalid();
  const channel = /^[A-Za-z0-9_-]+@conference\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+zoom\.us(?![\s\S])/.test(payload.sid);
  if (channel) {
    if (Object.keys(payload).length !== 3) throw invalid();
  } else {
    const user = value => typeof value === 'string' && /^[A-Za-z0-9_-]+@(?:[A-Za-z0-9-]+\.)+zoom\.us(?![\s\S])/.test(value)
      && !value.includes('@conference.');
    if (Object.keys(payload).length !== 4 || !user(payload.sid) || !user(payload.sid2) || payload.sid === payload.sid2) throw invalid();
    return { direct: { sid: payload.sid, sid2: payload.sid2 }, message: payload.mid, time: payload.time };
  }
  return { channel: payload.sid, message: payload.mid, time: payload.time };
}

function channelId(value, suffix) {
  validateChannelId(value);
  if (typeof suffix !== 'string' || !/^@[A-Za-z0-9.-]+$/.test(suffix)) {
    throw new AppError('CHAT_CONFIGURATION_ERROR', 'Chat did not provide a usable channel domain.');
  }
  if (typeof value !== 'string') throw new AppError('INVALID_INPUT', 'Supply a channel ID.');
  const bare = value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
  if (!/^[A-Za-z0-9_-]+$/.test(bare)) throw new AppError('INVALID_INPUT', 'Use a bare channel ID or a full channel JID from this Chat service.');
  return { bare, jid: bare + suffix };
}

function summary(jid, channel) {
  const channelAccountId = channel.channelAccountId ?? (typeof channel.account === 'string' && channel.account ? channel.account : null);
  const authenticatedAccountId = channel.authenticatedAccountId ?? null;
  const accessScope = channel.accessScope ?? (channelAccountId && authenticatedAccountId
    ? channelAccountId === authenticatedAccountId ? 'same-account' : 'shared-cross-tenant' : null);
  const encrypted = channel.e2e === undefined || channel.e2e === null ? null : channel.e2e !== '0';
  const nativeOption = channel.optionStr ?? channel.option ?? null;
  const incompleteFields = [
    [channelAccountId, 'channelAccountId'], [channel.owner, 'ownerId'], [channel.type, 'type'],
    [channel.e2e, 'encrypted'], [channel.memberCount, 'memberCount'], [nativeOption, 'nativeOption'],
  ].filter(([value]) => value === undefined || value === null).map(([, name]) => name);
  return {
    id: jid, title: typeof channel.name === 'string' ? channel.name : '',
    channelAccountId, authenticatedAccountId, accessScope,
    ownerId: channel.owner ?? null, type: channel.type ?? null,
    memberCount: channel.memberCount ?? null, role: channel.role ?? null,
    encrypted, nativeOption, incompleteFields,
  };
}

async function channelInfo(chat, id, accessMode) {
  if (!['read', 'write'].includes(accessMode)) throw new AppError('CHAT_CONFIGURATION_ERROR', 'Channel metadata lookup requires an explicit read or write access mode.');
  const response = await chat.request('/xms/channel/infos', { body: [{
    groupJid: id.jid, needDetail: true, needRole: true, needCount: true,
    disableCache: true, filterBot: 1, checkPermissionByGroupJid: true,
  }] });
  const channel = response.data?.[id.jid];
  if ((response.result !== undefined && response.result !== 0) || !channel || typeof channel !== 'object'
    || Array.isArray(channel) || typeof channel.name !== 'string') {
    throw new AppError('NOT_FOUND_OR_FORBIDDEN', 'Authoritative channel metadata was unavailable to this authenticated session; no absence was inferred.');
  }
  for (const key of ['jid', 'groupJid', 'channelId']) {
    if (channel[key] !== undefined && channel[key] !== id.jid && channel[key] !== id.bare) {
      throw new AppError('CHANNEL_IDENTITY_MISMATCH', 'Authoritative channel metadata identified a different channel.', {
        requestedChannelId: id.jid, identityField: key,
        authoritativeChannelId: typeof channel[key] === 'string' && /^[A-Za-z0-9_.@-]{1,512}$/.test(channel[key]) ? channel[key] : null,
      });
    }
  }
  const accountIdentity = chat.identity?.account?.accountId, userIdentity = chat.identity?.user?.accountId;
  if (accountIdentity && userIdentity && accountIdentity !== userIdentity) throw new AppError('CHAT_IDENTITY_ERROR', 'Authenticated account identities disagree.');
  const authenticatedAccountId = accountIdentity ?? userIdentity;
  if (typeof authenticatedAccountId !== 'string' || !authenticatedAccountId) throw new AppError('CHAT_CONFIGURATION_ERROR', 'Chat did not provide a usable authenticated account identity.');
  if (channel.account !== undefined && channel.account !== null && (typeof channel.account !== 'string' || !channel.account)) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Authoritative channel account metadata is malformed.');
  }
  const channelAccountId = channel.account ?? null;
  const accessScope = channelAccountId === null ? null
    : channelAccountId === authenticatedAccountId ? 'same-account' : 'shared-cross-tenant';
  return { ...channel, channelAccountId, authenticatedAccountId, accessScope,
    requestedAccessMode: accessMode, metadataAuthoritative: true };
}

const readChannelInfo = (chat, id) => channelInfo(chat, id, 'read');
const writeChannelInfo = (chat, id) => channelInfo(chat, id, 'write');

async function indexedConversation(chat, message, expectedGroupUsers, rooms, peers, expectedId) {
  if (message.type === 'groupchat') {
    if (typeof message.to !== 'string' || !message.to.endsWith(chat.channelSuffix)) throw new AppError('UNSUPPORTED_CONVERSATION_TYPE', 'Indexed room does not use this Chat service’s channel domain.');
    if (expectedId !== undefined && message.to !== expectedId) throw new AppError('UNSUPPORTED_CONVERSATION_INDEX', 'Native index and message addressing disagree. No different conversation was fetched.');
    const id = channelId(message.to, chat.channelSuffix);
    if (!rooms.has(id.jid)) {
      try {
        const metadata = await readChannelInfo(chat, id);
        let audience = null;
        if (Number(metadata.type) === 3) {
          if (!expectedGroupUsers) throw new AppError('GROUP_AUDIENCE_REQUIRED', 'Group-DM index routing requires --expect-users.');
          audience = await groupAudience(chat, id, metadata, expectedGroupUsers);
        } else if (![1, 2].includes(Number(metadata.type))) {
          throw new AppError('UNSUPPORTED_CONVERSATION_TYPE', 'Indexed conversation is not a verified channel or ordinary group DM.');
        }
        rooms.set(id.jid, { metadata, audience });
      } catch (error) {
        rooms.set(id.jid, { error }); throw error;
      }
    }
    const room = rooms.get(id.jid);
    if (room.error) throw room.error;
    return room.audience ? { channel: null, direct: null, group: { ...id, ...room } }
      : { channel: id, direct: null, group: null };
  }
  if (message.type === 'chat') {
    const self = chat.from.split('/')[0], peer = message.from === self ? message.to : message.to === self ? message.from : null;
    if (!peer) throw new AppError('UNSUPPORTED_DIRECT_MESSAGE', 'The indexed direct message does not belong to this authenticated pair.');
    if (expectedId !== undefined && peer !== expectedId) throw new AppError('UNSUPPORTED_CONVERSATION_INDEX', 'Native index and direct peer disagree. No different peer was resolved.');
    if (!peers.has(peer)) peers.set(peer, directPeer(chat, peer));
    return { channel: null, direct: await peers.get(peer), group: null };
  }
  throw new AppError('UNSUPPORTED_CONVERSATION_TYPE', 'The native index conversation type is unrecognized.');
}

async function searchMessages(chat, options) {
  const query = options.query;
  if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new AppError('INVALID_INPUT', 'Supply a message query of 1–1000 characters.');
  const limit = integer(options.limit ?? 99, 'Limit', 1);
  if (limit > 99) throw new AppError('INVALID_INPUT', 'Message search limit must not exceed 99.');
  if (!chat.messageSearchEnabled) throw new AppError('FORBIDDEN', 'Message search is not enabled in this Chat session.');
  if (!chat.unlimitedSearchRetention) throw new AppError('UNSUPPORTED_SEARCH_RETENTION', 'This account has bounded or unrecognized search retention. Its time-filter contract is not yet verified; no search was sent.');
  const self = chat.from?.split('/')[0], account = chat.identity?.user?.accountId;
  if (!self || !account) throw new AppError('CHAT_CONFIGURATION_ERROR', 'Message search requires the authenticated actor and account.');
  const expectedGroupUsers = options['expect-users'] === undefined ? null : groupUsers(chat, options['expect-users']);
  const scope = [...cursorScope('chat search', options), self, account, ...(expectedGroupUsers ? [expectedGroupUsers] : [])];
  const position = options.cursor ? decodeCursor(options.cursor, scope) : null;
  const response = await chat.request('/nws/asyncim/1.0/api/search/message', { body: {
    keyword: query, pageSize: limit, sortType: 2, searchSourceType: 2, archivedSessionStatus: 2,
    starred: false, atJidList: [], messageType: 2, cmcSessionScope: 3, pilotFeatureList: [1],
    onlyP2P: false, pageNum: 1, mynotesStartTime: 0, p2pStartTime: 0, mucStartTime: 0,
    channelStartTime: 0, startTime: 0, endTime: 0, ...(position ? { searchAfter: position.token } : {}),
  } });
  if (response.errorCode !== 0 || !Array.isArray(response.msgResults)
    || !Number.isSafeInteger(response.totalSize) || response.totalSize < 0 || typeof response.searchAfter !== 'string') {
    throw new AppError('CHAT_SEARCH_ERROR', 'Chat did not return a recognized message-search result.');
  }
  const items = [], unsupportedItems = [], seen = new Set(position?.seen), reasons = new Set(), directUsers = new Map(), indexedRooms = new Map();
  for (const row of response.msgResults) {
    if (!row || typeof row.msgId !== 'string' || !/^[A-Za-z0-9_-]+(?![\s\S])/.test(row.msgId)
      || !Number.isSafeInteger(row.sendTime) || row.sendTime <= 0
      || !Number.isSafeInteger(row.parentTime) || row.parentTime < 0 || typeof row.content !== 'string') {
      throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned an unrecognized message-search record.');
    }
    let channel, direct, group;
    try {
      if (row.chatType?.type === 2 && row.parentTime) throw new AppError('UNSUPPORTED_DIRECT_MESSAGE', 'Only exact two-person root hits are verified.');
      ({ channel, direct, group } = await indexedConversation(chat, {
        type: row.chatType?.type === 1 ? 'groupchat' : row.chatType?.type === 2 ? 'chat' : null,
        from: row.senderJid, to: row.chatType?.receiverJid,
      }, expectedGroupUsers, indexedRooms, directUsers));
    } catch (error) {
      if (['AUTH_REQUIRED', 'PROVIDER_APPROVAL_REQUIRED', 'RATE_LIMITED', 'SESSION_CLOSED', 'UNEXPECTED_REDIRECT'].includes(error?.code)) throw error;
      unsupportedItems.push({ id: row.msgId, reason: error instanceof AppError ? error.code : 'UNSUPPORTED_CONVERSATION_TYPE' });
      reasons.add('UNSUPPORTED_RESULTS'); continue;
    }
    if (row.parentTime && (typeof row.parentId !== 'string' || !/^[A-Za-z0-9_-]+(?![\s\S])/.test(row.parentId))) {
      throw new AppError('UNSUPPORTED_CONTENT', 'The search reply lacks a usable parent identity.');
    }
    const key = `${channel?.jid ?? group?.jid ?? direct.jid}:${row.msgId}`;
    if (seen.has(key)) { reasons.add('DUPLICATE_MESSAGE_IDS'); continue; }
    seen.add(key);
    const parent = row.parentTime ? { id: row.parentId, timestamp: row.parentTime } : null;
    const payload = { sid: channel?.jid ?? group?.jid ?? direct.jid, ...(direct ? { sid2: self } : {}), mid: row.msgId, time: row.sendTime };
    const link = `https://zoom.us/launch/chat/v2/${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
    items.push({ id: row.msgId, timestamp: row.sendTime,
      ...(group ? { group: { ...summary(group.jid, group.metadata), kind: 'group-direct' }, audience: group.audience }
        : channel ? { channelId: channel.jid, channelName: row.sessionName }
          : { conversation: { type: 'chat', self, peer: direct.jid }, user: direct.user }),
      sender: { jid: row.senderJid, name: row.senderName }, parent, snippet: row.content, contentComplete: false,
      searchSessionId: row.sessionId, link, readCommand: group
        ? ['chat', 'group-message', '--group', group.jid, '--expect-users', expectedGroupUsers.join(','), '--message', row.msgId, '--time', String(row.sendTime)]
        : ['chat', 'message', '--link', link],
      threadCommand: channel && parent ? ['chat', 'thread', '--channel', channel.jid, '--thread', String(parent.timestamp)] : null });
  }
  if (response.totalSize !== response.msgResults.length) reasons.add('SERVER_PAGE_TOTAL_MISMATCH');
  if (response.searchAfter && response.searchAfter === position?.token) reasons.add('CURSOR_NOT_ADVANCED');
  if (response.searchAfter && !response.msgResults.length) reasons.add('EMPTY_CONTINUATION_PAGE');
  let nextCursor = response.searchAfter ? encodeCursor(scope, { token: response.searchAfter, seen: [...seen] }) : null;
  if (nextCursor?.length > 60000) reasons.add('CURSOR_STATE_LIMIT');
  if (reasons.size) nextCursor = null;
  return { query, items, unsupportedItems, scope: 'unarchived-message-index', order: 'server-relevance',
    channelScoped: false, channelScopeReason: 'NATIVE_CHANNEL_SCOPED_SEARCH_NOT_PROVEN',
    limit, reportedPageTotal: response.totalSize, nextCursor, contentComplete: false,
    pagination: { status: reasons.size ? 'incomplete' : nextCursor ? 'more' : 'end', complete: !reasons.size && !nextCursor,
      snapshot: false, continuationVerified: true, reasons: [...reasons] } };
}

async function incomingMentions(chat, options) {
  const state = options.state, limit = integer(options.limit ?? 20, 'Limit', 1);
  if (!['all', 'unread'].includes(state) || limit > 50) throw new AppError('INVALID_INPUT', 'Mention state must be all or unread, with limit 1–50.');
  const self = chat.from.split('/')[0], account = chat.identity.user.accountId;
  const expectedGroupUsers = options['expect-users'] === undefined ? null : groupUsers(chat, options['expect-users']);
  const scope = ['chat mentions', state, self, account, expectedGroupUsers, options.timeRange ? [options.timeRange.since, options.timeRange.until] : null, options['mention-scope'] ?? 'any'];
  const position = options.cursor ? decodeCursor(options.cursor, scope) : null;
  const items = [], unsupportedItems = [], reasons = new Set(), seen = new Set(position?.seen);
  const rooms = new Map(), peers = new Map(), records = [];
  let response, token, total = null;
  if (state === 'all') {
    if (!chat.messageSearchEnabled) throw new AppError('FORBIDDEN', 'Native mention history search is not enabled.');
    if (!chat.unlimitedSearchRetention) throw new AppError('UNSUPPORTED_SEARCH_RETENTION', 'Mention history requires the verified current unlimited search-retention contract.');
    response = await chat.request('/bffapi/mentions/list/client', { body: {
      keyword: '', pageSize: limit, sortType: 1, searchSourceType: 2, archivedSessionStatus: 2,
      starred: false, atJidList: [self], messageType: 2, cmcSessionScope: 3, pilotFeatureList: [1],
      onlyP2P: false, mynotesStartTime: 0, p2pStartTime: 0, mucStartTime: 0, channelStartTime: 0,
      startTime: 0, endTime: 0, includeAtMeE2EMsg: true, ...(position ? { searchAfter: position.token } : {}),
    } });
    if (response.result !== 0 || !Array.isArray(response.data) || typeof response.searchAfter !== 'string') {
      throw new AppError('UNSUPPORTED_CONTENT', 'Native mention history did not return its recognized result, message array and cursor. No empty result or search fallback was synthesized.');
    }
    for (const row of response.data) records.push({ record: row, sessionId: row?.sessionId, id: row?.msgid, time: row?.t, stanza: row?.stanza });
    token = response.searchAfter || null;
  } else {
    let lastValue;
    if (position) {
      try {
        lastValue = JSON.parse(position.token);
        if (!(typeof lastValue === 'string' && lastValue.length > 0) && !(Number.isSafeInteger(lastValue) && lastValue >= 0)) throw new Error();
      } catch { throw new AppError('INVALID_INPUT', 'Unread mention cursor has an unsupported native position.'); }
    }
    const resource = await chat.unreadResource();
    response = await chat.request('/xms/message/unreadMentions', { body: {
      resource, mention_type: 3, size: limit, ...(position ? { lastValue } : {}),
    } });
    if (response.result !== 0 || !Array.isArray(response.items) || typeof response.haveMore !== 'boolean'
      || !Number.isSafeInteger(response.total_count) || response.total_count < 0
      || !(typeof response.lastValue === 'string' || (Number.isSafeInteger(response.lastValue) && response.lastValue >= 0))) {
      throw new AppError('UNSUPPORTED_CONTENT', 'Native unread mentions did not return a recognized bounded resource page.');
    }
    for (const conversation of response.items) {
      if (typeof conversation?.id !== 'string' || !['chat', 'groupchat'].includes(conversation.type) || !Array.isArray(conversation.mentions)) {
        unsupportedItems.push({ reason: 'UNSUPPORTED_CONVERSATION_INDEX', record: conversation });
        reasons.add('UNSUPPORTED_RESULTS'); continue;
      }
      for (const row of conversation.mentions) records.push({ record: row, sessionId: conversation.id,
        type: conversation.type, id: row?.msgId, time: row?.timestamp, stanza: row?.stanza });
    }
    total = response.total_count;
    token = response.haveMore ? JSON.stringify(response.lastValue) : null;
    if (response.haveMore && (response.lastValue === '' || response.lastValue === 0)) reasons.add('MISSING_NATIVE_CONTINUATION');
  }
  if (records.length > limit) throw new AppError('UNSUPPORTED_CONTENT', 'Native mention page exceeded the requested bound; it was not silently truncated.');
  for (const entry of records) {
    try {
      if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(entry.id)
        || typeof entry.sessionId !== 'string' || typeof entry.stanza !== 'string'
        || (state === 'unread' && ![0, 1].includes(entry.record.marked))) {
        throw new AppError('UNSUPPORTED_CONTENT', 'Native mention identity, stanza or unread marker is unrecognized.');
      }
      const timestamp = integer(entry.time, 'Native mention timestamp', 1);
      const [message] = await chat.parseMessages([{ timestamp, message: entry.stanza, comment_total: entry.record.comment_total }]);
      if (message?.deleted) throw new AppError('DELETED_MESSAGE', 'The native mention record is deleted.');
      if (!message || message.id !== entry.id || (entry.type && entry.type !== message.type)) {
        throw new AppError('UNSUPPORTED_CONTENT', 'Native mention record and message identity disagree.');
      }
      const { channel, direct, group } = await indexedConversation(chat, message, expectedGroupUsers, rooms, peers, entry.sessionId);
      const conversationId = channel?.jid ?? group?.jid ?? direct.jid;
      if (channel && rooms.get(channel.jid).metadata.e2e !== '0') throw new AppError('UNSUPPORTED_ENCRYPTION', 'Encrypted channel mention content is not decoded.');
      if (direct && message.replyTo) throw new AppError('UNSUPPORTED_DIRECT_MESSAGE', 'Exact two-person reply routing is not verified.');
      const mentionKinds = [...new Set((message.mentions ?? []).map(mention =>
        mention.type === 1 && mention.jid === self ? 'direct' : mention.type === 2 ? 'all' : mention.type === 4 ? 'mention-group' : 'unknown'))];
      if (!mentionKinds.length) mentionKinds.push('unknown');
      if (options['mention-scope'] && options['mention-scope'] !== 'any' && !mentionKinds.includes(options['mention-scope'])) continue;
      const key = `${conversationId}:${message.id}`;
      if (seen.has(key)) { reasons.add('DUPLICATE_MESSAGE_IDS'); continue; }
      seen.add(key);
      let parent = null;
      if (message.replyTo) {
        const parentTime = integer(message.replyTo.thread, 'Native mention parent timestamp', 1);
        if (typeof message.replyTo.id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(message.replyTo.id) || parentTime > timestamp) {
          throw new AppError('UNSUPPORTED_CONTENT', 'The mentioned reply has no usable native parent identity.');
        }
        parent = { id: message.replyTo.id, timestamp: parentTime };
      }
      const payload = { sid: conversationId, ...(direct ? { sid2: self } : {}), mid: message.id, time: timestamp };
      const link = `https://zoom.us/launch/chat/v2/${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
      message.readState = state === 'unread' ? 'unread' : 'unknown';
      items.push({ id: message.id, timestamp, message, mentionKinds, incoming: message.from !== self,
        ...(group ? { group: { ...summary(group.jid, group.metadata), kind: 'group-direct' }, audience: group.audience }
          : channel ? { channel: summary(channel.jid, rooms.get(channel.jid).metadata) }
            : { conversation: { type: 'chat', self, peer: direct.jid }, user: direct.user }),
        parent, link, readCommand: group
          ? ['chat', 'group-message', '--group', group.jid, '--expect-users', expectedGroupUsers.join(','), '--message', message.id, '--time', String(timestamp)]
          : ['chat', 'message', '--link', link],
        threadCommand: channel && parent ? ['chat', 'thread', '--channel', channel.jid, '--thread', String(parent.timestamp)] : null,
        readState: state === 'unread' ? 'unread' : 'unknown',
        readStateEvidence: state === 'unread' ? { source: 'native-resource-index', markedAsUnread: entry.record.marked === 1 }
          : { source: 'historical-mention-index' }, notificationExpectation: 'unknown' });
    } catch (error) {
      if (['AUTH_REQUIRED', 'PROVIDER_APPROVAL_REQUIRED', 'RATE_LIMITED', 'SESSION_CLOSED', 'UNEXPECTED_REDIRECT'].includes(error?.code)) throw error;
      unsupportedItems.push({ id: entry.id ?? null, sessionId: entry.sessionId ?? null,
        reason: error.details?.reason ?? (error instanceof AppError && error.code !== 'INVALID_INPUT' ? error.code : 'UNSUPPORTED_CONTENT'), record: entry.record });
      reasons.add('UNSUPPORTED_RESULTS');
    }
  }
  if (token && token === position?.token) reasons.add('CURSOR_NOT_ADVANCED');
  if (token && !records.length) reasons.add('EMPTY_CONTINUATION_PAGE');
  let nextCursor = token ? encodeCursor(scope, { token, seen: [...seen] }) : null;
  if (nextCursor?.length > 60000) reasons.add('CURSOR_STATE_LIMIT');
  if (reasons.size) nextCursor = null;
  return { actor: { jid: self, accountId: account }, state, items, unsupportedItems, limit, reportedTotal: total,
    scope: state === 'all' ? 'native-unarchived-at-self-mention-history' : 'native-resource-unread-mentions',
    order: state === 'all' ? 'native-timestamp-descending' : 'native-grouped-page-order', nextCursor,
    contentComplete: !unsupportedItems.length && items.every(item => item.message.contentComplete),
    readEffects: { explicitReadMutationSent: false, readNeutralityGuaranteed: false,
      source: state === 'all' ? 'BFF at-self history, not unread status or arbitrary searchable mention text; no browser-local history merge'
        : 'fresh resource initialized by native offline index; not all historical or searchable mentions' },
    pagination: { status: reasons.size ? 'incomplete' : nextCursor ? 'more' : 'end', complete: !reasons.size && !nextCursor,
      snapshot: false, resourceBound: state === 'unread', reasons: [...reasons] } };
}

async function manualUnreadMarks(chat) {
  const response = await chat.request('/xms/murd/fetch', { body: { sessions: ['all'] } });
  if (response?.result !== 0 || !Array.isArray(response.data)) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Native manually marked-unread index returned an unrecognized envelope.');
  }
  const domain = chat.from.split('/')[0].split('@')[1], marks = new Map();
  for (const record of response.data) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new AppError('UNSUPPORTED_CONTENT', 'Native marked-unread index contains an unsupported record.');
    for (const [id, times] of Object.entries(record)) {
      if (!/^[A-Za-z0-9_-]+@[^@/]+$/.test(id) || (!id.endsWith(chat.channelSuffix) && id.split('@')[1] !== domain)
        || marks.has(id) || !Array.isArray(times)
        || times.some(time => !['string', 'number'].includes(typeof time) || !/^\d+$/.test(String(time)) || !Number.isSafeInteger(Number(time)) || Number(time) < 1)) {
        throw new AppError('UNSUPPORTED_CONTENT', 'Native marked-unread identity or message timestamps are unrecognized.');
      }
      marks.set(id, [...new Set(times.map(Number))].sort((a, b) => a - b));
    }
  }
  return marks;
}

async function conversationIndex(chat, operation) {
  const step = async (phase, read) => {
    try { return await read(); } catch (error) { throw stepError(error, operation, phase); }
  };
  const offline = await step('conversation-index.offline', () => chat.unreadIndex());
  const recent = await step('conversation-index.recent', () => chat.request('/xms/login/recent/list', { body: {} }));
  const marks = await step('conversation-index.marked-unread', () => manualUnreadMarks(chat));
  try {
  if (recent?.result !== 0 || !recent.data || typeof recent.data !== 'object' || Array.isArray(recent.data)
    || !(marks instanceof Map) || !Array.isArray(offline?.sessions)) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Native recent or manually marked-unread index returned an unrecognized envelope.');
  }
  return { recent: recent.data, marks, unread: new Map(offline.sessions.map(row => [row.id, row])), offline };
  } catch (error) { throw stepError(error, operation, 'conversation-index.validate'); }
}

async function checkNewMessages(chat, options) {
  const pageSize = integer(options.limit ?? 20, 'Page size', 1);
  const maxPages = integer(options['max-pages'] ?? 5, 'Maximum stream pages', 1);
  if (pageSize > 100 || maxPages > 10) throw new AppError('INVALID_INPUT', 'New-message checks allow page size1–100 and at most10 stream pages per call.');
  const self = chat.from.split('/')[0], account = chat.identity.user.accountId;
  const users = options['expect-users'] === undefined ? null : groupUsers(chat, options['expect-users']);
  const scope = ['chat new-messages', self, account, users];
  let position = options.checkpoint ? decodeCursor(options.checkpoint, scope) : null;
  const index = await conversationIndex(chat, 'chat.new-messages'), observedAt = index.offline.receivedAt;
  const watermarks = [...index.unread.values()].map(row => ({
    id: row.id, nativeCount: row.unreadCount, lastReadTime: row.lastReadTime,
    lastUnreadTime: row.lastUnreadTime, threads: row.threads,
  }));
  const baseline = position === null;
  if (baseline) position = { since: observedAt + 1, until: null, streams: [], offset: 0, before: null };
  const windowStart = position.since;
  if (!baseline && position.until === null && observedAt >= position.since) {
    const ids = new Set([...index.unread.values()].filter(row => row.unreadCount > 0 || row.threads.some(thread => thread.unreadCount > 0)).map(row => row.id));
    for (const [id, times] of index.marks) if (times.length) ids.add(id);
    const streams = [];
    for (const id of [...ids].sort()) {
      if (id === self) continue;
      streams.push({ id, thread: null });
      for (const entry of index.unread.get(id)?.threads ?? []) {
        if (entry.unreadCount > 0) streams.push({ id, thread: entry.timestamp });
      }
    }
    if (streams.length > 1000) throw new AppError('CHECKPOINT_TOO_LARGE', 'Native unread streams exceed the bounded checkpoint capacity; no history was read.');
    position = { ...position, until: observedAt, streams, offset: 0, before: null };
  }
  const windowEnd = position.until, items = [], excludedEvents = [], targets = new Map();
  let pagesRead = 0, blocked = null;
  const knownStreams = new Set(position.streams.map(stream => `${stream.id}:${stream.thread}`));
  while (position.until !== null && position.offset < position.streams.length && pagesRead < maxPages) {
    const stream = position.streams[position.offset], upper = position.before ?? position.until;
    try {
      if (!targets.has(stream.id)) {
        let target;
        if (stream.id.endsWith(chat.channelSuffix)) {
          const id = { ...channelId(stream.id, chat.channelSuffix), type: 'groupchat' };
          const metadata = await readChannelInfo(chat, id);
          if (metadata.e2e !== '0') throw new AppError('UNSUPPORTED_ENCRYPTION', 'Encrypted unread conversation is not supported.');
          if (Number(metadata.type) === 3) {
            if (!users) throw new AppError('GROUP_AUDIENCE_REQUIRED', 'Group-DM checks require the exact expected group audience.');
            await groupAudience(chat, id, metadata, users);
          } else if (![1, 2].includes(Number(metadata.type))) throw new AppError('UNSUPPORTED_CONVERSATION_TYPE', 'Unread room is not a verified channel or group DM.');
          target = { id, group: Number(metadata.type) === 3 };
        } else target = { id: await directPeer(chat, stream.id), group: false };
        targets.set(stream.id, target);
      }
      const target = targets.get(stream.id);
      if (stream.thread !== null && (target.id.type !== 'groupchat' || target.group)) throw new AppError('UNSUPPORTED_THREAD', 'Only observed channel-thread routing is supported.');
      const fetchPage = (size, before, start) => stream.thread === null
        ? history(chat, target.id, size, before, start)
        : thread(chat, target.id, stream.thread, size, before, Math.max(start, stream.thread));
      const first = await fetchPage(pageSize, upper, position.since);
      if (first.messages.some(message => typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(message.id)
        || !Number.isSafeInteger(message.timestamp) || message.timestamp < position.since || message.timestamp > upper)) {
        throw new AppError('HISTORY_RANGE_MISMATCH', 'Native messages do not match the checkpoint timestamp window.');
      }
      let boundary;
      if (first.messages.length >= pageSize) {
        const oldest = Math.min(...first.messages.map(message => message.timestamp));
        boundary = await fetchPage(BOUNDARY_LIMIT, oldest, oldest);
      }
      const streamScope = ['chat new-message-stream', stream.id, stream.thread];
      const page = completeHistoryPage(first, boundary, pageSize, streamScope);
      if (page.pagination.status === 'incomplete') throw new AppError(page.pagination.reason, 'Timestamp boundary cannot safely advance; this page was not emitted.');
      if (stream.thread !== null && (page.parent.timestamp !== stream.thread
        || page.messages.some(message => message.type !== 'groupchat' || message.to !== stream.id
          || message.replyTo?.id !== page.parent.id || Number(message.replyTo.thread) !== stream.thread))) {
        throw new AppError('UNSUPPORTED_CONTENT', 'Unread thread returned unrelated parent or reply identities.');
      }
      const nextBefore = page.nextCursor ? decodeCursor(page.nextCursor, streamScope).before : null;
      if (nextBefore !== null && nextBefore >= upper) throw new AppError('NONADVANCING_HISTORY', 'Native history did not advance the checkpoint.');
      const emitted = [], excluded = [], discovered = new Map();
      for (const message of page.messages) {
        const userMessage = message.messageType === '0' || message.messageType === '17';
        if (stream.thread === null && target.id.type === 'groupchat' && !target.group && !message.deleted && userMessage) {
          const timestamp = message.replyTo ? Number(message.replyTo.thread) : message.timestamp;
          if (!Number.isSafeInteger(timestamp) || timestamp < 1 || timestamp > position.until) throw new AppError('UNSUPPORTED_THREAD', 'Encountered message has no usable parent timestamp.');
          const key = `${stream.id}:${timestamp}`;
          if (!knownStreams.has(key)) discovered.set(key, { id: stream.id, thread: timestamp });
        }
        if (stream.thread === null && message.replyTo && (target.group || target.id.type === 'chat')) throw new AppError('UNSUPPORTED_THREAD', 'Direct/group-DM reply routing is not verified.');
        if (stream.thread === null && message.replyTo) continue;
        if (Number(message.messageType) >= 65536) throw new AppError('UNSUPPORTED_ENCRYPTION', 'Historical encrypted messages cannot be emitted as plaintext.');
        if (!userMessage || message.deleted || message.from === self) {
          excluded.push({ conversationId: stream.id, messageId: message.id, timestamp: message.timestamp, messageType: message.messageType,
            reason: message.deleted ? 'DELETED' : message.from === self ? 'SELF_AUTHORED' : 'NON_EMITTED_MESSAGE_TYPE' });
          continue;
        }
        if (typeof message.from !== 'string' || !/^[A-Za-z0-9_-]+@[^@/]+$/.test(message.from)
          || message.from.split('@')[1] !== self.split('@')[1]) throw new AppError('UNSUPPORTED_CONTENT', 'Incoming user message has an unrecognized sender identity.');
        const payload = { sid: stream.id, ...(target.id.type === 'chat' ? { sid2: self } : {}), mid: message.id, time: message.timestamp };
        const link = `https://zoom.us/launch/chat/v2/${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
        emitted.push({ conversationId: stream.id, kind: stream.thread !== null ? 'reply' : target.id.type === 'chat' ? 'direct' : target.group ? 'group' : 'root',
          id: message.id, timestamp: message.timestamp, message, link,
          readCommand: target.group ? ['chat', 'group-message', '--group', stream.id, '--expect-users', users.join(','), '--message', message.id, '--time', String(message.timestamp)]
            : ['chat', 'message', '--link', link],
          ...(stream.thread !== null ? { threadCommand: ['chat', 'thread', '--channel', stream.id, '--thread', String(stream.thread)] } : {}),
          unreadState: 'not-inferred-from-conversation-count' });
      }
      if (position.streams.length + discovered.size > 1000) throw new AppError('CHECKPOINT_TOO_LARGE', 'Encountered threads exceed the resumable stream bound.');
      for (const [key, entry] of discovered) {
        knownStreams.add(key); position.streams.push(entry);
      }
      items.push(...emitted); excludedEvents.push(...excluded); pagesRead++;
      if (nextBefore === null || nextBefore < position.since) {
        position.offset++; position.before = null;
      } else position.before = nextBefore;
    } catch (error) {
      if (['AUTH_REQUIRED', 'PROVIDER_APPROVAL_REQUIRED', 'RATE_LIMITED', 'SESSION_CLOSED', 'UNEXPECTED_REDIRECT'].includes(error?.code)) throw error;
      blocked = { ...stream, reason: error instanceof AppError ? error.code : 'UNSUPPORTED_CONTENT' };
      break;
    }
  }
  if (position.until !== null && position.offset === position.streams.length) {
    position = { since: position.until + 1, until: null, streams: [], offset: 0, before: null };
  }
  const checkpoint = encodeCursor(scope, position);
  if (checkpoint.length > 60000) throw new AppError('CHECKPOINT_TOO_LARGE', 'Checkpoint exceeds its resumable bound; no result or advanced checkpoint was emitted.');
  return { actor: self, items, excludedEvents, checkpoint, status: baseline ? 'baseline' : blocked ? 'blocked' : position.until !== null ? 'more' : 'checked',
    window: { since: windowStart, through: windowEnd }, pagesRead, remainingStreams: position.streams.length - position.offset,
    blocked, nativeIndex: { version: index.offline.version, observedAt, watermarks,
      manuallyMarkedTimes: [...index.marks].map(([id, timestamps]) => ({ id, timestamps })) },
    coverage: { scope: 'new-incoming-type0-or17-messages-in-native-unread-or-marked-conversations-and-indexed-or-encountered-channel-threads',
      indexedPassComplete: !baseline && !blocked && position.until === null, exhaustiveDeliveryLog: false,
      alreadyReadElsewhereCovered: false, lateOrBackdatedArrivalRecovery: false, snapshot: false,
      baselineBacklogEmitted: false, timestampBoundaryLimit: BOUNDARY_LIMIT },
    readEffects: { explicitReadMutationSent: false, readNeutralityGuaranteed: false } };
}

async function directInbox(chat, options) {
  const state = options.state, kind = options.kind ?? 'all', limit = integer(options.limit ?? 20, 'Limit', 1);
  if (!['all', 'unread'].includes(state) || !['all', 'direct', 'group'].includes(kind) || limit > 50) {
    throw new AppError('INVALID_INPUT', 'DM inbox requires state all or unread, kind all/direct/group, and limit 1–50.');
  }
  const self = chat.from.split('/')[0], domain = self.split('@')[1], account = chat.identity.user.accountId;
  const users = options['expect-users'] === undefined ? null : groupUsers(chat, options['expect-users']);
  const scope = ['chat dm-inbox', state, kind, self, account, users];
  const position = options.cursor ? decodeCursor(options.cursor, scope) : null;
  const index = await conversationIndex(chat, 'chat.dm-inbox'), candidates = [];
  const ids = new Set([...Object.keys(index.recent), ...index.unread.keys(), ...index.marks.keys()]);
  for (const id of ids) {
    if (id === self) continue;
    const cached = index.recent[id], unread = index.unread.get(id), marked = index.marks.get(id) ?? [];
    if (state === 'unread' && !(unread?.unreadCount > 0 || marked.length)) continue;
    let type;
    if (id.endsWith(chat.channelSuffix)) {
      if (cached && cached.sType === 'groupchat' && [1, 2].includes(Number(cached.type))) continue;
      type = cached?.sType === 'groupchat' && Number(cached.type) === 3 ? 'group' : 'unknown-group';
    } else type = /^[A-Za-z0-9_-]+@[^@/]+$/.test(id) && id.split('@')[1] === domain ? 'direct' : 'unknown';
    if (kind === 'direct' && type !== 'direct') continue;
    if (kind === 'group' && type === 'direct') continue;
    candidates.push({ id, type, cached, unread, marked });
  }
  candidates.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const fingerprint = createHash('sha256').update(JSON.stringify(candidates.map(({ id, type }) => [id, type]))).digest('hex');
  if (position && position.fingerprint !== fingerprint) throw new AppError('CURSOR_INDEX_CHANGED', 'Native DM candidate identities changed. Restart this local-window traversal; no snapshot or recovery was invented.');
  const offset = position?.offset ?? 0;
  if (position && offset >= candidates.length) throw new AppError('INVALID_INPUT', 'DM inbox cursor is outside the current native identity set.');
  const selected = candidates.slice(offset, offset + limit), targets = new Map(), rooms = new Map(), peers = new Map();
  const items = [], unsupportedItems = [], excludedItems = [];
  for (const entry of selected) {
    try {
      let target;
      if (entry.type === 'direct') {
        const peer = await directPeer(chat, entry.id);
        peers.set(entry.id, peer);
        target = { id: entry.id, kind: 'direct', user: peer.user, conversation: { type: 'chat', self, peer: peer.jid },
          readCommand: typeof peer.user.email === 'string' ? ['chat', 'dm-read', '--email', peer.user.email] : null };
      } else if (entry.type === 'group' || entry.type === 'unknown-group') {
        const id = channelId(entry.id, chat.channelSuffix), metadata = await readChannelInfo(chat, id);
        if ([1, 2].includes(Number(metadata.type))) { excludedItems.push({ id: entry.id, reason: 'NATIVE_CHANNEL_NOT_GROUP_DM' }); continue; }
        if (!users) throw new AppError('GROUP_AUDIENCE_REQUIRED', 'Group-DM inbox content requires complete --expect-users.');
        const audience = await groupAudience(chat, id, metadata, users);
        rooms.set(id.jid, { metadata, audience });
        target = { id: id.jid, kind: 'group', group: { ...summary(id.jid, metadata), kind: 'group-direct' }, audience,
          readCommand: ['chat', 'group-read', '--group', id.jid, '--expect-users', users.join(',')] };
      } else throw new AppError('UNSUPPORTED_CONVERSATION_TYPE', 'Native inbox identity is not a supported direct or group conversation.');
      Object.assign(target, { unread: {
        state: entry.unread?.unreadCount > 0 || entry.marked.length ? 'unread' : 'not-indexed-unread',
        nativeCount: entry.unread?.unreadCount ?? 0, markedMessageTimes: entry.marked,
        lastReadTime: entry.unread?.lastReadTime ?? null, lastUnreadTime: entry.unread?.lastUnreadTime ?? null,
        source: 'native-offline-acktime-and-murd', absenceProvesRead: false,
      }, lastActivity: null, latest: null, previewCoverage: { status: 'unavailable', scope: 'native-type-filtered-latest-preview' } });
      targets.set(entry.id, target); items.push(target);
    } catch (error) {
      if (['AUTH_REQUIRED', 'PROVIDER_APPROVAL_REQUIRED', 'RATE_LIMITED', 'SESSION_CLOSED', 'UNEXPECTED_REDIRECT'].includes(error?.code)) throw error;
      unsupportedItems.push({ id: entry.id, reason: error instanceof AppError ? error.code : 'UNSUPPORTED_CONTENT', nativeIndexRecord: entry.cached ?? entry.unread ?? null });
    }
  }
  if (targets.size) {
    const response = await chat.request('/history/fetch', { body: {
      limit: '1', sessions: [...targets.values()].map(target => ({ [target.id]: {
        timeframe: `0:${index.offline.receivedAt}`, visible_filter: false, type: target.kind === 'direct' ? 'chat' : 'groupchat', mynote: false,
      } })), needMsgTypes: PREVIEW_MESSAGE_TYPES, fixMsgType: true,
    } });
    if (response.result !== 0 || !Array.isArray(response.data) || new Set(response.data.map(row => row?.session)).size !== response.data.length
      || response.data.some(row => !targets.has(row?.session) || !Array.isArray(row.messages) || row.messages.length > 1)) {
      throw new AppError('UNSUPPORTED_CONTENT', 'Native latest-preview response has mismatched identities or exceeded its one-record bound.');
    }
    const received = new Set();
    for (const row of response.data) {
      received.add(row.session);
      const target = targets.get(row.session);
      if (!row.messages.length) { target.previewCoverage.status = 'no-native-preview'; continue; }
      try {
        if (typeof row.messages[0] !== 'string') throw new AppError('UNSUPPORTED_CONTENT', 'Native latest preview is not an XML message.');
        const [message] = await chat.parseMessages([{ message: row.messages[0] }]);
        if (!message || typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(message.id)
          || !Number.isSafeInteger(message.timestamp) || message.timestamp < 1 || message.timestamp > index.offline.receivedAt) {
          throw new AppError('UNSUPPORTED_CONTENT', 'Native latest preview lacks a usable exact message identity and timestamp.');
        }
        const routed = await indexedConversation(chat, message, users, rooms, peers, target.id);
        if ((routed.group?.jid ?? routed.direct?.jid) !== target.id) throw new AppError('UNSUPPORTED_DIRECT_PAIR', 'Latest preview addressing does not belong to this indexed DM.');
        target.lastActivity = { timestamp: message.timestamp, messageId: message.id, source: 'native-latest-preview' };
        if (message.deleted || message.replyTo) throw new AppError('UNSUPPORTED_DIRECT_MESSAGE', 'Deleted or threaded DM preview exact routing is not verified.');
        if (Number(message.messageType) >= 65536) throw new AppError('UNSUPPORTED_ENCRYPTION', 'Historical encrypted DM preview content is not decoded.');
        const payload = { sid: target.id, ...(target.kind === 'direct' ? { sid2: self } : {}), mid: message.id, time: message.timestamp };
        const link = `https://zoom.us/launch/chat/v2/${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
        target.latest = { message, link, readCommand: target.kind === 'group'
          ? ['chat', 'group-message', '--group', target.id, '--expect-users', users.join(','), '--message', message.id, '--time', String(message.timestamp)]
          : ['chat', 'message', '--link', link] };
        target.previewCoverage.status = message.contentComplete ? 'recognized' : 'partial-content';
      } catch (error) {
        if (['AUTH_REQUIRED', 'PROVIDER_APPROVAL_REQUIRED', 'RATE_LIMITED', 'SESSION_CLOSED', 'UNEXPECTED_REDIRECT'].includes(error?.code)) throw error;
        target.previewCoverage.status = 'unsupported';
        unsupportedItems.push({ id: row.session, reason: error instanceof AppError ? error.code : 'UNSUPPORTED_CONTENT', nativePreview: row });
      }
    }
    for (const id of targets.keys()) if (!received.has(id)) unsupportedItems.push({ id, reason: 'MISSING_NATIVE_PREVIEW_RESPONSE' });
  }
  const end = offset + selected.length, nextCursor = end < candidates.length ? encodeCursor(scope, { offset: end, fingerprint }) : null;
  return { actor: { jid: self, accountId: account }, state, kind, items, unsupportedItems, excludedItems, limit,
    candidateCount: candidates.length, scannedCount: selected.length, nextCursor, order: 'canonical-conversation-id',
    scope: 'native-recent-and-unread-direct-conversations',
    index: { receivedAt: index.offline.receivedAt, version: index.offline.version, fingerprint, recentCount: Object.keys(index.recent).length,
      watermarks: selected.map(({ id, unread }) => ({ id, lastReadTime: unread?.lastReadTime ?? null,
        lastUnreadTime: unread?.lastUnreadTime ?? null, nativeAckTime: unread?.nativeAckTime ?? null })) },
    pagination: { kind: 'local-window-over-unpaginated-native-index', status: nextCursor ? 'more' : unsupportedItems.length ? 'incomplete' : 'end',
      complete: !nextCursor && !unsupportedItems.length, snapshot: false, identitySetChange: 'restart-required' },
    coverage: { complete: !unsupportedItems.length && items.every(item => item.previewCoverage.status === 'recognized' || item.previewCoverage.status === 'no-native-preview'),
      excludedSources: ['browser-local-history', 'starred-only-conversations', 'folder-only-conversations', 'hidden-state-mirroring'],
      nativePreviewTypeFiltered: true, emptyPreviewProvesEmptyHistory: false },
    readEffects: { explicitReadMutationSent: false, readNeutralityGuaranteed: false, resourceBound: true,
      source: 'fresh offline resource, recent identity index, manually marked message timestamps and native latest preview; not a delivery checkpoint or new-conversation census' } };
}

function integer(value, name, minimum) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    throw new AppError('INVALID_INPUT', `${name} must be an integer of at least ${minimum}.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new AppError('INVALID_INPUT', `${name} must be a safe integer of at least ${minimum}.`);
  return number;
}

async function findChannels(chat, options) {
  const query = options.query;
  if (typeof query !== 'string' || !query.trim() || query.length > 20) {
    throw new AppError('INVALID_INPUT', 'Supply a channel title query of 1–20 characters.');
  }
  const limit = integer(options.limit ?? 100, 'Limit', 1);
  if (limit > 100) throw new AppError('INVALID_INPUT', 'Limit must not exceed 100.');
  const seen = new Set();
  const authenticatedAccountId = chat.identity?.user?.accountId;
  if (typeof authenticatedAccountId !== 'string' || !authenticatedAccountId) throw new AppError('CHAT_CONFIGURATION_ERROR', 'Chat did not provide an account ID for channel search.');
  const response = await chat.request('/xms/channel/search', { body: {
    matchType: 1, groupOptions: [['8']], onlyMatchJoined: 1, archivedSessionStatus: 3,
    page: 1, size: limit, keyword: query, accountId: authenticatedAccountId,
  } });
  if (!response || response.result !== 0 || response.keyword !== query || response.page !== 1
    || typeof response.hasMore !== 'boolean' || !Number.isSafeInteger(response.total) || response.total < 0
    || !Array.isArray(response.data) || response.data.length > limit) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned an unrecognized channel-search page.');
  }
  const items = [], overlap = [];
  for (const entry of response.data) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string'
      || (entry.memberCount !== undefined && entry.memberCount !== null && (!Number.isSafeInteger(entry.memberCount) || entry.memberCount < 0))
      || (entry.optionStr !== undefined && typeof entry.optionStr !== 'string')
      || (entry.option !== undefined && typeof entry.option !== 'string' && !Number.isSafeInteger(entry.option))
      || (entry.account !== undefined && entry.account !== null && (typeof entry.account !== 'string' || !entry.account))
      || (entry.accountId !== undefined && entry.accountId !== null && (typeof entry.accountId !== 'string' || !entry.accountId))
      || (entry.account && entry.accountId && entry.account !== entry.accountId)) {
      throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned an unrecognized channel-search candidate.');
    }
    let id;
    try { id = channelId(entry.channelId, chat.channelSuffix).jid; }
    catch { throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned an invalid channel-search candidate ID.'); }
    if (seen.has(id)) { overlap.push(id); continue; }
    seen.add(id);
    const channelAccountId = entry.account ?? entry.accountId ?? null;
    const item = { id, title: entry.name, channelAccountId, authenticatedAccountId,
      accessScope: channelAccountId === null ? null : channelAccountId === authenticatedAccountId ? 'same-account' : 'shared-cross-tenant' };
    if (entry.optionStr || entry.option !== undefined) item.nativeOption = entry.optionStr || String(entry.option);
    if (entry.memberCount !== undefined) item.memberCount = entry.memberCount;
    items.push(item);
  }
  const reason = overlap.length ? 'DUPLICATE_CHANNEL_IDS'
    : response.hasMore ? 'CONTINUATION_UNVERIFIED'
      : response.data.length >= limit ? 'SEARCH_RESULT_LIMIT'
        : response.total > items.length ? 'UNRETURNED_RESULTS' : null;
  return {
    items, query, scope: 'authenticated-account-joined-channel-name-search', page: 1,
    reportedTotal: response.total, exhaustiveDirectory: false, absenceProven: false, nextCursor: null,
    pagination: {
      status: reason ? 'incomplete' : 'end', complete: !reason, snapshot: false,
      serverHasMore: response.hasMore,
      ...(reason ? { reason, ...(overlap.length ? { overlappingIds: overlap } : {}) } : {}),
    },
  };
}

async function members(chat, id, channel, limit) {
  const response = await chat.request('/bffapi/channel/members/client', { body: {
    membersParams: { groupJid: id.jid, needAccountId: false, page: 1, size: limit },
  } });
  const page = response?.data?.memberResponse;
  const rows = Array.isArray(page?.data) ? page.data : [];
  const items = [], seen = new Set(), overlap = [], reasons = [];
  let unknownRows = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.userJid !== 'string' || !/^[^@\s/]+@[^@\s/]+$/.test(row.userJid)) {
      unknownRows++;
      continue;
    }
    if (seen.has(row.userJid)) { overlap.push(row.userJid); continue; }
    seen.add(row.userJid);
    if (typeof row.name !== 'string') unknownRows++;
    items.push({
      jid: row.userJid, name: typeof row.name === 'string' ? row.name : null,
      role: row.role ?? null, joinTime: row.joined_t ?? null, isZccQ: row.isZccQ ?? null,
      observations: [{ scope: 'channel', resourceId: id.jid, relationship: 'member',
        source: 'native-channel-members', observedAt: new Date().toISOString() }],
    });
  }
  const validTotal = Number.isSafeInteger(page?.total) && page.total >= 0;
  const validCount = Number.isSafeInteger(channel.memberCount) && channel.memberCount >= 0;
  if (response?.result !== 0 || !Array.isArray(page?.data) || unknownRows
    || !validTotal || typeof page?.haveMore !== 'boolean') reasons.push('UNRECOGNIZED_MEMBER_PAGE');
  if (overlap.length) reasons.push('DUPLICATE_MEMBER_IDS');
  if (page?.haveMore === true) reasons.push('CONTINUATION_UNVERIFIED');
  if (rows.length >= limit) reasons.push('MEMBER_PREVIEW_LIMIT');
  if (validTotal && (page.total !== rows.length || page.total !== seen.size)) reasons.push('SERVER_TOTAL_MISMATCH');
  if (!validCount) reasons.push('CHANNEL_MEMBER_COUNT_UNAVAILABLE');
  else if (channel.memberCount !== rows.length || channel.memberCount !== seen.size
    || (validTotal && channel.memberCount !== page.total)) reasons.push('CHANNEL_MEMBER_COUNT_MISMATCH');
  return {
    channel: summary(id.jid, channel), items, scope: 'channel-member-preview', page: 1, limit,
    maxLimit: 1000, reportedTotal: page?.total ?? null, channelMemberCount: channel.memberCount ?? null,
    rowCount: rows.length, uniqueMemberCount: seen.size, nextCursor: null,
    pagination: {
      status: reasons.length ? 'incomplete' : 'end', complete: reasons.length === 0, snapshot: false,
      completenessScope: 'consistent-unsaturated-count-evidence', continuationVerified: false,
      serverHaveMore: page?.haveMore ?? null,
      ...(reasons.length ? { reason: reasons[0], reasons } : {}),
      ...(overlap.length ? { overlappingIds: overlap } : {}),
      ...(unknownRows ? { unrecognizedRows: unknownRows } : {}),
    },
  };
}

async function resolveChannel(chat, title) {
  if (typeof title !== 'string' || !title.trim()) throw new AppError('INVALID_INPUT', 'Supply a full channel title.');
  const normalized = title.toLowerCase();
  const query = title.slice(0, 20).replace(/[\uD800-\uDBFF]$/, '');
  const result = await findChannels(chat, { query, limit: 100 });
  const candidates = result.items.filter(item => item.title.toLowerCase() === normalized);
  const details = {
    title, query: result.query, scope: result.scope,
    candidates: candidates.map(({ id, title, channelAccountId, authenticatedAccountId, accessScope }) =>
      ({ id, title, channelAccountId, authenticatedAccountId, accessScope })),
    page: result.page, reportedTotal: result.reportedTotal, pagination: result.pagination, absenceProven: false,
  };
  if (candidates.length > 1) throw new AppError('AMBIGUOUS_CHANNEL', 'Multiple joined channels match this exact title. Use an explicit channel ID.', details);
  if (!result.pagination.complete) {
    throw new AppError('RESOLUTION_INCOMPLETE', 'The bounded channel-name search cannot safely resolve this title. Use an explicit channel ID.', details);
  }
  if (!candidates.length) throw new AppError('RESOLUTION_INCOMPLETE', 'This bounded authenticated-account search returned no exact title; it does not establish channel absence. Use an explicit channel ID.', details);
  const id = channelId(candidates[0].id, chat.channelSuffix);
  const channel = await readChannelInfo(chat, id);
  if (channel.name.toLowerCase() !== normalized) {
    throw new AppError('RESOLUTION_INCOMPLETE', 'The channel title changed between search and exact-ID verification. Use an explicit channel ID.', details);
  }
  return { channel: summary(id.jid, channel), matchedBy: 'exact-title' };
}

async function inspectChannel(chat, options) {
  const id = channelId(options.channel, chat.channelSuffix);
  const diagnostics = {
    requestedChannelId: options.channel, normalizedChannelId: id.jid, authoritativeChannelId: null,
    discovery: { attempted: false, source: 'explicit-channel-id', requestedChannelId: id.jid, matchedChannelId: null, absenceInferred: false },
    metadata: { attempted: true, source: '/xms/channel/infos', returned: false, authoritative: false, exactChannelIdMatched: false },
    history: { attempted: false, returned: false, messageCount: null },
    exactFailure: null,
    verifiedOperations: [],
    unsupportedOperations: ['channel-scoped-message-search', 'exhaustive-channel-history', 'mutation-authorization-by-inspection'],
    mutationAuthorization: 'operation-specific native permission, capability, role, audience, expected-user, and uncertain-write checks',
  };
  diagnostics.lookup = diagnostics.metadata;
  const propagateGate = error => {
    if (['PROVIDER_APPROVAL_REQUIRED', 'AUTH_REQUIRED', 'REAUTHENTICATION_REQUIRED', 'REQUEST_CANCELLED',
      'SESSION_CLOSED', 'UNEXPECTED_REDIRECT'].includes(error?.code)) {
      error.details = { ...error.details, diagnostics };
      throw error;
    }
  };
  let channel;
  try {
    channel = await readChannelInfo(chat, id);
    Object.assign(diagnostics.lookup, { returned: true, authoritative: true, exactChannelIdMatched: true });
    diagnostics.authoritativeChannelId = id.jid;
    diagnostics.verifiedOperations.push('authoritative-channel-metadata');
  } catch (error) {
    if (error?.code === 'CHANNEL_IDENTITY_MISMATCH') {
      diagnostics.authoritativeChannelId = error.details?.authoritativeChannelId ?? null;
      Object.assign(diagnostics.lookup, { returned: true, identityField: error.details?.identityField });
    }
    diagnostics.exactFailure = { stage: 'metadata', code: error?.code ?? 'UNEXPECTED_ERROR' };
    propagateGate(error);
    throw new AppError(error?.code ?? 'UNSUPPORTED_CONTENT', 'Authoritative channel inspection failed; no channel absence was inferred.', {
      diagnostics, cause: { code: error?.code ?? 'UNEXPECTED_ERROR' },
    });
  }
  const limit = integer(options.limit ?? 1, 'Limit', 1);
  if (limit > 100) throw new AppError('INVALID_INPUT', 'Inspection history limit must not exceed 100.');
  try {
    if (![1, 2].includes(Number(channel.type))) throw new AppError('UNSUPPORTED_CONVERSATION', 'Channel inspection does not bypass group-DM audience verification.');
    if (channel.e2e !== '0') throw new AppError('UNSUPPORTED_ENCRYPTION', 'Channel inspection cannot verify encrypted history.');
    diagnostics.history.attempted = true;
    const result = await history(chat, id, limit);
    Object.assign(diagnostics.history, { returned: true, messageCount: result.messages.length });
    diagnostics.verifiedOperations.push('bounded-channel-history');
    const reasons = result.unsupportedItems.length ? ['UNSUPPORTED_NATIVE_HISTORY_RECORDS']
      : result.messages.length >= limit ? ['HISTORY_PREVIEW_LIMIT'] : [];
    return { operation: 'chat.inspect', scope: 'bounded-channel-history-preview', channel: summary(id.jid, channel),
      messages: result.messages, unsupportedItems: result.unsupportedItems, diagnostics, nextCursor: null,
      pagination: { status: reasons.length ? 'incomplete' : 'end', complete: !reasons.length,
        snapshot: false, requestedLimit: limit, reasons, completenessScope: 'returned-native-root-preview' },
      coverage: { category: dimension('unknown', 'channel-history', ['REPLIES_AND_OLDER_HISTORY_NOT_EXHAUSTIVELY_INSPECTED']) } };
  } catch (error) {
    diagnostics.exactFailure = { stage: 'history', code: error?.code ?? 'UNEXPECTED_ERROR' };
    propagateGate(error);
    return { operation: 'chat.inspect', scope: 'bounded-channel-history-preview', channel: summary(id.jid, channel), messages: [], unsupportedItems: [],
      diagnostics, nextCursor: null, pagination: { status: 'incomplete', complete: false, reasons: ['HISTORY_LOOKUP_FAILED'] },
      coverage: { content: dimension('unknown', 'unreturned-history', [error?.code ?? 'UNEXPECTED_ERROR']) } };
  }
}

function normalizeExactMessageRecord(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned an unrecognized exact-message record.');
  const stanza = row.stanza ?? row.message, messageId = row.msgid ?? row.msg_id, timestamp = row.t ?? row.timestamp;
  if ((row.stanza !== undefined && row.message !== undefined && row.stanza !== row.message)
    || (row.msgid !== undefined && row.msg_id !== undefined && row.msgid !== row.msg_id)
    || (row.t !== undefined && row.timestamp !== undefined && Number(row.t) !== Number(row.timestamp))
    || typeof stanza !== 'string' || typeof messageId !== 'string'
    || !Number.isSafeInteger(Number(timestamp)) || Number(timestamp) <= 0) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned conflicting or malformed exact-message metadata.');
  }
  return { ...row, stanza, message: stanza, msgid: messageId, msg_id: messageId, t: Number(timestamp), timestamp: Number(timestamp) };
}

async function exactMessage(chat, id, messageId, timestamp) {
  const response = await chat.request('/history/fetchbymsgid', { body: {
    sessions: [{ session: id.jid, type: 'groupchat', msgids: [{ id: messageId, sendtime: timestamp }] }],
  } });
  const pages = Array.isArray(response.data) ? response.data.filter(page => page?.session === id.jid || page?.session === id.bare) : [];
  if (pages.length !== 1 || !Array.isArray(pages[0].messages)) throw new AppError('UNSUPPORTED_CONTENT', 'Chat did not return a recognized exact-message result.');
  const records = pages[0].messages.map(normalizeExactMessageRecord);
  const messages = await chat.parseMessages(records);
  if (messages.length > 1 || messages.some(message => message.id !== messageId || message.timestamp !== timestamp
    || message.to !== id.jid || message.type !== 'groupchat')) throw new AppError('UNSUPPORTED_CONTENT', 'Exact-message identity, destination or timestamp did not match.');
  return messages[0] ?? null;
}

async function history(chat, id, limit, before, start = 0) {
  const response = await chat.request('/history/fetch2', { body: {
    sessions: [{ session: id.bare, limit, timeframe: `${start}:${before ?? ''}`, type: id.type ?? 'groupchat',
      sort: 'desc', visible_filter: false, mynote: false }],
    needEmojiList: true, needLatestComments: false, sortByTimestamp: true,
  } });
  if (!Array.isArray(response.data)) throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned an unrecognized history response.');
  const pages = response.data.filter(item => item?.session === id.jid || item?.session === id.bare);
  const page = pages[0];
  if (pages.length !== 1 || !Array.isArray(page?.messages) || page.messages.length > limit) throw new AppError('UNSUPPORTED_CONTENT', 'Chat did not return one bounded history page for the requested channel.');
  const { messages, unsupportedItems } = await parseHistoryRecords(chat, page.messages);
  if (!Array.isArray(messages)) throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned unrecognized messages.');
  if (id.type === 'chat') {
    const self = chat.from.split('/')[0];
    if (messages.some(message => message.type !== 'chat'
      || !((message.from?.split('/')[0] === self && message.to?.split('/')[0] === id.jid)
        || (message.from?.split('/')[0] === id.jid && message.to?.split('/')[0] === self)))) {
      throw new AppError('UNSUPPORTED_CONTENT', 'Direct history contains a message outside the verified sender/recipient pair.');
    }
  }
  if ((id.type ?? 'groupchat') === 'groupchat' && messages.some(message => message.type !== 'groupchat' || message.to !== id.jid)) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Channel or group-DM history contains a message outside the verified conversation.');
  }
  messages.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  return { messages, unsupportedItems, hasMore: page.hasMore ?? page.has_more ?? response.hasMore ?? response.has_more,
    nextCursor: page.nextCursor ?? response.nextCursor, retainedHistoryExhausted: page.retainedHistoryExhausted === true };
}

async function thread(chat, id, timestamp, limit, before, start = timestamp) {
  const response = await chat.request('/xms/thread/fetch', { body: {
    sessions: [{ session: id.bare, limit, timeframe: `${start}:${before ?? ''}`, thread: timestamp,
      type: 'groupchat', sort: 'desc', main_msg: true, need_total: true }],
    noNeedEmoji: false, noNeedLatestComments: false,
  } });
  const page = Array.isArray(response.data) && response.data.find(item =>
    (item.session === id.jid || item.session === id.bare) && Number(item.thread) === timestamp);
  if (!page || typeof page.message !== 'string' || !Array.isArray(page.comments) || !Number.isSafeInteger(page.total) || page.total < 0) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Chat did not return a recognized parent and replies for this thread.');
  }
  const [parent] = await chat.parseMessages([{ message: page.message, timestamp: page.thread, msg_id: page.thread_id, comment_total: page.total }]);
  if (!parent?.id || parent.to !== id.jid || parent.type !== 'groupchat' || parent.replyTo) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Chat did not return a channel parent for this thread.');
  }
  const { messages, unsupportedItems } = await parseHistoryRecords(chat, page.comments.map(record => ({ ...record, message: record.msg })));
  if (!Array.isArray(messages)) throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned unrecognized thread replies.');
  messages.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  return { parent, messages, unsupportedItems, total: page.total, hasMore: page.hasMore ?? page.has_more ?? response.hasMore ?? response.has_more,
    nextCursor: page.nextCursor ?? response.nextCursor };
}

async function pagedHistory(chat, id, timestamp, limit, before, scope) {
  const first = timestamp === null ? await history(chat, id, limit, before) : await thread(chat, id, timestamp, limit, before);
  let boundary;
  if (first.messages.length >= limit) {
    const oldest = Math.min(...first.messages.map(m => m.timestamp));
    try {
      boundary = timestamp === null
        ? await history(chat, id, BOUNDARY_LIMIT, oldest, oldest)
        : await thread(chat, id, timestamp, BOUNDARY_LIMIT, oldest, oldest);
    } catch (error) {
      boundary = { errorCode: error instanceof AppError ? error.code : 'INTERNAL_ERROR' };
    }
  }
  return completeHistoryPage(first, boundary, limit, scope);
}

async function readConversation(chat, id, channel, options, limit, before, scope) {
  if (Number(channel.type) !== 2 || channel.e2e !== '0') {
    throw new AppError('UNSUPPORTED_CONVERSATION', 'Conversation composition requires a private unencrypted channel.');
  }
  const threadLimit = integer(options['thread-limit'] ?? 20, 'Thread limit', 1);
  const maxThreads = integer(options['max-threads'] ?? 20, 'Maximum threads', 1);
  if (limit > 100 || threadLimit > 100 || maxThreads > 100) throw new AppError('INVALID_INPUT', 'History/thread limits and maximum threads must not exceed 100.');
  const page = await pagedHistory(chat, id, null, limit, before, scope);
  const records = new Map(), candidates = new Map(), threads = [], conflicts = [];
  const unsupportedItems = [...(page.unsupportedItems ?? [])];
  const add = message => {
    const previous = records.get(message.id);
    if (previous && ['timestamp', 'from', 'to', 'text', 'richText', 'replyTo'].some(key =>
      !isDeepStrictEqual(previous[key], message[key]))) {
      conflicts.push({ id: message.id, previous, current: message }); return;
    }
    records.set(message.id, { ...message, replyCount: message.replyCount ?? previous?.replyCount ?? null });
  };
  for (const message of page.messages) {
    add(message);
    if (!message.replyTo) candidates.set(message.id, message);
  }
  for (const message of page.messages) {
    if (message.replyTo && !candidates.has(message.replyTo.id)) candidates.set(message.replyTo.id, {
      id: message.replyTo.id, timestamp: Number(message.replyTo.thread), replyCount: null,
    });
  }
  let requested = 0;
  for (const root of candidates.values()) {
    const command = ['chat', 'thread', '--channel', id.jid, '--thread', String(root.timestamp), '--limit', String(threadLimit)];
    const entry = { parentId: root.id, parentTimestamp: root.timestamp, replyIds: [], total: root.replyCount ?? null,
      nextCursor: null, readCommand: command };
    if (root.replyCount === 0) {
      threads.push({ ...entry, status: 'native-zero-count', pagination: { complete: true, status: 'end', snapshot: false } });
      continue;
    }
    if (requested >= maxThreads) {
      threads.push({ ...entry, status: 'not-read', pagination: { complete: false, status: 'incomplete', reason: 'THREAD_BUDGET_LIMIT' } });
      continue;
    }
    requested++;
    try {
      if (!Number.isSafeInteger(root.timestamp) || root.timestamp <= 0) throw new AppError('UNSUPPORTED_CONTENT', 'No usable parent timestamp.');
      const threadScope = cursorScope('chat thread', { channel: id.jid, thread: root.timestamp });
      const result = await pagedHistory(chat, id, root.timestamp, threadLimit, undefined, threadScope);
      if (result.parent.id !== root.id || result.parent.timestamp !== root.timestamp
        || result.messages.some(message => message.to !== id.jid || message.type !== 'groupchat'
          || message.replyTo?.id !== root.id || Number(message.replyTo.thread) !== root.timestamp)) {
        throw new AppError('UNSUPPORTED_CONTENT', 'Thread returned a different parent or unrelated reply identity.');
      }
      add(result.parent); result.messages.forEach(add);
      unsupportedItems.push(...(result.unsupportedItems ?? []));
      threads.push({ ...entry, status: 'read', replyIds: result.messages.map(message => message.id), total: result.total,
        pagination: result.pagination, nextCursor: result.nextCursor,
        readCommand: result.nextCursor ? [...command, '--cursor', result.nextCursor] : null });
    } catch (error) {
      if (['PROVIDER_APPROVAL_REQUIRED', 'AUTH_REQUIRED', 'REAUTHENTICATION_REQUIRED', 'REQUEST_CANCELLED'].includes(error?.code)) throw error;
      threads.push({ ...entry, status: 'unavailable', error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' },
        pagination: { complete: false, status: 'incomplete', reason: 'THREAD_READ_FAILED' } });
    }
  }
  const messages = [...records.values()].sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const missingAuthorIds = messages.filter(message => typeof message.from !== 'string' || !message.from).map(message => message.id);
  const authors = [...new Set(messages.map(message => message.from).filter(value => typeof value === 'string' && value))], profiles = [];
  for (let offset = 0; offset < authors.length; offset += 100) {
    const batch = authors.slice(offset, offset + 100);
    try { profiles.push(await userCards(chat, batch.join(','))); }
    catch (error) {
      if (['PROVIDER_APPROVAL_REQUIRED', 'AUTH_REQUIRED', 'REAUTHENTICATION_REQUIRED', 'REQUEST_CANCELLED'].includes(error?.code)) throw error;
      profiles.push({ complete: false, items: batch.map(jid => ({ input: jid, requestedJid: jid, status: 'unavailable', profile: null })),
        error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' } });
    }
  }
  const threadComplete = threads.every(entry => entry.pagination.complete), profileComplete = !missingAuthorIds.length && profiles.every(batch => batch.complete);
  return { channel: summary(id.jid, channel), messages, unsupportedItems, rootIds: [...candidates.keys()], threads, profiles, missingAuthorIds, conflicts,
    history: { messageIds: page.messages.map(message => message.id), nextCursor: page.nextCursor, pagination: page.pagination },
    nextCursor: page.nextCursor, limits: { history: limit, repliesPerThread: threadLimit, maxThreads, threadsRequested: requested },
    coverage: { complete: page.pagination.complete && threadComplete && profileComplete && conflicts.length === 0,
      historyComplete: page.pagination.complete, threadsComplete: threadComplete, profilesComplete: profileComplete,
      contentComplete: messages.every(message => message.contentComplete === true), snapshot: false,
      scope: 'returned-private-channel-history-and-separately-bounded-threads', unseenArchiveComplete: false },
    order: 'timestamp-descending', absenceProvesDeletion: false };
}

function xml(value) {
  return String(value).replace(/[&<>"'\r\n\t]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;', '\n': '&#10;', '\t': '&#9;' })[character]);
}

export function xmlText(value) {
  return typeof value === 'string' && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value);
}

async function encodeTextMessage(chat, id, channel, text, reply, mention) {
  if (!xmlText(text) || !text.trim()) throw new AppError('INVALID_INPUT', 'Supply non-empty text containing valid XML characters.');
  if (channel.e2e !== '0') throw new AppError('UNSUPPORTED_ENCRYPTION', 'Sending to encrypted channels is not supported. No message sent.');
  const from = chat.from, displayName = await chat.getDisplayName();
  const slash = typeof from === 'string' ? from.indexOf('/') : -1;
  if (slash < 1 || slash === from.length - 1 || !xmlText(from) || !xmlText(displayName) || !xmlText(channel.name)) {
    throw new AppError('CHAT_IDENTITY_ERROR', 'Chat did not provide a usable sender identity or channel name. No message sent.');
  }
  const messageId = `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N`;
  const body = mention ? `@${mention.label} ${text}` : text;
  const content = mention ? [{ data: { 'custom-inline': { type: 'mention', mentionType: mention.type,
    jid: mention.jid, label: mention.label, prefix: '@' } } }, { data: ` ${text}` }] : [{ data: text }];
  const page = { type: 'Page', style: {}, children: [{ type: 'Paragraph', content }] };
  const mentionXml = mention ? `<at><user jid="${xml(mention.jid)}" s="0" e="${mention.label.length}" t="${mention.type}"/></at>` : '';
  const replyXml = reply ? `<reply msg_id="${xml(reply.id)}" owner="${xml(reply.owner)}" thread_t="${reply.thread}"/>` : '';
  const stanza = `<message xmlns="jabber:client" from="${xml(from)}" id="${xml(messageId)}" to="${xml(id.jid)}" type="groupchat"><zmrt>${xml(JSON.stringify(page))}</zmrt><body>${xml(body)}</body><sns><format>%1$@ in %2$@: %3$@</format><args><arg>${xml(displayName)}</arg><arg>${xml(channel.name)}</arg><body/></args></sns><zmext><msg_type>17</msg_type><ori_type>0</ori_type><from n="${xml(displayName)}" res="${xml(from.slice(slash + 1))}"/><to/><obj f="18" st="0" fs="0"/><visible>true</visible><msg_feature>${reply ? 32780 : 32768}</msg_feature>${mentionXml}${replyXml}</zmext></message>`;
  return { messageId, body, stanza };
}

async function send(chat, id, channel, text, reply, mention) {
  const { messageId, body, stanza } = await encodeTextMessage(chat, id, channel, text, reply, mention);
  const context = { operation: mention ? 'chat.mention-group-send' : id.type === 'groupchat' ? 'chat.group-send' : reply ? 'chat.reply' : 'chat.send', id: messageId,
    ...(id.type === 'groupchat' ? { groupId: id.jid } : { channelId: id.jid }), ...(reply ? { thread: reply.thread } : {}),
    ...(mention ? { mention } : {}) };
  let lastError;
  // Local transmission is not service acceptance. Never replay an uncertain send.
  try { await chat.sendStanza(stanza); }
  catch (error) {
    const failure = writeFailure(error, { ...context, acceptance: 'unobserved' });
    if (failure.details.outcome !== 'unknown') throw failure;
    lastError = error;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    let timer;
    try {
      const result = await Promise.race([
        reply ? thread(chat, id, reply.thread, 50) : history(chat, id, 50),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); }),
      ]);
      const message = result?.messages.find(item => item.id === messageId && item.text === body);
      if (message) return { ...context, channel: summary(id.jid, channel), outcome: 'confirmed', acceptance: 'persistence_readback', verified: true, message };
    } catch (error) { lastError = error; }
    finally { clearTimeout(timer); }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(300, remaining)));
  }
  throw writeFailure(lastError ?? new AppError('READBACK_MISMATCH', 'The message ID and text were not observed in the bounded history readback.'),
    { ...context, acceptance: 'unobserved' }, 'unknown');
}

async function contactSearch(chat, query) {
  if (typeof query !== 'string' || query.trim().length < 3 || query.length > 254) {
    throw new AppError('INVALID_INPUT', 'Supply a user query of 3–254 characters; native search requires at least three.');
  }
  const result = await chat.request('/nws/asyncim/1.0/api/search/contact', { body: {
    key: query, contactType: '0', needExternalFriend: false, pilotFeature: [3], sortType: 1, sourceType: 4,
  } });
  if (result.errorCode !== 0 || !Array.isArray(result.result)) throw new AppError('RESOLUTION_INCOMPLETE', 'Native contact search did not succeed.');
  return result.result;
}

async function searchUsers(chat, query) {
  const rows = await contactSearch(chat, query);
  const users = rows.filter(row => row.isSameAccount === 1 && row.externalFriend === false
    && row.inactiveStatus === 0 && row.type === 0);
  if (users.some(row => typeof row.userId !== 'string' || typeof row.snsEmail !== 'string'
    || !/^[A-Za-z0-9_-]+@[^@\s/]+$/.test(row.jid ?? '') || row.jid.split('@')[0] !== row.userId)) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Native user search returned an unrecognized identity.');
  }
  return { query, searchExhaustive: false, globalUniqueness: 'unknown', items: users.map(row => ({ searchUserId: row.userId, jid: row.jid,
    matchQuality: row.snsEmail.toLowerCase() === query.toLowerCase() ? 'exact-email' : row.displayName?.toLowerCase() === query.toLowerCase() ? 'exact-name' : 'partial',
    name: row.displayName ?? null, email: row.snsEmail, firstName: row.firstName ?? null,
    lastName: row.lastName ?? null, department: row.dept ?? null, jobTitle: row.jobTitle ?? null,
    sameAccount: true, active: true, highlights: row.highlights ?? [] })),
    scope: 'active-same-account-native-contact-search', excludedCount: rows.length - users.length,
    nextCursor: null, pagination: { complete: false, status: 'incomplete',
      reason: 'Native response has no total or verified continuation contract; refine the query.' } };
}

async function sendDirect(chat, options) {
  const context = { operation: 'chat.dm-send', id: `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N` };
  let submitted = false, acknowledged = false, lastError, definitiveOutcome;
  try {
    if (!xmlText(options.text) || !options.text.trim()) throw new AppError('INVALID_INPUT', 'Supply non-empty valid XML text.');
    const user = await resolveDirectRecipient(chat, options);
    context.peerJid = user.jid;
    const from = chat.from, self = from.split('/')[0], slash = from.indexOf('/');
    if (user.jid === self) throw new AppError('INVALID_INPUT', 'Personal notes are not supported by direct sending.');
    if (await chat.directEncryptionMode(user.jid) !== 'none') throw new AppError('UNSUPPORTED_ENCRYPTION', 'Native direct encryption is enabled; nothing sent.');
    const name = await chat.getDisplayName();
    if (slash < 1 || !xmlText(name) || !xmlText(from)) throw new AppError('CHAT_IDENTITY_ERROR', 'Native sender identity is unusable.');
    const page = { type: 'Page', children: [{ type: 'Paragraph', content: [{ data: options.text }] }] };
    const stanza = `<message xmlns="jabber:client" from="${xml(from)}" id="${xml(context.id)}" to="${xml(user.jid)}" type="chat"><zmrt>${xml(JSON.stringify(page))}</zmrt><body>${xml(options.text)}</body><sns><format>%1$@: %2$@</format><args><arg>${xml(name)}</arg><body/></args></sns><zmext><msg_type>0</msg_type><from n="${xml(name)}" res="${xml(from.slice(slash + 1))}"/><to/><visible>true</visible><msg_feature>4</msg_feature></zmext></message>`;
    submitted = true;
    try {
      const ack = await chat.sendIq(stanza, context.id);
      if (ack.from !== from || !Number.isSafeInteger(Number(ack.echo?.timestamp)) || Number(ack.echo?.timestamp) <= 0) {
        throw new AppError('WRITE_UNCONFIRMED', 'Native direct-message echo did not match the sender and timestamp.');
      }
      context.timestamp = Number(ack.echo.timestamp);
      acknowledged = true;
    } catch (error) {
      const failure = writeFailure(error, context);
      if (failure.details.outcome !== 'unknown') {
        definitiveOutcome = failure.details.outcome;
        throw failure;
      }
      lastError = error;
    }
    const id = { jid: user.jid, bare: user.jid.split('@')[0], type: 'chat' };
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { messages } = await history(chat, id, 100);
        const message = messages.find(message => message.id === context.id && message.text === options.text
          && message.from === self && message.to?.split('/')[0] === user.jid
          && (!acknowledged || message.timestamp === context.timestamp));
        if (message) return { ...context, user, message, outcome: 'confirmed', verified: true,
          acceptance: acknowledged ? 'native-echo' : 'persistence_readback',
          verification: 'exact-sender-peer-id-text-history', encryption: 'current-native-web-none', atomic: false };
      } catch (error) { lastError = error; }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw lastError ?? new AppError('READBACK_MISMATCH', 'Direct message was not observed by ID and text; inspect dm-read before any retry.');
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: acknowledged ? 'accepted' : 'unobserved' },
      definitiveOutcome ?? (submitted ? 'unknown' : 'not_sent'));
  }
}

async function userCards(chat, users) {
  const inputs = typeof users === 'string' ? users.split(',') : [];
  if (!inputs.length || inputs.length > 100 || inputs.some(input =>
    !/^[A-Za-z0-9_-]{1,128}(?:@[A-Za-z0-9.-]+)?$/.test(input))) {
    throw new AppError('INVALID_INPUT', 'Supply 1–100 comma-separated user IDs or user JIDs.');
  }
  const domain = chat.from.split('/')[0].split('@')[1];
  const jids = inputs.map(input => input.includes('@') ? input.toLowerCase() : `${input.toLowerCase()}@${domain}`);
  if (jids.some(jid => jid.split('@')[1] !== domain)) throw new AppError('INVALID_INPUT', 'User cards require the session-derived user JID domain, not a channel or foreign domain.');
  const response = await chat.request('/api/v1/ucs/contact/vcard/batch', { body: { userJids: [...new Set(jids)] } });
  if (!Array.isArray(response.vcardUsers)) throw new AppError('UNSUPPORTED_CONTENT', 'Native cards response has no recognized profile list.');
  const profiles = new Map();
  for (const profile of response.vcardUsers) {
    if (!jids.includes(profile.jid) || profiles.has(profile.jid) || typeof profile.userId !== 'string'
      || profile.userId.toLowerCase() !== profile.jid.split('@')[0]) {
      throw new AppError('UNSUPPORTED_CONTENT', 'Native card identity does not match a requested user.');
    }
    profiles.set(profile.jid, profile);
  }
  const items = inputs.map((input, index) => {
    const profile = profiles.get(jids[index]);
    return { input, requestedJid: jids[index], status: profile ? 'resolved' : 'unresolved',
      identity: profile ? { id: profile.userId, accountId: profile.accountId ?? null,
        displayName: profile.displayName ?? profile.nickName ?? profile.name ?? null, email: profile.email ?? null,
        provenance: { source: 'native-ucs-vcard', observedAt: new Date().toISOString() } } : null, observations: [],
      userId: profile?.userId ?? null, profile: profile ?? null,
      relationships: profile ? { organizationIds: profile.organization ?? null,
        hasManager: profile.hasManager ?? null, managerUserId: profile.managerUserId || null,
        hasOrgChart: profile.hasOrgChart ?? null } : null };
  });
  return { items, complete: items.every(item => item.status === 'resolved'),
    nativeOutcomes: Object.fromEntries(['unknownUsers', 'hiddenUsers', 'inactiveUsers', 'invisibleUsers',
      'unsupportedUsers', 'failedUsers'].map(key => [key, response[key] ?? null])),
    scope: 'explicit-user-native-cards', idMatching: 'normalized-chat-jid; canonical-userId-preserved',
    absentProfileProvesNonexistence: false };
}

// Read-only enrichment never authorizes a mutation or substitutes a roster.
async function readUserCards(chat, inputs) {
  const lookup = async ids => {
    try { return await userCards(chat, ids.join(',')); }
    catch (error) {
      if (!(error instanceof AppError) || !['HTTP_ERROR', 'REQUEST_FAILED', 'CHAT_SERVICE_ERROR', 'RATE_LIMITED',
        'FORBIDDEN', 'UNSUPPORTED_CONTENT'].includes(error.code)) throw error;
      const cause = stepError(error, 'chat.identity-resolution', 'native-cards').details.cause;
      return { complete: false, items: ids.map(input => ({ input, requestedJid: input, status: 'unavailable', identity: null, profile: null, error: cause })), error: cause };
    }
  };
  if (!inputs.length) return { items: [], complete: true };
  const batch = await lookup(inputs);
  if (!batch.error || inputs.length === 1) return batch;
  const items = [];
  for (const input of inputs) items.push(...(await lookup([input])).items);
  return { items, complete: items.every(item => item.status === 'resolved'), error: batch.error,
    scope: 'explicit-user-native-cards', absentProfileProvesNonexistence: false };
}

async function resolveContact(chat, email) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new AppError('INVALID_INPUT', 'Supply an existing user’s full email address.');
  }
  const rows = await contactSearch(chat, email);
  const matches = rows.filter(user => user.snsEmail?.toLowerCase() === email.toLowerCase());
  if (matches.length > 1) throw new AppError('AMBIGUOUS_USER', 'Multiple Chat contacts match this email.');
  const contact = matches[0];
  if (!contact || contact.isSameAccount !== 1 || contact.externalFriend !== false || contact.inactiveStatus !== 0
    || contact.type !== 0 || !/^[A-Za-z0-9_-]+@[^@\s/]+$/.test(contact.jid ?? '')) {
    throw new AppError('USER_NOT_FOUND', 'No active existing same-account Chat user matches this email; no email invitation was synthesized.');
  }
  const response = await chat.request('/api/v1/ucs/contact/vcard/batch', { body: { userJids: [contact.jid] } });
  const profile = response.vcardUsers?.length === 1 ? response.vcardUsers[0] : null;
  if (!profile || profile.jid !== contact.jid || profile.email?.toLowerCase() !== email.toLowerCase()
    || profile.userId?.toLowerCase() !== contact.userId || !profile.organization?.includes(chat.identity.user.accountId)
    || !xmlText(contact.displayName) || !contact.displayName.trim()) {
    throw new AppError('RESOLUTION_INCOMPLETE', 'Native contact and profile identity disagree.');
  }
  return { jid: profile.jid, userId: profile.userId, email: profile.email, name: contact.displayName };
}

async function directPeer(chat, peer) {
  const self = chat.from.split('/')[0], domain = self.split('@')[1];
  if (typeof peer !== 'string' || !/^[A-Za-z0-9_-]+@[^@/]+$/.test(peer)
    || peer.split('@')[1] !== domain || peer === self) {
    throw new AppError('UNSUPPORTED_DIRECT_PAIR', 'Direct links require another user on the session-derived domain, not personal notes or group DMs.');
  }
  const cards = await userCards(chat, peer), user = cards.items[0]?.profile;
  if (!user || !user.organization?.includes(chat.identity.user.accountId)) {
    throw new AppError('TENANT_MISMATCH', 'The explicit direct peer is unavailable or not verified in this account.');
  }
  if (await chat.directEncryptionMode(peer) !== 'none') {
    throw new AppError('UNSUPPORTED_ENCRYPTION', 'Direct lookup requires the verified current native web encryption mode.');
  }
  return { jid: peer, bare: peer.split('@')[0], type: 'chat', user };
}

async function linkedDirect(chat, link) {
  const self = chat.from.split('/')[0], pair = link.direct;
  if (pair.sid !== self && pair.sid2 !== self) throw new AppError('UNSUPPORTED_DIRECT_PAIR', 'This link does not include the authenticated actor.');
  const id = await directPeer(chat, pair.sid === self ? pair.sid2 : pair.sid);
  // Current native Jump uses fetch2 around sendTime; select exact ID/time within its bounded timestamp bucket.
  const { messages } = await history(chat, id, BOUNDARY_LIMIT, link.time, link.time);
  const matches = messages.filter(message => message.id === link.message && message.timestamp === link.time);
  if (matches.length > 1 || matches.some(message => message.replyTo)) throw new AppError('UNSUPPORTED_DIRECT_MESSAGE', 'Direct reply lookup or conflicting exact identity is not verified.');
  const message = matches[0] ?? null;
  return { link, conversation: { type: 'chat', self, peer: id.jid }, user: id.user, message,
    parent: null, threadCommand: null, outcome: message ? 'confirmed' : 'unknown',
    scope: 'exact-direct-message-id-time-pair', absenceProvesDeletion: false,
    lookup: 'bounded-native-history-timestamp-bucket', encryption: 'current-native-web-none' };
}

async function readDirect(chat, options) {
  const user = await resolveDirectRecipient(chat, options);
  const self = chat.from.split('/')[0];
  if (user.jid === self) throw new AppError('INVALID_INPUT', 'Use a different existing user; personal notes are not direct conversations.');
  const id = { jid: user.jid, bare: user.jid.split('@')[0], type: 'chat' };
  const limit = integer(options.limit ?? 20, 'Limit', 1);
  if (limit > 100) throw new AppError('INVALID_INPUT', 'Limit must not exceed 100.');
  if (options.cursor !== undefined && options.before !== undefined) throw new AppError('INVALID_INPUT', 'Supply cursor or before, not both.');
  const scope = ['chat dm-read', `${self}:${user.jid}`, null, options.timeRange ? [options.timeRange.since, options.timeRange.until] : null];
  const before = options.cursor ? decodeCursor(options.cursor, scope).before
    : options.before !== undefined ? integer(options.before, 'Before timestamp', 0) : undefined;
  return { user, conversation: { type: 'chat', self, peer: user.jid },
    ...await pagedHistory(chat, id, null, limit, before, scope), order: 'timestamp-descending',
    scope: 'direct-conversation-history', absenceProvesNoPriorConversation: false };
}

async function changeMember(chat, options, remove) {
  const context = { operation: remove ? 'chat.remove-member' : 'chat.add-member',
    requestId: `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N`, email: options.email };
  let submitted = false, accepted = false;
  try {
    const expected = typeof options['expect-users'] === 'string' ? options['expect-users'].split(',').map(value => value.toLowerCase()) : [];
    if (!expected.length || expected.some(value => !/^[A-Za-z0-9_-]+$/.test(value)) || new Set(expected).size !== expected.length) {
      throw new AppError('INVALID_INPUT', 'Supply unique comma-separated --expect-users IDs including the owner.');
    }
    const user = await resolveContact(chat, options.email);
    const id = channelId(options.channel, chat.channelSuffix);
    Object.assign(context, { channelId: id.jid, user });
    const channel = await writeChannelInfo(chat, id);
    const owner = chat.identity.user.userId.toLowerCase();
    if (channel.owner !== owner || Number(channel.type) !== 2 || channel.e2e !== '0') {
      throw new AppError('FORBIDDEN', 'Membership changes require an owner-controlled private unencrypted channel.');
    }
    const check = (roster, users) => {
      if (!roster.pagination.complete || roster.items.length !== users.length
        || !users.includes(owner) || roster.items.some(item => !users.includes(item.jid.split('@')[0]) || item.isZccQ !== false)) {
        throw new AppError('AUDIENCE_MISMATCH', 'Complete visible membership must match --expect-users exactly, including the owner.');
      }
    };
    const before = await members(chat, id, channel, 1000);
    check(before, expected);
    const target = user.jid.split('@')[0];
    if (target === owner) throw new AppError('INVALID_INPUT', 'Owner removal/transfer is not supported.');
    if (expected.includes(target) !== remove) {
      throw new AppError(remove ? 'NOT_A_MEMBER' : 'ALREADY_MEMBER', remove ? 'Recipient is not a current member.' : 'Recipient is already a member; nothing sent.');
    }
    const desired = remove ? expected.filter(value => value !== target) : [...expected, target];
    const action = remove ? 'kick' : 'invite';
    const stanza = `<iq from="${xml(chat.from)}" id="${xml(context.requestId)}" to="${xml(id.jid)}" type="${remove ? 'get' : 'set'}" xmlns="jabber:client"><zoom action="${action}" xmlns="zoom:iq:room"><buddylist><item displayName="${xml(user.name)}" nickname="${xml(target)}">${xml(user.jid)}</item></buddylist></zoom></iq>`;
    submitted = true;
    const acknowledgement = await chat.sendIq(stanza, context.requestId);
    accepted = true;
    if (acknowledgement.from !== id.jid || acknowledgement.room?.xmlns !== 'zoom:iq:room'
      || acknowledgement.room.action !== action || acknowledgement.room.notAllowed.length
      || Number(acknowledgement.room.memberCount) !== desired.length) {
      throw new AppError('MEMBERSHIP_UNCONFIRMED', 'IQ acknowledgement did not confirm the exact membership change. Inspect roster before retrying.');
    }
    let lastError;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const current = await writeChannelInfo(chat, id);
        if (current.owner !== channel.owner || Number(current.type) !== 2 || current.e2e !== '0') throw new AppError('CHANNEL_CHANGED', 'Channel ownership/privacy changed during readback.');
        const after = await members(chat, id, current, 1000);
        check(after, desired);
        if (after.items.some(item => item.jid !== user.jid && item.role !== before.items.find(old => old.jid === item.jid)?.role)) {
          throw new AppError('ROLE_CHANGED', 'Another member role changed during readback.');
        }
        return { ...context, outcome: 'confirmed', acceptance: 'accepted', verified: true,
          verification: 'native-iq-and-complete-roster', atomic: false, affectedUserAccessVerified: false,
          members: after.items, acknowledgement: acknowledgement.room };
      } catch (error) { lastError = error; }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw lastError;
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' },
      accepted ? 'unknown' : submitted ? undefined : 'not_sent');
  }
}

async function createChannel(chat, options) {
  const { name, description = '' } = options;
  if (!xmlText(name) || !name.trim() || !xmlText(description)) {
    throw new AppError('INVALID_INPUT', 'Supply a non-empty channel name and a description containing valid XML characters.');
  }
  if (Object.keys(options).some(key => /member|invite|owner|public|privacy|permission/i.test(key))) {
    throw new AppError('INVALID_INPUT', 'Channel creation supports only a private channel with the current owner; membership and permission inputs are not supported.');
  }
  const from = chat.from;
  const displayName = await chat.getDisplayName();
  const slash = typeof from === 'string' ? from.indexOf('/') : -1;
  const bare = slash > 0 ? from.slice(0, slash) : '';
  const owner = bare.split('@')[0];
  if (!xmlText(from) || slash < 1 || slash === from.length - 1 || !/^[^@/]+@[^@/]+$/.test(bare) || !xmlText(displayName) || !displayName.trim()) {
    throw new AppError('CHAT_IDENTITY_ERROR', 'Chat did not provide a usable channel owner identity. Nothing was sent.');
  }
  channelId('validate', chat.channelSuffix);
  const requestId = `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N`;
  const desc = `<desc ver="1" e2e="0"><text v="${xml(description)}"/></desc>`;
  const stanza = `<iq from="${xml(from)}" id="${xml(requestId)}" to="${xml(chat.channelSuffix.slice(1))}" type="get" xmlns="jabber:client"><zoom action="create" xmlns="zoom:iq:room"><room option="864691197174611980" subject="${xml(name)}" natural="${xml(name)}" desc="${xml(desc)}" e2e="0"><option_ext><item rank="1">4</item></option_ext></room><buddylist><item displayName="${xml(displayName)}" nickname="${xml(owner)}">${xml(bare)}</item></buddylist></zoom></iq>`;
  let acknowledged = false, createdChannelId;
  try {
    const { room } = await chat.sendIq(stanza, requestId);
    acknowledged = true;
    if (!room?.jid) throw new AppError('WRITE_UNCONFIRMED', 'Channel creation acknowledgement did not identify a channel.');
    const id = channelId(room.jid, chat.channelSuffix);
    createdChannelId = id.jid;
    const channel = await writeChannelInfo(chat, id);
    if (channel.owner !== owner || Number(channel.memberCount) !== 1 || Number(channel.type) !== 2 || channel.name !== name || channel.e2e !== '0') {
      throw new AppError('WRITE_UNCONFIRMED', 'Created channel ownership or privacy could not be verified.');
    }
    return { requestId, channel: summary(id.jid, channel), outcome: 'confirmed', acceptance: 'accepted', verified: true };
  } catch (error) {
    throw writeFailure(error, { operation: 'chat.create-channel', requestId, name,
      ...(createdChannelId ? { createdChannelId } : {}), acceptance: acknowledged ? 'accepted' : 'unobserved' }, acknowledged ? 'unknown' : undefined);
  }
}

async function privateAudience(chat, id, channel, expectedUsers) {
  const expected = typeof expectedUsers === 'string' ? expectedUsers.toLowerCase().split(',') : [];
  if (!expected.length || expected.some(value => !/^[a-z0-9_-]+$/.test(value)) || new Set(expected).size !== expected.length) {
    throw new AppError('INVALID_INPUT', 'Supply unique comma-separated --expect-users IDs.');
  }
  if (Number(channel.type) !== 2 || channel.e2e !== '0') throw new AppError('FORBIDDEN', 'This operation requires a private unencrypted channel.');
  const roster = await members(chat, id, channel, 1000);
  if (!roster.pagination.complete || roster.items.length !== expected.length
    || !expected.includes(chat.identity.user.userId.toLowerCase())
    || roster.items.some(item => !expected.includes(item.jid.split('@')[0]) || item.isZccQ !== false)) {
    throw new AppError('AUDIENCE_MISMATCH', 'Complete visible channel membership must match --expect-users exactly.');
  }
  return roster;
}

function groupUsers(chat, value) {
  const users = typeof value === 'string' ? value.toLowerCase().split(',').sort() : [];
  if (users.length < 3 || users.length > 10 || new Set(users).size !== users.length
    || users.some(user => !/^[a-z0-9_-]+$/.test(user))
    || !users.includes(chat.identity.user.userId.toLowerCase())) {
    throw new AppError('INVALID_INPUT', 'Group DMs require 3–10 unique user IDs including the authenticated user.');
  }
  return users;
}

async function groupAudience(chat, id, group, users) {
  if (Number(group.type) !== 3 || group.e2e !== '0') {
    throw new AppError('UNSUPPORTED_GROUP_DIRECT', 'This operation requires an ordinary unencrypted group DM, not a channel, public group, or two-person peer.');
  }
  const response = await chat.request('/xms/newchat/muc/batchGet/members', { body: {
    groupJids: [id.jid], size: 50, needMemberName: true,
  } });
  const rows = response.data?.[id.jid];
  const domain = chat.from.split('/')[0].split('@')[1];
  if (response.result !== 0 || !Array.isArray(rows) || rows.length >= 50
    || !Number.isSafeInteger(group.memberCount) || rows.length !== group.memberCount
    || rows.length !== users.length || new Set(rows.map(row => row?.userJid)).size !== rows.length
    || rows.some(row => typeof row?.userJid !== 'string'
      || row.isZccQ !== false || row.inactive !== 0
      || row.userJid.split('@')[1] !== domain || !users.includes(row.userJid.split('@')[0]))) {
    throw new AppError('AUDIENCE_MISMATCH', 'Complete visible group-DM membership must match the supplied users exactly.');
  }
  const cards = await userCards(chat, users.join(','));
  if (!cards.complete || cards.items.some(item => !item.profile.organization?.includes(chat.identity.user.accountId))) {
    throw new AppError('TENANT_MISMATCH', 'Every group-DM participant must resolve within the authenticated account.');
  }
  return { items: cards.items.map(item => ({ userId: item.userId, jid: item.requestedJid,
    name: rows.find(row => row.userJid === item.requestedJid)?.nickname ?? null })),
  complete: true, scope: 'verified-group-direct-audience', count: rows.length };
}

async function groupDirect(chat, action, options) {
  const users = groupUsers(chat, action === 'group-find' ? options.users : options['expect-users']);
  if (action === 'group-find') {
    const response = await chat.request('/xms/channel/search/mucList/byUsers', { body: {
      isFuzzySearch: false, users, archivedSessionStatus: 2,
    } });
    if (response.result !== 0 || !Array.isArray(response.data) || typeof response.lastValue !== 'string') {
      throw new AppError('UNSUPPORTED_CONTENT', 'Native group-DM discovery returned an unrecognized result.');
    }
    const items = [];
    for (const row of response.data) {
      const id = channelId(row.channelId, chat.channelSuffix), group = await readChannelInfo(chat, id);
      const audience = await groupAudience(chat, id, group, users);
      items.push({ group: { ...summary(id.jid, group), kind: 'group-direct' }, audience });
    }
    return { items, scope: 'exact-supplied-user-group-directs', nextCursor: null,
      pagination: { status: response.lastValue ? 'incomplete' : 'end', complete: !response.lastValue,
        snapshot: false, ...(response.lastValue ? { reason: 'CONTINUATION_UNVERIFIED' } : {}) } };
  }
  if (action === 'group-create') {
    if (!xmlText(options.name) || !options.name.trim()) throw new AppError('INVALID_INPUT', 'Supply a non-empty group-DM name.');
    const emails = typeof options.emails === 'string' ? options.emails.split(',') : [];
    if (emails.length !== users.length - 1 || new Set(emails.map(email => email.toLowerCase())).size !== emails.length) {
      throw new AppError('INVALID_INPUT', 'Supply one distinct existing-user email for every other group-DM participant.');
    }
    const contacts = await Promise.all(emails.map(email => resolveContact(chat, email)));
    const self = chat.from.split('/')[0], displayName = await chat.getDisplayName();
    const participants = [{ jid: self, name: displayName }, ...contacts];
    if (!xmlText(displayName) || !displayName.trim() || new Set(participants.map(item => item.jid)).size !== users.length
      || participants.some(item => !users.includes(item.jid.split('@')[0]))) {
      throw new AppError('AUDIENCE_MISMATCH', 'Resolved group-DM recipients must match --expect-users exactly.');
    }
    channelId('validate', chat.channelSuffix);
    const requestId = `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N`;
    const description = '<desc ver="1" e2e="0"><text v=""/></desc>';
    const stanza = `<iq from="${xml(chat.from)}" id="${xml(requestId)}" to="${xml(chat.channelSuffix.slice(1))}" type="get" xmlns="jabber:client"><zoom action="create" xmlns="zoom:iq:room"><room option="16" subject="${xml(options.name)}" natural="${xml(options.name)}" desc="${xml(description)}" e2e="0"><option_ext><item rank="1">0</item></option_ext></room><buddylist>${participants.map(item => `<item displayName="${xml(item.name)}" nickname="${xml(item.jid.split('@')[0])}">${xml(item.jid)}</item>`).join('')}</buddylist></zoom></iq>`;
    let accepted = false, createdGroupId;
    try {
      const result = await chat.sendIq(stanza, requestId);
      accepted = true;
      if (!result.room?.jid) throw new AppError('WRITE_UNCONFIRMED', 'Group-DM creation acknowledgement supplied no identity.');
      const id = channelId(result.room.jid, chat.channelSuffix);
      createdGroupId = id.jid;
      const group = await writeChannelInfo(chat, id), audience = await groupAudience(chat, id, group, users);
      if (group.name !== options.name) throw new AppError('WRITE_UNCONFIRMED', 'Created group-DM name did not match.');
      return { requestId, group: { ...summary(id.jid, group), kind: 'group-direct' }, audience,
        outcome: 'confirmed', acceptance: 'accepted', verified: true };
    } catch (error) {
      throw writeFailure(error, { operation: 'chat.group-create', requestId, name: options.name,
        ...(createdGroupId ? { createdGroupId } : {}), acceptance: accepted ? 'accepted' : 'unobserved' }, accepted ? 'unknown' : undefined);
    }
  }
  const id = channelId(options.group, chat.channelSuffix);
  const group = await (action === 'group-send' ? writeChannelInfo : readChannelInfo)(chat, id);
  id.type = 'groupchat';
  const audience = await groupAudience(chat, id, group, users);
  const details = { group: { ...summary(id.jid, group), kind: 'group-direct' }, audience };
  if (action === 'group-info') return details;
  if (action === 'group-send') {
    const { channel, ...result } = await send(chat, id, group, options.text);
    return { ...result, ...details, operation: 'chat.group-send', groupId: id.jid };
  }
  if (action === 'group-message') {
    if (typeof options.message !== 'string' || !/^[A-Za-z0-9_-]+$/.test(options.message)) throw new AppError('INVALID_INPUT', 'Supply a valid message ID.');
    const message = await exactMessage(chat, id, options.message, integer(options.time, 'Message timestamp', 1));
    return { ...details, message, outcome: message ? 'confirmed' : 'unknown', scope: 'exact-group-direct-message', absenceProvesDeletion: false };
  }
  const limit = integer(options.limit ?? 20, 'Limit', 1);
  if (limit > 100 || (options.cursor && options.before !== undefined)) throw new AppError('INVALID_INPUT', 'Group-DM reads require limit <=100 and either cursor or before.');
  const scope = ['chat group-read', id.bare, null, users, chat.from.split('/')[0], chat.identity.user.accountId];
  const before = options.cursor ? decodeCursor(options.cursor, scope).before
    : options.before === undefined ? undefined : integer(options.before, 'Before timestamp', 0);
  return { ...details, ...await pagedHistory(chat, id, null, limit, before, scope), order: 'timestamp-descending' };
}

async function mentionCatalog(chat, id) {
  const response = await chat.request('/xms/channel/mentiongroups', { body: { groupId: id.jid } });
  const rows = response.data?.mentionGroups;
  if (response.result !== 0 || response.data?.groupId !== id.jid || !Array.isArray(rows)
    || new Set(rows.map(row => row?.mgroupId)).size !== rows.length
    || rows.some(row => typeof row?.mgroupId !== 'string' || !/^[A-Za-z0-9_.@-]{1,512}$/.test(row.mgroupId)
      || row.groupId !== id.jid || !xmlText(row.name) || !row.name.trim() || row.version === null || row.version === undefined
      || !Number.isSafeInteger(Number(row.version)))) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Native mention-group catalog identity or version is unrecognized.');
  }
  return rows.map(row => ({ id: row.mgroupId, channelId: id.jid, name: row.name,
    description: row.desc ?? '', version: Number(row.version), kind: 'channel-mention-group' }));
}

function mentionMembers(value, audience, name) {
  const users = typeof value === 'string' ? value.toLowerCase().split(',').sort() : [];
  if (!users.length || users.length > 99 || new Set(users).size !== users.length
    || users.some(user => !/^[a-z0-9_-]+$/.test(user) || !audience.items.some(item => item.jid.split('@')[0] === user))) {
    throw new AppError('AUDIENCE_MISMATCH', `${name} must be unique existing members of the exact private-channel audience.`);
  }
  return users;
}

async function mentionGroupInfo(chat, id, group, audience) {
  const response = await chat.request('/bffapi/channel/mentionGroup/members/client', { body: {
    mentionGroups: [{ groupId: id.jid, mgroupId: group.id, size: 100, lastValue: '' }],
  } });
  const page = response.data?.[group.id], rows = page?.members;
  if (response.result !== 0 || page?.result !== 0 || !Array.isArray(rows) || rows.length >= 100 || page.haveMore !== false
    || rows.some(row => typeof row?.username !== 'string' || row.mgroupId !== group.id)) {
    throw new AppError('AUDIENCE_INCOMPLETE', 'Mention-group membership did not provide a complete recognized native page.');
  }
  const domain = chat.from.split('/')[0].split('@')[1];
  const jids = rows.map(row => row.username.includes('@') ? row.username.toLowerCase() : `${row.username.toLowerCase()}@${domain}`);
  if (new Set(jids).size !== jids.length || jids.some(jid => !audience.items.some(item => item.jid === jid))) {
    throw new AppError('AUDIENCE_MISMATCH', 'Mention-group recipients fall outside the exact private-channel audience.');
  }
  return { ...group, members: jids.sort().map(jid => ({ jid, userId: jid.split('@')[0] })), complete: true,
    membershipScope: 'unsaturated-native-page-with-explicit-end' };
}

async function channelMentionGroups(chat, action, options) {
  const id = channelId(options.channel, chat.channelSuffix);
  const channel = await (action === 'mention-groups' ? readChannelInfo : writeChannelInfo)(chat, id);
  const audience = await privateAudience(chat, id, channel, options['expect-users']);
  const catalog = await mentionCatalog(chat, id);
  if (action === 'mention-groups') return { channel: summary(id.jid, channel),
    items: await Promise.all(catalog.map(group => mentionGroupInfo(chat, id, group, audience))),
    scope: 'private-channel-mention-groups', nextCursor: null };
  const creating = action === 'mention-group-create', deleting = action === 'mention-group-delete';
  const before = creating ? null : catalog.find(group => group.id === options['mention-group']);
  if (!creating && (!before || before.name !== options['if-name'])) {
    throw new AppError('MENTION_GROUP_CHANGED', 'The exact mention-group ID and --if-name must still match.');
  }
  const current = before ? await mentionGroupInfo(chat, id, before, audience) : null;
  const previousUsers = current?.members.map(member => member.userId).sort();
  if (current && JSON.stringify(previousUsers) !== JSON.stringify(mentionMembers(options['expect-members'], audience, '--expect-members'))) {
    throw new AppError('MENTION_GROUP_CHANGED', 'Complete mention-group membership no longer matches --expect-members.');
  }
  if (action === 'mention-group-send') {
    const result = await send(chat, id, channel, options.text, undefined, { type: 4, jid: before.id, label: before.name });
    if (!result.message.mentions?.some(mention => mention.type === 4 && mention.jid === before.id
      && mention.start === 0 && mention.end === before.name.length)) {
      throw writeFailure(new AppError('READBACK_MISMATCH', 'Persisted mention metadata did not match the exact mention group.'),
        { operation: 'chat.mention-group-send', id: result.id, channelId: id.jid, mentionGroupId: before.id, acceptance: 'persistence_readback' }, 'unknown');
    }
    return { ...result, mentionGroup: current, recipients: current.members };
  }
  if (channel.owner !== chat.identity.user.userId.toLowerCase()) {
    throw new AppError('FORBIDDEN', 'Mention-group management is limited to this private channel’s owner; no role change is attempted.');
  }
  const name = options.name ?? before?.name, description = options.description ?? before?.description ?? '';
  if (!xmlText(name) || !name.trim() || !xmlText(description)) throw new AppError('INVALID_INPUT', 'Supply a valid mention-group name and description.');
  const desired = deleting ? [] : mentionMembers(options.members, audience, '--members');
  if (creating && catalog.some(group => group.name === name)) throw new AppError('ALREADY_EXISTS', 'An exact-name mention group already exists; no duplicate was created.');
  const domain = chat.from.split('/')[0].split('@')[1];
  const add = desired.filter(user => !previousUsers?.includes(user)), remove = (previousUsers ?? []).filter(user => !desired.includes(user));
  if (!creating && !deleting && !add.length && !remove.length && name === before.name && description === before.description) {
    throw new AppError('NO_CHANGE', 'The mention-group name, description and members already match.');
  }
  const mutation = creating ? 'create' : deleting ? 'delete' : 'update', requestId = randomUUID();
  const attrs = creating ? `name="${xml(name)}" desc="${xml(description)}" channel="${xml(id.jid)}" owner="${xml(chat.from.split('/')[0])}"`
    : deleting ? `id="${xml(before.id)}"` : `id="${xml(before.id)}" channel="${xml(id.jid)}" name="${xml(name)}" desc="${xml(description)}"`;
  const memberXml = creating ? desired.map(user => `<item>${xml(`${user}@${domain}`)}</item>`).join('')
    : deleting ? '' : add.map(user => `<add>${xml(`${user}@${domain}`)}</add>`).join('') + remove.map(user => `<remove>${xml(`${user}@${domain}`)}</remove>`).join('');
  const stanza = `<iq from="${xml(chat.from)}" id="${xml(requestId)}" to="${xml(id.jid)}" type="set"><query xmlns="zoom:iq:mgroups"><mgroup action="${mutation}" ${attrs}>${memberXml}</mgroup></query></iq>`;
  let accepted = false, mentionGroupId = before?.id;
  try {
    const response = await chat.sendIq(stanza, requestId);
    accepted = true;
    if (response.mentionGroup?.action !== mutation || !response.mentionGroup.id) throw new AppError('WRITE_UNCONFIRMED', 'Mention-group acknowledgement lacks the native action and identity.');
    if (mentionGroupId && response.mentionGroup.id !== mentionGroupId) throw new AppError('WRITE_UNCONFIRMED', 'Mention-group acknowledgement identity changed.');
    mentionGroupId = response.mentionGroup.id;
    const after = (await mentionCatalog(chat, id)).find(group => group.id === mentionGroupId);
    if (deleting) {
      if (after) throw new AppError('WRITE_UNCONFIRMED', 'Deleted mention group is still present.');
      return { requestId, mentionGroupId, channelId: id.jid, outcome: 'confirmed', acceptance: 'accepted', verified: true };
    }
    if (!after || after.name !== name || after.description !== description) throw new AppError('WRITE_UNCONFIRMED', 'Mention-group metadata did not match after mutation.');
    const result = await mentionGroupInfo(chat, id, after, audience);
    if (JSON.stringify(result.members.map(member => member.userId).sort()) !== JSON.stringify(desired)) {
      throw new AppError('WRITE_UNCONFIRMED', 'Mention-group recipient readback did not match.');
    }
    return { requestId, mentionGroup: result, channel: summary(id.jid, channel), outcome: 'confirmed', acceptance: 'accepted', verified: true };
  } catch (error) {
    throw writeFailure(error, { operation: `chat.${action}`, requestId, channelId: id.jid, ...(mentionGroupId ? { mentionGroupId } : {}),
      acceptance: accepted ? 'accepted' : 'unobserved' }, accepted ? 'unknown' : undefined);
  }
}

function messageAttachments(message) {
  const attachments = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    const value = node.data?.attachment;
    if (value && typeof value.attachmentId === 'string') attachments.push({
      fileId: value.attachmentId, name: value.name, size: value.size, mime: value.type,
      dimension: value.dimension ?? null, extra: value.extra ?? null,
    });
    for (const child of [...(Array.isArray(node.children) ? node.children : []), ...(Array.isArray(node.content) ? node.content : [])]) walk(child);
  };
  walk(message?.richText);
  return attachments;
}

async function inspectSticker(chat, options) {
  if (typeof options.file !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(options.file)) throw new AppError('INVALID_INPUT', 'Supply an exact own personal sticker file ID.');
  const metadata = await chat.attachment('info', { fileId: options.file });
  if (metadata.result !== 0 || metadata.fileId !== options.file || metadata.ownerId !== chat.identity.user.userId
    || metadata.ownerType !== 'user' || metadata.open !== false || metadata.encryption !== 0
    || metadata.shareJid || !metadata.channelTypes?.includes(5)) {
    throw new AppError('UNSUPPORTED_STICKER', 'Inspection requires an exact own private, unencrypted personal sticker, not an ordinary attachment, shared copy or account emoji.');
  }
  const mime = { png: 'image/png', gif: 'image/gif' }[metadata.extName];
  if (!mime || !Number.isSafeInteger(metadata.length) || metadata.length < 1 || metadata.length > 1024 * 1024
    || typeof metadata.fileName !== 'string' || !xmlText(metadata.fileName)) throw new AppError('UNSUPPORTED_STICKER', 'Only bounded PNG/GIF personal stickers are supported.');
  const downloaded = await chat.attachment('download', { fileId: options.file, maxBytes: 1024 * 1024 });
  const sha256 = createHash('sha256').update(downloaded.bytes).digest('hex');
  if (downloaded.bytes.length !== metadata.length || metadata.digest !== sha256) throw new AppError('ATTACHMENT_MISMATCH', 'Personal sticker bytes do not match native metadata.');
  const { dimension, media } = inspectAttachmentMedia(downloaded.bytes, mime);
  const catalog = await chat.sticker('list', { limit: 1000 });
  return { fileId: options.file, fileName: metadata.fileName, bytes: downloaded.bytes.length,
    mime, dimension, media, sha256, metadata, bytesVerified: true,
    catalog: { membership: catalog.files.some(file => file.fileId === options.file) ? 'present' : 'not-observed',
      nativeIndexEnd: !catalog.searchAfter, inventoryComplete: false,
      limitation: 'Native type-4 index can omit an acknowledged channel-5 personal asset; absence does not establish nonexistence.' } };
}

async function giphyMedia(chat, action, options) {
  if (action === 'gif-search') return chat.giphy('search', { query: options.query, limit: integer(options.limit ?? 30, 'Limit', 1) });
  if (typeof options.gif !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(options.gif)) throw new AppError('INVALID_INPUT', 'Supply an exact native GIF catalog ID.');
  const id = channelId(options.channel, chat.channelSuffix);
  const channel = await (action === 'gif-download' ? readChannelInfo : writeChannelInfo)(chat, id);
  if (channel.e2e !== '0') throw new AppError('UNSUPPORTED_ENCRYPTION', 'Encrypted GIF messages are not supported.');
  if (Number(channel.type) !== 2) throw new AppError('UNSUPPORTED_CONVERSATION_TYPE', 'GIF operations require an ordinary private channel, not a group DM or public channel.');
  if (action === 'gif-download') {
    const timestamp = integer(options.time, 'Message timestamp', 1), variant = options.variant ?? 'pc';
    const key = { pc: 'pcPicInfo', big: 'bigPicInfo', mobile: 'mobilePicInfo' }[variant];
    if (!key || typeof options.message !== 'string' || !/^[A-Za-z0-9_-]+$/.test(options.message)
      || typeof options.output !== 'string' || !options.output) throw new AppError('INVALID_INPUT', 'Supply exact message identity, a pc/big/mobile variant and new --output path.');
    const message = await exactMessage(chat, id, options.message, timestamp);
    const matches = messageAttachments(message).filter(item => item.fileId === options.gif);
    if (matches.length !== 1 || matches[0].extra?.type !== 'giphy' || matches[0].extra?.isSticker) throw new AppError('UNSUPPORTED_MEDIA_KIND', 'The exact message must link one native catalog GIF, not an ordinary file or sticker.');
    const attachment = matches[0], image = attachment.extra.data?.images?.[key];
    if (!image || !['width', 'height', 'size'].every(field => Number.isSafeInteger(image[field]) && image[field] > 0)) throw new AppError('UNSUPPORTED_GIPHY', 'Linked GIF rendition metadata is unverified.');
    if (image.size > 1024 * 1024) throw new AppError('ATTACHMENT_TOO_LARGE', 'GIF rendition downloads are bounded to1 MiB.');
    const result = await chat.giphy('download', { id: options.gif, url: image.url, maxBytes: 1024 * 1024 });
    const inspection = inspectAttachmentMedia(result.bytes, 'image/gif');
    if (result.bytes.length !== image.size || !isDeepStrictEqual(inspection.dimension, { width: image.width, height: image.height })) {
      throw new AppError('ATTACHMENT_MISMATCH', 'GIF bytes or dimensions disagree with the exact linked rendition.');
    }
    const after = await exactMessage(chat, id, options.message, timestamp);
    if (!isDeepStrictEqual(messageAttachments(after).filter(item => item.fileId === options.gif), matches)) {
      throw new AppError('ATTACHMENT_CHANGED', 'GIF linkage changed during download; no output was created.');
    }
    const destination = await open(options.output, 'wx', 0o600);
    try { await destination.writeFile(result.bytes); } finally { await destination.close(); }
    return { channelId: id.jid, messageId: message.id, timestamp, gifId: options.gif, attachment, variant,
      output: options.output, bytes: result.bytes.length, mime: 'image/gif', dimension: inspection.dimension, media: inspection.media,
      sha256: createHash('sha256').update(result.bytes).digest('hex'),
      verification: 'exact-message-linkage-size-and-dimensions; compare-sha256-with-independent-source' };
  }
  await privateAudience(chat, id, channel, options['expect-users']);
  const catalog = await chat.giphy('get', { id: options.gif }), asset = catalog.items[0], pc = asset.images.pcPicInfo;
  const attachment = { name: asset.title, attachmentId: asset.id, type: 'image/gif', size: pc.size,
    dimension: { width: pc.width, height: pc.height }, extra: { type: 'giphy', data: { images: asset.images, url: asset.url } } };
  const messageId = `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N`, userName = await chat.getDisplayName();
  const message = { id: messageId, sessionId: id.jid, userName, sessionName: channel.name,
    messageContent: { type: 'Page', style: {}, children: [{ type: 'Image', content: [{ data: { attachment } }], style: { width: pc.width } }] } };
  await privateAudience(chat, id, await writeChannelInfo(chat, id), options['expect-users']);
  const context = { operation: 'chat.gif-send', id: messageId, channelId: id.jid, gifId: asset.id, attachment };
  let accepted = false;
  try {
    const response = await chat.attachment('send-giphy', { message });
    accepted = true; context.timestamp = response.timestamp;
    if (response.id !== messageId || !Number.isSafeInteger(response.timestamp) || response.timestamp < 1) throw new AppError('WRITE_UNCONFIRMED', 'Native GIF acknowledgement did not identify this message.');
    for (let attempt = 0; attempt < 5; attempt++) {
      const readback = await exactMessage(chat, id, messageId, response.timestamp);
      if (readback?.from === chat.from.split('/')[0]
        && isDeepStrictEqual(readback.richText, message.messageContent)) {
        return { ...context, outcome: 'confirmed', acceptance: 'native-ack-and-exact-rich-message-readback',
          bytesVerified: false, message: readback };
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new AppError('READBACK_MISMATCH', 'The exact GIF variants and rich message were not observed in bounded readback.');
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' });
  }
}

async function fileAttachment(chat, action, options) {
  const id = channelId(options.channel, chat.channelSuffix);
  const channel = await (action === 'file-send' ? writeChannelInfo : readChannelInfo)(chat, id);
  if (channel.e2e !== '0') throw new AppError('UNSUPPORTED_ENCRYPTION', 'Encrypted attachments are not supported.');
  if (Number(channel.type) === 3) throw new AppError('UNSUPPORTED_GROUP_DIRECT', 'Group-DM attachment operations are not a verified channel operation.');
  const maxBytes = 1024 * 1024;
  if (action !== 'file-send') {
    const timestamp = integer(options.time, 'Message timestamp', 1);
    if (typeof options.message !== 'string' || !/^[A-Za-z0-9_-]+$/.test(options.message)) throw new AppError('INVALID_INPUT', 'Supply an exact message ID.');
    const message = await exactMessage(chat, id, options.message, timestamp);
    const attachments = messageAttachments(message);
    if (action === 'files') return { channel: summary(id.jid, channel), messageId: message?.id ?? null, timestamp, attachments, contentComplete: message?.contentComplete ?? false };
    const selected = attachments.find(item => item.fileId === options.file);
    if (!selected) throw new AppError('ATTACHMENT_NOT_FOUND', 'The exact message does not contain the requested file ID.');
    if (selected.extra?.type === 'giphy' || selected.extra?.isSticker) throw new AppError('UNSUPPORTED_MEDIA_KIND', 'Giphy and sticker assets require their distinct native contracts, not ordinary attachment downloads.');
    const metadata = await chat.attachment('info', { fileId: selected.fileId });
    if (metadata.result !== 0 || metadata.fileId !== selected.fileId || metadata.fileName !== selected.name
      || metadata.length !== selected.size || metadata.encryption !== 0 || metadata.open !== false || metadata.shareJid !== id.jid) {
      throw new AppError('ATTACHMENT_MISMATCH', 'Native file identity, encryption, private scope or message metadata did not match.');
    }
    if (action === 'file-info') return { messageId: message.id, attachment: selected, metadata };
    if (!Number.isSafeInteger(metadata.length) || metadata.length > maxBytes) throw new AppError('ATTACHMENT_TOO_LARGE', 'Downloads are limited to 1 MiB.');
    if (typeof options.output !== 'string' || !options.output) throw new AppError('INVALID_INPUT', 'Supply a new --output file.');
    const result = await chat.attachment('download', { fileId: selected.fileId, maxBytes });
    const bytes = result.bytes;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== metadata.length || (metadata.digest && metadata.digest !== sha256)) throw new AppError('ATTACHMENT_MISMATCH', 'Downloaded bytes do not match native size or digest.');
    const inspection = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(selected.mime) ? inspectAttachmentMedia(bytes, selected.mime) : null;
    if (inspection && selected.dimension && !isDeepStrictEqual(inspection.dimension, selected.dimension)) throw new AppError('ATTACHMENT_MISMATCH', 'Downloaded image dimensions do not match the linked native message.');
    const destination = await open(options.output, 'wx', 0o600);
    try { await destination.writeFile(bytes); } finally { await destination.close(); }
    return { messageId: message.id, attachment: selected, output: options.output, bytes: bytes.length, sha256, media: inspection?.media ?? null, verified: true };
  }
  await privateAudience(chat, id, channel, options['expect-users']);
  if (typeof options.input !== 'string' || !options.input) throw new AppError('INVALID_INPUT', 'Supply an --input file.');
  const file = await open(options.input, 'r');
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new AppError('INVALID_INPUT', 'Upload requires a nonempty regular file of at most 1 MiB.');
    bytes = await file.readFile();
  } finally { await file.close(); }
  if (!bytes.length || bytes.length > maxBytes) throw new AppError('INVALID_INPUT', 'Upload file size changed outside the supported range.');
  const name = basename(options.input);
  if (!xmlText(name)) throw new AppError('INVALID_INPUT', 'Filename contains unsupported characters.');
  const mime = options.mime ?? 'application/octet-stream';
  const { dimension, media } = inspectAttachmentMedia(bytes, mime);
  const messageId = `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N`;
  const context = { operation: 'chat.file-send', id: messageId, channelId: id.jid, fileName: name, bytes: bytes.length, mime, dimension, media };
  let submitted = false;
  try {
    const userName = await chat.getDisplayName();
    submitted = true;
    const uploaded = await chat.attachment('upload', { name, mime, bytes });
    context.fileId = uploaded.fileId;
    if (typeof uploaded.fileId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(uploaded.fileId)) throw new AppError('UPLOAD_UNCONFIRMED', 'Upload did not return a usable native file ID.');
    const attachment = { name, size: bytes.length, type: mime, attachmentId: uploaded.fileId, source: null, audio: null, border: null, shadow: null, dimension, crop: null, extra: {} };
    const block = { type: dimension ? 'Image' : 'Attachment', content: [{ data: { attachment } }],
      ...(dimension ? { style: { width: 128, aspectRatio: String(dimension.width / dimension.height) } } : {}) };
    const message = { id: messageId, sessionId: id.jid, userName, sessionName: channel.name, messageType: 17,
      messageContent: { type: 'Page', style: {}, children: [block] }, body: '', mentions: [], fontStyle: [], fileScope: '0', isSelf: false };
    const accepted = await chat.attachment('send', { sessionId: id.jid, ownerId: chat.from.split('/')[0], fileId: uploaded.fileId, message });
    context.timestamp = accepted.timestamp;
    if (accepted.id !== messageId || !Number.isSafeInteger(accepted.timestamp)) throw new AppError('WRITE_UNCONFIRMED', 'Native message acknowledgement did not match the attachment message.');
    for (let attempt = 0; attempt < 5; attempt++) {
      const readback = await exactMessage(chat, id, messageId, accepted.timestamp);
      if (messageAttachments(readback).some(item => item.fileId === uploaded.fileId && item.name === name && item.size === bytes.length
        && item.mime === mime && isDeepStrictEqual(item.dimension, dimension) && isDeepStrictEqual(item.extra, {}))) {
        return { ...context, outcome: 'confirmed', acceptance: 'native-ack-and-message-readback', sha256: createHash('sha256').update(bytes).digest('hex'), message: readback };
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new AppError('READBACK_MISMATCH', 'Attachment linkage was not observed in bounded exact message readback.');
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: 'unobserved' }, submitted ? 'unknown' : 'not_sent');
  }
}

async function customCatalog(chat, options = {}) {
  const limit = integer(options.limit ?? 100, 'Limit', 1);
  if (limit > 1000) throw new AppError('INVALID_INPUT', 'Custom emoji catalog limit must not exceed 1000.');
  const scope = [...cursorScope('chat custom-emojis', options), chat.from.split('/')[0], chat.identity.user.accountId];
  const position = options.cursor ? decodeCursor(options.cursor, scope) : null;
  const response = await chat.customEmoji('list', { limit, own: Boolean(options.own), searchAfter: position?.token });
  const seen = new Set(position?.seen), items = [], repeatedFileIds = [];
  for (const file of response.files) {
    const name = file.attribute?.businessCode ?? file.name;
    if (typeof file.fileId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(file.fileId)
      || typeof name !== 'string' || !/^[A-Za-z0-9_]{3,100}$/.test(name)) throw new AppError('UNSUPPORTED_CONTENT', 'Custom emoji catalog identity is unrecognized.');
    if (seen.has(file.fileId)) { repeatedFileIds.push(file.fileId); continue; }
    seen.add(file.fileId);
    items.push({ fileId: file.fileId, name, emojiId: `CE-${name}`, reactionKey: `v1:${Buffer.from(name).toString('base64')}:${file.fileId}`,
      extension: file.extName ?? null, creatorId: file.attribute?.userId ?? null, visibility: 'account-wide' });
  }
  const more = Boolean(response.searchAfter), advances = response.searchAfter !== position?.token && items.length > 0;
  const reason = repeatedFileIds.length ? 'REPEATED_CATALOG_FILE' : more && !advances ? 'NONADVANCING_NATIVE_CURSOR' : null;
  return { accountId: chat.identity.user.accountId, scope: options.own ? 'own-created-account-wide-custom-emojis' : 'account-wide-custom-emojis',
    items, nextCursor: more && advances && !reason ? encodeCursor(scope, { token: response.searchAfter, seen: [...seen] }) : null,
    pagination: { complete: !more && !reason, status: reason ? 'incomplete' : !more ? 'end' : 'more', snapshot: false,
      ...(reason ? { reason, repeatedFileIds } : {}) } };
}

async function completeCustomCatalog(chat, own = false) {
  const catalog = await customCatalog(chat, { own, limit: 1000 });
  if (!catalog.pagination.complete) throw new AppError('INCOMPLETE_CATALOG', 'This operation requires the complete current catalog within 1000 entries.');
  return catalog.items;
}

async function changeCustomEmoji(chat, action, options) {
  if (options['expect-account'] !== chat.identity.user.accountId) throw new AppError('TENANT_MISMATCH', 'Supply the exact --expect-account for this account-wide custom emoji change.');
  if (typeof options.name !== 'string' || !/^[A-Za-z0-9_]{3,100}$/.test(options.name)) throw new AppError('INVALID_INPUT', 'Emoji name requires 3–100 letters, digits, or underscores.');
  const deleting = action === 'emoji-delete', before = await completeCustomCatalog(chat, deleting);
  if (deleting && !before.some(item => item.fileId === options.file && item.name === options.name && item.creatorId === chat.identity.user.userId)) throw new AppError('FORBIDDEN', 'Delete requires an exact own-created custom emoji file ID and name.');
  if (!deleting && before.some(item => item.name === options.name)) throw new AppError('ALREADY_EXISTS', 'The custom emoji name already exists; nothing uploaded.');
  let bytes, fileName;
  if (!deleting) {
    if (typeof options.input !== 'string' || !options.input) throw new AppError('INVALID_INPUT', 'Supply a square PNG input file.');
    const file = await open(options.input, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 24 || stat.size > 256 * 1024) throw new AppError('INVALID_INPUT', 'Emoji requires a regular PNG file of at most 256 KiB.');
      bytes = await file.readFile();
    } finally { await file.close(); }
    if (bytes.length < 24 || bytes.length > 256 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      || !bytes.readUInt32BE(16) || bytes.readUInt32BE(16) !== bytes.readUInt32BE(20)) throw new AppError('INVALID_INPUT', 'Emoji requires a square PNG of at most 256 KiB.');
    fileName = `${options.name}.png`;
  }
  const context = { operation: `chat.${action}`, accountId: chat.identity.user.accountId, name: options.name,
    visibility: 'account-wide', ...(deleting ? { fileId: options.file } : { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) };
  let accepted = false;
  try {
    if (deleting) await chat.customEmoji('delete', { fileId: options.file });
    else {
      const uploaded = await chat.customEmoji('upload', { name: options.name, fileName, bytes });
      context.fileId = uploaded.fileId;
      if (typeof uploaded.fileId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(uploaded.fileId)) throw new AppError('UPLOAD_UNCONFIRMED', 'Custom emoji upload did not return a usable native file ID.');
    }
    accepted = true;
    for (let attempt = 0; attempt < 5; attempt++) {
      const own = await completeCustomCatalog(chat, true), all = await completeCustomCatalog(chat);
      const match = list => list.find(item => item.fileId === context.fileId && item.name === options.name);
      if (deleting ? !own.some(item => item.fileId === context.fileId) && !all.some(item => item.fileId === context.fileId) : match(own) && match(all)) {
        return { ...context, outcome: 'confirmed', acceptance: 'native-http-and-own-account-catalog-readback', emoji: deleting ? null : match(all) };
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new AppError('READBACK_MISMATCH', 'The custom emoji catalog transition was not observed; inspect its name and file ID before any retry.');
  } catch (error) { throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }); }
}

async function reactions(chat, id, message) {
  const response = await chat.request('/xms/emoji/listWithDisplayname', { body: { sessions: [{
    session: id.bare, type: 'groupchat', msg_timestamp: message.timestamp, msg_id: message.id,
  }] } });
  const rows = response.data;
  if (Array.isArray(response.data) && response.data.length === 0) return { messageId: message.id, timestamp: message.timestamp, channelId: id.jid, items: [], scope: 'native-exact-message-reactions', snapshot: false };
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].session !== id.jid
    || rows[0].msg_id !== message.id || rows[0].msg_timestamp !== message.timestamp
    || !rows[0].emojis || typeof rows[0].emojis !== 'object' || Array.isArray(rows[0].emojis)) {
    throw new AppError('REACTION_COVERAGE_UNKNOWN', 'Native reactions did not identify the exact requested message.');
  }
  const self = chat.from.split('/')[0];
  const items = Object.entries(rows[0].emojis).map(([key, users]) => {
    if (!Array.isArray(users) || users.some(user => typeof user.jid !== 'string')
      || new Set(users.map(user => user.jid)).size !== users.length) throw new AppError('UNSUPPORTED_CONTENT', 'Native reaction actors are malformed or duplicated.');
    const parts = key.startsWith('v1:') ? key.split(':') : null;
    const name = parts?.length === 3 ? Buffer.from(parts[1], 'base64').toString('utf8') : null;
    const customEmoji = name && /^[A-Za-z0-9_]{3,100}$/.test(name) && Buffer.from(name).toString('base64') === parts[1]
      && /^[A-Za-z0-9_-]+$/.test(parts[2]) ? { name, fileId: parts[2] } : null;
    return { key, emoji: key.startsWith('v1:') ? null : Buffer.from(key, 'base64').toString('utf8'), custom: key.startsWith('v1:'),
      ...(parts ? { customEmoji } : {}), count: users.length, self: users.some(user => user.jid === self), users };
  });
  return { messageId: message.id, timestamp: message.timestamp, channelId: id.jid, items, scope: 'native-exact-message-reactions', snapshot: false };
}

async function reaction(chat, action, options) {
  const id = channelId(options.channel, chat.channelSuffix);
  const channel = await (action === 'reactions' ? readChannelInfo : writeChannelInfo)(chat, id);
  if (channel.e2e !== '0') throw new AppError('UNSUPPORTED_ENCRYPTION', 'Encrypted message reactions are not supported.');
  if (Number(channel.type) === 3) throw new AppError('UNSUPPORTED_GROUP_DIRECT', 'Group-DM reactions are not a verified channel operation.');
  if (typeof options.message !== 'string' || !/^[A-Za-z0-9_-]+$/.test(options.message)) throw new AppError('INVALID_INPUT', 'Supply an exact message ID.');
  const message = await exactMessage(chat, id, options.message, integer(options.time, 'Message timestamp', 1));
  if (!message) throw new AppError('MESSAGE_NOT_FOUND', 'The exact reaction target was not found.');
  const before = await reactions(chat, id, message);
  if (action === 'reactions') return before;
  await privateAudience(chat, id, channel, options['expect-users']);
  const removing = action === 'unreact', custom = options['custom-emoji'] !== undefined;
  if (custom === (options.emoji !== undefined)) throw new AppError('INVALID_INPUT', 'Supply exactly one Unicode --emoji or --custom-emoji file ID.');
  let emoji, key;
  if (custom) {
    const entry = (await completeCustomCatalog(chat)).find(item => item.fileId === options['custom-emoji']);
    if (!entry) throw new AppError('NOT_FOUND', 'The exact custom emoji is not in this account catalog.');
    emoji = entry.name; key = entry.reactionKey;
  } else {
    emoji = options.emoji;
    if (!xmlText(emoji) || !emoji || emoji.length > 32 || !/\p{Extended_Pictographic}/u.test(emoji)) throw new AppError('INVALID_INPUT', 'Supply a Unicode emoji of at most 32 UTF-16 units.');
    key = Buffer.from(emoji).toString('base64');
  }
  const prior = before.items.find(item => item.key === key);
  if ((prior?.self ?? false) === !removing) throw new AppError(removing ? 'NO_SELF_REACTION' : 'ALREADY_REACTED', removing ? 'The authenticated actor has no such reaction to remove.' : 'The authenticated actor already has this reaction.');
  const requestId = `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N`, changeId = randomUUID();
  const context = { operation: `chat.${action}`, requestId, changeId, messageId: message.id, timestamp: message.timestamp, channelId: id.jid, emoji, ...(custom ? { customEmojiFileId: options['custom-emoji'] } : {}) };
  const threadId = message.replyTo?.id ?? message.id, threadTime = message.replyTo?.thread ?? message.timestamp;
  const stanza = `<iq id="${xml(requestId)}" from="${xml(chat.from)}" type="set" xmlns="jabber:client"><query xmlns="zoom:iq:emoji"><emoji session="${xml(id.bare)}" type="groupchat" msg_t="${message.timestamp}" id="${xml(key)}" action="${removing ? 'remove' : 'add'}" msgId="${xml(message.id)}" msg_owner="${xml(message.from)}" msg_type="${xml(message.messageType)}" thread_id="${xml(threadId)}" thread_t="${xml(threadTime)}" cid="${xml(changeId)}" custom="${custom}"/></query></iq>`;
  let accepted = false;
  try {
    await chat.sendIq(stanza, requestId);
    accepted = true;
    for (let attempt = 0; attempt < 5; attempt++) {
      const after = await reactions(chat, id, message), current = after.items.find(item => item.key === key);
      const self = chat.from.split('/')[0], previousOthers = (prior?.users ?? []).filter(user => user.jid !== self).map(user => user.jid).sort();
      const currentOthers = (current?.users ?? []).filter(user => user.jid !== self).map(user => user.jid).sort();
      if ((current?.self ?? false) === !removing && isDeepStrictEqual(previousOthers, currentOthers)) {
        return { ...context, outcome: 'confirmed', acceptance: 'native-iq-and-actor-readback', reactions: after, otherActorsPreserved: true };
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new AppError('READBACK_MISMATCH', 'The self reaction change with unchanged other actors was not observed.');
  } catch (error) { throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }); }
}

async function changeOwnMessage(chat, action, options) {
  const id = channelId(options.channel, chat.channelSuffix), channel = await writeChannelInfo(chat, id);
  await privateAudience(chat, id, channel, options['expect-users']);
  if (typeof options.message !== 'string' || !/^[A-Za-z0-9_-]+$/.test(options.message)) throw new AppError('INVALID_INPUT', 'Supply an exact message ID.');
  const message = await exactMessage(chat, id, options.message, integer(options.time, 'Message timestamp', 1));
  const self = chat.from.split('/')[0], deleting = action === 'delete';
  if (!message || message.deleted || message.from !== self) throw new AppError('FORBIDDEN', 'Only an existing own message can be edited or deleted.');
  if (!message.contentComplete || !['0', '17'].includes(message.messageType)) throw new AppError('UNSUPPORTED_CONTENT', 'Only supported text messages can be edited or deleted through this command.');
  if (typeof options['if-text'] !== 'string' || message.text !== options['if-text']) throw new AppError('MESSAGE_CHANGED', 'Current body must match --if-text exactly; nothing sent.');
  if (!deleting && (!xmlText(options.text) || !options.text.trim())) throw new AppError('INVALID_INPUT', 'Supply nonempty replacement text.');
  const replies = deleting && !message.replyTo ? await thread(chat, id, message.timestamp, 100) : null;
  if (replies && (!Number.isSafeInteger(replies.total) || replies.total > 100 || replies.messages.length !== replies.total)) throw new AppError('INCOMPLETE_THREAD', 'Root deletion requires a complete visible thread of at most 100 replies.');
  const requestId = `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N`, name = await chat.getDisplayName();
  const threadId = message.replyTo?.id ?? message.id, threadTime = message.replyTo?.thread ?? message.timestamp;
  const context = { operation: `chat.${action}`, requestId, messageId: message.id, timestamp: message.timestamp, channelId: id.jid, threadId, threadTime };
  const replyXml = message.replyTo ? `<reply msg_id="${xml(message.replyTo.id)}" owner="${xml(message.replyTo.owner)}" thread_t="${xml(message.replyTo.thread)}"/>` : '';
  const page = { type: 'Page', style: {}, children: [{ type: 'Paragraph', content: [{ data: options.text }] }] };
  const resource = chat.from.slice(chat.from.indexOf('/') + 1);
  const stanza = deleting
    ? `<message from="${xml(chat.from)}" id="${xml(requestId)}" to="${xml(id.jid)}" type="groupchat" xmlns="jabber:client"><zmext><msg_type>80</msg_type><from n="${xml(name)}" res="${xml(resource)}"/><to/><visible>false</visible></zmext><revoke has_comment="${replies?.total ? 1 : 0}" id="${xml(message.id)}" t="${message.timestamp}" thread="${xml(threadId)}" thread_t="${xml(threadTime)}"/><zmtask feature="3"/></message>`
    : `<message from="${xml(chat.from)}" to="${xml(id.jid)}" id="${xml(requestId)}" type="groupchat" xmlns="jabber:client"><zmedit id="${xml(message.id)}" t="${message.timestamp}"><message from="${xml(self)}" to="${xml(id.jid)}" id="${xml(message.id)}" type="groupchat" xmlns="jabber:client"><zmrt>${xml(JSON.stringify(page))}</zmrt><zmext t="${message.timestamp}"><msg_type>17</msg_type><from n="${xml(name)}" res="${xml(resource)}"/><to/><visible>true</visible><msg_feature>32768</msg_feature>${replyXml}<obj f="18" st="0" fs="0"/></zmext><body>${xml(options.text)}</body></message></zmedit><zmext><msg_type>204</msg_type><from/><to/><visible>false</visible></zmext><zmtask feature="3" type="medit" xmlns="zoom:imcmd"/></message>`;
  let accepted = false;
  try {
    const acknowledgement = await chat.sendIq(stanza, requestId);
    if (!acknowledgement.echo?.timestamp) throw new AppError('WRITE_UNCONFIRMED', 'No native message operation echo was returned.');
    accepted = true;
    for (let attempt = 0; attempt < 5; attempt++) {
      const after = await exactMessage(chat, id, message.id, message.timestamp);
      if (deleting ? !after || after.deleted?.deleter === self.split('@')[0] : after?.text === options.text && isDeepStrictEqual(after.replyTo, message.replyTo)) {
        const retained = replies?.total ? await thread(chat, id, message.timestamp, 100) : null;
        if (retained && (!retained.parent.deleted || retained.total !== replies.total
          || replies.messages.some(old => !retained.messages.some(current => current.id === old.id && current.text === old.text && isDeepStrictEqual(current.replyTo, old.replyTo))))) {
          throw new AppError('THREAD_CHANGED', 'Root deletion did not preserve the observed reply set; inspect the thread.');
        }
        return { ...context, outcome: 'confirmed', acceptance: 'native-echo-and-readback', message: after,
          ...(deleting ? { deletion: after?.deleted ? 'native-tombstone' : 'accepted-and-absent', absenceAloneProvesDeletion: false,
            retainedReplyIds: retained?.messages.map(item => item.id) ?? [] } : { previousText: message.text }) };
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new AppError('READBACK_MISMATCH', 'The own-message mutation was not observed in bounded exact readback.');
  } catch (error) { throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }); }
}

async function topPin(chat, id) {
  const response = await chat.request('/xms/pin/top', { body: [{ sessionId: id.jid }] });
  if (!Array.isArray(response.data) || response.data.length > 1
    || response.data.some(row => row.sessionId !== id.jid)) throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned an unrecognized shared-pin response.');
  return response.data[0]?.msg_id ? response.data[0] : null;
}

async function sharedPins(chat, action, options) {
  const id = channelId(options.channel, chat.channelSuffix);
  const channel = await (action === 'pins' ? readChannelInfo : writeChannelInfo)(chat, id);
  if (Number(channel.type) !== 2 || channel.e2e !== '0') throw new AppError('FORBIDDEN', 'Shared pins require a private unencrypted channel.');
  const current = await topPin(chat, id);
  if (action === 'pins') {
    const limit = integer(options.limit ?? 50, 'Limit', 1);
    if (limit > 100) throw new AppError('INVALID_INPUT', 'Pin history limit must not exceed 100.');
    const scope = [...cursorScope('chat pins', options), chat.from.split('/')[0], chat.identity.user.accountId];
    const position = options.cursor ? decodeCursor(options.cursor, scope) : null;
    const response = await chat.request('/xms/pin/list', { body: { sessionId: id.jid, limit, timeframe: '0:', scanForward: false,
      ...(position ? { lastValue: position.before } : {}) } });
    if (!Array.isArray(response.data) || typeof response.haveMore !== 'boolean') throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned unrecognized pin history.');
    const items = [];
    for (const row of response.data) {
      if (row.sessionId !== id.jid || !Number.isSafeInteger(row.timestamp) || typeof row.msg_id !== 'string') throw new AppError('UNSUPPORTED_CONTENT', 'Pin history identity is invalid.');
      const message = typeof row.msg === 'string' ? (await chat.parseMessages([{ msg_id: row.msg_id, timestamp: row.timestamp, message: row.msg }]))[0] : null;
      items.push({ messageId: row.msg_id, timestamp: row.timestamp, threadId: row.thread, threadTime: row.thread_t,
        state: row.type === 2 ? 'pinned' : row.type === 1 ? 'unpinned' : 'unsupported', nativeType: row.type,
        pinner: row.pinner, pinTimestamp: row.pin_t, current: current?.msg_id === row.msg_id, message });
    }
    const advances = Number.isSafeInteger(response.lastValue) && response.lastValue > 0 && response.lastValue !== position?.before;
    return { channelId: id.jid, current: current ? { messageId: current.msg_id, timestamp: current.timestamp,
      pinner: current.pinner, pinTimestamp: current.pin_t, version: current.version } : null, items,
      scope: 'shared-top-pin-and-native-pin-history-not-personal-bookmarks',
      nextCursor: response.haveMore && advances ? encodeCursor(scope, { before: response.lastValue }) : null,
      pagination: { complete: !response.haveMore, status: !response.haveMore ? 'end' : advances ? 'more' : 'incomplete', snapshot: false } };
  }
  await privateAudience(chat, id, channel, options['expect-users']);
  if (typeof options.message !== 'string' || !/^[A-Za-z0-9_-]+$/.test(options.message)) throw new AppError('INVALID_INPUT', 'Supply an exact message ID.');
  const message = await exactMessage(chat, id, options.message, integer(options.time, 'Message timestamp', 1));
  if (!message || message.deleted) throw new AppError('NOT_FOUND', 'Only an existing visible message can be pinned or unpinned.');
  const unpin = action === 'unpin';
  if (unpin ? current?.msg_id !== message.id || current.timestamp !== message.timestamp : current !== null) {
    throw new AppError('PIN_CHANGED', unpin ? 'The exact target is not the current shared pin; nothing sent.' : 'A shared pin already exists. Explicitly unpin that exact message before pinning another.');
  }
  const requestId = `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N`;
  const context = { operation: `chat.${action}`, requestId, channelId: id.jid, messageId: message.id, timestamp: message.timestamp };
  const item = unpin ? `<item t="${message.timestamp}"/>`
    : `<item msgid="${xml(message.id)}" t="${message.timestamp}" thread="${xml(message.replyTo?.id ?? message.id)}" thread_t="${xml(message.replyTo?.thread ?? message.timestamp)}"/>`;
  let accepted = false;
  try {
    await chat.sendIq(`<iq from="${xml(chat.from)}" to="${xml(id.jid)}" id="${xml(requestId)}" type="set" xmlns="jabber:client"><pin action="${action}" xmlns="zoom:iq:pin">${item}</pin></iq>`, requestId);
    accepted = true;
    for (let attempt = 0; attempt < 5; attempt++) {
      const after = await topPin(chat, id);
      if (unpin ? after === null : after?.msg_id === message.id && after.timestamp === message.timestamp && after.type === 2) {
        return { ...context, outcome: 'confirmed', acceptance: 'native-iq-and-shared-pin-readback', shared: true,
          current: after ? { messageId: after.msg_id, timestamp: after.timestamp, pinner: after.pinner, pinTimestamp: after.pin_t } : null };
      }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new AppError('READBACK_MISMATCH', 'The shared-pin transition was not observed. Inspect the exact target before any retry.');
  } catch (error) { throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }); }
}

const CHAT_UNAVAILABLE_CAPABILITIES = {
  drafts: [
    'The exact zak-authenticated native request is provider-rejected for the verified account; a local/browser draft index is not a safe substitute.',
    { request: { path: '/xms/drafts/fetch/userid', userId: 'actor-user-id-without-jid-domain', limit: 100 },
      providerResult: 9, phase: 'native-service', coverage: 'unavailable', readMutation: false },
  ],
};
export function chatCapabilities() {
  const implemented = {
    organization: ['folders', 'folder-create', 'folder-rename', 'folder-delete', 'folder-add', 'folder-remove', 'folder-move', 'starred', 'star', 'unstar'],
    mentionGroups: ['mention-groups', 'mention-group-create', 'mention-group-update', 'mention-group-delete', 'mention-group-send'],
    privateChats: ['private-chat-info', 'dm-inbox', 'dm-read', 'dm-send', 'group-find', 'group-info', 'group-read', 'group-send'],
    sharedSpaces: ['shared-spaces', 'shared-space-channels', 'shared-space-members', 'shared-space-create', 'shared-space-rename', 'shared-space-delete', 'shared-space-add-member', 'shared-space-remove-member', 'shared-space-add-channel', 'shared-space-remove-channel'],
    channels: ['list', 'find', 'info', 'inspect', 'create-channel', 'read', 'send', 'channel-delete', 'channel-leave', 'channel-admin', 'channel-permission', 'channel-transfer-owner', 'channel-rename', 'group-rename'],
    members: ['members', 'add-member', 'remove-member'],
    permissions: ['permissions', 'channel-permission', 'channel-admin', 'channel-transfer-owner'],
    notifications: ['notifications', 'notifications-set', 'notification-settings', 'notification-set'],
    sharedPins: ['pins', 'pin', 'unpin'],
    messageControls: ['reactions', 'react', 'unreact', 'edit', 'delete', 'thread', 'reply'],
    media: ['files', 'file-info', 'file-download', 'file-send', 'gif-search', 'gif-send', 'gif-download', 'custom-emojis', 'emoji-create', 'emoji-delete'],
    unreadObservation: ['mentions', 'dm-inbox', 'new-messages'],
    readState: ['mark-read', 'mark-unread', 'read-watermark'],
    reminders: ['reminders', 'reminder-set', 'reminder-edit', 'reminder-close'],
    drafts: ['draft-create', 'draft-edit', 'draft-delete'],
    scheduledSends: ['schedule-create', 'schedule-edit', 'schedule-delete'],
    presence: ['status-message', 'presence', 'presence-set', 'available', 'away', 'busy', 'out-of-office', 'ooo'],
  };
  const unsupported = Object.fromEntries(Object.entries(CHAT_UNAVAILABLE_CAPABILITIES).map(([action, [reason, evidence]]) =>
    [action, { disposition: 'unsupported', reason, evidence, fallback: false, sent: false }]));
  return {
    operation: 'chat.capabilities',
    provenance: { basis: 'repository-native-transport-and-sanitized-observation', capturedSecrets: false, accountIdentifiers: false },
    safety: { mutationPreflight: true, automaticWriteReplay: false, broadFallback: false, browserFallback: false },
    capabilities: {
      ...Object.fromEntries(Object.entries(implemented).map(([name, commands]) => [name, {
        disposition: 'implemented', commands,
        ...(name === 'organization' ? { starredContract: {
          source: '/xms/login/star/list', envelope: 'result-zero-data-array', recordsBound: 1000,
          sessionVariants: ['actor-peer', 'peer-actor', 'self-pair', 'repeated-peer', 'channel-local-id', 'channel-jid'],
          ordering: { field: 'i-or-absent', absentMeaning: 'native-response-order-only', direction: 'unknown', responseOrderPreserved: true },
          pagination: { complete: 'unknown', continuation: 'none', snapshot: false }, unknownFields: 'names-only',
        } } : {}),
      }])),
      unsupported,
    },
  };
}


async function notificationSettings(chat, action, options) {
  const id = channelId(options.chat, chat.channelSuffix);
  await (action === 'notifications' ? readChannelInfo : writeChannelInfo)(chat, id);
  const read = async () => {
    const requestId = `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N`;
    const response = await chat.sendIq(`<iq from="${xml(chat.from)}" id="${xml(requestId)}" type="get" xmlns="jabber:client"><query xmlns="zoom:iq:notify"><mucnotify xmlns="zoom:notify:mucnotify"/></query></iq>`, requestId);
    if (!Array.isArray(response.notifies)) throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned an unrecognized notification-setting response.');

    const seen = new Set(), items = [];
    for (const item of response.notifies) {
      if (typeof item?.jid !== 'string' || !/^[^@\s/]+@[^@\s/]+$/.test(item.jid)
        || !['all', 'mention', 'off'].includes(item.type) || seen.has(item.jid)) {
        throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned an invalid or repeated notification setting.');
      }
      seen.add(item.jid); items.push({ chatId: item.jid, state: item.type });
    }
    return items;

  };
  const beforeItems = await read(), previous = beforeItems.find(item => item.chatId === id.jid)?.state ?? null;
  if (action === 'notifications') {
    return { operation: 'chat.notifications', chatId: id.jid, state: previous, configured: previous !== null,
      items: beforeItems, pagination: { complete: true, status: 'end', nativeContinuation: false, snapshot: false } };
  }
  if (!['all', 'mention', 'off'].includes(options.state)) throw new AppError('INVALID_INPUT', 'Notification state must be all, mention or off.');
  if (previous === options.state) throw new AppError('ALREADY_SET', 'The exact per-chat notification setting is already active; nothing sent.');
  const requestId = `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N`;
  const context = { operation: 'chat.notifications-set', requestId, chatId: id.jid, previous, requested: options.state };
  let accepted = false;
  try {
    await chat.sendIq(`<iq from="${xml(chat.from)}" id="${xml(requestId)}" to="${xml(chat.from.split('/')[0])}" type="set" xmlns="jabber:client"><query sync="true" xmlns="zoom:iq:notify"><mucnotify storage="${previous === null ? 'add' : 'update'}" xmlns="zoom:notify:mucnotify"><item type="${options.state}" v="${xml(id.jid)}"/></mucnotify></query></iq>`, requestId);
    accepted = true;
    const afterItems = await read(), current = afterItems.find(item => item.chatId === id.jid)?.state ?? null;
    const otherBefore = beforeItems.filter(item => item.chatId !== id.jid), otherAfter = afterItems.filter(item => item.chatId !== id.jid);
    if (current !== options.state || !isDeepStrictEqual(otherAfter, otherBefore)) {
      throw new AppError('READBACK_MISMATCH', 'The exact notification transition with unchanged other settings was not observed.');
    }
    return { ...context, outcome: 'confirmed', acceptance: 'native-iq-and-independent-settings-readback',
      state: current, otherSettingsPreserved: true };
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' });
  }
}
async function changeDraft(chat, action, options) {
  const id = channelId(options.chat, chat.channelSuffix), channel = await writeChannelInfo(chat, id);
  if (![1, 2].includes(Number(channel.type)) || channel.e2e !== '0') throw new AppError('UNSUPPORTED_CONVERSATION_TYPE', 'Drafts require an ordinary unencrypted channel.');
  const creating = action === 'draft-create', deleting = action === 'draft-delete';
  const draftId = creating ? randomUUID() : options.draft;
  if (typeof draftId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(draftId)) throw new AppError('INVALID_INPUT', 'Supply an exact native draft ID.');
  const requestId = `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N`, createdAt = Date.now();
  let messageId = null, item;
  if (deleting) {
    item = `<item id="${xml(draftId)}" session="${xml(id.jid)}"/>`;
  } else {
    const encoded = await encodeTextMessage(chat, id, channel, options.text);
    messageId = encoded.messageId;
    item = `<item id="${xml(draftId)}" type="0"${creating ? ` create_t="${createdAt}"` : ''} send_t="0">${encoded.stanza}</item>`;
  }
  const nativeAction = creating ? 'create' : deleting ? 'delete' : 'update';
  const context = { operation: `chat.${action}`, requestId, draftId, chatId: id.jid, messageId, nativeAction };
  let accepted = false;
  try {
    const response = await chat.sendIq(`<iq id="${xml(requestId)}" type="set" from="${xml(chat.from)}" xmlns="jabber:client"><query xmlns="zoom:iq:draft" action="${nativeAction}">${item}</query></iq>`, requestId);
    const acknowledgement = response.draft;
    if (!acknowledgement || acknowledgement.action !== nativeAction || typeof acknowledgement.version !== 'string' || !acknowledgement.version) {
      throw new AppError('WRITE_UNCONFIRMED', 'Draft acknowledgement did not contain the correlated action and server version.');
    }
    if (creating && (acknowledgement.item?.id !== draftId || acknowledgement.item.type !== '0'
      || Number(acknowledgement.item.createdAt) !== createdAt || acknowledgement.item.sendAt !== '0'
      || !Number.isSafeInteger(Number(acknowledgement.item.modifiedAt)) || Number(acknowledgement.item.modifiedAt) < createdAt)) {
      throw new AppError('WRITE_UNCONFIRMED', 'Draft creation acknowledgement did not confirm the exact draft identity and timestamps.');
    }
    if (!creating && !deleting && acknowledgement.item && acknowledgement.item.id !== draftId) {
      throw new AppError('WRITE_UNCONFIRMED', 'Draft update acknowledgement referred to another draft.');
    }
    accepted = true;
    return { ...context, outcome: 'confirmed', acceptance: 'correlated-native-iq-and-server-draft-version',
      draftVersion: acknowledgement.version, item: acknowledgement.item, contentReadbackAvailable: false,
      reconciliation: 'next native draft synchronization; do not replay this operation automatically' };
  } catch (error) { throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }); }
}
async function changeConversationReadState(chat, action, options) {
  const id = channelId(options.chat, chat.channelSuffix);
  const channel = await writeChannelInfo(chat, id);
  if (![1, 2].includes(Number(channel.type))) throw new AppError('UNSUPPORTED_CONVERSATION_TYPE', 'Read-state controls require an ordinary channel.');
  const marksBefore = await manualUnreadMarks(chat), marked = marksBefore.get(id.jid) ?? [];
  const offlineBefore = await chat.unreadIndex();
  const unread = offlineBefore.sessions.find(item => item.id === id.jid) ?? null;
  const requestId = `${randomUUID()}-W_${randomBytes(4).toString('hex')}-N`;
  if (action === 'mark-unread') {
    const latest = await history(chat, id, 1);
    const message = latest.messages[0];
    if (!message || message.replyTo || !Number.isSafeInteger(message.timestamp)) throw new AppError('NOT_FOUND', 'No latest root message is available to mark unread.');
    if (marked.includes(message.timestamp)) throw new AppError('ALREADY_UNREAD', 'The latest root message is already manually marked unread; nothing sent.');
    const context = { operation: 'chat.mark-unread', requestId, chatId: id.jid, timestamp: message.timestamp, messageId: message.id };
    let accepted = false;
    try {
      await chat.sendIq(`<iq from="${xml(chat.from)}" id="${xml(requestId)}" type="set" xmlns="jabber:client"><query action="mark" xmlns="zoom:iq:mark"><session id="${xml(id.jid)}" timeframe="${message.timestamp}" type="groupchat"/></query></iq>`, requestId);
      accepted = true;
      const marksAfter = await manualUnreadMarks(chat), current = marksAfter.get(id.jid) ?? [];
      if (!current.includes(message.timestamp) || marked.some(timestamp => !current.includes(timestamp))) {
        throw new AppError('READBACK_MISMATCH', 'The exact manually-unread timestamp was not observed without losing prior marks.');
      }
      return { ...context, outcome: 'confirmed', acceptance: 'native-iq-and-marked-index-readback',
        timestamps: current, priorMarksPreserved: true };
    } catch (error) { throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }); }
  }
  if (marked.length && unread?.unreadCount > 0) throw new AppError('READ_STATE_AMBIGUOUS', 'Manual and incoming unread state coexist; one write cannot safely clear both.');
  if (!marked.length && !(unread?.unreadCount > 0)) throw new AppError('ALREADY_READ', 'No native unread state is present; nothing sent.');
  const context = { operation: 'chat.mark-read', requestId, chatId: id.jid,
    source: marked.length ? 'manual-mark' : 'native-unread', timestamps: marked.length ? marked : [unread.lastUnreadTime] };
  let accepted = false;
  try {
    if (marked.length) {
      const sessions = marked.map(timestamp => `<session id="${xml(id.jid)}" timeframe="${timestamp}" type="groupchat"/>`).join('');
      await chat.sendIq(`<iq from="${xml(chat.from)}" id="${xml(requestId)}" type="set" xmlns="jabber:client"><query action="unmark" xmlns="zoom:iq:mark">${sessions}</query></iq>`, requestId);
    } else {
      await chat.sendIq(`<iq from="${xml(chat.from)}" id="${xml(requestId)}" type="get" xmlns="jabber:client"><zoom xmlns="zoom:iq:read" from="${xml(id.bare)}" group="1" is_cmc="0" action="reset" count="${unread.unreadCount}"><item time="${unread.lastUnreadTime}"/></zoom></iq>`, requestId);
    }
    accepted = true;
    if (marked.length) {
      const after = await manualUnreadMarks(chat);
      if ((after.get(id.jid) ?? []).some(timestamp => marked.includes(timestamp))) throw new AppError('READBACK_MISMATCH', 'Manual unread timestamps remain after acknowledgement.');
    } else {
      let cleared = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const after = await chat.unreadIndex(), current = after.sessions.find(item => item.id === id.jid);
        if (!current || current.unreadCount === 0) { cleared = true; break; }
        if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (!cleared) throw new AppError('READBACK_MISMATCH', 'The native unread index did not confirm the reset.');
    }
    return { ...context, outcome: 'confirmed', acceptance: marked.length ? 'native-iq-and-marked-index-readback' : 'native-iq-and-offline-index-readback' };
  } catch (error) { throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }); }
}

async function channelPermissions(chat, options) {
  const id = channelId(options.chat, chat.channelSuffix);
  const channel = await readChannelInfo(chat, id);
  const roster = await members(chat, id, channel, 1000);
  const actor = chat.from.split('/')[0];
  const actorMember = roster.items.find(item => item.jid === actor) ?? null;
  return {
    operation: 'chat.permissions',
    channel: summary(id.jid, channel),
    actor: { jid: actor, metadataRole: channel.role ?? null, rosterRole: actorMember?.role ?? null,
      isOwner: channel.owner === chat.identity?.user?.userId },
    members: roster.items,
    coverage: {
      metadata: 'complete-for-returned-channel-info',
      roster: roster.pagination.complete ? 'complete-for-observed-unsaturated-roster' : 'incomplete',
      effectivePermissions: 'unknown',
      roleSemantics: 'opaque-native-values',
      permissionAbsenceProvesDenied: false,
    },
    pagination: roster.pagination,
  };
}


async function personalControlTarget(chat, options, accessMode = 'write') {
  if (options.session !== undefined) {
    if (typeof options.session !== 'string' || !/^[A-Za-z0-9_-]+@(?:conference\.)?[^@/]+$/.test(options.session)) {
      throw new AppError('INVALID_INPUT', 'Session must be a full native Chat JID.');
    }
    return options.session;
  }
  const channelTarget = options.channel ?? options.chat;
  if ([channelTarget, options.group, options.email].filter(value => value !== undefined).length !== 1) {
    throw new AppError('INVALID_INPUT', 'Select exactly one channel, group or email for this personal control.');
  }
  if (options.email !== undefined) {
    const peer = await resolveContact(chat, options.email);
    if (peer.jid !== options['expect-user']) throw new AppError('AUDIENCE_MISMATCH', 'The resolved peer must match --expect-user exactly.');
    return peer.jid;
  }
  const id = channelId(options.group ?? channelTarget, chat.channelSuffix);
  const metadata = await (accessMode === 'read' ? readChannelInfo : writeChannelInfo)(chat, id);
  if (options.group !== undefined) await groupAudience(chat, id, metadata, groupUsers(chat, options['expect-users']));
  else await privateAudience(chat, id, metadata, options['expect-users']);
  return id.jid;
}
async function renameConversation(chat, action, options) {
  const groupDirect = action === 'group-rename';
  if (!xmlText(options.name) || !options.name.trim() || !xmlText(options['if-name'])) {
    throw new AppError('INVALID_INPUT', 'Supply a non-empty name and exact --if-name.');
  }
  const id = channelId(groupDirect ? options.group : options.channel, chat.channelSuffix);
  const before = await writeChannelInfo(chat, id);
  const audience = groupDirect
    ? await groupAudience(chat, id, before, groupUsers(chat, options['expect-users']))
    : await privateAudience(chat, id, before, options['expect-users']);
  if (!groupDirect && before.owner !== chat.identity.user.userId.toLowerCase()) {
    throw new AppError('FORBIDDEN', 'Channel naming requires the verified private-channel owner.');
  }
  if (before.name !== options['if-name']) throw new AppError('CONVERSATION_CHANGED', 'The current name does not match --if-name. Nothing sent.');
  if (before.name === options.name) return { channel: summary(id.jid, before), audience, outcome: 'unchanged', verified: true };
  const requestId = randomUUID();
  const context = { operation: `chat.${action}`, requestId, channelId: id.jid };
  let accepted = false;
  try {
    await chat.sendIq(`<iq from="${xml(chat.from)}" id="${xml(requestId)}" to="${xml(id.jid)}" type="set" xmlns="jabber:client"><zoom action="subject" xmlns="zoom:iq:room"><subject${groupDirect ? ' no_topic="0"' : ''}>${xml(options.name)}</subject></zoom></iq>`, requestId);
    accepted = true;
    const after = await writeChannelInfo(chat, id);
    if (after.name !== options.name) throw new AppError('READBACK_MISMATCH', 'The requested name was not observed. Reconcile before retrying.');
    return { ...context, channel: summary(id.jid, after), audience, outcome: 'confirmed',
      acceptance: 'native-iq-and-metadata-readback', verified: true, concurrency: 'non-atomic-name-precondition' };
  } catch (error) { throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }); }
}
async function runChatAction(session, action, options = {}) {
  if (CHAT_UNAVAILABLE_CAPABILITIES[action]) {
    const [reason, evidence] = CHAT_UNAVAILABLE_CAPABILITIES[action];
    throw new AppError('UNSUPPORTED_CAPABILITY', reason, {
      operation: `chat.${action}`, phase: evidence.phase, outcome: 'not_sent',
      fallback: false, sent: false, evidence,
    });
  }
  if (['draft-create', 'draft-edit', 'draft-delete'].includes(action) && options.chat !== undefined) {
    return changeDraft(await session.openChat(), action, options);
  }
  if (['mark-read', 'mark-unread'].includes(action) && options.chat !== undefined && options.timestamp === undefined) {
    return changeConversationReadState(await session.openChat(), action, options);
  }
  if (organizationActions.has(action)) {
    const chat = await session.openChat();
    return runOrganization(chat, action, options, () => personalControlTarget(chat, options));
  }
  if (nativeControlActions.has(action)) {
    const chat = await session.openChat();
    return runNativeControl(chat, action, options, {
      channelId, readChannelInfo, writeChannelInfo, members,
      target: (targetOptions, accessMode) => personalControlTarget(chat, targetOptions, accessMode),
    });
  }
  if (action === 'notification-settings' || action === 'notification-set') {
    const chat = await session.openChat();
    return runNotificationSettings(chat, action, options,
      await personalControlTarget(chat, options, action === 'notification-settings' ? 'read' : 'write'));
  }
  if (action === 'channel-rename' || action === 'group-rename') return renameConversation(await session.openChat(), action, options);
  if (action === 'new-messages') return checkNewMessages(await session.openChat(), options);
  if (action === 'capabilities') return chatCapabilities();
  if (action === 'permissions') return channelPermissions(await session.openChat(), options);
  if (action === 'notifications' || action === 'notifications-set') return notificationSettings(await session.openChat(), action, options);
  if (action === 'mark-read' || action === 'mark-unread') return changeConversationReadState(await session.openChat(), action, options);
  if (action === 'sticker-info') return inspectSticker(await session.openChat(), options);
  if (!['gif-search', 'gif-send', 'gif-download', 'dm-inbox', 'mentions', 'mention-groups', 'mention-group-create', 'mention-group-update', 'mention-group-create', 'mention-group-update', 'mention-group-delete', 'mention-group-send', 'group-create', 'group-find', 'group-info', 'group-read', 'group-send', 'group-message', 'custom-emojis', 'emoji-create', 'emoji-delete', 'pins', 'pin', 'unpin', 'edit', 'delete', 'reactions', 'react', 'unreact', 'files', 'file-info', 'file-download', 'file-send', 'list', 'find', 'search', 'info', 'inspect', 'members', 'permissions', 'notifications', 'notifications-set', 'mark-read', 'mark-unread', 'draft-create', 'draft-edit', 'draft-delete', 'folders', 'shared-spaces', 'resolve', 'user', 'users', 'cards', 'dm-read', 'dm-send', 'add-member', 'remove-member', 'read', 'conversation', 'message', 'send', 'thread', 'reply', 'create-channel', 'reconcile'].includes(action)) throw new AppError('INVALID_INPUT', 'Unsupported Chat action. Use --help.');
  if (action.startsWith('mention-group')) return channelMentionGroups(await session.openChat(), action, options);
  if (action.startsWith('group-')) return groupDirect(await session.openChat(), action, options);
  if (['files', 'file-info', 'file-download', 'file-send'].includes(action)) return fileAttachment(await session.openChat(), action, options);
  if (['gif-search', 'gif-send', 'gif-download'].includes(action)) return giphyMedia(await session.openChat(), action, options);
  if (['reactions', 'react', 'unreact'].includes(action)) return reaction(await session.openChat(), action, options);
  if (['edit', 'delete'].includes(action)) return changeOwnMessage(await session.openChat(), action, options);
  if (['pins', 'pin', 'unpin'].includes(action)) return sharedPins(await session.openChat(), action, options);
  if (action === 'custom-emojis') return customCatalog(await session.openChat(), options);
  if (['emoji-create', 'emoji-delete'].includes(action)) return changeCustomEmoji(await session.openChat(), action, options);
  const messageLink = action === 'message' ? options.messageLink ?? parseMessageLink(options.link) : null;
  const chat = await session.openChat();
  if (messageLink?.direct) return linkedDirect(chat, messageLink);
  if (action === 'create-channel') return createChannel(chat, options);
  if (action === 'user') return { user: await resolveContact(chat, options.email) };
  if (action === 'users') return searchUsers(chat, options.query);
  if (action === 'cards') {
    const inputs = typeof options.users === 'string' ? options.users.split(',') : [];
    if (!inputs.length || inputs.length > 100 || inputs.some(input => !/^[A-Za-z0-9_-]{1,128}(?:@[A-Za-z0-9.-]+)?$/.test(input))) {
      throw new AppError('INVALID_INPUT', 'Supply 1–100 comma-separated user IDs or user JIDs.');
    }
    return readUserCards(chat, inputs);
  }
  if (action === 'dm-read') return readDirect(chat, options);
  if (action === 'dm-send') return sendDirect(chat, options);
  if (action === 'add-member' || action === 'remove-member') return changeMember(chat, options, action === 'remove-member');
  if (action === 'find') return findChannels(chat, options);
  if (action === 'resolve') return resolveChannel(chat, options.query);
  if (action === 'search') return searchMessages(chat, options);
  if (action === 'mentions') return incomingMentions(chat, options);
  if (action === 'dm-inbox') return directInbox(chat, options);
  if (action === 'inspect') return inspectChannel(chat, options);
  if (action === 'list') {
    const response = await chat.request('/xms/login/recent/list', { body: {} });
    if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new AppError('UNSUPPORTED_CONTENT', 'Chat returned an unrecognized recent-channel index.');
    const items = [];
    for (const [key, entry] of Object.entries(response.data)) {
      if (entry?.sType !== 'groupchat' || Number(entry.type) === 3) continue;
      const id = channelId(entry.jid ?? entry.groupId ?? key, chat.channelSuffix);
      const item = summary(id.jid, entry);
      items.push(item);
    }
    return { items, scope: 'recent-channels', nextCursor: null };
  }
  const id = channelId(messageLink ? messageLink.channel : options.channel, chat.channelSuffix);
  const reading = action === 'read' || action === 'thread' || action === 'conversation';
  const limit = action === 'members' ? integer(options.limit ?? 1000, 'Limit', 1) : reading ? integer(options.limit ?? 20, 'Limit', 1) : null;
  if (action === 'members' && limit > 1000) throw new AppError('INVALID_INPUT', 'Limit must not exceed 1000.');
  const scope = reading ? [...cursorScope(`chat ${action}`, options), ...(options.timeRange ? [[options.timeRange.since, options.timeRange.until]] : [])] : null;
  const before = reading && options.cursor ? decodeCursor(options.cursor, scope).before
    : reading && options.before !== undefined ? integer(options.before, 'Before timestamp', 0) : undefined;
  const timestamp = action === 'thread' || action === 'reply' || (action === 'reconcile' && options.thread !== undefined) ? integer(options.thread, 'Thread timestamp', 1) : null;
  if (timestamp !== null && before !== undefined && before < timestamp) throw new AppError('INVALID_INPUT', 'Before timestamp must not precede the thread parent.');
  const channel = await (action === 'send' || action === 'reply' ? writeChannelInfo : readChannelInfo)(chat, id);
  if (Number(channel.type) === 3) {
    if (action === 'message') return groupDirect(chat, 'group-message', {
      group: id.jid, 'expect-users': options['expect-users'], message: messageLink.message, time: messageLink.time,
    });
    throw new AppError('UNSUPPORTED_GROUP_DIRECT', 'Use the distinct group-DM commands with a complete --expect-users audience.');
  }
  if (action === 'conversation') return readConversation(chat, id, channel, options, limit, before, scope);
  if (action === 'message') {
    const message = await exactMessage(chat, id, messageLink.message, messageLink.time);
    let parent = null, threadCommand = null;
    if (message?.replyTo) {
      const reply = message.replyTo;
      if (typeof reply.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(reply.id)) throw new AppError('UNSUPPORTED_CONTENT', 'Reply has no usable parent message ID.');
      const parentTime = integer(reply.thread, 'Reply parent timestamp', 1);
      if (parentTime > message.timestamp) throw new AppError('UNSUPPORTED_CONTENT', 'Reply parent timestamp follows the reply.');
      parent = await exactMessage(chat, id, reply.id, parentTime);
      if (parent?.replyTo) throw new AppError('UNSUPPORTED_CONTENT', 'The linked reply did not resolve to a root parent.');
      threadCommand = ['chat', 'thread', '--channel', id.jid, '--thread', String(parentTime)];
    }
    return {
      channel: summary(id.jid, channel), link: messageLink, message, parent, threadCommand,
      outcome: message && (!message.replyTo || parent) ? 'confirmed' : 'unknown', scope: 'exact-message-id',
      timestamp: messageLink.time, absenceProvesDeletion: false, replyLinkMappingVerified: true,
    };
  }
  if (action === 'info') return { channel: summary(id.jid, channel) };
  if (action === 'members') return members(chat, id, channel, limit);
  if (action === 'reconcile') {
    const result = timestamp === null ? await history(chat, id, 100) : await thread(chat, id, timestamp, 100);
    const message = result.messages.find(item => item.id === options.message);
    return { channel: summary(id.jid, channel), id: options.message, outcome: message ? 'confirmed' : 'unknown',
      found: !!message, message: message ?? null, scope: 'latest-100-records', absenceProvesFailure: false };
  }
  if (action === 'send') return send(chat, id, channel, options.text);
  if (action === 'thread') return { channel: summary(id.jid, channel), ...await pagedHistory(chat, id, timestamp, limit, before, scope), order: 'timestamp-descending' };
  if (action === 'reply') {
    const { parent } = await thread(chat, id, timestamp, 1);
    const owner = parent.from?.split('@')[0];
    if (!xmlText(parent.id) || !parent.id || !xmlText(owner) || !owner || !/^[^@/]+@[^@/]+$/.test(parent.from)) {
      throw new AppError('UNSUPPORTED_CONTENT', 'Thread parent did not provide a usable reply identity. Nothing was sent.');
    }
    return send(chat, id, channel, options.text, { id: parent.id, owner, thread: timestamp });
  }
  const result = await pagedHistory(chat, id, null, limit, before, scope);
  return { channel: summary(id.jid, channel), ...result, order: 'timestamp-descending' };
}

async function resolveDirectRecipient(chat, options) {
  if (options.name === undefined) {
    const user = await resolveContact(chat, options.email);
    if (options['expect-user'] !== undefined && user.jid !== options['expect-user']) throw new AppError('RECIPIENT_CHANGED', 'Verified recipient does not match --expect-user; nothing sent.');
    return user;
  }
  if (options.email !== undefined) throw new AppError('INVALID_INPUT', 'Supply name or email, not both.');
  const result = await searchUsers(chat, options.name);
  const matches = result.items.filter(item => item.matchQuality === 'exact-name');
  if (matches.length > 1) throw new AppError('AMBIGUOUS_USER', 'Multiple exact names matched; select an explicit email instead.');
  if (matches.length !== 1) throw new AppError('USER_NOT_FOUND', 'No exact active same-account name matched.');
  if (!options['expect-user'] || options['expect-user'] !== matches[0].jid) {
    throw new AppError('RECIPIENT_CONFIRMATION_REQUIRED', 'A bounded exact-name match does not prove uniqueness. Supply --expect-user with the selected native JID, or use explicit email.');
  }
  const user = await resolveContact(chat, matches[0].email);
  if (user.jid !== options['expect-user']) throw new AppError('RECIPIENT_CHANGED', 'Verified recipient changed; nothing sent.');
  return { ...user, resolution: { matchQuality: 'exact-name', searchExhaustive: false, globalUniqueness: 'unknown', explicitRecipientConfirmed: true } };
}

export async function runChat(session, action, options = {}) {
  const reads = ['mentions', 'dm-inbox', 'new-messages', 'list', 'inspect', 'dm-read', 'read', 'thread', 'conversation', 'message', 'cards', 'users', 'members', 'pins', 'reactions', 'activity'];
  if (!reads.includes(action)) return runChatAction(session, action, options);
  if (options.state === 'unread' && !['mentions', 'dm-inbox'].includes(action)) {
    throw new AppError('UNSUPPORTED_UNREAD_SOURCE', 'Ordinary history and activity cannot answer unread state; use a native unread index.');
  }
  const observedAt = new Date().toISOString();
  let timeOptions = options;
  if (action === 'activity' && options.cursor) {
    try {
      if (typeof options.cursor !== 'string' || options.cursor.length > 60000 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) throw Error();
      const cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
      if (cursor.scope?.[0] !== 'chat activity' || !Number.isSafeInteger(cursor.scope[4]) || !Number.isSafeInteger(cursor.scope[5])) throw Error();
      timeOptions = { ...options,
        since: options.since === undefined || ['today', 'now'].includes(options.since) ? new Date(cursor.scope[4]).toISOString() : options.since,
        until: options.until === undefined || ['today', 'now'].includes(options.until) ? new Date(cursor.scope[5] + 1).toISOString() : options.until,
        timezone: options.timezone ?? cursor.scope[6] };
    } catch { throw new AppError('INVALID_INPUT', 'Invalid activity interval cursor.'); }
  }
  const timeRange = resolveChatTime(timeOptions);
  if (timeRange && !['mentions', 'dm-read', 'read', 'thread', 'conversation', 'activity'].includes(action)) {
    throw new AppError('INVALID_INPUT', 'Time ranges are not supported for this Chat source; no history substitution was made.');
  }
  if (options['mention-scope'] !== undefined && !['any', 'direct', 'all', 'mention-group', 'textual', 'unknown'].includes(options['mention-scope'])) {
    throw new AppError('INVALID_INPUT', 'Mention scope must be any, direct, all, mention-group, textual or unknown.');
  }
  if (options['mention-scope'] === 'textual') throw new AppError('UNSUPPORTED_MENTION_SCOPE', 'Native mention indexes do not establish textual @-matches; use explicit search, not unread mentions.');
  if (options['identity-db'] !== undefined) throw new AppError('UNSUPPORTED_IDENTITY_CACHE', 'No persistent identity cache is implemented; use bounded native cards.');
  if (options['identity-limit'] !== undefined && (integer(options['identity-limit'], 'Identity limit', 1) > 100 || !options['resolve-identities'])) {
    throw new AppError('INVALID_INPUT', 'Identity limit requires --resolve-identities and must be 1–100.');
  }
  const prepared = { ...options, timeRange };
  const chat = await session.openChat();
  const result = action === 'activity' ? await readActivity(chat, prepared, { channelId, channelInfo: readChannelInfo, summary, history, thread })
    : await runChatAction({ openChat: async () => chat }, action, prepared);
  finishChatRead(result, chat, action, prepared, observedAt);
  if (options['resolve-identities']) await resolveResultActors(chat, result, options);
  return enforceChatStrict(result, action, options.strict);
}

async function resolveResultActors(chat, result, options) {
  const limit = integer(options['identity-limit'] ?? 100, 'Identity limit', 1);
  if (limit > 100) throw new AppError('INVALID_INPUT', 'Identity limit must not exceed 100.');
  let missing = 0;
  const targets = [], add = (record, key, relation = 'unknown') => {
    if (!record) return;
    if (typeof record[key] === 'string' && record[key]) targets.push({ record, key, id: record[key], relation });
    else missing++;
  };
  for (const message of [...(result.messages ?? []), ...(result.message ? [result.message] : []), ...(result.parent?.from ? [result.parent] : [])]) add(message, 'from');
  for (const item of result.items ?? []) {
    add(item.message, 'from'); add(item.latest?.message, 'from');
    if (result.scope?.includes('pin-history')) add(item, 'pinner');
    if (result.scope === 'channel-member-preview') add(item, 'jid', 'member');
    for (const actor of item.users ?? item.actors ?? []) add(actor, 'jid');
  }
  add(result.current, 'pinner');
  const ids = [...new Set(targets.map(target => target.id))], selected = ids.slice(0, limit);
  const cards = await readUserCards(chat, selected), failure = cards.error;
  const profiles = new Map(cards.items.map(item => [item.input, item]));
  for (const target of targets) {
    const card = profiles.get(target.id);
    target.record[`${target.key}Identity`] = card?.identity ?? null;
    if (target.key === 'from') {
      target.record.senderIdentity = { status: card?.status === 'resolved' ? 'canonical' : target.record.messageLocalLabel ? 'message-local' : 'unresolved',
        canonicalProfile: card?.profile ?? null, messageLocalLabel: target.record.messageLocalLabel ?? null,
        canonicalStatus: card?.status ?? 'unavailable', ...(card?.error ? { error: card.error } : {}) };
    }
    target.record.observations ??= [];
    const resourceId = result.channel?.id ?? result.channel?.jid ?? result.channelId;
    if (resourceId) target.record.observations.push({ scope: 'channel', resourceId, relationship: target.relation,
      source: result.scope, observedAt: result.freshness.observedAt });
  }
  result.identities = cards.items.map(item => ({ nativeId: item.requestedJid, identity: item.identity, profile: item.profile, status: item.status, observations: item.observations ?? [], ...(item.error ? { error: item.error } : {}) }));
  if (result.senderEvidence) {
    const evidence = result.senderEvidence;
    evidence.unresolvedNativeSenders = evidence.unresolvedNativeSenders.filter(sender => profiles.get(sender.nativeId)?.status !== 'resolved');
    evidence.unresolvedSenderCount = evidence.unresolvedNativeSenders.length;
    evidence.identitiesResolved = !evidence.unresolvedSenderCount && !evidence.missingSenderCount;
  }
  result.coverage.identity = dimension(ids.length <= limit && cards.complete && !missing ? 'complete' : 'incomplete', 'returned-actors',
    ids.length > limit ? ['IDENTITY_BUDGET_LIMIT'] : cards.complete && !missing ? [] : ['NATIVE_IDENTITY_UNAVAILABLE']);
  result.identityResolution = { requested: selected.length, unresolved: missing + ids.length - cards.items.filter(item => item.status === 'resolved').length,
    limit, cache: 'none', scope: 'native-global-identities-separated-from-resource-observations', ...(failure ? { error: failure } : {}) };
  const messageTargets = targets.filter(target => target.key === 'from');
  result.coverage.identity.counts = { canonical: messageTargets.filter(target => target.record.senderIdentity.status === 'canonical').length,
    local: messageTargets.filter(target => target.record.senderIdentity.status === 'message-local').length,
    unresolved: missing + messageTargets.filter(target => target.record.senderIdentity.status === 'unresolved').length };
}

async function parseHistoryRecords(chat, records) {
  const messages = [], unsupportedItems = [];
  for (const record of records) {
    try {
      const parsed = await chat.parseMessages([record]);
      if (parsed.length !== 1 || typeof parsed[0]?.id !== 'string' || !parsed[0].id
        || !Number.isSafeInteger(parsed[0].timestamp) || parsed[0].timestamp < 1) {
        throw new AppError('UNSUPPORTED_CONTENT', 'History record has no usable native identity.', { reason: 'MESSAGE_IDENTITY_UNAVAILABLE' });
      }
      messages.push(parsed[0]);
    }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== 'UNSUPPORTED_CONTENT') throw error;
      unsupportedItems.push({ reason: error.details?.reason ?? 'MESSAGE_PARSER_UNSUPPORTED', record });
    }
  }
  return { messages, unsupportedItems };
}
