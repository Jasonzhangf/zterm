# V2 交付语义与逐条确认

## 2026-11-21 合入双机终端后的 MVP 复审

复审基线为 `origin/main` 的 `dc27e13a`（PR #214）。配套 JSON 保存原工作线逐项批准的文字、对象、行为、关系、owner 和正反用例。本节记本次基线证据。下文的旧 gate 和实现记录以当时的任务工作树为范围。原库标为 `bound_in_task_worktree` 的四个专用图都在主线之外。本次对主线七张业务图逐张执行了 `dagpipe graph validate` 和 `inspect`。线上运行覆盖按下表中的行为判定。

| 条款 | 用户可观察的行为及界限 | 本次核对结果 |
| --- | --- | --- |
| R01 | 同一正式 WebUI 的桌面和手机浏览器都能打开主导航 | 双机 QA 已覆盖桌面和手机视口。全导航正式交付待验。 |
| R02 | 登录后只列出当前账号有权选择的机器 | 双机 QA 已覆盖账号入口、目标机目录和错误凭据。完整目录权限矩阵待验。 |
| R03 | 每次资源操作依当前授权放行或拒绝，切换账号隔离旧数据 | 双机入口拒绝错误凭据。相关组合候选曾在 B 页面显示 A 的终端正文，账号切换待独立复验。 |
| R04 | 同一 authority 持久保存组织树和稳定 ID，同组重名拒绝 | 本地组织与重名已有候选证据。正式创建、重开和授权写入待组合验收。 |
| R05 | 选择目标机后显示实际握手和直连或中继路径 | #214 双机实测通过 direct 和 TURN。 |
| R06 | 打开绑定的真实终端并只向该目标写入 | #214 已读回远端正文，标记只进入 Air，断线后旧输入被拒。 |
| R07 | 同组跨机成员可消歧，绑定的 agent 实际收到投递 | 远端终端输入已验。agent 收件仍缺目标宿主证据。 |
| R08 | 断线后重连到原成员，拒绝旧代行为 | #214 覆盖链路换代和旧代拒绝。同身份接替及未消费消息见 C2。 |
| R09 | 跨机消息按原期限和预算重试，回执区分受理、交宿主和消费 | 候选已在桌面和手机查回原本机回执，最高阶段为 `host-delivered`。跨机默认重试与消费待验。 |
| R10 | 跨机文件在接收端核验并提交，断线后从已确认位置继续 | 现有文件候选仍需两机、撤权、重启续传及最终文件读回。 |
| R11 | 授权用户创建和修改目标，重开后读回 | 已有候选 HTTP 与持久化记录。正式页面与服务组合待验。 |
| R12 | 工单可创建、指派、报告、关闭和重开，未知写入保留原结果 | 已有 Vikunja 模块证据。正式 WebUI 中受限身份和真实服务的写入、失败待验。 |
| R13 | 看板先按 manager 范围及目标过滤，再取各目标前五项 | 已有模块及服务组合证据。正式入口选择 manager、刷新并验证作用域待验。 |
| R14 | 保存布局后可恢复，移动焦点或切换 workspace 保留正确终端 | 桌面拖动、同账号布局恢复和窄屏标题已有局部通过。移动 A/B/A 返回时出现空正文，释放与恢复仍缺通过结论。 |
| R15 | manager 挂接保留原组织身份及权限，非消息操作按各自路径授权 | 候选已有组织接口正反例。两机逐跳授权、同名及挂接拒环待组合验收。 |
| C1 | 有明确身份与权限时，普通消息及关联回信可跨组直接发送 | 已有批准。远端 agent 收件和回信链待验。 |
| C2 | 合法新 holder 仅接续仍有效的未消费消息，先查已受理或未知的原 attempt | 已有批准。需验证旧 holder 拒绝、保留原期限和去重。 |
| R17 | 稳定 peer 可在合法新会话恢复身份，多组关系共享当前绑定 | 待在正式入口观察接替和旧会话隔离。 |
| R18 | group 中的角色与工作职责可分别查询，执行仍需对应权限 | 待验证多组身份和跨范围拒绝。 |
| R19 | 同身份换会话继承工作，跨 owner 交接在接受并提交后生效 | 待验邀请前后归属和迟到结果。 |
| R20 | 部分交接可查已生效项，恢复只完成余项 | 待验响应丢失后查询、去重及后续接替。 |
| R21 | 授权用户配置持久提醒，重开后保持原节奏、余次和期限 | 待验正式页面、实际触发、取消与到期。 |
| R21-SENDER-RECEIVER | 注册时记录业务 sender 和初始 receiver，每次由 daemon 按当前权限执行 | 待验发送者撤权及触发记录。 |
| R21-OWNER-TRANSFER | 新 owner 接受后，后续新提醒跟随新 owner，原回执保留原目标 | 待验邀请、接受和下一次触发的接收人。 |
| R22 | owner、group manager、获授权 CEO 分别在各自范围巡检 | 待验越权拒绝、批次重开、计数和停止。 |
| R23 | 成员 busy 时工作可以排队。同类型候选派单时，idle 是优先级评估因素之一。 | 用户已确认这两项派单语义，执行绑定待验。 |
| R16 | 正式服务可启动，完整用户路径经独立两视口、两机、整体审查和主线入口验收 | #214 已完成双机终端增量的审查、CI 与主线合并。完整 WebUI 的干净安装、跨机投递及相关条款仍影响最终验收。 |

### R23 成员活动与派单

成员正在处理工作时，可为该成员排入后续任务。入队后，该任务处于等待状态。派单准入不要求成员 idle。对同类型且符合任务要求的候选成员，派单时可将 idle 作为优先因素，与其他适用因素一并评估。会话可达性、状态过期后的展示仍待确认。

结构化条款库为 [delivery-ontology.json](delivery-ontology.json)，持有已批准的需求原文、三轴语义、批准来源和实际 gate 绑定。本文件说明已确认的交付目标、当前证据与剩余缺口。业务 DAG 与实际 gate 持有执行约束。已确认、已入库、已绑定和已验证分别记录。

## 当前交付目标与缺口

已确认目标是从桌面或手机WebUI管理组织、目标与ticket，在多窗工作台使用本地和远端成员的真实终端、消息与文件。普通消息及关联回信在身份明确、当前资源权限允许时可跨group/workspace直达，经产品daemon持久化和派送；不依赖manager挂接，也不产生任务、订阅或管理权限。终端、文件、任务指派和订阅管理仍按各自权限与所需manager路径执行。消息最终到达成员绑定agent并取得宿主证据，按正式默认timeout/retry处理失败与失效；同一稳定peer的合法holder接替可受控接续未消费有效消息，但保留原delivery/attempt、期限和重试预算，accepted/unknown先查询原attempt。文件核验完整后原子提交到接收端inbox并支持持久续传。组织、角色/职责、工作归属、提醒、巡检与布局可查询和恢复；旧holder与迟到回调不得覆盖当前身份或业务事实。正式交付须有独立桌面/手机、真实两机、完整milestone审计和main集成证据。

| 用户路径 | 当前有效结果 | 距离交付的缺口 |
| --- | --- | --- |
| 桌面与手机打开 WebUI | R01 浏览器 gate 已绑定，正反用例通过 | 正式服务、真实登录材料与独立交付验收记录尚未齐备 |
| 登录并选择授权机器 | R02 已绑定，登录错误显示已修复，独立隔离浏览器回归通过 | 正式账号服务与已知机器权限样本的端到端验收 |
| R03 当前权限决定操作放行 | 连续logout/撤权/机器撤销/跨范围gate已绑定，非实现者独立执行通过 | 正式WebUI组合授权/撤权验收 |
| R04 从空目录建立组织 | 原独立Chromium组织全流程通过，显式URL/create/reopen consumer与validator已补 | 正式账号管理grant、真实配置组合与新模式独立验收 |
| R05 真实两机连接 | direct/TURN、目标身份和实际路径历史证据有效 | 版本管理统一consumer与当前正式组合独立验收 |
| R06 真实终端显示/输入 | 远端实际输出、精确输入及非目标隔离历史证据有效，当前公开consumer回归有效 | 当前正式组合的真实两机与独立前端验收 |
| 同组跨机成员准确使用 | routing/deviceId/wire与native输入已有证据，正式host配置已用生产connector核验真实thread并保存绑定 | HTTP/UI远端绑定、唯一authority、receiver/attempt到宿主的产品链与真实两机组合待补 |
| R08 断线、绑定恢复与受控交接 | 原恢复gate的非实现者Chromium重开、重绑、旧代拒绝、错误目标及健康成员用例通过 | 新增的同peer holder接替、未消费消息接续、旧holder拒绝与accepted/unknown原attempt查询尚未实现并绑定；真实host与两机恢复仍待补 |
| R09 消息默认超时、重试、结果与受控交接 | 持久source/target/attempt及runner公开端口已有受控组合证据，真实宿主输入已出现，host-delivered读回仍未闭合 | C2扩展的当前holder接续/旧holder拒绝/原attempt不重放尚待实现；正式消息/agent链、默认配置与真实两机组合仍待验收 |
| R10 文件完整交付与续传 | V1算法可复用，V2持久receiver和公开direct file runtime已通过隔离consumer | WebUI→HTTP→delivery/connections完整组合、manager relay、真实两机验收 |
| R11 目标管理 | 公开HTTP修改、409与重开通过，双向引用竞态已修复，另有真实Vikunja模块组合证据 | 页面修改及当前HTTP/真实provider的独立前端验收 |
| R12 ticket生命周期 | 真实Vikunja模块组合已过，owner PATCH公开HTTP已接通且持久读回通过 | 当前HTTP/UI用户路径与真实provider的非实现者两视口验收 |
| R13 管理看板 | 真实provider/组织/goals/tickets/board组合已验证每目标独立前五项和直属成员投影 | manager选择、打开对象、刷新重开的真实前端验收 |
| R14 工作台布局 | 原独立布局通过，SSE/client公开正文控制与只读current复核已补，物理链路和浏览器组合进入独立QA | 当前V1/Chromium、真实两机连接副作用及适用Android L5 |
| R15 manager挂接与多group身份 | 组织/members/routing组合已有证据，manager/attachment/peer公开HTTP正反行为已过；C1已批准普通消息/reply跨group直发 | 普通消息直达consumer尚待实现；仍需manager的非消息逐跳权限/relay、UI及真实两机agent收件待补 |
| R16 正式可用交付 | 阶段gate及R04适配已实现；正式local runner用真实relay完成登录和持久组织HTTP流程 | distributed正式组合、其余业务adapter、独立前端/真实两机验收、整体审计、main集成与正式入口复验 |

R01–R16、C1/C2及R17–R22已逐条确认并入库。R07的agent实际接收终点、R09的默认timeout/retry、R15的manager挂接模型，以及C1普通消息直发和C2受控消息交接均按用户修订保存。实际gate绑定与验证状态继续独立推进；原R08恢复gate的有效证据仅覆盖原恢复范围，不证明新交接语义已绑定或验收。C1/C2与R17–R22当前均为approved、governance `binding_pending`、verification `implementation_pending`。本轮未新增产品DAG、gate或实现。

条款当前存于本项目 ontology 库。AppSDK ledger 接入仍有项目声明缺口。本工作线修改尚未合入 main，完整 milestone 的组合验收、一次整体审计与集成交付仍待完成。

跨机主线已确认首个缺边为workspace组织authority的定位与公开读取，其后是目标机器当前member binding/generation和本机host核验。现有正式startup各自创建本地store，`machineRoutes`提供机器endpoint。真实两机需要补齐权威读取、当前授权和S/H/D正式组合，源码观察依据位于本任务 `two-machine-authority-observation/report.md`。环境准备依据为 `two-machine-runtime-readiness/report.md`，最小组合设计正在 `two-machine-composition-plan/` 推进。

用户于2026-11-12追加要求吸收 `~/github/appsdk` 当前Collab的多agent身份、角色和投递语义，并纳入角色锚定、身份/角色切换、提醒与巡检。source三轴映射已有独立计划；其设计与源项目批准不代表V2实现。本地条款仍由用户逐条批准后入库并绑定V2公开行为。

source映射已完成独立语义规划，完整依据位于本任务 `collab-ontology-alignment-plan/plan.md`。Collab最新已批准目标与主树旧声明、任务候选和安装态分别记录。V2新增语义批准来源收录于本任务 `collab-approvals-20261112.md`；源项目状态、候选入口和UNSUPPORTED均不作为V2实现或验收证据。R23若未在该批准输入中明确回复为批准，不入库。

| 已批准增量 | 修订范围 | 当前治理与实现状态 |
| --- | --- | --- |
| C1 普通消息与关联回信跨group/workspace直发 | 修订R15消息范围；manager仍只挂manager，非消息操作沿各自权限路径 | approved；binding_pending；implementation_pending |
| C2 同一稳定peer holder接替后的未消费消息交接 | 修订R08/R09；原message/attempt/deadline/budget保持 | approved；binding_pending；implementation_pending |
| R17 稳定peer身份与会话锚定 | 自动恢复、显式接替、多group共享binding、旧会话隔离 | approved；binding_pending；implementation_pending |
| R18 group角色与工作职责 | 按member身份声明多职责，职责不自动提权 | approved；binding_pending；implementation_pending |
| R19 身份切换与工作接续 | 同身份换会话保持任务；新owner接受提交后转交 | approved；binding_pending；implementation_pending |
| R20 交接结果与失败恢复 | partial/unknown可查，先核实，只接续未完成效果 | approved；binding_pending；implementation_pending |
| R21 提醒与持久订阅 | sender/初始receiver注册、daemon执行、当前工作owner、节奏/次数/期限 | approved；binding_pending；implementation_pending |
| R22 巡检与管理范围 | owner/manager/授权CEO范围、100次批次、持续日志与停止 | approved；binding_pending；implementation_pending |
| R23 身份存活与活动状态 | 11 月 12 日记录为待答。后续确认的派单范围见本次复审 R23。 | 派单语义已记录，绑定待完成 |

消息默认timeout/retry与提醒调度分别由各自owner持有。提醒的时间/周期、次数和有效期沿提醒订阅语义执行；C2的消息接续保留R09根deadline、重试预算和到期失效。已批准条款只写入ontology，不表示相关V2 gate或产品行为已完成。

### 本任务采用的设计选择

保留已有设计选择：消息策略总timeout 60秒、首次之外额外重试2次、间隔2秒、单次等待10秒；用户确认默认timeout/retry与失效报错语义，但未指定这些数值，仍待正式配置和执行链接入。文件目标采用接收端受控inbox。跨机路由使用单一authority；运行binding由当前peer本机owner持有。以上为当前设计披露，不新增数据表、通用事务平台或V2实现声明。

## R01 首期客户端交付范围

### 用户确认

- 状态为 approved。
- 条文为「V2 首期交付正式 WebUI，同时支持桌面浏览器和手机浏览器。两种视口都能从正式服务打开页面并操作主导航。Gate 需在交付版本上由独立测试员验证两种视口，页面空白、主操作不可达或其中一种视口不可用时，该条验收失败。」
- 用户回复原文为「确认 R01，按此入库和绑定」。
- 来源为 Codex chat `01a1ce3a-8390-7fa2-98c5-0a8d2a1f8986`，确认问题 `call_e86fc6e1ff5e4d23a31a945d9eb31b8f` 第 0 项，用户回复于 2026-11-11 Pacific。

### Object

| 字段 | 语义 |
| --- | --- |
| id | `v2.webui` |
| definition | V2 正式 WebUI 服务提供的浏览器客户端 |
| identity | 同一个交付版本及其明确的服务 URL |
| owner | `webui` 持有页面与导航，运行入口 owner 持有服务配置 |
| attributes | 服务 URL、交付位置、桌面视口、手机视口 |
| perception | 浏览器请求、可见页面、主导航操作及对应页面结果 |
| must_have | 桌面和手机两个视口的可操作 WebUI |
| must_not_have | 空白页面、不可达主操作或单一视口结果被标记为本条通过 |

### Behavior

| 字段 | 语义 |
| --- | --- |
| id | `v2.webui.open_and_navigate` |
| owner | `webui` |
| precondition | 明确待验收服务 URL，实际浏览器可访问该服务 |
| input | 桌面与手机视口的页面访问和主导航操作 |
| output | 每个视口的页面呈现、导航结果与本条验收结论 |
| transition | 待验收 → 两种视口均通过，或具体视口验收失败 |
| effects | 浏览器页面与路由切换，保存验收截图和操作结果 |
| perception | 真实浏览器中的可见和可操作页面 |
| must_have | 独立测试员从正式入口验证两个视口 |
| must_not_have | 仅凭 HTTP 200、静态源码或单一视口判定通过 |

### Relation

| 字段 | 语义 |
| --- | --- |
| id | `v2.webui.supports_browser_viewport` |
| from | `v2.webui` |
| to | `v2.browser_viewport`，属性为 desktop 或 mobile |
| direction | 正式 WebUI → 支持的浏览器视口 |
| cardinality | 一个交付服务至少覆盖 desktop 和 mobile 两类视口 |
| perception | 两类实际浏览器操作回执关联同一服务 URL |
| must_have | 两类视口各自的有效页面与主导航操作结果 |
| must_not_have | 用桌面结果替代手机结果，或用另一服务结果补齐本次服务的失败 |

### Gate 绑定

- 执行图：`v2/docs/dagpipe/graphs/webui-r01-delivery.graph.json`
- 图入口为 `arc.r01_request`，图出口为 `arc.r01_verdict`。桌面和手机两个视口从同一明确 URL 进入，并汇合到一个终态结果。
- `webui.r01.resolve_target` 对应 `resolveTarget()`：只接收显式 URL 和 evidence-dir。
- `webui.r01.verify_viewport` 对应 `verifyViewport()`：加载页面、处理现有登录门、点击 `workspaces`、`connections`、`setup`，并检查 shell 路由、目标页面和可见内容。
- `webui.r01.publish_verdict` 对应 `publishVerdict()`：任一视口失败返回非零；浏览器或登录材料缺失时返回 INCOMPLETE，仍不可放行。
- Gate 脚本：`v2/modules/webui/tests/r01-delivery-browser.mjs`
- Gate 测试：`v2/modules/webui/tests/r01-delivery-browser.test.mjs`

执行命令：

```sh
pnpm --dir v2/modules/webui run gate:r01 \
  --url "$ZTERM_R01_URL" \
  --evidence-dir "$ZTERM_R01_EVIDENCE_DIR"
```

正常登录只在现有 `v2` 登录表单出现时使用 `ZTERM_R01_TOKEN`。凭据不写入日志或结果。

用例与结果：

| 用例 | 观察 | 预期 |
| --- | --- | --- |
| 合法页面 | 真实 HTTP 服务加 Chromium，桌面与手机均完成三种主导航点击 | 两视口 PASS，退出 0 |
| 空白页面 | 独立 HTTP fixture 返回空 body | 两视口 FAIL，退出非零 |
| 页面内容被隐藏 | 隔离 fixture 使用 CSS 隐藏 page-body，DOM 保留正文 | 两视口 FAIL，退出非零 |
| 导航不可达 | 独立 context 阻断全局导航按钮 | 受影响视口 FAIL，退出非零 |
| 单一视口失败 | 仅手机上下文隐藏手机导航开关 | 桌面 PASS，手机 FAIL，退出非零 |

正例加载真实 WebUI 源码，fixture 的账号与目录 API 使用测试响应。反例在隔离测试服务器或浏览器测试上下文中构造。这些用例验证 gate 的放行与拦截能力，正式交付服务的产品验收单独记录。

图校验命令与结果：

```sh
dagpipe graph validate v2/docs/dagpipe/graphs/webui-r01-delivery.graph.json
dagpipe graph inspect v2/docs/dagpipe/graphs/webui-r01-delivery.graph.json
```

本次结果为 4 节点、4 边、3 个 wave，桌面与手机节点并行，唯一出口为验收结果。图只证明拓扑和 operator 语法绑定，不证明产品行为。

作者自检证据：

- 红测：`.worker-runs/v2-delivery-ontology-20261111/r01-red-test.log`，4 个用例因 gate 尚未实现而失败。
- 绿测：`.worker-runs/v2-delivery-ontology-20261111/r01-green-test.log`，4 个正反用例全部通过。
- 隐藏正文的反例曾错误放行，原错在 `hidden-content-red.log`。补入真实可见内容断言后，合法页面与隐藏正文反例均符合预期，回执在 `hidden-content-green.log`。判定使用可见页面和实际导航结果。
- `8899` 入口试跑：`.worker-runs/v2-delivery-ontology-20261111/r01-self-check-8899/`，两种视口均为 `INCOMPLETE`，明确原因为该运行服务要求登录且未提供凭据；服务版本未核实。

### 入库与验收状态

- 用户确认已取得。
- R01 已写入本项目的 ontology 条款库 `delivery-ontology.json`，批准原文和 gate 引用可查询。
- AppSDK ledger 接入未完成。`appsdk requirements apply v2` 返回 `PROJECT_CONTRACT_MISSING:v2/.appsdk/project.json`，原错在任务记录 `requirements-apply.log`。本轮采用项目内 ontology 条款库保存获准内容，未执行 AppSDK 初始化。
- Gate 已实现并通过作者自检的正反用例；图、脚本和文档映射已一致。当前只是 gate 绑定完成，不是独立产品验收。
- `8899` 自检未完成登录态验收，不能算产品 PASS。
- 本次条目产品验收尚未执行，待独立测试员在明确交付 URL 和可用凭据上运行同一 gate 并检查两视口页面。
- 条款及 gate 当前位于 `codex/v2-delivery-ontology-20261111` 工作线，尚未合入 main。

## R02 账号登录与授权机器目录

R02 的条文、确认原文「确认 R02，按此入库和绑定」以及对话来源已写入同一结构化条款库。对象为稳定 accountId 的账号和 machineId 的已登记机器；行为为账号登录、读取授权目录和选择机器；关系为当前账号有权访问该机器。账号与目录归 accounts，表单和选择动作归 webui，公开端口由 daemon 组合。

### 实际执行绑定

- 验收图为 `v2/docs/dagpipe/graphs/webui-r02-accounts-directory.graph.json`，单一请求经过样本解析、浏览器检查和结果发布后到单一结果出口。
- `webui.r02.resolve_inputs` 对应 `resolveInputs()`，解析明确服务 URL、账号样本和机器权限样本。
- `webui.r02.verify_account_directory` 对应 `verifyAccountDirectory()`，使用实际表单和 HTTP 端口核对拒绝、成功登录、目录与机器选择。
- `webui.r02.publish_verdict` 对应 `publishVerdict()`，行为符合时通过，失败或执行前提缺失时非零退出。
- 脚本为 `v2/modules/webui/tests/r02-accounts-directory-browser.mjs`，执行入口为 `pnpm --dir v2/modules/webui run gate:r02`。

实际界面的选择动作是机器行上的 `Connect`。本条核对实际请求的 machineId 并记录连接响应，精确目标请求为此步骤的判定终点。

```sh
pnpm --dir v2/modules/webui run gate:r02 \
  --url "$ZTERM_R02_URL" \
  --evidence-dir "$ZTERM_R02_EVIDENCE_DIR" \
  --authorized-machine-id "$ZTERM_R02_AUTHORIZED_MACHINE_ID" \
  --unauthorized-machine-id "$ZTERM_R02_UNAUTHORIZED_MACHINE_ID"
```

账号材料通过环境变量 `ZTERM_R02_LOGIN_NAME`、`ZTERM_R02_CREDENTIAL` 和 `ZTERM_R02_BAD_CREDENTIAL` 提供。外层服务如有访问令牌，使用 `ZTERM_R02_TOKEN`。运行 owner 需提供已授权和已知无权机器的实际登记/授权依据，单纯编造一个不存在的机器 ID 无法证明权限隔离。输入或浏览器缺失时结果为 `INCOMPLETE`。

### 正反用例与当前缺口

隔离测试服务器提供当前 WebUI 源码及声明的账号、目录 API 响应。用例覆盖完整合法组合、错误凭据被接受、错误呈现被隐藏、空目录、无权机器泄漏、选择错误机器、目录不可用和输入缺失。它们用于验证 gate 自身，正式交付服务由独立测试员另行验收。

完整合法组合最初被产品页面阻断。错误凭据请求收到拒绝后，登录失败状态已更新，但页面仍显示等待状态，错误内容没有呈现。原始回执为任务目录中的 `r02-positive-debug.log`。

修复在 `app-shell.mjs` 的 `loginAccounts()` 失败分支补入通知和渲染。正向修复后同入口通过；撤去这两行后同入口重新出现 HTTP 401 且错误不可见的失败；恢复修复后完整 R02 正反用例通过。对应回执为 `r02-login-fix-positive.log`、`r02-login-fix-reverse.log` 和 `r02-login-fix-green.log`。

产品行为图为 `webui-account-login.graph.json`。`webui.accounts.submit_login` 映射 `loginAccounts()` 调用账号公开端口；`webui.accounts.read_authorized_directory` 映射成功登录后的 `loadMachines()`；`webui.accounts.publish_result` 映射账号结果的 notify/render 发布。失败登录由同一发布 owner 显示 typed error，目录读取只在已登录分支执行。该图描述产品行为，R02 验收图描述浏览器观察。

R02 已入库，gate 绑定验证已完成。既有 Connections 页面集成回归通过，本工作树复用了宿主已安装的 jsdom。非实现者 QA 独立执行了完整浏览器用例，合法登录与选择流程以及各项违规反例均符合预期，结果为 PASS。回执位于任务目录 `r02-qa/result.md`，完整执行输出为 `r02-qa/browser.log`。

正式服务的真实账号端到端产品验收仍需独立测试员提供明确 URL、有效账号材料和已知机器权限样本。本轮 API fixture 回执覆盖当前 WebUI 与 gate 行为。AppSDK ledger 及 main 集成状态沿用本任务既有记录。

## R03 账号与资源操作授权

批准原文、来源和三轴语义已入同一条款库。对象为当前账号与明确资源操作，行为为当前授权下执行或拒绝，关系为账号对指定 workspace、机器和成员操作的有效权限。公开回执和实际副作用共同构成观察路径。

连续授权矩阵已实现，非实现者GCM QA独立执行通过。正式命令为根package的test:r03-authorization-sequence，图为r03-authorization-sequence.graph.json，覆盖同次logout、自撤grant、机器撤销与跨范围请求后的具体typed拒绝和业务/input副作用。真实relay、账号及持久授权owner参与组合，物理链路/terminal字节为明确测试边界。独立回执为本任务r03-qa/report.md。该gate的执行绑定已记录，正式服务独立WebUI组合验收仍待完成。

## R04 组织结构与成员身份

批准原文、来源和三轴语义已入同一条款库。workspace、group 和成员各自持有稳定 ID；组织归属由 organization 持有，WebUI 提供创建与查询入口。名字唯一性按已批准的父级/group 范围验证。

此前缺失的 WebUI 创建链已补齐。非实现者联合 QA 从空目录的实际表单建立 workspace、group 和成员。同父 group 重名及同 group 成员重名均返回明确错误，持久数量和 revision 保持。跨 group 同名成员具有不同稳定 ID，同存储 daemon/browser 重开后层级与各 ID 保持。

当前为 approved / bound_in_task_worktree。实际验收图为 `webui-r04-workspace-create.graph.json`，最终 edge 为 `arc.r04_merged_evidence → 发布R04验收结论 → arc.r04_verdict`，实现为 `r04-workspace-create-browser.mjs#publishVerdict`。命令为 `pnpm --dir v2/modules/webui run gate:r04 -- --evidence-dir <evidence-directory>`。缺失成员条件或重名后产生额外对象时，verdict 拒绝放行。独立结果见本任务 `r04-r08-r14-qa/report.md`。正式账号 authority 与实际管理 grant 验收仍待补齐。

用户逐条确认与 GCM 验证并行推进。已批准条目先入库，随后绑定和验证；发现缺陷后由本任务 owner 推进修复及回归。验证等待不阻断无依赖的下一条确认。

## R05–R07 已批准的后续验证

| 条款 | 用户行为 | GCM 验证与绑定记录 |
| --- | --- | --- |
| R05 同账号真实两机连接 | 从 WebUI 经产品链路连接真实机器，核验身份、实际状态与路径 | `r05-r06-verification/`，优先复用有效两机回执 |
| R06 真实终端显示与输入 | 读取真实终端并向当前精确绑定目标输入，拒绝错误目标与失效绑定 | 同一验证目录，独立记录显示、读回与隔离范围 |
| R07 同组跨机成员使用 | 查询和定位同组本地、远端成员，准确打开与投递，拒绝歧义 | `r07-verification/`，核对真实两机同组组合证据及缺口 |

以上路径均位于本任务 `.worker-runs/v2-delivery-ontology-20261111/` 下。条文和批准来源以结构化条款库为准。当前批准已取得，实际 gate 绑定和验证结果随 GCM 回执推进。

用户进一步明确 R07 投递终点为「成员绑定的 agent 实际收到消息，并有宿主接收证据」。该澄清及来源已追加到 R07。仅完成 inbox 存储时保留该存储事实，agent 接收结论仍待实际宿主证据。

## R08 断线与成员绑定恢复

用户先回复「确认 R08，按此入库和绑定」，后续回复「允许受控交接，修订 R08/R09（推荐）」。完整条文、两个批准来源与原答已写入结构化条款库。稳定 memberId 与组织关系在恢复时保持，当前运行绑定可推进代次。旧代请求和连接回调必须受隔离，错误目标明确失败，健康成员继续可用。合法新会话接替同一稳定 peer 时，尚未消费且仍有效的消息可交新 holder 接续；原消息 ID、正文、期限、重试预算和 delivery/attempt 事实保持，accepted/unknown 先查原 attempt，已消费/超时/耗尽保持原结果，旧 holder 失去当前收件资格。

恢复结果分别呈现已完成的绑定核验和实际支持的 agent 恢复能力。原恢复范围为 approved / bound_in_task_worktree；加入 C2 交接语义后，整体 governance 为 approved / `binding_pending`，新增交接的 verification 为 `implementation_pending`。原验收图仍为 `webui-r08-binding-recovery.graph.json`，其最终 edge 为 `arc.r08_cleanup → 发布R08验收结论 → arc.r08_verdict`，实现为 `r08-binding-recovery-browser.mjs#publishVerdict`。执行入口为 `pnpm run gate:r08 -- --evidence-dir <evidence-directory>`。这些原范围证据不证明 holder 接替、原 attempt 查询或旧 holder 拒绝已经绑定。

非实现者联合 QA 已用真实 Chromium、隔离 daemon、持久 store 与公开 HTTP 通过重开稳定身份、重绑推进代次、旧请求与迟到 probe 拒绝、不可达与错误机器明确失败、健康成员继续可用。hostProbe 是受控观察，agent start/resume 明确为 unsupported。独立结果见本任务 `r04-r08-r14-qa/report.md`。真实 host 与当前两机恢复仍待补齐。

## R09 跨机消息、默认超时与重试

用户先要求 timeout 后失效，再要求默认 timeout、默认 retry，全部失败后报错；随后回复「允许受控交接，修订 R08/R09（推荐）」。完整生效条文、原批准来源及 C2 修订来源/原答以结构化库为准。

正式配置声明默认策略，调用方可显式覆盖。有效期内的可重试失败保持同一请求 ID、稳定 peer 目标和到期时间。耗尽或超时后失效并报告实际错误，迟到请求不能恢复。持久结果保留已经发生的存储、交付与消费事实，冲突 ID 拒绝，重复请求不重复投递。WebUI 分清进行中、已完成、未知与最终失败。C2 接替将消息交给同 peer 当前合格 holder，不重写原 delivery/attempt、不重置期限或重试预算，旧 holder 不再接收新派送；accepted/unknown 先查询原 attempt 以避免重复 native 输入。

用户没有指定具体默认时长、重试次数与间隔。保留设计值总 timeout 60 秒、额外重试 2 次、间隔 2 秒、单次 10 秒，仍待正式配置接入。原 timeout/retry 范围已有受控组合证据，但 C2 接续验证为 `implementation_pending`。当前整体为 approved / binding_pending，原验证合同位于本任务 `r09-verification/task.md`。

## R10 跨机文件传输

文件验证已确认当前V2从WebUI到daemon、delivery、connections和receiver的公开文件链缺失。V1 CLI真实两机续传证据在原范围有效。V2仍须复用实际基础能力补正式产品链和独立前端验收。

用户已回复「确认 R10，按此入库和绑定」。完整原文及来源已入同一条款库。传输对象持有明确目标、实际进度、持久分块和提交状态。核验完整性后原子提交，中断或 daemon 重开从持久状态续传。权限、目标或绑定失效后拒绝后续写入，其他文件与目标保持隔离。

GCM 将沿现有文件传输公开链定向核对。当前为 approved / binding_pending，验证合同位于本任务 `r10-verification/task.md`。

## R11–R13 目标、ticket与管理看板

各条原文、三轴语义和逐条批准来源已写入结构化库。目标持有层级、owner和明确状态，ticket持有真实后端生命周期并通过稳定goalId关联，看板按每个目标取有权管理ticket的优先级前五项。未知写入先查询核对，查询投影不改业务真源。当前均为approved / binding_pending，定向验证合同为本任务r11-r13-verification/task.md。

创建ticket的持久operation在binding形成前就引用Goal。pending、unknown和succeeded创建均阻止删除该Goal，重开及结果未知保持原引用。无binding的创建只有在明确failed已持久后才释放引用。Goal删除先完成时，新的创建须在provider调用前拒绝。该关系落实已批准的引用保护与未知结果核对，修复计划位于本任务goal-ticket-reference-plan/plan.md。

## R14 工作台布局与导航恢复

用户已确认桌面多窗与拖边、任意成员突出、末尾成员可达，手机画布/聚焦/上下切换/返回视点，保存重开保持稳定引用与布局。布局和workspace导航不得改变角色、终止或重复启动会话、重建健康连接。条文及来源已入库，当前为approved / binding_pending，验证合同为本任务r14-verification/task.md。

## R15 manager挂接与多group身份

最终条款替代此前workspace引用挂接候选。源group的manager/master对象以peer身份挂入目标group；挂接仍只挂manager。稳定peer对象与group内成员身份分开，同一实际agent和运行绑定复用。C1 进一步批准：身份明确且当前资源权限允许的已注册对象可跨group/workspace直接发送普通消息及关联回信，经产品daemon接收、持久化和派送，不要求manager业务透传，也不产生任务指派、订阅或管理权限。终端、文件、任务指派和订阅管理仍按各自条款与权限执行；仍要求manager的挂接路径由各层manager按本group当前权限处理。解除或修改只影响该身份与挂接透传关系，源内部角色、管理关系与会话保持；独立当前权限允许的普通消息直发不因解除挂接自动失效。完整修订、原批准来源、C1原答及三轴语义已入库，当前为approved / binding_pending。原组织/members/routing证据只证明原挂接范围，不代表普通消息直达 consumer 已完成。

运行绑定的对象身份据此采用peerId和当前代次。每次操作同时携带准确memberId作为group身份。同peer的多个有效身份查询同一份运行绑定。源master与目标peer角色分别保存在各自membership，解除挂接后源agent及会话保持。旧memberId到peerId的兼容映射属于实施方案，不能改变既有稳定member引用。普通消息路由与 manager 透传是两个独立权限路径；解除挂接不自动撤销已批准的普通消息当前权限。

## R17 稳定身份与会话锚定

用户已回复「确认 R17，按此入库和绑定」。每个peer有稳定peerId，各group成员身份分别有稳定memberId、组内名字和角色；同一peer的各group身份共享一份当前agent运行绑定。普通恢复按已持久的唯一当前锚定自动找回身份、合法角色和工作归属，端点或会话变化时更新运行绑定。用户明确指定接替时可发布新当前会话，旧会话、旧请求和迟到回调不能夺回或覆盖新锚定；事实不足显示具体unknown原因，身份与通信可达性分别可查。当前为 approved / binding_pending，verification `implementation_pending`，目标 edge 仅为 proposed。

## R18 group角色与工作职责

用户已回复「确认 R18，职责按 group 身份声明」。master/peer角色归属于具体group成员身份，同一peer可在不同group持有不同角色；Planner、Reviewer、执行、巡检等职责也按group成员身份声明，可同时承担多项，职责声明本身不增加管理权限。有相应权限的用户可在WebUI修改角色和职责，角色变更按该group更新后续权限，撤销立即生效。普通恢复与更换执行会话沿用当前合法角色/职责。当前为 approved / binding_pending，verification `implementation_pending`。

## R19 身份切换与工作接续

用户已回复「确认 R19，按此入库和绑定」。任务归属明确稳定group成员身份；同身份换当前执行会话时，接续原未完成任务并保留引用、状态、证据和期限。切换为另一身份时使用新身份自己的工作归属，原身份任务保留并可恢复或明确重派。重派先邀请，新owner接受并提交后才改变归属，提醒随实际归属接续；旧执行者迟到结果交当前owner评估，不能覆盖提交状态或抢回任务。WebUI可查询当前归属与交接结果。当前为 approved / binding_pending，verification `implementation_pending`。

## R20 交接结果与失败恢复

用户已回复「确认 R20，按此入库和绑定」。身份、角色、任务、消息或提醒交接后，系统可查询实际生效关系、未完成部分和原始错误。部分失败明确显示partial或unknown；恢复先核对当前事实，只续接未完成效果。重试保持原操作关联，不重复转移任务、投递消息或创建提醒，不覆盖后续更新的身份/归属；可选显示或布局失败时，已生效身份与基础通信继续可用。当前为 approved / binding_pending，verification `implementation_pending`。

## R21 任务提醒与持久订阅

用户已回复「确认 R21，按此入库和绑定」。用户可为有权管理的目标或任务创建、查询、修改和取消提醒订阅，设置明确时间/周期、执行次数和有效期。提醒携带实际工作内容与引用，投递给该工作当前owner的有效会话；身份恢复、会话接替或daemon重开后保留订阅、进度、剩余次数和节奏。邀请未接受时仍归当前owner；取消/到期停止新触发，历史通知和回执可查，送达、消费和工作完成分别按证据呈现。当前为 approved / binding_pending，verification `implementation_pending`。

用户已追加回复「daemon 发送，但是注册时有 sender 和 receivor」。订阅注册时保存明确选择的稳定 sender 引用和初始 receiver 引用；daemon 是实际执行主体，不是业务 sender，也不把创建者或固定运营账号自动推断为 sender。每次触发前重新核验当前 sender 身份、当前资源权限和当前工作 owner。缺少明确注册事实时返回具体 unknown 或失败，不猜测默认身份。

用户对 Alice 注册工作正式转交 Bob 的追问已回复「跟随当前工作 owner：转交接受后发给 Bob，注册信息保留（建议）」。邀请未接受时仍投递给 Alice；新 owner 接受并提交后，只有尚未产生的后续新提醒改投 Bob。注册 sender 和初始 receiver 事实保留可查；已产生消息的原 ref、目标、期限和 attempt 不改写。

### R21 sender/receiver 执行图

执行图为 [reminder-occurrence.graph.json](../dagpipe/graphs/reminder-occurrence.graph.json)，版本 `0.3`。单一 tick 入口先恢复或 claim occurrence，再读取注册 sender/initial receiver 与当前 work assignment，分别核验当前 holder、sender 身份和资源权限，然后才按固定期限观察原 attempt 或提交新消息，最后持久结算并发布单一 outcome。

现有 reminder occurrence 测试覆盖 pending invitation 继续旧 owner、接受 assignment 后取新 owner、原 attempt/固定期限保持、撤权和缺 holder 阻断。它们未覆盖订阅中的 sender/initial receiver 注册字段，也未证明正式 daemon startup 或真实 agent 接收。因此 R21 sender/receiver 增量保持 `binding_pending` 与 `implementation_pending`；后续 owner 是 reminders sender/receiver 字段与测试、daemon formal composition、真实发送入口及独立验收。

## R22 巡检与管理范围

用户已回复「确认 R22，按此入库和绑定」。目标owner管理自身巡检，group manager管理本group职责范围，CEO跨group/workspace管理需明确授权。巡检检查目标进度、未清严重缺陷、实际子任务、交付gap和自有资源，并关联持续日志；周期巡检默认一批100次，间隔使用明确配置。恢复沿用原订阅和剩余次数，批次耗尽后仅按仍有效职责续订，目标完成或取消后停止触发。WebUI可查看配置、实际结果和具体错误。当前为 approved / binding_pending，verification `implementation_pending`。

## R16 正式可用交付与验收

用户已确认正式启动/配置、可访问WebUI和必要服务、安装使用/故障信息、独立两视口及真实两机组合验收、完整milestone一次整体审计和main集成后的入口核对。未过条款或缺必要证据须列交付gap。当前为approved / binding_pending，正式交付尚未完成。

阶段gate已实现，命令为 `pnpm run gate:r16 --phase <local|audit|delivered> --input <absolute-input-json> --evidence-dir <absolute-evidence-directory>`。执行图为 `r16-usable-delivery.graph.json`，最终operator为 `r16.publish_verdict`，实现为 `scripts/verify-v2-r16-delivery.mjs#publishVerdict`。local阶段核对正式入口和组合证据，audit阶段核对整体独立审计，delivered阶段核对main/适用CI及集成后入口。前两个阶段通过时整体仍为INCOMPLETE。

当前正式业务consumer适配尚未齐备。阶段判定正反用例通过只证明gate自身，完整业务绑定与正式组合仍待完成。当前批准集为R01–R16、C1/C2及R17–R22；这些新增条款尚未接入R16组合检查。实际交回为本任务 `r16-delivery-gate/result.md`，原始命令回执保存在同目录events.jsonl。

R04固定适配已直接调用 `validateR04Receipt`，核对正式URL、重开和R16独立前端执行来源，接线回执为本任务 `r16-r04-adapter/report.md`。真实正式产品证据以及其余必要业务adapter继续作为具体gap保留。
