# zterm Android UI Slices

## 目标

把 mobile UI 从“单页堆叠”拆成三条清晰主线：

1. `Connections / Sessions`
2. `Connection Properties`
3. `Terminal`

每条主线先冻结结构，再实现功能，再补运行态验证。

补充目标：

- phone / tablet / foldable / split-screen / future Mac 共享同一套 layout profile 真源
- 大屏通过**单行多列 + 垂直分屏**的 pane 编排复用同一批页面组件，而不是重画 desktop-only 页面

---

## 当前实现真相

当前代码主要集中在：

- `src/App.tsx`
- `src/components/HostList.tsx`
- `src/components/HostForm.tsx`
- `src/components/TerminalView.tsx`
- `src/contexts/SessionContext.tsx`

当前问题：

- `App.tsx` 同时负责页面切换、session 控制、host form 弹层、终端展示
- `HostList` 实际是网页式主机列表，不是 `Connections / Sessions` 连接中心
- `HostForm` 是单层长表单，还没按 `Connection Properties` section 化
- `TerminalView` 只有终端画布，没有顶部连接栏和底部快捷栏

---

## 目标文件 ownership

### Layout / Pane Stage

- `src/lib/layout-profile.ts`
  - 唯一 layout resolver
  - 根据容器尺寸 / 平台能力输出 `phone-single` / `phone-vertical-split` / `tablet-2pane` / `desktop-3pane`

- `src/components/layout/PaneFrame.tsx`
  - 单个 phone-sized pane 外框
  - 统一 safe-area / density / max-width token

- `src/components/layout/PaneStage.tsx`
  - 负责单 pane / 双列 / 三列的单行编排
  - 列与列之间统一使用垂直分屏
  - 不承载业务语义

- `src/components/layout/LayoutDebugBadge.tsx`
  - 仅调试态显示当前 layout profile / pane 数量
  - 默认关闭

说明：

- future `mac/` 壳只复用同一个 Layout / Pane Stage，不应自己重写页面级布局语义

### Root / App Shell

- `src/App.tsx`
  - 只负责路由级页面切换
  - 不再直接承载连接列表和终端页细节

### Connections / Sessions

- `src/pages/ConnectionsPage.tsx`
  - 页面总容器
  - 顶部栏 + 列表区 + FAB

- `src/components/connections/ConnectionsHeader.tsx`
  - 顶部标题 / 关闭 / 账户 / 更多

- `src/components/connections/ConnectionCard.tsx`
  - 单个 connection/session 卡片
  - 名称 / 预览 / 图标 / 删除/关闭动作

- `src/components/connections/ConnectionFab.tsx`
  - 右下角新增入口

### Connection Properties

- `src/pages/ConnectionPropertiesPage.tsx`
  - 纵向滚动配置页
  - 保存 / 取消 / section 排布

- `src/components/connection-form/ConnectionSection.tsx`
  - 通用 section 容器

- `src/components/connection-form/GeneralSection.tsx`
- `src/components/connection-form/AuthSection.tsx`
- `src/components/connection-form/ConnectionSectionFields.tsx`
- `src/components/connection-form/TerminalSection.tsx`
- `src/components/connection-form/AppearanceSection.tsx`

### Terminal

- `src/pages/TerminalPage.tsx`
  - 顶部连接栏 + 中部终端区 + 底部快捷栏

- `src/components/terminal/TerminalHeader.tsx`
  - 返回 / 当前连接胶囊 / 新建

- `src/components/terminal/TerminalCanvas.tsx`
  - 包装 `TerminalView`

- `src/components/terminal/TerminalQuickBar.tsx`
  - 底部固定快捷栏

- `src/components/terminal/TerminalExtendedKeyboard.tsx`
  - 扩展快捷键盘 / 命令输入条

---

## 页面级实现切片

## Slice Group A: App Shell

### Slice A1

- 目标：把 `App.tsx` 从“单页堆叠控制器”改成页面切换壳
- 成功标准：
  - `App.tsx` 只负责当前 page state
  - Connections / Properties / Terminal 有独立 page component

### Slice A2

- 目标：定义统一 page state
- 最小状态：
  - `connections`
  - `connection-properties`
  - `terminal`

### Slice A3

- 目标：让 App Shell 同时消费 page state + layout profile
- 成功标准：
  - 页面切换与 pane 编排分层
  - App Shell 不直接写 breakpoint 真源

---

## Slice Group B: Connections / Sessions

### Slice B1

- 目标：先做纯结构页
- 范围：
  - 顶部 header
  - connection card list
  - FAB
- 不接真实连接逻辑

### Slice B2

- 目标：把当前 host 数据接到 card list
- 范围：
  - `useHostStorage`
  - `ConnectionCard`
- 成功标准：
  - 能显示已有 host
  - 新增 host 后能回显为 card

### Slice B3

- 目标：连接卡片支持“进入终端”
- 范围：
  - 点击卡片 → 切页到 terminal
- 先不修协议闭环

---

## Slice Group C: Connection Properties

### Slice C1

- 目标：先把长表单拆成 section 结构
- 范围：
  - General
  - Tmux Session
  - Connection
  - Terminal
  - Appearance

### Slice C2

- 目标：把现有 `HostForm` 字段迁入新的 section 结构
- 成功标准：
  - 新增 / 编辑共用同一页
  - 页面能滚动
  - 保存按钮在安全区内

### Slice C3

- 目标：实现 Properties 页与 Connections 页往返
- 范围：
  - FAB → 新建
  - Card 编辑 → 打开属性页
  - 保存后回到 Connections 页

---

## Slice Group D: Terminal

### Slice D1

- 目标：先做终端页结构壳
- 范围：
  - TerminalHeader
  - TerminalCanvas
  - TerminalQuickBar

### Slice D2

- 目标：扩展键盘层
- 范围：
  - ESC / TAB / CTRL / ALT
  - 编辑 / 更多 / 键盘切换
  - 必要时命令输入条

### Slice D3

- 目标：把 session 状态显示到顶部连接栏
- 范围：
  - 当前连接名
  - 连接状态
  - 新建入口

---

## Slice Group E: Runtime closeout

### Slice E1

- 目标：解决 safe-area 与顶部点击区

### Slice E2

- 目标：修正 host create/save 闭环

### Slice E3

- 目标：修正 session / websocket 协议闭环

### Slice E4

- 目标：真机安装态验证

---

## Slice Group F: Responsive Layout / Shared Shell

### Slice F1

- 目标：定义唯一 `layout profile`
- 范围：
  - container 尺寸分类
  - pane 列数策略
  - phone-sized pane 宽度上限

### Slice F2

- 目标：抽 `PaneFrame + PaneStage`
- 范围：
  - page 组件不再自行决定 breakpoint
  - App Shell 统一编排单行 1/2/3 列

### Slice F3

- 目标：Connections / Properties / Terminal 接到统一 pane stage
- 成功标准：
  - 同一页面组件可在单 pane 与多 pane 下复用
  - 多 pane 默认是一行多列
  - 不新增 desktop-only 页面语义

### Slice F4

- 目标：future Mac 壳复用 shared app-layer
- 范围：
  - 明确平台壳差异只留在 window / shortcut / native input
  - 页面、会话、布局真源不复制

---

## 推荐执行顺序

```text
A1 -> A2 -> A3
-> F1 -> F2
-> B1 -> C1 -> D1
-> C2 -> C3 -> B2
-> E1 -> E2
-> B3 -> D2 -> D3
-> F3 -> E3 -> E4
-> F4
```

规则：

- 先把三个页面壳子立起来
- 再把 layout profile / pane stage 立起来
- 再把 host create/save 接回去
- 最后再收 session / websocket
