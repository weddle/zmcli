import { createReadStream, fstat as fstatCallback } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { AppError, connectCdp } from './session.mjs';

const fstat = promisify(fstatCallback);

const fail = (code, message, details) => new AppError(code, message, details);
const zoomHost = hostname => hostname === 'zoom.us' || hostname.endsWith('.zoom.us');
const LOGIN_URL = 'https://zoom.us/signin#/login';
const AUTH_COOKIE_NAMES = new Set(['_zm_ssid', 'cred', 'zm_aid']);

function outputPath(path) {
  if (typeof path !== 'string' || !path || path === '-' || path.startsWith('/dev/') || path.startsWith('/proc/')) {
    throw fail('INVALID_INPUT', 'Supply --output-cookie-file as a new private file path, not standard output or a device path.');
  }
  return path;
}

function descriptor(value, name) {
  const fd = Number(value);
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 1024) {
    throw fail('INVALID_INPUT', `${name} must identify an explicitly opened descriptor from 3 through 1024.`);
  }
  return fd;
}

async function readProtectedDescriptor(fd, label) {
  let stat;
  try { stat = await fstat(fd); } catch { throw fail('AUTH_INPUT_REQUIRED', `Cannot read the protected ${label} descriptor.`); }
  if (stat.isFile() || (!stat.isFIFO() && !stat.isSocket() && !stat.isCharacterDevice())) {
    throw fail('UNSAFE_CREDENTIAL_SOURCE', `The ${label} descriptor must be a pipe, socket, or terminal, not a regular file.`);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const stream = createReadStream(null, { fd, autoClose: false });
    stream.on('data', chunk => {
      length += chunk.length;
      if (length > 4096) {
        stream.destroy();
        reject(fail('INVALID_INPUT', `The ${label} value exceeds the local bound.`));
      } else chunks.push(chunk);
    });
    stream.on('error', () => reject(fail('AUTH_INPUT_REQUIRED', `Cannot read the protected ${label} descriptor.`)));
    stream.on('end', () => {
      const value = Buffer.concat(chunks);
      let end = value.length;
      while (end && (value[end - 1] === 10 || value[end - 1] === 13)) end--;
      if (!end || value.subarray(0, end).includes(0) || value.subarray(0, end).includes(10) || value.subarray(0, end).includes(13)) {
        value.fill(0);
        reject(fail('INVALID_INPUT', `The ${label} descriptor must contain one nonempty line.`));
        return;
      }
      resolve(value.subarray(0, end));
    });
  });
}

const stateExpression = `(() => {
  const visible = selector => Array.from(document.querySelectorAll(selector)).some(element => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  });
  const text = (document.body?.innerText || '').slice(0, 12000).toLowerCase();
  const url = location.href;
  const hasUsername = visible('input[type="email"], input[name="email"], input[name="username"], input[name="account"]');
  const hasPassword = visible('input[type="password"]');
  const signInPhonePrompt = location.hash.toLowerCase().includes('/bind-signin-phone')
    || /add sign-in phone number|link your phone number for easy sign-in/.test(text);
  const canSkipPhone = signInPhonePrompt && /skip for now and sign in/.test(text);
  const blockingCaptcha = visible('iframe[src*="/bframe"], iframe[title*="challenge"], [role="dialog"] [class*="captcha"], [role="dialog"] [id*="captcha"], [data-testid*="captcha"]')
    || /verify you are human|select all images|complete the captcha|security check/.test(text);
  let challenge = null;
  if (blockingCaptcha) challenge = 'captcha';
  else if (!signInPhonePrompt && (visible('input[autocomplete="one-time-code"], input[name*="otp"], input[name*="code"]')
    || (!hasUsername && !hasPassword && /two-factor|multi-factor|authenticator code/.test(text)))) challenge = 'mfa';
  else if (location.pathname.toLowerCase().includes('/sso')
    || (!hasUsername && !hasPassword && /single sign-on required|continue with sso/.test(text))) challenge = 'sso';
  return { url, hasUsername, hasPassword, canSkipPhone, challenge };
})()`;

async function pageState(connection, sessionId) {
  const result = await connection.call('Runtime.evaluate', { expression: stateExpression, returnByValue: true }, sessionId);
  return result?.result?.value ?? {};
}

async function waitFor(connection, sessionId, predicate, timeoutMs, sleep) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await pageState(connection, sessionId);
    if (state.challenge || predicate(state)) return state;
    await sleep(200);
  }
  throw fail('AUTH_TIMEOUT', 'The authorized browser login did not reach the required state before the bounded timeout.', {
    operation: 'auth.acquire', phase: 'browser-login', outcome: 'not_acquired', retryable: true,
  });
}

function interactionError(challenge) {
  const code = challenge === 'sso' ? 'AUTH_METHOD_UNSUPPORTED' : 'AUTH_INTERACTION_REQUIRED';
  const message = challenge === 'sso'
    ? 'The account requires SSO. Complete an explicitly authorized first-party browser sign-in, then use auth export.'
    : `The first-party login requires ${challenge === 'mfa' ? 'MFA' : 'CAPTCHA'} interaction. Complete it in an explicitly authorized browser, then use auth export.`;
  return fail(code, message, { operation: 'auth.acquire', phase: challenge, outcome: 'not_acquired', fallback: 'explicit-auth-export' });
}

async function documentObject(connection, sessionId) {
  const result = await connection.call('Runtime.evaluate', { expression: 'document' }, sessionId);
  const objectId = result?.result?.objectId;
  if (!objectId) throw fail('AUTH_REQUIRED', 'The first-party login form is unavailable.');
  return objectId;
}

async function submitUsername(connection, sessionId, username) {
  const objectId = await documentObject(connection, sessionId);
  return connection.call('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function (value) {
      const visible = element => {
        const box = element?.getBoundingClientRect();
        const style = element && getComputedStyle(element);
        return box?.width > 0 && box?.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const input = Array.from(this.querySelectorAll('input[type="email"], input[name="email"], input[name="username"], input[name="account"]')).find(visible);
      const submit = this.querySelector('#signin_btn_next, [data-testid="account-next-btn"]')
        || Array.from(this.querySelectorAll('button, input[type="submit"]')).find(element => visible(element) && /^(next|continue)$/i.test((element.innerText || element.value || '').trim()));
      if (!input || !submit) return { submitted: false };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      submit.click();
      return { submitted: true };
    }`,
    arguments: [{ value: username }],
    returnByValue: true,
  }, sessionId);
}

async function submitPassword(connection, sessionId, password) {
  const objectId = await documentObject(connection, sessionId);
  return connection.call('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function (value) {
      const visible = element => {
        const box = element?.getBoundingClientRect();
        const style = element && getComputedStyle(element);
        return box?.width > 0 && box?.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const input = Array.from(this.querySelectorAll('input[type="password"]')).find(visible);
      const submit = this.querySelector('#signin_btn, [data-testid="password-signin-btn"], button[type="submit"], input[type="submit"]')
        || Array.from(this.querySelectorAll('button')).find(element => visible(element) && /^(sign in|continue|next)$/i.test((element.innerText || '').trim()));
      if (!input || !submit) return { submitted: false };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      submit.click();
      return { submitted: true };
    }`,
    arguments: [{ value: password }],
    returnByValue: true,
  }, sessionId);
}

async function submitCombinedCredentials(connection, sessionId, username, password) {
  const objectId = await documentObject(connection, sessionId);
  return connection.call('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function (username, password) {
      const visible = element => {
        const box = element?.getBoundingClientRect();
        const style = element && getComputedStyle(element);
        return box?.width > 0 && box?.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const user = Array.from(this.querySelectorAll('input[type="email"], input[name="email"], input[name="username"], input[name="account"]')).find(visible);
      const pass = Array.from(this.querySelectorAll('input[type="password"]')).find(visible);
      const submit = this.querySelector('#signin_btn, [data-testid="password-signin-btn"], button[type="submit"], input[type="submit"]')
        || Array.from(this.querySelectorAll('button')).find(element => visible(element) && /^(sign in|continue)$/i.test((element.innerText || '').trim()));
      if (!user || !pass || !submit) return { submitted: false };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const [input, value] of [[user, username], [pass, password]]) {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      submit.click();
      return { submitted: true };
    }`,
    arguments: [{ value: username }, { value: password }],
    returnByValue: true,
  }, sessionId);
}

async function skipSignInPhone(connection, sessionId) {
  const objectId = await documentObject(connection, sessionId);
  return connection.call('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function () {
      const submit = Array.from(this.querySelectorAll('button')).find(element => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
          && /^skip for now and sign in$/i.test((element.innerText || '').trim());
      });
      if (!submit) return { submitted: false };
      submit.click();
      return { submitted: true };
    }`,
    arguments: [],
    returnByValue: true,
  }, sessionId);
}


export async function acquirePasswordBrowserCookies(options, dependencies = {}) {
  if (options?.method !== 'password-browser') throw fail('INVALID_INPUT', 'Select --method password-browser explicitly.');
  const out = outputPath(options.outputCookieFile);
  const usernameFd = descriptor(options.usernameFd, '--username-fd');
  const passwordFd = descriptor(options.passwordFd, '--password-fd');
  if (usernameFd === passwordFd) throw fail('INVALID_INPUT', 'Username and password require distinct protected descriptors.');
  const timeoutMs = Number(options.timeoutMs ?? 120000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10000 || timeoutMs > 300000) throw fail('INVALID_INPUT', 'Use --timeout-ms from 10000 through 300000.');
  const connect = dependencies.connect ?? connectCdp;
  const readDescriptor = dependencies.readDescriptor ?? readProtectedDescriptor;
  const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let usernameBuffer, passwordBuffer, username, password, connection, browserContextId, targetId, file;
  let outputCommitted = false;
  try {
    try { file = await open(out, 'wx', 0o600); }
    catch { throw fail('COOKIE_EXPORT_ERROR', 'Cannot reserve the private cookie file. Its parent must exist and destination must not already exist.'); }
    usernameBuffer = await readDescriptor(usernameFd, 'username');
    passwordBuffer = await readDescriptor(passwordFd, 'password');
    username = new TextDecoder('utf-8', { fatal: true }).decode(usernameBuffer);
    password = new TextDecoder('utf-8', { fatal: true }).decode(passwordBuffer);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username) || username.length > 254) throw fail('INVALID_INPUT', 'The protected username must be a full email address.');
    connection = await connect(options.cdp ?? 'http://127.0.0.1:9222');
    ({ browserContextId } = await connection.call('Target.createBrowserContext', { disposeOnDetach: true }));
    ({ targetId } = await connection.call('Target.createTarget', { url: 'about:blank', browserContextId, background: false }));
    const attached = await connection.call('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.sessionId;
    await connection.call('Page.enable', {}, sessionId);
    await connection.call('Runtime.enable', {}, sessionId);
    await connection.call('Page.navigate', { url: LOGIN_URL }, sessionId);
    const form = await waitFor(connection, sessionId, state => state.hasUsername || state.hasPassword, Math.min(timeoutMs, 30000), sleep);
    if (form.challenge) throw interactionError(form.challenge);
    let passwordState = form;
    if (form.hasUsername && form.hasPassword) {
      const submission = await submitCombinedCredentials(connection, sessionId, username, password);
      username = undefined;
      password = undefined;
      if (submission?.result?.value?.submitted !== true) throw fail('AUTH_REQUIRED', 'The first-party username/password form could not be submitted.');
    } else {
      if (form.hasUsername) {
        const usernameSubmission = await submitUsername(connection, sessionId, username);
        username = undefined;
        if (usernameSubmission?.result?.value?.submitted !== true) throw fail('AUTH_REQUIRED', 'The first-party account form could not be submitted.');
        passwordState = await waitFor(connection, sessionId, state => state.hasPassword
          || (typeof state.url === 'string' && !/\/signin(?:\/|\?|#|$)/i.test(new URL(state.url).pathname)), timeoutMs, sleep);
        if (passwordState.challenge) throw interactionError(passwordState.challenge);
      }
      if (passwordState.hasPassword) {
        const passwordSubmission = await submitPassword(connection, sessionId, password);
        password = undefined;
        if (passwordSubmission?.result?.value?.submitted !== true) throw fail('AUTH_REQUIRED', 'The first-party password form could not be submitted.');
      }
    }
    let finalState = passwordState.hasPassword || (form.hasUsername && form.hasPassword)
      ? await waitFor(connection, sessionId, state => state.canSkipPhone || (!state.hasPassword
        && typeof state.url === 'string' && !/\/signin(?:\/|\?|#|$)/i.test(new URL(state.url).pathname)), timeoutMs, sleep)
      : passwordState;
    if (finalState.challenge) throw interactionError(finalState.challenge);
    if (finalState.canSkipPhone) {
      const skip = await skipSignInPhone(connection, sessionId);
      if (skip?.result?.value?.submitted !== true) throw fail('AUTH_REQUIRED', 'The optional sign-in phone prompt could not be skipped.');
      finalState = await waitFor(connection, sessionId, state => !state.hasPassword
        && typeof state.url === 'string' && !/\/signin(?:\/|\?|#|$)/i.test(new URL(state.url).pathname), timeoutMs, sleep);
      if (finalState.challenge) throw interactionError(finalState.challenge);
    }
    const stored = await connection.call('Storage.getCookies', { browserContextId });
    const cookies = (stored.cookies ?? []).filter(cookie => {
      const domain = String(cookie.domain ?? '').replace(/^\./, '').toLowerCase();
      return zoomHost(domain);
    });
    if (!cookies.some(cookie => AUTH_COOKIE_NAMES.has(cookie.name))) {
      throw fail('AUTH_REQUIRED', 'The first-party flow did not produce an authenticated Zoom cookie session.', {
        operation: 'auth.acquire', phase: 'cookie-verification', outcome: 'not_acquired', retryable: true,
      });
    }
    await file.writeFile(JSON.stringify(cookies), 'utf8');
    outputCommitted = true;
    return { acquired: true, method: 'password-browser', outputCookieFile: out, cookieCount: cookies.length, mode: '0600', credentialsPersisted: false };
  } catch (error) {
    if (error instanceof TypeError && /encoded data/.test(error.message)) throw fail('INVALID_INPUT', 'Credentials must be valid UTF-8.');
    throw error instanceof AppError ? error : fail('AUTH_ACQUISITION_FAILED', 'The authorized first-party browser login could not be completed.', {
      operation: 'auth.acquire', phase: 'browser-login', outcome: 'not_acquired', retryable: false,
      cause: { code: 'INTERNAL_ERROR', type: typeof error?.name === 'string' ? error.name : 'Error' },
    });
  } finally {
    await file?.close().catch(() => {});
    if (file && !outputCommitted) await unlink(out).catch(() => {});
    usernameBuffer?.fill(0);
    username = undefined;
    password = undefined;
    passwordBuffer?.fill(0);
    if (connection && targetId) await connection.call('Target.closeTarget', { targetId }).catch(() => {});
    if (connection && browserContextId) await connection.call('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    connection?.close();
  }
}

export const authAcquisitionMethods = () => ({
  defaultServiceAuthentication: 'selected-profile-cookie-file',
  methods: {
    'cookie-file': { command: '--cookies PATH or selected profile', acquisition: false, unchanged: true },
    'cdp-export': { command: 'auth export [--out PATH]', acquisition: true, unchanged: true, requiresExplicitBrowserAuthorization: true },
    'password-browser': { command: 'auth acquire --method password-browser [--output-cookie-file PATH] --username-fd FD --password-fd FD', acquisition: true, optIn: true, credentialsPersisted: false, challengeFallback: 'explicit-auth-export' },
  },
  automaticFallback: false,
});
