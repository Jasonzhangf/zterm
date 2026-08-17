# Mainline Source Wiki

Worker-readable source ownership map. Generated diagram: `docs/wiki/generated/mainline-source.html`.

## Android Mainline

```mermaid
flowchart TD
  Native["native/android/app/src/main"] --> Capacitor["capacitor.config.ts"]
  Capacitor --> Vite["vite.config.ts"]
  Native --> NetworkIdentityWrapper["src/plugins/NetworkIdentityPlugin.ts#registerPlugin(NetworkIdentity)"]
  Vite --> Main["src/main.tsx"]
  Main --> App["src/App.tsx"]
  App --> CompositionRoot["src/lib/composition-root/client-composition-root.ts#ClientCompositionRoot"]
  CompositionRoot --> PluginHost
  App --> ControlCenter["src/lib/control-center/client-control-center.ts#ClientControlCenter"]
  ControlCenter --> PluginHostControlNode["src/lib/plugin-host/plugin-host-control-node.ts#PluginHostControlNode"]
  PluginHostControlNode --> PluginHost
  App --> App_createAppPluginHost["src/App.tsx#createAppPluginHost (App.createAppPluginHost)"]
  App_createAppPluginHost --> PluginHost["src/lib/plugin-host/plugin-host-runtime.ts#createPluginHost"]
  App --> PluginHost["src/lib/plugin-host/plugin-host-runtime.ts#createPluginHost"]
  PluginHost --> CapabilityRegistry["packages/shared/src/terminal/plugin-capability-registry.ts#PluginCapabilityRegistry"]
  PluginHost --> UiSlotRegistry["packages/shared/src/terminal/plugin-ui-slot-registry.ts#PluginUiSlotRegistry"]
  PluginHost --> DebugConsoleUiPlugin["src/lib/plugin-host/debug-console-ui-plugin.tsx#DebugConsoleUiPlugin"]
  DebugConsoleUiPlugin --> DebugConsoleContract["src/lib/plugin-debug-console/debug-console-contract.ts#TerminalDebugOverlayProps"]
  DebugConsoleUiPlugin --> TerminalDebugOverlay["src/pages/TerminalPageDebugOverlay.tsx#TerminalDebugOverlay"]
  App --> DebugConsoleContract
  PluginHost --> SessionDrawerUiPlugin["src/lib/plugin-host/session-drawer-ui-plugin.tsx#SessionDrawerUiPlugin"]
  SessionDrawerUiPlugin --> SessionDrawerContract["src/lib/plugin-session-drawer/session-drawer-contract.ts#TerminalSessionDrawerSlot"]
  SessionDrawerUiPlugin --> TerminalSessionDrawer["src/components/terminal/TerminalSessionDrawer.tsx#TerminalSessionDrawer"]
  App --> SessionDrawerContract
  PluginHost --> FileBrowserUiPlugin["src/lib/plugin-host/file-browser-ui-plugin.tsx#FileBrowserUiPlugin"]
  FileBrowserUiPlugin --> FileBrowserContract["src/lib/plugin-file-browser/file-browser-contract.ts#TerminalFileBrowserSlot"]
  FileBrowserUiPlugin --> FileTransferSheetPluginRender["src/components/terminal/FileTransferSheet.tsx#FileTransferSheet"]
  App --> FileBrowserContract
  PluginHost --> SettingsUpdateUiPlugin["src/lib/plugin-host/settings-update-ui-plugin.tsx#SettingsUpdateUiPlugin"]
  SettingsUpdateUiPlugin --> SettingsUpdateContract["src/lib/plugin-settings-update/settings-update-contract.ts#SettingsUpdateUiSlot"]
  SettingsUpdateUiPlugin --> AppUpdateSectionPluginRender["src/components/settings/AppUpdateSection.tsx#AppUpdateSection"]
  App --> SettingsUpdateContract
  PluginHost --> RemoteWindowUiPlugin["src/lib/plugin-host/remote-window-ui-plugin.tsx#RemoteWindowUiPlugin"]
  RemoteWindowUiPlugin --> RemoteWindowContract["src/lib/plugin-remote-window/remote-window-contract.ts#TerminalRemoteWindowSlot"]
  RemoteWindowUiPlugin --> RemoteWindowOverlayPluginRender["src/components/terminal/RemoteWindowOverlay.tsx#RemoteWindowOverlay"]
  App --> RemoteWindowContract
  PluginHost --> TerminalShellUiPlugin["src/lib/plugin-host/terminal-shell-ui-plugin.tsx#TerminalShellUiPlugin"]
  TerminalShellUiPlugin --> TerminalShellContract["src/lib/plugin-terminal-shell/terminal-shell-contract.ts#TerminalShellUiSlot"]
  App --> TerminalShellContract
  App --> SettingsPage["src/pages/SettingsPage.tsx#SettingsPage"]
  SettingsPage --> SettingsUpdateContract
  PluginHost --> NetworkIdentityCapability["src/lib/plugin-host/network-identity-capability-plugin.ts#NetworkIdentityCapabilityPlugin"]
  NetworkIdentityCapability --> NetworkIdentityRuntime["src/lib/network-identity.ts#createNetworkIdentityRuntime"]
  App --> TerminalShellSkinResolver["src/lib/terminal-shell-skin.ts#resolveEffectiveTerminalShellSkin + resolveTerminalRendererThemeForSkin"]
  TerminalShellSkinResolver --> TerminalPage["src/pages/TerminalPage.tsx"]
  App --> RelayControlRuntime["src/hooks/useRelayDeviceStream.ts#useRelayDeviceStream"]
  RelayControlRuntime --> RelayControlSocket["src/lib/traversal-relay-client.ts#connectTraversalRelayDevicesStream"]
  RelayControlSocket --> RelayAccountStore["src/lib/traversal-relay-client.ts#connectTraversalRelayDevicesStream"]
  RelayAccountStore --> RelayDirectoryProjection["src/lib/client-control-directory-runtime.ts#ClientControlDirectoryRuntime.replaceFromDevices"]
  RelayDirectoryProjection --> ClientControlPlaneTransport["src/lib/client-control-plane-transport.ts#ClientControlPlaneTransport"]
  ClientControlPlaneTransport --> TransportTargetResolver["src/lib/client-control-directory-runtime.ts#mergeHostWithClientControlDirectory"]
  TransportTargetResolver --> TraversalSocketFactory
  App --> SessionContext["src/contexts/SessionContext.tsx"]
  SessionContext --> SessionLifecycle["src/contexts/session-context-session-orchestration-runtime.ts"]
  SessionLifecycle --> PassiveVisibleRefreshScheduler["src/contexts/session-context-lifecycle.ts#selectNextPassiveVisibleRefreshCandidate"]
  PassiveVisibleRefreshScheduler --> ActivityFreshness
  SessionLifecycle --> ActivityFreshness["src/contexts/session-context-activity-runtime.ts"]
  ActivityFreshness --> SessionRuntime["src/contexts/session-context-session-runtime.ts"]
  SessionLifecycle --> SessionRuntime
  SessionRuntime --> TransportReusePlan["src/contexts/session-transport-open-helpers.ts"]
  SessionContext --> TransportOrchestration["src/contexts/session-context-transport-orchestration-runtime.ts"]
  TransportOrchestration --> TransportOpen["src/contexts/session-context-transport-open-runtime.ts"]
  TransportOrchestration --> TerminalChannelClosedIn01CloseSignal["src/contexts/session-context-transport-orchestration-runtime.ts#buildMuxChannelCallbacks.onClosed"]
  TerminalChannelClosedIn01CloseSignal --> TerminalChannelClosedIn02ControlStatusDecision["src/contexts/session-context-transport-orchestration-runtime.ts#resolveMuxChannelClosedWithControlStatusRuntime"]
  TerminalChannelClosedIn02ControlStatusDecision --> TerminalTargetControlOut01ListSessions["src/contexts/session-context-tmux-management-runtime.ts#manageTmuxSessionsOnOpenTransportRuntime"]
  TerminalChannelClosedIn02ControlStatusDecision --> TargetFailureRouter
  TransportOpen --> TransportReusePlan
  TransportOpen --> TraversalSocketFactory["src/contexts/session-context-infra-runtime.ts#buildTraversalSocketForHostRuntime"]
  TraversalSocketFactory --> TraversalSocket["src/lib/traversal/socket.ts#TraversalSocket"]
  TraversalSocket --> TerminalTransportOut01RouteSelection["src/lib/traversal/route-selector.ts#selectBestTraversalRoute"]
  TransportOpen --> TargetTransportRuntime["src/lib/session-transport-runtime.ts#target transport runtime"]
  TraversalSocket --> TargetTransportRuntime
  TargetTransportRuntime --> TargetHeartbeat["src/contexts/session-context-socket-runtime.ts#startSocketHeartbeat (target-keyed)"]
  PlatformNetworkSignal["src/hooks/useOpenTabLifecycleEffects.ts#useOpenTabLifecycleEffects (signal-only)"] --> OpenTabNetworkBinding["src/hooks/useOpenTabRuntime.ts#useOpenTabRuntime"]
  OpenTabNetworkBinding --> AppNetworkBinding["src/App.tsx#AppContent"]
  AppNetworkBinding --> SessionContextNetworkFacade["src/contexts/SessionContext.tsx#SessionProvider"]
  SessionContextNetworkFacade --> SessionProviderNetworkBinding["src/contexts/session-context-provider-facade-assemblies.ts#useSessionProviderFacadeAssemblies"]
  SessionProviderNetworkBinding --> SessionPublicFacadeBinding["src/contexts/session-context-public-facade-runtime.ts#createSessionPublicFacadeRuntime"]
  SessionPublicFacadeBinding --> SessionProviderCoreBinding["src/contexts/session-context-provider-core-assemblies.ts#useSessionProviderCoreAssemblies"]
  SessionProviderCoreBinding --> TargetNetworkSignalOrchestration["src/contexts/session-context-transport-orchestration-runtime.ts#createSessionTransportOrchestrationRuntime"]
  TargetHeartbeat --> TerminalMuxPingBuilder["packages/shared/src/connection/protocol.ts#buildTerminalMuxPing"]
  TargetNetworkSignalOrchestration --> TerminalMuxPingBuilder
  TargetNetworkSignalOrchestration --> TargetTransportAccessors["src/contexts/session-context-transport-runtime.ts#createSessionContextTransportAccessors"]
  TargetTransportAccessors --> TargetTransportStoreEnumeration["src/lib/session-transport-runtime.ts#listTargetTransportRuntimes"]
  TargetTransportStoreEnumeration --> TargetNetworkProbeDispatch["src/contexts/session-context-transport-orchestration-runtime.ts#notifyTargetNetworkSignalRuntime"]
  TargetNetworkProbeDispatch --> TargetNetworkProbe["src/contexts/session-context-target-network-probe-runtime.ts#createSessionTargetNetworkProbeRuntime"]
  TargetNetworkProbe --> TargetFailureRouter["src/contexts/session-context-transport-orchestration-runtime.ts#routeTargetSocketFailureRuntime"]
  TargetFailureRouter --> TerminalTransportError01TargetFailure
  TargetFailureRouter --> IdleTargetRetirement["zero-session exact-generation retirement"]
  TargetTransportRuntime --> MuxHandshake["packages/shared/src/connection/protocol.ts#TerminalMuxClientFrame"]
  MuxHandshake --> TargetMuxFrameLifecycle["src/contexts/session-context-transport-runtime.ts#bindTargetMuxTransportSocketLifecycleRuntime"]
  TargetMuxFrameLifecycle --> ActiveSessionPriority["src/contexts/session-context-transport-orchestration-runtime.ts#createSessionTransportOrchestrationRuntime activeSessionId binding"]
  ActiveSessionPriority --> ChannelRuntime
  TargetMuxFrameLifecycle --> TargetNetworkActivityBinding["src/contexts/session-context-transport-orchestration-runtime.ts#createSessionTransportOrchestrationRuntime recordTargetServerActivity binding"]
  TargetNetworkActivityBinding --> TargetNetworkProbe
  MuxHandshake --> TerminalTransportError01TargetFailure["src/contexts/session-context-transport-orchestration-runtime.ts#handleTargetMuxTransportFailureRuntime"]
  TerminalTransportError01TargetFailure --> TraversalSocket
  TerminalTransportError01TargetFailure --> SessionRuntime
  TargetTransportRuntime --> ChannelRuntime["src/lib/terminal-channel-mux-runtime.ts#terminal channel runtime"]
  ChannelRuntime --> ChannelMessageSend["src/contexts/session-context-transport-wire-runtime.ts#mux channel send"]
  SessionContext --> SocketMessage["src/contexts/session-context-socket-message-runtime.ts#handleSocketServerMessageRuntime"]
  SessionContext --> TerminalInputDispatch["src/contexts/session-context-input-runtime.ts#sendInputThroughSessionTransport"]
  TerminalInputDispatch --> ClientReliableInputQueue["src/lib/reliable-input/reliable-input-queue.ts#enqueueReliableInputChunks"]
  ClientReliableInputQueue --> ChannelSend["src/contexts/session-context-transport-wire-runtime.ts#mux channel send"]
  SocketMessage --> ClientReliableInputAck["src/lib/reliable-input/reliable-input-queue.ts#handleTerminalInputAck"]
  SessionContext --> RuntimeDebugHttpExporter["src/lib/runtime-debug-http-exporter.ts#flushRuntimeDebugLogs"]
  SharedNodeContract["packages/shared/src/terminal/node-contract.ts#FoundationNode/DataNode/ControlNode"] --> SharedDebugContract["packages/shared/src/terminal/debug-contract.ts#DebugHub/DebugRegistry/SnapshotCoordinator/BoundedDebugEventStore/DebugPermissionService"]
  SharedNodeContract --> ClientDebugSnapshotRegistry["src/lib/client-debug-snapshot.ts#registerClientDebugSnapshotSource/collectClientDebugSnapshot"]
  SharedDebugContract --> ClientDebugSnapshotRegistry
  ClientDebugSnapshotRegistry --> RuntimeDebugHttpExporter
  SocketMessage --> ChannelDemux["src/contexts/session-context-socket-message-runtime.ts#mux channel demux"]
  ChannelDemux --> BufferWireNormalize
  SocketMessage --> BufferWireNormalize["src/lib/wire-ingress/buffer-wire-normalize.ts#normalizeIncomingBufferPayload"]
  BufferWireNormalize --> BufferSyncIngress["src/contexts/session-context-buffer-runtime.ts#applyIncomingBufferSyncRuntime"]
  SocketMessage --> BufferHeadFrameExpiry["src/contexts/session-context-buffer-runtime.ts#handleBufferHeadRuntime"]
  BufferSyncIngress --> BufferFrameAssembly["src/lib/buffer-frame-assembly/session-buffer-frame-assembly.ts#assembleBufferSyncFrameChunk"]
  BufferHeadFrameExpiry --> BufferFrameAssembly["src/lib/buffer-frame-assembly/session-buffer-frame-assembly.ts#expireBufferSyncFrameAssembly"]
  BufferFrameAssembly --> BufferSparseApply["src/contexts/session-context-buffer-runtime.ts#applyResolvedBufferSyncPayloadRuntime"]
  BufferSparseApply --> RenderGate["src/lib/session-render-gate.ts#scheduleCommit"]
  SocketMessage --> PerformanceTrace["src/lib/terminal-performance-trace.ts"]
  BufferSparseApply --> PerformanceTrace
  RenderGate --> PerformanceTrace
  App --> Connections["src/pages/ConnectionsPage.tsx"]
  Connections --> SessionOpenOwner["src/hooks/useSessionOpenActions.ts#handleOpenSavedConnection"]
  SessionOpenOwner --> SessionContext
  App --> TerminalPage["src/pages/TerminalPage.tsx"]
  TerminalPage --> TerminalDebugOverlay
  TerminalPage --> InputNormalizerIn01CommittedText["src/lib/terminal-input-normalization.ts#normalizeTerminalCommittedText"]
  TerminalView --> InputNormalizerIn01CommittedText
  InputNormalizerIn01CommittedText --> InputNormalizerOut02NormalizedText["src/lib/terminal-input-normalization.ts#normalizeTerminalCommittedText normalized output"]
  StageShell --> TerminalView["src/components/TerminalView.tsx + src/components/terminal/VisibleRow.tsx + src/components/terminal/TerminalPreviewRow.tsx + src/components/useMirrorFixedZoomPan.ts + packages/shared/src/terminal/cell-render.ts + packages/shared/src/terminal/theme.ts"]
  TerminalPage --> QuickBarContract["src/lib/plugin-quickbar/quickbar-contract.ts#TerminalQuickBarSlot"]
  QuickBarUiPlugin --> TerminalQuickBarPluginRender["src/components/terminal/TerminalQuickBar.tsx#TerminalQuickBar"]
  TerminalQuickBarPluginRender --> ClientFileTransferUploadOut01SheetIntent["src/components/terminal/FileTransferSheet.tsx#FileTransferSheet"]
  ClientFileTransferUploadOut01SheetIntent --> ClientFileTransferUploadOut02BoundedWindow["src/lib/file-transfer-throughput-runtime.ts#sendBoundedFileUploadChunks"]
  ClientFileTransferUploadOut02BoundedWindow --> ClientFileTransferUploadOut03ChunkDispatch["src/components/terminal/FileTransferSheet.tsx#dispatchUploadChunk"]
  ClientFileTransferUploadOut03ChunkDispatch --> ClientFileTransferUploadOut04MuxSend["src/pages/TerminalPage.tsx#sendFileTransferMessage"]
  ClientFileTransferUploadAckIn01SocketDispatch["src/contexts/session-context-socket-message-runtime.ts#handleSocketServerMessageRuntime"] --> ClientFileTransferUploadAckIn02SessionProjection["src/lib/file-transfer-session-runtime.ts#createFileTransferSessionRuntime"]
  ClientFileTransferDownloadIn01SocketDispatch["src/contexts/session-context-socket-message-runtime.ts#handleSocketServerMessageRuntime"] --> ClientFileTransferDownloadIn02SessionProjection["src/lib/file-transfer-session-runtime.ts#createFileTransferSessionRuntime"]
  ClientFileTransferDownloadIn02SessionProjection --> ClientFileTransferDownloadIn03SheetPersistence["src/components/terminal/FileTransferSheet.tsx#FileTransferSheet"]
  ClientFileTransferDownloadIn03SheetPersistence --> ClientFileTransferDownloadIn04NativeWriteBatch["src/lib/file-transfer-throughput-runtime.ts#writeFileTransferChunkBatches"]
  ClientFileTransferDownloadIn04NativeWriteBatch --> ClientFileTransferDownloadIn05NativeWriteDispatch["src/components/terminal/FileTransferSheet.tsx#writeDownloadChunkBatch"]
  ClientFileTransferDownloadIn05NativeWriteDispatch --> ClientFileTransferDownloadIn06NativeStore["native/android/app/src/main/java/com/zterm/android/StoragePermissionPlugin.java#writeFileChunks"]
  ClientFileTransferDownloadIn06NativeStore --> ClientFileTransferDownloadPersistOut01BytesWritten["native/android/app/src/main/java/com/zterm/android/StorageFileWriteLogic.java#writeChunks"]
  ClientFileTransferDownloadPersistOut01BytesWritten --> ClientFileTransferDownloadPersistOut02VerifiedStat["src/components/terminal/FileTransferSheet.tsx#onDownloadComplete"]
  ClientFileTransferUploadOut03ChunkDispatch --> ClientFileTransferUploadErrorOut01WireFrameLimit["src/components/terminal/FileTransferSheet.tsx#dispatchUploadChunk"]
  ClientFileTransferUploadAckIn02SessionProjection --> ClientFileTransferUploadErrorIn01ProgressTimeout["src/lib/file-transfer-session-runtime.ts#waitForUploadProgress"]
  ClientFileTransferDownloadIn01SocketDispatch --> ClientFileTransferDownloadErrorIn01StaleRequest["src/lib/file-transfer-session-runtime.ts#createFileTransferSessionRuntime"]
  ClientFileTransferDownloadIn06NativeStore --> ClientFileTransferDownloadErrorIn02NativeWriteFailure["src/components/terminal/FileTransferSheet.tsx#onDownloadComplete"]
  ClientFileTransferDownloadPersistOut02VerifiedStat --> ClientFileTransferDownloadErrorIn03SizeMismatch["src/components/terminal/FileTransferSheet.tsx#onDownloadComplete"]
  TerminalPage --> RemoteWindowContract["src/lib/plugin-remote-window/remote-window-contract.ts#TerminalRemoteWindowSlot"]
  TerminalPage --> RemoteWindowInputRuntime["src/contexts/session-context-remote-window-runtime.ts#sendRemoteWindowInputRuntime"]
  RemoteWindowOverlay --> WindowGroupLayout["src/components/terminal/WindowGroupLayout.tsx#WindowGroupLayout"]
  RemoteWindowOverlay --> RemoteScreenshotRuntime["src/lib/remote-screenshot-runtime.ts#createRemoteScreenshotRuntime"]
  RemoteWindowOverlay --> RemoteWindowMessageRuntime["src/lib/remote-window-message-runtime.ts#createRemoteWindowMessageRuntime"]
  RemoteWindowOverlay --> RemoteWindowDualStreamSwitch["src/lib/remote-window-dual-stream-runtime.ts#beginRemoteWindowDualStreamSwitch"]
  RemoteWindowDualStreamSwitch --> RemoteWindowMessageRuntime
  RemoteWindowOverlay --> RemoteWindowOverlayRuntime["src/lib/remote-window-overlay-runtime.ts#beginRemoteWindowStreamHandoff"]
  RemoteWindowOverlay --> RemoteWindowStreamQualityRuntime["src/contexts/session-context-remote-window-runtime.ts#updateRemoteWindowStreamQualityRuntime"]
  RemoteWindowOverlay --> RemoteWindowTouchAction["src/lib/remote-window-touch-action-runtime.ts#dispatchRemoteWindowTouchInputActionRuntime"]
  RemoteWindowTouchAction --> RemoteWindowInputRuntime["src/contexts/session-context-remote-window-runtime.ts#sendRemoteWindowInputRuntime"]
  RemoteWindowInputRuntime --> RemoteWindowMessageRuntime
  RemoteWindowStreamQualityRuntime --> RemoteWindowMessageRuntime
  RemoteWindowMessageRuntime --> RemoteWindowReceiver["src/contexts/session-context-remote-window-runtime.ts#requestRemoteWindowStreamStartRuntime"]
  Http --> AttachmentHttpIn01AuthenticatedRequest
  AttachmentHttpIn01AuthenticatedRequest --> AttachmentIn02DeliveryOwner
  AttachmentIn02DeliveryOwner --> AttachmentOut03DurableManifestAndAssets
  TerminalPage --> TerminalShellContract["src/lib/plugin-terminal-shell/terminal-shell-contract.ts#TerminalShellUiSlot"]
  TerminalShellUiPlugin --> StageShell["src/pages/TerminalPageStageShell.tsx + src/pages/terminal-page-shell-ui.tsx + src/pages/useTerminalPageShellActionsRuntime.ts + src/pages/useTerminalPageCopyRuntime.ts + src/pages/terminal-copy-selection.ts + src/pages/terminal-page-status-helpers.ts + src/pages/terminal-page-debug-helpers.ts + src/pages/terminal-page-render-keys.ts + src/pages/terminal-page-quickbar-adapters.ts + src/pages/terminal-keyboard-lift.ts + src/pages/TerminalPageQuickBarAssembly.tsx + src/pages/TerminalPageCopyMenu.tsx + src/pages/TerminalConnectionStatusStrip.tsx + src/lib/terminal-shell-skin.ts"]
  TerminalShellContract --> StageShell
  TerminalPage --> TerminalHeader["src/components/terminal/TerminalHeader.tsx#TerminalHeader"]
  TerminalPage --> QuickBarContract["src/lib/plugin-quickbar/quickbar-contract.ts#TerminalQuickBarSlot"]
  QuickBarContract --> TerminalQuickBarPluginRender["src/components/terminal/TerminalQuickBar.tsx#TerminalQuickBar"]
  TerminalHeader --> TerminalPage
  TerminalPage --> LayoutProfile["src/lib/terminal-layout-profile.ts"]
  LayoutProfile --> StageShell
  TerminalPage --> SessionDrawerContract["src/lib/plugin-session-drawer/session-drawer-contract.ts#TerminalSessionDrawerSlot"]
  TerminalPage --> FileBrowserContract["src/lib/plugin-file-browser/file-browser-contract.ts#TerminalFileBrowserSlot"]
  SessionDrawer --> TerminalPage
  TerminalView --> Renderer["src/lib/session-render-buffer-store.ts"]
  Renderer --> RenderGate["src/lib/session-render-gate.ts"]
```

`AttachmentHttpIn01AuthenticatedRequest` validates the daemon token and canonical attachment id before delegating to `AttachmentIn02DeliveryOwner`. The owner serializes mutations and verifies each asset before exposing `AttachmentOut03DurableManifestAndAssets`; client-specific pending state is retained in the manifest until that device acknowledges it.

`App -> SessionDrawerContract` and `TerminalPage -> SessionDrawerContract` carry the typed session drawer UI slot render contract; TerminalPage passes saved/Home server identity aliases alongside Relay endpoint and Session catalog facts only through that plugin-provided callback. `TerminalPage` canonicalizes exact endpoint or saved/Home endpoint-to-online-daemon bindings into one host rail. Session catalogs supply rows only and never infer daemon identity, so rtc-only history without stable binding remains separate.
`App -> FileBrowserContract` and `TerminalPage -> FileBrowserContract` carry the typed file browser UI slot render contract; TerminalPage keeps file transfer open/mode shell intent and sends existing file-transfer wire/session callbacks only through that plugin-provided callback, so `FileTransferSheet` is no longer imported or rendered directly by TerminalPage.
`App -> SettingsUpdateContract` and `SettingsPage -> SettingsUpdateContract` carry the typed settings update UI slot render contract; SettingsPage keeps settings/config/update state and callbacks and renders only through that plugin-provided callback, so `AppUpdateSection` is no longer imported or rendered directly by SettingsPage.
`App -> RemoteWindowContract` and `TerminalPage -> RemoteWindowContract` carry the typed remote window UI slot render contract; TerminalPage keeps remote window catalog/stream/quality/touch/session callbacks and renders only through that plugin-provided callback, so `RemoteWindowOverlay` is no longer imported or rendered directly by TerminalPage.
`App -> TerminalShellContract`, `TerminalPage -> TerminalShellContract`, `PluginHost -> TerminalShellUiPlugin`, and `TerminalShellUiPlugin -> StageShell` carry the typed terminal shell UI slot render contract; TerminalPage keeps status/stage/copy/quickbar-shell/network-banner projections as typed props and renders only through `renderTerminalShell`, so `TerminalConnectionStatusStrip`, `TerminalPageCopyMenu`, `TerminalPageStageShell`, `terminal-page-shell-ui`, `TerminalQuickBarShell`, and `TerminalNetworkBanner` are no longer imported or rendered directly by TerminalPage.
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
  TerminalPreviewGrid --> WindowGroupLayout["src/components/terminal/WindowGroupLayout.tsx#WindowGroupLayout"]
  WindowGroupLayout --> TerminalPreviewTile["src/components/terminal/TerminalPreviewGrid.tsx#preview-tile"]
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
  DaemonRuntime --> IdleSessionPublishIn01Request["src/server/terminal-session-activity-runtime.ts#publishSessionActivitiesRuntime"]
  ControlGateway --> SessionCatalog["src/server/daemon-session-catalog-runtime.ts#handleListSessionsMessageRuntime"]
  MuxHandshake --> IdleSessionMuxOpenIn01ControlTrigger["src/server/terminal-message-control-runtime.ts#handleMuxChannelOpenedMessageRuntime"]
  SessionCatalog --> IdleSessionPublishIn01Request
  IdleSessionMuxOpenIn01ControlTrigger --> IdleSessionPublishIn01Request
  IdleSessionPublishIn01Request --> IdleActivityClassifierIn01MirrorWalk["src/server/terminal-session-activity-runtime.ts#classifySessionActivities"]
  Mirror --> IdleSessionPublishIn01Request
  IdleActivityClassifierIn01MirrorWalk --> IdleActivityClassifierOut01ClassifiedFacts["src/server/terminal-session-activity-runtime.ts#classifySessionActivities"]
  IdleActivityClassifierOut01ClassifiedFacts --> IdleSessionBroadcastOut01TransportPublish["src/server/terminal-transport-runtime.ts#sendTransportMessage"]
  IdleSessionBroadcastOut01TransportPublish --> TransportSend
  Runtime --> Bridge["src/server/terminal-bridge-runtime.ts"]
  Bridge --> MuxHandshake["packages/shared/src/connection/protocol.ts#TerminalMuxServerFrame"]
  MuxHandshake --> ChannelRegistry["src/server/terminal-runtime.ts#mux channel registry"]
  ChannelRegistry --> Runtime
  Runtime --> Message["src/server/terminal-message-runtime.ts"]
  Message --> ChannelRegistry
  Message --> Mirror["src/server/terminal-mirror-runtime.ts"]
  Message --> InputQueue["src/server/daemon-input-queue-runtime.ts#createDaemonInputQueueRuntime"]
  InputQueue --> ReliableInputAck["src/server/terminal-reliable-input-ack.ts#createReliableInputAckCache"]
  InputQueue --> Backend["src/server/terminal-control-runtime.ts#writeBackendInputGroup"]
  Backend --> Tmux
  Mirror --> Capture["src/server/terminal-mirror-capture.ts (daemon.mirror_writer)"]
  Mirror --> BufferPublisher["src/server/daemon-buffer-publisher-runtime.ts#createDaemonBufferPublisherRuntime"]
  BufferPublisher --> TransportSend["src/server/terminal-transport-runtime.ts#sendText"]
  Capture --> PerformanceTrace["src/lib/terminal-performance-trace.ts"]
  Mirror --> PerformanceTrace
  TransportSend --> PerformanceTrace
  Message --> ControlGateway["src/server/daemon-control-gateway-runtime.ts"]
  Message --> AttachmentMessageIn01Owner["src/server/terminal-attachment-message-runtime.ts#createTerminalAttachmentMessageRuntime"]
  AttachmentMessageIn01Owner --> AttachmentIn02DeliveryOwner["src/server/attachment-delivery-runtime.ts#createAttachmentDeliveryRuntime"]
  Message --> DaemonFileTransferMessageIn01Owner["src/server/terminal-file-transfer-message-runtime.ts#createTerminalFileTransferMessageRuntime"]
  DaemonFileTransferMessageIn01Owner --> DaemonFileTransferUploadIn02RuntimeFacade
  ControlGateway --> ControlCenter["src/server/daemon-control-center-runtime.ts"]
  ControlCenter --> Control["src/server/terminal-message-control-runtime.ts"]
  ControlCenter --> Schedule["src/server/terminal-schedule-runtime.ts"]
  ControlCenter --> Tmux["src/server/terminal-control-runtime.ts"]
  Message --> Control["src/server/terminal-message-control-runtime.ts"]
  Control --> SessionCatalog["src/server/daemon-session-catalog-runtime.ts#buildSessionsCatalogPayload"]
  Control --> Tmux["src/server/terminal-control-runtime.ts"]
  Control --> Schedule["src/server/terminal-schedule-runtime.ts"]
  DaemonFileTransferUploadIn01MessageDispatch["src/server/terminal-file-transfer-message-runtime.ts#createTerminalFileTransferMessageRuntime"] --> DaemonFileTransferUploadIn02RuntimeFacade["src/server/terminal-file-transfer-runtime.ts#createTerminalFileTransferRuntime"]
  DaemonFileTransferUploadIn02RuntimeFacade --> DaemonFileTransferUploadIn03CumulativeAckOwner["src/server/terminal-file-transfer-binary-runtime.ts#handleFileUploadChunk"]
  DaemonFileTransferUploadIn02RuntimeFacade --> DaemonFileTransferUploadEndIn04ExactCompletionOwner["src/server/terminal-file-transfer-binary-runtime.ts#handleFileUploadEnd"]
  DaemonFileTransferUploadIn03CumulativeAckOwner --> DaemonFileTransferUploadProgressOut01CumulativeAck
  DaemonFileTransferUploadIn03CumulativeAckOwner --> DaemonFileTransferUploadErrorOut01ChunkRejected
  DaemonFileTransferUploadEndIn04ExactCompletionOwner --> DaemonFileTransferUploadSuccessOut01Complete
  DaemonFileTransferUploadEndIn04ExactCompletionOwner --> DaemonFileTransferUploadErrorOut02CompletionRejected
  DaemonFileTransferUploadProgressOut01CumulativeAck --> DaemonFileTransferTransportOut01Send["src/server/terminal-transport-runtime.ts#sendMessage"]
  DaemonFileTransferUploadSuccessOut01Complete --> DaemonFileTransferTransportOut01Send
  DaemonFileTransferUploadErrorOut01ChunkRejected --> DaemonFileTransferTransportOut01Send
  DaemonFileTransferUploadErrorOut02CompletionRejected --> DaemonFileTransferTransportOut01Send
  DaemonFileTransferTransportOut01Send --> TransportSend
  Control --> Screenshot["src/server/remote-screenshot-daemon.ts"]
  Control --> RemoteWindowStream["src/server/remote-window-stream-daemon.ts#createRemoteWindowStreamDaemonRuntime"]
  RemoteWindowStream --> RemoteWindowCapture["src/server/remote-window-stream-daemon.ts#startScreenCaptureKitFrameSource"]
  RemoteWindowCapture --> RemoteWindowMedia["src/server/remote-window-stream-daemon.ts#startStream"]
  RemoteWindowStream --> RemoteWindowInput["src/server/remote-window-stream-daemon.ts#injectInput"]
  RemoteWindowStream --> RemoteWindowCleanup["src/server/remote-window-stream-daemon.ts#stopStream"]
  Server --> Http["src/server/terminal-http-runtime.ts"]
  Http --> DebugObservabilityIn01LogIngest["src/server/terminal-http-runtime.ts#/debug/runtime/logs"]
  Http --> DebugObservabilityIn02SnapshotIngest["src/server/terminal-http-runtime.ts#/debug/runtime/snapshot"]
  Http --> DebugObservabilityIn03ControlLease["src/server/terminal-http-runtime.ts#/debug/runtime/control"]
  DebugObservabilityIn01LogIngest --> DebugObservabilityOut01Accepted["src/server/terminal-http-runtime.ts#serveJson"]
  DebugObservabilityIn01LogIngest --> DebugObservabilityError01Rejected["src/server/terminal-http-runtime.ts#serveJson"]
  DebugObservabilityIn02SnapshotIngest --> DebugObservabilityOut01Accepted
  DebugObservabilityIn02SnapshotIngest --> DebugObservabilityError01Rejected
  DebugObservabilityIn03ControlLease --> DebugObservabilityOut01Accepted
  DebugObservabilityIn03ControlLease --> DebugObservabilityError01Rejected
  Server --> DaemonDebugHub["src/server/runtime-debug-store.ts#RuntimeDebugStore + src/server/terminal-debug-runtime.ts#createTerminalDebugRuntime"]
  SharedNodeContract["packages/shared/src/terminal/node-contract.ts#FoundationNode/DataNode/ControlNode"] --> SharedDebugContract["packages/shared/src/terminal/debug-contract.ts#DebugHub/DebugRegistry/SnapshotCoordinator/BoundedDebugEventStore/DebugPermissionService"]
  SharedNodeContract --> DaemonDebugHub
  SharedDebugContract --> DaemonDebugHub
  Server --> Transport["src/server/terminal-transport-runtime.ts"]
  Server --> Relay["src/server/relay-client.ts"]
  Server --> RelayHostControl["src/server/relay-client.ts#createTraversalRelayHostClient"]
  RelayHostControl --> DaemonEndpointDirectory["src/server/daemon-connection-endpoint-runtime.ts#buildDaemonConnectionEndpointCandidates"]
  DaemonEndpointDirectory --> RelayDirectoryPublish["src/server/relay-client.ts#publishRelayDirectoryUpdate"]
  RelayDirectoryPublish --> Relay
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
  Release["scripts/prepare-global-daemon-release.sh"] --> DaemonReleaseOut01StageRuntime["scripts/prepare-global-daemon-release.sh#stage_runtime"]
  DaemonReleaseOut01StageRuntime --> DaemonReleaseOut02VerifyDeterminism["scripts/prepare-global-daemon-release.sh#verify_deterministic_archive"]
  DaemonReleaseOut02VerifyDeterminism --> DaemonReleaseOut03ArchiveArtifact["scripts/prepare-global-daemon-release.sh#create_deterministic_archive"]
  DaemonReleaseOut03ArchiveArtifact --> DaemonReleaseOut04NormalizeMetadata["scripts/prepare-global-daemon-release.sh#normalize_release_tree_metadata"]
  DaemonReleaseOut02VerifyDeterminism --> Runtime
  Release --> Install["scripts/install-global-daemon-cli.sh"]
  Install --> GlobalBin["~/.local/bin/zterm-daemon"]
  Npm["scripts/prepare-daemon-npm-package.mjs"] --> PackageBin["package/bin/zterm-daemon"]
  Npm --> WinShell
  AppSdkPrebuildGate["package.json#prebuild"] --> AppSdkPackageGate["package.json#test:appsdk-verify"]
  AppSdkCiGate[".github/workflows/ci.yml#appsdk-governance"] --> AppSdkPackageGate
  AppSdkReleaseGate[".github/workflows/android-release.yml#Verify AppSDK binary and record graph"] --> AppSdkPackageGate
  AppSdkPackageGate --> AppSdkBinaryPreflight["scripts/verify-appsdk-binary.mjs#verifyPinnedAppSdkBinary"]
  AppSdkBinaryPreflight --> AppSdkRecordGraphVerify["same absolute AppSDK binary#verify"]
```

The AppSDK branch is a governance control path. Prebuild, CI, and Android
release converge on `test:appsdk-verify`; the preflight resolves one executable,
validates project/lock version and digest, and invokes record verification
through that same absolute path. It has no daemon, terminal, Active, or
Protected business-resource edge.

## Global Resource Flow

The executable resource graph is declared in `docs/resource-registry.json`; the review surface is `docs/resource-map.md`. Project module ownership is declared in `docs/module-registry.json` and reviewed in `docs/modules/project-modules.md`. Allowed cross-module resource edges are declared in `docs/edge-registry.json`. Mainline call-map edges in `docs/wiki/mainline-call-map.json` bind each lifecycle edge to `resource_from`, `resource_to`, `via_resources`, and `relation_status`.

```mermaid
flowchart TD
  RuntimeHome["resource.runtime_home"] --> DaemonArtifact["resource.daemon_runtime_artifact"]
  DaemonArtifact --> DaemonProcess["resource.daemon_process"]
  DaemonProcess --> DaemonConnectionGateway["resource.daemon_connection_gateway"]
  DaemonConnectionGateway --> RelayControlConnection["resource.relay_control_connection"]
  RelayControlConnection --> RelayAccountDirectory["resource.relay_account_directory"]
  RelayAccountDirectory --> TransportTarget
  DaemonProcess --> TerminalBackend["resource.terminal_backend"]
  DaemonProcess --> ObservabilityChannel["resource.observability_channel"]
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
  MirrorStore --> ClientSparseBuffer["client.sparse_buffer / resource.client_sparse_buffer"]
  ClientSparseBuffer --> RendererWindow["resource.renderer_window"]
  RendererWindow --> DomRenderer["client.dom_renderer / DOM projection"]
  DomRenderer --> TerminalShell["client.terminal_shell / terminal shell projection"]
  TerminalShell --> UiProjection["resource.ui_projection"]
  UiProjection --> PreviewSelection["resource.session_preview_selection"]
  UiProjection --> PreviewMode["resource.session_preview_mode"]
  UiProjection --> RemoteWindowContract["resource.remote_window_ui_contract"]
  RemoteWindowContract --> RemoteWindowOverlay
  UiProjection --> RemoteWindowOverlay["resource.remote_window_overlay"]
  RemoteWindowOverlay --> RemoteWindowTouchActionResource["resource.remote_window_touch_action"]
  RemoteWindowTouchActionResource --> RemoteWindowStream["resource.remote_window_stream"]
  RemoteWindowStream --> DaemonProcess
  PreviewSelection --> OpenTab
  PreviewMode --> UiProjection
  OpenTab["resource.open_tab"] --> ActiveSession["resource.active_session"]
  ActiveSession --> SessionTransport
  PlatformInput["resource.platform_input_channel"] --> ReliableInputQueue["resource.client_reliable_input_queue"]
  ReliableInputQueue --> SessionTransport
  ClientFileBrowser["resource.client_file_browser"] --> TargetMuxRequest["resource.target_mux_request"]
  TargetMuxRequest --> DaemonTargetTransport
  ClientFileBrowser --> ClientNativeFileStore["resource.client_native_file_store"]
  TransportSubscriber --> FileTransfer["resource.file_transfer"]
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
| Client transport lifecycle | `packages/shared/src/connection/protocol.ts`, `src/contexts/SessionContext.tsx`, `src/contexts/session-context-session-orchestration-runtime.ts`, `src/contexts/session-context-session-runtime.ts`, `src/contexts/session-context-activity-runtime.ts`, `src/contexts/session-context-transport-runtime.ts`, `src/contexts/session-context-transport-orchestration-runtime.ts`, `src/contexts/session-context-transport-open-runtime.ts`, `src/contexts/session-context-socket-message-runtime.ts`, `src/contexts/session-context-lifecycle.ts#selectNextPassiveVisibleRefreshCandidate`, `src/contexts/session-transport-open-helpers.ts`, `src/lib/session-transport-runtime.ts`; network-generation probes enumerate physical targets through `TargetTransportAccessors -> TargetTransportStoreEnumeration`, while valid inbound frames settle only their exact socket generation through `TargetMuxFrameLifecycle -> TargetNetworkActivityBinding -> TargetNetworkProbe`; target mux nodes are `TargetTransportRuntime`, `MuxHandshake`, `TerminalTransportError01TargetFailure`, `ChannelRuntime`, `ChannelMessageSend`, `ChannelDemux`, `TerminalChannelClosedIn01CloseSignal`, `TerminalChannelClosedIn02ControlStatusDecision`, and `TerminalTargetControlOut01ListSessions`; mux readiness and active/live channel-close control-unavailable failures record route health exactly once, retire the exact physical generation, then schedule one target rebuild; WebRTC route diagnostics include metadata-only selected ICE pair projection through `src/lib/traversal/socket.ts` and `src/pages/TerminalPageDebugOverlay.tsx` |
| Terminal body receive/apply/render | `src/contexts/session-context-socket-message-runtime.ts#handleSocketServerMessageRuntime`, `src/contexts/session-context-buffer-runtime.ts#applyIncomingBufferSyncRuntime`, `src/lib/buffer-frame-assembly/session-buffer-frame-assembly.ts#assembleBufferSyncFrameChunk`, `src/contexts/session-context-buffer-runtime.ts#applyResolvedBufferSyncPayloadRuntime`, `src/lib/session-render-gate.ts#scheduleCommit`, `src/lib/session-render-buffer-store.ts`, `src/components/TerminalView.tsx`, `src/components/terminal/VisibleRow.tsx`, `src/components/terminal/TerminalPreviewRow.tsx`, `src/components/useMirrorFixedZoomPan.ts`, `packages/shared/src/terminal/cell-render.ts`, `packages/shared/src/terminal/theme.ts` |
| Official Herdr single-terminal backend | `src/components/tmux/TmuxSessionPickerSheet.tsx`, `src/lib/tmux-sessions.ts`, `packages/shared/src/connection/protocol.ts`, `src/server/server.ts`, `src/server/herdr-backend-runtime.ts`, `src/server/herdr-process-transport.ts`, `src/server/herdr-backend.ts`, `src/server/herdr-frame-canonicalizer.ts`, `src/server/terminal-mirror-capture.ts`, `src/server/terminal-control-runtime.ts` |
| Terminal performance observer | `src/lib/terminal-performance-trace.ts`, `src/server/terminal-debug-runtime.ts`, `src/lib/runtime-debug.ts`, `src/lib/runtime-debug-http-exporter.ts`, `src/server/terminal-http-runtime.ts` (`/debug/runtime/logs`, `/debug/runtime/snapshot`, `/debug/runtime/control`); bounded HTTP observability export is independent of terminal mux/session transport; metadata only, no terminal text/cells |
| Terminal shell and panes | `src/pages/TerminalPageStageShell.tsx`, `src/pages/terminal-page-shell-ui.tsx`, `src/pages/useTerminalPageShellActionsRuntime.ts`, `src/pages/useTerminalPageCopyRuntime.ts`, `src/pages/terminal-copy-selection.ts`, `src/pages/terminal-page-status-helpers.ts`, `src/pages/terminal-page-debug-helpers.ts`, `src/pages/terminal-page-render-keys.ts`, `src/pages/terminal-page-quickbar-adapters.ts`, `src/pages/terminal-keyboard-lift.ts`, `src/pages/TerminalPageQuickBarAssembly.tsx`, `src/pages/TerminalPageCopyMenu.tsx`, `src/pages/TerminalConnectionStatusStrip.tsx`, `src/lib/terminal-shell-skin.ts`, `src/hooks/useTerminalWorkspace.ts`, `src/lib/workspace-persistence.ts`, `src/components/terminal/TerminalHeader.tsx`, `src/components/terminal/TerminalQuickBar.tsx` |
| Remote window stream projection | `packages/shared/src/connection/protocol.ts`, `src/server/remote-window-stream-daemon.ts`, `src/server/terminal-message-runtime.ts`, `src/server/server.ts`, `src/server/terminal-file-transfer-binary-runtime.ts`, `src/components/terminal/RemoteWindowOverlay.tsx`, `src/lib/remote-window-overlay-runtime.ts`, `src/lib/remote-window-touch-action-runtime.ts`, `src/lib/remote-window-message-runtime.ts`, `src/lib/remote-window-receiver-runtime.ts`, `src/lib/remote-window-video-quality.ts`, `src/contexts/session-context-remote-window-runtime.ts`, `src/contexts/session-context-transfer-runtime.ts`, `docs/decisions/2026-07-19-remote-window-stream-truth.md`; ScreenCaptureKit/WebRTC bindings are anchored under `RemoteWindowMessageRuntime`, `RemoteWindowReceiver`, `RemoteWindowStreamQualityRuntime`, `RemoteWindowTouchAction`, `RemoteWindowCapture`, `RemoteWindowMedia`, `RemoteWindowInput`, and `RemoteWindowCleanup`; Android fullscreen projection now owns collapsed same-app picker rows plus in-video sibling window switcher with transactional start-next/attach-commit/stop-old handoff and explicit cleanup error projection, one-in-flight sibling thumbnails that refresh only ready snapshots and keep failed or loading requests terminal until a new request identity, default safe-boundary placement and reachable close controls, default-collapsed iTerm2 picker grouping, daemon-wide 60-second target catalog cache keyed by daemon identity, aspect-fit drawing plus default remote target `window-resize` fill request on fullscreen entry, source-aspect floating resize with toolbar reachability cap, daemon-frame-aspect receiver projection after stream start, IME bottom-inset fullscreen padding plus QuickBar chrome auto-pan, unzoomed touch tap-to-pointer and tuning-scaled release-time gesture input plus wheel pixel-scroll input even while IME inset is present, zoomed-only local single-finger pan, target-locked two-finger tuning-scaled remote scroll with optional direction inversion, supported app-window-only input context through the touch/action dispatch boundary, ready-checked persistent macOS input helper warmup during interactive stream start without focus/input, focus-aware image paste routing, floating-preview low bitrate, desktop-area-proportional stream quality defaults, adaptive network quality caps, and explicit max frame-rate request values; remaining live gates are Android physical-send trace and iTerm2-pane stream/input proof |
| Terminal session group layout | `src/lib/terminal-layout-profile.ts`, `src/lib/session-group-viewport.ts`, `src/pages/TerminalPage.tsx#resolveTerminalSessionGroupActiveSessionProjection`, `src/pages/TerminalPageStageShell.tsx`, `docs/features/terminal-session-group-layout.md`, `docs/testing/terminal-session-group-layout-test-design.md` |
| Session drawer (multi-host) | `src/lib/plugin-session-drawer/session-drawer-contract.ts` (typed slot contract), `src/lib/plugin-host/session-drawer-ui-plugin.tsx` (slot provider), `src/components/terminal/TerminalSessionDrawer.tsx` (UI), `src/App.tsx` (slot consumer), `src/pages/TerminalPage.tsx` (`drawerServerIdentityAliases` canonicalizes live/session-group/Relay endpoint identity; `drawerSessions` projects hostKey/hostLabel + opened-first ordering) |
| File browser UI plugin | `src/lib/plugin-file-browser/file-browser-contract.ts` (typed slot contract), `src/lib/plugin-host/file-browser-ui-plugin.tsx` (slot provider), `src/components/terminal/FileTransferSheet.tsx` (UI), `src/App.tsx` (slot consumer), `src/pages/TerminalPage.tsx` (shell open/mode projection and file-transfer callback consumer only) |
| Settings update UI plugin | `src/lib/plugin-settings-update/settings-update-contract.ts` (typed slot contract), `src/lib/plugin-host/settings-update-ui-plugin.tsx` (slot provider), `src/components/settings/AppUpdateSection.tsx` (UI), `src/App.tsx` (slot consumer), `src/pages/SettingsPage.tsx` (settings/config/update projection and callback consumer only) |
| Remote window UI plugin | `src/lib/plugin-remote-window/remote-window-contract.ts` (typed slot contract), `src/lib/plugin-host/remote-window-ui-plugin.tsx` (slot provider), `src/components/terminal/RemoteWindowOverlay.tsx` (UI), `src/App.tsx` (slot consumer), `src/pages/TerminalPage.tsx` (remote window stream/catalog/session/action callback consumer only) |
| Quickbar UI plugin | `src/lib/plugin-quickbar/quickbar-contract.ts` (typed slot contract), `src/lib/plugin-host/quickbar-ui-plugin.tsx` (slot provider), `src/components/terminal/TerminalQuickBar.tsx` (UI), `src/App.tsx` (slot consumer), `src/pages/TerminalPage.tsx` (quickbar action projection and callback consumer only) |
| Terminal shell UI plugin | `src/lib/plugin-terminal-shell/terminal-shell-contract.ts` (typed slot contract), `src/lib/plugin-host/terminal-shell-ui-plugin.tsx` (slot provider), `src/pages/TerminalConnectionStatusStrip.tsx`, `src/pages/TerminalPageCopyMenu.tsx`, `src/pages/TerminalPageStageShell.tsx`, `src/pages/terminal-page-shell-ui.tsx`, `src/App.tsx` (slot consumer), `src/pages/TerminalPage.tsx` (terminal shell projection and callback consumer only) |
| Session quick preview | `src/lib/session-preview-selection.ts`, `src/lib/session-preview-gesture.ts`, `src/components/terminal/TerminalPreviewGrid.tsx`, `src/pages/TerminalPageStageShell.tsx`; secondary title/body tap promotes primary through `WindowGroupLayout`, secondary previews use compact local typography, and body drag remains local preview scroll/pan |
| Daemon runtime | `src/server/server.ts`, `src/server/terminal-daemon-runtime.ts`, `src/server/terminal-runtime.ts`, `src/server/terminal-message-runtime.ts`, `src/server/terminal-attachment-message-runtime.ts`, `src/server/daemon-input-queue-runtime.ts`, `src/server/terminal-reliable-input-ack.ts`, `src/server/terminal-mirror-runtime.ts`, `src/server/terminal-message-control-runtime.ts`, `src/server/daemon-session-catalog-runtime.ts`, `src/server/terminal-transport-runtime.ts`, `src/server/remote-window-stream-daemon.ts` |
| Daemon control edges | `src/server/terminal-control-runtime.ts`, `src/server/terminal-file-transfer-runtime.ts`, `src/server/terminal-schedule-runtime.ts`, `src/server/remote-screenshot-daemon.ts`, `src/server/remote-window-stream-daemon.ts`, `src/server/terminal-http-runtime.ts`, `src/server/daemon-session-catalog-runtime.ts` |
| Daemon attachment delivery | `src/server/attachment-delivery-runtime.ts#createAttachmentDeliveryRuntime` -> `src/server/terminal-http-runtime.ts#createTerminalHttpRuntime` -> `scripts/zterm-send-image.mjs`; transport-message pending/history/asset/receipt projection is owned by `src/server/terminal-attachment-message-runtime.ts#createTerminalAttachmentMessageRuntime` and only routed by `terminal-message-runtime.ts`; durable manifests provide per-device missed-push recovery, preview-first reads, receipts, and 48-hour cleanup. |
| Daemon CLI | `scripts/zterm-daemon.sh`, `scripts/windows/zterm-daemon.ps1`, `scripts/install-global-daemon-cli.sh`, `scripts/prepare-global-daemon-release.sh`, `scripts/prepare-daemon-npm-package.mjs` |
| Release/update | `contracts/app-version.json`, `scripts/app-version.mjs`, `native/android/app/build.gradle`, `scripts/build-android-debug.sh`, `scripts/prepare-update-bundle.mjs`, `scripts/verify-update-bundle.mjs`, `scripts/verify-release-assets.mjs`; normal `N`, rollback `N.1`, and next normal `N+1` occupy strictly increasing Android version-code slots; Relay public update route and future `RelayPeerLease` idle-resume resource are authored in `src/traversal-relay/server.ts` and packaged by `scripts/prepare-relay-server-npm-package.mjs` with `ZTERM_TRAVERSAL_UPDATES_DIR` |
| Worker wiki generator | `scripts/build-function-wiki.mjs`, `docs/wiki/daemon.md`, `docs/wiki/cli.md`, `docs/wiki/mainline-source.md` |
| Global resource truth | `docs/resource-registry.json`, `docs/resource-map.md`, `docs/testing/resource-truth-test-design.md` |
| Project module and edge truth | `docs/module-registry.json`, `docs/edge-registry.json`, `docs/modules/project-modules.md`, `docs/testing/module-edge-registry-test-design.md` |

## Gate

- `src/lib/feature-registry-truth.test.ts`
- `src/lib/function-wiki-truth.test.ts`
- `src/lib/resource-registry-truth.test.ts`
- `src/lib/module-registry-truth.test.ts`
- `src/lib/edge-registry-truth.test.ts`
- `src/lib/function-map-resource-truth.test.ts`
- `src/lib/mainline-resource-call-map.test.ts`
- `pnpm run test:feature-registry`
