# terminal-admission-composition-1107 观察与计划（plan-first，实施前待 master 确认）

任务：terminal-admission-composition-1107（P1），owner Emma，reviewer David，worktree `/Volumes/Intel/playground/zterm/worktrees/daemon-terminal-admission-20261107`，基线 `f99a61a8`。当前 `working`，review 未通过。

长期目标：V2 daemon 对经 workspace/member/runtime-binding 准入后的远程机器，开放一个精确原生终端会话；输入不漂移、一 Enter 一 CR、未准入不转发。

先决约束：不 merge/push/publish/PR；不动 8899/3333/8801、tmux 16906、15T；不做共享服务/tmux server 生命周期；不在正常启动嵌入测试种子或自动诊断；缺必需生产依赖时返回 typed unavailable，不回退 token-only、不静默 legacy。

## 第一部分：观察（已在 worktree 读取源码与证据）

### 已落地（复用，不重复返工）

1. `v2/modules/members/src/application/members-service.mjs`：`bindSession({token, memberId, sessionId, anchor, expectedGeneration, terminalTarget})` 持久化可选可空 `terminalTarget {backend, stableId}`；`getRuntimeBinding(memberId)` 投影 `{machineId, bindingGeneration, sessionId, anchor, terminalTarget}`；导出 `resolveBindingTarget({binding, catalog})`（已验证精确比较、A 选 B 零副作用、无匹配/模糊目录返回 null，不读写、不推断）。
2. `v2/modules/daemon/src/terminal-admission.mjs`：`createTerminalAdmission({auth, members, routing, terminal, machineTerminal, resolveBindingTarget, log})`，暴露 `admit`/`forwardInput`/`requireCurrent`。完成 auth verify、routing.resolve、getRuntimeBinding、machine/generation 比对、bindingResolver 精确匹配、目录 exact entry 校验、`forwardInput` 非空 raw string 校验、一 Enter 即 `input(session.stableId, data)` 不再附加 CR、revoke/rebind 后 linkGeneration/daemonHostId 重检。
3. 语义：raw input 逐字节不变；`TerminalPort.input` 空字符串返回 400 `INPUT_INVALID`（由调用方保证非空，不在 admission 重复该策略）。

### 当前缺口（按风险到达点排序）

缺口 1（daemon 组装，阻断生产）：`startDaemon()` / `main.mjs` CLI 直接调用 `createDaemon({...})`，不传 `admission`，不组装 accounts + connections + members。`server.mjs` `/api/terminal/stream`、`/api/terminal/input` 在 `!context.admission` 时降级为静态 `authenticate()` token-only 路径。这是未接受的“缺省 legacy 静默放行”，必须拆掉。

缺口 2（daemon scope，缺公共边消费者）：`machineTerminal.forMachine({machineId, memberId, bindingGeneration})` 仅存在于测试双 `createMachineTerminal`（常量 status/freshness/peerIdentityVerified/daemonHostId/linkGeneration）。产品端没有从 connections 可验证链派出的机器作用域终端消费者，即缺 `{listSessions, input, subscribe}` 与 `daemonHostId/linkGeneration` 的真实来源。

缺口 3（connections owner，公共接口缺）：connections 第一增量只有 `connect` + `openChannel('terminal', target)` + `sendChannel`/`onChannelMessage`/`closeChannel`，没有 `list-sessions` 目录读，无法由 V1 mux 链返回当前机器的 session catalog。真实 V1 daemon 通过 `mux-channel-open`（带 sessionName/expectedSessionIdentity/backend）开通道，但 catalog 的 `list-sessions` 控制请求未被 connections 公开端口承载。

缺口 4（已裁决，保持 fail-closed）：真实 V1 daemon 现有 `mux-ready` 省略 `daemonHostId`。裁决明确：不新增“缺失即回退为 accounts 已验证身份”的路径；缺失或错误 canonical peer identity 一律 fail-closed 为 `peer_identity_mismatch`。正确修复由 `mux-ready-daemon-host-id-20261107`（独立 worktree，已加 `daemonHostId`）提供 `mux-ready.daemonHostId`，composition 侧消费该回执，不改此边界。connections 现有 `connection-manager.ts` 已加 `peerIdentityMatches` 严格校验（非空 + verified + 等于 `auth.daemonHostId`），与裁决一致，复用不重写。

缺口 5（connections owner，语言边界）：`v2/modules/connections/src/**` 内部相对 import 无 `.ts` 扩展名（`../public/errors`、`../ports/transport`、`../channels/dispatch`、`../domain/link-state` 等），`node --experimental-strip-types` 无法解析（实测 `ERR_MODULE_NOT_FOUND`）。accounts src 已用显式 `.ts` 且可运行（实测 11 exports OK）。`connections/tsconfig.json` `moduleResolution: Bundler` 且未开 `allowImportingTsExtensions`。修复归属 connections owner：内部相对 import 加 `.ts` 并调 tsconfig，或提供 `.mjs` 公共运行时入口。daemon 不复制、不 shim、不绕过 connections 源码。

缺口 6（members/host 绑定生产者）：`bindSession` 可写入 `terminalTarget`，但产品 launch/restore/bind 边界提供精确原生目标的生产者尚未接入；当前仍是 harness `bindTarget`。需明确谁（members/host adapter）在 bind 时写入 exact `{backend, stableId}`，并在 launch/restore 时读回。

缺口 7（evidence 层级，re-delivery 前纠正）：现有 `result.md` 未区分真实 members/module HTTP 测试、dev-auth/link 双与真实 V1 daemon 回执。重新交付前按 David 要求纠正证据层级。

已闭合不再返工：`resolveBindingTarget` 精确比较、A 选 B 零副作用、raw 输入证据、daemon 20 pass / members 22 pass / terminal-slice 3 pass。

## 第二部分：接受的公开接口签名（已读候选 worktree，基线 f99a61a8）

### accounts（`worktrees/accounts-workspace-auth-adapters-20261106`）

```ts
createWorkspaceAuthorization({authService, store, now?}) -> WorkspaceAuthorization
  .verify(token) -> WorkspaceAuthorizationContext {accountId, scopes, workspaces, members}
  .bindCreatedWorkspace({token, workspaceId})
createAccountsAuthorizationPort({token, authService, machineService, routes}) -> AccountsAuthorizationPort
  .authorizeMachine(machineId) -> AuthorizedMachineLink
```

`AuthorizedMachineLink {machineId, daemonHostId, accountId, authorizationId, capabilities, target, settings}`。路径来自注入 `MachineRouteSource.get(machineId)`；要求 `route.daemonHostId === target.daemonHostId`，否则 `MACHINE_IDENTITY_UNVERIFIED`。

公共入口 `src/public/contracts.ts`；store `createFileAccountAuthorizationStore`。

### connections（`worktrees/connections-cross-device-foundation-20261106`）

```ts
createConnectionManager({authorizationPort, transport, now?}) -> ConnectionManager
  .connect(machineId, verifiedAuthorization?) -> LinkRef {id, machineId, generation}
```

peer identity 必须非空、已验证且等于 `auth.daemonHostId`，否则 `peer_identity_mismatch` 并关闭传输。

```ts
  .openChannel(link, 'terminal', {sessionName, backend, expectedSessionIdentity, existingOnly, bodySubscribed}) -> ChannelRef  // 仅在真实 mux-channel-opened 后
  .onChannelMessage / .sendChannel / .closeChannel / .observeLink / .closeOwnLink / .retryLateOpenClose / .onChannelCloseFailure
```

当前缺：仅 terminal 一种 channel kind；无 `list-sessions` 经本端口；无 `forMachine`-style 机器作用域消费者；`mux-ready.daemonHostId` 被真实 V1 省略，当前硬拒。

### members（daemon worktree）

```ts
bindSession({token, memberId, sessionId, anchor, expectedGeneration, terminalTarget}) -> binding
getRuntimeBinding(memberId) -> {machineId, bindingGeneration, sessionId, anchor, terminalTarget}
resolveBindingTarget({binding, catalog}) -> {backend, stableId} | null
```

### daemon 目标签名（实现侧）

```js
createTerminalAdmission({auth, members, routing, terminal, machineTerminal, resolveBindingTarget, log})
  .admit({callerToken, workspaceId, memberId, machineId, groupPath, expectedGeneration, target, operationId})
  .forwardInput({target, data, operationId})
  .requireCurrent(admitted, operationId)
```

`machineTerminal.forMachine({machineId, memberId, bindingGeneration}) -> {machineId, status:'connected', freshness:'fresh', peerIdentityVerified:true, daemonHostId, linkGeneration, listSessions, input, subscribe}`。

`main.mjs`/`startDaemon` 装配点：在 `createDaemon({...admission...})` 处装配由 accounts `createAccountsAuthorizationPort` + `createWorkspaceAuthorization.verify`、connections `createConnectionManager`、members `bindSession`/`getRuntimeBinding`/`resolveBindingTarget` 组装出的 `machineTerminal` 与 `admission`。缺必需生产依赖时返回 typed unavailable，不降级。

## 第三部分：语言边界修复清单（归属 connections owner；daemon 不碰）

1. 为 `v2/modules/connections/src/**` 所有内部相对 import 加 `.ts` 扩展名（`../public/errors`、`../ports/transport`、`../channels/dispatch`、`../domain/link-state` 等）。
2. `connections/tsconfig.json` 追加 `allowImportingTsExtensions: true`（与 `moduleResolution: Bundler` 并存，使类型检查与 strip-types 运行一致）。
3. 或折中：提供 `.mjs` 公共运行时入口（与现有 `src/index.ts` 并存、不替代），由 daemon 仅 import 公共入口。
4. daemon 侧禁：不复制 connections 源码、不写本地 shim、不改连接源码以外的文件。

## 第四部分：缺失公共边与归属（精确）

| 缺失边 | 需要方 | 归属 | 说明 |
|---|---|---|---|
| machine-scoped `forMachine` 产品消费者（listSessions/input/subscribe + daemonHostId/linkGeneration） | daemon | daemon owner | 基于 connections 公共端口 connect/openChannel/sendChannel/onChannelMessage 组装；daemon 不拷贝连接代码 |
| connections `list-sessions` catalog 读（经机器链返回当前机器 session catalog） | daemon | connections owner | 真实 V1 支持 list-sessions 目标控制请求，connections 未承载 |
| mux-ready 必须携带并验证 daemonHostId（缺失即 fail-closed） | daemon 受影响 | mux-ready-daemon-host-id-20261107 owner + connections owner | 不降级、不回退；由 mux-ready worktree 提供字段，connections 严格比对 |
| connections 内部 import `.ts` 扩展名 + tsconfig | daemon 无法运行 connections | connections owner | 现为 ERR_MODULE_NOT_FOUND |
| launch/restore/bind 边界的 terminalTarget 生产者 | daemon | members/host adapter owner | 由 bindSession 写入 exact {backend, stableId}，launch/restore 读回 |

## 第五部分：红/绿用例

绿 G1：已验证 caller + 精确目标在 catalog 中 → `admit` 返回 `{session, target, daemonHostId, linkGeneration}`；`forwardInput` 逐字节透传，一个 Enter 一个 CR，拒绝前零订阅/输入副作用。
绿 G2：`requireCurrent` 在 rebind/revoke 后（bindingGeneration 或 linkGeneration/daemonHostId 变更）拒绝，返回 `BINDING_GENERATION_STALE` / `peer_identity_mismatch`。
绿 G3：raw 输入非空字节序列不被裁剪；空字符串返回 400 `INPUT_INVALID`（TerminalPort 已实现，admission 不复制）。
红 R1：错误机器身份（daemonHostId 不匹配）→ 零 channel open、零 input，传输关闭，`peer_identity_mismatch`。
红 R2：未知成员/机器 → `MEMBER_NOT_FOUND`；成员绑定与运行时不一致 → `MEMBER_BINDING_INVALID`；过期 generation → `BINDING_GENERATION_STALE`。
红 R3：请求目标与成员绑定目标不一致，或目标不在当前 catalog → `TERMINAL_TARGET_IDENTITY_MISMATCH` / `TERMINAL_TARGET_BINDING_UNAVAILABLE`，零订阅。
红 R4：缺必需生产依赖（无 machine terminal 消费者、无连接端口）→ typed unavailable，不降级 token-only，不静默 legacy。

## 第六部分：验证步骤（仅 isolated real V1；fixture 仅模块测试）

1. 启动隔离真实 V1 daemon：`ZTERM_CANDIDATE_ROOT=<worktree> node .worker-runs/isolated-v1-stream-fixture-1105/run.mjs start`（disposable tmux socket `/tmp/isolated-v1-<runId>/tmux.sock`，sessions `fixture-alpha-<runId>`/`fixture-beta-<runId>`，stableId `tmux:v1:{...}`）。
2. 真实链路：login → accounts 机器授权（verify daemonHostId 一致） → V2 daemon handshake → members bind（精确 terminalTarget） → 开目标 stream → 输入 raw 字节校验（逐字节相等，Enter = CR）。
3. 真实拒绝：revoke 与 rebind 后再输入必须被拒（zero open/input）；错误 daemonHostId/错误目标必须被拒（zero open/input）。
4. 运行现有模块测试作为非退行证据：daemon 20 pass / members 22 pass / terminal-slice 3 pass；不新增 fixture-only 生产证据。
5. 证据落盘：区分“真实 members/module HTTP 测试”“dev-auth/link 双”“真实 V1 daemon 回执”三层，纠正 `result.md` 层级后再提交 re-delivery。

## 第七部分：下一步（提交给 Jenny 确认）

1. 将本 plan 路径通过 `collab send` 发给 Jenny（master），请求确认。
2. 仅在 Jenny 确认后进入实现；实现前先补红测（按第五部分）。
3. 实现完成后按 isolated real V1 验收，再报告结果、不自行 merge/push。

预计实现范围：`v2/modules/daemon/src/main.mjs`（装配点）、`v2/modules/daemon/src/server.mjs`（拆掉 admission=null 降级）、新增机器作用域 terminal 消费者（由 daemon 组装 connections 公共端口）。connections 侧由其 owner 按第三、四部分自行提交，daemon 不替其修改。

报告人：Emma（peer/worker），向 Jenny（master）汇报。CEO Alice。
