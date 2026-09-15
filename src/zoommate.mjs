import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { AppError, writeFailure } from './session.mjs';
import { encodeCursor, decodeCursor } from './cursor.mjs';
import { createZoomMateState } from './zoommate-state.mjs';
import { zoomMateModeOptions, resolveZoomMateMode } from './zoommate-execution.mjs';
import { readZoomMateArtifact, saveZoomMateArtifact, exportZoomMateArtifact, readZoomMateSnapshot } from './zoommate-artifact-api.mjs';
import { prepareZoomMateDocumentEdit, commitZoomMateDocumentEdit } from './zoommate-document-edits.mjs';

export const ZOOMMATE_ACTIONS = Object.freeze(['status', 'capabilities', 'chats', 'search-chats', 'history', 'rename',
  'query', 'watch', 'cancel', 'projects', 'project', 'project-context', 'files', 'file', 'resources',
  'connectors', 'skills', 'credits', 'credit-history', 'approve', 'artifacts', 'artifact', 'artifact-save', 'artifact-export', 'snapshot', 'devices']);
const fail = (code, message, details) => { throw new AppError(code, message, details); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) fail('INVALID_INPUT', `${label} must be a nonblank identifier.`);
  return value;
};
const idPath = (base, id) => `${base}/${encodeURIComponent(required(id, 'ID'))}`;
const number = (value, fallback, min = 1, max = 100) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail('INVALID_INPUT', `Expected an integer from ${min} to ${max}.`);
  return n;
};
const list = (data, key) => {
  const items = key ? data?.[key] : data;
  if (!Array.isArray(items)) fail('UNSUPPORTED_RESPONSE', 'ZoomMate returned a response without the required list.');
  return items;
};
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clientInfo = () => ({ device_id: '', client_type: 'browser', client_timezone: 'UTC', client_utc_offset: 0, client_lang: 'en-US' });
const timeout = options => number(options['timeout-ms'], 120000, 1, 3600000);
const emit = (options, type, data) => options.onEvent?.({ version: 1, type, ...data });
const stage = (options, sessionId, requestId, stageName, label) => emit(options, 'operation-stage', {
  sessionId, ...(requestId ? { requestId } : {}), stage: stageName, label, startedAt: Date.now(),
});
const EMPTY_SCENARIO = { agent_specific_feature: { agent_id: '', spec_id: '', agent_name: '', project_type: 'new_task' } };
const resourceTypes = {
  meeting: { entity_type: 'meeting' }, chat_group: { entity_type: 'chat_group', filter: { type: null, is_archived: false } },
  zoom_doc: { entity_type: 'zoom_doc', filter: { list_doc_type: 'recent', list_doc_file_type: null } },
  notes: { entity_type: 'notes' },
  'file-google': { entity_type: 'file', source: 'google' }, 'file-microsoft': { entity_type: 'file', source: 'microsoft' },
  'email-google': { entity_type: 'email', source: 'google' }, 'email-microsoft': { entity_type: 'email', source: 'microsoft' },
};
function scope(session, action, options, limit) {
  const user = session.identity?.user;
  if (!user?.userId || !user.accountId) fail('AUTH_REQUIRED', 'ZoomMate identity is missing.');
  return [`zoommate ${action}`, user.accountId, user.userId, options.id ?? null,
    options.query ?? '', options.type ?? null, options.since ?? null, options.until ?? null, limit];
}
function pageResult(items, hasMore, next, binding, previous, extra = {}) {
  if (typeof hasMore !== 'boolean') fail('UNSUPPORTED_RESPONSE', 'ZoomMate did not report pagination coverage.');
  const signature = fingerprint(items);
  if (hasMore && (!next || !items.length || signature === previous?.previous || JSON.stringify(next) === JSON.stringify(previous?.native))) {
    return { items, hasMore: true, nextCursor: null, ...extra, coverage: { complete: false, reason: 'nonadvancing-native-page' } };
  }
  return { items, hasMore, nextCursor: hasMore ? encodeCursor(binding, { native: next, previous: signature }) : null,
    ...extra, coverage: { complete: !hasMore } };
}
function positionFor(options, binding, kind) {
  if (!options.cursor) return undefined;
  const position = decodeCursor(options.cursor, binding), native = position.native;
  if (kind === 'search_after') {
    if (typeof native.search_after !== 'string' || !native.search_after) fail('INVALID_INPUT', 'Invalid project cursor.');
  } else if (!Number.isSafeInteger(native[kind]) || native[kind] < (kind === 'page' ? 1 : 0)) fail('INVALID_INPUT', 'Invalid native page position.');
  return position;
}
function timeBound(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/(?:Z|[+-]\d\d:\d\d)$/u.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_INPUT', 'Credit timestamps require an explicit UTC offset.');
  return Date.parse(value);
}

async function readPage(session, transport, action, options) {
  const limit = number(options.limit, action === 'credit-history' ? 10 : 50), binding = scope(session, action, options, limit);
  const kind = action === 'projects' ? 'search_after' : action === 'credit-history' ? 'page' : action === 'resources' ? 'start' : 'offset';
  const position = positionFor(options, binding, kind), native = position?.native;
  const request = (path, body) => transport.request(path, { ...(body ? { method: 'POST', body } : {}), signal: options.signal });
  if (action === 'chats' || action === 'search-chats') {
    const body = { limit, ...(native ? { next_offset: native.offset } : {}),
      ...(action === 'chats' ? { filters: { is_scheduled: false, is_ask_meeting: false } } : { keyword: required(options.query, 'Search query') }) };
    const data = await request(`/api/v1/session/${action === 'chats' ? 'list' : 'search'}`, body);
    const more = data.has_more ?? data.continuation?.has_more;
    const offset = data.continuation?.next_offset ?? data.next_offset;
    return pageResult(list(data, 'result'), more, offset == null ? null : { offset }, binding, position);
  }
  if (action === 'projects') {
    const params = new URLSearchParams({ limit: String(limit), ...(native ? { search_after: native.search_after } : {}) });
    const data = await request(`/api/v1/projects?${params}`);
    return pageResult(list(data, 'projects'), data.has_more, data.next_search_after ? { search_after: data.next_search_after } : null, binding, position, { total: data.total });
  }
  if (action === 'resources') {
    const type = resourceTypes[options.type];
    if (!type) fail('INVALID_INPUT', 'Unknown resource type.', { validTypes: Object.keys(resourceTypes) });
    const data = await request('/api/v1/resource-panel/items/page', { start: native?.start ?? 0, take: limit, query: options.query ?? '',
      source: null, start_time: null, end_time: null, ...type, ...(native?.continuation === undefined ? {} : { continuation: native.continuation }) });
    const items = list(data, 'result');
    return pageResult(items, data.has_more, { start: (native?.start ?? 0) + items.length, continuation: data.continuation }, binding, position,
      { type: options.type, requestedLimit: limit, limitHonored: items.length <= limit });
  }
  if (action === 'credit-history') {
    const since = timeBound(options.since), until = timeBound(options.until);
    if (since !== null && until !== null && since >= until) fail('INVALID_INPUT', 'Credit --since must precede --until.');
    const current = native?.page ?? 1;
    const params = new URLSearchParams({ app_id: 'zoommate_app', limit: String(limit), page: String(current), sort_by: 'time', sort_order: 'desc' });
    const data = await request(`/api/v1/credits/history?${params}`), rows = list(data, 'records');
    if (!Number.isSafeInteger(data.total) || data.total < 0) fail('UNSUPPORTED_RESPONSE', 'Credit history omitted its total.');
    const result = pageResult(rows, current * limit < data.total, { page: current + 1 }, binding, position, { total: data.total, billingMayBeDelayed: true });
    result.items = rows.filter(record => { const at = Date.parse(record.time); return (since === null || at >= since) && (until === null || at < until); });
    if (since !== null || until !== null) result.timeFilter = { since: options.since ?? null, until: options.until ?? null, applied: 'locally-to-native-pages' };
    return result;
  }
  fail('INVALID_INPUT', 'Unknown paged action.');
}

// One listener owns hydration and streaming so a delta or done arriving before an RPC acknowledgement is not lost.
function observe(transport, sessionId, options, requestId = null) {
  const state = createZoomMateState(sessionId), completed = new Map(), waiters = new Set(), pendingRequests = new Set();
  let history = null, historyError = null, disconnected = false, historyRequested = false, dispatched = !requestId;
  let latestSnapshot = null, liveControls = null;
  const publish = () => {
    const snapshot = state.snapshot();
    latestSnapshot = snapshot;
    pendingRequests.clear();
    if (snapshot.status === 'blocked') for (const pending of snapshot.pendingApprovals) pendingRequests.add(pending.requestId ?? pending.messageId);
    emit(options, 'state', { state: snapshot });
    for (const update of [...waiters]) update();
  };
  const unsubscribe = transport.subscribe(event => {
    if (event.params?.session_id && event.params.session_id !== sessionId) return;
    if (event.method === 'agent.history' && !historyRequested) return;
    if (requestId && ['agent.delta', 'agent.done', 'agent.error'].includes(event.method)
      && (!dispatched || event.params?.request_id && event.params.request_id !== requestId)) return;
    try {
      state.apply(event);
      if (event.method === 'agent.history') { history = event.params; liveControls?.clear(); }
      if (event.method === 'agent.delta' && event.params.part?.metadata?.part_type === 'client_tool') {
        (liveControls ??= new Set()).add(event.params.part.data?.tool_call_id);
      }
      if (event.method === 'agent.done') completed.set(event.params.request_id, {
        outcome: event.params.async_status === 'pendingUser' ? 'blocked' : event.params.async_status === 'failed' ? 'failed' : 'completed', result: event.params,
      });
      if (event.method === 'agent.error') completed.set(event.params.request_id, { outcome: 'failed', error: event.params });
      if (event.method === 'transport.disconnected') disconnected = true;
    } catch (error) { historyError = new AppError('UNSUPPORTED_RESPONSE', error.message); }
    publish();
  });
  function until(check, ms) {
    return new Promise((resolve, reject) => {
      const finish = (error, value) => { clearTimeout(timer); waiters.delete(update); options.signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      const update = () => {
        if (historyError) return finish(historyError);
        try { const value = check(); if (value !== undefined) finish(null, value); } catch (error) { finish(error); }
      };
      const abort = () => finish(null, { outcome: 'unknown', reason: 'detached' });
      const timer = setTimeout(() => finish(null, { outcome: 'unknown', reason: 'timeout' }), ms);
      waiters.add(update); options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort(); else update();
    });
  }
  return {
    state,
    beginRequest() { dispatched = true; },
    async join() {
      await transport.connect({ signal: options.signal });
      historyRequested = true;
      const joined = await transport.send('session.join', { session_id: sessionId }, { signal: options.signal });
      if (joined?.session_id !== sessionId || !Object.hasOwn(joined, 'active_run')) fail('UNSUPPORTED_RESPONSE', 'ZoomMate did not confirm the requested conversation.');
      const loaded = await until(() => history ?? (disconnected ? { outcome: 'unknown' } : undefined), 15000);
      if (!Array.isArray(loaded.messages)) fail('REQUEST_FAILED', 'Remote history was not received; no request sent.');
      state.apply({ method: 'session.joined', params: { session_id: sessionId, active_run: joined.active_run } });
      const info = await transport.request(`${idPath('/api/v1/session', sessionId)}/info`, { signal: options.signal });
      state.apply({ method: 'session.info', params: info });
      publish();
      return { joined, history: loaded };
    },
    async approvalSnapshot() {
      const { joined } = await this.join(), active = joined.active_run?.request_id;
      // Active-run controls arrive as replayed deltas, not in persisted history.load pages.
      if (active && !['completed', 'failed', 'cancelled'].includes(latestSnapshot.asyncStatus)) {
        const ready = await until(() => {
          if (disconnected) return { outcome: 'unknown', reason: 'disconnected' };
          if (completed.has(active)) return true;
          if (latestSnapshot.pendingApprovals.some(pending => (pending.requestId ?? pending.messageId) === active
            && liveControls?.has(pending.toolCallId))) return true;
          return undefined;
        }, Math.min(timeout(options), 15000));
        if (ready?.outcome === 'unknown') fail('REQUEST_FAILED', 'Fresh native approval state could not be verified. Nothing was sent.', { reason: ready.reason });
      }
      return state.snapshot();
    },
    async wait(requestId, options) { return this.waitAny([requestId], options); },
    async waitAny(requestIds, { terminalOnly = false } = {}) {
      const ids = [...new Set(requestIds.filter(id => typeof id === 'string' && id))];
      const result = await until(() => {
        for (const id of ids) if (completed.has(id)) return { ...completed.get(id), requestId: id };
        if (disconnected) return { outcome: 'unknown', reason: 'disconnected' };
        if (!terminalOnly) for (const id of ids) if (pendingRequests.has(id)) return { outcome: 'blocked', requestId: id };
        return undefined;
      }, timeout(options));
      if (result.outcome === 'unknown') state.apply({ method: 'transport.disconnected', params: {} });
      const output = { ...result, requestId: result.requestId ?? ids[0], sessionId, state: state.snapshot() };
      emit(options, result.outcome === 'blocked' ? 'approval-required' : result.outcome, output);
      publish(); return output;
    },
    publish,
    beginContinuation(requestId) {
      completed.delete(requestId);
      state.apply({ method: 'client.continuation', params: { request_id: requestId } });
    },
    close() { unsubscribe(); },
  };
}
async function scenario(transport, project, signal) {
  if (!project) return structuredClone(EMPTY_SCENARIO);
  const record = await transport.request(idPath('/api/v1/projects', project), { signal });
  if (record?.id !== project || typeof record.name !== 'string' || typeof record.project_type !== 'string') fail('UNSUPPORTED_RESPONSE', 'Project identity or type is missing.');
  const spec = ['project', 'teammate', 'caic_custom_agent', 'custom_agent', 'system_agent', 'scheduled_task'].includes(record.project_type);
  return { agent_specific_feature: { agent_id: spec ? '' : record.id, spec_id: spec ? record.id : '',
    agent_name: record.name, project_type: record.project_type, ...(record.template_id ? { template_id: record.template_id } : {}) } };
}
async function references(session, transport, options) {
  const refs = { selected_entities: [], selected_skills: [], selected_apps: [], selected_plugins: [], selected_workflows: [] };
  const values = key => {
    const items = options[key] ?? [];
    if (!Array.isArray(items) || items.some(item => typeof item !== 'string' || !item.trim())) fail('INVALID_INPUT', `${key} must be an array of IDs.`);
    return [...new Set(items)];
  };
  const entityIds = values('entity');
  const grouped = new Map();
  for (const ref of entityIds) {
    const separator = ref.indexOf(':'), type = ref.slice(0, separator), id = ref.slice(separator + 1);
    if (separator < 1 || !resourceTypes[type] || !id) fail('INVALID_INPUT', 'Context selections require TYPE:ID from native resources.');
    if (!grouped.has(type)) grouped.set(type, new Set()); grouped.get(type).add(id);
  }
  for (const [type, ids] of grouped) {
    let cursor;
    do {
      const page = await readPage(session, transport, 'resources', { type, cursor, signal: options.signal });
      for (const record of page.items) {
        if (!ids.has(record.id)) continue;
        if (!record.entity_type || !record.name) fail('UNSUPPORTED_RESPONSE', 'Selected resource omitted its type or name.');
        const { displayName, addedByScene, isImplicitContext, isPastedTextFile, ...native } = record;
        refs.selected_entities.push({ ...native, name: displayName ?? record.name }); ids.delete(record.id);
      }
      cursor = page.nextCursor;
    } while (ids.size && cursor);
    if (ids.size) fail('INVALID_INPUT', 'Selected context is not available to this actor.', { ids: [...ids], type });
  }
  for (const [key, path, field] of [['skill', '/api/v1/skills', 'skills'], ['connector', '/api/v1/connectors/me', 'connectors']]) {
    const requested = values(key); if (!requested.length) continue;
    const records = list(await transport.request(path, { signal: options.signal }), field);
    for (const id of requested) {
      const record = records.find(item => item.id === id || (key === 'skill' && item.skill_id === id));
      if (!record) fail('INVALID_INPUT', `Selected ${key} is unavailable.`, { id });
      if (record.enabled === false || record.authorized === false || (key === 'connector' && record.connection_status !== 'connected' && record.connection_status !== 'connect')) fail('FORBIDDEN', `Selected ${key} is not enabled and connected.`, { id });
      if (key === 'skill') refs.selected_skills.push({ id: record.id, skill_id: record.skill_id, name: record.name, ...(record.raw_arguments !== undefined ? { raw_arguments: record.raw_arguments } : {}) });
      else refs.selected_apps.push({ app_id: record.id, app_name: record.name, ...(record.display_name ? { display_name: record.display_name } : {}) });
    }
  }
  return refs;
}
async function artifactAction(transport, action, options) {
  const observation = observe(transport, required(options.id, 'Session ID'), options);
  try {
    await observation.join();
    const state = observation.state.snapshot();
    if (action === 'artifacts') return { sessionId: state.sessionId, items: state.artifacts };
    if (action === 'snapshot') {
      const snapshots = state.execution.snapshots.filter(item => item.partId === options.snapshot
        && (options['message-id'] === undefined || item.messageId === options['message-id']));
      if (snapshots.length !== 1) fail('TARGET_NOT_FOUND', 'Select one unambiguous native screenshot from this conversation.');
      return await readZoomMateSnapshot(transport, snapshots[0], options);
    }
    const artifact = state.artifacts.find(item => item.key === options.artifact);
    if (!artifact) fail('TARGET_NOT_FOUND', 'The artifact is not present in this native conversation.');
    const operation = { artifact: readZoomMateArtifact, 'artifact-save': saveZoomMateArtifact, 'artifact-export': exportZoomMateArtifact }[action];
    return await operation(transport, artifact, options);
  } finally { observation.close(); }
}

async function query(session, transport, options) {
  if ((options.new === true) === (options.id !== undefined)) fail('INVALID_INPUT', 'Choose exactly one existing ID or new:true.');
  if (typeof options.prompt !== 'string' || !options.prompt.trim() || Buffer.byteLength(options.prompt) > 262144) fail('INVALID_INPUT', 'A nonblank prompt of at most 256 KiB is required.');
  const mode = resolveZoomMateMode(options.mode, transport.bootstrap);
  if (options.artifact !== undefined && (!Array.isArray(options.artifact) || options.artifact.some(key => typeof key !== 'string'))) fail('INVALID_INPUT', 'Artifact references must be an array of native artifact keys.');
  const refs = await references(session, transport, options), requestScenario = await scenario(transport, options.project, options.signal);
  const sessionId = options.id ? required(options.id, 'Session ID') : randomBytes(16).toString('base64url').slice(0, 21);
  const requestId = `request-${randomUUID()}`, observation = observe(transport, sessionId, options, requestId);
  try {
    if (options.id) {
      await observation.join();
      const snapshot = observation.state.snapshot();
      if (snapshot.status === 'working' || (snapshot.status === 'blocked' && (snapshot.activeRequestId || snapshot.pendingApprovals.length))) fail('RUN_ACTIVE', 'The conversation has an active request or pending control. Resume or answer it first.');
    } else await transport.connect({ signal: options.signal });
    for (const key of new Set(options.artifact ?? [])) {
      const artifact = observation.state.snapshot().artifacts.find(item => item.key === key);
      if (!artifact) fail('TARGET_NOT_FOUND', 'A referenced artifact is not in this native conversation.', { artifact: key });
      const entity = artifact.kind === 'document'
        ? { id: artifact.id, entity_type: 'zoom_doc', name: artifact.title }
        : { id: artifact.id, entity_type: 'file', name: artifact.title, file_id: artifact.id, file_name: artifact.title };
      if (!refs.selected_entities.some(item => item.id === entity.id && item.entity_type === entity.entity_type)) refs.selected_entities.push(entity);
    }
    const message = { message_id: randomUUID(), role: 'user', timestamp: Date.now(),
      parts: [{ kind: 'text', text: options.prompt, metadata: { part_type: 'text', part_id: randomUUID() } }], ...refs, scene: { sources: null },
      ...(mode === undefined ? {} : { mode }) };
    emit(options, 'prepared', { sessionId, requestId, state: observation.state.snapshot() });
    observation.beginRequest();
    observation.state.apply({ method: 'client.accepted', params: { request_id: requestId, message } });
    stage(options, sessionId, requestId, 'execution', 'Starting native execution');
    const accepted = await transport.send('agent.run', { request_id: requestId, session_id: sessionId, message,
      request_configs: { streaming_format: 'v2', browser: { use_my_browser: false } }, client_info: clientInfo(), request_scenario: requestScenario }, { signal: options.signal });
    if (accepted?.request_id !== requestId) fail('WRITE_UNCONFIRMED', 'The run acknowledgement did not match. No resend attempted.', { outcome: 'unknown', sessionId, requestId });
    emit(options, 'accepted', { sessionId, requestId, result: accepted }); observation.publish();
    stage(options, sessionId, requestId, 'execution', 'Remote execution');
    const result = await observation.wait(requestId);
    if (result.outcome === 'completed' || result.outcome === 'failed') stage(options, sessionId, requestId, 'completed', result.outcome === 'completed' ? 'Native execution completed' : 'Native execution failed');
    return result;
  } catch (error) {
    if (error.details?.outcome === 'unknown') error.details = { ...error.details, sessionId, requestId };
    throw error;
  } finally { observation.close(); }
}
function approvalChoices(pending) {
  const data = pending.data;
  if (data?.tool_type !== 'human_in_the_loop' || !Array.isArray(data.parameters_values)) return [];
  const params = Object.fromEntries(data.parameters_values.map(item => [item.name, item.value]));
  if (data.tool_id === 'system_ask_user_confirmation' && typeof params.confirmResponseContent === 'string' && typeof params.cancelResponseContent === 'string') {
    return [{ id: 'confirm', label: params.confirmText ?? 'Confirm', response: { response_type: 'success', response_content: params.confirmResponseContent, request_agent_response: true } },
      { id: 'cancel', label: params.cancelText ?? 'Cancel', response: { response_type: 'error', response_content: params.cancelResponseContent, request_agent_response: true } }];
  }
  const spec = params.spec;
  if (!['system_dynamic_form', 'human_in_the_loop_tool'].includes(data.tool_id) || !object(spec) || !Array.isArray(spec.actions) || !Array.isArray(spec.fields)) return [];
  // Only display-only forms and native document edit cards have implemented controls.
  if (spec.fields.some(field => !['display', 'edit_canvas_card'].includes(field.type))) return [];
  return spec.actions.filter(action => ['submit', 'cancel', 'send'].includes(action.type) && typeof action.id === 'string' && action.id !== 'session_bypass' && typeof action.message === 'string')
    .map(action => ({ id: action.id, label: action.label ?? action.message,
      method: spec.meta?.quick_approve === true || spec.meta?.path_a_resume === true ? 'client.hitlResolve' : 'client.toolResult',
      targetRequestId: spec.meta?.path_a_resume === true ? pending.messageId : null,
      continuationRequestId: spec.meta?.quick_approve === true ? pending.requestId ?? pending.messageId : null,
      response: { response_type: 'success', response_content: action.message, request_agent_response: true,
        response_data: { action_id: action.id, action_type: action.type, ...(action.type === 'submit' ? { values: {} } : {}), message: action.message } } }));
}
async function approve(transport, options) {
  if (typeof options.confirmApproval !== 'function') fail('PROVIDER_APPROVAL_REQUIRED', 'Explicit interactive approval is required.');
  const sessionId = required(options.id, 'Session ID');
  let observation = observe(transport, sessionId, options);
  let docs;
  const committed = [];
  try {
    const snapshot = await observation.approvalSnapshot(), pending = snapshot.pendingApprovals;
    const detail = options['tool-call-id'] ? pending.find(item => item.toolCallId === options['tool-call-id']) : pending[0];
    if (!detail) fail('INVALID_INPUT', 'There is no pending approval in the current remote history.');
    const approvalRequestId = detail.requestId ?? detail.messageId;
    stage(options, sessionId, approvalRequestId, 'review', 'Preparing approval review');
    let choices = approvalChoices(detail);
    if (!choices.length) fail('PROVIDER_APPROVAL_REQUIRED', 'This request needs an unsupported interactive control. Nothing was run.', { pending: detail });
    const plans = [], documentEdits = [];
    const fields = detail.data.parameters_values?.find(item => item.name === 'spec')?.value?.fields ?? [];
    for (const field of fields.filter(item => item.type === 'edit_canvas_card')) {
      const artifact = snapshot.artifacts.find(item => item.update?.editId === field.props?.edit_id && item.update?.approvalId === detail.toolCallId);
      if (!artifact) fail('UNSUPPORTED_RESPONSE', 'The document approval does not identify an available native artifact.');
      docs ??= await transport.openDocs({ signal: options.signal });
      try {
        const plan = await prepareZoomMateDocumentEdit(docs, artifact); plans.push(plan);
        documentEdits.push({ documentId: plan.documentId, title: plan.title, baseVersion: plan.baseVersion,
          beforeMarkdown: plan.beforeMarkdown, afterMarkdown: plan.afterMarkdown, changes: plan.changes });
      } catch (error) {
        if (!['UNSUPPORTED_EDIT', 'AMBIGUOUS_EDIT_TARGET', 'TARGET_NOT_FOUND'].includes(error.code)) throw error;
        choices = choices.filter(choice => choice.id !== 'canvas_accept');
        documentEdits.push({ documentId: artifact.id, title: artifact.title, unsupported: error.message, url: `https://docs.zoom.us/doc/${artifact.id}` });
      }
    }
    stage(options, sessionId, approvalRequestId, 'approval', 'Awaiting explicit approval');
    const decision = await options.confirmApproval({ sessionId, pending: detail, choices, documentEdits });
    if (!object(decision) || typeof decision.choice !== 'string') fail('PROVIDER_APPROVAL_REQUIRED', 'Approval was not granted. Nothing was sent.');
    const choice = choices.find(item => item.id === decision.choice);
    if (!choice) fail('INVALID_INPUT', 'The selected approval action is not offered by this request.');
    const continuationRequestId = choice.targetRequestId ?? choice.continuationRequestId;
    stage(options, sessionId, approvalRequestId, 'approval', 'Validating approved request');
    observation.close();
    observation = observe(transport, sessionId, options);
    const checked = await observation.approvalSnapshot();
    const current = checked.pendingApprovals.find(item => item.toolCallId === detail.toolCallId);
    if (!current || fingerprint(current.data) !== fingerprint(detail.data)) fail('STALE_APPROVAL', 'The remote approval changed or was already answered. Nothing was sent.');
    for (const plan of plans) {
      const artifact = checked.artifacts.find(item => item.id === plan.documentId && item.update?.editId === plan.editId);
      if (artifact?.update?.transactionId !== plan.transactionId || artifact?.update?.xml !== plan.privatePlan.sourceXml) fail('STALE_APPROVAL', 'The proposed document changes changed while approval was open. Nothing was sent.');
    }
    if (choice.id === 'canvas_accept') {
      if (!plans.length) fail('UNSUPPORTED_RESPONSE', 'No verified native document edit is prepared.');
      stage(options, sessionId, approvalRequestId, 'execution', 'Applying approved document edit');
      for (const plan of plans) {
        const proof = await commitZoomMateDocumentEdit(docs, plan);
        committed.push(proof);
        emit(options, 'document-edit-confirmed', { sessionId, ...proof, markdown: plan.afterMarkdown });
      }
    }
    const requestId = randomUUID(), method = choice.method ?? 'client.toolResult';
    const message = { role: 'user', message_id: randomUUID(), parts: [{ kind: 'data', metadata: { part_type: 'client_tool_result', part_id: randomUUID(), timestamp: Date.now() }, data: { ...current.data, response: choice.response } }] };
    stage(options, sessionId, requestId, 'execution', 'Sending approved response');
    if (options.wait === true) observation.beginContinuation(continuationRequestId ?? detail.requestId ?? detail.messageId);
    const result = await transport.send(method, { request_id: requestId, session_id: sessionId, message,
      request_scenario: EMPTY_SCENARIO, client_info: clientInfo(),
      ...(method === 'client.hitlResolve' ? { hitl_event_id: randomUUID(), ...(choice.targetRequestId ? { target_request_id: choice.targetRequestId } : {}) } : {}) }, { signal: options.signal });
    observation.state.apply({ method: 'client.response_accepted', params: { message,
      request_id: continuationRequestId ?? (typeof result?.request_id === 'string' && result.request_id ? result.request_id : null) } });
    observation.publish();
    let continuation;
    if (options.wait === true && choice.response.request_agent_response) {
      const candidates = [result?.request_id, continuationRequestId].filter(id => typeof id === 'string' && id);
      if (!candidates.length) fail('WRITE_UNCONFIRMED', 'Approval was acknowledged without a usable continuation request ID. No resend attempted.', { outcome: 'unknown', sessionId, requestId });
      stage(options, sessionId, continuationRequestId ?? result?.request_id ?? approvalRequestId, 'reconciliation', 'Reconciling approved continuation');
      const settled = await observation.waitAny(candidates);
      continuation = { outcome: settled.outcome, requestId: settled.requestId, ...(settled.reason ? { reason: settled.reason } : {}) };
    }
    return { outcome: 'acknowledged', sessionId, requestId, result, ...(continuation ? { continuation } : {}), ...(committed.length ? { documentEdits: committed } : {}) };
  } catch (error) {
    if (committed.length) error.details = { ...error.details, documentEdits: committed, approvalOutcome: 'unconfirmed', noReplay: true };
    throw error;
  } finally { docs?.close(); observation.close(); }
}
export async function runZoomMate(session, action, options = {}) {
  if (!ZOOMMATE_ACTIONS.includes(action)) fail('INVALID_INPUT', 'Unknown ZoomMate action.');
  const transport = await session.openZoomMate();
  if (['chats', 'search-chats', 'projects', 'resources', 'credit-history'].includes(action)) return readPage(session, transport, action, options);
  if (['artifacts', 'artifact', 'artifact-save', 'artifact-export', 'snapshot'].includes(action)) return artifactAction(transport, action, options);
  switch (action) {
    case 'status': return { identity: transport.identity, bootstrap: transport.bootstrap };
    case 'capabilities': return { identity: transport.identity, channel: await transport.connect({ signal: options.signal }),
      remoteOnly: true, localTools: false, browserTakeover: false, forcedModes: false, modes: zoomMateModeOptions(transport.bootstrap),
      nativeHost: { available: false, requirement: 'A supported, registered Zoom/Synora desktop host and its verified bridge are required. This client executes cloud tasks only.' },
      approval: 'interactive-supported-controls-only', actions: ZOOMMATE_ACTIONS };
    case 'query': return query(session, transport, options);
    case 'approve': return approve(transport, options);
    case 'rename': {
      const sessionId = required(options.id, 'Session ID'), title = typeof options.title === 'string' ? options.title.trim() : '';
      if (!title || title.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(title)) fail('INVALID_INPUT', 'Supply a session title of 1–200 characters without control characters.');
      let acknowledged = false;
      try {
        await transport.request('/api/v1/session/update', { method: 'PUT', body: { session_id: sessionId, title }, signal: options.signal });
        acknowledged = true;
        const info = await transport.request(`${idPath('/api/v1/session', sessionId)}/info`, { signal: options.signal });
        if (info?.session_id !== undefined && info.session_id !== sessionId || info?.conversation_title !== title) {
          fail('WRITE_UNCONFIRMED', 'Native session readback did not confirm the requested title.');
        }
        return { outcome: 'confirmed', sessionId, title, verification: 'native-readback' };
      } catch (error) {
        throw writeFailure(error, { operation: 'zoommate.rename', sessionId, title }, acknowledged ? 'unknown' : undefined);
      }
    }
    case 'history': case 'watch': {
      const id = required(options.id, 'Session ID'), observation = observe(transport, id, options);
      try {
        const { joined, history } = await observation.join();
        if (action === 'watch') {
          const snapshot = observation.state.snapshot();
          if (snapshot.status === 'blocked') return { outcome: 'blocked', sessionId: id, state: snapshot };
          if (!snapshot.activeRequestId) return { outcome: snapshot.status === 'idle' ? 'idle' : 'unknown', sessionId: id, state: snapshot };
          return await observation.wait(snapshot.activeRequestId);
        }
        const limit = number(options.limit, 50), binding = scope(session, action, options, limit), position = positionFor(options, binding, 'offset');
        const page = options.cursor || options.limit !== undefined
          ? await transport.send('history.load', { session_id: id, limit, offset: position?.native.offset ?? 0 }, { signal: options.signal }) : history;
        return { sessionId: id, joined, state: observation.state.snapshot(), ...pageResult(list(page, 'messages'), page.has_more,
          page.next_offset == null ? null : { offset: page.next_offset }, binding, position, { total: page.total_count }) };
      } finally { observation.close(); }
    }
    case 'cancel': {
      const id = required(options.id, 'Session ID'), requestId = required(options['request-id'], 'Request ID');
      const observation = observe(transport, id, { ...options, 'timeout-ms': options['timeout-ms'] ?? 15000 });
      try {
        await observation.join();
        if (observation.state.snapshot().activeRequestId !== requestId) fail('STALE_REQUEST', 'That request is no longer the active native run. State refreshed; no cancellation sent.');
        observation.beginContinuation(requestId);
        let acknowledgement, acknowledgementError;
        try { acknowledgement = await transport.send('agent.cancel', { session_id: id, request_id: requestId }, { signal: options.signal }); }
        catch (error) { acknowledgementError = error; }
        const settled = await observation.wait(requestId, { terminalOnly: true });
        if (['completed', 'failed'].includes(settled.outcome)) return { ...settled, confirmation: 'remote-terminal', ...(acknowledgement !== undefined ? { acknowledgement } : {}),
          ...(acknowledgementError ? { acknowledgementError: { code: acknowledgementError.code, message: acknowledgementError.message } } : {}) };
        if (acknowledgementError) throw acknowledgementError;
        return { ...settled, outcome: 'acknowledged', confirmation: 'unconfirmed', acknowledgement };
      } finally { observation.close(); }
    }
    case 'project': return transport.request(idPath('/api/v1/projects', options.id), { signal: options.signal });
    case 'project-context': return transport.request(`${idPath('/api/v1/projects', options.id)}/knowledges`, { signal: options.signal });
    case 'files': {
      if (options.all !== undefined && typeof options.all !== 'boolean') fail('INVALID_INPUT', 'All-files selection must be boolean.');
      const path = `${idPath('/api/v2/assets', options.id)}/${options.all ? 'all-files' : 'file-explorer'}`;
      return { items: list(await transport.request(path, { signal: options.signal })), coverage: { complete: true, scope: options.all ? 'conversation-files' : 'root-folder' } };
    }
    case 'file': {
      const sessionId = required(options.id, 'Session ID'), id = required(options['file-id'], 'File ID');
      return readZoomMateArtifact(transport, { key: `file:${id}`, kind: 'file', id, sessionId }, options);
    }
    case 'skills': case 'connectors': {
      const data = await transport.request(action === 'skills' ? '/api/v1/skills' : '/api/v1/connectors/me', { signal: options.signal });
      return { items: list(data, action), hasMore: false, nextCursor: null, coverage: { complete: true } };
    }
    case 'credits': return transport.request('/api/v1/credits/status', { signal: options.signal });
    case 'devices': return { items: list(await transport.request('/api/v1/devices', { signal: options.signal })), nativeExecution: false };
    default: fail('INVALID_INPUT', 'Unsupported ZoomMate action.');
  }
}
