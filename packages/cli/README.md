# ZTerm CLI

`@jsonstudio/zterm-cli` provides the `zterm` command for connecting to an existing
ZTerm daemon session and managing the local daemon installation.

## Current status

CLI 0.1.3 labels, preview navigation, and fresh on-demand tmux snapshots passed
installed macOS acceptance. The Air daemon also passed socket-alias catalog
deduplication and exact snapshot retrieval with an existing saved slot. Source
integration status is recorded in `android/note.md`.

Version 0.1.4 projects concise slot labels and moves snapshot preview into a
single five-action configure menu. It passed installed macOS full-user-path
acceptance and matching list/selector labels. This does not claim acceptance on
other platforms.

The configurable tmux socket and local daemon configuration commands below are
the Increment A candidate contract. They are not claimed as delivered until the
built candidate passes installed CLI and native socket acceptance.

`packages/cli/src/main.ts` is the formal command entry. The package build and
isolated tarball installation work on the current development host.

On macOS arm64, the real user path passed from an isolated npm tarball through
login, slot selection, snapshot, mirror, input, resize, `Ctrl+] q`, stale
identity, logout, and cleanup. The npm isolation upgrade suite passed 8/8.
The CLI test suite also covers stale session identity and request-driven initial
mirror delivery.

`@jsonstudio/zterm-cli@0.1.5` and `@jsonstudio/zterm-daemon@0.1.4` (together with
`@jsonstudio/zterm-daemon-darwin-arm64@0.1.4`,
`@jsonstudio/zterm-daemon-linux-x64@0.1.4`, and
`@jsonstudio/zterm-daemon-win32-x64@0.1.4`) are published to the public npm
registry. CLI `0.1.5` adds the `zterm app` cross-machine message and file
commands; daemon `0.1.4` adds the `/app` WebSocket gateway they use.
See [`../../docs/install-from-zero.md`](../../docs/install-from-zero.md) for the
from-zero installation guide, `AppSDK`/`Collab` install order, and the verified
vs. unverified blank-machine audit matrix. Windows x64, Linux x64 and macOS
arm64 have passed native builds, installed CLI checks, isolated npm upgrade
checks and the native daemon installation matrix in CI run `40797381369`.
The installed Windows remote user path has also passed login reuse, exact slot
selection and snapshot, initial mirror, remote input, resize, local exit with
terminal restoration, and logout. The separate public RTC API consumer checks
the actual TURN relay/relay route and the original connection deadline. Its
per-run results remain separate from installed CLI behavior; see the PR checks
and their evidence artifacts for the acceptance result of each candidate.

## Platforms and requirements

Target platforms:

- `darwin-arm64`
- `linux-x64`
- `win32-x64`

Requirements:

- Node.js 22 or later for the CLI.
- Network access to the Relay account service selected by your account.
- An online ZTerm daemon that publishes a stable session catalog.
- For `zterm daemon install`, the `@jsonstudio/zterm-daemon` launcher and the
  matching platform payload must be available for the current OS, CPU, Node
  version, and Node ABI.

The CLI must not guess a daemon address or daemon credential from the local
host OS. It resolves the selected daemon from the logged-in account directory
and the exact server and session identity saved in the slot.

## Install

Global npm installation (`@jsonstudio/zterm-cli@0.1.5` and `@jsonstudio/zterm-daemon@0.1.4`):

```sh
npm install --global @jsonstudio/zterm-cli
zterm --version
zterm daemon install --version 0.1.4
```

See [`../../docs/install-from-zero.md`](../../docs/install-from-zero.md) for OS-specific dependency setup (including Node.js 22 LTS `ABI 127` for `zterm-daemon` and `TMUX_TMPDIR="$HOME/.tmux/run"`).

For local package development, build and install the actual CLI tarball into
an isolated prefix:

```sh
pnpm --dir packages/cli run pack:release
CLI_TARBALL="$(find packages/cli/dist -maxdepth 1 -name '*.tgz' -print -quit)"
npm install --global --prefix "$PWD/.zterm-cli-prefix" "$CLI_TARBALL"
"$PWD/.zterm-cli-prefix/bin/zterm" --version
```

On Windows, install into the same kind of isolated prefix and run
`.zterm-cli-prefix\zterm.cmd --version`. The tarball path is a local development
artifact. Its use does not show that public npm installation is available.

## Quick start

After the CLI is installed from a release or a local tarball:

```sh
zterm login
zterm slot set 1
zterm 1
```

The normal path needs no separate CLI configuration file and no extra endpoint
arguments. Login state, slots, and daemon settings all use the shared
`~/.zterm/config.json` file described below.

## Login and logout

### Interactive login

```sh
zterm login
```

If `zterm.cli.server.relayBaseUrl` already exists, `zterm login` asks only for
the account name and password. If the Relay URL is missing, it asks for the URL
first. The password is hidden on a TTY.

On success, the new local login identity is committed atomically. Current and
future CLI processes reuse it. A failed or cancelled login does not replace an
existing valid login.

### One-time login input from the shared config

Use `--from-config` only for controlled one-time automation:

1. Create or edit `~/.zterm/config.json`.
2. Set `zterm.cli.server.relayBaseUrl`.
3. Set `zterm.cli.loginInput.username` and
   `zterm.cli.loginInput.password`.
4. Restrict the file to the current user.
5. Run:

```sh
zterm login --from-config
```

The password is consumed in the login-start transaction before the network
request. A later authentication failure does not restore it. Do not leave a
long-lived plaintext password in this file. Prefer interactive login when a
person is present.

On macOS and Linux, `chmod 600 ~/.zterm/config.json` limits read and write access
to the file owner after you create it. On Windows, restrict the file ACL to the
current user with the operating system's file-security tools.

### Logout

```sh
zterm logout
```

Logout clears the local CLI login state and advances the local auth generation.
It keeps the Relay server, slots, daemon configuration, and unrelated fields.
It does not claim that copied or already issued Relay tokens were revoked
remotely. Local connections that used the old login identity stop using it.

## Shared configuration

The only configuration file in scope is:

```text
~/.zterm/config.json
```

The CLI and daemon read and write different typed sections of this one file.
There is no separate CLI config path. Use the CLI for normal writes. Do not
hand-edit `auth`, `authGeneration`, or `slots`; they are written by login and
slot commands.

Minimal example with placeholders only:

```json
{
  "zterm": {
    "android": {
      "daemon": {
        "host": "0.0.0.0",
        "port": 3333,
        "authToken": "<daemon-token>",
        "sessionName": "zterm-daemon-3333",
        "terminalCacheLines": 3000
      }
    },
    "cli": {
      "server": {
        "relayBaseUrl": "https://relay.example.test/zterm/"
      },
      "loginInput": {
        "username": "<account-name>",
        "password": "<one-time-password>"
      }
    }
  }
}
```

Field meaning:

| Field | Meaning |
|---|---|
| `zterm.cli.server.relayBaseUrl` | Relay account server used by `zterm login` and account directory reads. |
| `zterm.cli.loginInput.username` | One-time username input for `zterm login --from-config`. |
| `zterm.cli.loginInput.password` | One-time password input. The login-start transaction removes it. |
| `zterm.android.daemon.host` | Daemon listen address on the daemon host. |
| `zterm.android.daemon.port` | Daemon listen port. |
| `zterm.android.daemon.authToken` | Daemon authentication secret. Do not use the Relay account token here. |
| `zterm.android.daemon.sessionName` | Default daemon session name. Omit it to use the current default. |
| `zterm.android.daemon.terminalCacheLines` | Daemon mirror retention in lines. Omit it to use the current default. |

### Configurable tmux sockets (design only; not implemented)

The deployed daemon does not read this block yet. It discovers tmux sockets at
the process `TMPDIR`, the CLI default `/tmp` root, the standard host root
`~/.tmux/run` and its own stable `~/.zterm/tmux` directory, and it shares the
standard path resolver in `packages/shared/src/terminal/tmux-socket-path.ts`.
Configure a host with `scripts/setup/ensure-tmux-session-path.sh`, which adds a
missing `TMUX_TMPDIR="$HOME/.tmux/run"` export or repoints an existing one.

The canonical tmux socket block is:

```json
{
  "zterm": {
    "android": {
      "daemon": {
        "tmux": {
          "sockets": [
            {
              "name": "main",
              "socketPath": "~/.tmux/run/tmux-<uid>/default"
            },
            {
              "name": "old",
              "socketPath": "/private/tmp/tmux-<uid>/default"
            }
          ],
          "primary": "main"
        }
      }
    }
  }
}
```

Replace `<uid>` with the current user's numeric UID. The CLI derives that value
at runtime; it does not hardcode a user name or UID.

`sockets` is a non-empty ordered list of explicit socket routes. `name` is the
local display label and CLI selection key. It does not enter a stable session
identity. `socketPath` must be absolute or start with `~/`. The CLI stores the
portable `~/` form and resolves it only for runtime use.

When the block is absent, the CLI derives one route named `default`:

```text
~/.tmux/run/tmux-<current uid>/default
```

There is no `mobile.daemon.tmux` compatibility reader or writer. Unknown data
at that older location is preserved.

The CLI accepts no tmux socket environment override or filesystem discovery.
An invalid block, empty path, unsupported relative path, duplicate name,
duplicate resolved path, or missing primary fails without replacing the file.

Local socket configuration uses the shared configuration owner directly. It
does not require account login, Relay access, daemon installation, a running
daemon, or the installed daemon shim. Reading a missing configuration does not
create a file. Existing-only reads and catalog preview do not start a server,
session, keepalive, directory, or lease.

Configure a socket with:

```sh
zterm daemon config
zterm daemon config tmux set main --socket '~/.tmux/run/tmux-501/default'
zterm daemon config tmux set old --socket /private/tmp/tmux-501/default
zterm daemon config tmux primary old
zterm daemon config tmux remove main
```

The first `set` creates the tmux block and makes that entry primary. Later
`set` commands add or update one named route. You cannot remove the primary
route while other routes remain, and you cannot remove the final route.
Mutations preserve authentication, slots, Relay settings, other daemon fields,
and unknown fields. The output reports the real config path and says that the
change applies to the next daemon start, not to a running process.

Do not copy a daemon endpoint from another platform or infer one from the host
OS. The account directory and saved slot are the source for the selected
remote server.

## Slots

Slots are numbered integers from 1 through 20.

```sh
zterm slot list
zterm slot set 1
zterm
zterm 1
```

`zterm slot list` reads local slot bindings only. It does not log in again or
refresh the remote directory.

No-argument `zterm` lists configured slots and asks you to choose one. It does
not refresh the account directory.

`zterm 1` resolves the exact saved binding for slot 1. It does not ask for a
server or session again and does not rebind by display name.

### Name and synchronize slots

```sh
zterm slot rename 1 "Studio · server-1"
zterm slot list
zterm slot push 1
zterm slot pull 1
zterm slot push --all
zterm slot pull --all
```

Names are optional. The list shows the slot number, the name when present, and
the saved machine and session once. Backend, width mode, device ID, and stable
session ID stay in the saved binding instead of the routine list. Without a
name, the line uses the machine and session names. The slot number is the
selection value. Rename works while logged out and changes only the local name.
Configuring an existing slot preserves its name.

Cloud sync requires login and a Relay server with the slot configuration API.
Another computer logged in to the same account can pull the saved bindings.
Sync includes slot numbers, names, stable server/session identities, display
names, and width modes. Login tokens, passwords, endpoint secrets, and daemon
configuration stay local. Pull does not connect to or create a session.

Every pull or push requires a slot number or `--all`. A single-slot pull
replaces only that local slot; a single-slot push replaces only that cloud
slot. A missing cloud slot fails without changing local configuration.

`push --all` replaces the account's complete cloud slot set with its local
slots. An empty local set intentionally clears the cloud set. `pull --all`
replaces the local slots owned by the logged-in account, including removal of
local-only slots for that account. It preserves other accounts' slots and
fails atomically if an incoming number belongs to another account locally.
A cloud account that has never saved slots fails pull without local changes.
An explicitly saved empty cloud set clears the current account's local slots
when pulled with `--all`.

Sync is explicit. There is no automatic merge or background sync. The latest
accepted push replaces the selected cloud scope. If the connection fails after
a push was dispatched, the command reports that the remote result is unknown.
Read back the cloud configuration before deciding whether to push again.

### Configure a slot

```sh
zterm slot set 1
```

The interactive flow is:

1. Read the current account directory.
2. List servers that have an online or offline daemon record.
3. Choose one exact `deviceId + daemonHostId` server.
4. Read the daemon session catalog.
5. Choose a session with both `backend` and non-empty `stableId`.
6. Choose one action from the single five-choice menu: save, preview, reselect
   session, return to servers, or exit.

The catalog reads only the configured tmux socket routes. If two configured
sockets have a session with the same name, both entries appear with distinct
labels, for example:

```text
work [tmux · main]
work [tmux · old]
```

Labels are display metadata only. Selection and save use the exact
`{ backend, stableId }` identity.

When one configured route is unavailable, the catalog still returns reachable
entries and shows the failure for that route. Each failure contains the socket
name, socket path, error code, and a safe message. Cached resident reads keep
the failures beside the entries. Reachable entries remain selectable. A
reachable route with zero sessions is a successful empty result. If every
configured route fails, the catalog request fails with a correlated error. No
unconfigured route is used as a fallback, and reading an absent socket does not
start a replacement server.

Cancellation leaves the original slot unchanged. If another process changes
the same slot before save, the command reports `slot_changed` and keeps the
newer binding instead of overwriting it.

Snapshot preview is opt-in and read-only. Choosing 预览 snapshot does not attach
a terminal, create a mirror, start continuous capture, resize a terminal, or
send input. Older daemons may still report a preview as unavailable when no
mirror is ready; that does not itself create a mirror. A preview requests one
detached frame for the exact selected target, then returns to the same menu on
the same connection and the original slot baseline. A failed capture or an
identity mismatch fails the command without writing the slot. The action menu
has five choices:

| Choice | Behavior |
|---|---|
| 保存到槽位 N | Build the binding from the current selection and save to slot N with the original slot baseline. |
| 预览 snapshot | Request one detached frame for the exact selected target, then return to the same five-choice menu. Never saves by itself. |
| 重新选择 session | Refresh the session catalog on the current connection, discard the current selection and preview, and choose again. |
| 返回服务器选择 | Close the current connection once, show the retained server directory, and connect only after another server selection. |
| 退出配置 | Cancel the whole command without writing the slot. |

Only the save choice writes the slot. `Ctrl+C` and EOF cancel the whole
command at every prompt without writing. Authentication, account directory
lookup, and the original slot baseline happen once before navigation. Each
successfully opened connection has one close scope; returning to servers
closes it before the server picker, and a cleanup failure is reported and
stops the command instead of opening another connection. Same-server session
reselection keeps the current connection. `slot_changed` preserves the newer
concurrent binding and the original baseline; it never promotes the navigation
draft. Saving preserves the existing alias and width mode. If cleanup fails
after a successful save, the saved result remains and the cleanup error is
reported separately.

The candidate keeps exact `{ backend, stableId }` targeting and the current
one-shot capture contract: the preview captures one fresh frame without
attaching, resizing, sending input, starting continuous capture, or writing
the live mirror. A failed or timed-out preview is explicit and does not reach
save.

### Width mode

The CLI uses the same two width modes as the App:

| Mode | Behavior |
|---|---|
| `adaptive-phone` | Reports the current local column count to the daemon adaptive-width owner. That owner may reflow tmux columns. Rows are not continuously rewritten by the CLI. New slots default to this mode. |
| `mirror-fixed` | Keeps the daemon mirror and tmux width unchanged. The local renderer crops the upstream columns and uses local horizontal pan. |

Set a slot's width mode during slot configuration:

```sh
zterm slot set 1 --width-mode mirror-fixed
```

The command preserves the existing slot mode when you omit the override.
Numbered launch uses the mode saved in the slot.

## Connect and view

```sh
zterm 1
```

`zterm 1` has no separate width override argument. Change the saved mode with
`zterm slot set 1 --width-mode adaptive-phone|mirror-fixed`.

Local viewing and exit use an explicit `Ctrl+]` byte prefix. In the table,
`Ctrl+]` means byte `0x1D`.

| Key sequence | Local behavior |
|---|---|
| `Ctrl+]` then `q` | Disconnect the local CLI connection and exit. |
| `Ctrl+]` then `k` | Scroll up one line. |
| `Ctrl+]` then `j` | Scroll down one line. |
| `Ctrl+]` then `u` | Scroll up one page. |
| `Ctrl+]` then `d` | Scroll down one page. |
| `Ctrl+]` then `h` | Pan left, mainly meaningful in `mirror-fixed`. |
| `Ctrl+]` then `l` | Pan right, mainly meaningful in `mirror-fixed`. |
| `Ctrl+]` then `f` | Return to follow mode at the current daemon tail. |
| `Ctrl+]` then `Ctrl+]` | Send one literal `Ctrl+]` byte to the remote application. |
| `Ctrl+]` then another key | Send the pending `Ctrl+]` first, then process that key normally, which may send it to the remote application. |

Only lowercase `q` closes the CLI. `Ctrl+C`, `Ctrl+D`, `Ctrl+Z`, `Esc`, arrow
keys, and function keys are not local exit commands; they remain available to
the remote terminal.

In reading mode, live updates do not pull the view back to the bottom. Typing
remote input, pressing `Ctrl+] f`, or scrolling down to the tail exits reading
and returns to follow.

Paste wrappers `ESC[200~` and `ESC[201~` are consumed locally. The remote
application receives only the pasted content. A `Ctrl+] q` inside a valid paste
is treated as content, not as an exit command.

## Cross-machine app messaging

`zterm app` sends durable messages and files between daemons over the existing
daemon connection. Both hosts need daemon `0.1.4` or later, which serves the
`/app` WebSocket gateway.

```sh
zterm app stream --json
zterm app send --peer <deviceId> --daemon-host-id <hostId> --subject <text> --body <text>
zterm app send-file --peer <deviceId> --daemon-host-id <hostId> --file <path> [--subject <text>]
zterm app status --message-id <id>
zterm app ack --message-id <id>
zterm app consume --message-id <id>
```

`stream` prints one JSON object per line. `send`/`send-file` exit `0` only when
the receiving daemon reports `received`; exit `3` means the local daemon cannot
prove the remote result (`result_unknown`), and exit `1` means the peer is
unreachable. File transfer is chunked, resumable, and content-checked; delivery
survives a receiver daemon restart.

## Exit and terminal recovery

`Ctrl+] q` closes only the local CLI connection. It does not delete, rename, or
stop the remote session.

Normal exit, initialization failure, input failure, `SIGINT`, `SIGTERM`,
`SIGHUP`, and a closed output pipe enter the same local cleanup path. Cleanup
restores:

- terminal raw mode
- alternate screen
- cursor visibility
- default color state
- bracketed-paste mode

A network cleanup failure does not prevent the local terminal restoration.
If the process is force-killed, the machine crashes, or the terminal emulator
loses the process before cleanup, restoration cannot be guaranteed. Close the
affected terminal tab and open a new one, or use the terminal application's
reset action. Do not start another CLI process inside a terminal that is still
in an unknown raw or alternate-screen state.

The macOS arm64 full path verified the local prefix, remote input, resize, and
terminal restoration. Windows and Linux physical-key behavior inside real
`vim` or `top` sessions remain pending platform CI or target-host evidence.

## Upgrade

```sh
zterm upgrade
zterm upgrade --registry <url>
```

Upgrade changes only `@jsonstudio/zterm-cli`. It does not upgrade the daemon,
log out, or modify the shared configuration.

The command works only when the current CLI is running from a recognized npm
global installation tree. It:

1. Reads the current npm global prefix.
2. Queries the fixed CLI package from the selected registry.
3. Skips installation when the version is unchanged.
4. Installs the requested version into the same prefix.
5. Runs the installed `zterm --version`.

It does not use `sudo`, switch prefixes, create an active-version pointer,
create a second installation lock, or promise an automatic rollback. A failed
or cancelled npm operation is reported as `unverified`; it does not claim that
the previous entry is still healthy.

`@jsonstudio/zterm-cli@0.1.5` and `@jsonstudio/zterm-daemon@0.1.4` are published to the public npm registry, and isolated public registry installation plus the `zterm app` cross-machine message and file end-to-end gate pass. End-to-end upgrade/rollback on a genuinely blank physical machine or blank OS VM remains unverified until a blank-machine target is provisioned.

## Daemon management

```sh
zterm daemon install
zterm daemon status
zterm daemon config
zterm daemon config tmux set <name> --socket <path>
zterm daemon config tmux primary <name>
zterm daemon config tmux remove <name>
```

Daemon package distribution is one public launcher package plus exactly three
platform payloads. The public package is the only owner of the
`zterm-daemon` and `wterm` bins. The payload packages have no bin.

Build the three-payload package with explicit release inputs:

```sh
node android/scripts/prepare-daemon-npm-package.mjs \
  --version <daemon-version> \
  --release darwin-arm64=<release-dir> \
  --release linux-x64=<release-dir> \
  --release win32-x64=<release-dir>
```

The tuple set is fixed. The generated payloads cover Node.js 22 and contain
their platform runtime, native dependencies, configuration command, and runner.
The `android/package.json` `daemon:prepare-npm` entry keeps the Node script as
its entry point; callers supply the required arguments. The retired no-argument
single-host flow is not a supported packaging path.

### `zterm daemon install`

Installs the `@jsonstudio/zterm-daemon` package that matches the current host
platform manifest. Installation uses a temporary staging prefix, verifies the
package and runtime components, installs the staged tarball into the same npm
global prefix, and asks the package-owned shim installer to publish the user
command.

This command does not:

- start, stop, or restart the daemon
- install an autostart service
- write `~/.zterm/config.json`
- execute package lifecycle scripts during staging

It also does not promise that a failed install wrote nothing. Review the
reported phase, installed version, written paths, and error.

### `zterm daemon status`

Delegates to the formal `zterm-daemon status` owner and preserves its exit
code, signal, stdout, and stderr. It can distinguish running, stopped, stale
managed PID, service failure, unknown listener ownership, and observation
failure. A health endpoint alone is not treated as complete status truth.

### `zterm daemon config`

Reads the local shared configuration directly through the shared reader and
projection. It does not require login, daemon installation, a running daemon,
or the installed `zterm-daemon config` command.

It shows the real config path and existence, host, port, session name, cache
lines, configured tmux socket labels, stored and resolved socket paths, primary
socket, and their source locations. Auth is shown only as configured or not
configured, with its source. Secrets are not printed.

Reading a missing config reports it as absent and does not create a file. A
malformed config or invalid tmux block fails explicitly. The output says that a
mutation affects the next daemon start, not a running process. `daemon config`
does not perform a legacy migration or start, stop, restart, install, or
contact a daemon.

`daemon status` keeps its formal status owner and preserves its current exit
semantics.

## Common failures

| Result | Meaning | Safe next action |
|---|---|---|
| `invalid_slot` | A slot number is not an integer from 1 through 20. | Use `zterm slot set 1` through `20`. |
| `slot_not_found` | The requested slot has no saved binding. | Configure that slot first. |
| `no_slots` | No slot bindings exist for no-argument selection. | Run `zterm slot set <1..20>`. |
| `auth_required` or `auth_invalid` | No usable CLI login exists, or the server rejected it. | Run `zterm login` and select the slot again only if its identity changed. |
| `slot_changed` | Another process changed the same slot during configuration. | Re-run `zterm slot set` and review the newer binding. |
| `session_not_found` or `session_identity_mismatch` | The saved stable session no longer matches the daemon catalog. | Reconfigure the slot explicitly. The CLI does not create or rename a replacement session. |
| `snapshot_read_failed` | The daemon could not capture a fresh preview of the selected existing session. | Check that the selected session still exists and retry. Preview captures one frame without attaching, resizing, sending input, or starting continuous capture. Older daemons may return `mirror_not_ready` or `mirror_not_present`; update the daemon to enable on-demand capture. |
| `config_busy` | Another cooperating writer holds the shared config lock. | Wait for that process to finish and retry. Do not delete the lock without confirming its owner. |
| `invalid_json` or `invalid_config` | The shared config is malformed or a typed section has the wrong shape. | Repair the file manually or from a known backup; the CLI does not overwrite invalid content with an empty object. |
| One configured daemon socket is unavailable | The catalog keeps reachable entries selectable and prints the failed socket label and path. | Check the configured socket or remove/update it. Cached reads keep the failure so it is not silently discarded. |
| Every configured daemon socket is unavailable | The catalog request fails with a correlated error. | Check the configured socket routes and rerun the request. |
| `legacy_migration_required` | Only `~/.wterm` exists, so read-only daemon commands stop before an implicit migration. | Move or initialize the current `~/.zterm` configuration explicitly, then rerun. |
| `daemon_platform_mismatch` or `daemon_node_abi_mismatch` | The daemon package does not match the current OS, CPU, Node version, or ABI. | Use a daemon artifact built for the current host. |
| `upgrade_install_context_unsupported` | The running CLI is not in the npm global package tree. | Install through npm global installation before using `zterm upgrade`. |

The formal entry maps success to `0`, ordinary failure to `1`, cancellation to
`130`, and malformed command usage to `2`. The macOS arm64 same-entry run
exercised the user-facing success, failure, cleanup, and typed stale-identity
paths from an installed local tarball.

## Development

Package source lives under `packages/cli/src`. The formal package build expects
`packages/cli/src/main.ts` and bundles it to `dist/main.mjs` for the `zterm` bin.

```sh
pnpm --dir packages/cli run build
pnpm --dir packages/cli run test
pnpm --dir packages/cli run type-check
pnpm --dir packages/cli run pack:release
```

Package consumers must not need workspace source files. `@zterm/shared` logic
needed by the CLI must be bundled into the published entry rather than declared
as a private workspace runtime dependency.

## Verification status

| Platform | Target | Current real CLI evidence |
|---|---|---|
| Windows | `win32-x64`, Node 22 | Real native staging, installed CLI, PTY, remote connection, and lifecycle evidence are pending platform CI or a Windows target host. |
| macOS | `darwin-arm64`, Node 22 | Full user path passed from an isolated npm tarball, including login, slot, snapshot, mirror, input, resize, `Ctrl+] q`, stale identity, logout, and cleanup. |
| Linux | `linux-x64`, Node 22 | Real native staging, installed CLI, PTY, remote connection, and lifecycle evidence are pending platform CI or a Linux target host. |

The npm isolation upgrade suite passed, and `@jsonstudio/zterm-cli@0.1.5` plus `@jsonstudio/zterm-daemon@0.1.4` (with all three platform payloads) are published to the public npm registry. The `zterm app` message and file gate passes against the public installed CLI. Note that CI runner, container, and existing-host verification do not substitute for a genuinely blank physical machine or blank OS VM; see [`../../docs/install-from-zero.md`](../../docs/install-from-zero.md) for the explicit blank-machine audit matrix.
