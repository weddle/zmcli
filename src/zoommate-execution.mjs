import { AppError } from './session.mjs';

const modeFlag = bootstrap => bootstrap?.feature_toggle?.task_input_mode_enabled === true;
export function zoomMateModeOptions(bootstrap = {}) {
  const manualSelection = modeFlag(bootstrap);
  return { defaultMode: 'auto', modes: manualSelection ? ['auto', 'advanced'] : ['auto'], manualSelection };
}
export function resolveZoomMateMode(mode, bootstrap = {}) {
  if (mode === undefined) return undefined;
  if (!['auto', 'advanced'].includes(mode)) throw new AppError('INVALID_INPUT', 'ZoomMate mode must be auto or advanced.');
  if (modeFlag(bootstrap)) return mode;
  if (mode === 'auto') return undefined;
  throw new AppError('UNSUPPORTED', 'This account does not enable native task mode selection. Auto remains the server default.');
}

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const typeOf = part => part.metadata?.part_type ?? part.kind;
const terminalStatuses = new Set(['success', 'succeeded', 'completed', 'done', 'error', 'failed', 'failure', 'cancelled', 'canceled', 'rejected']);
const statusOf = value => typeof value === 'string' ? value.toLowerCase() : undefined;
const requestOf = (message, data) => message.request_id ?? data?.request_id ?? null;
const callOf = (data, response) => data?.action_id ?? data?.tool_call_id ?? response?.action_id ?? response?.tool_call_id ?? null;
const planStepOf = (part, data) => part.metadata?.plan_step_id ?? data?.plan_step_id ?? null;

/*
 * The native stream is not a transcript of independent events: a tool request,
 * partial result and terminal result are updates to one execution.  Keep the
 * reducer deliberately boring and key it by the native call id (and request
 * scope), while retaining an id-less event as its own event.
 */
export function deriveZoomMateExecution(messages = [], options = {}) {
  let sandbox = null, liveStatus = null;
  const plans = new Map(), tools = [], toolByKey = new Map(), callKeys = new Map(), snapshots = [];
  const activeRequestId = options.activeRequestId ?? null;
  const completedRequestIds = new Set(options.completedRequestIds ?? []);
  const authoritativeStatus = options.status ?? null;
  const scoped = Object.hasOwn(options, 'activeRequestId') || Object.hasOwn(options, 'completedRequestIds') || Object.hasOwn(options, 'status');
  const latestAssistant = messages.findLast(message => message.role === 'assistant');
  const currentRequestId = activeRequestId ?? latestAssistant?.request_id ?? latestAssistant?.message_id ?? null;
  const requestIsCurrent = requestId => !scoped || requestId === currentRequestId;
  const toolKey = (requestId, callId, messageId, partId) => callId
    ? `${requestId ?? ''}\u0000${callId}` : `event\u0000${messageId}\u0000${partId ?? tools.length}`;
  const addTool = (candidate, requestId, messageId, partId) => {
    const key = toolKey(requestId, candidate.toolCallId, messageId, partId);
    let index = toolByKey.get(key);
    // Results may omit request_id. Pair only with a unique native call id.
    if (index === undefined && candidate.toolCallId) {
      const candidates = callKeys.get(candidate.toolCallId) ?? [];
      if (candidates.length === 1 && (!requestId || !tools[candidates[0]].requestId || tools[candidates[0]].requestId === requestId)) index = candidates[0];
    }
    if (index === undefined) {
      index = tools.length;
      tools.push(candidate);
      toolByKey.set(key, index);
      if (candidate.toolCallId) callKeys.set(candidate.toolCallId, [...(callKeys.get(candidate.toolCallId) ?? []), index]);
    } else {
      const prior = tools[index];
      const merged = { ...prior, ...candidate, requestId: prior.requestId ?? candidate.requestId,
        messageId: prior.messageId ?? candidate.messageId, partId: prior.partId ?? candidate.partId };
      if (prior.isTerminal || candidate.isTerminal) {
        merged.isTerminal = true;
        delete merged.isActive;
        if (prior.isTerminal && !candidate.isTerminal && prior.status !== undefined) merged.status = prior.status;
        merged.resultReceived = prior.resultReceived || candidate.resultReceived;
      }
      tools[index] = merged;
    }
  };
  for (const message of messages) for (const part of message.parts ?? []) {
    const type = typeOf(part), data = part.data;
    if (!object(data)) continue;
    const response = object(data.response) ? data.response : null;
    const requestId = requestOf(message, data);
    const origin = { messageId: message.message_id, requestId: requestId ?? message.message_id, partId: part.metadata?.part_id ?? null };
    if (type === 'live_status' && typeof data.text === 'string' && requestIsCurrent(requestId)) liveStatus = { ...origin, text: data.text };
    if (type === 'sandbox_update' && typeof data.sandbox_id === 'string') {
      sandbox = { ...origin, id: data.sandbox_id, ...(typeof data.status === 'string' ? { status: data.status } : {}),
        ...(typeof data.browser_active === 'boolean' ? { browserActive: data.browser_active } : {}) };
    }
    if (['plan_outline', 'plan_update', 'plan_step', 'plan_step_metadata', 'plan_step_result', 'plan_step_execution_notify'].includes(type)) {
      const steps = type === 'plan_outline' || type === 'plan_update' ? data.steps : [data];
      if (Array.isArray(steps)) for (const step of steps) {
        if (!object(step)) continue;
        const stepId = step?.plan_step_id ?? (type === 'plan_outline' || type === 'plan_update' || type === 'plan_step' ? step?.step_id : undefined);
        if (typeof stepId !== 'string') continue;
        const planKey = `${origin.requestId ?? ''}\u0000${stepId}`;
        const prior = plans.get(planKey) ?? {};
        const next = { ...prior, ...origin, messageId: prior.messageId ?? origin.messageId, requestId: prior.requestId ?? origin.requestId, stepId };
        for (const field of ['title', 'status', 'description', 'result', 'output', 'error']) if (step[field] !== undefined) next[field] = step[field];
        if (type === 'plan_step_result') next.resultReceived = true;
        plans.set(planKey, next);
      }
    }
    if (!['server_tool', 'server_tool_result', 'client_tool', 'client_tool_result', 'preview', 'live_widget'].includes(type)) continue;
    const detail = object(data.detail) ? data.detail : object(response?.detail) ? response.detail : null;
    if (type.includes('tool')) {
      const resultReceived = type.endsWith('_result');
      const toolCallId = callOf(data, response);
      const status = statusOf(data.status ?? response?.status);
      const partial = data.is_partial === true || response?.is_partial === true || data.partial === true;
      const terminal = terminalStatuses.has(status) || (resultReceived && !partial);
      const candidate = { ...origin, type, resultReceived, ...(terminal ? { isTerminal: true } : {}),
        ...(!terminal ? { isActive: true } : {}), ...(typeof (data.tool ?? data.tool_id) === 'string' ? { toolId: data.tool ?? data.tool_id } : {}),
        ...(typeof toolCallId === 'string' ? { toolCallId } : {}),
        ...(typeof (data.status ?? response?.status) === 'string' ? { status: data.status ?? response.status } : {}),
        ...(typeof response?.response_type === 'string' ? { responseType: response.response_type } : {}),
        ...(data.error !== undefined ? { error: data.error } : response?.error !== undefined ? { error: response.error } : {}),
        ...(typeof data.brief === 'string' ? { brief: data.brief } : {}), ...(typeof data.description === 'string' ? { description: data.description } : {}),
        ...(planStepOf(part, data) ? { planStepId: planStepOf(part, data) } : {}), ...(detail?.canvas_type ? { canvasType: detail.canvas_type } : {}) };
      for (const [key, value] of [['args', data.args ?? data.arguments], ['input', data.input],
        ['result', data.result ?? (resultReceived ? (response?.response_data ?? response?.result ?? response) : undefined)],
        ['output', data.output ?? response?.output]]) if (value !== undefined) candidate[key] = value;
      addTool(candidate, requestId, message.message_id, part.metadata?.part_id);
    }
    if (detail?.canvas_type !== 'browser') continue;
    if (![detail.screenshot_file_id, detail.screenshot_url, detail.screenshot_base64].some(value => typeof value === 'string' && value)) continue;
    snapshots.push({ ...origin, ...(typeof data.tool === 'string' ? { toolId: data.tool } : {}),
      ...(typeof (detail.sandbox_id ?? sandbox?.id) === 'string' ? { sandboxId: detail.sandbox_id ?? sandbox.id } : {}),
      ...(typeof detail.screenshot_file_id === 'string' ? { fileId: detail.screenshot_file_id } : {}),
      ...(typeof detail.screenshot_url === 'string' ? { url: detail.screenshot_url } : {}),
      ...(typeof detail.screenshot_base64 === 'string' ? { base64: detail.screenshot_base64 } : {}),
      ...(typeof detail.page_title === 'string' ? { title: detail.page_title } : {}), ...(typeof detail.url === 'string' ? { pageUrl: detail.url } : {}),
      ...(Number.isSafeInteger(detail.viewport_width) ? { width: detail.viewport_width } : {}),
      ...(Number.isSafeInteger(detail.viewport_height) ? { height: detail.viewport_height } : {}) });
  }
  const currentTools = tools.map(tool => ({ ...tool, current: requestIsCurrent(tool.requestId),
    isActive: !tool.isTerminal && requestIsCurrent(tool.requestId) && (!scoped || ['working', 'processing', 'blocked', 'pendingUser'].includes(authoritativeStatus)) && !completedRequestIds.has(tool.requestId) }));
  const currentPlan = [...plans.values()].map(step => requestIsCurrent(step.requestId) ? { ...step, current: true } : step);
  const currentSandbox = sandbox && requestIsCurrent(sandbox.requestId) ? { ...sandbox, current: true } : sandbox;
  const currentSnapshots = snapshots.map(snapshot => requestIsCurrent(snapshot.requestId) ? { ...snapshot, current: true } : snapshot);
  return { sandbox: currentSandbox, liveStatus, plan: currentPlan, tools: currentTools, snapshots: currentSnapshots,
    ...(currentRequestId ? { currentRequestId } : {}),
    ...(authoritativeStatus ? { turnStatus: authoritativeStatus } : {}) };
}
