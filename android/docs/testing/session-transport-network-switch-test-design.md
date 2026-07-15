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

1. A connected physical socket sends a heartbeat every 2 seconds.
2. Every valid server frame refreshes server-activity truth; pong also refreshes pong truth.
3. A heartbeat tick with no server activity since the previous tick counts one missed health confirmation.
4. Three consecutive misses, bounded by 6 seconds, finalize the current socket generation once as retryable failure.
5. The existing reconnect owner replaces that physical socket immediately while retaining session id, active-session truth, and local buffer.
6. A valid server frame resets the consecutive-miss count. A non-open socket does not emit heartbeat traffic.

## White-Box Gates

Positive:

- Healthy socket sends one ping per 2-second tick.
- Any valid server activity between ticks resets the miss counter.
- Three consecutive ticks without server activity call `finalizeFailure` exactly once.
- Stale failure enters the existing reconnect owner and preserves logical session state.

Negative:

- One or two misses cannot fail or close the transport.
- A busy terminal stream without pong cannot be classified stale.
- Repeated timer ticks after terminal failure cannot finalize the same socket generation again.
- `CLOSING` or `CLOSED` sockets cannot send ping or create a second reconnect path.

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
