# connections-authority-runtime-entry-1107 result

## 目标

补齐 David terminal-binding 裁决第 4 条所需的 connections-owned 授权目录与公开 runtime 入口：
从 member 当前已授权 link 出发，按验证过的 daemonHostId 产出 machine-scoped 授权终端目录，
并让目录与终端操作绑定同一当前授权 link。revoked / 错 daemon / 被 supersede 的 link 用既有
typed connections error 拒绝并保留 cause。

## 公开入口与对外调用链

入口文件：`v2/modules/connections/src/public/index.mjs`（纯 Node 可加载，ESM）。

- 导出 `createConnectionManager`、`ConnectionError`：复用已合入的
  `connections-cross-device-foundation`（`src/public/link-port.ts`、`src/public/errors.ts`），
  不重造 transport。
- 新增 `resolveAuthorizedTerminalDirectory({ connectionManager, machineId, verifiedAuthorization })`。

调用链：

```
composition / daemon
  -> resolveAuthorizedTerminalDirectory({ connectionManager, machineId, verifiedAuthorization })
     -> connectionManager.connect(machineId, verifiedAuthorization)   // peer daemonHostId 验证
        -> transport.open(auth, ...)                                   // 已合入的 traversal transport
     -> connectionManager.listSessions(link)                           // machine-scoped catalog
     => { link, machineId, entries, openChannel, close }
        -> dir.openChannel(kind, target)                               // 同一 link
        -> dir.close()                                                 // 同一 link
```

语义要点：

- `connect` 用 `transport.peerIdentityVerified && transport.peerIdentity === auth.daemonHostId`
  验证 daemonHostId；未验证或错 daemon 抛 `peer_identity_mismatch`。
- `listSessions` 只读取当前 link 的 transport，不打开 terminal channel、不写 members binding。
- 返回目录的 `openChannel` 与 `close` 闭包固定到同一 `LinkRef`，消费者不能选择另一台机器的
  TerminalPort。
- supersede 后的旧 link 走既有 generation fencing，抛 `stale_generation`；关闭后的 link 抛
  `link_closed`；授权端口 typed 拒绝原样上抛并保留 `cause`。
- 不新增第二 machine 状态 store；`LinkRef.generation` 只存在于 connections runtime 的 `link`
  返回值，不写入 members。

## changed paths

- `v2/modules/connections/src/public/index.mjs`（新增）
- `v2/modules/connections/tests/contract/public-runtime.contract.test.mjs`（新增）
- `v2/evidence/connections-authority-runtime-entry-1107/`（本证据目录）

未修改 `members/`、`daemon/`、`host-adapters/`，未动共享端口/tmux/15T/8899，
未 push/merge/publish，未重启 daemon。

## focused 命令与 exit code

工作目录：`v2/modules/connections`

1. 红（实现前，stub 未实现）：

```
node --test tests/contract/public-runtime.contract.test.mjs
EXIT=1   # tests 6, pass 0, fail 6
```

2. 绿（实现后）：

```
node --test tests/contract/public-runtime.contract.test.mjs
EXIT=0   # tests 6, pass 6, fail 0
```

3. 语法检查：

```
node --check src/public/index.mjs                  EXIT=0
node --check tests/contract/public-runtime.contract.test.mjs   EXIT=0
```

收据：`red-node-test.log`、`green-node-test.log`、`node-check.log`。

## 契约测试覆盖

1. 返回当前授权 link 的 machine-scoped 目录，目录读取不打开 terminal channel；随后
   `dir.openChannel` 走同一 link。
2. 错 daemon：`peer_identity_mismatch`。
3. 授权写给另一台机器：`machine_mismatch`（同 target 文本、不同机器不能通过）。
4. 被 supersede 的旧 link：`stale_generation`。
5. revoked（已关闭）link：`link_closed`。
6. typed 授权拒绝保留 `cause`。

## 复用与消融

- 复用既有 `ConnectionManager`（generation fencing、link store、catalog、channel open）与
  traversal transport；未新增 transport 或 machine store。
- 仅新增一层最小纯 JS 组合边，把目录与终端操作固定到同一 `LinkRef`。

## 未覆盖 / 说明

- TS 文件未改动，模块原有 `vitest` 契约测试与 `tsc` 类型检查不受影响，本轮按交付条件只跑
  聚焦 `node --test` 与 `node --check`。
- 真实跨机 daemon 组合与成员绑定写路径由父任务 `daemon-terminal-admission-1107` 负责，
  不在本任务范围。
