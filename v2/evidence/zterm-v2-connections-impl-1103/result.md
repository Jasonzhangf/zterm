# zterm-v2-connections-impl-1103 结果（rev21 定向 rework）

任务：zterm-v2-connections-impl-1103。Owner: Frank。Reviewer: David。Integrator: Jenny。P1。

## 本轮结论

只修 David `120a5c8c` 两条原 finding，保留 `129f6d43` 与 `1224316f` 已接受/已验证的生命周期、错误链和代际修正。修复已落到 `v2/modules/connections/**`。

核心修正：

- `deriveChannelKinds` 不再把 terminal mux 的 `channelEnvelope`/`bulkChannel` 当 generic message/file 服务声明。只有 `channelEnvelope === true` 映射为 `terminal` 会话通道能力；generic message/file/receipt/status 显式 `unsupported_channel`。
- `openChannel(LinkRef, kind, target?)` 改为异步；terminal 必须带真实 `sessionName`/`backend`/`expectedSessionIdentity`，发送真实 `mux-channel-open` 并等待 `mux-channel-opened` 后才注册 ChannelRef 与允许 send。
- `sendChannel` 只能写已 ack 的 channel；未注册地址不可能由公开入口产生。
- 真实 bridge 错误 token 的 `{type:"error",payload:{code:"unauthorized"}}` 先于 4001 到达，已按真实帧分类为 `unauthorized`。
- `mux-ready.daemonHostId` 缺失时 `peerIdentity=null` 且不把期望身份写成观测；出现并匹配才 verified，出现但不匹配仍 `peer_identity_mismatch`。

## 接口

- 公开入口：`v2/modules/connections/src/index.ts`。
- 公开类型：`v2/modules/connections/src/public/types.ts`（`LinkKind` 增加 `terminal`；`TerminalChannelTarget`、`ChannelOpenRequest`、`ChannelOpenResult`）。
- 授权端口：`ports/accounts-authorization.ts`（不读凭据）。
- 物理传输：`adapters/v1-traversal.ts`（复用 `@zterm/shared/connection/traversal` 与 terminal mux protocol）。
- 通道协商/隔离：`channels/dispatch.ts`（真实 open/ack 后才注册）。
- `/app` codec：`adapters/app-websocket.ts`（只做 V1 帧校验；真实 /app 数据面下一增量）。

## 证据

- `rework/rev21-vitest.log`：36 passed，3 skipped（contract 22 + real-entry 14；real-daemon 默认 skipped）。
- `rework/rev21-tsc.log`：`tsc --noEmit` exit 0。
- `rework/rev21-red-vitest.log`：rev21 红测 3 failed；`rework/rev21-red-tsc.log`：对应 type errors。
- `rework/rev21-targeted.log`：新增 late-open close-failure + retry 单独 1 passed。

- `rework/final-vitest.log`：全量 27 passed（contract 18 + real-entry 9）；real-daemon 3 skipped（默认）。
- `rework/real-daemon-vitest.log`：真实 V1 daemon 3 passed（连接/能力/unsupported + 真实 open/ack + wrong token unauthorized）。
- `rework/final-tsc.log`：`tsc --noEmit` exit 0。
- `rework/interface-map.md`：公开接口与能力映射。
- `rework/channel-addressing-isolation.md`：真实 open/ack、地址隔离、负例证据。
- `red-vitest.log`：旧实现的 6 failed / 17 passed 红测基线（保留）。
- module OBSERVATION/PLAN：R4 设计判断与真实事实。

真实 V1 daemon 黑盒参数：`ZTERM_REAL_DAEMON=1 ZTERM_REAL_DAEMON_HOST=192.168.0.3 ZTERM_REAL_DAEMON_PORT=3333`，token 来自本机 `~/.zterm/config.json`，不落盘。open 使用真实 `list-sessions` 得到的 existing tmux stableId，`existingOnly:true`、`bodySubscribed:false`、不传 cols/rows；只读 attach，不写 tmux 几何/正文。

## 精确命令

```sh
cd v2/modules/connections
node ../../../packages/cli/node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node ../../../packages/cli/node_modules/vitest/vitest.mjs run --config vitest.config.ts
ZTERM_REAL_DAEMON=1 ZTERM_REAL_DAEMON_HOST=192.168.0.3 \
  node ../../../packages/cli/node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/integration/real-daemon.test.ts
```

## Rev20 定向返工

本轮只修 David R3/rev20 的五项 channel 生命周期 finding，保留 `129f6d43` 的 terminal-only、generic unsupported、真实 open/ack 与旧代失败栅栏。

- 身份观测（rev20 历史）：真实 `mux-ready` 缺少 `daemonHostId` 时曾回填 accounts 期望值；rev21 已改为 null/unverified。
- 迟到 open ack：本地 open 超时后保留 channel id；远端迟到 `mux-channel-opened` 会收到 `mux-channel-close`，释放远端 channel，不影响后续 open/send。
- 远端 channel close：已接受 channel 收到 `mux-channel-closed`/`mux-error` 后从唯一 registry 删除；原 `ChannelRef` 的 send/close 明确 `link_closed`，兄弟 channel 与 link 保持可用。
- close 发送失败：`ChannelDispatcher.close` 不再吞错或先删记录；返回 typed `link_closed`（保留 cause），channel 仍可恢复/重试。
- 异步 open 与 generation：`openChannel` 完成后复核 generation、link 状态和 transport identity；旧代 channel 即使 close 发送失败也会从 registry 移除，不留下僵尸 channel。
- 物理 transport close 与客户端主动 close 都会清理该 transport 的全部 channel；旧代 close callback 不能删除新代 channel。

### Rev20 验证

- `pnpm run type-check`：exit 0。
- `pnpm test`：35 passed，3 skipped；contract 22 passed，real-entry 13 passed，real-daemon 默认 skipped。
- 收口提交仅移除测试运行留下的 `node_modules/.vite` 缓存；`129f6d43..最终 head` 净 diff 不含 node_modules。
- real-entry 覆盖真实本地 WebSocket/mux wire：身份缺失回填且未验证、匹配身份已验证、迟到 ack close、远端 close 隔离、真实 open/ack 与 payload 投递。
- real-daemon 本轮因未设置 `ZTERM_REAL_DAEMON=1` 未重跑；先前 `rework/real-daemon-vitest.log` 的真实 daemon 3 passed 证据保留。


## Rev21 定向返工

本轮只修 David `120a5c8c` 两条原 finding，保留已复核的 terminal-only、真实 open/ack、远端 close、发送 guard、普通 close 错误与 generation 修正。

1. mux-ready 缺 `daemonHostId`：`peerIdentity` 必须 `null`/unverified，不再把 `auth.daemonHostId` 写进观测身份。声明正确身份才 verified；声明错误身份仍 `peer_identity_mismatch`。
2. late-open ack close send 失败：不再先删 `pendingRelease`，不再 catch 吞错，不再假定 socket gone。保留 pending release，发出 `ConnectionError("channel_close_failed", { channelId, cause })`；`ConnectionManager` 暴露按 link 的 `onChannelCloseFailure` 与 `retryLateOpenClose`，重试成功才删除，物理 close 才清理。共享 link/tmux 不受影响。

### Rev21 验证

- `pnpm run type-check`：exit 0（`rework/rev21-tsc.log`）。
- `pnpm test`：36 passed，3 skipped（contract 22 + real-entry 14；real-daemon 默认 skipped）。
- `rework/rev21-red-vitest.log`：红测 3 failed（缺身份两次、late-open consumer 缺失）；`rework/rev21-red-tsc.log` 对应 type errors。
- `rework/rev21-targeted.log`：新增真实 WebSocket/mux late-open close-failure + retry 用例单独 1 passed。
- `real-entry` 覆盖：缺身份 null/unverified、匹配身份 verified、错误身份 mismatch、close send 失败保留 typed channelId/cause、retry 只释放该 channel、兄弟 channel 与 link 继续可用。
- `real-daemon` 本轮仍未设置 `ZTERM_REAL_DAEMON=1`，未重跑；旧 `rework/real-daemon-vitest.log` 仅证明真实握手/open，不作为 rev21 身份语义证据。

## 未达成 / 边界

- 两独立物理机 LAN 贯通仍未验收（`UNVERIFIED`）。本轮真实 daemon 是 workspace 容器经 LAN 地址连接到宿主机真实 daemon，不是两机。
- 跨网络 direct/relay、真实 `/app` 数据投递、真实两机 terminal 数据面不在本轮。
- 未 push / PR / merge / publish / 全局安装 / daemon 重启 / tmux 生命周期操作。

## 唯一 writer owner

本轮 Frank；Review David；Integrate Jenny。
