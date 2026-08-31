# Android Relay Route 修复与 OTA 发布计划

## 目标与验收标准

修复 Android 连接在非同一局域网时错误选择 `192.168.x.x` LAN endpoint 的问题：Relay directory 保留同一 daemon 的完整 endpoint candidates，transport 将 LAN 建模为独立 route，只在 Android 当前网络与该 LAN endpoint 同网段时纳入候选；否则从 Tailscale 开始按 canonical 顺序连接。保存的 Host 配置保持原值，并生成包含真实修复的新 APK，验证公网 OTA 路径可获取该 APK。

验收必须同时满足：

- healthy LAN 仍遵守 canonical Auto 顺序；
- 非同网段 LAN 不进入 Android native 候选；同网段 LAN 握手失败后，同一 generation 继续尝试 Tailscale；
- saved Host、BridgeServerPreset、Relay directory payload 不被 picker 层覆盖或改写；
- 正反向 route、失败、重试和非 terminal 状态测试通过；
- canonical Android build、OTA bundle、`latest.json`、APK checksum 全部一致；
- 公网 URL 返回的 `latest.json` 与 APK 可下载，checksum 与 manifest 一致；
- 安装/重启/在线真实样本确认新运行版本确实包含修复；
- AGY review PASS 后才允许 merge、commit、push 和 close。

## 范围与边界

In scope：

- `android/src/lib/traversal/config.ts`、route types、Bridge settings 及其既有测试主线；
- Android Connection Service 的 typed target、LAN eligibility 和有序候选流程；
- Relay endpoint candidate 到 transport route 的实体归并、分类和投影；
- Android APK 构建、rollback APK、OTA bundle、manifest 和公网可达性验证；
- 与 `connections.history_projection` / `android.relay.endpoint_preference` 对应的 registry、evidence 和 task lifecycle。

Out of scope：

- 不修改 `session-picker.ts` 来伪造 Tailscale 优先；
- 不覆盖或删除 saved `bridgeHost`、BridgeServerPreset target 或 Relay directory truth；
- 不改变 canonical LAN → Tailscale/direct websocket → WebRTC → TURN 的默认顺序；
- 不修改 daemon/client payload 以携带控制状态；
- 不直接编辑 `.agent-collab`、journal、claims、task JSON；
- 不把抽屉 availability 修复的 APK 或证据当作本任务完成证据。

## 设计原则

1. 唯一 owner 是 Session/Transport 的 route selector/socket failure path；UI picker 只展示 saved Host 与候选，不决定物理线路。
2. 先确认首次语义偏离：LAN close/error 是否进入 route health；若没有，修该唯一记录点，再由 selector 重新计算。
3. 禁止 fallback、silent success、静默吞错和“测试通过但运行路径不变”的 test-only 修复。
4. 保持控制面与业务 payload 隔离；健康度、失败原因和重试控制不写入 terminal 业务 payload。
5. 所有代码改动必须在一个干净、声明过的 peer worktree 中完成；task owner 自己完成实现、验证、集成、push 和关闭，永久 master/worker 角色不参与生命周期。

## 技术方案与文件清单

先阅读并核对：

- `android/docs/architecture.md`
- `android/docs/audits/2026-07-02-architecture-boundary-remediation.md`
- `android/docs/resource-registry.json`
- `android/docs/resource-map.md`
- `android/docs/module-registry.json`
- `android/docs/edge-registry.json`
- `android/docs/function-map.md`
- `android/docs/wiki/mainline-call-map.json`
- `android/docs/feature-registry.json`
- `android/src/lib/traversal/route-selector.ts`
- `android/src/lib/traversal/config.ts`
- `android/src/lib/traversal/types.ts`
- `android/src/lib/bridge-settings.ts`
- `android/src/lib/android-connection-service-commands.ts`
- `android/native/android/app/src/main/java/com/zterm/android/AndroidConnectionService.java`
- `android/native/android/app/src/main/java/com/zterm/android/AndroidConnectionServiceRoutePolicy.java`
- `android/native/android/app/src/main/java/com/zterm/android/AndroidConnectionServiceTarget.java`
- `android/src/lib/traversal/route-selector.test.ts`
- `android/src/lib/traversal/config.test.ts`

只允许在确认唯一 owner 后修改必要的 transport source/test 文件。Web 层负责把 directory endpoint 原样分类为 `lan` / `tailscale` / `ipv4` / `ipv6`；Android Connection Service 是 native LAN eligibility 的唯一 owner，按本机 interface prefix 决定 LAN 是否进入候选，再复用既有 candidate failure lifecycle。不得新建第二套 resolver，也不得在 picker 覆盖 route truth。

## 风险与规避

- LAN healthy 被错误改成 Tailscale-first：加入 healthy LAN 反向测试，并验证 diagnostics 仍为 LAN。
- 保存地址被运行时覆盖：对 Host/preset 做 snapshot 回归，禁止 picker source diff。
- 非同网段 LAN 仍被尝试：native gate 构造不匹配 interface prefix 的 LAN target，断言首个候选是 Tailscale。
- 同网段 LAN failure 未继续候选：native gate 触发 LAN WebSocket failure，断言同一 generation 继续 Tailscale，而不是终止或重建 transport。
- Tailscale 失败被伪装成成功：加入 Tailscale failure negative test，要求显式错误状态。
- build 使用错误 AppSDK：先校验 `/Users/fanzhang/.local/lib/appsdk/0.1.4/appsdk` 的固定 SHA，再用 PATH-scoped command。
- OTA 只更新 manifest 未发布 APK：运行 `verify-update-bundle.mjs`，再用公网 URL 下载并校验字节数/SHA-256。
- 运行版本与源码不一致：构建后安装/重启真实 daemon 与 APK，记录版本、路径和 checksum。

## 测试计划与验证矩阵

| 层级 | 必须证明 |
|---|---|
| route config | directory LAN 保持独立 `lan` 类型；canonical 顺序为 LAN → Tailscale → public IPv4/IPv6 → RTC direct → TURN |
| native lifecycle | 同网段才纳入 LAN；非同网段从 Tailscale 开始；候选失败后同一 generation 继续下一项 |
| boundary | saved Host/picker/preset 不改写；无 payload 控制语义泄漏；module/edge/function map 通过 |
| project gates | 定向 Vitest、feature registry、type-check、`git diff --check`、canonical `build:android` |
| OTA | rollback APK、prepare bundle、verify bundle；manifest/APK checksum/size 一致 |
| live | 公网 `latest.json` 和 APK 下载；daemon 重启；真实跨 LAN/Tailscale 连接样本；在线设备安装验证 |
| review | 完成上述验证后启动 AGY review；P0/P1 必须为 0 |

## 实施步骤

1. Task owner 在 live tmux pane 执行 `collab init`，用最新 main、独立 worktree 和 branch 自注册唯一 task；不重复创建同义 task，也不使用已废弃的 master/worker/claim/dispatch 角色流程。
2. 读取 MemoryPalace/项目 note/run notes 和全部架构 maps，记录资源 owner、允许边和当前基线。
3. 追踪 `Relay directory → traversal config → typed Android target → native candidate list → candidate failure`，锁定首次偏离并先写红测。
4. 在各自唯一 owner 做最小修复：Web config 只分类 endpoint，Android native 只判定 LAN eligibility；补正向和反向测试，确保 saved Host truth 不变。
5. 运行定向测试、registry、type-check、build；固定使用 AppSDK 0.1.4 canonical binary。
6. 生成 APK/rollback APK 和 OTA bundle；运行 verify-update-bundle；从公网 URL 下载并校验 manifest、APK checksum、版本号。
7. 安装并重启实际 daemon/客户端，使用跨 LAN 的 Tailscale 真实样本验证；记录在线证据。
8. 只有实现、构建、安装、重启、在线验证全部完成后运行 AGY review。FAIL 必须修复并新建 review。
9. Task owner 记录完整 evidence，精确集成到主树并重跑主树验证；push 成功且本地/远端 main 一致后标记 merged，再执行 `collab task close` 清理自己的 worktree/branch。

## 完成定义（DoD）

- 非同 LAN 时不再把不可达 private LAN 当作唯一终点；LAN failure 后实际选择 Tailscale 并可连接。
- 同 LAN healthy 时仍优先 LAN；Tailscale/Relay failure 不会伪装成功。
- saved Host、preset、Relay directory 和任务/evidence/worktree/branch 真相完整保留。
- 新 APK 与公网 OTA manifest/下载文件版本和 checksum 一致，rollback 包可验证。
- 真实安装/重启/在线样本证明运行版本与修复 commit 一致。
- AGY review PASS；主树已合并并 push；Collab task 已 close；无重复 feature/worktree owner、未释放资源占用或未处理 migration blocker。
- 本任务不以“定向测试通过”单独宣称完成；任何未完成 live/public gate 都必须明确报告。
