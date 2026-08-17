# Connections Enter + Upgrade APK Plan

## 目标与验收标准

目标：修复 Android Connections 页点击 live server group 的 `Enter` 进不了 terminal tabs，同时把当前 copy 修复与 Enter 修复一起编译成可升级 APK，交付到升级路径。

验收标准：
- Connections 页点击 live group 的 `Enter` 后必须切到 Terminal 页面，并激活对应 session/tab。
- copy mode 的 buffer 覆盖失败不再静默无响应，仍保留已选状态并显式 warn。
- 构建产物必须写入 `android/update-dist/`，并更新 `android/update-dist/latest.json`。
- 同步写入 daemon update dir：默认 `~/.wterm/updates/latest.json` 与 `~/.wterm/updates/zterm-latest-debug.apk`。
- 输出最终 APK 路径、versionName、sha256、manifest 路径。

## 范围与边界

In scope：
- `android/src/hooks/useOpenTabSessionActions.ts`
- `android/src/hooks/useOpenTabSessionActions.test.tsx`
- 已有 copy owner 文件：`android/src/pages/terminal-copy-selection.ts`、`android/src/pages/useTerminalPageCopyRuntime.ts`、对应测试
- 构建脚本链路：`pnpm --dir android run build:android` 或等价的 `scripts/build-android-debug.sh`
- update bundle 输出校验

Out of scope：
- 不重构 Connections 卡片 UI。
- 不改 `TerminalView` / `TerminalPageStageShell`。
- 不改 daemon/tmux/runtime 语义。
- 不为构建失败新增 fallback 或跳过门禁。
- 不清理 unrelated dirty files，除非它们直接阻塞 APK 构建且必须明确记录原因。

## 设计原则

- 唯一修改点：`handleResumeSession` 成功恢复 transport 后仍必须执行页面可见性切换；transport 恢复与页面导航不是同一真源。
- 不新增 fallback：点击 Enter 的唯一目标是 terminal tabs 可见；失败要通过测试/日志暴露。
- 保持职责边界：Connections 只发起 action，open-tab session actions 负责 tab 激活与 terminal page visibility。
- APK 交付必须以 manifest 文件和实际 APK 文件为证据，不能只说 build 成功。

## 技术方案

### Enter 修复

当前根因：`useOpenTabSessionActions.ts` 中 `handleResumeSession(sessionId)` 在 `openExplicitSessionById(sessionId)` 返回 `true` 后直接 `return`，导致 transport 恢复成功但没有调用 `ensureTerminalPageVisible()`。用户在 Connections 页点击 live group 的 `Enter` 时看起来没有进入 tabs。

修复：
- 在 `openExplicitSessionById(sessionId)` 返回 `true` 的分支里调用 `ensureTerminalPageVisible()`，然后 return。
- 保持失败分支原逻辑：调用 `handleSwitchSession(sessionId)`，由它 apply open tab state 并 ensure terminal page visible。

测试：
- 更新 `useOpenTabSessionActions.test.tsx` 现有测试：`does not downgrade an explicit resume...` 必须同时断言 `ensureTerminalPageVisible` 被调用一次。
- 新增/调整测试名为：transport reopen succeeded still makes terminal page visible。

### Copy 修复保留

确认以下测试仍通过：
- `src/pages/useTerminalPageCopyRuntime.test.tsx`
- `src/pages/terminal-copy-selection.test.ts`
- `src/components/terminal/system-copy-state-machine.test.tsx`
- `src/components/terminal/system-copy-longpress-regression.test.tsx`

### APK 交付

优先命令：

```bash
cd android
pnpm run build:android
```

该脚本应执行：
- ensure pnpm install
- runtime published check
- `pnpm build`（含 bump build number、type-check、vite build）
- `npx cap sync android`
- `./gradlew assembleDebug`
- `node scripts/prepare-update-bundle.mjs <apk>`

构建完成后必须校验：

```bash
test -f android/update-dist/latest.json
test -f android/update-dist/zterm-latest-debug.apk
test -f ~/.wterm/updates/latest.json
test -f ~/.wterm/updates/zterm-latest-debug.apk
cat android/update-dist/latest.json
```

若 `pnpm run build:android` 被 unrelated dirty files 的 TypeScript error 阻塞，先记录具体 error 文件与行号；只在用户目标允许并且阻塞 APK 交付时，修复这些构建阻塞项。不得跳过 type-check 直接出包。

## 风险与规避

- 风险：`handleResumeSession` 成功分支只恢复 transport 不切页。规避：测试直接断言 `ensureTerminalPageVisible`。
- 风险：`tsc` 被目标外脏文件阻塞。规避：记录错误；若要交付 APK，必须修阻塞项并明确它们是 build gate 修复。
- 风险：只生成 `native/android/app/build/.../app-debug.apk`，没发布到升��路径。规避：必须跑 `prepare-update-bundle.mjs` 并校验 update manifests。
- 风险：设备未连接导致无法真机点测。规避：至少交付 APK + manifest；真机验证由 Jason 安装升级包后执行，或连接设备后补 adb install/smoke。

## 验证计划

定向测试：

```bash
cd android
pnpm exec vitest run \
  src/hooks/useOpenTabSessionActions.test.tsx \
  src/pages/useTerminalPageCopyRuntime.test.tsx \
  src/pages/terminal-copy-selection.test.ts \
  src/components/terminal/system-copy-state-machine.test.tsx \
  src/components/terminal/system-copy-longpress-regression.test.tsx \
  --reporter dot
```

Build + APK：

```bash
cd android
pnpm run build:android
```

Artifact verification：

```bash
cat android/update-dist/latest.json
ls -lh android/update-dist/zterm-latest-debug.apk ~/.wterm/updates/zterm-latest-debug.apk
shasum -a 256 android/update-dist/zterm-latest-debug.apk ~/.wterm/updates/zterm-latest-debug.apk
```

Manual smoke after upgrade：
- Connections 页点击 `Mac Studio · 8 sessions` 的 `Enter`。
- 应进入 Terminal tabs，不停留在 Connections。
- 点击 quick bar `拷贝`，长按行，执行复制，系统剪贴板可粘贴。

## 实施步骤

1. 修改 `useOpenTabSessionActions.ts`：resume 成功分支调用 `ensureTerminalPageVisible()`。
2. 修改 `useOpenTabSessionActions.test.tsx`：锁定成功分支仍切 Terminal 页面。
3. 跑定向测试。
4. 跑 `pnpm run build:android`。
5. 校验 `android/update-dist/latest.json`、`android/update-dist/zterm-latest-debug.apk`、`~/.wterm/updates/latest.json`、`~/.wterm/updates/zterm-latest-debug.apk`。
6. 汇报 APK 路径、versionName、sha256、构建/测试结果、未完成真机项。

## 完成定义

- Enter bug 有代码修复与红测证据。
- copy 静默失效修复测试仍绿。
- Android APK 已构建并发布到升级路径。
- `latest.json` 指向新 APK，sha256 与实际文件一致。
- 最终回复给 Jason 明确 APK 路径和升级 manifest 路径。
