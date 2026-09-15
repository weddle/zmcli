import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZoomMateLifecycle, createZoomMateReporter } from '../src/zoommate-herdr.mjs';

function fixture() {
  const bridge = { sessionId: 'remote-a', busy: false, awaitingApproval: false, state: { status: 'idle' } };
  const events = [];
  const lifecycle = createZoomMateLifecycle(bridge, {
    report: (state, _message, { agentSessionId }) => events.push({ state, session: agentSessionId }),
    reset: () => events.push({ reset: true }),
    release: () => events.push({ release: true }),
  });
  lifecycle.activate();
  return { bridge, events, lifecycle, states: () => events.filter(event => event.state).map(event => event.state) };
}

test('history loading and idle browsing do not create completed turns; native idle waits for Pi settlement', () => {
  const { bridge, lifecycle, states } = fixture();
  bridge.busy = true; lifecycle.update('operation');
  lifecycle.update('hydrate');
  bridge.busy = false; lifecycle.update('operation');
  lifecycle.promptStarted({ kind: 'custom' });
  lifecycle.promptEnded({ kind: 'custom' });
  assert.deepEqual(states(), ['idle', 'idle']);
  lifecycle.agentStarted();
  bridge.busy = true; lifecycle.update('operation');
  bridge.state.status = 'working'; lifecycle.update('state');
  bridge.state.status = 'idle'; lifecycle.update('state');
  bridge.busy = false; lifecycle.update('operation');
  assert.deepEqual(states(), ['idle', 'idle', 'working']);
  lifecycle.agentSettled();
  lifecycle.agentSettled();
  lifecycle.update('context');
  assert.deepEqual(states(), ['idle', 'idle', 'working', 'idle']);
});
test('nested human prompts restore working only after the final prompt closes', () => {
  const { lifecycle, states } = fixture();
  lifecycle.agentStarted();
  const prompt = { kind: 'confirm', title: 'Confirm action' };
  lifecycle.promptStarted(prompt);
  lifecycle.promptStarted(prompt);
  lifecycle.promptEnded({ kind: 'input', title: 'Unrelated' });
  lifecycle.promptEnded(prompt);
  assert.deepEqual(states(), ['idle', 'working', 'blocked']);
  lifecycle.promptEnded(prompt);
  assert.deepEqual(states(), ['idle', 'working', 'blocked', 'working']);
  lifecycle.agentSettled();
  assert.equal(states().at(-1), 'idle');
});

test('remote approval and unknown outcomes remain authoritative after Pi settles', () => {
  const { bridge, lifecycle, states } = fixture();

  lifecycle.agentStarted();
  bridge.state.status = 'blocked'; lifecycle.update('state');
  lifecycle.agentSettled();
  assert.equal(states().at(-1), 'blocked');
  bridge.awaitingApproval = true;
  bridge.state.status = 'idle'; lifecycle.update('operation');
  assert.equal(states().at(-1), 'blocked');
  bridge.awaitingApproval = false;
  bridge.state.status = 'unknown'; lifecycle.update('state');
  lifecycle.agentSettled();
  assert.deepEqual(states(), ['idle', 'working', 'blocked', 'unknown']);
});
test('standard herdr blocked events compose with native dialogs without clearing each other', () => {
  const { lifecycle, states } = fixture();
  lifecycle.agentStarted();
  lifecycle.blockedChanged({ active: true });
  lifecycle.blockedChanged({ active: true });
  const prompt = { kind: 'confirm' };
  lifecycle.promptStarted(prompt);
  lifecycle.blockedChanged({ active: false });
  lifecycle.blockedChanged({ active: false });
  lifecycle.blockedChanged({ active: false });
  assert.equal(states().at(-1), 'blocked');
  lifecycle.promptEnded(prompt);
  assert.deepEqual(states(), ['idle', 'working', 'blocked', 'working']);
});

test('changing remote conversations resets completion authority and never reports a local Pi session', () => {
  const { bridge, lifecycle, events } = fixture();
  bridge.state.status = 'working'; lifecycle.update('state');
  bridge.sessionId = 'remote-b'; bridge.state.status = 'idle'; lifecycle.update('hydrate');
  assert.deepEqual(events.slice(-2), [{ reset: true }, { state: 'idle', session: 'remote-b' }]);
  lifecycle.release();
  const count = events.length;
  lifecycle.agentStarted(); lifecycle.update('state'); lifecycle.promptStarted({ kind: 'confirm' });
  assert.equal(events.length, count);
});

test('reporter preserves report/reset/release ordering and stops after shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zoommate-herdr-test-'));
  try {
    const log = join(dir, 'events.jsonl'), executable = join(dir, 'herdr');
    await writeFile(executable, `#!/usr/bin/env node\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o700 });
    const reporter = createZoomMateReporter({ env: { HERDR_ENV: '1', HERDR_BIN_PATH: executable, HERDR_PANE_ID: 'test-pane' } });
    reporter.report('working', 'remote turn', { agentSessionId: 'remote-a' });
    reporter.reset();
    reporter.report('idle', 'ready', { agentSessionId: 'remote-b' });
    await reporter.release();
    assert.equal(reporter.report('working'), false);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.map(call => call[1]), ['report-agent', 'release-agent', 'report-agent', 'release-agent']);
    const sequences = calls.map(call => Number(call[call.indexOf('--seq') + 1]));
    assert.ok(sequences.every((value, index) => index === 0 || value > sequences[index - 1]));
    assert.equal(calls[2][calls[2].indexOf('--agent-session-id') + 1], 'remote-b');
    assert.ok(calls.every(call => !call.includes('notification') && !call.includes('--agent-session-path')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('standalone execution and incomplete Herdr environments never invoke an integration', async () => {
  for (const env of [{}, { HERDR_ENV: '1', HERDR_BIN_PATH: '/not-an-executable' }]) {
    const reporter = createZoomMateReporter({ env });
    assert.equal(reporter.enabled, false);
    assert.equal(reporter.report('working'), false);
    reporter.reset();
    await reporter.release();
  }
});
