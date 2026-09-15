import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rename, link, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppError } from './session.mjs';
import { createCookieHttp } from './cookie-http.mjs';

const DEFAULT_CDP = 'http://127.0.0.1:9222';
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const fail = (code, message) => { throw new AppError(code, message); };
const owned = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const absent = error => error.code === 'ENOENT';

export const PROFILE_HELP = `Profiles and cookie storage:
  Default profile: ~/.zmcli/config.json and ~/.zmcli/cookies.json
  Named profile:   ~/.zmcli/profiles/NAME/config.json and cookies.json
  Root precedence: --config-dir PATH > ZMCLI_HOME > ~/.zmcli
  --profile NAME selects local storage, not a browser account.
  --cookies PATH overrides saved cookies for this invocation without changing them.
  Named profiles never fall back to another profile's cookies or settings.
  profile show [--profile NAME] reports resolved paths without displaying cookies.
  Managed directories are private (0700); config and cookie files use 0600.

Setup and explicit browser refresh:
  zmcli profile init
  zmcli auth import --cookies /private/fresh-export.json
  zmcli profile init --profile work
  zmcli profile set --profile work --cdp http://127.0.0.1:9222
  zmcli auth export --profile work
  zmcli auth export --profile work --replace
  zoompi --profile work

  auth import copies an existing export; it does not contact a browser.
  auth export captures cookies from an already-running, explicitly authorized browser.
  CDP precedence: --cdp URL > selected profile's saved cdp > http://127.0.0.1:9222.
  Confirm the browser account before export. Saving CDP settings grants no authority.
  Existing managed cookies require --replace for an authorized refresh/account change.
  Failed acquisition or validation preserves the previous managed cookie file.
  auth export --out PATH writes a new external file instead; --replace cannot overwrite it.
  auth acquire without --output-cookie-file also saves into the selected profile.
  No automatic browser launch, login, cookie refresh, or browser runtime fallback.`;

export function validateCdpUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { fail('INVALID_INPUT', 'CDP must be an HTTP loopback URL without credentials, path, query, or fragment.'); }
  if (url.hostname.endsWith('.localhost')) throw new AppError('RELAY_COOKIE_EXPORT_UNSUPPORTED',
    'Browser relay cookie export is not supported; use an explicitly authorized literal loopback CDP endpoint.',
    { operation: 'auth.export', phase: 'relay-cookie-acquisition', outcome: 'not_sent', retryable: false });
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/' || url.username || url.password || url.hash || url.search) {
    fail('INVALID_INPUT', 'CDP must be an HTTP literal-loopback URL without credentials, path, query, or fragment.');
  }
  return value;
}

function layout(options) {
  const name = options.profile ?? 'default';
  if (typeof name !== 'string' || !PROFILE_NAME.test(name)) fail('INVALID_INPUT', 'Profile names must contain 1–64 letters, digits, underscores or hyphens and start with a letter or digit.');
  const directory = options['config-dir'] ?? process.env.ZMCLI_HOME ?? join(homedir(), '.zmcli');
  if (typeof directory !== 'string' || !directory.trim() || /[\u0000-\u001f\u007f]/u.test(directory)) fail('INVALID_INPUT', 'Supply a nonblank configuration directory.');
  const root = resolve(directory), dir = name === 'default' ? root : join(root, 'profiles', name);
  return { name, root, dir, configFile: join(dir, 'config.json'), cookieFile: join(dir, 'cookies.json'),
    cacheDir: join(dir, 'cache'), agentDir: join(dir, 'pi') };
}

async function privateDirectory(path, create = false) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) {
    if (!absent(error)) throw error;
    if (!create) return false;
    await mkdir(path, { recursive: true, mode: 0o700 });
    stat = await lstat(path);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o077)) {
    fail('PROFILE_SECURITY_ERROR', 'Profile directories must be owned by the current user, private (mode 0700), and not symlinks.');
  }
  return true;
}

async function privateFile(path) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (absent(error)) return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o077)) {
    fail('PROFILE_SECURITY_ERROR', 'Managed profile files must be owned by the current user, private (mode 0600), and not symlinks.');
  }
  return true;
}

async function readConfig(profile) {
  if (!await privateFile(profile.configFile)) return { version: 1 };
  const file = await open(profile.configFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let config;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536 || !owned(stat) || (stat.mode & 0o077)) fail('PROFILE_CONFIG_ERROR', 'Invalid profile configuration file.');
    try { config = JSON.parse(await file.readFile('utf8')); }
    catch { fail('PROFILE_CONFIG_ERROR', 'Profile config.json must contain valid JSON.'); }
  } finally { await file.close(); }
  if (!config || Array.isArray(config) || config.version !== 1 || Object.keys(config).some(key => !['version', 'cdp'].includes(key))) {
    fail('PROFILE_CONFIG_ERROR', 'Profile config.json requires version 1 and supports only the cdp setting.');
  }
  if (config.cdp !== undefined) validateCdpUrl(config.cdp);
  return config;
}

export async function ensureProfileDirectory(profile) {
  await privateDirectory(profile.root, true);
  if (profile.name !== 'default') {
    await privateDirectory(join(profile.root, 'profiles'), true);
    await privateDirectory(profile.dir, true);
  }
  await privateDirectory(profile.cacheDir, true);
  await privateDirectory(profile.agentDir, true);
}

export async function resolveProfile(options = {}, { create = false } = {}) {
  const profile = layout(options);
  let exists = await privateDirectory(profile.root);
  if (profile.name !== 'default') {
    exists = exists && await privateDirectory(join(profile.root, 'profiles')) && await privateDirectory(profile.dir);
    if (!exists && !create) fail('PROFILE_NOT_FOUND', 'The selected profile does not exist. Use profile init --profile NAME; no other profile was selected.');
  }
  if (create) { await ensureProfileDirectory(profile); exists = true; }
  const config = exists ? await readConfig(profile) : { version: 1 };
  if (options.cookies !== undefined && (typeof options.cookies !== 'string' || !options.cookies.trim())) fail('INVALID_INPUT', 'Supply a nonblank cookie file path.');
  const hasCookies = exists && await privateFile(profile.cookieFile);
  return { ...profile, exists, config, hasCookies,
    cookies: options.cookies === undefined ? profile.cookieFile : resolve(options.cookies),
    cdp: validateCdpUrl(options.cdp ?? config.cdp ?? DEFAULT_CDP) };
}

async function installPrivateFile(source, destination, replace) {
  const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) fail('PROFILE_SECURITY_ERROR', 'Profile output must be a regular file.');
    await file.chmod(0o600);
    await file.sync();
  } finally { await file.close(); }
  await privateFile(destination);
  if (replace) await rename(source, destination);
  else {
    try { await link(source, destination); }
    catch (error) {
      if (error.code === 'EEXIST') fail('PROFILE_FILE_EXISTS', 'The managed profile file already exists. Nothing was replaced.');
      throw error;
    }
  }
}

function summary(profile) {
  return { name: profile.name, directory: profile.dir, initialized: profile.exists, configFile: profile.configFile,
    cookieFile: profile.cookieFile, hasCookies: profile.hasCookies, cacheDir: profile.cacheDir, agentDir: profile.agentDir,
    settings: profile.config, effectiveCdp: profile.cdp, automaticCookieRefresh: false };
}

export async function runProfileCommand(action, options = {}) {
  if (action === 'list') {
    const base = layout(options), names = ['default'];
    const exists = await privateDirectory(base.root);
    if (exists && await privateDirectory(join(base.root, 'profiles'))) {
      for (const entry of await readdir(join(base.root, 'profiles'), { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'default' && PROFILE_NAME.test(entry.name)) names.push(entry.name);
      }
    }
    return { root: base.root, defaultProfile: 'default', profiles: names.sort().map(name => ({ name, directory: layout({ ...options, profile: name }).dir })) };
  }
  if (!['init', 'show', 'set'].includes(action)) fail('INVALID_INPUT', 'Use profile init, show, list or set.');
  if (action === 'set' && options.cdp === undefined) fail('INVALID_INPUT', 'Use profile set --cdp URL.');
  if (options.cdp !== undefined) validateCdpUrl(options.cdp);
  const profile = await resolveProfile(options, { create: action !== 'show' });
  if (action !== 'show') {
    const configExists = await privateFile(profile.configFile);
    if (action === 'init' && configExists) {
      if (options.cdp !== undefined && profile.config.cdp !== options.cdp) fail('PROFILE_FILE_EXISTS', 'This profile is already configured. Use profile set --cdp URL to change it.');
    } else {
      const stage = await mkdtemp(join(profile.dir, '.config-'));
      try {
        const path = join(stage, 'config.json'), file = await open(path, 'wx', 0o600);
        try { await file.writeFile(`${JSON.stringify({ ...profile.config, ...(options.cdp === undefined ? {} : { cdp: options.cdp }) }, null, 2)}\n`); }
        finally { await file.close(); }
        await installPrivateFile(path, profile.configFile, action === 'set');
      } finally { await rm(stage, { recursive: true, force: true }); }
    }
    return summary(await resolveProfile(options));
  }
  return summary(profile);
}

export async function persistProfileCookies(profile, producer, { replace = false } = {}) {
  await ensureProfileDirectory(profile);
  const existed = await privateFile(profile.cookieFile);
  if (existed && !replace) fail('PROFILE_FILE_EXISTS', 'This profile already has cookies. Use --replace only for an explicitly authorized refresh or account replacement.');
  const stage = await mkdtemp(join(profile.dir, '.auth-'));
  try {
    const path = join(stage, 'cookies.json');
    const result = await producer(path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!(await file.stat()).isFile()) fail('COOKIE_FILE_ERROR', 'Cookie acquisition did not produce a regular file.'); }
    finally { await file.close(); }
    const validation = await createCookieHttp(path);
    await validation.close();
    await installPrivateFile(path, profile.cookieFile, replace);
    return { ...result, ...(result?.outputCookieFile !== undefined ? { outputCookieFile: profile.cookieFile } : {}),
      profile: profile.name, cookieFile: profile.cookieFile, persisted: true, replaced: existed, mode: '0600' };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function importProfileCookies(profile, source, options = {}) {
  if (typeof source !== 'string' || !source.trim()) fail('INVALID_INPUT', 'auth import requires --cookies PATH.');
  return persistProfileCookies(profile, async destination => {
    const file = await open(resolve(source), constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      if (!(await file.stat()).isFile()) fail('COOKIE_FILE_ERROR', 'Import requires a regular exported cookie file.');
      bytes = await file.readFile();
      const output = await open(destination, 'wx', 0o600);
      try { await output.writeFile(bytes); } finally { await output.close(); }
    } finally { bytes?.fill(0); await file.close(); }
    return { imported: true };
  }, options);
}
