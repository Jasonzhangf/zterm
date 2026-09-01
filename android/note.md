# 2026-08-19 升级链路 + Logo 替换

# 2026-08-31 session rename reconnect race fix

- Root cause: `resolveMuxChannelClosedWithControlStatusRuntime` captured the rename-time `sessionName` in its async control query; renaming race left the post-query session-present check comparing the old name, so a renamed session was treated as missing and entered the slow reconnect backoff.
- Fix: the unique owner `terminal.transport_lifecycle.channel_closed_control_status` now re-reads the still-closed channel's `sessionName` after `queryTargetSessions()` resolves before deciding presence; it also surfaces the resolved name in the runtime-debug event.
- Tests: `session-context-transport-orchestration-runtime.test.ts` adds a red-then-green rename-race case (24/24), plus regression for the positive and negative control paths; `session-context-session-runtime.test.ts` + `terminal-channel-mux-runtime.test.ts` still 38 + 7 = 45 PASS; `tsc --noEmit` PASS; `git diff --check` clean; canonical build blocked at `COMPILED_STAGE_REQUIRES_ARTIFACT` because this worktree does not carry the frozen AppSDK compiled tree (not a code defect).
- Device L5 still pending: emulator install + adb-driven rename→reconnect replay is the user-visible acceptance gate; commit will be deferred until that gate is exercised or Jason releases the L5 evidence.

# 2026-08-31 Android UI/UX + motion audit

- Scope: client UI projection only; Connections home, Settings, tmux picker, and existing dialog motion hooks. Daemon, transport, mirror, sparse buffer, renderer truth, payloads, and runtime ownership were untouched.
- Changes: Connections empty state now gives a clear first-server path and uses an SVG add icon; Settings adds labelled back navigation, save status feedback, and state-addressable group content; tmux picker retains its mounted DOM during the 280ms exit transition; dialog exposes its existing open/closing state; CSS adds bounded transform/opacity transitions while retaining the existing reduced-motion media query.
- Tests: focused UI stack passed 9 files / 63 tests; canonical build passed after generating the missing `schedule-fire` daemon-mirror evidence case with the pinned AppSDK 0.1.4 binary; detector returned `[]`; `git diff --check` passed.
- Live evidence: Vite user entry `https://android.zterm.localhost:1355` rendered the updated Connections and Settings DOM and screenshots under `android/evidence/ui-ux-motion-audit-20260831/after/`; save feedback was observed. Browser click automation had one viewport-control failure, so that failure is not treated as product evidence.
- Review: AGY Review task `agy-ui-ux-motion-audit-20260831` passed with zero findings. AppSDK-generated module artifacts remain uncommitted and unrelated to this UI change set.

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
# 2026-08-22 remote-window stream A-H first slice architecture mapping

- 功能块：`desktop.remote_window_stream` 的 receiver negotiation / daemon stream start / typed protocol contract。
- 唯一 owner：Android offer/track attach 由 `src/lib/remote-window-receiver-runtime.ts` 拥有；daemon sender/capture start 由 `src/server/remote-window-stream-daemon.ts` 拥有；wire contract 由 `packages/shared/src/connection/protocol.ts` 拥有。
- 整改分类：**分离下沉**。把 single-window `focus-only` 与 app-group `overview-focus` media plan 变成共享 typed contract；不以 target kind、timeout 或 fallback 在 receiver/daemon 各自猜测第二 lane。Early ICE 只由各自 PeerConnection lifecycle owner 暂存并在 remote description 应用后顺序 flush。
- Allowed paths：overlay intent -> receiver offer -> typed start request -> daemon stream owner -> ScreenCaptureKit/WebRTC sender -> receiver track attach。控制/诊断继续走 typed status/error chain。
- Forbidden paths：screenshot、terminal buffer、旧视频、静默 full-display capture、业务 media payload 内嵌控制语义、无条件 TURN、UI 直接操作 PeerConnection、未协商第二 lane 的伪造 track。
- 保持不变：route-derived ICE、ScreenCaptureKit `queueDepth=3`、Android background stop/close、一个 PeerConnection 最多 focus/overview 两条 video lane。
- 必跑 gate：shared protocol、receiver、daemon stream 定向测试；remote-window protocol/architecture registry gates；type-check；daemon build/package；`git diff --check`。真实 loopback、安装 daemon、Android/Mac rendered-pixel 与 cleanup 只能在相应 macOS/ADB 资源可用时宣称通过。

## 2026-08-22 transport resilience Phase 1 verification

- T1/T3：`JAVA_HOME=/Applications/Android Studio.app/Contents/jbr/Contents/Home` 下 `./gradlew :app:testDebugUnitTest --tests com.zterm.android.AndroidConnectionServiceTransportTest` PASS；覆盖单次失败原地重试、三次失败升级、延迟重试 generation fence、旧 generation 帧顺序回队、短故障不投影、持续故障只投影一次、恢复清 timer。
- T2：`pnpm --dir android exec vitest run src/lib/file-transfer-session-runtime.test.ts src/lib/file-transfer-throughput-runtime.test.ts src/server/terminal-file-transfer-binary-runtime.test.ts --no-file-parallelism` PASS，3 files / 32 tests。daemon 正向幂等锁住相同 chunk 重发只重复 ACK 不二次写入；冲突 chunk 显式删除 pending upload 且 end 不落盘。
- Global gates：`pnpm --dir android run type-check` PASS；`pnpm --dir android run test:feature-registry -- --reporter dot` PASS，13 files / 102 tests；`git diff --check` clean。
- 未做 live smoke：无在线 ADB / 真机断网样本；不得宣称端到端断点续传已闭环。

## 2026-08-22 DSH review round 2 fix

- DSH r2 FAIL 两个 P1 已修：target-level `send()` 现在统一走 `attemptSendWithRetry()`（mux hello/heartbeat 同样获得三次重试）；`drainPendingFrames()` 改走 retry owner，FIFO 保持、lifecycle epoch fence、成功才移除队列。
- 新增正测 `targetSendRetriesBeforeTearingDown` 和 `drainPendingFramesUsesRetryOwnerInsteadOfImmediateTeardown`，锁住 hello/heartbeat/drain 的 transient send failure 不再立即 teardown。
- 回归：Gradle transport suite 22/22 PASS；file-transfer/session/daemon idempotency 32/32 PASS；typecheck PASS；feature registry 102/102 PASS；assembleDebug BUILD SUCCESSFUL。
- APK sha256: `3053774ff0d8241feaf959e4892c8d8789606ad3dcbc293afc048463f58d4940`
- 后续收敛：移除 `mediaPlan` optional compatibility，start/started 两端改为 mandatory typed contract；client 保证 start request 先于 offer 期间收集的 local ICE，client/daemon 都在 remote description 应用前有界暂存 early ICE。daemon status 分 lane 发布 `capture-started`，receiver 记录 capture-confirmed / answer-applied / focus-or-overview track-attached，playback 独立记录 track binding / decoded first frame / playing。

# 2026-08-23 remote-window A-H next slice architecture mapping

- 功能块：`desktop.remote_window_stream` typed capability / startup failure-stage 诊断链。
- 唯一 owner：daemon stream lifecycle 负责验证并发布 ScreenCaptureKit/WebRTC/media-plan capability 与失败阶段；shared protocol 只定义 wire type；client message runtime 只把 typed error 投影为保留 `failureStage` 的 Error，不建立第二套状态机。
- 整改分类：**分离下沉**。capability 和 failure stage 走现有 `remote-window-stream-status` / `remote-window-error` 控制 side-channel，不进入视频帧、SDP、track metadata 或业务媒体 payload。
- Allowed paths：daemon stream owner -> typed status/error -> session transport -> message runtime -> overlay diagnostics/error projection。
- Forbidden paths：从 timeout 猜失败阶段、在 UI 根据错误字符串反推 capability、静默 fallback 到 screenshot/terminal/旧视频、宣称未验证的 VideoToolbox/ROI capability。
- 保持不变：route-derived ICE、ScreenCaptureKit `queueDepth=3`、Android background stop/close、single-focus 一 lane、overview-plus-focus 两 lane。
- 必跑 gate：shared protocol/message runtime、daemon start/capability/error tests、remote-window architecture gates、typecheck、process-isolated native loopback、Vite build；真实 ScreenCaptureKit/installed Android 仍须 macOS/ADB 证据。

# 2026-08-23 同步 main 后的 A-H 差距复核

- 已将当前分支 rebase 到 `main@dcbb19a`，并读取新出现的 `docs/goals/remote-window-stream-remediation-plan.md` 及综合审计。此前“实现文档不存在”的判断作废；后续以计划末尾的 A-H 校准批次为准。
- A-H 边界：当前只继续 `media plan / per-lane startup / early ICE / capability preflight / real loopback / installed proof`，不提前进入 owner 大拆分、Touch 全量改造、Layout Planner V2、screenshot-loop 清除或性能重写。
- 已实现部分：mandatory `mediaPlan`、single/composite lane 数、returned-plan mismatch、answer 前 early ICE 排队、capture/answer/track/decoded/playing 分离 telemetry，以及独立 native loopback 进程。
- 仍需红测和实现：B 要求的 plan id/version、显式 lane role 与 `requiredForStart` 尚未进入同一 typed plan；D 尚缺每条 required lane 的 elapsed/timeout code 和完整 success/failure/non-terminal/already-terminal 矩阵；E 尚缺 duplicate/conflict/unknown identity 的显式 candidate 结果；F 尚未完成 wrtc/Swift helper/权限/ABI/capture/sender 的真实统一 preflight（当前 capability status 不能替代权限、capture 或 sender proof）；G loopback 尚未证明 ICE 顺序、真实帧、连续至少三帧与资源计数归零；H 仍无 online ADB/真实 Mac installed proof。
- 唯一 owner/边：shared contract 定义 plan 与 status/error；receiver media owner 消费 plan 并拥有 peer/ICE/track timeout；daemon stream owner 执行 preflight/sender/capture/cleanup；overlay 只投影 typed result。禁止从 target kind、timeout 或错误字符串重建第二套 media/capability 真相。
- 保持不变：route-derived ICE、ScreenCaptureKit `queueDepth=3`、Android background stop/close，以及一个 PeerConnection 最多 overview/focus 两条 video lane。
- B 本轮继续收敛：shared protocol 新增 version-1 media-plan registry，明确 `single-focus=[focus required]`、`overview-plus-focus=[focus required, overview required]`；receiver transceiver 数和 daemon overview allocation 消费该 registry。start/started wire 现在强制携带 `mediaPlanVersion=1`，daemon 在 allocation 前 typed reject version mismatch，receiver 同样拒绝 returned version mismatch，capability status 回传 version 与 lane role/start requirement。quality transaction 显式引用 plan version 仍待后续收敛。
- G 本轮收敛：独立 `@roamhq/wrtc` loopback 不再只观察 `ontrack`；现在双方 remote description 前有界暂存并顺序 flush ICE，等待 ICE gathering/application 完成，使用真实 `RTCVideoSink` 对每条 required lane 验证至少 3 帧，随后 stop sink/track、close peer，并验证 local track 已 ended。该 gate 仍不能替代安装版 ScreenCaptureKit/Android rendered-pixel 的 H 证据。
- E 本轮收敛：daemon ICE owner 为每个 stream 保存 candidate fingerprint；重复、closed stream 和 bounded queue overflow 分别抛出 typed code，terminal message owner 原样投影为 `remote-window-error`，不再以 `false` 静默吞掉 late candidate。未知但可能尚未 registration 的 stream 仍按原顺序暂存，这是 early-ICE 正常路径而不是 unknown rejection。
- F 本轮继续收敛：daemon 在 peer/capture allocation 前验证 Darwin ABI 与 wrtc peer/session/candidate/video-source/RGBA converter capability；unsupported ABI 或缺 capability 返回 `platform-capability` typed error。preflight telemetry 明确区分已验证的 wrtc/ABI、仅 configured 的 Swift helper，以及必须等待真实 lifecycle 的 permission/capture/sender `pending`，不再用一个布尔值伪装后续媒体成功。权限与 Swift executable 的真实安装版 probe 仍属于 H/live 缺口。
- D 本轮继续收敛：receiver 从单个共享 track timeout 改为每条 required lane 独立 handle；track attach 只清本 lane，已 attach lane 的迟到 callback 保持 non-terminal。expiry 返回 `remote_window_receiver_lane_timeout`、`failureStage=track-attach`、精确 lane 和 elapsedMs，再由唯一 cleanup owner 关闭 peer/track/timer。
- B/quality 本轮收敛：quality request/result wire 强制携带 active media plan id/version；client quality owner 只使用 daemon capability status 提供的 accepted plan，capability 尚未到达时不发 transaction。daemon entry 保存启动 plan，plan mismatch 在 sender/capture mutation 前以 `remote_window_stream_quality_media_plan_mismatch` 拒绝，ACK 原样回传 plan identity。

## 2026-08-23 screenshot owner 拆分（计划步骤 owner 拆分）

- 提交：`c2b3af5e refactor(remote-window): split screenshot owner into useRemoteWindowScreenshot`
- 范围：
  - 新增 `android/src/components/terminal/useRemoteWindowScreenshot.ts`（113 行）：状态机、capturing/saved/failed、feedback projection、activeSessionId/requestScreenshot guard
  - 新增 `android/src/components/terminal/useRemoteWindowScreenshot.test.tsx`（151 行）：6 tests 覆盖 idle、capturing→saved、in-flight capturing feedback、rejection、无通道、reset
  - `RemoteWindowOverlayController.tsx`：`setScreenshotStatus({phase:'idle'})` 3 处 → `screenshotController.reset()`；`handleRemoteWindowScreenshot` 从 30 行降到 3 行只委托 `capture(state.target)`
  - `android/docs/module-registry.json`：`useRemoteWindowScreenshot.{ts,test.tsx}` 列入 `client.remote_window_overlay` 的 `owned_paths`
- 闭环验证：
  - `pnpm --dir android run type-check` PASS
  - `pnpm --dir android run test:feature-registry -- --reporter dot` 13 files / 102 tests PASS
  - `pnpm --dir android exec vitest run --no-file-parallelism <remote-window 13 files>` 100 passed / 4 skipped
  - `pnpm --dir android run test:remote-window-webrtc-loopback` ok:true (single-focus 1 lane × 3 frames / overview-plus-focus 2 lanes × 3 frames, ICE order preserved)
  - `pnpm exec vitest run packages/shared/src/connection/protocol.test.ts` 11 tests PASS
- 剩余：
  - 未改 wire/protocol/runtime/media — APK 2706 行为等价，不需要重建 APK
  - plan 阶段 4-7（Media/Focus/Input/Gesture/Projection owner；touch 收敛已对齐；layout planner；screenshot loop 物理清除；WebRTC performance）未在本轮做
  - `session-context-transfer-runtime.ts` 中 `ensureSessionReadyForTransfer` unused import 是他人 dirty，未触碰
  - 不在 `RemoteWindowOverlay.tsx` 的剩余类型同步：注入 `useRemoteWindowScreenshot` 暴露的 `feedback` 用于未来的 toolbar toast（当前仅控制器内部消费）

## 2026-08-24 daemon permission / large-refresh closeout

- `desktop.remote_window_stream` permission/capture identity is now one installed executable: `zterm-daemon --permission-probe` for install preflight and `zterm-daemon remote-window-capture` for runtime. Remote Capture bundle, raw helper, alternate capture env, and runtime compilation paths are removed; missing capability returns typed `remote_window_capture_binary_missing / platform-capability` before the factory.
- Installed verification: launchd runner contains only `ZTERM_DAEMON_NATIVE`, permission probe exits 0, daemon health is ready. Focused tests 110/110, type-check, feature registry 102/102, release artifact inspection, and isolated typed-failure probe passed.
- Emulator-5554 / installed `0.1.3.2719`: fresh 100000-line refresh, 100 timed CDP samples, 0 empty rows, 0 gaps, 0 discontinuities, visible absolute range advanced by 100000. Screenshot `/tmp/zterm-emulator-large-refresh-rerun.png` SHA `04c86d1d3caca7dd2f38674bfa6c9d233c0c00d8b725afa1322df7314f38cd1d`, terminal-region non-black fraction `0.961536`.
- Next: AGY Review only; do not stage unrelated dirty files.

## 2026-08-24 permission fallback correction

- Root cause: canonical ScreenCaptureKit Swift called `CGRequestScreenCaptureAccess()` and polled for 12 seconds after preflight denial; tests explicitly required that fallback.
- Corrected owner: `hasScreenCapturePermission()` now performs one `CGPreflightScreenCaptureAccess()` only. Missing permission exits 5 immediately; no request, wait, retry, TCC reset, alternate executable, screenshot, or runtime compilation path exists.
- Evidence before review: red test reproduced the request path; focused capture 8/8, daemon/service/screenshot 30/30, stream/message/capture 122/122, typecheck, feature registry 102/102, Swift compile, installed daemon SHA `25dbfb2a...`, exact launchd restart health ready, and emulator 100000-line refresh with 100/100 non-empty continuous samples.
- Post-restart runtime evidence: staged `server.cjs` SHA `299ce64e...`, installed native daemon SHA `25dbfb2a...`; the bundle has no request/poll/screenshot/runtime-compile markers, and the binary imports preflight but not request. Emulator 100000-line refresh after restart produced 100/100 non-empty continuous CDP samples. AGY Review r4 passed with zero findings; MemoryPalace reindex remains blocked by an unrelated corpus-worker hang.

## 2026-08-24 remote-window capture/quality explicit failure closeout

- Commit `c31dd79cebae5f95a046e8846999ab1f22b7ac46` keeps ScreenCaptureKit outputs alive for the stream lifetime and removes the AppKit main-loop dependency from the capture startup/update tasks.
- `@roamhq/wrtc` quality now mutates the exact sender transaction and requests a fresh transaction before rollback. Both original and rollback failures use the shared typed formatter, so native `InvalidStateError` cannot become an empty diagnostic.
- The canonical live probe treats protocol-valid `quality-result status=rejected` as an explicit failure; it neither retries into another capture path nor converts rejection into success.
- Runtime evidence: installed runtime SHA equals release SHA `50d0591ae5b426587370df5d0d653f313f9e76e72a795bc6d0339ba33460d1c5`; `/health` PID 68870 ready; canonical mux probe passed with 197 frames sent and all input markers observed; focused quality tests 6/6, type-check, feature registry 102/102.
- AGY Review task `agy-remote-window-20260824T230406Z`: controller `verdict=pass`, findings `[]`. Local and remote main are both at commit `c31dd79c`.

## 2026-08-25 stale remote-window target explicit failure closeout

- 根因：catalog 的 `windowId` 是枚举投影，窗口关闭后仍可能被 picker 使用；旧链路直接 spawn ScreenCaptureKit capture，fresh `SCShareableContent` 找不到目标后才失败，错误未及时经 mux channel 回传，Android 最终只能等 stream-start timeout。
- 唯一修复点：`remote-window-capture.ts` 在 capture spawn 前调用同一已安装 `zterm-daemon remote-window-validate <windowId...>`；缺失目标抛 `RemoteWindowCaptureTargetUnavailableError`，daemon 投影 `remote_window_target_not_found` / `target-validation`。capture/daemon/message 流程不增加 screenshot、旧视频或其他 fallback。
- 验证：定向 127/127、type-check、feature registry 102/102；Finder 正向探针 `trackSeen=true`、1347x679、ScreenCaptureKit 5 FPS、正常 stopped；无效 ID `99999` 直接 exit 4，stderr 为 fresh `SCShareableContent` target-not-found；health PID 94375 ready，installed daemon SHA `882d01404cb33fe1ec1eaa0a4abe68cb61857f83d14202f9209c0b3a93a3ae54`。
- Review/交付：AGY task `agy-daemon-screenshot-no-fallback-20260825` PASS、findings=[]；精确 change set commit `94e35a89`，已 push，origin/main 与本地 HEAD 一致。其他 dirty 文件未暂存。
## 2026-08-25 Composite frame validation closeout

- Commit ce9996a4 merged to main and pushed. Worktree/branch cleaned.
- New daemon binary c5d0696e installed at /Users/fanzhang/.zterm/bin/zterm-daemon; PID 59452 healthy.
- Live probe: composite out-of-display correctly rejected with exit 6 / typed stderr; stale window still exit 4.
- AGY Review PASS findings=[] for commit 68a895c3 (worktree) = ce9996a4 (main).
- Emulator socket=missing for remote-window transport is unrelated to this fix (emulator NAT'd, daemon not reachable via 127.0.0.1); owned by mux/route worktree.
## 2026-08-25 UDP/relay red-test 评估（decision recorded 2026-08-27）

### 现状与根因

- `AndroidConnectionService` 是 native 物理 transport owner，但 `buildCandidates()` 目前只生成 Tailscale/IPv6/IPv4 WebSocket URL；`startAttempt()` 对 `RTC_DIRECT` / `RTC_RELAY` 显式返回 `webrtc-not-supported`。
- `android/native/android/app/build.gradle` 没有 WebRTC 依赖（只有 OkHttp、Capacitor、AndroidX），因此 native service 当前没有 `RTCPeerConnection`、ICE 或 DataChannel 实现。
- WebView 的 `TraversalSocket` 已实现 signal WebSocket、`RTCPeerConnection`、ordered DataChannel、ICE direct/relay、断线重启、route diagnostics；`buildTraversalPlan()` 也已统一生成 `rtc-direct` / `rtc-relay` candidate、`relayHostId`、STUN/TURN 与 `iceTransportPolicy`。
- Android native 路径在 `session-context-infra-facade-runtime.ts` 的 `openDaemonTargetTransportSocket()` 分支强制进入 `openAndroidConnectionServiceTransportSocket()`，不会消费 WebView `TraversalSocket`。这解释了“WebView relay 可用、native Android relay 明确拒绝”的差异。
- 资源、模块、function map 与 mainline call map 已将 native WebRTC/Relay media 标为 separate slice；`resource.android_connection_service` 仍只声明 target physical transport、mux/channel、heartbeat、network-generation、reconnect/backoff 与 route policy owner。

### 决策

选择方案 B 作为架构方案：保留 `AndroidConnectionService` 的 target transport/channel/mux/heartbeat/reconnect 唯一 owner，在其下接入一个 native WebRTC `TransportBackend`，而不是新增第二个 native service 或独立 session/lifecycle owner。

这里的“B”描述 ownership 与生命周期边界；实现该 backend 时可以采用方案 A 所列的 libwebrtc/wrtc-android（或等价 Android WebRTC binding）作为底层引擎。底层库不是新的业务真相，也不拥有 route policy、target generation、mux/channel、heartbeat、重连或 UI 状态。

### 方案对比

| 方案 | Owner / 允许路径 | 禁止路径 | Gate 计划 | 回滚与成本 |
| --- | --- | --- | --- | --- |
| A. full native WebRTC + native signaling slice | 新增 native WebRTC/signaling owner；Android service 仅作为调用方；可在 native 层重建 signal、ICE、peer、DataChannel 与 relay lifecycle | 不得复制 `buildTraversalPlan()` / route health / `relayHostId` 真相；不得让 signaling slice 持有 target/session/channel/mux/heartbeat；不得绕过既有 typed command/event 与 mux wire | 先补 resource/module/edge/function/mainline/test-design；再做依赖/ABI/NDK preflight；native direct+relay 正反测试；signal/ICE ordering、generation fence、DataChannel binary/text、reconnect/cleanup；Android compile/unit；真实 ADB relay smoke；安装版本与 runtime SHA 对齐 | 可删除 native slice 回到现有显式 `webrtc-not-supported`，但会产生第二套 signaling/route/lifecycle 真相；依赖、ABI、NDK、包体与维护成本最高 |
| B. service owner + WebRTC backend（选中） | `AndroidConnectionService` 继续拥有 target、generation、route selection、mux/channel、heartbeat、retry/backoff；仅将 candidate-specific peer/ICE/DataChannel 通过 typed backend adapter 接入；复用共享 traversal candidate semantics | backend 不得直接改 UI、SessionContext、mirror/buffer/renderer；不得自行重连、切 route、创建第二个 mux/channel registry；不得把 control/debug/provider 字段写入业务 payload；不得把 native media library暴露为新业务 owner | 先锁 `Backend`/candidate adapter contract；依赖/ABI preflight；native WebRTC unit tests（direct/relay、ICE、ordered channel、failure/close）；service lifecycle tests（generation、retry、mux、heartbeat、route health）；TS/native protocol parity；type-check、feature/resource/module/edge gates；Android compile；真实 ADB direct+TURN relay、断网恢复、旧 generation rejection、cleanup 计数归零 | 逐 candidate 可显式失败并继续既有 WebSocket candidate；若 backend 不可用，保留 `webrtc-not-supported` typed error，不做静默降级。改动集中在 service adapter + native backend，能按 slice 删除，避免重写既有 service |

### Owner、allowed / forbidden paths

- 唯一 owner：`client.android_connection_service`（native service）继续拥有 physical target transport 与 lifecycle；新增的 native WebRTC backend 只能是该 owner 的实现子片，不注册为第二个 session/transport owner。
- Allowed：`route_policy -> shared traversal candidate adapter -> native WebRTC backend -> typed physical transport events -> AndroidConnectionService generation/mux/channel -> existing SessionContext projection`。
- Allowed：复用 `TraversalPlanCandidate` 的 `signalUrl`、`relayHostId`、`iceServers`、`iceTransportPolicy` 与 route diagnostics 语义；native 侧只做显式类型转换，不重新决定候选顺序。
- Forbidden：native backend 读取或写入 renderer、buffer、mirror、active tab、foreground/background、viewport；service 之外执行 `resize-window` 或改写 daemon truth；任何 UI 组件直接创建/关闭 peer；在 metadata、SDP、channel body 或 terminal payload 中混入 retry/provider/health/debug/control 语义。
- Forbidden：新增独立 signaling daemon、第二套 `relayHostId`/TURN credential 真相、backend 自己的 reconnect/backoff、跨 generation 复用 peer/channel，或用 screenshot/WebSocket fallback 把 WebRTC 失败投影成成功。

### 交付顺序与验证门

1. 先补机器映射：`resource.android_connection_service`、`client.android_connection_service` 的 owned paths、edge、function map、mainline call map 与 test design，明确 backend 作为同一 owner 的子片。
2. 做依赖与平台 preflight：固定 Android WebRTC artifact、ABI/NDK/minSdk、ProGuard/packaging、ICE API 与 DataChannel binary 支持；未通过则保持显式 unsupported，不提交半接线依赖。
3. 先写正反红测，再实现：candidate identity/route ordering、signal init/offer/answer、early ICE ordering、direct/relay policy、DataChannel text/binary、generation fence、retry/backoff、close/cleanup、already-terminal/non-terminal。
4. 跑 `test:android-connection-service`、transport/mux/route gates、`test:feature-registry`、type-check、Android unit/compile；之后才做在线 ADB direct + TURN relay、断网恢复与资源清理，确认安装 runtime 与源码 commit 一致。
5. 任何 backend 或协议代码变更都会使旧安装、在线样本与 review 证据失效；必须从定向测试、构建、安装/重启、真实样本重新闭环，最后才允许 AGY Review。

### 结论

方案 B 达成“native Android 可用 WebRTC/Relay”而不破坏现有唯一 owner：service 继续控制物理 target 生命周期，backend 只提供 candidate-specific WebRTC transport。方案 A 的 native library 仍可能被采用，但不能以独立 signaling/session/lifecycle slice 落地。当前仅记录决策，不改实现；在依赖与 machine-map gate 落地前，不得把 `RTC_DIRECT` / `RTC_RELAY` 从显式 unsupported 改为可用。

## 2026-08-27 Mac blackbox CDP root cause analysis

### 发现
- `zterm.v2.phase7.desktop.live.gate` 两次 blackbox 重跑（blackbox-final-pass、blackbox-rework-final）均失败：`CDP did not start on 9362: fetch failed`
- 同时 `lsof` 证明 ZTerm 进程在 9362 监听，但 DevTools HTTP endpoint 不可达
- `layout-final-pass` CDP 成功是因为它在 app.asar 打包**之前**运行（直接用未打包的 main process）
- `blackbox-final-4` 也失败，same error

### 根因
Packaged Electron app.asar 内 DevTools 默认被禁用。`--remote-debugging-port` 启动参数让 Electron 监听端口，但不自动暴露 DevTools HTTP endpoint。需要在启动参数加 `--disable-devtools` 或配置 Electron security settings。

### 当前状态
- pane-552 rework 仍在执行（PID 59210 黑盒脚本 + PID 59360 ZTerm 仍在运行）
- pane-552 会在发现根因后报告 blocker
- master 不注入、不重启、不催促，等 blocker 报告

### 待解决
- Mac packaged app 如何在黑盒 smoke 中暴露 CDP DevTools endpoint
- 可能方案：启动参数加 `--no-sandbox --disable-devtools=false` 或 Electron BrowserWindow 默认 webSecurity=false

### 根本原因：open -n --args 不传参数
- blackbox-gate.mjs 使用 `open -n <app> --args --remote-debugging-port=N` 启动
- layout 脚本使用 `spawn(<binary>)` 直接启动
- `open -n --args` 在 macOS 上不能可靠传递参数给 packaged Electron app 内的 launcher
- 修复在测试脚本，不在代码本身
- layout-final-pass 成功因为用 spawn()；blackbox 失败因为用 open -n
### 2026-08-28 session drawer rename closeout

- 长按重命名交付先因 AGY P0 测试缺口被退回；pane-5 补齐 `pointerDown(button=0)` + 550ms + `pointerUp` 测试后重新交付。
- 主线合并 commit `ed000290`；定向测试 60/60、feature/architecture registry 102/102、type-check 通过；2771 OTA 公网 manifest/APK、checksum、bundle verifier 全绿。
- 真机 `100.104.163.65:5555` 安装并重启 2771；普通点击标题不弹重命名，长按 700ms 弹出“重命名 session”。
- 新 AGY review `session-drawer-rename-gesture-20260828-review-2` PASS；Collab task 已 merged/closed。整体项目 goal 仍未完成，不能以单 task 结论替代总验收。
### 2026-08-28 session drawer unavailable regression

- 真机截图显示已连接/已枚举 session 被错误投影为灰色 `unavailable`，普通连接入口被禁用，只剩“重试”；这是当前 P0，不能用 UI 放开按钮掩盖 catalog/availability truth 错误。
- Collab task `session-drawer-availability-reconnect-20260828` 已由 pane-6 claim，owner worktree 为 `./playground/session-drawer-availability-reconnect-20260828`，base `ed000290`；master 不在主树并行改动。
- 初步代码边界：`TerminalPage` 负责 session/catalog projection，`terminal-drawer-session-availability.ts` 负责 availability reason，`TerminalSessionDrawer` 只消费 reason；需验证 `resolveSessionRemoteMissing()` 是否把已连接 session 的 stale history/catalog 状态误判为 remote-missing。
### 2026-08-29 session drawer availability reconnect delivery

- pane-6 证实首次偏离：`remote-tab-audit.ts` 在 `missingTabs.length === 0` 时提前 return，确认远端重新出现的 tab 不会清除旧 `remoteMissing=true`；修复为仅对非空确认 catalog 按 tab 写入 true/false，空/未知结果保持旧 truth。
- commit `9986c1ca` 已合并为主线 `a5e4d032`；audit 11/11、session drawer UI 189/189、feature registry 102/102、type-check、diff-check 和 AGY review 通过。
- 重新构建/发布 2772：`0.1.3.2772` / versionCode `1100027720`，APK SHA256 `29127a74be413d5c0698e7a4721fab9a4d7ed6cb4a2f6235077f87f9c3d41082`；本机、Tailscale、公网 manifest/APK 均一致，bundle verifier 全绿。
- 当前 adb 无在线设备，2772 真机安装/抽屉回归仍是明确缺口；task 保持 delivered，待 master 完成 L5 后再 close。
# 2026-09-01 browser remote-window mode

- 目标锚定：现有 Chrome 窗口经现有 remote-window 链路全屏投影；不启动实例、不改 native window；缩放只改 Android projection；CDP UA/target 控制暂未接入。
- 唯一 owner：catalog/capture/WebRTC 仍归 `daemon.remote_window_stream`；Chrome 过滤、browser entry 和 fullscreen projection 归 `client.remote_window_overlay`。
- 已实现：`Web` 浮动入口、Chrome bundle 过滤、选中后直接 fullscreen；普通 `窗` 入口保持 floating。
- 验证：remote-window runtime/helper/picker 定向测试 22/22（修正 picker test 后待重跑）；`pnpm --dir android run type-check` 通过（依赖通过现有 workspace node_modules 映射）。
- 剩余：CDP target mapping 与 UA typed control、真实 Chrome ScreenCaptureKit/WebRTC 在线样本、APK/模拟器验证未完成；当前不可宣称完整浏览器功能完成。

### 2026-09-01 browser remote-window CDP UA slice

- 浏览器特别版继续复用 `client.remote_window_ui` 与 `daemon.remote_window_stream`：Chrome picker 只允许四个 Chrome bundle，选中后 fullscreen；UA 控制只走 shared typed control side-channel，不进入媒体帧或 daemon 客户端状态。
- Android More 面板仅对 Chrome target 显示桌面版/移动版 UA 切换；切换状态显式投影 pending/applied/rejected。关闭 overlay 只停止 stream，并清理本地 UA 投影，不关闭 Chrome。
- daemon CDP helper 只访问现有 `127.0.0.1:9222/json/list`，按 page + 精确 title 唯一匹配；0 个或多个匹配均显式失败，不启动 Chrome、不 resize native window、不做 screenshot/CDP screencast fallback。
- 证据：`pnpm --dir android run type-check` PASS；定向 4 files / 71 tests PASS；feature registry 13 files / 103 tests PASS；`git diff --check` PASS。真实已安装 Android + Chrome CDP/WebRTC loopback 尚未完成。
- canonical `pnpm --dir android run build` 被现有 AppSDK pin gate 阻断：当前实际二进制 SHA `c015a7ab…` 与项目锁定 SHA `c26e500e…` 不一致；未改 lock、未绕过 gate。
- 2026-09-01 已将浏览器 worktree 快进到最新 `origin/main` `b238e20a`（build 2820），并按版本真源分配 build 2821；类型/定向测试/feature registry 仍通过，但 canonical build 继续被同一 AppSDK digest gate 阻断，因此尚未进入最终 commit、主 tree merge 或 OTA。

# 2026-08-31 session rename reconnect race fix

- Root cause: `resolveMuxChannelClosedWithControlStatusRuntime` captured the rename-time `sessionName` in its async control query; renaming race left the post-query session-present check comparing the old name, so a renamed session was treated as missing and entered the slow reconnect backoff.
- Fix: the unique owner `terminal.transport_lifecycle.channel_closed_control_status` now re-reads the still-closed channel's `sessionName` after `queryTargetSessions()` resolves before deciding presence; it also surfaces the resolved name in the runtime-debug event.
- Tests: `session-context-transport-orchestration-runtime.test.ts` adds a red-then-green rename-race case (24/24), plus regression for the positive and negative control paths; `session-context-session-runtime.test.ts` + `terminal-channel-mux-runtime.test.ts` still 38 + 7 = 45 PASS; `tsc --noEmit` PASS; `git diff --check` clean; canonical build blocked at `COMPILED_STAGE_REQUIRES_ARTIFACT` because this worktree does not carry the frozen AppSDK compiled tree (not a code defect).
- Device L5 still pending: emulator install + adb-driven rename→reconnect replay is the user-visible acceptance gate; commit will be deferred until that gate is exercised or Jason releases the L5 evidence.
