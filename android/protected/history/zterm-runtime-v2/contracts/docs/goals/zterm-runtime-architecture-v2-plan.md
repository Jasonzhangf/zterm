# ZTerm Runtime Architecture v2 Implementation Plan

- Design: `docs/design/2026-08-14-zterm-runtime-architecture-v2.md`
- Design ID: `ZTERM-ARCH-V2-DESIGN-001`
- AppSDK project: `android/.appsdk/project.json`
- Goal contract: `android/.appsdk/goal.json`
- Status: confirmed; Phase 0/1, Phase 2, and Phase 3 Playground contracts implemented; Phase 2 production debug HTTP observability slice, Phase 3 production `client.terminal_channel_mux` ownership slice, Phase 4 production `client.buffer_frame_assembly`, `client.wire_ingress`, `client.sparse_buffer`, `client.dom_renderer`, `client.terminal_shell`, and `client.input_normalizer` ownership slices, Phase 5 production daemon control gateway/center, daemon buffer publisher, daemon session catalog, daemon attachment message delivery, daemon source adapter, daemon mirror writer, and daemon file transfer message route slices, Phase 6 plugin host first slice, and Phase 7 debug console, session drawer, file browser, settings update, remote window, quickbar, and terminal shell UI slices implemented, review/promotion pending

## 1. Goal and Acceptance Criteria

Refactor the current Android client and embedded daemon into an AppSDK-governed v2 architecture while preserving current behavior.

Acceptance requires:

1. client and daemon have explicit physical modules, unique resources, owned paths, and registered adjacent edges;
2. data, control, debug, and error planes use different typed contracts and cannot leak into each other;
3. runtime foundation nodes support lifecycle, bounded debug subscriptions, and versioned snapshots;
4. buffer update, frame assembly, sparse buffer, render window, DOM renderer, UI shell, connection, terminal channel, input, and daemon services are independent owners;
5. client features are capability-scoped plugins, with Cordis isolated behind an adapter if the Playground evaluation passes;
6. SessionContext, server composition, and message dispatch no longer act as cross-domain service locators;
7. terminal/source/input/session behavior and business payload semantics remain unchanged;
8. architecture gates are connected to CI/prebuild and prove source ownership, import/call edges, plane isolation, and no cycles;
9. every promoted slice has AppSDK evidence, review PASS, regression, compile, promotion, Active, Protected, and Freeze records.

## 2. Scope

### In scope

- `android/.appsdk/**` project-authored contracts, maps, goals, and records.
- `android/playground/experiments/zterm-runtime-architecture-v2/**` experiments.
- `android/docs/**` architecture, registries, call maps, test designs, and review surfaces.
- `android/src/**` only after the owning slice is admitted and promoted from Playground.
- `packages/shared/**` only for registered typed contracts required by Android client/daemon edges.
- tests and gates required by the exact module slice.

### Out of scope

- `mac/**`, `win/**`, and `../wterm/**` runtime refactors.
- product behavior, UI redesign, and payload-semantic changes.
- fallback, shadow writers, dual compiler, or permanent compatibility adapters.
- direct edits to `active/lib/**`, `protected/source/**`, `protected/history/**`, `generated/**`, `.appsdk/sdk.lock`, or `.appsdk/sdk-resources.json`.

## 3. Canonical Inputs

Read in this order before every implementation slice:

1. `.appsdk/skills/appsdk-project-governance/SKILL.md`
2. `.appsdk/contracts/sdk-bundle.manifest.json`
3. `.appsdk/project.json`
4. `.appsdk/goal.json`
5. `.appsdk/maps/resource-map.json`
6. `.appsdk/maps/function-map.json`
7. `.appsdk/maps/mainline-call-map.json`
8. `.appsdk/maps/verification-map.json`
9. `docs/design/2026-08-14-zterm-runtime-architecture-v2.md`
10. `docs/architecture.md`
11. `docs/audits/2026-07-02-architecture-boundary-remediation.md`
12. `docs/resource-registry.json` and `docs/resource-map.md`
13. `docs/module-registry.json` and `docs/modules/project-modules.md`
14. `docs/edge-registry.json`
15. `docs/function-map.md`
16. `docs/wiki/mainline-call-map.json`
17. `.agents/skills/terminal-buffer-truth/SKILL.md`
18. current `.appsdk/records/`, Git status, and exact diff

## 4. Design Principles

- One resource, one writer, one owning module.
- Data, control, debug, and errors are separate typed planes.
- Commands request change; domain events report committed facts; queries read current owner truth.
- High-frequency bodies use adjacent direct data ports, not a global event bus.
- Debug observes only and cannot affect business success, ordering, timing policy, or truth.
- UI/plugins consume capability ports and immutable projections, never raw sockets or owner stores.
- Cordis is optional composition infrastructure behind `CordisAdapter`, not a protocol or data-plane dependency.
- No production cutover keeps two owners or two routes.
- Registry `design`/`pending` entries are target state until physical paths and gates exist.

## 5. Target Files and Surfaces

Exact implementation paths must be admitted per slice. Expected target surfaces are:

### Governance and docs

- `.appsdk/project.json`
- `.appsdk/goal.json`
- `.appsdk/maps/resource-map.json`
- `.appsdk/maps/function-map.json`
- `.appsdk/maps/mainline-call-map.json`
- `.appsdk/maps/verification-map.json`
- `docs/design/2026-08-14-zterm-runtime-architecture-v2.md`
- `docs/resource-registry.json`
- `docs/module-registry.json`
- `docs/edge-registry.json`
- `docs/function-map.md`
- `docs/wiki/mainline-call-map.json`
- `docs/testing/zterm-runtime-architecture-v2-test-design.md`

### Foundation and shared contracts

Final paths are chosen by the registered owner before implementation. Required units:

- node identity/lifecycle/disposal;
- data/control/event/error/debug envelopes;
- snapshot schema and subscription contract;
- plugin manifest, capability, lifecycle, and permission contracts;
- wire codecs that preserve business payload semantics.

### Client runtime

- composition root and plugin host;
- control center and typed gateways;
- transport/session/channel owners;
- wire ingress, frame assembly, sparse buffer, render window, DOM renderer;
- input normalizer and reliable input (`src/lib/reliable-input/reliable-input-queue.ts` production slice);
- capability-scoped UI plugins;
- client debug hub and snapshot registry.

### Daemon runtime

- composition root;
- control gateway and control center;
- typed per-domain handlers;
- channel mux, source adapter, mirror writer/store, publisher, input queue;
- feature control/data owners;
- daemon debug hub and snapshot registry.

## 6. Implementation Sequence

### Phase 0: Governance admission

1. Confirm global AppSDK 0.1.0 and pinned Bundle.
2. Replace template project/goal/maps with ZTerm v2 identity.
3. Add target resources/modules/edges as `design` or `pending` only.
4. Add the v2 test design and architecture red gates.
5. Run `appsdk verify .` from `android/`.

Exit: governance contract is valid; no production runtime changed.

### Phase 1: Foundation contracts

1. Create the Playground experiment. (done)
2. Define `FoundationNode`, `DataNode`, `ControlNode`, typed ports/envelopes, `DebuggableNode`, snapshot, and plugin contracts. (done)
3. Prove data/control type separation, adjacent-edge rules, lifecycle disposal, duplicate debug producer failure, snapshot immutability, and bounded subscriptions. (done)
4. Produce EvidenceRecord and ReviewRecord PASS. (EvidenceRecord done; ReviewRecord pending codex-review availability)

Exit: contracts compile and gates pass; no runtime owner cutover yet. (contracts/gates pass; review not yet recorded)

Production progress:
- `shared.node_contract` now owns
  `packages/shared/src/terminal/node-contract.ts` and
  `resource.runtime_node_registry`; `shared.debug_contract` now owns
  `packages/shared/src/terminal/debug-contract.ts` and
  `resource.debug_snapshot_registry`. `client.observability` owns
  `resource.client_debug_hub` through
  `src/lib/client-debug-snapshot.ts` plus
  `src/lib/runtime-debug-http-exporter.ts`; `daemon.observability` owns
  `resource.daemon_debug_hub` through `src/server/runtime-debug-store.ts` plus
  `src/server/terminal-debug-runtime.ts`. Shared ownership tests, module/
  feature/resource/function/wiki/AppSDK maps, prebuild, and CI are updated.
  Review and promotion remain pending; this is a `production_pending_review`
  foundation slice, not Phase 1 or v2 completion.

### Phase 2: Debug plane first

1. Add client/daemon local debug hubs and snapshot registries. (Playground contract done; production binding pending)
2. Add a dedicated target-level observability channel with independent capability and backpressure. (Playground contract done)
3. Remove debug log/snapshot from terminal session message classification. (production cutover done)
4. Remove active-session/socket dependency from debug flush. (production cutover done)
5. Make debug HTTP/control endpoints authenticated, default-deny, POST for mutation, and lease-based. (production cutover done)
6. Prove debug off/on/failure cannot change business data/control results.

Exit: debug is a physical side channel with bounded metadata-only observation.

### Phase 3: Client composition and control

1. Introduce a narrow client composition root. (Playground composition root contract done; production composition root pending)
2. Introduce control center and explicit capability ports. (Playground control center contract done)
3. Split target, route, transport, session, and terminal-channel ownership.
4. Stop adding SessionContext capabilities; migrate one admitted capability slice at a time.
5. Physically implement `client.terminal_channel` owned paths.

Production progress:
- `client.terminal_channel_mux` now owns `src/lib/terminal-channel-mux-runtime.ts`; `SessionTransportRuntimeStore.terminalChannels` embeds `TerminalChannelMuxStore` and `TargetTransportRuntime` no longer owns `channels`. Registry/docs/AppSDK maps and dedicated store tests are updated. Review and promotion remain pending.
- `client.composition_root` now owns `src/lib/composition-root/client-composition-root.ts`; App binds the declared `plugin-host` port through `ClientCompositionRoot`, validates required ports, and resolves the host from the composition root. Registry/docs/AppSDK maps, production tests, prebuild, and CI are updated. Review and promotion remain pending.
- `client.control_center` and `shared.control_contract` now own production control routing and branded control contracts under `src/lib/control-center/` plus `packages/shared/src/terminal/control-contract.ts`. App routes plugin-host disposal through `ClientControlCenter` and `PluginHostControlNode`; direct App `pluginHost.disposeAll` is removed. Registry/docs/AppSDK maps, ownership/contract tests, prebuild, and CI are updated. Review and promotion remain pending.

Exit: plugins/UI cannot access raw transport/store; no duplicate session/transport owner.

### Phase 4: Client data plane

1. Keep current frame assembly and terminal truth numbering.
2. Separate wire ingress, complete-frame assembly, sparse apply, render window, DOM renderer, and terminal shell.
3. Replace callback back-references with registered directed ports and committed lightweight events.
4. Preserve buffer-sync-only body repaint, renderer visible-range truth, and immutable render snapshots.

Production progress:
- `client.wire_ingress` and `client.buffer_frame_assembly` are active physical owners; `client.sparse_buffer` now owns `src/lib/session-buffer-store.ts` and `client.renderer_window` owns the immutable render projection store. `client.buffer_store` remains the planner/pull/repair orchestrator and no longer owns sparse body or render projection paths.
- `client.dom_renderer` now owns `TerminalView`, `VisibleRow`, `TerminalPreviewRow`, `useMirrorFixedZoomPan`, `cell-render.ts`, and `theme.ts`; `client.terminal_shell` now owns `TerminalPageStageShell.tsx`, shell skin, status/quickbar/copy/keyboard-lift shell files. Registry/docs/AppSDK maps and the v2 test design are updated in lockstep.
- `client.input_normalizer` now owns `src/lib/terminal-input-normalization.ts` and its tests; TerminalPage and TerminalView consume the pure normalizer through registered `client.app_shell -> client.input_normalizer` and `client.dom_renderer -> client.input_normalizer` edges. Registry/docs/wiki/AppSDK maps, ownership tests, prebuild, and CI are updated in lockstep. Review and promotion remain pending; this is a `production_pending_review` slice, not Phase 4 completion.

Exit: source-to-DOM parity passes with no cyclic owner edge.

### Phase 5: Daemon decomposition

1. Keep `server.ts` as composition/transport/HTTP glue only.
2. Split the giant message switch into typed data and control routers.
3. Physically implement `daemon.input_queue` owned paths.
4. Separate source adapter, mirror writer, mirror store, buffer publisher, subscriber, feature control, and feature streams.
5. Preserve daemon no-client-mind and mirror single-writer truth.

Production progress:
- `daemon.control_gateway` now owns `src/server/daemon-control-gateway-runtime.ts` and
  `daemon.control_center` owns `src/server/daemon-control-center-runtime.ts`.
  `terminal-message-runtime.ts` routes schedule and tmux control through the gateway
  and control center; existing wire response/error semantics are preserved by typed
  owner adapters around `terminal-message-control-runtime.ts`. Registry/docs/AppSDK
  maps, ownership/contract tests, prebuild, and CI are updated. Review and promotion
  remain pending; this is a `production_pending_review` first slice, not Phase 5
  completion.
- `daemon.buffer_publisher` now owns `src/server/daemon-buffer-publisher-runtime.ts`
  and `src/server/terminal-buffer-sync-wire.ts`; `terminal-mirror-runtime.ts` only
  calls the publisher boundary for per-subscriber pending-latest, range merge,
  backpressure hysteresis, head fanout, oversized contiguous frame split,
  trace stages, and explicit flush statuses. Module/resource/edge/function/wiki/
  mainline/AppSDK maps and the v2 test design are updated in lockstep; publisher
  tests, mirror backpressure tests, and CI/prebuild wiring are active. Review and
  promotion remain pending; this is a `production_pending_review` first slice, not
  Phase 5 completion.
- `daemon.session_catalog` now owns `src/server/daemon-session-catalog-runtime.ts`:
  backend session catalog construction, backend-qualified `sessionCatalog` rows,
  and `list-sessions` control dispatch. The gateway delegates list-sessions to
  this owner; the schedule control runtime consumes only the shared catalog
  builder for republish. Registry/docs/wiki/AppSDK maps, ownership tests,
  prebuild, and CI are updated. Review and promotion remain pending; this is a
  `production_pending_review` first slice, not Phase 5 completion.
- `daemon.attachment_delivery` now owns
  `src/server/terminal-attachment-message-runtime.ts` for
  `pending-attachments-query`, `attachment-history-query`,
  `attachment-asset-request`, and `attachment-receipt` wire projections.
  `terminal-message-runtime.ts` routes only these four types to the attachment
  owner and no longer owns attachment delivery business state. AppSDK
  function/verification maps, registries, wiki, test design, prebuild, and CI
  are updated. Review and promotion remain pending; this is a
  `production_pending_review` slice, not Phase 5 completion.
- `daemon.file_transfer` now owns
  `src/server/terminal-file-transfer-message-runtime.ts` for
  `paste-image-start`, `attach-file-start`, `paste-image`,
  `file-list-request`, `file-create-directory-request`,
  `file-download-request`, `remote-screenshot-request`,
  `file-upload-start/chunk/end`, and raw binary chunk routing.
  `terminal-message-runtime.ts` routes only these types and chunks to the
  file-transfer message route owner and no longer owns file-transfer facade
  invocation or pending paste/attach projection. AppSDK
  function/verification maps, registries, wiki, mainline call map, test
  design, prebuild, and CI are updated. Review and promotion remain pending;
  this is a `production_pending_review` slice, not Phase 5 completion.
- `daemon.source_adapter` now owns the shared terminal source adapter contract
  in `src/server/terminal-source-adapter.ts`, with dedicated
  kind-normalization tests and real module/edge/feature/function/wiki/AppSDK
  ownership. Backend and mirror capture consumers import the contract from
  this owner; no source or mirror revision ownership moved. Registry/docs/
  AppSDK maps, prebuild, and CI are updated. Review and promotion remain
  pending; this is a `production_pending_review` slice, not Phase 5
  completion.
- `daemon.mirror_writer` now owns
  `src/server/terminal-mirror-capture.ts` for validated terminal source
  capture, source-neutral canonicalization, and authoritative mirror snapshot
  commit writes. `daemon.mirror_store` retains canonical mirror truth,
  revision, and runtime scheduling; `daemon.buffer_publisher` retains
  per-subscriber publication and must not lower mirror capture cadence for a
  slow subscriber. Module/edge/feature/function/wiki/AppSDK maps,
  design, test design, prebuild, and CI are updated. Review and promotion
  remain pending; this is a `production_pending_review` slice, not Phase 5
  completion.

Exit: daemon modules are independently testable and no handler bypasses the declared owner graph.

### Phase 6: Plugin host and Cordis evaluation

1. Implement framework-neutral `PluginHost` contracts.
2. Evaluate Cordis only in Playground through `CordisAdapter`.
3. Prove dependency enforcement, deterministic start/stop/dispose, subscription cleanup, debug auto-registration, and no hot-path interception.
4. If the evaluation fails, fix the adapter/contract or stop explicitly; do not create a second plugin system.

Exit: one plugin host implementation is selected and pinned by evidence.

Production progress:
- `client.plugin_host` now owns `src/lib/plugin-host/` and `shared.plugin_contract`
  owns `packages/shared/src/terminal/plugin-*`. `App.tsx` composes one host-level
  `network:native-snapshot` capability, installs the `network-identity` plugin,
  and consumes only the plugin-provided `network:sample-interfaces` capability.
  Registry/docs/AppSDK maps, capability registry tests, lifecycle tests, and a
  static ownership red test are updated; `test:plugin-host` is wired to prebuild
  and CI. Review and promotion remain pending, so this is a
  `production_pending_review` first slice, not Phase 6 completion.

### Phase 7: UI plugin migration

Migrate in order:

1. debug console;
2. session drawer preview;
3. file browser;
4. settings/update;
5. remote window;
6. quickbar;
7. terminal shell projection.

Each cutover removes its old route/facade/import edge after validation.

Production progress:
- `client.debug_console` now owns the typed debug console UI contract under
  `src/lib/plugin-debug-console/debug-console-contract.ts` and the debug overlay
  under `src/pages/TerminalPageDebugOverlay.tsx`; `shared.plugin_contract` owns
  the typed UI slot registry; the debug console plugin provides
  `terminal.debug-console` through the plugin host, and App/TerminalPage consume
  only the typed slot render callback after plugin host activation. Module/resource/edge/function/wiki/AppSDK
  maps, plugin host tests, debug overlay tests, prebuild, and CI are updated.
  Review and promotion remain pending, so this is a
  `production_pending_review` first slice, not Phase 7 completion.
- `client.session_drawer_ui` now owns the typed session drawer UI slot contract
  under `src/lib/plugin-session-drawer/session-drawer-contract.ts`; the session
  drawer plugin provides `terminal.session-drawer` through the plugin host, and
  App/TerminalPage consume only the typed slot render callback. TerminalPage no
  longer imports or renders `TerminalSessionDrawer` directly. Module/resource/edge/feature/function/wiki/AppSDK
  maps, plugin host tests, session drawer/session preview/tab isolation tests,
  App dynamic refresh tests, prebuild, and CI are updated. Review and promotion
  remain pending, so this is a `production_pending_review` second slice, not
  Phase 7 completion.
- `client.file_browser_ui` now owns the typed file browser UI slot contract
  under `src/lib/plugin-file-browser/file-browser-contract.ts`; the file
  browser plugin provides `terminal.file-browser` through the plugin host, and
  App/TerminalPage consume only the typed slot render callback. TerminalPage no
  longer imports or renders `FileTransferSheet` directly. Module/resource/edge/feature/function/wiki/AppSDK
  maps, plugin host tests, TerminalPage render isolation, App dynamic refresh,
  prebuild, and CI are updated. Review and promotion remain pending, so this is
  a `production_pending_review` third slice, not Phase 7 completion.
- `client.settings_update_ui` now owns the typed settings update UI slot
  contract under `src/lib/plugin-settings-update/settings-update-contract.ts`;
  the settings update plugin provides `settings.update` through the plugin
  host, and App/SettingsPage consume only the typed slot render callback.
  SettingsPage no longer imports or renders `AppUpdateSection` directly.
  Module/resource/edge/feature/function/wiki/AppSDK maps, plugin host tests,
  SettingsPage plugin render, App dynamic refresh, prebuild, and CI are
  updated. Review and promotion remain pending, so this is a
  `production_pending_review` fourth slice, not Phase 7 completion.
- `client.remote_window_ui` now owns the typed remote window UI slot contract
  under `src/lib/plugin-remote-window/remote-window-contract.ts`; the remote
  window plugin provides `terminal.remote-window` through the plugin host, and
  App/TerminalPage consume only the typed slot render callback. TerminalPage no
  longer imports or renders `RemoteWindowOverlay` directly.
  Module/resource/edge/feature/function/wiki/AppSDK maps, plugin host tests,
  TerminalPage remote-window overlay/IME tests, App dynamic refresh, prebuild,
  and CI are updated. Review and promotion remain pending, so this is a
  `production_pending_review` fifth slice, not Phase 7 completion.
- `client.quickbar_ui` now owns the typed quickbar UI slot contract under
  `src/lib/plugin-quickbar/quickbar-contract.ts`; the quickbar plugin provides
  `terminal.quickbar` through the plugin host, and App/TerminalPage consume
  only the typed slot render callback. TerminalPage no longer imports or
  renders `TerminalQuickBar` directly. Module/resource/edge/feature/function/
  wiki/AppSDK maps, plugin host tests, TerminalPage render isolation, App
  dynamic refresh, prebuild, and CI are updated. Review and promotion remain
  pending, so this is a `production_pending_review` sixth slice, not Phase 7
  completion.
- `client.terminal_shell_ui` now owns the typed terminal shell UI slot
  contract under `src/lib/plugin-terminal-shell/terminal-shell-contract.ts`;
  the terminal shell plugin provides `terminal.shell` through the plugin host,
  and App/TerminalPage consume only the typed slot render callback.
  TerminalPage no longer imports or renders `TerminalConnectionStatusStrip`,
  `TerminalPageCopyMenu`, `TerminalPageStageShell`, `terminal-page-shell-ui`,
  `TerminalQuickBarShell`, or `TerminalNetworkBanner` directly.
  Module/resource/edge/feature/function/wiki/AppSDK maps, plugin host tests,
  TerminalPage render isolation, App dynamic refresh, prebuild, and CI are
  updated. Review and promotion remain pending, so this is a
  `production_pending_review` seventh slice, not Phase 7 completion.

### Phase 8: Closeout

For every AppSDK promotion unit:

1. EvidenceRecord;
2. ReviewRecord PASS;
3. compile candidate and bind artifact/public API hashes;
4. PromotionRecord;
5. publish immutable Active artifact;
6. archive source/contracts/evidence to Protected;
7. RegressionReport with exact input/source/artifact bindings;
8. FreezeRecord;
9. `appsdk verify .` and Protected history audit.

## 7. Verification Matrix

| level | required evidence | proves |
| --- | --- | --- |
| AppSDK | `appsdk verify .`, lock and record graph checks | governance validity and lifecycle binding |
| L0 architecture | registry/schema/owner/import/call/DAG/plane-isolation gates | machine boundaries match source |
| L1 contracts | node lifecycle, data/control/debug/error/plugin unit tests | typed semantics and cleanup |
| L1 owners | exact client/daemon owner tests, positive and negative | slice behavior and forbidden paths |
| L2 daemon | daemon/tmux mirror close loop, source/input/control probes | real daemon/backend path |
| L3 client | transport/channel/buffer/render/input integration | client runtime chain |
| L4 shell | page/plugin/IME/drawer/preview interaction tests | UI projection behavior |
| L5 device | APK install/update, real Android path, source-to-DOM/input evidence | packaged behavior |
| review | architecture review with explicit PASS after all applicable gates | final boundary and regression review |

Minimum commands after runtime implementation:

```bash
appsdk verify .
pnpm run test:feature-registry
pnpm run test:debug-observability
pnpm exec tsc -p tsconfig.json --noEmit --pretty false
pnpm test -- --run
pnpm run build
pnpm run daemon:mirror:close-loop
```

Use the feature/verification map to narrow or extend the command set. Runtime-affecting slices also require the matching L3-L5 evidence; unit tests alone are not completion.

## 8. Positive and Negative Gates

Required paired tests include:

- data frame reaches only the adjacent data owner; control/debug consumers cannot receive it;
- command reaches exactly one owner; unknown or duplicate owner fails;
- debug subscriber receives bounded metadata; debug overflow/failure does not block data/control;
- snapshot is versioned and immutable; duplicate node producer fails;
- plugin receives declared capabilities; undeclared/raw access fails before activation;
- incomplete frame never publishes; complete frame publishes once;
- buffer commit schedules one renderer commit; renderer cannot request transport directly;
- daemon control cannot mutate mirror except through the registered business owner;
- module graph has no cycle; an unregistered import/call edge fails;
- debug/control fields in business payload metadata fail schema/gate validation;
- old SessionContext/raw-send/giant-switch route cannot return after cutover.

## 9. Risks and Controls

| risk | control |
| --- | --- |
| broad rewrite changes behavior | owner-sized slices, one cutover at a time, parity evidence |
| target maps are mistaken for active truth | keep entries `design`/`pending` until physical paths and gates exist |
| event bus duplicates business truth | events remain lightweight committed facts; bodies stay in owner stores/streams |
| debug affects hot path | bounded metadata, independent queue/backpressure, drop counter |
| Cordis instability leaks into core | framework-neutral PluginHost and isolated adapter |
| SessionContext replacement becomes another god object | capability ports, import/DAG gates, no global service lookup |
| daemon router becomes another god object | router performs validation/routing only; one owning handler per type |
| shared protocol change breaks compatibility | preserve business payload semantics and add protocol positive/negative tests |
| dirty worktree mixes unrelated changes | edit/stage/commit only exact AppSDK v2 paths |

## 10. Definition of Done

The task is complete only when:

- the v2 registry entries are active and every source file has exactly one owner;
- data/control/debug/error contracts are physically and type-level separated;
- client and daemon control/debug centers have narrow ownership and no business truth;
- all required runtime nodes expose bounded debug subscription and versioned snapshots;
- client features consume capability-scoped plugins through one plugin host;
- terminal buffer, renderer, shell, connection, terminal channel, input, daemon mirror, and input queue are independent physical modules;
- SessionContext/server/message-runtime legacy cross-domain ownership is physically removed;
- all required L0-L5 gates for touched surfaces pass;
- online source-to-DOM and input/control behavior matches the pre-refactor baseline;
- AppSDK Evidence, Review PASS, Promotion, Regression, Active, Protected, and Freeze graph verifies;
- no Playground/Generated/Protected source is a runtime dependency;
- no fallback, shadow route, second owner, or second SDK remains.
