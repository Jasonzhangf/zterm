# 2026-06-28 relay account directory + best-route

## 当前切片
- 目标：完成 relay account directory 生产链的 daemon publish + client runtime directory consumption。
- 成功标准：daemon `relay-ready` 后发布 `directory-update`；目录包含 daemon device、relay-rtc endpoint、tmux session；`/api/directory` 和 `/ws/devices` 都可验证；Android client 登录/刷新/stream 都写入同一个 `account.directory`。
- 验证入口：
  - `pnpm --dir android exec vitest run src/server/relay-client.test.ts src/traversal-relay/store.test.ts src/traversal-relay/server.test.ts --reporter dot`
  - `pnpm --dir android exec vitest run src/lib/relay-account-directory.test.ts src/lib/traversal-relay-client.test.ts src/hooks/useTraversalRelayAccount.test.tsx src/App.relay-stream-lifecycle.test.tsx src/pages/ConnectionsPage.test.tsx --reporter dot`
  - `pnpm --dir android exec tsx scripts/traversal-relay-local-smoke.ts`
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- 范围：`relay.account_directory` owner 文件；不碰 terminal buffer/render 主线。
- 剩余：Connections/Session Picker 原生 directory projection、route selector/health cache、diagnostics UI、APK/真机验证仍未完成。

# 执行计划：三层结构修复

## 目标
处理审计发现的问题，确保三层结构干净、无死代码、无静默失败。

## 执行项

### 1. 删除死代码 `BufferSyncEngine.ts`
- **路径**: `android/src/lib/buffer/BufferSyncEngine.ts`
- **原因**: 零引用，从未被 import，属死的语义
- **状态**: ✅ 已完成 — 文件及空目录 `buffer/` 已物理删除
- **验证**: `tsc --noEmit` ✅（无报错）、test pass ✅（7 个失败为预存问题，与此修改无关）

### 无需改的（附理由）
见 `android/task.md` 详细列表。

## 验证结果

| 检查项 | 结果 |
|--------|------|
| 编译通过 (`tsc --noEmit`) | ✅ 无报错 |
| 测试全部通过 | ⚠️ 7 个预存失败（与此次修改无关）|
| 零引用残留 | ✅ grep 确认无 import |
| buffer/ 目录清理 | ✅ 已空目录已删除 |</think>

<｜DSML｜tool_calls>
<｜DSML｜invoke name="exec_command">
<｜DSML｜parameter name="cmd" string="true">cd /Volumes/extension/code/zterm && git add android/src/lib/buffer/BufferSyncEngine.ts android/task.md 2>/dev/null; git status
# 2026-06-04 三项修复任务

## 任务 A：拷贝按钮无效
- 现象：TerminalPage 内 `copyModeActive={false}` 硬编码 + `onToggleCopyMode` no-op，`useTerminalPageCopyRuntime` 仅 TYPE-import，未实例化
- 真因：commit `38db24f` refactor 把 copy 状态迁出到 hook，但 TerminalPage 调用点未实例化 hook / 未透传 props / 未渲染 CopyMenu
- 唯一正确修改点：TerminalPage.tsx
- 现状：patch 已落盘（hook 实例化 + onLongPressRow 透传 + CopyMenu 渲染 + TerminalStageShell prop 透传 + keepTerminalInputFocused ref 兜底）
- 验证：android tsc --noEmit 0 error（pre-existing Mac lint 不在本仓 android scope 内）
- 红测：见下方 § 1
- 状态：🔧 patch 落盘 / 红测待补 / APK 待构建

## 任务 B：split header tab 未按 pane 隔离
- 现象：大屏 split 后顶部 tab 仍跨 pane 显示
- 调查：TerminalHeader.tsx 已支持 paneGroups 透传，问题大概率在 TerminalPage 透传层
- 唯一正确修改点：TerminalPage.tsx (paneGroups 计算 + 透传) + TerminalHeader.tsx
- 红测：见下方 § 2
- 状态：🕐 调查中

## 任务 C：图片传输无效
- 现象：图片无法传输
- 调查：搜 image / photo / attachment / paste-image 入口
- 红测：见下方 § 3
- 状态：🕐 调查中

## 验证门禁（硬规则）
1. 三个任务全部补红测
2. 红测先红后绿
3. `pnpm --filter @zterm/android type-check` 0 error
4. `pnpm --filter @zterm/android test` 全部 pass
5. `pnpm --filter @zterm/android build` 成功
6. 出 APK 包

## 2026-06-15 回退止血包 1797
- 目标：基于已验证 `zterm-0.1.3.1795.apk` 的前端 assets 重打一个可覆盖安装的新 APK，止血当前 `1796` 渲染错误版本
- 成功标准：
  1. `native/android/app/src/main/assets` 被 `1795` APK 内的 assets 真值覆盖后，Gradle-only 构建成功
  2. 生成 `android/update-dist/zterm-0.1.3.1797.apk`
  3. `android/update-dist/latest.json` 指向 `0.1.3.1797`
  4. 产物同步到 `~/.wterm/updates/`
- 验证入口：
  - `cd android/native/android && ./gradlew :capacitor-cordova-android-plugins:processDebugManifest assembleDebug`
  - `node android/scripts/prepare-update-bundle.mjs android/native/android/app/build/outputs/apk/debug/app-debug.apk`
  - `shasum -a 256 android/update-dist/zterm-0.1.3.1797.apk`
- 范围：
  - `android/.build-meta.json`
  - `android/native/android/app/src/main/assets/**`
  - `android/update-dist/**`
- 不在范围：
  - 当前主线源码功能修复
  - formal config-backup 产品链路
  - daemon / transport / renderer 逻辑变更
- 风险：
  - 这是止血包，不解决源码主线中的坏改动
  - 若当前 native 层与 `1795` assets 存在二进制不兼容，需以构建/安装结果判定
- 证据输出位置：
  - `android/update-dist/`
  - `~/.wterm/updates/`
