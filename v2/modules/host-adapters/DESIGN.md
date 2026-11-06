# host-adapters 模块设计与执行卡

状态：2026-11-02 设计交接版。V1/Collab 既有适配器有源码依据；V2 接入包含在 Grace bootstrap，未交付。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/host-adapters/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../docs/mvp/module-execution.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
host-adapters/
├── DESIGN.md
├── src/
│   ├── public/host-port：capabilities/deliver/observe
│   ├── tmux/endpoint：已有 socket/session 定位
│   ├── tmux/delivery：正式输入入口
│   ├── dsh/gateway：agent-facts/enqueue 消费
│   ├── codex-desktop/bridge：原生线程桥接
│   ├── registry：按 hostKind 选择
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

只拥有宿主访问与实际能力。tmux 存在不意味着 AGY/DSH 必须使用 tmux 输入；不拥有网络路由。

## 公开接口、数据及错误

消息与已落盘文件引用均通过公开 host port，能力包括 message/file-ref、可信消费证据和按 DeliveryRef 去重/查询支持。无宿主去重证据的未知结果不得自动再次注入。边界与 I2 验收见[跨设备投递契约](../../docs/interfaces/cross-device-delivery.md) §2–§4、§7–§8；host 不拥有穿透或文件传输。

deliver(Binding, request) → HostReceipt；observe 返回宿主事实及来源；terminal 的阅读渲染通过独立 terminal 端口。

unsupported、目标不存在、身份不匹配显式。禁止任何 tmux server 生命周期动作，测试仅释放自有具名 session。

## 依赖与联调

无业务模块硬依赖；平台/存储由声明端口注入，鉴权在公开调用边界落实。

对应组合增量：I0/I1/I2。链路、输入条件与退出证据见[联调计划](../../docs/mvp/integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先接真实 tmux 现存端点；再按 MVP 实际消费需要接 DSH/桌面桥；与 agent-adapters、members 分别联调。host 与 terminal 同为底层消费关系，不强制所有 host 依赖 terminal。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

真实端点输入可见；不存在或旧 anchor 拒绝；tmux 写入只证明 hostDelivered；非 tmux host 不生成伪终端。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/host-adapters/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

