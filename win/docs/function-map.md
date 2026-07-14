# zterm Windows Function Map

| feature_id | owner | allowed change surface | required gate source |
| --- | --- | --- | --- |
| `daemon.windows_wezterm_backend` | `android/src/server/wezterm-backend.ts`; `android/src/server/terminal-backend-selection.ts`; `android/scripts/wezterm-*-smoke.ts` | Windows daemon backend selection, WezTerm pane list parsing, `get-text --escapes` mirror snapshots, stdin-only `send-text`, pane cleanup verification | `android/src/server/wezterm-backend.test.ts`; `android/src/server/wezterm-backend-runtime.test.ts`; `android/src/server/terminal-backend-selection.test.ts`; `android/scripts/wezterm-daemon-protocol-smoke.ts`; `android/scripts/wezterm-backend-remote-smoke.ts`; `android/scripts/wezterm-backend-input-smoke.ts` |
| `windows.desktop_shell` | `win/electron/main.ts`; `win/electron/preload.cts`; `win/src/WindowsDesktopApp.tsx`; `win/src/windows-terminal-session.ts`; shared terminal renderer `packages/shared/src/terminal/mac-terminal-view.tsx` | Windows Electron window/menu/package/platform bridge and desktop composition; consumes existing shared transport/buffer/renderer owners and must not import Mac IPC | `win/src/windows-architecture-truth.test.ts`; `win/src/windows-terminal-session.test.ts`; typecheck/build/package; packaged Windows source-to-DOM marker smoke |

## Pending function bindings

| function_id | owner symbol | mainline call id | status |
| --- | --- | --- | --- |
| `windows.desktop_shell.electron_main` | `win/electron/main.ts#createMainWindow` | `windows_desktop_shell:WinElectronMain->WinPreloadBridge` | anchored |
| `windows.desktop_shell.preload_bridge` | `win/electron/preload.cts#ztermWindows` | `windows_desktop_shell:WinPreloadBridge->WinRendererEntry` | anchored |
| `windows.desktop_shell.renderer_entry` | `win/src/main.tsx`; `win/src/WindowsDesktopApp.tsx#WindowsDesktopApp` | `windows_desktop_shell:WinRendererEntry->WinDesktopShell` | anchored |
| `windows.desktop_shell.session_control` | `win/src/windows-terminal-session.ts#createWindowsSessionControl` | `windows_desktop_shell:WinDesktopShell->WinSessionControl` | anchored |
| `windows.desktop_shell.transport_binding` | `win/src/windows-terminal-session.ts#createWindowsTerminalSession` | `windows_desktop_shell:WinDesktopShell->WinSharedTransport` | anchored |
| `windows.desktop_shell.shared_renderer` | `packages/shared/src/terminal/mac-terminal-view.tsx#MacTerminalView` | `windows_desktop_shell:WinSharedTransport->WinSharedRenderer` | anchored |

Rules:

- `windows.desktop_shell` must not own daemon truth.
- `daemon.windows_wezterm_backend` must not own desktop window/menu/package behavior.
- Add a registry entry and gates before implementing `windows.desktop_shell`.
