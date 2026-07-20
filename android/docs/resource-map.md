# Global Resource Map

Date: 2026-07-12

`docs/resource-registry.json` is the top-level machine-readable truth for global zterm resources. This file is the human review surface for the same graph.

## Scope

Global scope includes:

- daemon process, daemon runtime artifact, runtime home, release/update artifacts, and debug channels.
- Android, Mac, and Windows platform terminal surfaces.
- terminal backend resources, including tmux and Windows WezTerm.
- client session, transport, input, buffer, renderer, and UI projection resources.
- CLI, release, update, debug, file transfer, schedule, screenshot, and remote window stream side resources.

## Resource Families

| family | resource ids | owner rule |
| --- | --- | --- |
| Global runtime | `resource.runtime_home`, `resource.daemon_runtime_artifact`, `resource.daemon_process`, `resource.release_update_artifact`, `resource.debug_channel` | Runtime consumes compiled/staged artifacts and explicit runtime home truth. Debug observes only. |
| Platform client | `resource.open_tab`, `resource.active_session`, `resource.session_transport`, `resource.transport_target`, `resource.pending_open_intent`, `resource.platform_terminal_surface`, `resource.platform_input_channel` | Platform clients own user intent and transport identity, not backend resources. |
| Daemon/backend | `resource.terminal_backend`, `resource.backend_session`, `resource.tmux_session`, `resource.wezterm_pane`, `resource.mirror_store`, `resource.transport_subscriber`, `resource.daemon_input_queue`, `resource.schedule_job`, `resource.file_transfer`, `resource.remote_screenshot`, `resource.remote_window_stream` | Daemon owns backend sessions, physical subscribers, mirror truth, input queues, and daemon side jobs. It does not own client active/foreground/viewport/follow truth. Remote window stream owns desktop media capture/input truth, not terminal buffer truth. |
| Client buffer/render | `resource.client_sparse_buffer`, `resource.renderer_window`, `resource.ui_projection`, `resource.session_preview_selection`, `resource.session_preview_mode`, `resource.remote_window_overlay` | Client buffer consumes daemon mirror patches. Renderer declares visible demand. UI, preview, and remote-window overlay resources project state and emit intent only. |

## Allowed Direct Relations

```mermaid
flowchart TD
  RuntimeHome["resource.runtime_home"] --> DaemonArtifact["resource.daemon_runtime_artifact"]
  DaemonArtifact --> DaemonProcess["resource.daemon_process"]
  DaemonProcess --> TerminalBackend["resource.terminal_backend"]
  DaemonProcess --> DebugChannel["resource.debug_channel"]
  TerminalBackend --> BackendSession["resource.backend_session"]
  BackendSession --> TmuxSession["resource.tmux_session"]
  BackendSession --> WeztermPane["resource.wezterm_pane"]
  OpenTab["resource.open_tab"] --> ActiveSession["resource.active_session"]
  ActiveSession --> SessionTransport["resource.session_transport"]
  SessionTransport --> TransportTarget["resource.transport_target"]
  SessionTransport --> PendingOpenIntent["resource.pending_open_intent"]
  SessionTransport --> TransportSubscriber["resource.transport_subscriber"]
  TransportSubscriber --> MirrorStore["resource.mirror_store"]
  MirrorStore --> TransportSubscriber
  MirrorStore --> TmuxSession
  MirrorStore --> WeztermPane
  MirrorStore --> ClientSparseBuffer["resource.client_sparse_buffer"]
  ClientSparseBuffer --> RendererWindow["resource.renderer_window"]
  RendererWindow --> UiProjection["resource.ui_projection"]
  UiProjection --> PreviewSelection["resource.session_preview_selection"]
  UiProjection --> PreviewMode["resource.session_preview_mode"]
  UiProjection --> RemoteWindowOverlay["resource.remote_window_overlay"]
  RemoteWindowOverlay --> RemoteWindowStream["resource.remote_window_stream"]
  RemoteWindowStream --> DaemonProcess
  RemoteWindowStream --> TransportTarget
  PreviewSelection --> OpenTab
  PreviewMode --> UiProjection
  PlatformSurface["resource.platform_terminal_surface"] --> UiProjection
  PlatformInput["resource.platform_input_channel"] --> SessionTransport
  DaemonInputQueue["resource.daemon_input_queue"] --> BackendSession
  ScheduleJob["resource.schedule_job"] --> BackendSession
  FileTransfer["resource.file_transfer"] --> BackendSession
  RemoteScreenshot["resource.remote_screenshot"] --> BackendSession
  ReleaseArtifact["resource.release_update_artifact"] --> DaemonArtifact
  OpenTab --> PreviewSelection
```

## Required Indirect Relations

| source | target | required path |
| --- | --- | --- |
| `resource.ui_projection` | `resource.session_transport` | via `resource.active_session` |
| `resource.renderer_window` | `resource.tmux_session` | via `resource.client_sparse_buffer -> resource.mirror_store` |
| `resource.renderer_window` | `resource.wezterm_pane` | via `resource.client_sparse_buffer -> resource.mirror_store` |
| `resource.platform_input_channel` | `resource.tmux_session` | via `resource.session_transport -> resource.transport_subscriber -> resource.daemon_input_queue -> resource.backend_session` |
| `resource.platform_input_channel` | `resource.wezterm_pane` | via `resource.session_transport -> resource.transport_subscriber -> resource.daemon_input_queue -> resource.backend_session` |
| `resource.platform_terminal_surface` | `resource.backend_session` | via `resource.active_session -> resource.session_transport -> resource.transport_subscriber -> resource.mirror_store` |
| `resource.release_update_artifact` | `resource.daemon_process` | via `resource.daemon_runtime_artifact` |
| `resource.session_transport` | `resource.client_sparse_buffer` | via `resource.transport_subscriber -> resource.mirror_store` |
| `resource.remote_window_overlay` | `resource.transport_target` | via `resource.active_session -> resource.session_transport` |
| `resource.remote_window_stream` | `resource.tmux_session` | via `resource.daemon_input_queue -> resource.backend_session` |

## Forbidden Direct Relations

| forbidden edge | reason |
| --- | --- |
| `resource.ui_projection -> resource.session_transport` | UI and drawer emit intent only through active-session/session-transport owner. |
| `resource.renderer_window -> resource.tmux_session` | Renderer never owns terminal content layout or backend geometry. |
| `resource.renderer_window -> resource.wezterm_pane` | Renderer never owns terminal content layout or backend geometry. |
| `resource.platform_input_channel -> resource.backend_session` | Input must go through current session transport and daemon input queue. |
| `resource.daemon_process -> resource.active_session` | Daemon must not store client active/session/foreground state. |
| `resource.debug_channel -> resource.mirror_store` | Debug side channels observe only and cannot become business truth. |
| `resource.release_update_artifact -> resource.daemon_process` | Runtime must consume promoted deterministic artifacts, not direct release/update outputs. |
| `resource.ui_projection -> resource.remote_window_stream` | UI may only project the overlay and emit intent; daemon/native stream truth owns catalog, coordinates, capture, WebRTC, and input injection. |
| `resource.remote_window_stream -> resource.mirror_store` | Remote window video is desktop media truth and must not reuse terminal mirror rows as video truth. |

## Owner Locks

- `resource.open_tab` is explicit current-process client truth; runtime sessions and daemon facts must not close or merge it, and cold launch must not restore it.
- `resource.session_transport` is the only platform-client path to daemon transport.
- `resource.session_transport` owns physical body-subscription intent and measured RTT/jitter/stall. It does not own active/visible reasons after emitting the physical intent.
- `resource.transport_subscriber` owns only physical `bodySubscribed`, send accounting/backpressure, last-sent revision, and bounded pending-latest state. It must not store active tab, foreground, pane visibility, follow, reading, or viewport reasons.
- `resource.mirror_store` is the only daemon canonical terminal content, revision, absolute-index, and geometry truth. Hot-tail range patch and full reconciliation are two validated commit modes inside this one writer, not two truth paths.
- `resource.mirror_store -> resource.transport_subscriber` is the only unsolicited live body broadcast relation. Unsubscribe removes broadcast eligibility without closing the transport, detaching the mirror, or disabling explicit head/range reads.
- `resource.client_sparse_buffer` only merges daemon mirror patches by absolute row.
- `resource.renderer_window` owns follow/reading/render-bottom/visible demand and next-RAF commit only, not terminal content layout or network cadence.
- `resource.session_preview_selection` owns only an ordered 1-6 client preference resolved through current open-tab truth; remote drawer catalog rows must first materialize through the existing session-open owner and persist only the returned local session id; drawer checkbox and in-preview add both route to this owner, add/replacement candidates are every currently open unselected Session, reorder only changes preference order, and tile close removes only that preview target without closing a Session or transport.
- `resource.session_preview_mode` owns preview shell projection plus the captured entry-session projection used only by cancel. Entry does not mutate active session; tile activation emits one explicit switch; Back/right-swipe/close cancellation restores the captured entry session. Buffer, transport, and backend geometry remain untouched.
- `resource.remote_window_overlay` owns only the Android picker/floating/fullscreen projection, default-collapsed iTerm2 pane picker grouping, source-aspect floating resize with toolbar reachability bounds, fullscreen aspect-fit/aspect-fill display mode, fullscreen zoom/pan/minimap state, keyboard-open fullscreen letterbox pan, projection-sized effective bitrate selection, Back shrink, minimize, close intent, and explicit input intent emission for supported app-window OS-event targets. Unsupported `tmux-input` / `iterm2-api` routes are projected as read-only and must not publish a remote-window input context. Aspect-fill cover is Android projection only: drawing and pointer normalization use the same actual content rect, and the daemon capture/coordinate truth remains unchanged. It does not compute macOS coordinates, read iTerm2 split trees, perform input injection, or own capture lifecycle.
- `resource.remote_window_stream` owns daemon/native app/window/iTerm2 pane catalog, coordinate manifest, ScreenCaptureKit capture, WebRTC media negotiation/sender lifecycle, receiver attach status, frame metadata, cleanup, and input target lease. It may reverse-map iTerm2 `tty` to tmux client/session metadata, but terminal mirror/buffer/render resources are forbidden as video truth. Media negotiation still uses the existing session transport as the control plane; video frames must come only from the daemon capture source. Android derives video ICE servers from the current session traversal route, so Relay/cellular remote-window video does not start a separate no-ICE peer connection.
- `resource.debug_channel` can observe and diagnose through bounded metadata-only trace records, but cannot become request/response business truth or contain terminal text/cells.
- `resource.release_update_artifact` must promote through `resource.daemon_runtime_artifact`; runtime cannot scan authoring directories as capability truth.

## Gate Contract

- `src/lib/resource-registry-truth.test.ts` validates schema, resource id uniqueness, owner feature existence, doc/gate references, relation ids, and forbidden direct edges.
- `src/lib/function-map-resource-truth.test.ts` validates function map resource binding and prevents feature-local maps from inventing resource ids.
- `src/lib/mainline-resource-call-map.test.ts` validates resource metadata on mainline call-map edges and rejects direct forbidden edges.
