# Relay Reconnect Optimization Plan

## Goal

让连接链路默认按 `ipv6 direct -> Tailscale direct -> ipv4 direct -> rtc-relay` 排序，并为 relay 链路提供正确、快速、可验证的重连机制。

## Acceptance Criteria

- 默认 traversal path priority 为 `ipv6 -> tailscale -> ipv4 -> rtc-relay`。
- 每个路径能力可单独测试，不通过单个端到端 smoke 混合验证。
- Relay device stream 断开后可自动重连，且错误显式暴露到 runtime debug。
- RTC relay 连接断开后通过 session reconnect 主链快速重建，不引入 daemon 客户端状态。
- IPv6 / IPv4 direct WebRTC 可使用 TURN server 参与 ICE 建连；连接一旦成功，后续同一 live transport 不因 relay 状态变化被重建。
- 线上验证通过后再把默认排序接线为稳定默认值。

## Scope

### In Scope

- `android/src/lib/bridge-settings.ts`
  - 默认 traversal priority 调整。
- `android/src/lib/traversal/config.ts`
  - direct / relay candidate 生成规则审计与测试补齐。
- `android/src/lib/traversal/socket.ts`
  - traversal candidate timeout / close / retry 语义收口。
- `android/src/lib/traversal-relay-client.ts`
  - relay device stream 建连接口保持单一真源。
- `android/src/App.tsx`
  - relay device stream 生命周期与自动重连接线。
- `android/src/contexts/session-context-*`
  - 只审计 session reconnect 是否正确接收 relay transport close，不把 relay 状态机塞进 session owner。
- Tests under `android/src/**/*.test.ts(x)`。
- Evidence under `android/evidence/relay-reconnect/`。

### Out of Scope

- 不改 relay server 协议，除非线上验证证明 server 是唯一根因。
- 不把 runtime 源码复制到 zterm 仓库。
- 不引入 fallback / 双路径补偿；所有路径必须是明确 candidate 与显式失败。
- 不让 daemon 持有 client session / active tab / foreground / viewport 状态。

## Current Findings

- TS direct 快：session reconnect 主链已有 `scheduleReconnectRuntime -> startReconnectAttemptRuntime`，base delay `1200ms`，max `30000ms`。
- Relay 慢：`TraversalSocket` 当前是一次性 candidate runner，`connectNext()` 只顺序试候选，没有长期 reconnect runtime。
- `WebRtcBackend` signal socket close 直接触发 backend close；无 signal reconnect。
- `App.tsx` relay device stream 只在 relay settings 变化时创建；socket close 后不自动恢复。
- 默认 priority 目前为 `tailscale -> ipv6 -> ipv4 -> rtc-relay`，与目标不一致。

## Design Principles

- 唯一真源：candidate 排序只由 `normalizeTraversalPathPriority()` 和 `buildTraversalPlan()` 决定。
- 显式失败：任何 socket / ICE / signal 错误必须进入 diagnostics / runtime debug，不吞异常。
- 职责隔离：relay reconnect 属于 traversal / app relay stream；session reconnect 只重新打开 transport intent。
- 先单测后接线：每个能力先用定向测试锁定，再进行默认排序与线上验证。
- 不裁剪真实 payload：relay / signal / bridge transport payload 语义不因优化被裁剪。

## Technical Plan

### 1. Default Path Priority

- Change `DEFAULT_TRAVERSAL_PATH_PRIORITY` from `['tailscale', 'ipv6', 'ipv4', 'rtc-relay']` to `['ipv6', 'tailscale', 'ipv4', 'rtc-relay']`.
- Update tests:
  - `buildTraversalPlan` default order test.
  - settings normalization test if present or add one.
- Keep user-selected `traversalPathPriority` authoritative.

### 2. Direct WebRTC Candidate Coverage

- Audit `buildTraversalPlan()` candidate model before editing.
- If current model only creates RTC candidate for `rtc-relay`, add explicit direct RTC candidate types only if protocol supports host identity / signal routing for direct peers.
- Direct IPv6 / IPv4 requirement interpretation:
  - WebSocket direct remains primary direct path when bridge endpoint is reachable.
  - WebRTC direct may use TURN as ICE server for NAT traversal only when signal URL and target identity are explicitly available.
  - TURN must not become hidden fallback; it is ICE server config for one explicit RTC candidate.
- Add tests proving candidate shape includes TURN ICE servers for supported RTC direct candidates.

### 3. TraversalSocket Reconnect Runtime

- Add reconnect state inside `TraversalSocket` only for traversal candidate attempts, not session ownership.
- Required fields:
  - `attempt`
  - `timer`
  - `connecting`
  - `closedByClient`
  - last diagnostics reason
- Delay policy:
  - initial candidate attempts remain fast.
  - reconnect after open-close starts with small delay, e.g. `300ms`, then exponential to cap, e.g. `5000ms`.
  - no busy loop when relay server is down.
- Reset policy:
  - successful open resets attempt.
  - client close cancels timer.
- Tests:
  - close after open schedules reconnect.
  - client close does not reconnect.
  - timeout advances candidates and records diagnostics.
  - retry delay grows and caps.

### 4. WebRtcBackend Signal / ICE Failure Handling

- Keep backend explicit: signal close / ICE failed reports close to `TraversalSocket`.
- Do not hide reconnection inside `WebRtcBackend` unless tests prove it is needed.
- Prefer one reconnect owner: `TraversalSocket` handles retry; `WebRtcBackend` only reports state changes.
- Add tests for:
  - signal socket close emits close reason.
  - RTC data channel close emits close reason.
  - ICE disconnected / failed emits close reason.

### 5. Relay Device Stream Auto-Reconnect

- Add App-level relay device stream reconnect loop:
  - lifecycle owner remains `App.tsx`.
  - reconnect only when relay account/settings still match current generation.
  - close on settings/account change cancels old timer.
  - debug events emitted for open / close / scheduled retry / error.
- Delay policy:
  - fast first reconnect, e.g. `300ms`.
  - exponential backoff capped, e.g. `5000ms`.
- Tests:
  - stream close schedules reconnect.
  - settings change cancels previous stream timer.
  - manual dispose does not reconnect.
  - devices snapshot still updates state.

### 6. Online Verification Before Final Sorting

- Create evidence directory: `android/evidence/relay-reconnect/`.
- Verify each function independently:
  1. IPv6 direct candidate reaches bridge.
  2. Tailscale candidate reaches bridge.
  3. IPv4 direct candidate reaches bridge.
  4. RTC relay candidate reaches bridge.
  5. Relay device stream reconnects after relay ws close.
  6. Session transport reconnects after RTC relay transport close.
- Only after independent success, switch stable default ordering.

## Test Matrix

| Feature | Unit Test | Integration Test | Online Evidence |
|---|---|---|---|
| Default priority | `traversal/config.test.ts`, `bridge-settings.test.ts` | open tab restore traversal plan | candidate list log |
| Direct WS IPv6 | config candidate order | bridge ws connect | runtime diagnostics |
| Direct WS Tailscale | config candidate order | bridge ws connect | runtime diagnostics |
| Direct WS IPv4 | config candidate order | bridge ws connect | runtime diagnostics |
| RTC relay | config relay hostId / TURN test | session open via relay | runtime diagnostics + screenshot/log |
| Traversal reconnect | fake backend timers | session reconnect via relay close | runtime debug log |
| Relay device stream reconnect | mocked WebSocket timers | App relay stream lifecycle | relay device list recovers |

## Implementation Steps

1. Add focused tests for default priority and user priority preservation.
2. Add tests around traversal candidate timeout / close / reconnect behavior.
3. Implement `TraversalSocket` reconnect state and diagnostics.
4. Add tests for relay device stream reconnect lifecycle.
5. Implement App-level relay device stream reconnect loop.
6. Audit whether direct WebRTC candidates are protocol-supported; implement only if there is a single explicit signal identity source.
7. Run targeted test suite.
8. Run TypeScript compile.
9. Run online verification per path; write evidence files.
10. Switch default path priority if not already switched; rerun targeted tests and online smoke.
11. Update `android/MEMORY.md` only with verified conclusions.

## Verification Commands

```bash
pnpm --dir android exec vitest run src/lib/traversal/config.test.ts src/lib/traversal/socket.test.ts src/lib/bridge-settings.test.ts --reporter dot
pnpm --dir android exec vitest run src/App.*relay*.test.tsx src/App.dynamic-refresh.test.tsx --reporter dot
pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false
```

Online verification commands must be recorded in `android/evidence/relay-reconnect/README.md` with timestamp, target path, result, and diagnostic artifact path.

## Risks

- Direct WebRTC over IPv6 / IPv4 may require explicit signal peer identity that current config does not model. Do not fake this with relay-only hostId.
- Too-aggressive reconnect can create connection storm when relay is down. Use capped backoff and generation cancel.
- Multiple reconnect owners can race. Keep `TraversalSocket` as traversal retry owner and session context as session intent retry owner.
- Device stream reconnect must not recreate session transports.

## Done Definition

- Tests prove each function separately.
- Online evidence proves each path separately.
- Default ordering is `ipv6 -> tailscale -> ipv4 -> rtc-relay`.
- Relay disconnect recovers without user settings edit.
- No daemon/client state boundary violation.
- `android/note.md` contains exploration notes; verified long-term conclusions appended to `android/MEMORY.md`.
