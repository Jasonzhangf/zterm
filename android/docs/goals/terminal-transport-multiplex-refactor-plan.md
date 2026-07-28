# Terminal Transport Multiplex Refactor Plan

Date: 2026-07-20
Feature: `terminal.transport_lifecycle`

## 1. Goal And Acceptance

Goal: replace the current per-session physical terminal WebSocket model with one long-lived daemon-target transport owned by `client.daemon_connection`, with terminal sessions multiplexed as logical channels on that transport.

Acceptance:
- Opening 10 terminal sessions on the same daemon target creates one terminal physical transport, not 10 session transports.
- Session switch does not create, close, or rebuild a physical WebSocket while the daemon-target transport is still open.
- Each terminal session has an independent logical channel for input, resize, body subscription, head request, range request, file transfer, schedule, screenshot, and remote-window control messages.
- Buffer, input, ack, body-subscription, adaptive-width lease, file transfer, and schedule responses cannot cross sessions.
- Inactive tabs only set channel body subscription to false; they do not close channel, detach mirror, or close the physical target transport.
- Physical target close/stale cleanup detaches all channels through the existing daemon subscriber detach owner and leaves tmux sessions/mirror truth intact.
- Backpressure on one channel cannot permanently delay or corrupt another channel; active input/control/ack always outranks body frames.
- The new Android path does not silently fall back to per-session sockets. If a daemon does not advertise multiplex capability, the client exposes an explicit upgrade-required error.
- Relay recovery is target-scoped and client-device-scoped: after a Relay/WebRTC physical route has been established, the Relay server may keep only an idle-timeout bounded peer lease for that account, daemon target, and concrete client device id. It must not keep session/channel/tmux/UI truth, and it must explicitly fail missing device identity, expired, or mismatched resumes.
- Daemon release, Android APK, function map, resource map, mainline call map, test design, gates, and live black-box evidence are all updated before completion is claimed.

## 2. Evidence-First Diagnosis Contract

### Symptom

Observed:
- The current design creates an independent session transport per terminal session. With 10 open sessions, the model tends toward 10 session WebSocket/RTC transports for one daemon target.
- Current live daemon probe at `http://127.0.0.1:3333/health` returned `sessions.total=0`, `mirrors.total=2`, `subscribers=0`; no live 10-session phone reproduction was available in this analysis. The root-cause conclusion below is based on source and architecture proof, not a live multi-session count.

Expected:
- A daemon target should have one physical transport. Multiple terminal sessions should be logical channels on that transport.

Entry:
- Android SessionContext terminal transport open/resume/session-switch flow.

Raw evidence:
- `android/src/lib/session-transport-runtime.ts`: `SessionTransportRuntime` stores `activeSocket` per `sessionId`; target runtime stores only `controlTransport`.
- `android/src/contexts/session-context-transport-runtime.ts`: same-target control transport is reused for `session-open`, but session bodies are still opened as separate session transports.
- `android/src/contexts/session-context-transport-open-runtime.ts` and `client.daemon_connection`: after target-open intent, the client opens or reuses one daemon-target physical transport and then materializes a terminal channel. No per-session physical socket may be created.
- `android/src/server/terminal-runtime.ts`: `createTransportSubscriber()` binds one `connection.transportId` to one subscriber and writes `connection.boundSubscriberId`.
- `android/src/server/terminal-message-runtime.ts`: input/buffer/schedule/file handlers resolve session from `connection.boundSubscriberId`.
- `packages/shared/src/connection/protocol.ts`: session-bound messages are not wrapped in a channel envelope.
- `android/src/traversal-relay/server.ts`: `registerClient()` currently creates a fresh random `peerId` for every phone signaling socket and sends `relay-peer-close` on close/error.
- `android/src/server/relay-client.ts`: daemon host client forwards `relay-peer-close` into `closeRelayPeer()`.
- `android/src/server/rtc-bridge.ts`: `closePeer()` closes and deletes the RTCPeerConnection. Current Relay reconnect is therefore a cold peer rebuild, not idle resume.

### SOP / Model Flow

Status: known flow.

Flow id: `terminal.transport_lifecycle`.

Source docs:
- `android/docs/resource-map.md`
- `android/docs/function-map.md`
- `android/docs/feature-gates.md`
- `android/docs/wiki/mainline-call-map.json`
- `.agents/skills/terminal-buffer-truth/SKILL.md`
- `android/docs/testing/websocket-transport-reuse-test-design.md`

Current lifecycle nodes:

```text
OpenTab / foreground / explicit resume intent
-> SessionContext lifecycle primitive
-> target control transport reuse
-> session-open / target-open intent
-> daemon-target physical transport open
-> terminal channel open
-> daemon create one transport subscriber
-> daemon attach subscriber to tmux mirror
-> mirror push / explicit head/range
-> client socket-message dispatch
-> sparse buffer apply
-> renderer commit
```

Resource edges currently in use:
- `resource.active_session -> resource.session_transport`
- `resource.session_transport -> resource.transport_target`
- `resource.session_transport -> resource.transport_subscriber`
- `resource.transport_subscriber -> resource.mirror_store`
- `resource.mirror_store -> resource.client_sparse_buffer`

Forbidden edges:
- UI/drawer must not open WebSockets directly.
- Daemon must not own active tab, foreground, viewport, renderer follow, or client session identity.
- Buffer/renderer must not compensate for transport/channel identity mistakes.
- Remote-window/file-transfer must not create a second transport owner.

### Hypotheses

H1 confirmed: Physical transport and terminal subscriber are currently coupled one-to-one.
- Supporting evidence: daemon `TerminalTransportConnection.boundSubscriberId` is a single value; message handlers derive session from that value.
- First divergence: `client.daemon_connection.openSessionTargetTransport()` after target-open intent still materializes a physical socket at the wrong layer instead of remaining a unique daemon-target owner that later opens channels.
- Confidence: 95.

H2 ruled out as primary root cause: control socket is not reused.
- Counter evidence: target runtime already stores `controlTransport`; `ensureControlTransportForSessionOpen()` flushes pending opens over an existing open control socket.
- Confidence: 90.

H3 downstream risk: route/reconnect bugs can create extra replacement sockets.
- Supporting evidence: reuse planner exists for same-session socket reuse and route-aware target keys.
- Counter evidence: even perfect same-session reuse still leaves one body socket per opened session.
- Confidence: 85.

Confirmed root cause:
- The protocol lacks a channel envelope, and daemon runtime treats the physical transport as the subscriber identity. Therefore multiple sessions require multiple physical transports by construction.

Unique owner:
- `terminal.transport_lifecycle`, spanning shared protocol, Android SessionContext transport runtime, and daemon terminal transport/message/runtime modules.

Allowed edit surface for implementation:
- `packages/shared/src/connection/protocol.ts`
- new shared pure helpers under `packages/shared/src/connection/**` or `packages/shared/src/terminal/**`
- `android/src/lib/session-transport-runtime.ts`
- `android/src/contexts/session-context-transport-*.ts`
- `android/src/contexts/session-context-session-runtime.ts`
- `android/src/contexts/session-context-socket-message-runtime.ts`
- `android/src/contexts/session-context-input-runtime.ts`
- `android/src/contexts/session-context-buffer-runtime.ts`
- `android/src/contexts/session-context-transfer-runtime.ts`
- `android/src/contexts/session-context-remote-window-runtime.ts`
- `android/src/server/terminal-runtime-types.ts`
- `android/src/server/terminal-runtime.ts`
- `android/src/server/terminal-bridge-runtime.ts`
- `android/src/server/terminal-message-runtime.ts`
- `android/src/server/terminal-message-control-runtime.ts`
- `android/src/server/terminal-transport-runtime.ts`
- `android/src/server/terminal-mirror-runtime.ts`
- `android/src/server/terminal-daemon-runtime.ts`
- related tests, docs, function/resource/mainline maps, local skills

Forbidden edit surface:
- Terminal renderer as a transport/channel fix.
- `TerminalSessionDrawer` or `TerminalPage` as a WebSocket lifecycle owner.
- Relay route selection as a channel identity fix.
- Remote-window capture/video as terminal transport truth.
- Any UI-side filtering to hide session/body cross-talk.

## 3. Target Architecture

### Resource Model

Add or split resources before code:

```text
resource.daemon_target_transport
  one physical WebSocket/RTC datachannel per daemon target route

resource.terminal_channel
  one logical terminal channel per open local session on that target transport

resource.relay_peer_lease
  one idle-timeout bounded Relay peer/signaling lease for one account + daemon target + concrete client device

resource.transport_subscriber
  daemon-side physical subscriber for one channel, not for the whole connection
```

Required relation update:

```text
resource.active_session
  -> resource.session_transport
  -> resource.daemon_target_transport
  -> resource.terminal_channel
  -> resource.transport_subscriber
  -> resource.mirror_store
```

`resource.session_transport` remains the client-facing feature boundary, but its physical socket truth moves to daemon target level. The session-local runtime becomes a channel runtime.

Relay relation:

```text
resource.daemon_target_transport
  -> resource.relay_peer_lease
  -> resource.transport_target
```

`resource.relay_peer_lease` is route/signaling truth only. It may rebind the same phone signaling socket identity to a still-valid peer before idle timeout, but missing client device id is rejected, another phone gets a different peer lease, and the lease must not own `resource.terminal_channel`, `resource.transport_subscriber`, `resource.tmux_session`, `resource.mirror_store`, active tab, foreground, viewport, or renderer truth.

### Protocol Shape

Introduce an explicit multiplex protocol version. Names may be adjusted during implementation, but the semantics must stay stable.

Client to daemon:

```ts
type TerminalMuxClientFrame =
  | { type: 'mux-hello'; payload: { version: 1; clientInstanceId: string } }
  | { type: 'mux-target-message'; payload: { requestId?: string; message: TargetControlMessage } }
  | { type: 'mux-channel-open'; payload: { channelId: string; sessionName: string; geometry?: TerminalGeometry; widthMode?: TerminalWidthMode; autoCommand?: string } }
  | { type: 'mux-channel-message'; payload: { channelId: string; message: ChannelClientMessage } }
  | { type: 'mux-channel-close'; payload: { channelId: string; reason?: string } }
  | { type: 'mux-ping'; payload: { sentAt: number } };
```

Daemon to client:

```ts
type TerminalMuxServerFrame =
  | { type: 'mux-ready'; payload: { version: 1; daemonHostId?: string; capabilities: TerminalMuxCapabilities } }
  | { type: 'mux-target-message'; payload: { requestId?: string; message: TargetControlServerMessage } }
  | { type: 'mux-channel-opened'; payload: { channelId: string; sessionName: string; capabilities?: TerminalSessionCapabilitiesPayload } }
  | { type: 'mux-channel-message'; payload: { channelId: string; message: ChannelServerMessage } }
  | { type: 'mux-channel-closed'; payload: { channelId: string; reason: string; code?: string } }
  | { type: 'mux-pong'; payload: { sentAt: number; receivedAt: number } }
  | { type: 'mux-error'; payload: { code: string; message: string; channelId?: string } };
```

Relay resume protocol:
- Android stores a per-install Relay client `deviceId` and includes it in `/ws/client`.
- Reconnect within idle timeout may use the same account, hostId, and client device identity to rebind to the existing peer lease.
- Relay server either rebinds the phone signaling socket to the existing peer lease and keeps the same `peerId`, or returns an explicit `deviceId is required`, `resume-expired`, `resume-mismatch`, or `host-offline` error.
- Peer id / device id is never a terminal session id, channel id, tmux id, or UI state id.

Channel-bound messages:
- `input`
- `resize`
- `body-subscription`
- `buffer-head-request`
- `buffer-sync-request`
- schedule messages
- file transfer messages
- screenshot messages
- remote-window request/status/control messages when invoked from a terminal context
- debug-log/debug-snapshot with channel metadata only

Target-level messages:
- `list-sessions`
- `tmux-create-session`
- `tmux-rename-session`
- `tmux-kill-session`
- target-level debug control
- future target-level capability queries

Compatibility:
- New Android code must use the multiplex path only after `mux-ready`/capability is confirmed.
- If capability is missing, expose a clear "daemon upgrade required for terminal multiplex transport" error.
- If legacy daemon compatibility is retained for old installed clients, it must be an explicit protocol-version branch in daemon tests with a removal plan. It must not be a hidden fallback for new Android multiplex failures.

### Identity Rules

- `channelId` is transport-local wire identity. It is not daemon-owned active tab truth.
- Daemon may store `connection.channels[channelId] -> subscriberId` only while the physical target transport exists.
- Daemon must not persist channel ids across process restarts and must not treat Android local `sessionId` as daemon business truth.
- Client maps `localSessionId -> channelId` in the transport runtime store.
- Every response that can affect a session buffer/input/file/schedule state must carry `channelId`.

### Send Scheduling

One physical WebSocket introduces head-of-line blocking risk. Add one send scheduler owner for mux transports:

Priority lanes:
- P0: `mux-error`, `mux-channel-closed`, `input-ack`, open/close replies, ping/pong.
- P1: active channel input-adjacent responses, `buffer-head`, target control replies.
- P2: active channel `buffer-sync`.
- P3: preview/live-set channel `buffer-sync`.
- P4: inactive channel explicit replies and debug metadata.

Body coalescing:
- Do not queue unbounded body frames.
- Keep at most one pending latest body update per channel from current mirror truth.
- Pending body flush must read the current mirror store at send time; do not store old serialized cells as truth.
- Never drop input, ack, channel close, or error frames.

## 4. Mainline Call Map Changes

Add new mainline nodes before source edits:

```text
Android:
SessionRuntime -> TargetTransportRuntime
TargetTransportRuntime -> MuxHandshake
TargetTransportRuntime -> ChannelRuntime
ChannelRuntime -> ChannelMessageSend
MuxSocketMessage -> ChannelDemux
ChannelDemux -> BufferApply
ChannelDemux -> InputAckRuntime

Daemon:
BridgeConnection -> MuxHandshake
MuxHandshake -> TargetControlRuntime
MuxHandshake -> ChannelAttachRuntime
ChannelAttachRuntime -> TransportSubscriber
ChannelMessageRuntime -> TerminalMessageRuntime
TransportSendScheduler -> PhysicalTransport
PhysicalTransportClose -> DetachAllChannels
```

Every edge must have a deterministic `edge_id`, owner feature, resource_from/resource_to, and relation status in `docs/wiki/mainline-call-map.json`.

## 5. Function Map Changes

Add function bindings before implementation:

```text
terminal.transport_lifecycle.mux.protocol.parse
terminal.transport_lifecycle.mux.protocol.build
terminal.transport_lifecycle.target_transport.open
terminal.transport_lifecycle.target_transport.reuse
terminal.transport_lifecycle.channel.open
terminal.transport_lifecycle.channel.close
terminal.transport_lifecycle.channel.body_subscription
terminal.transport_lifecycle.channel.send
terminal.transport_lifecycle.channel.demux
terminal.transport_lifecycle.daemon.mux_handshake
terminal.transport_lifecycle.daemon.channel_bind
terminal.transport_lifecycle.daemon.channel_detach
terminal.transport_lifecycle.daemon.send_scheduler
terminal.transport_lifecycle.daemon.stale_target_cleanup
```

Each binding must name the real symbol after code is written. Until then mark symbols as `binding pending`; do not invent symbols.

## 6. Implementation Plan

### Phase 0: Registry / Test Design Lock

- Update `docs/resource-registry.json` and `docs/resource-map.md` with `resource.daemon_target_transport` and `resource.terminal_channel`.
- Update `docs/function-map.md`, `docs/feature-registry.json`, `docs/feature-gates.md`, `docs/wiki/mainline-call-map.json`, and `docs/wiki/mainline-source.md`.
- Add `docs/testing/terminal-transport-multiplex-test-design.md`.
- Add source gates that fail if channel-bound daemon handlers read only `connection.boundSubscriberId` in mux mode.

### Phase 1: Protocol And Pure Helpers

- Add shared mux frame types and validators/builders.
- Add positive/negative tests for parse/build.
- Add explicit rejection for malformed frames, missing channel id, target messages sent as channel messages, and channel messages sent unwrapped.
- Add capability shape: `connected.capabilities.terminalMultiplexTransport.version=1` or `mux-ready.capabilities`.

### Phase 2: Client Target Transport Runtime

- Change `SessionTransportRuntimeStore` so target runtime owns the physical socket.
- Add channel runtime per local session:
  - local `sessionId`
  - `channelId`
  - target key
  - channel state
  - body subscription state
  - requested geometry
  - reliable input queue identity
- Replace `readSessionTransportSocket(sessionId)` call sites with owner APIs that resolve the target socket and channel envelope:
  - `sendChannelPayload(sessionId, message)`
  - `sendTargetPayload(targetKey/sessionId, message)`
  - `readSessionChannelState(sessionId)`
- Keep UI and page code calling SessionContext intents only.

### Phase 3: Client Demux

- Add mux socket message dispatcher:
  - `mux-channel-message` routes by `channelId -> local sessionId`.
  - Buffer apply uses the local session id resolved from channel map.
  - `input-ack` resolves the same session-local reliable queue.
  - Responses for unknown channel id are explicit debug/error facts and cannot mutate any buffer.
- Add tests that old/late channel A frames do not repaint active session B.

### Phase 4: Daemon Mux Runtime

- Extend daemon transport connection with mux state:
  - `muxVersion`
  - `channels: Map<channelId, subscriberId>`
  - target/control role
  - send scheduler state
- Implement `mux-hello`/`mux-ready`.
- Implement `mux-channel-open`:
  - generate/create a `TerminalTransportSubscriber` for that channel.
  - bind subscriber to channel, not to the whole connection.
  - attach tmux via existing mirror owner.
- Implement `mux-channel-message`:
  - resolve subscriber from `channelId`.
  - route through existing terminal message runtime with explicit subscriber context.
- Implement `mux-channel-close` and physical close:
  - channel close detaches exactly that subscriber.
  - physical close/stale cleanup detaches every channel subscriber.
- Keep adaptive width lease per channel subscriber.

### Phase 5: Send Scheduler

- Add mux send scheduler in daemon transport owner.
- Route `sendMessage(session, message)` for mux subscribers through `mux-channel-message`.
- Preserve current direct send for explicit legacy compatibility only if retained.
- Add per-channel pending-latest body coalescing and high-priority control lanes.

### Phase 6: Cutover And Cleanup

- New Android path opens only the daemon-target mux transport for terminal sessions.
- Remove new-code dependencies on per-session body WebSocket creation.
- Any retained legacy protocol branch must be isolated, documented as compatibility-only, and guarded by source tests.
- Physically remove dead per-session-only helpers after gates prove no new Android call path uses them.
- Update local skills with the new anti-pattern: "do not reintroduce per-session physical body sockets for same target".

## 7. Test Plan

### L0 Architecture / Static Gates

- `pnpm --dir android run test:feature-registry -- --reporter dot`
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- `git diff --check`
- New resource/function/mainline gates must prove:
  - resource ids exist and relation edges are legal.
  - mux call map edges exist and symbols bind after implementation.
  - channel-bound messages cannot bypass mux envelope.

### L1 Pure / Runtime Unit Tests

Protocol:
- valid `mux-hello`, `mux-channel-open`, `mux-channel-message`, `mux-target-message`.
- missing channel id rejected.
- unknown channel id rejected.
- unwrapped session-bound message rejected on a mux connection.

Client:
- opening 10 sessions on one target creates one physical target socket.
- switching A -> B -> A reuses the same physical target socket.
- active switch sends `body-subscription=false` for old channel and `true` for new channel.
- foreground resume sends ping/head over the same target socket.
- input for B is wrapped with B channel id and ack drains B queue only.
- late `mux-channel-message(A, buffer-sync)` while B active updates A buffer only and does not repaint B.
- target-level `list-sessions` uses target message, not a channel body socket.

Daemon:
- one mux connection opens two channels and creates two subscribers.
- channel A input writes only tmux session A.
- channel B buffer request returns channel B only.
- channel body unsubscribe stops unsolicited body but explicit head/range still works.
- channel close detaches one subscriber and preserves other channels.
- physical close/stale cleanup detaches all channel subscribers and leaves tmux sessions/mirrors.
- adaptive width lease is per channel and releases on channel close or physical close.
- send scheduler keeps P0/P1 frames ahead of channel body frames.

### L2 Daemon / Tmux Real Loop

Add a real mux close-loop script or extend `daemon:mirror:close-loop`:
- Start one mux WebSocket.
- Open at least three tmux channels with distinct session names and distinct marker output.
- Verify tmux oracle content matches each received channel buffer.
- Send input to channel A and prove only tmux A receives it.
- Run fast TUI updates in channel B and prove channel A input ack/head are not blocked indefinitely.
- Close channel B and prove A/C remain attached.
- Close physical transport and prove all subscribers detach without killing tmux sessions.

### L3 Client Integration

Run focused Android SessionContext tests:
- session context transport/runtime tests.
- socket message demux tests.
- input reliable queue tests.
- buffer apply identity tests.
- transfer/remote-window/schedule routing tests.
- session preview live-set body-subscription tests.

Required black-box identity gate:
- Same test creates two or more sessions with distinct body markers.
- Render through `sessionBufferStore -> TerminalPageStageShell -> TerminalView`.
- Assert active header/id/name and DOM body marker have the same session origin.
- Inject late old-channel publish, pause/resume, IME/layout resize, and session switch; old body must not appear under new active name.

### L4 App Shell / UI Behavior

- Drawer open/switch still only emits intent.
- Preview mode can subscribe 1-6 channels without opening extra physical transports.
- Home/server row entry opens last-entered/first remote session over the target mux transport.
- Network status top strip reports one target transport plus route/up/down metrics without layout mutation.

### L5 Package / Device / Release

Daemon:
- `pnpm --dir android run daemon:prepare-release`
- install global daemon release.
- service-scoped restart only.
- verify `/health`, loaded runtime path/hash, and mux symbols in installed runtime.

Android:
- `pnpm --dir android run build:android`
- verify `android/update-dist/latest.json`, APK path, versionName, versionCode, sha256.
- publish public Relay update assets if this is a user-testable mobile change.
- verify public `GET/HEAD` and downloaded APK sha.
- If ADB is online, install/launch/smoke. If not, report L5 device gap.

## 8. Black-Box Gates

Required before claiming completion:
- Multi-session single-socket count: 10 opened same-target sessions -> one target transport in Android runtime and one daemon mux connection.
- Session/source identity: tmux source marker for each session equals rendered target marker; no cross-session buffer pollution.
- Input identity: send CJK/special/long input to one channel; only that tmux session receives exact bytes and ack seq belongs to that channel.
- TUI refresh: one channel runs fast bottom/head refresh; another channel receives input/head without stale or delayed cross-talk.
- Body subscription: inactive channel stops unsolicited body bytes but explicit head/range still works.
- Reconnect restore: one physical target reconnect reopens/restores subscribed channel set without creating per-session sockets.
- Stale cleanup: physical stale sweep detaches every channel and releases adaptive width without killing tmux.

## 9. Risk And Controls

Risk: session body crosses into the wrong active tab.
- Control: channel envelope required on every session-bound frame; unknown/unwrapped frames reject; source-to-DOM black-box identity gate.

Risk: one WebSocket causes head-of-line blocking.
- Control: send scheduler priority lanes; bounded pending-latest body per channel; explicit latency gate with fast TUI + input.

Risk: daemon gains client active/foreground truth.
- Control: daemon stores only channel/subscriber/bodySubscribed/physical transport facts. Active reason remains client-side and is expressed only as body-subscription intent.

Risk: old protocol remains as hidden fallback.
- Control: new Android path requires mux capability. Any old protocol support is compatibility-only with tests and removal plan; mux failure must not silently open per-session sockets.

Risk: remote-window/file-transfer/schedule regress because they used active session socket.
- Control: classify every message as channel-bound or target-bound and add routing tests for each owner.

Risk: adaptive width leaks after app exit.
- Control: physical close/stale cleanup releases all channel subscriber leases through existing mirror owner.

## 10. Rust Migration Register

The current target-network probe policy is implemented in TypeScript, but its identity, dedupe, and failure-transition semantics are core transport policy and therefore have an explicit Rust migration target.

- `migration_id`: `terminal.transport_lifecycle.target_network_probe.rust`
- `status`: `planned`
- `current_owner`: `android/src/contexts/session-context-target-network-probe-runtime.ts#createSessionTargetNetworkProbeRuntime`
- `planned_target`: `crates/zterm-transport-core/src/target_network_probe.rs`
- `planned_rust_semantics`: target/socket-generation identity, pending-probe dedupe state, probe outcome, and target failure-transition policy
- `post_migration_ts_boundary`: platform event adapter, WebSocket IO, and timer scheduling only
- `activation`: create the Rust crate and target path, pass TS/Rust parity tests, wire the bridge, change this registry entry to active, then physically remove the old TS policy owner
- `gate`: `android/src/lib/function-wiki-truth.test.ts`

This entry is a target-state plan, not active architecture truth. Until activation is complete, the TypeScript symbol above remains the only runtime owner.

## 11. Implementation Steps

1. Commit or explicitly isolate current unrelated dirty work before starting this refactor.
2. Add the resource/function/mainline/test-design docs and source gates.
3. Add red tests for protocol envelope, client one-target-socket behavior, daemon multi-channel routing, black-box session identity, and stale cleanup.
4. Implement shared mux protocol helpers.
5. Implement client target transport and channel runtime without touching UI owners.
6. Implement daemon mux handshake/channel attach/channel message routing.
7. Implement mux send scheduler and body coalescing.
8. Remove or isolate per-session physical socket path from new Android flow.
9. Run L0/L1/L2/L3/L4 gates.
10. Prepare and install daemon release, restart service-scoped, verify loaded runtime.
11. Build and publish Android APK/update assets.
12. Run live mux black-box if local daemon and tmux are available; run ADB smoke if device is online.
13. Update `note.md`, promote verified durable facts to `MEMORY.md`, update local skill with the new guard, re-mine MemoryPalace, and verify search.
14. Commit scoped changes and report evidence plus remaining L5 gaps.

## 12. Definition Of Done

- One daemon target uses one physical terminal transport for all terminal sessions.
- Logical channels fully replace per-session body sockets in the new Android path.
- Session identity cannot mix across buffer, render, input, ack, file, schedule, screenshot, preview, or remote-window routing.
- Existing terminal mirror/buffer/renderer truth boundaries remain intact.
- Reconnect and foreground resume operate on the target transport first and do not rebuild channels unless physical transport truth requires it.
- All required tests/build/live gates pass, daemon runtime and APK are delivered, and public update route is verified when publishing for Jason's device test.
