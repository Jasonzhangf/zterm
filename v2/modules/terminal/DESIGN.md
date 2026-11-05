# terminal 模块设计与执行卡

状态：2026-11-02 设计交接版。V1 可复用；已发现 bodySubscribed=false 释放冲突。V2 bootstrap 未交付终端验收。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/terminal/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
terminal/
├── DESIGN.md
├── src/
│   ├── public/terminal-port
│   ├── adapters/v1-daemon-client
│   ├── adapters/wterm-renderer
│   ├── application/terminal-consumer
│   ├── ports/width-lease：正式宽度入口
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

消费 V1 server/mirror/publisher/buffer/renderer 的独立 owner，不复制 runtime；连接管理通过注入公开端口。

## 公开接口、数据及错误

attach/read/subscribe/input/requestWidth；读取正文不得触发上游同步策略；预览遵守既定 detached snapshot 例外。

冲突未闭合只停相关验收，不以常开 body 订阅绕过。

## 依赖与联调

无业务模块硬依赖；平台/存储由声明端口注入，鉴权在公开调用边界落实。

对应组合增量：I0/I2。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先真实 TUI 基础读写；终端 owner 定界无 body 释放冲突；通过后组合多窗隐藏/恢复、手机布局与背压。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

停止正文订阅不关闭 session/transport；最后物理 subscriber 离开才释放 daemon 资源且 tmux 存活；同 target 其他 subscriber 保持；输入/resize 不伪写 mirror。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/terminal/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

专项依据：[已有设计/证据](../../zterm-v1-connection-evidence-audit.md)。

