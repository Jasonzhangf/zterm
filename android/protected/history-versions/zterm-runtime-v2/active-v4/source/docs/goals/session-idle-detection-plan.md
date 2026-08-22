# Session Idle/Stopped Detection — Implementation Plan

## 目标

daemon 探测 tmux session 10秒无屏幕更新，通过独立 message type `session-activity` 经控制通道发送给 client。

## 验收标准

1. 新增 `session-activity` message type，不修改 `sessions` payload（旧 client 零报错）
2. daemon 在 heartbeat 时和 attach 时均发送 `session-activity`
3. `SESSION_IDLE_STOPPED_THRESHOLD_MS = 10_000` 独立常量，不 alias `MIRROR_LIVE_SYNC_IDLE_MS`
4. 注册表完整（feature / resource / edge / function-map / mainline-call-map）
5. L0 gate: `test:feature-registry` + `tsc --noEmit` + JSON parse
6. L1 gate: 单测 idle 分类（threshold boundary / resume / no-mirror / multi mirrors）

---

## Wire Shape

**独立 message type，不动 sessions payload：**

```typescript
// protocol.ts 新增
type TerminalMuxTargetServerMessageType =
  | 'sessions'
  | 'session-activity'   // ← 新增
  | 'debug-control'
  | 'error'
  | 'pong'

// 新增 type
interface SessionActivity {
  name: string
  lastLiveActivityAt: number   // unix ms, mirror.lastLiveActivityAt
  stopped: boolean            // now - lastLiveActivityAt >= 10_000
}

// 独立 message
{ type: 'session-activity'; payload: { activities: SessionActivity[] } }
```

---

## 文件清单

| 文件 | 操作 |
|---|---|
| `packages/shared/src/connection/protocol.ts` | 新增 `session-activity` variant + `SessionActivity` interface |
| `android/src/server/terminal-session-activity-runtime.ts` | 新建；纯函数 idle 分类 |
| `android/src/server/terminal-message-control-runtime.ts` | attach 时发 `session-activity` |
| `android/src/server/terminal-daemon-runtime.ts` | heartbeat 时 piggy-back `session-activity` |
| `android/docs/decisions/2026-07-30-session-idle-stopped-notification.md` | 更新 wire shape，status 改 design-rev2 |
| `android/docs/feature-registry.json` | 新增 `daemon.session_idle_detection` row |
| `android/docs/resource-registry.json` | 新增 `resource.session_idle_facts` |
| `android/docs/edge-registry.json` | 新增 2 条 edge |
| `android/docs/function-map.md` | 新增对应 row |
| `android/docs/wiki/mainline-call-map.json` | 新增 `IdleActivityClassifier`、`IdleSessionBroadcast` 节点 |

---

## 实施步骤

1. 更新设计 doc，wire shape 改独立 msg type，status 改 design-rev2
2. 补 4 个注册表/manifest
3. 跑 L0 gate: `test:feature-registry` + `tsc --noEmit` + JSON parse
4. 改 `protocol.ts`：加 `session-activity` variant + `SessionActivity` type
5. 写 `terminal-session-activity-runtime.ts`：纯函数 idle 分类
6. 写单测 `terminal-session-activity-runtime.test.ts`
7. 改 `terminal-message-control-runtime.ts`：attach 时发 `session-activity`
8. 改 `terminal-daemon-runtime.ts`：heartbeat 时 piggy-back `session-activity`
9. L0/L1 gate
10. codex review（`codex -p cc review`）
11. 提交推送

---

## 风险与规避

- 风险：旧 client 收到 `session-activity` 会报错 → 规避：独立 type，旧 client switch 不命中即忽略
- 风险：`lastLiveActivityAt` 为 0 的 session 被误判 stopped → 规避：初始化为 `now`，或 idle 判断加 `lastLiveActivityAt > 0` guard
- 风险：heartbeat 时 mirror 未初始化 → 规避：map.get(session) 为空则 skip

---

## 验证矩阵

| 场景 | 预期 | 验证方式 |
|---|---|---|
| session 有活动 | `stopped: false` | 单测 |
| session 10s 无活动 | `stopped: true` | 单测 |
| 活动恢复 | `stopped: false` | 单测 |
| 无 mirror 的 session | 不 crash，skip | 单测 |
| 多 mirror 场景 | 每个独立分类 | 单测 |
| 旧 client 收到新 msg | 忽略，零报错 | 手动兼容性验证 |
| L0 gate | `test:feature-registry` 通过 | CI |

---

## 完成定义 (DoD)

- [ ] 独立 `session-activity` type 已在 protocol.ts 实现
- [ ] idle 分类逻辑有单测覆盖（threshold boundary / resume / no-mirror / multi mirrors）
- [ ] heartbeat 和 attach 触发路径已实现
- [ ] 所有注册表已更新
- [ ] L0 gate 通过
- [ ] codex review 通过（语义 PASS）
- [ ] 已提交推送
