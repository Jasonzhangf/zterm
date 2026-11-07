# board 模块设计与执行卡

状态：2026-11-02 设计交接版。静态board形态已有；V2真实查询投影未交付。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/board/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
board/
├── DESIGN.md
├── src/
│   ├── public/board-query
│   ├── adapters/goals-public-adapter
│   ├── adapters/organization-public-adapter
│   ├── application/manager-board-reader
│   ├── domain/priority-order
│   ├── ports/goal-reader
│   ├── ports/ticket-reader
│   ├── ports/member-status-reader
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

只读投影，不保存第二套任务状态；权限过滤在排序截取之前。

## 公开接口、数据及错误

queryManagerBoard(managerId,scope) → goals及各目标前五票/直属成员Observation；分页和同优先级次序明确。

读数适配边界：

- goals：board 适配器调用真实公开 `listGoals({ token, workspaceId, parentGoalId })`，
  仅以 `ownerMemberId === managerId` 选择直属目标；`parentGoalId` 不用于推导 manager 关系。
- organization：board 适配器调用真实公开
  `listDirectReports({ token, workspaceId, managerMemberId })`，只在 organization
  明确维护的 `member.managerMemberId` 关系上取直属成员；`parentGroupId` 与 group
  层级不代表管理关系，board 不自行推断。
- tickets 与 member status 继续通过声明端口注入，不新增第二业务真源。

ticket失联可显示stale，不能用空数组声称无任务；状态局部失败不隐藏已知任务。

## 依赖与联调

- [goals](../goals/DESIGN.md) 的公开端口。
- [tickets](../tickets/DESIGN.md) 的公开端口。
- [status](../status/DESIGN.md) 的公开端口。
- [organization](../organization/DESIGN.md) 的公开端口。

对应组合增量：I3。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先组合目标与票；再成员状态与忙闲；最后与webui属性面板联调。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

多个目标/不同权限/同优先级/超过五票的数据验证；未知不计idle；巡检前不读终端内容。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/board/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

