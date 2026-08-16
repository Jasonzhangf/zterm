# 2026-04-23 Terminal 旧实现全面审计（删除优先）

目标：

- 不再在旧 terminal 架构上修修补补
- 先识别并移除**完全用不上的旧逻辑**
- 再在干净基线上重做新架构

原则：

> 不是断掉接线，而是移除旧实现。

---

## 1. 已确认并已删除的旧残留

### 1.1 废弃的协议消息类型

以下旧消息类型已从共享协议/Android 类型中移除：

- `data`
- `viewport-update`
- `scrollback-update`

对应文件：

- `packages/shared/src/connection/protocol.ts`
- `packages/shared/src/connection/types.ts`
- `android/src/lib/types.ts`

删除原因：

- 它们不属于新的 `head broadcast + range response` 真源
- 当前主链路也不再消费这些消息
- 保留只会继续污染协议心智模型

说明（历史背景，现已收口）：

- 当时 `TerminalSnapshot` 还残留在 Mac 本地 tmux 过渡链路里
- 现在终端活代码已经不再保留 `TerminalSnapshot` 作为协议或 runtime 真源

---

## 2. 旧实现中必须整块删除的模块（下一批）

这些模块不是“局部修补”问题，而是**整块角色错误**，后续应整体替换。

### 2.1 Android renderer：`android/src/components/TerminalView.tsx`

当前问题：

- 自己维护 `followMode`
- 自己发 `onViewportChange`
- 自己挂旧式 `prefetch` 侧路
- 自己带 `followViewportNonce / viewportLayoutNonce`
- 自己把 scroll / 旧式补拉 / viewport / follow reset 搅在一起

为什么必须删：

- 新真源里 renderer 只负责：
  - bottom-relative render window
  - consume current sparse buffer
  - 缺失则报“当前窗口缺口”
- 它不该再承担 transport / 补拉策略 / follow 状态机

结论：

- 这个文件需要**按新职责整块重写**
- 不是继续在里面减 if/else

### 2.2 Android session orchestration：`android/src/contexts/SessionContext.tsx`

当前问题：

- 同时维护：
  - websocket lifecycle
  - reconnect
  - 旧 `stream-mode`
  - 旧 buffer-sync 请求规划
  - 旧 tail bootstrap
  - tail probe
  - 旧 viewport prefetch
  - follow reset nonce
  - render cadence buffering

为什么必须删：

- 新真源要求 client 拆成：
  - transport/session
  - sparse buffer worker
  - renderer container
- 当前这个文件把三层揉成了一层

结论：

- 旧的 `requestBufferSync / sendTailBootstrap... / sendFollowRefresh... / probeActiveFollowTail / requestViewportPrefetch / updateSessionViewport`
  这一整套都应删除
- 不做“保留函数名，换内部实现”的假重构

### 2.3 daemon active-push 架构：`android/src/server/server.ts`

当前问题：

- 保存 `lastBufferSyncRequest`
- 旧 `stream-mode active/idle`
- `scheduleMirrorFlush`
- `flushMirrorUpdates`
- `buildLiveBufferPayloadForSession`
- `pushMirrorBufferSyncToSubscribers`
- 主动 push `buffer-sync`

为什么必须删：

- 新真源里 daemon 只做：
  - head 查询响应
  - range request response
- daemon 不该按 client 消费状态持续推数据

结论：

- 以上主动推送链必须整块移除
- server 侧会围绕“session head + range read”重新建模

### 2.4 shared renderer：`packages/shared/src/react/terminal-view.tsx`

当前问题：

- 和 Android 版一样，仍然是老式 follow / 旧式补拉 / viewport-change renderer
- Mac 还在消费这套旧 renderer

结论：

- 这份 shared TerminalView 后续也要整块替换
- 否则 Mac 会继续把旧角色耦合带回来

### 2.5 Mac runtime 接口

涉及文件：

- `mac/src/pages/ShellWorkspace.tsx`
- `mac/src/pages/TerminalSlot.tsx`
- `mac/src/lib/terminal-buffer-store.ts`
- `mac/src/lib/local-tmux-transport.ts`

当前问题：

- 当时仍沿用 `onViewportChange / onViewportPrefetch`
- 仍消费旧 shared TerminalView
- 当时本地 tmux transport 仍带有旧 snapshot 转 buffer-sync 的过渡桥

结论：

- 在 shared renderer / worker 重做后，这批接口要一起删旧换新

---

## 3. 当前仍保留但需要重判的重复实现

### 3.1 terminal buffer reducer 双份实现

当前同时存在：

- `android/src/lib/terminal-buffer.ts`
- `packages/shared/src/connection/terminal-buffer.ts`

这不是“立刻可删”的死代码，因为两边都在用。

但它们的命运必须在重做时二选一：

- 要么完全共享一份 sparse buffer worker/reducer
- 要么明确平台专属边界

禁止继续双份演化。

---

## 4. 当前审计结论

### 可以立即删掉的

- 旧协议残留类型（本轮已删）

### 必须下一批整块删除/替换的

1. `android/src/components/TerminalView.tsx`
2. `android/src/contexts/SessionContext.tsx`
3. `android/src/server/server.ts` 中 active-push / 旧 stream-mode / request-coupled push 部分
4. `packages/shared/src/react/terminal-view.tsx`
5. Mac 侧 old viewport / old prefetch runtime 接口

### 不允许的做法

- 保留旧模块只“断接线”
- 在旧模块上继续打补丁
- 新旧 worker / renderer / protocol 长期并存

---

## 5. 后续执行顺序

1. 删除 daemon 主动 push 链
2. 删除 client renderer 反向驱动 transport 链
3. 重建 session head/range protocol
4. 重建 sparse buffer worker
5. 重建纯 renderer container
6. 最后把 UI shell 接回去
