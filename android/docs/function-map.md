# zterm Android Function Map

This map is the human-readable index for `docs/feature-registry.json`.

Before changing a feature, locate its `feature_id`, read its owner paths, and run its required gates. If no row exists, add the feature to the registry and gate it before touching behavior.

| feature_id | owner | allowed change surface | required gate source |
| --- | --- | --- | --- |
| `terminal.copy_mode` | `src/pages/useTerminalPageCopyRuntime.ts` | copy runtime, TerminalPage wiring, `TerminalView` pointer/touch long-press ownership, `VisibleRow` selection/menu guard, header state | `src/pages/useTerminalPageCopyRuntime.test.tsx`; `system-copy-state-machine.test.tsx`; `system-copy-longpress-regression.test.tsx`; `TerminalView.selection-guard.test.tsx`; `VisibleRow.selection.test.tsx` |
| `terminal.quickbar` | `src/components/terminal/TerminalQuickBar.tsx` | quickbar UI, terminal page shell wiring, workspace/layout profile | `TerminalQuickBar.test.tsx`; `TerminalPage.real-quickbar-split.test.tsx` |
| `terminal.keyboard_ime` | `src/pages/terminal-keyboard-lift.ts`; `src/pages/TerminalPage.tsx`; `src/pages/TerminalPageStageShell.tsx` | IME lift, keyboard visibility, viewport safe-area, stage shell visual lift, listener cleanup | `terminal-keyboard-lift.test.ts`; `TerminalPage.android-ime.test.tsx`; `TerminalPage.lifecycle-cleanup.test.tsx`; `TerminalPageStageShell.pane-stage.test.tsx` |
| `terminal.schedule` | `src/server/schedule-*.ts` | daemon schedule store/engine/dispatch and page editor wiring | schedule store/engine/dispatch tests; `server.schedule-truth.test.ts` |
| `terminal.remote_screenshot` | `src/lib/remote-screenshot-runtime.ts`; daemon control runtime | screenshot request aggregation, file-transfer bridge, page preview/save | runtime/page screenshot tests; file-transfer truth gate |
| `terminal.open_tabs` | `src/hooks/useOpenTabRuntime.ts`; `src/lib/open-tab-persistence.ts` | open-tab persistence, restore sync, explicit open/close policy | `open-tab-history-truth.test.ts`; persistence/restore/intent tests |
| `terminal.transport_lifecycle` | `src/contexts/session-context-transport-runtime.ts`; `src/server/terminal-bridge-runtime.ts` | session transport runtime, socket message runtime, daemon bridge/transport runtime | transport lifecycle/runtime tests |
| `terminal.daemon_input` | `src/server/terminal-message-runtime.ts`; `src/server/terminal-control-runtime.ts`; `src/server/terminal-bridge-runtime.ts` | daemon input receive/drop/write queue, transport drain, bridge attach/input/message lane scheduling, live-activity scheduling | `terminal-bridge-runtime.test.ts`; `terminal-message-runtime.test.ts`; `terminal-mirror-runtime.test.ts`; scheduler/control/bridge truth gates |
| `terminal.buffer_render` | `src/contexts/session-context-buffer-runtime.ts`; `src/lib/session-render-gate.ts` | client buffer manager, render gate, daemon mirror runtime | render gate, buffer runtime, multi-pane, mirror runtime tests |
| `terminal.workspace_panes` | `src/hooks/useTerminalWorkspace.ts`; `src/pages/TerminalPageStageShell.tsx` | pane split/layout/workspace persistence/shared PaneStage | workspace pane tests; `TerminalPageStageShell.pane-stage.test.tsx` |
| `terminal.interaction_runtime` | `src/pages/useTerminalPageInteractionRuntime.ts` | active pane session routing, pane attach intent, swipe/tab isolation | `TerminalPage.tab-isolation.test.tsx`; `TerminalPage.multi-pane-decouple.test.tsx` |
| `terminal.shell_actions` | `src/pages/useTerminalPageShellActionsRuntime.ts` | quick picker, tab manager scope, viewport mode routing | `useTerminalPageShellActionsRuntime.test.tsx` |
| `connections.history_projection` | `src/lib/connections-server-groups.ts`; `src/hooks/useSessionHistoryStorage.ts` | connections projection and history storage | open-tab/history truth; connections page/group tests |
| `daemon.file_transfer` | `src/lib/file-transfer-message-runtime.ts`; daemon control runtime | file transfer message runtime, sheet UI, daemon file-transfer runtime | `FileTransferSheet.test.tsx`; file-transfer truth gate |

Rules:

- One feature has one owner surface. Shared helpers are allowed only when the registry names them as allowed paths.
- Forbidden paths are hard boundaries. Do not patch behavior there to make a feature pass indirectly.
- Required gates are the minimum verification stack, not a replacement for broader regression when the change has wider impact.
