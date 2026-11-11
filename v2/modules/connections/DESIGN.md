# connections 模块设计与执行卡

状态：2026-11-02 设计交接版。V1 连接采证已接受；V2 machine-link 与 /app 统一接入尚未验收。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/connections/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
connections/
├── DESIGN.md
├── src/
│   ├── public/link-port：connect/listSessions/openChannel/observeLink
│   ├── domain/link-state：身份、代次与能力
│   ├── application/connection-manager：候选到连接
│   ├── ports/transport：平台传输契约
│   ├── adapters/v1-traversal：候选和路径复用
│   ├── adapters/app-websocket：显式旧 app 兼容
│   ├── channels/dispatch：通道协商与隔离
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

拥有物理连接与代次；不拥有成员角色、agent session 或 ticket 完成。

## 公开接口、数据及错误

connect(machineId, verifiedAuthorization) → LinkRef；listSessions(LinkRef) → SessionCatalogEntry[]；openChannel(LinkRef, kind, target?) → ChannelRef；observeLink 提供路径、状态与新鲜度。openChannel 为 async：只有对端真实 open/ack 后才返回可寻址 ChannelRef，未接能力抛 unsupported_channel。

catalog 读是机器作用域的 target 控制操作，不是 terminal channel：`listSessions` 经 V1
`mux-target-message` 承载 `list-sessions` 请求，按 `requestId` 关联 `sessions` 响应，
不 open channel、不发送 channel payload。公开条目为 `{ name, backend, stableId }`；
shared mux-ready 契约强制 `targetMessages: true` 并由 `isTerminalMuxServerFrame` 在握手校验；
缺失该能力的帧在握手期被拒绝且不建立 link，因此不存在可达的 `unsupported_catalog`
公开分支。响应缺 `sessions` 或 `sessionCatalog`、条目缺 `stableId` 时抛
`invalid_response`；远端 `list_sessions_failed` 保留原始 message/code 并抛 typed
`list_sessions_failed`。缺 stableId 不自行合成。terminal mux 当前只
请求 tmux backend 的 catalog。

`createTerminalMuxClient({ connectionManager, link })` 提供只绑定一个当前 `LinkRef` 的
terminal mux client。它的 catalog 调用 `listSessions(link)`，channel open 调用
`openChannel(link, "terminal", exactTarget)`，消息只写当前 `ChannelRef`。channel close
和 physical link close 分别通过公开事件投影给 terminal。adapter 的 `close()` 只关闭自己
拥有的 channel；link 仍由连接 owner 用 `closeOwnLink` 显式释放。当前代次失效后，旧
adapter 不读取新 catalog、不打开新 channel，也不把旧事件交给新代 adapter。

通道边界（R3 修正）：terminal mux 的 channelEnvelope/bulkChannel 是传输能力，不是 generic message/file 服务声明。首增量只把 channelEnvelope 映射为 terminal 会话 channel，open 必须带真实 sessionName/backend/expectedSessionIdentity；generic message/file/receipt/status 属于独立 V1 /app 服务，未接入时显式 unsupported，绝不在 terminal mux 上发送任意 payload。

鉴权拒绝不换通道绕过。路径耗尽与当前暂态不可达按声明恢复政策区分；不伪造在线。

## 依赖与联调

- [accounts](../accounts/DESIGN.md) 的公开端口。

对应组合增量：I2。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先经正式端口连接两机 LAN；再接真实跨网 direct/relay 与 app 数据；最后组合远端 daemon。已有 V1 策略不复制，新 channel 不能冒称 terminal mux 已支持。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

I2：两机授权握手和真实数据；错误身份/凭据拒绝；断线恢复旧回调隔离；持续正文/文件时状态能返回真实结果或明确不可用。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/connections/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

专项依据：[已有设计/证据](../../zterm-v2-connections-practice-audit.md)。

