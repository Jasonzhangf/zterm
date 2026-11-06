# agent-adapters 模块设计与执行卡

状态：2026-11-02 设计交接版。能力边界已设计；V2 各产品 start/resume 未验收。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/agent-adapters/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
agent-adapters/
├── DESIGN.md
├── src/
│   ├── public/agent-port：start/resume/discover/observe
│   ├── domain/capabilities：产品能力声明
│   ├── codex/session-driver
│   ├── claude-code/session-driver
│   ├── agy/session-driver
│   ├── acp/session-driver：后续有真实消费再建立
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

拥有产品会话协议解释，不拥有组织身份或机器连接。宿主与 agent 由 members 组合。

## 公开接口、数据及错误

start(launchProfile) → AgentSessionRef；resume(sessionId) 返回 supported/unsupported 与真实结果；配置不允许任意注入执行字符串。

启动失败不写活跃绑定；恢复失败不偷偷新建会话并称恢复。

## 依赖与联调

无业务模块硬依赖；平台/存储由声明端口注入，鉴权在公开调用边界落实。

对应组合增量：I1/后续。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先明确一个已支持 TUI 产品的真实启动/恢复；其他产品逐个能力验收；ACP 延后同端口接入，不先造空实现。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

真实 consumer 启动获得 sessionId；支持 resume 才报告恢复，不支持时明确；更换 agent session 后成员 ID 不变。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/agent-adapters/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

