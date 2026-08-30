# Control Chain And Transport Separation Test Design

## Ownership

- `relay.account_directory` owns the persistent Android Relay device WebSocket and the confirmed endpoint-directory projection.
- `daemon.connection_gateway` owns daemon network endpoint discovery and publication plus direct/WebRTC physical ingress.
- `terminal.transport_lifecycle` owns one client physical daemon-target transport, route selection, route-health persistence, and logical terminal-channel multiplexing.
- `shared.connection_types` owns endpoint candidate wire types.

The allowed resource route is:

`resource.relay_control_connection -> resource.relay_account_directory -> resource.transport_target -> resource.daemon_target_transport -> resource.terminal_channel`

The control WebSocket never carries terminal/session/buffer payloads. A directory update may replace candidate truth for a daemon target, but it cannot close or replace a healthy open terminal transport.

## Lifecycle

1. Daemon starts one Relay host control WebSocket, maintains heartbeat, and publishes its current LAN, Tailscale, verified public-direct, RTC-direct signaling, and TURN Relay candidates under one stable daemon host id.
2. Android starts one Relay device control WebSocket after account authentication. Cached account data may render UI, but it cannot authorize a new terminal transport generation.
3. Every new Relay-owned daemon-target transport carrying Relay endpoint/signaling/WebRTC route evidence waits for a fresh server-confirmed directory generation from the HTTP control refresh or device control WebSocket. A saved direct/Tailscale target with only a persisted daemon id is not Relay-owned route evidence and opens its explicit endpoint immediately, even while the account is logged in. When the control line is reconnecting, only Relay-owned terminal transports remain `CONNECTING` without starting LAN/Tailscale/RTC signaling from stale profile data.
4. Auto selection uses the fixed product tiers `eligible same-subnet LAN > Tailscale > verified public direct > TURN Relay`; health can reject a failed candidate or order candidates inside one tier, but cannot move a lower tier ahead of a healthy higher tier. Same-subnet is eligibility only; the authenticated data-transport handshake is reachability truth.
5. The selected successful route is persisted by daemon/account/candidate identity and can seed a new transport generation without becoming a second endpoint truth.
6. All tmux sessions for the same stable daemon id open logical mux channels on one physical terminal transport.
7. Control reconnect or endpoint push updates future reconnect candidates only. The current healthy terminal transport remains untouched; a replacement generation created while control is unavailable waits for reconfirmation, and then atomically becomes the current target generation.
8. A newly created waiting transport immediately projects its typed diagnostics into the owning Session lifecycle. The portrait status strip may render that projection as `正在同步控制通道`, but it must remain a flat, non-highlighted UI surface and must never read the control directory resource directly.
9. Foreground resume and the bounded automatic reconnect route flow are standard recovery, not a user-visible failure. Their typed probe/transport errors stay in Session diagnostics and the flat status strip. The top error banner becomes actionable only after the standard reconnect flow is exhausted (`reconnectAttempt >= 4`) or after a non-retryable terminal error; low-level probe strings are not copied into the user notification.

## White-Box Gates

- `src/server/daemon-connection-endpoint-runtime.test.ts`
  - classifies private LAN and Tailscale interfaces deterministically;
  - excludes loopback, link-local, internal, duplicate, and unspecified addresses;
  - never fabricates a UDP NAT mapping from a TCP control socket address.
- `src/server/relay-client.test.ts`
  - publishes endpoint candidates supplied by the daemon gateway plus one Relay/TURN identity;
  - rejects a directory payload containing terminal/session-buffer fields;
  - reports endpoint/session discovery failures explicitly.
- `src/lib/traversal/route-selector.test.ts`
  - proves exact Auto tier order;
  - proves a LAN candidate is eligible only when one current client IPv4 address shares its explicit prefix;
  - proves a same-subnet candidate whose authenticated handshake fails does not become healthy;
  - proves transient/auth failures do not silently become success;
  - proves recent persisted success cannot override a healthy higher route tier.
- `src/lib/traversal/route-health-cache.test.ts`
  - proves successful route truth survives a new cache instance through the storage adapter;
  - proves expired and malformed stored records are removed rather than selected.
- `src/lib/relay-device-stream-runtime.test.ts`
  - proves cached account projection is not marked as server-confirmed control truth;
  - proves HTTP refresh and control-stream directory frames publish confirmed generations;
  - proves control close/reconnect blocks only new transport generations;
  - proves `stop()` closes only the control socket.
- `src/lib/client-control-plane-transport.test.ts`
  - proves a new transport performs no signaling before confirmed directory truth;
  - proves confirmed truth creates exactly one data transport generation;
  - proves closing a waiting generation prevents a late control snapshot from opening it.
- `src/contexts/session-context-infra-runtime.test.ts`
  - proves Relay route evidence enters the control-directory gate;
  - proves a saved direct target with only daemon identity bypasses the Relay gate and opens immediately.
- `native/android/app/src/test/java/com/zterm/android/AndroidConnectionServiceTransportTest.java`
  - proves native Auto order `LAN > Tailscale > public direct > TURN` from one typed daemon target;
  - proves unsupported/unavailable candidates fail explicitly and advance once without creating a second lifecycle owner;
  - proves foreground/control-directory refresh leaves a healthy socket generation and channel map unchanged.
- `src/pages/TerminalPage.session-drawer.test.tsx`
  - proves a control-confirmation wait is visible in the flat portrait status strip;
  - proves ordinary connected status remains neutral rather than permanently highlighted;
  - proves reconnect activity stays in the status strip while the error banner remains hidden during the first ten seconds, and actionable recovery status appears only after the standard flow threshold is exceeded.
- `src/pages/TerminalPage.network-banner.test.tsx`
  - proves foreground and standard automatic reconnect attempts remain non-actionable even with a terminal socket-state diagnostic;
  - proves exhausting the standard recovery flow makes the notification actionable;
  - proves the notification uses a stable user-facing recovery message instead of raw transport internals.

## Module Black-Box Gates

- Start a fake Relay account/device stream, receive a full directory update, close the control WebSocket, reconnect, and observe the same endpoint truth followed by the new pushed revision.
- Open a fake daemon-target transport, then close/fail the control stream. Assert the terminal socket object identity, open state, channel map, and session ids are unchanged.
- Open two logical tmux sessions for one daemon id and assert one terminal socket plus two channel ids.
- Push a changed endpoint list while the terminal socket is open. Assert route candidate generation increments, the open socket is not closed, and only a later failed/reconnect generation reads the new order.

## Project Black-Box Gates

- Relay control connected: Android receives daemon endpoint list and terminal data remains on a different physical socket.
- Control interruption: terminal input/output continues on the already-open transport; directory reconnect restores endpoint truth.
- Route matrix: same-subnet LAN, Tailscale-only, public-direct-only, and TURN-only environments select the expected route and expose the actual selected path through diagnostics.
- Session multiplex: switch repeatedly across at least two tmux sessions without creating a second physical daemon-target transport.

## Positive And Negative Locks

| Area | Positive proof | Negative proof |
| --- | --- | --- |
| Control persistence | reconnect reconfirms directory before a new transport opens | cached or disconnected control state cannot start a new data transport |
| Socket separation | control and terminal sockets have different identities | no terminal/session/buffer field is accepted in control payload |
| Route order | eligible LAN, Tailscale, public direct, TURN select in that order | subnet similarity alone cannot mark LAN healthy; persisted health cannot promote a lower healthy tier over a higher healthy tier |
| Endpoint push | future route candidates update | healthy active terminal socket is not replaced |
| Multiplex | multiple channels share one target socket | no per-session heartbeat or physical socket is created |
| Status projection | Session diagnostics show control synchronization/reconnect activity in the portrait strip | UI does not read control payloads directly and the strip does not use a raised/highlighted treatment |

## Known Gap

A Relay control WebSocket exposes a TCP source mapping, not a reusable UDP NAT allocation. Automatic publication of literal `publicIp:udpPort` requires a daemon-owned persistent UDP/STUN allocation that is also used by the subsequent transport. Until that owner exists, the valid RTC-direct candidate is the Relay-signaled daemon identity; publishing the observed TCP address as UDP truth is forbidden.
