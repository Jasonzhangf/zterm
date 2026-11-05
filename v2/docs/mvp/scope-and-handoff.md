# Zterm V2 第一版 MVP 与执行交接

状态：用户已定范围；本文是 David 的概要设计和派单依据，不是实现完成或 UX PASS。Jenny 负责实际派单、工作区、AppSDK、DAGpipe 和集成。David 负责总体设计和审计。最新要求优先于旧文档的“尚未定义 MVP”。

## 1. 可交付行为

用户从 WebUI 完成初始配置、登录、登记/选择机器、建立 workspace/group、配置成员与启动参数，在一个工作台查看本地和远端真实 TUI。用户能保存布局并切换突出显示的成员。页面覆盖账号连接、组织配置、sessions、board/ticket 和错误状态。没有实现的功能明确禁用并说明原因，不显示模拟成功。

跨设备是实际不同机器间访问，验收必须包含不同网络或经过 relay 的场景；同机不同端口不替代。group 能包含同机成员或不同机器成员，读取层级、成员定位和投递均保持同一语义。

第一轮建议实现同账号多机器；跨账号机器共享是否进入第一轮尚未由用户明确，禁止默认为任意账号可连接。权限接口必须保留，跨账号功能未实现则明确禁用。此范围选择由 Jenny 在执行计划中显式列出，不能隐式缩减跨机器要求。

Android/macOS/Windows/Linux 保留独立模块设计与源代码归属；首期交付 WebUI，不因此要求同时交付四种 native 客户端。ACP、自动化巡检、全产品一键恢复和无停机升级可后续实现。手机 Web 必须保留竖屏焦点、画布缩放平移和 workspace 快捷切换的设计。

## 2. 最小架构决策

- 每个 workspace 有一个配置的 authority daemon，独占组织写入；其他 daemon 提供远端成员运行事实。MVP 不做多主离线写入。authority 不可达时只读缓存标为 stale，修改明确不可用。
- 组织记录使用 workspaceId/groupId/memberId 稳定标识。group 的 parentGroupId 形成树；同父 group 的名字唯一。可读地址 machine.group.path 通过 routing 解析，不能充当权限或稳定存储键。
- 成员记录关联 groupId、name、machineId、hostKind、agentKind、launchProfileRef；运行绑定独立保存 sessionId、anchor、bindingGeneration。端点变化不重建成员。
- workspace 连接先用显式挂接：在新父 workspace 引用原 workspace 的 manager，原 workspace 保留 authority、ID、ticket 关联和 ACL。拒绝环和重名；挂接不扩大权限。破坏性数据合并不进入首轮。这是建议语义，详细设计审计需确认。
- 新建组织的配置写入只由 authority 提交。远端启动为另一条可查询操作：配置成功而启动失败须分别显示，不能回滚为假消失或报整体成功。
- WebUI 通过 daemon 业务接口访问。账号 relay、ticket 后端不向浏览器暴露服务器管理凭据。机器链路直连或中继不改变目标 daemon 的鉴权。
- terminal 沿 V1 source/mirror/publisher/buffer/renderer 复用。布局仅属于 WebUI；拖窗格、换焦点不重建连接。宽度只经既有正式 lease 接口处理。

## 3. Jenny 可分派的执行包

| 执行包 | 独占范围 | 依赖及输出 |
| --- | --- | --- |
| 工作区及治理 | 正式 V2 根、AppSDK、DAGpipe、项目入口 | Jenny 负责；把设计稿迁为唯一真源，登记真实 owner；图无实现时不能报行为 PASS |
| 账号与连接 | accounts / connections | 先明确公开身份、目录、连接契约，再独立实现；证明两台真实机器授权连接及拒绝路径 |
| 组织与 daemon | organization / members / routing / delivery / daemon | 依赖身份和连接契约；本地 group 可先验，远端接入后同入口组合验收 |
| 宿主与 agent | host-adapters / agent-adapters / terminal 接入 | 首期 tmux + 已确认支持的 TUI；不同产品声明实际能力，不以粘贴完成当任务完成 |
| WebUI | webui | Emma 修订设计并送 David 审计；可先按已审接口构建完整页面，真实操作待基础接入 |
| Ticket 适配验证 | tickets 的 Vikunja adapter | 先验证选定版本的 API、权限、重试和映射；通过后接 board；不把选型稿当兼容证据 |

Jenny 根据当前 idle/busy 和 owner 派单，不按历史名字推定空闲。独立包可并行，但共享接口变更先交 David 对齐。peer 负责合同内实现、自检、行为证据和交回；执行 worker 使用 GCM。David 不接管上述执行或治理动作。

每份合同列出目标、允许路径、禁止路径、依赖版本、真实入口验收、报告位置和停止条件。不得只发送聊天摘要。接口缺失只停依赖该接口的工作。

## 4. MVP 验收与审计入口

1. 新用户打开完整 WebUI：初始配置、账号/连接、workspace、group、sessions、board/ticket 可导航；不可用动作明确标识。
2. 本机建立 group，两个成员名字冲突被拒；不同 group 同名可以存在。启动后按稳定成员查询当前绑定。
3. 两台真实机器建立连接；远端成员加入同一 group，显示真实 TUI并接受允许的输入。无权限请求被拒。网络断开显示 stale/offline；恢复不重复创建成员。
4. 调整布局、突出任意 peer、保存后重新打开；角色不变，session 不被终止或重复启动。手机焦点恢复可读竖屏。
5. 连接两个 workspace 后层级正确、ID/权限不变；若本轮未实现连接 UI，必须明确列为缺口，不能声称覆盖该需求。
6. Ticket 后端获准接入后，从创建、派发、报告到关闭可追踪；board 按目标查询自己任务的前五项。成员状态独立展示，打开巡检才读取内容。
7. daemon、relay 或 ticket 服务失败有可查询错误；accepted/delivered/consumed 与任务 done 分开。报告未知状态，不伪造完成。

David 审计设计边界及完整 milestone 的交付证据；Jenny 维护 gate 并执行集成。既有 UX r1 NOT PASS 项（子 workspace 提交、合并输入、成员唯一性）须有修正证据。纯文档交付仅做链接和一致性检查，不新增无运行路径的 DAG。

## 5. 正式落盘合同

正式根由总设计师决定为现有 zterm 仓库内 v2/，见 [正式根决策](../decisions/product-root.md)。不再等待用户/CEO 选择仓库方案。Jenny 按现有 zterm LayerFS 项目建立独占工作线，运行环境未就绪与架构选型未定必须分开报告。

当前设计包位于本文件所在目录。Jenny 迁入 V2 正式 docs/ 后修正引用，旧包作为交接材料停止维护。foundation-modules 中每个 modules/<name>/DESIGN.md 与 src/ 是目标结构；不能用空 src 目录宣布模块完成。

将 skills/zterm-v2-architecture/SKILL.md 纳入正式项目 .agents/skills/zterm-v2-architecture/SKILL.md，并在 V2 AGENTS.md 的路由中引用。它只约束新产品 V2，不替换 V1 的 terminal/mobile/windows 技能。迁入后的文档链接必须可解析；不安装全局 Skill。
