# Project Modules Wiki

Worker-readable module map. Generated diagram: `docs/wiki/generated/modules.html`.

## Owner

- `feature_id`: `mainline_source.android`
- Module manifest: `docs/module-registry.json`
- Edge manifest: `docs/edge-registry.json`
- Resource manifest: `docs/resource-registry.json`
- Human review: `docs/modules/project-modules.md`
- Test design: `docs/testing/module-edge-registry-test-design.md`

## Module Flow

```mermaid
flowchart TD
  Product["project.product_runtime"] --> Client["client.runtime"]
  Product --> Daemon["daemon.runtime"]
  Product --> Shared["shared.contract"]
  Product --> Relay["relay.runtime"]
  Product --> Release["release.runtime"]
  Product --> Observability["observability.governance"]
  Release --> DaemonEntry["daemon.runtime_entry"]
  DaemonEntry --> DaemonGateway["daemon.connection_gateway"]
  DaemonEntry --> Backend["daemon.terminal_backend"]
  Backend --> Mirror["daemon.mirror_store"]
  DaemonGateway --> Subscriber["daemon.transport_subscriber"]
  Mirror --> Subscriber
  Client --> SessionRuntime["client.session_runtime"]
  SessionRuntime --> ClientConnection["client.daemon_connection"]
  ClientConnection --> ChannelMux["client.terminal_channel_mux"]
  ChannelMux --> Subscriber
  Mirror --> BufferStore["client.buffer_store"]
  BufferStore --> Renderer["client.renderer_window"]
  Renderer --> AppShell["client.app_shell"]
  AppShell --> RemoteOverlay["client.remote_window_overlay"]
  RemoteOverlay --> RemoteStream["daemon.remote_window_stream"]
  Relay --> PeerLease["relay.peer_lease"]
  PeerLease --> ClientConnection
  Observability --> Debug["observability.debug_channel"]
```

## Rules

- Resource registry defines resource truth.
- Module registry groups resources into runtime ownership.
- Edge registry is the only cross-module connection list.
- Function map binds feature-local code after module/edge truth exists.
- Client connection owns one physical connection per daemon target.
- Terminal session is a mux channel, not a socket owner.
- Daemon must not store client active tab, foreground/background, viewport, renderer, or UI truth.
- Relay peer lease is route/signaling truth only.

## Gates

- `src/lib/module-registry-truth.test.ts`
- `src/lib/edge-registry-truth.test.ts`
- `src/lib/resource-registry-truth.test.ts`
- `src/lib/function-map-resource-truth.test.ts`
- `src/lib/mainline-resource-call-map.test.ts`
- `pnpm run test:feature-registry`
