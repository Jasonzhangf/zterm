# Ambient Skin: 页面控件化 + 控件效果落盘计划

## 目标

先完成 zterm Android 生产页面的**控件化**，再做 **Ambient CSS 光影效果**。

控件化目标不是复制 CSS 到每个页面，而是把现在 352 个 `<button>`、60 个 `<input>`、9 个 `<select>`、16 个 `<textarea>` 收拢成有限的共享控件 owner，再让页面消费共享控件。

效果目标是在共享控件层接入 Ambient CSS 的物理光影模型，而不是逐个页面调 box-shadow。

## Worktree / 分支

```text
worktree: /Volumes/extension/code/zterm/playground/page-controlization-ambient-0913
branch: codex/page-controlization-ambient-0913
base: origin/main (e4f0b36f)
```

本计划文件：

```text
android/docs/goals/ambient-skin-page-controlization-plan.md
```

## 当前代码事实

扫描结果：

```text
<button    352
<input      60
<select      9
<textarea   16
checkbox     5
style={{  1171（含测试；非测试主文件仍有大量局部 style）
```

Live 页面：

```text
Connections
Connection Properties
Settings
Terminal
```

Terminal 下还有这些二级控件面：

```text
TerminalQuickBar
TerminalSessionDrawer
TmuxSessionPickerSheet
TabManagerSheet
SessionScheduleSheet
FileTransferSheet
AttachmentDrawer
RemoteWindowOverlay
RemoteScreenshotSheet
CopyMenu
DebugOverlay
各种 Dialog / Bottom Sheet / Menu
```

关键约束：

- Capacitor + React DOM，不是原生 RN。
- 已存在 skin 真源：`src/lib/terminal-shell-skin.ts`。
- 已存在 CSS token 面：`src/index.css` 的 `.zterm-terminal-shell[data-terminal-shell-skin=light|blue|black]`。
- 当前 Ambient 静态预览在 `android/evidence/2026-09-13-skin-design/`，只做视觉目标，不直接并入生产。
- Android 当前 WebView `154.0.8037.0`，支持 Ambient CSS 需要的 `color-mix()`、relative color、`@property`、`pow()`、`atan2()`。

## 执行顺序

### Phase 1: 页面控件化

Phase 1 不改视觉，只把现有 JSX 控件替换成共享 React 控件，保持当前 DOM 行为、ARIA、事件和测试 selector。

交付目标：

```text
页面不再直接散写 button/input/select/textarea style
控件状态 owner 收拢到共享组件
visual owner 与业务 owner 分离
```

共享控件清单：

```text
AmbientButton
AmbientIconButton
AmbientInput
AmbientTextarea
AmbientSelect
AmbientSegmentedControl
AmbientSwitch
AmbientStatusLed
AmbientPanel
AmbientSheet
AmbientDialog
AmbientKeyBank
```

先建组件，再接页面：

```text
Step 0: 建立 src/components/ambient/ 目录与 owner
Step 1: ConnectionsPage
Step 2: ConnectionPropertiesPage
Step 3: SettingsPage
Step 4: TerminalHeader
Step 5: TerminalQuickBar
Step 6: TerminalSessionDrawer
Step 7: TmuxSessionPickerSheet
Step 8: SessionScheduleSheet
Step 9: FileTransferSheet
Step 10: AttachmentDrawer
Step 11: RemoteWindowOverlay
Step 12: Dialog / Menu / Overlay
```

### Phase 2: Ambient 控件效果

Phase 2 在控件化完成后接入视觉。

步骤：

```text
1. 引入 ambient.css 到生产 CSS 真源
2. 把现有 --zterm-* token bridge 到 Ambient token
3. 在 .zterm-terminal-shell 上设置 light / black 两套 ambient token
4. 共享控件输出 .ambient / .amb-surface / .ambx-* class
5. 清理重复 box-shadow / active / pressed / disabled 局部规则
6. 真机 / emulator 验证
```

## 页面控件化工作量表

### 主页面

| 页面 | 当前控件量 | Phase 1 工作量 | Phase 2 工作量 |
|---|---|---:|---:|
| ConnectionsPage | 5 buttons | 0.5~1d | 0.5d |
| ConnectionPropertiesPage | 9 buttons + textareas | 1~1.5d | 0.5d |
| SettingsPage | 8 buttons + inputs + selects | 1~1.5d | 0.5d |
| TerminalPage | 页面壳 + shell | 0.5d | 0.5d |

### Terminal 二级控件面

| 模块 | 当前控件量 | Phase 1 工作量 | Phase 2 工作量 |
|---|---|---:|---:|
| TerminalQuickBar | 45 buttons + 6 inputs + 3 textareas | 2~3d | 1d |
| TmuxSessionPickerSheet | 22 buttons + 5 inputs | 1.5~2.5d | 0.5d |
| FileTransferSheet | 17 buttons + textarea | 1.5~2d | 0.5d |
| TerminalSessionDrawer | 11 buttons | 1~1.5d | 0.5d |
| SessionScheduleSheet | 8 buttons + 13 inputs + selects | 1~1.5d | 0.5d |
| AttachmentDrawer | 11 buttons | 0.5~1d | 0.5d |
| RemoteWindowOverlay | 9+ buttons | 1~2d | 0.5d |
| Dialog / Menu / Overlay | 分散 | 1~2d | 0.5d |

### 合计

```text
Phase 1: 12~19d
Phase 2: 5~6d
总计: 17~25d
最小主页面 + QuickBar 范围: 5~8d
```

## 唯一 owner 与文件边界

本任务允许写入：

```text
android/src/components/ambient/
android/src/pages/ConnectionsPage.tsx
android/src/pages/ConnectionPropertiesPage.tsx
android/src/pages/SettingsPage.tsx
android/src/pages/TerminalPage.tsx
android/src/pages/TerminalPageStageShell.tsx
android/src/pages/terminal-page-shell-ui.tsx
android/src/components/terminal/*
android/src/components/tmux/*
android/src/components/settings/*
android/src/components/connection-form/*
android/src/index.css
android/src/lib/mobile-ui.ts
android/src/lib/terminal-shell-skin.ts
android/docs/goals/ambient-skin-page-controlization-plan.md
android/docs/architecture.md
android/docs/ui-slices.md
android/docs/dev-workflow.md
android/docs/feature-registry.json
android/docs/module-registry.json
android/docs/edge-registry.json
```

禁止写入：

```text
daemon / shared protocol / transport / buffer / renderer 行为
TerminalView 渲染链
daemon mirror / buffer publisher / control center
非本任务其他 worktree / dirty main
```

## 必跑 gate

每次切片完成后至少跑：

```text
pnpm run type-check
pnpm run test:feature-registry
pnpm run test:terminal:shell-theme
pnpm run test:settings-update-ui
pnpm run test:quickbar-ui
pnpm run test:session-drawer-ui
pnpm run test:file-browser-ui
pnpm run test:remote-window-ui
pnpm run test:common-user-flows
```

页面控件化阶段还必须：

```text
保留现有 aria-label / role / test-id / text content
不改变事件调用参数
不改变 disabled / pressed / focus 行为
```

控件效果阶段还必须：

```text
390px 手机视口截图
平板 / 横屏截图
Android emulator / 真机渲染
focus-visible 不再出现异常绿色 focus 框
```

## 完成 iff

Phase 1 完成 iff：

```text
live 页面不再直接出现共享控件可覆盖的 button/input/select/textarea style 散写
每类控件只有一个 owner 组件
现有单测和 feature-registry gate 通过
```

Phase 2 完成 iff：

```text
light / black 两套皮肤均由 token 驱动
Ambient CSS 已进入生产 CSS，不依赖 evidence 静态预览
所有共享控件在 light / black 下渲染正确
手机 / 平板 / 真机截图证据落 evidence/
```

## 非目标

- 不改 daemon / wire / buffer / renderer 行为。
- 不把控制状态写入业务 payload。
- 不做新功能，不做重构 terminal 核心。
- 不改 relay / session / transport 逻辑。
- 不替换 terminal renderer 自身。
- 不处理 Mac 客户端实现。

## 风险

- 现在页面大量 inline style，先控件化会暴露重复样式定义。
- 很多组件是 plugin slot 渲染，需要在 plugin host 边界内替换，不能直接穿透到业务 truth。
- RemoteWindow 控件有自己的窗口尺寸 / 输入约束，不能随手改全局尺寸。
- Ambient CSS 视觉效果依赖 WebView ≥ 119；当前连接设备已满足，但仍需在最低目标设备上验证。
