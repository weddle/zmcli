import { AppError } from './session.mjs';
import { deriveZoomMateArtifacts } from './zoommate-artifacts.mjs';
import { deriveZoomMateExecution } from './zoommate-execution.mjs';
import { deriveZoomMateCitations, visibleZoomMateTextParts } from './zoommate-citations.mjs';
const KNOWN_PART_TYPES = new Set(['text', 'extended_text', 'status_update', 'live_status', 'client_tool',
  'client_tool_result', 'server_tool', 'server_tool_result', 'thinking', 'agent_reasoning',
  'plan_step_metadata', 'plan_step_result', 'plan_step_execution_notify', 'summary_attachments',
  'create_doc', 'update_doc', 'sandbox_update', 'plan_outline', 'plan_step', 'plan_update', 'agent_submit_result', 'team_submit_result', 'card', 'preview',
  'live_widget', 'suggestion', 'explanation', 'save_template']);
const clone = value => structuredClone(value);
const partType = part => part.metadata?.part_type ?? part.kind;
const malformed = message => { throw new AppError('UNSUPPORTED_RESPONSE', message); };
const textOf = parts => visibleZoomMateTextParts(parts).map(part => part.text ?? '').join('');
const validSkillSuggestion = part => part.kind === 'data' && typeof part.data?.prompt === 'string' && Boolean(part.data.prompt.trim());
function normalize(message) {
  if (!message || typeof message.message_id !== 'string' || !message.message_id || !Array.isArray(message.parts)) malformed('ZoomMate history omitted a message ID or parts.');
  if (message.parts.some(part => !part || typeof part !== 'object')) malformed('ZoomMate returned a malformed message part.');
  return { ...clone(message), text: textOf(message.parts) };
}

export function createZoomMateState(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) malformed('A ZoomMate session ID is required.');
  let messages = [], status = 'idle', activeRequestId = null, pendingApprovals = [], unsupportedItems = [], serverStatus = null, stateArtifacts = [];
  let conversationTitle = null, stateCitations = [], stateSuggestions = [];
  const sequences = new Map(), completed = new Set();
  function derive() {
    const resolved = new Set(), requests = [], unsupported = [], suggestions = [];
    const latestPrompt = messages.findLastIndex(message => message.role === 'user' && message.parts.some(part => ['text', 'extended_text'].includes(partType(part))));
    const latestAssistant = messages.findLast(message => message.role === 'assistant');
    for (const [messageIndex, message] of messages.entries()) {
      for (const part of message.parts) {
        const type = partType(part), data = part.data;
        if (type === 'client_tool_result' && data?.response) {
          if (data.tool_call_id) resolved.add(data.tool_call_id);
        }
        if (messageIndex > latestPrompt && type === 'client_tool' && data && typeof data === 'object' && !data.response) {
          requests.push({ id: data.tool_call_id ?? part.metadata?.part_id ?? message.message_id,
            toolCallId: data.tool_call_id ?? null, toolId: data.tool_id ?? null,
            requestId: message.request_id ?? activeRequestId, sourceType: data.tool_type ?? 'unknown',
            messageId: message.message_id, partId: part.metadata?.part_id ?? null, data: clone(data) });
        }
        if (!KNOWN_PART_TYPES.has(type) || (type === 'client_tool' && data?.tool_type !== 'human_in_the_loop')
          || (type === 'save_template' && !validSkillSuggestion(part))) {
          unsupported.push({ messageId: message.message_id, partId: part.metadata?.part_id ?? null, partType: type, part: clone(part) });
        }
      }
    }
    if (latestAssistant) {
      for (const part of latestAssistant.parts) {
        const type = partType(part), data = part.data;
        if (type === 'save_template' && validSkillSuggestion(part)) {
          suggestions.push({ messageId: latestAssistant.message_id, partId: part.metadata?.part_id ?? null,
            type, prompt: data.prompt });
        }
      }
    }
    stateSuggestions = suggestions;
    const unique = new Map();
    for (const request of requests) if (!resolved.has(request.toolCallId)) unique.set(request.id, request);
    pendingApprovals = ['cancelled', 'failed'].includes(serverStatus) ? [] : [...unique.values()]; unsupportedItems = unsupported;
    const derived = deriveZoomMateArtifacts(messages, { sessionId, pendingApprovals, status });
    if (pendingApprovals.length && !['completed', 'failed', 'cancelled'].includes(serverStatus)) status = 'blocked';
    stateArtifacts = derived.artifacts;
    unsupportedItems = [...unsupportedItems, ...derived.unsupported];
    stateCitations = deriveZoomMateCitations(messages);
  }
  const snapshot = () => ({ sessionId, ...(conversationTitle ? { title: conversationTitle } : {}), messages: clone(messages), status, activeRequestId, asyncStatus: serverStatus,
    pendingApprovals: clone(pendingApprovals), unsupportedItems: clone(unsupportedItems), suggestions: clone(stateSuggestions), artifacts: clone(stateArtifacts),
    execution: deriveZoomMateExecution(messages, { status, activeRequestId, completedRequestIds: completed }), citations: clone(stateCitations) });
  function apply(event) {
    if (!event || typeof event.method !== 'string') malformed('Malformed ZoomMate notification.');
    const { method, params = {} } = event;
    if (params.session_id && params.session_id !== sessionId) return snapshot();
    if (method === 'transport.disconnected') {
      sequences.clear(); status = 'unknown'; return snapshot();
    }
    if (method === 'agent.error') {
      if (params.request_id) completed.add(params.request_id);
      if (!activeRequestId || activeRequestId === params.request_id) {
        activeRequestId = null; serverStatus = 'failed'; status = 'idle'; derive();
      }
      return snapshot();
    }
    if (method === 'agent.history') {
      if (!Array.isArray(params.messages)) malformed('ZoomMate history omitted messages.');
      serverStatus = params.async_status ?? null;
      messages = params.messages.map(normalize); sequences.clear();
      const retainedRequestId = params.active_run?.request_id ?? null;
      const active = retainedRequestId && !['completed', 'failed', 'cancelled'].includes(serverStatus);
      activeRequestId = active ? retainedRequestId : null;
      if (retainedRequestId && !active) completed.add(retainedRequestId);
      status = activeRequestId ? (serverStatus === 'pendingUser' ? 'blocked' : 'working') : 'idle';
      derive(); return snapshot();
    }
    if (method === 'session.info') {
      serverStatus = params.async_status;
      if (typeof params.conversation_title === 'string' && params.conversation_title.trim()) conversationTitle = params.conversation_title;
      if (serverStatus === 'pendingUser') status = 'blocked';
      else if (['completed', 'failed', 'cancelled'].includes(serverStatus)) { status = 'idle'; activeRequestId = null; }
      else if (serverStatus === 'processing') status = 'working';
      derive(); return snapshot();
    }
    if (method === 'session.joined') {
      const requestId = params.active_run?.request_id;
      if (requestId && !completed.has(requestId)) { activeRequestId = requestId; status = 'working'; }
      else if (!activeRequestId) status = 'idle';
      derive(); return snapshot();
    }
    if (method === 'client.continuation') {
      completed.delete(params.request_id); sequences.delete(params.request_id);
      return snapshot();
    }
    if (method === 'client.response_accepted') {
      const message = normalize(params.message);
      if (!messages.some(item => item.message_id === message.message_id)) messages.push(message);
      derive();
      if (status === 'blocked' && !pendingApprovals.length) {
        activeRequestId = params.request_id ?? activeRequestId;
        serverStatus = null;
        status = activeRequestId ? 'working' : 'unknown';
      }
      return snapshot();
    }
    if (method === 'client.accepted') {
      const message = normalize(params.message);
      serverStatus = null;
      if (!messages.some(item => item.message_id === message.message_id)) messages.push(message);
      activeRequestId = params.request_id; status = 'working'; derive(); return snapshot();
    }
    if (method === 'agent.delta') {
      const part = params.part;
      if (!part || typeof part !== 'object' || typeof params.message_id !== 'string' || !params.message_id) malformed('ZoomMate delta omitted its message or part.');
      if (params.seq !== undefined) {
        if (!Number.isSafeInteger(params.seq) || params.seq < 0) malformed('ZoomMate delta has an invalid sequence.');
        const key = params.request_id ?? params.message_id;
        if (sequences.has(key) && params.seq <= sequences.get(key)) return snapshot();
        sequences.set(key, params.seq);
      }
      if (params.request_id && completed.has(params.request_id)) return snapshot();
      let message = messages.find(item => item.message_id === params.message_id);
      if (!message) {
        message = { message_id: params.message_id, request_id: params.request_id, role: 'assistant', parts: [], text: '' };
        messages.push(message);
      }
      const partId = part.metadata?.part_id;
      const index = partId ? message.parts.findIndex(item => item.metadata?.part_id === partId) : -1;
      const prior = index >= 0 ? message.parts[index] : null;
      let next = clone(part);
      if (prior && part.metadata?.append === true) {
        if (part.kind === 'text' && prior.kind === 'text') next.text = `${prior.text ?? ''}${part.text ?? ''}`;
        else if (partType(part) === 'explanation' && typeof prior.data?.content === 'string' && typeof part.data?.content === 'string') next.data.content = prior.data.content + part.data.content;
      }
      if (index < 0) message.parts.push(next); else message.parts[index] = next;
      message.text = textOf(message.parts);
      activeRequestId = params.request_id ?? activeRequestId;
      status = partType(part) === 'status_update' && part.data?.agent_status === 'blocked' ? 'blocked' : 'working';
      derive(); return snapshot();
    }
    if (method === 'agent.done') {
      if (params.request_id && params.async_status !== 'pendingUser') completed.add(params.request_id);
      if (!activeRequestId || activeRequestId === params.request_id) {
        serverStatus = params.async_status ?? 'completed';
        activeRequestId = serverStatus === 'pendingUser' ? params.request_id ?? activeRequestId : null;
        status = serverStatus === 'pendingUser' ? 'blocked' : 'idle';
      }
      derive(); return snapshot();
    }
    return snapshot();
  }
  return { apply, snapshot };
}
