# V2 跨设备消息与文件投递契约

David，2026-11-02。任务 zterm-v2-cross-device-delivery-infra；设计交回 Jenny 审收。跨设备消息和文件投递是 I2 必需基础设施。CLI、WebUI、宿主均消费同一 daemon 端口，不各自持有网络投递状态。本文不声明 V2 已实现。

## 1. 真源、复用和 DAG

依据：[任务合同](/Volumes/Intel/playground/zterm/.worker-runs/zterm-v2-cross-device-delivery-infra/task.md)、[V1 设计](/Volumes/extension/code/zterm/android/docs/decisions/2026-10-28-cli-cross-machine-messaging.md)、[V1 DAG](/Volumes/extension/code/zterm/android/docs/dagpipe/daemon-app-messaging.graph.json)、[I2 联调](../mvp/integration-plan.md)。

已读 V1 图：单输入 arc.request，经 validate→resolve→admit→prepare→execute→publish→settle 到单输出 arc.app_result，拓扑闭合。它绑定 CLI route/settle 和 V1 operator，不能当 V2 已有 gate。V2 补链设计为：公开请求→源授权/解析→持久受理→connections→目标授权/准入→目标持久收件或文件提交→宿主交付→回执投影→本次请求结果。成功、拒绝、失败、unknown 均汇入同一结果出口；后续恢复/消费是以 DeliveryRef 为输入的新操作，不画无限回边。Jenny 将其绑定现有受影响图与 gate，不在本次纯设计中造可执行空图。

| owner | 独占责任 | 禁止承担 |
| --- | --- | --- |
| accounts | 当前账号/机器/委托与 action/scope 授权、撤销 | 从 group 层级推导权限 |
| routing + members | memberId、目标 machineId、bindingGeneration 与 anchor | 物理连接和内容存储 |
| connections | 授权机器链路、通道、路径、代次、发送背压 | 消费状态、文件落盘、CLI 路由副本 |
| delivery | outbox/inbox、去重、回执、文件 staging/提交/续传、宿主派送 | terminal mirror 或 ticket done |
| host-adapters | 宿主正式入口、能力、可证实的投递/消费结果 | 穿透、远端文件传输、私建重试队列 |
| daemon | 组合公开端口与接收边界 | 第二份业务状态机 |

复用 V1 app protocol/store/gateway 的有效能力，经公开兼容 adapter 接入；不复制源文件形成第二套 store。消息文件 channel 与终端语义隔离。V1 /app 可以是显式兼容通道，不假称已接 terminal mux 或 RTC。

## 2. 身份与端口

```text
DeliveryRef = { sourceMachineId, workspaceId, actorAccountId, requestId }
Target = { memberId, machineId, bindingGeneration }
Envelope = { deliveryRef, target, kind:message|file, subject?, payload|fileSpec }
FileSpec = { safeName, totalBytes, sha256, chunkSize, chunkCount }
```

源 daemon 在受理前通过可信 AuthContext 填 actorAccountId；可读 machine.group.xxx 先由 routing 解析，不用裸名字作为去重键。DeliveryRef 唯一绑定不可变目标、正文或文件 spec。同键不同请求返回 DELIVERY_CONFLICT，不能覆写；不同账号/机器同 requestId 不串单。绑定换代不自动把已受理内容转给新会话，返回 TARGET_BINDING_STALE，由调用者明确重新投递。

```text
delivery.submitMessage(actor, targetAddress, requestId, message) -> Receipt
delivery.beginFile(actor, targetAddress, requestId, FileSpec) -> TransferView
delivery.writeChunk(actor, DeliveryRef, offset, bytes) -> TransferView
delivery.commitFile(actor, DeliveryRef) -> Receipt
delivery.queryReceipt(actor, DeliveryRef) -> ReceiptObservation
delivery.queryTransfer(actor, DeliveryRef) -> TransferView
delivery.subscribeInbox(actor, scope, cursor?) -> inbound events
delivery.ackInbox(actor, DeliveryRef, recipientRef) -> Receipt
delivery.confirmConsumed(actor, DeliveryRef, trustedHostEvidence) -> Receipt
connections.openChannel(LinkRef, kind=message|file|receipt) -> ChannelRef
connections.send(ChannelRef, frame) -> awaited wire submission
connections.observeLink(LinkRef) -> LinkObservation
host.capabilities(binding) -> supported kinds/receipt/idempotence
host.deliver(binding, DeliveryRef, message|localFileRef) -> HostReceipt
```

ackInbox 只证明本地收件接收，不等于宿主交付或业务消费。confirmConsumed 只接受已授权宿主确认来源，普通请求不能自报 consumed。文件提交后发同一 DeliveryRef 的 inbox 事件，宿主收到本机受控文件引用，不收到发送机绝对路径。download/readFile 需 delivery 文件读权限，经 daemon 端口读，不能绕过权限把绝对路径暴露给任意客户端。

## 3. 回执与 unknown

Receipt 分离事实进度和当前观察：

```text
Receipt { deliveryRef, target, durableStage, outcome, errorRef?, observedAt }
durableStage = accepted | remote-stored | host-delivered | consumed
outcome = pending | confirmed | unknown | rejected | failed
ReceiptObservation { receipt?, freshness:fresh|stale|unavailable, observedAt }
```

accepted 仅在源 daemon 已持久化 outbox 后发布。remote-stored 表示目标已持久收件；文件还必须完成字节与摘要校验及原子发布。host-delivered 需要真实宿主接收凭据；tmux send-keys 只到此阶段。consumed 需要宿主业务消费确认，不从屏幕、进程在线、ack 或 IM 通知推断。

阶段按证据单调前进；断线不撤销已证实阶段。响应丢失时保持已有 durableStage，同时 outcome=unknown，不能伪造 failed 可重试。源落盘前拒绝为 rejected，不产生远端副作用。目标拒绝在回执中保留具体错误和已发生事实；已完成的文件不会因后续宿主拒绝被谎称从未收到。

兼容映射：V1 received→remote-stored；V1 delivered/app-ack→本地接收确认，不能直接映射 host-delivered；V1 consumed 仅在消费确认来源绑定到目标成员且可信时映射，否则保留兼容证据而不升级 V2 阶段。V1 resultUnknown→outcome unknown。

## 4. 文件完整性、恢复和去重

文件内容协议保留 totalBytes 与 SHA-256；这用于实际传输完整性，不为设计、提交或候选建立哈希清单。本次不计算任何摘要。

1. 接收端先验证 FileSpec、当前权限和配额；原子预留本次总字节及 staging。拒绝非法尺寸、分块计数、路径穿越和同键内容冲突。只允许 safe basename，目标位置由 daemon 的 inbox owner 决定，wire 不接任意目标路径。
2. chunk 只按接收端协议声明的顺序/offset 写入。本期采用连续已持久 offset；相同 offset+相同字节幂等，冲突字节拒绝。只在数据和对应进度可恢复后确认 persistedOffset；内存接收或 socket 写完不算持久。
3. 完整接收后核对总字节、chunk 合同和 SHA-256；任一不符不发布最终文件、不发 remote-stored。临时 part 不向消费者可见。
4. commit 使用 V1 已有原子发布/恢复 owner。最终文件与记录之间的崩溃窗口用持久提交阶段恢复：存在且匹配则补记录，冲突返回 STORAGE_INCONSISTENT，不覆盖现存内容；不能把缺失 part 当作零字节成功。
5. daemon 重启后以同一 DeliveryRef 查询目标持久 offset/spec，重新授权并核对源内容仍符合 FileSpec，再续传缺失区间。源变更返回 SOURCE_CHANGED，要求新操作。发送端缓存 offset 不是真源。
6. 目标已完成则返回原 receipt，不再生成第二个文件或第二条 inbox 记录。回执丢失先查询，再在远端去重契约已协商的范围内重放同 ID；不生成新 ID 盲重试。
7. 宿主交付是独立副作用。崩溃发生在宿主调用后、回执落盘前时，如果宿主不支持按 DeliveryRef 去重/查询，保持 host outcome unknown，不自动再注入 tmux。daemon 收件去重不等于宿主 exactly-once。

去重保留窗口与 inbox/outbox 保留策略由 delivery 配置声明并在准入时返回；活跃传输和未知操作不能无声驱逐。已过可安全重放窗口返回 DEDUPE_WINDOW_EXPIRED，不把旧 ID 当新写入。清理只释放本 owner 明确终止/过期的资源并保留必要去重记录，不靠扫描日志恢复状态。

## 5. 双端授权、撤销与状态可获得性

源侧检查 message.send/file.send 的 workspace、目标 member 和机器范围；目标侧独立验证机器身份、调用账号/委托、目标当前 scope/binding。relay 登录、同账号目录或 manager 上下级关系都不能替代目标授权。peer 不能借此越过组织对外边界，跨 group 出口仍按已授权 manager 路由。

错误机器身份、错凭据、过期/撤销 grant 明确拒绝。已有连接不固定永久权限：目标准入、续传、提交、宿主派发、文件读取和 receipt 查询均验证当前权限。撤销后停止未提交的传输和新派发，partial 按 owner 策略保留或清理；已提交事实不抹掉，但撤权者不能读取正文或文件。授权真源不可获得且不能证明当前有效时拒绝新的受保护动作，不把旧缓存当授权。

状态查询不依赖读取 TUI，也不要求正文通道活跃。连接不可达时本端仍能查询已持久操作，标 stale/unknown；没有记录为 unavailable 或经授权的 not-found，不能报“已完成”或“无待办”。拒绝访问不能回退缓存正文。

## 6. 链路、限流与背压

同一授权机器链路承载 message/file/receipt 逻辑通道，复用 accounts 授权和 connections 握手；“同一链路”是 LinkRef 抽象，不要求不支持复用的 V1 /app 强行变成 terminal mux。物理复用必须先协商能力，缺少能力返回 UNSUPPORTED_CHANNEL，不能跨协议裸发帧。

LinkObservation 包含 machineId、generation、state、observedAt、path=direct|relay|unknown、transportKind。direct/relay 仅来自实际建链结果；目录中存在 relay 候选不证明已走 relay。新代次丢弃旧回调。换路仍使用同一 DeliveryRef；只有在接收去重/恢复条件满足时才继续，不对鉴权拒绝换路绕过。

准入限制按每来源、每目标及 daemon 总量配置最大活跃传输、队列条数、待存字节和磁盘预留。已持久收件、文件和 staging 均计入额度，同键重放不重复扣额。超限返回 ADMISSION_REJECTED 和可查询原因，不先 accepted 再静默丢弃。

connections 公开 queuedBytes/bufferedBytes/backpressured 的 typed observation；每次 chunk dispatch 前检查当前 generation 与背压，并 await send。OPEN 拥塞不等于断线，不无条件重连。delivery 使用有界待发数据，不将整文件无限堆入内存。慢消费者只隔离对应 subscriber，持久 inbox 保留且可按 cursor 重放，不关闭其他 peer 链路。receipt/控制请求应可调度，但共享物理通道不承诺已证明低延迟；I2 实测持续文件发送期间状态返回正常结果或明确 typed unavailable，不无限悬挂、不伪造在线。

relay 的离线持久队列不是已验证能力，首期不依赖它。离线恢复由发送/接收 daemon 的持久记录负责。V2 必须定义 direct/relay 同语义接口并验对应可用路径；未接通 relay 的候选只能报告 direct 子增量，不能宣称完整穿透交付。

## 7. 模块增量与执行切片

| 模块 | 在现有目录中增加/明确的职责 | I2 交付行为 |
| --- | --- | --- |
| connections | public/link-port 的 message/file/receipt 通道与发送背压；adapters/app-websocket 的显式兼容映射；channels/dispatch 的能力协商 | 两机机器身份确认、真实路径、慢消费者与旧代隔离 |
| delivery | public/delivery-port 增加文件与收件端口；domain/file-transfer；application/file-transfer；ports/transfer-store；现有 receipt-store 持有去重与操作结果 | 两向消息/文件、持久offset、原子发布、重启恢复、unknown不误重发 |
| host-adapters | public/host-port 声明 message/file-ref、consumeEvidence、idempotentDelivery 能力；各既有 adapter 按能力接入 | 目标当前binding校验，已落盘文件引用交宿主，真实host-delivered与consumed区分 |

职责名不要求建立无消费者空文件。实现顺序：V1公开能力兼容→V2授权/DeliveryRef与状态映射→文件恢复→真实宿主派发→两机direct/relay组合。账号、组织等 owner 可以并行开发；只在具体接入边上等待契约。

## 8. 证据迁移和验收

| 可复用事实 | 证据 | 限制/新增 gate |
| --- | --- | --- |
| PR #185 d570e0c7 两物理机双向消息/文件、字节及摘要、接收daemon重启offset续传 | [two-machine-1](/Volumes/Intel/playground/zterm/.worker-runs/cli-cross-machine-messaging/two-machine-1/run.md) | 目录为隔离 stub，不能证明V2权限或生产relay数据面 |
| 公共 CLI 0.1.5/daemon 0.1.4 两机投递、重启去重；本地门禁覆盖slow consumer/准入/unknown | [复验报告](/Volumes/Intel/playground/zterm/.worker-runs/cli-delivery-verify-1031/verify.md) | 此次两机重启后重试不等于中途chunk恢复；不要与前项混淆 |
| CLI 0.1.6/daemon 0.1.5 两机消息 received、文件匹配；有序多端点接入 | [项目发布记录](/Volumes/extension/code/zterm/android/docs/goals/zterm-project-master-standing-goal.md)、[CLI入口](/Volumes/extension/code/zterm/packages/cli/README.md) | 使用明确版本段，不采用同文旧latest段；本文引用已记录结果，未重跑安装/网络 |

V2 I2 必验：两实际机器双向消息原文和文件完整性；断连/接收daemon重启后续传；commit响应丢失同ID去重；同ID不同内容拒绝；错误身份/双端撤权（含传输中撤权）不落盘发布/不派宿主；额满不重复预留；慢消费者不影响其他成员；目标换绑定不误投；宿主结果不确定不再次注入；direct与relay各记实际路径及缺失能力。正反例从正式V2公开端口进入，复用未变V1证据，不以旧CLI PASS冒充V2组合PASS。

## 9. 单 writer 迁入映射

| 本设计包输入 | Jenny 管理的正式目标 | 动作 |
| --- | --- | --- |
| 本文 | v2/docs/interfaces/cross-device-delivery.md | 迁入唯一跨模块契约；修正相对链接 |
| module-designs/connections/DESIGN.md 的新增引用 + 本文§7 | v2/modules/connections/DESIGN.md | 当前owner合并端口与I2增量，不覆盖活动编辑 |
| module-designs/delivery/DESIGN.md 的新增引用 + 本文§7 | v2/modules/delivery/DESIGN.md | 合并文件职责/恢复与receipt边界 |
| module-designs/host-adapters/DESIGN.md 的新增引用 + 本文§7 | v2/modules/host-adapters/DESIGN.md | 合并能力和宿主确认边界 |
| zterm-v2-integration-plan.md 的新增I2引用 | v2/docs/mvp/integration-plan.md | 将消息/文件作为I2必需验收 |

架构Skill和模块总表链接本文；Jenny迁入后以正式文档为唯一维护源，旧交接包停止更新。V1证据保留原位置，以链接和适用范围复用，不复制大量日志。无源码修改、设备访问、生产重启或新运行门禁执行。
