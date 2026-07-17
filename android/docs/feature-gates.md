# Feature Gates

`docs/feature-registry.json` is the machine-checkable feature gate matrix. This document explains how to apply it.

## Required Flow

1. Pick the `feature_id` before editing code.
2. Confirm the changed files are inside `allowed_paths` for that feature.
3. If a necessary file is not in `allowed_paths`, update the registry first and add or adjust a truth gate explaining the new owner boundary.
4. Run every `required_gates` entry for the feature.
5. For terminal transport, daemon input, buffer/render, schedule, and file transfer changes, also run the terminal regression stack required by `docs/dev-workflow.md`.

## Gate Meaning

- `owners`: unique modules that own the feature state or behavior.
- `allowed_paths`: files or directories that may change for that feature.
- `forbidden_paths`: paths that must not be used as shortcut or fallback locations.
- `required_gates`: tests or scripts that must pass before the feature can be reported complete.
- `truth_sources`: docs or skills that define the invariant behind the feature.

## No Fallback Rule

Do not use another feature owner to compensate for a broken owner. If a feature cannot be fixed inside its owner surface, update the registry and truth gates first so the ownership change is explicit and testable.

## Current High-Risk Gates

- `terminal.copy_mode`: prove copy mode has an explicit enter/exit lifecycle, Android touch long-press is routed to app copy menu instead of native system selection, and close/copy/failure paths do not leave highlighted controls behind.
- `terminal.quickbar`: prove floating quickbar actions, shortcut editing, copy entry, split controls, and workspace handoff stay inside the quickbar/workspace owners without adding terminal renderer or daemon fallback behavior.
- `terminal.keyboard_ime`: prove IME lift and keyboard listeners clean up without double-lift, stale listeners, hidden-input overlap, or stage-height shrink regressions; prove the terminal stage shell still lifts above the soft keyboard whenever a reported keyboard inset is non-zero, even when the quickbar DOM editor currently owns focus; prove QuickBar reports its real chrome height while the IME lift is applied outside the component so stage reserve cannot collapse to zero; when WebView viewport metrics do not expose IME occlusion (`adjustPan`-style devices), `keyboardInset` remains the only physical truth and `resolveKeyboardLiftPx` must not return zero purely because layout/visual viewport bottoms appear aligned.
- `terminal.remote_screenshot`: prove screenshot requests stay split between client runtime aggregation, daemon control execution, file-transfer truth, and page preview/save projection; missing permission or transfer failure must surface as explicit error, not a fake successful preview.
- `terminal.transport_lifecycle`: prove client session identity, transport open/attach, heartbeat health, reconnect, detach, and daemon mirror lifecycle remain separated; an OPEN socket with three consecutive missed 2-second server-activity confirmations must fail once through the unique reconnect owner while logical session and buffer truth remain intact; daemon must not own client active tab, viewport, foreground, network type, or logical session state.
- `terminal.daemon_input`: prove stale or detached input is dropped before tmux write, input wire remains string-only, connect/close attach barriers stay ordered, per-transport input lane can bypass slow non-input work without crossing attach barriers and can also bypass older in-flight input work on the same transport (no self-blocking), mirror live cadence falls back to idle without fake activity, and debug metadata exposes receive/drop/write/queue facts without terminal payload.
- `terminal.open_tabs`: prove no daemon audit, transport close, or runtime absence can physically auto-close a current-process client tab; prove cold launch ignores/removes legacy persisted tabs and runtime tab actions never write tab persistence.
- `terminal.buffer_render`: prove buffer-sync apply is the only body repaint path, revision reset does not publish empty black frames over existing content, and the Android renderer has an automatic source-buffer-to-visible-DOM comparison gate for fast TUI/top/status/bottom refreshes.
- `terminal.workspace_panes`: prove pane ownership is explicit, split layout does not resurrect runtime-only tabs, and PaneStage remains the split truth.
- `terminal.session_group_layout`: prove session/tab/pane truth stays unchanged while layout profiles map existing containers to stage slots; Phase 1 must keep phone behavior stable before adding multi-container projection, and future partially-visible slots must not mount live terminal by default.
- `terminal.interaction_runtime`: prove active tab / pane routing stays isolated and pane attach/switch refuses owner-less targets.
- `terminal.session_drawer`: prove drawer grouping consumes injected host identity, filters disconnected/stale Relay daemon records out of host rails and target lookup, recomputes when Relay session catalogs change without endpoint changes, preserves opened-first ordering, scopes new-session actions to the selected host only when a real hostKey exists, never invents `default` / `本机` fallback identity, and rejects a synthetic row click produced by the same edge gesture that opened the drawer.
- `terminal.session_preview`: prove ordered selection is limited to six open sessions; remote drawer catalog rows auto-materialize through the existing session-open owner with no activation/navigation before selection storage persists the local session id; unresolved remote placeholders are not stored; long-press replacement preserves order and exposes only unselected open sessions without also activating the tile; system Back cancels to the captured entry session projection; right-edge preview admission stays disjoint from left drawer and middle fixed crop gestures; preview tiles consume existing render-buffer truth without input/resize/transport side effects; and preview live subscriptions exist only while the projection is open.
- `terminal.shell_actions`: prove tab manager scope, quick-picker pane routing, and viewport mode updates stay in shell-actions owner.
- `terminal.schedule`: prove jobs do not leave orphan timers or store entries and daemon remains the execution truth.
- `connections.history_projection`: prove session history storage, bridge server preset settings, connections projection, and connection properties stay separated from current open-tab truth; Home projection renders one row per server and must not close or persist open tabs.
- `connections.config_share`: prove connection share has one canonical shared payload/link owner, the real FAB/add-flow sheet exposes paste import + QR scan + saved-connection share, QR/copy/deep-link import consume the same payload, secrets are stripped, malformed input returns explicit errors, and UI import goes through host storage upsert instead of direct storage writes.
- `settings.config_transfer`: prove Settings export/import returns explicit success/error results with a user-visible path or error message, and config export excludes session/runtime state such as open tabs, active session, session history, and drafts; console-only success or silent boolean return is not enough.
- `relay.account_directory`: prove relay server stores only account directory / presence / signaling facts, daemon publishes tmux/session truth snapshots, and Android consumes directory truth without requiring a local bridge preset.
- `relay.route_selection`: prove Auto route is chosen from explicit candidates plus probe/score/TTL diagnostics; user priority is only a weight, and unreachable/auth-failed candidates cannot be selected.
- `relay.directory_ui`: prove Settings accepts only account/password for fixed `relay.codewhisper.cc`, persists no plaintext password, Home projects only online daemon devices/server rows without Session-group controls, disconnected/stale `rtc-device-*` records are not connectable rows, same-daemon saved direct rows merge Relay route candidates without replacing saved identity, rows with `relay-rtc` expose explicit Auto and Relay open intents, normal Home server-row entry goes through the session-open owner directly instead of stopping at the Session Picker, Home server rows open last-entered or first live remote sessions before creating any generated tmux session, and Session Picker never renders directory sessions as final truth while live refresh is pending; Session Picker/drawer remain the advanced Session projection owners.
- `daemon.file_transfer`: prove file-transfer messages, daemon file runtime, and client sheet projection stay separated; remote cwd and transfer failures must come from daemon/file-transfer truth, not local client environment or UI guesses.
- `daemon.runtime_entry`: prove `server.ts` and daemon runtime assembly remain the only long-running daemon entry, with tmux/mirror/control/schedule/file-transfer/debug/http routes wired through documented owners and no runtime directory scanning fallback.
- `daemon.windows_wezterm_backend`: prove Windows WezTerm CLI is only an external source, not daemon truth; `get-text --escapes` must be converted to ZTerm-owned absolute mirror snapshots; input may only use the verified `send-text --no-paste` stdin contract; missing panes and pane cleanup failures must surface as explicit errors; mock protocol, direct real Windows remote/input smoke, and real Windows daemon source-to-`buffer-sync` protocol smoke with targeted cleanup are required before claiming closeout.
- `daemon.cli_shell`: prove `zterm-daemon.sh` command contracts, launchd/bootstrap, config writes, global install, and native helper handoff stay in CLI owners and report explicit failure instead of silently continuing.
- `daemon.cli_node`: prove node CLI helpers stay diagnostic/harness-only, share parser behavior where required, and never become daemon runtime owners.
- `daemon.support`: prove setup/verify/release helper scripts only validate or prepare prerequisites and cannot become hidden runtime truth.
- `windows.desktop_shell`: prove Windows owns only desktop window/menu/package/platform bridge, uses shared transport/buffer/renderer owners, has registry/resource/function/mainline/test design before implementation, and never imports Mac IPC (`window.ztermMac`), local tmux transport, daemon source, mirror source, or a copied terminal renderer.
- `project.loop_governance`: prove the initialized loop stays in L1 report-only mode, has required loop docs/state/constraints/budget/run-log/manifest, denies product-code/runtime/daemon/git write actions, binds every report item to feature map and `mainline_call_id`, and keeps `test:feature-registry` wired to the loop truth gate.
- `mainline_source.android`: prove Android native entry, Capacitor config, Vite entry, app shell, terminal view, and terminal page remain documented user-facing source surfaces and stay cross-linked to feature registry/function wiki gates.
- `mainline_source.daemon`: prove daemon request paths remain anchored at `src/server/server.ts` and the documented terminal runtime modules, with function wiki gates catching owner drift.
- `mainline_source.cli`: prove CLI release/install mainline remains anchored in shell/package scripts and generated wiki docs, with no undocumented public command surface.
