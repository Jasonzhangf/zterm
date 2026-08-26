# ZTerm Cordis v2 跨平台重建架构

- Design ID: `ZTERM-CORDIS-V2-DESIGN-001`
- Status: proposed baseline; implementation starts only after Phase 0 admission
- Production baseline: `d0f17b709873a7b4571b00f2ce32f428aae1b6ae`
- Target branch: `codex/zterm-v2-cordis-rebuild-20260825`
- Scope: Android, macOS, Windows, iOS application architecture
- Non-scope: `../wterm` runtime source; terminal protocol/business payload redesign

## 1. Decision

ZTerm v2 uses the following composition:

```text
Platform Host
  Android: Activity/WebView + ForegroundService
  iOS: WKWebView/Capacitor host + native lifecycle adapter
  macOS: Electron main/preload + renderer
  Windows: Electron main/preload + renderer
        |
        | typed IPC / command / event / snapshot / stream handle
        v
ZTerm Application Kernel (per process)
  Cordis context + services + plugin lifecycle + capability registry
        |
        v
ZTerm Domain Core (platform/framework neutral)
  session projection, route policy, commands, reducers, selectors,
  protocol codecs, persistence contracts, error/control contracts
        |
        v
UI Host
  UI contract + platform shell + React renderer plugins
```

Cordis is an in-process composition and lifecycle framework. Each process owns
its own Cordis context. No Cordis `Context`, service object, plugin instance,
React component, callback, or fiber crosses a process or IPC boundary.

Cordis is not allowed to own terminal bytes, video/audio frames, file chunks,
WebRTC RTP, buffer-sync bodies, or high-frequency pointer/scroll streams. Those
paths retain dedicated typed transports with explicit ordering and backpressure.

## 2. Current baseline and migration gap

The production tree already contains an Android-only v2 ownership migration and
a framework-neutral `PluginHost`, but it is not the cross-platform target:

- `packages/shared/src/terminal/plugin-contract.ts` imports `ReactNode`; this
  is a React ABI, not a platform-neutral UI ABI.
- Android has `ClientCompositionRoot`, `PluginHostRuntime`, typed UI slots, and
  AppSDK registries. These are source material and parity references, not a
  license to copy Android runtime ownership into desktop/iOS.
- macOS and Windows already have platform shell/runtime registry boundaries;
  they need to consume the same core contracts, not duplicate terminal truth.
- Cordis is not currently a production dependency. Phase 2 evaluates a pinned
  adapter in Playground before any production dependency or cutover.

Migration rule: preserve v1 behavior and payload semantics; replace ownership
and composition boundaries one slice at a time. Existing production v1 remains
the parity oracle until each v2 slice has matching evidence.

## 3. Ownership layers

### 3.1 Shared domain core

Owns serializable contracts and pure semantics only:

- `SessionId`, target identity, route plan, lifecycle state, selectors;
- `ClientAction`, `ControlCommand`, committed domain event, typed error;
- snapshot/version contracts and codec validation;
- plugin manifest, capability ID, permission, UI surface contribution;
- persistence schema and migration contract;
- parity fixtures and behavior-level test vectors.

Forbidden: React/DOM, Capacitor, Electron, Swift/Kotlin/Win32, Cordis imports,
socket ownership, transport retry, renderer state, terminal buffer truth.

### 3.2 Application kernel

Every process may create a local kernel with these owners:

- `CompositionRoot`: explicit service/port binding and validation;
- `CapabilityRegistry`: unique provider resolution and permission checks;
- `PluginLifecycle`: install/start/stop/dispose ordering and cleanup;
- `ControlCenter`: authorization, deadline, idempotency, correlation, audit;
- `ProjectionRegistry`: immutable state/snapshot projection for UI;
- `ObservabilityHub`: bounded metadata-only debug side channel.

`CordisAdapter` is the only owner allowed to translate these contracts to
Cordis context/service/plugin/fiber primitives. Core contracts remain usable
without Cordis for tests and for platform processes where Cordis is not needed.

### 3.3 Platform host

Platform hosts own OS lifecycle and native resources:

| Platform | Owns | Must not own |
| --- | --- | --- |
| Android | foreground service, native network, WebView bridge, IME/notifications/permissions | React UI truth, domain reducers, Cordis across Service/WebView |
| iOS | background/lifecycle policy, native bridge, permissions, notifications | WebView plugin business truth, terminal stream policy |
| macOS | Electron main/preload, window/menu, local tmux adapter, native dialogs | renderer buffer truth, shared domain state duplication |
| Windows | Electron main/preload, Windows/ConPTY adapter, packaging | Mac adapter reuse, second renderer/mirror/transport |

Platform adapters expose typed ports to the application kernel. They never
become UI plugins and never pass raw native objects through shared contracts.

### 3.4 UI plugin ABI

The UI contract is framework-neutral:

```ts
type SurfaceId = string;
type CapabilityId = string;

interface UiContribution {
  readonly surfaceId: SurfaceId;
  readonly route: string;
  readonly viewModelSchema: string;
}

interface ClientAction {
  readonly type: string;
  readonly payload: unknown;
}

interface UiPluginManifest {
  readonly pluginId: string;
  readonly requires: readonly CapabilityId[];
  readonly contributes: readonly UiContribution[];
}
```

`@zterm/ui-contract` contains no React types. `@zterm/ui-react` adapts a
framework-neutral surface/view-model/action contribution to React components,
hooks, slots, and mobile/desktop shells. Future Compose, SwiftUI, or WinUI
adapters implement the same contract without implementing React ABI.

UI plugins may own layout, local ephemeral UI state, selectors, view models,
surface contributions, and action mapping. They may not own sockets, reconnect,
route probing, WebRTC, reliable input queues, daemon sessions, terminal buffers,
mirror truth, persistence truth, or background services.

## 4. IPC and data/control separation

Each process boundary exposes only serializable typed messages:

- commands: request a state transition;
- committed events: report owner-committed facts;
- snapshots: read immutable current projection;
- stream handles: dedicated data-plane transport with sequence/backpressure;
- errors: explicit typed error chain.

Control/debug/routing/retry/provider/health/snapshot semantics cannot enter
business request/response `metadata`. Business payload cannot reconstruct
control state. Validation rejects contamination at codec and architecture-gate
levels; no request-side cleanup or silent stripping.

Recommended gateway:

```ts
interface RuntimeGateway {
  execute<C, R>(command: ControlCommand<C>): Promise<ControlOutcome<R>>;
  subscribe(listener: (event: RuntimeEvent) => void): Disposable;
  readSnapshot(): Promise<RuntimeSnapshot>;
  openDataStream(request: DataStreamRequest): Promise<DataStreamHandle>;
}
```

The gateway is a boundary adapter, not a second domain owner. Terminal bytes,
video, audio, file chunks, and large buffer frames use `openDataStream`; they do
not become Cordis events.

## 5. Resource and module ownership

Initial resource IDs:

| Resource | Owner | Plane |
| --- | --- | --- |
| `resource.domain_state` | `shared.domain_core` | business truth |
| `resource.runtime_kernel` | `app.kernel` | control/lifecycle |
| `resource.cordis_context` | `app.cordis_adapter` | composition |
| `resource.ui_projection` | `app.projection_registry` | projection |
| `resource.platform_bridge.<platform>` | platform host | IPC/native |
| `resource.terminal_data_stream` | terminal transport owner | data |
| `resource.debug_snapshot_registry` | observability owner | debug |
| `resource.plugin_registry` | plugin lifecycle owner | control |

No resource gets two writers. `resource.cordis_context` is never a business
truth resource. `resource.ui_projection` is derived and cannot write domain
state. A registry entry is target state until the physical path and gate exist.

## 6. Migration boundaries

V1 remains executable and untouched outside the v2 worktree. V2 uses these
one-way boundaries:

1. v1 production behavior -> parity fixture and black-box oracle;
2. platform adapter -> typed gateway;
3. gateway -> kernel command/event/snapshot ports;
4. kernel -> domain core contracts/selectors;
5. kernel -> UI plugin contribution;
6. UI plugin -> action dispatch and projection read only.

No dual production route, shadow writer, silent fallback, or permanent
compatibility adapter. Compatibility codecs are time-bounded, explicitly
versioned, and removed after the parity gate closes.

## 7. Non-negotiable gates

- every source file has exactly one module owner;
- every cross-module import/call is registered and adjacent;
- module graph is acyclic;
- shared core has zero platform/UI/Cordis imports;
- UI plugins have no raw transport/store/native imports;
- Cordis appears only in adapter/kernel process-local paths;
- control/debug/provider/retry/health fields cannot enter business payload;
- data streams never route through Cordis event bus;
- lifecycle has positive and negative tests for start/stop/dispose and stale
  generation;
- each migrated feature passes v1/v2 parity, build, packaged smoke, and the
  platform-specific live gate before the next claim opens;
- v2 branch does not modify `../wterm` or copy runtime source.

## 8. Open decisions intentionally deferred

- exact Cordis package/version and adapter API: Phase 2 evidence;
- iOS host implementation details: Phase 1 platform contract, Phase 7 host;
- React versus future native renderer: `ui-contract` now, renderer adapter
  selected per platform later;
- daemon process Cordis adoption: only if it improves composition without
  pulling data-plane ownership into Cordis; default is no Cordis in daemon
  hot path.
