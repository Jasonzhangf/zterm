# zterm Windows Task Board

## Current

- `windows.desktop_shell.file_browser` local browse/preview adapter is implemented and has packaged Windows fixture source-to-DOM proof.

## Next

1. Add packaged installer/icon metadata after the filesystem boundary is anchored.
2. Keep Ctrl+C / console-control semantics explicit until solved.

## Not Started

- Installer target, icon, signing, and update channel.

## Done

- `daemon.windows_wezterm_backend` local unit gates, mock daemon protocol, direct Windows WezTerm remote/input smoke, typecheck, feature registry gates, and live Windows daemon source-to-`buffer-sync` protocol smoke passed on 2026-07-14.
- `windows.desktop_shell` Electron main/preload/renderer, shared transport/buffer/renderer binding, x64 directory package, and real Windows packaged source-to-DOM marker smoke passed on 2026-07-14.
- `windows.desktop_shell` session refresh/create/select/connect/close UI passed packaged source-to-DOM and daemon-list cleanup smoke on 2026-07-14.
- `windows.desktop_shell.workspace` shared pane/tab composition, two stable per-tab runtimes, focus-switch transport reuse, isolated source-to-DOM markers, targeted tab disposal, and sibling live refresh after close passed packaged Windows smoke on 2026-07-14.
- `windows.desktop_shell.file_browser` Windows preload filesystem bridge, local fixture list/read, shared preview policy, Markdown source-to-DOM preview, binary-disabled projection, and no terminal runtime side effect passed packaged Windows smoke on 2026-07-14.
