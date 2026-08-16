# 设计文档：输入延迟 & 远程路径错误修复

> 生成时间：2026-05-17
> 对应 goal：mobile-17

## 1. 问题拆解

### 问题 A：切换 session 后输入延迟大

**现象**
- 切 tab/session 后输入回显慢，多客户端也慢
- 输出正常 → 下行链路无问题，问题在上行（client→daemon→tmux）

**已审计代码**
- 输入真源：`session-context-input-runtime.ts` `sendInputThroughSessionTransport`
  - 每条 input 后都调 `requestSessionBufferHead(force:true)` → 可能请求堆积
  - stale transport 时调 `probeOrReconnectStaleSessionTransport` → 可能阻塞发送
  - `hasPendingSessionTransportOpen` 时直接 return → input 丢失而非延迟
- switchSession 后 `ensureActiveSessionFresh` 与 input 并发竞争同一 transport 发送队列

**已验证入口**
- 已有测试：`session-context-input-runtime.test.ts`
- `git log -1 -- android/src/contexts/SessionContext.tsx` = f4b5975

### 问题 B：远程 cwd 显示为 `/`

**现象**
- session 工作目录是 `/` 而非配置路径

**已审计代码**
- server 侧测试有 `cwd: process.cwd()` 使用，需追 daemon `new-session -c` 参数链路

## 2. 执行计划

### Phase 1：真源定位（不修改代码，先加 log 量化）
- [ ] 在 `sendInputThroughSessionTransport` 入口/`ws.send` 两处打 timestamp，量化延迟
- [ ] 确认 `requestSessionBufferHead(force:true)` 是否阻塞 input 发送
- [ ] 确认 `probeOrReconnectStaleSessionTransport` 调用耗时
- [ ] 查 daemon 中 `new-session -c` 参数传递

### Phase 2：修复
- [ ] 若根因是 head force 堆积 → 改为 input 后不强制 head，只标记 tail-refresh
- [ ] 若根因是 stale probe 阻塞 → 去掉 input 路径的 probe，仅在 transport 真正断开时 reconnect
- [ ] 若根因是 refresh/input 并发 → input 优先于 buffer pull 使用 transport
- [ ] cwd：确认 daemon `new-session -c` 或 connect payload 的 cwd 字段

### Phase 3：测试
- [ ] 补 `sendInputThroughSessionTransport` 的 stale/reconnect/normal 三态测试
- [ ] 验证 cwd 传递链路

## 3. 验证矩阵

| 场景 | 标准 |
|------|------|
| 单 session 输入延迟 | < 100ms |
| 切 session 后输入延迟 | 与切前一致 |
| 多客户端输入 | 各客户端独立不互锁 |
| 远程 cwd | `pwd` 输出配置路径 |
| 测试 | `pnpm vitest run session-context-input-runtime` 全绿 |

## 4. 关键文件

- `android/src/contexts/session-context-input-runtime.ts`
- `android/src/contexts/session-context-transport-runtime.ts`
- `android/src/contexts/SessionContext.tsx`
- `android/src/contexts/session-context-pull-runtime.ts`
- daemon：`../wterm/src/server/` 中 input handler + tmux session 创建
