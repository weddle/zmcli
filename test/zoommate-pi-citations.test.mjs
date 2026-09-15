import test from 'node:test';
import assert from 'node:assert/strict';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { deriveZoomMateCitations } from '../src/zoommate-citations.mjs';
import { renderZoomMateCitations } from '../src/zoommate-pi-citations.mjs';

test('collapsed source cards omit excerpts until explicitly expanded', () => {
  initTheme('dark');
  const group = deriveZoomMateCitations([{ message_id: 'message', role: 'assistant', parts: [{ kind: 'text', text: 'Answer [^1]',
    metadata: { part_type: 'text', part_id: 'answer', citation: [{ citation_id: 1, citation_type: 'zoom_doc', citation_title: 'Document',
      citation_text: 'Excerpt from Document', citation_url: 'https://docs.zoom.us/doc/source' }] } }] }])[0];
  const theme = { bold: text => text, fg: (_color, text) => text };
  const collapsed = renderZoomMateCitations({ details: group }, { expanded: false }, theme).render(65).join('\n');
  const expanded = renderZoomMateCitations({ details: group }, { expanded: true }, theme).render(65).join('\n');
  assert.doesNotMatch(collapsed, /Excerpt from Document/);
  assert.match(expanded, /Excerpt from Document/);
  assert.match(expanded, /https:\/\/docs.zoom.us\/doc\/source/);
});
