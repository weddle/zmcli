import { randomUUID } from 'node:crypto';
import { AppError, recoverSafeRead, retryAfterMs } from './session.mjs';
import WebSocket from 'ws';
import { parseXml, child, attr, messageWire, unreadWire, attachmentRichText, xml } from './chat-xml.mjs';

function zoomUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('CHAT_ROUTING_ERROR', 'Chat returned an invalid service route.'); }
  if (!['https:', 'wss:'].includes(url.protocol) || !url.hostname.endsWith('.zoom.us') || url.username || url.password || (url.port && url.port !== '443')) {
    throw new AppError('CHAT_ROUTING_ERROR', 'Chat service routes must use secure Zoom origins.');
  }
  return url;
}

function giphyUrl(value, id) {
  const url = zoomUrl(value), parts = url.pathname.split('/');
  if (url.protocol !== 'https:' || url.hostname !== 'file-cf.zoom.us' || url.search || url.hash
    || !url.pathname.startsWith('/external/link/issue/giphy/media/') || parts.length !== 9
    || !/^[A-Za-z0-9_.-]+$/.test(parts[6]) || parts[7] !== id || !['100.gif', '100w.gif', '200.gif'].includes(parts[8])) {
    throw new AppError('UNSUPPORTED_GIPHY_URL', 'GIF bytes require the observed Zoom proxy and exact catalog asset, not an arbitrary URL.');
  }
  return url;
}

function giphyAsset(value) {
  if (!value || typeof value.id !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(value.id)
    || value.type !== 'gif' || value.rating !== 'g' || typeof value.title !== 'string' || !value.title) {
    throw new AppError('UNSUPPORTED_GIPHY', 'Only identified native G-rated GIF catalog records are verified.');
  }
  let source;
  try { source = new URL(value.url); } catch { throw new AppError('UNSUPPORTED_GIPHY', 'GIF attribution URL is invalid.'); }
  if (source.protocol !== 'https:' || source.hostname !== 'giphy.com' || source.username || source.password || source.port
    || source.search || source.hash || !source.pathname.startsWith('/gifs/') || !source.pathname.endsWith(value.id)) {
    throw new AppError('UNSUPPORTED_GIPHY', 'GIF attribution does not match the observed provider asset.');
  }
  const image = original => {
    if (!original || typeof original !== 'object' || Array.isArray(original)) throw new AppError('UNSUPPORTED_GIPHY', 'GIF variant metadata is missing.');
    const result = { ...original };
    for (const key of ['width', 'height', 'size']) {
      if (!/^[1-9]\d*$/.test(String(original[key])) || !Number.isSafeInteger(Number(original[key]))) throw new AppError('UNSUPPORTED_GIPHY', 'GIF dimensions and sizes must be positive safe integers.');
      result[key] = Number(original[key]);
    }
    giphyUrl(result.url, value.id);
    for (const key of ['webp', 'mp4']) if (result[key] !== undefined) {
      let url;
      try { url = new URL(result[key]); } catch { throw new AppError('UNSUPPORTED_GIPHY', 'GIF alternate rendition URL is invalid.'); }
      if (url.protocol !== 'https:' || !/^media\d*\.giphy\.com$/.test(url.hostname) || url.username || url.password || url.port
        || url.search || url.hash || url.pathname.split('/').at(-2) !== value.id || !url.pathname.endsWith(`.${key}`)) {
        throw new AppError('UNSUPPORTED_GIPHY', 'GIF alternate rendition does not match its provider asset.');
      }
    }
    return result;
  };
  const big = image(value.images?.fixed_height);
  return { id: value.id, url: value.url, title: value.title, type: value.type, rating: value.rating,
    images: { bigPicInfo: big, pcPicInfo: value.images?.fixed_height_small?.url ? image(value.images.fixed_height_small) : big,
      mobilePicInfo: value.images?.fixed_width_small?.url ? image(value.images.fixed_width_small) : big } };
}

// Body text is a projection, never evidence of lossless structured content.
export function messageContent(record, wire) {
  const reasons = new Set();
  if (wire.deleted) reasons.add('DELETED_MESSAGE');
  let richText = null;
  if (wire.rawRichText === null) reasons.add('MISSING_ZMRT');
  else {
    try { richText = JSON.parse(wire.rawRichText); }
    catch { reasons.add('INVALID_ZMRT_JSON'); }
  }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const keys = (value, allowed) => {
    if (Object.keys(value).some(key => !allowed.includes(key))) reasons.add('UNSUPPORTED_RICH_FIELDS');
  };
  const node = value => {
    if (!object(value)) { reasons.add('UNSUPPORTED_RICH_NODE'); return; }
    keys(value, value.type === 'Page' ? ['type', 'style', 'children'] : ['type', 'style', 'content']);
    if (value.style !== undefined && (!object(value.style) || Object.keys(value.style).length)) reasons.add('UNSUPPORTED_RICH_STYLE');
    if (value.type === 'Page' && Array.isArray(value.children)) value.children.forEach(node);
    else if (value.type === 'Paragraph' && Array.isArray(value.content)) {
      for (const run of value.content) {
        if (!object(run)) { reasons.add('UNSUPPORTED_RICH_RUN'); continue; }
        if (object(run.data?.attachment)) reasons.add('ATTACHMENT_CONTENT');
        keys(run, ['data', 'attrs']);
        if (run.attrs !== undefined) {
          if (!object(run.attrs) || Object.entries(run.attrs).some(([key, value]) =>
            !['bold', 'italic'].includes(key) || typeof value !== 'boolean')) reasons.add('UNSUPPORTED_RUN_ATTRIBUTES');
        }
        if (typeof run.data === 'string') continue;
        const mention = run.data?.['custom-inline'];
        if (object(mention) && ['mention', 'channel'].includes(mention.type)) {
          keys(run.data, ['custom-inline']);
          keys(mention, ['type', 'mentionType', 'jid', 'label', 'prefix', 'joinStatus']);
          if (![1, 2, 3, 4, 5].includes(mention.mentionType) || typeof mention.jid !== 'string'
            || typeof mention.label !== 'string' || !['@', '#', '/'].includes(mention.prefix)
            || (mention.joinStatus !== undefined && !['Joined', 'NotJoined'].includes(mention.joinStatus))) {
            reasons.add('UNSUPPORTED_RICH_MENTION');
          }
          continue;
        }
        const source = run.data?.link?.source;
        if (!object(run.data) || !object(run.data.link) || !object(source)
          || source.type !== 'link' || typeof source.link !== 'string' || typeof source.text !== 'string') {
          reasons.add('UNSUPPORTED_RICH_RUN'); continue;
        }
        keys(run.data, ['link']); keys(run.data.link, ['source']); keys(source, ['type', 'link', 'text']);
      }
    } else reasons.add('UNSUPPORTED_RICH_NODE');
  };
  if (richText !== null) {
    if (richText?.type !== 'Page') reasons.add('UNSUPPORTED_RICH_ROOT');
    node(richText);
  } else if (!reasons.size) reasons.add('UNSUPPORTED_RICH_ROOT');
  if (!['0', '17'].includes(wire.messageType)) reasons.add('UNSUPPORTED_MESSAGE_TYPE');
  if (wire.text === null) reasons.add('MISSING_BODY');
  for (const reason of wire.mentionCoverage?.reasons ?? []) reasons.add(reason);
  const { rawRichText, ...message } = wire;
  const evidence = record.incrementalIndexEvidence;
  const incrementalIndexEvidence = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    ? { ...Object.fromEntries(['messageTimestamp', 'collectionTimestamp', 'relation', 'endpoint', 'contentCoverage', 'identityProvenance', 'firstSeen', 'lastSeen']
      .filter(key => Object.hasOwn(evidence, key)).map(key => [key, evidence[key]])), completenessEvidence: false } : null;
  return { ...message,
    readState: 'unknown',
    fromIdentity: null,
    senderIdentity: { status: wire.messageLocalLabel ? 'message-local' : 'unresolved', canonicalProfile: null,
      messageLocalLabel: wire.messageLocalLabel ?? null },
    ...(incrementalIndexEvidence ? { incrementalIndexEvidence } : {}),
    replyCount: Number.isSafeInteger(record.comment_total) && record.comment_total >= 0 ? record.comment_total : null,
    richText, raw: { zmrt: rawRichText, xml: record.message },
    contentComplete: reasons.size === 0,
    contentCoverage: { scope: 'observed-zmrt-paragraph-runs-links-and-mentions', complete: reasons.size === 0,
      lossless: false, rawXmlPreserved: true, reasons: [...reasons] } };
}

export async function openChatTransport({ http, identity, WebSocketClass = WebSocket, recovery } = {}) {
  const version = '7.0.5.19571.0828';
  let disposed = false, socket, opening, authenticated = false, unreadReady = false, unreadError, unreadOpening, unreadWaiter, unreadRoot, unreadReceivedAt;
  const pending = new Map();
  const ensureOpen = () => {
    if (disposed) throw new AppError('SESSION_CLOSED', 'The Chat session is closed.');
  };
  const checked = async response => {
    if (response.status === 401) {
      await response.body?.cancel();
      throw new AppError('AUTH_REQUIRED', 'Chat authentication expired.');
    }
    if (response.status === 403) {
      await response.body?.cancel();
      throw new AppError('FORBIDDEN', 'Chat denied this operation.');
    }
    if (response.status === 429) {
      const delay = retryAfterMs(response.headers.get('retry-after'));
      await response.body?.cancel();
      throw new AppError('RATE_LIMITED', 'Chat rate limited this operation.', { retryAfterMs: delay });
    }
    if (response.status === 490) {
      await response.body?.cancel();
      throw new AppError('CHAT_CREDENTIAL_EXPIRED', 'Chat rejected the current service credential.');
    }
    if (!response.ok) throw new AppError('HTTP_ERROR', 'Chat could not complete the request.', { status: response.status });
    return response;
  };
  const bootstrap = async (path, body) => {
    const response = await checked(await http.request(`https://zoom.us${path}`, {
      method: 'POST', headers: { origin: 'https://app.zoom.us', referer: 'https://app.zoom.us/',
        'content-type': body ? 'application/json' : 'application/x-www-form-urlencoded',
        'x-zm-trackingid': randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    let data;
    try { data = await response.json(); } catch { throw new AppError('AUTH_REQUIRED', 'Chat cookie bootstrap did not return JSON. Resolve sign-in through the first-party UI.'); }
    if (data?.status !== true || !data.result) throw new AppError('AUTH_REQUIRED', 'Chat did not accept the supplied cookies.');
    return data.result;
  };
  let token, config;
  try {
    [token, config] = await Promise.all([
      recoverSafeRead(() => bootstrap('/newchat/token?tokenType=all&requestFrom=webNewChat'), recovery),
      recoverSafeRead(() => bootstrap('/chat/config', { requestFrom: 'webNewChat', newChatVersion: version }), recovery),
    ]);
    if (![config.uid, config.accountId, config.jid, token.jid, token.zak, token.xmppToken, token.resourceId, token.deviceId]
      .every(value => typeof value === 'string' && value.trim())) throw new AppError('CHAT_BOOTSTRAP_ERROR', 'Chat credential or identity fields are missing.');
    if (config.jid !== token.jid || !/^[^@/\s]+@[^@/\s]+$/.test(token.jid)) throw new AppError('TENANT_MISMATCH', 'Chat configuration and issued token identities disagree.');
    if (identity && (config.uid !== identity.user?.userId || config.accountId !== identity.user?.accountId
      || (identity.account?.accountId !== undefined && config.accountId !== identity.account.accountId))) throw new AppError('TENANT_MISMATCH', 'Authenticated service actor or account identities disagree.');
    identity ??= { user: { userId: config.uid, accountId: config.accountId }, account: { accountId: config.accountId } };
    const domains = config.domainList, channelSuffix = domains?.channelSessionDomain;
    if (typeof channelSuffix !== 'string' || !/^@conference\.[a-z0-9.-]+\.zoom\.us$/.test(channelSuffix)) throw new AppError('CHAT_ROUTING_ERROR', 'Chat did not issue a recognized channel domain.');
    const origin = value => {
      if (typeof value !== 'string' || !value) throw new AppError('CHAT_ROUTING_ERROR', 'A required Chat service route is missing.');
      const url = zoomUrl(value.includes('://') ? value : `https://${value}`);
      if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) throw new AppError('CHAT_ROUTING_ERROR', 'Chat requires a secure service origin.');
      return url.origin;
    };
    const routes = { xms: origin(domains.microServiceDomain), bff: origin(domains.bffCFServerDomain),
      ucs: origin(domains.ucsDomain), asyncIm: origin(domains.asyncImDomain), file: origin(domains.fileServerDomain) };
    const socketUrl = zoomUrl(`wss://${domains.xmppWsDomain}/xmpp-websocket`).href;
    const remintToken = async () => {
      const [candidate, settings] = await Promise.all([
        bootstrap('/newchat/token?tokenType=all&requestFrom=webNewChat'),
        bootstrap('/chat/config', { requestFrom: 'webNewChat', newChatVersion: version }),
      ]);
      if (![candidate.jid, candidate.zak, candidate.xmppToken, candidate.resourceId, candidate.deviceId]
        .every(value => typeof value === 'string' && value.trim())
        || settings.uid !== config.uid || settings.accountId !== config.accountId
        || settings.jid !== config.jid || candidate.jid !== config.jid) {
        throw new AppError('AUTH_REQUIRED', 'Chat cookie remint did not return a replacement credential for the same actor and account.');
      }
      const profile = await jsonRequest(`${routes.ucs}/api/v1/ucs/contact/vcard/batch`, {
        method: 'POST', headers: { zak: candidate.zak, 'content-type': 'application/json', 'x-zm-trackingid': randomUUID() },
        body: JSON.stringify({ userJids: [candidate.jid] }),
      });
      const user = profile.vcardUsers?.length === 1 ? profile.vcardUsers[0] : undefined;
      if (profile.result !== 0 || user?.jid !== candidate.jid || user?.userId !== settings.uid) {
        throw new AppError('AUTH_REQUIRED', 'Chat could not verify the re-minted credential against the current actor.');
      }
      token = candidate;
    };
    const currentFrom = () => `${token.jid}/${token.resourceId}`;
    const messageSearchEnabled = config.searchInChatEnabled === true;
    const unlimitedSearchRetention = [config.channelLocalStorageTime, config.p2pMucLocalStorageTime, config.selfChatStorageTimeResult]
      .every(value => typeof value === 'string' && value.split(';')[0] === '-1');
    // The verified web bridge returns {}, and its session helper maps that to none.
    // Keep the current-client guard without executing or importing the web SDK.
    const webEncryptionCompatible = domains.chatCdnPath === `https://st1.zoom.us/fe-static/nx-chat/${version}`;
    const failPending = error => { for (const entry of pending.values()) entry.reject(error); pending.clear(); };
    const dispose = async () => {
      disposed = true;
      failPending(new AppError('SESSION_CLOSED', 'The Chat session is closed.'));
      unreadWaiter?.reject(new AppError('SESSION_CLOSED', 'The Chat session is closed.'));
      token = undefined; config = undefined;
      if (!socket || socket.readyState === WebSocketClass.CLOSED) return;
      await new Promise(resolve => {
        const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1000);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
        if (socket.readyState === WebSocketClass.OPEN) socket.send('<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>');
        socket.close();
      });
    };
    const connectSocket = async () => {
      ensureOpen();
      if (authenticated && socket?.readyState === WebSocketClass.OPEN) return;
      if (opening) return opening;
      opening = new Promise((resolve, reject) => {
        let authSent = false, settled = false;
        const authId = `{${randomUUID()}-W_${randomUUID().slice(0, 8)}-N}`;
        const finish = error => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          if (error) { socket?.terminate(); reject(error); } else resolve();
        };
        const timer = setTimeout(() => finish(new AppError('CHAT_NOT_READY', 'Chat socket authentication timed out.')), 20000);
        socket = new WebSocketClass(socketUrl, 'xmpp');
        socket.addEventListener('open', () => socket.send(`<open version="1.0" xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="${xml(token.jid.split('@')[1])}"/>`));
        socket.addEventListener('error', () => finish(new AppError('CHAT_NOT_READY', 'Chat socket connection failed.')));
        socket.addEventListener('close', () => {
          authenticated = false;
          unreadReady = false; unreadOpening = undefined; unreadRoot = undefined; unreadReceivedAt = undefined;
          finish(new AppError('CHAT_NOT_READY', 'Chat socket closed before authentication.'));
          failPending(new AppError('WRITE_UNCONFIRMED', 'Chat socket closed before acknowledgement. Inspect the recorded operation IDs before any retry.'));
          unreadWaiter?.reject(new AppError('CHAT_INDEX_NOT_READY', 'Chat closed before its native unread index arrived.'));
        });
        socket.addEventListener('message', event => {
          if (disposed) return;
          let root;
          try { root = parseXml(event.data); } catch {
            finish(new AppError('CHAT_PROTOCOL_ERROR', 'Chat socket returned unsupported XML.'));
            return;
          }
          if (root.localName === 'features' && !authSent) {
            authSent = true;
            socket.send(`<iq id="${xml(authId)}" type="set" xmlns="jabber:client"><query xmlns="jabber:iq:auth"><username>${xml(token.jid.split('@')[0])}</username><password>${xml(token.xmppToken)}</password><resource>${xml(token.resourceId)}</resource><option>13422497015</option><deviceid>${xml(token.deviceId)}</deviceid><dname>Chrome</dname></query></iq>`);
          } else if (root.localName === 'iq' && attr(root, 'id') === authId) {
            if (attr(root, 'type') !== 'result') { finish(new AppError('AUTH_REQUIRED', 'Chat rejected the newly issued socket credential.')); return; }
            authenticated = true; finish();
          } else if (root.localName === 'iq') {
            const offline = child(root, 'zoom', 'zoom:iq:ext');
            if (attr(root, 'type') === 'result' && attr(offline, 'type') === 'offline') {
              if (attr(root, 'from') !== currentFrom() || attr(root, 'to') !== currentFrom()) {
                unreadError = new AppError('CHAT_IDENTITY_ERROR', 'Native unread index does not belong to this authenticated resource.');
                unreadWaiter?.reject(unreadError);
              } else {
                unreadRoot = root; unreadReceivedAt = Date.now();
                unreadReady = true;
                unreadWaiter?.resolve();
              }
              return;
            }
            const id = attr(root, 'id'), entry = pending.get(id);
            if (!entry) return;
            if (attr(root, 'type') === 'error') entry.reject(new AppError('CHAT_SERVICE_ERROR', 'Chat rejected the request.', { requestId: id }));
            else if (attr(root, 'type') === 'result') entry.resolve(root);
          }
        });
      });
      const attempt = opening;
      try { return await attempt; }
      finally { if (opening === attempt) opening = undefined; }
    };
    const sendIq = async (stanza, requestId, { responseXml = false } = {}) => {
      ensureOpen(); await connectSocket();
      if (socket.readyState !== WebSocketClass.OPEN) throw new AppError('CHAT_NOT_READY', 'Chat socket is unavailable. Nothing sent.');
      const root = await new Promise((resolve, reject) => {
        const finish = callback => value => { clearTimeout(timer); pending.delete(requestId); callback(value); };
        const timer = setTimeout(() => entry.reject(new AppError('WRITE_UNCONFIRMED', 'No service IQ acknowledgement arrived. Reconcile before retrying.', { requestId })), 10000);
        const entry = { resolve: finish(resolve), reject: finish(reject) };
        pending.set(requestId, entry);
        try { socket.send(stanza); } catch { entry.reject(new AppError('WRITE_UNCONFIRMED', 'Chat transmission failed with unknown acceptance.', { requestId })); }
      });
      const room = child(root, 'room'), echo = child(root, 'zoom', 'zoom:iq:ext'), mentionGroup = child(root, 'mgroup', 'zoom:iq:mgroups');
      const notify = child(child(root, 'query', 'zoom:iq:notify'), 'mucnotify', 'zoom:notify:mucnotify');
      const draftQuery = child(root, 'query', 'zoom:iq:draft'), draftItem = child(draftQuery, 'item'), notifies = [], notAllowed = [];
      for (let item = child(room, 'not-allowed-items')?.firstChild; item; item = item.nextSibling) {
        if (item.nodeType === 1 && item.localName === 'item') notAllowed.push({ jid: item.textContent, reason: attr(item, 'reason') });
      }
      for (let item = notify?.firstChild; item; item = item.nextSibling) {
        if (item.nodeType === 1 && item.localName === 'item') notifies.push({ jid: attr(item, 'v'), type: attr(item, 'type') });
      }
      return { ...(responseXml ? { stanza: root.toString() } : {}), from: attr(root, 'from'), room: room ? { jid: attr(room, 'uuid'), option: attr(room, 'option'),
        memberCount: attr(room, 'total'), action: attr(room, 'action'), xmlns: room.namespaceURI, diff: attr(room, 'diff'), notAllowed } : null,
        mentionGroup: mentionGroup ? { id: attr(mentionGroup, 'id'), action: attr(mentionGroup, 'action'), version: attr(mentionGroup, 'version') } : null,
        notifies: notify ? notifies : null,
        draft: draftQuery ? { action: attr(draftQuery, 'action'), version: attr(draftQuery, 'version'),
          item: draftItem ? { id: attr(draftItem, 'id'), type: attr(draftItem, 'type'), createdAt: attr(draftItem, 'create_t'),
            modifiedAt: attr(draftItem, 'modified_t'), sendAt: attr(draftItem, 'send_t'), version: attr(draftItem, 'ver') } : null } : null,
        echo: echo && attr(echo, 'type') === 'echo' ? { timestamp: attr(echo, 't'), previous: attr(echo, 'prev') } : null };
    };
    const serviceRequest = async (url, options = {}) => {
      ensureOpen();
      return checked(await http.request(zoomUrl(url).href, { credentials: 'omit', ...options }));
    };
    const jsonRequest = async (url, options) => {
      const response = await serviceRequest(url, options);
      try { return await response.json(); } catch { throw new AppError('RESPONSE_ERROR', 'Chat service returned non-JSON content.'); }
    };
    return {
      get identity() { return identity; }, get from() { return currentFrom(); }, channelSuffix, dispose, messageSearchEnabled, unlimitedSearchRetention,
      credentialSource: 'cookie-only', nativeProtocolVersion: version,
      async directEncryptionMode() {
        ensureOpen();
        if (!webEncryptionCompatible) throw new AppError('UNSUPPORTED_ENCRYPTION', 'The current native web encryption compatibility contract is unknown. Nothing sent.');
        return 'none';
      },
      async unreadResource() {
        await recoverSafeRead(() => connectSocket(), { remint: remintToken, ...recovery });
        if (socket.readyState !== WebSocketClass.OPEN) throw new AppError('CHAT_INDEX_NOT_READY', 'The authenticated unread-index resource is no longer connected.');
        if (unreadError) throw unreadError;
        if (!unreadReady) {
          unreadOpening ??= new Promise((resolve, reject) => {
            const finish = callback => value => { clearTimeout(timer); unreadWaiter = undefined; callback(value); };
            const timer = setTimeout(() => unreadWaiter?.reject(new AppError('CHAT_INDEX_NOT_READY', 'Native unread index did not arrive within ten seconds. No unread request or retry was sent.')), 10000);
            unreadWaiter = { resolve: finish(resolve), reject: finish(reject) };
          });
          await unreadOpening;
        }
        ensureOpen();
        if (socket.readyState !== WebSocketClass.OPEN) throw new AppError('CHAT_INDEX_NOT_READY', 'The initialized unread-index resource disconnected before it could be used.');
        return token.resourceId;
      },
      async unreadIndex() {
        await this.unreadResource();
        return { ...unreadWire(unreadRoot, currentFrom(), channelSuffix), receivedAt: unreadReceivedAt };
      },
      async getDisplayName() {
        ensureOpen();
        if (typeof identity.user.displayName === 'string' && identity.user.displayName.trim()) return identity.user.displayName;
        const result = await this.request('/api/v1/ucs/contact/vcard/batch', { body: { userJids: [token.jid] } });
        const profile = result.vcardUsers?.length === 1 ? result.vcardUsers[0] : null;
        if (!profile || profile.jid !== token.jid || profile.userId !== identity.user.userId) throw new AppError('CHAT_IDENTITY_ERROR', 'Chat did not return the authenticated sender profile.');
        const { nickName, firstName, lastName, email } = profile;
        if ([nickName, firstName, lastName, email].some(value => value != null && typeof value !== 'string')) throw new AppError('CHAT_IDENTITY_ERROR', 'Chat returned an unsupported sender name.');
        const name = nickName || (firstName || lastName ? `${firstName ?? ''} ${lastName ?? ''}` : '') || email || '';
        if (!name.trim()) throw new AppError('CHAT_IDENTITY_ERROR', 'Chat did not provide a sender name.');
        identity.user.displayName = name;
        return name;
      },
      async request(path, { method = 'POST', body } = {}) {
        ensureOpen();
        const bff = ['/bffapi/channel/members/client', '/bffapi/channel/mentionGroup/members/client', '/bffapi/mentions/list/client'].includes(path), profile = path === '/api/v1/ucs/contact/vcard/batch';
        const messageSearch = path === '/nws/asyncim/1.0/api/search/message', contactSearch = path === '/nws/asyncim/1.0/api/search/contact';
        const zakOnly = profile || messageSearch || contactSearch, auxiliary = bff || zakOnly;
        if (!auxiliary && !/^\/(xms|history)\//.test(path)) throw new AppError('INVALID_ARGUMENT', 'Only observed Chat service paths are supported.');
        if (auxiliary && method !== 'POST') throw new AppError('INVALID_ARGUMENT', 'This Chat operation requires POST.');
        const url = new URL(path, bff ? routes.bff : profile ? routes.ucs : zakOnly ? routes.asyncIm : routes.xms);
        if (!auxiliary) url.searchParams.set('cv', version);
        const encodedBody = method === 'GET' ? undefined : JSON.stringify(body);
        const perform = () => jsonRequest(url.href, { method, ...(encodedBody === undefined ? {} : { body: encodedBody }), headers: {
          ...(path === '/xms/emoji/listWithDisplayname' ? { customEmoji: '1' } : {}),
          ...(zakOnly ? { zak: token.zak } : bff ? { zak: token.zak, 'xms-hash': 'hardcode' }
            : { authorization: `Bearer ${token.zak}`, 'xms-hash': 'hardcode' }),
          ...(encodedBody === undefined ? {} : { 'content-type': 'application/json' }),
          ...(!zakOnly && { 'xms-timestamp': String(Date.now()) }), 'x-zm-trackingid': randomUUID(),
        } });
        const data = await recoverSafeRead(perform, { remint: remintToken, ...recovery });
        if (contactSearch ? data?.status !== true || !Array.isArray(data.result) : data?.result !== 0) throw new AppError('CHAT_SERVICE_ERROR', 'Chat did not accept the operation.', { result: typeof data?.result === 'number' ? data.result : null });
        return data;
      },
      async parseMessages(records) { return records.map(record => messageContent(record, messageWire(record))); },
      async sendStanza(stanza) {
        ensureOpen(); await connectSocket();
        if (socket.readyState !== WebSocketClass.OPEN) throw new AppError('CHAT_NOT_READY', 'Chat socket is unavailable. Nothing sent.');
        try { socket.send(stanza); } catch { throw new AppError('WRITE_UNCONFIRMED', 'Chat transmission failed with unknown acceptance.'); }
      },
      sendIq,
      async customEmoji(operation, args = {}) {
        ensureOpen();
        if (config.customEmojiEnabled !== true) throw new AppError('FORBIDDEN', 'Custom emoji is not enabled for this account.');
        const headers = { zak: token.zak, 'x-zm-trackingid': randomUUID() };
        if (operation === 'list') {
          const data = await jsonRequest(`${routes.asyncIm}/nws/asyncim/1.0/api/file/list`, { method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ type: 6, pageSize: args.limit ?? 100,
              listSortType: 1, ...(args.own ? { attribute: [{ attributeKey: 'userId', attributeValue: identity.user.userId }] } : {}),
              ...(args.searchAfter ? { searchAfter: args.searchAfter } : {}) }) });
          if (data.result !== 0 || !Array.isArray(data.files) || typeof data.searchAfter !== 'string') throw new AppError('UNSUPPORTED_CONTENT', 'Custom emoji catalog returned an unrecognized response.');
          return data;
        }
        if (config.customEmojiEditable !== true) throw new AppError('FORBIDDEN', 'Custom emoji editing is not enabled for this actor.');
        if (operation === 'upload') {
          if (!Buffer.isBuffer(args.bytes) || !args.bytes.length || args.bytes.length > 256 * 1024) throw new AppError('INVALID_ARGUMENT', 'Custom emoji upload requires at most 256 KiB of image bytes.');
          const body = new FormData(); body.append('file', new Blob([args.bytes], { type: 'image/png' }), args.fileName);
          const url = new URL('/zoomfile/upload', routes.file);
          url.search = new URLSearchParams({ name: args.fileName, channel: '312', business: 'imcustomemoji',
            attr: `businessCode:${args.name}`, scan: 'true', get_dimension: 'true' });
          const response = await serviceRequest(url.href, { method: 'POST', body, headers: { ...headers,
            'X-Zoom-User': identity.user.userId, 'Zoom-File-Meta': JSON.stringify({ open: true, ownerType: 'account', ownerId: identity.user.accountId }) } });
          return { fileId: response.headers.get('zoom-file-id'), bytes: Number(response.headers.get('zoom-file-size')) };
        }
        if (operation === 'delete') {
          const url = new URL(`/file/${encodeURIComponent(args.fileId)}/delete`, routes.file);
          url.searchParams.set('business', 'imcustomemoji');
          const response = await serviceRequest(url.href, { method: 'DELETE', headers });
          await response.body?.cancel();
          return { httpStatus: response.status };
        }
        throw new AppError('INVALID_ARGUMENT', 'Unsupported custom emoji operation.');
      },
      async sticker(operation, args = {}) {
        ensureOpen();
        const flags = config.newChatConfigOptions?.[1];
        if (!/^\d+$/.test(String(flags)) || (typeof flags === 'number' && !Number.isSafeInteger(flags))) throw new AppError('UNSUPPORTED_CAPABILITY', 'Native sticker policy is unavailable.');
        if ((BigInt(flags) & 64n) === 0n) throw new AppError('FORBIDDEN', 'Native stickers are not enabled for this account.');
        const headers = { zak: token.zak, 'x-zm-trackingid': randomUUID() };
        if (operation === 'list') {
          const data = await jsonRequest(`${routes.asyncIm}/nws/asyncim/1.0/api/file/list`, { method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({
              type: 4, pageSize: args.limit ?? 100, listSortType: 1, ...(args.searchAfter ? { searchAfter: args.searchAfter } : {}),
            }) });
          if (data.result !== 0 || !Array.isArray(data.files) || typeof data.searchAfter !== 'string') throw new AppError('UNSUPPORTED_CONTENT', 'Native sticker catalog returned an unrecognized response.');
          return data;
        }
        throw new AppError('INVALID_ARGUMENT', 'Unsupported sticker operation.');
      },
      async giphy(operation, args = {}) {
        ensureOpen();
        if (config.giphy !== true) throw new AppError('FORBIDDEN', 'Native GIF capability is not enabled for this account.');
        if (config.giphyRating !== 'G') throw new AppError('UNSUPPORTED_CAPABILITY', 'Only the observed native G-rated GIF policy is verified.');
        const headers = { zak: token.zak, 'x-zm-trackingid': randomUUID() };
        if (operation === 'download') {
          if (typeof args.id !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(args.id) || !Number.isSafeInteger(args.maxBytes) || args.maxBytes < 1 || args.maxBytes > 1024 * 1024) throw new AppError('INVALID_ARGUMENT', 'Supply a bounded exact GIF download.');
          const url = giphyUrl(args.url, args.id);
          url.search = new URLSearchParams({ 'response-cache-control': 'max-age=31536000', decryptType: '1', business: 'pwachat' });
          const response = await serviceRequest(url.href, { headers }), chunks = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > args.maxBytes) throw new AppError('ATTACHMENT_TOO_LARGE', 'GIF exceeds the bounded download limit.');
            chunks.push(chunk);
          }
          return { bytes: Buffer.concat(chunks, size), size, contentType: response.headers.get('content-type') };
        }
        const url = new URL(operation === 'search' ? '/v1/gifs/search' : '/v1/gifs', routes.file);
        url.searchParams.set('business', 'pwachat');
        if (operation === 'search') {
          if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 100
            || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 30) throw new AppError('INVALID_ARGUMENT', 'GIF search requires a query up to100 characters and limit1..30.');
          url.searchParams.set('q', args.query); url.searchParams.set('limit', String(args.limit)); url.searchParams.set('rating', 'g');
        } else if (operation === 'get' && typeof args.id === 'string' && /^[A-Za-z0-9]{1,128}$/.test(args.id)) url.searchParams.set('ids', args.id);
        else throw new AppError('INVALID_ARGUMENT', 'Unsupported GIF catalog operation.');
        const data = await jsonRequest(url.href, { headers });
        if (data.meta?.status !== 200) throw new AppError('CHAT_SERVICE_ERROR', 'Native GIF catalog rejected the request.', { status: data.meta?.status ?? null });
        if (!Array.isArray(data.data) || data.data.length > 30 || data.pagination?.count !== data.data.length
          || data.pagination.offset !== 0 || !Number.isSafeInteger(data.pagination.total_count) || data.pagination.total_count < data.data.length) {
          throw new AppError('UNSUPPORTED_GIPHY', 'Native GIF catalog pagination is unrecognized.');
        }
        const items = data.data.map(giphyAsset);
        if (new Set(items.map(item => item.id)).size !== items.length) throw new AppError('UNSUPPORTED_GIPHY', 'Native GIF catalog repeated an asset identity.');
        if (operation === 'get' && (items.length !== 1 || items[0].id !== args.id)) throw new AppError('GIPHY_NOT_FOUND', 'Catalog did not resolve the exact requested GIF.');
        return { items, reportedTotal: data.pagination.total_count, rating: 'g',
          pagination: { status: data.pagination.total_count === items.length ? 'end' : 'incomplete', complete: data.pagination.total_count === items.length,
            snapshot: false, scope: 'native-first-catalog-view', continuation: 'not-observed' } };
      },
      async attachment(operation, args) {
        ensureOpen();
        if (!['info', 'download', 'upload', 'send', 'send-giphy'].includes(operation)) throw new AppError('INVALID_ARGUMENT', 'Unsupported attachment operation.');
        const headers = { zak: token.zak, 'x-zm-trackingid': randomUUID() };
        if (operation === 'info') {
          const value = await jsonRequest(`${routes.asyncIm}/nws/asyncim/1.0/api/file/${encodeURIComponent(args.fileId)}`, { headers });
          return Object.fromEntries(['result', 'fileId', 'fileName', 'length', 'digest', 'encryption', 'open', 'ownerId', 'ownerJid', 'ownerType', 'shareJid', 'draft', 'extName', 'createdTime', 'modifiedTime', 'channelTypes'].map(key => [key, value[key]]));
        }
        if (operation === 'download') {
          const url = new URL(`/file/${encodeURIComponent(args.fileId)}`, routes.file);
          url.search = new URLSearchParams({ decryptType: '1', business: 'pwachat', 'response-cache-control': 'max-age=31536000' });
          const response = await serviceRequest(url.href, { headers });
          const chunks = []; let size = 0;
          for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > args.maxBytes) throw new AppError('ATTACHMENT_TOO_LARGE', 'Attachment exceeds the bounded download limit.');
            chunks.push(chunk);
          }
          return { bytes: Buffer.concat(chunks, size), size };
        }
        if (operation === 'upload') {
          if (!Buffer.isBuffer(args.bytes)) throw new AppError('INVALID_ARGUMENT', 'Attachment upload requires file bytes.');
          const bytes = args.bytes;
          if (!bytes.length || bytes.length > 1024 * 1024) throw new AppError('INVALID_ARGUMENT', 'Attachment upload is limited to nonempty files of at most 1 MiB.');
          const body = new FormData(); body.append('file', new Blob([bytes], { type: args.mime }), args.name);
          const url = new URL('/zoomfile/upload', routes.file);
          url.search = new URLSearchParams({ name: args.name, channel: '1', business: 'pwachat', dup: 'true', scan: 'true', ...(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'].includes(args.mime) ? { get_dimension: 'true' } : {}) });
          const response = await serviceRequest(url.href, { method: 'POST', body, headers: { ...headers, 'zoom-file-meta': JSON.stringify({ draft: true }) } });
          return { fileId: response.headers.get('zoom-file-id'), fileName: args.name, fileSize: response.headers.get('zoom-file-size') };
        }
        const giphy = operation === 'send-giphy';
        if (giphy && config.giphy !== true) throw new AppError('FORBIDDEN', 'Native GIF capability is not enabled for this account.');
        if (!giphy) {
          const shared = await jsonRequest(`${routes.asyncIm}/nws/asyncim/1.0/api/file/multishare`, { method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({
              multiFileInfos: [{ fileId: args.fileId }], shareJids: [args.sessionId], ownerId: args.ownerId.split('@')[0], draft: true, replyFile: false,
            }) });
          if (shared.result !== 0) throw new AppError('CHAT_SERVICE_ERROR', 'Native file sharing was rejected; no message was sent.');
        }
        const message = args.message, block = message.messageContent.children[0], attachment = block.content[0].data.attachment;
        const rich = attachmentRichText(attachment, block.type === 'Image');
        const originalType = giphy ? 12 : block.type !== 'Image' ? 10 : attachment.type === 'image/png' ? 5 : attachment.type === 'image/jpeg' ? 1 : attachment.type === 'image/gif' ? 6 : 10;
        const notification = `${message.userName} in ${message.sessionName} sent you a file`;
        const stanza = `<message xmlns="jabber:client" from="${xml(currentFrom())}" id="${xml(message.id)}" to="${xml(message.sessionId)}" type="groupchat"><zmrt>${xml(JSON.stringify(message.messageContent))}</zmrt><body>${xml(notification)}</body><sns><format>%1$@ in %2$@ sent you a file</format><args><arg>${xml(message.userName)}</arg><arg>${xml(message.sessionName)}</arg></args></sns><zmext fb="1"><msg_type>17</msg_type><ori_type>${originalType}</ori_type><from n="${xml(message.userName)}" res="${xml(token.resourceId)}"/><to/><rt b="${xml(rich)}"/><obj f="18" st="0" fs="0"/><visible>true</visible><msg_feature>32768</msg_feature></zmext></message>`;
        const result = await sendIq(stanza, message.id);
        return { id: message.id, timestamp: Number(result.echo?.timestamp) };
      },
    };
  } catch (error) {
    disposed = true; socket?.close(); token = undefined; config = undefined;
    throw error instanceof AppError ? error : new AppError('CHAT_BOOTSTRAP_ERROR', 'Could not initialize the standalone cookie-authenticated Chat session.',
      { cause: { code: 'INTERNAL_ERROR', type: typeof error?.name === 'string' ? error.name : 'Error' } });
  }
}
