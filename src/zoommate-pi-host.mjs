import process from 'node:process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  AgentSessionRuntime, InteractiveMode, ModelRuntime, SessionManager, SettingsManager,
  createAgentSessionFromServices, createAgentSessionServices, getMarkdownTheme,
} from '@earendil-works/pi-coding-agent';
import { CombinedAutocompleteProvider, Markdown, Text, getCapabilities, setCapabilityOverrides, stripTerminalSequences } from '@earendil-works/pi-tui';
import { createZoomMateProvider } from './zoommate-pi-provider.mjs';
import { registerZoomMateApprovals } from './zoommate-pi-approval.mjs';
import { createZoomMateBridge } from './zoommate-pi-bridge.mjs';
import { createZoomMateLifecycle, createZoomMateReporter, zoomMateLaunchRecipe } from './zoommate-herdr.mjs';
import { creditBalanceComponent, creditFooter, selectedContextSummary } from './zoommate-pi-presentation.mjs';
import { registerZoomMateCommands } from './zoommate-pi-commands.mjs';
import { isZoomMateMarkdownArtifact, renderZoomMateArtifact } from './zoommate-pi-artifacts.mjs';
import { renderZoomMateCitations } from './zoommate-pi-citations.mjs';
import { ZoomMateExecutionWidget, renderZoomMatePlan, renderZoomMateTool } from './zoommate-pi-execution.mjs';
import { registerZoomMateSuggestions } from './zoommate-pi-suggestions.mjs';

function nativeCards(state) {
  const cards = new Map(), artifacts = new Map((state.artifacts ?? []).map(artifact => [artifact.key, artifact]));
  const add = (messageId, customType, content, details, cardId) => {
    if (!messageId) return;
    if (!cards.has(messageId)) cards.set(messageId, []);
    cards.get(messageId).push({ role: 'custom', customType, content, details: { ...details, cardId }, display: true, timestamp: Date.now() });
  };
  for (const message of state.messages ?? []) {
    const keys = new Set();
    for (const part of message.parts ?? []) {
      if (['create_doc', 'update_doc'].includes(part.metadata?.part_type)) keys.add(`document:${part.metadata.doc_id}`);
      if (part.metadata?.part_type === 'summary_attachments' && Array.isArray(part.data?.attachments_v2)) {
        for (const file of part.data.attachments_v2) keys.add(`file:${file?.id}`);
      }
    }
    for (const key of keys) {
      const artifact = artifacts.get(key);
      if (artifact) add(message.message_id, 'zoommate.artifact', artifact.title, artifact, `${message.message_id}:${key}`);
    }
  }
  for (const group of state.citations ?? []) add(group.messageId, 'zoommate.sources', `${group.citations.length} source citations`, group, `sources:${group.key}`);
  for (const suggestion of state.suggestions ?? []) add(suggestion.messageId, 'zoommate.suggestion', '', suggestion,
    `suggestion:${suggestion.messageId}:${suggestion.partId}`);
  const execution = state.execution ?? {};
  for (const tool of execution.tools ?? []) add(tool.messageId, 'zoommate.tool', tool.brief ?? tool.description ?? '', tool,
    `tool:${tool.requestId ?? tool.messageId}:${tool.toolCallId ?? `${tool.type}:${tool.partId}`}`);
  const plans = new Map();
  for (const step of execution.plan ?? []) {
    if (!step.requestId) continue;
    if (!plans.has(step.requestId)) plans.set(step.requestId, []);
    plans.get(step.requestId).push(step);
  }
  for (const [requestId, plan] of plans) add(plan[0].messageId, 'zoommate.plan', '', { plan }, `plan:${requestId}`);
  if (execution.snapshots?.length) {
    const messageId = execution.snapshots.at(-1).messageId ?? execution.sandbox?.messageId;
    if (messageId) add(messageId, 'zoommate.computer', '', { count: execution.snapshots.length }, `computer:${messageId}`);
  }
  return cards;
}

const BUILTINS = [
  { name: 'copy', description: 'Copy the last assistant response' },
  { name: 'quit', description: 'Detach and exit; do not cancel the remote request' },
];
const WHILE_BUSY = new Set(['cancel', 'computer', 'snapshot', 'credits', 'session', 'help', 'settings']);
const usage = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }) });
const clean = value => stripTerminalSequences(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
const label = value => clean(value).replace(/\n/gu, ' ');
const statusOf = bridge => bridge.awaitingApproval ? 'blocked'
  : bridge.busy && bridge.state.status === 'idle' ? 'working' : bridge.state.status;

export function projectZoomMateHistory(state, model) {
  const cards = nativeCards(state);
  return (state.messages ?? []).filter(message => ['user', 'assistant'].includes(message.role)).flatMap(message => [
    ...(message.text ? [{
      role: message.role, content: [{ type: 'text', text: clean(message.text) }],
      timestamp: Date.now(), message_id: message.message_id,
      ...(message.role === 'assistant' ? { api: model.api, provider: model.provider, model: model.id, usage, stopReason: 'stop' } : {}),
    }] : []),
    ...(cards.get(message.message_id) ?? []),
  ]);
}

function hydrate(session, state, bridge) {
  const manager = session.sessionManager;
  const messages = projectZoomMateHistory(state, session.model);
  manager.newSession();
  manager.appendModelChange(session.model.provider, session.model.id);
  if (state.title) session.setSessionName(state.title);
  manager.appendCustomEntry('zoommate.session', { remoteSessionId: bridge.sessionId, actor: bridge.identity.user });
  manager.appendCustomEntry('zoommate.native-state', state);
  for (const message of messages) {
    if (message.role === 'custom') manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
    else manager.appendMessage(message);
  }
  session.agent.reset();
  session.agent.sessionId = manager.getSessionId();
  session.agent.state.messages = messages;
}

function dynamicText(textFor) {
  const component = new Text('', 0, 0);
  let previous;
  return {
    render(width) { const next = textFor(); if (next !== previous) { component.setText(next); previous = next; } return component.render(width); },
    invalidate() { component.invalidate(); },
  };
}

async function detectNativeImages() {
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY || input.listenerCount('data') || getCapabilities().images
      || ['kitty', 'iterm2', 'none', '0'].includes(process.env.PI_IMAGE_PROTOCOL?.toLowerCase())) return;
  // Some real Kitty-capable terminals provide no TERM_PROGRAM. Query the
  // terminal before Pi takes stdin; do not force a protocol from a host name.
  const wasRaw = Boolean(input.isRaw), chunks = [];
  await new Promise(resolve => {
    let settled = false, size = 0;
    const finish = reply => {
      if (settled) return;
      settled = true; clearTimeout(timer); input.removeListener('data', onData); input.pause();
      input.setRawMode(wasRaw);
      const bytes = Buffer.concat(chunks);
      const remaining = reply ? Buffer.concat([bytes.subarray(0, reply.index), bytes.subarray(reply.index + reply[0].length)]) : bytes;
      if (remaining.length) input.unshift(remaining);
      if (reply?.[1] === 'OK') setCapabilityOverrides({ images: 'kitty' });
      resolve();
    };
    const onData = chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); size += chunk.length;
      const reply = /\x1b_Gi=31;([^\x1b]*)\x1b\\/u.exec(Buffer.concat(chunks).toString('latin1'));
      if (reply || size > 8192) finish(reply);
    };
    const timer = setTimeout(() => finish(), 750);
    try {
      input.setRawMode(true); input.on('data', onData); input.resume();
      process.stdout.write('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\');
    } catch { finish(); }
  });
}

// Pinned Pi 0.85.1 host adaptation: keep its renderer, editor, Markdown, dialogs
// and key handling. Only remote-session routing and forbidden local actions differ.
export class ZoomMateInteractiveMode extends InteractiveMode {
  constructor(runtime, bridge, options = {}) {
    super(runtime, options);
    this.bridge = bridge;
  }
  getBuiltInCommandConflictDiagnostics() { return []; }
  showManagedToolStatus(status) {
    const optionalSearch = status?.type === 'warning'
      && /^(fd|ripgrep) not found\. Offline mode enabled, skipping download\.$/u.test(String(status.message ?? ''));
    if (optionalSearch) {
      this.showStatus('Optional local search unavailable; online remote ZoomMate remains available.');
      return;
    }
    super.showManagedToolStatus(status);
  }
  rebuildChatFromMessages() {
    if (!this.bridge?.following && !['execution', 'reconciliation'].includes(this.bridge?.operationStage?.stage)) return super.rebuildChatFromMessages();
    this.chatContainer.clear();
    this.renderSessionItems(this.session.messages);
  }
  createBaseAutocompleteProvider() {
    const commands = this.session.extensionRunner.getRegisteredCommands().map(command => ({
      name: command.name, description: command.description, getArgumentCompletions: command.getArgumentCompletions,
    }));
    const provider = new CombinedAutocompleteProvider([...commands, ...BUILTINS], this.sessionManager.getCwd());
    return {
      getSuggestions: (lines, line, column, ...args) => lines[line]?.startsWith('/')
        ? provider.getSuggestions(lines, line, column, ...args) : null,
      applyCompletion: (...args) => provider.applyCompletion(...args),
    };
  }
  async remoteCommand(text) {
    const name = text.slice(1).split(/\s/u, 1)[0];
    const command = this.session.extensionRunner.getRegisteredCommands().find(item => item.name === name);
    if (!command) return false;
    if ((this.submitting || this.session.isStreaming || this.bridge.busy || this.interruptPending || this.bridge.stopping) && !WHILE_BUSY.has(name)) {
      this.editor.setText(text);
      this.showWarning('An operation is active. Escape in the editor stops the remote turn; /cancel also requests a stop.');
      return true;
    }
    this.editor.setText('');
    this.editor.addToHistory?.(text);
    if (name !== 'approve') this.approvalHooks?.promptStarted();
    try { await this.session.prompt(`/${command.invocationName}${text.slice(name.length + 1)}`); }
    finally { if (name !== 'approve') this.approvalHooks?.promptEnded(); }
    return true;
  }
  setupEditorSubmitHandler() {
    super.setupEditorSubmitHandler();
    const submit = this.defaultEditor.onSubmit;
    this.defaultEditor.onSubmit = async text => {
      const draft = text;
      text = text.trim();
      if (!text) return;
      const reject = message => { this.editor.setText(draft); this.showWarning(message); };
      try {
        if (text.startsWith('/')) {
          if (await this.remoteCommand(text)) return;
          if (!BUILTINS.some(command => text === `/${command.name}`)) {
            reject('That command is not available in ZoomMate. Type / for supported commands.'); return;
          }
          await submit(text);
          return;
        } else if (text.startsWith('!')) {
          reject('Local shell execution is disabled. ZoomMate runs remotely.'); return;
        } else if (this.submitting || this.session.isStreaming || this.bridge.busy || this.interruptPending || this.bridge.stopping) {
          reject(this.bridge.state.status === 'working'
            ? 'Remote work is still running. Escape in the editor or /cancel requests a remote stop.'
            : 'The current operation is still settling. Your draft is preserved; prompts are not queued.'); return;
        } else if (this.bridge.state.status === 'working') {
          reject(this.bridge.following
            ? 'Remote work is still running and is being followed automatically. Escape in the editor stops the turn.'
            : 'The last remote state was running. Escape requests a stop; /resume reconnects observation.'); return;
        } else if (this.bridge.state.status === 'blocked' && (this.bridge.state.activeRequestId || this.bridge.state.pendingApprovals.length)) {
          reject('The remote turn needs input. A provider review opens automatically; /approve reopens a dismissed review, and /cancel requests a stop.'); return;
        } else if (this.bridge.state.status === 'unknown') {
          reject(this.bridge.following
            ? 'Checking the remote outcome automatically. No prompt will be replayed.'
            : 'The remote outcome is unconfirmed. /resume retries observation; /cancel can request a stop for a known run.'); return;
        }
        this.submitting = true;
        this.editor.addToHistory?.(text);
        this.editor.setText('');
        try { await this.session.prompt(text); }
        finally { this.submitting = false; this.reconcileInterrupt(); }
      } catch (error) { this.showError(error.message); }
    };
  }
  interruptTurn() {
    const { sessionId, state } = this.bridge;
    if (this.bridge.stopping) { this.showStatus('Stopping remote work; waiting for confirmation. Escape will not send another request.'); return; }
    if (sessionId && state.activeRequestId && state.status !== 'idle') {
      const key = `${sessionId}:${state.activeRequestId}`;
      this.interruptPending = false;
      if (this.interruptedRequest === key) { this.showStatus('Stop already requested for this turn. Observing its outcome; no request resent.'); return; }
      this.interruptedRequest = key;
      this.showStatus('Stopping remote work… completed tool side effects are not undone.');
      void this.bridge.run('cancel', { id: sessionId, 'request-id': state.activeRequestId }).then(result => {
        if (result.confirmation !== 'remote-terminal') this.showWarning('Stop acknowledged but not confirmed. Observing automatically; Escape will not resend it.');
      }).catch(error => this.showWarning(`Remote stop unconfirmed: ${error.message} No automatic resend; /resume reconnects observation.`));
      return;
    }
    if (this.session.isStreaming || this.submitting || this.bridge.busy || this.bridge.following) {
      this.interruptPending = true;
      this.showStatus('Interrupting locally; any in-flight remote request will be stopped once identified.');
      this.localEscape?.();
    } else {
      this.interruptPending = false;
      this.showStatus(state.status === 'unknown' ? 'Remote outcome unknown and no request ID is available. /resume reconnects; no stop can be confirmed.'
        : 'Local turn interrupted; no active remote request was identified.');
    }
  }
  reconcileInterrupt() {
    if (!this.interruptPending || this.bridge.closed) return;
    if (this.bridge.state.activeRequestId || (!this.bridge.busy && !this.submitting && !this.session.isStreaming && !this.bridge.following)) this.interruptTurn();
  }
  setupKeyHandlers() {
    super.setupKeyHandlers();
    this.localEscape = this.defaultEditor.onEscape;
    this.defaultEditor.onEscape = () => {
      if (this.interruptPending || this.session.isStreaming || this.submitting || ['working', 'blocked', 'unknown'].includes(this.bridge.state.status)) this.interruptTurn();
      else this.localEscape?.();
    };
    this.defaultEditor.onAction('app.session.new', () => void this.remoteCommand('/new'));
    this.defaultEditor.onAction('app.session.resume', () => void this.remoteCommand('/resume'));
    this.defaultEditor.onAction('app.session.tree', () => this.showWarning('Remote conversations do not have local branches. Use /chats.'));
    this.defaultEditor.onAction('app.session.fork', () => this.showWarning('Local forks cannot fork a remote conversation. Use /new.'));
    this.defaultEditor.onAction('app.message.followUp', () => this.showWarning('Follow-up queues are disabled; each remote prompt requires a new submission.'));
  }
  toggleToolOutputExpansion() {
    if (!this.executionWidget && !this.chatContainer.children.some(child => ['zoommate.artifact', 'zoommate.sources', 'zoommate.tool', 'zoommate.plan'].includes(child.message?.customType))) {
      this.showStatus('No native tool, artifact, source, or plan cards to expand.');
      return;
    }
    super.toggleToolOutputExpansion();
    this.executionWidget?.setExpanded(this.toolOutputExpanded);
  }
  showModelSelector() { this.showStatus('ZoomMate uses its native remote agent; there is no local model fallback.'); }
  async handleOpenExternalEditor() { this.showWarning('External programs are disabled in the remote-only host.'); }
  async handleClipboardPaste() { await this.handleRightClickPaste(); }
  updateTerminalTitle() {
    if (!this.bridge) return super.updateTerminalTitle();
    this.ui.terminal.setTitle(`ZoomMate | ${statusOf(this.bridge)} | ${label(this.bridge.state.title ?? this.bridge.sessionId ?? 'new')}`);
  }
  async shutdown(options) {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    const closing = this.bridge.close();
    await this.session.abort();
    await closing;
    if (options?.fromSignal) await this.runtimeHost.dispose();
    this.themeController.disableAutoSync();
    await this.ui.terminal.drainInput(1000);
    this.stop();
    if (!options?.fromSignal) await this.runtimeHost.dispose();
    if (!options?.fromSignal && this.bridge.sessionId) {
      const recipe = zoomMateLaunchRecipe({ cookies: this.bridge.cookieFile, profile: this.bridge.launch.profile,
        configDir: this.bridge.launch.configDir, resume: this.bridge.sessionId, project: this.bridge.project?.id });
      const command = [recipe.command, ...recipe.args].map(value => "'" + value.replaceAll("'", "'\\''") + "'").join(' ');
      process.stdout.write(`Resume ZoomMate: ${command}\n`);
    }
    process.exit(0);
  }
}

export async function createZoomMatePiRuntime(bridge, { cwd = process.cwd(), agentDir, reporter } = {}) {
  const provider = createZoomMateProvider(bridge);
  const model = provider.getModels()[0];
  const settingsManager = SettingsManager.inMemory({
    theme: 'dark', quietStartup: true, collapseChangelog: true, doubleEscapeAction: 'none',
    enableSkillCommands: false, compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 },
    terminal: { showImages: false, images: getCapabilities().images ?? undefined },
    defaultProvider: provider.id, defaultModel: model.id, defaultThinkingLevel: 'off',
  });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  // The public factory has no provider allowlist. Remove built-ins before any
  // availability refresh so ambient keys/credential files cannot supply a fallback.
  modelRuntime.defaultBuiltins.clear(); modelRuntime.builtins.clear(); modelRuntime.rebuildProviders();
  modelRuntime.registerNativeProvider(provider);
  await modelRuntime.refresh({ providers: [provider.id], allowNetwork: false });
  let mode, context, lastReported, lastActivity, pendingHydration, lastReconciliation, stageTimer, promptDepth = 0;
  let executionWidget, approvalHooks, projectedState = bridge.state;
  const recordedCredits = new WeakMap();
  const renderedCards = new Set();
  const rememberCards = state => {
    renderedCards.clear();
    for (const cards of nativeCards(state).values()) for (const card of cards) renderedCards.add(card.details.cardId);
  };
  const lifecycle = createZoomMateLifecycle(bridge, reporter);
  const help = `# ZoomMate

Native ZoomMate execution in upstream Pi.

- **/** opens command completion; Tab completes. **Enter** submits; **Shift+Enter** inserts a newline.
- **Escape in the editor** requests one remote stop, then observes the result. Before dispatch it interrupts locally. Repeated Escape never resends an uncertain stop.
- **Escape in a picker or review** closes that context without stopping work or granting approval. **Ctrl+C twice**, **Ctrl+D** on an empty editor, or **/quit** exits without cancelling remote work.
- **/cancel** confirms the exact remote stop target. Acknowledgement alone is not completion; completed side effects are not undone.
- **/resume** restores history and continues live observation without replaying a prompt. **/chats** switches conversations; **/new** stages a new one without cancelling the old turn.
- **/name TITLE** renames the native conversation and verifies its title by readback.
- **/project**, **/attach**, **/skills**, **/connectors**, **/clear** select remote context. The footer shows typed counts. **/attach selected** manages attached items, including off-page items; **/attach clear** removes attached entities.
- **/artifacts** previews and references native artifacts. Save Markdown always asks for a destination, confirms its resolved path, and creates a new mode-0600 file without replacing any file or symlink.
- Native documents open their existing Zoom Docs identity. Markdown files can be exported separately; **Check existing Zoom Docs export** reconciles without another import.
- **Ctrl+O** expands tool, plan, artifact and source cards. **/sources** inspects individual citations.
- **/computer** inspects captured screenshots, artifacts and conversation files read-only. **/snapshot** opens a capture only on request; neither opens a live VNC connection.
- **/mode** selects Auto or Advanced only when enabled by the native account flag.
- **/suggestions** reviews native skill suggestions and loads the exact prompt into an empty editor. Nothing is sent or saved until you submit it yourself.
- **/credits** shows shared-account observations, not per-turn cost. **/session** shows the active profile; verbose diagnostics redact credential paths. Resume recipes retain profile identity and custom config roots. **/files** inspects native files.
- **/settings** changes the Pi theme. **/copy** copies the last response.

Cloud execution only. Native desktop execution requires a supported registered Zoom/Synora host and verified bridge.

No local tools, shell, automatic write retries, compaction, history replay or background prompt queues. Token usage and per-run credit costs are not reported by ZoomMate.`;
  const extension = pi => {
    const unsubscribeBlocked = pi.events.on('herdr:blocked', data => lifecycle.blockedChanged(data));
    pi.registerMessageRenderer('zoommate.result', message => new Markdown(message.content, 1, 0, getMarkdownTheme()));
    pi.registerMessageRenderer('zoommate.credits', (message, _options, theme) => creditBalanceComponent(message.details.credit, theme, message.details.observedAt, message.details.observations));
    pi.registerMessageRenderer('zoommate.artifact', (message, options, theme) => {
      let previous, component;
      return {
        render(width) {
          const artifact = bridge.getArtifact(message.details.key) ?? message.details;
          if (options.expanded && artifact.needsRead && isZoomMateMarkdownArtifact(artifact)) void bridge.ensureArtifact(artifact.key);
          if (artifact !== previous) { previous = artifact; component = renderZoomMateArtifact({ ...message, details: artifact }, options, theme); }
          return component.render(width);
        },
        invalidate() { component?.invalidate(); },
      };
    });
    pi.registerMessageRenderer('zoommate.sources', (message, options, theme) => renderZoomMateCitations(message, options, theme));
    approvalHooks = registerZoomMateApprovals(pi, bridge);
    registerZoomMateCommands(pi, bridge);
    registerZoomMateSuggestions(pi, bridge);
    pi.registerCommand('help', { description: 'ZoomMate commands and Pi keyboard controls', handler: async (_args, ctx) => {
      pi.sendMessage({ customType: 'zoommate.result', content: help, display: true }, { triggerTurn: false });
    } });
    pi.registerMessageRenderer('zoommate.tool', (message, options, theme) => renderZoomMateTool(message, options, theme));
    pi.registerMessageRenderer('zoommate.plan', (message, options, theme) => renderZoomMatePlan(message, options, theme));
    pi.registerMessageRenderer('zoommate.computer', (message, _options, theme) => new Text(
      `${theme.fg('accent', 'Computer use')} · ${message.details?.count ?? 0} snapshot(s) available · ${theme.fg('dim', '/computer to inspect')}`, 1, 0));
    pi.registerCommand('settings', { description: 'Choose a Pi theme', handler: async (_args, ctx) => {
      const name = await ctx.ui.select('Pi theme', ctx.ui.getAllThemes().map(theme => theme.name));
      if (!name) return;
      const result = ctx.ui.setTheme(name);
      if (!result.success) throw new Error(result.error);
      settingsManager.setTheme(name);
    } });
    pi.on('input', (event, ctx) => {
      if (event.images?.length || event.text.startsWith('!') || event.text.startsWith('/')
        || bridge.busy || ['working', 'unknown'].includes(bridge.state.status)
        || (bridge.state.status === 'blocked' && (bridge.state.activeRequestId || bridge.state.pendingApprovals.length))) {
        ctx.ui.setEditorText(event.text);
        ctx.ui.notify('Input not sent; your draft is preserved. /cancel requests a stop, and /resume reconnects observation. Pending provider reviews appear automatically; /approve reopens a dismissed review.', 'warning');
        return { action: 'handled' };
      }
      return { action: 'continue' };
    });
    pi.on('before_agent_start', () => ({ systemPrompt: '' }));
    for (const event of ['session_before_switch', 'session_before_fork', 'session_before_tree', 'session_before_compact']) {
      pi.on(event, () => ({ cancel: true }));
    }
    pi.on('tool_call', () => ({ block: true, reason: 'Local tools are disabled for ZoomMate.', terminate: true }));
    pi.on('user_bash', () => ({ result: { output: 'Local shell execution is disabled for ZoomMate.', exitCode: 1, cancelled: false, truncated: false } }));
    pi.on('agent_start', () => lifecycle.agentStarted());
    pi.on('agent_settled', (_event, ctx) => {
      if (!ctx.isIdle()) return;
      lifecycle.agentSettled();
      approvalHooks.agentSettled?.();
      update(bridge.state, pendingHydration ?? 'state');
    });
    pi.on('ui_prompt_start', event => { promptDepth++; lifecycle.promptStarted(event); approvalHooks.promptStarted?.(event); mode?.ui.requestRender(); });
    pi.on('ui_prompt_end', event => { promptDepth = Math.max(0, promptDepth - 1); lifecycle.promptEnded(event); approvalHooks.promptEnded?.(event); mode?.ui.requestRender(); });
    pi.on('agent_end', () => {
      mode?.sessionManager.appendCustomEntry('zoommate.native-state', bridge.state);
      for (const cards of nativeCards(bridge.state).values()) for (const card of cards) {
        if (renderedCards.has(card.details.cardId)) continue;
        renderedCards.add(card.details.cardId);
        pi.sendMessage({ customType: card.customType, content: card.content, display: true, details: card.details }, { triggerTurn: false });
      }
    });
    pi.on('session_start', (_event, ctx) => {
      context = ctx;
      approvalHooks.sessionStart?.(ctx);
      if (mode) lifecycle.activate();
      ctx.ui.setHeader(() => dynamicText(() => `${ctx.ui.theme.bold(ctx.ui.theme.fg('accent', 'ZoomMate'))} ${ctx.ui.theme.fg('dim', '· Pi interactive · remote execution')}\n${ctx.ui.theme.fg('muted', label(bridge.identity.user.displayName ?? bridge.identity.user.userId))} ${ctx.ui.theme.fg('dim', `· profile ${label(bridge.launch.profile ?? 'default')} · type / for commands`)}`));
      ctx.ui.setFooter(() => dynamicText(() => {
        const theme = ctx.ui.theme, status = statusOf(bridge);
        const color = status === 'blocked' ? 'warning' : status === 'unknown' ? 'error' : 'accent';
        const credit = creditFooter(bridge.credits, theme);
        const escapeHint = mode?.defaultEditor.isShowingAutocomplete() ? 'Esc closes suggestions'
          : promptDepth ? 'Esc closes this dialog; remote work is not stopped'
          : bridge.stopping ? 'Stopping remote work… Esc will not resend'
          : mode?.interruptPending ? 'Interrupt pending: identifying the in-flight request'
          : bridge.state.activeRequestId && bridge.state.status !== 'idle'
            ? mode?.interruptedRequest === `${bridge.sessionId}:${bridge.state.activeRequestId}` ? 'Stop requested; observing outcome · Esc will not resend' : 'Esc stops the remote turn'
            : mode?.session.isStreaming ? 'Esc interrupts the turn'
            : 'Esc: no active remote turn';
        const operation = bridge.operationStage;
        const progress = operation && operation.stage !== 'completed'
          ? `\n${theme.fg('muted', `${label(operation.label)} · ${Math.max(0, Math.floor((Date.now() - operation.startedAt) / 1000))}s`)}` : '';
        return `${theme.fg(color, bridge.stopping ? 'stopping' : status)} ${theme.fg('dim', `· ${label(bridge.state.title ?? bridge.sessionId ?? 'new conversation')} · ${label(bridge.project?.name ?? 'no project')}`)}\n${credit} ${theme.fg('dim', `· ${bridge.mode} · Profile: ${label(bridge.launch.profile ?? 'default')} · Context: ${selectedContextSummary(bridge.selected)}`)}\n${theme.fg('muted', escapeHint)}${progress}`;
      }));
      update(bridge.state, 'state');
    });
    pi.on('session_shutdown', async () => {
      clearInterval(stageTimer); stageTimer = null;
      try { approvalHooks.dispose?.(); await bridge.close(); }
      finally { await lifecycle.release(); }
    });
  };
  const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime,
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
      extensionFactories: [{ name: 'zoommate', factory: extension }], systemPromptOverride: () => '',
    },
  });
  const manager = agentDir ? SessionManager.create(cwd, join(agentDir, 'sessions')) : SessionManager.inMemory(cwd);
  const created = await createAgentSessionFromServices({ services, sessionManager: manager, model,
    thinkingLevel: 'off', scopedModels: [{ model, thinkingLevel: 'off' }], noTools: 'all', tools: [],
  });
  created.session.setAutoCompactionEnabled(false); created.session.setAutoRetryEnabled(false);
  hydrate(created.session, bridge.state, bridge);
  rememberCards(bridge.state);
  const runtime = new AgentSessionRuntime(created.session, services, async () => { throw new Error('Use native ZoomMate /resume or /new, not local Pi session replacement.'); });
  function update(state, kind) {
    lifecycle.update(kind);
    const operation = bridge.operationStage;
    if (context?.hasUI && operation && operation.stage !== 'completed') {
      stageTimer ??= setInterval(() => mode?.ui.requestRender(), 1000).unref();
    } else { clearInterval(stageTimer); stageTimer = null; }
    if (kind === 'hydrate' || kind === 'reconcile') {
      if (mode?.session.isStreaming) pendingHydration = kind;
      else {
        pendingHydration = undefined;
        hydrate(created.session, state, bridge);
        rememberCards(state);
        projectedState = state;
        if (mode?.isInitialized) { mode.rebuildChatFromMessages(); mode.ui.requestRender(); }
      }
    }
    // Followed turns have no local Pi stream. Refresh the projected transcript
    // in place so assistant deltas become visible without dispatching a turn.
    if (kind === 'state' && state !== projectedState && (bridge.following || ['execution', 'reconciliation'].includes(operation?.stage)) && !mode?.session.isStreaming && mode?.isInitialized) {
      const messages = projectZoomMateHistory(state, created.session.model);
      const localMessages = created.session.messages.filter(message => message.role === 'custom' && !message.details?.cardId);
      created.session.agent.state.messages = [...messages, ...localMessages];
      projectedState = state;
      mode.rebuildChatFromMessages();
      mode.ui.requestRender();
    }
    if (state.title && manager.getSessionName() !== state.title) created.session.setSessionName(state.title);
    const creditSessionId = manager.getSessionId();
    for (const observation of bridge.creditObservations ?? []) if (recordedCredits.get(observation) !== creditSessionId) {
      manager.appendCustomEntry('zoommate.credit-observation', observation);
      recordedCredits.set(observation, creditSessionId);
    }
    const status = statusOf(bridge), key = `${status}:${bridge.sessionId ?? ''}`;
    if (key !== lastReported) {
      lastReported = key;
      if (bridge.sessionId) manager.appendCustomEntry('zoommate.session', { remoteSessionId: bridge.sessionId, status: state.status, actor: bridge.identity.user });
    }
    if (context?.hasUI) {
      if (kind === 'reconcile' && !mode?.session.isStreaming && ['idle', 'blocked'].includes(state.status) && bridge.reconciliation && bridge.reconciliation !== lastReconciliation) {
        lastReconciliation = bridge.reconciliation;
        context.ui.notify(state.asyncStatus === 'cancelled' ? 'Remote stop confirmed by ZoomMate; history reconciled.'
          : state.status === 'blocked' ? !state.activeRequestId && !state.pendingApprovals.length
            ? 'Remote task is waiting for your reply.' : 'Remote input required. /approve reviews the pending action.'
          : state.asyncStatus === 'failed' ? 'Remote turn failed; native history reconciled.'
          : 'Remote turn finished; native history reconciled automatically.', state.asyncStatus === 'failed' ? 'warning' : 'info');
      }
      context.ui.setTitle(`ZoomMate | ${status} | ${label(state.title ?? bridge.sessionId ?? 'new')}`);
      const pending = state.pendingApprovals?.length ?? 0, unsupported = state.unsupportedItems?.length ?? 0;
      const execution = state.execution ?? {}, activity = [];
      if (state.status === 'blocked' && !pending && !state.activeRequestId) activity.push('Remote task is waiting for your reply. Type a message to continue.');
      const requestId = state.activeRequestId ?? execution.currentRequestId;
      const activeTool = execution.tools?.findLast(tool => tool.requestId === requestId && tool.isActive && (tool.brief || tool.description));
      context.ui.setWorkingMessage(bridge.stopping ? 'Stopping remote work…' : activeTool ? label(activeTool.brief ?? activeTool.description)
        : state.status === 'working' && execution.liveStatus?.requestId === requestId ? label(execution.liveStatus.text) || undefined
        : operation && operation.stage !== 'completed' ? label(operation.label) : undefined);
      const relevantExecution = mode?.session.isStreaming && state.status === 'working' && (execution.plan?.some(step => step.requestId === requestId) || execution.tools?.some(tool => tool.requestId === requestId));
      if (['working', 'blocked'].includes(state.status)) {
        if (bridge.following && !mode?.session.isStreaming && execution.liveStatus?.requestId === requestId) activity.push(label(execution.liveStatus.text));
        if (execution.sandbox?.requestId === requestId) activity.push(`Cloud sandbox: ${label(execution.sandbox.status ?? 'unknown')}${execution.sandbox.browserActive ? ' · browser active' : ''}`);
        if (bridge.stopping) activity.push('Stopping remote work… awaiting native confirmation.');
        else if (bridge.following) activity.push('Following remote work automatically.');
      }
      if (state.status === 'unknown') activity.push(bridge.following
        ? 'Checking the remote outcome automatically. No prompt or stop request will be replayed.'
        : `Remote outcome unconfirmed. **/resume** reconnects observation.${bridge.followError ? ` ${label(bridge.followError.code)}: ${label(bridge.followError.message)}` : ''}`);
      if (execution.snapshots?.length) activity.push(`Computer use · ${execution.snapshots.length} snapshot(s) available · /computer to inspect`);
      if (pending) activity.push(`${state.status === 'blocked' ? 'Input required' : 'Optional response controls'}: ${pending}. Provider review appears automatically; **/approve** reopens a dismissed request.`);
      if (unsupported) activity.push(`${unsupported} unsupported item(s) preserved. **/session verbose** shows details.`);
      const body = activity.join('\n\n');
      if (relevantExecution) {
        if (!executionWidget) context.ui.setWidget('zoommate-execution', (tui, theme) => {
          executionWidget = new ZoomMateExecutionWidget(execution, requestId, tui, cwd, theme);
          if (mode) mode.executionWidget = executionWidget;
          return executionWidget;
        });
        else executionWidget.setExecution(execution, requestId);
      } else if (executionWidget) {
        context.ui.setWidget('zoommate-execution', undefined);
        executionWidget = undefined;
        if (mode) mode.executionWidget = undefined;
      }
      if (body !== lastActivity) context.ui.setWidget('zoommate-activity', body ? () => new Markdown(body, 1, 0, getMarkdownTheme()) : undefined);
      lastActivity = body;
      mode?.ui.requestRender();
    }
    mode?.reconcileInterrupt();
  }
  const unsubscribe = bridge.subscribe(update);
  return { runtime, services, model, setMode(value) { mode = value; mode.approvalHooks = approvalHooks; }, dispose: () => runtime.dispose() };
}

export async function startZoomMatePi(options) {
  if (options.agentDir) await mkdir(options.agentDir, { recursive: true, mode: 0o700 });
  const bridge = await createZoomMateBridge(options);
  const reporter = createZoomMateReporter();
  let host;
  try {
    await detectNativeImages();
    host = await createZoomMatePiRuntime(bridge, { agentDir: options.agentDir, reporter });
    const mode = new ZoomMateInteractiveMode(host.runtime, bridge);
    host.setMode(mode);
    await mode.run();
  } finally {
    if (host) await host.dispose();
    else { await bridge.close(); await reporter.release(); }
  }
}
