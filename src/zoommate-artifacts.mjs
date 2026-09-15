import { DOMParser } from '@xmldom/xmldom';

const partType = part => part?.metadata?.part_type ?? part?.kind;
const children = node => Array.from(node.childNodes ?? []);
const elements = node => children(node).filter(child => child.nodeType === 1);
const escape = value => String(value ?? '').replace(/([\\`*_{}\[\]<>#|])/gu, '\\$1');
const blocks = new Set(['document', 'changes', 'text', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'uli', 'oli', 'todo', 'quote', 'callout', 'code-block', 'math-block', 'hr', 'table', 'columns', 'column']);

export function renderZoomMateDocumentXml(xml, { partial = false } = {}) {
  const unsupported = [];
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 4 * 1024 * 1024 || /<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml)) {
    return { markdown: '', unsupported: [{ reason: 'UNSAFE_OR_OVERSIZED_XML' }], complete: false };
  }
  if (!xml.trim()) return { markdown: '', unsupported: [], complete: !partial };
  let doc;
  try {
    doc = new DOMParser({ onError() { throw new Error('Malformed XML'); } }).parseFromString(`<artifact>${xml}</artifact>`, 'application/xml');
  } catch {
    return { markdown: '', unsupported: partial ? [] : [{ reason: 'MALFORMED_XML' }], complete: false };
  }
  let visited = 0;
  const issue = (node, reason = 'UNSUPPORTED_XML_TAG') => {
    unsupported.push({ reason, tag: node.nodeName, ...(node.getAttribute?.('id') ? { id: node.getAttribute('id') } : {}) });
  };
  const walk = (node, depth = 0, inlineOnly = false) => {
    if (++visited > 20000 || depth > 64) throw new Error('XML preview bound exceeded');
    if (node.nodeType === 3 || node.nodeType === 4) return escape(node.data.replace(/\s+/gu, ' '));
    if (node.nodeType !== 1) return '';
    const tag = node.nodeName.toLowerCase();
    const inner = () => children(node).map(child => walk(child, depth + 1, true)).join('');
    const body = () => children(node).map(child => walk(child, depth + 1)).join('');
    if (tag === 'artifact' || tag === 'document' || tag === 'changes') return body();
    if (tag === 'b') return `**${inner()}**`;
    if (tag === 'i') return `*${inner()}*`;
    if (tag === 's') return `~~${inner()}~~`;
    if (tag === 'u' || tag === 'h') { issue(node, 'UNREPRESENTED_TEXT_STYLE'); return inner(); }
    if (tag === 'code') {
      const text = node.textContent ?? '', fence = '`'.repeat(Math.max(1, ...Array.from(text.matchAll(/`+/gu), match => match[0].length + 1)));
      return `${fence} ${text} ${fence}`;
    }
    if (tag === 'a') {
      const href = node.getAttribute('href') ?? '';
      if (!/^(?:https?:|mailto:)/iu.test(href) || /[\u0000-\u0020<>]/u.test(href)) { issue(node, 'UNSUPPORTED_LINK'); return inner(); }
      return `[${inner()}](<${href}>)`;
    }
    if (tag === 'br') return '\n';
    if (/^h[1-6]$/u.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${inner().trim()}\n\n`;
    if (tag === 'text' || tag === 'p') return `${inner().trim()}${inlineOnly ? '' : '\n\n'}`;
    if (['uli', 'oli', 'todo'].includes(tag)) {
      const nested = elements(node).filter(child => blocks.has(child.nodeName.toLowerCase()) && child.nodeName.toLowerCase() !== 'text');
      const content = children(node).filter(child => !nested.includes(child)).map(child => walk(child, depth + 1, true)).join('').trim();
      const marker = tag === 'oli' ? '1.' : tag === 'todo' ? `- [${node.getAttribute('checked') === 'true' ? 'x' : ' '}]` : '-';
      return `${marker} ${content}\n${nested.map(child => walk(child, depth + 1).trimEnd().split('\n').map(line => `  ${line}`).join('\n') + '\n').join('')}`;
    }
    if (tag === 'quote' || tag === 'callout') return body().trim().split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
    if (tag === 'code-block' || tag === 'math-block') {
      const content = node.textContent ?? '', fence = '`'.repeat(Math.max(3, ...Array.from(content.matchAll(/`+/gu), match => match[0].length + 1)));
      const language = tag === 'math-block' ? 'math' : (node.getAttribute('language') ?? '').replace(/[^a-z0-9_+-]/giu, '');
      return `${fence}${language}\n${content}\n${fence}\n\n`;
    }
    if (tag === 'hr') return '\n---\n\n';
    if (tag === 'table') {
      const rows = Array.from(node.getElementsByTagName('tr')).map(row => elements(row).filter(cell => ['td', 'th'].includes(cell.nodeName.toLowerCase())).map(cell => {
        if (Number(cell.getAttribute('colspan') || 1) > 1 || Number(cell.getAttribute('rowspan') || 1) > 1) issue(cell, 'UNREPRESENTED_TABLE_SPAN');
        return children(cell).map(child => walk(child, depth + 1, true)).join('').trim().replace(/\n/gu, ' ');
      }));
      if (!rows.length) return '';
      const width = Math.max(...rows.map(row => row.length));
      const line = row => `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`;
      return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n') + '\n\n';
    }
    if (tag === 'update-title') return `Title: ${inner().trim()}\n\n`;
    if (['update', 'replace', 'replace-range', 'insert', 'delete'].includes(tag)) {
      const target = node.getAttribute('id') || node.getAttribute('start-id') || node.getAttribute('above') || node.getAttribute('below') || node.getAttribute('parent');
      return `${tag}${target ? ` (${escape(target)})` : ''}:\n${body()}\n`;
    }
    issue(node);
    return `[Unsupported ${escape(tag)}]\n${inner()}\n`;
  };
  try {
    return { markdown: walk(doc.documentElement).replace(/\n{3,}/gu, '\n\n').trim(), unsupported, complete: !partial && unsupported.length === 0 };
  } catch {
    return { markdown: '', unsupported: [{ reason: 'XML_PREVIEW_LIMIT' }], complete: false };
  }
}

export const isZoomMateDocumentPart = part => ['create_doc', 'update_doc'].includes(partType(part));

export function renderZoomMateDocumentBlocks(blocks, rootId) {
  const values = Array.isArray(blocks) ? blocks : Object.values(blocks);
  const encode = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const byParent = new Map();
  for (const block of values) {
    if (block.id === rootId) continue;
    if (!byParent.has(block.parentId)) byParent.set(block.parentId, []);
    byParent.get(block.parentId).push(block);
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);
  const mappings = { PARAGRAPH: 'text', BULLET: 'uli', NUMBERED: 'oli', QUOTE: 'quote', CALLOUT: 'callout',
    TABLE: 'table', TABLE_ROW: 'tr', TABLE_CELL: 'td', DIVIDER: 'hr',
    ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`HEADING${i + 1}`, `h${i + 1}`])) };
  const seen = new Set();
  const visit = (parent, depth = 0) => {
    if (depth > 64) return '<unknown-block type="DEPTH_LIMIT"/>';
    return (byParent.get(parent) ?? []).map(block => {
      if (seen.has(block.id)) return '<unknown-block type="CYCLIC"/>';
      seen.add(block.id);
      if (block.type === 'BLOCK_TYPE_TABLE_COL') return '';
      let runs;
      try { runs = JSON.parse(block.content?.title ?? '[]'); } catch { runs = null; }
      const text = Array.isArray(runs) ? runs.map(run => {
        if (!Array.isArray(run) || run[0] !== 0) return '<unknown-inline/>';
        const source = run[1]?.link?.source;
        let value = typeof run[1] === 'string' ? encode(run[1]) : source?.type === 'link' ? `<a href="${encode(source.link)}">${encode(source.text)}</a>` : '<unknown-inline/>';
        if (/(?:^|\|)8:1(?:\||$)/u.test(run[2] ?? '')) value = `<b>${value}</b>`;
        if (/(?:^|\|)9:1(?:\||$)/u.test(run[2] ?? '')) value = `<i>${value}</i>`;
        return value;
      }).join('') : '<unknown-inline/>';
      const tag = mappings[String(block.type).replace(/^BLOCK_TYPE_/u, '')] ?? 'unknown-block';
      return `<${tag} id="${encode(block.id)}">${text}${visit(block.id, depth + 1)}</${tag}>`;
    }).join('');
  };
  return renderZoomMateDocumentXml(`<document>${visit(rootId)}</document>`);
}

export function deriveZoomMateArtifacts(messages, { sessionId = null, pendingApprovals = [] } = {}) {
  const byKey = new Map(), unsupported = [], edits = new Map(), responses = new Map();
  for (const message of messages) for (const part of message.parts ?? []) {
    const data = part.data;
    if (partType(part) === 'client_tool_result' && data?.tool_call_id && data.response) responses.set(data.tool_call_id, data.response.response_data?.action_id);
    if (partType(part) !== 'client_tool' || !data?.tool_call_id) continue;
    const spec = data.parameters_values?.find(item => item.name === 'spec')?.value;
    for (const field of spec?.fields ?? []) {
      if (field.type !== 'edit_canvas_card' || typeof field.props?.edit_id !== 'string') continue;
      edits.set(field.props.edit_id, { approvalId: data.tool_call_id, transactionId: field.props.transaction_id });
    }
  }
  const pending = new Set(pendingApprovals.map(item => item.toolCallId));
  for (const message of messages) for (const part of message.parts ?? []) {
    const metadata = part.metadata ?? {}, type = partType(part);
    const origin = { sessionId, messageId: message.message_id, requestId: message.request_id ?? message.message_id, partId: metadata.part_id ?? null };
    if (isZoomMateDocumentPart(part)) {
      if (part.kind !== 'text' || typeof metadata.doc_id !== 'string' || !metadata.doc_id || typeof part.text !== 'string') {
        unsupported.push({ ...origin, partType: type, reason: 'MALFORMED_DOCUMENT_ARTIFACT', part: structuredClone(part) }); continue;
      }
      const key = `document:${metadata.doc_id}`, previous = byKey.get(key), update = type === 'update_doc';
      const finished = metadata.last_chunk === true;
      const preview = renderZoomMateDocumentXml(part.text, { partial: !finished });
      const record = { ...origin, key, id: metadata.doc_id, kind: 'document', title: metadata.title ?? previous?.title ?? 'Untitled document',
        status: finished ? 'ready' : 'streaming', xml: part.text, markdown: preview.markdown, unsupported: preview.unsupported,
        needsRead: false };
      if (update) {
        const correlation = edits.get(metadata.edit_id), action = responses.get(correlation?.approvalId);
        const resolved = action === 'canvas_accept' || action === 'canvas_reject';
        record.status = action === 'canvas_reject' ? 'rejected' : action === 'canvas_accept' || metadata.force_accept === true ? 'ready' : finished || pending.has(correlation?.approvalId) ? 'pending' : 'streaming';
        record.update = { editId: metadata.edit_id ?? null, transactionId: correlation?.transactionId ?? null, approvalId: correlation?.approvalId ?? null,
          xml: part.text, markdown: preview.markdown, ...(resolved ? { action } : {}) };
        record.markdown = previous && !previous.needsRead ? previous.markdown : '';
        record.needsRead = true;
      }
      byKey.set(key, record);
    } else if (type === 'summary_attachments') {
      const files = part.data?.attachments_v2;
      if (files === undefined) continue;
      if (!Array.isArray(files)) { unsupported.push({ ...origin, partType: type, reason: 'MALFORMED_ARTIFACT_LIST', part: structuredClone(part) }); continue; }
      for (const file of files) {
        if (typeof file?.id !== 'string' || !file.id) { unsupported.push({ ...origin, partType: type, reason: 'MISSING_ARTIFACT_ID', file: structuredClone(file) }); continue; }
        const key = `file:${file.id}`;
        byKey.set(key, { ...byKey.get(key), ...origin, key, id: file.id, kind: 'file', title: file.name ?? file.id,
          status: 'ready', file: structuredClone(file), needsRead: true });
      }
    }
  }
  return { artifacts: [...byKey.values()], unsupported };
}
