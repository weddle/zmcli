import { AppError } from './session.mjs';
import { decodeCursor, encodeCursor } from './cursor.mjs';

export const BOUNDARY_LIMIT = 100;

export function completeHistoryPage(first, boundary, limit, scope) {
  const valid = message => typeof message.id === 'string' && message.id.length > 0
    && Number.isSafeInteger(message.timestamp) && message.timestamp > 0;
  if (!first.messages.every(valid) || new Set(first.messages.map(m => m.id)).size !== first.messages.length) {
    throw new AppError('UNSUPPORTED_CONTENT', 'History returned invalid or duplicate stable IDs/timestamps. No continuation can be established.');
  }
  const pagination = { status: 'end', complete: true, snapshot: false, requestedLimit: limit, boundaryLimit: BOUNDARY_LIMIT };
  if (first.unsupportedItems?.length || boundary?.unsupportedItems?.length) return { ...first,
    unsupportedItems: [...(first.unsupportedItems ?? []), ...(boundary?.unsupportedItems ?? [])], nextCursor: null,
    pagination: { ...pagination, status: 'incomplete', complete: false, reason: 'UNSUPPORTED_NATIVE_HISTORY_RECORDS' } };
  if (first.nextCursor) {
    try {
      const { before } = decodeCursor(first.nextCursor, scope);
      if (!first.messages.length || before >= Math.min(...first.messages.map(message => message.timestamp))) throw Error();
      return { ...first, pagination: { ...pagination, status: 'more', complete: false } };
    } catch {
      return { ...first, nextCursor: null, pagination: { ...pagination, status: 'incomplete', complete: false, reason: 'NATIVE_MORE_WITHOUT_USABLE_CURSOR' } };
    }
  }
  if (first.hasMore === true && first.messages.length < limit) return { ...first, nextCursor: null,
    pagination: { ...pagination, status: 'incomplete', complete: false, reason: 'NATIVE_MORE_WITHOUT_USABLE_CURSOR' } };
  if (first.messages.length < limit) return { ...first, nextCursor: null, pagination };
  const oldest = Math.min(...first.messages.map(m => m.timestamp));
  const bucket = boundary?.messages ?? [];
  const boundaryIds = new Set(bucket.map(m => m.id));
  const exhausted = bucket.length > 0 && bucket.length < BOUNDARY_LIMIT && bucket.every(m => valid(m) && m.timestamp === oldest)
    && boundaryIds.size === bucket.length && first.messages.filter(m => m.timestamp === oldest).every(m => boundaryIds.has(m.id));
  const records = new Map(first.messages.map(m => [m.id, m]));
  let changed = false;
  for (const message of bucket.filter(m => valid(m) && m.timestamp === oldest)) {
    const previous = records.get(message.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(message)) changed = true;
    records.set(message.id, message);
  }
  const messages = [...records.values()].sort((a, b) => b.timestamp - a.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!exhausted || changed) return { ...first, messages, nextCursor: null, pagination: {
    ...pagination, status: 'incomplete', complete: false, boundaryTimestamp: oldest, boundaryExhausted: false,
    reason: changed ? 'HISTORY_CHANGED_DURING_READ' : boundary?.errorCode ? 'BOUNDARY_READ_FAILED' : 'TIMESTAMP_BOUNDARY_NOT_EXHAUSTED',
    ...(boundary?.errorCode ? { errorCode: boundary.errorCode } : {}),
  } };
  if (scope[2] !== null && oldest <= scope[2]) return { ...first, messages, nextCursor: null, pagination: { ...pagination, boundaryExhausted: true } };
  return { ...first, messages, nextCursor: encodeCursor(scope, { before: oldest - 1 }), pagination: {
    ...pagination, status: 'more', complete: false, boundaryTimestamp: oldest, boundaryExhausted: true,
  } };
}
