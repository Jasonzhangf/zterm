# Session Drawer CWD Preview Release Plan

## 目标与验收标准

完成 Android session drawer 的 daemon/device → cwd → sessions 层级与 cwd 多窗口预览，并发布一个可通过 Relay OTA 升级的版本。抽屉继续位于左侧；mobile 单列紧凑；preview tile 最多六个，底部 quick-peek 仅在点击 tile 后出现，支持半开、上滑全屏、下滑关闭；Quick Bar 在 sheet 打开时仍可呼出和关闭。

验收必须来自安装后的 emulator/设备真实入口：能看到至少一个 daemon/device 下的 cwd folder，folder 长按进入菜单，进入 preview 后不展开 session；点击 folder 后出现真实 terminal preview；secondary tile 点击后才出现 quick-peek；边缘触摸出现队列滚动提示且不占横向空间；中心滚动仍属于 terminal 历史。

## 范围与边界

In scope：现有 Android drawer、session catalog cwd 字段、client projection、preview grid/sheet/edge queue、对应 registry、测试、APK、OTA manifest 和 Relay channel。

Out of scope：runtime 源码复制、daemon 持有 client 状态、UI 推断 cwd、改 tmux geometry、重构 terminal renderer、替换 Quick Bar、清除 emulator 数据、DNS/路由修改。

## 设计原则

- cwd 只来自 daemon/tmux catalog；client 只渲染和消费。
- `TerminalView`/buffer render store 是 terminal 可见内容真源；preview 不解析或复制 terminal 真相。
- 保持现有 layout 与左侧 drawer；mobile 单列、紧凑；桌面最多两屏并用触摸出现的边缘 overlay 管队列。
- preview selection、quick-peek sheet、Quick Bar 各自保持唯一 owner。
- 错误显式暴露；不做 fallback、silent strip 或第二条数据链。

## 技术方案与文件清单

- `android/src/server/terminal-control-runtime.ts` 与 `packages/shared/src/connection/protocol.ts`：传递 daemon-owned `cwd`。
- `android/src/hooks/useSessionOpenActions.ts`、`useSessionHistoryStorage.ts`、`android/src/lib/types.ts`：保存和投影 `sessionCwdByName`，空值保持兼容省略。
- `android/src/pages/TerminalPage.tsx`：按 daemon/device 与 cwd 建立 drawer projection，调用现有 preview/open owner。
- `android/src/components/terminal/TerminalSessionDrawer.tsx` 及其子模块：folder rows、长按菜单、session rows、slot/new-session 菜单；每个实现文件小于 1000 行并登记 module/edge registry。
- `android/src/components/terminal/TerminalPreviewGrid.tsx`：tile、half/full sheet、touch-revealed edge queue。
- `android/docs/feature-registry.json`、`resource-registry.json`、`module-registry.json`、`edge-registry.json` 及相关 wiki/test design：同步 owner、资源边和验证门禁。

## 风险与规避

- Relay 与本机 direct endpoint 不同：先从 active relay directory/health 证明 catalog，再做 UI 验收。
- emulator 版本可能高于候选 APK：只用版本脚本递增 buildNumber，使用 `adb install -r`，不卸载、不清数据。
- host daemon 与 app 版本不一致：构建后核对 APK version、web assets、daemon health、安装时间和 SHA。
- 主 tree 可能有他人 dirty 改动：只在声明 worktree 实现，集成时只 stage 本 change set。

## 测试计划

- 定向 drawer/catalog/preview 正反测试；selection 1–6、重复/第 7 项拒绝、长按与普通点击区分、sheet 手势、edge queue 与 Quick Bar 共存。
- type-check、feature/resource/module/edge/import gates、Vite/Gradle build、diff-check。
- L2/L3：受控 tmux source → daemon mirror → client buffer/render store → preview DOM，验证 session/cwd 隔离和关闭后资源恢复。
- L4：emulator/设备真实触摸与截图/logcat/UIAutomator 证据。
- L5：APK 安装重启、version/hash/manifest 对齐、OTA bundle verify、Relay 公网 manifest/APK HEAD/hash 校验。
- AGY review 必须在上述验证完成后运行；任何 review 后代码或配置变更都必须重新验证和 review。

## 实施步骤

1. 读取最新 main、项目架构/resource/function/mainline/verification 文档，刷新 collab/run/claim/worktree 声明。
2. 在独立 worktree 合并最新 `origin/main`，确认唯一 change set 与模块边界。
3. 完成 cwd projection、drawer folder/preview/sheet/edge queue 实现及真实子模块拆分；同步 registry 和测试设计。
4. 跑定向测试、全局 gates、type-check、Vite、Gradle；修复所有 P0/P1。
5. 构建递增版本 APK，覆盖安装 emulator，重启 app/daemon，使用 Jason relay 目录验证真实 cwd folder 与 preview 交互。
6. 生成 rollback APK、update bundle，运行 bundle verifier；运行 AGY review，只有 PASS 才进入交付。
7. 精确 stage change set，提交并把 candidate 合并到最新 main；在 main 入口复测后推送代码。
8. 发布 Relay OTA，验证公网 latest manifest、APK hash、version code 和 rollback 链路；保存 evidence，释放 worktree/claim。

## 完成定义（DoD）

- 真实安装入口显示 daemon/device → cwd → sessions 分类和完整 preview 交互。
- 所有定向、架构、构建、emulator、OTA 和 AGY gates 通过。
- main 与远端推送 commit 一致；公网 Relay OTA manifest/APK/hash 与构建版本一致。
- 无未声明文件进入提交，无他人 dirty 改动被覆盖或提交，无未记录风险。
