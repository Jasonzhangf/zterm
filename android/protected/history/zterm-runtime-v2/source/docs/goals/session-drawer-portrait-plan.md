# Session Drawer Portrait Plan

## 目标
把顶部 tabs 改为手机竖屏优先的左侧 session 抽屉：默认不显示 tabs，用户在 terminal 内右滑时从左侧拉出窄抽屉；抽屉内是 `1×N` 的 session 单列；右侧始终保留 terminal 主内容；左滑收起；点击或上下滑动选择 session；底部 `+` 触发 session picker。

## 验收标准
- 手机竖屏下默认无顶部 tab strip。
- 右滑后只拉出左侧窄列，宽度受控，不允许 session 面板吃掉主要 terminal 画面。
- 抽屉内 session 采用 `1×N` 单列，而不是 2 列 grid 或顶部 tab 条。
- 抽屉展开时，terminal 仍清晰可见且占右侧主要区域。
- 左滑可收起；点击某个 session 可切换并收起。
- 上下滑动可浏览/聚焦 session 列表。
- 底部 `+` 明确作为“新建 / 打开 session”入口，触发 session picker，而不是直接在抽屉内塞复杂表单。

## 范围
### In Scope
- 竖屏 terminal 主界面的 session 导航形态重构
- 右滑展开 / 左滑收起交互
- session 抽屉的静态布局、层级、间距、状态表现
- 底部 `+` 按钮入口语义

### Out of Scope
- daemon/session 真实打开逻辑
- tab 自动关闭、transport、render、copy mode 等现有功能修复
- session picker 详细表单与 CRUD 完整实现
- 横屏 / pad / split-screen 的最终适配

## 设计原则
- terminal 是主内容，session 抽屉只是切换器，不得喧宾夺主。
- 竖屏优先，空间必须紧凑，尽量少吃垂直空间。
- 左侧抽屉只承担 session 导航，不承担 terminal 内容主体。
- 不保留顶部 tabs 和左侧抽屉双轨并存的重复设计。
- session 列表必须以单列滚动列表为主，便于竖屏拇指操作。

## 技术方案

### 目标结构
- `TerminalPage` 默认隐藏 tab chrome
- 新增左侧 `session drawer` 容器
- gesture runtime 负责：
  - terminal 右滑 -> reveal drawer
  - drawer 左滑 -> hide drawer
  - 抽屉展开时上下滚动 session list
  - 点击 session -> active session 切换 -> drawer 收起
- 抽屉底部 `+` -> 打开已有 session picker / quick-open surface

### UI 结构
- 左侧：`session drawer`
  - header：极简标题/状态
  - body：单列 session rows
  - footer：`+ New Session`
- 右侧：terminal stage
  - 始终保留主要可见面积
  - 不变成 session 内容页

### 关键文件
- `src/pages/TerminalPage.tsx`
- `src/hooks/useTerminalWorkspace.ts`
- `src/pages/useTerminalPageShellActionsRuntime.ts`
- `src/components/terminal/*` 中负责 tab/header/pane chrome 的相关组件
- 预览/设计参考：
  - `docs/tab-swipe-grid-session-preview/index.html`

## 风险与规避
- 风险：手势与 terminal 横向交互冲突
  - 规避：只在明确的 edge-swipe 或 drawer-open 状态接管
- 风险：抽屉过宽导致 terminal 不可用
  - 规避：竖屏宽度固定上限，目标约 `min(280px, 72vw)`
- 风险：继续保留顶部 tabs 导致双系统并存
  - 规避：改造目标必须物理移除默认顶部 tabs

## 测试计划
- 静态预览核对：
  - 左侧抽屉宽度
  - terminal 右侧持续可见
  - session 1×N 单列
  - 底部 `+` 入口位置
- 组件/��互测试：
  - 默认隐藏
  - 右滑显示 / 左滑收起
  - 点击 session 切换并关闭抽屉
  - `+` 触发 picker
- 真机验证：
  - 手机竖屏单手操作
  - 抽屉滚动、点击命中、terminal 可见面积

## 实施步骤
1. 冻结竖屏信息结构与宽度约束
2. 移除默认顶部 tabs 的常驻展示
3. 接入左侧抽屉容器和 reveal/hide 状态机
4. 把 session 投影改成 `1×N` 单列行
5. 接入底部 `+` 到 session picker
6. 补静态/组件/交互红测
7. 真机竖屏验证

## DoD
- 顶部 tabs 默认不显示
- 右滑左出抽屉、左滑收起闭环成立
- session 抽屉单列列表稳定
- terminal 始终保持右侧主视图
- `+` 明确进入 session picker
- 相关测试与真机验证齐全
