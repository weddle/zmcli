import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { imageSize } from 'image-size';
import { AppError, writeFailure } from './session.mjs';
import { inspectAttachmentMedia } from './chat-media.mjs';
import { readPage, runDocs } from './docs.mjs';
import { renderZoomMateDocumentBlocks } from './zoommate-artifacts.mjs';

const MAX_BYTES = 8 * 1024 * 1024, conversions = new WeakMap();
const requireArtifact = artifact => {
  if (!artifact || !['document', 'file'].includes(artifact.kind) || typeof artifact.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(artifact.id)) throw new AppError('INVALID_INPUT', 'A native document or file artifact is required.');
  if (artifact.kind === 'file' && !/^[A-Za-z0-9_-]{1,128}$/u.test(artifact.sessionId ?? '')) throw new AppError('INVALID_INPUT', 'The file artifact requires its native conversation ID.');
};
const markdownFile = artifact => /\.(?:md|markdown)$/iu.test(artifact.file?.name ?? artifact.title ?? '');
const docsUrl = value => {
  let url; try { url = new URL(value); } catch { /* rejected below */ }
  if (!url || url.protocol !== 'https:' || url.hostname !== 'docs.zoom.us' || url.port || url.username || url.password || !/^\/doc\/[A-Za-z0-9_-]+$/u.test(url.pathname)) throw new AppError('UNSUPPORTED_RESPONSE', 'The provider did not return a native Zoom Docs document URL.');
  return url.href;
};
async function download(url, signal) {
  let parsed; try { parsed = new URL(url); } catch { /* rejected below */ }
  if (!parsed || parsed.protocol !== 'https:' || parsed.hostname !== 'file.zoom.us' || parsed.port || parsed.username || parsed.password || !/^\/file\/[A-Za-z0-9_-]+$/u.test(parsed.pathname)) throw new AppError('UNSUPPORTED_DOWNLOAD', 'Only the observed native file download capability is supported.');
  const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]) });
  if (response.status !== 200 || !response.body) throw new AppError('UNSUPPORTED_DOWNLOAD', 'The native file could not be downloaded.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) throw new AppError('ARTIFACT_TOO_LARGE', 'The artifact exceeds the 8 MiB download bound.'); chunks.push(chunk); }
  return { bytes: Buffer.concat(chunks), mimeType: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() };
}

export async function readZoomMateArtifact(transport, artifact, { signal } = {}) {
  requireArtifact(artifact);
  if (artifact.kind === 'document') {
    const docs = await transport.openDocs({ signal });
    try {
      const page = await readPage(docs, artifact.id), rendered = renderZoomMateDocumentBlocks(page.blocks, page.root.id);
      return { ...artifact, title: page.file.title ?? artifact.title, markdown: rendered.markdown, needsRead: false,
        native: { pageId: page.root.id, version: page.root.version, scope: 'single-native-page' }, unsupported: rendered.unsupported };
    } finally { docs.close(); }
  }
  const preview = await transport.request(`/api/v2/assets/${encodeURIComponent(artifact.sessionId)}/file-explorer/${encodeURIComponent(artifact.id)}/preview`, { signal });
  if (preview?.type !== 'text' || typeof preview.text !== 'string') throw new AppError('UNSUPPORTED_PREVIEW', 'This file has no native text preview. Browser images are available through /snapshot.');
  if (Buffer.byteLength(preview.text) > MAX_BYTES) throw new AppError('ARTIFACT_TOO_LARGE', 'The text preview exceeds 8 MiB.');
  return { ...artifact, markdown: preview.text, needsRead: false, preview: { source: 'native-file-explorer', type: preview.type } };
}

async function writeMarkdownFile(out, content) {
  let file;
  try {
    file = await open(out, 'wx', 0o600);
    await file.chmod(0o600);
    await file.writeFile(content);
    return (await file.stat()).mode & 0o777;
  } finally {
    await file?.close();
  }
}

export async function saveZoomMateArtifact(transport, artifact, { out, signal, task } = {}) {
  requireArtifact(artifact);
  if (typeof out !== 'string' || !out || out === '-') throw new AppError('INVALID_INPUT', 'Supply a Markdown output file path.');
  if (artifact.kind === 'document') {
    const docs = await transport.openDocs({ signal });
    try {
      const { markdown, ...result } = await runDocs(docs, 'export-markdown', { ...(task ? { task } : { id: artifact.id }), signal });
      const mode = await writeMarkdownFile(out, markdown);
      return { ...result, out, mode: mode.toString(8).padStart(4, '0'), bytes: Buffer.byteLength(markdown), sha256: createHash('sha256').update(markdown).digest('hex'),
        ...(task ? { requestedArtifact: artifact.key } : { artifact: artifact.key }) };
    } finally { docs.close(); }
  }
  if (!markdownFile(artifact)) throw new AppError('UNSUPPORTED_EXPORT', 'Only native Markdown files can be saved as Markdown without conversion.');
  const status = await transport.request(`/api/v1/file/status?fileId=${encodeURIComponent(artifact.id)}`, { signal });
  const { bytes, mimeType } = await download(status.fileUrl, signal);
  if (mimeType && !['text/plain', 'text/markdown', 'application/octet-stream'].includes(mimeType)) throw new AppError('UNSUPPORTED_EXPORT', 'The native download is not a Markdown/text file.');
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new AppError('UNSUPPORTED_EXPORT', 'The native Markdown file is not valid UTF-8.'); }
  const mode = await writeMarkdownFile(out, bytes);
  return { outcome: 'confirmed', artifact: artifact.key, out, mode: mode.toString(8).padStart(4, '0'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function exportZoomMateArtifact(transport, artifact, { target = 'zoom-docs', signal, task, reconcileOnly = false } = {}) {
  requireArtifact(artifact);
  if (target !== 'zoom-docs') throw new AppError('INVALID_INPUT', 'The supported export target is zoom-docs.');
  if (typeof reconcileOnly !== 'boolean') throw new AppError('INVALID_INPUT', 'Read-only reconciliation must be an explicit boolean.');
  if (artifact.kind === 'document') return { outcome: 'confirmed', documentId: artifact.id, url: docsUrl(`https://docs.zoom.us/doc/${artifact.id}`), identityPreserved: true };
  if (!markdownFile(artifact)) throw new AppError('UNSUPPORTED_EXPORT', 'This native conversion supports generated Markdown files.');
  let tasks = conversions.get(transport); if (!tasks) { tasks = new Map(); conversions.set(transport, tasks); }
  const key = `${artifact.sessionId}:${artifact.id}`;
  let operation = tasks.get(key);
  if (!operation && task) { operation = { taskId: task, outcome: 'pending' }; tasks.set(key, operation); }
  const existing = async () => {
    const files = await transport.request(`/api/v2/assets/${encodeURIComponent(artifact.sessionId)}/all-files`, { signal });
    if (!Array.isArray(files)) throw new AppError('UNSUPPORTED_RESPONSE', 'Native file metadata is missing.');
    const file = files.find(file => file.id === artifact.id);
    if (!file) throw new AppError('TARGET_NOT_FOUND', 'The generated file is no longer in this conversation.');
    return file.ai_office_url ? docsUrl(file.ai_office_url) : null;
  };
  let url = await existing();
  if (url) return { outcome: 'confirmed', artifact: artifact.key, url };
  operation ??= tasks.get(key);
  if (!operation && reconcileOnly) operation = { outcome: 'read-only' };
  if (!operation) {
    operation = { outcome: 'unknown' }; tasks.set(key, operation);
    try {
      const result = await transport.request('/api/v1/ai_office/import/async', { method: 'POST', signal,
        body: { fileId: artifact.id, fileType: 'md', sessionId: artifact.sessionId } });
      if (result?.status === 'completed' && (result.editUrl || result.edit_url)) {
        url = docsUrl(result.editUrl ?? result.edit_url); operation.url = url; operation.outcome = 'confirmed';
        return { outcome: 'confirmed', artifact: artifact.key, url };
      }
      const taskId = result?.taskId ?? result?.task_id;
      if (result?.status !== 'pending' || typeof taskId !== 'string' || !taskId) throw new AppError('UNSUPPORTED_RESPONSE', 'Conversion was submitted without a usable status or task ID.');
      operation.taskId = taskId; operation.outcome = 'pending';
    } catch (error) {
      const failure = writeFailure(error, { operation: 'zoommate.artifact-export', sessionId: artifact.sessionId, fileId: artifact.id });
      if (failure.details.outcome !== 'unknown') tasks.delete(key);
      throw failure;
    }
  }
  if (operation.url) return { outcome: 'confirmed', artifact: artifact.key, url: operation.url };
  // Native metadata reads reconcile a known conversion; never replay the write as a poll.
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    url = await existing();
    if (url) { operation.url = url; operation.outcome = 'confirmed'; return { outcome: 'confirmed', artifact: artifact.key, url }; }
  }
  if (operation.outcome === 'read-only') return { outcome: 'unavailable', artifact: artifact.key, sessionId: artifact.sessionId, fileId: artifact.id };
  if (operation.outcome === 'unknown') throw new AppError('WRITE_UNCONFIRMED', 'Conversion outcome remains unknown. No duplicate conversion was submitted.', { sessionId: artifact.sessionId, fileId: artifact.id, outcome: 'unknown' });
  return { outcome: 'pending', artifact: artifact.key, sessionId: artifact.sessionId, fileId: artifact.id, taskId: operation.taskId };
}

export async function readZoomMateSnapshot(transport, snapshot, { signal } = {}) {
  let bytes, mimeType;
  if (typeof snapshot?.base64 === 'string' && snapshot.base64) {
    const match = /^(?:data:(image\/[a-z]+);base64,)?([A-Za-z0-9+/]*={0,2})$/u.exec(snapshot.base64);
    if (!match || match[2].length % 4 || match[2].length > Math.ceil(MAX_BYTES / 3) * 4) throw new AppError('INVALID_MEDIA', 'Invalid or oversized native screenshot encoding.');
    bytes = Buffer.from(match[2], 'base64'); mimeType = match[1];
  } else {
    const status = snapshot?.fileId ? await transport.request(`/api/v1/file/status?fileId=${encodeURIComponent(snapshot.fileId)}`, { signal }) : null;
    ({ bytes, mimeType } = await download(status?.fileUrl ?? snapshot?.url, signal));
  }
  let dimensions; try { dimensions = imageSize(bytes); } catch { throw new AppError('INVALID_MEDIA', 'Native screenshot image headers cannot be decoded.'); }
  const inferred = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[dimensions.type];
  if (!mimeType || mimeType === 'application/octet-stream') mimeType = inferred;
  if (!inferred || dimensions.width * dimensions.height > 50000000) throw new AppError('INVALID_MEDIA', 'Unsupported or oversized screenshot dimensions.');
  const checked = inspectAttachmentMedia(bytes, mimeType);
  return { base64: bytes.toString('base64'), mimeType, title: snapshot.title ?? 'Cloud-browser screenshot', width: checked.dimension.width, height: checked.dimension.height };
}
