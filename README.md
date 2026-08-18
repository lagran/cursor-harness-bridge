# Cursor Harness Bridge

Use the DeepSeek Harness Web UI with a local Cursor SDK agent as the execution
runtime.

```text
DeepSeek Harness Web UI
        -> cursor-harness-bridge AgentFactory
        -> @cursor/sdk local agent
        -> selected workspace
```

Cursor owns model calls and tool execution. Harness owns the browser UI,
event-sourced transcript, session list, streaming presentation, and generic
tool cards. The bridge never sends Cursor tool calls back through Harness'
tool executor, so file edits and shell commands run exactly once.

## Requirements

- Node.js 22.19+ or 24+
- pnpm available through Corepack (required by `dsh plugin`)
- Linux: `bubblewrap` / `bwrap`
- A Cursor user or service-account API key

On RHEL-compatible Linux:

```bash
sudo dnf install -y bubblewrap
corepack enable
corepack install --global pnpm@latest
```

RHEL 8's stock Python and GCC are too old if `node-pty` has to compile locally.
Install the newer toolchain before `npm install`:

```bash
sudo dnf install -y python3.11 gcc-toolset-13-gcc-c++
source /opt/rh/gcc-toolset-13/enable
export PYTHON=/usr/bin/python3.11
```

## Setup

```bash
cd cursor-harness-bridge
npm install
cp .env.example .env
# Edit .env and set CURSOR_API_KEY / CURSOR_WORKSPACE.

npm run build
npm run profile:install
```

Export the variables or load `.env` in your shell, then start the UI:

```bash
set -a
. ./.env
set +a
npm run web -- --workspace "$CURSOR_WORKSPACE"
```

Open `http://127.0.0.1:3080`.

The installation command adds this local bundle to the standard Harness
`web` profile under `$DSH_HOME` (default `~/.dsh`). Re-run it after moving the
bridge directory.

Instead of defining `CURSOR_API_KEY` in `.env`, you may enter it under
**Settings → Models → Cursor Agent**. The bridge resolves
`CURSOR_API_KEY` through Harness' Credential Store for every catalog or Agent
operation. A `credentials/updated` event immediately invalidates the fallback
catalog, fetches Cursor's current models, and refreshes the model picker without
restarting Harness. An inherited process-environment Key remains read-only and
takes precedence, matching Harness credential-layer rules.

## Optional production deployment

This repository contains no deployment hostname, account name, public IP, or
machine-specific absolute path. Supply those facts on the target host:

```bash
export CURSOR_WORKSPACE=/srv/your-project
export HARNESS_DOMAIN=harness.example.com
export HARNESS_PORT=3080
export HARNESS_RUN_USER="$(id -un)"

sudo -E ./scripts/install-systemd.sh
```

`install-systemd.sh` resolves the current checkout, workspace, Node binary,
environment file, user/group, domain, and port, then renders
`deploy/cursor-harness.service.in` into `/etc/systemd/system`. Harness remains
bound to loopback; your own TLS proxy decides how it is exposed.

Service operations:

```bash
sudo systemctl status cursor-harness.service
sudo systemctl restart cursor-harness.service
sudo journalctl -u cursor-harness.service -f
```

If you change an environment-supplied `CURSOR_API_KEY`, restart systemd so it
loads the new value. Keys saved through **Settings → Models** are hot-reloaded
and do not require a restart.

### Optional mTLS

The certificate helper is deployment-neutral. Its default state root is:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/cursor-harness-bridge/mtls
```

Override it and the certificate subject for your environment:

```bash
export HARNESS_MTLS_DIR=/var/lib/cursor-harness/mtls
export HARNESS_CA_ORGANIZATION="Example Organization"
export HARNESS_CA_COMMON_NAME="Example Production Harness CA"
# Optional: reload this container after CRL updates.
export NGINX_CONTAINER=my-nginx

./scripts/harness-mtls.sh init
./scripts/harness-mtls.sh issue laptop
./scripts/harness-mtls.sh issue phone
./scripts/harness-mtls.sh list
```

If `HARNESS_CA_COMMON_NAME` is omitted on a new deployment, the helper
generates a random unique CA Common Name and persists it in
`$HARNESS_MTLS_DIR/ca/ca-common-name`. This keeps the acceptable issuer DN
different across independent Harness deployments, so browsers do not offer a
client certificate from another installation. An existing CA's subject is
authoritative and never changes during upgrades; an explicit mismatching name
is rejected.

Install packages from
`$HARNESS_MTLS_DIR/clients/<device>/<device>.p12`; each directory contains its
own root-readable `password.txt`. Mount only `$HARNESS_MTLS_DIR/public`
(`ca.crt` and `ca.crl`) into the TLS proxy. Never mount or distribute
`ca/private/ca.key`.

Do not send a `.p12` and its password through the same messaging channel.

- macOS: import the `.p12` into the login keychain.
- Windows: import it for the current user into Personal certificates.
- iPhone/iPad: transfer it with AirDrop and install the downloaded profile.
- Android: install it as a VPN & app user certificate.

Revocation regenerates the CRL:

```bash
./scripts/harness-mtls.sh revoke laptop
./scripts/harness-mtls.sh refresh-crl
```

Configure your own HTTPS virtual host to require that CA and proxy to the
loopback Harness port. Use a certificate for a domain you control; the
`harness.example.com` value above is documentation-only.

If Cursor's long-lived local runtime returns an authentication error while the
configured API key still validates, the bridge disposes and reopens that
session's SDK agent and retries the run once before surfacing the error. A
systemd timer also refreshes the Harness process daily around 04:30 so
short-lived SDK authentication state never remains in memory for several days.

If your reverse proxy injects `deploy/harness-mobile.css` and
`deploy/harness-image-upload.js` into Harness HTML, the settings view becomes a
full-screen mobile sheet and iOS/Android gain a native image picker. Re-run the
browser smoke checks after upgrading Harness because preview releases may
change generated CSS-module class names.

### Mobile shell and home-screen icon

Three more deployment assets refine the phone experience:

- `deploy/harness-mobile.css` also turns Harness' desktop three-column grid
  into a single-column layout: an open sidebar or details panel becomes a
  fixed overlay sheet above a dimmed scrim instead of squeezing the
  transcript into a narrow strip. The sidebar content fills that sheet without
  exposing its desktop-width background edge, and the transcript header
  collapses its mode badge / "Session log" label to icons so the session title
  stays readable.
- `deploy/harness-mobile-nav.js` adds the matching behaviors: picking a
  session auto-closes the sheet, and tapping anywhere outside it (or pressing
  Escape) closes it. Closing always goes through Harness' own collapse-sidebar
  control in either locale so React state stays authoritative. This
  deployment also hides and immediately completes Harness' internal-testing
  notice.
- `deploy/harness-manifest.webmanifest` plus `deploy/harness-icons/`
  (generated by `scripts/generate-icons.py`) give "Add to Home Screen" a
  recognizable icon: an opaque `apple-touch-icon.png` for iOS, rounded PNG
  icons for the manifest, and a full-bleed maskable icon that keeps the
  glyph inside Android's adaptive safe zone.

`scripts/deploy-mobile-assets.sh` copies these into a selected running Nginx
container, patches the rendered vhost (extra `location` blocks plus the
`<head>` injection of the apple-touch-icon, PWA meta tags, and both scripts),
and reloads nginx. Pass `--host` to also patch the host nginx template and
compose mounts so the deployment survives a container recreate:

```bash
HARNESS_NGINX_CONTAINER=my-nginx \
HARNESS_PROXY_PROJECT=/path/to/proxy-project \
HARNESS_RECREATE=1 \
  bash scripts/deploy-mobile-assets.sh --host
```

No container name, checkout path, domain, or client-certificate location is
embedded in the script. `--host-only` patches the host project without touching
a running container. If your proxy uses another layout, set
`HARNESS_NGINX_TEMPLATE` and `HARNESS_COMPOSE_FILE`; set
`HARNESS_COMPOSE_SERVICE` when its service is not named `nginx`.

## What is mapped

- token-level visible text and reasoning
- complete assistant messages
- tool start, arguments, completion/error, result, and truncation notices
- nested task progress
- token usage when Cursor reports it
- Harness cancellation to `Run.cancel()`
- multi-turn and process-restart recovery through a fixed Cursor JSONL store
- Cursor model discovery in the Harness model picker
- PNG, JPEG, WebP, and GIF attachments through Cursor SDK image messages

### Image input

Every Cursor route advertises text and image input. The bridge reads each
content-addressed Harness attachment through `ctx.attachments`, verifies it,
and sends ordered base64 images with MIME type and intrinsic dimensions through
`SDKUserMessage.images`.

Harness already supports paste and whole-page drag/drop. The production vhost
also injects `deploy/harness-image-upload.js`, adding an accessible **Add
images** button so iPhone/iPad users can choose images from Photos or Camera.
Drafts continue through Harness' native count, byte-size, pixel, preview, and
durable-storage checks.

### Cursor model options

The bridge expands Cursor's dynamic model catalog into Harness-compatible
routes:

- `context`, `thinking`, and `fast` become explicit model variants, for
  example `Opus 4.8 · Thinking On · Context 1M · Fast`.
- `effort`, `reasoning`, and Cursor Router's `optimize_for` use Harness'
  separate Effort selector.
- Selecting a variant is translated back to the original Cursor model id plus
  its exact `model.params`; synthetic Harness route ids never reach Cursor.
- The unsuffixed model id always represents Cursor's `isDefault` variant, so
  existing saved selections remain compatible.

The number of selectable routes is derived from the authenticated Cursor
account at runtime; no account-specific catalog is committed to this repository.

Tool names and payloads are not a stable Cursor SDK contract. Unknown tools use
Harness' generic card and payloads are serialized defensively. Values larger
than 50,000 characters are truncated in the Harness transcript.

## Permission model

The Harness composer permission selector controls Cursor execution for each
session:

- `Read Only` enables Cursor Sandbox and Auto-review and exposes only read,
  search, lint, and web-read tools. Shell, edits, deletes, MCP, subagents, and
  image generation are unavailable.
- `Workspace Write` enables Cursor Sandbox without Auto-review and keeps the
  standard toolset. Only the session's primary workspace is passed as a
  writable root; commands that need unsandboxed access fail instead of being
  sent to a classifier that could allow them.
- `Full Access` disables Cursor Sandbox and Auto-review and uses the SDK's
  unrestricted headless default toolset.

Changing the permission while a run is active cancels that run immediately.
The next turn resumes the same durable Cursor agent with the new policy, so
conversation context is retained without letting the old policy continue.

`CURSOR_ADDITIONAL_DIRS` and `CURSOR_SETTING_SOURCES` remain comma-separated
process settings. Additional directories are readable under `Read Only`,
omitted under `Workspace Write`, and fully available under `Full Access`.
Restart Harness after changing either setting.

On Linux, startup fails if `bwrap` is unavailable. Auto-review may allow or
deny a tool call, but it is not a security boundary; the OS sandbox is the
enforcement layer. The bridge prepends a narrow Bubblewrap compatibility
wrapper for RHEL 8: it removes only redundant read-only self-binds of CA
certificate symlinks when Cursor also binds the resolved target. This avoids
the Bubblewrap 0.4 symlink-mount preflight failure without widening the
filesystem policy.

Cursor's public headless SDK currently has no API to answer an interactive
approval. Its `request` stream event contains only an id and there is no
`approve`, `deny`, or `respond` method. If such an event appears, the bridge
ends the turn with an explicit error instead of hanging.

## Performance and recovery

- Cursor agent state is stored in per-workspace SQLite databases. The first
  startup after upgrading migrates the portable JSONL store in place and keeps
  the original files as a rollback source.
- Published sessions prewarm Cursor's workspace executor, and rules, skills,
  `AGENTS.md`, and ignore scans are cached for five minutes by default.
- A run with no SDK delta or message for 90 seconds is cancelled. The bridge
  retries once only when the attempt produced no output or tool call; otherwise
  it fails with `CURSOR_RUN_STALLED` to avoid repeating side effects.
- `CURSOR_WORKSPACE_SCAN_CACHE_MS` and `CURSOR_RUN_STALL_MS` override the two
  defaults. Cursor's own unbounded transport/stall retry is disabled.

The bridge logs `openMs`, `sendMs`, `firstOutputMs`, and `totalMs` for every
run. These isolate bridge overhead from model latency. Large-context,
non-Fast, maximum-reasoning variants remain slower by model design.

## Current boundaries

- Harness steering received during a Cursor run is queued as the next turn.
- A Harness fork creates a separate Cursor context instead of sharing mutable
  conversation state with its parent.
- Deleting a Harness session does not currently garbage-collect its Cursor
  checkpoint files.
- Cursor SDK and DeepSeek Harness are both pre-release surfaces; versions are
  pinned in `package-lock.json`, and upgrades should run the contract tests.
- `@cursor/sdk@1.0.28` currently brings an `undici` version reported by
  `npm audit` with upstream HTTP/WebSocket advisories and no compatible fix.
  Keep the Harness listener on loopback and re-audit when Cursor publishes an
  updated SDK.

## Checks

```bash
npm run typecheck
npm test
npm run build
CURSOR_WORKSPACE=/path/to/project npm run test:web
npm run test:mobile
npm run test:sidebar
npm run test:image
npm run test:mtls
```

The mobile and image tests inject deployment assets themselves when run
against loopback. To test your TLS proxy instead, set `HARNESS_ORIGIN` and,
when mTLS is enabled, `HARNESS_CLIENT_CERT` / `HARNESS_CLIENT_KEY`.

The real-agent smoke test runs only when `CURSOR_API_KEY` is set:

```bash
npm run smoke -- --workspace /path/to/project
```
