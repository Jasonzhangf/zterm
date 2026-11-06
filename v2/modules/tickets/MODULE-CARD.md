# tickets 模块设计与执行卡

状态：2026-11-02 设计交接版。Vikunja v2.7.1 API 验证 accepted；Frank 的 zterm-v2-tickets-design-1103 正在细化，adapter 未实现。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/tickets/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
tickets/
├── DESIGN.md
├── src/
│   ├── public/ticket-provider-port
│   ├── domain/ticket-binding
│   ├── domain/write-operation
│   ├── application/ticket-service
│   ├── application/report-service
│   ├── adapters/vikunja-v2
│   ├── ports/binding-store
│   ├── ports/credential-provider
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

Vikunja 管票正文/状态，Zterm 管scope/goal/member映射与操作记录；不镜像第二份done状态。

## 公开接口、数据及错误

create/get/list/appendReport/close/reopen；以providerInstanceId+externalTaskId定位；报告明确actor与执行member。

unknown保持待核实；provider不可用不切回Collab；本地operation record不证明远端未提交。

## 依赖与联调

- [accounts](../accounts/DESIGN.md) 的公开端口。
- [organization](../organization/DESIGN.md) 的公开端口。
- [goals](../goals/DESIGN.md) 的公开端口。

对应组合增量：I3。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先目标版本直接读写；再scope映射/稳定排序/unknown状态；最后board组合。Frank当前详细设计是下一层唯一产物，本卡是结构和联调边界，不覆盖其编辑。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

真实provider创建/报告/关闭重开、403/401、每目标top5；未知创建不重发；读取对账不凭同名认领；无幂等保障不得承诺exactly-once。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/tickets/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

专项依据：[已有设计/证据](../../zterm-v2-vikunja-verification-audit.md)。

