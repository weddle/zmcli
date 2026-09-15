import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DOMParser } from '@xmldom/xmldom';
import { AppError, writeFailure } from './session.mjs';
import { readPage, runDocs } from './docs.mjs';
import { renderZoomMateDocumentBlocks } from './zoommate-artifacts.mjs';

const prepared = new WeakSet(), submittedPlans = new WeakSet();
const tags = { text: 'PARAGRAPH', uli: 'BULLET', oli: 'NUMBERED', ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`h${i + 1}`, `HEADING${i + 1}`])) };
const operationAttributes = { 'update-title': [], insert: ['above', 'below', 'parent'], update: ['id'],
  replace: ['id'], 'replace-range': ['start-id', 'end-id'], delete: ['id'] };
const elements = node => Array.from(node.childNodes ?? []).filter(child => child.nodeType === 1);
const fail = (message, details) => { throw new AppError('UNSUPPORTED_EDIT', message, details); };
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const siblings = (blocks, parentId) => Object.values(blocks).filter(block => block.parentId === parentId).sort((a, b) => a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);
function textOf(block) {
  let runs;
  try { runs = JSON.parse(block.content.title); } catch { fail('The target has no supported native text representation.', { blockId: block.id }); }
  if (!Array.isArray(runs) || runs.some(run => !Array.isArray(run) || run[0] !== 0 || typeof run[1] !== 'string')) fail('The target contains embedded rich content; use its native Docs editor.', { blockId: block.id });
  return runs.map(run => run[1]).join('');
}
function contentOf(node, actorId, depth = 0) {
  if (depth > 32 || !tags[node.nodeName.toLowerCase()]) fail('This native block type needs the Docs editor.', { tag: node.nodeName });
  if (node.attributes.length) fail('Native content attributes require the Docs editor; no attributes were discarded.');
  const type = `BLOCK_TYPE_${tags[node.nodeName.toLowerCase()]}`, runs = [], nested = [];
  const visit = (parent, attributes = {}) => {
    for (const child of parent.childNodes ?? []) {
      if (child.nodeType === 3 || child.nodeType === 4) {
        const text = child.data.replace(/\s/gu, ' ');
        if (text) runs.push([0, text, [...Object.entries(attributes).map(([key, value]) => `${key}:${value}`), `26:${JSON.stringify(actorId)}`].join('|')]);
      } else if (child.nodeType === 1) {
        if (child.attributes.length) fail('Native inline attributes require the Docs editor; no attributes were discarded.');
        const name = child.nodeName.toLowerCase();
        if (name === 'b' || name === 'i') visit(child, { ...attributes, [name === 'b' ? '8' : '9']: 1 });
        else if (name === 'text' && ['BLOCK_TYPE_BULLET', 'BLOCK_TYPE_NUMBERED'].includes(type)) visit(child, attributes);
        else if (tags[name] && ['BLOCK_TYPE_BULLET', 'BLOCK_TYPE_NUMBERED'].includes(type)) nested.push(contentOf(child, actorId, depth + 1));
        else fail('This inline or nested structure needs the native Docs editor; no formatting was discarded.', { tag: name });
      }
    }
  };
  visit(node);
  return { type, content: { title: JSON.stringify(runs) }, style: {}, children: nested };
}
const preview = (blocks, rootId) => renderZoomMateDocumentBlocks(blocks, rootId).markdown;

export async function prepareZoomMateDocumentEdit(docsSession, artifact) {
  const documentId = artifact?.id, editId = artifact?.update?.editId, transactionId = artifact?.update?.transactionId;
  if (![documentId, editId, transactionId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(value))) throw new AppError('INVALID_INPUT', 'Native document, edit and transaction IDs are required.');
  const source = artifact.update.xml;
  if (typeof source !== 'string' || Buffer.byteLength(source) > 1024 * 1024 || /<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(source)) fail('Unsafe or oversized edit XML.');
  let root;
  try { root = new DOMParser({ onError() { throw new Error('Malformed XML'); } }).parseFromString(`<changes>${source}</changes>`, 'application/xml').documentElement; }
  catch { fail('Malformed edit XML; nothing was sent.'); }
  const page = await readPage(docsSession, documentId), actor = { ...docsSession.identity.user };
  if (page.file.privilege?.permissionWithReason?.edit?.hasPermission !== true) throw new AppError('FORBIDDEN', 'Native document edit permission is required.');
  const before = structuredClone(page.blocks), after = structuredClone(before), order = new Map(), ops = [], changes = [];
  for (const block of Object.values(before)) order.set(block.id, siblings(before, block.id).map(child => child.id));
  const originalIds = [];
  const enumerate = parent => { for (const id of order.get(parent) ?? []) { originalIds.push(id); enumerate(id); } };
  enumerate(documentId);
  const resolve = value => {
    if (!value) fail('A native block target is required.');
    const matches = Object.keys(after).filter(id => id.startsWith(value));
    if (!matches.length && /^block-\d+$/u.test(value)) { const id = originalIds[Number(value.slice(6))]; if (id && after[id]) return after[id]; }
    if (matches.length !== 1) throw new AppError(matches.length ? 'AMBIGUOUS_EDIT_TARGET' : 'TARGET_NOT_FOUND', 'The edit target must identify exactly one native block.', { target: value });
    return after[matches[0]];
  };
  const remove = block => {
    if (block.id === documentId) fail('The root document cannot be deleted by a block edit.');
    for (const id of [...(order.get(block.id) ?? [])]) remove(after[id]);
    ops.push({ command: 'COMMAND_TYPE_DELETE', blockId: block.id });
    order.set(block.parentId, order.get(block.parentId).filter(id => id !== block.id)); order.delete(block.id); delete after[block.id];
  };
  const insert = (content, parentId, index) => {
    const id = randomUUID().replaceAll('-', ''), list = order.get(parentId);
    if (!list) fail('The insertion parent is unavailable.');
    const block = { id, parentId, type: content.type, content: content.content, style: content.style, seq: '' };
    ops.push({ command: 'COMMAND_TYPE_CREATE', blockId: id, args: { type: block.type, content: block.content, style: block.style, parentBlockId: parentId, afterBlockId: list[index - 1] ?? null } });
    list.splice(index, 0, id); after[id] = block; order.set(id, []);
    for (const [childIndex, child] of content.children.entries()) insert(child, id, childIndex);
  };
  let title;
  const nodes = elements(root).flatMap(node => node.nodeName.toLowerCase() === 'changes' ? elements(node) : [node]);
  for (const node of nodes) {
    const kind = node.nodeName.toLowerCase();
    const allowed = operationAttributes[kind];
    if (!Array.isArray(allowed)) fail('Unrecognized native edit operation.', { operation: kind });
    if (Array.from(node.attributes).some(attribute => !allowed.includes(attribute.name))) fail('Unsupported native operation attributes; the requested scope was not changed.');
    if (kind === 'update-title') {
      if (page.file.privilege?.permissionWithReason?.modifyMetadata?.hasPermission !== true) throw new AppError('FORBIDDEN', 'Native title modification permission is required.');
      title = node.textContent; changes.push({ operation: kind, title }); continue;
    }
    const content = kind === 'delete' ? [] : elements(node).map(child => contentOf(child, actor.userId));
    if (kind !== 'delete' && !content.length) fail('The edit contains no supported content.');
    if (kind === 'insert') {
      if (node.hasAttribute('above') && node.hasAttribute('below')) fail('Insertion requires one unambiguous sibling anchor.');
      if (allowed.some(name => node.hasAttribute(name) && !node.getAttribute(name))) fail('Insertion coordinates must not be empty.');
      const above = node.getAttribute('above'), below = node.getAttribute('below'), parent = node.getAttribute('parent');
      const anchor = above ? resolve(above) : below ? resolve(below) : null;
      let parentId = parent ? resolve(parent).id : anchor?.parentId ?? documentId;
      if (after[parentId]?.type === 'BLOCK_TYPE_PARAGRAPH' || /^BLOCK_TYPE_HEADING/u.test(after[parentId]?.type ?? '')) fail('Insertion into a non-container requires an explicit sibling anchor.');
      const list = order.get(parentId);
      if (anchor && anchor.parentId !== parentId) fail('The insertion anchor and parent disagree.');
      const index = anchor ? list.indexOf(anchor.id) + (above ? 0 : 1) : list.length;
      content.forEach((block, offset) => insert(block, parentId, index + offset));
      changes.push({ operation: kind, parentId, count: content.length }); continue;
    }
    const first = resolve(node.getAttribute(kind === 'replace-range' ? 'start-id' : 'id'));
    if (first.id === documentId) fail('Use update-title for the document title.');
    if (kind === 'delete') { changes.push({ operation: kind, blockId: first.id }); remove(first); continue; }
    if (kind === 'update' && content.length === 1 && !content[0].children.length && !(order.get(first.id)?.length)) {
      if (!Object.values(tags).some(type => first.type === `BLOCK_TYPE_${type}`)) fail('This block cannot be updated as text.');
      const oldText = textOf(first), next = content[0], delta = JSON.parse(next.content.title);
      if (oldText.length) delta.push([1, oldText.length]);
      ops.push({ command: 'COMMAND_TYPE_UPDATE', blockId: first.id, args: { delta: JSON.stringify(delta), ...(first.type !== next.type ? { type: next.type } : {}) } });
      first.content = { ...first.content, title: next.content.title }; first.type = next.type;
      changes.push({ operation: kind, blockId: first.id, text: textOf(first) }); continue;
    }
    const last = kind === 'replace-range' ? resolve(node.getAttribute('end-id')) : first;
    if (first.parentId !== last.parentId) fail('Cross-container replacement needs the native Docs editor.');
    const list = order.get(first.parentId), start = list.indexOf(first.id), end = list.indexOf(last.id);
    if (start < 0 || end < start) fail('The replacement range is reversed or unavailable.');
    const parentId = first.parentId;
    for (const id of list.slice(start, end + 1)) remove(after[id]);
    content.forEach((block, offset) => insert(block, parentId, start + offset));
    changes.push({ operation: kind, startBlockId: first.id, endBlockId: last.id, count: content.length });
  }
  if (!ops.length && title === undefined) fail('The edit contains no native operations.');
  // Synthetic order is used only for the approval preview; server sequence values are never guessed in a write.
  for (const ids of order.values()) ids.forEach((id, index) => { if (after[id]) after[id].seq = String(index).padStart(8, '0'); });
  const plan = freeze({ documentId, editId, transactionId, baseVersion: page.root.version, title: page.file.title,
    beforeMarkdown: preview(before, documentId), afterMarkdown: preview(after, documentId), changes,
    privatePlan: { before, after, order: [...order], actor, route: page.file.fileClusterApiPrefix, ops, title, sourceXml: source } });
  prepared.add(plan); return plan;
}

export async function commitZoomMateDocumentEdit(docsSession, plan) {
  if (!prepared.has(plan) || submittedPlans.has(plan)) throw new AppError('INVALID_INPUT', 'Use an unsubmitted prepared edit; an uncertain transaction must not be replayed.');
  const { before, after: expected, order, actor, route, ops, title } = plan.privatePlan;
  const current = await readPage(docsSession, plan.documentId);
  if (docsSession.identity.user.userId !== actor.userId || docsSession.identity.user.accountId !== actor.accountId) throw new AppError('TENANT_MISMATCH', 'The document actor changed.');
  if (current.root.version !== plan.baseVersion || !isDeepStrictEqual(current.blocks, before)) throw new AppError('VERSION_CONFLICT', 'The document changed while approval was open. Prepare and review it again.');
  if (current.file.privilege?.permissionWithReason?.edit?.hasPermission !== true) throw new AppError('FORBIDDEN', 'Document edit permission changed.');
  const context = { documentId: plan.documentId, editId: plan.editId, transactionId: plan.transactionId, requestId: randomUUID(), clientId: randomUUID(), baseVersion: plan.baseVersion };
  let accepted = false;
  submittedPlans.add(plan);
  try {
    if (ops.length) {
      await docsSession.request(`/api/block/transactions?fileId=${encodeURIComponent(plan.documentId)}`, { method: 'POST', base: route,
        body: { reqId: context.requestId, clientId: context.clientId, baseVersion: plan.baseVersion,
          transactions: [{ id: plan.transactionId, ops, extra: { editsSourceType: 'EDIT_SOURCE_TYPE_AI_PANEL', transactionId: plan.transactionId } }], extra: { fromFileId: plan.documentId } } });
      accepted = true;
    }
    if (title !== undefined) { context.phase = 'title'; await runDocs(docsSession, 'rename', { id: plan.documentId, title }); accepted = true; }
    for (let attempt = 0; attempt < 5; attempt++) {
      const after = await readPage(docsSession, plan.documentId);
      const matching = Object.keys(after.blocks).length === Object.keys(expected).length && Object.values(expected).every(block => {
        const actual = after.blocks[block.id];
        return actual?.type === block.type && actual.parentId === block.parentId
          && (block.id === plan.documentId && title !== undefined || isDeepStrictEqual(actual.content, block.content))
          && isDeepStrictEqual(actual.style ?? {}, block.style ?? {});
      });
      if (matching && order.every(([parent, ids]) => isDeepStrictEqual(siblings(after.blocks, parent).map(block => block.id), ids))
          && (title === undefined || after.file.title === title)) return { ...context, outcome: 'confirmed', version: after.root.version,
            verification: 'native-content-style-and-complete-child-order-readback', atomic: title === undefined };
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new AppError('READBACK_MISMATCH', 'The intended content and unchanged surrounding structure were not confirmed.');
  } catch (error) { throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }, accepted ? 'unknown' : undefined); }
}
