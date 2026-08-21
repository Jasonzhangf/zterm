# 2026-08-19 升级链路 + Logo 替换

## 当前 HEAD / 状态
- HEAD: `3942ede1`
- 工作区有 dirty：AndroidConnectionService 大迁移（staged）、logo/splash 资源改动（部分 staged）。
- 本轮要求保留所有 dirty，不回退。

## 当前构建产物
- `android/native/android/app/build/outputs/apk/debug/app-debug.apk`
  - versionName `0.1.3.2662`, versionCode `1100026620`
  - sha256 `2a7553d71dc024d531ec5413468a27175cd7268541c6a620a7de7db4ace08d12`
  - size 5,717,977
- `android/native/android/app/build/outputs/apk/debug/app-rollback-debug.apk`
  - versionName `0.1.3.2662.1`, versionCode `1100026621`
  - sha256 `78bb347c01313d1e1cafb839e329026e218c4326ef352c1c6f2ddc8ae8c02569`
- `android/.build-meta.json`: {"buildNumber": 2662}
- assets/logo.png 已存在根 repo 资产。

## Daemon 状态
- 本地 daemon `http://127.0.0.1:3333/updates/latest.json` 已生效 → 0.1.3.2662
- device 100.104.163.65:5555 已在线 (PLZ110, OP64DDL1)
- Jason 已授权本地 + Tailscale OTA，禁止 Public Relay。

## 本轮目标
1. 解锁设备 → screencap splash + launcher 真实证据。
2. 验证 Tailscale IP 上 daemon 返回相同 sha256。
3. 报告：变化、验证、剩余缺口、下一步。
2026-08-18 23:46:13

## 2026-08-19 第二轮：用 assets/logo.png 真源重新生成图标

### 变更 / 已落动作
- 用 `assets/logo.png` (1254x1254) 真源，按 5 个密度重新生成：
  - `mipmap-*/ic_launcher_foreground.png` (RGBA, adaptive icon 66% 安全区)
  - `mipmap-*/ic_launcher.png` + `ic_launcher_round.png`（fallback）
  - `drawable/splash_logo.png` + 5 密度
- bump build → `0.1.3.2663 / versionCode 1100026630`
- cap sync + assembleDebug + assembleDebug -PztermRollbackVariant=false
  重新 ensure normal APK；用 `scripts/tools/patch-apk-version.py 1100026631 0.1.3.2663.1` 生成 rollback
- prepare/verify OTA bundle: full green
- 本地 daemon + Tailscale `100.66.1.82:3333` 都返回 `06a818fff1ab…/6,099,105B`
- 真机覆盖安装（设备 `100.104.163.65:5555`）
  - firstInstallTime=2026-06-16 12:30:58 **未变**
  - lastUpdateTime=2026-08-19 15:00:10
  - dataDir=/data/user/0/com.zterm.android
  - versionCode=1100026630, versionName=0.1.3.2663

### 真机证据
- splash (cold start t3): 主色 (176/176/176), 灰 + 含 (95,105,121)/(0,0,32) zterm logo 字符色调
- launcher (home3): 区域 (720,272) 命中 `ic_launcher_background` #111A23 ≈ 252 像素 → 真实桌面图标
- 多次截屏 pixel sampling 共同证明: 桌面前景不再是 mono engraved/old palette

### 仍需 / 已知缺口
- view_image 工具持续空返回，仅用 pixel/histogram/ascii 特征记录；建议你亲自 cat 截图
- 0.1.3.2663 splash center 不像 zterm 原色 — 调查发现 splash drawable 是 #1E1E1E 底 + 内嵌 70% logo，Android 12+ SplashScreen API 会叠 mask → 这是预期行为
- 你的明确要求 "用 assets/logo.png" 已物理落进 mipmap+drawable 5 密度

### 文件 dirty 状态（暂不 commit，等你裁决）
- assets/ 未改
- mipmap-* (5 密度) + drawable (5 密度) + drawable/splash_logo.png 已改
- AndroidConnectionService 大迁移 staged：未触碰
- .build-meta.json 已 bump 至 2663

# 2026-08-19 remote-window stream remediation

## Architecture mapping before implementation

- Feature: `desktop.remote_window_stream`. This is a separation/downward-extraction remediation, plus physical removal of client layout duplication and SDP/quality fallback paths.
- Daemon truth owners: catalog; stream session/cleanup; canvas layout generation; ScreenCaptureKit source/cadence; focus+overview quality transaction; focus verification/input injection. Gateway may route only typed requests.
- Client owners: controller/lifecycle; receiver/stats; acknowledged quality state; projection geometry; locked gesture arena; render-only view; debug-only diagnostics.
- Allowed resource route: daemon layout/capture/quality -> typed protocol -> client receiver/controller -> projection/view. Input intents route gesture arena -> session transport -> daemon input owner.
- Forbidden: client macOS/canvas layout builder; active modules consuming design resources; debug/control metadata in media/business payloads; SDP rewrite; silent catch; optimistic quality apply; stream restart as quality fallback; terminal mirror/buffer/renderer truth.
- Registry gap confirmed: active dual-stream code consumed `resource.remote_window_focus_stream` while it was `status: design`; current overview had no explicit active resource; client and daemon each implemented the fixed 1920x1080 layout.
- Runtime gap confirmed: daemon rewrote failed SDP offers, overview quality application was swallowed, client recorded `lastApplied` before ACK, focus/overview lacked one total budget and cadence transaction, first direct-touch scroll omitted `moveCursor:false`, committed two-finger scroll could switch to pinch, pair-to-single always became local pan, and Overlay owned a second long-press timer.
- Required gates: registry/edge/import truth, remote-window client/server/state tests, typecheck, Android build, installed daemon/APK identity, live UI/input/network/cleanup, then DSH Review.

## Remediation verification progress

- `RemoteWindowOverlay.tsx` is now a <=10-line facade over `RemoteWindowOverlayController`; locked toolbar and developer diagnostics are physical view owners. Daemon cleanup moved to `remote-window-stream-session.ts`; capture/track/peer failures aggregate into explicit stopped status instead of silent catches.
- `remote-window-boundary-truth.test.ts` is wired into `test:feature-registry`. It locks one daemon layout builder, no client layout builder, no daemon SDP rewrite, no active design-resource dependency, dedicated daemon owner imports, and the thin overlay facade.
- Current clean-worktree evidence: architecture gate 100/100; daemon 69/69 with fork pool; session cleanup 2/2; overlay 71 pass plus 4 intentional skips; page overlay 7/7; screenshot preview 6/6; typecheck and direct Vite production build pass.
- Canonical `pnpm build` reaches the pinned AppSDK 0.1.3 binary successfully, then stops on pre-existing `ARCHITECTURE_REVIEW_MAP_STALE`. Lock hash is correct; current committed AppSDK review hashes already disagree with committed `.appsdk/maps`. Do not rewrite the lock or protected records outside the AppSDK lifecycle/review closeout.
- Main-tree merge preserved unrelated dirty work. Main architecture gates 100/100, typecheck, direct Vite build, diff check, and the repaired touch-action SOP gate pass. The broader remote-window run found 209 tests; only the missing canonical function-map phrases failed, and the targeted SOP plus architecture gates passed after restoring them.
- Installed/live closure is externally blocked in this managed sandbox: ADB cannot create its smartsocket, Gradle cannot create its lock-contention socket, launchd install cannot update `~/.local/bin`, and direct daemon execution cannot access the tmux socket. The existing launchd service is installed but unhealthy because the old `~/.zterm/bin/zterm-daemon-launchd-run` has an unmatched quote. Therefore daemon/APK identity, real Android UI/input/network/cleanup, DSH Review, commit, and push remain intentionally incomplete.
- Continued owner remediation: input target/policy/route/event/layout-generation validation moved from the 1,372-line daemon gateway into `remote-window-input-policy.ts`. The gateway now routes to the input-policy owner before coordinate mapping/injection. Positive current-generation/key tests and negative stale-generation/wrong-target/out-of-range/no-focus tests pass; worktree and main typecheck plus architecture gates remain green.
- Continued daemon thinning: live app/iTerm/tmux enumeration, 60-second cache, stale-while-refresh, warmup, same-app refresh, and cache disposal moved into `remote-window-catalog-runtime.ts`. The old silent tmux enumeration catch is gone; failure now appears as a typed partial catalog error. Gateway reduced from 1,232 to 1,045 lines. Worktree daemon+catalog 71/71, worktree/main typecheck, architecture gates 100/100, main catalog 2/2, and diff check pass.
- Client God Controller split started: sibling screenshot scheduling, one-in-flight cadence, request identity matching, terminal failure, stale/late completion rejection, and reset moved into `useRemoteWindowThumbnails.ts`. Controller reduced from 4,460 to 4,287 lines. Worktree Overlay+hook 73 pass/4 intentional skips, hook 2/2, worktree/main typecheck, architecture gates 100/100, and diff check pass.
- Target picker rendering moved into `RemoteWindowTargetPicker.tsx`; the controller now supplies phase truth and intent callbacks only. Loading, grouped app/iTerm targets, refresh/close/select/toggle behavior, 48px controls, and the no-nested-button invariant have direct tests. Controller reduced from 4,287 to 4,180 lines; worktree/main typecheck, picker 2/2, Overlay 71 pass/4 intentional skips, architecture gates 100/100, and exact worktree/main file parity pass.
- Active target switching moved into `RemoteWindowAppSwitch.tsx`; grouping, active-target dismissal, sibling selection, typed catalog error, iTerm group, and empty state now have a direct view-owner test. Low-frequency display/bitrate/status UI moved into `RemoteWindowMorePanel.tsx`; the controller retains quality intent/state ownership and passes display text plus callbacks. Controller reduced from 4,180 to 4,108 lines. Worktree/main typecheck, both new view tests 2/2, Overlay 71 pass/4 intentional skips, architecture gates 100/100, and exact parity pass.
- ABR client ownership moved into `useRemoteWindowQuality.ts`: network observation, effective/adaptive preset derivation, requested→applied/rejected revision ACK truth, duplicate-key suppression, stats sampling, and adaptive reset are no longer controller state. Positive delayed-ACK and negative transport-rejection/reset hook tests pass. Controller reduced from 4,108 to 3,944 lines; worktree/main typecheck, hook 2/2, Overlay 71 pass/4 intentional skips, architecture gates 100/100, and exact parity pass.
- Receiver playback ownership moved into `useRemoteWindowPlayback.ts`: receiver epoch/binding, media-element attachment, frame/play reveal guard, overview attachment, visibility truth, live sampling, and debug snapshot projection are no longer controller state. The hook rejects a late reveal from the previous stream epoch and accepts the current epoch; explicit invalidation stays hidden. Controller reduced from 3,944 to 3,667 lines; worktree/main typecheck, playback hook 2/2, Overlay 71 pass/4 intentional skips, architecture gates 100/100, and exact parity pass.
- Daemon-layout canvas projection moved into `useRemoteWindowCompositeCanvas.ts`; the hook owns rAF drawing of the published canvas, focused crop, and contained thumbnails without deriving a second layout. Positive draw and negative no-receiver tests pass. Controller reduced from 3,667 to 3,597 lines; worktree/main typecheck, hook 2/2, Overlay 71 pass/4 intentional skips, architecture gates 100/100, and exact parity pass.
- Media/status rendering moved into `RemoteWindowVideoContent.tsx`; attached focus/overview media, wallpaper reveal, lifecycle intents, and explicit starting/error/waiting truth are no longer inline controller JSX. Controller reduced from 3,597 to 3,505 lines; worktree/main typecheck, video view 2/2, Overlay 71 pass/4 intentional skips, architecture gates 100/100, and exact parity pass.
- Client catalog ownership moved into `useRemoteWindowCatalog.ts`: picker enumeration, local projection cache, timeout watchdog, typed failure, active-stream refresh, and catalog target upsert are no longer controller state. Positive fresh/cache-reuse and negative missing-session tests pass. Controller reduced from 3,505 to 3,298 lines; worktree/main typecheck, catalog hook 2/2, Overlay 71 pass/4 intentional skips, architecture gates 100/100, and exact parity pass.
- Display geometry ownership moved into `useRemoteWindowViewport.ts`: surface measurement, fullscreen viewport/display mode, clamp, double-tap zoom, IME chrome pan, resize/orientation observation, and viewport diagnostics are no longer controller state. Measurement/zoom/reset and fullscreen IME tests pass. Controller reduced from 3,298 to 3,108 lines; worktree/main typecheck, viewport hook 2/2, Overlay 71 pass/4 intentional skips, architecture gates 100/100, and exact parity pass.
- Duplicate composite-thumbnail and same-app focus-switch implementations were consolidated into `useRemoteWindowFocusSwitch.ts`. One revisioned overview-crop→focus transaction now owns both entry points and fails explicitly for missing stream, target, transport, or session. Positive dispatch and negative missing-target tests pass. Controller reduced from 3,108 to 3,078 lines; worktree/main typecheck, focus hook 2/2, Overlay 71 pass/4 intentional skips, architecture gates 100/100, and exact parity pass.
- Consolidated regression gate after the owner extractions: worktree and main each pass all `remote-window` path tests in a single fork (23 files, 213/213), direct Vite production build, typecheck, architecture gates 100/100, and `git diff --check`. Default threaded Vitest segfaulted while daemon tests were active; the project-safe single-fork invocation completed the same corpus without test failures.
- Controller growth is now mechanically bounded at 3,200 lines in `remote-window-boundary-truth.test.ts`; current controller is 3,078 lines and forbidden owner patterns lock catalog, playback, quality, viewport, focus-switch, canvas, picker, More, diagnostics, and video view outside it.
- Canonical `pnpm build` remains externally blocked, but the blocker changed because the global AppSDK binary was replaced during this run: project lock requires `appsdk 0.1.3` SHA `e3c36a…`, while `/Users/fanzhang/.local/bin/appsdk` is now `appsdk 0.1.4` SHA `c26e50…`. The pin gate correctly rejects `APPSDK_BINARY_DIGEST_MISMATCH`; do not update the project lock or bypass the gate as part of remote-window work.
- Memory closeout is also externally blocked by the managed sandbox. The required `scripts/mempalace-mine-zterm.sh` cannot update `/Volumes/extension/code/memory/zterm-mempalace-corpus-safe` (`Operation not permitted`), and even a read query cannot open `~/.mempalace/palace` because the CLI attempts a database write and receives `attempt to write a readonly database`. The safe corpus/`wing=zterm` policy was preserved; the repository root and a temporary alternate wing were not indexed.
