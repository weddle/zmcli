import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoomMateState } from '../src/zoommate-state.mjs';
import { deriveZoomMateArtifacts, renderZoomMateDocumentXml, renderZoomMateDocumentBlocks } from '../src/zoommate-artifacts.mjs';

const message = (id, ...parts) => ({ message_id: id, role: 'assistant', parts });
const document = (type, xml, metadata = {}) => ({ kind: 'text', text: xml, metadata: { part_type: type, part_id: type, doc_id: 'doc1', title: 'Verification', last_chunk: true, ...metadata } });
const create = message('create', document('create_doc', '<document><h1>Verification</h1><uli>First value: alpha</uli></document>'));
const update = message('update', document('update_doc', '<update id="block1"><uli>First value: gamma</uli></update>', { edit_id: 'edit1', force_accept: false }), {
  kind: 'data', metadata: { part_type: 'client_tool', part_id: 'approval' }, data: {
    tool_call_id: 'approve1', tool_type: 'human_in_the_loop', tool_id: 'human_in_the_loop_tool',
    parameters_values: [{ name: 'spec', value: { fields: [{ type: 'edit_canvas_card', props: { edit_id: 'edit1', transaction_id: 'transaction1' } }] } }],
  },
});
const resolve = action => message('resolve', { kind: 'data', metadata: { part_type: 'client_tool_result', part_id: 'answer' },
  data: { tool_call_id: 'approve1', response: { response_type: 'resolved', response_data: { action_id: action } } } });

test('native document XML becomes an artifact rather than assistant narration', () => {
  const state = createZoomMateState('session').apply({ method: 'agent.history', params: { messages: [create] } });
  assert.equal(state.messages[0].text, '');
  assert.equal(state.artifacts[0].markdown, '# Verification\n\n- First value: alpha');
});

test('pending and rejected document edits never replace saved content with the proposal', () => {
  const pending = deriveZoomMateArtifacts([create, update]).artifacts[0];
  assert.equal(pending.status, 'pending');
  assert.match(pending.markdown, /alpha/);
  assert.doesNotMatch(pending.markdown, /gamma/);
  assert.match(pending.update.markdown, /gamma/);
  assert.equal(pending.update.transactionId, 'transaction1');
  const rejected = deriveZoomMateArtifacts([create, update, resolve('canvas_reject')]).artifacts[0];
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.markdown, /alpha/);
  const accepted = deriveZoomMateArtifacts([create, update, resolve('canvas_accept')]).artifacts[0];
  assert.equal(accepted.status, 'ready');
  assert.equal(accepted.needsRead, true);
});

test('artifact identity comes from native metadata and flat attachments, never a title', () => {
  const result = deriveZoomMateArtifacts([create, message('files', { kind: 'data', metadata: { part_type: 'summary_attachments' }, data: {
    attachments_v2: [{ id: 'file1', name: 'same.md' }, { id: 'file2', name: 'same.md' }, { name: 'missing.md' }],
  } })]);
  assert.deepEqual(result.artifacts.map(artifact => artifact.key), ['document:doc1', 'file:file1', 'file:file2']);
  assert.equal(result.unsupported.length, 1);
  assert.equal(result.unsupported[0].reason, 'MISSING_ARTIFACT_ID');
});

test('unsafe XML and incomplete streams cannot masquerade as complete previews', () => {
  const unsafe = renderZoomMateDocumentXml('<!DOCTYPE document [<!ENTITY x "secret">]><document>&x;</document>');
  assert.equal(unsafe.complete, false);
  assert.equal(unsafe.markdown, '');
  const partial = renderZoomMateDocumentXml('<document><text>unfinished', { partial: true });
  assert.equal(partial.complete, false);
  assert.equal(partial.markdown, '');
  assert.equal(renderZoomMateDocumentXml('<document><text>unfinished').unsupported[0].reason, 'MALFORMED_XML');
});

test('canonical native blocks retain hierarchy and compact text formatting', () => {
  const preview = renderZoomMateDocumentBlocks([
    { id: 'root', type: 'BLOCK_TYPE_PAGE' },
    { id: 'nested', parentId: 'list', seq: 'a0', type: 'BLOCK_TYPE_BULLET', content: { title: '[[0,"Nested"]]' } },
    { id: 'list', parentId: 'root', seq: 'a1', type: 'BLOCK_TYPE_BULLET', content: { title: JSON.stringify([[0, 'Value', '8:1|26:"author"']]) } },
    { id: 'heading', parentId: 'root', seq: 'a0', type: 'BLOCK_TYPE_HEADING1', content: { title: '[[0,"Title"]]' } },
  ], 'root');
  assert.equal(preview.markdown, '# Title\n\n- **Value**\n  - Nested');
  assert.equal(preview.complete, true);
});
