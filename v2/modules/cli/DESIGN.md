# cli 模块设计与执行卡

状态：2026-11-02 设计交接版。V1 remote CLI已有；V2命令尚未交付。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/cli/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
cli/
├── DESIGN.md
├── src/
│   ├── commands/auth
│   ├── commands/machines
│   ├── commands/groups
│   ├── commands/members
│   ├── commands/receipts
│   ├── clients/daemon-api
│   ├── output/format
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

无独立业务状态或数据库写入；client会话凭据由正式安全存储端口持有。

## 公开接口、数据及错误

消费与Web相同的公开API；输出区分accepted/unknown/done。最终命令拼写由CLI详细DESIGN确定，不在本卡假设已存在。

配置不兼容或无凭据明确失败，不绕过daemon写存储。

## 依赖与联调

- [daemon](../daemon/DESIGN.md) 的公开端口。

对应组合增量：I0诊断/I2正式。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先诊断和真实基础链验证；再用户必需group/member命令；组合远端操作和回执查询。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

安装后正式入口完成公开流程，错误退出码和结构输出准确；不能用内部函数当CLI验收。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/cli/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

