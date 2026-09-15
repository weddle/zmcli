const LINK_FIELDS = ['citation_url', 'citationUrl', 'url', 'permalink', 'meeting_url', 'meetingUrl', 'meeting_link', 'meetingLink', 'edl_url', 'edlUrl', 'preview_url', 'previewUrl'];
const text = value => typeof value === 'string' ? value : null;
const httpsLink = value => {
  if (typeof value !== 'string' || /\s/u.test(value)) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
};

export function visibleZoomMateTextParts(parts = []) {
  const visible = parts.filter(part => ['text', 'extended_text'].includes(part.metadata?.part_type ?? part.kind));
  const guarded = visible.filter(part => part.metadata?.tags?.includes('guardrail'));
  return guarded.length ? guarded : visible;
}

function unlinkedReferences(content) {
  const found = new Map();
  let fence = null, inlineTicks = 0;
  for (const line of content.split('\n')) {
    const boundary = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (boundary) {
      if (!fence) fence = boundary;
      else if (boundary[0] === fence[0] && boundary.length >= fence.length) fence = null;
      continue;
    }
    if (fence || /^(?: {4}|\t)/u.test(line)) continue;
    for (const match of line.matchAll(/(`+)|\^\[([^\]\r\n]+)\]|\[\^(\d+)\]/gu)) {
      if (match[1]) { if (!inlineTicks) inlineTicks = match[1].length; else if (inlineTicks === match[1].length) inlineTicks = 0; continue; }
      if (inlineTicks) continue;
      found.set(match[0], { marker: match[0], id: match[3] ?? null, title: match[2] ?? 'Unresolved source' });
    }
  }
  return [...found.values()];
}

export function deriveZoomMateCitations(messages = []) {
  const groups = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const [index, part] of visibleZoomMateTextParts(message.parts).entries()) {
      const partId = part.metadata?.part_id ?? null, key = `${message.message_id}:${partId ?? `text-${index}`}`;
      const supplied = Array.isArray(part.metadata?.citation) ? part.metadata.citation : [];
      const citations = supplied.filter(source => source && typeof source === 'object' && !Array.isArray(source)).map((source, ordinal) => {
        const id = Number.isSafeInteger(source.citation_id) ? source.citation_id : text(source.citation_id);
        let url = httpsLink(source.citation_url);
        for (const field of LINK_FIELDS) { if (url) break; url = httpsLink(source.metadata?.[field]); }
        return { key: `${key}:${ordinal}`, id, title: text(source.citation_title) ?? 'Untitled source',
          type: text(source.citation_type) ?? 'unknown', sourceId: text(source.source_id), url,
          excerpt: text(source.citation_text), sender: text(source.sender_name),
          timestamp: typeof source.message_timestamp === 'number' || typeof source.message_timestamp === 'string' ? source.message_timestamp : null,
          ...(id === null ? { unsupported: 'The provider omitted a usable citation marker.' } : {}) };
      });
      for (const reference of unlinkedReferences(part.text ?? '')) {
        if (reference.id !== null && citations.some(citation => String(citation.id) === String(reference.id))) continue;
        citations.push({ ...reference, key: `${key}:unlinked:${citations.length}`, type: 'unresolved', sourceId: null, url: null,
          excerpt: null, sender: null, timestamp: null,
          unsupported: 'This citation has no native source metadata. Its identity, link and excerpt have not been guessed from its label.' });
      }
      if (citations.length) groups.push({ key, messageId: message.message_id, partId,
        responseExcerpt: (part.text ?? '').slice(0, 160), citations });
    }
  }
  return groups;
}
