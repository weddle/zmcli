import { DynamicBorder, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { SelectList, Text, matchesKey, stripTerminalSequences } from '@earendil-works/pi-tui';

const clean = value => stripTerminalSequences(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
const line = value => clean(value).replace(/\s+/gu, ' ').trim();
const broadChoices = new Set(['session_bypass', 'approve_all', 'allow_all', 'always_allow', 'session_allow', 'all_tools', 'all-tools']);
const supported = choice => typeof choice?.id === 'string' && choice.id.trim() && choice.unsupported !== true && choice.supported !== false && !broadChoices.has(choice.id);
const pendingOf = detail => detail?.pending ?? detail;
const toolIdOf = detail => pendingOf(detail)?.toolCallId ?? pendingOf(detail)?.data?.tool_call_id;
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}
function fingerprint(sessionId, pending, state) {
  const toolCallId = toolIdOf(pending);
  const proposals = toolCallId ? (state.artifacts ?? []).filter(item => item.update?.approvalId === toolCallId)
    .map(item => ({ id: item.id, xml: item.update.xml, transactionId: item.update.transactionId })) : [];
  return stable({ sessionId, toolCallId, data: pendingOf(pending)?.data, proposals });
}

function reviewText(detail) {
  const pending = detail.pending, data = pending.data ?? {};
  const parameters = Object.fromEntries((data.parameters_values ?? []).map(item => [item.name, item.value]));
  const rows = [
    `Session: ${line(detail.sessionId)}`,
    `Request: ${line(pending.requestId ?? pending.messageId ?? 'not reported')}`,
    `Tool call: ${line(toolIdOf(pending))}`,
    `Native tool: ${line(data.tool_id ?? pending.toolId ?? 'not reported')}`,
    '', 'Native scope and parameters', clean(JSON.stringify(parameters, null, 2)),
  ];
  for (const edit of detail.documentEdits ?? []) {
    rows.push('', `Document: ${line(edit.title ?? edit.documentId)}`, `Native document: ${line(edit.documentId)}`);
    if (edit.unsupported) rows.push(`Cannot apply this edit: ${line(edit.unsupported)}`);
    else rows.push(`Saved version: ${line(edit.baseVersion)}`, '', 'Before', clean(edit.beforeMarkdown), '', 'After approval', clean(edit.afterMarkdown));
  }
  return { title: line(parameters.spec?.title ?? parameters.title ?? 'Review native provider request'), text: rows.join('\n') };
}

function reviewOverlay(tui, theme, keybindings, detail, done) {
  const description = reviewText(detail);
  const header = new Text(theme.bold(theme.fg('accent', description.title)), 0, 0);
  const body = new Text(description.text, 0, 0), border = new DynamicBorder();
  const actions = [...detail.choices.map(choice => ({ choice, enabled: supported(choice) })), { choice: null, enabled: true }];
  const list = new SelectList(actions.map(({ choice, enabled }, index) => ({ value: String(index),
    label: choice ? `${line(choice.label ?? choice.id)} [${line(choice.id)}]${enabled ? '' : ' — unavailable'}` : 'Later — send nothing',
  })), Math.min(5, actions.length), getSelectListTheme());
  list.setSelectedIndex(actions.length - 1);
  let closed = false, offset = 0, height = 8, listTop = 0;
  const finish = value => { if (!closed) { closed = true; done(value); } };
  list.onCancel = () => finish(undefined);
  list.onSelect = item => {
    const action = actions[Number(item.value)];
    if (!action?.choice) finish(undefined);
    else if (action.enabled) finish({ choice: action.choice.id });
  };
  return {
    cancel: () => finish(undefined),
    render(width) {
      const top = header.render(width), rows = body.render(width);
      const buttons = list.render(width);
      const hint = new Text(theme.fg('dim', 'Up/Down choose · Enter selects · PgUp/PgDn review\nEscape or Later sends nothing.'), 0, 0).render(width);
      height = Math.max(1, Math.floor((tui.terminal?.rows ?? 24) * 0.9) - top.length - buttons.length - hint.length - 2);
      offset = Math.min(offset, Math.max(0, rows.length - height));
      const visible = rows.slice(offset, offset + height);
      listTop = top.length + 1 + visible.length + 1;
      return [...top, '', ...visible, ...border.render(width), ...buttons, ...hint];
    },
    handleInput(data) {
      if (closed) return;
      if (keybindings.matches(data, 'tui.select.cancel') || matchesKey(data, 'ctrl+c')) { finish(undefined); return; }
      if (matchesKey(data, 'pageDown')) offset += height;
      else if (matchesKey(data, 'pageUp')) offset = Math.max(0, offset - height);
      else if (['tui.select.up', 'tui.select.down', 'tui.select.confirm'].some(action => keybindings.matches(data, action))) list.handleInput(data);
      tui.requestRender();
    },
    handleMouse(event) {
      if (closed) return;
      if (event.type === 'wheel') { offset = Math.max(0, offset + (event.wheelDelta < 0 ? -3 : 3)); return { handled: true, render: true }; }
      if (event.y >= listTop) return list.handleMouse({ ...event, y: event.y - listTop });
    },
    invalidate() { header.invalidate(); body.invalidate(); list.invalidate(); border.invalidate(); },
  };
}

export function registerZoomMateApprovals(pi, bridge) {
  let context, promptDepth = 0, scheduled = false, running = false, active, disposed = false, currentReview;
  const handled = new Set();
  const uiIdle = () => !disposed && context?.hasUI && context.isIdle() && promptDepth === 0;
  const canStart = () => uiIdle() && !bridge.closed && !bridge.busy && !bridge.following && !bridge.awaitingApproval;
  const entries = () => (bridge.state.pendingApprovals ?? []).map(pending => ({ pending, sessionId: bridge.sessionId,
    fingerprint: fingerprint(bridge.sessionId, pending, bridge.state) }));
  const stillCurrent = review => bridge.sessionId === review.sessionId && (bridge.state.pendingApprovals ?? [])
    .some(pending => toolIdOf(pending) === review.toolCallId && fingerprint(bridge.sessionId, pending, bridge.state) === review.fingerprint);
  const schedule = () => {
    if (disposed || scheduled || running) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!canStart()) return;
      const entry = entries().find(item => !handled.has(item.fingerprint));
      if (entry) void start(entry);
    });
  };
  const start = entry => {
    running = true;
    handled.add(entry.fingerprint);
    const ctx = context;
    let deferred = false, shown = false;
    currentReview = (async () => {
      try {
        const result = await bridge.run('approve', { id: entry.sessionId, 'tool-call-id': toolIdOf(entry.pending),
          confirmApproval: async detail => {
            // The bridge owns busy/awaitingApproval now; only competing UI or observation prevents opening.
            if (!uiIdle() || bridge.following || bridge.sessionId !== entry.sessionId) { deferred = true; return false; }
            const review = { sessionId: entry.sessionId, toolCallId: toolIdOf(detail),
              fingerprint: fingerprint(entry.sessionId, detail, bridge.state), invalidated: false, cancel: null };
            active = review; shown = true; handled.add(review.fingerprint);
            const choice = await ctx.ui.custom((tui, theme, keybindings, done) => {
              const component = reviewOverlay(tui, theme, keybindings, detail, done);
              review.cancel = component.cancel;
              return component;
            }, { overlay: true, overlayOptions: { width: '90%', maxHeight: '90%' } });
            if (active === review) active = null;
            if (!choice || review.invalidated || !stillCurrent(review) || !detail.choices.some(item => item.id === choice.choice && supported(item))) return false;
            return choice;
          },
        });
        if (disposed || result?.outcome !== 'acknowledged') return;
        const outcome = result.continuation?.outcome;
        ctx.ui.notify(`Provider response sent.${outcome ? ` Remote turn ${line(outcome)}.` : ' Continuation was not confirmed.'}`, outcome === 'failed' || outcome === 'unknown' ? 'warning' : 'info');
        for (const edit of result.documentEdits ?? []) if (Number.isFinite(edit.version)) ctx.ui.notify(`Document ${line(edit.documentId)} saved at v${edit.version}; native readback confirmed.`, 'info');
      } catch (error) {
        if (!disposed && !(error.code === 'PROVIDER_APPROVAL_REQUIRED' && (shown || deferred))) ctx.ui.notify(`${line(error.message)} Check /session before retrying.`, 'warning');
      } finally {
        if (deferred) handled.delete(entry.fingerprint);
        running = false;
        schedule();
      }
    })();
    return currentReview;
  };
  const unsubscribe = bridge.subscribe((_state, kind) => {
    if (kind === 'credits') return;
    if (active && !stillCurrent(active)) { active.invalidated = true; active.cancel?.(); }
    schedule();
  });
  const reopen = async ctx => {
    if (ctx) context = ctx;
    if (running) return currentReview;
    const entry = entries()[0];
    if (!entry) { context?.ui.notify('No pending native approval in this conversation.', 'info'); return; }
    if (!canStart()) { context?.ui.notify('Wait for the current operation or dialog to finish before reviewing.', 'info'); return; }
    handled.delete(entry.fingerprint);
    return start(entry);
  };
  pi.registerCommand('approve', { description: 'Reopen a native request for explicit review', handler: (_args, ctx) => reopen(ctx) });
  return {
    sessionStart(ctx) { context = ctx; schedule(); },
    promptStarted() { promptDepth++; },
    promptEnded() { promptDepth = Math.max(0, promptDepth - 1); schedule(); },
    agentSettled() { schedule(); },
    reopen,
    dispose() { disposed = true; unsubscribe(); if (active) { active.invalidated = true; active.cancel?.(); } },
  };
}
