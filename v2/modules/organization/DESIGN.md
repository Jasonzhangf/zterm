# organization 模块设计与执行卡

状态：2026-11-03 V2 organization rework 实现候选。源码、公开 self-check 和
聚焦测试已在本任务分支通过；未做最终 review、集成或远端交付。

## 闭合 SESE 图

读路径与写路径分开；两条路径都只汇入一个 public result 边界。

```text
读路径：
R0 public read (queryTree / readWorkspace / getMember)
  -> R1 auth.verify(token) -> AuthContext
  -> R2 scope + workspace + member allowlist authorization
  -> R3 store.read() 当前真源
  -> R4 组装结果（mount 节点只是引用，不展开 source tree）
  -> RESULT ok(payload)

写路径：
M0 public mutation (create/update/delete/mount/unmount)
  -> M1 auth.verify(token) -> AuthContext
  -> M2 scope + workspace + member allowlist authorization（store 访问之前）
  -> M3 边界输入校验
  -> M4 store.update() 单 authority 串行边界
       -> M4.1 读取当前状态
       -> M4.2 expectedRevision CAS
       -> M4.3 结构 / 冲突 / 环校验
       -> M4.4 修改组织状态
       -> M4.5 原子持久化（临时文件 + rename）
  -> RESULT ok(receipt)

单一 result：
RESULT -> typed 成功 receipt（含最新 revision）
       -> typed 失败（UNAUTHENTICATED / ORGANIZATION_FORBIDDEN / VALIDATION /
          *_NOT_FOUND / 冲突 / MOUNT_CYCLE / ORGANIZATION_REVISION_STALE /
          STORE_PERSIST_FAILED）
```

授权检查在第一次 store access 之前。校验、CAS、冲突或环失败不写入 store，也不返回
成功 receipt；M4.5 的持久化失败转为 typed `STORE_PERSIST_FAILED`，与其它 typed
failure 汇入同一个 public result 失败出口。没有跨模块写路径，没有 fallback 成功
路径，没有第二把锁或第二套写库。

## Owner 与边界

| Concern | Owner |
|---|---|
| Workspace/group/member structural tree | organization |
| Workspace revision and mount references | organization |
| Runtime configuration and session binding | members |
| Address resolution and generation checks | routing |
| Account identity and auth context | accounts |
| Ticket references | tickets |

Organization 只保存结构化成员引用，不保存 `machineId`、`hostKind`、
`agentKind` 或 `launchProfileRef`。Mount 只保存目标 workspace 中的源 workspace
引用，不复制或改写源 workspace、成员或外部引用。`queryTree` 只返回该引用节点，
不展开 source tree；下游展开 source 成员/分组/挂载时，必须用展开时的 AuthContext
对 source workspace 重新授权，再走 source 域读取。引用可达不等于下游读权限。

## 公开接口

公开入口：`src/public/index.mjs`。

读取：

- `queryTree({ token, workspaceId }) -> { workspace, root }`
  - 需要 `org:read` 和 workspace access。
  - group node 包含 `members`、`children` 和 `mounts`。
  - `members` 按 AuthContext 的显式 allowlist 过滤。
  - `mounts` 是引用节点（`mountId`、`sourceWorkspaceId`、`name`），不展开 source。
- `listWorkspaces({ token }) -> [{ workspaceId, name, revision }]`
  - 需要 `org:read`；只返回当前账号 AuthContext 可读的 workspace 稳定引用。
  - daemon 用本入口构建 `/api/workspaces` 导航目录，不自行枚举 store。

修改：

- `createWorkspace({ token, name, rootGroupName? })`
- `createGroup({ token, workspaceId, name, parentGroupId?, expectedRevision })`
- `updateGroup({ token, workspaceId, groupId, name?, parentGroupId?, expectedRevision })`
- `deleteGroup({ token, workspaceId, groupId, expectedRevision })`
- `addMember({ token, workspaceId, groupId, name, expectedRevision })`
- `updateMember({ token, workspaceId, memberId, name?, groupId?, expectedRevision })`
- `deleteMember({ token, workspaceId, memberId, expectedRevision })`
- `mountWorkspace({ token, workspaceId, parentGroupId, sourceWorkspaceId, name?, expectedRevision })`
- `unmountWorkspace({ token, workspaceId, mountId, expectedRevision })`

成功 mutation receipt：

```text
{ ...resourceCopy, revision: workspace.revision }
```

删除 receipt：

```text
{ workspaceId, groupId|memberId|mountId, revision }
```

可信组合读取端口：

- `readWorkspace(workspaceId)`
- `getMember(memberId)`

## 数据结构

```text
workspace = { workspaceId, name, rootGroupId, revision }
group = { groupId, workspaceId, parentGroupId, name, path }
member = { memberId, workspaceId, groupId, name }
mount = { mountId, workspaceId, groupId, sourceWorkspaceId, name }
```

Store 只在单个 organization authority 中持久化上述数据。写入先写临时文件，
再原子 rename；同一 store instance 的 read-modify-write 串行执行。

## AuthContext 与授权矩阵

```text
{
  accountId: string,
  scopes: string[],
  workspaces: string[] | "*",
  members?: string[]
}
```

- `createWorkspace` 需要 `org:write` 且 `workspaces === "*"`。
- 其他 mutation 需要 `org:write` 和目标 workspace access。
- 读取需要 `org:read` 和目标 workspace access。
- `mountWorkspace` 另外需要 `org:read` 和 source workspace access。
- `members` 缺失表示不按成员收窄。
- `members` 存在时是 allowlist；空数组拒绝所有现有成员。
- allowlist 存在时拒绝创建新成员，因为新 member ID 没有预先授权。

## Revision 与结构规则

- 每个 workspace 有一个结构 revision。
- 每个成功 group/member/mount mutation 只增加目标 workspace revision 一次。
- 除 `createWorkspace` 外，每次 mutation 必须提供当前 `expectedRevision`。
- stale 或缺失 revision 返回 `ORGANIZATION_REVISION_STALE`，且不改 store。
- 同父 group 名、同组 member 名、同父 group/mount node 名必须唯一。
- 非 root group 不能移动到 `null`；root group 不能移动或删除。
- group 不能移动到自身或后代；非空 group 不能删除。
- mount source 必须是已存在 workspace；self 和 source-to-target 可达环都拒绝。
- 同父完全相同的 mount source 拒绝为 `MOUNT_CONFLICT`。
- `unmountWorkspace` 只删除 mount reference。

## 错误码

除既有错误码外，organization public typed-error entry 增加：

- `ORGANIZATION_FORBIDDEN`
- `ORGANIZATION_REVISION_STALE`
- `MEMBER_NAME_CONFLICT`
- `GROUP_NOT_EMPTY`
- `ROOT_GROUP_PROTECTED`
- `MOUNT_NOT_FOUND`
- `MOUNT_NAME_CONFLICT`
- `MOUNT_CONFLICT`
- `MOUNT_CYCLE`
- `STORE_PERSIST_FAILED`

## 文件结构

```text
organization/
├── DESIGN.md
├── src/
│   ├── public/index.mjs, typed-error.mjs, dev-auth.mjs, boundary.mjs
│   ├── domain/ids.mjs, group-path.mjs
│   ├── application/organization-service.mjs
│   └── adapters/organization-store.mjs
└── tests/organization.test.mjs
```

## 验收

聚焦测试与 public-entry self-check：

```sh
node --test v2/modules/organization/tests/organization.test.mjs
node v2/evidence/zterm-v2-organization-impl-1103/self-check.mjs
```

并行 A->B / B->A mount 公开用例证明单 authority 上恰好一成功、一 `MOUNT_CYCLE`，
重开图无环；持久化失败以 `STORE_PERSIST_FAILED` typed 形式汇入同一 result。

任务证据：`v2/evidence/zterm-v2-organization-impl-1103/`。

## 依赖与未完成

- Routing 仍读取 organization member 的 `machineId`；routing owner 必须迁移到
  `members.getRuntimeBinding`。本分支不修改 routing。
- Members 拥有动态 runtime configuration；本分支只提供结构化 member reference。
- Accounts relay 和最终集成不在本分支范围。
