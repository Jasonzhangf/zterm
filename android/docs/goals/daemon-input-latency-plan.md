# Daemon Input Latency Plan

## 1. 目标与验收标准

目标：完整审计并修复 daemon 输入链路的分钟级延迟、客户端退出后旧输入继续执行、多 pane 下输入被拖慢的问题，使输入链路具备可观测、可红测、可交付的生命周期闭环。

验收标准：
- 找到 daemon 输入链路唯一瓶颈，并用源码与运行态证据支撑。
- 每个问题先补红测，红测必须覆盖正向与反向边界。
- 修复后输入不得在 transport 关闭、session detach、客户端杀掉后继续写入 tmux。
- 多 pane / 多 session 场景下输入不能被输出刷新或其他 pane backlog 长时间阻塞。
- 输入 wire 保持 string-only，不引入 object payload，不裁剪真实 payload 语义。
- 通过定向测试、terminal regression、type-check、daemon runtime 验证。
- 构建新 APK 并交付到升级路径，输出 sha256。
- 精确提交本轮相关文件并推送，不 stage 无关 dirty 文件。

## 2. 范围与边界

In scope：
- daemon WebSocket / RTC 入站 message drain。
- `terminal-message-runtime` 的 input 门禁。
- `terminal-mirror-runtime` 的 input 写入 orchestration。
- `terminal-control-runtime` 的 tmux `send-keys` 写入策略。
- transport close / error / detach 后 stale input 的拒绝。
- daemon 输入链路 telemetry。
- 红测、回归测试、运行态验证、APK 构建与升级路径交付。

Out of scope：
- 不改终端真实 payload 语义，不通过裁剪输入内容提速。
- 不引入 fallback / 双路径补偿 / 静默吞错。
- 不让 daemon 持有 client active tab / foreground / viewport / follow / reading 状态。
- 不复制 runtime 源码到 app repo。
- 不做 UI 布局修复，除非为输入链路状态观测必须增加有界 metadata。

## 3. 已确认审计事实

运行态证据：
- `bash android/scripts/status-tmux-daemon.sh` 显示 daemon 正在运行：`com.zterm.android.zterm-daemon`，`0.0.0.0:3333`。
- `/debug/runtime` 快照显示 daemon 当前 `sessions.total=0`、`mirrors.total=17`、`mirrors.subscribers=0`，说明客户端已断开时 daemon 仍保留 mirror truth。
- `/debug/runtime/logs` 中可见 `session.input.send` 与大量 `buffer-sync`、`drop-summary`，但 daemon 端缺少 input receive / tmux write duration / stale drop 观测。

源码事实：
- `android/src/server/terminal-bridge-runtime.ts` 的 `ws.on('message')` 与 RTC `onMessage` 都是 `void deps.handleMessage(...)`，没有 per-transport 串行队列、没有 await、没有入站 backlog 观测。
- `android/src/server/terminal-message-runtime.ts` 在函数开头取一次 `session`，`input` 分支只检查 payload 是 string 后直接 `deps.handleInput(session, payload)`；缺少执行前 current transport / current session / readyState 二次门禁。
- `android/src/server/terminal-runtime.ts` 的 `detachSessionTransportOnly()` 会把 session 从 `sessions` 删除，但已经进入事件循环、闭包里持有旧 `session` 的 input 仍可能继续执行。
- `android/src/server/terminal-mirror-runtime.ts` 的 `handleInput()` 只按 `session.mirrorKey` 找 mirror，然后调用 `deps.writeToLiveMirror(...)` 与 `scheduleMirrorLiveSync(mirror, 0)`。
- `android/src/server/terminal-control-runtime.ts` 的 `writeToLiveMirror()` / `writeToTmuxSession()` 使用同步 `spawnSync(tmux send-keys)`；每次 input 都阻塞 Node event loop。

初步瓶颈结论：
- 核心瓶颈不是本地回显，而是 daemon 入站 input 没有 current-transport gate，加上每次 input 同步 `spawnSync(tmux send-keys)` 阻塞 Node event loop，导致 WebSocket / RTC 入站消息在内核、ws、Node 回调队列中堆积。
- 客户端杀掉后仍继续输入的合理解释是：旧 input 已经进入 daemon 事件队列或 ws buffer，detach 后没有 stale input gate，旧闭包仍持有 session 并继续写 tmux。

## 4. 设计原则

- 输入写入 tmux 前必须重新验证 transport 仍是当前 attached transport。
- input payload 继续保持 string-only；非 string input 必须显式 `input_invalid`，不得解包或 stringify。
- daemon 只��物理 transport、session attach、mirror、tmux truth；不引入客户端状态机。
- 性能优化必须保持输入语义等价，不允许丢弃已被当前 live transport 明确提交的合法输入。
- close / error / detach 后来自旧 transport 的 queued input 必须 drop，并记录 metadata 级 telemetry。
- tmux write 要从每 input 一次同步 spawn 改成 per mirror / per transport generation 的有界 coalescer 或 async writer，flush 前必须复验 source 仍 active。

## 5. 技术方案

### 5.1 daemon input telemetry

新增 daemon metadata 观测：
- input received：connectionId、transportId、sessionId、sessionName、payload length、receivedAt。
- input accepted / dropped：drop reason、current transport state、mirror state。
- tmux write start / done：durationMs、payload length、sessionName。
- pending input queue / coalescer：queue depth、coalesced count、flush duration。

禁止记录真实 terminal payload 内容；只允许长度、时间、id、状态、原因。

### 5.2 stale transport gate

在 `terminal-message-runtime` 或专门 input gate helper 中增加执行前复验：
- `connection.boundSessionId` 仍存在。
- `deps.sessions.get(connection.boundSessionId)` 仍为当前 session。
- `session.transportId === connection.transportId`。
- `session.transport === connection.transport`。
- `session.transport.readyState === OPEN`。
- `session.mirrorKey` 仍存在且 mirror lifecycle ready。

失败时 drop input，记录 `input.drop.stale_transport`、`input.drop.detached_session`、`input.drop.mirror_not_ready` 等 metadata。

### 5.3 input coalescer / writer

最小安全实现：
- 按 tmux sessionName / mirrorKey 建立 per-target bounded coalescer。
- 同一 tick 或短窗口内合并连续 string input，用单次 tmux write 写入。
- pending item 绑定 `transportId` / source generation；flush 前复验 source 仍 active。
- detach / close / error 时取消该 transport source 的 pending input。
- queue 超限时不得静默吞输入；必须显式 close stale/backpressured transport 或返回错误事件，并记录原因。

### 5.4 mirror sync 触发收敛

当前 `handleInput()` 每次 input 后 `scheduleMirrorLiveSync(mirror, 0)`，多字符输入会导致高频 reschedule。修复后：
- coalescer flush 成功后只触发一次 immediate mirror sync。
- flush 期间已有 mirror sync in-flight 时不得重复堆积。
- 保持 daemon mirror truth，不引入 client follow / viewport 逻辑。

## 6. 文件清单

预计触达：
- `android/src/server/terminal-bridge-runtime.ts`
- `android/src/server/terminal-message-runtime.ts`
- `android/src/server/terminal-mirror-runtime.ts`
- `android/src/server/terminal-control-runtime.ts`
- `android/src/server/terminal-runtime.ts`
- `android/src/server/terminal-runtime-types.ts`
- `android/src/server/terminal-debug-runtime.ts`
- `android/src/server/runtime-debug-store.ts`
- `.agents/skills/terminal-buffer-truth/SKILL.md`
- `android/docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md`
- `android/docs/dev-workflow.md`
- `android/note.md`
- `android/MEMORY.md`
- `android/CACHE.md`

预计新增/扩展测试：
- `android/src/server/terminal-message-runtime.test.ts`
- `android/src/server/terminal-mirror-runtime.test.ts`
- `android/src/server/terminal-control-runtime.test.ts`
- `android/src/server/terminal-transport-runtime.test.ts`

## 7. 红测矩阵

必须先红：
- transport close 后，旧 connection 再处理 input，不调用 `handleInput` / `writeToLiveMirror`。
- session 已 detach / `sessions.delete(session.id)` 后，闭包持有旧 session 的 queued input 不写 tmux。
- transportId 不匹配时，不写 tmux。
- readyState 非 OPEN 时，不写 tmux。
- mirror missing / failed 时，不写 tmux。
- object input payload 继续返回 `input_invalid`，不会写成 `[object Object]`。
- input burst 100 次不能触发 100 次 tmux spawn；必须被合并或串行限流。
- flush 前 detach 后，pending input 不写 tmux。

反向测试必须覆盖：
- 不能误杀当前 live transport 的合法输入。
- 不能因为某个旧 transport stale 而影响同 mirror 上新 transport 的输入。
- 不能把 mirror capture failure 包装成输入成功。
- 不能让 close/error 自动关闭 open tab；daemon 只 detach transport。

## 8. 实施步骤

1. 补文档与 skill 冻结 input lifecycle 规则：string-only、current-transport gate、detach 后 stale input drop、tmux write coalescer。
2. 补红测，确认至少 stale input / burst spawn / object payload 三类在当前实现下失败或已有 object payload 测试继续锁绿。
3. 增加 input telemetry，只记录 metadata，不记录 payload 内容。
4. 实现 current transport gate，并把所有 input 入口统一走该 helper。
5. 实现 bounded input coalescer，绑定 transport source，flush 前复验 source。
6. detach / close / error 清理 pending input source。
7. 收敛 input 后 mirror sync：flush 成功后触发一次 live sync。
8. 跑定向 server 测试与 source gate。
9. 跑 `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`。
10. 跑 `pnpm --dir android test:terminal:regression`。
11. 用 `/debug/runtime` 或本地 probe 做 daemon 在线验证，确认 stale drop / write duration / queue depth 可见。
12. 构建新 APK，复制到 `android/update-dist/` 与 `~/.wterm/updates/`。
13. 输出 APK 路径、sha256、验证结果。
14. 精确 stage 本轮相关文件，提交并推送。
15. 更新 `android/note.md`、`android/MEMORY.md`、`android/CACHE.md`。

## 9. 验证矩阵

必须通过：
- daemon input stale gate 定向测试。
- daemon input coalescer / writer 定向测试。
- object payload string-only 协议测试。
- transport detach lifecycle 测试。
- terminal source boundary gates。
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`。
- `pnpm --dir android test:terminal:regression`。
- daemon runtime `/debug/runtime` 快照或 logs 验证。
- Android APK build 与升级路径检查。

交付证据必须包含：
- 根因报告：源码证据 + 运行态证据。
- 红测失败与转绿摘要。
- daemon telemetry 示例，不含 terminal payload。
- APK 路径与 sha256。
- commit hash 与 push 成功证据。

## 10. 完成定义

任务完成必须同时满足：
- 客户端断开 / 杀掉后，旧输入不会继续写入 tmux。
- 多 pane / 多 session 下，input 不再因同步 tmux spawn backlog 出现分钟级延迟。
- daemon 输入链路有可观察的 receive / drop / write duration / queue depth metadata。
- 所有新增红测通过，terminal regression 通过。
- 新 APK 已交付到升级路径，用户可以直接升级测试。
- 本轮代码已提交并推送。
