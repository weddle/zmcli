import { open } from 'node:fs/promises';
import { once } from 'node:events';

export class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const MAX_RETRY_WAIT_MS = 30000;
const MAX_BACKOFF_MS = 8000;
const MAX_JITTER_MS = 250;
export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  let delay;
  if (/^\d+$/.test(text)) delay = Number(text) * 1000;
  else {
    const deadline = Date.parse(text);
    if (!Number.isFinite(deadline)) return null;
    delay = Math.max(0, deadline - now);
  }
  if (!Number.isSafeInteger(delay) || delay < 0) return null;
  return delay;
}

const abortError = () => new AppError('REQUEST_CANCELLED', 'The operation was cancelled before completion.', { partial: false });
const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return; }
  let timer;
  const cancelled = () => { clearTimeout(timer); reject(abortError()); };
  const complete = () => {
    signal?.removeEventListener('abort', cancelled);
    resolve();
  };
  timer = setTimeout(complete, milliseconds);
  signal?.addEventListener('abort', cancelled, { once: true });
});
export async function recoverSafeRead(operation, {
  remint, sleep = wait, maxAttempts = 3, signal, maxWaitMs = MAX_RETRY_WAIT_MS, random = Math.random,
} = {}) {
  if (typeof operation !== 'function' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3
    || !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0 || typeof random !== 'function') {
    throw new AppError('INVALID_ARGUMENT', 'Safe-read recovery requires one to three bounded attempts and a nonnegative wait budget.');
  }
  let reminted = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw abortError();
    try {
      return await operation(attempt);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      const transient = ['RATE_LIMITED', 'REQUEST_FAILED', 'CHAT_NOT_READY', 'CHAT_INDEX_NOT_READY'].includes(error.code)
        || (error.code === 'HTTP_ERROR' && (error.details?.status === 408 || error.details?.status >= 500));
      if (transient && attempt < maxAttempts) {
        const advertisedDelay = error.code === 'RATE_LIMITED' && error.details?.retryAfterMs !== null
          && error.details?.retryAfterMs !== undefined ? error.details.retryAfterMs : null;
        const baseDelay = advertisedDelay ?? Math.min(1000 * (2 ** (attempt - 1)), MAX_BACKOFF_MS);
        const jitter = advertisedDelay === null ? Math.floor(Math.max(0, Math.min(1, random())) * Math.min(MAX_JITTER_MS, baseDelay / 4)) : 0;
        const delay = baseDelay + jitter;
        if (!Number.isSafeInteger(delay) || delay < 0 || delay > maxWaitMs) {
          throw new AppError(error.code, error.message, {
            ...error.details, attempts: attempt, partial: false, retryDeferred: true, maxWaitMs,
          });
        }
        await sleep(delay, signal);
        continue;
      }
      if (['AUTH_REQUIRED', 'CHAT_CREDENTIAL_EXPIRED'].includes(error.code) && remint && !reminted && attempt < maxAttempts) {
        reminted = true;
        try { await remint(); }
        catch (mintError) {
          if (mintError instanceof AppError && ['AUTH_REQUIRED', 'CHAT_CREDENTIAL_EXPIRED'].includes(mintError.code)) {
            throw new AppError('REAUTHENTICATION_REQUIRED', 'The supplied cookie session could not mint a replacement service credential. Supply a fresh private cookie export; no write was replayed.',
              { attempts: attempt, partial: false });
          }
          throw mintError;
        }
        continue;
      }
      if (['AUTH_REQUIRED', 'CHAT_CREDENTIAL_EXPIRED'].includes(error.code)) {
        throw new AppError('REAUTHENTICATION_REQUIRED', 'Service authentication remained expired after bounded credential renewal. Supply a fresh private cookie export; no write was replayed.',
          { attempts: attempt, partial: false });
      }
      if (transient) {
        throw new AppError(error.code, error.message, { ...error.details, attempts: attempt, partial: false, retryExhausted: true });
      }
      throw error;
    }
  }
  throw new AppError('RECOVERY_EXHAUSTED', 'Safe-read recovery exhausted its bounded attempts.', { attempts: maxAttempts, partial: false });
}

export function writeFailure(error, context, outcome) {
  const cause = error instanceof AppError
    ? error.details?.cause ?? { code: error.code, message: error.message }
    : { code: 'INTERNAL_ERROR', message: 'Unexpected local failure while reconciling the operation.', type: error instanceof TypeError ? 'TypeError' : 'Error' };
  const rejected = ['FORBIDDEN', 'AUTH_REQUIRED', 'RATE_LIMITED', 'CHAT_SERVICE_ERROR'].includes(cause.code)
    || (cause.code === 'HTTP_ERROR' && error.details?.status >= 400 && error.details.status < 500);
  outcome ??= error instanceof AppError ? error.details?.outcome : undefined;
  outcome ??= ['CHAT_NOT_READY', 'SESSION_CLOSED', 'INVALID_INPUT', 'INVALID_ARGUMENT'].includes(cause.code)
    ? 'not_sent' : rejected ? 'rejected' : 'unknown';
  return new AppError(outcome === 'unknown' ? 'WRITE_UNCONFIRMED' : cause.code,
    outcome === 'unknown' ? 'Write outcome is uncertain. Reconcile the recorded IDs before retrying; no automatic resend was attempted.' : cause.message,
    { ...(error instanceof AppError ? error.details : {}), ...context, outcome, cause });
}

const failure = (code, message, details) => new AppError(code, message, details);
const loopback = hostname => ['127.0.0.1', '[::1]', 'localhost'].includes(hostname);
const zoomHost = hostname => hostname.endsWith('.zoom.us');
function zoomUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('INVALID_ARGUMENT', 'An HTTPS Zoom URL is required.'); }
  if (url.protocol !== 'https:' || !zoomHost(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw failure('INVALID_ARGUMENT', 'Only HTTPS subdomains of zoom.us are allowed.');
  }
  return url;
}
function endpointUrl(value, websocket = false) {
  let url;
  try { url = new URL(value); } catch { throw failure('INVALID_ARGUMENT', 'A loopback CDP endpoint is required.'); }
  if (url.protocol !== (websocket ? 'ws:' : 'http:') || !loopback(url.hostname) || url.username || url.password || url.search || url.hash || (!websocket && url.pathname !== '/')) {
    throw failure('INVALID_ARGUMENT', 'CDP must use an HTTP loopback endpoint without credentials.');
  }
  return url;
}

export async function connectCdp(endpoint) {
  let socket;
  try {
    const url = endpointUrl(endpoint);
    const response = await fetch(new URL('/json/version', url), { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw failure('CDP_UNAVAILABLE', 'Browser debugging endpoint is unavailable.');
    const version = await response.json();
    socket = new WebSocket(endpointUrl(version.webSocketDebuggerUrl, true));
  } catch (error) {
    throw error instanceof AppError ? error : failure('CDP_UNAVAILABLE', 'Cannot connect to the local browser debugging endpoint.');
  }
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Set();
  const fail = () => {
    closed = true;
    for (const item of pending.values()) item.reject(failure('CDP_CLOSED', 'Browser connection closed.'));
    pending.clear();
    listeners.clear();
  };
  socket.addEventListener('close', fail);
  socket.addEventListener('error', () => { fail(); socket.close(); });
  socket.addEventListener('message', ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { fail(); socket.close(); return; }
    if (message.id) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      if (message.error) item.reject(failure('BROWSER_ERROR', 'The browser could not complete the requested operation.'));
      else item.resolve(message.result);
    } else {
      for (const listener of listeners) listener(message);
    }
  });
  try { await once(socket, 'open', { signal: AbortSignal.timeout(5000) }); }
  catch { socket.close(); fail(); throw failure('CDP_UNAVAILABLE', 'Cannot open the local browser debugging connection.'); }
  return {
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { fail(); socket.close(); },
    call(method, params = {}, sessionId, timeout = 10000) {
      if (closed || socket.readyState !== WebSocket.OPEN) return Promise.reject(failure('CDP_CLOSED', 'Browser connection closed.'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(failure('BROWSER_TIMEOUT', 'The browser operation timed out.'));
        }, timeout);
        pending.set(id, {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch { pending.get(id).reject(failure('CDP_CLOSED', 'Browser connection closed.')); pending.delete(id); }
      });
    },
  };
}

function statusError(response) {
  if (response.status === 401) return failure('AUTH_REQUIRED', 'The supplied cookie session or service credential is not accepted.');
  if (response.status === 403) return failure('FORBIDDEN', 'The signed-in user does not have permission for this operation.');
  if (response.status === 429) return failure('RATE_LIMITED', 'Zoom rate limited this operation.', {
    retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
  });
  return failure('HTTP_ERROR', 'Zoom could not complete the operation.', { status: response.status });
}
function safeIdentity(value) {
  const userKeys = ['userId', 'accountId', 'email', 'displayName', 'avatarUrl', 'timezone', 'userType', 'locale', 'dateFormat', 'using24HourTimeFormat'];
  const accountKeys = ['accountId', 'name', 'isPersonalAccount', 'isMany', 'type'];
  const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
  return { user: pick(value.user, userKeys), account: pick(value.account, accountKeys), homeClusterApiPrefix: value.homeClusterApiPrefix, clusterId: value.clusterId };
}

export async function exportBrowserCookies({ cdp = 'http://127.0.0.1:9222', out }) {
  if (typeof out !== 'string' || !out || out === '-' || out.startsWith('/dev/') || out.startsWith('/proc/')) {
    throw failure('INVALID_ARGUMENT', 'Supply a private cookie file path, not standard output.');
  }
  const connection = await connectCdp(cdp);
  let file;
  try {
    const result = await connection.call('Storage.getCookies');
    const cookies = result.cookies.filter(cookie => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      return domain === 'zoom.us' || zoomHost(domain);
    });
    file = await open(out, 'wx', 0o600);
    await file.writeFile(JSON.stringify(cookies), 'utf8');
    return { exported: true };
  } catch (error) {
    throw error instanceof AppError ? error : failure('COOKIE_EXPORT_ERROR', 'Cannot create the private cookie file. Its parent must exist and destination must not already exist.');
  } finally {
    await file?.close().catch(() => {});
    connection.close();
  }
}

export async function connectSession({ cookies, service = 'docs' } = {}) {
  if (!['docs', 'chat', 'zoommate'].includes(service)) throw failure('INVALID_ARGUMENT', 'Session service must be docs, chat, or zoommate.');
  if (typeof cookies !== 'string' || !cookies) throw failure('COOKIE_REQUIRED', 'Supply --cookies PATH. Browser cookie acquisition is an explicit auth export operation.');
  const { createCookieHttp } = await import('./cookie-http.mjs');
  const http = await createCookieHttp(cookies);
  if (service === 'zoommate') {
    let zoommate;
    try {
      const { openZoomMateTransport } = await import('./zoommate-transport.mjs');
      zoommate = await openZoomMateTransport({ http });
      return {
        get identity() { return zoommate.identity; },
        close: async () => { zoommate.close(); await http.close(); },
        async openZoomMate() {
          if (!zoommate) throw failure('SESSION_CLOSED', 'The session is closed.');
          return zoommate;
        },
      };
    } catch (error) {
      await http.close();
      throw error instanceof AppError ? error : failure('SESSION_ERROR', 'Cookie-only session initialization failed.');
    }
  }
  let closed = false, chat, token, expiresAt = 0, identity, apiBase, refreshing;
  const close = async () => {
    if (closed) return;
    closed = true; token = undefined;
    await chat?.dispose();
    await http.close();
  };
  const json = async (url, options) => {
    const response = await http.request(url, options);
    if (!response.ok) throw statusError(response);
    try { return await response.json(); }
    catch { throw failure('RESPONSE_ERROR', 'Zoom returned a successful response that was not JSON.'); }
  };
  const mint = async () => {
    const response = await http.request('https://docs.zoom.us/nws/common/2.0/nak?pms=Docs%2CUser%3ABase%2CAICW&src=aicw',
      { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!response.ok) throw statusError(response);
    const candidate = (await response.text()).trim();
    let claims;
    try {
      if (candidate.split('.').length !== 3) throw new Error();
      claims = JSON.parse(Buffer.from(candidate.split('.')[1], 'base64url').toString('utf8'));
      if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) throw new Error();
    } catch { throw failure('AUTH_RESPONSE_ERROR', 'Docs credential issuance did not return an unexpired native JWT.'); }
    // JWT claims schedule re-minting only. First-party identity, not decoded claims, determines the actor and routing.
    const result = await json('https://docs.zoom.us/api/user/me', { headers: { authorization: `Bearer ${candidate}` } });
    if (!result.user?.userId || !result.user?.accountId || typeof result.homeClusterApiPrefix !== 'string') {
      throw failure('AUTH_RESPONSE_ERROR', 'Docs identity or home-cluster routing is missing.');
    }
    if (identity && (identity.user.userId !== result.user.userId || identity.user.accountId !== result.user.accountId)) {
      throw failure('TENANT_MISMATCH', 'Re-minted Docs credentials identify a different actor or account. Nothing was replayed.');
    }
    apiBase = zoomUrl(result.homeClusterApiPrefix);
    identity = safeIdentity(result); token = candidate; expiresAt = claims.exp * 1000;
  };
  const refresh = () => refreshing ??= mint().finally(() => { refreshing = undefined; });
  try {
    if (service === 'chat') {
      const { openChatTransport } = await import('./chat-transport.mjs');
      chat = await openChatTransport({ http });
      identity = chat.identity;
    } else {
      await recoverSafeRead(() => refresh());
    }
    return {
      get identity() { return identity; },
      close,
      async openChat() {
        if (closed) throw failure('SESSION_CLOSED', 'The session is closed.');
        if (!chat) throw failure('INVALID_ARGUMENT', 'Chat operations require a Chat session.');
        return chat;
      },
      async request(path, { method = 'GET', body, base, safeRead = false, signal } = {}) {
        if (closed) throw failure('SESSION_CLOSED', 'The session is closed.');
        if (service !== 'docs') throw failure('INVALID_ARGUMENT', 'Docs requests require a Docs session.');
        let url;
        try { url = zoomUrl(new URL(path, base ? zoomUrl(base) : apiBase).href); }
        catch { throw failure('INVALID_ARGUMENT', 'Only HTTPS Zoom API targets are allowed.'); }
        method = String(method).toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) throw failure('INVALID_ARGUMENT', 'Unsupported HTTP method.');
        let serialized;
        try { serialized = body === undefined ? undefined : JSON.stringify(body); }
        catch { throw failure('INVALID_ARGUMENT', 'Request body must be JSON serializable.'); }
        if (expiresAt <= Date.now() + 60000) {
          try { await recoverSafeRead(() => refresh(), { signal }); }
          catch (error) {
            throw failure(error.code ?? 'AUTH_REQUIRED', error.message, { outcome: 'not_sent' });
          }
          if (!base) url = zoomUrl(new URL(path, apiBase).href);
        }
        const perform = () => json(url.href, { method, body: serialized, signal,
          headers: { authorization: `Bearer ${token}`, ...(serialized === undefined ? {} : { 'content-type': 'application/json' }) } });
        return ['GET', 'HEAD'].includes(method) || safeRead
          ? recoverSafeRead(perform, { remint: () => recoverSafeRead(() => refresh(), { signal }), signal })
          : perform();
      },
    };
  } catch (error) {
    await close();
    throw error instanceof AppError ? error : failure('SESSION_ERROR', 'Cookie-only session initialization failed.');
  }
}
