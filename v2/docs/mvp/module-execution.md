# V2 模块设计、开发与联调总表

David 维护本唯一进度索引与架构接口；Jenny 负责本地组合、publish、Git 同步与执行资源协调。更新于 2026-11-03。模块作者交事实与证据，不另复制进度总表。设计、候选代码、真实行为与集成交付分别记录。

## 正式目录与首跑路径

- 产品根 `v2/`；模块根 `v2/modules/<name>/`，各自包含 DESIGN.md 与实际 src/tests。目录存在不证明能力完成。
- [架构](../architecture.md)、[模块边界](../module-boundaries.md)、[接口](../interfaces/mvp-contracts.md)、[交接范围](scope-and-handoff.md)。旧 `module-designs/` 相对链接已退役。
- 第一轮依次验证：WebUI 正常入口 → 本机真实终端 → 跨机器连接 → 本地/跨机器组织。Delivery 与这些模块并行开发；每条链只等待其实际依赖，不全局串行等待。
- 用户预览入口由 Jenny 维护在 `http://127.0.0.1:8801/`。它不是完整后端验收入口；未接端口必须明确 unavailable。Board/Tickets/Sessions 均位于所选 workspace 内，全局区只承载账号/连接/配置；手机与桌面自动适配。
- 终端链：WebUI client → V2 HTTP/SSE facade → terminal V1 WS/mux adapter → V1 mirror/publisher → tmux；完整帧经公开 buffer consumer → released wterm。不得以直连 tmux 或文本占位替代。

## 模块、责任与下一可用增量

| 模块设计/源码根 | 当前事实与缺口 | 执行 owner | 下一动作与联调 |
| --- | --- | --- | --- |
| [accounts](../../modules/accounts/DESIGN.md) | 真实 relay 注册/登录/验证/空目录子链有证据；enroll、possession、远端撤销仍缺 | Frank；relay 扩展由 Jenny 指定唯一 owner | 保留子增量；接真实机器身份与非空双账号隔离，不另建账号库 |
| [connections](../../modules/connections/DESIGN.md) | 本地 socket 握手候选存在；通道能力/隔离、旧代失败和失败资源关闭 finding 待新交付 | Jenny 持目标、独占 GCM | 修原 finding，组合真实 V1 endpoint；两机 direct/relay 尚未验收 |
| [daemon](../../modules/daemon/DESIGN.md) | bootstrap HTTP/SSE facade 有真实终端候选证据 | Grace bootstrap；Jenny 组合 | 与最新 WebUI 组合鉴权及失败无副作用；不增加第二 mirror |
| [host-adapters](../../modules/host-adapters/DESIGN.md) | 既有 V1 基础可复用；权威 host 身份与完整恢复尚未验收 | Grace 已有切片；其余 Jenny 派发 | 向 members 提供公开身份/恢复端口，运行存在性不冒充机器所有权 |
| [agent-adapters](../../modules/agent-adapters/DESIGN.md) | 设计边界存在；各宿主 start/resume 未交付 | Jenny 待派 | 按当前宿主能力逐项接入，ACP 后续；不虚构一键恢复 |
| [organization](../../modules/organization/DESIGN.md) | CRUD/唯一名/授权/mount 拒环模块候选已接受；产品组合待验 | Frank；Jenny 集成 | 与 members/routing 组合，展开 mount 时重新授权源 workspace |
| [members](../../modules/members/DESIGN.md) | 运行配置与绑定同源 reader、单调 generation 模块候选已接受；真正 host 身份/恢复仍缺 | Grace；Jenny 集成 | 保留组织结构与运行配置分离，验证换机旧代拒绝 |
| [routing](../../modules/routing/DESIGN.md) | 12eec3e5 扫描授权与结果字段 finding 已关闭；Jenny 报告本地 publish，任务候选记录修正中 | Jenny + GCM | 组合实际 organization/members readers；任务元数据错误不重开代码 finding |
| [delivery](../../modules/delivery/DESIGN.md) | domain/ports/application 已有候选；真实 facade 已可消费，adapter 正在执行 | David 唯一 owner，独占 GCM 执行 | 先 durable accept/query、重放/冲突/旧代/授权/重开与完整 errorChain；后续真实跨机消息及文件投递 |
| [terminal](../../modules/terminal/DESIGN.md) | R2 follow-up 有真实 V1 mux、输入、刷新、双订阅证据；帧修复/关闭/公开导入仍有局部问题 | Grace | 修局部问题后本地组合最新 WebUI；保留有效真实链证据 |
| [webui](../../modules/webui/DESIGN.md) | Emma shell 已修 workspace 导航与数据隔离；重复筛选、可读性和静态一致性待返工验收 | Emma；Grace 仅 clients/terminal 切片 | 同视口对照批准原型；按 workspace 查询/写入/深链/迟到响应隔离 |
| [goals](../../modules/goals/DESIGN.md) | 目标与 ticket 分离已定；真实 CRUD 未验收 | Jenny 待派 | 接授权组织与目标持久层后组合 Board |
| [tickets](../../modules/tickets/DESIGN.md) | Vikunja v2.7.1 /api/v2 设计与 API 基础已验；产品 adapter 未交付 | Frank 设计；Jenny 派实现 | workspace/goal 映射、权限、报告和工单真实闭环 |
| [board](../../modules/board/DESIGN.md) | 静态呈现有基线；真实查询投影未验收 | Jenny 待派 | workspace 内按 manager 显示目标、优先票据与成员状态，巡检时展开内容 |
| [status](../../modules/status/DESIGN.md) | bootstrap observation 切片存在；全系统状态聚合未验收 | Grace 已有切片；Jenny 后续派发 | 保留 freshness/unknown，聚合真实模块状态 |
| [errors](../../modules/errors/DESIGN.md) | typed error 切片存在；V1 facade 新 errorChain 可接 | 各边界 owner；Jenny 组合 | 统一 cause/report 接入；不新建第二错误库或假引用 |
| [cli](../../modules/cli/DESIGN.md) | V1 remote CLI 可复用；V2 正式命令未交付 | Jenny 待派 | 通过 daemon 公共端口验证，不私读模块库 |
| [upgrades](../../modules/upgrades/DESIGN.md) | 独立升级与兼容设计；执行器未交付 | Jenny 待派 | 本 MVP 不增加热升级要求 |
| [android](../../modules/android/DESIGN.md) | V2 native 未交付；本阶段手机由 WebUI 负责 | Jenny 后续派发 | native 行为另走产品真机门禁 |
| [macos](../../modules/macos/DESIGN.md) | V1 壳可参考；V2 独立客户端未交付 | Jenny 后续派发 | WebUI 后续封装，当前不冒称客户端完成 |
| [windows](../../modules/windows/DESIGN.md) | V1 alpha 可参考；V2 独立客户端未交付 | Jenny 后续派发 | 后续真实客户端验收 |
| [linux](../../modules/linux/DESIGN.md) | 远端 daemon 目标属于跨机验收；V2 GUI 未交付 | Jenny 组合/后续派发 | 纳入真实机器链，GUI 后续 |

## 当前执行与证据入口

- Delivery：branch `zterm-v2-delivery-adapter-1103`，workspace `4:/workspaces/1`。由原 delivery 与公开 V1 persistence 候选无冲突组合。独占 GCM PID 78151、exec session 45392；实际完成以 result 与行为证据为准。合同、events、stderr、result 位于 `/Volumes/Intel/playground/zterm/.worker-runs/zterm-v2-delivery-impl-1103/adapter-exec/`。
- V1 facade：`@zterm/android/app-messaging-persistence`，候选 1242ffe6 已关闭错误 cause finding。实现 owner Frank；错误链必须完整消费，实例内引用不能冒称全局持久 ID。真实 consumer 证据在 `/Volumes/Intel/playground/zterm/.worker-runs/zterm-v1-app-messaging-persistence-1103/`。
- 架构局部问题与已关闭结论：`/Users/fanzhang/.codex/visualizations/2026/11/03/01a19f39-e33f-71a3-9f14-187160a43203/zterm-v2-review-readiness-1103.md`。该记录不替代本表进度，不是最终 milestone Review。
- 终端真实链证据在 bootstrap 候选 `v2/evidence/zterm-v2-bootstrap-1103/rework-r2f/`；WebUI fixture 只证明界面交互，不证明后台组合。旧 I0 直连 tmux 结果不能覆盖 R2 边界。

## 联调与交付顺序

每个 milestone 明确用户可用行为和真实入口。独占工作线开发及本地 CI → Jenny 串行本地 publish → 组合 CI/真实 E2E → 架构师统筹一次独立整体代码/架构审计 → finding 修复及受影响回归 → Jenny Git 同步/push/PR/GitHub CI/合并。开发接口检查不变成最终审计前置门禁。

本表不声明整个 MVP 已可用。跨机器消息/文件投递、完整账号机器登记、实际组建与 Board/Tickets 后端仍须按各自真实链交付。无变化证据复用；只有相关实现、接口或输入变化才重验。

