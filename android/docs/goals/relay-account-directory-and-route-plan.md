# Relay Account Directory and Best Route Plan

## 目标与验收标准

目标：把 relay 从“账号登录 + 设备 presence + 手动 bridge preset”升级为账号级统一目录。用户登录 relay 后，客户端能同步同一账号下所有机器、daemon、tmux sessions、可连接 endpoint candidates、route health，并在 Connections / Session Picker 里直接用最佳线路打开 session。

验收标准：
- relay server 暴露 account-scoped directory：`account -> devices -> daemons -> endpointCandidates -> sessions -> routeHealth`。
- daemon 上线后向 relay 发布自身稳定身份、可连接路径候选、auth capability、tmux session snapshot 与版本/健康信息。
- Android 登录 relay 后不再依赖本地 bridge preset 才能识别在线 daemon；无 preset 也能看到机器、session，并可通过 relay 路径连接。
- Auto 线路选择从固定 priority 串行尝试升级为显式 best-route 评分：reachable、auth ok、RTT、recent success、freshness、user policy weight。
- Settings 只保留账号和高级策略；Connections / Session Picker 成为远端机器和 session 的主工作流入口。
- 所有失败必须显式暴露到 diagnostics / runtime debug；禁止 fallback、静默吞错、UI 层补业务真相。

## 范围与边界

In Scope：
- relay server directory store/API/ws 协议。
- daemon relay host client 上报 directory snapshot。
- Android relay account client、directory storage/projection、Connections/Session Picker UI 消费。
- traversal route candidate generation、probe、score、TTL cache、diagnostics。
- feature registry / function map / test design / docs / skill 经验更新。

Out of Scope：
- 不改 terminal buffer/render 主线。
- 不让 relay server 或 daemon 持有 client active tab / foreground / viewport / pane 等客户端状态。
- 不把 runtime 源码复制进 zterm app repo。
- 不通过裁剪真实 payload 达成性能优化。
- 不做“连不上就假装成功”的降级路径；错误必须显式进入 diagnostics。

## 当前证据

- `src/traversal-relay/store.ts` 当前只持久化 `users / tokens / devices`；device snapshot 只有 client/daemon 在线状态、daemon hostId/version。
- `src/traversal-relay/server.ts` 的 `/api/auth/login`、`/api/auth/me`、`/api/devices` 只返回 devices；`/ws/host` 与 `/ws/client` 只做 signaling 转发。
- `src/lib/session-picker.ts` 当前需要本地 `BridgeServerPreset` 才能把 relay daemon 解析为可连接 target；无 preset 时 `bridgeHost/authToken` 为空。
- `src/lib/traversal/config.ts` 当前按 `traversalPathPriority` 生成候选；`src/lib/traversal/socket.ts` 当前串行连接候选，WS 1800ms、RTC 8000ms 超时后继续，没有 route scoring/RTT/TTL。
- 审计摘要已写入 `android/note.md` 的 `2026-06-28 relay path audit`。

## 设计原则

- 唯一真源：relay server 拥有账号目录与 presence；daemon 拥有 tmux/session truth；client 拥有 route selection 与 UI projection。
- 不越界：daemon 不持有客户端 UI 状态；UI 不补上游业务真相；route resolver 不改 payload 语义。
- 目录优先：Connections/Session Picker 消费 account directory，不再把 local bridge preset 当远端机器可连接的前置条件。
- 同账号一致：Settings、Connections、Home、Session Picker、Drawer 必须消费
  App 级同一份 confirmed directory generation；禁止组件各自读取账号缓存，
  禁止把远端 endpoint 自动写入本地 preset 后再作为下一次目录输入。
- 快照替换：同一稳定 `hostId` 的最新 daemon directory-update 是完整快照，
  必须原子替换旧 endpoints/sessions；禁止并集旧 registration 产生僵尸项。
- 本地与远端分层：显式手工 Host/preset 是客户端本地资源；Relay daemon 与
  tmux session 行是远端临时投影。历史缓存不能创建远端行，也不能覆盖目录。
- 显式候选：每条线路都是明确 candidate，不存在隐藏 fallback。
- 可观测：每次 route 选择必须能解释候选、评分、最终路径、失败原因。
- 先 map/test，后实现：新增 feature_id、function map、test design，再改行为代码。

## 技术方案与文件清单

### 1. Governance / Maps

新增 feature_id：
- `relay.account_directory`
- `relay.route_selection`
- `relay.directory_ui`

更新文件：
- `android/docs/feature-registry.json`
- `android/docs/function-map.md`
- `android/docs/feature-gates.md`
- `android/docs/testing/relay-account-directory-test-design.md`
- `android/docs/wiki/mainline-source.md` 如 mainline entry 变化
- `.agents/skills/zterm-mobile-dev/SKILL.md` 记录 relay directory / route selection 边界

### 2. Relay Directory Contract

新增共享类型，优先放在 shared 纯模块或 relay owner 模块，再由 Android/relay server 引用：

```ts
interface RelayAccountDirectory {
  schemaVersion: 1;
  user: { id: string; username: string };
  devices: RelayDirectoryDevice[];
  updatedAt: string;
}

interface RelayDirectoryDevice {
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  client: RelayPresence;
  daemon?: RelayDirectoryDaemon;
}

interface RelayDirectoryDaemon {
  hostId: string;
  version: string;
  presence: RelayPresence;
  endpoints: RelayEndpointCandidate[];
  sessions: RelayTmuxSessionSnapshot[];
  lastPublishedAt: string;
}

interface RelayEndpointCandidate {
  id: string;
  kind: 'tailscale' | 'ipv6' | 'ipv4' | 'relay-rtc';
  host?: string;
  port?: number;
  wsUrl?: string;
  relayHostId?: string;
  authRequired: boolean;
  lastSeenAt: string;
}

interface RelayTmuxSessionSnapshot {
  name: string;
  cwd?: string;
  title?: string;
  updatedAt: string;
}
```

规则：
- endpoint candidates 是目录事实，不是最终选择结果。
- session snapshot 来自 daemon tmux truth；relay server 只存和广播，不解释 session lifecycle。
- route health 可以由 client 上报为 account-scoped diagnostics，但不能覆盖 daemon endpoint truth。

### 3. Relay Server

修改/新增：
- `android/src/traversal-relay/store.ts`
- `android/src/traversal-relay/server.ts`
- `android/src/traversal-relay/store.test.ts`
- `android/scripts/traversal-relay-local-smoke.ts`

能力：
- store 增加 directory 结构与 migration：旧 store 只含 device presence 时可读为 empty endpoints/sessions。
- HTTP 增加 `GET /api/directory`。
- WebSocket devices stream 推送 `directory-snapshot`，保留 `devices-snapshot` 兼容期但不作为新 UI 真源。
- `/ws/host` 支持 daemon 发布 `directory-update`，包含 endpoints/sessions/version/health。
- server 只做 auth、persist、broadcast，不做 route selection。

### 4. Daemon Relay Host Client

修改/新增：
- `android/src/server/relay-client.ts`
- `android/src/server/terminal-control-runtime.ts`
- `android/src/server/terminal-message-runtime.ts`
- `android/src/server/daemon-config.ts`

能力：
- daemon 登录 relay 后发布 directory meta：hostId、deviceId、version、endpoint candidates、tmux sessions。
- session snapshot 由 daemon 自己从 tmux truth 获取；失败要显式上报错误，不伪造空列表为成功。
- endpoint candidates 来自 daemon config：tailscale/ipv6/ipv4/direct ws/relay rtc。未配置的不发布。
- tmux session 变化或固定间隔触发 directory update；避免高频 spam。

### 5. Android Client Directory Runtime

修改/新增：
- `android/src/lib/traversal-relay-client.ts`
- `android/src/hooks/useTraversalRelayAccount.ts`
- `android/src/hooks/useTraversalRelayDaemonDevices.ts` 或替换为 `useRelayAccountDirectory`
- `android/src/lib/relay-account-directory.ts`
- `android/src/lib/session-picker.ts`
- `android/src/lib/connections-server-groups.ts`

能力：
- 登录/刷新读取 directory，而不只读取 devices。
- App 全局维护 directory stream；Picker/Connections 消费同一 projection，不各自读 stale local snapshot。
- 无本地 bridge preset 时，relay daemon 仍能投影为 openable machine；route resolver 使用 directory endpoints 构造 target。
- 本地 bridge preset 只作为用户 pin / alias / auth override，不再是 relay daemon 可连接的前置条件。

### 6. Best Route Selection

修改/新增：
- `android/src/lib/traversal/config.ts`
- `android/src/lib/traversal/socket.ts`
- `android/src/lib/traversal/route-selector.ts`
- `android/src/lib/traversal/route-health-cache.ts`
- `android/src/lib/traversal/types.ts`

模型：
- `RouteCandidate`：从 directory endpoint + local policy 生成。
- `RouteProbeResult`：reachable/auth/RTT/error/timestamp。
- `RouteScore`：最终排序值，必须可解释。
- `SelectedRoute`：连接时唯一真相，写入 session diagnostics。

评分建议：
- unreachable 直接不可选。
- auth failure 直接不可选，除非用户修 token 后重新 probe。
- RTT 越低越好。
- 最近成功有短 TTL 加分。
- relay/TURN 成本高于 direct；但 direct 不通时 relay 正常胜出。
- user path priority 转为 weight，不是硬编码唯一排序。
- probe 超时要短而可配；不要让一次失败长期阻塞 UI。

### 7. UI

修改/新增：
- `android/src/components/settings/RelayControlSection.tsx`
- `android/src/pages/ConnectionsPage.tsx`
- `android/src/components/tmux/TmuxSessionPickerSheet.tsx`
- `android/src/components/connection-form/RelayDevicePicker.tsx`
- 可新增 `RemoteMachinesSection` / `RouteDiagnosticsSheet`

目标形态：
- Settings：relay base url、登录状态、账号、设备同步状态、高级 route policy。
- Connections：Remote Machines 卡片，显示 online/offline、session count、best route badge、RTT、last seen。
- Session Picker：先选 machine，再列 directory sessions；点击 session 直接 open，Connect 自动使用 selected best route。
- Diagnostics：每台机器显示 path table：Tailscale / IPv6 / IPv4 / Relay RTC / TURN，包含 status、RTT、last error、last success。

## 风险与规避

- 风险：目录模型和现有 `BridgeServerPreset` 双真源冲突。规避：明确目录是远端机器 truth，preset 是本地 pin/cache，不能反向覆盖目录。
- 风险：route selector 变成隐藏 fallback。规避：每个 candidate 显式建模，diagnostics 必须展示失败与选择理由。
- 风险：daemon 发布 session catalog 过频。规避：变化触发 + 最小间隔 + hash 去重。
- 风险：server 持有客户端状态。规避：server 只存 account directory / presence / relay signaling，不存 active tab 或 UI。
- 风险：旧客户端兼容。规避：短期保留 `devices-snapshot`，新 UI 只走 directory projection；兼容期结束后物理删除旧 projection。

## 测试计划

### Unit / Contract

- `src/traversal-relay/store.test.ts`
  - directory persistence / migration / account isolation / device disconnect stale handling。
- `src/traversal-relay/server*.test.ts`
  - `/api/directory` auth isolation。
  - `directory-update` broadcast。
  - invalid payload fail-fast。
- `src/lib/traversal/route-selector.test.ts`
  - scoring positive/negative cases。
  - auth failure 不可选。
  - stale route TTL 失效。
  - user priority 只影响 weight。
- `src/lib/traversal/config.test.ts`
  - directory endpoint candidates 生成正确。
- `src/lib/connections-server-groups.test.ts`
  - directory machine 无 preset 也可投影。
- `src/components/tmux/TmuxSessionPickerSheet.test.tsx`
  - 登录后显示 remote machines/sessions。

### Integration / Smoke

- `android/scripts/traversal-relay-local-smoke.ts`
  - register/login -> daemon publish directory -> client fetch directory -> route select -> list sessions。
- App relay stream lifecycle test：
  - directory-snapshot 更新 UI。
  - stream reconnect 后目录恢复。
- Existing gates：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - focused vitest suite。
  - build APK only after automatic gates green。

### Live Verification

- 在真实 relay + 至少一台 daemon 上验证：
  - 登录账号后 Connections 出现 machine。
  - 无本地 bridge preset 时，仍可看到 session 并连接。
  - route diagnostics 能显示最终 selected route 与失败候选。
  - direct 不通时 relay RTC 被显式选中；direct 恢复后按评分回到 direct。

Evidence 路径：
- `android/evidence/relay-directory/<YYYY-MM-DD>/`

## 实施步骤

1. 更新 feature registry / function map / test design，冻结 owner 和 gate。
2. 设计并落地 directory contract 类型，先加红测。
3. 扩展 relay store/server：`/api/directory`、`directory-update`、directory ws broadcast。
4. 扩展 daemon relay host client：发布 endpoints + tmux sessions。
5. 扩展 Android relay client：读取/监听 account directory。
6. 改 Connections/Session Picker projection：目录成为主入口，preset 降级为本地 pin/cache。
7. 新增 route selector / health cache / diagnostics，替换固定 priority-only 选择。
8. 改 UI：Remote Machines、best route badge、route diagnostics sheet。
9. 跑定向测试、typecheck、local relay smoke。
10. 构建 APK 并做真实安装态验证。
11. 已验证结论追加 `android/MEMORY.md`，新反模式/边界写入 local skill。

## 完成定义

- 登录 relay 后自动同步 machines/sessions/endpoints。
- 用户无需知道 ws/client、ws/host、hostId，也无需先手动保存 bridge preset，能直接从 Connections/Session Picker 打开远端 session。
- Auto route 有可解释的 best-route 选择，不再只是固定顺序尝试。
- UI 能看到当前机器、session、selected route、RTT/错误。
- server/daemon/client 职责边界保持清晰，无客户端状态进入 daemon/server。
- 定向测试、typecheck、local relay smoke、真实 APK 验证均有证据。
