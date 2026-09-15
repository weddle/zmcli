import WebSocket from 'ws';
import { AppError, recoverSafeRead, retryAfterMs } from './session.mjs';

const fail = (code, message, details) => new AppError(code, message, details);
const notSent = () => fail('REQUEST_CANCELLED', 'The operation was cancelled before sending.', { outcome: 'not_sent' });
const unknown = () => fail('WRITE_UNCONFIRMED', 'The remote outcome is unknown. No request was replayed.', { outcome: 'unknown' });
const secret = /nak|token|ticket|authorization|password|secret|cookie/i;
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !secret.test(key)).map(([key, item]) => [key, sanitize(item)]));
  return value;
}
function identityOf(data) {
  const user = data.user_profile;
  if (typeof user?.user_id !== 'string' || !user.user_id || typeof user.account_id !== 'string' || !user.account_id) {
    throw fail('AUTH_RESPONSE_ERROR', 'ZoomMate did not provide an actor and account.');
  }
  return { user: { userId: user.user_id, accountId: user.account_id,
    ...(user.user_name ? { displayName: user.user_name } : {}) } };
}
function route(value) {
  let url;
  try { url = new URL(value?.includes('://') ? value : `https://${value}`); } catch { /* handled below */ }
  if (!url || url.protocol !== 'https:' || !url.hostname.endsWith('.zoom.us') || url.username || url.password || url.port || url.search || url.hash) {
    throw fail('AUTH_RESPONSE_ERROR', 'ZoomMate returned an invalid HTTPS service route.');
  }
  return new URL(`${url.href.replace(/\/$/u, '')}/`);
}
function providerError(payload, status, retryAfter = null) {
  const nativeCode = payload?.status_code ?? payload?.code;
  const code = Number(nativeCode);
  const details = { ...(status ? { status } : {}), ...(nativeCode !== undefined ? { nativeCode } : {}),
    ...(retryAfter !== null ? { retryAfterMs: retryAfter } : {}) };
  if ([30010201, -30010201, 401].includes(code) || status === 401 || nativeCode === 'AUTH_REQUIRED'
      || /token expired|signature has expired/iu.test(payload?.error_message ?? payload?.error ?? '')) {
    return fail('AUTH_REQUIRED', 'ZoomMate authentication was not accepted. Refresh the private cookie export in the browser.', details);
  }
  if (code === 403 || status === 403 || nativeCode === 'FORBIDDEN') return fail('FORBIDDEN', 'ZoomMate denied access to this resource.', details);
  if (code === -32003 || code === 429 || status === 429) return fail('RATE_LIMITED', 'ZoomMate rate limited this operation.', { ...details, retryAfterMs: retryAfter });
  if (code === -32007) return fail('QUOTA_EXCEEDED', 'ZoomMate credits are unavailable.', details);
  if (nativeCode === 'PROVIDER_APPROVAL_REQUIRED') return fail('PROVIDER_APPROVAL_REQUIRED', 'Interactive provider approval is required. No retry attempted.', details);
  return fail(status >= 400 ? 'HTTP_ERROR' : 'PROVIDER_ERROR', 'ZoomMate rejected the operation.', details);
}
function decode(payload, status, login = false, retryAfter = null) {
  if (status >= 400) throw providerError(payload, status, retryAfter);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('UNSUPPORTED_RESPONSE', 'ZoomMate returned an invalid response envelope.');
  if (payload.success === false || payload.error || payload.error_message ||
      (payload.status_code !== undefined && ![0, 200].includes(Number(payload.status_code)))) throw providerError(payload, status, retryAfter);
  if (login && (payload.success !== true || !payload.data)) throw providerError(payload, status, retryAfter);
  if (payload.data?.success === false) throw providerError(payload.data, status, retryAfter);
  return Object.hasOwn(payload, 'data') ? payload.data : payload;
}

export async function openZoomMateTransport({ http, webSocket = url => new WebSocket(url) } = {}) {
  if (!http?.request) throw fail('INVALID_ARGUMENT', 'ZoomMate requires cookie-native HTTP.');
  let closed = false, token, expiresAt = Infinity, base, identity, bootstrapData;
  let socket, handshake, opening, refreshing, sequence = 0, heartbeat, refreshTimer, refreshFailure, refreshRetryAt = 0;
  const lifetime = new AbortController();
  const pending = new Map(), listeners = new Set();
  const notify = event => { for (const listener of listeners) listener(event); };
  async function httpResponse(url, options = {}) {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(25000), ...(options.signal ? [options.signal] : [])]);
    if (signal.aborted) throw notSent();
    let response;
    try { response = await http.request(url, { ...options, signal }); }
    catch (error) {
      if (options.signal?.aborted) throw fail('REQUEST_CANCELLED', 'The HTTP operation was interrupted.', { outcome: options.method === 'POST' ? 'unknown' : 'cancelled' });
      throw error instanceof AppError ? error : fail('REQUEST_FAILED', 'ZoomMate HTTP failed.');
    }
    return response;
  }
  async function httpJson(url, options = {}) {
    const response = await httpResponse(url, options);
    let payload;
    try { payload = await response.json(); }
    catch {
      if (response.status >= 400) throw providerError(undefined, response.status, retryAfterMs(response.headers.get('retry-after')));
      throw fail('UNSUPPORTED_RESPONSE', 'ZoomMate returned a non-JSON response.', { status: response.status });
    }
    return { payload, status: response.status, retryAfter: retryAfterMs(response.headers.get('retry-after')) };
  }
  async function mint(signal) {
    const response = await httpResponse('https://zoom.us/nws/common/2.0/nak?pms=AICW%2CUser%3ABase&src=aicw', {
      signal, headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    const candidate = (await response.text()).trim();
    let payload;
    try { payload = JSON.parse(candidate); } catch { /* Successful mint returns plain JWT text. */ }
    const nativeCode = payload?.status_code ?? payload?.code;
    if (response.status >= 400 || payload?.success === false || payload?.error || payload?.error_message
        || (nativeCode !== undefined && ![0, 200].includes(Number(nativeCode)))) {
      throw providerError(payload, response.status, retryAfterMs(response.headers.get('retry-after')));
    }
    let claims;
    try {
      const parts = candidate.split('.');
      if (parts.length !== 3) throw new Error();
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (!Number.isFinite(claims.exp * 1000) || typeof claims.exp !== 'number') throw new Error();
    } catch { throw fail('AUTH_RESPONSE_ERROR', 'Zoom did not issue a scoped JWT with a usable expiry.'); }
    const expiry = claims.exp * 1000;
    if (expiry <= Date.now()) throw fail('AUTH_REQUIRED', 'Zoom issued an expired service credential. No stale credential was reused.');
    return { token: candidate, expiresAt: expiry };
  }
  async function bootstrap(signal) {
    const minted = await mint(signal);
    const result = await httpJson('https://ai.zoom.us/ai-computer/api/v1/login/?continue=https%3A%2F%2Fzoommate.zoom.us%2F', {
      signal, headers: { authorization: `Bearer ${minted.token}` },
    });
    const data = decode(result.payload, result.status, true, result.retryAfter), nextIdentity = identityOf(data);
    if (identity && (identity.user.userId !== nextIdentity.user.userId || identity.user.accountId !== nextIdentity.user.accountId)) {
      throw fail('TENANT_MISMATCH', 'Refreshed ZoomMate credentials identify another actor or account. Nothing was replayed.');
    }
    const nextBase = route(data.api_root);
    if (data.nak !== minted.token) throw fail('AUTH_RESPONSE_ERROR', 'ZoomMate bootstrap did not confirm the scoped service credential.');
    const nextExpiry = minted.expiresAt;
    if (nextExpiry <= Date.now()) throw fail('AUTH_REQUIRED', 'ZoomMate returned an expired service credential. No stale credential was reused.');
    if (closed) throw fail('SESSION_CLOSED', 'ZoomMate is closed.');
    token = data.nak; base = nextBase; identity = nextIdentity; bootstrapData = sanitize(data);
    expiresAt = nextExpiry;
  }
  const refresh = signal => {
    if (refreshing) return refreshing;
    clearTimeout(refreshTimer);
    const recoverySignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    return refreshing = recoverSafeRead(() => bootstrap(recoverySignal), { signal: recoverySignal, maxAttempts: 3 }).then(() => {
      refreshFailure = undefined;
      // Renew the in-memory working token; the original browser-cookie export is immutable.
      const delay = Math.max(1000, Math.min(2_147_483_647, expiresAt - Date.now() - 60000));
      refreshTimer = setTimeout(() => { void refresh().catch(() => {}); }, delay);
      refreshTimer.unref();
    }).catch(error => {
      if (!closed && !recoverySignal.aborted && error.code !== 'REQUEST_CANCELLED') {
        refreshFailure = error;
        refreshRetryAt = Date.now() + Math.max(0, error.details?.retryAfterMs ?? 0);
        if (socket) socket.terminate();
        else notify({ method: 'transport.disconnected', params: { code: error.code } });
      }
      throw error;
    }).finally(() => { refreshing = undefined; });
  };
  const recoverableRefreshFailure = error => error?.code === 'REQUEST_FAILED' || error?.code === 'RATE_LIMITED'
    || (error?.code === 'HTTP_ERROR' && (error.details?.status === 408 || error.details?.status >= 500));
  async function ensureAuth(signal) {
    if (refreshing) await refreshing;
    if (refreshFailure && (!recoverableRefreshFailure(refreshFailure) || Date.now() < refreshRetryAt)) throw refreshFailure;
    if (refreshFailure || Date.now() + 30000 >= expiresAt) await refresh(signal);
  }
  await refresh();
  async function authenticatedRead(perform, method, signal) {
    try { return await perform(); }
    catch (error) {
      if (error.code !== 'AUTH_REQUIRED' || method !== 'GET') throw error;
      const rejectedToken = token;
      await refresh(signal);
      if (token === rejectedToken) throw error;
      return perform();
    }
  }
  async function openDocs({ signal } = {}) {
    // The native Docs iframe uses the same hn()/auth.token callback as ZoomMate,
    // not a second cookie acquisition or the agent WebSocket ticket.
    let docsClosed = false, docsBase = new URL('https://docs.zoom.us/');
    const docsRequest = async (path, { method = 'GET', body, base: requestedBase, signal: requestSignal = signal } = {}) => {
      if (closed || docsClosed) throw fail('SESSION_CLOSED', 'The document session is closed.');
      if (typeof path !== 'string' || !path.startsWith('/api/') || /[\\#]/u.test(path)) throw fail('INVALID_ARGUMENT', 'Use a relative Docs API path.');
      let url;
      try { url = new URL(path, requestedBase ?? docsBase); } catch { /* rejected below */ }
      if (!url || url.protocol !== 'https:' || !/^(?:[a-z0-9-]+)?docs\.zoom\.us$/u.test(url.hostname)
          || url.username || url.password || url.port || !url.pathname.startsWith('/api/')) {
        throw fail('INVALID_ARGUMENT', 'The document credential is restricted to native HTTPS Docs API routes.');
      }
      method = String(method).toUpperCase();
      if (!['GET', 'POST', 'PUT'].includes(method)) throw fail('INVALID_ARGUMENT', 'Unsupported document HTTP method.');
      let serialized;
      try { serialized = body === undefined ? undefined : JSON.stringify(body); }
      catch { throw fail('INVALID_INPUT', 'Invalid document JSON request body.'); }
      try { await ensureAuth(requestSignal); }
      catch (error) { throw fail(error.code, error.message, { ...error.details, outcome: 'not_sent' }); }
      return authenticatedRead(async () => {
        const result = await httpJson(url.href, { method, body: serialized, signal: requestSignal,
          headers: { authorization: `Bearer ${token}`, ...(serialized === undefined ? {} : { 'content-type': 'application/json' }) } });
        if (result.status >= 400) throw providerError(result.payload, result.status, result.retryAfter);
        // Docs has a raw response contract; its "data" field is not an AICW envelope.
        return result.payload;
      }, method, requestSignal);
    };
    const docsIdentity = await docsRequest('/api/user/me');
    if (docsIdentity.user?.userId !== identity.user.userId || docsIdentity.user?.accountId !== identity.user.accountId) {
      throw fail('TENANT_MISMATCH', 'The document service identifies a different actor or account. Nothing was written.');
    }
    docsBase = route(docsIdentity.homeClusterApiPrefix);
    return {
      get identity() { return { user: { ...identity.user } }; },
      request: docsRequest,
      close() { docsClosed = true; },
    };
  }
  async function request(path, { method = 'GET', body, signal } = {}) {
    if (closed) throw fail('SESSION_CLOSED', 'ZoomMate is closed.');
    if (signal?.aborted) throw notSent();
    if (typeof path !== 'string' || !/^\/api\//u.test(path) || /[\\#]/u.test(path)) throw fail('INVALID_ARGUMENT', 'Use a relative ZoomMate API path.');
    method = method.toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw fail('INVALID_ARGUMENT', 'Unsupported ZoomMate HTTP method.');
    let serialized;
    try { serialized = body === undefined ? undefined : JSON.stringify(body); } catch { throw fail('INVALID_INPUT', 'Invalid JSON request body.'); }
    try { await ensureAuth(signal); }
    catch (error) { throw fail(error.code, error.message, { ...error.details, outcome: 'not_sent' }); }
    const perform = async () => {
      const url = new URL(path.slice(1), base);
      if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}api/`)) throw fail('INVALID_ARGUMENT', 'Invalid ZoomMate API path.');
      const result = await httpJson(url.href, { method, body: serialized, signal,
        headers: { authorization: `Bearer ${token}`, ...(serialized === undefined ? {} : { 'content-type': 'application/json' }) } });
      return decode(result.payload, result.status, false, result.retryAfter);
    };
    return authenticatedRead(perform, method, signal);
  }
  function rejectPending() { for (const item of [...pending.values()]) item.finish(unknown()); }
  function disconnect(channel) {
    if (channel !== socket) return;
    clearInterval(heartbeat); heartbeat = undefined;
    socket = undefined; handshake = undefined;
    rejectPending();
    if (!closed) notify({ method: 'transport.disconnected', params: {} });
  }
  function receive(raw) {
    let message;
    try { message = JSON.parse(String(raw)); }
    catch { socket?.terminate(); return; }
    if (!message || message.jsonrpc !== '2.0') return;
    if (Object.hasOwn(message, 'id')) {
      const item = pending.get(String(message.id));
      if (item) item.finish(message.error ? providerError(message.error) : null, message.result);
    } else if (typeof message.method === 'string') {
      try { notify({ method: message.method, params: message.params ?? {} }); }
      catch { socket?.terminate(); }
    }
  }
  async function send(method, params = {}, { signal, timeoutMs = 15000 } = {}) {
    if (closed) return Promise.reject(fail('SESSION_CLOSED', 'ZoomMate is closed.', { outcome: 'not_sent' }));
    if (signal?.aborted) return Promise.reject(notSent());
    try { await ensureAuth(signal); }
    catch (error) { throw fail(error.code, error.message, { ...error.details, outcome: 'not_sent' }); }
    if (signal?.aborted) throw notSent();
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(fail('REQUEST_FAILED', 'ZoomMate is disconnected.', { outcome: 'not_sent' }));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(fail('INVALID_INPUT', 'A positive RPC timeout is required.'));
    const id = String(++sequence);
    let frame;
    try { frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }); } catch { return Promise.reject(fail('INVALID_INPUT', 'Invalid RPC parameters.', { outcome: 'not_sent' })); }
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        if (!pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(result);
      };
      const onAbort = () => finish(unknown());
      const timer = setTimeout(() => finish(unknown()), timeoutMs);
      pending.set(id, { finish }); signal?.addEventListener('abort', onAbort, { once: true });
      try { socket.send(frame, error => { if (error) finish(unknown()); }); }
      catch { finish(unknown()); }
    });
  }
  async function connect({ signal } = {}) {
    if (closed) throw fail('SESSION_CLOSED', 'ZoomMate is closed.');
    if (signal?.aborted) throw notSent();
    await ensureAuth(signal);
    if (handshake && socket?.readyState === WebSocket.OPEN) return handshake;
    if (opening) return opening;
    opening = (async () => {
      const ticket = await request('/api/v3/ws-ticket', { method: 'POST', signal });
      if (typeof ticket?.ticket !== 'string' || !ticket.ticket) throw fail('AUTH_RESPONSE_ERROR', 'ZoomMate did not issue a socket ticket.');
      if (closed || signal?.aborted) throw notSent();
      const url = new URL('api/v3/agent', base); url.protocol = 'wss:';
      url.searchParams.set('ticket', ticket.ticket);
      if (bootstrapData.synora_cluster) url.searchParams.set('cluster', bootstrapData.synora_cluster);
      url.searchParams.set('aid', identity.user.accountId);
      const channel = webSocket(url.href); socket = channel;
      channel.on('message', receive);
      channel.on('error', () => disconnect(channel)); channel.on('close', () => disconnect(channel));
      try {
        await new Promise((resolve, reject) => {
          const settle = error => { clearTimeout(timer); channel.removeListener('open', onOpen); channel.removeListener('close', onClose); channel.removeListener('error', onError); signal?.removeEventListener('abort', onAbort); error ? reject(error) : resolve(); };
          const onOpen = () => settle();
          const onClose = () => settle(fail('REQUEST_FAILED', 'ZoomMate socket closed during connection.'));
          const onError = () => settle(fail('REQUEST_FAILED', 'ZoomMate socket connection failed.'));
          const onAbort = () => { settle(notSent()); channel.terminate(); };
          const timer = setTimeout(() => { settle(fail('REQUEST_TIMEOUT', 'ZoomMate socket connection timed out.')); channel.terminate(); }, 10000);
          channel.once('open', onOpen); channel.once('error', onError); channel.once('close', onClose);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        handshake = await send('session.start', { client_info: {} }, { signal });
        if (!handshake?.connection_id || !handshake.capabilities) throw fail('UNSUPPORTED_RESPONSE', 'ZoomMate did not confirm the session handshake.');
        heartbeat = setInterval(() => {
          void send('ping', { timestamp: Date.now() }, { timeoutMs: 10000 }).catch(() => channel.terminate());
        }, 30000);
        heartbeat.unref();
        return handshake;
      } catch (error) { channel.terminate(); disconnect(channel); throw error; }
    })().finally(() => { opening = undefined; });
    return opening;
  }
  return {
    get identity() { return structuredClone(identity); },
    get bootstrap() { return structuredClone(bootstrapData); },
    request, connect, send, openDocs,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() {
      if (closed) return;
      closed = true; lifetime.abort(); clearTimeout(refreshTimer); clearInterval(heartbeat); rejectPending(); listeners.clear();
      const channel = socket; socket = undefined; handshake = undefined; token = undefined;
      channel?.terminate();
    },
  };
}
