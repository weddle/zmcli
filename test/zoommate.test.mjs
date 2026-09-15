import test from 'node:test';
import assert from 'node:assert/strict';
import { runZoomMate } from '../src/zoommate.mjs';
import { createZoomMateBridge } from '../src/zoommate-pi-bridge.mjs';
import { ZoomMateInteractiveMode } from '../src/zoommate-pi-host.mjs';

const identity = { user: { userId: 'user', accountId: 'account' } };
const text = value => ({ kind: 'text', text: value, metadata: { part_type: 'text', part_id: 'text' } });
function fixture({ messages = [], asyncStatus = 'completed', activeRun = null, request, info, run, historyAfter } = {}) {
  const listeners = new Set(), sent = [];
  let joins = 0;
  const notify = (method, params) => { for (const listener of listeners) listener({ method, params }); };
  const transport = {
    identity, connect: async () => ({ connection_id: 'connection', capabilities: ['agent.run'] }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    request: async (path, options) => path.endsWith('/info') ? info?.(path, options) ?? { async_status: asyncStatus } : request(path, options),
    async send(method, params) {
      sent.push({ method, params });
      if (method === 'session.join') {
        const currentMessages = ++joins > 1 ? historyAfter ?? messages : messages;
        notify('agent.history', { session_id: params.session_id, messages: currentMessages, active_run: activeRun, async_status: asyncStatus, seq: 1, has_more: false, next_offset: null, total_count: 0 });
        return { session_id: params.session_id, active_run: activeRun };
      }
      if (method === 'history.load') return { session_id: params.session_id, messages: historyAfter ?? messages, has_more: false, next_offset: null };
      if (method === 'agent.run') {
        if (run) await run(params, notify);
        else {
          // The real provider can complete before the RPC ack is processed.
          notify('agent.delta', { session_id: params.session_id, request_id: params.request_id, message_id: 'reply', seq: 1, part: text('remote reply') });
          notify('agent.done', { session_id: params.session_id, request_id: params.request_id, seq: 2, async_status: 'completed' });
        }
        return { request_id: params.request_id, accepted_at: 1 };
      }
      return { request_id: params.request_id };
    },
  };
  return { session: { identity, openZoomMate: async () => transport, close: async () => {} }, transport, notify, sent, listeners };
}

test('a remote completion before the run acknowledgement is retained with its real session', async () => {
  const f = fixture();
  const result = await runZoomMate(f.session, 'query', { new: true, prompt: 'describe work', 'timeout-ms': 1000 });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.state.status, 'idle');
  assert.equal(result.state.messages.at(-1).text, 'remote reply');
  assert.match(result.sessionId, /^[A-Za-z0-9_-]{21}$/u);
  assert.equal(f.listeners.size, 0);
});

test('selection discovery traverses native pages and sends only the selected remote context', async () => {
  const resource = { id: 'RDP/AK8+zQ==', entity_type: 'meeting', name: 'Chosen meeting', has_summary_permission: true, recurrence: { instance: 2 } };
  const f = fixture({ request: async (path, { body } = {}) => {
    if (path.includes('items/page')) return body.start === 0
      ? { result: [{ id: 'other', name: 'Other', entity_type: 'meeting' }], has_more: true, continuation: [{ search_after: 'page2' }] }
      : { result: [resource], has_more: false, continuation: [] };
    if (path.endsWith('/project-id')) return { id: 'project-id', name: 'Project', project_type: 'project' };
    throw new Error(`Unexpected discovery: ${path}`);
  }, run: async (params, notify) => {
    // Provider contract oracle rejects local access and unresolvable project/reference shapes.
    assert.equal(params.request_configs.browser.use_my_browser, false);
    assert.equal(params.request_scenario.agent_specific_feature.spec_id, 'project-id');
    assert.equal(params.request_scenario.agent_specific_feature.agent_id, '');
    assert.deepEqual(params.message.selected_entities, [resource]);
    assert.equal(params.message.mounted_folder, undefined);
    notify('agent.done', { request_id: params.request_id, session_id: params.session_id, async_status: 'completed' });
  } });
  const result = await runZoomMate(f.session, 'query', { new: true, prompt: 'summarize selected context', entity: ['meeting:RDP/AK8+zQ=='], project: 'project-id' });
  assert.equal(result.outcome, 'completed');
});

test('native resource cursors preserve continuation and reject reuse by another actor', async () => {
  const requests = [];
  const f = fixture({ request: async (path, options) => {
    requests.push(options.body);
    return { result: [{ id: options.body.start ? 'second' : 'first' }], has_more: !options.body.start, continuation: [{ entity_type: 'history_meeting', search_after: 'next' }] };
  } });
  const first = await runZoomMate(f.session, 'resources', { type: 'meeting', limit: 1 });
  const second = await runZoomMate(f.session, 'resources', { type: 'meeting', limit: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].id, 'second');
  assert.deepEqual(requests[1].continuation, [{ entity_type: 'history_meeting', search_after: 'next' }]);
  const other = { ...f.session, identity: { user: { userId: 'other', accountId: 'account' } } };
  await assert.rejects(runZoomMate(other, 'resources', { type: 'meeting', limit: 1, cursor: first.nextCursor }), { code: 'INVALID_INPUT' });
  assert.equal(requests.length, 2);
});

test('missing lists error while valid empty and nonadvancing pages remain distinguishable', async () => {
  const f = fixture({ request: async () => ({ result: [], has_more: false }) });
  assert.equal((await runZoomMate(f.session, 'chats')).coverage.complete, true);
  f.transport.request = async () => ({ result: [], has_more: true, next_offset: 1 });
  const stalled = await runZoomMate(f.session, 'chats');
  assert.equal(stalled.coverage.complete, false);
  assert.equal(stalled.nextCursor, null);
  f.transport.request = async () => ({ has_more: false });
  await assert.rejects(runZoomMate(f.session, 'chats'), { code: 'UNSUPPORTED_RESPONSE' });
});
test('native rename uses one exact update and confirms the conversation title by readback', async () => {
  const calls = [];
  const f = fixture({
    request: async (path, options) => { calls.push({ path, options }); return {}; },
    info: async (path, options) => { calls.push({ path, options }); return { session_id: 'session-1', conversation_title: 'Renamed' }; },
  });
  const result = await runZoomMate(f.session, 'rename', { id: 'session-1', title: ' Renamed ' });
  assert.deepEqual(result, { outcome: 'confirmed', sessionId: 'session-1', title: 'Renamed', verification: 'native-readback' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    path: '/api/v1/session/update',
    options: { method: 'PUT', body: { session_id: 'session-1', title: 'Renamed' }, signal: undefined },
  });
  assert.deepEqual(calls[1], {
    path: '/api/v1/session/session-1/info',
    options: { signal: undefined },
  });
});

test('native rename readback mismatch is unknown and never resends the update', async () => {
  const calls = [];
  const f = fixture({
    request: async (path, options) => { calls.push({ path, options }); return {}; },
    info: async (path, options) => { calls.push({ path, options }); return { session_id: 'session-1', conversation_title: 'Different title' }; },
  });
  await assert.rejects(
    runZoomMate(f.session, 'rename', { id: 'session-1', title: 'Requested title' }),
    error => error.code === 'WRITE_UNCONFIRMED' && error.details?.outcome === 'unknown',
  );
  assert.equal(calls.filter(call => call.path === '/api/v1/session/update').length, 1);
  assert.equal(calls.filter(call => call.path === '/api/v1/session/session-1/info').length, 1);
});


const confirmation = { role: 'assistant', message_id: 'pending-message', parts: [{ kind: 'data', metadata: { part_type: 'client_tool', part_id: 'approval' }, data: {
  tool_type: 'human_in_the_loop', tool_call_id: 'tool1', tool_id: 'system_ask_user_confirmation',
  parameters_values: [{ name: 'message', value: 'Send this exact message to Alice?' }, { name: 'confirmResponseContent', value: 'send now' }, { name: 'cancelResponseContent', value: 'do not send' }],
} }] };

test('pendingUser with a resolved control and no active run accepts an explicit follow-up', async () => {
  const answered = { role: 'user', message_id: 'answered', parts: [{ kind: 'data', metadata: { part_type: 'client_tool_result' },
    data: { tool_call_id: 'tool1', response: { response_type: 'resolved' } } }] };
  const f = fixture({ asyncStatus: 'pendingUser', messages: [confirmation, answered,
    { role: 'assistant', message_id: 'needs-reply', parts: [text('Select the authorized connector and reply.')] }] });
  const result = await runZoomMate(f.session, 'query', { id: 's', prompt: 'The connector is selected; continue the reviewed operation.', 'timeout-ms': 1000 });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.state.messages.at(-1).text, 'remote reply');
  assert.equal(f.sent.filter(item => item.method === 'agent.run').length, 1);
});

test('a follow-up cannot bypass pending controls or a retained native run', async () => {
  for (const waiting of [{ messages: [confirmation] }, { activeRun: { request_id: 'still-active' } }]) {
    const f = fixture({ asyncStatus: 'pendingUser', ...waiting });
    await assert.rejects(runZoomMate(f.session, 'query', { id: 's', prompt: 'Continue without answering the control.' }), { code: 'RUN_ACTIVE' });
    assert.equal(f.sent.filter(item => item.method === 'agent.run').length, 0);
  }
});

test('a live permission gate releases the prompt without waiting for agent.done', async () => {
  const f = fixture({ run: async (params, notify) => {
    notify('agent.delta', { session_id: params.session_id, request_id: params.request_id, message_id: params.request_id,
      seq: 1, part: { kind: 'data', metadata: { part_type: 'client_tool', part_id: 'permission' }, data: {
        tool_type: 'human_in_the_loop', tool_call_id: 'permission', tool_id: 'human_in_the_loop_tool',
        parameters_values: [{ name: 'spec', value: { fields: [], meta: { request_id: params.request_id, quick_approve: true },
          actions: [{ id: 'allow_once', type: 'send', message: 'Allow once' }] } }],
      } } });
  } });
  const result = await runZoomMate(f.session, 'query', { new: true, prompt: 'Perform the reviewed edit.', 'timeout-ms': 20 });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.state.activeRequestId, result.requestId);
  assert.equal(result.state.pendingApprovals[0].toolCallId, 'permission');
  assert.equal(f.sent.some(item => item.method.startsWith('client.')), false);
});

test('cancelling a pending gate waits for native termination rather than returning the gate', async () => {
  const f = fixture({ messages: [{ ...confirmation, message_id: 'active' }], asyncStatus: 'pendingUser', activeRun: { request_id: 'active' } });
  const send = f.transport.send.bind(f.transport);
  f.transport.send = async (method, params) => {
    const result = await send(method, params);
    if (method === 'agent.cancel') setImmediate(() => f.notify('agent.done', {
      session_id: params.session_id, request_id: params.request_id, async_status: 'cancelled',
    }));
    return result;
  };
  const result = await runZoomMate(f.session, 'cancel', { id: 's', 'request-id': 'active', 'timeout-ms': 1000 });
  assert.equal(result.confirmation, 'remote-terminal');
  assert.equal(result.state.activeRequestId, null);
  assert.deepEqual(result.state.pendingApprovals, []);
});

test('approval requires interactive input and never accepts caller-supplied stale details', async () => {
  const f = fixture({ messages: [confirmation], asyncStatus: 'pendingUser' });
  await assert.rejects(runZoomMate(f.session, 'approve', { id: 's' }), { code: 'PROVIDER_APPROVAL_REQUIRED' });
  await assert.rejects(runZoomMate(f.session, 'approve', { id: 's', confirmApproval: async detail => {
    assert.equal(detail.pending.toolCallId, 'tool1'); return false;
  } }), { code: 'PROVIDER_APPROVAL_REQUIRED' });
  assert.equal(f.sent.filter(item => item.method.startsWith('client.')).length, 0);
});

test('approval answered in another client while confirmation is open is never resent', async () => {
  const f = fixture({ messages: [confirmation], asyncStatus: 'pendingUser', historyAfter: [] });
  await assert.rejects(runZoomMate(f.session, 'approve', { id: 's', confirmApproval: async () => ({ choice: 'confirm' }) }), { code: 'STALE_APPROVAL' });
  assert.equal(f.sent.filter(item => item.method.startsWith('client.')).length, 0);
});

test('live permission approval validates fresh replay rather than incomplete persisted history', async t => {
  for (const scenario of [
    { name: 'replay before join acknowledgement' },
    { name: 'replay after join acknowledgement', delayed: true },
    { name: 'changed live scope is refused', delayed: true, changed: true },
    { name: 'answered live permission is not resent', delayed: true, resolved: true },
  ]) await t.test(scenario.name, async () => {
    const f = fixture({ messages: [{ role: 'user', message_id: 'prompt', parts: [text('Edit Alpha.')] }],
      asyncStatus: 'processing', activeRun: { request_id: 'active' } });
    const send = f.transport.send.bind(f.transport);
    let reviewed = false;
    f.transport.send = async (method, params) => {
      const result = await send(method, params);
      if (method === 'session.join') {
        const replay = () => {
          const part = reviewed && scenario.resolved
            ? { kind: 'data', metadata: { part_type: 'client_tool_result' }, data: {
              tool_call_id: 'permission', response: { response_type: 'resolved' },
            } }
            : { kind: 'data', metadata: { part_type: 'client_tool', part_id: 'permission' }, data: {
              tool_type: 'human_in_the_loop', tool_call_id: 'permission', tool_id: 'human_in_the_loop_tool',
              parameters_values: [{ name: 'spec', value: {
                title: reviewed && scenario.changed ? 'Different operation' : 'Edit Alpha',
                fields: [], meta: { request_id: 'active', quick_approve: true },
                actions: [{ id: 'allow_once', type: 'send', message: 'User allowed once' }],
              } }],
            } };
          f.notify('agent.delta', { session_id: params.session_id, request_id: 'active', message_id: 'active', seq: 2, part });
          if (reviewed && scenario.resolved) f.notify('agent.done', { session_id: params.session_id, request_id: 'active', async_status: 'completed' });
        };
        if (scenario.delayed) setImmediate(replay); else replay();
      }
      return result;
    };
    const approval = runZoomMate(f.session, 'approve', { id: 's', 'timeout-ms': 1000, confirmApproval: async detail => {
      assert.equal(detail.pending.data.parameters_values[0].value.title, 'Edit Alpha');
      reviewed = true; return { choice: 'allow_once' };
    } });
    if (scenario.changed || scenario.resolved) await assert.rejects(approval, { code: 'STALE_APPROVAL' });
    else assert.equal((await approval).outcome, 'acknowledged');
    assert.equal(f.sent.filter(item => item.method === 'client.hitlResolve').length, scenario.changed || scenario.resolved ? 0 : 1);
  });
});

test('explicit cancellation decision uses the provider-declared response rather than fake success', async () => {
  const f = fixture({ messages: [confirmation], asyncStatus: 'pendingUser' });
  const result = await runZoomMate(f.session, 'approve', { id: 's', confirmApproval: async () => ({ choice: 'cancel' }) });
  assert.equal(result.outcome, 'acknowledged');
  const resolution = f.sent.find(item => item.method === 'client.toolResult').params;
  assert.equal(resolution.message.parts[0].data.response.response_content, 'do not send');
  assert.equal(resolution.message.parts[0].data.response.response_type, 'error');
  assert.equal(resolution.message.parts[0].data.tool_call_id, 'tool1');
});

test('signal detaches without sending agent.cancel or replaying agent.run', async () => {
  const controller = new AbortController();
  const f = fixture({ run: async () => { controller.abort(); } });
  const result = await runZoomMate(f.session, 'query', { new: true, prompt: 'describe', signal: controller.signal });
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.state.status, 'unknown');
  assert.deepEqual(f.sent.map(item => item.method), ['agent.run']);
});

test('disabled Advanced and unknown artifact references cannot start native runs', async () => {
  const f = fixture();
  await assert.rejects(runZoomMate(f.session, 'query', { new: true, prompt: 'work', mode: 'advanced' }), { code: 'UNSUPPORTED' });
  await assert.rejects(runZoomMate(f.session, 'query', { id: 'session', prompt: 'work', artifact: ['document:not-in-history'] }), { code: 'TARGET_NOT_FOUND' });
  assert.equal(f.sent.filter(item => item.method === 'agent.run').length, 0);
});

test('changing proposed XML during human review invalidates a document approval', async () => {
  const messages = [{ message_id: 'proposal', role: 'assistant', parts: [
    { kind: 'text', text: '<update id="block"><text>Approved value</text></update>', metadata: {
      part_type: 'update_doc', part_id: 'edit-part', doc_id: 'doc', edit_id: 'edit', last_chunk: true, force_accept: false,
    } },
    { kind: 'data', metadata: { part_type: 'client_tool', part_id: 'approval' }, data: {
      tool_type: 'human_in_the_loop', tool_id: 'human_in_the_loop_tool', tool_call_id: 'approve-edit',
      parameters_values: [{ name: 'spec', value: { fields: [{ type: 'edit_canvas_card', props: { edit_id: 'edit', transaction_id: 'transaction' } }],
        actions: [{ id: 'canvas_accept', type: 'submit', message: 'Accept' }], meta: { quick_approve: true, path_a_resume: true } } }],
    } },
  ] }];
  const changed = structuredClone(messages); changed[0].parts[0].text = '<update id="block"><text>Unreviewed value</text></update>';
  const f = fixture({ messages, historyAfter: changed, asyncStatus: 'pendingUser' });
  f.transport.openDocs = async () => ({ identity, close() {}, request: async path => {
    if (path.includes('batch_get')) return { successItems: [{ id: 'doc', fileType: 'doc', title: 'Document', fileClusterApiPrefix: 'https://docs.zoom.us',
      privilege: { permissionWithReason: { edit: { hasPermission: true } } } }] };
    if (path.includes('/content?')) return { content: { data: Buffer.from(JSON.stringify({ blocks: {
      doc: { id: 'doc', version: 3, type: 'BLOCK_TYPE_PAGE', content: { title: 'Document' }, style: {} },
      block: { id: 'block', parentId: 'doc', seq: 'a0', type: 'BLOCK_TYPE_PARAGRAPH', content: { title: '[[0,"Before"]]' }, style: {} },
    } })).toString('base64') } };
    assert.fail('Changed approval must not submit a document mutation.');
  } });
  await assert.rejects(runZoomMate(f.session, 'approve', { id: 'session', confirmApproval: async () => ({ choice: 'canvas_accept' }) }), { code: 'STALE_APPROVAL' });
  assert.equal(f.sent.filter(item => item.method.startsWith('client.')).length, 0);
});

test('approval continuation retains completion arriving before its acknowledgement', async () => {
  const f = fixture({ messages: [confirmation], asyncStatus: 'pendingUser' }), original = f.transport.send.bind(f.transport);
  f.transport.send = async (method, params) => {
    if (method !== 'client.toolResult') return original(method, params);
    await original(method, params);
    f.notify('agent.delta', { session_id: 'session', request_id: 'continued-run', message_id: 'continued-run', seq: 1, part: text('Continued after approval') });
    f.notify('agent.done', { session_id: 'session', request_id: 'continued-run', seq: 2, async_status: 'completed' });
    return { request_id: 'continued-run' };
  };
  const result = await runZoomMate(f.session, 'approve', { id: 'session', wait: true, 'timeout-ms': 1000, confirmApproval: async () => ({ choice: 'confirm' }) });
  assert.equal(result.continuation?.outcome, 'completed');
  assert.equal(f.sent.filter(item => item.method === 'client.toolResult').length, 1);
  assert.equal(f.listeners.size, 0);
});
test('path-A approval waits for the explicit target before a different acknowledgement and answers once', async () => {
  const targetRequestId = 'pending-message';
  const pending = { message_id: targetRequestId, request_id: 'envelope-request', role: 'assistant', parts: [{
    kind: 'data', metadata: { part_type: 'client_tool' }, data: {
      tool_type: 'human_in_the_loop', tool_id: 'human_in_the_loop_tool', tool_call_id: 'path-a-control',
      parameters_values: [{ name: 'spec', value: { fields: [{ type: 'display' }],
        actions: [{ id: 'confirm', type: 'submit', message: 'Continue' }], meta: { path_a_resume: true, quick_approve: true } } }],
    },
  }] };
  const f = fixture({ messages: [pending], asyncStatus: 'pendingUser' }), original = f.transport.send.bind(f.transport);
  let responses = 0;
  f.transport.send = async (method, params) => {
    if (method !== 'client.hitlResolve') return original(method, params);
    assert.equal(params.target_request_id, targetRequestId);
    responses++;
    await original(method, params);
    f.notify('agent.delta', { session_id: params.session_id, request_id: targetRequestId, message_id: 'continued-run', seq: 1, part: text('Continued after approval') });
    f.notify('agent.done', { session_id: params.session_id, request_id: targetRequestId, seq: 2, async_status: 'completed' });
    return { request_id: 'acknowledgement-request' };
  };
  const result = await runZoomMate(f.session, 'approve', { id: 'session', wait: true, 'timeout-ms': 1000, confirmApproval: async () => ({ choice: 'confirm' }) });
  assert.equal(result.continuation?.outcome, 'completed');
  assert.equal(result.continuation?.requestId, targetRequestId);
  assert.equal(responses, 1);
  assert.equal(f.sent.filter(item => item.method === 'client.hitlResolve').length, 1);
});

test('quick permission continuation follows the original run rather than its response acknowledgement', async () => {
  const pending = { message_id: 'original-run', role: 'assistant', parts: [{
    kind: 'data', metadata: { part_type: 'client_tool' }, data: {
      tool_type: 'human_in_the_loop', tool_id: 'human_in_the_loop_tool', tool_call_id: 'permission',
      parameters_values: [{ name: 'spec', value: { fields: [], meta: { quick_approve: true, request_id: 'original-run' },
        actions: [{ id: 'deny', type: 'send', message: 'User denied' }] } }],
    },
  }] };
  const f = fixture({ messages: [pending], asyncStatus: 'pendingUser' }), send = f.transport.send.bind(f.transport);
  f.transport.send = async (method, params) => {
    const result = await send(method, params);
    if (method !== 'client.hitlResolve') return result;
    f.notify('agent.delta', { session_id: params.session_id, request_id: 'original-run', message_id: 'original-run',
      seq: 1, part: text('Permission denied; nothing changed.') });
    f.notify('agent.done', { session_id: params.session_id, request_id: 'original-run', seq: 2, async_status: 'completed' });
    return { request_id: params.request_id };
  };
  let latestState;
  const result = await runZoomMate(f.session, 'approve', { id: 's', wait: true, 'timeout-ms': 20,
    onEvent: event => { if (event.state) latestState = event.state; }, confirmApproval: async () => ({ choice: 'deny' }) });
  assert.equal(result.continuation.outcome, 'completed');
  assert.equal(result.continuation.requestId, 'original-run');
  assert.equal(latestState.status, 'idle');
  assert.equal(f.sent.filter(item => item.method === 'client.hitlResolve').length, 1);
});

test('approval with neither acknowledgement nor explicit target fails unconfirmed without replay', async () => {
  const f = fixture({ messages: [confirmation], asyncStatus: 'pendingUser' }), original = f.transport.send.bind(f.transport);
  f.transport.send = async (method, params) => method === 'client.toolResult' ? (await original(method, params), {}) : original(method, params);
  await assert.rejects(
    runZoomMate(f.session, 'approve', { id: 'session', wait: true, 'timeout-ms': 20, confirmApproval: async () => ({ choice: 'confirm' }) }),
    error => error.code === 'WRITE_UNCONFIRMED' && error.details?.outcome === 'unknown',
  );
  assert.equal(f.sent.filter(item => item.method === 'client.toolResult').length, 1);
  assert.equal(f.sent.filter(item => item.method === 'agent.run').length, 0);
});
test('terminal cancellation remains confirmed when its native acknowledgement rejects', async () => {
  const f = fixture({ asyncStatus: 'processing', activeRun: { request_id: 'request-1' } }), original = f.transport.send.bind(f.transport);
  f.transport.send = async (method, params) => {
    if (method === 'agent.cancel') {
      f.notify('agent.done', { session_id: params.session_id, request_id: params.request_id, async_status: 'cancelled' });
      const error = new Error('cancel acknowledgement failed'); error.code = 'REQUEST_FAILED'; throw error;
    }
    return original(method, params);
  };
  const result = await runZoomMate(f.session, 'cancel', { id: 'session', 'request-id': 'request-1', 'timeout-ms': 1000 });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.confirmation, 'remote-terminal');
  assert.equal(result.result.async_status, 'cancelled');
  assert.equal(result.acknowledgementError.code, 'REQUEST_FAILED');
});

test('terminal authentication failure remains failed instead of becoming completion', async () => {
  const f = fixture({ run: async (params, notify) => notify('agent.error', {
    session_id: params.session_id, request_id: params.request_id, code: 'AUTH_REQUIRED', message: 'sign in again',
  }) });
  const result = await runZoomMate(f.session, 'query', { new: true, prompt: 'work', 'timeout-ms': 1000 });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error.code, 'AUTH_REQUIRED');
});
test('cancel acknowledgement is not mistaken for a remote stop, while completion before ack is retained', async () => {
  const f = fixture({ asyncStatus: 'processing', activeRun: { request_id: 'request-1' } }), original = f.transport.send.bind(f.transport);
  f.transport.send = async (method, params) => {
    if (method !== 'agent.cancel') return original(method, params);
    f.notify('agent.done', { session_id: params.session_id, request_id: params.request_id, async_status: 'cancelled' });
    return { accepted: true };
  };
  const confirmed = await runZoomMate(f.session, 'cancel', { id: 'session', 'request-id': 'request-1' });
  assert.equal(confirmed.outcome, 'completed');
  assert.equal(confirmed.confirmation, 'remote-terminal');

  const pending = fixture({ asyncStatus: 'processing', activeRun: { request_id: 'request-1' } });
  const pendingSend = pending.transport.send.bind(pending.transport);
  pending.transport.send = async (method, params) => method === 'agent.cancel' ? { accepted: true } : pendingSend(method, params);
  const acknowledged = await runZoomMate(pending.session, 'cancel', { id: 'session', 'request-id': 'request-1', 'timeout-ms': 5 });
  assert.equal(acknowledged.outcome, 'acknowledged');
  assert.equal(acknowledged.confirmation, 'unconfirmed');
});

test('a detached transport follows the native turn without replaying or cancelling it', async () => {
  const controller = new AbortController(), activeRun = { request_id: null }, notices = [];
  const f = fixture({ asyncStatus: 'processing', activeRun, run: async params => { activeRun.request_id = params.request_id; controller.abort(); } });
  const bridge = await createZoomMateBridge({}, { connect: async () => f.session });
  try {
    bridge.subscribe((state, kind) => notices.push({ state, kind }));
    const detached = await bridge.query('work', { signal: controller.signal });
    assert.equal(detached.outcome, 'unknown');
    await new Promise(setImmediate);
    assert.equal(bridge.following, true);
    assert.equal(bridge.busy, false);
    f.notify('agent.delta', { session_id: bridge.sessionId, request_id: activeRun.request_id, message_id: 'answer', part: text('Final remote answer') });
    f.notify('agent.done', { session_id: bridge.sessionId, request_id: activeRun.request_id, async_status: 'completed' });
    await new Promise(setImmediate);
    assert.equal(bridge.following, false);
    assert.equal(bridge.state.status, 'idle');
    assert.equal(bridge.state.messages.at(-1).text, 'Final remote answer');
    assert.equal(notices.at(-1).kind, 'reconcile');
    assert.equal(f.sent.filter(item => item.method === 'agent.run').length, 1);
    assert.equal(f.sent.filter(item => item.method === 'agent.cancel').length, 0);
  } finally { await bridge.close(); }
});

test('resume follows a running turn, while switching rejects stale follower updates', async () => {
  const f = fixture({ asyncStatus: 'processing', activeRun: { request_id: 'run' } });
  const bridge = await createZoomMateBridge({}, { connect: async () => f.session });
  try {
    await bridge.resume('first'); await new Promise(setImmediate);
    assert.equal(bridge.following, true);
    await bridge.resume('second'); await new Promise(setImmediate);
    f.notify('agent.delta', { session_id: 'first', request_id: 'run', message_id: 'old-answer', part: text('Stale') });
    f.notify('agent.done', { session_id: 'first', request_id: 'run', async_status: 'completed' });
    await new Promise(setImmediate);
    assert.equal(bridge.sessionId, 'second');
    assert.equal(bridge.state.status, 'working');
    assert.equal(bridge.state.messages.length, 0);
    f.notify('agent.delta', { session_id: 'second', request_id: 'run', message_id: 'new-answer', part: text('Current answer') });
    f.notify('agent.done', { session_id: 'second', request_id: 'run', async_status: 'completed' });
    await new Promise(setImmediate);
    assert.equal(bridge.state.status, 'idle');
    assert.equal(bridge.state.messages.at(-1).text, 'Current answer');
    assert.equal(f.sent.filter(item => item.method === 'agent.run').length, 0);
  } finally { await bridge.close(); }
});

test('terminal native history with a retained request does not hang watch', async () => {
  const f = fixture({ activeRun: { request_id: 'old' } });
  const result = await runZoomMate(f.session, 'watch', { id: 'session', 'timeout-ms': 5 });
  assert.equal(result.outcome, 'idle');
  assert.equal(result.state.status, 'idle');
  assert.equal(f.listeners.size, 0);
});

test('cancel observes completion after acknowledgement and rejects a stale target without writing', async () => {
  const f = fixture({ asyncStatus: 'processing', activeRun: { request_id: 'current' } }), original = f.transport.send.bind(f.transport);
  f.transport.send = async (method, params) => {
    const result = await original(method, params);
    if (method === 'agent.cancel') setImmediate(() => f.notify('agent.done', { session_id: params.session_id, request_id: params.request_id, async_status: 'cancelled' }));
    return result;
  };
  await assert.rejects(runZoomMate(f.session, 'cancel', { id: 'session', 'request-id': 'old' }), { code: 'STALE_REQUEST' });
  assert.equal(f.sent.filter(item => item.method === 'agent.cancel').length, 0);
  const result = await runZoomMate(f.session, 'cancel', { id: 'session', 'request-id': 'current', 'timeout-ms': 1000 });
  assert.equal(result.confirmation, 'remote-terminal');
  assert.equal(result.result.async_status, 'cancelled');
  assert.equal(result.state.status, 'idle');
  assert.equal(f.sent.filter(item => item.method === 'agent.cancel').length, 1);
  assert.equal(f.listeners.size, 0);
});

test('repeated editor interrupts do not resend an unconfirmed remote stop', async () => {
  const f = fixture({ asyncStatus: 'processing', activeRun: { request_id: 'run' } }), original = f.transport.send.bind(f.transport);
  f.transport.send = async (method, params) => {
    const result = await original(method, params);
    if (method === 'agent.cancel') f.notify('transport.disconnected', {});
    return result;
  };
  const bridge = await createZoomMateBridge({}, { connect: async () => f.session });
  const mode = Object.assign({ interruptTurn: ZoomMateInteractiveMode.prototype.interruptTurn, reconcileInterrupt: ZoomMateInteractiveMode.prototype.reconcileInterrupt }, {
    bridge, session: { isStreaming: false }, showStatus() {}, showWarning() {},
  });
  try {
    await bridge.resume('session'); await new Promise(setImmediate);
    mode.interruptTurn(); mode.interruptTurn();
    await new Promise(setImmediate);
    assert.equal(bridge.stopping, false);
    assert.equal(bridge.state.status, 'working');
    mode.interruptTurn();
    await new Promise(setImmediate);
    assert.equal(f.sent.filter(item => item.method === 'agent.cancel').length, 1);
    assert.equal(f.sent.filter(item => item.method === 'agent.run').length, 0);
  } finally { await bridge.close(); }
});

test('interrupt before run acknowledgement stops the identified in-flight request without replay', async () => {
  const controller = new AbortController(), activeRun = { request_id: null };
  let release;
  const acknowledged = new Promise(resolve => { release = resolve; });
  const f = fixture({ asyncStatus: 'processing', activeRun, run: async params => {
    activeRun.request_id = params.request_id; await acknowledged;
  } });
  const bridge = await createZoomMateBridge({}, { connect: async () => f.session });
  const mode = Object.assign({ interruptTurn: ZoomMateInteractiveMode.prototype.interruptTurn, reconcileInterrupt: ZoomMateInteractiveMode.prototype.reconcileInterrupt }, {
    bridge, session: { isStreaming: true }, showStatus() {}, showWarning() {},
    localEscape: () => controller.abort(),
  });
  bridge.subscribe(() => mode.reconcileInterrupt());
  try {
    const query = bridge.query('work', { signal: controller.signal });
    await new Promise(setImmediate);
    mode.interruptTurn();
    assert.equal(controller.signal.aborted, true);
    release(); await query; await new Promise(setImmediate);
    assert.equal(f.sent.filter(item => item.method === 'agent.cancel').length, 1);
    assert.equal(f.sent.find(item => item.method === 'agent.cancel').params.request_id, activeRun.request_id);
    f.notify('agent.done', { session_id: bridge.sessionId, request_id: activeRun.request_id, async_status: 'cancelled' });
    await new Promise(setImmediate);
    assert.equal(bridge.state.status, 'idle');
    assert.equal(f.sent.filter(item => item.method === 'agent.run').length, 1);
  } finally { release(); await bridge.close(); }
});
