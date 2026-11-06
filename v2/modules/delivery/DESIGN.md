# delivery 模块设计与执行卡

状态：2026-11-02 设计交接版。V1 app receipts 可作参考；V2 统一投递未验收。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/delivery/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../docs/mvp/module-execution.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
delivery/
├── DESIGN.md
├── src/
│   ├── public/delivery-port
│   ├── domain/receipt：阶段及证据
│   ├── application/local-dispatch
│   ├── application/remote-dispatch
│   ├── ports/receipt-store
│   ├── application/query-receipts
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

拥有投递 operation/receipt；不写 ticket done，不从 TUI 文本判断消费。

## 公开接口、数据及错误

跨设备消息/文件是 I2 必需能力，不是 CLI-only。新增文件传输、收件、续传和完整 DeliveryRef 契约见[跨设备投递](../../docs/interfaces/cross-device-delivery.md) §2–§5、§7。delivery 持有 staging/原子提交/去重；文件总字节与 SHA-256 仅用于协议完整性。远端持久收件不等于 host-delivered，后者不等于 consumed。

submit/getReceipt/subscribeReceipt；requestId、targetMemberId、bindingGeneration 与可信 actor；接收端检查当前绑定。

超时结果未知不等于失败可重试；收件去重与可重放能力须在具体 host 合同验证。

## 依赖与联调

- [routing](../routing/DESIGN.md) 的公开端口。
- [connections](../connections/DESIGN.md) 的公开端口。
- [host-adapters](../host-adapters/DESIGN.md) 的公开端口。
- [accounts](../accounts/DESIGN.md) 的公开端口。

对应组合增量：I1/I2。链路、输入条件与退出证据见[联调计划](../../docs/mvp/integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先本地受理→宿主交付；再远端 daemon→同一回执接口；只有宿主正式消费确认才填 consumed。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

收到/写宿主/消费证据可区分；断线 unknown 不重复发；同 operation 查询可恢复；绑定换代期间无误投。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/delivery/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

