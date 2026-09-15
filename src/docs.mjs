import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { open, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { AppError, writeFailure } from './session.mjs';
import { decodeCursor, encodeCursor } from './cursor.mjs';
import { inspectAttachmentMedia } from './chat-media.mjs';

export function fileId(value) {
  if (typeof value !== 'string') throw new AppError('INVALID_INPUT', 'Supply a document ID or Docs URL.');
  if (value.startsWith('https://')) {
    let url;
    try { url = new URL(value); } catch { throw new AppError('INVALID_INPUT', 'Invalid document URL.'); }
    if (url.hostname !== 'docs.zoom.us' || url.username || url.password || url.port || !/^\/(doc|page)\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname)) {
      throw new AppError('INVALID_INPUT', 'Use a docs.zoom.us/doc/ID or /page/ID URL.');
    }
    value = url.pathname.split('/')[2];
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new AppError('INVALID_INPUT', 'Invalid document ID.');
  return value;
}

export function documentPage(items, token, scope, seen = []) {
  const previous = new Set(seen), overlap = [], fresh = [];
  for (const item of items) {
    if (previous.has(item.id)) overlap.push(item.id);
    else { previous.add(item.id); fresh.push(item); }
  }
  const nextCursor = token ? encodeCursor(scope, { token, seen: [...previous] }) : null;
  const reason = overlap.length ? 'RESULTS_CHANGED_DURING_PAGINATION' : nextCursor?.length > 60000 ? 'CURSOR_STATE_LIMIT' : null;
  return { items: fresh, nextCursor: reason ? null : nextCursor,
    pagination: { status: reason ? 'incomplete' : nextCursor ? 'more' : 'end', complete: !reason && !nextCursor,
      snapshot: false, ...(reason ? { reason, overlappingIds: overlap } : {}) } };
}

function fileSummary(file) {
  const routeVerified = typeof file?.fileClusterApiPrefix === 'string' && file.fileClusterApiPrefix.length > 0;
  const readSupported = file?.fileType === 'doc' && routeVerified;
  return {
    id: file?.id, title: file?.title, type: file?.fileType,
    readSupported,
    ...(readSupported ? {} : { unsupportedReason: file?.fileType === 'doc' ? 'READ_ROUTE_UNVERIFIED' : 'UNSUPPORTED_FILE_TYPE' }),
    parentId: file?.parentId, url: file?.fileLink,
    ownerId: file?.owner?.ownerId ?? null, updatedAt: file?.updatedInfo?.time,
    permissions: Object.fromEntries(Object.entries(file?.privilege?.permissionWithReason ?? {})
      .filter(([key]) => ['access', 'edit', 'modifyMetadata', 'remove'].includes(key))
      .map(([key, value]) => [key, value?.hasPermission === true])),
  };
}

async function metadata(session, id) {
  const result = await session.request('/api/file/files/action/batch_get', { method: 'POST', safeRead: true, body: { ids: [id] } });
  const file = result.successItems?.find(item => item.id === id);
  if (!file) throw new AppError('NOT_FOUND_OR_FORBIDDEN', 'Document unavailable to this session; check its ID and access.');
  if (file.fileType !== 'doc') throw new AppError('UNSUPPORTED_FILE', 'This command supports Docs documents, not other Canvas file types.');
  return file;
}

async function inspectPermissions(session, id, options = {}) {
  // Metadata failure is fatal; the two independent sharing reads can fail partially.
  const file = await metadata(session, id);
  const issues = [];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const issue = (reason, path) => issues.push({ reason, path });
  const roles = new Set(['owner', 'co-owner', 'editor', 'commenter', 'viewer', 'member', 'unspecified', 'noAccess']);
  const targets = ['user', 'channel', 'group', 'tag', 'accountScope', 'whiteboard'];
  const roleFields = ['spacePermissionSetting', 'currentSpacePermissionSetting', 'inheritSpacePermissionSetting',
    'meetingDocRole', 'meetingDocInviteeRole', 'meetingDocParticipantRole', 'spaceMemberDefaultInheritedRole'];
  const linkFields = ['linkAccess', 'currentLinkAccess', 'inheritLinkAccess'];
  const arrayFields = ['collaborators', 'disabledExternalCollaborators', 'sharingMeetings', 'wikiMemberPermissionGroups',
    'wikiMemberGroupPermissionSetting', 'currentWikiMemberGroupPermissionSetting', 'inheritWikiMemberGroupPermissionSetting'];
  const permissionFields = new Set([...roleFields, ...linkFields, ...arrayFields,
    'emailInviteIsClosed', 'anyoneWithLinkEnabled', 'orgPublishInfo']);
  const sensitive = /token|authorization|cookie|password|passcode|secret|signature|credential/i;
  const shape = value => ({ redacted: true, type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value });
  const sanitize = (value, path) => {
    if (Array.isArray(value)) return value.map((item, index) => sanitize(item, `${path}[${index}]`));
    if (!object(value)) return typeof value === 'string' && /(?:^bearer\s|[?&](?:(?:x-amz-|x-goog-)?(?:signature|credential|security-token)|(?:access_|auth_|refresh_)?token|sig)=)/i.test(value) ? shape(value) : value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (sensitive.test(key)) return [key, shape(item)];
      return [key, sanitize(item, `${path}.${key}`)];
    }));
  };
  const checkRole = (value, path, nullable = true) => {
    if (value === null && nullable) return;
    if (!object(value) || !roles.has(value.newRole) || (value.role !== undefined && !roles.has(value.role))) {
      issue('UNKNOWN_OR_MALFORMED_ROLE', path); return;
    }
    if (value.source !== undefined && !['unspecified', 'collaboration', 'conference'].includes(value.source)) issue('UNKNOWN_ROLE_SOURCE', path);
  };
  const checkLink = (value, path) => {
    if (value === null) return;
    if (!object(value)) { issue('MALFORMED_LINK_SETTING', path); return; }
    if (!['linkPermissionSetting', 'accountPermissionSetting', 'spacePermissionSetting',
      'wikiEditorPermissionSetting', 'wikiCommenterPermissionSetting', 'wikiViewerPermissionSetting'].includes(value.settingItem)) issue('UNKNOWN_LINK_SOURCE', path);
    checkRole(value.role, `${path}.role`, false);
  };
  const checkPermission = (value, path) => {
    if (!object(value)) { issue('MALFORMED_PERMISSION_INFO', path); return; }
    for (const key of Object.keys(value)) if (!permissionFields.has(key)) issue('UNKNOWN_GRANT_CLASS', `${path}.${key}`);
    for (const key of ['collaborators', 'disabledExternalCollaborators', 'sharingMeetings']) {
      if (!Array.isArray(value[key])) issue('MISSING_OR_MALFORMED_GRANT_ARRAY', `${path}.${key}`);
    }
    for (const key of arrayFields) {
      if (!(key in value)) continue;
      if (!Array.isArray(value[key])) { issue('MALFORMED_GRANT_ARRAY', `${path}.${key}`); continue; }
      if (!['collaborators', 'disabledExternalCollaborators'].includes(key)) {
        if (value[key].length) issue('UNVERIFIED_GRANT_CLASS', `${path}.${key}`);
        continue;
      }
      value[key].forEach((grant, index) => {
        const at = `${path}.${key}[${index}]`;
        if (!object(grant)) { issue('MALFORMED_COLLABORATOR', at); return; }
        const present = targets.filter(target => grant[target] != null);
        if (present.length !== 1) issue('UNKNOWN_OR_AMBIGUOUS_TARGET', at);
        for (const target of present) {
          const identity = grant[target];
          if (!object(identity) || typeof identity[target === 'accountScope' ? 'accountId' : 'id'] !== 'string') issue('MALFORMED_TARGET', `${at}.${target}`);
          if (target !== 'user') issue('UNVERIFIED_TARGET_TYPE', `${at}.${target}`);
        }
        checkRole(grant.role, `${at}.role`, false);
        for (const field of ['currentRole', 'inheritedRole']) if (field in grant) checkRole(grant[field], `${at}.${field}`);
        for (const flag of ['isInherited', 'isExternal', 'isEmailInvitee']) if (typeof grant[flag] !== 'boolean') issue('MALFORMED_COLLABORATOR_FLAG', `${at}.${flag}`);
        if (grant.isInherited || grant.inheritedRole != null) issue('NESTED_INHERITANCE_UNVERIFIED', at);
      });
    }
    for (const key of roleFields) if (key in value) checkRole(value[key], `${path}.${key}`);
    for (const key of linkFields) if (key in value) checkLink(value[key], `${path}.${key}`);
    for (const key of ['spacePermissionSetting', 'meetingDocRole', 'linkAccess']) if (!(key in value)) issue('MISSING_GRANT_SETTING', `${path}.${key}`);
    if (typeof value.emailInviteIsClosed !== 'boolean') issue('MALFORMED_SHARING_FLAG', `${path}.emailInviteIsClosed`);
    if ('anyoneWithLinkEnabled' in value && typeof value.anyoneWithLinkEnabled !== 'boolean') issue('MALFORMED_SHARING_FLAG', `${path}.anyoneWithLinkEnabled`);
    if (value.orgPublishInfo != null) issue('UNVERIFIED_GRANT_CLASS', `${path}.orgPublishInfo`);
  };
  const privilege = file.privilege;
  const capabilities = object(privilege?.permissionWithReason) ? privilege.permissionWithReason : {};
  if (!object(privilege)) issue('MISSING_EFFECTIVE_PRIVILEGE', 'metadata.privilege');
  checkRole(privilege?.role, 'metadata.privilege.role', false);
  for (const key of ['access', 'edit', 'seeCollaborators', 'addCollaborators', 'removeCollaborators', 'modifyCollaboratorRole']) {
    if (!(key in capabilities)) issue('MISSING_EFFECTIVE_CAPABILITY', `metadata.privilege.permissionWithReason.${key}`);
  }
  const permissionWithReason = Object.fromEntries(Object.entries(capabilities).map(([key, value]) => {
    if (value === null && ['move', 'manageAdvancedPermission'].includes(key)) return [key, null];
    if (!object(value) || typeof value.hasPermission !== 'boolean' || typeof value.reasonCode !== 'string' || sensitive.test(key)) {
      issue('MALFORMED_EFFECTIVE_CAPABILITY', `metadata.privilege.permissionWithReason.${key}`);
      return [key, sensitive.test(key) ? shape(value) : sanitize(value, `metadata.privilege.permissionWithReason.${key}`)];
    }
    return [key, sanitize(value, `metadata.privilege.permissionWithReason.${key}`)];
  }));
  if (capabilities.seeCollaborators?.hasPermission !== true) issue('COLLABORATOR_VIEW_HIDDEN_OR_UNKNOWN', 'metadata.privilege.permissionWithReason.seeCollaborators');
  const effective = object(privilege) ? {
    ...sanitize(Object.fromEntries(Object.entries(privilege).filter(([key]) => key !== 'permissionWithReason')), 'metadata.privilege'),
    permissionWithReason,
  } : null;
  const sources = {};
  let cancelled = false;
  for (const [name, suffix] of [['permission', '/permission'], ['ancestors', '/ancestors/permission?flattenInherit=true']]) {
    const path = `/api/file/files/${id}${suffix}`;
    try {
      if (cancelled || options.signal?.aborted) throw new AppError('REQUEST_CANCELLED', 'Permission inspection was cancelled.');
      if (typeof file.fileClusterApiPrefix !== 'string' || !file.fileClusterApiPrefix) throw new AppError('FILE_ROUTE_UNAVAILABLE', 'Document metadata has no file route.');
      const response = await session.request(path, { method: 'GET', base: file.fileClusterApiPrefix });
      sources[name] = { status: 'received', method: 'GET', path, data: sanitize(response, name) };
      if (name === 'permission') checkPermission(response, name);
      else {
        if (!object(response) || !Array.isArray(response.ancestorPermissionInfos)) { issue('MALFORMED_ANCESTORS', name); continue; }
        for (const key of Object.keys(response)) if (key !== 'ancestorPermissionInfos') issue('UNKNOWN_ANCESTOR_SOURCE_FIELD', `${name}.${key}`);
        const seen = new Set();
        for (const [index, ancestor] of response.ancestorPermissionInfos.entries()) {
          const at = `${name}.ancestorPermissionInfos[${index}]`;
          if (!object(ancestor) || typeof ancestor.id !== 'string') { issue('MALFORMED_ANCESTOR', at); continue; }
          if (seen.has(ancestor.id)) issue('DUPLICATE_ANCESTOR', at);
          seen.add(ancestor.id);
          if (typeof ancestor.supportPermissionSetting !== 'boolean' || typeof ancestor.fileType !== 'string') issue('MALFORMED_ANCESTOR', at);
          if (!['doc', 'space'].includes(ancestor.fileType)) issue('UNVERIFIED_ANCESTOR_TYPE', at);
          if (ancestor.canSeeCollaborators === false) issue('COLLABORATOR_VIEW_HIDDEN', at);
          if (ancestor.permissionInfo != null) {
            checkPermission(ancestor.permissionInfo, `${at}.permissionInfo`);
            if (ancestor.canSeeCollaborators !== true) issue('COLLABORATOR_VISIBILITY_UNKNOWN', at);
          } else if (ancestor.supportPermissionSetting !== false) issue('MISSING_ANCESTOR_PERMISSION_INFO', at);
          if (ancestor.id !== id && ancestor.supportPermissionSetting !== false) issue('NESTED_INHERITANCE_UNVERIFIED', at);
        }
        if (!seen.has(id)) issue('CURRENT_FILE_MISSING_FROM_ANCESTORS', name);
        if (typeof file.parentId === 'string' && file.parentId && !seen.has(file.parentId)) issue('EXPECTED_PARENT_NOT_VISIBLE', name);
      }
    } catch (error) {
      cancelled = error.code === 'REQUEST_CANCELLED' || error.name === 'AbortError';
      if (cancelled && !options.preservePartialOnCancel) throw error;
      sources[name] = { status: cancelled ? 'cancelled' : 'failed', method: 'GET', path,
        code: cancelled ? 'REQUEST_CANCELLED' : typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'REQUEST_FAILED',
        ...(Number.isSafeInteger(error.details?.attempts) && error.details.attempts > 0 ? { attempts: error.details.attempts } : {}),
        ...(Number.isSafeInteger(error.details?.retryAfterMs) && error.details.retryAfterMs >= 0 ? { retryAfterMs: error.details.retryAfterMs } : {}),
        ...(Number.isInteger(error.details?.status) && error.details.status >= 100 && error.details.status <= 599 ? { httpStatus: error.details.status } : {}) };
      issue(cancelled ? 'PERMISSION_SOURCE_REQUEST_CANCELLED' : 'PERMISSION_SOURCE_REQUEST_FAILED', name);
    }
  }
  if (typeof file.parentId !== 'string' || !file.parentId) issue('PARENT_METADATA_UNAVAILABLE', 'metadata.parentId');
  return {
    file: { id, type: file.fileType, parentId: file.parentId ?? null, ownerId: file.owner?.ownerId ?? file.ownerId ?? null },
    scope: 'visible-document-permissions', atomic: false, effective, sources,
    coverage: { status: issues.length ? 'incomplete' : 'complete', complete: issues.length === 0, atomic: false,
      scope: 'supported-visible-permission-documents', serverExhaustivenessVerified: false, issues,
      support: 'Observed root-Doc user grants and current-source sharing fields; non-user and populated meeting/wiki grants are preserved but unverified. No synthesized ancestors or inferred link grants.',
      linkAvailabilityIsGrant: false },
  };
}

function blockText(block) {
  const value = block.content?.title;
  if (block.type === 'BLOCK_TYPE_PAGE') return typeof value === 'string' ? value : '';
  if (typeof value !== 'string') return null;
  try {
    const runs = JSON.parse(value);
    if (!Array.isArray(runs) || !runs.every(run => Array.isArray(run) && run[0] === 0 && typeof run[1] === 'string')) return null;
    return runs.map(run => run[1]).join('');
  } catch { return null; }
}

function decodePageContent(response) {
  const envelope = response?.content;
  const wrapper = envelope && typeof envelope === 'object' && !Array.isArray(envelope) ? 'content' : 'missing';
  const data = envelope?.data;
  const gzip = envelope?.gzip === true;
  const evidence = {
    wrapper,
    encoding: gzip ? 'base64+gzip+utf8+json' : 'base64+utf8+json',
    gzip,
    encodedLength: typeof data === 'string' ? data.length : null,
    encodedSha256: typeof data === 'string' ? createHash('sha256').update(data).digest('hex') : null,
  };
  if (typeof data !== 'string' || !data.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Docs returned an unrecognized page envelope.', { diagnostic: 'INVALID_PAGE_ENVELOPE', evidence });
  }
  try {
    const bytes = Buffer.from(data, 'base64');
    const json = (gzip ? gunzipSync(bytes) : bytes).toString('utf8');
    return { decoded: JSON.parse(json), evidence: { ...evidence, decodedLength: Buffer.byteLength(json) } };
  } catch {
    throw new AppError('UNSUPPORTED_CONTENT', 'Docs returned an unrecognized page encoding.', { diagnostic: 'PAGE_DECODE_FAILED', evidence });
  }
}

export async function readPage(session, id, file) {
  file ??= await metadata(session, id);
  const response = await session.request(`/api/page/${id}/content?returnEncodedData=true&fileId=${id}`, { base: file.fileClusterApiPrefix });
  const { decoded, evidence } = decodePageContent(response);
  const blocks = decoded?.blocks;
  if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks) || blocks[id]?.id !== id || !Number.isInteger(blocks[id].version)) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Docs did not return the requested page root.',
      { diagnostic: 'PAGE_ROOT_UNRECOGNIZED', evidence });
  }
  return { file, blocks, root: blocks[id], decodeEvidence: evidence };
}

function pageSummary(page) {
  const { file, blocks, root } = page;
  const children = new Map();
  for (const block of Object.values(blocks)) {
    if (block.id === root.id) continue;
    const siblings = children.get(block.parentId) ?? [];
    siblings.push(block); children.set(block.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);
  const ordered = [];
  const visited = new Set([root.id]);
  function visit(parentId) {
    for (const block of children.get(parentId) ?? []) {
      if (visited.has(block.id)) throw new AppError('UNSUPPORTED_CONTENT', 'Cyclic document block tree.');
      visited.add(block.id);
      ordered.push({ id: block.id, parentId: block.parentId, type: block.type, version: block.version, text: blockText(block), content: block.content });
      visit(block.id);
    }
  }
  visit(root.id);
  return { file: fileSummary(file), pageId: root.id, version: root.version, title: blockText(root), text: ordered.map(block => block.text ?? '').join('\n'), blocks: ordered, scope: 'single-page', unrenderedBlockIds: ordered.filter(block => block.text === null).map(block => block.id) };
}

// Read coverage is deliberately narrower than the editor's complete block schema.
// Current client + authorized 2026-09-06 fixture: insert tuples, 8/9/26 attributes,
// link.source links/doc mentions, and the block types below. Raw data is retained.
const readableBlockTypes = new Set(['PAGE', 'PARAGRAPH', 'HEADING1', 'BULLET', 'TABLE', 'TABLE_ROW', 'TABLE_COL', 'TABLE_CELL'].map(type => `BLOCK_TYPE_${type}`));

function richTitle(block, files, issues) {
  const value = block.content?.title;
  const issue = (reason, extra = {}) => issues.push({ blockId: block.id, reason, ...extra });
  if (block.type === 'BLOCK_TYPE_PAGE') {
    if (typeof value !== 'string') issue('MALFORMED_PAGE_TITLE');
    return { text: typeof value === 'string' ? value : '', runs: [] };
  }
  let tuples;
  try { tuples = JSON.parse(value); } catch { issue('MALFORMED_TITLE'); return { text: '', runs: [] }; }
  if (!Array.isArray(tuples)) { issue('MALFORMED_TITLE'); return { text: '', runs: [] }; }
  const runs = tuples.map((tuple, index) => {
    const run = { raw: tuple, text: '', attributes: {} };
    if (!Array.isArray(tuple) || tuple[0] !== 0 || tuple.length < 2 || tuple.length > 3) {
      issue('UNSUPPORTED_TUPLE', { index });
      return run;
    }
    run.packedAttrs = tuple[2];
    if (tuple[2] !== undefined) {
      // JSON strings can contain "|" so split only at an attribute-key boundary.
      if (typeof tuple[2] !== 'string') issue('MALFORMED_ATTRIBUTES', { index });
      else for (const attr of tuple[2].split(/\|(?=\d+:)/)) {
        const match = /^(\d+):([\s\S]*)$/.exec(attr);
        let decoded;
        try { if (!match) throw new Error(); decoded = JSON.parse(match[2]); }
        catch { issue('MALFORMED_ATTRIBUTES', { index, raw: attr }); continue; }
        if (match[1] === '8' && decoded === 1) run.attributes.bold = true;
        else if (match[1] === '9' && decoded === 1) run.attributes.italic = true;
        else if (match[1] === '26' && typeof decoded === 'string') run.attributes.authorId = decoded;
        else issue('UNSUPPORTED_ATTRIBUTE', { index, raw: attr });
      }
    }
    if (typeof tuple[1] === 'string') run.text = tuple[1];
    else {
      const source = tuple[1]?.link?.source;
      if (source?.type === 'link' && typeof source.text === 'string' && typeof source.link === 'string') {
        run.text = source.text; run.link = source.link;
      } else if (source?.type === 'mention' && source.mentionType === 'doc' && typeof source.guid === 'string') {
        run.mention = { type: 'doc', id: source.guid };
        const title = files.get(source.guid)?.title;
        if (typeof title === 'string') run.text = title;
        else { run.text = `[doc:${source.guid}]`; issue('UNRESOLVED_DOC_MENTION', { index, id: source.guid }); }
      } else { run.text = '[unsupported embed]'; issue('UNSUPPORTED_EMBED', { index }); }
    }
    return run;
  });
  return { text: runs.map(run => run.text).join(''), runs };
}

function treePageSummary(page, files) {
  const { file, root, blocks } = page;
  const issues = [], records = [], byId = new Map(), children = new Map();
  for (const [key, raw] of Object.entries(blocks)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      records.push({ key, raw }); issues.push({ key, reason: 'MALFORMED_BLOCK' }); continue;
    }
    const record = { ...raw, key, ...richTitle(raw, files, issues), childIds: [] };
    records.push(record);
    if (typeof raw.id !== 'string' || raw.id !== key || byId.has(raw.id)) {
      issues.push({ key, blockId: raw.id, reason: 'MALFORMED_OR_DUPLICATE_ID' }); continue;
    }
    byId.set(raw.id, record);
    if (!readableBlockTypes.has(raw.type)) issues.push({ blockId: raw.id, reason: 'UNSUPPORTED_BLOCK_TYPE', type: raw.type });
    if (typeof raw.seq !== 'string') issues.push({ blockId: raw.id, reason: 'MALFORMED_SEQ' });
    if (raw.id !== root.id) {
      if (typeof raw.parentId !== 'string') issues.push({ blockId: raw.id, reason: 'MALFORMED_PARENT' });
      const siblings = children.get(raw.parentId) ?? [];
      siblings.push(record); children.set(raw.parentId, siblings);
    }
  }
  for (const [parentId, siblings] of children) {
    siblings.sort((a, b) => a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);
    const seqs = new Set();
    for (const sibling of siblings) {
      if (typeof sibling.seq === 'string' && seqs.has(sibling.seq)) issues.push({ blockId: sibling.id, parentId, reason: 'DUPLICATE_SEQ', seq: sibling.seq });
      seqs.add(sibling.seq);
      if (!byId.has(parentId)) issues.push({ blockId: sibling.id, parentId, reason: 'ORPHAN_BLOCK' });
    }
  }
  for (const record of byId.values()) {
    if (record.type !== 'BLOCK_TYPE_TABLE') continue;
    const tableChildren = children.get(record.id) ?? [];
    const columns = tableChildren.filter(child => child.type === 'BLOCK_TYPE_TABLE_COL');
    const rows = tableChildren.filter(child => child.type === 'BLOCK_TYPE_TABLE_ROW');
    if (columns.length + rows.length !== tableChildren.length) issues.push({ blockId: record.id, reason: 'UNVERIFIED_TABLE_LAYOUT' });
    for (const row of rows) {
      const cells = children.get(row.id) ?? [];
      if (cells.length !== columns.length || cells.some((cell, index) =>
        cell.type !== 'BLOCK_TYPE_TABLE_CELL' || cell.style?.columnId !== columns[index]?.id
        || cell.style?.rowspan !== 1 || cell.style?.colspan !== 1)) {
        issues.push({ blockId: row.id, reason: 'UNVERIFIED_TABLE_LAYOUT' });
      }
    }
  }
  const visited = new Set(), ordered = [];
  const hierarchy = byId.get(root.id);
  // Iterative traversal avoids overflowing on deeply nested or malformed blocks.
  const stack = hierarchy ? [hierarchy] : [];
  while (stack.length) {
    const record = stack.pop();
    if (visited.has(record.id)) { issues.push({ blockId: record.id, reason: 'BLOCK_CYCLE_OR_DUPLICATE' }); continue; }
    visited.add(record.id);
    ordered.push(record);
    const descendants = children.get(record.id) ?? [];
    record.childIds = descendants.map(child => child.id);
    for (let index = descendants.length - 1; index >= 0; index--) stack.push(descendants[index]);
  }
  const unreachableBlocks = records.filter(record => !visited.has(record.id) || byId.get(record.id) !== record);
  const unreachableBlockIds = unreachableBlocks.map(record => record.id ?? record.key);
  for (const id of unreachableBlockIds) issues.push({ blockId: id, reason: 'UNREACHABLE_BLOCK' });
  return {
    file: { ...fileSummary(file), isRootPage: file.isRootPage, hasChildren: file.hasChildren },
    pageId: root.id, version: root.version, title: hierarchy?.text ?? '',
    text: ordered.filter(record => record.id !== root.id && record.text !== '').map(record => record.text).join('\n'),
    blocks: ordered, unreachableBlocks, decodeEvidence: page.decodeEvidence,
    coverage: { status: issues.length ? 'incomplete' : 'complete', complete: issues.length === 0, issues, unreachableBlockIds },
  };
}

async function readDocumentTree(session, id) {
  const files = new Map(), loaded = [], visited = new Set(), unread = new Set(), issues = [], discoveries = [];
  const pending = [{ id, parentId: null }];
  let attempts = 0;
  while (pending.length && attempts < 100) {
    const next = pending.pop();
    if (visited.has(next.id)) { issues.push({ id: next.id, reason: 'PAGE_CYCLE_OR_DUPLICATE' }); continue; }
    visited.add(next.id); attempts++;
    let file;
    try {
      file = await metadata(session, next.id);
      files.set(next.id, file);
      if (next.parentId !== null && file.parentId !== next.parentId) issues.push({ id: next.id, reason: 'FILE_PARENT_CHANGED', expectedParentId: next.parentId, parentId: file.parentId });
      loaded.push(await readPage(session, next.id, file));
    } catch (error) {
      const failure = { id: next.id, reason: error.code ?? 'PAGE_READ_FAILED',
        diagnostic: error.details?.diagnostic ?? null, opaqueEvidence: error.details?.evidence ?? null };
      if (next.parentId === null && !error.details?.diagnostic) throw error;
      if (next.parentId === null) {
        throw new AppError(error.code ?? 'PAGE_READ_FAILED', 'No document pages could be decoded.', {
          operation: 'docs.read', phase: 'page-decode', decodedPageCount: 0, zeroDecoded: true, failure,
        });
      }
      unread.add(next.id); issues.push({ ...failure, descendantsUnknown: !file });
    }
    if (!file) continue;
    try {
      const response = await session.request('/api/file/files/action/batch_get_children', {
        method: 'POST', safeRead: true, base: file.fileClusterApiPrefix,
        body: { parentIds: [next.id], accountId: session.identity.user.accountId },
      });
      const matches = Array.isArray(response.successItems) ? response.successItems.filter(item => item?.parentId === next.id) : [];
      if (response.failureItems?.length) issues.push({ id: next.id, reason: 'CHILD_DISCOVERY_FAILURES', failures: response.failureItems, descendantsUnknown: true });
      if (matches.length !== 1 || !Array.isArray(matches[0].children)) throw new AppError('UNSUPPORTED_CHILDREN', 'Unrecognized child listing.');
      const children = matches[0].children;
      discoveries.push({ parentId: next.id, children: children.map(child => child && typeof child === 'object' ? fileSummary(child) : { malformed: true }) });
      const supported = [];
      for (const child of children) {
        if (!child || typeof child.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(child.id)) {
          issues.push({ parentId: next.id, reason: 'MALFORMED_CHILD', child, descendantsUnknown: true }); continue;
        }
        if (child.fileType !== 'doc') {
          unread.add(child.id); issues.push({ id: child.id, parentId: next.id, reason: 'UNSUPPORTED_FILE_TYPE', fileType: child.fileType, descendantsUnknown: true }); continue;
        }
        supported.push({ id: child.id, parentId: next.id });
      }
      pending.push(...supported.reverse());
    } catch (error) {
      issues.push({ id: next.id, reason: 'CHILD_DISCOVERY_FAILED', code: error.code ?? 'REQUEST_FAILED', descendantsUnknown: true });
    }
  }
  for (const next of pending) if (!visited.has(next.id)) unread.add(next.id);
  if (pending.length) issues.push({ reason: 'PAGE_LIMIT', limit: 100, descendantsUnknown: true });
  const pages = loaded.map(page => treePageSummary(page, files));
  const root = pages.find(page => page.pageId === id);
  const complete = issues.length === 0 && pages.every(page => page.coverage.complete);
  return {
    file: root?.file ?? fileSummary(files.get(id)), rootPageId: id,
    scope: 'document-tree', atomic: false, pages, discoveries,
    text: pages.map(page => [page.title, page.text].filter(Boolean).join('\n')).join('\n\n'),
    coverage: { status: complete ? 'complete' : 'incomplete', complete, atomic: false, pageLimit: 100,
      decodedPageCount: pages.length, loadedPageIds: pages.map(page => page.pageId), unreadPageIds: [...unread],
      incompletePageIds: pages.filter(page => !page.coverage.complete).map(page => page.pageId), issues,
      support: 'Observed doc files with plain and gzip encoded page envelopes and insert-only compact titles; opaque decode evidence and raw unsupported block data retained. Streaming, page-file, and database routing remain unsupported.' },
  };
}

async function append(session, id, text, options = {}, page) {
  const context = { operation: 'docs.append', documentId: id, transactionId: randomUUID(), requestId: randomUUID(), clientId: randomUUID() };
  let submitted = false, accepted = false;
  try {
    page ??= await readPage(session, id);
    if (page.file.privilege?.permissionWithReason?.edit?.hasPermission !== true) throw new AppError('FORBIDDEN', 'This session cannot edit the document.');
    if (options['if-version'] !== undefined && Number(options['if-version']) !== page.root.version) {
      throw new AppError('VERSION_CONFLICT', 'The page changed since the supplied version. Read it again before editing.',
        { expectedVersion: Number(options['if-version']), actualVersion: page.root.version });
    }
    const children = Object.values(page.blocks).filter(block => block.parentId === id).sort((a, b) => a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);
    const target = options.block ? page.blocks[options.block] : children.at(-1);
    if (!target) throw new AppError('TARGET_NOT_FOUND', 'The requested paragraph is not present on this page.');
    const before = blockText(target);
    const plainRuns = target.type === 'BLOCK_TYPE_PARAGRAPH' && before !== null ? JSON.parse(target.content.title) : null;
    if (target.type !== 'BLOCK_TYPE_PARAGRAPH' || target.parentId !== id || before === null
      || !plainRuns.every(run => run.length <= 3 && (run[2] === undefined || run[2] === '' || /^26:"[A-Za-z0-9_-]+"$/.test(run[2])))
      || Object.values(page.blocks).some(block => block.parentId === target.id)) {
      throw new AppError('UNSUPPORTED_EDIT', 'Append requires a plain-text top-level paragraph without child blocks. No content changed.');
    }
    Object.assign(context, { blockId: target.id, baseVersion: page.root.version });
    const inserted = before ? `\n${text}` : text;
    const delta = [];
    if (before.length) delta.push([2, before.length]);
    delta.push([0, inserted, `26:${JSON.stringify(session.identity.user.userId)}`]);
    submitted = true;
    await session.request(`/api/block/transactions?fileId=${id}`, {
      method: 'POST', base: page.file.fileClusterApiPrefix,
      body: { reqId: context.requestId, clientId: context.clientId, baseVersion: context.baseVersion,
        transactions: [{ id: context.transactionId, ops: [{ command: 'COMMAND_TYPE_UPDATE', blockId: target.id, args: { delta: JSON.stringify(delta) } }] }],
        extra: { fromFileId: id } },
    });
    accepted = true;
    let readbackError;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const after = await readPage(session, id, page.file);
        if (!after.blocks[target.id]) throw new AppError('TARGET_CHANGED', 'The submitted target block is no longer present.');
        const actual = blockText(after.blocks[target.id]);
        if (actual !== null && actual.startsWith(before + inserted)) {
          return { ...pageSummary(after), ...context, outcome: 'confirmed', verified: true,
            verification: 'intended-text-prefix', additionalText: actual.length > before.length + inserted.length };
        }
        readbackError = new AppError('READBACK_MISMATCH', 'The intended text prefix is not present; concurrent changes may have occurred.');
      } catch (error) { readbackError = error; }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw readbackError;
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }, accepted ? 'unknown' : submitted ? undefined : 'not_sent');
  }
}

async function insertParagraph(session, id, options) {
  const context = { operation: 'docs.insert', documentId: id, blockId: randomUUID().replaceAll('-', ''),
    transactionId: randomUUID(), requestId: randomUUID(), clientId: randomUUID(), afterBlockId: options.after };
  let submitted = false, accepted = false;
  try {
    if (typeof options.text !== 'string' || !options.text.trim()) throw new AppError('INVALID_INPUT', 'Supply non-empty paragraph text.');
    const page = await readPage(session, id);
    if (page.file.privilege?.permissionWithReason?.edit?.hasPermission !== true) throw new AppError('FORBIDDEN', 'This session cannot edit the document.');
    if (options['if-version'] !== undefined && Number(options['if-version']) !== page.root.version) {
      throw new AppError('VERSION_CONFLICT', 'The page changed before insertion.', { expectedVersion: Number(options['if-version']), actualVersion: page.root.version });
    }
    const anchor = page.blocks[options.after];
    if (!anchor || anchor.parentId !== id) throw new AppError('UNSUPPORTED_EDIT', 'Insert requires an existing top-level block as --after; nested insertion is unsupported.');
    context.baseVersion = page.root.version;
    const title = JSON.stringify([[0, options.text, `26:${JSON.stringify(session.identity.user.userId)}`]]);
    submitted = true;
    await session.request(`/api/block/transactions?fileId=${id}`, {
      method: 'POST', base: page.file.fileClusterApiPrefix,
      body: { reqId: context.requestId, clientId: context.clientId, baseVersion: context.baseVersion,
        transactions: [{ id: context.transactionId, ops: [{ command: 'COMMAND_TYPE_CREATE', blockId: context.blockId,
          args: { type: 'BLOCK_TYPE_PARAGRAPH', content: { title }, style: {}, parentBlockId: id, afterBlockId: anchor.id } }] }],
        extra: { fromFileId: id } },
    });
    accepted = true;
    let readbackError;
    const originals = Object.values(page.blocks).filter(block => block.id !== id);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const after = await readPage(session, id, page.file), block = after.blocks[context.blockId];
        const siblings = Object.values(after.blocks).filter(block => block.parentId === id)
          .sort((a, b) => a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);
        const anchorIndex = siblings.findIndex(block => block.id === anchor.id);
        const unchanged = originals.every(before => {
          const current = after.blocks[before.id];
          return current?.type === before.type && current.parentId === before.parentId
            && isDeepStrictEqual(current.content, before.content) && isDeepStrictEqual(current.style, before.style);
        });
        if (block?.type === 'BLOCK_TYPE_PARAGRAPH' && block.parentId === id && blockText(block) === options.text
          && anchorIndex >= 0 && siblings[anchorIndex + 1]?.id === context.blockId && unchanged) {
          return { ...context, file: fileSummary(page.file), pageId: id, version: after.root.version, block,
            outcome: 'confirmed', acceptance: 'accepted', verified: true, atomic: false,
            verification: 'exact-new-paragraph-adjacency-and-existing-content-style', existingBlocksUnchanged: true };
        }
        readbackError = new AppError('READBACK_MISMATCH', 'New paragraph, adjacency or unchanged existing content/style was not confirmed; inspect returned block ID before retrying.');
      } catch (error) { readbackError = error; }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw readbackError;
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' },
      accepted ? 'unknown' : submitted ? undefined : 'not_sent');
  }
}

async function replaceParagraph(session, id, options) {
  const context = { operation: 'docs.replace', documentId: id, blockId: options.block,
    transactionId: randomUUID(), requestId: randomUUID(), clientId: randomUUID() };
  let submitted = false, accepted = false;
  try {
    if (!options.block || typeof options.text !== 'string' || !options.text.trim()
      || options['if-version'] === undefined || !Number.isSafeInteger(Number(options['if-version'])) || Number(options['if-version']) < 0) {
      throw new AppError('INVALID_INPUT', 'Replace requires --block, non-empty --text and an explicit nonnegative --if-version.');
    }
    const page = await readPage(session, id);
    if (page.file.privilege?.permissionWithReason?.edit?.hasPermission !== true) throw new AppError('FORBIDDEN', 'This session cannot edit the document.');
    if (Number(options['if-version']) !== page.root.version) {
      throw new AppError('VERSION_CONFLICT', 'The page changed before replacement.', { expectedVersion: Number(options['if-version']), actualVersion: page.root.version });
    }
    const target = page.blocks[options.block], before = target && blockText(target);
    const runs = target?.type === 'BLOCK_TYPE_PARAGRAPH' && before !== null ? JSON.parse(target.content.title) : null;
    if (!runs || target.parentId !== id
      || !runs.every(run => run.length <= 3 && (run[2] === undefined || run[2] === '' || /^26:"[A-Za-z0-9_-]+"$/.test(run[2])))
      || Object.keys(target.content).some(key => key !== 'title')
      || Object.values(page.blocks).some(block => block.parentId === target.id)) {
      throw new AppError('UNSUPPORTED_EDIT', 'Replace requires an existing plain-text top-level paragraph without child blocks or rich content.');
    }
    context.baseVersion = page.root.version;
    // Current native replacement inserts first, then removes UTF-16 code units (including surrogate pairs).
    const delta = [[0, options.text, `26:${JSON.stringify(session.identity.user.userId)}`]];
    if (before.length) delta.push([1, before.length]);
    submitted = true;
    await session.request(`/api/block/transactions?fileId=${id}`, {
      method: 'POST', base: page.file.fileClusterApiPrefix,
      body: { reqId: context.requestId, clientId: context.clientId, baseVersion: context.baseVersion,
        transactions: [{ id: context.transactionId, ops: [{ command: 'COMMAND_TYPE_UPDATE', blockId: target.id, args: { delta: JSON.stringify(delta) } }] }],
        extra: { fromFileId: id } },
    });
    accepted = true;
    let readbackError;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const after = await readPage(session, id, page.file), actual = after.blocks[target.id];
        const unchanged = Object.keys(after.blocks).length === Object.keys(page.blocks).length
          && Object.values(page.blocks).every(block => {
            const current = after.blocks[block.id];
            return current?.type === block.type && current.parentId === block.parentId && current.seq === block.seq
              && isDeepStrictEqual(current.style, block.style)
              && (block.id === target.id || isDeepStrictEqual(current.content, block.content));
          });
        if (actual && blockText(actual) === options.text && unchanged) {
          return { ...context, file: fileSummary(page.file), pageId: id, version: after.root.version, block: actual,
            outcome: 'confirmed', acceptance: 'accepted', verified: true, atomic: false,
            verification: 'exact-paragraph-and-unchanged-neighbor-content-order-style', existingBlocksUnchanged: true };
        }
        readbackError = new AppError('READBACK_MISMATCH', 'Exact replacement and unchanged neighboring content/order/style were not confirmed; inspect operation IDs before retrying.');
      } catch (error) { readbackError = error; }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw readbackError;
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' },
      accepted ? 'unknown' : submitted ? undefined : 'not_sent');
  }
}

const commentReadEffects = {
  explicitReadMarkerSent: false, neutralityVerified: false,
  note: 'The native client separately posts /api/notification/file/read on comment consumption/resolution. These readers do not send that marker; server-side read effects are not guaranteed absent.',
};

function commentOptions(options) {
  const limit = Number(options.limit ?? 30), status = options.status ?? 'open';
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['open', 'resolved'].includes(status)) {
    throw new AppError('INVALID_INPUT', 'Comments require --limit 1..100 and --status open|resolved.');
  }
  return { limit, status };
}

function inlineCommentAnchors(page) {
  const anchors = new Map(), unsupportedBlockIds = [];
  for (const block of Object.values(page.blocks)) {
    if (block.id === page.root.id) continue;
    let runs;
    try { runs = JSON.parse(block.content?.title); } catch { unsupportedBlockIds.push(block.id); continue; }
    if (!Array.isArray(runs)) { unsupportedBlockIds.push(block.id); continue; }
    let offset = 0;
    for (const run of runs) {
      if (!Array.isArray(run) || run[0] !== 0 || typeof run[1] !== 'string') {
        unsupportedBlockIds.push(block.id); offset = null; continue;
      }
      if (typeof run[2] === 'string') {
        for (const match of run[2].matchAll(/(?:^|\|)thread-([A-Za-z0-9_-]{1,128}):true(?=\||$)/g)) {
          const ranges = anchors.get(match[1]) ?? [];
          ranges.push({ blockId: block.id, offset, length: run[1].length, units: 'UTF-16', text: run[1], rawAttributes: run[2] });
          anchors.set(match[1], ranges);
        }
      }
      if (offset !== null) offset += run[1].length;
    }
  }
  return { anchors, unsupportedBlockIds: [...new Set(unsupportedBlockIds)] };
}

function commentMentions(content) {
  if (!content || typeof content.text !== 'string' || Object.keys(content).some(key => !['text', 'doc'].includes(key))) return null;
  if (!Object.hasOwn(content, 'doc')) return [];
  if (!Array.isArray(content.doc)) return null;
  const mentions = [], parts = [];
  let offset = 0;
  for (const [index, block] of content.doc.entries()) {
    if (!block || block.type !== 'BLOCK_TYPE_PARAGRAPH' || !Array.isArray(block.content)
      || Object.keys(block).some(key => !['type', 'content', 'children'].includes(key))
      || (block.children !== undefined && (!Array.isArray(block.children) || block.children.length))) return null;
    if (index) { parts.push('\n'); offset++; }
    for (const run of block.content) {
      if (!run || Object.keys(run).some(key => key !== 'data')) return null;
      if (typeof run.data === 'string') {
        parts.push(run.data); offset += run.data.length;
        continue;
      }
      const person = run.data?.person;
      if (!person || Object.keys(run.data).some(key => key !== 'person')
        || Object.keys(person).some(key => !['mentionId', 'userId', 'name', 'notify'].includes(key))
        || typeof person.name !== 'string' || typeof person.notify !== 'boolean'
        || typeof person.userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(person.userId)
        || typeof person.mentionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(person.mentionId)) return null;
      mentions.push({ ...person, offset, length: person.name.length, units: 'UTF-16' });
      parts.push(person.name); offset += person.name.length;
    }
  }
  return parts.join('') === content.text ? mentions : null;
}

function notificationMentionInfo(context) {
  const key = Array.isArray(context?.commentContentElements) ? 'commentContentElements'
    : Array.isArray(context?.contextElements) ? 'contextElements' : null;
  if (!key) return undefined;
  const elements = context[key], runs = [], persons = [], text = [];
  for (const element of elements) {
    if (typeof element === 'string') {
      runs.push({ data: element }); text.push(element); continue;
    }
    if (!element || typeof element !== 'object' || Array.isArray(element) || typeof element.text !== 'string') return null;
    if (element.type !== undefined && typeof element.type !== 'string') return null;
    if (element.type !== 'person') {
      runs.push({ data: element.text }); text.push(element.text); continue;
    }
    const candidates = [element.person, element.data?.person, element.data, element.meta?.person, element.meta, element]
      .filter(value => value && typeof value === 'object' && !Array.isArray(value));
    const source = candidates.find(value => Object.hasOwn(value, 'mentionId')
      || Object.hasOwn(value, 'userId') || Object.hasOwn(value, 'notify') || Object.hasOwn(value, 'name')) ?? {};
    const person = { mentionId: source.mentionId, userId: source.userId,
      name: source.name ?? element.text, notify: source.notify };
    runs.push({ data: { person } }); persons.push(element); text.push(person.name);
  }
  const mentions = commentMentions({ text: text.join(''),
    doc: [{ type: 'BLOCK_TYPE_PARAGRAPH', content: runs }] });
  if (mentions === null) return null;
  return mentions.map((mention, index) => {
    const element = persons[index], sources = [element, element.meta].filter(value => value && typeof value === 'object');
    const range = sources.find(value => Number.isSafeInteger(value.offset) && value.offset >= 0
      && Number.isSafeInteger(value.length) && value.length >= 0
      && (value.units === undefined || value.units === 'UTF-16'));
    return range ? { ...mention, offset: range.offset, length: range.length, units: 'UTF-16' } : mention;
  });
}

function commentAttachments(value) {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') return null;
  let items;
  try { items = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(items) || items.length > 10) return null;
  const ids = new Set(), assets = new Set();
  for (const item of items) {
    if (!item || Object.keys(item).some(key => !['id', 'name', 'size', 'type', 'attachmentId', 'width', 'height'].includes(key))
      || typeof item.id !== 'string' || typeof item.attachmentId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || !/^[A-Za-z0-9_-]{1,128}$/.test(item.attachmentId)
      || typeof item.name !== 'string' || !item.name || /[\0\r\n]/.test(item.name)
      || !Number.isSafeInteger(item.size) || item.size < 1
      || !['application/octet-stream', 'text/plain', 'image/png'].includes(item.type)
      || (item.type === 'image/png' ? !Number.isSafeInteger(item.width) || item.width < 1 || !Number.isSafeInteger(item.height) || item.height < 1
        : item.width !== undefined || item.height !== undefined)
      || ids.has(item.id) || assets.has(item.attachmentId)) return null;
    ids.add(item.id); assets.add(item.attachmentId);
  }
  return items;
}

function nativeComment(row, users, threadId) {
  const comment = row?.comment;
  if (!comment || typeof comment.commentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(comment.commentId)
    || comment.threadId !== threadId) throw new AppError('UNSUPPORTED_RESPONSE', 'Comment identity does not match the requested thread.');
  let content = null;
  try { content = JSON.parse(comment.content); } catch {}
  const mentions = commentMentions(content), attachmentItems = commentAttachments(comment.attachments);
  const supported = mentions !== null && attachmentItems !== null && !comment.parentComment;
  const unsupported = [
    ...(mentions === null ? ['UNSUPPORTED_COMMENT_RICH_CONTENT_OR_MENTIONS'] : []),
    ...(attachmentItems === null ? ['UNSUPPORTED_COMMENT_ATTACHMENT_METADATA'] : []),
    ...(comment.parentComment ? ['UNINTERPRETED_PARENT_COMMENT_REFERENCE'] : []),
  ];
  return { ...comment, id: comment.commentId, text: typeof content?.text === 'string' ? content.text : null,
    body: { text: typeof content?.text === 'string' ? content.text : null, format: 'native-comment-json', raw: comment.content },
    createdAt: nativeTime(comment.createAt), updatedAt: nativeTime(comment.modifyAt),
    structuredContent: content, mentions: mentions?.map(mention => ({ ...mention, scope: 'direct',
      notificationExpectation: mention.notify ? 'requested-not-delivery-proof' : 'not-requested' })) ?? null,
    attachmentItems, author: users?.[comment.createdBy] ?? null, reactions: row.reactions ?? null,
    coverage: { complete: supported, format: supported ? attachmentItems.length ? 'native-text-mentions-and-file-metadata' : content.doc ? 'native-text-and-person-mentions' : 'native-plain-text' : 'raw-preserved',
      attachmentBytesVerified: false, unsupported } };
}

function nativeThread(row, users, page, anchors, status) {
  const thread = row?.thread;
  if (!thread || typeof thread.threadId !== 'string' || thread.fileId !== page.root.id
    || thread.rootBlockId !== page.root.id || thread.threadStatus !== status) {
    throw new AppError('UNSUPPORTED_RESPONSE', 'Thread page identity or requested status does not match.');
  }
  const ranges = anchors.get(thread.threadId) ?? [];
  return { ...thread, id: thread.threadId, author: users?.[thread.createdBy] ?? null,
    createdAt: nativeTime(thread.createAt), updatedAt: nativeTime(thread.modifyAt), state: thread.threadStatus,
    selectedText: typeof thread.selectContent === 'string' ? thread.selectContent : null,
    anchor: { supported: thread.commentType === 1 ? ranges.length > 0 && ranges.every(range => range.offset !== null) : [2, 3].includes(thread.commentType),
      kind: thread.commentType === 1 ? 'inline-text' : thread.commentType === 2 ? 'whole-page' : thread.commentType === 3 ? 'unanchored-discussion' : 'native-unknown',
      ranges, nativeBlockIds: thread.blockIds ?? null, selectedContent: thread.selectContent ?? null,
      limitation: thread.commentType === 1 ? 'Only persisted inline thread attributes are interpreted.' : 'Page/discussion identity is not a text selection or Markdown range.' },
    commentsCommand: `docs comment-thread --id ${page.root.id} --thread ${thread.threadId} --status ${status}`,
    nativeCommentsCursor: row.nextCursor ?? null, raw: thread };
}

async function commentThreads(session, id, options) {
  const { limit, status } = commentOptions(options), page = await readPage(session, id);
  const { anchors, unsupportedBlockIds } = inlineCommentAnchors(page), ids = [...anchors.keys()].sort();
  const scope = ['docs comments', id, status, session.identity.user.userId, session.identity.user.accountId];
  const position = options.cursor ? decodeCursor(options.cursor, scope) : null;
  if (position && position.token !== String(page.root.version)) throw new AppError('CURSOR_STALE', 'The page changed during anchored-thread discovery. Start a fresh read.');
  const seen = new Set(position?.seen ?? []), batch = ids.filter(threadId => !seen.has(threadId)).slice(0, limit);
  const result = batch.length ? await session.request(`/api/comment/threads:batchGet?fileId=${id}`, {
    method: 'POST', safeRead: true, base: page.file.fileClusterApiPrefix, body: { threadIds: batch, threadStatus: status },
  }) : { threads: [], users: {} };
  if (!Array.isArray(result.threads)) throw new AppError('UNSUPPORTED_RESPONSE', 'Missing native thread rows.');
  const items = result.threads.map(row => nativeThread(row, result.users, page, anchors, status));
  if (items.some(item => !batch.includes(item.id)) || new Set(items.map(item => item.id)).size !== items.length) {
    throw new AppError('UNSUPPORTED_RESPONSE', 'Unexpected or duplicate native thread identity.');
  }
  batch.forEach(threadId => seen.add(threadId));
  const token = ids.some(threadId => !seen.has(threadId)) ? String(page.root.version) : null;
  const nextCursor = token ? encodeCursor(scope, { token, seen: [...seen] }) : null;
  const limited = nextCursor?.length > 60000;
  return { file: fileSummary(page.file), pageId: id, version: page.root.version, items, users: result.users ?? {},
    requestedThreadIds: batch, notReturnedThreadIds: batch.filter(threadId => !items.some(item => item.id === threadId)),
    nextCursor: limited ? null : nextCursor,
    pagination: { complete: !token && !limited, status: limited ? 'incomplete' : token ? 'more' : 'end',
      kind: 'local-anchor-batches', snapshot: false, ...(limited ? { reason: 'CURSOR_STATE_LIMIT' } : {}) },
    coverage: { scope: 'single-page-persisted-inline-anchors', documentCommentsComplete: false, unsupportedBlockIds,
      note: 'Page discussions, suggestions, deleted/unanchored and non-inline anchors are not enumerated. A missing filtered thread is not proof of deletion.' },
    readEffects: commentReadEffects };
}

async function discussions(session, id, options) {
  const kind = options.kind ?? 'page', { limit, status } = commentOptions(options);
  if (!['page', 'document'].includes(kind) || (kind === 'document' && options.status !== undefined)) {
    throw new AppError('INVALID_INPUT', 'Use --kind page|document; --status is supported only for page discussions.');
  }
  const page = await readPage(session, id), { anchors } = inlineCommentAnchors(page);
  const scope = ['docs discussions', id, kind, kind === 'page' ? status : 'all', session.identity.user.userId, session.identity.user.accountId];
  const position = options.cursor ? decodeCursor(options.cursor, scope) : null;
  let state = { cursor: '', version: page.root.version };
  if (position) {
    try { state = JSON.parse(position.token); } catch { throw new AppError('INVALID_INPUT', 'Invalid discussion cursor.'); }
    if (typeof state.cursor !== 'string' || !state.cursor || state.version !== page.root.version) {
      throw new AppError('CURSOR_STALE', 'The page changed or discussion continuation is invalid.');
    }
  }
  const commentType = kind === 'page' ? 2 : 3;
  const result = await session.request(`/api/comment/discussions:batchGet?fileId=${id}`, {
    method: 'POST', safeRead: true, base: page.file.fileClusterApiPrefix,
    body: { commentType, ...(kind === 'page' ? { threadStatus: status } : {}), limit, cursor: state.cursor },
  });
  if (!Array.isArray(result.threads) || typeof result.nextCursor !== 'string') throw new AppError('UNSUPPORTED_RESPONSE', 'Missing native discussion rows or continuation.');
  const seen = new Set(position?.seen ?? []), repeatedThreadIds = [], items = [];
  for (const row of result.threads) {
    if (row.thread?.commentType !== commentType || !['open', 'resolved'].includes(row.thread?.threadStatus)) {
      throw new AppError('UNSUPPORTED_RESPONSE', 'Unexpected discussion kind or status.');
    }
    const thread = nativeThread(row, result.users, page, anchors, kind === 'page' ? status : row.thread.threadStatus);
    if (seen.has(thread.id)) { repeatedThreadIds.push(thread.id); continue; }
    seen.add(thread.id);
    if (!Array.isArray(row.comments)) throw new AppError('UNSUPPORTED_RESPONSE', 'Missing native discussion comments.');
    const comments = (row.firstComment ? [row.firstComment, ...row.comments] : row.comments).map(comment => nativeComment(comment, result.users, thread.id));
    items.push({ ...thread, comments, commentsComplete: !row.nextCursor && /^\d+$/.test(String(thread.commentCount))
      && Number(thread.commentCount) === new Set(comments.map(comment => comment.id)).size });
  }
  const nextCursor = result.nextCursor ? encodeCursor(scope, {
    token: JSON.stringify({ cursor: result.nextCursor, version: page.root.version }), seen: [...seen],
  }) : null;
  const reason = repeatedThreadIds.length ? 'REPEATED_NATIVE_THREAD'
    : result.nextCursor && result.nextCursor === state.cursor ? 'NONADVANCING_NATIVE_CURSOR'
    : nextCursor?.length > 60000 ? 'CURSOR_STATE_LIMIT'
    : !nextCursor && result.threads.length >= limit ? 'SATURATED_NATIVE_PAGE' : null;
  return { file: fileSummary(page.file), pageId: id, version: page.root.version, kind, status: kind === 'page' ? status : null,
    items, users: result.users ?? {}, repeatedThreadIds, nextCursor: reason ? null : nextCursor,
    pagination: { complete: !reason && !nextCursor, status: reason ? 'incomplete' : nextCursor ? 'more' : 'end',
      kind: 'native-service-continuation', snapshot: false, returnedNativeCursor: result.nextCursor, ...(reason ? { reason } : {}) },
    coverage: { scope: `single-page-native-${kind}-discussions`, documentCommentsComplete: false,
      commentsComplete: items.every(item => item.commentsComplete),
      note: 'Other discussion kinds, inline anchors, suggestions, deleted threads and descendant pages are separate scopes. Per-thread readCommand continues replies; no exhaustive document claim.' },
    readEffects: commentReadEffects };
}

async function commentThread(session, id, options) {
  const { limit, status } = commentOptions(options), threadId = fileId(options.thread);
  const scope = ['docs comment-thread', id, threadId, status, session.identity.user.userId, session.identity.user.accountId];
  const position = options.cursor ? decodeCursor(options.cursor, scope) : null;
  let state = { source: 'batch', cursor: null, stamp: null };
  if (position) {
    try { state = JSON.parse(position.token); } catch { throw new AppError('INVALID_INPUT', 'Invalid comment continuation.'); }
    if (!['batch', 'comments'].includes(state.source) || typeof state.stamp !== 'string'
      || (state.source === 'comments' && (typeof state.cursor !== 'string' || !state.cursor))) {
      throw new AppError('INVALID_INPUT', 'Invalid comment continuation.');
    }
  }
  const page = await readPage(session, id), { anchors } = inlineCommentAnchors(page);
  const initial = await session.request(`/api/comment/threads:batchGet?fileId=${id}`, {
    method: 'POST', safeRead: true, base: page.file.fileClusterApiPrefix, body: { threadIds: [threadId], threadStatus: status },
  });
  if (!Array.isArray(initial.threads) || initial.threads.length > 1) throw new AppError('UNSUPPORTED_RESPONSE', 'Unexpected exact-thread response.');
  if (!initial.threads.length) return { pageId: id, threadId, thread: null, items: [], nextCursor: null,
    pagination: { complete: false, status: 'incomplete', reason: 'THREAD_NOT_RETURNED_FOR_STATUS' }, readEffects: commentReadEffects };
  const row = initial.threads[0], thread = nativeThread(row, initial.users, page, anchors, status);
  if (thread.id !== threadId) throw new AppError('UNSUPPORTED_RESPONSE', 'Exact thread identity mismatch.');
  const stamp = JSON.stringify([thread.modifyAt, thread.newestCommentCreateAt, thread.commentCount, thread.threadStatus]);
  if (state.stamp !== null && state.stamp !== stamp) throw new AppError('CURSOR_STALE', 'The thread changed during pagination. Start a fresh read.');
  let result = { ...row, users: initial.users };
  if (state.source === 'comments') {
    const params = new URLSearchParams({ fileId: id, threadId, limit: String(limit), cursor: state.cursor });
    result = await session.request(`/api/comment/comments?${params}`, { base: page.file.fileClusterApiPrefix });
  }
  if (!Array.isArray(result.comments) || typeof result.nextCursor !== 'string') throw new AppError('UNSUPPORTED_RESPONSE', 'Unrecognized native comment page.');
  const rows = result.firstComment ? [result.firstComment, ...result.comments] : result.comments;
  const comments = rows.map(comment => nativeComment(comment, { ...initial.users, ...result.users }, threadId));
  if (new Set(comments.map(comment => comment.id)).size !== comments.length) throw new AppError('UNSUPPORTED_RESPONSE', 'Duplicate native comments within one page.');
  const seen = new Set(position?.seen ?? []), fresh = comments.filter(comment => !seen.has(comment.id)), items = fresh.slice(0, limit);
  items.forEach(comment => seen.add(comment.id));
  const moreLocal = fresh.length > items.length, moreNative = Boolean(result.nextCursor);
  const nextState = moreLocal ? { ...state, stamp } : { source: 'comments', cursor: result.nextCursor, stamp };
  const nextCursor = moreLocal || moreNative ? encodeCursor(scope, { token: JSON.stringify(nextState), seen: [...seen] }) : null;
  const reason = moreNative && result.nextCursor === state.cursor && !moreLocal ? 'NONADVANCING_NATIVE_CURSOR'
    : nextCursor?.length > 60000 ? 'CURSOR_STATE_LIMIT'
    : !nextCursor && (!/^\d+$/.test(String(thread.commentCount)) || Number(thread.commentCount) !== seen.size) ? 'COMMENT_COUNT_UNVERIFIED' : null;
  return { pageId: id, threadId, thread, items, nextCursor: reason ? null : nextCursor,
    pagination: { complete: !reason && !nextCursor, status: reason ? 'incomplete' : nextCursor ? 'more' : 'end',
      kind: 'local-window-over-native-batch-and-returned-native-cursor', order: 'native-newest-first', snapshot: false,
      returnedNativeCursor: result.nextCursor, ...(reason ? { reason } : {}) },
    coverage: { contentComplete: items.every(item => item.coverage.complete), rootIdentity: 'native-firstComment-when-present',
      nativeFirstCommentId: row.firstComment?.comment?.commentId ?? null,
      note: 'The initial native batch has its own service size; --limit bounds emitted comments, not that initial response. Root/replies retain native identities; absent parent fields are not invented.' },
    readEffects: commentReadEffects };
}

function expectedUsers(options) {
  const users = typeof options['expect-users'] === 'string' ? options['expect-users'].split(',') : [];
  if (!users.length || users.some(user => !/^[A-Za-z0-9_-]{1,128}$/.test(user)) || new Set(users).size !== users.length) {
    throw new AppError('INVALID_INPUT', 'Supply unique comma-separated --expect-users IDs, including the owner.');
  }
  return users;
}

function privateAudience(inspection, expected) {
  const permission = inspection.sources.permission?.data;
  if (!inspection.coverage.complete || inspection.file.parentId !== 'my-docs' || !permission
    || permission.disabledExternalCollaborators.length
    || ['spacePermissionSetting', 'currentSpacePermissionSetting', 'inheritSpacePermissionSetting',
      'meetingDocRole', 'meetingDocInviteeRole', 'meetingDocParticipantRole', 'spaceMemberDefaultInheritedRole']
      .some(key => permission[key] != null && !['noAccess', 'unspecified'].includes(permission[key].newRole))
    || ['linkAccess', 'currentLinkAccess', 'inheritLinkAccess']
      .some(key => permission[key] != null && permission[key].role?.newRole !== 'noAccess')) {
    throw new AppError('UNSUPPORTED_PERMISSION_SCOPE', 'Requires complete visible inspection of a collaborator-only root Doc without inherited or broader grants.');
  }
  const grants = permission.collaborators;
  const users = grants.map(grant => grant.user?.id);
  if (!expected.includes(inspection.file.ownerId) || users.length !== expected.length
    || new Set(users).size !== users.length || users.some(user => !expected.includes(user))
    || grants.some(grant => !grant.user || grant.isInherited || grant.isExternal || grant.isEmailInvitee || grant.inheritedRole != null)) {
    throw new AppError('AUDIENCE_MISMATCH', 'Visible direct user collaborators must exactly match --expect-users, including the owner.');
  }
  return grants;
}

async function singlePageFile(session, id) {
  const file = await metadata(session, id);
  const children = await session.request('/api/file/files/action/batch_get_children', {
    method: 'POST', safeRead: true, base: file.fileClusterApiPrefix, body: { parentIds: [id], accountId: session.identity.user.accountId },
  });
  const matches = Array.isArray(children.successItems) ? children.successItems.filter(item => item?.parentId === id) : [];
  if (children.failureItems?.length || matches.length !== 1 || !Array.isArray(matches[0].children) || matches[0].children.length) {
    throw new AppError('UNSUPPORTED_PERMISSION_SCOPE', 'Collaboration changes require a verified single-page Doc; descendant propagation is unverified.');
  }
  return file;
}

async function resolveUser(session, email) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new AppError('INVALID_INPUT', 'Supply the existing recipient’s full email address.');
  }
  const result = await session.request('/api/user/contact', { method: 'POST', safeRead: true, body: { keyword: email, searchUsersOnly: false } });
  if (!Array.isArray(result.userContacts) || result.userContacts.length > 20) {
    throw new AppError('RESOLUTION_INCOMPLETE', 'Contact search is missing or too broad to verify an exact existing user.');
  }
  const candidates = [], seen = new Set();
  for (const contact of result.userContacts) {
    const user = contact?.userInfo;
    if (!user || typeof user.userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(user.userId)) {
      throw new AppError('RESOLUTION_INCOMPLETE', 'Contact search returned an unrecognized identity.');
    }
    if (seen.has(user.userId)) continue;
    seen.add(user.userId);
    if (contact.isExternal !== false || user.accountId !== session.identity.user.accountId || user.isEmailUser === true) continue;
    const profile = await session.request('/api/file/files/user/vcard', { method: 'POST', safeRead: true, body: { userId: user.userId } });
    if (profile.isExternal !== false || profile.vcard?.userId !== user.userId || typeof profile.vcard.email !== 'string') {
      throw new AppError('RESOLUTION_INCOMPLETE', 'The returned contact could not be verified by its native profile.');
    }
    if (profile.vcard.email.toLowerCase() === email.toLowerCase()) {
      candidates.push({ userId: user.userId, accountId: user.accountId, email: profile.vcard.email, displayName: user.displayName });
    }
  }
  if (candidates.length > 1) throw new AppError('AMBIGUOUS_USER', 'Multiple same-account users match this email.', { candidates });
  if (!candidates.length) throw new AppError('USER_NOT_FOUND', 'No verified existing same-account user matches this email. No email-only invitation was synthesized.');
  return { user: candidates[0], matchedBy: 'exact-email-and-native-profile', scope: 'same-account-existing-user' };
}

async function shareDocument(session, id, options) {
  const context = { operation: 'docs.share', operationId: randomUUID(), documentId: id, email: options.email, role: options.role };
  let submitted = false, accepted = false;
  try {
    const expected = expectedUsers(options);
    if (!['editor', 'viewer'].includes(options.role)) throw new AppError('INVALID_INPUT', 'Sharing supports editor or viewer.');
    const { user } = await resolveUser(session, options.email);
    context.userId = user.userId;
    const before = await inspectPermissions(session, id);
    if (before.file.ownerId !== session.identity.user.userId || before.effective?.permissionWithReason?.addCollaborators?.hasPermission !== true) {
      throw new AppError('FORBIDDEN', 'Sharing requires the document owner and effective add-collaborator permission.');
    }
    const grants = privateAudience(before, expected);
    if (expected.includes(user.userId)) throw new AppError('ALREADY_COLLABORATOR', 'This user is already a collaborator. Use docs set-role for supported role changes.');
    const file = await singlePageFile(session, id);
    submitted = true;
    const response = await session.request(`/api/file/files/${id}/collaborators`, {
      method: 'POST', base: file.fileClusterApiPrefix, body: { id,
        collaboratorInfo: [{ collaboratorId: { userId: user.userId }, role: { newRole: options.role, role: options.role } }],
        sendEmail: false, pageOnly: false, allowDowngrade: true, sendChatMessage: false, createChatChannel: false },
    });
    accepted = true;
    if (!Array.isArray(response.successList) || !Array.isArray(response.failedList) || response.failedList.length
      || response.successList.length !== 1 || response.successList[0].user?.id !== user.userId
      || response.successList[0].role?.newRole !== options.role) {
      throw new AppError('SHARE_RESULT_UNCONFIRMED', 'The service did not acknowledge exactly the requested user/role. Inspect permissions before any retry.');
    }
    const after = await inspectPermissions(session, id);
    const actual = privateAudience(after, [...expected, user.userId]);
    if (after.file.ownerId !== before.file.ownerId || actual.some(grant =>
      grant.role.newRole !== (grant.user.id === user.userId ? options.role : grants.find(old => old.user.id === grant.user.id)?.role.newRole))) {
      throw new AppError('READBACK_MISMATCH', 'Sharing readback did not preserve the requested audience and roles.');
    }
    return { ...context, user, outcome: 'confirmed', acceptance: 'accepted', verified: true,
      verification: 'service-result-and-visible-direct-grant', atomic: false,
      notifications: { email: false, chat: false, createChatChannel: false }, affectedUserCapabilitiesVerified: false,
      collaborators: actual.map(grant => ({ userId: grant.user.id, role: grant.role.newRole })) };
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' },
      accepted ? 'unknown' : submitted ? undefined : 'not_sent');
  }
}

async function removeCollaborator(session, id, options) {
  const context = { operation: 'docs.unshare', operationId: randomUUID(), documentId: id, email: options.email };
  let submitted = false, accepted = false;
  try {
    const expected = expectedUsers(options);
    const { user } = await resolveUser(session, options.email);
    context.userId = user.userId;
    const before = await inspectPermissions(session, id);
    if (before.file.ownerId !== session.identity.user.userId
      || before.effective?.permissionWithReason?.removeCollaborators?.hasPermission !== true) {
      throw new AppError('FORBIDDEN', 'Removal requires the document owner and effective remove-collaborator permission.');
    }
    const grants = privateAudience(before, expected);
    const target = grants.find(grant => grant.user.id === user.userId);
    if (!target || user.userId === before.file.ownerId || !['editor', 'viewer'].includes(target.role?.newRole)) {
      throw new AppError('UNSUPPORTED_COLLABORATOR', 'Only an existing non-owner direct Editor/Viewer collaborator can be removed.');
    }
    const file = await singlePageFile(session, id);
    context.previousRole = target.role.newRole;
    const collaboratorId = { userId: user.userId };
    submitted = true;
    await session.request(`/api/file/files/${id}/collaborators/action/remove`, {
      method: 'POST', base: file.fileClusterApiPrefix, body: { id, collaboratorIds: [collaboratorId],
        targets: [{ collaboratorId, isEmailInvitee: false }], pageOnly: false, propagatePermissionChanges: true },
    });
    accepted = true;
    const after = await inspectPermissions(session, id);
    const actual = privateAudience(after, expected.filter(value => value !== user.userId));
    if (after.file.ownerId !== before.file.ownerId || actual.some(grant =>
      grant.role.newRole !== grants.find(old => old.user.id === grant.user.id)?.role.newRole)) {
      throw new AppError('READBACK_MISMATCH', 'Removal did not preserve the remaining collaborator roles.');
    }
    return { ...context, user, outcome: 'confirmed', acceptance: 'accepted', verified: true,
      verification: 'visible-direct-grant-absence', atomic: false, affectedUserAccessVerified: false,
      collaborators: actual.map(grant => ({ userId: grant.user.id, role: grant.role.newRole })) };
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' },
      accepted ? 'unknown' : submitted ? undefined : 'not_sent');
  }
}


async function resolveDocument(session, title) {
  if (typeof title !== 'string' || !title.trim()) throw new AppError('INVALID_INPUT', 'Supply an exact document title.');
  const candidates = [], normalized = title.toLowerCase();
  let cursor, complete = false, pagination;
  for (let page = 0; page < 100; page++) {
    const result = await runDocs(session, 'find', { query: title, limit: 100, ...(cursor ? { cursor } : {}) });
    candidates.push(...result.items.filter(file => file.type === 'doc' && file.title?.toLowerCase() === normalized));
    pagination = result.pagination;
    if (candidates.length > 1) throw new AppError('AMBIGUOUS_DOCUMENT', 'Multiple accessible Docs match this exact title.', { title, candidates });
    if (pagination.complete) { complete = true; break; }
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  if (!complete) throw new AppError('RESOLUTION_INCOMPLETE', 'Document title search could not be exhausted safely.', { title, candidates, pagination });
  if (!candidates.length) throw new AppError('DOCUMENT_NOT_FOUND', 'No exact title match was returned by accessible Doc search; newly created Docs may not yet be indexed.', { title });
  const file = await metadata(session, candidates[0].id);
  if (file.title.toLowerCase() !== normalized) throw new AppError('RESOLUTION_INCOMPLETE', 'The document title changed after search.');
  return { file: fileSummary(file), matchedBy: 'exact-title', scope: 'accessible-title-search' };
}

async function setCollaboratorRole(session, id, options) {
  const context = { operation: 'docs.set-role', operationId: randomUUID(), documentId: id,
    userId: options.user, role: options.role };
  let submitted = false, accepted = false;
  try {
    const expected = expectedUsers(options);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.user ?? '') || !['editor', 'viewer'].includes(options.role)) {
      throw new AppError('INVALID_INPUT', 'Supply an exact user ID and editor/viewer role.');
    }
    const before = await inspectPermissions(session, id);
    if (before.file.ownerId !== session.identity.user.userId
      || before.effective?.permissionWithReason?.modifyCollaboratorRole?.hasPermission !== true) {
      throw new AppError('FORBIDDEN', 'Role changes require the document owner and effective modify-collaborator permission.');
    }
    const grants = privateAudience(before, expected);
    const target = grants.find(grant => grant.user.id === options.user);
    if (!target || target.user.id === before.file.ownerId || !['editor', 'viewer'].includes(target.role.newRole)) {
      throw new AppError('UNSUPPORTED_COLLABORATOR', 'Only an existing non-owner direct Editor/Viewer collaborator can be changed.');
    }
    const file = await singlePageFile(session, id);
    context.previousRole = target.role.newRole;
    submitted = true;
    await session.request(`/api/file/files/${id}/collaborators`, {
      method: 'PATCH', base: file.fileClusterApiPrefix,
      body: { id, collaboratorInfo: { collaboratorId: { userId: options.user },
        role: { newRole: options.role, role: options.role }, isEmailInvitee: false },
        pageOnly: false, propagatePermissionChanges: true },
    });
    accepted = true;
    const after = await inspectPermissions(session, id);
    const actual = privateAudience(after, expected);
    if (after.file.ownerId !== before.file.ownerId || actual.some(grant =>
      grant.role.newRole !== (grant.user.id === options.user ? options.role : grants.find(old => old.user.id === grant.user.id)?.role.newRole))) {
      throw new AppError('READBACK_MISMATCH', 'The requested role and unchanged other collaborator roles were not confirmed.');
    }
    return { ...context, outcome: 'confirmed', acceptance: 'accepted', verified: true,
      verification: 'visible-direct-grant-readback', atomic: false,
      collaborators: actual.map(grant => ({ userId: grant.user.id, role: grant.role.newRole })),
      affectedUserCapabilitiesVerified: false };
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' },
      accepted ? 'unknown' : submitted ? undefined : 'not_sent');
  }
}

async function importMarkdown(session, options) {
  const context = { operation: 'docs.import-markdown', operationId: randomUUID(), title: options.title };
  let submitted = false, accepted = false;
  try {
    if (typeof options.title !== 'string' || !options.title.trim() || typeof options.text !== 'string'
      || !options.text.trim() || Buffer.byteLength(options.text) > 8 * 1024 * 1024) {
      throw new AppError('INVALID_INPUT', 'Supply a title and nonempty UTF-8 Markdown up to 8 MiB.');
    }
    submitted = true;
    const response = await session.request('/api/bridge/import/syncCreate', { method: 'POST',
      body: { parentId: 'my-docs', filename: options.title, targetType: 1, sourceType: 4, sourceData: options.text } });
    accepted = true;
    if (typeof response.fileId !== 'string') throw new AppError('MISSING_CREATED_ID', 'Native Markdown import returned no document ID. Inspect My docs before retrying.');
    context.documentId = fileId(response.fileId);
    const page = await readPage(session, context.documentId);
    privateAudience(await inspectPermissions(session, context.documentId), [session.identity.user.userId]);
    return { ...context, file: fileSummary(page.file), version: page.root.version,
      outcome: 'confirmed', acceptance: 'accepted', verified: true, verification: 'created-page-readable-and-owner-only',
      sourceSha256: createHash('sha256').update(options.text).digest('hex'),
      conversion: { format: 'native-Markdown', lossless: false, contentEquivalenceVerified: false,
        note: 'Native conversion normalizes formatting; inspect docs read and export-markdown for the actual resulting content.' } };
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' },
      accepted ? 'unknown' : submitted ? undefined : 'not_sent');
  }
}

async function exportMarkdown(session, options, sourcePage) {
  const context = { operation: 'docs.export-markdown', operationId: randomUUID(), taskId: options.task ?? null };
  let accepted = Boolean(options.task), submitted = false;
  try {
    if (Boolean(options.id) === Boolean(options.task)) throw new AppError('INVALID_INPUT', 'Supply exactly one document --id or existing export --task.');
    let page;
    if (options.id) {
      const id = fileId(options.id), file = sourcePage?.file ?? await singlePageFile(session, id);
      if (file.privilege?.permissionWithReason?.export?.hasPermission !== true) throw new AppError('FORBIDDEN', 'This session cannot export the page.');
      page = sourcePage ?? await readPage(session, id, file);
      Object.assign(context, { documentId: id, sourceVersion: page.root.version });
      submitted = true;
      const response = await session.request(`/api/bridge/export/create?fileId=${id}`, {
        method: 'POST', base: file.fileClusterApiPrefix, body: { fileId: id, targetType: 4 },
      });
      accepted = true;
      if (typeof response.taskId !== 'string') throw new AppError('MISSING_EXPORT_TASK', 'Export was accepted without a usable task ID. Do not recreate it automatically.');
      context.taskId = response.taskId;
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(context.taskId)) throw new AppError('INVALID_INPUT', 'Invalid native export task ID.');
    let completed;
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await session.request(`/api/bridge/export/status?taskIds=${context.taskId}`);
      const rows = response.list?.filter(row => row.taskId === context.taskId);
      if (!Array.isArray(rows) || rows.length !== 1) throw new AppError('UNSUPPORTED_RESPONSE', 'Native export status did not identify the requested task.');
      context.nativeStatus = rows[0].status;
      if (rows[0].status === 2 && typeof rows[0].signedUrl === 'string') { completed = rows[0]; break; }
      if (rows[0].error) throw new AppError('EXPORT_FAILED', 'Native export reported a failure.', { nativeError: rows[0].error });
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!completed) throw new AppError('EXPORT_PENDING', 'Bounded export polling did not complete. Resume --task with this taskId; do not create another export.');
    const url = new URL(completed.signedUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'file.zoom.us' || url.username || url.password
      || (url.port && url.port !== '443') || !/^\/file\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
      throw new AppError('UNSUPPORTED_DOWNLOAD', 'Native export returned an unverified download origin or path.');
    }
    // A native signed capability, never a destination for Docs cookies or auth headers.
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (response.status !== 200 || !response.body || !/\.md(?:[";]|$)/i.test(response.headers.get('content-disposition') ?? '')) {
      throw new AppError('UNSUPPORTED_DOWNLOAD', 'Export did not return the observed Markdown attachment format.');
    }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new AppError('EXPORT_TOO_LARGE', 'Markdown download exceeds the 8 MiB supported bound.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks), markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const after = page ? await readPage(session, context.documentId, page.file) : null;
    if (after && after.root.version !== context.sourceVersion) throw new AppError('VERSION_CONFLICT', 'The source page changed during export; same-version mapping is unavailable.');
    if (options.out) await writeFile(options.out, bytes, { flag: 'wx', mode: 0o600 });
    return { ...context, outcome: 'confirmed', exportComplete: true, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(options.out ? { out: options.out } : { markdown }), sourceVersionAfter: after?.root.version ?? null,
      sourceAssociation: page ? 'matching-pre-and-post-page-version-observations' : 'resumed-task-source-not-verified',
      atomic: false, pollLimit: 6, format: 'Markdown', scope: page ? 'single-native-page' : 'native-export-task',
      conversion: { lossless: false, note: 'Native Markdown normalizes whitespace/table layout and does not retain block IDs, author metadata or comment anchors. Other block conversions are not claimed lossless.' } };
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' },
      accepted ? 'unknown' : submitted ? undefined : 'not_sent');
  }
}

function commentExportBlock(block, pageId) {
  if (block.parentId !== pageId) return { reason: 'UNSUPPORTED_NESTED_BLOCK' };
  const heading = /^BLOCK_TYPE_HEADING([1-6])$/.exec(block.type);
  const prefix = heading ? `${'#'.repeat(Number(heading[1]))} ` : block.type === 'BLOCK_TYPE_BULLET' ? '- ' : '';
  if (!heading && !['BLOCK_TYPE_PARAGRAPH', 'BLOCK_TYPE_BULLET'].includes(block.type)) return { reason: 'UNSUPPORTED_EXPORT_BLOCK_TYPE' };
  let runs;
  try { runs = JSON.parse(block.content?.title); } catch { return { reason: 'UNSUPPORTED_SOURCE_RUNS' }; }
  if (!Array.isArray(runs)) return { reason: 'UNSUPPORTED_SOURCE_RUNS' };
  const groups = [];
  for (const run of runs) {
    if (!Array.isArray(run) || run[0] !== 0 || typeof run[1] !== 'string' || (run[2] !== undefined && typeof run[2] !== 'string')) return { reason: 'UNSUPPORTED_SOURCE_RUNS' };
    const attrs = (run[2] ?? '').split('|').filter(Boolean);
    if (attrs.some(attr => !/^(?:26:"[A-Za-z0-9_-]+"|thread-[A-Za-z0-9_-]+:(?:true|false)|[89]:1)$/.test(attr))) return { reason: 'UNSUPPORTED_SOURCE_FORMATTING' };
    if (/[\r\n\\*_`\[\]<>]/.test(run[1])) return { reason: 'UNSUPPORTED_MARKDOWN_ESCAPING' };
    const bold = attrs.includes('8:1'), italic = attrs.includes('9:1');
    if (bold && italic) return { reason: 'UNVERIFIED_COMBINED_EMPHASIS' };
    const marker = bold ? '**' : italic ? '*' : '';
    if (groups.at(-1)?.marker === marker) groups.at(-1).text += run[1];
    else groups.push({ marker, text: run[1] });
  }
  let rendered = prefix, text = '';
  const segments = [];
  for (const group of groups) {
    rendered += group.marker;
    segments.push({ sourceStart: text.length, sourceEnd: text.length + group.text.length, markdownStart: rendered.length });
    text += group.text; rendered += group.text + group.marker;
  }
  return text ? { rendered, text, segments } : { reason: 'EMPTY_SOURCE_BLOCK' };
}

function mapCommentExport(page, thread, exported) {
  const result = { pageId: page.root.id, threadId: thread.id, sourceVersion: page.root.version, exportSha256: exported.sha256,
    sourceAssociation: exported.sourceAssociation, atomic: false, status: 'unmapped', ranges: [],
    units: 'UTF-16', offsets: 'zero-based, end-exclusive', linesAndColumns: 'one-based, UTF-16 columns',
    scope: 'exact-thread-current-inline-anchor', note: 'Only verified whole-block Markdown conversions are mapped. No text-only fallback, ordinal guess or lossless-document claim.' };
  if (exported.sourceVersion !== page.root.version || exported.sourceVersionAfter !== page.root.version) return { ...result, status: 'stale', reason: 'SOURCE_VERSION_MISMATCH' };
  if (thread.commentType !== 1) return { ...result, reason: 'NO_TEXT_ANCHOR', anchorKind: thread.anchor.kind };
  if (!thread.anchor.ranges.length) return { ...result, reason: 'DETACHED_ANCHOR' };
  const blockIds = thread.blockIds;
  if (!Array.isArray(blockIds) || new Set(blockIds).size !== blockIds.length
    || thread.anchor.ranges.some(range => !blockIds.includes(range.blockId))
    || blockIds.some(id => !thread.anchor.ranges.some(range => range.blockId === id))) return { ...result, reason: 'NATIVE_BLOCK_RANGE_MISMATCH' };
  const ranges = [...thread.anchor.ranges].sort((a, b) => blockIds.indexOf(a.blockId) - blockIds.indexOf(b.blockId) || a.offset - b.offset), joined = [];
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) || range.length < 1) return { ...result, reason: 'SOURCE_OFFSET_UNAVAILABLE' };
    const previous = joined.at(-1);
    if (previous?.blockId === range.blockId) {
      if (previous.offset + previous.length !== range.offset) return { ...result, reason: 'NONCONTIGUOUS_ANCHOR' };
      previous.length += range.length; previous.text += range.text;
    } else joined.push({ blockId: range.blockId, offset: range.offset, length: range.length, text: range.text });
  }
  const selectedText = joined.map(range => range.text).join('\n');
  result.selectedText = selectedText; result.nativeSelectedContent = thread.selectContent;
  if (typeof thread.selectContent !== 'string' || !thread.selectContent) return { ...result, reason: 'NATIVE_SELECTION_UNVERIFIED', ranges: joined };
  if (selectedText !== thread.selectContent) return { ...result, status: 'stale', reason: 'SELECTED_CONTENT_CHANGED', ranges: joined };
  const markdown = exported.markdown, lineStarts = [0], prepared = new Map();
  for (let i = 0; i < markdown.length; i++) if (markdown[i] === '\n') lineStarts.push(i + 1);
  const position = offset => {
    let low = 0, high = lineStarts.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (lineStarts[middle] <= offset) low = middle; else high = middle; }
    return { offset, line: low + 1, column: offset - lineStarts[low] + 1 };
  };
  for (const block of Object.values(page.blocks)) if (block.id !== page.root.id) prepared.set(block.id, commentExportBlock(block, page.root.id));
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  result.ranges = joined.map(source => {
    const block = page.blocks[source.blockId], converted = prepared.get(source.blockId);
    const plain = block ? blockText(block) : null;
    const context = { ...source, blockText: plain, sentences: typeof plain === 'string' ? [...segmenter.segment(plain)]
      .filter(segment => segment.index < source.offset + source.length && segment.index + segment.segment.length > source.offset)
      .map(segment => ({ offset: segment.index, length: segment.segment.length, text: segment.segment })) : [],
      sentenceMethod: 'Unicode English sentence segmentation; source block text retained', status: 'unmapped' };
    if (plain === null || plain?.slice(source.offset, source.offset + source.length) !== source.text) return { ...context, reason: 'SOURCE_RANGE_MISMATCH' };
    if (!converted || converted.reason) return { ...context, reason: converted?.reason ?? 'SOURCE_BLOCK_UNAVAILABLE' };
    const competingSourceBlocks = [...prepared].filter(([id, value]) => id !== source.blockId
      && (value.rendered === converted.rendered || (value.reason && blockText(page.blocks[id]) === converted.text))).map(([id]) => id);
    if (competingSourceBlocks.length) return { ...context, status: 'ambiguous', reason: 'REPEATED_SOURCE_BLOCK', competingSourceBlocks };
    const candidates = [];
    for (let from = 0; from < markdown.length;) {
      const offset = markdown.indexOf(converted.rendered, from);
      if (offset < 0) break;
      const end = offset + converted.rendered.length;
      if ((offset === 0 || markdown[offset - 1] === '\n') && (end === markdown.length || markdown[end] === '\n')) candidates.push(offset);
      if (candidates.length === 2) break;
      from = offset + 1;
    }
    if (candidates.length !== 1) return { ...context, status: candidates.length ? 'ambiguous' : 'unmapped',
      reason: candidates.length ? 'REPEATED_EXPORT_BLOCK' : 'EXPORT_CONVERSION_UNMAPPED', candidateCountAtLeast: candidates.length };
    const markdownRanges = converted.segments.flatMap(segment => {
      const start = Math.max(source.offset, segment.sourceStart), end = Math.min(source.offset + source.length, segment.sourceEnd);
      if (start >= end) return [];
      const offset = candidates[0] + segment.markdownStart + start - segment.sourceStart;
      return [{ start: position(offset), end: position(offset + end - start), text: markdown.slice(offset, offset + end - start) }];
    });
    if (markdownRanges.map(range => range.text).join('') !== source.text) return { ...context, reason: 'EXPORT_RANGE_MISMATCH' };
    return { ...context, status: 'exact', verification: 'unique-whole-block-conversion-and-native-UTF16-range',
      markdownRanges, formattingSeparatesRanges: markdownRanges.length > 1 };
  });
  result.status = result.ranges.every(range => range.status === 'exact') ? 'exact' : result.ranges.some(range => range.status === 'exact') ? 'partial'
    : result.ranges.some(range => range.status === 'ambiguous') ? 'ambiguous' : 'unmapped';
  return result;
}

async function commentContext(session, id, options) {
  const { status } = commentOptions(options), threadId = fileId(options.thread), file = await singlePageFile(session, id);
  const page = await readPage(session, id, file);
  const { anchors } = inlineCommentAnchors(page);
  const response = await session.request(`/api/comment/threads:batchGet?fileId=${id}`, {
    method: 'POST', safeRead: true, base: page.file.fileClusterApiPrefix, body: { threadIds: [threadId], threadStatus: status },
  });
  if (!Array.isArray(response.threads) || response.threads.length !== 1) throw new AppError('THREAD_NOT_RETURNED_FOR_STATUS', 'Exact thread was not returned for this page and status.');
  const thread = nativeThread(response.threads[0], response.users, page, anchors, status);
  if (thread.id !== threadId) throw new AppError('UNSUPPORTED_RESPONSE', 'Exact thread identity mismatch.');
  const exported = await exportMarkdown(session, { id }, page);
  return { file: fileSummary(page.file), thread, export: exported, context: mapCommentExport(page, thread, exported), readEffects: commentReadEffects };
}

function comparableCommentRuns(block, ignoredThread) {
  let runs;
  try { runs = JSON.parse(block.content?.title); } catch { return null; }
  if (!Array.isArray(runs)) return null;
  const result = [];
  for (const run of runs) {
    if (!Array.isArray(run) || run.length > 3 || run[0] !== 0 || typeof run[1] !== 'string' || (run[2] !== undefined && typeof run[2] !== 'string')) return null;
    const attributes = (run[2] ?? '').split('|').filter(attr => attr && (ignoredThread === undefined || attr !== `thread-${ignoredThread}:true`)).sort().join('|');
    if (result.at(-1)?.attributes === attributes) result.at(-1).text += run[1];
    else result.push({ text: run[1], attributes });
  }
  return result;
}

async function prepareCommentContent(session, options, grants, context) {
  if (options['mention-email'] === undefined) return { text: options.text };
  const { user } = await resolveUser(session, options['mention-email']);
  const grant = grants.find(grant => grant.user.id === user.userId);
  if (!grant || !['owner', 'co-owner', 'editor', 'commenter', 'viewer'].includes(grant.role?.newRole)) {
    throw new AppError('MENTION_AUDIENCE_MISMATCH', 'A mention requires an existing direct collaborator with access. No invitation or sharing change was sent.');
  }
  if (typeof user.displayName !== 'string' || !user.displayName.trim()) throw new AppError('RESOLUTION_INCOMPLETE', 'The canonical mentioned user has no usable native display name.');
  const person = { mentionId: randomUUID().replaceAll('-', ''), userId: user.userId, name: user.displayName, notify: true };
  const text = `${person.name} ${options.text}`;
  if (Buffer.byteLength(text) > 16384) throw new AppError('INVALID_INPUT', 'Comment text including the canonical mention must fit within 16 KiB.');
  context.mentions = [{ ...person, email: user.email, notificationDelivery: 'unverified' }];
  context.sharingMutationSent = false;
  return { doc: [{ type: 'BLOCK_TYPE_PARAGRAPH', content: [{ data: { person } }, { data: ` ${options.text}` }] }], text };
}

async function verifyCommentAudience(session, id, expected, before) {
  const after = privateAudience(await inspectPermissions(session, id), expected);
  if (after.some(grant => grant.role.newRole !== before.find(previous => previous.user.id === grant.user.id)?.role.newRole)) {
    throw new AppError('MENTION_AUDIENCE_CHANGED', 'The post-mention audience or collaborator roles changed. No sharing repair or comment replay was attempted.');
  }
}

async function prepareCommentAttachment(session, id, file, options, context, expected, grants) {
  if (options.attachment === undefined) return [];
  if (file.privilege?.permissionWithReason?.upload?.hasPermission !== true) throw new AppError('FORBIDDEN', 'This actor cannot upload attachments to the Doc.');
  const type = options['attachment-mime'] ?? 'application/octet-stream', name = basename(options.attachment);
  if (!['application/octet-stream', 'text/plain', 'image/png'].includes(type)) throw new AppError('UNSUPPORTED_ATTACHMENT', 'Comment uploads support octet-stream/text files and PNG images; other media and inline embeds are unverified.');
  if (!name || /[\0\r\n]/.test(name)) throw new AppError('INVALID_INPUT', 'Supply a valid local attachment filename.');
  const handle = await open(options.attachment, 'r');
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) throw new AppError('INVALID_INPUT', 'Comment attachment must be a nonempty regular file up to 1 MiB.');
    bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw new AppError('FILE_CHANGED', 'Attachment size changed while reading; nothing uploaded.');
  } finally { await handle.close(); }
  const image = type === 'image/png' ? inspectAttachmentMedia(bytes, type).dimension : null;
  const attachment = { id: randomUUID().replaceAll('-', ''), name, size: bytes.length, type, ...(image ?? {}) };
  Object.assign(context, { attachment, attachmentSha256: createHash('sha256').update(bytes).digest('hex'),
    phase: 'attachment_allocation_submitted', uploadAcceptance: 'unobserved' });
  const allocation = await session.request(`/api/attachment/getUploadFileUrl?fileId=${id}`, { method: 'POST', base: file.fileClusterApiPrefix,
    body: { bucket: image ? 7 : 8, name, contentType: type, contentLength: bytes.length, permissionRecord: { pageId: id, blockId: id } } });
  attachment.attachmentId = fileId(allocation.attachmentId);
  context.phase = 'attachment_allocated'; context.uploadAcceptance = 'allocated';
  const url = new URL(allocation.signedPutUrl), headers = allocation.putHeaders;
  if (url.protocol !== 'https:' || url.hostname !== 'file.zoom.us' || url.pathname !== '/zoomfile/upload'
    || url.username || url.password || (url.port && url.port !== '443') || !headers || typeof headers !== 'object'
    || Array.isArray(headers) || Object.entries(headers).some(([key, value]) =>
      !['zoom-file-meta', 'x-zm-auth', 'x-zm-trackingid'].includes(key.toLowerCase()) || typeof value !== 'string')) {
    throw new AppError('UNSUPPORTED_UPLOAD', 'Native allocation returned an unverified signed upload contract.');
  }
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  context.phase = 'attachment_upload_submitted'; context.uploadAcceptance = 'unobserved';
  let response;
  try { response = await fetch(url, { method: 'POST', body: form, headers, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { throw new AppError('UPLOAD_UNCONFIRMED', 'Signed upload failed or timed out; do not upload or link again automatically.'); }
  await response.body?.cancel();
  if (response.headers.get('cf-mitigated') === 'challenge') throw new AppError('PROVIDER_APPROVAL_REQUIRED', 'Native upload requires interactive provider approval.');
  if (response.status !== 200 || response.headers.get('zoom-file-id') !== attachment.attachmentId) {
    throw new AppError('UPLOAD_ACKNOWLEDGEMENT_MISMATCH', 'Upload did not acknowledge the allocated attachment identity.', { status: response.status });
  }
  context.phase = 'attachment_uploaded'; context.uploadAcceptance = 'confirmed';
  await verifyCommentAudience(session, id, expected, grants);
  return [attachment];
}

async function downloadCommentAttachment(session, id, options) {
  const threadId = fileId(options.thread), commentId = fileId(options.comment), attachmentId = fileId(options.attachment);
  if (typeof options.out !== 'string' || !options.out) throw new AppError('INVALID_INPUT', 'Supply an exclusive local --out path.');
  const file = await singlePageFile(session, id);
  if (file.privilege?.permissionWithReason?.download?.hasPermission !== true) throw new AppError('FORBIDDEN', 'This actor cannot download Doc attachments.');
  const thread = await completeCommentThread(session, id, threadId, options.status ?? 'open');
  const comment = thread.items.find(item => item.id === commentId);
  if (!comment) throw new AppError('COMMENT_NOT_FOUND', 'Exact comment was not returned in the requested thread.');
  if (!comment.attachmentItems) throw new AppError('UNSUPPORTED_ATTACHMENT', 'Comment contains unverified attachment metadata or media; raw content remains available.');
  const attachment = comment.attachmentItems.find(item => item.attachmentId === attachmentId);
  if (!attachment) throw new AppError('ATTACHMENT_NOT_FOUND', 'Attachment is not linked to this exact comment.');
  if (attachment.size > 1024 * 1024) throw new AppError('ATTACHMENT_TOO_LARGE', 'Comment downloads are bounded to 1 MiB.');
  const result = await session.request(`/api/attachment/getSignedFileUrls?fileId=${id}`, { method: 'POST', safeRead: true, base: file.fileClusterApiPrefix,
    body: { attachments: [{ attachmentId, permissionRecord: { pageId: id, blockId: commentId }, fileName: attachment.name }],
      acceptWEBP: false, download: true } });
  const value = result.signedUrls?.[attachmentId];
  if (typeof value !== 'string') throw new AppError('ATTACHMENT_UNAVAILABLE', 'Native signing did not return this linked attachment.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['file.zoom.us', 'file-paa.zoom.us'].includes(url.hostname)
    || url.pathname !== `/file/${attachmentId}` || url.username || url.password || (url.port && url.port !== '443')) {
    throw new AppError('UNSUPPORTED_DOWNLOAD', 'Native comment attachment returned an unverified download origin or identity.');
  }
  let response;
  try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { throw new AppError('DOWNLOAD_FAILED', 'Signed attachment download failed; no automatic retry.'); }
  if (response.headers.get('cf-mitigated') === 'challenge') { await response.body?.cancel(); throw new AppError('PROVIDER_APPROVAL_REQUIRED', 'Native download requires interactive provider approval.'); }
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new AppError('DOWNLOAD_FAILED', 'Native attachment download was not accepted.', { status: response.status }); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > attachment.size) throw new AppError('ATTACHMENT_MISMATCH', 'Downloaded bytes exceed the linked native attachment size.');
    chunks.push(chunk);
  }
  if (size !== attachment.size) throw new AppError('ATTACHMENT_MISMATCH', 'Downloaded bytes do not match the linked native attachment size.');
  const bytes = Buffer.concat(chunks), after = await completeCommentThread(session, id, threadId, options.status ?? 'open');
  if (attachment.type === 'image/png' && !isDeepStrictEqual(inspectAttachmentMedia(bytes, attachment.type).dimension,
    { width: attachment.width, height: attachment.height })) throw new AppError('ATTACHMENT_MISMATCH', 'Downloaded image dimensions differ from the linked native metadata.');
  if (!isDeepStrictEqual(after.items.find(item => item.id === commentId)?.attachmentItems, comment.attachmentItems)) {
    throw new AppError('ATTACHMENT_CHANGED', 'Comment attachment linkage changed during download; output was not created.');
  }
  await writeFile(options.out, bytes, { flag: 'wx', mode: 0o600 });
  return { documentId: id, threadId, commentId, attachment, out: options.out, bytes: size,
    sha256: createHash('sha256').update(bytes).digest('hex'), contentType: response.headers.get('content-type'),
    verification: 'exact-comment-linkage-and-size; compare-sha256-with-independent-source', atomic: false };
}

async function createAnchoredComment(session, id, options) {
  const context = { operation: 'docs.comment-create', documentId: id, threadId: randomUUID().replaceAll('-', ''),
    commentId: randomUUID().replaceAll('-', ''), requestId: randomUUID(), clientId: randomUUID(), transactionId: randomUUID(),
    phase: 'preflight', threadAcceptance: 'not_sent', annotationAcceptance: 'not_sent', atomic: false };
  let submitted = false, threadAccepted = false;
  try {
    const blockId = fileId(options.block), offset = Number(options.offset), length = Number(options.length), version = Number(options['if-version']);
    if (!Number.isSafeInteger(offset) || offset < 0 || String(options.offset) !== String(offset)
      || !Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(version) || version < 0
      || typeof options.quote !== 'string' || !options.quote || typeof options.text !== 'string' || !options.text.trim()
      || Buffer.byteLength(options.text) > 16384) throw new AppError('INVALID_INPUT', 'Supply exact UTF-16 offset/length/quote, page version and nonempty comment text up to 16 KiB.');
    Object.assign(context, { blockId, offset, length, quote: options.quote, baseVersion: version,
      readCommand: `docs comment-thread --id ${id} --thread ${context.threadId}`,
      anchorReadCommand: `docs comments --id ${id}` });
    const file = await singlePageFile(session, id);
    const expected = expectedUsers(options), grants = privateAudience(await inspectPermissions(session, id), expected);
    if (file.privilege?.permissionWithReason?.comment?.hasPermission !== true || file.privilege?.permissionWithReason?.edit?.hasPermission !== true) {
      throw new AppError('FORBIDDEN', 'Anchored creation currently requires observed comment and edit capabilities.');
    }
    const content = await prepareCommentContent(session, options, grants, context);
    const page = await readPage(session, id, file), target = page.blocks[blockId];
    if (page.root.version !== version) throw new AppError('VERSION_CONFLICT', 'The page changed before comment creation; nothing sent.', { actualVersion: page.root.version });
    const comparable = target ? comparableCommentRuns(target) : null;
    if (!target || target.parentId !== id || !comparable
      || !['BLOCK_TYPE_PARAGRAPH', 'BLOCK_TYPE_BULLET', 'BLOCK_TYPE_NUMBERED', 'BLOCK_TYPE_HEADING1', 'BLOCK_TYPE_HEADING2', 'BLOCK_TYPE_HEADING3', 'BLOCK_TYPE_HEADING4', 'BLOCK_TYPE_HEADING5', 'BLOCK_TYPE_HEADING6'].includes(target.type)) {
      throw new AppError('UNSUPPORTED_ANCHOR', 'Select a supported top-level text block; nested/object anchors are not created.');
    }
    const text = blockText(target), end = offset + length;
    const splitsSurrogate = index => index > 0 && index < text.length
      && /[\uD800-\uDBFF]/.test(text[index - 1]) && /[\uDC00-\uDFFF]/.test(text[index]);
    if (!Number.isSafeInteger(end) || end > text.length || text.slice(offset, end) !== options.quote || splitsSurrogate(offset) || splitsSurrogate(end)) {
      throw new AppError('ANCHOR_CHANGED', 'Exact quote/range must match the current block without splitting a UTF-16 surrogate pair; nothing sent.');
    }
    const attachments = await prepareCommentAttachment(session, id, file, options, context, expected, grants);
    if (attachments.length && (await readPage(session, id, file)).root.version !== version) {
      throw new AppError('VERSION_CONFLICT', 'Attachment uploaded, but page changed before thread submission. Preserve the allocated asset; do not replay.');
    }
    context.phase = 'thread_submitted'; context.threadAcceptance = 'unobserved'; submitted = true;
    const created = await session.request(`/api/comment/threads?fileId=${id}`, { method: 'POST', base: file.fileClusterApiPrefix,
      body: { fileId: id, rootBlockId: id, threadId: context.threadId, commentId: context.commentId,
        selectContent: options.quote, commentContent: JSON.stringify(content), attachments: JSON.stringify(attachments), blockIds: [blockId] } });
    threadAccepted = true; context.threadAcceptance = 'accepted'; context.phase = 'thread_acknowledged';
    const createdComment = nativeComment({ comment: created.comment, reactions: [] }, {}, context.threadId);
    if (created.thread?.threadId !== context.threadId || created.thread.fileId !== id || created.thread.rootBlockId !== id
      || created.thread.commentType !== 1 || created.thread.threadStatus !== 'open'
      || !isDeepStrictEqual(created.thread.blockIds, [blockId]) || created.thread.selectContent !== options.quote
      || createdComment.id !== context.commentId || !isDeepStrictEqual(createdComment.structuredContent, content)
      || !isDeepStrictEqual(createdComment.attachmentItems, attachments)
      || created.comment.createdBy !== session.identity.user.userId) throw new AppError('CREATE_READBACK_MISMATCH', 'Native creation did not acknowledge the exact requested comment; no annotation sent.');
    const current = await readPage(session, id, file);
    if (current.root.version !== version || !isDeepStrictEqual(current.blocks[blockId]?.content, target.content)) {
      throw new AppError('VERSION_CONFLICT', 'Thread exists, but the page changed before annotation. Inspect its recorded ID; do not recreate it.');
    }
    const delta = [...(offset ? [[2, offset]] : []), [2, length, `thread-${context.threadId}:true`]];
    context.phase = 'annotation_submitted'; context.annotationAcceptance = 'unobserved';
    await session.request(`/api/block/transactions?fileId=${id}`, { method: 'POST', base: file.fileClusterApiPrefix,
      body: { reqId: context.requestId, clientId: context.clientId, baseVersion: version,
        transactions: [{ id: context.transactionId, ops: [{ command: 'COMMAND_TYPE_UPDATE', blockId, args: { delta: JSON.stringify(delta) } }] }],
        extra: { fromFileId: id } } });
    context.annotationAcceptance = 'accepted'; context.phase = 'annotation_acknowledged';
    let readbackError;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const after = await readPage(session, id, file), anchors = inlineCommentAnchors(after).anchors;
        const ranges = anchors.get(context.threadId) ?? [];
        const unchanged = Object.keys(after.blocks).length === Object.keys(page.blocks).length && Object.values(page.blocks).every(block => {
          const actual = after.blocks[block.id];
          if (!actual || actual.type !== block.type || actual.parentId !== block.parentId || actual.seq !== block.seq || !isDeepStrictEqual(actual.style, block.style)) return false;
          if (block.id !== blockId) return isDeepStrictEqual(actual.content, block.content);
          return isDeepStrictEqual(comparableCommentRuns(actual, context.threadId), comparable)
            && Object.keys(actual.content).length === Object.keys(block.content).length
            && Object.keys(block.content).every(key => key === 'title' || isDeepStrictEqual(actual.content[key], block.content[key]));
        });
        let nextOffset = offset;
        const exactAnchor = ranges.length > 0 && ranges.every(range => {
          if (range.blockId !== blockId || range.offset !== nextOffset) return false;
          nextOffset += range.length; return true;
        }) && nextOffset === end && ranges.map(range => range.text).join('') === options.quote;
        if (!unchanged || !exactAnchor || after.root.version <= version) throw new AppError('ANCHOR_READBACK_MISMATCH', 'Exact new anchor with unchanged prior content/formatting/anchors was not observed.');
        const observed = await session.request(`/api/comment/threads:batchGet?fileId=${id}`, {
          method: 'POST', safeRead: true, base: file.fileClusterApiPrefix, body: { threadIds: [context.threadId], threadStatus: 'open' },
        });
        if (!Array.isArray(observed.threads) || observed.threads.length !== 1) throw new AppError('COMMENT_READBACK_MISMATCH', 'Created thread was not returned.');
        const row = observed.threads[0], thread = nativeThread(row, observed.users, after, anchors, 'open');
        const comment = [row.firstComment, ...(row.comments ?? [])].filter(Boolean).map(item => nativeComment(item, observed.users, context.threadId))
          .find(item => item.id === context.commentId);
        if (thread.id !== context.threadId || !isDeepStrictEqual(comment?.structuredContent, content)
          || !isDeepStrictEqual(comment.attachmentItems, attachments) || comment.createdBy !== session.identity.user.userId) throw new AppError('COMMENT_READBACK_MISMATCH', 'Exact created comment identity/content/attachments were not recovered.');
        if (content.doc || attachments.length) await verifyCommentAudience(session, id, expected, grants);
        return { ...context, phase: 'confirmed', outcome: 'confirmed', acceptance: 'native-thread-and-annotation-acknowledgements-and-readback',
          file: fileSummary(file), version: after.root.version, thread, comment, existingBlocksUnchanged: true, existingFormattingAndAnchorsPreserved: true };
      } catch (error) { readbackError = error; }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw readbackError;
  } catch (error) {
    throw writeFailure(error, context, context.uploadAcceptance ? 'unknown' : !submitted ? 'not_sent' : threadAccepted ? 'unknown' : undefined);
  }
}

function commentThreadBinding(thread) {
  return Object.fromEntries(['threadId', 'createdBy', 'createAt', 'fileId', 'rootBlockId', 'commentType', 'threadStatus',
    'blockIds', 'selectContent', 'anchor'].map(key => [key, thread[key]]));
}

const preservedCommentFields = ['createdBy', 'updatedBy', 'createAt', 'modifyAt', 'threadId', 'content', 'attachments', 'parentComment', 'parentId', 'isEdited'];

function commentsPreserved(before, currentById) {
  return before.every(previous => {
    const current = currentById.get(previous.id);
    return current && preservedCommentFields.every(key => isDeepStrictEqual(current[key], previous[key]));
  });
}

async function completeCommentThread(session, id, threadId, status = 'open') {
  let first, cursor;
  const items = [], seen = new Set();
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await commentThread(session, id, { thread: threadId, status, limit: 100, cursor });
    if (!page.thread) throw new AppError('THREAD_NOT_RETURNED_FOR_STATUS', 'Exact thread is unavailable for the requested status; no implicit reopen.');
    first ??= page;
    if (!isDeepStrictEqual(commentThreadBinding(first.thread), commentThreadBinding(page.thread))) throw new AppError('CURSOR_STALE', 'Thread context changed during preflight.');
    for (const item of page.items) {
      if (seen.has(item.id)) throw new AppError('INCOMPLETE_THREAD', 'Thread continuation repeated a comment identity.');
      seen.add(item.id); items.push(item);
    }
    cursor = page.nextCursor;
    if (!cursor) {
      if (!page.pagination.complete) throw new AppError('INCOMPLETE_THREAD', 'Native reader could not prove complete thread coverage.', { pagination: page.pagination });
      return { ...first, items, nextCursor: null, pagination: page.pagination };
    }
  }
  throw new AppError('INCOMPLETE_THREAD', 'Thread verification is bounded to ten native-reader pages and 1000 comments.');
}

async function replyComment(session, id, options) {
  const context = { operation: 'docs.comment-reply', documentId: id, commentId: randomUUID().replaceAll('-', ''), phase: 'preflight', atomic: false };
  let submitted = false, accepted = false;
  try {
    const threadId = fileId(options.thread);
    Object.assign(context, { threadId, readCommand: `docs comment-thread --id ${id} --thread ${threadId}` });
    if (typeof options.text !== 'string' || !options.text.trim() || Buffer.byteLength(options.text) > 16384) throw new AppError('INVALID_INPUT', 'Supply nonempty reply text up to 16 KiB.');
    const file = await singlePageFile(session, id);
    const expected = expectedUsers(options), grants = privateAudience(await inspectPermissions(session, id), expected);
    if (file.privilege?.permissionWithReason?.comment?.hasPermission !== true) throw new AppError('FORBIDDEN', 'This actor cannot comment on the Doc.');
    const content = await prepareCommentContent(session, options, grants, context);
    const before = await completeCommentThread(session, id, threadId);
    if (![1, 2, 3].includes(before.thread.commentType) || before.items.length >= 1000 || !Array.isArray(before.thread.blockIds)
      || before.thread.blockIds.some(block => typeof block !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(block))) {
      throw new AppError('UNSUPPORTED_THREAD', 'Reply requires supported native block identities and a complete thread below 1000 comments.');
    }
    const attachments = await prepareCommentAttachment(session, id, file, options, context, expected, grants);
    if (attachments.length) {
      const current = await completeCommentThread(session, id, threadId);
      if (!isDeepStrictEqual(commentThreadBinding(current.thread), commentThreadBinding(before.thread))
        || !commentsPreserved(before.items, new Map(current.items.map(item => [item.id, item])))) {
        throw new AppError('THREAD_CHANGED', 'Attachment uploaded, but thread context changed before comment submission. Do not replay.');
      }
    }
    context.phase = 'submitted'; submitted = true;
    const created = await session.request(`/api/comment/comments?fileId=${id}`, { method: 'POST', base: file.fileClusterApiPrefix,
      body: { threadId, commentId: context.commentId, commentContent: JSON.stringify(content), attachments: JSON.stringify(attachments),
        blockIds: before.thread.blockIds, fileId: id } });
    accepted = true; context.phase = 'acknowledged';
    const acknowledged = nativeComment({ comment: created.comment, reactions: [] }, {}, threadId);
    if (created.thread?.threadId !== threadId || created.thread.fileId !== id || created.thread.rootBlockId !== id
      || created.thread.threadStatus !== before.thread.threadStatus || acknowledged.id !== context.commentId
      || !isDeepStrictEqual(acknowledged.structuredContent, content) || !isDeepStrictEqual(acknowledged.attachmentItems, attachments)
      || acknowledged.createdBy !== session.identity.user.userId) {
      throw new AppError('REPLY_ACKNOWLEDGEMENT_MISMATCH', 'Native reply acknowledgement did not preserve the requested thread/status/author/content.');
    }
    let readbackError;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const after = await completeCommentThread(session, id, threadId);
        const byId = new Map(after.items.map(comment => [comment.id, comment])), reply = byId.get(context.commentId);
        const unchanged = commentsPreserved(before.items, byId);
        if (!reply || !isDeepStrictEqual(reply.structuredContent, content) || !isDeepStrictEqual(reply.attachmentItems, attachments) || reply.createdBy !== session.identity.user.userId
          || reply.parentComment !== acknowledged.parentComment || reply.parentId !== acknowledged.parentId
          || !unchanged || !isDeepStrictEqual(commentThreadBinding(after.thread), commentThreadBinding(before.thread))) {
          throw new AppError('REPLY_READBACK_MISMATCH', 'Exact reply and unchanged existing comment content/parent/status/anchor were not observed.');
        }
        if (content.doc || attachments.length) await verifyCommentAudience(session, id, expected, grants);
        return { ...context, phase: 'confirmed', outcome: 'confirmed', acceptance: 'native-comment-acknowledgement-and-complete-thread-readback',
          file: fileSummary(file), thread: after.thread, reply, previousCommentsPreserved: true,
          previousCommentIds: before.items.map(comment => comment.id), additionalConcurrentComments: after.items.length - before.items.length - 1,
          parentSemantics: 'Native thread-root reply; parentComment/parentId returned verbatim, no nested parent invented.',
          readEffects: commentReadEffects };
      } catch (error) { readbackError = error; }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw readbackError;
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }, context.uploadAcceptance ? 'unknown' : !submitted ? 'not_sent' : accepted ? 'unknown' : undefined);
  }
}

async function changeCommentStatus(session, id, options, status) {
  const expectedStatus = status === 'resolved' ? 'open' : 'resolved';
  const context = { operation: status === 'resolved' ? 'docs.comment-resolve' : 'docs.comment-reopen',
    documentId: id, expectedStatus, requestedStatus: status, phase: 'preflight', atomic: false };
  let submitted = false, accepted = false;
  try {
    const threadId = fileId(options.thread);
    Object.assign(context, { threadId, readCommand: `docs comment-thread --id ${id} --thread ${threadId} --status ${status}` });
    const file = await singlePageFile(session, id);
    privateAudience(await inspectPermissions(session, id), expectedUsers(options));
    if (file.privilege?.permissionWithReason?.comment?.hasPermission !== true) throw new AppError('FORBIDDEN', 'This actor cannot comment on the Doc.');
    let before;
    try { before = await completeCommentThread(session, id, threadId, expectedStatus); }
    catch (error) {
      if (error.code !== 'THREAD_NOT_RETURNED_FOR_STATUS') throw error;
      const other = await commentThread(session, id, { thread: threadId, status, limit: 1 });
      if (other.thread) {
        context.observedStatus = status;
        throw new AppError('THREAD_STATE_MISMATCH', 'The thread is already in the requested state; no PATCH sent and native idempotency is not assumed.');
      }
      throw error;
    }
    if (![1, 2, 3].includes(before.thread.commentType)
      || (expectedStatus === 'resolved' && !/^[1-9]\d*$/.test(String(before.thread.resolveAt)))) {
      throw new AppError('UNSUPPORTED_THREAD', 'Transition requires a known native thread kind and supported resolution history.');
    }
    context.previousState = { status: before.thread.threadStatus, modifyAt: before.thread.modifyAt, resolveAt: before.thread.resolveAt };
    context.phase = 'submitted'; submitted = true;
    const response = await session.request(`/api/comment/threads/${threadId}?fileId=${id}`, {
      method: 'PATCH', base: file.fileClusterApiPrefix, body: { threadStatus: status },
    });
    accepted = true; context.phase = 'acknowledged';
    const acknowledged = response.thread;
    if (acknowledged?.threadId !== threadId || acknowledged.fileId !== id || acknowledged.rootBlockId !== id || acknowledged.threadStatus !== status) {
      throw new AppError('THREAD_STATE_ACKNOWLEDGEMENT_MISMATCH', 'Native acknowledgement did not identify the requested page/thread/state.');
    }
    const binding = { ...commentThreadBinding(before.thread), threadStatus: status };
    let readbackError;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const after = await completeCommentThread(session, id, threadId, status);
        if (!isDeepStrictEqual(commentThreadBinding(after.thread), binding)
          || !commentsPreserved(before.items, new Map(after.items.map(comment => [comment.id, comment])))
          || after.thread.resolveAt !== acknowledged.resolveAt
          || (status === 'open' ? after.thread.resolveAt !== before.thread.resolveAt : !/^[1-9]\d*$/.test(String(after.thread.resolveAt)))) {
          throw new AppError('THREAD_STATE_READBACK_MISMATCH', 'Requested state with unchanged comments/parents/anchor and native resolution history was not observed.');
        }
        return { ...context, phase: 'confirmed', outcome: 'confirmed', acceptance: 'native-thread-state-acknowledgement-and-complete-readback',
          file: fileSummary(file), thread: after.thread, comments: after.items, previousCommentsPreserved: true,
          additionalConcurrentComments: after.items.length - before.items.length,
          history: { previous: context.previousState, current: { status: after.thread.threadStatus, modifyAt: after.thread.modifyAt, resolveAt: after.thread.resolveAt },
            scope: 'native-current-and-last-resolution-fields', completeAuditHistory: false },
          readEffects: commentReadEffects };
      } catch (error) { readbackError = error; }
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw readbackError;
  } catch (error) {
    throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }, !submitted ? 'not_sent' : accepted ? 'unknown' : undefined);
  }
}

const dimension = (status, scope, reasons = [], exhaustive = false) => ({ status, scope, exhaustive, reasons });
const observedFreshness = session => ({
  source: 'server', observedAt: new Date().toISOString(), actorId: session.identity.user.userId,
  accountId: session.identity.user.accountId ?? null, nativeWatermark: null,
  snapshot: { status: 'non-atomic' }, alreadyReadCoverage: 'unknown', lateOrBackdatedCoverage: 'unknown',
});

function nativeTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const milliseconds = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value);
  return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8640000000000000
    ? new Date(milliseconds).toISOString() : null;
}

function docsInterval(options) {
  const { since, until, timezone } = options;
  if (since === undefined && until === undefined) {
    if (timezone !== undefined) {
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
      catch { throw new AppError('INVALID_INPUT', 'Use a valid IANA timezone.'); }
    }
    return null;
  }
  const now = options.commandStartedAt ?? Date.now();
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { throw new AppError('INVALID_INPUT', 'Use a valid IANA timezone.'); }
  const day = ms => {
    const parts = Object.fromEntries(formatter.formatToParts(ms).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const today = day(now);
  const midnight = next => {
    if (!timezone) throw new AppError('INVALID_INPUT', 'today requires an explicit IANA timezone.');
    // Search the actual civil-day boundary; no fixed 24-hour assumption across DST.
    let low = now - 48 * 3600000, high = now + 48 * 3600000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (next ? day(middle) <= today : day(middle) < today) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const resolve = (value, end) => {
    if (value === undefined) return null;
    if (value === 'now') return now;
    if (value === 'today') return midnight(end);
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
      || !Number.isFinite(Date.parse(value))
      || new Date(Date.parse(`${value.slice(0, 10)}T00:00:00Z`)).toISOString().slice(0, 10) !== value.slice(0, 10)) {
      throw new AppError('INVALID_INPUT', 'Time endpoints require a valid offset timestamp, now, or today.');
    }
    return Date.parse(value);
  };
  const start = resolve(since, false), end = resolve(until ?? (since === 'today' ? 'today' : 'now'), true);
  if (start !== null && end !== null && start >= end) throw new AppError('INVALID_INPUT', 'The half-open interval must have since before until.');
  return { inputs: { since: since ?? null, until: until ?? null, timezone: timezone ?? null },
    timezone: timezone ?? 'UTC', since: start === null ? null : new Date(start).toISOString(),
    until: end === null ? null : new Date(end).toISOString(), filterLocation: 'local', sourceExhaustive: false };
}

function strictRead(result, options, required) {
  if (options.strict && required.some(key => result.coverage?.[key]?.status !== 'complete')) {
    // Error details are log-safe: content, titles, names and addresses stay out of exceptions.
    throw new AppError('INCOMPLETE_COVERAGE', 'The native source cannot establish the requested coverage.', {
      operation: result.operation ?? 'docs.read', phase: 'coverage', retryable: false,
      partial: { coverage: result.coverage, nextCursor: result.nextCursor ?? null,
        itemIds: (result.items ?? result.pages ?? []).map(item => item.id ?? item.pageId ?? item.identity?.id).filter(Boolean),
        loadedPages: result.loadedPages, unresolvedDescendants: result.unresolvedDescendants,
        unsupportedItems: (result.unsupportedItems ?? []).map(item => ({
          id: item.id, pageId: item.pageId, blockId: item.blockId, reason: item.reason, reasons: item.reasons,
          diagnostic: item.diagnostic, opaqueEvidence: item.opaqueEvidence,
        })) },
    });
  }
  return result;
}

function actorObservation(session, id, user, resourceId, source) {
  const observedAt = new Date().toISOString();
  return {
    identity: { id: id ?? null, accountId: user?.accountId ?? null,
      displayName: user?.displayName ?? user?.name ?? null, email: user?.email ?? null,
      provenance: { source, observedAt, observerAccountId: session.identity.user.accountId ?? null } },
    observations: resourceId ? [{ scope: 'document', resourceId, relationship: 'unknown', source, observedAt }] : [],
  };
}
async function enrichActors(session, records, options) {
  const actors = records.map(record => record.actor).filter(Boolean);
  const ids = [...new Set(actors.map(actor => actor.identity.id).filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)))];
  const requested = ids.slice(0, 20);
  const result = requested.length ? await resolveActors(session, { ids: requested, signal: options.signal }) : { items: [], unsupportedItems: [] };
  const global = new Map(result.items.map(item => [item.identity.id, item.identity]));
  for (const actor of actors) {
    const identity = global.get(actor.identity.id);
    if (identity) {
      actor.observedIdentity = actor.identity;
      actor.identity = identity;
    }
  }
  const unresolvedIds = ids.filter(id => !global.has(id));
  const reasons = [
    ...(ids.length > requested.length ? ['IDENTITY_LOOKUP_LIMIT'] : []),
    ...result.unsupportedItems.map(item => item.reason),
    ...(actors.some(actor => typeof actor.identity.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(actor.identity.id)) ? ['INVALID_OR_MISSING_NATIVE_ACTOR_ID'] : []),
    ...(actors.some(actor => !actor.identity.id || !actor.identity.accountId) ? ['GLOBAL_IDENTITY_TENANT_UNVERIFIED'] : []),
  ];
  return { ...dimension(reasons.length ? 'incomplete' : 'complete', 'bounded-native-actor-profiles', [...new Set(reasons)]),
    requestedIds: requested, unresolvedIds, limit: 20 };
}

const notificationTypes = new Set([
  'docComment', 'docMention', 'addCollaboration', 'docMentionNoPermission',
  'docPermissionRequest', 'docOwnerTransfer', 'docCreateInMeeting', 'docReminder',
  'docPageReactions', 'docFirstRead', 'verifyPage', 'docMeetingCollaboration',
  'sharedFolderCollaboration', 'docOnboarding', 'docPublishPage', 'docDisabledPublishPage',
  'docDisabledPublishPageFeature', 'docSuggestion', 'docContentUpdate', 'docAddSubscriber',
  'docRisky', 'docLowQuality', 'docDataRetention', 'docPostGallery',
  'docDisabledPostGalleryFeature', 'generic', 'docAutoWriting',
]);

function notificationUnavailable(session, endpoint, state, interval, error) {
  const status = Number.isInteger(error?.details?.status) && error.details.status >= 100 && error.details.status <= 599
    ? error.details.status : null;
  const providerResult = Number.isSafeInteger(error?.details?.result) ? error.details.result : null;
  const attempts = Number.isSafeInteger(error?.details?.attempts) && error.details.attempts > 0
    ? error.details.attempts : null;
  const source = endpoint === '/api/notification/groupByFile' ? 'native-global-notification-center' : 'native-document-for-me';
  return {
    operation: 'docs.notifications', source: endpoint, scope: source, state, items: [], unsupportedItems: [],
    nextCursor: null, timeRange: interval, filterLocation: endpoint === '/api/notification/groupByFile' ? 'native-listType' : 'local', nativeUnreadCount: null,
    availability: 'unavailable', disposition: 'source-unavailable',
    unavailable: { source: endpoint, provider: { status, result: providerResult, attempts },
      noFallback: true, reason: 'NATIVE_NOTIFICATION_SOURCE_UNAVAILABLE' },
    readEffects: { explicitReadMarkerSent: false, neutralityVerified: false },
    freshness: { ...observedFreshness(session), alreadyReadCoverage: state === 'unread' ? 'excluded' : 'included' },
    coverage: {
      pagination: dimension('unavailable', endpoint, ['SOURCE_UNAVAILABLE']),
      content: dimension('unavailable', endpoint, ['SOURCE_UNAVAILABLE']),
      identity: dimension('unknown', 'bounded-native-actor-profiles', ['SOURCE_UNAVAILABLE']),
      permission: dimension('unknown', 'linked-document-access', ['NOTIFICATIONS_DO_NOT_PROVE_CURRENT_ACCESS']),
      category: dimension('unknown', 'notification-center-categories', ['CATEGORY_EXHAUSTIVENESS_UNPROVEN', 'SOURCE_UNAVAILABLE']),
      mentions: dimension('unavailable', endpoint, ['SOURCE_UNAVAILABLE']),
    },
  };
}

async function notificationInbox(session, options) {
  const limit = Number(options.limit ?? 50), state = options.state ?? 'all', timeRange = docsInterval(options);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !['all', 'unread'].includes(state)) {
    throw new AppError('INVALID_INPUT', 'Docs notifications require --limit 1..50 and --state all|unread.');
  }
  const id = options.id === undefined ? null : fileId(options.id);
  const scope = ['docs notifications', id ? 'for-me-v1' : 'group-by-file-v1',
    session.identity.user.userId, session.identity.user.accountId, id, state,
    options.since ?? null, options.until ?? null, options.timezone ?? null];
  const position = options.cursor ? decodeCursor(options.cursor, scope) : null;
  let token = '', interval = timeRange;
  if (position) {
    let saved;
    try { saved = JSON.parse(position.token); } catch { throw new AppError('INVALID_INPUT', 'Invalid notification cursor.'); }
    if (typeof saved.token !== 'string' || !saved.token || (saved.interval !== null &&
      (!saved.interval || typeof saved.interval.until !== 'string' || !Number.isFinite(Date.parse(saved.interval.until))
        || (saved.interval.since !== null && !Number.isFinite(Date.parse(saved.interval.since)))))) {
      throw new AppError('INVALID_INPUT', 'Invalid notification continuation interval.');
    }
    if ((saved.interval === null) !== (timeRange === null)
      || (saved.interval && (JSON.stringify(saved.interval.inputs) !== JSON.stringify(timeRange.inputs)
        || (saved.interval.since && saved.interval.since >= saved.interval.until)))) {
      throw new AppError('INVALID_INPUT', 'The notification cursor interval does not match the requested bounds.');
    }
    token = saved.token; interval = saved.interval;
  }
  const endpoint = id ? '/api/notification/forMe' : '/api/notification/groupByFile';
  const params = new URLSearchParams();
  if (id) {
    params.set('fileId', id);
    params.set('pagingToken', token);
    params.set('limit', String(limit));
  } else {
    params.set('limit', String(limit));
    params.set('listType', state);
    if (token) params.set('pagingToken', token);
  }
  const requestPath = `${endpoint}?${params}`;
  let result;
  try { result = await session.request(requestPath, { signal: options.signal }); }
  catch (error) {
    const status = error.details?.status;
    const globalProviderFailure = !id && error instanceof AppError
      && (error.code === 'REQUEST_FAILED'
        || (error.code === 'HTTP_ERROR' && (status === 408 || (Number.isInteger(status) && status >= 500))));
    if (globalProviderFailure) return strictRead(notificationUnavailable(session, endpoint, state, interval, error), options,
      ['pagination', 'content', 'category']);
    throw new AppError(error.code ?? 'REQUEST_FAILED', 'Native Docs notification retrieval failed.', {
      operation: 'docs.notifications', phase: 'native-inbox', retryable: error.details?.retryable ?? false,
      source: endpoint, cause: { code: error.code ?? 'REQUEST_FAILED',
        ...(Number.isInteger(error.details?.status) ? { status: error.details.status } : {}),
        ...(Number.isInteger(error.details?.attempts) ? { attempts: error.details.attempts } : {}) },
    });
  }
  const malformedEnvelope = !result || typeof result !== 'object'
    || (id ? !Array.isArray(result.notifications) : !Array.isArray(result.fileNotifications))
    || (result.nextPagingToken !== undefined && typeof result.nextPagingToken !== 'string')
    || (!id && (!Number.isFinite(result.unreadCount) || result.unreadCount < 0));
  if (malformedEnvelope) {
    throw new AppError('UNSUPPORTED_RESPONSE', 'The native notification envelope is not recognized.',
      { operation: 'docs.notifications', phase: 'decode', source: endpoint });
  }
  const items = [], unsupportedItems = [], seen = new Set(position?.seen ?? []), repeatedIds = [];
  const mentionReasons = new Set(['STRUCTURED_MENTION_DATA_NOT_AVAILABLE_FOR_ALL_NOTIFICATION_TYPES']);
  const nativeEntries = [];
  if (id) {
    for (const [nativeIndex, row] of result.notifications.entries()) nativeEntries.push({ nativeIndex, row, group: null });
  } else {
    for (const [nativeIndex, group] of result.fileNotifications.entries()) {
      const row = group?.latestNotification;
      if (!group || typeof group !== 'object' || Array.isArray(group)
        || !row || typeof row !== 'object' || Array.isArray(row)) {
        unsupportedItems.push({ nativeIndex, reason: 'MALFORMED_NOTIFICATION_GROUP', raw: group });
        continue;
      }
      nativeEntries.push({ nativeIndex, row, group });
    }
  }
  for (const { nativeIndex: index, row, group } of nativeEntries) {
    const reasons = [];
    if (!row || typeof row.notificationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.notificationId)) {
      unsupportedItems.push({ nativeIndex: index, reason: 'MALFORMED_NOTIFICATION_ID', raw: row }); continue;
    }
    if (seen.has(row.notificationId)) { repeatedIds.push(row.notificationId); continue; }
    seen.add(row.notificationId);
    if (!notificationTypes.has(row.templateType)) reasons.push('UNSUPPORTED_NOTIFICATION_TYPE');
    let context = null;
    try {
      context = JSON.parse(row.templateData);
      if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error();
    } catch { reasons.push('MALFORMED_NOTIFICATION_CONTEXT'); }
    const createdAt = nativeTime(row.createTime);
    if (!createdAt) reasons.push('UNKNOWN_NOTIFICATION_TIME');
    const readState = row.read === true ? 'read' : row.read === false ? 'unread' : 'unknown';
    if (readState === 'unknown') reasons.push('UNKNOWN_READ_STATE');
    if (typeof row.sender?.id !== 'string') reasons.push('UNKNOWN_NOTIFICATION_ACTOR');
    const documentId = typeof row.fileId === 'string' ? row.fileId
      : typeof group?.fileId === 'string' ? group.fileId : null;
    if (!documentId) reasons.push('UNKNOWN_NOTIFICATION_DOCUMENT');
    if (id && documentId !== id) reasons.push('NOTIFICATION_DOCUMENT_MISMATCH');
    if (group && typeof group.fileId === 'string' && typeof row.fileId === 'string'
      && group.fileId !== row.fileId) reasons.push('NOTIFICATION_GROUP_DOCUMENT_MISMATCH');
    let target = null;
    try {
      const link = new URL(row.link);
      if (link.protocol !== 'https:' || link.username || link.password
        || (link.hostname !== 'docs.zoom.us' && link.origin !== new URL(session.identity.homeClusterApiPrefix).origin)) throw new Error();
      target = { documentId,
        blockId: link.searchParams.get('blockId') ?? (/^#[A-Za-z0-9_-]{1,128}$/.test(link.hash) ? link.hash.slice(1) : null),
        threadId: link.searchParams.get('comment'), commentId: link.searchParams.get('commentReply') };
    } catch { reasons.push('UNSUPPORTED_NOTIFICATION_LINK'); }
    const category = row.templateType === 'docMention' ? 'content-mention'
      : row.templateType === 'docComment' ? target?.commentId ? 'comment-reply'
        : context?.fromType === 'mention' ? 'comment-mention' : 'comment'
      : notificationTypes.has(row.templateType) ? row.templateType : 'unknown';
    const mentionInfo = notificationMentionInfo(context);
    if (mentionInfo === null) {
      reasons.push('UNSUPPORTED_NOTIFICATION_MENTION_CONTENT');
      mentionReasons.add('UNSUPPORTED_NOTIFICATION_MENTION_CONTENT');
    }
    const normalizedMentions = mentionInfo === undefined ? {} : {
      mentions: mentionInfo === null ? null : mentionInfo.map(mention => ({ ...mention, scope: 'direct',
        notificationExpectation: mention.notify ? 'requested-not-delivery-proof' : 'not-requested' })),
      mentionScope: mentionInfo?.length ? 'direct' : 'unknown',
    };
    const item = { id: row.notificationId, type: row.templateType ?? null, documentId,
      url: row.link ?? null, createdAt, nativeCreatedAt: row.createTime ?? null, readState,
      actor: actorObservation(session, row.sender?.id, row.sender, documentId, endpoint),
      context, target, category, nativeMentionKind: context?.fromType ?? null,
      mentionScope: 'unknown', ...normalizedMentions,
      notificationExpectation: 'native-record-observed',
      nativeGroup: group ? { fileId: group.fileId ?? null, fileType: group.fileType ?? null,
        title: group.title ?? null, unreadCount: group.unreadCount ?? null,
        notificationLevel: group.notificationLevel ?? null,
        hasFilePermission: group.hasFilePermission ?? null } : null,
      raw: row };
    if (reasons.length) unsupportedItems.push({ ...item, reasons });
    // Unknown time/state remains visible as unsupported, never silently a matching unread item.
    if (state === 'unread' && readState !== 'unread') continue;
    if (interval && (!createdAt || (interval.since && createdAt < interval.since) || (interval.until && createdAt >= interval.until))) continue;
    if (items.length < limit) items.push(item);
    else if (!reasons.length) unsupportedItems.push({ ...item, reasons: ['NATIVE_LIMIT_NOT_RESPECTED'] });
  }
  let nextCursor = result.nextPagingToken ? encodeCursor(scope, {
    token: JSON.stringify({ token: result.nextPagingToken, interval }), seen: [...seen],
  }) : null;
  const paginationReason = repeatedIds.length ? 'REPEATED_NOTIFICATION_ID'
    : token && token === result.nextPagingToken ? 'NONADVANCING_NATIVE_CURSOR'
    : nextCursor?.length > 60000 ? 'CURSOR_STATE_LIMIT'
    : (id ? result.notifications.length : result.fileNotifications.length) > limit ? 'NATIVE_LIMIT_NOT_RESPECTED' : null;
  if (paginationReason) nextCursor = null;
  const identityCoverage = await enrichActors(session, items, options);
  return strictRead({
    operation: 'docs.notifications', source: endpoint, scope: id ? 'native-document-for-me' : 'native-global-notification-center',
    state, items, unsupportedItems, nextCursor, timeRange: interval, repeatedIds,
    filterLocation: id ? 'local' : 'native-listType', nativeUnreadCount: result.unreadCount ?? null,
    freshness: { ...observedFreshness(session), alreadyReadCoverage: state === 'unread' ? 'excluded' : 'included' },
    readEffects: { explicitReadMarkerSent: false, neutralityVerified: false },
    coverage: {
      pagination: dimension(paginationReason || nextCursor ? 'incomplete' : 'complete', endpoint,
        paginationReason ? [paginationReason] : nextCursor ? ['MORE_NATIVE_PAGES'] : [], false),
      content: dimension(unsupportedItems.length || !id ? 'incomplete' : 'complete',
        id ? 'returned-native-notification-records' : 'latest-native-notification-per-document-group',
        [...new Set([...(id ? [] : ['LATEST_NOTIFICATION_PER_DOCUMENT_ONLY']),
          ...unsupportedItems.flatMap(item => item.reasons ?? [item.reason])])]),
      mentions: dimension('incomplete',
        id ? 'returned-native-structured-person-elements' : 'latest-native-notification-structured-person-elements',
        [...mentionReasons]),
      identity: identityCoverage,
      permission: dimension('unknown', 'linked-document-access', ['NOTIFICATIONS_DO_NOT_PROVE_CURRENT_ACCESS']),
      category: dimension('unknown', 'notification-center-categories', ['CATEGORY_EXHAUSTIVENESS_UNPROVEN']),
    },
  }, options, ['pagination', 'content', 'identity', 'category']);
}

async function recentDocuments(session, options) {
  const limit = Number(options.limit ?? 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError('INVALID_INPUT', 'Recent requires --limit 1..100.');
  if (options.since || options.until || options.timezone) throw new AppError('INVALID_INPUT', 'Recent time filtering is not verified; use the native activity metadata without assuming modified-time semantics.');
  const scope = ['docs recent', session.identity.user.userId, session.identity.user.accountId];
  const position = options.cursor ? decodeCursor(options.cursor, scope) : null;
  const params = new URLSearchParams({ limit: String(limit) });
  if (position) params.set('pagingToken', position.token);
  const result = await session.request(`/api/file/recent?${params}`, { signal: options.signal });
  if (!Array.isArray(result.recentFiles) || (result.nextPagingToken !== undefined && typeof result.nextPagingToken !== 'string')) {
    throw new AppError('UNSUPPORTED_RESPONSE', 'Missing native Recent records or continuation.');
  }
  const ids = result.recentFiles.slice(0, limit).map(row => row?.file?.id)
    .filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id));
  let current = new Map(), reconciliationFailure = null;
  if (ids.length) {
    try {
      const response = await session.request('/api/file/files/action/batch_get', {
        method: 'POST', safeRead: true, body: { ids: [...new Set(ids)] }, signal: options.signal,
      });
      if (!Array.isArray(response.successItems)) throw new AppError('UNSUPPORTED_RESPONSE', 'Missing reconciliation rows.');
      current = new Map(response.successItems.filter(file => file && ids.includes(file.id)).map(file => [file.id, file]));
    } catch (error) { reconciliationFailure = error.code ?? 'REQUEST_FAILED'; }
  }
  const unsupportedItems = [], rows = [];
  for (const [index, row] of result.recentFiles.entries()) {
    if (index >= limit) { unsupportedItems.push({ reason: 'NATIVE_LIMIT_NOT_RESPECTED', nativeIndex: index, raw: row }); continue; }
    if (typeof row?.file?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.file.id)) {
      unsupportedItems.push({ reason: 'MALFORMED_RECENT_FILE', nativeIndex: index, raw: row }); continue;
    }
    const file = row.file, live = current.get(file.id);
    const item = { ...fileSummary(file), nativeRankInPage: index, indexedTitle: file.title ?? null,
      currentTitle: live?.title ?? null, titleReconciliation: !live ? 'unavailable' : live.title === file.title ? 'matched' : 'changed',
      lastOperatedTime: row.lastOperatedTime ?? null, operationType: row.operationType ?? null,
      location: row.location ?? null, ancestors: row.ancestors ?? null,
      native: { file, location: row.location ?? null, ancestors: row.ancestors ?? null },
      reconciliation: { source: '/api/file/files/action/batch_get', observedAt: new Date().toISOString(),
        status: live ? 'received' : 'unavailable', current: live ? fileSummary(live) : null },
    };
    rows.push(item);
    if (file.fileType !== 'doc') unsupportedItems.push({ ...item, reason: 'UNSUPPORTED_FILE_TYPE' });
  }
  const page = documentPage(rows, result.nextPagingToken, scope, position?.seen);
  if ((position?.token && position.token === result.nextPagingToken) || result.recentFiles.length > limit) {
    page.nextCursor = null; page.pagination = { status: 'incomplete', complete: false, snapshot: false,
      reason: result.recentFiles.length > limit ? 'NATIVE_LIMIT_NOT_RESPECTED' : 'NONADVANCING_NATIVE_CURSOR' };
  }
  return strictRead({ ...page, operation: 'docs.recent', scope: 'native-recent-files', order: 'native-recent',
    unsupportedItems, freshness: observedFreshness(session),
    coverage: {
      pagination: dimension(page.pagination.complete ? 'complete' : 'incomplete', 'native-recent',
        page.pagination.reason ? [page.pagination.reason] : page.nextCursor ? ['MORE_NATIVE_PAGES'] : []),
      content: dimension(unsupportedItems.length || rows.some(row => row.reconciliation.status !== 'received') ? 'incomplete' : 'complete',
        'recent-file-metadata', [...new Set([...unsupportedItems.map(item => item.reason),
          ...(rows.some(row => row.reconciliation.status !== 'received') ? [reconciliationFailure ?? 'CURRENT_METADATA_NOT_RETURNED'] : [])])]),
      identity: dimension('unknown', 'recent-actors', ['PROFILE_RESOLUTION_NOT_REQUESTED']),
      permission: dimension('unknown', 'recent-file-access', ['INDEX_PRESENCE_IS_NOT_CURRENT_ACCESS']),
      category: dimension('unknown', 'server-recent-not-browser-local', ['UI_FILTERS_AND_LOCAL_RECENT_NOT_REPRODUCED']),
    },
  }, options, ['pagination', 'content', 'category']);
}

function selectedIds(options) {
  const values = Array.isArray(options.ids) ? options.ids : typeof options.ids === 'string' ? options.ids.split(',') : [];
  if (!values.length || values.length > 100) throw new AppError('INVALID_INPUT', 'Supply --ids with 1..100 native IDs.');
  const ids = values.map(fileId);
  if (new Set(ids).size !== ids.length) throw new AppError('INVALID_INPUT', 'IDs must be unique.');
  return ids;
}

async function modifiedDocuments(session, options) {
  const ids = selectedIds(options), timeRange = docsInterval(options);
  if (options.cursor) throw new AppError('INVALID_INPUT', 'Modified ordering is a bounded explicit-ID query, not a paginated Recent list.');
  const response = await session.request('/api/file/files/action/batch_get', {
    method: 'POST', safeRead: true, body: { ids }, signal: options.signal,
  });
  if (!Array.isArray(response.successItems)) throw new AppError('UNSUPPORTED_RESPONSE', 'Missing requested file metadata.');
  const byId = new Map(response.successItems.filter(file => ids.includes(file.id)).map(file => [file.id, file]));
  const unsupportedItems = [], items = [];
  for (const id of ids) {
    const file = byId.get(id), updatedAt = nativeTime(file?.updatedInfo?.time);
    if (!file) { unsupportedItems.push({ id, reason: 'NOT_RETURNED_OR_FORBIDDEN' }); continue; }
    const item = { ...fileSummary(file), updatedAt };
    if (!updatedAt) unsupportedItems.push({ ...item, reason: 'UNKNOWN_MODIFIED_TIME' });
    if (timeRange && (!updatedAt || (timeRange.since && updatedAt < timeRange.since) || updatedAt >= timeRange.until)) continue;
    items.push(item);
  }
  items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
  return strictRead({ operation: 'docs.modified', scope: 'explicit-document-ids', order: 'modified-at-descending',
    orderLocation: 'local', items, unsupportedItems, nextCursor: null, timeRange, freshness: observedFreshness(session),
    coverage: {
      pagination: dimension('complete', 'supplied-ids', [], true),
      content: dimension(unsupportedItems.length ? 'incomplete' : 'complete', 'supplied-file-metadata'),
      identity: dimension('unknown', 'file-actors', ['PROFILE_RESOLUTION_NOT_REQUESTED']),
      permission: dimension(unsupportedItems.some(item => item.reason === 'NOT_RETURNED_OR_FORBIDDEN') ? 'incomplete' : 'unknown', 'supplied-file-access'),
      category: dimension('complete', 'explicit-ids-only-not-native-recent', [], true),
    },
  }, options, ['content', 'pagination']);
}

async function readCoverage(session, result, options, action) {
  const diagnostics = result.coverage ?? {}, items = result.items ?? [];
  const contentRecords = items.flatMap(item => item.comments ?? [item]);
  const threads = action === 'comment-thread' ? (result.thread ? [result.thread] : []) : items;
  const reasons = [...new Set([...contentRecords.flatMap(item => item.coverage?.unsupported ?? []),
    ...(threads.some(item => item.anchor?.supported === false) ? ['UNSUPPORTED_COMMENT_ANCHOR'] : []),
    ...(diagnostics.unsupportedBlockIds?.length ? ['UNSUPPORTED_INLINE_COMMENT_ANCHOR'] : []),
    ...(result.notReturnedThreadIds?.length ? ['THREAD_NOT_RETURNED_FOR_STATUS'] : [])])];
  const paginationComplete = result.pagination?.complete === true;
  const contentComplete = reasons.length === 0 && (action === 'comment-thread' ? diagnostics.contentComplete === true
    : action === 'discussions' ? diagnostics.commentsComplete === true : action === 'comments');
  for (const item of [...items, ...(result.thread ? [result.thread] : [])]) {
    const resourceId = result.pageId;
    item.actor = actorObservation(session, item.createdBy, item.author, resourceId, '/api/comment');
    item.createdAt = nativeTime(item.createAt); item.updatedAt = nativeTime(item.modifyAt);
    if (item.threadStatus) item.state = item.threadStatus;
    for (const comment of item.comments ?? []) {
      comment.actor = actorObservation(session, comment.createdBy, comment.author, resourceId, '/api/comment');
      comment.createdAt = nativeTime(comment.createAt); comment.updatedAt = nativeTime(comment.modifyAt);
    }
  }
  const unsupportedItems = contentRecords.filter(item => item.coverage?.complete === false)
    .map(item => ({ id: item.id, reasons: item.coverage.unsupported, raw: item }));
  unsupportedItems.push(...threads.filter(item => item.anchor?.supported === false)
    .map(item => ({ id: item.id, reasons: ['UNSUPPORTED_COMMENT_ANCHOR'], raw: item })),
    ...(diagnostics.unsupportedBlockIds ?? []).map(blockId => ({ blockId, reason: 'UNSUPPORTED_INLINE_COMMENT_ANCHOR' })),
    ...(result.notReturnedThreadIds ?? []).map(id => ({ id, reason: 'THREAD_NOT_RETURNED_FOR_STATUS' })));
  const identityCoverage = await enrichActors(session,
    items.flatMap(item => [item, ...(item.comments ?? [])]).concat(result.thread ? [result.thread] : []), options);
  if (contentRecords.some(item => Array.isArray(item.reactions) && item.reactions.length)) {
    identityCoverage.status = 'incomplete';
    identityCoverage.reasons.push('REACTION_ACTOR_SCHEMA_UNVERIFIED');
  }
  return strictRead({ ...result, operation: `docs.${action}`, diagnostics, unsupportedItems,
    freshness: observedFreshness(session),
    coverage: {
      pagination: dimension(paginationComplete ? 'complete' : 'incomplete', result.pagination?.kind ?? 'native-comment-scope',
        result.pagination?.reason ? [result.pagination.reason] : result.nextCursor ? ['MORE_PAGES'] : []),
      content: dimension(contentComplete ? 'complete' : 'incomplete', 'returned-thread-content', reasons),
      identity: identityCoverage,
      permission: dimension('unknown', 'comment-access', ['COMMENT_VISIBILITY_IS_NOT_COLLABORATOR_COMPLETENESS']),
      category: dimension(action === 'comment-thread' ? 'complete' : 'incomplete', diagnostics.scope ?? 'exact-thread',
        action === 'comment-thread' ? [] : ['OTHER_COMMENT_CATEGORIES_AND_DESCENDANTS_NOT_ENUMERATED']),
    },
  }, options, ['pagination', 'content', 'identity', 'category']);
}

function treeCoverage(session, result, options) {
  const diagnostics = result.coverage;
  const contentIssues = result.pages.flatMap(page => page.coverage.issues.map(issue => ({ pageId: page.pageId, ...issue })));
  const pageIssues = diagnostics.issues.map(issue => ({ pageId: issue.id ?? null, reason: issue.reason,
    diagnostic: issue.diagnostic ?? null, opaqueEvidence: issue.opaqueEvidence ?? null }));
  const unsupportedItems = [...contentIssues, ...pageIssues];
  const unsupportedBlocks = new Map();
  for (const issue of contentIssues) {
    const key = `${issue.pageId}:${issue.blockId}`;
    const block = unsupportedBlocks.get(key) ?? { pageId: issue.pageId, blockId: issue.blockId ?? null, reasons: [] };
    if (!block.reasons.includes(issue.reason)) block.reasons.push(issue.reason);
    unsupportedBlocks.set(key, block);
  }
  const unresolvedDescendants = { knownUnreadPageIds: diagnostics.unreadPageIds,
    unknownBelowPageIds: [...new Set(diagnostics.issues.filter(issue => issue.descendantsUnknown).map(issue => issue.id ?? issue.parentId ?? result.rootPageId))] };
  const paginationReasons = diagnostics.issues.map(issue => issue.reason);
  const contentReasons = [...new Set([...contentIssues.map(issue => issue.reason), ...pageIssues.map(issue => issue.reason)])];
  return strictRead({ ...result, operation: 'docs.read', diagnostics, unresolvedDescendants, unsupportedItems,
    unsupportedBlocks: [...unsupportedBlocks.values()],
    loadedPageCount: result.pages.length,
    loadedPages: result.pages.map(page => ({ pageId: page.pageId, version: page.version,
      blockCount: page.blocks.length, contentStatus: page.coverage.status, decodeEvidence: page.decodeEvidence })),
    freshness: observedFreshness(session),
    coverage: {
      pagination: dimension(paginationReasons.length ? 'incomplete' : 'complete', 'discovered-page-tree', paginationReasons),
      content: dimension(contentReasons.length || diagnostics.unreadPageIds.length ? 'incomplete' : 'complete', 'decoded-pages',
        contentReasons),
      identity: dimension('unknown', 'block-and-page-actors', ['PROFILE_RESOLUTION_NOT_REQUESTED']),
      permission: dimension(diagnostics.unreadPageIds.length ? 'incomplete' : 'unknown', 'discovered-page-access',
        ['VISIBLE_TREE_IS_NOT_PERMISSION_EXHAUSTIVENESS']),
      category: dimension('unknown', 'supported-doc-page-block-schema', ['STREAMING_DATABASE_AND_OTHER_FILE_TYPES_UNSUPPORTED']),
    },
  }, options, ['pagination', 'content', 'category']);
}

function permissionCoverage(session, result, options) {
  const diagnostics = result.coverage, permission = result.sources.permission?.data;
  const settingField = permission?.currentLinkAccess !== undefined ? 'currentLinkAccess' : 'linkAccess';
  const setting = permission?.[settingField];
  const linkRole = setting?.role?.newRole ?? null;
  const validGrant = ['owner', 'co-owner', 'editor', 'commenter', 'viewer', 'member'].includes(linkRole)
    && !diagnostics.issues.some(issue => issue.path === `permission.${settingField}` || issue.path?.startsWith(`permission.${settingField}.`));
  let visibility = 'unknown';
  if (validGrant && setting.settingItem === 'linkPermissionSetting') visibility = 'link';
  if (validGrant && setting.settingItem === 'accountPermissionSetting') visibility = 'account';
  // Even a null link grant is not proof of private visibility: inherited/meeting grants can exist.
  return strictRead({ ...result, operation: 'docs.permissions', diagnostics,
    visibility: { effective: visibility, linkRole, rawFlags: {
      linkAccess: permission?.linkAccess ?? null, currentLinkAccess: permission?.currentLinkAccess ?? null,
      anyoneWithLinkEnabled: permission?.anyoneWithLinkEnabled ?? null,
    } },
    collaborators: { items: (Array.isArray(permission?.collaborators) ? permission.collaborators : []).map(grant => ({ ...grant,
      actor: actorObservation(session, grant?.user?.id, grant?.user, result.file.id, '/api/file/files/:id/permission') })),
      complete: diagnostics.complete && diagnostics.serverExhaustivenessVerified === true },
    coverage: {
      pagination: dimension('unknown', 'permission-documents', ['NO_NATIVE_PAGINATION_EXHAUSTIVENESS_EVIDENCE']),
      content: dimension(diagnostics.complete ? 'complete' : 'incomplete', 'supported-visible-permission-fields',
        [...new Set(diagnostics.issues.map(issue => issue.reason))]),
      identity: dimension('unknown', 'collaborator-observations', ['DOCUMENT_GRANTS_ARE_NOT_GLOBAL_PROFILES']),
      permission: dimension(diagnostics.complete ? 'unknown' : 'incomplete', 'visible-permission-sources',
        ['SERVER_EXHAUSTIVENESS_UNVERIFIED']),
    },
  }, options, ['content', 'permission']);
}

async function permissionsBatch(session, options) {
  const ids = selectedIds(options), concurrency = Number(options.concurrency ?? 2);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new AppError('INVALID_INPUT', 'Use --concurrency 1..4.');
  const items = new Array(ids.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (index < ids.length) {
      const at = index++, id = ids[at];
      if (options.signal?.aborted) { items[at] = { id, status: 'cancelled', code: 'REQUEST_CANCELLED' }; continue; }
      let requests = 0;
      const scopedSession = { identity: session.identity, request: (path, requestOptions) => {
        requests++;
        return session.request(path, { ...requestOptions, signal: options.signal });
      } };
      try {
        const result = permissionCoverage(session, await inspectPermissions(scopedSession, id,
          { signal: options.signal, preservePartialOnCancel: true }), {});
        const cancelled = Object.values(result.sources).some(source => source.status === 'cancelled');
        items[at] = { id, status: cancelled ? 'cancelled' : 'received', ...(cancelled ? { code: 'REQUEST_CANCELLED' } : {}), result,
          attempts: { servicePasses: 1, requests, transportAttempts: null, retryOwner: 'session' } };
      }
      catch (error) { items[at] = { id, status: error.code === 'REQUEST_CANCELLED' || error.name === 'AbortError' ? 'cancelled' : 'failed', code: error.name === 'AbortError' ? 'REQUEST_CANCELLED' : error.code ?? 'REQUEST_FAILED',
        attempts: { servicePasses: 1, requests, transportAttempts: null, retryOwner: 'session' } }; }
    }
  }));
  const failed = items.filter(item => item.status !== 'received');
  return strictRead({ operation: 'docs.permissions-batch', items, concurrency,
    coverage: { pagination: dimension('complete', 'supplied-ids', [], true),
      content: dimension(failed.length || items.some(item => item.result?.coverage.content.status === 'incomplete') ? 'incomplete' : 'complete',
        'per-document-results', [...failed.map(item => item.code), ...new Set(items.flatMap(item => item.result?.coverage.content.reasons ?? []))]),
      permission: dimension(failed.length || items.some(item => item.result?.coverage.permission.status === 'incomplete') ? 'incomplete' : 'unknown',
        'visible-per-document-permissions', ['SERVER_EXHAUSTIVENESS_UNVERIFIED']) },
  }, options, ['content', 'permission']);
}

async function resolveActors(session, options) {
  const ids = selectedIds(options), items = [], unsupportedItems = [];
  if (ids.length > 20) throw new AppError('INVALID_INPUT', 'Native identity resolution is bounded to 20 IDs.');
  if (options.identityDb) throw new AppError('UNSUPPORTED_CAPABILITY', 'An identity database is not implemented; no implicit cache is used.');
  let cancelled = false;
  for (const id of ids) {
    if (cancelled || options.signal?.aborted) { unsupportedItems.push({ id, reason: 'REQUEST_CANCELLED' }); continue; }
    try {
      const result = await session.request('/api/file/files/user/vcard', {
        method: 'POST', safeRead: true, body: { userId: id }, signal: options.signal,
      });
      if (result.vcard?.userId !== id) throw new AppError('IDENTITY_MISMATCH', 'Native identity did not match the requested actor.');
      const card = result.vcard;
      // isExternal=false is native account-scope evidence; missing evidence does not assign a tenant.
      const accountId = result.isExternal === false ? session.identity.user.accountId : null;
      items.push(actorObservation(session, id, { accountId, displayName: card.nickName ?? card.displayName,
        email: card.email }, null, '/api/file/files/user/vcard'));
    } catch (error) {
      cancelled = error.code === 'REQUEST_CANCELLED' || error.name === 'AbortError';
      unsupportedItems.push({ id, reason: cancelled ? 'REQUEST_CANCELLED' : error.code ?? 'IDENTITY_LOOKUP_FAILED' });
    }
  }
  return strictRead({ operation: 'docs.identities', items, unsupportedItems, cache: { enabled: false },
    coverage: { identity: dimension(unsupportedItems.length || items.some(item => !item.identity.accountId) ? 'incomplete' : 'complete',
      'explicit-native-user-ids', [...new Set([...unsupportedItems.map(item => item.reason),
        ...(items.some(item => !item.identity.accountId) ? ['GLOBAL_IDENTITY_TENANT_UNVERIFIED'] : [])])]) },
  }, options, ['identity']);
}

async function folders(session, options) {
  const limit = Number(options.limit ?? 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError('INVALID_INPUT', 'Folders requires --limit 1..100.');
  let root;
  if (options.id) {
    const id = fileId(options.id);
    const response = await session.request('/api/file/files/action/batch_get', { method: 'POST', safeRead: true, body: { ids: [id] } });
    root = response.successItems?.find(file => file.id === id);
  } else root = (await session.request('/api/file/my_space')).mySpace;
  if (!root?.id || !['space', 'folder'].includes(root.fileType)) {
    throw new AppError('UNSUPPORTED_FOLDER_SCOPE', 'Native enumeration requires a visible folder or personal space, not a document or an inferred root.');
  }
  const scope = ['docs folders', session.identity.user.userId, session.identity.user.accountId, root.id];
  const position = options.cursor ? decodeCursor(options.cursor, scope) : null;
  const response = await session.request('/api/hub/files/action/batch_get_children_by_limit', {
    method: 'POST', safeRead: true, base: root.fileClusterApiPrefix,
    body: { parentId: root.id, accountId: session.identity.user.accountId, limit, sortBy: 'lastModifiedTime',
      pageToken: position?.token ?? '', flatten: false },
  });
  if (!Array.isArray(response.children) || typeof response.nextPageToken !== 'string') {
    throw new AppError('UNSUPPORTED_RESPONSE', 'Native folder children or pagination are missing.');
  }
  const unsupportedItems = [], children = [];
  for (const [index, file] of response.children.entries()) {
    if (index >= limit) { unsupportedItems.push({ reason: 'NATIVE_LIMIT_NOT_RESPECTED', nativeIndex: index, raw: file }); continue; }
    if (!file || typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(file.id)) {
      unsupportedItems.push({ reason: 'MALFORMED_CHILD_ID', nativeIndex: index, raw: file }); continue;
    }
    children.push(fileSummary(file));
    if (!['folder', 'doc'].includes(file.fileType)) unsupportedItems.push({ id: file.id, reason: 'UNSUPPORTED_CHILD_FILE_TYPE', raw: file });
  }
  const page = documentPage(children, response.nextPageToken, scope, position?.seen);
  if (position?.token === response.nextPageToken || response.children.length > limit) {
    page.nextCursor = null; page.pagination = { status: 'incomplete', complete: false,
      reason: response.children.length > limit ? 'NATIVE_LIMIT_NOT_RESPECTED' : 'NONADVANCING_NATIVE_CURSOR' };
  }
  return strictRead({ ...page, operation: 'docs.folders', parent: fileSummary(root),
    scope: 'immediate-native-parent-children', items: page.items.filter(file => file.type === 'folder'),
    otherChildren: page.items.filter(file => file.type !== 'folder'), filterLocation: 'local',
    unsupportedItems, freshness: observedFreshness(session),
    limitations: ['NOT_ALL_ACCOUNT_FOLDERS', 'SHARED_SPACES_NOT_ENUMERATED', 'NO_RECURSIVE_DESCENDANT_ENUMERATION'],
    coverage: {
      pagination: dimension(page.pagination.complete ? 'complete' : 'incomplete', 'native-parent-children',
        page.pagination.reason ? [page.pagination.reason] : page.nextCursor ? ['MORE_NATIVE_PAGES'] : []),
      content: dimension(unsupportedItems.length ? 'incomplete' : 'complete', 'returned-folder-metadata',
        [...new Set(unsupportedItems.map(item => item.reason))]),
      identity: dimension('unknown', 'folder-actors', ['PROFILE_RESOLUTION_NOT_REQUESTED']),
      permission: dimension('unknown', 'visible-parent-children', ['HIDDEN_CHILDREN_NOT_PROVEN_ABSENT']),
      category: dimension('incomplete', 'personal-space-or-explicit-folder', ['OTHER_ROOTS_AND_DESCENDANTS_NOT_ENUMERATED']),
    },
  }, options, ['pagination', 'content', 'category']);
}

function docsCapabilities() {
  return { operation: 'docs.capabilities', browserFallback: { automatic: false, requiresApproval: true, readStateRisk: true,
    relay: { automatic: false, implemented: false, limitation: 'NO_IMPLICIT_RELAY_SESSION_OR_ACTIVE_TAB_REUSE' } },
    capabilities: {
      notifications: { source: '/api/notification/groupByFile', scope: 'native-global-notification-center',
        availability: 'implemented', disposition: 'implemented', fallback: false, noFallback: true,
        limitation: 'Mirrors the native account-wide notification UI grouped feed and returns only the latest notification per file group. Global content coverage is incomplete: older notifications, including hidden mentions, may not be returned and absence is not evidence of absence. Normalized mentions are emitted only when structured person elements are available; notification requests are not delivery proof.',
        excludes: ['document-for-me', 'browser-history', 'comment-scans'] },
      documentForMe: { source: '/api/notification/forMe', scope: 'bounded-document-native-records',
        availability: 'implemented', disposition: 'implemented',
        evidencedCategories: ['content-mention', 'comment-mention', 'comment-reply', 'addCollaboration'],
        excludes: ['global-notification-center'] },
      unread: { source: 'native-notification-read-boolean', filterLocation: 'local', excludes: ['ordinary-history', 'comment-scans'] },
      recent: { source: '/api/file/recent', order: 'native', excludes: ['modified-order', 'browser-local-recent'] },
      modified: { scope: 'explicit-ids', order: 'modified-at-descending', excludes: ['native-recent', 'all-accessible-documents'] },
      folders: { source: '/api/hub/files/action/batch_get_children_by_limit', scope: 'immediate-parent-children',
        excludes: ['all-account-folders', 'shared-space-discovery', 'recursive-descendants'] },
      starred: { status: 'unsupported', reason: 'NATIVE_STARRED_ENUMERATION_NOT_IMPLEMENTED' },
      browserLocalState: { status: 'unsupported', reason: 'COOKIE_ONLY_SERVER_READS' },
      identityDatabase: { status: 'unsupported', reason: 'EXPLICIT_BOUNDED_NATIVE_LOOKUPS_NO_CACHE' },
      pinnerIdentities: { status: 'unsupported', reason: 'NATIVE_PINNER_ENUMERATION_NOT_VERIFIED' },
      reactionActorIdentities: { status: 'unsupported', reason: 'NATIVE_REACTION_ACTOR_SCHEMA_NOT_VERIFIED' },
      renderer: { status: 'outside-repository', reason: 'NO_RENDERER_OR_CONSUMER_ARTIFACT_MUTATIONS' },
    } };
}

export function validateDocsOptions(action, options = {}) {
  const commandStartedAt = options.commandStartedAt ?? Date.now();
  if (!Number.isSafeInteger(commandStartedAt) || commandStartedAt < 0) throw new AppError('INVALID_INPUT', 'Invalid command-start timestamp.');
  const normalized = { ...options, commandStartedAt };
  if (options.strict !== undefined && typeof options.strict !== 'boolean') throw new AppError('INVALID_INPUT', '--strict is a boolean flag.');
  if (['notifications', 'modified'].includes(action)) docsInterval(normalized);
  else if (options.since !== undefined || options.until !== undefined || options.timezone !== undefined) {
    throw new AppError('INVALID_INPUT', 'Time bounds are supported only by native notifications and explicit-ID modified ordering.');
  }
  if (['notifications', 'recent', 'folders'].includes(action)) {
    const limit = Number(options.limit ?? 50), max = action === 'notifications' ? 50 : 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) throw new AppError('INVALID_INPUT', `Use --limit 1..${max}.`);
    if (options.id !== undefined) fileId(options.id);
  }
  if (action === 'notifications' && !['all', 'unread'].includes(options.state ?? 'all')) throw new AppError('INVALID_INPUT', 'Use --state all|unread.');
  if (['modified', 'identities', 'permissions-batch'].includes(action)) {
    const ids = selectedIds(options);
    if (action === 'identities' && ids.length > 20) throw new AppError('INVALID_INPUT', 'Use at most 20 identity IDs.');
    if (options.cursor !== undefined) throw new AppError('INVALID_INPUT', 'Explicit-ID queries do not accept cursors.');
  }
  if (action === 'permissions-batch') {
    const concurrency = Number(options.concurrency ?? 2);
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new AppError('INVALID_INPUT', 'Use --concurrency 1..4.');
  }
  if (options.identityDb !== undefined || options['identity-db'] !== undefined) throw new AppError('UNSUPPORTED_CAPABILITY', 'Identity caching is not implemented; no hidden cache is used.');
  if (options.cursor !== undefined && (typeof options.cursor !== 'string' || options.cursor.length > 60000 || !/^[A-Za-z0-9_-]+$/.test(options.cursor))) {
    throw new AppError('INVALID_INPUT', 'Malformed Docs cursor.');
  }
  return normalized;
}

export async function runDocs(session, action, options) {
  options = validateDocsOptions(action, options);
  if (action === 'capabilities') return docsCapabilities();
  if (options.signal) {
    const original = session;
    session = { identity: original.identity,
      request: (path, requestOptions) => original.request(path, { ...requestOptions, signal: options.signal }) };
  }
  if (action === 'notifications') return notificationInbox(session, options);
  if (action === 'recent') return recentDocuments(session, options);
  if (action === 'modified') return modifiedDocuments(session, options);
  if (action === 'identities') return resolveActors(session, options);
  if (action === 'permissions-batch') return permissionsBatch(session, options);
  if (action === 'folders') return folders(session, options);
  if (action === 'starred') throw new AppError('UNSUPPORTED_CAPABILITY',
    'This native enumeration has not been verified; it is not replaced by Recent or document search.',
    { operation: `docs.${action}`, phase: 'capability', capability: docsCapabilities().capabilities[action] });
  if (action === 'import-markdown') return importMarkdown(session, options);
  if (action === 'export-markdown') return exportMarkdown(session, options);
  if (action === 'comment-context') return commentContext(session, fileId(options.id), options);
  if (action === 'comment-create') return createAnchoredComment(session, fileId(options.id), options);
  if (action === 'comment-reply') return replyComment(session, fileId(options.id), options);
  if (action === 'comment-download') return downloadCommentAttachment(session, fileId(options.id), options);
  if (['comment-resolve', 'comment-reopen'].includes(action)) return changeCommentStatus(session, fileId(options.id), options, action === 'comment-resolve' ? 'resolved' : 'open');
  if (action === 'discussions') return readCoverage(session, await discussions(session, fileId(options.id), options), options, action);
  if (action === 'resolve') return resolveDocument(session, options.query);
  if (action === 'user') {
    const result = await resolveUser(session, options.email);
    return { ...result, ...actorObservation(session, result.user.userId, result.user, null, '/api/user/contact+native-vcard'),
      match: { quality: 'exact-email-and-native-profile', uniquenessScope: 'returned-native-candidates', searchExhaustive: false },
      cache: { enabled: false } };
  }
  if (action === 'share') return shareDocument(session, fileId(options.id), options);
  if (action === 'unshare') return removeCollaborator(session, fileId(options.id), options);
  if (action === 'find' || action === 'search') {
    const body = { pageSize: Number(options.limit ?? 30), query: options.query, fileTypes: ['database', 'doc', 'page'] };
    if (action === 'find') body.titleOnly = true;
    const scope = [`docs ${action}`, options.query ?? '', session.identity.user.userId, session.identity.user.accountId];
    const position = options.cursor ? decodeCursor(options.cursor, scope) : null;
    if (position) body.pageToken = position.token;
    const result = await session.request('/api/search/file', { method: 'POST', safeRead: true, body });
    if (!Array.isArray(result.items) || (result.pageToken !== undefined && typeof result.pageToken !== 'string')) {
      throw new AppError('UNSUPPORTED_RESPONSE', 'Missing native search records or continuation.');
    }
    const malformed = result.items.filter(item => typeof item?.file?.id !== 'string');
    const items = result.items.filter(item => typeof item?.file?.id === 'string')
      .map(item => ({ ...fileSummary(item.file), highlight: item.highlight }));
    const page = documentPage(items, result.pageToken, scope, position?.seen);
    if (position?.token && position.token === result.pageToken) {
      page.nextCursor = null; page.pagination = { status: 'incomplete', complete: false, reason: 'NONADVANCING_NATIVE_CURSOR' };
    }
    const unsupportedItems = [...malformed.map(raw => ({ reason: 'MALFORMED_SEARCH_RECORD', raw })),
      ...items.filter(item => !item.readSupported).map(item => ({ ...item, reason: 'UNSUPPORTED_FILE_TYPE' }))];
    return strictRead({ ...page, operation: `docs.${action}`, totalCount: result.totalCount,
      scope: action === 'find' ? 'title-search' : 'content-search', unsupportedItems, freshness: observedFreshness(session),
      coverage: {
        pagination: dimension(page.pagination.complete ? 'complete' : 'incomplete', 'native-search-pages',
          page.pagination.reason ? [page.pagination.reason] : page.nextCursor ? ['MORE_NATIVE_PAGES'] : []),
        content: dimension(unsupportedItems.length ? 'incomplete' : 'complete', 'returned-search-records'),
        identity: dimension('unknown', 'search-actors', ['PROFILE_RESOLUTION_NOT_REQUESTED']),
        permission: dimension('unknown', 'search-index-access', ['INDEX_PRESENCE_IS_NOT_CURRENT_ACCESS']),
        category: dimension('unknown', 'native-search-index', ['SEARCH_EXHAUSTIVENESS_UNPROVEN']),
      },
    }, options, ['pagination', 'content', 'category']);
  }
  if (action === 'rename') {
    const id = fileId(options.id);
    const context = { operation: 'docs.rename', operationId: randomUUID(), documentId: id };
    let submitted = false, accepted = false;
    try {
      const file = await metadata(session, id);
      if (file.privilege?.permissionWithReason?.modifyMetadata?.hasPermission !== true) throw new AppError('FORBIDDEN', 'This session cannot rename the document.');
      submitted = true;
      await session.request('/api/file/files/title', { method: 'PUT', base: file.fileClusterApiPrefix, body: { id, title: options.title, stopSync: false } });
      accepted = true;
      const after = await metadata(session, id);
      if (after.title !== options.title) throw new AppError('READBACK_MISMATCH', 'Rename title readback did not match.');
      return { file: fileSummary(after), ...context, outcome: 'confirmed', verified: true };
    } catch (error) {
      throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }, accepted ? 'unknown' : submitted ? undefined : 'not_sent');
    }
  }
  if (action === 'read') return treeCoverage(session, await readDocumentTree(session, fileId(options.id)), options);
  if (action === 'permissions') return permissionCoverage(session, await inspectPermissions(session, fileId(options.id),
    { signal: options.signal, preservePartialOnCancel: true }), options);
  if (action === 'set-role') return setCollaboratorRole(session, fileId(options.id), options);
  if (action === 'append') return append(session, fileId(options.id), options.text, options);
  if (action === 'insert') return insertParagraph(session, fileId(options.id), options);
  if (action === 'replace') return replaceParagraph(session, fileId(options.id), options);
  if (action === 'comments') return readCoverage(session, await commentThreads(session, fileId(options.id), options), options, action);
  if (action === 'comment-thread') return readCoverage(session, await commentThread(session, fileId(options.id), options), options, action);
  if (action === 'create') {
    const context = { operation: 'docs.create', operationId: randomUUID(), title: options.title };
    let accepted = false;
    try {
      const response = await session.request('/api/file/files', { method: 'POST', body: { fileType: 'doc', accountId: session.identity.user.accountId, parentId: 'my-docs', title: options.title } });
      accepted = true;
      const file = response.files?.[0];
      if (!file?.id) throw new AppError('MISSING_CREATED_ID', 'Create returned no document ID. Inspect My docs before retrying.');
      Object.assign(context, { createdDocumentId: file.id, createdDocumentUrl: file.fileLink, documentId: file.id });
      const result = await append(session, file.id, options.text, {}, await readPage(session, file.id, file));
      return { ...result, ...context };
    } catch (error) {
      throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved',
        ...(error?.details?.outcome ? { contentOutcome: error.details.outcome } : {}) }, accepted ? 'unknown' : undefined);
    }
  }
  throw new AppError('INVALID_INPUT', 'Unknown Docs command.');
}
