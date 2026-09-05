# Daemon Wiki

Worker-readable daemon map. Keep this page factual and short; generated diagrams live in `docs/wiki/generated/daemon.html`.

## Owner

- `feature_id`: `daemon.runtime_entry`
- Runtime entry: `src/server/server.ts`
- Runtime config truth: `src/server/daemon-config.ts`
- CLI launcher: `scripts/zterm-daemon.sh run`
- Staged runtime: `~/.wterm/daemon-runtime/server.cjs`
- State/log directories: `~/.wterm/run`, `~/.wterm/logs`, `~/.wterm/uploads`, `~/Downloads/zterm`

## Mainline

```mermaid
flowchart TD
  CLI["scripts/zterm-daemon.sh run"] --> Stage["stage_daemon_runtime"]
  Stage --> Server["src/server/server.ts"]
  Server --> Config["daemon-config.ts"]
  Server --> Bridge["terminal-bridge-runtime.ts"]
  Server --> Transport["terminal-transport-runtime.ts (connections map)"]
  Server --> Message["terminal-message-runtime.ts (route message)"]
  Server --> Http["terminal-http-runtime.ts"]
  Server --> Daemon["terminal-daemon-runtime.ts (lifecycle orchestrator)"]
  Server --> Core["terminal-core-support.ts (tmux helpers)"]
  Server --> AttachToken["terminal-attach-token-runtime.ts"]
  Message --> ControlGateway["daemon-control-gateway-runtime.ts (typed control ingress)"]
  ControlGateway --> ControlCenter["daemon-control-center-runtime.ts (capability/audit routing)"]
  ControlGateway --> SessionCatalog["daemon-session-catalog-runtime.ts (backend session catalog)"]
  Control --> SessionCatalog
  Message --> Mirror["terminal-mirror-runtime.ts (tmux mirror truth)"]
  Mirror --> Capture["terminal-mirror-capture.ts (daemon.mirror_writer)"]
  Mirror --> BufferPublisher["daemon-buffer-publisher-runtime.ts (buffer-sync publication)"]
  BufferPublisher --> Transport
  Message --> InputQueue["daemon-input-queue-runtime.ts (input receive/write queue)"]
  InputQueue --> ControlRt
  InputQueue --> InputAck["terminal-reliable-input-ack.ts (seq dedupe)"]
  Message --> Control["terminal-message-control-runtime.ts"]
  Control --> ControlRt["terminal-control-runtime.ts (tmux spawn/write)"]
  Control --> Schedule["terminal-schedule-runtime.ts"]
  Control --> Transfer["terminal-file-transfer-runtime.ts"]
  Control --> Screenshot["remote-screenshot-daemon.ts"]
  Daemon --> Heartbeat["ws heartbeat loop (30s ping)"]
  Daemon --> MemoryGuard["memory guard (2.5GB RSS / 1.5GB heap)"]
  Daemon --> Relay["relay-client.ts (TURN relay host)"]
  Bridge --> RtcBridge["rtc-bridge.ts (WebRTC signaling)"]
```

## Runtime Modules (from server.ts wiring order)

| module | responsibility | key file |
| --- | --- | --- |
| `terminal-daemon-runtime.ts` | lifecycle orchestrator: heartbeat, memory guard, SIGINT/SIGTERM/SIGHUP, daemon startup/shutdown, relay client | `src/server/terminal-daemon-runtime.ts` |
| `terminal-bridge-runtime.ts` | WebSocket/RTC connection accept, auth, message lane routing (attach/input/message) | `src/server/terminal-bridge-runtime.ts` |
| `terminal-transport-runtime.ts` | per-connection transport state, send, broadcast, ws/rtc unified | `src/server/terminal-transport-runtime.ts` |
| `terminal-message-runtime.ts` | message dispatcher: routes client messages to mirror/control/bridge/transfer | `src/server/terminal-message-runtime.ts` |
| `daemon-control-gateway-runtime.ts` | typed control ingress and daemon command owner adapters for schedule/tmux control | `src/server/daemon-control-gateway-runtime.ts` |
| `daemon-control-center-runtime.ts` | daemon capability/deadline/idempotency/correlation/audit routing | `src/server/daemon-control-center-runtime.ts` |
| `daemon-session-catalog-runtime.ts` | backend session catalog construction and `list-sessions` control dispatch | `src/server/daemon-session-catalog-runtime.ts` |
| `terminal-runtime.ts` | session lifecycle, tmux attach/detach, buffer head/range, schedule handoff | `src/server/terminal-runtime.ts` |
| `terminal-mirror-runtime.ts` | tmux mirror truth: capture scheduling, canonicalize, changed-ranges, subscriber broadcast | `src/server/terminal-mirror-runtime.ts` |
| `daemon-buffer-publisher-runtime.ts` | daemon buffer-sync publication: per-subscriber live pending-latest, bounded FIFO request-range responses, range merge/collapse, backpressure hysteresis, shared physical-transport round-robin budget, head cache, frame split, explicit flush statuses | `src/server/daemon-buffer-publisher-runtime.ts` |
| `terminal-mirror-capture.ts` | validated source capture, source-neutral canonicalization, and authoritative mirror snapshot commit writes; owned by `daemon.mirror_writer` | `src/server/terminal-mirror-capture.ts` |
| `terminal-source-adapter.ts` | shared tmux/Herdr/WezTerm source adapter contract: kind normalization, source session/snapshot/input/resize/close/read-path boundary | `src/server/terminal-source-adapter.ts` |
| `daemon-input-queue-runtime.ts` | daemon input receive/ack/dedupe/queue/backend write ordering; reliable seq cache in `terminal-reliable-input-ack.ts` | `src/server/daemon-input-queue-runtime.ts` |
| `terminal-message-control-runtime.ts` | session control (resize/rename/kill), schedule/transfer/screenshot delegation | `src/server/terminal-message-control-runtime.ts` |
| `terminal-control-runtime.ts` | tmux spawnSync/Async, pane metrics, backend input write primitive, tmux command dispatch | `src/server/terminal-control-runtime.ts` |
| `terminal-schedule-runtime.ts` | schedule store, engine, per-session state, dispatch handoff | `src/server/terminal-schedule-runtime.ts` |
| `terminal-file-transfer-runtime.ts` | upload/download, chunking, binary bridge | `src/server/terminal-file-transfer-runtime.ts` |
| `terminal-http-runtime.ts` | HTTP debug routes, app-update manifest, connected payload | `src/server/terminal-http-runtime.ts` |
| `terminal-debug-runtime.ts` | client/daemon debug log capture, snapshot, runtime debug store | `src/server/terminal-debug-runtime.ts` |
| `runtime-debug-store.ts` | ring-buffer debug store, payload redaction | `src/server/runtime-debug-store.ts` |
| `terminal-core-support.ts` | pure tmux helpers: sanitize/name/build/cache-lines/cursor-equal | `src/server/terminal-core-support.ts` |
| `terminal-attach-token-runtime.ts` | per-session transport attach token issuance/consumption | `src/server/terminal-attach-token-runtime.ts` |
| `relay-client.ts` | TURN relay host client: device registration, signaling forward | `src/server/relay-client.ts` |
| `rtc-bridge.ts` | WebRTC signaling server for relay peers | `src/server/rtc-bridge.ts` |
| `remote-screenshot-daemon.ts` | daemon-side screenshot: native binary handoff | `src/server/remote-screenshot-daemon.ts` |

## Request Paths

| path | entry | owner module | hard boundary |
| --- | --- | --- | --- |
| WebSocket attach/connect | `server.ts` | `terminal-bridge-runtime.ts` | daemon must not own client active tab, foreground, pane, or UI state |
| input | `terminal-message-runtime.ts` | `daemon-input-queue-runtime.ts` + `terminal-reliable-input-ack.ts` | payload remains string-only; stale/detached input drops before tmux write |
| buffer head/range | `terminal-message-runtime.ts` | `terminal-mirror-runtime.ts` -> `daemon-buffer-publisher-runtime.ts` | range response keeps request correlation and goes through the bounded publisher FIFO/backpressure/frame-split/physical-budget lane; queue overflow is an explicit error; read request must read mirror truth only; no client state policy |
| live mirror capture | `terminal-mirror-runtime.ts` | `daemon.mirror_writer` via `terminal-mirror-capture.ts` | snapshot commit writes stay in the mirror writer; daemon owns tmux mirror, not renderer/window/follow state |
| live or explicit body publish | `terminal-mirror-runtime.ts` / `terminal-message-runtime.ts` | `daemon-buffer-publisher-runtime.ts` | mirror commits truth; buffer publisher owns live pending and bounded explicit range FIFO, per-subscriber backpressure, shared physical-transport round-robin, head/frame-split delivery to physical transport subscribers |
| list sessions | `daemon-control-gateway-runtime.ts` | `daemon-session-catalog-runtime.ts` | backend session catalog owns backend-qualified `sessionCatalog` and list-time idle facts; no client active/session/UI truth |
| schedule | `daemon-control-gateway-runtime.ts` -> `daemon-control-center-runtime.ts` -> `terminal-message-control-runtime.ts` | `schedule-engine.ts` + `schedule-store.ts` + `schedule-dispatch.ts` | daemon is schedule execution truth |
| file transfer | `terminal-message-control-runtime.ts` | `terminal-file-transfer-runtime.ts` | transfer chunks preserve payload semantics |
| remote screenshot | `terminal-message-control-runtime.ts` | `remote-screenshot-daemon.ts` + native `scripts/native/zterm-daemon.swift` | daemon/native binary owns local screenshot execution |
| debug runtime | `terminal-http-runtime.ts` | `terminal-debug-runtime.ts` + `runtime-debug-store.ts` | debug logs may redact payload; user-visible payload cannot be rewritten |

## Required Gates

- `src/server/server.daemon-runtime-truth.test.ts`
- `src/server/server.core-support-truth.test.ts`
- `src/server/server.http-truth.test.ts`
- `src/server/server.debug-truth.test.ts`
- `src/server/daemon-input-queue-runtime.test.ts`
- `src/server/daemon-control-center-runtime.test.ts`
- `src/server/daemon-control-center-ownership.test.ts`
- `src/server/daemon-session-catalog-runtime.test.ts`
- `src/server/daemon-session-catalog-ownership.test.ts`
- `src/server/terminal-message-runtime.test.ts`
- `src/server/terminal-mirror-runtime.test.ts`
- `src/server/terminal-mirror-writer-ownership.test.ts`
- `src/server/daemon-buffer-publisher-runtime.test.ts`
- `src/server/terminal-source-adapter.test.ts`
- `pnpm run test:terminal:regression`

## No-Go

- Do not add `clientSessionId` or active-tab truth to daemon internals.
- Do not use daemon read requests to trigger upstream sync policy.
- Do not kill tmux sessions except through explicit user-visible kill commands.
- When the final physical terminal subscriber detaches, release only daemon mirror/runtime resources; keep the tmux session alive. A sibling subscriber keeps the shared mirror alive, and `bodySubscribed=false` does not count as detached.
- Do not add fallback success paths; expose errors and fix the unique owner.
