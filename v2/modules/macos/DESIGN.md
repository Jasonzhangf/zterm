# macos 模块设计与执行卡

状态：2026-11-02 设计交接版。V1 Mac壳存在；V2 macOS独立客户端未交付。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/macos/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
macos/
├── DESIGN.md
├── src/
│   ├── shell/main
│   ├── shell/preload
│   ├── platform/secure-storage
│   ├── platform/window-lifecycle
│   ├── composition/web-surface
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

拥有平台窗口/原生能力；不拥有Web业务状态或单独重连策略。

## 公开接口、数据及错误

窄preload桥接，消费WebUI和daemon公开端口，不暴露任意文件/命令执行。

壳能力缺失明确，不用浏览器PASS替代客户端证据。

## 依赖与联调

- [daemon](../daemon/DESIGN.md) 的公开端口。
- [webui](../webui/DESIGN.md) 的公开端口。

对应组合增量：设计/后续客户端。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先确定壳能力和权限；后续封装已验WebUI；再补native集成。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

真实Mac客户端打开组/终端、窗口生命周期不误停session；原生授权边界正确。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/macos/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

