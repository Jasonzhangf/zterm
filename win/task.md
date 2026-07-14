# zterm Windows Task Board

## Current

- `windows.desktop_shell` single-session alpha is implemented and has packaged Windows L5 marker proof.

## Next

1. Add daemon session discovery/create/close UI through the existing control protocol owner.
2. Extract platform-neutral desktop workspace/pane composition from Mac without copying `window.ztermMac` IPC.
3. Add a Windows filesystem/browser adapter and packaged installer after the workspace boundary is shared.
4. Keep Ctrl+C / console-control semantics explicit until solved.

## Not Started

- Multi-session workspace and pane/tab shell.
- Windows filesystem browser/preview adapter.
- Installer target, icon, signing, and update channel.

## Done

- `daemon.windows_wezterm_backend` local unit gates, mock daemon protocol, direct Windows WezTerm remote/input smoke, typecheck, feature registry gates, and live Windows daemon source-to-`buffer-sync` protocol smoke passed on 2026-07-14.
- `windows.desktop_shell` Electron main/preload/renderer, shared transport/buffer/renderer binding, x64 directory package, and real Windows packaged source-to-DOM marker smoke passed on 2026-07-14.
