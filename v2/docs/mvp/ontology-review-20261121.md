# MVP ontology 审计日志

长期目标：逐条审计 V2 交付 ontology 的业务语义、真实依据与验收缺口。所有结论按稳定身份条款记录。用户逐条批准需要修改的规则。修改只限本任务分支。

## 本轮已确认

1. 所有任务逻辑绑定稳定名字。更换机器、终端或会话后，按原名字接续任务。
2. 任务临近到期时提醒负责的 agent 自行续订。
3. 晚读只更新消费记录。下次周期触发按原排期执行。
4. 周期触发时，负责的 agent 忙碌或离线就跳过本轮。

## 11 月 21 日

本轮目的：作为唯一 architect，恢复前序审计并整理需要用户决定的 R17 条款。

身份与任务：当前 Collab 回执为 Noah/peer，工作角色含 architect。board 上没有标题或职责明确属于 architect 的未关闭任务。已请 master Jenny 调整项目内 architect 职责与派单。当前审计按用户直接指令继续。

前序证据：R17 原文已批准，状态为 `approved / binding_pending`，正式入口恢复仍待验收。R18 至 R22 已有模块或独立复验记录，正式页面与服务验收仍待补齐。前一轮已向用户提交这六条的审计意见。

用户纠正：用户指出业务语义绑定到稳定名字，与底层 transport 无关。Collab 当前规则也明确，名字承载工作归属，agent sessionID 是当前执行载体，transport 只定位通信。据此撤回先前把「能收消息」作为身份接替条件的提案。此前的建议不能作为待审批条文。

本轮改动：[delivery-ontology.md](delivery-ontology.md) 在 R17 下写入稳定名字与 transport 的边界和 Henry 的跨宿主恢复例子。[delivery-ontology.json](delivery-ontology.json) 在 R17 的 peer 对象、接替行为、绑定关系与 gate 用例中落实同一边界，并把用户原话写入批准来源的修订记录。

验证：`git diff --check` 通过。`jq` 确认 R17 只有一个对应条款，修订来源已写入，条款仍是 `binding_pending`。这里是文字和 JSON 结构检查，不是正式产品入口验收。

用户已明确业务归属。R17 的验收应在断线前后按同一个名字查询原工作，再单独检查当前投递位置。

剩余缺口：正式服务检查换 transport 后按名字查询原任务、角色、消息与当前绑定。另需检查旧连接迟到请求不能取得新名字归属。

R18 的角色按组生效。历史组织模块已验证职责隔离和职责不提权。仍需在正式页面撤销 Henry 在 A 组的管理权，由同一个 Henry 再次执行该组管理操作，观察实际拒绝。唯一 architect 的派单调整已交 Jenny 协调。

### R19 与 R20

本轮核对换会话、换负责人和交接响应丢失。R19 的 `v2.work.transfer_assignment` 要求提供新负责人的邀请与接受。用户已明确所有任务逻辑绑定名字。同名接续直接恢复原任务，真正转交时才走邀请流程。

已按该裁决修正 R19 流程输入与验收用例。Bob 换电脑后用原名字打开原任务，检查进度、证据、期限和新增邀请数（应为零）。Bob 邀请 Alice 接手时，分别在邀请后和接受提交后查询负责人，再检查下一条新提醒的收件人。

历史独立复验 `r19-invite-independent-retest/report.md` 记录了桌面和手机视口的 Goal/Ticket 操作。邀请发出后页面丢失响应，查询原操作可找回同一条待接受邀请。错人或已撤权的人接受时被拒，受邀人成功接受后重开服务仍是负责人。R19 的同名字换会话仍缺同入口验收。

R20 的部分证据来自上述邀请查询及 `current-identity-routing/resume-report.md` 的运行绑定查询。后者能区分已提交和已被后续操作取代。任务已转交、提醒尚待处理时只续办余项，仍缺组合验收。当前 board 仍列有多个 architect。

### R21 提醒到期时按谁的权限发送

已批准的 `R21-SENDER-RECEIVER` 规定订阅保存业务发送者，daemon 每次触发前核验其当前权限。Collab 的稳定名字承载工作和消息，会话定位当前执行位置。历史工作线的 `reminder-occurrence.graph.json` 把 holder 与执行授权放在同一个检查节点。图上的节点名称不足以判定产品会因发送者关闭终端而拒发。

按已批准的 R17 和 R21 核验发送权限。订阅指定 Alice 为发送者，任务现由 Bob 负责。提醒到期时，daemon 按 Alice 的名字查她对该任务的发送权限，按当前负责人确定收件人 Bob。Alice 关闭终端且仍有权发送时，daemon 照常替她发。Alice 在线但发送权限已撤销时，daemon 拒绝本次发送并记录原因。Bob 的当前连接只用于实际投递。

正式入口待验：让 Bob 在线，分别触发上述两种情况。核对第一条消息的发送者和收件人，核对第二次触发的拒绝原因及 Bob 的收件记录。

复核发现 `v2.reminders.execute_registered_delivery` 的执行条件仍引用发送者当前会话。已按 R17 和 R21 的批准原文改为通过登记的名字核验组内身份及资源权限，并在 `R21-SENDER-RECEIVER` 的正反用例中分别写明 Alice 关终端和 Alice 被撤权时的预期结果。

补充核对历史工作线 `v2/modules/daemon/tests/reminder-composition.test.mjs` 的 `recipient.resolve`。测试按当前任务负责人的 `assignment.memberId` 查收件端，查不到时返回 `CURRENT_HOLDER_UNBOUND`。该结果描述 Bob 的连接状态。这份测试材料只覆盖受控收件端。

11 月 21 日对照 Collab 项目记忆后，撤回“Bob 离线时为本轮周期提醒创建一条待投递消息”的提案。依据为 AppSDK 的 `appsdk-collab-periodic-wake-semantics`、`appsdk-collab-task-wakeup-continuity` 和 `appsdk-inbox-persist-notification-trigger`。

R21 周期提醒已确认。任务由 Bob 负责，订阅跟随任务当前负责人的名字。到点时 Bob 忙碌或离线，本轮跳过。daemon 按原有效订阅判断后续轮次。已经进入 Bob 收件箱的消息仍可按名字查阅。普通消息和显式单次通知按各自条文处理。

正式入口待验。给 Bob 配每 10 分钟一次的任务提醒，让他在 10:00 离线，10:05 用同一个名字回来。查看收件箱、原订阅及执行记录，确认 10:00 跳过、10:05 无补发、10:10 按当时状态判断。再查看断线前已入箱的消息。

复核时发现，执行流程将读到当前会话列为前提，离线且没有当前会话的负责人无法走到跳过分支。现已将前提改为从任务查到负责人的名字，并在订阅结果中列出本轮跳过。上述离线用例仍待正式入口实测。

### R21 有限周期提醒的续订与晚读

以下采用 11 月 21 日用户对 zterm 的直接裁决。正式入口待验。

1. 任务临近到期时提醒负责的 agent，由该 agent 自行续订。
2. 每 10 分钟提醒一次。Bob 在 10:12 读到 10:00 的消息，下一次仍在 10:20 按当时状态判断。过期前已入箱的消息可继续查阅。

### R22 巡检与 R23 派单

R22 已批准。按 R17 和 R22 的现有条文，Henry 换终端后仍可按自己的组内身份查原巡检。正式验收可复用 R22 的例子，在两次巡检之间换终端，核对同一订阅、同一份日志、原定时间和剩余 37 次。

R23 已收录用户对 Rex 的说明。验收时向忙碌的 Henry 排入任务，再按 Henry 的名字查待办。忙闲未知时查他当前绑定窗格的 `program_status`。结果仍不明确时，agent 可读同一窗格的 capture。证据不足时保留未知。R22 与 R23 的正式入口验证均待完成。本轮无新增待批条款。

R23 的正例现要求在 Henry 换终端前后核对同一待办的工作引用。这一步把稳定名字的裁决落实到排队任务。待正式派单入口接入后执行。

### 周期提醒跳过后的剩余次数（已批准）

用户以「yes」批准 zterm 采用“实际发出才扣一次”。已写入 R21 条文、提醒行为与验收用例。

正式入口待验。Bob 的订阅还剩 2 次。10:00 他忙碌或离线，系统跳过，原订阅仍显示 2 次。10:10 他在线空闲，实际发出提醒后剩 1 次。验收时对照同一订阅的余额、原到期时间和 Bob 的收件记录。

本次修订沿用此前补入执行流程的“本轮跳过”结果。

历史工作线 `v2-delivery-ontology-20261111` 的 SQLite 实现曾在 `recordConsumption` 中调用 `settleSubscriptionAfterConsumption` 增加已用次数。`delivery-accepted` 分支只写本条提醒的状态。验收时应在 Bob 的终端实际收到提醒、Bob 尚未读取时先查询余额，再在读取后查一次。两个时点均应剩 1 次。代码位置为 `v2/modules/reminders/src/adapters/sqlite-reminder-store.mjs` 的上述两个函数，正式服务仍待实测。

## 2026-11-21 实现与 ontology 语义差距

审计基线：`origin/main` 的 `4d80126e`。当前分支 `77cf6b38` 尚未合入该提交。历史工作线 `v2-delivery-ontology-20261111` 有提醒模块，但主线没有 reminders、daemon reminder route 或其 DAG。以下证据只说明当前主线或历史工作线对应层的状态，不把二者拼成产品通过。

| 条款 | 首个语义差距 | 结论 |
| --- | --- | --- |
| R17 | `members-service` 的 binding 和 generation 以 `memberId` 为键；organization 主线没有 `peerId`。一个 peer 在多个 group 的成员身份无法共享同一运行绑定。 | implementation_gap |
| R18 | organization 主线成员只有 name、group、manager，没有 group role 或 work duties 的读写入口。 | implementation_gap |
| R19 | goals 主线的 `updateGoal` 接受 `ownerMemberId` 并直接修改 owner，没有邀请与接受前置。当前 daemon 未暴露该 update route，不能证明 WebUI 可转交，但服务契约仍违反“未接受不得转移”。 | implementation_gap |
| R20 | 主线没有 handoff reconcile 端口、partial/unknown 投影或按原操作继续未完成效果的可执行入口。 | implementation_gap |
| R21 | 主线没有 reminders 实现。历史工作线在 `recordConsumption` 才扣剩余次数，在 `waiting-recipient` 保留未发 occurrence；二者分别违反“实际发出才扣一次”和“忙碌或离线跳过本轮”。 | implementation_gap |
| R21-SENDER-RECEIVER | 历史订阅契约没有独立 sender 或 initial receiver 字段，执行授权只携带订阅的当前 authorizationRef。无法查询订阅注册时的明确 sender 与 initial receiver。 | implementation_gap |
| R22 | 主线没有巡检管理或执行入口。历史 reminders 有 patrol 计数和续批，但未证明目标/group/CEO 范围授权及正式 WebUI 路径。 | implementation_gap |
| R23 | 主线 board 只有 busy/idle/unknown 状态值，没有待派工作队列、成员排队或 Rex `program_status`/capture 的正式入口；status 模块也没有聚合实现。 | implementation_gap |

证据入口：

- R17：`v2/modules/members/src/application/members-service.mjs` 的 `state.bindings` 以 memberId 索引；`v2/modules/organization/src/application/organization-service.mjs` 主线成员记录无 peerId。
- R18：同上 organization 服务的 member create/update copy 均无 group role 或 work duties。
- R19：`v2/modules/goals/src/application/goal-service.mjs:178` 的 updateGoal，当前主线 daemon 的 work-goal route 只有 GET。
- R20：主线没有对应 handoff service route；历史目标邀请服务也不能替代整体交接恢复。
- R21：主线 `git ls-tree origin/main v2/modules/reminders` 为空；历史工作线 `sqlite-reminder-store.mjs` 的 `markDeliveryAccepted` 与 `recordConsumption` 分别处理送达和计数，`occurrence-controller.mjs` 对无 holder 返回 waiting-recipient。
- R21-SENDER-RECEIVER：历史 `subscription-service.mjs` 与 `contracts.ts` 只有 workRef、schedule、authorizationRef，没有 sender/initial receiver 注册字段。
- R22：主线没有 reminders 或 patrol route；历史 patrol 模块仍缺正式身份范围 gate。
- R23：主线 `v2/modules/board/src/domain/board-view.ts` 只声明成员状态值；`v2/modules/status/src/public/index.mjs` 只导出 observation；没有 queued work 或 Rex probe 的公开执行入口。

这些差距需要先按 ontology 更新受影响 DAG 和 gate，再由各自唯一 owner 实现。当前结论不是代码修复完成，也不是正式入口验收。

治理层同时缺图。`origin/main` 的 `v2/docs/dagpipe/graphs/` 只有 goals-tickets-board、成员/机器连接等七张图，没有 R17 至 R23 对应的 handoff、reminders、inspection 或 dispatch 图。结构化条款中这些 edge 仍以 `proposed:` 开头，R23 也只写“拟绑定”。因此条款虽已批准，但没有可执行 gate 承接。主线和历史工作线均不能据此宣称 binding 已完成。

### 2026-11-21 全库状态复核

本轮目的：确认是否还有待用户审批的 ontology 语义，并复核全部条款的 approval 与 governance 状态。

证据来源：当前任务分支的 `delivery-ontology.json` 以 `jq` 读取全部 27 条；`origin/main` 以 `git ls-tree` / `git grep` / `git show` 核对实现与 DAG。项目根没有 `.appsdk/requirements.json`，本次不适用该声明文件。

结果：27 条条款的 approval 均为 `approved`，没有 `candidate`、`rejected` 或待批语义。因此不再需要新的语义审批；下一步是实现与绑定差距修复。治理状态为 4 条 `bound_in_task_worktree`（R01-R04），23 条其他状态。R08 有图和历史验收入口，但状态仍记录为正式组合待补。`binding_pending` 中 R05-R16、C1/C2 多数已有局部或历史验收证据，但正式组合验收未闭合；R17-R23 除局部历史证据外，主线存在上表的实现差距。

R20 需要单独防止误判：主线 `delivery.resumeDispatch` 与 tickets 的 `confirmRemoteResult` 已有各自恢复/unknown 处理，但它们只覆盖消息投递和 ticket 写入。R20 要求的身份、角色、任务、消息和提醒交接整体可查询并只续接未完成效果；主线没有对应的 handoff reconcile 端口，不能把两个局部入口合并成 R20 通过。

治理裁决已确认。用户明确要求更新过时的 gate 和治理。已批准条款在实际入口具备可执行 DAG edge/gate、合法用例、违规用例和公开观测证据后才可用于强制验收。在此之前保留原绑定状态。主依赖顺序为 R19、R21、R17、R18、R20、R22、R23。独立且写入范围不重叠的纠偏可并发推进。

### 2026-11-21 R19 架构设计与执行交接

本轮目的：把已批准的 R19 语义转成可执行 DAG、gate 和 executor 文件合同。

证据来源：当前 `goals-tickets-board` 图、`goal-service.mjs#updateGoal`、daemon
work-goal route、既有 goals/daemon 测试及历史 R19 邀请复验报告。主线
`updateGoal` 仍可直接改写 `ownerMemberId`；历史邀请证据不等同于当前主线已绑定。

设计结论：R19 采用显式 invite、query/resume 和 accept-and-commit 状态机。邀请
不改变 owner；同名 resume 只读并保留原 owner；错误 actor、重复 accept 和提交失败
不得改变 owner 或邀请状态。普通 update 必须拒绝 owner 变更。该设计已写入
`r19-assignment-handoff-plan-20261121.md`。

所有者边界：goals 持有 assignment owner 和 invitation 提交；daemon 暴露公开
route 并解析已认证 actor；organization 提供同 workspace 成员身份；webui 只投影。
本轮不实现 reminders，不修改 ontology 文件，不触碰 R10。

执行合同：
`.worker-runs/mvp-ontology-review-20261121/r19-assignment-handoff/task.md`。
board 父任务 `mvp-ontology-review-20261121` revision 1；子任务
`r19-assignment-handoff-20261121` revision 1 保持 pending。

交接结果：peer 调用 `collab board invite` 返回 `BOARD_MASTER_REQUIRED`，邀请未
发出，任务状态未改变。已向当前 master Jenny 发送派发请求
`m1795310980430-4`。等待执行者交付后由 architect 验收证据；最终 Review、
merge/push 仍归独立 owner。

剩余缺口：尚无执行者红绿证据、公开 HTTP gate 结果、独立 review 或正式产品验收。
R19 继续为已批准但不可强制的 `binding_pending / implementation_pending`。

### 2026-11-21 R21 提醒绑定架构设计

本轮目的：在 R19 的 accepted owner 事实之上，设计 R21 的 sender/receiver 注册、
周期触发、忙碌/离线跳过、实际发出扣次、晚读和当前 owner 投递。

证据来源：当前主线没有 reminders 模块或 daemon reminder route。历史工作线的
`recordConsumption` 扣次和 `waiting-recipient` 仅作为反例证据。R19 状态机设计已
分开落盘，但当前实现仍未交付。

设计结论：订阅注册保存不可变的 sender 和 initial receiver 引用；每次 tick 从
goals/tickets 读取当前 owner。busy、offline 或 unknown 在周期触发时写 skipped/
unknown，不创建等待消息、不扣次数。只有投递模块确认实际发出才扣一次。本地受理
和排队回执不触发扣次。晚读只记录 consumption，不改余额和下一次排期。Rex 未知时先读绑定窗格
`program_status`，仍不明确才可读同一窗格 `capture`；证据不足保留 unknown。

设计文件：`r21-reminder-binding-plan-20261121.md`。本轮不创建 reminders 实现、
不伪造执行合同、不修改 ontology，也不把历史模块测试或静态图当作产品验收。

依赖和缺口：R21 的 owner transfer subclause 需要 R19 accept-and-commit 先提供
当前 owner。执行者未派发，R19 也无公开红绿证据，因此 R21 只完成架构设计，仍为
approved / binding_pending / implementation_pending。正式 daemon composition、
真实 agent 投递、两机验收和独立 review 均未完成。

### 普通目标更新的调用方与提醒扣次的证据

本轮核对审计工作树候选中的两条调用路径。R19 已由 Alice 交回，原 board
任务已退回返工。正式回执见
`.worker-runs/mvp-ontology-review-20261121/r19-acceptance/acceptance.md`。

- R19：`goals/src/application/goal-service.mjs` 返回 `updateGoal`。在 `v2/`
  源码中，能定位到的直接调用均在测试中。`daemon/src/server.mjs` 的 work
  路由调用 `createGoal`、`getGoal` 及专用 assignment 操作。普通目标更新的
  产品调用方仍缺组合证据。R11 已规定 WebUI 普通编辑。Alice 按原返工合同
  定位实际编辑入口，独立测试员在该入口验证普通编辑与换 owner 拒绝，再从
  专用转交入口观察邀请前后归属。
- R21：`delivery/src/application/submit-message.ts` 在请求重放时可直接返回
  `accepted` 和已有 receipt，分支在 `dispatchMessage` 之前结束。
  `delivery/src/domain/receipt.ts` 将初次本地受理记录为 `accepted/pending`。
  因此仅凭顶层 `accepted` 扣次会有误扣风险。后续提醒执行者需将一次周期
  触发与同一次投递的实际发送证据关联。对照场景为本地受理后尚未发出便重放、
  实际发出但未读、同一发送回执重复到达。预期扣次数分别为零、一次、累计一次。
  此处记录的是代码路径及待验证场景。实际发送对应的公开回执和接收端观测仍待
  执行者配对取证。

公开回执路径复查：`delivery/src/public/delivery-port.ts` 暴露
`queryReceipt(actor, DeliveryRef)`。`webui/src/clients/delivery-client.mjs`
则发送 `delivery.queryReceipt` 请求，参数为 `messageId`。本轮在 V2
生产源码中只定位到该请求的客户端调用，尚未找到负责将 `messageId` 解析
为 `DeliveryRef` 并查询投递模块的正式入口。R21 执行合同需明确从正常
daemon 触发到接收端及余额查询的关联证据，再确定应复用的公开路径。

并行取证沿原返工单交接。Alice 核对标准依赖入口并返回首个缺失声明或
可复现命令（`m1795316126386-176`）。Olivia 从已有交付证据区分运行绑定
查询与成员写入，返回可核对的入口、权限和副作用证据
（`m1795316153437-179`）。两项只读取证已交回。用户确认更新过时的 gate
和治理后，架构师已直接发出原任务返工合同。Alice 负责 R19 互斥操作图
（`m1795317890181-42`），Olivia 负责 R17/R18 读写分支图
（`m1795317890212-43`）。两条返工的图文件互不重叠。组合入口及测试
依赖沿原合同解决并回报。

后续可并行准备的验收场景（按执行容量与真实依赖派发）：

- R20：用同一交接操作观察任务归属已提交、提醒效果仍未知的状态。
  恢复后分别查询原操作、当前归属和提醒。再次恢复时应沿用原操作，
  已提交的归属和已发提醒各保持一次效果。`delivery.resumeDispatch`
  和 `tickets.confirmRemoteResult` 可提供各自效果的证据。组合验收依赖
  R19 的归属提交和 R21 的提醒观测。
- R22：可先核对同一 group manager 管理组内目标与管理组外目标的授权差异。
  后续测试员通过 WebUI 观察组内操作结果、组外拒绝原因及原配置。巡检
  订阅恢复和周期执行的验收依赖 R21 的持久订阅与实际触发。
- R23：分别核对忙碌成员的待办和该成员的忙闲观测。向忙碌成员排入任务，
  按其稳定名字查询待办并观察归属。另取一个状态未明的绑定，先查目标
  窗格的 `program_status`，仍不明确时用同窗格 `capture` 取证。
  证据不足时预期返回 unknown。队列场景可以单独准备，换设备后的组合
  验收依赖 R17 的稳定身份绑定。

### R20 恢复入口的交接设计

首个组合用例取任务转交成功、提醒执行结果未知、客户端丢失响应。查询与重试分别建图。查询只按原操作引用核验各业务 owner 的当前事实，返回已提交项、未完成项和原始错误。重试先复用查询，逐项判断是否仍适用。后续归属已改变时，向调用方显示当前归属及原效果被取代的事实。只有能证明尚未执行且仍获授权的效果才交原 owner 执行。再次查询同一操作，验证归属版本、消息引用和提醒次数。

验收时先通过 R19 接受邀请并提交，模拟响应丢失，再从公开查询读回已生效的归属。消息已有确认回执时沿原投递引用回读。提醒结果仍未知时保留原错误和 `partial` 或 `unknown`。补齐证据后仅接续明确未执行的效果。重复恢复应读到同一次转交、同一条消息及同一提醒轮次。另让后续合法 owner 接替，并使可选布局读回失败，验证当前归属和基础通信仍可使用。

daemon 组合入口负责关联与投影，业务模块分别持有身份、组内职责、工作归属、投递回执和提醒结算。`tickets.confirmRemoteResult` 和 `delivery.resumeDispatch` 仅适用于各自操作。组合 gate 需要 R17/R18 的身份与职责入口、R19 的归属回读和 R21 的提醒观察路径。当前交接内容供 executor 补图和设计红测使用。

#### R20 查询和恢复的取证合同

查询图设计为 `原操作引用 → 验证调用者和工作区 → 按引用向各效果 owner 查询 → 投影当前关系及原始错误 → 查询结果`。每次查询都须能观察到相同的邀请、消息和提醒引用。查询失败的项保留其错误和未知状态。

恢复图设计为 `原操作引用 → 复用已授权的查询 → 判断原效果是否仍适用 → 由效果 owner 按原引用处理可续项 → 回读各 owner → 恢复结果`。恢复前查到的 owner 和 revision 只说明读取时的状态。涉及写入时，由持有该效果的 owner 在提交处核对当前授权、原操作关联和适用条件。跨模块仅能看到旧投影时，将该项保留为待核实。

首个并发用例在隔离夹具中控制两个公开操作的顺序。先让 A 转给 B 并提交，保留第一次操作的引用。启动第一次操作的恢复，在读取 B 后暂停。通过第二次邀请让 B 转给 C 并提交，读回 C 和此时的 revision，再放行旧恢复。以原引用查询应同时看到第一次转交已生效及当前负责人 C。再次恢复后，任务仍属 C，revision 等于第二次提交后的值。对照接收端收件箱、原投递引用和提醒轮次，以确认旧恢复没有再次产生效果。合法对照使用相同数据，但保持 B 为负责人，只接续有明确未执行证据且当前仍获授权的一项。

取证执行者先检查 `v2/modules/goals/src/application/goal-service.mjs` 中 `acceptAssignmentInvitation` 的提交与查询投影，再对照 delivery 回执及 R21 轮次查询。交回每项效果的公开读取入口、原引用、授权字段、提交时可检查的条件和可复现观测。在缺少公开入口时，标出缺失的 producer、consumer 和对应 owner。当前阶段仅形成图设计和验收合同，真实组合测试待上述入口接通。

#### R20 原邀请与当前授权的对照

| 操作顺序 | 恢复第一次交接时的公开断言 |
| --- | --- |
| A 转给 B，B 修改目标名称 | 保留新名称和当前负责人 B。第一次邀请显示已接受。普通编辑也会递增目标 revision，必须独立判断余项授权。 |
| A 转给 B，B 转给 C，C 再转回 B | 保留第一次邀请已接受的历史事实。最后一次转回 B 有独立的邀请。只有能关联到当前有效交接的余项才可执行。重放第一次操作后核对两端消息和提醒轮次，旧操作不得重复产生效果。 |

本轮给观察执行者的问题是，goals 的公开 assignment 与 invitation 查询是否给出可区分上述两条历史的提交依据。沿 daemon 路由、goals 提交点及公开投影核对，列出调用、可读字段、缺口和所属模块。结果交 architect，源码与测试中的断言分别标注。范围限定为只读取证。

只读取证已由一次性观察执行者交回，结果在
`.worker-runs/mvp-ontology-review-20261121/r20-assignment-observe/result.md`。
公开 assignment 查询只返回最新邀请。第一次邀请仍持久存在，但当前 HTTP 没有
按 `invitationId` 的只读查询。测试只覆盖单次邀请，尚未覆盖 A-B-C-B。

架构下一步已写入 `r20-handoff-query-plan-20261121.md`：goals 在接受提交的同一
store update 中保存 `committedGoalRevision`，daemon 增加精确邀请 GET，并用
`handoff-query.graph.json` 绑定只读 gate。该实现会与 Alice 当前 R19 写面重叠，
必须等 R19 释放后才派发。此增量只补 goals 侧历史事实，不替代 delivery 和
reminder 的 R20 组合恢复。

### R22 与 R23 的可并行设计

R22 的授权和连续执行计划已写入
`r22-inspection-scope-plan-20261121.md`。图中把 management 与 run 分成两个
SESE，唯一 owner 分别是 inspections 的配置提交与 occurrence 结算。实现依赖
R21 的调度及实际投递结算，不另建第二套 scheduler。

R23 的队列和忙闲探测计划已写入
`r23-work-queue-activity-plan-20261121.md`。`board` 保持只读，新增 dispatch
owner 持有 queue item 和候选评估理由；Rex 先探测同一绑定窗格的
`program_status`，仍不明时只提供同一窗格的 capture 引用，事实不足保持
unknown。实现依赖 R17 的 peer 共享绑定和 R18 的职责读回。

R22 graph 任务已发布为 `r22-inspection-scope-graph-20261122`，board revision 1，
executor Iris，reviewer Noah。architect 的 `board dispatch` 仍收到
`BOARD_MASTER_REQUIRED`，已请 Jenny 按当前 revision 发正常邀请。该阻塞只影响
R22 graph 开始，不影响 R20 设计与 R23 文档准备。

Jenny 后续完成正式邀请。R22 原工单在邀请后为 revision 3、`invited`。
Iris 的当前 Rex 绑定仍报告 `generation_mismatch`，原邀请待接受，由 Jenny
跟进既有绑定恢复请求。R18 原工单由 Olivia 保留，等待当前 attempt 和绑定的
Execute 回执。R19 的 finding 复核按原合同等待 Alice 正式交回。

R21 并行只读取证已交回，见
`.worker-runs/mvp-ontology-review-20261121/r21-readiness-observe/result.md`。
delivery 的 `remote-stored` 对应目标网关确认存储。WebUI receipt 查询只传
`messageId`，模块读取需要经授权的完整 `DeliveryRef`，当前 daemon 缺组合入口。
已在 Olivia 的原取证合同中引用该结果。后续需要在正式发送路径核对同一轮次、
远端未读消息及订阅余额，再确定实际扣次证据。

### R20/R23 拓扑并行推进

2026-11-22，架构师把两个可独立执行的图面交给一次性执行者。R20 初稿
`handoff-query.graph.json` 通过 `dagpipe graph validate/inspect`，但复核发现
未授权、引用缺失和 tuple 不匹配只是节点说明，没有显式 selector 分支；因此
撤回拓扑验收并按 `r20-query-graph/rework-task.md` 返工。返工要求成功、未授权
和 scoped not-found 三支显式汇入同一只读结果，并保留 pending 或 unknown 提交
证明。

R23 入队写链 `work-queue.graph.json` 通过 validate/inspect，并把授权、工作
引用、成员职责放在唯一创建分支之前；busy 不参与拒绝，拒绝分支零队列副作用。
该图仅是入队拓扑输入，不代表实现或产品验收。

R20 返工后通过 validate/inspect。`authorized=false` 和
`tupleMatched=false` 均有显式 selector 分支：前者不读取邀请或归属，后者不
读取 assignment 投影；成功、未授权和 scoped not-found 汇入同一只读结果，
并保留 pending 或 unknown 提交证明。

R23 读侧 `work-queue-query.graph.json` 同日交回并通过 validate/inspect。该图
按稳定 peer 名字、精确 group 身份和 work reference 定位待办，成功投影只含
queue item、workspace、work、稳定 peer/member、state、入队时间和 actor，并
显式排除 session、endpoint、device、binding 与 generation。架构师接受三份
图作为对应实现的拓扑输入。operator 注册、公开 route、真实观察和独立验收
仍缺，R20/R23 维持 approved / binding_pending / implementation_pending。
