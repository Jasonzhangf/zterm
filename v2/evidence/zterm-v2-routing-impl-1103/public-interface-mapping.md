# Routing R2 返工 — 公开接口映射

公开入口：`v2/modules/routing/src/public/index.mjs`

## `createRoutingService({ organization, members, auth }) -> resolve({ token, workspaceId, address })`

### 必选依赖
- `organization.readWorkspace(workspaceId)`：取同一 workspace 的 groups 与 members 快照（只读，不取绑定）。
- `members.getRuntimeBinding(memberId)`：运行绑定 reader，**必须**实现；构造函数检查拒绝旧 `getBinding`。
  返回形状 `{ memberId, machineId, hostKind, agentKind, launchProfileRef, generation, sessionId, anchor }`；
  抛出 `MEMBER_RUNTIME_NOT_CONFIGURED` / `MEMBER_BINDING_NOT_FOUND` / `MEMBER_BINDING_INVALID` 的 TypedError。
- `auth.verify(token)`：返回 AuthContext `{ accountId, scopes: string[], workspaces: string[]|'*', members?: string[] }`。

### 授权（任何读取前，无副作用）
- 缺/未知 token -> `UNAUTHENTICATED`。
- 缺 `routing:resolve` scope 或跨账号 workspace -> `ROUTE_FORBIDDEN`。
- `context.members` 只接受 `string[]`：缺省即不做成员级收窄；`string[]`（含空数组）必须包含目标 `memberId`，空数组拒绝；`'*'` 或非数组非 undefined 被当作畸形/未约定扩权拒绝。
- 定向选择在读取运行绑定前校验目标 `memberId`；无选择器扫描先按同一允许表收窄候选，再读取运行绑定。未授权成员不读取绑定，也不出现在 `memberIds` / `bindingFailures`，错误不泄漏未授权 ID。

### address 契约
- 必填 `machineId`、`groupPath`；`memberId` 只匹配稳定 ID，`memberName` 只匹配可读名，两者可选且互不代填；`expectedGeneration` 可选非负整数。
- 有选择器：定向选择，命中 0 个 -> `ROUTE_NOT_FOUND`，命中 >1 个 -> `ROUTE_AMBIGUOUS`，命中 1 个即读该成员的运行绑定并按 `runtime.machineId === address.machineId` 匹配，不匹配 -> `ROUTE_NOT_FOUND`。
- 无选择器：机器+组扫描，先按 `context.members` 收窄授权候选，再为每个授权候选读运行绑定；只把 `getRuntimeBinding` 成功且 `machineId` 匹配的作为候选；0 匹配 -> `ROUTE_NOT_FOUND` 并明细 `bindingFailures`；>1 匹配 -> `ROUTE_AMBIGUOUS`（附 `bindingFailures`）；失败的成员不当成匹配，不静默吞掉。未授权成员不读取绑定，也不进入错误明细。

### 返回（成功后，不返回 null generation）
- `{ memberId, machineId: binding.machineId, groupId: group.groupId, groupPath: group.path, organizationRevision: workspace.revision, hostKind: binding.hostKind, agentKind: binding.agentKind, launchProfileRef: binding.launchProfileRef, bindingGeneration: binding.generation, sessionId: binding.sessionId, anchor: binding.anchor }`。
- `machineId/hostKind/agentKind/launchProfileRef` 来自 members 运行绑定 reader；organization 成员记录只用于定位 group/name/memberId，不提供运行配置。
- `expectedGeneration` 不等于当前 binding `generation` -> `BINDING_GENERATION_STALE`（带 `currentGeneration`）。

### 导出错误代码
- `MEMBER_RUNTIME_NOT_CONFIGURED`、`MEMBER_BINDING_NOT_FOUND`、`MEMBER_BINDING_INVALID`：由 `members.getRuntimeBinding` 抛出，定向选择直接传播，扫描写入 `bindingFailures`，不伪装成成功或空目标。
- `ROUTE_FORBIDDEN`、`ROUTE_NOT_FOUND`、`ROUTE_AMBIGUOUS`、`BINDING_GENERATION_STALE`、`UNAUTHENTICATED`（沿用）。

## 依赖边界（未动）
- 未改 `v2/modules/members/**`、`v2/modules/organization/**`、`v2/modules/organization/**`、V1 主树、`packages/**`、`android/**`、`mac/**`、`win/**`。
- 真实 members `getRuntimeBinding` 及组合验证归 Jenny 的 members 最终修正版合入后统一跑；本模块单测用内存 Map 端口夹具，夹具不冒充真实 reader。

## 必跑 gate
- `node --test v2/modules/routing/tests/*.test.mjs`（19 用例，全绿）。
