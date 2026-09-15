import { DynamicBorder, getMarkdownTheme, getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { Input, Markdown, SelectList, Text, fuzzyFilter, matchesKey, stripTerminalSequences } from '@earendil-works/pi-tui';

const text = value => stripTerminalSequences(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
const line = value => text(value).replace(/\s+/gu, ' ').trim();
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const idOf = record => record?.id ?? record?.session_id ?? record?.skill_id ?? record?.app_id;
const available = skill => skill.enabled !== false && skill.authorized !== false;

export function skillName(skill) {
  const name = line(skill.display_name ?? skill.title ?? skill.name ?? idOf(skill)?.split(':').at(-1));
  return name.replace(/[-_]+/gu, ' ').replace(/^\p{L}/u, letter => letter.toUpperCase());
}

export const attachmentSources = Object.freeze([
  { id: 'meeting', name: 'Meetings', description: 'Browse meeting context. Summary and transcript availability are shown separately from permission to read them.' },
  { id: 'chat_group', name: 'Team Chat', description: 'Select a Zoom Team Chat conversation as context for your next prompt.' },
  { id: 'zoom_doc', name: 'Zoom Docs', description: 'Browse recent Zoom documents available to this account.' },
  { id: 'notes', name: 'Notes', description: 'Select an available Zoom note as remote context.' },
  { id: 'file-google', name: 'Google Drive files', description: 'Browse files available through your existing Google connection. This does not authorize a new connection.' },
  { id: 'file-microsoft', name: 'Microsoft files', description: 'Browse files available through your existing Microsoft connection. This does not authorize a new connection.' },
  { id: 'email-google', name: 'Google email', description: 'Browse email context available through your existing Google connection.' },
  { id: 'email-microsoft', name: 'Microsoft email', description: 'Browse email context available through your existing Microsoft connection.' },
]);

class RemotePicker {
  constructor(views, options, tui, theme, keybindings, done) {
    this.tui = tui; this.theme = theme; this.keybindings = keybindings; this.done = done; this.options = options;
    this.selected = new Set(options.selected ?? []);
    this.attachedOnly = false;
    this.views = views.map((view, index) => ({ ...view, index: String(index), search: `${view.name} ${view.description}` }));
    this.input = new Input({ prompt: theme.fg('accent', 'Search › '), placeholder: options.placeholder ?? 'Name or description', placeholderStyle: value => theme.fg('dim', value) });
    this.heading = new Text('', 1, 0);
    this.previewHeading = new Text('', 1, 0);
    this.selectionCaption = new Text('', 1, 0);
    this.preview = new Markdown('', 1, 0, getMarkdownTheme());
    this.identifiers = new Text('', 1, 0);
    this.hint = new Text('', 1, 0);
    this.border = new DynamicBorder();
    this.descriptionOffset = 0; this.descriptionHeight = 6; this.showIds = false;
    this.rebuildList();
  }
  get focused() { return this.input.focused; }
  set focused(value) { this.input.focused = value; }
  rebuildList(preserve) {
    const candidates = this.views.filter(view => !view.nextPage && (!this.attachedOnly || view.filter || view.clear || this.selected.has(view.key)));
    this.filtered = fuzzyFilter(candidates, this.input.getValue(), view => view.search);
    const nextPage = this.views.find(view => view.nextPage);
    if (nextPage) this.filtered.push(nextPage);
    const rows = Math.max(3, Math.min(7, Math.floor((this.tui.terminal.rows - 12) / 2)));
    this.list = new SelectList(this.filtered.map(view => {
      const attached = this.selected.has(view.key);
      return { value: view.index,
        label: view.filter ? `${view.name}: ${this.attachedOnly ? 'On' : 'Off'}` : this.options.onToggle && !view.clear && !view.nextPage
          ? `${this.theme.fg(attached ? 'success' : 'muted', attached ? '[x]' : '[ ]')} ${view.name}` : view.name,
        description: view.available === false ? 'Unavailable' : undefined,
      };
    }), rows, { ...getSelectListTheme(), noMatch: () => this.theme.fg('muted', `  No matching ${this.options.noun}`) }, { maxPrimaryColumnWidth: 52 });
    if (preserve !== undefined) this.list.setSelectedIndex(this.filtered.findIndex(view => view.index === preserve));
    this.list.onSelectionChange = () => { this.descriptionOffset = 0; this.updatePreview(); };
    this.list.onCancel = () => this.done(undefined);
    this.list.onSelect = item => {
      const view = this.views[Number(item.value)];
      if (view.nextPage) { this.done('next'); return; }
      if (view.filter) {
        this.attachedOnly = !this.attachedOnly; this.rebuildList(view.index); this.tui.requestRender(); return;
      }
      if (view.record === null && view.clear) { this.done(null); return; }
      if (view.available === false) {
        this.hint.setText(this.theme.fg('warning', 'This item is not available for selection in the current account.'));
      } else if (this.options.onToggle) {
        if (this.options.onToggle(view.record)) this.selected.add(view.key);
        else this.selected.delete(view.key);
        this.rebuildList(view.index);
      } else this.done(view.record);
      this.tui.requestRender();
    };
    const count = this.filtered.filter(view => !view.nextPage && !view.filter && !view.clear).length;
    const selected = this.options.onToggle ? ` · ${this.selected.size} attached` : '';
    this.heading.setText(`${this.theme.bold(this.theme.fg('accent', this.options.title))}  ${this.theme.fg('dim', `${count} of ${this.views.filter(view => !view.nextPage && !view.filter && !view.clear).length}${selected}`)}${this.options.caption ? `\n${this.theme.fg('muted', line(this.options.caption))}` : ''}`);
    this.updatePreview();
  }
  updatePreview() {
    const item = this.list.getSelectedItem(), view = item ? this.views[Number(item.value)] : null;
    this.previewHeading.setText(view ? this.theme.bold(this.theme.fg('accent', view.name)) : this.theme.fg('muted', `No matching ${this.options.noun}`));
    const selected = view && this.selected.has(view.key);
    this.selectionCaption.setText(view?.clear ? this.theme.fg('warning', 'Enter clears all attached context')
      : view && this.options.onToggle && !view.nextPage && !view.filter
        ? this.theme.fg(selected ? 'success' : 'muted', selected ? 'Attached · Enter to remove' : 'Not attached · Enter to add') : '');
    this.preview.setText(view?.description || (view ? 'No description supplied by ZoomMate.' : 'Try a different search or another source.'));
    this.identifiers.setText(view ? this.theme.fg('dim', view.identifiers ?? '') : '');
    const action = this.options.onToggle ? 'Enter attach/remove · Esc done' : 'Enter choose · Esc close';
    const next = this.views.some(view => view.nextPage) ? ' · Ctrl+Right next page' : '';
    this.hint.setText(this.theme.fg('dim', `↑↓ browse · ${action} · PgUp/PgDn details · Tab IDs${next}\n${this.options.note}`));
  }
  handleInput(data) {
    if (matchesKey(data, 'ctrl+right') && this.views.some(view => view.nextPage)) { this.done('next'); return; }
    if (matchesKey(data, 'pageDown') || matchesKey(data, 'pageUp')) this.descriptionOffset = Math.max(0, this.descriptionOffset + (matchesKey(data, 'pageDown') ? 1 : -1) * this.descriptionHeight);
    else if (matchesKey(data, 'tab')) this.showIds = !this.showIds;
    else if (['tui.select.up', 'tui.select.down', 'tui.select.confirm', 'tui.select.cancel'].some(action => this.keybindings.matches(data, action))) this.list.handleInput(data);
    else {
      const previous = this.input.getValue(); this.input.handleInput(data);
      if (this.input.getValue() !== previous) { this.descriptionOffset = 0; this.rebuildList(); }
    }
    this.tui.requestRender();
  }
  handleMouse(event) {
    if (event.y >= this.listTop && event.y < this.listTop + this.listHeight) return this.list.handleMouse({ ...event, y: event.y - this.listTop, x: event.x - 1 });
    if (event.type === 'wheel' && event.y >= this.previewTop) { this.descriptionOffset = Math.max(0, this.descriptionOffset + (event.wheelDelta < 0 ? -3 : 3)); return { handled: true, render: true }; }
  }
  render(width) {
    const rows = [...this.heading.render(width), '', ...this.input.render(Math.max(1, width - 2)).map(value => ` ${value}`), ''];
    this.listTop = rows.length; const list = this.list.render(Math.max(1, width - 2)).map(value => ` ${value}`);
    this.listHeight = list.length; rows.push(...list, '', ...this.border.render(width), ...this.previewHeading.render(width), ...this.selectionCaption.render(width), '');
    this.previewTop = rows.length; const description = this.preview.render(width);
    this.descriptionHeight = Math.max(3, Math.min(10, this.tui.terminal.rows - rows.length - (this.showIds ? 7 : 4)));
    this.descriptionOffset = Math.min(this.descriptionOffset, Math.max(0, description.length - this.descriptionHeight));
    rows.push(...description.slice(this.descriptionOffset, this.descriptionOffset + this.descriptionHeight));
    if (description.length > this.descriptionHeight) rows.push(this.theme.fg('dim', ` ${this.descriptionOffset + 1}–${Math.min(description.length, this.descriptionOffset + this.descriptionHeight)} of ${description.length} lines · PgUp/PgDn`));
    if (this.showIds) rows.push('', ...this.identifiers.render(width));
    rows.push('', ...this.hint.render(width)); return rows;
  }
  invalidate() { for (const component of [this.heading, this.input, this.list, this.previewHeading, this.selectionCaption, this.preview, this.identifiers, this.hint, this.border]) component.invalidate(); }
}

export function pickRemoteSkill(ctx, records, selected, onToggle) {
  const views = records.map(record => ({ record, key: idOf(record), name: skillName(record),
    description: text(record.description ?? ''), available: Boolean(idOf(record)) && available(record),
    identifiers: `ID: ${line(idOf(record))}\nSkill ID: ${line(record.skill_id)}`,
  }));
  return ctx.ui.custom((tui, theme, keybindings, done) => new RemotePicker(views, {
    title: 'Remote skills', noun: 'skills', selected, onToggle, note: 'Selections affect the next prompt. Toggling does not run a skill.',
  }, tui, theme, keybindings, done));
}

export function pickAttachmentSource(ctx, selectedContextRecords = []) {
  const views = attachmentSources.map(record => ({ record, key: record.id, name: record.name, description: record.description, identifiers: `Type: ${record.id}` }));
  if (selectedContextRecords.length) views.unshift({
    record: { id: 'selected', name: 'Attached items' }, key: 'selected', name: `Attached items (${selectedContextRecords.length})`,
    description: 'Browse only items already attached to this conversation.', identifiers: 'Type: selected',
  });
  return ctx.ui.custom((tui, theme, keybindings, done) => new RemotePicker(views, {
    title: 'Attach remote context', noun: 'sources', note: 'Choose a source to browse. No local files are read or uploaded.',
  }, tui, theme, keybindings, done));
}

export function attachmentName(record) {
  return line(record.displayName ?? record.display_name ?? record.title ?? record.name ?? 'Untitled item');
}

const dateOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' };
const dateFormats = new Map();
function occurrenceDate(record) {
  const timestamp = record.meeting_start_time ?? record.schedule_start_time ?? record.start_time ?? record.date;
  if (timestamp === undefined || timestamp === null || timestamp === '') return null;
  const numeric = typeof timestamp === 'number' || /^\d+$/u.test(String(timestamp)) ? Number(timestamp) : null;
  const date = new Date(numeric === null ? timestamp : numeric < 1e12 ? numeric * 1000 : numeric);
  if (!Number.isFinite(date.getTime())) return null;
  const timezone = record.timezone ?? record.time_zone ?? record.meeting_timezone ?? record.schedule_timezone ?? 'UTC';
  try {
    if (!dateFormats.has(timezone)) dateFormats.set(timezone, new Intl.DateTimeFormat('en-US', { ...dateOptions, timeZone: timezone }));
    return dateFormats.get(timezone).format(date);
  } catch {
    return null;
  }
}
function attachmentRowName(record, source) {
  const title = attachmentName(record);
  if (source.id !== 'meeting') return title;
  return `${occurrenceDate(record) ?? 'Unknown date'} · ${title}`;
}
function attachmentDescription(record, source) {
  const access = (exists, permission) => exists === false ? 'Not present' : exists === true
    ? permission === true ? 'Available' : permission === false ? 'Exists · access not permitted' : 'Exists · access not reported' : null;
  const fields = [
    ['Source', source.name], ['When', occurrenceDate(record)],
    ['Host', record.host_name], ['Owner', record.owner_name !== record.host_name ? record.owner_name : null],
    ['Participants', record.participant_size], ['Location', record.location],
    ['Summary', access(record.has_summary, record.has_summary_permission)],
    ['Transcript', access(record.has_transcript, record.has_transcript_permission)],
  ];
  const metadata = fields.filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `**${key}:** ${line(value)}`).join('  \n');
  return [text(record.description ?? ''), metadata].filter(Boolean).join('\n\n');
}

export function pickRemoteAttachment(ctx, source, page, selected, onToggle, selectedContextRecords = [], options = {}) {
  const native = Array.isArray(page?.items) ? page.items : [];
  const prior = selectedContextRecords.filter(entry => source.id === 'selected' || entry.type === source.id).map(entry => ({
    ...(entry.record ?? { id: entry.key.slice(entry.type.length + 1), name: `${entry.key} (metadata unavailable)`, entity_type: entry.type }),
    _selectedType: entry.type,
  }));
  const seen = new Set(native.map(record => `${source.id}:${record.id}`));
  const items = [...native, ...prior.filter(record => !seen.has(`${record._selectedType}:${record.id}`))];
  const views = items.map(record => {
    const type = record._selectedType ?? source.id, actualSource = attachmentSources.find(item => item.id === type) ?? source;
    return { record, key: `${type}:${record.id}`, name: attachmentRowName(record, actualSource),
      description: attachmentDescription(record, actualSource),
      available: Boolean(record.id && (record.name || record.display_name || record.displayName || record.title) && record.entity_type),
      identifiers: `ID: ${line(record.id)}\nType: ${line(type)}` };
  });
  views.unshift({ filter: true, name: 'Show attached only', description: 'Limit this chooser to items currently attached. Toggle again to show all loaded items.' });
  if (options.clearLabel) views.unshift({ record: null, clear: true, name: options.clearLabel, description: 'Remove every attached item from this conversation.' });
  if (page.nextCursor) views.push({ nextPage: true, name: 'More results…', description: 'Load the next native page from this source. Current selections are kept.' });
  return ctx.ui.custom((tui, theme, keybindings, done) => new RemotePicker(views, {
    title: `Attach · ${source.name}`, noun: 'attachments', selected: source.id === 'selected' ? selected : selected.filter(key => key.startsWith(`${source.id}:`)),
    onToggle, placeholder: 'Filter this page by name or details',
    note: page.hasMore && !page.nextCursor ? 'Native pagination stopped early; this list is incomplete.'
      : 'Search filters this page. Selections affect the next prompt; nothing is uploaded.',
  }, tui, theme, keybindings, done));
}
 
export function pickRemoteRecords(ctx, records, options = {}) {
  const nameOf = options.name ?? (record => line(record.display_name ?? record.displayName ?? record.conversation_title ?? record.project_name ?? record.app_name ?? record.meeting_topic ?? record.title ?? record.name ?? 'Untitled item'));
  const descriptionOf = options.description ?? (record => line(record.description ?? record.email ?? record.connection_status ?? ''));
  const keyOf = options.key ?? (record => idOf(record) ?? nameOf(record));
  const views = records.map((record, index) => {
    const identifier = idOf(record);
    return {
      record, key: keyOf(record), name: nameOf(record) || `Item ${index + 1}`,
      description: descriptionOf(record), available: Boolean(options.key ? keyOf(record) : identifier) && (options.available ? options.available(record) : true),
      identifiers: identifier ? `ID: ${line(identifier)}` : '',
    };
  });
  if (options.clearLabel) views.unshift({ record: null, clear: true, name: options.clearLabel, description: 'Clear the project selection for subsequent prompts. Existing conversations and remote work are unchanged.' });
  if (options.nextCursor) views.push({
    nextPage: true, name: 'More results…',
    description: 'Load the next native page from this source. Current selections are kept.',
  });
  return ctx.ui.custom((tui, theme, keybindings, done) => new RemotePicker(views, {
    title: options.title ?? 'Choose a remote item', noun: options.noun ?? 'items', caption: options.caption,
    selected: options.selected, onToggle: options.onToggle, note: options.hasMore && !options.nextCursor
      ? 'Native pagination stopped early; this list is incomplete.' : options.note ?? 'Search filters the records currently loaded from ZoomMate.',
    placeholder: options.placeholder ?? 'Filter this page by name or details',
  }, tui, theme, keybindings, done));
}
export function selectedContextSummary(selected) {
  const values = selected?.entity ?? [];
  const counts = new Map();
  for (const key of new Set(values)) {
    const type = String(key).split(':', 1)[0];
    const label = type === 'meeting' ? 'meeting' : type === 'connector' ? 'connected app'
      : type === 'chat_group' ? 'chat' : type === 'zoom_doc' ? 'document' : type === 'notes' ? 'note'
      : type === 'file-google' ? 'Google Drive file' : type === 'file-microsoft' ? 'Microsoft file'
      : type === 'email-google' ? 'Google email' : type === 'email-microsoft' ? 'Microsoft email'
      : type.replace(/[-_]+/gu, ' ');
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  for (const [key, label] of [['artifact', 'artifact'], ['skill', 'skill'], ['connector', 'connected app']]) {
    const count = new Set(selected?.[key] ?? []).size;
    if (count) counts.set(label, count);
  }
  if (!counts.size) return 'none';
  return [...counts].map(([label, count]) => `${count} ${label}${count === 1 ? '' : 's'}`).join(', ');
}

function creditValues(credit) {
  if (![credit?.remaining_credit, credit?.used_credit, credit?.budget_cap].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null;
  return { remaining: credit.remaining_credit, used: credit.used_credit, budget: credit.budget_cap,
    ratio: credit.budget_cap > 0 ? Math.min(1, credit.remaining_credit / credit.budget_cap) : 0 };
}
function meter(values, theme, width, quotaAvailable) {
  const filled = Math.round(values.ratio * width);
  const color = quotaAvailable === false || values.ratio <= 0.1 ? 'error' : values.ratio <= 0.25 ? 'warning' : 'accent';
  return theme.fg(color, '━'.repeat(filled)) + theme.fg('dim', '─'.repeat(width - filled));
}

export function creditFooter(credit, theme) {
  const values = creditValues(credit);
  if (!values) return theme.fg('muted', 'Credits: /credits · token usage unreported');
  return `${theme.fg('muted', 'Credits')} ${meter(values, theme, 10, credit.is_quota_available)} ${theme.fg('accent', number.format(values.remaining))}${theme.fg('dim', ` / ${number.format(values.budget)}`)}`;
}

export function creditBalanceComponent(credit, theme, observedAt, observations = []) {
  const component = new Text('', 1, 0);
  const observationText = observation => {
    const values = creditValues(observation?.creditStatus);
    const balance = values ? `${number.format(values.remaining)} remaining` : observation?.error?.message ? `unavailable (${line(observation.error.message)})` : 'unavailable';
    const time = Number.isFinite(observation?.observedAt) ? new Date(observation.observedAt).toISOString() : 'time unavailable';
    return `${observation?.phase === 'before-request' ? 'Before request' : observation?.cached ? 'After request (cached; not observed)' : 'After request'}: ${balance} · observed ${time}${observation?.requestId ? ` · request ${line(observation.requestId)}` : ''}`;
  };
  const latestCorrelation = [...observations].reverse().find(item => item?.phase === 'before-request' && item?.correlationId)?.correlationId;
  const requestObservations = latestCorrelation
    ? observations.filter(item => item.correlationId === latestCorrelation && ['before-request', 'after-request'].includes(item.phase))
    : [];
  return {
    render(width) {
      const values = creditValues(credit);
      const requestLines = requestObservations.map(item => theme.fg('muted', observationText(item)));
      if (!values) {
        component.setText([
          theme.bold(theme.fg('accent', 'Shared credits')),
          theme.fg('warning', 'The provider did not report a usable numeric balance.'),
          theme.fg('dim', 'No estimate has been substituted.'),
          ...requestLines,
          theme.fg('warning', 'Per-request attribution: unavailable'),
        ].join('\n'));
      } else {
        const percent = values.budget > 0 ? `${number.format(Math.round(values.ratio * 1000) / 10)}% remaining` : 'No budget allocated';
        const quota = credit.is_quota_available === true ? theme.fg('success', 'Quota available') : credit.is_quota_available === false ? theme.fg('error', 'Quota unavailable') : theme.fg('muted', 'Quota status unreported');
        component.setText([
          `${theme.bold(theme.fg('accent', 'Shared credits'))}  ${theme.fg('muted', percent)}`,
          meter(values, theme, Math.max(4, Math.min(54, width - 4)), credit.is_quota_available),
          `${theme.bold(theme.fg('accent', number.format(values.remaining)))} remaining  ${theme.fg('dim', '·')}  ${number.format(values.used)} used  ${theme.fg('dim', '·')}  ${number.format(values.budget)} budget`,
          quota,
          ...(Number.isFinite(observedAt) ? [theme.fg('dim', `Observed ${new Date(observedAt).toISOString()}`)] : []),
          ...requestLines,
          theme.fg('warning', 'Per-request attribution: unavailable'),
          theme.fg('dim', 'Shared account snapshot. Billing may lag; this is not a per-turn cost estimate.'),
        ].join('\n'));
      }
      return component.render(width);
    },
    invalidate() { component.invalidate(); },
  };
}
