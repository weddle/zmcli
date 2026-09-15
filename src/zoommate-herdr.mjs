import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const STATES = new Set(['idle', 'working', 'blocked', 'unknown']);
const safe = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 400);

export function createZoomMateReporter({ env = process.env } = {}) {
  const enabled = env.HERDR_ENV === '1' && Boolean(env.HERDR_BIN_PATH && env.HERDR_PANE_ID);
  const source = 'custom:zoommate', agent = 'zoommate';
  let sequence = Date.now() * 1000, released = false, queue = Promise.resolve();
  function enqueue(args) {
    if (!enabled) return queue;
    queue = queue.then(() => new Promise(resolve => {
      let child;
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { child?.kill(); resolve(); }, 2000);
      try {
        child = spawn(env.HERDR_BIN_PATH, ['pane', ...args], { stdio: 'ignore', windowsHide: true });
        child.once('close', done); child.once('error', done);
      } catch { done(); }
    }));
    return queue;
  }
  return {
    get enabled() { return enabled; },
    get sequence() { return sequence; },
    report(state, message = '', { agentSessionId } = {}) {
      if (!enabled || released) return false;
      const args = ['report-agent', env.HERDR_PANE_ID, '--source', source, '--agent', agent,
        '--state', STATES.has(state) ? state : 'unknown', '--message', safe(message), '--seq', String(++sequence)];
      if (agentSessionId) args.push('--agent-session-id', safe(agentSessionId));
      enqueue(args); return true;
    },
    reset() {
      if (!enabled || released) return;
      enqueue(['release-agent', env.HERDR_PANE_ID, '--source', source, '--agent', agent, '--seq', String(++sequence)]);
    },
    release() {
      if (released) return queue;
      released = true;
      // Release after every queued report, never before a late report can re-claim the pane.
      return enqueue(['release-agent', env.HERDR_PANE_ID, '--source', source, '--agent', agent, '--seq', String(++sequence)]);
    },
  };
}

// Herdr derives native notifications from these semantic transitions. Do not
// also send notification.show: that bypasses focus policy and duplicates delivery.
export function createZoomMateLifecycle(bridge, reporter) {
  let active = false, agentActive = false, externalBlocks = 0, lastState, lastMessage, lastSession;
  const prompts = [];
  const current = () => {
    const title = typeof bridge.state.title === 'string' && bridge.state.title.trim() ? ` · ${safe(bridge.state.title.trim())}` : '';
    if (externalBlocks > 0 || prompts.some(prompt => prompt.blocking) || bridge.awaitingApproval || bridge.state.status === 'blocked') {
      return { state: 'blocked', message: `Human input required; no action auto-approved${title}` };
    }
    if (bridge.state.status === 'unknown') return { state: 'unknown', message: `Remote outcome unknown; resume to reconcile${title}` };
    if (agentActive || bridge.state.status === 'working') return { state: 'working', message: `ZoomMate remote turn${title}` };
    return { state: 'idle', message: `ZoomMate ready${title}` };
  };
  const update = kind => {
    if (!active) return;
    const session = bridge.sessionId ?? null;
    if (kind === 'hydrate' && lastState !== undefined) {
      // Loading history is not a newly completed turn, even in the same session.
      reporter?.reset();
      lastState = undefined; lastMessage = undefined;
    }
    const { state, message } = current();
    if (state === lastState && message === lastMessage && session === lastSession) return;
    lastState = state; lastMessage = message; lastSession = session;
    reporter?.report(state, message, { agentSessionId: session });
  };
  return {
    activate() { active = true; update(); },
    update,
    agentStarted() { if (!active) return; agentActive = true; update(); },
    blockedChanged(data) {
      if (!active) return;
      externalBlocks = data?.active ? externalBlocks + 1 : Math.max(0, externalBlocks - 1);
      update();
    },
    agentSettled() { if (!active) return; agentActive = false; update(); },
    promptStarted(event) {
      if (!active) return;
      // Idle browsing is not an agent waiting on the user. Confirmations and
      // prompts interrupting a remote turn are consequential waiting states.
      prompts.push({ kind: event.kind, title: event.title,
        blocking: agentActive || bridge.awaitingApproval || ['working', 'blocked'].includes(bridge.state.status) || event.kind === 'confirm' });
      update();
    },
    promptEnded(event) {
      const index = prompts.findLastIndex(prompt => prompt.kind === event.kind && prompt.title === event.title);
      if (index >= 0) prompts.splice(index, 1);
      update();
    },
    release() { active = false; externalBlocks = 0; prompts.length = 0; return reporter?.release(); },
  };
}

export function zoomMateLaunchRecipe({ cookies, profile, configDir, resume, project } = {}) {
  if ((typeof cookies !== 'string' || !cookies || cookies.includes('\0'))
    && (typeof profile !== 'string' || !profile || profile.includes('\0'))) return null;
  const args = [fileURLToPath(new URL('./zoommate-tui.mjs', import.meta.url))];
  if (typeof profile === 'string' && profile && !profile.includes('\0')) args.push('--profile', profile);
  if (typeof configDir === 'string' && configDir && !configDir.includes('\0')) args.push('--config-dir', resolve(configDir));
  if (typeof cookies === 'string' && cookies && !cookies.includes('\0')) args.push('--cookies', resolve(cookies));
  if (resume) args.push('--resume', resume);
  if (project) args.push('--project', project);
  return { command: process.execPath, args, cwd: process.cwd() };
}
