# tickets 模块详细设计与 Vikunja adapter 合同

状态：R2/R3详细设计合同；adapter候选127b81ff已获模块范围限定接受，待本地组合及产品真实入口验收

目标：在 `v2/modules/tickets/` 内提供唯一的 ticket 业务端口，并把 Zterm 的 workspace、goal、member 映射接到 Vikunja v2.7.1 `/api/v2`。Vikunja task 和 comment 是 ticket 内容与状态的权威来源；Zterm 只保存 typed binding、权限映射和写入操作记录，不保存第二套 ticket 完成状态。

依据：

- 已验收 API 证据：`/Volumes/Intel/playground/zterm/.worker-runs/vikunja-adapter-verify-1103/report.md`
- 审计结论：`zterm-v2-vikunja-verification-audit.md`（交接包）
- 模块结构卡：[MODULE-CARD.md](MODULE-CARD.md)
- 跨模块接口：[MVP 接口合同](../../docs/interfaces/mvp-contracts.md)
- 正式根与模块边界：[正式根决策](../../docs/decisions/product-root.md)、[模块边界](../../docs/module-boundaries.md)

迁入说明：本文件是 David R3 复核 PASS 的唯一详细稿；原模块结构卡保留为 [MODULE-CARD.md](MODULE-CARD.md)，仅作索引，不建立平行设计真源。§8.1/§8.3 已含 R3 要求的文字一致性校正。

## 1. 范围与非目标

本设计确定以下内容：

1. `create/get/list/appendReport/close/reopen` 的公开语义。
2. Vikunja v2.7.1 `/api/v2` 的实际路径、请求字段和成功结果映射。
3. workspace、goal、member 与 provider project、bot、comment author 的归属边界。
4. 每目标前五项查询的权限、排序、分页和投影接口。
5. 非幂等创建、评论追加在超时或响应丢失后的 unknown 状态与人工对账边界。
6. adapter 已获模块范围限定接受的实现事实、证据边界及待本地组合项。

本设计不新增 adapter 行为。它不修改 V1 主树，不部署生产 Vikunja，不把 Collab board 作为写入后备，也不承诺原生 exactly-once。adapter 候选 127b81ff 的实现只获模块范围限定接受，待本地组合及产品真实入口验收。

### 1.1 实现与证据状态

- 公开端口与真实源码入口：`create/get/list/appendReport/close/reopen/confirmRemoteResult` 由 `v2/modules/tickets/src/public/contracts.ts` 导出。`TicketProviderPort` / `TicketQueryPort` 是设计目录中的逻辑职责划分，对应上文导出的服务方法与 `listPendingWrites/listForGoalTopFive`；当前没有两个独立同名文件。
- 持久化与本地事务：`SqliteBindingStore` 持久保存 binding、operation、workspace provider 映射、member 映射和 intent 版本；成功写操作把 binding 与 operation 在同一 SQLite 事务提交。实际适配器入口见 `src/adapters/sqlite-binding-store.ts`。
- OperationRef 隔离：以 `(workspaceId, actorAccountId, operationId)` 作为唯一范围；同一范围同请求重放不再次 POST，不同请求返回 `OPERATION_CONFLICT`。
- 固定 provider 身份：读取和写入按 binding/operation 上固定的 `providerInstanceId` 解析实例，不跟随 workspace mapping 漂移；原实例不可用返回 `PROVIDER_UNAVAILABLE`。
- 恢复与人工核实：过期 pending 在原 store 事务转 unknown，合法 lease 保持；重放和 `confirmRemoteResult` 消费同一恢复入口，确认后不再 POST。人工成功要求 `attribution=operation-produced` 与可核查 `evidenceRef`，并登记 `successSource=manual`，不冒充 provider 回执。
- top-five 与 typed error：`listForGoalTopFive` 按授权后的本地 bindings 逐个读取 provider，稳定排序 `priority desc, externalTaskId asc, bindingId asc`，第六项生成 `nextCursor`；`TicketError` 保留原始 cause，不另建错误中心。

## 2. 唯一 owner 与模块边界

以下目录是逻辑职责划分；当前实现以 `src/public/contracts.ts` 作为真实公开入口，不把目录中尚未存在的拆分文件当作已实现产物。

```text
v2/modules/tickets/
├── DESIGN.md
├── src/
│   ├── public/
│   │   ├── ticket-provider-port
│   │   └── ticket-query-port
│   ├── domain/
│   │   ├── ticket-binding
│   │   ├── provider-mapping
│   │   └── write-operation
│   ├── application/
│   │   ├── ticket-service
│   │   ├── report-service
│   │   ├── write-executor
│   │   └── pending-operation-query
│   ├── adapters/
│   │   └── vikunja-v2
│   └── ports/
│       ├── binding-store
│       └── credential-provider
└── tests/
    ├── contract/
    └── integration/
```

职责：

| 对象 | 唯一 owner | 说明 |
| --- | --- | --- |
| ticket 内容、priority、done、comment | Vikunja | Zterm 不复制第二份可写状态机 |
| workspace 到 Vikunja project 的映射 | tickets | typed control，不写进 task description 或标签 |
| ticket 到 goal、owner member 的关联 | tickets binding store | 只保存稳定引用 |
| 写入操作状态 | tickets write-executor + write-operation store | pending、succeeded、failed、unknown、superseded |
| 人类账号与授权 | accounts | tickets 只接收已验证 AuthContext |
| workspace、goal、member 组织关系 | organization、goals | tickets 只校验并引用稳定 ID |
| board 展示和成员状态组合 | board、status | board 不保存第二套 ticket |
| 统一错误记录 | errors | tickets 返回 typed error，errors 不决定重试方式 |

依赖方向只能是：

```text
board/webui/cli
    -> tickets public ports
        -> application
            -> binding store
            -> credential provider
            -> Vikunja adapter
        -> accounts/organization/goals public readers
```

`tickets` 不得 import `board`、`webui`、`daemon` 或 Vikunja 私有实现。`board` 不得直接调用 Vikunja REST。

## 3. 核心数据

### 3.1 ProviderInstance

```text
ProviderInstance
  providerInstanceId: stable Zterm ID
  providerKind: "vikunja-v2"
  baseUrl: server-side base URL
  credentialRef: secret reference, never the token
  status: active | disabled | credential-invalid
  createdAt
```

同一个 Vikunja 服务可以被多个 provider instance 引用，但同一 workspace 的首期设计只允许一个 active provider mapping。

### 3.2 WorkspaceProviderBinding

```text
WorkspaceProviderBinding
  workspaceId: stable Zterm workspace ID
  providerInstanceId
  externalProjectId: Vikunja project id
  authority: workspace authority
  createdAt
  updatedAt
```

约束：

- `workspaceId + active providerInstanceId` 唯一。
- workspace 合并或挂接保留源 project 映射和已有 ticket binding，不重新创建 project。
- `goalId` 不映射成 Vikunja project 或 `parent` 字段。

### 3.3 TicketBinding

```text
TicketBinding
  bindingId: stable Zterm ticket binding ID
  workspaceId
  goalId
  ownerMemberId: stable Zterm member ID
  providerInstanceId
  externalTaskId: Vikunja task id
  category: requirement | bug | report | other
  providerAssigneeId?: verified Vikunja user or bot id
  lastObservedTitle?
  lastObservedPriority?
  lastObservedDone?
  lastObservedAt?
  stateIntentVersion: monotonically increasing per binding
```

`ownerMemberId` 是分派真源。`providerAssigneeId` 只是可选投影；没有明确账号映射时为空。展示层必须区分：

- Zterm owner member：谁负责这项追踪。
- Vikunja assignee：provider 中的人类或 bot 账号。
- comment author：provider 实际评论账号，通常是 adapter bot。

任何权限判断只使用 Zterm `AuthContext`、workspace/goal scope 和 binding，不解析标题、正文或评论作者。

### 3.4 WriteOperation

operation 的完整身份固定为 OperationRef 三元组。receipt、人工核实和结果返回都使用它，不使用裸 `operationId`：

```text
OperationRef
  workspaceId
  actorAccountId   # 目标操作的原始发起账号，不可与当前核实人混同
  operationId      # 调用方提供的稳定 ID，只在上述三元组内唯一
```

`WriteOperation` 持久化该三元组：

```text
WriteOperation
  operationRef: OperationRef
  bindingId?
  kind: create | appendReport | close | reopen
  request: typed requested fields
  state: pending | succeeded | failed | unknown | superseded
  externalTaskId?
  externalCommentId?
  intentVersion?: stateIntentVersion used by close/reopen
  observedAt?
  errorRef?
  resolution: none | auto-verified | manually-verified
  successSource?: provider | manual   # succeeded 的来源；manual 不得冒充 provider 回执
  verifiedBy?
  verifiedAt?
  evidenceRef?
  executionLeaseOwner?
  executionLeaseUntil?
```

`operationId` 的最窄唯一范围固定为 `(workspaceId, actorAccountId, operationId)`。不同账号或不同 workspace 的相同字符串不得互相读回、覆盖或合并 operation。不得用标题、正文片段、文件名、SHA、checksum 或随机查询结果推导 operation 身份。相同唯一范围和不同 typed request 必须返回 `OPERATION_CONFLICT`。定位 operation 必须先按完整 OperationRef 找到唯一记录，再校验当前调用者权限。OperationRef 直接映射已有 WriteOperation 记录，不新增第二套身份注册表。

### 3.5 ProviderWriteReceipt（可选）

正常路径应把 provider 已返回的稳定 ID 与 binding、operation succeeded 在单个本地事务内一次提交；单独 receipt 写入不是必需保障，也不为审计新增 lease/receipt 框架。

```text
ProviderWriteReceipt   # 仅在实现选择先持久化成功身份再正常提交时保留
  operationRef: OperationRef
  kind: create | appendReport
  externalTaskId?
  externalCommentId?
  observedAt
  consumedAt?
```

若保留 receipt，必须携带完整 OperationRef；其唯一恢复价值是在重启后按同一 OperationRef 完成本地提交，避免重复 POST。receipt 与 operation/binding 使用同一模块本地存储和事务入口。它不是 provider 幂等机制，只保存已经从 provider 收到的成功身份。

## 4. 公开端口

### 4.1 TicketProviderPort

```text
create(actor: VerifiedAuthContext, input: CreateTicketInput)
  -> CreateTicketResult

get(actor: VerifiedAuthContext, input: GetTicketInput)
  -> TicketObservation

list(actor: VerifiedAuthContext, input: ListTicketsInput)
  -> TicketListObservation

appendReport(actor: VerifiedAuthContext, input: AppendReportInput)
  -> WriteOperationResult

close(actor: VerifiedAuthContext, input: MutateTicketStateInput)
  -> WriteOperationResult

reopen(actor: VerifiedAuthContext, input: MutateTicketStateInput)
  -> WriteOperationResult

confirmRemoteResult(actor: VerifiedAuthContext, input: ConfirmRemoteResultInput)
  -> WriteOperationResult
```

公共输入语义：

```text
CreateTicketInput
  operationId
  workspaceId
  goalId
  ownerMemberId
  category
  title
  description
  priority: integer

GetTicketInput
  bindingId

ListTicketsInput
  workspaceId
  goalId?
  status: open | closed | all
  ownerMemberId?
  limit
  cursor?

AppendReportInput
  operationId
  bindingId
  actorMemberId
  executingMemberId?
  reportKind: status | result | blocker | note
  body

MutateTicketStateInput
  operationId
  bindingId

ConfirmRemoteResultInput
  operationRef: OperationRef   # 原 operation 完整三元组；当前核实人由 actor 独立表达
  candidateExternalTaskId?
  candidateExternalCommentId?
  providerObservedAt
  evidenceRef                  # 可核查的人工归属证据；缺失时服务拒绝
  attribution: operation-produced   # 显式确认“本次 operation 产生该对象”；MVP 只接受这一种
```

`actor` 必须由 accounts 验证；`ownerMemberId`、`actorMemberId`、`executingMemberId`、`workspaceId`、`goalId` 都必须由各自 owner 校验或来自已验证会话。tickets 不接受调用者自报的权限。`ConfirmRemoteResultInput.operationRef` 指向原 operation 的原始三元组；当前核实人由 `actor` 独立表达。候选 provider ID 与 `evidenceRef` 都只是核实材料，本身不是成功证据。

`confirmRemoteResult` 是本地控制写操作，只允许具备 `ticket.operation.reconcile` 权限的调用者提交显式归属确认。服务处理顺序固定为：

1. 按 `operationRef` 精确定位目标 operation，不按裸 `operationId` 查找。
2. 校验当前 `actor` 的 reconcile 权限；没有权限直接拒绝，不泄露 operation 或 provider 内容。
3. 以当前凭据重新读取候选 provider 对象，确认其属于该 operation 固定的 provider/project；task 必须属于该 operation 的 provider project，comment 必须属于原 binding 的确切 task。
4. 校验候选对象没有已被其他 binding/operation 认领的冲突。
5. 只有调用者明确提交 `attribution=operation-produced` 和可核查 `evidenceRef`，才把 operation 记为 `resolution=manually-verified`、`successSource=manual`，并原子建立 binding 或 comment 关联。

服务不凭同名、同正文、同项目或类型匹配自动认领，证据不足时保持 unknown。人工结果的来源必须在 operation 中可见，不得冒充 provider 原始成功回执。没有可靠因果证据但用户希望采用已有票，属于独立的关联/导入行为，MVP 不提供，也不能伪称原写入已成功。

### 4.2 TicketQueryPort

模块只提供只读投影；`board` 只能消费本端口，不能获得任何写入或人工核实能力：

```text
listPendingWrites(actor, workspaceId)
  -> PendingWriteObservation[]

listForGoalTopFive(actor, workspaceId, goalId)
  -> GoalTicketTopFiveObservation
```

`listPendingWrites` 只返回当前调用者可读的 unknown、pending 或 superseded 写入，不接受 operationId 作为跨账号查询凭据，不含 provider 正文或秘密。默认只列出同一 `actorAccountId` 的 operation；workspace 级人工核实需要显式 `ticket.operation.reconcile` 权限。它不能被实现成“自动重试”入口。

人工核实入口 `confirmRemoteResult` 位于 `TicketProviderPort`，不属于查询端口。

### 4.3 公共结果最小字段

worker 不得自定互不兼容的结果形状。最小公共结果如下：

```text
OperationView
  operationRef: OperationRef
  actorMemberId?
  bindingId?
  kind
  state
  externalTaskId?
  externalCommentId?
  intentVersion?
  observedAt
  resolution: none | auto-verified | manually-verified
  successSource?: provider | manual
  freshness: fresh | stale | unavailable | unknown
  errorRef?
  retryDisposition
  reconciliationAllowed: boolean

WriteOperationResult
  operation: OperationView

CreateTicketResult
  operation: OperationView
  binding?: TicketBindingView
  ticket?: TicketObservation

PendingWriteObservation
  operation: OperationView
  canReconcile: boolean

TicketObservation
  binding: TicketBindingView
  ticket: TicketView
  providerObservedAt
  freshness: fresh | stale | unavailable
  errorRef?

TicketListObservation
  items: TicketObservation[]
  totalKnown?: integer
  observationStartedAt
  observationEndedAt
  freshness: fresh | stale | best-effort | unavailable
  errorRef?
```

结果中的 `binding`、`operation`、`freshness` 与 `errorRef` 分别表达不同事实。调用者不能从缺少 binding 的 succeeded operation 推断成功，也不能把 stale 当成当前 provider 观察。

## 5. Vikunja v2.7.1 映射

所有请求使用 `/api/v2`，服务端使用 provider credential；浏览器不接收 token。当前已验证 task、comment、project 隔离、分页排序、token 撤销与过期，以及 bot 映射。

| Zterm 动作 | Vikunja 请求 | 成功结果 | 失败边界 |
| --- | --- | --- | --- |
| `create` | `POST /projects/{externalProjectId}/tasks`，body `{title, description, priority}` | `201`，读取 `id/title/project_id/priority/done/done_at/index` | `400` 请求错误；`401` 凭据无效；`403` 无 project 权限；超时或无有效响应为 unknown |
| `get` | `GET /tasks/{externalTaskId}` | `200`，读取 task 字段 | `401`、`403`、`404` 明确失败 |
| `appendReport` | `POST /tasks/{externalTaskId}/comments`，body `{comment}` | `201`，读取 `id/comment/created/author` | `401`、`403`、`404` 明确失败；超时或无有效响应为 unknown |
| `close` | `PATCH /tasks/{externalTaskId}`，body `{done:true}` | `200`，`done=true` 且 `done_at` 非零 | 无响应为 unknown；查询后见目标状态才可完成 |
| `reopen` | `PATCH /tasks/{externalTaskId}`，body `{done:false}` | `200`，`done=false` 且 `done_at` 为零值 | 无响应为 unknown；查询后见目标状态才可完成 |
| `list` | `GET /tasks`，至少使用 `filter`、`sort_by=priority`、`order_by=desc`、`per_page`、`page` | `200`，读取 `total/items` | `401`、`403` 失败；provider 不可达时只返回已知 stale 投影 |

列表 endpoint 的边界：

- 已验证 `GET /tasks` 支持 `filter=done = false && title ~ "..."`、`sort_by=priority`、`order_by=desc`、`per_page=5`、`page=1`，且分页 `total` 可用于继续读取。
- 已验证 project 访问隔离是 `403`，但未验证 `project_id` 过滤表达式或 `GET /projects/{id}/tasks` 的列表行为。
- 正式 adapter 必须在隔离实例选定一个 project scope 读取方式，并证明不会返回其他 workspace 的 task。候选为 `GET /tasks?filter=project_id = ...` 或 project-scoped task route；未证明前不得把该 endpoint 写成已验收。
- adapter 不依赖 provider 默认排序作为最终业务顺序。provider 的 `priority desc` 只做候选排序提示，tickets service 仍按本模块稳定排序规则归一化。

当前实现不调用未验收的 provider 项目级列表端点/过滤器；它按授权后的本地 bindings 逐个读取 provider，再在 tickets 内稳定排序。`GET /tasks` 的 project 过滤不属于当前实现，也不得由本次合流新做 endpoint 实现。

## 6. Scope、goal、member 与权限

### 6.1 workspace 映射

每 workspace 首期映射一个 Vikunja project：

```text
workspaceId -> providerInstanceId + externalProjectId
```

映射由 tickets 的 binding store 持有，属于 typed control。不得：

- 从 project 标题猜 workspace。
- 从 task 描述、标签、assignee 或 comment 作者猜权限。
- 把 goal 层级写成 provider project 树。
- 把一个全局管理员 token 交给浏览器。

Vikunja project 权限用于 provider 边界；Zterm workspace 权限用于产品边界。两处都要通过，任一失败都返回对应错误，不互相替代。读取 provider 的 `401`/`403` 不得通过 warm cache 变成 stale 成功；缓存存在不等于授权存在。

### 6.2 goal 映射

`goalId` 只存在于 `TicketBinding`。每个公开动作必须显式声明所需 action 和 scope：

| 公开动作 | 所需 Zterm action/scope | provider 边界 |
| --- | --- | --- |
| `create` | `ticket.create` on workspace + goal | project 成员或 owner，写权限 |
| `get` | `ticket.read` on workspace + goal | project 可见，读权限 |
| `list` | `ticket.read` on workspace + goal | project 可见，读权限 |
| `appendReport` | `ticket.report` on workspace + goal + binding | project 可见，comment 写权限 |
| `close` | `ticket.state.write` on workspace + goal + binding | project 可见，task 更新权限 |
| `reopen` | `ticket.state.write` on workspace + goal + binding | project 可见，task 更新权限 |
| `listPendingWrites` | `ticket.operation.reconcile`（或同账号只读） | 不调用 provider |
| `confirmRemoteResult` | `ticket.operation.reconcile` on workspace + binding | 按 OperationRef 定位后，以当前凭据重新读取候选对象并核验归属证据 |

动作授权判断顺序固定为：

1. `actorAccountId` 有该 workspace 的指定 action。
2. `goalId` 属于该 workspace。
3. binding（如有）属于该 workspace/goal。
4. 报告时 `actorMemberId` 与 `executingMemberId` 必须是已验证成员或显式空值，`actorMemberId` 不能伪报为另一成员；伪报成员拒绝。
5. provider scope 检查在本地授权通过后执行；provider 明确 `403` 不得被缓存或 Zterm 授权替代。

通过全部检查后才写入 provider task，并把 `workspaceId + goalId + ownerMemberId + externalTaskId` 写入 binding。provider 侧没有 goal 真源，因此不允许从 provider task 反推 goal。

已认证账号默认只读。只有 accounts/organization 明确授予的写 action 才能调用 create/appendReport/close/reopen。同一账号重复 operation 查询也必须先验证当前调用者仍有读取 action；权限撤销后旧 operation 读取返回 `TICKET_SCOPE_FORBIDDEN`，不返回缓存的旧成功。

报告归属还需要账号委托关系：`actorMemberId` 必须是当前账号自身成员，或 accounts 给出的 active `delegate:ticket.report` grant 明确允许的代表成员；`executingMemberId` 必须在该 grant 的 workspace/goal 范围内。tickets 不得根据名字、邮箱、Vikunja assignee 或评论作者推断委托；没有 active grant 时返回 `TICKET_REPORT_DELEGATION_FORBIDDEN`。相同规则适用于 create 的 `ownerMemberId` 和 state 操作涉及的成员范围。

### 6.3 member 与 report 归属

`ownerMemberId` 是 Zterm 的机器成员分派真源。若配置了 bot，只建立 provider bot 与 member 的显式映射：

```text
memberId -> providerInstanceId + providerAssigneeId?
```

没有映射时，ticket 仍可创建和追踪，但不能假装 provider assignee 已分派。报告写入时：

- `actorMemberId` 是发起报告的人或 manager。
- `executingMemberId` 是实际执行成员，可为空。
- provider comment author 通常是 adapter bot，不是上述身份的替代。
- 报告归属以 `WriteOperation` 的 typed 字段为准；评论正文只用于人读，不承载权限或控制决策。

## 7. 每目标前五项与稳定排序

board 的公开组合只调用：

```text
tickets.listForGoalTopFive(actor, workspaceId, goalId)
```

`listForGoalTopFive` 返回：

```text
GoalTicketTopFiveObservation
  goalId
  items: TicketObservation[]  # 最多五项
  freshness: fresh | stale | unavailable
  observedAt
  nextCursor?
  errorRef?
```

规则：

1. 先校验 actor 对 workspace、goal 和 ticket binding 的可见范围；无读取权限直接拒绝，不得返回缓存。
2. 只计算当前目标的候选 ticket，不得先取整个 workspace 或整个系统的前五项再过滤。
3. 当前 board 需要的是 open ticket；closed 状态另列或由显式筛选读取。
4. 排序键固定为：

```text
1. normalized priority descending
2. externalTaskId ascending
3. bindingId ascending  # 多 provider 挂接或同 provider 同 ID 冲突时的最终稳定 tie-break
```

`priority` 按 Vikunja task priority 的整数语义归一化；`externalTaskId` 是 provider 返回的稳定 ID。不得以标题、创建时间字符串、数组偶然顺序或同优先级 provider 返回顺序作为唯一稳定性依据。

5. 先按是否属于该 goal 过滤，再截取五项。相同优先级的第 5、6 项也使用上述稳定顺序，不产生“谁先返回谁在前”的不确定结果。
6. provider 若只能返回 project 级列表，adapter 必须先读取授权范围内全部候选，再本地排序。只有 provider 明确证明其 `priority desc` 顺序可靠，才允许提前停止；该前提未证明前不得跳过任何候选。提前停止的合法条件是：
   - 已收集该 goal 的五项；且
   - provider 已返回一个优先级严格低于第五项优先级的项，且该 provider 在本次观察中声明排序可靠；或
   - provider 明确返回 `total` 已读完。

   若 provider 顺序不可靠，必须读完授权候选再排序，不能越过某个低优先级项就认定完毕。

不得把首个 provider page 的五项直接当成目标前五项。

7. provider 不可达（网络、运输、超时）时，可返回已有 `lastObserved*` 的 stale projection，并带 `observedAt` 和错误引用。provider 返回 `401`/`403` 时不得返回 stale 缓存，必须返回对应授权错误。没有已知投影时返回 unavailable，不得返回空数组声称该目标没有 ticket。

8. 页间 provider 变动不承诺快照精确性。观察必须记录 `observationStartedAt` 与 `observationEndedAt`，跨页读取期间的新变更不保证包含，也不保证被遗漏；adapter 不得为了“看起来一致”重试整个分页。若调用者需要精确一致性，应使用单页稳定读取或后续增量。

当前实现不依赖 provider 项目级列表 endpoint/filter；该能力仍未验收，不作为 top-five 的当前来源。

## 8. 写操作、unknown 与对账

### 8.1 状态机

```text
new
  -> pending
      -> succeeded
      -> failed
      -> unknown
      -> superseded
```

`pending`：已受理，尚未确认 provider 结果。

`succeeded`：provider 返回明确成功，且已取得稳定 ID，或 close/reopen 的读取结果明确达到目标状态。

`failed`：provider 明确拒绝，已知不存在本次副作用；`400`、`401`、`403`、`404` 按此边界处理。

`unknown`：网络超时、连接中断、响应无法解析，或可能已执行但没有稳定的 provider 结果。不得把 `5xx`、超时或空响应伪装成 failed。

`superseded`：同一 binding 已出现更新的相反 state intent，本 adapter 不再用旧 operation 发起新写或覆盖新 intent。它只用于 close/reopen 的旧意图，不代表 provider 副作用已被撤销；已发出的旧请求仍可能迟到生效，真实状态以 provider 为准。

### 8.2 create 和 appendReport

这两个动作是非幂等写入：

- 写请求只有一个 executor。发起前以原子 compare-and-set 创建 `WriteOperation` 并取得 execution lease，再调用 adapter。
- 同一 `(workspaceId, actorAccountId, operationId)` 的并发第二请求不得再次 POST；它返回已有的 pending 结果和 `retryDisposition=await-current-attempt`。
- adapter 每次 operation 只发起一次非幂等 POST，不自动重发。
- provider 正常返回 `201` 后，在单个本地事务中提交 TicketBinding（或 comment 关联）、已知 provider ID 和 operation 的 succeeded；评论必须同时保存 `externalCommentId`、typed report 归属字段和 operation 结果。
- comment 认领按 provider scope：`comment_claims` 的唯一键是 `(providerInstanceId, externalCommentId)`；不同 provider 可各自使用相同数字的 comment ID，不得以全局裸 `externalCommentId` 做唯一约束。
- binding/结果与 succeeded 不得分两次提交，也不得出现 succeeded 指向不存在 binding 的状态。
- 该本地事务失败时，operation 保持 pending/unknown，重启后不得再次 POST，进入人工核实。若实现选择先持久化 `ProviderWriteReceipt` 再正常提交，receipt 必须携带完整 OperationRef，并且只在重启恢复该 operation 的本地提交时使用。
- provider 明确拒绝后，进入 failed，保留错误码和 `retryDisposition`。
- 连接超时、请求被取消、响应不可解析或没有稳定成功结果时，进入 unknown。
- unknown 不得自动重发；必须先人工或可靠机制核实远端是否存在本次副作用。
- 单次空查询不是“未提交”的证明。因为 provider 不提供可验证的客户端写入关联，首期只能保留待核实，不能自动认领同名 task 或同正文 comment。

恢复规则（由操作入口按原 store 事务检查，不宣称已部署独立后台扫描器）：

1. 过期 pending 在原 store 事务转 unknown；仍持有有效 lease 的 pending 保持原状态，不抢占活动 executor。
2. 同一 OperationRef 的重放和人工核实消费同一恢复记录；确认后不再 POST provider。
3. 当前实现没有 ProviderWriteReceipt，本次合流也不新增；provider 成功 ID 后、本地事务提交前的窗口只能保持 unknown 并等待人工核实，不能自动补成功。
4. 人工核实只能经 `confirmRemoteResult`，先按 OperationRef 定位并校验当前调用者 reconcile 权限，再以当前凭据 GET 候选对象并核验归属，原子创建 binding 或 comment 关联；无法确认时继续 unknown。成功标记 `successSource=manual`。

### 8.3 close 和 reopen

close/reopen 会改变目标状态，必须按 binding 的 `stateIntentVersion` 排序：

- 每次显式 close/reopen 在发起前原子递增 `stateIntentVersion`，并把该版本写入 operation。
- 同票的恢复动作只能处理仍是最新 `stateIntentVersion` 的 operation。
- 超时后可以 GET task 进行只读核实；只有 observation 明确为目标状态、provider 稳定可用且 operation 仍是最新 intent 时，才可记为 succeeded。
- 查询明确未达到目标状态时，不自动重设，不把旧 operation 重新变成 pending 尝试；保持 unknown，等待显式新 operation。
- 若期间已经出现新的相反 intent，旧 operation 进入 superseded，本 adapter 不再发旧写、不覆盖新 intent；已发出的旧 PATCH 仍可能迟到，真实状态以 provider 实际观察为准。
- provider 外部修改不等于新的 Zterm intent。外部状态与旧 operation 相反时，旧 operation 继续 unknown，不覆盖外部状态；需要新状态时必须由有权限调用者发出新的 close/reopen operation。

最小反例：旧 close 超时进入 unknown → 调用者显式 reopen 并成功 → 旧 close 的恢复检查发现 `stateIntentVersion` 已变化，只将旧 close 标为 superseded，本地不再发旧 PATCH、不覆盖新 intent；provider 真实状态仍以实际观察为准，若旧 PATCH 已在途并迟到到达，可能再次改变 provider 状态；该“不能覆盖新 intent”仅指本地 store CAS，不构成远端 fencing。

本地 `stateIntentVersion` 只约束本 adapter 后续动作：它阻止本地恢复流程把旧 operation 重新写 provider 或覆盖新 intent，但无法阻止已经发出的超时 PATCH 在 provider 迟到生效。旧请求仍可能生效期间，产品结果必须显示为不确定（unknown/待核实），不得声称本地版本实现了远端 fencing。真实联调必须覆盖“旧 PATCH 迟到到达并改变 provider 状态”的场景。

### 8.4 本地幂等与结果读取

本地幂等键是完整 OperationRef，不等于 provider exactly-once：

- 已知 succeeded/failed 结果只能在当前 `actorAccountId` 仍持有对应 action 时返回。
- 相同 operation 正在 pending 时，返回原 pending 结果，其他 executor 不调用 provider。
- 相同 OperationRef 的 unknown 结果继续返回 unknown，不再次调用 provider。
- 相同唯一 scope、不同 typed request 返回 `OPERATION_CONFLICT`。
- 调用者要发起新的写入必须使用新 OperationRef（通常是同 workspace、同账号内的新 `operationId`），并显式承担新的副作用。
- 旧 operation 的读取必须重新验证当前权限；权限撤销、账号停用或调用者变化后，旧结果不再可见。

本地记录只能保证“本 adapter 不重复发出同一 operation”，不能保证远端已经提交一次。产品文案和错误投影必须把这一点说清楚。

## 9. 错误语义

tickets 返回以下 typed error，由 errors 统一关联和展示，但 errors 不替代业务决定：

| code | 来源 | retryDisposition |
| --- | --- | --- |
| `TICKET_SCOPE_FORBIDDEN` | Zterm workspace/goal 权限 | none |
| `TICKET_REPORT_DELEGATION_FORBIDDEN` | report actor/executing member 无 active delegation | none |
| `PROVIDER_UNAUTHORIZED` | Vikunja `401` | credential repair |
| `PROVIDER_FORBIDDEN` | Vikunja `403` | none until scope repaired |
| `PROVIDER_NOT_FOUND` | Vikunja `404` | none |
| `PROVIDER_VALIDATION_FAILED` | Vikunja `400` | none; caller fixes input |
| `PROVIDER_UNAVAILABLE` | 网络、运输、不可用 provider | query or manual recovery |
| `WRITE_OUTCOME_UNKNOWN` | write timeout/no stable result | manual reconciliation only |
| `OPERATION_CONFLICT` | same OperationRef, different request | none; new operation required |
| `OPERATION_SUPERSEDED` | newer opposite intent exists | none; use newer operation result |
| `BINDING_CONFLICT` | duplicate binding or mapping conflict | none until resolved |

错误必须保留完整 `operationRef`（workspaceId + actorAccountId + operationId）、`owningModule=tickets`、provider status（有则保留）、cause 和用户可执行的处理说明。不得记录 token、密码、完整 Authorization header 或其他秘密。

读取 provider 失败时：

- Zterm 授权失效、撤销或无 scope：先返回 `TICKET_SCOPE_FORBIDDEN`，不得返回任何缓存。
- provider 明确 `401`：返回 `PROVIDER_UNAUTHORIZED`，不得返回 stale 缓存。
- provider 明确 `403`：返回 `PROVIDER_FORBIDDEN`，不得返回 stale 缓存。
- 仅网络不可达、超时或传输失败时：有已知 binding/projection 才返回 stale observation。
- 没有已知投影：返回 unavailable，不返回“没有 ticket”。
- 写入 provider 失败时：不得切回 Collab 写票，也不得返回本地成功。

缓存只是最后一次观察的投影，不是授权凭据，也不能覆盖当前鉴权或 provider 拒绝。

## 10. Board 组合合同

board 只消费 `TicketQueryPort`，不直接读 provider：

```text
board.queryManagerBoard(managerId, workspaceScope)
  -> goals
  -> tickets.listForGoalTopFive(actor, workspaceId, goalId) per goal
  -> status observations
```

约束：

- board 不把 ticket done 或 member status 写回 tickets/goals。
- board 不获得 `confirmRemoteResult` 或任何写入入口，只消费 TicketQueryPort 的只读投影。
- 每个 goal 的 top-five 分别查询，不能先聚合所有 goal 的票再截取。
- 某个 goal 的 provider 失联时，只有该 goal 的 ticket 区显示 stale/unavailable；其他 goal 和成员状态继续独立返回。
- board 的响应中每个 ticket 带 binding、goalId、provider freshness 和观察时间，前端不猜测缺失项。
- 空数组必须和 unavailable 分开。空数组表示已在授权范围内成功查询且确实为空。

## 11. 验证计划

本节保留完整必要验收用例，不整节标 PASS。已有证据按以下边界分开：

- 真实 Vikunja 正常流程：隔离实例上的 create/get/appendReport/close/reopen 成功，以及跨 project、授权拒绝和同一 OperationRef 不重复 POST。
- 真实新进程 + SQLite，但 fake createTask 中断的恢复：child 在持久 pending 后、本地事务提交前退出；重启按同一 OperationRef 读取持久 unknown，不调用 provider。该证据证明恢复路径，不证明“真实远端写成功后崩溃”。
- 尚缺组合证据：真实远端写成功后、本地事务提交前进程退出。当前无 ProviderWriteReceipt，也不新增该可选机制；该窗口只能保持 unknown，不能自动补成功。不得把第二类拼成“真实 POST 后 crash 已验”。

### 11.1 设计审计

- 对照本文件与已接受的 Vikunja 审计，确认没有把原生 `Idempotency-Key` 写成可用。
- 对照接口合同，确认 tickets 不拥有 goal、member、workspace 或权限真源。
- 对照 board 合同，确认 top-five 是 goal 先过滤再截取，不是全 project 五项。

### 11.2 后续 adapter 黑盒验收

在隔离 Vikunja v2.7.1 实例执行：

1. create/get/appendReport/close/reopen 成功，读取对应 task/comment/task state。
2. 跨 project 读取和评论返回 `403`；无效或过期 token 返回 `401`。
3. 同一 OperationRef（同 workspace、同账号、同 operationId）在本地重复调用只产生一条 provider task/comment；相同 header `Idempotency-Key` 不产生 provider 保证。
4. 用可控网络故障或超时注入让 create/appendReport 无稳定响应，断言状态为 unknown、没有自动重发、`listPendingWrites` 可查。
5. 对 unknown create/comment 做人工核实路径：核实前不能返回 succeeded；不能凭同名、同正文、同项目/类型或一次空查询自动认领。同一 project 的无关联 task、同一 task 的旧 comment 必须拒绝误认；有完整 OperationRef 定位、reconcile 权限和可核查证据时才可建立 binding，且 operation 显示 `successSource=manual`，不得冒充 provider 回执。
6. 构造两个 workspace、两个 goal、多个 owner member、相同 priority 和六项以上 open ticket，断言每个 goal 的前五项正确，不泄露跨 scope 数据。
7. 使用 provider 分页边界验证同一 priority 的稳定 orderBy 为 `priority desc, externalTaskId asc`，不以数组偶然顺序判定。
8. provider 不可达时返回 stale 或 unavailable，不返回空成功。
9. 只读账号调用 create/appendReport/close/reopen 被拒；伪报执行成员被拒；权限撤销后旧 operation 读取被拒。
10. provider 成功后模拟本地 binding/succeeded 提交失败并退出：当前无 ProviderWriteReceipt，预期保持 unknown，通过人工核实完成绑定；不能出现无 binding 的 succeeded。该“真实远端写成功后进程退出”的组合证据目前尚缺，不得标 PASS。
11. 旧 close 超时进入 unknown 后，新 reopen 成功，旧 close 恢复只标 superseded，不覆盖 reopen。
12. warm cache 存在但 provider 返回 `401`/`403` 或 Zterm 权限失效时，不返回 stale 成功。
13. 两个账号或两个 workspace 使用相同 operationId 时，恢复和人工核实只影响匹配 OperationRef 的记录，不跨账号或跨 workspace 合并。
14. 旧 close/reopen 超时后，模拟旧 PATCH 迟到到达并改变 provider 状态，断言本地保持不确定、不声称远端 fencing，真实状态以 provider 为准。
15. 两个 provider 使用相同数字 comment ID 时，各自认领成功；不得因全局裸 `externalCommentId` 冲突。
16. 持久 pending 的 lease 过期后由原 store 事务转 unknown，有效 lease 不被抢占；重放与人工核实消费同一记录且不再次 POST。

### 11.3 尚未验证、不得冒充已实现

- 真实请求超时后的远端副作用核实。
- project-scoped list 的准确 endpoint 或 filter。
- Zterm workspace/goal/member 映射的实际 adapter 行为。
- provider 返回成功 ID 后、本地提交前的进程退出恢复路径。
- board 与 tickets 的真实组合调用。
- 生产 Vikunja 部署、凭据轮换、HA 或多主写入。

## 12. 交付边界与组合状态

本文件保留 main 的 R2/R3 详细设计合同，不再标记为“本任务只设计”或“再派实现”。adapter 候选 127b81ff 只获模块范围限定接受，其产品行为仍待本地组合及真实入口验收；模块接受不等于 MVP 或产品交付。

模块内已实现：公开端口、SQLite 持久 store 与本地事务、OperationRef 隔离、固定 provider 身份、人工核实入口、top-five 本地稳定排序、typed error。

真实 owner readers 组合待验：accounts/organization/goals 真实 readers、WebUI/board/CLI 真实组合调用、真实超时副作用、生产部署、凭据轮换、HA 或多主写入。不保留“全部已实现”或“全部未验证”的笼统状态。

实现不得以本设计中的候选 endpoint、mapping 或 unknown 方案替代真实黑盒验收。
