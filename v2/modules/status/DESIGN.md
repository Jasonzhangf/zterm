# status 模块设计与执行卡

状态：2026-11-02 设计交接版。状态分层与未知规则已设计；未交付V2聚合查询。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/status/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
status/
├── DESIGN.md
├── src/
│   ├── public/status-query
│   ├── domain/observation
│   ├── application/status-aggregator
│   ├── application/activity-duration
│   ├── ports/observation-source
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

组合各owner状态；不拥有第二份link/session/ticket状态机。source adapter由daemon注入。

## 公开接口、数据及错误

当前公开入口 `src/public/index.mjs` 只导出 `observation(source,value,observedAt?)`，返回 `{source,observedAt,value}` 的只读来源标签。它不导出 future aggregator、订阅或持久状态。

query/subscribe(subjectRefs) → source/observedAt/freshness/value 是后续对外查询契约；查询不通过发 agent 消息探测。

一个source不可达仅影响对应subject；计时不能将观测缺口补成idle。

## 依赖与联调

- [organization](../organization/DESIGN.md) 的公开端口。
- [members](../members/DESIGN.md) 的公开端口。

对应组合增量：I0/I1/I2/I3。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先机器/绑定/运行事实查询；再订阅与unknown区间；组合board及多窗状态。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

断网保留lastKnown并标stale；宿主没有busy能力时unknown；状态来源不明拒绝假填idle。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/status/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

