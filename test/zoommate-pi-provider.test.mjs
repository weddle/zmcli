import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoomMateProvider } from '../src/zoommate-pi-provider.mjs';

const state = messages => ({ messages, activeRequestId: 'request-1' });
const assistant = (id, text, requestId = 'request-1') => ({ role: 'assistant', message_id: id, request_id: requestId, text, parts: [{ kind: 'text', text }] });
function harness({ outcome = { outcome: 'completed' }, updates = [], initial = [] } = {}) {
  let listener, queryText, currentState = { messages: initial, activeRequestId: null };
  const bridge = {
    get state() { return currentState; },
    subscribe(fn) { listener = fn; return () => { listener = null; }; },
    async query(text, options) {
      queryText = text;
      options.onEvent({ type: 'accepted', requestId: 'request-1' });
      for (const update of updates) { currentState = update; listener?.(update); }
      return outcome;
    },
  };
  return { bridge, get queryText() { return queryText; } };
}
async function eventsFor(bridge, context, options) {
  const provider = createZoomMateProvider(bridge);
  const events = [];
  for await (const event of provider.streamSimple(provider.getModels()[0], context, options)) events.push(event);
  return events;
}
const question = { messages: [{ role: 'user', content: 'question' }] };

test('authoritative native replacements can shorten provisional text', async () => {
  const h = harness({ initial: [assistant('old', 'history')], updates: [
    state([assistant('old', 'history'), assistant('new', 'provisional answer')]),
    state([assistant('old', 'history'), assistant('new', 'short')]),
  ] });
  const events = await eventsFor(h.bridge, question);
  assert.deepEqual(events.filter(event => event.type === 'text_delta').map(event => event.partial.content[0].text), ['provisional answer', 'short']);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.at(-1).message.content[0].text, 'short');
});

test('provider never replays native or Pi history into the current run', async () => {
  const h = harness({ initial: [assistant('old', 'do not repeat')], updates: [state([assistant('old', 'do not repeat'), assistant('new', 'current')])] });
  const events = await eventsFor(h.bridge, { messages: [
    { role: 'assistant', message_id: 'pi-old', content: [{ type: 'text', text: 'do not repeat' }] },
    { role: 'user', content: 'question' },
  ] });
  assert.equal(events.at(-1).message.content[0].text, 'current');
  assert.equal(h.queryText, 'question');
});

test('completion arriving before acceptance keeps only the attributed response', async () => {
  let listener, currentState = state([]);
  const bridge = {
    get state() { return currentState; },
    subscribe(fn) { listener = fn; return () => {}; },
    async query(_text, { onEvent }) {
      currentState = state([assistant('old', 'old history', 'previous-request')]); listener(currentState);
      currentState = state([...currentState.messages, assistant('new', 'already complete')]); listener(currentState);
      onEvent({ type: 'accepted', requestId: 'request-1' });
      return { outcome: 'completed', requestId: 'request-1', state: currentState };
    },
  };
  const events = await eventsFor(bridge, question);
  assert.equal(events.at(-1).message.content[0].text, 'already complete');
  assert.ok(events.filter(event => event.partial).every(event => !event.partial.content[0].text.includes('old history')));
});

test('lost acknowledgement preserves attributed partial output without claiming success', async () => {
  let listener, currentState = state([]);
  const bridge = {
    get state() { return currentState; },
    subscribe(fn) { listener = fn; return () => {}; },
    async query() {
      currentState = state([assistant('new', 'partial output')]); listener(currentState);
      throw Object.assign(new Error('Acknowledgement lost'), { details: { outcome: 'unknown', requestId: 'request-1' } });
    },
  };
  const events = await eventsFor(bridge, question);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).error.zoommateOutcome, 'unknown');
  assert.equal(events.at(-1).error.content[0].text, 'partial output');
});

test('detaching preserves partial output and never sends another request', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let listener, currentState = state([]), requests = 0;
  const bridge = {
    get state() { return currentState; },
    subscribe(fn) { listener = fn; return () => {}; },
    async query(_text, { signal, onEvent }) {
      requests += 1; onEvent({ type: 'accepted', requestId: 'request-1' });
      currentState = state([assistant('new', 'partial output')]); listener(currentState);
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { outcome: 'unknown', reason: 'detached', state: currentState };
    },
  };
  const provider = createZoomMateProvider(bridge), events = [];
  for await (const event of provider.streamSimple(provider.getModels()[0], question, { signal: controller.signal })) {
    events.push(event);
    if (event.type === 'text_delta') controller.abort();
  }
  assert.equal(requests, 1);
  assert.equal(events.at(-1).error.stopReason, 'aborted');
  assert.equal(events.at(-1).error.zoommateOutcome, 'unknown');
  assert.equal(events.at(-1).error.content[0].text, 'partial output');
});

test('image input is rejected before any remote query', async () => {
  let called = false;
  const bridge = { subscribe: () => () => {}, query: async () => { called = true; } };
  const events = await eventsFor(bridge, { messages: [{ role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }] });
  assert.equal(called, false);
  assert.equal(events.at(-1).type, 'error');
});
test('prepared native history is excluded while an unscoped pre-ack assistant delta is shown', async () => {
  let listener, currentState = { messages: [], activeRequestId: null };
  const bridge = {
    get state() { return currentState; },
    subscribe(fn) { listener = fn; return () => { listener = null; }; },
    async query(_text, { onEvent }) {
      const restored = { role: 'assistant', message_id: 'restored', text: 'loaded before this query', parts: [] };
      currentState = { messages: [restored], activeRequestId: null };
      onEvent({ type: 'prepared', sessionId: 'session-1', requestId: 'request-1', state: currentState });
      const current = { role: 'assistant', message_id: 'current', parts: [{ kind: 'text', text: 'before acknowledgement' }] };
      currentState = { messages: [restored, current], activeRequestId: 'request-1' };
      listener(currentState);
      onEvent({ type: 'accepted', requestId: 'request-1' });
      return { outcome: 'completed', requestId: 'request-1', state: currentState };
    },
  };
  const events = await eventsFor(bridge, question);
  assert.deepEqual(events.filter(event => ['start', 'text_delta'].includes(event.type)).map(event => event.partial.content[0].text), ['before acknowledgement']);
  assert.equal(events.at(-1).message.content[0].text, 'before acknowledgement');
  assert.ok(events.every(event => !event.partial?.content?.[0]?.text.includes('loaded before this query')));
});

test('blocked approval is surfaced as a blocked outcome, while native failure remains failed', async () => {
  const blocked = await eventsFor(harness({ outcome: { outcome: 'blocked', requestId: 'request-1', state: state([]) } }).bridge, question);
  const failed = await eventsFor(harness({ outcome: { outcome: 'failed', requestId: 'request-1', state: state([]), error: { message: 'native failure' } } }).bridge, question);
  assert.equal(blocked.at(-1).type, 'done');
  assert.equal(blocked.at(-1).message.zoommateOutcome, 'blocked');
  assert.equal(blocked.at(-1).message.errorMessage, undefined);
  assert.equal(failed.at(-1).type, 'error');
  assert.equal(failed.at(-1).error.zoommateOutcome, 'failed');
});
