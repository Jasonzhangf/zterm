# zterm-v2-routing-impl-1103 evidence

Routing V2 increment candidate. The public entry is the only exercised surface;
store implementation stays internal to organization and members. No secrets are
recorded.

## R2 准入返工（本证据基线）

本次窄返工只改 routing 模块的准入退回项，未改 members/organization/其他模块。

- 空成员 grant 不得当作无限制：`context.members` 只接受 `string[]`；缺省表示不做成员级收窄，数组（含空数组）必须显式匹配目标 `memberId`，空数组拒绝，`members === '*'` 是未约定扩权，必须拒绝。
- routing 改用 `members.getRuntimeBinding(memberId)` 运行绑定 reader，不再使用 `members.getBinding`；`machineId` 取自运行绑定，不再取 organization 成员记录的旧 `machineId` 字段。
- `getRuntimeBinding` 的 typed 失败（`MEMBER_RUNTIME_NOT_CONFIGURED`、`MEMBER_BINDING_NOT_FOUND`、`MEMBER_BINDING_INVALID`）显式暴露：定向选择直接传播，机器+组扫描写入 `bindingFailures`，不静默当成匹配。
- 构造函数改为要求 `members.getRuntimeBinding`（拒绝旧 `getBinding` 端口）。
- 无选择器机器+组扫描先按 AuthContext 成员允许表收窄候选，再读取任何运行绑定：`members: []` 拒绝，窄允许表只读授权成员，未授权成员不进入 `memberIds` / `bindingFailures`，错误不泄漏未授权 ID；缺省允许表保持原来的全组成员扫描。
- 返回契约恢复 DESIGN 声明的 `groupId/groupPath/organizationRevision`；`hostKind/agentKind/launchProfileRef` 只取 members 运行绑定 reader 的契约值，不再读 organization 已迁出的旧运行字段。

## Public entries

- `v2/modules/routing/src/public/index.mjs` -> `createRoutingService`、
  `createRoutingDevAuth`，以及 `ROUTE_FORBIDDEN`、`ROUTE_RESOLVE_ACTION`、
  `MEMBER_RUNTIME_NOT_CONFIGURED`、`MEMBER_BINDING_NOT_FOUND`、`MEMBER_BINDING_INVALID`。

`createRoutingService({ organization, members, auth })` requires
`organization.readWorkspace`, `members.getRuntimeBinding`, and `auth.verify`.
详情见同目录 `public-interface-mapping.md`。

## 地址与授权契约

- `address.machineId`、`address.groupPath` 必填；`memberId`/`memberName` 可选且互不代填；`expectedGeneration` 可选非负整数。
- 有选择器定向选择：0 命中 `ROUTE_NOT_FOUND`，>1 命中 `ROUTE_AMBIGUOUS`，1 命中即读运行绑定并按 `runtime.machineId === address.machineId` 匹配。
- 无选择器机器+组扫描：先按 `context.members` 收窄授权候选；只把成功返回且 `machineId` 匹配的绑定视为候选；0 匹配 `ROUTE_NOT_FOUND`（含授权候选的 `bindingFailures`），多匹配 `ROUTE_AMBIGUOUS`。未授权成员不读取绑定、不出现在错误明细。
- 成功返回 `memberId/machineId/groupId/groupPath/organizationRevision/bindingGeneration/sessionId/anchor`，以及来自运行绑定的 `hostKind/agentKind/launchProfileRef`。
- `auth.verify` 返回 AuthContext `{ accountId, scopes, workspaces, members? }`；授权在任何读取前完成，无副作用。

## 运行

```sh
node --test v2/modules/routing/tests/*.test.mjs
```

## 证据文件

- `red-test-output.txt`：R2 红测输出（新测试对旧实现失败）。
- `final-test-output.txt`：本轮修正后 19 用例全绿（含多授权目标歧义保留）。
- `type-check-output.txt`：routing 源码、测试与 receipt 的 `node --check` 输出。
- `public-interface-mapping.md`：公开接口映射。

## 组合依赖（未在本分支完成）

真实 members `getRuntimeBinding` reader 仍在 members 最终修正版（当前 head
`12708063`，R2 窄修中）合入后，由 Jenny 统一跑组合 E2E。本分支单测使用最小
`getRuntimeBinding` 端口夹具（内存 Map，返回真实形状或抛共享 `TypedError`），
不复制 members 写存储、不 import `getBinding`；夹具不作为真实 reader 的通过证据。

## 范围

只写 `v2/modules/routing/**` 与 `v2/evidence/zterm-v2-routing-impl-1103/**`；
未写 `v2/modules/{organization,members,accounts,connections}/**`、V1 主树、
`packages/**`、`android/**`、`mac/**`、`win/**`；未 push/publish/merge。
