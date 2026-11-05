# android 模块设计与执行卡

状态：2026-11-02 设计交接版。V1 Android已有；V2 native独立模块未实现，当前手机Web由webui负责。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/android/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
android/
├── DESIGN.md
├── src/
│   ├── platform/application
│   ├── platform/native-transport
│   ├── platform/input-ime
│   ├── platform/secure-storage
│   ├── composition/web-surface
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

仅Android平台能力；业务账号/路由/票仍是基础owner，native发送流控继续单owner。

## 公开接口、数据及错误

平台端口适配到公开connection/input/credential接口；不能复制业务策略。

缺设备仅停native验收；不改生产启动路径插入测试。

## 依赖与联调

- [daemon](../daemon/DESIGN.md) 的公开端口。
- [connections](../connections/DESIGN.md) 的公开端口。
- [webui](../webui/DESIGN.md) 的公开端口。

对应组合增量：设计/后续native。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先独立设计约束与MVP手机Web；后续排native切片时接平台能力；最后真实设备组合。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

native改动按Android L5正式入口/截图/logcat/安装态验收；Web浏览器结果不能冒充native。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/android/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

