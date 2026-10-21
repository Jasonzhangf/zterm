# ZTerm CLI

`@jsonstudio/zterm-cli` provides the `zterm` command for connecting to an existing
ZTerm daemon session and managing the local daemon installation.

## Current status

`packages/cli/src/main.ts` is the formal command entry. The package build and
isolated tarball installation work on the current development host.

On macOS arm64, the real user path passed from an isolated npm tarball through
login, slot selection, snapshot, mirror, input, resize, `Ctrl+] q`, stale
identity, logout, and cleanup. The npm isolation upgrade suite passed 8/8.
CLI tests passed 123/123 before the stale-identity follow-up added a focused
17/17 test set.

`@jsonstudio/zterm-cli` is not published to the public npm registry. The
Windows and Linux real native and installed-CLI gates remain pending in the
platform CI workflow. Do not treat the macOS result as evidence for all three
operating systems.

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

The release target is a global npm installation:

```sh
npm install --global @jsonstudio/zterm-cli
zterm --version
```

This public command is unavailable until the package publish is complete.

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
6. Optionally preview a snapshot from an already-ready mirror.
7. Confirm the save.

Cancellation leaves the original slot unchanged. If another process changes
the same slot before save, the command reports `slot_changed` and keeps the
newer binding instead of overwriting it.

Snapshot preview is read-only. It does not attach a terminal, create a mirror,
start capture, resize a terminal, or send input. A preview can be unavailable
when no mirror is ready; that does not itself create a mirror. You may still
save the stable session binding after an explicit confirmation.

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

The public CLI package has not yet been published by this task. The adapter
exists, but public upgrade delivery remains unverified.

## Daemon management

```sh
zterm daemon install
zterm daemon status
zterm daemon config
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

Delegates to the formal `zterm-daemon config` owner. It shows the real config
path and the host, port, session name, cache lines, and auth configuration
sources. Auth is shown only as configured or not configured, with its source.
Secrets are not printed.

If only the old `~/.wterm` directory exists and `~/.zterm` is missing, status
and config fail with `legacy_migration_required`. They do not perform an
implicit legacy migration.

## Common failures

| Result | Meaning | Safe next action |
|---|---|---|
| `invalid_slot` | A slot number is not an integer from 1 through 20. | Use `zterm slot set 1` through `20`. |
| `slot_not_found` | The requested slot has no saved binding. | Configure that slot first. |
| `no_slots` | No slot bindings exist for no-argument selection. | Run `zterm slot set <1..20>`. |
| `auth_required` or `auth_invalid` | No usable CLI login exists, or the server rejected it. | Run `zterm login` and select the slot again only if its identity changed. |
| `slot_changed` | Another process changed the same slot during configuration. | Re-run `zterm slot set` and review the newer binding. |
| `session_not_found` or `session_identity_mismatch` | The saved stable session no longer matches the daemon catalog. | Reconfigure the slot explicitly. The CLI does not create or rename a replacement session. |
| `mirror_not_ready` or `mirror_not_present` | Snapshot preview has no ready mirror to read. | Preview is unavailable; save only after confirming the intended stable session. |
| `config_busy` | Another cooperating writer holds the shared config lock. | Wait for that process to finish and retry. Do not delete the lock without confirming its owner. |
| `invalid_json` or `invalid_config` | The shared config is malformed or a typed section has the wrong shape. | Repair the file manually or from a known backup; the CLI does not overwrite invalid content with an empty object. |
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

The npm isolation upgrade suite passed 8/8. Public npm publication and download
remain pending, so `npm install --global @jsonstudio/zterm-cli` is not yet a
working public installation instruction. The three operating systems are not
all accepted until the Windows and Linux real gates pass.
