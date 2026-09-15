import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
const PROVIDER_ID = 'zoommate';
const MODEL_ID = 'zoommate';
const API_ID = 'zoommate';
const usageUnavailable = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function textFromLatestUser(context) {
  const message = (Array.isArray(context?.messages) ? context.messages : []).findLast(item => item?.role === 'user');
  if (!message) throw new Error('ZoomMate requires a user message.');
  if (typeof message.content === 'string') { if (!message.content.trim()) throw new Error('ZoomMate requires nonblank user text.'); return message.content; }
  if (!Array.isArray(message.content) || message.content.some(part => part?.type !== 'text')) throw new Error('ZoomMate accepts text-only user messages; images and tool calls are unsupported.');
  const text = message.content.map(part => part.text ?? '').join('');
  if (!text.trim()) throw new Error('ZoomMate requires nonblank user text.');
  return text;
}
function messageFor(model, text, stopReason = 'pending', extras = {}) {
  return { role: 'assistant', content: [{ type: 'text', text }], api: model.api ?? API_ID, provider: model.provider ?? PROVIDER_ID, model: model.id ?? MODEL_ID, usage: usageUnavailable(), stopReason, timestamp: Date.now(), ...extras };
}
function stateText(state, baselineIds, currentRequestId) {
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  return messages.filter(message => {
    if (message?.role !== 'assistant' || typeof message.message_id !== 'string') return false;
    if (baselineIds.has(message.message_id)) return false;
    // Some native delta/history envelopes omit request_id.  The baseline
    // identity fence still excludes restored history; do not drop a
    // legitimate current response solely because that optional scope is absent.
    return !message.request_id || message.request_id === currentRequestId;
  }).map(message => typeof message.text === 'string' ? message.text : Array.isArray(message.parts) ? message.parts.filter(part => part?.kind === 'text').map(part => part.text ?? '').join('') : '').filter(Boolean).join('\n\n');
}
function outcomeDetails(outcome) { return outcome && typeof outcome === 'object' ? outcome.error ?? outcome.result ?? outcome.state ?? outcome.reason : undefined; }

export function createZoomMateProvider(bridge) {
  if (!bridge || typeof bridge.query !== 'function' || typeof bridge.subscribe !== 'function') throw new TypeError('ZoomMate provider requires a bridge with query() and subscribe().');
  const streamSimple = (model, context, options = {}) => {
    const stream = createAssistantMessageEventStream();
    const baselineIds = new Set((bridge.state?.messages ?? []).filter(message => typeof message?.message_id === 'string').map(message => message.message_id));
    let currentRequestId = null, currentText = '', started = false, unsubscribe = () => {};
    const emitSnapshot = text => {
      if (!started) { started = true; stream.push({ type: 'start', partial: messageFor(model, text) }); stream.push({ type: 'text_start', contentIndex: 0, partial: messageFor(model, text) }); }
      else stream.push({ type: 'text_delta', contentIndex: 0, delta: '', partial: messageFor(model, text) });
      currentText = text;
    };
    const onState = state => {
      if (!currentRequestId) return;
      const text = stateText(state, baselineIds, currentRequestId);
      if (!started || text !== currentText) emitSnapshot(text);
    };
    const onEvent = event => {
      if (event?.type === 'prepared') {
        for (const message of event.state?.messages ?? []) baselineIds.add(message.message_id);
        currentRequestId = event.requestId;
        return;
      }
      if (event?.type !== 'accepted') return;
      currentRequestId = event.requestId;
      onState(bridge.state);
    };
    (async () => {
      try {
        const text = textFromLatestUser(context);
        unsubscribe = bridge.subscribe(onState) ?? (() => {});
        const outcome = await bridge.query(text, { signal: options.signal, onEvent });
        if (outcome?.requestId) currentRequestId = outcome.requestId;
        if (outcome?.state) onState(outcome.state);
        const kind = outcome?.outcome ?? 'unknown';
        if (kind === 'completed' || kind === 'blocked') {
          if (!started) emitSnapshot('');
          const final = messageFor(model, currentText, 'stop', kind === 'blocked' ? { zoommateOutcome: kind, zoommateDetails: outcomeDetails(outcome) } : {});
          stream.push({ type: 'text_end', contentIndex: 0, content: currentText, partial: final });
          stream.push({ type: 'done', reason: 'stop', message: final });
        } else {
          if (!started) emitSnapshot(currentText);
          const reason = kind === 'unknown' ? 'aborted' : 'error';
          stream.push({ type: 'error', reason, error: messageFor(model, currentText, reason, { errorMessage: kind === 'unknown' ? 'ZoomMate request outcome is unknown; no retry was attempted.' : outcome?.error?.message ?? 'ZoomMate request failed.', zoommateOutcome: kind, zoommateDetails: outcomeDetails(outcome) }) });
        }
      } catch (error) {
        if (error?.details?.requestId) {
          currentRequestId = error.details.requestId;
          onState(bridge.state);
        }
        if (!started) emitSnapshot('');
        const unknown = error?.details?.outcome === 'unknown';
        stream.push({ type: 'error', reason: unknown ? 'aborted' : 'error', error: messageFor(model, currentText, unknown ? 'aborted' : 'error', { errorMessage: error instanceof Error ? error.message : String(error), zoommateOutcome: unknown ? 'unknown' : 'failed', zoommateDetails: error?.details }) });
      } finally { unsubscribe(); stream.end(); }
    })();
    return stream;
  };
  const nativeModel = { id: MODEL_ID, name: 'ZoomMate native agent', api: API_ID, provider: PROVIDER_ID, baseUrl: 'https://docs.zoom.us', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0 };
  return {
    id: PROVIDER_ID, name: 'ZoomMate', baseUrl: 'https://docs.zoom.us',
    auth: { apiKey: { name: 'Explicit Zoom cookie session', resolve: async () => bridge.identity?.user?.userId && !bridge.closed ? { auth: {}, source: 'Explicit Zoom cookie session' } : undefined } },
    getModels: () => [nativeModel], stream: streamSimple, streamSimple,
  };
}
