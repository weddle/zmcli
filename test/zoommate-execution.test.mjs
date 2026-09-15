import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomMateModeOptions, resolveZoomMateMode, deriveZoomMateExecution } from '../src/zoommate-execution.mjs';

const part = (type, id, data, metadata = {}) => ({ kind: 'data', metadata: { part_type: type, part_id: id, ...metadata }, data });
const browser = (id, fileId) => part('server_tool', id, { tool: 'take_screenshot', action_id: id, status: 'success',
  detail: { canvas_type: 'browser', screenshot_file_id: fileId, page_title: 'Example Domain' } });

test('only the exact enabled native flag permits Advanced; Auto remains omitted otherwise', () => {
  const unrelated = { feature_toggle: { 'mode-toggle': true, task_input_mode_enabled: 'true' } };
  assert.equal(resolveZoomMateMode('auto', unrelated), undefined);
  assert.throws(() => resolveZoomMateMode('advanced', unrelated), { code: 'UNSUPPORTED' });
  assert.deepEqual(zoomMateModeOptions(unrelated).modes, ['auto']);
  const enabled = { feature_toggle: { task_input_mode_enabled: true } };
  assert.equal(resolveZoomMateMode('advanced', enabled), 'advanced');
  assert.equal(resolveZoomMateMode(undefined, enabled), undefined);
  assert.throws(() => resolveZoomMateMode('lite', enabled), { code: 'INVALID_INPUT' });
});

test('screenshots stay associated with their own sandbox rather than the latest one', () => {
  const result = deriveZoomMateExecution([{ message_id: 'run', parts: [
    part('sandbox_update', 'sandbox1', { sandbox_id: 'one', status: 'running', vnc_url: 'https://private.invalid/vnc' }),
    browser('first', 'image1'),
    part('sandbox_update', 'sandbox2', { sandbox_id: 'two', status: 'running' }),
    browser('second', 'image2'),
    part('server_tool_result', 'not-image', { tool_id: 'file_write', response: { file_id: 'markdown-file' } }),
  ] }]);
  assert.deepEqual(result.snapshots.map(snapshot => [snapshot.fileId, snapshot.sandboxId]), [['image1', 'one'], ['image2', 'two']]);
  assert.equal(JSON.stringify(result).includes('/vnc'), false);
  assert.equal(result.tools[0].status, 'success');
});

test('plan updates retain other steps and never infer associations from part IDs', () => {
  const result = deriveZoomMateExecution([{ message_id: 'run', parts: [
    part('plan_outline', 'outline', { steps: [{ plan_step_id: 'step_0', title: 'Visit page' }, { plan_step_id: 'step_1', title: 'Write file' }] }),
    part('plan_step', 'update', { plan_step_id: 'step_0', status: 'completed' }),
    browser('step_0_browser_tool', 'image'),
    part('server_tool', 'file', { tool: 'file_write', status: 'success', detail: { canvas_type: 'file' } }, { plan_step_id: 'step_1' }),
  ] }]);
  assert.deepEqual(result.plan.map(step => [step.title, step.status]), [['Visit page', 'completed'], ['Write file', undefined]]);
  assert.equal(result.tools[0].planStepId, undefined);
  assert.equal(result.tools[1].planStepId, 'step_1');
});

test('tool request and result pair into one lifecycle with terminal error and request metadata', () => {
  const result = deriveZoomMateExecution([
    { message_id: 'request-message', request_id: 'native-request', parts: [
      part('server_tool', 'request-part', { tool: 'file_write', action_id: 'call-1', status: 'running', brief: 'Writing document' }),
    ] },
    { message_id: 'result-message', parts: [
      part('server_tool_result', 'result-part', { tool_id: 'file_write', response: { tool_call_id: 'call-1', status: 'error', error: { code: 'WRITE_FAILED' } } }),
    ] },
  ]);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].toolCallId, 'call-1');
  assert.equal(result.tools[0].status, 'error');
  assert.deepEqual(result.tools[0].error, { code: 'WRITE_FAILED' });
  assert.equal(result.tools[0].requestId, 'native-request');
});
test('same-name calls remain separate and terminal result retains native display data', () => {
  const result = deriveZoomMateExecution([
    { message_id: 'm', request_id: 'r', parts: [
      part('server_tool', 'a', { tool: 'shell_exec', action_id: 'a1', status: 'running', args: { command: 'one' } }),
      part('server_tool', 'b', { tool: 'shell_exec', action_id: 'b1', status: 'running', args: { command: 'two' } }),
      part('server_tool_result', 'ar', { tool_id: 'shell_exec', response: { tool_call_id: 'a1', status: 'success', response_data: { output: 'one' } } }),
    ] },
  ]);
  assert.equal(result.tools.length, 2);
  assert.deepEqual(result.tools.map(tool => [tool.toolCallId, tool.status]), [['a1', 'success'], ['b1', 'running']]);
  assert.deepEqual(result.tools[0].args, { command: 'one' });
  assert.deepEqual(result.tools[0].result, { output: 'one' });
  assert.equal(result.tools[0].isTerminal, true);
  assert.equal(result.tools[1].isActive, true);
});

test('native plan metadata and result merge by step identity across messages', () => {
  const result = deriveZoomMateExecution([
    { message_id: 'outline', request_id: 'r', parts: [part('plan_outline', 'o', { steps: [{ plan_step_id: 's1', title: 'Gather' }, { plan_step_id: 's2', title: 'Write' }] })] },
    { message_id: 'updates', request_id: 'r', parts: [
      part('plan_step_metadata', 'meta', { plan_step_id: 's1', description: 'Read sources' }),
      part('plan_step_result', 'res', { plan_step_id: 's1', status: 'completed', result: { count: 2 } }),
    ] },
  ]);
  assert.deepEqual(result.plan.map(step => [step.stepId, step.title, step.status]), [['s1', 'Gather', 'completed'], ['s2', 'Write', undefined]]);
  assert.equal(result.plan[0].description, 'Read sources');
  assert.deepEqual(result.plan[0].result, { count: 2 });
});

test('authoritative active request keeps unfinished work active only while running', () => {
  const result = deriveZoomMateExecution([
    { message_id: 'old', request_id: 'old-r', parts: [part('server_tool', 'old-tool', { tool: 'shell_exec', action_id: 'old-call', status: 'success' })] },
    { message_id: 'new', request_id: 'new-r', parts: [part('server_tool', 'new-tool', { tool: 'shell_exec', action_id: 'new-call', status: 'running' })] },
  ], { status: 'processing', activeRequestId: 'new-r', completedRequestIds: ['old-r'] });
  const oldTool = result.tools.find(tool => tool.toolCallId === 'old-call');
  const newTool = result.tools.find(tool => tool.toolCallId === 'new-call');
  assert.equal(result.currentRequestId, 'new-r');
  assert.equal(result.turnStatus, 'processing');
  assert.equal(oldTool.current, false);
  assert.equal(oldTool.isTerminal, true);
  assert.equal(oldTool.isActive, false);
  assert.equal(newTool.current, true);
  assert.equal(Boolean(newTool.isTerminal), false);
  assert.equal(newTool.isActive, true);
});

test('reused tool call IDs remain separate across native request IDs', () => {
  const result = deriveZoomMateExecution([
    { message_id: 'first-request', request_id: 'request-a', parts: [
      part('server_tool', 'first-tool', { tool: 'shell_exec', action_id: 'reused', status: 'running', args: { command: 'one' } }),
    ] },
    { message_id: 'second-request', request_id: 'request-b', parts: [
      part('server_tool', 'second-tool', { tool: 'shell_exec', action_id: 'reused', status: 'running', args: { command: 'two' } }),
      part('server_tool_result', 'second-result', { tool_id: 'shell_exec', response: { tool_call_id: 'reused', status: 'success', response_data: { output: 'two' } } }),
    ] },
  ], { status: 'processing', activeRequestId: 'request-b' });
  assert.equal(result.tools.length, 2);
  assert.deepEqual(result.tools.map(tool => [tool.requestId, tool.toolCallId, tool.status, Boolean(tool.isTerminal)]), [
    ['request-a', 'reused', 'running', false],
    ['request-b', 'reused', 'success', true],
  ]);
  assert.deepEqual(result.tools[0].args, { command: 'one' });
  assert.deepEqual(result.tools[1].result, { output: 'two' });
});

test('idle status does not infer completion for unfinished plans or tools', () => {
  const result = deriveZoomMateExecution([{
    message_id: 'idle-message', request_id: 'request-id', parts: [
      part('plan_outline', 'outline', { steps: [{ plan_step_id: 'step-1', title: 'Still working' }] }),
      part('server_tool', 'tool', { tool: 'shell_exec', action_id: 'call-1', status: 'running' }),
    ],
  }], { status: 'idle', activeRequestId: 'request-id' });
  assert.deepEqual(result.plan.map(step => [step.title, step.status, step.current]), [['Still working', undefined, true]]);
  assert.deepEqual(result.tools.map(tool => [tool.status, Boolean(tool.isTerminal), tool.isActive, tool.current]), [['running', false, false, true]]);
});
