# Session Transport Network-Switch Test Design

## Architecture Binding

- Feature: `terminal.transport_lifecycle`
- Resource: `resource.session_transport`
- Unique health owner: `src/contexts/session-context-socket-runtime.ts`
- Mainline: `android_mainline:TransportOrchestration->TransportHealth`
- Recovery return: `TransportHealth -> SessionRuntime -> TransportReusePlan -> TransportOpen`
- Allowed behavior: retain the logical session and cached buffer while replacing only a stale physical WebSocket.
- Forbidden behavior: UI/page reconnect loops, daemon client-network state, fallback endpoints, parallel replacement sockets, or treating `readyState === OPEN` as sufficient health truth.

## Lifecycle Contract

1. A mux target transport owns one heartbeat timer keyed by `targetKey`; logical tmux sessions/channels do not own heartbeat timers.
2. Normal target keepalive is low-frequency (60 seconds). Session switch, channel open, foreground resume, and body-subscription changes do not start another heartbeat.
3. Every valid mux server frame refreshes target physical activity; `mux-pong` also refreshes pong truth. Activity is recorded under the physical target key, not the anchor session id.
4. The target health owner may finalize one physical socket generation only after its configured consecutive health policy is exhausted; the target failure fanout then preserves logical session/channel ids and routes recovery through the existing reconnect owner.
5. The existing reconnect owner replaces only that physical target socket while retaining logical session/channel ids, active-session truth, and local buffers.
6. A valid target frame resets the consecutive-miss count. A non-open socket does not emit heartbeat traffic. A channel error must not poison the target heartbeat or rebuild the physical socket.

## White-Box Gates

Positive:

- Two logical sessions sharing one target create exactly one heartbeat timer.
- Healthy target transport sends one `mux-ping` per 60-second-class tick.
- Any valid target activity between ticks resets the physical miss counter.
- Three consecutive target health misses call the physical failure owner exactly once.
- Stale failure enters the existing reconnect owner and preserves logical session state.

Negative:

- One or two misses cannot fail or close the physical transport.
- A busy terminal stream on any logical channel refreshes target health without requiring a per-session heartbeat.
- Repeated timer ticks after terminal failure cannot finalize the same physical socket generation again.
- `CLOSING` or `CLOSED` sockets cannot send ping or create a second reconnect path.
- A logical channel close/open does not create another physical heartbeat timer.

## Module Black-Box Gate

Replay an OPEN WebSocket whose server frames stop while its target IP remains reachable. Advance three heartbeat ticks, prove one retryable failure, one pending open intent, one replacement socket, unchanged session id/buffer, and rejection of late frames from the superseded socket.

## Real-Device Black-Box Gate

1. Connect the current APK to the Mac Studio daemon through its Tailscale IP and run a continuously changing TUI.
2. Capture client session id, daemon tmux target, buffer head, physical transport id, and Android network id.
3. Disable Wi-Fi while cellular remains validated. Independently prove `http://100.66.1.82:3333/health` is reachable from the phone.
4. Without killing the app, switching session, or reopening the page, prove output resumes through one replacement physical WebSocket within 10 seconds.
5. Prove logical session id and tmux target are unchanged, buffer head is monotonic, input echoes, and no stale socket event overwrites the replacement.
6. Repeat cellular-to-Wi-Fi.

## Known Gap Rule

Unit tests, type-check, build, and local WebSocket simulation do not close the network-switch bug. Completion requires the real-device two-direction gate above on the newly built APK.
