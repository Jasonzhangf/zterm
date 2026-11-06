# Observation - V2 connections first increment

Task: zterm-v2-connections-impl-1103. Owner: GCM impl worker. Reviewer: David. Integrator: Jenny.
Baseline branch: zterm-v2-connections-impl-1103. Workspace: 2:/workspaces/1. Repo HEAD at mount: 79bd37ea.

## Scope and inputs (read)
- Contract: /Volumes/Intel/playground/zterm/.worker-runs/zterm-v2-connections-impl-1103/task.md
- Design: module-designs/connections/DESIGN.md (David), practice-audit, cross-device-delivery, mvp-interface-contracts.
- V1 evidence: /Volumes/Intel/playground/zterm/.worker-runs/v1-connection-evidence-1103/evidence-report.md

## Facts read (source-verified)
1. V1 shared traversal public contract at packages/shared/src/connection/traversal/:
   - types.ts: TraversalTargetSource, TraversalSettingsSource, TraversalPlanCandidate, AttemptFailure, FailureDecision, TraversalDiagnostics.
   - policy.ts: DEFAULT_TRAVERSAL_PATH_PRIORITY = lan, ipv6, ipv4, rtc-direct, tailscale, rtc-relay.
   - route-selector.ts: selectBestTraversalRoute is tier-first; health/lease only tie-break inside a tier; auth-failure and failure penalize but cannot promote a lower tier.
   - config.ts: buildTraversalPlan/buildTraversalPlanCached build ws (lan/ipv4/ipv6/tailscale) and rtc (rtc-direct/rtc-relay) candidates; direct ws URL = ws://host:port?token=.
   - socket.ts: TraversalSocket connects candidates tier-first, exposes getDiagnostics() with resolvedPath/resolvedEndpoint/stage.
2. V1 node traversal factory: packages/cli/src/node-platform.ts createNodeTraversalFactory({WebSocket,RTCPeerConnection,RTCSessionDescription,RTCIceCandidate}); packages/cli/src/node-websocket.ts createNodeWebSocket adapts ws.
3. V1 terminal mux protocol: packages/shared/src/connection/protocol.ts:
   - buildTerminalMuxHello(clientInstanceId, deviceId) client frame.
   - buildTerminalMuxReady({daemonHostId, capabilities}) server frame; mux-ready carries daemonHostId + TerminalMuxCapabilities.
   - isTerminalMuxServerFrame validates server frames.
4. V1 /app protocol: packages/shared/src/connection/app-protocol.ts: validateAppServerFrame/validateAppClientFrame, APP_PROTOCOL_VERSION, capability constants.
5. V1 directory: relay directory endpoint candidate carries authToken and authRequired; token is injected into the ws URL query. connections must NOT read a credential store; the accounts authorization port supplies authorized candidates.
6. Environment: workspace is Linux arm64 Docker container (node 24.21.0). ws 8.20.0, vitest, tsx, typescript available at packages/cli/node_modules. Host daemon runs at 127.0.0.1:3333 (PID 66612) but is unreachable from the LayerFS container. LAN peer 192.168.0.27 rejects password/keyboard auth. jennys-macbook-air (Tailscale 100.93.143.20) is online but no zterm daemon listens on 3333/47011. Two-machine LAN acceptance remains UNVERIFIED; no daemon install/restart is authorized.

## Gap (what the first increment must close)
- No V2 connections implementation exists (v2/modules/connections contains only DESIGN.md).
- Required public port: connect(machineId, verifiedAuthorization) -> LinkRef; openChannel(LinkRef, kind) -> ChannelRef; observeLink(LinkRef) -> { path, status, freshness }; closeOwnLink(LinkRef).
- Must reuse V1 shared traversal (tier-first + rtc-direct/TURN) and V1 protocol parsing; must record actual selected path (direct/relay), not report unconnected as connected.
- Must keep accounts authorization port injection (credentials supplied by accounts, never read by connections, never in ticket payload).
- LAN two-machine real connection is the increment acceptance; cross-network direct/relay and /app data are a later increment.

## Constraints (contract)
- Write only v2/modules/connections/** and v2/evidence/zterm-v2-connections-impl-1103/**.
- No V1/other-module edits, no install/restart daemon, no push/PR, no global runtime install, no tmux/daemon lifecycle operations.
- If two-machine environment is unavailable: keep explicit UNVERIFIED and next action; do not fake success.
