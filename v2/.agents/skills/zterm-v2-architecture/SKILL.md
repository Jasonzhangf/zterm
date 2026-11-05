---
name: zterm-v2-architecture
description: 设计、实现或审计新产品 Zterm V2 的独立模块、跨机器 group 和 WebUI；明确状态归属与执行边界，不用于旧 Android runtime-v2。
---

# Zterm V2 工作入口

这是项目 Skill 交接源，由 Jenny 迁入正式 V2 的 .agents/skills。当前设计包根为本文件的 ../..；正式迁入后以下文件位于项目 docs/，由 Jenny 更新链接。未迁入不声称已被项目自动加载。

## 先读适用设计

- 全模块文件结构、当前进度、开发与联调：[执行总表](../../../docs/mvp/module-execution.md)。从总表进入自己的模块 DESIGN，再读对应 I0–I4 场景；不全量加载其他模块。

- 总体边界：[架构](../../../docs/architecture.md)。
- 目录及依赖：[模块](../../../docs/module-boundaries.md)。
- 范围、执行包及验收：[MVP](../../../docs/mvp/scope-and-handoff.md)。
- 账号/机器授权：[账号设计](../../../modules/accounts/DESIGN.md)。
- 跨设备消息和文件是基础设施，非 CLI-only 或后续选项：[投递契约](../../../docs/interfaces/cross-device-delivery.md)。按同一授权 LinkRef、持久回执和文件恢复端口接入；不把 V1 received 直接升级为 host-delivered/consumed。
- Ticket/board：[Ticket 设计](../../../modules/tickets/DESIGN.md)。

David 只负责总架构、概要/详细设计、协调和审计。Jenny 负责向可用 peer 派单、AppSDK、DAGpipe、工作区和集成。执行者先读派单合同、对应 DESIGN.md、适用需求和图；不能用本 Skill 获得范围外权限。

## 可以做

- 在独占模块内实现公开契约，复用 V1 通信和 wterm 发布能力。
- 明确报告 unsupported、unknown、stale、partial failure；按对应 owner 处理恢复。
- 按已审接口并行开发，未实现页面明确禁用。源码、自检、真实行为、集成交付分别报告。
- 在已授权范围提交设计修正请求，保留未受影响工作推进。

## 不可以做

- 跨模块 import 私有实现、直接改对方存储，或为平台复制账号/路由策略。accounts、connections、daemon、host-adapters、agent-adapters、webui 与各平台分别独立。
- 让 relay 管理 agent/ticket/终端内容；让 daemon terminal runtime 管客户端焦点/标签页/恢复状态。V2 业务编排使用独立 owner，不能污染 V1 mirror。
- 从 manager 层级、名字、ticket 正文推导授权。稳定 memberId、当前 session binding 与可读路径必须分开。
- 将在线当空闲，将入队/输入当完成，将目录端点当连接成功。状态必须有来源与新鲜度。
- 拖动窗格时重建连接或擅改 tmux 几何。server/buffer/renderer/UI 边界以及现有宽度 lease 继续有效。
- 把不同宿主/agent 的能力统一伪造；ACP 仅是后续会话适配，不绕过 daemon 投递。
- 在 board 重建 ticket 真源；第三方失败时自动回写旧 Collab。
- 将静态 DAG validate 当行为 PASS，或在 UX/设计未通过的受影响部分提前实现。不得写 V1 dirty 树、安装全局 runtime 或操作 tmux server 生命周期。

## 交回要求

按合同交回允许路径、公开入口结果、失败反例及未完成项。跨机器场景必须用真实不同机器验证。David 审计边界与证据；Jenny 接收并集成。该 Skill 不发明额外审批，也不替代既有全局安全和交付规则。
