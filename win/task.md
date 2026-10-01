# zterm Windows Task Board

## Current

- `windows.remote_access_client` Phase 1 is implemented locally: profile store, iTerm2-style sidebar/session catalog, workspace split/tab projection, statusbar, shared transport/renderer binding, file browser projection, and Windows package verification.

## Next

1. Deploy a current daemon runtime to `jason-hw-desktop`. The installed `zterm-daemon-0.1.3-iterm2-pane-ux` bundle still rejects UI close with `wezterm backend does not support tmux command: kill-session`; `origin/main` already routes `tmux-kill-session` through `WezTermBackendRuntime.closeSession`, so this is a stale installed bundle, not a `win/` defect.
2. Record daemon session/transport/subscriber counts across UI close once the current daemon runtime is installed.
3. Keep Ctrl+C / Windows console-control semantics explicit until solved.

## Done

- 2026-10-01 packaged Windows source-to-DOM smoke on candidate asar sha256 `1632658bcadba95e9796e0ab0fa30f946e6723f7a8b0a756d390f410f422f521` against `jason-hw-desktop` daemon `127.0.0.1:3333`: seeded profile, refreshed session catalog, opened `ztermwinremote1790878840` by clicking the session row, statusbar `connected rev 1`, typed marker echoed in terminal DOM (`sourceToDom.markerRowCount = 2`), split produced 2 panes with isolated markers (`paneIsolation.paneCount = 2`), cleanup stopped all ZTerm PIDs, `CDP_LISTENERS 0`, `USERDATA_REMOVED True`, daemon health `sessions total/attached/ready = 0/0/0`. Result file `D:\zterm-tools\zterm-final-result.json`; daemon stayed up as scheduled task PID 16792 across the run.
- `daemon.windows_wezterm_backend` local unit gates, mock daemon protocol, direct Windows WezTerm remote/input smoke, typecheck, feature registry gates, and live Windows daemon source-to-`buffer-sync` protocol smoke passed on 2026-07-14.
- Historical packaged Windows shell/session/workspace/file-browser smoke evidence is preserved under `win/MEMORY.md` as `windows.desktop_shell*` context, but current governance routes through `windows.remote_access_client`.
