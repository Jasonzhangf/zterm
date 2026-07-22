# Mainline Source Wiki

Worker-readable source ownership map. Generated diagram: `docs/wiki/generated/mainline-source.html`.

## Android Mainline

```mermaid
flowchart TD
  Native["native/android/app/src/main"] --> Capacitor["capacitor.config.ts"]
  Capacitor --> Vite["vite.config.ts"]
  Vite --> Main["src/main.tsx"]
  Main --> App["src/App.tsx"]
  App --> SessionContext["src/contexts/SessionContext.tsx"]
  SessionContext --> SessionLifecycle["src/contexts/session-context-session-orchestration-runtime.ts"]
  SessionLifecycle --> ActivityFreshness["src/contexts/session-context-activity-runtime.ts"]
  ActivityFreshness --> SessionRuntime["src/contexts/session-context-session-runtime.ts"]
  SessionLifecycle --> SessionRuntime
  SessionRuntime --> TransportReusePlan["src/contexts/session-transport-open-helpers.ts"]
  SessionContext --> TransportOrchestration["src/contexts/session-context-transport-orchestration-runtime.ts"]
  TransportOrchestration --> TransportOpen["src/contexts/session-context-transport-open-runtime.ts"]
  TransportOpen --> TransportReusePlan
  TransportOpen --> TraversalSocketFactory["src/contexts/session-context-infra-runtime.ts#buildTraversalSocketForHostRuntime"]
  TraversalSocketFactory --> TraversalSocket["src/lib/traversal/socket.ts#TraversalSocket"]
  TransportOpen --> TargetTransportRuntime["src/lib/session-transport-runtime.ts#target transport runtime"]
  TraversalSocket --> TargetTransportRuntime
  TargetTransportRuntime --> MuxHandshake["packages/shared/src/connection/protocol.ts#TerminalMuxClientFrame"]
  TargetTransportRuntime --> ChannelRuntime["src/lib/session-transport-runtime.ts#terminal channel runtime"]
  ChannelRuntime --> ChannelMessageSend["src/contexts/session-context-transport-wire-runtime.ts#mux channel send"]
  SessionContext --> SocketMessage["src/contexts/session-context-socket-message-runtime.ts#handleSocketServerMessageRuntime"]
  SocketMessage --> ChannelDemux["src/contexts/session-context-socket-message-runtime.ts#mux channel demux"]
  ChannelDemux --> BufferApply
  SocketMessage --> BufferApply["src/contexts/session-context-buffer-runtime.ts#applyIncomingBufferSyncRuntime"]
  BufferApply --> RenderGate["src/lib/session-render-gate.ts#scheduleCommit"]
  SocketMessage --> PerformanceTrace["src/lib/terminal-performance-trace.ts"]
  BufferApply --> PerformanceTrace
  RenderGate --> PerformanceTrace
  App --> Connections["src/pages/ConnectionsPage.tsx"]
  Connections --> SessionOpenOwner["src/hooks/useSessionOpenActions.ts#handleOpenSavedConnection"]
  SessionOpenOwner --> SessionContext
  App --> TerminalPage["src/pages/TerminalPage.tsx"]
  TerminalPage --> TerminalView["src/components/TerminalView.tsx"]
  TerminalPage --> QuickBar["src/components/terminal/TerminalQuickBar.tsx"]
  TerminalPage --> RemoteWindowOverlay["src/components/terminal/RemoteWindowOverlay.tsx#RemoteWindowOverlay"]
  TerminalPage --> RemoteWindowInputRuntime["src/contexts/session-context-remote-window-runtime.ts#sendRemoteWindowInputRuntime"]
  RemoteWindowOverlay --> RemoteWindowMessageRuntime["src/lib/remote-window-message-runtime.ts#createRemoteWindowMessageRuntime"]
  RemoteWindowOverlay --> RemoteWindowStreamQualityRuntime["src/contexts/session-context-remote-window-runtime.ts#updateRemoteWindowStreamQualityRuntime"]
  RemoteWindowOverlay --> RemoteWindowInputRuntime["src/contexts/session-context-remote-window-runtime.ts#sendRemoteWindowInputRuntime"]
  RemoteWindowInputRuntime --> RemoteWindowMessageRuntime
  RemoteWindowStreamQualityRuntime --> RemoteWindowMessageRuntime
  RemoteWindowMessageRuntime --> RemoteWindowReceiver["src/contexts/session-context-remote-window-runtime.ts#requestRemoteWindowStreamStartRuntime"]
  TerminalPage --> StageShell["src/pages/TerminalPageStageShell.tsx"]
  TerminalPage --> LayoutProfile["src/lib/terminal-layout-profile.ts"]
  LayoutProfile --> StageShell
  TerminalPage --> SessionDrawer["src/components/terminal/TerminalSessionDrawer.tsx"]
  SessionDrawer --> TerminalPage
  TerminalView --> Renderer["src/lib/session-render-buffer-store.ts"]
  Renderer --> RenderGate["src/lib/session-render-gate.ts"]
```

`App -> TerminalPage -> SessionDrawer` carries saved/Home server identity aliases alongside Relay endpoint and Session catalog facts. `TerminalPage` canonicalizes these into one daemon host rail; ambiguous rtc-only catalog matches remain separate and never guess identity.
`SessionOpenOwner` and the open-tab runtime audit path also reuse an existing open mux target transport for drawer refresh / session-picker refresh when a matching non-closed session exists; legacy tmux fetch is only the no-matching-open-target path.

## Android Session Preview Mainline

```mermaid
flowchart TD
  SessionDrawer["src/components/terminal/TerminalSessionDrawer.tsx#TerminalSessionDrawer"] --> PreviewSelectionOwner["src/lib/session-preview-selection.ts#toggleSessionPreviewTarget"]
  SessionDrawer --> RemoteSessionOpenOwner["src/hooks/useSessionOpenActions.ts#handleOpenGroupSession"]
  RemoteSessionOpenOwner --> PreviewSelectionOwner
  PreviewSelectionOwner --> OpenTabResolver["src/lib/session-preview-selection.ts#resolveSessionPreviewTargets"]
  TerminalShellGesture["src/lib/session-preview-gesture.ts#resolveSessionPreviewGesture"] --> PreviewModeOwner["src/pages/TerminalPage.tsx#sessionPreviewOpen"]
  PreviewModeOwner --> PreviewLiveSetProjector["src/lib/session-preview-selection.ts#projectSessionPreviewLiveIds"]
  PreviewLiveSetProjector --> SessionBodySubscriptionIntent["src/pages/TerminalPage.tsx#onLiveSessionIdsChange"]
  PreviewModeOwner --> TerminalPreviewGrid["src/components/terminal/TerminalPreviewGrid.tsx#TerminalPreviewGrid"]
  TerminalPreviewGrid --> TerminalPreviewTile["src/components/terminal/TerminalPreviewGrid.tsx#preview-tile"]
  TerminalPreviewTile --> SharedRenderSurface["src/components/TerminalView.tsx#TerminalView"]
  TerminalPreviewTile --> PreviewReplacementMenu["src/components/terminal/TerminalPreviewGrid.tsx#preview-replacement-menu"]
  PreviewReplacementMenu --> PreviewSelectionOwner
  PreviewAddMenu["src/components/terminal/TerminalPreviewGrid.tsx#terminal-preview-add-menu"] --> PreviewSelectionOwner
  TerminalPreviewTileClose["src/pages/TerminalPage.tsx#handleRemoveSessionFromPreview"] --> PreviewSelectionOwner
  TerminalPreviewTile --> ActiveSessionIntent["src/pages/TerminalPage.tsx#handleActivateOpenSessionInViewport"]
  ActiveSessionIntent --> TerminalPage["src/pages/TerminalPage.tsx"]
  SystemBackIntent["@capacitor/app#backButton"] --> PreviewModeOwner
  PreviewModeOwner --> EntrySessionProjection["src/pages/TerminalPage.tsx#handleCancelSessionPreview"]
  EntrySessionProjection --> TerminalPage
```

## Daemon Mainline

```mermaid
flowchart TD
  CLI["scripts/zterm-daemon.sh"] --> Server["src/server/server.ts"]
  Server --> DaemonRuntime["src/server/terminal-daemon-runtime.ts"]
  Server --> Runtime["src/server/terminal-runtime.ts"]
  DaemonRuntime --> Runtime
  Runtime --> Bridge["src/server/terminal-bridge-runtime.ts"]
  Bridge --> MuxHandshake["packages/shared/src/connection/protocol.ts#TerminalMuxServerFrame"]
  MuxHandshake --> ChannelRegistry["src/server/terminal-runtime.ts#mux channel registry"]
  ChannelRegistry --> Runtime
  Runtime --> Message["src/server/terminal-message-runtime.ts"]
  Message --> ChannelRegistry
  Message --> Mirror["src/server/terminal-mirror-runtime.ts"]
  Mirror --> Capture["src/server/terminal-mirror-capture.ts"]
  Mirror --> SendScheduler["src/server/terminal-transport-runtime.ts#mux send scheduler"]
  SendScheduler --> TransportSend
  Mirror --> TransportSend["src/server/terminal-transport-runtime.ts#sendText"]
  Capture --> PerformanceTrace["src/lib/terminal-performance-trace.ts"]
  Mirror --> PerformanceTrace
  TransportSend --> PerformanceTrace
  Message --> Control["src/server/terminal-message-control-runtime.ts"]
  Control --> Tmux["src/server/terminal-control-runtime.ts"]
  Control --> Schedule["src/server/terminal-schedule-runtime.ts"]
  Control --> Transfer["src/server/terminal-file-transfer-runtime.ts"]
  Control --> Screenshot["src/server/remote-screenshot-daemon.ts"]
  Control --> RemoteWindowStream["src/server/remote-window-stream-daemon.ts#createRemoteWindowStreamDaemonRuntime"]
  RemoteWindowStream --> RemoteWindowCapture["src/server/remote-window-stream-daemon.ts#startScreenCaptureKitFrameSource"]
  RemoteWindowCapture --> RemoteWindowMedia["src/server/remote-window-stream-daemon.ts#startStream"]
  RemoteWindowStream --> RemoteWindowInput["src/server/remote-window-stream-daemon.ts#injectInput"]
  RemoteWindowStream --> RemoteWindowCleanup["src/server/remote-window-stream-daemon.ts#stopStream"]
  Server --> Http["src/server/terminal-http-runtime.ts"]
  Server --> Debug["src/server/terminal-debug-runtime.ts"]
  Server --> Transport["src/server/terminal-transport-runtime.ts"]
  Server --> Relay["src/server/relay-client.ts"]
  Relay --> RelayPeerLease["src/traversal-relay/server.ts#relay peer lease"]
  RelayPeerLease --> MuxHandshake
```

## CLI Mainline

```mermaid
flowchart TD
  DevCLI["pnpm run daemon:*"] --> Shell["scripts/zterm-daemon.sh"]
  Shell --> Launchd["~/Library/LaunchAgents/com.zterm.android.zterm-daemon.plist"]
  Shell --> Direct["~/.wterm/run/zterm-daemon.pid"]
  Shell --> Runtime["~/.wterm/daemon-runtime/server.cjs"]
  Shell --> Native["scripts/native/zterm-daemon.swift"]
  WinShell["scripts/windows/zterm-daemon.ps1"] --> WinTask["Windows Scheduled Task: ZTermDaemon"]
  WinTask --> Runtime
  Release["scripts/prepare-global-daemon-release.sh"] --> Runtime
  Release --> Install["scripts/install-global-daemon-cli.sh"]
  Install --> GlobalBin["~/.local/bin/zterm-daemon"]
  Npm["scripts/prepare-daemon-npm-package.mjs"] --> PackageBin["package/bin/zterm-daemon"]
  Npm --> WinShell
```

## Global Resource Flow

The executable resource graph is declared in `docs/resource-registry.json`; the review surface is `docs/resource-map.md`. Mainline call-map edges in `docs/wiki/mainline-call-map.json` bind each lifecycle edge to `resource_from`, `resource_to`, `via_resources`, and `relation_status`.

```mermaid
flowchart TD
  RuntimeHome["resource.runtime_home"] --> DaemonArtifact["resource.daemon_runtime_artifact"]
  DaemonArtifact --> DaemonProcess["resource.daemon_process"]
  DaemonProcess --> TerminalBackend["resource.terminal_backend"]
  TerminalBackend --> BackendSession["resource.backend_session"]
  BackendSession --> TmuxSession["resource.tmux_session"]
  BackendSession --> WeztermPane["resource.wezterm_pane"]
  SessionTransport["resource.session_transport"] --> DaemonTargetTransport["resource.daemon_target_transport"]
  DaemonTargetTransport --> TransportTarget["resource.transport_target"]
  DaemonTargetTransport --> RelayPeerLease["resource.relay_peer_lease"]
  RelayPeerLease --> TransportTarget
  DaemonTargetTransport --> TerminalChannel["resource.terminal_channel"]
  TerminalChannel --> TransportSubscriber["resource.transport_subscriber"]
  TransportSubscriber --> MirrorStore["resource.mirror_store"]
  MirrorStore --> TransportSubscriber
  MirrorStore --> ClientSparseBuffer["resource.client_sparse_buffer"]
  ClientSparseBuffer --> RendererWindow["resource.renderer_window"]
  RendererWindow --> UiProjection["resource.ui_projection"]
  UiProjection --> PreviewSelection["resource.session_preview_selection"]
  UiProjection --> PreviewMode["resource.session_preview_mode"]
  UiProjection --> RemoteWindowOverlay["resource.remote_window_overlay"]
  RemoteWindowOverlay --> RemoteWindowStream["resource.remote_window_stream"]
  RemoteWindowStream --> DaemonProcess
  PreviewSelection --> OpenTab
  PreviewMode --> UiProjection
  OpenTab["resource.open_tab"] --> ActiveSession["resource.active_session"]
  ActiveSession --> SessionTransport
  PlatformInput["resource.platform_input_channel"] --> SessionTransport
  DaemonInputQueue["resource.daemon_input_queue"] --> BackendSession
  ReleaseArtifact["resource.release_update_artifact"] --> DaemonArtifact
  DebugChannel["resource.debug_channel"] --> DaemonProcess
  MirrorStore --> DebugChannel
  TransportSubscriber --> DebugChannel
  ClientSparseBuffer --> DebugChannel
  RendererWindow --> DebugChannel
```

## Published Source Surfaces

| surface | files |
| --- | --- |
| Android app entry | `src/main.tsx`, `src/App.tsx`, `src/pages/ConnectionsPage.tsx`, `src/pages/TerminalPage.tsx` |
| Client transport lifecycle | `packages/shared/src/connection/protocol.ts`, `src/contexts/SessionContext.tsx`, `src/contexts/session-context-session-orchestration-runtime.ts`, `src/contexts/session-context-session-runtime.ts`, `src/contexts/session-context-activity-runtime.ts`, `src/contexts/session-context-transport-orchestration-runtime.ts`, `src/contexts/session-context-transport-open-runtime.ts`, `src/contexts/session-context-socket-message-runtime.ts`, `src/contexts/session-transport-open-helpers.ts`, `src/lib/session-transport-runtime.ts`; target mux nodes are `TargetTransportRuntime`, `MuxHandshake`, `ChannelRuntime`, `ChannelMessageSend`, and `ChannelDemux`; WebRTC route diagnostics include metadata-only selected ICE pair projection through `src/lib/traversal/socket.ts` and `src/pages/TerminalPageDebugOverlay.tsx` |
| Terminal body receive/apply/render | `src/contexts/session-context-socket-message-runtime.ts#handleSocketServerMessageRuntime`, `src/contexts/session-context-buffer-runtime.ts#applyIncomingBufferSyncRuntime`, `src/lib/session-render-gate.ts#scheduleCommit`, `src/lib/session-render-buffer-store.ts` |
| Terminal performance observer | `src/lib/terminal-performance-trace.ts`, `src/server/terminal-debug-runtime.ts`, `src/lib/runtime-debug.ts`; metadata only, no terminal text/cells |
| Terminal shell and panes | `src/pages/TerminalPageStageShell.tsx`, `src/hooks/useTerminalWorkspace.ts`, `src/components/terminal/TerminalQuickBar.tsx` |
| Remote window stream projection | `packages/shared/src/connection/protocol.ts`, `src/server/remote-window-stream-daemon.ts`, `src/server/terminal-message-runtime.ts`, `src/server/server.ts`, `src/server/terminal-file-transfer-binary-runtime.ts`, `src/components/terminal/RemoteWindowOverlay.tsx`, `src/lib/remote-window-overlay-runtime.ts`, `src/lib/remote-window-message-runtime.ts`, `src/lib/remote-window-receiver-runtime.ts`, `src/lib/remote-window-video-quality.ts`, `src/contexts/session-context-remote-window-runtime.ts`, `src/contexts/session-context-transfer-runtime.ts`, `docs/decisions/2026-07-19-remote-window-stream-truth.md`; ScreenCaptureKit/WebRTC bindings are anchored under `RemoteWindowMessageRuntime`, `RemoteWindowReceiver`, `RemoteWindowStreamQualityRuntime`, `RemoteWindowCapture`, `RemoteWindowMedia`, `RemoteWindowInput`, and `RemoteWindowCleanup`; Android fullscreen projection now owns default-collapsed iTerm2 picker grouping, daemon-wide 60-second target catalog cache keyed by daemon identity, aspect-fit/default, aspect-fill cover display mode using one content rect for drawing and input mapping, source-aspect floating resize with toolbar reachability cap, daemon-frame-aspect receiver projection after stream start, IME bottom-inset fullscreen padding plus QuickBar chrome auto-pan, unzoomed pointer/gesture input and wheel pixel-scroll input even while IME inset is present, zoomed-only local single-finger pan, supported app-window-only input context, focus-aware image paste routing, floating-preview low bitrate, desktop-area-proportional stream quality defaults, adaptive network quality caps, and explicit max frame-rate request values; remaining live gates are Android rendered-pixel recheck and iTerm2-pane stream/input proof |
| Terminal session group layout | `src/lib/terminal-layout-profile.ts`, `src/lib/session-group-viewport.ts`, `src/pages/TerminalPage.tsx#resolveTerminalSessionGroupActiveSessionProjection`, `src/pages/TerminalPageStageShell.tsx`, `docs/features/terminal-session-group-layout.md`, `docs/testing/terminal-session-group-layout-test-design.md` |
| Session drawer (multi-host) | `src/components/terminal/TerminalSessionDrawer.tsx` (UI), `src/pages/TerminalPage.tsx` (`drawerServerIdentityAliases` canonicalizes live/session-group/Relay endpoint identity; `drawerSessions` projects hostKey/hostLabel + opened-first ordering) |
| Session quick preview | `src/lib/session-preview-selection.ts`, `src/lib/session-preview-gesture.ts`, `src/components/terminal/TerminalPreviewGrid.tsx`, `src/pages/TerminalPageStageShell.tsx` |
| Daemon runtime | `src/server/server.ts`, `src/server/terminal-daemon-runtime.ts`, `src/server/terminal-runtime.ts`, `src/server/terminal-message-runtime.ts`, `src/server/terminal-mirror-runtime.ts`, `src/server/terminal-message-control-runtime.ts`, `src/server/terminal-transport-runtime.ts`, `src/server/remote-window-stream-daemon.ts` |
| Daemon control edges | `src/server/terminal-control-runtime.ts`, `src/server/terminal-file-transfer-runtime.ts`, `src/server/terminal-schedule-runtime.ts`, `src/server/remote-screenshot-daemon.ts`, `src/server/remote-window-stream-daemon.ts`, `src/server/terminal-http-runtime.ts` |
| Daemon CLI | `scripts/zterm-daemon.sh`, `scripts/windows/zterm-daemon.ps1`, `scripts/install-global-daemon-cli.sh`, `scripts/prepare-global-daemon-release.sh`, `scripts/prepare-daemon-npm-package.mjs` |
| Release/update | `scripts/build-android-debug.sh`, `scripts/prepare-update-bundle.mjs`, `scripts/verify-release-assets.mjs`; Relay public update route and future `RelayPeerLease` idle-resume resource are authored in `src/traversal-relay/server.ts` and packaged by `scripts/prepare-relay-server-npm-package.mjs` with `ZTERM_TRAVERSAL_UPDATES_DIR` |
| Worker wiki generator | `scripts/build-function-wiki.mjs`, `docs/wiki/daemon.md`, `docs/wiki/cli.md`, `docs/wiki/mainline-source.md` |
| Global resource truth | `docs/resource-registry.json`, `docs/resource-map.md`, `docs/testing/resource-truth-test-design.md` |

## Gate

- `src/lib/feature-registry-truth.test.ts`
- `src/lib/function-wiki-truth.test.ts`
- `src/lib/resource-registry-truth.test.ts`
- `src/lib/function-map-resource-truth.test.ts`
- `src/lib/mainline-resource-call-map.test.ts`
- `pnpm run test:feature-registry`
