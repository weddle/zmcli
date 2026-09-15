# zmcli

**Zoom Chat, Zoom Docs, and ZoomMate from the terminal.**

`zmcli` is a web-session client for reading and working with Zoom content, with structured output for scripts and automation. It also includes **`zoompi`**, an interactive ZoomMate terminal application built on [Pi](https://github.com/earendil-works/pi).

Both entry points share private local profiles and persisted cookies. Normal service operations run directly over HTTP and native WebSockets—not through browser automation. Browser-assisted authentication is a separate, explicit operation.

> **Status:** release candidate (`1.0.0-rc.1`). Install from source; the package is not currently published to npm. It depends on Zoom web-service protocols, so availability can vary with account permissions, product entitlement, and upstream changes.

> **Unofficial project:** `zmcli` and `zoompi` were developed by inspecting and interrogating Zoom's web application (PWA) and its behavior. This project is not a product of Zoom and is not affiliated with, endorsed by, sponsored by, or supported by Zoom in any way. Zoom names and trademarks belong to their respective owners.

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Quick start](#quick-start)
- [Authentication and profiles](#authentication-and-profiles)
- [CLI examples](#cli-examples)
- [Interactive ZoomMate with zoompi](#interactive-zoommate-with-zoompi)
- [Output and automation](#output-and-automation)
- [Safety and limitations](#safety-and-limitations)
- [Development](#development)

## What it does

| Area | Capabilities |
| --- | --- |
| **Zoom Chat** | Discover conversations, search messages, read threads and bounded activity, track new messages with checkpoints, and use supported messaging, attachment, reaction, membership, and organization controls. |
| **Zoom Docs** | Find and read documents, inspect comments and permissions, export Markdown, and use supported creation, editing, commenting, and sharing operations. |
| **ZoomMate CLI** | Inspect status and credits, list conversations and projects, read history, submit a prompt, watch a run, inspect artifacts, and request cancellation. |
| **ZoomMate TUI** | Work interactively with native conversation history, streamed Markdown, context selection, artifacts, citations, credit observations, and explicit approval dialogs. |
| **Profiles** | Keep separate cookie files and settings for different accounts or environments, with explicit import and browser refresh. |

The two executables serve different purposes:

- **`zmcli`** — noninteractive CLI with `auth`, `profile`, `chat`, `docs`, and `zoommate` command groups.
- **`zoompi`** — interactive ZoomMate client. Pi provides the terminal interface; ZoomMate remains the remote executor.

The package is named `zmcli`. Use `zmcli zoommate …` for machine-oriented ZoomMate operations and `zoompi` for the interactive interface.

## Install

### Requirements

- **Node.js 24 or newer.** The development runtime is pinned to **24.20.0** in [`.node-version`](.node-version).
- **npm**, with **11.9.0** recorded as the package manager version.
- Access to the source repository.
- A valid Zoom web-session cookie export for authenticated operations.
- An interactive terminal for `zoompi`.

The project is developed and verified on Linux. Browser-assisted acquisition additionally requires an already-running, authorized Chromium-compatible browser exposing a loopback CDP endpoint. A browser is **not** required for normal operation with saved cookies.

```sh
git clone https://forgejo.weddle.cloud/ryan/zmcli.git
cd zmcli
npm ci --ignore-scripts
```

Use `npm ci` to install the dependency versions recorded in `package-lock.json`. The Pi packages are exact-pinned; several other direct dependencies use version ranges, but the lockfile fixes the installed dependency tree.

Run directly from the checkout:

```sh
node src/cli.mjs --help
node src/zoommate-tui.mjs --help
```

Or install the local checkout's executables into your configured npm global prefix:

```sh
npm install --global . --ignore-scripts
zmcli --help
zoompi --help
```

Your npm global executable directory must be on `PATH` and writable by your user. Prefer a user-managed Node installation rather than installing with elevated privileges. Reinstall an older local installation to refresh its package and executable names.

The examples below use the installed commands. Without installation, substitute `node src/cli.mjs` for `zmcli` and `node src/zoommate-tui.mjs` for `zoompi`, from the application checkout.

## Quick start

Create a profile and import a **fresh cookie export that you are authorized to use**:

```sh
zmcli profile init --profile work
zmcli auth import --profile work --cookies /absolute/path/to/fresh-cookie-export.json
zmcli --profile work auth status
```

Inspect content or open the interactive client:

```sh
zmcli --profile work chat list
zmcli --profile work docs recent --limit 10
zmcli --profile work zoommate chats
zoompi --profile work
```

ZoomMate requires the corresponding account entitlement; successful Chat or Docs authentication does not establish ZoomMate availability.

Help is available without credentials or a running browser:

```sh
zmcli --help
zmcli profile --help
zmcli auth export --help
zmcli chat --help
zmcli docs --help
zmcli zoommate --help
zoompi --help
```

## Authentication and profiles

### Where data lives

By default, the application stores its configuration under `~/.zmcli`:

```text
~/.zmcli/
├── config.json                 # Default-profile settings
├── cookies.json                # Default-profile cookie export
├── cache/                      # Reserved for future cache storage
├── pi/                         # Local Pi session storage
└── profiles/
    └── work/
        ├── config.json
        ├── cookies.json
        ├── cache/
        └── pi/
```

The default profile lives directly at the root; it is not a `profiles/default` directory. `--profile NAME` selects a named profile. Names may contain letters, digits, underscores, and hyphens, must begin with a letter or digit, and are limited to 64 characters.

**Root precedence:** `--config-dir PATH` → `ZMCLI_HOME` → `~/.zmcli`.

**Cookie selection:** explicit `--cookies PATH` → the selected profile's `cookies.json`.

```sh
zmcli profile init
zmcli profile list
zmcli profile show --profile work
zmcli --config-dir /private/zmcli-home profile init --profile work
```

`profile show` reports resolved paths and whether cookies are present; it does not print cookie values. Named profiles do not inherit another profile's settings or credentials. A missing named profile is an error, not a fallback to the default account.

Managed directories are created with mode `0700`; configuration and cookie files use `0600`. Unsafe managed paths or permissions fail closed. Cookies are sensitive, unencrypted files—not an OS keychain. Keep them outside source control and shared folders.

`cache/` currently reserves a location only; it is not a new service cache. Pi session storage is profile-local, while theme settings retain their existing in-memory behavior. Old state directories are not automatically migrated.

### Import an existing export

```sh
zmcli auth import --profile work --cookies /private/fresh-export.json
```

The input is a JSON array of browser cookie objects, as produced by `auth export`. Import copies and validates the file without contacting a browser or changing the source. Existing managed cookies require explicit `--replace`:

```sh
zmcli auth import --profile work --cookies /private/new-export.json --replace
```

Replacement is staged and validated before atomic installation. Failed acquisition or invalid input preserves the previous managed cookie file.

For a one-off operation, bypass managed cookies without changing them:

```sh
zmcli --profile work --cookies /private/another-export.json auth status
```

### Capture or refresh cookies from a browser

First arrange an authorized browser session with loopback remote debugging enabled and sign in to the intended account. A profile name selects **local storage**, not a browser account; confirm the browser's actor before exporting.

Save the endpoint and capture cookies:

```sh
zmcli profile set --profile work --cdp http://127.0.0.1:9222
zmcli auth export --profile work
```

To explicitly refresh an existing managed cookie file:

```sh
zmcli auth export --profile work --replace
```

**CDP precedence:** `--cdp URL` → the selected profile's saved `cdp` setting → `http://127.0.0.1:9222`.

Saving a CDP URL does not initiate a connection or authorize acquisition. `auth export` connects to the existing browser; it does not launch one or log in. Only supported HTTP loopback CDP endpoints are accepted, not remote or relay-style hosts.

Use `auth export --out /private/new-export.json` for a separate external file. That destination must be new; `--replace` applies only to managed profile cookies.

### Username/password acquisition

`auth acquire --method password-browser` supports explicit browser-assisted login. It reads the username and password from two distinct, already-open protected descriptors supplied through `--username-fd` and `--password-fd`. It does **not** offer interactive username/password prompts, and it does not accept credentials in arguments or environment variables.

```sh
zmcli auth acquire --help
zmcli auth methods
```

This method uses an isolated context in an already-running authorized browser. Omitting `--output-cookie-file` saves cookies into the selected profile; replacement still requires `--replace`. Usernames and passwords are never persisted. MFA, CAPTCHA, or SSO require a human handoff rather than a bypass or automatic method switch.

### Runtime authentication

Normal commands use the selected cookie file to obtain service-specific credentials. Working tokens and response-cookie updates stay in memory; normal runtime does not rewrite the saved cookie export or fall back to a browser. Revoked or expired underlying session authority requires explicit fresh acquisition.

## CLI examples

Replace identifiers and paths with values from your own authorized environment. Read-only examples do not grant permission for unrelated writes.

### Chat

```sh
zmcli --profile work chat list
zmcli --profile work chat search --query 'release checklist' --limit 20
zmcli --profile work chat message --link 'https://zoom.us/launch/chat/v2/…'
zmcli --profile work chat new-messages --limit 20 --max-pages 5
```

New-message checkpoints and pagination cursors are opaque. Use returned tokens with the same actor and command scope; do not construct or reuse them across accounts.

### Docs

```sh
zmcli --profile work docs recent --limit 10
zmcli --profile work docs find --query 'Project plan'
zmcli --profile work docs read --id DOC_ID
zmcli --profile work docs export-markdown --id DOC_ID --out project-plan.md
```

Markdown export writes a local file. Document edits, comments, shares, message sends, and other mutations are explicit commands with operation-specific guards. Use command help before performing them.

### ZoomMate

```sh
zmcli --profile work zoommate status
zmcli --profile work zoommate credits
zmcli --profile work zoommate chats
zmcli --profile work zoommate history --id CHAT_ID
```

**The following commands submit remote work and may consume shared-account credits.** Review the prompt and authorize its scope before running:

```sh
zmcli --profile work zoommate query --new --prompt-file prompt.txt --stream
zmcli --profile work zoommate query --id CHAT_ID --prompt-file prompt.txt --stream
```

Choose exactly one of `--new` or `--id`. `--prompt-file -` reads UTF-8 input from stdin. A failed resume does not create a replacement conversation, and an uncertain write is not automatically replayed.

## Interactive ZoomMate with zoompi

```sh
zoompi --profile work
zoompi --profile work --resume CHAT_ID
zoompi --profile work --project PROJECT_ID
```

Type `/` for command completion. Common controls:

| Command | Purpose |
| --- | --- |
| `/chats`, `/resume`, `/new` | Select, restore, or stage a native conversation. |
| `/project` | Select or clear the remote project. |
| `/attach`, `/skills`, `/connectors` | Manage explicit context and available capabilities. |
| `/artifacts`, `/files`, `/sources` | Inspect artifacts, conversation files, and citations. |
| `/computer` | Inspect captured computer-use output; not a live VNC connection. |
| `/credits` | Inspect the shared-account credit balance. |
| `/approve` | Reopen a dismissed provider review. |
| `/cancel` | Confirm a remote stop request and check its outcome. |
| `/session`, `/session verbose` | Inspect current state and detailed diagnostics. |
| `/help`, `/quit` | Show help or detach without cancelling remote work. |

- **Escape in the editor** interrupts the active turn and requests a remote stop without another confirmation dialog. In a picker or review dialog, Escape dismisses that interface without granting approval.
- **Ctrl+O** expands or collapses tool, plan, artifact, and citation cards.
- **Ctrl+D** exits an empty editor. **Ctrl+C** clears the editor; pressing it twice exits.
- Exiting or disconnecting detaches; it does not undo completed work or automatically cancel a remote run.

The client does not expose your local shell, filesystem, or browser as agent tools. Remote execution remains subject to ZoomMate's capabilities and permissions. Supported native execution requires a registered host/bridge; launching this TUI does not provision one.

## Output and automation

`zmcli` emits a JSON success envelope on stdout: `{ "ok": true, "data": … }`. Errors go to stderr as `{ "ok": false, "error": … }`, with a nonzero exit status. Even ordinary CLI help is carried in the JSON envelope; `zoompi --help` is plain terminal text.

Use machine-readable help to discover commands and options:

```sh
zmcli --help --json
zmcli docs read --help --json
```

Supported streaming commands emit versioned JSONL events and a terminal result with `--stream`; they do not mix the interactive TUI into stdout.

| Exit code | Meaning |
| --- | --- |
| `0` | Success. |
| `2` | Invalid arguments or input. |
| `3` | Authentication failure or required authentication interaction. |
| `4` | Forbidden or access denied. |
| `1` | Other operational errors. |

Inspect the returned error code and any coverage, pagination, availability, or unsupported-content fields. Success is not a blanket claim that a query is exhaustive. Some operations have explicit capability or source-availability limits.

## Safety and limitations

- Use only accounts and resources you are authorized to access. Account identity alone is not permission to mutate a resource.
- Do not commit cookies, passwords, tokens, raw private captures, or profile directories. Redact sensitive data before sharing diagnostics or filing an issue.
- CDP access can expose browser session authority. Keep it loopback-only and use a deliberately selected browser session.
- There is no automatic browser login, cookie refresh, account switching, or provider approval. Short-lived service-token renewal is separate from acquiring new browser cookies.
- Bounded recovery for safe reads is not permission to replay an uncertain write. Check the native outcome before retrying a mutation.
- ZoomMate availability and advanced features depend on provider entitlement. Credit observations are shared-account snapshots, not per-request billing guarantees.
- Web protocols can change. Unsupported or unavailable results must not be treated as proof of an empty dataset.

## Development

```sh
npm ci --ignore-scripts
npm run verify
npm run cli -- --help
npm run zoompi -- --help
```

The test suite uses fixtures and synthetic transports; running it does not require live Zoom credentials. Live protocol checks are separate and require explicit authorization.

```text
src/                  Application, transports, profiles, CLI and Pi integration
test/                 Regression tests
test/fixtures/        Sanitized protocol fixtures
package.json          Package identity, executables and dependencies
package-lock.json     Resolved dependency tree
.node-version         Development Node version
```

For changes, preserve the cookie-only runtime boundary, avoid replaying uncertain writes, and verify the affected behavior. Keep credentials and private captures out of application commits.

## License

Copyright (c) 2026 Ryan Weddle. Licensed under the [MIT License](LICENSE).

Third-party dependencies retain their own licenses and copyright notices. This license does not grant rights to Zoom's services or trademarks.
