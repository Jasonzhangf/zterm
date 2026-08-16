# ZTerm Runtime Architecture v2 Test Design

Design ID: `ZTERM-ARCH-V2-DESIGN-001`
Phase: 1-7 production ownership slices; AppSDK active-version and lifecycle
state are authoritative in `.appsdk/project.json` and `.appsdk/records/**`
active-v2 is implemented but not yet promoted/frozen; see `.appsdk/records/**`
Experiment: `playground/experiments/zterm-runtime-architecture-v2`

## Lifecycle

1. Governance goal confirmed and AppSDK draft verified.
2. Foundation contracts authored only in Playground.
3. Focused positive/negative contract tests prove typed plane separation,
   lifecycle, debug bounds, snapshots, and plugin capability gating.
4. Gate is wired to Android `prebuild` and CI.
5. Later slices promote these contracts into registered production modules.

## Whitebox Tests

- Node lifecycle: `start()` moves to running, `stop(reason)` disposes owned
  subscriptions and unregisters debug producers.
- Data/control planes: `DataNode.accept()` cannot receive `ControlCommand`;
  `ControlNode.execute()` cannot receive `DataEnvelope`.
- Debug registry: duplicate node producer IDs fail fast.
- Debug hub: bounded subscribers, bounded event history, drop counters, and
  listener failures cannot alter a data/control result.
- Snapshot coordinator: generation and sequence increment, and payloads are
  deeply frozen.
- Plugin host: missing required capabilities fail before plugin creation;
  undeclared capability access fails before activation.

## Blackbox Tests

- `AdjacentDataLink` sends through adjacent typed nodes only and never touches
  control or debug consumers.
- `CommandOwnerRegistry` has exactly one owner per command type and returns an
  explicit unknown-command result.
- `PluginHost` lifecycle state transitions are deterministic and plugin stop
  cleans debug producers.

## Gate Mapping

| Gate | Command | Covered By |
| --- | --- | --- |
| `node_contract` | `pnpm run test:runtime-architecture-v2` | all Phase 1 tests |
| `typecheck` | `pnpm exec tsc -p tsconfig.json --noEmit` | experiment source + tests |
| `module_ownership` | `pnpm run test:feature-registry` | existing source ownership gate |
| `module_dag` | `pnpm run test:feature-registry` | `module-import-graph-truth.test.ts` real cross-module import DAG gate |
| `payload_control_separation` | `pnpm run test:feature-registry` | `architecture-boundary-truth.test.ts` static control/debug/business payload contract scan |
| `adjacent_data_edges` | `pnpm run test:feature-registry` | `edge-registry-truth.test.ts` direct adjacent terminal data-plane chain lock |
| `appsdk verify` | `/Users/fanzhang/.local/bin/appsdk verify android` | governance contracts |

## Known Gaps

- AppSDK review, promotion, Active, Protected, regression, and freeze are
  complete for `zterm-runtime-v2` `active-v1`.
- `active-v2` AppSDK map/test-config corrections are implemented and pass the
  local gates, but a fresh review/promotion is still required.
- Product L5 device/package/OTA verification remains open and requires an
  attached Android device plus explicit release authorization.
- `packages/shared/**` production changes remain limited to registered typed
  contracts required by the Android client/daemon edges.

## Phase 1 Production Foundation Contract Binding

### Whitebox Tests

- `shared.node_contract` owns runtime node identity, lifecycle, disposal,
  subscription, and adjacent typed node base contracts in
  `packages/shared/src/terminal/node-contract.ts`; it reuses the shared
  `ControlCommand` contract and never carries business state or routing policy.
- `shared.debug_contract` owns versioned snapshot envelopes, debug events,
  filters, strict sensitivity classes, bounded event stores, permission grants,
  and snapshot coordination in
  `packages/shared/src/terminal/debug-contract.ts`; business payload fields are
  excluded by contract and red test.
- `client.observability` owns the client debug snapshot registry and HTTP
  observability export in `src/lib/client-debug-snapshot.ts` and
  `src/lib/runtime-debug-http-exporter.ts`; it consumes the shared debug
  contract and never reads or writes session/transport/mirror/renderer/UI truth.
- `daemon.observability` owns bounded client/daemon debug entries, snapshots,
  permission lease, and typed event projection in
  `src/server/runtime-debug-store.ts` and
  `src/server/terminal-debug-runtime.ts`; debug control defaults to deny and
  explicit leases expire.

### Blackbox Tests

- `src/lib/shared-contract-ownership.test.ts` proves the module, feature,
  resource, source, package export, and v2 gate bindings for the shared node
  and debug contracts.
- `packages/shared/src/terminal/node-contract.test.ts` and
  `packages/shared/src/terminal/debug-contract.test.ts` prove lifecycle
  cleanup, duplicate producer rejection, immutable versioned snapshots, typed
  filters, bounded event history, and default-deny expiring permissions.
- `src/lib/client-debug-snapshot.test.ts`, `src/server/runtime-debug-store.test.ts`,
  and `src/server/terminal-debug-runtime.test.ts` prove production client and
  daemon debug hubs consume only shared contract truth and keep debug metadata
  out of terminal business paths.
- Resource/function/mainline/wiki/AppSDK maps bind the four foundation/debug
  resources to real production paths while review and promotion stay pending.

### Gate Mapping

| gate | command | covered by |
| --- | --- | --- |
| `node_contract` | `pnpm run test:runtime-architecture-v2` | shared node/debug contract tests |
| `shared_contract_ownership` | `pnpm run test:shared-contract-ownership` | static module/feature/resource/package/gate ownership |
| `debug_observability` | `pnpm run test:debug-observability` | client/daemon debug hub and HTTP observability tests |
| `module_ownership` | `pnpm run test:feature-registry` | registry/module/resource/edge/wiki truth gates |
| `typecheck` | `pnpm exec tsc -p tsconfig.json --noEmit --pretty false` | production foundation sources |
| `daemon close-loop` | `pnpm run daemon:mirror:close-loop` | daemon runtime parity after observability wiring |

## Phase 2: Debug Side-Channel Contracts

Experiment: same Playground module, new `debug-side-channel.ts` and paired
blackbox tests. The production cutover removes `debug-log`/`debug-snapshot`
from terminal mux classification and replaces the active-session debug flush
with the dedicated HTTP observability channel; Playground contracts remain the
typed-contract source until promotion.

### Whitebox Tests

- `DebugPermissionService` is default-deny for every debug capability; explicit
  expiring grants are required for read/subscribe/control.
- `ObservabilityChannel` accepts only typed observability frames and rejects
  frames carrying business body fields such as terminal text or session payload.
- `DebugExporter` drops overflow/closed-channel exports without throwing into the
  business node result.

### Blackbox Tests

- An observability frame reaches only the dedicated channel, never a data or
  control node.
- A bounded debug export failure/overflow cannot change the returned data result.
- Expired or revoked debug permission fails before any debug mutation or export.

### Phase 2 Production Cutover: HTTP Observability Channel

The production slice adds `resource.observability_channel` as the physical
target-level HTTP observability side channel.

#### Whitebox Tests

- `runtime-debug-http-exporter.ts` keeps bounded log/snapshot queues, failure
  discard counters, and does not block the caller when debug export fails.
- `terminal-debug-runtime.ts` lease control is default-deny and expires, and
  client log/snapshot ingestion is source-metadata-validated.
- `terminal-http-runtime.ts` accepts POST `/debug/runtime/logs` and
  `/debug/runtime/snapshot`, requires POST for `/debug/runtime/control`, and
  applies auth when configured.

#### Blackbox Tests

- Terminal mux classification rejects `debug-log` and `debug-snapshot` instead
  of routing them into the session channel.
- Debug observability export does not require an active session or transport
  socket.
- Log/snapshot ingestion reaches only the debug store, never a terminal data or
  control node.
- Invalid payloads, non-POST control mutation, and expired debug leases fail
  explicitly.

#### Gate Mapping

| Gate | Command | Covered By |
| --- | --- | --- |
| `debug_export_isolation` | `pnpm run test:debug-observability` | Playground debug side-channel tests + production HTTP exporter/ingestion tests |
| `debug_bounded` | `pnpm run test:debug-observability` | `runtime-debug-http-exporter.test.ts` |
| `debug_schema` | `pnpm run test:debug-observability` | protocol classification + HTTP observability tests |
| `module_ownership` | `pnpm run test:feature-registry` | module/edge/resource/mainline truth gates |
| `typecheck` | `pnpm exec tsc -p tsconfig.json --noEmit` | all production slice sources |

## Phase 3: Client Control Center Contracts

Experiment: same Playground module, new `control-center.ts` and paired tests.
Production `SessionContext` is changed only by the Phase 2 debug flush cutover
and the `client.terminal_channel_mux` ownership cutover below; no server router
or plugin host is changed.

### Terminal Channel Ownership Production Slice

Whitebox:
- `TerminalChannelMuxStore` owns channel open/close/name/body-subscription state.
- Channel demux and opening replay are scoped by target key and active-session priority.
- Removing one channel does not remove sibling channels or the daemon-target binding; empty targets are pruned only after the final binding is cleared.
- Rebinding a session to another target removes the old channel and prunes the old empty target.

Blackbox:
- `docs/module-registry.json` gives `client.terminal_channel_mux` a real `owned_paths` entry and `docs/edge-registry.json` declares the real `client.daemon_connection -> client.terminal_channel_mux` and `client.session_runtime -> client.terminal_channel_mux` import edges.
- `src/lib/session-transport-runtime.ts` no longer exposes `TargetTransportRuntime.channels`.

Gate:
- `src/lib/terminal-channel-mux-runtime.test.ts`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

### Whitebox Tests

- `ControlCenter` routes only to one registered owner and rejects duplicate
  registrations.
- Capability-gated commands are denied before the owning node runs.
- Idempotency keys return the first result without invoking the owner twice.
- Deadline exceeded is an explicit control error, not a swallowed success.
- Audit entries record command, subject, result, and duration in a bounded
  ledger.

### Blackbox Tests

- Unknown commands and denied capabilities produce explicit typed control
  errors.
- Repeated commands with the same idempotency key produce the same observable
  result.
- A never-completing owner produces a deadline error instead of a hung command.

### Composition Root

- `ClientCompositionRoot` binds declared runtime ports only and rejects
  duplicate providers.
- Resolution of an unbound or undeclared raw port fails before any runtime node
  can access it.
- Missing required composition ports fail before activation.

### Phase 3 Production Composition Root Slice

Whitebox:
- `ClientCompositionRoot` owns declared port binding, validation, and
  resolution in `src/lib/composition-root/client-composition-root.ts`.
- Duplicate providers, unbound raw access, and missing required ports fail
  explicitly before use.
- The composition root imports no SessionContext, traversal, session stores,
  renderer, daemon, or server truth.

Blackbox:
- `src/App.tsx` binds the declared `plugin-host` port through
  `ClientCompositionRoot`, requires it, and resolves the plugin host from the
  composition root before use.
- `docs/module-registry.json`, `docs/edge-registry.json`,
  `docs/resource-registry.json`, feature/function/wiki/AppSDK maps bind
  `client.composition_root` and `resource.client_composition_root` to real
  production paths.
- The real cross-module import graph remains acyclic and only `client.app_shell`
  imports the composition root module.

Gate:
- `src/lib/composition-root/client-composition-root.test.ts`
- `src/lib/composition-root/client-composition-root-ownership.test.ts`
- `pnpm run test:composition-root`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

### Phase 3 Production Control Center Slice

Whitebox:
- `shared.control_contract` owns branded `ControlCommand`, `ControlResult`,
  correlation, deadline, idempotency, and audit contracts in
  `packages/shared/src/terminal/control-contract.ts`; it never contains
  terminal/file/media body truth.
- `ClientControlCenter` owns unique command registration, capability
  authorization before owner execution, deadline failure, idempotency key
  deduplication, correlation, and bounded audit entries in
  `src/lib/control-center/client-control-center.ts`.
- `PluginHostControlNode` owns the typed `plugin-host.dispose` control node
  adapter for `PluginHost.disposeAll`; its params contain only a non-empty
  `reason` string.
- `client-control-center-ownership.test.ts` statically proves control-center
  code cannot import SessionContext, traversal, session stores,
  buffer/renderer/plugin host implementation, or server truth, and that only
  App plus the control-center directory import `ClientControlCenter`.

Blackbox:
- `src/App.tsx` binds both `plugin-host` and `control-center` ports through
  `ClientCompositionRoot`, requires both, and resolves them before use.
- App routes plugin-host disposal through `ClientControlCenter` with
  `plugin-host.dispose`, subject `app-shell`, capability
  `plugin-host:dispose`, and an idempotency key; App no longer calls
  `pluginHost.disposeAll` directly.
- Unknown command, denied capability, duplicate idempotency, and deadline
  failures return explicit errors and are audited without swallowing owner
  errors.
- `docs/module-registry.json`, `docs/edge-registry.json`,
  `docs/resource-registry.json`, feature/function/wiki/AppSDK maps bind
  `client.control_center`, `shared.control_contract`,
  `resource.client_control_center`, and real production paths.

Gate:
- `src/lib/control-center/client-control-center.test.ts`
- `src/lib/control-center/client-control-center-ownership.test.ts`
- `src/lib/plugin-host/plugin-host-control-node.test.ts`
- `pnpm run test:control-center`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

## Phase 5: Daemon Control Gateway And Control Center First Slice

### Whitebox

- `DaemonControlCenter` owns unique command registration, capability
  authorization before owner execution, deadline failure, idempotency key
  deduplication, command/correlation/subject validation, bounded audit, and
  typed owner execution context in `src/server/daemon-control-center-runtime.ts`.
- `daemon.control_gateway` owns `src/server/daemon-control-gateway-runtime.ts`;
  it adapts legacy schedule/tmux control messages into branded control commands
  and delegates only to the existing `terminal-message-control-runtime.ts`
  owner, preserving exact wire response/error semantics.
- Static ownership red gates prove the control center imports only the shared
  control contract and the gateway imports only typed command/owner/runtime
  types, not mirror, transport, file, remote-window, or server god runtime.

### Blackbox

- `terminal-message-runtime.ts` routes `schedule-*` and `tmux-*` messages
  through `DaemonControlGatewayRuntime`; it no longer imports schedule/tmux
  control handlers directly.
- `docs/module-registry.json`, `docs/edge-registry.json`,
  `docs/resource-registry.json`, feature/function/wiki/AppSDK maps bind
  `daemon.control_gateway`, `daemon.control_center`,
  `resource.daemon_control_gateway`, `resource.daemon_control_center`, and real
  production paths.

Gate:
- `src/server/daemon-control-center-runtime.test.ts`
- `src/server/daemon-control-center-ownership.test.ts`
- `src/server/terminal-message-runtime.test.ts`
- `pnpm run test:daemon-control-center`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

## Phase 5: Daemon Buffer Publisher Ownership Slice

### Whitebox Tests

- `daemon.buffer_publisher` owns per-subscriber bounded pending-latest,
  range merge/collapse, backpressure hysteresis, head broadcast cache,
  oversized contiguous frame split, trace stages, and
  explicit flush statuses in `src/server/daemon-buffer-publisher-runtime.ts`.
- Pending flush reads only current mirror truth and either sends the full
  authoritative changed span as contiguous same-revision frames or returns an
  explicit `backpressured` / `transport-not-open` / `send-error` /
  `stale-transport` status; send errors and stale transport generations never
  clear pending state or advance the sent revision.
- `terminal-mirror-runtime.ts` calls only the publisher broadcast/flush/head
  boundary and no longer contains queuing, backpressure, flush, or head fanout
  implementation.

### Blackbox Tests

- `docs/module-registry.json` owns `src/server/daemon-buffer-publisher-runtime.ts`
  and `src/server/terminal-buffer-sync-wire.ts` under `daemon.buffer_publisher`;
  `docs/resource-registry.json` and `docs/edge-registry.json` bind
  `resource.daemon_buffer_publisher` with
  `edge.daemon.mirror_store_to_buffer_publisher` and
  `edge.daemon.buffer_publisher_to_transport_subscriber`.
- `docs/wiki/mainline-source.md` and `docs/wiki/mainline-call-map.json` route
  `Mirror -> BufferPublisher -> TransportSend`; old `Mirror -> SendScheduler`
  and `Mirror -> TransportSend` direct body edges are removed.
- The real cross-module import graph allows mirror store to publisher and
  publisher to transport subscriber only; mirror runtime does not import
  transport send internals for body publication.

Gate:
- `src/server/daemon-buffer-publisher-runtime.test.ts`
- `src/server/terminal-buffer-sync-wire.test.ts`
- `src/server/terminal-mirror-runtime.test.ts`
- `src/server/terminal-mirror-runtime.backpressure.test.ts`
- `pnpm run test:daemon-buffer-publisher`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm run daemon:mirror:close-loop`

## Phase 5: Daemon Session Catalog Ownership Slice

### Whitebox Tests

- `daemon.session_catalog` owns backend session catalog construction,
  backend-qualified `sessionCatalog` rows, `list-sessions` control dispatch,
  legacy `sessions` payload publication, and list-time `session-activity`
  fact publication through `src/server/daemon-session-catalog-runtime.ts`.
- `buildSessionsCatalogPayload` preserves the legacy payload shape for
  backend-opaque catalogs, explicit backend requests, and terminal-session-only
  enumeration; catalog build/list failures remain explicit
  `list_sessions_failed` errors.
- Static ownership gates forbid the catalog owner from importing
  server/mirror/transport/control god runtimes and forbid
  `terminal-message-control-runtime.ts` or `terminal-message-runtime.ts`
  from constructing a second catalog/list-sessions implementation.

### Blackbox Tests

- `daemon.control_gateway` delegates `list-sessions` to
  `daemon.session_catalog`; `daemon.schedule_runtime` consumes only the shared
  `buildSessionsCatalogPayload` boundary for republish.
- `docs/module-registry.json`, `docs/resource-registry.json`,
  `docs/edge-registry.json`, function/wiki/mainline/AppSDK maps bind
  `daemon.session_catalog`, `resource.daemon_session_catalog`,
  `edge.daemon.control_gateway_to_session_catalog`, and
  `edge.daemon.schedule_runtime_to_session_catalog`.
- Mainline call map routes `ControlGateway -> SessionCatalog` for list-sessions
  and `Control -> SessionCatalog` for catalog republish; list-time idle facts
  flow `SessionCatalog -> IdleSessionPublishIn01Request`.

Gate:
- `src/server/daemon-session-catalog-runtime.test.ts`
- `src/server/daemon-session-catalog-ownership.test.ts`
- `pnpm run test:daemon-session-catalog`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm run daemon:mirror:close-loop`

## Phase 5: Daemon Attachment Message Delivery Ownership Slice

### Whitebox Tests

- `daemon.attachment_delivery` owns the four attachment transport-message
  projections in `src/server/terminal-attachment-message-runtime.ts`:
  `pending-attachments-query`, `attachment-history-query`,
  `attachment-asset-request`, and `attachment-receipt`.
- Pending manifests map to the legacy `pending-attachments` payload, history
  maps per-device delivery status to `attachment-history`, asset requests send
  base64 `attachment-asset-data`, and receipts call the delivery owner with no
  success frame.
- Invalid payloads fail before delivery-store access with `invalid_payload`;
  query/read/ack failures project explicit legacy error codes.
- Static ownership gates forbid `terminal-message-runtime.ts` from retaining
  attachment delivery business state or constructing a second attachment wire
  projection.

### Blackbox Tests

- `terminal-message-runtime.ts` routes only the four attachment message types
  to `terminal-attachment-message-runtime.ts`; the router has no direct
  attachment delivery store access.
- `docs/module-registry.json`, `docs/edge-registry.json`, function/wiki/
  mainline/AppSDK maps bind `daemon.attachment_delivery`,
  `daemon.transport_subscriber -> daemon.attachment_delivery`, and
  `daemon.attachment_delivery -> daemon.runtime`.
- Mainline call map routes
  `Message -> AttachmentMessageIn01Owner -> AttachmentIn02DeliveryOwner` and
  keeps HTTP and transport attachment projection under one owner.

Gate:
- `src/server/terminal-attachment-message-runtime.test.ts`
- `src/server/terminal-message-runtime.test.ts`
- `pnpm run test:attachment-message-delivery`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm run daemon:mirror:close-loop`

## Phase 5: Daemon File Transfer Message Route Ownership Slice

### Whitebox Tests

- `daemon.file_transfer` owns file-transfer transport-message projection in
  `src/server/terminal-file-transfer-message-runtime.ts`:
  `paste-image-start`, `attach-file-start`, `paste-image`,
  `file-list-request`, `file-create-directory-request`,
  `file-download-request`, `remote-screenshot-request`,
  `file-upload-start/chunk/end`, and raw binary chunk delivery.
- Pending paste/attach start projection is owned there and initializes the
  exact pending payload plus zero-byte/chunk bookkeeping before binary bytes
  arrive; missing attached sessions fail with `session_required` before the
  file-transfer owner is accessed.
- Every delegated message preserves the existing file-transfer wire semantics;
  the route owner has no second implementation of file listing, mkdir,
  download, screenshot, upload, or binary handling.

### Blackbox Tests

- `terminal-message-runtime.ts` routes only file-transfer message types and
  binary chunks to `terminal-file-transfer-message-runtime.ts`; it no longer
  imports the file-transfer facade directly and no longer owns pending binary
  projection.
- `docs/module-registry.json`, `docs/edge-registry.json`, function/wiki/
  mainline/AppSDK maps bind `daemon.file_transfer`,
  `daemon.transport_subscriber -> daemon.file_transfer`, and
  `daemon.file_transfer -> daemon.runtime`.
- Mainline call map routes
  `Message -> DaemonFileTransferMessageIn01Owner ->
  DaemonFileTransferUploadIn02RuntimeFacade` and keeps the upload
  cumulative-ACK/exact-completion chain unchanged.

Gate:
- `src/server/terminal-file-transfer-message-runtime.test.ts`
- `src/server/terminal-message-runtime.test.ts`
- `src/server/server.file-transfer-truth.test.ts`
- `src/server/server.transport-lifecycle-truth.test.ts`
- `pnpm run test:file-transfer-message-route`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm run daemon:mirror:close-loop`

## Phase 5: Daemon Source Adapter Contract Ownership Slice

### Whitebox Tests

- `daemon.source_adapter` owns the shared terminal source adapter contract in
  `src/server/terminal-source-adapter.ts`: supported kind normalization for
  tmux/Herdr/WezTerm, source session shape, mirror readback snapshot shape,
  and the adapter boundary consumed by backend and mirror capture owners.
- `assertSupportedTerminalSourceKind` accepts supported kinds after
  case/whitespace normalization and rejects unsupported or blank kinds
  explicitly; no source revision, mirror revision, backend session truth, or
  client policy is introduced.

### Blackbox Tests

- `docs/module-registry.json` owns `src/server/terminal-source-adapter.ts`
  and its dedicated test under `daemon.source_adapter`;
  `docs/edge-registry.json` declares the real
  `daemon.mirror_writer -> daemon.source_adapter` and
  `daemon.terminal_backend -> daemon.source_adapter` import edges.
- `daemon.terminal_backend` and `terminal.buffer_render` no longer list the
  source adapter contract as their owned path; the source adapter remains a
  shared contract physically owned by one daemon module.
- The real cross-module import graph remains acyclic and the feature registry
  and function wiki gates stay green.

Gate:
- `src/server/terminal-source-adapter.test.ts`
- `pnpm run test:source-adapter-ownership`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm run daemon:mirror:close-loop`

## Phase 5: Daemon Mirror Writer Ownership Slice

### Whitebox Tests

- `daemon.mirror_writer` owns validated terminal source capture and
  authoritative mirror snapshot commit writes in
  `src/server/terminal-mirror-capture.ts`: tmux capture/readback, source
  adapter snapshot normalization, canonical line window resolution, and
  `mirror.rows` / `mirror.bufferLines` snapshot apply stay in this owner.
- The writer does not import mirror runtime, buffer publisher, message
  runtime, or transport runtime; it never advances `mirror.revision`, never
  publishes subscriber frames, and never owns client viewport/render/UI truth.

### Blackbox Tests

- `docs/module-registry.json` owns `src/server/terminal-mirror-capture.ts`
  and its dedicated tests under `daemon.mirror_writer`; `daemon.mirror_store`
  no longer lists capture as its owned path.
- `docs/edge-registry.json` declares
  `daemon.mirror_writer -> daemon.source_adapter`,
  `daemon.mirror_writer -> daemon.runtime`, and
  `daemon.runtime_entry -> daemon.mirror_writer` import edges; no stale
  `daemon.mirror_store -> daemon.mirror_writer` import edge exists because
  capture is injected into mirror runtime through the composition owner.
- `terminal.buffer_render` no longer lists capture as its owned path; the
  function map, mainline call map, wiki, and AppSDK maps bind
  `daemon.mirror_writer` to the writer path.

Gate:
- `src/server/terminal-mirror-writer-ownership.test.ts`
- `src/server/terminal-mirror-capture.test.ts`
- `src/server/terminal-mirror-capture-continuity.test.ts`
- `src/server/server.mirror-capture-truth.test.ts`
- `pnpm run test:mirror-writer-ownership`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm run daemon:mirror:close-loop`

## Phase 4: Daemon Input Queue Ownership Slice

### Whitebox Tests

- `createDaemonInputQueueRuntime` owns receive validation for string and
  reliable v1 input frames, byte-cap rejection, session-required/stale
  retryable nack, invalid/oversize non-retryable errors, and seq dedupe.
- `enqueueLiveMirrorInput` coalesces same-mirror bursts, preserves
  append-enter boundaries, splits tmux write groups by byte budget, and
  settles each item only after all of its backend chunks complete.
- `disposeLiveMirrorInputBatch` evicts queued items and never lets queued input
  survive into a future attach.

### Blackbox Tests

- `daemon-input-queue-runtime.ts` is a real `daemon.input_queue` owned path and
  `terminal-control-runtime.ts` no longer owns queue internals.
- `terminal-message-runtime.ts` routes `input` and plain-text frames through
  the queue owner; mirror runtime consumes queue enqueue/dispose only.
- Edge `edge.daemon.input_queue_to_backend` names the queue runtime as the
  backend-write caller.

Gate:
- `src/server/daemon-input-queue-runtime.test.ts`
- `src/server/terminal-message-runtime.test.ts`
- `src/server/server.control-truth.test.ts`
- `src/server/server.herdr-selection-truth.test.ts`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

## Phase 4: Client Buffer Frame Assembly Ownership Slice

Experiment: production ownership slice in `src/lib/buffer-frame-assembly/`.

Whitebox:
- `client.buffer_frame_assembly` owns the bounded authoritative frame assembly
  resource and the frame error/repair ledger.
- The assembly module imports only shared terminal types/protocol constants;
  it does not own socket routing, sparse apply, renderer, or UI policy.
- `client.buffer_store` no longer owns `resource.client_buffer_frame_assembly`
  and no longer owns the frame assembly source paths.

Blackbox:
- `docs/module-registry.json` gives `client.buffer_frame_assembly` a real
  `owned_paths` entry and active resource ownership.
- `docs/edge-registry.json` declares `client.buffer_store ->
  client.buffer_frame_assembly` and `client.session_runtime ->
  client.buffer_frame_assembly` import edges plus the frame assembly resource
  edges.
- The real cross-module import graph remains acyclic with the new module.
- Frame assembly tests, buffer runtime tests, feature registry, typecheck, and
  daemon mirror close-loop remain green.

Gate:
- `src/lib/buffer-frame-assembly/session-buffer-frame-assembly.test.ts`
- `src/contexts/session-context-buffer-runtime.test.ts`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm run daemon:mirror:close-loop`

## Phase 4: Client Wire Ingress Ownership Slice

Experiment: production ownership slice in `src/lib/wire-ingress/`.

Whitebox:
- `client.wire_ingress` owns validated client wire ingress normalization and
  frame identity decoding before frame assembly.
- `normalizeIncomingBufferPayload` and `normalizeTerminalCursorState` do not
  decide feature policy, sparse apply, renderer state, or UI projection.
- `session-wire-helpers.ts` remains the outbound host-config builder owned by
  `client.daemon_connection`; the normalized buffer ingress path does not share
  that file.

Blackbox:
- `docs/module-registry.json` gives `client.wire_ingress` a real `owned_paths`
  entry and active module ownership.
- `docs/edge-registry.json` declares `client.buffer_store ->
  client.wire_ingress`, `client.session_runtime -> client.wire_ingress`, and
  `client.wire_ingress -> shared.terminal_types` import edges.
- The real cross-module import graph remains acyclic with the new module.
- Buffer normalization tests, buffer runtime tests, feature registry,
  typecheck, and daemon mirror close-loop remain green.

Gate:
- `src/lib/wire-ingress/buffer-wire-normalize.test.ts`
- `src/contexts/session-context-buffer-runtime.test.ts`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm run daemon:mirror:close-loop`

## Phase 4: Client Sparse Buffer And Render Projection Ownership Slice

Whitebox:
- `client.sparse_buffer` owns `resource.client_sparse_buffer` through
  `src/lib/session-buffer-store.ts`; it publishes immutable absolute-row sparse
  snapshots and does not own follow/reading/render bottom.
- `client.buffer_store` no longer owns the sparse body store; it keeps
  planner/pull/repair orchestration and head/tail refresh truth as consumers of
  sparse body truth.
- `client.renderer_window` owns `src/lib/session-render-buffer-store.ts` with
  the existing render gate; render projection and visible-window demand remain
  outside `client.buffer_store`.

Blackbox:
- `docs/module-registry.json` gives `client.sparse_buffer` a real
  `owned_paths` entry and active resource ownership.
- `docs/edge-registry.json` declares `client.buffer_store ->
  client.sparse_buffer`, `client.session_runtime -> client.sparse_buffer`,
  `client.renderer_window -> client.sparse_buffer`, and
  `client.sparse_buffer -> shared.terminal_types` import edges.
- `docs/edge-registry.json` resource edges route frame assembly to
  `client.sparse_buffer` and sparse truth to `client.renderer_window`.
- The real cross-module import graph remains acyclic with the new module.
- Sparse store tests, render store tests, buffer runtime tests, feature
  registry, typecheck, and daemon mirror close-loop remain green.

Gate:
- `src/lib/session-buffer-store.test.ts`
- `src/lib/session-render-buffer-store.test.ts`
- `src/contexts/session-context-buffer-runtime.test.ts`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm run daemon:mirror:close-loop`

## Phase 4: Client DOM Renderer And Terminal Shell Ownership Slice

Experiment: production ownership slice in `src/components/`,
`src/pages/`, and `packages/shared/src/terminal/`.

Whitebox:
- `client.dom_renderer` owns immutable render snapshot to DOM projection:
  `TerminalView`, `VisibleRow`, `TerminalPreviewRow`, mirror-fixed zoom/pan,
  cell render helpers, and terminal theme. It consumes
  `resource.renderer_window`, `resource.ui_projection`, and
  `resource.shared_terminal_types`; it does not own follow/reading/
  renderBottomIndex, request policy, sparse truth, or backend access.
- `client.terminal_shell` owns Android terminal stage shell, shell skin,
  status projection, shell action routing, copy runtime, quickbar assembly,
  and keyboard lift. It consumes platform/UI/renderer/DOM projections and
  emits user intent only; it does not own terminal body or visible-window
  truth.
- `client.renderer_window` no longer owns DOM projection files; its
  responsibility is limited to visible-window truth and immutable render
  snapshot projection.

Blackbox:
- `docs/module-registry.json` gives `client.dom_renderer` and
  `client.terminal_shell` real `owned_paths` entries and active module
  ownership.
- `docs/edge-registry.json` declares `client.app_shell ->
  client.terminal_shell`, `client.terminal_shell -> client.dom_renderer`,
  `client.dom_renderer -> client.renderer_window`, and
  `client.terminal_shell -> client.renderer_window` import edges.
- `docs/edge-registry.json` resource edge
  `edge.client_renderer_to_ui_projection` routes renderer projection through
  `client.dom_renderer` and `client.terminal_shell` instead of a direct
  renderer-to-app-shell shortcut.
- The real cross-module import graph remains acyclic with the new modules.
- Feature registry, module import truth, DOM renderer tests, terminal shell
  tests, typecheck, and daemon mirror close-loop remain green.

Gate:
- `src/lib/module-registry-truth.test.ts`
- `src/lib/module-import-graph-truth.test.ts`
- `src/components/TerminalView.dynamic-refresh.test.tsx`
- `src/pages/TerminalPageStageShell.pane-stage.test.tsx`
- `src/pages/useTerminalPageShellActionsRuntime.test.tsx`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm run daemon:mirror:close-loop`

## Phase 4: Client Input Normalizer Ownership Slice

Experiment: production ownership slice in `src/lib/terminal-input-normalization.ts`.

Whitebox:
- `client.input_normalizer` owns only pure committed-text normalization in
  `src/lib/terminal-input-normalization.ts`.
- The normalizer preserves CJK, emoji, and non-ASCII symbols, converts
  terminal-oriented full-width ASCII/punctuation and ideographic space to
  half-width, and turns IME line breaks into text separators instead of
  terminal Enter.
- The normalizer never imports session transport, session context, backend,
  mirror, or transport truth.
- `client.runtime` no longer owns the normalizer path.

Blackbox:
- `docs/module-registry.json` gives `client.input_normalizer` the exclusive
  `owned_paths` entry for `src/lib/terminal-input-normalization.ts`.
- `docs/edge-registry.json` declares the real
  `client.app_shell -> client.input_normalizer` and
  `client.dom_renderer -> client.input_normalizer` import edges and binds the
  corresponding `android_mainline` call ids.
- TerminalPage and TerminalView consume the normalizer only through those
  registered edges.
- Positive and negative normalization tests cover CJK/emoji/symbols, full-width
  punctuation, IME line breaks, and empty input.

Gate:
- `src/lib/input-normalizer-ownership.test.ts`
- `src/lib/terminal-input-normalization.test.ts`
- `pnpm run test:input-normalizer`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

## Phase 5: Client Reliable Input Ownership Slice

Experiment: production ownership slice in
`src/lib/reliable-input/reliable-input-queue.ts` with
`src/contexts/session-context-input-runtime.ts` reduced to a thin bridge.

Whitebox:
- `client.reliable_input` owns reliable terminal input seq allocation, ordered
  pending queue, one-in-flight send, ACK application, ACK-timeout retry,
  transport-generation retry, retryable nack handling, and exponential
  backoff in `src/lib/reliable-input/reliable-input-queue.ts`.
- The queue never imports SessionContext or session runtime state machines,
  never calls `reconnectSession`/`scheduleReconnect`, and never writes retry
  control state into terminal input payloads.
- `session-context-input-runtime.ts` keeps only `sendInputThroughSessionTransport`
  and `ensureSessionReadyForTransfer` as a compatibility bridge and re-exports
  the queue API without re-owning queue truth.

Blackbox:
- `docs/module-registry.json` gives `client.reliable_input` the exclusive
  `owned_paths` entry for `src/lib/reliable-input/reliable-input-queue.ts` and
  binds `resource.client_reliable_input_queue` truth to that path.
- `docs/feature-registry.json` registers the queue path for
  `terminal.daemon_input`; feature-registry, resource-registry, module
  registry, edge-registry, and import-graph gates pass.
- Mainline call map anchors
  `android_mainline:TerminalInputDispatch->ClientReliableInputQueue`,
  `android_mainline:ClientReliableInputQueue->ChannelSend`, and
  `android_mainline:SocketMessage->ClientReliableInputAck`.
- Positive and negative queue tests cover ack-before-resend, ack timeout,
  transport-generation resend, route-config no-resend, chunk order,
  retryable/non-retryable nack, and backoff bounds.

Gate:
- `src/lib/reliable-input/reliable-input-ownership.test.ts`
- `src/lib/reliable-input/reliable-input-queue.test.ts`
- `pnpm run test:reliable-input-ownership`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

## Phase 6: Production Plugin Host First Slice

Experiment: production ownership slice in `src/lib/plugin-host/`,
`packages/shared/src/terminal/plugin-*`, and `src/App.tsx`.

Whitebox:
- `PluginHostRuntime` owns manifest install, deterministic start/stop/dispose,
  declared capability injection, and plugin-provided capability removal.
- `PluginCapabilityRegistry` rejects duplicate or undeclared providers and
  keeps host-provided providers non-removable.
- Disposed hosts reject lifecycle/capability reads and App composition can
  create a fresh replacement host after unmount.
- `plugin-host-ownership.test.ts` statically proves host code cannot import
  SessionContext, traversal, session stores, or server truth, and that only
  `src/App.tsx` plus `src/lib/plugin-host/` consume plugin contracts.

Blackbox:
- The `network-identity` plugin receives only the declared
  `network:native-snapshot` capability and publishes only
  `network:sample-interfaces`; App consumes only that published capability to
  build `NetworkIdentityRuntime`.
- `docs/module-registry.json`, `docs/edge-registry.json`,
  `docs/resource-registry.json`, feature/function/wiki/AppSDK maps bind
  `client.plugin_host`, `shared.plugin_contract`,
  `resource.client_plugin_host`, and `resource.plugin_capability_registry` to
  real production paths.
- The real cross-module import graph remains acyclic and the ownership red
  test passes.

Gate:
- `src/lib/plugin-host/plugin-host-runtime.test.ts`
- `src/lib/plugin-host/plugin-host-ownership.test.ts`
- `pnpm run test:plugin-host`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

## Phase 7: Debug Console UI Plugin First Slice

Experiment: production ownership slice in `src/lib/plugin-debug-console/`,
`src/lib/plugin-host/debug-console-ui-plugin.tsx`,
`packages/shared/src/terminal/plugin-ui-slot*.ts`, and
`src/pages/TerminalPageDebugOverlay.tsx`.

Whitebox:
- `client.debug_console` owns the typed debug console UI slot contract and
  terminal debug session projection in
  `src/lib/plugin-debug-console/debug-console-contract.ts`; it never owns
  transport, session, mirror, sparse, renderer, or UI projection truth.
- `PluginUiSlotRegistry` rejects duplicate UI slot providers, resolves only
  registered slots, supports presence checks, and removes only removable
  slots.
- `DebugConsoleUiPlugin` provides `terminal.debug-console` through the plugin
  host UI slot registry and renders `TerminalDebugOverlay` with the typed
  contract.
- `TerminalPageDebugOverlay` renders only typed debug session projections and
  never imports the raw overlay directly from `TerminalPage`.

Blackbox:
- `src/App.tsx` installs `DebugConsoleUiPlugin`, reads the debug console UI
  slot render callback only after `PluginHost.startAll` resolves, and passes it
  into `TerminalPage`; `TerminalPage` renders the callback only when present.
- `docs/module-registry.json`, `docs/edge-registry.json`,
  `docs/resource-registry.json`, feature/function/wiki/AppSDK maps bind
  `client.debug_console`, `resource.debug_console_ui_contract`,
  `resource.plugin_ui_slot_registry`, and the real production paths.
- The real cross-module import graph remains acyclic; `client.plugin_host ->
  client.debug_console` and `client.app_shell -> client.debug_console` are
  declared, and `client.debug_console -> client.terminal_shell` is the only
  overlay helper dependency.
- Debug overlay visibility, typed session metrics, remote-window debug
  projection, render-scope stability, and plugin UI slot lifecycle tests pass.

Gate:
- `src/lib/plugin-host/plugin-host-runtime.test.ts`
- `src/pages/TerminalPageDebugOverlay.test.tsx`
- `src/pages/TerminalPage.render-scope.test.tsx`
- `src/pages/TerminalPage.remote-window-overlay.test.tsx`
- `pnpm run test:debug-console-ui`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

## Phase 7: Session Drawer UI Plugin Second Slice

Experiment: production ownership slice in `src/lib/plugin-session-drawer/`,
`src/lib/plugin-host/session-drawer-ui-plugin.tsx`, `src/App.tsx`, and
`src/pages/TerminalPage.tsx`.

Whitebox:
- `client.session_drawer_ui` owns `SESSION_DRAWER_UI_SLOT_ID`,
  `SessionDrawerUiProps`, and `TerminalSessionDrawerSlot` in
  `src/lib/plugin-session-drawer/session-drawer-contract.ts`; it never owns
  transport, session, mirror, sparse, renderer, or UI projection truth.
- `SessionDrawerUiPlugin` registers and removes `terminal.session-drawer`
  through the plugin host UI slot registry and renders `TerminalSessionDrawer`
  with the typed session drawer contract.
- `TerminalPage` imports only the typed slot contract and renders the drawer
  only through `renderSessionDrawer`; it has no direct `TerminalSessionDrawer`
  import/render path.

Blackbox:
- `src/App.tsx` installs `SessionDrawerUiPlugin`, reads the session drawer UI
  slot render callback only after `PluginHost.startAll` resolves, and passes it
  into `TerminalPage`; first paint with no callback still succeeds and App
  rerenders once the plugin host publishes the slot.
- `TerminalPage` without a drawer callback renders no drawer; with a callback
  it renders only the plugin-provided callback.
- Direct sibling tests for drawer, session preview, and tab isolation pass the
  real plugin callback so existing drawer behavior remains covered.
- `docs/module-registry.json`, `docs/edge-registry.json`,
  `docs/resource-registry.json`, feature/function/wiki/AppSDK maps bind
  `client.session_drawer_ui`, `resource.session_drawer_ui_contract`,
  `resource.plugin_ui_slot_registry`, and the real production paths; the real
  cross-module import graph remains acyclic.

Gate:
- `src/lib/plugin-host/plugin-host-runtime.test.ts`
- `src/pages/TerminalPage.session-drawer.test.tsx`
- `src/pages/TerminalPage.session-preview.test.tsx`
- `src/pages/TerminalPage.tab-isolation.test.tsx`
- `src/App.dynamic-refresh.test.tsx`
- `pnpm run test:session-drawer-ui`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

## Phase 7: File Browser UI Plugin Third Slice

Experiment: production ownership slice in `src/lib/plugin-file-browser/`,
`src/lib/plugin-host/file-browser-ui-plugin.tsx`, `src/App.tsx`, and
`src/pages/TerminalPage.tsx`.

Whitebox:
- `client.file_browser_ui` owns `FILE_BROWSER_UI_SLOT_ID`,
  `FileBrowserUiProps`, and `TerminalFileBrowserSlot` in
  `src/lib/plugin-file-browser/file-browser-contract.ts`; it never owns
  transport, session, mirror, sparse, renderer, or UI projection truth.
- `FileBrowserUiPlugin` registers and removes `terminal.file-browser` through
  the plugin host UI slot registry and renders `FileTransferSheet` with the
  typed file browser contract.
- `TerminalPage` imports only the typed slot contract and renders the file
  browser only through `renderFileBrowser`; it has no direct
  `FileTransferSheet` import/render path.

Blackbox:
- `src/App.tsx` installs `FileBrowserUiPlugin`, reads the file browser UI slot
  render callback only after `PluginHost.startAll` resolves, and passes it into
  `TerminalPage`; first paint with no callback still succeeds and App rerenders
  once the plugin host publishes the slot.
- `TerminalPage` without a file browser callback renders no file browser; with
  a callback it renders only the plugin-provided callback and the open flag
  toggles through the existing QuickBar shell intent.
- `docs/module-registry.json`, `docs/edge-registry.json`,
  `docs/resource-registry.json`, feature/function/wiki/AppSDK maps bind
  `client.file_browser_ui`, `resource.file_browser_ui_contract`,
  `resource.plugin_ui_slot_registry`, and the real production paths; the real
  cross-module import graph remains acyclic.

Gate:
- `src/lib/plugin-host/plugin-host-runtime.test.ts`
- `src/lib/plugin-file-browser/file-browser-ui-ownership.test.ts`
- `src/pages/TerminalPage.render-isolation.test.tsx`
- `src/App.dynamic-refresh.test.tsx`
- `pnpm run test:file-browser-ui`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

## Phase 7: Settings Update UI Plugin Fourth Slice

Experiment: production ownership slice in `src/lib/plugin-settings-update/`,
`src/lib/plugin-host/settings-update-ui-plugin.tsx`, `src/App.tsx`, and
`src/pages/SettingsPage.tsx`.

Whitebox:
- `client.settings_update_ui` owns `SETTINGS_UPDATE_UI_SLOT_ID`,
  `SettingsUpdateUiProps`, and `SettingsUpdateUiSlot` in
  `src/lib/plugin-settings-update/settings-update-contract.ts`; it never owns
  transport, session, mirror, sparse, renderer, open-tab, or UI projection
  truth.
- `SettingsUpdateUiPlugin` registers and removes `settings.update` through the
  plugin host UI slot registry and renders `AppUpdateSection` with the typed
  settings update contract.
- `SettingsPage` imports only the typed slot contract and renders the update
  section only through `renderSettingsUpdate`; it has no direct
  `AppUpdateSection` import/render path.

Blackbox:
- `src/App.tsx` installs `SettingsUpdateUiPlugin`, reads the settings update UI
  slot render callback only after `PluginHost.startAll` resolves, and passes it
  into `SettingsPage`; first paint with no callback still succeeds and App
  rerenders once the plugin host publishes the slot.
- `SettingsPage` without a settings update callback renders no update section;
  with a callback it renders only the plugin-provided callback and receives the
  full AppUpdateSection projection props.
- `docs/module-registry.json`, `docs/edge-registry.json`,
  `docs/resource-registry.json`, feature/function/wiki/AppSDK maps bind
  `client.settings_update_ui`, `resource.settings_update_ui_contract`,
  `resource.plugin_ui_slot_registry`, and the real production paths; the real
  cross-module import graph remains acyclic.

Gate:
- `src/lib/plugin-host/plugin-host-runtime.test.ts`
- `src/lib/plugin-settings-update/settings-update-ui-ownership.test.ts`
- `src/pages/SettingsPage.plugin-render.test.tsx`
- `src/App.dynamic-refresh.test.tsx`
- `pnpm run test:settings-update-ui`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

## Phase 7: Remote Window UI Plugin Fifth Slice

Experiment: production ownership slice in `src/lib/plugin-remote-window/`,
`src/lib/plugin-host/remote-window-ui-plugin.tsx`, `src/App.tsx`, and
`src/pages/TerminalPage.tsx`.

Whitebox:
- `client.remote_window_ui` owns `REMOTE_WINDOW_UI_SLOT_ID`,
  `RemoteWindowUiProps`, and `TerminalRemoteWindowSlot` in
  `src/lib/plugin-remote-window/remote-window-contract.ts`; it never owns
  transport, session, mirror, sparse, renderer, remote-window media/capture,
  touch dispatch, or UI projection truth.
- `RemoteWindowUiPlugin` registers and removes `terminal.remote-window`
  through the plugin host UI slot registry and renders `RemoteWindowOverlay`
  with the typed remote window UI contract.
- `TerminalPage` imports only the typed slot contract and renders the remote
  window overlay only through `renderRemoteWindow`; it has no direct
  `RemoteWindowOverlay` import/render path.

Blackbox:
- `src/App.tsx` installs `RemoteWindowUiPlugin`, reads the remote window UI
  slot render callback only after `PluginHost.startAll` resolves, and passes it
  into `TerminalPage`; first paint with no callback still succeeds and App
  rerenders once the plugin host publishes the slot.
- `TerminalPage` without a remote window callback renders no remote window
  overlay; with a callback it renders only the plugin-provided callback and
  receives the full RemoteWindowOverlay projection props.
- `docs/module-registry.json`, `docs/edge-registry.json`,
  `docs/resource-registry.json`, feature/function/wiki/AppSDK maps bind
  `client.remote_window_ui`, `resource.remote_window_ui_contract`,
  `resource.remote_window_overlay`, and the real production paths; the real
  cross-module import graph remains acyclic.

Gate:
- `src/lib/plugin-host/plugin-host-runtime.test.ts`
- `src/lib/plugin-remote-window/remote-window-ui-ownership.test.ts`
- `src/pages/TerminalPage.remote-window-overlay.test.tsx`
- `src/pages/TerminalPage.android-ime.test.tsx`
- `src/App.dynamic-refresh.test.tsx`
- `pnpm run test:remote-window-ui`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

## Phase 7: Quickbar UI Plugin Sixth Slice

Experiment: production ownership slice in `src/lib/plugin-quickbar/`,
`src/lib/plugin-host/quickbar-ui-plugin.tsx`, `src/App.tsx`, and
`src/pages/TerminalPage.tsx`.

Whitebox:
- `client.quickbar_ui` owns `QUICKBAR_UI_SLOT_ID`, `QuickBarUiProps`, and
  `TerminalQuickBarSlot` in `src/lib/plugin-quickbar/quickbar-contract.ts`;
  it never owns transport, session, mirror, sparse, renderer, UI projection,
  or input normalization truth.
- `QuickBarUiPlugin` registers and removes `terminal.quickbar` through the
  plugin host UI slot registry and renders `TerminalQuickBar` with the typed
  quickbar contract.
- `TerminalPage` imports only the typed slot contract and renders the quickbar
  only through `renderQuickBar`; it has no direct `TerminalQuickBar`
  import/render path.

Blackbox:
- `src/App.tsx` installs `QuickBarUiPlugin`, reads the quickbar UI slot render
  callback only after `PluginHost.startAll` resolves, and passes it into
  `TerminalPage`; first paint with no callback still succeeds and App rerenders
  once the plugin host publishes the slot.
- `TerminalPage` without a quickbar callback renders no quickbar projection;
  with a callback it renders only the plugin-provided callback and receives
  the full `TerminalQuickBar` projection props.
- `docs/module-registry.json`, `docs/edge-registry.json`,
  `docs/resource-registry.json`, feature/function/wiki/AppSDK maps bind
  `client.quickbar_ui`, `resource.quickbar_ui_contract`,
  `resource.plugin_ui_slot_registry`, and the real production paths; the real
  cross-module import graph remains acyclic and declares
  `client.quickbar_ui -> client.input_runtime`.

Gate:
- `src/lib/plugin-host/plugin-host-runtime.test.ts`
- `src/lib/plugin-quickbar/quickbar-ui-ownership.test.ts`
- `src/pages/TerminalPage.render-isolation.test.tsx`
- `src/App.dynamic-refresh.test.tsx`
- `pnpm run test:quickbar-ui`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`

## Phase 7: Terminal Shell UI Plugin Seventh Slice

Experiment: production ownership slice in `src/lib/plugin-terminal-shell/`,
`src/lib/plugin-host/terminal-shell-ui-plugin.tsx`, `src/App.tsx`, and
`src/pages/TerminalPage.tsx`.

Whitebox:
- `client.terminal_shell_ui` owns `TERMINAL_SHELL_UI_SLOT_ID`,
  `TerminalShellUiProps`, and `TerminalShellUiSlot` in
  `src/lib/plugin-terminal-shell/terminal-shell-contract.ts`; it never owns
  transport, session, mirror, sparse, renderer, terminal body, or UI
  projection truth.
- `TerminalShellUiPlugin` registers and removes `terminal.shell` through the
  plugin host UI slot registry and renders `TerminalConnectionStatusStrip`,
  `TerminalPageCopyMenu`, `TerminalPageStageShell`, `TerminalNetworkBanner`,
  and `TerminalQuickBarShell` with the typed terminal shell contract.
- `TerminalPage` imports only the typed slot contract and renders the terminal
  shell only through `renderTerminalShell`; it has no direct
  `TerminalConnectionStatusStrip`, `TerminalPageCopyMenu`,
  `TerminalPageStageShell`, `terminal-page-shell-ui`, `TerminalQuickBarShell`,
  or `TerminalNetworkBanner` import/render path.

Blackbox:
- `src/App.tsx` installs `TerminalShellUiPlugin`, reads the terminal shell UI
  slot render callback only after `PluginHost.startAll` resolves, and passes
  it into `TerminalPage`; first paint with no callback still succeeds and App
  rerenders once the plugin host publishes the slot.
- `TerminalPage` without a terminal shell callback renders no shell projection;
  with a callback it renders only the plugin-provided callback and receives
  the full `TerminalShellUiProps` projection.
- `docs/module-registry.json`, `docs/edge-registry.json`,
  `docs/resource-registry.json`, feature/function/wiki/AppSDK maps bind
  `client.terminal_shell_ui`, `resource.terminal_shell_ui_contract`,
  `resource.plugin_ui_slot_registry`, and the real production paths; the real
  cross-module import graph remains acyclic and declares
  `client.terminal_shell_ui -> client.terminal_shell`.

Gate:
- `src/lib/plugin-host/plugin-host-runtime.test.ts`
- `src/lib/plugin-terminal-shell/terminal-shell-ui-ownership.test.ts`
- `src/pages/TerminalPage.render-isolation.test.tsx`
- `src/App.dynamic-refresh.test.tsx`
- `pnpm run test:terminal-shell-ui`
- `pnpm run test:feature-registry`
- `pnpm exec tsc -p tsconfig.json --noEmit`
