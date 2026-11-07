# mux-ready-daemon-host-id-1107 architecture mapping

- Baseline revision: f99a61a8f39542afcb450a23ad55060dcbcdd697
- Worktree: /Volumes/Intel/playground/zterm/worktrees/mux-ready-daemon-host-id-20261107
- Affected graph: android/docs/dagpipe/daemon-connection-channel-catalog.graph.json
- Affected node: negotiate_mux (daemon.connection_gateway.negotiate_mux)
- Node owner: android/src/server/terminal-mux-channel-runtime.ts (handleMuxFrame -> buildTerminalMuxReady)
- Identity source: android/src/server/daemon-config.ts DAEMON_CONFIG.daemonHostId, already consumed by terminal-http-runtime; no new identity owner is introduced
- Gap class: missing edge data (payload completeness) inside an existing node; no topology change and no DAG file edit
- V2 source untouched: v2/modules/connections/src/adapters/v1-traversal.ts is not modified

## Change chain

1. android/src/server/server.ts passes DAEMON_CONFIG.daemonHostId into createTerminalMessageRuntime.
2. android/src/server/terminal-message-runtime.ts declares daemonHostId in TerminalMessageRuntimeDeps and forwards it into createTerminalMuxChannelRuntime.
3. android/src/server/terminal-mux-channel-runtime.ts declares daemonHostId in TerminalMuxChannelRuntimeDeps and passes it into buildTerminalMuxReady, which emits it in the mux-ready payload as a non-empty string.
4. android/src/server/terminal-message-runtime.test.ts adds the focused assertion that mux-ready advertises the current daemon host identity.

## Compatibility boundary

- Existing mux clients that do not require identity continue to work: daemonHostId remains optional in TerminalMuxReady and the shared protocol test suite passes unchanged (22/22).
- A frame with a missing identity remains valid under the shared protocol compatibility contract; buildTerminalMuxReady only omits empty values, while the server must not omit the configured value.
- A mismatched identity is still rejected by the V2 adapter contract; that contract is not weakened.
