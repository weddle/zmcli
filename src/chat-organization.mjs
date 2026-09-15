import { createHash, randomUUID } from 'node:crypto';
import { AppError, writeFailure } from './session.mjs';
import { xml } from './chat-xml.mjs';

export const organizationActions = new Set(['folders', 'folder-create', 'folder-rename', 'folder-delete', 'folder-add', 'folder-remove', 'folder-move', 'starred', 'star', 'unstar']);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f\p{Cs}\ufffe\uffff]/u.test(value);
const nativeOrder = value => (typeof value === 'string' && text(value) && /^-?\d+(?:\.\d+)?$/.test(value))
  || (typeof value === 'number' && Number.isSafeInteger(value));
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = message => { throw new AppError('INVALID_INPUT', message); };

async function catalog(chat, stars) {
  const self = chat.from.split('/')[0], user = self.split('@')[0];
  const response = await chat.request(stars ? '/xms/login/star/list' : '/xms/login/folders/list', {
    body: stars ? { userId: user } : { type: [0, 1], folders: [] },
  });
  if (response.result !== 0 || !Array.isArray(response.data) || response.data.length > 1000) {
    throw new AppError('UNSUPPORTED_CONTENT', 'Native personal organization index is unrecognized or exceeds the 1000-record bound.');
  }
  const items = response.data.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new AppError('UNSUPPORTED_CONTENT', 'Native personal organization index contains a malformed record.');
    }
    let id, identity;
    if (stars) {
      const known = new Set(['hsession_id', 'channel_id', 'name', 'type', 'avatar', 'peer_contact_email',
        'peer_contact_user_id', 'i', 'index', 'order']);
      const unsupportedOrderFields = ['index', 'order'].filter(field => Object.hasOwn(row, field));
      if (unsupportedOrderFields.length || (Object.hasOwn(row, 'i') && !nativeOrder(row.i))) {
        throw new AppError('UNSUPPORTED_CONTENT', 'Starred session contains conflicting or unrecognized explicit ordering.');
      }
      const orderField = Object.hasOwn(row, 'i') ? 'i' : null, order = orderField === null ? null : row.i;
      if (row.type === 'groupchat') {
        if (!text(row.channel_id) || ![row.channel_id, row.channel_id.split('@')[0]].includes(row.hsession_id)) {
          throw new AppError('UNSUPPORTED_CONTENT', 'Starred channel identity is unrecognized.');
        }
        id = row.channel_id;
        identity = { kind: 'channel-jid', source: 'channel_id-and-hsession_id', actorRelation: 'not-applicable',
          sessionVariant: row.hsession_id === row.channel_id ? 'channel-jid' : 'channel-local-id' };
      } else if (row.type === 'chat') {
        const pair = typeof row.hsession_id === 'string' ? row.hsession_id.split(':') : [];
        const nativePeer = row.peer_contact_user_id;
        if (pair.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(nativePeer ?? '') || !pair.includes(nativePeer)
          || row.channel_id != null) {
          throw new AppError('UNSUPPORTED_CONTENT', 'Starred direct-chat identity is unrecognized.');
        }
        const actorIncluded = pair.includes(user);
        if (!actorIncluded && !(pair[0] === nativePeer && pair[1] === nativePeer)) {
          throw new AppError('UNSUPPORTED_CONTENT', 'Starred direct-chat identity does not include this actor or the evidenced repeated-peer session identity.');
        }
        const peer = actorIncluded ? (pair[0] === user ? pair[1] : pair[0]) : nativePeer;
        if (peer !== nativePeer) throw new AppError('UNSUPPORTED_CONTENT', 'Starred direct-chat peer identity conflicts with its session identity.');
        id = `${peer}@${self.split('@')[1]}`;
        identity = { kind: actorIncluded ? (peer === user ? 'self-jid' : 'peer-jid') : 'peer-jid',
          source: 'hsession_id-and-peer_contact_user_id', actorRelation: actorIncluded ? (peer === user ? 'self' : 'peer') : 'unknown',
          sessionVariant: actorIncluded ? (peer === user ? 'self-pair' : pair[0] === user ? 'actor-peer' : 'peer-actor') : 'repeated-peer' };
      } else {
        throw new AppError('UNSUPPORTED_CONTENT', 'Starred session type is not a verified native shape.');
      }
      if (!text(id)) throw new AppError('UNSUPPORTED_CONTENT', 'Starred session identity is unrecognized.');
      return { id, type: row.type, name: typeof row.name === 'string' ? row.name : null,
        index: order === null ? null : String(order), order: { field: orderField, value: order === null ? null : String(order) },
        identity, unknownFields: Object.keys(row).filter(field => !known.has(field)).sort() };
    }
    if (!text(row.folderID) || typeof row.name !== 'string' || ![0, 1].includes(row.type)
      || row.username !== user || !Number.isSafeInteger(row.version) || !Number.isSafeInteger(row.sortType)
      || !nativeOrder(row.index) || (row.members !== undefined && !Array.isArray(row.members))
      || (row.members?.length ?? 0) > 1000 || row.members?.some(member => !text(member.objid) || !nativeOrder(member.index))
      || new Set((row.members ?? []).map(member => member.objid)).size !== (row.members?.length ?? 0)) {
      throw new AppError('UNSUPPORTED_CONTENT', 'Folder identity, actor, version or members are unrecognized.');
    }
    return { id: row.folderID, name: row.name, type: row.type, version: row.version, index: String(row.index),
      sortType: row.sortType, members: row.members ?? [], native: row };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) throw new AppError('UNSUPPORTED_CONTENT', 'Personal organization index repeats an identity.');
  return { items, state: fingerprint(items.map(({ native, unknownFields, ...item }) => ({
    ...item, ...(item.members ? { members: item.members.map(member => ({ id: member.objid, index: String(member.index) })).sort((a, b) => a.id.localeCompare(b.id)) } : {}),
  })).sort((a, b) => a.id.localeCompare(b.id))),
    scope: stars ? 'native-personal-star-index' : 'native-personal-folder-index',
    snapshot: false,
    pagination: stars
      ? { complete: null, status: 'unknown', continuation: 'none', snapshot: false, recordsBound: 1000 }
      : { complete: null, status: 'unknown', nativeContinuation: false, recordsBound: 1000 },
    ordering: stars
      ? { fields: [...new Set(items.map(item => item.order.field).filter(Boolean))], direction: 'unknown', responseOrderPreserved: true }
      : { field: 'index', direction: 'unknown', responseOrderPreserved: true } };
}

export async function runOrganization(chat, action, options, resolveTarget) {
  const stars = ['starred', 'star', 'unstar'].includes(action);
  const before = await catalog(chat, stars);
  if (action === 'folders' || action === 'starred') return before;
  if (typeof options['if-state'] !== 'string' || options['if-state'] !== before.state) {
    throw new AppError('ORGANIZATION_CHANGED', 'Supply the exact current index --if-state. Nothing sent.');
  }
  const requestId = randomUUID(), context = { operation: `chat.${action}`, requestId };
  let payload, verify;
  const folder = id => {
    const item = before.items.find(item => item.id === id);
    if (!item || item.type !== 0) throw new AppError('FORBIDDEN', 'Only an exact existing ordinary personal folder may be changed; system folders are excluded.');
    return item;
  };
  const order = () => {
    if (typeof options.index !== 'string' || !/^\d{1,9}$/.test(options.index)) invalid('Supply a decimal --index of at most nine digits.');
    return options.index;
  };
  if (stars) {
    const target = await resolveTarget();
    const present = before.items.some(item => item.id === target);
    if (present === (action === 'star')) return { ...context, outcome: 'unchanged', ...before };
    payload = `<query sync="true" xmlns="jabber:iq:private"><starsession storage="${action === 'star' ? 'add' : 'remove'}" xmlns="zoom:iq:starsession"><item v="${xml(target)}"${action === 'star' ? ` i="${order()}"` : ''}/></starsession></query>`;
    verify = after => after.items.some(item => item.id === target) === (action === 'star');
  } else {
    let contents;
    if (action === 'folder-create') {
      if (!text(options.name) || !options.name.trim()) invalid('Supply a non-empty folder name of at most 512 characters.');
      if (before.items.some(item => item.name === options.name)) throw new AppError('AMBIGUOUS_FOLDER', 'A folder already has the supplied name. Nothing sent.');
      contents = `<folder action="create" index="${order()}" name="${xml(options.name)}" sort_type="3" type="0" f_ver="1"/>`;
      verify = after => after.items.filter(item => item.type === 0 && item.name === options.name && !before.items.some(old => old.id === item.id)).length === 1;
    } else {
      const current = folder(options.folder);
      context.folderId = current.id;
      if (action === 'folder-delete') {
        if (current.members.length) throw new AppError('FOLDER_NOT_EMPTY', 'Remove explicitly selected members before deleting this folder.');
        contents = `<folder action="delete" id="${xml(current.id)}"/>`;
        verify = after => !after.items.some(item => item.id === current.id);
      } else if (action === 'folder-rename') {
        if (!text(options.name) || !options.name.trim()) invalid('Supply a non-empty folder name of at most 512 characters.');
        if (before.items.some(item => item.id !== current.id && item.name === options.name)) throw new AppError('AMBIGUOUS_FOLDER', 'Another folder already has this name.');
        contents = `<folder action="update"><item id="${xml(current.id)}" index="${xml(current.index)}" name="${xml(options.name)}" sort_type="${current.sortType}" type="0" f_ver="1"/></folder>`;
        verify = after => after.items.find(item => item.id === current.id)?.name === options.name;
      } else {
        const target = await resolveTarget(), present = current.members.some(member => member.objid === target);
        if (action === 'folder-add') {
          if (present) return { ...context, outcome: 'unchanged', ...before };
          contents = `<folder action="add" id="${xml(current.id)}"><item index="${order()}" v="${xml(target)}"/></folder>`;
          verify = after => after.items.find(item => item.id === current.id)?.members.some(member => member.objid === target);
        } else {
          if (!present) throw new AppError('ORGANIZATION_CHANGED', 'The exact session is absent from the source folder. Nothing sent.');
          contents = `<folder action="remove" id="${xml(current.id)}"><item v="${xml(target)}"/></folder>`;
          const absent = after => after.items.some(item => item.id === current.id && !item.members.some(member => member.objid === target));
          if (action === 'folder-move') {
            const destination = folder(options.destination);
            if (destination.id === current.id || destination.members.some(member => member.objid === target)) invalid('Choose a different destination without the selected session.');
            contents = `<folder action="add" id="${xml(destination.id)}"><item index="${order()}" v="${xml(target)}"/></folder>${contents}`;
            verify = after => absent(after) && after.items.find(item => item.id === destination.id)?.members.some(member => member.objid === target);
          } else verify = absent;
        }
      }
    }
    payload = `<query sync="true" xmlns="zoom:iq:folders">${contents}</query>`;
  }
  let accepted = false;
  try {
    await chat.sendIq(`<iq from="${xml(chat.from)}" id="${xml(requestId)}" type="set" xmlns="jabber:client">${payload}</iq>`, requestId);
    accepted = true;
    const after = await catalog(chat, stars);
    if (!verify(after)) throw new AppError('READBACK_MISMATCH', 'The requested personal organization transition was not observed. Reconcile the index before retrying.');
    return { ...context, ...after, outcome: 'confirmed', acceptance: 'native-iq-and-index-readback', concurrency: 'non-atomic-index-precondition' };
  } catch (error) { throw writeFailure(error, { ...context, acceptance: accepted ? 'accepted' : 'unobserved' }); }
}
