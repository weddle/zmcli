import { createHash } from 'node:crypto';
import { AppError } from './session.mjs';
import { decodeCursor, encodeCursor } from './cursor.mjs';
import { BOUNDARY_LIMIT, completeHistoryPage } from './history-page.mjs';
import { dimension, resolveChatTime } from './chat-feedback.mjs';

const gates = new Set(['AUTH_REQUIRED', 'REAUTHENTICATION_REQUIRED', 'PROVIDER_APPROVAL_REQUIRED', 'REQUEST_CANCELLED',
  'SESSION_CLOSED', 'UNEXPECTED_REDIRECT', 'CHAT_IDENTITY_ERROR', 'TENANT_MISMATCH',
  'FORBIDDEN', 'AUTHORIZATION', 'AUTHORIZATION_REQUIRED', 'NOT_FOUND_OR_FORBIDDEN']);

export async function readActivity(chat, options, { channelId, channelInfo, summary, history, thread }) {
  if (!options.timeRange) throw new AppError('INVALID_INPUT', 'Activity requires a resolved bounded interval.');
  const bounded = (key, fallback, min, max) => {
    const value = Number(options[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new AppError('INVALID_INPUT', `Invalid activity ${key} budget.`);
    return value;
  };
  const limit = bounded('limit', 20, 1, 100), maxPages = bounded('max-pages', 5, 1, 10);
  const maxRequests = bounded('max-requests', 20, 1, 40);
  const rootBudget = bounded('root-pages', maxPages, 1, 10), threadBudget = bounded('thread-pages', maxPages, 1, 10);
  const recovery = options['recover-older-roots'] === true;
  if (options['recover-older-roots'] !== undefined && typeof options['recover-older-roots'] !== 'boolean') throw new AppError('INVALID_INPUT', 'Older-root recovery requires an explicit boolean opt-in.');
  const olderBudget = bounded('older-root-pages', 2, 0, 10), olderRequests = bounded('older-root-requests', 6, 1, 40);
  const olderThreads = bounded('older-root-threads', 20, 1, 1000), checkpointLimit = bounded('older-root-checkpoint-limit', 1000, 1, 2000);
  const checkpointBytes = bounded('older-root-checkpoint-bytes', 60000, 1024, 60000);
  const rescans = bounded('overlap-rescans', 0, 0, 5);
  const id = channelId(options.channel, chat.channelSuffix);
  const since = Date.parse(options.timeRange.since), until = Date.parse(options.timeRange.until) - 1;
  if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || since < 0 || since > until) throw new AppError('INVALID_INPUT', 'Activity requires fixed valid absolute bounds.');
  let lookback = null;
  if (recovery) {
    const value = options['older-root-since'];
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) throw new AppError('INVALID_INPUT', 'Older-root recovery requires an absolute older-root-since boundary.');
    lookback = Date.parse(resolveChatTime({ since: value, until: options.timeRange.since }).since);
    if (!Number.isSafeInteger(lookback) || lookback < 0 || lookback >= since) throw new AppError('INVALID_INPUT', 'Older-root-since must precede the interval.');
  } else if (options['older-root-since'] !== undefined) throw new AppError('INVALID_INPUT', 'Lookback requires recover-older-roots.');
  const overlap = bounded('overlap-ms', until - since + 1, 1, Number.MAX_SAFE_INTEGER);
  const scope = ['chat activity', chat.identity.user.userId, chat.identity.user.accountId, id.jid, since, until,
    options.timeRange.timezone ?? 'UTC', lookback, rescans, overlap];
  const initial = scan => ({ rootsBefore: until, olderBefore: recovery ? since - 1 : null, pending: [], seen: [], emitted: [], scan,
    unknownOlderRoots: false, retainedEnd: false });
  let position = initial(0);
  if (options.cursor) {
    try {
      if (typeof options.cursor !== 'string' || options.cursor.length > 60000 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) throw Error();
      const bytes = Buffer.from(options.cursor, 'base64url');
      if (bytes.toString('base64url') !== options.cursor) throw Error();
      const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (raw.v !== 1 || JSON.stringify(raw.scope) !== JSON.stringify(scope) || Object.keys(raw).sort().join(',') !== 'position,scope,v') throw Error();
      position = raw.position;
      const timestamp = value => Number.isSafeInteger(value) && value >= 1 && value <= until;
      if (!position || Object.keys(position).sort().join(',') !== 'emitted,olderBefore,pending,retainedEnd,rootsBefore,scan,seen,unknownOlderRoots'
        || typeof position.unknownOlderRoots !== 'boolean' || typeof position.retainedEnd !== 'boolean'
        || !Number.isSafeInteger(position.scan) || position.scan < 0 || position.scan > rescans
        || (position.rootsBefore !== null && (!Number.isSafeInteger(position.rootsBefore) || position.rootsBefore < since || position.rootsBefore > until))
        || (position.olderBefore !== null && (!recovery || !Number.isSafeInteger(position.olderBefore) || position.olderBefore < lookback || position.olderBefore >= since))
        || !Array.isArray(position.pending) || position.pending.length > 1000 || !Array.isArray(position.seen) || position.seen.length > 1000
        || position.seen.some(row => !Array.isArray(row) || row.length !== 2 || !timestamp(row[0]) || typeof row[1] !== 'string' || !row[1].length || row[1].length > 512)
        || new Set(position.seen.map(row => row[0])).size !== position.seen.length
        || !Array.isArray(position.emitted) || position.emitted.length > 2000
        || position.emitted.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[0].length || row[0].length > 512 || !/^[a-f0-9]{64}$/.test(row[1]))
        || new Set(position.emitted.map(row => row[0])).size !== position.emitted.length
        || position.pending.some(value => !value || Object.keys(value).sort().join(',') !== 'before,older,parentId,thread'
          || !timestamp(value.thread) || !timestamp(value.before) || value.before < since || value.before < value.thread
          || typeof value.older !== 'boolean' || (value.older && !recovery)
          || !position.seen.some(row => row[0] === value.thread && row[1] === value.parentId))
        || new Set(position.pending.map(value => value.thread)).size !== position.pending.length) throw Error();
    } catch { throw new AppError('INVALID_INPUT', 'Activity cursor must match command, actor, account, channel, interval and scan configuration.'); }
  }
  const messages = [], unsupportedItems = [], parents = new Map(), emitted = new Map(position.emitted);
  let seen = new Map(position.seen), pagesRead = 0, requestsUsed = 0, rootPages = 0, threadPages = 0;
  let olderRootPages = 0, olderPages = 0, olderRequestsUsed = 0, olderRoots = 0, olderReplyRecords = 0, recoveredReplies = 0, completedThreads = 0;
  let roots = 0, replies = 0, duplicates = 0, stop = null;
  const inspected = new Set(), scanStartedAt = new Date().toISOString(), terminations = [];
  const terminate = (outcome, reason) => { stop = { outcome, reason }; terminations.push(stop); };
  const checkpoint = () => {
    position.seen = [...seen]; position.emitted = [...emitted];
    return encodeCursor(scope, position);
  };
  const propagateGate = error => {
    if (!gates.has(error?.code)) return;
    error.details = { ...error.details, activity: { outcome: 'unsupported-stop', reason: 'AUTHORIZATION_UNCERTAINTY', nextCursor: checkpoint(), pagesRead, requestsUsed } };
    throw error;
  };
  let channel;
  try { channel = await channelInfo(chat, id); }
  catch (error) { propagateGate(error); throw error; }
  if (![1, 2].includes(Number(channel.type)) || channel.e2e !== '0') throw new AppError('UNSUPPORTED_CONVERSATION', 'Activity requires an unencrypted native channel.');
  const fits = () => seen.size + emitted.size + position.pending.length <= checkpointLimit && checkpoint().length <= checkpointBytes;
  if (!fits()) terminate('budget-stop', 'OVERSIZED_CHECKPOINT');
  while (!stop && pagesRead < maxPages && requestsUsed < maxRequests) {
    if (!position.pending.length && position.rootsBefore === null && position.olderBefore === null) {
      if (position.scan >= rescans) break;
      const unknown = position.unknownOlderRoots, retainedEnd = position.retainedEnd;
      position = initial(position.scan + 1); position.unknownOlderRoots = unknown; position.retainedEnd = retainedEnd; seen = new Map();
    }
    const stream = position.pending[0] ?? (position.rootsBefore !== null ? { thread: null, before: position.rootsBefore, older: false }
      : position.olderBefore !== null ? { thread: null, before: position.olderBefore, older: true } : null);
    if (!stream) break;
    if (stream.thread === null ? rootPages >= rootBudget || (stream.older && olderRootPages >= olderBudget) : threadPages >= threadBudget) {
      terminate('budget-stop', stream.older && stream.thread === null ? 'OLDER_ROOT_PAGE_BUDGET' : stream.thread === null ? 'ROOT_PAGE_BUDGET' : 'THREAD_PAGE_BUDGET'); break;
    }
    if (stream.older && (olderRequestsUsed >= olderRequests || (stream.thread !== null && !inspected.has(stream.thread) && inspected.size >= olderThreads))) {
      terminate('budget-stop', olderRequestsUsed >= olderRequests ? 'OLDER_ROOT_REQUEST_BUDGET' : 'OLDER_ROOT_THREAD_BUDGET'); break;
    }
    const start = stream.thread === null && stream.older ? lookback : position.scan ? Math.max(since, until - overlap + 1) : since;
    const fetchPage = async (size, before, lower) => {
      if (requestsUsed >= maxRequests || (stream.older && olderRequestsUsed >= olderRequests)) return null;
      requestsUsed++; if (stream.older) olderRequestsUsed++;
      return stream.thread === null ? history(chat, id, size, before, lower) : thread(chat, id, stream.thread, size, before, Math.max(lower, stream.thread));
    };
    if (stream.older && stream.thread !== null) inspected.add(stream.thread);
    pagesRead++; if (stream.thread === null) { rootPages++; if (stream.older) olderRootPages++; } else threadPages++;
    if (stream.older) olderPages++;
    let page;
    try {
      const first = await fetchPage(limit, stream.before, start);
      if (!first || !Array.isArray(first.messages)) throw new AppError('UNSUPPORTED_CONTENT', 'Missing native message page.');
      if (first.messages.some(message => !Number.isSafeInteger(message.timestamp) || message.timestamp < start || message.timestamp > stream.before)) {
        throw new AppError('HISTORY_RANGE_MISMATCH', 'Activity source returned a record outside its requested bounds.');
      }
      let boundary;
      if (first.messages.length >= limit && !first.nextCursor) {
        const oldest = Math.min(...first.messages.map(message => message.timestamp));
        boundary = await fetchPage(BOUNDARY_LIMIT, oldest, oldest);
        if (!boundary) terminate('budget-stop', stream.older && olderRequestsUsed >= olderRequests ? 'OLDER_ROOT_REQUEST_BUDGET' : 'REQUEST_BUDGET');
      }
      page = completeHistoryPage(first, boundary, limit, ['chat activity-page', id.jid, stream.thread]);
      if (stream.thread !== null && (!page.parent || page.parent.id !== stream.parentId || page.parent.timestamp !== stream.thread || page.messages.some(message =>
        message.replyTo?.id !== page.parent.id || Number(message.replyTo.thread) !== stream.thread || message.to !== id.jid))) {
        throw new AppError('UNSUPPORTED_CONTENT', 'Activity replies disagree with the native parent.');
      }
    } catch (error) {
      propagateGate(error);
      if (!stream.older && ['HISTORY_RANGE_MISMATCH', 'UNSUPPORTED_CONTENT'].includes(error?.code)) throw error;
      terminate(stream.thread === null ? 'unsupported-stop' : 'thread-incomplete', error?.code ?? 'NATIVE_READ_FAILED'); break;
    }
    unsupportedItems.push(...(page.unsupportedItems ?? []));
    if (page.parent) parents.set(page.parent.id, { id: page.parent.id, timestamp: page.parent.timestamp, channelId: id.jid });
    if (page.pagination.status === 'incomplete' && !stop) {
      const reason = page.pagination.reason;
      terminate(reason === 'UNSUPPORTED_NATIVE_HISTORY_RECORDS' ? 'unsupported-stop' : 'pagination-stop', reason);
    }
    for (const message of page.messages) {
      const key = createHash('sha256').update(JSON.stringify([message.timestamp, message.from ?? null, message.to ?? null, message.replyTo?.id ?? null, message.replyTo?.thread ?? null])).digest('hex');
      if (emitted.has(message.id) && emitted.get(message.id) !== key) { terminate('pagination-stop', 'INCONSISTENT_REPEATED_IDENTITY'); break; }
      if (stream.thread === null) {
        if (stream.older) {
          if (message.replyTo) olderReplyRecords++;
          else olderRoots++;
        }
        const timestamp = message.replyTo ? Number(message.replyTo.thread) : message.timestamp, parentId = message.replyTo?.id ?? message.id;
        if (!Number.isSafeInteger(timestamp) || timestamp < 1 || timestamp > until || typeof parentId !== 'string' || !parentId.length || parentId.length > 512) { terminate('unsupported-stop', 'UNSUPPORTED_THREAD'); break; }
        if (seen.has(timestamp) && seen.get(timestamp) !== parentId) { terminate('pagination-stop', 'INCONSISTENT_REPEATED_IDENTITY'); break; }
        if (stream.older && !message.replyTo && (!Number.isSafeInteger(message.replyCount) || message.replyCount < 0)) position.unknownOlderRoots = true;
        const candidate = message.replyTo || (stream.older ? Number.isSafeInteger(message.replyCount) && message.replyCount > 0 : message.replyCount !== 0);
        if (candidate && !seen.has(timestamp)) {
          seen.set(timestamp, parentId); position.pending.push({ thread: timestamp, parentId, before: until, older: stream.older });
          if (!fits()) { seen.delete(timestamp); position.pending.pop(); terminate('budget-stop', 'OVERSIZED_CHECKPOINT'); break; }
        }
      }
      if (message.timestamp < since || message.timestamp > until || (stream.thread === null && message.replyTo && !stop)) continue;
      if (emitted.has(message.id)) { duplicates++; continue; }
      emitted.set(message.id, key);
      if (message.id.length > 512 || !fits()) { emitted.delete(message.id); terminate('budget-stop', 'OVERSIZED_CHECKPOINT'); break; }
      const activityKind = stream.thread === null && !message.replyTo ? 'root' : 'reply';
      if (activityKind === 'root') roots++; else { replies++; if (stream.older) recoveredReplies++; }
      messages.push({ ...message, activityKind, readState: 'unknown', fromIdentity: null,
        senderIdentity: { status: message.messageLocalLabel ? 'message-local' : 'unresolved', canonicalProfile: null, messageLocalLabel: message.messageLocalLabel ?? null } });
      if (!message.contentComplete) unsupportedItems.push({ id: message.id, reason: 'PARTIAL_MESSAGE_CONTENT', reasons: message.contentCoverage?.reasons ?? [], record: message });
    }
    if (stop) break;
    const nextBefore = page.nextCursor ? decodeCursor(page.nextCursor, ['chat activity-page', id.jid, stream.thread]).before : null;
    if (nextBefore !== null && nextBefore >= stream.before) { terminate('pagination-stop', 'CURSOR_NOT_ADVANCED'); break; }
    if (stream.thread === null) {
      position[stream.older ? 'olderBefore' : 'rootsBefore'] = nextBefore !== null && nextBefore >= start ? nextBefore : null;
      if (stream.older && position.olderBefore === null) {
        if (page.retainedHistoryExhausted === true) { position.retainedEnd = true; terminations.push({ outcome: 'retained-history-exhausted', reason: 'NATIVE_END' }); }
        else terminations.push({ reason: nextBefore !== null ? 'LOOKBACK_BOUNDARY' : 'NATIVE_RANGE_END' });
      }
    } else if (nextBefore === null || nextBefore < Math.max(start, stream.thread)) { position.pending.shift(); if (stream.older) completedThreads++; }
    else stream.before = nextBefore;
  }
  const more = position.rootsBefore !== null || position.olderBefore !== null || position.pending.length > 0 || position.scan < rescans;
  if (more && !stop) terminate('budget-stop', requestsUsed >= maxRequests ? 'REQUEST_BUDGET' : 'PAGE_BUDGET');
  const token = checkpoint(), nextCursor = more ? token : null;
  const lookbackComplete = recovery && position.olderBefore === null;
  const candidatesComplete = recovery && !position.pending.some(row => row.older) && lookbackComplete && !position.unknownOlderRoots && !stop;
  const traversed = !more && !stop && recovery && lookbackComplete && candidatesComplete;
  const reasons = stop ? [stop.reason] : [];
  const outcomes = [...new Set([...terminations.map(row => row.outcome).filter(Boolean), ...(traversed ? ['complete-within-lookback'] : []), 'late/backdated-unknown'])];
  return { channel: summary(id.jid, channel), messages, parents: [...parents.values()], unsupportedItems, nextCursor, pagesRead, requestsUsed,
    counts: { roots, replies, duplicates },
    traversal: { rootPages, threadPages, pendingThreads: position.pending.length, seenThreads: seen.size, exhaustive: false },
    olderRootRecovery: { enabled: recovery, lookbackSince: lookback === null ? null : new Date(lookback).toISOString(),
      lookbackUntil: new Date(since).toISOString(), rootsScanned: olderRoots, replyRecordsScanned: olderReplyRecords,
      candidatesInspected: inspected.size, repliesRecovered: recoveredReplies,
      pagesUsed: olderPages, rootPagesUsed: olderRootPages, requestsUsed: olderRequestsUsed, candidateThreadsCompleted: completedThreads,
      checkpointUsage: { entries: seen.size + emitted.size + position.pending.length, bytes: token.length, entryLimit: checkpointLimit, byteLimit: checkpointBytes },
      lookbackTraversalCompleted: lookbackComplete, everyCandidateThreadCompleted: candidatesComplete, completeWithinLookback: traversed,
      retainedHistoryExhausted: position.retainedEnd, unknownRootReplyCounts: position.unknownOlderRoots, outcomes, terminations },
    overlap: { requestedRescans: rescans, scan: position.scan, overlapMs: overlap, scanStartedAt, stableIdDedupe: true },
    lateOrBackdatedRecovery: false, scope: 'bounded-channel-roots-and-candidate-threads', sourceExhaustive: false,
    timeRange: { ...options.timeRange, since: new Date(since).toISOString(), until: new Date(until + 1).toISOString(),
      timezone: options.timeRange.timezone ?? 'UTC', filterLocation: 'mixed', sourceExhaustive: false },
    pagination: { complete: !more && !stop, status: stop ? 'incomplete' : more ? 'more' : 'end', reasons },
    coverage: { pagination: dimension(more || stop ? 'incomplete' : 'complete', 'bounded-native-streams', reasons),
      identity: { ...dimension('unknown', 'returned-actors', ['IDENTITIES_NOT_RESOLVED']), counts: { canonical: 0,
        local: messages.filter(message => message.messageLocalLabel).length, unresolved: messages.filter(message => !message.messageLocalLabel).length } },
      traversal: { status: traversed ? 'complete' : 'incomplete', scope: 'explicit-lookback-roots-and-candidate-threads', exhaustive: false, completeWithinLookback: traversed },
      category: dimension('unknown', 'channel-activity', [...(!traversed ? ['REPLIES_TO_UNENCOUNTERED_OLDER_ROOTS_NOT_PROVEN'] : []), 'LATE_OR_BACKDATED_ARRIVALS_NOT_RECOVERED']) },
    omissions: ['Only explicitly bounded roots and discovered threads are traversed; no archive or timestamp completeness is established.',
      'Overlap rescans are bounded observations, not a verified monotonic recovery mechanism.'],
    readEffects: { explicitReadMutationSent: false, readNeutralityGuaranteed: false } };
}
