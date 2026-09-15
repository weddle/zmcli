import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoomMateState } from '../src/zoommate-state.mjs';

const delta = (seq, text, metadata = {}, requestId = 'r') => ({ method: 'agent.delta', params: {
  session_id: 's', request_id: requestId, message_id: `m-${requestId}`, seq,
  part: { kind: 'text', metadata: { part_type: 'text', part_id: 'p', ...metadata }, text },
} });
const control = { kind: 'data', metadata: { part_type: 'client_tool', part_id: 'control' }, data: {
  tool_call_id: 'tool-1', tool_type: 'human_in_the_loop', tool_id: 'system_ask_user_confirm_inline',
  parameters_values: [{ name: 'buttons', value: [{ text: 'Use Advanced Mode', responseContent: 'Use Advanced Mode' }] }],
} };
const history = parts => ({ method: 'agent.history', params: { session_id: 's', seq: 1,
  messages: [{ role: 'assistant', message_id: 'm-r', parts }] } });

test('guardrail projection replaces streamed text while raw parts remain available', () => {
  const state = createZoomMateState('s');
  state.apply(delta(1, 'initial draft'));
  state.apply(delta(2, 'refusal', { part_type: 'extended_text', tags: ['guardrail'], append: false, part_id: 'guardrail' }));
  state.apply(delta(3, ' continued', { part_type: 'extended_text', tags: ['guardrail'], append: true, part_id: 'guardrail' }));
  assert.equal(state.snapshot().messages[0].text, 'refusal continued');
  assert.equal(state.snapshot().messages[0].parts[0].text, 'initial draft');
});

test('a new streamed tool remains active after the previous turn completed', () => {
  const state = createZoomMateState('s');
  state.apply(delta(1, 'previous answer'));
  state.apply({ method: 'agent.done', params: { request_id: 'r', async_status: 'completed' } });
  state.apply({ method: 'client.accepted', params: { request_id: 'next', message: {
    role: 'user', message_id: 'next-user', parts: [{ kind: 'text', text: 'continue', metadata: { part_type: 'text' } }],
  } } });
  state.apply({ method: 'agent.delta', params: { session_id: 's', request_id: 'next', message_id: 'next-assistant', seq: 1,
    part: { kind: 'data', metadata: { part_type: 'server_tool', part_id: 'tool' },
      data: { tool_call_id: 'next-call', tool: 'shell_exec', status: 'start' } },
  } });
  assert.equal(state.snapshot().execution.tools[0].isActive, true);
  state.apply({ method: 'agent.done', params: { request_id: 'next', async_status: 'completed' } });
  const tool = state.snapshot().execution.tools[0];
  assert.equal(tool.isActive, false);
  assert.equal(Boolean(tool.isTerminal), false);
});

test('duplicates are ignored, different runs and history establish new sequence scopes', () => {
  const state = createZoomMateState('s');
  state.apply(delta(1, 'a')); state.apply(delta(1, 'a'));
  state.apply(delta(2, 'b', { append: true }));
  assert.equal(state.snapshot().messages[0].text, 'ab');
  state.apply({ method: 'agent.done', params: { request_id: 'r', async_status: 'completed' } });
  state.apply(delta(1, 'new', {}, 'r2'));
  assert.equal(state.snapshot().messages[1].text, 'new');
  state.apply({ method: 'transport.disconnected' });
  state.apply(history([{ kind: 'text', text: 'authoritative', metadata: { part_id: 'p' } }]));
  assert.equal(state.snapshot().messages[0].text, 'authoritative');
  assert.equal(state.snapshot().status, 'idle');
});

test('post-response optional controls do not turn completed runs into blocked tasks', () => {
  const state = createZoomMateState('s');
  state.apply({ method: 'agent.delta', params: { request_id: 'r', message_id: 'm-r', seq: 1, part: control } });
  assert.equal(state.snapshot().status, 'blocked');
  state.apply({ method: 'agent.done', params: { request_id: 'r', async_status: 'completed' } });
  assert.equal(state.snapshot().status, 'idle');
  assert.equal(state.snapshot().pendingApprovals[0].toolId, 'system_ask_user_confirm_inline');
  state.apply({ method: 'client.accepted', params: { request_id: 'next', message: { role: 'user', message_id: 'next-user', parts: [{ kind: 'text', text: 'A new prompt' }] } } });
  assert.equal(state.snapshot().status, 'working');
  assert.deepEqual(state.snapshot().pendingApprovals, []);
});

test('pendingUser remains blocked across hydration until its actual tool result arrives', () => {
  const state = createZoomMateState('s');
  state.apply(history([control]));
  state.apply({ method: 'session.info', params: { async_status: 'pendingUser' } });
  assert.equal(state.snapshot().status, 'blocked');
  state.apply({ method: 'transport.disconnected' });
  assert.equal(state.snapshot().status, 'unknown');
  state.apply(history([control]));
  assert.equal(state.snapshot().pendingApprovals[0].toolCallId, 'tool-1');
  state.apply({ method: 'agent.delta', params: { request_id: 'r2', message_id: 'reply', seq: 1, part: {
    kind: 'data', metadata: { part_type: 'client_tool_result', part_id: 'result' },
    data: { ...control.data, response: { response_type: 'success', response_content: 'confirmed' } },
  } } });
  assert.deepEqual(state.snapshot().pendingApprovals, []);
});

test('an acknowledged approval clears its control without completing or reopening the native turn', () => {
  const response = { method: 'client.response_accepted', params: { request_id: 'continued',
    message: { message_id: 'client-response', role: 'user', parts: [{
      kind: 'data', metadata: { part_type: 'client_tool_result' },
      data: { ...control.data, response: { response_type: 'success', request_agent_response: true } },
    }] },
  } };
  const state = createZoomMateState('s');
  state.apply(history([control]));
  state.apply({ method: 'session.info', params: { async_status: 'pendingUser' } });
  const continuing = state.apply(response);
  assert.equal(continuing.status, 'working');
  assert.deepEqual(continuing.pendingApprovals, []);
  assert.equal(continuing.activeRequestId, 'continued');
  state.apply({ method: 'agent.done', params: { request_id: 'continued', async_status: 'completed' } });
  assert.equal(state.snapshot().status, 'idle');

  const settled = createZoomMateState('s');
  settled.apply(history([control]));
  settled.apply({ method: 'agent.done', params: { request_id: 'continued', async_status: 'completed' } });
  const late = settled.apply(response);
  assert.equal(late.status, 'idle');
  assert.equal(late.activeRequestId, null);
  assert.deepEqual(late.pendingApprovals, []);
});

test('unknown local requests remain blocked and visible without executing anything', () => {
  const state = createZoomMateState('s');
  state.apply(history([{ ...control, data: { tool_call_id: 'local', tool_type: 'local', tool_id: 'shell', parameters_values: [{ name: 'command', value: 'must not run' }] } }]));
  assert.equal(state.snapshot().status, 'blocked');
  assert.equal(state.snapshot().unsupportedItems[0].part.data.tool_id, 'shell');
  assert.throws(() => state.apply({ method: 'agent.history', params: { messages: [{}] } }), { code: 'UNSUPPORTED_RESPONSE' });
});

test('a late done from another request cannot stop a current run', () => {
  const state = createZoomMateState('s');
  state.apply(delta(1, 'current', {}, 'new'));
  state.apply({ method: 'agent.done', params: { request_id: 'old', async_status: 'completed' } });
  assert.equal(state.snapshot().activeRequestId, 'new');
  assert.equal(state.snapshot().status, 'working');
});
test('completed history does not retain a stale active request', () => {
  const state = createZoomMateState('s');
  state.apply({ method: 'agent.history', params: { session_id: 's', async_status: 'completed',
    active_run: { request_id: 'old-request' }, messages: [] } });
  assert.equal(state.snapshot().activeRequestId, null);
  assert.equal(state.snapshot().status, 'idle');
});

test('a blocked request remains cancellable and its cancelled controls cannot block again', () => {
  const state = createZoomMateState('s');
  state.apply({ method: 'agent.delta', params: { request_id: 'r', message_id: 'm-r', part: control } });
  state.apply({ method: 'agent.done', params: { request_id: 'r', async_status: 'pendingUser' } });
  assert.equal(state.snapshot().activeRequestId, 'r');
  assert.equal(state.snapshot().status, 'blocked');
  state.apply({ method: 'agent.done', params: { request_id: 'r', async_status: 'cancelled' } });
  assert.equal(state.snapshot().status, 'idle');
  assert.equal(state.snapshot().activeRequestId, null);
  assert.equal(state.snapshot().pendingApprovals.length, 0);
});
