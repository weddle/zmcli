import { AppError, connectSession } from './session.mjs';
import { runZoomMate } from './zoommate.mjs';
import { zoomMateModeOptions, resolveZoomMateMode } from './zoommate-execution.mjs';
import { readZoomMateArtifact, readZoomMateSnapshot } from './zoommate-artifact-api.mjs';

const emptyState = () => ({ sessionId: null, status: 'idle', messages: [], pendingApprovals: [], unsupportedItems: [], artifacts: [], citations: [],
  execution: { sandbox: null, plan: [], tools: [], snapshots: [] } });
const sameArtifact = (a, b) => a && b && a.partId === b.partId && a.status === b.status && a.xml === b.xml && a.title === b.title && a.update?.action === b.update?.action;
const STAGES = new Set(['review', 'approval', 'execution', 'reconciliation', 'completed']);

export async function createZoomMateBridge({ cookies, resume, project, profile, configDir, cdp } = {}, { connect = connectSession } = {}) {
  const session = await connect({ cookies, service: 'zoommate' });
  let transport;
  try { transport = await session.openZoomMate(); }
  catch (error) { await session.close(); throw error; }
  const listeners = new Set();
  const selected = { entity: [], skill: [], connector: [], artifact: [] }, contextRecords = new Map(), artifactReads = new Map();
  const contextKey = (type, record) => `${type}:${record?.id ?? record?.session_id ?? record?.skill_id ?? record?.app_id ?? ''}`;
  const pruneContextRecords = () => {
    for (const key of contextRecords.keys()) if (!selected.entity.includes(key)) contextRecords.delete(key);
  };
  let mode = 'auto', modeEditedByUser = false;
  let sessionId = null, currentProject = null, busy = false, closed = false;
  let followController = null, followToken = 0, reconciliation = null, followError = null, cancelling = false;
  let credits = null, creditObservations = [], operationStage = null, creditSequence = 0;
  const launch = Object.freeze({ profile: typeof profile === 'string' && profile ? profile : null,
    configDir: typeof configDir === 'string' && configDir ? configDir : null,
    cdp: typeof cdp === 'string' && cdp ? cdp : null,
    resume: typeof resume === 'string' && resume ? resume : null,
    project: typeof project === 'string' && project ? project : null });
  let origin = launch.resume ? 'restored' : 'new';
  let awaitingApproval = false;
  let state = emptyState();
  const stopFollowing = () => { followToken++; followController?.abort(); followController = null; };
  const follow = id => {
    stopFollowing();
    if (closed || !id || !['working', 'unknown'].includes(state.status)) return;
    const token = followToken, controller = new AbortController();
    followController = controller;
    followError = null; notify('state');
    void runZoomMate(session, 'watch', {
      id, signal: controller.signal, 'timeout-ms': 3600000,
      onEvent: event => {
        if (token !== followToken || closed || sessionId !== id) return;
        ingest(event);
      },
    }).then(result => {
      if (token !== followToken || closed || sessionId !== id) return;
      if (result?.state) state = result.state;
      followController = null; reconciliation = result;
      notify(result?.outcome === 'unknown' ? 'state' : 'reconcile');
    }).catch(error => {
      if (token !== followToken || closed || sessionId !== id) return;
      followError = { code: error.code ?? 'OBSERVATION_FAILED', message: error.message };
      state = { ...state, status: 'unknown' }; followController = null; notify('state');
    });
  };
  const notify = kind => { for (const listener of listeners) listener(state, kind); };
  const recordCredits = (phase, target, creditStatus, error, observedAt = Date.now(), correlationId = null) => {
    if (!target.cached) credits = creditStatus;
    creditObservations = [...creditObservations.slice(-31), { phase, recordedAt: Date.now(), observedAt, ...target,
      ...(correlationId ? { correlationId } : {}), creditStatus, ...(error ? { error } : {}) }];
    notify('credits');
    return creditStatus;
  };
  const recordCachedCredits = (phase, requestId = state.activeRequestId, correlationId = null) => {
    const previous = correlationId ? creditObservations.findLast(item => item.correlationId === correlationId) : creditObservations.at(-1);
    return recordCredits(phase, { sessionId, requestId, cached: true },
      previous?.creditStatus ?? null, previous?.error, previous?.observedAt ?? null, correlationId);
  };
  const observeCredits = async (phase, requestId = null, signal, correlationId = null) => {
    const target = { sessionId, requestId };
    try {
      const result = await runZoomMate(session, 'credits', { signal: AbortSignal.any([AbortSignal.timeout(2000), ...(signal ? [signal] : [])]) });
      return recordCredits(phase, target, result?.credit_status ?? null, null, Date.now(), correlationId);
    } catch (cause) {
      recordCredits(phase, target, null, { code: cause?.code ?? 'CREDITS_UNAVAILABLE', message: cause?.message ?? 'Credit snapshot unavailable.' }, Date.now(), correlationId);
      if (['startup', 'before-request'].includes(phase) && ['AUTH_REQUIRED', 'REAUTHENTICATION_REQUIRED', 'TENANT_MISMATCH', 'PROVIDER_APPROVAL_REQUIRED'].includes(cause?.code)) throw cause;
      return null;
    }
  };
  const idle = () => {
    if (closed) throw new AppError('SESSION_CLOSED', 'ZoomMate is closed.');
    if (busy) throw new AppError('OPERATION_ACTIVE', 'Wait for the current operation, cancel explicitly, or detach.');
  };
  const ingest = event => {
    if (event?.sessionId && sessionId && event.sessionId !== sessionId) return;
    if (event?.state) {
      const nextId = event.state.sessionId;
      if (nextId && sessionId && nextId !== sessionId) return;
      state = { ...event.state, ...(state.title && nextId === sessionId && event.state.title === undefined ? { title: state.title } : {}) };
      if (nextId) sessionId = nextId;
    }
    if (event?.type === 'accepted') {
      const nextId = event.sessionId;
      if (nextId && sessionId && nextId !== sessionId) return;
      if (nextId) sessionId = nextId;
    }
    if (event?.type === 'document-edit-confirmed') {
      const artifact = state.artifacts.find(item => item.kind === 'document' && item.id === event.documentId && item.update?.transactionId === event.transactionId);
      if (artifact) artifactReads.set(artifact.key, { source: artifact, result: { ...artifact, markdown: event.markdown,
        needsRead: false, native: { version: event.version }, writeConfirmation: { transactionId: event.transactionId, version: event.version, verification: event.verification } } });
    }
    if (event?.type === 'operation-stage' && STAGES.has(event.stage)) {
      operationStage = { stage: event.stage, label: typeof event.label === 'string' ? event.label : event.stage,
        startedAt: Number.isFinite(event.startedAt) ? event.startedAt : Date.now(), sessionId: event.sessionId ?? sessionId, requestId: event.requestId ?? state.activeRequestId ?? null };
    }
    notify('state');
  };
  const unsubscribe = transport.subscribe(event => {
    if (event.method === 'transport.disconnected') {
      state = { ...state, status: 'unknown' }; notify('state');
    }
  });
  const bridge = {
    cookieFile: cookies,
    launch,
    get origin() { return origin; },
    get identity() { return session.identity; },
    get sessionId() { return sessionId; },
    get state() { return state; },
    get busy() { return busy; },
    get stopping() { return cancelling; },
    get closed() { return closed; },
    get credits() { return credits; },
    get creditObservations() { return creditObservations; },
    get operationStage() { return operationStage; },
    get awaitingApproval() { return awaitingApproval; },
    get reconciliation() { return reconciliation; },
    get following() { return followController !== null; },
    get followError() { return followError; },
    get project() { return currentProject; },
    get modeOptions() { return zoomMateModeOptions(transport.bootstrap); },
    get mode() { return bridge.modeOptions.manualSelection ? mode : 'auto'; },
    set mode(value) { idle(); resolveZoomMateMode(value, transport.bootstrap); mode = value; modeEditedByUser = true; notify('context'); },
    get selectedContextRecords() {
      pruneContextRecords();
      return selected.entity.map(key => {
        const saved = contextRecords.get(key);
        const separator = key.indexOf(':');
        return { key, type: saved?.type ?? (separator > 0 ? key.slice(0, separator) : key), record: saved?.record ?? null };
      });
    },
    setContextRecord(type, record) {
      if (typeof type !== 'string' || !type || !record || typeof record !== 'object') return;
      const key = contextKey(type, record);
      if (selected.entity.includes(key) && !key.endsWith(':')) contextRecords.set(key, { type, record });
    },
    contextChanged() { pruneContextRecords(); notify('context'); },
    getArtifact(key) {
      const artifact = state.artifacts.find(item => item.key === key), cached = artifactReads.get(key);
      return sameArtifact(artifact, cached?.source) && cached.result ? cached.result : artifact;
    },
    ensureArtifact(key) {
      const artifact = state.artifacts.find(item => item.key === key), cached = artifactReads.get(key);
      if (!artifact || !artifact.needsRead) return Promise.resolve(artifact);
      if (sameArtifact(artifact, cached?.source)) return cached.promise ?? Promise.resolve(cached.result);
      const entry = { source: artifact }, requestSessionId = sessionId;
      artifactReads.set(key, entry);
      entry.promise = bridge.run('artifact', { artifact: key }).catch(error => {
        if (sessionId === requestSessionId && sameArtifact(state.artifacts.find(item => item.key === key), artifact)) {
          entry.result = { ...artifact, needsRead: false, readError: `${error.code ?? 'ERROR'}: ${error.message}` };
          artifactReads.set(key, entry); notify('artifact');
        }
        return entry.result;
      });
      return entry.promise;
    },
    set project(value) {
      idle();
      if (value !== null && (!value || typeof value.id !== 'string' || !value.id)) throw new AppError('UNSUPPORTED_RESPONSE', 'The project did not supply a native ID.');
      currentProject = value; notify('context');
    },
    selected,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async run(action, options = {}) {
      if (closed) throw new AppError('SESSION_CLOSED', 'ZoomMate is closed.');
      if (action === 'rename') {
        idle(); stopFollowing(); busy = true; notify('operation');
        try {
          const result = await runZoomMate(session, action, { id: sessionId, ...options });
          if (!closed && result.sessionId === sessionId) { state = { ...state, title: result.title }; notify('title'); }
          return result;
        } finally { busy = false; notify('operation'); follow(sessionId); }
      }
      if (['artifacts', 'artifact', 'artifact-save', 'artifact-export', 'snapshot'].includes(action)) options = { id: sessionId, ...options };
      if (action === 'snapshot' && options.id === sessionId) {
        const matches = (state.execution?.snapshots ?? []).filter(item => item.partId === options.snapshot
          && (options['message-id'] === undefined || item.messageId === options['message-id']));
        if (matches.length !== 1) throw new AppError('TARGET_NOT_FOUND', 'Select one unambiguous native screenshot from this conversation.');
        return readZoomMateSnapshot(transport, matches[0], options);
      }
      const approving = action === 'approve';
      const cancellingNow = action === 'cancel';
      if (cancellingNow) {
        if (cancelling) throw new AppError('OPERATION_ACTIVE', 'A remote stop request is already awaiting confirmation; it will not be resent.');
        cancelling = true; notify('operation');
      }
      if (approving) {
        idle();
        if (typeof options.confirmApproval !== 'function') throw new AppError('PROVIDER_APPROVAL_REQUIRED', 'Interactive approval is required.');
        busy = true; notify('operation');
      }
      let result;
      const artifactSource = action === 'artifact' && options.id === sessionId ? state.artifacts.find(item => item.key === options.artifact) : null;
      const creditCorrelationId = approving ? `request-${++creditSequence}` : null;
      const creditTarget = action === 'credits' ? { sessionId, requestId: state.activeRequestId, correlationId: `manual-${++creditSequence}` } : null;
      try {
        if (approving) await observeCredits('before-request', state.activeRequestId, options.signal, creditCorrelationId);
        result = artifactSource ? await readZoomMateArtifact(transport, artifactSource, options) : await runZoomMate(session, action, approving ? {
          ...options, wait: true, onEvent: event => { ingest(event); options.onEvent?.(event); },
          confirmApproval: async detail => {
            awaitingApproval = true; notify('operation');
            try { return await options.confirmApproval(detail); }
            finally { awaitingApproval = false; notify('operation'); }
          },
        } : cancellingNow ? { ...options, onEvent: event => {
          if (sessionId === options.id && !closed) ingest(event);
          options.onEvent?.(event);
        } } : options);
        if (approving && !closed) {
          if (['completed', 'blocked'].includes(result?.continuation?.outcome)) await observeCredits('after-request', result.continuation.requestId, options.signal, creditCorrelationId);
          else recordCachedCredits('after-request', result?.continuation?.requestId, creditCorrelationId);
        }
      } catch (error) {
        if (approving && !closed) recordCachedCredits('after-request', result?.continuation?.requestId, creditCorrelationId);
        if (creditTarget) recordCredits('manual', creditTarget, null, { code: error.code ?? 'CREDITS_UNAVAILABLE', message: error.message });
        throw error;
      } finally {
        if (approving) { busy = false; operationStage = null; notify('operation'); }
        if (cancellingNow) { cancelling = false; notify('operation'); follow(sessionId); }
      }
      if (creditTarget) recordCredits('manual', creditTarget, result.credit_status ?? null);
      if (action === 'artifact' && options.id === sessionId) {
        const source = state.artifacts.find(item => item.key === result.key);
        if (sameArtifact(source, artifactSource)) { artifactReads.set(result.key, { source, result }); notify('artifact'); }
      }
      if (approving && sessionId && !busy && !closed) {
        await bridge.resume(sessionId, { keepContext: true });
      }
      return result;
    },
    async resume(id, { keepContext = false } = {}) {
      idle(); stopFollowing(); busy = true; reconciliation = null; followError = null; operationStage = null;
      try {
        notify('operation');
        const result = await runZoomMate(session, 'history', { id });
        if (!result?.state) throw new AppError('UNSUPPORTED_RESPONSE', 'History did not return authoritative state.');
        sessionId = id; state = result.state; artifactReads.clear();
        if (!keepContext) origin = 'restored';
        if (!modeEditedByUser && bridge.modeOptions.manualSelection) {
          const restoredMode = state.messages.findLast(message => message.role === 'user' && ['auto', 'advanced'].includes(message.mode))?.mode;
          mode = restoredMode ?? 'auto';
        }
        if (!keepContext) { currentProject = null; for (const key of Object.keys(selected)) selected[key].splice(0); contextRecords.clear(); }
        notify(keepContext ? 'reconcile' : 'hydrate');
        if (!keepContext) bridge.contextChanged();
        return result;
      } finally { busy = false; notify('operation'); follow(sessionId); }
    },
    async newConversation() {
      idle(); stopFollowing(); sessionId = null; origin = 'new'; reconciliation = null; followError = null; operationStage = null;
      artifactReads.clear();
      for (const key of Object.keys(selected)) selected[key].splice(0);
      contextRecords.clear();
      currentProject = null;
      state = emptyState();
      notify('hydrate');
      bridge.contextChanged();
    },
    async query(text, { signal, onEvent } = {}) {
      idle(); stopFollowing(); busy = true; reconciliation = null; followError = null; operationStage = null;
      const creditCorrelationId = `request-${++creditSequence}`;
      try {
        notify('operation');
        await observeCredits('before-request', null, signal, creditCorrelationId);
        if (closed || signal?.aborted) throw new AppError('REQUEST_CANCELLED', 'Interrupted before remote dispatch.');
        const result = await runZoomMate(session, 'query', {
          ...(sessionId ? { id: sessionId } : { new: true }), prompt: text,
          ...(currentProject ? { project: currentProject.id } : {}),
          entity: [...selected.entity], skill: [...selected.skill], connector: [...selected.connector], artifact: [...selected.artifact], mode: bridge.mode,
          signal, onEvent: event => {
            ingest(event);
            if (event.type === 'accepted') { selected.artifact.splice(0); bridge.contextChanged(); }
            onEvent?.(event);
          },
        });
        if (!closed) {
          if (['completed', 'blocked'].includes(result?.outcome)) await observeCredits('after-request', result.requestId, signal, creditCorrelationId);
          else recordCachedCredits('after-request', result?.requestId, creditCorrelationId);
        }
        return result;
      } catch (error) {
        if (error.details?.sessionId) sessionId = error.details.sessionId;
        if (error.details?.outcome === 'unknown') {
          state = { ...state, sessionId, status: 'unknown', activeRequestId: error.details.requestId ?? state.activeRequestId };
          notify('state');
        }
        if (!closed) recordCachedCredits('after-request', error.details?.requestId, creditCorrelationId);
        throw error;
      } finally { busy = false; operationStage = null; notify('operation'); follow(sessionId); }
    },
    async close() {
      if (closed) return;
      closed = true; stopFollowing();
      try { recordCachedCredits('exit'); }
      finally { unsubscribe(); listeners.clear(); await session.close(); }
    },
  };
  try {
    await observeCredits('startup');
    if (resume) await bridge.resume(resume);
    if (project) bridge.project = await runZoomMate(session, 'project', { id: project });
    return bridge;
  } catch (error) { await bridge.close(); throw error; }
}
