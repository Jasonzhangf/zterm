# zterm Windows Task Board

## Current

- `windows.remote_access_client` Phase 1 is implemented locally: profile store, iTerm2-style sidebar/session catalog, workspace split/tab projection, statusbar, shared transport/renderer binding, file browser projection, and Windows package verification.

## Next

1. Run the real installed Windows packaged source-to-DOM smoke for sidebar profile/session projection, split/tab, input marker, statusbar, file browser, and daemon session cleanup.
2. Record daemon session/transport/subscriber counts before and after close/tab/session/window behavior.
3. Keep Ctrl+C / Windows console-control semantics explicit until solved.

## Done

- `daemon.windows_wezterm_backend` local unit gates, mock daemon protocol, direct Windows WezTerm remote/input smoke, typecheck, feature registry gates, and live Windows daemon source-to-`buffer-sync` protocol smoke passed on 2026-07-14.
- Historical packaged Windows shell/session/workspace/file-browser smoke evidence is preserved under `win/MEMORY.md` as `windows.desktop_shell*` context, but current governance routes through `windows.remote_access_client`.
