import { resolve } from 'node:path';
import { Container, Image, Markdown, Text, matchesKey, stripTerminalSequences } from '@earendil-works/pi-tui';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { pickRemoteRecords } from './zoommate-pi-presentation.mjs';

const clean = value => stripTerminalSequences(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
const label = value => clean(value).replace(/\s+/gu, ' ').trim();
const title = artifact => label(artifact.title ?? artifact.id ?? 'Untitled artifact');
const isDocument = artifact => artifact.kind === 'document';
export const isZoomMateMarkdownArtifact = artifact => isDocument(artifact) || /\.(?:md|markdown)$/iu.test(artifact.file?.name ?? artifact.title ?? '');
const pending = artifact => artifact.status === 'pending' || artifact.status === 'streaming' && artifact.update;

export function renderZoomMateArtifact(message, options = {}, theme) {
  const artifact = message.details ?? {}, component = new Container();
  const badge = isDocument(artifact) ? 'DOCUMENT' : isZoomMateMarkdownArtifact(artifact) ? 'MARKDOWN' : 'FILE';
  const state = artifact.writeConfirmation ? `Saved v${artifact.writeConfirmation.version}` : pending(artifact) ? 'Edit pending' : artifact.native?.version !== undefined ? `Saved v${artifact.native.version}` : label(artifact.status ?? 'unknown');
  component.addChild(new Text(`${theme.bold(theme.fg('accent', `[${badge}] ${title(artifact)}`))}  ${theme.fg(pending(artifact) && !artifact.writeConfirmation ? 'warning' : 'dim', state)}`, 0, 0));
  if (!options.expanded) {
    component.addChild(new Text(theme.fg('dim', isZoomMateMarkdownArtifact(artifact)
      ? 'Ctrl+O expand · /artifacts preview, reference, save, Zoom Docs'
      : 'Ctrl+O details · /artifacts reference'), 0, 0));
    return component;
  }
  if (!isZoomMateMarkdownArtifact(artifact)) component.addChild(new Text(theme.fg('dim', 'Non-Markdown file. Use /snapshot for cloud-browser images.'), 0, 0));
  else if (artifact.needsRead) component.addChild(new Text(theme.fg('dim', 'Reading current saved content…'), 0, 0));
  else if (artifact.markdown) component.addChild(new Markdown(clean(artifact.markdown), 0, 0, getMarkdownTheme()));
  else component.addChild(new Text(theme.fg('dim', artifact.readError ? `${label(artifact.readError)} · /artifacts → Preview retries.` : artifact.status === 'streaming' ? 'Document content is streaming.' : 'Empty text content.'), 0, 0));
  if (artifact.writeConfirmation) component.addChild(new Text(theme.fg('dim', 'Approved edit saved and read back.'), 0, 0));
  else if (pending(artifact)) {
    component.addChild(new Text(theme.fg('warning', 'Proposed edit — not yet committed. Use /approve to review.'), 0, 0));
    if (artifact.update?.markdown) component.addChild(new Markdown(clean(artifact.update.markdown), 0, 0, getMarkdownTheme()));
  }
  if (artifact.unsupported?.length) component.addChild(new Text(theme.fg('warning', 'Preview has unsupported formatting or blocks; native content is preserved.'), 0, 0));
  component.addChild(new Text(theme.fg('dim', `Native ID: ${label(artifact.id)}`), 0, 0));
  return component;
}

async function preview(ctx, heading, makeBody) {
  await ctx.ui.custom((tui, theme, keybindings, done) => {
    const body = makeBody(theme, tui), header = new Text(theme.bold(theme.fg('accent', label(heading))), 0, 0);
    let offset = 0, height = 10;
    return {
      invalidate() { body.invalidate?.(); },
      render(width) {
        const lines = body.render(width); height = Math.max(3, tui.terminal.rows - 5);
        offset = Math.min(offset, Math.max(0, lines.length - height));
        return [...header.render(width), ...lines.slice(offset, offset + height), theme.fg('dim', '↑/↓ or PgUp/PgDn scroll · Esc closes')];
      },
      handleInput(data) {
        if (keybindings.matches(data, 'tui.select.cancel') || matchesKey(data, 'ctrl+c')) { done(); return; }
        if (matchesKey(data, 'pageDown')) offset += height;
        else if (matchesKey(data, 'pageUp')) offset = Math.max(0, offset - height);
        else if (matchesKey(data, 'down')) offset++;
        else if (matchesKey(data, 'up')) offset = Math.max(0, offset - 1);
        tui.requestRender();
      },
    };
  });
}

export const showZoomMateText = (ctx, heading, content) => preview(ctx, heading, () => new Markdown(clean(content), 0, 0, getMarkdownTheme()));

export async function markdownDestination(ctx, artifact) {
  const input = await ctx.ui.input(`Save Markdown destination for ${title(artifact)}`);
  if (!input?.trim()) return null;
  const out = resolve(ctx.cwd ?? process.cwd(), input.trim());
  if (!await ctx.ui.confirm('Confirm Markdown save', `Save ${title(artifact)} to ${out} as a new private file (mode 0600)? Existing files and symlinks will not be replaced.`)) return null;
  return { out };
}

function requireConversation(bridge, sessionId) {
  if (bridge.sessionId !== sessionId) throw new Error('The conversation changed. Reopen the inspector for the current conversation.');
}

async function previewArtifact(ctx, bridge, artifact, sessionId) {
  requireConversation(bridge, sessionId);
  const detail = await bridge.run('artifact', { id: sessionId, artifact: artifact.key });
  requireConversation(bridge, sessionId);
  if (typeof detail.markdown !== 'string') throw new Error('This artifact has no supported Markdown preview.');
  await preview(ctx, title(detail), () => new Markdown(clean(detail.markdown)
    + (pending(detail) ? `\n\n## Proposed edit (pending)\n\n${clean(detail.update?.markdown ?? '')}` : ''), 0, 0, getMarkdownTheme()));
}

async function previewSnapshot(ctx, bridge, snapshot, sessionId) {
  requireConversation(bridge, sessionId);
  const image = await bridge.run('snapshot', { id: sessionId, snapshot: snapshot.partId, 'message-id': snapshot.messageId });
  requireConversation(bridge, sessionId);
  await preview(ctx, `${image.title ?? 'Cloud computer'} · captured screenshot, not live`, (theme, tui) => {
    const limits = { maxWidthCells: 72 };
    const component = new Image(image.base64, image.mimeType, { fallbackColor: text => theme.fg('muted', text) },
      limits, { widthPx: image.width, heightPx: image.height });
    return {
      invalidate() { component.invalidate(); },
      render(width) {
        const height = Math.max(1, tui.terminal.rows - 5);
        if (limits.maxHeightCells !== height) { limits.maxHeightCells = height; component.invalidate(); }
        return component.render(width);
      },
    };
  });
}

async function inspectComputer(ctx, bridge) {
  const sessionId = bridge.sessionId;
  if (!sessionId) { ctx.ui.notify('Start or resume a conversation to inspect its cloud computer.', 'info'); return; }
  while (bridge.sessionId === sessionId) {
    let files = [], fileError;
    try {
      const result = await bridge.run('files', { id: sessionId, all: true });
      if (!Array.isArray(result.items)) throw new Error('The provider omitted the native file inventory.');
      files = result.items;
    } catch (error) { fileError = label(error.message); }
    requireConversation(bridge, sessionId);
    const rows = [], knownFiles = new Set();
    for (const [index, snapshot] of (bridge.state.execution?.snapshots ?? []).entries()) rows.push({
      kind: 'snapshot', key: `snapshot:${snapshot.messageId}:${snapshot.partId ?? index}`, snapshot,
      name: `[SNAPSHOT] ${label(snapshot.title ?? snapshot.toolId ?? `Capture ${index + 1}`)}`,
      description: `Captured screenshot, not a live connection.\n${label(snapshot.pageUrl ?? '')}\nRequest: ${label(snapshot.requestId ?? 'not reported')}`,
    });
    for (const artifact of bridge.state.artifacts ?? []) {
      if (!isDocument(artifact)) knownFiles.add(artifact.id);
      rows.push({ kind: 'artifact', key: artifact.key, artifact,
        name: `[${isDocument(artifact) ? 'DOC' : 'FILE'}] ${title(artifact)}`,
        description: `${isDocument(artifact) ? 'Native Zoom document' : 'Native generated file'} · ${label(artifact.status ?? 'status unreported')}` });
    }
    for (const file of files) if (typeof file.id === 'string' && !knownFiles.has(file.id)) rows.push({
      kind: 'file', key: `file:${file.id}`, file,
      name: `[${file.is_directory ? 'FOLDER' : 'FILE'}] ${label(file.name ?? file.id)}`,
      description: [file.path, Number.isFinite(file.size) ? `${file.size} bytes` : null, 'Native cloud file or attachment'].filter(Boolean).map(label).join('\n'),
    });
    if (!rows.length) {
      ctx.ui.notify(fileError ? `Native file inventory unavailable: ${fileError}. No captured snapshots or artifacts are known.`
        : 'No captured snapshots, files, or artifacts are available in this conversation yet.', fileError ? 'warning' : 'info');
      return;
    }
    const chosen = await pickRemoteRecords(ctx, rows, {
      title: 'Cloud computer', noun: 'snapshots, files and artifacts', key: item => item.key,
      name: item => item.name, description: item => item.description, caption: `Conversation: ${sessionId}`,
      note: fileError ? `File inventory unavailable: ${fileError}. Showing known snapshots and artifacts.`
        : 'Read-only inspection. Select a capture to view it; files offer native text previews or metadata. Escape closes.',
    });
    if (!chosen) return;
    requireConversation(bridge, sessionId);
    if (chosen.kind === 'snapshot') { await previewSnapshot(ctx, bridge, chosen.snapshot, sessionId); continue; }
    const record = chosen.artifact ?? chosen.file;
    const action = await ctx.ui.select(chosen.name, [...(!record.is_directory ? ['Preview'] : []), 'Native details']);
    if (!action) continue;
    requireConversation(bridge, sessionId);
    if (action === 'Native details') {
      await showZoomMateText(ctx, chosen.name, `\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``);
      continue;
    }
    try {
      if (chosen.artifact && isDocument(chosen.artifact)) await previewArtifact(ctx, bridge, chosen.artifact, sessionId);
      else {
        const detail = await bridge.run('file', { id: sessionId, 'file-id': record.id });
        requireConversation(bridge, sessionId);
        await preview(ctx, chosen.name, () => isZoomMateMarkdownArtifact(chosen.artifact ?? { title: record.name })
          ? new Markdown(clean(detail.markdown), 0, 0, getMarkdownTheme()) : new Text(clean(detail.markdown), 0, 0));
      }
    } catch (error) { ctx.ui.notify(`Preview unavailable: ${label(error.message)}. Native details remain available.`, 'warning'); }
  }
}

export function registerZoomMateArtifactCommands(pi, bridge) {
  const register = (name, description, handler) => pi.registerCommand(name, { description, handler: async (args, ctx) => {
    try { await handler(String(args ?? '').trim(), ctx); }
    catch (error) { ctx.ui.notify(`${label(error.code ?? 'ERROR')}: ${label(error.message)}`, 'error'); }
  } });
  register('artifacts', 'Preview, reference, save and open native artifacts', async (_args, ctx) => {
    const artifacts = bridge.state.artifacts ?? [];
    if (!artifacts.length) { ctx.ui.notify('No native artifacts in this conversation.', 'info'); return; }
    const artifact = await pickRemoteRecords(ctx, artifacts, {
      title: 'Native artifacts', noun: 'artifacts', key: item => item.key, selected: bridge.selected.artifact,
      name: item => `[${isDocument(item) ? 'DOC' : isZoomMateMarkdownArtifact(item) ? 'MARKDOWN' : 'FILE'}] ${title(item)}`,
      description: item => `${isDocument(item) ? 'Native Zoom document; Open in Zoom Docs uses its existing identity.' : isZoomMateMarkdownArtifact(item) ? 'Native Markdown file; Export to Zoom Docs converts this file.' : 'Native file.'} ${label(item.status ?? '')}`,
      note: 'Native files and Zoom documents keep their own identities.',
    });
    if (!artifact) return;
    const markdown = isZoomMateMarkdownArtifact(artifact);
    const actions = [...(markdown ? ['Preview'] : []), 'Toggle next-prompt reference', ...(markdown ? ['Save Markdown'] : []),
      ...(isDocument(artifact) ? ['Open in Zoom Docs'] : markdown ? ['Export to Zoom Docs', 'Check existing Zoom Docs export'] : [])];
    const action = await ctx.ui.select(title(artifact), actions); if (!action) return;
    if (action === 'Toggle next-prompt reference') {
      const index = bridge.selected.artifact.indexOf(artifact.key);
      if (index < 0) bridge.selected.artifact.push(artifact.key); else bridge.selected.artifact.splice(index, 1);
      bridge.contextChanged();
      ctx.ui.notify(index < 0 ? `Referenced ${title(artifact)} for the next prompt.` : 'Artifact reference removed.', 'info'); return;
    }
    if (action === 'Preview') { await previewArtifact(ctx, bridge, artifact, bridge.sessionId); return; }
    if (action === 'Save Markdown') {
      const destination = await markdownDestination(ctx, artifact);
      if (!destination) return;
      const result = await bridge.run('artifact-save', { artifact: artifact.key, ...destination });
      if (!result.out || result.mode !== '0600') throw new Error('The save did not confirm its output path and private mode.');
      ctx.ui.notify(`Saved ${result.out} (mode ${result.mode})`, 'info'); return;
    }
    if (action === 'Export to Zoom Docs' && !await ctx.ui.confirm('Export Markdown to Zoom Docs',
      `${title(artifact)}\nNative file: ${artifact.id}\nConversation: ${artifact.sessionId}\nOpen the existing export, or create one if none is reported? If an earlier export is unconfirmed, use Check existing Zoom Docs export instead.`)) return;
    const result = await bridge.run('artifact-export', { artifact: artifact.key, target: 'zoom-docs', reconcileOnly: action === 'Check existing Zoom Docs export' });
    if (result.url) pi.sendMessage({ customType: 'zoommate.result', content: `[${title(artifact)}](${result.url})`, display: true }, { triggerTurn: false });
    else if (result.taskId) ctx.ui.notify(`Conversion pending (${result.taskId}). Use Check existing Zoom Docs export to reconcile without another import, including after restarting.`, 'info');
    else if (result.outcome === 'unavailable') ctx.ui.notify('No existing Zoom Docs export is reported yet. No import was submitted.', 'info');
    else throw new Error('The provider did not confirm a document URL or pending task.');
  });
  register('computer', 'Inspect cloud screenshots, files and artifacts without sending a task', async (_args, ctx) => inspectComputer(ctx, bridge));
  register('mode', 'Select native Auto or Advanced when enabled', async (args, ctx) => {
    const options = bridge.modeOptions;
    if (!options.manualSelection) { ctx.ui.notify('Auto: this account does not enable manual native mode selection.', 'info'); return; }
    const choice = args || await ctx.ui.select(`Execution mode · current ${bridge.mode}`, options.modes);
    if (!choice) return;
    bridge.mode = choice; ctx.ui.notify(`Native execution mode: ${choice}`, 'info');
  });
  register('snapshot', 'Show an optional cloud-browser screenshot', async (_args, ctx) => {
    const snapshots = bridge.state.execution?.snapshots ?? [];
    if (!snapshots.length) { ctx.ui.notify('No native cloud-browser screenshots in this conversation.', 'info'); return; }
    const labels = snapshots.map((snapshot, index) => `${index + 1}. ${label(snapshot.title ?? snapshot.toolId ?? 'Browser snapshot')}`);
    const choice = await ctx.ui.select('Cloud screenshots · opt-in display', labels), snapshot = snapshots[labels.indexOf(choice)];
    if (!snapshot) return;
    await previewSnapshot(ctx, bridge, snapshot, bridge.sessionId);
  });
}
