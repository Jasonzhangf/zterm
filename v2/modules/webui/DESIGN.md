# webui 模块设计与执行卡

状态：2026-11-03 V2 WebUI 组件与首条真实链已落地（owner: Emma，branch: `zterm-v2-webui-impl-1103`，workspace: `3:/workspaces/10`）。Grace 保留 bootstrap I0 终端切片（`src/clients/daemon-api*`、`src/clients/terminal-client*`、`src/features/terminal/**`）。

本卡是 David 的模块结构/开发/联调合同，正式根为 `v2/modules/webui/`；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线与实际实现映射。

## 文件结构与责任

```text
v2/modules/webui/
├── DESIGN.md
├── src/
│   ├── index.html
│   ├── app/
│   │   ├── entry.mjs
│   │   ├── routes.mjs
│   │   └── app-shell.mjs
│   ├── pages/
│   │   ├── setup/index.mjs
│   │   ├── connections/index.mjs
│   │   ├── workspaces/index.mjs
│   │   ├── sessions/index.mjs
│   │   ├── board/index.mjs
│   │   └── tickets/index.mjs
│   ├── components/
│   │   ├── index.mjs
│   │   ├── loadable.mjs
│   │   ├── status-badge.mjs
│   │   ├── error-notice.mjs
│   │   ├── form-actions.mjs
│   │   ├── workspace-tree.mjs
│   │   ├── member-picker.mjs
│   │   ├── member-status-list.mjs
│   │   ├── window-header.mjs
│   │   ├── window-frame.mjs
│   │   ├── property-panel.mjs
│   │   ├── goal-ticket-list.mjs
│   │   ├── ticket-list.mjs
│   │   ├── ticket-detail.mjs
│   │   └── delivery-status.mjs
│   ├── features/
│   │   ├── sessions/
│   │   │   ├── index.mjs
│   │   │   ├── session-workbench.mjs
│   │   │   ├── split-layout.mjs
│   │   │   ├── session-preview-canvas.mjs
│   │   │   ├── session-focus-view.mjs
│   │   │   └── workspace-quick-switch.mjs
│   │   └── terminal/              # Retained bootstrap I0 slice (Grace)
│   ├── controllers/
│   │   ├── session-controller.mjs
│   │   └── property-controller.mjs
│   ├── state/
│   │   ├── session-layout.mjs
│   │   └── layout-store.mjs
│   └── clients/
│       ├── delivery-client.mjs
│       ├── daemon-api*            # Retained bootstrap I0 slice (Grace)
│       └── terminal-client*       # Retained bootstrap I0 slice (Grace)
└── tests/
    ├── contract/                  # 当前契约的必要正反例（62 tests）
    │   ├── components.test.mjs
    │   ├── sessions-layout.test.mjs
    │   ├── delivery-client.test.mjs
    │   └── controllers.test.mjs
    └── integration/               # 本模块真实 consumer，关联联调场景（7 tests）
        └── webui-public-entry.test.mjs
```

目录名表达职责；公开入口在 `src/app/entry.mjs`、`src/components/index.mjs`、`src/features/sessions/index.mjs`，私有实现不被跨模块直接引用。

拥有页面导航、焦点、窗格布局；业务事实来自 daemon，各页面独立但复用控件，不跨模块改存储。

## 公开接口、数据及错误

组件接 typed snapshot 与 intent；MemberRef/WorkspaceRef 贯穿标题属性面板；窗口数不固定五个（`1+4` 仅定义桌面默认左主区 `0.42` 比例 + 右侧双列连续滚动区，5/6/N 个 peer 全部可达）。

术语“巡检目标用户”“task q”保持待定（`PropertyPanel` 中显式标注只读待定提示），未明权限不接真实写；缺权限面板明确（`ErrorNotice` 显式暴露 `AUTH_INVALID_TOKEN` / `DELIVERY_TARGET_UNKNOWN_STATE` / `stale` / `unknown`），不能隐藏错误。

终端 typed failure 保持原窗格与 handle 身份。只有失败 member 的窗格显示 `TERMINAL_STREAM_UNAVAILABLE` 与带 `data-member-id` 的 `retry-terminal` action；重试只重建该 member 的 stream，成功后刷新投影，兄弟窗格保持原连接。

## 依赖与联调

- [daemon](../daemon/DESIGN.md) 的公开端口。
- 对应组合增量：I0/I1/I2/I3。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。
- 专项依据：
  - [组件拆分与接口合同](/Users/fanzhang/.codex/visualizations/2026/11/03/01a19f39-e33f-71a3-9f14-187160a43203/zterm-v2-webui-component-contract.md)
  - [跨设备投递与展示合同](/Users/fanzhang/.codex/visualizations/2026/11/03/01a19f39-e33f-71a3-9f14-187160a43203/zterm-v2-cross-device-delivery.md)
  - [已有设计/证据](../../zterm-v2-ux-vertical-review-contract.md)
  - [本地 UX 组件契约副本](../../docs/ux/component-contract.md)

## 开发顺序

完整页面先可导航，模拟/不可用显式；接真实本地 session；再远端组和 tickets。直接拖边、单行标题、窗下属性、多窗滚动、手机上下选择一起审。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

桌面 `1440×900` / 手机 `390×844` 真实视口末尾窗口（第 6 个 peer `m-6`）可达；选中后手机进入单主屏（`SessionFocusView` 复用同一个 `WindowFrame`）；上下切换（`↑ Prev Member` / `↓ Next Member`）不抢终端滚动；返回 `⊞ 2D Preview` 恢复 `{ zoom, panX, panY }`；边框拖拽写回 `layout-store` 并刷新恢复；各窗口独立属性抽屉按 `memberId` 绑定保存不串窗；编辑失败/未知状态/无权限不假成功；布局操作期间健康 `terminalHandle` 零断开重连（`disconnectCalls = 0, createCalls = 1`）。

本轮证据落点：`v2/evidence/zterm-v2-webui-impl-1103/modules/webui/`（详见该目录下 `README.md`、`node-test-report.txt`、`ego-browser-audit.json`，以及宿主证据目录 `/Volumes/Intel/playground/zterm/.worker-runs/zterm-v2-webui-impl-1103/evidence/` 下的 5 张真实视口截图）。
