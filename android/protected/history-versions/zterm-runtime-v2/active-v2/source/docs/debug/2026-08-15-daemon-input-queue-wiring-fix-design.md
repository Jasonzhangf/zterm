# Fix Design Report

Design ID: `FD-20260815-DAEMON-INPUT-QUEUE-WIRING-01`

Date: 2026-08-15

Owner: `daemon.input_queue` / `server.ts` composition root

Status: `IMPLEMENTED`

Authorization basis: Jason 的最终执行 goal 明确要求直接按
`ZTERM-ARCH-V2-DESIGN-001` 实现，不再等待同一任务的额外确认；本修复属于
该 goal 内 `daemon.input_queue` 生产切片。

## Goal

让 `daemon.input_queue` 生产接线在运行时可启动、可断开、可完整跑完
`daemon:mirror:close-loop`。当前 `terminal-runtime.ts` 在 detach/close 时调用
`deps.daemonInputQueue.disposeLiveMirrorInputBatch`，但 `server.ts` 传入的
`daemonInputQueue` 是在该 runtime 创建后才赋值的 binding，实际值是
`undefined`，第一个 WebSocket 断开就会让 daemon 崩溃。

## Confirmed Root Cause

`server.ts` 初始化顺序是：

1. `terminalRuntime = createTerminalRuntime({ daemonInputQueue: daemonInputQueueRuntime, ... })`
2. `terminalTransportRuntime = createTerminalTransportRuntime(...)`
3. `daemonInputQueueRuntime = createDaemonInputQueueRuntime({ handleInput: (s) => terminalRuntime.handleInput(s), ... })`

`daemonInputQueueRuntime` 使用 definite assignment，创建 terminal runtime
时仍未赋值；对象属性会复制当前值 `undefined`，不是闭包引用 binding。
因此首个 `probe.close()` 触发
`terminal-bridge-runtime.ts` 的 detach 路径时，
`deps.daemonInputQueue.disposeLiveMirrorInputBatch` 抛
`TypeError: Cannot read properties of undefined`，daemon 进程退出。

首次偏离点不是 terminal runtime 的 detach 逻辑，而是 composition root 在
对象创建时把未初始化的 runtime 值拷进了 deps。

## Positive / Reverse Evidence

Red baseline（生产工作树，未打补丁）：

`pnpm --dir android run daemon:mirror:close-loop` 在 `codex-live: PASS` 后于
`top-live` 失败：

```text
[daemon-mirror-lab] codex-live: PASS
[daemon-mirror-lab] top-live: FAIL
  reason: connect ECONNREFUSED 127.0.0.1:61462
```

`evidence/daemon-mirror/2026-08-15/current-daemon.log` 保留：

```text
/Volumes/extension/code/zterm/android/src/server/terminal-runtime.ts:261
      deps.daemonInputQueue.disposeLiveMirrorInputBatch(mirror.sessionName, `detach:${reason}`, mirror.backend);
                            ^
TypeError: Cannot read properties of undefined (reading 'disposeLiveMirrorInputBatch')
    at Object.detachSubscriberTransportOnly (...)
```

Reverse baseline（隔离 worktree
`android/tmp/worktrees/android`，只改 `server.ts`）：

```text
[daemon-mirror-lab] codex-live: PASS
[daemon-mirror-lab] top-live: PASS
[daemon-mirror-lab] vim-live: PASS
[daemon-mirror-lab] initial-sync: PASS
[daemon-mirror-lab] local-input-echo: PASS
[daemon-mirror-lab] long-input-echo: PASS
[daemon-mirror-lab] external-input-echo: PASS
[daemon-mirror-lab] daemon-restart-recover: PASS
[daemon-mirror-lab] schedule-fire: PASS
[daemon-mirror-close-loop] all replay + strict audit cases passed
```

隔离 worktree 还跑了 `tsc -p tsconfig.json --noEmit`，PASS。

## Design

在 `server.ts` 中保留现有初始化顺序，把 `daemonInputQueueRuntime` 的未初始化
binding 转成 late-bound forwarding proxy。`server.ts` 是 composition root，
允许只做接线；proxy 不实现队列语义，不复制业务逻辑，不提供 fallback。

```ts
let daemonInputQueueRuntime!: ReturnType<typeof createDaemonInputQueueRuntime>;
const daemonInputQueueRuntimeProxy: ReturnType<typeof createDaemonInputQueueRuntime> = {
  handleInputMessage: (connection, payload) =>
    daemonInputQueueRuntime.handleInputMessage(connection, payload),
  enqueueLiveMirrorInput: (sessionName, payload, appendEnter, shouldWrite, backendKind) =>
    daemonInputQueueRuntime.enqueueLiveMirrorInput(
      sessionName,
      payload,
      appendEnter,
      shouldWrite,
      backendKind,
    ),
  disposeLiveMirrorInputBatch: (sessionName, reason, backendKind) =>
    daemonInputQueueRuntime.disposeLiveMirrorInputBatch(sessionName, reason, backendKind),
};
```

`createTerminalRuntime` 的 deps 改为
`daemonInputQueue: daemonInputQueueRuntimeProxy`；真正
`createDaemonInputQueueRuntime` 的创建位置不变。由于 daemon 只有在全部
runtime 创建完成后才接受连接，proxy 方法被调用时 real runtime 已赋值。

Allowed paths:

- `server.ts` 只持有 forwarding proxy，不新增业务状态。
- `terminal-runtime.ts` / `terminal-mirror-runtime.ts` 继续只消费
  `DaemonInputQueueRuntime` 接口。
- `daemon-input-queue-runtime.ts` 的 receive/ack/dedupe/queue/write owner
  不变。

Forbidden:

- 不移动或复制 queue 实现。
- 不把 detach 时清理输入队列改为 silent skip。
- 不把 runtime 创建顺序改成可能让 daemon 提前接受连接。
- 不增加 fallback / dual path。

## Verification Contract

正式修复已应用，需重跑：

1. `pnpm --dir android run test:feature-registry`
2. `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
3. `pnpm --dir android run daemon:mirror:close-loop`
4. 定向 server 套件（`daemon-input-queue-runtime.test.ts`、
   `terminal-message-runtime.test.ts`、control/mirror/backpressure/detached
   相关测试）

回归测试目标：运行时 detach/close/destroy 必须调用
`disposeLiveMirrorInputBatch`，且 daemon 不得崩溃；`daemon:mirror:close-loop`
必须 9/9 + replay + strict audit 全绿。

## Non-Goals

- 不改变 `daemon.input_queue` 的协议、payload、chunking、ack/dedupe 语义。
- 不改变 `terminal-runtime.ts` 的 detach/close/destroy 清理策略。
- 不处理 `FileTransferSheet.test.tsx` 并行环境 flake，那是既有无关回归缺口。

## Evidence

- Red: `android/evidence/daemon-mirror/2026-08-15/top-live`
- Red log: `android/evidence/daemon-mirror/2026-08-15/current-daemon.log`
- Green isolated run:
  `android/tmp/worktrees/android/evidence/daemon-mirror/2026-08-15`
- Candidate patch in isolated `server.ts`:
  `android/tmp/worktrees/android/src/server/server.ts`
