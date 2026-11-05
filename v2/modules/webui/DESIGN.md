# webui 模块设计与执行卡

状态：2026-11-02 设计交接版。Emma zterm-v2-ux-vertical-density-1103 正在修订；旧指定 UX 路径有证据，最新交互尚待审。Grace 负责 bootstrap 接入切片。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/webui/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
webui/
├── DESIGN.md
├── src/
│   ├── pages/setup
│   ├── pages/connections
│   ├── pages/workspaces
│   ├── pages/sessions
│   ├── pages/board
│   ├── pages/tickets
│   ├── components/window-frame
│   ├── components/window-header
│   ├── components/property-panel
│   ├── state/session-layout
│   ├── clients/daemon-api
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

拥有页面导航、焦点、窗格布局；业务事实来自 daemon，各页面独立但复用控件，不跨模块改存储。

## 公开接口、数据及错误

组件接 typed snapshot 与 intent；MemberRef/WorkspaceRef 贯穿标题属性面板；窗口数不固定五个。

术语“巡检目标用户”“task q”保持待定，未明权限不接真实写；缺权限面板明确，不能隐藏错误。

## 依赖与联调

- [daemon](../daemon/DESIGN.md) 的公开端口。

对应组合增量：I0/I1/I2/I3。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

完整页面先可导航，模拟/不可用显式；接真实本地 session；再远端组和 tickets。直接拖边、单行标题、窗下属性、多窗滚动、手机上下选择一起审。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

桌面/390x844真实视口末尾窗口可达；选中后手机单主屏；上下切换不抢终端滚动；保存刷新正确；板/bug面板对象不串；编辑失败不假成功。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/webui/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

专项依据：[已有设计/证据](../../zterm-v2-ux-vertical-review-contract.md)。

