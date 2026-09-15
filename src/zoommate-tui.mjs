#!/usr/bin/env node
import process from 'node:process';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AppError } from './session.mjs';
import { PROFILE_HELP } from './profiles.mjs';
const HELP = `ZoomMate — upstream Pi interactive application
Usage: zoompi [--profile NAME] [--config-dir PATH] [--cookies PATH] [--resume SESSION_ID] [--project PROJECT_ID]

Profiles keep native Pi session storage isolated. --cookies overrides the profile's managed cookie file.
${PROFILE_HELP}

/resume [ID]             Restore native history and follow any running turn
/chats                   Pick a remote conversation
/new                     Start a new conversation on the next prompt
/name TITLE              Rename the native conversation with readback confirmation
/project [ID|clear]      Pick, select or clear a remote project
/attach [TYPE[:ID]|selected|clear]  Browse, manage or clear attached context
/skills [ID]             Pick or select a remote skill
/connectors [ID]         Pick or select a connected authorized app
/clear                   Clear explicit context, skill and app selections
/files                   Show this conversation's remote files
/artifacts               Preview, reference, save Markdown, or open/export Zoom Docs
/sources                 Expand native citations and explicit unresolved source markers
/mode                    Select Auto or gated Advanced
/snapshot                Display an optional native cloud-browser screenshot
/computer                Inspect captures, artifacts and conversation files read-only
/suggestions             Review native skill suggestions; load a prompt without sending
/credits                 Show the shared credit balance
/approve                 Reopen a dismissed provider review (new requests appear automatically)
/cancel                  Confirm a remote stop request and check its outcome
/session [verbose]       Show compact status or detailed native diagnostics
/settings                Choose a Pi theme
/copy                    Copy the last assistant response
/help                    Show commands and keyboard controls
/quit                    Detach and exit WITHOUT cancelling the remote run

Type / for live completion; Tab completes. Native Pi editor and Markdown.
Escape in the editor interrupts the turn and requests a remote stop without another dialog.
Escape in suggestions, pickers or dialogs closes that context without stopping remote work; Escape in the review overlay sends nothing.
The footer shows the current Escape action.
No queued prompts, automatic write retries, or prompt replay.
Ctrl+O expands/collapses tool, plan, artifact and citation cards. No VNC connection.
Cloud only; native execution requires a supported registered Zoom/Synora host and bridge.
Ctrl+C clears the editor; press twice to exit. Ctrl+D exits an empty editor.
No local tools, shell, auto-retry, compaction, browser fallback or automatic provider approval.`;

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (['--cookies', '--resume', '--project', '--profile', '--config-dir', '--cdp'].includes(arg)) {
      const key = arg.slice(2), value = argv[++i];
      if (options[key] !== undefined || !value?.trim() || value.startsWith('--')) {
        throw new AppError('INVALID_INPUT', `${arg} requires one nonblank value.`);
      }
      options[key] = value;
    } else throw new AppError('INVALID_INPUT', `Unknown option ${arg}.`);
  }
  return options;
}

export async function runZoomMateTui(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(`${HELP}\n`); return; }
  if (options.version) {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${pkg.version}\n`); return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AppError('TTY_REQUIRED', 'ZoomMate requires an interactive terminal.');
  const { ensureProfileDirectory, resolveProfile } = await import('./profiles.mjs');
  const profile = await resolveProfile({
    profile: options.profile, 'config-dir': options['config-dir'], cookies: options.cookies, cdp: options.cdp,
  });
  if (options.cookies === undefined && !profile.hasCookies) throw new AppError('COOKIE_REQUIRED',
    `Profile ${profile.name} has no saved cookies. Use auth import --cookies PATH or explicitly authorized auth export, or supply --cookies PATH.`);
  await ensureProfileDirectory(profile);
  options.profile = profile.name;
  options.configDir = profile.root;
  options.cookies = profile.cookies;
  options.cdp = profile.cdp;
  options.agentDir = profile.agentDir;
  process.env.PI_CODING_AGENT_DIR = options.agentDir;
  process.env.PI_OFFLINE = '1';
  const { startZoomMatePi } = await import('./zoommate-pi-host.mjs');
  await startZoomMatePi(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  try { await runZoomMateTui(); }
  catch (error) { process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message ?? 'ZoomMate could not start.'}\n`); process.exitCode = 1; }
}
