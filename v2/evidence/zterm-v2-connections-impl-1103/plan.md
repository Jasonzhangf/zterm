# Minimal plan - V2 connections first increment

## Target behavior
A caller can connect to an authorized target machine over a real LAN path, get an opaque LinkRef, open isolated logical channels, query real path/status/freshness/backpressure, and close its own link. Actual path must come from the real connection result; auth/identity/directory rejection must not be bypassed; unreachable must never be reported connected; unsupported channel must be rejected.

## Method -> architecture mapping
- DAG slice: authorization candidate -> capability filter -> real handshake/peer verify -> channel negotiation -> explicit result; close is a separate operation. Success/reject/unreachable all converge on one result exit; no lifecycle back edge.
- Unique owner: v2/modules/connections. Physical link + generation + channel isolation only; no member role, agent session, delivery state, or ticket completion.
- Gap class: add link (new module), reusing V1 traversal/protocol; no V1 edit.
- Reuse boundaries: @zterm/shared/connection/traversal (plan + tier-first select + TraversalSocket + node platform), @zterm/shared/connection/protocol (mux hello/ready identity), @zterm/shared/connection/app-protocol (frame validation).
- Required gates: contract tests (positive/negative) + real-entry black-box (real ws server + real TraversalSocket + real mux handshake) + type-check.

## Public surface
- connect(machineId, verifiedAuthorization?) -> LinkRef. If verifiedAuthorization omitted, resolve via injected AccountsAuthorizationPort; never read credentials directly.
- openChannel(LinkRef, kind) -> ChannelRef (kind in message|file|receipt|status).
- observeLink(LinkRef) -> { path: direct|relay|unknown, status, freshness, observedAt, generation, transportKind, capabilities, backpressure }.
- closeOwnLink(LinkRef).
- Typed ConnectionError codes: invalid_input, unauthorized, directory_rejected, machine_mismatch, peer_identity_mismatch, unreachable, unsupported_channel, link_not_found, link_closed, stale_generation, unknown.

## Steps
1. Write red contract tests for the required positive/negative semantics against a fake TransportPort; confirm they fail before implementation.
2. Implement domain link-state (generation fencing), ports (accounts-authorization, transport), application connection-manager, adapters (v1-traversal real; app-websocket codec), channels/dispatch.
3. Implement real v1-traversal adapter reusing TraversalSocket + buildTraversalPlanCached; record actual resolvedPath only after onopen; mux-hello/mux-ready verifies daemonHostId.
4. Run contract tests (green), type-check.
5. Real-entry test: real ws WebSocketServer (token check + mux handshake) + real TraversalSocket over the container LAN interface; positive connect records direct; negative wrong token -> unauthorized; negative closed port -> unreachable.
6. Two-machine LAN attempt: document reachability and why no daemon target (no daemon installed/running; installing/restarting daemon is forbidden). If not achievable, mark UNVERIFIED with exact next actions.
7. Write result.md with interface map, commands, raw results, unimplemented capabilities, writer owner, resource cleanup.
8. Single workspace commit (no publish).

## Non-goals
- Cross-network direct/relay real acceptance and /app data delivery (next increment).
- Member/agent/ticket/delivery state, daemon/tmux lifecycle, V1 changes.
