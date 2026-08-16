# Fix Design: Tailscale WebSocket False Connect Timeout + Dynamic Route Verification

- Design ID: `FD-20260812-TAILSCALE-DYNAMIC-ROUTE-02`
- Supersedes: `FD-20260812-TAILSCALE-WS-BUDGET-01`（旧设计只放宽 deadline，未满足 Jason 的动态验证要求）
- Status: implemented and live-verified
- Base: `384039184a74afa6e23974394a390ba35dbaa156`
- Added: 2026-08-12，按 Jason 要求补入 “Tailscale IP 必须动态验证是否可通，不能依赖缓存”

## Scope

- Feature: `terminal.transport_lifecycle`
- Resource path: `resource.active_session -> resource.session_transport -> resource.daemon_target_transport -> resource.terminal_channel`
- Unique owner: `src/lib/traversal/socket.ts`（transport route selection / candidate attempt 唯一 owner）
- Allowed paths: `src/lib/traversal/socket.ts`, `src/lib/traversal/socket.test.ts`；文档与测试设计允许同步 `android/docs/debug/*`、`android/docs/testing/websocket-transport-reuse-test-design.md`
- Forbidden paths: reconnect UI, session error projection, daemon/tmux mirror, client buffer, renderer
- Boundary action: remove the invalid Tailscale-specific timing policy; keep the real authenticated WebSocket candidate attempt as the only dynamic Tailscale reachability verification; retain the existing typed transport owner and generic WebSocket failure path

## Baseline

- Device: `100.104.163.65:5555`
- Installed package: `com.zterm.android` `0.1.3.2587`
- User path: cold launch, explicitly open `Macbookair`
- Endpoint: `100.86.84.63:3333`
- Result: native alert `ws connect timeout`; route health persisted the Tailscale candidate as failed.
- The Android device could ping the endpoint with 0% loss. RTT varied from 29.5ms to 825ms.
- Mac-side `GET /health` returned HTTP 200 in 60ms.

## Confirmed Root Cause

Commit `2564c474` introduced a Tailscale-only 900ms candidate timeout based on
the assumption that a healthy Tailscale path opens below 100ms. That assumption
does not hold for this Android device when the peer is reached through Tailscale
DERP.

The first divergence is in `resolveCandidateTimeoutMs()`: the 900ms timer can
call `failAttempt(..., "ws connect timeout")` before Android WebView publishes
the healthy socket's `onopen`.

This is not a route-health-cache admission failure. The cache records the
downstream false timeout. It is also not a daemon, mux, auth, tmux, buffer, or
renderer failure.

## Jason 的新增硬要求

> tailscale 需要验证 ip 是否通，动态验证，因为不可靠

含义：不能把缓存或一次健康结果当永久真相。Tailscale candidate 被当前
route selection 选入物理连接批次时，必须由真实 WebSocket attempt 动态验证；
验证信号必须是 WebSocket 本身，而不是 ICMP / HTTP `/health`。同一网络代的
短期失败仍遵守既有 30 秒 cooldown；cooldown 内若有其他健康候选，不承诺每个
物理连接代都重复尝试该失败 candidate。

### 为什么只能由真实 candidate attempt 验证

1. Android WebView 无法执行 ICMP；ping 结果不能代表 WebSocket/WebRTC 可达性。
2. `GET /health` 是 HTTP 层信号，Tailscale DERP / WebSocket 握手路径与它不同；
   现有 `reconnect-host-probe.ts` 注释已明确 HTTP probe 不能等价于 WebSocket
   reachability。
3. 另开一个短生命周期 WebSocket probe 会与即将建立的正式 transport 对同一
   daemon 制造重复物理握手，违反 “禁止第二套 per-session transport owner”。
4. `TraversalSocket` 里对 Tailscale candidate 的真实带 token WebSocket attempt
   就是唯一正确的动态验证：`onopen` 证明当前 IP:port + DERP 路径此刻可通；
   timeout/error 证明不可通，并走既有显式失败与 route-health owner。

### 动态验证边界（不新增第二 owner）

- 不新增 probe socket，不把 HTTP /health 当 WebSocket admission gate。
- 不清理 route-health cache 来“恢复连接”。
- 不把 ICMP / HTTP 结果写进业务 payload；probe 只允许作为诊断 metadata。
- 每次真实 candidate attempt 的结果按 `networkGeneration + candidate id`
  写入 route health；旧网络结果不得污染新网络（现有 `networkGeneration`
  已注入 `TraversalRouteHealthScope`）。
- 候选列表在每次物理连接代由最新 host 投影构造（现有
  `refreshHostForReconnect -> mergeHostWithLatestProjection` 已接线），
  因此重连不会无限打陈旧 Tailscale IP。
- route health 会参与是否把 candidate 放入当前 race；同一 network generation
  的短期失败会在其他健康候选存在时暂时不可选。这是现有 cooldown 行为，不是
  “每个物理连接代都探测 Tailscale”的保证。
- 失败后按既有 30s transient cooldown 到期自动重新 probe；`route-selector`
  已保证全部不健康时仍选 least-bad 重试，不做 silent fallback。

## Causal Proof

The same installed WebView opened the same authenticated WebSocket repeatedly.

- Reverse intervention, 900ms budget: 12 attempts produced 10 opens and 2 timer
  expirations. Successful handshakes took 771-894ms.
- Positive intervention, 1800ms budget: 12/12 attempts opened. Handshakes took
  772-976ms.

Only the observation budget changed. Endpoint, token, device, WebView process,
Wi-Fi, VPN, and daemon remained the same. This proves the 900ms policy creates
false route failures.

## Formal Fix

1. Delete `TAILSCALE_CANDIDATE_TIMEOUT_MS` and the Tailscale special case from
   `resolveCandidateTimeoutMs()`. Tailscale WebSocket candidates return to the
   existing generic `WS_CANDIDATE_TIMEOUT_MS` budget.
2. When route selection includes the Tailscale candidate in the parallel
   batch, its real authenticated WebSocket attempt is the dynamic reachability
   verification; `onopen` wins the batch, timeout/error fails explicitly
   through the existing generic failure path. A cached same-generation failure
   may suppress it while another healthy route exists, until cooldown expires.
3. No new probe sockets, no HTTP admission, no cache clearing, no UI
   suppression, no fallback. A genuinely unavailable Tailscale endpoint still
   fails explicitly and the next generation re-probes after the existing
   transient cooldown.

## Test Design

- Positive: a healthy Tailscale candidate that opens after 900ms but before the
  generic WebSocket deadline must become the winner and publish one `onopen`
  （动态验证通过：当前 IP 的真实 WS 握手在合理窗口内成功）。
- Negative: a Tailscale candidate still connecting at the generic WebSocket
  deadline must fail once with `ws connect timeout`（动态验证失败：不得伪造
  成功，也不得提前误杀健康连接）。
- Regression: a non-Tailscale WebSocket candidate keeps the same generic budget.
- Network isolation: same Tailscale endpoint failure/success under
  `networkGeneration=N` must not be visible under `networkGeneration=N+1`。
- Stale endpoint: old Tailscale IP candidate id 与新 IP 的 candidate id 不同；
  旧 IP 的健康记录不得决定新 IP 的 selectability。新 IP 是否被本轮尝试仍由
  当前候选集合、优先级与其他候选健康状态共同决定。
- Diagnostic boundary: HTTP /health probe 无论成功失败都不得 gate 正式
  transport open（沿用现有 session-runtime 测试语义）。
- Cooldown recovery: transient failure 30s 后同 candidate 自动重新 probe，
  不依赖清 cache。
- Existing traversal/reconnect tests must remain green.

## Verification

After approval and formal implementation:

1. Focused `socket.test.ts` positive/negative tests.
2. Transport lifecycle and architecture gates.
3. Type-check and Android build.
4. Preserve device data, install the new APK, then replay cold launch and
   explicit Macbookair open repeatedly.
5. Require terminal `connected`, real body rendering, no `ws connect timeout`,
   and no false failure record for the successful route.
6. Real-device dynamic check: cold launch -> Macbookair Tailscale open；
  断网/切网后重连，观察 route selection 使用最新 Tailscale IP；该 candidate
  被选入时必须发起真实 WebSocket attempt，成功路线上无 false failure；失败时
  显式 timeout/error 并按 cooldown 重探。
7. Publish and verify the authorized OTA channels, then run `codex-review`.

## Remaining Risk

The generic 1800ms deadline is proven sufficient for the sampled route, not for
all possible high-latency networks. This design intentionally removes only the
invalid Tailscale-specific contraction. Any future adaptive timeout must use
measured transport-owner evidence and paired live gates. 动态验证只证明当前
被尝试 candidate 的即时可达性；缓存失败可在 cooldown 内抑制重复尝试，超过
deadline 的高延迟仍会显式失败，不会被伪装成成功。
