# errors 模块设计与执行卡

状态：2026-11-02 设计交接版。统一错误归属已设计，未交付V2错误入口。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/errors/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
errors/
├── DESIGN.md
├── src/
│   ├── public/error-contract
│   ├── application/error-sink
│   ├── application/error-query
│   ├── ports/error-store
│   ├── domain/redaction
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

拥有统一错误记录/查询；各业务owner决定恢复，不import全部业务实现造成循环依赖。

## 公开接口、数据及错误

recordError(code,owner,operationRef,cause,retryDisposition)；query在相应scope授权后返回脱敏因果。

错误存储失败必须显式记录当前动作结果，不递归发无限错误，不吞原错。

## 依赖与联调

无业务模块硬依赖；平台/存储由声明端口注入，鉴权在公开调用边界落实。

对应组合增量：I0起。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先最小typed错误接口与当前必要记录；再接各owner真实错误；最后在webui/cli统一显示。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

鉴权、连接、宿主unsupported、ticket unknown可区分并追溯；秘密不记录；可选错误不crashdaemon。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/errors/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

