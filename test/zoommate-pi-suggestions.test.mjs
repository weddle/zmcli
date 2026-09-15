import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoomMateState } from '../src/zoommate-state.mjs';
import { registerZoomMateSuggestions } from '../src/zoommate-pi-suggestions.mjs';

const savePart = (prompt, partId = 'save-1') => ({ kind: 'data', metadata: { part_type: 'save_template', part_id: partId }, data: { prompt } });
const history = parts => ({ method: 'agent.history', params: { session_id: 's', messages: [{ role: 'assistant', message_id: 'assistant-1', parts }] } });

test('valid save_template is a native suggestion and not unsupported', () => {
  const state = createZoomMateState('s');
  state.apply(history([savePart('Create a reusable skill for this task.') ]));
  const snapshot = state.snapshot();
  assert.deepEqual(snapshot.suggestions.map(({ messageId, partId, type, prompt }) => ({ messageId, partId, type, prompt })), [{
    messageId: 'assistant-1', partId: 'save-1', type: 'save_template', prompt: 'Create a reusable skill for this task.',
  }]);
  assert.equal(snapshot.unsupportedItems.some(item => item.partType === 'save_template'), false);
});

test('malformed save_template remains unsupported and creates no suggestion', () => {
  const state = createZoomMateState('s');
  state.apply(history([savePart('', 'bad-empty'), { kind: 'data', metadata: { part_type: 'save_template', part_id: 'bad-type' }, data: {} },
    { ...savePart('Wrong part kind'), kind: 'text' }]));
  const snapshot = state.snapshot();
  assert.equal(snapshot.suggestions.length, 0);
  assert.equal(snapshot.unsupportedItems.filter(item => item.partType === 'save_template').length, 3);
});

test('suggestion selection loads only into an empty editor and never sends remotely', async () => {
  let command, editor = '';
  const pi = { registerMessageRenderer() {}, registerCommand(_name, spec) { command = spec; }, sendUserMessage() { assert.fail('Suggestion must not dispatch'); } };
  const bridge = { sessionId: 's', state: { sessionId: 's', suggestions: [{ messageId: 'm', partId: 'p', type: 'save_template', prompt: 'exact native prompt' }] },
    run() { assert.fail('Suggestion must not call remote operations'); }, query() { assert.fail('Suggestion must not dispatch'); } };
  registerZoomMateSuggestions(pi, bridge);
  await command.handler('', { ui: { select: async (_title, choices) => choices[0], getEditorText: () => editor,
    setEditorText(value) { editor = value; }, notify() {} } });
  assert.equal(editor, 'exact native prompt');
  editor = 'existing draft';
  await command.handler('', { ui: { select: async (_title, choices) => choices[0], getEditorText: () => editor,
    setEditorText(value) { editor = value; }, notify() {} } });
  assert.equal(editor, 'existing draft');
});

test('a changed conversation cannot load a previously displayed suggestion', async () => {
  let command, editor = '';
  const bridge = { sessionId: 's', state: { sessionId: 's', suggestions: [{ messageId: 'm', partId: 'p', type: 'save_template', prompt: 'old prompt' }] } };
  registerZoomMateSuggestions({ registerMessageRenderer() {}, registerCommand(_name, spec) { command = spec; } }, bridge);
  await command.handler('', { ui: {
    async select(_title, choices) { bridge.sessionId = 'other'; return choices[0]; },
    getEditorText: () => editor, setEditorText(value) { editor = value; }, notify() {},
  } });
  assert.equal(editor, '');
});
