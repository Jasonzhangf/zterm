# Ambient Skin: 页面控件化 + 控件效果落盘计划

## 目标

先完成 zterm Android 生产页面的**控件化**，再做 **Ambient CSS 光影效果**。

控件化目标不是复制 CSS 到每个页面，而是把生产页面里散写的原生控件收拢成有限的共享控件 owner，再让页面消费共享控件。当前扫描已从初期的 352 个 `<button>` / 60 个 `<input>` / 9 个 `<select>` / 16 个 `<textarea>` 降到 live 页面 0 个可迁移原生控件；仅保留 `TerminalView.tsx` 终端隐藏输入与 `src/traversal-relay/server.ts` 非 UI 例外。

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
<button      0
<input       0
<select      0
<textarea    0
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
HostForm / HostList 死页面已物理删除（无运行时引用，registry 同步移除）
app 主壳按钮        部分全局按钮已迁移
RenameDialog / ZtermDialog / SessionDrawer 菜单 / 新建会话 Dialog 已迁移
TerminalQuickBar / TmuxSessionPickerSheet / SessionScheduleSheet / FileTransferSheet 已迁移
TerminalSessionDrawerContent / AttachmentDrawer / TerminalPreviewGrid / ResourceBottomSheet 已迁移
RemoteScreenshotSheet / RemoteWindow 面板 / TabManagerSheet / ConnectionPropertiesPage textarea 已迁移
```

剩余主要原生控件面：

```text
TerminalView 终端隐藏输入 1（渲染链例外，不改）
traversal-relay/server.ts 8（非 UI，不改）
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
[x] Step 2: ConnectionPropertiesPage
[x] Step 3: SettingsPage
[x] Step 4: TerminalHeader
[x] Step 5: TerminalQuickBar
[x] Step 6: TerminalSessionDrawer
[x] Step 7: TmuxSessionPickerSheet
[x] Step 8: SessionScheduleSheet
[x] Step 9: FileTransferSheet
[x] Step 10: AttachmentDrawer
[x] Step 11: RemoteWindowOverlay
[x] Step 12: Dialog / Menu / Overlay 剩余面
```

### Phase 2: Ambient 控件效果

Phase 2 在控件化完成后接入视觉。当前已接入生产 `android/src/ambient.css`，并给共享控件输出 ambient class；已抓取手机真机截图与平板模拟器截图：`android/evidence/2026-09-13-skin-design/current-phone.png`、`current-tablet.png`。剩余项是双皮肤逐页渲染校验和阴影/留白校准。

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
| ConnectionPropertiesPage | 已控件化 | 0 | 0 | 0.5d |
| SettingsPage | 已控件化 | 0 | 0 | 0.5d |
| TerminalPage / Shell | 已控件化（TerminalView 例外） | 0 | 0 | 0.5d |

### Terminal 二级控件面

| 模块 | 状态 | 剩余控件量 | Phase 1 剩余工作量 | Phase 2 工作量 |
|---|---|---|---:|---:|
| TerminalQuickBar | 已控件化 | 0 | 0 | 1d |
| TmuxSessionPickerSheet | 已控件化 | 0 | 0 | 0.5d |
| SessionScheduleSheet | 已控件化 | 0 | 0 | 0.5d |
| FileTransferSheet | 已控件化 | 0 | 0 | 0.5d |
| TerminalSessionDrawerContent / menus | 已控件化 | 0 | 0 | 0.5d |
| AttachmentDrawer / TerminalPreviewGrid / TabManager | 已控件化 | 0 | 0 | 0.5d |
| RemoteWindow 相关 | 已控件化 | 0 | 0 | 0.5d |
| ResourceBottomSheet / 其他 Dialog / Menu / Overlay | 已控件化 | 0 | 0 | 0.5d |

### 合计

```text
Phase 1 原始估算: 12~19d
Phase 1 已投入: 约 3~4d（当前分支多个 commit）
Phase 1 剩余: 0d（live 页面已控件化；TerminalView/server 例外）
Phase 2: 5~6d（已开始 CSS 接入；剩余视觉校准与设备截图）
总计剩余: 4~6d（仅 Phase 2 校准/截图）
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
- 已迁移主面：ConnectionsPage、ConnectionPropertiesPage 按钮、SettingsPage、TerminalHeader、部分 Dialog/Menu；HostForm/HostList 死页面已物理删除
- 剩余生产控件量：live 页面可迁移控件 0；只保留 TerminalView 终端输入与 traversal-relay/server.ts 非 UI 例外

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
android/src/App.tsx
android/src/main.tsx
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
android/src/lib/server-color.ts
android/src/lib/server-color.test.ts
android/src/lib/terminal-quickbar-logic.ts
android/src/components/terminal/terminal-quickbar-helpers.tsx
android/src/lib/terminal-shell-skin.ts
android/docs/goals/ambient-skin-page-controlization-plan.md
android/docs/architecture.md
android/docs/ui-slices.md
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

## 设备证据记录

本地证据（`.gitignore` 忽略 `android/evidence/**`，不提交图片文件；提交里只保留该记录）：

```text
android/evidence/2026-09-13-skin-design/current-phone.png   1216x2640  phone 真机截图
android/evidence/2026-09-13-skin-design/current-tablet.png  2560x1600  tablet emulator 截图
```

相关 commit：

```text
0b45e4f1 生产接入 ambient.css 与共享控件 class
ed875ad6 ambient 生产 CSS / class 真源门禁
1cd0e9e2 手机+平板证据状态提交
d95935fd 设备证据绑定命令与 commit
e92fb88c ambient shadow/margin calibration
6bdadda0 ambient shared controls render owner DOM
```

已做校准：`index.css` 将 `.ambient-control` 阴影收紧为轻量 2/8px，蓝色/黑色 #0a0f1a 16% 投影；settings group 内容区横向内边距收到 `clamp(8px, 2.4vw, 18px)`；terminal shell 内 ambient classes 降低 elevation/thickness/roughness，避免额外大阴影叠加。

生成路径：

```text
./gradlew :app:assembleDebug
adb -s <device-or-emulator> install -r -d app-debug.apk
adb -s <device-or-emulator> shell am start -n com.zterm.android/.MainActivity
adb -s <device-or-emulator> exec-out screencap -p > evidence/png
```

### 2026-09-15 green focus regression evidence

Candidate source:

```text
base: bb224c608face642ead9c14108736766912c7ee4
worktree: /Volumes/extension/code/zterm/playground/ambient-phase2-final-0915
branch: fix/ambient-phase2-final-0915
```

Data-preserving emulator install:

```text
adb -s emulator-5554 install -r -d -t android/native/android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 shell am start -W -n com.zterm.android/.MainActivity
versionName: 0.1.3.2980
versionCode: 1100029800
firstInstallTime: 2026-09-08 06:36:23
lastUpdateTime: 2026-09-15 20:08:23
dataDir: /data/user/0/com.zterm.android
APK SHA-256: 33746fa48e2fd379349d528fcc0c79270aa1da2e28cd9715d4021859bec439a9
```

The APK bundle contains `data-zterm-input-modality`; the app entry initializes
the runtime as `pointer`. On the installed Terminal page, a real pointer tap on
the connection status strip produced:

```text
modality: pointer
data-keyboard-focus: null
outline-style: none
outline-color: rgb(238, 242, 247)
```

After a real `adb shell input keyevent 61` (Tab), the status strip became the
active element and produced:

```text
modality: keyboard
data-keyboard-focus: true
outline: rgb(56, 212, 125) solid 1.90476px
```

A subsequent real pointer tap returned the strip to `pointer` and
`outline-style: none`, proving the keyboard-only path does not leak into touch
focus.

Evidence files:

```text
android/evidence/2026-09-13-skin-design/emulator-2980-focus-pointer.png
SHA-256: 259c26f40a41bf49ead4c4bc53d2ea077b590bdd675d7d6ab37eb43f2343733a

android/evidence/2026-09-13-skin-design/emulator-2980-focus-keyboard.png
SHA-256: ab36ded6e0c844200cc1ea83154f90bf88fd88195da3617ba187c62a7a8f340a
```
