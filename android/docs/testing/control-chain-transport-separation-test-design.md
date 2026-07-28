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

1. Daemon starts one Relay host control WebSocket and publishes its current LAN, Tailscale, RTC-direct signaling, and TURN Relay candidates.
2. Android starts one Relay device control WebSocket after account authentication and keeps the last confirmed directory projection across reconnect attempts.
3. Client route construction reads the latest directory truth for the stable daemon id.
4. Auto selection uses the fixed product tiers `LAN > RTC UDP direct > Tailscale > TURN Relay`; health can reject a failed candidate or order candidates inside one tier, but cannot move a lower tier ahead of a healthy higher tier.
5. The selected successful route is persisted by daemon/account/candidate identity and can seed a new transport generation without becoming a second endpoint truth.
6. All tmux sessions for the same stable daemon id open logical mux channels on one physical terminal transport.
7. Control reconnect or endpoint push updates future reconnect candidates only. The current healthy terminal transport remains untouched.

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
  - proves transient/auth failures do not silently become success;
  - proves recent persisted success cannot override a healthy higher route tier.
- `src/lib/traversal/route-health-cache.test.ts`
  - proves successful route truth survives a new cache instance through the storage adapter;
  - proves expired and malformed stored records are removed rather than selected.
- `src/lib/relay-device-stream-runtime.test.ts`
  - proves control close/reconnect retains last confirmed endpoint truth;
  - proves refresh failure does not clear confirmed endpoint truth;
  - proves `stop()` closes only the control socket.

## Module Black-Box Gates

- Start a fake Relay account/device stream, receive a full directory update, close the control WebSocket, reconnect, and observe the same endpoint truth followed by the new pushed revision.
- Open a fake daemon-target transport, then close/fail the control stream. Assert the terminal socket object identity, open state, channel map, and session ids are unchanged.
- Open two logical tmux sessions for one daemon id and assert one terminal socket plus two channel ids.
- Push a changed endpoint list while the terminal socket is open. Assert route candidate generation increments, the open socket is not closed, and only a later failed/reconnect generation reads the new order.

## Project Black-Box Gates

- Relay control connected: Android receives daemon endpoint list and terminal data remains on a different physical socket.
- Control interruption: terminal input/output continues on the already-open transport; directory reconnect restores endpoint truth.
- Route matrix: LAN, RTC direct, Tailscale, and TURN-only environments select the expected route and expose the actual selected path through diagnostics.
- Session multiplex: switch repeatedly across at least two tmux sessions without creating a second physical daemon-target transport.

## Positive And Negative Locks

| Area | Positive proof | Negative proof |
| --- | --- | --- |
| Control persistence | reconnect restores confirmed directory | refresh failure does not clear or mutate terminal transport |
| Socket separation | control and terminal sockets have different identities | no terminal/session/buffer field is accepted in control payload |
| Route order | LAN, RTC direct, Tailscale, TURN select in that order | persisted health cannot promote a lower healthy tier over a higher healthy tier |
| Endpoint push | future route candidates update | healthy active terminal socket is not replaced |
| Multiplex | multiple channels share one target socket | no per-session heartbeat or physical socket is created |

## Known Gap

A Relay control WebSocket exposes a TCP source mapping, not a reusable UDP NAT allocation. Automatic publication of literal `publicIp:udpPort` requires a daemon-owned persistent UDP/STUN allocation that is also used by the subsequent transport. Until that owner exists, the valid RTC-direct candidate is the Relay-signaled daemon identity; publishing the observed TCP address as UDP truth is forbidden.
