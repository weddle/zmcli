import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZoomMateBridge } from '../src/zoommate-pi-bridge.mjs';

const identity = { user: { userId: 'user', accountId: 'account' } };
const textPart = text => ({ kind: 'text', text, metadata: { part_type: 'text', part_id: 'text' } });
const documentPart = (id, text) => ({ kind: 'create_doc', text, metadata: {
  part_type: 'create_doc', part_id: id, doc_id: id, title: 'Unsolicited document',
} });

function fixture() {
  const listeners = new Set(), sent = [];
  const oldHistory = {
    method: 'agent.history',
    params: {
      messages: [
        { role: 'user', message_id: 'old-user', selected_entities: [{ id: 'old-source', entity_type: 'zoom_doc', name: 'Old source' }], parts: [textPart('old prompt')] },
        { role: 'assistant', message_id: 'old-assistant', request_id: 'old-request', parts: [textPart('old answer'), documentPart('old-doc', '# Old artifact')] },
      ],
      async_status: 'completed',
      has_more: false, next_offset: null,
    },
  };
  const transport = {
    bootstrap: {},
    identity,
    async connect() { for (const listener of listeners) listener(oldHistory); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async request(path) {
      assert.equal(path, '/api/v1/credits/status');
      return { credit_status: null };
    },
    async send(method, params) {
      sent.push({ method, params });
      assert.equal(method, 'agent.run');
      for (const listener of listeners) {
        listener({ method: 'agent.delta', params: {
          session_id: params.session_id, request_id: 'foreign-request', message_id: 'foreign', seq: 1,
          part: textPart('foreign answer'),
        } });
        listener({ method: 'agent.delta', params: {
          session_id: params.session_id, request_id: 'foreign-request', message_id: 'foreign-doc', seq: 2,
          part: documentPart('foreign-doc', '# Foreign artifact'),
        } });
        listener({ method: 'agent.delta', params: {
          session_id: params.session_id, request_id: params.request_id, message_id: 'current', seq: 1,
          part: textPart('current answer'),
        } });
        listener({ method: 'agent.done', params: {
          session_id: params.session_id, request_id: params.request_id, async_status: 'completed', seq: 2,
        } });
      }
      return { request_id: params.request_id, accepted_at: 1 };
    },
    close() {},
  };
  return { session: { identity, openZoomMate: async () => transport, close: async () => {} }, transport, sent };
}

test('new conversation clears the bridge conversation and derived context', async () => {
  const f = fixture();
  const bridge = await createZoomMateBridge({}, { connect: async () => f.session });
  try {
    bridge.project = { id: 'project', name: 'Project', project_type: 'project' };
    bridge.selected.entity.push('meeting:chosen');
    bridge.selected.skill.push('skill');
    bridge.selected.connector.push('connector');
    bridge.selected.artifact.push('document:chosen');
    await bridge.newConversation();
    assert.equal(bridge.sessionId, null);
    assert.equal(bridge.project, null);
    assert.deepEqual(bridge.selected, { entity: [], skill: [], connector: [], artifact: [] });
    assert.deepEqual(bridge.state.messages, []);
    assert.deepEqual(bridge.state.artifacts, []);
  } finally {
    await bridge.close();
  }
});
test('new query ignores unsolicited history and foreign request deltas in text, sources, and artifacts', async () => {
  const f = fixture();
  const bridge = await createZoomMateBridge({}, { connect: async () => f.session });
  try {
    const result = await bridge.query('current prompt');
    assert.equal(result.outcome, 'completed');
    assert.equal(result.state.messages.filter(message => message.role === 'assistant').map(message => message.text).join('\n'), 'current answer');
    assert.deepEqual(result.state.messages.filter(message => message.role === 'user').flatMap(message => message.selected_entities ?? []), []);
    assert.deepEqual(result.state.artifacts, []);
    assert.equal(f.sent.filter(item => item.method === 'agent.run').length, 1);
  } finally {
    await bridge.close();
  }
});

test('unavailable credit reads cannot erase a completed run or retain a falsely fresh balance', async () => {
  const f = fixture();
  let reads = 0;
  f.transport.request = async () => {
    if (++reads >= 3) throw Object.assign(new Error('Credits unavailable'), { code: 'FORBIDDEN' });
    return { credit_status: { remaining_credit: 50, used_credit: 50, budget_cap: 100 } };
  };
  const bridge = await createZoomMateBridge({}, { connect: async () => f.session });
  try {
    const result = await bridge.query('complete once');
    assert.equal(result.outcome, 'completed');
    assert.equal(bridge.state.status, 'idle');
    assert.equal(bridge.credits, null);
    assert.equal(f.sent.filter(item => item.method === 'agent.run').length, 1);
    await assert.rejects(bridge.run('credits'), { code: 'FORBIDDEN' });
    assert.equal(bridge.creditObservations.at(-1).error.code, 'FORBIDDEN');
    assert.equal(bridge.credits, null);
  } finally { await bridge.close(); }
});

test('a cached request observation never rolls back an interleaved manual balance', async () => {
  const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  let reads = 0;
  f.transport.request = async () => ({ credit_status: { remaining_credit: ++reads < 3 ? 100 : 90, budget_cap: 100 } });
  const send = f.transport.send;
  f.transport.send = async (...args) => {
    await send(...args);
    entered.resolve();
    await release.promise;
    throw new Error('Acknowledgement unavailable');
  };
  const bridge = await createZoomMateBridge({}, { connect: async () => f.session });
  try {
    const running = bridge.query('one request');
    await entered.promise;
    await bridge.run('credits');
    const visible = [];
    const unsubscribe = bridge.subscribe((_state, kind) => { if (kind === 'credits') visible.push(bridge.credits.remaining_credit); });
    release.resolve();
    await assert.rejects(running, /Acknowledgement unavailable/);
    unsubscribe();
    const before = bridge.creditObservations.find(item => item.phase === 'before-request');
    const after = bridge.creditObservations.findLast(item => item.phase === 'after-request');
    const manual = bridge.creditObservations.findLast(item => item.phase === 'manual');
    assert.deepEqual(visible, [90]);
    assert.equal(after.cached, true);
    assert.equal(after.correlationId, before.correlationId);
    assert.notEqual(after.correlationId, manual.correlationId);
    assert.equal(after.creditStatus.remaining_credit, 100);
    assert.equal(after.observedAt, before.observedAt);
    assert.equal(f.sent.filter(item => item.method === 'agent.run').length, 1);
  } finally { release.resolve(); await bridge.close(); }
});

test('credit observations survive native Pi history replacement without duplicate cache entries', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Offline history restoration must not fetch external services.'));
  const { createZoomMatePiRuntime } = await import('../src/zoommate-pi-host.mjs');
  const cwd = await mkdtemp(join(tmpdir(), 'zoommate-credit-cache-'));
  const agentDir = join(cwd, 'agent'), f = fixture();
  f.transport.request = async path => {
    if (path.endsWith('/info')) return { async_status: 'completed' };
    assert.equal(path, '/api/v1/credits/status');
    return { credit_status: { remaining_credit: 50, budget_cap: 100 } };
  };
  f.transport.send = async (method, params) => {
    assert.equal(method, 'session.join');
    await f.transport.connect();
    return { session_id: params.session_id, active_run: null };
  };
  const bridge = await createZoomMateBridge({}, { connect: async () => f.session });
  const observedAt = bridge.creditObservations[0].observedAt;
  let host;
  try {
    host = await createZoomMatePiRuntime(bridge, { cwd, agentDir, reporter: { report() {}, reset() {}, release() {} } });
    await bridge.resume('first');
    await bridge.resume('second');
    const sessions = join(agentDir, 'sessions');
    const snapshots = await Promise.all((await readdir(sessions)).map(async name =>
      (await readFile(join(sessions, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line))));
    const restored = snapshots.find(entries => entries.some(entry => entry.customType === 'zoommate.native-state' && entry.data.sessionId === 'second'));
    assert.ok(restored, 'The restored conversation must have a persisted Pi cache.');
    const startup = restored.filter(entry => entry.customType === 'zoommate.credit-observation' && entry.data.phase === 'startup');
    assert.equal(startup.length, 1, 'Replacing native history must retain one original startup observation.');
    assert.equal(startup[0].data.observedAt, observedAt);
  } finally {
    await bridge.close();
    await host?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
