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
  App --> Connections["src/pages/ConnectionsPage.tsx"]
  App --> TerminalPage["src/pages/TerminalPage.tsx"]
  TerminalPage --> TerminalView["src/components/TerminalView.tsx"]
  TerminalPage --> QuickBar["src/components/terminal/TerminalQuickBar.tsx"]
  TerminalPage --> StageShell["src/pages/TerminalPageStageShell.tsx"]
  TerminalPage --> LayoutProfile["src/lib/terminal-layout-profile.ts"]
  LayoutProfile --> StageShell
  TerminalPage --> SessionDrawer["src/components/terminal/TerminalSessionDrawer.tsx"]
  SessionDrawer --> TerminalPage
  TerminalView --> Renderer["src/lib/session-render-buffer-store.ts"]
  Renderer --> RenderGate["src/lib/session-render-gate.ts"]
```

## Daemon Mainline

```mermaid
flowchart TD
  CLI["scripts/zterm-daemon.sh"] --> Server["src/server/server.ts"]
  Server --> DaemonRuntime["src/server/terminal-daemon-runtime.ts"]
  Server --> Runtime["src/server/terminal-runtime.ts"]
  Runtime --> Bridge["src/server/terminal-bridge-runtime.ts"]
  Runtime --> Message["src/server/terminal-message-runtime.ts"]
  Message --> Mirror["src/server/terminal-mirror-runtime.ts"]
  Mirror --> Capture["src/server/terminal-mirror-capture.ts"]
  Message --> Control["src/server/terminal-message-control-runtime.ts"]
  Control --> Tmux["src/server/terminal-control-runtime.ts"]
  Control --> Schedule["src/server/terminal-schedule-runtime.ts"]
  Control --> Transfer["src/server/terminal-file-transfer-runtime.ts"]
  Control --> Screenshot["src/server/remote-screenshot-daemon.ts"]
  Server --> Http["src/server/terminal-http-runtime.ts"]
  Server --> Debug["src/server/terminal-debug-runtime.ts"]
  Server --> Transport["src/server/terminal-transport-runtime.ts"]
  Server --> Relay["src/server/relay-client.ts"]
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
  SessionTransport["resource.session_transport"] --> TransportSubscriber["resource.transport_subscriber"]
  TransportSubscriber --> MirrorStore["resource.mirror_store"]
  MirrorStore --> ClientSparseBuffer["resource.client_sparse_buffer"]
  ClientSparseBuffer --> RendererWindow["resource.renderer_window"]
  RendererWindow --> UiProjection["resource.ui_projection"]
  OpenTab["resource.open_tab"] --> ActiveSession["resource.active_session"]
  ActiveSession --> SessionTransport
  PlatformInput["resource.platform_input_channel"] --> SessionTransport
  DaemonInputQueue["resource.daemon_input_queue"] --> BackendSession
  ReleaseArtifact["resource.release_update_artifact"] --> DaemonArtifact
  DebugChannel["resource.debug_channel"] -. observe only .-> DaemonProcess
```

## Published Source Surfaces

| surface | files |
| --- | --- |
| Android app entry | `src/main.tsx`, `src/App.tsx`, `src/pages/ConnectionsPage.tsx`, `src/pages/TerminalPage.tsx` |
| Client transport lifecycle | `src/contexts/SessionContext.tsx`, `src/contexts/session-context-session-orchestration-runtime.ts`, `src/contexts/session-context-session-runtime.ts`, `src/contexts/session-context-activity-runtime.ts`, `src/contexts/session-context-transport-orchestration-runtime.ts`, `src/contexts/session-context-transport-open-runtime.ts`, `src/contexts/session-transport-open-helpers.ts` |
| Terminal renderer | `src/components/TerminalView.tsx`, `src/lib/session-render-buffer-store.ts`, `src/lib/session-render-gate.ts` |
| Terminal shell and panes | `src/pages/TerminalPageStageShell.tsx`, `src/hooks/useTerminalWorkspace.ts`, `src/components/terminal/TerminalQuickBar.tsx` |
| Terminal session group layout | `src/lib/terminal-layout-profile.ts`, `src/pages/TerminalPageStageShell.tsx`, `docs/features/terminal-session-group-layout.md`, `docs/testing/terminal-session-group-layout-test-design.md` |
| Session drawer (multi-host) | `src/components/terminal/TerminalSessionDrawer.tsx` (UI), `src/pages/TerminalPage.tsx` (hostKey/hostLabel + opened-first ordering in `drawerSessions` useMemo) |
| Daemon runtime | `src/server/server.ts`, `src/server/terminal-daemon-runtime.ts`, `src/server/terminal-runtime.ts`, `src/server/terminal-message-runtime.ts`, `src/server/terminal-mirror-runtime.ts`, `src/server/terminal-message-control-runtime.ts`, `src/server/terminal-transport-runtime.ts` |
| Daemon control edges | `src/server/terminal-control-runtime.ts`, `src/server/terminal-file-transfer-runtime.ts`, `src/server/terminal-schedule-runtime.ts`, `src/server/remote-screenshot-daemon.ts`, `src/server/terminal-http-runtime.ts` |
| Daemon CLI | `scripts/zterm-daemon.sh`, `scripts/windows/zterm-daemon.ps1`, `scripts/install-global-daemon-cli.sh`, `scripts/prepare-global-daemon-release.sh`, `scripts/prepare-daemon-npm-package.mjs` |
| Release/update | `scripts/build-android-debug.sh`, `scripts/prepare-update-bundle.mjs`, `scripts/verify-release-assets.mjs` |
| Worker wiki generator | `scripts/build-function-wiki.mjs`, `docs/wiki/daemon.md`, `docs/wiki/cli.md`, `docs/wiki/mainline-source.md` |
| Global resource truth | `docs/resource-registry.json`, `docs/resource-map.md`, `docs/testing/resource-truth-test-design.md` |

## Gate

- `src/lib/feature-registry-truth.test.ts`
- `src/lib/function-wiki-truth.test.ts`
- `src/lib/resource-registry-truth.test.ts`
- `src/lib/function-map-resource-truth.test.ts`
- `src/lib/mainline-resource-call-map.test.ts`
- `pnpm run test:feature-registry`
