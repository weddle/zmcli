import { Container, Text, stripTerminalSequences } from '@earendil-works/pi-tui';

const clean = value => stripTerminalSequences(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
const label = value => clean(value).replace(/\s+/gu, ' ').trim();

/**
 * Render a read-only native suggestion. Selecting it is deliberately separate
 * from rendering: this card never submits a prompt or creates a skill.
 */
export function renderZoomMateSuggestion(message, _options = {}, theme) {
  const suggestion = message.details ?? message.suggestion ?? {};
  const component = new Container();
  component.addChild(new Text(theme.bold(theme.fg('accent', '[SUGGESTED SKILL]')), 0, 0));
  component.addChild(new Text(theme.fg('text', label(suggestion.prompt)), 0, 0));
  component.addChild(new Text(theme.fg('dim', 'Read-only native suggestion · /suggestions to review and load'), 0, 0));
  return component;
}

function editorText(ctx) {
  if (typeof ctx.ui?.getEditorText === 'function') return ctx.ui.getEditorText();
  return null;
}

/** Register the explicit, review-only suggestion action and renderer hook. */
export function registerZoomMateSuggestions(pi, bridge) {
  pi.registerMessageRenderer('zoommate.suggestion', (message, options, theme) => renderZoomMateSuggestion(message, options, theme));
  pi.registerCommand('suggestions', {
    description: 'Review native suggested skills without sending or saving them',
    handler: async (_args, ctx) => {
      const beforeSession = bridge.sessionId, suggestions = bridge.state?.suggestions ?? [];
      if (!suggestions.length) { ctx.ui.notify('No native skill suggestions are available.', 'info'); return; }
      const choices = suggestions.map((item, index) => `${index + 1}. Create reusable skill · ${label(item.prompt)}`);
      const chosen = await ctx.ui.select('Load a suggested prompt for review (does not send)', choices);
      if (!chosen) return;
      if (bridge.sessionId !== beforeSession || bridge.state?.sessionId !== beforeSession) {
        ctx.ui.notify('Conversation changed while the suggestion chooser was open; nothing was loaded.', 'warning');
        return;
      }
      const index = choices.indexOf(chosen);
      const selected = suggestions[index];
      const suggestion = (bridge.state?.suggestions ?? []).find(item => item.messageId === selected?.messageId
        && item.partId === selected?.partId && item.type === selected?.type && item.prompt === selected?.prompt);
      if (!suggestion || typeof suggestion.prompt !== 'string' || !suggestion.prompt.trim()) return;
      const current = editorText(ctx);
      if (current === null) {
        ctx.ui.notify('Editor state could not be verified; suggestion was not loaded.', 'warning');
        return;
      }
      if (String(current).length) {
        ctx.ui.notify('Your draft is not empty; clear it before loading the suggested prompt.', 'warning');
        return;
      }
      ctx.ui.setEditorText(suggestion.prompt);
      ctx.ui.notify('Suggested prompt loaded for review. Nothing was sent or saved.', 'info');
    },
  });
}
