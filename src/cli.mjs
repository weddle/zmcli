#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { AppError, connectSession, exportBrowserCookies } from './session.mjs';
import { fileId, validateDocsOptions } from './docs.mjs';
import { parseMessageLink, validateChannelId, xmlText } from './chat.mjs';
import { cursorScope, decodeCursor } from './cursor.mjs';
import { PROFILE_HELP, resolveProfile, runProfileCommand, persistProfileCookies, importProfileCookies, validateCdpUrl } from './profiles.mjs';

const VERSION = '1.0.0-rc.1';
const GLOBAL = { cdp: 'value', cookies: 'value', profile: 'value', 'config-dir': 'value', debug: 'flag', help: 'flag', json: 'flag', version: 'flag' };

const CHAT_STRICT_IDENTITY = { strict: 'flag', 'resolve-identities': 'flag', 'identity-limit': 'value' };
const CHAT_TIME = { since: 'value', until: 'value', timezone: 'value', ...CHAT_STRICT_IDENTITY };
const CHAT_ACTIVITY = {
  'max-requests': 'value', 'root-pages': 'value', 'thread-pages': 'value',
  'recover-older-roots': 'flag', 'older-root-since': 'value', 'older-root-pages': 'value',
  'older-root-requests': 'value', 'older-root-threads': 'value',
  'older-root-checkpoint-limit': 'value', 'older-root-checkpoint-bytes': 'value',
  'overlap-rescans': 'value', 'overlap-ms': 'value',
};
const CHAT_TARGET = { session: 'value', channel: 'value', group: 'value', email: 'value', 'expect-user': 'value', 'expect-users': 'value' };
const CHAT_NATIVE_TEXT = { text: 'value', 'text-file': 'value' };
const CHAT_TARGET_USAGE = '(--session JID | --channel ID --expect-users IDS | --group ID --expect-users IDS | --email EMAIL --expect-user JID)';
const DOCS_STRICT = { strict: 'flag' };
const DOCS_TIME_STRICT = { since: 'value', until: 'value', timezone: 'value', ...DOCS_STRICT };
const COMMANDS = {
  'auth status': {},
  'auth export': { out: 'value', replace: 'flag' },
  'auth import': { cookies: 'value', replace: 'flag' },
  'auth acquire': { method: 'value', 'output-cookie-file': 'value', 'username-fd': 'value', 'password-fd': 'value', 'timeout-ms': 'value', replace: 'flag' },
  'auth methods': {},
  'profile init': { cdp: 'value' },
  'profile show': {},
  'profile list': {},
  'profile set': { cdp: 'value' },
  'zoommate status': {},
  'zoommate capabilities': {},
  'zoommate chats': { limit: 'value', cursor: 'value' },
  'zoommate search-chats': { query: 'value', limit: 'value', cursor: 'value' },
  'zoommate history': { id: 'value', limit: 'value', cursor: 'value' },
  'zoommate rename': { id: 'value', title: 'value' },
  'zoommate query': { id: 'value', new: 'flag', project: 'value', 'prompt-file': 'value', entity: 'value', skill: 'value', connector: 'value', artifact: 'value', mode: 'value', stream: 'flag', 'timeout-ms': 'value' },
  'zoommate watch': { id: 'value', stream: 'flag', 'timeout-ms': 'value' },
  'zoommate cancel': { id: 'value', 'request-id': 'value' },
  'zoommate projects': { limit: 'value', cursor: 'value' },
  'zoommate project': { id: 'value' },
  'zoommate project-context': { id: 'value' },
  'zoommate files': { id: 'value', all: 'flag' },
  'zoommate file': { id: 'value', 'file-id': 'value' },
  'zoommate resources': { type: 'value', query: 'value', limit: 'value', cursor: 'value' },
  'zoommate connectors': {},
  'zoommate skills': {},
  'zoommate credits': {},
  'zoommate credit-history': { limit: 'value', cursor: 'value', since: 'value', until: 'value' },
  'zoommate artifacts': { id: 'value' },
  'zoommate artifact': { id: 'value', artifact: 'value' },
  'zoommate artifact-save': { id: 'value', artifact: 'value', out: 'value', task: 'value' },
  'zoommate artifact-export': { id: 'value', artifact: 'value', target: 'value', task: 'value' },
  'zoommate snapshot': { id: 'value', snapshot: 'value', 'message-id': 'value' },
  'zoommate devices': {},
  'docs recent': { limit: 'value', cursor: 'value', ...DOCS_STRICT },
  'docs notifications': { id: 'value', state: 'value', limit: 'value', cursor: 'value', ...DOCS_TIME_STRICT },
  'docs modified': { ids: 'value', ...DOCS_TIME_STRICT },
  'docs folders': { id: 'value', limit: 'value', cursor: 'value', ...DOCS_STRICT },
  'docs permissions-batch': { ids: 'value', concurrency: 'value', ...DOCS_STRICT },
  'docs identities': { ids: 'value', ...DOCS_STRICT },
  'docs capabilities': {},
  'docs find': { query: 'value', limit: 'value', cursor: 'value', ...DOCS_STRICT },
  'docs search': { query: 'value', limit: 'value', cursor: 'value', ...DOCS_STRICT },
  'docs resolve': { query: 'value' },
  'docs user': { email: 'value' },
  'docs share': { id: 'value', email: 'value', role: 'value', 'expect-users': 'value' },
  'docs unshare': { id: 'value', email: 'value', 'expect-users': 'value' },
  'docs rename': { id: 'value', title: 'value' },
  'docs read': { id: 'value', ...DOCS_STRICT },
  'docs comments': { id: 'value', status: 'value', limit: 'value', cursor: 'value', ...DOCS_STRICT },
  'docs comment-thread': { id: 'value', thread: 'value', status: 'value', limit: 'value', cursor: 'value', ...DOCS_STRICT },
  'docs comment-context': { id: 'value', thread: 'value', status: 'value' },
  'docs comment-create': { id: 'value', block: 'value', offset: 'value', length: 'value', quote: 'value', 'if-version': 'value', 'expect-users': 'value', text: 'value', 'text-file': 'value', 'mention-email': 'value', attachment: 'value', 'attachment-mime': 'value' },
  'docs comment-reply': { id: 'value', thread: 'value', 'expect-users': 'value', text: 'value', 'text-file': 'value', 'mention-email': 'value', attachment: 'value', 'attachment-mime': 'value' },
  'docs comment-download': { id: 'value', thread: 'value', comment: 'value', attachment: 'value', out: 'value', status: 'value' },
  'docs comment-resolve': { id: 'value', thread: 'value', 'expect-users': 'value' },
  'docs comment-reopen': { id: 'value', thread: 'value', 'expect-users': 'value' },
  'docs discussions': { id: 'value', kind: 'value', status: 'value', limit: 'value', cursor: 'value', ...DOCS_STRICT },
  'docs permissions': { id: 'value', ...DOCS_STRICT },
  'docs set-role': { id: 'value', user: 'value', role: 'value', 'expect-users': 'value' },
  'docs create': { title: 'value', text: 'value', 'text-file': 'value' },
  'docs import-markdown': { title: 'value', text: 'value', 'text-file': 'value' },
  'docs export-markdown': { id: 'value', task: 'value', out: 'value' },
  'docs append': { id: 'value', block: 'value', 'if-version': 'value', text: 'value', 'text-file': 'value' },
  'docs insert': { id: 'value', after: 'value', 'if-version': 'value', text: 'value', 'text-file': 'value' },
  'docs replace': { id: 'value', block: 'value', 'if-version': 'value', text: 'value', 'text-file': 'value' },
  'chat list': { strict: 'flag' },
  'chat capabilities': {},
  'chat folders': {},
  'chat folder-create': { name: 'value', index: 'value', 'if-state': 'value' },
  'chat folder-rename': { folder: 'value', name: 'value', 'if-state': 'value' },
  'chat folder-delete': { folder: 'value', 'if-state': 'value' },
  'chat folder-add': { folder: 'value', index: 'value', 'if-state': 'value', ...CHAT_TARGET },
  'chat folder-remove': { folder: 'value', 'if-state': 'value', ...CHAT_TARGET },
  'chat folder-move': { folder: 'value', destination: 'value', index: 'value', 'if-state': 'value', ...CHAT_TARGET },
  'chat starred': {},
  'chat star': { index: 'value', 'if-state': 'value', ...CHAT_TARGET },
  'chat unstar': { 'if-state': 'value', ...CHAT_TARGET },
  'chat shared-spaces': { 'max-pages': 'value' },
  'chat shared-space-channels': { space: 'value', cursor: 'value' },
  'chat shared-space-members': { space: 'value', cursor: 'value' },
  'chat shared-space-create': { name: 'value', general: 'value', description: 'value', 'space-option': 'value', 'channel-option': 'value' },
  'chat shared-space-rename': { space: 'value', name: 'value', description: 'value', 'space-option': 'value' },
  'chat shared-space-delete': { space: 'value' },
  'chat shared-space-add-member': { space: 'value', members: 'value' },
  'chat shared-space-remove-member': { space: 'value', members: 'value' },
  'chat shared-space-add-channel': { space: 'value', channel: 'value', 'channel-option': 'value' },
  'chat shared-space-remove-channel': { space: 'value', channel: 'value' },
  'chat private-chat-info': { ...CHAT_TARGET },
  'chat channel-delete': { channel: 'value' },
  'chat channel-leave': { channel: 'value' },
  'chat channel-admin': { channel: 'value', member: 'value', name: 'value', role: 'value' },
  'chat channel-permission': { channel: 'value', member: 'value', name: 'value', role: 'value' },
  'chat channel-transfer-owner': { channel: 'value', member: 'value', name: 'value' },
  'chat channel-rename': { channel: 'value', name: 'value', 'if-name': 'value', 'expect-users': 'value' },
  'chat group-rename': { group: 'value', name: 'value', 'if-name': 'value', 'expect-users': 'value' },
  'chat drafts': { limit: 'value', cursor: 'value' },
  'chat draft-create': { chat: 'value', draft: 'value', 'draft-id': 'value', 'message-id': 'value', 'draft-type': 'value', 'send-time': 'value', ...CHAT_TARGET, ...CHAT_NATIVE_TEXT },
  'chat draft-edit': { chat: 'value', draft: 'value', 'draft-id': 'value', 'message-id': 'value', 'draft-type': 'value', 'send-time': 'value', ...CHAT_TARGET, ...CHAT_NATIVE_TEXT },
  'chat draft-delete': { chat: 'value', draft: 'value', 'draft-id': 'value', ...CHAT_TARGET },
  'chat schedule-create': { 'draft-id': 'value', 'message-id': 'value', 'draft-type': 'value', 'send-time': 'value', ...CHAT_TARGET, ...CHAT_NATIVE_TEXT },
  'chat schedule-edit': { 'draft-id': 'value', 'message-id': 'value', 'draft-type': 'value', 'send-time': 'value', ...CHAT_TARGET, ...CHAT_NATIVE_TEXT },
  'chat schedule-delete': { 'draft-id': 'value', ...CHAT_TARGET },
  'chat notifications': { chat: 'value' },
  'chat notifications-set': { chat: 'value', state: 'value' },
  'chat notification-settings': { ...CHAT_TARGET },
  'chat notification-set': { mode: 'value', 'if-mode': 'value', ...CHAT_TARGET },
  'chat mark-read': { chat: 'value', timestamp: 'value', ...CHAT_TARGET },
  'chat mark-unread': { chat: 'value', timestamp: 'value', ...CHAT_TARGET },
  'chat read-watermark': { timestamp: 'value', ...CHAT_TARGET },
  'chat permissions': { chat: 'value' },
  'chat reminders': { limit: 'value', cursor: 'value', ...CHAT_TARGET },
  'chat reminder-set': { timestamp: 'value', 'reminder-t': 'value', 'display-t': 'value', message: 'value', content: 'value', note: 'value', ...CHAT_TARGET },
  'chat reminder-edit': { timestamp: 'value', 'reminder-t': 'value', note: 'value', ...CHAT_TARGET },
  'chat reminder-close': { timestamp: 'value', ...CHAT_TARGET },
  'chat status-message': { mode: 'value', message: 'value' },
  'chat presence': { mode: 'value', previous: 'value' },
  'chat presence-set': { mode: 'value', previous: 'value' },
  'chat available': { previous: 'value' },
  'chat away': {},
  'chat busy': {},
  'chat out-of-office': {},
  'chat ooo': {},
  'chat find': { query: 'value', limit: 'value' },
  'chat search': { query: 'value', limit: 'value', cursor: 'value', 'expect-users': 'value' },
  'chat mentions': { state: 'value', limit: 'value', cursor: 'value', 'expect-users': 'value', 'mention-scope': 'value', ...CHAT_TIME },
  'chat dm-inbox': { state: 'value', kind: 'value', limit: 'value', cursor: 'value', 'expect-users': 'value', ...CHAT_STRICT_IDENTITY },
  'chat new-messages': { checkpoint: 'value', limit: 'value', 'max-pages': 'value', 'expect-users': 'value', ...CHAT_STRICT_IDENTITY },
  'chat activity': { channel: 'value', limit: 'value', 'max-pages': 'value', cursor: 'value', ...CHAT_TIME, ...CHAT_ACTIVITY },
  'chat resolve': { query: 'value' },
  'chat info': { channel: 'value' },
  'chat inspect': { channel: 'value', limit: 'value' },
  'chat members': { channel: 'value', limit: 'value', ...CHAT_STRICT_IDENTITY },
  'chat user': { email: 'value' },
  'chat users': { query: 'value', strict: 'flag' },
  'chat cards': { users: 'value', strict: 'flag' },
  'chat dm-read': { email: 'value', name: 'value', 'expect-user': 'value', limit: 'value', before: 'value', cursor: 'value', ...CHAT_TIME },
  'chat dm-send': { email: 'value', name: 'value', 'expect-user': 'value', text: 'value', 'text-file': 'value' },
  'chat add-member': { channel: 'value', email: 'value', 'expect-users': 'value' },
  'chat remove-member': { channel: 'value', email: 'value', 'expect-users': 'value' },
  'chat read': { channel: 'value', limit: 'value', before: 'value', cursor: 'value', ...CHAT_TIME },
  'chat conversation': { channel: 'value', limit: 'value', before: 'value', cursor: 'value', 'thread-limit': 'value', 'max-threads': 'value', ...CHAT_TIME },
  'chat message': { link: 'value', 'expect-users': 'value', ...CHAT_STRICT_IDENTITY },
  'chat send': { channel: 'value', text: 'value', 'text-file': 'value' },
  'chat files': { channel: 'value', message: 'value', time: 'value' },
  'chat file-info': { channel: 'value', message: 'value', time: 'value', file: 'value' },
  'chat file-download': { channel: 'value', message: 'value', time: 'value', file: 'value', output: 'value' },
  'chat file-send': { channel: 'value', input: 'value', 'expect-users': 'value', mime: 'value' },
  'chat gif-search': { query: 'value', limit: 'value' },
  'chat gif-send': { channel: 'value', gif: 'value', 'expect-users': 'value' },
  'chat gif-download': { channel: 'value', message: 'value', time: 'value', gif: 'value', variant: 'value', output: 'value' },
  'chat sticker-info': { file: 'value' },
  'chat reactions': { channel: 'value', message: 'value', time: 'value', ...CHAT_STRICT_IDENTITY },
  'chat react': { channel: 'value', message: 'value', time: 'value', emoji: 'value', 'custom-emoji': 'value', 'expect-users': 'value' },
  'chat unreact': { channel: 'value', message: 'value', time: 'value', emoji: 'value', 'custom-emoji': 'value', 'expect-users': 'value' },
  'chat edit': { channel: 'value', message: 'value', time: 'value', 'if-text': 'value', 'expect-users': 'value', text: 'value', 'text-file': 'value' },
  'chat delete': { channel: 'value', message: 'value', time: 'value', 'if-text': 'value', 'expect-users': 'value' },
  'chat pins': { channel: 'value', limit: 'value', cursor: 'value', ...CHAT_STRICT_IDENTITY },
  'chat pin': { channel: 'value', message: 'value', time: 'value', 'expect-users': 'value' },
  'chat unpin': { channel: 'value', message: 'value', time: 'value', 'expect-users': 'value' },
  'chat custom-emojis': { own: 'flag', limit: 'value', cursor: 'value' },
  'chat emoji-create': { input: 'value', name: 'value', 'expect-account': 'value' },
  'chat emoji-delete': { file: 'value', name: 'value', 'expect-account': 'value' },
  'chat group-create': { name: 'value', emails: 'value', 'expect-users': 'value' },
  'chat group-find': { users: 'value' },
  'chat group-info': { group: 'value', 'expect-users': 'value' },
  'chat group-read': { group: 'value', 'expect-users': 'value', limit: 'value', before: 'value', cursor: 'value' },
  'chat group-send': { group: 'value', 'expect-users': 'value', text: 'value', 'text-file': 'value' },
  'chat group-message': { group: 'value', 'expect-users': 'value', message: 'value', time: 'value' },
  'chat mention-groups': { channel: 'value', 'expect-users': 'value' },
  'chat mention-group-create': { channel: 'value', name: 'value', members: 'value', 'expect-users': 'value', description: 'value' },
  'chat mention-group-update': { channel: 'value', 'mention-group': 'value', 'if-name': 'value', members: 'value', 'expect-members': 'value', 'expect-users': 'value', name: 'value', description: 'value' },
  'chat mention-group-delete': { channel: 'value', 'mention-group': 'value', 'if-name': 'value', 'expect-members': 'value', 'expect-users': 'value' },
  'chat mention-group-send': { channel: 'value', 'mention-group': 'value', 'if-name': 'value', 'expect-members': 'value', 'expect-users': 'value', text: 'value', 'text-file': 'value' },
  'chat thread': { channel: 'value', thread: 'value', limit: 'value', before: 'value', cursor: 'value', ...CHAT_TIME },
  'chat reply': { channel: 'value', thread: 'value', text: 'value', 'text-file': 'value' },
  'chat create-channel': { name: 'value', description: 'value' },
  'chat reconcile': { channel: 'value', message: 'value', thread: 'value' },
};
const USAGE = {
  'auth status': 'auth status',
  'auth export': 'auth export [--out PATH] [--replace]',
  'auth import': 'auth import --cookies PATH [--replace]',
  'auth acquire': 'auth acquire --method password-browser [--output-cookie-file PATH] --username-fd FD --password-fd FD [--timeout-ms 10000..300000] [--replace]',
  'auth methods': 'auth methods',
  'profile init': 'profile init [--cdp URL]',
  'profile show': 'profile show',
  'profile list': 'profile list',
  'profile set': 'profile set --cdp URL',
  'zoommate status': 'zoommate status',
  'zoommate capabilities': 'zoommate capabilities',
  'zoommate chats': 'zoommate chats [--limit N] [--cursor TOKEN]',
  'zoommate search-chats': 'zoommate search-chats --query TEXT [--limit N] [--cursor TOKEN]',
  'zoommate history': 'zoommate history --id CHAT_ID [--limit N] [--cursor TOKEN]',
  'zoommate rename': 'zoommate rename --id CHAT_ID --title TITLE',
  'zoommate query': 'zoommate query (--new | --id CHAT_ID) --prompt-file PATH|- [--project PROJECT_ID] [--entity TYPE:ID,...] [--skill ID,...] [--connector ID,...] [--artifact KIND:ID,...] [--mode auto|advanced] [--stream] [--timeout-ms N]',
  'zoommate watch': 'zoommate watch --id CHAT_ID [--stream] [--timeout-ms N]',
  'zoommate cancel': 'zoommate cancel --id CHAT_ID --request-id RUN_ID',
  'zoommate projects': 'zoommate projects [--limit N] [--cursor TOKEN]',
  'zoommate project': 'zoommate project --id PROJECT_ID',
  'zoommate project-context': 'zoommate project-context --id PROJECT_ID',
  'zoommate files': 'zoommate files --id CHAT_ID [--all]',
  'zoommate file': 'zoommate file --id CHAT_ID --file-id FILE_ID',
  'zoommate resources': 'zoommate resources --type TYPE [--query TEXT] [--limit N] [--cursor TOKEN]',
  'zoommate connectors': 'zoommate connectors',
  'zoommate skills': 'zoommate skills',
  'zoommate credits': 'zoommate credits',
  'zoommate credit-history': 'zoommate credit-history [--limit N] [--cursor TOKEN] [--since OFFSET_TIMESTAMP] [--until OFFSET_TIMESTAMP]',
  'zoommate artifacts': 'zoommate artifacts --id CHAT_ID',
  'zoommate artifact': 'zoommate artifact --id CHAT_ID --artifact KIND:ID',
  'zoommate artifact-save': 'zoommate artifact-save --id CHAT_ID --artifact KIND:ID --out PATH [--task EXPORT_TASK_ID]',
  'zoommate artifact-export': 'zoommate artifact-export --id CHAT_ID --artifact KIND:ID [--target zoom-docs] [--task CONVERSION_TASK_ID]',
  'zoommate snapshot': 'zoommate snapshot --id CHAT_ID --snapshot PART_ID [--message-id MESSAGE_ID]',
  'zoommate devices': 'zoommate devices',

  'docs recent': 'docs recent [--limit 1..100] [--cursor TOKEN] [--strict]',
  'docs notifications': 'docs notifications [--id DOC_ID] [--state all|unread] [--limit 1..50] [--cursor TOKEN] [--since OFFSET_TIMESTAMP|today|now] [--until OFFSET_TIMESTAMP|today|now] [--timezone IANA] [--strict]',
  'docs modified': 'docs modified --ids ID[,ID...] [--since ENDPOINT] [--until ENDPOINT] [--timezone IANA] [--strict]',
  'docs folders': 'docs folders [--id FOLDER_OR_SPACE_ID] [--limit 1..100] [--cursor TOKEN] [--strict]',
  'docs permissions-batch': 'docs permissions-batch --ids ID[,ID...] [--concurrency 1..4] [--strict]',
  'docs identities': 'docs identities --ids ID[,ID...] [--strict]',
  'docs capabilities': 'docs capabilities',
  'docs find': 'docs find --query TEXT [--limit N] [--cursor TOKEN] [--strict]',
  'docs search': 'docs search --query TEXT [--limit N] [--cursor TOKEN] [--strict]',
  'docs unshare': 'docs unshare --id ID --email EXACT_EMAIL --expect-users OWNER_ID,USER_ID,...',
  'docs resolve': 'docs resolve --query EXACT_TITLE',
  'docs user': 'docs user --email EXACT_EMAIL',
  'docs share': 'docs share --id ID --email EXACT_EMAIL --role editor|viewer --expect-users OWNER_ID,USER_ID,...',
  'docs rename': 'docs rename --id ID --title TITLE',
  'docs discussions': 'docs discussions --id PAGE_ID [--kind page|document] [--status open|resolved] [--limit N] [--cursor TOKEN] [--strict]',
  'docs read': 'docs read --id ID [--strict]',
  'docs comments': 'docs comments --id PAGE_ID [--status open|resolved] [--limit N] [--cursor TOKEN] [--strict]',
  'docs comment-thread': 'docs comment-thread --id PAGE_ID --thread THREAD_ID [--status open|resolved] [--limit N] [--cursor TOKEN] [--strict]',
  'docs comment-context': 'docs comment-context --id PAGE_ID --thread THREAD_ID [--status open|resolved]',
  'docs comment-create': 'docs comment-create --id PAGE_ID --block BLOCK_ID --offset N --length N --quote EXACT_TEXT --if-version N --expect-users OWNER_ID,... (--text TEXT | --text-file PATH) [--mention-email EMAIL] [--attachment PATH --attachment-mime TYPE]',
  'docs comment-reply': 'docs comment-reply --id PAGE_ID --thread THREAD_ID --expect-users OWNER_ID,... (--text TEXT | --text-file PATH) [--mention-email EMAIL] [--attachment PATH --attachment-mime TYPE]',
  'docs comment-download': 'docs comment-download --id PAGE_ID --thread THREAD_ID --comment COMMENT_ID --attachment ATTACHMENT_ID --out PATH [--status open|resolved]',
  'docs comment-resolve': 'docs comment-resolve --id PAGE_ID --thread THREAD_ID --expect-users OWNER_ID,...',
  'docs comment-reopen': 'docs comment-reopen --id PAGE_ID --thread THREAD_ID --expect-users OWNER_ID,...',
  'docs permissions': 'docs permissions --id ID [--strict]',
  'docs set-role': 'docs set-role --id ID --user USER_ID --role editor|viewer --expect-users OWNER_ID,USER_ID,...',
  'docs create': 'docs create --title TITLE (--text TEXT | --text-file PATH)',
  'docs import-markdown': 'docs import-markdown --title TITLE (--text TEXT | --text-file PATH)',
  'docs export-markdown': 'docs export-markdown (--id PAGE_ID | --task TASK_ID) [--out PATH]',
  'docs append': 'docs append --id ID [--block BLOCK_ID] [--if-version N] (--text TEXT | --text-file PATH)',
  'docs insert': 'docs insert --id ID --after BLOCK_ID [--if-version N] (--text TEXT | --text-file PATH)',
  'docs replace': 'docs replace --id ID --block BLOCK_ID --if-version N (--text TEXT | --text-file PATH)',
  'chat list': 'chat list',
  'chat capabilities': 'chat capabilities',
  'chat folders': 'chat folders',
  'chat folder-create': 'chat folder-create --name NAME --index N --if-state HASH',
  'chat folder-rename': 'chat folder-rename --folder ID --name NAME --if-state HASH',
  'chat folder-delete': 'chat folder-delete --folder ID --if-state HASH',
  'chat folder-add': `chat folder-add --folder ID --index N --if-state HASH ${CHAT_TARGET_USAGE}`,
  'chat folder-remove': `chat folder-remove --folder ID --if-state HASH ${CHAT_TARGET_USAGE}`,
  'chat folder-move': `chat folder-move --folder ID --destination ID --index N --if-state HASH ${CHAT_TARGET_USAGE}`,
  'chat starred': 'chat starred',
  'chat star': `chat star --index N --if-state HASH ${CHAT_TARGET_USAGE}`,
  'chat unstar': `chat unstar --if-state HASH ${CHAT_TARGET_USAGE}`,
  'chat shared-spaces': 'chat shared-spaces [--max-pages 1..10]',
  'chat shared-space-channels': 'chat shared-space-channels --space ID [--cursor TOKEN]',
  'chat shared-space-members': 'chat shared-space-members --space ID [--cursor TOKEN]',
  'chat shared-space-create': 'chat shared-space-create --name NAME --general NAME --space-option N --channel-option N [--description TEXT]',
  'chat shared-space-rename': 'chat shared-space-rename --space ID --name NAME --space-option N [--description TEXT]',
  'chat shared-space-delete': 'chat shared-space-delete --space ID',
  'chat shared-space-add-member': 'chat shared-space-add-member --space ID --members USER_IDS',
  'chat shared-space-remove-member': 'chat shared-space-remove-member --space ID --members USER_IDS',
  'chat shared-space-add-channel': 'chat shared-space-add-channel --space ID --channel ID --channel-option N',
  'chat shared-space-remove-channel': 'chat shared-space-remove-channel --space ID --channel ID',
  'chat private-chat-info': `chat private-chat-info ${CHAT_TARGET_USAGE}`,
  'chat channel-delete': 'chat channel-delete --channel ID',
  'chat channel-leave': 'chat channel-leave --channel ID',
  'chat channel-admin': 'chat channel-admin --channel ID --member JID --role admin|member [--name NAME]',
  'chat channel-permission': 'chat channel-permission --channel ID --member JID --role admin|member [--name NAME]',
  'chat channel-transfer-owner': 'chat channel-transfer-owner --channel ID --member JID [--name NAME]',
  'chat channel-rename': 'chat channel-rename --channel ID --name NAME --if-name EXACT_NAME --expect-users FULL_USER_IDS',
  'chat group-rename': 'chat group-rename --group ID --name NAME --if-name EXACT_NAME --expect-users FULL_USER_IDS',
  'chat drafts': 'chat drafts [--limit 1..100] [--cursor TOKEN]',
  'chat draft-create': `chat draft-create (--chat ID | ${CHAT_TARGET_USAGE}) [--draft-id ID] (--text TEXT | --text-file PATH)`,
  'chat draft-edit': `chat draft-edit (--chat ID --draft ID | ${CHAT_TARGET_USAGE} --draft-id ID) (--text TEXT | --text-file PATH)`,
  'chat draft-delete': `chat draft-delete (--chat ID --draft ID | ${CHAT_TARGET_USAGE} --draft-id ID)`,
  'chat schedule-create': `chat schedule-create ${CHAT_TARGET_USAGE} --send-time MILLISECONDS [--draft-id ID] (--text TEXT | --text-file PATH)`,
  'chat schedule-edit': `chat schedule-edit ${CHAT_TARGET_USAGE} --draft-id ID --send-time MILLISECONDS (--text TEXT | --text-file PATH)`,
  'chat schedule-delete': `chat schedule-delete ${CHAT_TARGET_USAGE} --draft-id ID`,
  'chat notifications': 'chat notifications --chat ID',
  'chat notifications-set': 'chat notifications-set --chat ID --state PROVIDER_STATE',
  'chat notification-settings': `chat notification-settings ${CHAT_TARGET_USAGE}`,
  'chat notification-set': `chat notification-set ${CHAT_TARGET_USAGE} --mode all|mention|off|inherit --if-mode CURRENT`,
  'chat mark-read': `chat mark-read (--chat ID | ${CHAT_TARGET_USAGE} --timestamp MILLISECONDS)`,
  'chat mark-unread': `chat mark-unread (--chat ID | ${CHAT_TARGET_USAGE} --timestamp MILLISECONDS)`,
  'chat read-watermark': `chat read-watermark ${CHAT_TARGET_USAGE} [--timestamp MILLISECONDS]`,
  'chat permissions': 'chat permissions --chat ID',
  'chat reminders': `chat reminders [${CHAT_TARGET_USAGE}] [--limit 1..100] [--cursor TOKEN]`,
  'chat reminder-set': `chat reminder-set ${CHAT_TARGET_USAGE} --timestamp MILLISECONDS --reminder-t SECONDS [--display-t MILLISECONDS] [--message ID] [--content TEXT] [--note TEXT]`,
  'chat reminder-edit': `chat reminder-edit ${CHAT_TARGET_USAGE} --timestamp MILLISECONDS --reminder-t SECONDS [--note TEXT]`,
  'chat reminder-close': `chat reminder-close ${CHAT_TARGET_USAGE} --timestamp MILLISECONDS`,
  'chat status-message': 'chat status-message --message TEXT [--mode available|away|busy|ooo]',
  'chat presence': 'chat presence --mode available|away|busy|ooo [--previous busy|ooo]',
  'chat presence-set': 'chat presence-set --mode available|away|busy|ooo [--previous busy|ooo]',
  'chat available': 'chat available [--previous busy|ooo]',
  'chat away': 'chat away',
  'chat busy': 'chat busy',
  'chat out-of-office': 'chat out-of-office',
  'chat ooo': 'chat ooo',
  'chat find': 'chat find --query TEXT [--limit N]',
  'chat search': 'chat search --query TEXT [--limit N] [--cursor TOKEN] [--expect-users GROUP_USER_IDS]',
  'chat mentions': 'chat mentions --state all|unread [--mention-scope any|direct|all|mention-group|textual|unknown] [--since TIME] [--until TIME] [--timezone IANA] [--strict] [--resolve-identities] [--identity-limit N] [--limit N] [--cursor TOKEN] [--expect-users GROUP_USER_IDS]',
  'chat new-messages': 'chat new-messages [--checkpoint TOKEN] [--limit 1..100] [--max-pages 1..10] [--strict] [--resolve-identities] [--identity-limit N] [--expect-users GROUP_USER_IDS]',
  'chat dm-inbox': 'chat dm-inbox --state all|unread [--kind all|direct|group] [--strict] [--resolve-identities] [--identity-limit N] [--limit N] [--cursor TOKEN] [--expect-users GROUP_USER_IDS]',
  'chat activity': 'chat activity --channel ID --since TIME [--until TIME] [--timezone IANA] [--limit N] [--max-pages 1..10] [--max-requests 1..40] [--root-pages 1..10] [--thread-pages 1..10] [--recover-older-roots --older-root-since ABSOLUTE_TIME] [--older-root-pages 0..10] [--older-root-requests 1..40] [--older-root-threads 1..1000] [--older-root-checkpoint-limit 1..2000] [--older-root-checkpoint-bytes 1024..60000] [--overlap-rescans 0..5] [--overlap-ms N] [--cursor TOKEN] [--strict] [--resolve-identities] [--identity-limit N]',
  'chat resolve': 'chat resolve --query EXACT_TITLE',
  'chat info': 'chat info --channel ID',
  'chat inspect': 'chat inspect --channel ID [--limit 1..100]',
  'chat members': 'chat members --channel ID [--limit N] [--strict] [--resolve-identities] [--identity-limit N]',
  'chat user': 'chat user --email EXACT_EMAIL',
  'chat users': 'chat users --query NAME_OR_EMAIL_FRAGMENT [--strict]',
  'chat cards': 'chat cards --users USER_ID_OR_JID,... [--strict]',
  'chat dm-read': 'chat dm-read (--email EXACT_EMAIL | --name EXACT_NAME --expect-user NATIVE_JID) [--since TIME] [--until TIME] [--timezone IANA] [--strict] [--resolve-identities] [--identity-limit N] [--limit N] [--before TIMESTAMP | --cursor TOKEN]',
  'chat dm-send': 'chat dm-send (--email EXACT_EMAIL | --name EXACT_NAME --expect-user NATIVE_JID) (--text TEXT | --text-file PATH)',
  'chat add-member': 'chat add-member --channel ID --email EXACT_EMAIL --expect-users OWNER_ID,...',
  'chat remove-member': 'chat remove-member --channel ID --email EXACT_EMAIL --expect-users OWNER_ID,USER_ID,...',
  'chat read': 'chat read --channel ID [--since TIME] [--until TIME] [--timezone IANA] [--strict] [--resolve-identities] [--identity-limit N] [--limit N] [--cursor TOKEN | --before TIMESTAMP]',
  'chat conversation': 'chat conversation --channel ID [--since TIME] [--until TIME] [--timezone IANA] [--strict] [--resolve-identities] [--identity-limit N] [--limit N] [--thread-limit N] [--max-threads N] [--cursor TOKEN | --before TIMESTAMP]',
  'chat message': 'chat message --link URL [--expect-users GROUP_USER_IDS] [--strict] [--resolve-identities] [--identity-limit N]',
  'chat send': 'chat send --channel ID (--text TEXT | --text-file PATH)',
  'chat files': 'chat files --channel ID --message ID --time TIMESTAMP',
  'chat file-info': 'chat file-info --channel ID --message ID --time TIMESTAMP --file ID',
  'chat file-download': 'chat file-download --channel ID --message ID --time TIMESTAMP --file ID --output PATH',
  'chat file-send': 'chat file-send --channel ID --input PATH --expect-users OWNER_ID,... [--mime TYPE]',
  'chat gif-search': 'chat gif-search --query TEXT [--limit 1..30]',
  'chat gif-send': 'chat gif-send --channel ID --gif CATALOG_ID --expect-users USER_ID,...',
  'chat gif-download': 'chat gif-download --channel ID --message ID --time TIMESTAMP --gif CATALOG_ID [--variant pc|big|mobile] --output PATH',
  'chat sticker-info': 'chat sticker-info --file OWN_PERSONAL_STICKER_ID',
  'chat reactions': 'chat reactions --channel ID --message ID --time TIMESTAMP',
  'chat react': 'chat react --channel ID --message ID --time TIMESTAMP (--emoji EMOJI | --custom-emoji FILE_ID) --expect-users OWNER_ID,...',
  'chat unreact': 'chat unreact --channel ID --message ID --time TIMESTAMP (--emoji EMOJI | --custom-emoji FILE_ID) --expect-users OWNER_ID,...',
  'chat edit': 'chat edit --channel ID --message ID --time TIMESTAMP --if-text PREVIOUS_TEXT --expect-users OWNER_ID,... (--text TEXT | --text-file PATH)',
  'chat delete': 'chat delete --channel ID --message ID --time TIMESTAMP --if-text PREVIOUS_TEXT --expect-users OWNER_ID,...',
  'chat pins': 'chat pins --channel ID [--limit N] [--cursor TOKEN]',
  'chat pin': 'chat pin --channel ID --message ID --time TIMESTAMP --expect-users OWNER_ID,...',
  'chat unpin': 'chat unpin --channel ID --message ID --time TIMESTAMP --expect-users OWNER_ID,...',
  'chat custom-emojis': 'chat custom-emojis [--own] [--limit N] [--cursor TOKEN]',
  'chat emoji-create': 'chat emoji-create --input PNG --name NAME --expect-account ACCOUNT_ID',
  'chat emoji-delete': 'chat emoji-delete --file ID --name EXACT_NAME --expect-account ACCOUNT_ID',
  'chat group-create': 'chat group-create --name NAME --emails OTHER_EMAIL,... --expect-users FULL_USER_IDS',
  'chat group-find': 'chat group-find --users FULL_USER_IDS',
  'chat group-info': 'chat group-info --group ID --expect-users FULL_USER_IDS',
  'chat group-read': 'chat group-read --group ID --expect-users FULL_USER_IDS [--limit N] [--before TIMESTAMP | --cursor TOKEN]',
  'chat group-send': 'chat group-send --group ID --expect-users FULL_USER_IDS (--text TEXT | --text-file PATH)',
  'chat group-message': 'chat group-message --group ID --expect-users FULL_USER_IDS --message ID --time TIMESTAMP',
  'chat mention-groups': 'chat mention-groups --channel ID --expect-users FULL_USER_IDS',
  'chat mention-group-create': 'chat mention-group-create --channel ID --name NAME --members USER_IDS --expect-users FULL_USER_IDS [--description TEXT]',
  'chat mention-group-update': 'chat mention-group-update --channel ID --mention-group ID --if-name EXACT_NAME --members DESIRED_IDS --expect-members OLD_IDS --expect-users FULL_USER_IDS [--name NAME] [--description TEXT]',
  'chat mention-group-delete': 'chat mention-group-delete --channel ID --mention-group ID --if-name EXACT_NAME --expect-members OLD_IDS --expect-users FULL_USER_IDS',
  'chat mention-group-send': 'chat mention-group-send --channel ID --mention-group ID --if-name EXACT_NAME --expect-members OLD_IDS --expect-users FULL_USER_IDS (--text TEXT | --text-file PATH)',
  'chat thread': 'chat thread --channel ID --thread TIMESTAMP [--limit N] [--cursor TOKEN | --before TIMESTAMP]',
  'chat reply': 'chat reply --channel ID --thread TIMESTAMP (--text TEXT | --text-file PATH)',
  'chat create-channel': 'chat create-channel --name NAME [--description TEXT]',
  'chat reconcile': 'chat reconcile --channel ID --message ID [--thread TIMESTAMP]',
};
const CHAT_AUTH_FREE = new Set(['chat capabilities', 'chat drafts']);

function invalid(message, details) {
  throw new AppError('INVALID_INPUT', message, details);
}

function parse(argv) {
  const options = { _: [] };
  const supplied = new Set();
  const optionKinds = { ...GLOBAL, ...Object.assign({}, ...Object.values(COMMANDS)) };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('-')) {
      options._.push(token);
      continue;
    }
    if (!token.startsWith('--') || token === '--') invalid('Only named long options are supported.');
    const separator = token.indexOf('=');
    const name = token.slice(2, separator < 0 ? undefined : separator);
    if (!Object.hasOwn(optionKinds, name)) invalid('Unknown option. Use --help for supported options.');
    if (supplied.has(name)) invalid(`Option --${name} may only be supplied once.`);
    supplied.add(name);
    if (optionKinds[name] === 'flag') {
      if (separator >= 0) invalid(`Option --${name} does not accept a value.`);
      options[name] = true;
    } else {
      const value = separator >= 0 ? token.slice(separator + 1) : argv[++index];
      if (value === undefined || (separator < 0 && value.startsWith('--'))) {
        invalid(`Option --${name} requires a value.`);
      }
      options[name] = value;
    }
  }
  const [group, action, ...extra] = options._;
  if (extra.length) invalid('Unexpected positional arguments.');
  const validGroups = ['auth', 'profile', 'docs', 'chat', 'zoommate'];
  if (group && !validGroups.includes(group)) {
    invalid('Unknown command group.', { validGroups, help: 'zmcli --help' });
  }
  const command = action ? `${group} ${action}` : undefined;
  if (command && !Object.hasOwn(COMMANDS, command)) {
    const validCommands = Object.keys(COMMANDS).filter(key => key.startsWith(`${group} `));
    if (options.help) return { group, action: undefined, command: undefined, options };
    invalid(`Unknown ${group} command.`, { validCommands, help: `zmcli ${group} --help` });
  }
  const allowed = { ...GLOBAL, ...(COMMANDS[command] ?? {}) };
  for (const name of supplied) {
    if (!Object.hasOwn(allowed, name)) invalid(`Option --${name} is not supported for this command.`);
  }
  return { group, action, command, options };
}

function help(group, command) {
  const commands = command ? [command] : Object.keys(COMMANDS).filter(key => !group || key.startsWith(`${group} `));
  const notes = {
    zoommate: [
      'ZoomMate uses saved profile cookies or an explicit --cookies override, native service credentials and a ticket-authenticated WebSocket. No browser runtime fallback or local tool execution.',
      'query sends exactly once; --new creates a remote chat through that run. --id resumes an existing chat. Prompt input comes from a UTF-8 --prompt-file; use - for stdin.',
      'Resource selections are explicit comma-separated native IDs; entity values include TYPE:ID from resources. Visible connectors/skills are not permission to install or authorize them.',
      'query/watch stop with structured blocked or unknown state when approval or reconciliation is needed. Use the zoommate terminal client for interactive approvals; there is no unattended --yes option.',
      'Disconnecting or Ctrl-C detaches without cancelling remote work. cancel requires the exact chat and active request IDs. An uncertain write is never replayed.',
      '--stream emits versioned JSONL events and one terminal result; without it commands emit one JSON result. Guardrail replacement and persisted history supersede provisional streamed text.',
      'artifact-export opens existing native Docs identity or converts a generated Markdown file. Pending conversions are reconciled through file metadata without replaying the conversion write.',
      '--mode advanced is accepted only when task_input_mode_enabled is true; otherwise Auto remains omitted and server-selected. Native desktop execution requires a supported registered Zoom/Synora host and a verified bridge.',
      'snapshot explicitly downloads a bounded native cloud-browser image. It never connects to VNC.',
      'Credit balances can be shared and billing delayed; a request timeout is not a credit cap. Workflows, uploads, connector installation, local tools and hidden mode overrides are excluded.',
    ],
    auth: [
      'auth methods describes explicit, non-fallback acquisition and consumption paths without authentication.',
      'auth acquire --method password-browser reads a username and password only from two distinct explicitly opened pipe/socket/terminal descriptors. Passwords are never accepted in argv, output, logs, telemetry, or persisted by the CLI.',
      'Password-browser acquisition drives the first-party Zoom form in a new isolated browser context on an explicitly authorized loopback CDP endpoint. It saves managed profile cookies or a new --output-cookie-file with mode 0600, returns metadata only, closes the isolated context, and never persists the username or password.',
      'MFA and CAPTCHA return AUTH_INTERACTION_REQUIRED; SSO returns AUTH_METHOD_UNSUPPORTED. Complete those flows explicitly in an authorized first-party browser and then use auth export. There is no bypass, automatic method switch, active-tab adoption, or per-request re-login.',
      'auth export explicitly captures cookies from an authorized loopback browser. Service commands use saved profile cookies or --cookies PATH and mint their own credentials over standalone HTTP.',
      'Safe reads retry at most three total attempts for 429, request timeout/disconnect, HTTP 408/5xx and pre-auth socket failures. Retry-After is honored when it fits the bounded wait budget; longer delays terminate explicitly instead of retrying early. Other retries use bounded jittered backoff. Credential rejection permits one same-actor cookie-backed remint. Persistent rejection returns REAUTHENTICATION_REQUIRED/exit 3.',
      'Writes and write-like export/import operations are never automatically replayed. Provider approval, permission, malformed responses and ambiguous write outcomes are terminal.',
      'Browser relay cookie export is unsupported. Use an explicitly authorized literal loopback CDP endpoint or expect RELAY_COOKIE_EXPORT_UNSUPPORTED; service commands never fall back to a browser.',
    ],
    docs: [
      'Docs recent preserves native rank, activity, type, location, ancestors, and indexed/current title reconciliation. It is not modified-at sorting or browser-local Recent. find is server title search; search is server content search.',
      'Docs notifications mirrors native notification records: omitted --id uses the account-wide /api/notification/groupByFile source with native all/unread listType filtering and returns the latest record per file group, while --id selects document /api/notification/forMe. Global content coverage is explicitly incomplete: an absent row is not evidence that an earlier notification does not exist. Structured person elements are normalized as mentions[] with requested-not-delivery-proof semantics when available; docComment/comment-reply alone never proves a direct mention. Source failures stay typed and never fall back to ordinary history, comments, Recent or browser/local state. Category exhaustiveness, older records within each group, complete mention extraction, late/backdated coverage, and read neutrality remain unproven.',
      'Docs modified sorts exactly 1–100 explicit IDs by modified-at. It is not native Recent and does not enumerate all accessible Docs.',
      'Docs folders enumerates bounded immediate native children under the personal space or an explicit visible parent. It does not claim all-account roots, shared-space discovery, or recursive descendants.',
      'Docs permissions-batch bounds document chains to concurrency 1–4 and preserves received, failed, and cancelled per-document results. Exact service request counts and unknown transport attempt counts remain distinct.',
      'Docs identities resolves 1–20 explicit native IDs without a cache or inferred relationships. docs capabilities is auth-free and lists source scopes and exclusions.',
      'Docs read diagnostics expose loaded pages, unresolved descendants, unsupported blocks/items, and independent pagination/content/identity/permission/category coverage. Strict mode returns a sanitized partial result instead of upgrading incomplete evidence.',
      'Docs permissions reports visibility only from recognized native link/account grants; missing grants do not prove private. Collaborator completeness remains false unless native exhaustiveness is established.',
      'Docs comment readers normalize body, timestamps, author/profile, selected text, state, mentions, and attachments while retaining raw records. Bounded native identity enrichment never invents reporting or membership relationships.',
      'Docs resolve exhausts accessible title-search pages and verifies an exact title; duplicate titles or incomplete search are errors.',
      'Docs user resolves an existing same-account contact by full email and native profile; no email-only/external invitation fallback.',
      'Docs share adds that verified user to an owner-controlled, collaborator-only single-page Doc, with email/chat notifications disabled.',
      'Docs read/append/rename accept document IDs or docs.zoom.us/doc/ID URLs.',
      'Docs read traverses supported child Docs (up to 100 pages); text combines their titles and text. Inspect pages and coverage for structure/partial reads.',
      'Doc/page/database search rows expose readSupported for file-format support, not permission. Only doc file-type reads are verified.',
      'Docs append targets a top-level plain-text paragraph by --block; otherwise the final paragraph. Rich/table targets are unsupported.',
      'Docs insert creates one new paragraph after an existing top-level block, without flattening or rewriting adjacent rich content. Confirmation requires exact text/adjacency and unchanged existing content/style. Nested insertion and rich payload writes are unsupported.',
      'Docs replace corrects an explicit top-level plain paragraph; --block and --if-version are required. Rich/nested targets fail before sending; supplementary Unicode uses the observed UTF-16 delete length. Accepted but unverifiable edits remain unknown with operation IDs, never resent.',
      'Docs import-markdown uses native inline Markdown conversion into an owner-only My docs page. Conversion is not lossless; inspect read/export output.',
      'Docs export-markdown creates one native Markdown task for a childless page and polls at most six times. Resume its returned taskId with --task without creating another task; resumed source association is unverified. --out exclusively creates a file; otherwise JSON includes Markdown. UTF-8 payloads/downloads are bounded to 8 MiB. Stable pre/post page versions are observations, not atomic export locking.',
      '--if-version checks the page version before submission, not an atomic lock. Concurrent changes can still produce an uncertain outcome; never blindly resend.',
      'Docs discussions enumerates native whole-page comments or unanchored document discussions, separately from inline comments. --status applies only to page kind. Native cursors are used verbatim; repeated rows/cursors stop incomplete. Replies retain separate comment-thread commands. No all-kinds/subpage completeness or read-neutrality claim.',
      'Docs comment-context returns exact native thread, fresh same-version Markdown export, current UTF-16 quote/sentence context and verified Markdown ranges. Bold/italic conversion is bounded; repeated blocks, changed selection, detached/multi-block and unsupported export cases stay explicit. No arbitrary text match or lossless/stale mapping claim.',
      'Docs comment-create requires an exact UTF-16 range/quote/version and complete private root-Doc audience. Both comment/edit capabilities are required; supported top-level text formatting and prior anchors are preserved. Thread creation and annotation are separate native writes: partial/unknown outcomes retain IDs and phase, never replay. Comment text including an optional canonical mention is locally bounded to16 KiB.',
      'Docs comment-reply posts text with an optional structured person mention to an exact open thread, without implicit reopening or invented nested-parent IDs. Complete private root-Doc audience, comment capability and bounded complete thread preflight are required; hidden parent metadata refuses transmission even for an Editor. Confirmation preserves existing comments/parents, anchor and status. Lost acknowledgement retains generated IDs without replay; local text bound16 KiB and verification bound1000 comments.',
      'Docs comment-create/reply --mention-email prepends one canonical existing collaborator’s native person mention. Full-email/profile resolution; no display-name guessing, @all, email invitation or sharing mutation. Ambiguous/outside-audience targets fail before submission. Exact structured ACK/readback and unchanged audience/roles are required; notification delivery is unverified by the writer. Plain @text is not converted by the CLI.',
      'Docs comment-create/reply optionally uploads one text/plain, application/octet-stream or image/png attachment up to1 MiB via native file/image comment buckets, then links it to the exact comment. Inline embeds and arbitrary existing asset IDs are unsupported. Allocation/upload/link phases and asset/comment IDs survive uncertain outcomes; never automatically replay partial uploads or comments. Readers retain raw attachment strings and expose validated attachmentItems; metadata coverage never claims byte verification. comment-download signs only an exact currently linked file, verifies size/PNG dimensions and unchanged linkage, and exclusively writes --out; compare its SHA256 with an independent source.',
      'Docs comment-resolve/reopen require the exact open/resolved thread respectively, complete private root-Doc audience and comment capability. Already-requested states refuse before PATCH, not an idempotency claim. Native acknowledgement plus full thread readback preserve comments/parents/anchor and last-resolution history. Current/last native timestamps are not a complete audit log; unknown writes retain IDs/state and are never replayed.',
      'For child-page edits, use that page ID as --id. Block IDs and per-page versions are returned by docs read.',
      'Docs permissions separates visible grants/ancestry from effective capability reasons; incomplete inspection is not a full audience guarantee.',
      'Docs set-role changes an existing direct Editor/Viewer grant on an owner-controlled single-page Doc; --expect-users must name the complete visible collaborator set, including the owner.',
      'Docs comments discovers anchored threads on one page; comment-thread reads an explicit thread and its replies. Initial native batches are locally windowed by --limit; native continuation is used only when supplied. Inspect anchor/status/count/coverage and preserve cursors. Reads may mark discussions read; no neutrality guarantee.',
      'Docs unshare removes one existing non-owner user by verified email under the same exact audience and single-page guards.',
      'Collaboration changes reject broader/inherited audiences and subpages. Confirmation is grant readback, not an atomic audience lock or proof of affected-user capabilities. Ownership transfer is unsupported.',
      'Use nextCursor only with the same Docs command, query, and filters.',
      'Docs cursors bind command/query and detect repeated IDs. Moving results stop pagination incomplete rather than loop.',
    ],
    chat: [
      'chat capabilities is authentication-free and reports the sanitized implemented/unsupported disposition for every requested control. Unsupported routes fail before opening a session, report outcome=not_sent, and never substitute Recent, shared pins, message sends, channel metadata, or browser state.',
      'Chat starred accepts only the bounded native result-zero data-array contract. It preserves response order; numeric i is exposed when present, while absent ordering remains fields:[] without an inferred direction, pagination completeness, continuation, or snapshot. Verified actor/peer, repeated-peer, and channel session identities are explicit, and unknown provider field names are exposed without their values.',
      'Chat list uses the recent index. find is a bounded authenticated-account joined-channel name search, not an exhaustive or global directory. A filtered zero result never proves channel absence; use an explicit channel ID when discovery is incomplete.',
      'Chat find accepts 1–20 query characters; a full limit is incomplete even when the service reports hasMore:false. Continuation is unverified. Native search account metadata is preserved when present and null when absent; channel option bitfields never imply tenant.',
      'Chat dm-read resolves an exact same-account contact and reads only that sender/recipient pair. Cursors bind both actors; empty history does not prove no prior conversation.',
      'Chat dm-send requires the verified current-web encryption semantics to map to none; the standalone mapping is pinned to the observed client version and fails closed when it changes. No native SDK executes at runtime. Sends correlate native echo and exact history; reconcile unknown outcomes with dm-read, never replay automatically.',
      'Chat search returns bounded unarchived message-index snippets and readCommand arrays, including reply parent IDs/timestamps.',
      'Search accepts 1–1000 query characters and limit 1–99 (default 99). It currently requires recognized unlimited retention.',
      'Chat search follows the observed searchAfter cursor with pageNum fixed at 1; reportedPageTotal is not a global hit count. Use nextCursor with the same query.',
      'Global Chat message search is explicitly non-channel-scoped unless a native response proves otherwise, and it is not snapshot-isolated. Overlap, nonadvancing cursors and unsupported conversations stop incomplete rather than silently duplicate or skip results.',
      'Chat resolve matches a full title exactly (case-insensitive), then verifies the exact ID through authoritative channel metadata. Ambiguous, filtered-zero, unavailable, or incomplete candidates are never chosen or mislabeled globally absent.',
      'Chat info and inspect report channelAccountId separately from authenticatedAccountId. accessScope is same-account or shared-cross-tenant when native channel account metadata is present, otherwise null; ownership tenant is resource metadata, never an authorization decision.',
      'Chat inspect keeps the requested and normalized channel IDs separate from authoritative metadata identity. It reports explicit discovery and metadata lookup stages; resource/authenticated accounts; owner, type, encryption, member count, native option and access scope; bounded history attempted/returned/count; verified and unsupported operations; pagination, freshness, independent coverage, and precise native failure codes. Permission denial never becomes CHANNEL_NOT_FOUND or proof of absence.',
      'Cross-tenant channels have permission parity with same-tenant channels: reads and mutations use the authenticated session plus the same operation-specific native permission, capability, role, audience, expected-user, and uncertain-write guards. Tenant mismatch alone never blocks an operation; account and credential overrides remain prohibited.',
      'Chat message resolves canonical channel root/reply and two-person sid/sid2 links by exact ID/time/pair. Direct root links require this actor and a verified same-account peer; group DMs, notes, direct replies and unknown encryption remain unsupported. Missing messages stay unknown.',
      'Chat has no email-only invitations or encrypted writes. Direct sending supports existing same-account users, not personal notes or group DMs.',
      'Chat user verifies an active same-account contact by exact email plus native profile.',
      'Chat users requires 3–254 query characters and returns active same-account candidates, never an arbitrary selected user. searchUserId is native lowercase; chat user verifies canonical identity by email. No exhaustive total/continuation is claimed.',
      'Chat cards resolves 1–100 explicit IDs/JIDs in a native batch, without email lookup. Inputs and canonical case-sensitive profile IDs are preserved; missing profiles and native unavailable categories stay explicit. Organization/manager fields are relationships, not inferred roles.',
      'Chat add-member/remove-member require the private-channel owner and complete exact --expect-users audience; ownership transfer is unsupported.',
      'Chat history/exact/thread readers preserve zmrt trees, run/link metadata and raw XML. contentComplete covers observed paragraph runs/links only, never lossless rendering; contentCoverage retains overlapping unsupported reasons and fields/types. Body text alone never upgrades partial rich content. Unknown numeric message and rich-node types remain opaque. Missing replyCount is null, not zero; thread totals are native counts.',
      'Chat files/file-info/file-download require exact private channel, message ID/time and native file ID. --output exclusively creates a private file. file-send requires exact complete --expect-users including self and a regular nonempty file up to 1 MiB; MIME supports application/octet-stream, text/plain, image/png, image/jpeg, image/gif, image/webp and image/bmp. Native acknowledgement and exact filename/MIME/dimensions/linkage readback confirm sends; uncertain writes are never replayed. Encrypted attachments, arbitrary URLs and reply uploads are unsupported.',
      'JPEG/PNG/static WebP/BMP dimensions and GIF control metadata are inspected from bytes, not trusted from the filename. GIF output includes frameCount, animated, encodedDurationMs and encoded loopCount (0=infinite; null=absent); these are not a browser playback-timing guarantee or full pixel decoding. Downloads verify native size/hash and declared dimensions before creating output. Oriented images, animated WebP and unverified formats fail explicitly. Ordinary GIF attachments are distinct from Giphy and stickers.',
      'Chat gif-search uses the enabled native G-rated catalog, not uploaded GIF files or custom stickers. It returns one bounded native view (up to30), reported totals and explicit unverified continuation. gif-send resolves the exact catalog ID and preserves native pc/big/mobile renditions in one private-channel root; complete --expect-users, current policy, acknowledgement and exact rich readback are required. It neither uploads nor shares an ordinary file, and never replays uncertain sends. Metadata confirmation does not claim byte verification. gif-download binds an exact message/GIF/rendition, permits only the observed same-asset Zoom proxy, verifies original GIF size/dimensions/control metadata and exclusively writes --output (up to1 MiB). Compare SHA256 with an independent source; no arbitrary URL, encrypted/group/reply send or unverified sticker protocol.',
      'Chat sticker-info verifies an exact own private channel-5 PNG/GIF asset from native metadata and original bytes, and reports its observed type-4 catalog membership without an exhaustive-inventory claim. Sticker upload/send is not exposed: native duplicate sharing returned open=true without a channel binding; private recipient scope remains unverified. No ordinary-file or Giphy substitution is made.',
      'Chat reactions exposes native actor identities. react/unreact changes only self on an exact private root/reply with complete --expect-users. Existing self add or absent self remove is refused; acknowledgement and actor readback verify transitions. Concurrent changes remain unknown; no write replay.',
      'Membership writes submit one native IQ, then reconcile acknowledgement and roster. Read counts may lag. Unknown outcomes must not be replayed.',
      'Chat members reads one roster preview (default/max 1000) and compares independent counts; no member pagination or numeric-role interpretation.',
      'Chat read/thread order by message timestamp, not last-reply activity. Continue with returned nextCursor.',
      'Chat conversation composes one private-channel history page with separate reply pages and explicit encountered-author card batches. History/thread limits and max-threads default20/max100. Unknown counts trigger thread reads; budget/unavailable threads/cards stay incomplete. messages deduplicates native IDs; thread readCommand resumes each reply cursor separately. History continuation does not drain earlier threads. No atomic snapshot or exhaustive archive claim.',
      'Each full page probes its boundary timestamp (up to 100 records); ties and server-added system records can exceed --limit.',
      'pagination.status=incomplete stops continuation if the boundary cannot be exhausted or changes.',
      'Check pagination.complete; a null cursor alone does not prove completeness. History is not an atomic snapshot.',
      'Chat mints its own cookie-backed credentials/config and opens a standalone authenticated socket, without Docs bootstrap. Actor, token, JID, account, remint, and route identity consistency remains mandatory for same-account and cross-tenant resources. No guaranteed unread-preserving or receipt-suppression mode is verified.',
      'Chat edit/delete requires an exact own supported text root/reply, previous body --if-text and complete private --expect-users audience. Echo and exact readback confirm changes; root deletion must preserve a completely read reply set of at most100. No other-author deletion or uncertain-write replay.',
      'Search and copied-link group-DM routing require optional --expect-users with the exact complete group audience. Native conference JID/type1 search fields alone do not distinguish channels from group DMs; current metadata must classify them. Missing group audience is explicitly unsupported, not silently routed as a channel.',
      'Chat pins reads native shared top and pin history, not personal bookmarks. Pin refuses an existing top; unpin requires its exact ID/time. Mutations require complete private --expect-users, native IQ acknowledgement and top readback. No implicit replacement or uncertain-write replay.',
      'Custom emoji creation publishes a synthetic PNG to the account-wide catalog, not a private conversation. Requires ordinary enabled/editable capability and exact --expect-account; no admin-setting or consent bypass. Deletion requires an exact own file/name/account. Custom reactions retain the complete private conversation audience guard. Catalogs are not stickers or animated emoji.',
      'Group-DM commands are distinct from channels and two-person DMs. Creation resolves 2–9 other existing users and requires the exact full 3–10-person audience including self. Reads/sends require complete expected membership and observed plaintext mode. No email invitations, implicit audience expansion or encryption bypass.',
      'Mention groups are native private-channel recipient groups, not group DMs or @all. Management currently requires channel ownership; every current/desired mention member must be in the complete expected channel audience. Exact group ID/name/member preflights protect updates, deletion and structured type4 sends. Nonempty member sets are bounded to99 for unsaturated native verification; unknown writes are not replayed.',
      'Chat mentions requires --state all or unread: native all-history index and resource-bound unread index are distinct. Unread waits for the ordinary socket offline index, without extra registration or auth changes. Limit1–50/default20; cursors bind actor/account/state/expected group audience. Malformed, repeated or incomplete native results remain explicit; no search fallback, read-state mutation or global read-neutrality guarantee.',
      'Chat dm-inbox discovers direct/group conversations from native recent and unread indexes, not a browser-local/starred/folder census. Limit1–50/default20; --kind defaults all. Canonical-JID local windows cover the current unpaginated identity set, not native service paging; a changed identity set refuses cursor continuation. Latest preview, native unread counts and explicit manual marks remain distinct. No snapshot or read-neutrality guarantee; group content requires the complete expected audience.',
      'Chat new-messages first returns a baseline checkpoint without emitting backlog. Resume with the returned --checkpoint to drain bounded native-unread root/direct/thread timestamp windows; --limit is per stream page and ties can add up to99 records, --max-pages defaults5/max10. Save each new checkpoint only after consuming its items. Actor/account/expected-group scope is bound; timestamp-boundary or access failures preserve the blocked position. Counts are not per-message read state or delivery receipts. Already-read conversations, late/backdated arrivals and global snapshots are not covered; no daemon, read-marker write or automatic recovery/replay.',
      'Chat --thread is the parent message timestamp from chat read, not its message ID.',
      'Chat --thread/--before must be positive decimal safe integer timestamps in milliseconds.',
      'Chat thread returns parent, messages (replies), total, nextCursor, and explicit pagination status.',
      'Chat send/reply write once over a live authenticated websocket and verify exact ID/text through history/thread.',
      'Chat create-channel creates only private, single-owner channels; member/invite inputs are unsupported.',
      'A new empty channel may be absent from the recent index. Use the ID returned by create.',
      'Chat reconcile looks for an exact ID in the latest 100 records. Absence is unknown, never permission to resend.',
      'Chat activity defaults to roots encountered inside one fixed absolute half-open interval plus replies from threads discovered during that traversal. Cursor scope binds the command, authenticated actor, account, channel, resolved endpoints, timezone, lookback, and rescan configuration. It reports root, reply, page, request, pending-thread, seen-thread, pagination, and coverage state separately; native work without a safe advancing cursor stops incomplete.',
      'Older-root reply recovery is an explicit opt-in with an absolute pre-interval boundary and independent root-page, request, candidate-thread, checkpoint-entry, and checkpoint-byte budgets. It scans only reply-bearing roots inside that lookback and keeps only replies inside the requested interval. Lookback traversal and candidate-thread completion are separate; complete-within-lookback requires both. Native end, retention end, lookback boundary, budget, unsupported response, unsafe pagination, authorization uncertainty, thread failure, and oversized checkpoints remain explicit outcomes.',
      'Overlap rescans use a configured bounded window and stable message-ID dedupe. They report a separate scan timestamp but never set late/backdated recovery or timestamp completeness without a verified native monotonic mechanism. Optional native index evidence retains message and collection time, root/reply relation, endpoint, content coverage, identity provenance, and first/last observation with completenessEvidence=false.',
      'Sender enrichment is bounded to returned message actors and never reads a full roster. Expected batch or individual card failures remain per-sender, preserving successful canonical profiles beside unavailable senders. Native message-envelope labels remain message-local evidence bound to message ID and sender JID; they never overwrite canonical identity or infer uniqueness, email, tenant, department, manager, or team. Every returned message exposes canonical, message-local, or unresolved identity status with separate counts.',
      'Time-bounded Chat reads resolve now once; today requires an IANA timezone and follows local calendar midnight across DST. Results state server/local/mixed filtering and source exhaustiveness.',
      'Per-message readState is read, unread, or unknown only from native evidence. Ordinary history, activity, counts, recent indexes, search, notification centers, folders, starred items, and browser-local state are not interchangeable unread sources.',
      'Exact-name DM mode is bounded and not globally unique: provide the selected native JID with --expect-user. Ambiguous exact matches are refused; email mode still verifies canonical same-account identity.',
      'Optional identity resolution batches only returned native actors. It does not cache messages or infer reporting/team membership, motivation, or performance. Browser fallback is never automatic and requires explicit approval because opening content can change read state.',
    ],
  };
  return [
    'Usage: zmcli [global options] <group> <command> [options]',
    '',
    ...commands.map(key => `  zmcli ${USAGE[key]}`),
    '',
    'Global options (accepted before or after commands):',
    '  --cdp URL       Stored/explicit loopback CDP for profile/auth operations only (default http://127.0.0.1:9222)',
    '  --cookies PATH  Explicit private Zoom cookie JSON; otherwise selected profile cookie file',
    '  --profile NAME  Select a named persistent profile',
    '  --config-dir PATH  Override the persistent profile root',
    '  --debug         Emit elapsed timing only on stderr',
    '  --help          Show general, group, or command help without connecting',
    '  --version       Show version without connecting',
    '',
    PROFILE_HELP,
    '',
    'Limits are 1–100 except Chat GIF search (1–30), search (1–99), mentions/DM inbox (1–50), and members/custom emojis (1–1000). Cursor tokens are opaque.',
    'Text comes from exactly one of --text or --text-file (UTF-8).',
    ...(group ? notes[group] ?? [] : Object.values(notes).flat()),
    'Output: JSON success on stdout; JSON errors on stderr. No interactive prompts.',
    'Exit codes: 0 success, 2 input, 3 authentication, 4 forbidden, 1 other errors.',
  ].join('\n');
}

function helpOption(command, option, kind) {
  const usage = USAGE[command], marker = `--${option}`, at = usage.indexOf(marker);
  if (at < 0) return { name: marker, kind };
  const prefix = usage.slice(0, at);
  const squareDepth = (prefix.match(/\[/g)?.length ?? 0) - (prefix.match(/\]/g)?.length ?? 0);
  const parenDepth = (prefix.match(/\(/g)?.length ?? 0) - (prefix.match(/\)/g)?.length ?? 0);
  return {
    name: marker,
    kind,
    ...(squareDepth > 0 ? { required: false } : parenDepth === 0 ? { required: true } : { conditional: true }),
  };
}

function machineHelp(group, command) {
  const mutating = /^(auth (export|import|acquire)|profile (init|set)|docs (share|unshare|set-role|create|import-markdown|append|insert|replace|rename|comment-create|comment-reply|comment-resolve|comment-reopen)|chat (dm-send|add-member|remove-member|send|file-send|gif-send|react|unreact|edit|delete|pin|unpin|emoji-create|emoji-delete|group-create|group-send|mention-group-create|mention-group-update|mention-group-delete|mention-group-send|reply|create-channel|folder-create|folder-rename|folder-delete|folder-add|folder-remove|folder-move|star|unstar|shared-space-create|shared-space-rename|shared-space-delete|shared-space-add-member|shared-space-remove-member|shared-space-add-channel|shared-space-remove-channel|channel-delete|channel-leave|channel-admin|channel-permission|channel-transfer-owner|channel-rename|group-rename|draft-create|draft-edit|draft-delete|schedule-create|schedule-edit|schedule-delete|notifications-set|notification-set|mark-read|mark-unread|read-watermark|reminder-set|reminder-edit|reminder-close|status-message|presence|presence-set|available|away|busy|out-of-office|ooo))$/;
  const authFree = new Set(['auth methods', 'profile init', 'profile show', 'profile list', 'profile set', ...CHAT_AUTH_FREE, 'docs capabilities']);
  const selected = Object.keys(COMMANDS).filter(name => !group || name.startsWith(`${group} `));
  if (command) selected.splice(0, selected.length, command);
  const commands = selected.sort().map(name => {
    const [commandGroup, action] = name.split(' ');
    const unsupported = CHAT_AUTH_FREE.has(name) && name !== 'chat capabilities';
    return {
      name,
      group: commandGroup,
      action,
      summary: USAGE[name],
      arguments: [],
      options: Object.entries(COMMANDS[name]).sort(([left], [right]) => left.localeCompare(right))
        .map(([option, kind]) => helpOption(name, option, kind)),
      access: {
        authentication: authFree.has(name) ? 'not-required' : name.startsWith('auth ') ? 'explicit-auth-operation' : 'cookie-file-required',
        mode: mutating.test(name) || ['zoommate query', 'zoommate cancel', 'zoommate rename', 'zoommate artifact-save', 'zoommate artifact-export'].includes(name) ? 'mutating' : 'read-only',
      },
      capabilityRequirements: unsupported ? ['verified-native-endpoint', 'bounded-acknowledgement-and-readback'] : [],
      ...(unsupported ? { conditionalUnsupported: {
        code: 'UNSUPPORTED_CAPABILITY', outcome: 'not_sent', fallback: false,
        note: 'The native endpoint or safe readback contract is not verified; inspect chat capabilities for the per-operation reason.',
      } } : {}),
    };
  });
  return {
    schemaVersion: 1,
    program: 'zmcli',
    version: VERSION,
    scope: command ?? group ?? 'all',
    invocation: '--help --json',
    profileHelp: PROFILE_HELP,
    globalOptions: Object.entries(GLOBAL).sort(([left], [right]) => left.localeCompare(right))
      .map(([option, kind]) => ({ name: `--${option}`, kind, required: false, ...(option === 'cdp' ? { default: 'http://127.0.0.1:9222' } : {}) })),
    commands,
  };
}

async function validate(command, options) {
  if (command.startsWith('zoommate ')) {
    const action = command.slice('zoommate '.length);
    for (const name of ['id', 'project', 'request-id', 'message-id', 'file-id', 'cursor', 'artifact', 'snapshot', 'out', 'task']) {
      if (options[name] !== undefined && (typeof options[name] !== 'string' || !options[name].trim())) invalid(`Option --${name} must not be blank.`);
    }
    if (['history', 'rename', 'watch', 'cancel', 'project', 'project-context', 'files', 'file', 'artifacts', 'artifact', 'artifact-save', 'artifact-export', 'snapshot'].includes(action) && !options.id) invalid('Option --id is required.');
    if (action === 'cancel' && !options['request-id']) invalid('Option --request-id is required.');
    if (action === 'file' && !options['file-id']) invalid('Option --file-id is required.');
    if (action === 'rename' && (!options.title?.trim() || options.title.trim().length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(options.title))) invalid('Option --title must contain 1–200 characters without control characters.');
    if (action === 'search-chats' && !options.query?.trim()) invalid('Option --query is required.');
    if (action === 'resources' && !options.type?.trim()) invalid('Option --type is required.');
    if (['artifact', 'artifact-save', 'artifact-export'].includes(action) && !options.artifact) invalid('Option --artifact is required.');
    if (action === 'artifact-save' && (!options.out || options.out === '-')) invalid('Option --out must name a new Markdown file.');
    if (action === 'snapshot' && !options.snapshot) invalid('Option --snapshot is required.');
    if (options.mode !== undefined && !['auto', 'advanced'].includes(options.mode)) invalid('Option --mode must be auto or advanced.');
    if (options.target !== undefined && options.target !== 'zoom-docs') invalid('Option --target must be zoom-docs.');
    for (const name of ['limit', 'timeout-ms']) {
      if (options[name] !== undefined) {
        if (!/^[1-9]\d*$/.test(options[name]) || !Number.isSafeInteger(Number(options[name]))) invalid(`Option --${name} must be a positive integer.`);
        options[name] = Number(options[name]);
        if (options[name] > (name === 'limit' ? 100 : 3600000)) invalid(`Option --${name} exceeds its supported bound.`);
      }
    }
    for (const name of ['entity', 'skill', 'connector', ...(action === 'query' ? ['artifact'] : [])]) {
      if (options[name] !== undefined) {
        options[name] = options[name].split(',');
        if (options[name].some(value => !value.trim()) || new Set(options[name]).size !== options[name].length) invalid(`Option --${name} requires unique nonempty native IDs.`);
      }
    }
    if (action === 'query') {
      if (Boolean(options.id) === Boolean(options.new)) invalid('Select exactly one of --new or --id.');
      if (!options['prompt-file']) invalid('Option --prompt-file is required; use - for stdin.');
      try {
        const input = options['prompt-file'] === '-' ? process.stdin : createReadStream(options['prompt-file']);
        const chunks = [];
        let size = 0;
        for await (const chunk of input) {
          size += chunk.length;
          if (size > 262144) invalid('Prompt must be at most 256 KiB.');
          chunks.push(chunk);
        }
        options.prompt = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch (error) {
        if (error instanceof AppError) throw error;
        invalid('Could not read a UTF-8 prompt from the supplied file or stdin.');
      }
      if (!options.prompt.trim() || Buffer.byteLength(options.prompt) > 262144) invalid('Prompt must contain text and be at most 256 KiB.');
    }
    return;
  }
  const requireValue = name => {
    if (typeof options[name] !== 'string' || !options[name].trim()) invalid(`Option --${name} is required and must not be blank.`);
  };
  const validateNativeTarget = ({ optional = false } = {}) => {
    const selectors = ['session', 'channel', 'group', 'email'].filter(name => options[name] !== undefined);
    if (optional && selectors.length === 0) return false;
    if (selectors.length !== 1) invalid('Select exactly one of --session, --channel, --group or --email.');
    const selector = selectors[0]; requireValue(selector);
    if (selector === 'session' && !/^[A-Za-z0-9_-]+@(?:conference\.)?[^@/\s]+$/.test(options.session)) invalid('Supply a full native Chat session JID.');
    if (selector === 'channel' || selector === 'group') {
      validateChannelId(options[selector]); requireValue('expect-users');
      const users = options['expect-users'].split(',').map(value => value.toLowerCase());
      if (!users.length || users.some(value => !/^[A-Za-z0-9_-]{1,128}$/.test(value)) || new Set(users).size !== users.length) {
        invalid('Supply unique comma-separated --expect-users IDs for the complete conversation audience.');
      }
    }
    if (selector === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email) || options.email.length > 254) invalid('Supply the existing recipient’s full email address.');
      requireValue('expect-user');
      if (!/^[A-Za-z0-9_-]{1,128}@[A-Za-z0-9.-]+$/.test(options['expect-user'])) invalid('Supply the selected peer’s exact native JID with --expect-user.');
    }
    return true;
  };
  const targetRequired = new Set([
    'chat folder-add', 'chat folder-remove', 'chat folder-move', 'chat star', 'chat unstar', 'chat private-chat-info',
    'chat notification-settings', 'chat notification-set', 'chat read-watermark', 'chat reminder-set', 'chat reminder-edit', 'chat reminder-close',
    'chat schedule-create', 'chat schedule-edit', 'chat schedule-delete',
  ]);
  if (targetRequired.has(command)) validateNativeTarget();
  if (command === 'chat reminders') validateNativeTarget({ optional: true });
  if (['chat mark-read', 'chat mark-unread'].includes(command) && options.chat === undefined) validateNativeTarget();
  if (['chat draft-create', 'chat draft-edit', 'chat draft-delete'].includes(command) && options.chat === undefined) validateNativeTarget();
  for (const name of ['timestamp', 'reminder-t', 'display-t', 'send-time', 'space-option', 'channel-option', 'draft-type', 'max-pages', 'index']) {
    if (options[name] !== undefined && (!/^\d+$/.test(options[name]) || !Number.isSafeInteger(Number(options[name])))) {
      invalid(`Option --${name} must be a nonnegative decimal safe integer.`);
    }
  }
  if (options.timestamp !== undefined && Number(options.timestamp) < 1) invalid('Option --timestamp must be positive.');
  if (options['reminder-t'] !== undefined && Number(options['reminder-t']) < 1) invalid('Option --reminder-t must be positive.');
  if (options['max-pages'] !== undefined && (Number(options['max-pages']) < 1 || Number(options['max-pages']) > 10)) invalid('Option --max-pages must be 1–10.');
  if (options['draft-type'] !== undefined && !['0', '1'].includes(options['draft-type'])) invalid('Option --draft-type must be 0 or 1.');
  if (options.cdp !== undefined) validateCdpUrl(options.cdp);
  if (options.cookies !== undefined) requireValue('cookies');
  if (options.profile !== undefined) requireValue('profile');
  if (options['config-dir'] !== undefined) requireValue('config-dir');
  const maximumLimit = ['chat members', 'chat custom-emojis'].includes(command) ? 1000 : command === 'chat gif-search' ? 30 : command === 'chat search' ? 99 : ['chat mentions', 'chat dm-inbox', 'docs notifications'].includes(command) ? 50 : 100;
  if (options.limit !== undefined && (!/^[1-9]\d*$/.test(options.limit) || Number(options.limit) > maximumLimit)) {
    invalid(`Option --limit must be a positive integer no greater than ${maximumLimit}.`);
  }
  for (const name of ['thread-limit', 'max-threads']) {
    if (options[name] !== undefined && (!/^[1-9]\d*$/.test(options[name]) || Number(options[name]) > 100)) invalid(`Option --${name} must be an integer from 1 to 100.`);
  }
  if (options.cursor !== undefined) {
    requireValue('cursor');
    if (/[\u0000-\u0020\u007f]/.test(options.cursor)) invalid('Cursor must not contain whitespace or control characters.');
  }
  if (command === 'auth export' && options.out !== undefined) requireValue('out');
  if (command === 'auth import') requireValue('cookies');
  if (['auth export', 'auth import', 'auth acquire'].includes(command) && options.replace && (
    (command === 'auth export' && options.out !== undefined) || (command === 'auth acquire' && options['output-cookie-file'] !== undefined)
  )) invalid('Option --replace is only supported for managed profile cookie outputs.');
  if (command === 'auth acquire') {
    requireValue('method'); requireValue('username-fd'); requireValue('password-fd');
    if (options.method !== 'password-browser') invalid('Use --method password-browser; authentication methods never switch automatically.');
    if (options['username-fd'] === options['password-fd']) invalid('Username and password require distinct protected descriptors.');
    if (options['timeout-ms'] !== undefined && (!/^[1-9]\d*$/.test(options['timeout-ms']) || Number(options['timeout-ms']) < 10000 || Number(options['timeout-ms']) > 300000)) invalid('Option --timeout-ms must be from 10000 through 300000.');
  }
  if (['docs find', 'docs search', 'docs resolve', 'chat find', 'chat search', 'chat resolve'].includes(command)) requireValue('query');
  if (command === 'chat new-messages') {
    if (options.checkpoint !== undefined && (options.checkpoint.length > 60000 || !/^[A-Za-z0-9_-]+$/.test(options.checkpoint))) invalid('Supply a bounded opaque checkpoint from this command.');
    if (options['max-pages'] !== undefined && (!/^[1-9]\d*$/.test(options['max-pages']) || Number(options['max-pages']) > 10)) invalid('Maximum stream pages must be1–10.');
    const expectedCount = options['expect-users']?.split(',').length;
    if (expectedCount !== undefined && (expectedCount < 3 || expectedCount > 10)) invalid('Group-DM index routing requires the full 3–10-person expected audience.');
  }
  if (command === 'chat activity') {
    requireValue('since');
    const ranges = {
      'max-pages': [1, 10], 'max-requests': [1, 40], 'root-pages': [1, 10], 'thread-pages': [1, 10],
      'older-root-pages': [0, 10], 'older-root-requests': [1, 40], 'older-root-threads': [1, 1000],
      'older-root-checkpoint-limit': [1, 2000], 'older-root-checkpoint-bytes': [1024, 60000],
      'overlap-rescans': [0, 5], 'overlap-ms': [1, Number.MAX_SAFE_INTEGER],
    };
    for (const [name, [minimum, maximum]] of Object.entries(ranges)) {
      if (options[name] !== undefined && (!/^\d+$/.test(options[name]) || !Number.isSafeInteger(Number(options[name]))
        || Number(options[name]) < minimum || Number(options[name]) > maximum)) {
        invalid(`Option --${name} must be an integer from ${minimum} through ${maximum}.`);
      }
    }
    const recoveryOptions = ['older-root-since', 'older-root-pages', 'older-root-requests', 'older-root-threads',
      'older-root-checkpoint-limit', 'older-root-checkpoint-bytes'];
    if (options['recover-older-roots']) requireValue('older-root-since');
    else if (recoveryOptions.some(name => options[name] !== undefined)) invalid('Older-root options require explicit --recover-older-roots.');
    if (options['overlap-ms'] !== undefined && Number(options['overlap-rescans'] ?? 0) === 0) {
      invalid('Option --overlap-ms requires at least one --overlap-rescans pass.');
    }
  }
  if (['chat mentions', 'chat dm-inbox'].includes(command)) {
    requireValue('state');
    if (!['all', 'unread'].includes(options.state)) invalid('Use --state all or unread.');
    if (command === 'chat dm-inbox' && options.kind !== undefined && !['all', 'direct', 'group'].includes(options.kind)) invalid('Use --kind all, direct or group.');
    const expectedCount = options['expect-users']?.split(',').length;
    if (expectedCount !== undefined && (expectedCount < 3 || expectedCount > 10)) invalid('Group-DM index routing requires the full 3–10-person expected audience.');
  }
  if (command === 'chat mentions' && options['mention-scope'] !== undefined
    && !['any', 'direct', 'all', 'mention-group', 'textual', 'unknown'].includes(options['mention-scope'])) {
    invalid('Mention scope must be any, direct, all, mention-group, textual or unknown.');
  }
  if (options['identity-limit'] !== undefined) {
    if (!options['resolve-identities'] || !/^[1-9]\d*$/.test(options['identity-limit']) || Number(options['identity-limit']) > 100) {
      invalid('Option --identity-limit requires --resolve-identities and must be 1–100.');
    }
  }
  if (command === 'chat users') {
    requireValue('query');
    if (options.query.trim().length < 3 || options.query.length > 254) invalid('User search query must contain 3–254 characters.');
  }
  if (command === 'chat cards') {
    requireValue('users');
    const users = options.users.split(',');
    if (users.length > 100 || users.some(user => !/^[A-Za-z0-9_-]{1,128}(?:@[A-Za-z0-9.-]+)?$/.test(user))) {
      invalid('Supply 1–100 comma-separated user IDs or user JIDs.');
    }
  }
  if (command === 'chat find' && options.query.length > 20) invalid('Chat find query must contain no more than 20 characters.');
  if (command === 'chat search' && options.query.length > 1000) invalid('Chat search query must contain no more than 1000 characters.');
  if (['chat notifications', 'chat notifications-set', 'chat permissions'].includes(command)
    || (['chat mark-read', 'chat mark-unread', 'chat draft-create', 'chat draft-edit', 'chat draft-delete'].includes(command) && options.chat !== undefined)) {
    requireValue('chat');
    validateChannelId(options.chat);
  }
  if (command === 'chat notifications-set' && !['all', 'mention', 'off'].includes(options.state)) {
    invalid('Notification state must be all, mention or off.');
  }
  if (['chat draft-edit', 'chat draft-delete'].includes(command)) {
    const draft = options.chat !== undefined ? options.draft : options['draft-id'] ?? options.draft;
    if (typeof draft !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(draft)) invalid('Supply an exact native draft ID.');
  }
  if (['chat schedule-edit', 'chat schedule-delete'].includes(command)) {
    requireValue('draft-id');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options['draft-id'])) invalid('Supply an exact native draft ID.');
  }
  if (command === 'chat notification-set') {
    if (!['all', 'mention', 'off', 'inherit'].includes(options.mode)) invalid('Notification mode must be all, mention, off or inherit.');
    requireValue('if-mode');
  }
  if (['chat presence', 'chat presence-set'].includes(command)) {
    requireValue('mode');
    if (!['available', 'away', 'busy', 'ooo'].includes(options.mode)) invalid('Presence mode must be available, away, busy or ooo.');
  }
  if (command === 'chat status-message') {
    requireValue('message');
    if (options.mode !== undefined && !['available', 'away', 'busy', 'ooo'].includes(options.mode)) invalid('Status mode must be available, away, busy or ooo.');
  }
  if (options.previous !== undefined && !['busy', 'ooo'].includes(options.previous)) invalid('Option --previous must be busy or ooo.');
  const requiredByCommand = {
    'chat folder-create': ['name', 'index', 'if-state'],
    'chat folder-rename': ['folder', 'name', 'if-state'],
    'chat folder-delete': ['folder', 'if-state'],
    'chat folder-add': ['folder', 'index', 'if-state'],
    'chat folder-remove': ['folder', 'if-state'],
    'chat folder-move': ['folder', 'destination', 'index', 'if-state'],
    'chat star': ['index', 'if-state'],
    'chat unstar': ['if-state'],
    'chat shared-space-channels': ['space'],
    'chat shared-space-members': ['space'],
    'chat shared-space-create': ['name', 'general', 'space-option', 'channel-option'],
    'chat shared-space-rename': ['space', 'name', 'space-option'],
    'chat shared-space-delete': ['space'],
    'chat shared-space-add-member': ['space', 'members'],
    'chat shared-space-remove-member': ['space', 'members'],
    'chat shared-space-add-channel': ['space', 'channel', 'channel-option'],
    'chat shared-space-remove-channel': ['space', 'channel'],
    'chat channel-delete': ['channel'],
    'chat channel-leave': ['channel'],
    'chat channel-admin': ['channel', 'member', 'role'],
    'chat channel-permission': ['channel', 'member', 'role'],
    'chat channel-transfer-owner': ['channel', 'member'],
    'chat channel-rename': ['channel', 'name', 'if-name', 'expect-users'],
    'chat group-rename': ['group', 'name', 'if-name', 'expect-users'],
    'chat notification-set': ['mode', 'if-mode'],
    'chat reminder-set': ['timestamp', 'reminder-t'],
    'chat reminder-edit': ['timestamp', 'reminder-t'],
    'chat reminder-close': ['timestamp'],
    'chat schedule-create': ['send-time'],
    'chat schedule-edit': ['draft-id', 'send-time'],
    'chat schedule-delete': ['draft-id'],
  };
  for (const name of requiredByCommand[command] ?? []) requireValue(name);
  if (['chat channel-delete', 'chat channel-leave', 'chat channel-admin', 'chat channel-permission', 'chat channel-transfer-owner',
    'chat channel-rename', 'chat shared-space-add-channel', 'chat shared-space-remove-channel'].includes(command)) validateChannelId(options.channel);
  if (command === 'chat group-rename') validateChannelId(options.group);
  if (['chat channel-admin', 'chat channel-permission'].includes(command) && !['admin', 'member'].includes(options.role)) invalid('Role must be admin or member.');
  if (['chat channel-admin', 'chat channel-permission', 'chat channel-transfer-owner'].includes(command)
    && !/^[A-Za-z0-9_-]+@[^@/\s]+$/.test(options.member)) invalid('Supply an exact member JID.');
  if (['chat shared-space-add-member', 'chat shared-space-remove-member'].includes(command)) {
    const members = options.members.split(',').map(value => value.trim().toLowerCase());
    if (!members.length || members.length > 100 || new Set(members).size !== members.length
      || members.some(value => !/^[a-z0-9_-]+(?:@[^@/\s]+)?$/.test(value))) invalid('Supply 1–100 unique native member IDs or JIDs.');
  }
  if (['chat mark-read', 'chat mark-unread'].includes(command) && options.chat === undefined) requireValue('timestamp');
  if (['chat activity', 'chat info', 'chat inspect', 'chat members', 'chat read', 'chat conversation', 'chat send', 'chat thread', 'chat reply', 'chat reconcile', 'chat files', 'chat file-info', 'chat file-download', 'chat file-send', 'chat reactions', 'chat react', 'chat unreact', 'chat edit', 'chat delete', 'chat pins', 'chat pin', 'chat unpin'].includes(command)) {
    requireValue('channel');
    validateChannelId(options.channel);
  }
  if (command.startsWith('chat mention-group')) {
    requireValue('channel'); validateChannelId(options.channel);
    if (command === 'chat mention-group-create') requireValue('name');
    if (!['chat mention-groups', 'chat mention-group-create'].includes(command)) {
      requireValue('mention-group'); requireValue('if-name');
      if (!/^[A-Za-z0-9_.@-]{1,512}$/.test(options['mention-group'])) invalid('Supply an exact native mention-group ID.');
    }
    for (const key of command === 'chat mention-groups' ? [] : command === 'chat mention-group-create' ? ['members']
      : command === 'chat mention-group-update' ? ['members', 'expect-members'] : ['expect-members']) {
      requireValue(key);
      const ids = options[key].split(',');
      if (ids.length > 99 || new Set(ids.map(id => id.toLowerCase())).size !== ids.length || ids.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))) invalid(`Option --${key} requires distinct user IDs, at most99.`);
    }
  }
  if (command === 'chat thread' || command === 'chat reply' || (command === 'chat reconcile' && options.thread !== undefined)) {
    requireValue('thread');
    if (!/^[1-9]\d*$/.test(options.thread) || !Number.isSafeInteger(Number(options.thread))) {
      invalid('Option --thread must be a positive decimal safe integer timestamp in milliseconds.');
    }
    if (options.before !== undefined && Number(options.before) < Number(options.thread)) invalid('Before timestamp must not precede the thread parent.');
  }
  if (command === 'chat reconcile') {
    requireValue('message');
    if (!/^[A-Za-z0-9_-]+$/.test(options.message)) invalid('Invalid message ID.');
  }
  if (['chat gif-download', 'chat files', 'chat file-info', 'chat file-download', 'chat reactions', 'chat react', 'chat unreact', 'chat edit', 'chat delete', 'chat pin', 'chat unpin', 'chat group-message'].includes(command)) {
    requireValue('message'); requireValue('time');
    if (!/^[A-Za-z0-9_-]+$/.test(options.message) || !/^[1-9]\d*$/.test(options.time)
      || !Number.isSafeInteger(Number(options.time))) invalid('Supply an exact message ID and positive safe integer timestamp.');
    if (['chat file-info', 'chat file-download'].includes(command)) requireValue('file');
    if (['chat file-download', 'chat gif-download'].includes(command)) requireValue('output');
  }
  if (command === 'chat sticker-info') {
    requireValue('file');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.file)) invalid('Supply an exact native sticker file ID.');
  }
  if (command === 'chat file-send') requireValue('input');
  if (command === 'chat gif-search') {
    requireValue('query');
    if (options.query.length > 100) invalid('GIF search query must contain no more than100 characters.');
  }
  if (['chat gif-send', 'chat gif-download'].includes(command)) {
    requireValue('channel'); validateChannelId(options.channel); requireValue('gif');
    if (!/^[A-Za-z0-9]{1,128}$/.test(options.gif)) invalid('Supply an exact native GIF catalog ID.');
    if (options.variant !== undefined && !['pc', 'big', 'mobile'].includes(options.variant)) invalid('GIF rendition must be pc, big or mobile.');
  }
  if (command === 'chat react' || command === 'chat unreact') {
    if ((options.emoji !== undefined) === (options['custom-emoji'] !== undefined)) invalid('Supply exactly one --emoji or --custom-emoji.');
    requireValue(options.emoji !== undefined ? 'emoji' : 'custom-emoji');
    if (options['custom-emoji'] !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(options['custom-emoji'])) invalid('Supply an exact custom emoji file ID.');
  }
  if (['chat emoji-create', 'chat emoji-delete'].includes(command)) {
    requireValue('name'); requireValue('expect-account');
    if (!/^[A-Za-z0-9_]{3,100}$/.test(options.name) || !/^[A-Za-z0-9_-]{1,128}$/.test(options['expect-account'])) invalid('Supply a 3–100 character alphanumeric/underscore name and exact account ID.');
    if (command === 'chat emoji-create') requireValue('input');
    else { requireValue('file'); if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.file)) invalid('Supply an exact own emoji file ID.'); }
  }
  if (['chat edit', 'chat delete'].includes(command) && typeof options['if-text'] !== 'string') invalid('Supply exact previous message body with --if-text.');
  if (command === 'docs export-markdown') {
    if (Boolean(options.id) === Boolean(options.task)) invalid('Supply exactly one --id or --task.');
    if (options.id) options.id = fileId(options.id);
    if (options.task && !/^[A-Za-z0-9_-]{1,128}$/.test(options.task)) invalid('Invalid export task ID.');
    if (options.out !== undefined) requireValue('out');
  }
  if (command === 'chat create-channel') requireValue('name');
  if (command === 'chat group-create') {
    requireValue('name'); requireValue('emails');
    const emails = options.emails.split(',');
    if (emails.length < 2 || emails.length > 9 || new Set(emails.map(email => email.toLowerCase())).size !== emails.length
      || emails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)) invalid('Supply 2–9 distinct existing other-user emails.');
  }
  if (command === 'chat group-find') {
    requireValue('users');
    const users = options.users.split(',');
    if (users.length < 3 || users.length > 10 || new Set(users).size !== users.length || users.some(user => !/^[A-Za-z0-9_-]{1,128}$/.test(user))) invalid('Supply the full 3–10-person group audience as distinct user IDs.');
  }
  if (['chat group-info', 'chat group-read', 'chat group-send', 'chat group-message'].includes(command)) { requireValue('group'); validateChannelId(options.group); }
  if (['docs read', 'docs discussions', 'docs comments', 'docs comment-thread', 'docs comment-context', 'docs comment-create', 'docs comment-reply', 'docs comment-download', 'docs comment-resolve', 'docs comment-reopen', 'docs permissions', 'docs set-role', 'docs share', 'docs unshare', 'docs append', 'docs insert', 'docs replace', 'docs rename'].includes(command)) {
    requireValue('id');
    options.id = fileId(options.id);
  }
  if (['docs comments', 'docs comment-thread', 'docs comment-context', 'docs comment-reply', 'docs comment-download', 'docs comment-resolve', 'docs comment-reopen', 'docs discussions'].includes(command)) {
    if (options.status !== undefined && !['open', 'resolved'].includes(options.status)) invalid('Use --status open or resolved.');
    if (['docs comment-thread', 'docs comment-context', 'docs comment-reply', 'docs comment-download', 'docs comment-resolve', 'docs comment-reopen'].includes(command)) { requireValue('thread'); options.thread = fileId(options.thread); }
  }
  if (command === 'docs comment-download') {
    for (const name of ['comment', 'attachment', 'out']) requireValue(name);
    options.comment = fileId(options.comment); options.attachment = fileId(options.attachment);
  }
  if (['docs comment-create', 'docs comment-reply'].includes(command)) {
    if (options['attachment-mime'] !== undefined && options.attachment === undefined) invalid('--attachment-mime requires --attachment.');
    if (options.attachment !== undefined) requireValue('attachment');
    if (options['attachment-mime'] !== undefined && !['application/octet-stream', 'text/plain', 'image/png'].includes(options['attachment-mime'])) invalid('Comment attachments support application/octet-stream, text/plain or image/png.');
  }
  if (['docs comment-create', 'docs comment-reply'].includes(command) && options['mention-email'] !== undefined) {
    requireValue('mention-email');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options['mention-email']) || options['mention-email'].length > 254) invalid('Supply the existing mentioned collaborator’s full email address.');
  }
  if (command === 'docs discussions' && ((options.kind !== undefined && !['page', 'document'].includes(options.kind))
    || (options.kind === 'document' && options.status !== undefined))) invalid('Use --kind page|document; --status applies only to page discussions.');
  if (['docs user', 'docs share', 'docs unshare', 'chat user', 'chat add-member', 'chat remove-member'].includes(command)) {
    requireValue('email');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email) || options.email.length > 254) invalid('Supply the existing recipient’s full email address.');
  }
  if (['chat dm-read', 'chat dm-send'].includes(command)) {
    if ((options.email === undefined) === (options.name === undefined)) invalid('Supply exactly one of --email or --name.');
    if (options.email !== undefined && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email) || options.email.length > 254)) {
      invalid('Supply the existing recipient’s full email address.');
    }
    if (options.name !== undefined && (options.name.trim().length < 3 || options.name.length > 254)) {
      invalid('Exact recipient name must contain 3–254 characters.');
    }
    if (options['expect-user'] !== undefined && !/^[A-Za-z0-9_-]{1,128}@[A-Za-z0-9.-]+$/.test(options['expect-user'])) {
      invalid('Option --expect-user must be an exact native user JID.');
    }
    if (options.name !== undefined && options['expect-user'] === undefined) invalid('Name resolution requires --expect-user with the selected native JID.');
  }
  if (command === 'docs set-role' || command === 'docs share') {
    for (const name of ['role', 'expect-users']) requireValue(name);
    const users = options['expect-users'].split(',');
    if (!['editor', 'viewer'].includes(options.role)
      || users.some(user => !/^[A-Za-z0-9_-]{1,128}$/.test(user)) || new Set(users).size !== users.length) {
      invalid('Supply an editor/viewer role and unique comma-separated --expect-users IDs.');
    }
    if (command === 'docs set-role') {
      requireValue('user');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.user)) invalid('Supply an exact user ID.');
    }
  }
  if (['chat gif-send', 'chat add-member', 'chat remove-member', 'chat file-send', 'chat react', 'chat unreact', 'chat edit', 'chat delete', 'chat pin', 'chat unpin', 'chat group-create', 'chat group-info', 'chat group-read', 'chat group-send', 'chat group-message', 'docs unshare', 'docs comment-create', 'docs comment-reply', 'docs comment-resolve', 'docs comment-reopen'].includes(command)
    || command.startsWith('chat mention-group') || (['chat search', 'chat message', 'chat mentions', 'chat dm-inbox', 'chat new-messages'].includes(command) && options['expect-users'] !== undefined)) {
    if (command.startsWith('chat ') && !command.startsWith('chat group-') && !['chat search', 'chat message', 'chat mentions', 'chat dm-inbox', 'chat new-messages'].includes(command)) {
      requireValue('channel');
      validateChannelId(options.channel);
    }
    requireValue('expect-users');
    const users = options['expect-users'].split(',').map(value => value.toLowerCase());
    if (users.some(value => !/^[A-Za-z0-9_-]{1,128}$/.test(value)) || new Set(users).size !== users.length) {
      invalid('Supply unique comma-separated --expect-users IDs including the owner.');
    }
  }
  if (options.block !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(options.block)) invalid('Invalid paragraph block ID.');
  if (command === 'docs replace') { requireValue('block'); requireValue('if-version'); }
  if (command === 'docs comment-create') {
    for (const name of ['block', 'offset', 'length', 'quote', 'if-version']) requireValue(name);
    if (!/^(0|[1-9]\d*)$/.test(options.offset) || !Number.isSafeInteger(Number(options.offset))
      || !/^[1-9]\d*$/.test(options.length) || !Number.isSafeInteger(Number(options.length))) invalid('Supply a nonnegative UTF-16 offset and positive safe integer length.');
  }
  if (command === 'docs insert') {
    requireValue('after');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.after)) invalid('Invalid anchor block ID.');
  }
  if (options['if-version'] !== undefined
    && (!/^(0|[1-9]\d*)$/.test(options['if-version']) || !Number.isSafeInteger(Number(options['if-version'])))) {
    invalid('Option --if-version must be a nonnegative decimal safe integer page version.');
  }
  if (command === 'chat message') {
    requireValue('link');
    options.messageLink = parseMessageLink(options.link);
  }
  if (['docs create', 'docs rename', 'docs import-markdown'].includes(command)) requireValue('title');
  if (['docs create', 'docs import-markdown', 'docs append', 'docs insert', 'docs replace', 'docs comment-create', 'docs comment-reply', 'chat send', 'chat reply', 'chat dm-send', 'chat edit', 'chat group-send', 'chat mention-group-send', 'chat draft-create', 'chat draft-edit', 'chat schedule-create', 'chat schedule-edit'].includes(command)) {
    if ((options.text !== undefined) === (options['text-file'] !== undefined)) {
      invalid('Supply exactly one of --text or --text-file.');
    }
    if (options['text-file'] !== undefined) {
      requireValue('text-file');
      try {
        options.text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(options['text-file']));
      } catch {
        invalid('Unable to read --text-file as a UTF-8 text file.');
      }
      delete options['text-file'];
    }
    requireValue('text');
    if (['docs comment-create', 'docs comment-reply'].includes(command) && Buffer.byteLength(options.text) > 16384) invalid('Comment text exceeds the local 16 KiB bound.');
  }
  if (command.startsWith('chat ')) {
    for (const name of ['text', 'name', 'description']) {
      if (options[name] !== undefined && !xmlText(options[name])) invalid(`Option --${name} must contain valid XML characters.`);
    }
  }
  if (options.cursor !== undefined) {
    if (options.before !== undefined) invalid('Use either --cursor or --before, not both.');
    // Actor-bound, interval-bound, and native Docs cursors are validated by their service.
    const serviceScoped = command === 'chat activity' || options.since !== undefined || options.until !== undefined || options.timezone !== undefined;
    const docsServiceScoped = ['docs recent', 'docs notifications', 'docs folders', 'docs find', 'docs search'].includes(command);
    if (!serviceScoped && !docsServiceScoped && !['chat dm-read', 'chat group-read', 'chat search', 'chat mentions', 'chat dm-inbox', 'chat pins', 'chat custom-emojis', 'docs comments', 'docs comment-thread', 'docs discussions'].includes(command)) {
      decodeCursor(options.cursor, cursorScope(command, options));
    }
  }
}

function safeIdentity(identity) {
  const fields = {
    userId: identity?.user?.userId,
    displayName: identity?.user?.displayName,
    email: identity?.user?.email,
    accountId: identity?.account?.accountId ?? identity?.user?.accountId,
    accountName: identity?.account?.name,
    homeClusterApiPrefix: identity?.homeClusterApiPrefix,
  };
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [
    key, typeof value === 'string' || typeof value === 'number' ? value : null,
  ]));
}

function exitCode(code) {
  if (['INVALID_INPUT', 'INVALID_ARGUMENT', 'INVALID_ARGUMENTS', 'USAGE_ERROR'].includes(code)) return 2;
  if (['FORBIDDEN', 'PERMISSION_DENIED', 'ACCESS_DENIED'].includes(code)) return 4;
  if (['UNAUTHENTICATED', 'UNAUTHORIZED', 'AUTH_REQUIRED', 'AUTH_INPUT_REQUIRED', 'AUTH_INTERACTION_REQUIRED', 'AUTH_METHOD_UNSUPPORTED', 'COOKIE_REQUIRED', 'AUTH_FAILED', 'AUTH_EXPIRED', 'AUTH_ERROR', 'REAUTHENTICATION_REQUIRED'].includes(code)) return 3;
  return 1;
}

async function main() {
  const commandStartedAt = Date.now();
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGINT', cancel);
  const started = performance.now();
  let session;
  let debug = false;
  let streaming = false;
  try {
    const { group, action, command, options } = parse(process.argv.slice(2));
    debug = options.debug === true;
    let data;
    if (options.version) {
      data = { version: VERSION };
    } else if (options.help || !group) {
      data = options.json ? machineHelp(group, command) : { help: help(group, command) };
    } else {
      if (!command) invalid('A subcommand is required. Use --help.');
      await validate(command, options);
      if (group === 'docs') Object.assign(options, validateDocsOptions(action, { ...options, commandStartedAt, signal: cancellation.signal }));
      if (group === 'zoommate') {
        options.signal = cancellation.signal;
        streaming = options.stream === true;
        if (streaming) options.onEvent = event => process.stdout.write(`${JSON.stringify(event)}\n`);
      }
      const authFree = group === 'profile' || command === 'auth methods' || command === 'docs capabilities' || CHAT_AUTH_FREE.has(command);
      const managedAuth = command === 'auth import' || command === 'auth export' && options.out === undefined
        || command === 'auth acquire' && options['output-cookie-file'] === undefined;
      const profile = authFree ? null : await resolveProfile(options, { create: managedAuth });
      if (profile && options.cdp === undefined) options.cdp = profile.cdp;
      if (group === 'profile') {
        data = await runProfileCommand(action, options);
      } else if (command === 'auth export') {
        if (options.out !== undefined) {
          data = await exportBrowserCookies({ cdp: options.cdp, out: options.out });
        } else {
          data = await persistProfileCookies(profile, staging => exportBrowserCookies({ cdp: options.cdp, out: staging }), { replace: options.replace === true });
        }
      } else if (command === 'auth import') {
        data = await importProfileCookies(profile, options.cookies, { replace: options.replace === true });
      } else if (command === 'docs capabilities' || CHAT_AUTH_FREE.has(command)) {
        if (group === 'chat') {
          const { runChat } = await import('./chat.mjs');
          data = await runChat(undefined, action, options);
        } else {
          const { runDocs } = await import('./docs.mjs');
          data = await runDocs(undefined, action, options);
        }
      } else if (command === 'auth methods') {
        const { authAcquisitionMethods } = await import('./auth-acquisition.mjs');
        data = authAcquisitionMethods();
      } else if (command === 'auth acquire') {
        const { acquirePasswordBrowserCookies } = await import('./auth-acquisition.mjs');
        const producer = staging => acquirePasswordBrowserCookies({
          method: options.method, outputCookieFile: staging,
          usernameFd: options['username-fd'], passwordFd: options['password-fd'],
          timeoutMs: options['timeout-ms'], cdp: options.cdp,
        });
        data = options['output-cookie-file'] !== undefined
          ? await acquirePasswordBrowserCookies({ method: options.method, outputCookieFile: options['output-cookie-file'], usernameFd: options['username-fd'], passwordFd: options['password-fd'], timeoutMs: options['timeout-ms'], cdp: options.cdp })
          : await persistProfileCookies(profile, producer, { replace: options.replace === true });
      } else {
        if (options.cookies === undefined && !profile.hasCookies) throw new AppError('COOKIE_REQUIRED',
          `Profile ${profile.name} has no saved cookies. Use auth import --cookies PATH or explicitly authorized auth export, or supply --cookies PATH.`);
        session = await connectSession({ cookies: profile.cookies, service: group === 'chat' ? 'chat' : group === 'zoommate' ? 'zoommate' : 'docs' });
        if (command === 'auth status') data = safeIdentity(session.identity);
        else if (group === 'zoommate') {
          const { runZoomMate } = await import('./zoommate.mjs');
          data = await runZoomMate(session, action, options);
        } else if (group === 'chat') {
          const { runChat } = await import('./chat.mjs');
          data = await runChat(session, action, options);
        } else {
          const { runDocs } = await import('./docs.mjs');
          data = await runDocs(session, action, options);
        }
      }
    }
    process.stdout.write(`${JSON.stringify(streaming ? { version: 1, type: 'result', ok: true, data } : { ok: true, data })}\n`);
  } catch (error) {
    const safe = error instanceof AppError
      ? { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
      : { code: 'INTERNAL_ERROR', message: 'The command could not be completed.' };
    process.stderr.write(`${JSON.stringify({ ok: false, error: safe })}\n`);
    process.exitCode = exitCode(safe.code);
  } finally {
    process.removeListener('SIGINT', cancel);
    if (session) {
      try {
        await session.close();
      } catch {
        // Cleanup must not replace the command result.
      }
    }
    if (debug) process.stderr.write(`${JSON.stringify({ debug: { elapsedMs: Math.round(performance.now() - started) } })}\n`);
  }
}

await main();
