# zterm Windows Function Map

| feature_id | owner | allowed change surface | required gate source |
| --- | --- | --- | --- |
| `daemon.windows_wezterm_backend` | `android/src/server/wezterm-backend.ts`; `android/src/server/terminal-backend-selection.ts`; `android/scripts/wezterm-*-smoke.ts` | Windows daemon backend selection, WezTerm pane list parsing, `get-text --escapes` mirror snapshots, stdin-only `send-text`, pane cleanup verification | `android/src/server/wezterm-backend.test.ts`; `android/src/server/wezterm-backend-runtime.test.ts`; `android/src/server/terminal-backend-selection.test.ts`; `android/scripts/wezterm-daemon-protocol-smoke.ts`; `android/scripts/wezterm-backend-remote-smoke.ts`; `android/scripts/wezterm-backend-input-smoke.ts` |
| `windows.desktop_shell` | `win/` | Pending Windows app shell: window lifecycle, menu, packaging, platform integration; must reuse shared pane stage and terminal renderer | Pending test design before implementation |

Rules:

- `windows.desktop_shell` must not own daemon truth.
- `daemon.windows_wezterm_backend` must not own desktop window/menu/package behavior.
- Add a registry entry and gates before implementing `windows.desktop_shell`.
