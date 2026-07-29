# zterm Windows Function Map

| feature_id | owner | allowed change surface | required gate source |
| --- | --- | --- | --- |
| `daemon.windows_wezterm_backend` | `android/src/server/wezterm-backend.ts`; `android/src/server/terminal-backend-selection.ts`; `android/scripts/wezterm-*-smoke.ts` | Windows daemon backend selection, WezTerm pane list parsing, `get-text --escapes` mirror snapshots, stdin-only `send-text`, pane cleanup verification | `android/src/server/wezterm-backend.test.ts`; `android/src/server/wezterm-backend-runtime.test.ts`; `android/src/server/terminal-backend-selection.test.ts`; `android/scripts/wezterm-daemon-protocol-smoke.ts`; `android/scripts/wezterm-backend-remote-smoke.ts`; `android/scripts/wezterm-backend-input-smoke.ts` |
| `windows.desktop_shell` | `win/electron/main.ts`; `win/electron/preload.cts`; `win/src/WindowsDesktopApp.tsx`; `win/src/windows-terminal-session.ts`; shared terminal renderer `packages/shared/src/terminal/mac-terminal-view.tsx` | Windows Electron window/menu/package/platform bridge and desktop composition; consumes existing shared transport/buffer/renderer owners and must not import Mac IPC | `win/src/windows-architecture-truth.test.ts`; `win/src/windows-terminal-session.test.ts`; typecheck/build/package; packaged Windows source-to-DOM marker smoke |
| `windows.desktop_shell.workspace` | `win/src/windows-workspace.ts#createWindowsWorkspaceState`; `win/src/windows-workspace.ts#splitWindowsWorkspaceEmpty`; `win/src/windows-workspace.ts#openWindowsWorkspaceTabInPane`; `win/src/windows-workspace.ts#changeWindowsWorkspaceTabSession`; `win/src/windows-workspace.ts#moveWindowsWorkspaceTab`; `win/src/windows-terminal-registry.ts#createWindowsTerminalRegistry`; `win/src/WindowsDesktopApp.tsx#WindowsWorkspaceStage` | Windows tab target identity, empty pane chooser placement, change-session tab replacement, move-to-numbered-pane projection, and runtime registry composition over shared pane/workspace operations; tab selection changes projection without recreating transport | `win/src/windows-workspace.test.ts`; `win/src/windows-terminal-registry.test.ts`; `win/src/WindowsDesktopApp.test.tsx`; typecheck/build/package; packaged Windows two-session pane isolation smoke |
| `windows.desktop_shell.file_browser` | `win/electron/windows-file-system.ts#createWindowsLocalFileSystemService`; `win/src/WindowsFileBrowserPanel.tsx#WindowsFileBrowserPanel`; shared `packages/shared/src/files/file-browser-core.ts` | Windows local directory selection/list/read IPC and file-browser UI projection; preview eligibility/sort/path policy remains shared | `win/src/windows-file-system.test.ts`; `win/src/WindowsFileBrowserPanel.test.tsx`; architecture gate; typecheck/build/package; packaged Windows fixture browse/preview smoke |
| `windows.desktop_shell.package_channel` | `win/package.json#build`; `win/build/icon.ico`; `win/scripts/verify-windows-package.mjs` | Windows dir package, NSIS installer target, app icon, unsigned internal-alpha signing stance, and generic update metadata verification | `win/src/windows-architecture-truth.test.ts`; `pnpm --dir win run package`; `pnpm --dir win run package:verify`; packaged installed-app smoke |

## Function bindings

| function_id | owner symbol | mainline call id | status |
| --- | --- | --- | --- |
| `windows.desktop_shell.electron_main` | `win/electron/main.ts#createMainWindow` | `windows_desktop_shell:WinElectronMain->WinPreloadBridge` | anchored |
| `windows.desktop_shell.preload_bridge` | `win/electron/preload.cts#ztermWindows` | `windows_desktop_shell:WinPreloadBridge->WinRendererEntry` | anchored |
| `windows.desktop_shell.renderer_entry` | `win/src/main.tsx`; `win/src/WindowsDesktopApp.tsx#WindowsDesktopApp` | `windows_desktop_shell:WinRendererEntry->WinDesktopShell` | anchored |
| `windows.desktop_shell.session_control` | `win/src/windows-terminal-session.ts#createWindowsSessionControl` | `windows_desktop_shell:WinDesktopShell->WinSessionControl` | anchored |
| `windows.desktop_shell.transport_binding` | `win/src/windows-terminal-session.ts#createWindowsTerminalSession` | `windows_desktop_shell:WinDesktopShell->WinSharedTransport` | anchored |
| `windows.desktop_shell.shared_renderer` | `packages/shared/src/terminal/mac-terminal-view.tsx#MacTerminalView` | `windows_desktop_shell:WinSharedTransport->WinSharedRenderer` | anchored |
| `windows.desktop_shell.workspace_model` | `win/src/windows-workspace.ts#createWindowsWorkspaceState` | `windows_desktop_shell:WinDesktopShell->WinWorkspaceModel` | anchored |
| `windows.desktop_shell.workspace_pane_session_actions` | `win/src/windows-workspace.ts#splitWindowsWorkspaceEmpty`; `win/src/windows-workspace.ts#openWindowsWorkspaceTabInPane`; `win/src/windows-workspace.ts#changeWindowsWorkspaceTabSession`; `win/src/windows-workspace.ts#moveWindowsWorkspaceTab` | `windows_desktop_shell:WinDesktopShell->WinWorkspacePaneSessionActions` | anchored |
| `windows.desktop_shell.runtime_registry` | `win/src/windows-terminal-registry.ts#createWindowsTerminalRegistry` | `windows_desktop_shell:WinWorkspaceModel->WinRuntimeRegistry` | anchored |
| `windows.desktop_shell.pane_projection` | `win/src/WindowsDesktopApp.tsx#WindowsWorkspaceStage` | `windows_desktop_shell:WinRuntimeRegistry->WinSharedRenderer` | anchored |
| `windows.desktop_shell.platform_fs` | `win/electron/windows-file-system.ts#createWindowsLocalFileSystemService`; `registerWindowsFileSystemIpcHandlers` | `windows_desktop_shell:WinDesktopShell->WinFileProvider` | anchored |
| `windows.desktop_shell.file_preview` | `win/src/WindowsFileBrowserPanel.tsx#WindowsFileBrowserPanel` using shared `FileBrowserCore` | `windows_desktop_shell:WinFileProvider->WinFilePreview` | anchored |
| `windows.desktop_shell.installer_channel` | `win/package.json#build`; `win/scripts/verify-windows-package.mjs` | `windows_desktop_shell:WinPackageConfig->WinInstallerArtifact` | anchored |

Rules:

- `windows.desktop_shell` must not own daemon truth.
- `daemon.windows_wezterm_backend` must not own desktop window/menu/package behavior.
- Add a registry entry and gates before implementing `windows.desktop_shell`.
- Empty pane selection and tab context-menu actions stay inside `windows.desktop_shell.workspace`; they mutate only workspace tab target identity/projection and rely on the existing registry retain/ensure pass for runtime lifecycle.
