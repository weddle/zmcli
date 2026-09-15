import { AppError } from './session.mjs';

export function cursorScope(command, options) {
  if (command === 'chat custom-emojis') return [command, options.own ? 'own' : 'all'];
  return command.startsWith('docs ') || command === 'chat search'
    ? [command, options.query ?? '']
    : [command, options.channel.split('@')[0], options.thread === undefined ? null : Number(options.thread)];
}

export function encodeCursor(scope, position) {
  return Buffer.from(JSON.stringify({ v: 1, scope, position })).toString('base64url');
}

export function decodeCursor(token, scope) {
  try {
    if (typeof token !== 'string' || token.length > 60000 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.toString('base64url') !== token) throw new Error();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (value.v !== 1 || JSON.stringify(value.scope) !== JSON.stringify(scope)
      || Object.keys(value).sort().join(',') !== 'position,scope,v') throw new Error();
    const position = value.position;
    if (scope[0].startsWith('zoommate ')) {
      if (!position || Object.keys(position).sort().join(',') !== 'native,previous'
        || !position.native || typeof position.native !== 'object' || Array.isArray(position.native)
        || (position.previous !== null && typeof position.previous !== 'string')) throw new Error();
    } else if (scope[0].startsWith('docs ') || ['chat search', 'chat custom-emojis', 'chat mentions'].includes(scope[0])) {
      const idPattern = ['chat search', 'chat mentions'].includes(scope[0]) ? /^[A-Za-z0-9_.:@-]{1,1024}$/ : /^[A-Za-z0-9_-]{1,128}$/;
      if (!position || Object.keys(position).sort().join(',') !== 'seen,token'
        || typeof position.token !== 'string' || !position.token || !Array.isArray(position.seen)
        || !position.seen.every(id => typeof id === 'string' && idPattern.test(id))) throw new Error();
    } else if (scope[0] === 'chat new-messages') {
      if (!position || Object.keys(position).sort().join(',') !== 'before,offset,since,streams,until'
        || !Number.isSafeInteger(position.since) || position.since < 1
        || !Array.isArray(position.streams) || position.streams.length > 1000
        || !Number.isSafeInteger(position.offset) || position.offset < 0 || position.offset > position.streams.length) throw new Error();
      if (position.until === null) {
        if (position.streams.length || position.offset !== 0 || position.before !== null) throw new Error();
      } else if (!Number.isSafeInteger(position.until) || position.until < position.since
        || position.offset >= position.streams.length
        || (position.before !== null && (!Number.isSafeInteger(position.before)
          || position.before < position.since || position.before > position.until))) throw new Error();
      const identities = new Set();
      for (const stream of position.streams) {
        if (!stream || Object.keys(stream).sort().join(',') !== 'id,thread'
          || typeof stream.id !== 'string' || !/^[A-Za-z0-9_-]{1,512}@[A-Za-z0-9.-]{1,253}$/.test(stream.id)
          || (stream.thread !== null && (!Number.isSafeInteger(stream.thread) || stream.thread < 1 || stream.thread > position.until))) throw new Error();
        const key = `${stream.id}:${stream.thread}`;
        if (identities.has(key)) throw new Error();
        identities.add(key);
      }
    } else if (scope[0] === 'chat dm-inbox') {
      if (!position || Object.keys(position).sort().join(',') !== 'fingerprint,offset'
        || !Number.isSafeInteger(position.offset) || position.offset < 1
        || typeof position.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(position.fingerprint)) throw new Error();
    } else if (!position || Object.keys(position).join(',') !== 'before'
      || !Number.isSafeInteger(position.before) || position.before < 0
      || (scope[2] !== null && position.before < scope[2])) throw new Error();
    return position;
  } catch {
    throw new AppError('INVALID_INPUT', 'Invalid cursor or cursor does not match this command, channel, thread, or query.');
  }
}
