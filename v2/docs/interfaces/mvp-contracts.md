# MVP 跨模块接口概要合同

David，2026-11-02。供 Jenny 将分包计划细化为独占执行合同。状态：设计提案；类型名说明语义，未锁语言、REST 路径或传输编码。正式根选址不影响本合同讨论，产品实现仍沿正式工作线与审计准入。

## 1. 唯一归属与公开端口

| Owner | 公开能力 | 结果及边界 |
| --- | --- | --- |
| accounts | register/login/logout/verifySession；enrollMachine/listAuthorizedMachines/grant/revoke | 返回 AccountRef、MachineRef、经验证 AuthContext；不返回可被任意改写后信任的 actor JSON；原始凭据不进入组织或 ticket |
| connections | connect(targetMachineId, authorization)/openChannel/observeLink | LinkRef、协议能力、链路状态与 typed error；机器身份须与目标一致，已发布端点不等于连接成功 |
| organization | createWorkspace/createGroup/addMember/mountWorkspace/queryTree | WorkspaceRef、GroupRef、MemberRef、revision；唯一 authority daemon 提交，挂接拒环/同父重名，组织层级不扩权 |
| members | configureLaunch/bindSession/launch/restore/queryBinding | 当前 Binding 与 OperationRef；稳定 memberId 不随 sessionId 改变；恢复支持程度由 adapter 声明 |
| routing | resolve(workspaceId, readableAddress) | 唯一 memberId、machineId 与当前 bindingGeneration；零匹配/冲突/旧绑定显式返回，不以裸名字全局广播 |
| delivery | submit/getReceipt/subscribeReceipt | DeliveryRef；受理、交宿主、消费确认分别有证据，未获宿主消费证明保持 unknown；不自动关闭 ticket |
| host-adapters | capabilities/deliver/observe | 宿主正式端点及实际可得结果；tmux 输入不冒充模型消费，DSH/桌面桥接不假装 tmux |
| agent-adapters | capabilities/start/resume/observeSession | agent session 与恢复能力；unsupported 明确，ACP 后续实现同一能力边界 |
| terminal | attach/read/subscribe/input/requestWidth | 消费 V1 公开端口；mirror/buffer/renderer 归属不变，布局不拥有 resize 或重连策略 |
| tickets | create/get/list/appendReport/close/reopen | provider 真实结果和 TicketBinding；已选 Vikunja v2.7.1 /api/v2，API证据已接受，adapter未实现；详细设计见 tickets-module-design |
| goals / board | goal CRUD / queryManagerBoard | 目标与 ticket 分开；board 仅查询投影，无第二份任务完成状态 |
| status / errors | query/subscribe 与 recordError | 状态聚合带来源、新鲜度；错误保留因果链及 owningModule，恢复由对应 owner 决定 |
| daemon | expose/compose 上述业务端口 | 组合与机器级入口，不重写各模块权限、状态机或存储；所有成员投递经本端/目标 daemon |

同一 peer 可接一个组合包，但每个物理模块仍各有 DESIGN.md/src/tests；不能将 accounts+connections 合成一个包内大模块。goals、board、status、errors 的实际负责 peer 由 Jenny 在派单前补齐。平台模块暂不实现 native App，不免除其独立设计归属。

## 2. 最小类型语义

- ResourceRef：稳定 ID 与资源种类；可读 name/path 是可变显示字段。MachineRef 不使用 IP 作为 ID。
- AuthContext：经信任边界验证的账号、调用范围、凭据有效性和授权版本引用。跨机由接收端验证其来源与有效性，不能信任请求正文自报 accountId。机器身份不替代调用用户身份。
- Binding：memberId、machineId、hostKind、agentKind、sessionId、anchor、generation。替换绑定须比较预期 generation；旧投递不得落到无关的新会话。
- OperationRef：operationId、owningModule、state（pending/succeeded/failed/unknown）、errorRef。组织配置成功与远端启动失败分别保留，不伪装整体成功或自动删配置。
- DeliveryReceipt：deliveryId、targetMemberId、bindingGeneration、acceptedAt、hostDeliveredAt、consumedAt（仅有证据时）、errorRef。IM 通知不是 ticket 真源；消费不是任务完成。
- Observation：subjectRef、source、observedAt、freshness、value。断线后的最后已知值可保留，当前 unknown 不计空闲。
- ErrorRecord：code、owningModule、operationId、cause、retryDisposition。调用者只按声明处理，不由错误中心统一重试。

上述是接口语义最小集，字段按真实消费者确定，不强制每个调用都携带无用途元数据。安全令牌和登录 session 不与 agent session 混用。

## 3. Authority 与写入

每个 workspace 的组织配置指定一个 authority daemon。远端成员由其所在机器 daemon 管运行绑定与状态；组织成员归属和运行绑定互相引用，分别拥有写入权。authority 不可达时可显示 stale 只读投影，首期不接受多主离线组织写入。

workspace 挂接为父层保存源 workspace/manager 引用。保留源 authority、成员稳定 ID、ticket 关联与 ACL。跨 owner 挂接先验证源暴露/引用权限，父层写入才发布成功；不能用创建父层本地成功宣称远端授权成立。未接入原子跨机事务时不承诺原子远端启动，返回可查询部分结果。

默认建议首期同账号多机器，跨账号共享仍待范围决定。现有 V1 只有同账号目录/信令；执行合同不得把未实现跨账号权限当已支持。注册策略、授权有效期、撤销与存量通道行为须在 accounts DESIGN 中定明后才实现对应路径。

## 4. 两个组合链路

连接/投递：已认证调用 → organization 授权范围 → routing 解析稳定成员和绑定 → delivery 受理 → 本地 host 或 connections → 远端 daemon 验证身份/权限/绑定代次 → host-adapter → 可获得的 receipt → 状态查询。每处错误回到 owningModule，不用读取 TUI 推断完成。

Ticket/board：已认证调用 → tickets 范围检查 → provider adapter → provider 确认 → TicketBinding/目标引用 → board 按 manager 范围查询。优先级在 owner 统一规范化；前五项口径见 UX 的每个目标下前五项，不能变成全系统五项后过滤。创建超时未知先核对，不盲重试造重复票。

DAGpipe 正式图与 gate 由 Jenny 按上述对象流落地。现有 design-unbound 图仅作设计输入，不是可执行 gate。账户、链路、组织和投递分别验证基础，再验组合；不通过追加快照/hash 包装代替行为。

## 5. 开工依赖和验收

- 账号与连接先对齐身份/目录/授权端口，组织与适配器可据稳定接口分别推进设计；不必等账号所有功能完成才开始宿主适配。
- 本地组闭环依赖 organization、members、delivery 与真实 tmux adapter；跨机组再组合 accounts/connections 与远端 daemon。
- WebUI 可在明确的模拟接口下开发页面，演示状态必须显式；只有接入真实服务并验收才标可用。
- Ticket 版本/API 基础验证已接受，Vikunja 是架构选定后端；project scope、真实超时恢复和正式 adapter 仍须验收，不冒称用户逐项指定。详细设计审计见 zterm-v2-tickets-design-audit-r1.md。
- 大屏一加四仅是默认比例，不限制成员数量。最新交互范围见 zterm-v2-ux-vertical-review-contract.md；R5已退回，历史 PASS 不覆盖新增交互。

最低组合验收：两台实际机器的授权连接与越权拒绝；本地/跨机同一 group 的真实 session；断线显示陈旧并恢复；旧绑定不得误投；挂接拒环且刷新后关系一致；ticket 写入失败不假成功；board 不泄露其他 scope；布局切换不重建会话。Jenny 为每包指定具体公开入口、测试环境和证据位置，不能只写“真实入口验收”作为合同内容。
