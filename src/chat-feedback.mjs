import { AppError } from './session.mjs';

export function stepError(error, operation, phase) {
  const code = error instanceof AppError ? error.code : 'CHAT_NATIVE_STEP_FAILED';
  const safe = value => {
    if (!value || typeof value !== 'object') return undefined;
    return Object.fromEntries(Object.entries(value).filter(([key, entry]) =>
      (['code', 'operation', 'phase', 'outcome'].includes(key) && typeof entry === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(entry))
      || (['status', 'attempts', 'retryAfterMs'].includes(key) && Number.isFinite(entry))
      || (['retryable', 'retryExhausted', 'partial'].includes(key) && typeof entry === 'boolean')));
  };
  return new AppError(code, 'Chat native step failed; inspect operation, phase and cause before retrying.', {
    operation, phase, outcome: 'not_sent', retryable: false,
    cause: { code, ...safe(error?.details), ...(error?.details?.cause ? { cause: safe(error.details.cause) } : {}) },
  });
}

export function resolveChatTime(options, now = Date.now()) {
  if (options.since === undefined && options.until === undefined && options.timezone === undefined) return null;
  const timezone = options.timezone ?? 'UTC';
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { throw new AppError('INVALID_INPUT', 'Timezone must be an IANA timezone.'); }
  const day = time => {
    const p = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  const midnight = next => {
    if (!options.timezone) throw new AppError('INVALID_INPUT', 'today requires an explicit IANA timezone.');
    const today = day(now);
    let lo = now - 48 * 3600000, hi = now + 48 * 3600000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (next ? day(mid) <= today : day(mid) < today) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const parse = (value, end) => {
    if (value === 'now') return now;
    if (value === 'today') return midnight(end);
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new AppError('INVALID_INPUT', 'Use an absolute timestamp with offset or Z, today, or now.');
    const [year, month, date] = value.slice(0, 10).split('-').map(Number);
    const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== date
      || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) {
      throw new AppError('INVALID_INPUT', 'Timestamp contains an invalid calendar date or clock time.');
    }
    return Date.parse(value);
  };
  const since = parse(options.since ?? 'today', false);
  const until = parse(options.until ?? (options.since === 'today' ? 'today' : 'now'), true);
  if (since < 0 || since >= until) throw new AppError('INVALID_INPUT', 'The half-open time interval must be nonempty and forward.');
  return { inputs: { since: options.since ?? null, until: options.until ?? null, timezone: options.timezone ?? null },
    timezone, since: new Date(since).toISOString(), until: new Date(until).toISOString(),
    interval: '[since,until)', filterLocation: 'local', sourceExhaustive: false };
}

export function dimension(status, scope, reasons = []) { return { status, scope, exhaustive: false, reasons }; }

export function finishChatRead(result, chat, action, options, observedAt) {
  const indexed = ['mentions', 'dm-inbox', 'new-messages', 'list'].includes(action);
  const scope = result.scope ?? `chat-${action}`;
  if (options.timeRange) {
    result.timeRange ??= options.timeRange;
    const since = Date.parse(options.timeRange.since), until = Date.parse(options.timeRange.until);
    const inRange = item => Number.isSafeInteger(item.timestamp) && item.timestamp >= since && item.timestamp < until;
    if (result.messages) result.messages = result.messages.filter(inRange);
    if (action === 'mentions') result.items = result.items.filter(inRange);
  }
  const messages = [...(result.messages ?? []), ...(result.items ?? []).flatMap(item => item.message ? [item.message] : item.latest?.message ? [item.latest.message] : []),
    ...(result.message ? [result.message] : []), ...(result.parent?.from ? [result.parent] : [])];
  for (const message of messages) {
    message.readState ??= 'unknown';
    message.fromIdentity ??= null;
    message.senderIdentity ??= { status: message.messageLocalLabel ? 'message-local' : 'unresolved', canonicalProfile: null,
      messageLocalLabel: message.messageLocalLabel ?? null };
  }
  const unsupported = result.unsupportedItems ?? [];
  const coverage = result.coverage ?? {};
  coverage.pagination ??= dimension(result.pagination?.complete === true ? 'complete' : result.nextCursor || result.pagination?.complete === false ? 'incomplete' : 'unknown', scope,
    result.pagination?.reasons ?? (result.pagination?.reason ? [result.pagination.reason] : []));
  const contentKnown = messages.length > 0 || Array.isArray(result.messages) || typeof result.contentComplete === 'boolean';
  const contentComplete = !unsupported.length && messages.every(message => message.contentComplete === true);
  if (typeof result.contentComplete === 'boolean') result.contentComplete = contentComplete;
  coverage.content ??= dimension(!contentComplete ? 'incomplete' : contentKnown ? 'complete' : 'unknown', 'returned-records',
    [...new Set(messages.flatMap(message => message.contentCoverage?.reasons ?? []))]);
  coverage.identity ??= action === 'cards' ? dimension(result.complete ? 'complete' : 'incomplete', 'explicit-native-card-identities')
    : dimension('unknown', 'returned-actors', ['IDENTITIES_NOT_RESOLVED']);
  coverage.identity.counts = { canonical: messages.filter(message => message.senderIdentity.status === 'canonical').length,
    local: messages.filter(message => message.senderIdentity.status === 'message-local').length,
    unresolved: messages.filter(message => message.senderIdentity.status === 'unresolved').length };
  const senderCounts = new Map();
  let missingSenderCount = 0;
  for (const message of messages) {
    if (typeof message.from === 'string' && message.from) senderCounts.set(message.from, (senderCounts.get(message.from) ?? 0) + 1);
    else missingSenderCount++;
  }
  result.senderEvidence = { scope: 'returned-message-records', identitiesResolved: false, missingSenderCount,
    unresolvedNativeSenders: [...senderCounts].map(([nativeId, messageCount]) => ({ nativeId, messageCount, identity: null })),
    unresolvedSenderCount: senderCounts.size };
  coverage.permission ??= dimension('unknown', 'accessible-native-source', ['PERMISSION_EXHAUSTIVENESS_UNPROVEN']);
  if (indexed) coverage.category ??= dimension('unknown', scope, ['SOURCE_EXHAUSTIVENESS_UNPROVEN']);
  result.coverage = coverage;
  result.freshness = { source: 'server', sourceType: scope, observedAt,
    actorId: chat.identity.user.userId, accountId: chat.identity.user.accountId,
    nativeWatermark: result.nativeIndex?.watermarks ?? result.index?.watermarks ?? null,
    snapshot: { status: 'non-atomic' }, alreadyReadCoverage: action === 'new-messages' || options.state === 'unread' ? 'excluded' : 'unknown',
    lateOrBackdatedCoverage: ['new-messages', 'activity'].includes(action) ? 'excluded' : 'unknown' };
  result.consumerConstraints = { membershipProvesReportingRelationship: false, countsProveMotivationOrPerformance: false,
    historyProvesUnread: false, browserFallback: 'never-automatic; explicit approval required because opening conversations may change read state' };
  result.capabilityExclusions = ['folder-enumeration', 'starred-census', 'browser-local-state', 'notification-center'];
  return result;
}

export function enforceChatStrict(result, action, strict) {
  const required = action === 'cards' ? ['identity'] : ['members', 'users'].includes(action) ? ['pagination', 'identity']
    : action === 'list' ? ['pagination', 'category'] : ['pagination', 'content', 'identity'];
  result.strictPolicy = { requiredCoverage: required, sourceExhaustivenessRequired: false };
  if (!strict) return result;
  if (required.some(key => result.coverage?.[key]?.status !== 'complete')) {
    throw new AppError('INCOMPLETE_COVERAGE', 'Required Chat evidence dimensions are incomplete; consume non-strict output for private record detail.', {
      operation: `chat.${action}`, phase: 'coverage', outcome: 'not_sent', retryable: false, required,
      partial: { coverage: result.coverage, freshness: result.freshness, timeRange: result.timeRange,
        returnedCount: result.items?.length ?? result.messages?.length ?? 0,
        unsupportedItems: (result.unsupportedItems ?? []).map(item => ({ reason: item.reason })), nextCursor: result.nextCursor ?? null },
    });
  }
  return result;
}
