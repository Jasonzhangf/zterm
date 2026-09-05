# Runtime Memory Truth

Date: 2026-09-05

Status: user-confirmed target design plus code-verified current implementation.

This decision separates current implementation truth from target design truth.
Target truth must not be reported as implemented until its source owner and
runtime gates pass.

## Current Implementation

### Terminal data path

```text
tmux / Herdr / WezTerm
  -> TerminalSourceAdapter
  -> daemon.mirror_writer
  -> daemon.mirror_store
  -> daemon.buffer_publisher
  -> physical transport / mux channel
  -> client.buffer_frame_assembly
  -> client sparse buffer / buffer store
  -> renderer window
  -> DOM terminal renderer
  -> terminal shell
  -> container / layout / App projection
```

- The daemon owns canonical absolute-row terminal truth. It does not own client
  tab, session projection, foreground/background, renderer, or UI state.
- `daemon.buffer_publisher` owns contiguous wire ranges, frame splitting,
  subscriber pending state, and backpressure.
- Client frame assembly accepts a split authoritative frame only after complete
  continuous coverage.
- The client buffer stores absolute rows, supports sparse holes, repairs visible
  ranges, preserves useful cached rows across reconnect, and evicts rows as its
  rolling window moves.
- The renderer owns visible range, follow, reading, and `renderBottomIndex`. It
  does not own buffer production or transport requests.
- The daemon default mirror retention is 3000 lines. The current shared/client
  default and maximum are still 1000 lines.
- The current daemon compares changed rows across its complete canonical mirror
  window. Initial `forceRevision` publication can publish the complete mirror
  window.
- A three-screen request window exists in
  `packages/shared/src/terminal/viewport-utils.ts`, but current initial daemon
  publication is not restricted to that window.

### Client composition

```text
App.tsx
  -> ClientCompositionRoot
       -> local PluginHost
       -> ClientControlCenter
```

The production client currently uses `ClientCompositionRoot` and the local
`PluginHost`. Cordis exists only behind the process-local Playground
`CordisAdapter`; it is not the production composition owner.

### Connection and Relay

```text
daemon
  -> configured Relay login
  -> host control WebSocket
  -> endpoint / machine / session directory publication

client
  -> Relay login
  -> access-token persistence
  -> device control WebSocket
  -> daemon directory projection

AndroidConnectionService
  -> native WebSocket / mux / heartbeat / reconnect

TypeScript TraversalSocket
  -> RTC direct / TURN traversal paths
```

- The daemon reads Relay credentials and URL from environment or the current
  JSON configuration.
- The client currently persists username, access token, and Relay settings, but
  not the plaintext password.
- Production client code still contains a fixed default Relay URL.
- `AndroidConnectionService` currently owns WebSocket/mux physical lifecycle
  but explicitly rejects native WebRTC. UDP/WebRTC traversal remains in
  TypeScript.
- The TypeScript Auto order currently begins
  `LAN -> RTC direct -> Tailscale`; the native Service currently begins
  `LAN -> Tailscale`.

## Confirmed Target Design

### Daemon, buffer, renderer, and UI

```text
terminal source
  -> daemon canonical absolute-row truth
  -> contiguous buffer publication
  -> route-selected physical connection
  -> client transport service
  -> client session service
  -> client buffer service
  -> client renderer service
  -> terminal/video renderer
  -> container/layout
  -> UI projection
```

- The daemon owns source capture, canonical mirror truth, and publication from
  that truth. It never owns client state.
- Every connection starts from the current daemon tail truth.
- Ordinary live comparison is bounded to the latest terminal screen. Rows in
  that tail remain mutable even when their absolute row numbers do not change.
- When absolute movement exceeds one screen, old content is not continuously
  compared; the daemon continues from the latest tail window.
- Every logical body publication covers a continuous absolute range. A client
  cache may contain holes.
- The client buffer is an absolute-row sparse rolling window. Its default span
  is 3000 lines and is configurable. The maximum is not defined by this
  decision.
- Initial synchronization is head/tail first, followed by a continuous catch
  of at most three screens. Older history is fetched on demand.
- Reconnect preserves cached rows that remain useful and in range.
- The renderer declares visible demand. The buffer owns hole detection and
  range repair.
- `stable/live` is not a client buffer or renderer layer. The daemon cannot
  lock a stable TUI region because it does not own reflow truth.
- Terminal rendering, video rendering, container/layout, and UI composition
  remain separate owners.

### Cordis composition

```text
Cordis composition and lifecycle
  -> fixed service/node: transport
  -> fixed service/node: session
  -> fixed service/node: buffer
  -> fixed service/node: renderer
  -> UI and business capability plugins
```

Cordis is the target production composition/lifecycle owner. It carries
capability and lifecycle control, not terminal, file, or media body payloads.
Migration must end with one production owner; the local PluginHost and
ClientCompositionRoot must not remain as a second production composition path.

### Connection ownership and route order

```text
Relay control plane
  daemon -> configured Relay WebSocket -> endpoint/presence updates
  client -> configured Relay WebSocket -> directory projection

Android physical connection owner
  Android Service
    -> LAN
    -> UDP direct
         -> IPv4 candidate
         -> IPv6 candidate
    -> Tailscale
    -> Relay
```

- Client and daemon actively maintain Relay control-plane connections and
  publish their reachable private/LAN, public, Tailscale, and WebSocket state.
- Relay holds daemon machine identity, endpoint candidates, presence, and
  heartbeat/control state.
- IPv4 and IPv6 are address families inside `UDP direct`, not independent route
  priority tiers.
- Android Service is the target owner of physical connection state, route
  selection, heartbeat, and reconnect. UI only projects snapshots/settings and
  emits typed reconnect or route intents. Foreground/background does not
  recreate healthy connections.

### Configuration and credentials

```text
~/.zterm/config.json
  -> validated one-time migration
  -> atomic ~/.zterm/config.toml
  -> read-back verification
  -> config.toml becomes the only runtime configuration truth
```

- Relay URL and Relay startup settings come from `~/.zterm/config.toml`; no
  production Relay URL is hardcoded.
- Existing `~/.zterm/config.json` data must be migrated. After successful
  migration, JSON is not a runtime fallback or second truth.
- Migration failure is explicit and must not silently select a built-in Relay.
- The client must not persist plaintext Relay passwords. It may persist a
  password-derived hash/verifier only through a fair, established,
  non-replayable industry authentication design.
- The concrete authentication protocol is intentionally deferred to a separate
  design. This decision does not select a challenge protocol, PAKE, token
  rotation algorithm, or secure-storage implementation.

## Implementation Gaps

The following are target migrations, not completed runtime facts:

1. Change the shared/client default retention from 1000 to configurable 3000
   without assuming that 3000 is the maximum.
2. Bound ordinary daemon live comparison to the final screen and make initial
   synchronization head/tail plus at most three screens.
3. Replace the production local composition path with the confirmed Cordis
   fixed-service model.
4. Move UDP/WebRTC/Relay physical connection ownership into Android Service.
5. Normalize route tiers to
   `LAN -> UDP direct -> Tailscale -> Relay`, with IPv4/IPv6 inside UDP direct.
6. Add validated JSON-to-TOML migration, remove fixed Relay defaults, and make
   `~/.zterm/config.toml` the sole runtime configuration source.
7. Design and migrate the non-replayable password-derived credential protocol.
