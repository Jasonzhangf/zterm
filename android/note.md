# 2026-06-29 WezTerm TUI / Codex observation

- 远端 Windows 机已实测 `codex` 可直接在 WezTerm mux pane 中运行：`wezterm.exe cli spawn --new-window --workspace codex-test cmd /c codex` 返回 pane `9`。
- `wezterm.exe cli get-text --pane-id 9 --escapes` 能直接抓到 Codex TUI 当前屏幕，包括欢迎头、提示符和 ANSI 样式；这说明 WezTerm 可作为 TUI 可观测窗口，而不是只能跑普通 shell。
- 目前可用的观测手段：
  - `wezterm.exe cli list` 定位 pane / workspace。
  - `wezterm.exe cli get-text --pane-id <id> --escapes` 抓当前画面。
  - `wezterm.exe cli get-text --pane-id <id> --start-line -N --escapes` 看 scrollback。
- 这次只验证了“能跑 + 能观测”，没有把 `send-text` 作为输入真源纳入结论。

# 2026-06-29 WezTerm daemon mainline integration

- 已把 WezTerm backend 从独立 adapter 接入 daemon 主链：`ZTERM_TERMINAL_BACKEND=wezterm` 时走 WezTerm runtime，Windows 默认 WezTerm，其他平台默认 tmux；未知 backend 显式报错，不做 fallback。
- WezTerm backend owner 仍是 `src/server/wezterm-backend.ts`：负责 `list/spawn/get-text/send-text/kill-pane` 和 sessionName -> paneId 映射；server/control/mirror 只通过 runtime 接口消费。
- 接入边界：
  - `send-text --no-paste` 只通过 stdin 写真实 input，禁止把用户输入塞进 args。
  - `assertTmuxSessionExists` 已改为 backend-aware，WezTerm attach 不再走 tmux `has-session`。
  - WezTerm 暂不支持 adaptive window resize；resize 不静默吞掉，走显式 error。
  - `wezterm session not found` 纳入 session unavailable 分类，避免 pane 消失时变成泛化 sync failure。
- 已验证：
  - `pnpm --dir android exec vitest run src/server/server.control-truth.test.ts src/server/terminal-backend-selection.test.ts src/server/terminal-mirror-runtime.test.ts src/server/terminal-control-runtime.input-queue.test.ts src/server/terminal-mirror-capture.test.ts src/server/wezterm-backend.test.ts src/server/wezterm-backend-runtime.test.ts src/server/terminal-message-runtime.test.ts --reporter dot` PASS（8 files / 69 tests）。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。

## 2026-06-30 traversal reconnect dead-end recovery / startup width truth

- TraversalSocket 以前在“所有候选都失败且没有可选路径”时直接落入 error 终态，只发一次 `onclose`，不会再进入重试循环；这会把网络恢复场景卡死到必须重启 App 才能重新建连。
- 修复方向已收口成唯一真源：`finishFailure()` 负责发 close 事件，随后统一走 `scheduleReconnect()`，避免把“全候选失败”当成永久死路。
- 启动宽度模式链路已再次确认：`useBridgeSettingsStorage` 首 render 同步读 localStorage，`SessionContext` 首次 connect handshake 直接携带 `widthMode`，不需要等后续 resize 才决定。
  - `pnpm --dir android exec tsx scripts/wezterm-backend-remote-smoke.ts` PASS，Windows host `huawei@100.75.122.121`，snapshot lineCount=3。
  - `pnpm --dir android exec tsx scripts/wezterm-backend-input-smoke.ts` PASS，cmd/raw input contract OK。
  - `pnpm --dir android exec tsx scripts/wezterm-daemon-protocol-smoke.ts` PASS，真实 server/WebSocket 主链走 `list -> create -> session-open -> connect -> input -> buffer-sync`。

# 2026-06-29 app update explicit manifest install fix

- 现场截图显示 1950 弹窗点击「立即升级」后停在「升级清单已变更，请重新检查更新」；根因在 `app-update-runtime.startUpdate()`：用户点弹窗按钮时传入了 `availableManifest`，但 runtime 仍强制重新拉 `latest.json` 并要求 versionCode + sha256 与弹窗快照完全一致。服务端发布新 manifest 后，旧弹窗就永远无法继续安装。
- 修复：`startUpdate(manifest)` 以显式传入的弹窗 manifest 为安装真源，直接进入 native install，不再二次拉 manifest；只有内部无显式 target 的 `startUpdate()` 仍保留 revalidation，继续锁住 cached manifest 过期风险。
- 回归：
  - 正向：`installs the explicit manifest target without revalidating a potentially changed manifest`，证明弹窗按钮不会再被新 manifest 卡死。
  - 反向：`revalidates the cached manifest when install is requested without an explicit target`，证明无显式 target 时仍会拒绝 stale cached manifest。
- 验证：
  - `pnpm --dir android exec vitest run src/lib/app-update-runtime.test.ts src/hooks/useAppUpdate.test.tsx src/lib/app-update-relay-manifest.test.ts --reporter dot` PASS（16 tests）。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。
  - `./android/scripts/build-android-debug.sh` PASS，生成并发布 `0.1.3.1955`。
  - `android/update-dist/latest.json` 与 `~/.zterm/updates/latest.json` 均指向 `zterm-0.1.3.1955.apk`，sha256 `e875468be619e67bf3d8c8384ebe713307f1578953b749085d9f447167a0712a`。
  - `curl http://100.66.1.82:3333/updates/latest.json` 返回 `0.1.3.1955`；`curl -I http://100.66.1.82:3333/updates/zterm-0.1.3.1955.apk` 返回 200。

# 2026-06-29 drawer server identity alias fix

- 现场截图显示 drawer host rail 同一台 `mac-studio` 被拆成两组：`100.66.1.82` 下面 7 个 session，`mac-studio` 下面 1 个 session。根因是部分 session 有 `daemonHostId=mac-studio`，部分历史/open tab 只保留 `bridgeHost=100.66.1.82`，drawer 直接按各自字段分组。
- 修复：`server-identity.ts` 增加 endpoint alias map。先从带 daemonHostId 的 session 建立 `bridgeHost:bridgePort -> daemonHostId/displayName` 映射，再把同 endpoint 但缺 daemonHostId 的 session 归并到同一个 hostKey/hostLabel。
- `TerminalPage` drawer projection 改为消费 `resolveServerIdentity(session, aliases)`；`TerminalSessionDrawer` host rail 直接显示注入的 `group.hostLabel`，不再在 UI 层二次 `resolveServerDisplayName()`。
- 验证：
  - `pnpm --dir android exec vitest run src/lib/server-identity.test.ts src/components/terminal/TerminalSessionDrawer.test.tsx --reporter dot` PASS（15 tests）。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。
  - `./android/scripts/build-android-debug.sh` PASS，发布 `0.1.3.1956`。
  - `curl http://100.66.1.82:3333/updates/latest.json` 返回 `0.1.3.1956`；`curl -I http://100.66.1.82:3333/updates/zterm-0.1.3.1956.apk` 返回 200。

# 2026-06-28 relay route continuation audit

# 2026-06-29 multi-daemon UI identity slice

- 本轮 UI 修复收敛到共享 server identity projection：`src/lib/server-identity.ts` 统一产出 server key / display name / color tone，Terminal drawer、session group side peek、TerminalPage drawer projection 不再各自拼 `bridgeHost:bridgePort` 当用户可见服务器名。
- 颜色修正：`server-color.ts` 不再用连续 hue hash，避免落到紫/粉区；改成固定红/黄/蓝/绿/青/橙 palette，并锁住 `mac-studio` 与 `100.86.84.63` 不能同色。
- New connection picker 增加显式“新增服务器” CTA；已有 target/session 列表改成“已有服务器”，避免“新增服务器”和“从旧服务器开 session”语义混在一起。
- Terminal drawer 多 daemon host rail 改为纵向列表；窄抽屉里不再横向滚动 daemon tabs。
- 横向 side peek 显示 server label + session title，并用 server tone 区分不同服务器；回归锁定不再把 `host:3333` 作为用户可见身份。
- 已验证：
  - `pnpm --dir android exec vitest run src/lib/server-identity.test.ts src/components/terminal/TerminalSessionDrawer.test.tsx src/components/tmux/TmuxSessionPickerSheet.test.tsx src/pages/TerminalPageStageShell.pane-stage.test.tsx --reporter dot` PASS（4 files / 26 tests）。
  - `pnpm --dir android exec vitest run src/lib/server-color.test.ts src/lib/server-identity.test.ts src/components/terminal/TerminalSessionDrawer.test.tsx src/pages/TerminalPageStageShell.pane-stage.test.tsx --reporter dot` PASS（4 files / 25 tests）。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。
  - `src/contexts/SessionContext.ws-refresh.test.tsx` 先被全局 `defaultTraversalRouteHealthCache` 污染阻断，表现为后续用例 `MockWebSocket.instances` 期望 1 实际 0；修复为该测试 `beforeEach` 清 route health cache 后单跑 PASS（125 tests）。
  - `node ./scripts/run-terminal-contracts.mjs` PASS（48 files / 551 tests）。
- `./android/scripts/build-android-debug.sh` PASS，生成 `android/update-dist/zterm-0.1.3.1949.apk` 与 `~/.zterm/updates/zterm-0.1.3.1949.apk`，sha256 `25657725778fd42fcf5f4cc01f08ec1871cf80dd00233f51cdce8040b20e837b`；manifest 校验和 default relay address leak check PASS。
- `adb devices -l` 无在线设备，缺直接 adb install 真机验证。

## 2026-06-29 server color palette fix

- 颜色 palette 已从连续 hue hash 收口为固定 `红 / 黄 / 蓝 / 绿 / 青 / 橙` 区间，避免 drawer 切换时把不同服务器切成同一类紫红色。
- `server-color.test.ts` 锁住两个真机可见 key：`mac-studio` 与 `100.86.84.63` 不能同色，并禁止 hue 落入紫/粉区。
- 现场继续发现 Connections 入口页和 terminal drawer 的服务器色不一致；根因是 Connections 页仍按 `bridgeHost:bridgePort` 取 `server-color`，drawer 按 `server-identity` 的 daemon/server key 取色。
- 修复：Connections 页也改为 `getServerIdentityTone()`；`ConnectionCard` 暴露 `data-server-key` 测试点，回归锁住 daemon-first group 的入口页 server key 和 tone 必须与 drawer 同源。
- 已验证：
  - `pnpm --dir android exec vitest run src/lib/server-color.test.ts src/lib/server-identity.test.ts src/components/terminal/TerminalSessionDrawer.test.tsx src/pages/TerminalPageStageShell.pane-stage.test.tsx --reporter dot` PASS（4 files / 25 tests）。
  - `pnpm --dir android exec vitest run src/pages/ConnectionsPage.test.tsx src/components/terminal/TerminalSessionDrawer.test.tsx src/lib/server-identity.test.ts src/lib/server-color.test.ts --reporter dot` PASS（4 files / 35 tests）。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。
  - `./android/scripts/build-android-debug.sh` PASS，生成 `android/update-dist/zterm-0.1.3.1950.apk` 与 `~/.zterm/updates/zterm-0.1.3.1950.apk`，sha256 `ab5f7f98fae2ad6e643886e46ff6594559e74b1b00ced147aaed9d1040b17546`。
  - `adb devices -l` 当前无在线设备，仍缺真机安装态验证。

- 继续 `/goal` 后当前 route gate 先跑通：`route-selector / route-health-cache / config / socket` 共 20 tests PASS。
- 现有 `socket.test.ts` 仍偏老 reconnect 语义，缺少目标要求的 route health 边界：成功写入 RTT/candidate id、失败/auth failure 后下一轮跳过坏 candidate、TTL 过期后 direct 可重新胜出。
- `TraversalSocket` 的 `onerror` 会记录 failure/auth-failure health；实际 WebSocket 通常随后 close 才推进候选。需要用测试锁住“failure + close -> next candidate”和“reconnect 重新按 health 选择”的行为，避免 route selector 退化回固定 priority。

# 2026-06-29 relay default login server

- Relay 登录默认地址收敛为 `DEFAULT_TRAVERSAL_RELAY_BASE_URL=https://claw.codewhisper.cc:18443/relay/`，Settings 初始值和输入 placeholder 都使用同一真源。
- `useTraversalRelayAccount.syncRelay()` 现在在 Relay Base URL 为空时使用默认地址；用户填写自定义地址时仍优先使用用户值，并继续走 `normalizeTraversalRelayBaseUrl()` 补 `/relay/`。
- 验证：
  - `pnpm --dir android exec vitest run src/lib/traversal-relay-client.test.ts src/hooks/useTraversalRelayAccount.test.tsx src/components/settings/RelayControlSection.test.tsx --reporter dot` PASS（3 files / 9 tests）。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。
  - relay related gate PASS：16 files / 98 tests。

# 2026-06-29 daemon install / home migration固化

- MacBook Air 上已经确认不是“手工修环境”才能跑，而是 daemon 包内脚本自己生成了稳定用户态入口：
  - `~/.local/bin/zterm-daemon` 和 `~/.local/bin/wterm` 由 npm postinstall / service runner 自动写入。
  - 写入前会先移除旧文件或旧 symlink，避免误写到旧目标。
  - released service runner 在读 config 前会把旧 `~/.wterm` 迁移到 `~/.zterm`。
- 远端验证结果：
  - `zterm-daemon restart` 后服务仍是 `com.zterm.android.zterm-daemon`。
  - `curl http://100.86.84.63:3333/health?token=wterm-4123456` 返回 `ok: true`。
  - `~/.wterm` 已不存在，`~/.zterm` 存在并持有 config。
- 这次固化的边界：以后不能再把“改 PATH / 改安装目录 / 手修 home”当成最终修复，只能回到 daemon 包和发布脚本里修真源。

# 2026-06-29 keyboard IME gap / missing display audit

- 现场截图显示同一 terminal 内容在键盘弹起和未弹起时可见区域不同，键盘弹起后像中间被错误 gap 挤掉。
- 根因：键盘布局 helper 已有 `terminal-keyboard-lift.ts` 真源，但 `TerminalPage.tsx` 里还保留一份重复实现；页面运行态仍按复制版计算。且旧逻辑在 Android WebView 已经 `adjustResize` 到键盘上方时，仍用 pre-keyboard stable height 再加一层 keyboard lift，导致 shell/stage/quickbar 混用两套高度真相。
- 修复方向：
  - 物理移除 `TerminalPage.tsx` 内重复 keyboard helper，实现改为 re-export `terminal-keyboard-lift.ts`。
  - `terminal-keyboard-lift.ts` 新增 `resolveCurrentLayoutViewportHeight()` 与 `isKeyboardViewportAlreadyResized()`；只有 stable height 明确高于当前 viewport 且 visual bottom 等于当前 viewport 时，判定 WebView 已 resize。
  - `TerminalPage` 在已 resize 模式下使用当前 viewport height 且 keyboard lift 为 0；只有 overlay 模式才使用 stable height + lift。
- 已验证：
  - `pnpm --dir android exec vitest run src/pages/terminal-keyboard-lift.test.ts src/pages/TerminalPage.android-ime.test.tsx src/pages/TerminalPage.foldable-display-change.test.tsx --reporter dot` PASS（3 files / 51 tests）。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。
- 全量 APK 构建未完成：`./scripts/build-android-debug.sh` 仍被既有 `src/contexts/SessionContext.ws-refresh.test.tsx` 阻断，表现为多条用例 `MockWebSocket.instances` 期望 1 实际 0。这个阻断此前已有记录，不是本次 keyboard layout 修改引入；在该门禁未绿前不能宣称新 APK 已生成。

# 2026-06-29 contracts parallelism blocker

- `android/package.json` 里的 `test:terminal:contracts` 在 vitest 默认多文件并发下会互相覆盖全局 `WebSocket` mock，`SessionContext.ws-refresh.test.tsx` 单跑绿，但合并跑会红。
- 修复方向：把 contracts gate 改成串行文件执行，再重新跑全量构建，避免把测试隔离问题误判成 runtime 回归。

# 2026-06-29 macbookair fresh install daemon verification

- macbookair Tailscale 真源：`macbookair.anoa-buri.ts.net` / `100.86.84.63`，当前在线，`tailscale ping` 经 DERP(cn-custom) 约 27-59ms。
- 已按 fresh install 验证，不只验证旧运行态：
  - 上传 `android/release-dist/jsonstudio-zterm-daemon-0.1.3.tgz` 到 macbookair `/tmp/`，sha256 `81932fb6d541ea763073a701c395b78a6c482585ed0125ad343a01aff4606fc2`。
  - 远端执行 `npm uninstall -g @jsonstudio/zterm-daemon` 后再 `npm install -g /tmp/jsonstudio-zterm-daemon-0.1.3.tgz`。
  - 使用新安装的 `/opt/homebrew/bin/zterm-daemon install-service` 重装同一 launchd service。
  - fresh install 后 `/health?token=...` 返回 `ok: true`，pid `9254`，uptime 约 23s，证明不是旧进程。
- 真实 WebSocket 协议验证：
  - control transport `list-sessions` 返回 `["server"]`。
  - `session-open` 返回 `session-ticket`。
  - session transport `connect` 成功，`daemonHostId=macbook-air`。
  - `buffer-head-request` 后收到 `buffer-sync`，`revision=1`，`cols=160`，`rows=51`，`lineCount=1121`。

# 2026-06-29 ConnectionPropertiesPage first-bind fix

- 现场问题：手机新增 `macbookair` server 后点 `Save` 退出，但 Connections 里不列出也不保存。
- 根因：`useAppPageState.handleSaveHost()` 已经能同步写 `bridgeSettings.servers`，但 `ConnectionPropertiesPage` 的 daemon-first 分支把“未映射 daemon”挡在了 preset 前面，首次手工绑定没有入口。
- 修复：daemon-first 在 selected daemon 没有 preset 时，直接显示可编辑的 bridgeHost/authToken；保存和 Connect 只要求“已选 daemon + 已填 host/token”，不再要求先有 preset。
- 验证：
  - `pnpm --dir android exec vitest run src/pages/ConnectionPropertiesPage.test.tsx src/hooks/useAppPageState.test.tsx src/lib/bridge-settings.test.ts src/lib/connections-server-groups.test.ts --reporter dot` PASS（38 tests）。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。

# 2026-06-29 Windows version gap audit

- 远端 smoke 仍通过：`pnpm --dir android exec tsx scripts/wezterm-backend-remote-smoke.ts` PASS，Windows host `huawei@100.75.122.121`、WezTerm `20240203-110809-5046fc22`、pane snapshot lineCount=3。
- 当前已有能力只覆盖 WezTerm `list/get-text --escapes -> buildWezTermMirrorSnapshot()`，未接入 daemon 主链。
- 关键缺口：`server.ts` 启动仍强依赖 tmux backend：`resolveTmuxBinary()`、`ensureTmuxServerRunning()`、`listTmuxSessions`、`attachTmux`、`writeToTmuxSession`、tmux capture 都是主线真源；Windows 没 tmux 时不能基础运行。
- release/npm 包也偏 macOS：prepare 脚本、shell shim、launchd service、darwin node-pty/wrtc artifact、README 都按 Darwin 固化。Windows 版需要独立 service/install owner，不能复用 launchd 包装。

# 2026-06-29 WezTerm input contract probe

- 方案 A 深测结果：`wezterm cli send-text --no-paste --pane-id <id>` 从 stdin 写原始字节可用；禁止把用户输入塞进 shell 参数。
- 已验证：
  - cmd Enter：`echo ZTERM_INPUT_ENTER_OK\r` 执行成功。
  - cmd Backspace：`echo BAD\x7fOK\r` 实际执行为 `echo BAOK`。
  - cmd Up Arrow：`\x1b[A\r` 能回放上一条 history。
  - raw-mode Node TUI 收到 `1b7f1b5b4103`，对应 Esc / DEL / Up Arrow / ETX。
  - Codex TUI 文本输入可进入输入框，未提交任务。
- 限制：ETX 能到 raw-mode/TUI，但不能作为 Windows console control event 中断 `cmd.exe /k ping -t 127.0.0.1` 这类子进程。
- 固化：新增 `scripts/wezterm-backend-input-smoke.ts`，默认测 cmd + raw TUI，`--include-codex` 额外测 Codex TUI；`requireWezTermInputContract()` 只放开 `send-text-no-paste-stdin`。

# 2026-06-29 relay default address APK leak / session group regression

- Relay 默认地址不能在 APK 中以完整文本暴露：默认地址只在运行时由 parts 拼出，Settings 输入框不再预填/placeholder 展示真实默认地址，生产 sourcemap 默认关闭；build 链路新增 `scripts/check-relay-default-address-leak.mjs` 扫 dist / native assets / APK。
- 1946 现场证伪：`TerminalPageStageShell` 放开横屏 session group、加入 “center-only 不进 group”、调整抽屉切 session 顺序，这三处一起把竖屏的上 / 中 / 下显示和滚动逻辑打坏了。1946 不是可保留的正确修复。
- 1947 热修原则：session group stage 回到 1945 行为，`TerminalPageStageShell` 只有 `!splitVisible && !landscape && sessionGroupViewport?.slots.center` 时才启用当前 mobile group stage；`TerminalPage` 抽屉选择 session 保持先切 session，再按当前 focus slot 替换槽位。当前安装验证目标应是 1947，不是 1946。
- Jason 现场确认：升级到 1947 后确实比 1946 好，1946 的“完全没办法用”问题已被回退掉；后续新改动必须以 1947 为基线继续做。

## 2026-06-29 1947 基线上的横屏 split 小步修复

- 横屏 split 顶部 tab 点击无效的高风险点：shared `PaneTabs` 在 tab `pointerdown` 前置调用 `onActivatePane()`，Android WebView 下容易在 click 前触发 pane 重渲染，表现为点击 tab 不切换、长按菜单也不稳定。
- 小步修复：`PaneTabs` 不再在 tab/pane strip 的 `pointerdown` 激活 pane；只在 pane strip 空白区 click 时激活 pane。tab 自身 click/long-press 先交给 `onSelectTab` / `onLongPressTab`。
- 为横屏底部错位加诊断，不改布局语义：状态浮窗新增 `LP` layout profile、`LS` landscape、`SP` splitVisible、`QC` quickbarCollapsed；配合已有 `SH/VV/QB/TB` 判断是 viewport、profile 还是 quickbar 占位计算错。
- 已验证：
  - `pnpm --dir android exec vitest run src/components/terminal/shared-pane-tabs.test.tsx src/components/terminal/TerminalHeader.test.tsx src/pages/TerminalPageStageShell.pane-stage.test.tsx src/pages/TerminalPage.render-scope.test.tsx --reporter dot` PASS（4 files / 48 tests）。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。
- 未完成：`./scripts/build-android-debug.sh` 仍被当前全量门禁 `src/contexts/SessionContext.ws-refresh.test.tsx` 阻断；失败表现为 32 个用例等待 `MockWebSocket.instances.length === 1` 但收到 0。本次小步 diff 不涉及 `SessionContext`，不能在该门禁未绿时发布新 APK。
- 验证：
  - `pnpm --dir android exec vitest run src/lib/terminal-layout-profile.test.ts src/pages/TerminalPageStageShell.pane-stage.test.tsx src/pages/TerminalPage.session-drawer.test.tsx src/pages/TerminalPage.render-scope.test.tsx --reporter dot` PASS（4 files / 47 tests）。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。
  - `pnpm --dir android run test:common-user-flows -- --reporter dot` PASS。
  - `pnpm --dir android run test:relay:smoke` PASS。
  - Gradle `assembleDebug` PASS。
  - update bundle PASS：`android/update-dist/zterm-0.1.3.1947.apk`，sha256 `a08283bd365bfcb352cfc37ba35d4ad241eafed9bc183dabb3bad5487004393f`。
  - `node android/scripts/check-relay-default-address-leak.mjs android/dist android/native/android/app/src/main/assets/public android/update-dist/zterm-0.1.3.1947.apk` PASS。
- 剩余：`adb devices -l` 无在线设备，缺真机安装态确认；请用 `0.1.3.1947` 复测竖屏显示和上下滚动。

# 2026-06-29 relay directory UI / route smoke slice

- 补齐 route/socket 回归：成功记录 RTT + candidate id；auth failure close 后跳过坏 direct；health TTL 过期后 direct 可以重新胜出。
- `TraversalRelayDeviceSnapshot` 兼容层保留 directory endpoints/sessions；`BridgeTarget` / `Host` / `resolveTraversalConfigFromHost()` 透传 `relayEndpointCandidates`，避免 UI 打开后丢 route truth。
- `TmuxSessionPickerSheet` 现在可直接消费 directory session catalog：无本地 bridge preset 时，选中 relay daemon 后显示目录 sessions，Open 回调携带 endpoint candidates；修复默认空数组导致的 render-loop。
- `Connections` group 现在投影 directory sessions 为显式 `directory` source，并透传 `relayEndpointCandidates` 到 open action；无 saved host 也能形成 openable session。
- smoke 增加 `routeSelection` 输出和断言：只从 directory endpoint candidates 构造 plan；无 direct endpoint 时不再把 `relayHostId` 伪造成 direct ipv4，selected route 为 `relay-rtc`。
- route diagnostics UI 已接入 Connections server group projection：`TraversalRouteHealthCache` 提供 TTL-aware `list/snapshot` 读 API；group summary 从 directory endpoint candidates + route health 计算 `Route ...` badge、RTT、last success、last error；Connections 卡片展示同一份 summary，不在 UI 层补路线真相。
- 验证：
  - required relay vitest gate PASS：13 files / 89 tests。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。
  - `pnpm --dir android exec tsx scripts/traversal-relay-local-smoke.ts` PASS；输出包含 account directory、directory stream snapshot、`routeSelection.selected.path=rtc-relay`、RTC list-sessions。
  - `./scripts/build-android-debug.sh` PASS；prebuild regression / contracts / common flows / relay smoke 已跑入构建链路。
  - update bundle PASS：`android/update-dist/zterm-0.1.3.1945.apk`、`~/.zterm/updates/zterm-0.1.3.1945.apk`、debug APK sha256 均为 `2f230f24d99269956f0f6aaa66c46c6c8c6ba3eb8f961fec34d70d7cff2c9761`。
  - `node android/scripts/verify-update-bundle.mjs` PASS；`http://127.0.0.1:3333/updates/latest.json` 与 `/updates/zterm-0.1.3.1945.apk` 均返回 200。
  - evidence：`android/evidence/relay-directory/2026-06-29/build-and-install-gap.txt`。
- 剩余：ADB 当前无在线设备（`adb devices -l` 为空），还缺真实安装态验证与手机 UI 截图/log 证据。

# 2026-06-28 relay directory daemon publish slice

- daemon relay host client 现在在 `relay-ready` 后发布 `directory-update`，目录内容来自 daemon tmux truth：`listTmuxSessions()` -> session snapshots，并至少发布 `relay-rtc:<hostId>` endpoint candidate。
- `listTmuxSessions()` 是必填注入项，不允许缺失后降级成空 sessions；tmux 枚举失败时只发送显式 `relay-error: directory-update failed: ...`，不发送 success-shaped empty directory。
- local relay smoke 已扩展为真实闭环：先创建 smoke tmux session，再注册 relay 用户，让 daemon 首次 directory publish 能枚举到目标 session；随后同时验证 `/api/directory` 与 `/ws/devices` 的 `directory-snapshot`。
- smoke 中 client device 和 daemon device 必须使用不同 `deviceId`；复用同一 id 会把 daemon directory record 的 `deviceName/platform/appVersion` 覆盖成 client metadata，形成假目录。
- 验证：
  - `pnpm --dir android exec vitest run src/server/relay-client.test.ts src/traversal-relay/store.test.ts src/traversal-relay/server.test.ts --reporter dot` PASS（10/10）。
  - `pnpm --dir android exec tsx scripts/traversal-relay-local-smoke.ts` PASS；输出包含 daemon device、client device、relay-rtc endpoint、smoke tmux session、directory stream snapshot、RTC list-sessions。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。

# 2026-06-28 relay directory client runtime slice

- Android client 现在有唯一 directory runtime owner：`src/lib/relay-account-directory.ts`。它负责 normalize account directory、拒绝 invalid snapshot、投影 daemon machines，以及把 directory 临时投影成 legacy `TraversalRelayDeviceSnapshot[]` 供现有 UI 消费。
- `traversalRelayLogin()` / `traversalRelayRefreshMe()` 现在要求 relay auth payload 包含合法 `directory`；缺失或非法时直接报错 `relay account directory missing or invalid`，不再把只有 `devices` 的响应当完整成功。
- `/ws/devices` 的 `directory-snapshot` 现在会写入 `account.directory` 并触发 `onDirectory`，App / account hook 优先用 directory projection 更新 `relayDevices`；旧 `devices` 只保留为本地存储兼容和无 directory 时的 adapter。
- 验证：
  - `pnpm --dir android exec vitest run src/lib/relay-account-directory.test.ts src/lib/traversal-relay-client.test.ts src/hooks/useTraversalRelayAccount.test.tsx src/App.relay-stream-lifecycle.test.tsx src/lib/connections-server-groups.test.ts src/pages/ConnectionsPage.test.tsx --reporter dot` PASS（44/44）。
  - `pnpm --dir android exec vitest run src/server/relay-client.test.ts src/traversal-relay/store.test.ts src/traversal-relay/server.test.ts src/lib/relay-account-directory.test.ts src/lib/traversal-relay-client.test.ts --reporter dot` PASS（18/18）。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。
  - `pnpm --dir android exec tsx scripts/traversal-relay-local-smoke.ts` PASS。

# 2026-06-28 session group boundary projection

- 当前 session group 需要两层真相：
  - 固定槽位 truth：drawer 保存 top / center / bottom，不因点击 peek 改写。
  - viewport projection truth：stage 按 focus slot 只投影可见边界，focus=top 时隐藏 top peek，focus=bottom 时隐藏 bottom peek。
- 边界可见性要下沉成共享 helper，而不是在 `TerminalStageShell` 里分别写 top/bottom 条件；未来横向 left/right 也复用同一边界投影框架。
- 这次修复的关键不是“少渲染一个按钮”，而是把“槽位内容”和“边界是否显示”拆成两个独立投影结果，避免再次出现 bottom focus 还渲染 bottom placeholder 的假状态。
- session group layout axis 默认必须按 aspect ratio：`width / height <= 0.4` 的窄竖屏强制 vertical，上下滚；宽竖屏默认 horizontal，但设置可切 vertical；landscape 永远 horizontal。这个判断属于 app-layer layout policy，不属于 drawer/session 真相。
- 横向 side peek 的 session 身份不能贴顶部；状态栏/返回按钮会遮挡。身份应放到中部安全区，标题和 host 允许两行显示。

# 2026-06-28 relay path audit

- 当前 traversal relay server store 只持久化 `users / tokens / devices`，device snapshot 只有 client/daemon 在线状态、daemon hostId/version；没有 account-scoped endpoint candidates、tmux session catalog、route metrics 或可直接消费的 websocket/session access directory。
- 客户端账号登录只把 relay token/ws/turn 与 devices snapshot 写入本地 account/settings；Connections/Session Picker 仍依赖本地 bridge server preset 才能把在线 daemon 解析成可连接 target。
- 当前 Auto 线路不是实时 best-route：`buildTraversalPlan()` 只按 `traversalPathPriority` 生成候选，`TraversalSocket` 按顺序串行连接，WS 超时 1800ms、RTC 超时 8000ms；没有 probe scoring、RTT 统计、成功路径 TTL 缓存或 per-device route health truth。

# note

## Input path audit (2026-06-19)

### Full client-side input chain
```
domInputController.handleInput() / handleBeforeInput()
  → sendTerminalInput(value)
    → onInputRef.current(sessionId, value)  [sessionIdRef.current = sessionId prop]
      → TerminalView.onInput(sessionId, data)
        → handleTerminalInput(sessionId, data)
          → sendInput(sessionId, data)      [via useSession context]
            → sendInputRuntime() / sendInputThroughSessionTransport()
              → sendSocketPayload(sessionId, ws,
                  JSON.stringify({type:'input', payload: data}))
                → WebSocket.send()           [ws.readyState === OPEN]
                  → daemon receives JSON {type:'input', payload}
                    → PTY.write(data)        [bottleneck: PTY write may block]
```

### Bottleneck analysis
- After tab switch, `scheduleInputHeadRefresh` captures stale `readSessionTransportSocket` closure.
- `queueMicrotask` delay means head refresh may target wrong transport.
- Fix: add session ID version/epoch check before `requestSessionBufferHead` call.
- `sessionIdRef.current = sessionId` updates synchronously on prop change (line 484).
- `domInputController` uses `sessionIdRef.current` on next input event → correct if no pending input.
- Risk: rapid tab switch + pending composition may route to wrong session.
- `setTimeout(0)` + `setTimeout(32)` retry → 32ms minimum latency on every commit.
- For high-frequency typing, this adds at least 32ms per batch.

### Daemon PTY write (in `server.cjs`)
```javascript
ws.on("message", (msg: Buffer | string) => {
  const input = typeof msg === "string" ? msg : msg.toString("utf-8");
  ptyProcess.write(input);  // blocking write to PTY
});
```

### Status
- TypeScript: `npx tsc --noEmit` → **No errors found** ✓
- All prior R5/R2/R1 work remains intact.
- Need: daemon source to audit PTY queue depth + write scheduling.

## 2026-06-21 自动关闭Tab根因审计

### 问题现象
- 远程 daemon 上 tmux session 仍然存在，但客户端 audit 逻辑误判为"不存在"并错误关闭 tab

### 根因链路追踪

#### 触发路径
1. `useOpenTabLifecycleEffects.ts` 监听 `SESSION_STATUS_EVENT`（type='closed'）
2. 触发 `auditOpenTabsAgainstRemoteSessions('session-status-closed')`

#### 审计链路
1. `remote-tab-audit.ts::auditOpenTabsAgainstRemoteSessions()`
2. 调用 `fetchRemoteTmuxSessionNamesByOwner()` 获取远程会话列表
3. 对每个 tab 检查 `tab.sessionName.trim()` 是否在远程会话列表中

#### 根因发现
`fetchRemoteTmuxSessionNamesByOwner()` 返回**空 Map 或空数组**，导致：
- `remoteSessionNames = []` → `!remoteSessionNames` 为 false（数组不是 falsy）
- 但 `new Set([]).has('sessionName')` = false
- tab 被标记为 missing，触发 tab 关闭

#### 失败原因分析
1. WebSocket 连接失败或超时（2500ms）
2. daemon 返回错误响应（type !== 'sessions'）
3. 客户端缓存旧结果或版本不兼容

### 修复策略
1. **门禁强化**：audit 失败时只记录 debug，不主动关闭 tab
2. **降级处理**：网络失败时不触发 tab 关闭，只保留 tab 并等待下次审计
3. **红测覆盖**：测试 WebSocket 失败、超时、错误响应场景

## 2026-06-22 升级包 404 审计

### 现象
- App 能读到 `latest.json`
- 弹窗显示 `Remote: 0.1.3.1860 / versionCode 1031860`
- 点击“立即升级”后原生插件报 `下载升级包失败：HTTP 404`

### 根因
- `android/update-dist/latest.json` 与 `~/.wterm/updates/latest.json` 都指向 `zterm-0.1.3.1860.apk`
- 但 `~/.wterm/updates/` 实际缺少该文件，只存在 `zterm-0.1.3.1862.apk` 等其他版本
- daemon HTTP `/updates/<apk>` 从 `~/.wterm/updates` 读文件；manifest 命中但文件缺失时必然 404

### 处理
- 先把 `android/update-dist/zterm-0.1.3.1860.apk` 补拷贝到 `~/.wterm/updates/zterm-0.1.3.1860.apk`
- 新增 `scripts/verify-update-bundle.mjs`
- `build-android-debug.sh` 发布后强制校验：
  - `update-dist/latest.json` 与 `~/.wterm/updates/latest.json` 版本一致
  - 两侧 versioned APK 均存在
  - 两侧 APK sha256 / size 与 manifest 一致
- `zterm-latest-debug.apk` alias 与 versioned APK 一致

### 复核结果
- 当前 daemon 更新目录已补齐 `zterm-0.1.3.1863.apk`
- `http://127.0.0.1:3333/updates/zterm-0.1.3.1863.apk` 返回 `200`
- `http://100.66.1.82:3333/updates/zterm-0.1.3.1863.apk` 返回 `200`
- `android/scripts/verify-update-bundle.mjs` 结果为 `ok: true`
- 当前 `android/update-dist/latest.json` 和 `~/.wterm/updates/latest.json` 都指向 `0.1.3.1863`

## 2026-06-22 optimization-1 构建门禁补充

### 验证结果
- `npx tsc --noEmit` PASS
- 定向红测 PASS：
  - `src/components/TerminalView.test.tsx`
  - `src/components/TerminalView.dynamic-refresh.test.tsx`
  - `src/pages/TerminalPage.render-scope.test.tsx`
  - `src/contexts/session-context-lifecycle.test.tsx`
  - `src/contexts/SessionContext.ws-refresh.test.tsx`
- `pnpm run test:terminal:contracts` PASS（`564/564`）
- `pnpm run test:terminal:regression` PASS
- `./scripts/build-android-debug.sh` PASS

### 构建链路卡点
- `capacitor-cordova-android-plugins/src/main/res/.gitkeep` 与 `src/main/java/.gitkeep` 不能在构建前删除
- 删除后 AGP `:capacitor-cordova-android-plugins:parseDebugLocalResources` 会报 `!directory.isDirectory()`
- 已移除 `build-android-debug.sh` 中删除 `.gitkeep` 的逻辑

### 当前升级包
- `android/update-dist/zterm-0.1.3.1866.apk`
- `~/.wterm/updates/zterm-0.1.3.1866.apk`
- `http://100.66.1.82:3333/updates/latest.json` 指向 `0.1.3.1866`
- `http://100.66.1.82:3333/updates/zterm-0.1.3.1866.apk` 返回 `200`

## 2026-06-22 optimization 续做：background tick / closed transport / delete gate

### 本轮改动
- `session-context-lifecycle.ts`
  - active tick 在后台改为 `1000ms` cadence，不再沿用前台 `16ms+` 刷新周期
  - passive tick 在后台只保留单条 `1000ms` timer，移除原先重复排队
  - `active-tick` 的 `allowReconnectIfUnavailable` 改为读取 `foregroundActiveRef.current`
- `session-context-core.ts`
  - `DELETE_SESSION` action 增加 `manualClose: true` 类型门禁
- `session-context-infra-runtime.ts` / `session-context-infra-facade-runtime.ts`
  - `deleteSessionSyncRuntime()` 只发送带 `manualClose: true` 的 `DELETE_SESSION`
- `session-context-transport-open-runtime.ts`
  - transport 收到 server `closed` 后，先把 session state 落到 `closed`，再发 `zterm:session-status`

### 验证
- `cd android && npx tsc --noEmit` PASS
- `cd android && pnpm exec vitest run src/contexts/session-context-lifecycle.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx src/contexts/session-context-session-runtime.test.ts` PASS
- `cd android && pnpm run test:terminal:contracts` PASS
  - `49 files / 561 tests` 全绿

### 新增红测
- `session-context-lifecycle.test.tsx`
  - `foreground=false` 时 timeout delay `>= 900ms`
- `SessionContext.ws-refresh.test.tsx`
  - websocket `closed` message 后 session state 变为 `closed`
  - 后续底层 socket close 不再重复触发 reconnect/status

### 当前缺口
- client optimization-1 还没完成 `TerminalView` 的 split 32ms RAF 节流与 `renderGeometryRevision` effect 收口
- daemon optimization-2 还没跑 throughput bench，也没交付新 APK
- 本轮只完成代码 + contracts 闭环，未构建 APK

## 2026-06-22 optimization-3 自动关闭 tab close/disconnected closeout

### 本轮改动
- `SessionState` 新增 `disconnected`，表示 transport 断开但 runtime session / OPEN_TABS 仍保留。
- daemon websocket `{ type: "closed" }` 经过 `buildSessionClosedUpdates()` 后只把 session 标记为 `disconnected`，不落成用户显式关闭态。
- `buildActiveSessionRefreshPlan()` 将 `closed/disconnected/error` 都视为 unavailable，只有 `explicit-resume` 可以恢复。
- debug UI 将 `disconnected` 显示为 closed 风格状态，但不删除 tab。

### 删除门禁审计
- 生产代码中 `deleteSessionSync()` 只有一个调用点：`closeSessionRuntime()`。
- `closeSessionRuntime()` 先执行 `manualCloseRef.current.add(sessionId)`，之后才调用 `deleteSessionSync(sessionId)`。
- `SessionAction.DELETE_SESSION` 类型要求 `manualClose: true`，`deleteSessionSyncRuntime()` 只发送该类型 action。
- 因此 daemon closed / transport detach / auditOpenTabsAgainstRemoteSessions 均没有直接删除 OPEN_TABS 的路径。

### 验证
- `cd android && npx tsc --noEmit` PASS。
- `cd android && pnpm exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx src/App.dynamic-refresh.test.tsx src/contexts/session-sync-helpers.test.ts src/contexts/session-context-activity-runtime.test.ts src/contexts/session-context-transport-open-runtime.test.ts src/contexts/session-context-lifecycle.test.tsx` PASS（279/279）。
- `cd android && pnpm exec vitest run src/contexts/session-context-session-runtime.test.ts src/contexts/session-context-core.test.ts` PASS（14/14）。
- `cd android && pnpm run test:terminal:contracts` PASS（564/564）。
- `cd android && ./scripts/build-android-debug.sh` PASS。
- 新 APK：`~/.wterm/updates/zterm-0.1.3.1869.apk`，versionCode `1031869`，sha256 `49859962c5a65dfa610b27ece2d577c97feb584875eea945d2ec1f60ee653eb9`，size `5459890`。
- HTTP 验证：
  - `http://127.0.0.1:3333/updates/latest.json` 200，APK 200。
  - `http://100.66.1.82:3333/updates/latest.json` 200，APK 200。

## 2026-06-22 升级包 404 二次修复

### 现象
- App 能检查到升级包，但点击升级下载 APK 报 HTTP 404。
- 现场弹窗仍显示旧版本 `0.1.3.1860`，而当前 daemon 更新目录已发布 `0.1.3.1866+`。

### 根因
- 文件侧已正常：`~/.wterm/updates/latest.json` 与 versioned APK 均存在。
- 客户端 `startUpdate(manifest)` 会直接使用 UI 里旧的 `availableManifest/latestManifest`，不会在安装前重新 `no-store` 拉最新 manifest。
- 因此 UI 手里的旧 `apkUrl` 可以继续被拿去下载，造成 manifest 检查成功但下载旧 APK 404。

### 修复
- `app-update-runtime.ts`
  - 新增 `refreshing-manifest` stage。
  - `startUpdate()` 在 native support / backup / install 前必须重新拉 `snapshot.preferences.manifestUrl`。
  - 校验最新 manifest 的 `versionCode + sha256` 与用户确认安装的目标一致，否则中止并提示重新检查更新。
  - 真实下载只使用刚复核的 manifest URL，避免 stale host / stale APK。
- `app-update-runtime.test.ts`
  - 红测：旧 install target 被最新 manifest 拒绝，且不会 backup / download。
  - 正测：同版本同 sha 时安装使用复核后的同源 URL，不使用旧 snapshot apkUrl。

### 验证
- `cd android && npx tsc --noEmit` PASS。
- `cd android && pnpm exec vitest run src/lib/app-update-runtime.test.ts src/hooks/useAppUpdate.test.tsx` PASS（12/12）。
- `cd android && pnpm run test:terminal:contracts` PASS（564/564）。
- `cd android && ./scripts/build-android-debug.sh` PASS。
- 新升级包：
  - `android/update-dist/zterm-0.1.3.1868.apk`
  - `~/.wterm/updates/zterm-0.1.3.1868.apk`
  - versionCode `1031868`
  - sha256 `8f7826a51675465197dae6f3f2256c4ac19035d6ada54c86e73ceb41bba0aa00`
  - size `5459886`
- HTTP:
  - `http://127.0.0.1:3333/updates/latest.json` 200，APK 200。
  - `http://100.66.1.82:3333/updates/latest.json` 200，返回 apkUrl host 为 `100.66.1.82`，APK 200。

## 2026-06-27 session drawer 新 session 按钮回归

### 现象
- portrait terminal session drawer 底部 `New Session` 按钮在真机上看起来无响应。

### 当前判断
- 按钮现在同时挂了 `pointerup` / `touchend` / `click`，还加了 600ms 去重。
- 这类多路事件 + 时间戳门禁在 Android WebView 上容易把真实点击链路吞掉。

### 修复方向
- 收敛成单一 `click` owner。
- `touch` 只保留给 drawer 滑动关闭，不再负责 new session 打开。

### 回归锁定
- 抽屉 add 按钮：`touchEnd` 不再触发打开，`click` 才是唯一语义 owner。

## 2026-06-27 Android IME 特殊键回归

### 现象
- 输入法/终端键盘里的 `Esc`、`Backspace` 等特殊键在真机上无效。

### 根因判断
- JS `TerminalPage` 已有 `ImeAnchor` 的 `input / backspace / key` 三条监听。
- shared renderer 也已能把 `Escape -> \x1b`、`Backspace -> \x7f`、`Delete -> \x1b[3~` 映射成终端序列。
- Native `ImeAnchorPlugin` 的 hardware key mapping 没锁住 `KEYCODE_DEL` / `KEYCODE_FORWARD_DEL`，部分输入法或硬件路径会把 Backspace/Delete 作为 keyCode 送到 `onKeyDown`，未进入 `backspace` listener。

### 修复方向
- native mapping 增加 `KEYCODE_DEL -> Backspace`、`KEYCODE_FORWARD_DEL -> Delete`。
- JS 回归锁住 `ImeAnchor key` payload 的 `Escape / Backspace / Delete / Ctrl+C` 都路由到当前 active session。

## 2026-06-22 升级包 404 现场复核（0.1.3.1872）

### 现场证据
- `android/update-dist/latest.json` 当前指向 `zterm-0.1.3.1872.apk`，`apkUrl` 为相对路径。
- `http://127.0.0.1:3333/updates/latest.json` 返回 200，manifest 与 `0.1.3.1872` 一致。
- `http://127.0.0.1:3333/updates/zterm-0.1.3.1872.apk` 返回 200。

### 结论
- 当前 daemon 更新服务侧没有 404。
- 若手机侧仍报 404，优先怀疑是旧客户端拿到了旧 manifest / 旧 apkUrl，而不是当前 daemon 路由本身失效。

## 2026-06-22 升级包 404 现场复核

### 当前核验
- `android/update-dist/latest.json` 与 `~/.wterm/updates/latest.json` 目前都指向 `zterm-0.1.3.1869.apk`
- 对应 APK 文件在两侧都存在
- `http://127.0.0.1:3333/updates/latest.json` 返回 200
- `http://127.0.0.1:3333/updates/zterm-0.1.3.1869.apk` 返回 200

### 结论
- 现阶段服务端升级包发布链路正常，当前 404 不是“包没落盘”导致
- 若设备端仍报 404，优先怀疑客户端持有旧 manifest / 旧 apkUrl，或请求到了别的更新源

## 2026-06-22 upgrade 404 follow-up
- 现象：manifest 命中，但安装侧仍可能拿旧 manifestUrl/旧 apkUrl。
- 当前修复：AppUpdatePlugin 失败信息增强，app-update-runtime 记录 lastInstallContext，App.tsx 移除 relay 二次派生残留。
- 验证：tsc clean；app-update-runtime 定向红测通过；verify-update-bundle 通过。

## 2026-06-22 升级包 404 真源：daemon 不得改写 manifest apkUrl
- 现场：`http://127.0.0.1:3333/updates/latest.json` 曾把 `apkUrl` 改成 `http://127.0.0.1:3333/updates/zterm-0.1.3.1871.apk`；手机拿到该绝对 URL 后会指向手机自己的回环地址，导致升级包下载 404。
- 真源：`android/src/server/terminal-http-runtime.ts::handleHttpRequest('/updates/latest.json')` 历史逻辑会把相对 apkUrl 重写成 `${origin}/updates/<apk>`。
- 修复：daemon 原样输出 build pipeline 写入的 manifest；唯一允许的 apkUrl 绝对化位置是 client `app-update-runtime.ts` 对 `manifestUrl` 执行 `new URL(payload.apkUrl, manifestUrl).toString()`。
- 红测：`android/src/server/server.http-truth.test.ts` 禁止 `/updates/latest.json` 路由再次出现 `${origin}/updates/<file>` 重写。
- 验证：`pnpm exec vitest run src/server/server.http-truth.test.ts` PASS（4/4）；`pnpm run type-check` PASS；`node scripts/verify-update-bundle.mjs` PASS；`bash scripts/zterm-daemon.sh restart` 已重新 stage `~/.wterm/daemon-runtime/server.cjs`；`curl http://127.0.0.1:3333/updates/latest.json` 返回相对 `apkUrl: "zterm-0.1.3.1871.apk"`；`curl -I http://127.0.0.1:3333/updates/zterm-0.1.3.1871.apk` 与 `curl -I http://100.66.1.82:3333/updates/zterm-0.1.3.1871.apk` 均为 200。

## 2026-06-22 optimization-2 阶段进展：head-request 首次 revision fanout 收口
- 现状核验：`terminal-message-runtime.ts` 的 `buffer-head-request` 仍经 `sendBufferHeadToSession(session, mirror)` 路由，但过去 `terminal-mirror-runtime.ts::sendBufferHeadToSession()` 是单 session 私有回包路径，8 个订阅者同时探头时会重复走 head fanout。
- 本轮修复：`android/src/server/terminal-mirror-runtime.ts`
  - 新增 mirror 级 `WeakMap<SessionMirror, { revision }>` head broadcast cache。

## 2026-06-24 图片/文件 picker 与 missing-session audit 二次收口（1896）

### 用户现场
- 1892/1893/1894 包在真机上“看起来没变化”：
  - 点击 `图片` / `文件` 没有任何弹窗
  - 缺失 session 灰显/一键关闭在现场不可见

### 本轮根因
- `TerminalQuickBar.tsx`
  - picker 仍依赖对完全隐藏 `display:none` 的 `input[type=file]` 做程序化 `click()`
  - Android WebView 下这类 input 很容易直接不弹系统 picker
  - 旧实现还把 `Keyboard.hide()` 混在同一路径里，真机上更难判断点击链是否丢失
- `remote-tab-audit.ts`
  - `fetchRemoteTmuxSessionNamesByOwner()` 返回空数组时，历史逻辑仍会把空数组当成远端真相去 prune
  - 这会让“远端返回未知/失败”错误投影成“session 不存在”

### 本轮代码修复
- `android/src/components/terminal/TerminalQuickBar.tsx`
  - picker 入口改成同手势栈内直接触发：优先 `showPicker()`，否则 `input.click()`
  - 触发后再异步 `Keyboard.hide()`
  - 文件 input 从 `display:none` 改成“视觉隐藏但仍在文档流可触发”的样式
- `android/src/lib/remote-tab-audit.ts`
  - 远端结果为空数组时不再 prune，也不再把 tab 标成 missing

### 白盒 / 黑盒验证
- `cd android && pnpm exec vitest run src/components/terminal/TerminalQuickBar.test.tsx src/lib/remote-tab-audit.test.ts src/pages/TerminalPage.real-quickbar-split.test.tsx src/pages/ConnectionsPage.test.tsx`
  - `PASS (78) FAIL (0)`
- `cd android && pnpm run type-check`
  - PASS
- `cd android && ./scripts/build-android-debug.sh`
  - PASS
  - build number: `1896`

### 升级链路证据
- `android/update-dist/latest.json` 与 `~/.zterm/updates/latest.json` 都指向 `zterm-0.1.3.1896.apk`
- `android/update-dist/zterm-0.1.3.1896.apk`
- `android/release-dist/zterm-0.1.3.1896.apk`
- `~/.zterm/updates/zterm-0.1.3.1896.apk`
- `curl http://127.0.0.1:3333/updates/latest.json`
  - 返回 `versionName=0.1.3.1896`
- `curl -I http://127.0.0.1:3333/updates/zterm-0.1.3.1896.apk`
  - `HTTP/1.1 200 OK`

### 仍待真机确认
- 自动回归已覆盖“真实 TerminalPage -> QuickBar -> 文件输入 -> onImagePaste/onFileAttach”黑盒链路
- 但是否完全命中 Jason 手上的那台 Android WebView 行为，仍需 Jason 用 1896 包现场点一次确认

## 2026-06-23 copy 现场复核

### 现象
- Jason 现场反馈：复制功能在真机上仍不可用。

### 当前确认
- JS copy-mode 链路仍在：
  - `TerminalView.tsx` 在 `copyModeActive` 下仍注册 row 级 `onTouchStart/onPointerDown` 长按计时，420ms 后调用 `onLongPressRow(...)`。
  - `useTerminalPageCopyRuntime.ts` 仍会把选区文本写入 `DeviceClipboardPlugin` / `navigator.clipboard`。
- 现有 jsdom 红测全绿，但这些测试不覆盖 Android 原生 `WebView` 的长按边界。

### 新怀疑根因
- `android/native/android/app/src/main/java/com/zterm/android/MainActivity.java` 之前对整个 `WebView` 设置了 `setOnLongClickListener(v -> true)`。
- 这会在原生边界吞掉真实设备上的长按，导致系统菜单被禁用的同时，DOM copy-mode 长按也可能收不到。

### 本轮处理
- 移除 `MainActivity` 对整个 `WebView` 的全局 long-click consume，改回只保留滚动条 / overscroll 配置。
- copy-mode 的"禁系统菜单"继续留在 DOM/React 层做，不在 native WebView 边界全局吞事件。

## 2026-06-23 copy 现场复核二：震动但无菜单

### 现象
- 1882 版本：启用 copy mode 后长按有震动，但菜单不弹出。

### 根因
- `setOnLongClickListener(v -> true)` 虽然禁了系统菜单，但 Android WebView 仍触发原生长按 haptic + touch 拦截，JS 的 `onTouchStart` 收不到完整 touch 序列，420ms timer 无法正常 fire。

### 修复
- `MainActivity.java`: 改为 `wv.setLongClickable(false)`。
  - 不再触发原生长按 haptic / 选择手柄。
  - touch 事件完整传给 DOM，JS copy-mode `startCopyLongPressTouch` 可以正常启动 420ms timer → `onLongPressRow` → 菜单弹出。

### 验证
- `cd android && npx tsc --noEmit` PASS
- `cd android && pnpm run test:terminal:contracts` PASS (566/566)
- `./scripts/build-android-debug.sh` PASS
- APK: `zterm-0.1.3.1885` (versionCode `1031885`)
- 缺口：Jason 现场复测长按菜单是否弹出；真机震动应消失。
  - `sendBufferHeadToSession()` 改为：某 revision 第一次 head probe 先 `broadcastBufferHeadToSubscribers(mirror)`，同 revision 后续 probe 只回 requester，不再重复 fanout。
  - `broadcastBufferHeadToSubscribers()` 广播时写入 revision cache，后续 cursor/body 更新后的广播仍会刷新该 cache。
- 红测：
  - `android/src/server/terminal-mirror-runtime.test.ts`
  - 新增用例：同 revision 第一次 `sendBufferHeadToSession()` 要对两个 subscriber 都发 `buffer-head`；第二次同 revision probe 只回 requester。
- 验证：
  - `pnpm exec vitest run src/server/terminal-mirror-runtime.test.ts src/server/terminal-message-runtime.test.ts` PASS。
  - `pnpm run type-check` PASS。
  - `pnpm run test:terminal:contracts` PASS（566 tests）。
  - `bash scripts/zterm-daemon.sh restart` 已重新 stage 新 daemon runtime。
  - `mac/scripts/daemon-throughput-bench.ts --subs=8 --duration=10`：
    - aggregate `headProbes=28472`
    - baseline 文档记录修复前 `17428`
    - 当前总 probe 数已超过 objective 门槛 `24000`
  - `./scripts/build-android-debug.sh` PASS，升级包发布：
    - `android/update-dist/zterm-0.1.3.1872.apk`
    - `~/.wterm/updates/zterm-0.1.3.1872.apk`
    - `versionCode=1031872`
    - `sha256=738535420ee9c618a2aa25c637026b61ee29d5d28d7265c0be1d7836dd92bef8`

## 2026-06-22 session drawer 多机场景 + Android copy-mode 系统菜单
### session drawer 收口
- `TerminalSessionDrawerItem` 新增 `hostKey/hostLabel` 显式字段，drawer 内部不再隐式从 bridge 派生
- `TerminalPage.drawerSessions` 按 `bridgeHost:bridgePort` 注入 hostKey；hostLabel 优先取该 host 上 customName
- 单机场景：归入 `default` 分组，host rail 不显示
- 多机场景：host rail pill 切换，default 选中 active session 所在 host
- 排序：已打开 session 按 pane 顺序排前面，未打开 session 按名字排后面
- 红测：5/5 PASS（基础 + 多机 rail + 多机切换 + 单 host 无 rail + 顺序保持）
### Android 拷贝系统菜单拦截
- 根因：WebView `setOnLongClickListener` 未设置，Android 原生长按触发系统上下文菜单
- 修复：`MainActivity.onCreate` 设置 `webView.setOnLongClickListener(v -> true)` + `setLongClickable(true)`，由 JS copy-mode 完全接管长按
- 升级包：zterm-0.1.3.1882.apk，sha256=4f5745d1662ba844017f46f314d3541c0e1bcb6329e74b67d93378936651cd40
- HTTP 200，update channel 正常

## 2026-06-23 daemon 自启 + tmux socket 标准化

### 诊断结果
- **daemon 自启**：实际已正常工作。launchd plist 存在，`RunAtLoad=true`，进程在跑。误报。
- **tmux socket 标准化**：默认在 `/private/tmp/tmux-501/default`，系统重启清空。
- **重启后连不上**：daemon 在跑但 tmux server 没 auto-start。daemon 启动时不自动 `tmux start-server`。

### 改动
1. `terminal-control-runtime.ts`：
   - `cleanEnv()` 加 `TMUX_TMPDIR=~/.wterm/tmux/`
   - 新增 `resolveTmuxSocketDir()` 函数
   - 新增 `ensureTmuxServerRunning()` — 创建目录 + start-server + list-sessions
   - deps 新增可选 `tmuxSocketDir`
2. `server.ts`：
   - 传入 `tmuxSocketDir: join(WTERM_HOME_DIR, 'tmux')`
   - 创建 terminalControlRuntime 后立即调用 `ensureTmuxServerRunning()`

### 验证
- `npx tsc --noEmit` PASS
- `pnpm run test:terminal:contracts` 50 files / 566 tests PASS
- daemon restart 后 socket 路径变为 `~/.wterm/tmux/tmux-501/default`
- `listTmuxSessions()` 正确返回新路径下的 sessions
- daemon health endpoint 正常

### 剩余风险
- 现有 tmux sessions 在旧路径 `/private/tmp/tmux-501/` 上，不会被新 daemon 看到
- 用户需手动迁移旧 sessions 到新路径，或等待旧 tmux server 自然消亡

### 修正：tmux socket 策略
- **第一版错误**：强制设 `TMUX_TMPDIR=~/.wterm/tmux/` → daemon 重启后创建了新 server 在新路径，看不到用户已有 sessions（demo-shell, routecodex）
- **正确方案**：`ensureTmuxServerRunning()` 先检测已有 tmux server（不设 TMUX_TMPDIR）
  - 有 server → 复用，不设 TMUX_TMPDIR
  - 无 server → 创建标准化路径 ~/.wterm/tmux/，设 TMUX_TMPDIR
- 新增 `runTmuxWithEnv()` helper 用于检测阶段
- 新增 `detectedSocketDir` 模块级变���控制 cleanEnv 行为

## 2026-06-23 copy 现场复核三：1885 仍弹系统工具栏

### 现场
- 1885 启用 copy 后长按：系统"全选 / 剪切 / 复制 / 分享 / AI 写作"浮动工具栏仍弹出。
- 我自己的 JS copy menu 未出现。

### 根因复盘
- 1885 用 `setLongClickable(false)`：不阻止 WebView 触发文本 selection，Android 仍然进入 ActionMode。
- 1882 用 `setOnLongClickListener(v -> true)`：会阻止系统 ActionMode。
- 1889（本轮）回退到 1882 同款 native 配置：`setLongClickable(true)` + `setOnLongClickListener(v -> true)`。

### publish
- `zterm-0.1.3.1889` (versionCode `1031889`)
- sha256: `3bb0d14d69d082381b32f42b1697b9d341cef554390880cea6282855505dca7b`
- HTTP 200, daemon update channel ready

### 缺口
- Jason 现场复测长按是否弹 JS copy 菜单（4 颗按钮胶囊"设为起点 / 设为终点 / 复制 / 关闭"）。
- 如果 JS 菜单仍未出现，下一轮直接追 `useTerminalPageCopyRuntime.handleLongPressCopyRow` 和 `TerminalPageCopyMenu` 渲染分支。

## 2026-06-24 daemon 重启后 sessions 列表空 - 根因 + 修复

### 现象
- 系统重启后 daemon 自动启动（launchd），但客户端 ws list-sessions 返回 []
- daemon stderr: `failed to release tmux window-size ownership for demo: no server running on /Users/fanzhang/.zterm/tmux/tmux-501/default`
- 用户手动 `tmux list-sessions` 仍能看到 `demo`

### 根因链路
1. 用户登录后手动启 `tmux` → server 挂在 `/tmp/tmux-501/default`，session `demo`
2. launchd 重启后先于用户登录启动 daemon → 此时 `/tmp/` 下还没有 user tmux server
3. 旧 `ensureTmuxServerRunning()` 看到默认 socket 没 server → 走 `detectTmuxSocketDir()` → `~/.zterm/tmux` → `mkdir` → `TMUX_TMPDIR=~/.zterm/tmux` → `start-server`
4. tmux 3.6a 的 `start-server` 是"启动 server 但立刻退出 client"的命令。**没有 live session 时 server 也会跟着退出**。
5. 用户登录后手动 tmux 启了 `demo` → 出现在 `/tmp/tmux-501/default` socket
6. daemon 用 `TMUX_TMPDIR=~/.zterm/tmux` 找自己的 socket → 找不到 server（因为 start-server 后 server 进程被 abort 了）→ 每次都报 "no server running"
7. 用户和 daemon 用的是两个 socket，互相看不见

### 修复
1. `cleanEnv()` 移除 `TMUX_TMPDIR` 设置（避免 launchd 继承污染）
2. `detectTmuxSocketDir()` → `detectTmuxSocketPath()`，固定 socket 路径为 `~/.zterm/tmux/tmux.sock`（之前是目录）
3. `runTmux()` / `runTmuxAsync()` 强制 prepend `-S <socketPath>`，避开 `tmux-501` 子目录、跨用户隔离
4. `ensureTmuxServerRunning()` 改用 `new-session -d -s zterm-daemon-keepalive` 起一个 keepalive session，避免 tmux server 自动退出
5. `HIDDEN_TMUX_SESSIONS` 加 `zterm-daemon-keepalive`，避免暴露给客户端
6. launchd runner 加 `-u TMUX_TMPDIR`（防环境变量污染）

### 验证
- daemon 启动后 `tmux list-sessions -S ~/.zterm/tmux/tmux.sock` → 返回 keepalive
- 客户端 ws list-sessions → 过滤后空（user session `demo` 在另一个 socket，不在 daemon 控制内；用户需要通过 daemon 客户端新建 tab 才会出现在 daemon socket）

### 待办
- 用户手动启的 `demo` 不会被 daemon 看到。这是有意为之（daemon 不能接管 user-managed tmux server，否则会和用户 shell 抢 PTY）。文档需说明：用户应在 daemon 控制下打开 session，或用 `zterm attach <name>` 把 user session 迁移到 daemon socket

## 2026-06-24 APK upgrade path publish audit

### 当前真相
- `android/.build-meta.json` 已升到 `1891`
- `android/update-dist/latest.json`、`android/release-dist/latest.json`、`~/.zterm/updates/latest.json` 仍停在 `0.1.3.1890`
- build 失败点：`src/server/terminal-control-runtime.ts` 残留未使用 import `mkdirSync` / `join`

### 本轮动作
- 先删掉 TS6133 阻塞 import
- 然后重跑 `./scripts/build-android-debug.sh`
- 必须验证 `update-dist` / `release-dist` / `~/.zterm/updates` 三处 manifest 和 versioned APK 一致后，才能宣称新 APK 已进入升级路径

### 验证结果
- `./scripts/build-android-debug.sh` PASS
- `pnpm run test:terminal:regression:core` PASS
- `pnpm run test:terminal:contracts` PASS（50 files / 566 tests）
- `pnpm run test:common-user-flows` PASS（7 files / 85 tests）
- `pnpm run test:relay:smoke` PASS
- `android/update-dist/latest.json` / `android/release-dist/latest.json` / `~/.zterm/updates/latest.json` 已统一到：
  - `versionName=0.1.3.1892`
  - `versionCode=1031892`
  - `sha256=735d9ba8a263ac94d21ba64b604c7e4814eb8d8a2380e1ebe663cfb1020dac57`
  - `size=5473686`
- versioned APK 已落三处：
  - `android/update-dist/zterm-0.1.3.1892.apk`
  - `android/release-dist/zterm-0.1.3.1892.apk`
  - `~/.zterm/updates/zterm-0.1.3.1892.apk`
- `scripts/verify-update-bundle.mjs` 返回 `ok: true`
- `curl http://127.0.0.1:3333/updates/latest.json` 返回 `1892` manifest
- `curl -I http://127.0.0.1:3333/updates/zterm-0.1.3.1892.apk` 返回 `HTTP/1.1 200 OK`

## 2026-06-24 image/file picker regression + missing-session visibility

### 现象
- `1892`：QuickBar 点“图片/文件”后真机无任何 picker 弹出
- 缺失 session 的灰色状态和 `Close missing` 虽然代码在，但埋在 group 展开层，卡片主体默认直接 open，用户难以进入缺失态处理路径

### 根因
- `TerminalQuickBar.tsx` 在 Android native + keyboard visible 路径走了 `Keyboard.hide() -> setTimeout(350) -> input.click()`
- 这个延迟 click 已脱离用户手势上下文，Android WebView 会吞掉 file/image picker
- `ConnectionsPage.tsx` 对 missing session group 的 card body 仍绑定“直接 open”，不是“先进入缺失态 review”

### 修复
- 图片/文件 picker 改为：同一点击栈内立即 `input.click()`，键盘只异步 `Keyboard.hide()`，不再 `setTimeout(350)`
- missing session group card：
  - preview / accent 直接显示 `N missing`
  - card 主体点击优先展开 group，让灰色 session 和 `Close missing` 直接可见
  - action button 仍保留 `Open/Enter` 语义

### 验证
- `pnpm exec vitest run src/components/terminal/TerminalQuickBar.test.tsx src/pages/ConnectionsPage.test.tsx` PASS（68/68）
- 新增门禁：
  - native + keyboard visible 时，图片/文件按钮点击后必须立刻触发隐藏 file input 的 click，不允许依赖延时 timer
  - missing-session group card 必须在卡片级暴露 `1 missing`，点击卡片主体进入展开 review，而不是盲目 open
- `./scripts/build-android-debug.sh` PASS
- `pnpm run test:terminal:contracts` PASS（566/566）
- `pnpm run test:common-user-flows` PASS（86/86）
- `pnpm run test:relay:smoke` PASS
- 新 APK：
  - `android/update-dist/zterm-0.1.3.1893.apk`
  - `android/release-dist/zterm-0.1.3.1893.apk`
  - `~/.zterm/updates/zterm-0.1.3.1893.apk`
- 三处 manifest 一致：
  - `versionName=0.1.3.1893`
  - `versionCode=1031893`
  - `sha256=1bdcd1c434acd9400496aa4036090be89bc403008ee709dff6b1d3b5eabc84ca`
  - `size=5473918`
- `curl http://127.0.0.1:3333/updates/latest.json` 返回 `1893`
- `curl -I http://127.0.0.1:3333/updates/zterm-0.1.3.1893.apk` 返回 `HTTP/1.1 200 OK`

### 追加测试设计修正（白盒 + 黑盒）
- Jason 反馈：之前测试只验证“函数被调用”，不够，必须分白盒与黑盒
- 白盒：
  - `TerminalQuickBar.test.tsx`
  - native + keyboard visible 下，`图片/文件` 点击后必须**在 `Keyboard.hide()` resolve 之前**同步触发隐藏 input 的 `click()`
  - 这条门专门防 `setTimeout(...) -> input.click()` 这类脱离用户手势上下文的错误实现复活
- 黑盒：
  - `TerminalPage.real-quickbar-split.test.tsx`
  - 通过真实 `TerminalPage -> TerminalQuickBar` 路径点击 `图片/文件`，再用用户侧 `change(file)` 验证 `onImagePaste/onFileAttach` 真正收到目标 session 和文件
  - `ConnectionsPage.test.tsx`
  - 通过卡片主体点击验证 missing-session group 不再盲目 open，而是进入 review 展开态并暴露 `Close missing`
- 当前测试门结果：
  - `TerminalQuickBar.test.tsx + TerminalPage.real-quickbar-split.test.tsx + ConnectionsPage.test.tsx` PASS（72/72）
  - `pnpm run type-check` PASS

## 2026-06-25: TUI bottom lines not refreshing

### Symptom
TUI (vim/htop/etc) bottom input area (status line / command line) never refreshes.
Lines are rendered but content is permanently stale.

### Investigation done
- TerminalView.tsx → buildTerminalRenderFrame → buildTerminalRenderRows chain traced
- `followDemandAnchorEndIndex` = `bufferTailAnchorEndIndex` = `max(startIndex, bufferTailEndIndex || effectiveBufferEndIndex)`
- `followVisualBottomIndex = min(anchor, effectiveBufferEndIndex)`
- If `bufferTailEndIndex` is stale → `followVisualBottomIndex` stuck → bottom lines outside visible window
- `projectRenderBuffer` in session-render-gate.ts reuses rows via `rowsEqual` — if buffer revision doesn't change, stale rows persist
- `applyBufferSyncToSessionBuffer` in shared/terminal-buffer.ts: `bufferTailEndIndex` from `resolveAuthoritativeTailEndIndex` uses `max(current.bufferTailEndIndex, sparseWindow.endIndex)`
- `trimToCache` limits buffer window to `cacheLines` — could trim bottom if `bufferTailEndIndex` is wrong
- `renderEndOffset = min(totalRows, visibleStartOffset + viewportRows + overscan)` — if totalRows > bufferLines.length, render tries to extend beyond available data

### Hypothesis
Most likely: `bufferTailEndIndex` in the render buffer snapshot is stale/frozen, causing `followDemandAnchorEndIndex` to clamp `followVisualBottomIndex` below the actual buffer end. This means the renderer's visible window bottom doesn't reach the latest lines.

### Next steps
1. Add runtime debug logging to trace `bufferTailEndIndex` vs `effectiveBufferEndIndex` vs `followVisualBottomIndex` at runtime
2. Check if `bufferTailEndIndex` updates when TUI redraws in place (same line count, different content)
3. The fix is likely in `@zterm/shared` package — NOT in the Android app layer
4. Need to verify whether daemon sends updated `availableEndIndex` when content changes without scrolling

### Root cause hypothesis (refined)
The render buffer store uses `renderBuffersEqual()` to detect changes.
This checks `revision` first, then `rowsEqual` per-cell.
If daemon sends updated content for in-place TUI redraw, the chain SHOULD work.
BUT if daemon's `revision` field doesn't increment for in-place redraws, the render gate's
`projectRenderBuffer` might short-circuit row comparison and reuse old row references.
The `reusedRowMask` logic in `projectRenderBuffer` compares `rowsEqual(row, previousProjectedRow)`
where `row` is from `buffer.lines` (live buffer) and `previousProjectedRow` is from previous render projection.
If these are reference-equal (from previous clone), the row is marked reused and NOT re-cloned.

Key question: does the live buffer's `lines[offset]` get a NEW cell array reference when content changes in place?
If `applyBufferSyncToSessionBuffer` creates new cell arrays only when new payload data arrives,
but the payload's lines cover the same range, the cells SHOULD be new references.

Need runtime debug to confirm:
1. `session.render-gate.flush.inspect` → liveBuffer vs projected comparison
2. Whether `bufferTailEndIndex` advances when TUI redraws in place
3. Whether `effectiveBufferEndIndex` matches actual buffer content length

## 2026-06-25 current audit

- Current uncommitted changes are regression tests and notes for TUI bottom stale repaint, not a new copy-code patch.
- Copy-mode truth to keep: native WebView long-press is a two-gate problem; `setOnLongClickListener(v -> true)` only suppresses ActionMode, `setLongClickable(false)` is the gate that restores JS long-press delivery.

## 2026-06-27 copy coupling audit

- Repeated copy regressions came from cross-layer gesture ownership drifting into multiple places.
- Current cleanup direction: copy long-press constants/move threshold live in `terminal-copy-gesture.ts`; QuickBar shell event filtering lives in `terminal-quickbar-shell-guards.ts`; copy runtime owns selection state only.
- Removed `[CopyTrace]` console logs from runtime path; debug evidence should use structured overlay/log gates, not production console spam.

## 2026-06-27 session drawer New Session 再回归

### 重新确认
- drawer 到 `onOpenQuickTabPicker -> pickerMode='quick-tab'` 的调用链是通的，问题不在 `TerminalPage` / `App` 桥接层。
- 真机点击 `New Session` 的失败点更像是 Android WebView 下 `click` / `pointerup` 没有稳定穿透到这个 drawer 按钮。

### 修复
- `TerminalSessionDrawer` 底部按钮改成自身单一 `touchend` owner，并 `stopPropagation()` 截断父级 drawer 手势。

## 2026-06-30 terminal stale rows during large refresh

- 现场现象：大面积刷新时有两行旧内容被跳过，并随着 buffer 刷新持续上移。
- 本轮审计排除点：`TerminalView` 行 key 已按 `absoluteIndex`，不是 viewport index；`buildTerminalRenderRows` 的窗口平移最小场景能正确重锚。
- 可复现根因路径：client 本地 revision 若从 5 直接收到 daemon revision 8 的 sparse `buffer-sync`，当前实现仍把 sparse diff 写入本地 buffer；未覆盖的旧行会被当成本地 truth 保留，之后 sparse diff 继续叠加时旧行就可能永久存在。
- 修复：`applyIncomingBufferSyncRuntime` 增加 `revision gap + sparse payload` 门禁。发现非连续 revision 且 payload 未覆盖完整窗口时，不 commit 该 sparse diff，不触发 renderer；清掉 tail-refresh debounce 后请求 daemon 当前 authoritative tail window。
- 反向锁定：连续 revision sparse diff 仍正常 commit/render，不把正常高频 diff 误判为漏帧。
- 回归测试从 `click/pointerUp` 改为 `touchEnd`，锁 `TerminalSessionDrawer` 与 `TerminalPage.session-drawer` 两层。

### 已验证
- `pnpm exec vitest run src/components/terminal/TerminalSessionDrawer.test.tsx src/pages/TerminalPage.session-drawer.test.tsx --reporter=dot` PASS
- `pnpm exec tsc --noEmit` PASS

## 2026-06-27 session drawer 真机诊断变量 + picker 自动刷新

### 诊断变量
- `TerminalSessionDrawer` 新增只记录不改变语义的事件探针：`drawer:touchstart/touchend`、`add:touchstart/touchend/pointerdown/pointerup/click/callback`。
- `TerminalPage` 状态浮窗新增 `DR/EV/CB/PM`：
  - `DR`: drawer 是否打开
  - `EV`: 最近事件序号与名称
  - `CB`: drawer 回调数 / page open-picker 回调数
  - `PM`: App pickerMode
- Jason 可先打开“状态”浮窗，再点击 drawer 底部 `New Session`，截图对比点击前后定位事件是否进入、回调是否进入、pickerMode 是否变化。
- 2026-06-27 真机截图显示 `EV 4:drawer:touchstart`、没有 `add:*`，说明事件进入 drawer 容器但没有进入原 inner button；Jason 明确排除“遮挡导致不弹框”。正确方向不是继续猜 `click/pointer/touch`，而是把语义 owner 放到实际可命中的 footer 触达面，并把 capture target 打进状态浮窗。
- 修复：`TerminalSessionDrawer` 将 `terminal-session-drawer-add` 从内部 button 上移到整个 footer hit surface；footer 自身作为唯一 `touchend` owner 触发 `onOpenQuickTabPicker()`，同时保留 `cap:start/end:<target>` 与 `add:capstart/capend` 诊断。`bottomInsetPx` 只作为布局避让输入，不再作为根因结论。

### picker 行为
- session picker 打开后若已有明确 `bridgeHost + authToken`，自动刷新 tmux session，不再要求每次人工点 `Connect`。
- picker row 统一合并 open tabs，不再只在 quick-tab 模式合并，减少“daemon session 列表 + 已打开 tab 列表”双列表心智。
- daemon 成功枚举后，目标 owner 下未出现在远端 session 列表中的 open tab 自动用 `session-picker-remote-missing` 关闭。

### 已验证
- `pnpm exec vitest run src/components/terminal/TerminalSessionDrawer.test.tsx src/pages/TerminalPage.session-drawer.test.tsx src/components/tmux/tmux-session-picker-rows.test.ts --reporter=dot` PASS
- `pnpm exec tsc --noEmit` PASS
- `./scripts/build-android-debug.sh` PASS，发布 `0.1.3.1923`。
- Jason 真机安装验证：drawer 内 `New Session` 点击后 picker 已能弹出，修复生效。

## 2026-06-28 adaptive-phone 启动读取缺口

### 现象
- Settings 中已保存 `terminalWidthMode=adaptive-phone` 后，App 启动第一次进入 terminal 仍按 `mirror-fixed` 宽度连接/排版。
- 只有重新进入 Settings 并 save 一次后，排版才按手机屏幕宽度生效。

### 根因
- `packages/shared/src/react/use-bridge-settings-storage.ts` 初始 state 固定为 `DEFAULT_BRIDGE_SETTINGS`，其中 `terminalWidthMode` 默认是 `mirror-fixed`。
- localStorage 里的真实 `BridgeSettings` 只在 mount 后 `useEffect` 异步读取。
- SessionProvider / restore / connect 的首帧可能已经消费了默认 `mirror-fixed`，所以启动时没有把已保存的 `adaptive-phone` 带入运行态。

### 修复
- `useBridgeSettingsStorage` 改为 lazy initializer 同步读取 `localStorage[STORAGE_KEYS.BRIDGE_SETTINGS]` 并 `normalizeBridgeSettings()`，确保第一次 render 就拿到已保存的 `adaptive-phone`。
- 保留 effect 作为浏览器环境挂载后的同步校正，但不再依赖 effect 才得到首屏设置。

### 已验证
- `pnpm exec vitest run ../packages/shared/src/react/use-bridge-settings-storage.test.tsx src/hooks/useTerminalShellActions.test.tsx src/lib/terminal-width-mode-manager.test.ts --reporter=dot` PASS。
- `pnpm exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx --reporter=dot` PASS。
- `pnpm --dir android exec tsc --noEmit` PASS。
- 已知既有测试不一致：`android/src/lib/bridge-settings.test.ts` 期望 daemon config path 为 `~/.zterm/config.json`，但共享实现返回 `~/.wterm/config.json`；该失败不是本次 adaptive 启动读取改动引入。

## 2026-06-28 copy mode QuickBar 入口偶发不激活

### 现象
- Jason 反馈：拷贝功能仍不是每次都能激活。

### 根因判断
- copy mode 长按菜单链路已有回归锁住，问题更靠前：QuickBar 固定按钮 `tmux-copy` 只在 `click` 中调用 `onToggleCopyMode()`。
- Android WebView 工具栏按钮的 `click` 合成不稳定时，按下没有进入 copy active；长按 terminal row 后自然不会弹 copy menu。

### 修复
- `TerminalQuickBar` 为 `tmux-copy` 改成 press-owned armed + release commit：`pointerDown` / `touchStart` 只负责 armed，`pointerUp` / `touchEnd` 只提交一次 copy mode，`click` 只作兜底。
- 去掉按时间窗判断同一轮 press 的做法，避免长按或慢释放把 copy mode 误切回去。

### 已验证
- `pnpm exec vitest run src/components/terminal/TerminalQuickBar.test.tsx src/components/terminal/copy-longpress-e2e.test.tsx src/components/terminal/system-copy-state-machine.test.tsx src/components/terminal/system-copy-longpress-regression.test.tsx --reporter=dot` PASS。
- `pnpm --dir android exec tsc --noEmit` PASS。

## 2026-06-28 copy mode 激活后右滑抽屉与 copy 仍失效

### 现场
- Jason 真机截图显示版本 `0.1.3.1926`，状态浮窗 `CM OFF`，点击底部 `拷贝` 后仍无法进入 copy mode。
- 同一状态下右滑无法拉出 session drawer，需要退出 terminal 再进入。

### 根因
- 上一版把 `tmux-copy` 激活从 press start 改到 release commit，Android WebView 仍可能漏掉 `pointerUp/touchEnd`，导致按钮触达但 `copySelection.active` 没有打开。
- copy mode 行级长按入口在 `touchstart/pointerdown` 里 `stopPropagation()`，会阻断父级 `TerminalTabSwipeSurface` 收到右滑起点；一旦 copy 相关手势接管，session drawer 右滑入口会被一起卡住。

### 修复
- `TerminalQuickBar` 改为 press start 立即触发 copy mode，并用显式 press sequence 去重：后续 `touchStart/pointerDown/touchEnd/pointerUp/click` 只消费，不再二次 toggle。
- `TerminalView` copy 行级长按不再 `preventDefault/stopPropagation`；只启动/cancel copy long-press timer，让父级 swipe surface 继续拥有右滑抽屉入口。

### 已验证
- `pnpm exec vitest run src/components/terminal/TerminalQuickBar.test.tsx src/components/TerminalView.test.tsx src/components/terminal/TerminalTabSwipeSurface.test.tsx src/components/terminal/copy-longpress-e2e.test.tsx src/components/terminal/system-copy-state-machine.test.tsx src/components/terminal/system-copy-longpress-regression.test.tsx src/pages/TerminalPage.session-drawer.test.tsx --reporter=dot` PASS（79/79）。
- `pnpm exec tsc --noEmit` PASS。

## 2026-06-28 copy button visible active but TerminalView stale

### 现场
- 点击底部 `拷贝` 后，QuickBar 已经显示 active，但 `TerminalView` 里的 copy mode 仍停在旧值。
- 只有点开状态浮窗后，TerminalView 才彻底进入 copy mode，表现像“状态变化被 UI 某层吞掉了”。

### 根因
- `TerminalStageShell` 是 `ReactMemo`，但 comparator 之前没有比较 `copySelection` 和 `onLongPressRow`。
- 结果是 QuickBar 先重渲染，`TerminalView.copyModeActive` 还卡在旧 props；等别的状态变化（比如状态浮窗）触发父级刷新，TerminalView 才吃到新 copy props。

### 修复
- 给 `TerminalStageShell` comparator 增加 `copySelection` 稳定 key 和 `onLongPressRow` 比较。
- 回归直接盯 `TerminalView.data-copy-mode-active`，不再只看 QuickBar 染色。

## 2026-06-29 renderer parity / network recovery

### 现象
- Jason 截图对比 iTerm2 与 ZTerm：ZTerm 终端正文有局部渲染错位/灰块；同时网络变化后 App 卡死，只有杀 App 才恢复。

### 根因与修复
- 渲染链路先跑本地门禁，`TerminalView.theme.test.tsx` 暴露 mixed ASCII/CJK cell width 红灯：隐藏 glyph probe 在异常布局下会返回整屏宽 `640px`，导致单列 cell 被渲成整屏宽、CJK 两倍整屏宽，色块/反显区域随之错位。
- 修复在共享 renderer 真源 `packages/shared/src/terminal/renderer.ts`：`measureTerminalViewport()` 拒绝接近整屏宽的 glyph probe 测量，回退到 `fontSize * 0.62` / CJK 2 倍推导；禁止在 Android 页面层补第二份 cell 宽度逻辑。
- 网络变化卡死修复在 `useOpenTabLifecycleEffects`：前台 `online` 事件只恢复当前 active tab 的 transport，并走现有 resume/audit/follow reset 主线；hidden 状态 online 只记 debug，不扫所有 session。

### 已验证
- `pnpm --dir packages/shared exec vitest run src/terminal/renderer.test.ts --reporter dot` PASS（16 tests）。
- `pnpm --dir android exec vitest run src/components/TerminalView.theme.test.tsx src/components/TerminalView.bottom-stale.test.tsx src/App.dynamic-refresh.test.tsx --reporter dot` PASS（3 files / 91 tests）。
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。
- `./android/scripts/build-android-debug.sh` PASS：`0.1.3.1952` / `versionCode=1031952`，`android/update-dist/zterm-0.1.3.1952.apk`、`~/.zterm/updates/zterm-0.1.3.1952.apk`、`android/native/android/app/build/outputs/apk/debug/app-debug.apk` sha256 均为 `54f27dcae36fe1a5676d598865cd2048be8e9d1d5eae9ec2f705b28f45929979`。
- build 链路内 `check-relay-default-address-leak` PASS，`verify-update-bundle` manifest / update / daemon apk 对齐 PASS。
- `adb devices -l` 当前无在线设备，缺本机 adb install 后真机画面验证。

## 2026-06-29 大面积刷新后空白直到手动滚动

- 现场现象：大面积文件新增/删除时，正文会变空白，只有触摸上下滚动后才恢复刷新。
- 根因：`session-buffer-store.commitBuffer()` 旧实现按引用判等且直接存 live buffer；上游复用同一个 buffer 对象并原地 mutate 时，store 可能不发布新 truth。
- 修复：`commitBuffer()` 改成内容判等，并在 store 内 clone buffer，切断 live 引用。
- 已验证：
  - `src/lib/session-buffer-store.test.ts`
  - `src/lib/session-render-gate.test.ts`
  - `src/lib/session-render-gate.tui-content.test.ts`
  - `src/contexts/session-context-buffer-runtime.test.ts`
  - `src/components/TerminalView.dynamic-refresh.test.tsx`
  - `src/components/TerminalView.bottom-stale.test.tsx`
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS
  - `./android/scripts/build-android-debug.sh` PASS，产出 `0.1.3.1953`
- 记录：以后碰到“滚一下就好”的空白刷新，不先动 scroll，先查 buffer publish 是否被引用短路。

## 2026-06-29 Windows PC remote access baseline

- Windows PC record found at `~/Documents/server/memory/windows-codex-updated-jason-hw-desktop-2026-03-07.md`.
- Host truth: `Jason-HW-Desktop`, Tailscale `100.75.122.121`, user `huawei`, MagicDNS `jason-hw-desktop.anoa-buri.ts.net`.
- Verified from current Mac route:
  - `tailscale ping 100.75.122.121` PASS via DERP `cn-custom`, about 20ms after path switch.
  - `ping -c 2 100.75.122.121` PASS, 0% loss.
  - SSH port 22 open and `ssh huawei@100.75.122.121` works with existing key.
  - Remote identity: `Jason-HW-Desktop`, `jason-hw-deskto\huawei`, PowerShell `5.1.26100.8115`.
  - Node available: `C:\Program Files\nodejs\node.exe`, version `24.11.1.0`; `npm.ps1` available.
  - Tailscale peer API port `58327` open; `3389/5985/5986/3333` did not show as open in this probe.
  - `wezterm` not found in PATH.

## 2026-06-29 Windows WezTerm portable backend probe

- Downloaded official portable WezTerm to Windows PC:
  - `D:\zterm-tools\wezterm\WezTerm-windows-20240203-110809-5046fc22.zip`
  - extracted to `D:\zterm-tools\wezterm\portable\WezTerm-windows-20240203-110809-5046fc22\`
  - sha256 verified: `57e5d03b585303d81e8b8e96d1230362852eb39aca92b3b29c7a42cfb82f9ac4`
- `wezterm.exe --version` returns `wezterm 20240203-110809-5046fc22`.
- `wezterm cli --prefer-mux list` can auto-start `wezterm-mux-server.exe --daemonize` from SSH and persists across later SSH execs; observed mux PID `30396`.
- CLI capability verified:
  - `cli spawn --new-window --workspace ...` creates panes and returns pane ids.
  - `cli list` enumerates windows/tabs/panes/workspaces.
  - `cli get-text --pane-id ...` exports pane text.
  - `cli get-text --escapes` preserves ANSI style output; verified red foreground `\x1b[91m` and green background `\x1b[102m`.
  - scrollback export works with negative ranges; `get-text --start-line -90 --end-line -1` returned earlier scrollback, and mixed negative/positive range returned scrollback + current screen.
- Important limitation found:
  - In pure mux/no GUI-client state, `cli send-text` can put visible text into a pane but did not reliably deliver Enter/control execution through SSH tests. Treat input injection via WezTerm CLI as unproven, not a backend contract.
  - `get-text` line indexes are relative to scrollback/current screen, not stable daemon absolute line indexes. A ZTerm adapter would need its own poll/diff -> absolute mirror store.
- Cleanup: test panes `1..6` were removed with `wezterm cli kill-pane`; default pane `0` and downloaded portable files remain.

## 2026-06-29 Windows WezTerm backend initial contract

- Added ZTerm-side initial adapter, not a WezTerm fork:
  - `src/server/wezterm-backend.ts`
  - `src/server/wezterm-backend.test.ts`
  - `scripts/wezterm-backend-remote-smoke.ts`
  - `docs/decisions/2026-06-29-windows-wezterm-backend-contract.md`
- Frozen contract:
  - WezTerm CLI is external source material, not daemon truth.
  - ZTerm owns absolute `bufferStartIndex`, `revision`, mirror rows, and later `buffer-head / buffer-sync`.
  - `get-text --escapes` is accepted for buffer snapshot input.
  - `send-text` remains explicitly forbidden by `requireWezTermInputContract()` until pure-mux execution input is proven.
  - This initial slice must not modify `server.ts`, `terminal-mirror-runtime.ts`, `terminal-mirror-capture.ts`, or `terminal-control-runtime.ts`.
- Remote verified on `huawei@100.75.122.121`:
  - `pnpm --dir android exec tsx scripts/wezterm-backend-remote-smoke.ts` PASS.
  - Smoke spawned pane `8`, read `ZTERM_WEZTERM_REMOTE_SMOKE`, converted to snapshot `{ revision: 1, bufferStartIndex: 0, lineCount: 3, cols: 80, rows: 24 }`, and cleaned the pane.
- Local gates:
  - `pnpm --dir android exec vitest run src/server/wezterm-backend.test.ts --reporter dot` PASS, 5 tests.
  - `pnpm --dir android exec vitest run src/lib/feature-registry-truth.test.ts --reporter dot` PASS, 4 tests.
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS.

## 2026-06-30 traversal reconnect owner split / APK build 1967

- 初始修复把 `TraversalSocket.finishFailure()` 接到内部 `scheduleReconnect()` 后，单独 socket 能自恢复，但 `SessionContext` 全量 contract 暴露出双重 owner：外层 session reconnect runtime 已经会在 `onclose -> finalizeFailure(..., true)` 后排队重连，内部 socket 又自建 backend，导致 stale probe 等待窗口内多出第 3 个 WebSocket。
- 最终修复：`TraversalSocket` 增加 `autoReconnect` 选项，默认 `true`；`SessionContext` 通过 `buildTraversalSocketForHostRuntime()` 创建 app session/control transport 时传 `autoReconnect:false`，由外层 session reconnect runtime 唯一拥有重连调度。
- 回归锁定：`socket.test.ts` 覆盖默认全候选耗尽后自恢复，以及 `autoReconnect:false` 时只尝试完当前候选轮、不延时自建下一轮 backend；`SessionContext.ws-refresh.test.tsx` 全量 125 tests PASS，证明不再破坏 stale probe wait window。
- 构建验证：`./android/scripts/build-android-debug.sh` PASS，最终发布 `0.1.3.1967`，sha256 `b4cb983aced634b8549e995813cf313431206dc241616da0aaa60f07438de0dc`；`verify-update-bundle` PASS；`check-relay-default-address-leak` PASS。

## 2026-06-30 online recovery active reconnect

- 现场截图显示 `No traversal path succeeded` 后网络变化仍卡死在 reconnecting；当前 online 事件只调用 `resumeActiveSessionTransport(activeSessionId)`，会走 stale-open probe / wait 路径，不保证重启 session reconnect backoff。
- 修复：`useOpenTabLifecycleEffects` 的 foreground `online` 分支改为只对 active tab 调 `reconnectSession(activeSessionId)`，不 sweep all sessions，也不走普通 resume/probe；hidden 状态仍不恢复。
- 回归：`App.dynamic-refresh.test.tsx` 更新为 online 只 reconnect active tab，且不调用 `resumeActiveSessionTransport` / `reconnectAllSessions`。
- 验证：`pnpm --dir android exec vitest run src/App.dynamic-refresh.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx src/lib/traversal/socket.test.ts --reporter dot` PASS；`pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。

## 2026-06-30 Windows daemon / WezTerm 接入检查

- 已确认 Windows 侧当前有两层事实：
  - `src/server/wezterm-backend.ts` 只负责把 WezTerm CLI 作为外部 mux/buffer source，ZTerm 自己持有 absolute mirror snapshot 真相。
  - `scripts/zterm-daemon.sh` 与 `scripts/prepare-global-daemon-release.sh` 仍是 macOS launchd 语义，没有 Windows 自启动安装入口。
- Android 侧已有 Windows/relay 入口骨架：
  - `src/lib/traversal/config.ts` 已能按 `win32` 走 `wezterm` backend。
  - `src/pages/ConnectionsPage.tsx` / `src/lib/connections-server-groups.ts` / `src/lib/relay-account-directory.ts` 已在做目录投影。
- 当前要补的缺口不是 WezTerm 镜像本身，而是：
  1. Windows daemon 安装/启动脚本真源；
  2. Windows daemon 构建/发行包门禁；
  3. Android 侧把 Windows daemon 作为可投影 server truth 继续锁住测试。

## 2026-06-30 Windows daemon runner 初版验证

- 新增 `scripts/windows/zterm-daemon.ps1`，作为 Windows daemon runner；npm daemon 包通过 `bin/zterm-daemon.cjs` 在 Windows 分流到该 runner，macOS/Linux 仍走 `support/zterm-daemon.sh`。
- Windows runner 只负责平台壳：
  - `run/start/stop/restart/status`
  - `install-service/uninstall-service/service-status` 使用 Windows Scheduled Task `ZTermDaemon`
  - `configure-relay`
  - 精确 `TCP/<port>` 入站防火墙规则
  - 默认 `ZTERM_TERMINAL_BACKEND=wezterm`
- 真实 Windows 主机 `huawei@100.75.122.121` 验证：
  - PowerShell 5.1 下脚本 `--help/status` 可运行。
  - 修复两个真实 PowerShell 兼容问题：`$pid/$Pid` 是只读自动变量；`Start-Process` 不能把 stdout/stderr 指向同一文件；`New-ScheduledTaskSettingsSet` 不支持 `-DisallowStartIfOnBatteries`。
  - `install-service` 成功注册并启动 `ZTermDaemon`，本机 `http://127.0.0.1:3333/health` OK，PID `21296` 现场可见。
  - WezTerm backend 真实 smoke PASS：`scripts/wezterm-backend-remote-smoke.ts` 和 `scripts/wezterm-backend-input-smoke.ts` 都通过。
- 当前未闭环：
  - Mac -> Windows `100.75.122.121:3333` 仍超时；同机 Windows 访问 `100.75.122.121:3333` 成功，Mac -> Windows `22` 成功。
  - 已添加普通和 Tailscale interface 端口防火墙规则仍未打通，剩余怀疑点是 Tailscale/Windows WFP/ACL 入站策略，不是 daemon runtime 本身。
- 本地验证：
  - `pnpm --dir android exec vitest run src/server/daemon-service-script.test.ts src/lib/feature-registry-truth.test.ts src/server/terminal-backend-selection.test.ts src/server/wezterm-backend.test.ts src/server/wezterm-backend-runtime.test.ts --reporter dot` PASS（33 tests）。
  - `pnpm --dir android exec tsx scripts/wezterm-daemon-protocol-smoke.ts` PASS。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。

## 2026-06-30 Windows daemon Android 接入继续排查

- Mac -> Windows Tailscale ping `100.75.122.121` PASS，SSH `:22` PASS；Windows daemon 本机监听 `0.0.0.0:3333`，本机 health OK。
- Mac -> `http://100.75.122.121:3333/health` / `nc 100.75.122.121 3333` 仍不可达；当前证据指向 Windows/Tailscale 入站过滤层，不是 daemon runtime 未启动。
- Windows `~/.zterm/config.json` 当前缺失，说明 `configure-relay` 尚未写入 relay account truth；Android 侧 relay directory 目前不会出现这台 Windows daemon。
- 下一步：先完成 Windows runner 的 relay 配置/发布闭环，再用 relay directory + route selector 验证 Android 从目录选择 Windows daemon；直连 3333 继续作为环境诊断，不作为唯一接入前提。

## 2026-06-30 Windows runner build + artifact checkpoint

- `./android/scripts/build-android-debug.sh` 已产出 `android/release-dist/zterm-0.1.3.1969.apk`，`latest.json` 版本为 `0.1.3.1969`，sha256 `21e1ae43650f4c8c86843dfe1b2b652408c0eb26cc659660bf72450e94152de2`。
- 构建产物和 `zterm-latest-debug.apk` 的 sha256 一致，说明当前 latest debug 指向这次发布包。
- 本轮 Windows runner 真坑再确认：
  - PowerShell 5.1 写 JSON 默认带 BOM，会导致 daemon 读 config 直接报 `Unexpected token '﻿'`。
  - Windows Scheduled Task 不继承交互式 PATH，runner 必须显式探测/固化 WezTerm executable 路径，不能默认 `wezterm.exe` 可见。

## 2026-06-30 drawer-owned session creation UI shift

- 新产品语义纠正：Connections 主页面的入口不该消失；入口保留，但语义是“进入/连接服务器 workspace”，不再承担 `New Session` / `New Tab` 创建动作，也不打开 `new-connection` picker。
- 右滑 Terminal drawer 是 session/daemon 操作入口：host rail 直接列账号目录里的 daemon；即使某台机器当前没有打开的 runtime session，也能选中该机器。
- drawer 底部 `New Session` 不再打开通用 picker；它会把当前选中机器的 hostKey 交给 action owner，由 `tmux-create-session` 在该 daemon 上创建一个空白 session，再打开成 tab。
- 修正版构建：`./android/scripts/build-android-debug.sh` PASS，发布 `0.1.3.1972`，sha256 `789f8b59e151b265f2638e68e2e5d30d4781e12507e36b63f062ca05939a3ae4`；`zterm-latest-debug.apk` 与版本 APK sha 一致。

## 2026-06-30 traversal reconnect dead-end recovery

- 现场“连不上，杀掉才能连通”的真因落在 route selection：`TraversalRouteHealthCache` 记录失败后，`selectBestTraversalRoute()` 以前把 `failure/auth-failure` 当成不可选终态；当同 scope 下所有 candidate 都失败时，`TraversalSocket` 会直接走 `No traversal path succeeded`，进程不重启就不会重新 probe。
- 修复策略：失败仍保留为强惩罚信号，但不再是绝对不可选；selector 在全失败时仍返回“最不坏”的 candidate 让 socket 继续显式探测，避免把暂时性的网络恢复误判成永久无路可走。
- 回归锁：需要保留两类测试，一类锁“健康路由优先于失败路由”，一类锁“全失败时仍可重新 probe”，否则很容易再次回到杀 app 才恢复。

## 2026-06-30 add-server entry / drawer new-session correction

- 现场纠正：Connections 主入口不能只是“进入已有服务器 workspace”；它必须恢复为“新增服务器”入口，打开 `new-connection` picker，再由 picker 区分“新增服务器”和“已有服务器 sessions”。
- drawer 底部 `New Session` 不能只依赖 relay directory device 解析 hostKey；如果当前 host rail 来自 saved server 或 runtime session identity，也必须能解析成 `BridgeTarget` 并调用 `tmux-create-session` 创建空白 session。
- 继续纠正：drawer 的 `New Session` 不能点击后直接创建；必须先弹出表单让用户确认 session 名和启动路径，路径默认 `~/`。确认后才发送 `tmux-create-session`，payload 必须带用户确认的 `cwd`。

## 2026-06-30 Windows daemon 可用性复核

- Windows daemon 已验证可用：
  - `http://100.75.122.121:3333/health?token=...` 返回 `ok: true`
  - WebSocket 主链已跑通 `list-sessions -> tmux-create-session -> session-open -> connect -> input -> buffer-sync`
  - 当前 health 显示 `pid=15400`、`wsUrl=ws://100.75.122.121:3333`
- Windows 鉴权不是硬编码：
  - `C:\Users\huawei\.zterm\config.json` 已写入 `mobile.daemon.host=0.0.0.0`
  - `mobile.daemon.port=3333`
  - `mobile.daemon.authToken` 来自统一配置真源，token 前缀为 `wterm-41...`
- Tailscale IP：
  - Windows `jason-hw-desktop` -> `100.75.122.121`
  - macbookair -> `100.86.84.63`
- 手机多机管理测试时，直接用这两个 Tailscale IP + 3333 端口即可；不要再走本机名或硬编码地址。

## 2026-06-30 Windows TUI 退出不应断 session

- 现场问题：Windows 上从 Codex/TUI 退出后连接断掉。根因方向不是 Tailscale，而是 Windows WezTerm session 必须以持久 shell 为根进程；如果 pane 根进程是一次性 `cmd.exe /c codex`，Codex 退出就会直接结束 pane，daemon 随后会报告 session unavailable。
- 已验证真实能力：Windows WezTerm pane 用 `cmd.exe /k` 启动后，通过 stdin 进入 `codex`，再发 Ctrl+C 退出，pane 仍在并回到 `C:\Users\huawei>` prompt；继续发送 `echo ZTERM_AFTER_CODEX` 可成功返回。
- 修复：`wezterm-backend.ts` 默认 session root 改为 `cmd.exe /k`，新增 `buildWezTermPersistentShellCommand()`，显式拒绝 `cmd.exe /c ...` 作为 session root。
- 回归：`wezterm-backend-input-smoke.ts --include-codex` 现在验证“shell -> codex -> Ctrl+C -> shell 继续可用”，并处理 Codex update prompt 的 `Skip`。
- 验证：
  - `pnpm --dir android exec vitest run src/server/wezterm-backend.test.ts src/server/wezterm-backend-runtime.test.ts src/server/terminal-control-runtime.input-queue.test.ts --reporter dot` PASS（21 tests）
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS
  - `pnpm --dir android exec tsx scripts/wezterm-backend-input-smoke.ts --include-codex` PASS，结果 `codex.returnedToShell=true`
- 已部署到 Windows 当前 task runtime：
  - 本地 `pnpm --dir android run daemon:prepare-release` 重新生成 `runtime/server.cjs`
  - 覆盖 Windows `D:\zterm-tools\daemon-runtime-test\runtime\server.cjs` 和 `support\windows\zterm-daemon.ps1`
  - 仅重启 Scheduled Task `ZTermDaemon`，新 pid `5428`
  - health `http://100.75.122.121:3333/health?token=...` 返回 `ok: true`
  - 真实 daemon 协议复测：`tmux-create-session -> session-open -> connect -> codex -> Ctrl+C -> echo ZTERM_DAEMON_CODEX_RETURNED_STRICT` PASS，session transport 仍 open

## 2026-06-30 Connections server card -> exact picker target

- Connections 主卡片点击现在不再走旧的 shared open path；它直接打开该卡片对应的 `onEditServerGroup` picker。
- picker 真源必须跟随该卡片的 `bridgeHost / bridgePort / daemonHostId / authToken`，不能复用另一个 server 的 target。
- 通过测试锁住了两个回归：同一页面多 server card 点击各自 target 不串线；history-only group 也只进 picker，不伪装成 runtime open。
- 已补 edit-group 自动刷新回归：picker 打开后必须对当前 concrete target 调 `fetchTmuxSessions()`，并通过 `onRemoteSessionsRefreshed()` 回写最新 sessions。
- 已验证：`ConnectionsPage.test.tsx`、`tmux-session-picker-rows.test.ts`、`TmuxSessionPickerSheet.test.tsx`、`tsc --noEmit` 全绿。

## 2026-06-30 Windows session refresh/auth correction

- Jason 真机截图证实 `codex-test` 旧 tab 仍尝试连接，而 Windows 新建/刷新 session 不可用；不能只用 mock 测试判断已修。
- Mac -> Windows daemon 真实验证：`fetchTmuxSessions()` 返回 `zterm-20260630-115307/default`，`createTmuxSession()` 新建后再次 fetch 能看到新 session；清理测试 pane 后列表恢复到这两个真实 session。
- Android 根因：relay directory group / drawer hostKey 命中 relay device 时可能只拿 directory target，缺 saved server/preset 的 daemon auth token，导致 Windows direct session refresh/create 不带 token。
- 修复：Connections card target resolver 使用 saved server preset 补 `bridgeHost/bridgePort/authToken`；drawer New Session 的 relay-device target 用 saved host 补 auth/endpoint。
- 已验证：Connections/useSessionOpenActions/TmuxSessionPicker/session-picker 定向 48 tests PASS；`tsc --noEmit` PASS；真实 Windows `fetch/create/fetch` PASS。

## 2026-06-30 Windows WezTerm cursor audit

- 现场问题：Windows sessions 已能连接，但手机 terminal 没有光标。
- 真源追踪：Android renderer / buffer manager 已支持 `cursor` metadata；`TerminalView` 只消费 `renderBuffer.cursor`，不 invent cursor。丢失点在 WezTerm backend：`WezTermMirrorSnapshot.cursor` 被硬编码为 `null`。
- WezTerm 真实接口验证：`wezterm.exe cli list --format json` 在 `100.75.122.121` 返回 `cursor_x/cursor_y/cursor_visibility/top_row`；`get-text --escapes` 只给正文/样式，不给 cursor。
- 修复：`wezterm-backend.ts` 改用 `list --format json` 解析 pane + cursor metadata，并在 `readSnapshot()` 中保留完整 pane record；cursor 作为独立 metadata 写入 snapshot，不写入 cells。
- 真实 daemon 验证：覆盖 Windows 当前 runtime 后通过 `support/windows/zterm-daemon.ps1 start` 启动，health `pid=23312`；WebSocket 主链 `list-sessions -> session-open -> connect -> buffer-head` 返回 `cursor={"rowIndex":0,"col":16,"visible":true}`。
- 发布路径缺口已发现并修包 metadata：`jsonstudio-zterm-daemon-0.1.3.tgz` 之前 `os/cpu=darwin/arm64`，Windows `npm install -g` 会 `EBADPLATFORM`；已改为允许 `darwin/win32` + `arm64/x64`。后续还需要专门验证 clean npm global install + service install；本轮 Windows 临时 tgz 文件遇到 `EBUSY`，未完成 fresh install 闭环。

## 2026-07-01 Terminal drawer session auto-refresh

- 现场问题：抽屉打开后不是最新 session 列表，只能看到本地已打开/已保存的 tab；远端 daemon 新增 session 不会自动进入抽屉。
- 根因：远端 refresh 只存在于 `TmuxSessionPickerSheet`，`handleRemoteSessionsRefreshed()` 只 prune/audit，没有把 fetch 到的 sessionNames 物化进 `sessionGroups` catalog；`TerminalPage` drawer projection 也只消费本地 `sessions`。
- 修复方向：抽屉打开时按当前 hostKey 调 `fetchTmuxSessions()`，复用 `handleRemoteSessionsRefreshed()` 写入 `sessionGroups`；`TerminalPage` 从 `sessionGroups` 投影 remote-only rows，点击 remote-only row 走 `handleOpenGroupSession()` 打开对应 tmux session。
- 反耦合点：drawer effect 只依赖稳定 `refreshHostKey`，不能依赖整个 `hostGroups/sessions` 投影，避免 catalog 更新后反复触发远端枚举。

## 2026-07-01 Android IME shell blank refresh

- 现场问题：IME 弹出时 shell 偶发不刷新、变空白，触摸/滚动后又恢复。
- 真源判断：IME 只改变 UI shell geometry，不属于 daemon/buffer truth；但 stage absolute bottom / shellHeight 变化必须显式驱动 renderer 重新 measure viewport 和 follow 对齐。
- 根因方向：之前主要依赖 TerminalView host 的 `ResizeObserver` 发现外层高度变化；Android WebView/IME 场景下该回调可能漏或晚到，renderer 停在旧 viewport/scrollTop，表现为空白。
- 修复：`TerminalPage` 汇总 `shellHeight / terminalChromeBottomPx / terminalImeLiftPx / keyboardInset / terminalKeyboardRequested` 为 `terminalLayoutRefreshToken`，经 `TerminalStageShell` 传给 `TerminalView`；TerminalView 收到 token 后只做本地 `runViewportRefresh()` 和 follow 对齐，不触发 Android upstream `onResize`。
- 回归：`TerminalPage.android-ime.test.tsx` 锁住 IME show 后 token 改变且 `onResize` 不触发；`TerminalView.dynamic-refresh` / `bottom-stale` 同跑防止 renderer body 回归。
