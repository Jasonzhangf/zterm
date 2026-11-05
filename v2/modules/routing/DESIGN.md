# routing 模块设计与执行卡

状态：2026-11-03 实现候选（独占 fork 分支 `zterm-v2-routing-impl-1103`，待 David 准入）。解析契约已含 David 审计修订，行为收据见 `v2/evidence/zterm-v2-routing-impl-1103/`。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/routing/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
routing/
├── DESIGN.md
├── src/
│   ├── public/resolve-port
│   ├── domain/address：machine/group/path 解析
│   ├── application/member-resolver
│   ├── ports/organization-reader
│   ├── ports/binding-reader
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

无第二份组织/绑定写存储；只从 authority 与当前绑定解析。

## 公开接口、数据及错误

`createRoutingService({ organization, members, auth })` → `resolve({ token, workspaceId, address })`。

address 必填 `machineId` 与 `groupPath`。选择器显式分开：`memberId` 只匹配稳定 ID，`memberName` 只匹配可读名；两者可选、互不代填，缺选择器时只在唯一匹配下解析。`expectedGeneration` 为可选非负整数。

0 匹配、未知组/机器 → `ROUTE_NOT_FOUND`；同机器同组多成员且无选择器 → `ROUTE_AMBIGUOUS`；过期 `expectedGeneration` → `BINDING_GENERATION_STALE`。返回 `memberId/machineId/groupId/groupPath/organizationRevision/bindingGeneration/sessionId/anchor`，以及来自 members 运行绑定 reader 的 `hostKind/agentKind/launchProfileRef`；organization 成员记录只用于定位 group/name/memberId，不提供运行配置。`organizationRevision` 是当前 workspace revision。

授权按 AuthContext 的固定 `routing:resolve` action scope、目标 workspace、成员允许表执行；该 action 由 routing 内部固定，调用方不能通过传参选择其他 scope 绕过授权。缺 scope 或跨账号目标 → `ROUTE_FORBIDDEN`，且在任何读取前拒绝、无副作用；token 缺失/未知 → `UNAUTHENTICATED`。account 身份只取自 `auth.verify` 的 AuthContext，不采信调用方输入。

定向选择与无选择器机器+组扫描共享同一成员权限边界：定向路径在读取运行绑定前用目标 `memberId` 校验允许表；无选择器路径先按允许表收窄候选，再读取运行绑定。`members: []` 显式拒绝，窄允许表只允许列出成员，未授权成员不得读取绑定，也不得出现在 `memberIds` / `bindingFailures` 等错误明细中；缺省成员允许表表示不做成员级收窄。

0/多匹配均拒绝投递；revision 随组织变更推进，失效时不静默用旧值。旧路径不猜匹配最新同名成员。

## 依赖与联调

- [organization](../organization/DESIGN.md) 的公开端口。
- [members](../members/DESIGN.md) 的公开端口。

对应组合增量：I1/I2。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先精确 scope 路径；再重命名/迁移语义；与 delivery 组合时目标端复核 generation，避免解析后换代误投。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

a.Jenny/b.Jenny 不串；同名不同 workspace 不泄漏；旧路径不猜匹配最新同名成员。歧义、过期 binding、错误 scope 与跨账号目标显式拒绝且无副作用。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/routing/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。
