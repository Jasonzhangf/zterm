# zterm 弱网延迟修复计划

## 1) 目标与验收
- 目标：修复“多机 + tab 切换 + 弱网”下输入/输出高延迟，优先保证 active tab 交互实时性。
- 验收：
  - 弱网下 active tab 输入到首个回显延迟显著下降；
  - tab 切换后首屏刷新稳定，无 hidden tab 抢占导致的排队；
  - 回归用例可复现、可失败、修复后稳定转绿。

## 2) 范围与边界
### In Scope
- transport stale 探测/重连等待策略
- head/buffer-sync cadence 与 debounce 动态化
- active/hidden tab 调度隔离与切换时 pull bookkeeping 清理

### Out of Scope
- daemon mirror 写侧重构
- renderer 语义改造
- payload binary 协议改造（留作 P2）

## 3) 关键方案（按优先级）
### P0
1. Tab 切换时显式 reset 旧 tab pull bookkeeping，避免污染新 active tab。
2. 将 stale probe 等待阈值改为 RTT 感知，弱网下缩短 probe->reconnect 时延。
3. cadence 改为 RTT 感知：动态调节 headTickMs / pullRequestStaleMs。

### P1
4. hidden tab 降频 probe（低频），active tab 优先刷新。
5. buffer-sync debounce 改为 RTT 感知，避免弱网下错过关键 tail refresh。

## 4) 文件清单
- `android/src/contexts/session-context-core.ts`（P0-1 tab drain）
- `android/src/contexts/session-context-activity-runtime.ts`（P0-2/3 cadence）
- `android/src/contexts/session-context-buffer-runtime.ts`（P1-5 debounce）
- `android/src/contexts/session-context-provider-facade-assemblies.ts`（probe wait）
- `android/src/lib/mobile-config.ts`

## 5) 验证矩阵
1. 弱网输入延迟对比（before/after 日志）
2. tab A/B 连续切换首屏刷新与输入回显
3. 前后台恢复后 active tab 实时性
4. 相关单测通过（activity/buffer cadence）
