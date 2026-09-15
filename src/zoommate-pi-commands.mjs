import { zoomMateLaunchRecipe } from './zoommate-herdr.mjs';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import { attachmentName, attachmentSources, pickAttachmentSource, pickRemoteAttachment, pickRemoteRecords, pickRemoteSkill, skillName } from './zoommate-pi-presentation.mjs';
import { registerZoomMateArtifactCommands, showZoomMateText } from './zoommate-pi-artifacts.mjs';
import { registerZoomMateCitationCommands } from './zoommate-pi-citations.mjs';
const TYPES = attachmentSources.map(source => source.id);
const clean = value => stripTerminalSequences(String(value ?? '')).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim();
const idOf = record => record?.session_id ?? record?.id ?? record?.skill_id ?? record?.app_id;
const labelOf = (record, index) => clean(record?.conversation_title ?? record?.title ?? record?.display_name ?? record?.name ?? idOf(record) ?? `Item ${index + 1}`);
const conversationLabel = bridge => bridge.sessionId
  ? `${bridge.origin === 'restored' ? 'Restored' : 'Current'}: ${clean(bridge.state.title ?? bridge.sessionId)}`
  : 'Current: New conversation — not started';
const conversationDescription = record => [record.preview ?? record.last_message ?? record.description, record.updated_at ?? record.last_message_at]
  .filter(value => typeof value === 'string' && value).map(clean).join('\n');

async function choosePage(ctx, bridge, action, args, title, filter = () => true, options = {}) {
  const result = await bridge.run(action, args);
  if (!Array.isArray(result?.items)) throw new Error(`${action} did not return a resource list.`);
  const records = result.items.filter(filter);
  if (!records.length && !result.nextCursor && !options.clearLabel) {
    ctx.ui.notify(result.hasMore ? 'No selectable entries on this incomplete page.' : `No ${title.toLowerCase()} available in this scope.`, 'info');
    return undefined;
  }
  const actionResult = await pickRemoteRecords(ctx, records, {
    ...options, title, nextCursor: result.nextCursor, hasMore: result.hasMore,
  });
  if (actionResult === 'next') return choosePage(ctx, bridge, action, { ...args, cursor: result.nextCursor }, title, filter, options);
  return actionResult;
}

function addSelection(bridge, key, value, ctx, name = value) {
  if (!value) throw new Error(`The selected ${key} has no ID.`);
  if (!bridge.selected[key].includes(value)) {
    bridge.selected[key].push(value);
    bridge.contextChanged();
  }
  ctx.ui.notify(`Selected ${key}: ${clean(name)}`, 'info');
}

function toggleSelection(bridge, key, value, ctx, name, record = null) {
  if (!value) throw new Error(`The selected ${key} has no native ID.`);
  const index = bridge.selected[key].indexOf(value);
  if (index < 0) {
    bridge.selected[key].push(value);
    if (key === 'entity' && record) bridge.setContextRecord(value.split(':', 1)[0], record);
  } else bridge.selected[key].splice(index, 1);
  bridge.contextChanged();
  ctx.ui.notify(`${index < 0 ? 'Selected' : 'Removed'} ${key}: ${clean(name)}`, 'info');
  return index < 0;
}

export function registerZoomMateCommands(pi, bridge) {
  const register = (name, description, handler) => pi.registerCommand(name, {
    description,
    getArgumentCompletions: prefix => {
      const values = name === 'project' ? ['clear'] : name === 'attach' ? ['selected', 'clear', ...TYPES] : name === 'session' ? ['verbose'] : [];
      const matches = values.filter(value => value.startsWith(prefix));
      return matches.length ? matches.map(value => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      try { await handler(String(args ?? '').trim(), ctx); }
      catch (error) { ctx.ui.notify(`${error?.code ?? 'ERROR'}: ${error?.message ?? 'ZoomMate command failed.'}`, 'error'); }
    },
  });

  register('chats', 'Pick a remote conversation', async (_args, ctx) => {
    const record = await choosePage(ctx, bridge, 'chats', {}, 'Choose a remote conversation', () => true, {
      noun: 'conversations', caption: conversationLabel(bridge), selected: bridge.sessionId ? [bridge.sessionId] : [],
      note: 'Search filters this loaded page. Escape leaves the current conversation unchanged.',
      description: conversationDescription,
    });
    if (record) await bridge.resume(idOf(record));
  });

  register('resume', 'Resume a remote conversation', async (args, ctx) => {
    const id = args || idOf(await choosePage(ctx, bridge, 'chats', {}, 'Choose a remote conversation', () => true, {
      noun: 'conversations', caption: conversationLabel(bridge), selected: bridge.sessionId ? [bridge.sessionId] : [],
      note: 'Search filters this loaded page. Escape leaves the current conversation unchanged.',
      description: conversationDescription,
    }));
    if (!id) return;
    await bridge.resume(id);
    ctx.ui.notify(bridge.following ? `Resumed ${id}; following remote work and reconciling automatically.`
      : bridge.state.status === 'blocked' ? `Resumed ${id}; input is required. /approve inspects it; /cancel requests a stop.`
      : bridge.state.status === 'unknown' ? `Restored ${id}; the remote outcome is unconfirmed. /session shows observation details.`
      : `Resumed ${id}; remote history restored and no run is active.`, bridge.state.status === 'unknown' ? 'warning' : 'info');
  });

  register('new', 'Start a new remote conversation', async (_args, ctx) => {
    await bridge.newConversation();
    ctx.ui.notify('New conversation staged; the next prompt will start it remotely.', 'info');
  });

  register('name', 'Show or rename the current native conversation', async (args, ctx) => {
    if (!args) {
      ctx.ui.notify(bridge.sessionId ? `Current name: ${clean(bridge.state.title ?? 'not reported')}. Use /name <name> to rename this conversation.`
        : 'No remote conversation yet. Start a conversation before naming it.', 'info');
      return;
    }
    if (!bridge.sessionId) throw new Error('Start a remote conversation before naming it.');
    const result = await bridge.run('rename', { id: bridge.sessionId, title: args });
    ctx.ui.notify(`Conversation named ${clean(result.title)}; native readback confirmed.`, 'info');
  });

  register('project', 'Select or clear a remote project', async (args, ctx) => {
    if (args.toLowerCase() === 'clear') {
      bridge.project = null;
      ctx.ui.notify('Project cleared.', 'info');
      return;
    }
    const record = args ? await bridge.run('project', { id: args }) : await choosePage(ctx, bridge, 'projects', {}, 'Choose a remote project', () => true, {
      noun: 'projects', description: record => clean(record.description ?? record.owner_name ?? record.updated_at ?? ''),
      selected: bridge.project ? [bridge.project.id] : [], clearLabel: 'No project',
    });
    if (record === undefined) return;
    bridge.project = record;
    ctx.ui.notify(record === null ? 'Project cleared.' : `Selected project: ${labelOf(record, 0)}`, 'info');
  });

  register('attach', 'Browse and toggle remote attachments', async (args, ctx) => {
    if (args === 'clear') {
      bridge.selected.entity.splice(0);
      bridge.contextChanged();
      ctx.ui.notify('Attached context cleared; skills and apps remain selected.', 'info');
      return;
    }
    const separator = args.indexOf(':');
    if (separator > 0) {
      if (!TYPES.includes(args.slice(0, separator)) || !args.slice(separator + 1)) throw new Error('Use a supported TYPE:ID from remote resources.');
      addSelection(bridge, 'entity', args, ctx);
      return;
    }
    const source = args === 'selected' ? { id: 'selected', name: 'Attached items' } : args ? attachmentSources.find(item => item.id === args) : await pickAttachmentSource(ctx, bridge.selectedContextRecords);
    if (!source) { if (args) throw new Error('Choose a supported attachment source.'); return; }
    const toggle = record => {
      const type = record?._selectedType ?? source.id;
      return toggleSelection(bridge, 'entity', `${type}:${idOf(record)}`, ctx, attachmentName(record), record);
    };
    if (source.id === 'selected') {
      const action = await pickRemoteAttachment(ctx, source, { items: [] }, bridge.selected.entity, toggle, bridge.selectedContextRecords, {
        clearLabel: 'Clear all attached context',
      });
      if (action === null) {
        bridge.selected.entity.splice(0);
        bridge.contextChanged();
        ctx.ui.notify('Attached context cleared; skills and apps remain selected.', 'info');
      }
      return;
    }
    let cursor;
    do {
      const page = await bridge.run('resources', { type: source.id, ...(cursor ? { cursor } : {}) });
      const action = await pickRemoteAttachment(ctx, source, page, bridge.selected.entity, toggle, bridge.selectedContextRecords);
      if (action !== 'next') return;
      cursor = page.nextCursor;
    } while (cursor);
  });


  register('skills', 'Browse and toggle remote skills', async (args, ctx) => {
    const inventory = await bridge.run('skills');
    if (!Array.isArray(inventory?.items)) throw new Error('The provider did not return a skill inventory.');
    const toggle = record => toggleSelection(bridge, 'skill', idOf(record), ctx, skillName(record));
    if (!args) { await pickRemoteSkill(ctx, inventory.items, bridge.selected.skill, toggle); return; }
    const record = inventory.items.find(item => item.id === args || item.skill_id === args);
    if (!record) throw new Error('That skill is not in the current native inventory.');
    if (record.enabled === false || record.authorized === false) throw new Error('That skill is not enabled and authorized.');
    toggle(record);
  });

  register('connectors', 'Browse and toggle connected authorized apps', async (args, ctx) => {
    const connected = record => record.enabled !== false && record.authorized !== false
      && ['connected', 'connect'].includes(record.connection_status);
    let record;
    if (args) {
      const inventory = await bridge.run('connectors');
      if (!Array.isArray(inventory?.items)) throw new Error('The provider did not return a connector inventory.');
      record = inventory.items.find(item => item.id === args && connected(item));
      if (!record) throw new Error('That app is not connected and authorized in the current native inventory.');
    } else record = await choosePage(ctx, bridge, 'connectors', {}, 'Choose a connected authorized app', connected, {
      noun: 'apps', description: record => clean(record.description ?? record.connection_status ?? record.email ?? ''),
      selected: bridge.selected.connector, onToggle: item => toggleSelection(bridge, 'connector', idOf(item), ctx, labelOf(item, 0)),
    });
    if (record) toggleSelection(bridge, 'connector', idOf(record), ctx, labelOf(record, 0));
  });

  register('clear', 'Clear explicit remote selections', async (_args, ctx) => {
    for (const key of Object.keys(bridge.selected)) bridge.selected[key].splice(0);
    bridge.contextChanged();
    ctx.ui.notify('Explicit context, skill and app selections cleared.', 'info');
  });

  register('files', 'Show remote conversation files', async (_args, ctx) => {
    if (!bridge.sessionId) throw new Error('Select a conversation first.');
    const file = await choosePage(ctx, bridge, 'files', { id: bridge.sessionId }, 'Conversation files (root)', () => true, {
      noun: 'files', description: record => clean(record.description ?? (record.is_directory ? 'Folder' : 'File')),
      note: 'Browse native file metadata. /artifacts opens generated artifacts.',
    });
    if (file) await showZoomMateText(ctx, labelOf(file, 0), `\`\`\`json\n${JSON.stringify(file, null, 2)}\n\`\`\``);
  });

  register('credits', 'Show the shared credit balance and progress', async (_args, ctx) => {
    const result = await bridge.run('credits'), credit = result?.credit_status;
    pi.sendMessage({
      customType: 'zoommate.credits', display: true, details: { credit, observedAt: bridge.creditObservations?.at(-1)?.observedAt, observations: bridge.creditObservations },
      content: credit ? `Shared credits: ${clean(credit.remaining_credit)} remaining; ${clean(credit.used_credit)} used; ${clean(credit.budget_cap)} budget. Billing may lag.` : 'Shared credit balance unavailable.',
    }, { triggerTurn: false });
  });


  register('cancel', 'Cancel the active remote request', async (_args, ctx) => {
    if (!bridge.sessionId || !bridge.state?.activeRequestId) throw new Error('No known active remote request. Resume first if the outcome is unknown.');
    const target = { id: bridge.sessionId, 'request-id': bridge.state.activeRequestId };
    const ok = await ctx.ui.confirm('Stop remote work', `Send one stop request for ${target['request-id']} in conversation ${target.id}? Completed tool side effects will not be undone. Escape closes this dialog without sending a stop request.`);
    if (!ok) return;
    if (bridge.sessionId !== target.id || bridge.state.activeRequestId !== target['request-id']) throw new Error('The active request changed while confirmation was open. No stop request sent.');
    const result = await bridge.run('cancel', target);
    const title = result.confirmation !== 'remote-terminal' ? 'Stop acknowledged, not confirmed; observing automatically'
      : result.result?.async_status === 'cancelled' ? 'Remote stop confirmed'
      : 'Remote turn ended; cancellation may have raced completion';
    const details = {
      sessionId: result.sessionId, requestId: result.requestId, outcome: result.outcome,
      nativeStatus: result.result?.async_status ?? result.state?.asyncStatus, confirmation: result.confirmation,
      reason: result.reason, sideEffects: 'Completed tool side effects are not undone.',
    };
    pi.sendMessage({ customType: 'zoommate.result', display: true,
      content: `## ${title}\n\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\`` }, { triggerTurn: false });
  });


  register('session', 'Show compact session status; verbose adds diagnostics', async (args, ctx) => {
    if (args && args !== 'verbose') throw new Error('Use /session or /session verbose.');
    const user = bridge.identity?.user ?? {}, state = bridge.state;
    if (args === 'verbose') {
      const diagnostics = {
        sessionId: bridge.sessionId, origin: bridge.origin, status: state.status, activeRequestId: state.activeRequestId,
        actor: user.displayName ?? user.userId, accountId: user.accountId,
        launch: bridge.launch, resumeRecipe: bridge.sessionId ? { generated: true, purpose: 'Future resume command, not the actual launch; credential path redacted',
          ...zoomMateLaunchRecipe({ cookies: '[REDACTED_COOKIE_FILE]', profile: bridge.launch.profile, configDir: bridge.launch.configDir, resume: bridge.sessionId, project: bridge.project?.id }) } : null,
        following: bridge.following, observationError: bridge.followError, operation: bridge.operationStage,
        project: bridge.project, selected: bridge.selected, mode: bridge.mode, modeOptions: bridge.modeOptions,
        pendingApprovals: state.pendingApprovals, unsupportedItems: state.unsupportedItems,
        creditObservations: bridge.creditObservations,
      };
      await showZoomMateText(ctx, 'Session diagnostics', `\`\`\`json\n${JSON.stringify(diagnostics, null, 2)}\n\`\`\``);
      return;
    }
    const counts = Object.entries(bridge.selected).filter(([, values]) => values.length).map(([kind, values]) => `${values.length} ${kind}`).join(', ');
    const lines = [
      `**${conversationLabel(bridge)}**`, `Profile: ${clean(bridge.launch.profile ?? 'default')}`, `Status: ${bridge.stopping ? 'stopping' : state.status}`,
      `Actor: ${clean(user.displayName ?? user.userId)}`, `Mode: ${bridge.mode}`,
      `Project: ${clean(bridge.project?.name ?? 'none')}`, `Selected context: ${counts || 'none'}`,
      `Approvals: ${state.pendingApprovals?.length || 'none'} · Unsupported items: ${state.unsupportedItems?.length || 'none'}`,
      'Execution: cloud · native host unavailable', 'More detail: /session verbose',
    ];
    pi.sendMessage({ customType: 'zoommate.result', content: lines.join('  \n'), display: true }, { triggerTurn: false });
  });
  registerZoomMateArtifactCommands(pi, bridge);
  registerZoomMateCitationCommands(pi, bridge);

}
