# goals 模块设计与执行卡

状态：2026-11-02 设计交接版。目标与 ticket 分离已定；V2 独立 CRUD 未交付。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/goals/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
goals/
├── DESIGN.md
├── src/
│   ├── public/goal-port
│   ├── domain/goal：层级与owner
│   ├── application/goal-service
│   ├── ports/goal-store
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

拥有目标层级、目标状态和 owner；ticket 关联由 tickets typed binding 引用 goalId，board 不反写完成。

## 公开接口、数据及错误

create/get/list/updateGoal，actor/workspace scope 必需；目标删改有明确引用处理。

冲突/被引用/无权限明确；不从票全部关闭自动宣称目标达成，除非后续明确策略。

## 依赖与联调

- [accounts](../accounts/DESIGN.md) 的公开端口。
- [organization](../organization/DESIGN.md) 的公开端口。

对应组合增量：I3。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先目标CRUD与权限；再层级和状态变更；最后 tickets 关联与 board 查询。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

跨scope拒绝；目标更新可重读；有引用目标不得静默删除导致孤票；board查询不改变目标状态。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/goals/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

