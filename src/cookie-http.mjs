import { readFile } from 'node:fs/promises';
import { CookieJar } from 'tough-cookie';
import { AppError } from './session.mjs';

function target(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || (url.hostname !== 'zoom.us' && !url.hostname.endsWith('.zoom.us'))
    || url.username || url.password || (url.port && url.port !== '443')) {
    throw new AppError('INVALID_ARGUMENT', 'Cookie HTTP targets must be HTTPS Zoom hosts.');
  }
  return url;
}

export async function createCookieHttp(path) {
  const jar = new CookieJar();
  let cookies;
  try {
    cookies = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(cookies) || !cookies.length) throw new Error();
    for (const cookie of cookies) {
      if (!cookie || typeof cookie.domain !== 'string' || typeof cookie.name !== 'string' || typeof cookie.value !== 'string'
        || /[\s;=\r\n]/.test(cookie.name) || /[;\r\n]/.test(cookie.value)) throw new Error();
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      const origin = target(`https://${domain}/`);
      // Cached service credentials are not bootstrap inputs. Partitioned cookies cannot be widened into an unpartitioned jar.
      if (cookie.name === '_zm_docs_nak' || cookie.partitionKey) continue;
      if (cookie.expires > 0 && cookie.expires * 1000 <= Date.now()) continue;
      const parts = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path || '/'}`];
      if (cookie.domain.startsWith('.')) parts.push(`Domain=${domain}`);
      if (cookie.secure) parts.push('Secure');
      if (cookie.httpOnly) parts.push('HttpOnly');
      if (['strict', 'lax', 'none'].includes(cookie.sameSite?.toLowerCase())) parts.push(`SameSite=${cookie.sameSite}`);
      if (cookie.expires > 0) parts.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`);
      await jar.setCookie(parts.join('; '), origin.href);
    }
  } catch { throw new AppError('COOKIE_FILE_ERROR', 'Supply a valid exported Zoom cookie JSON array.'); }
  cookies = undefined;
  let closed = false;
  return {
    async cookieHeader(url) { return jar.getCookieString(target(url).href); },
    async close() {
      closed = true;
      await jar.removeAllCookies();
    },
    async request(value, options = {}) {
      if (closed) throw new AppError('SESSION_CLOSED', 'Cookie HTTP session is closed.');
      let url = target(value), headers = new Headers(options.headers);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (headers.has('cookie')) throw new AppError('INVALID_ARGUMENT', 'Cookie headers are supplied by the scoped jar, not callers.');
      const signal = options.signal ?? AbortSignal.timeout(25000);
      for (let redirects = 0; ; redirects++) {
        const requestHeaders = new Headers(headers);
        if (options.credentials !== 'omit') {
          const cookie = await jar.getCookieString(url.href);
          if (cookie) requestHeaders.set('cookie', cookie);
        }
        let response;
        try { response = await fetch(url, { ...options, method, headers: requestHeaders, redirect: 'manual', signal }); }
        catch { throw new AppError('REQUEST_FAILED', 'Standalone HTTP failed or timed out.'); }
        if (response.headers.get('cf-mitigated') === 'challenge') {
          await response.body?.cancel();
          throw new AppError('PROVIDER_APPROVAL_REQUIRED', 'The provider requires interactive human approval. No bypass or retry attempted.');
        }
        if (options.credentials !== 'omit') {
          for (const cookie of response.headers.getSetCookie()) {
            if (/;\s*partitioned(?:;|$)/i.test(cookie)) continue;
            await jar.setCookie(cookie, url.href, { ignoreError: true });
          }
        }
        if (![301, 302, 303, 307, 308].includes(response.status) || options.redirect !== 'follow') return response;
        if (!['GET', 'HEAD'].includes(method) || redirects >= 4) {
          await response.body?.cancel();
          throw new AppError('UNEXPECTED_REDIRECT', 'Redirect was not followed: writes are never replayed and reads allow at most four redirects.');
        }
        const location = response.headers.get('location');
        if (!location) return response;
        const next = target(new URL(location, url).href);
        if (next.origin !== url.origin) headers = new Headers(headers.has('accept') ? { accept: headers.get('accept') } : {});
        await response.body?.cancel();
        url = next;
      }
    },
  };
}
