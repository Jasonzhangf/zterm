# Session Drawer CWD Tree + Folder Preview 实现计划

## 1. 目标与验收标准

在现有 Android Terminal 页面和左侧 drawer layout 基础上，完成 daemon `device > cwd > sessions` 的树状 session 展示，以及按 cwd folder 进入预览模式的多窗口交互。保持 daemon 提供的 tmux cwd 为唯一事实来源，UI 只渲染和消费。

验收必须来自用户可安装的最新 APK / OTA 版本，并在 emulator 真实入口完成：

- drawer 左侧保持现有排版和入口；device、cwd folder、session 层级可见，cwd 分类稳定，不从 session name/subtitle 猜 cwd。
- mobile 为紧凑单列；桌面容器最多同时显示两屏预览，超出的 preview tile 通过触摸后才出现的边缘队列滚动区域上下浏览。
- 未点击 drawer folder 时，下方 preview drawer 不出现。
- 只有长按左侧 drawer 的 folder 项才进入 folder preview 模式并显示菜单；点击菜单可进入/退出。
- preview mode 下 folder 不展开其 sessions；点击哪个 folder 就预览哪个 folder。
- preview 为小窗口 tile；默认只刷新最下面区域；多 tile 在宽屏可多列，在 mobile 单列。
- 点击 tile 后，下方半开 quick-peek drawer 才出现；可上滑全屏、下滑关闭；未点击 tile 前不得出现。
- quick-peek 打开时 Quick Bar 仍可呼出和关闭。
- terminal 中央区域的历史滚动与左右边缘的 preview queue 滚动互不抢占、互不混淆。

## 2. 范围与边界

### In scope

- Android 现有 TerminalPage、session drawer、preview grid、quick-peek / bottom sheet 交互。
- daemon 已提供的 session cwd 消费与现有 session refresh / audit 链路中 catalog-owned group 的保留。
- 必要的 UI 状态、测试、版本构建、emulator 验证和 OTA 发布。

### Out of scope

- 不重构现有 layout，不改 drawer 为右侧或新的导航模型。
- 不修改 tmux cwd 真源、daemon session ownership 或 transport 架构。
- 不把 runtime 源码复制进本仓库。
- 不引入第二个 cwd/session 真源，不从展示字段反推 cwd。
- 不做未要求的视觉重构、后端协议重设计或 fallback 双路径。

## 3. 设计原则

- 先读并遵守 `android/docs/architecture.md`、架构边界整改审计、`android/docs/spec.md`、`android/docs/dev-workflow.md`、`android/docs/ui-slices.md` 和相关 decision / test design。
- 使用 `frontend-ui-reference` skill 选择实现级 UI pattern；必要时配合 `zterm-mobile-dev` 完成 Android 真实验证。沿用现有 layout、token、组件和手势基础。
- daemon 持有 tmux cwd；client 只消费已提供的 cwd 字段并建立 `device > cwd > sessions` 投影。
- drawer 的 folder 长按是 preview mode 唯一进入触发；普通点击继续既有展开/选择语义，preview mode 内禁止展开 sessions。
- preview queue 是叠加在 terminal 上的触摸后显示层，不常驻占用横向空间；中央 terminal history scroll 继续由 terminal renderer 负责。
- sheet 手势状态必须显式区分 hidden / half / full，并保持 Quick Bar 独立可用。
- 失败显式暴露；不通过静默清理、silent strip、兼容 fallback 或第二套分类逻辑掩盖数据问题。

## 4. 技术方案与文件范围

先通过 resource map、function map、mainline call map 和 verification map 确认唯一 owner，再定位现有实现。优先修改现有文件，禁止无收益新增 Manager/Service/Factory 等抽象。

预期检查/修改范围（以实际 owner 为准）：

- `android/src/pages/TerminalPage.tsx` 及其现有 helper：drawer、preview mode、quick-peek、Quick Bar 和手势编排。
- `android/src/components/` 或现有 terminal drawer / preview 组件：树状 cwd 投影、tile grid、edge queue、bottom sheet。
- `android/src/hooks/`、`android/src/lib/`：现有 session refresh、remote tab audit、catalog-owned group 保留逻辑；只修唯一真源。
- 对应 `.test.ts` / `.test.tsx`：正反交互回归和 cwd 分类测试。
- `android/.build-meta.json`、OTA bundle 产物链：仅按项目既有版本流程更新，不提交大批构建物或 node_modules。

必须先核对真实文件和 registry；以上是定位范围，不得据此虚构 symbol 或越过 owner。

## 5. 风险与规避

- 空 backend refresh 误删 catalog-owned cwd group：仅对确有 backend session 的 catalog 执行相应 prune，并保留 drawer-open 的非破坏语义。
- preview 手势与 terminal history 手势冲突：队列只绑定边缘触摸区域，中央滚动保持 terminal 原有 owner；边缘 overlay 默认隐藏。
- preview mode 意外展开 sessions：mode 内 folder click 只切换预览目标，不改变 tree 展开状态。
- sheet 与 Quick Bar 互相遮挡：验证 quick-peek hidden/half/full 三态下 Quick Bar 仍可呼出、关闭。
- mobile 横向空间不足：单列、紧凑 tile、队列叠加显示；不常驻 scrollbar/side rail。
- 只在源码或旧 APK 验证：必须重新构建、安装/OTA 更新并用 emulator 用户入口核对版本号和 APK hash。

## 6. 测试与验证矩阵

### 静态与架构

- 先完成模块边界、owner、allowed/forbidden paths 自检。
- feature registry、architecture / truth gates、`git diff --check` 通过。

### 定向测试

- cwd tree 投影：device/cwd/session 层级、空 cwd、多个 session、tmux-only catalog。
- drawer audit：drawer-open 不 prune catalog-owned group；空 backend 不删除有效 cwd group。
- folder 长按菜单：普通点击不触发 preview；长按触发；进入/退出可逆。
- preview mode：不展开 sessions，目标 folder 切换正确。
- preview grid：mobile 单列、宽屏多列、最多两屏、edge queue 默认隐藏且触摸后显示。
- quick-peek：tile 未点击时 hidden；点击后 half；上滑 full；下滑 hidden；Quick Bar 独立可用。
- 手势隔离：中央 terminal history scroll 与边缘 queue scroll 分离。
- 正反测试成对覆盖 success、failure、non-terminal / already-terminal 等适用状态。

### 构建与真实运行

- 按 `android/docs/dev-workflow.md` 跑定向测试、全量测试、strict / feature gates、Vite / Capacitor / Gradle 构建。
- 安装或 OTA 更新到 emulator；确认运行中的 versionName、versionCode、APK SHA256 与本次构建一致。
- 真实 emulator CDP/ADB 操作覆盖完整验收路径，保存最小截图、DOM / accessibility、logcat 和版本证据到 `android/evidence/`，不提交大批构建物。
- 版本变化时严格执行项目 OTA 顺序：`patch-apk-version.py` → `prepare-update-bundle.mjs` → `verify-update-bundle.mjs`，并验证 daemon `latest.json` 与下载 APK hash。
- 全部实现、构建、安装、重启、在线真实样本验证完成后，才运行 AGY Review；P0/P1 或 controller FAIL 必须修复并重新完成受影响闭环。

## 7. 实施步骤

1. 创建独立 run、读取 `USER.md`、项目 `note.md`、相关 run notes、resource/function/mainline/verification map，刷新 `.agent-collab` 状态和 kill switch。
2. 在 `playground/<issue-or-semantic-id>-<run_id>/` 创建干净 owner worktree 和 claim，记录 base commit、branch、绝对路径。
3. 读取前端相关 skill；核对现有 drawer、session catalog、preview、sheet、Quick Bar 的真实 owner 和调用边。
4. 先写测试设计与最小反向测试，再实现 cwd tree、folder preview、edge queue 和 quick-peek 的最小改动。
5. 在 worktree 内完成定向测试、全量测试、架构 gates、构建和真实 replay；记录 append-only run notes / evidence。
6. 写 handoff / merge queue，精确合并到最新 main；主 tree 只做受影响验证，不覆盖 Jason 现有 dirty 改动。
7. 按项目顺序重新构建、安装/重启、emulator 在线验收；如果改了代码或构建配置，旧 review / 证据全部失效并重跑。
8. 完成 AGY Review 并取得 PASS 后，检查 staged stat/name-status 只含声明 change set，定向 commit、push；确认远端 main、主 tree HEAD 和 OTA manifest 一致。
9. 仅在 clean、无未合并提交、远端一致且证据完整后释放 claim、清理该问题 worktree；更新 `android/note.md` 与 `android/MEMORY.md` 的已验证结论。

## 8. 完成定义（DoD）

- 最新 main 已包含本功能的精确 change set，未覆盖或带入他人 dirty 改动。
- 已有 drawer layout / 左侧入口保持不变，cwd 树状分类和 session 展示在真实安装版可见。
- 长按 folder → 菜单 → preview mode → tile → half/full/close sheet 的完整链路在 emulator 可复现，且 mobile / desktop 约束满足。
- Quick Bar、中央 terminal history、边缘 preview queue 的交互边界通过正反验证。
- 定向测试、构建、架构 gates、安装版真实验证、AGY Review PASS、OTA manifest/hash 验证全部有证据。
- 剩余风险必须明确列出；没有真实证据的项目不得标记完成。
