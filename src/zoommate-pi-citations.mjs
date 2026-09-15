import { Container, Markdown, Text, stripTerminalSequences } from '@earendil-works/pi-tui';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { showZoomMateText } from './zoommate-pi-artifacts.mjs';

const clean = value => stripTerminalSequences(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
const label = value => clean(value).replace(/\s+/gu, ' ').trim();
const escape = value => clean(value).replace(/([\\`*_{}\[\]<>#|])/gu, '\\$1');
const typeLabel = type => ({ zoom_doc: 'Document', zoom_meeting_summary: 'Meeting summary', zoom_meeting_agenda: 'Meeting agenda',
  meeting: 'Meeting', recording: 'Recording', chat: 'Chat', chat_channel: 'Chat channel', web: 'Web', file: 'File', notes: 'Notes' })[type] ?? label(type).replaceAll('_', ' ');
const citationMarkdown = citation => [
  `## [${escape(citation.id ?? '?')}] ${escape(citation.title)}`,
  `**${escape(typeLabel(citation.type))}**${citation.sender ? ` · ${escape(citation.sender)}` : ''}${citation.timestamp !== null ? ` · ${escape(citation.timestamp)}` : ''}`,
  citation.url ? `[Open source](<${citation.url}>)\n\n${citation.url}` : 'The provider supplied no safe source link.',
  citation.excerpt ? clean(citation.excerpt) : 'No source excerpt was supplied.',
  ...(citation.sourceId ? [`Source ID: ${escape(citation.sourceId)}`] : []),
  ...(citation.unsupported ? [escape(citation.unsupported)] : []),
].join('\n\n');

export function renderZoomMateCitations(message, options = {}, theme) {
  const group = message.details, component = new Container(), citations = group?.citations ?? [];
  const types = [...new Set(citations.map(citation => typeLabel(citation.type)))].join(', ');
  component.addChild(new Text(theme.bold(theme.fg('accent', `[SOURCES ${citations.length}]`)) + ` ${theme.fg('muted', types)}`, 0, 0));
  if (!options.expanded) {
    component.addChild(new Text(theme.fg('dim', 'Ctrl+O expand · /sources inspect individual citations'), 0, 0));
  } else {
    component.addChild(new Markdown(citations.map(citationMarkdown).join('\n\n---\n\n'), 0, 0, getMarkdownTheme()));
  }
  return component;
}

export function registerZoomMateCitationCommands(pi, bridge) {
  pi.registerCommand('sources', { description: 'Inspect and expand native response citations', handler: async (_args, ctx) => {
    try {
      const state = bridge.state;
      const sources = (state.citations ?? []).flatMap((group, index) => group.citations.map(citation => ({ group, citation, response: index + 1 })));
      if (!sources.length) { ctx.ui.notify('No native source citations in this conversation.', 'info'); return; }
      const labels = sources.map(({ citation, response }, index) => `${index + 1}. [${label(citation.id ?? '?')}] ${typeLabel(citation.type)} · ${label(citation.title)} · response ${response}`);
      const selected = await ctx.ui.select(`Sources · ${label(state.sessionId)}`, labels), source = sources[labels.indexOf(selected)];
      if (!source) return;
      if (bridge.sessionId !== state.sessionId) { ctx.ui.notify('The conversation changed; reopen /sources for the current thread.', 'warning'); return; }
      const message = state.messages.find(item => item.message_id === source.group.messageId);
      const part = source.group.partId && message?.parts.find(item => item.metadata?.part_id === source.group.partId);
      const response = part?.text ?? message?.text ?? source.group.responseExcerpt;
      await showZoomMateText(ctx, 'Source citation', `Conversation: ${label(state.sessionId)}  \nResponse: ${label(source.group.messageId)}\n\n${citationMarkdown(source.citation)}\n\n---\n\n**Cited response:**\n\n${clean(response)}`);
    } catch (error) { ctx.ui.notify(`${label(error.code ?? 'ERROR')}: ${label(error.message)}`, 'error'); }
  } });
}
