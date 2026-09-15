import test from 'node:test';
import assert from 'node:assert/strict';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { getKeybindings, stripTerminalSequences } from '@earendil-works/pi-tui';
import { registerZoomMateApprovals } from '../src/zoommate-pi-approval.mjs';

initTheme('dark', false);
const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const control = (id = 'permission', title = 'Change only Alpha') => ({
  toolCallId: id, messageId: 'run', requestId: 'run', data: {
    tool_type: 'human_in_the_loop', tool_id: 'human_in_the_loop_tool', tool_call_id: id,
    parameters_values: [{ name: 'spec', value: { title, fields: [{ type: 'display', props: { content: 'Document: offline-doc\nAlpha: original → Alpha: verified' } }],
      actions: [{ id: 'allow_once', label: 'Allow once', type: 'send', message: 'User allowed once' }, { id: 'deny', label: 'Deny', type: 'send', message: 'User denied' }],
      meta: { quick_approve: true, request_id: 'run' } } }],
  },
});

function fixture({ beforeReview, documentEdits = [], choices } = {}) {
  const subscribers = new Set(), views = [], responses = [], notices = [], commands = new Map();
  let hooks, draft = 'preserved unsent draft';
  const bridge = {
    sessionId: 'session', busy: false, following: false, awaitingApproval: false, closed: false,
    state: { sessionId: 'session', status: 'blocked', activeRequestId: 'run', pendingApprovals: [control()], artifacts: [], messages: [] },
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    emit(kind = 'state') { for (const listener of subscribers) listener(this.state, kind); },
    async run(action, options) {
      assert.equal(action, 'approve');
      this.busy = true; this.emit();
      try {
        await beforeReview?.();
        const pending = this.state.pendingApprovals.find(p => !options['tool-call-id'] || p.toolCallId === options['tool-call-id']);
        if (!pending) throw Object.assign(new Error('No pending control'), { code: 'INVALID_INPUT' });
        const spec = pending.data.parameters_values[0].value;
        this.awaitingApproval = true; this.emit();
        const decision = await options.confirmApproval({ sessionId: this.sessionId, pending, documentEdits,
          choices: choices ?? spec.actions.map(a => ({ id: a.id, label: a.label, response: { response_type: 'success', response_content: a.message, response_data: { action_id: a.id } } })) });
        if (!decision) throw Object.assign(new Error('No response chosen'), { code: 'PROVIDER_APPROVAL_REQUIRED' });
        responses.push({ sessionId: options.id, choice: decision.choice });
        this.state = { ...this.state, status: 'idle', activeRequestId: null, pendingApprovals: [] };
        this.emit();
        return { outcome: 'acknowledged', continuation: { outcome: 'completed' } };
      } finally { this.awaitingApproval = false; this.busy = false; this.emit(); }
    },
  };
  const ctx = { hasUI: true, idle: true, isIdle() { return this.idle; }, ui: {
    getEditorText: () => draft, setEditorText: value => { draft = value; },
    notify: (...args) => notices.push(args),
    custom(factory, options) {
      hooks.promptStarted();
      return new Promise(resolve => {
        const view = { options, closed: false };
        const tui = { terminal: { rows: 36, columns: 100 }, requestRender() {} };
        const theme = { fg: (_color, value) => value, bg: (_color, value) => value, bold: value => value, dim: value => value };
        view.component = factory(tui, theme, getKeybindings(), result => {
          if (view.closed) return;
          view.closed = true; hooks.promptEnded(); resolve(result);
        });
        views.push(view);
      });
    },
  } };
  const pi = { registerCommand: (name, command) => commands.set(name, command), sendMessage() {} };
  hooks = registerZoomMateApprovals(pi, bridge);
  return { bridge, ctx, hooks, views, responses, notices, commands, get draft() { return draft; } };
}

test('automatic approval defaults to Later, preserves draft, and stays dismissed until reopened', async t => {
  const f = fixture(); t.after(() => f.hooks.dispose());
  f.hooks.sessionStart(f.ctx); await settle();
  assert.equal(f.views.length, 1);
  f.views[0].component.handleInput('\r'); await settle();
  assert.equal(f.views[0].closed, true);
  assert.deepEqual(f.responses, []);
  assert.equal(f.draft, 'preserved unsent draft');
  for (let i = 0; i < 5; i++) f.bridge.emit();
  await settle(); assert.equal(f.views.length, 1);
  const reopened = f.commands.get('approve').handler('', f.ctx);
  await settle(); assert.equal(f.views.length, 2);
  f.views[1].component.handleInput('\x1b'); await reopened;
  assert.deepEqual(f.responses, []);
});

test('automatic approval waits for both Pi idle and another dialog to finish', async t => {
  const f = fixture(); t.after(() => f.hooks.dispose());
  f.ctx.idle = false; f.hooks.sessionStart(f.ctx); await settle();
  assert.equal(f.views.length, 0);
  f.hooks.promptStarted(); f.ctx.idle = true; f.hooks.agentSettled(f.ctx); await settle();
  assert.equal(f.views.length, 0);
  f.hooks.promptEnded(); await settle();
  assert.equal(f.views.length, 1);
  f.views[0].component.handleInput('\x1b'); await settle();
  assert.deepEqual(f.responses, []);
});

test('a dialog opened during native approval preparation is not covered by the review', async t => {
  let release;
  const preparation = new Promise(resolve => { release = resolve; });
  const f = fixture({ beforeReview: () => preparation }); t.after(() => f.hooks.dispose());
  f.hooks.sessionStart(f.ctx); await settle();
  assert.equal(f.bridge.busy, true);
  f.hooks.promptStarted(); release(); await settle();
  assert.equal(f.views.length, 0);
  f.hooks.promptEnded(); await settle();
  assert.equal(f.views.length, 1);
  f.views[0].component.handleInput('\x1b'); await settle();
  assert.deepEqual(f.responses, []);
});

test('changed request scope invalidates the old review without a response', async t => {
  const f = fixture(); t.after(() => f.hooks.dispose());
  f.hooks.sessionStart(f.ctx); await settle();
  const old = f.views[0];
  f.bridge.state = { ...f.bridge.state, pendingApprovals: [control('permission', 'Different operation')] };
  f.bridge.emit(); await settle();
  assert.equal(old.closed, true);
  assert.deepEqual(f.responses, []);
  assert.equal(f.views.length, 2);
  f.views[1].component.handleInput('\x1b'); await settle();
});

test('an answered control or conversation switch cannot submit the old review', async t => {
  for (const change of ['answered', 'switched']) await t.test(change, async t => {
    const f = fixture(); t.after(() => f.hooks.dispose());
    f.hooks.sessionStart(f.ctx); await settle();
    const old = f.views[0];
    if (change === 'switched') f.bridge.sessionId = 'other-session';
    f.bridge.state = { ...f.bridge.state, sessionId: f.bridge.sessionId, status: 'idle', activeRequestId: null, pendingApprovals: [] };
    f.bridge.emit(); await settle();
    assert.equal(old.closed, true);
    old.component.handleInput('\r'); await settle();
    assert.deepEqual(f.responses, []);
  });
});

test('only explicit provider selection sends Allow once or Deny, exactly once', async t => {
  for (const [choice, up] of [['allow_once', 2], ['deny', 1]]) await t.test(choice, async t => {
    const f = fixture(); t.after(() => f.hooks.dispose());
    f.hooks.sessionStart(f.ctx); await settle();
    const panel = f.views[0].component;
    panel.handleInput('y'); await settle();
    assert.deepEqual(f.responses, [], 'Single-letter input must not approve.');
    for (let i = 0; i < up; i++) panel.handleInput('\x1b[A');
    panel.handleInput('\r'); await settle();
    panel.handleInput('\r'); f.bridge.emit(); await settle();
    assert.deepEqual(f.responses, [{ sessionId: 'session', choice }]);
  });
});

test('a dismissed request does not hide a different pending request', async t => {
  const f = fixture(); t.after(() => f.hooks.dispose());
  f.hooks.sessionStart(f.ctx); await settle();
  f.views[0].component.handleInput('\x1b'); await settle();
  f.bridge.state.pendingApprovals.push(control('next-permission', 'A different provider operation'));
  f.bridge.emit(); await settle();
  assert.equal(f.views.length, 2);
  const rendered = stripTerminalSequences(f.views[1].component.render(100).join('\n'));
  assert.match(rendered, /next-permission/u);
  f.views[1].component.handleInput('\x1b'); await settle();
  assert.deepEqual(f.responses, []);
});

test('review exposes native scope and the end of a long document change without hiding actions', async t => {
  const f = fixture({ documentEdits: [{ documentId: 'offline-doc', title: 'Review fixture', baseVersion: 3,
    beforeMarkdown: 'Alpha: original\nBeta: unchanged',
    afterMarkdown: `${Array.from({ length: 70 }, (_, n) => `Line ${n}: unchanged`).join('\n')}\nLAST-LINE: final verified value`,
    changes: [{ operation: 'replace', id: 'alpha' }] }] });
  t.after(() => f.hooks.dispose());
  f.hooks.sessionStart(f.ctx); await settle();
  const panel = f.views[0].component;
  let seen = '';
  for (let page = 0; page < 10; page++) {
    const rendered = stripTerminalSequences(panel.render(70).join('\n'));
    assert.match(rendered, /Later/u, 'Actions must remain visible while the diff scrolls.');
    seen += `\n${rendered}`;
    panel.handleInput('\x1b[6~');
  }
  assert.match(seen, /Change only Alpha/u);
  assert.match(seen, /Alpha: original/u);
  assert.match(seen, /LAST-LINE: final verified value/u);
  assert.deepEqual(f.responses, []);
  panel.handleInput('\x1b'); await settle();
});

test('document proposal changes invalidate a review even when the control ID is unchanged', async t => {
  const f = fixture(); t.after(() => f.hooks.dispose());
  f.bridge.state.artifacts = [{ key: 'document:offline-doc', update: { approvalId: 'permission', xml: '<p>Original</p>', transactionId: 'transaction-1' } }];
  f.hooks.sessionStart(f.ctx); await settle();
  const original = f.views[0];
  f.bridge.state.artifacts[0].update.xml = '<p>Different change</p>';
  f.bridge.emit('reconcile'); await settle();
  assert.equal(original.closed, true);
  assert.deepEqual(f.responses, []);
  assert.equal(f.views.length, 2);
  f.views[1].component.handleInput('\x1b'); await settle();
});
