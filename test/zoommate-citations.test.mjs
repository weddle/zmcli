import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoomMateState } from '../src/zoommate-state.mjs';
import { deriveZoomMateCitations } from '../src/zoommate-citations.mjs';

const source = (title, type = 'zoom_doc') => ({ citation_id: 1, citation_type: type, citation_title: title,
  citation_text: `Excerpt from ${title}`, citation_url: 'https://docs.zoom.us/doc/source', source_id: title });
const part = (id, citation, tags) => ({ kind: 'text', text: 'A sourced answer [^1]', metadata: { part_type: 'text', part_id: id, citation: [citation], ...(tags ? { tags } : {}) } });

test('citation markers remain bound to their own response across history restoration', () => {
  const messages = [
    { message_id: 'first', role: 'assistant', parts: [part('answer', source('First document'))] },
    { message_id: 'second', role: 'assistant', parts: [part('answer', source('Planning meeting', 'meeting'))] },
  ];
  const state = createZoomMateState('session').apply({ method: 'agent.history', params: { messages } });
  assert.deepEqual(state.citations.map(group => [group.messageId, group.citations[0].title]), [['first', 'First document'], ['second', 'Planning meeting']]);
  assert.notEqual(state.citations[0].citations[0].key, state.citations[1].citations[0].key);
});

test('guardrail replacement hides citations belonging to superseded assistant text', () => {
  const result = deriveZoomMateCitations([{ message_id: 'message', role: 'assistant', parts: [
    part('provisional', source('Superseded source')), part('replacement', source('Allowed source'), ['guardrail']),
  ] }]);
  assert.deepEqual(result.map(group => group.citations.map(citation => citation.title)), [['Allowed source']]);
});

test('native source links reject credentials and unsafe schemes while retaining evidenced metadata links', () => {
  const citation = { ...source('Meeting'), citation_url: 'javascript:alert(1)', metadata: { url: 'https://name:secret@example.com/', meeting_url: 'https://zoom.us/meeting/verified' } };
  const result = deriveZoomMateCitations([{ message_id: 'message', role: 'assistant', parts: [part('answer', citation)] }]);
  assert.equal(result[0].citations[0].url, 'https://zoom.us/meeting/verified');
});


test('observed named citation markers remain expandable without invented source identities', () => {
  const result = deriveZoomMateCitations([{ message_id: 'answer', role: 'assistant', parts: [{
    kind: 'text', text: 'Heading from the file. ^[verification.md]\nDecision from the meeting. ^[Planning meeting summary]',
    metadata: { part_type: 'text', part_id: 'answer-text' },
  }] }]);
  assert.deepEqual(result[0].citations.map(citation => [citation.title, citation.sourceId, citation.url]),
    [['verification.md', null, null], ['Planning meeting summary', null, null]]);
  assert.ok(result[0].citations.every(citation => citation.type === 'unresolved'));
});

test('citation examples inside code are not promoted to response sources', () => {
  const result = deriveZoomMateCitations([{ message_id: 'answer', role: 'assistant', parts: [{
    kind: 'text', text: 'An example `^[not a source]`.\n```text\n^[also not a source]\n```\nA real marker [^7].',
    metadata: { part_type: 'text', part_id: 'answer-text' },
  }] }]);
  assert.deepEqual(result[0].citations.map(citation => citation.marker), ['[^7]']);
});
