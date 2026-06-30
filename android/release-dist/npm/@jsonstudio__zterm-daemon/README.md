# zterm-daemon

ZTerm daemon for macOS and Windows. It runs the local WebSocket bridge used by the ZTerm Android app to connect to local terminal sessions. macOS uses tmux; Windows uses WezTerm mux through the ZTerm WezTerm backend adapter.

## Requirements

- darwin arm64
- Node.js 20+
- macOS: tmux available on PATH
- Windows: WezTerm available on PATH, or set `ZTERM_WEZTERM_EXE` to the portable `wezterm.exe`
- macOS remote screenshot: grant Screen Recording permission to the installed `zterm-daemon` native binary when macOS prompts

## Install

```bash
npm install -g @jsonstudio/zterm-daemon
printf '%s
' "$RELAY_PASSWORD" | zterm-daemon configure-relay \
  --relay-url "$RELAY_BASE_URL" \
  --username "$RELAY_USERNAME" \
  --password-stdin \
  --host-id "$(hostname -s)" \
  --device-id "$(hostname -s)" \
  --device-name "$(hostname)"
zterm-daemon install-service
zterm-daemon service-status
```

The relay password must come from a local secret manager, shell secret, or CI secret. The configure command only prints `passwordSet=true`; it must not echo the password.

The installer uses these locations:

- runtime/config/logs: `~/.zterm`
- CLI: npm global bin `zterm-daemon`
- legacy alias: npm global bin `wterm`
- macOS launch agent: `~/Library/LaunchAgents/com.zterm.android.zterm-daemon.plist`
- Windows scheduled task: `ZTermDaemon`

## Commands

```bash
zterm-daemon run               # run in foreground
zterm-daemon start             # start launchd service on macOS, scheduled task/direct process on Windows
zterm-daemon status            # direct runtime status
zterm-daemon stop              # stop service or direct process
zterm-daemon restart           # restart service or direct process
zterm-daemon configure-relay   # write ~/.zterm/config.json mobile.relay from secret input
zterm-daemon install-service   # install and start launchd service or Windows scheduled task
zterm-daemon uninstall-service # stop and remove service
zterm-daemon service-status    # service status
```

`wterm daemon <command>` is kept as a compatibility alias.

## Configuration

Optional config file: `~/.zterm/config.json`.

```json
{
  "zterm": {
    "android": {
      "daemon": {
        "host": "0.0.0.0",
        "port": 3333,
        "authToken": "change-me"
      }
    }
  }
}
```

Relay account configuration should be written through the global CLI, not by hand-editing scattered daemon files. The command shape is `zterm-daemon configure-relay --relay-url ... --username ... --password-stdin --host-id ...`:

```bash
printf '%s
' "$RELAY_PASSWORD" | zterm-daemon configure-relay \
  --relay-url "$RELAY_BASE_URL" \
  --username "$RELAY_USERNAME" \
  --password-stdin \
  --host-id "mac-studio" \
  --device-id "mac-studio" \
  --device-name "Mac Studio"
```

Successful output contains `passwordSet=true` and never prints the relay password.

Environment variables override config:

- `ZTERM_HOST`
- `ZTERM_PORT`
- `ZTERM_AUTH_TOKEN`
- `ZTERM_DAEMON_SESSION`
- `ZTERM_WEZTERM_EXE` on Windows

## Android connection

In the ZTerm Android app, create a connection pointing at your Mac host/IP and daemon port, usually `3333`. If your Mac and phone are connected by Tailscale, use the Mac Tailscale IP.

## Remote screenshot permission

Remote screenshot permission belongs to the installed native `zterm-daemon` binary, not Node.js and not a separate GUI helper. Install the service once, trigger a screenshot from Android, and approve the macOS Screen Recording prompt for `zterm-daemon`.
