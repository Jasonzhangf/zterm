# V2 联调计划：真实基础能力到完整MVP

设计状态，未执行。关联[模块总表](module-execution.md)与各模块DESIGN。Jenny负责任务、运行环境、DAG/gate和集成；David审计契约与完成的可交付增量。

## 顺序与环境

I0→I1→I2；I3可在accounts/organization/goals/tickets基础端口具备后独立推进并与I1组合，不必等全部I2传输；I4汇合I1/I2/I3与最新UX。errors和版本能力最小契约从I0注入。

采用独立测试账号、Vikunja project、开发daemon及明确自有tmux session。每合同填实际机器、端口、工作线、进程归属及清理终点，不使用生产账号数据。Mock只支持并行开发，不计真实联调通过。Linux机器daemon参与MVP，不等同四平台native客户端交付。

## I0：Web到真实终端

链路：WebUI→daemon API→host-adapters/terminal公开端口→真实tmux→wterm consumer。host输入与终端渲染是不同owner。
- 前置：Grace现有bootstrap独占工作线、开发鉴权、真实目标。复用现有任务。
- 正例：打开既有会话→输入可识别文本/命令→读回真实结果→刷新再次访问同一目标。
- 反例：错误目标/凭据、unsupported host明确失败，不写到其他会话。
- 生命周期：基础读写可先交证据；停止正文/隐藏/恢复的相关验收须等terminal冲突定界，不能用常开订阅规避。
- 证据：实际task Workspace内v2/evidence/<task>/integration/I0/，保存公开入口操作、脱敏daemon结果、真实TUI截图或输出。

## I1：本地组织、绑定与投递

链路：AuthContext→organization→members Binding→routing→delivery→host→receipt/status→WebUI/CLI。
- 前置：I0相应能力，单authority提交语义与授权明确。
- 正例：建workspace/group→配置两个成员→绑定/启动受支持session→按名字投递→查分阶段回执。
- 反例：同父重名、歧义地址、旧binding generation、越权拒绝；tmux写入不标agent消费。
- 挂接：合法引用重开后关系保持；祖先反挂拒绝；ID/ticket/权限不变。配置成功与启动失败分开显示。
- 证据：integration/I1/，公开请求响应、重开结果、权限及旧代反例。

## I2：跨机器group

跨设备消息与文件投递是本增量的必需基础设施，详见[接口及证据映射](../interfaces/cross-device-delivery.md)。两机双向消息/文件、字节与SHA-256、重启续传、去重/冲突、双端撤权、背压、direct/relay路径及宿主unknown均按该契约验收；CLI只是消费者，V1已验部分与V2组合分开记录。

链路：accounts目录→connections候选/握手→source daemon→target daemon授权/绑定复核→remote host→回执/状态。
- 前置：两台实际机器；先LAN增量，再实际不同网络direct/relay能力。不能用同机多端口代替。
- 正例：同group本地与远端TUI/投递；独立状态查询；记录实际路径，非仅目录候选。
- 反例：错误账号/目标身份、撤销后新操作拒绝；不可达端点不能报connected。
- 断线：远端stale/unknown，其余机器继续；恢复保留memberId，旧socket/旧binding回调不污染新状态。
- 拥塞：持续正文/文件时查询状态，记录真实结果或在声明时间界限内typed unavailable；共享背压不证明优先级。实际失败需要时才改调度。
- 证据：integration/I2/，两机环境、路径、权限与断线时间线，脱敏且保留关键原错。

## I3：目标、票、报告与Board

链路：actor/scope→goals→tickets/Vikunja→TicketBinding→board/status→WebUI属性面板。
- 前置：Vikunja v2.7.1隔离实例、受限凭据、Frank详细设计审计通过。
- 正例：目标下创建票→分派→追加报告→关闭/重开；每目标前五项正确。样本含多个目标、同优先级和超过五项。
- 反例：跨workspace读/评论拒绝、token失效明确；scope/goal过滤先于排序截取。
- 非幂等：请求已发出但响应丢失时操作unknown；验证没有自动第二次POST。没有可靠关联时显式待核实，不强求首期自动对账成功。
- 服务离线：缓存标stale；未发出写明确失败，已发出未知写不能假报可重试。IM不是状态真源。
- 证据：integration/I3/，脱敏HTTP、UI投影、重复POST观察与查询样本。provider基础证据复用。

## I4：完整MVP

完整初始化、账号连接、组织、sessions、board/tickets页面。未实现动作明确禁用。
- 桌面重点窗格按比例，其余同网格连续，无固定五窗上限，整体滚动到末尾；直接拖边、一行标题、窗下board/bug属性。
- 手机多窗选择后单主屏；上下成员切换不抢终端历史滚动；workspace快捷切换和布局保存恢复。
- 角色不随布局改变，session不被启动/关闭，健康共享连接不重建。失效身份按认证路径处理。
- 错误可查owner/操作，局部可选失败不崩服务；必要协议不兼容显式，无静默fallback。
- 证据：integration/I4/最新真实组合入口与必要截图。完整milestone作者自检后David审计，Jenny集成发布，不用设计PASS冒充实现。

## DAG与执行记录

member-delivery/member-status当前design-unbound图可复用拓扑输入，不能冒充运行gate。I0标V1 consumer边界；I1组织提交、I2连接恢复、I3provider写入分别补schema/operator和闭合结果。成功/拒绝/失败/unknown可观测。Jenny落实，不每文件造gate。
I3正式执行图：`v2/docs/dagpipe/graphs/goals-tickets-board.graph.json`（`goals.tickets.board@0.1`）。静态校验通过不替代真实入口、actor映射和Vikunja v2.7.1验收。

每任务填实际绝对证据路径。大型日志截图留任务附件，v2/docs/mvp/acceptance.md只引用有效结果；回收Disposable Store前交到可靠载体。接口/配置/实现未变的有效证据复用，失败只停真实下游，不以“所有模块还没完成”阻断集成。
