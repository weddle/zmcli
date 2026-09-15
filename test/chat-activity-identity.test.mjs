import test from 'node:test';
import assert from 'node:assert/strict';
import { readActivity } from '../src/chat-activity.mjs';
import { runChat } from '../src/chat.mjs';
import { messageContent } from '../src/chat-transport.mjs';
import { messageWire, xml, parseXml } from '../src/chat-xml.mjs';
import { completeHistoryPage } from '../src/history-page.mjs';
import { encodeCursor } from '../src/cursor.mjs';
import { AppError } from '../src/session.mjs';

const jid = 'room@conference.xmpp.zoom.us';
const identity = { user: { userId: 'actor', accountId: 'auth' }, account: { accountId: 'auth' } };
const metadata = { type: 2, e2e: '0', account: 'resource', name: 'Fixture', owner: 'owner' };
const timeRange = { since: '1970-01-01T00:00:00.500Z', until: '1970-01-01T00:00:02.000Z', timezone: 'UTC' };
const recover = { timeRange, 'recover-older-roots': true, 'older-root-since': '1970-01-01T00:00:00.050Z', 'max-pages': 10 };
const root = (id, timestamp, replyCount = 0) => ({ id, timestamp, replyCount, from: 'a@xmpp.zoom.us', to: jid, contentComplete: true });
const reply = (id, timestamp, parent) => ({ ...root(id, timestamp), replyTo: { id: parent.id, thread: String(parent.timestamp) } });
const current = root('current', 1000, 1), silent = root('silent', 1200), older = root('older', 100, 1), zero = root('zero', 50);
const currentReply = reply('current-reply', 1100, current), olderReply = reply('older-reply', 600, older), late = reply('late', 1800, older);
function source({ roots = [silent, current, older, zero], replies = [currentReply, olderReply], historyHook, threadHook } = {}) {
  const calls = [];
  const page = (rows, size, before, start) => rows.filter(row => row.timestamp >= start && row.timestamp <= before).sort((a, b) => b.timestamp - a.timestamp).slice(0, size);
  const callbacks = { channelId: () => ({ jid }), channelInfo: async () => metadata, summary: () => ({ id: jid }),
    history: async (chat, id, size, before, start) => { calls.push({ kind: 'roots', size, before, start }); return historyHook ? historyHook({ size, before, start, page, calls }) : { messages: page(roots, size, before, start) }; },
    thread: async (chat, id, timestamp, size, before, start) => { calls.push({ kind: 'thread', timestamp, size, before, start });
      return threadHook ? threadHook({ timestamp, size, before, start, page, calls }) : { parent: roots.find(row => row.timestamp === timestamp), messages: page(replies.filter(row => Number(row.replyTo.thread) === timestamp), size, before, start) }; } };
  return { callbacks, calls };
}
const run = (options, fixture = source()) => readActivity({ identity }, options, fixture.callbacks);

// Counted acceptance corpus: 2 interval roots, 2 baseline replies, 2 older roots,
// 1 additional late/backdated reply observed on rescan. Identity corpus below: 1/1/1.
test('default never scans older history; opt-in recovers only in-range older-root replies', async () => {
  const fixture = source({ replies: [currentReply, olderReply, reply('before', 499, older), reply('end', 2000, older)] });
  const base = await run({ timeRange }, fixture);
  assert.deepEqual(base.messages.map(row => row.id), ['silent', 'current', 'current-reply']);
  assert.equal(fixture.calls.some(call => call.start < 500), false);
  assert.equal(base.sourceExhaustive, false);
  const recovered = await run(recover, fixture);
  assert.deepEqual(recovered.messages.map(row => row.id), ['silent', 'current', 'current-reply', 'older-reply']);
  assert.deepEqual(recovered.counts, { roots: 2, replies: 2, duplicates: 0 });
  assert.equal(recovered.olderRootRecovery.rootsScanned, 2);
  assert.equal(recovered.olderRootRecovery.candidatesInspected, 1);
  assert.equal(recovered.olderRootRecovery.repliesRecovered, 1);
  assert.equal(recovered.olderRootRecovery.pagesUsed, 2);
  assert.equal(recovered.olderRootRecovery.requestsUsed, 2);
  assert.equal(recovered.olderRootRecovery.completeWithinLookback, true);
  assert.equal(recovered.olderRootRecovery.everyCandidateThreadCompleted, true);
  assert.equal(recovered.lateOrBackdatedRecovery, false);
  assert.deepEqual(recovered.messages.at(-1).replyTo, olderReply.replyTo);
});

test('lookback is required, explicit and never crosses the requested lower boundary', async () => {
  await assert.rejects(run({ timeRange, 'recover-older-roots': true }), { code: 'INVALID_INPUT' });
  await assert.rejects(run({ timeRange, 'older-root-since': recover['older-root-since'] }), { code: 'INVALID_INPUT' });
  const fixture = source({ roots: [older, root('outside', 49, 1)] });
  const result = await run(recover, fixture);
  assert.equal(fixture.calls.some(call => call.start < 50), false);
  assert.equal(result.olderRootRecovery.lookbackSince, recover['older-root-since']);
  assert.equal(result.olderRootRecovery.rootsScanned, 1);
});

test('epoch lookback with one-millisecond interval start never makes a negative checkpoint', async () => {
  const fixture = source({ roots: [] });
  const options = { ...recover, timeRange: { since: '1970-01-01T00:00:00.001Z', until: '1970-01-01T00:00:00.002Z' },
    'older-root-since': '1970-01-01T00:00:00.000Z', 'max-pages': 1 };
  const first = await run(options, fixture);
  assert.equal(JSON.parse(Buffer.from(first.nextCursor, 'base64url')).position.olderBefore, 0);
  const second = await run({ ...options, cursor: first.nextCursor }, fixture);
  assert.equal(second.nextCursor, null);
  assert.equal(second.olderRootRecovery.completeWithinLookback, true);
  assert.deepEqual(fixture.calls.map(call => [call.start, call.before]), [[1, 1], [0, 0]]);
  await assert.rejects(run({ ...options, timeRange: { since: '1970-01-01T00:00:00.000Z', until: '1970-01-01T00:00:00.001Z' } }), { code: 'INVALID_INPUT' });
});

test('cursor binds command actor account channel interval and lookback', async () => {
  const first = await run({ ...recover, 'max-pages': 1 });
  for (const index of [0, 1, 2, 3, 4, 5, 7]) {
    const value = JSON.parse(Buffer.from(first.nextCursor, 'base64url'));
    value.scope[index] = typeof value.scope[index] === 'number' ? value.scope[index] + 1 : `${value.scope[index]}-other`;
    await assert.rejects(run({ ...recover, cursor: Buffer.from(JSON.stringify(value)).toString('base64url') }), { code: 'INVALID_INPUT' });
  }
});

test('page and request budgets preserve resumable native work', async () => {
  for (const options of [{ 'max-pages': 1 }, { 'max-requests': 1 }, { 'root-pages': 1 }, { 'thread-pages': 1 }, { 'older-root-pages': 0 }, { 'older-root-requests': 1 }]) {
    const result = await run({ ...recover, ...options });
    assert.ok(result.nextCursor);
    assert.equal(result.olderRootRecovery.completeWithinLookback, false);
    assert.ok(result.olderRootRecovery.outcomes.includes('budget-stop'));
    const next = await run({ ...recover, cursor: result.nextCursor });
    assert.equal(next.olderRootRecovery.completeWithinLookback, true);
  }
});

test('candidate thread budget stops before another candidate request', async () => {
  const other = root('other', 200, 1);
  const fixture = source({ roots: [older, other], replies: [olderReply, reply('other-reply', 700, other)] });
  const first = await run({ ...recover, 'older-root-threads': 1 }, fixture);
  assert.equal(first.olderRootRecovery.candidatesInspected, 1);
  assert.equal(first.olderRootRecovery.everyCandidateThreadCompleted, false);
  assert.ok(first.olderRootRecovery.terminations.some(row => row.reason === 'OLDER_ROOT_THREAD_BUDGET'));
  const second = await run({ ...recover, cursor: first.nextCursor }, fixture);
  assert.equal(second.olderRootRecovery.everyCandidateThreadCompleted, true);
});

test('checkpoint entry and byte budgets stop explicitly without oversized returned cursors', async () => {
  for (const options of [{ 'older-root-checkpoint-limit': 1 }, { 'older-root-checkpoint-bytes': 1024 }]) {
    const fixture = source({ roots: Array.from({ length: 10 }, (_, index) => root(`root-${index}-${'x'.repeat(60)}`, 1000 + index)) });
    const result = await run({ ...recover, ...options }, fixture);
    assert.ok(result.nextCursor);
    assert.ok(result.olderRootRecovery.terminations.some(row => row.reason === 'OVERSIZED_CHECKPOINT'));
    assert.ok(result.nextCursor.length <= (options['older-root-checkpoint-bytes'] ?? 60000));
    assert.equal(result.olderRootRecovery.completeWithinLookback, false);
  }
});

test('has-more without usable cursor fails closed; usable cursor is retained exactly', async () => {
  const scope = ['chat activity-page', jid, null], token = encodeCursor(scope, { before: 999 });
  const page = completeHistoryPage({ messages: [current], hasMore: true, nextCursor: token }, null, 20, scope);
  assert.equal(page.nextCursor, token);
  for (const nextCursor of [undefined, 'opaque-invalid', encodeCursor(scope, { before: 1000 })]) {
    const stopped = completeHistoryPage({ messages: [current], hasMore: true, nextCursor }, null, 20, scope);
    assert.equal(stopped.pagination.complete, false);
    assert.equal(stopped.nextCursor, null);
  }
  const fixture = source({ roots: [], historyHook: ({ start }) => ({ messages: start === 50 ? [older] : [], hasMore: start === 50 }) });
  const result = await run(recover, fixture);
  assert.ok(result.nextCursor);
  assert.ok(result.olderRootRecovery.outcomes.includes('pagination-stop'));
  assert.equal(result.olderRootRecovery.completeWithinLookback, false);
});

test('same timestamp boundary is drained, counted as a request, and stops at lookback', async () => {
  const boundaryRoot = root('boundary', 50, 0);
  const fixture = source({ roots: [boundaryRoot] });
  const result = await run({ ...recover, limit: 1 }, fixture);
  assert.equal(result.olderRootRecovery.rootsScanned, 1);
  assert.equal(result.olderRootRecovery.requestsUsed, 2);
  assert.equal(result.olderRootRecovery.rootPagesUsed, 1);
  assert.equal(result.olderRootRecovery.completeWithinLookback, true);
  assert.ok(result.olderRootRecovery.terminations.some(row => row.reason === 'LOOKBACK_BOUNDARY'));
});

test('repeated cursor and repeated out-of-range timestamp stop rather than looping', async () => {
  const token = encodeCursor(['chat activity-page', jid, null], { before: 99 });
  const fixture = source({ roots: [], historyHook: ({ start, before }) => start === 50
    ? { messages: [root('older', before === 499 ? 100 : 99)], nextCursor: token, hasMore: true } : { messages: [] } });
  const result = await run(recover, fixture);
  assert.ok(result.olderRootRecovery.outcomes.includes('pagination-stop'));
  assert.equal(result.olderRootRecovery.completeWithinLookback, false);
  const repeated = source({ roots: [], historyHook: ({ start }) => start === 50 ? { messages: [{ ...older, replyCount: 0 }], nextCursor: token } : { messages: [] } });
  const stopped = await run(recover, repeated);
  assert.ok(stopped.olderRootRecovery.terminations.some(row => row.reason === 'HISTORY_RANGE_MISMATCH'));
});

test('inconsistent repeated stable identity cannot be hidden by overlap dedupe', async () => {
  let scans = 0;
  const fixture = source({ historyHook: () => ({ messages: [{ ...silent, from: ++scans === 1 ? 'a' : 'different' }] }) });
  const result = await run({ timeRange, 'max-pages': 10, 'overlap-rescans': 1 }, fixture);
  assert.equal(result.messages.length, 1);
  assert.ok(result.olderRootRecovery.terminations.some(row => row.reason === 'INCONSISTENT_REPEATED_IDENTITY'));
});

test('native end and unknown counts cannot overstate timestamp completeness', async () => {
  const fixture = source({ historyHook: () => ({ messages: [], retainedHistoryExhausted: true }) });
  const result = await run(recover, fixture);
  assert.ok(result.olderRootRecovery.outcomes.includes('retained-history-exhausted'));
  assert.equal(result.sourceExhaustive, false);
  assert.equal(result.lateOrBackdatedRecovery, false);
  const unknown = await run(recover, source({ roots: [{ ...older, replyCount: null }] }));
  assert.equal(unknown.olderRootRecovery.lookbackTraversalCompleted, true);
  assert.equal(unknown.olderRootRecovery.completeWithinLookback, false);
  assert.equal(unknown.olderRootRecovery.everyCandidateThreadCompleted, false);
});

test('unsupported roots and failed threads retain precise incomplete outcomes', async () => {
  const unsupported = source({ historyHook: ({ start }) => start === 50 ? { messages: [], unsupportedItems: [{ reason: 'MALFORMED_MESSAGE_XML', record: '<broken' }] } : { messages: [] } });
  const stopped = await run(recover, unsupported);
  assert.ok(stopped.olderRootRecovery.outcomes.includes('unsupported-stop'));
  assert.deepEqual(stopped.unsupportedItems[0].record, '<broken');
  const failed = source({ roots: [older], threadHook: () => { throw new AppError('HTTP_ERROR', 'Thread service unavailable', { status: 503 }); } });
  const result = await run(recover, failed);
  assert.ok(result.olderRootRecovery.outcomes.includes('thread-incomplete'));
  assert.equal(result.olderRootRecovery.everyCandidateThreadCompleted, false);
  assert.ok(result.nextCursor);
});

test('unexpected identity errors propagate from batch and individual fallback without further requests', async () => {
  for (const failure of [new AppError('INTERNAL_ERROR', 'Local failure'), new Error('Unexpected failure'), new TypeError('Programming failure')]) {
    for (const stage of ['batch', 'individual']) {
      let calls = 0;
      const fixture = session([], ids => {
        calls++;
        if (stage === 'individual' && ids.length > 1) throw new AppError('HTTP_ERROR', 'Batch unavailable', { status: 415 });
        throw failure;
      });
      await assert.rejects(runChat(fixture, 'cards', { users: 'a,b' }), error => error === failure);
      assert.equal(calls, stage === 'batch' ? 1 : 2);
    }
  }
});

test('native activity authorization failures propagate sanitized resumable evidence at every read stage', async () => {
  for (const code of ['FORBIDDEN', 'AUTHORIZATION', 'AUTHORIZATION_REQUIRED', 'NOT_FOUND_OR_FORBIDDEN', 'TENANT_MISMATCH']) {
    for (const stage of ['metadata', 'roots', 'thread']) {
      const failure = new AppError(code, 'Private native denial', { cookie: 'private-cookie', cause: { token: 'private-token' } });
      const fixture = source({ roots: [older] });
      if (stage === 'metadata') fixture.callbacks.channelInfo = async () => { throw failure; };
      else fixture.callbacks[stage === 'roots' ? 'history' : 'thread'] = async () => { throw failure; };
      let cursor;
      await assert.rejects(run(recover, fixture), error => {
        assert.equal(error, failure);
        const evidence = error.details.activity;
        assert.equal(evidence.reason, 'AUTHORIZATION_UNCERTAINTY');
        assert.equal(evidence.outcome, 'unsupported-stop');
        cursor = evidence.nextCursor;
        assert.equal(typeof cursor, 'string');
        assert.equal(JSON.stringify(evidence).includes('private-'), false);
        assert.equal(evidence.requestsUsed, stage === 'metadata' ? 0 : stage === 'roots' ? 1 : 3);
        return true;
      });
      const resumed = await run({ ...recover, cursor }, source({ roots: [older] }));
      assert.equal(resumed.olderRootRecovery.completeWithinLookback, true);
      assert.deepEqual(resumed.messages.map(row => row.id), ['older-reply']);
    }
  }
});

test('pre-interval replies in root history discover parents without inflating older root counts', async () => {
  const historicalReply = reply('historical-reply', 300, older);
  const fixture = source({ roots: [zero, historicalReply], threadHook: () => ({ parent: older, messages: [olderReply] }) });
  const result = await run(recover, fixture);
  assert.equal(result.olderRootRecovery.rootsScanned, 1);
  assert.equal(result.olderRootRecovery.replyRecordsScanned, 1);
  assert.equal(result.olderRootRecovery.candidatesInspected, 1);
  assert.equal(result.olderRootRecovery.repliesRecovered, 1);
  assert.deepEqual(result.messages.map(row => row.id), ['older-reply']);
  assert.deepEqual(result.messages[0].replyTo, olderReply.replyTo);
  assert.equal(result.olderRootRecovery.completeWithinLookback, true);
});

test('authorization uncertainty propagates the gate without subsequent native work', async () => {
  const fixture = source({ roots: [older], threadHook: () => { throw new AppError('PROVIDER_APPROVAL_REQUIRED', 'Approval required'); } });
  await assert.rejects(run(recover, fixture), error => {
    assert.equal(error.code, 'PROVIDER_APPROVAL_REQUIRED');
    assert.equal(error.details.activity.reason, 'AUTHORIZATION_UNCERTAINTY');
    assert.ok(error.details.activity.nextCursor);
    return true;
  });
  assert.equal(fixture.calls.length, 3);
});

test('repeatable overlap rescans recover one late fixture without claiming monotonic recovery', async t => {
  let olderReads = 0;
  const fixture = source({ threadHook: ({ timestamp, size, before, start, page }) => ({ parent: timestamp === 100 ? older : current,
    messages: page(timestamp === 100 ? ++olderReads > 1 ? [olderReply, late] : [olderReply] : [currentReply], size, before, start) }) });
  let cursor, results = [];
  do {
    const result = await run({ ...recover, 'max-pages': 3, 'overlap-rescans': 2, cursor }, fixture);
    results.push(result); cursor = result.nextCursor;
    assert.ok(results.length < 10);
  } while (cursor);
  const messages = results.flatMap(result => result.messages);
  assert.deepEqual(messages.map(row => row.id).sort(), ['current', 'current-reply', 'late', 'older-reply', 'silent']);
  assert.equal(results.reduce((sum, result) => sum + result.counts.roots, 0), 2);
  assert.equal(results.reduce((sum, result) => sum + result.counts.replies, 0), 3);
  assert.equal(results.reduce((sum, result) => sum + result.olderRootRecovery.repliesRecovered, 0), 2);
  assert.equal(results.every(result => result.lateOrBackdatedRecovery === false), true);
  assert.equal(results.at(-1).olderRootRecovery.completeWithinLookback, true);
  t.diagnostic(`ACTIVITY_CORPUS roots=2 replies=3 olderRoots=2 late=1 paginationCalls=${results.length} nativePages=${results.reduce((sum, row) => sum + row.pagesRead, 0)} nativeRequests=${results.reduce((sum, row) => sum + row.requestsUsed, 0)}`);
});

const rich = { type: 'Page', children: [{ type: 'Paragraph', content: [{ data: 'body' }] }] };
const record = (id, sender, label, content = rich, body = '<body>body</body>', type = '17') => ({ msg_id: id, timestamp: 1000,
  message: `<message id="${id}" from="${sender}@xmpp.zoom.us/resource" to="${jid}" type="groupchat">${body}<zmrt>${xml(JSON.stringify(content))}</zmrt><zmext><msg_type>${type}</msg_type>${label === null ? '' : `<from n="${xml(label)}"/>`}</zmext></message>` });
function session(records, cards) {
  return { openChat: async () => ({ identity, from: 'actor@xmpp.zoom.us/resource', channelSuffix: '@conference.xmpp.zoom.us',
    parseMessages: async rows => rows.map(row => messageContent(row, messageWire(row))),
    request: async (path, args) => {
      if (path === '/xms/channel/infos') return { result: 0, data: { [jid]: metadata } };
      if (path === '/history/fetch2' || path === '/history/fetchbymsgid') return { data: [{ session: jid, messages: records }] };
      assert.equal(path, '/api/v1/ucs/contact/vcard/batch', 'No roster or alternative endpoint');
      return cards(args.body.userJids);
    } }) };
}

test('batch 415 and individual failures preserve canonical local unresolved identities separately', async t => {
  const records = [record('canonical', 'a', 'Same'), record('local', 'b', 'Same'), record('unresolved', 'c', null)];
  const result = await runChat(session(records, ids => {
    if (ids.length > 1) throw new AppError('HTTP_ERROR', 'Batch rejected', { status: 415 });
    if (ids[0] === 'a@xmpp.zoom.us') return { vcardUsers: [{ jid: ids[0], userId: 'a', displayName: 'Canonical', email: 'a@example.test' }] };
    throw new AppError('HTTP_ERROR', 'Sender unavailable', { status: 404 });
  }), 'inspect', { channel: jid, limit: 10, 'resolve-identities': true });
  assert.deepEqual(result.coverage.identity.counts, { canonical: 1, local: 1, unresolved: 1 });
  assert.equal(result.messages[0].fromIdentity.displayName, 'Canonical');
  assert.equal(result.messages[0].fromIdentity.accountId, null);
  assert.equal(result.messages[1].fromIdentity, null);
  assert.deepEqual(result.messages[1].messageLocalLabel, { displayName: 'Same', senderJid: 'b@xmpp.zoom.us', messageId: 'local', source: 'native-message-envelope', confidence: 'message-local' });
  assert.equal(result.messages[1].senderIdentity.error.status, 404);
  assert.equal(result.identityResolution.error.status, 415);
  assert.deepEqual(result.identities.map(row => row.status), ['resolved', 'unavailable', 'unavailable']);
  t.diagnostic('IDENTITY_CORPUS canonical=1 local=1 unresolved=1 envelopeLabels=2');
});

test('cards command treats HTTP 415 as unavailable evidence, not a fatal read', async () => {
  const result = await runChat(session([], () => { throw new AppError('HTTP_ERROR', '415', { status: 415 }); }), 'cards', { users: 'a' });
  assert.equal(result.items[0].status, 'unavailable');
  assert.equal(result.items[0].error.status, 415);
  assert.equal(result.coverage.identity.status, 'incomplete');
});

test('history and exact envelopes alone supply labels; body rich attributes cannot impersonate sender', async () => {
  const raw = record('exact', 'a', 'Local');
  const exact = await runChat(session([raw], () => { throw Error('No enrichment requested'); }), 'message', { messageLink: { channel: jid, message: 'exact', time: 1000 } });
  assert.equal(exact.message.senderIdentity.status, 'message-local');
  const forged = record('forged', 'a', null, { ...rich, senderName: 'Fake' }, '<body from="Fake">Fake</body>');
  forged.senderName = 'Fake';
  const parsed = messageContent(forged, messageWire(forged));
  assert.equal(parsed.messageLocalLabel, null);
  assert.equal(parsed.senderIdentity.status, 'unresolved');
  const mismatched = { ...raw, msg_id: 'other' };
  assert.equal(messageWire(mismatched).messageLocalLabel, null);
});

test('overlapping unsupported content reasons and raw payload survive without text upgrade', async t => {
  const malformedRich = { type: 'Page', extra: true, style: { unknown: true }, children: [{ type: 'Paragraph', content: [{ data: 42, attrs: { color: 'red' } }] }, { type: 999 }] };
  const records = [record('partial', 'a', null, malformedRich, '', '902'), record('text-partial', 'b', null, malformedRich)];
  const messages = records.map(row => messageContent(row, messageWire(row)));
  for (const reason of ['MISSING_BODY', 'UNSUPPORTED_MESSAGE_TYPE', 'UNSUPPORTED_RICH_FIELDS', 'UNSUPPORTED_RICH_STYLE', 'UNSUPPORTED_RICH_RUN', 'UNSUPPORTED_RICH_NODE', 'UNSUPPORTED_RUN_ATTRIBUTES']) assert.ok(messages[0].contentCoverage.reasons.includes(reason));
  assert.equal(messages[1].text, 'body');
  assert.equal(messages.every(row => row.contentComplete === false), true);
  assert.deepEqual(messages.map(row => row.raw.xml), records.map(row => row.message));
  t.diagnostic('UNSUPPORTED_CORPUS records=2 overlappingReasons=7');
});

test('safe declaration remains accepted while declarations entities roots and size attacks fail', () => {
  assert.equal(parseXml('<?xml version="1.0"?><message/>').localName, 'message');
  for (const raw of ['<?xml version="1.0"?><?xml version="1.0"?><message/>', '<!DOCTYPE message SYSTEM "file:///secret"><message/>', '<!ENTITY x "bad"><message/>', '<message>&external;</message>', '<message/><message/>', '<message>', `<message>${'x'.repeat(1024 * 1024)}</message>`]) assert.throws(() => parseXml(raw), { code: 'UNSUPPORTED_CONTENT' });
});
