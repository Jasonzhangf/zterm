# Ambient Skin: 页面控件化 + 控件效果落盘计划

## 目标

先完成 zterm Android 生产页面的**控件化**，再做 **Ambient CSS 光影效果**。

控件化目标不是复制 CSS 到每个页面，而是把生产页面里散写的原生控件收拢成有限的共享控件 owner，再让页面消费共享控件。当前扫描已从初期的 352 个 `<button>` / 60 个 `<input>` / 9 个 `<select>` / 16 个 `<textarea>` 降到非 Prototype、非 server 的生产代码中 162 个 `<button>` / 32 个 `<input>` / 6 个 `<select>` / 11 个 `<textarea>`。

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

扫描结果（2026-09-13，生产 src 排除 `Prototype.tsx`、`src/traversal-relay/server.ts` 和测试文件）：

```text
<button    162
<input      32
<select       6
<textarea    11
```

共享控件 owner 已存在：

```text
src/components/ambient/AmbientButton.tsx
src/components/ambient/AmbientInput.tsx
src/components/ambient/AmbientSelect.tsx
src/components/ambient/AmbientTextarea.tsx
```

当前已控件化的主要面：

```text
ConnectionsPage      按钮已迁移
ConnectionPropertiesPage 按钮已迁移；仍有 2 处 textarea
SettingsPage         button/input/select/textarea 已迁移
TerminalHeader       header 本地按钮已迁移
HostForm / HostList 表单按钮 / 输入 / 多行已迁移
app 主壳按钮        部分全局按钮已迁移
RenameDialog / ZtermDialog / SessionDrawer 菜单 / 新建会话 Dialog 已迁移（未提交待收尾）
```

剩余主要原生控件面：

```text
TerminalQuickBar        54
TmuxSessionPickerSheet  29
SessionScheduleSheet    25
FileTransferSheet       18
AttachmentDrawer        11
TerminalPreviewGrid     11
TerminalSessionDrawerContent 11
RemoteWindowLockedToolbar 9
RemoteWindowTargetPicker 6
TabManagerSheet         6
ResourceBottomSheet     5
RemoteScreenshotSheet   3
RemoteWindowMorePanel   3
RemoteWindowOverlayController 3
ConnectionPropertiesPage textarea 2
TerminalView / RemoteWindowAppSwitch 各 1
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
[x] Step 0: 建立 src/components/ambient/ 目录与 owner
[x] Step 1: ConnectionsPage
[x] Step 2: ConnectionPropertiesPage（按钮；textarea 待补）
[x] Step 3: SettingsPage
[x] Step 4: TerminalHeader
[~] Step 5: TerminalQuickBar（部分全局/对话框；QuickBar 大面积待做）
[~] Step 6: TerminalSessionDrawer（菜单 / 新建会话 / Rename / ZtermDialog 已做，Drawer content 待做）
[ ] Step 7: TmuxSessionPickerSheet
[ ] Step 8: SessionScheduleSheet
[ ] Step 9: FileTransferSheet
[ ] Step 10: AttachmentDrawer
[ ] Step 11: RemoteWindowOverlay
[ ] Step 12: Dialog / Menu / Overlay 剩余面
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

| 页面 | 状态 | 剩余控件量 | Phase 1 剩余工作量 | Phase 2 工作量 |
|---|---|---|---:|---:|
| ConnectionsPage | 已控件化 | 0 | 0 | 0.5d |
| ConnectionPropertiesPage | 按钮已迁移 | 2 textarea | 0.5d | 0.5d |
| SettingsPage | 已控件化 | 0 | 0 | 0.5d |
| TerminalPage / Shell | 局部 | 少量壳按钮 | 0.5d | 0.5d |

### Terminal 二级控件面

| 模块 | 状态 | 剩余控件量 | Phase 1 剩余工作量 | Phase 2 工作量 |
|---|---|---|---:|---:|
| TerminalQuickBar | 部分已迁移 | 54 | 3~4d | 1d |
| TmuxSessionPickerSheet | 待做 | 29 | 2~3d | 0.5d |
| SessionScheduleSheet | 待做 | 25 | 2~3d | 0.5d |
| FileTransferSheet | 待做 | 18 | 1.5~2d | 0.5d |
| TerminalSessionDrawerContent / menus | 部分已迁移 | 11 | 0.5~1d | 0.5d |
| AttachmentDrawer / TerminalPreviewGrid / TabManager | 待做 | 22 | 1.5~2d | 0.5d |
| RemoteWindow 相关 | 待做 | 22 | 1.5~2.5d | 0.5d |
| ResourceBottomSheet / 其他 Dialog / Menu / Overlay | 待做 | 8 | 1~1.5d | 0.5d |

### 合计

```text
Phase 1 原始估算: 12~19d
Phase 1 已投入: 约 1.5~2d（当前分支 4 个 commit + 待收尾 5 个文件）
Phase 1 剩余: 约 11~17d
Phase 2: 5~6d
总计剩余: 16~23d
最小主线范围（主页面 + QuickBar + SessionDrawer）: 4~6d
```

## Goal Prompt

复制到 Codex / worker 派单时使用。

```text
目标：在 /Volumes/extension/code/zterm 的独立 worktree 下，完成 zterm Android 生产页面控件化，再接入 Ambient light/black 控件效果。

范围：
- 先完成页面控件化：把 production src 中可被共享控件覆盖的 button / input / select / textarea 迁移到 src/components/ambient/ 共享 owner。
- 再完成控件效果：把已批准的 Ambient 光影模型接入生产 CSS 与共享控件，不继续改业务逻辑。
- 只允许在本次 worktree 覆盖 allowed paths 内写入，不改 daemon / wire / transport / buffer / renderer 行为。

当前 baseline 事实：
- worktree: /Volumes/extension/code/zterm/playground/page-controlization-ambient-0913
- branch: codex/page-controlization-ambient-0913
- base: origin/main
- 已存在共享控件：AmbientButton / AmbientInput / AmbientSelect / AmbientTextarea
- 已迁移主面：ConnectionsPage、ConnectionPropertiesPage 按钮、SettingsPage、TerminalHeader、HostForm/HostList、部分 Dialog/Menu
- 剩余生产控件量：162 button / 32 input / 6 select / 11 textarea（排除 Prototype.tsx 与 traversal-relay/server.ts）

执行方式：
1. 先读 android/docs/goals/ambient-skin-page-controlization-plan.md、android/docs/ui-slices.md、android/docs/architecture.md。
2. 按文件切片逐个迁移，每切片只改控件 owner 与调用点，保留 aria-label / role / test-id / text content / 事件参数 / disabled / focus 行为。
3. 每切片先补或更新 ambient-controls-truth 类门禁，再跑定向测试；任何视觉变化放到 Phase 2。
4. Phase 1 完成后单独提交一组合并，不开主干；Phase 2 在控件化合并后开始。

完成 iff：
- production src 不再出现共享控件可覆盖的原生控件 style 散写（允许 Prototype 和 server 例外，需在 commit 说明标明）。
- 每类控件只有一个 owner 组件，ambient-controls-truth 门禁通过。
- pnpm run type-check、pnpm run test:feature-registry、pnpm run test:terminal:shell-theme、pnpm run test:settings-update-ui、pnpm run test:quickbar-ui、pnpm run test:session-drawer-ui、pnpm run test:file-browser-ui、pnpm run test:remote-window-ui、pnpm run test:common-user-flows 均绿。
- Phase 2 完成后 light / black 两套皮肤由 token 驱动，Android emulator / 真机截图落 android/evidence/，且不再出现异常绿色 focus 框。
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
