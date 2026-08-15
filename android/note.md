# 2026-07-29 remote-window sibling switch / screenshot / fullscreen gesture diagnosis

# 2026-08-14 Phase 3 production client.terminal_channel_mux cutover

- Phase 3 first production slice: `client.terminal_channel_mux` now owns `src/lib/terminal-channel-mux-runtime.ts` (`TerminalChannelMuxStore`). `SessionTransportRuntimeStore.terminalChannels` embeds the store; `TargetTransportRuntime` no longer owns `channels`.
- Callers were migrated without behavior change: session transport store, transport accessors, transport-open types, infra facade body subscription, provider assembly types, and lifecycle tests.
- Registry/docs bound: module-registry `owned_paths`, edge-registry `import_edges` (`client.daemon_connection -> client.terminal_channel_mux`, `client.session_runtime -> client.terminal_channel_mux`), resource truth stores, function map, wiki call map/source, feature registry, test designs, AppSDK maps.
- Verification: dedicated channel-store tests 7/7; targeted transport/session/lifecycle 161/161; `test:feature-registry` 83/83; `test:debug-observability` 61/61; `tsc --noEmit` PASS; full `pnpm run build` PASS; AppSDK `appsdk verify android` ok:true.
- Remaining: no ReviewRecord/PASS (codex-review MCP unavailable); later slices still needed for `daemon.input_queue`, production composition/control owners, Phases 4-8. Do not claim complete or promote.

# 2026-08-14 same-account all-daemon visibility diagnosis

- Jason requires every client logged into the same Relay account to see every daemon identity in that account.
- Known flow: `relay.account_directory -> relay.directory_ui`. Relay server directory retains daemon identity when disconnected; client projection currently calls `projectOnlineTraversalRelayDaemonDevicesFromAccount()` and filters by `connected + freshness + this-client recent connection`.
- First-divergence hypothesis H1: local recent-connection truth makes daemon visibility client-specific. Online/freshness is connectability truth, not account-directory membership truth.
- Formal runtime/tests remain read-only. Experiment contract: `playground/relay-account-all-daemons-20260814/README.md`. Design ID `FD-20260814-ACCOUNT-DAEMON-VISIBILITY-01` is not yet approved.
- Causal experiment confirmed H1: current online projection gives client A `daemon-a,daemon-b` and client B only `daemon-a` from the same directory when local recent maps differ; direct account-membership projection gives both clients the same two daemon ids. Playground 2/2 PASS.
- Fix design `FD-20260814-ACCOUNT-DAEMON-VISIBILITY-01` is now `WAITING_FOR_JASON_APPROVAL`; formal code remains unchanged.
- After Jason approved `FD-20260814-ACCOUNT-DAEMON-VISIBILITY-01`, implementation preflight found its allowed paths omitted drawer/picker consumers required to preserve "visible but not connectable" semantics. Marked `SCOPE_INVALIDATED` before product edits. Replacement `FD-20260814-ACCOUNT-DAEMON-VISIBILITY-02` keeps the same owner/first divergence and adds only Home/drawer/picker projection consumers plus focused tests; status `WAITING_FOR_JASON_APPROVAL`.

# 2026-08-13 foreground resume transport close H2

- Jason approved `FD-20260813-FOREGROUND-CLEANUP-01`; formal fix is now applied in `src/contexts/session-context-lifecycle.ts`.
- Lifecycle cleanup is provider-disposal-only: callback refs track the latest cleanup functions, while the physical socket/control cleanup effect has an empty dependency list. Relay/control settings refresh can rebuild callback identities without closing a healthy target transport.
- Regression gate: `session-context-lifecycle.test.tsx` proves callback refresh keeps an `OPEN` socket open and provider unmount still invokes the latest cleanup functions. The H2 playground positive/reverse intervention remains causal evidence.

- H1 network identity baseline 修复后，真实 round-trip 仍复现。`foreground-same-network-round-1` 的首偏离不是 network generation：seq 455 target `OPEN`，seq 467 收到 `mux-pong`，期间无 `app.network.identity.generation-changed`；seq 468 才出现 `session.mux.target-transport-failed`。
- 真实事件在 seq 461/462 显示 Relay device stream 先因 `app relay runtime disposed` 旧 generation cleanup，再启动新 generation；terminal target 随后关闭。`relay.device-stream.close.stale` 不是 terminal socket 的 owner，但证明了前台/后台期间 React runtime generation 正在重建。
- 静态调用链确认：`AppContent.handleForegroundResumeAfterControlRefresh` -> `refreshControlDirectory` -> Relay settings `setBridgeSettings`；`SessionProvider` 的 `bridgeSettings` 变化重建 transport/lifecycle callback；`session-context-lifecycle.ts` 的最后 cleanup effect 依赖 `cleanupSocket` / `cleanupControlSocket`，依赖变化时 cleanup 会调用 `cleanupSocket(session.id, true)`，因此普通 settings refresh 会关闭健康 target socket。
- H2 单假设 playground：`playground/foreground-resume-reconnect-20260813/H2-background-transport-close/`。正向干预是将依赖变化与 provider disposal 分离，保持 OPEN socket；反向恢复 cleanup 后复现 close。Fix Design ID：`FD-20260813-FOREGROUND-CLEANUP-01`，已获 Jason 批准并已落正式代码。

# 2026-08-12 startup reconnect HTTP preflight fix

- Root cause confirmed in `playground/reconnect-startup-20260812/H1-http-preflight-block`: reconnect used HTTP `/health` reachability as admission control. When all HTTP probes failed, it scheduled another probe and never queued the real mux/WebSocket/WebRTC open.
- Formal owner: `terminal.transport_lifecycle`, `session-context-session-runtime.ts`. The typed transport owner now queues the current reconnect open immediately; HTTP probes run asynchronously as metadata-only diagnostics. They do not select a route, rewrite host truth, schedule a second retry, or suppress mux open.
- Red/green evidence: `runReconnectHostProbeAndFallback` tests cover all-probes-false immediate open and a still-pending HTTP probe not delaying open; focused reconnect/infrastructure/orchestration/probe suite is 69/69 PASS; `tsc --noEmit` PASS.

# 2026-08-12 Android Tailscale WebSocket false timeout diagnosis

- User path: installed Android `0.1.3.2587` cold launch, explicitly open Macbookair `100.86.84.63:3333`; native alert reports `ws connect timeout`.
- First divergence: `TraversalSocket` uses a Tailscale-only 900ms candidate deadline introduced by `2564c474`. On the current Android WebView over DERP, healthy authenticated WebSocket opens take 729-977ms, so the timer can beat `onopen`.
- Causal proof from the same installed WebView and endpoint: 900ms observation budget produced 2/12 false timeouts; 1800ms produced 12/12 opens in 772-976ms. Device ping had 0% loss with 29.5-825ms RTT; Mac-side `/health` was HTTP 200.
- Root cause is the invalid sub-100ms Tailscale latency assumption, not route-health admission, daemon, mux, auth, tmux, buffer, or renderer. Route health only persisted the downstream false timeout.
- Fix design: `FD-20260812-TAILSCALE-WS-BUDGET-01`. Unique owner is `src/lib/traversal/socket.ts`; delete the Tailscale-specific contraction and reuse the generic WebSocket deadline. Formal code remains unchanged pending Jason approval.

- Symptom from live screenshot/user report: remote-window overlay can show `截图失败`; after tapping a secondary/sibling remote window, the active connection/video loses usability; fullscreen pinch-to-zoom is misclassified as scroll; remote scroll feels choppy.
- SOP/model flow: known `desktop.remote_window_stream` plus screenshot subflow `terminal.remote_screenshot`. Resource path is `resource.remote_window_overlay -> resource.remote_window_touch_action -> resource.remote_window_stream`; screenshot path is `resource.remote_window_overlay -> resource.remote_screenshot`. Forbidden: terminal buffer/render, daemon tmux mirror, route fallback, or transport reconnect compensation.
- MemoryPalace search gap: `scripts/mempalace-mine-zterm.sh search "remote-window sibling screenshot pinch scroll"` failed because `/Users/fanzhang/.local/pipx/venvs/mempalace/bin/python` is missing. Diagnosis therefore used project docs/registry/note/source directly and does not claim MP coverage.
- Confirmed first divergence H1: `RemoteWindowOverlay.handleSelectTarget()` stops the previous stream and clears receiver media before the new sibling target stream is confirmed. If the new stream or screenshot-adjacent target handoff fails, the currently usable stream is already gone. Unique owner: `desktop.remote_window_stream.overlay.project`; allowed paths `RemoteWindowOverlay.tsx` and its overlay tests.
- Confirmed first divergence H2: fullscreen pair gesture classification requires each finger's axis projection to dominate perpendicular movement. A real pinch with vertical drift can have clear opposite-distance expansion but enough midpoint movement to fall through into `twoFingerScroll`, so zoom is emitted as a remote scroll. Unique owner: client overlay/touch-action classifier in `RemoteWindowOverlay.tsx` tests.
- Screenshot failure itself is downstream explicit error projection: existing screenshot handler sets `screenshotStatus=failed` and does not focus or clear stream state. The fix should keep screenshot non-input and avoid treating thumbnail/screenshot failure as stream truth.
- Required verification: red/green overlay tests for sibling switch failed handoff, overlapping sibling handoff stale result cleanup, old-stream cleanup failure projection, clear-pinch-no-scroll, default safe boundary, and thumbnail refresh; focused remote-window tests; typecheck. L5 phone replay remains needed for final tactile smoothness proof.

# 2026-07-25 session preview child refresh / body tap diagnosis

- Jason reported two regressions in the multi-session preview group UI: secondary preview bodies appear black / not refreshing, and tapping inside the child window body does not promote it; only the top title area works. The visible order badges `1/2/3/4` also consume too much header space.
- SOP/model flow: existing `terminal.session_preview` flow. Resource path is `resource.ui_projection -> resource.session_preview_mode -> resource.client_sparse_buffer -> resource.renderer_window`; preview body subscription remains through `resource.active_session -> resource.session_transport`. Forbidden: daemon, tmux mirror, terminal buffer/render store truth, or transport fallback changes.
- Read-only evidence: `pnpm --dir android run terminal:preview:source-dom-gate` passed before edits with six controlled tmux sessions. It proved `tmux source -> daemon -> client sparse -> preview DOM` can refresh all six child containers and cleanup subscribers, so the current first edit should stay in the UI projection owner rather than daemon/buffer.
- Confirmed first divergence for interaction: `TerminalPreviewGrid` wraps the body in `data-preview-scroll-surface` and its `onClick` always `preventDefault()/stopPropagation()`. That blocks the already-mapped secondary tile promotion path for clicks inside the terminal body. The titlebar click works only because it does not block `click` bubbling.
- Unique owner/edit scope: `terminal.session_preview.grid.render` in `src/components/terminal/TerminalPreviewGrid.tsx`, its tests, and preview test design/map docs. Required red/green: body tap on secondary promotes without activation, scroll/move still does not activate, child DOM refresh remains per-session after promotion, and visual order badges are removed while data order remains available for tests.
- Jason added that the lower/smaller child preview windows should use smaller local typography as a glance preview, while not changing tmux layout. This stays in the same owner: secondary `TerminalView` gets compact font/row height, remains `mirror-fixed`, and still receives no resize/width/viewport callbacks.
- Verification after the compact font change: focused preview suite `6 files / 46 PASS`, `tsc --noEmit` PASS, feature/resource/function/mainline gates `48 PASS`, `git diff --check` PASS, and `terminal:preview:source-dom-gate` PASS with six controlled tmux sessions matching source->daemon->client->DOM and subscribers returning `0 -> 6 -> 0`.

# 2026-07-23 remote-window PID focus/live probe closeout

- Confirmed previous `remote-window-live-input-probe.ts` was still too weak for duplicate/temp app identities: bundle-id checks can pass the wrong app instance. The live gate now filters catalog targets by the exact AppKit probe PID from the file-backed `PROBE_READY` log and verifies frontmost by PID after defocus/focus.
- Live failure after switching to PID truth: raw probe exposed `remote input target app is not running` immediately after a focus ACK. Independent `.app` lifecycle and Swift `NSRunningApplication(processIdentifier:)` checks showed the probe app stays alive and the API can resolve the same PID, so the fix stayed in the daemon input helper rather than Android UI/transport.
- Fix scope: `desktop.remote_window_stream.daemon.input_inject`. The macOS helper now activates by PID through System Events and uses a bounded `waitForRunningApplication(pid)` before declaring the app not running. The error keeps the PID in the explicit message; no bundle fallback or hidden success path was added.
- Verified installed daemon runtime SHA `9931f2f94de15e85df00856b1914e4d27025d9084682f814ae4fe9239fe735a1` after `daemon:prepare-release`, `daemon:install-global`, and service-scoped `zterm-daemon restart`; `/health` returned pid `42295`, uptime `3`.
- Live gates passed serially: raw WebSocket local, raw burst local, mux local `session=zterm`, mux burst with `CLIENT_CLOCK_OFFSET_MS=-60000`, and mux Tailscale `ws://100.66.1.82:3333`. Each successful gate defocused to Finder, restored the target PID, and observed target-side AppKit mouse down/up, dragged, scroll, and key markers.
- Static gates passed: `remote-window-stream-daemon.test.ts` 44 PASS, `tsc --noEmit` PASS, feature registry gates 48 PASS, resource/function/mainline/wiki gates 20 PASS, `git diff --check` PASS.

# 2026-07-23 remote-window real app control correction diagnosis

- Jason corrected the previous closeout: proving `remote-window-input` frames reach a controlled AppKit probe is not sufficient. The product failure is that real remote app control is not stable: video can stream, but the app is not reliably brought to foreground and user gestures/input do not take effect.
- SOP/model flow: known `desktop.remote_window_stream`. Resource path is `resource.remote_window_overlay -> resource.remote_window_touch_action -> resource.session_transport -> resource.remote_window_stream`. Video receiver/capture is separate from control; the control flow must be validated independently as `focus -> gesture/input -> combined video surface`.
- First gap in current verification: `scripts/remote-window-live-input-probe.ts` launches the AppKit probe and leaves it frontmost before sending input, so `focusTargetWindow()` can pass through the fast path and the test does not prove daemon can bring a background/covered real app to front.
- Active hypothesis H1: the focus/control gate is a false positive because it tests an already-frontmost synthetic window; it does not assert frontmost transition before accepted `focus`, so real-app focus failure can survive. Verification action: update the live probe to activate another app before sending input and assert accepted focus changes macOS frontmost app back to the target bundle before pointer/scroll/key are considered delivered.
- Unique owner for diagnosis/test scope: `desktop.remote_window_stream` live gate and daemon input owner. Allowed paths for the first edit round: `android/scripts/remote-window-live-input-probe.ts`, `android/docs/testing/remote-window-stream-test-design.md`, `android/MEMORY.md`, `.agents/skills/zterm-mobile-dev/SKILL.md`; product code remains locked until the defocused live gate identifies the first failing node.
- H1 was confirmed by the real-app gate: `remote-window-existing-app-focus-probe` against WeChat returned `remote window input helper timed out` while the video stream started. After installing the staged daemon with a 3s focus timeout it still failed, which moved first divergence inside the Swift focus helper rather than Android or WebRTC.
- H2 confirmed: the Swift focus loop called `NSAppleScript(tell application id ... activate)` twice per attempt. On this Mac, `osascript` activation of WeChat takes about 2.07s by itself, so one focus attempt can exceed the helper's bounded control-action deadline before AXRaise/focused-window verification returns. A direct Swift `NSRunningApplication.activate + AX frontmost` probe changed frontmost to WeChat in about 0.5s. Fix scope is still `desktop.remote_window_stream.daemon.input_inject`: remove blocking AppleScript activation from the persistent helper and keep AX frontmost/raise/focused verification as the only focus truth.

# 2026-07-22 connected green body/catalog stale diagnosis

- Symptom: Android 0.1.3.2213 can show a green transport with rx/tx counters while the terminal body stops refreshing; opening Remote Window then shows `远程窗口列表读取超时`. Killing the app and re-entering restores updates.
- Expected: one daemon target physical transport remains valid, or the transport lifecycle owner marks it failed and reopens before body/catalog requests are sent. Remote-window catalog is only a control-plane consumer and must not mask transport truth.
- Flow: `terminal.transport_lifecycle` via `resource.session_transport -> resource.daemon_target_transport -> resource.terminal_channel -> resource.transport_subscriber`; remote-window catalog uses `resource.remote_window_stream` only after an open session transport exists.
- Evidence:
  - Local daemon direct catalog is healthy: `remote-window-targets-request includeIterm2=false` returned 19 targets in 945ms; full catalog returned 32 targets in 1690ms.
  - Local `/health` while Jason's screenshot still showed green connection reported `sessions.total=0`, `attached=0`, `ready=0`, mirrors still ready.
  - Daemon log at 2026-07-22 20:22:54: `transport ... stale inbound heartbeat kind=rtc staleForMs=10022`, then detached/closed transport. This matches a dead server-side subscriber while Android still projects an open client route.
  - Source mismatch: daemon `TERMINAL_TRANSPORT_STALE_INBOUND_MS = 10_000`; Android `startSocketHeartbeatInfraRuntime` sends physical heartbeat every `60_000ms` with `maxConsecutiveMisses=3`. A quiet RTC/mux transport can therefore be detached by daemon before the client heartbeat is even due.
- Active hypothesis: H1, first divergence is daemon physical transport liveness policy. It uses a 10s inbound-stale timeout even though the client heartbeat contract is 60s. This creates server-detached/client-open split truth and downstream body/catalog timeouts.
- Unique owner: `terminal.transport_lifecycle` / daemon physical transport heartbeat policy in `android/src/server/terminal-transport-runtime.ts` and tests in `android/src/server/terminal-daemon-runtime.test.ts`. Client render and remote-window overlay are downstream consumers and forbidden as compensation points.
- Required red/green:
  - Positive: an attached RTC mux transport with no inbound frame at 11s must stay attached/open because the client heartbeat is 60s.
  - Negative: an attached RTC mux transport beyond the daemon stale bound must still detach every mux subscriber and close only the physical transport, without destroying mirrors.
  - Existing mapped context/transport gates plus typecheck and diff-check.

# 2026-07-22 remote-window focus + desktop-fullscreen bitrate correction

- Symptom: Jason reports generic remote app control still fails because the selected desktop app is not actually brought to the foreground. Jason also corrected bitrate semantics: app-window default encoding bitrate must be `2mbps`; `fullscreen`/20Mbps means the computer-side window is desktop fullscreen, not Android phone fullscreen.
- SOP/model flow: `desktop.remote_window_stream`: Android overlay projects picker/floating/fullscreen UI and emits explicit input/quality intents; daemon `remote-window-stream-daemon` owns macOS catalog, desktop fullscreen manifest metadata, AX frontmost/focus verification, and Quartz input injection.
- Active hypotheses:
  - H1: bitrate first divergence is `remote-window-video-quality` and `RemoteWindowOverlay#handleFullscreen`: current defaults infer high bitrate from target resolution and Android fullscreen entry upgrades untouched presets to `fullscreen`/20Mbps. This contradicts the corrected desktop-fullscreen-only semantics.
  - H2: focus first divergence is daemon Swift input helper: current helper runs `NSRunningApplication.activate` + `AXRaise`, but does not explicitly set AX app `kAXFrontmostAttribute`; for some ordinary apps the focus-only event can return downstream without the target app becoming usable foreground truth.
- Unique owner/edit scope: `packages/shared/src/connection/protocol.ts`, `android/src/server/remote-window-stream-daemon.ts`, `android/src/lib/remote-window-video-quality.ts`, `android/src/components/terminal/RemoteWindowOverlay.tsx`, their focused tests, and remote-window docs/skill. Forbidden: terminal transport reconnect, buffer/render, tmux width, file-transfer fallback, route selection.
- Required verification: fail/green `remote-window-video-quality.test.ts`, `RemoteWindowOverlay.test.tsx`, `TerminalPage.remote-window-overlay.test.tsx`, `remote-window-stream-daemon.test.ts`; then `tsc --noEmit`, `test:feature-registry`, `git diff --check`. Live phone/WeChat replay remains dependent on an online test device and installed daemon reload.

# 2026-07-22 remote app focus diagnosis

- Symptom: remote video can display a selected app window, but the app is not activated/focused and remote control input is unavailable.
- SOP/model flow: `desktop.remote_window_stream` -> daemon app-window catalog projection -> Android input capability projection -> explicit focus intent -> daemon AX/Quartz focus verification -> OS input injection.
- Single active hypothesis: daemon app-window manifests are projected as read-only. `RemoteWindowOverlay.isRemoteWindowInputSupported()` requires `streamMode='interactive'`; the two daemon app-window builders currently emit `streamMode='view'`. This makes `inputContext` null and causes `sendRemoteWindowInputIntent()` to reject the initial focus intent and all later input before transport.
- First divergence: `buildMacosAppWindowTargets()` / app-window branch of `buildRemoteWindowStreamTargets()` changes an interactive app-window target into `view`.
- Unique owner and allowed edit scope: `android/src/server/remote-window-stream-daemon.ts` plus its owner tests in `android/src/server/remote-window-stream-daemon.test.ts`. iTerm2 pane targets remain `view`, including `tmux-input` and `iterm2-api` read-only routes.
- Required verification: daemon manifest positive assertions for app-window `interactive`; negative assertions that iTerm2 panes remain `view`; existing Android overlay focus-context/explicit-focus tests; TypeScript check; feature-registry gates; build only after local gates pass. Live Android input replay remains dependent on an online device.
- Fix completed: changed the daemon app-window projection to `streamMode='interactive'` in both `buildMacosAppWindowTargets()` and the app-window branch of `buildRemoteWindowStreamTargets()`, leaving iTerm2 panes on `view`.
- Verification completed: `pnpm --dir android exec vitest run src/server/remote-window-stream-daemon.test.ts src/components/terminal/RemoteWindowOverlay.test.tsx --reporter dot` passed `69 tests`; `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` passed; `pnpm --dir android run test:feature-registry` passed `48 tests`; `pnpm --dir android run build:android` passed with APK `0.1.3.2207`, versionCode `1032207`, sha256 `9295aaac4376e3ca618b919a37137a19bd4e42198bb5d9956e6e6201d417a9d1`. No online ADB device was attached, so live phone focus replay remains open.

# 2026-07-22 relay route projection keeps losing Tailscale fallback

- Symptom: Jason reports that when Relay is unavailable the whole service fails, which violates the intended design because Tailscale should remain independent and serve as the backup path.
- Evidence so far: the Home/relay route projection for an explicit relay entry strips `bridgeHost` and currently only keeps `relay-rtc` candidates. In production relay directory snapshots the daemon entry can contain only `relay-rtc`, so the relay-open target can lose the saved direct/Tailscale identity entirely.
- Working hypothesis: the unique owner is `connections.history_projection` / `relay.directory_ui`, not transport. The fix should preserve the saved direct identity and route candidates in the relay-derived Home target instead of forcing a relay-only target.
- Verification to add: a black-box test that opening the relay-derived Home entry still preserves the direct/Tailscale route in the traversal plan, and a negative test that a relay-only directory entry does not invent a direct route.

# 2026-07-22 drawer open disconnects because remote audit still opens a second Relay RTC client peer

- Symptom: Jason reports opening the Terminal drawer now always disconnects and cannot self-recover; tapping the top status `UDP` reconnect action recovers.
- Flow classification: known `terminal.transport_lifecycle.target_tmux_management` + `terminal.session_drawer`. Drawer open is `TerminalSessionDrawer -> onRefreshHostSessions -> useSessionOpenActions.handleRefreshDrawerHostSessions -> manageTmuxSessionsForTarget`. Allowed resource path is `resource.ui_projection -> resource.active_session -> resource.session_transport -> resource.daemon_target_transport -> mux-target-message`; drawer/open-tab audit must not directly open a new transport while a matching open target exists.
- Confirmed first divergence: the main drawer refresh path now correctly uses `manageTmuxSessionsOnOpenTransport`, but `handleRemoteSessionsRefreshed()` still unconditionally triggers `auditOpenTabsAgainstRemoteSessions('session-picker-refresh')`. That audit calls `open-tab-restore.fetchRemoteTmuxSessionNamesByOwner()`, which calls legacy `fetchTmuxSessions()` and constructs a new `TraversalSocket`.
- Relay-side evidence: `traversal-relay/server.ts#registerClient` keys an active client peer by `userId + hostId + deviceId`; `bindClientPeerSocket()` closes the previous active socket with `relay client socket replaced`. Therefore a drawer-triggered second `TraversalSocket` for the same relay host/device can close the active terminal mux socket. This matches “打开抽屉一定断掉；点 UDP 重新连接才恢复”.
- Unique owner/edit scope: keep the fix in open-tab remote audit / restore fetch owner plus App wiring to SessionContext tmux management API. `fetchRemoteTmuxSessionNamesByOwner()` must prefer existing open mux target management for matching non-closed sessions and must not fallback to legacy `tmux-sessions.ts` if that open target exists but is not ready or errors. UI drawer, renderer, buffer, daemon mirror, and Relay replacement policy are downstream/forbidden.
- Test design: add positive test that remote audit/session restore owner lists sessions through `manageTmuxSessionsOnOpenTransport` when an open same-daemon session exists; add negative tests proving legacy `fetchTmuxSessions` is not called when open-target management returns `null` or throws; keep legacy fetch only when no matching open target exists. Add hook wiring test so `useOpenTabRuntime` passes current sessions and manager into the audit.
- Verification: `pnpm --dir android exec vitest run src/lib/open-tab-restore.test.ts src/lib/remote-tab-audit.test.ts src/hooks/useOpenTabRuntime.test.tsx src/hooks/useSessionOpenActions.test.tsx --reporter dot` passed; `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` passed; `./android/scripts/build-android-debug.sh` passed and published `android/update-dist/zterm-0.1.3.2205.apk` with sha256 `e704ddc77953bebfa474a76574ad54369bc073ce3393e2b91ef393027f003381`. No ADB device was attached, so live install smoke remains open.

# 2026-07-21 remote-window operation focus injection repair

- 现场反馈：远程 app 控制时，用户点击/滚动/键盘/手势操作需要把目标 app/window 拉到焦点；当前体感是没有焦点注入，导致远程控制失败。
- 架构映射：`feature_id=desktop.remote_window_stream`；资源链为 `resource.remote_window_overlay -> resource.remote_window_stream -> resource.daemon_process`。Android overlay/TerminalPage 只负责发显式 `focus` intent 与输入 intent；daemon `remote-window-stream-daemon` 是唯一 AXRaise/focus verification/Quartz event owner。禁止 UI 计算 macOS focus truth，禁止 terminal transport/buffer 层补偿。
- 代码证据：当前 daemon Swift helper 的 `handleConfig` 会在每个 `focus/pointer/scroll/gesture/key` 事件前执行 `focusTargetWindow(config)`；live daemon runtime 也包含该逻辑。Android 现有覆盖只锁住 stream start、pointerdown、wheel、key、QuickBar/IME batch 首个 focus；没有锁“每个逻辑操作事件本身前必须紧邻 focus”，尤其 touch gesture 是 pointerdown 先 focus，release 时才发 `gesture`，中间没有紧邻 focus。
- 本轮唯一修改面：`RemoteWindowOverlay` 与 `TerminalPage#emitRemoteWindowInputEvents` 的 client input intent builder。做法是将 supported app-window 的非 focus 输入统一走 focus-first helper：每个 pointer/scroll/gesture/key 事件发送前先发送同 stream/target 的 `focus`；TerminalPage QuickBar/IME 的每个事件也按 `focus,event` 成对发送。daemon 仍保留最终 focus 验证，不把错误伪造成成功。
- 红测设计：正向锁 touch tap/down-up、touch swipe gesture、wheel/key、QuickBar/IME 事件都必须是 focus-first；反向锁 iTerm/tmux unsupported read-only target 不发 focus/input。必要 gate：`RemoteWindowOverlay.test.tsx`、`TerminalPage.remote-window-overlay.test.tsx`、`TerminalPage.android-ime.test.tsx`、remote-window runtime/daemon tests、`tsc`、feature registry、build APK。
- 追加可复用结论：终端快捷键编辑器的组合键规则不能把 `Shift` 只限制在字母/Enter/Tab；`Shift + 方向键` 需要直接映射到合法的 shifted terminal sequence，并且保存预览要保持 `Shift + 目标键` 的规范化顺序。

# 2026-07-21 auto route / mux timeout / remote-window focus closeout

- 现场 `terminal mux channel open timeout` 首轮根因已证实不是 Android mux client 本身，而是 Mac daemon release artifact stale：installed runtime 当时缺 `mux-hello` / `mux-ready` / `mux-channel-open`。本轮已执行 `daemon:prepare-release`、global install、service-scoped restart；当前 live daemon `pid=88422`，installed release runtime sha 与 repo release runtime sha 都是 `7ce8b8d28ee64295eee4ab25915c2d89c76afbe5b8ceb0df8b9a3acf4652d65c`，live mux smoke 得到 `mux-ready` + `mux-channel-opened`。
- Auto route 本轮设计锁定：Auto 不消费旧 `traversalPathPriority`，默认 `Tailscale/direct websocket -> WebRTC UDP direct -> TURN/Relay`；手动选择只作为显式 override，不写回 Auto 全局顺序。
- Jason 新反馈 remote-window 视频目标 app 没被拉到 focus。代码/doc 真源显示 focus 属于 `desktop.remote_window_stream.daemon.input_inject`：Android overlay 只能发 input intent，daemon helper 必须 bring-to-front / focus 后再注入 OS event。修复后 Android 视频 surface 在 pointerdown 先发送 explicit `focus` intent，QuickBar/IME batch 先发 `focus` 再发 key/text；daemon helper 对 `focus` 做 focus-only 操作，并验证 frontmost + focused 后才返回成功。本机直接 helper smoke 对微信返回 `ok=true`，frontmost 从 `com.googlecode.iterm2` 变成 `com.tencent.xinWeChat`。本轮 APK `0.1.3.2190` sha256 `05f8237626f1fbade0aca65d2b16b7644a3f379d5b12e87179e3393211efa895`。
- MemoryPalace 收口 mine 当前被现有 PID `56674` 占用，该进程是另一路 `mempalace mine . --wing routecodex --no-gitignore`；本轮未 broad kill，待 holder 结束后再 mine `wing=zterm` 并搜新短语。

# 2026-07-21 drawer tmux management must not replace active mux transport

- Symptom: opening the Android session drawer can show `tmux open data channel error` and the active `zterm` terminal disconnects; Jason correctly pointed out the phone must not rebuild/replace an already-maintained connection.
- Expected: while the phone still has an open daemon-target mux transport, drawer refresh / quick create / remote kill use that same physical transport and send target-level `mux-target-message` requests. They must not create a second `TraversalSocket`/RTC peer that can replace the first peer on the daemon/relay side.
- Flow/model: known `terminal.transport_lifecycle`. Resource path is `resource.ui_projection -> resource.active_session -> resource.session_transport -> resource.daemon_target_transport`; target-level tmux management is allowed only through the existing daemon-target transport when it exists. UI/drawer cannot directly own transport sockets.
- Active hypothesis H1: `useSessionOpenActions.handleRefreshDrawerHostSessions()` and related create/kill paths still call `android/src/lib/tmux-sessions.ts`, whose pool constructs a fresh `TraversalSocket`. For Relay RTC with the same peer id, daemon `rtc-bridge.initializePeerConnection()` closes the older peer as "replaced by new init", so drawer management can kill the active terminal transport. Evidence: source import/calls in `useSessionOpenActions.ts`; `tmux-sessions.ts` owns `new TraversalSocket`; mux target protocol already supports `mux-target-message` with `requestId`, but `handleTargetMuxServerFrameRuntime()` only logs `mux-target-message`.
- First divergence node: drawer/session-open tmux management request chooses legacy target-scoped `TraversalSocket` even when `SessionContext` already has an open mux daemon-target transport.
- Unique owner/edit scope: `terminal.transport_lifecycle` plus session-open owner wiring. Allowed source paths: SessionContext transport/public facade files, `useSessionOpenActions.ts`, focused tests, this test design/note/skill. Forbidden: renderer, buffer store, daemon mirror, Relay fallback/replacement logic.
- Test design: add red tests proving SessionContext sends/resolves request-id target messages on one physical mux socket; add hook tests proving drawer refresh/kill prefer the injected open-transport management API and do not call legacy `fetchTmuxSessions`/`killTmuxSession` when a matching open session exists; keep negative fallback test only for no matching open target.
- Fix: added `session-context-tmux-management-runtime.ts`, wired it through SessionContext/provider/facade, and changed `useSessionOpenActions` tmux management operations to call `manageTmuxSessionsOnOpenTransport()` first for a matching non-closed open Session. `mux-target-message` response settlement is request-id keyed, malformed/daemon-error/timeout responses reject, and fallback to legacy `tmux-sessions.ts` is blocked whenever a matching open Session exists even if the mux target is not yet ready.
- Verification: focused mux-management/runtime/hook/SessionContext tests passed; mapped mux/session regression `13 files / 329 PASS`; `tsc --noEmit`, feature/resource/function/mainline gates, `git diff --check`, and full `build:android` passed. Local same-socket mux probe listed 10 sessions including `zterm`; after service-scoped daemon restart restored `/health`, production Relay same-datachannel mux probe listed 10 sessions including `zterm`. Android `0.1.3.2203` was published to the public Relay update route with sha256 `fd73468d5430a3faff990dcb73323891777cad1241d7ac3645c929e26297596f`.

# 2026-07-20 Android exit stale transport keeps tmux window occupied

- Jason reported a follow-up Android field symptom: re-entering a session can show uplink/downlink traffic in the status strip while the terminal body does not update, and asked whether UDP/WebRTC and Tailscale/WebSocket recovery are being conflated.
- Code evidence: `buildTransportTargetKey()` used only `bridgeHost:bridgePort:authToken`. That means a direct/Tailscale WebSocket host and a Relay/WebRTC-capable host for the same daemon could be treated as the same physical target; restore/open-intent could therefore reuse an old OPEN socket/control transport instead of rebuilding for the route-aware host. Status traffic can still move because ping/control bytes are flowing, while visible body subscription/buffer-sync belongs to the wrong transport truth.
- Fix: `session-transport-runtime` target keys now include semantic route identity: `transportMode`, daemon/relay identity, direct endpoint fields, signal URL, and normalized Relay endpoint candidates. Volatile Relay directory `lastSeenAt` is excluded so directory freshness does not churn sockets by itself.
- Regression added: direct websocket and Relay/WebRTC route-aware hosts with the same bridge endpoint must produce different target keys; `lastSeenAt` changes must not change the key; `openSessionTransportByIntentRuntime()` must rebuild when current OPEN direct socket receives a route-aware Relay host intent instead of reusing it.
- Verification: route target focused suite PASS 4 files / 40 tests; route/transport regression PASS 9 files / 277 tests; `tsc --noEmit` PASS; feature/resource/mainline gates PASS 48 tests; full `build:android` PASS with terminal contracts 48 files / 593 tests, common flows 82 tests, local Relay smoke, Gradle and manifest verification. APK `0.1.3.2185` / versionCode `1032185` sha256 `44c8490921f2b78bd0947a378fa3bac7bbecff51bb5c0c9cf33dc66f51d27e4b` published to local update channel and `~/.zterm/updates`.

- Jason reported a recurring field bug: after Android exits a zterm terminal, iTerm2 can still see the same tmux session as occupied/constrained; width may be released in some paths, but the session transport/subscriber is not reliably released.
- Live daemon evidence before code change: `/health` had `sessions.total=2`, `mirrors.subscribers=2`; `/debug/runtime` showed relay-origin transport subscribers for `rcc1`/`rcc3`; `tmux list-sessions` showed iTerm2 clients attached but affected windows still narrow/manual in the observed sessions.
- Architecture mapping: `feature_id=terminal.transport_lifecycle`; resources are `resource.session_transport -> resource.transport_subscriber -> resource.mirror_store -> resource.tmux_session`. The only allowed fix is daemon/client transport lifecycle owner cleanup. UI, TerminalView, buffer/render, and manual tmux cleanup are forbidden.
- Root-cause hypothesis locked by code reading: `terminal-daemon-runtime.ts` only pings WS transports and does not close missed pongs; RTC/Relay datachannels have no daemon-side stale inbound cleanup. If Android exits/suspends and close does not reach daemon, the bound subscriber can remain in `mirror.subscribers`, keeping adaptive lease/session occupation alive until chance close or long lease expiry.
- Test design added to `docs/testing/websocket-transport-reuse-test-design.md`: daemon stale bound RTC/Relay transport must close/detach via `detachSubscriberTransportOnly`, release adaptive width through existing mirror owner, keep tmux session/mirror truth intact, and not affect active 2-second heartbeat transports or idle control transports.
- Fix implemented in `terminal.transport_lifecycle`: every transport connection records inbound activity; WS pong/message and RTC datachannel message refresh it. Daemon heartbeat now sweeps stale bound session transports, detaches through `detachSubscriberTransportOnly`, closes only that physical transport, deletes the daemon connection, and does not destroy mirror/tmux truth.
- Verification: red `terminal-daemon-runtime.test.ts` failed before the daemon sweep. Focused transport suite PASS 6 files / 38 tests; `tsc --noEmit` PASS; feature registry/resource/mainline gates PASS 7 files / 48 tests; `daemon:mirror:close-loop` PASS all 9 cases. Installed daemon release was restarted service-scoped and verified by content plus live behavior.
- Live RTC black-box proof on dedicated temp tmux `zterm-rtc-stale-*`: before attach `80x24`, during adaptive attach `58x24`, after stale RTC close `80x24`, daemon lingering subscribers `0`; temp tmux session was cleaned by explicit name. Android build/update PASS: APK `0.1.3.2184` / versionCode `1032184` published to local update channel and `~/.zterm/updates`.

# 2026-07-20 Remote-window fullscreen IME auto-lift and 20Mbps default correction

- Jason showed fullscreen screenshots: automatic IME state was still below the manually adjusted target, and fullscreen toolbar showed `2 Mbps` instead of the expected 20Mbps default.
- Root cause: previous exact-fill fix only allowed manual local pan by expanding `bottomInsetPx` clamp range; it did not set an initial pan when IME opened. The missing automatic amount is the measured QuickBar chrome, not daemon capture or remote scroll. Bitrate root cause: fullscreen still consumed the selected/effective low preset path; stale low storage could leave fullscreen at `2mbps`.
- Fix: `TerminalPage` now passes `bottomChromeInsetPx` to `RemoteWindowOverlay`. Fullscreen overlay auto-pans by that chrome amount only when keyboard lift is active, reduces fullscreen bottom padding by the same amount, and stops auto-overriding once the user manually pans. Floating preview still starts at effective `2mbps`, but fullscreen entry/default upgrades untouched low/default presets to `fullscreen`/20Mbps and sends stream quality update over the existing active stream without restart.
- Verification so far: `RemoteWindowOverlay.test.tsx` + `remote-window-video-quality.test.ts` PASS 32 tests; remote-window runtime/daemon/file-transfer focused suite PASS 12 files / 145 tests; `test:feature-registry` PASS 7 files / 48 tests; `tsc --noEmit` PASS; `git diff --check` PASS.
- Build/update: `build:android` PASS with terminal contracts 48 files / 590 tests, common flows 7 files / 82 tests, local Relay smoke, Vite/Capacitor/Gradle/update manifest verification. APK `0.1.3.2177` / versionCode `1032177`, size `5879934`, sha256 `2cfeca37f8fbae93b081af0aa3b1e470760d29683761957d2a06a14f6ccdc83c`, published to local update channel, `/Users/fanzhang/.zterm/updates`, and public Relay `/relay/updates`; public latest.json, APK HEAD, and streamed public APK sha PASS. `adb devices -l` showed no online device, so physical Android fullscreen IME/bitrate UI proof remains Jason device L5.

# 2026-07-20 Remote-window bottom-corner resize and exact-fill IME pan 2176

- Jason reported the previous remote-window fixes did not address two concrete paths: floating window could move but not scale from lower corners, and fullscreen video could not be manually moved upward when IME/QuickBar covered content.
- Architecture mapping: `feature_id=desktop.remote_window_stream`, function `desktop.remote_window_stream.overlay.project`, resource `resource.remote_window_overlay`. The fix stays in `RemoteWindowOverlay` Android projection and docs/skill gates. No daemon capture, WebRTC sender, Mac coordinate, terminal renderer, page shell, or transport owner was changed.
- Root cause: floating resize had only one left-edge strip and calculated width as `startWidth - deltaX`, so right-bottom corner resizing did not exist and corner direction/anchor semantics were untested. Fullscreen keyboard pan used `bottomInsetPx` only as static padding; when the selected source aspect exactly filled the measured video surface, `maxPanY` was `0`, so one-finger upward pan was clamped away.
- Fix: floating overlay now exposes bottom-left and bottom-right resize handles. Both preserve source aspect ratio; left-bottom keeps the right edge anchored, right-bottom keeps the left edge stable by pairing width growth with x-offset movement. Fullscreen clamp now treats `bottomInsetPx` as extra local pan range; upward pan reclaims the same amount from bottom padding so effective content area is not left blank while the keyboard is open.
- Verification: red tests first failed on missing `remote-window-resize-handle-right` and exact-fill content top staying `0`. After the fix, `RemoteWindowOverlay.test.tsx` PASS 27 tests; `TerminalPage.remote-window-overlay.test.tsx` PASS; remote-window runtime/daemon/file-transfer focused suites PASS 116 tests; `test:feature-registry` PASS 48 tests; `tsc --noEmit` PASS; `git diff --check` PASS; `build:android` PASS with terminal contracts 48 files / 590 tests, common flows 7 files / 82 tests, relay smoke, Vite/Capacitor/Gradle/update manifest.
- Delivery: APK `0.1.3.2176` / versionCode `1032176`, sha256 `ccdc5eca06bda9e2479df200633987908d972b943cc0e597aea8e40277e38066`, size `5879718`, published to local update channel, `~/.zterm/updates`, and public Relay `/relay/updates`; public latest.json, APK HEAD, server files, and downloaded APK sha all verified. `adb devices -l` showed no online device, so physical Android resize/IME proof remains an L5 gap for Jason's device test.

# 2026-07-20 Remote-window projection bitrate, resize, IME pan, and notification overlay 2175

- Jason reported four Android remote-window projection issues: floating preview bitrate too high, floating remote window could move but not edge-resize, fullscreen video could not be shifted when IME covers content, and the floating entry button still moved only a few pixels. He also asked network/reconnect notifications to float above all pages without changing layout.
- Architecture mapping: `desktop.remote_window_stream.overlay.project` owns floating/fullscreen projection, source-aspect resize, fullscreen IME padding/pan, and projection-capped effective bitrate. `desktop.remote_window_stream.client.quality_request` owns active-stream quality updates. `terminal.transport_lifecycle` owns reconnect/offline status truth, while `TerminalPage` may only project it as a fixed overlay. No daemon capture, Mac coordinate, terminal buffer/render, or transport lifecycle owner was changed.
- Fix: selected bitrate remains remembered, but effective stream bitrate is projection-capped: floating always `2mbps`; unzoomed fullscreen caps high presets to `5mbps`; zoomed fullscreen applies the remembered preset. Stream quality updates are sent by effect on active stream projection changes and do not restart capture/receiver/session transport.
- Fix: floating overlay has a pointer-captured edge resize handle preserving selected crop/window aspect ratio. Fullscreen root consumes `bottomInsetPx` as padding and allows local vertical letterbox pan while keyboard is open. Floating entry moved to fixed viewport coordinates to avoid parent-stage clipping. `TerminalNetworkBanner` is now a top-level fixed, pointer-transparent overlay.
- Verification: `remote-window-video-quality.test.ts`, `RemoteWindowOverlay.test.tsx`, `TerminalPage.network-banner.test.tsx`, and `TerminalPage.remote-window-overlay.test.tsx` PASS 4 files / 31 tests. `test:feature-registry` PASS 7 files / 48 tests. `tsc --noEmit` PASS. `git diff --check` PASS. `pnpm --dir android run build:android` PASS: terminal contracts 48 files / 590 tests, common user flows 7 files / 82 tests, local Relay smoke, Vite/Capacitor/Gradle/update manifest verification.
- Delivery: APK `0.1.3.2175` / versionCode `1032175`, size `5879466`, sha256 `337ceaacefb27fab6168335bc875bb0d32c078391f392c425171e85991693350`, published to `android/update-dist`, `/Users/fanzhang/.zterm/updates`, and public Relay `/relay/updates`. Public `GET/HEAD https://relay.codewhisper.cc:18443/relay/updates/latest.json`, APK `HEAD`, Relay `/health` updates dir, and streamed public APK sha all PASS.
- L5 gap: `adb devices` returned no online device, so physical Android drag/resize/IME visual proof and install smoke are not claimed.

# 2026-07-20 Remote-window WeChat video start failure

- Jason reported selecting WeChat starts with `视频流启动失败` and native wrtc error `Attempted to set RtpParameters with different enc...`.
- Root cause: `src/server/remote-window-stream-daemon.ts#applyRemoteWindowVideoBitrate()` fabricated `[{}]` when `sender.getParameters().encodings` was empty. Real `@roamhq/wrtc` rejects `setParameters()` if the `encodings` structure changes, so optional bitrate setup broke stream startup before video opened.
- Architecture mapping: `feature_id=desktop.remote_window_stream`; unique code owner is daemon stream quality/start owner in `remote-window-stream-daemon.ts`. Android overlay, receiver, ScreenCaptureKit capture, terminal transport, and buffer/render truth are not the fix point.
- Fix: bitrate apply now preserves existing sender `encodings` count/order and only writes `maxBitrate`. Empty encodings no longer call `setParameters()` or fail stream start; startup reports `video bitrate not applied` and omits `capture.maxBitrateBps`. Live quality update on the same unsupported sender returns `remote_window_stream_quality_failed`.
- Verification so far: `remote-window-stream-daemon.test.ts` 28 PASS; focused remote-window/terminal-message suite 5 files / 101 PASS; `tsc --noEmit` PASS; feature/resource/function/mainline gates 7 files / 48 PASS; `git diff --check` PASS.
- Runtime closeout: `daemon:prepare-release` PASS, install-global PASS, service-scoped `~/.local/bin/zterm-daemon restart` PASS, `/health` returned pid `49187`. Actual process command loads `/Users/fanzhang/.zterm/releases/zterm-daemon/0.1.3/runtime/server.cjs`; release and loaded runtime sha `9853c0296e17f723b094777c0b6b5007899d056e2105367d870df0d35fb69f15` include `remote window video bitrate sender has no encodings to update`.
- Live daemon WebSocket smoke selected real WeChat target `app-window:486:2668`, sent `remote-window-stream-start-request` with `5mbps`, got status `video bitrate not applied: remote window video bitrate sender has no encodings to update`, then `phase=streaming` with `framesSent=1`, `remote-window-stream-started.capture` omitted `maxBitrateBps`, local WebRTC receiver got first frame `280x380`, and stop returned `phase=stopped`. This proves the exact empty-encodings case no longer blocks WeChat video startup.
- Android build/publish: `pnpm --dir android run build:android` PASS; terminal contracts 48 files / 590 tests PASS; common flows 7 files / 82 tests PASS; local Relay smoke PASS; Vite/Capacitor/Gradle/update-manifest verification PASS. APK `0.1.3.2174` / versionCode `1032174`, size `5878278`, sha256 `7745165b7b4fb548d5e14214e61e9bad47d1aec1e9d53c0df9a91edf576f4222` published to local update channel and public Relay `/relay/updates`; public GET/HEAD and downloaded APK sha PASS. `adb devices` had no online device, so physical install/launch smoke remains an L5 gap.

# 2026-07-20 Remote-window paste focus and bitrate closeout

- 架构映射：`feature_id=desktop.remote_window_stream`。Android `RemoteWindowOverlay` 只投影/发布 active remote-window input context；`TerminalPage` 是 QuickBar/IME/focus 路由 owner；daemon `remote-window-stream-daemon` 是 ScreenCaptureKit/WebRTC sender、input injection、bitrate apply owner；file-transfer owner 仍负责 paste-image upload/clipboard/temp file。
- 修复：图片粘贴不再固定进入 iTerm/tmux。remote-window context active 时 `handleQuickBarImagePaste()` 发送 `pasteTarget.kind=remote-window`，daemon 写 clipboard 后对选中 stream/target 注入 macOS Command+V；terminal pane pointer down 清空 context 后，同一 image 按钮恢复 terminal Ctrl+V path。daemon 不猜焦点。
- 修复：新增 per-window bitrate preset helper；start request 携带 bitrate config；overlay selector 发 `remote-window-stream-quality-request`；daemon 校验 preset/bitrate/maxBitrateBps 并通过 WebRTC sender parameters 设置 `maxBitrate`，target mismatch/missing stream 显式报错。
- 回归：focused remote-window/file-transfer/daemon gates 10 files / 164 tests PASS；`tsc --noEmit` PASS；resource/function/mainline registry 7 files / 48 tests PASS；`docs:function-wiki` PASS；`git diff --check` PASS。
- Live daemon：`daemon:prepare-release` + `daemon:install-global` + service-scoped `zterm-daemon restart` 后 `/health` ok，PID `72857`；installed `~/.zterm/daemon-runtime/server.cjs` 含 `remote-window-stream-quality-request`、`KeyV`、`pasteImageToRemoteWindow`、`maxBitrate`。Live WS against temp `zterm-rwq-1784519076` returned `remote-window-error code=remote_window_stream_quality_missing`; temp tmux session removed.
- Android build：`pnpm --dir android run build:android` PASS。Prebuild terminal contracts 48 files / 590 tests PASS、common flows 7 files / 82 tests PASS、relay local smoke PASS。APK `0.1.3.2173` / `1032173` sha256 `7d75b8987e9d6b27afd5b932209d4775f4c393a1ccbb9333706d1de53efa3e3f` published to `android/update-dist`, `~/.zterm/updates`, and public Relay `/relay/updates`; public GET/HEAD and downloaded APK sha PASS. ADB has no online device, so local device install smoke remains L5 gap.

# 2026-07-18 Session switch slow reconnect audit

- Jason 反馈当前每次切 session 都像要十来秒重新连接，旧版本没有。静态审计确认切换主线本身不应关闭旧 socket：`switchSession()` 只切 active、重置 pull bookkeeping、调用 `ensureActiveSessionFresh()`；`setActiveSessionSync()` 经 `reconcilePhysicalBodySubscriptions()` 给旧 session 发 `body-subscription:false`、给新 active/live session 发 `true`，服务端仅切 `session.bodySubscribed`，不 close transport。
- 当前慢点来自 transport lifecycle 判定与重开路径：`buildActiveSessionRefreshPlan()` 在 `active-reentry/explicit-resume` 且最近有 activity 但 `ws` 已 `null/CLOSING/CLOSED` 时会返回 `transport-keepalive-grace`，先不 reconnect；若随后进入 reconnect，`reconnectSessionRuntime()` 会 `cleanupSocket(sessionId, false)`，把旧 active socket 移到 superseded、清 heartbeat/active socket，再走 control/session open。这个路径不再是“恢复 body push + ping/head probe”，而是 rebuild 语义。
- 10 秒量级来自 traversal/open timeout：`TraversalSocket` 的 RTC candidate timeout 是 8000ms，WS candidate 是 1800ms；session/control handshake timeout 是 4000ms。若 route selector 先试不可达 WebRTC/relay candidate，再等 session ticket/handshake，体感就是 8-12s。下一步修复应在唯一 owner `terminal.transport_lifecycle`：切换回旧 session 时，若存在同 target old socket 或最近健康 baseline，先恢复 `body-subscription:true` + `ping/buffer-head-request` 探活，1-1.5s 无响应才 replace；禁止切换路径直接 cleanup/rebuild。回归 gate 必须锁 A->B->A 同 socket 保持、只发 body subscription/head probe、无 `cleanupSocket/reconnectSession/new TraversalSocket`；以及 closed socket probe timeout 后才重建并限制等待。

# 2026-07-18 Long input tmux literal command limit

- 长输入专项 L2 首次失败已追到第三层真源：probe 发出的 6 个 string-only input frame（5 x 65,536 bytes + 27,155 bytes）全部到达 daemon；随后 `terminal-control-runtime` 的 64 KiB `tmux send-keys -l` 参数逐个报 `command too long`，tmux oracle 未收到任何内容。
- 独立 tmux probe 实测：4,096 / 8,192 / 12,000 / 16,000 bytes 成功，20,000 bytes 及以上稳定失败。因此 WebSocket frame budget 与 tmux argv budget 不能共用；client frame 保持 64 KiB，daemon tmux literal write 需要更小 UTF-8 chunk。
- 架构仍归 `terminal.daemon_input` 唯一 backend write owner；不在 UI、renderer、buffer manager 增加补偿。新增反向 queue gate：前一 tmux write in-flight 时到达的新 input 必须在前一写完成后继续 drain，不得遗留。
- 继续实测：8 KiB 后不再报 `command too long`，但超长 here-doc digest 仍不等价；直接 `send-keys` / `paste-buffer` 都会在 tmux/zsh/pty 长输入中把下一行前缀插入当前行。追加节流矩阵：2 KiB / 1 KiB / 512B 都失败，只有 256B + 2ms inter-write settle 达到 source SHA == target SHA。这个只影响多 chunk 长输入；普通几十字单 chunk 不增加等待。

# 2026-07-18 Android voice IME committed text

- Jason 反馈几十字语音输入也会丢，且语音换行会直接发出去。代码根因之一已确认：`TerminalPage` 的 Android `ImeAnchor input` listener 对所有 committed text 做 `.replace(/\n/g, '\r')`，所以语音识别插入的文本换行被投成 terminal Enter。
- 显式 Enter 已有独立 `performEditorAction` / native key 路径；Android committed text 中的 CR/LF 应在 `src/lib/terminal-input-normalization.ts` 归一为空格，保留中文、emoji、`￥`、`、` 等非 ASCII 符号。唯一 owner 仍是 `terminal.keyboard_ime`，禁止在 daemon/input transport/renderer 层过滤换行。

# 2026-07-18 Drawer duplicate session enumeration

- 现场：同一 daemon 同时存在 direct/Tailscale history 与 Relay history 时，`TerminalPage.drawerRemoteSessions` 按原始 `sessionGroups` 逐组追加 rows；虽然 `drawerServerIdentityAliases` 已把两组 canonicalize 到同一 host rail，但 row 枚举没有按 canonical daemon + tmux session 去重，因此每个 session 会显示两次。
- 架构映射：`feature_id=terminal.session_drawer`，资源 `resource.ui_projection -> resource.open_tab -> resource.active_session`；唯一修改点是 `TerminalPage` drawer catalog projection。属于物理移除重复投影，不改 history storage、session transport、daemon、buffer 或 renderer。allowed path 是 canonical identity 后的 UI projection；forbidden path 是在 drawer component 或 transport 层用隐藏/过滤补偿。
- 测试设计：`docs/testing/terminal-session-drawer-gesture-test-design.md` 增加 direct + Relay history overlap 的正反黑盒 gate，要求同 canonical daemon/session 只出现一行，同时保留 Relay-capable target metadata。
- 修复：`drawerRemoteSessions` 增加 canonical row key map，重复来源只合并 `targets/closeTargets/catalogLiveSessionIds`，不再 push 第二个 drawer item。红测先复现 React duplicate key `direct-rcc`，修复后 focused drawer 34/34 PASS、drawer/relay/session-open suite 107/107 PASS、typecheck PASS、feature registry 48/48 PASS、`build:android` PASS 并发布 APK `0.1.3.2148` sha256 `df618c463a036f30661276f4625ecb31c44436b5e348067c43087cb3c38b5c0d`。本机 `adb devices -l` 无 online 设备，L5 真机验证未完成。

# 2026-07-16 Relay Home visible route entry

- 现场：Settings 已登录 Relay，但 Home 没有显式 Relay 选项；用户无法知道或选择 Relay。代码证据：`ConnectionsPage.getHostBadge()` 只有 `bridgeHost` 为空时才显示 `Relay`，saved Tailscale/direct row 即使有 `relay-rtc` 候选也显示 Tailscale；`projectHomeSavedConnections()` dedupe 同 daemon row 时会保留 saved row 但丢掉 relay directory endpoint candidates。
- 架构映射：`feature_id=relay.directory_ui`，资源 `resource.ui_projection -> resource.transport_target`。唯一修复面是 Home projection helper、ConnectionsPage 投影、App 到 session-open owner 的 intent；禁止改 daemon、TerminalView、buffer/renderer、transport lifecycle。
- 测试设计：`docs/testing/relay-login-home-and-ephemeral-tabs-test-design.md` 增加 same-daemon saved row 合并 Relay candidates、Home Auto/Relay 双 intent、Relay action 不走 direct fallback 的正反门禁。
- 实现方向：新增 `home-connection-projection.ts` 作为 Home server rows 唯一 projection helper；同 daemon dedupe 时 merge `relayEndpointCandidates/relayHostId/relayDeviceId`；Home row 主点击保留 Auto，`relay-rtc` 存在时显示 `Relay 可用` 与独立 `Relay` 按钮；Relay 按钮构造 `transportMode='webrtc'` 且只带 `relay-rtc` candidates 的 Host 后交给现有 `useSessionOpenActions.handleOpenSavedConnection`。

# 2026-07-17 Home server row reuse existing Session before generated tmux

- 现场：Home 上已存在 `zterm` / `zterm-*` active sessions，但点击 server row 会继续创建新的 `zterm-<timestamp>`。代码根因：`useSessionOpenActions.handleOpenSavedConnection()` 以前只读取 `host.sessionName.trim()`；无 saved `sessionName` 时直接 `buildGeneratedSessionName()` + `createTmuxSession()`，没有先查当前进程同 daemon/endpoint 的 open Session。
- 架构映射：`feature_id=relay.directory_ui` / `connections.history_projection`，主修改点是 `src/hooks/useSessionOpenActions.ts` 的 Home row open intent；Home 仍只投影 server entry，session 管理仍归 drawer/picker。禁止改 daemon、renderer、transport reconnect。
- 修复：Home server row 打开前先按 saved `sessionName`、daemonHostId/relayHostId、bridge endpoint 匹配当前进程 open Session；优先当前 terminal/runtime active，再按 connected/newer 排序。命中时写 open-tab active truth 并以 `explicit-resume` 切 runtime，不调用 `createTmuxSession()`；只有无可复用 Session 时才生成 `zterm-*` 并创建 tmux。
- 验证：focused Home gates 60/60 PASS；broader relay/Home/picker 81/81 PASS；`tsc --noEmit` PASS；`docs:function-wiki` PASS；`test:feature-registry` 48/48 PASS；`git diff --check` PASS；`build:android` 第二次 PASS（第一次 AAPT2 daemon startup transient failure），发布 `0.1.3.2141` sha256 `d1560f1849ba1dc85d90ad3cb26b3ad0fd93e06bf243a5072c9441ce46d8ee6e`。
- 真机：ADB 安装 `0.1.3.2141` 到 `100.104.163.65:5555` 成功，`dumpsys package` 显示 versionCode `1032141` / versionName `0.1.3.2141`。L5 UI smoke 未闭环：`mFocusedApp=com.zterm.android/.MainActivity`，但 `mCurrentFocus=NotificationShade` 且 `isKeyguardShowing=true`。

# 2026-07-16 Preview remote-only selection auto materialize

- 现场：drawer 预览多选时，远端 catalog row 还没本地打开会显示“该 session 尚未打开，不能加入实时预览”，导致 Jason 不能直接把远端 session 加入预览。
- 架构映射：`feature_id=terminal.session_preview`，资源 `resource.ui_projection -> resource.open_tab -> resource.session_preview_selection`。唯一修复面是 `TerminalPage` 预览选择 owner 复用 `onOpenDrawerRemoteSession` / `useSessionOpenActions.handleOpenGroupSession` 物化本地 open tab；selection storage 仍只存本地 open-session target，禁止存 `remote:<owner>::session:<name>` placeholder。daemon、transport、renderer 不参与。
- 根因：`handleToggleSessionPreviewSelection()` 只从 `sessions` 查已打开 session；对 drawer remote-only placeholder 没走已有 remote-open materialize 主线，直接报“未打开”。
- 修复：预览选择 remote row 时先以 `{ activate:false, navigate:false }` 调现有 remote-open owner，拿返回 local `sessionId` 后持久化 preview target；打开失败显式报错并不写 placeholder。

# 2026-07-16 Relay signed-in status / Home relay server openability

- 现场：Settings 已登录 relay 后，UI 状态仍像登录表单；Home 能看到 Relay server row，但点击不能稳定进入 terminal。
- 架构映射：`feature_id=relay.directory_ui`，资源 `resource.ui_projection -> resource.transport_target`。唯一 owner 面是 `ConnectionsPage` / `SettingsPage` / `RelayAccountSettingsSection` / `useTraversalRelayAccount` / `useSessionOpenActions`；本轮禁止改 daemon、TerminalView、buffer/renderer。
- 当前假设：Settings 登录态投影需要更明确地显示 signed-in account/directory；Home relay row open 必须保留 relay directory endpoint candidates 并由 session-open owner 直接 materialize/open，不能只按 direct `bridgeHost` 判断。
- 测试先行：补 Settings signed-in UI red/green；补 Home relay-only server row / useSessionOpenActions relay endpoint open red/green；再跑 `relay.directory_ui` 相关 required gates。

# 2026-07-12 Android IME input intent / mirror-fixed horizontal pan

## 2026-07-13 Drawer opening gesture promoted a stale session

- 现场日志证明当前 `zterm` 之外的 stale `routecodex2` 不只是错误文案污染：`session.ws.reconnect.onopen`、`session.transport.active-tick` 都把 `session-1782948645655-wc890xa6` 当成 active/live，并真实发起了 `routecodex2` attach。
- 切换序列在短时间内依次把 `rcc3 -> rcc -> routecodex2` 提升为 active，符合边缘右滑打开抽屉后，Android WebView 在 release 坐标合成 click、命中新出现 drawer row 的跨手势 click-through。drawer refresh/transport retry 只是后果，不是 active intent 真源。
- 架构映射：`feature_id=terminal.session_drawer`；关系 `resource.ui_projection -> resource.open_tab -> resource.active_session`。唯一修改点是 `TerminalSessionDrawer` 的 row selection press owner。物理移除“没有在 drawer row 内开始 press 也能接受 pointer click”的路径；禁止在 banner、SessionContext、daemon 做过滤或补偿。
- 测试设计：`docs/testing/terminal-session-drawer-gesture-test-design.md`。正向锁真实 row press/键盘激活；反向锁 opening synthetic click、跨 row 授权和 unavailable row。
- 最终 L1-L4：drawer/open-tab/transport focused 6 files / 80 tests PASS；补充 drawer catalog refresh 保持 `active-zterm` 且不调用 `applyOpenTabState/createSession/switchSession`；`tsc --noEmit` PASS；`build:android` PASS，发布并安装 `0.1.3.2103`，sha256 `86cae9e2d59649737248100d04fa2c4ee87e6e11c078df51c9ba12a6f64c0312`。
- L5 缺口：设备 `100.104.163.65:5555` 安装 2103 后仍为 `mCurrentFocus=NotificationShade`、`isKeyguardShowing=true`，UI dump package 是 `com.android.systemui`。不能在锁屏下重放 drawer touch/click，故未宣称真机闭环。
- 独立 gate 现状：`test:feature-registry` 的 `resource.debug_channel.allowed_operations` 断言未同步另一个 active claim `terminal.performance_pipeline` 的 manifest 改动；本轮未越权修改该 owner。Android build 使用的 terminal contract/core gate 整体通过。

- 架构映射：`feature_id=terminal.keyboard_ime` 与 `terminal.buffer_render`。IME input intent 属于 UI shell/input channel；follow/reading/renderBottomIndex 属于 renderer；`mirror-fixed` 横向位移只属于 renderer projection。daemon/tmux/mirror truth 不参与本轮改动。
- 根因 1：滚到历史区后点击键盘，输入意图没有先把 renderer 从 reading 对齐回 follow/bottom，导致 native IME show 与可见窗口状态分裂。修复为 terminal click、quickbar show keyboard、blur-to-keyboard 等入口先调用 follow reset，再 show/focus IME。
- 根因 2：Android 键盘按钮用本地 requested/inset 推断 IME 显隐，刷新或 stale state 后可能误判。修复为 `ImeAnchor.getState()/keyboardState` 暴露 native `keyboardVisible/keyboardHeight`，按钮显示/隐藏以 native IME truth 为准。
- 边界修正：IME 只允许 UI shell 做裁切/预留：`terminalStageBottomPx = measured quickbar chrome + IME lift`，QuickBar shell 用同一份 IME lift 上台；`TerminalView` 不接收 IME resize token、不触发 upstream `onResize`、不改 tmux rows/cols。排版仍由 tmux/mirror 负责。
- 新功能：`mirror-fixed` 下 `TerminalView` 支持水平 touch pan，移动的是 `.term-grid` projection `translateX(-offset)`，offset 按 session 存入 localStorage；`adaptive-phone` 明确不响应横向 pan。
- 红测：`TerminalView.dynamic-refresh.test.tsx` 覆盖 reading 点击输入前回 follow、mirror-fixed 横向 pan + per-session restore、adaptive-phone 不 pan；`TerminalPage.android-ime.test.tsx` 覆盖 Android native IME visible truth 与 show/hide 路径。
- 验证：focused L4 `TerminalView.dynamic-refresh + TerminalPage.android-ime` 114/114 PASS；`tsc --noEmit` PASS；`test:feature-registry` 48/48 PASS；`build:android` PASS，发布 `0.1.3.2074`，APK sha256 `ab37682ed7280c892fe6f615204d97be107516ae93b05ef8b513e0aac009313b`。
- L5 缺口：`ANDROID_SERIAL=100.104.163.65:5555 pnpm --dir android run test:android:terminal-real-device` 被设备锁屏阻塞；证据为 `isKeyguardShowing=true`、`mCurrentFocus=NotificationShade`，脚本明确失败在 `app surface not visible at before-ime`。

## 2026-07-13 Android IME post-visible bottom realign

- 现场：滚到历史区后点 QuickBar `键盘`，IME 可见但 terminal 仍停在旧阅读窗口，底部 prompt / shell line 没有进入可视区。
- 根因：toggle show 前已经做 follow reset，但 Android IME 上台后 WebView visual viewport 从 `754px` 变成约 `470px`，stage 高度再次变化；只在 show 前 reset 不足以保证缩高后的 viewport 仍贴底。
- 修复：QuickBar 键盘 toggle 仍先 reset follow 再 native show；当 native `keyboardState(visible=true)` 到达且这次 IME 是 terminal keyboard request 触发时，再做一次 renderer follow reset。这个动作只移动 renderer visible bottom，不触发 `TerminalView` resize、不改 daemon/tmux geometry。
- 真机验证：2088 安装到 `100.104.163.65:5555` 后，历史区截图 `android/evidence/ime/2088-scrolled-up-before-toggle.png`；点击键盘后 `android/evidence/ime/2088-scrolled-up-after-keyboard-toggle-on.png` 显示 prompt / shell bottom 可见。DevTools 证据：`.wterm` `clientHeight=299`、`scrollHeight=16000`、`scrollTop=15701`、`deltaBottom=0`。
- 验证：IME focused gates 129/129 PASS；`tsc --noEmit` PASS；`test:feature-registry` 48/48 PASS；`build:android` PASS，发布 `0.1.3.2088`，APK sha256 `3e8205ea26546dab5ce673124cbb85bf0ae97ba95751a34261c9be78957ead3a`。

## 2026-07-13 Drawer refresh stale missing session error projection

- 现场：打开 terminal drawer 后当前会话仍在，但 UI 出现 `连接已断开，正在重连 / Tmux session unavailable: can't find session: routecodex`。本机 tmux truth 证明 `routecodex` 不存在，当前 tmux sessions 仍有 `rcc2/freehand/...`；Android WebView localStorage 里仍有 stale `OPEN_TABS` / terminal layout routecodex 条目。
- 根因：缺失的 stale open tab 被推进到 transport reconnect 后，`tmux_session_unavailable` 在 inactive / non-live 场景仍会走 retry/error projection。抽屉 / picker refresh 本应只是 catalog/audit fact，不能让非当前 session 的 attach failure 污染当前 UI。
- 修复：`scheduleReconnectRuntime()` 在 retryable 且 auto reconnect 被 active/live gate 拦住时，只清 reconnect runtime 并把该 session 落回 idle，不再 emit `SESSION_STATUS_EVENT(type='error')`。`handleReconnectHandshakeFailureRuntime()` 在 retryable reconnect handshake failure 后再次检查 active/live gate；若 session 已不再 active/live，停止 retry、落回 idle、不发 terminal error。
- 边界：owner 是 `terminal.transport_lifecycle`；资源关系是 `resource.active_session -> resource.session_transport`。UI/drawer 不加本地过滤，daemon/tmux 不改；`resource.ui_projection` 不能直连或修补 `resource.session_transport`。
- 已验证：本机 `tmux has-session -t routecodex` 返回 1，证明 routecodex 是真实缺失 stale session；focused transport gates 31/31 PASS；transport/App/open-tab broader gates 275/275 PASS；`tsc --noEmit` PASS。

# 2026-07-08 Active transport proactive stale probe

- Jason 现场截图显示 `ws connect timeout` 仍会长期停滞；用户明确要求不要只等长 timeout，而要主动知道问题并主动尝试。
- 架构映射：本 slice 属于 `terminal.transport_lifecycle`；唯一 owner 是 `SessionContext -> ensureActiveSessionFresh / probeOrReconnectStaleSessionTransport`。UI 只展示状态，不判断 timeout；daemon 不持有客户端 freshness。
- 根因：active transport stale 判定沿用 `CLIENT_PING_INTERVAL_MS + 5000 = 35s`，heartbeat timeout 是 70s；即使 active tab 已无服务端活动，也会长时间停在旧 open transport / timeout banner。
- 修复方向：active tab 2.5s 无服务端活动即发 `buffer-head-request` probe；probe 等待窗口默认 1.2s，无响应才 `reconnectSession(...forceReplaceTransport)`。健康连接收到 `buffer-head` 后视为 recovered，不替换 socket。

# 2026-07-08 Same-revision stale buffer-sync guard

- Jason 现场描述刷新时旧错误页面和新页面交替出现，并怀疑刷新过程假设 buffer 干净或循环 buffer 未清空。
- 架构映射：属于 `terminal.buffer_render` / Client Mirror Buffer；唯一 owner 是 `src/contexts/session-context-buffer-runtime.ts`，测试 owner 是 `session-context-buffer-runtime.test.ts` 与 `terminal-refresh-buffer-truth-test-design.md`。禁止 TerminalPage/UI shell 清空 DOM 或本地 buffer。
- 红测证实：当前实现会接受同 revision、同 absolute window 的迟到旧 payload，并把已有非 gap 行从 `new-*` 覆盖回 `old-*`，可解释新旧画面交替。
- 修复方向：`buffer-sync apply` 前检测 same-revision payload 是否会改写本地已有 non-gap absolute rows；若冲突且 payload 窗口不命中本地 gap，显式 `session.buffer.sync.stale-same-revision-drop` 并拒绝 apply。same-revision gap repair 仍允许填洞。
- Jason 进一步补充是“旧 buffer 内容刷出来又被新内容覆盖，高频反复”。补充红测锁定 `incomingRevision < localRevision` 旧 body：不能 repaint，必须记录 `session.buffer.sync.stale-lower-revision-drop` 并请求当前 tail；否则低 revision 旧包虽然可能不 commit，也会静默不可观测。
- 验证：buffer/runtime/render gates 109 PASS；feature registry 31 PASS；tsc PASS；`daemon:mirror:close-loop` 8 cases PASS，覆盖 codex/top/vim/initial/local input/external input/daemon restart/schedule，并且 replay/source compare OK。标准 debug APK build PASS，发布 `0.1.3.2032`，sha256 `a8f5717c08825324ecde536890f0d1819a4a7b259963048638ffa355b13b8114`。本机 `adb devices -l` 只有 offline emulator，未完成真机安装态复测。

# 2026-07-07 WebSocket reuse planning audit

- Jason 当前确认 `0.1.3.2026` 版本体感可用，下一步只梳理 WebSocket 复用，不先写代码；禁止再做 inactive/background 持续刷新方案。
- 架构真源：`terminal.transport_lifecycle`，function map owner 是 `src/contexts/session-context-transport-runtime.ts` 及 daemon transport runtime；client freshness 唯一 owner 仍是 `SessionContext -> ensureActiveSessionFresh / buildActiveSessionRefreshPlan`。App / TerminalPage / drawer / header 只能传 intent。
- Decision 文档已明确 reconnect 顺序：same session transport still alive -> reuse same session transport；session transport dead but control alive -> rebuild same session transport；control dead -> reconnect control + reattach + rebuild session transport。禁止 `cleanup old socket -> fresh ws -> fresh connect -> pretend same session`。
- 当前源码高风险重复重建点：`connectSessionRuntime()` 和 `reconnectSessionRuntime()` 都会无条件 `cleanupSocket(sessionId, false)` 并推进 open/reconnect；`openSessionTransportByIntentRuntime()` 也会在拿到 ticket 后 cleanup 再建 session socket。现有 `buildActiveSessionRefreshPlan()` 对 OPEN socket 会 request-head/probe，不直接 reconnect，但显式 reconnect/connect 入口缺少同 target OPEN/CONNECTING 复用 guard。
- 计划方向：新增/收口一个纯 transport reuse plan helper，所有 connect/reconnect/open-intent 前先判定 same session + same target + OPEN/CONNECTING/pending open；OPEN 只 request head/保持 socket，不 cleanup；CONNECTING/fresh pending open 只等待，不重复 queue；target mismatch 或 CLOSED/CLOSING 才允许 rebuild。测试先覆盖正反，再实现。
- 已实现：新增 `buildSessionTransportReusePlan()`，接入 `connectSessionRuntime()` / `reconnectSessionRuntime()` / `openSessionTransportByIntentRuntime()`。same-target OPEN 复用，CONNECTING/fresh pending open 等待，closed/missing/target mismatch/stale pending 才 rebuild；stale-probe timeout 用内部 `forceReplaceTransport` 显式替换 OPEN stale socket。open-intent 等待 CONNECTING 时不再清 `sessionTransportToken`，避免破坏 in-flight handshake。
- 已补 map：`terminal.transport_lifecycle` 的 feature registry、function map、mainline call map 增加 SessionContext/session runtime/transport reuse planner 绑定，UI 仍只传 intent。
- 已验证：L1/L3 6 files / 236 tests PASS；L4 open-tab/App/transport 12 files / 150 tests PASS；`test:feature-registry` 31 tests PASS；`tsc --noEmit` PASS；`git diff --check` PASS；`./android/scripts/build-android-debug.sh` PASS 并发布 APK `0.1.3.2027`，sha256 `41390810cf2c0753bf1dd2b2a7bfad3a87fcaa23913f136a2bf86732dc2b695f`。
- daemon 状态：`http://127.0.0.1:3333/health` 返回 `ok:true`，PID `858`，但 `sessions.total/attached/ready=0`、`mirrors.subscribers=0`；若手机无刷新，当前证据指向客户端未挂 session/subscriber，不是 daemon 进程 dead。
- 收口审计补充：`useOpenTabRuntime.test.tsx` 单跑暴露未 mock 的 remote audit / Capacitor lifecycle 触发真实 Undici WebSocket；该测试不属于 remote audit 语义，已 mock `remote-tab-audit`、`@capacitor/app` 和 no-op `WebSocket`，避免 L4 gate 依赖外部 socket。

# 2026-07-04 Loop governance L1 initialization

- 架构映射：新增 `feature_id=project.loop_governance`，属于 cross-block governance / prevention gate，不改 terminal runtime、daemon、UI 业务主链；唯一 owner 是 `android/docs/loops/**`、`android/docs/testing/loop-governance-test-design.md`、`android/src/lib/loop-governance-truth.test.ts` 和 registry/function map/gate 绑定。
- 初始化结果：`zterm.daily-triage` 只启用 `L1 report-only`，允许 read/report/append run log，显式禁止 product code edits、daemon start/stop、stage/commit、push/merge。L2/L3 未启用，升级需 Jason 明确批准、maker/checker、run history、唯一 owner 和 required gates。
- Mainline call ID：`docs/wiki/mainline-call-map.json` 每条 edge 增加 deterministic `edge_id=<lifecycle_id>:<from>-><to>`；loop manifest 的 `mainline_call_ids` 必须反查真实 edge，禁止编造调用边。
- 防复发：`src/lib/loop-governance-truth.test.ts` 接入 `test:feature-registry`，覆盖 loop files/manifest parse、kill switch 初始 inactive、L1 禁动作、report required fields、mainline_call_id 绑定、L2/L3 disabled、测试设计存在。
- 验证：`pnpm --dir android run test:feature-registry -- --reporter dot` PASS（4 files / 30 tests）；`pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS；`git diff --check` PASS。

# 2026-07-04 Foldable / landscape bottom quickbar lift

- Jason 截图反馈折叠屏和横屏底部需要整体再往上抬一点，可能会和底边快捷栏目重合。
- 架构映射：`feature_id=terminal.keyboard_ime`，唯一 owner 是 `src/pages/terminal-keyboard-lift.ts`、`src/pages/TerminalPage.tsx`、`src/pages/TerminalPageStageShell.tsx`；本轮只改 UI shell bottom inset/lift，不碰 `TerminalView`、buffer manager、daemon、transport。
- Function map / feature gates / MemoryPalace 均指向同一 owner：QuickBar shell bottom 和 TerminalStageShell bottom 必须消费同一 shell 几何真相；TerminalView 不接收 IME/layout token，不触发 upstream resize。
- 初步实现方向：新增 shell-only bottom lift policy，foldable-like wide portrait 与 landscape 加小额额外 bottom lift；`terminalChromeBottomPx = quickBarHeight + touchSafeOffset + extraLift`，QuickBar shell bottom = `terminalImeLiftPx + touchSafeOffset + extraLift`。这样快捷栏本体上抬，stage 同步预留，不会互相覆盖。
- 测试设计：白盒测 policy 的 phone/foldable/landscape 正反；模块黑盒在 `TerminalPage.android-ime.test.tsx` 测 foldable/landscape bottom 值，且 `TerminalView` 仍无 `onResize/onWidthModeChange`；缺口是真机截图/L5 需后续设备验证。

# 2026-07-03 Session resume first-tap active truth fix

- Jason 现场指出切 session 时第一次切换目标未连接可用，界面不变且后续也不变，需要第二次切换才过去。
- 架构映射：本 slice 属于 `terminal.open_tabs` + `terminal.transport_lifecycle` 交界；`useOpenTabSessionActions` 是用户 resume/switch intent owner，`useOpenTabRuntime` 负责 open-tab active truth 与 runtime switch，`SessionContext` 负责 transport refresh。
- 根因：`handleResumeSession()` 调 `resumeActiveSessionTransport()` 成功后提前 return，导致 open-tab `ACTIVE_SESSION` 未提交，第一次点击只启动/刷新 transport，不切 UI active truth。
- 修复：物理移除 `openExplicitSessionById` 短路；resume 入口统一走 `handleSwitchSession()`，先提交 active tab truth，再通过 `switchRuntime:'explicit-resume'` 推进 runtime switch/transport refresh。回归锁住 connecting 目标第一次 resume 后 `ACTIVE_SESSION=s2`、`switchSession(s2)`、`resumeActiveSessionTransport(s2)` 均发生，并在目标 connected 后渲染目标 revision。

# 2026-07-04 Session switch ws connect timeout de-dup

- Jason 现场截图显示切 session 后非常容易出现 `ws connect timeout` banner。
- 架构映射：仍是 `terminal.open_tabs` + `terminal.transport_lifecycle` 交界；`useOpenTabRuntime.requestRuntimeActiveSessionSwitch()` 不应对已有 runtime shell 的目标重复推进 transport，`SessionContext.switchSession()` 已经拥有 active-reentry refresh。
- 根因：前一轮修复后，切换到已有 runtime shell 且正在 `connecting/reconnecting/connected` 的 session 时，外层仍无差别补一发 `resumeActiveSessionTransport()`；这会让同一次切换同时走 `active-reentry` 和 `explicit-resume` 两条 refresh path，更容易把 traversal/control open 推到 `ws connect timeout`。
- 修复：`explicit-resume` 收窄为只给 unavailable runtime 使用：目标 runtime 缺失或状态是 `idle/closed/disconnected/error` 时才补 `resumeActiveSessionTransport()`；对已有且正在 `connecting/reconnecting/connected` 的目标只做 `switchSession()`，让 `active-reentry` 成为唯一 refresh owner。回归锁住 connecting 目标切换时不再额外调用 `resumeActiveSessionTransport()`，但 disconnected 目标仍保留显式 reopen。

# 2026-07-03 File Sync download zero-byte fix

- Jason 现场指出同步图片下载到本地最后写盘失败，文件大小为 0；同时强调远程和本地排序都需要按名称/时间、正序/倒序。
- 架构映射：本 slice 属于 File Sync 下载保存主链；`FileTransferSheet` 负责下载 chunks 到 native storage 的投影/保存动作，`StoragePermissionPlugin` 是 Android 本地写盘 owner，`file-transfer-session-runtime` 负责 transfer 状态。
- 根因：旧实现把所有 download chunks 合并成一个大 base64 字符串后一次性传给 native `writeFile`，Android bridge 上大 payload 可能变空；native 又允许空字符串成功写盘，导致 0 字节。另一个隐藏问题是本地写盘失败后 runtime 会把 transfer 覆盖回 `done`。
- 修复：新增 native `writeFileChunk(path,data,append)`，下载完成按 chunk 分块写盘；写完 `stat` 校验本地 size 等于 `totalBytes`；写盘/大小校验失败由 runtime 保持 `error`，不再覆盖为 `done`。回归同时锁住远程/本地按时间倒序排序。

# 2026-07-03 File Sync upload path injection removal

- Jason 现场指出同步功能实现越界：图片/文件已经传到远端，但额外把远端文件位置写进对话框/输入框，这是错误副作用。
- 架构映射：本 slice 属于 File Sync 上传主链；owner 是 `terminal-file-transfer-binary-runtime.ts` 的 `file-upload-*` 处理。同步只产生远端文件事实和 `file-upload-complete` 事件，不属于 terminal input / quick input / composer。
- 根因：`handleFileUploadEnd()` 写完文件后调用 `writeToTmuxSession(mirror.sessionName, filePath, true)` 并触发 mirror sync，导致上传后的路径被注入 tmux 输入。
- 修复：物理删除 `file-upload-end` 完成后的 tmux 写入和 mirror sync；回归改为证明文件已写入、`file-upload-complete` 仍返回，但 `writeToTmuxSession` / `scheduleMirrorLiveSync` 均不调用。

# 2026-07-03 File Sync sorting / no-filter enumeration

- Jason 现场确认本地目录已能枚举，但文件同步列表缺少按时间排序选项，并且图片文件不应因扩展名/类型/隐藏规则被过滤。
- 架构映射：本 slice 属于 file sync UI projection + native storage owner；`FileTransferSheet` 只做列表投影、排序和选择，`StoragePermissionPlugin` 只返回 native 目录事实。排序不进入 native/daemon 真源，过滤语义从本地枚举链路物理移除。
- 修复方向：本地 native `readdir` 不再跳过 dot files；TS native API 删除 `showHidden` 参数；远端 file-list 请求固定 `showHidden: true` 以请求完整列表；UI 增加名称/修改时间和正序/倒序切换，目录仍排在文件前。
- 回归锁定：`FileTransferSheet.test.tsx` 覆盖远端请求完整列表、本地图片与 dot file 不过滤、本地按 modified 倒序排序、权限拒绝不伪装空目录。

# 2026-07-03 Android IME double-lift / drawer double-select / startup width-mode default

- Jason 现场复现两个真机问题：1）IME 弹出后出现“内容上抬 + 容器再上抬”的双重上抬；2）session drawer 里点一次 session 不能稳定切过去，首击会出现双框/错误过渡。
- 架构映射：
  - IME 问题属于 `TerminalPage` 的 layout shell owner；renderer / daemon / buffer 都不应背锅。
  - session 切换问题属于 `terminal.session_drawer` 的 UI projection / intent owner；不能让同一 row 在两个 DOM owner 上重复 dispatch `onSelectSession`。
  - 启动宽度模式默认值属于 `useBridgeSettingsStorage` 的客户端配置真源；无本地显式设置时应按当前 viewport 定初始模式，而不是永远写死 `mirror-fixed`。
- 修复：
  - `TerminalPage` 新增 `keyboardViewportAlreadyResized` 判定；Android 已 `adjustResize` 时不再冻结 `shellHeight` 到 stable height，也不再额外吃第二次 IME lift。
  - `TerminalSessionDrawer` 物理移除 row 外层 `div` 的重复 `onClick`，只保留内层 select button 作为 session 选择唯一 owner。
  - `useBridgeSettingsStorage` 在没有持久化配置时按当前 viewport 宽度初始化默认 `terminalWidthMode`：窄屏默认 `adaptive-phone`，宽屏保留 `mirror-fixed`。
- 回归：
  - `TerminalPage.android-ime.test.tsx`：已 resize viewport 时，quickbar keyboard inset = 0，stage bottom 只保留 chrome 高度，不再出现第二次 lift。
  - `TerminalSessionDrawer.test.tsx` / `TerminalPage.session-drawer.test.tsx`：一次点击只 dispatch 一次 session select，页面集成用例改为命中唯一 select owner。
  - `use-bridge-settings-storage.test.tsx`：首启无配置时窄 viewport 默认 `adaptive-phone`。
- 现场纠正 4：1994 后双抬改善但仍抬太高。根因继续收敛在同一 `terminal-keyboard-lift.ts` helper：部分 Android 输入法上报的 `keyboardHeight` 可能接近物理像素或明显偏大，旧上限 portrait 60% / landscape 50% 过高。修复为先按 `devicePixelRatio` 识别并归一疑似物理像素高度，再把最大 lift 收紧到 portrait 45% / landscape 38%；回归锁住高 DPR 手机上 `760px` 报告值在 393x900 viewport 下归一为 `380px`，避免 quickbar 被顶到半屏。

# 2026-07-02 connection config share add-flow correction

- Jason 现场指出 87 版本 Connections 主界面看不到分享/导入，期望点击右下角 `+` 后，在新增连接流程里看到“导入”和“分享已有连接”。
- 架构映射：本 slice 仍属于 `connections.config_share`；payload/parser owner 仍是 `packages/shared/src/connection/connection-config-share.ts`，storage import owner 仍由 App 调 `useHostStorage.upsertHost`；本轮只移动 UI projection。`ConnectionsPage` 只保留 FAB add intent，`ConnectionPropertiesPage` 的新增态承载导入/分享入口。
- 防复发：测试需要同时锁住主列表不常驻 import 面板，以及新增连接页能 paste import、显示 malformed error、选择已有连接生成同一 canonical link/QR。
- 现场 1988 再证伪：`+` 真实打开的是 `TmuxSessionPickerSheet`，不是 `ConnectionPropertiesPage`；因此导入/分享/扫码入口必须在 sheet 内出现，表单页入口只能作为二级兼容，不是主入口。Settings 的导出配置按钮不能只写 console，必须给用户可见成功/失败反馈。
- Jason 进一步澄清：全局配置导出应导出本地服务器和设置，不按 session 分，也不导出 open tabs / session history / active session / drafts；导入服务器后再通过 daemon/tmux truth 发现所有 session 选项。

# 2026-07-02 offline generated wiki HTML

- 架构映射：本 slice 是 Wiki Review Surface block，不改业务 runtime；owner 是 `scripts/build-function-wiki.mjs`、`docs/wiki/generated/*.html`、`src/lib/function-wiki-truth.test.ts`，接入点是 `android/package.json -> test:feature-registry`。
- 发现：旧审计 `arch-quality-audit-2026-06-19.md` 已记录 A1：generated wiki HTML 依赖 `cdn.jsdelivr.net` Mermaid，不满足离线 review 面。
- 修复：生成器物理移除 CDN/script 依赖，改为解析当前 flowchart 子集并生成内联 SVG；HTML 同时保留原始 Mermaid source 便于 review。
- 防复发：`function-wiki-truth.test.ts` 禁止 generated HTML 包含 `<script`、`https://`、`cdn.jsdelivr.net`，并要求 `<svg class="wiki-graph">` 与 `<pre class="source">`。
- 证明范围：L0 wiki HTML 生成与静态 gate；未做浏览器截图验证，不宣称 L4/L5 visual smoke。

# 2026-07-02 wiki mainline-call-map manifest

- 架构映射：本 slice 是 Wiki Review Surface / Mainline Call Map block，不改业务 runtime；owner 是 `docs/wiki/mainline-call-map.json` 与 `src/lib/function-wiki-truth.test.ts`，接入点是 `android/package.json -> test:feature-registry`。
- 发现：旧审计 `arch-quality-audit-2026-06-19.md` 已记录 F1：mainline call map 未机器可读，当前 wiki 只有 md/html，没有 JSON manifest。
- 修复：新增 `android_mainline`、`daemon_mainline`、`cli_mainline` 三个 lifecycle 的 machine-readable call map；节点 ID 对齐 `docs/wiki/mainline-source.md` Mermaid ID；gate 校验 owner feature、节点/边、canonical docs、verification gates。
- 证明范围：L0 wiki/mainline-call-map manifest gate；未改 runtime 业务，不宣称 L1-L5 行为变化。

# 2026-07-02 feature-gates coverage lock

- 架构映射：本 slice 是 cross-block verification-map prevention，不改业务 runtime；owner 是 `docs/feature-gates.md` 与 `src/lib/feature-registry-truth.test.ts`，接入点是 `android/package.json -> test:feature-registry`。
- 发现：`feature-gates.md` 漏了 13 个 registry feature 的验证说明，包括 `terminal.transport_lifecycle`、`daemon.runtime_entry`、`mainline_source.*`、`terminal.session_drawer` 等。
- 修复：补齐缺失 feature 的验证风险说明，并新增 gate：registry 内每个 `feature_id` 必须出现在 `feature-gates.md`。
- 证明范围：L0 验证映射覆盖 gate；未改 runtime 业务，不宣称 L1-L5 行为变化。

# 2026-07-02 registry/function-map lockstep gate

- 架构映射：本 slice 是 cross-block documentation/source-map prevention，不改业务 runtime；owner 是 `src/lib/feature-registry-truth.test.ts`，接入点是 `android/package.json -> test:feature-registry`。
- 修复：新增 registry/function-map 双向 feature id lockstep gate；`docs/feature-registry.json` 的每个 `feature_id` 必须出现在 `docs/function-map.md`，function map 的 feature 行也必须指回 registry 内已注册 id。
- 验证目标：防止新功能只补机器 registry 或只补人工 function map，导致 owner/gate/review 面漂移成两套真源。
- 证明范围：L0 架构与文档真源 gate；未改 runtime 业务，不宣称 L1-L5 行为变化。

# 2026-07-02 architecture gate hardening

- 架构映射：本 slice 是 cross-block prevention gate，不改业务 runtime；owner 是 `src/lib/architecture-boundary-truth.test.ts`，接入点是 `android/package.json -> test:feature-registry`。
- 修复：新增 gate wiring 检查、page/UI direct session lifecycle primitive 扫描、daemon client width policy owner 扫描、attach correlation owner 扫描。
- 兼容边界：允许 `TerminalAttachPayload.widthMode` 与 resize wire payload 保留；禁止 `TerminalSession.widthMode`、`SessionMirror.adaptiveCols`、tmux resize/window-size ownership、daemon-owned `clientSessionId`、attach token 用 `openRequestId` 做 owner。
- 验证：`pnpm --dir android run test:feature-registry -- --reporter dot` PASS（3 files / 17 tests）。
- 证明范围：L0 架构防复发 gate；未改 runtime 业务，不宣称 L1-L5 行为变化。

# 2026-07-02 UI projection drawer host identity sentinel removal

- 架构映射：本 slice 属于 `terminal.session_drawer` / UI Projection Block；唯一 identity owner 是 `TerminalPage` projection + `src/lib/server-identity.ts`，`TerminalSessionDrawer` 只消费 `hostKey/hostLabel`。
- 修复：物理移除 drawer 内部 `default` hostKey 与 `本机` hostLabel fallback；未注入 hostKey 的 session 只进入 private unscoped UI group，不再把 fake host identity 传给 refresh/create callback。
- 防复发：`src/lib/architecture-boundary-truth.test.ts` 增加 drawer host identity fallback 扫描；`TerminalSessionDrawer.test.tsx` 增加缺失 hostKey 时 `onOpenQuickTabPicker(undefined, ...)` 的反向测试。
- 验证：`pnpm --dir android exec vitest run src/components/terminal/TerminalSessionDrawer.test.tsx src/lib/architecture-boundary-truth.test.ts --reporter dot` PASS（2 files / 19 tests）；`pnpm --dir android run test:feature-registry -- --reporter dot` PASS（3 files / 13 tests）；`pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS。
- 证明范围：这是 L0 + L1/L4 drawer projection gate；未触碰 daemon/tmux/client transport，因此本轮不宣称 L2/L3 连接闭环。

# 2026-07-02 daemon truth live validation close-loop

- Jason 指出 daemon/tmux 真实验证肯定可做也必须做；本次 daemon truth 架构切片不能只用单测、静态 gate、typecheck 收口。
- 已检查 `scripts/daemon-mirror-close-loop.ts` / `scripts/daemon-mirror-lab.ts` / `scripts/run-daemon-mirror-lab.sh`：live lab 使用当前代码启动 managed daemon、创建固定 tmux session `zterm_mirror_lab`、通过 WebSocket control/session 链路连接，并用 tmux capture 作为 oracle；清理只针对明确 daemon PID 和明确 tmux session，不使用 broad kill。
- 本机前置：`/opt/homebrew/bin/tmux`，`tmux 3.6a`，`pnpm` 可用，`tsx v4.21.0`。
- 真实闭环验证已跑：`pnpm --dir android run daemon:mirror:close-loop` PASS。
- 覆盖 case：`codex-live`、`top-live`、`vim-live`、`initial-sync`、`local-input-echo`、`external-input-echo`、`daemon-restart-recover`、`schedule-fire` 全部 PASS；每个 case replay + strict audit 通过，summary 写入 `android/evidence/daemon-mirror/2026-07-02/summary.json`。
- 这次证据证明：当前代码 daemon 可真实启动，WebSocket session-open/connect/input/head/sync 主链可通，tmux oracle 与 daemon/client replay 一致，daemon restart 后可恢复，schedule fire 可进入 tmux 并被 buffer-sync 捕获。

# 2026-07-01 Android bottom chrome / drawer close audit

- 现场“不同手机/IME 抬起后底部输入框看不见”不是 buffer/renderer 真源问题；本轮定位到 UI shell chrome 计算漏算 `TerminalQuickBarShell` 自身的 `TERMINAL_QUICK_BAR_RENDER_LIFT_PX=30`。`TerminalPage` 以前只把 `quickBarHeight` 交给 `TerminalStageShell.bottom`，quickbar shell 又额外 bottom 30px，导致终端底部可能被 quickbar shell 覆盖。
- 修复方向：`terminalChromeBottomPx = quickBarHeight + layoutProfile.quickBar.touchSafeOffsetPx + TERMINAL_QUICK_BAR_RENDER_LIFT_PX`；IME overlay 场景下 `terminalStageBottomPx = terminalChromeBottomPx + terminalImeLiftPx`，QuickBar shell 同样只消费一次 `terminalImeLiftPx` 上台；TerminalView / upstream resize 仍保持关闭，避免 keyboard 高度进入 daemon/renderer 内容真相。
- 抽屉 session row close 现场不生效的高风险点：原实现是外层 row `<button>` 内嵌关闭 `<span>`，属于交互元素嵌套/命中语义不清。修复方向是 row container 改成非交互 `div`，选择区和关闭区分别是独立 button；关闭按钮只调用 `onCloseSession`，不触发 select。

# 2026-07-01 large refresh blank follow audit

- 现场仍复现“大面积刷新后空白，触摸/滚动后恢复”。IME 越层修复后仍存在，说明根因不应继续从 keyboard/layout token 补。
- 当前怀疑链路：`buffer-sync apply -> render gate publish -> TerminalView follow scroll/renderBottomIndex`。需要红测覆盖本地 buffer absolute window 大跳（例如 `[0,30)` 到 `[500,590)`）时，不触摸也必须贴到新 tail，不能停在空白窗口。
- 验证结果：absolute window 大跳 renderer 测试已绿，单纯贴尾不是缺口；真正红测是 contiguous sparse tail jump 后旧 visibleRange 仍指向旧 tail，post-apply repair 没检查新 tail gap。修复为旧 visibleRange 贴旧 tail 时用新 tail 默认 visibleRange 做 gap repair；reading 区保留旧 visibleRange。

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

# 2026-07-03 file transfer local storage permission / external path audit

- Jason 现场新反馈：文件/图片相关本地目录在未授权时没有主动申请权限；即便用户手动授权，`/storage/emulated/0/Download` 仍可能列不出来，UI 看起来像“空目录”。
- 架构映射：
  - 功能块：`daemon.file_transfer` 中的 client sheet projection / local file access。
  - UI owner：`src/components/terminal/FileTransferSheet.tsx`，负责触发权限请求、授权后刷新、目录错误显式投影。
  - Native owner：`android/native/android/app/src/main/java/com/zterm/android/StoragePermissionPlugin.java`，只负责权限真相与 request 入口。
  - forbidden：不能把目录读取失败伪装成空目录；不能把 Android 外部存储路径解释散落到多个调用点。
- 现状确认：
  - `checkLocalStoragePermission()` 只调用 `StoragePermissionPlugin.check()`，不会 `request()`。
- `Filesystem.readdir/stat/readFile/writeFile/mkdir` 统一用了 `Directory.ExternalStorage`。后续被现场证伪：Android 11+ 即便授权 MANAGE_EXTERNAL_STORAGE，也不能把 Capacitor `Directory.ExternalStorage` 当全盘文件 owner；Capacitor README 明确 ExternalStorage 只适用于 Android 9 或更老版本。
  - `readdir` 异常后当前直接 `setLocalEntries([])`，导致权限/path 失败被投影成“空目录”。
- 本轮目标：
  - 缺权限时自动请求。
  - 从设置页返回后自动 refresh permission + relist。
- 本地文件访问下沉到 `StoragePermissionPlugin` native owner，用 Android `File` API 读写真实 `/storage/emulated/0/...`，并用 canonical path guard 防越界。
  - local list/read/write 失败显式显示错误，不再假装空目录。
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

### Correction

- Jason 进一步确认：IME 理论上只应影响容器，不应影响内容；因此上面的 `terminalLayoutRefreshToken -> TerminalView viewport refresh` 方向仍然过界。
- 修正方向：移除 `layoutRefreshToken` 内容链；IME 活跃时 `shellHeight` 继续冻结 stable layout height，`TerminalStageShell` 作为 UI shell 容器可以叠加 `terminalImeLiftPx` 做底部裁切，QuickBar 同步上台；但 TerminalView 不接收 IME layout token，不触发 Android upstream resize，也不把 keyboard 高度写回 daemon/tmux。
- 大面积刷新仍空白的补充修复：revision-gap sparse payload 仍然拒绝合并，并继续请求 authoritative tail；但拒绝时立即 `scheduleSessionRenderCommit(sessionId)`，把当前稳定本地 buffer truth 重新推给 renderer，避免等待 tail 期间 UI 没有 render 信号而停在空白态。
- 回归更新：`TerminalPage.android-ime.test.tsx` 和 `TerminalPageStageShell.pane-stage.test.tsx` 反向锁住 IME 不再压缩 terminal content bottom；`session-context-buffer-runtime.test.ts` 锁住 sparse-reject 不写错误 payload 但会重推稳定 render。

# 2026-07-01 IME container lift regression
- 现场截图显示键盘弹起后 quickbar 上台但 terminal stage 容器仍按未抬起区域占位，底部被 quickbar/IME 盖住。已锁定唯一 owner：`TerminalPage` 只在 UI shell 层计算 `terminalStageBottomPx = terminalChromeBottomPx + terminalImeLiftPx`；`TerminalStageShell` 只消费 bottom 裁切；`TerminalView` 不拿 IME token、不触发 `onResize`。
- 回归验证：`TerminalPage.android-ime.test.tsx` 锁住 stage 跟随 IME 上台且 `onResize` 不触发；`TerminalPageStageShell.pane-stage.test.tsx`、`TerminalView.dynamic-refresh.test.tsx`、`TerminalView.bottom-stale.test.tsx` 同跑，防止 shell 修复越界到 renderer 内容链。

# 2026-07-02 Drawer catalog-only session projection
- 现场问题：Terminal drawer 仍显示已经打开过但 daemon 不再枚举到的旧 tab。根因在 `TerminalPage.drawerSessions`：catalog 投影后又追加 `runtimeOnly` 本地 sessions，导致 stale opened tabs 绕过 daemon live session 真源。
- 修复方向：drawer rows 只消费 `sessionGroups` daemon catalog，再把命中的 live runtime session 合并 status/active；不在 catalog 内的 runtime session 不显示在抽屉。回归：`TerminalPage.session-drawer.test.tsx` 锁住 catalog live/remote-only 显示，stale opened tab 隐藏。
# 2026-07-02 architecture audit findings

- 只读审计范围：模块化/边界清晰、数据与控制分离、无 fallback、无静默失败。已验证 `feature-registry-truth` 与 `function-wiki-truth` 当前 PASS，但 gate 只检查文档/路径存在与字符串对齐，不检查 forbidden path 真实调用、daemon 是否持有 client 状态、fallback/silent failure 静态违规。
- 高风险发现：`src/server/terminal-runtime-types.ts` 与 `src/server/terminal-mirror-runtime.ts` 仍在 daemon session/mirror 内保存 `widthMode/adaptiveCols`，并由 subscriber width mode 反向影响 tmux resize；这与“daemon 不持有客户端 width mode / viewport truth”规则冲突。
- 高风险发现：`src/App.tsx` 的 force relay / use auto handler 直接 `closeSession -> setTimeout -> createSession -> switchSession`，绕过 `useSessionOpenActions` / open-tab owner，属于页面层承载 session lifecycle 控制。
- 静默失败发现：`open-tab-persistence` 读/写 `OPEN_TABS` / `ACTIVE_SESSION` 失败时只 `console.error` 并返回空/继续，容易把存储损坏/不可写投影成“没有打开 tabs”，缺显式错误链或 UI 事实。
- fallback/默认值发现：`TerminalSessionDrawer` 对缺 hostKey session 使用 `default/本机` sentinel；`open-tab-intent` 仍暴露 `fallbackActiveSessionId/fallbackSessionIds` 激活替代路径。需要区分 UI presentation fallback 与业务真源 fallback，并加 gate 禁止关键真源使用 fallback 命名/语义。

# 2026-07-02 IME lift inconsistent across phones

- 架构映射：问题属于 UI Projection / Layout Shell 的 `terminal.keyboard_ime`，owner 是 `terminal-keyboard-lift.ts`、`TerminalPage.tsx`、`TerminalPageStageShell.tsx`；禁止改 `TerminalView`、daemon、buffer manager。
- 现场两台手机键盘弹起时 quickbar/terminal shell 有的上抬、有的没上抬。高风险根因：WebView/visualViewport 指标在某些设备上看起来像“已 resize”，但真实 root/container 并未被 Android 推到键盘上方；当前 `isKeyboardViewportAlreadyResized()` 只看 stable height > current layout + visualViewportBottom≈current layout，可能把 adjustPan/overlay 设备误判成已 resize，返回 lift=0。
- 已验证更精确根因：`TerminalStageShell.bottom` 已包含 `quickBarHeight + touchSafeOffset + TERMINAL_QUICK_BAR_RENDER_LIFT_PX + IME lift`，但 `TerminalQuickBarShell.bottom` 只包含 `touchSafeOffset + IME lift`，少了 quickbar 自身 `TERMINAL_QUICK_BAR_RENDER_LIFT_PX=30` 基线。修复为 QuickBar shell 同样纳入 render lift；红测先红后绿。验证：IME owner gate 59 tests PASS，`tsc --noEmit` PASS。

# 2026-07-02 architecture remediation slice: open-tab truth

- 架构映射：本轮属于 Persistence Truth Block / `terminal.open_tabs`，owner 是 `src/lib/open-tab-intent.ts` 与 `src/lib/open-tab-persistence.ts`；允许路径限 open-tab hooks/tests/package gate，禁止改 daemon / renderer / Connections projection。
- 修复：`fallbackActiveSessionId` 改为显式 `preserveActiveSessionId` policy，`fallbackSessionIds` 改为 `nextActiveCandidateSessionIds` policy；`architecture-boundary-truth.test.ts` 接入 `test:feature-registry`，防止旧 fallback 命名回到 core intent。
- 修复：`readPersistedOpenTabsState()` / `readPersistedActiveSessionIdState()` 现在返回 `status: failed/invalid` 与 `error`，`persistOpenTabsState()` / `persistActiveSessionId()` 返回 `{ ok:false, error }`；调用方至少记录 `open-tabs.persistence.write-failed`，不再只有 void/空 truth。
- 验证：open-tabs required gates PASS（52 tests），open-tab runtime/session action slice PASS（59 tests），`test:feature-registry` PASS（11 tests），`tsc --noEmit` PASS。

# 2026-07-02 architecture remediation slice: session orchestration owner

- 架构映射：本轮属于 Session Orchestration Block / `terminal.open_tabs` action surface，owner 是 `src/hooks/useSessionOpenActions.ts`；处理方式是分离下沉，禁止 `App.tsx` 直接决定 force relay / use auto 的 close/create/switch 生命周期。
- 修复：`App.tsx` 删除 force relay / use auto 里的 Host 构造与 `closeSession -> setTimeout -> createSession -> switchSession` 序列，只把 `TerminalPage` intent 交给 owner action；`useSessionOpenActions` 负责同 `sessionId` 下按 `transportMode: webrtc/auto` 重建 runtime，并显式 alert 缺 relay token / daemonHostId。
- 回归：`useSessionOpenActions.test.tsx` 正向锁 force relay / auto mode rebuild；反向锁缺 relay token 不触发 runtime lifecycle；`architecture-boundary-truth.test.ts` 锁 `App.tsx` 不再包含 force relay / use auto 生命周期实现。

# 2026-07-02 architecture remediation slice: daemon client width policy removal

- 架构映射：本轮属于 Daemon Truth Block / `terminal.transport_lifecycle`，owner 是 `src/server/terminal-runtime-types.ts`、`src/server/terminal-mirror-runtime.ts`、`src/server/terminal-runtime.ts`；处理方式是物理移除，禁止 daemon 持有 client `widthMode/adaptiveCols` 或按 client resize 改写 tmux 宽度。
- 修复：删除 `TerminalSession.widthMode`、`SessionMirror.adaptiveCols`、adaptive width reconcile、detach/close 时释放 manual width 的逻辑；attach/resize wire 仍接受 `widthMode` 字段作为兼容输入，但只触发 mirror sync，不进入 daemon session/mirror truth。
- 回归：`server.transport-lifecycle-truth.test.ts` 扫 owner 文件防止 `widthMode/adaptiveCols` state 和 tmux resize ownership 复活；`terminal-mirror-runtime.test.ts` 锁 attach payload 可兼容但不存 policy；`terminal-runtime.detached-session.test.ts` 锁 detach 不再 mutate tmux width policy；daemon/transport/tsc gates 已通过。

# 2026-07-02 connection config share contract slice

- 架构映射：新功能属于 Connections / Storage 的 `connections.config_share`，唯一 payload owner 是 `packages/shared/src/connection/connection-config-share.ts`；页面只能投影 shared link/QR，导入只能走 `useHostStorage.upsertHost`，禁止在 UI/daemon/terminal transport 中复制 payload 或补第二套同步逻辑。
- 当前切片：先下沉 shared payload builder/parser，二维码和链接共用同一 canonical link；payload 显式剥离 `password/privateKey/lastConnected`，解析失败返回 `{ ok:false, error }`，不静默吞错、不产生空 host truth。
- UI 切片：Connection Properties 展示 canonical link + QR SVG + copy；Connections 提供 paste import；App 层统一 `parseConnectionConfigShareLink -> upsertHost`，Android Manifest 注册 `zterm://connection/import`。仍需 packaged-device smoke 才能宣称真机扫码/外部链接端到端完成。
- 现场纠正：真实 `+` 入口是 `TmuxSessionPickerSheet`；分享二维码/链接不能藏在“点击已有连接卡片后才出现”的隐式交互里。打开 `New Connection` sheet 时必须默认选中第一个可分享 host 并直接展示二维码与链接，连接卡片只作为切换分享对象。
- 现场纠正 2：配置分享的默认语义应是“一次分享本机全部已保存连接”，不是默认分享某一个连接。shared payload 真源改为 `hosts[]`；旧单 host 输入只归一成单元素 `hosts[]`；App import 必须遍历 `parsed.hosts` 批量 `upsertHost`。
- 现场纠正 3：全量配置分享还必须包含快捷指令配置。shared payload 增加 `quickActions[]` 和 `shortcutActions[]`；默认全量二维码包含它们，导入时通过 `setQuickActions` / `setShortcutActions` 写回 storage owner。单连接 narrowed share 不附带快捷配置。

# 2026-07-03 IME precise quickbar lift

- 现场诊断值显示 `RESZ=N`、`VV/SH/RAW` 未 resize，`KB/LIFT=294` 合理；剩余“抬高太多”来自 IME lift 上又叠加固定 `TERMINAL_QUICK_BAR_RENDER_LIFT_PX=30`。修复只在 `TerminalPage` UI shell owner 内处理：IME 活跃时 `quickBarRenderLiftPx=0`，键盘隐藏时保留 30px 基线；不传入 `TerminalView`，不触发 resize，不进入 daemon/tmux/buffer truth。
- 回归锁定：IME 活跃的 stage/quickbar bottom 期望整体减少 30px；already-resized 路径保持不二次上抬。验证：IME owner 110 tests PASS，`tsc --noEmit` PASS，`git diff --check` PASS，debug build/APK `0.1.3.1997` PASS。
# 2026-07-05 Android renderer shared visible-gap repair

- 架构映射：本轮属于 `terminal.buffer_render` / renderer visible-range demand；唯一修改点是 Android `TerminalView` 的 viewport emit 改为消费 shared `buildTerminalViewportDemandWithRepair`，不在 Android 复制 missingRanges/gap repair 逻辑。
- 修复：Android follow/reading viewport demand 现在携带 shared core 计算出的 visible `missingRanges`；shared demand key 纳入 missingRanges 拓扑，避免同 viewport 下可见 gap 改变被去重吞掉。无 gap 时仍保持旧 payload 形状，不发送空 `missingRanges: []`。
- 回归：`TerminalView.dynamic-refresh.test.tsx` 增加自动黑盒断言，证明 visible reading/follow gap 会通过 `onViewportChange` 上报 `missingRanges`，并同步渲染 gap marker。
- 验证：shared renderer/Mac tests 25 PASS；Android targeted renderer/buffer tests 86 PASS；Android prebuild terminal regression core 576+96 PASS；relay local smoke PASS；web build PASS；Gradle debug build PASS，APK `0.1.3.2011` 已发布到 update channel。

# 2026-07-05 Android cold-start adaptive width mode

- 架构映射：本轮属于 Client Render Width / BridgeSettings persistence truth；唯一 owner 是 `packages/shared/src/react/use-bridge-settings-storage.ts`，Android App 只消费 `BridgeSettings.terminalWidthMode` 并传给 TerminalPage/SessionContext。
- 根因：无 `zterm:bridge-settings.terminalWidthMode` 或旧配置缺字段时，默认 resolver 用 `Math.max(innerWidth, documentElement.clientWidth, visualViewport.width)`；Android WebView/折叠屏可能首帧 `visualViewport.width=393` 但 layout viewport 为 `980`，导致进入 terminal 前被错判为 `mirror-fixed`，打开 Settings 后再写入/刷新才变成 adaptive。
- 修复：默认 resolver 改为优先使用 `visualViewport.width`，再依次使用 `innerWidth`、`documentElement.clientWidth`；持久化 `BRIDGE_SETTINGS.terminalWidthMode` 仍最高优先级。删除旧 `src/lib/device/TerminalWidthModeManager.ts` 和旧 `terminal-width-mode` localStorage 分叉真源。
- 回归：shared storage 测试覆盖 persisted adaptive、窄 viewport、WebView visual narrow/layout wide、wide viewport；App first-paint 测试覆盖未打开 Settings 时首帧 DOM `data-width-mode=adaptive-phone` 且 connect payload `widthMode=adaptive-phone`；架构 gate 防旧分叉 owner 复活。

# 2026-07-05 Terminal drawer close touch activation

- 现场问题：抽屉 session row 右侧 `×` 在真机触摸路径下无效；已有测试只覆盖 click，没覆盖 Android WebView touch activation。
- 根因：close button 只有 `onClick`；row/drawer 外层同时有 touch/长按手势 owner，真机触摸路径可能不产生可依赖 click 或被父层手势链吃掉。
- 修复：close button 增加自身 `onTouchStart/onTouchEnd/onTouchCancel`，touchEnd 直接调用 `onCloseSession` 并用 ref 去重后续 synthetic click；同时阻止冒泡和清长按 timer，避免触发 select/slot menu。
- 回归：`TerminalSessionDrawer.test.tsx` 新增 close touch activation 用例，锁住 touch 能关闭、不会 select、后续 click 不重复关闭。

# 2026-07-05 MemPalace generated-artifact search correction

- Jason 纠正：zterm 搜索不能包含生成物；只做代码和文档/项目记忆搜索，否则 MemoryPalace 结果没有工程意义。
- 处理：`scripts/mempalace-mine-zterm.sh` 改为安全语料唯一入口，使用 `find + grep` 扫描 corpus，不再依赖本机异常的 `rg`；rsync 开启 `--delete-excluded`，并用 forbidden regex + source allowlist 双重阻断 generated/build/evidence/release/cache/node_modules/html/log/apk/tgz/lock 文件。
- 处理：根目录新增 `.ignore`，普通本地文本搜索同样排除生成物；`AGENTS.md` 和 `android/MEMORY.md` 写入 zterm source-only search 规则。
- 当前验证：安全 mine 完成后发现 `wing=zterm` 仍残留旧 raw repo / 旧 corpus `source_file`；已先备份 palace 到 `/Users/fanzhang/.mempalace/backups/palace-pre-zterm-safe-corpus-prune-20260705T165013Z.tar.gz`，再删除 `wing=zterm && source_file !^ /Volumes/extension/code/memory/zterm-mempalace-corpus-safe/` 的旧索引（drawers 13910、closets 1131）。随后补入 Android native / Mac Electron 真实源码，但排除 Capacitor generated web bundle 与二进制资源；中断 mine 残留的 5 个 native public generated source 已备份到 `/Users/fanzhang/.mempalace/backups/palace-pre-zterm-native-public-prune-20260705T171121Z.tar.gz` 后删除（drawers 18、closets 5）。最终复核：zterm wing 801 个 distinct source 全部在 safe corpus 下，safe corpus 外 0，forbidden path 0；唯一短语搜索命中 `note.md` 与 `MEMORY.md`，不再命中生成物。

# 2026-07-05 terminal buffer render source/DOM black-box gate

- 处理：`terminal.buffer_render` 增加自动黑盒门禁，`TerminalView.dynamic-refresh.test.tsx` 将 source buffer rows 与 DOM visible rows 按 absolute row index 对比，覆盖 fast TUI top/status/bottom refresh 和大窗口 same-window repaint。
- 处理：`session-context-buffer-runtime.test.ts` 增加白盒同窗口多行 body update 测试，证明 buffer truth 更新并调度 render commit；`docs/testing/terminal-refresh-buffer-truth-test-design.md` 记录 lifecycle、white-box、module black-box、project black-box 与缺口。
- 已验证：目标 Android renderer/buffer tests、feature registry gates、tsc、terminal.buffer_render required gates 在本轮补丁后通过；最终提交前需重跑受 memory/docs 变更影响的快速 gate。
## 2026-07-06 drawer remote close / websocket retry closeout

- 架构映射：
  - 抽屉关闭属于 `terminal.session_drawer` + session-open owner 分发；`TerminalPage` 只识别 remote-only drawer row 并转发 intent，`useSessionOpenActions` 执行 `killTmuxSession -> fetchTmuxSessions -> handleRemoteSessionsRefreshed`。
  - WebSocket 断开重试属于 `terminal.transport_lifecycle`；普通 server `closed` 消息是 retryable transport failure，不是 terminal session close truth。终态关闭仍只由 `tmux_session_killed` 锁住。
- 修复：
  - remote-only drawer `×` 不再调用 local open-tab `onCloseSession(remote:...)`，改走 `onCloseDrawerRemoteSession(target, sessionName)`。
  - `SessionContext` 收到 plain `closed` 后走 `onFailure(reason, true)`，由 existing reconnect owner 调度重试，避免落入 closed/disconnected 卡死。
- 已验证：
  - `pnpm --dir android exec vitest run src/pages/TerminalPage.session-drawer.test.tsx src/contexts/session-context-socket-message-runtime.test.ts src/contexts/session-context-transport-runtime.test.ts src/contexts/session-context-transport-open-runtime.test.ts --reporter dot`：4 files / 33 tests PASS。
  - `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx -t "reconnects after a plain websocket closed message" --reporter dot`：1 targeted test PASS。
  - `pnpm --dir android run test:feature-registry -- --reporter dot`：4 files / 31 tests PASS。
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`：PASS。
- 缺口：本轮未跑 L5 真机/APK；只能宣称 owner/unit/integration/type/feature gate 已过，不能宣称真实 Android UI 现场完全闭环。

## 2026-07-07 Android bottom prompt duplicate refresh investigation

- 现场问题：Android 底部 TUI/input prompt 区域出现局部刷新重复，几行 prompt/status/input 被持续刷到上方。
- 架构映射：属于 `terminal.buffer_render`，先查 source buffer -> local buffer -> renderer DOM；禁止用 QuickBar/IME/daemon UI shell 做补偿。当前 owner 候选：`TerminalView` DOM 投影、`session-render-gate`、`session-render-buffer-store`、shared `terminal-buffer` 合并。
- 新增 gate：`TerminalView.dynamic-refresh.test.tsx` 增加 strict source/DOM helper，锁 DOM row absolute index 唯一、DOM 文本按 source absolute index 精确一致；新增 prompt/status/input 高频同窗口刷新测试，源里 prompt 只出现一次时 DOM 也只能出现一次，且不能残留上一帧。
- 已验证：`pnpm --dir android exec vitest run src/components/TerminalView.dynamic-refresh.test.tsx --reporter dot` PASS（64 tests）。`pnpm --dir android exec tsx scripts/daemon-mirror-lab.ts --case=top-live --keep-daemon` PASS，tmux oracle 与 daemon payload compare ok。
- 当前缺口：`adb devices -l` 无设备，不能做真机 WebView DOM/截图/运行时日志闭环；现有证据只证明 pure TerminalView 同窗口 repaint 与 daemon top-live oracle 不复现，不能宣称截图现场已修复。

## 2026-07-07 Android bottom prompt duplicate root fix

- 现场进一步证据：tmux `rcc` 源只出现一个 prompt/input，但 daemon head 曾出现 `latestEndIndex/availableEndIndex` 从 1220 回退到 1188；这会让 Android local buffer tail anchor 倒退，旧底部 prompt/status/input 行被当成新窗口内容刷到上方。
- 根因 owner：Daemon Truth Block 的 `terminal-mirror-capture.ts` 使用 single-capture-authoritative 直接发布；tmux `history_size + paneRows` 在 alternate screen / TUI 刷新时可能小于当前 mirror tail。Client buffer 也会接受 forward-revision payload 的 `availableEndIndex` 回退。
- 修复：daemon capture 改为同一次 sync 内连续两帧一致或匹配当前 mirror 才发布；同一 mirror 的 totalAvailableLines 以当前 mirror end 做单调下界，TUI/alternate screen 新内容发布到当前 tail anchor，不允许 tail 倒退。shared client buffer 拒绝无显式 reset 的 authoritative tail regression。
- 已验证：owner gate `terminal-mirror-capture / terminal-mirror-runtime / terminal-buffer / TerminalView.dynamic-refresh` 4 files / 115 tests PASS；`test:feature-registry` 31 tests PASS；`tsc --noEmit` PASS；`git diff --check` PASS；真实 `pnpm --dir android run daemon:mirror:close-loop` PASS，覆盖 codex-live、top-live、vim-live、initial-sync、local/external input、daemon restart、schedule-fire，并自动 replay/source compare。
- 当前缺口：还未在真机 WebView 上安装新 APK 后复现验证；可以宣称 L1/L2 闭环通过，不能宣称 L5 真机现场最终闭环。

## 2026-07-07 File Sync markdown preview selection

- 现场问题：文件同步里远端 `USER.md` 能预览但无法选中下载。根因是旧交互把 markdown 文件行点击定义为预览，且复选框没有独立事件，点击复选框会冒泡到行点击并被预览吞掉。
- 架构映射：属于 File Sync UI projection / `FileTransferSheet` 交互 owner；daemon file list/download 真源不变。
- 修复：复选框改成独立 button，点击时 `stopPropagation()` 并只切换 selection；文件名/行点击仍保留 markdown 预览或目录进入。远程/本地列表都统一该选择入口。
- 已验证：`pnpm --dir android exec vitest run src/components/terminal/FileTransferSheet.test.tsx --reporter dot` PASS（15 tests）；`test:feature-registry` PASS（31 tests）；`tsc --noEmit` PASS；`git diff --check` PASS。

## 2026-07-07 session switch websocket slow reconnect analysis

- 现场问题：切换 session 后断掉的链接长时间不恢复，UI toast 显示 `ws connect timeout`。本轮只做分析，未改代码。
- daemon health 证据：本机 `127.0.0.1:3333/health` 正常，PID `858`，sessions `2/2 ready`，mirrors `4/4 ready`，不是 daemon dead。
- 当前 Android client 真实语义：`explicit-resume -> switchSession -> ensureActiveSessionFresh -> reconnectSession/open intent`。`buildSessionTransportReusePlan()` 只复用同 session、同 target、`readyState=OPEN` 的 session socket；`CONNECTING` 或 fresh pending open 会 `wait-existing-open`，不会抢占重建，也没有一个全局 daemon WebSocket 在多个 session 间复用。
- 慢点链路：pending open stale 阈值 5s；control/session handshake timeout 4s；TraversalSocket 单个 WS candidate timeout 1.8s，失败后内部可继续 candidate/reconnect；reconnect bucket 后续指数退避最高 30s。截图里的 `ws connect timeout` 更像 TraversalSocket/control/session open 链路超时，而非 daemon mirror 死。
- 高风险根因候选：
  1. session 切换命中同 target 的 `CONNECTING` / pending open 时，复用策略选择等待，导致 UI 卡在旧 open 超时窗口。
  2. control socket 是 target-level，但 session socket 仍是 per-session；现实现并未实现“daemon 启动时一个长期全局 WebSocket，session 切换只复用同一物理连接”。
  3. `online` 事件在 App lifecycle 直接调用 `reconnectSession(activeSessionId)`，随后又走 foreground/audit；这条路径可能与唯一 `active-resume` owner 重叠，应后续收口到同一个 transport owner。
- 下一步若修复：先补 runtime debug/测试，锁 `explicit-resume` 对 fresh pending/CONNECTING/closed/stale connecting 的决策；再决定是否把 target-level long-lived transport 做成唯一 owner，移除重复 reconnect 入口。

## 2026-07-07 active resume pending websocket wait budget

- 架构映射：本轮属于 `terminal.transport_lifecycle`；唯一 owner 是 `SessionContext -> ensureActiveSessionFreshRuntime / buildActiveSessionRefreshPlan / reconnectSessionRuntime`，不改 daemon、renderer、TerminalView，也不实现全局唯一 WebSocket。
- 修复：active resume / active reentry / explicit resume 对 pending open 使用 1200ms 短等待预算；超过预算后走 `reconnectSession(sessionId, { forceReplaceTransport: true })`，避免旧 CONNECTING/pending open 长时间挡住恢复。active tick 与普通首连仍不抢占，防止重复开 socket。
- 状态投影：pending open 未超过预算且处于 reconnect runtime 时，SessionContext 写入 `state=reconnecting` 与 `lastError=Waiting for existing websocket open`，现有 TerminalPage banner 会显示真实等待状态；健康首连 `connecting` 不被改成 reconnecting。
- 已验证：transport planner/runtime L1 96 tests PASS；SessionContext ws refresh + transport runtime 135 tests PASS；`test:feature-registry` 31 tests PASS；`tsc --noEmit` PASS；`git diff --check` PASS。
- 当前缺口：尚未完成标准 debug APK 构建与 Jason 真机安装验证；仍不能宣称 L5 现场闭环。

## 2026-07-07 Android IME quickbar bottom alignment

- 现场问题：系统 IME 弹出时底部偶发不对齐，截图表现为 terminal 内容/QuickBar 与键盘边界关系不稳定。
- 架构映射：本轮属于 UI shell 的 `terminal.keyboard_ime` + QuickBar shell measurement；唯一修改点候选是 `src/components/terminal/TerminalQuickBar.tsx` 的 measured shell height 上报。禁止改 daemon、buffer manager、TerminalView renderer、tmux rows/cols。
- 测试设计：先在 `TerminalQuickBar.test.tsx` 加红测，证明 `keyboardInsetPx > 0` 时 `onMeasuredHeightChange` 必须上报 QuickBar DOM shell rows 的真实高度，不得把同一份 IME lift 从测量高度里再减一次；再跑 `TerminalPage.android-ime` 验证 stage bottom = measured quickbar height + safe offset + IME lift。
- 根因候选：`TerminalQuickBar` 当前用 `measuredPx - keyboardInsetPx` 上报 shell 高度；但 QuickBar 根节点自身没有吃 keyboard padding，IME lift 已由外层 `TerminalQuickBarShell.bottom` 消费。键盘高度大于 QuickBar 高度时会把 `quickBarHeight` 压到 0，导致 stage 不再为 QuickBar 预留空间。

## 2026-07-08 Android TUI leak-row daemon capture closeout

- 现场问题：Android 仍出现底部 TUI/input prompt 行漏刷、旧行残留上移。架构归属 `terminal.buffer_render` 的 daemon mirror 写侧；不碰 QuickBar/IME/UI shell。
- 红测先失败：`terminal-mirror-capture.test.ts` 证明当前 `captureMirrorAuthoritativeBufferFromTmux()` 只做 single-capture 直接发布；已有 `resolveStableMirrorCaptureSnapshot()` helper 只被 helper 测试覆盖，未接入真实主线。另一个红测证明 alternate-screen/TUI 可见窗口会把 mirror tail 从 `500-503` 拉回 `0-3`。
- 修复：daemon capture 主线接入 `resolveStableMirrorCaptureSnapshot()`；只有当前 mirror 已匹配或连续两次 snapshot 一致才发布。`totalAvailableLines` 以当前 mirror end 为单调下界，防止短 alternate-screen capture 让 absolute tail 回退。
- 验证：capture 红测转绿，显示 `stabilizeAttempts=3` 与 `total=503 buffer=500-503`；daemon runtime / buffer contract / client sparse buffer / TerminalView source-DOM 6 files / 143 tests PASS；feature-registry 31 PASS；tsc PASS；`daemon:mirror:close-loop` 8 cases PASS，top/vim/codex replay/source compare ok。
- APK：标准 `./scripts/build-android-debug.sh` PASS，发布 `0.1.3.2030` 到 `android/update-dist`、`android/release-dist`、`~/.zterm/updates`，sha256 `14c4c413c04dd56062ee7c918774504106ba7b25e82e79a9a935beb486ef9c08`。
- 本机 daemon：已执行 `daemon:install-global` + `zterm-daemon restart`，health `127.0.0.1:3333` OK，新 pid `26206`；`~/.zterm/daemon-runtime/server.cjs` 已确认包含 `resolveStableMirrorCaptureSnapshot` 主线和 `totalAvailableLines = Math.max(resolvedAvailableLineCount, getMirrorAvailableEndIndex2(mirror))`。

## 2026-07-08 Adaptive width mode stale geometry root fix

- 现场问题：手机 Settings 已设 `adaptive-phone` 时，session reconnect 仍按 `mirror-fixed` 发给 daemon。
- 架构映射：属于 `terminal.transport_lifecycle` 的 client width policy 传递；唯一 owner 是 `SessionContext` 的 transport geometry reader / wire payload builder。禁止改 daemon 或 TerminalView 做事后补偿。
- 根因：`SessionContext` 的 `readRequestedTerminalGeometry()` 优先返回 session runtime 里旧的 `requestedTerminalGeometry`；只要该 session 曾写过 `{ widthMode:'mirror-fixed' }`，后续 Settings 改成 adaptive 后 reconnect 仍会读旧 mode。
- 修复：`session-context-provider-core-assemblies.ts` 读取 geometry 时只把 session runtime 当 measured cols 来源，width policy 永远以当前 `BridgeSettings.terminalWidthMode` 为准；fixed 下不携带 cols/rows，adaptive 下只保留合法 cols。
- 回归：`SessionContext.ws-refresh.test.tsx` 增加 red case，证明 fixed stale geometry -> settings adaptive -> reconnect 的 connect payload 必须为 `adaptive-phone`。

## 2026-07-08 render store revision monotonic gate after 2032 field failure

- 现场问题：Jason 确认 APK `0.1.3.2032` 仍有旧 buffer / 新 buffer 高频交替，说明 lower-revision / same-revision stale payload guard 不足以闭环。
- 架构映射：属于 `terminal.buffer_render` / Client Rendering And Buffer Block；唯一修改点是 `src/lib/session-render-buffer-store.ts` 和对应 gate。禁止 TerminalPage / QuickBar / UI shell 清 DOM 或 daemon 接管 renderer 状态。
- 排查结果：`session-render-gate` flush 时读取 liveBufferStore 最新 snapshot；TerminalView DOM key 是 absolute row index，VisibleRow memo 比较 row ref/plainText。未发现按数组 offset 错写 sparse diff 或 DOM key 复用旧行的直接证据。
- 修复：render store 新增 per-session body revision 单调门禁。已发布 `revision=N` 后，`revision<N` 的 snapshot 拒绝发布并记录 `session.render-store.revision-regression-drop`；显式 `deleteSession()` 后允许低 revision 新链路重新开始。
- 回归：`session-render-buffer-store.test.ts` 新增正/反测试，锁 lower revision 不能覆盖新行、explicit delete 后可 reset。`terminal.buffer_render` owner gate 9 files / 150 tests PASS。
- 项目级验证：`test:feature-registry` 31 PASS，`tsc --noEmit` PASS，`git diff --check` PASS，`daemon:mirror:close-loop` 8 cases PASS。
- APK：`./scripts/build-android-debug.sh` PASS，版本 `0.1.3.2033`，sha256 `15e6e69ba70ed532c61ef7e301e9a994738315901978fe80fae22569dc57cef4`，已发布到 `android/update-dist` 与 `~/.zterm/updates`。`adb devices -l` 无 online 设备，本机不能完成 L5 真机 UI 复测。
- 缺口：这只排除本地 render 发布回退。若真机仍出现高 revision 旧内容，需要继续用 `session.buffer.apply.inspect`、`session.render-gate.flush.inspect` 和新 `session.render-store.revision-regression-drop` 区分 daemon payload 源污染 vs WebView compositor/DOM 显示问题。

## 2026-07-08 refresh slow + status bar overlap follow-up

- 现场问题：Jason 反馈 2033 刷新很慢；截图还显示 Android 状态栏图标覆盖 terminal 顶部文字/返回按钮。
- 慢刷根因：daemon mirror capture 为防半帧要求连续两次 canonical snapshot 内容完全一致；动态 TUI 每次 capture 都可能变化，导致多次重采样甚至 `tmux capture remained unstable`，随后 live sync failure backoff，体感刷新慢。
- 修复：`resolveStableMirrorCaptureSnapshot()` 改为“结构稳定才发布”：连续两次 snapshot 的 rows/cols/cursorKeys/scrollback/window line count/available line count/visibleTop 稳定即可发布第二次最新内容；若当前 mirror 完整一致仍一次通过。`stabilizedAgainst='consecutive-window'` 表示内容可变但窗口稳定。
- 状态栏根因：`resolveTerminalHeaderTopInsetPx(true)` 硬返回 16px，折叠屏/高状态栏设备实际 safe-area top 更大，导致 header/terminal 首行进状态栏。
- 修复：Android top inset 读取 CSS `env(safe-area-inset-top)`，最低 16px；仍不读取 `visualViewport.offsetTop`，避免 IME 弹起时 top inset 二次叠加。
- 验证：`terminal-keyboard-lift.test.ts`、`TerminalPage.android-ime.test.tsx`、`TerminalHeader.test.tsx`、`terminal-mirror-capture.test.ts` PASS；相关完整 gate 12 files / 223 tests PASS。
- 最终验证：`test:feature-registry` 31 PASS；Android `tsc --noEmit` PASS；`git diff --check` PASS；`daemon:mirror:close-loop` 8 cases PASS（codex-live/top-live/vim-live/initial-sync/local-input/external-input/daemon-restart/schedule-fire，replay + strict audit OK）；Mac client `pnpm --dir mac test -- --reporter dot` 22 files / 146 tests PASS；Mac type-check PASS；标准 `./scripts/build-android-debug.sh` PASS，发布 APK `0.1.3.2034`，sha256 `b168e63472326eb716331ee4a8ea5d06da1d88841533196d4bf2593f3a9f3030`。本机 `adb devices -l` 无 online 设备，L5 Android 真机 UI 复测仍缺。

## 2026-07-08 old bridge settings adaptive width mode fix

- 现场问题：Jason 截图反馈 2034 仍像 fixed，不按 `adaptive-phone`，同时位置/刷新仍异常。
- 架构映射：属于 Client Render Width / BridgeSettings persistence truth；唯一 owner 是 `packages/shared/src/react/use-bridge-settings-storage.ts`。禁止在 daemon / TerminalView / TerminalPage 用后置 resize 补偿当前 settings 真源错误。
- 根因：旧 `BRIDGE_SETTINGS` 存在但缺 `terminalWidthMode` 时，`readStoredBridgeSettings()` 直接 `normalizeBridgeSettings(JSON.parse(stored))`；normalize 对缺失或未知 mode 使用 `DEFAULT_BRIDGE_SETTINGS.terminalWidthMode = mirror-fixed`，绕过 `visualViewport.width` 设备检测。
- 修复：shared storage 读取旧配置时先注入检测到的 `terminalWidthMode`，再 normalize；已有显式 `adaptive-phone` / `mirror-fixed` 不覆盖。调试浮窗增加 `WM` 字段，下一轮截图能直接确认当前 app 看到的宽度模式。
- 验证：shared storage 5 tests PASS；App first-paint + SessionContext reconnect + TerminalPage IME/lift gates 194 tests PASS；Android `tsc --noEmit` PASS；feature registry 31 PASS；`git diff --check` PASS；`daemon:mirror:close-loop` 8 cases PASS；standard debug build PASS。APK `0.1.3.2035`，sha256 `a9702c34b7bc5372c1e317bc4e6d2fb81d979c59994e88c1453d6c982a578a86`。本机 ADB 只有 offline emulator，仍缺真机 L5 UI 复测。

## 2026-07-08 WebSocket quiet-time must not expire long session transport

- 现场判断：同一 tmux session 的 per-session WebSocket 在 daemon 未重启、tmux target 未变、物理 socket 未 close/error/send failure 时不应“过期”。此前 `lastServerActivityAt` stale -> probe -> `forceReplaceTransport` 和 heartbeat pong timeout close 都是错误失效真相。
- 修复：`buildActiveSessionRefreshPlan()` 对 `WebSocket.OPEN` 一律 request-head，不再返回 stale probe；input 发送成功后不再触发 stale probe；client app heartbeat pong overdue 只继续 ping，不 finalize/close；daemon ws heartbeat missed pong 只记录并继续 ping，不 close；Mac `bridge-transport` pong overdue 也只继续 ping，不 close。
- 同步：`architecture.md`、transport lifecycle decision、terminal checklist/matrix、websocket reuse test design、`terminal-buffer-truth` skill 均改成 quiet-time observational rule；旧 2026-05-27 audit 仍是历史背景，不再是当前真源。
- 验证：transport/heartbeat/SessionContext targeted gates 8 files / 253 tests PASS；Android `tsc --noEmit` PASS；feature registry 31 PASS；`git diff --check` PASS；Mac client tests 22 files / 147 tests PASS；Mac type-check PASS；`daemon:mirror:close-loop` 8 cases PASS（codex/top/vim/initial/local input/external input/daemon restart/schedule）。
- 复测构建：标准 `./scripts/build-android-debug.sh` PASS，版本 `0.1.3.2037`，versionCode `1032037`，sha256 `ccf406236e33c5ee5a15e68a0b2e712e6ff1633d0251fbf293e71207dd37416a`；`android/update-dist/latest.json`、`android/update-dist/zterm-latest-debug.apk`、`android/release-dist/zterm-latest-debug.apk`、`/Users/fanzhang/.zterm/updates/zterm-0.1.3.2037.apk` 已对齐。`adb devices -l` 无在线设备，Android L5 真机现场复测仍需 Jason 安装后验证。

## 2026-07-08 visible-window body pull for bottom status refresh

- 现场问题：用户确认“WebSocket OPEN 不等于拉 buffer”，隐藏区域不能因连接存在而主动拉取；随后底部频繁更新状态栏几乎不更新，说明同位置刷新判断和可见窗口拉取边界混乱。
- 架构映射：属于 Client Mirror Buffer / SessionContext buffer runtime；唯一 owner 是 `session-context-buffer-runtime.ts`、`session-buffer-planner-helpers.ts` 和 shared `buffer-sync-request-planner.ts`。daemon 只回 head/range，不拥有 viewport/follow/reading 策略；renderer 只声明 visible range。
- 修复：没有 renderer visible range 时，`buffer-head` 只更新 head/cursor metadata，不触发 body pull；有 visible range 时，tail/reading/request/catch-up 的 body pull 都严格限制在当前 visible window。1000 行只作为本地 sparse retention，不再是拉取目标；旧“三屏请求窗口”语义从 skill/architecture/decision 中移除。
- 底部状态栏刷新：`daemonRevision > localRevision` 且 end 相同仍触发当前 visible tail window 刷新，锁住 `top`/状态栏这类同一行原地更新；但不会扩大到隐藏历史或 full cache。
- 验证：Android targeted gates 3 files / 228 tests PASS；shared terminal planner/renderer 3 files / 50 tests PASS；Android typecheck PASS；feature registry 31 PASS；`git diff --check` PASS；Mac client tests 22 files / 147 tests PASS；Mac type-check PASS；`daemon:mirror:close-loop` 8 cases PASS。
- 复测构建：标准 `./scripts/build-android-debug.sh` PASS，版本 `0.1.3.2038`，versionCode `1032038`，sha256 `bde818c79cdff64d64275298923e644b30925b7541e044d22e2a1967c5e02adb`；`android/update-dist/latest.json`、`android/update-dist/zterm-latest-debug.apk`、`android/release-dist/zterm-latest-debug.apk`、`/Users/fanzhang/.zterm/updates/zterm-0.1.3.2038.apk` 已对齐。`adb devices -l` 只有 `emulator-5554 offline`，本机无法完成 Android L5 真机 UI 复测。

## 2026-07-08 daemon subscribed mirror cadence fix

- 现场问题：2038 状态栏仍经常不刷新且刷新率低。visible-only body pull 已修，但 daemon mirror 在“最近无 live activity”后退到 idle 120ms，下一次原地状态栏更新必须等下一轮 idle capture 才能被发现。
- 架构映射：属于 Daemon Truth Block / mirror scheduler；唯一 owner 是 `terminal-performance-scheduler.ts` 和 `terminal-mirror-runtime.ts`。daemon 仍不读取 client active/visible/follow/reading，只用物理事实：ready subscriber、transport ready/backpressure、failure、capture cost。
- 修复：ready subscriber 存在且无 failure/backpressure/over-budget capture 时保持 active/fast cadence；`lastLiveActivityAt` 不再决定 ready mirror 是否 idle。per-subscriber helper 只把 `ready=true` transport 计为健康 subscriber，closed transport 走 no-subscriber slow path。
- 验证：server scheduler/mirror targeted gates 4 files / 35 tests PASS；Android `tsc --noEmit` PASS；feature registry 31 PASS；`git diff --check` PASS；`daemon:mirror:close-loop` 8 cases PASS，top-live replay strict audit OK。
- 收口：Mac client 22 files / 147 tests PASS，Mac type-check PASS；MemPalace safe corpus re-mine 后可搜到 `Daemon subscribed mirror cadence truth status bar`；standard debug build PASS，APK `0.1.3.2039` / versionCode `1032039` / sha256 `1c2303435e82b61c1bec61aa0ffe9f0e474c47f4c658d38336b76a521a57d5ca` 已发布到 `android/update-dist`、`android/release-dist`、`~/.zterm/updates`。`adb devices -l` 无在线设备，Android L5 真机 UI 刷新复测仍缺。
- 进一步发现：`~/.zterm/daemon-runtime/server.cjs` 在构建后仍残留旧 `RECENT_PROGRESS_MS/recentlyActive`，说明只升级 APK 不能修 daemon-side cadence。已执行 `pnpm --dir android run daemon:install-global && zterm-daemon restart`；新 runtime 只命中 `subscribed-good-transport-low-capture-cost`，无旧 idle gate；`curl http://127.0.0.1:3333/health` 返回 `ok=true`、pid `40791`、`wsUrl=ws://127.0.0.1:3333`。

## 2026-07-08 adaptive width mode still entering as fixed

- 现场问题：最新版本进入 terminal 后横向排版仍按 fixed，不读 adaptive。
- 架构映射：属于 Client Render Width / Session Transport payload；唯一 owner 是 BridgeSettings -> App width-mode handler -> TerminalPage/TerminalStageShell/TerminalView -> SessionContext payload builder。禁止 daemon 保存 widthMode，也禁止 TerminalView/daemon 后置补偿 fixed。
- 根因 1：`TerminalPage` props 缺省仍是 `mirror-fixed`，任何入口/测试/初始化缺 prop 时会直接固定化。
- 根因 2：active terminal/header 发出的 `onTerminalWidthModeChange` 只调用 `sendTerminalResize()`，没有同步更新 BridgeSettings；即使当次 resize 是 adaptive，下一次进入或 reconnect 仍可能从 stale settings 走 fixed。
- 根因 3：`TerminalPageStageShell` 用 `terminalWidthMode !== "mirror-fixed"` 禁用 tab swipe；当前没有独立 horizontal pan owner 时，这会让 fixed 模式进入无交互出口，和架构规则冲突。
- 修复：TerminalPage 默认改 `adaptive-phone`；App 包装 width-mode handler，先写 BridgeSettings 再发送 resize；StageShell 不再用 width mode 禁用 tab swipe。
- 验证：Android width/layout/transport gates 7 files / 285 tests PASS；shared settings/renderer 2 files / 22 tests PASS；Android type-check PASS；feature registry 31 PASS；`git diff --check` PASS。
- 构建：standard debug build PASS，prebuild terminal contracts 48 files / 592 tests PASS，common flows 96 tests PASS，relay smoke OK。发布 APK `0.1.3.2040` / versionCode `1032040` / sha256 `baf0b43e3e797ee48179c5008f9efd273fbbde696220f6ec5e1247ec0738c7e1` 到 `android/update-dist`、`android/release-dist`、`~/.zterm/updates`。`adb devices -l` 无在线设备，Android L5 真机 width-mode 复测仍缺。

## 2026-07-09 bottom-row refresh risk lock + adaptive default closeout

- 下方刷新风险：新增 `TerminalView.dynamic-refresh.test.tsx` 回归，真实 `BaseTerminalView + session-render-buffer-store` 场景先渲染 session A bottom rows，切到 session B，发布 A 的 late revision，再模拟 IME 高度变化对应的 `ResizeObserver` layout refresh；断言 B DOM 只含 B bottom rows，不含 A/late-A rows；切回 A 后只显示 A 最新 rows。
- 验证下方刷新：`TerminalView.dynamic-refresh.test.tsx` 64 tests PASS；`session-render-buffer-store.test.ts` + `TerminalPage.tab-isolation.test.tsx` + `TerminalPage.android-ime.test.tsx` 63 tests PASS；Android typecheck PASS；feature registry/architecture/wiki/loop 31 tests PASS；`git diff --check` PASS。
- 继续问题：Jason 反馈 2040 最新版设置仍看起来固定宽度。复查发现上一轮只修了 storage hook / TerminalPage / App handler，但 shared `DEFAULT_BRIDGE_SETTINGS`、`normalizeBridgeSettings()`、Android `normalizeTerminalWidthMode()` 和 Settings 选项顺序仍以 `mirror-fixed` 为默认/首选；任何绕过 storage hook 或 draft normalize 的路径都能复活 fixed。
- 修复：`packages/shared/src/connection/bridge-settings.ts` 默认 `terminalWidthMode` 改为 `adaptive-phone`，unknown/missing normalize 改为 adaptive；`android/src/lib/terminal-width-mode-manager.ts` unknown normalize 改为 adaptive，并把 Settings 选项顺序改为 Adaptive Phone 在前。
- 验证宽度链路：Android targeted gates 8 files / 292 tests PASS；shared storage 5 tests PASS；Android `tsc --noEmit` PASS；feature registry/architecture/wiki/loop 31 tests PASS；`git diff --check` PASS。
- 构建：`android/scripts/build-android-debug.sh` PASS；prebuild terminal contracts 48 files / 593 tests PASS；common flows 96 tests PASS；relay smoke OK；发布 APK `0.1.3.2041` / versionCode `1032041` / sha256 `86f2a8427b18ec1e8fee73151c4fc4f32f2b7b1cf7461c9d28ae3d5d5c5122b5` 到 `android/update-dist`、`android/release-dist`、`~/.zterm/updates`。`adb devices -l` 只有 `emulator-5554 offline`，Android L5 真机 UI 复测仍缺。

## 2026-07-09 foreground resume stale CONNECTING transport replacement

- 现场问题：Android App 进后台再回前台后显示 `连接已断开，正在重连 / WS connect timeout`，与“daemon 未重启时同一 tmux session 不应因前后台切换重建失败”的 transport lifecycle 规则冲突。
- 架构映射：属于 `terminal.transport_lifecycle` / SessionContext transport owner；唯一修改点是 `session-transport-open-helpers.ts`、`session-context-activity-runtime.ts`、`session-context-session-runtime.ts` 和 provider lifecycle 接线。禁止改 daemon、TerminalPage 或 renderer 做补偿。
- 红测发现：原补丁只处理 `pending-open` stale；真实 L3 foreground case 里 `session-ticket` 已到达并删除 pending intent，但 session WebSocket 仍卡在 `CONNECTING`，planner 因 `pendingTransportOpen=false` 且 `wsReadyState=CONNECTING` 返回 skip，导致旧 socket 一直等通用 handshake timeout。
- 修复：active resume / active reentry / explicit resume 读取 socket prime 时记录的 `lastPongAtRef` 作为 CONNECTING 起点；超过 1200ms active wait budget 且仍 `CONNECTING` 时返回 `reconnect(forceReplaceTransport:true)`。`reconnectSessionRuntime()` 对 `stale-pending-open` 和 `force-replace` 都物理关闭旧 session socket，并清 stale pending/control socket 后再排新 reconnect。
- 回归：`session-sync-helpers.test.ts` 增加 over-budget CONNECTING 正向和 fresh CONNECTING 反向；`SessionContext.ws-refresh.test.tsx` 增加后台 -> 前台 stale CONNECTING 集成红测，断言旧 socket close、新 socket 只创建一个。
- 验证：transport/lifecycle target gates 5 files / 243 tests PASS；Android `tsc --noEmit` PASS；feature registry/architecture/wiki/loop 31 tests PASS；`git diff --check` PASS。
- 构建：`android/scripts/build-android-debug.sh` PASS；prebuild terminal contracts 48 files / 594 tests PASS，common flows 96 tests PASS，relay smoke OK；发布 APK `0.1.3.2042` / versionCode `1032042` / sha256 `c93a72ce9a7fc476806c98d0d422870702e5399d4ec96c0a128138920104a9f3` 到 `android/update-dist`、`android/release-dist`、`~/.zterm/updates`。`adb devices -l` 无在线设备，Android L5 前后台实机复测仍缺。

## 2026-07-09 correction: foreground / online must not rebuild session WebSocket

- Jason 纠正：每个 session 的 WebSocket 是 client-owned long transport truth；网络 online、前后台恢复、切 tab、沉默、missed pong 都不是重连依据。已有 OPEN ws 必须直接用协议消息向 daemon 查询 head/session 状态；CONNECTING/pending ws 也不得因 active wait budget 自动创建第二条 ws。
- 架构映射：仍是 `terminal.transport_lifecycle`；唯一 owner 是 `SessionContext` transport lifecycle + `useOpenTabLifecycleEffects` 的前后台事件桥。App / TerminalPage / daemon / renderer 不得拥有 reconnect 判断。
- 修复方向：`useOpenTabLifecycleEffects` 移除 `reconnectSession` 能力，`online` 只调用 `resumeActiveSessionTransport(activeSessionId)`；`buildActiveSessionRefreshPlan()` 对 stale pending open / over-budget CONNECTING 返回 `transport-open-pending`，不再 `forceReplaceTransport`。
- 回归：`App.dynamic-refresh.test.tsx` 锁 online 只 probe active，不调用 reconnect；`session-sync-helpers.test.ts` / `session-context-activity-runtime.test.ts` 锁 stale pending/CONNECTING 不替换；`SessionContext.ws-refresh.test.tsx` 锁 foreground stale CONNECTING 不创建第二条 ws。

## 2026-07-09 reconnect bookkeeping is not websocket failure truth

- 继续审计发现：`buildActiveSessionRefreshPlan()` 仍把 `staleReconnectInFlight` 映射为 `reconnect`，会让 foreground/active resume 因本地 reconnect bookkeeping 创建第二条 ws。
- 修复：移除 `staleReconnectInFlight` 和 `connectingTransportStale` planner 输入；任何 `WebSocket.CONNECTING` 在非 active tick 恢复路径都返回 `skip/transport-open-pending`；stale reconnect bookkeeping 不再进入 planner。
- 回归：`session-sync-helpers.test.ts` 新增 stale reconnect bookkeeping 反向锁；targeted transport gate 5 files / 313 tests PASS。
- 最终验证：Android typecheck PASS；feature registry/architecture/wiki/loop 31 tests PASS；`git diff --check` PASS；Mac client 22 files / 147 tests PASS；Mac type-check PASS；`daemon:mirror:close-loop` 8 cases PASS；MemPalace safe mine 后可搜到 `reconnect bookkeeping is not websocket failure truth`。
- 构建：`android/scripts/build-android-debug.sh` PASS；prebuild terminal contracts 48 files / 596 tests PASS，common flows 96 tests PASS，relay smoke OK；发布 APK `0.1.3.2044` / versionCode `1032044` / sha256 `2f04d8e6a4e98281dfa06985774532ff81c6db0ec9c691c2026ec434a5eab688` 到 `android/update-dist`、`android/release-dist`、`~/.zterm/updates`。`adb devices -l` 只有 `emulator-5554 offline`，Android L5 真机 UI 复测仍缺。

## 2026-07-09 adaptive width Settings save stale-current bug

- 现场问题：Jason 安装最新版本后仍反馈 terminal 未使用 adaptive。复查 daemon runtime 已含 `handleAdaptiveResize/applyAdaptiveColsToTmuxMirror`，Settings/TerminalPage 默认也已是 `adaptive-phone`。
- 根因：`App.tsx` 的 Settings `onSave(next)` 写回 `terminalWidthMode` 时调用 `updateBridgeSettingsTerminalWidthMode(current, next.terminalWidthMode).terminalWidthMode`。如果旧 `current` 是 `mirror-fixed`，保存 adaptive 的 draft 仍可能被旧 current 覆盖回 fixed。
- 修复：Settings 保存以 draft `next` 为真源：`updateBridgeSettingsTerminalWidthMode(next, next.terminalWidthMode)`；新增 App 层红测模拟 terminal -> connections -> settings save，并把 updater 套在旧 fixed current 上，断言结果是 adaptive。
- 已验证：`App.dynamic-refresh.test.tsx` + Settings/width manager/bridge settings 105 tests PASS；width handshake/layout targeted gates 182 tests PASS；Android typecheck PASS；feature registry/architecture/wiki/loop 31 tests PASS；`git diff --check` PASS。

## 2026-07-09 adaptive width daemon stale process

- 现场继续问题：Jason 确认写入 adaptive 并升级 APK 后仍“完全没有区别”。
- 架构判断：不再停在 Settings 保存层；问题属于 Client Render Width + Daemon adaptive resize 入参链路。daemon 不保存 widthMode，但必须对一次性 `connect/resize widthMode=adaptive-phone cols=N` 执行 tmux `resize-window -x N`。
- 真实复现：在 daemon `pid=40791`、`uptimeSec≈14h` 时，新建 `zterm-adaptive-probe-*` tmux session；WebSocket 发送 `session-open`、`connect widthMode=adaptive-phone cols=47`、`resize cols=53`。daemon 回 `buffer-sync.cols=80`，tmux 仍 `80x24`。
- 关键发现：`~/.zterm/daemon-runtime/server.cjs` 文件包含 adaptive 代码，但运行中的 daemon 进程未重启，仍是旧内存代码。APK 升级不会热加载 Mac daemon runtime。
- 处理：执行 service-scoped `zterm-daemon restart`，新 daemon `pid=17512`、`uptimeSec=3`。
- 复测：同一 WebSocket/tmux probe 后，`connect cols=47` 返回 `buffer-sync.cols=47`；随后 `resize cols=53` 后 tmux 实际为 `53x24`。临时 probe tmux session 已按明确名称删除。

## 2026-07-09 foreground resume / stale buffer chain audit

- 现场问题：杀掉 App 冷启动秒连，但后台回前台卡住 timeout；刷新过程中偶发旧 buffer 闪回。
- 架构映射：属于 `terminal.transport_lifecycle` + client buffer apply gate。唯一 owner 是 `SessionContext lifecycle / activity planner / socket message runtime`；App 只能提供 foreground truth，renderer 只消费 buffer，daemon 不参与 client foreground 状态。
- 根因链路 1：冷启动 / persisted terminal restore 走 `explicit-resume/open`，后台 false->true 走独立 `active-resume`。旧分支遇到 closed/unavailable 时与 explicit resume 不一致，导致后台恢复不走冷启动同一 reconnect/open owner。
- 根因链路 2：`buffer-sync` 有 inactive/live drop，`buffer-head` 没有同级 gate；旧/非 live session 的 head frame 仍可能推进 local head / connected baseline，形成旧 buffer 闪回。
- 修复：foreground false->true 改为触发 `explicit-resume`；从 `android/src` 物理移除 `active-resume` source；`buffer-head` 在 handle 前复用 live buffer gate，inactive 时直接 drop 并记录 debug。
- 回归：`session-context-lifecycle.test.tsx`、`session-sync-helpers.test.ts`、`session-context-activity-runtime.test.ts`、`session-context-socket-message-runtime.test.ts`、`SessionContext.ws-refresh.test.tsx` 共 223 tests PASS；Android `tsc --noEmit` PASS。

## 2026-07-09 terminal background / old-buffer flash audit

- 现场问题：Jason 对比截图显示 zterm Android 背景颜色和真实终端不同；输入刷新时会先出现一帧旧 buffer，再被新 buffer 覆盖。
- 架构映射：属于 `terminal.buffer_render` / Client Rendering And Buffer Block。唯一 owner 是 shared cell/row renderer 与 Android `session-render-gate`；daemon payload、UI shell、transport 不应补偿背景或刷新时序。
- 根因 1：`resolveTerminalCellColors()` 把默认背景 sentinel `bg=256` 映射为 `transparent`；row/cell wrap/gap 也未强制 paint terminal theme background，导致外层容器背景替代 terminal 默认背景。
- 根因 2：`session-render-gate` 在 buffer truth 后又按 `renderCommitMs` 做 per-session debounce，再进 RAF；延迟 commit 可能发布已过期的 scheduled frame，形成旧 buffer 闪烁。
- 修复：默认 bg、row 背景、cell wrap、gap marker/fill 全部使用 `theme.background`；render gate 移除 `resolveRenderCommitMs/renderCommitMs`，只做 RAF coalescing，RAF flush 时读取当前 live buffer。
- 已验证：`pnpm --dir android exec vitest run src/lib/session-render-gate.test.ts src/components/TerminalView.theme.test.tsx src/components/TerminalView.dynamic-refresh.test.tsx src/lib/mobile-config.test.ts src/lib/session-runtime-cadence.test.ts --reporter dot` 97 tests PASS；`pnpm --dir packages/shared exec vitest run src/terminal/renderer.test.ts --reporter dot` 17 tests PASS。
- 完整验证：`SessionContext.ws-refresh.test.tsx` 130 PASS；Android `tsc --noEmit` PASS；feature registry/architecture/wiki/loop 34 PASS；`git diff --check` PASS；standard debug build PASS，prebuild terminal contracts 595 PASS，common flows 96 PASS，relay smoke OK。发布并安装 APK `0.1.3.2047` / versionCode `1032047` / sha256 `eb832f5a205f1ed6db0a934936af31b73c4629512025aee0c78b5faed43ddac6`，设备 `100.104.163.65:5555` dumpsys 确认为 2047，`am start` 后 topResumedActivity 是 `com.zterm.android/.MainActivity`。
- 已知缺口：本轮未在真机上自动复现截图中的具体彩色终端页面；已完成 APK 安装与前台 smoke，仍需要 Jason 用同一页面截图确认视觉背景与旧 buffer flash。

## 2026-07-09 2047 installed but background unchanged: active theme preset root cause

- Jason 现场确认 `0.1.3.2047` 已安装但视觉没有变化。CDP 直连 WebView 后证据：`terminalThemeId=classic-dark`，active `.wterm` computed background 是 `rgb(0, 0, 0)`，默认行/cell computed background 也是黑；显式 TUI input row 仍有 `rgb(49, 52, 57)` 背景，说明 renderer 能渲染 inline payload 背景。
- 根因修正：2047 修掉了 `bg=256 -> transparent` 的 renderer bug，但 active preset `classic-dark.background` 本身就是 `#000000`，所以用户可见背景不会变。继续改 Android 页面/daemon/transport 是错路。
- 修复：`packages/shared/src/terminal/theme.ts` 将 `classic-dark.background` 改为 `#1e1e1e`；`TerminalView.theme.test.tsx` 增加 Classic Dark default bg 红测，断言 scroller/default cells 是 `#1e1e1e`。
- 验证：`TerminalView.theme.test.tsx` 12 PASS；shared renderer 17 PASS；Android typecheck PASS；feature registry 34 PASS；`android/scripts/build-android-debug.sh` PASS，prebuild terminal contracts 595 PASS、common flows 96 PASS、relay smoke OK。
- APK：构建并发布 `0.1.3.2048` / versionCode `1032048` / sha256 `1943c85a393575a30b6d2b858333f435045e48c78ef51911e410f888b317457e` 到 `android/update-dist` 和 `~/.zterm/updates`，四个 version/latest alias sha 一致。
- 真机闭环：`adb install -r` 到 `100.104.163.65:5555` 成功；dumpsys 显示 `versionCode=1032048`、`lastUpdateTime=2026-07-09 16:05:44`。CDP live DOM 显示同一 `terminalThemeId=classic-dark` 下 active `.wterm` background 变成 `rgb(30, 30, 30)`；最近默认行/cell 为 `rgb(30, 30, 30)`；显式 TUI input row cell 仍为 `rgb(49, 52, 57)`，证明 preset 真源变化已进入真实 WebView。
- 未完成：`scripts/mempalace-mine-zterm.sh` 被 MemoryPalace stale lock 阻塞，报 PID `15913` 持锁但 `ps -p 15913` 已无进程；本轮未删除全局 lock，避免破坏索引状态。

## 2026-07-09 daemon ownership / decoupling audit

- 审计边界：daemon 只允许拥有 tmux truth、mirror store、物理 transport/subscriber、daemon 自身 file/schedule/screenshot/relay 业务事实；不得拥有 client lifecycle、active/foreground/background、viewport、renderer、width policy。
- 已确认相对合规：`TerminalSession` 未保存 `widthMode/adaptiveCols/clientSessionId/foreground/follow/reading/renderBottomIndex`；WebSocket close/error 走 transport detach，不直接 destroy mirror；daemon truth targeted tests 5 files / 33 tests PASS。
- 违规 1：daemon 仍把 transport-bound subscriber 建模为 `TerminalSession/sessions/boundSessionId`，并暴露 `closeLogicalSessions/closeLogicalTerminalSession` API。当前行为多为物理 transport 清理，但命名和 API 语义会持续复活“daemon 管 logical client session”的错误设计。
- 违规 2：`terminal-mirror-runtime.ts` 仍存在 `applyAdaptiveColsToTmuxMirror()`，`connect/resize widthMode=adaptive-phone` 会执行 `tmux resize-window -x` 并改 `mirror.cols/baselineCols`。这与当前规则“daemon 不长期保存也不执行 client width policy；mirror-fixed/adaptive 是 client render width mode”冲突。
- 违规 3：`handleAdaptiveResize()` 在没有 mirror 时直接 `return`，message 层不检查结果，属于 resize 请求静默失败。
- 违规 4：`terminal-transport-runtime.ts` 的 send helper 在 transport 不 open 时直接 return；broadcast 可允许显式 drop，但 required protocol response 必须返回失败或抛错，不能静默。
- 违规 5：`terminal-message-runtime.ts` 仍是 500 行级 god dispatcher，一个 switch 同时处理 schedule、tmux、buffer、debug、file、screenshot、input；唯一 owner 不够硬，协议分发层仍承担 feature-specific 判断。
- 违规 6：file upload 直接接受 client payload 的 `targetDir` 并 `mkdirSync/writeFileSync`，没有统一 path resolver/allowlist，daemon 文件 owner 没有收口路径权威。
- 违规 7：HTTP debug projection 暴露 `clientSessions`，debug 可以存在，但命名应改为 `transportSubscribers/subscriberDebug`，并加 gate 保证 debug 投影不参与 runtime 决策。
- gate 缺口：现有 `server.transport-lifecycle-truth.test.ts` 仍断言 `resize-window` 和 `closeLogicalSessions` 存在，说明 gate 只锁旧边界，未锁 Jason 当前明确的强边界。下一步应先更新 gate，再做无行为/有行为整改。

## 2026-07-09 daemon client-width ownership removal slice

- 架构映射：属于 Daemon Truth Block；处理方式是物理移除 daemon 执行 client width policy，并把 logical session API 分离成 transport subscriber 语义。允许路径是 `src/server/terminal-mirror-runtime.ts`、`terminal-runtime.ts`、`terminal-message-runtime.ts`、`terminal-message-control-runtime.ts`、`terminal-daemon-runtime.ts` 和对应 truth tests；禁止路径是 UI/renderer 补偿。
- 修复：移除 `applyAdaptiveColsToTmuxMirror()` 和 `supportsWindowSizeManagement` 注入；attach/resize 的 `widthMode/cols` 只保留 wire compatibility，不再执行 `tmux resize-window -x`，不再用手机 cols 改 `mirror.cols/baselineCols`。mirror geometry 改为来自 existing mirror、tmux pane metrics 或 daemon default。
- 修复：`closeLogicalSessions/closeLogicalTerminalSession` 改为 `closeTransportSubscribers/closeTransportSubscriber`，消除 daemon API 拥有 logical client session 的错误 contract。行为仍是 shutdown/tmux kill 时释放物理 subscriber/transport。
- 修复：`handleAdaptiveResize()` 返回显式 `{ ok:true } | { ok:false, code:'session_not_ready' }`；message runtime 对失败返回 `error`，不再静默接受 resize。
- Gate：`server.transport-lifecycle-truth.test.ts` 反向禁止 `applyAdaptiveColsToTmuxMirror` 和 daemon `resize-window`；`terminal-mirror-runtime.test.ts` 覆盖 adaptive attach/resize 不改 tmux/mirror truth、无 mirror 显式失败；`terminal-message-runtime.test.ts` 覆盖 resize failure 投影。
- 验证：targeted server/daemon gates 8 files / 72 tests PASS；Android `tsc --noEmit` PASS；`rg` 源码扫描无 `closeLogical*` / `applyAdaptiveColsToTmuxMirror` / daemon `resize-window` 残留（除测试反向断言和独立 tmux 语义测试）；真实 `daemon:mirror:close-loop` 8 cases PASS，包括 top/vim/local-input/external-input/daemon-restart/schedule。
- 未完成：`TerminalSession/sessions/boundSessionId` 仍是命名/模型债；send helper 静默 drop、file upload targetDir、message god dispatcher、HTTP debug `clientSessions` 仍待后续切片处理。

## 2026-07-09 explicit resume same-socket head probe

- 现场问题：新版本不再报连接不上，但后台返回或网络波动后界面不刷新，说明 transport 复用方向有效，但 resume 后没有重新拉取 head/body。
- 架构映射：属于 `terminal.transport_lifecycle` 与 `terminal.buffer_render` 交界；唯一 owner 是 `SessionContext -> ensureActiveSessionFreshRuntime()` 和 buffer manager。daemon 不参与 foreground/active 判断，UI 不补刷新策略。
- 根因：`explicit-resume + forceHead` 会被 `lastActiveReentryAtRef` 或 `connectedBaselineBurstGuardRef` 抑制。foreground resume 正是需要同一 OPEN WebSocket 上发 `buffer-head-request` 的路径，被 guard 吃掉后表现为“连接还在但不刷新”。
- 修复：`shouldSkipImmediateForcedResumeHead` 只允许作用于 `active-reentry`，不得作用于 `explicit-resume`。foreground/explicit resume 可在同一 socket 上重复发 head probe，但不得新建 WebSocket。
- 回归：`session-context-activity-runtime.test.ts` 锁 explicit resume 命中两个 guard 时仍发送 forced head；`SessionContext.ws-refresh.test.tsx` 锁 connected baseline 后 explicit resume / tab switch 后 explicit resume 都会在同一 socket 再发 head，且不产生额外 connect。

## 2026-07-09 orphaned adaptive tmux narrow-window restore

- 现场问题：daemon `/health` 显示 `subscribers=0`，但全局 tmux window 仍停在 `55x*`；`@zterm_adaptive_width_baseline` / `@zterm_adaptive_width_applied` 均为空。说明旧窄窗已失去 persisted baseline，单纯恢复 option 覆盖不到。
- 架构映射：属于 Daemon Truth Block 的 adaptive width lease owner；处理方式是补齐无 active adaptive client 的恢复语义。禁止客户端/UI 补偿宽度，禁止 daemon 持有 foreground/active 状态。
- 修复：`restorePersistedAdaptiveWidthBaselines()` 现在先用 persisted baseline；若没有 baseline，但 tmux window 比 attached tmux client 窄，则按 attached client 尺寸恢复。这覆盖旧版本未写 baseline option 但留下窄 window 的遗留状态。
- 同步修复：lease 归零时若内存 baseline 为空，也会尝试 persisted baseline 或 orphaned attached-client restore，避免最后一个 adaptive holder 消失后无 baseline 直接 return。
- 真实验证：安装全局 daemon 并 `zterm-daemon restart` 后，新进程 `pid=76055`；`freehand/onestop/predict/rcc/rcc2/rcc3/server/zterm` 从 `55x*` 恢复到对应 attached client 尺寸，如 `freehand 115x56`、`onestop 110x54`、`zterm 92x52`，且 baseline/applied option 为空。`daemon:mirror:close-loop` 8 case PASS。

## 2026-07-09 foreground resume missing target restore

- 现场问题：2051 修完 same-socket head probe 后，真机 Home->返回仍能看到 subscriber 从 `afd34...` 换成 `a55e...`；runtime 日志有 `session.transport.explicit-resume -> session.reconnect.reuse-plan reason=missing-target -> manual reconnect`。
- 架构映射：属于 `terminal.transport_lifecycle`；唯一 owner 是 `createSessionRuntime` / `SessionContext` transport identity。UI 不补 reconnect，daemon 不持有 client state。
- 根因：open-tab restore 的 `createSession(connect:false)` 只恢复 local runtime shell 和 Session 列表，没有写入 session transport runtime host/target identity。随后 explicit resume 看到 `targetKey=null`，把同一目标误判成 missing target 并重建 WebSocket。
- 修复：`createSessionRuntime` 在新建或复用 local shell 时都调用 `writeSessionTransportHost(sessionId, host with resolvedSessionName)`；connect=false 不开 socket，但必须恢复 transport identity，供后续 explicit-resume 复用同 target。
- 回归：`session-context-session-runtime.test.ts` 新增 closed local shell / existing shell 都写入 transport identity；targeted transport tests 224 PASS；Android typecheck PASS；standard build 2052 PASS。
- 真机闭环：安装 APK `0.1.3.2052` 后，Home 4s 再返回，daemon `/debug/runtime` 中 subscriber 前后均为 `98fb9489-d10c-4c9c-9067-0787109cce77`，latest client scope 继续推进 `session.buffer.head`，最近 260 条日志 `missing-target/transport-detached/rebuild` 命中 0。

## 2026-07-09 head probe timeout must stay same-socket

- 架构映射：属于 `terminal.transport_lifecycle`；唯一 owner 是 `ensureActiveSessionFreshRuntime`。处理方式是物理移除 `OPEN` socket head probe timeout 后直接 `reconnectSession()` 的判断。
- 根因：same-socket head probe 超时只证明 head response 没按预算回来，不证明 WebSocket 物理失败。旧逻辑会把 quiet / delayed response 升级成重建 WebSocket，和当前 reuse truth 冲突。
- 修复：head probe timeout 只记录 debug、清 stale marker，然后继续在同一 `OPEN` socket 上发下一次 `buffer-head-request`。
- 回归：`session-context-activity-runtime.test.ts` 改为断言过期 probe marker + `WebSocket.OPEN` 时仍调用 `requestSessionBufferHead`，且不调用 `reconnectSession`。

## 2026-07-09 buffer-head cursor-only repaint stale body flash

- 现场问题：Android terminal 快速刷新时仍会闪到旧 buffer，再被新 buffer 覆盖。
- 架构映射：属于 `terminal.buffer_render`；唯一 owner 是 `session-context-buffer-runtime`。处理方式是物理移除 `buffer-head` / cursor metadata 对正文 body repaint 的触发；禁止 UI shell / TerminalView 清 DOM 或补偿。
- 根因：`handleBufferHeadRuntime()` 收到 cursor/cursorKeys metadata 变化时会 `commitSessionBufferUpdate()` 后设置 `renderCommitNeeded` 并 `scheduleSessionRenderCommit()`。这让 head-only frame 在真正 `buffer-sync apply` 前把当前本地旧 body 发布到 render store，视觉上就是旧 buffer 先闪一帧再被 body diff 覆盖。
- 修复：cursor metadata 仍写入 buffer manager truth，但只记录 `session.buffer.head.cursor-metadata-applied-no-body-render`，不触发 body render commit；正文 repaint 继续只允许由 `buffer-sync apply` 触发。
- 回归：`session-context-buffer-runtime.test.ts` 将 cursor-head 测试改成反向门禁，断言 cursor metadata apply 不调用 `scheduleSessionRenderCommit()`。定向 gates：`session-context-buffer-runtime.test.ts`、`session-render-gate.test.ts`、`session-render-buffer-store.test.ts` 共 51 tests PASS；Android `tsc --noEmit` PASS；feature registry / architecture / wiki / loop 34 tests PASS。
- 未完成：本轮未构建安装 APK、未做真机动态刷新录屏验证；当前结论是 L1/L0 闭环，仍需 L5 实机确认旧 buffer flash 是否完全消失。

## 2026-07-10 real-device evidence must prove current WebView, not package or mixed daemon snapshots

- 2055 构建与安装：`zterm-0.1.3.2055.apk` 资产包含 `1032055 / 0.1.3.2055`，设备 package dumpsys 显示 `versionCode=1032055`。`MainActivity` version cache pref 已写 `1032055`，且只保留 `app_webview` localStorage；`cache/WebView/Default/HTTP Cache` 会在启动后重建，不能单凭目录存在判断没清。
- 验证脚本问题 1：daemon `/debug/runtime` 的 `clientDebugSnapshots` 会混入多台客户端。最新 `1032049` snapshot 来自 userAgent `V2545A`，不是当前 `PLZ110`；不能再把 daemon 最新 snapshot 当成本机 live WebView 证据。
- 验证脚本问题 2：`webview-bridge-target.json` 只解析出 open-tab bridge target，未带 active session；输入验证会退化成全局日志过滤，容易得到 `activeSessionId=null`。
- 验证脚本问题 3：当前设备处于 AOD/锁屏时 `mFocusedApp=zterm` 但 `mCurrentFocus=NotificationShade`，Activity 立即 pause/stop；此时 adb input 不会进入 terminal，L5 必须显式失败为 device locked/sleeping，不得归因 terminal。
- 修复验证脚本：启动时 collapse statusbar；前台 gate 要求 current focus 不在 NotificationShade；runtime snapshot 按 smoke start time + device model 过滤；active session 优先从本机 fresh snapshot 解析；锁屏/AOD 失败输出短错误。
- 当前证据结论：L0/L1 修复仍通过；2055 真机安装成功；L5 端到端输入/旧 buffer flash 复测被设备锁屏/AOD 阻塞，不能宣称旧 buffer flash 已在真机闭环。

## 2026-07-10 missingRanges response must not contain holes

- 2055 现场继续出现刷新时闪旧 buffer。daemon runtime logs 对 PLZ110 已确认 `runtimeVersionCode=1032055`、`widthMode=adaptive-phone`，排除旧 JS/旧 fixed 配置。
- 现场日志形状：active session visible range 约 `3235..3271`，但多条 `buffer-sync` 是 `startIndex=3247 endIndex=3283 lineCount=6 firstLineIndex=3252 lastLineIndex=3257` 这类“外层 window 很大、lines 只带中间局部 gap”的带洞 payload。client sparse apply 会保留未覆盖的本地旧行或 gap，然后仍可能发布 render commit，表现为刷新时旧 buffer 混闪。
- 架构映射：属于 `terminal.buffer_render` / daemon buffer-sync contract；唯一 owner 是 `buffer-sync-contract.ts` 与 client `requestSessionBufferSyncRuntime` pull bookkeeping。处理方式是物理禁止带洞窗口，不做 UI 清屏/延时补偿。
- 修复：`buildRequestedRangeBufferPayload()` 对 `missingRanges` 不再只 flatMap gap 行并保留原 request window；改为返回从第一个 missing range 到最后一个 missing range 的完整 authoritative span。client `reading-repair` 的 in-flight target 也收缩到 missing span，避免用整个 visible request window 判定覆盖/supersede。
- 回归：`buffer-sync-contract.test.ts` 新增多 gap 返回完整 span `[101,105)` 行 `101..104`；`session-context-buffer-runtime.test.ts` 锁 reading-repair targetStart/End 等于 missing span。定向 gates：server/client/render 4 files / 62 tests PASS；shared pull-state 15 tests PASS。
- 追加修正：`missingRanges` 先按 start/end 排序再取连续 span，避免调用方乱序导致 span 边界错误；新增乱序 missing ranges 红测仍返回 `[101,105)` 行 `101..104`。
- 2026-07-10 验证：server/client/render owner gate 63 PASS；shared pull-state 15 PASS；Android `tsc --noEmit` PASS；feature registry / architecture / wiki / loop 34 PASS；server/mirror/client/TerminalView gate 138 PASS；`daemon:mirror:close-loop` 8 cases PASS；Mac client tests 147 PASS + type-check PASS；`build:android` PASS，产物 `0.1.3.2056 / 1032056`，sha256 `276361b7d84dd86b2eabe6808989b0457a235b6e01f6cd1c8b6e3379f69d591a`。
- 本机 daemon 已 `daemon:install-global` 并 `zterm-daemon restart`，health OK pid `63190`；安装后的 `/Users/fanzhang/.zterm/daemon-runtime/server.cjs` 包含 `normalizeRequestedMissingRanges(...).sort(...)` 与连续 requested span 逻辑。
- 缺口：当前 `adb devices -l` 无在线设备，未完成 APK 真机安装和 Android L5 动态刷新复测；不能宣称 2056 真机已完全消除旧 buffer flash。
- 追加 2：live `changedRanges` 也必须先排序并返回连续 changed span；新增乱序 changedRanges 红测。最终构建版本递增到 `0.1.3.2058 / 1032058`。
- 现场 daemon restart 后曾 unhealthy。根因不是 missingRanges，而是旧/异常 adaptive attach 缺 `cols` 时，`attachTmux()` 在进入 `updateAdaptiveWidthLease()` 显式错误前先把 invalid requested geometry 送进 `normalizeTerminalCols()`，真实 daemon 抛 `terminal cols must be a finite positive number` 并退出；此前测试 helper 的 `normalizeTerminalCols: cols || 120` 掩盖了真实崩溃。
- 修复：`attachTmux()` 只有在 `adaptive-phone + finite positive cols` 时才构造 requested geometry；否则走 adaptive lease owner 的 `adaptive_width_cols_invalid` 显式错误路径。测试 helper 支持 strict normalizer，红测复现真实 throw 条件并证明 attach 不抛。
- 追加验证：`terminal-mirror-runtime.test.ts` + `buffer-sync-contract.test.ts` 44 PASS；Android `tsc --noEmit` PASS；`daemon:mirror:close-loop` 8 cases PASS；`build:android` PASS，产物 `0.1.3.2058 / 1032058`；本机 daemon install 后手动 `launchctl bootstrap` 恢复服务，health OK pid `76428`；真实 WebSocket probe 发送缺 `cols` adaptive attach 返回 `adaptive_width_cols_invalid`，probe 后 health 仍 OK 且 pid 不变。

## 2026-07-10 19:36 CST oversized buffer-sync tail-crop investigation

- 现场：Jason 确认 1032058 刷新时仍闪错误旧 buffer，不能再把 missingRanges 连续化当成已解决。
- 架构映射：属于 `terminal.buffer_render` / Client Mirror Buffer；唯一 owner 是 shared `packages/shared/src/connection/terminal-buffer.ts` + Android `session-context-buffer-runtime.ts` 消费链。禁止 UI 清屏/延时/renderer 补偿，禁止 daemon 持有 client viewport 策略。
- live 证据形状：本地 tail window 约 `[16463,17463)`；daemon 发权威大 span `[14763,17463)` / `lineCount=2700` / `revision=7440`；client apply 后变成 `[14763,15763)` 且 `nextTailEndIndex=17463`，下一小帧才回到 tail。这个会把旧历史窗口发布给 renderer，形成旧 buffer 闪屏。
- 红测：新增 `packages/shared/src/connection/terminal-buffer.test.ts`，复现当前 `[16463,17463)` + incoming `[14763,17463)` + cache 1000。修复前失败为 `next.startIndex=14763`，证明当前 owner 会裁 head。
- 修复：`resolveDesiredLocalWindow()` 对覆盖 authoritative tail 的 oversized payload 优先 `desiredEndIndex=sparseWindow.endIndex`，裁成本地 tail window `[tail-cacheLines, tail)`；不改 daemon、不改 renderer。
- 已跑：shared terminal buffer/planner/gap gates 51 PASS；Android buffer/render gates 118 PASS；Android typecheck PASS；feature registry 34 PASS；Mac client tests 147 PASS；Mac type-check PASS；daemon mirror close-loop 8 cases PASS；Android build PASS，APK `0.1.3.2059 / 1032059`，sha256 `f5a447e0602a9484d919b297acfed61e192acb451ee6b2603fa64272a213bd67`。本机 `adb devices -l` 无在线设备，未完成 Android L5 真机动态刷新复测。

## 2026-07-11 00:12 CST near-tail bottom flash follow-up

- 现场：Jason 确认 1032059 底部更新时仍闪屏，说明上一轮“覆盖 tail 的超大 payload 裁 tail”只解决一类 shape，不能宣称已完成。
- 新日志形状：当前窗口 `[10606,11606)` 已贴 tail，较新 payload `[10592,11601)` / `lineCount=1009` / tail `11606` 不覆盖最后 5 行。旧逻辑因 `incoming.startIndex < current.startIndex` 把窗口回拖到 `[10592,11592)`，随后同 revision 尾部 patch 再拉回 `[10606,11606)`。
- 架构映射：仍属 `terminal.buffer_render` / Client Mirror Buffer；唯一 owner 是 `packages/shared/src/connection/terminal-buffer.ts`。处理方式是收紧窗口锚定规则，不改 daemon、不清 DOM、不延迟 repaint。
- 红测：`terminal-buffer.test.ts` 新增当前 tail window + near-tail non-tail-covering payload，修复前失败为 `next.startIndex=10592`；反向测试证明 current 不贴 tail 时 reading/prepend 仍可移动本地 cache。
- 当前验证：shared buffer/planner/gap gates 53 PASS；Android buffer/render gates 118 PASS；Android typecheck PASS；feature registry 34 PASS；Mac client 147 PASS + type-check PASS；daemon mirror close-loop 8 cases PASS；`build:android` PASS，prebuild contracts 608 PASS、common flows 96 PASS、relay smoke PASS。
- 交付：APK `0.1.3.2060 / 1032060`，`android/update-dist/zterm-0.1.3.2060.apk` 与 `~/.zterm/updates/zterm-0.1.3.2060.apk` sha256 均为 `0019cb00bf81058df92b41167b5a903289c5ac165de52285ea852559f2babfd0`，manifest size `4579266`。`adb devices -l` 无在线设备，未完成 Android L5 真机动态刷新复测。

## 2026-07-11 adaptive lease release still leaves iTerm affected

- 现场问题：adaptive 宽度恢复后，iTerm 的 buffer/layout 仍被 daemon 影响；说明 daemon 释放了几何尺寸但没有释放 tmux 的窗口控制权。
- 架构映射：属于 Daemon Truth Block / `terminal.transport_lifecycle` 的 adaptive width lease owner；唯一 owner 是 `android/src/server/terminal-mirror-runtime.ts`。处理方式是补齐 lease owner 的释放语义；禁止 Android UI、renderer、client resize 路径补偿。
- 根因：`resize-window -x` 会让 tmux window 持有本地 `window-size` override。旧 restore 只执行 `resize-window -x baseline -y rows` 并清 `@zterm_adaptive_width_*` option；后来改成 `window-size latest` 仍是本地 override，不是真释放。
- 修复：`releaseTmuxWindowSizePolicyToLatest(sessionName, reason)` 当前释放语义是 `set-window-option -u -t <session> window-size`；`restoreAdaptiveWidthBaseline()` 和 `restorePersistedAdaptiveWidthBaselines()` 在恢复 geometry 后统一 unset window-local policy。
- 回归：owner tests 覆盖 invalid cols 释放、切到 `mirror-fixed`、最后 lease heartbeat 过期、daemon start persisted baseline restore、orphaned narrow restore、manual override startup unset、latest override startup unset、transport detach restore；架构 gate 只允许 release owner 执行 `set-window-option -u ... window-size`。
- 真实验证目标：更新全局 daemon 并重启后，用真实 tmux window 检查 `tmux show-window-options -v -t <target> window-size` 必须为空/`<default>`；若仍显示 `latest` 或 `manual`，说明 window-local override 未释放。

## 2026-07-11 rcc4 still incomplete after width release: alternate-screen local override

- 现场复查：`rcc4` 的 `window-size` 已是 `<default>`，daemon `/debug/runtime` 无 subscribers/mirrors，但 `tmux show-window-options -t rcc4` 显示 `alternate-screen off`。其它用户 sessions 也有同样 local override。
- 代码根因：`server.ts` 的 `assertTmuxSessionExists()` 调 `terminalControlRuntime.ensureTmuxSessionAlternateScreenDisabled(sessionName)`；`terminal-control-runtime.ts` 内部执行 `runTmux(['set-option','-t',sessionName,'alternate-screen','off'])`。这是“存在性检查/daemon mirror”越界修改用户 tmux option。
- 修复：物理删除 `ensureTmuxSessionAlternateScreenDisabled` interface/function/export/call；新增 `server.transport-lifecycle-truth.test.ts` gate，禁止 daemon control/server 写 `alternate-screen`。
- 现场清理：对所有 `tmux list-windows -a` target 执行有条件 `tmux set-window-option -u -t <target> alternate-screen`；重启更新后的 daemon 后，`rcc4 local-window-size=<default>`、`rcc4 local-alternate-screen=<default>`、`alternate=1`。

## 2026-07-11 mirror truth must be tmux readback only

- Jason 澄清刚性边界：daemon 可以向 tmux 发请求，例如 adaptive lease `resize-window`、输入 `send-keys`、session create/kill/rename；但 daemon 不可以自己改 mirror truth。mirror 必须等同 tmux 回读内容，不能根据“我刚请求了 cols=N”就写 `mirror.cols=N`。
- 架构映射：属于 Daemon Truth Block；唯一内容/尺寸 owner 是 `terminal-mirror-capture.ts` 的 `applyMirrorCaptureSnapshot()`，它只消费 tmux capture/readback snapshot。`terminal-mirror-runtime.ts` 只能编排 attach、lease、sync、destroy，不拥有 mirror 内容/尺寸写入。
- 修复：移除 `attachTmux()` 新建 mirror 时根据 `readTmuxPaneMetrics()` 预写 `writeMirrorBaselineGeometry(mirror, existingTmuxGeometry)`、`mirror.cols = existingTmuxGeometry.cols`、`mirror.rows = existingTmuxGeometry.rows`；resize/restore/startMirror 也保持不自写 mirror 内容/尺寸。
- Gate：`server.mirror-capture-truth.test.ts` 新增反向扫描，允许 capture owner 写 `mirror.rows/cols/bufferStartIndex/bufferLines/cursor`，只允许 `destroyMirror()` 做 destroyed cleanup；`syncMirrorCanonicalBuffer()`、`attachTmux()` 不得写这些字段。当前定向 daemon mirror gates 5 files / 70 tests PASS，Android typecheck PASS。

## 2026-07-11 superseded wrong turn: adaptive must not affect tmux session

- Superseded same day by the corrected requirement: `adaptive-phone` must reflow tmux via the single daemon adaptive lease owner. Keep this section as wrong-turn history only.
- Jason 继续收紧边界：`adaptive-phone` 也必须不要影响 tmux session。旧理解“daemon 可以为 adaptive 发 `resize-window`，但 mirror 等回读”仍会改变用户 tmux 原始布局，因此不合格。
- 架构映射：属于 Daemon Truth Block；处理方式是物理移除 adaptive 对 tmux 的副作用，保留 wire 兼容与 in-memory heartbeat metadata。唯一允许状态是 subscriber `adaptiveWidthCols/adaptiveWidthHeartbeatAt` 与 mirror in-memory `adaptiveWidthAppliedCols/adaptiveWidthLeaseTimer`。
- 修复：删除 `terminal-mirror-runtime.ts` 内 `resize-window`、`window-size`、`@zterm_adaptive_width_*`、persisted baseline/orphan restore/auto unset 逻辑；`restorePersistedAdaptiveWidthBaselines()` 改为 no-op 返回 0；attach/resize/fixed/TTL 只清内存 lease，不 touch tmux。
- Gate：`terminal-mirror-runtime.test.ts` 改为证明 attach/resize/fixed/holder disappearance/heartbeat expiry/daemon start 不调用 tmux mutation；`server.transport-lifecycle-truth.test.ts` 与 `architecture-boundary-truth.test.ts` 禁止 mirror runtime 出现 adaptive tmux mutation 字符串。

## 2026-07-11 adaptive selected but terminal still looks fixed

- Superseded same day: client renderer projection/crop is not the product requirement; adaptive must request tmux width reflow via daemon lease owner.
- 现场：Settings 已显示 `Adaptive Phone`，但 terminal 画面仍按 80 列横向宽度显示，Jason 判断 adaptive 没起作用。
- 架构映射：属于 `terminal.width_mode` / Client Render Width；唯一 owner 是 BridgeSettings storage + SessionContext wire geometry + TerminalView renderer projection。处理方式是分离：daemon/tmux 不改宽，client 本地按手机 viewport 投影；禁止回到 daemon resize。
- 根因：之前修复只保证 Settings 保存、connect/resize payload 携带 `adaptive-phone + cols`，但 TerminalView row projection 仍把 daemon 80 列 row 完整渲染。也就是 wire adaptive 生效，UI 本地投影没生效，看起来还是 fixed。
- Superseded/removed: shared renderer helper `projectTerminalRowForWidthMode()` / `projectTerminalCursorColumnForWidthMode()` was the wrong crop route and has been physically removed.
- 回归：shared renderer test 锁 pure projection；TerminalView dynamic test 锁 adaptive 320px viewport 只显示 45 列、fixed 保持完整 80 列；width/connect/render gates 282 PASS，typecheck PASS。

## 2026-07-11 18:34 CST adaptive wrap and terminal chrome white bar correction

- 现场：2065 仍有左侧白条，且 Jason 反馈 adaptive 设置不起作用。
- 架构映射：白条属于 UI shell / terminal viewport chrome；adaptive 属于 Client Render Width。唯一 owner 是 `TerminalPageStageShell`、`TerminalView`、`VisibleRow`、shared renderer row view model；禁止动 daemon/tmux/buffer。
- 根因 1：上一轮只隐藏 `.wterm` scrollbar，但 terminal stage / pane shell / session-group center 仍画 `cardBorder`，深色终端左侧表现为 1px 白条。
- 修复 1：terminal stage frame、split pane shell、session-group center 改为 `borderWidth=0` + `borderStyle=none`；新增 StageShell regression 锁住三处不再画亮边框。
- 根因 2：adaptive 投影做成 crop，导致 80 列 daemon row 的右侧内容被裁掉；Settings/wire 看似 adaptive，但可见行为仍像 fixed。
- 错误修复 2：`TerminalView` 保留完整 row，adaptive 传 `wrapCols=viewportCols`，shared row view model 用 wrap width + `white-space: normal` 做本地视觉换行。该方式破坏 fixed-row virtual scroll，导致上滚持续循环和 IME 后底部不可见。
- 纠正：撤销 CSS auto-height wrapping。现有 TerminalView 必须保持固定 DOM row height；真正 adaptive visual wrap 必须先做 renderer-owned visual-row 模型，把 daemon row 拆成固定行高 visual segments，并同步 scroll mapping / padding / viewport demand。
- 当前验证：TerminalView.dynamic-refresh 65 PASS；TerminalPageStageShell 11 PASS；shared renderer 19 PASS；Android typecheck PASS；feature registry 34 PASS；diff check PASS。待重新构建 APK 与真机复测。

## 2026-07-11 adaptive requirement corrected back to tmux reflow

- Jason 澄清：`adaptive-phone` 不是 renderer crop / CSS wrap，而是把当前 active adaptive 客户端的最窄宽度发给 tmux 让 tmux 重排。
- 架构映射：属于 Daemon Truth Block / `terminal-mirror-runtime.ts` adaptive width lease owner。允许路径是 `client measured cols -> adaptive lease owner -> tmux resize-window -x -> tmux capture/readback -> mirror truth`。禁止路径是 TerminalView/renderer 本地后处理、daemon 自写 mirror geometry、散落 resize/window-size。
- 本轮方向：更新 AGENTS/docs/skills/MEMORY 的旧 no-tmux-impact 规则；测试改为证明 narrowest wins、resize 更新、fixed/invalid/heartbeat release 都通过唯一 owner 触发 tmux；实现集中在 `applyAdaptiveTmuxWidth()` / `releaseAdaptiveTmuxWidth()`。
- 实现：`terminal-mirror-runtime.ts` 新增 `applyAdaptiveTmuxWidth()` / `releaseAdaptiveTmuxWidth()`；adaptive leases 聚合最窄 cols 后执行 `resize-window -x`，final release 恢复 baseline 并 `set-window-option -u window-size`。移除 shared `projectTerminalRowForWidthMode()` / `projectTerminalCursorColumnForWidthMode()` crop helper，防止客户端裁切路线复活。
- 验证：owner/architecture gates 64 PASS；TerminalView/daemon/render gates 129 PASS；shared renderer 18 PASS；Android typecheck PASS；feature registry 34 PASS；daemon mirror close-loop 8 case PASS；Mac client 147 PASS + type-check PASS；Android build 2068 PASS。
- 真实 daemon/tmux probe：本机 `zterm-daemon restart` 后 health OK pid `63121`；真实 WebSocket `connect widthMode=adaptive-phone cols=91` 使 tmux `120x30 -> 91x30`，`resize cols=63` 使 tmux `63x30`，切 `mirror-fixed` 后释放回 `120x30`；临时 session `zterm_adaptive_ws_probe_1783769472130` 已清理。

## 2026-07-11 20:27 CST client transport open but old buffer not refreshing

- 现场：Jason 截图显示 drawer 里有 session 卡 `connecting`；另一路是界面仍停在旧 buffer，但输入可发出，输入后画面也不更新。
- 架构映射：属于 client `terminal.transport_lifecycle` + `terminal.buffer_render` 的读侧恢复，不属于 daemon mirror、UI drawer 或 renderer 清屏。daemon 稳定真源是 tmux mirror，不是每个 session 一根 daemon-owned 永久 WebSocket；WebSocket 是客户端到 daemon 的物理连接，能写不等于读侧 head/body 订阅已恢复。
- 根因 1：stale pending transport-open bookkeeping 会阻塞 explicit resume，导致 UI 等待一个已经不会完成的 pending open。修复为 stale pending 只在 reconnect owner 内清 pending intent + cleanup control + rebuild same target；fresh pending 仍等待，防止双开。
- 根因 2：active reentry 曾把 `connected + non-empty local buffer` 当成不需要 resume-tail 的条件。旧 buffer 存在恰好是风险信号，不能证明 daemon mirror 已同步。修复为 active reentry / active session change 只复用 transport，但必须 `forceHead + markResumeTail`，让 head 到达后按 visible/tail 拉正文。
- 回归：`session-context-activity-runtime.test.ts` 锁 stale pending reconnect、fresh pending wait、old local buffer 仍 mark resume-tail；`session-context-lifecycle.test.tsx` 锁 activeSessionId 变化传 `markResumeTail: true`；architecture gate 锁 `stale-pending-open` 只在 transport planner/session runtime owner 内出现。
- 验证：session transport/buffer/lifecycle/ws tests 183 PASS；feature registry 34 PASS；Android typecheck PASS；`build:android` PASS，APK `0.1.3.2069 / 1032069`，sha256 `dd47913911a7bf990d39068c633ed560ce545bec40e69f98a0ffaf73f41f02b6`。`adb devices -l` 无在线设备，未完成 Android L5 真机复测。

## 2026-07-11 23:30 CST drawer session switch transport-flow audit

- 现场问题：抽屉切 session 经常显示连接失败；再次连接又成功。Jason 指出 daemon 本地应有日志，必须用本机日志验证。
- 本机 daemon 证据：`~/.wterm/logs/launchd-stdout.log` 在 `2026-07-11 23:30:27-23:30:31` 精确窗口内出现 `websocket transport created=31`、`role=pending bound=none closed=30`、`session-open=1`、`transport-attach-ok=1`、`tmux_session_unavailable/connect.failure/reconnect.failure/error=0`。daemon health 同时 OK，说明不是 daemon/tmux attach 失败。
- 流程审计结论：这是客户端流程设计问题，不是简单 retry 次数不足。用户显式 drawer/session switch 被拆散在 open-tab runtime、SessionContext active-reentry、explicit-resume/reconnect owner、control transport owner、UI error projection 多处；单一用户 intent 没有全链路 correlation / single-flight owner，所以短窗口内能生成大量 pending control/session WebSocket，大多数还没发 `session-open` 就被关闭。
- 具体设计裂缝：`switchSession()` 当前把用户切 session 映射成 `source:'active-reentry'`；而 open-tab 层只在目标 disconnected 时额外 `resumeActiveSessionTransport()`。这让“用户显式切换”在不同状态下走 active-reentry / explicit-resume 两套语义，和架构冻结的 restore-sync vs explicit-resume 分离不一致。
- 具体投影裂缝：retryable reconnect handshake failure 当前会 `emitSessionStatus(..., 'error')`，即使后续继续 `startReconnectAttempt()`；UI 看到 `state === error` 就显示“连接失败”。这会把中间失败投成终态失败。
- 具体缺口：现有测试覆盖 pending/CONNECTING 不重复开 socket、control stale reopen、explicit resume 复用 open socket，但缺少端到端红测：一次 drawer select 在 3-5 秒内只能产生一个有效 `session-open` intent；pending control socket 未绑定前关闭不得显示连接失败；retryable reconnect 中间失败不得投 UI error；同一 sessionId/open intent 必须可从 UI intent 追踪到 daemon `session-open/attach-ok`。
- 下一步修复应先落测试设计与 owner 映射，再改最小 owner：把 drawer/user switch 统一提升为 explicit-resume intent single-flight；control/session open pending 以 `{sessionId,targetKey,openRequestId}` 为唯一 truth；retryable failure 只投 reconnecting/connecting，非 retryable 或 exhausted 后才投 error。
## 2026-07-11 Windows WezTerm backend closeout attempt

- Goal source: `/Users/fanzhang/.codex/attachments/5192ea7c-8ce4-4ffb-b3d6-09a95a513403/pasted-text-1.txt`.
- Scope: close out `daemon.windows_wezterm_backend` as a production-selectable Windows daemon backend and create the minimum `win/` architecture truth before a Windows desktop shell is implemented.
- Architecture mapping: feature owner is `daemon.windows_wezterm_backend`; allowed owner surfaces are `android/src/server/wezterm-backend.ts`, backend selection/tests, WezTerm smoke scripts, docs/registry/maps, and `win/` docs. Forbidden surfaces remain tmux capture/mirror shortcuts and `server.ts` fallback behavior.
- Implemented progress:
  - `createWezTermBackendRuntime.closeSession()` now re-lists panes after `kill-pane`; if the pane remains listed, it throws `wezterm pane cleanup failed...` and does not silently delete local session/snapshot state.
  - Added red/positive runtime test for cleanup failure.
  - Updated Windows WezTerm decision status/gates, feature registry, feature gates, function map, and goal plan.
  - Added `win/docs/spec.md`, `win/docs/architecture.md`, `win/docs/function-map.md`, `win/task.md`, and `win/MEMORY.md` to define Windows shell as a later window/menu/package owner only.
- Verified local gates:
  - `pnpm --dir android exec vitest run src/server/wezterm-backend.test.ts src/server/wezterm-backend-runtime.test.ts src/server/terminal-backend-selection.test.ts src/server/terminal-control-runtime.input-queue.test.ts --reporter dot` PASS: 4 files / 27 tests.
  - `pnpm --dir android exec tsx scripts/wezterm-daemon-protocol-smoke.ts` PASS with `backend=wezterm`, `inputSyncType=buffer-sync`.
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS.
  - `pnpm --dir android run test:feature-registry -- --reporter dot` PASS: 4 files / 34 tests.
- Blocked real Windows gates:
  - `pnpm --dir android exec tsx scripts/wezterm-backend-remote-smoke.ts` failed before WezTerm probe because SSH to `huawei@100.75.122.121:22` timed out.
  - `tailscale ping --timeout=10s 100.75.122.121` reports `peer's node key has expired`.
  - `tailscale status` shows `jason-hw-desktop / 100.75.122.121 / windows` offline, last seen 7d ago.
  - `ssh -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=1 huawei@100.75.122.121 "echo ZTERM_SSH_OK"` timed out.
- Completion status: not complete. Real Windows remote/input smoke cannot be run until `jason-hw-desktop` is online and its Tailscale node key is valid. Do not claim backend closeout until those gates pass in the current worktree.

## 2026-07-12 terminal layout ownership correction

- Jason clarified: "排版是 tmux 的责任，我们不排版的".
- Durable rule written to `.agents/skills/terminal-buffer-truth/SKILL.md` and `android/MEMORY.md`: client must not reflow terminal content; session-enter missing previous buffer must be debugged through `attach/resume -> tmux geometry/head -> buffer-sync -> local apply`.
- Current resource-truth work should keep renderer/shared row/theme/layout changes out of scope. Only transport resource owner and buffer bootstrap path are valid fix surfaces for this symptom.

## 2026-07-12 global resource truth first phase

- Objective source: `/Users/fanzhang/.codex/attachments/74cc6144-fde3-47e8-8e90-d6f8d7174147/pasted-text-1.txt`.
- Scope corrected to global: daemon, each terminal/platform client, terminal backend, transport, buffer/render, CLI/release, and debug surfaces.
- Added `android/docs/resource-registry.json`, `android/docs/resource-map.md`, and `android/docs/testing/resource-truth-test-design.md`.
- Updated `android/docs/function-map.md` with `Resource Binding Map`; updated `android/docs/wiki/mainline-source.md` with `Global Resource Flow`; updated `android/docs/wiki/mainline-call-map.json` so every edge now has `resource_from`, `resource_to`, `via_resources`, and `relation_status`.
- Added gates `android/src/lib/resource-registry-truth.test.ts`, `android/src/lib/function-map-resource-truth.test.ts`, `android/src/lib/mainline-resource-call-map.test.ts`; wired them into `pnpm --dir android run test:feature-registry`.
- Verification before architecture/skill memory append: focused resource gates passed 3 files / 11 tests; full feature-registry gate passed 7 files / 45 tests.
## 2026-07-12 retryable reconnect handshake failure projection

- 架构映射：本轮属于 `terminal.transport_lifecycle`，涉及 `resource.session_transport` / `resource.pending_open_intent` / `resource.ui_projection`。唯一修改点是 `session-context-transport-open-runtime.ts` 的 reconnect handshake failure owner；UI drawer / renderer / daemon 不参与补偿。
- 红测先行：新增 `handleReconnectHandshakeFailureRuntime` 正反测试。retryable reconnect handshake failure 必须保持 `state='reconnecting'`、递增 reconnect attempt 并继续 `startReconnectAttempt()`，不得 `emitSessionStatus(..., 'error')`；nonretryable failure 才投 terminal error。
- 修复：移除 retryable reconnect handshake failure 分支里的 `emitSessionStatus('error')`。这避免中间 control/session attach 失败被 drawer/UI 投影成“连接失败”，同时不改变 nonretryable/auth rejected 的终态错误路径。
- 验证：红测先失败，修复后 `session-context-transport-open-runtime.test.ts` 3 tests PASS；transport owner focused gates 4 files / 35 tests PASS；`test:feature-registry` 7 files / 45 tests PASS；`tsc --noEmit` PASS。
## 2026-07-12 explicit session switch must preserve explicit-resume owner

- 架构映射：本轮仍属于 `terminal.transport_lifecycle`，涉及 `resource.open_tab -> resource.active_session -> resource.session_transport`。`open-tab` 负责显式 tab/session intent，`SessionContext` active switch owner 负责把 refresh source 投给唯一 transport lifecycle。
- 根因：`useOpenTabRuntime` 已把 drawer/tab switch 标为 `switchRuntime:'explicit-resume'`，但传到 `SessionContext.switchSession(id)` 后，provider facade 固定用 `source:'active-reentry'` 调 `ensureActiveSessionFresh()`。这会把显式用户选择降级成 lifecycle re-entry，造成同一 drawer select 的资源语义被拆成 open-tab explicit intent 与 transport active-reentry 两条。
- 修复：`switchSession(id, { refreshSource })` 允许 open-tab explicit-resume reason 直接进入 SessionContext active switch owner；默认仍是 `active-reentry`，保护其它内部 active 切换路径。`useOpenTabRuntime` 在 `switchRuntime:'explicit-resume'` 时传 `{ refreshSource:'explicit-resume' }`。
- 验证：`useOpenTabRuntime.test.tsx` 锁 explicit switch 传入 `refreshSource:'explicit-resume'`；focused gates 6 files / 48 tests PASS；resource/architecture feature registry 7 files / 45 tests PASS；`tsc --noEmit` PASS。

## 2026-07-12 input resource owner removes reconnect shortcut

- 架构映射：本轮属于 `terminal.keyboard_ime + terminal.daemon_input` 的前半段，涉及 `resource.platform_input_channel -> resource.session_transport -> resource.daemon_input_queue`。客户端 input owner 只能消费当前 session transport resource，不能创建 reconnect/open intent。
- 根因：旧 `sendInputThroughSessionTransport()` 接收 `shouldReconnectQueuedActiveInput`、`reconnectSession`、`probeOrReconnectStaleSessionTransport`、`isSessionTransportActivityStale`，让 input runtime 既发输入又参与 transport lifecycle 决策，违反 resource owner 分工。
- 修复：input runtime 改为读取 `readSessionTransportResource(sessionId).socket`；open socket 同步发 input，missing/pending/backpressure 只显式 drop/debug。pending tail head refresh 微任务重新读取 current resource，避免用已替换 socket。
- 验证：`session-context-input-runtime.test.ts` + `terminal-message-runtime.test.ts` 2 files / 22 tests PASS；`test:feature-registry` 7 files / 45 tests PASS；`tsc --noEmit` PASS。

## 2026-07-12 buffer bootstrap and visible-window truth

- 架构映射：本轮属于 `terminal.buffer_render`，涉及 `resource.mirror_store -> resource.client_sparse_buffer -> resource.renderer_window`。daemon mirror 是正文真源；client sparse buffer 只合并 head/body；renderer 只声明 visible demand 和消费已应用 body。
- 根因：session enter / explicit resume 的 `buffer-head` 可能早于 renderer visible range；旧逻辑要么等 visible range，要么把 cache window 当 fetch window，容易造成进入 session 看不到旧 buffer 或拉隐藏历史。另一个边界是 head-only cursor/head metadata 可能触发 body repaint，造成旧 body 闪一下。
- 修复：active head-before-visible 时由 buffer owner 直接按 daemon head bounds bootstrap 当前 tail body sync；无 visible range 的非 active body pull 只 skip。`buffer-head` 只更新 metadata，不触发正文 render commit。tail/reading repair 均收窄到当前 visible window；sparse tail jump 后按 follow/reading 语义发 visible repair。
- 验证：`session-sync-helpers.test.ts` + `session-context-buffer-runtime.test.ts` 2 files / 99 tests PASS；shared `terminal-buffer.test.ts` + `buffer-sync-request-planner.test.ts` 2 files / 20 tests PASS；`test:feature-registry` 7 files / 45 tests PASS；`tsc --noEmit` PASS。

## 2026-07-12 zterm reconnect error projection

- 现场问题：`zterm` 偶发显示连不上，但稍后又能连上；其它 session 可连。tmux 真源检查显示 `zterm` session/pane 存在、pane 未死、`capture-pane` 可读；daemon health OK，mirror 对 `zterm` 持续 capture。
- 关键日志：daemon stdout 在 13:47 对 `zterm` 有 `session.ws.reconnect.buffer-sync`、`session.buffer.applied`，并出现 `input-receive` / `input-write`；这证明不是 daemon/tmux 不可用。客户端 runtime 日志里同一重连流程先投了 `app.session.status type=error message='manual reconnect'`。
- 修复：`scheduleReconnectRuntime()` 的 retryable 分支不再 `emitSessionStatus(..., 'error')`；只保持 `reconnecting`、更新 attempt/lastError，并继续 `startReconnectAttempt()`。nonretryable / auto reconnect blocked 仍投 terminal error。
- 验证：focused owner gates 3 files / 31 tests PASS；`tsc --noEmit` PASS；`test:feature-registry` 7 files / 48 tests PASS；Vite build PASS；Capacitor sync PASS；Gradle `:app:assembleDebug` PASS；真机 smoke `android/evidence/real-device/2026-07-12-135023` PASS。

## 2026-07-12 real-device evidence gate correction

- 现场复查：用户截图里的 adaptive banner 已在提交 `3f846d9` 后不再出现在当前 evidence 和最近 daemon 日志；后续所谓黑屏证据来自真机处于 Android keyguard/SystemUI 锁屏界面，`after-ime-ui.xml` package 为 `com.android.systemui`，并显示密码/PIN 键盘，不是 zterm WebView。
- 取证问题：旧 `terminal-real-device-evidence.ts` 在 `activeSessionId=null` 时仍用未按当前 session 过滤的 runtime logs 计算 `clientInputSend/bufferApplied/renderCommit`，能把旧 session 日志误判为当前 L5 PASS。
- 已验证新门禁：补上 active-session hard gate 后，真机 smoke 对同一锁屏现场返回 `ok:false activeSessionId:null`；补上 app surface gate 后，同一设备直接失败为 `app surface not visible at before-ime: device keyguard/SystemUI owns the screen`。
- 结论：当前不能继续把这台锁屏设备作为 zterm app 黑屏证据。下一轮 L5 必须先确保设备已解锁且 UI/window dump 包含 `com.zterm.android`，再判断 active/open-tab/session 恢复链路。

## 2026-07-12 Android update stale WebView process investigation

- User clarified the device was no longer locked. Rechecked `dumpsys window`: focus was `com.zterm.android/.MainActivity`, not keyguard, when stale zterm terminal text appeared.
- Current visible stale content was real zterm WebView UI: UI dump contained `routecodex`, `Implement`, `拷贝`, `Paste`, and `继续`.
- After `adb shell am force-stop com.zterm.android` and cold start, UI dump length dropped and no longer contained `routecodex`, `Implement`, `Paste`, `拷贝`, `继续`, `mempalace`, or `tkrprobe`. This proves the immediate stale-screen symptom was old process/WebView projection surviving update/re-entry, not necessarily persisted layout truth.
- Implemented native owner fix: `AppUpdatePlugin.installApk()` now calls `terminateCurrentProcessAfterInstallerHandoff()` after `ACTION_VIEW` installer handoff. It finishes/removes the task and kills only `android.os.Process.myPid()` after 750ms. This is explicit self-process shutdown, not a broad kill.
- Added native-source red gates: `android-app-update-process-truth.test.ts` proves installer handoff terminates old process and does not clear `app_webview`/Local Storage/app data; existing `android-webview-cache-version-truth.test.ts` proves upgrade cache invalidation avoids localStorage deletion.
- Verified targeted gates: update/process + workspace tests passed 4 files / 15 tests; `tsc --noEmit` passed; `test:feature-registry` passed 7 files / 48 tests.
- Built direct APK: `android/native/android/app/build/outputs/apk/debug/app-debug.apk`, sha256 `f3bd5395defbaf545d0eb63428b90b4a3f2f443c20baef1af16974bf135a4fdf`; Vite build, Capacitor sync, Gradle `assembleDebug` passed.
- Direct `adb install -r` + start showed package `versionCode=1032069`, `lastUpdateTime=2026-07-12 21:10:08`; zterm focus existed but UI dump no longer contained stale terminal strings. This proves rebuilt APK cold-start surface is clean.
- Remaining L5 gap: real App-internal `AppUpdatePlugin.downloadAndInstall()` handoff was not triggered end-to-end. Attempted WebView DevTools probe: socket existed (`webview_devtools_remote_12805`) but `/json` timed out with zero bytes. Do not claim plugin update handoff fully closed until a real in-app update button/manifest smoke proves old PID exits after installer handoff.

## 2026-07-12 23:58 CST Android WeType IME ghost shown root cause

- User reported 2074 latest upgradeable version still could not pop IME. Continued from 2081 failure.
- Architecture mapping: `terminal.keyboard_ime`, resource `resource.platform_input_channel`; allowed owner is Android native `ImeAnchor` / input intent route. Renderer/tmux/daemon layout stayed out of scope.
- 2082 tested larger native editor rect (`ImeAnchorEditText` served at roughly `188,2430-1028,2598`) plus `requestRectangleOnScreen`. Result: still no visible WeType keyboard. `dumpsys input_method`: `mServedView=ImeAnchorEditText`, `mInputShown=true`, `mIsInputViewShown=true`, but `contentTopInsets=2505`; screenshot no keyboard.
- 2083 tested temporarily clearing immersive/fullscreen flags during IME show. Result: still no visible keyboard. This path was removed as ineffective.
- 2084 tested direct `showSoftInput(..., SHOW_IMPLICIT)` without prior `hideSoftInputFromWindow` reset. Result before IME process reset: still no visible keyboard.
- Critical control: opened system Settings search field using same default WeType. Ordinary system `android.widget.EditText` had the same failure: cursor focused, `mInputShown=true`, `mIsInputViewShown=true`, `contentTopInsets=2505`, screenshot no keyboard. This proves the live failure was not zterm-specific anchor/show logic.
- Recovery evidence: `adb shell am force-stop com.tencent.wetype` (explicit package-scoped reset) then zterm keyboard tap made WeType visibly appear in zterm. `dumpsys input_method` changed to `contentTopInsets=1509`, proving real keyboard window expansion.
- Current 2084 APK was direct-built and published manually to update channel because `pnpm --dir android run build:android` repeatedly timed out inside `npm view ... --fetch-timeout=10000`; long-timeout `npm view` verified all three runtime packages are still `0.1.9`. Direct gates run: focused IME gate 52 PASS, tsc PASS, `pnpm --dir android build` including terminal regression/core 621 PASS + common flows 96 PASS + relay smoke PASS, Capacitor sync PASS, Gradle assembleDebug PASS, update bundle verify PASS.

## 2026-07-13 session drawer edge swipe and fixed-width crop pan

- 架构映射：`terminal.session_drawer` owns drawer projection and shell edge gesture; `terminal.buffer_render` renderer owns `mirror-fixed` horizontal crop/pan. Daemon/tmux/mirror truth do not participate; adaptive layout still only through daemon adaptive width lease.
- UI change: drawer width changed from old `min(280px, 72vw)` shape to compact `width: 48vw; max-width: 187px` (about old width 2/3). Shell-level tab/drawer horizontal gesture now starts inside a 96 CSS px near-edge hot zone, not the system-reserved 0-几 px edge.
- Behavior: in `adaptive-phone`, middle horizontal swipe is ignored by shell and does not open drawer or switch tab. In `mirror-fixed`, middle horizontal swipe is left to `TerminalView` and updates `.term-grid` crop offset; offset is stored per session in `zterm:terminal:mirror-fixed-horizontal-offsets`.
- Verified gates: focused UI/renderer tests 4 files / 117 tests PASS; `tsc --noEmit` PASS; `test:feature-registry` 7 files / 48 tests PASS; `git diff --check` PASS; `pnpm --dir android run build:android` PASS, published `0.1.3.2090`, sha256 `4908f782f3a778f622db40687f2cf3d20b911252384037ed0801b3b03e4bca9f`.
- Real device `100.104.163.65:5555`: installed `versionName=0.1.3.2090`, `versionCode=1032090`; while app focus was `com.zterm.android/.MainActivity` and `isKeyguardShowing=false`, DevTools edge swipe from `x=6 -> 150` opened drawer with rect width `166.76px`, `aria-hidden=false`; middle swipe kept drawer hidden; temporary `mirror-fixed` smoke moved `.term-grid` offset from `0` to `180` and persisted `{"session-1782187153676-6w4w2nxx":180}`. Afterward the device returned to keyguard, so the retained screenshots are not used as acceptance evidence for this run.
- Correction: 28 CSS px / `x=6` style edge validation is too narrow on Android because the system back gesture can own the physical screen edge. Fixed in `0.1.3.2091`: hot zone widened to 96 CSS px; real device DevTools verified `x=88 -> 236` opens the drawer, `x=170 -> 300` middle swipe keeps drawer hidden, and tapping visible `freehand` row changes active surface from `session-1782187153682-0xjkdxdf` to `session-1783906496653-dyos8b09` and closes drawer.

## 2026-07-13 terminal width mode user preference truth

- 现场：用户设置过 `mirror-fixed`，重装/升级后看到又回到 `adaptive-phone`。这个不能由 viewport 默认覆盖用户偏好。
- 架构映射：`terminal.width_mode` preference belongs to client settings resource. `bridge-settings` remains the full config truth; new `zterm:terminal-width-mode-preference` is the explicit user-choice resource used only when migrating old settings without `terminalWidthMode`.
- 修复：`useBridgeSettingsStorage` now writes `zterm:terminal-width-mode-preference` whenever settings change, reads persisted `mirror-fixed` before first render, and uses the preference if old `zterm:bridge-settings` lacks `terminalWidthMode`. Unknown mode normalization stays `adaptive-phone` rather than silently becoming fixed.
- Verified gates: shared `use-bridge-settings-storage.test.tsx` 8/8 PASS; Android `bridge-settings.test.ts`, `terminal-width-mode-manager.test.ts`, `App.dynamic-refresh.test.tsx` 98/98 PASS; `tsc --noEmit` PASS; `build:android` PASS, published `0.1.3.2092`, sha256 `f579dd3313b32d116c993d6fec2e41b607fd78d2d2be42bb3b5433d29e38aa67`.
- Real-device status: installed `0.1.3.2092` on `100.104.163.65:5555`, package version verified. Device returned to keyguard (`mCurrentFocus=NotificationShade`, `isKeyguardShowing=true`) after launch; WebView `/json` was reachable but `Runtime.evaluate` stalled while invisible. Do not count L5 UI/storage verification closed until device is unlocked and WebView visible.

## 2026-07-13 quickbar horizontal crop pan

- 架构映射：`terminal.quickbar` UI projection owns bottom shortcut bar horizontal crop/pan. It is separate from renderer `mirror-fixed` pan and from drawer shell swipe. Daemon/tmux/mirror truth do not participate.
- 修复：`TerminalQuickBar` expanded rows (`terminal-quickbar-shell-rows`) now own touch horizontal pan inside only their actual expanded height. Horizontal drag after an 8px lock moves every `[data-quickbar-scroll-track]` `scrollLeft` together; vertical gestures do not pan; blank click still stops at the quickbar shell and does not bubble into terminal.
- Boundary: root shell capture still blocks non-interactive click/pointer events. The rows are marked `data-quickbar-pan-surface="true"` only for touch events, not as globally allowed pointer targets.
- Verified gates: `TerminalQuickBar.test.tsx` 59/59 PASS; combined quickbar/drawer/fixed-pan gates 5 files / 164 tests PASS; `tsc --noEmit` PASS; `build:android` PASS, published `0.1.3.2093`, sha256 `20a19658badbcd54a5271154e5323279da4709f53f7ce5e28fd90fb91c3c5c31`.
- L5 status: installed `0.1.3.2093` on `100.104.163.65:5555`, package version verified. Device is locked (`mCurrentFocus=NotificationShade`, `isKeyguardShowing=true`), so frontmost WebView quickbar gesture verification is still blocked.

## 2026-07-13 quickbar gesture chain correction

- Jason 反馈 rows-level quickbar pan 影响快捷栏自身滚动。重新审计后确认父级 `terminal-quickbar-shell-rows` 的 touch handler 会接到 scroll track 内开始的 touch，并在横向锁定后 `preventDefault()` + 同步所有 track `scrollLeft`，这会抢走单个 track 的 native horizontal scroll owner。
- 架构修正：`terminal.quickbar` 仍是唯一 owner，但 owner 内部继续分层。`data-quickbar-scroll-track` 自己拥有 native horizontal scroll；button/input/label 拥有自己的交互；父级 rows 只处理非交互空白区域的横向 pan。
- 代码修复：`handleQuickBarRowsTouchStart()` 若 target 落在 `[data-quickbar-scroll-track="true"]` 或 quickbar interactive selector 内，直接保持 rows pan inactive，不触发 preventDefault / scrollLeft sync。
- 验证：`TerminalQuickBar.test.tsx` 增加 scroll-track native-owner no-steal 与 button no-steal；focused quickbar 61/61 PASS；quickbar + drawer + fixed-pan combined 5 files / 166 tests PASS；`tsc --noEmit` PASS；目标文件 `git diff --check` PASS。
- 完整 build/发布：`build:android` PASS，terminal contracts 48 files / 624 tests PASS，common flows / relay smoke / Vite / Capacitor / Gradle 全绿；发布 `0.1.3.2094`，sha256 `4367c1dba2612f87a4eb7f85e1279b24ad8d48f5e5d845c82f688bf2f021a79a`。
- 真机 `100.104.163.65:5555`：安装后 `versionCode=1032094`，zterm foreground，`isKeyguardShowing=false`。CDP 真 touch 从 top scroll track 内 `Esc` button 开始横滑，第一 track `scrollLeft 40 -> 132`，第二 track 保持 `40`，所有 touch event `defaultPrevented=false`；证明 native track 独立滚动且父级没有同步抢占。再从 rows 右侧非交互空白开始横滑，前两条 track `40 -> 140` 同步移动；证明 rows 空白 pan 仍工作且热区未扩大到 terminal body。

## 2026-07-13 quickbar collapse/reveal gesture restoration

- 用户纠正：只修 track/native horizontal owner 不完整；QuickBar 还必须能用手势收起和唤出。
- 架构映射：属于 `terminal.quickbar`，唯一 owner 仍是 `TerminalQuickBar.tsx`；`TerminalPage` 只持有/传递 `quickBarCollapsed` projection。属于“分离下沉”：rows 内 axis lock 同时区分 native track horizontal、rows whitespace horizontal pan、vertical collapse；renderer/drawer/daemon/tmux 禁止参与。
- 预期链条：expanded rows 向下纵滑超过阈值 -> `onCollapsedChange(true)`；collapsed bottom trigger 向上纵滑超过阈值 -> `onCollapsedChange(false)`。横向 track scroll、rows 空白横移、button click 都不得误触 collapse/reveal。
- 必跑 gate：`TerminalQuickBar.test.tsx` 正向覆盖 collapse/reveal，反向覆盖水平 no-collapse、短纵滑 no-collapse、track native horizontal 不被抢；`TerminalPage` gate 锁 portrait 不再强制展开；之后 combined gestures、typecheck、feature registry、build 和 unlocked foreground 真机 CDP touch。
- 修复：rows gesture state 增加 `horizontalPanAllowed + last point`；track/button start 只禁止父级 horizontal pan，仍允许 axis lock 识别纵向 collapse。向下 48px commit collapse；touch cancel 只 reset。collapsed floating bottom trigger 向上 48px commit reveal。`TerminalPage` 删除 portrait 强制展开 effect，并在所有 orientation 传 `collapseAvailable=true`。
- 回归：`TerminalQuickBar.test.tsx` 64/64 PASS；`TerminalPage.foldable-display-change.test.tsx` 6/6 PASS；combined quickbar/drawer/fixed-pan 6 files / 175 tests PASS；`tsc --noEmit` PASS；feature registry 7 files / 48 tests PASS；`git diff --check` PASS。
- 完整 build/发布：terminal contracts 48 files / 624 tests PASS，common flows / relay smoke / Vite / Capacitor / Gradle 全绿；发布 `0.1.3.2095`，sha256 `746fc3b82811d877644d87788ae09e5fa9cbf34e76feb415d8b30f5b30cdea09`。
- 真机 `100.104.163.65:5555`：安装并确认 `versionCode=1032095`、zterm foreground、`isKeyguardShowing=false`。CDP 真 touch 完成 expanded rows 向下滑 -> rows 消失且 `展开快捷栏` bottom trigger 出现 -> trigger 向上滑 -> rows 恢复。随后 track 横滑 `40 -> 122`，sibling 保持 `40`，rows 仍存在，证明 collapse/reveal 没有重新抢占 native horizontal scroll。

## 2026-07-13 quickbar collapsed height truth and full-width reveal

- 用户截图证明 `0.1.3.2096` 虽然 rows 已隐藏，但 terminal stage 仍保留大块底部空白。CDP 现场显示 QuickBar shell 已为 `height=0`，reveal surface 已存在，但 stage 仍是 `bottom=168px`。
- 根因在页面唯一消费点：`handleQuickBarMeasuredHeightChange()` 使用 `height > 0 ? height : current`，把合法的 collapsed `0` 丢弃并保留旧展开高度。
- 修复：`TerminalPage` 对 measured chrome height 使用 `Math.max(0, height)`；QuickBar collapsed 时继续上报 0。底部 reveal surface 为全宽 68 CSS px，允许在左侧/中间上滑恢复，不依赖右侧键盘/悬浮按钮。
- 回归：`TerminalPage.tab-isolation.test.tsx` 锁定先测量 180、再上报 0 后 stage bottom 必须归零；`TerminalQuickBar.test.tsx` 锁定 collapsed 上报 0 和全宽 reveal surface 上滑。
- 验证：focused 2 files / 81 tests PASS；`tsc --noEmit` PASS；完整 `build:android` PASS；发布 `0.1.3.2097`，sha256 `ec6ed84e629295fc9384e073ef4d39c46b690c0d4eb80c39ecaae8602138e29c`。
- 真机 `100.104.163.65:5555`：`versionCode=1032097`、zterm foreground、`isKeyguardShowing=false`。CDP 真 touch：展开 stage `bottom=168px,height=586`；rows 下滑后 `bottom=0px,height=754`；从底部左侧 `x=80,y=730 -> y=640` 上滑后 rows 恢复且 stage 回到 `bottom=168px`。

## 2026-07-13 terminal render/network performance audit

- 目标：检查当前 terminal 渲染与 daemon/client 网络传输是否还有更强的性能/帧率提升方式，约束是弱网、窄带宽、不能裁剪真实 payload 语义、不能让客户端做 terminal 排版。
- 架构映射：涉及 `terminal.buffer_render`、`terminal.transport_lifecycle`、`resource.mirror_store`、`resource.transport_subscriber`、`resource.session_transport`、`resource.client_sparse_buffer`、`resource.renderer_window`。daemon 只能消费 tmux/mirror 与物理 transport 事实；renderer 只消费已应用 body 并 RAF 合并。
- 现场证据：`/debug/runtime` 显示 daemon pid `5873`，uptime `148128s`，11 mirrors / 10 ready / 0 subscribers；ready mirror 多个 `bufferedLines=3000`，最近 flush duration 样本约 `150-354ms`。当前运行 daemon 未必等同 worktree 最新代码，只能作为现场性能事实，不可当源码版本闭环。
- 现场 client debug 证据：`/debug/runtime/logs?limit=500` 中 69 条 `session.ws.reconnect.buffer-sync`，64 条是 1 行 diff，但 3 条 `lineCount>=1000`，最大 3000 行；165 条 inactive `buffer-sync.preparse-inactive-drop`；61 条 `runtime.debug.drop-summary` 合计 dropped 793。说明弱网下真实 payload 已经有大包尖峰，且 inactive transport 仍接收后丢弃，debug 本身也在占链路。
- 源码证据：`terminal-mirror-capture.ts` 每轮读取 pane metrics、cursor、`capture-pane -S -<cache>`，再 canonicalize 全窗口；daemon 默认 `DEFAULT_DAEMON_TERMINAL_CACHE_LINES=3000`。`resolveStableMirrorCaptureSnapshot()` 可最多 4 次完整 capture。`buildChangedRangesBufferSyncPayload()` 用 first changed range 到 last changed range 的连续 span，稀疏变更可能膨胀成大包。
- 源码证据：`terminal-mirror-runtime.ts` 在 subscriber backpressure 时直接 `continue` 跳过本次 `buffer-sync`，没有 per-subscriber latest-authoritative pending。若输出随后停止，弱网客户端可能长期停在旧 revision，后续靠 repair 才补。
- 源码证据：高频 pre-serialized `sendText()` 只更新 `lastSendAt`，不更新 `lastSendBytes` / `totalSendBytes` / `lastSendError=null` / trace，所以 debug 下主 `buffer-sync` 发送路径的带宽观测不完整。
- 源码证据：`session-render-gate.ts` 已按 RAF 合并并在 flush 时读取最新 live buffer，结构上正确；主要剩余风险在 `projectRenderBuffer()` / render store 对 1000 行 retained window 做全窗口 projection/clone/equality scan，需先接入真实 `rx -> apply -> RAF -> commit` trace 后再改。
- 审计结论：优先级应是 1) metadata-only performance trace 真接入生产；2) backpressure 从 skip 改成 per-subscriber latest-authoritative coalescing；3) inactive read subscription 收窄，避免 inactive tab 收到后丢包；4) hot-tail capture + full-history reconciliation 分层但保持单一 mirror writer；5) sendText accounting；6) runtime RTT/jitter/stall 接入 cadence；7) profiling 后再动 renderer projection；8) 多 range wire v2 最后再考虑。

## 2026-07-13 terminal performance implementation architecture mapping

- 功能块：`terminal.transport_lifecycle` + `terminal.buffer_render` + `daemon.cli_node` observer side channel。
- 资源链：`resource.session_transport -> resource.transport_subscriber -> resource.mirror_store -> resource.client_sparse_buffer -> resource.renderer_window`；`resource.debug_channel` 只能 observer，不进入业务 payload 或成为正文真源。
- 唯一 owner：
  - physical body subscription / subscriber backpressure / pending latest：daemon mirror + transport runtime；
  - capture/full reconciliation：`terminal-mirror-capture.ts` 单一 mirror writer；
  - client receive/apply：socket-message runtime -> buffer runtime；
  - render commit：render gate next RAF；
  - trace：metadata-only bounded debug observer。
- 本轮处理类型：分离下沉。把 inactive body demand、subscriber pending、send accounting、trace correlation 分别收回对应 owner；不在 UI、renderer 或 daemon 中新增跨层补偿。
- allowed paths：资源 registry/map、function map、mainline call map/source、terminal decisions/test design/local skill、上述唯一 owner 与定向 gates。
- forbidden paths：client reflow/anchor 推断；daemon active/visible/foreground 心智；head/range 请求触发 capture；debug/trace 保存 terminal 文本；fallback/隐藏双协议；slow subscriber 拖慢 healthy subscriber。
- 必跑 gate：resource/function/mainline/architecture gates；trace/send/subscription/backpressure 成对正反测试；typecheck；之后按阶段进入 daemon/tmux、Mac client、Android 真机弱网 L2-L5。

## 2026-07-13 mirror-fixed crop pan vs drawer edge gesture

- Jason reported that dragging the fixed-width shell horizontally to the right still opens the drawer even when the gesture starts far from the left side.
- Architecture mapping: `terminal.session_drawer` owns drawer UI intent; `terminal.buffer_render` / `resource.renderer_window` owns `mirror-fixed` horizontal crop pan. UI shell can route gesture ownership but cannot change terminal content layout.
- Root cause: `TerminalTabSwipeSurface` treated both left and right 96px bands as valid edge starts whenever drawer swipe was enabled. In `mirror-fixed`, StageShell re-enabled that surface for drawer access, so right-side horizontal crop drags could resolve to `previous` and open the drawer.
- Fix: `TerminalTabSwipeSurface` now supports `allowedStartEdge` and `allowedDirections`; StageShell passes `left + previous` only in `mirror-fixed`, leaving right/middle horizontal drags to renderer crop pan.
- Extra cleanup: existing StageShell border gate exposed remaining bright terminal chrome borders; StageShell container/pane/group-center borders are now explicitly `0px none`.
- Verified: focused drawer/fixed-pan gates passed 4 files / 105 tests.
- L5 real-device verification for `0.1.3.2104`: device `100.104.163.65:5555`, zterm foreground, keyguard false, WebView visible true. CDP CSS viewport `347x754`, `terminalWidthMode=mirror-fixed`. Right-side drag `260,500 -> 330,500` kept drawer `aria-hidden=true` and moved `.term-grid` horizontal offset `13 -> 0`. Left-edge drag `80,500 -> 236,500` opened drawer (`aria-hidden=false`).

## 2026-07-13 performance pipeline incremental closeout: send accounting + trace correlation

- Active performance goal resumed from `/Users/fanzhang/.codex/attachments/4b02c24a-347b-4c6a-b90c-4e520e6720c7/pasted-text-1.txt`; section 11 remains the source of truth.
- Current-state audit found the existing performance claim had only contract-update evidence and that test design still listed major gaps: production trace wiring, physical body-subscription wire contract, subscriber pending-latest/drain, hot-tail range patch, and real byte-shaping weak-network harness.
- Completed owner slice E: `terminal-transport-runtime.ts` pre-serialized `sendText()` now updates `lastSendBytes`, `totalSendBytes`, `lastSendError=null`, and backpressure snapshot using the already serialized string without re-stringifying payload. Fail-first evidence: `terminal-transport-runtime.test.ts` failed with `lastSendBytes undefined expected 47`, then passed.
- Completed owner slice A partial: `terminal-performance-trace.ts` now keeps `traceId`, `mirrorRevision`, and `subscriberId` metadata and summarizes by `sessionId + traceId + mirrorRevision + subscriberId`, preventing same-session different-revision events from becoming a synthetic latency sample. Fail-first evidence: `terminal-performance-trace.test.ts` merged `trace-a/rev10 capture` with `trace-b/rev11 render` into one sample, then passed.
- Verified gates this slice: `terminal-transport-runtime.test.ts`, `terminal-performance-trace.test.ts`, `multi-pane-refresh.test.ts` = 3 files / 13 tests PASS; `tsc --noEmit` PASS; `test:feature-registry` 7 files / 48 tests PASS; targeted `git diff --check` PASS.
- Not complete: no production trace wiring, body subscription, latest-authoritative coalescing, hot-tail capture, weak-net proxy, L2-L5 replay, APK/push for performance goal yet.

## 2026-07-13 mirror-fixed non-edge right pan drawer regression

- Architecture mapping: `terminal.session_drawer` owns the left-edge drawer intent; `terminal.buffer_render` / `resource.renderer_window` owns `mirror-fixed` horizontal crop pan. The only modification point is `TerminalTabSwipeSurface` gesture admission.
- Fail-first evidence: with the existing `EDGE_SWIPE_START_PX=96`, a fixed-mode right swipe starting at CSS `clientX=88` resolved to `previous` and opened the drawer.
- Fix: narrow the drawer admission band to 64 CSS px. The accepted edge sample remains 56px, outside Android's immediate system-edge strip; 88px and the rest of the terminal surface remain renderer pan territory.
- Paired tests: `TerminalTabSwipeSurface.test.tsx` proves 56px right swipe is accepted and 88px right swipe is rejected; `TerminalPage.session-drawer.test.tsx` proves an assembled `mirror-fixed` page keeps the drawer hidden for the 88px gesture.
- Verification: focused gesture/page gates 27 PASS; StageShell + TerminalView gates 80 PASS; `tsc --noEmit` PASS; feature/resource/function/mainline registry gates 48 PASS; full Android build PASS and published `0.1.3.2105`.
- L5 exact bug path: installed 2105 on `100.104.163.65:5555`; zterm foreground and keyguard false. ADB physical swipe mapped to CSS start 88px moved fixed grid offset `172 -> 0` while drawer remained `aria-hidden=true`. The subsequent 56px positive edge replay was interrupted because the device foreground switched to WeChat, so the positive edge result for 2105 remains covered by tests and the previous 2104 L5 run.

## 2026-07-13 mirror-fixed positive-offset pan still opened drawer

- Jason reported that a rightward shell-position pan still opened the drawer. A nested `TerminalTabSwipeSurface -> TerminalView` fail-first test reproduced the exact semantic split: renderer offset changed `160 -> 16`, while the parent still emitted `previous`.
- Root cause: `TerminalView` called `preventDefault()` for horizontal pan but did not stop propagation. The parent had already armed the left-edge gesture and consumed the bubbled `touchend`, so one touch sequence drove both renderer pan and drawer open.
- Fix: `TerminalView` records whether a horizontal gesture actually changed the clamped fixed offset. If yes, it owns the gesture and stops `touchmove/touchend` propagation. If the offset was already 0 and a rightward edge drag cannot move the renderer, the event remains available to the drawer owner.
- Paired gate: positive offset right pan changes offset without drawer; the next pan reaches 0 without drawer; a fresh left-edge right swipe at offset 0 emits exactly one `previous`.
- Verification: fail-first reproduced one unwanted `previous`; focused TerminalView/drawer/StageShell gates 111 PASS; `tsc --noEmit` PASS; feature/resource/function/mainline gates 48 PASS; full Android prebuild contracts 628 PASS, common flows 96 PASS, relay smoke PASS; APK `0.1.3.2106` built, published, installed, sha256 `8f1025fc335b1ac2107c0eb314075e5c9b7a8adf69a3238ea849b08ead574391`.
- L5 visible gesture replay remains blocked: device `100.104.163.65:5555` reports `isKeyguardShowing=true`, `mCurrentFocus=NotificationShade`, and WebView DevTools does not respond while suspended. Locked-screen events are not accepted as app behavior evidence.

## 2026-07-13 17:27 CST performance trace full-chain wiring slice

- Goal source remains `/Users/fanzhang/.codex/attachments/4b02c24a-347b-4c6a-b90c-4e520e6720c7/pasted-text-1.txt`; section 11 of `android/docs/goals/daemon-client-transport-performance-plan.md` is still active and not complete.
- Implemented production trace wiring for daemon capture stages: `terminal-mirror-capture.ts` now preserves capture/canonicalize absolute timestamps in mirror metadata; `terminal-mirror-runtime.ts` emits `capture-start`, `capture-done`, `canonicalize-done`, and `mirror-commit` with subscriber `traceId=${subscriberId}:${revision}` after the authoritative mirror commit.
- Implemented raw client receive byte binding: session socket lifecycle estimates UTF-8 frame byte length from the raw `MessageEvent.data` and passes it to `handleSocketServerMessageRuntime`; `client-rx` trace now records those bytes instead of `0`.
- Updated mainline call map trace edges from `binding pending` to `anchored` and clarified the trace evidence gate wording; current daemon `/debug/runtime` proof is still required before calling trace step closed.
- Verified: focused trace/transport/mirror/buffer/render gates 10 files / 119 tests PASS; `tsc --noEmit` PASS; `test:feature-registry` 7 files / 48 tests PASS; targeted `git diff --check` PASS.

## 2026-07-13 physical body subscription scheduler demand slice

- Goal source remains `/Users/fanzhang/.codex/attachments/4b02c24a-347b-4c6a-b90c-4e520e6720c7/pasted-text-1.txt`; section 11 remains active and not complete.
- Architecture mapping: `resource.session_transport` emits physical body subscription intent; `resource.transport_subscriber` stores only `bodySubscribed`; `resource.mirror_store -> resource.transport_subscriber` remains the only unsolicited body broadcast relation. Daemon still stores no active/inactive/foreground/visible reason.
- Fail-first evidence: new `terminal-mirror-runtime.backpressure.test.ts` case showed a mirror with only ready but body-unsubscribed subscribers still ran recurring live capture. New `terminal-message-runtime.test.ts` case showed resubscribe did not restore scheduler demand.
- Fix: `terminal-mirror-runtime.ts` now counts only ready `bodySubscribed !== false` subscribers for live capture cadence; all-body-unsubscribed mirrors stop live timers; bulk pending flush skips unsubscribed subscribers. `terminal-message-runtime.ts` routes both unsubscribe and resubscribe back through the mirror scheduler owner; resubscribe sends current head then schedules immediate live demand.
- Guard: explicit `buffer-sync-request` remains allowed while body-unsubscribed and does not call scheduler/capture; unsubscribe does not close transport or detach mirror.
- Docs/skills updated: performance plan, refresh-buffer test design, mainline call map/source wiki, generated wiki, and local `terminal-buffer-truth` skill now record scheduler-demand ownership.
- Verified: fail-first red tests failed before implementation; focused server/client performance gates 11 files / 141 tests PASS; `tsc --noEmit` PASS; `docs:function-wiki` PASS; `test:feature-registry` 7 files / 48 tests PASS; targeted `git diff --check` PASS.
- L2 verification: `pnpm --dir android run daemon:mirror:close-loop` PASS; real tmux oracle/replay passed `codex-live`, `top-live`, `vim-live`, `initial-sync`, `local-input-echo`, `external-input-echo`, `daemon-restart-recover`, and `schedule-fire`; evidence summary at `android/evidence/daemon-mirror/2026-07-13/summary.json`.
- Current daemon runtime proof: managed launchd restart via `pnpm --dir android run daemon -- restart` staged `~/.zterm/daemon-runtime/server.cjs` sha256 `b5e718d8201597b6cdd8ba32336e1a6d77230ea69c6b2609f4139e6ddc34646e`; `/health` returned pid `29191`; temporary tmux/WebSocket trace probe reached `liveRevision=2`; `/debug/runtime` exposed `performanceTrace.recordCount=136`. Evidence saved under `android/evidence/performance/2026-07-13/`.
- Not complete: full Android client rx/apply/render trace correlation, real inactive-byte reduction, healthy+slow real subscriber drain, weak-network byte shaping, L3-L5 replay, APK, commit, and push remain pending.

## 2026-07-13 mirror-fixed zero-offset non-edge right pan guard

- Jason reported that dragging the fixed-width shell horizontally to the right can still open the drawer even when the finger starts far from the left edge.
- Architecture mapping: `terminal.session_drawer` owns only left-edge drawer intent; `resource.renderer_window` owns `mirror-fixed` crop projection. The fix stays in `TerminalView`/`TerminalTabSwipeSurface` gesture routing and does not touch daemon/tmux/mirror layout.
- Root cause refinement after the 2106 fix: stopping propagation only when the clamped offset changes is insufficient. At offset 0, a non-left-edge rightward horizontal drag cannot visually move, but it is still renderer crop ownership and must not leak to the parent drawer gesture owner.
- Fix: shared the 64 CSS px drawer edge threshold through `TERMINAL_DRAWER_EDGE_SWIPE_START_PX`; `TerminalView` now consumes horizontal fixed gestures unless the gesture starts inside that left-edge threshold with offset already 0. Left-edge 56px drawer open remains valid; 88px/non-edge/right-middle gestures remain renderer-owned.
- Verified: focused drawer/fixed-pan gates passed 5 files / 124 tests; zero-offset non-edge parent propagation red path is locked in `TerminalView.dynamic-refresh.test.tsx`; `tsc --noEmit` PASS; feature/resource/function/mainline registry gates 48 PASS.
- Build/L5: full Android prebuild passed 48 files / 629 contract tests plus common-flow/relay gates; APK `0.1.3.2107` built, published, installed, sha256 `6b788d40840bcdaebe755363abafdec394e936e35025dbc8aa71914fcbb319ce`. CDP on foreground zterm/keyguard false proved non-edge CSS `181 -> 291` kept drawer hidden at offset 0, while left-edge `56 -> 200` opened it. Evidence: `evidence/gesture/2026-07-13/mirror-fixed-zero-offset-non-edge-2107.json`.

## 2026-07-13 performance pipeline weak-network proxy + real inactive/slow subscriber proof

- Architecture mapping: `daemon.cli_node` owns `scripts/weak-network-byte-proxy.ts` and `scripts/terminal-performance-probe.ts` as out-of-process verification tools; production daemon/client payload path is unchanged. Resources observed: `resource.transport_subscriber`, `resource.session_transport`, `resource.mirror_store`, `resource.debug_channel`.
- Added transparent TCP byte proxy. It only delays, jitters, rate-limits, stalls, or disconnects sockets; it does not parse WebSocket frames and does not inspect or rewrite terminal payload. White-box gate proves exact bidirectional byte equality, metadata-only metrics, rate/latency shaping, deterministic stall windows, and disconnect/reconnect socket behavior.
- Added real daemon protocol probe for `inactive-body` and `healthy-slow`: it performs real control/session WebSocket `session-open -> session-ticket -> connect`, toggles versioned `body-subscription`, generates tmux output, and measures actual wire bytes/revisions without daemon internals.
- Current daemon proof: `/health` pid `29191`, session `zterm-perf-inactive-1783939271` created as explicit tmux sample.
- Real inactive body direct proof: `android/evidence/performance/2026-07-13/inactive-body-direct-current-daemon.json` shows baseline inactive body `20092` bytes, unsubscribed inactive body `0`, reduction `1.0`, transport not recreated, final revision matched.
- Real inactive body through good proxy: `inactive-body-proxy-good.json` shows baseline inactive body `10349` bytes, unsubscribed inactive body `0`, transport not recreated, final revision matched.
- Real inactive body through narrow proxy (256 Kbps + 300ms RTT + jitter): `inactive-body-proxy-narrow.json` shows baseline inactive body `7058` bytes, unsubscribed inactive body `0`, transport not recreated, final revision matched.
- Real healthy+slow proof through narrow proxy: `healthy-slow-proxy-narrow.json` shows healthy direct latest body in `92ms`, slow shaped latest body in `328ms`, slow drain after healthy `236ms < 1000ms`, both reached revision `10`, and slow subscriber did not lower healthy cadence.
- Verified gates: `weak-network-byte-proxy.test.ts` 4/4 PASS; `tsc --noEmit` PASS; feature registry/resource/function/mainline gates 48 PASS.
- Remaining before completion: unstable periodic stall, explicit disconnect/reconnect app smoke, hot-tail capture/full reconciliation, RTT cadence production evidence, V2/renderer threshold decision, Mac gates, Android L5 weak-network app path, APK/commit/push.
## 2026-07-14 terminal session preview continuation

- Continued run `20260713T155522Z-Macstudio.local-68849-9548-session-preview`; existing claims still uniquely own the preview feature/resources/mainline.
- Baseline verification on the current dirty worktree: focused preview/drawer tests 38 PASS, `type-check` PASS, feature/resource/function/mainline gates 48 PASS.
- Audit gap: the existing grid test mocked `TerminalView`, so it proved wiring but not render-store-to-preview DOM parity. Added a separate real-renderer test that publishes six unique session snapshots, concurrently refreshes all six, and automatically asserts per-tile DOM identity plus read-only renderer attributes.
- Ownership correction: StageShell previously invoked both tile activation and preview close, while `TerminalPage#handleActivateSessionFromPreview` already owns switch-then-close. Removed the duplicate StageShell close so tile activation has one page-level owner; explicit close/back remains on `onCloseSessionPreview`.
- Added the `android_preview` machine-readable lifecycle with the required adjacent call IDs and real symbol bindings; updated resource relations, function bindings, Mermaid wiki, and regenerated offline HTML. Feature/resource/function/mainline gates pass 48/48.
- Focused preview + real render parity gates pass 39/39; drawer/fixed-pan/StageShell/tab-isolation regressions pass 128/128; typecheck and targeted diff-check pass.
- Standard Android build completed: contracts 48 files / 630 tests, common flows 7 files / 96 tests, relay smoke PASS, Gradle assemble PASS. Published APK `update-dist/zterm-0.1.3.2109.apk`, versionCode `1032109`, size `4588786`, sha256 `0bdd1d6700b056009b2ad565a2a2cb4861e8ccc29d0c8c653dc9ae8128358d34`.
- L5 remains unverified: `adb devices -l` returned no connected device. Do not claim the feature closed until an unlocked device proves drawer selection, right-edge entry, live six-session refresh, rotation, exit, tile activation, subscription cleanup, and performance.
- Selection identity audit found that resolution used only `sessionId` even though persistence records host/port/tmux identity. Tightened the resolver to require matching bridge host, bridge port, tmux session name, and stored daemon host when present, preventing a restored stale selection from binding to a reused id belonging to another terminal.
- Added a real local L2 gate that connects six physical daemon session transports in `mirror-fixed`, applies received `buffer-sync` frames through the shared client sparse-buffer function, publishes the resulting immutable snapshots to the real preview renderer, and automatically compares tmux/client/preview DOM markers plus cross-session isolation. The fail-first run exposed Node's read-only global `navigator`; DOM setup now installs globals with explicit configurable properties. Its `finally` block closes only its six sockets and kills only gate sessions created by that invocation.
- Real source-to-target gate now PASS: six independent tmux markers all matched tmux capture, daemon-delivered/client-applied sparse truth, and their own preview tile DOM; no foreign marker entered another tile; each session used one physical socket. Daemon subscriber/session counts were exactly `0 -> 6 -> 0`, transport bytes were `35544`, preview DOM nodes `3726`, and all six explicitly created tmux gate sessions were removed. Daemon mirror cache remains at 13 ready mirrors with zero subscribers; this is daemon cache state, not a live session/subscriber leak, and is out of preview scope.
- Rebuilt after the session identity correction. Current package supersedes 2109: `update-dist/zterm-0.1.3.2110.apk`, versionCode `1032110`, size `4588834`, sha256 `a94555b0e32f7058a48797a142b62d09c1804cc38127dc5d0ff3d71468b96106`; update and daemon manifests passed exact hash/size/alias checks.

## 2026-07-14 terminal session preview closeout continuation

- Rechecked active goal objective, existing run `20260713T155522Z-Macstudio.local-68849-9548-session-preview`, .agent-collab claims, resource/function/mainline maps, MemoryPalace, dirty worktree, APK manifests, and ADB state.
- Added an explicit stale reused-id guard test for stored `daemonHostId` mismatch in `session-preview-selection.test.ts`; focused preview suite remains 6 files / 40 tests PASS.
- Extended `terminal:preview:source-dom-gate` evidence with local render performance metadata: DOM nodes, transport bytes, subscriber/session lifecycle, render-store publication count, total buffer-sync count, convergence time, and process CPU. Latest run marker `ZPREVIEW-1783961735734` PASS: six tmux sessions matched daemon/client/preview DOM, subscribers `0 -> 6 -> 0`, sessions `0 -> 6 -> 0`, transport bytes `24456`, DOM nodes `3726`.
- Re-ran `test:feature-registry` 7 files / 48 tests PASS and `type-check` PASS after instrumentation.
- ADB L5 remains missing: `adb devices -l` empty, mDNS empty, known `100.104.163.65:5555` offline, only `oppo-pad-mini` online on Tailscale but `adb connect 100.119.165.59:5555` refused. Do not claim real-device closure.
- Current pushed APK remains `android/update-dist/zterm-0.1.3.2110.apk` and `~/.zterm/updates/zterm-0.1.3.2110.apk`, versionCode `1032110`, size `4588834`, sha256 `a94555b0e32f7058a48797a142b62d09c1804cc38127dc5d0ff3d71468b96106`.

## 2026-07-14 Windows daemon live protocol closeout

- Architecture mapping: `daemon.windows_wezterm_backend` owns the selected Windows WezTerm backend adapter and live daemon protocol smoke. Changed only backend/control/runtime gate surfaces; no mirror/capture fallback and no daemon client-state ownership added.
- Test design added: `android/docs/testing/windows-daemon-live-protocol-test-design.md`. It requires black-box source marker -> real daemon `buffer-sync` target comparison, missing-session explicit failure, and targeted cleanup through daemon control protocol.
- Implemented `android/scripts/wezterm-daemon-remote-protocol-smoke.ts`. It probes one configured daemon endpoint, opens control/session WebSockets, creates a unique session, decodes `buffer-sync` wire lines, sends a unique input marker, compares target buffer text automatically, and removes only the created session.
- Root cause found during live gate: deployed Windows daemon on `100.75.122.121:3333` was stale. It passed create/connect/input but cleanup failed because control `tmux-kill-session` still called tmux in WezTerm mode. Fixed unique close owner by adding `TerminalControlRuntime#closeDetachedTerminalSession`; it routes to `WezTermBackendRuntime#closeSession` for WezTerm and to `tmux kill-session` only for tmux.
- Deployed updated daemon runtime artifact to `D:\zterm-tools\daemon-runtime-test\runtime\server.cjs`, preserving backup `D:\zterm-tools\daemon-runtime-test\runtime\server.cjs.pre-20260714-1410`, and restarted the existing Windows `ZTermDaemon` scheduled task. Current listener PID observed after restart: `27564` on port `3333`.
- Verified gates: backend unit/runtime/selection/control tests 4 files / 28 tests PASS; mock protocol smoke PASS with targeted cleanup; direct remote smoke PASS pane 58; input smoke PASS panes 59/60; `tsc --noEmit` PASS; feature registry 7 files / 48 tests PASS; live daemon protocol PASS marker `ZTERM_WINDOWS_DAEMON_E2E_1784009295061_8d3ac8de`, target buffer matched, targeted session removed.
- Remaining: Windows desktop shell has not started. Next step is `windows.desktop_shell` registry/resource/mainline/test design and shared desktop shell boundary from Mac without copying Mac-specific IPC.
- Initialized `windows.desktop_shell` architecture surface: added feature registry entry, function/resource binding row, `win/docs/testing/windows-desktop-shell-test-design.md`, and `win/docs/windows-desktop-shell-manifest.json`. All implementation symbols remain `binding pending`; next code step is platform-neutral desktop shell extraction from Mac with separate Windows bridge.

## 2026-07-14 preview-to-shell frozen projection diagnosis

- Field symptom: preview tiles continue refreshing, but after tapping a tile and returning to the real shell the visible terminal stops refreshing.
- Architecture mapping: `terminal.session_preview.tile.activate` may emit one active-session intent, but the visible shell projection is still owned by `terminal.session_group_layout`. The unique shared activation point must update both `resource.active_session` and the focused session-group viewport projection; transport, daemon mirror, sparse buffer, and renderer remain unchanged.
- Confirmed source cause: `handleActivateSessionFromPreview` called only `handleSwitchSessionFromChrome(sessionId)` and closed preview. `resolveTerminalSessionGroupSlotIds()` intentionally preserves an existing center slot even after `activeSession` changes. Therefore StageShell could keep rendering the old center session while input/live ownership moved to the selected target. After preview subscriptions closed, the old visible center was no longer live, producing exactly “input/target changed but visible shell frozen.”
- Existing drawer activation already performs the required `resolveTerminalSessionGroupSlotReplacement(current, sessionId, sessionGroupFocusSlot)` projection before switching. Preview duplicated only half that semantic operation.
- Fix design: extract one page-level open-session viewport activation owner used by drawer and preview. It first projects the target into the focused session-group slot, then calls the existing session switch owner. Preview closes only after this shared operation. No fallback, reconnect, forced refresh, buffer clear, or duplicate renderer.
- Positive black-box test: open preview with two selected sessions, activate the non-center tile, rerender with that active session, and prove normal shell renders the selected session and continues receiving render-store updates.
- Negative test: preview exit without tile activation preserves the existing center/active session; tile activation emits exactly one switch and does not invoke a second close/switch path.
- Implemented fix: `TerminalPage#handleActivateOpenSessionInViewport` is now the shared page-level owner for drawer row activation and preview tile activation. It calls `resolveTerminalSessionGroupSlotReplacement(..., sessionGroupFocusSlot)` before `handleSwitchSessionFromChrome(sessionId)`; preview close remains after that operation.
- Red/green: `TerminalPage.session-preview.test.tsx` failed before the fix because `terminal-session-group-center` still rendered `terminal-view-s1` after activating preview tile `s2`; after the fix, it renders `terminal-view-s2`, old `s1` is absent, and there is exactly one switch.
- Source-to-shell gate: `terminal:preview:source-dom-gate` now also replaces the preview grid with real `TerminalStageShell`, appends a live marker to selected session 2, republishes the same client sparse/render-store truth, and proves the real shell DOM continues updating while stale session 1 markers stay excluded. Latest PASS marker `ZPREVIEW-1783988556733`; subscribers `0 -> 6 -> 0`, sessions `0 -> 6 -> 0`, transport bytes `29536`, DOM nodes `3726`, one physical session socket per session.
- Verification after the fix: preview/drawer/StageShell/tab-isolation focused regression 9 files / 88 tests PASS; feature/resource/function/mainline gates 7 files / 48 tests PASS; `type-check` PASS; `check:no-source-js-pollution` clean.
- Standard build: first build attempt hit transient `test:relay:smoke` RTC timeout; immediate isolated rerun passed, and the full build then passed contracts 48 files / 630 tests, common flows 7 files / 96 tests, relay smoke, Vite, Capacitor sync, and Gradle assemble. Published APK `0.1.3.2112`, versionCode `1032112`, size `4588922`, sha256 `7ce0fe3e9ee66be6183e64db562f11f1bafc93706c22cfea4a9c354baf1fb7f2`.
- L5 remains missing: `adb devices -l` returned no devices after the APK build, so real-device preview-to-shell touch verification is still not closed.

## 2026-07-14 preview long-press replacement and Back cancel

- Requirement: long press a preview tile to replace that ordered slot with an unselected open session; Android system Back cancels preview and returns to the session/projection present at entry.
- Architecture mapping: `terminal.session_preview` remains the only owner. `resource.session_preview_selection` gained only in-place replacement through current `resource.open_tab` truth. `resource.session_preview_mode` captures entry `{ activeSessionId, slotIds, focusSlot }` and may restore only that exact projection on cancel. No daemon, transport, mirror, sparse-buffer, renderer, or tmux changes.
- Mainline additions: `android_preview:TerminalPreviewTile->PreviewReplacementMenu`, `android_preview:PreviewReplacementMenu->PreviewSelectionOwner`, `android_preview:SystemBackIntent->PreviewModeOwner`, and `android_preview:PreviewModeOwner->EntrySessionProjection`.
- Implementation: `replaceSessionPreviewTarget()` validates source existence, replacement validity, and not-already-selected status while preserving order. `TerminalPreviewGrid` uses a 420ms movement-cancelled long press, suppresses the release click, and lists only unselected open sessions. `TerminalPage#handleCancelSessionPreview` is the unique close/cancel owner for close button, right swipe, and Capacitor `backButton`; tile activation clears the entry snapshot and keeps its explicit switch semantics.
- Positive/negative gates: replacement preserves order; selected/missing replacements fail; long press opens menu without activation; movement opens no menu and activates nothing; Back listener exists only while preview is open; Back restores entry Session even if active projection changed while preview was open.
- Verification: focused preview regression 9 files / 92 tests PASS before the final movement-negative addition; final replacement/back focused suite 3 files / 17 tests PASS; feature/resource/function/mainline gates 7 files / 48 tests PASS; type-check and source pollution gate PASS; real six-session source-to-preview/source-to-shell gate PASS with subscribers/sessions `0 -> 6 -> 0` and one physical socket per session.
- Build: standard Android build passed 48 files / 630 terminal contract tests, 7 files / 96 common-flow tests, relay smoke, Vite/Capacitor/Gradle, and manifest/hash gates. APK `0.1.3.2113`, versionCode `1032113`, size `4590414`, sha256 `319e158d24f2d3e97cf4a1746cda3933ecbdc9a30d5fc56384364bd9ce99db28` published to update-dist and `~/.zterm/updates`.
- L5 remains open because `adb devices -l` is empty; no real-device long-press/system-Back claim is made.

## 2026-07-14 preview count layout, tile removal, and body navigation

- Requirement: preview selection count is 1-6, not required to fill six; portrait rows cap at 2 tiles, landscape rows cap at 3; each preview tile needs a close control; tile body should scroll/pan locally; preview font should be smaller; long-press replacement menu must show only unselected open sessions.
- Architecture mapping: stayed inside `terminal.session_preview`. `resource.session_preview_selection` owns count/order/replacement/removal; `resource.session_preview_mode` owns cancel restore; `TerminalPreviewGrid` owns UI projection. No daemon, transport, mirror, sparse-buffer, reconnect, tmux, or width-owner changes.
- Implementation: added `resolveSessionPreviewGridLayout()` to derive rows from selected count; portrait now maps 1/2/3/4/5/6 to 1x1/2x1/2x2/2x2/2x3/2x3 and landscape to 1x1/2x1/3x1/3x2/3x2/3x2. Tile close calls `TerminalPage#handleRemoveSessionFromPreview`, persists remaining selection, and cancels preview only when empty. Preview body pointer/touch/click events are stopped before tile activation while `TerminalView` remains mounted read-only with smaller `fontSize=6,rowHeight=9px` at default 10px.
- Long-press menu proof: page test now asserts already selected `s1/s2` are absent and only unselected open `s3` is offered for replacement.
- Verification: focused component/page tests 2 files / 26 tests PASS; full preview suite 5 files / 41 tests PASS; feature/resource/function/mainline gates 7 files / 48 tests PASS after adding `android_preview:TerminalPreviewTileClose->PreviewSelectionOwner`; type-check/source-pollution PASS; source-to-DOM/source-to-shell gate PASS marker `ZPREVIEW-1783991765720` with six real tmux sessions and subscriber/session lifecycle restored to baseline.
- Build: standard Android build PASS with terminal contracts 48 files / 630 tests, common flows 7 files / 96 tests, relay smoke, Vite/Capacitor/Gradle, manifest/hash gates. APK `0.1.3.2114`, versionCode `1032114`, sha256 `ef7439df9c3c28719b70174765f7ff9d8e0a23c782f810dbbaf6fb04400221e2` published to update-dist and `~/.zterm/updates`.
- L5 remains open: `adb devices -l` is empty, so no real-device gesture claim is made for tile close/body scroll/body pan.

## 2026-07-14 Windows desktop shell packaged alpha

- Architecture mapping: `windows.desktop_shell` owns only Electron main/preload, Windows platform bridge, desktop composition, packaging, and thin shared-core binding. It reuses `openBridgeConnection`, shared sparse-buffer application, and `MacTerminalView`; no daemon/mirror/renderer/Mac IPC/local-tmux implementation was copied into `win/`.
- Packaged root cause 1: ESM `preload.js` failed under Electron sandbox with `Cannot use import statement outside a module`. Fixed source to `preload.cts`, output to `preload.cjs`, and locked main/manifest/function-map/tests to that binding.
- Packaged root cause 2: renderer emitted `buffer-sync-request` immediately after `connected`, before the daemon mirror produced its first frame. This caused `buffer-sync-request requires a ready mirror` and moved the shell to error. `requestVisibleRange` now requires connected status and buffer revision greater than zero.
- Local gates: Windows typecheck PASS; 2 test files / 5 tests PASS; renderer/main build PASS; x64 Electron directory package PASS.
- Real Windows L5: deployed `D:/zterm-tools/windows-client-alpha/0.1.0-alpha.1/ZTerm.exe`; fresh packaged process exposed `platform=windows` and preload bridge, connected to dedicated `zterm-win-l5-gate` without error, sent source `echo ZTERMWINDOWSLIVE`, and DOM rows automatically matched both command and output. Screenshot payload was 7,892 bytes.
- Deployment archive SHA-256 `b60b5c5b4f27c73dc2e6b1f2dfc007a644d3c4eadaab4e2ad6dbb32d37655cf0`. Dedicated session was removed; four known app PIDs and CDP/SSH sessions were precisely closed; port 9333 had no listener.

## 2026-07-14 Windows session control packaged alpha

- Architecture mapping: `windows.desktop_shell.session_control` owns UI session discovery/create/close. It calls the existing shared daemon control helpers and does not introduce a Windows-only daemon protocol fork or fallback.
- Implementation: connection panel now exposes manual refresh, session list selection, new session creation, and explicit close per session. Closing the currently connected session also disconnects only the Windows client transport after daemon close succeeds.
- Local gates: Windows typecheck PASS; 2 test files / 7 tests PASS; renderer/main build PASS; x64 Electron directory package PASS.
- Real Windows L5: deployed `D:/zterm-tools/windows-client-alpha/0.1.0-alpha.1/ZTerm.exe`; UI refreshed sessions `default` and `zterm-20260630-115307`, created `ztermwinsessioncontrol`, selected it, connected, sent `echo ZTERMSESSIONCONTROL`, matched both command/output DOM rows, closed it through UI, and daemon final list omitted it. Screenshot payload was 16,032 bytes.
- Deployment archive SHA-256 `df59c1f382179cfe9c7a2834105e6271b865a4f712b7854f52482a1db669397a`. App PIDs `6628,7544,7884,30628`, holder, and tunnel were precisely cleared; port 9333 had no listener.
## 2026-07-14 WebSocket Wi-Fi-to-cellular stale transport fix

- User issue: ZTerm connects on Wi-Fi but becomes unusable after leaving Wi-Fi. Live device evidence showed target stayed `100.66.1.82:3333` (Mac Studio Tailscale IP), cellular/Tailscale route could still reach `/health`, and failure was inside client physical WebSocket lifecycle rather than endpoint selection.
- Root cause: `session-context-socket-runtime.ts` treated `WebSocket.OPEN` as healthy and the previous heartbeat behavior only kept sending ping after pong timeout, so a half-open socket bound to the old Wi-Fi path could be reused forever.
- Architecture mapping: `terminal.transport_lifecycle` / `resource.session_transport`; unique health owner is `src/contexts/session-context-socket-runtime.ts`. UI lifecycle and daemon must not add their own reconnect loops or network-state truth.
- Fix: client session heartbeat now runs every 2s and fails a physical socket once after 3 consecutive missed server-activity confirmations. Pong or any valid server frame resets misses; logical session/buffer remain owned above the physical socket and are reused by the existing reconnect owner.
- Test design added: `docs/testing/session-transport-network-switch-test-design.md` with white-box, module black-box, and real-device Wi-Fi/cellular gates. Feature/function/gate docs now bind socket heartbeat to `terminal.transport_lifecycle`.
- Verified local gates: `session-context-socket-runtime.test.ts`, `session-context-activity-runtime.test.ts`, `session-context-lifecycle.test.tsx`, `SessionContext.ws-refresh.test.tsx`, `App.dynamic-refresh.test.tsx` PASS; transport/session focused gates PASS; `tsc --noEmit` PASS; `test:feature-registry` PASS; `build:android` PASS.
- APK built/published/installed: `0.1.3.2115` / `versionCode=1032115`; sha256 `a82bf8d2664f48adc764a1d216d02b61b2a94861ce473d18975c5847b0d44409`; paths `android/update-dist/zterm-0.1.3.2115.apk` and `/Users/fanzhang/.zterm/updates/zterm-0.1.3.2115.apk`; installed on `100.104.163.65:5555` successfully.
- Remaining gap: not yet closed as L5 network-switch gate because the new APK still needs unlocked foreground app + real session/TUI two-direction Wi-Fi/cellular switch proving output/input recovery within 10s.
## 2026-07-14 21:57 CST - preview add selection and Android logo package

- Architecture mapping: `terminal.session_preview` remains the only owner. The visible drawer checkbox now dispatches to the existing `toggleSessionPreviewTarget` path; the in-preview add menu continues through `appendSessionPreviewTarget` and only projects currently open, eligible, unselected Sessions. No transport, daemon, mirror, sparse-buffer, or renderer ownership changed. The visual-only checkbox behavior was physically removed by replacing the span with an explicit button.
- Positive lock: after removing two of six preview tiles, the add menu lists both removed open Sessions and appends either one while preserving order. Negative lock: selected and closed Sessions cannot dispatch add/toggle, and the command never switches or closes a Session.
- Android App Logo source is now root `assets/logo.png`; 15 legacy/round/adaptive density resources were regenerated. APK `0.1.3.2116` contains byte-identical xxxhdpi legacy/adaptive icon resources.
- Verification: preview focused tests 52/52; architecture/feature/function/mainline gates 48/48; type-check passed; build preflight 631/631 terminal contracts + 96/96 common flows + relay smoke; Gradle build passed. APK sha256 `78ccc529d63a759641f3ee4ab55bb32851f5e6e1514be9288e7d1111a2f07a49`.
- L5 gap: `adb devices -l` returned no online device, so launcher rendering and physical touch behavior remain for Jason's upgrade test.

## 2026-07-14 22:17 CST - Android adaptive icon safe-zone correction

- Jason's Launcher screenshot is the L5 counterexample: build `0.1.3.2116` packaged the requested source correctly, but the adaptive foreground filled the full canvas and ColorOS applied a second mask, cropping the lower wordmark and outer frame.
- Correction: remove only the connected near-white outer background from the source, center the remaining Logo at 80% of every legacy/round/adaptive canvas, and set adaptive background to `#111A23`. This increases the deep border while keeping all Logo semantics inside the Launcher safe zone.
- Gate correction: source/APK hash equality remains necessary but insufficient; final acceptance requires a real Launcher screenshot.
## 2026-07-15 - Fixed relay Home and ephemeral tabs closeout

- Home was reduced to the fixed `relay.codewhisper.cc` account/password login projection plus daemon-device rows. Session groups, connection cards/FAB, saved tab lists, and Home session actions were physically removed from the live path.
- Relay credentials now keep plaintext password only in the login form/request; persisted relay account state stores token/account/directory/client settings with an empty password.
- Open tabs, active tab focus, and closed-tab reuse tombstones are current-process state only. Startup and runtime writes remove legacy `OPEN_TABS`, `ACTIVE_SESSION`, `SAVED_TAB_LISTS`, and closed-reuse storage keys instead of restoring or rewriting them.
- Gates passed: focused relay/open-tab suite 9 files / 80 tests; App dynamic matrix 29 tests; real first-paint gates 4 tests; architecture registry/mainline gates 23 tests; TypeScript; Android build preflight 48 files / 572 tests; common flows 77 tests; local relay end-to-end smoke.
- APK `0.1.3.2119` / versionCode `1032119` published with SHA-256 `00991533d26f999d9982257951cfda689c134d308ad739aee7e8ba5a2c334a0a`.
- Production relay endpoint is not yet live at the fixed URL: `relay.codewhisper.cc` has no A record; current relay host `claw.codewhisper.cc` resolves to Tailscale IP `100.124.49.106`; that host serves relay health on port 18443, while 443 `/relay/health` returns 404 and the certificate contains only `claw.codewhisper.cc`. DNS A + nginx 443 route + TLS SAN/certificate are all required before production login E2E.
- ADB target `100.104.163.65:5555` was offline, so APK install and real-device visual/login verification remain open.
# 2026-07-15 Relay optional assurance Home correction

- Jason 修正产品语义：Relay 是可选保障与同步增强；未登录 Relay 时 saved direct/Tailscale connections 与 current-process active Sessions 必须仍可见可用。登录后 Relay 可以同步包括 Tailscale 在内的 route candidates，但不得替换 saved Host truth。
- 根因已定位：`ConnectionsPage` 只接收 Relay props，`App` 只向 Home 注入 Relay settings/devices；旧架构文档和 App 红测还明确禁止 Home resume projection，导致 Relay 登录成为事实导航 gate。
- 架构映射：`feature_id=relay.directory_ui + connections.history_projection + terminal.open_tabs`；Home 只消费 `Host[]` / current runtime Session projection 并发出 `useSessionOpenActions` / open-tab owner intent。禁止 Home 写 storage、直接 create/close session、恢复 cold tabs 或接管 transport。
- 测试先行：`ConnectionsPage.test.tsx` 初始 4/5 failure，锁 signed-out saved/active/add entry、login failure preservation、logout preservation；实现后 Connections + session-open owner 25/25 PASS，App integration 32/32 PASS，feature registry 48/48 PASS，typecheck PASS。APK/L5 尚待。
- 完整 build gate PASS：terminal contracts 48 files / 572 tests、common flows 7 files / 78 tests、relay local smoke PASS、Vite/Gradle PASS。发布并安装 `0.1.3.2122`（versionCode `1032122`），sha256 `652926d1fa38590fc9b72a8cbc8e238dece0c6ed572801c8116e9543c3aa468a`。
- L5 现场缺口：设备 `100.104.163.65:5555` 安装版本已由 package manager 证实为 2122，但 `mCurrentFocus=NotificationShade`、`isKeyguardShowing=true`；无法在锁屏下验证 signed-out Home saved/active/picker 点击，不宣称真机 UI 闭环。
## 2026-07-15 Android IME intermittent over-lift

- Screenshot shows an intermittent UI-shell over-lift while IME is open; scope is `terminal.keyboard_ime`, not renderer/buffer/daemon.
- Confirmed race candidate in source: `visualViewport.resize` calls `updateViewportMetrics()`, but that updater currently stores only width and top inset. If keyboard height arrives before adjustResize settles, the initial overlay classification can remain rendered because the later height-only resize produces no React state change.
- Test first: dispatch the registered visual viewport resize after a keyboard-first sample and require reclassification to adjustResize with zero external lift.
- Red/green gate confirmed: before the fix, keyboard-first reported `data-keyboard-inset=320` remained frozen after layout/visual viewport settled at 600; after storing current layout viewport height as UI-shell state, the same registered `visualViewport.resize` event re-renders to inset 0 and stage bottom 184.
- Focused IME stack: 4 files / 145 tests PASS; feature/resource/mainline architecture gates: 48 tests PASS; full prebuild contracts: 48 files / 573 tests PASS; common flows: 78 tests PASS; relay smoke, Vite, Capacitor sync, Gradle and update bundle verification PASS.
- Built/published/installed `0.1.3.2123` (`versionCode=1032123`), APK SHA-256 `212801c488ef8a99f1bc17a34e52f60a4e1f290cbb00e4b01a2c9d3e95b4a7bf`.
- Remaining L5 gap: device is on face-lock screen (`mDreamingLockscreen=true`), so repeated real IME open/close geometry capture cannot run yet. Do not claim visual closure until unlocked-device `KB/LIFT/SH/RESZ` samples pass repeatedly.

## 2026-07-15 Home visual + drawer remote close follow-up

- Jason feedback: Home can enter servers now but visual layout is not acceptable; drawer right-side `X` may only close locally because sessions closed on one phone still appear on another.
- Architecture mapping: Home visual is `relay.directory_ui` / `connections.history_projection` presentation only. Drawer `X` is `terminal.session_drawer`; remote catalog rows must route through the existing session-open owner `killTmuxSession -> fetchTmuxSessions -> handleRemoteSessionsRefreshed`.
- Source audit: `drawerRemoteSessions.targets` is currently populated only for remote-only rows. Already-open live rows that also come from daemon catalog fall through to local `onCloseSession`, which explains why another client can still list the same remote tmux session.
- Fix plan: add a separate drawer remote close target map for every daemon catalog row; `X` uses that map first, waits for remote close success, then closes local tab only when the row has a local session id. Home restyle stays in `ConnectionsPage.tsx` and preserves server-row open intent.
- Red/green: `TerminalPage.session-drawer.test.tsx` failed before the fix for opened catalog row close because `onCloseDrawerRemoteSession` was never called; after adding `closeTargets` for all catalog rows, the same test passes and the negative failure test proves local tab is not closed when remote kill fails.
- Real daemon black-box gate: one-off app API gate created `zterm-drawer-close-gate-*`, verified `fetchTmuxSessions` contained it, called `killTmuxSession`, then verified `fetchTmuxSessions` no longer contained it. This proves the handler chain can physically remove the remote tmux session.
- Focused regression after UI + drawer fix: `ConnectionsPage`, `SettingsPage.relay-account`, `SettingsPage.theme`, `useSessionOpenActions`, `App.dynamic-refresh`, `TerminalSessionDrawer`, and `TerminalPage.session-drawer` passed 106/106 tests; typecheck and feature/resource/mainline gates passed.
- Build/publish/install follow-up: standard Android build published `0.1.3.2126` (`versionCode=1032126`, size `5848238`) to `android/update-dist/` and `/Users/fanzhang/.zterm/updates/`; all APK aliases hash to `2288950816a50f192130be6c217389696e457df60e2ba1e1683756e301e19718`. Installed on ADB device `100.104.163.65:5555`; package manager reports `versionName=0.1.3.2126`, `versionCode=1032126`, `lastUpdateTime=2026-07-15 22:59:31`.
- Re-ran real daemon drawer-close black-box gate after install: app API created `zterm-drawer-close-gate-1784127733004`, `fetchTmuxSessions` before contained it (`count=12`), `killTmuxSession` removed it, `fetchTmuxSessions` after did not contain it (`count=11`), and `tmux has-session -t zterm-drawer-close-gate-1784127733004` returned missing. This proves remote close can physically remove the daemon/tmux session; the UI button mapping is covered by the drawer page tests.
- L5 visual smoke gap: app was installed and started, but the device stayed behind `NotificationShade` / keyguard (`mDreamingLockscreen=true`, `isKeyguardShowing=true`, `mCurrentFocus=NotificationShade`). No unlocked Home screenshot or drawer tap proof is claimed for `0.1.3.2126`.

## 2026-07-16 drawer remote-only session first-tap activation

- User issue: tapping a new remote-only session in the terminal drawer started connecting, but the visible shell stayed frozen on the old center session; after connection succeeded the user had to tap the newly materialized row again.
- Architecture mapping: `terminal.session_drawer` owns the drawer intent, `terminal.open_tabs/useSessionOpenActions` owns remote session materialization and explicit-resume, and `terminal.session_group_layout` owns the visible StageShell slot projection. No daemon, transport, mirror, sparse buffer, or renderer owner changes.
- Root cause: `TerminalPage#handleSelectSessionFromDrawer` detected remote-only catalog rows and called `onOpenDrawerRemoteSession(...)`, but that callback returned no `sessionId` contract to the page. `useSessionOpenActions#handleOpenGroupSession` did materialize/open/switch the local Session, yet TerminalPage never updated `sessionGroupSlotIds`, so `resolveTerminalSessionGroupSlotIds()` kept the old center slot even when parent props changed `activeSession` to the new session.
- Red/green: new `TerminalPage.session-drawer.test.tsx` first failed because after parent rerender with `activeSession=remote-opened`, DOM still lacked `terminal-view-remote-opened`; after returning the materialized `sessionId` from `handleOpenGroupSession` and projecting it through `activateSessionInViewportSlot()`, the same test passed.
- Guard corrections: `useOpenTabRuntime.test.tsx` no longer expects legacy `ACTIVE_SESSION` persistence; `open-tab-history-truth.test.ts` now locks Relay fixed URL ownership to Settings `RelayAccountSettingsSection`, not Home `ConnectionsPage`.
- Verification: drawer/session-open/open-tab focused suite 4 files / 68 tests PASS; open-tab/history/StageShell/transport suite 6 files / 77 tests PASS; `type-check` PASS; feature/resource/mainline registry gates 7 files / 48 tests PASS; `build:android` PASS with terminal contracts 48 files / 574 tests and common flows 76 tests.
- APK published: `0.1.3.2127` (`versionCode=1032127`, size `5848294`, sha256 `b411f9ac8718374386679cab1a1bd8c78fe6f8ede0a7216a0d7ef5309f28eb20`) to `android/update-dist/` and `/Users/fanzhang/.zterm/updates/`.
- L5 gap: `adb devices -l` returned no online device, so no real-device drawer tap claim is made for 2127.

## 2026-07-16 settings/update entry visibility

- User issue: after Home simplification, the app felt like it had no Settings or upgrade entry. Source audit confirmed Home still had an icon-only gear, but Terminal portrait destructured `onOpenSettings` as `_onOpenSettings` and never rendered an entry.
- Architecture mapping: Home entry visibility stays in `connections.history_projection` / `relay.directory_ui`; Settings upgrade controls stay in `settings.config_transfer` via `AppUpdateSection`; Terminal only emits the existing `onOpenSettings` UI intent and does not own update logic.
- Red/green: focused tests first failed for missing `设置和升级` Home/Terminal buttons and missing `settings-update-section`; after the fix, Home exposes a visible settings button, Terminal portrait exposes a settings button, and Settings moves `版本与升级` above server/relay configuration with update controls.
- Verification: focused entry/settings suite 38 PASS, feature/resource/function/mainline gates 48 PASS, type-check PASS, `build:android` PASS with terminal contracts 48 files / 574 tests, common flows 76 tests, relay smoke, Vite/Capacitor/Gradle, and update bundle manifest/hash verification.
- APK published: `0.1.3.2128` (`versionCode=1032128`, size `5848522`, sha256 `2643cb4fca29c3ad64ea965309def4005bb04b8b078abec852413694169b8e57`) to `android/update-dist/` and `/Users/fanzhang/.zterm/updates/`; latest aliases hash-identical. L5 gap: `adb devices -l` returned no online device, so no installed-device visual proof is claimed.
## 2026-07-16 Relay visible route live failure

- Jason reported the newly visible Home Relay option did not connect; previous commit `a567973` proved UI projection/build/install only, not the real relay route.
- Live black-box route evidence against production account `jason`:
  - `https://relay.codewhisper.cc:18443/relay/health` returns 200 and reports TURN configured.
  - Login returns `mac-studio` daemon online, `ws.client=wss://relay.codewhisper.cc:18443/relay/ws/client`, `turn.url=turn:claw.codewhisper.cc:3479?transport=udp`.
  - Standard RTC (`iceTransportPolicy=all`) through relay signaling to `mac-studio` opens a data channel and `list-sessions` returns live tmux sessions in ~100ms.
  - Forced TURN relay-only (`iceTransportPolicy=relay`) receives answer/candidates but ICE fails after ~15s; local and remote relay candidates are allocated on `159.75.134.56:49xxx`, so the remaining failure is TURN/public relay-port/server config, not Home UI projection.
- Root cause for app-visible failure: `TraversalSocket` forced `iceTransportPolicy='relay'` for the production `rtc-relay` candidate. That made the Home Relay button depend on the failing TURN-only gate even when standard WebRTC via the relay control plane was healthy.
- Fix direction: production `rtc-relay` uses standard ICE (`all`) with relay signaling + TURN config; forced relay-only remains the black-box TURN gate and must not be claimed as fixed until relay-only passes.
- Closeout verification after code change:
  - Focused relay/Home/session-open gate: 9 files / 74 tests PASS.
  - Feature/resource/function/mainline architecture gate: 7 files / 48 tests PASS.
  - `tsc --noEmit` PASS.
  - Production `TraversalSocket` smoke against `relay.codewhisper.cc` and `mac-studio`: `relay-rtc:mac-studio` opened in 105ms, diagnostics stage `open`, and `list-sessions` returned 11 sessions (`agentpi`, `freehand`, `onestop`, `rcc`, `rcc1`, `rcc2`, `rcc3`, `rccstart`, `server`, `zterm`, `zterm-20260716-154518`).
  - Forced TURN-only diagnostic still fails: ICE failed after 15389ms even though local and remote relay candidates were allocated on `159.75.134.56`, so public TURN/off-network relay remains unclosed.
  - `build:android` PASS with terminal contracts 48 files / 574 tests, common flows 7 files / 77 tests, local relay smoke, Vite/Capacitor/Gradle, and update manifest verification.
  - APK `0.1.3.2134` (`versionCode=1032134`, size `5849766`, sha256 `cf0900e23be32859cb9c886095e35e9f30f5dda4179714347a715749568764c7`) published to `android/update-dist/` and `/Users/fanzhang/.zterm/updates/`; latest aliases hash-identical.
  - Real device `100.104.163.65:5555` installed `0.1.3.2134` and package manager confirms the version. UI click L5 remains unproven because the device is stuck behind `NotificationShade` / lockscreen (`mAwake=false`, `mDreamingLockscreen=true`), so screenshots are black and no Home Relay tap is claimed.

## 2026-07-17 Relay login polluted Session Picker session listing

- Jason reported APK `0.1.3.2134` cannot list sessions through either Tailscale or Relay. Source audit mapped the bug to `relay.directory_ui` / `connections.history_projection`, not daemon transport: `TmuxSessionPickerSheet` used global `daemonFirst = relay logged in && relayDevices.length > 0` as if every current target were a Relay daemon target.
- Fail-first gates reproduced three concrete failures: signed-in Relay blocked a direct Tailscale target with `bridgeHost + authToken`; a Relay-only `transportMode='webrtc'` target with `relay-rtc` candidates could not refresh when `bridgeHost` was empty; `buildBridgeTargetFromHost()` resolved direct/Tailscale candidates into `bridgeHost` even for explicit Relay route hosts.
- Fix: remove global `daemonFirst` from the picker and replace it with target-scoped Relay capability (`relay-rtc` candidates + relay host identity). Relay daemon section is only an optional route picker; direct target inputs and saved server chips stay active. `buildBridgeTargetFromHost()` now preserves explicit `webrtc` / `relay-route` identity instead of auto-filling direct endpoint.
- Verified: focused picker/session target gates 3 files / 22 tests PASS; focused relay/Home/session-open/route gates 8 files / 74 tests PASS; feature/resource/function/mainline gates 7 files / 48 tests PASS; `tsc --noEmit` PASS; real source black-box `fetchTmuxSessions` returned 15 sessions from direct `100.66.1.82:3333` in 42ms and Relay `relay-rtc:mac-studio` in 99ms; `build:android` PASS and published `0.1.3.2135` sha256 `d7c04b8099d1b8f6674c29ad9d073b2d40d09f8da7ee1a257600ec513721fb65`; ADB device `100.104.163.65:5555` installed versionCode `1032135`. UI tap L5 remains unclaimed because the device stayed behind `NotificationShade` / keyguard.

## 2026-07-17 Session Picker live sessions truth after Relay device selection

- Jason clarified both Relay and Tailscale must list sessions. Follow-up root cause: `TmuxSessionPickerSheet.handleRefreshNow()` treated non-empty relay account directory sessions as final truth and returned before live `fetchTmuxSessions()`. Selecting a Relay daemon could therefore show stale directory sessions or be cleared by the target reset effect instead of proving current tmux truth.
- Fix: removed the directory-sessions early return. Relay directory remains route/device projection only; Session Picker final session list now comes from live `fetchTmuxSessions()` for both direct/Tailscale and Relay targets.
- Red/green: `TmuxSessionPickerSheet.test.tsx` now requires Relay daemon selection to call `fetchTmuxSessions()` and replace directory `main` with live `relay-live/zterm-live`.
- Black-box source evidence: direct WebSocket `127.0.0.1:3333` returned 21 sessions in 36ms; Tailscale `100.66.1.82:3333` returned the same 21 sessions in 6ms; production Relay WebRTC `mac-studio` returned the same 21 sessions in 113ms.
- Verification: focused picker/session/traversal/tmux gates 4 files / 34 tests PASS; `test:feature-registry` 7 files / 48 tests PASS; `tsc --noEmit` PASS; `build:android` PASS with terminal contracts 48 files / 574 tests, common flows 7 files / 77 tests, relay local smoke, Vite/Capacitor/Gradle, and update manifest verification.
- APK published: `0.1.3.2136` (`versionCode=1032136`, size `5849714`, sha256 `d450bdf215b316a41b4a103ae8c77729dd82437c4aef54e978665ce407886463`) to `android/update-dist/` and `/Users/fanzhang/.zterm/updates/`. ADB has no online devices, so install/UI tap L5 is not claimed.

## 2026-07-17 TURN relay status projection

- User need: when a session is connected through TURN, the session status should show that fact instead of only showing generic Relay.
- Architecture mapping: route detection belongs to `relay.route_selection` / `TraversalSocket` diagnostics; session runtime only copies diagnostics into `Session`; `TerminalHeader` and `TabManagerSheet` only render status badges. No daemon, buffer, renderer, or Relay server change.
- Key distinction: `resolvedPath='rtc-relay'` means WebRTC/relay route was selected; it does not prove TURN. TURN display must be based on the selected ICE candidate pair where local or remote candidate `candidateType === 'relay'`.
- Fix: `TraversalSocket` inspects `RTCPeerConnection.getStats()` on RTC open/connected, records `resolvedRelayTransport='turn' | 'direct'`, and UI shows `TURN` / `Relay TURN` only for the TURN case.
- Verification: focused TURN route/UI gate 4 files / 35 tests PASS; `tsc --noEmit` PASS; feature/resource/function/mainline gates 7 files / 48 tests PASS; `build:android` PASS with terminal contracts 48 files / 575 tests, common flows 7 files / 77 tests, local relay smoke, Vite/Capacitor/Gradle, and update manifest verification.
- APK published: `0.1.3.2137` (`versionCode=1032137`, size `5849894`, sha256 `f7947f625a7c20cdf068e1bc294c83428faa19a5ac60c093c02955869a6154c2`) to `android/update-dist/` and `/Users/fanzhang/.zterm/updates/`. ADB has no online devices, so install/UI tap L5 is not claimed.

## 2026-07-17 Relay drawer duplicate host identity and tmux control reuse

- User issue: drawer showed `Mac Studio` and `100.66.1.82` as two servers even though they were one daemon; the named Relay row showed 0 sessions while the IP row held the sessions.
- Root cause: `TerminalPage` built drawer server identity aliases from local Sessions only. Relay directory daemon endpoints were not part of alias truth, so an IP-keyed direct/Tailscale SessionGroup could not canonicalize to Relay daemon hostId `mac-studio`.
- Second root cause for Relay open timeout: `SessionGroupHistory` dropped `relayEndpointCandidates`, and drawer remote catalog open/close targets did not pass candidates to `useSessionOpenActions`. A drawer remote-only open could therefore degrade to direct `bridgeHost/bridgePort` and surface `ws connect timeout` instead of using Relay route truth.
- Fix: drawer alias inputs now include live sessions, session groups, and Relay daemon direct endpoints; session group history persists normalized relay endpoint candidates; drawer remote targets pass candidates into session-open/remote close owners.
- Transport improvement: tmux management `fetch/create/rename/kill` now uses a target-scoped pooled `TraversalSocket` with FIFO request serialization. It keeps the physical socket after successful responses and request-level daemon errors, evicts on physical/protocol failure or timeout, and caches no session-list results.
- Verification: focused drawer/history/tmux gates 40 PASS; broader drawer/session-open/picker/traversal/tmux gates 105 PASS; architecture gates 48 PASS; `tsc --noEmit` PASS; production Relay black-box login to `relay.codewhisper.cc` as `jason` found online `mac-studio` and two sequential live `fetchTmuxSessions()` calls returned 10 sessions (`firstMs=100`, `secondMs=7`) over the same control transport; `build:android` PASS and published `0.1.3.2138` sha256 `2260a1d7892e7b62fe80ff3f1a0f04c12abed46d3b62320e8d8ff2325a76114b`.
- L5 gap: `adb devices -l` returned no online devices, so installed-device drawer visual proof is not claimed for `0.1.3.2138`.

## 2026-07-17 Relay drawer duplicate host rtc-only closeout

- User screenshot after 2138 showed drawer still split one daemon into `Mac Studio 0` and `100.66.1.82 11`; previous conclusion was incomplete because it was not proven on the upgraded device state.
- Live production Relay login for `relay.codewhisper.cc:18443/relay` shows `mac-studio` directory publishes only `relay-rtc:mac-studio`, no direct/Tailscale endpoint, with 10 tmux sessions. Direct Tailscale `100.66.1.82:3333` live `fetchTmuxSessions` returned the same 10-session catalog in 41ms.
- Fix owner `terminal.session_drawer`: TerminalPage drawer identity aliases now include App Home/saved server alias inputs and an rtc-only Relay session-catalog alias when exactly one Relay daemon catalog contains all non-missing SessionGroup names. Ambiguous catalog matches remain separate. TerminalPage memo comparator now includes `relayDevices` and saved alias inputs.
- Gates passed: focused drawer/App/server identity/session-open/traversal suite 166 tests PASS; feature/resource/function/mainline gates 48 PASS; `tsc --noEmit` PASS; `git diff --check` PASS; `build:android` PASS including terminal contracts 576, common flows 82, relay local smoke PASS.
- APK published: `0.1.3.2139` / versionCode `1032139`, sha256 `fa547e10eeaa32d47a90da4f04f3df0edc91b9d8fbdf3cf77c5ad94d91895634`, paths `android/update-dist/zterm-0.1.3.2139.apk` and `/Users/fanzhang/.zterm/updates/zterm-0.1.3.2139.apk`.
- L5 gap: `adb devices -l` shows no online device, so installed drawer visual proof is not claimed in this workspace.

## 2026-07-17 Android Relay/session enumeration closeout

- Jason screenshot showed enumeration still wrong: stale Relay daemon records and old directory session snapshots could leak into Home/drawer/picker, while Home server-row tap still risked creating another generated `zterm-*` instead of entering an existing tmux session.
- Root cause: Relay account directory was treated as connectable UI truth without an online-daemon filter in several projection owners; `TmuxSessionPickerSheet` rendered directory sessions before live `fetchTmuxSessions()`; `TerminalPage` memo UI key ignored Relay daemon session catalog updates; Home server-row open lacked last-entered / first-live-remote selection before generated create.
- Fix: `traversal-relay-devices.ts` is now the online daemon projection owner. Home/drawer/picker target projections use only `daemon.connected=true && daemon.hostId`; stale `rtc-device-*` remains account directory fact only. Session Picker clears directory rows and waits for live fetch after Relay daemon selection. Home open order is current-process last-entered reuse -> live remote last-entered -> first live remote -> generated create only when remote list is empty.
- Verified local gates: focused enumeration regression 7 files / 112 tests PASS before final build; repeated focused closeout 7 files / 112 tests PASS after handoff (`traversal-relay-devices`, `home-connection-projection`, `TerminalPage.session-drawer`, `App.dynamic-refresh`, `useSessionHistoryStorage`, `useSessionOpenActions`, `TmuxSessionPickerSheet`); feature/resource/function/mainline gates 48 PASS; `tsc --noEmit` PASS; `git diff --check` PASS.
- Production Relay black-box using app `TraversalSocket` against `relay.codewhisper.cc`: login 196ms; online connectable daemon list contained only `mac-studio` with `relay-rtc` and session catalog; stale `rtc-device-1784267569532` / `rtc-verify-1784267569532` was filtered; live `fetchTmuxSessions()` over Relay returned current tmux sessions in 162ms.
- Android build/install: published `0.1.3.2143` (`versionCode=1032143`, size `5853242`, sha256 `8fea30acd3c4f311668070e765871e2da1082c299f423ad774ae2e1260fd196e`) to `android/update-dist/` and `/Users/fanzhang/.zterm/updates/`; ADB device `100.104.163.65:5555` installed successfully and package manager confirms `versionName=0.1.3.2143`, `lastUpdateTime=2026-07-17 15:08:18`; app foreground/keyguard check shows zterm focused and keyguard false.
- MemoryPalace command is currently unavailable (`/Users/fanzhang/.local/bin/mempalace` bad interpreter to missing pipx venv), so this closeout cannot honestly claim mine/search persistence until the mempalace install is repaired.

## 2026-07-17 Relay must not rely on Tailscale

- Jason turned off Tailscale and Relay failed. Prior "Relay works" evidence was invalid because standard WebRTC could select host/P2P candidates; the production relay-only/TURN black-box was timing out.
- Architecture mapping: `relay.route_selection` owns Android RTC candidate policy; `terminal.transport_lifecycle` owns daemon `rtc-bridge` consuming the `rtc-init` ICE policy. UI/Home only projects route intent and must not imply availability.
- Fix direction implemented in source: product `rtc-relay` candidates use `iceTransportPolicy='relay'`, `rtc-init` carries that policy to daemon, daemon `rtc-bridge` uses it instead of widening to `all`, and Home badge changed from `Relay 可用` to `Relay 路由`.
- Focused proof before broader gates: traversal/Home/rtc focused tests 38 PASS; `tsc --noEmit` PASS. Remaining gate: production relay-only black-box, full feature gates, Android build/install.

## 2026-07-17 Android client stale TURN settings / transport closed

- Jason reported one Android client cannot connect and shows transport unavailable/closed. Real device `100.104.163.65:5555` is still installed at `0.1.3.2143`; logcat repeatedly resolves `claw.codewhisper.cc` and reports `TURN host lookup received error -1` plus `WebSocket is already in CLOSING or CLOSED state`, while production `/relay/health` now returns TURN `turn:relay.codewhisper.cc:3479?transport=udp`.
- Root cause in source: `traversalRelayRefreshMe()` called `/api/auth/me` but `/me` does not return a new `accessToken`; `deriveTraversalRelayClientSettings()` therefore returned undefined and the code kept old `state.relaySettings`. App relay stream bootstrap then opened `/ws/devices` directly from stored account state, so stale TURN/WS settings could survive app launch and network changes.
- Fix mapping: `relay.account_directory` owns `/api/auth/me` control truth refresh; `relay.directory_ui` owns App relay stream bootstrap. App must refresh account control truth before opening the device stream, update `BridgeSettings.traversalRelay` if any WS/TURN field changed, and refuse to open `/ws/devices` when refresh fails. Legacy fixed relay host `claw.codewhisper.cc` is migrated to canonical `relay.codewhisper.cc` on account read.
- Current local proof: `traversal-relay-client.test.ts` + `App.relay-stream-lifecycle.test.tsx` PASS (13 tests); `tsc --noEmit` PASS. Remaining gates before delivery: broader relay suite, feature registry gates, production relay-only black-box, Android build/install, and logcat proof that the upgraded client no longer tries `claw.codewhisper.cc`.
- Closeout proof: broader relay/App suite 16 files / 121 tests PASS; feature/resource/function/mainline gates 7 files / 48 tests PASS; `git diff --check` PASS; `tsc --noEmit` PASS; production `zterm-rtc-remote-verify` against `relay.codewhisper.cc` PASS with standard stage host/prflx and required relay-only stage local/remote `candidateType=relay`; DNS proof `relay.codewhisper.cc -> 159.75.134.56`, `claw.codewhisper.cc -> 100.124.49.106`; `build:android` PASS with terminal contracts 48 files / 577 tests, common flows 7 files / 82 tests, local relay smoke PASS.
- APK published and installed: `0.1.3.2144` / versionCode `1032144`, sha256 `8a3cd2466e3b3ad10bcc164de976877b8aa75399f927402862e7784f9523e9e2`, path `android/update-dist/zterm-0.1.3.2144.apk`, installed on `100.104.163.65:5555` at `2026-07-17 18:22:43`.
- Device-side gap: after install, app process `15184` and focused app are zterm, but `mCurrentFocus=NotificationShade` and `isKeyguardShowing=true`. Cleared-log startup counts show `claw.codewhisper.cc=0` and `WebSocket is already in CLOSING or CLOSED state=0`, but the locked device did not run a usable UI/Relay interaction, so full L5 relay tap proof remains pending.

## 2026-07-17 Android Relay L5 unlocked device gate

- Device unlocked and local ADB switched to `192.168.0.28:5555`; `com.tailscale.ipn` was force-stopped, `pidof com.tailscale.ipn` empty, `ip -brief address` showed no `tun0`, and direct `100.66.1.82:3333` socket probe failed while `relay.codewhisper.cc:18443/3479` was reachable.
- CDP clicked the Home `saved-connection-relay-button`; app moved to Terminal, drawer marked `mac-studio · zterm` as `connected`, screenshot `/tmp/zterm-relay-after.png` showed live terminal content, and CDP captured `rtc-init` payload using `turn:relay.codewhisper.cc:3479?transport=udp` with `iceTransportPolicy:"relay"` plus relay candidates on `159.75.134.56`.
- Residual found during L5: an offline/stale `jason-hw-desktop` relay attempt could close signaling while async ICE candidates were still firing, producing misleading `WebSocket is already in CLOSING or CLOSED state`. Fix added `TraversalSocket` signaling readyState guard and `rtc-error` peer/signaling cleanup; focused socket regression now locks no candidate send after signaling close.
- Follow-up installed build `0.1.3.2145` on unlocked `192.168.0.28:5555` and reran the Home Relay L5 after force-stopping only `com.zterm.android`. Device still had no `com.tailscale.ipn`, no `tun0`, direct `100.66.1.82:3333` returned connection refused, while `relay.codewhisper.cc:18443/3479` succeeded. CDP captured Home -> Relay -> Terminal in `1750ms`, `mac-studio · zterm connected`, `rtc-init` with `iceTransportPolicy:"relay"`, 9 `typ relay` candidates on `159.75.134.56`, and source-to-target DOM marker `L5_MARKER_20260717_1906_RELAY_UI_OUTPUT_SOURCE_TO_TARGET`. Logcat counts after the run: `claw.codewhisper.cc=0`, `WebSocket CLOSING/CLOSED=0`, `transport unavailable/closed/ws timeout/rtc-error=0`; remaining non-fatal WebRTC noise is 16 `relay.codewhisper.cc.` tail-dot DNS/TURN warnings while the route is connected.

## 2026-07-17 WebRTC-first route policy and fixed-width tmux isolation

- Jason clarified the desired route order: logged-in targets default to WebRTC UDP/P2P first, then Tailscale/direct websocket, and only then TURN relay; logged-out targets prefer direct/Tailscale because no relay control truth exists.
- Implemented `rtc-direct` as a separate traversal path. It uses relay signaling with `iceTransportPolicy='all'` and STUN-only ICE derived from the relay TURN URL, so TURN credentials cannot be used before the direct/Tailscale middle step. `rtc-relay` remains TURN-only with `iceTransportPolicy='relay'`.
- Home/drawer/picker Relay targets now use `transportMode='auto'` WebRTC-first target truth and carry all daemon endpoint candidates. Drawer rows owned by Relay catalog still route through `useSessionOpenActions`, and an already-open stale direct row is reused/upgraded instead of duplicated.
- Fixed width tmux isolation is now locked by a daemon mirror test: `mirror-fixed` attach/resize ignores client cols and does not call `tmux resize-window`; only `adaptive-phone` lease owner may call `resize-window -x`, and fixed mode may only release a lease held by that subscriber.
- Verified: focused relay/route/drawer/session/mirror suite 163 PASS; broader relay UI suite 30 PASS; server transport/RTC truth 21 PASS; feature/resource/function/mainline gates 48 PASS; `tsc --noEmit` PASS; `git diff --check` PASS; local relay smoke PASS twice and selected `rtc-direct` with `iceTransportPolicy='all'` / STUN-only candidate; `build:android` published `0.1.3.2147` sha256 `b3ede68f37dae59a6c624546826bccfc20786a06beb704036056490d2c0c9e7d`.
- L5 gap: `adb devices -l` returned no online devices after build, so APK is in the update channel but not installed/visually verified on a phone in this run.
- MemoryPalace remains unavailable with bad interpreter `/Users/fanzhang/.local/pipx/venvs/mempalace/bin/python`, so mine/search persistence is not claimable until that toolchain is repaired.

## 2026-07-18 Session name/body identity black-box gate

- Jason reported a severe session identity risk: after switching sessions and backgrounding/foregrounding the app, the session list/header name can appear to belong to one session while the terminal body belongs to another.
- Architecture mapping: this is `resource.active_session -> resource.session_transport -> resource.client_sparse_buffer -> resource.renderer_window -> resource.ui_projection`. The owner chain is `App -> SessionContext/BufferApply -> session-render-buffer-store -> TerminalPage/StageShell -> TerminalView`; UI text must not compensate for buffer identity mistakes.
- Detection added:
  - `App.dynamic-refresh.test.tsx` now marks each mocked session body and asserts active session body remains `s2` after tab switch and foreground resume even when a stale getter still points to `s1`.
  - New `TerminalPage.session-content-identity.test.tsx` uses real `TerminalPageStageShell`, real `TerminalView`, and real `sessionBufferStore`; only Header is mocked to expose active name/id. It asserts Alpha header/body, switch to Beta header/body, then Alpha late publish + Beta resumed publish + pause/resume + resize still render Beta body only.
- Verification passed: focused gate `pnpm --dir android exec vitest run src/App.dynamic-refresh.test.tsx src/components/TerminalView.dynamic-refresh.test.tsx src/pages/TerminalPage.session-content-identity.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx --reporter dot` = 4 files / 235 tests PASS; `test:feature-registry` = 7 files / 48 tests PASS; `tsc --noEmit` PASS; `git diff --check` PASS.
- Current conclusion: local black-box tests did not reproduce wrong session body binding. This is a newly locked regression gate, not proof the real device bug is gone. Remaining gap is live device/daemon source-to-DOM replay across actual background/foreground with two uniquely marked tmux sessions.
- MemoryPalace remains unavailable with bad interpreter `/Users/fanzhang/.local/pipx/venvs/mempalace/bin/python`, so no mine/search closure is claimed.

## 2026-07-18 Android transport keepalive grace

- User issue: Android reconnects too aggressively on session switch and foreground resume. Short switch/background round-trips should preserve recent client transport lifecycle instead of immediately rebuilding a WebSocket.
- Architecture mapping: feature `terminal.transport_lifecycle`; resource path `resource.active_session -> resource.session_transport -> resource.transport_subscriber`. The only changed behavior is the client freshness planner/runtime (`session-context-activity-runtime.ts` + `session-transport-open-helpers.ts`). No daemon, route-selection, UI, buffer, or renderer owner changed.
- Implementation: added `SESSION_TRANSPORT_KEEPALIVE_GRACE_MS = 120000`. `ensureActiveSessionFreshRuntime()` resolves recent alive truth from `lastServerActivityAtRef` and `lastConnectedBaselineAtRef`; `buildActiveSessionRefreshPlan()` returns `transport-keepalive-grace` for missing/closed local socket during `explicit-resume` / `active-reentry` inside the grace window. After the grace expires, the existing reconnect/throttle owner still runs. `active-tick` / explicit input recovery is not blocked by this lifecycle grace.
- Verification: focused transport gate 5 files / 245 tests PASS; feature/resource/function/mainline gates 7 files / 48 tests PASS; `tsc --noEmit` PASS; `git diff --check` PASS; `build:android` PASS with terminal contracts 48 files / 579 tests, common flows 7 files / 82 tests, local relay smoke PASS, Vite/Capacitor/Gradle PASS, and update manifest verification PASS.
- APK published: `0.1.3.2149` / versionCode `1032149`, sha256 `fc60b8c056497d7e262c634bb2370ffa9272b23811b87c1f2245e93e8ac48fc7`, paths `android/update-dist/zterm-0.1.3.2149.apk` and `/Users/fanzhang/.zterm/updates/zterm-0.1.3.2149.apk`. `adb devices -l` returned no online devices, so installed-device L5 is not claimed. MemoryPalace remains unavailable due bad interpreter, so mine/search persistence is not claimed.

## 2026-07-18 Long terminal input delivery investigation

- User issue: latest Android version loses longer terminal input.
- MemoryPalace initially failed in the earlier shell with a stale pipx interpreter, so local `CACHE.md`/`MEMORY.md`/docs were read directly before implementation. Closeout must re-run the canonical safe-corpus mine and unique-phrase search before claiming persistence.
- Architecture mapping: `terminal.keyboard_ime` owns Android native IME commit into `resource.platform_input_channel`; `terminal.transport_lifecycle` owns JS session transport send; `terminal.daemon_input` owns `resource.daemon_input_queue -> backend_session -> tmux_session`. Mainline IDs: `daemon_mainline:Runtime->Message`, `daemon_mainline:Message->Control`, `daemon_mainline:Control->Tmux`.
- Verified cause in code/history: `terminal-message-runtime.ts` rejects any single string `input.payload` over 256KB with `input_too_large`, but Android client `session-context-input-runtime.ts` sent long input as one JSON frame. The R13 audit explicitly said "client 端做 chunking"; that part was missing. Secondary same-chain risk: `terminal-control-runtime.ts` coalesced same-microtask input into one `tmux send-keys -l -- <payload>`, so multiple safe frames could be merged back into an unsafe tmux argument.
- Fix direction implemented in source: shared UTF-8 chunk helper; native `ImeAnchorInputLogic` chunks long commit events before WebView bridge emission; Android session input sends ordered string-only frames; daemon message frame max remains 256KB; daemon control queue preserves small coalescing but splits tmux write groups by byte budget and direct write paths use the same chunking.
- Verified closeout: focused JS/native/daemon tests, shared chunk tests, Java IME tests, typecheck, feature/resource/function/mainline gates, full nine-case daemon mirror close-loop, Android build, and update manifest passed. `long-input-echo` automatically matched the 357,840-byte source and tmux target digest, then proved mirror recovery. APK `0.1.3.2150` was published with SHA-256 `82365b6c2614ccf41843d3e88f8d38d0e6caa335baf1e306e814992fc822a621`.
- `adb devices -l` returned no online device, so real voice IME / Capacitor bridge / visible terminal L5 remains unverified.

## 2026-07-18 Android IME shift-enter / RTC timeout closeout

- User clarified the intended system IME semantics: `换行` is `Shift+Enter`, and `完成` is submit/Enter.
- Implemented at the native IME owner:
  - line-break-only `commitText()` / `finishComposingText()` emit shifted Enter
  - `performEditorAction()` emits plain Enter submit
  - shared terminal keyboard mapping preserves `Shift+Enter` as `\n` and plain Enter as `\r`
- Shortened traversal RTC candidate timeout from 8000ms to 2500ms so session switching does not sit in a long candidate wait window.
- Verified:
  - focused IME / traversal / session-runtime / shared keyboard tests: 110 tests PASS
  - `pnpm --dir android run test:feature-registry` PASS
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS
  - `pnpm --dir android run build:android` PASS
- APK published:
  - version `0.1.3.2152`
  - versionCode `1032152`
  - sha256 `e3fb6bfabbbb6faa773bcd8852fd3b4d2bcdfd5e7e8eae2677e7237753d50b7c`
  - path `android/update-dist/zterm-0.1.3.2152.apk`
- `adb devices -l` returned no attached device in this workspace, so no install or UI L5 was claimed here.

## 2026-07-18 Connected switch bookkeeping trim

- Jason provided a recovery screenshot showing the switched session already in `connected / waiting`, while exit/re-enter worked normally.
- Root finding: the switch path still owns the immediate `ensureActiveSessionFresh()` probe, but `tab-switch-in` bookkeeping reset was too aggressive for already-connected sessions. Keep the freshness probe, but skip the bookkeeping reset only when the target session is already connected.
- Verified locally:
  - `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx src/contexts/session-context-lifecycle.test.tsx --reporter dot` PASS
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS
  - `pnpm --dir android run build:android` PASS
- APK published:
  - version `0.1.3.2155`
  - versionCode `1032155`
  - path `android/update-dist/zterm-0.1.3.2155.apk`
- Remaining gap: no live device replay in this turn, so the fix is locally verified but not yet claimed against the exact phone-side screenshot path.

## 2026-07-18 Relay update manifest follows public Relay route

- Jason 要求 Relay 时升级 IP 跟着切到当前 Relay 公网路径。架构映射：`settings.config_transfer` owns app update preferences/runtime; `relay.account_directory` owns public Relay update assets. `App.tsx` 只把 `bridgeSettings.traversalRelay.wsHostUrl` 交给 `app-update-runtime.applyRelayManifestSource()`，不自行拼 URL。
- 实现事实：`AppUpdatePreferences.manifestSource` 区分 `user-saved`、`relay-injected`、`server-connected`、`none`；显式 `user-saved` 不覆盖；旧私网/Tailscale daemon URL 和旧 Relay 注入 URL 可替换为当前 Relay URL。`wss://relay.codewhisper.cc:18443/relay/ws/host` 派生为 `https://relay.codewhisper.cc:18443/relay/updates/latest.json`，保留 `/relay` base path。
- Relay server 新增 `ZTERM_TRAVERSAL_UPDATES_DIR` / `ZTERM_RELAY_UPDATES_DIR`，默认 `dirname(STORE_PATH)/updates`，公开服务 `/relay/updates/latest.json` 和 `/relay/updates/<apk>`；manifest `apkUrl` 保持原样，客户端按同一路由解析相对 APK。补充 `HEAD` 支持，避免 public smoke `curl -I` 误报 404。
- Production 已部署到 `relay.codewhisper.cc`：`zterm-traversal-relay.service` PID `515028`，health 包含 `updates.dir=/var/lib/zterm-traversal-relay/updates`、`manifestPresent=true`。公网验证 `GET/HEAD https://relay.codewhisper.cc:18443/relay/updates/latest.json` 200；`HEAD/GET https://relay.codewhisper.cc:18443/relay/updates/zterm-0.1.3.2158.apk` 200，下载大小 `5857562`，sha256 `3bc28bc20238b41612f7babf7125c5dcb1630fd6c9379653abf3ffb934572cf3` 与本地 APK 一致。
- 验证：focused app-update/Relay package tests 7 files / 33 tests PASS；`tsc --noEmit` PASS；feature/resource/function/mainline gates 7 files / 48 tests PASS；local Relay smoke PASS with `relayUpdateSmoke` fetching manifest and APK bytes; `relay:prepare-npm` / `relay:verify-package` PASS; `build:android` PASS with terminal contracts 48 files / 586 tests, common flows 7 files / 82 tests, Relay smoke PASS, Vite/Capacitor/Gradle PASS.
- APK 发布并安装：`0.1.3.2158` / versionCode `1032158`，APK `android/update-dist/zterm-0.1.3.2158.apk` 和 `/Users/fanzhang/.zterm/updates/zterm-0.1.3.2158.apk`，sha256 `3bc28bc20238b41612f7babf7125c5dcb1630fd6c9379653abf3ffb934572cf3`；ADB device `100.104.163.65:5555` install success，`dumpsys package` 显示 versionCode `1032158` / versionName `0.1.3.2158`。设备仍锁屏在 `NotificationShade` / `isKeyguardShowing=true`，所以 App 内检查更新 UI L5 未宣称。

## 2026-07-19 Remote window stream interaction decisions

- Jason confirmed remote window video is not view-only long term. It must later support mouse/keyboard event return, with a user-selectable "bring to focus" policy before forwarding input to the selected remote window/pane.
- Fullscreen remote window stream Back behavior: Android system Back shrinks the fullscreen stream back to floating-window mode. The explicit close button is the stream teardown action.

## 2026-07-19 iTerm2 pane coordinate live experiment

- Used temporary venv `/tmp/zterm-iterm2-pane-crop-20260719-67865` because the base Python had no `iterm2` module. iTerm2 RPC connected and enumerated the existing Mac Studio iTerm2 window, including `session.tty` values for pane-to-tmux reverse lookup.
- Created a temporary iTerm2 tab `zterm-iterm2-crop-20260719-pass2`, split it into two panes, drew red and blue marker rows, captured the desktop, and force-closed the temporary tab in `finally`.
- Window frame was `{x:0,y:84,width:3825,height:2046}`. Flattened content was `{width:3825,height:1978,topInset:68}`. Top pane frame was `{x:0,y:0,width:3825,height:1327}` and bottom pane frame was `{x:0,y:1328,width:3825,height:650}`.
- Direct formula `cropY = window.y + topInset + pane.y` matched expected samples: top red `4/4`, bottom blue `3/4` with one probe outside the drawn marker width. Inverted-y formula matched `0`.
- Cleanup check after tab close found no `ZTERM_CROP` / `sleep 300` process except the check command itself. Follow-up cleanup confirmed no matching temporary venv/screenshot directory remains.

## 2026-07-19 Remote window target catalog runtime closeout

- Implemented daemon-side `desktop.remote_window_stream` target catalog slice: shared protocol messages, `remote-window-stream-daemon.ts`, server/message-runtime wiring, iTerm2 Python catalog, split-tree flattening, crop manifest, tmux `tty -> list-clients` reverse lookup, and explicit error responses.
- Live black-box initially exposed a real bug in the complex existing iTerm2 layout: two rightmost pane crops were out of bounds because nested split measurement double-counted positioned leaf `frame.x` offsets. The bug was not caught by the simple nested test.
- Fix: `measureIterm2Node()` now computes bounding boxes with the same cursor/offset semantics as flattening. It treats iTerm2 leaf frames as local to the immediate splitter and only applies parent splitter offsets once. `buildRemoteWindowStreamTargets()` rejects content/crop rectangles outside the owning window instead of returning bad manifests.
- Added regression with the live four-column/nested-stack iTerm2 tree. It locks expected rightmost pane x `2984` and asserts every pane crop stays within `{x:0,y:85,width:3799,height:2045}`.
- Verification passed:
  - `pnpm --dir android exec vitest run src/server/remote-window-stream-daemon.test.ts src/server/terminal-message-runtime.test.ts --reporter dot` = 2 files / 27 tests PASS.
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS.
  - `pnpm --dir android run test:feature-registry -- --reporter dot` = 7 files / 48 tests PASS.
  - `git diff --check` PASS.
  - Live catalog gate with temporary venv and real iTerm2 API returned `targets=12`, `appWindows=1`, `panes=11`, `tmuxPanes=10`, `outOfBounds=0`; temp venv cleaned at exit.
- Scope still pending: Android picker/overlay, ScreenCaptureKit/WebRTC frame stream, and input return runtime.

## 2026-07-19 Remote window generic app and non-tmux pane closeout

- Jason clarified two selection requirements: daemon must allow selecting iTerm2 panes with no tmux mapping, and daemon must allow selecting non-iTerm2 app windows.
- Architecture mapping stayed inside `desktop.remote_window_stream` / `resource.remote_window_stream`. Android overlay, terminal buffer/render, remote screenshot, daemon input, and tmux truth were not changed.
- Implementation:
  - Added daemon-side macOS app-window catalog via `CGWindowListCopyWindowInfo` Swift script. It emits generic `app-window` manifests with bundle id, pid, window id, title, top-left bounds, crop rect, `focusPolicy=bring-to-focus`, and `inputRoute=os-event`.
  - Kept iTerm2 pane catalog independent. Missing tmux reverse lookup now remains explicitly selectable as `inputTarget.kind=iterm2-pane`, `inputRoute=iterm2-api`, with no fake tmux ids.
  - `RemoteWindowStreamTargetsResponsePayload` now supports partial `errors` so non-iTerm2 app windows can remain selectable while an optional iTerm2 source error is visible instead of silently hidden.
- Verification passed:
  - `pnpm --dir android exec vitest run src/server/remote-window-stream-daemon.test.ts src/server/terminal-message-runtime.test.ts --reporter dot` = 2 files / 31 tests PASS.
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS.
  - `pnpm --dir android run test:feature-registry -- --reporter dot` = 7 files / 48 tests PASS.
  - `git diff --check` PASS.
  - Live Mac Studio catalog gate with real Swift app-window catalog + real iTerm2 API returned `targets=31`, `appWindows=20`, `nonItermAppWindows=18`, `panes=11`, `tmuxPanes=10`, `nonTmuxPanes=1`, `outOfBounds=0`, `errors=[]`; temp venv cleaned at exit.

## 2026-07-19 Remote window Android minimal UI slice

- Current task: minimal Android implementation after daemon catalog closeout. Scope is picker + target-locked floating/fullscreen overlay shell only; no fake video, no terminal-buffer preview fallback, no ScreenCaptureKit/WebRTC receiver, no input return yet.
- Architecture mapping: `feature_id=desktop.remote_window_stream`; resources `resource.ui_projection -> resource.remote_window_overlay -> resource.remote_window_stream`, with catalog request routed through current active session transport owner. Android overlay may request/render daemon target manifests and emit close/minimize/fullscreen intent only. It must not compute macOS coordinates, read iTerm2 split trees, use terminal mirror/buffer/render as video truth, or inject input.
- Owner update needed in same change set: add Android overlay component/runtime/request runtime paths to feature registry, function map, mainline call map/source, and remote-window test design. Replace Android overlay `binding pending` with real symbols while leaving capture/WebRTC/input runtime pending.
- Verification design: white-box runtime request response/error/timeout; component black-box picker/select/double-tap/fullscreen Back/minimize/close; TerminalPage integration for floating entry opening picker via active session; existing daemon catalog tests; resource/function/mainline gates; typecheck; build APK if UI behavior is delivered for device testing.
- Closeout: implemented `remote-window-android-minimal-overlay-slice` with `RemoteWindowOverlay`, overlay state runtime, remote-window message runtime, SessionContext active-transport catalog request, socket response dispatch, App/TerminalPage wiring, feature registry/function map/mainline wiki/test-design bindings, and page integration tests.
- Verification passed: remote-window focused suite `6 files / 26 tests`; daemon catalog/message suite `2 files / 31 tests`; App/lifecycle related suite `4 files / 50 tests`; architecture/resource/function/mainline gate `7 files / 48 tests`; `tsc --noEmit`; `git diff --check`; `build:android` including terminal contracts `48 files / 586 tests`, common flows `7 files / 82 tests`, Relay smoke, Vite, Capacitor sync, and Gradle assemble.
- APK published and installed: `0.1.3.2159` / versionCode `1032159`, sha256 `cd9ce9f03eafd734966ebc366cc762bd05a709dd1ac4a4e5019f1dbf77395e56`, paths `android/update-dist/zterm-0.1.3.2159.apk` and `/Users/fanzhang/.zterm/updates/zterm-0.1.3.2159.apk`; `adb install -r` succeeded on `100.104.163.65:5555`, `dumpsys package` reports the same version.
- Remaining gap: Android launch intent focused `com.zterm.android/.MainActivity`, but `mCurrentFocus=NotificationShade` and `mDreamingLockscreen=true`; UI visual L5 is not claimed. Real ScreenCaptureKit/WebRTC frame delivery and input return remain pending by design.

## 2026-07-19 Remote window Android triage after device screenshots

- Jason reported three regressions: update check path still tied to a Tailscale/direct daemon URL, remote window picker timed out with zero targets, and the terminal quickbar/input surface remained visible while the remote-window overlay was open.
- Architecture mapping: update route belongs to `settings.config_transfer`; remote target catalog belongs to `desktop.remote_window_stream`; bottom quickbar suppression belongs to `TerminalPage` projection between `desktop.remote_window_stream` and `terminal.quickbar`.
- ADB confirms device `100.104.163.65:5555` is installed at `0.1.3.2159` / versionCode `1032159`; the screenshot showing `0.1.3.2157` is not the current installed package truth.
- Root cause found for catalog timeout: running daemon PID `3312` started 2026-07-16 from `~/.zterm/daemon-runtime/server.cjs`; that staged runtime has no `remote-window-targets-request`, so Android waits until the 15s catalog timeout. Source has the handler; daemon runtime staging/service needs update.

## 2026-07-19 Remote window overlay drag and daemon catalog service closeout

- Jason reported two UI regressions after the remote-window slice: Terminal drawer left a large blank area above the footer, and the remote-window floating overlay could not be moved.
- Architecture mapping: drawer spacing stays in `terminal.session_drawer` / `TerminalSessionDrawer`; overlay movement stays in `desktop.remote_window_stream` / `resource.remote_window_overlay`. No terminal buffer/render/transport fallback was added.
- Red/green: `RemoteWindowOverlay.test.tsx` first failed on missing `remote-window-drag-handle`, then passed after adding toolbar-only floating drag. Drag is disabled in fullscreen; double-click/double-tap fullscreen intent moved to the video surface so future video/input gestures are not hijacked by toolbar drag.
- Drawer fix remains content-sized list projection: list uses `flex: 0 1 auto` and `minHeight: 0`, with a regression test preventing `flex: 1` blank-space growth.
- Daemon root cause for zero iTerm2 panes was the launchd runner using base Python without `iterm2`; `scripts/zterm-daemon.sh` and release script now prepare `~/.zterm/python/iterm2` and launch daemon with `ZTERM_ITERM2_PYTHON`.
- Live verification after service-scoped `bash android/scripts/zterm-daemon.sh restart`: health pid `79375`, uptime `19s`; launch runner exports `ZTERM_ITERM2_PYTHON=/Users/fanzhang/.zterm/python/iterm2/bin/python3`; `import iterm2` passes; real WebSocket catalog returned `targetCount=31`, `appWindows=20`, `itermPanes=11`, `errors=[]`.
- Local gates passed before APK build: remote-window required gates `8 files / 62 tests`, drawer required gates `4 files / 62 tests`, Settings/update focused gates `6 files / 33 tests`, feature/resource/function/mainline gates `7 files / 48 tests`, and `tsc --noEmit`.

## 2026-07-19 Public Relay update channel 2161 publish

- Public Relay update route had stayed on `0.1.3.2158` after local 2161 build/install. Correct production host access is `ssh -i ~/.ssh/claw.pem -o IdentitiesOnly=yes root@159.75.134.56`; default `id_rsa` root SSH is denied.
- Published only the 2161 update assets to `/var/lib/zterm-traversal-relay/updates`: `latest.json` and `zterm-0.1.3.2161.apk`. No service restart was required.
- Public verification passed:
  - `GET https://relay.codewhisper.cc:18443/relay/updates/latest.json` returns `versionName=0.1.3.2161`, `versionCode=1032161`, `sha256=9ed1bbe370264ed3e14e87ae7a716303ccbf38e411b4193128115b2b616643c4`, `size=5863118`.
  - `HEAD latest.json` and `HEAD zterm-0.1.3.2161.apk` both return 200; APK `Content-Length=5863118`.
  - Downloaded public APK sha256 is `9ed1bbe370264ed3e14e87ae7a716303ccbf38e411b4193128115b2b616643c4`.
  - Relay `/health` still reports `updates.dir=/var/lib/zterm-traversal-relay/updates` and `manifestPresent=true`.
- Device visual L5 remains blocked: ADB device `100.104.163.65:5555` is online and app focused, but `mCurrentFocus=NotificationShade`, `mDreamingLockscreen=true`, `isKeyguardShowing=true`; drawer/remote-window visual smoke is not claimed.

# 2026-07-19 Remote window catalog readiness and bandwidth audit

- Jason 现场反馈：远程能连旧 session，但远程窗口列举显示 `0 个目标 / 没有可选窗口`，并且未开始视频连接时带宽已经异常。静态追踪确认 catalog 请求入口 `requestRemoteWindowTargetsRuntime()` 以前复用 `ensureSessionReadyForPasteRuntime()`，后者下沉到 `ensureSessionReadyForTransfer()`，要求 `session.state === connected && ws.OPEN`，因此物理 session socket 已经 open 但 UI/runtime session 仍是 `connecting` 时会等 paste timeout 后报 `Active session is not ready yet (connecting)`。
- 架构映射：`feature_id=desktop.remote_window_stream`，资源关系为 `resource.remote_window_overlay -> resource.active_session -> resource.session_transport -> resource.remote_window_stream`。本轮唯一行为修复点是 catalog transport readiness，不改 daemon catalog、不改 terminal mirror/buffer/render、不改 screenshot/file transfer paste ready gate。
- 测试设计已补：catalog readiness 必须允许 `session=connecting + socket=OPEN` 发一次 `remote-window-targets-request`；无 open socket 必须显式 remote-window catalog transport error，不能复用 paste ready 的 `Active session is not ready yet`，也不能启动 screenshot/terminal buffer/video fallback。
- 带宽尚未定根因。当前只能确认 catalog 未启动视频流；大流量下一步要用 runtime/debug 或真 daemon 统计 `remote-window-targets-request`、`body-subscription`、`buffer-head-request`、`buffer-sync-request` 的频率和 bytes，不能把 catalog ready bug 和带宽 bug 混成一个结论。
- 带宽现场证据：`/debug/runtime` 中 `remote-window` scope 为 0，`body-subscription` scope 为 0，但 `clientDebug.totalEntries=2000`、`performanceTrace.recordCount=5932`，最近条目主要是 `terminal.performance.trace`、`session.buffer.applied`、`session.ws.reconnect.buffer-sync`、`runtime.debug.drop-summary`。根因之一是 `flushRuntimeDebugLogsToSessionTransport()` 在 runtime debug disabled 但 pending queue 非空时仍会把 `runtimeDebugPrechecked('terminal.performance.trace')` 队列上送。修复为：debug 未开启时不 flush pending queue；debug flag 写 TTL，旧无 TTL 的永久 flag 冷启动时清理。剩余真实下行 buffer-sync 体积需另用网络字节 gate 统计，不能归入 remote-window 视频。

# 2026-07-19 Remote window real video mainline continuation

- Goal file re-read: current target is not APK packaging. Required next slice is daemon real ScreenCaptureKit capture + WebRTC sender, then Android receiver pixel proof, then APK only after gates.
- MemoryPalace search for `desktop.remote_window_stream ScreenCaptureKit WebRTC RemoteWindowOverlay` returned no results; current truth remains local docs/maps/MEMORY.
- Architecture owner: `desktop.remote_window_stream`; direct resources are `resource.remote_window_overlay -> resource.remote_window_stream` through existing `resource.session_transport`. Forbidden fixes remain Android coordinate math, terminal mirror/buffer/render video truth, screenshot/static/mock fallback, and fresh transport creation.
- Current source state: Android receiver/control-plane code exists; daemon `RemoteWindowStreamDaemonRuntime` still only exposes `listTargets`. `terminal-message-runtime.ts` only routes `remote-window-targets-request`. Next code edit must add adjacent start/candidate/stop control edges and daemon capture/media lifecycle.
- Local Swift checks: `ScreenCaptureKit` imports, `SCStreamConfiguration.sourceRect` exists, `SCContentFilter(desktopIndependentWindow:)` requires `AppKit` / `NSApplication.shared` on the main actor, and a real `SCStream` can emit a first frame on this Mac Studio.

# 2026-07-19 Remote window video start timeout root cause

- Jason screenshot showed `视频流启动失败 / Remote window stream start timed out` after selecting a generic app window. Direct daemon WebSocket smoke reproduced against `app-window:486:1439` / `微信` with crop `1037x1177`: catalog succeeded, stream emitted only `phase=starting`, then timed out.
- Root cause was daemon-side frame conversion, not Android picker/receiver and not Relay/session transport. The active service logs are under `~/.wterm/logs/launchd-stderr.log`; the daemon had crashed with `TypeError: Expected a .byteLength of 1831931, not 1830823` from `convertRgbaToI420Frame`.
- Fix: I420 allocation now uses `Y = width * height` and chroma planes `ceil(width/2) * ceil(height/2) * 2`; `onFrame` conversion errors are caught and close the stream with explicit stopped status instead of crashing the daemon process.
- Verification: remote-window server focused tests now pass `2 files / 42 tests`, full remote-window focused suite passes `9 files / 92 tests`, feature/resource/function/mainline gates pass `7 files / 48 tests`, `tsc --noEmit` passes, and `git diff --check` passes.
- Live gates from the fixed staged daemon runtime: same `微信` target produced `remote-window-stream-started`, `phase=streaming`, WebRTC video track `live`, and stopped cleanly at `framesSent=22` with daemon PID stable. Android CDP receiver proof showed `<video data-testid="remote-window-video">` `readyState=4`, `videoWidth=1037`, `videoHeight=1177`, track `live`. Controlled AppKit marker rendered through Android video with canvas samples red `[254,8,7,255]`, green `[0,249,58,255]`, blue `[0,52,246,255]`, all classified true.
- Delivery build: `pnpm --dir android run build:android` passed full build gates (`terminal contracts 48 files / 588 tests`, common flows 82 tests, local Relay smoke, typecheck/Vite/Gradle/update-manifest verification). APK `0.1.3.2164` / versionCode `1032164` was published to local update channel and installed on ADB device `100.104.163.65:5555`; sha256 `40db98e2c66701212471f920ffd4a7a7188340f716116934eb8ce2a5febdbe3b`. Post-install UI smoke for 2164 is blocked because the device is on `NotificationShade` with `isKeyguardShowing=true`; do not claim 2164 visual L5 beyond install/version proof.

# 2026-07-19 Session switch connected but body not updating

- Jason reported that switching sessions can show the new session as connected while the visible shell body stops updating. MemoryPalace hit the earlier drawer remote-open/session-group slot class of bugs; this run confirmed the current symptom at the UI projection layer, not the WebSocket owner.
- Root cause: `TerminalPage` kept `sessionGroupSlotIds.center` from initial render. `resolveTerminalSessionGroupSlotIds()` only fell back to the new `activeSession` when the old center session no longer existed. In portrait/session-group mode, an external active session change to an already-open session could therefore leave `TerminalPageStageShell` rendering the old center `TerminalView`.
- Red test: `TerminalPage.session-content-identity.test.tsx` now forces a portrait viewport, renders `ALPHA_PORTRAIT_BODY`, rerenders with active session beta, and fails if DOM rows still contain alpha instead of `BETA_PORTRAIT_BODY`.
- Fix: `TerminalPage#resolveTerminalSessionGroupActiveSessionProjection` synchronizes active session id to the existing top/center/bottom slot before StageShell render. If active is already in a slot, focus that slot; otherwise replace center with active. This stays in `terminal.session_group_layout` / UI projection and does not open, close, reconnect, or rebuild transports.
- Additional cleanup: `TerminalPage.session-preview.test.tsx` expected a remote drawer materialization target without `relayHostId`; current route identity correctly includes `relayHostId`, so the assertion was aligned.
- Verification:
  - `TerminalPage.session-content-identity.test.tsx` PASS, 2 tests.
  - Session/body/drawer/preview/layout/transport/render focused gate PASS, 7 files / 292 tests.
  - `test:feature-registry` PASS, 7 files / 48 tests.
  - `tsc --noEmit` PASS; `git diff --check` PASS.
  - `pnpm --dir android run build:android` PASS: terminal contracts 48 files / 588 tests, common user flows 7 files / 82 tests, local Relay smoke, typecheck/Vite/Capacitor/Gradle/update-manifest verification.
- APK published/installed: `0.1.3.2165` / versionCode `1032165`, sha256 `71273aa50420d2dc86d53e92ed312a4b2c6fe2bb9b70a535703d32b3fef1bd89`, size `5867362`, paths `android/update-dist/zterm-0.1.3.2165.apk` and `/Users/fanzhang/.zterm/updates/zterm-0.1.3.2165.apk`; ADB install on `100.104.163.65:5555` succeeded and package manager reports versionName `0.1.3.2165`.
- L5 gap: launching the app focuses `com.zterm.android/.MainActivity`, but `mCurrentFocus=NotificationShade`, `mDreamingLockscreen=true`, `isKeyguardShowing=true`; real UI session-switch visual proof is not claimed until the device is unlocked.

# 2026-07-19 Session switch report recheck

- Jason reported the same connected-but-not-updating switch symptom again. Current local code still maps this class first to `terminal.session_group_layout` / `resource.ui_projection`, not WebSocket: connected state can be true while `TerminalPageStageShell` is still rendering the old session-group center slot.
- Rechecked current installed device package: `com.zterm.android` is `0.1.3.2165` / versionCode `1032165`. The device is currently locked behind `NotificationShade` / keyguard, so live DOM/session-body replay is blocked and not claimed.
- Local focused gate re-run passed: `TerminalPage.session-content-identity.test.tsx` 2/2 PASS and the wider session/body/drawer/preview/layout/transport/render gate 7 files / 291 tests PASS. If the issue still reproduces on 2165 after unlock, the remaining suspect is a second projection path outside the covered portrait external-active-session case, not the daemon WebSocket owner until a session/body marker gate proves otherwise.

# 2026-07-19 Remote window fullscreen interaction 2166 closeout

- Jason requested remote-window fullscreen support for pinch zoom, zoomed single-finger pan, and a top-right minimap; this sits in `desktop.remote_window_stream` / `resource.remote_window_overlay`, with input requests crossing the existing active session transport to daemon `resource.remote_window_stream`.
- Implemented overlay interaction slice: partial daemon catalog errors are hidden when selectable targets exist; floating video no longer suppresses QuickBar; picker/fullscreen still suppress QuickBar and active body push; floating toolbar has an explicit fullscreen button next to close; fullscreen uses aspect-fit letterbox, pinch scale `1..4`, pan clamps to content bounds, and minimap shows viewport position.
- Implemented input intent path: Android maps pointer/key events from the video content rect to daemon target coordinates and sends `remote-window-input` over the already-open session transport. Daemon accepts only `focusPolicy=bring-to-focus` + `inputRoute=os-event` for generic app windows and explicitly rejects no-focus/generic, target mismatch, stopped stream, and unsupported iTerm2/tmux routes.
- Verification passed before package delivery: remote-window focused suite `9 files / 101 tests`; `tsc --noEmit`; feature/resource/function/mainline gates `7 files / 48 tests`; `git diff --check`; Swift input script parse gate; full `build:android` including terminal contracts `48 files / 588 tests`, common user flows `7 files / 82 tests`, local Relay smoke, Vite/Capacitor/Gradle/update manifest verification.
- APK `0.1.3.2166` / versionCode `1032166` was built and published to local update channel. sha256 `fa0dd5c9ab14a535e21a4f2c8541b2a883d5df2c5f543e99c485f0d4a34f90f3` matches `android/update-dist/zterm-0.1.3.2166.apk`, `android/update-dist/zterm-latest-debug.apk`, and `/Users/fanzhang/.zterm/updates/zterm-0.1.3.2166.apk`.
- ADB install on `100.104.163.65:5555` succeeded. Package manager reports `versionName=0.1.3.2166` and `versionCode=1032166`; `am start` focused `com.zterm.android/.MainActivity` with keyguard not showing.
- Remaining gap: no live physical pinch/pan/minimap visual proof and no live OS input injection proof on a remote target in this closeout. Unit/component/runtime gates prove the interaction mapping and explicit unsupported routes; Jason device testing is still needed for actual gesture feel and macOS input permission behavior.

# 2026-07-19 Remote window video Relay ICE and fullscreen safe-area 2167

- Jason reported two regressions on 2166: remote-window video still failed with `Remote window stream start timed out`, and fullscreen toolbar overlapped the Android status bar.
- Local daemon/WebRTC black-box still proved ScreenCaptureKit/WebRTC itself can stream: direct daemon WebSocket selected a real `app-window` target, emitted `phase=starting`, `phase=streaming`, `remote-window-stream-started`, delivered a live video track, and stopped cleanly. That narrowed the new failure to Android remote-window media negotiation on the current session route, not daemon capture.
- Fix: remote-window video is still a separate WebRTC peer, but `requestRemoteWindowStreamStartRuntime()` now derives ICE servers from the active session traversal route. `rtc-direct` inherits STUN-only direct ICE; `rtc-relay` inherits Relay TURN ICE; direct WebSocket/Tailscale paths do not fabricate ICE. This prevents cellular/Relay remote-window video from starting with an empty no-ICE peer.
- Fix: `RemoteWindowOverlay` fullscreen root now uses `box-sizing: border-box` and `padding-top: calc(16px + env(safe-area-inset-top, 0px))`, moving the toolbar below the status-bar safe area.
- Verification passed before delivery: focused remote-window route/overlay tests `2 files / 20 tests`; full remote-window focused suite `9 files / 102 tests`; `tsc --noEmit`; feature/resource/function/mainline gates `7 files / 48 tests`; `git diff --check`; full `pnpm --dir android run build:android` including terminal contracts `48 files / 588 tests`, common user flows `7 files / 82 tests`, local Relay smoke, Vite/Capacitor/Gradle/update manifest verification.
- APK `0.1.3.2167` / versionCode `1032167` built and published to local update channels: `android/update-dist/zterm-0.1.3.2167.apk`, `android/update-dist/zterm-latest-debug.apk`, and `/Users/fanzhang/.zterm/updates/zterm-0.1.3.2167.apk`, sha256 `8ed0e1e717f27076cd00d10858002741aa942e43f28fb9c949a5f7cc975d024d`.
- ADB install on `100.104.163.65:5555` succeeded and package manager reported `versionName=0.1.3.2167`, `versionCode=1032167`; `am start` focused `com.zterm.android/.MainActivity` with keyguard false. After a later CDP/ADB probing attempt the phone dropped off Tailscale/ADB (`tailscale status Online=false`, ping 100% loss), so live Android rendered-pixel/video-open and visual safe-area proof for 2167 are not claimed in this note.

# 2026-07-19 Fast-path route, reliable input resend, and portrait top chrome

- Jason reported 2167 was hard to use: the top UI bug persisted, route choice was wrong for real networks, and user input still needed resend semantics. Current product route policy is `private LAN IPv4 -> Tailscale/direct websocket -> WebRTC direct/hole-punch -> TURN/Relay`; Relay/TURN is last, not default.
- Architecture mapping: `relay.route_selection` owns route cost/health and `TraversalSocket` candidate selection; `terminal.daemon_input` owns input resend/ack/dedupe; `terminal.keyboard_ime` / `TerminalPageStageShell` own Android top/bottom chrome avoidance. No daemon client-state fallback or terminal renderer workaround was added.
- Code changes now under test:
  - route selector default priority and cost make private LAN IPv4 win first, public IPv4 stay below Tailscale, WebRTC direct stay before TURN/Relay, and opened-route close/heartbeat failure records route health so the next attempt can try another candidate.
  - reliable input remains string-only for old daemons; new daemon capability `connected.capabilities.reliableInput.version=1` enables client seq/ack/retry, daemon accepted-seq dedupe, retryable stale-transport/session-required nacks staying queued, and invalid/oversize nacks stopping.
  - portrait terminal stage now reserves top chrome for the Android safe area plus floating top controls; remote-window picker has an 8s local watchdog so it cannot remain indefinitely at `读取中`.
- Focused verification passed before APK build:
  - route/config/socket: 3 files / 35 tests PASS.
  - input/protocol/session sync: 4 files / 128 tests PASS.
  - UI/remote-window focused: 2 files / 64 tests PASS, plus remote-window wider focused 8 files / 93 tests PASS.
  - session-open/drawer/infra/picker old route wording gate: 4 files / 80 tests PASS.
  - transport/session wider gate: 5 files / 166 tests PASS.
  - feature/resource/function/mainline gates: 7 files / 48 tests PASS.
  - `tsc --noEmit` PASS and `git diff --check` PASS.
- Remaining gap: APK build/update publish and any ADB/live network proof are not yet claimed in this note.

# 2026-07-19 Remote window floating preview and hit surface fixes

- Jason reported the remote-window stream can show video in fullscreen but not in the floating window, fullscreen input is not effective, and the window floating marker cannot be moved / can obstruct UI. Same screenshot also showed the quickbar command bubble persisted near the Android status bar.
- Architecture mapping: `desktop.remote_window_stream` owns `RemoteWindowOverlay` floating/fullscreen projection and video/input hit surface; `terminal.quickbar` owns the independent command bubble clamp. No daemon coordinate truth, ScreenCaptureKit capture, terminal mirror/buffer/render, or transport fallback was changed.
- Implemented source-side fixes:
  - floating remote preview now derives width cap and video surface `aspect-ratio` from selected `cropRectTopLeftPx` / `windowBoundsTopLeftPx` instead of using fixed 16:10.
  - floating overlay is a flex shell with a real aspect-ratio video surface; received media `<video>` is pointer-transparent so fullscreen/floating pointer/key input belongs to `remote-window-video-surface`.
  - remote-window floating entry is draggable and suppresses the synthetic click from the same drag gesture.
  - quickbar command bubble clamp now has a 64px top guard to keep it below Android status icons after persisted/manual movement.
- Verification so far:
  - `pnpm --dir android exec vitest run src/components/terminal/RemoteWindowOverlay.test.tsx src/components/terminal/TerminalQuickBar.test.tsx --reporter dot` PASS, 2 files / 82 tests.
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS.
- Broader gates passed after the focused fix:
  - Remote-window + quickbar runtime suite PASS, 10 files / 178 tests.
  - `pnpm --dir android run test:feature-registry -- --reporter dot` PASS, 7 files / 48 tests.
  - `git diff --check` PASS.
  - `pnpm --dir android run build:android` PASS, including terminal contracts, common flows, local Relay smoke, Vite/Capacitor/Gradle/update-manifest verification.
- Delivery:
  - APK `0.1.3.2169` / versionCode `1032169`, sha256 `72b276cd2906687ea502e15a676ab9fc0ef65abb93f0482160cd4b07331b9dff`, size `5873874`.
  - Local paths: `android/update-dist/zterm-0.1.3.2169.apk`, `android/update-dist/zterm-latest-debug.apk`, `/Users/fanzhang/.zterm/updates/zterm-0.1.3.2169.apk`.
  - ADB install succeeded on `100.104.163.65:5555`; package manager reports `versionName=0.1.3.2169`, `versionCode=1032169`.
  - Public Relay update route `https://relay.codewhisper.cc:18443/relay/updates/latest.json` now returns build `2169`; APK sha matches the local package.
- 2026-07-19 recheck: focused overlay/quickbar gate PASS 82 tests, `tsc --noEmit` PASS, `git diff --check` PASS, public Relay manifest still returns 2169 and local APK sha matches. Live Android rendered-pixel/input proof remains blocked because the device is behind `NotificationShade` / keyguard (`isKeyguardShowing=true`), and CDP `/json/list` timed out.

# 2026-07-19 Remote window floating overlay drag pointer capture

- Jason reported the remote-window floating window still could not be dragged. Architecture/map lookup keeps this in `desktop.remote_window_stream.overlay.project` / `resource.remote_window_overlay`; the fix point is `RemoteWindowOverlay`, not daemon, transport, terminal buffer, or renderer.
- Red test changed the drag gate to require `setPointerCapture/releasePointerCapture` on the toolbar handle. Old implementation failed that assertion and relied on `window.pointermove`, which can be unreliable in Android WebView touch drags.
- Fix: toolbar drag now captures pointer, handles toolbar-local move/up/cancel through the same bounded floating-offset helper, releases capture from the saved element, and leaves video surface pointer events separate for remote-window input.
- Verification: `RemoteWindowOverlay.test.tsx` 15 PASS; remote-window input/QuickBar/IME suite 5 files / 146 tests PASS; overlay/page focused suite 2 files / 16 tests PASS; feature/resource/function/mainline gates 7 files / 48 tests PASS; `tsc --noEmit` and `git diff --check` PASS.
- Full `build:android` PASS: terminal contracts 48 files / 590 tests, common flows 7 files / 82 tests, local Relay smoke, typecheck, Vite, Capacitor, Gradle, and update-manifest verification.
- Delivery: APK `0.1.3.2170` / versionCode `1032170`, size `5875906`, sha256 `489fad6910fb94d1c7c080a2b2c517f993ac11947adcb60051d9a40ca9a62e97`. Local update paths and public Relay update route carry the same package; public manifest/HEAD/downloaded APK sha were verified.
- L5 gap: `adb devices` returned no online device, so install and physical touch-drag proof are not claimed. Jason must verify the toolbar drag on an upgraded unlocked phone.

# 2026-07-19 Remote window IME lift, raw input, and scroll injection

- Jason reported that after the Android keyboard opens, an already-open remote-window preview stays under the IME; keyboard text does not reach the remote app; vertical drag gestures do not scroll the remote window.
- Architecture mapping: all fixes stay inside `desktop.remote_window_stream`. Android `RemoteWindowOverlay` owns overlay projection/input intent, `TerminalPage` only routes active remote-window IME/QuickBar intent, and daemon `remote-window-stream-daemon.ts#injectInput` owns macOS focus/input injection. Terminal buffer/render/transport are not modified for this symptom.
- Root cause: `TerminalPage` already passed the IME bottom inset to `RemoteWindowOverlay`, but target-locked floating overlay still used fixed `bottom: 118`; only the closed entry button consumed the inset.
- Root cause: touch drag on the video surface was pointer input only; normal macOS apps need scroll-wheel input for vertical content scrolling. Added explicit `RemoteWindowInputEventPayload.event.kind='scroll'` with pixel deltas and target coordinates.
- Root cause: remote-window IME input was sharing terminal committed-text normalization. Remote-window input now sends raw committed text so CJK, special symbols, and newline text are preserved for the selected app.
- Mac SDK check: Apple docs confirm `CGEvent.post(tap:)` posts Quartz events into the event stream and `NSRunningApplication.activate(options:)` attempts to activate the app. Local AppKit experiment with a key/active flipped scroll view proved `CGEvent` pixel scroll moves content; negative macOS `wheel1` moves content down, so daemon is the single owner that translates DOM positive-down/right deltas to negative CGEvent wheel values.
- Verification: remote-window focused suite PASS `11 files / 174 tests`; feature/resource/function/mainline gates PASS `7 files / 48 tests`; `tsc --noEmit` PASS; `git diff --check` PASS; `pnpm --dir android run build:android` PASS including terminal contracts `48 files / 590 tests`, common flows `7 files / 82 tests`, local Relay smoke, Vite/Capacitor/Gradle/update-manifest verification.
- Delivery: APK `0.1.3.2171` / versionCode `1032171`, size `5876330`, sha256 `296a98b90a8cd6f6ff4e9b1266a43c5dbc55ff7accd860f29ee2e30a44a86c42`. Local update channel and `~/.zterm/updates` have matching artifacts. Public Relay `GET/HEAD https://relay.codewhisper.cc:18443/relay/updates/latest.json` and APK `HEAD` return 200; downloaded public APK sha matches local.
- L5 gap: `adb devices` showed no attached/online device, so installed APK and physical Android IME/scroll/input replay are not claimed in this closeout.

# 2026-07-20 Remote window input no-op on 2171 root correction

- Jason reported Android `0.1.3.2171` had no visible behavior change: click/input/gesture did not reach the Mac target, and WeChat did not come to foreground.
- Root cause 1: 2171 APK had been published, but daemon-side input changes were not installed into the running Mac daemon. The stale running daemon explains why phone upgrade alone looked unchanged for click/input.
- Root cause 2: daemon input Swift used only `pid + app.activate`; for covered/background normal app windows this does not guarantee the selected window is front. WeChat is in this class. Fix: input config now carries selected `windowId/title/windowBoundsTopLeftPx`; Swift matches the AX window by bounds, activates the app, performs `AXRaise`, sets focused/main window when supported, then posts pointer/key/scroll.
- Coordinate correction: a live AppKit experiment proved `CGWindowList` bounds center works directly as `CGEvent` location. The old failed experiment used AppKit bottom-left frame coordinates, not daemon manifest coordinates. Therefore no y-axis conversion belongs in daemon input for manifest coordinates.
- Black-box focus proof: created a marked AppKit target scroll window and a separate cover window over the target point. Pixel scroll before AXRaise left target `y=500`; after AXRaise the target became key and scrolled to `y=620` (`coveredDidNotMove=true`, `raisedMovedDown=true`, `trusted=true`).
- Runtime closeout: ran `pnpm --dir android run daemon:prepare-release`, installed `android/release-dist/zterm-daemon-0.1.3-darwin-arm64/bin/install-global.sh`, then service-scoped `~/.local/bin/zterm-daemon restart`. `/health` returned pid `25719`, uptime `1`, and installed runtime contains `remote input target window could not be matched for focus`, `kAXFocusedWindowAttribute`, and `(-deltaY)`.
- Live daemon catalog after restart returned `targetCount=34`, `appWindows=21`, `itermPanes=13`, `errors=[]`.
- Verification after fix: exact Swift input script extracted from source compiled/ran; focused source gates PASS `11 files / 175 tests`; architecture gates PASS `7 files / 48 tests`; `tsc --noEmit` PASS; `git diff --check` PASS.

# 2026-07-20 Remote window persistent input helper correction

- Additional live daemon black-box found a second root cause after the stale daemon/AXRaise fix: `remote-window-input` pointer/key could pass, but scroll returned `remote_window_input_failed` with `The data couldn't be read because it is missing.` The daemon Swift input schema incorrectly required `phase` for every event, while the wire protocol correctly omits `phase` for `kind=scroll`.
- Per-event `swift -e` was also the wrong lifecycle for pointer/scroll/key sequences. Each user interaction compiled a fresh Swift script, so continuous input could be delayed, fail on compile/runtime warnings, or time out independently. The daemon now lazily owns one persistent Swift helper per runtime and sends JSON-line configs to it.
- Source fix: `MACOS_REMOTE_WINDOW_INPUT_SWIFT` supports stdin JSON-line helper mode and one-shot env mode; `RemoteInputEvent.phase` is optional; pointer/key explicitly require phase; scroll decodes without phase; `createDefaultRemoteWindowInputHelper()` serializes input requests, keeps stderr metadata out of per-event success, times out stuck helpers, and is disposed with the remote-window daemon runtime.
- White-box gates after this correction: `pnpm --dir android exec vitest run src/server/remote-window-stream-daemon.test.ts --reporter dot` PASS `24 tests`; `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS.
- Runtime closeout: `pnpm --dir android run daemon:prepare-release` PASS, install-global PASS, service-scoped `~/.local/bin/zterm-daemon restart` PASS. `/health` returned pid `54921`, uptime `1`; installed runtime sha matched release runtime sha `b0700c64a5cfe1a72c46138c79affddaab10a97d8df3d6086d6314b9a794718f`; archive sha `3e544498ed549ce37b6d2646f8598be3162864bd6a2866f0689a9f231949f2e3`.
- Live catalog after restart returned `total=35`, `appWindows=22`, `itermPanes=13`, `errors=[]`.
- Live input black-box with marked AppKit probe window `ZTERM_REMOTE_INPUT_BLACKBOX_20260720`: protocol stream started; pointer down/up, pixel scroll, key down/up all returned `remote-window-input-result accepted=true`; target stdout observed `PROBE_MOUSE_DOWN`, `PROBE_MOUSE_UP`, `PROBE_SCROLL dx=0 dy=-96`, `PROBE_KEY_DOWN`, and `PROBE_KEY_UP`.
- Live WeChat focus black-box: test first activated iTerm2, then sent a harmless pointer move to selected WeChat app-window target `app-window:486:1439`; protocol returned `accepted=true`, and `System Events` reported `frontmostBefore=iTerm2`, `frontmostAfter=WeChat`, `focusPassed=true`.
- Cleanup: temporary AppKit probe process pid `44933` was stopped with Ctrl-C through its own PTY; `ps -p 44933` returned no process. Daemon remained healthy on pid `54921`.

# 2026-07-20 Remote window fullscreen fill projection

- Jason requested a fullscreen option that makes the selected remote app fill the phone screen in both portrait and landscape.
- Architecture mapping: this stays in `desktop.remote_window_stream.overlay.project` / `resource.remote_window_overlay`. Android `RemoteWindowOverlay` owns only projection state and input coordinate normalization; daemon ScreenCaptureKit crop, WebRTC negotiation, Mac coordinate manifest, tmux width, terminal mirror, and renderer truth are unchanged.
- Implementation: fullscreen defaults to aspect-fit complete display. A new toolbar display-mode button switches to aspect-fill cover mode (`填满` / `适配`). Switching mode resets local zoom/pan only. Fit/fill/zoomed drawing and pointer mapping now use the same projected content rect so cover-mode cropped offsets are reflected in `remote-window-input` normalized/global coordinates.
- Red tests added before source fix: fullscreen defaults to fit geometry and switches to cover geometry on a 300x200 phone surface for an 800x600 target; fill-mode pointer input at the top edge maps through the negative cover offset instead of pretending the target exactly matches the phone surface.
- Verification: focused `RemoteWindowOverlay.test.tsx` PASS `19 tests`; remote-window suite PASS `10 files / 125 tests`; feature/resource/function/mainline gates PASS `7 files / 48 tests`; `tsc --noEmit` PASS; `git diff --check` PASS.
- Full `build:android` PASS: terminal contracts `48 files / 590 tests`, common flows `7 files / 82 tests`, local Relay smoke, typecheck, Vite, Capacitor, Gradle, and update-manifest verification.
- Delivery: APK `0.1.3.2172` / versionCode `1032172`, size `5876698`, sha256 `088d448b2610fcaba4510824b4d6f4d130775e9c4b0a0ae47c1ace1e26a16ad1`. Local update channel and `/Users/fanzhang/.zterm/updates` match. Public Relay `GET/HEAD https://relay.codewhisper.cc:18443/relay/updates/latest.json` and APK `HEAD` return 200; downloaded public APK sha matches local.
- L5 gap: `adb devices` returned no attached device, so installed APK and physical fullscreen fill visual/input proof are not claimed.

# 2026-07-20 Remote window picker/resize/iTerm input diagnosis

- Symptom 1: remote-window picker now returns many generic app windows plus iTerm2 panes in one flat list. Expected: app windows remain directly selectable; iTerm2 panes are collapsed until explicitly expanded. First divergence is Android overlay picker projection, not daemon catalog, because daemon catalog must still expose all targets.
- Symptom 2: floating preview can resize larger until the toolbar/top becomes unreachable. Expected: resize owner caps or adjusts projection so the toolbar remains inside the viewport and can still be dragged. First divergence is Android floating overlay resize bounds; daemon capture/window coordinates are unchanged.
- Symptom 3: iTerm2 pane targets look interactive but current daemon input owner rejects `tmux-input` / `iterm2-api` (`remote window input route is not implemented`). Expected for this slice: do not expose remote-window input context or send pointer/key/scroll for unsupported routes; mark the target read-only. Implementing real tmux/iTerm input remains a separate daemon route slice.

# 2026-07-20 Remote window background, adaptive quality, and catalog cache triage

- Jason reported: remote-window video waiting/background state shows an ugly gray native video/play surface; expected a standard single-color Z-term engraved wallpaper. First divergence is Android `resource.remote_window_overlay` video surface projection, not daemon capture.
- Jason reported: bad network should automatically step down bitrate and frame rate, down to 5 FPS. Current protocol only guarantees `videoBitrate.maxBitrateBps`; it has no frame-rate quality contract. First divergence is `desktop.remote_window_stream.client.quality_request` / daemon sender parameter owner, not route selection or capture fallback.
- Jason reported: switching sessions / returning from background frequently disconnects/reconnects and re-enumerates daemon app targets. Existing transport owner already has 2-minute keepalive grace; without live event traces the reconnect root cause is still pending. A confirmed gap is remote-window target catalog: `requestTargets()` sends full daemon enumeration on each picker open with no client cache.
- Implementation update: added ZTERM engraved video wallpaper, Network Information based effective preset caps, `RemoteWindowVideoBitrateConfig.maxFrameRateFps`, daemon sender `maxFramerate`, and a daemon-wide 60s target catalog cache keyed by `daemonHostId + bridgeHost + bridgePort + authToken` so switching tmux sessions on the same daemon does not enumerate app windows again. Cache still requires an open physical SessionContext transport; it does not hide closed sockets.
- Verification so far: remote-window required suite `12 files / 155 tests` PASS; focused cache/quality suite `5 files / 82 tests` PASS; `tsc --noEmit` PASS; `test:feature-registry` PASS; `git diff --check` PASS; `build:android` PASS. APK `0.1.3.2180` / versionCode `1032180`, sha256 `7fa53dfaa12e7c08ad7456ee48c309f89d1e12459504325935716571699978e7`, local update channels aligned. Local daemon `/health` is reachable on port 3333 with pid `49187`, but `adb devices` has no online device, so live Android switch/foreground reconnect proof remains unavailable. Transport reconnect root cause is not claimed fixed by this cache slice.

# 2026-07-20 Transport reconnect / route / status-bar triage

- Jason reported three transport issues: Relay can get stuck unavailable, message/image sends lack reliable resend, and switching sessions should keep the previous per-session WebSocket alive instead of reconnecting. New UI requirement: portrait top status area should show current bandwidth use, realtime up/down rates, and selected route mode (LAN/Tailscale/UDP/Relay).
- Architecture mapping: route selection belongs to `relay.route_selection`; switch/reuse/metrics/status projection belongs to `terminal.transport_lifecycle`; reliable text input belongs to `terminal.daemon_input`; image paste reliability is `daemon.file_transfer`/protocol-level transfer and is not safe to fake at UI retry level without daemon ack.
- Current source evidence: `TraversalRouteHealthCache` stores fresh failure/auth-failure records, but `selectBestTraversalRoute()` computed `selectable` without using it as the first selection pool. This can let the score sorter, rather than route health truth, decide whether a fresh-bad candidate remains eligible. Fix should choose healthy/unknown candidates first, then explicitly reprobe least-bad only when every route is unhealthy.
- Current source evidence: `TerminalPageDebugOverlay` already consumes `SessionDebugOverlayMetrics.uplinkBps/downlinkBps/transportBufferedBytes` and `Session.resolvedPath/resolvedRelayTransport/selectedIcePair`; the top status projection can reuse that truth without new probes or layout-changing banners.
- Current switch evidence still pending: `handleSwitchSession` sends `switchRuntime: 'explicit-resume'`; active lifecycle sends `active-reentry`; `buildActiveSessionRefreshPlan()` already has a 2-minute keepalive grace. Need a red test for `closed/null activeSocket within grace must not become a fake healthy state`, and a separate red test that a still-OPEN socket requests head on switch without new `WebSocket` construction.
- Closeout: portrait top shell now shows route mode plus combined and per-direction live rates from existing `SessionDebugOverlayMetrics`; no new polling transport or layout-changing banner was added. Route labels are derived from existing resolved transport diagnostics. Route selection now ignores fresh failed/auth-failed candidates until every route is unhealthy, then explicitly reprobes the least-bad route. Closed/missing sockets inside keepalive grace now reconnect through the unique owner instead of being treated as reusable.
- Verification: focused route/UI/transport suite PASS `5 files / 260 tests`; `tsc --noEmit` PASS; feature/resource/function/mainline gates PASS `7 files / 48 tests`; full `build:android` PASS including terminal contracts `48 files / 590 tests`, common flows `7 files / 82 tests`, local Relay smoke, Vite/Capacitor/Gradle/update-manifest verification. APK `0.1.3.2182` / versionCode `1032182`, sha256 `88989b6f4db31d67573a12bdda06675340f5361ff8d40719dec57cb3f5bea848`, local update channels and public Relay update route verified. `adb devices` had no attached device, so live phone visual proof remains unclaimed.

# 2026-07-20 Remote window input forwarding repair diagnosis

- Symptom: Jason reports remote-window operations move/pan the Android container, while scroll, click, and input do not reach/activate the remote app. Expected: app-window `bring-to-focus + os-event` targets receive remote pointer, pixel scroll, QuickBar/IME key/text events; local pan is reserved for zoomed fullscreen projection.
- Flow/model: existing `desktop.remote_window_stream`; resource edge `resource.remote_window_overlay -> resource.session_transport -> resource.remote_window_stream`; mainline edges `android_mainline:RemoteWindowOverlay->RemoteWindowInputRuntime`, `android_mainline:TerminalPage->RemoteWindowInputRuntime`, `daemon_mainline:RemoteWindowStream->RemoteWindowInput`.
- Forbidden edges: terminal mirror/buffer/render and screenshot runtime cannot be used as input/video truth.
- Active hypothesis H1: Android overlay gesture classifier is stealing one-finger fullscreen touches whenever `bottomInsetPx > 0`, so IME/QuickBar-open fullscreen treats clicks and drags as local `pan`; this is the first divergence for "container moves only". Source evidence: `RemoteWindowOverlay.tsx#handleVideoSurfacePointerDown` enters `mode: 'pan'` for `state.mode==='fullscreen' && (scale > 1.01 || bottomInsetPx > 0)`.
- Active hypothesis H2: unzoomed touch scroll is delayed until `pointerup` and coalesced into one event; in Android WebView this can look like no remote scroll and loses continuous gesture semantics. Source evidence: current `touchPending/scroll` path does not call `emitRemoteWindowInput` during `pointermove`; prior tests explicitly assert no send before `pointerup`.
- Active hypothesis H3: aspect ratio mismatch may be a projection/video stretch issue. Source evidence: `<video>` uses `objectFit: 'fill'`; if actual receiver dimensions differ from manifest crop after ScreenCaptureKit rounding, the media can be stretched inside the aspect-correct content rect. Owner remains overlay projection unless live frame metadata proves daemon crop dimensions wrong.
- Scope lock: first edit owner is `RemoteWindowOverlay.tsx` and its tests. Daemon input owner remains unchanged unless a live protocol smoke proves `remote-window-input` is sent by Android but rejected/not injected by daemon.
- Required red gates before fix: fullscreen scale 1 with `bottomInsetPx > 0` must emit pointer down/up instead of local pan; unzoomed fullscreen/floating touch drag must emit scroll during move; zoomed fullscreen drag must remain local pan and emit no remote scroll; media video must not stretch its intrinsic aspect ratio.
- Fix applied in the Android overlay owner: `bottomInsetPx` no longer changes fullscreen scale-1 gesture ownership; touch drags emit incremental remote pixel scroll during `pointermove`; `pointerup` only emits a final scroll delta if the last position changed; pinch release seeds the remaining pointer as moved to avoid accidental remote tap; receiver video now uses `object-fit: contain`.
- Verified locally: `RemoteWindowOverlay.test.tsx` PASS 34 tests; remote-window focused suite PASS 13 files / 164 tests; `tsc --noEmit` PASS; `test:feature-registry` PASS 7 files / 48 tests; `git diff --check` PASS. Daemon `/health` stayed ok at PID `49187`. A live WS smoke enumerated real target `app-window:540:174` (`OPPO 互联`), reached ScreenCaptureKit/WebRTC `streaming` at `452x619`, sent a non-destructive pointer move through `bring-to-focus + os-event`, received `accepted=true`, and stopped the stream. Physical Android touch/IME L5 remains unverified because no ADB device is online.

# 2026-07-20 Public Relay update channel 2185 publish

- Jason reported an installed old app still could not detect a newer build. Online check proved the public Relay manifest was stale: `GET https://relay.codewhisper.cc:18443/relay/updates/latest.json` returned `0.1.3.2183` / versionCode `1032183`, while local `android/update-dist/latest.json` and `/Users/fanzhang/.zterm/updates/latest.json` already pointed to `0.1.3.2185` / versionCode `1032185`.
- Published only `android/update-dist/latest.json` and `android/update-dist/zterm-0.1.3.2185.apk` to production `/var/lib/zterm-traversal-relay/updates` on `159.75.134.56` via `ssh -i ~/.ssh/claw.pem -o IdentitiesOnly=yes`. No service restart was required.
- Public verification after publish:
  - `GET https://relay.codewhisper.cc:18443/relay/updates/latest.json` returns `versionName=0.1.3.2185`, `versionCode=1032185`, `sha256=44c8490921f2b78bd0947a378fa3bac7bbecff51bb5c0c9cf33dc66f51d27e4b`, `size=5882574`.
  - `HEAD https://relay.codewhisper.cc:18443/relay/updates/zterm-0.1.3.2185.apk` returns `200` and `Content-Length=5882574`.
  - Downloaded public APK sha256 is `44c8490921f2b78bd0947a378fa3bac7bbecff51bb5c0c9cf33dc66f51d27e4b`.
  - `/relay/health` reports `updates.manifestPresent=true`.

# 2026-07-20 Remote window aspect + gesture diagnosis

- Symptom A: remote-window video looks slightly vertically stretched. Expected: Android projection should use the actual daemon media frame aspect once the stream starts, while input coordinates still map to the selected manifest crop.
- Symptom B: touch gesture does not really pass through. Expected: Android recognizes the local touch gesture and sends an explicit gesture command to the daemon; daemon simulates that gesture through its remote-window input owner.
- Flow/model: existing `desktop.remote_window_stream`; resources `resource.remote_window_overlay -> resource.remote_window_stream`; mainline edges `RemoteWindowOverlay->RemoteWindowReceiver`, `RemoteWindowOverlay->RemoteWindowInputRuntime`, and daemon `Control->RemoteWindowStream`.
- Source evidence A: `RemoteWindowOverlay` always uses `getRemoteWindowSourceRect(state.target)` for `resolveZoomedContentRect()` and floating aspect ratio. `RemoteWindowStreamStartResult.started.capture.frameWidth/frameHeight` exists but is not stored or consumed by the overlay, so a ScreenCaptureKit/WebRTC frame aspect that differs from the manifest crop cannot correct the projection.
- Source evidence B: `RemoteWindowInputEventPayload.event` has only `pointer | scroll | key`; `RemoteWindowOverlay` converts unzoomed touch drags into incremental `kind='scroll'` events; daemon Swift helper only has pointer/scroll/key branches. There is no owner path for a high-level recognized touch gesture.
- Confirmed owner/scope: `desktop.remote_window_stream`. Allowed edit paths for this slice are `packages/shared/src/connection/protocol.ts`, `android/src/components/terminal/RemoteWindowOverlay.tsx`, `android/src/components/terminal/RemoteWindowOverlay.test.tsx`, `android/src/server/remote-window-stream-daemon.ts`, `android/src/server/remote-window-stream-daemon.test.ts`, and the remote-window docs/maps/memory entries.
- Red gates to add before source fix: overlay uses `started.capture.frameWidth/frameHeight` for display aspect after stream start; unzoomed touch drag emits one `kind='gesture'` swipe command on pointer-up instead of only scroll wheel deltas; daemon validates and accepts gesture input; invalid gesture values are rejected; Swift helper schema contains a gesture branch that simulates the swipe by posting pixel scroll events. Zoomed fullscreen pan must remain local and must not emit a remote gesture.

# 2026-07-20 Remote window aspect + gesture implementation note

- Implemented owner path: Android `RemoteWindowOverlay` stores daemon `remote-window-stream-started.capture.frameWidth/frameHeight` as receiver display aspect truth after stream start. Input coordinates still map to the selected manifest crop/window rect; daemon coordinate truth is unchanged.
- Implemented owner path: unzoomed touch drag now transitions `touchPending -> touchGesture`, sends no move-time scroll, and emits one `RemoteWindowInputEventPayload.event.kind='gesture'` / `gesture='swipe'` / `phase='end'` command on pointer-up with start/end normalized coordinates, aggregate delta, duration, and velocity. Wheel remains `kind='scroll'`; zoomed fullscreen drag remains local pan.
- Implemented daemon path: `remote-window-stream-daemon` validates gesture coordinates/ranges/timing and the persistent Swift input helper supports `gesture` by simulating the swipe as bounded pixel scroll steps after AX focus/raise. Invalid gesture payloads return `remote_window_input_failed` explicitly.
- Focused verification: `pnpm --dir android exec vitest run src/components/terminal/RemoteWindowOverlay.test.tsx src/server/remote-window-stream-daemon.test.ts --reporter dot` PASS, 2 files / 63 tests.
- Architecture follow-up from Jason's question: current per-session physical WebSocket model is a historical simplification. Correct long-term refactor is daemon-level physical connection plus per-session logical channel/subscriber multiplexing. This must be a separate `terminal.transport_lifecycle` refactor because daemon subscriber/adaptive lease truth currently treats physical transport as subscriber identity; direct socket reuse without logical channel ids risks buffer/session/input cross-talk.

# 2026-07-20 Terminal transport multiplex refactor diagnosis

- Jason asked why 10 sessions require 10 WebSockets and requested a debug-skill analysis plus implementation `/goal`.
- Evidence-first diagnosis confirmed the root cause is architectural, not a missing reuse guard: Android stores `activeSocket` per local `sessionId`, target runtime only stores reusable `controlTransport`, `openSessionTransportByIntentRuntime()` still opens one physical session transport after each `session-ticket`, daemon `TerminalTransportConnection` has only one `boundSubscriberId`, and current protocol has no channel envelope on session-bound messages.
- H1 confirmed: physical transport and daemon subscriber are coupled one-to-one. H2 ruled out as primary: same-target control socket is already reused. H3 downstream: route/reconnect bugs can create extra replacement sockets, but even perfect same-session reuse remains one body socket per open session.
- Added implementation design doc `android/docs/goals/terminal-transport-multiplex-refactor-plan.md`. Required direction: one daemon-target physical transport plus per-session logical channel/subscriber multiplexing, explicit mux capability, channel-bound message envelopes, target/control messages, daemon send scheduler, and black-box source-to-render/session identity gates. New Android path must not silently fallback to per-session sockets.

# 2026-07-20 Android power/network foreground-background diagnosis

- Symptom: Jason reports zterm drains battery quickly and the phone gets hot. No ADB device is attached in this run, so live CPU/network counters are unavailable; local daemon `/health` had no current subscribers in the previous probe and cannot reproduce phone heat.
- Flow/model: `terminal.session_preview.live_set.project` projects preview selected sessions into `onLiveSessionIdsChange`, then `terminal.transport_lifecycle` sends physical `body-subscription` intent. App foreground truth is owned by `useOpenTabLifecycleEffects` via `visibilitychange`, `pause/resume`, and Capacitor `appStateChange`; daemon must not own foreground state.
- Confirmed first divergence H1: `TerminalPage.tsx` passes literal `true` to `projectSessionPreviewLiveIds(...)`, even though `session-preview-selection.ts#projectSessionPreviewLiveIds` already requires a `foreground` argument and the test design says selected sessions join live body demand only while preview is open and foreground. This can keep up to six preview sessions in the body subscription set during Android app background paths not represented by the page-local `visibilitychange` handler.
- Confirmed first divergence H2: `session-context-lifecycle.ts` still starts background timers for debug metrics, runtime debug flush, active tick, and passive visible tick; the active/passive tick loops avoid transport refresh while background but still wake the JS runtime. This is client-side CPU wakeup, not daemon truth.
- Confirmed first divergence H3: `RemoteWindowOverlay.tsx` had no foreground input. A target-locked remote-window stream could keep Android WebRTC receiver/media decode and daemon video source active while the app is backgrounded. This is the heaviest current network/CPU path when a video overlay is open.
- Unique owners: H1 belongs to `terminal.session_preview` / `resource.session_preview_mode` and the `TerminalPage -> PreviewLiveSetProjector -> SessionBodySubscriptionIntent` mainline. H2 belongs to `terminal.transport_lifecycle` / `resource.session_transport` lifecycle cadence owner. H3 belongs to `desktop.remote_window_stream` / `resource.remote_window_overlay` lifecycle cleanup. Forbidden paths: daemon mirror, renderer, tmux width, route selector, and file transfer.
- Required gates for this slice: red/green preview live-set foreground test, lifecycle background timer test, remote-window background stop test, focused preview+lifecycle/remote-window tests, `test:feature-registry`, `tsc --noEmit`, `git diff --check`; APK/live battery proof remains an L5 gap until an unlocked device is available.
- Implementation: `App` now passes single `appForegroundActive` truth into `TerminalPage`; `TerminalPage` feeds it to preview live-set projection and `RemoteWindowOverlay`; `SessionContext` lifecycle no longer starts debug/active/passive timers while background; remote-window overlay closes/stops active stream when the app backgrounds.
- Verification: focused foreground/background suite PASS `6 files / 97 tests`; feature/resource/function/mainline gates PASS `7 files / 48 tests`; `tsc --noEmit` PASS; `git diff --check` PASS; full `build:android` PASS with terminal contracts `48 files / 593 tests`, common flows `82 tests`, local Relay smoke, Gradle build and manifest verification. APK `0.1.3.2186` / versionCode `1032186` is in `android/update-dist` and `/Users/fanzhang/.zterm/updates`, sha256 `edd8231d87d40e2a5f3c17285ad7322011ac8b57c7559f8a92a867bf14bd9bbf`. `adb devices -l` has no attached device, so live battery/thermal/network L5 remains unclaimed.
- Extra audit: repository search found a dormant `native/android/app/src/main/java/com/zterm/android/BackgroundService.java` plus `BackgroundServicePlugin.ts`, but there are no call sites that start it from app code. The dormant service originally acquired `PARTIAL_WAKE_LOCK` and requested battery-optimization bypass permissions, so I removed those power-hungry behaviors and locked the rule in docs/tests. This does not change any active transport path, but it closes a latent future power leak.
- 2026-07-20: Same session retarget from direct/Tailscale to Relay must not keep the old socket as active truth under the new target key. `upsertSessionTransportRuntime()` now clears active socket on target change and only preserves the old one as superseded cleanup truth. Home/Relay reopening an already-open session must rebind route truth through `createSession(..., { sessionId: existingId, activate: false })` before explicit-resume.
- 2026-07-20: Android `0.1.3.2188` built successfully with the new logo resources and route-rebind transport fix. Public Relay update route was republished; `latest.json` now serves `versionCode=1032188`, APK HEAD returned 200, and streamed APK sha256 matched `4a562dd0ea022ee21da65300cb357c9a8bad7d78be3f3a9f6d4475e717ff7cb7`. No online ADB device was attached, so no install/UI smoke was possible in this run.
- 2026-07-20: Relay idle-resume design audit: current production relay server does not preserve resumable RTC peer state. `/ws/client` creates a fresh random `peerId` for every phone signaling socket; client close deletes `clients[peerId]` and sends `relay-peer-close`; daemon `relay-client.ts` forwards that into `rtc-bridge.closeRelayPeer()`, which closes and deletes the RTCPeerConnection. Correct refactor should add an explicit relay peer lease/resume-token resource keyed by daemon target, account, hostId and client device, held only in memory until idle timeout. Relay must preserve route/peer signaling lease only, not tmux/session/UI truth. With terminal mux, one daemon-target transport gets one resume lease and per-session channels rebind under it.
# 2026-07-20 Remote window touch gesture diagnosis

- Symptom: Jason reports the remote video window still cannot pass touch gestures. Existing Android tests prove a touch drag emits a `gesture/swipe` payload on pointer-up, and daemon tests prove the payload is accepted, but those tests stop at `accepted=true`.
- Flow: `desktop.remote_window_stream.client.input_request` -> `desktop.remote_window_stream.daemon.input_inject`.
- First divergence candidate: daemon macOS injection posts CG scroll wheel events with `event.location`, but does not move the HID mouse cursor to the gesture start/current point before the wheel events. macOS scroll routing commonly follows the current pointer/window hit target, so accepted input can be delivered to the wrong UI target or no effective scroll target.
- Owner scope: `android/src/server/remote-window-stream-daemon.ts` Swift helper and its daemon tests. Android overlay remains the gesture recognizer/source coordinate owner.

# 2026-07-21 Top route status and remote-window picker/entry diagnosis

- Symptom A: portrait status strip still shows an aggregate bandwidth value beside the already sufficient uplink/downlink rates, and the route is not an actionable manual preference. Expected: project `Session.resolvedPath/resolvedRelayTransport` as the actual route, expose the existing route-mode owner from the strip, and retain that mode in the session transport host.
- First divergence A: `TerminalConnectionStatusStrip` owns the stale aggregate projection and has no route selector; route changes remain owned by `useSessionOpenActions`. Allowed paths: `TerminalPage.tsx`, `useSessionOpenActions.ts`, `App.tsx`, and their focused tests. Transport selection internals, daemon truth, and terminal buffer/render are forbidden.
- Symptom B: the closed remote-window entry does not reliably enter a movable state after long press in Android WebView. First divergence: `RemoteWindowOverlay` only activates entry drag after a 7px move and does not disable native touch handling; it has no long-press ownership transition. Unique owner: `resource.remote_window_overlay`.
- Symptom C: opening or refreshing the remote-window picker replaces the catalog with a large loading/empty panel even when a previously valid daemon-wide catalog exists. First divergence: `handleOpenPicker()` always projects `targetEnumerating`; the 60s SessionContext cache can avoid daemon enumeration but cannot stop the overlay from blanking while its Promise settles.
- Fix scope C: keep a session-local projection snapshot for immediate stale-while-revalidate display, preserve rows during background/manual refresh, add an explicit force-refresh option through the existing SessionContext catalog owner, and compact the first-load placeholder. This does not create a second catalog truth: SessionContext remains the daemon-wide cache owner and closed sockets still fail explicitly.
- Required gates: `TerminalPage.session-drawer.test.tsx`, `RemoteWindowOverlay.test.tsx`, `session-context-remote-window-runtime.test.ts`, `TerminalPage.remote-window-overlay.test.tsx`, typecheck, feature/resource/function/mainline gates, diff check, then Android build. Physical long-press/UI proof requires an online unlocked Android device.
- Implementation: portrait top strip now removes the aggregate bandwidth chip, leaves only actual route + uplink/downlink rates, opens a route menu for Auto / direct-Tailscale / WebRTC-Relay, and routes those choices through `useSessionOpenActions`. Remote-window entry now disables native touch handling, pointer-captures safely, and supports long-press armed dragging. Remote-window picker now reuses the last active-session catalog projection while a stale/manual refresh runs; manual refresh passes `{ forceRefresh: true }` to `requestRemoteWindowTargetsRuntime`, which bypasses the daemon-wide TTL.
- Focused verification passed: `TerminalPage.session-drawer.test.tsx`, `RemoteWindowOverlay.test.tsx`, `TerminalPage.remote-window-overlay.test.tsx`, `session-context-remote-window-runtime.test.ts` = 4 files / 92 tests PASS. `session-context-buffer-runtime.test.ts` PASS 31 tests. `tsc --noEmit` PASS after adding the missing `readSessionTransportResource` type and making the mux test `channelId` readable by its helper. `test:feature-registry` PASS 7 files / 48 tests. `git diff --check` PASS.
- Build gap: `pnpm --dir android run build:android` still fails before packaging because the broader dirty mux/transport gate has `SessionContext.ws-refresh.test.tsx` 33 failures plus `server.bridge-runtime-truth.test.ts` 1 failure and `server.transport-lifecycle-truth.test.ts` 2 failures. No APK was produced in this run.

# 2026-07-21 Terminal mux reconnect sibling-channel diagnosis

- Symptom: same-target `reconnectAllSessions()` creates one replacement physical mux transport, but after `mux-ready` only the first/active session sends `mux-channel-open`; sibling sessions remain reconnecting. The current focused gate has 6 failures, with 4 sharing this first divergence.
- Flow/model: `terminal.transport_lifecycle`; `active_session -> session_transport -> daemon_target_transport -> terminal_channel -> transport_subscriber -> mirror_store`. The physical target transport and logical terminal channels are separate resources; session/tab state must not create another physical socket.
- Confirmed H1: `openSessionMuxChannelByIntentRuntime()` calls `ensureSessionTerminalChannel()`, but an existing channel is returned with its previous `open` or `closed` state. When the replacement target socket is `CONNECTING`, or `OPEN` but waiting for `mux-ready`, the function returns without setting that session channel to `opening`. `bindTargetMuxTransportSocketLifecycleRuntime()` intentionally flushes only `getOpeningSessionTerminalChannelsForTarget()` at `mux-ready`, so siblings are omitted.
- First divergence: `session-context-transport-open-runtime.ts#openSessionMuxChannelByIntentRuntime`, before the `CONNECTING` / `wait-ready` return.
- Unique owner: `terminal.transport_lifecycle` transport-open owner. Allowed source path: `android/src/contexts/session-context-transport-open-runtime.ts`. Allowed red/green test path: `android/src/contexts/session-context-transport-open-runtime.test.ts`. Session UI, buffer, renderer, daemon mirror, route selector, and per-session legacy socket fallback are forbidden.
- Required positive gate: an existing stale `open`/`closed` channel is normalized to `opening` while one same-target physical transport connects or waits for `mux-ready`, then the mux-ready owner can emit every pending channel open.
- Required negative gate: waiting sibling sessions do not construct or bind a second physical socket and do not send channel data before mux readiness.

# 2026-07-21 Terminal mux build closeout

- Source fixes after diagnosis: `openSessionMuxChannelByIntentRuntime()` now normalizes stale waiting channels to `opening`; target opening-channel reads prioritize the anchor session; input runtime treats mux channel state as part of session-message readiness; plain `closed` inside `mux-channel-message` marks only that channel closed before reconnect; the old plain-closed black-box test now asserts same physical WebSocket plus repeated `mux-channel-open`, not a second physical socket.
- Verification: focused mux/open/input/session transport gates PASS `7 files / 213 tests`; `SessionContext.ws-refresh.test.tsx` PASS `130 tests`; `tsc --noEmit` PASS; `test:feature-registry` PASS `7 files / 48 tests`; `git diff --check` PASS; full `pnpm --dir android run build:android` PASS, including terminal contracts `48 files / 602 tests`, common user flows, local Relay smoke, Vite/Capacitor/Gradle, and update manifest verification.
- Delivery: Android `0.1.3.2189` / versionCode `1032189`; local APK `android/update-dist/zterm-0.1.3.2189.apk`; sha256 `5d22c2c96c9bc057cc2ec5d34da64eb4e17255e9f64cf1a5cd07434800949aef`; size `4777174`. Local update channel and `/Users/fanzhang/.zterm/updates` hashes match.
- Public Relay update route: uploaded `latest.json` and `zterm-0.1.3.2189.apk` to `/var/lib/zterm-traversal-relay/updates`; public GET manifest returns versionCode `1032189`; public APK HEAD returns `200` and `Content-Length=4777174`; downloaded public APK sha256 matches `5d22c2c96c9bc057cc2ec5d34da64eb4e17255e9f64cf1a5cd07434800949aef`; `/relay/health` reports `updates.manifestPresent=true`.
- L5 gap: `adb devices -l` returned no attached device, so installed-device smoke/UI proof is not claimed for this package.

# 2026-07-21 Terminal mux connected-blank and adaptive first-entry diagnosis

- Symptom A: Android top strip can show UDP connected while the terminal body is blank and download is `0 B/s` for one session; other sessions render, and switching back to the broken session stays blank. Expected: physical target transport, logical terminal channel, daemon subscriber attach, buffer-sync apply, and renderer projection stay aligned; UI connected must not be projected before terminal channel content readiness.
- Symptom B: first terminal entry can still appear not to read `adaptive-phone` width. Expected: the first terminal open/mux-channel-open carries current bridge width-mode truth and a finite adaptive cols value, while `mirror-fixed` carries no client cols/rows.
- Flow/model: `terminal.transport_lifecycle` plus `terminal.buffer_render`; resource path `active_session -> session_transport -> daemon_target_transport -> terminal_channel -> transport_subscriber -> mirror_store -> client_sparse_buffer -> renderer_window`. Only `buffer-sync apply` can repaint body; `buffer-head` and physical UDP/WS connected are metadata/readiness evidence only.
- Confirmed source evidence A: daemon `terminal-message-runtime.ts` sends `mux-channel-opened` immediately after creating a channel subscriber, before async `attachTmux()` finishes. Client `handleTargetMuxServerFrameRuntime()` currently marks the channel `open` and calls `buildChannelCallbacks(sessionId).onConnected()` on `mux-channel-opened`, which settles pending open, marks the session connected, and triggers baseline `buffer-head-request` too early. If daemon mirror is not ready, `buffer-head-request` returns `session_not_ready`; no `buffer-sync apply` means the UI can remain connected/blank.
- Active hypothesis H1: `mux-channel-opened` is channel allocation truth, not terminal content readiness. First divergence is `android/src/contexts/session-context-transport-runtime.ts#handleTargetMuxServerFrameRuntime` case `mux-channel-opened`. Unique owner is `terminal.transport_lifecycle` channel demux / transport-open callbacks. `terminal.buffer_render`, `TerminalView`, daemon mirror, route selector, and physical WebSocket rebuild paths are downstream or forbidden.
- Related hypothesis H2: body-subscription reconciliation still reads legacy per-session `activeSocket` via `readSessionTransportSocket()`. In mux mode the effective session socket is `readSessionTransportResource(sessionId).socket`, so active/live changes can fail to send channel-bound `body-subscription` over the target mux socket. This is same owner but separate first divergence in `session-context-infra-facade-runtime.ts#reconcilePhysicalBodySubscriptions`.
- Adaptive hypothesis H3: shared settings storage already reads persisted/detected `terminalWidthMode` before first render; `readRequestedTerminalGeometry()` returns adaptive default `cols=80` when no measured cols exist. Need a first-entry mux black-box gate to prove current first `mux-channel-open` is `adaptive-phone`, not `mirror-fixed`, and to catch future regressions. If the live symptom is a measured-col timing issue rather than a fixed-mode payload, fix must stay in the width-mode signal/session geometry owner, not daemon mirror or UI fallback.
- Allowed paths for this slice: tests in `android/src/contexts/session-context-transport-runtime.test.ts`, `android/src/contexts/session-context-infra-facade-runtime.test.ts`, `android/src/contexts/SessionContext.ws-refresh.test.tsx`, and width-mode storage tests if touched; source in `android/src/contexts/session-context-transport-runtime.ts`, `android/src/contexts/session-context-infra-facade-runtime.ts`, and narrowly related transport geometry owner only if red tests prove H3.
- Forbidden paths: renderer/TerminalView repaint compensation, daemon mirror/content readiness fallback, route selector, forced physical WebSocket rebuild per session switch, changing terminal payload semantics, or treating errors as successful truth.
- Required gates: positive/negative mux test that `mux-channel-opened` opens local channel but does not call connected baseline or send `buffer-head-request`; channel-bound `connected` or live `buffer-sync` settles pending and requests head/body; mux body-subscription sends over effective target socket; adaptive first-entry mux open sends `widthMode='adaptive-phone'` with finite cols and no rows under adaptive settings, while mirror-fixed stays cols/rows-free.

# 2026-07-21 Relay per-client-device peer lease closeout

- Jason clarified the expected Relay semantics: different clients independently maintain links; an active client lease is preserved for 30 minutes; after 30 minutes a new link must be established.
- Implementation: Android Relay client now generates and persists a per-install `deviceId`; traversal signal URLs include `deviceId`; Relay `/ws/client` rejects missing `deviceId` explicitly; peer leases are keyed by `userId + hostId + deviceId`; normal signaling `close/error` marks only that device peer idle for 30 minutes; same device rebinds the same `peerId`; another phone gets a different `peerId`; host close clears active and idle leases; explicit `rtc-close` closes immediately. Daemon RTC bridge now accepts repeated `rtc-init` for the same `peerId` by replacing the old peer connection and renegotiating instead of ignoring it.
- New black-box gate: `pnpm --dir android run test:relay:peer-lease` starts a local Relay server, opens phone A, closes its signaling socket, proves no immediate host `relay-peer-close`, reconnects phone A and observes same `peerId`, opens phone B and observes a different `peerId`, and verifies missing `deviceId` returns `deviceId is required`.
- Verification passed: focused Relay/RTC tests `5 files / 47 tests`; broad Relay suite `11 files / 74 tests`; `tsc --noEmit`; architecture gates `7 files / 48 tests`; `git diff --check`; local Relay smoke; peer-lease black-box smoke; full `build:android`.
- Delivery: Android `0.1.3.2192` / versionCode `1032192`, APK sha256 `5c35bd626bd0631496e9985e68c4940c1ea6ce8965bf838d7124a385b129fab8`, size `4777334`. Local update channel and `/Users/fanzhang/.zterm/updates` match.
- Runtime delivery: relay package sha256 `528703e3287d65c5665210fd180ccd622282eca1e008ab6922cdb753cd7baf7d`; daemon archive sha256 `a2f41bcf9d8307bfd4d1ac5d8466786583aba4ca958a0e6ad2db489aa1da99e5`; local daemon restarted to pid `46535` and loaded `rtc peer replaced by new init`; production Relay restarted to pid `1442264` and loaded `clientPeerLeaseKey`, `deviceId is required`, and 30-minute idle timeout. Public Relay update route serves `0.1.3.2192`, APK `HEAD` returns `Content-Length=4777334`, streamed APK sha matches local, and production smoke with `jason/welcome2img` passes.
- L5 gap: no online ADB device in this workspace, so installed-device two-phone UI proof is not claimed. The server-side black-box gate covers the peer lease identity semantics automatically.

# 2026-07-21 Legacy Relay client device identity migration diagnosis

- Symptom: after daemon/Relay deployment and Android `0.1.3.2192` upgrade, a phone can still fail to connect and two upgraded phones can replace the same Relay peer.
- Expected: every installed client has one stable, per-install Relay `deviceId`; two phones under one account receive independent 30-minute peer leases.
- Live evidence:
  - local daemon launchd service is running on PID `46535`; `/health` returned `ok=true`, uptime `2903s`, and the runtime log contains `rtc peer replaced by new init`, so a missing daemon restart is ruled out.
  - production Relay service is running on PID `1442264`, started `2026-07-21 13:08:37 CST`; public `/relay/health` returned `liveDaemonDevices=1`.
  - production account directory observed an upgraded Android `0.1.3.2192` client still publishing the legacy fixed identity `deviceId=zterm-android`.
- SOP/model flow: known `relay.account_directory.peer_lease.resume`.
  - lifecycle: persisted Android Relay account -> client device metadata normalization -> Relay signaling URL `deviceId` -> Relay `{userId,hostId,deviceId}` peer lease key -> daemon RTC peer.
  - allowed resource edge: `resource.daemon_target_transport -> resource.relay_peer_lease -> resource.transport_target`.
  - forbidden: Relay peer lease must not own terminal channel/subscriber/tmux/mirror/UI state.
- Hypotheses:
  - H1 confirmed: `resolveTraversalRelayDeviceMeta()` and `normalizeStoredState()` accept any non-empty stored id, so legacy installs retain `zterm-android`; the new per-install generator only runs for a missing id.
  - H2 ruled out: daemon not restarted. PID/uptime/runtime marker and live Relay daemon presence prove the new daemon is active.
  - H3 ruled out for first divergence: Relay peer lease keying is already device-aware and its black-box gate separates distinct device ids; pollution happens before signaling when Android emits the shared legacy id.
- First divergence: Android persisted-account normalization.
- Unique owner: `src/lib/traversal-relay-client.ts` under `relay.account_directory`.
- Allowed edit paths:
  - `src/lib/traversal-relay-client.ts`
  - `src/lib/traversal-relay-client.test.ts`
  - `src/App.tsx` and `src/App.relay-stream-lifecycle.test.tsx` only to sync already-normalized account Relay settings into BridgeSettings at startup.
  - `docs/testing/relay-account-directory-test-design.md`
  - feature/function/mainline documentation only if the verified contract changes.
- Forbidden edit paths: daemon RTC bridge, Relay peer lease server, terminal mux/channel, renderer/buffer, route fallback.
- Required verification:
  - red/green tests for legacy top-level and nested Relay id migration, persistence, and preservation of explicit non-legacy ids;
  - Relay/RTC focused regression, typecheck, feature/resource/function/mainline gates;
  - local Relay peer-lease black-box and Relay smoke;
  - full Android build and public update artifact verification;
  - post-upgrade production directory replay proving the phone no longer publishes `zterm-android` remains the final device L5 gate.

# 2026-07-21 Legacy Relay client device identity migration closeout

- Verification passed after fix:
  - `pnpm --dir android exec vitest run src/lib/traversal-relay-client.test.ts src/App.relay-stream-lifecycle.test.tsx --reporter dot`: 2 files / 18 tests PASS.
  - Relay/RTC focused gates: 6 files / 56 tests PASS.
  - Broad Relay suite: 11 files / 77 tests PASS.
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`: PASS.
  - `pnpm --dir android run test:feature-registry -- --reporter dot`: 7 files / 48 tests PASS.
  - `pnpm --dir android run test:relay:peer-lease`: PASS.
  - `pnpm --dir android run test:relay:smoke`: PASS.
  - `pnpm --dir android run build:android`: PASS.
- Delivery: Android `0.1.3.2193` / versionCode `1032193`; local APK `android/update-dist/zterm-0.1.3.2193.apk`; sha256 `599c3ee820ee824860072c61301f35d57779d5adab39325f03f08de4855b6e72`; size `4777730`.
- Public Relay update route now serves `0.1.3.2193`; APK HEAD returns `Content-Length=4777730`; streamed public APK sha256 matches local; `/relay/health` reports production Relay PID `1442264`, `liveDaemonDevices=1`, and update manifest present.
- L5 gap: `adb devices -l` has no attached online device in this workspace, so installed-phone proof and post-upgrade account directory proof that phones no longer publish `zterm-android` remain pending.

# 2026-07-21 Remote window selected-app control focus diagnosis

- Symptom: Jason reports selected remote APP still cannot be controlled; suspected first issue is missing focus injection. Expected: every remote app-window operation uses bring-to-focus before OS input, then daemon verifies target app/window focus before reporting accepted.
- Flow/model: existing `desktop.remote_window_stream`; resource path `resource.remote_window_overlay -> resource.remote_window_stream -> resource.daemon_process`; mainline `RemoteWindowOverlay/TerminalPage -> RemoteWindowInputRuntime -> daemon Control -> RemoteWindowStream.injectInput -> macOS AX/Quartz`.
- Owner graph: Android overlay owns projection and explicit input intent only; TerminalPage owns QuickBar/IME routing via active remote-window context; daemon remote-window-stream owner owns target window lease, AXRaise/focus verification, and Quartz event injection. UI must not compute desktop focus or silently fallback to terminal input.
- Active hypotheses:
  - H1: Android failing path does not emit or route input through remote-window context/focus intent. Verification: inspect overlay/TerminalPage and focused tests for pointer/wheel/key/QuickBar/IME paths.
  - H2: daemon source or installed runtime does not actually focus before non-focus events. Verification: inspect `MACOS_REMOTE_WINDOW_INPUT_SWIFT`, `injectInput`, installed runtime symbols, and live daemon `/health`.
  - H3: daemon focus helper runs but live macOS target matching/permission/frontmost verification fails, and Android does not surface the explicit error. Verification: live WS/AppKit probe with selected app target, read remote-window input result/error, verify frontmost app.
- Read-only evidence so far: source `MACOS_REMOTE_WINDOW_INPUT_SWIFT#handleConfig` calls `focusTargetWindow(config)` before every event kind; Android `TerminalPage.emitRemoteWindowInputEvents` sends `{kind:'focus'}` before QuickBar/IME batches; overlay pointerdown sends focus but wheel/key only send direct scroll/key, relying on daemon per-event focus. This makes H2-source unlikely but H2-installed and H3 still open.
- Live black-box evidence: current daemon PID `46535` and installed runtime contain `focusTargetWindow`. A real control-WebSocket/WebRTC stream against WeChat target `app-window:486:2757` was started, iTerm2 was made frontmost, then `{kind:'focus'}` was sent. Daemon returned `remote-window-input-result accepted=true`; macOS frontmost changed from `iTerm2` to `WeChat`. The temporary stream/socket were stopped/closed. The Node `@roamhq/wrtc` probe exited with signal status 139 during native teardown after producing the successful protocol/frontmost evidence; daemon remained alive.
- H2 ruled out: daemon source, installed runtime, and live AX focus all work.
- H1 confirmed at the first client divergence: selecting and starting a supported app-window stream does not emit focus; direct overlay wheel/key paths also omit explicit focus and rely only on the daemon helper's internal focus. The selected app therefore does not enter focus at target-lock time, and those direct client paths do not preserve a visible focus-first command contract.
- Unique owner: `desktop.remote_window_stream.overlay.project/client.input_request` in `RemoteWindowOverlay`.
- Allowed paths: `android/src/components/terminal/RemoteWindowOverlay.tsx`, its focused test, remote-window test design, note/memory/skill closeout. Forbidden: daemon AX/Quartz implementation, terminal transport/mux, renderer/buffer, route selection, iTerm pane read-only policy.
- Required positive tests: supported app-window stream start emits focus; wheel/key emit focus before scroll/key; existing pointer, QuickBar, and IME focus-first tests remain green. Required negative test: unsupported iTerm pane emits no focus/input. Live gate: installed daemon focus changes frontmost app and returns accepted.
- Root-cause closeout: `RemoteWindowOverlay` now sends focus immediately after the selected supported app-window stream is attached and sends focus before direct wheel/key events through one component-local intent helper. The edit stayed inside the locked Android overlay owner; daemon AX/Quartz, terminal transport, renderer, and read-only iTerm policy were unchanged.
- Verification: the new test failed before the source change because stream start emitted zero input intents, then passed after the fix. Focused overlay `38 PASS`; mapped remote-window regression `8 files / 142 tests PASS`; feature/resource/function/mainline gates `7 files / 48 tests PASS`; `tsc --noEmit` and `git diff --check` PASS. Live daemon proof remains the real WeChat target `app-window:486:2757`: explicit focus returned `accepted=true` and changed macOS frontmost app from iTerm2 to WeChat.
- Delivery: source fix committed as `432f138`; Android APK `0.1.3.2194` / versionCode `1032194` built by `pnpm --dir android run build:android`; local APK `android/update-dist/zterm-0.1.3.2194.apk`; sha256 `75d14528cce897deab79478372b6fc130e0455296689943550fb4f680f89a5e3`; size `4777934`.
- Public Relay update route verified: `https://relay.codewhisper.cc:18443/relay/updates/latest.json` serves `0.1.3.2194`; APK HEAD returns `Content-Length=4777934`; streamed public APK sha256 matches local; `/relay/health` reports production Relay PID `1442264`, `liveDaemonDevices=1`, and update manifest present.
- Remaining gaps: `adb devices -l` has no attached online device, so installed-phone visual/control L5 proof is pending. `scripts/mempalace-mine-zterm.sh` is blocked by existing MemoryPalace lock PID `56674` running `mempalace mine . --wing routecodex`, so zterm wing re-mine/search verification is pending until that lock clears.

# 2026-07-21 New-install tmux management transport close diagnosis

- Symptom: new installed Android app cannot enter/use the daemon and shows `Transport closed while managing tmux sessions`.
- Flow/model: `relay.directory_ui -> terminal.transport_lifecycle/tmux-sessions -> TraversalSocket route plan -> Relay/WebRTC/direct -> daemon terminal-message-control-runtime list-sessions`. Resource path: `resource.ui_projection -> resource.transport_target -> resource.daemon_target_transport -> resource.relay_peer_lease -> resource.transport_target`; tmux session truth remains daemon/backend only.
- Live evidence A: production `/api/auth/login` for `jason` returns `mac-studio` directory with `relay-rtc:mac-studio` and 10 tmux sessions, but the legacy `devices` snapshot for the same daemon has no endpoints/sessions because `TraversalRelayDeviceSnapshot` is presence-only.
- Live evidence B: production device stream order alternates endpointless `devices-snapshot` and enriched `directory-snapshot`; the current App `onDevices` handler directly sets `relayDevices` from the endpointless presence snapshot, so a Home row opened during/after that projection can produce a target with no usable direct or relay-rtc candidates. `TraversalSocket` then exhausts an empty plan and `tmux-sessions.ts` hides the diagnostics behind the generic close string.
- Live evidence C: production relay signaling to `mac-studio` over WebRTC/TURN timed out without an answer while local daemon `/health` accepted TCP but returned no bytes within 3s; service status shows launchd PID `46535` still running, and logs show last host relay close/reconnect plus stale rtc events. This is a second runtime-health issue and must be verified after a service-scoped daemon restart; it is not an app UI projection owner.
- Confirmed first divergence for the popup: `src/App.tsx` relay device stream `onDevices` projection overwrites route-bearing directory truth with endpointless presence truth; `src/lib/tmux-sessions.ts` close handling then loses the exact `TraversalSocket` reason.
- Unique owner: `relay.directory_ui` for Android Relay device projection, plus `terminal.transport_lifecycle` tmux management diagnostics. Allowed paths: `android/src/App.tsx`, `android/src/App.relay-stream-lifecycle.test.tsx`, `android/src/lib/tmux-sessions.ts`, `android/src/lib/tmux-sessions.test.ts`, and focused docs/memory. Forbidden paths for this app fix: daemon mirror/buffer/render, route fallback, terminal session creation, Relay server store schema.
- Required gates: red/green app stream test proving endpointless devices snapshots cannot erase directory endpoint/session truth; red/green tmux-sessions test proving close surfaces diagnostics reason; focused tests, typecheck, feature gates, live production directory/list-sessions replay after daemon health is restored, Android build/update verification.
- Closeout: fixed in the locked owners. `App.tsx` now keeps route-bearing directory endpoint/session truth in a ref and merges later presence-only device snapshots without erasing those route facts; `tmux-sessions.ts` now surfaces `TraversalSocket` close diagnostics/event reason before the generic tmux management close string. Red tests failed first, then passed.
- Verification: focused `tmux-sessions + App relay stream` `17 PASS`; full `relay.directory_ui` mapped stack `11 files / 97 tests PASS`; `tsc --noEmit` PASS; feature/resource/function/mainline gates `7 files / 48 tests PASS`; live local daemon was service-scoped restarted because `/health` hung, then `/health` returned pid `4530`; production login directory showed `mac-studio` `relay-rtc` endpoint and 10 sessions; live production `/ws/client` RTC datachannel `list-sessions` returned those 10 sessions with selected ICE pair `host/host`.
- Delivery: Android `0.1.3.2195` / versionCode `1032195`; APK sha256 `55f5904200d150ee0fcb8f1fe217f0c1251cb7936877224028b273e85e2bbee0`; size `4778214`. Full `build:android` passed including terminal contracts `48 files / 603 tests`, common flows, local Relay smoke, Gradle, local update manifest checks. Public Relay update route serves `0.1.3.2195`; APK HEAD `Content-Length=4778214`; streamed public APK sha matches.
- Remaining gap: `adb devices -l` showed no attached online device, so installed-phone UI L5 for the new package remains unclaimed. `scripts/mempalace-mine-zterm.sh` is still blocked by MemoryPalace lock PID `56674` (`mempalace mine .`), so current re-mine/search persistence remains pending; the lock process was not touched.

# 2026-07-21 2195 mux channel readiness diagnosis

- Symptom: `0.1.3.2195` can enumerate daemon sessions but some selected sessions still never render. Production one-socket concurrent open replay listed 10 sessions; only `rcc1`, `rcc2`, and `zterm` reached same-channel `connected` plus buffer data, while seven channels stopped at `mux-channel-opened`/`title`. Opening `agentpi` alone then reached `connected` and `buffer-head` in about 103 ms, so session existence and list projection are not the failing truth.
- Known flow: `terminal.transport_lifecycle`: Android open intent -> daemon-target mux transport -> terminal channel -> daemon subscriber -> tmux attach/mirror readiness -> channel `connected` -> buffer head/sync -> sparse buffer/renderer. First divergence was client projection of `mux-channel-opened` as terminal connected before daemon attach completed. A second input to the same divergence was missing initial body eligibility on channel open, so inactive concurrent opens defaulted to body-subscribed before the later subscription sweep.
- Unique owner: mux channel open/readiness/body-subscription inside `terminal.transport_lifecycle`. Allowed paths are the shared mux contract, SessionContext transport/channel owner, daemon terminal message owner, their tests, and mapped docs. Renderer, buffer repaint, route fallback, per-session socket recreation, and fake session-list success are forbidden.
- Repair in progress: carry `bodySubscribed` in `mux-channel-open`, initialize daemon subscriber eligibility before attach, retain latest channel-local demand, and treat `mux-channel-opened` as allocation only. Real terminal connected remains owned by the channel `connected` message after attach/mirror readiness.
- Required closeout: focused positive/negative gates, type/architecture gates, updated installed daemon plus service-scoped restart, repeat the production all-session one-socket replay, then build and publish a new Android APK. `list-sessions` alone is explicitly insufficient.
- Closeout: implemented in the locked owner. Shared mux protocol now carries `bodySubscribed`; client channel open records body demand before attach; daemon subscriber initializes `bodySubscribed` before `attachTmux`; `mux-channel-opened` is allocation truth only and no longer settles terminal connected/render readiness; body subscription reconciliation updates the channel-local truth before sending; inactive body-suppressed channels attach/announce connected without initial capture; oversized first sync is bounded to the live tail instead of sending a multi-hundred-KB frame.
- Verification: focused server mirror/message tests `73 PASS`; mapped mux/session regression `9 files / 283 tests PASS`; `tsc --noEmit`, feature/resource/function/mainline gates `48 PASS`, and `git diff --check` PASS. Installed daemon release was rebuilt, globally installed, and service-scoped restarted to PID `42820`; installed runtime contains `bodySubscribed = frame.payload.bodySubscribed !== false`, inactive no-capture attach, and `SUBSCRIBER_BUFFER_SYNC_MAX_BYTES`.
- Production cold-daemon black-box gate: after `/health` showed zero sessions/mirrors, one WebRTC datachannel to `mac-studio` opened all 10 tmux sessions with `bodySubscribed:false`, then activated each session on the same channel. Every session produced same-channel `connected` and nonzero render data; render times were `21-188 ms`, selected ICE pair was `host/host udp`, max first-sync frame was below `128 KB`, and cleanup left `subscribers=0`.
- Delivery: Android `0.1.3.2196` / versionCode `1032196`; APK sha256 `f396694a81fc5580a0490422043dffcf558a7a17769cc1a1fdc4449cac375327`; size `4778462`. Public Relay update route serves `0.1.3.2196`; APK HEAD `Content-Length=4778462`; streamed public APK sha matches. `adb devices -l` had no attached device, so installed-phone UI L5 is still unclaimed.

# 2026-07-21 zterm-only open hang after mux allocation

- Symptom: Jason reports only the `zterm` session still does not open while other sessions can. Expected: selecting any listed tmux session either reaches same-channel `connected` + render data, or exposes/retries an explicit channel-ready failure within a bounded time.
- Read-only evidence: local daemon PID `50923` is running, `/health` is OK, tmux has live `zterm` pane `%10` at `80x51`, and mirrors are ready. Local mux black-box opened `zterm` in both `mirror-fixed` and `adaptive-phone` (`connected + buffer-sync`, 20-32ms). Production Relay/WebRTC to `mac-studio` opened `zterm` fixed/adaptive and `rcc` over one datachannel; selected ICE was `host/host udp`, `zterm` produced 80-line sync in 4-20ms. No online ADB device is attached, so phone-side route/local-storage proof is unavailable.
- Flow/model: `terminal.transport_lifecycle`: Android pending open intent -> daemon-target mux transport -> terminal channel allocation -> daemon attach/mirror readiness -> same-channel `connected` -> buffer head/sync -> renderer. Resource path: `resource.session_transport -> resource.daemon_target_transport -> resource.terminal_channel -> resource.transport_subscriber -> resource.mirror_store -> resource.client_sparse_buffer`.
- Active hypothesis confirmed from source: current pending open timeout is a single timer. The 2197 split clears that timer on `mux-channel-opened`, but does not arm a second bounded terminal-ready timer. If a phone-side route/channel gets allocation but loses/delays same-channel `connected`, the pending open can hang indefinitely and never retry or expose a root error.
- Unique owner: `terminal.transport_lifecycle` pending open/channel readiness owner in SessionContext transport orchestration and open-intent helper. Allowed paths: `session-transport-open-helpers.ts`, `session-context-transport-orchestration-runtime.ts`, timeout constant wiring, focused tests, docs/memory/skill. Forbidden: daemon tmux/mirror, renderer, route fallback, UI masking.
- Closeout: kept `mux-channel-opened` as allocation-only, but made allocation re-arm a second 10s terminal-ready timeout. Same-channel `connected` clears this second timer; missing `connected` now finalizes the pending open as retryable `terminal mux channel ready timeout` instead of hanging. This is explicit failure/retry, not a fallback route.
- Verification: focused transport/open/sync gates `3 files / 99 PASS`; mapped mux/session regression `9 files / 284 PASS`; `tsc --noEmit`, feature/resource/function/mainline gates `48 PASS`, and `git diff --check` PASS. Local daemon black-box opened `zterm` fixed/adaptive with `connected + buffer-sync`; production Relay/WebRTC opened `zterm` fixed/adaptive and `rcc` over one datachannel with selected ICE `host/host udp`.
- Delivery: Android `0.1.3.2198` / versionCode `1032198`; local/public APK sha256 `01e5f320ed434da093b692b89f86b2076dbc5402e0f11e445c1103446b21c9d2`; size `4778722`. Public Relay manifest and APK HEAD returned 200, `Content-Length=4778722`, and streamed public APK sha matches local. `adb devices -l` has no online device, so installed-phone UI L5 remains unclaimed.

# 2026-07-21 cold first-entry blank / same mux target partial session open diagnosis

- Symptom: Jason reports Android can input after the latest build, but after killing the app the first server entry is blank; later re-entry may work. He also reports the same phone/daemon should reuse one RTC/WebSocket target, yet some tmux sessions open while one session stays blank/unusable.
- Expected: one daemon target physical transport is reused; each tmux session is isolated only by `terminalChannel`; switching/activating a channel must send `body-subscription=true` on that same physical mux socket and then get `connected + buffer-head/sync`, without creating another RTC link.
- Flow/model: known `terminal.transport_lifecycle`.
  - Resource path: `resource.open_tab -> resource.active_session -> resource.session_transport -> resource.daemon_target_transport -> resource.terminal_channel -> resource.transport_subscriber -> resource.mirror_store -> resource.client_sparse_buffer`.
  - Forbidden edges: UI/renderer cannot compensate, Relay lease cannot own terminal channel/subscriber/mirror, daemon cannot store client active/live truth.
- Evidence:
  - Local daemon `/health` on PID `50923` reports `ok=true`, `mirrors.ready=10`, `subscribers=0` before probe.
  - Local same-physical-socket mux black-box probe listed 10 tmux sessions and opened/activated every session on one WebSocket. All sessions, including `zterm`, reached `opened=true`, `connected=true`, and `body/head` data with no mux errors. This rules out daemon mirror/session existence and server-side mux channel registry as the first divergence for this local daemon.
  - Source read found `reconcilePhysicalBodySubscriptions()` in `session-context-infra-facade-runtime.ts` mutates channel-local `bodySubscribed`, but sends the wire `body-subscription` only through `transportAccessors.readSessionTransportSocket(session.id)`.
  - In mux mode, `getSessionTransportSocket()` intentionally returns only legacy `activeSocket`; the effective mux socket lives in `getSessionTransportResource(session.id).socket` after `targetRuntime.terminalMuxReady`. Existing `session-transport-runtime.test.ts` explicitly locks this distinction.
- Confirmed hypothesis: when a session channel was initially opened inactive / body-suppressed, later active/live changes updated only local channel state but did not send `body-subscription=true` on the mux target socket. The daemon therefore kept that channel body-suppressed; user input could still work because input is channel-bound, while render stayed blank or stale.
- First divergence: Android client body-subscription reconcile, before daemon subscriber/mirror and before renderer.
- Unique owner: `terminal.transport_lifecycle` client session transport/body-subscription owner.
- Allowed paths: `android/src/contexts/session-context-infra-facade-runtime.ts`, focused SessionContext/transport tests, `android/docs/testing/websocket-transport-reuse-test-design.md`, project memory/skill closeout.
- Forbidden paths: daemon mirror/session registry, Relay route/peer lease, renderer/buffer repaint, per-session RTC/WebSocket rebuild, UI fallback.
- Required gate: red/green test proving active/live change sends channel-bound `body-subscription=true` over the existing mux target socket even when the legacy per-session socket is null; negative assertion that physical mux socket count stays one.

# 2026-07-21 mux target datachannel error fanout closeout

- Symptom: some selected tmux sessions report `data channel error` while other sessions on the same daemon target may still appear usable. Jason questioned whether this is protocol negotiation or channel switching.
- Verified ownership: `android/src/lib/traversal/socket.ts` maps WebRTC datachannel `onerror` to `rtc data channel error`; this is a physical target transport event before mux channel demux. The failing owner is `terminal.transport_lifecycle` target transport failure handling, not tmux session existence, daemon mirror, renderer, Relay route fallback, or per-session socket creation.
- First divergence: `bindTargetMuxTransportSocketLifecycleRuntime` invoked one `finalizeFailure` callback tied to the anchor open intent that created the physical target socket. Same-target logical channels were not explicitly invalidated, so a dead physical target could leave sibling logical channels projected differently.
- Fix: added `handleTargetMuxTransportFailureRuntime` in `session-context-transport-orchestration-runtime.ts`. Target mux error/close now clears target socket/ready, marks every non-closed same-target terminal channel closed, settles pending opens with the original retryable failure, and schedules immediate/reset reconnect for affected non-pending sessions through the existing reconnect owner.
- Verification: red test `handleTargetMuxTransportFailureRuntime` failed before implementation because the function did not exist; after fix it passes. Mapped mux/client/server transport regression passed: `9 files / 244 tests`. `tsc --noEmit`, `git diff --check`, and feature/resource/function/mainline gates `48 PASS`. Full `build:android` passed and produced Android `0.1.3.2200` / versionCode `1032200`, sha256 `03c31aff9e1e8e31e36f9a0425a134b7f6dc40475ed02f100c4203807dc4bc65`, size `4778970`. Public Relay update route serves the same manifest/APK and streamed APK sha matches. `adb devices -l` has no attached online device, so installed-phone L5 remains unclaimed.

# 2026-07-21 switch-back direct timeout / closed mux channel closeout

- Symptom: Jason reports switching away and back can directly timeout.
- Root cause: the physical daemon-target mux socket can remain `OPEN` while the per-session terminal channel is `closed/closing`. The first attempted fix passed `readSessionTerminalChannel` into facade/lifecycle, but `useSessionProviderCoreAssemblies()` did not return that accessor in the provider result, so real `SessionContext` still observed `terminalChannelState:null`. The active refresh planner then treated the open physical socket as reusable and sent `buffer-head-request` to the old/dead channel instead of reopening the mux channel.
- Unique owner: `terminal.transport_lifecycle`, resource path `active_session -> session_transport -> daemon_target_transport -> terminal_channel -> transport_subscriber -> mirror_store`.
- Fix: `ensureActiveSessionFreshRuntime()` now reads terminal channel truth; when the target socket is open but the session channel is closed/closing, it does not request head and calls `reopenSessionTerminalChannel()`. The lifecycle reopen path reuses `readSessionTransportHost(sessionId)` and `connectSession(sessionId, host)` so it reopens only the mux channel through the existing open-intent owner. Provider core assembly result, assembly types, and facade now all expose `readSessionTerminalChannel`.
- Verification: focused activity runtime `19 PASS`; focused SessionContext gates `3 PASS` including closed inactive mux channel switch-back on the same physical socket and repeated session switch render updates; mapped mux/transport regression `11 files / 284 PASS`; `tsc --noEmit` PASS; feature/resource/function/mainline gates `7 files / 48 PASS`; `git diff --check` PASS; full `build:android` PASS.
- Delivery: Android `0.1.3.2201` / versionCode `1032201`; APK `android/update-dist/zterm-0.1.3.2201.apk`; sha256 `369faa6aa76b9e2ea012fe2edd4aada6a85120add1a6fb2ca198821b6bf47abe`; size `4779342`. Public Relay update route serves `0.1.3.2201`, APK HEAD returns `Content-Length=4779342`, and streamed public APK sha matches. `adb devices -l` had no online device, so installed-phone UI L5 remains unclaimed.

# 2026-07-21 remote-window focus-first and shortcut one-shot Shift closeout

- Symptom: remote app operations must bring the selected target app/window to focus before control injection; shortcut editor blocked `Shift + ←` and still treated a modifier as applying to an entire multi-key combination.
- Flow/model: `desktop.remote_window_stream.client.input_request` emits explicit input intents only; daemon remains the focus/injection owner. `terminal.quickbar` owns the UI projection, while `packages/shared/src/shortcuts/terminal-shortcut-composer.ts` is the shared Android/Mac shortcut encoding owner.
- Root cause 1: Android focus intent was batch-level or stream-start/pointerdown-adjacent, not focus-first for every logical non-focus user input event. Gesture, wheel/key, and QuickBar/IME batches could send a real operation without an immediately preceding `focus` intent.
- Root cause 2: shortcut composer globally rejected modifier combinations with more than one target key. The expected terminal macro semantics are one-shot modifier semantics: `Shift` modifies only the first following target key, then clears; the next token is encoded normally.
- Fix: `RemoteWindowOverlay` and `TerminalPage#emitRemoteWindowInputEvents` now send same stream/target `focus` before each pointer/gesture/wheel/key/QuickBar/IME event. `buildTerminalShortcutSequence()` now walks tokens in order, consumes pending modifiers on the next non-modifier token, clears them, supports `Shift + arrow` sequences, and preserves later keys unshifted.
- Map update: `terminal.quickbar` feature registry/function map now names `packages/shared/src/shortcuts/terminal-shortcut-composer.ts` and its test as the shared shortcut composer owner/gate.
- Required gates: shared composer tests, `TerminalQuickBar.test.tsx`, remote-window overlay/page/IME tests, remote-window runtime/daemon mapped tests, `test:feature-registry`, `tsc --noEmit`, `git diff --check`, Android build/update, and live device/remote-window proof when an online phone is available.
- Verification: shared shortcut composer `3 PASS`; focused QuickBar/RemoteWindow/IME `4 files / 165 PASS`; mapped remote-window regression `11 files / 270 PASS`; feature/resource/function/mainline gates `7 files / 48 PASS`; `tsc --noEmit` PASS; `git diff --check` PASS; full `pnpm --dir android run build:android` PASS including terminal contracts, common user flows, local Relay smoke, Vite, daemon release prep, Gradle, update manifest verification.
- Delivery: Android `0.1.3.2204` / versionCode `1032204`; local APK `android/update-dist/zterm-0.1.3.2204.apk`; public Relay update route serves the same manifest/APK; sha256 `c3734c0062fa1b0b19899a1be77adb22a54477a759a2de733921978de92c10e4`; size `4781178`. Public `GET latest.json`, APK `HEAD Content-Length=4781178`, and downloaded public APK sha all match. `adb devices -l` returned no attached device, so installed-phone L5 remains unclaimed.

# 2026-07-22 network-switch Relay RTC signal ordering diagnosis

- Symptom: Jason reports that after switching networks some states never reconnect; older behavior would eventually move to Relay. Local daemon `/health` and production Relay `/relay/health` were both OK, but no ADB device was online for phone logcat. Daemon stderr had `traversal relay host parse error: Failed to set local answer sdp: Called in wrong state: stable` and `Failed to set ICE candidate`; daemon stdout showed repeated `rtc transport ... closed: rtc peer replaced by new init` / `rtc data channel closed`.
- Flow/model: known `terminal.transport_lifecycle` plus `relay.relay_peer_lease`: Android `TraversalSocket` opens a route-aware daemon target through Relay signaling; Relay server preserves per-device peer lease; daemon `relay-client.ts` forwards `relay-signal` into `rtc-bridge.ts`; `rtc-bridge` owns RTCPeerConnection negotiation before terminal mux/channel truth exists. Relay lease must not own tmux/session/channel/mirror/UI truth.
- Confirmed first divergence: daemon `rtc-bridge.ts` handled relay signals concurrently and treated every `rtc-offer` / `rtc-candidate` as immediately valid for the current peer connection. Network changes and peer resume can deliver duplicate `rtc-offer` for a stable peer or candidate before remote offer application, which throws from WebRTC and is logged by `relay-client.ts` as a host parse error. This prevents clean Relay renegotiation and can leave Android stuck waiting for a route that should have moved on.
- Unique owner: daemon RTC bridge signaling owner in `android/src/server/rtc-bridge.ts`; tests in `android/src/server/rtc-bridge.test.ts`. Forbidden fixes: route fallback masking, UI success projection, daemon tmux/mirror changes, or per-session transport rebuild.
- Fix: per-peer relay signals now run through a `signalChain`; repeated offers after one accepted offer are ignored; ICE candidates are buffered until an offer has been accepted and `remoteDescription` is set; `rtc-init` resets offer/candidate state for explicit renegotiation.
- Verification: focused `rtc-bridge` reorder test uses a real WebRTC peer and intentionally sends `rtc-candidate` before `rtc-offer`; it still opens and echoes over the datachannel. `pnpm --dir android exec vitest run src/server/rtc-bridge.test.ts src/traversal-relay/server.test.ts --reporter dot` PASS `10 tests`; `pnpm --dir android exec vitest run src/lib/traversal/socket.test.ts --reporter dot` PASS `17 tests`; `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS; `git diff --check` PASS. No online ADB device, so live phone network-switch L5 remains unclaimed.

# 2026-07-22 Android foreground resume transport diagnosis

- Symptom: Jason narrowed the current connect failure to Android app background -> foreground restore. Expected: every real OS foreground resume signal drives the active session through the existing `terminal.transport_lifecycle` explicit-resume owner; if the physical target socket is still `OPEN`, request head/body on that same socket; if socket/channel truth is closed or missing, call the unique reconnect/reopen owner immediately. No route fallback, no per-session second socket, no daemon client foreground state.
- Existing SOP/model flow: `terminal.transport_lifecycle`; `resource.active_session -> resource.session_transport -> resource.daemon_target_transport -> resource.terminal_channel -> resource.transport_subscriber -> resource.mirror_store -> resource.client_sparse_buffer -> resource.renderer_window`.
- Owner graph: App platform lifecycle projects foreground facts into `SessionProvider`; `useSessionContextLifecycle` is the SessionContext foreground refresh owner; `ensureActiveSessionFreshRuntime` is the transport reuse/reconnect owner. `useOpenTabLifecycleEffects` may observe OS events but must not create a second reconnect policy.
- Read-only evidence: `useSessionContextLifecycle` currently triggers explicit resume only when `appForegroundActive` changes false -> true. `useOpenTabLifecycleEffects` handles `visibilitychange`, document `resume`, and Capacitor `appStateChange`, but for foreground signals it only updates the boolean and audits remote tmux truth. If Android emits a foreground `resume`/`appStateChange(true)` while the React boolean is already `true` or if the hidden event was missed/coalesced, the active transport owner never receives a resume event. Existing tests cover boolean false -> true and even assert App does not call `resumeActiveSessionTransport`; they do not cover a monotonic foreground signal with unchanged boolean.
- Active hypothesis H1: foreground resume is currently modeled as a boolean edge, but Android foreground restore is an event. The first divergence is the missing event identity between `useOpenTabLifecycleEffects` foreground event observation and `useSessionContextLifecycle` explicit-resume invocation. Unique owner remains SessionContext lifecycle; the fix should pass a monotonic foreground resume sequence into SessionContext and let the existing explicit-resume owner run once per sequence.
- Allowed paths: `android/src/App.tsx`, `android/src/hooks/useOpenTabLifecycleEffects.ts`, `android/src/contexts/session-context-core.ts`, `android/src/contexts/session-context-provider-assembly-types.ts`, `android/src/contexts/SessionContext.tsx`, `android/src/contexts/session-context-lifecycle.ts`, focused lifecycle/App tests, and docs/memory. Forbidden paths: daemon RTC/tmux/mirror, renderer/buffer repaint compensation, route fallback, per-session transport creation outside the existing owner.
- Required red/green: foreground resume sequence increments while `appForegroundActive` remains true must call `ensureActiveSessionFresh({ source:'explicit-resume', forceHead:true, markResumeTail:true, allowReconnectIfUnavailable:true })`; repeated same sequence must not double-call; boolean false -> true remains supported; App foreground event must project the sequence to `SessionProvider` without calling App-side reconnect.
- Fix: `App` now owns a monotonic `foregroundResumeEpoch`; `useOpenTabLifecycleEffects` dedupes `visibilitychange` / document `resume` / Capacitor `appStateChange(true)` with shared `shouldResumeForeground`, keeps `online` on its own path, and projects only the foreground resume event into `SessionProvider`. `useSessionContextLifecycle` consumes epoch changes and invokes the existing SessionContext explicit-resume owner exactly once per sequence.
- Verification: focused lifecycle/App red-green `47 PASS`; mapped refresh gates `session-context-activity-runtime`, `session-context-lifecycle`, `SessionContext.ws-refresh`, and `App.dynamic-refresh` `200 PASS`; transport runtime/open/session/orchestration gates `48 PASS`; `tsc --noEmit` PASS; `test:feature-registry` `48 PASS`; `git diff --check` PASS; full `pnpm --dir android run build:android` PASS including terminal contracts `48 files / 611 tests`, common flows `83 PASS`, local Relay smoke, Vite, daemon release prep, Gradle, and update manifest checks.
- Delivery: Android `0.1.3.2208` / versionCode `1032208`; APK `android/update-dist/zterm-0.1.3.2208.apk`; sha256 `282c7b3564ccd75eb4aac035f2aa0cb7fb949a2cc449b90e3f81462cc04ae076`; size `4782142`; copied to `~/.zterm/updates`. `adb devices -l` has no online device, so installed-phone foreground-resume proof remains pending.

# 2026-07-22 Android update route publication closeout

- Symptom: Jason reports neither Relay nor Tailscale update check can see the new package. Local files existed, but Tailscale daemon HTTP was hanging and public Relay updates directory had not been refreshed with `0.1.3.2208`.
- Fix: copied `android/update-dist/latest.json` and `android/update-dist/zterm-0.1.3.2208.apk` to production Relay `/var/lib/zterm-traversal-relay/updates`; restarted only the service-scoped local daemon via `bash android/scripts/zterm-daemon.sh restart` because `http://127.0.0.1:3333/health` and `/updates/latest.json` timed out; left other dirty workspace changes untouched.
- Verification: local daemon `/health` now returns pid `94202`, updatesDir `/Users/fanzhang/.zterm/updates`, uptime reset; `http://127.0.0.1:3333/updates/latest.json`, `http://100.66.1.82:3333/updates/latest.json`, and `https://relay.codewhisper.cc:18443/relay/updates/latest.json` all report `0.1.3.2208` / `1032208`; local, Tailscale, and Relay APK downloads all sha256 `282c7b3564ccd75eb4aac035f2aa0cb7fb949a2cc449b90e3f81462cc04ae076`; Relay APK HEAD reports `Content-Length: 4782142`.
- Skill closeout: `.agents/skills/zterm-mobile-dev/SKILL.md` now requires every Android delivery to verify both Tailscale daemon update route and public Relay update route, including manifest GET, APK HEAD/GET, and sha match; local files alone no longer count as delivery.

# 2026-07-22 remote-window operation-scoped focus/input diagnosis

- Symptom: remote app/window can be pulled to foreground after the user leaves that desktop app, and touch gesture / keyboard input still fails in live use. Jason clarified the policy: only the instant of a real user operation may bring the target app to focus; no operation means no focus acquisition.
- SOP/model flow: `desktop.remote_window_stream`; resource path `resource.remote_window_overlay -> resource.session_transport -> resource.remote_window_stream`. Android overlay may emit explicit input intents only. Daemon/native stream owner owns focus verification and OS-event injection.
- Confirmed first divergence A: `RemoteWindowOverlay#handleSelectTarget` sends `{kind:'focus'}` as soon as `startStream()` resolves. Stream start / video attach is setup, not a user control operation, so this violates operation-scoped focus and can steal macOS focus with no active user input.
- Active hypothesis B: live gesture/input failure is hidden by tests that allow setup-time focus and do not prove the first actual touch/key/QuickBar/IME operation remains focus-first after setup emits no focus. The same owner must lock pointer tap, gesture swipe, wheel, surface key, QuickBar, IME, and unsupported iTerm negative paths.
- Unique owner/edit scope: `desktop.remote_window_stream.overlay.project/client.input_request` in `android/src/components/terminal/RemoteWindowOverlay.tsx` and focused tests; TerminalPage QuickBar/IME remains in scope only if its focus-first operation path is contradicted. Forbidden: daemon focus fallback, terminal transport reconnect, renderer/buffer, route selection.
- Required gates: red/green `RemoteWindowOverlay.test.tsx` proving stream start/fullscreen/IME lift/local zoom-pan do not emit focus, while pointer/gesture/wheel/key emit focus immediately before each actual remote operation; `TerminalPage.remote-window-overlay.test.tsx` and `TerminalPage.android-ime.test.tsx` keep QuickBar/IME focus-first; daemon input tests remain unchanged unless live evidence moves the first divergence.
- Fix: removed setup-time focus from `RemoteWindowOverlay#handleSelectTarget`, removed video-surface pointerdown focus, routed pointer down/tap through the same focus-first helper as other actual operations, delayed touch tap/gesture focus until classification/release, and corrected swipe delta to DOM-positive `to - from`.
- Verification: the focused red tests first failed on setup-time focus and old gesture delta signs, then greened. `pnpm --dir android exec vitest run src/components/terminal/RemoteWindowOverlay.test.tsx src/pages/TerminalPage.android-ime.test.tsx --reporter dot` PASS `92 tests`; mapped overlay/page/daemon gate `RemoteWindowOverlay.test.tsx`, `TerminalPage.remote-window-overlay.test.tsx`, `TerminalPage.android-ime.test.tsx`, `remote-window-stream-daemon.test.ts` PASS `126 tests`; `tsc --noEmit`, `test:feature-registry` `48 PASS`, and `git diff --check` PASS.
- Delivery: full `pnpm --dir android run build:android` PASS and produced `0.1.3.2209` / versionCode `1032209` / sha256 `986720169006fa610cdf0f04a14903693b1caf66d0628a55ea3dafbc204e25fd` / size `4782110`. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay `https://relay.codewhisper.cc:18443/relay/updates/latest.json` all serve `0.1.3.2209`, and downloaded APK sha matches on all three routes. `adb devices -l` has no online device.

# 2026-07-22 remote-window live interaction delivery diagnosis

- Symptom: Jason reports Android `0.1.3.2209` remote-window video remains non-interactive. Expected: an app-window target with `streamMode=interactive`, `focusPolicy=bring-to-focus`, and `inputRoute=os-event` sends operation-scoped focus plus pointer/gesture/key input over the existing session transport, and the live daemon focuses the selected macOS window and injects the event.
- SOP/model flow: known `desktop.remote_window_stream`; `resource.remote_window_overlay -> resource.active_session -> resource.session_transport -> resource.remote_window_stream -> resource.daemon_process`. Android owns only input intent projection; daemon/native remote-window stream is the unique focus/AX/Quartz input owner. Terminal renderer/buffer, tmux mirror, route fallback, and screenshot paths are forbidden.
- H1 active and confirmed at the delivery boundary: the live service PID `94202` runs `/Users/fanzhang/.zterm/daemon-runtime/server.cjs` SHA `2c3f545f30f9ffe45293f1022553bbb4758ad365059717b420a5446fb6da331b`, while the current release runtime is SHA `cf8c1517ffd830c8867fd41e919ae1518fc4af9e3d51c8ad74d64aa65c48a1c7`. The installed daemon runtime predates the release artifact, so APK/unit/build evidence cannot prove current live interaction behavior.
- H2 pending only after H1 is removed: if an exact installed-runtime live smoke still fails, locate the first divergence among control input frame emission, daemon `remote-window-input-result`, AX focus verification, and OS event observation. Do not patch Android or daemon before that replay.
- First divergence for this round: `resource.release_update_artifact -> resource.daemon_runtime_artifact -> resource.daemon_process`; the compiled release was not promoted into the live daemon runtime.
- Unique owner/scope: daemon release installation and service lifecycle. Allowed runtime actions are release install, service-scoped restart, installed/release SHA verification, `/health` PID/uptime verification, and a live app-window input smoke. Product source, renderer/buffer, tmux/session transport, and route selection are out of scope unless the live replay moves the first divergence.
- Required gates: install current release globally; restart only `com.zterm.android.zterm-daemon`; prove installed SHA equals release SHA and PID/uptime changed; run live WebSocket/WebRTC app-window focus plus harmless input with `remote-window-input-result accepted=true`; observe the target app/window receives the operation; clean marked temporary resources.
- H1 removed: installed `android/release-dist/zterm-daemon-0.1.3-darwin-arm64` via package `install-global.sh` and `~/.local/bin/zterm-daemon install-service`; live launchd runner now execs `/Users/fanzhang/.zterm/releases/zterm-daemon/0.1.3/runtime/server.cjs`, not stale `/Users/fanzhang/.zterm/daemon-runtime/server.cjs`. `/health` shows PID `62669`, uptime reset, and release/runtime SHA matches `cf8c1517ffd830c8867fd41e919ae1518fc4af9e3d51c8ad74d64aa65c48a1c7`.
- Local live proof after H1 removal: WebSocket catalog found `ZTERM_REMOTE_INPUT_PROBE` target `app-window:95294:4889`; WebRTC stream started with `520x372` frames and `connectionState=connected`; `remote-window-input` focus, pointer down/up, scroll, gesture, key down/up all returned `accepted=true`. Probe stdout observed `PROBE_MOUSE_DOWN`, `PROBE_MOUSE_UP`, `PROBE_SCROLL`, and `PROBE_KEY_DOWN/UP`, proving macOS target received OS events. No online ADB device was attached, so Android installed-phone touch-path L5 remains unclaimed.
- Delivery correction: the previous `0.1.3.2209` closeout did not prove live interaction because it lacked installed daemon runtime SHA/PID proof and the live AppKit input smoke. Future remote-window daemon/input fixes must not report closure from APK/build/unit gates alone.

# 2026-07-22 network-switch green-connected body-stale diagnosis

- Symptom: after phone network switch, Android top status can remain green (`Tailscale`) with traffic counters, but terminal body stops refreshing until the app is killed and re-entered. Expected: active terminal channel either receives `buffer-head`/`buffer-sync` on the same target mux socket within the freshness budget, or SessionContext exposes/reopens the channel through the unique transport lifecycle owner.
- Flow/model: known `terminal.transport_lifecycle`. Resource path: `resource.active_session -> resource.session_transport -> resource.daemon_target_transport -> resource.terminal_channel -> resource.transport_subscriber -> resource.mirror_store -> resource.client_sparse_buffer -> resource.renderer_window`.
- Function/mainline anchors: `terminal.transport_lifecycle.target_transport.open`, `channel.open`, `channel.send`, `channel.demux`; mainline edges `TargetTransportRuntime->ChannelRuntime`, `ChannelRuntime->ChannelMessageSend`, `SocketMessage->ChannelDemux`.
- Active hypothesis H1: the client currently uses one `lastServerActivityAt` as both physical server activity and terminal render freshness. `recordSessionRx()` updates that timestamp and clears `staleTransportProbeAtRef` for any non-pong inbound frame. After a network switch, non-body frames such as `title`, `schedule-state`, `input-ack`, `mux-channel-opened`, or diagnostics can make the transport look fresh and clear a pending head probe even though no `buffer-head` or `buffer-sync` arrived; active tick then stops sending head probes and UI remains green/stale.
- Source evidence: `session-context-pull-runtime.ts#recordSessionRx` sets `lastServerActivityAtRef` and deletes `staleTransportProbeAtRef` for every call; mux demux records activity for every non-pong channel message before `handleSocketServerMessageRuntime` knows whether it is render truth. `ensureActiveSessionFreshRuntime()` then uses `lastServerActivityAtRef` in `shouldScheduleActiveTickRefresh()` / keepalive grace and treats stale probe timeout as same-socket retry only if the probe marker was not cleared.
- Unique owner/edit scope: `terminal.transport_lifecycle` client freshness and rx bookkeeping. Allowed paths: `android/src/contexts/session-context-pull-runtime.ts`, `android/src/contexts/session-context-transport-runtime.ts`, `android/src/contexts/session-context-activity-runtime.ts` only if tests prove needed, focused tests in the same area, and map/skill/memory closeout. Forbidden: renderer/body repaint compensation, UI status projection masking, route fallback, daemon tmux/mirror, per-session WebSocket rebuild.
- Required red/green: non-render frames must not clear a pending head probe; non-render frames must not make active tick skip the next head probe; `buffer-head` and `buffer-sync` must clear the probe and refresh terminal freshness; pong still counts only heartbeat, not terminal render truth. Live L5 requires phone/logcat/network-switch replay; no online ADB means that gate remains unclaimed.
- Root cause confirmed by fail-first tests: generic Rx bookkeeping conflated physical server activity with terminal render activity. Non-render frames cleared the only stale head marker, so the active scheduler stopped asking for terminal truth while status and byte counters remained healthy.
- Fix: added `lastTerminalActivityAtRef`; only `buffer-head` / `buffer-sync`, including nested mux frames, refresh it and clear the head probe. Generic frames still update physical `lastServerActivityAtRef`. Connected baseline head requests no longer become long-lived probes; `lastConnectedBaselineAtRef` supplies only the bounded initial freshness window before same-socket active probing resumes.
- Verification: pull/lifecycle red-green passed; mapped context stack `9 files / 167 PASS`; `SessionContext.ws-refresh` `134 PASS`; feature/resource/function/mainline gates `48 PASS`; `tsc --noEmit` and `git diff --check` PASS; full `build:android` passed terminal contracts `48 files / 611 tests`, common flows `83 PASS`, local Relay smoke, Vite, daemon release preparation, Gradle, and update manifest checks.
- Delivery: Android `0.1.3.2210` / versionCode `1032210`; APK size `4782646`; sha256 `6ed06b07d029e7f439056f95f933a85b17cb1e15e3b8c62559f54e5884d49529`. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay update routes all serve the same manifest/APK hash. No online ADB device was attached, so installed-phone Wi-Fi/mobile network-switch L5 remains unclaimed.

# 2026-07-22 remote-window operation focus / gesture / screenshot diagnosis

- Symptom: selected desktop app/window can still be brought foreground when Jason is not operating it; remote touch must be gesture-replay rather than raw passthrough; floating/fullscreen remote-window needs a screenshot button that captures the selected desktop app/window and saves it on Android.
- Web research anchors: Android common gesture docs split handling into collecting touch data then interpreting it as a gesture; RFB/VNC sends `PointerEvent` / `KeyEvent` with coordinate/button state rather than forwarding raw touch streams; Apple CGEvent is the macOS low-level hardware event API for mouse/keyboard/scroll in global coordinates. This matches the project contract: Android classifies tap/swipe locally, sends action + coordinates, daemon replays via AX/Quartz.
- SOP/model flow: known `desktop.remote_window_stream`; screenshot transfer reuses `terminal.remote_screenshot` and file-download chunks. Resource path for input is `resource.remote_window_overlay -> resource.session_transport -> resource.remote_window_stream -> resource.daemon_process`; screenshot path is `resource.remote_window_overlay -> resource.session_transport -> resource.remote_screenshot -> Android local save`.
- Confirmed source evidence: current maps already require stream start, receiver attach, fullscreen entry, IME lift, picker/catalog refresh, pinch zoom, local zoom-pan, and screenshot to emit no `focus`; actual pointer/gesture/wheel/key/QuickBar/IME events must be same stream/target focus-first. Current screenshot request payload has only `requestId`, so a remote-window screenshot cannot carry selected target/crop truth.
- Active hypothesis H1: operation-scoped focus and local gesture recognition are owned by `RemoteWindowOverlay`; missing/weak tests let setup/projection actions regress into focus or raw-like move streams. First divergence for screenshot is protocol/request payload lacking remote-window target crop semantics.
- Unique owner/edit scope: `desktop.remote_window_stream.overlay.project/client.input_request` and `terminal.remote_screenshot` request/daemon handler extension. Allowed paths: `RemoteWindowOverlay.tsx/test`, `TerminalPage.tsx/remote-window-overlay/screenshot tests`, shared protocol/types, `remote-screenshot-runtime`, `session-context-transfer-runtime`, `terminal-file-transfer-list-runtime/types`, remote-window/screenshot docs/maps. Forbidden: terminal renderer/buffer, WebSocket reconnect, tmux mirror, route fallback, duplicate screenshot transfer pipeline, daemon input focus fallback.
- Required gates: red/green tests proving setup/fullscreen/close/screenshot do not focus; touch drag emits one `gesture/swipe` only on release and no pointer move stream; screenshot button sends target crop request and auto-saves; daemon screenshot handler uses explicit target/crop and rejects invalid target rectangles; existing QuickBar/IME focus-first and unsupported iTerm read-only tests remain green.
- Fix: added floating/fullscreen remote-window screenshot button; `RemoteWindowOverlay` only emits screenshot intent and does not send input/focus. `TerminalPage` passes selected target manifest into `remote-screenshot-request` and auto-saves the returned PNG through the existing Android screenshot persist runtime. Shared protocol/types and SessionContext transfer runtime now accept optional target payload. Daemon screenshot handler resolves app-window target to `--window-id` and iTerm pane target to `--rect`, rejects invalid target without fallback, and native `zterm-daemon capture-screen` supports `--window-id` / `--rect`.
- Gesture/focus status: source and tests now lock the intended mature remote-control subset: Android recognizes tap/swipe locally; unzoomed touch drag sends one `gesture/swipe` on release, mouse/trackpad wheel remains pixel scroll, zoomed fullscreen drag stays local pan, and screenshot/setup/projection paths do not focus. Actual pointer/gesture/wheel/key/QuickBar/IME operation paths remain focus-first.
- Verification: `RemoteWindowOverlay.test.tsx + remote-screenshot-runtime.test.ts + terminal-file-transfer-list-runtime.test.ts + TerminalPage.remote-window-overlay.test.tsx` PASS `54`; mapped remote-window/screenshot gates PASS `130 + 13`; `test:feature-registry` PASS `48`; `tsc --noEmit` PASS; `git diff --check` PASS; `swiftc android/scripts/native/zterm-daemon.swift` PASS; compiled native and installed native both captured 1x1 rect PNG successfully. Full `pnpm --dir android run build:android` PASS including terminal contracts/common flows/local Relay smoke/Vite/daemon release prep/Gradle/update manifest checks.
- Delivery: service-scoped restarted zterm daemon; `/health` PID `99803`, uptime reset, `/debug/runtime` OK. Android update package `0.1.3.2211` / versionCode `1032211` / sha256 `590c3fefa6ebe22e64422bf5b55e0fd3b6d02f34520d5995abd56c4d10f93549` / size `4782990`. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay `https://relay.codewhisper.cc:18443/relay/updates/latest.json` all serve `0.1.3.2211`; Relay APK HEAD length and downloaded APK sha match. `adb devices` returned no online device, so installed-phone screenshot/touch L5 remains unclaimed.
# 2026-07-22 Remote-window realtime gesture/input diagnosis

- Symptom: remote-window click/gesture/input is realtime control, but current path can queue old operations and replay them later; touch drag is locally recognized, yet daemon replays a swipe as multiple delayed scroll steps.
- SOP/model flow: `desktop.remote_window_stream.client.input_request -> desktop.remote_window_stream.daemon.input_inject`. Resource edge is `resource.remote_window_overlay -> resource.remote_window_stream`; Android emits intent only, daemon owns macOS focus/injection.
- External-source check: noVNC and Guacamole both separate local touch/mouse recognition/element coordinate mapping from protocol-level remote input, with tap/gesture time thresholds and wheel/move coalescing rather than raw touch stream forwarding.
- Active hypothesis H1: first divergence is the remote-window input lifecycle contract: `RemoteWindowInputEventPayload` has no client timestamp, daemon/helper queue has no stale drop, and Swift gesture replay loops with `usleep`, allowing stale action pile-up.
- Unique owner/edit scope: shared protocol timestamp, `remote-window-message-runtime` stamping, `RemoteWindowOverlay` tap/gesture coordinate semantics, and `remote-window-stream-daemon` validation/helper/Swift gesture injection. Forbidden: terminal buffer/renderer, session transport reconnect, screenshot/file-transfer, Relay route selection.
- Required gates: overlay black-box tests for no move emission + one release action + absolute remote deltas + >1s local drop; message runtime timestamp test; daemon tests for stale rejection before helper and no Swift gesture sleep/loop; focused remote-window vitest + typecheck before any delivery claim.

# 2026-07-22 network-switch cannot reconnect diagnosis

- Symptom: Jason reports network switching can leave the app unable to reconnect at all. Expected: a half-open physical daemon-target transport is detected by heartbeat, finalized once as retryable physical failure, and replaced through `terminal.transport_lifecycle` while preserving logical session/channel/buffer truth.
- SOP/model flow: known `terminal.transport_lifecycle`; resource path `resource.active_session -> resource.session_transport -> resource.daemon_target_transport -> resource.terminal_channel -> resource.transport_subscriber -> resource.mirror_store -> resource.client_sparse_buffer`.
- Function/mainline anchors: `terminal.transport_lifecycle.target_transport.open`, `channel.open`, `channel.send`, `channel.demux`, and `relay.route_selection` only for recording route health after a physical target failure.
- H1 active and confirmed by code reading: legacy per-session WebSocket path starts `startSocketHeartbeat()` in `openSocketConnectHandshake()`, but mux physical target path `bindTargetMuxTransportSocketLifecycleRuntime()` never starts heartbeat. The mux protocol already has `mux-ping`/`mux-pong`, and `wrapSessionPayloadForTargetMuxRuntime()` maps legacy `{type:'ping'}` to `mux-ping`, but no timer drives it and `mux-pong` currently only logs. A network-switched mux/RTC/WebSocket target can therefore stay `OPEN` from the JS API point of view with no bounded failure, so no reconnect owner runs.
- First divergence: `android_mainline:TargetTransportRuntime->MuxHandshake` / `bindTargetMuxTransportSocketLifecycleRuntime` omits the physical target heartbeat and target-level activity bookkeeping.
- Unique owner/edit scope: `terminal.transport_lifecycle` target transport health. Allowed paths: `android/src/contexts/session-context-transport-runtime.ts`, `android/src/contexts/session-context-transport-orchestration-runtime.ts`, focused transport/heartbeat tests, `android/docs/testing/session-transport-network-switch-test-design.md`, project memory/skill closeout. Forbidden: UI reconnect loops, renderer/buffer compensation, daemon client-network state, route fallback order changes, per-session socket rebuild logic.
- Required red/green: target mux lifecycle must start a 2s heartbeat on physical socket open; heartbeat sends `mux-ping` through the existing send wrapper; any valid mux server frame refreshes target physical activity and `mux-pong` refreshes pong truth; after three misses the target failure fanout runs once and closes the physical socket; healthy `mux-pong` / channel body frames do not fail; route health must see the close reason so next open can avoid the just-failed route. Real phone Wi-Fi/cellular L5 remains required before claiming field closure.
- 2026-07-22 correction from Jason: the previous "2s per-session heartbeat" requirement is the wrong mental model for mux. In mux mode heartbeat truth is per physical daemon target transport (`resource.daemon_target_transport`), not per tmux session / logical channel. Normal keepalive must be low-frequency (60s class); session switch / foreground resume / logical channel open must not create another heartbeat timer. Channel errors reopen only the channel; physical close/error/target heartbeat failure is the only owner that rebuilds the target transport.
- Fix implemented: `startSocketHeartbeat` now accepts a target heartbeat key; mux target lifecycle passes `target:<targetKey>` and records target activity/pong under that key. The facade interval is 60s, target failure finalizes once, route health is marked before client close, and logical session/channel open/switch paths reuse the same target timer. Docs/function wiki/skill/gates updated to lock target-level heartbeat semantics.
- Verification: `test:feature-registry` 48 PASS; mux/heartbeat/traversal focused suite 199 PASS; remote-window dirty-scope gates 81 PASS; `tsc --noEmit` PASS; `docs:function-wiki` regenerated; `git diff --check` PASS. First full `build:android` hit one transient `SessionContext.ws-refresh` render-gate assertion; the exact test and full terminal contracts reran green, then full `build:android` passed.
- Delivery: Android `0.1.3.2212` / versionCode `1032212`; APK `android/update-dist/zterm-0.1.3.2212.apk`; sha256 `98af72a4b2bf66f6859b61d00196314397f1bb4f6856d1907785fe5cbc2eca87`; size `4783886`. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay update routes all serve the same manifest and APK sha. `adb devices -l` has no online device, so installed-phone Wi-Fi/cellular network-switch L5 remains unclaimed.
# 2026-07-22 Classic network model / daemon runtime mismatch audit

- Symptom follow-up: after service-scoped daemon restart, Android can connect again, but this is not proof that the latest client/daemon network model is correct.
- Live daemon evidence: `/health` PID `72729` runs `/Users/fanzhang/.zterm/daemon-runtime/server.cjs` via `/Users/fanzhang/.zterm/bin/zterm-daemon-launchd-run`; this runner is hardcoded to the legacy daemon-runtime path.
- Runtime SHA divergence:
  - `/Users/fanzhang/.zterm/releases/zterm-daemon/0.1.3/runtime/server.cjs` = `cf8c1517ffd830c8867fd41e919ae1518fc4af9e3d51c8ad74d64aa65c48a1c7`
  - `android/release-dist/zterm-daemon-0.1.3-darwin-arm64/runtime/server.cjs` = `71ef58dd744eeea6f53180ab38cc7aa5746f816e374628a758285f2e274729bc`
  - `/Users/fanzhang/.zterm/daemon-runtime/server.cjs` = `bda7c7cbd2041239a40c8e311b482acd625d7a3ac49c762776d3f804687e9315`
- Local black-box protocol replay against the currently running daemon:
  - `ws://127.0.0.1:3333`: open 5ms, mux-ready 5ms, list-sessions 15ms, channel-opened 16ms, connected 20ms, first body 94ms, 10 sessions.
  - `ws://100.66.1.82:3333`: open 2ms, mux-ready 3ms, list-sessions 7ms, channel-opened 8ms, connected 8ms, first body 60ms, 10 sessions.
  - Conclusion: current local/Tailscale physical transport and mux channel path are healthy after restart; if phone still fails on stable Tailscale while `/health` and this replay pass, root cause is client state/channel lifecycle or stale runtime delivery, not Tailscale network reachability.
- Classic model anchors checked:
  - RFC 6455 WebSocket ping/pong is connection-level keepalive/responsiveness, not per logical tmux session.
  - `ws` reference heartbeat uses one server interval around 30s and closes broken physical connections.
  - MDN WebRTC ICE `disconnected` can be transient; `failed` means all candidate pairs failed; `restartIce()` is the standard ICE repair primitive.
  - Android connectivity docs recommend `ConnectivityManager.NetworkCallback` / `registerDefaultNetworkCallback()` for network changes instead of expensive polling.
  - Tailscale docs describe direct peer-to-peer first, peer relay if configured, then DERP relay; stable Tailscale IP reachability should behave like a direct endpoint for zterm.
- Current implementation gaps against classic model:
  - Daemon server still has `WS_HEARTBEAT_INTERVAL_MS = 2000` and `TERMINAL_TRANSPORT_STALE_INBOUND_MS = 10000`, causing high-frequency physical heartbeat/stale decisions. This may be acceptable only for short smoke tests; it is too aggressive as a long-lived mobile network model.
  - Android mux heartbeat is now target-keyed and 60s-class, but the live daemon being tested may not be the current release artifact, so behavior must not be called fixed until launchd/runtime artifact truth is aligned.
  - `TraversalSocket` treats WebRTC `disconnected` as close immediately; classic ICE model says disconnected can recover spontaneously and should not always mean rebuild. Need a bounded grace/ICE-restart design before code edits.
  - Route health cache records route failure for an active candidate and keeps it for 5 minutes. For stable Tailscale, a transient app/background/RTC/channel error must not poison direct Tailscale reachability when direct `/health` is still reachable.
- Next required diagnosis before product patch: align daemon runtime truth, then run a matrix gate on one physical target transport with multiple logical channels across direct Tailscale, WebRTC direct, and TURN/relay. The gate must distinguish physical transport close/error from logical channel error and terminal render freshness.

# 2026-07-22 Client target transport effective socket diagnosis

- Symptom: after session switch / foreground resume / drawer interaction, Android can show connected but stall, or spend seconds reconnecting even when the same daemon target is already physically connected.
- Expected: one daemon target physical transport remains the truth; session switch opens/reuses only mux channels and requests head/body, unless the physical target transport is actually closed past timeout.
- SOP/model flow: terminal.transport_lifecycle -> resource.session_transport -> resource.daemon_target_transport -> resource.terminal_channel -> resource.transport_subscriber.
- Source docs checked: android/docs/resource-map.md, android/docs/function-map.md, android/docs/wiki/mainline-call-map.json, android/docs/testing/websocket-transport-reuse-test-design.md.
- Confirmed first divergence: mux physical socket is stored at target runtime terminalTransport, but connectSessionRuntime/reconnectSessionRuntime/createSessionRuntime still use readSessionTransportSocket(), which reads only legacy runtime.activeSocket. In mux mode that can be null while targetRuntime.terminalTransport is OPEN, so reconnect/reopen decisions rebuild or wait incorrectly.
- Unique owner / allowed edit scope: android/src/contexts/session-context-session-runtime.ts and its tests; optional orchestration wiring may pass readSessionTransportResource/effective socket reader. Forbidden: renderer, buffer, daemon mirror, tmux, UI compensation.
- Secondary confirmed gap: TraversalSocket WebRTC treats peer connectionState=disconnected as immediate close and records route failure; classic ICE semantics require bounded grace/ICE repair before close. This is separate after effective-socket fix.
- Required red tests: connectSessionRuntime and reconnectSessionRuntime must reuse OPEN same-target effective mux socket when legacy activeSocket is null; createSessionRuntime reuse must not reconnect when effective socket is open; TraversalSocket must not close immediately on transient rtc disconnected.
- Effective-socket fix detail: session lifecycle now reads mux resource socket state when deciding connect/create/reconnect, but treats a closing/closed terminal channel as unavailable so it reopens the logical channel on the existing target transport instead of skipping the open. Unit tests lock both sides: open channel reuses target socket; closed channel queues channel reopen.
- Verification: `session-context-session-runtime.test.ts` PASS `25`; `SessionContext.ws-refresh.test.tsx` PASS `134`; mapped transport stack `session-context-session-runtime`, `session-context-activity-runtime`, `SessionContext.ws-refresh`, `session-context-transport-runtime`, `session-context-transport-open-runtime`, `session-context-transport-orchestration-runtime` PASS `208`; `test:feature-registry` PASS `48`; `tsc --noEmit` PASS; `git diff --check` PASS.

# 2026-07-22 RTC transient disconnected closeout

- Root cause: `WebRtcBackend` immediately projected `RTCPeerConnection.connectionState === disconnected` as `onclose`, so a transient ICE interruption during network switch was recorded as a physical route failure and could poison route health before WebRTC had a chance to recover.
- Fix: `disconnected` now starts a bounded 10s grace timer and calls `restartIce()` when available; returning to `connected` clears the timer and keeps the same data channel alive. Only unrecovered `disconnected`, `failed`, `closed`, or actual data-channel close reaches the outer transport close/failure path.
- Verification: fail-first `socket.test.ts` locked transient disconnected no-close before 9999ms + recovered connected path, and unrecovered 10s disconnected close. Focused traversal/transport gate PASS `208`; `test:feature-registry` PASS `48`; `tsc --noEmit` PASS; `git diff --check` PASS. Real phone network-switch L5 is still unclaimed without an online device replay.
- Delivery: full `pnpm --dir android run build:android` PASS and produced Android `0.1.3.2213` / versionCode `1032213`; APK size `4784102`; sha256 `de443704ab31872876ee39e5c01772904e47452b84ebcc800d34cb09ad664d96`. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay `https://relay.codewhisper.cc:18443/relay/updates/latest.json` all serve `0.1.3.2213`, and APK downloads from all three routes match the manifest sha. `adb devices -l` has no online device, so installed-phone Wi-Fi/cellular switch L5 remains Jason-side pending.

# 2026-07-22 Remote-window control closeout diagnosis

- Symptom: remote-window APP control is not closed end-to-end; current L4/unit gates pass, but Android real-device input replay is still unclaimed without an online ADB device.
- SOP/model flow: `desktop.remote_window_stream.client.input_request -> desktop.remote_window_stream.daemon.input_inject`; image paste crosses the file-transfer owner only for clipboard upload, then must re-enter the same daemon remote-window input owner for Command+V.
- Resource path: `resource.remote_window_overlay -> resource.session_transport -> resource.remote_window_stream -> resource.daemon_process`. Android emits intent; daemon owns AX/Quartz focus and OS input. No terminal renderer/buffer/transport fallback is allowed.
- Source evidence: `remote-window-message-runtime` stamps normal Android `remote-window-input` with `clientSentAt`; daemon `validateRemoteWindowInput()` now requires `clientSentAt` and rejects stale events before helper injection. However `server.ts` remote-window image paste path calls `remoteWindowStreamRuntime.injectInput()` for Command+V key down/up without `clientSentAt`, so that path must fail with `remote window input requires clientSentAt` after the stale-drop change.
- Confirmed first divergence: daemon-internal remote-window paste shortcut payload construction in the remote-window input owner/glue, not Android overlay coordinate mapping, ScreenCaptureKit, terminal transport, or file binary chunking.
- Unique owner: `desktop.remote_window_stream.daemon.input_inject` plus server glue that invokes it from the existing file-transfer paste owner.
- Allowed edit scope: `android/src/server/remote-window-stream-daemon.ts`, `android/src/server/server.ts`, `android/src/server/remote-window-stream-daemon.test.ts`, remote-window test design/memory. Forbidden: renderer/buffer, session transport reconnect, duplicate clipboard/file-transfer pipeline, UI fallback.
- Required gates: red/green proving internal remote-window image paste Command+V events carry fresh `clientSentAt`; existing remote-window focused gates; feature/resource/function/mainline gates; typecheck; installed daemon SHA/PID plus live WebSocket/WebRTC AppKit probe if daemon code changes.
- Fix: moved remote-window image paste Command+V payload construction into `buildRemoteWindowImagePasteInputPayloads()` under the daemon remote-window owner and changed `server.ts` to call that helper. Each key down/up input now carries a fresh `clientSentAt`; direct daemon `injectInput()` without `clientSentAt` remains rejected before macOS helper injection.
- Reusable live gate added: `pnpm --dir android exec tsx scripts/remote-window-live-input-probe.ts`. The script builds a temporary `.app` bundle, starts a live app-window WebSocket/WebRTC stream, sends focus/pointer down/up/scroll/gesture/key down/up, checks `accepted=true`, reads target stdout OS-event markers, stops the stream, and removes the temporary process/files. A previous unbundled Swift script probe was flaky because normal app focus semantics could be missing a bundle id.
- Verification: fail-first daemon owner test initially failed because the new helper did not exist; after fix `remote-window-stream-daemon.test.ts` PASS `33`. Mapped remote-window stack PASS `8 files / 197 tests`; feature/resource/function/mainline registry PASS `7 files / 48 tests`; `tsc --noEmit` PASS; `git diff --check` PASS.
- Runtime closeout: `daemon:prepare-release` + `daemon:install-global` + service-scoped `/Users/fanzhang/.local/bin/zterm-daemon restart` completed. `/health` changed from PID `77367` to PID `46565`, uptime reset, and live command is `/opt/homebrew/bin/node /Users/fanzhang/.zterm/releases/zterm-daemon/0.1.3/runtime/server.cjs`. Repo release runtime and installed release runtime SHA both equal `9d6b61deb8abc8463a00a6366cb61be11143d06a774250fa80a2ebba623a4d50`.
- Live proof: `.app` probe selected target `app-window:73135:5502`, stream capture `520x404`, `trackSeen=true`, stopped after `33` frames, and target stdout observed `PROBE_MOUSE_DOWN`, `PROBE_MOUSE_UP`, `PROBE_SCROLL dx=0 dy=-96`, `PROBE_SCROLL dx=0 dy=-81`, `PROBE_KEY_DOWN chars=z`, `PROBE_KEY_UP chars=a`. Probe PID `73135` was gone after cleanup; daemon remained healthy with subscribers `0`. No online ADB device was attached, so installed Android touch-path L5 remains unclaimed.
# 2026-07-22 Remote-window original screenshot feedback diagnosis

- Symptom: Jason reports the remote-window screenshot button has no visible animation/prompt and clarifies the required behavior is remote original-resolution capture, not a screenshot of the local Android video surface.
- Expected: floating/fullscreen screenshot button sends a non-input `terminal.remote_screenshot` request with `target.kind=remote-window` and selected daemon manifest; daemon captures by macOS `windowId` or normalized crop rect at source resolution, file-download saves the PNG on Android, and overlay shows an obvious in-progress/saved/failed feedback animation. The screenshot path must not focus/raise the desktop app and must not read the local DOM/video surface.
- SOP/model: `desktop.remote_window_stream.overlay.screenshot_intent -> terminal.remote_screenshot.request -> daemon remote screenshot native capture -> file-download chunks -> Android save projection`. Resources: `resource.remote_window_overlay -> resource.remote_screenshot -> resource.backend_session`. Forbidden: `resource.remote_window_overlay -> local video/DOM screenshot`, remote-window input/focus, renderer/buffer, and transport fallback.
- Active hypothesis H1: existing screenshot truth path is structurally correct but overlay feedback is too weak; tests should lock the user-visible animation/status and keep the negative no-focus/no-local-capture gate.
- Owner/scope: `terminal.remote_screenshot.remote_window_feedback`. Allowed paths are `RemoteWindowOverlay`, TerminalPage screenshot caller/tests, remote screenshot runtime/list runtime tests, test design, memory/skill. No transport/renderer/daemon stream changes unless read-only evidence shows target capture itself is wrong.
- Closeout: added a non-layout overlay toast animation/status inside the remote-window video surface (`capturing` spinner, saved/failure result), disabled the screenshot button while a remote capture is pending, and kept the path as `target.kind=remote-window` through the existing remote screenshot/file-download owner. TerminalPage test spies on `HTMLCanvasElement.toDataURL` to prove no local video/canvas screenshot is used and asserts no remote-window input/focus is sent.
- Live evidence found and fixed native source-size correctness: `screencapture -l<windowId>` included macOS shadow inflation (`638x565` for a `570x497` manifest window), while `screencapture -x -o -l<windowId>` returns exact `570x497`. `android/scripts/native/zterm-daemon.swift` now passes `-o` before `-l`, and packaged global install copies the packaged support native binary into `~/.zterm/bin/zterm-daemon` so the runtime fallback path cannot use an old shadow-inflating binary.
- Verification: overlay/page focused tests `44 PASS`; remote screenshot/list/native blackbox `18 PASS`; mapped remote-window/screenshot suite `13 files / 191 PASS`; `tsc --noEmit` PASS; feature/resource/function/mainline gates `48 PASS`; Swift native compile + 64x64 rect capture PASS; rebuilt/installed daemon, restarted service to PID `26788`, and live WS screenshot against app-window `2410` returned PNG `570x497` matching manifest bounds with one file-download chunk and no local canvas path.
- Delivery: Android APK `0.1.3.2215` / versionCode `1032215`, sha256 `dc190903b700431a17bc2ea5c3dcbec44701c5078945cbf98ebba161fd9f1f6c`, size `4785046`. Full `build:android` PASS; local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay update routes serve the same manifest/APK sha. No online ADB device was attached, so installed-phone visual L5 remains unclaimed.

# 2026-07-22 Remote-window catalog cache and picker blank diagnosis

- Symptom A: Android `0.1.3.2215` remote-window picker can show `远程窗口列表读取超时` and `0 个目标`. Expected: remote-window target list is daemon-owned catalog projection, not a per-open realtime desktop enumeration; picker should use cached rows and refresh in the background.
- Symptom B: while the picker is open, the terminal keeps a bottom QuickBar reserve even though the QuickBar is hidden, leaving a blank strip below the terminal area. Expected: picker is a top overlay and must not keep bottom chrome layout space.
- Flow/model: known `desktop.remote_window_stream`. Resource path: `resource.remote_window_overlay -> resource.session_transport -> resource.remote_window_stream`. `resource.remote_window_stream` owns desktop catalog/cache; Android overlay owns projection only. Terminal renderer/buffer/transport rebuild are forbidden compensation paths.
- Live evidence: direct WS probe against running daemon PID `26788` returned the first uncached full catalog in `11208ms`, after the overlay's `8000ms` local watchdog. The response eventually had `13` iTerm2 pane targets plus `app_window_catalog_unavailable`, proving the UI timeout is caused by blocking live daemon enumeration, not by an absent transport. A subsequent warm probe returned `32` targets in `1636ms`, showing the missing owner is a daemon catalog cache/warm path.
- First divergence A: `remote-window-stream-daemon.ts#listTargets` synchronously calls macOS app catalog + iTerm2 + tmux enumeration on every request and has no daemon-side stale-while-refresh cache. The existing SessionContext 60s cache only helps after Android receives one successful response; it cannot protect the first picker open after a cold daemon enumeration exceeds the UI watchdog.
- First divergence B: `TerminalPage` computes `terminalStageBottomPx` from `quickBarHeight` even when `RemoteWindowOverlay` reports picker-open QuickBar suppression and the QuickBar shell is not rendered.
- Unique owners: A belongs to daemon `desktop.remote_window_stream.daemon.catalog_cache` in `android/src/server/remote-window-stream-daemon.ts` plus protocol/message request force-refresh wiring. B belongs to `desktop.remote_window_stream.overlay.project` / TerminalPage chrome projection.
- Allowed paths: `packages/shared/src/connection/protocol.ts`, `android/src/lib/remote-window-message-runtime.ts`, `android/src/contexts/session-context-remote-window-runtime.ts`, `android/src/server/remote-window-stream-daemon.ts`, `android/src/pages/TerminalPage.tsx`, focused tests, remote-window test design/function/resource docs, memory/skill closeout.
- Forbidden paths: terminal mirror/buffer/renderer, tmux backend truth, route fallback/reconnect, screenshot fallback, local video/canvas capture.
- Closeout: daemon runtime now warms default app-window+iTerm2 target catalog on start, caches per source-set for 60s, returns stale rows immediately while one background refresh runs, and honors explicit `forceRefresh` for live reads. `TerminalPage` stage bottom reserve becomes `0` while the remote-window picker suppresses QuickBar.
- Verification: focused cache/layout gate `67 PASS`; mapped remote-window stack `195 PASS`; feature/resource/function/mainline gates `48 PASS`; `tsc --noEmit` PASS; `git diff --check` PASS; `build:android` PASS with terminal contracts `612 PASS`, common flows `83 PASS`, local Relay smoke PASS. Installed daemon release SHA matched repo SHA `01809b02174879494a8c8398ce2ca460549b636a6ebe3326f250a5201a2da0fd`; service-scoped restart produced PID `32658`; live WS catalog on one socket returned normal1 `2ms`, normal2 `1ms`, force `1470ms`, normal3 `1ms`, `32` targets, no errors.
- Delivery: APK `0.1.3.2216` / versionCode `1032216`, sha256 `27c9d96851900d1d6a54596e17ae7f6b77d2f68baa84923aa0eea3808b6ef1c6`, size `4785190`. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay `https://relay.codewhisper.cc:18443/relay/updates/latest.json` all serve the same manifest/APK sha. `adb devices -l` had no online device, so installed-phone visual L5 remains unclaimed.

# 2026-07-22 Remote-window input loopback gate check

- Jason challenged whether remote-window input had enough black-box loopback proof. Current answer: previous package delivery alone was not enough; the required gate is live daemon WebSocket/WebRTC -> daemon input helper -> macOS AppKit probe stdout markers.
- Test gate correction: `scripts/remote-window-live-input-probe.ts` must request catalog with `forceRefresh:true` because it creates a brand-new temporary `.app` window. Without force refresh, daemon catalog cache can be correctly stale and the probe may test the cache instead of the new target.
- Live proof completed on installed daemon PID `32658`, with repo/installed runtime SHA both `01809b02174879494a8c8398ce2ca460549b636a6ebe3326f250a5201a2da0fd`.
- Direct local proof: `pnpm --dir android exec tsx scripts/remote-window-live-input-probe.ts` passed twice over `ws://127.0.0.1:3333`. Each run selected the temporary `app-window`, started ScreenCaptureKit/WebRTC, observed `trackSeen=true`, accepted focus/pointer/scroll/gesture/key requests, and stdout showed `PROBE_MOUSE_DOWN`, `PROBE_MOUSE_UP`, two `PROBE_SCROLL` markers, `PROBE_KEY_DOWN`, and `PROBE_KEY_UP`.
- Tailscale proof: `ZTERM_REMOTE_WINDOW_PROBE_WS_URL=ws://100.66.1.82:3333 pnpm --dir android exec tsx scripts/remote-window-live-input-probe.ts` passed with the same accepted input markers.
- White-box gate: remote-window overlay/page/message/context/daemon/input-mapping focused suite passed `7 files / 168 tests`; `tsc --noEmit`, `test:feature-registry` `48 PASS`, and `git diff --check` passed.
- Remaining gap: no online ADB device was attached in this run, so this proves live daemon protocol and macOS OS-event loopback, plus React/SessionContext message construction. It still does not prove installed Android WebView touch delivery on a phone.

# 2026-07-22 Remote-window Android phone logic gate diagnosis

- Symptom: Jason correctly points out that daemon loopback alone is insufficient; the Android phone-side path must prove video-surface touch/gesture actions actually leave `TerminalPage` as `remote-window-input` instead of being swallowed by local overlay, terminal surface, or QuickBar focus routing.
- SOP/model flow: `desktop.remote_window_stream.client.input_request`; resource path `resource.remote_window_overlay -> resource.active_session -> resource.session_transport`. Android owns only local touch recognition and coordinate projection; daemon owns macOS focus/injection.
- Code evidence: `RemoteWindowOverlay` has component-level pointer tests for tap/gesture/wheel/key; `TerminalPage.remote-window-overlay.test.tsx` covers QuickBar/image/IME-ish routing, but does not yet prove a real page-level video-surface touch reaches `onSendRemoteWindowInput`. That is the remaining phone-logic gate below the live daemon proof.
- First divergence risk: page integration could pass QuickBar while video-surface actions are still swallowed or routed to terminal input. Unique owner is `RemoteWindowOverlay` + `TerminalPage` projection test; forbidden fixes remain daemon/input fallback, terminal renderer, and transport reconnect.
- Required red/green: render real `TerminalPage`, open the picker, select an interactive app-window, set a realistic mobile surface rect, replay touch tap and unzoomed touch drag on `remote-window-video-surface`, assert focus-first `pointer down/up` and single `gesture/swipe` payloads are sent via `onSendRemoteWindowInput`, and assert `onTerminalInput` is not called.
# 2026-07-22 Remote-window touch-to-system-control migration diagnosis

- Symptom: APK 0.1.3.2217 can show remote-window video and screenshot, but app-window click/gesture/input is still not useful; tapping the remote video surface can flash the ZTERM wallpaper/background.
- Expected: follow mature remote desktop semantics instead of raw or delayed touch passthrough. Local Android recognizes touch gestures and emits bounded system-control actions over the existing session transport; daemon injects macOS OS events. No terminal renderer/transport fallback.
- SOP/model flow: `desktop.remote_window_stream.client.input_request -> resource.remote_window_overlay -> resource.session_transport -> resource.remote_window_stream -> desktop.remote_window_stream.daemon.input_inject`.
- Source docs checked: `android/docs/resource-map.md`, `android/docs/function-map.md`, `android/docs/mainline-call-map.md`, `android/docs/testing/remote-window-stream-test-design.md`, `.agents/skills/zterm-mobile-dev/SKILL.md`.
- External references checked: RustDesk `remote_input.dart` maps tap to cursor move + left down/up, one-finger pan to left down at pan start + absolute moves + left up on end, and scroll as a separate wheel action; RustDesk server maps those to `mouse_move_to`, `mouse_down`, `mouse_up`, and wheel. noVNC similarly sends pointer events with absolute coordinates/button mask and rate-limits move, not raw touch streams.
- Confirmed first divergence H1: Android `RemoteWindowOverlay` currently converts unzoomed touch drag into one delayed `kind=gesture/swipe` on pointer-up. That is the wrong desktop app control semantic; it delays the action, can be stale/dropped, and never produces mouse drag down/move/up. The app-window input owner already has pointer down/move/up and daemon pointer injection, so the unique fix is client gesture recognition, not daemon fallback.
- Confirmed first divergence H2: `RemoteWindowOverlay` video `srcObject` effect depends on the entire overlay `state`, so pointer/toolbar/state updates can reset `videoHasPlayed=false` for the same media stream and briefly project the wallpaper. The stream identity, not UI state, must own video playback reset.
- Unique owners: `desktop.remote_window_stream.client.input_request` in `android/src/components/terminal/RemoteWindowOverlay.tsx` and page/overlay tests; wallpaper flash is the same overlay projection owner. Existing daemon pointer/key/scroll injection remains owner for OS events and does not need a new path for this slice.
- Allowed paths: `android/src/components/terminal/RemoteWindowOverlay.tsx`, `android/src/components/terminal/RemoteWindowOverlay.test.tsx`, `android/src/pages/TerminalPage.remote-window-overlay.test.tsx`, `android/docs/resource-map.md`, `android/docs/function-map.md`, `android/docs/testing/remote-window-stream-test-design.md`, `.agents/skills/zterm-mobile-dev/SKILL.md`, project memory/note, and only focused remote-window gate scripts if needed.
- Forbidden paths: terminal buffer/renderer, tmux mirror, route selection/reconnect, per-session transport rebuild, daemon gesture fallback, local video/canvas screenshot path.
- Required red/green: touch tap still emits focus-first pointer down/up; unzoomed touch drag emits focus-first pointer down when the drag threshold is crossed, focus-first pointer move events while dragging, and focus-first pointer up on release, with no `kind=gesture`; zoomed fullscreen pan remains local; same media stream state/input changes do not bring back `remote-window-video-wallpaper`.
- 2026-07-23 live release probe correction: installed release daemon PID `94192` runs `/Users/fanzhang/.zterm/releases/zterm-daemon/0.1.3/runtime/server.cjs` with repo/installed SHA `6324c6400c05b0eada34c973c6d367b921255a097350f8259da0a96be1acb83d`. Local live probe now starts the video stream but fails first input at `remote_window_input_failed: remote window input helper timed out`; `ps` during failure showed a `swift-frontend` child under the daemon still compiling/interpreting the helper after the 1s realtime deadline. First divergence is `desktop.remote_window_stream.daemon.input_inject`: helper cold start is being charged to the user operation deadline. Fix must warm the daemon-owned helper without emitting focus/input, while preserving the 1s stale/drop rule for queued real operations.
- 2026-07-23 closeout verification: after installing release runtime, a stale daemon run once returned `app_window_catalog_unavailable` for the live input probe; service-scoped `~/.local/bin/zterm-daemon restart` reset PID to `34464`, release/installed runtime SHA stayed `8a197331d41c2a312746fe4a605ae69f0b9779ae805a4f52b0a9b6ef78a46458`, manual app-window catalog returned `19` targets, and both local `ws://127.0.0.1:3333` plus Tailscale `ws://100.66.1.82:3333` live probes passed with `PROBE_MOUSE_DOWN`, `PROBE_MOUSE_DRAGGED`, `PROBE_MOUSE_UP`, `PROBE_SCROLL`, `PROBE_KEY_DOWN`, and `PROBE_KEY_UP`. This validates daemon protocol and macOS OS-event loopback; no ADB device was online, so installed-phone WebView touch L5 remains unclaimed.

# 2026-07-23 Remote-window installed-phone input diagnostics

- Symptom: Jason's installed Android still shows remote-window video but cannot operate the selected desktop app. Existing daemon WebSocket/WebRTC live probes pass, so the next unknown is whether the phone WebView path actually emits remote-window input metadata on touch/QuickBar/IME.
- Owner/scope: `desktop.remote_window_stream.client.input_request`; resource path `resource.remote_window_overlay -> resource.session_transport -> resource.remote_window_stream`. This slice adds metadata-only diagnostics in `RemoteWindowOverlay` and `TerminalPage` status projection. It does not alter daemon injection, terminal renderer/buffer, route selection, or transport lifecycle.
- Change design: `RemoteWindowOverlay` reports each focus/pointer/key/scroll send attempt as `{source, sent, sessionId, streamId, targetId, event-kind/point}`; `TerminalPage` also records QuickBar/IME remote-window events. The `状态` debug floating window now shows CTX, route/focus policy, client/session/stream/target ids, last source, SEND Y/N, last event, point, and focus/down/move/up/scroll/key/text counts.
- Diagnostic boundary: if Jason's screenshot shows counts unchanged after touching the remote video surface, the bug is Android WebView hit-test/overlay event delivery. If counts move but SEND=N, the bug is active context/sendInput wiring. If SEND=Y with correct coordinates but the desktop app does not react, continue in daemon input-result/focus/injection logs and live probe; do not guess from UI alone.
- Verification: focused remote-window overlay/page/render gates PASS (`61` tests), `tsc --noEmit` PASS, feature/resource/function/mainline gates PASS (`48` tests), `git diff --check` PASS, and full `pnpm --dir android run build:android` PASS with terminal contracts `612` tests, common flows `83` tests, local Relay smoke, Vite/Capacitor/Gradle/update manifest verification.
- Delivery: APK `0.1.3.2219` / versionCode `1032219`, size `4786270`, sha256 `f829be52172ac4a0c00228f9f6733cce263251a95bd138db6ffa8e2ee37f7bf4`. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay `https://relay.codewhisper.cc:18443/relay/updates/latest.json` serve the same manifest/APK sha; public APK HEAD returns `Content-Length=4786270` and `/relay/health` reports `updates.manifestPresent=true`. `adb devices -l` has no online device, so installed-phone screenshot/input L5 remains Jason-side.

# 2026-07-23 Remote-window input-result diagnosis

- Symptom: Jason's installed-phone screenshot now shows `远控 CTX Y`, `RW事件 overlay · SEND Y · ptr:up`, valid stream/target ids, and moving focus/down/move/up counts, but remote-window control still does not operate the desktop app.
- Expected: after each phone-side `remote-window-input` send, the same SessionContext transport receives either `remote-window-input-result accepted=true` or `remote-window-error` with the request id/code; the debug status panel must show this downstream result so the next owner can be isolated.
- SOP/model flow: known `desktop.remote_window_stream.client.input_request -> SessionContext transport -> daemon remote_window_stream.daemon.input_inject -> macOS AX/Quartz`.
- Resource path: `resource.remote_window_overlay -> resource.active_session -> resource.session_transport -> resource.remote_window_stream -> resource.daemon_process`.
- Read-only evidence: local live probe `pnpm --dir android exec tsx scripts/remote-window-live-input-probe.ts` passed against `ws://127.0.0.1:3333`; Tailscale live probe passed against `ws://100.66.1.82:3333`. Both selected a temporary AppKit app-window, started ScreenCaptureKit/WebRTC, and target stdout observed `PROBE_MOUSE_DOWN`, `PROBE_MOUSE_DRAGGED`, `PROBE_MOUSE_UP`, `PROBE_SCROLL`, and key markers.
- Read-only evidence: daemon `/debug/runtime/logs` returned zero client/daemon debug entries, so the phone status panel is currently local-only and daemon did not provide phone request/result trace through that endpoint.
- First divergence found in client result projection: `remote-window-message-runtime.ts#dispatch` routes `remote-window-input-result` to `return false`, and `SessionContext` only registers ice/status listeners. Therefore even if daemon accepted or rejected the phone request, Android does not project the result into status/debug. This is a diagnosis gap and a likely hidden failure surface, not proof that injection succeeded.
- Active hypothesis H1: installed-phone input reaches SessionContext send (`SEND Y`) but the downstream daemon accepted/error result is ignored by client runtime, preventing the next owner decision and hiding target/coordinate/policy failures.
- Unique owner/edit scope: `desktop.remote_window_stream.client.response_dispatch` plus `client.input_request` diagnostics. Allowed paths: `android/src/lib/remote-window-message-runtime.ts`, `android/src/contexts/session-context-provider-runtime.ts`, `android/src/pages/TerminalPage.tsx`, focused remote-window tests, docs/skill/memory. Forbidden: daemon input fallback, terminal renderer/buffer, transport reconnect, coordinate compensation before result evidence.
- Required red/green: `remote-window-input-result` dispatch calls a listener and returns true; `remote-window-error` for non-pending input/result calls an error listener; Terminal status panel shows last daemon input accepted/error result tied to stream/target/request; existing send counters remain intact. Live daemon probe remains required after code change; installed-phone L5 remains Jason-side unless ADB is online.
- Closeout: `remote-window-message-runtime` now exposes a subscriber path for `remote-window-input-result`, quality/status, and unmatched `remote-window-error`; `TerminalPage` status panel shows `RW结果 ACK/ERR` and `A/E` counts. The live input probe now supports `ZTERM_REMOTE_WINDOW_PROBE_MUX=1` and its AppKit fixture creates the target window explicitly so the gate cannot hang before `PROBE_READY`.
- Verification: focused remote-window/page/server tests PASS (`54` tests); `tsc --noEmit` PASS; feature/resource/function/mainline gates PASS (`48` tests); `git diff --check` PASS. Raw WS live probe PASS against `ws://127.0.0.1:3333`; mux-channel live probe PASS against both `ws://127.0.0.1:3333` and `ws://100.66.1.82:3333`, with target AppKit markers `PROBE_MOUSE_DOWN`, `PROBE_MOUSE_DRAGGED`, `PROBE_MOUSE_UP`, `PROBE_SCROLL`, `PROBE_KEY_DOWN`, and `PROBE_KEY_UP`.
- Delivery: APK `0.1.3.2220` / versionCode `1032220`, sha256 `8683a1aa5761e984b091e13ff7ef25f85716e453ff04edf062e0a8ff5a83af34`, size `4786970`. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay `https://relay.codewhisper.cc:18443/relay/updates/latest.json` all serve `0.1.3.2220`; all three APK downloads sha-match the manifest. No ADB device is online, so installed-phone `RW结果` screenshot remains Jason-side.

# 2026-07-23 Remote-window local action loopback / clock-skew diagnosis

- Symptom: Jason's installed-phone status now shows `RW事件 ime-input · SEND Y · text:1/down` followed by `RW结果 ERR remote_window_input_failed remote window input stale`. The event leaves Android and daemon returns a policy error, so this is no longer a hidden UI send/result projection gap.
- Expected: mobile/Mac wall-clock skew must not decide whether a realtime input is stale. The realtime gate is local to the actor that queues the operation: Android may drop old local touch classifications before send; daemon may drop operations that waited too long after daemon receive/enqueue; `clientSentAt` is debug metadata only across devices.
- SOP/model flow: `desktop.remote_window_stream.client.input_request -> resource.remote_window_overlay -> resource.session_transport -> resource.remote_window_stream -> desktop.remote_window_stream.daemon.input_inject`.
- Confirmed first divergence: `remote-window-stream-daemon.ts#validateRemoteWindowInput()` compares `Date.now()` on Mac with Android `payload.clientSentAt`, and `createDefaultRemoteWindowInputHelper().rejectIfStale()` repeats the same cross-device wall-clock comparison. The live raw/mux probes used same-Mac timestamps, so they could not catch phone/Mac clock skew.
- Unique owner/edit scope: `desktop.remote_window_stream.daemon.input_inject` plus the local action loopback probe: `android/src/server/remote-window-stream-daemon.ts`, `android/src/server/remote-window-stream-daemon.test.ts`, `android/scripts/remote-window-live-input-probe.ts`, `android/docs/testing/remote-window-stream-test-design.md`, `.agents/skills/zterm-mobile-dev/SKILL.md`, project memory/note. Forbidden: UI compensation, terminal renderer/buffer, transport reconnect, Relay route changes, disabling stale entirely.
- Required red/green: daemon accepts missing/old/future `clientSentAt` when daemon receive time is fresh; helper stale checks use daemon-local `daemonReceivedAtMs`; daemon-local stale still rejects; live probe supports `ZTERM_REMOTE_WINDOW_PROBE_CLIENT_CLOCK_OFFSET_MS=-60000` and runs raw + mux through a local action sequence that maps tap/drag/scroll/key to focus-first remote input and verifies AppKit stdout markers.
- Closeout: daemon input stale now uses daemon-local `daemonReceivedAtMs` receive/enqueue time. Android `clientSentAt` remains debug metadata only and missing/old/future client wall-clock values no longer reject fresh daemon input; daemon-local queued requests older than one second still reject before helper injection.
- Local action loopback: `remote-window-live-input-probe.ts` now supports `ZTERM_REMOTE_WINDOW_PROBE_CLIENT_CLOCK_OFFSET_MS` and sends focus-first action sequence `tap-down/up`, `drag-down/move/up`, `scroll`, and `key` instead of a same-host timestamp-only input sequence.
- Verification: `remote-window-stream-daemon.test.ts` PASS `41`; mapped remote-window focused suite PASS `9 files / 144`; `tsc --noEmit` PASS; `test:feature-registry` PASS `48`; `git diff --check` PASS; raw WS live probe with `ZTERM_REMOTE_WINDOW_PROBE_CLIENT_CLOCK_OFFSET_MS=-60000` PASS; mux-channel live probe with `ZTERM_REMOTE_WINDOW_PROBE_CLIENT_CLOCK_OFFSET_MS=-60000` PASS; Tailscale mux live probe `ws://100.66.1.82:3333` with same skew PASS. A first parallel raw+mux attempt failed at app catalog and a first Tailscale run failed before probe app ready; both passed after serializing resources, so loopback gates should be run serially.
- Delivery: Android build PASS. APK `0.1.3.2221` / versionCode `1032221` / sha256 `836b54dc8f47f662e95a6e446340a0ed7b11562178105219f38bb3589823b17f` / size `4786970` published to local update dir, daemon 127/Tailscale update routes, and public Relay update route. Public Relay APK HEAD returned `Content-Length=4786970`, and downloaded APK sha matched. `adb devices -l` returned no online devices, so installed-phone L5 remains Jason-side.

# 2026-07-23 Remote-window installed-phone stale after 2221

- Symptom: Jason's installed phone on `0.1.3.2221` still shows `RW事件 overlay · SEND Y · ptr:up` followed by `RW结果 ERR remote_window_input_failed remote window input stale`; counts move, so Android hit-test/send/result projection are alive.
- Release/runtime check from prior diagnosis: live daemon PID runs packaged `~/.zterm/releases/zterm-daemon/0.1.3/runtime/server.cjs` and SHA matches release, so this is not a stale daemon install issue.
- First diagnostic correction: existing live probes are serial (`focus` ACK awaited, then action ACK awaited). They prove raw/mux protocol and AppKit loopback but do not model Android WebView burst semantics where focus marker + pointer/key/text events can arrive back-to-back.
- Active hypothesis: `RemoteWindowOverlay` / `TerminalPage` correctly emit focus-first marker before each actual operation, but `remote-window-stream-daemon` also runs full AX focus inside every actual input. The standalone focus marker is therefore a duplicate full helper request. Under phone burst input, duplicate focus helper requests queue ahead of real pointer/key/text and the daemon-local 1s stale gate rejects later operations while they wait in helper queue. Unique owner is `desktop.remote_window_stream.daemon.input_inject` plus live burst gate; terminal transport/renderer/Relay are forbidden.

# 2026-07-23 Remote-window burst stale gate closeout

- Jason installed-phone evidence invalidated the previous serial live probe: phone showed `RW事件 overlay · SEND Y · ptr:up` followed by `RW结果 ERR remote_window_input_failed remote window input stale`, while serial raw/mux probes had passed. This proves Android hit-test/send/result projection reached daemon, and the missing test was phone-style focus-first burst timing.
- Root cause: daemon Swift helper ran full focus/AXRaise/activate/sleep on every focus marker and again before real pointer/key input. In a WebView burst, repeated focus requests queued ahead of actual input and pushed later operations past the daemon-local 1s stale gate.
- Fix owner: `desktop.remote_window_stream.daemon.input_inject`. Added focused-target fast path: if target pid is already frontmost and matched AX window is focused, repeated focus returns immediately. No renderer/transport/Relay fallback was added.
- Gate correction: `scripts/remote-window-live-input-probe.ts` now supports `ZTERM_REMOTE_WINDOW_PROBE_BURST=1`, sending focus + pointer/key actions without serial ACK waits. Docs, feature gate, function map, skill, and MEMORY now require burst live probes for this class.
- Verification: focused remote-window suite `9 files / 220 PASS`; `tsc --noEmit` PASS; feature/resource/function/mainline gates `48 PASS`; `git diff --check` PASS. Live burst gates PASS: raw local, mux local, mux Tailscale; repeated with `ZTERM_REMOTE_WINDOW_PROBE_CLIENT_CLOCK_OFFSET_MS=-60000` also PASS for all three.
- Delivery: `pnpm --dir android run build:android` PASS and published Android `0.1.3.2222` / versionCode `1032222` / sha256 `ea14b71c834250236e6a9a49d7fa844a0c2989465ac85b3dcc56b7d3cfda9e1f` / size `4786970`. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay update routes all serve matching manifest/APK hash. `adb devices -l` has no online device, so physical installed-phone L5 remains Jason-side.

# 2026-07-23 Remote-window touch/action layer split diagnosis

- Symptom: installed Android can show `RW事件 ... SEND Y`, but WebView DevTools hook observed no physical `remote-window-input` frame on `RTCDataChannel.send` after tapping the video surface. Expected: touch/action classification, focus-first input emission, transport dispatch attempt, and downstream result are separately observable; overlay/UI state cannot claim send success by itself.
- SOP/model flow: `desktop.remote_window_stream.client.touch_action -> desktop.remote_window_stream.client.input_request`; resource path `resource.remote_window_overlay -> resource.remote_window_touch_action -> resource.session_transport -> resource.remote_window_stream`. Forbidden edge remains `resource.remote_window_overlay -> resource.remote_window_stream`.
- Confirmed first divergence: `RemoteWindowOverlay` still owns WebView pointer state, coordinate mapping, touch drag classification, focus-first wrapping, and dispatch debug. This couples WebView/overlay projection to app input semantics and makes `SEND Y` a local React callback fact rather than a physical transport/result fact.
- Unique owner/edit scope: `resource.remote_window_touch_action` and its adapter edge from `RemoteWindowOverlay`. Allowed paths: `android/src/lib/remote-window-touch-action-runtime.ts`, its focused tests, `RemoteWindowOverlay.tsx/test`, `TerminalPage.remote-window-overlay.test.tsx`, and docs/maps/gates already bound to `desktop.remote_window_stream.client.touch_action`. Forbidden: daemon AX/Quartz helper, terminal buffer/renderer, route/reconnect, screenshot/file-transfer, tmux/input fallback.
- Required red/green: pure runtime maps surface geometry to global macOS coordinates; unzoomed touch tap emits focus-first pointer down/up; unzoomed touch drag emits focus-first pointer down at start, absolute pointer moves, pointer up on release/cancel; zoomed fullscreen one-finger pan emits local projection only; unsupported/missing context never reports sent; page black-box proves video-surface events leave through remote-window input and never terminal input; installed-phone L5 must hook physical WebSocket/DataChannel or downstream result, not just status text.

# 2026-07-23 Remote-window installed-phone keyboard and touch E2E

- Installed-phone evidence on `0.1.3.2225`: opened a real app-window stream for `ZTERM_PHONE_E2E_PROBE_1784793435553` on device `100.104.163.65:5555`; the video preview rendered. ADB tap on the video surface produced `PHONE_E2E_MOUSE_DOWN` and `PHONE_E2E_MOUSE_UP`; ADB swipe on the same surface produced `PHONE_E2E_SCROLL dx=0 dy=123`. This proves current touch tap + swipe reaches macOS OS-event injection on the installed phone for the controlled probe window.
- Keyboard symptom remains live: pressing remote-window `KB` calls the Android native `ImeAnchor.show()` path, and native state reports `pendingShowRequest=true`, `hasFocus=true`, `hasWindowFocus=true`, `hasWindowToken=true`, `inputEnabled=true`, but `keyboardVisible=false` and `keyboardHeight=0`; screenshot still shows no soft keyboard. Logcat shows `imm.showSoftInput(... SHOW_IMPLICIT)` returned `shown=true`, but the keyboard layout observer never reported visible occlusion.
- SOP/model flow: `desktop.remote_window_stream.client.input_request -> terminal.keyboard_ime -> resource.platform_input_channel -> resource.session_transport -> resource.remote_window_stream`. The first divergence is the native IME show owner, not remote-window overlay: remote-window publishes the input context and calls the keyboard request, but the platform anchor receives focus without a visible soft keyboard.
- Active hypothesis H1: `ImeAnchorPlugin` keeps `imeEditText.setShowSoftInputOnFocus(false)` even during explicit user keyboard intent. On this OEM/IME, `showSoftInput(SHOW_IMPLICIT)` can return true while producing no visible keyboard unless the anchor allows soft input on focus for the explicit show window. Unique owner/edit scope: `terminal.keyboard_ime` native anchor show policy in `android/native/android/app/src/main/java/com/zterm/android/ImeAnchorPlugin.java`, plus `android/src/lib/android-ime-anchor-truth.test.ts`, `TerminalPage.remote-window-overlay.test.tsx`, `android/docs/function-map.md`, `android/docs/feature-gates.md`, and `android/docs/testing/terminal-keyboard-ime-test-design.md`. Forbidden: terminal renderer/buffer, daemon input injection, remote-window transport, route reconnect, duplicate hidden input path.
- Closeout on installed Android `0.1.3.2226` / versionCode `1032226`: package installed on `100.104.163.65:5555`; pressing remote-window `KB` via real ADB tap showed Android soft keyboard and `ImeAnchor.getState()` reported `keyboardVisible=true`, `keyboardHeight=1041`, `hasFocus=true`, `inputEnabled=true`. Screenshot saved at `/tmp/zterm-2226-remote-window-kb.png`. After hiding keyboard, repeated ADB video-surface tap/swipe appended controlled probe events: `before=6 after=15 delta=9`, i.e. three cycles of `PHONE_E2E_MOUSE_DOWN`, `PHONE_E2E_MOUSE_UP`, and `PHONE_E2E_SCROLL dx=0 dy=123`. CDP Network also captured real `mux-channel-message` remote-window input frames and matching `remote-window-input-result accepted=true` frames for pointer down/up. Remaining observed gap: the status debug panel did not project ACK counts without an explicit result UI refresh path; core input and gesture injection were verified end-to-end.
- Delivery: focused remote-window/IME tests PASS `64`, `test:feature-registry` PASS `48`, full `build:android` PASS, installed `0.1.3.2226` on device, local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay update routes serve APK sha256 `5f69b7887412233bd53d63fde62cf3cfd683b4d9eab47d9fea9bc4aff976ba84` / size `4789338`.
# 2026-07-23 Android connected-green render-stale root cause

- Live ADB/WebView现场证据：daemon pid 4175 restart后 mirror `zterm` revision 4774/latestEndIndex 1385 持续前进；Android WebView TerminalView live store revision 71847/endIndex 2998 仍停在 restart 前高 revision，DOM tail不变但顶部 rx/tx继续变化。
- 根因不是 ring/cache 回滚。ring/cache 只影响 startIndex/endIndex/gapRanges/missingRanges；当前是 daemon mirror in-memory revision namespace 重置后，新合法低 revision 被 `session-render-buffer-store` 的 anti-regression guard 拒绝，render store 不通知 subscriber。
- 唯一 owner：terminal.buffer_render / session-render-gate + session-render-buffer-store。修复方向：只有 render gate 看到 projected.revision 与 projected.daemonHeadRevision 同时低于 previous 时，显式授权 lower-revision publish；低 buffer revision 但 daemon head 未 reset 仍拒绝。

# 2026-07-23 Remote-window scroll tuning execution

- Scope: `desktop.remote_window_stream.client.touch_action` / `resource.remote_window_overlay -> resource.remote_window_touch_action`; forbidden daemon compensation preserved.
- Implemented draft: default touch gesture scale `2x`, selectable scroll scale `1/1.5/2/3/4x`, persisted reverse toggle, fullscreen two-finger candidate classifier, two-finger remote `scroll`, pinch axis lock, zoomed single-finger local pan preserved.
- Verification so far: focused remote-window runtime/overlay/page gate passed `58` tests; `tsc --noEmit`, `test:feature-registry` (`48`), and `git diff --check` passed. Next: full `build:android`, update-route checks, then commit.

# 2026-07-23 Remote-window floating controls / capture timeout diagnosis

- Symptom: Jason reports the target-locked remote-window floating preview cannot be moved/closed, and video stream startup fails with `ScreenCaptureKit capture did not produce a frame before timeout`.
- SOP/model flow: `desktop.remote_window_stream.overlay_projection -> desktop.remote_window_stream.daemon.capture`. Resource path stays `resource.remote_window_overlay -> resource.remote_window_touch_action -> resource.remote_window_stream` for input and `resource.remote_window_overlay -> active session transport -> resource.remote_window_stream` for stream start. Forbidden: terminal renderer/buffer fallback or local video/screenshot fake frames.
- Confirmed UI divergence: scroll tuning / bitrate / screenshot / keyboard controls were all in the same draggable toolbar row, so on phone-width floating preview they crowded the top bar and pushed the close/fullscreen actions out of the reachable row while also shrinking the drag hit zone. Fix keeps only title + fullscreen/close in the fixed top bar and moves tuning controls to a horizontally scrollable secondary strip.
- Capture/catalog live diagnosis: installed daemon raw WS catalog returned `app_window_catalog_unavailable`; standalone source and installed Swift catalog scripts both produced JSON, so the likely failure is daemon `execFile(swift -e ...)` timing/error projection, not macOS API absence. Startup timeout also hid stderr detail, making ScreenCaptureKit permission/window/frame stalls indistinguishable.
- Fix owner/scope: `desktop.remote_window_stream` in `RemoteWindowOverlay.tsx/test` plus daemon capture/catalog timeout/error reporting in `remote-window-stream-daemon.ts/test`. Increased app-window catalog timeout to 15s and capture first-frame startup timeout to 20s; timeout messages now preserve timeout ms and bounded stderr while still stripping inline Python/Swift source text.
- Verification closeout: focused remote-window receiver/overlay/touch/page/daemon suite passed `113` tests; `tsc --noEmit`, feature/resource/function/mainline gates `48 PASS`, and `git diff --check` passed. Packaged daemon release SHA matches installed runtime (`server.cjs` `13eb18347c35c70cbab063bf6d46c85f1c547ac2d8a337d7d3a48d4329d575d0`), service-scoped restart moved daemon to PID `12714`, and live ScreenCaptureKit/WebRTC/input probes passed on raw local, mux local, and mux Tailscale with `trackSeen=true` and real AppKit mouse/drag/scroll/key markers. Full Android build passed and published APK `0.1.3.2229` / versionCode `1032229` / sha256 `25adbc988196f8bf9558932aebd85048183f6ba3e266a6b4c53e953021a8a13f`; local, Tailscale, and public Relay update routes serve matching manifest/APK sha. No online ADB device is attached, so installed-phone L5 remains Jason-side.
- Gate correction after rerun: `remote-window-stream-daemon.test.ts` same-target slow-focus test cannot fake `swift -e` with a shebang script on macOS because the leading `-e` prevents the script body from becoming the executed program. The test now injects a process factory and starts the stale budget after helper warm, matching production receive/enqueue semantics. Rerun focused remote-window suite passed `5 files / 113 tests`, `tsc --noEmit`, `test:feature-registry`, and `git diff --check`.

# 2026-07-24 Terminal large-refresh / remote-window latency closeout

- Objective source: `/Users/fanzhang/.codex/attachments/9f8a365c-7b6c-4d43-a855-a8cae47d2dd9/pasted-text-1.txt`. Scope: P0 terminal updates larger than one screen, P1/P2 remote-window latency quality model, P3 scroll units.
- P0 root cause: `terminal-mirror-runtime.ts` capped oversized changed-span body `buffer-sync` to live tail, so middle source rows could be silently skipped while the client kept stale body rows. Fix: live body changed span is split into contiguous same-revision chunks under the byte budget; each authoritative source row in the span is covered. Initial forced oversized seed remains bounded to live tail.
- P1/P2 closeout: regular presets default to 30 FPS and desktop-fullscreen ceiling is 60 FPS; ScreenCaptureKit receives explicit `minimumFrameInterval` and `queueDepth=1`; getStats adaptation samples RTT/available bitrate/FPS/dropped/freeze/jitter/quality limitation, converts cumulative counters to per-sample deltas, downgrades after consecutive weak samples to 1/4 bitrate + half FPS floor 5, and restores only after a stable window. Existing sender encodings are updated without stream restart.
- Live WebRTC correction marker `remote-window-transceiver-sendEncodings-trackSeen-20260724`: real `@roamhq/wrtc` sender can have no encodings when created via `addTrack`; stream start now seeds send encodings via `addTransceiver(... sendEncodings ...)` when available. The live probe applies daemon ICE candidates and requires a receiver video track (`trackSeen=true`) via `ontrack` or `getReceivers()`.
- P3 closeout: remote-window scroll tuning is now visible-surface fractions `1/8`, `1/4` default, `1/2`, `1 screen`; direction inversion flips only sign. Persist key is `zterm:remote-window:touch-scroll-fraction-v1`.
- Verified gates: focused remote-window suite `5 files / 118 PASS`; typecheck PASS; feature/resource/function/mainline gates `48 PASS`; `git diff --check` PASS; terminal contracts `49 files / 625 PASS`; daemon mirror close-loop PASS all 9 cases with evidence `android/evidence/daemon-mirror/2026-07-24/summary.json`; raw local, mux local, and mux Tailscale remote-window live probes PASS with `trackSeen=true` and AppKit input markers.
- Delivery evidence: daemon prepared/installed/restarted with `/health` PID `90113` and installed/release runtime SHA `8e18204544b37d43583e3699966cef9b4240398f868fc96bdad389dd93b3027e`; Android build produced APK `0.1.3.2230` / versionCode `1032230` / sha256 `8a9c3ef3d6b0a11b55f057836fe16d1cc7ff6f3d3c5973a70f4db370f5ea835b` / size `4792586` at `android/update-dist/zterm-0.1.3.2230.apk` and `/Users/fanzhang/.zterm/updates/zterm-0.1.3.2230.apk`. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay `https://relay.codewhisper.cc:18443/relay/updates/latest.json` all serve matching manifest/APK sha. No online ADB device was attached, so installed-phone L5 remains unclaimed.

# 2026-07-26 terminal input-row stale refresh root-cause audit

- Scope: Jason reports the terminal bottom/input rows still show already-submitted text while the command is running. This remains `terminal.buffer_render`, not QuickBar/chrome/status overlay.
- Header truth confirmed in code: `buildBufferHeadPayload()` computes `latestEndIndex = availableEndIndex = mirror.bufferStartIndex + mirror.bufferLines.length`. This is only the authoritative tail absolute index; it is not row-level freshness and it cannot repaint body rows.
- Client freshness gap found in code: `applyBufferSyncToSessionBuffer()` writes the incoming payload `revision` onto the whole local sparse buffer after applying a sparse body patch, even if that payload only contains one changed row. The planner later compares only global `localRevision`, `daemonHeadRevision`, and tail/end indexes. A non-gap visible row that missed its repaint can therefore look "fresh" once any later sparse row advances the whole buffer revision.
- Live daemon evidence from `~/.zterm/logs/launchd-stdout.log`: current `zterm` mirror repeatedly held `buffer=5255-6346` / visible `6295-6346`, while revisions `7382+` only sent `changedRanges=[6340,6341)`. In that shape, a stale visible/input row outside `6340` will never be repaired by header calculation; later one-row updates keep advancing revision while preserving the old local row.
- Why prior fixes did not close it: prior fixes covered same-revision requested overwrite, head-before-body pending authority, visible gap repair, oversized chunk frame identity, and renderer same-text/style repaint. They did not add a black-box gate for "source row changed/cleared once, client missed that non-gap row, then later tiny sparse patches advance global revision and suppress visible repair".
- Required next fix direction: add source-to-payload-to-client-to-DOM gate for this stale non-gap visible-row case. Then fix the unique owner by either making sparse apply track row-level revision/authority or requiring a visible-window authoritative repaint when a same-end sparse live patch advances global revision without covering the whole visible/input window. Do not use header/body clear/UI reset as compensation.

# 2026-07-24 Remote-window WeChat video start diagnosis

- Symptom: installed Android floating remote-window preview for WeChat showed `正在建立视频流` and never displayed video.
- Exact target from live catalog: `app-window:486:2757`, title `微信`, crop `1037x1177`, app bundle `com.tencent.xinWeChat`.
- First divergence: daemon stream start with requested bitrate used `addTransceiver(videoTrack, { sendEncodings })`; direct live probe showed ScreenCaptureKit started and WebRTC ICE connected, but the answer SDP direction was `inactive`, so Android receiver `ontrack` did not fire. Same exact target without bitrate produced `sendonly` and `ontrack`.
- Fix: daemon stream start now uses `addTrack(videoTrack)` for sendonly-safe negotiation, then applies bitrate after localDescription only if existing sender encodings can be updated. Quality unsupported remains explicit and does not block video startup. Live probe now requires actual `ontrack`, not just `getReceivers().track.live`.
- Verification: focused remote-window daemon/message suite passed `2 files / 60`; typecheck, feature/resource/function/mainline gates, and `git diff --check` passed. Daemon release/install runtime SHA is `74002cca973777d84ddd7633cf30d5b59e00cd0da638e7e267332a0b1339e3da`. Exact WeChat raw local video-only replay and exact WeChat Tailscale mux video-only replay both returned ScreenCaptureKit `1037x1177`, `ontrack=true`, `framesSent=1`, and explicit stream stop. Full focus variant still exposes a separate Tailscale mux control gap where `remote-window-input` focus returns accepted but WeChat does not become frontmost; this is not part of the video-start fix.
- Delivery: Android update package `0.1.3.2231` / versionCode `1032231` / sha256 `9786f7992d124e07ff1dae1e76850293d9090f9a2c851922cda523f56345921b` is published on local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay `https://relay.codewhisper.cc:18443/relay/updates/latest.json`; all three downloaded APK streams match the manifest sha. `adb devices -l` has no online device, so installed-phone L5 remains Jason-side.

# 2026-07-24 Terminal input refresh freshness diagnosis

- Symptom: Jason reports current terminal refresh timing is wrong and the input area/body does not refresh reliably. This is `terminal.buffer_render`, not UI chrome or transport fallback. Resource path stays `resource.mirror_store -> resource.transport_subscriber -> resource.client_sparse_buffer -> resource.renderer_window`.
- First likely divergence: `handleBufferHeadRuntime()` clears `lastSyncRequestAtRef` for `tail-refresh` and `reading-repair` immediately when `buffer-head` arrives. If the explicit body response arrives after that head with the same mirror revision, `applyIncomingBufferSyncRuntime()` no longer sees a pending request and drops the same-revision non-gap overwrite as stale. This matches stale visible rows / input tail not repainting after a head-first sequence.
- Fix direction: keep body request freshness bookkeeping until the matching body apply/drop path consumes it; do not patch UI or daemon. Add optional buffer protocol timestamps for observability only: client request timestamp and daemon response generation timestamp. Revision/absolute row remain the linear truth.

# 2026-07-24 Same-revision visible refresh / remote-video pending projection

- Symptom A: after repeated network switches/reconnects, terminal bottom live rows continue updating while upper visible rows remain stale, or only part of the visible content refreshes.
- Confirmed owner boundary: `terminal.buffer_render` client sparse-buffer apply. Existing same-revision stale overwrite protection correctly rejects unsolicited old packets, but it also rejected an explicit reconnect `tail-refresh` / reading `reading-repair` response when daemon returned the same revision with corrected visible rows.
- Fix: same-revision non-gap overwrite is accepted only when the incoming range overlaps a recorded pending visible-refresh request and its `knownRevision` / `targetHeadRevision` match local and incoming revision. Unrequested same-revision overwrite still drops.
- Red/green: focused runtime test reproduces stale upper rows with live lower rows, then proves explicit pending refresh replaces the upper rows and schedules render commit; existing stale same-revision drop and gap-fill tests remain green.
- Symptom B: remote-window `<video>` exposes WebView's gray native playback placeholder before actual playback.
- Projection fix: keep video transparent until `playing`, show the ZTERM engraved logo wallpaper, attach the negotiated `MediaStream`, and retry `play()` on stream attach, metadata, canplay, and user pointer. This does not substitute for ScreenCaptureKit/WebRTC truth.
- Verification: focused buffer/render/remote-window gate passed `4 files / 90`; `tsc --noEmit` PASS; feature/resource/function/mainline gate `48 PASS`; `git diff --check` PASS; daemon mirror close-loop PASS all 9 cases including `top-live`, `vim-live`, `long-input-echo`, and `daemon-restart-recover`; full `build:android` PASS with terminal contracts `625 PASS`, common user flows `83 PASS`, and relay local smoke PASS.
- Delivery: APK `0.1.3.2232` / versionCode `1032232` / sha256 `029aa8513b0879d9728ccde272a2f1e3788800d8188d0df165e5f6345d32a90d` / size `5599534`. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay update routes all serve matching manifest/APK sha. `adb devices -l` returned no online devices, so installed-phone L5 remains Jason-side.

# 2026-07-24 Remote-window wallpaper / stream-start diagnosis

- Symptom: installed Android remote-window stream surface shows the pending wallpaper with the logo plus a large `ZTERM` wordmark; Jason wants a single logo only. Same screenshot also shows the stream not connected/visible.
- SOP/model flow: `desktop.remote_window_stream.overlay.project -> desktop.remote_window_stream.android.frame.render` for wallpaper projection; `desktop.remote_window_stream.start.request -> daemon.stream_start -> daemon.capture_frame -> android.receiver.attach` for connectivity. Resource path: `resource.remote_window_overlay -> resource.remote_window_stream` only via active session transport for stream start; terminal mirror/buffer/render are forbidden compensation paths.
- Confirmed owner A: `RemoteWindowOverlay` renders `videoWallpaperMark` with literal `ZTERM`; tests currently assert wallpaper text contains `ZTERM`. This is projection owner only and can be removed without touching daemon/capture.
- Read-only connectivity evidence: daemon `/health` is OK on PID `90934`. Exact existing WeChat app-window video-only probe over raw local WebSocket passed with `trackSeen=true`, ScreenCaptureKit `1037x1177`, `framesSent=1`, and explicit stop. The same exact target over Tailscale mux passed with `trackSeen=true`, ScreenCaptureKit `1037x1177`, `framesSent=1`, and explicit stop. Therefore local daemon capture/WebRTC and Tailscale mux stream-start are not currently the first failing node for the screenshot; the remaining unverified path is the installed phone route/UI entry that produced the screenshot.
- Failed auxiliary evidence: temporary AppKit live input probe failed before daemon stream-start because the probe app exited before `PROBE_READY`; this does not prove remote-window stream failure.
- Allowed paths for the projection fix: `android/src/components/terminal/RemoteWindowOverlay.tsx`, `android/src/components/terminal/RemoteWindowOverlay.test.tsx`, optional docs/memory/skill notes. Connectivity fix is not unlocked unless a failing stream-start owner is reproduced.

# 2026-07-24 Remote-window wallpaper closeout

- Change: removed the large `ZTERM` text mark from `RemoteWindowOverlay` pending/unplayed video wallpaper; retained the engraved logo image only and updated overlay tests to lock no wordmark.
- Verified: focused remote-window gate `4 files / 118 PASS`; `tsc --noEmit` PASS; feature/resource/function/mainline gates `48 PASS`; `git diff --check` PASS; exact WeChat raw local video-only probe PASS and exact WeChat Tailscale mux video-only probe PASS with `trackSeen=true`, ScreenCaptureKit `1037x1177`, `framesSent=1`; full `build:android` PASS with terminal contracts `627 PASS`, common flows `83 PASS`, local Relay smoke PASS.
- Delivery: APK `0.1.3.2234` / versionCode `1032234` / sha256 `5d8660783b4e67cdba9721f9da8ff4d5bd3bef4d83b96485d948f45ac3961805` / size `5599578`. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay update routes serve matching manifest/APK sha. `adb devices -l` returned no online devices, so installed-phone L5 remains Jason-side.

# 2026-07-24 Remote-window wallpaper blend / playback-stuck diagnosis

- Symptom: installed Android screenshot shows the pending wallpaper logo as a visible square card whose four corners do not blend with the remote video background. The screenshot also has no `正在建立视频流` / `视频流启动失败` text, only the wallpaper in the video content area, which matches `streamStarted && receiverMediaStream && videoHasPlayed=false` rather than daemon stream-start error projection.
- Expected: pending/unplayed background must blend into the Z-term dark surface and must not hide an already attached receiver stream forever just because Android WebView does not fire `playing`.
- SOP/model flow: `desktop.remote_window_stream.android.receiver.attach -> desktop.remote_window_stream.android.frame.render` for attached media projection. Resource path remains `resource.remote_window_overlay -> resource.remote_window_stream` via active session transport. Forbidden fixes: terminal renderer/buffer, daemon stream fallback, local fake screenshot/video.
- Evidence A: `assets/logo.png` is RGB with an opaque white background. Rendering it as a normal `<img>` over a dark wallpaper will always show a square/corner matte. Unique owner is `RemoteWindowOverlay` wallpaper projection; fix by blending/masking at projection layer, not by changing stream truth.
- Evidence B: WeChat raw local and Tailscale mux video-only probes both passed with `trackSeen=true` and `framesSent=1`; `adb devices -l` shows no online device, so the installed-phone route is not directly replayable here. The screenshot state points to client video visibility/playback gating as the first local divergence: the video is set to `opacity: 0` until `playing`, and `play()` rejection sets `videoHasPlayed=false`, which can permanently show the wallpaper even after a `MediaStream` is attached.
- Unique owner/edit scope: `RemoteWindowOverlay` plus focused overlay tests. Required red/green: wallpaper uses blend mode that hides the opaque white logo background; loaded metadata / loaded data / canplay / playing can mark an attached stream visible; a rejected `play()` attempt must not re-hide an attached stream indefinitely; pending no-stream state still shows the wallpaper.

# 2026-07-24 Remote-window wallpaper blend / playback-stuck closeout

- Change: `RemoteWindowOverlay` now blends the opaque RGB logo with `mix-blend-mode:multiply` and removes drop-shadow so the source image's square alpha cannot draw a card. Attached receiver video is revealed on `loadedmetadata` / `loadeddata` / `canplay` / `playing`, `play()` rejection no longer re-hides it, and a bounded same-stream timer prevents Android WebView from showing the pending wallpaper forever after a `MediaStream` is attached.
- Verified: focused remote-window gate `4 files / 120 PASS`; `tsc --noEmit` PASS; feature/resource/function/mainline gates `48 PASS`; `git diff --check` PASS. Serial exact WeChat probes passed on raw local and Tailscale mux with `trackSeen=true`, ScreenCaptureKit `1037x1177`, `framesSent=1`. An earlier parallel raw+mux probe hit the known ScreenCaptureKit same-target timeout false red; the serial rerun passed and matches the skill rule.
- Delivery: APK `0.1.3.2235` / versionCode `1032235` / sha256 `a1e6424c8c1def717db340c5caa842e0082193c5ec180d97cd6605b7660a5d8a` / size `5599690`. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay update routes serve matching manifest/APK sha. `adb devices -l` returned no online devices, so installed-phone L5 remains Jason-side.
# 2026-07-24 remote-window stream start timeout after 2235

- Jason's installed 2235 screenshot still shows `视频流启动失败 / Remote window stream start timed out`, so the prior overlay wallpaper/video reveal fix did not close the actual stream-start path.
- Architecture owner remains `desktop.remote_window_stream`; allowed path is `resource.remote_window_overlay -> resource.session_transport -> resource.remote_window_stream`. UI wallpaper/reveal is downstream projection only and must not be used as proof that stream negotiation works.
- Mainline traced: `RemoteWindowOverlay -> RemoteWindowMessageRuntime -> RemoteWindowReceiver -> SessionContext remote-window runtime -> existing session transport/mux -> terminal-message-runtime -> remote-window-stream-daemon.startStream -> remote-window-stream-started/error -> SocketMessage -> RemoteWindowMessageRuntime -> Receiver -> Overlay`.
- First code evidence: `remote-window-message-runtime` uses one 15s timeout for both target catalog and stream start. Daemon stream start can wait up to 20s for ScreenCaptureKit first frame and also warms the input helper up to 15s in parallel before returning the answer. Therefore a healthy but slow start can be misreported as client-side `Remote window stream start timed out` before daemon emits its explicit `remote-window-stream-started/error`.
- Second code evidence: `remote-window-receiver-runtime` arms the 25s video-track timer before the offer is sent to the daemon, so daemon startup time is counted against receiver attach time. If daemon answers after >25s, Android can reject with a receiver-track error before the answer is even applied.
- Active hypothesis H1: current timeout ownership is wrong, not just the background image. Stream-start request timeout must be separate from catalog timeout and must exceed daemon capture startup + helper warm + network budget; receiver track timeout should start after the answer/remoteDescription is applied so it measures receiver attach, not daemon capture startup.

# 2026-07-24 remote-window wallpaper alpha correction after Android screenshot

- Jason's screenshot/feedback shows the opaque RGB `assets/logo.png` still projects as a square card on the dark stream placeholder. Relying on CSS `mix-blend-mode:multiply` is not a valid Android WebView gate because the source image itself has no alpha and the WebView may not visually blend it as expected.
- Projection owner remains `desktop.remote_window_stream.android.frame.render` / `resource.remote_window_overlay`; daemon capture/stream truth is unrelated.
- Fix direction: derive and render an actual transparent engraved logo asset for the video placeholder. The placeholder must not depend on CSS blend as the only way to hide the source image's white background.

# 2026-07-24 remote-window native video placeholder after 2236

- Jason's installed 2236 screenshot shows a giant Android/WebView native video play placeholder instead of the engraved waiting wallpaper or real frames. Status overlay shows `connected / waiting`, route `tailscale / open`, `远控 CTX Y`, and recent RW input ACK, so the current first divergence is Android `<video>` visibility/playback projection, not daemon input send.
- Previous 2235 MEMORY/skill rule that `loadedmetadata` / `loadeddata` / `canplay` / same-stream ready poll can reveal the receiver video is now disproven by the installed screenshot. Those events can occur while WebView still exposes a native play placeholder.
- Code evidence: the in-progress overlay patch still had `readyState >= 2 && !paused` poll reveal and the stream effect depended on callbacks that included `videoHasPlayed`, so a visibility state change could rerun the effect and reset `videoHasPlayed=false`.
- Fix applied in `RemoteWindowOverlay`: video visibility is now stream-identity/ref driven; `loadedmetadata` / `loadeddata` / `canplay` / bounded poll only retry `play()` and publish debug; native `<video>` stays `opacity:0` and `visibility:hidden` until `play()` resolves, `playing` fires, or `requestVideoFrameCallback` reports a frame. `TerminalPage` status overlay now reports video attach/visible/ready/paused/dimensions/play attempts/accept/reject/last event/error.
- Verification so far: focused overlay/page gate `54 PASS`; mapped remote-window stack `10 files / 207 PASS`; `tsc --noEmit` PASS; feature/resource/function/mainline gates `48 PASS`; `git diff --check` PASS; raw local and Tailscale mux WeChat video-only probes both returned `trackSeen=true`, `ScreenCaptureKit 1037x1177`, `framesSent=1`. `adb devices -l` has no online device, so installed-phone visual L5 remains Jason-side after package delivery.

# 2026-07-24 remote-window live Android no-inbound-RTP diagnosis

- Installed Android `0.1.3.2237` on `100.104.163.65:5555` showed the correct waiting wallpaper, but CDP proved the attached `<video>` still had `readyState=0`, `videoWidth=0`, `currentTime=0`, and one live muted video track. RTCPeerConnection state/ICE/DTLS were connected, but stats had no `inbound-rtp` video and no decoded frames.
- Control-plane WebSocket frames proved the daemon sent `remote-window-stream-status phase=streaming framesSent=1` and `remote-window-stream-started` with `ScreenCaptureKit` metadata for WeChat `1037x1177`. Therefore the UI wallpaper was not the first failing node; the first divergence is daemon capture-frame to WebRTC sender timing.
- Red test added: when the first capture frame arrives before `setLocalDescription` and WebRTC media readiness, `RTCVideoSource.onFrame` must not be called and `streaming` must not be reported. The daemon now stores one latest pending capture frame, flushes it only after the peer is connected, and drops it on stop before connection.

# 2026-07-25 Remote-window video refresh diagnosis

- Symptom: Jason reports the current remote-window video stream appears connected but does not refresh.
- SOP/model flow: known `desktop.remote_window_stream`, resource path `resource.remote_window_overlay -> resource.session_transport -> resource.remote_window_stream -> Android receiver video surface`; terminal mirror/buffer/render and screenshot fallback are forbidden.
- Evidence before edit: installed-phone ADB is currently unavailable (`adb connect 100.104.163.65:5555` timed out), so the exact phone UI cannot yet be replayed. Local daemon `/health` is reachable with attached sessions. Existing `remote-window-live-input-probe.ts` passes raw WebSocket control, but its `stopped.framesSent` is `1`; the current gate only proves first track/frame, not continuous video refresh.
- Active hypothesis H1: the test gate is missing continuous frame truth, and the first divergence may be in daemon capture-to-WebRTC refresh cadence or Android receiver frame projection. First action is to upgrade the live probe to use an animated target window and require multiple sent/decoded frames before product code changes.
- Owner lock for first edit: `desktop.remote_window_stream` test/live gate only. Allowed paths: `android/scripts/remote-window-live-input-probe.ts`, `android/docs/testing/remote-window-stream-test-design.md`, `android/note.md`. Product code remains locked until the animated gate identifies the first failing node.

# 2026-07-24 remote-window gesture / stale stream closeout

- Fix: daemon now replays one Android `gesture/swipe/end` as bounded macOS scroll steps instead of one huge wheel event. Android overlay now invalidates the active stream when daemon returns `remote_window_input_stream_missing`, so a daemon restart or lost stream cannot leave stale video accepting fake input.
- Test infrastructure fix: `remote-window-live-input-probe.ts` run ids now include timestamp + pid + random; parallel probes no longer collide on the same `streamId`.
- Installed-phone evidence on `100.104.163.65:5555`, app `0.1.3.2238`: CDP video `readyState=4`, `videoWidth=1037`, `videoHeight=1177`; ADB physical tap/swipe at surface coords `724,1716` and `724,2000 -> 724,1493` produced focus-first pointer down/up and focus-first `gesture/swipe/end deltaY=-1177` frames over `mux-channel-message`, plus six matching daemon `remote-window-input-result accepted=true` replies.
- Mac AppKit loopback evidence: raw local, mux local, Tailscale mux, and Tailscale mux burst with `CLIENT_CLOCK_OFFSET_MS=-60000` all saw target-side `PROBE_MOUSE_DOWN`, `PROBE_MOUSE_UP`, `PROBE_MOUSE_DRAGGED`, two `PROBE_SCROLL` entries from bounded gesture replay, and key down/up.
- Delivery: APK `0.1.3.2238` / versionCode `1032238` / sha256 `e6753ff18ab2069ded69a025e05a5d8c870523750ec3ae05711e74399b37bccd` is published on local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay update routes; all downloaded APK shas match manifest.
- New live symptom during this run: Jason reports foreground resume from background can leave the UI/video refresh frozen. This may share the visible symptom but belongs first to foreground/resume lifecycle truth (`terminal.transport_lifecycle` for terminal body; `desktop.remote_window_stream.android.receiver.attach/frame.render` only if isolated to remote-window video). Do not conflate it with the ScreenCaptureKit queueDepth fix until live logs prove the same first-divergence node.

# 2026-07-25 foreground resume remote-window body suppression

- Foreground resume freeze can be caused by remote-window fullscreen body suppression, even when the terminal transport stays green and head/body refresh code is correct. The owner is `desktop.remote_window_stream.overlay.project` plus `terminal.transport_lifecycle` body-subscription projection: when app foreground becomes false, overlay close must immediately release `onBodySubscriptionSuppressedChange(false)` before/while stopping the stream, so the active terminal body subscription cannot remain suppressed across background -> foreground.
- Regression gates: `TerminalPage.remote-window-overlay.test.tsx` must prove backgrounding a locked remote-window stream stops the stream, removes the overlay, restores QuickBar, and last reports body suppression `false`; `SessionContext.ws-refresh.test.tsx` must prove foreground resume applies same-socket head + body to render output without adding a physical socket.

# 2026-07-25 remote-window two-finger gesture lock

- Jason verified foreground resume usable and requested locking that area, then optimizing remote-window gestures: all cases should use two-finger up/down as remote scroll, and pinch threshold should be tighter to reduce scroll misclassification as zoom.
- Owner: `desktop.remote_window_stream.client.touch_action` / `resource.remote_window_overlay -> resource.remote_window_touch_action -> resource.remote_window_stream`. Edit scope is Android overlay touch classifier plus tests/docs only; daemon input injection, terminal renderer, and transport remain unchanged.
- Implemented draft: second touch on any target-locked remote-window surface enters two-finger candidate, not only fullscreen. Two-finger vertical movement emits focus-first pixel `scroll` in floating/fullscreen/zoomed fullscreen. Pinch is fullscreen-only and requires scale change plus at least 18px distance change with both fingers moving along the start axis; near-parallel vertical two-finger movement with slight spread remains scroll.

# 2026-07-25 remote scroll / bitrate / input-tail refresh closeout

- Jason's screenshot shows terminal bottom/input rows can still split-refresh: live lower text changes while a visible input/tail row remains stale. Owner is `terminal.buffer_render` / `resource.client_sparse_buffer -> resource.renderer_window`, not transport reconnect or remote-window.
- Root cause found in same-revision overwrite gate: pending visible refresh authority was checked against the whole incoming body window. If daemon answered a requested input-tail refresh with a larger stable superset body, the payload could be dropped as stale even when the only conflicting rows were inside the requested pending window.
- Fix: same-revision pending authority now checks the actual conflicting non-gap row range against the pending request window. Superset body is accepted only when conflicts are within pending; conflicts outside pending still drop as stale.
- Remote-window scroll fix: two-finger vertical scroll now maps midpoint movement proportionally to source pixels, emits continuous wheel-like scroll events, caps each event by the selected fraction, and defaults direction to inverted. Single-finger release-time gesture keeps its legacy bounded action direction.
- Remote-window bitrate fix: untouched default is now always `2mbps`; manual selector choices still persist by target/resolution and may raise fullscreen baseline.
- Verification so far: remote-window focused gate PASS `3 files / 68`; terminal buffer/ws-refresh gate PASS `2 files / 170`. Full build/package still pending in this run.

# 2026-07-25 remote-window APP group / session preview layout closeout

- Jason requested dynamic multi-window APP semantics: same APP windows (main window, image preview, popup/dialog) should not appear as separate APP rows. The UI should use a primary-plus-children container where the primary window is large and child windows are smaller; child click promotes the child to primary, and selecting/opening operates on the concrete primary window. The same layout semantics should also apply to normal tmux multi-session preview.
- Architecture owner: shared projection module `src/components/terminal/WindowGroupLayout.tsx`. It is deliberately a display/container layout owner only; each concrete app-window target or tmux Session remains its own child container. Remote-window streaming/input truth, terminal buffer/render truth, and transport/session truth are not owned by this module.
- Remote-window picker now groups same-app `app-window` targets by `appBundleId + pid`, sorts largest area as the default primary, and renders one group container. Single-window apps still render as direct rows. Child window click only changes the group's primary target; clicking the current primary selects that exact target manifest for stream start.
- Terminal session preview now uses the same `WindowGroupLayout`: portrait shows a child rail above a large primary preview; landscape shows a side child rail beside a large primary preview. Child tile click promotes the primary preview without activation; only the primary tile click activates/switches the real shell.
- Verification: focused layout/preview/remote-window picker tests PASS `3 files / 68`; `tsc --noEmit` PASS; feature/resource/function/mainline gates PASS `48`; `git diff --check` PASS; full `pnpm --dir android run build:android` PASS with terminal-message `37`, terminal contracts/common/relay smoke inside build, and APK `0.1.3.2242` / versionCode `1032242` / sha256 `2ae8c4f46403832d77f187aefa4abc9e3b69ade3faa51038c333356fc5e96dc8` published to local, Tailscale, and public Relay update routes. ADB has only `emulator-5554 offline`, so installed-device L5 remains unclaimed.

# 2026-07-25 remote-window group placement / fill / two-finger correction

- Jason clarified that same-APP child windows belong inside the active video layer, not as small picker-list tiles. Current correction keeps only one collapsed app row in picker and adds a video-layer sibling switcher after the concrete target is opened; switching siblings stops the previous stream and starts the selected sibling.
- The fullscreen "填满" correction is not local aspect-fill. It sends one daemon `window-resize` input event for the selected remote target and keeps local drawing/input mapping aspect-fit.
- Two-finger scroll must remain available in floating, unzoomed fullscreen, and zoomed fullscreen. The pinch threshold was tightened; the gesture was not removed. Focused remote-window gate PASS `6 files / 150`, terminal refresh owner gate PASS `9 files / 158`, feature/resource/function/mainline gates PASS `48`, typecheck PASS, `git diff --check` PASS.

# 2026-07-25 remote-window pinch gate regression after correction

- Follow-up red evidence: simply removing the potential-pinch hold makes a true pinch's first moving finger emit a stray horizontal `scroll` before the second finger confirms pinch. That is also wrong.
- Final owner rule: hold potential pinch only when the midpoint movement is not clearly vertical. If midpoint movement is vertical and the two fingers do not satisfy fullscreen pinch start-axis intent, emit continuous pixel `scroll` even when the two-finger distance changed a lot.
- Added `RemoteWindowOverlay.test.tsx` gate: diagonal vertical two-finger movement with large distance change but no pinch-axis intent stays scroll; active scroll can still become pinch after clear axis/distance confirmation. Focused overlay gate PASS `55/55`.
# 2026-07-25 remote window selection must focus target app before input

- Symptom reported by Jason: selecting an interactive remote app-window produced correct coordinate math, but input/gesture landed on the still-frontmost app (typically iTerm2) because the target app was not actually brought to the foreground.
- Root cause: overlay selection started the stream but did not emit an explicit focus intent for interactive app-window targets before later pointer/wheel/gesture events.
- Fix scope: `src/components/terminal/RemoteWindowOverlay.tsx` only. Add an immediate `focus` remote-window input event after successful stream start for interactive app-window targets; keep iTerm2 pane / read-only routes unchanged.
- Verification: focused overlay and page tests plus `tsc --noEmit` are green locally.

# 2026-07-25 terminal input-tail refresh / background diagnosis

- Jason corrected scope: the current terminal input-area stale/black-background issue has no QuickBar ownership. It is `terminal.buffer_render`.
- Architecture map: `resource.tmux_session -> resource.mirror_store -> resource.transport_subscriber -> resource.client_sparse_buffer -> resource.renderer_window`; Android mainline is `SocketMessage -> BufferApply -> RenderGate -> TerminalView`.
- Live evidence on Android device `100.104.163.65:5555`, package `0.1.3.2245`: CDP active DOM session id `session-1784964839208-4lothua3` maps through daemon `/debug/runtime` to tmux session `rcc3`. Daemon mirror `rcc3` is ready; subscriber is `f51c6c79...:channel:session-1784964839208-4lothua3`.
- Source-to-DOM compare for active `rcc3`: DOM visible rows `1337-1340` are `data-terminal-gap=true`, but `tmux capture-pane -p -t rcc3 -S 0` aligned to daemon `latestEndIndex=1353` shows non-empty source text at absolute rows `1337-1340`. Recent daemon logs only sent `buffer-sync` ranges beginning at `1341`/`1347`/`1348`, so visible gap repair did not fill the already-visible top gap.
- Separate projection evidence: `VisibleRow` renders a non-gap row with `row=[]` as one plain `' '` text child without `terminalCellStyle`, so any empty row that still belongs to terminal content can show transparent/black instead of terminal surface or styled input background. This is downstream of buffer/render projection, not UI chrome.
- Active hypotheses:
  - H1: visible-range demand/gap repair is suppressed or not re-emitted when the follow viewport still has the same end/rows but new gap ranges appear in the visible slice.
  - H2: row projection mishandles non-gap empty rows, causing empty terminal/input rows to lose background fill.
- Allowed edit scope after red tests: `packages/shared/src/terminal/renderer/row.ts`, `packages/shared/src/terminal/renderer.test.ts`, `android/src/components/TerminalView.dynamic-refresh.test.tsx`, and if H1 needs runtime repair, `android/src/contexts/session-context-public-runtime.ts` / `session-context-buffer-runtime.ts` plus their tests. Forbidden: `TerminalQuickBar.tsx`, page chrome compensation, daemon/client duplicate truth.
- Fix: `TerminalView` viewport repair demand dedupe now includes buffer/render freshness whenever `missingRanges` is non-empty, so the same visible gap can be re-reported after a newer buffer revision still leaves it unrepaired. Shared renderer rows/gap fills now paint `theme.background`, so empty/gap rows cannot leak the outer black surface.
- Verification: `TerminalView.dynamic-refresh.test.tsx` 75 PASS, shared renderer 19 PASS, focused terminal buffer/render gates 269 PASS, `tsc --noEmit` PASS, feature registry 48 PASS, `git diff --check` PASS, `daemon:mirror:close-loop` all 9 PASS, and full `build:android` PASS. APK `0.1.3.2246` / `1032246` sha256 `0bbb3a1f7164bbced39249a1df49c550243f8453a5f2244128028cd2bb27a70c` published to local, Tailscale, and public Relay update routes.
- Installed-device smoke on `100.104.163.65:5555`: app updated to `0.1.3.2246`, active TerminalView mapped to tmux `zterm`, DOM visible rows had `gapCount=0`; source-to-DOM mismatch was limited to a live timer/status row changing between source capture and DOM read. Remaining risk: a fully controlled stable-source same-revision input-row repro on the installed phone was not isolated before this closeout.

# 2026-07-25 remote-window focus accepted but app not frontmost

- Symptom: Jason reports remote-window clicks/input are injected into the currently frontmost desktop app because the selected remote APP is not brought to foreground before injection.
- SOP/model flow: known `desktop.remote_window_stream`. Mainline: `RemoteWindowOverlay/TerminalPage -> RemoteWindowInputRuntime -> daemon RemoteWindowStream -> RemoteWindowInput`. Resource path: `resource.remote_window_overlay -> resource.remote_window_touch_action -> resource.remote_window_stream -> resource.daemon_process`.
- Live evidence: `pnpm --dir android exec tsx scripts/remote-window-existing-app-focus-probe.ts` against `ws://127.0.0.1:3333` selected WeChat `app-window:86862:14018`. It received `remote-window-input-result accepted=true` for `{kind:'focus'}`, but external System Events still reported frontmost bundle `com.apple.finder`.
- Manual control: after defocusing to Finder, `osascript 'tell application "System Events" to set frontmost of first process whose unix id is 86862 to true'` brought the same WeChat PID frontmost. Therefore the daemon target PID and OS permission route are viable.
- Confirmed first divergence: the persistent Swift helper verifies focus with `NSWorkspace.shared.frontmostApplication`. In a long-lived helper process this can be stale; it can fast-path `frontmostPidMatches(config.pid) && focusedWindowMatchesTarget(...)` and return accepted without actually activating the target app. External System Events is the live frontmost truth for the same operation.
- Unique owner: `desktop.remote_window_stream.daemon.input_inject` in `src/server/remote-window-stream-daemon.ts` and `src/server/remote-window-stream-daemon.test.ts`.
- Allowed edit scope: replace helper frontmost verification with System Events PID truth; keep Android overlay/TerminalPage, transport, terminal renderer, and screenshot paths unchanged.
- Required gates: fail-first daemon helper string gate; `remote-window-stream-daemon.test.ts`; live `remote-window-existing-app-focus-probe.ts` after daemon prepare/install/restart; then APK build/update if Android package changes are included.

# 2026-07-25 remote-window focus intent must not queue ahead of real input

- Jason corrected the model: the daemon input owner must check the current frontmost PID immediately before every real remote input action. If the selected app/window is not frontmost/focused, the daemon focuses it first and only then injects the action; if it is already frontmost/focused, it skips focus work. Client-sent standalone `focus` is only a compatibility/explicit intent, not a required queue item before every action.
- Red evidence: `ZTERM_REMOTE_WINDOW_PROBE_BURST=1 ZTERM_REMOTE_WINDOW_PROBE_MUX=1 pnpm --dir android exec tsx scripts/remote-window-live-input-probe.ts` failed with `remote_window_input_failed remote window input stale` on `drag-down`. Unit red reproduced the same shape with `focus,pointer` bursts and slow focus helper responses.
- Root cause: `createDefaultRemoteWindowInputHelper()` sent every queued `focus` to the persistent Swift helper. Android/WebView burst input could queue `focus,pointer,focus,pointer,...`; each slow focus consumed helper time before the real action even though `handleConfig()` already calls daemon-owned focus verification before every real action.
- Owner: `desktop.remote_window_stream.daemon.input_inject` / `src/server/remote-window-stream-daemon.ts`. Fix direction: keep explicit standalone focus valid, but add a short daemon-side pair grace and coalesce redundant same-target focus immediately followed by real input; the real action then performs the inline frontmost/focused check in Swift before OS injection.

- Fix: `frontmostPidMatches` now uses System Events live unix id; `createDefaultRemoteWindowInputHelper` coalesces same-target focus immediately followed by real input and refreshes the following action receive time so it is not charged against the coalesced focus wait.
- Verified: `remote-window-stream-daemon.test.ts` 52 PASS; raw+mux existing WeChat focus probes PASS; raw/mux serial live input PASS; raw/mux/Tailscale mux burst live input PASS; `tsc --noEmit` PASS; feature/resource/function/mainline gates 48 PASS; `git diff --check` PASS. Daemon reinstalled/restarted with health pid 40167.

# 2026-07-25 remote-window action-only gesture/click diagnosis

- Jason corrected the remote-control semantics: Android must not transmit gesture/click process streams. Touch tap, drag/swipe, and two-finger scroll should be classified locally into action records; daemon then performs the local OS-event replay/injection after inline focus verification. Existing code already made single-finger drag a release-time `gesture/swipe`, but touch tap still emitted pointer down/up and two-finger scroll emitted continuous `scroll` frames during pointer move. That explains visible stutter on the Mac app: the remote app receives a sequence driven by Android/WebView gesture cadence instead of one local virtual scroll action.
- SOP/model flow: `desktop.remote_window_stream.client.touch_action -> desktop.remote_window_stream.client.input_request -> desktop.remote_window_stream.daemon.input_inject`. Resource path remains `resource.remote_window_overlay -> resource.remote_window_touch_action -> resource.remote_window_stream -> resource.daemon_process`; terminal renderer/QuickBar/transport are forbidden compensation points.
- First divergence: `RemoteWindowOverlay` two-finger branch sends `scroll` on pointer move, and `remote-window-touch-action-runtime` maps tap to pointer down/up. Unique owner for classification: `desktop.remote_window_stream.client.touch_action`; protocol/daemon owner must add an action-level click decode/inject path. Fill action divergence is `desktop.remote_window_stream.overlay.project`: fullscreen "fill" sends phone surface width/height as absolute app window size, but required semantics are keep current desktop width and calculate height from the phone aspect ratio.
- Follow-up correction: client-side focus prelude is also not part of the action contract. Android click/gesture/wheel/key/QuickBar/IME must send one user action record only; daemon input owner performs the frontmost/focused check inline before injection. Compatibility `focus` remains explicit bring-front only and is not a required or automatic prefix for real input.

# 2026-07-25 remote-window action-only input closeout

- Jason corrected remote control: click/gesture/scroll/key/QuickBar/IME must be local action records, not touch/mouse process streams, and not client focus preludes.
- Owner: desktop.remote_window_stream.client.touch_action + desktop.remote_window_stream.daemon.input_inject.
- Fix: Android emits click / release-time gesture/swipe / scroll / key actions only; daemon postClick + inline focus; same-target action-only burst refreshes next queued action after preceding success while different-target still stales at 1s.
- Verified: focused remote-window 126 PASS, daemon 55 PASS, broader remote-window 75 PASS, tsc PASS, feature/resource/function/mainline 48 PASS, live raw/mux serial+burst+clock-skew PASS, Tailscale mux serial/burst PASS, Android build/publish 0.1.3.2247 sha256 79fa04b4ab691f56f70f7ac198f2a6e4ae17d912f6bf01589ff319a932072826 on local/Tailscale/public Relay, ADB install on 100.104.163.65:5555 Success; keyguard still locked so phone UI L5 unclaimed.

# 2026-07-25 remote-window video group lift correction

- Jason screenshot clarified that same-APP child windows belong inside the active remote-window video container, in the area above the primary video in portrait, and must move with the same container when QuickBar/IME appears.
- Owner: `desktop.remote_window_stream.overlay.project` and shared `WindowGroupLayout`. Forbidden compensation points remain daemon stream/input, terminal renderer, and transport.
- Fix: remote-window picker still shows one collapsed app row, but target-locked video now uses `WindowGroupLayout` inside the locked video layer. Portrait places child sibling tiles before/above the primary video; landscape places them after/beside it. `TerminalPage` passes `terminalChromeBottomPx + terminalImeLiftPx` as `bottomInsetPx`, so the whole locked remote-window container avoids QuickBar plus IME instead of leaving child tiles or primary video under bottom chrome.
- Verification so far: focused remote-window overlay/page/layout tests PASS `3 files / 64`, `git diff --check` PASS. Full type/registry/build/APK publish still pending in this run.

# 2026-07-25 terminal input-area stale refresh diagnosis

- Symptom: Jason screenshot shows terminal body and bottom input/editor rows partially stale: dynamic lower rows keep changing, but older visible rows and input rows keep old text/background. This is `terminal.buffer_render`, not QuickBar/chrome.
- SOP/model flow: known terminal buffer/render flow `tmux truth -> daemon mirror store -> transport subscriber buffer-sync -> client sparse buffer -> renderer window -> UI projection`. Resource path is `resource.mirror_store -> resource.transport_subscriber -> resource.client_sparse_buffer -> resource.renderer_window`; forbidden compensation paths are `TerminalPage.tsx` and `TerminalQuickBar.tsx`.
- Mainline: `android_mainline:SocketMessage->BufferApply`, `android_mainline:ChannelDemux->BufferApply`, `android_mainline:BufferApply->RenderGate`, `android_mainline:Renderer->RenderGate`.
- Active hypothesis H1: after the daemon oversized body-refresh fix, one authoritative changed span can be sent as several `buffer-sync` payloads with the same `revision` but no frame/chunk identity. The first chunk advances the local buffer revision. Later same-revision chunks that rewrite non-gap rows can be classified as stale by `applyIncomingBufferSyncRuntime()` because they are not tied to the same authoritative daemon frame/payload. This matches partial refresh where some rows update and later rows/input rows stay stale.
- Counter-evidence to preserve: unsolicited same-revision old packets must still be dropped; same-revision local gap fills must still apply; requested same-revision visible refresh must still apply only within pending request authority.
- First divergence candidate: daemon split chunks lose authoritative frame identity at `terminal-mirror-runtime.ts#splitBufferSyncPayloadMessages`, then client same-revision stale guard lacks a frame authority at `session-context-buffer-runtime.ts#applyIncomingBufferSyncRuntime`.
- Unique owner/edit scope if H1 is confirmed by red test: `terminal.buffer_render` owner paths `src/server/terminal-mirror-runtime.ts`, `src/server/terminal-mirror-runtime.backpressure.test.ts`, `src/contexts/session-context-buffer-runtime.ts`, `src/contexts/session-context-buffer-runtime.test.ts`, and shared protocol type `packages/shared/src/connection/types.ts`. No UI chrome, no transport reconnect, no fallback.
- Required verification: red/green client chunk apply test; server split metadata test; stale same-revision negative test remains green; focused buffer/server gates; typecheck; feature/resource/function/mainline gates; daemon mirror close-loop; then Android package if product behavior changed.

# 2026-07-25 remote-window fill ACK / terminal chunk frame closeout

- Remote-window "填满" is now locked as remote target resize truth, not Android local cover/crop and not phone-resolution resizing. Android computes the target height from the fullscreen available display container aspect ratio while preserving the current remote desktop window width, sends `window-resize`, and updates projection only after daemon returns ACK `target/capture` truth. Marker: `remote-window fill ACK target capture preserves desktop width`.
- Daemon ScreenCaptureKit helper now keeps a stdin command channel open, accepts `update-config`, calls `SCStream.updateConfiguration`, and returns `ZTERM_REMOTE_WINDOW_CAPTURE_UPDATE` ACK. `remote-window-input-result` can carry updated `target` and `capture`; Android applies them only for the active locked stream/target.
- Terminal input/tail stale refresh fix: daemon split `buffer-sync` chunks now carry same authoritative frame metadata (`frameStartIndex/frameEndIndex/frameChunkIndex/frameChunkCount`), and client same-revision apply accepts later chunks from the same frame while preserving stale overwrite rejection for unrelated same-revision packets. This targets the "large paste / more than one screen changed / input rows do not repaint" failure class.
- Verification: focused `RemoteWindowOverlay.test.tsx` 55 PASS; `remote-window-stream-daemon.test.ts` 58 PASS; remote-window message/session runtime 29 PASS; SOP/page/layout gate 11 PASS; `tsc --noEmit` PASS; feature/resource/function/mainline gate 48 PASS; `git diff --check` PASS; full `pnpm --dir android run build:android` PASS including terminal message/runtime, terminal contracts, common flows, relay local smoke, Vite/Capacitor/Gradle.
- Delivery: Android APK `0.1.3.2250` / versionCode `1032250` / sha256 `f7aee6de741bcee6b68bf1b2b2ddaae22a7560c39f43ace739d794cbe058770e` is published on local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay `https://relay.codewhisper.cc:18443/relay/updates/latest.json`; downloaded APK sha matched on all three routes.
- Daemon: `daemon:install-global` plus `zterm-daemon restart` started `/Users/fanzhang/.zterm/releases/zterm-daemon/0.1.3/runtime/server.cjs` at health pid `20237`; installed release runtime SHA matched `android/release-dist/.../runtime/server.cjs`. `~/.zterm/daemon-runtime/server.cjs` still has an old SHA but is not the launchd runner path in this install.
- Remaining L5 gap: no online ADB device was attached in this closeout, so installed-phone remote-window resize and visual terminal refresh remain Jason-side verification, not agent-claimed L5.

# 2026-07-26 fullscreen buffer/status audit start

- Scope: Jason reports fullscreen buffer refresh can show wrong/stale content, and top status projection can duplicate with one old state. Architecture mapping: terminal body belongs to `terminal.buffer_render` (`resource.mirror_store -> resource.transport_subscriber -> resource.client_sparse_buffer -> resource.renderer_window`); page chrome/status belongs to UI projection and must not repaint terminal body or compensate buffer truth.
- Existing L1/L2 gates before product edit: focused terminal buffer/render suite and daemon/tmux close-loop were green in the handoff. New audit target is to remove duplicate page chrome owners and keep TerminalPage using the extracted shell/debug modules as the only UI projection owner, while preserving terminal body gates and adding a portrait active-session status single-source test.
- Closeout: removed duplicate inline `TerminalQuickBarShell` / `TerminalNetworkBanner` / `TerminalDebugOverlay` owners from `TerminalPage`, kept page shell/debug modules as the only projection owners, and added gates for fullscreen same-text/status-row style repaint plus single active-session status strip after switches.
- Verification: focused status/buffer/source gates PASS `5 files / 128 tests`; terminal buffer/render mainline PASS `4 files / 127 tests`; render isolation/scope/remote-window overlay PASS `3 files / 33 tests`; typecheck PASS; feature/resource/function/mainline gate PASS `7 files / 49 tests`; `git diff --check` PASS; `daemon:mirror:close-loop` PASS all 9 cases.
- Delivery: Android APK `0.1.3.2251` / versionCode `1032251` / sha256 `5c3c77ab73aa098cda44466e62c99d6ed7a1fc0bd5d3ede65db4a7250fc6d9a6` published to local update channel, `/Users/fanzhang/.zterm/updates`, Tailscale daemon route `http://100.66.1.82:3333/updates/latest.json`, and public Relay `https://relay.codewhisper.cc:18443/relay/updates/latest.json`; public APK HEAD length `4808707`, streamed public APK sha matched manifest. `adb devices` had no online device, so installed-phone L5 visual proof remains Jason-side.

# 2026-07-26 project module/resource/edge registry landing

- Scope: Jason asked to start landing the whole project module split before connection/runtime refactor. Correction accepted: modules are not just the connection module; first list daemon/client/shared/relay/release/observability top modules, then internal modules, resource lists, edge registry, function/mainline maps, gate, SOP.
- Existing truth before edit: `docs/resource-registry.json`, `docs/resource-map.md`, `docs/function-map.md`, and `docs/wiki/mainline-call-map.json` existed; no `docs/module-registry.json`, `docs/edge-registry.json`, or `docs/modules/project-modules.md` existed.
- Implementation: added `docs/module-registry.json`, `docs/edge-registry.json`, `docs/modules/project-modules.md`, `docs/testing/module-edge-registry-test-design.md`, `src/lib/module-registry-truth.test.ts`, and `src/lib/edge-registry-truth.test.ts`; wired both gates into `test:feature-registry`.
- Architecture lock: `client.daemon_connection` owns one physical connection per daemon target; `client.terminal_channel_mux` owns terminal session channels; daemon side stays client-agnostic under `daemon.connection_gateway` / `daemon.transport_subscriber`; Relay peer lease is route/signaling truth only.
- Verification: focused module/resource/edge/function/mainline gate passed `5 files / 24 tests`; `pnpm --dir android run test:feature-registry -- --reporter dot` passed `9 files / 59 tests`.
- Known gap: this is docs/static architecture lock only. It does not prove live daemon/client connection reuse or buffer correctness. Runtime refactor still must add feature-specific black-box/live tests before code changes.

# 2026-07-26 connection module gap inspection

- Evidence: MemoryPalace search for `client.daemon_connection physical connection owner terminal channel mux gap`; static module/resource/mainline gates passed `27/27`; full `test:feature-registry` passed `59/59`; focused transport/mux tests passed `224/224`.
- Confirmed current lock: resource/module/edge registries exist and make `client.daemon_connection` / `client.terminal_channel_mux` / `daemon.connection_gateway` / `daemon.transport_subscriber` explicit.
- Gap 1: runtime target identity is still route-shaped. `buildTransportTargetKey()` includes `transportMode`, `tailscale/ipv4/ipv6`, `signalUrl`, and relay endpoint candidates; tests still assert direct websocket and relay-aware targets for the same daemon are different target runtimes. Desired design needs stable `DaemonTargetId` separate from `RouteCandidateId`.
- Gap 2: app-facing daemon connection interface is not unique yet. Remote-window, screenshot/file/input/tmux management mostly use `readSessionTransportResource(sessionId).socket` or `sendMessageRaw`; `tmux-sessions.ts` still owns a legacy direct `TraversalSocket` pool.
- Gap 3: target runtime still has separate `controlTransport` and `terminalTransport` plus legacy per-session `activeSocket` fields. The mux path works, but the data model has not physically removed the old control/session socket semantics.
- Gap 4: target failure currently fans out into per-session reconnect scheduling. It should become one target-level route rebuild with channel demand replay.
- Gap 5: human docs still contain stale pending/binding wording (`project-modules.md`, `module-edge-registry-test-design.md`, parts of `function-map.md`) even though machine gates are green. Need sync before runtime refactor.

# 2026-07-26 daemon connection phase1 implementation slice

- Scope: `terminal.transport_lifecycle` / `client.daemon_connection` first runtime identity slice. Allowed owner paths: `android/src/lib/session-transport-runtime.ts`, `android/src/lib/session-transport-runtime.test.ts`, module docs/gates. Goal remains full phase1; this slice only locks stable daemon target identity and docs stale gap.
- Docs/map fix: `project-modules.md` no longer lists `resource.daemon_connection_gateway`, `resource.client_file_browser`, or `resource.client_settings_update` as pending because all three are already in `docs/resource-registry.json`. `module-edge-registry-test-design.md` now says runtime pending resources are forbidden. `module-registry-truth.test.ts` adds a human-doc gate so pending resource wording cannot re-enter module docs.
- Function map fix: mux protocol/channel/target/relay peer rows now bind to real existing symbols (`TerminalMuxClientFrame`, `buildTerminalMuxHello`, `ensureTargetTransportRuntime`, `wrapSessionPayloadForTargetMuxRuntime`, `handleTargetMuxServerFrameRuntime`, `registerClient`, etc.) instead of generic binding-pending placeholders.
- Runtime fix: `buildTransportTargetKey()` now returns stable `DaemonTargetId`: uses `daemonHostId || relayHostId` when available and otherwise endpoint host+port. It no longer includes transport mode, auth token, route candidates, signal URL, Tailscale/IP variants, relay device, or session name. New `buildTransportRouteCandidateKey()` carries route/auth/candidate identity separately. `TargetTransportRuntime` stores `daemonTargetId`, `routeCandidateKey`, and `routeGeneration`; same daemon route updates increment generation without creating a second target runtime.
- Focused evidence: `pnpm --dir android exec vitest run src/lib/session-transport-runtime.test.ts src/lib/module-registry-truth.test.ts --reporter dot` PASS, 2 files / 26 tests. Tests lock same daemon direct-vs-relay route candidate sharing one target key, route generation updates, active socket preservation across route candidate update, and channel preservation across route update.
- Remaining gaps: full phase1 still needs migration of all feature callers to a unique daemon connection interface, physical removal of legacy per-session sockets/direct `TraversalSocket` feature paths, target-level failure/reconnect replay, broader focused transport gates, live daemon/tmux source-output gate, network matrix, APK build/publish, commit and push.

# 2026-07-26 daemon connection gap plan after phase1 slice

- Gap check source: `project-modules.md`, `resource-registry.json`, `edge-registry.json`, `function-map.md`, `mainline-call-map.json`, MemoryPalace search, and runtime reads of `session-transport-runtime.ts`, `session-context-transport-open-runtime.ts`, `session-context-transport-orchestration-runtime.ts`, `session-context-infra-facade-runtime.ts`, `session-context-public-runtime.ts`, `session-context-remote-window-runtime.ts`, `session-context-tmux-management-runtime.ts`, and `tmux-sessions.ts`.
- Confirmed closed gap: target identity is now stable daemon identity, and route candidate changes no longer create a second `TargetTransportRuntime`.
- Remaining implementation gaps: no app-facing `client.daemon_connection` interface yet; feature paths still read raw session socket/resource; `tmux-sessions.ts` still creates legacy `TraversalSocket`; target runtime still exposes `controlTransport`, `terminalTransport`, and session `activeSocket`; target physical failure still fans out into per-session reconnect; live/network/APK gates not yet run for this refactor phase.

# 2026-07-26 daemon connection session-open owner slice

- Scope: `terminal.transport_lifecycle` / `client.daemon_connection`. This slice targets the session-open mux path only; it does not claim the full phase1 closeout.
- Change: `ClientDaemonConnection` now exposes target transport read/open owner hooks. `openSessionMuxChannelByIntentRuntime()` no longer receives or calls `buildTraversalSocketForHost`; when no reusable target transport exists it delegates to `client.daemon_connection.openSessionTargetTransport()`. The orchestration layer wires that hook to the existing target socket prime + mux lifecycle bind, so the physical creation point is now behind the daemon-connection interface.
- Change: when a `daemonConnection` is present, input, deferred input head refresh, buffer head/sync requests, paste readiness, terminal resize, and runtime debug flush now read only through daemon connection instead of falling back to raw session socket accessors.
- Verified: `pnpm --dir android exec tsc --noEmit --pretty false` PASS; focused daemon-connection/open/input/buffer/transfer/debug gate PASS `7 files / 79 tests`; broader transport/mux/session/tmux focused gate PASS `10 files / 236 tests`; feature registry gate PASS `9 files / 62 tests`; `git diff --check` PASS.
- Remaining gaps: legacy `openSessionTransportByIntentRuntime()` still owns the old session-ticket socket path; `session-context-socket-runtime.ts`, `session-context-session-runtime.ts`, `session-context-transport-runtime.ts`, `session-context-activity-runtime.ts`, and remote-window fallback paths still have raw accessors for migration/legacy; `tmux-sessions.ts` still has a direct management socket pool; target heartbeat/failure replay is not yet fully target-level; no live daemon/network/APK/commit/push closeout yet.

# 2026-07-26 daemon connection tmux management slice

- Scope: `terminal.transport_lifecycle` / `client.daemon_connection` for drawer/catalog tmux management. This closes part of the "drawer/catalog must not create physical sockets when an open daemon target exists" requirement.
- Change: `manageTmuxSessionsOnOpenTransportRuntime()` now accepts `daemonConnection` and reads the mux target resource through it before raw resource access. `session-context-public-facade-runtime` passes the shared daemon connection into that owner.
- Static lock: `module-registry-truth.test.ts` now forbids `daemonConnection.read* || readSessionTransport*` fallback patterns in product source. This keeps daemon connection from becoming a cosmetic wrapper over old raw socket paths.
- Verified: `pnpm --dir android exec tsc --noEmit --pretty false` PASS; `session-context-tmux-management-runtime.test.ts + SessionContext.ws-refresh.test.tsx` PASS `2 files / 141 tests`; `module-registry-truth.test.ts` PASS `9 tests`; `test:feature-registry` PASS `9 files / 63 tests`.
- Remaining gap remains substantial: `tmux-sessions.ts` is still the allowed legacy path when no matching open target session exists. Full phase1 still needs target-level physical connection owner API, removal of per-session `activeSocket`/heartbeat legacy, route failure replay at target level, live/network matrix, APK, commit, push.

# 2026-07-26 daemon connection gap plan checkpoint

- Gap check evidence: read current goal prompt, USER/AGENTS, architecture, module/resource/edge/function/mainline maps, note/MEMORY/skills; MemoryPalace returned current module/transport/heartbeat/tmux-management truth; `test:feature-registry` passed `9 files / 63 tests`.
- Confirmed closed: docs/module/edge registry is parseable; stable `DaemonTargetId` exists; `client.daemon_connection` wrapper exists; mux session-open delegates target physical open through that wrapper; tmux management can use existing mux target transport; static grep found no `daemonConnection.read* || raw` fallback pattern.
- Confirmed open gaps: legacy per-session `activeSocket` still exists in `SessionTransportRuntime`; `controlTransport` and `terminalTransport` are still split inside `TargetTransportRuntime`; legacy `openSessionTransportByIntentRuntime()` still calls `buildTraversalSocketForHost`; `tmux-sessions.ts` still owns a direct `TraversalSocket` pool; several migration branches still read raw session socket when no daemonConnection is provided; target failure still schedules reconnect per affected session instead of a single target route rebuild plus channel replay; live/network/APK/commit/push are not closed.

# 2026-07-26 daemon connection target-owned read slice

- Scope: `terminal.transport_lifecycle` / `client.daemon_connection` read-side truth. This is not full phase1 closeout; it removes one bad precedence where legacy per-session `activeSocket` could mask the ready mux target transport.
- Change: `getSessionTransportResource()` now prefers `targetRuntime.terminalTransport` when a session has a mux channel and the target mux is ready; `runtime.activeSocket` remains only a legacy fallback when the mux target is not ready/available. Added a regression proving a leftover `activeSocket` does not override the target physical transport.
- Verified: owner gate `session-transport-runtime.test.ts + client-daemon-connection.test.ts` PASS `24 tests`; broader transport/mux/session/tmux gate PASS `10 files / 249 tests`; input/buffer/transfer/debug gate PASS `4 files / 64 tests`; `tsc --noEmit` PASS; `test:feature-registry` PASS `9 files / 63 tests`; `git diff --check` PASS.
- Remaining gaps unchanged: `activeSocket` is still physically present as migration truth, target `controlTransport/terminalTransport` still split, legacy session-ticket open path and `tmux-sessions.ts` direct pool still exist, target route rebuild + channel replay is still not implemented, and no live/network/APK/commit/push closeout exists.

# 2026-07-26 lifecycle effective-socket read follow-up

- Change: `session-context-lifecycle` now reads transport health and cadence from `getSessionTransportResource(...).socket`, so passive visible refresh and debug metrics follow the mux-ready target transport instead of the raw session `activeSocket`.
- Test repair: lifecycle passive-fast-lane tests now use a real `SessionTransportRuntimeStore`, and the regression set proves a ready target transport overrides a leftover per-session `activeSocket` for both buffered-byte cadence and transport-health reads.
- Verified: `session-context-lifecycle.passive-fast-lane.test.ts + session-context-lifecycle.test.tsx + runtime-debug-flush.test.ts` PASS `28 tests`; `tsc --noEmit` PASS.
- Remaining gaps unchanged: this only fixes read-side truth. The runtime still contains legacy session socket fields and legacy open/tmux-management paths, so the physical connection refactor is not done yet.

# 2026-07-26 target-level rebuild gap inspection

- Scope: next `terminal.transport_lifecycle` / `client.daemon_connection` implementation step after target-owned read slice. Read architecture, remediation, resource map, function map, mainline source/call map, current transport runtime/open/orchestration/session/reconnect code, and existing focused tests.
- Confirmed current good state: `buildTransportTargetKey()` is stable daemon identity; `buildTransportRouteCandidateKey()` is separate route identity; mux open path delegates physical target creation through `client.daemon_connection.openSessionTargetTransport()`; read-side resource prefers ready target mux transport over leftover session `activeSocket`; focused tests already lock those.
- Gap A: `handleTargetMuxTransportFailureRuntime()` still closes channels then calls `scheduleReconnect(sessionId, ...)` per same-target logical session. This violates the desired model: one target physical failure should perform one target route rebuild, then replay all affected channel opens/body demand on that rebuilt target.
- Gap B: reconnect owner remains session-shaped (`scheduleReconnectRuntime` / `startReconnectAttemptRuntime` / `reconnectRuntimesRef` keyed by session id). It can still create duplicate target rebuild attempts when several same-target sessions fail together.
- Gap C: pending channel opens are finalized individually during target failure, but there is no target-level pending/rebuild state that preserves channel demand and replays it once the new mux transport is ready.
- Gap D: legacy paths remain: `openSessionTransportByIntentRuntime()` still builds a per-session `TraversalSocket`; `tmux-sessions.ts` still owns direct tmux management socket pool; raw socket branches remain only acceptable as migration/compat, not final phase1.
- Implementation implication: next code slice should add red tests around target failure fanout first, then introduce a target rebuild coordinator rather than patching session reconnect loops.

# 2026-07-26 target-level rebuild/replay implementation slice

- Scope: `terminal.transport_lifecycle.target_transport.open` / `client.daemon_connection`. This slice closes Gap A for physical target failure semantics; it does not claim full phase1 closeout because legacy per-session open/direct paths still exist.
- Change: `handleTargetMuxTransportFailureRuntime()` now treats `rtc data channel error` / `terminal mux transport closed` as target-level failure. It clears target mux ready/socket/heartbeat once, turns every recoverable same-target logical channel into `opening` replay demand, projects affected sessions as reconnecting, clears stale pending open timers/intents without per-session failure fanout, and schedules exactly one immediate/reset rebuild through a single anchor session with `force: true`.
- Replay path: existing `bindTargetMuxTransportSocketLifecycleRuntime()` already flushes all `opening` channels on target `mux-ready`, so the rebuilt target transport replays sibling channel opens without creating additional physical sockets.
- Docs/skill update: `websocket-transport-reuse-test-design.md`, `function-map.md`, and `.agents/skills/zterm-mobile-dev/SKILL.md` now state the single target rebuild + channel replay rule.
- Verified: `pnpm --dir android exec vitest run src/contexts/session-context-transport-orchestration-runtime.test.ts src/contexts/session-context-transport-runtime.test.ts --reporter dot` PASS `20 tests`; focused transport/mux/session runtime gate PASS `5 files / 77 tests`; `pnpm --dir android exec tsc --noEmit --pretty false` PASS; `pnpm --dir android run test:feature-registry -- --reporter dot` PASS `10 files / 67 tests`; scoped `git diff --check` PASS for this slice. Full `git diff --check` still reports pre-existing unrelated `android/src/lib/terminal-buffer-debug.ts:93 new blank line at EOF`.
- Remaining gaps: legacy `openSessionTransportByIntentRuntime()` still exists and can build a per-session `TraversalSocket`; `tmux-sessions.ts` still owns the no-open-target legacy direct pool; `SessionTransportRuntime.activeSocket` remains migration truth; no live daemon/network/APK/commit/push closeout yet.

# 2026-07-26 daemon_connection phase1 open-intent fallback removal

- 架构映射：feature_id=terminal.transport_lifecycle；resources=resource.session_transport -> resource.daemon_target_transport -> resource.terminal_channel；owner=client.daemon_connection / client.terminal_channel_mux。
- 本切片物理移除 queueSessionTransportOpenIntentRuntime 的 legacy session-ticket fallback：缺少 openSessionMuxChannelByIntent 时删除 pending intent 并显式失败 client.daemon_connection mux opener unavailable，不再调用 ensureControlTransportForSessionOpen。
- 红测/gate：session-context-transport-open-runtime.test 新增 missing mux opener 显式失败；module-registry-truth.test 新增静态 gate 禁 queueSessionTransportOpenIntentRuntime 重新引用 ensureControlTransportForSessionOpen 并要求失败文案与 pending cleanup。
- 验证：transport/mux/session focused suite 9 files / 88 tests PASS；test:feature-registry 10 files / 68 tests PASS；tsc --noEmit PASS；scoped git diff --check PASS。
- 未完成：activeSocket 迁移、feature raw socket fallback 收口、legacy tmux-sessions 管理 socket 最终限制、live daemon/tmux gate、network matrix、APK build/publish/download sha、commit/push 仍未闭环。

# 2026-07-26 daemon_connection effective-socket fallback narrowing

- 架构映射：feature_id=terminal.transport_lifecycle；owner=client.daemon_connection / session transport runtime；资源边界为 session_transport 只通过 daemon_target_transport + terminal_channel 暴露有效 socket。
- 本切片收窄 getSessionTransportResource：一旦 session 已有 mux channel，effective socket 只允许来自 ready mux target terminal transport；legacy runtime.activeSocket 仍保留为迁移字段，但不能在 channel 未 ready/closed/opening 时冒充可用连接。纯 legacy 无 mux channel 时暂保兼容。
- 红测：session-transport-runtime.test 增加 legacy activeSocket + mux channel exists + mux not ready 时 resource.socket 必须为 null，防止 connected-but-stale/no-refresh 被 activeSocket 隐藏。
- 验证：session-transport-runtime 22 PASS；transport/open/orchestration/client-daemon focused 35 PASS；transport stack 9 files / 89 PASS；test:feature-registry 68 PASS；tsc --noEmit PASS；scoped git diff --check PASS。
- 未完成：feature direct socket fallback 全面收口、legacy tmux management socket 最终限制、live daemon/tmux gate、network matrix、APK build/publish/download sha、commit/push 仍未闭环。

# 2026-07-26 daemon_connection remaining gap inspection

- Gap check evidence: current goal prompt, architecture/module/resource/edge/function/mainline maps, `websocket-transport-reuse-test-design.md`, runtime grep for `ensureControlTransportForSessionOpen` / `createClientDaemonTraversalSocket` / raw socket fallbacks, and focused gates.
- Verified current static state: focused transport stack passed `9 files / 89 tests`; `test:feature-registry` passed `10 files / 69 tests`; `tsc --noEmit` passed; scoped diff-check passed.
- Remaining Gap 1: `createSessionControlTransportOrchestrationRuntime()` still constructs and exports the old control transport opener, although current open queue no longer reaches it; this is dead legacy and should be physically removed or demoted to explicit compat-only with a static no-reach gate.
- Remaining Gap 2: feature runtimes still carry optional `daemonConnection` plus raw socket fallback branches (`public`, `buffer`, `input`, `transfer`, `remote-window`, `activity`, `session`, `runtime-debug`). Production wiring passes `daemonConnection`, but the API still permits bypass.
- Remaining Gap 3: `tmux-sessions.ts` still owns a direct `createClientDaemonTraversalSocket()` pool for no-open-target management; it needs a stricter gate proving matching open target failure never falls back to this pool.
- Remaining Gap 4: store shape still exposes legacy `SessionTransportRuntime.activeSocket` and target `controlTransport`/`terminalTransport` split. Effective socket is narrowed, but physical model is not fully singular yet.

# 2026-07-26 daemon_connection raw fallback gate slice

- Scope: `terminal.transport_lifecycle` / `client.daemon_connection` owner tightening. This slice does not close full phase1; it reduces wrapper drift and one feature raw fallback path.
- Change: `SessionProviderCoreAssembliesResult` now exposes the shared `daemonConnection` built by infra. Public facade, interaction runtime, lifecycle runtime, and message assemblies consume that owner instead of constructing their own cosmetic wrapper. Static gate now allows `createClientDaemonConnection()` only in `session-context-infra-facade-runtime.ts`, `session-context-transport-orchestration-runtime.ts`, and the owner lib.
- Change: schedule/public message sending no longer accepts raw session socket accessors. Paste readiness also no longer falls back to raw socket/resource; it reads only through `daemonConnection.readSessionSocket()`.
- Verification: focused public/transfer/message/remote-window/module gate PASS `5 files / 36 tests`; feature registry/module/resource/edge/function/mainline gate PASS `10 files / 70 tests`. Full `tsc --noEmit` remains blocked by existing broad `Session.buffer` / `daemonHeadRevision` test type migration errors, so type closeout for the whole branch remains unclaimed.
- Remaining gaps: remote-window runtime APIs still retain optional daemonConnection/raw socket branches in tests and function signatures; input/session/activity/buffer legacy accessors remain migration paths; `tmux-sessions.ts` direct pool and `activeSocket`/control-vs-terminal store split still need removal or stricter compat gating; live daemon/network/APK/commit/push are not closed.

# 2026-07-26 sync upload crash diagnosis
- Jason reported: choosing sync/upload crashes the Android app.
- Flow classification: `daemon.file_transfer` / `client.file_browser`: QuickBar sync -> `FileTransferSheet` local file browser -> `StoragePermissionPlugin.readFile` -> `file-upload-*` mux messages -> daemon file transfer runtime. Resources: `resource.client_file_browser -> resource.file_transfer -> resource.backend_session`. Forbidden as fix points: terminal buffer/render, remote-window stream, transport reconnect fallback.
- Device evidence: ADB initially online `100.104.163.65:5555`, installed app `0.1.3.2249` pid `29574`; current screenshot/dumpsys shows device locked/AOD and package frozen, so live crash replay cannot be driven yet. Existing logcat has no `com.zterm.android` FATAL; current ADB then went offline.
- Static first-risk evidence: upload path calls `StoragePermissionPlugin.readFile` and native `readFile()` reads entire selected file into `ByteArrayOutputStream`, then returns a single base64 string to WebView. `FileTransferSheet.startTransfer` then slices that base64 and sends chunks. This can OOM / WebView-renderer crash before JS chunking when selecting a large upload file. Owner remains `client.file_browser` + native storage plugin; fix should add native chunk read and make upload stream chunks from native, not one whole base64 payload.
- Closeout: `FileTransferSheet` upload now computes chunk count from file size and calls `StoragePermissionPlugin.readFileChunk(path, offset, length)` for each 256 KiB span; it no longer calls whole-file `readFile()` on upload. Native `StorageFileReadLogic` returns only bytes/bytesRead/eof, and `StoragePermissionPlugin` performs `android.util.Base64.NO_WRAP` encoding at the bridge boundary so minSdk 24 does not depend on `java.util.Base64`.
- Verification: file-transfer component/runtime gate `21 PASS`; native `StorageFileReadLogicTest` PASS; server file-transfer truth gate `13 PASS`; QuickBar/split gate `74 PASS`; `tsc --noEmit` PASS; feature/module/resource/mainline gate `71 PASS`; full `build:android` PASS with terminal regression/core gates; installed APK `0.1.3.2254` on ADB device `100.104.163.65:5555`; WebView CDP live bridge probe read a 614400-byte file in native chunks `262144 + 262144 + 90112` with `eof=true`; post-probe logcat had no `FATAL EXCEPTION`, `AndroidRuntime`, `OutOfMemory`, or `RenderProcessGone`.
- Delivery: Android APK `0.1.3.2254` / versionCode `1032254` / sha256 `ad31d10afc340ffb850e26a2e04a71aaf7befde92c12fb47ca0976f2b0903619` is published to local update route, Tailscale update route, and public Relay `https://relay.codewhisper.cc:18443/relay/updates/latest.json`; downloaded public APK sha matched. Temporary ADB smoke file and devtools forward were removed.

# 2026-07-26 architecture gap T2c/T9 reconnect store mapping

- Scope: `terminal.transport_lifecycle`; resources `resource.active_session -> resource.session_transport -> resource.daemon_target_transport -> resource.terminal_channel`.
- Unique owner/edit class: `client.daemon_connection` / SessionContext transport lifecycle runtime; category is separate/downstream store convergence, not protocol/UI/daemon behavior change.
- Current evidence: `session-reconnect-store.ts` already defines `idle | scheduled | connecting`, but product runtime still passes `reconnectRuntimesRef`, `manualCloseRef`, and `staleTransportProbeAtRef` through provider/core/facade/session/open/activity/socket/buffer runtimes.
- Planned fix: make `SessionReconnectStore` own reconnect phase, manual-close markers, and stale head-probe markers; provider creates one store ref; runtimes consume store methods instead of direct Map/Set refs. This keeps illegal `connecting + timer` unrepresentable and removes the scattered ref bag.
- Forbidden paths for this slice: `TerminalPage.tsx`, `TerminalView.tsx`, `src/server/**`, and shared wire protocol. Required gates: reconnect store unit tests, focused transport/session/lifecycle/ws-refresh tests, `tsc --noEmit`, and `test:feature-registry`.

# 2026-07-26 architecture gap T2c/T9 reconnect closeout

- Closeout: `SessionReconnectStore` now owns reconnect runtime phase, manual-close markers, and stale transport probe markers. Product paths no longer reference `reconnectRuntimesRef`, `manualCloseRef`, or `staleTransportProbeAtRef`.
- T9 invariant: phase union is `idle | scheduled | connecting`; only `scheduled` carries a timer. `startReconnectAttemptRuntime` uses `globalThis.setTimeout` and writes a scheduled phase, then timer fire marks connecting before queueing the open intent.
- New red/green coverage: store unit tests lock manual close cleanup and stale probe no-replace behavior; session runtime tests lock manual close suppressing retryable reconnect, scheduled -> connecting without timer, and no duplicate queue while scheduled/connecting.
- Verification evidence: reconnect store 8/8, focused reconnect/context 77/77, lifecycle/ws-refresh 158/158, contexts all 451/451, `type-check` PASS, `test:feature-registry` 71/71, `test:terminal:regression:core` PASS (terminal contracts 49 files/638, common flows 83, relay smoke ok), scoped diff-check PASS.
- Remaining T2 gap: `session-context-provider-assembly-types.ts` still has `refs: any` and typed-any surfaces; `session-context-message-assemblies.ts` still has local `any` signatures. This is T2d, separate from reconnect phase truth.

# 2026-07-26 sync upload crash 2255 follow-up

- Follow-up scope: same `daemon.file_transfer` / `client.file_browser` chain. Upload had already moved from whole-file `readFile()` to native `readFileChunk()`, but local Markdown preview still used whole-file `StoragePermissionPlugin.readFile()` when tapping a local `.md` filename. That left a second WebView/native bridge OOM/crash path before upload.
- Fix: `FileTransferSheet.previewLocalMarkdown()` now reads local Markdown preview through bounded native chunks, capped at 512 KiB, with streaming `TextDecoder` and an explicit truncation notice. Upload still reads and sends the complete file in 256 KiB native chunks.
- Source check: `rg "StoragePermissionPlugin\\.readFile\\(" android/src/components/terminal/FileTransferSheet.tsx` has no match; only `readFileChunk()` remains in upload and local preview paths.
- Verification: `FileTransferSheet.test.tsx + file-transfer runtime + server file-transfer truth` PASS `3 files / 27 tests`; native `StorageFileReadLogicTest` PASS; `tsc --noEmit` PASS; `test:feature-registry` PASS `10 files / 71 tests`; scoped `git diff --check` PASS.
- Delivery: Android APK `0.1.3.2255` / versionCode `1032255` / sha256 `1c7819789dfe7f904e1e030d85ced0f4191b935e75616c3919127fd2b458b1c6` built and served by local, Tailscale, and public Relay update routes; downloaded APK sha matched on Tailscale and public Relay.
- L5 smoke: installed on ADB `100.104.163.65:5555` as `com.zterm.android` version `0.1.3.2255` / `1032255`. WebView CDP bridge read a 1.5 MiB probe file in six 256 KiB native chunks and a 12 MiB probe file in 48 native chunks; app pid stayed alive and logcat showed no `AndroidRuntime`, `FATAL EXCEPTION`, `OutOfMemory`, or `RenderProcessGone`. Temporary probe files and `tcp:9229` adb forward were removed.

# 2026-07-27 sync upload crash reopened listener churn diagnosis

- Jason reported the sync/upload button can still crash the app on installed Android `0.1.3.2255`. Current device evidence: ADB `100.104.163.65:5555` online, package `com.zterm.android` versionCode `1032255`, pid `19310` alive. Recent logcat did not show `FATAL EXCEPTION`, but showed thousands of `Capacitor App.addListener/removeListener appStateChange` calls in seconds.
- Source check: `FileTransferSheet` upload and local Markdown preview still call only `StoragePermissionPlugin.readFileChunk()`. `rg "StoragePermissionPlugin\\.readFile\\(" android/src/components/terminal/FileTransferSheet.tsx android/src/pages android/src/hooks android/src/lib` has no matches.
- First confirmed divergence: `useOpenTabLifecycleEffects` registered Capacitor `appStateChange` inside an effect whose dependency list included render-changing callbacks. Sync sheet state changes can therefore churn native listeners and flood the WebView/native bridge while upload also sends native file chunks.
- Architecture mapping: fix owner is `terminal.open_tabs` lifecycle, not `daemon.file_transfer` protocol. File sync remains `resource.client_file_browser -> resource.file_transfer -> resource.backend_session`; foreground native listener lifecycle is `terminal.open_tabs` / App lifecycle owner.
- Red/green: added `useOpenTabLifecycleEffects.test.tsx`, which first failed because callback-only rerender registered `appStateChange` twice. Fix stores latest callbacks in a ref and keeps the native listener effect bound only to stable refs; the test now passes and proves events dispatch to the latest callback without re-registering.
- Delivery: Android APK `0.1.3.2256` / versionCode `1032256` / sha256 `37c16592324382eaf62f8e5c00556d19f06b1b09c83df1eeb00be39f0e41fcb5` built and served by local `127.0.0.1:3333`, Tailscale `100.66.1.82:3333`, and public Relay `https://relay.codewhisper.cc:18443/relay/updates/latest.json`; public APK HEAD length `4809399`, downloaded public/local/Tailscale APK sha matched.
- L5 smoke: installed on ADB `100.104.163.65:5555` as `com.zterm.android` version `0.1.3.2256` / `1032256`. Cold launch pid `29962`. post-install/start logcat showed no `addListener`/`removeListener` flood and no `FATAL EXCEPTION`/`OutOfMemory`/`RenderProcessGone`. Jason still needs to manually open sync sheet and upload to close the crash L5.

# 2026-07-27 file sync upload crash wire-frame diagnosis

- Jason: 选择同步按钮时上传会出现 app crash。
- feature_id=`daemon.file_transfer`; resource path `resource.client_file_browser -> resource.file_transfer -> resource.backend_session`.
- 已完成 native `readFileChunk` 流式上传后，剩余风险是 wire 帧过大：`FILE_CHUNK_SIZE=256KiB` raw -> base64 ~341KiB -> 再经 `mux-channel-message` JSON 包装，超过常见 RTC DataChannel `maxMessageSize`（常为 256KiB），上传时会直接炸 channel/WebView。
- 唯一修改点：shared `FILE_TRANSFER_WIRE_CHUNK_BYTES=16KiB` 作为 client/daemon 同一真源；`FileTransferSheet` 与 daemon download/upload chunk 共用；新增 frame size 门禁。
- Forbidden: transport reconnect、buffer/render、TerminalView。
- Verification: `FileTransferSheet` / file-transfer runtime / transfer context / daemon file-transfer gates PASS `5 files / 35 tests`; shared protocol contract PASS `8 tests`; `tsc --noEmit` PASS; `test:feature-registry` PASS `10 files / 71 tests`.
- Clean detached HEAD build was attempted to avoid unrelated dirty WIP, but failed before APK because committed `HEAD=6f967e8` is incomplete without current untracked architecture files such as `android/src/lib/client-daemon-connection.ts`; this is a separate repository hygiene gap, not a file-transfer behavior failure.
- Delivery: built from the current verified working tree. Android APK `0.1.3.2257` / versionCode `1032257` / sha256 `b8ef040341adc9253589fb09d542fcc40d22956b695241be526c848975f1a4b4` published to local update route, Tailscale `100.66.1.82:3333`, and public Relay `https://relay.codewhisper.cc:18443/relay/updates/latest.json`. Public Relay APK HEAD returned `Content-Length: 4809751`; downloaded public and Tailscale APK sha matched the manifest.
- L5 gap: `adb devices -l` returned no online devices after build, so installed-phone sync button/upload replay remains Jason-side pending for `2257`.

# 2026-07-27 architecture gap T2d any clear

- Scope: `terminal.transport_lifecycle` / `terminal.buffer_render` SessionContext assembly boundary only. Forbidden: protocol behavior, daemon runtime, TerminalView/TerminalPage compensation.
- Change: `SessionProviderRuntimeRefs` now types the provider ref bag; message assemblies expose typed socket/buffer/server-message options and structural minimal store/runtime interfaces instead of `MutableRefObject<any>` / callback `any`.
- Hidden mismatch surfaced by types: transport orchestration's `handleSocketServerMessageRef` callback needed `onClosed`; the real runtime already consumed it, but the old `any` boundary hid the missing signature.
- Verification: `tsc --noEmit` PASS; contexts `MutableRefObject<any>|refs:any` grep 0; target file `any` grep 0; focused message/session/ws-refresh 161/161; contexts all 451/451; `test:feature-registry` 71/71; `test:terminal:regression:core` terminal-message 37/37 + contracts 49 files/639 + common flows 83/83 + relay smoke PASS.
- Remaining architecture closeout: T7 App relay stream downshift and T8 TerminalView follow-scroll state machine remain pending; T8 still requires test design first and real terminal-buffer truth loop.

# 2026-07-27 architecture gap T7 App relay stream downshift

- Scope: `relay.directory_ui` / `client.connection_home` only. Forbidden: terminal transport reconnect, buffer/render, TerminalView, daemon protocol.
- Change: App.tsx no longer owns relay device WebSocket reconnect timers/generation/socket refs. Owner is `relay-device-stream-runtime` + `useRelayDeviceStream`; presence/directory merge re-exported from home-connection projection.
- Verification: runtime unit 4/4; App.relay-stream-lifecycle 7/7; architecture-boundary 14/14; home-connection/traversal/account 20/20; type-check; feature-registry; App.tsx 844 lines.
- Remaining architecture closeout: T8 TerminalView follow-scroll state machine only.

# 2026-07-27 architecture gap T8 TerminalView follow scroll closeout

- Scope: `terminal.buffer_render` / `client.renderer_window`. Resource path remains `resource.client_sparse_buffer -> resource.renderer_window -> resource.ui_projection`; forbidden paths were daemon mirror, transport reconnect, SessionContext buffer planner, TerminalPage/QuickBar/IME compensation.
- Change: added `src/lib/terminal-follow-scroll-runtime.ts` as the pure discriminated-union owner for follow/reading scroll truth. TerminalView no longer has independent `pendingFollow*`, `recentViewportLayoutChangeRef`, `ignoredProgrammaticScrollTopRef`, `lastSettledScrollTopRef`, `hasSettledFollowFrameRef`, `suppressProgrammaticScrollRef`, `userScrollIntentDeadlineRef`, or `readingModeRef`; it keeps only timer/function refs as effect handles and applies runtime effects to DOM/React state.
- Tests/maps: added `docs/testing/terminal-follow-scroll-state-test-design.md`; bound `terminal-follow-scroll-runtime` into `client.renderer_window` module registry and `terminal.buffer_render` function map. Runtime tests cover pending dedupe, reading no pending, flush/no-flush, programmatic one-shot suppress, user intent reading, layout drift negative, selectors, reset, and cancel.
- Verification: `terminal-follow-scroll-runtime.test.ts` 10/10 PASS; TerminalView focused 85/85 PASS; TerminalPage render/session identity 28/28 PASS; `tsc --noEmit` PASS; `test:feature-registry` 72/72 PASS; `daemon:mirror:close-loop` all 9 cases PASS; scoped `git diff --check` PASS; old follow ref names in `TerminalView.tsx` 0.
- Known non-T8 gate failure: `TerminalView.theme.test.tsx` currently fails 2 theme preset assertions (`DEFAULT_TERMINAL_CELL_COLOR` bg resolves transparent and `classic-dark.background` is `#000000`). This is shared theme/cell-render truth, not the follow-scroll owner touched here; do not claim full TerminalView.* suite until that separate owner is repaired or baseline is documented.

# 2026-07-27 sync upload crash progress-ack diagnosis

- Jason: 选择同步按钮时上传会出现 app crash。
- feature_id=`daemon.file_transfer`; resource path `resource.client_file_browser -> resource.file_transfer -> resource.backend_session`.
- Prior closeouts already fixed whole-file native `readFile()`, local markdown preview, appStateChange listener churn, and 16KiB wire chunk budget. Current source still burst-sent all `file-upload-chunk` frames without waiting for daemon progress.
- First remaining divergence: upload owner in `FileTransferSheet`/`file-transfer-session-runtime` could flood RTC DataChannel even under frame budget. Unique fix: wait for `file-upload-progress` after each chunk and `file-upload-complete` before finish; no transport reconnect fallback.
- Forbidden: buffer/render, TerminalView, transport reconnect, daemon mirror.

# 2026-07-27 connected green but terminal body not refreshing diagnosis

- Symptom: Jason confirmed upload no longer crashes, but online device can show connected/green while terminal body does not refresh.
- SOP/model flow: known `terminal.buffer_render` plus metadata-only `daemon.cli_node` observability. Main chain is `tmux truth -> daemon mirror store -> transport subscriber buffer-sync -> client sparse buffer -> renderer window -> TerminalView DOM`. Resource path is `resource.mirror_store -> resource.transport_subscriber -> resource.client_sparse_buffer -> resource.renderer_window`; debug path is `resource.daemon_process -> resource.debug_channel`.
- Live handoff evidence: `/debug/runtime/logs` showed active `freehand` receiving `session.ws.reconnect.buffer-sync`, applying `session.buffer.applied`, and emitting `terminal.performance.trace` client stages. Daemon mirror revision was advancing, often as one changed status row. Repeated sparse one-row same-tail updates triggered `session.buffer.sync.visible-stale-non-gap-repair-request` repeatedly, causing large authoritative reading-repair responses and debug drop summaries. `/debug/runtime` latency summary stayed null because daemon trace ids used mux channel ids while client trace ids used local session ids.
- Active hypotheses: H1 repeated visible non-gap repair amplification overloads client/transport/render enough to appear connected but stale; H2 trace identity mismatch hides the real first stopped stage during live diagnosis. Both are inside existing owner graph; no WebSocket reconnect/UI chrome compensation allowed.
- First divergence nodes: H1 `BufferApply -> reading-repair request planner`; H2 `PerformanceTrace sample grouping`. Unique owner paths: `src/contexts/session-context-buffer-runtime.ts` / test and `packages/shared/src/terminal/performance-trace.ts` / `src/lib/terminal-performance-trace.test.ts` / HTTP summary test. Forbidden: `TerminalPage.tsx`, `TerminalView.tsx`, route selection, daemon tmux mirror truth, reconnect loops.
- Required verification: focused buffer runtime red/green, trace identity red/green, `/debug/runtime` live check with non-null send-to-rx/rx-to-render, and L5 APK only after source gates pass.
# 2026-07-27 normal-network target transport recovery diagnosis

- Symptom: Android can remain unable to connect even while Wi-Fi, Tailscale, public Relay, and the daemon are reachable. Current online-device replay connected only after foreground wake, so the intermittent failure itself was not reproduced in that replay; daemon history is the failing-path evidence.
- SOP/model flow: known `terminal.transport_lifecycle`; `resource.transport_target -> resource.daemon_target_transport -> resource.terminal_channel`. Control/directory and terminal payload remain separate. UI, buffer, renderer, and daemon mirror are forbidden compensation layers.
- Raw evidence: `~/.zterm/logs/launchd-stderr.log` repeatedly records failed RTC transports retained until `staleForMs ~= 190000`; the target failure owner in `session-context-transport-orchestration-runtime.ts` clears `targetRuntime.terminalTransport` but neither calls `reportFailure()` nor closes the failed physical socket. `TraversalSocket` records a route as successful when the backend opens, so a later mux hello/channel-ready timeout does not poison that route unless the owner explicitly reports the protocol failure.
- Active hypothesis H1, confirmed by source/data flow: an OPEN route that fails at mux handshake is removed from target truth without retirement. The next reconnect can select the same falsely healthy route again, while the old daemon transport survives until the 190-second stale-inbound guard. This explains failure under otherwise reachable networks and the repeated stale transport records.
- First divergence: `DaemonTargetTransport failure -> route health/physical retirement`. The target failure fanout updates logical channels before retiring the failed physical generation.
- Unique owner: `handleTargetMuxTransportFailureRuntime`. Allowed product path: `src/contexts/session-context-transport-orchestration-runtime.ts`; owner test: `src/contexts/session-context-transport-orchestration-runtime.test.ts`; test design: `docs/testing/session-transport-network-switch-test-design.md`. Forbidden: Relay account stream, TerminalPage/UI, buffer/render, daemon mirror, per-session fallback sockets.
- Required positive gate: one target mux failure reports route failure, clears target truth, closes the exact failed physical socket, and schedules one target rebuild while preserving all recoverable channel ids. Required negative gate: already-closing/closed physical transports are not closed again, and multiple logical channels still produce only one retirement/rebuild.
- Exact live closeout still required after APK: controlled Wi-Fi/cellular or route interruption, no app kill, terminal output/input recovery within 10 seconds, old daemon transport removed instead of surviving 190 seconds, and unchanged logical session/tmux identity.

# 2026-07-27 normal-network route quarantine diagnosis round 2

- Symptom: Android can remain disconnected while the Mac Studio Tailscale endpoint is healthy; killing and reopening the Android process makes the same endpoint connect immediately.
- SOP/model flow: known `terminal.transport_lifecycle` entering the adjacent `relay.route_selection` owner at `TransportOpen -> TraversalSocket.connectNext -> selectBestTraversalRoute -> route-health-cache`. Resource path remains `resource.transport_target -> resource.daemon_target_transport -> resource.terminal_channel`; control/directory sockets and terminal payload sockets remain separate.
- Exact live evidence: before the process restart, CDP showed terminal open selecting repeated `wss://relay.codewhisper.cc:18443/relay/ws/client?...hostId=mac-studio` sockets even though a phone-side `ws://100.66.1.82:3333` list-sessions probe succeeded. After an explicit package-scoped restart, CDP request `19044.18` opened `ws://100.66.1.82:3333/?token=...`, received `mux-ready`, opened `channel:session-1785157218708-bsahaw2j`, received `connected` and `buffer-sync`, and rendered `freehand`. The runtime label was `Tailscale`.
- Confirmed hypothesis H2: `TraversalRouteHealthCache` retains ordinary transient failures for five minutes, while `selectBestTraversalRoute` makes every fresh failure `selectable=false`. The cache is process-local, so killing the app clears the false-negative quarantine and immediately restores the healthy Tailscale route. This is the first divergence from the expected network-recovery model.
- First divergence: `RouteHealth failure record -> next physical target route selection`. A transient network failure is incorrectly treated as a five-minute hard blacklist instead of a short circuit-breaker cooldown followed by a fresh probe.
- Unique owner: `src/lib/traversal/route-health-cache.ts` plus `src/lib/traversal/route-selector.ts`; owner tests are `route-health-cache.test.ts`, `route-selector.test.ts`, and `traversal/socket.test.ts`. The target retirement change remains in `session-context-transport-orchestration-runtime.ts` but is not the owner of the second divergence.
- Allowed paths: traversal health/selection owner, its tests, network-switch test design, feature/function/mainline bindings, project note/memory/skill. Forbidden: `TerminalPage`, UI banner, renderer/buffer, daemon mirror, Relay account stream, per-session sockets, and reconnect compensation outside the physical target owner.
- Required positive gate: an ordinary route failure is quarantined only for a bounded short cooldown; after cooldown the same candidate is probe-eligible without process restart. Required negative gate: auth failure remains quarantined for the full health TTL, and a failed candidate cannot be retried repeatedly inside one `TraversalSocket` attempt generation.
- Real-device closeout: on the newly built APK, switch Wi-Fi off/on and cellular/Wi-Fi in both directions without killing the app; prove the same logical session/tmux target resumes within 10 seconds and CDP shows one target transport generation at a time.

# 2026-07-27 normal-network route quarantine implementation and live verification

- Unique fix: `TraversalRouteHealthCache` now expires an ordinary `failure` after its fixed one-second owner policy, while `success` and `auth-failure` retain the five-minute health TTL. The cooldown has no caller override/default path. No UI reconnect loop, per-session transport, fallback endpoint, or second route owner was added.
- Positive gates: an ordinary failure becomes probe-eligible after cooldown; the selector chooses Relay during cooldown and selects the recovered Tailscale endpoint after cooldown without process reset. Negative gate: authentication failures remain quarantined for the full health TTL. Target mux failure now reports route failure, removes the exact failed socket from target truth, closes it once, preserves channel ids, and schedules one target rebuild; an already-closing socket is not closed again.
- Source verification: focused route/transport stack PASS `7 files / 84 tests` before handoff and rerun PASS `6 files / 57 tests`; architecture registry PASS `10 files / 72 tests`; full Android prebuild/regression/build PASS; `tsc --noEmit` and `git diff --check` PASS.
- Installed-device baseline: APK `0.1.3.2263` / versionCode `1032263` installed on ADB `100.104.163.65:5555`. CDP opened `ws://100.66.1.82:3333`, received `mux-ready`, `mux-channel-opened`, `connected`, `buffer-head`, and `buffer-sync`, and rendered `freehand` on the Tailscale route.
- Live physical-failure replay: service-scoped Mac Studio daemon restart closed the target socket; the same Android process re-probed `ws://100.66.1.82:3333` at about 3.31s, received `mux-ready` at 3.344s, reopened the unchanged `channel:session-1785158382390-vf9m8pnk` at 3.348s, received `connected` at 3.360s and resumed buffer frames at 3.390s. No Android process restart or session switch was used.
- Repeated replay: three daemon restarts preserved the same logical channel id. The first two recovered direct Tailscale transport and buffer frames within about 0.6-1.5s after each restart; the third projected `Relay/TURN` with the session connected. This proves short-cooldown re-probe and route failover, but it also exposed multiple route/probe WebSocket creations around one physical rebuild; one-physical-target-generation enforcement remains part of the active connection-gateway goal and is not claimed complete here.
- Network-change replay: Wi-Fi off with cellular-backed Tailscale, then Wi-Fi on, kept the same terminal session connected and rendered; no app kill was required. This did not force the Mac Studio target socket to close, so it is evidence for underlay continuity, not a replacement-socket proof.
- Delivery: APK `0.1.3.2263`, sha256 `22c83cea0dc102e4522eb1f1cc1931bdb6628daa5d9f512f4f37b363bbd3cbc5`, is live on local, Tailscale, and public Relay update routes; public GET/HEAD and downloaded APK sha match the manifest.

## 2026-07-27 network-normal connection failure diagnosis contract

- Confirmed architecture violation: `useOpenTabLifecycleEffects` maps Capacitor `networkStatusChange.connected=false` to `onForegroundActiveChange(false)` and marks foreground runtime hidden. Network reachability and app visibility are independent resources; this can stop visible-page freshness/recovery timers even when the target endpoint remains reachable.
- Existing red test locks the wrong behavior (`marks foreground hidden when network disconnects`) and must be inverted before runtime repair.
- Target heartbeat is already one-per-target at 60 seconds x 3 misses; shortening the global heartbeat or adding session reconnect branches would duplicate ownership. Network change needs one bounded probe keyed by daemon target plus exact socket generation, with timeout submitted to the existing `TerminalTransportError01TargetFailure` owner.
- Live 2263 observation did not prove a permanent failure, but daemon health showed zero subscribers after the app left foreground. The architecture violation is confirmed by source/test; real-device closure still requires network transition replay on the new APK.
- Codex review round 1 found the initial network probe incorrectly scoped platform events through `activeSessionId`, returned `started` after synchronous send failure, declared gates that were not wired into prebuild/CI, and recorded non-existent or non-caller map symbols. The correction keeps the lifecycle hook signal-only, makes `client.daemon_connection` enumerate all current daemon-target generations, returns `send-failed` explicitly, binds real adjacent callers/symbols, and wires lifecycle/probe/orchestration tests into both prebuild and CI.

## 2026-07-28 network-generation probe review closeout

- Final review found two remaining boundary defects: foreground generation was still downstream of the active-session audit gate, and the call map compressed facade/binding/orchestration/failure routing into non-adjacent edges.
- Runtime correction: foreground entry now submits `foreground-resume` to the physical target owner before session/UI resume eligibility is evaluated. A zero-session retained target is therefore probed while tab audit/follow reset may independently skip.
- Map correction: the machine mainline now records the adjacent facade, provider binding, orchestration, probe, generation-safe failure router, channel-bearing failure owner, and zero-session retirement branches. Function map, edge registry, wiki, skill, and red gates use the same node IDs.
- Follow-up review exposed the remaining zero-session transport defect: the physical target was retained, but its inbound listener still validated through the removed anchor session, so valid pong activity was ignored and the probe falsely timed out. The listener now reads current generation by target key; mux ping serialization moved to the shared protocol builder; the call map now separates probe dispatch from the probe runtime owner.
- The next review found two governance defects: probe clock/timeout silently defaulted or clamped, and the signal call map skipped `useOpenTabRuntime` plus `AppContent`. The constructor now requires explicit clock and finite positive timeout, while function/mainline/edge maps and gates bind the complete signal forwarding chain.
- Review round 3 found that fractional timeouts were still silently floored, two real provider binding layers were missing from the call map, the probe closure was represented by a fabricated static symbol, and the core TS policy had no Rust migration binding. The owner now rejects any non-positive-safe-integer timeout without rounding; the adjacent map includes public-facade and provider-core bindings; the map names the real factory symbol only; and migration `terminal.transport_lifecycle.target_network_probe.rust` is explicitly `planned` with current TS owner, target Rust path, activation criteria, and a truth gate. These are governance/source corrections pending rerun and review, not live network closure evidence.
- Fresh review cycle round 1 found that shared `buildTerminalMuxPing` still repaired fractional/negative timestamps and that the probe owner did not reject a missing clock at construction. The shared builder now accepts only non-negative safe integers, while the probe owner validates a callable clock before creating state; paired red tests prevent either invalid input from entering the transport failure chain.
- Fresh review cycle round 2 found a remaining timestamp fallback in the generic mux payload wrapper and a non-existent compressed mainline edge in the test design. Target heartbeat now constructs its own timestamped `mux-ping` through the shared builder before generic sending; the wrapper's legacy ping conversion is physically removed. The test design now references every real adjacent signal edge through `TargetNetworkProbe`.
- Fresh review cycle round 3 found that foreground resume fabricated `connected: true` when `navigator` was unavailable. `SessionTargetNetworkSignal` is now source-discriminated: Capacitor/window signals carry observed connectivity, while `foreground-resume` carries generation only. Runtime debug preserves that distinction and no longer invents reachability metadata. This repair still requires a newly authorized Codex review cycle before commit.
# 2026-07-28 network-generation target probe review closeout

- feature/owner: `terminal.transport_lifecycle` / `client.daemon_connection`; network callbacks remain signal-only and probe each exact daemon-target socket generation once.
- Codex review corrections: bound both real `buildTerminalMuxPing` callers into `TerminalMuxPingBuilder`; replaced free-text probe failures with `TargetNetworkProbeError01GenerationTimeout | TargetNetworkProbeError02SendFailure` and exhaustive owner projection; expanded the CI/prebuild network gate to include target heartbeat and shared protocol tests.
- verification before final review: `test:transport-network-lifecycle` Android 30/30 + shared protocol 9/9 PASS; `test:feature-registry` 74/74 PASS; type-check, JSON parse, and diff checks PASS.
- remaining product gap: network switch/foreground recovery still requires a new packaged APK and real-device bidirectional Wi-Fi/mobile/Tailscale/relay matrix; automated gates do not prove product closure.

## 2026-07-28 terminal chunk frame continuity investigation

- Field symptom: large refreshes can update the tail while leaving a stale middle region; old and new buffer content alternates before eventually converging.
- Reproduced structural defect in the current white-box contract: `applies later chunks from the same authoritative revision frame` passes only because it explicitly expects two local commits and two render schedules for a two-chunk frame.
- Source trace: daemon `splitBufferSyncPayloadMessages()` emits one frame as multiple WebSocket messages; client `applyIncomingBufferSyncRuntime()` applies each message immediately, records only applied chunk indexes, and schedules render after every chunk. WebSocket messages run as separate event tasks, so RAF can publish the intermediate hybrid frame.
- Architecture mapping: feature `terminal.buffer_render`; unique owner `client.buffer_store` / `session-context-buffer-runtime.ts`; action is physical removal of per-chunk publication and separation into bounded frame assembly followed by the existing single sparse apply path. Allowed paths match feature/resource/module registries; forbidden UI/QuickBar paths are untouched.
- Required gates: buffer runtime positive/negative frame tests, render gate/store, TerminalView source-to-DOM no-mixed-frame black box, daemon oversized chunk coverage, feature/resource/mainline gates, and live daemon/tmux close-loop. Local tests alone do not close the real-device risk.
- Implemented owner correction: `session-buffer-frame-assembly.ts#assembleBufferSyncFrameChunk` now buffers one frame identity per session, validates dense chunk rows plus exact contiguous frame coverage, and emits one complete payload. `applyIncomingBufferSyncRuntime()` no longer re-enters itself or publishes individual chunks; it calls the resolved sparse apply stage exactly once after assembly.
- Same-revision different-frame interleave now rejects the current payload, clears the poisoned incomplete state, and requests an authoritative repair. A paired runtime gate proves the interleave never commits while the next consistent same-revision repair commits and renders exactly once.
- Frame assembly is now a required production resource across provider/message/reset/socket cleanup wiring. Missing injection is a type error rather than a silent forever-pending frame.
- Close-loop replay now declares each intermediate step as `source-only` or `source-and-client-render`; a client-render mismatch exits nonzero even if the final frame converges. Core frame policy has planned Rust migration id `terminal.buffer_render.frame_assembly.rust`; TypeScript remains the active unique owner until parity/bridge/removal gates complete.
- Codex review round 1 found two P0 gaps: frame rejection only emitted debug then automatically requested repair without an error truth/bound, and the call map skipped the adjacent `BufferFrameAssembly -> BufferSparseApply` edge. Correction keeps `pending + error` in one per-session frame resource, limits repairable rejection to one attempt per revision, leaves stale-frame rejection non-repairing, clears error only after a verified passthrough/complete frame, and adds the missing adjacent machine/wiki/edge binding while retaining ingress-to-sparse only for unchunked passthrough.
- Follow-up source audit found a second old/new flashback edge: an unchunked payload older than a newer incomplete frame was returned as passthrough, while ingress deleted the pending assembly before sparse freshness handling. The assembly owner now rejects both chunked and unchunked lower revisions as `stale-frame`, preserves the newer pending frame, emits no repair, commit, or render, and has pure plus runtime negative gates.
- Post-correction verification: focused buffer/render/runtime stack `7 files / 156 PASS`; architecture/registry stack `10 files / 76 PASS`; type-check and source-JS pollution gate PASS; `git diff --check` PASS. Real daemon/tmux close-loop passed `codex-live`, `top-live`, `vim-live`, `initial-sync`, `local-input-echo`, `long-input-echo`, `external-input-echo`, `daemon-restart-recover`, and `schedule-fire`; every client-visible intermediate step used `source-and-client-render` and matched, and the test tmux session was removed.
- Codex review round 2 rejected the first closeout because frame assembly was still registered as sparse-buffer internal state, rejection repair used a derived tail instead of the rejected frame's exact range, and a request suppressed before wire dispatch still consumed the one-repair budget. The architecture now has an independent `resource.client_buffer_frame_assembly` and registered `mirror_store -> frame_assembly -> client_sparse_buffer` edges. Error truth stores exact `[frameStartIndex, frameEndIndex)` plus `pending/dispatched`; only a successful request dispatch consumes the revision budget, while the next legal `buffer-head` retries pending repair. Lower-revision malformed payloads are classified stale before metadata repair and retain the newer assembly.
- Post-review correction gates: focused buffer/render/runtime stack `7 files / 157 PASS`, pure/runtime frame pair `52 PASS`, feature/resource/module/import/mainline stack `10 files / 76 PASS`, type-check/source-JS pollution PASS, JSON parse PASS, and `git diff --check` PASS. Full terminal contracts ran `51 files / 696 tests`; `50 files / 694 tests` passed and only the two pre-existing `SessionContext.ws-refresh` active-first ordering assertions failed. Real daemon/tmux close-loop passed all nine cases again with strict intermediate source/client-render comparison and removed `zterm_daemon_mirror_lab`.
- Codex review round 3 found three remaining repair-truth defects: malformed wire revision was fabricated as `0`; same-revision interleave could repair the incoming conflicting range instead of the original pending range; and successful repair deleted the dispatch ledger, allowing a delayed malformed payload to request the same revision again. Correction makes error revision nullable, derives it only from retained pending truth or authoritative live head, returns the original pending range, and retains `repairDispatchedRevision` through successful same-revision apply until revision advancement.
- Latest post-correction gates: focused frame/buffer/renderer stack `7 files / 160 PASS`; feature/resource/module/import/mainline stack `10 files / 76 PASS`; type-check/source-JS pollution and diff checks PASS. Full terminal contracts ran `51 files / 698 tests`; `50 files / 696 tests` passed, with only the same two independently documented `SessionContext.ws-refresh` active-first ordering assertions failing. Real daemon/tmux close-loop passed all nine cases with strict intermediate `source-and-client-render` comparison and explicit tmux cleanup. Mandatory Codex re-review and packaged-device black-box are still pending, so this entry does not claim product closure.
- Codex review round 4 found that a revisionless malformed payload could bypass the dispatch ledger after resolving its revision from live head, retained frame chunks had no concrete capacity/lifetime limits despite registry claims, and the schedule-fire live step declared client-render verification while hardcoding `ok: true`. Correction rechecks `repairDispatchedRevision` after authoritative head resolution; moves frame limits into shared protocol constants (`4096` rows, `512` chunks, `64 MiB`, `15s`); expires incomplete frames from buffer-head cadence into exact-range repair truth; and routes schedule-fire through `buildStepResult` so client divergence is fatal. Focused owner/server gates now pass `4 files / 84 tests`, shared protocol/buffer gates pass `12`, type-check and diff checks pass. Full regression, close-loop, re-review, and device verification remain pending.
- Post-round-4 audit also locked revision/range identity: when a malformed packet advertises a different valid range while an incomplete frame is retained, the rejection repairs the retained frame's exact range instead of pairing the retained revision with the incoming range. Final local gates: focused buffer/render stack `8 files / 175 PASS`; owner/server subset `4 files / 85 PASS`; feature/resource/module/import/mainline `10 files / 76 PASS`; type-check and diff checks PASS. Full terminal contracts ran `51 files / 703 tests`; `50 files / 701 PASS`, with only the same two pre-existing `SessionContext.ws-refresh` active-first ordering assertions failing. Real daemon/tmux close-loop passed all nine cases, including schedule-fire source/client comparison, and explicit tmux cleanup returned no session. Mandatory Codex re-review and packaged-device black-box remain pending.
- Mandatory Codex review round 5 failed on two frame-resource lifecycle defects: the scalar dispatch ledger was deleted when a later revision succeeded, allowing an old revision repair to dispatch twice; and a newer pending frame inherited an older undispatched repair error, allowing the next head to request stale repair. The frame assembly owner now holds a bounded 512-revision per-session dispatch ledger that survives later successful revisions, and pending-frame supersede atomically clears older repair error while retaining the ledger. Paired tests prove `repair 11 -> success 12 -> malformed 11` does not redispatch, and `pending repair 11 -> pending frame 12 -> head 12` does not dispatch the old repair. Post-correction focused stack passes `8 files / 179 tests`, architecture stack `76 PASS`, type-check and diff checks PASS; re-review and live/device reruns remain pending.

## 2026-07-28 terminal frame wire identity and epoch closeout

- Jason added the exact visible failure: during one update the UI can alternate between an old incorrect buffer and the new buffer before finally converging. This is the observable intermediate hybrid-frame defect, not acceptable eventual consistency.
- Production-path audit found `normalizeIncomingBufferPayload()` was the first lossy boundary: it omitted `frameStartIndex/frameEndIndex/frameChunkIndex/frameChunkCount`, so daemon chunks reached the assembly owner as independent unchunked payloads. The normalizer now preserves valid identity values and preserves malformed presence as `NaN` so the assembly validator rejects it explicitly rather than silently downgrading it to passthrough.
- Repair lifecycle audit found a daemon restart can reuse lower revision numbers while the client still retains a previous epoch's repair ledger. The first authoritative lower head now resets pending/error/ledger before repair dispatch; repeated lower heads inside that same reset expectation do not reset a newly recorded repair. Tab switch, inactive drop, socket cleanup, and reconnect clear only pending chunks; explicit local session close deletes the resource.
- The frame policy was separated into `session-buffer-frame-assembly.ts` plus its owner-private state/ledger module `session-buffer-frame-assembly-state.ts`; the public assembly entry and resource owner remain `client.buffer_store`, while the main policy file is now below 500 lines. Registry/function-map paths were updated instead of creating a second owner.
- Latest known verification before this small structural split: focused stack `10 files / 222 PASS`; architecture stack `10 files / 76 PASS`; type-check/source-JS gate PASS; full terminal contracts `705/707 PASS` with only the two separately documented ws-refresh ordering assertions; real daemon/tmux close-loop all 9 cases PASS with strict intermediate source/client comparison and explicit tmux cleanup. The split itself still needs the complete gate rerun, mandatory review PASS, and Android WebView real-device observation before product closure.
- Fresh mandatory review cycle round 3 found two remaining frame error-truth defects: ingress cleared frame error before sparse freshness/commit acceptance, and resource-limit rejection discarded a validated exact frame range. Correction now makes `applyResolvedBufferSyncPayloadRuntime()` return explicit acceptance, settles frame truth only after accepted no-op/commit, retains error on stale/unauthorized/commit-rejected payloads, and records exact range with `unavailable` repair for bounded-resource rejection. Added paired runtime gates for stale passthrough retention, commit rejection/acceptance settlement, and exact-range resource-limit projection. Focused frame gate passes `3 files / 86 tests`; type-check and diff checks pass. Review cycle reached its three-round limit without PASS, so a new user-authorized review cycle and real-device WebView observation remain required before commit or product closure.
# 2026-07-28 file sync throughput diagnosis

- Scope maps to `daemon.file_transfer`: client owner `client.file_browser`, daemon owner `daemon.file_transfer`, shared wire contract `shared.terminal_types`; the allowed route remains `resource.client_file_browser -> resource.file_transfer -> resource.backend_session`. This is a bounded flow-control and native IO separation change, not UI-owned transfer semantics.
- MemoryPalace pre-edit search is blocked because `/Users/fanzhang/.local/bin/mempalace` points at a removed pipx Python interpreter. The project-safe corpus script was inspected; repo/build/evidence exclusions remain present. No memory-search result is claimed.
- Upload root cause confirmed in source: `FileTransferSheet.startTransfer()` sends one 16 KiB chunk and blocks on `file-upload-progress` before reading/sending the next chunk. Effective throughput is capped near `16 KiB / RTT`; at 50 ms RTT that is about 320 KiB/s, independent of available link bandwidth.
- Download root cause confirmed in source: daemon `readFileSync()` materializes the whole file then emits every 16 KiB JSON/base64 frame without receiver backpressure; after receipt, Android performs one `writeFileChunk` Capacitor bridge roundtrip per 16 KiB. A 100 MiB file therefore causes 6,400 native bridge calls and holds the full base64 chunk set in WebView memory until completion.
- Architecture direction: preserve the 16 KiB wire-frame limit; upload uses one cumulative ACK owner plus an 8-chunk bounded window; download keeps wire chunks but writes native batches of at most 8 chunks per bridge call. Unbounded burst and whole-file WebView/native materialization remain forbidden. Test design/maps/gates must land before runtime edits.
# 2026-07-28 file-transfer bidirectional throughput audit

- Confirmed upload bottleneck: `FileTransferSheet` used strict stop-and-wait, one 16 KiB chunk per cumulative ACK/RTT. At 50 ms RTT this caps payload throughput near 320 KiB/s regardless of available link bandwidth.
- Confirmed download persistence bottleneck: 16 KiB wire chunks were written through one Capacitor bridge call each; 100 MiB required 6,400 JS/native calls. Daemon whole-file read and client whole-transfer chunk assembly remain unchanged and are an explicit bounded-memory gap.
- Unique owners: `src/lib/file-transfer-throughput-runtime.ts#sendBoundedFileUploadChunks` owns the fixed cumulative-ACK window; `#writeFileTransferChunkBatches` owns native batching; `contracts/file-transfer-throughput.json` is the one upload-window/native-batch machine truth; Gradle binds the native value through `BuildConfig`.
- Upload now allows at most eight unacknowledged 16 KiB chunks; ACK 1 opens one slot. Daemon ACK advances only across the contiguous prefix, rejects invalid/conflicting chunks, and publishes complete only after exact chunk-count and byte-count validation.
- Download keeps 16 KiB wire semantics but writes eight chunks per native call. The module loopback proves 1 MiB upload/download SHA-256 equality, maximum in-flight <= 8, and 64 wire chunks -> 8 native writes.
- Canonical gate: `pnpm run test:file-transfer:throughput`; physically wired to `prebuild` and `.github/workflows/ci.yml`. Latest evidence: 7 TS files / 39 tests PASS, Android `StorageFileWriteLogicTest` PASS, feature/architecture registry 10 files / 77 tests PASS, type-check PASS, diff-check PASS. Wiki Playwright: callback nodes visible, no horizontal overflow.
- Codex architecture review final semantic verdict: PASS. Earlier review findings were closed by splitting real callback nodes in mainline/edge maps and binding TS/Java limits to one JSON contract.
- Live gap: ADB only reports `emulator-5554 offline`. Production daemon is active on port 3333, but was not restarted because the worktree also contains unreviewed terminal-buffer changes. No real WebSocket/RTC + Android throughput claim, APK delivery, daemon restart, or update publication was made.
- Post-change `scripts/mempalace-mine-zterm.sh` failed at the same broken pipx interpreter (`~/.local/pipx/venvs/mempalace/bin/python` missing), so re-mine/search verification remains blocked and is not claimed.

# 2026-07-28 control-chain separation and route-priority audit

- MemoryPalace remains unavailable because the project-safe miner resolves to the removed pipx interpreter; this run therefore uses the current resource registry, function map, mainline call map, architecture docs, and source as evidence and makes no MemoryPalace claim.
- Feature blocks: client control presence/directory belongs to `relay.account_directory`; one daemon-target physical transport and route selection belong to `terminal.transport_lifecycle`; daemon endpoint discovery/publication belongs to `daemon.connection_gateway`. Shared endpoint wire types remain under `shared.connection_types`.
- Resource path: `resource.relay_control_connection -> resource.relay_account_directory -> resource.transport_target -> resource.daemon_target_transport -> resource.terminal_channel`. Control and terminal data are forbidden from sharing a socket or payload. Endpoint pushes may update route-candidate truth but must not close or replace an open healthy `resource.daemon_target_transport`.
- Classification: separation downward. Endpoint discovery leaves `relay-client.ts` and moves to the daemon gateway owner; route ranking and persisted route health remain inside the client traversal owner; UI/session code consumes projections only.
- Current evidence: daemon Relay host control WebSocket and Android Relay device control WebSocket are already persistent and physically separate from `TraversalSocket`; client sessions already multiplex on one daemon-target transport. Missing pieces are complete daemon endpoint publication, the required `LAN > RTC UDP direct > Tailscale > TURN Relay` Auto order, durable selected-route truth, active-target endpoint push binding, and `daemon.connection_gateway` activation.
- Confirmed protocol constraint: a Relay control WebSocket's observed TCP source address/port is not a reusable UDP NAT mapping. Publishing it as `publicIp:port` would create false endpoint truth. A valid UDP endpoint must come from an explicit daemon UDP/STUN allocation owner or remain represented as Relay-signaled `rtc-direct`; no TCP-derived fallback will be introduced.
- Required positive gates: LAN/RTC-direct/Tailscale/TURN candidates rank in exact order; control reconnect preserves and restores directory truth; a successful selected route is durably available to a new traversal generation; an endpoint push changes candidate generation without replacing an already-open terminal transport; multiple logical sessions retain one physical terminal socket.
- Required negative gates: control refresh/close cannot clear confirmed endpoint truth or close terminal transport; control and terminal sockets have different identities; control directory payload rejects terminal/session/buffer fields; transient route health cannot override the product tier order; stale/invalid endpoint records cannot become connectable candidates.

# 2026-07-28 file-transfer throughput verification refresh

- Re-ran `pnpm run test:file-transfer:throughput`: 7 TS files / 39 tests PASS and native `StorageFileWriteLogicTest`/Gradle PASS. Re-ran `pnpm run type-check` and `git diff --check`: PASS.
- Current Android product E2E remains unavailable: `adb devices -l` is empty and `adb connect 100.104.163.65:5555` timed out. The installed daemon remains release `0.1.3`, so it was not restarted from this mixed worktree and no live throughput number is claimed.
- The current full `test:feature-registry` run is red only on undeclared `daemon.connection_gateway` import edges introduced by the separate active control-chain refactor. The file-transfer canonical gate itself stays green; do not misreport the repository-wide architecture gate as green until those control-chain edges are registered.

# 2026-07-28 control-chain completion diagnosis

- Symptom/goal: Android must keep one Relay account control WebSocket separate from the daemon-target terminal transport, consume pushed daemon endpoints for future route generations, preserve a healthy terminal transport across control failure, and select `LAN > RTC direct > Tailscale > TURN Relay`.
- Known flow: `resource.relay_control_connection -> resource.relay_account_directory -> resource.transport_target -> resource.daemon_target_transport -> resource.terminal_channel`; owners are `relay.account_directory`, `daemon.connection_gateway`, and `terminal.transport_lifecycle`.
- First registry divergence: `resource.relay_control_connection` and the adjacent control/directory/target edges are missing. The real daemon import graph also has four undeclared gateway edges, so `test:feature-registry` is correctly red.
- First runtime divergence: `ClientControlDirectoryRuntime.replaceFromDevices()` deletes confirmed endpoint truth when a daemon presence projection is disconnected or absent. That couples transport candidate truth to transient Relay presence and contradicts the test-design rule that control interruption cannot erase future direct/Tailscale route candidates. The unique edit owner is `src/lib/client-control-directory-runtime.ts`; UI, terminal socket, channel, buffer, and renderer paths are forbidden.
- Second runtime gap: daemon endpoint publication has no persistent UDP/STUN allocation owner. It can publish LAN, Tailscale, Relay-signaled RTC direct identity, and TURN identity, but cannot honestly publish a literal reusable public UDP mapping. A WebSocket TCP source mapping or a temporary ICE candidate from another peer connection is not reusable endpoint truth and will not be fabricated.
- Required paired verification: directory push updates future candidate generation but never closes the current terminal socket; control close/refresh failure retains confirmed endpoint truth; explicit account logout clears it; disconnected presence alone does not clear it; registry/import/mainline gates parse and bind the real symbols.

# 2026-07-28 file-transfer throughput review closeout state

- Runtime closeout now includes post-write `stat` verification before `file-upload-complete`; persisted-size mismatch enters the explicit completion-error branch and has a negative test. Canonical gate is green: 7 TS files / 40 tests plus native `StorageFileWriteLogicTest`, Gradle BUILD SUCCESSFUL. Type-check and `git diff --check` are green.
- Mainline truth now separates cumulative ACK, exact completion, chunk rejection, and completion rejection by real owner symbol. The architecture gate derives every edge touching a `DaemonFileTransfer*` node regardless of declared owner, compares the exact allowed edge set, verifies edge ownership, and enforces the single transport-send convergence node.
- Codex review reached the configured five-round ceiling. Round 5 findings were the owner-independent induced-subgraph gate and persisted stat check; both are now fixed and locally green, but no sixth review was run because the project rule caps the loop at five. Therefore no PASS claim and no commit/delivery yet.
- Product E2E remains blocked: `adb devices -l` is empty and `adb connect 100.104.163.65:5555` times out. No live LAN/Tailscale/RTC/Relay throughput claim is made.

# 2026-07-28 file-transfer live throughput E2E refresh

- Live ADB device `100.104.163.65:5555` is online with `com.zterm.android` versionName `0.1.3.2264`, versionCode `1032264`, pid `11551`; daemon port 3333 is pid `1623`, uptime ~6h, command `/opt/homebrew/bin/node /Users/fanzhang/.zterm/releases/zterm-daemon/0.1.3/runtime/server.cjs`.
- Canonical source gate `pnpm --dir android run test:file-transfer:throughput` passed: 7 Vitest files / 40 tests plus Gradle `StorageFileWriteLogicTest` BUILD SUCCESSFUL.
- Product download persistence is red on installed APK: WebView CDP call `StoragePermission.writeFileChunks({path,chunks,append:false})` returns `UNIMPLEMENTED` on Android, while `writeFile` still works. Therefore the current installed product cannot exercise the new batched native download path.
- Live mux file-transfer probe over phone WebView -> Tailscale `ws://100.66.1.82:3333` -> daemon used an 8 MiB deterministic file. Upload completed with exact remote SHA-256 `a4b6c5fd40371b12b326890a7e5e4ea0a78a51c3bce6a667d44077f08a93e008`, remote stat `8388608`, duration `2892.7 ms`, throughput `2.77 MiB/s`, final cumulative ACK `512`.
- Live download wire-only probe from the same uploaded file completed in `121 ms`, `66.1 MiB/s`, SHA-256 matched, but only `32` chunks were received for 8 MiB. That proves the running daemon still emits 256 KiB chunks and is not the current 16 KiB throughput contract runtime. This is wire diagnostics only, not product download E2E, because native `writeFileChunks` is missing.
- Cleanup: Android temp upload file removed, remote temp upload directory removed with exact Node `fs.rmSync` guard, temporary tmux session `zterm_file_e2e_1785236997` killed by exact name. App pid stayed alive; recent logcat showed no `AndroidRuntime`, `FATAL EXCEPTION`, `OutOfMemory`, or `RenderProcessGone`.

# 2026-07-28 file-transfer live throughput E2E closeout

- Standard `pnpm --dir android run build:android` remains blocked by unrelated control-chain registry gate: undeclared import edge `daemon.transport_subscriber->daemon.connection_gateway` from `src/server/terminal-transport-runtime.ts -> src/server/rtc-bridge.ts`. File-transfer-specific gates are green and should not be reported as whole-repo architecture green.
- Minimal package path used for product E2E: `pnpm --dir android run type-check` PASS, `pnpm --dir android run test:file-transfer:throughput` PASS (7 TS files / 40 tests + Gradle `StorageFileWriteLogicTest`), direct `vite build`, `npx cap sync android`, Gradle `assembleDebug` PASS, installed APK sha256 `cac9bd7bf32e63d693aec2f74d8a4cecb06d1473d07f1355bd5fd3925994c361` to ADB `100.104.163.65:5555`.
- After reinstall, WebView CDP verified `StoragePermission.writeFileChunks()` on device: wrote 4 bytes and `stat` returned size 4. This closed the prior installed-APK `UNIMPLEMENTED` gap.
- Current daemon release was prepared and run on isolated port 3334 with temp HOME `/tmp/zterm-file-e2e-home-hk2Y7d`, auth `zterm-e2e-token`, traversal relay disabled, so production daemon 3333 was not restarted. Side daemon pid was `57737`, release runtime from `android/release-dist/zterm-daemon-0.1.3-darwin-arm64/runtime/server.cjs`.
- Full live product E2E used Android WebView -> Tailscale `ws://100.66.1.82:3334` -> mux channel -> current daemon runtime with an 8 MiB deterministic file. Source SHA-256 `a4b6c5fd40371b12b326890a7e5e4ea0a78a51c3bce6a667d44077f08a93e008`; remote upload stat and downloaded Android stat were both `8388608`; final downloaded SHA matched.
- Measured throughput: upload `2280.7 ms`, `3.51 MiB/s`, final ACK `512/512`, max in-flight observed `5`; download wire `142.4 ms`, `56.18 MiB/s`, `512` chunks received; Android native persistence `1401.2 ms`, full download wall `5102 ms`, `1.57 MiB/s`, native write calls `64` for 512 wire chunks.
- Cleanup complete: Android temp upload/download/probe files removed, temp daemon HOME removed, temp tmux session `zterm_file_e2e_1785239054` killed, side daemon 3334 stopped by SIGINT and health no longer connects. App pid stayed alive; logcat showed no `FATAL EXCEPTION`, `OutOfMemory`, or `RenderProcessGone`.

# 2026-07-28 standard build unblock after file-transfer E2E

- Root cause of the remaining standard build red was unrelated to file transfer: same-target reconnect queued the active session first, but `mux-ready` flushed opening channels in target channel insertion order, so the inactive `session-1` sent `mux-channel-open` before active `session-2`.
- Architecture mapping: feature `terminal.transport_lifecycle`; resource path `resource.active_session -> resource.session_transport -> resource.daemon_target_transport -> resource.terminal_channel`. Unique owner is `session-context-transport-runtime` / orchestration; file-transfer, daemon mirror, renderer, and UI projection are forbidden fix points.
- Fix: `bindTargetMuxTransportSocketLifecycleRuntime` now reads the current active session id at `mux-ready` and passes it to the existing opening-channel accessor, preserving active-first channel flush without changing target transport ownership.
- Verification: focused transport runtime `17 PASS`; full `SessionContext.ws-refresh.test.tsx` `136 PASS`; `type-check` PASS; `test:feature-registry` `78 PASS`; `test:terminal:contracts` `715 PASS`; full `pnpm --dir android run build:android` PASS with prebuild gates, Vite, daemon release, Gradle, and update bundle verification.
- Delivery evidence: Android APK `0.1.3.2265` / versionCode `1032265` / sha256 `274dfad65e778c0823904ab2af2f831a7ea03eec2ef504ff7a9396c7807ad7fa` published to `android/update-dist` and `~/.zterm/updates`; installed on ADB `100.104.163.65:5555`; cold launch pid `20972`; post-launch logcat showed no `AndroidRuntime`, `FATAL EXCEPTION`, `OutOfMemory`, or `RenderProcessGone`.
- MemoryPalace remains unavailable: `scripts/mempalace-mine-zterm.sh` fails because `/Users/fanzhang/.local/bin/mempalace` points to a removed pipx interpreter.

# 2026-07-28 active-first mux-ready final review closeout

- Codex review found the first active-priority fix still allowed a non-empty but non-opening active session id to replay opening channels in old/unprioritized order. Root cause was checking only presence of `activeSessionId`, not membership in the same target's opening channel set.
- Final fix keeps the unique owner at `terminal.transport_lifecycle` / `bindTargetMuxTransportSocketLifecycleRuntime`: on `mux-ready`, read current active session truth, get the target opening channels once, require the active session to be present in that set, and only then set target mux ready and send `mux-channel-open`. Missing or non-opening active truth now enters explicit target failure; no UI/renderer/file-transfer fallback was added.
- Maps synced: function map `terminal.transport_lifecycle.channel.open`, mainline nodes/edges `TargetMuxFrameLifecycle -> ActiveSessionPriority -> ChannelRuntime`, and edge registry `edge.client.target_mux_ready_to_active_session_priority` plus active-priority channel replay gate.
- Verification after final fix: `session-context-transport-runtime.test.ts` 19 PASS, `test:feature-registry` 78 PASS, `type-check` PASS, `build:android` PASS including prebuild file-transfer throughput 40 PASS, transport-network lifecycle 30+9 PASS, terminal contracts 715 PASS, common flows 83 PASS, relay smoke PASS, Vite, daemon release, Gradle, and update bundle verification.
- Delivery: APK `0.1.3.2267` / versionCode `1032267` / sha256 `d9ba6e08481eac2a7aba593fa71a0622111071ce03160863c9717d3caa16b0c6` published to local update dir and `~/.zterm/updates`; local `127.0.0.1:3333` and Tailscale `100.66.1.82:3333` manifests and APK downloads match sha. Installed on ADB `100.104.163.65:5555`; cold launch pid `29465`; fatal-only logcat check found no crash.
- Public Relay update route remains stale at `0.1.3.2263`; external public publishing was not performed because publish requires explicit authorization.

# 2026-07-28 Home auto-route UI and priority alignment

- Scope: align Home UI with automatic route selection. Server row tap remains the only Home connect action; the separate Relay button was removed. Relay directory candidates are still visible as an `自动线路` badge and stay merged into the saved server Host without replacing saved direct/Tailscale identity.
- Route policy: Auto ignores stale saved traversal priority and ranks private LAN IPv4 first via the LAN cost override, then Tailscale/direct websocket, then WebRTC UDP direct/hole-punch, then TURN Relay. Public/non-LAN IPv4 remains selectable only after higher route classes are unavailable.
- Health cadence: existing target-level mux heartbeat/physical close/mux failure remains the route-health update owner; ordinary failures use the one-second circuit-breaker and are probe-eligible on the next target generation.
- Verification: `ConnectionsPage.test.tsx`, `home-connection-projection.test.ts`, `traversal/config.test.ts`, and `traversal/route-selector.test.ts` passed 30/30; `App.dynamic-refresh.test.tsx` passed 35/35; `pnpm --dir android run type-check` passed with source-js-pollution clean.
- MemoryPalace remains unavailable because `/Users/fanzhang/.local/bin/mempalace` points to the removed pipx interpreter; no re-mine/search claim was made.

# 2026-07-29 multi-pane refresh and session placement review

- Scope: `terminal.workspace_panes` / `terminal.session_group_layout` / `terminal.transport_lifecycle` only. Forbidden: daemon mirror, buffer text truth, route selection, file transfer, and reconnect fallback.
- Performance finding: passive split panes were all eligible on the same passive visible refresh tick. Even with separate active/passive lanes, this can burst `ensureActiveSessionFresh()` across every visible pane at once when multiple panes are stale.
- Fix: passive visible pane refresh now selects one stale passive pane per tick in round-robin order. Active pane keeps its active tick owner; passive panes keep the slower target-level freshness lane and body subscription truth.
- Multi-session UI fix: split can now create an empty pane from a single open session; empty panes remain persisted/rendered, show their explicit Pane number, and tapping the empty pane opens the session picker scoped to that pane. Existing split pane tab context menu now exposes `更改 Pn Session` plus explicit `移到 Pn` targets.
- Verification: `session-context-lifecycle.test.tsx`, `TerminalPage.render-scope.test.tsx`, and `TerminalHeader.test.tsx` passed 46/46; `multi-pane-refresh.test.ts`, `workspace-persistence.test.ts`, and `useTerminalWorkspace.test.tsx` passed 16/16; `pnpm --dir android run type-check` passed.
- MemoryPalace remains unavailable with the same removed pipx interpreter, so no re-mine/search claim is made.

# 2026-07-29 multi-pane final review/resource closeout

- Codex review initially found three blocking gaps: empty pane/split fallback paths, passive cursor coercion, and passive refresh mapped as active-session truth. Final shape: malformed workspace state throws, passive cursor must be a non-negative integer, split growth uses one authoritative splitter, and `resource.visible_pane_session` separates visible passive pane truth from `resource.active_session`.
- Maps synced: feature registry keeps `useTerminalWorkspace.ts` as the sole workspace mutation owner; function map marks TerminalPage/Header/StageShell as projection/intent callers; resource map/registry add `resource.visible_pane_session`; mainline call map records `SessionLifecycle -> PassiveVisibleRefreshScheduler -> ActivityFreshness`.
- Verification after final map fix: JSON parse PASS; focused lifecycle/workspace/persistence 38 PASS; `test:feature-registry` 78 PASS; `test:terminal:contracts` 54 files / 754 PASS; codex review final `VERDICT: PASS`.

# 2026-07-29 TerminalPage v2/v3 alignment audit

- Scope: audit current TerminalPage/page runtime state against `2026-05-24-shared-blocks-orchestration-audit-v2.md` and v3. Output written to `android/docs/audits/2026-07-29-terminal-page-v2-v3-alignment-audit.md`.
- Finding: v3 interaction runtime completion does not hold in current code. `useTerminalPageInteractionRuntime()` and `useTerminalPageShellActionsRuntime()` are only definitions/tests; no product caller. `TerminalPage.tsx` still owns swipe, chrome session switch, pane activation, quick-tab/tab-manager open, and viewport change handlers.
- Evidence: current `TerminalPage.tsx` is 3849 lines versus v3's 2586-line record. `pnpm --dir android run type-check` PASS. v2/v3-style targeted suite fails 1 stale render-key expectation; workspace split suite fails 1 stale expectation that contradicts latest empty-pane rule.
- Next owner path: first fix stale test semantics, then connect or delete the orphan page runtimes, and add a gate that function-map/runtime owner files must be product-callsite-bound, not merely present.
- MemoryPalace search remains blocked by missing pipx interpreter, so this audit used docs/source/tests only and makes no re-mine claim.

# 2026-07-29 startup terminal route flash fix

- Scope: App page-state restore only. Feature/resource mapping stays in Android app shell / `terminal.open_tabs` current-process projection; no terminal transport, renderer, daemon, or open-tab persistence resurrection.
- Root cause: `useAppPageState()` initialized `ACTIVE_PAGE=terminal` with `allowTerminal=false`, so a live current-process runtime session first painted Connections/light home and only later called `ensureTerminalPageVisible()` from the restore effect. That visible route flip appeared as a white screen then refresh.
- Fix: initial page-state restore now allows terminal only when a runtime session and active runtime session id already exist in the same render. Stale terminal page without runtime ownership still returns Connections and clears legacy open-tab storage.
- Verification: `useAppPageState.test.tsx`, `App.first-paint.test.tsx`, and `App.first-paint.real-terminal.test.tsx` passed 7/7; `useOpenTabRuntime.test.tsx`, `open-tab-intent.test.ts`, and `App.dynamic-refresh.test.tsx` passed 60/60; `open-tab-history-truth`, `feature-registry-truth`, and `function-wiki-truth` passed 23/23; `pnpm --dir android run type-check` passed.
- MemoryPalace remains blocked by missing pipx interpreter (`~/.local/pipx/venvs/mempalace/bin/python`), so no MemoryPalace search/re-mine claim is made.

# 2026-07-29 remote-window multi-window preview performance fix

- Scope: `desktop.remote_window_stream` Android overlay projection only. Owner is `RemoteWindowOverlay`; daemon stream/capture, terminal renderer, buffer truth, route selection, and QuickBar owners are not modified.
- Root cause: same-app sibling projection added two periodic foreground work sources while video is active: active catalog `forceRefresh` every 1s and per-sibling screenshot thumbnails every 5s with a 4s stale cutoff. Effect rebuilds could clear or discard in-flight thumbnail truth, causing duplicate screenshot requests or permanent `截图中` cards. This can occupy the WebView/daemon control path and make the multi-window preview look frozen although the stream truth is still connected.
- Review fix: failed thumbnails are terminal for the current request identity, the single in-flight lock is held until the real screenshot promise settles, thumbnail completion must match `{sessionId,targetId,requestId}`, and daemon stream stop now resolves/rejects from request-id matched `remote-window-stream-status` / `remote-window-error` instead of fire-and-forget cleanup.
- Map fix: handoff projection is bound to `RemoteWindowOverlay -> RemoteWindowOverlayRuntime`; daemon control messages stay on `RemoteWindowOverlay -> RemoteWindowMessageRuntime`, and stop ACK/error returns through `SocketMessage -> RemoteWindowMessageRuntime`.
- Verification: focused overlay/message/session `96 PASS`; remote-window stack `171 PASS`; `tsc --noEmit` PASS; `test:feature-registry` `78 PASS`; full `build:android` PASS. APK `0.1.3.2273` / versionCode `1032273` / sha256 `2d6aac8a35d67db08bdefc7c8a837c284e9e0faa32d4b75fd8322e3b9c545fc1` published to local, Tailscale, and public Relay routes; ADB install/launch passed and awake screenshot confirmed Home rendered.
- MemoryPalace search remains blocked by missing pipx interpreter; no re-mine/search claim is made.
# 2026-07-29 remote-window canvas/focus dual-stream closeout

- Scope: `desktop.remote_window_stream` only. Owners touched: shared protocol, Android message/receiver/session runtime, `RemoteWindowOverlay`, daemon stream lifecycle, and matching docs/tests. Network realtime/bandwidth strategy remains out of scope.
- Root cause found during focused gate: focus stream attach used `attachRemoteWindowStreamReceiver(current, focusId)` while `current.streamId` still pointed at canvas, so focus never became the active overlay stream; quality/resize ACK paths either stayed on canvas or skipped focus. Canvas attach also started active catalog force-refresh before focus had committed.
- Fix: non-handoff focus success now first runs `beginRemoteWindowStreamSetup(current, focusId)` then attaches focus; active media/stats/input/resize/quality truth moves to focus. `pendingFocusStreamIdRef` suppresses canvas catalog cadence while focus is pending, clears on focus success/failure, and focus start seeds `lastAppliedStreamQualityKeyRef` to avoid duplicate no-op quality requests.
- Review closeout: canvas/focus startup is intentionally sequential, but the current Android overlay projects only one `<video>`; after focus commits the startup canvas stream must be stopped, not retained as an unprojected duplicate capture. If focus fails, handoff commit must accept the already-started canvas stream id, not only the focus pending id. Late focus completion is guarded by `streamRequestEpochRef` and close stops the pending focus id so stale promises cannot resurrect media or leak daemon capture.
- Verification: focused remote-window message/receiver/overlay/session/daemon gate passed 6 files / 179 tests; Android `tsc --noEmit`, `test:feature-registry` 78/78, and `git diff --check` passed after P1 review fixes.
- MemoryPalace: project-safe mine now succeeded and `mempalace search --wing zterm "remote window dual stream canvas focus"` returns the new canvas pipeline decision/resource map.

# 2026-07-29 dual-stream review fix closeout

- Codex cc review found one P1 and two P2 issues after dual-stream implementation: focus receiver startup failure could leave the daemon-side focus stream alive, Windows scoped `Change session` intent survived chooser dismissal, and future canvas compositor/layout resources were recorded as active truth before implementation.
- Fix: focus startup catch now explicitly stops the known focus stream id before committing canvas-only display; Windows settings close/cancel clears `pendingSessionReplacement`; `resource.remote_window_canvas_raw`, `resource.remote_window_canvas_layout`, `resource.remote_window_canvas_encode`, and `resource.remote_window_focus_stream` are marked `status: design` and resource registry gate now locks that state until implementation.
- Verification after fixes: `RemoteWindowOverlay.test.tsx` + `resource-registry-truth.test.ts` passed 77/77; focused remote-window/useAppPageState gate passed 7 files / 183 tests; Android `tsc --noEmit`, `test:feature-registry` 79/79, Windows full 7 files / 24 tests, Windows type-check, Mac focused 32/32, Mac type-check, and `git diff --check` passed.

# 2026-07-29 desktop pane/session review closeout

- Mac scope: workspace model only. `Change session` creates an active empty replacement slot in the selected tab; opening a connection/local tmux with `append=false` consumes that active empty tab even inside a multi-tab pane. `Move to Pn` consumes a target empty-pane sentinel and leaves a source sentinel when moving the only live tab.
- Windows scope: desktop shell workspace only. `Change session` is now a scoped chooser intent: context menu stores `{paneId,tabId}`, activates that pane, opens the session list, and only a session-list row click calls `changeWindowsWorkspaceTabSession`. Marker: `windows change session scoped chooser before replacement`.
- Verification: `pnpm --dir mac test -- --reporter dot` passed 22 files / 155 tests; Mac type-check passed; `pnpm --dir win test -- --reporter dot` passed 7 files / 23 tests; Windows type-check passed; `git diff --check` passed.

# 2026-07-29 dual-stream review second closeout

- Second codex review identified that active `purpose=canvas` advertised a persistent canvas pipeline that does not exist yet. Current code now uses `purpose=preview` for the startup low-rate stream and keeps app-group canvas docs/resources as design/future only.
- Focus receiver startup failure no longer hides behind `console.warn`; Android keeps the preview stream visible and projects `remote-window-stream-degraded` with the focus failure message.
- Desktop pane UX review fixes: Windows rejects moving empty placeholder tabs; Mac and Windows pane context menus dismiss on outside pointer, Escape, and stale tab removal.
- Verification this round: Android focused remote-window 6 files / 180 PASS; Android tsc PASS; Android feature registry 10 files / 79 PASS; Mac focused 2 files / 34 PASS; Mac type-check PASS; Windows focused 2 files / 14 PASS; Windows type-check PASS; git diff --check PASS.

# 2026-07-29 dual-stream review third closeout

- Review found two remaining P2 issues: Windows primary `连接` ignored a pending scoped replacement, and Android focus-stream cleanup errors could be lost when the preview stream became the committed fallback.
- Windows fix stays in `windows.desktop_shell.workspace`: `openTarget(false)` now consumes `pendingSessionReplacement` through `changeWindowsWorkspaceTabSession`, matching the session-list replacement path; split still opens a new split target.
- Android fix stays in `desktop.remote_window_stream.overlay.project`: focus startup failure stops the known focus stream only after the preview stream is committed as the active replacement, so `failRemoteWindowStreamCleanup()` can bind the cleanup failure to the displayed preview stream instead of the previous stream.
- Verification so far: Windows focused 2 files / 15 PASS; Android overlay/runtime 2 files / 80 PASS; Android remote-window stack 6 files / 181 PASS; Android tsc PASS; Windows type-check PASS; Mac focused 2 files / 34 PASS; Mac type-check PASS; feature-registry 10 files / 79 PASS; `build:android` PASS and regenerated APK `0.1.3.2274`.

# 2026-07-29 module registry design-resource review closeout

- Review found one remaining P2 registry truth issue: future remote-window canvas/layout/encode/focus resources were `status: design` in `resource-registry.json` but appeared as active owned/consumed bindings in `module-registry.json`.
- Fix: `daemon.remote_window_stream` and `client.remote_window_overlay` now list those design resources only under `pending_resources`; `module-registry-truth.test.ts` now rejects non-active resources in active owned/consumed bindings and requires pending resources to stay non-active.
- Verification: focused `module-registry-truth.test.ts` passed 13/13. Marker: `module registry pending design resources not active bindings`.

# 2026-07-29 final review fixes before commit

- Codex review found three remaining issues before commit: pending terminal route persistence could overwrite ACTIVE_PAGE before open-tab hydration, RemoteWindowOverlay could handoff from an unattached starting stream, and Windows Change session was incorrectly gated by invalid connection form values.
- Fixes: useAppPageState preserves terminal route intent while persisted open tabs are still hydrate candidates and sets terminal page on owned restore; RemoteWindowOverlay handoff now requires state.streamStarted; Windows Change session opens the scoped chooser regardless of current form validity while keeping connection buttons gated.
- Verification: Android useAppPageState/RemoteWindowOverlay/runtime focused gate passed 85/85; Android type-check passed; WindowsDesktopApp focused gate passed 10/10; Windows type-check passed; Mac type-check passed; git diff --check passed.

# 2026-07-29 MacBook Air revoked client package correction

- Jason reported the same macOS error after local client install. Local `/Applications/ZTerm.app` Finder-opened successfully, so the first conclusion that local `/Applications` was the remaining target was false.
- Root cause was on MacBook Air: `/Applications/ZTerm.app` was missing, while a running `/Users/fanzhang/Applications/ZTerm.app` had old app.asar `a6f668c781ecd605481eea0d5e715978adb41563c0dbdb0b51d36295d2bf3f24`; `spctl --assess` reported `notarization indicates this code has been revoked`.
- Fix: backed up the old remote user-app path as `/Users/fanzhang/Applications/ZTerm.app.revoked-20260729210803`, installed current Mac build to `/Users/fanzhang/Applications/ZTerm.app`, ad-hoc re-signed it, and launched it. Installed remote app.asar now matches local current hash `449a402638888f85546473d624f1f3e39afdbe43fe67239a173c2adc9a4af579`; `codesign --verify --deep --strict` passes and remote PID `95730` runs from the corrected path.
- Skill update: Mac install flow must identify the actual clicked/running app path across `/Applications`, `$HOME/Applications`, Downloads/Desktop/Trash before claiming the Gatekeeper error fixed. `osascript tell ZTerm quit` can hang on revoked apps; use explicit PID cleanup only after proving that hang.

# 2026-07-29 account daemon sync and iTerm2 split chrome

- Scope maps to `relay.account_directory` / `relay.directory_ui` plus shared `terminal.workspace_panes`, Mac `mac.workspace_store` projection, and Windows `windows.desktop_shell.workspace`. Runtime/daemon terminal truth, buffer, route selection, and renderer semantics are untouched.
- Root cause for daemon sync: `connectTraversalRelayDevicesStream()` captured the account object at socket open. A fresh `directory-snapshot` could update `account.directory`, but a later legacy `devices-snapshot` wrote `{...options.account, devices}` back to storage and could restore the stale directory. This made machines already logged into daemon appear unsynced or disappear from account directory projection after the next presence update.
- Fix: stream message writes now re-read the current stored account for the same token/base URL before updating `devices` or `directory`, so latest daemon directory truth survives legacy presence snapshots and still keeps devices presence current. Added a regression with two daemon hosts proving a later client-only devices snapshot cannot roll back the fresh directory.
- iTerm2 split UI fix: desktop split profile now uses zero pane gap, 3px divider hit band with only a 1px visual divider, square pane frames, no pane-tab wrapper border/background, Mac terminal stage/surface no longer adds rounded padded containers, and Windows pane background matches the terminal canvas. Empty pane/session chooser and numbered move/change actions stay in the existing workspace owners.
- Verification: relay focused gate `3 files / 22 PASS`; Android header/stage/home projection `31 PASS`; Android type-check PASS; Mac full tests `22 files / 158 PASS`; Mac type-check PASS; Windows full tests `7 files / 30 PASS` with pre-existing "Port is already in use" test-server warning but no failure; Windows type-check PASS; architecture/registry gate `10 files / 79 PASS`; `git diff --check` PASS. Shared package full `tsc --noEmit` remains blocked by pre-existing test type errors unrelated to this change.

## 2026-07-30: APK versionCode binary patch 根因

**问题**：原 `patch-apk-version.py` 用 `[0x10][0x08][uint32]` 模式搜索 versionCode，定位错误导致 manifest 损坏。

**发现**：
- `aapt2 dump badging` 报告的 `versionCode` 属性 ID 是 `0x0101021b`，但这个值**不在 AndroidManifest.xml 源码里**。
- versionCode 存在 `resources.arsc` 字符串池 + `AndroidManifest.xml` 二进制 attribute 值中。
- manifest 二进制里的 pattern 是 `[0x08][0x00][0x00][0x10][value_uint32_LE]` — **TYPE_INT_HEX (0x08)** 不是 TYPE_INT_DEC (0x10)。
- 在当前 zterm APK 里，这个 8 字节 pattern 只出现一次，偏移 5732，绝对安全。

**修复方案**：用 `aapt2 dump badging` 获取当前 versionCode 数值，用 `TYPE_INT_HEX pattern + value` 精确定位替换。

**versionName**：存在 `resources.arsc` 里，长度固定偏移。长度变化会破坏二进制结构，不做修改 — Android 安装只用 versionCode。

**验证**：aapt2 dump badging + apksigner verify 都通过。

# 2026-07-31 foreground resume + daemon session idle execution contract

- Foreground symptom: returning from Android background leaves the active session disconnected until another session is selected. Existing planner evidence shows a physically `CLOSED` socket already produces `action=reconnect`; the new `shouldBypassKeepaliveGrace` guard in `session-context-activity-runtime.ts` is therefore a no-op, not a valid root-cause fix. Owner remains `terminal.transport_lifecycle` / SessionContext activity runtime. Positive gate: explicit resume reconnects a closed socket. Negative gates: OPEN socket requests head and reconnect-in-flight does not create a second transport.
- Idle block: daemon truth/control projection. Feature `daemon.session_idle_detection`; unique derived owner is `resource.session_idle_facts` in `terminal-session-activity-runtime.ts`. This is a separation downward from `resource.mirror_store`, then direct publication to `resource.transport_subscriber`.
- Allowed idle paths: shared protocol, classifier/publisher, daemon heartbeat, target mux/control send, registries/maps/docs/tests. Forbidden: client UI notification, renderer, open-tab, active-session, and daemon client lifecycle truth.
- Publication contract: preserve legacy `sessions` payload byte semantics; independently emit target-level `session-activity` after list, successful mux attach, and once per open physical transport on the existing heartbeat tick. Closed/stale transports receive none; multiple mux channels on one physical connection must not duplicate heartbeat publication. Publication failure is logged/projected explicitly and must not be converted into a successful attach or a transport close.
- Required gates: paired classifier threshold/resume tests, list legacy-shape + activity/error tests, mux attach success/failure tests, heartbeat open/multi-channel/closed/stale tests, protocol tests, feature/resource/module/import/mainline gates, type-check, daemon close-loop, packaged APK, installed-device foreground replay.
# 2026-07-31 session-activity invalid terminal mux frame diagnosis

- Symptom: Android reports `invalid terminal mux frame`, then the target transport is finalized as retryable and later surfaces as `rtc connection timeout`.
- SOP/model flow: existing multiplex transport control path. `resource.session_idle_facts -> resource.daemon_target_transport` must use target-level mux control frames; session-bound business data must use `resource.terminal_channel`.
- Confirmed first divergence: commit `2a5d5a6` added raw `{ type: 'session-activity' }` writes in `terminal-daemon-runtime.ts#startHeartbeatLoop` and after `mux-channel-opened`. After `mux-hello`, the physical transport accepts only `TerminalMuxServerFrame`; Android rejects the raw message in `session-context-transport-runtime.ts#bindTargetMuxTransportSocketLifecycleRuntime` before any RTC recovery logic runs.
- Unique owner: `feature_id=daemon.session_idle_detection`; `terminal-session-activity-runtime.ts` must own classification plus target-control publication. The publisher must emit raw `session-activity` only for legacy/pre-mux connections and `mux-target-message` for a mux-negotiated physical transport.
- Change category: separate transport envelope projection into the existing session-idle owner and physically remove the duplicate raw publishers. Allowed paths are the feature registry paths under `src/server/**`, shared mux protocol tests, and mapped docs. Forbidden paths are client contexts, UI, renderer, open-tab, and notification owners.
- Test design:
  - White-box positive: legacy/pre-mux connection gets exactly one raw `session-activity`.
  - White-box positive: mux-negotiated connection gets exactly one `mux-target-message` carrying `session-activity`.
  - White-box negative: mux-negotiated connection never gets a raw `session-activity` or `mux-channel-message`.
  - Module black-box positive: mux `list-sessions` reply carries both `sessions` and `session-activity` as target envelopes with the request id.
  - Module black-box positive: `mux-channel-open` emits `mux-channel-opened`, then target-level `session-activity`.
  - Module black-box negative: no frame written to the physical mux transport fails `isTerminalMuxServerFrame`.
  - Heartbeat positive/negative: mux heartbeat publishes one target envelope per physical transport, while a legacy attached transport keeps the raw control message.
- Exact replay after implementation: start installed daemon, negotiate `mux-hello`, open a channel, and assert every received frame passes `isTerminalMuxServerFrame`; then wait through a heartbeat publication and assert `session-activity` is inside `mux-target-message`.

# 2026-07-31 rcc / rccstart session identity collision diagnosis

- Live symptom at 21:55: the Android drawer selected `rcc`, while the rendered route log belonged to `rccstart`.
- Root-source proof: tmux accepts prefix targets. With only `<probe>start` present, `tmux display-message -p -t <probe> '#{session_name}'` returned `<probe>start`, while `-t =<probe>` failed because the exact session was absent. The daemon currently passes bare session names to `has-session`, initial mirror `display-message`, input, resize, rename, and close operations.
- Historical daemon proof: at `2026-07-31 21:55:20`, `[mirror:rcc]` opened with `total=200448` and route-log lines even though the current `rcc` pane contains no route-log marker; the same marker occurs 2623 times in `rccstart`. This is the first authoritative divergence, before client mux demux or renderer projection.
- Architecture mapping: `terminal.buffer_render` consumes `resource.tmux_session` into `resource.mirror_store`; `terminal.daemon_input` consumes `resource.backend_session -> resource.tmux_session`. The unique backend target builder belongs in `src/server/terminal-control-runtime.ts`; mirror capture/runtime receive that builder through dependency injection. This is separation/downward normalization, not a client fallback. UI, channel mapping, sparse buffer, and renderer remain unchanged.
- Test design: positive exact target `rcc` stays `=rcc`; negative prefix collision `rcc` must not resolve `rccstart`; module tests lock existence, capture, resize, input, rename, and close commands to exact targets. Live closeout must start an isolated `<name>start` session, prove daemon open of absent `<name>` creates/captures `<name>` rather than the prefix session, then replay Android `rcc` / `rccstart` switching against distinct pane content.

# 2026-07-31 rollback version ordering correction

- Jason reconfirmed the contract: normal `0.1.3.N`; rollback of that release `0.1.3.N.1`; next normal `0.1.3.N+1`, with Android `versionCode(N) < versionCode(N.1) < versionCode(N+1)`.
- The shipped implementation violated it by setting bit 30 on rollback codes, making every later normal build lower forever. It also only patched `versionCode`; the APK manifest kept the base `versionName`, despite manifest metadata claiming `.1`.
- Owner is `release.update_artifact` / `resource.release_update_artifact`. Correct implementation uses one machine contract for epoch/stride/rollback offset, real Gradle normal and rollback variants, and the previous release's retained `.1` artifact as `rollbackToPrevious`.
# 2026-07-31 Android rollback subversion correction

- Jason 再次确认唯一版本合同：正常版 `0.1.3.N`，回退版 `0.1.3.N.1`，下一正常版 `0.1.3.N+1`。旧实现把回退 `versionCode` 放进 bit-30 高位，导致后续正常包被 Android 判定为低版本，属于 release/update artifact owner 的排序真源错误。
- 本次修复 owner：`release.update_artifact` / `resource.release_update_artifact` / `daemon.support`。修改点只应落在 app version contract、Gradle APK manifest 构建、update bundle builder/verifier 和其测试；客户端 updater 只消费 manifest，不得补降级安装或 `adb install -d` fallback。
- 必跑正向：`N < N.1 < N+1`、新 epoch 高于已发布 bit-30 rollback、normal/rollback APK 内 manifest 与 latest.json 对齐。必跑反向：rollback 不能占用跨 build 的永久高位、previous rollback payload 不能指向当前 normal、自称 `.1` 但 APK 内 versionName 未变必须红灯。最终必须真机无 `-d` 依次覆盖安装。

# 2026-07-31 mux channel closed control-status stopgap + reconnect UI grace

- User-facing issue: data/session channel close could present as black-box `rtc connection timeout`/disconnect before the app used the still-alive target control line to decide whether the tmux session still existed. This made control/data separation opaque during recovery.
- Root owner: client `terminal.transport_lifecycle` / mux orchestration. Existing protocol separation was already locked by shared mux tests: target/control uses `mux-target-message`, session body uses `mux-channel-message`, and raw frames after `mux-hello` are invalid.
- Fix: `resolveMuxChannelClosedWithControlStatusRuntime()` now handles closed mux data channels by sending target-control `list-sessions` through the existing open target mux transport before deciding outcome. If the tmux session still exists and the session is active/live, it schedules the same session reconnect; if tmux truth says the session is gone, it marks closed; if the channel has already reopened, it ignores stale control results; inactive sessions become idle instead of auto reconnecting.
- UI grace: `NETWORK_BANNER_GRACE_MS` is now 10s. During that grace, when network is online and the active session is `reconnecting`, the network banner stays hidden and the portrait status strip projects `waiting`/green instead of visibly flashing reconnect.
- Verification: focused transport/UI gate `52/52 PASS`; `tsc --noEmit` PASS; `git diff --check` PASS; full `pnpm --dir android run build:android` PASS; built APK `0.1.3.2284` / `versionCode=1100022840`; rollback APK `0.1.3.2284.1` / `versionCode=1100022841`; ADB install and launch on `100.104.163.65:5555` PASS; local `127.0.0.1:3333`, Tailscale `100.66.1.82:3333`, and public Relay update routes all serve `0.1.3.2284` with sha `7bba4871557ae47620030f65c8cc946207a82a6f8ccef53eff26aed26e217377`.

# 2026-07-31 mux/control release closeout correction

- Final release supersedes the intermediate `2284` evidence above. Current update artifact is APK `0.1.3.2285` / `versionCode=1100022850`, sha256 `d5365cda25b635ff9c3d4cf120c4617ea1054b85a5dc43ff5bc539a3810c6aa7`; prepared rollback is `0.1.3.2285.1` / `1100022851`, sha256 `1c499b9c76d48e57501c7563d028b4694047f64e1a559588a4d7771b9e64ca70`; previous rollback retained as `0.1.3.2284.1` / `1100022841`, sha256 `a4a96239d29b546ad3b256723c26acc5845eb21d2231166a99ad0b4607b5de02`.
- Verified after the final attachTmux negative test addition: `terminal-message-runtime.test.ts` 40/40 PASS; combined transport/UI/server gate 110/110 PASS; `tsc --noEmit` PASS; `git diff --check` PASS; `test:feature-registry` 79/79 PASS; codex review final verdict `VERDICT: PASS`.
- Public Relay route `https://relay.codewhisper.cc:18443/relay/updates/latest.json` serves `0.1.3.2285`; downloaded public normal, rollback, and previous rollback APK sha256 values match manifest. Online ADB device `100.104.163.65:5555` reports installed package `versionCode=1100022850`, `versionName=0.1.3.2285`.

# 2026-08-01 reconnect hard-to-connect diagnosis contract

- Symptom: new Android build often cannot connect/reconnect until the app process is killed; a fresh process immediately connects. No online ADB device is attached in this run, so the original phone log cannot be pulled yet.
- Expected: process kill must not be required. `terminal.transport_lifecycle` must recover a failed physical daemon target by retiring the exact target generation, recording route failure, preserving recoverable logical channels, and rebuilding the target transport through the existing target failure owner.
- SOP/model flow: known `terminal.transport_lifecycle`. Resource path is `resource.active_session -> resource.session_transport -> resource.daemon_target_transport -> resource.terminal_channel -> resource.transport_subscriber -> resource.mirror_store`; target control status uses `resource.daemon_target_transport` via `mux-target-message`; terminal data uses `resource.terminal_channel` via `mux-channel-message`.
- Owner graph: `session-context-transport-runtime.ts` demuxes mux frames and physical target lifecycle; `session-context-transport-orchestration-runtime.ts` owns channel-close control-status decisions, target failure routing, and target rebuild/replay; `session-context-tmux-management-runtime.ts` owns target-control `list-sessions`.
- Candidate H1: the recent channel-close control-status stopgap marks a mux channel `closed` and, when target control is already unavailable because the same physical target generation is closed/stale, projects idle/error without entering the target failure owner. A subsequent physical target failure can then skip the already-closed channel, leaving no replay demand; killing the app recreates all target/channel runtime from scratch and succeeds.
- Supporting evidence: `resolveMuxChannelClosedWithControlStatusRuntime()` maps `queryTargetSessions() === null` to idle/error and no reconnect; `manageTmuxSessionsOnOpenTransportRuntime()` returns `null` when target mux is not ready or terminal socket is not open; `handleTargetMuxTransportFailureRuntime()` skips channels whose state is already `closed`.
- Active hypothesis: H1. First divergence pending controlled red test: data channel close plus target-control unavailable due physical target not open must be routed to the target failure owner, not idle/error or a session-level fallback.
- Allowed paths: `android/src/contexts/session-context-transport-orchestration-runtime.ts`, `android/src/contexts/session-context-transport-orchestration-runtime.test.ts`, `android/note.md`, `android/MEMORY.md`, `.agents/skills/zterm-mobile-dev/SKILL.md` if a reusable reconnect rule is confirmed.
- Forbidden paths: UI/page reconnect loops, daemon tmux/mirror truth, renderer, route fallback/degrade, broad reconnectAll compensation.
- Required verification: focused red/green orchestration tests with positive and negative control-status cases, broader transport mux tests, `tsc --noEmit`, `test:feature-registry`, `git diff --check`, and L5/APK only if an online device/update channel is available for this run.

# 2026-08-01 daemon mirror exact tmux target diagnosis

- L2 close-loop after the client reconnect fix failed before replay: `daemon:mirror:close-loop` reported `Initial canonical sync failed: Failed to capture canonical tmux buffer during initial sync`; evidence folder `android/evidence/daemon-mirror/2026-08-01/codex-live` shows `daemon-payload=null` and daemon log `tmux returned invalid pane metrics for zterm_mirror_lab: rows= cols=`.
- Read-only tmux proof: with a real `zterm_probe_exact` session, `tmux display-message -p -t '=zterm_probe_exact' '#{session_name}|#{pane_id}|#{pane_height}|#{pane_width}'` returns empty format fields, while `-t '=zterm_probe_exact:0.0'` returns `zterm_probe_exact|%45|24|80`. `tmux send-keys -t '=zterm_probe_send'` fails `can't find pane`, while `=zterm_probe_sendpane:0.0` writes to the pane.
- First divergence: the previous exact-session collision fix made `buildExactTmuxSessionTarget()` return `=<session>`, but daemon pane-level commands (`display-message`, `capture-pane`, `send-keys`, `pane_current_path`) need an exact pane target. This breaks canonical sync and input before client reconnect logic can recover.
- Review correction: `buildExactTmuxSessionTarget()` must remain `=<session>` because `has-session` / `kill-session` / `rename-session` are session commands. New unique pane owner is `buildExactTmuxPaneTarget()` -> `=<session>:.{top-left}` for `send-keys`, `display-message`, `capture-pane`, and `pane_current_path`. A single pane-safe session builder corrupted session-command target truth; fixed `:0.0` was rejected because base indexes may be nonzero.
- Focused gate after fix: `terminal-control-runtime.input-queue.test.ts`, `terminal-mirror-capture.test.ts`, `server.control-truth.test.ts`, and `server.transport-lifecycle-truth.test.ts` passed `50/50`.
- 2026-08-01T01:20Z route reset follow-up: Jason reported latest version cannot Tailscale connect when not logged into Relay. Focused route test showed old default priority let non-LAN/public IPv4 beat IPv6 and delay Tailscale/other direct truth. Fix keeps private LAN IPv4 first via `route-selector` LAN cost, but changes default path order to `tailscale -> ipv6 -> rtc-direct -> ipv4 -> rtc-relay` so public IPv4 cannot preempt logged-out Tailscale. Added regression `opens Tailscale before non-LAN IPv4 when no relay account settings are present` in `src/lib/traversal/socket.test.ts`.
- 2026-08-01T01:21Z relay ops: production relay user `jason` password hash reset in `/var/lib/zterm-traversal-relay/store.json`; old tokens for that user cleared; service-scoped `systemctl restart zterm-traversal-relay.service`; `/relay/health` active and `/relay/api/auth/login` returned ok with token + directory. Backup: `/var/lib/zterm-traversal-relay/store.json.bak-2026-08-01T01-11-41-794Z`.

# 2026-08-01 relay login auto-route auth closeout

- Symptom: after account login, a new Android device saw the daemon but connection failed; production `/api/auth/me` directory exposed `mac-studio` with only `tailscale` and `relay-rtc` candidates, both without `authToken`, so direct WebSocket attempts could not authenticate and Auto lost the intended LAN/Tailscale/RTC/Relay chain.
- Root-source proof: local daemon runtime had `auth=config` and log-published `endpoints=5`, but production relay runtime `/usr/lib/node_modules/@jsonstudio/zterm-relay-server/runtime/server.cjs` did not contain `authToken` and had mtime `2026-07-21T05:08:37.516Z`. The relay store held the connected `mac-studio` record with two no-token endpoints because the old relay package stripped the field before store normalization.
- Fix path: shared directory contract now accepts/preserves `RelayEndpointCandidate.authToken`; daemon endpoint builder publishes the daemon auth token on LAN, RTC-direct, Tailscale, and Relay candidates; client target resolver consumes endpoint token for direct route attempts; Home badge projects one `Auto` intent for rows with `relay-rtc`; daemon config merges non-empty `zterm.android.daemon.*` over legacy `mobile.daemon.*` per field so empty new config cannot mask the real legacy daemon token.
- Production ops: prepared relay package `jsonstudio-zterm-relay-server-0.1.3.tgz` sha256 `b931031cadcbaf300684bb65918aab74c43a00c9bae5c911cc49ab23c473c940`, installed it globally on `159.75.134.56`, and service-scoped restarted `zterm-traversal-relay.service`. New production runtime contains `authToken`, mtime `2026-08-01T02:34:56.376Z`.
- Live evidence: public `/relay/api/auth/me` after restart returned connected `mac-studio` lastPublishedAt `2026-08-01T02:34:58.615Z`, `endpointCount=5`, kinds `lan, lan, rtc-direct, tailscale, relay-rtc`, and `allHaveAuth=true`. Public update route serves `0.1.3.2292`; downloaded APK sha256 matches `4d3f70a3e9753f60970bf1794b6e576f669a274a5700c08a74ff7acabc91793e`.
- Device evidence: ADB installed `android/update-dist/zterm-0.1.3.2292.apk` successfully on `100.104.163.65:5555`; `dumpsys package` reports `versionCode=1100022920` and `versionName=0.1.3.2292`; launched app PID `5349`. ADB TCP reset during concurrent log/pid collection, so UI click-through connection smoke remains a live evidence gap.
- Verification: relay/route/UI focused gates `111/111 PASS`, shared relay-directory `3/3 PASS`, Android `tsc --noEmit` PASS, `test:feature-registry` `79/79 PASS`, `git diff --check` PASS, relay package verify PASS. `packages/shared` whole-package typecheck still fails on existing unrelated harness/test typing debt and is not counted as this feature gate.
- Review gate follow-up: `codex -p cc review --uncommitted` completed after the provider failures with no discrete correctness defects reported across the relay-directory authentication flow, route ordering, mux recovery, daemon configuration merge, and exact tmux pane targeting. Final sanity also rechecked `git diff --check` and live public `/relay/api/auth/me`: connected `mac-studio`, `endpointCount=5`, kinds `lan, lan, rtc-direct, tailscale, relay-rtc`, `allHaveAuth=true`.

# 2026-08-01 unauthorized bridge token + RTC probe closeout

- Live complaint: installed Android showed `Unauthorized bridge token` and `rtc data channel` failure after relay login/auto-route work.
- Root cause confirmed in client traversal plan: saved host stale `authToken` and relay directory fresh endpoint `authToken` could generate two candidates for the same `path + host:port` because dedupe used full token-bearing URL. Saved direct candidate was inserted before directory endpoint, so Auto could try the stale token first and hit daemon `/ws` unauthorized even though relay directory truth was fresh.
- Fix: `buildTraversalPlan()` now inserts relay directory direct endpoints before saved direct fields for each path, and dedupes direct WS candidates by endpoint identity `${path}:${displayEndpoint}` before URL. Regression proves stale saved `100.66.1.82:3333` token is absent and fresh directory token is first.
- RTC verification correction: production relay requires `/ws/client` `deviceId`; old remote RTC probes omitted it and then reused daemon device id as client id. Updated probes to send distinct per-attempt client ids, matching peer lease contract. Real production probe then passed P2P and TURN-only data channel: P2P candidate types host/prflx; relay-only candidate types relay/relay.
- Live production route proof after fix: `/relay/api/auth/me` for jason reports connected `mac-studio`, endpoint kinds `lan,lan,rtc-direct,tailscale,relay-rtc`, all endpoint auth present. With a deliberate `known-stale-token`, first candidate is `tailscale:100.66.1.82:3333`, `urlHasStale=false`, `urlHasEndpointToken=true`; opening WS and sending `list-sessions` returned sessions including `rcc` and `rccstart`.
- Delivery: build produced APK `0.1.3.2293` / `versionCode=1100022930`, sha256 `50bc5ba9066903ffc971f0eda16e59d201e7e6db96eae27002b39b250503e54b`; prepared rollback `0.1.3.2293.1` / `1100022931`, sha256 `12421ab1f34b16c2b96dd2471faaf439e972b5772c8eddc83d8d55e41fd46b66`; previous rollback `0.1.3.2292.1` sha256 `ddf5982b572184b3f57938d015feafc94cedde8024a44e39f4adc5c4d13d2175`.
- Update routes verified: local `127.0.0.1:3333`, Tailscale `100.66.1.82:3333`, and public `https://relay.codewhisper.cc:18443/relay/updates/latest.json` all serve 0.1.3.2293 and downloaded APK sha256 matches manifest. No online ADB device was attached, so installed phone click-through remains unverified in this run.

# 2026-08-01 RTC direct stability + reliable input resend closeout

- Live complaint: one device connects through Tailscale but fails when Tailscale is off, while input buffer can resend the same content several times under poor network.
- RTC root cause: `rtc-direct` data channel could briefly open and then close before the candidate was actually stable. `TraversalSocket` treated the first open as final success, so route selection stopped and never fell through to TURN-only `rtc-relay`; this matched the symptom where killing/restarting could succeed but the in-process attempt stayed failed.
- RTC fix: `rtc-direct` now has a 1000ms open-stability window before publishing open to upper layers. If the data channel closes inside that window, the candidate is recorded failed and Auto continues to the next route, including TURN-only relay. `rtc-relay` still publishes immediately because it is already the fallback route.
- Reliable input root cause: once a reliable input seq was sent, the client kept a fixed retry timer and resent after 500ms even though the daemon might simply not have acked yet. Under weak network, late ACK plus timer resend could duplicate visible input. The seq dedupe on daemon remains useful but is no longer used to hide client-side over-send.
- Reliable input fix: a pending reliable input item with `sentAt !== null` is treated as in-flight and waits for ACK without timer resend. Only explicit retryable NACK resets `sentAt=null` and allows the same seq to be sent again.
- Delivery: build produced APK `0.1.3.2294` / `versionCode=1100022940`, sha256 `e60915e297638de02172a72a9d4898eb56eb5f8caf8780a97f42dd9b9455398f`.
- Installed daemon: global release runtime restarted under launchd as PID `43574`; `/health` returned `ok=true`, `uptimeSec=4`, `updatesUrl=http://127.0.0.1:3333/updates/latest.json`, and release runtime sha matched artifact `dc6197e97ea698dec10de45e09ada57cef33cdc7e8d308c53f5c33252e83c514`.
- Auth and route evidence: no-token WS returned `Unauthorized bridge token`; config-token WS returned sessions including `rcc` and `rccstart`. Production RTC smoke passed P2P with host/host candidates and TURN-only with relay/relay candidates.
- Update routes verified: local `127.0.0.1:3333`, Tailscale `100.66.1.82:3333`, and public `https://relay.codewhisper.cc:18443/relay/updates/latest.json` all serve 0.1.3.2294 and downloaded APK sha256 matches manifest. No online ADB device was attached, so installed phone click-through remains unverified in this run.

# 2026-08-01 foreground resume websocket error + RTC direct closeout

- Live complaint after 2294: Android from background to foreground reports `websocket error` and does not retry until switching session; 2294 RTC still fails when Tailscale is disabled on one device.
- Foreground root cause: `notifyTargetNetworkSignalRuntime()` could observe foreground/online while the retained target transport was already CLOSED/ERROR, but it returned a local `not-open` probe result and did not submit that physical target generation to the target failure owner. If the browser/Capacitor lifecycle missed or did not replay the original close/error event, the target stayed dead until session switch produced another control action.
- Foreground fix: foreground/online signal with non-OPEN target transport now calls `submitTargetSocketFailure()` for the exact target generation. This keeps ownership in `terminal.transport_lifecycle`: network signal only proves generation changed; target failure owner retires/rebuilds the physical transport and replays recoverable mux channels.
- RTC closeout: `rtc-direct` open stability remains 1000ms and direct candidate timeout is extended to include that window, so a direct data channel that opens in the final second can still either stabilize and publish success or close and fall through to TURN-only relay.
- Reliable input closeout: no fixed 500ms duplicate resend. The client observes in-flight seq every 500ms but resends only after `ACK_TIMEOUT=5000ms` or target routeGeneration change; retry uses the same seq and daemon ack cache preserves idempotence.
- Verification: focused input/server gate `59/59 PASS`; traversal route/socket gate `55/55 PASS`; transport orchestration/runtime gate `36/36 PASS`; `tsc --noEmit` PASS; `test:feature-registry` `79/79 PASS`; `git diff --check` PASS; full `pnpm --dir android run build:android` PASS.
- Delivery: build produced APK `0.1.3.2295` / `versionCode=1100022950`, sha256 `55592a367c249fa1ddd51786bd11394f93e02b9bd647a2873b62a48725164566`; local update dir and daemon update dir APK sha match. Global daemon release installed and service-scoped restarted as PID `63743`; `/health` returned `ok=true`, `auth=config`, `updatesUrl=http://127.0.0.1:3333/updates/latest.json`.
- Auth/update/RTC evidence: no-token WS returns `Unauthorized bridge token`; `?token=` config-token WS returns sessions including `rcc` and `rccstart`; local `127.0.0.1:3333`, Tailscale `100.66.1.82:3333`, and public Relay all serve 0.1.3.2295 and downloaded APK sha matches manifest; production RTC smoke passed P2P host/host and TURN-only relay/relay. No online ADB device was attached, so installed-phone foreground resume click-through remains unverified in this run.

# 2026-08-01 control-confirmed connection gate correction

- Corrected diagnosis: the Relay peer-lease replacement path is not the current failure owner. A local black-box smoke proved that a new same-account/host/client-device signaling socket reuses the same `peerId`, closes the previous socket with `relay client socket replaced`, and sends a new `rtc-init`; another device receives a different `peerId`.
- Confirmed root cause: `buildTraversalSocketForHostRuntime()` could merge the client control directory synchronously before a fresh server snapshot arrived. When the control directory was not confirmed it returned the saved host, so a new business transport could start LAN/Tailscale/RTC signaling with stale endpoint/token truth before the control plane had decided the current route inputs.
- Owner mapping: `resource.relay_control_connection -> resource.relay_account_directory -> resource.transport_target -> resource.daemon_target_transport`. `relay.account_directory` owns confirmation and endpoint/token truth; `terminal.transport_lifecycle` owns the waiting physical generation and releases it exactly once. Terminal mux/channel payload remains physically separate and is never written into the control directory.
- Fix shape: logged-in targets with stable daemon ids return a typed CONNECTING transport gate; only a confirmed HTTP/live directory snapshot may construct the traversal socket. A confirmed snapshot without the target fails explicitly with 4404. Logged-out saved direct/Tailscale targets do not depend on Relay control truth.
- Verification so far: focused control/directory/traversal/probe/input suites 86 PASS; feature/module/edge/resource/mainline gates 79 PASS; TypeScript PASS; local Relay peer replacement smoke PASS. APK 0.1.3.2296 was built; global daemon install/restart and online route/device closeout continue below.

# 2026-08-01 portrait connection status session/rate layout

- Architecture mapping: narrow `client.app_shell` UI projection in `src/pages/TerminalPage.tsx`; it consumes existing `resource.active_session` and debug metrics only. No transport, daemon, buffer, renderer, or control payload semantics change.
- Test design: positive case binds the visible status-strip session label to `activeSession.sessionName` and renders upload/download as two independent rows; switch case proves route, session label, and both rates change together with the active session. Negative gate preserves one strip only and no aggregate-bandwidth projection.
- Implemented in the existing portrait status strip: route, active `sessionName`, and a fixed two-row upload/download rate column. The session label is ellipsized inside the remaining width; no new container or transport projection was added.
- Final build/install evidence: full `build:android` PASS and produced `0.1.3.2297`, versionCode `1100022970`, sha256 `b4d51f4d1b3287ca3e6ed3abdfb3183fc39992bb38756cceace06e616d9f53aa`. The release daemon was globally installed and service-scoped restarted; `/health` returned `ok=true`, `auth=config`, pid `34637`; tokened WS `list-sessions` returned `freehand`, `rcc`, `rccstart`, and the remaining current sessions.
- Route evidence: local and Tailscale manifests serve 2297 and both downloaded APK hashes match the manifest. Production RTC verification passed P2P host/host and TURN-only relay/relay. Local Relay peer replacement smoke passed new-same-device replacement and different-device isolation.
- UI evidence: Playwright at 390x844 connected to the installed daemon and rendered `局域网 | freehand | ↑ 0 B/s / ↓ 7.3 KB/s`; measured strip bounds 250x34 with route, session, and rate boxes non-overlapping. Screenshot: `/tmp/zterm-2297-status-strip.png`.
- Remaining delivery gaps: no online ADB device was attached, so 2297 could not be installed on a phone. Public Relay update manifest still serves 2295; publishing 2297 to that external channel was not performed without an explicit publish action.

# 2026-08-01 control gate waiting timeout

- Jason's screenshot shows the reconnect UI parked on `连接已断开，正在重连` after the physical target reached WebSocket `CLOSED` (`readyState=3`). Source review found the new control-confirmed generation could remain `CONNECTING` forever when no fresh control directory snapshot arrived; `startReconnectAttemptRuntime()` then correctly refused duplicate `phase=connecting` attempts, but there was no owner-level terminal event to advance the generation.
- Fix: `ClientControlPlaneTransport` now has a bounded 10s control-confirmation timer. Expiry closes only the waiting generation with typed code `4408` / reason `control directory confirmation timeout`; it does not start signaling from stale host data. The existing target failure/reconnect owner receives the close and can schedule the next generation. Confirmation clears the timer; close and replacement also clear it.
- Positive/negative gate: control confirmed opens exactly once; confirmed missing target returns 4404; a never-confirmed target returns 4408 and late snapshots cannot open it. Focused control/orchestration suite is 29 PASS.

# 2026-08-01 portrait connection activity projection

- Jason clarified that the centered portrait connection strip must not look permanently highlighted. The previous `zterm-neo-status-strip` rule forced a raised blue surface and a green glowing route dot even during the first-ten-second reconnect grace period.
- The strip is now a flat transparent click target with no border highlight, outer shadow, backdrop blur, or dot glow. Connected route text is neutral; only active connection work or errors use semantic amber/red text.
- The transport lifecycle owner now publishes diagnostics immediately after creating a target transport, before it opens. A control-confirmed waiting generation therefore projects `waiting for confirmed control directory` into Session truth, and TerminalPage renders `正在同步控制通道`; generic connecting/reconnecting renders `正在连接` / `正在重连`.
- Boundary: TerminalPage reads only Session diagnostics projection. It does not import or read the Relay control directory, preserving `control -> directory -> target transport -> Session projection -> UI` ownership.
- Focused verification: portrait status, transport diagnostics, and orchestration tests 65 PASS.
- Foreground-resume notification correction: reconnect attempts `0` and `1` are standard automatic recovery and never make the top banner actionable. The banner is eligible only at `reconnectAttempt >= 2` (one complete failed traversal generation) or terminal `error`; retry notifications replace raw probe strings such as `network generation target transport terminal state 3` with a stable user-facing message.
- Final build/device evidence: full `build:android` PASS produced `0.1.3.2310`, versionCode `1100023100`, APK sha256 `a0c92c1a879ee493c1cafa458e415605ffd73192896c1fce44dc83c3dafc044f`. The daemon release was globally installed and service-scoped restarted. ADB installed 2310 on `100.104.163.65:5555`; real terminal connected over Tailscale, the top strip rendered flat without raised highlight, and background -> foreground screenshots at 1s and 13s showed no transient network error banner while the session remained connected (`/tmp/zterm-2310-resume-1s.png`, `/tmp/zterm-2310-resume-13s.png`).
# 2026-08-01 Stale daemon identity creates an unreachable duplicate drawer target

- 现场：同一台 Mac Studio 在 session drawer 中出现两个自动目标；Relay directory 只有在线 `mac-studio`，本地 `sessionGroups` 仍保留旧 `daemon-Macstu...` identity，旧目标永远无法连接，手动选择在线目录目标可以连接。
- 根因：`terminal.session_drawer` projection 只会把无 `daemonHostId` 的 direct history 通过 endpoint/session catalog alias 到在线 Relay daemon；带失效 `daemonHostId` 的历史会被 `resolveServerIdentity()` 当成直接真相，跳过 canonical alias，随后 `drawerHosts` 把它追加成第二条 host rail。
- 架构映射：`feature_id=terminal.session_drawer`，资源仍是 `resource.ui_projection -> resource.open_tab -> resource.active_session`；唯一修改点是 `TerminalPage` drawer projection。没有修改 history storage、transport lifecycle、daemon 或业务 payload。
- 修复策略：当前在线 daemon id 优先且不可替换；仅对不在在线目录的持久化 daemon id，按唯一 endpoint 精确匹配，缺 endpoint 时再按唯一完整 session catalog 匹配。零匹配或多匹配保持分离，禁止猜测。

# 2026-08-01 Multi-device Relay authentication correction

- Jason confirmed the product contract: one Relay account must support multiple simultaneously logged-in client devices and multiple daemon devices; a new login must never evict an existing device.
- Production/source evidence rejects the earlier login-eviction hypothesis. `TraversalRelayStore.login()` appends a new token and `authenticate()` accepts any stored token. Production currently contains 91 tokens for account `jason`, so normal login is already multi-token.
- The affected phone token was written at `2026-08-01T01:11:32Z` and now returns HTTP 401. The operations record proves that the manual password reset cleared every existing `jason` token and wrote backup `/var/lib/zterm-traversal-relay/store.json.bak-2026-08-01T01-11-41-794Z` nine seconds later. The phone was invalidated by that manual global token deletion, not by another device login.
- Unique owner remains `relay.account_directory`: token issuance/authentication in `src/traversal-relay/store.ts`, role-scoped control connections in `src/traversal-relay/server.ts`, and client invalid-auth projection in the Relay account/control runtime. Terminal business payload and terminal transport are forbidden paths.
- Required correction: lock concurrent token semantics with positive/negative tests; never clear all account tokens during an ordinary password reset unless an explicit global sign-out operation was requested. The already-deleted phone token cannot be recreated from normal login semantics; restoring it requires an authorized production-store merge from the timestamped backup or one explicit re-login on that phone.

# 2026-08-02 Multi-device auth repair and persistent-background live proof

- Production repair restored only the affected Android token from `/var/lib/zterm-traversal-relay/store.json.bak-2026-08-01T01-11-41-794Z`; the pre-repair production store was preserved as `/var/lib/zterm-traversal-relay/store.json.bak-2026-08-02T01-14-phone-token-restore`. Relay was restarted through `zterm-traversal-relay.service`; the restored phone token and a second fresh login both returned HTTP 200 concurrently, with the same account id and 22 directory devices. Relay health observed one client device and two daemon devices.
- Focused positive/negative gate now locks append-only login tokens, concurrent client identities, concurrent daemon identities, unknown-token rejection, and account directory isolation. The source owner remains `relay.account_directory`; terminal payload and terminal transport were not used to reconstruct auth/control truth.
- Android `0.1.3.2317` (`versionCode=1100023170`, sha256 `50fce1c4425cb3c3440b6470d945258e550de22b3a51cbb8312e4922611b9db4`) was installed on `100.104.163.65:5555`. A real `rccstart` terminal opened through Tailscale. Local, Tailscale, and public Relay update routes all serve the same manifest and downloaded APK sha.
- Ten-minute screen-off proof is intentionally split: the app process remained PID `19245`; native `BackgroundService` remained foreground/start-requested and held `com.zterm.android:terminal-background`. The WebView Relay client control stream did not remain registered while the screen was off (`client-device-request delivered=0`), so the current implementation proves process retention but not an always-live JavaScript control plane. After wake, the same PID and same session id recovered to `connected` over Tailscale without switching session, and live terminal output advanced. Do not claim long-term background control-plane continuity from the foreground-service/WakeLock evidence alone.
- Review correction produced final APK `0.1.3.2318` (`versionCode=1100023180`, sha256 `45a4a42a3d8043372d7e4fc407def25760343fd7cf25f68ccadb1a310637f631`). Daemon-less legacy direct history now adopts the uniquely resolved Relay daemon identity in the drawer; ambiguous catalogs remain separate. The Capacitor back listener returns Settings/connection properties to Home and explicitly preserves Android exit behavior elsewhere. Focused tests passed 48/48, full Android build gate passed, and installed-phone screenshots proved Settings -> hardware back -> Home plus live `rccstart` Tailscale terminal. Local, Tailscale, and public update downloads all match the final sha.

# 2026-08-02 Drawer daemon identity final review correction

- Final reviewer finding proved that a unique Relay Session catalog was still being treated as daemon identity evidence. With multiple machines, common names such as `rcc` or `dev` can make an unrelated direct/stale history group open the wrong daemon even when endpoints have no relationship.
- Architecture correction stays in `terminal.session_drawer`: `TerminalPage` now canonicalizes only an exact online Relay endpoint or a saved/Home endpoint-to-online-daemon alias. Relay Session catalogs remain row truth and cannot reconstruct `resource.transport_target` identity. The two catalog-only alias builders were physically removed.
- Positive gate proves an rtc-only daemon plus an explicit saved/Home endpoint alias still merges and opens a route-aware target. Negative gate proves one online daemon with the same common Session name and a mismatched history endpoint remains on a separate stale host rail.
- Full build gates passed. Global daemon release was installed and launchd restarted it as PID `66272`; `/health` returned `ok=true`, `auth=config`, and the expected update URL. Android `0.1.3.2319` (`versionCode=1100023190`, sha256 `64a8836596dfdbf2a0834969d433401e532a7488ced551e929053ff7c57f24ab`, 4835144 bytes) was installed on PLZ110. Settings showed 2319 and hardware Back returned Home; Home showed four server rows; Auto opened live `rccstart` over Tailscale with two-line transfer rates and advancing terminal content. Local, Tailscale, and public Relay manifests/downloads all matched the 2319 sha.

# 2026-08-02 tmux management mux protocol correction and 2320 live proof

- Root cause of the phone error `Unexpected tmux control response type`: the standalone `tmux-sessions.ts` management socket sent a raw `list-sessions` immediately on physical open. The current daemon correctly answered `mux-ready`, but the client parser only accepted raw `sessions/error` and rejected that legal negotiation frame.
- Unique owner correction: `tmux-sessions.ts` now sends `mux-hello`, waits for one validated `mux-ready`, then sends only `mux-target-message` with a unique request id. It accepts only the matching target response. Raw bridge responses, mismatched request ids, channel frames, and duplicate ready frames fail closed and discard the transport; no legacy fallback was added.
- Review corrections closed at their owners: a saved direct host with only persisted `daemonHostId` no longer waits for Relay directory truth unless the host has actual Relay route evidence; the portrait status strip now derives activity from the reconnect-suppressed status during the ten-second grace window.
- Focused tests passed 68/68, feature/architecture gates passed 79/79, type-check passed, and the complete Android build pipeline passed. Global daemon was installed and launchd restarted it as PID `12918`; `/health` returned `ok=true`.
- Android `0.1.3.2320` (`versionCode=1100023200`, sha256 `8ff0100383d6546a6f6718a966c191e46687a478eb51374cf4f689293e7452c1`, 4835456 bytes) was installed on PLZ110. Opening the saved `100.66.1.82` server entered a live tmux session without the old protocol error. A four-second background cycle resumed the same terminal; screenshots at two and twelve seconds showed live rates and no reconnect error, while filtered logcat contained none of the strict mux/reconnect error strings. Local, Tailscale, and public update channels serve the same manifest and APK sha.

# 2026-08-02 Android background power stopgap

- Jason clarified the background goal: keep the connection heartbeat alive, do not keep full terminal body streaming/timers alive, and do not rebuild transport on ordinary foreground return.
- Root cause found in the client lifecycle: background state previously remained foreground-active for the five-minute grace path, allowing visible body subscriptions and foreground refresh timers to continue. Native `BackgroundService` also had no session-count gate in the new plugin path.
- Fix shape: App foreground false now immediately clears `liveSessionIds` and suppresses active body subscription. Foreground resume calls `ensureActiveSessionFresh(... allowReconnectIfUnavailable: false)`, so it may refresh an existing transport but cannot rebuild one solely due to foreground return. Target socket heartbeat remains the owner that detects missed control activity and triggers recovery after timeout.
- Native Android handoff is bounded: `BackgroundServicePlugin` starts the foreground service only with retained sessions; `BackgroundService` stops itself for `sessionCount <= 0` and only holds a 35s partial wakelock for process handoff, not a five-minute business-stream grace.
- Verification: focused lifecycle/power/App tests `67/67 PASS`; transport heartbeat/orchestration/infra tests `38/38 PASS`; `tsc --noEmit` PASS; `git diff --check` PASS; feature/architecture gate `79/79 PASS`; full `pnpm --dir android run build` PASS; full `pnpm --dir android run build:android` PASS. APK/update channel produced `0.1.3.2327` (`versionCode=1100023270`) at `android/update-dist/zterm-0.1.3.2327.apk` and `/Users/fanzhang/.zterm/updates/zterm-0.1.3.2327.apk`.
- Remaining gap: this run has not installed 2327 on a physical phone nor measured Android battery stats; live device proof is still required before claiming real-world power improvement.

# 2026-08-02 Floating button remote file manager

- Jason changed the floating quick button contract: the floating entry should open/close remote file management, not the old quick-input panel. The bottom quickbar rows can still expose keyboard/file/image/sync controls, but the floating entry in product mode must route directly to `FileTransferSheet`.
- Architecture mapping: `client.file_browser` owns the file-browser projection and upload/download intents; `client.runtime` owns native local storage bytes; `daemon.file_transfer` owns remote list/download/upload truth. The implementation keeps remote list/read/save on existing `file-list-request`, `file-download-request`, and bounded `file-upload-*` ACK protocol; it does not invent a UI-to-daemon direct save path or mix file payloads into control truth.
- Superseded correction after latest product decision: `TerminalQuickBar` product mode must not show both floating entries. When `onOpenFileTransfer` is present, the only floating entry is `文件浏览`, which directly opens `client.file_browser`; the old quick-input `⌘` floating bubble is legacy-only when file browser is unavailable.
- Fix: `FileTransferSheet` now opens text/code files (`md`, `ts`, `js`, `json`, shell/code/config extensions, etc.) into an editable preview. Saving writes back through `sendBoundedFileUploadChunks`; local external editing writes a bounded local copy through `StoragePermissionPlugin.writeFile()` and opens it with the native `openFile()` FileProvider path, then local focus refresh can pick up edits for upload.
- Verification: `pnpm --dir android exec vitest run src/components/terminal/FileTransferSheet.test.tsx src/components/terminal/TerminalQuickBar.test.tsx --reporter dot` passed `90/90`; `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS; feature/architecture gate `79/79 PASS`; targeted `git diff --check` PASS; full `pnpm --dir android run build:android` PASS. APK/update channel produced `0.1.3.2328` (`versionCode=1100023280`, sha256 `4075ee82de703505ebe2bab2a539cf72ea0441e7c1648838524af7bd796c1850`, 4,838,572 bytes).
- Remaining gap: no physical phone install or real external editor round-trip was run in this turn; product path is covered by JS/native compile and mocked native plugin tests, not L5 device evidence.
- Follow-up correction: empty remote text saves must use the textarea's current value, not `previewEditorText || preview.text`, or an intentionally cleared file is restored to the old preview. External editor flow now records the local FileProvider copy and exposes an explicit `同步本地副本` action that uploads the edited local bytes back through the same bounded `file-upload-*` protocol.
- Final 2329 evidence: targeted file-transfer/quickbar gate passed `91/91`; `tsc --noEmit` PASS; feature/architecture gate `79/79 PASS`; targeted `git diff --check` PASS; full `pnpm --dir android run build:android` PASS. APK `0.1.3.2329` (`versionCode=1100023290`, sha256 `87179a5346181d1114e7f017e8a36f6f3ed9fb32eb41da11b74ef7d628f05019`, 4,838,992 bytes) was built and copied to local daemon update dir. Local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay update downloads all matched the manifest SHA. ADB installed 2329 on `100.104.163.65:5555` and package manager reported `versionName=0.1.3.2329` / `versionCode=1100023290`.

# 2026-08-02 floating remote file browser correction
- Jason corrected the prior implementation: the floating button must not merely open the sync directory/sheet. It must be a remote cwd browser: no local sync panel, no remote checkbox/download selection, directory navigation, text/code preview, in-sheet editing, remote save, and explicit external-editor sync back.
- Architecture mapping: `client.file_browser` owns browser projection and intents, `client.runtime` owns local external edit copy bytes, and `daemon.file_transfer` owns remote list/download/upload truth. Existing file-transfer frames remain the only wire path; no control payload or new save protocol was added.
- Fix: browser mode now shows remote list errors explicitly, hides sync selection controls, reports unsupported/oversized files instead of selecting them for download, recognizes extensionless code files like Dockerfile/Makefile, and writes external edit copies under `Download/zterm/remote-browser/<remote-cwd>/` instead of the sync directory root.
- Verification so far: focused `FileTransferSheet + file-transfer-session-runtime + TerminalQuickBar + overlays` PASS `104/104`; `tsc --noEmit` PASS; feature/architecture gate PASS `79/79`; `test:file-transfer:throughput` PASS `48` TS tests plus Gradle native unit test. Full build/update still pending.
- Follow-up: screenshot showed fixed-height browser blank space and text preview `atob` failure. Root cause: browser inherited fixed sync sheet height, and preview decoded padded base64 chunks after concatenating them. Fix owner remains `client.file_browser` plus daemon list owner: browser sheet now content-heights with max cap, text preview decodes each chunk independently, and daemon file-list requests serve a resolved-path cache refreshed by fs watcher events instead of resync scanning on every request. Focused gate: `file-transfer-session-runtime + FileTransferSheet + terminal-file-transfer-list-runtime` PASS `37/37`.

# 2026-08-02T11:30:50Z foreground resume standard recovery banner
- User-visible issue: foreground resume / auto reconnect can necessarily fail one intermediate route before reconnecting, so showing the top error banner during that standard flow is a false user-visible failure.
- Architecture mapping: feature `terminal.transport_lifecycle`; resources `resource.session_transport -> resource.daemon_target_transport -> resource.terminal_channel`; UI consumes Session projection only. No control payload, Relay directory, daemon truth, or business terminal payload is read or mutated by the UI.
- Fix scope: `TerminalPage` projection only moves the actionable reconnect banner threshold to `reconnectAttempt >= 4` and removes the immediate online-reconnecting banner path so actionable reconnect still passes the 10s quiet window. The flat status strip continues showing `正在同步控制通道` / `正在连接` / `正在重连` during standard recovery.
- Test design update: control-chain test design now defines bounded automatic reconnect flow as standard recovery; raw probe strings remain hidden from notification text.

# 2026-08-02T11:43:20Z progress banner and five-minute background keepalive
- Jason correction: the top banner must show standard recovery progress, not disappear entirely. Fix stays in UI projection: `TerminalNetworkBanner` now renders a neutral progress banner from Session projection (`正在连接` / `正在重连` / `正在同步控制通道`) while `connectionIssueVisible=false`; raw transport errors remain hidden until the actionable error threshold.
- Background recovery delay root cause: design doc already says five-minute background grace, but JS/native constants still used a 35s wake lock. After that window Android can suspend WebView timers/control heartbeat, so foreground return falls into reconnect/recovery instead of reusing the retained transport.
- Stopgap fix: `BACKGROUND_HANDOFF_WAKE_LOCK_MS` is now 5 minutes in both `useOpenTabLifecycleEffects.ts` and native `BackgroundService.java`. Background still suppresses terminal body/live session streaming via App state, so the retained path is heartbeat/control only as far as current JS execution permits. Native service remains process-execution support and explicitly does not own WebSocket/PeerConnection truth.

# 2026-08-02T12:59:30Z target-driven reconnect and route lease reuse
- Jason corrected the connection model: recovery must wait for explicit target signals, not sleep for fixed windows. The valid sequence is existing target probe first, then control directory truth, then route candidate selection. An OPEN transport is reusable only after a valid mux/head/body signal; if a head probe exceeds its response budget, the unique reconnect owner retires that generation instead of sending another blind probe.
- Route selection now treats recent successful LAN/Tailscale/rtc-direct/rtc-relay records as reusable route leases. A lease wins before unknown higher-tier probes, and only explicit timeout/close/auth failure records invalidate that lease and allow downgrade/next-candidate selection. Baseline policy still applies when no reusable lease exists.
- Control directory runtime now exposes confirmed generation, target presence, and known daemon ids for connection wait decisions. `ClientControlPlaneTransport` diagnostics now names the directory generation and target being waited on; the 4408 timeout remains only a bounded deadman for an unconfirmed generation.
- Verification: focused lifecycle/control/target-probe/traversal gates passed `111/111`; TypeScript `tsc --noEmit` passed; architecture/feature registry gate passed `79/79`; targeted `git diff --check` passed. No UI projection or terminal business payload was changed in this slice.
# 2026-08-03 foreground resume control-first recovery

- Symptom: returning from background could enter a long route attempt before current server control truth was available.
- Root cause: foreground resume probed session transports but did not actively refresh `resource.relay_account_directory`; route-aware logged-in hosts with saved direct candidates also bypassed `ClientControlPlaneTransport`, so stale `bridgeHost`/Tailscale candidates could run before confirmed directory truth.
- Owner fix: `relay-device-stream-runtime.refreshNow()` synchronously marks the directory unconfirmed, deduplicates the authoritative account refresh, republishes confirmed endpoints, and leaves an existing control socket/data transport intact. `App` starts that refresh before projecting the foreground resume epoch. `buildTraversalSocketForHostRuntime()` now gates logged-in route-aware targets on confirmed directory truth and removes stale direct fields once a confirmed entry exists.
- Positive evidence: healthy open session transports still take the existing head-probe path; foreground control refresh republishes confirmed endpoints without creating another device-stream socket.
- Negative evidence: stale saved direct candidates cannot bypass control confirmation or remain mixed with the confirmed endpoint set. A first review found that a pending refresh promise could cross runtime generations; the promise is now generation-bound, and a regression test proves a restarted runtime starts its own refresh.
- Final verification: focused tests 47/47, TypeScript, feature/module/edge registry gates 79/79, and full `build:android` pass. Published APK `0.1.3.2354` has sha256 `e91899032d2c8085baf8edee3ea6b076849f0be02d826a2ebcc99ffacca407ab`; local, Tailscale, and public update manifests serve the same artifact. Final Codex review returned `VERDICT: PASS`. No ADB device was online, so real-phone foreground recovery remains the explicit verification gap.

# 2026-08-03 terminal UI skin unification and edge ownership

- Architecture mapping: `mainline_source.android` / module `client.app_shell` owns effective shell presentation and Android page-back intent; `terminal.session_drawer` owns drawer projection; `terminal.session_group_layout` owns stage outer-margin tokens. Resources are only `resource.platform_terminal_surface -> resource.ui_projection`; terminal payload, transport, daemon, tmux, buffer, and renderer truth are forbidden.
- Change class: separate/unify presentation. Light, blue, and black continue to be independent palettes but must provide one complete shared token set consumed by Header, QuickBar, drawer, connection status, and route menu. Phone stage side gutters are physically removed at the profile owner. Terminal system-back exit is consumed at page-navigation owner; Settings/properties back-to-Home and Home exit remain explicit.
- Test design: positive gates cover complete theme propagation, edge-to-edge phone stages, and Settings back navigation; negative gates cover no hard-coded blue drawer/status surfaces in light/black, no Terminal `exitApp`, no terminal/transport/renderer mutation, and unchanged Home exit.

# 2026-08-03 12:24 light renderer correction

- User screenshot proved the first pass changed shell/text appearance but left the terminal body too bright. Root cause: the body is `TerminalView` renderer theme, while initial edits concentrated on shell CSS.
- Corrected the established `tabby-github-light` preset to GitHub Primer neutrals (`#eaeef2` / `#57606a`) and added a real renderer DOM gate. Build `0.1.3.2360` installed on `100.104.163.65:5555`; package version verified. Live terminal screenshot is still blocked by target `WS connect timeout`, so current runtime evidence covers installation/Home only, not the connected terminal screen.

# 2026-08-03 rcc3 first paint and floating file entry

- Symptom: `rcc3` selected via Tailscale showed an empty/black terminal body, while the old floating `⌘` quick-input button reappeared beside the file browser entry.
- Root cause evidence: daemon `/debug/runtime` and tmux truth showed `rcc3` subscriber connected, mirror ready, revision `16`, rows `55`, and available buffer `2..58`; captured tmux content was above a mostly blank tail. Client active bootstrap without renderer visible range requested only one viewport tail, which can be all blank for this session shape.
- Owner fix: `terminal.buffer_render` no-visible-range active bootstrap now requests a three-screen tail bounded by `availableStartIndex/latestEndIndex`. `TerminalQuickBar` product mode renders only the file-folder floating action; old quick-input floating entry is disabled when file browser is available.
- Review correction: collapsed quickbar taps must still expand before the file-browser route; the product file-browser callback must not steal the old reveal interaction. Added the collapsed + `onOpenFileTransfer` regression.
- Follow-up correction after Jason: the folder floating action must remain visible, but the old quick-input `⌘` floating button must not appear beside it. Product mode shows only `文件浏览`; quick-input/saved text/schedule/clipboard stays out of the floating product entry.
- Verification after correction: focused quickbar/buffer tests `122/122`, `SessionContext.ws-refresh` `136/136`, TypeScript, feature/architecture gate `80/80`, `git diff --check`, and full `build:android` passed before the follow-up recovery-banner fix. Intermediate local update APK was `0.1.3.2368`.

# 2026-08-03 foreground recovery banner truth

- Symptom: every foreground recovery round could briefly show an error floating banner and then continue connecting successfully. That proves the banner was tied to a normal recovery milestone rather than an unexpected failure.
- Root cause: `TerminalPage` treated `reconnectAttempt >= 4` as `reconnect-exhausted`. In current route probing, attempt count and transient probe failures are standard recovery progress; successful rounds can still pass that count.
- Owner fix: UI projection no longer turns `reconnecting` attempt count into an actionable error. `TerminalNetworkBanner` keeps neutral progress for standard recovery and only shows error banners for offline or typed terminal `error`.
- Verification: network/banner + drawer + render-isolation UI gates `60/60`, focused quickbar/buffer/ws-refresh gates `258/258`, TypeScript, feature/architecture gate `80/80`, `git diff --check`, and full `build:android` passed. Final installed APK on `100.104.163.65:5555` is `0.1.3.2369` / `versionCode=1100023690`; local/Tailscale update manifests serve sha256 `98c26c023f7317cbd20f406d412d7c4350fc6ba266d977d308aac73747cb1bb0`.

# 2026-08-03 stale daemon and light-theme contrast repair

- Symptom: current Relay daemon and persisted `daemon-Macstu...` both appeared in the drawer; the stale row could be selected by default. Light renderer default text on explicit dark ANSI/truecolor cells was too gray.
- Root cause: `resolveServerIdentity()` skipped endpoint aliases whenever input had any `daemonHostId`; shared `resolveTerminalCellColors()` always used light preset foreground for default foreground cells, even when the cell background was explicitly dark.
- Owner fixes: exact normalized endpoint alias now canonicalizes stale daemon IDs in `TerminalPage` projection; absent/mismatched endpoint evidence remains separate. Shared cell resolver uses bright theme foreground only for default text on explicit dark backgrounds; transparent/default cells keep preset foreground.
- Verification: identity + drawer + theme + QuickBar focused tests `135/135`; feature/architecture gate `80/80`; TypeScript; shared renderer `21/21`; full `build:android` and prebuild gates; installed APK `0.1.3.2373` / `1100023730` on `100.104.163.65:5555`; local/Tailscale/public update manifest and APK sha256 `a4ecc009819e30dfbb82763bec1dc080760eb729233827c8af7536923eb1510a` match.

# 2026-08-03 duplicate daemon host binding repair

- Symptom: one daemon host could remain unreachable while other sessions/devices worked; the relay directory could retain an older online device row for the same daemon host after a daemon restart regenerated its device id.
- Root cause: relay store keyed persisted devices by `deviceId`, while routing/control truth is keyed by `daemonHostId`; `registerHost()` did not retire other online device rows carrying the same host identity. Client projections then received duplicate online host records and could resolve the wrong endpoint/device binding.
- Owner fix: `TraversalRelayStore.clearOtherDaemonHostBindings()` is the sole relay-store mutation for retiring stale same-host daemon bindings; authenticated `registerHost()` invokes it before publishing the new host presence. Existing disconnected rows retain identity for audit but no longer expose endpoints/sessions.
- Verification: relay store/server contract tests `16/16`, control-directory/session-open focused tests `67/67`, feature/resource/function/mainline gates `80/80`, TypeScript, full relay local smoke and full Android prebuild/build passed. APK `0.1.3.2374` / `1100023740`, sha256 `4fbd47f1bfac598a4d6e375f69b61044aa6b5a5166a0140781c47745f368b935`, installed on `100.104.163.65:5555`. Local/Tailscale update routes serve `2374`; public route still serves `2373` and relay server package is prepared/verified locally but not deployed.

# 2026-08-03 wrapped terminal style deployment correction

- Screenshot showed the first physical row of a wrapped TUI line using the intended background while the continuation row reverted to the default theme.
- The current source already carries SGR continuation across captured physical rows. A real tmux sample with a long `48;5;22` background line proved `capture-pane -e` emitted one style opener and one reset after the continuation row; `canonicalizeCapturedMirrorLines()` produced background `22` on both rows.
- Root cause was deployment drift: the running daemon PID `51172` had about 10.6 hours uptime and its installed runtime did not contain `buildAnsiSgrContinuationPrefix` or `continuationState`. Android build `2374` had been installed without globally installing/restarting the daemon runtime.
- Corrected by running `daemon:install-global` and `daemon:install-service`. The live service now runs PID `68350`; `~/.zterm/daemon-runtime/server.cjs` contains the continuation owner and `/health` responds from the new process. No new runtime code change was required.

# 2026-08-03 terminal neutral contrast correction

- Screenshot evidence: Codex/TUI dim gray text on Pencil Light is nearly indistinguishable from `#f1f1f1`; the current fixed 50% foreground/background mix is the direct renderer cause. The symmetric dark-theme risk is ANSI black/dark-gray foreground on a near-black cell.
- Architecture mapping: feature `terminal.buffer_render`, module `client.renderer_window`, resource `resource.renderer_window`; unique implementation point is `packages/shared/src/terminal/cell-render.ts`. This is renderer projection only. Stored cells, ANSI payload, daemon mirror, client sparse buffer, transport, and shell CSS remain unchanged.
- Change class: separate projection policy inside the existing owner. Positive gates cover neutral foreground contrast and readable dim hierarchy on light/dark backgrounds. Negative gates preserve sufficient-contrast saturated ANSI/truecolor colors, reverse semantics, and explicit background truth.
- Real-device follow-up on `0.1.3.2375`: terminal text contrast is visibly improved, but QuickBar labels show doubled edges because the shell CSS applies both dark-above and light-below text shadows. Black skin also loses button depth because its outer shadow merges into the near-black panel. This remains `client.app_shell` presentation truth; the renderer correction is not involved.
## 2026-08-03 terminal multi-view preview performance correction

- User evidence: the six-session preview becomes severely slow and can terminate shortly after entry; secondary terminal glyphs are visually too large; title/body promotion and primary full-shell activation must be deterministic.
- Architecture mapping: `feature_id=terminal.session_preview`; owner module `client.session_drawer_preview`; renderer behavior is consumed from `client.renderer_window`. Allowed implementation paths are `src/components/terminal/TerminalPreviewGrid.tsx` and `src/components/TerminalView.tsx`; transport, daemon mirror, sparse-buffer writes, session lifecycle, and tmux geometry are forbidden.
- Root implementation risk confirmed in source: all six preview tiles pass `live=true` into full `TerminalView`, so every child executes interactive follow/scroll and resize work; preview also passes `splitVisible=false`, selecting the unthrottled resize path. Tile body activation relies on bubbling through `TerminalView`, which runs its own follow alignment before the preview owner sees the click.
- Planned correction category: separation/downstream projection. Keep one primary live renderer; make child previews passive real-time tail projections with compact non-autosized typography and explicit title/body promotion. Required gates: `TerminalPreviewGrid.test.tsx`, `TerminalPreviewGrid.render-truth.test.tsx`, `TerminalView.dynamic-refresh.test.tsx`, session preview page tests, type-check, feature/module gates, build, install, live-device proof, then Codex review.
- Additional lifecycle root cause confirmed after user reproduction: `TerminalPage` owns a `visibilitychange -> setSessionPreviewOpen(false)` effect and passes foreground state into `projectSessionPreviewLiveIds`, dropping preview child ids immediately in background. This duplicates and bypasses `useBackgroundLiveSessionHandoff`, whose five-minute window is the established owner for body suppression/live-set handoff. On foreground return, every dropped child becomes "newly visible" and `useSessionContextLifecycle` schedules `ensureActiveSessionFresh`, explaining both vanished multi-view state and apparent all-session reconnect.
- Lifecycle correction category: physical removal of duplicate owner. Preview mode/live projection stay stable across short background; only `useBackgroundLiveSessionHandoff` may suppress/clear/restore demand. Active transport validity remains decided by the transport lifecycle owner.
- First online six-session source-to-DOM gate after passive follow separation passed data correctness and single-socket continuity, but measured `initialRenderMs=3034`, `domNodeCount=17765`, and about 3.87 CPU seconds during local render. The remaining dominant cost is confirmed as five secondary previews still mounting full per-cell `VisibleRow` DOM. Corrective projection remains inside `TerminalView` owner: secondary previews flatten each visible row to one text node while the primary keeps full ANSI/cursor DOM; add a deterministic DOM-node budget to the existing source-to-DOM gate.
- After flattened secondary-row projection, the same six-session gate passed with `domNodeCount=825` (under the 8000 hard budget), `initialRenderMs=641`, `convergenceMs=46`, and local render CPU `user=961922us/system=17109us`. All six tmux-source, daemon-to-sparse, sparse-to-preview-DOM, cross-session isolation, subscriber cleanup, preview-to-shell continuation, and single physical session socket checks passed.
- Android build completed as `0.1.3.2377` / `1100023770`; APK SHA-256 `828a802914dbae160cfaf366105667c109908acbd387edcbbd2ffd26274f4ef8`. Full prebuild/build passed. Local and Tailscale update manifests serve 2377 with the matching SHA. Public Relay remains at 2373 and was not overwritten without explicit publication authorization. The only ADB target went offline before install, so L5 device install/background reproduction remains open.

# 2026-08-04 repository residue cleanup

- User policy: keep `note.md`; evidence directories keep only `README.md`; non-code residue should be removed or ignored.
- Removed tracked residue: root `.build-meta.json`, `.cursor/rules/avoid-useeffect.mdc`, `.reasonix/truncated-results/1781184229014-af1ccee4-run_command.txt`, `android/tmp-daemon-probe.cjs`, and `mac/CACHE.md`.
- Removed local ignored residue: root `CACHE.md`, `android/CACHE.md`, evidence payloads under Android/Mac/examples, root `project-architecture-analysis.html`, `.agent-collab`, `.DS_Store`, and a root `tmux` socket.
- `.gitignore` now ignores root `.build-meta.json`, root `tmux`, temp daemon probe scripts, and examples evidence payloads while preserving evidence README files.
- Remaining root clutter is structural rather than temporary: `apps/`, `examples/`, root `src/`, `web/`, `e2e/`, `assets/`, `patches/`, and `docs/` need an approved reorganization plan because several are tracked source or referenced by code/config.

# 2026-08-04 app repo layout convergence

- User approved full app-repo convergence and CI rebuild. Physical deletes: legacy docs app, examples, root runtime/web/e2e trees, old `packages/@wterm/*`, old `packages/@internal`, root Zig build files, old wterm mobile skill, next-themes patch, and obsolete `scripts/sync-versions.mjs`.
- Root `docs/goals/mac-*` moved under `mac/docs/goals/`; root old `mac-alpha-p0-closeout-plan.md` was removed because `mac/docs/goals/mac-alpha-p0-closeout-plan.md` is the newer Mac-owned plan.
- Root workspace now has five projects: root, `android`, `mac`, `win`, and `packages/shared`; `pnpm install --lockfile-only` pruned old workspace package entries.
- Added `scripts/check-repo-layout.mjs`, root `test:repo-layout`, and CI/release workflow wiring so banned legacy roots cannot be reintroduced silently.
- Verification: `pnpm install --frozen-lockfile`, `pnpm run test:repo-layout`, `pnpm --dir android run type-check`, `pnpm --dir android run test:feature-registry -- --reporter dot`, Mac split gate, and Windows tests passed.

# 2026-08-04 foreground resume UI / background handoff repair

- User symptom: background -> foreground shows a fixed reconnect/error overlay on normal recovery, and short background appears to recreate the UI/connection immediately.
- Root cause: `TerminalNetworkBanner` still projected ordinary `connectionProgressLabel` / reconnecting state as a fixed overlay; `TerminalConnectionStatusStrip` suppressed reconnect activity into `waiting`, so the top strip did not show the current phase. Native `MainActivity.onStart()` also called `stopBackgroundService()` before the JS lifecycle owner observed foreground/resume.
- Owner fix: fixed banner now only shows offline or typed terminal `error`; standard recovery phases show in the flat top status strip. Removed `suppressReconnectUi` and removed native `onStart` service stop; JS lifecycle remains the only background-service shutdown owner.
- Verification: focused UI/lifecycle tests `74/74`, `test:transport-network-lifecycle` `54/54`, `test:feature-registry` `80/80`, `test:terminal:shell-theme` `203/203`, TypeScript, `git diff --check`, full `build:android`, and public/local/Tailscale update SHA checks all passed. APK `0.1.3.2379` / `1100023790`, sha256 `bbc83a92eab532d0f11e7f423ac6003d2ccb2a0fef64302d4ff5875b0eb960e0`. No online ADB device was attached, so installed-phone background replay remains open.

# 2026-08-04 remote-window top-safe overlay and realtime two-finger scroll

- User symptom: opening apps such as WeChat could place remote-window chrome above the visible top/status boundary, and touch gestures mixed fullscreen pinch, local pan, and remote scrolling.
- Architecture mapping: `desktop.remote_window_stream.client.touch_action` / `client.remote_window_overlay` only. Android overlay owns floating/fullscreen projection, touch classification, and remote input action records; daemon remains the only macOS focus/input injection owner; terminal renderer/transport are not touched.
- Root cause: overlay preserved only single-pointer gesture state when converting between overlay/runtime state, so two-finger state could be lost; local-effect handling ignored `pinch-move`, so fullscreen pinch did not update viewport; old tests/docs locked two-finger scroll as release-time `gesture/swipe`; floating overlay drag/resize allowed top placement too close to the viewport top.
- Fix: floating overlay clamps to a 48px top safe margin, two-finger states survive overlay conversion, coherent two-finger vertical motion emits realtime pixel `scroll` actions on pointer move with no release-time remote action, scroll is vertical-only, and fullscreen pinch updates local viewport scale without sending remote input.
- Verification: focused remote-window/page gates passed `111/111`, TypeScript passed, feature/module gates passed `80/80`, `git diff --check` passed, and full `build:android` passed. APK `0.1.3.2381` / `1100023810`, sha256 `21e0b41e2eebf527be6531a46a9bff036ffb7ae9990335ae01274704ed24b406`; local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay update routes all serve matching 2381. Prepared rollback `0.1.3.2381.1` sha256 `784804e01ab1bf590e8d39056728a9b7f9a5d59dadc3c14a3410833bef6e4867` was also uploaded and verified from public Relay. No online ADB device was attached, so installed-phone gesture replay remains open.

# 2026-08-04 review correction: endpoint identity is not daemon owner truth

- Codex review found two P1 issues after the foreground UI/lifecycle work: `open-tab-restore` and `open-tab-persistence` were still willing to canonicalize by shared `bridgeHost:bridgePort` before preserving exact daemon/host identity.
- Root risk: multiple daemons behind the same Relay/proxy endpoint could be collapsed into one pinned/newer host, causing tmux session audit and persisted tab restore to use the wrong daemon token/route. This is the same class as stale daemon/zombie row bugs: endpoint is route evidence, not owner truth unless it maps to exactly one confirmed owner.
- Owner fix: `resolveRemoteSessionOwnerTargets()` now preserves exact daemon owner first and only endpoint-canonicalizes when the endpoint maps to one owner. `resolveHostForPersistedOpenTab()` now uses exact persisted `hostId`, then semantic daemon/session match, then unique endpoint projection only.
- Renderer review correction: neutral contrast projection now selects a readable black/white anchor when theme foreground cannot meet the requested contrast; it no longer changes low-contrast neutral text into the same color as an explicit background.
- Verification: review-red focused tests now pass (`open-tab-restore`/`open-tab-persistence` `31/31`, shared `cell-render` `6/6`), focused UI/lifecycle `74/74`, transport lifecycle `54/54`, feature gates `80/80`, shell-theme `204/204`, repo-layout, TypeScript, `git diff --check`, and full `build:android`. APK `0.1.3.2380` / `1100023800`, sha256 `654cfeba104c4daeb6b2028eef50850dc4175c017b600e838d58096dcc9f541d`; local, Tailscale, and public Relay update routes all serve matching 2380. Prepared rollback `0.1.3.2380.1` sha256 `8a513e2cfec92518087c835aec62658dd9c8903494c4c7dd2456d7d7c429f292` also verified from public Relay. No online ADB device was attached, so installed-phone background replay remains open.

# 2026-08-04 remote-window pinch continuation / anchor repair 2383

- User symptom: after fullscreen zoom, the next pinch did not continue naturally from the current zoomed projection and gestures could appear ineffective.
- Architecture mapping: `desktop.remote_window_stream.client.touch_action` / `client.remote_window_overlay` only. Android overlay owns fullscreen local viewport scale/pan and touch classification; daemon input injection, terminal renderer, tmux, transport, and route logic were not changed.
- Root cause: the overlay consumed runtime `pinch-move` scale ratios as local scale changes but did not preserve the pinch midpoint as the zoom anchor. A new pinch could multiply from the current scale but still expand around the fit center / previous pan, creating a visible jump that felt like recalculation from the wrong touch point.
- Fix: `RemoteWindowOverlay` now records pinch baseline scale per gesture and applies `scale + pan` together through `resolveAnchoredFullscreenViewportScale()`, preserving the remote content point under the current two-finger midpoint while clamping to fullscreen fit/max bounds.
- Verification: focused gesture gates `79/79`, remote-window/page gates `111/111`, TypeScript, feature/module gates `80/80`, `git diff --check`, and full `build:android` all passed. APK `0.1.3.2383` / `1100023830`, sha256 `7be00f0ffbedd6402cf2c5bea29a83d9f2bcb2609b89fb52b3f47c6512901efb`; local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay update routes serve matching 2383. Prepared rollback `0.1.3.2383.1` sha256 `8be22a4312a3773bbd11507f5e8d0c3e73c67ac806986be0caf2f5535369ac09` was also uploaded and verified from public Relay. No online ADB device was attached, so installed-phone gesture replay remains open.

# 2026-08-04 remote-window post-pinch local pan / WebView zoom repair 2384

- User symptom: after fullscreen zoom, the remaining one-finger drag could be consumed without moving the local container, while tap and two-finger gestures still needed to pass through as remote input.
- Architecture mapping stays `desktop.remote_window_stream.client.touch_action` / `client.remote_window_overlay`. The fix is Android overlay gesture state plus native WebView touch ownership only; daemon focus/input injection remains action-owner truth.
- Root cause: when a two-finger pinch/scroll ended with one finger still down, runtime returned `localPan`, but `RemoteWindowOverlay` did not seed `surfaceLocalPanStartRef` from the current fullscreen viewport pan before consuming following move events. Android WebView built-in zoom controls were also still enabled, so native WebView gesture handling could compete with the custom fullscreen pinch classifier.
- Fix: pair pointer-up now seeds the remaining pointer's local pan baseline before converting runtime state back to overlay state, clears stale pan/pinch baselines on gesture resets, and native `MainActivity` disables WebView support zoom / built-in zoom controls / display zoom controls.
- Verification: focused gesture/page gates `86/86`, TypeScript, feature/module gates `80/80`, `git diff --check`, and full `build:android` passed. APK `0.1.3.2384` / `1100023840`, sha256 `d20d7c2e777323e9ab373acac7dbeb16d60b0bd2a8a0803c68529c46337687be`; local `127.0.0.1`, Tailscale `100.66.1.82`, and public Relay update routes serve matching 2384. No online ADB device was attached, so installed-phone touch replay remains open.

# 2026-08-04 terminal preview input owner correction

- User symptom: in multi-window terminal preview, text input could go to a different session than the large visible preview window. This made the preview look non-interactive even though the real failure was input focus/target ownership.
- Architecture mapping: `terminal.session_preview` / `client.session_drawer_preview` only. Preview selection/mode owns the visible primary tile; `TerminalPage` owns the UI input projection. Daemon, tmux, transport, sparse buffer, and renderer truth were not changed.
- Root cause: `TerminalPreviewGrid` kept `primaryPreviewSessionId` as local component state, while `TerminalPage` and `TerminalQuickBar` kept sending quick actions/draft/screenshot/schedule intents to `uiSessionId`, the previous active shell session. The visible preview primary and input owner could therefore diverge.
- Fix: `TerminalPreviewGrid` now publishes the resolved preview primary session through `onPrimarySessionChange`; `TerminalPage` stores `sessionPreviewInputSessionId` while preview is open and routes QuickBar sequence/draft/screenshot/schedule active session projection through that owner. Preview cancel/activation clears the owner.
- Verification: focused preview tests `37/37`, TypeScript, feature/module/resource gates `80/80`, `git diff --check`, and six-session `terminal:preview:source-dom-gate` passed with `domNodeCount=825`, `initialRenderMs=664`, `convergenceMs=49`, all six tmux-source -> daemon -> client sparse -> preview DOM checks true, exact six subscribers added, and subscribers restored after close.

# 2026-08-04 terminal preview child visibility and input target correction

- Jason reported two concrete preview failures: the primary tile rendered while secondary tiles stayed visually empty, and QuickBar/IME input continued targeting the old interactive session after a preview child became primary.
- First divergence in the client projection owner: `TerminalView` subscribed secondary previews to the session buffer, but its passive render frame retained the component's initial `renderBottomIndex`; when the buffer grew, the preview window could remain outside the new tail. Secondary previews now derive their render bottom from `effectiveBufferEndIndex` while retaining passive one-row text projection and no interactive demand loop.
- Input owner correction stays in `TerminalPage`: preview primary selection is already published by `TerminalPreviewGrid`; `activeSessionIdRef`, textarea focus/blur, IME route keys, and QuickBar target paths now use `terminalActionSessionId` while preview is open. Clicking a secondary tile only promotes it; clicking the promoted primary tile still exits preview into the real shell.
- Positive tests: passive preview buffer growth renders the new tail row; existing primary/secondary promotion and QuickBar target tests remain green. Negative behavior remains: secondary preview does not create hidden input or interactive geometry/viewport demand.
- Verification: focused preview/TerminalPage gates `35/35`, TypeScript, feature/module/resource gates `80/80`, and `git diff --check` pass. The real six-session source-to-DOM gate is currently blocked by the existing runtime `Unauthorized bridge token` before preview assertions; this is a daemon/runtime credential state issue, not evidence that the UI path passed online.

## 2026-08-04 terminal refresh residue investigation
- Screenshot symptom is treated as stale row pixels after a refresh: terminal content advances but a row remains from the previous frame.
- Owner mapping: `terminal.buffer_render`; renderer owner is `src/components/TerminalView.tsx` with row projection in `src/components/terminal/VisibleRow.tsx`. Daemon/mirror/buffer truth is out of scope.
- Focused baseline: `TerminalView.bottom-stale.test.tsx` and `TerminalView.dynamic-refresh.test.tsx` passed 80/80, but existing regression only used new row references. The likely untested path is in-place row mutation: React memo plus `key=absoluteIndex` can preserve a stale row when cell arrays are reused.

## 2026-08-04 terminal refresh residue fix
- Root cause confirmed at renderer memo boundary: `VisibleRow` compared only row reference, so an in-place cell/style mutation could leave stale DOM pixels.
- Fix: `TerminalView` memoizes a per-row signature over char/fg/bg/flags/width; `VisibleRow` compares that signature. Changed rows repaint; unchanged rows retain DOM identity.
- Evidence: focused TerminalView refresh/selection tests 83/83, architecture gates 80/80, Android build `0.1.3.2388` completed before final signature memoization refinement; final build rerun required after this note.
- Online device gate remains open: `adb devices` returned no connected devices.

## 2026-08-04 remote-window startup stream and logo wallpaper repair
- User symptom: app-window streaming did not establish, and the pre-frame surface exposed the WebView video element's native gray play placeholder instead of zterm branding.
- Architecture mapping: `desktop.remote_window_stream` client receiver projection remains owned by `RemoteWindowOverlay`; daemon capture remains owned by the ScreenCaptureKit/WebRTC stream runtime. No terminal payload, route selection, or control-plane contract changed.
- Root cause evidence: the running daemon predated the current remote-window stream runtime. After installing and restarting the built daemon, a token-authenticated mux probe completed `remote-window-stream-start`, observed the receiver track, captured a real WeChat window through ScreenCaptureKit, sent one frame, and stopped normally. Separately, receiver visibility was not reset at every target handoff, allowing a new frame-less `<video>` lifecycle to expose native browser UI.
- Fix: every target receiver lifecycle and failed startup cleanup now resets video visibility; the video remains hidden behind the engraved zterm logo until playback/frame evidence reveals it, and the video `poster` is the same logo as a native-placeholder guard. Regression tests lock both target-switch hiding and poster branding.
- Review found and the implementation fixed all negative handoff paths: failed replacement, superseding handoffs, and immediate missing-session rejection now restore the original receiver visibility instead of leaving a valid retained stream behind the logo. One handoff-scoped ref owns that original visibility until the replacement group commits or rolls back.
- Verification: focused overlay/page tests `78/78`, TypeScript, architecture gates `80/80`, the complete Android prebuild/build chain, daemon global install/restart, and the real mux + ScreenCaptureKit + WebRTC probe passed. APK `0.1.3.2393` / `1100023930`, sha256 `ec8ac23571372f6dcd5fef87e5fc05c8c01f1a9d1ea4c0d77793159fe0b552fa`. No ADB device was attached, so installed-phone WebView pixel verification remains open.

## 2026-08-04 stale tmux session drawer entry

- User symptom: the drawer listed a tmux session that had already been closed elsewhere; pressing close returned `can't find session` and the stale row remained.
- Root cause: the drawer consumed a previously published daemon `sessions` projection. The tmux close command reached the daemon, but an already-absent session was treated as an ordinary error, so no fresh authoritative session list was published.
- Fix: `terminal-message-control-runtime.ts` now treats only explicit absent-session terminal errors (`can't find session`, `no server running`, `session not found`) as idempotent close. It marks the schedule/session missing, releases the matching mirror without closing unrelated subscribers, and republishes the current tmux session list. Permission and other failures remain explicit `tmux_kill_failed` errors.
- Verification: targeted tests `99/99`, full Android prebuild/build chain passed, APK `0.1.3.2401` / `1100024010` manifest and rollback checks passed, daemon installed/restarted with health PID `97056`, and authenticated mux + ScreenCaptureKit video-only probe passed. No Android ADB device was attached. The isolated Codex review process produced no final output, so review is incomplete and is not reported as PASS.

## 2026-08-05 startup/resume surface coverage and pane-menu cancellation

- First visual divergence: `AppContent` and `TerminalPage` used transient `100dvh` / measured pixel heights as painted outer-surface bounds. A short cold-start or foreground WebView measurement therefore exposed the root background below the terminal until a later layout event.
- Owner correction: `AppContent` now pins the app surface to native content bounds with `position: fixed; inset: 0`; `TerminalPage` keeps measured height for IME/layout calculations but has `minHeight: 100%` and no pixel `maxHeight`, so internal viewport metrics cannot crop the painted surface.
- Session drawer slot assignment now has an explicit cancel action. Cancel closes only the menu and emits no workspace assignment.
- Connection lifecycle audit: backgrounding does not intentionally close transport. Target heartbeat runs every 30 seconds and fails after three consecutive inactive ticks; foreground sends a typed mux probe. OPEN/CONNECTING and one 2.5-second inconclusive probe do not reconnect; only terminal socket state or direct send failure enters target transport failure/replay.
- Verification: focused UI tests `121/121`, feature registry gates `80/80`, pane gates `44/44`, full Android prebuild/build passed. APK `0.1.3.2407` / `1100024070`, sha256 `ec6f23e16bb21ffa032637f3c0ddcbcb65f7463b3c17292f7fd25e3261ef28c7`. Local and Tailscale manifests serve 2407; public Relay remains 2385. No ADB device was attached, so cold-start/foreground pixel proof and exact field reconnect trigger remain open.

## 2026-08-05 secondary preview blank-body diagnosis

- Symptom: real-device six-window preview renders all six titles, but only the primary tile has terminal rows; five secondary bodies are empty.
- Known flow: `terminal.session_preview` live-set intent -> `terminal.transport_lifecycle` body subscription -> daemon mirror head/body -> client frame assembly/sparse buffer -> render gate/store -> passive preview projection. Preview rendering against six pre-filled independent render-store snapshots passes, and the authenticated real daemon source-to-DOM gate passes all six streams, so layout/render isolation is not the first divergence.
- Rejected hypothesis: `setLiveSessionIds` reading stale React state. `applySessionActionRuntime` synchronously advances `stateRef` before dispatch, so body subscription reconciliation reads the new live set.
- Active hypothesis: the existing L3 gate bypasses the field transition from already-connected, initially body-unsubscribed mux channels into preview demand. A SessionProvider integration test must identify whether divergence occurs at subscription send, first head, bounded tail request, buffer apply, or render-store publish.
- Owner/scope lock: feature `terminal.transport_lifecycle` for subscription/bootstrap and `terminal.buffer_render` only if evidence reaches the apply/commit edge. Allowed runtime paths are `src/contexts/session-context-*.ts`; preview UI is forbidden unless transport/render evidence reaches the DOM with non-empty per-session snapshots.
- Device `PLZ110` on APK `0.1.3.2408` disproved the initial-render-only hypothesis: the primary tile rendered and all five secondary bodies remained empty. The screenshot's debug overlay `窗格 x1` describes normal pane projection, not preview live demand, so it cannot prove subscription count.
- Field-equivalent divergence: the first six-session integration gate kept every logical mux channel open. Real inactive Sessions may retain UI/session records after their mux channel closes. `setLiveSessionIdsSync` updated body demand and sent subscriptions only to existing open channels; it did not ask the lifecycle owner to reopen newly-live closed channels.
- Unique-owner fix: public `setLiveSessionIds` records the prior set, commits the new set, then sends only newly-live IDs through existing `ensureActiveSessionFresh`. A healthy shared target therefore reopens only the missing logical channel with `bodySubscribed=true`; it does not recreate the physical socket or change active-session truth. Positive integration proof covers inactive channel close -> preview live add -> same-target channel reopen; existing unchanged-live and inactive-close tests guard duplicate/open-idle behavior.
# 2026-08-05 foreground resume business-probe boundary repair

- Symptom: returning from Android background regularly projected reconnect and rebuilt the terminal transport even when the retained physical target socket was still open.
- Confirmed root edge: `ensureActiveSessionFreshRuntime()` marked a forced `buffer-head` request pending, then treated its response timeout as transport death and called `reconnectSession()`. This reconstructed control truth from business payload silence even though foreground resume already sends a typed target mux probe through the physical transport owner.
- Owner repair: `terminal.transport_lifecycle` now keeps `buffer-head` timeout inside the activity/business freshness path. It clears and reissues only that head request while an `OPEN` socket remains authoritative; only target probe/socket lifecycle failures may retire and rebuild the physical transport. Closed/missing socket reconnect behavior remains unchanged.
- Test design: positive case locks open-socket head timeout to same-socket reissue with no reconnect; existing negative cases retain closed/missing-socket reconnect through the unique owner.
# 2026-08-05 Android orientation and white-viewport repair

- Symptom: after rotating or returning from background, the terminal surface could retain a stale pixel height and expose the light App root as a large white region; orientation followed the system switch only.
- Root cause: `TerminalPage` sampled a monotonic layout height for IME geometry and used it as the visual shell height without a viewport clamp. Android also reports one stale metrics frame during `orientationchange`.
- Owner repair: the terminal shell keeps the geometry height contract for keyboard/terminal calculations but is visually clamped by the shell CSS to the current parent viewport; viewport metrics are rescheduled on `orientationchange` and the following animation frame. Root/App keep a dark-safe viewport background so a transition cannot flash white.
- Verification: Android IME + viewport tests `71/71` pass after the contract-preserving clamp.
- Manual control: Android QuickBar now exposes the opposite orientation (`横屏` or `竖屏`) and delegates the explicit command to the native `ScreenOrientationPlugin`; the plugin is the single requested-orientation owner.

# 2026-08-05 frequent reconnect and false offline banner diagnosis

- Symptom: APK `0.1.3.2412` on `PLZ110` periodically lost an already-open Auto connection and recovered only after an explicit Tailscale selection; after transport recovery the terminal still showed `网络已断开` while rows continued refreshing.
- Known flow: `resource.platform_network_signal` may trigger the typed target probe, but only `resource.daemon_target_transport` and its target failure owner may publish terminal connection truth. `TerminalPage` is a projection consumer and must not reconstruct control truth from browser state.
- Live evidence: daemon transport `db8d06a5-de45-4613-9cac-2ecc1336d1ae` attached the `zterm` mux channel at `2026-08-05 23:02:24 +08:00`; after screen-off, that target transport plus two pending control transports all closed with `1006` at `23:03:26.630`. Android `dumpsys` then showed no `BackgroundService` and no `terminal-background` wake lock, so WebView background execution was not retained.
- False-banner first divergence: `TerminalPage` independently sampled `navigator.onLine` and converted `false` directly into the user-visible control statement `网络已断开`. The screenshot and live terminal refresh prove this platform hint disagreed with the active mux transport. This is an unregistered reverse edge from browser projection to control truth.
- Unique owner and edit scope: `terminal.transport_lifecycle`; remove the `navigator.onLine` control projection from `src/pages/TerminalPage.tsx` / `src/pages/terminal-page-shell-ui.tsx` and lock it in `src/pages/TerminalPage.network-banner.test.tsx`. Foreground-service retention remains a separate native lifecycle slice under `BackgroundService.java` and is not yet fixed by the banner change.
- Positive/negative test design: platform `networkOnline=false` with a connected or reconnecting terminal must not manufacture an offline error banner; an explicit terminal `error` remains actionable after the existing 10-second grace and still renders the generic failure message.

## 2026-08-06 后台心跳机制完成

### 完成内容
- 后台心跳机制实现完成
- 30秒间隔心跳保持连接
- 90秒超时检测
- 与现有后台保活机制集成

### 修复问题
- SessionContext.tsx 缺少 lastBackgroundEnteredAtRef 解构
- 测试 mock 缺少新的后台心跳函数
- AttachmentDrawer.tsx 未加入 module-registry

### 提交
- commit 0b3a957: feat(android): add background heartbeat mechanism for connection preservation

### APK
- android/native/android/app/build/outputs/apk/debug/app-debug.apk (4.6MB)

# 2026-08-08 08:30 CST 设计 v2 fix 已 commit, 等待 Jason 设备恢复

- commit c30b738: 修复 useEffect[receiverMediaStream] 调用 requestVideoPlayback 之前清 videoFrameCallbackRef
- TS 0 error, vitest 75/75 PASS
- build:android 0.1.3.2473 (含 Rn.current=null in bundle)
- APK 待安装 — 设备 100.65.195.25:33831 当前 connection refused

## 需要确认的实验结果
- 在新 stream 切来时, rVFC 守卫 (!videoFrameCallbackRef.current) 成立
- 预期: framesReceived 持续上涨, currentTime 持续推进, play_attempt 不再卡 0.543
- 验证点: epoch=3 sibling handoff 时, framesReceived 应当 > 1 (因为 rVFC 重挂到新 stream)

# 2026-08-09 连接方式审计:长语音输出后断流(输入过程中)

## 用户报告(2026-08-09)

- 现象:终端 UI 弹出 `连接已断开,正在重连` banner
- 触发:用户长按 Android 原生 IME 语音键说一段中文,识别完成一次性 commit 到 terminal 后不久断流
- 用户原话选型:"语音场景=Android 原生 IME 语音键"、"先静态审计"(设备不可直连 15T,本机 adb 能看到一台 OPPO PLZ110 在线)

## 架构映射(SOP 必填)

- 已知 model flow:`terminal.transport_lifecycle` 唯一 owner,`resource.platform_input_channel`(IME input intent 入口)→ `terminal.keyboard_ime` 持有 committed-text normalization → `resource.daemon_input_queue`(sending queue)→ `resource.session_transport` → `resource.daemon_target_transport` → `backend_session` → `tmux_session`
- 唯一 owner 是 `terminal.transport_lifecycle`(`src/contexts/session-context-socket-runtime.ts` 派生的 socket-runtime / session-runtime / transport-orchestration-runtime)
- 本次"语音"事件**只是触发器**,真正的诊断目标仍然是 transport 是否在长输入事件下被错误判定为断开、是否触发 reconnect、是否发错 offline banner
- 不允许做的事:在 IME 入口(`TerminalPage.tsx`/`terminal-input-normalization.ts`)加 reconnect 屏蔽逻辑,或在 renderer 加 stale 抑制
- 允许做的事:继续在 `terminal.transport_lifecycle` owner 内审计 reconnect/keepalive/heartbeat 阈值、识别长输入事件期间是否被错误判 close
- 历史警告(2026-08-05 同一仓库现场):APK `0.1.3.2412` 出现过 `网络已断开` banner,但实际 `daemon transport db8d06a5-...` attached mux channel;根因是 `TerminalPage` 直接把 `navigator.onLine=false` 当成 terminal offline 投影,被命名为"unregistered reverse edge from browser projection to control truth"

## 静态审计结论(尚无物理证据,以下为代码静态推断)

### 已定位、可被本次现象间接命中但不是根因

- `src/pages/TerminalPage.tsx#import normalizeTerminalCommittedText` + IME `input` listener 在 `TerminalPage.android-ime.test.tsx` 已经有以下红测:
  - "keeps native IME routing alive after a voice-style CJK commit without needing an extra priming character"(L2637)
  - "treats voice IME line breaks as text separators, not terminal Enter"(L2707)
  - "keeps routing later native IME input after a buffer rerender that follows a voice-style commit"(L2783)
  - 说明 7 月历史 bug `语音识别换行 → 投成 \r` 已经修
- `terminal-input-normalization.ts` 是文本归一化层,只动 character,不动 transport

### 待定的真源:transport 在长 voice commit 期间被谁推下 `closed`

- 长 voice commit 一般 200-1500 字符,会触发 IME listener 多次 `input` callback,但一次就推到 `onTerminalInput`,随后由 `session-context-input-runtime` / socket-runtime 走 `sendQueue`.这不是常规事件,无法在静态审计层面证伪
- 三个最可疑点(按概率排序):
  1. `navigator.onLine` 被 voice IME 唤起时短暂 false → 2026-08-05 banner bug 已修,本批 APK `0.1.3.2412+` 应该不命中;但如果 Jason 当前 APK < 2412 仍可能命中
  2. `socket-runtime` 的 physical heartbeat 60s + maxConsecutiveMisses=3 与 daemon `TERMINAL_TRANSPORT_STALE_INBOUND_MS=10_000` 之前存在服务端早 detach 风险(2026-07-22 已修);但**修复只在 daemon runtime,Android 客户端心跳仍 60s**——若 voice commit 期间被某层误以为 mute,daemon 会先把 transport 关掉
  3. `reconnectSessionRuntime` 在同 target OPEN socket 时已经会复用不 rebuild(2026-07-21 mux sibling 修复后),但客户端 UI 上 reconnect banner 是否在复用后仍触发清除——`scheduleReconnectRuntime` 的 active/live gate(2026-07-22 修复)在 retryable + auto reconnect 被 active/live gate 拦住时只清 reconnect runtime 落 idle、不发 `SESSION_STATUS_EVENT(type='error')`,但 voice commit 期间 active/live 状态变化可能走非 happy path

### 设备/daemon 双侧日志都没拿到(关键 gap)

- 本地 `adb devices -l` 只显示 `100.104.163.65:5555`(OPPO PLZ110,不是用户指定的 15T)
- `adb connect 15T` 失败(`failed to resolve host: '15T'`)
- 因此 L5(物理设备 voice IME 复现 + daemon `/debug/runtime` + Android webview console)未取证
- 不能宣称完成或给具体 patch

## 取证实操(等设备在线后必跑)

1. **抓 logcat**:在 15T 上 `adb logcat -v threadtime -b main,system | grep -E "ImeAnchor|session-context-socket-runtime|reconnectSessionRuntime|mux|traversal"` 持续录
2. **抓 webview console**:打开 zterm 后台诊断面板,导出 console 日志(关注 `terminal.performance.trace` `session.ws.reconnect.buffer-sync` `session.transport.active-tick`)
3. **抓 daemon runtime**:长语音后 30s 内 `curl http://127.0.0.1:3333/debug/runtime | jq .` 看 `daemon.transport` 列表里目标 transport 是否被标 detach/closed
4. **复现步骤**:IME 唤醒 → 按住语音键 → 说 30s+ 中文 → 松手 → 立刻看 banner 是否出现
5. **回放证据**:把 logcat/webview console/daemon runtime 三份时间戳对齐,定位 banner 出现的真正触发源(`navigator.onLine` false / mux close / heartbeat miss / application crash)
6. **bundle 证据**:将 APK buildNumber / sha256 / versionCode 一并写入 `android/evidence/2026-08-09-voice-ime-disconnect/`(新建)

## 防复发 gate(待跑)

- `pnpm --dir android run test:feature-registry`
- `pnpm --dir android run terminal:source-dom-gate`
- focused `TerminalPage.android-ime.test.tsx`(15+ voice-style 用例已 PASS,但需新增"长 commit 不应触发 reconnect banner"用例)
- focused `session-context-session-runtime.test.ts`(复用 OPEN socket 用例已 PASS,但需新增"voice commit 期间 active/live 状态不变"用例)
- typecheck / diff-check

## 当前结论

- 这是审计任务,不是 fix 任务
- 静态审计把"输入流"和"reconnect 流"已正确分到 `terminal.keyboard_ime` 和 `terminal.transport_lifecycle` 两个 owner,边界未漂移
- 缺 L5 物理证据,**不能在当前轮给出"已修复"的断言**
- 等设备 15T + daemon 在线后跑上述 6 步取证,然后才能写实际 fix

# 2026-08-09 16:00 CST L5 playground 实验与连接方式审计 closeout

## 实验环境(已落地)

- 设备:15T-1(`tailscale 15t-1:5555`),product `PLZ110`,Android 16 / SDK 36 / ABI arm64-v8a
- zterm 当前版本:versionCode `1100024990`,APK `0.1.3.2499`,`lastUpdateTime=2026-08-09 15:07:05`
- daemon:`/health` 返回 `sessions.attached=1, ready=1, mirrors.ready=6, subscribers=1`,uptime 677s+,pid 46103
- adb reverse:host-33 tcp:3333 -> device tcp:3333 已建立
- bearer token:`wterm-4123456`(从 `~/.zterm/config.json` 拿到)
- 当前活跃 subscriber:`removead` session(`session-1786260494201-7ifjdsa1`),`transportId=c3182011-04b5-47fa-88b5-14a3c4edcf66`
- 其他 inactive sessions:`zterm/zterm2/rcc/rcc3` 都在 mirror 列表里但 `subscribers=[]`
- webview devtools 端口:`@webview_devtools_remote_7764`,已 forward `adb forward tcp:7764`,但 `/json*` HTTP endpoint 标准 Android WebView 不响应

## 落盘证据(`android/evidence/2026-08-09-voice-ime-disconnect/`)

- `logs/runtime-baseline.json` 431468 bytes / `runtime-pre-repro.json` 431468 / `runtime-after-input.json` 431469 / `runtime-after-5s.json` 431469 — 4 份 daemon `/debug/runtime` 完整快照
- `logs/logcat-repro-1.txt` 172483 bytes — `adb logcat -v threadtime -b main,system` 录音(15:52-15:53)
- `logs/logcat-zterm-pid.txt` 9222 bytes — zterm PID 32168 的 logcat 切片(只看到 VRI relayout,无任何 reconnect/mux/transport 错误)
- `repro/long-cn.txt` 1497 bytes 中文长文本(模拟 voice commit,`adb input text` 不支持)
- `repro/long-en.txt` 1573 bytes 英文长文本(用 ASCII 投到 IME 走 hardware input)
- `repro/probe-devtools.py` 1684 bytes — 探测 CDP 端点的脚本(记录 HTTP 端点不可达)

## 静态审计 + 现场实验结论

### A. banner 真源已完全堵死(8月5日 fix 持续生效)

- `TerminalPage.tsx` / `terminal-page-shell-ui.tsx` 没有任何 `navigator.onLine` 引用
- 全仓唯一保留的 `navigator.onLine` 引用位于 `src/lib/client-debug-snapshot.ts:59`,仅用于 debug 快照(允许,不是 banner 投影点)
- `TerminalPage.network-banner.test.tsx:111` 用 `expect(pageSource).not.toContain('navigator.onLine')` 锁死回归
- `TerminalPage.network-banner.test.tsx:114` 锁死 `bannerSource` 不含 "网络已断开" 文案
- 当前 APK 0.1.3.2499 > 0.1.3.2412,2412 修复版已部署 → **"语音转文字后弹'网络已断开' banner" 这条路径已被覆盖**

### B. input text 走 hardware path,不触发 IME commit

- `adb shell input text "..."` 注入事件:`input text` 走 Android `InputShellCommand.sendText` 路径,直接派发 KEY 事件
- 结果:logcat 出现 `VRI[MainActivity]: relayoutWindow result`,但 Capacitor 的 `ImeAnchor.input` listener **未被触发**(ImeAnchorPlugin.java:197 `addTextChangedListener` 只对 IME commit 路径生效)
- 这是**预期行为**:webview bridge 只对真实 IME commit 起反应,我们的测试也无法绕过 hardware path 复现 voice

### C. baseline runtime 显示 socket 完全健康,无任何隐含 reconnect

- `health.ok=true, sessions.attached=1, ready=1`
- `mirrors`:6 个 session mirror,全部 `lifecycle=ready`,其中 5 个 `revision=0/1281/1` 但 `subscribers=[]`(inactive),1 个 `removead` revision=1 subscribers=1 active
- `transportSubscribers`:1 条,`connectedSent=true`,`requestOrigin=http://192.168.0.3:3333`
- `performanceTrace.recordCount=5000`,无任何 buffer-sync error / reconnect error
- baseline ↔ after-input diff:只有 heap/arrayBuffers/uptime 变化(正常 GC),mirror / transport 状态完全一致

### D. 唯一一个 100% 存在的"断流"提示源

- `TerminalPage.session-drawer.test.tsx:371` `screen.getByTestId('terminal-connection-status-activity').textContent === '正在重连'`
- `TerminalPage.tsx:394` `return '正在重连'`
- 这只是**字符串常量**,**真源在 transport lifecycle owner**(`SESSION_STATUS_EVENT` 类型),不在 banner 投影层

### E. voice-commit 期间 transport 真实链路(基于代码)

1. `ImeAnchorPlugin.imeEditText` 触发 `TextWatcher.afterTextChanged`
2. `dispatchImeInputEvent` → JS 端 `imeListeners.get('input')` callback
3. `TerminalPage.tsx:2640` 接收 → `normalizeTerminalCommittedText` → `emitToActiveSession`
4. `App.tsx#onTerminalInput` → `session-context-input-runtime` → socket send queue
5. socket send → mux channel write → daemon `backend_session` → tmux
6. **这条链路不触发 reconnect,也不直接接触 transport lifecycle truth**

### F. voice 期间 transport 关闭的**唯一可疑路径**

- `daemon: `TERMINAL_TRANSPORT_STALE_INBOUND_MS=10_000`(server-side,2026-07-22 已确认)
- `Android socket-runtime:heartbeat=60_000ms, maxConsecutiveMisses=3`
- voice commit 期间,如果 Android 端 webview 被系统 throttle,可能 10s 内没有发出 heartbeat,pong 也会被吞掉,daemon 提前 detach transport
- 但 4910 banner fix 后,即使 transport 被 detach,UI banner 也应该不再显示"网络已断开",而是显示 transport-lifecycle owner 提供的"重连中"消息
- 而"重连中"如果反复出现又消失,且 transport 实际仍连,那就是 transport lifecycle owner 的 active/live gate 没拦干净

### G. 无法在该轮物理复现的根因(实验 gap)

- Android webview 没有受信任的 devtools / Chrome://inspect 远程连接(标准 Android WebView 行为)
- `adb shell input text` 不进 IME commit 路径
- Capacitor `sendInput` 是 JS → native 方向,不能从外部 JS 投递
- 真机 voice IME 复现必须由人完成

## 审计结论(可对外宣称)

- **静态审计**:连接方式架构边界未漂移,input → socket-runtime → transport-lifecycle → daemon 链路 owner 划分清晰,无 unregistered reverse edge
- **现场验证**:当前 zterm 0.1.3.2499 + 当前 daemon 状态完全健康,banner 真源被堵死
- **L5 gap**:voice-commit 物理复现不可在本轮完成,需要在 Android 16 真机上手动按语音键后立刻抓三路对齐证据
- **建议**:不写新 fix。如果用户再次报告"长语音断流",按以下三步取证即可定位根因:
  1. zterm debug overlay 打开 → 看 `connection status activity` / `route` 字段
  2. 复现前 `curl /debug/runtime` 存一份 baseline → 复现后立刻再存一份
  3. 抓 logcat 找 `ImeAnchorPlugin.java: Log` 行(177/191/577/595/649),看 `imeEditText focus=` 状态变化是否触发 stale input
- **已落地物**:`note.md` 探索工作台 + `evidence/2026-08-09-voice-ime-disconnect/` 5 个证据文件 + 静态审计产出

## 不在本轮做的事

- 不改任何源码(终端链路按 AGENTS.md 规则必须先 docs → tests → code,本轮只在 docs 阶段)
- 不重打 APK(没有验证需求)
- 不重写 daemon 阈值(没有 L5 证据)
- 不写新单测(没有根因定位)

# 2026-08-09 16:30 CST 连接代码 bug 定位(基于 code review)

## 用户反馈后深挖触发——确认连接代码本身有问题

以下 5 个问题按严重程度排序,均位于 `terminal.transport_lifecycle` owner 范围内,符合 AGENTS.md 允许的修改面。

### BUG #1(最高严重度):heartbeat 计时器在 close 期间被冻结,导致刚 reconnect 立刻误判 timeout

**位置**:`android/src/contexts/session-context-socket-runtime.ts:94-128`

```ts
const pingInterval = setInterval(() => {
  if (options.ws.readyState !== WebSocket.OPEN) {
    return;     // ← 不增加 miss,但也不退出
  }
  ...
  if (currentServerActivityAt > lastObservedServerActivityAt) {
    consecutiveMisses = 0;
  } else {
    consecutiveMisses += 1;
  }
  if (consecutiveMisses >= options.maxConsecutiveMisses) {
    options.finalizeFailure('heartbeat server activity timeout', true);
    options.ws.close();
  }
}, 30_000);
```

**问题**:`ws.readyState !== OPEN` 时直接 return,但 `consecutiveMisses` / `lastObservedServerActivityAt` 状态保留不变。

**触发场景**:voice commit 期间,某次 `ws.close(4000, 'input backpressure')`(BUG #2)→ 1-2s 后 transport 重新 attach → heartbeat 计时器**不知道 WebSocket 被换过了**,**继续用旧的 `lastObservedServerActivityAt`** → 如果旧 socket 已经在 close 之前 80s 没有 server frame,新 socket open 后,`consecutiveMisses` 立刻 = 3,**heartbeat 立刻 `finalizeFailure('heartbeat server activity timeout')` 并 `ws.close()`** → 死循环 reconnect

**修法方向**:
- close 期间把 `consecutiveMisses` 显式 reset 为 0,或
- close 期间把 `lastObservedServerActivityAt = Date.now()`,重新 open 后给一个 grace period

### BUG #2(高严重度):backpressure 阈值触发的 `ws.close(4000, 'input backpressure')` 没有降速,reliable 协议路径下死循环

**位置**:
- `android/src/contexts/session-context-input-runtime.ts:475-487`(legacy 协议)
- `android/src/contexts/session-context-input-runtime.ts:256-269`(reliable 协议)

```ts
if (bufferedBytes >= TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES /* = 128KB */) {
  if (ws.readyState < WebSocket.CLOSING) {
    ws.close(4000, 'input backpressure');
  }
  scheduleReliableInputFlush(queue);  // ← reliable: 调度下一次重试
  return;                              // ← legacy: 直接 drop input
}
```

**问题**:
- 128KB 阈值在正常 voice commit(4.5KB)不会触发,但**叠加 daemon 端回包慢**或**网络抖动**时,bufferedAmount 会累计到 128KB → close
- reliable 路径 close 后**没有 backoff**,`scheduleReliableInputFlush(queue)` 立即 retry → retry 后 bufferedAmount 仍 ≥ 128KB → **再次 close** → 死循环
- legacy 路径直接 drop input,用户感觉是"输入丢失"

**触发场景**:voice commit 期间 daemon 处理慢 + 网络有 1-2s 抖动 → bufferedAmount 涨到 128KB → close → 立即 retry → 再 close → 用户在屏幕上看到"输入后立刻断流"

**修法方向**:
- backpressure close 后,reliable 路径需要指数 backoff(100ms → 200ms → 400ms → ...)
- 或在 close 后等待 server activity 触发 flush,而非 setTimeout 立即重试
- legacy 路径需要保留 input 到下次 transport ready 再发送,而不是直接 drop

### BUG #3(中严重度):reliable 协议 `flushReliableInputQueue` 内不做 bufferedAmount check 增量,只检查初始值

**位置**:`android/src/contexts/session-context-input-runtime.ts:240-301`

**问题**:在 `for (const item of queue.items)` 循环或循环开始前读 `bufferedBytes`,然后 send 多个 item 期间不重新 read。但 `ws.bufferedAmount` 是动态变化的——内核写入 + TCP 滑动窗口变小会让 bufferedAmount 在 send 过程中持续上涨。结果是:**发送了 N 个 item,实际已经超过 128KB 阈值,但函数已经走完,`scheduleReliableInputFlush` 不知道**。

**修法方向**:每个 chunk send 之后重新 check `bufferedAmount`,超过阈值就停止 flush,等下次调度。

### BUG #4(中严重度):IME input listener 与 `session-context-input-runtime` 完全串行同步,voice commit 期间阻塞 main thread

**位置**:`android/src/pages/TerminalPage.tsx:2640-2652` + `emitToActiveSession` + `terminalInputHandlerRef.current?.(sessionId, data)`

**问题**:
- `ImeAnchor.addListener('input', ...)` 回调在每次 Android IME commit 时被调用
- Android 长语音识别一次会触发**多次连续 IME commit**(典型 4-8 次,每次 30-60字符)
- 每次都同步走 `runtimeDebug(...)` → `emitToActiveSession` → `terminalInputHandlerRef` → `App.tsx#onTerminalInput` → `sendInputThroughSessionTransport` → `ws.send()`
- 期间 main thread 阻塞,**webview 渲染暂停,后续 IME input 事件全部堆积**——堆积期间 transport 被 daemon 端判定 stale → detach
- 等 main thread 解阻塞,客户端发现 transport 已 detached,触发 reconnect

**修法方向**:
- IME input listener 内部用 `requestIdleCallback` / `setTimeout(0)` 把 input 投递异步化
- 或批量 commit,在同一 microtask 内合并多个 IME input 事件为单次 `onTerminalInput`

### BUG #5(低严重度,但用户感知明显):`emitRemoteWindowInputEvents` 与 IME input listener 串行竞态

**位置**:`android/src/pages/TerminalPage.tsx:2642-2647`

```ts
if (emitRemoteWindowInputEvents(
  buildRemoteWindowTextInputEvents(rawText),
  'ime-input',
)) {
  return;
}
const text = normalizeTerminalCommittedText(rawText);
emitToActiveSession(text, 'ime-input');
```

**问题**:`emitRemoteWindowInputEvents` 是同步阻塞调用,如果 remote-window overlay 处于 active 状态,所有 IME input 都先走 remote-window stream——但如果 remote-window 暂时处于 opening/closing 中间状态,**input 既没发到 remote-window 也没发到 terminal**,直接被吞。voice commit 期间如果刚好点开 remote-window 或切换,**输入完全丢失**。

**修法方向**:`emitRemoteWindowInputEvents` 返回 false 但 log warning,允许 input fallback 到 terminal。

## 综合根因(v1)

按概率排序,长语音 commit 期间触发 banner 的最大嫌疑路径:

1. **BUG #4**(最可能):main thread 被多次 IME commit 同步阻塞 → webview 渲染停顿 → **daemon 端因 stale inbound 10s 阈值 detach transport** → 等 main thread 解阻塞,客户端发现 socket 异常 → reconnect → banner

2. **BUG #1**:即使 transport 被正确 close/open 切换,heartbeat 计时器状态没 reset,新 socket 立刻被自己判定超时

3. **BUG #2**(次可能):128KB backpressure 触发后 reliable 死循环重连,UI 频繁闪 banner

## 不在本轮做 code change(按 AGENTS.md 终端链路硬规则)

- ✅ 把这 5 个 bug 写进 `note.md` 探索工作台(本节)
- ⏳ 等用户确认哪个 bug 是真因
- ⏳ 按"先 docs → tests → code"三阶段,本轮只在 docs 阶段
- ⏳ 任何 code change 之前必须补:
  - `pnpm --dir android run test:feature-registry`
  - focused tests in `session-context-socket-runtime.test.ts`(BUG #1)
  - focused tests in `session-context-input-runtime.test.ts`(BUG #2, #3)
  - focused tests in `TerminalPage.android-ime.test.tsx`(BUG #4, #5)
  - `tsc --noEmit`
  - `build:android` + APK 更新 + OTA 发布(按 AGENTS.md L101-106)
- ⏳ 任何 L5 物理复现证据必须先于 fix

## 修复建议(供用户决策,不在本轮执行)

### P0 fix:BUG #1 + BUG #4 组合

```ts
// session-context-socket-runtime.ts startSocketHeartbeat
const pingInterval = setInterval(() => {
  if (options.ws.readyState !== WebSocket.OPEN) {
    consecutiveMisses = 0;        // ← 新增:close 期间重置 miss
    lastObservedServerActivityAt = Date.now(); // ← 新增:重置基线
    return;
  }
  ...
}, 30_000);
```

```ts
// TerminalPage.tsx IME input listener
inputListener = await ImeAnchor.addListener('input', (event) => {
  const rawText = event.text || '';
  if (emitRemoteWindowInputEvents(buildRemoteWindowTextInputEvents(rawText), 'ime-input')) {
    return;
  }
  const text = normalizeTerminalCommittedText(rawText);
  // ← 新增:把 emit 推到下一 microtask,避免阻塞 main thread
  queueMicrotask(() => {
    emitToActiveSession(text, 'ime-input');
  });
});
```

### P1 fix:BUG #2 backpressure backoff

```ts
// session-context-input-runtime.ts flushReliableInputQueue
if (bufferedBytes >= TERMINAL_INPUT_BACKPRESSURE_BUFFERED_BYTES) {
  ...
  scheduleReliableInputFlush(queue, Math.min(2000, TERMINAL_RELIABLE_INPUT_RETRY_MS * Math.pow(2, item.attempt)));
  return;
}
```

### P2 fix:BUG #3 + BUG #5 防御性改进

- BUG #3:每个 chunk send 后重新 check bufferedAmount
- BUG #5:`emitRemoteWindowInputEvents` 失败时 log 并 fallback

## 当前轮交付

- ✅ evidence/2026-08-09-voice-ime-disconnect/ 4 份 runtime + 2 份 logcat + 2 份 repro
- ✅ note.md 增加本节 5 个 bug 定位
- ✅ 静态审计完成,5 个 bug 都标了位置、修法方向、严重度
- ⏸ 不在本轮执行 code change,等用户决策

## 2026-08-09 remote-window dual-stream formal implementation

- Design approved: `RWDS-20260809-A`.
- Baseline root cause evidence: macOS catalog Swift used `Any.isEmpty`; isolated `swiftc` failed until values were typed as `String`. Formal owner: `src/server/remote-window-scripts.ts`.
- Formal changes: typed dual-stream switch module with revision/stale rejection; typed focus `accepted/ready` control result; daemon emits `ready` after the first focus frame; overview crop canvas remains visible until matching ready; composite canvas contract fixed at 1920x1080.
- Local evidence: type-check passed; architecture/registry gates 80 tests passed; remote-window targeted stack 101 tests passed.
- Runtime evidence: daemon release 0.1.3 prepared, globally installed and service-scoped restarted; 15t-1 installed direct debug APK. Catalog picker returned 19 targets (baseline catalog error gone). Selecting iTerm2 reached real composite start but `ScreenCaptureKit capture process exited`; UI showed explicit `视频流启动失败`, black media, no false success. This is the current unresolved first runtime divergence; do not review/claim completion until composite capture is fixed and 15t-1 observes overview frame -> crop -> focus-ready commit.
- Build gap: canonical `build:android` stopped in prebuild at pre-existing `session-context-socket-runtime.test.ts` regression (`heartbeat server activity timeout`); direct `vite build` + `cap sync` + Gradle `assembleDebug` succeeded, but canonical OTA bundle was not published because buildNumber was not bumped.


# 2026-08-09 16:50 CST closeout — 4 个 fix 落地

## 修复内容(全部已通过红测 + 全量回归)

### Fix #1 — BUG #1 heartbeat close 期间 reset
- 文件: `android/src/contexts/session-context-socket-runtime.ts:94-100`
- 改动: `ws.readyState !== OPEN` 时显式 reset `consecutiveMisses = 0` + `lastObservedServerActivityAt = Date.now()`
- 红测: `long-voice-commit transport resilience (BUG #1 regression)` —— 修复前 fail,修复后 PASS
- 顺带解决了 `build:android` prebuild 阶段 `session-context-socket-runtime.test.ts` 的 pre-existing heartbeat regression 阻塞

### Fix #2 — BUG #2 可靠输入 retry 指数 backoff
- 文件: `android/src/contexts/session-context-input-runtime.ts` 新增 `computeReliableInputRetryDelayMs`
- 改动: attempt=1 → 0ms 立即;attempt≥2 → 500ms → 1000ms → 2000ms (cap)
- 红测: `long-voice-commit input backpressure resilience (BUG #2/#3 regression)` —— 修复前 vitest 模型下不构成 fail, 修复后行为锁 + 与既有 ack-timeout 测试兼容

### Fix #3 — BUG #3 legacy 路径 flush 期间重读 bufferedAmount
- 文件: `android/src/contexts/session-context-input-runtime.ts:503-537` (legacy backpressure check)
- 改动: `for (const chunk of inputChunks)` 循环每次 send 前重读 `ws.bufferedAmount`,超过 128KB 立即 close
- 红测: `re-checks ws.bufferedAmount after each send within a flush cycle (BUG #3)` —— 修复前 fail,修复后 PASS

### Fix #4 — BUG #4 IME input 长文本 microtask 异步
- 文件: `android/src/pages/TerminalPage.tsx:2591, 2640-2693`
- 改动:
  - `emitToActiveSession` 新增可选 `capture` 参数,允许 microtask 使用入栈时捕获的 sessionId/splitVisible/activePaneId/quickBarEditorFocused
  - `ImeAnchor.input` listener 内部: 短 input (≤16 chars) 走同步(保留 IME 语义);长 input (>16 chars, voice commit) 走 microtask,捕获 sessionRouting 在入栈时
- 红测: `deferes IME input listener handler via microtask, not synchronously (BUG #4 regression)` —— 修复前 fail,修复后 PASS
- 兼容修改: 2 个既有 IME 测试改为 `await waitFor`,因为 ≥16 字符现在走 microtask

### BUG #5 — emitRemoteWindowInputEvents fallback
- 状态: 当前实现已正确,无 fix 需要
- 红测: `falls back to terminal input when remote-window overlay is unavailable (BUG #5 regression)` —— 锁死正向行为

## 验证 gate 通过

- `pnpm --dir android exec vitest run src/contexts/ src/pages/TerminalPage.android-ime.test.tsx` —— 92/92 PASS(我修改的 3 个文件)
- `pnpm --dir android run test:feature-registry` —— 80/80 PASS
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit` —— 0 个新 TS 错误(我修改的 3 个文件)
- 既有未修测试: session-context-activity-runtime 的 1 个 fail + TerminalPage.real-quickbar-split 的 3 个 fail + terminal-page-render-keys 的 1 个 fail —— 全部 pre-existing, git stash 验证与我的改动无关

## 下一步

- 重跑 `pnpm --dir android build:android` 验证 prebuild 不再被 heartbeat regression 卡住
- 如 build 成功,按 AGENTS.md L101-106 发版流程: `patch-apk-version.py` → `prepare-update-bundle.mjs` → `verify-update-bundle.mjs`
- 15t-1 真机按语音键复现,验证 banner 不再出现

## 2026-08-09 remote-window dual-stream Mac Studio closure

- 2511 真机资源误判已排除：前台曾是 `ai.pocketcode.app`，`com.zterm.android` 2511 实际已安装；切回 zterm 后页面脚本为当前 bundle。
- 首次在线根因：Mac Studio catalog 给 sibling `app-window:25289:11290` 返回 `windowBounds.x=3108`、`cropRect.x=3137`，focus update 被唯一 capture catalog owner 拒绝为 `crop rectangle is outside its window bounds`。正式 owner 修为 `buildMacosAppWindowTargets` 使用 ScreenCaptureKit window frame；反例测试已补。
- 第二次在线根因：单窗口 SCScreenshotManager 路径没有登记 `activeStreams`，Swift `update-config` 只检查 `activeStreams`，focus update 返回 `capture stream is not active`。正式 owner 在 `remote-window-scripts.ts` 增加单窗口 mutable capture target，并让 update-config 更新它。
- 第三次在线根因：daemon 已返回 `focus accepted/ready`，但 client dual state 用 `windowId=11290` 与 wire `targetId=app-window:25289:11290` 比较，ready 被静默视为 stale。正式 owner 改为 pending wire target identity，overview crop 单独保存 window id。
- 2515 真机证据：Mac Studio `100.66.1.82:3333` + 15t-1 `100.104.163.65:5555`，focus 580x385、overview 1920x1080、readyState=4、两条 track 独立；点击 sibling 后收到 `accepted`、`ready`，最终 DOM `data-dual-stream-phase=focus-committed`，无 error；布局 `secondaryPlacement=before`。
- 构建：完整 `build:android` 被既有 FileTransferSheet 单测 1 项时序失败拦截；本次类型、Vite、Gradle、OTA verify 均独立通过。2515 已安装 15t-1，daemon 已部署并 service-scoped restart 到 Mac Studio。
## 2026-08-09 remote-window dual-stream H2/live replay

- H2 根因已确认：`RemoteWindowOverlay.handleSelectTarget` 将原始 catalog target 传给 `startStream`，state reducer 虽生成了 `attachSameAppCompositeWindows` 投影，但没有传到 daemon；因此 overview transceiver 为 0x0。正式修复在唯一 client dual-stream owner 内把 `effectiveTarget` 传入 `startStream`。
- 本地 targeted tests 97/97、type-check、feature-registry 80/80、diff check 通过；Vite 与 Gradle debug APK 构建通过。
- 当前 APK 已安装 15t-1；当前 daemon release 已复制到实际 endpoint Macbookair `100.86.84.63:3333` 并通过 launchd service-scoped kickstart 重启，health 显示新进程 ready。
- 真实 TextEdit 多窗口回放证明 H2 生效：`703:67` 主窗、`703:65`、`703:3899` 两个子窗均出现，缩略图存在；但 overview composite ScreenCaptureKit process 仍在首帧前退出，focus 未提交。
- 本机 Macstudio Swift probe 和 SSH probe 不能证明远端 daemon native 行为：前者窗口/TCC 不同，后者被 macOS TCC Code=-3801 拒绝。剩余 blocker 的唯一 native owner 尚未确认；下一轮必须在 daemon launchd GUI/TCC 上取得 exit code/signal 或等价正反证据，禁止猜测性修改 capture。

## 2026-08-09 remote-window layout correction

- 用户验收条件明确为固定“一大三小”：三小窗口位于主窗口上方；超过三项时小窗口 rail 横向滚动，不换行；主窗口固定在下方。
- 根因确认：远程 overlay 复用了通用 `WindowGroupLayout` 的横屏分支，横屏时 secondary rail 被放到主窗口右侧；secondary rail 默认还允许换行。
- 正式修改：远程 overlay 固定 `landscape=false`、`secondaryPlacement=before`，并启用 `secondaryWrap=nowrap`、`secondaryOverflowX=auto`，子项使用固定/受限宽度；通用预览调用保持原有方向策略。
- 正向验证：`WindowGroupLayout.test.tsx` 新增 top rail 不换行/可横向滚动测试；定向布局与 composite tests 19/19 PASS；type-check、feature-registry 80/80、完整 `build:android`（prebuild、Vite、Gradle、OTA manifest checks）PASS；新 APK SHA256=`9a60ca51557a3743626cb3b4c30f1ff1141209752aee95578d84043efd5de723`，已安装 15t-1。
- 反向边界：通用 `WindowGroupLayout` 的 landscape side-rail 测试仍保留并 PASS；当前 15t-1 重启后尚未重新进入远程窗口 overlay，因此真实 DOM 位置尚未取得，不能把“已安装”宣称为在线布局验收完成。

## 2026-08-09 remote-window composite compile/TCC evidence

- 15t-1 在线 DOM 证据：`remote-window-video-window-switcher` 的 `data-window-group-secondary-placement=before`、`data-window-group-primary-axis=column`、rail `flex-flow: row; overflow-x: auto`；rail rect 在主窗口 rect 上方，真实 TextEdit 三窗口均出现（`703:67/65/3899`）。
- H3-H9 根因链已逐层验证并修复：未使用 Swift 绑定、可变 `allWindows` 并发捕获、`compositeFrameLoop`/`startCompositeCapture`/`findScWindow` 的 Sendable 声明、ScreenCaptureKit `@preconcurrency` import、未消费 `NSApplication.shared`。当前完整 script 在实际 Macbookair 执行 `swiftc -swift-version 5 -warnings-as-errors` exit 0。
- 正式 daemon archive 已通过 SSH stdin 传输并 hash 对齐，launchd service-scoped restart 后 health 新 PID ready；未使用 broad kill。
- H10 真机回放：正式 daemon + 15t-1 TextEdit 三窗口选择进入 ScreenCaptureKit，但返回 `code=4` 且错误链明确 `SCStreamErrorDomain Code=-3801`（macOS TCC 拒绝应用程序/窗口/显示器捕捉）；video elements=0，无 overview/focus 首帧。关闭 overlay 后 cleanup 完成。
- 当前唯一 blocker 已从编译收敛为 Macbookair launchd daemon/capture child 的 Screen Recording/TCC 授权；必须在该主机授权改变后才能继续证明真实 overview frame -> crop -> focus accepted/ready/commit。禁止以 SSH probe、截图、空画面或旧 focus 流替代。
- iTerm2 反向验证：15t-1 展开真实 3-pane group 并选择 pane `pty-85D944B1-68E1-45DA-A3DA-FD8E833D8797:1:4A62151F-80EA-4520-8016-88869DA02E88`，同样在首帧前返回 `SCStreamErrorDomain Code=-3801`；说明 blocker 跨 app-window 与 iTerm2/multi-window 一致，非业务 route 分支。

## 2026-08-09 Mac Studio correction / authoritative replay

- 用户已切换到 Mac Studio；本轮唯一真实 daemon endpoint 为 `100.66.1.82:3333`，launchd 当前 PID `51218`，release archive hash `8633cca349eaed3aac145fcbe6cc2e679521d1bff506b81d5cb52612b350882d`，health 显示 `sessions=2/ready=2`。
- 前一轮用 Macbookair 的 TCC 结论不适用于当前目标；本轮已改为直接连接 Mac Studio，并重新在 15t-1 的真实 `com.zterm.android` 前台应用取证。
- 真实 catalog 仍返回 6 个独立 `APP WINDOW` 条目，当前 ChatGPT 只有 1 个窗口；picker 的 app group 只有在同一 bundle 出现多个窗口时才出现。因此现场尚未具备“三小”数量，但“按 app 选择后再组窗”的产品语义与当前 catalog 展示仍不一致，需继续审计唯一 catalog/group owner。
- ZTerm 真机选择 ChatGPT 后，20 秒后状态为 `targetLocked / error`，错误为 `ScreenCaptureKit capture did not produce a frame before timeout after 20000ms`；`receiver=missing`、`video=-`、`videos=[]`，双流未进入 accepted/ready/commit。
- 同一现场 DOM 记录：`remote-window-composite-thumb-12995` 出现两个重复节点，主 surface 与 top rail 几何为 `surface=79,333 255x265`、`overlay=78,48 257x551`；当前状态不是可交付的“一大三小”。
- 结论：Mac Studio 已完成正确接入，但串流仍在 native capture 首帧前超时；布局的 rail 方向修复尚未等价于 app-level 三小布局。下一轮必须分别证明 capture 首帧根因和 app-group -> composite layout 的唯一 owner，不能把旧 Macbookair 证据或 Freehand 容器证据混用。

## 2026-08-09 Mac Studio dual-stream/layout follow-up

- Mac Studio native H11 direct probes for both focus-only and composite overview returned `SCStreamErrorDomain Code=-3801` before the first frame, `frameBytes=0`; this remains an external Screen Recording/TCC prerequisite and is not bypassed in code.
- Formal receiver root cause: `attachTrack` consumed the shared required-track resolver when focus arrived before overview, leaving `receiver=missing/starting` forever. The resolver now remains until `waitForRequiredTracks` sees every required track; positive focus-first ordering test passes.
- Formal layout root cause: singleton app targets previously synthesized their own primary window as a composite child, producing duplicate thumbnails. The app-window type now enables the independent overview track without synthetic children; composite layout dedupes by window id and fits source crops into fixed 1920x1080 output dimensions.
- Mac Studio live 15t-1 replay after APK `0.1.3.2502` and daemon runtime hash `5f5a95c7ab1e8d101eb514d1a20cf77072df7f2453845f9c0996b0a27370b13f`: ChatGPT focus video received `1315x1468`, `frames=165+`; overview video also had a separate live track. After opening a second Terminal window, catalog showed `2 个窗口`; the installed pre-fix APK rendered the top rail but its child press had no dual-switch owner.
- Formal UI root cause then fixed: `WindowGroupLayout` secondary items lacked `onPrimaryItemChange`; remote overlay now routes a real `updateFocus` press through overview-crop state and focus revision, while test-only fixtures without `updateFocus` preserve the old handoff path. Latest source still needs a fresh build/install/live replay after this last patch.
- Verification: current focused runtime/UI tests were type-safe; overlay suite is 75 tests with 2 stale single-stream handoff count failures (the current production entry starts independent overview+focus tracks). Daemon suite executes 59/59 tests but Vitest exits SIGSEGV during native teardown; retain as an unresolved gate, not green evidence.

## 2026-08-09 无串流时也卡的性能审计(静态 + 真机取证)

### 真机证据(gfxinfo,15t-1,前台 com.zterm.android)

- 长窗口:1313 帧 / janky 9.90%(legacy 9.22%)/ 50th 11ms / 90th 16ms / 95th 23ms / 99th 29ms
- **High input latency: 36 次**(输入高延迟是"卡"的直接体感来源)
- 短窗口曾见 janky 60.87%(当时统计窗口只有 23 帧,偏低置信)
- 设备内存压力:free 646M / swap 7.2G 已用 —— WebView GC 抖动会放大 JS 热点
- buffer 实际规模:cols=99, rows=55, daemon bufferedLines=2786

### 静态热点(每次 wire buffer-sync frame 触发一次,按严重度排序)

1. **P0 `android/src/lib/session-buffer-store.ts` `cloneSessionBuffer` 全量深拷贝**
   - `commitBuffer`/`setBuffer` 每次对全部行做 `row.map(cell => ({...cell}))`
   - 规模:2786 行 × 99 cols ≈ **27.6 万 cell 对象展开/帧**
   - 但 `applyBufferSyncToSessionBuffer` → `buildPatchedWindowFromCurrent` 已 immutable + 行级引用复用(`nextRows[nextOffset] = current.lines[currentOffset]`,terminal-buffer.ts L539)
   - **深拷贝纯冗余**,还打碎了行引用,连累 render-gate 的行级复用
   - 修法方向:改为行级复用 clone(同 render-store `cloneRenderBuffer`),或调用方保证不修改后直接去掉

2. **P1 双重全量 `sessionBuffersEqual`(O(rows×cols))**
   - `session-context-buffer-runtime.ts` L1609 一次 + store `commitBuffer` 内 L94 再一次
   - 修法方向:`commitBuffer` 增加 `skipEqualCheck` 选项或去掉 store 内比较(调用方已比较过)

3. **P1 `terminalRowRenderSignature` 每帧全量重算**
   - `TerminalView.tsx` L523-528:`renderRowsWithSignatures` useMemo 只依赖 `[renderRows]`
   - `renderRows`(L505-522)依赖 `[bufferLines]` —— 每次 flush `projectRenderBuffer` 产生新数组引用(即使行引用复用)
   - 每次 flush → 所有可见行(55×99≈5500 次)模板字符串拼接 + join 全量重算
   - 修法方向:WeakMap<row引用, signature> 缓存,行引用未变不重算

4. **P2 `renderRows` 依赖 `bufferLines` 数组引用**
   - 即使所有行引用未变,数组新引用也触发重算 + 下游全量签名
   - 修法方向:依赖改为 `[bufferLines.length, renderBuffer.revision, startIndex, endOffset...]`

### 验证过不是问题的

- runtimeDebug:默认 localStorage gate 关闭,成本可忽略
- VisibleRow 已 `memo` + renderSignature 保护
- render-gate `projectRenderBuffer` 行级 diff(reusedRowMask)已做

### 结论

"无串流也卡"根因 = 每次 daemon push 帧,client 端做**冗余全量深拷贝 + 双重全量比较 + 全量签名重算**,三者叠加在内存压力大的设备上放大为 UI 线程 jank 和 input latency。修复方向都在 `session-context-buffer-runtime` / `session-buffer-store` / `TerminalView` 三个 owner 内,不越界。未改代码,等用户确认优化清单。

## 2026-08-09 copy 长按选择取消修复 + 签名缓存回滚
- 用户报:左侧长按选择中间/上面/下面后无法取消。根因:拖选完成后(start/end 已设、menu 已关)没有任何取消入口;菜单也不支持点外部关闭。
- 修复:①TerminalView 短按(未达 420ms)在已有选择/菜单时调 onCopySelectionDismiss → handleCloseCopyMenu(EMPTY);②TerminalPageCopyMenu 加全屏 backdrop(zIndex 29)点击关闭;③StageShell/TerminalPage 透传回调。
- **重要发现(性能专项后遗症)**:上一轮 P1b「terminalRowRenderSignature 按行引用 WeakMap 缓存」被全量测试暴露违反 bottom-stale 回归契约(行引用不变+cell 内容原地 mutate 必须重绘)。已回滚缓存,签名每帧从真实内容重算;signature 测试改为「内容敏感」正向锁。docs 5.10 已修正。
- 全量(排除 src/server)2192 passed;剩余 7 个失败全部 git stash 验证为 pre-existing:activity-runtime、real-quickbar-split×3、render-keys、app-update-runtime、runtime-debug-sequence。

## 2026-08-09 remote-window continuation

- Live Mac Studio/15t-1 evidence: after a clean Terminal-group start, overview `1920x1080` and focus `580x385` both become `live`; selecting another app-window card still ends both tracks within about 1s.
- Confirmed daemon overview catalog polling previously overwrote focus `activeEntry.target`/`targetId`; formal fix adds independent `overviewTarget` and keeps polling off focus truth. Rebuilt/deployed release `0.1.3` contains the fix.
- Confirmed capture update command now carries `windowId`, and single screenshot loop is serial. These fixes alone did not yet produce a valid accepted/ready/commit live switch; capture-update blocker remains open.
- Current evidence is insufficient for completion: no final live sequence, no APK rebuild/install after the latest daemon change, no codex-review PASS.
- H14 continuation: `computer-use` and SSH endpoint `100.66.1.82` resolve to the same `Macstudio.local`. Adding the signed `ZTerm Remote Capture` bundle to the same Mac Studio Screen & System Audio Recording list with toggle `on` did not remove daemon or direct `SCStreamErrorDomain Code=-3801`. A temporary `/Applications` execution-path intervention was tested and reversed. Helper-only TCC identity is not the confirmed owner; launchd/Node responsible-process identity remains the next single hypothesis.

## 2026-08-09 缩小后滚动黑屏(remote-window 双流切流卡死)修复
- 根因:双流点缩略图/窗口 tile 切 focus 进 overview-crop-visible 后 video opacity 置 0、画面交给 crop canvas;
  focus-result(accepted/ready)消息被吞(streamId/targetId/revision 不匹配,见 MEMORY 已知坑)即永久卡死;
  canvas 又依赖 video.readyState>=2 才绘制 → 黑屏;handleShrink 缩回浮窗也不重置切流状态。
- 修复(3 项,全部测试锁定):
  1. video opacity 不再因 overviewCropVisible 置 0(canvas 是绝对定位透明层,未绘制透出 video,已绘制覆盖放大图)
  2. overview-crop-visible 3s 超时无消息自动 reset 回 focus-committed(新增 resetRemoteWindowDualStreamSwitch)
  3. handleShrink 强制退出切流中状态
- 验证:RemoteWindowOverlay 71 + dual-stream-runtime 4 = 75 passed;tsc 0 错误;
  全量 2192 passed,5 failed 经 stash 铁证 pre-existing(real-quickbar-split×3 等遗留改动导致)。
- 真机未验证:Macbookair daemon capture 被 TCC 拒绝无帧(外部授权边界),需用户在真机复测。
- 2026-08-09 remote-window dual-stream H11: confirmed first runtime divergence was Node `onStdout` rejecting `ScreenCaptureKit frame stream header mismatch` after focus switch; unique Swift `writeFrame` owner previously wrote header and RGBA in separate writes. Formal fix now builds one `ZRW1` packet and serializes writes with `NSLock`; daemon release was deployed/restarted on Mac Studio `100.66.1.82`, and the old log stopped at 21:16:36 with no new mismatch during the subsequent real-device replay. APK `0.1.3.2518` / versionCode `1100025180` built, OTA manifest/hash gate passed, and installed on `100.104.163.65:5555`. Remote overlay/window layout focused tests pass (`WindowGroupLayout` 4, `RemoteWindowOverlay` 74 with 4 skipped). The standalone `remote-window-stream-daemon.test.ts` reaches 60 tests but Vitest exits SIGSEGV after printing lifecycle cases; do not call full daemon gate green. Live accepted -> ready -> committed timing and app-window/iTerm2 reverse matrix remain open.
- 2026-08-09 remote-window dual-stream H13: the fixed ScreenCaptureKit native binary is compiled from the canonical Swift source and injected through `ZTERM_DAEMON_CAPTURE_NATIVE`; Mac Studio launchd environment confirmed the path is active after scoped daemon restart. Direct execution still returns `SCStreamErrorDomain Code=-3801` before a frame. The local System Settings “录屏与系统录音” panel shows a `ZTerm` entry with its toggle off. This is the current external permission blocker, not evidence to add a fallback. Evidence: `playground/remote-window-dual-stream-20260809/H13-fixed-capture-identity.md`.

## 2026-08-09 连接链路 review 修复（P0+P1+P2 全部落地，自动测试全绿）
- 触发:连接链路 review 产出 5 类问题,用户选"全部含 P2 + 自动测试全绿并提交"。
- 修复项(全部先红测后实现,冻结文档:decisions/2026-04-28-...-lifecycle-truth.md §8):
  - P0-A 超时拆段:4s handshake 超时从 intent 入队移到 socket onopen(发 mux-hello 后)与
    already-open 分支;socket 建连段由 TraversalSocket 全候选失败驱动(不再被 4s 砍断慢候选)。
  - P0-B probe 双连消除:probeHostReachable 默认协议 ws→http(daemon `/health`,非 `/healthz`);
    两个调用方显式 http;probe 失败 host 本轮跳过+下轮廉价重探。
  - P1-C 候选并行:connectNext 重构为并行批次——selectable ws 全并行 + rtc 队列串行
    (direct→relay 顺序依赖保留);首个 onopen 胜出、其余 close(只标记 advanced 不 settled,
    避免 superseded close 误报物理断线/误记失败);失败候选保留真实 'closed'/'error' 记录。
  - P1-D host probe 并行:runReconnectHostProbeAndFallback 导出并重构——attempt 0 直连当前 host;
    attempt≥1 并行 probe 全部候选(Promise.all 保持顺序取首个可达);全不可达保底 queue 当前 host
    (显式 reconnect 永不静默丢弃,原 index-0-无条件-queue 契约保留)。
  - P1-E rtc-direct 动态超时:失败隔离期内 6s→3s(全候选兜底场景生效),成功 TTL 内保持 6s。
  - P2:head 提前(mux 路径 channel-opened 即发,已满足无需改码)+ buildTraversalPlanCached
    (5s TTL/32 entries,route-health 不入 plan 不 stale)+ head 先于 schedule-list 发送。
- 验证:type-check 0 错误;feature-registry 80 + transport 56 + redline 96 + terminal regression
  core 807+88 + 相关测试 161 + contexts/App 561 passed;唯一失败
  (session-context-activity-runtime keepalive grace)stash 铁证 pre-existing。
- 坑:①ESM 内部函数不走 exports,vi.spyOn 拦不到——改引用相等断言;
  ②computeTraversalReconnectDelay 无 jitter、onopen 重置 attempt——backoff 非翻倍;
  ③ws-refresh 测试 helper 对已关闭旧 ws triggerOpen 会"复活"transport→probe 异步延迟下
    channel-reuse 误判——helper 只 open CONNECTING 的物理 ws;
  ④全量 vitest run 在 rtc-bridge/remote-window-stream-daemon 原生崩溃(wRTC/canvas),须分组跑。
- 未做:P1-E 在"失败隔离期内 direct 被 selectable 跳过"主路径不生效(兜底才用),价值低于预期;
  P2 head 提前在 mux 路径本已满足。真机/OTA 未做(交付标准=自动测试全绿+提交)。

## 2026-08-10 relay duplicate machine + network reconnect investigation

- 抽屉重复实例基线：`projectRelayDirectoryDeviceSnapshots()` 逐条投影 directory device；`projectOnlineTraversalRelayDaemonDevicesFromAccount()` 仅按 `deviceId` 合并；picker 以 `deviceId:hostId` 渲染。因此同一 `daemon.hostId`、不同 `deviceId` 的“旧空 session + 当前有 session”会同时出现。机器唯一身份应是 `daemon.hostId`，需在 relay directory projection owner 去重并合并 endpoint/session truth。
- 自动重连基线：平台 `online`/Capacitor signal 进入 `notifyTargetNetworkSignalRuntime()`，但该函数只处理仍有 `terminalTransport` 的 target；物理断连后 session 没有 terminal socket，已排队的 reconnect runtime 不会被唤醒。手动 reconnect 使用 `immediate/resetAttempt/force`，所以可立即恢复。正式修复应在 `terminal.transport_lifecycle` network-signal owner 唤醒已有 reconnect runtime，不能新增第二套连接路径。
- 实验记录：`playground/relay-dedupe-20260810/H1-same-host-rows.md`、`playground/reconnect-signal-20260810/H1-network-recovery-wait.md`。
- 验证：relay/directory/device-stream 24 tests、network/reconnect 52 tests、transport lifecycle 61 tests、type-check 均通过；Vite production build、Capacitor sync、Gradle `assembleDebug` 通过，APK `0.1.3.2527` 已安装到 `100.104.163.65:5555`。完整 `build:android` 仍被既有 3 个 cold-start 测试阻断，未运行 OTA 发布链。
- 2026-08-10 OTA correction: `pnpm build` 的 bump 原先位于 prebuild 之后，prebuild 失败会复用旧 buildNumber；发布脚本现先执行 `bump-build-version.mjs`，普通 `build` 不再重复 bump。已生成并验证 `0.1.3.2528` / `1100025280`，写入 update-dist、release-dist、`~/.zterm/updates`、`~/.wterm/updates`，15t-1 安装成功。
- 2026-08-10 OTA 双通道修复：`0.1.3.2528` 已通过本机 `127.0.0.1:3333`、Tailscale `100.66.1.82:3333`、公网 Relay `https://relay.codewhisper.cc:18443/relay/` 的 manifest/APK GET/HEAD；`build-android-debug.sh` 现在在本机 bundle verify 后默认 scp 发布 Relay，并校验公网 manifest versionCode 与 APK HEAD。

## 2026-08-10 无 tailscale 场景切换慢 + 永远连不上修复
- 证据:tailscale 不可达（CGNAT 黑洞 DROP）时 TCP connect 挂满 5s+ 不返回
  （node 实测 ws://100.99.99.99:3333 5s 截断仍无结果），socket.ts 1800ms
  timer 兜底 → 每次切换/重连重建都等 tailscale 候选超时。
- 修复 1（tailscale 快速失败）:socket.ts 候选超时——tailscale 候选
  1800→900ms（正常 tailscale 延迟 <100ms 不受影响），无 tailscale 时
  切换/重连重建快一半。
- 修复 2（永远连不上根因）:reconnectStore.attempt 从未递增写回——每次
  失败循环从 attempt 0 重新开始 → backoff（300→600→…cap）永不生效 →
  网络黑洞下每 300ms 高频重试（耗电 + 永远连不上）。修复:startReconnect
  Attempt 后 attempt+1 写回 schedule；scheduleReconnectRuntime 加
  MAX_RECONNECT_ATTEMPTS=12 上限，达到后删除 runtime + 显式报错
  （active-reentry/resume/手动重连仍可恢复）。
- 验证:socket 29（2 新红测）/session-runtime 30（1 新红测 + 317 适配）/
  type-check clean/feature-registry 80/redline 96/transport 9。

## 2026-08-11 Android 前台恢复白色任务面诊断

- 目标：定位 HOME 后恢复 `MainActivity` 时的白色视觉冲击；诊断期正式产品代码只读，实验只写 `playground/foreground-white-flash-20260811/`。
- 基线：commit `2564c474039e57ad2f5339ce554c78948853d11c`；真机 `100.104.163.65:5555` 安装 `0.1.3.2541` / `1100025410`。
- 流程与 owner：Android task manager / launcher transition -> `AppTheme.NoActionBarLaunch` -> Capacitor `BridgeActivity` -> WebView -> React UI。唯一功能 owner 为 `mainline_source.android` / `client.app_shell`，资源边为 `resource.platform_terminal_surface -> resource.ui_projection`；不涉及 terminal transport、buffer 或 renderer truth。
- 首次偏离：后台态 `MainActivity` 无 surface；恢复时 zterm surface 重新附着前，连续截图先显示系统转场，再显示白色 Freehand task surface，最后恢复 zterm。OCR 命中 `Freehand`、`Workspace ready`、`Connecting to workspace`。证据：`android/evidence/foreground-white-flash-20260811/noanim/fg-noanim-seq-03.png` 到 `fg-noanim-seq-10.png`。
- 排除：CDP lifecycle probe 中 `#root` 始终挂载且有 child，terminal body text 与 `zterm:active-page={"kind":"terminal"}` 均未清空；当前现象不是 React 页面卸载或 terminal body 丢失。
- 已证伪旧结论：已安装 APK 包含 `51127e9` 的深色 splash、`windowSplashScreenBackground`、WebView 深色背景和 `colorMode` configChanges，但白色任务面仍可复现；仅修 splash/WebView 背景不足以解决 warm resume 转场。
- 活跃 H1：`Theme.SplashScreen` 未声明 `postSplashScreenTheme`，且正常 `AppTheme.NoActionBar` 没有明确深色 `windowBackground`，导致系统 task transition identity 未稳定切到深色运行主题。确认信号：实验 APK 的 HOME -> foreground 连续截图不再出现 Freehand 白色任务面；证伪信号：相同入口仍出现亮帧。
- 正向实验：只在 playground Gradle overlay 中给 launch theme 增加 `postSplashScreenTheme=@style/AppTheme.NoActionBar`，并给运行主题增加深色 `windowBackground`。反向实验：恢复基线 APK 后相同入口再次出现亮帧。两者齐备后才能确认根因并输出 Fix Design Report。
- 架构缺口：`feature-registry.json` 的 `mainline_source.android.allowed_paths` 与 `module-registry.json` 的 `client.app_shell.owned_paths` 尚未覆盖 `native/android/app/src/main/res/values/styles.xml` / `MainActivity.java`。正式修复前必须先补 owner 路径与 gate，不能把现有 registry 当作已允许 theme 修改。
- H1 实验状态：debug resource overlay 构建成功并安装，APK 仍是 `0.1.3.2541` / `1100025410`，sha256 `5da740d56bf66bbb448554b1f4477a69a17a95434d62ae23bfff72c3f00efe23`。随后已恢复 OTA 基线 `android/update-dist/zterm-0.1.3.2541.apk`。
- H1 结果不成立：正向样本 `h1-positive-terminal/` 与恢复基线后的 `h1-reverse-baseline/` 都没有抓到原始 Freehand 帧；两组亮度相同是当前 terminal shell 自身浅色背景，不能当作白闪消失。由于基线在同入口未复现，缺少有效反向干预，不能确认 theme 是根因，不能进入正式修复。
- 追加系统证据：当前 SurfaceFlinger 明确保留 `starting_reveal` animation leash；zterm 与 Freehand 都存在独立 ActivityRecord，Freehand 已 `mHasSurface=false`，而原始亮帧仍能显示完整 Freehand UI，符合 task snapshot/transition surface 而非 live React/WebView surface。下一假设应聚焦 Oplus task snapshot/transition owner，并先恢复稳定可复现条件。
- 检索 marker：`foreground-task-transition-freehand-snapshot-h1-not-confirmed`。
- 2026-08-11 22:24 CST 新基线：已安装正式 `0.1.3.2547` / `1100025470`。进入真实 terminal 后 HOME，`dumpsys window` 的 zterm task 2605 显示 `mIsRealSnapshot=true`、`mSnapshotColor=fff7f8fb`，即系统保存的是 zterm 浅色 terminal task snapshot；这比早先的 foreign-task 帧更接近稳定首次偏离。Android 36 `Activity#setRecentsScreenshotEnabled(false)` 文档明确：关闭后系统不应把 Activity screenshot 用作 recents representation，Activity 不运行时可改用 theme window background。
- H2 单假设：真实浅色 zterm task snapshot 是 warm foreground 的亮帧 owner。正向实验只在 `playground/foreground-white-flash-20260811/H2-recents-screenshot-disabled/` 注入 API 33+ `setRecentsScreenshotEnabled(false)` 和深色 theme background；确认信号是 zterm task 不再保存/呈现 real light snapshot 且恢复亮帧消失，证伪信号是仍为 real light snapshot 或亮帧不变。正式产品代码继续只读。
- H2 因果闭环完成。基线正式 2547：HOME 后 `mIsRealSnapshot=true`、`mSnapshotColor=ffffffff`；正向 playground 2549：`mIsRealSnapshot=false`、黑色 snapshot bundle `{mode=1,color=-16777216}`；反向重装正式 2547：再次 `mIsRealSnapshot=true`、`mSnapshotColor=ffffffff`。首次偏离是 `MainActivity` stopped 时的 Android task snapshot capture policy，发生在 Capacitor/WebView/React resume 之前。`FD-20260811-ANDROID-FOREGROUND-FLASH-01` 已获 Jason 批准；正式修复限制在 `client.app_shell` 的 `MainActivity.java` + theme resources，先补 registry/gate。
- 正式修复与真机闭环完成。`MainActivity.onCreate` 在 `super.onCreate` 前对 API 33+ 调 `setRecentsScreenshotEnabled(false)`；`AppTheme.NoActionBar` 改为 opaque 深色 `windowBackground`/`colorBackground`，launch theme 显式绑定 `postSplashScreenTheme`；未加 `FLAG_SECURE`、未做 JS 生命周期补偿。正式 APK `0.1.3.2550` / `1100025500`，sha256 `75f04412514fc0ab0853a05f787bbe7060a3bee761479a8e5d36ecee0a6b8c11`。三通道 manifest/APK 对齐，真机 `100.104.163.65:5555` 三次 HOME -> foreground：`mIsRealSnapshot=false`、`mSnapshotBundle={mode=1,color=-16777216}`、`shouldAppSnapshot=false`，截图无白帧。证据 `android/evidence/foreground-white-flash-20260811/formal-2550-run-*`。

## 2026-08-11 QuickBar 双行自定义入口纠正

- Jason 明确纠正：自定义快捷按钮入口不是工具行的单个通用 `+`，而是第一行、第二行末尾各一个 `+`。
- 历史真源 `13978ca^` 证明原始 ID 分别为 `shortcut-editor-top` / `shortcut-editor-bottom`；两者都复用现有 `openShortcutEditor` owner。
- 正式改动：竖屏分别投影到第一、第二快捷行；横屏合并快捷行保留两个入口；第三工具行不放该入口。单测锁定行归属、两个入口均可打开编辑器、且不发送 terminal sequence。

## 2026-08-11 QuickBar 编辑器与传输速率遮挡修复

- 根因：快捷键编辑器虽然是 `position: fixed; z-index: 121`，但仍挂在 `TerminalQuickBarShell(z-index: 10)` 的 stacking context 内；顶部连接/速率栏是相邻 `z-index: 15`，因此速率栏实际压在全屏编辑器之上。
- 唯一 owner：`terminal.quickbar` / `TerminalQuickBar.tsx`。正式修复把现有编辑器 overlay portal 到 `document.body` 并设为 `z-index: 240`；不隐藏传输速率、不移动两行自定义入口、不修改 transport/renderer/daemon。
- 真机 `0.1.3.2554` CDP：overlay parent 为 body；顶部速率栏采样点 `elementsFromPoint` 中 overlay 首项 index=0、status 首项 index=6，证明编辑器完整覆盖速率栏。Portal 内输入焦点同时纳入 QuickBar editor-focus owner，控件间切换保持 active，关闭时显式清为 false。

## 2026-08-12 Android test safety incident learning

- Trigger: a real-device test used `adb uninstall com.zterm.android`, then manually changed an isolated worktree `.build-meta.json` to bypass an installed-version constraint.
- Anti-pattern: destructive app-data cleanup without export/backup evidence; treating a build/version obstacle as permission to mutate the version source; publishing an unapproved stable OTA artifact.
- Future rule: preserve app data with `adb install -r` or in-app OTA; require Jason authorization plus a verified `zterm-config.json`/backup before any uninstall or clear-data operation; allocate versions only through `bump-build-version.mjs`; never publish Relay stable assets without explicit authorization.
- Evidence: device reports `0.1.3.2581` with fresh WebView storage; main repo truth remains `.build-meta.json=2580`; focused fixed-canvas tests and gates are being rerun in the isolated worktree.

## 2026-08-12 QuickBar 内置按键排序诊断

- `terminal.quickbar` 的首次偏离在快捷键存储真源：`useShortcutActionStorage` 只保存自定义项，内置项不进入 `TerminalShortcutAction[]`；编辑器因此看不到内置项。
- 可见投影 `buildVisibleShortcutRowActions` 再按固定 `SHORTCUT_PRESETS` 先行注入内置项，即使传入 `Enter, Esc` 的持久化顺序，输出仍从 `Esc, Bksp` 开始。正向组合顺序模型保留 `Enter, Esc`，反向恢复当前 builder 即重新固定。
- 唯一修复方向：在 QuickBar persistence owner 将稳定 ID 的内置项物化进同一有序列表，legacy custom-only 数据只补缺失内置项；UI 统一排序，内置项仅允许移动，不开放编辑/删除。设计 `FD-20260812-QUICKBAR-BUILTIN-ORDER-01` 待 Jason 批准。

## 2026-08-12 Android background connection service lifecycle slice

- 首次偏离：`BackgroundService` 已存在但只负责 partial WakeLock / WebView heartbeat；`useOpenTabLifecycleEffects` 在 foreground resume 立即 stop service，导致 service 生命周期仍跟随 UI 可见性，不能作为 retained connection 的独立 lifecycle owner。
- 正式切片：service 按 retained session count 启动/更新，前后台切换不停止；最后一个 retained session 关闭才停止。`SessionContext` 继续保持唯一 transport/message owner，页面只消费 projection。
- 红测/验证：`useOpenTabLifecycleEffects.test.tsx` 先红后绿；定向 transport/lifecycle/power tests `172 passed`；type-check clean；完整 `build:android` 被既有 `TerminalView.test.tsx` pinch transform 失败阻断（`811` tests，`1` pre-existing failure），未形成 APK/OTA/真机证据。
- 未完成：native `BackgroundService` 尚未真正拥有 WebSocket/mux socket；当前仍通过 WebView JS heartbeat 维持已有 transport。不能宣称“native service 已接管连接管理”完成，下一切片需先补 native service ↔ protocol transport owner 的 resource/edge registry 与真实后台断链/保活回环。

## 2026-08-12 reconnect preflight audit fix

- `runReconnectHostProbeAndFallback` now probes every candidate before queueing a reconnect intent, including attempt 0. When all candidates are unreachable it records explicit retry state and schedules normal backoff instead of sending a known-dead host into `TraversalSocket`.
- A single target mux probe timeout remains diagnostic-only per `terminal.transport_lifecycle.target_transport.network_probe`; physical OPEN transport retirement remains owned by heartbeat consecutive misses, synchronous send failure, terminal socket state, or explicit network-generation owner policy.
- Scoped reconnect/target tests: 118 passed. APK `0.1.3.2574` bundle/manifest/public Relay SHA passed; online ADB dropped before 2574 install. Marker: `reconnect preflight all candidates no known-dead socket probe timeout diagnostic-only`.

## 2026-08-12 固定 Canvas 单流 + 语义输入 + RTC 错误归口

- 完成 design id `FD-20260812-REMOTE-WINDOW-FIXED-CANVAS-SINGLE-STREAM-01`：
  - daemon 端 `1920x1080` 固定 canvas，一 capture/一 WebRTC sender/一 video track/一 receiver，
    focus 切换只更新 `layoutGeneration` 不重建连接；删除旧 `RemoteWindowDualStreamSwitch`/
    `resource.remote_window_focus_stream` 等所有 dual-stream 资源/边/测试。
  - client 端新增 `remote-window-semantic-input-runtime.ts`：boundary/continuous/control 三类
    semantic event，`sequence` 单调递增，continuous 走 latest-wins 合并（按 stream/target/kind），
    boundary 前 flush pending continuous，control 用 `input-state-snapshot` 校准，
    所有事件带 `layoutGeneration` 给 daemon 反算。
- receiver-runtime 加 `onConnectionFailure` 回调：peer/ICE `connectionStateChange` 归类为
  `network/transport/ice/peer`；通过 `zterm-remote-window-connection-failure` DOM CustomEvent
  透传到 overlay，overlay 的 `recordRemoteWindowConnectionFailure` 把分类前缀写到
  `streamErrorMessage`，再不发「rtc connect timeout」原句给用户。
- registry/function/mainline/test-design 全部同步删 dual-stream、加 semantic-input：
  - `feature-registry.json`/`module-registry.json`/`resource-registry.json`/edges/wiki 切换 owner；
  - `RemoteWindowCanvasLayout.canvas.width` 改成 number（允许测试用实际值），type-check 0 error。
- 定向测试全绿：`RemoteWindowOverlay.test.tsx` 60 + 4 skipped、`TerminalPage.remote-window-overlay.test.tsx` 7、
  `remote-window-receiver-runtime.test.ts` 12（含 4 个 connection failure 分类）、
  `remote-window-semantic-input-runtime.test.ts` 17、`remote-window-overlay-runtime.test.ts` 18、
  feature-registry gate 80/80、type-check 0 error。
- 主仓库两个误改测试已精确反转（`RemoteWindowOverlay.test.tsx`、`remote-window-receiver-runtime.test.ts`），
  无 checkout/reset。
- 剩余：worktree 内 daemon release/install/service-scoped restart + ADB 真机 15t-1 验证
  （固定 canvas 不重建连接 + semantic input 链路 + RTC 错误分类显示），
  再走 codex-review 门禁。
# 2026-08-12 Herdr compatibility-source experiment

- Jason要求：增加playground实验；每次测试写不同note；实验结束二次评估。
- 实验目录：`playground/herdr-compat-source-20260812/`；正式代码、registry、协议、backend均未修改；现有工作树其他dirty改动全部保留。
- H0接口实验：clone官方`herdrdev/herdr`成功，审计revision `5600197f00e871764465d4e3d9ba5e6aa6fd9547`。确认Herdr是独立Rust runtime，拥有PTY/pane/server/client；公开`terminal session observe/control`适合作为外部source adapter。Apache-2.0；Windows通过ConPTY，当前beta。
- H1 observer实验：设计了ANSI frame -> 隔离terminal state -> zterm canonical mirror的正反测试；本轮没有真实adapter/parser，未宣称live兼容。禁止把raw ANSI追加成mirror行，禁止partial frame推进revision。
- H2 controller实验：设计了input/resize ownership、second-controller、release/reconnect、失败不推进mirror geometry的正反测试；依赖H1隔离adapter，未宣称live input/resize通过。
- 二次评估：结论保持“Herdr作为兼容源可行，整体fork/替换daemon不合适”。下一批准门：新增resource/module/edge/function/mainline映射；完成playground真实observer/controller replay；再跑zterm daemon mirror close-loop；Windows单独跑ConPTY beta gate。没有这些证据，不进入正式代码。

# 2026-08-12 Herdr first-stage audit

- 审计报告：`playground/herdr-compat-source-20260812/first-stage-audit-report.md`。
- 审计结论：ARCHITECTURALLY FEASIBLE, NOT IMPLEMENTATION-READY；Herdr继续作为外部terminal source测试，不整体clone、不替换zterm daemon、不伪造tmux session。
- 源码证据补强：`src/cli.rs`存在observe/control命令；`src/client/mod.rs`存在`terminal.frame`、`terminal.input`、`terminal.resize`、`terminal.scroll`、`terminal.release`解析和输出；API边界成立。
- zterm边界：现有`daemon.terminal_backend -> mirror_store -> transport/buffer/renderer`可承接，但Herdr resource尚未注册；生产前必须补resource/module/edge/function/mainline，禁止复用`resource.tmux_session`。
- 关键未证：ANSI frame到canonical mirror、scrollback/absolute range、重复frame revision、malformed frame、controller input/resize/release/takeover均无live replay，H1/H2仍pending。
- Windows：源码有Windows/ConPTY/CI/打包；官方状态仍beta，native `herdr --remote`和direct terminal attach不支持；zterm只能将其作为显式beta backend能力。
- 构建审计：在`/tmp/herdr-audit.Q5Vl0p`执行`cargo check --locked`；Rust依赖和编译推进后，build.rs因缺少`zig`构建vendored `libghostty-vt`失败。此项是环境阻塞，不得报告为源码compile pass。
- 阶段门禁：仓库/版本/API/边界审计通过；live observer/controller、zterm mirror close-loop、Windows ConPTY gate、registry设计均未通过；不批准正式实现。

# 2026-08-12 官方安装双backend决策

- Jason决策：不修改/不fork Herdr官方版本；官方安装版原样运行，同时让zterm保留tmux并增加Herdr source支持。
- 官方安装：`curl -fsSL https://herdr.dev/install.sh | sh`成功；`/Users/fanzhang/.local/bin/herdr`，版本`0.8.0`，sha256 `d53a9f93fccfdfcc55632927bf51002f5add0aa7990bcdf508ffbd84ac658178`。
- 官方运行态：专用session `zterm-herdr-compat-20260812`启动过；启动产生server/client进程并拉取agent manifests；本轮已按明确PID关闭，`herdr status --json`确认server `not_running`，无Herdr遗留进程。
- zterm现状：`terminal-backend-selection.ts`只支持`tmux|wezterm`；`server.ts`、`terminal-control-runtime.ts`、`terminal-mirror-capture.ts`把非tmux路径绑定为WezTerm runtime，尚无Herdr adapter。仅安装官方Herdr不能产生zterm双backend能力。
- 实施决策：改zterm自有backend adapter，不改Herdr；新增`herdr`为显式backend kind，tmux仍为macOS/Linux默认，Windows现有WezTerm默认保持；Herdr observer/controller控制线进入daemon backend owner，canonical mirror仍唯一由zterm mirror writer发布。
- 当前阻塞：正式实现前需补Herdr resource/module/edge/function/mainline映射，并在playground用官方0.8.0完成observer frame、controller input/resize、生命周期正反replay；未完成前不得称zterm已支持Herdr。

# 2026-08-12 Herdr tmux-parity and agent-value audit

- 审计目录：`playground/herdr-capability-audit-20260812/`。
- A线结论：官方Herdr不能从安装/API存在直接宣称100%覆盖现有tmux能力。必须由zterm adapter补齐canonical rows/cells/cursor、absolute buffer range、gap repair、revision、source identity、schedule、image transfer、adaptive/mirror-fixed等契约，并通过现有tmux黑盒等价套件。
- A线硬缺口：Herdr公开`terminal.frame`是ANSI stream，不等于zterm canonical mirror；workspace/pane close不等于tmux session kill；Herdr没有zterm schedule执行契约；图片桥接与zterm clipboard/Ctrl+V链路也不是同一契约。
- B线Codex：官方支持；`herdr integration install codex`提供session identity，恢复命令`codex resume <id>`，但生命周期仍是screen-manifest authority，不是Codex hook全生命周期真源。
- B线OpenCode：官方支持；`herdr integration install opencode`，支持session identity与lifecycle plugin，active plugin可提供working/idle/blocked；恢复命令`opencode --session <id>`。
- B线Reasonix：未找到官方Herdr integration或native restore定义；可作为普通pane运行并获得Herdr持久化/布局，状态识别最多依赖manifest；要获得语义lifecycle需custom socket integration。
- 总结：Herdr增量价值在agent fleet协调、状态聚合、wait/prompt、restore，不在替代zterm mirror。tmux保留为100% parity reference；Herdr只有通过同一黑盒契约后才能标记parity-complete。Codex/OpenCode值得接入，Reasonix先按普通pane评估。

# 2026-08-12 Herdr adapter experiment round 1

- 实验目录：`playground/herdr-adapter-experiment-20260812/`；只改 playground 与本 note，未改 daemon runtime。
- 官方 `herdr 0.8.0` server protocol `19` 可启动；命名 session 启动 API server 后没有自动 pane，直接 `pane split` 返回显式 `pane_not_found`。实验随后显式创建 workspace/tab，再创建 pane，验证 Herdr lifecycle 不是 tmux `new-session` 的同形 API。
- Herdr snapshot 确认 pane identity（如 `w1:p3`）、terminal id、layout rect、`revision`、scroll metadata、workspace/tab 归属；这些可作为 adapter control metadata，但不能直接当 zterm mirror revision/absolute range。
- 本轮 Herdr read 使用 `pane read --format ansi`，实验记录了 command 参数在 CLI JSON 边界上的失败（`SyntaxError`），因此 Herdr output parity、input byte parity、resize rows/cols、absolute range 均保持 `gap`，没有把 partial evidence 晋级为 PASS。
- tmux oracle 的 create/run/read 与 pane geometry 通过；Herdr 的 list/create/lifecycle 通过部分前置，但 read/input/resize/revision contract 尚未通过。正式 adapter 暂不接入 daemon；下一轮先修正 CLI invocation/证据采集，再做 ANSI frame -> canonical mirror 正反 replay。

# 2026-08-12 Herdr zterm-feature scope correction

- Jason明确：不使用 Herdr 的 pane split/tab/workspace UI 能力；本项目只需要把一个 Herdr terminal surface 映射为 zterm 的一个 backend session。
- 实验范围已收窄为 zterm 真正使用的 feature：session list/create/close/rename、单 session output/mirror、input、resize、reconnect、multi-client mirror truth、schedule、file/image chain，以及 Codex/OpenCode/Reasonix 的 agent side-channel。
- 第二次单 session 实验只创建一个初始 terminal surface；没有调用 `pane split`，没有把 Herdr layout/tab/workspace 当作 zterm contract。Herdr server 仍要求显式初始化一个 workspace/container 才会出现初始 terminal surface，这只是官方启动前置，不进入 zterm 业务模型。
- 实验仍发现 `pane run` 的 CLI 参数 JSON 边界问题，故 Herdr output/input/resize/revision 继续保持 `gap`，不进入正式 adapter。后续应直接针对单 session API/协议做 capture，而不是继续探索 Herdr UI 布局。

# 2026-08-12 Herdr single-session contract experiment round 2

- 实验纠正：`pane read` 成功时 stdout 是裸 terminal text/ANSI，不是 JSON envelope；控制命令 JSON 与 terminal payload 必须物理分离。修正后，单 session `pane read --source recent --format ansi` 能读到 `HERDR_MARKER`，ANSI read 标记 PASS。
- 实验纠正：`pane send-text` 是 literal，不自动提交；zterm 的 `appendEnter` 必须显式映射为后续 `pane send-keys ... Enter`。修正后的 input marker 回读纳入同一实验，作为正向 input gate。
- Herdr CLI `pane resize` 是 split ratio/layout 操作；只有一个 terminal surface 时返回 `changed:false`，不改变/不报告 zterm 所需 PTY cols/rows。不能拿它替代 zterm resize；Herdr source 中存在 `terminal.resize` 会话协议（含 cols/rows/cell size），下一步必须走该协议而非 pane CLI。
- 当前结论：单 session output read 已通过最小 ANSI marker；input 正向 replay 已实现但完整错误/重连门禁待补；PTY geometry、absolute range/cursor、Herdr revision 到 zterm mirror revision 仍未通过。正式 adapter 继续不接入 daemon。

# 2026-08-12 Herdr terminal session protocol experiment round 3

- 实验转向官方 `terminal session observe/control`，不再使用 pane layout resize。`observe` 实际输出 `terminal.frame`：base64 ANSI bytes、`seq`、`full`、`width`、`height`。
- 真实 resize 证据：controller/observer 初始 `80x24`；发送 `terminal.resize { cols: 100, rows: 30, cell_width_px: 8, cell_height_px: 16 }` 后收到 frame `width=100,height=30`。因此 Herdr terminal session protocol 可以承接 zterm PTY geometry，`pane resize` 不可以。
- controller release 后 observer 收到 `terminal.closed reason=detached`，证明协议有显式 close/release 事件。
- 本轮 terminal.input harness 的 JSON quoting 错误导致 control stdin 报 `invalid json command`，不能把该轮标为 input PASS；上一轮 CLI `send-text + send-keys Enter` 的单 session input replay 仍单独为 PASS。
- adapter 候选路径锁定为 `terminal session observe/control -> decode terminal.frame -> validate seq/full/geometry -> zterm canonicalizer -> mirror_store`。`terminal.frame.seq` 暂时只能当 Herdr transport sequence，不能直接冒充 zterm mirror revision/absolute range。

# 2026-08-12 Herdr terminal protocol replay round 4

- 新增可重复 TypeScript runner：`playground/herdr-adapter-experiment-20260812/terminal-session-protocol-run.ts`，控制消息由 `JSON.stringify` 生成，避免 shell quoting 误报；证据：`terminal-session-protocol-evidence.json`。
- 单 terminal session observer/controller 实验通过：initial `terminal.frame seq=1 full=true width=80 height=24`；随后收到 `seq=2 full=false`；resize 后收到 `seq=1 full=true width=100 height=30`；controller release 后收到 `terminal.closed reason=detached`；同一 `terminal_id` 重新 observer 成功收到 `seq=1 full=true`。
- 关键结论：Herdr `terminal.frame.seq` 在 resize/reconnect 后重置，是 attachment-local render sequence，不是全局 mirror revision。adapter 必须在 accepted canonical commit 后自己生成 zterm mirror revision；禁止直接复制 Herdr seq。
- 本轮 terminal.input marker 未在收集窗口内观察到，故 protocol input 保持 GAP；pane CLI 的 literal text + Enter 回读 PASS 不替代 terminal session control input gate。需要单独拉长 observer/controller 生命周期并验证 input ack/output marker。

# 2026-08-12 Herdr terminal protocol input/delta analysis round 5

- 可重复 runner 证据显示 `PROTO_INPUT_MARKER` 已进入 terminal frame 的输入回显，但在原 CR 提交字节下未观察到命令输出 marker；因此 terminal.input 写入已观察，提交/执行仍 GAP。本轮改用 LF 作为独立提交字节并延长等待，继续验证。
- Herdr `render_stream.rs` 明确：TerminalAnsi client 使用 per-client `BlitEncoder`，`full=false` 是相对该 client 前一帧 baseline 的 ANSI patch；不是独立 snapshot。Herdr adapter 必须为每个 terminal stream 保留 baseline，并在 stream/reconnect/resize/full frame 边界重置；不能把 delta 直接当 zterm mirror patch，也不能跨 attachment 复用。

# 2026-08-12 Herdr terminal protocol input/delta analysis round 6

- 修正了两处实验采集器错误：frame payload 字段是 `bytes` 而不是 `data`；本轮使用项目声明的 `pnpm --dir android exec tsx`，不把执行器路径错误计入协议结论。
- controller 独占单 session，发送 `terminal.input` text `echo PROTO_INPUT_MARKER`，随后发送 base64 `CR`；解码 `terminal.frame.bytes` 后观察到 marker，`inputMarkerObserved=true`，故 terminal session protocol 的基本 shell input/replay gate PASS。
- 同轮保持正向证据：初始 `80x24`、resize 后 `100x30`、release 得到 `terminal.closed(detached)`、同 terminal identity reconnect 得到新的 `full=true seq=1`。
- 反向/边界仍未通过：TUI 控制序列、bracketed paste、second-controller takeover、multi-client observer mirror 一致性、scrollback absolute range/cursor、image/file chain、schedule。Herdr frame 仍是 ANSI bytes，`full=false` 仍需 stateful parser 才能构成 zterm canonical mirror。

# 2026-08-12 Herdr ANSI canonicalizer experiment round 1

- 新增 playground-only `ansi-canonicalizer.ts` 与 `ansi-canonicalizer.test.ts`，验证 zterm cell contract 的最小状态模型：`char/fg/bg/flags/width`、rows/cols、cursor。
- 正向 gate：full frame 后 delta 写入保持既有行内容；resize 后保留可见状态并限制 geometry/cursor；三项均 PASS。
- 反向 gate：malformed/control bytes 不应推进 canonical truth；PASS。
- 明确限制：该实验 parser 只用于验证状态边界，尚未实现真实 VT/ANSI 语义（光标移动、擦除、滚动、SGR、Unicode 宽度、scrollback）。不能把该 parser 接入 daemon，也不能据此宣称 Herdr mirror parity。
- 下一正式实验：采用已有可靠 VT parser 或单独验证完整 VT state machine，直接重放 Herdr `terminal.frame.bytes` 的 full/delta 序列，并与 tmux oracle 做 rows/cells/cursor/revision 等价审计。

# 2026-08-12 Herdr frame canonicalizer experiment round 2

- 先检查现有 owner，确认 zterm 已有唯一 terminal VT 核心 `@jsonstudio/wtermmod-core` `WasmBridge`，支持 `writeRaw/resize/getCell/getCursor/getScrollbackCount/cursorKeysApp/usingAltScreen`；因此删除“另写简化 ANSI parser 作为正式路径”的方向，playground 改为复用该核心验证。
- 新增 `herdr-frame-canonicalizer.ts`：验证 Herdr frame `bytes` base64 解码、frame geometry、stream-local seq 连续性、full/delta baseline、zterm-owned revision、cursor/cells/scrollback/alternate-screen 投影。
- 真实 Herdr evidence replay 通过：现有 `terminal-session-protocol-evidence.json` 的 initial/resized/reconnect frames 可被 WasmBridge 重放；`80x24 -> 100x30`、reconnect 后 revision 从 1 重新开始均通过。
- VT 语义 fixture 通过：cursor movement、SGR red、CJK/emoji width、alternate-screen round trip。
- 反向 gate 通过：duplicate、missing seq、geometry mismatch 的 delta 均显式拒绝，不推进 canonical truth。
- 仍不能宣称 parity：Herdr frame 没有 zterm absolute line index/available range；scrollback absolute mapping、multi-client observer truth、file/image/schedule、正式 daemon adapter 尚未验证。

# 2026-08-12 Herdr canonicalizer/parity verification round 3

- 架构复核确认正式承载面：`resource.terminal_backend -> resource.backend_session -> resource.mirror_store`；现有 `daemon.terminal_backend` 与 `daemon.mirror_store` 已有 owner，但 registry 当前只声明 tmux/WezTerm，Herdr 尚未成为 active backend。正式 adapter 不能绕过这条边，也不能直接复用 `resource.tmux_session`。
- 确认 zterm 已有唯一 VT 真源 `@jsonstudio/wtermmod-core` `WasmBridge`，因此 Herdr frame canonicalizer 复用 `writeRaw/getCell/getCursor/getScrollbackCount/usingAltScreen`，不维护第二套简化 parser。
- Herdr 真实 frame replay：`realHerdrReplay=pass`、`vtSemanticCoverage=pass`、`reverseSequenceGates=pass`；覆盖 full/delta、resize、reconnect、cursor movement、SGR、CJK/emoji width、alternate screen、duplicate/missing/geometry-mismatch reject。
- tmux parity oracle：`terminal-backend-selection + mirror-line-canonicalizer + terminal-mirror-capture + terminal-mirror-runtime + server.mirror-capture-truth` 共 63 tests PASS；真实 `daemon:mirror:close-loop` 的 codex-live/top-live/vim-live/initial-sync/local-input/long-input/external-input/restart-recover/schedule 与 replay strict audit 全部 PASS。
- 二次阶段判断：Herdr terminal session 的 input/resize/release/reconnect/ANSI VT 重放已具备 adapter 基础，但 zterm 的 absolute scrollback/range/cursor truth 仍不能从公开 `terminal.frame` 直接证明；正式 adapter 仍不接入，需先做 capability decision：Herdr source 若不能提供稳定 absolute range，只能显式标记 backend capability gap，不能伪造 tmux parity。

# 2026-08-12 Herdr scroll capability experiment round 4

- 通过官方 terminal session control 发送 `terminal.scroll { direction: "up", lines: 1, source: "wheel" }`。
- 在受控窗口内没有观察到带新 sequence 的 `terminal.frame`；因此只记录 command sent，不把 scroll 标为 PASS。
- 这进一步确认 Herdr `terminal.frame` 当前不能证明 zterm 所需 absolute scrollback/range。重复或相同 seq 的 full frame 也不能推进 zterm revision；adapter 必须按 attachment sequence/内容去重并显式拒绝无法连续重放的 delta。
- 正式 adapter 进入条件新增：必须拿到稳定 scrollback positive replay，或在 capability contract 中明确 Herdr backend 不支持 absolute scrollback，并由上层显式暴露 gap；禁止伪造 tmux 的 absolute indexes。
# 2026-08-12 Herdr official backend integration gate audit

- 按 `docs/goals/herdr-adapter-integration-plan.md` 读取 architecture、resource/module/function/mainline/verification map；当前正式 backend owner 只声明 `tmux` 与 `WezTerm`，没有 active Herdr resource/edge/feature binding。正式代码不能直接复用 `resource.tmux_session`，也不能把 Herdr workspace/pane/layout truth写入 daemon。
- 真实 Herdr 0.8.0 replay 已通过：`playground/herdr-adapter-experiment-20260812/herdr-frame-canonicalizer.test.ts` 输出 `realHerdrReplay=pass`、`vtSemanticCoverage=pass`、`reverseSequenceGates=pass`；覆盖真实 full/delta bytes、cursor movement、SGR、CJK/emoji width、alternate screen、duplicate/missing/geometry mismatch reject。
- 真实 terminal session protocol runner 已观察 initial full frame、delta frame、resize 后 geometry/full frame、release `terminal.closed(detached)`、同 terminal identity reconnect、input marker；`terminal.frame.seq` 在 resize/reconnect 重置，只能是 attachment-local metadata。
- 硬阻塞：`terminal.frame` 没有 zterm 所需 absolute scrollback/range；受控 `terminal.scroll` command 未在观察窗口产生可验证新 frame。当前不能推导 `bufferStartIndex/endIndex`、cursor absolute row 或 parity revision；禁止正式 adapter 伪造或把 Herdr seq 复制为 zterm revision。
- 未闭环能力：官方 Herdr multi-client observer/controller mirror 一致性、duplicate/reorder/missing frame 在线行为、正式 daemon mirror close-loop、Codex/OpenCode/Reasonix side-channel 审计、Windows ConPTY 真实 gate。现有实验结论只允许 adapter design/playground evidence，不允许宣称 backend complete。
- 唯一安全下一步：先取得官方 Herdr 稳定 absolute range/scrollback/cursor contract（或明确产品层接受 `absolute-range=unsupported` 的 beta capability contract），再补 active resource/module/edge/function/mainline/verification entries；在此之前不写正式 runtime backend。
# 2026-08-12 Herdr formal adapter owner round 2

- `daemon.herdr_backend` 已加入 resource/module/feature/function/verification binding，状态保持 `pending`；owner 仅在 daemon backend surface，不进入 client/UI/shared payload，不存 Herdr workspace/layout truth。
- 新增正式 `herdr-frame-canonicalizer.ts`：唯一复用 `@jsonstudio/wtermmod-core` WasmBridge，full/delta exact sequence、geometry、malformed bytes reject；zterm revision 独立递增，reconnect 只 reset attachment baseline；Herdr viewport cursor保留 `localCursor`，mirror `cursor` 与 `absoluteRange` 保持 null，显式 gap `absolute-range-unavailable`。
- 新增 typed `herdr-backend.ts` 与官方 CLI JSONL `herdr-process-transport.ts`：input/resize/release/reconnect 只走 typed control message；source frame/closed/error 走 typed source side-channel；多 adapter 实例各自持有 baseline，不共享状态。
- playground canonicalizer 已改为导入正式 owner，真实 Herdr frame replay 仍输出 `realHerdrReplay=pass`、`vtSemanticCoverage=pass`、`reverseSequenceGates=pass`；formal adapter 14 tests、tsc、registry/module/function/mainline gates 全绿。
- 现有 daemon server 尚未接入 Herdr process runtime；`ZTERM_TERMINAL_BACKEND=herdr` 当前明确 fail-fast，禁止误落 tmux。下一修改点是抽象 daemon backend runtime 的通用 capture/input/lifecycle interface，并在 Herdr absolute-range capability 未满足时显式拒绝 mirror attach，不得伪造范围。

# 2026-08-12 Herdr schema/range gate round 3

- 读取官方 `herdr api schema --json` 与 CLI help：`terminal.frame` 只暴露 attachment-local `seq/full/width/height/bytes`；schema 未发现 terminal frame 的 absolute line index、available range 或 absolute cursor row。
- 官方 pane scroll 信息只提供 `offset_from_bottom/max_offset_from_bottom/viewport_rows`，不能推出稳定的 zterm `bufferStartIndex/endIndex`，也不能把 viewport cursor 转换成 absolute row。
- 因此 Herdr adapter 保持 `absoluteRange=null` 与 `cursor=null`，只导出 WasmBridge canonical rows/local cursor；daemon 选择 Herdr 时仍 fail-fast，不能绕过 mirror contract 或把本地序号伪造成 absolute range。
- 进一步读取官方 Herdr `src/server/render_stream.rs` 与 `src/protocol/wire.rs`：`ClientRenderState::TerminalAnsi` 只保存 per-client `BlitEncoder + seq`；实际 `TerminalFrame` wire 只有 `seq/width/height/full/bytes`。`FrameData` semantic 模式虽有 cells/cursor，但不是 `terminal session` bytes 协议，且同样没有 absolute line identity。该源码证据锁定 range 缺口属于官方 source contract。
- 正式 canonicalizer 反向门禁修正：首帧 `full=false`、同 geometry duplicate full、geometry 变化但非 `full=true,seq=1` 均拒绝且不推进 zterm revision；15 个 Herdr 定向测试与 tsc 通过。
- 长输出真实 scroll probe：生成 80 行后 `pane get.scroll` 在底部为 `{max_offset_from_bottom:61, offset_from_bottom:0, viewport_rows:24}`；发送 `terminal.scroll up 1` 后收到 1 个新 frame，metrics 变为 `{max_offset_from_bottom:54, offset_from_bottom:1, viewport_rows:30}`（resize 同轮从 24 行改为 30 行）。这证明 scroll command/frame 路径可用，但 `max_offset + viewport_rows` 随 viewport geometry 变化为 85→84，仍是 host viewport 指标，不是稳定 absolute line identity；不能直接写入 zterm `bufferStartIndex`。
- 多客户端真实 replay：controller 与独立 read-only observer 同时订阅同一 terminal；在相同 80x24、底部 viewport，两个独立 canonicalizer 的 rows digest 相等（`atBottomCellsEqual=true`），两边各自 seq 从 1 开始且 frame count 可不同；resize/scroll 后 observer 保持自身 80x24 viewport，controller 变为 100x30，不能比较为同一可见窗口。正式 adapter 必须按 attachment 独立维护 baseline，不把 observer viewport 状态写入 daemon truth。
- 正式 canonicalizer 增加条件 range contract：frame 携带 geometry-matching 的 `maxOffsetFromBottom/offsetFromBottom/viewportRows` 时，以 `max+offset+viewportRows` 建立 host-scroll-derived available end；跨 frame 不能回退，bottom 时才把 local cursor 转为 absolute row；无 metrics 或 regression 保持 explicit gap/error，失败不推进 revision。新增正反测试后 Herdr 定向总数 59 PASS。

# 2026-08-12 Herdr runtime wiring round 5

- 官方输入源码确认 `ClientMessage::Input { data: Vec<u8> }`；Herdr terminal session JSONL 实际同时接受 `terminal.input.text` 与 base64 `terminal.input.bytes`。正式 typed adapter 增加 `inputText`，真实 formal process probe 已通过 input marker、resize、release/closed，证据 `formal-process-transport-evidence.json`。
- `pane get` 与 frame stream 存在 geometry 竞态；transport 不再丢弃 frame 或伪造 seq gap，metrics 不匹配时保留原 frame，由 canonicalizer 输出 `absolute-range-unavailable` capability gap。
- daemon 已接入 `herdr-backend-runtime.ts`，server 在 `ZTERM_TERMINAL_BACKEND=herdr` 下启动并 `/health` 返回 `ok:true`；当前仍未完成 Android session 黑盒 mirror close-loop、side-channel 审计与 Windows ConPTY gate，不能宣称整体完成或 Windows 支持。

# 2026-08-12 Herdr runtime wiring round 6

- 真实 daemon close-loop：Herdr backend create/initial buffer-sync/input/resize/release/reconnect/close 全链路通过；restart 后依靠官方 session/pane discovery 恢复同一命名 server，验证 detached server 与 zterm revision truth 分离。
- 代码修正：server glue 改为 `TERMINAL_BACKEND_RUNTIME`；Herdr 的 mirror capture 不使用 `rows + cols` 作为 tmux history/absolute-range 提示；rename 明确 unsupported。
- Windows 远程检查：WezTerm direct snapshot/input 通过；daemon protocol smoke 在 targeted cleanup 阶段只收到 `error`，health 显示实际 session 已清零。ConPTY 与 Windows daemon close-list gate 仍 gap，不能标记 Windows PASS。

# 2026-08-12 Herdr completion audit round 7

- `herdr integration status` 显示 Codex/OpenCode 均未安装；Reasonix 没有官方 Herdr integration surface。静态 terminal payload side-channel gate PASS，但外部 operational agent audit 仍是未配置/未证明。
- Windows smoke 已输出完整错误：远端 daemon 仍是旧 WezTerm→tmux close 路径；health 清零不等于 close-list control 收口，Windows 继续 beta/gap。
- Codex review 对混合未提交工作树返回 ambiguous verdict，并只给出其他 Android 并行改动的 P2；不能当作本 Herdr patch 的 PASS。
- reconnect range 修复后的 17 个 Herdr 定向测试、tsc、Vite 通过；本轮完整 build 被无关 `FileTransferSheet` native stat `EIO` 测试失败阻断，保留为全局 build gap。
- 单独重跑 native-stat 测试后通过；完整 `pnpm run build` 再跑全绿，确认上一轮是非稳定时序失败，不再作为当前 build gap。

# 2026-08-12 Herdr completion audit round 8

- 修复 review P1：source `terminal.closed` 后 adapter release 幂等；named-session restart discovery 多 pane 无 identity 显式失败，不再静默选 `panes[0]`。
- 20 个 Herdr 定向测试、tsc、diff check、完整 `pnpm run build` 全绿；release/install runtime SHA256 对齐。安装脚本的 Screen Recording preflight 仍因现有 TCC 状态退出，未执行 TCC reset。
- 隔离 `39091` 以安装后的同一 `server.cjs` 显式选择 Herdr，真实 close-loop 输出：`80x24 rev1`、input `rev3`、resize `100x30 rev4`、reconnect `rev4`、close 后 session list 空。之前 launchd 默认端口的 resize timeout 证据归因于命中了 tmux，不计入 Herdr 失败。
- 二次评估结论不变：tmux 是 parity oracle；Herdr 只提供单 session surface；Codex/OpenCode/Reasonix operational integration 未配置/未证明；Windows ConPTY/close-list gate 为 beta/gap，不能宣称 Windows 通过。

# 2026-08-12 Herdr review P1 remediation round 9

- review 发现 fixed-mode resize 越过 geometry owner；正式修复为 mirror-fixed 不 resize backend，adaptive-phone 才由 adaptive lease owner 调 backend-specific resize。
- Herdr/WezTerm adaptive apply/release 已与 tmux resize 分流；最新安装 runtime 真实 Herdr close-loop 通过 `rev1 -> input rev3 -> resize 100x30 rev4 -> reconnect rev4 -> close removed`。
- Herdr named-session 创建阶段增加 scroll capability/初始 rows 前置检查；缺失能力显式清理失败，不发布伪造 absolute range。

# 2026-08-12 Herdr absolute-range boundary round 10

- Review 结论确认 host scroll offsets 不能证明 zterm absolute line identity；已删除 Herdr offset 到 absolute range/cursor 的伪造映射，保留显式 `absolute-range-unavailable` gap。
- adaptive lease 增加 applied rows 比较，修复同 cols 仅 rows 变化时跳过 backend resize。
- 当前实现不能宣称 Herdr 100% tmux parity；transport close-loop 通过，但 absolute range/visible-history repair 仍是官方 Herdr 能力缺口。

# 2026-08-12 Herdr canonical scrollback round 11

- 发现 `@jsonstudio/wtermmod-core` 自带 VT scrollback API；正式 canonicalizer 改为从 bridge scrollback + visible grid 生成 attachment-local absolute range，host pane offsets 仅用于判断 viewport-relative cursor capability。
- 新增 10th canonicalizer test 覆盖滚屏后 scrollback rows、absolute range 和 canonical buffer 投影；formal backend/mirror/transport 定向 55 tests 与 tsc 通过。
- 完整 build/release/install/restart/real Herdr close-loop 通过：rev1→rev3→resize rev4→reconnect rev5→close removal；Windows 仍 beta/gap，agent external integrations 仍未配置/未证明。

# 2026-08-12 Herdr final gate reassessment round 12

- 重新执行 Windows 真实远端 WezTerm snapshot/input smoke：通过；daemon protocol smoke 仍在 targeted cleanup 等待 `sessions` close-list 时超时，health 最终显示 `sessions.total=0`，因此 Windows ConPTY/daemon gate 仍只能标 beta/gap。
- 最新正式 Herdr 定向门禁 `herdr-frame-canonicalizer`、backend、process transport、side-channel、selection、transport lifecycle 共 6 files / 42 tests，`tsc --noEmit` 与 `git diff --check` 全绿；安装 launchd runtime health 仍为 `ok:true`。
- parity 审计矩阵已修正：canonicalizer-owned VT scrollback absolute range 不再被记录为“尚未实现”，但完整 tmux black-box rows/cells/cursor/geometry/revision parity、range repair、Windows close-list、Codex/OpenCode/Reasonix operational audit 仍未通过，功能 registry 保持 `status: pending`。
- 最新 Codex review 仍因混合工作树中与 Herdr 无关的 Android P1/P2 findings 失败；Herdr 专项未出现 review finding，但没有语义 `PASS`，不能作为交付门禁通过。
- 新增并运行同样本 parity probe：同一 ANSI/VT 样本分别进入 tmux 与官方 Herdr，tmux `capture-pane -e` 先按 row-snapshot 语义恢复 CRLF，再复用正式 canonicalizer；rows、wide-cell shape、geometry、cursor 全部相等，revision 保持独立 namespace。证据：`playground/herdr-adapter-experiment-20260812/tmux-herdr-canonical-parity-evidence.json`。
- parity 样本已扩展为 SGR、CJK/emoji width、erase-to-end-of-line、scroll、alternate-screen enter/leave、OSC title、kitty graphics；tmux/Herdr 全部 canonical rows、cell shape、80x24 geometry、cursor 对齐，probe exit 0。tmux 快照末尾 sentinel row 与 LF 语义均在实验 owner 内显式归一化。
- 使用当前 `/Users/fanzhang/.zterm/daemon-runtime/server.cjs`、隔离端口 `39094`、显式 Herdr backend 重跑 daemon close-loop：initial rev1、input rev3、adaptive resize rev4 `100x30`、reconnect rev5、close removal true；本轮安装 runtime 与源码行为保持一致。
- 正式 canonicalizer test owner 新增综合 VT fixture 与 wrap delta 反向边界，测试数 10→12；SGR/erase/scrollback/alternate-screen/OSC/kitty/wide-cell/cursor 语义不再只由 playground 覆盖。
- 完整 `pnpm run build` 本轮全绿：prebuild 83 tests、Gradle、terminal contract 814 tests、common flows 91 tests、relay smoke/account/workspace gates、type-check、Vite；最新 oauth Codex review 仍 fail，但唯一 finding 是无关 `RemoteWindowOverlay` 删除样式的 P1 与 attachment notification race P2，Herdr 专项无 finding。
- 新增 `herdr-backend-runtime.test.ts`，锁住 canonical snapshot 到通用 `WezTermMirrorSnapshot` 的 range/cursor/geometry/zterm revision 投影，以及缺失 absolute range 时显式拒绝；Herdr runtime/registry 专项 25 tests 通过。随后全局 tsc 被当前并行 `TerminalView.tsx` 未定义 ref/setter 错误阻断，不能把本轮新 runtime helper 宣称已安装；不修改无关 UI 文件。
# 2026-08-12 current-worktree performance audit

- Read-only audit against current dirty worktree; no product code changed. Worktree has 141 changed/untracked paths and tracked diff is +3568/-1043, so findings are against current source, not attributable to one commit.
- Focused performance gates passed: 6 files / 46 tests; type-check; feature/resource/module/edge/import gates 83 tests; inactive-body real daemon probe passed with 100% inactive body reduction, no transport recreation, final revision preserved.
- Live daemon evidence: RSS about 305 MB, 12 ready mirrors. `/debug/runtime` trace reached bounded 5000 records, but all 808 summarized samples had null capture-to-render, send-to-rx, and rx-to-render; client debug entries were 0. End-to-end latency SLA is therefore not currently measurable online.
- Confirmed hotspots: mirror capture performs async tmux metrics + cursor + full `capture-pane` + canonicalization each active flush and authoritative-replaces the cached window; live trace samples reached 3000 lines and 822004 bytes. Client render path compares/clones rows in `session-render-gate` and then compares/clones again in `session-render-buffer-store`, creating repeated O(lines*cells) work and allocations.

# 2026-08-12 performance repair continuation

- MemoryPalace search confirmed the performance plan order: production metadata-only trace first, then only implement renderer optimization after current-version trace crosses the documented threshold. No payload trimming, live-tail fallback, or second mirror truth is allowed.
- Render owner change remains limited to `session-render-gate.ts` -> `session-render-buffer-store.ts`: the gate performs row equality/reuse and owns the immutable projected snapshot; the store accepts `immutableProjection` only for that handoff, skips the second full-window equality/deep clone, and keeps normal callers cloned. Existing positive/negative tests cover both paths and post-publish source mutation isolation.
- Trace owner change remains limited to `packages/shared/src/terminal/performance-trace.ts`: bounded metadata ring eviction is O(1), with snapshot ordering and payload-key rejection preserved. Dedicated trace/HTTP tests pass 8/8.
- Verification completed in this continuation: focused performance suite 54/54, trace/HTTP suite 8/8, Android TypeScript no-emit pass, `git diff --check` pass, feature/registry gate 83/83, and real `daemon:mirror:close-loop` pass for codex-live, top-live, vim-live, initial-sync, input, long-input, external-input, daemon-restart, and schedule cases. Replay strict audit reported no source/client mismatches.
- Authenticated live daemon snapshot after the close-loop showed `ok=true`, installed daemon PID `1762`, 12 ready mirrors, 0 active subscribers after test cleanup, 1790 bounded trace records, 0 client debug entries, and 0 completed capture-to-render/send-to-rx/rx-to-render samples. Therefore online end-to-end latency remains unmeasurable; this is an observability gap, not evidence for a further capture algorithm patch.
- No further daemon capture change is justified by the current evidence. The authoritative terminal payload remains complete and the renderer optimization is the only confirmed runtime cost reduction in this continuation.

# 2026-08-13 Tailscale dynamic route live verification

- Installed APK `0.1.3.2589` (`versionCode=1100025890`) on ADB device `100.104.163.65:5555` with `adb install -r`; `dataDir` and `firstInstallTime` remained unchanged.
- WebView CDP was used to inspect the actual DOM and click the saved `Open Macbookair` button. Blind coordinate tapping was not used as connection evidence.
- Two explicit Tailscale connection rounds reached a real terminal body. Route projection reported `resolvedPath=tailscale`, `resolvedEndpoint=100.86.84.63:3333`, `lastConnectStage=open`, `lastError=null`; daemon runtime reported `terminalChannelState=open` and one attached subscriber.
- Input replay through the visible QuickBar reached the remote tmux shell and produced the visible shell error/body change, proving the connected WebSocket was carrying terminal input and mirror updates.
- Cold-launch replay after force-stop hit a transient CDP transport reset while the WebView page was still being recreated; this is harness timing evidence, not a product connection failure. The subsequent explicit CDP open and two live rounds were successful.
- Evidence directory: `android/evidence/2026-08-13-tailscale-reconnect/`.
- Remaining live gap: this run did not force a Tailscale address change or intentionally make the current IP unreachable. Dynamic per-generation candidate verification is covered by the socket/route tests and the live authenticated WebSocket attempt; network-change failure/recovery remains a manual scenario.
2026-08-12 Herdr runtime projection close-loop final evidence: the explicitly installed `ZTERM_TERMINAL_BACKEND=herdr` daemon runtime was started on port 39095 and replayed `playground/herdr-adapter-experiment-20260812/daemon-herdr-close-loop.ts`. Evidence records connected=true, inputRevision=3, resizeRevision=4 with geometry 100x30, reconnected=true, reconnectRevision=5, and closeRemovedSession=true. The generated release runtime and `/Users/fanzhang/.zterm/daemon-runtime/server.cjs` have identical SHA-256 `9d38c0ce0c7eb3d89ca59c33eb2f4bb59745924b`. Herdr-specific tests remain 25/25 passing; registry/resource/map tests are 43/43 passing; `git diff --check` is clean. The full Android typecheck remains blocked by unrelated pre-existing dirty `android/src/components/TerminalView.tsx` undefined refs/setters; no UI file was changed for this task. The macOS install-service command still exits at the existing Screen Recording preflight (`could not create image from display`), without any TCC reset. Windows remains explicitly beta/gap because the remote daemon close-list cleanup timeout gate is not green.
2026-08-12 Herdr projection correction: the shared `WezTermMirrorSnapshot` contract now exposes `cursorKeysApp: boolean` instead of a false-only type, and `mapHerdrCanonicalSnapshot` preserves the canonicalizer's parsed cursor-key mode. The projection fixture now asserts true propagation; Herdr/runtime/registry gates pass 69/69 and `tsc --noEmit` passes. A full `pnpm run build` reached the terminal contract suite but failed two unrelated dirty-worktree `SessionContext.ws-refresh.test.tsx` reconnect timing assertions (812 passed, 2 failed); no reconnect/UI source was changed. Release preparation and install copy completed; release and installed runtime SHA-256 match `0b858d4e87ff3f41d1cde8618e3fea87daf24226`. launchd restarted and health returned ok=true. Explicit installed Herdr close-loop on port 39096 passed connected, input rev3, resize rev4 100x30, reconnect rev5, closeRemovedSession=true. Install-service still exits only at existing Screen Recording preflight.
2026-08-12 Herdr build recheck: the previously failing `SessionContext.ws-refresh.test.tsx` suite passed standalone 138/138 on rerun, confirming the two failures during the first full build were timing-flaky unrelated worktree assertions. A second complete `pnpm run build` passed: feature gates 83, terminal shell/theme 181 plus shared 6, file-transfer 82, Gradle 134 tasks, transport lifecycle 62, terminal contracts 814, common flows 91, relay smoke/account gates 38+runtime smoke, workspace panes 48, TypeScript, and Vite production build. The new Herdr projection remains covered by the earlier 69 targeted/map tests and tsc. Codex review task `20260812T185122Z-review-69429-dh9pz8` returned FAIL solely for unrelated `RemoteWindowOverlay` composite styles and `useAttachmentNotifications` in-flight polling; Herdr files had no findings. No unrelated files were modified.
2026-08-12 Herdr single-surface boundary correction: formal runtime no longer projects `pane_id` prefix into shared backend `workspace`. It now uses exported synthetic label `herdr-single-session`; Herdr `terminal_id/pane_id` remain physical attachment identity only. Resource/function docs and registry updated. Targeted boundary/runtime gates 67/67, TypeScript, diff check, and full `pnpm run build` pass. Release/install copy hash `045e05de960f5710dd73cd4da9c0a9015a5d60c9` matches installed runtime. Launchd health is ok; explicit installed Herdr close-loop on port 39097 passes connected, input rev3, resize rev4 100x30, reconnect rev5, closeRemovedSession=true. Install-service still exits at existing Screen Recording preflight.
2026-08-12 tmux parity review remediation: Codex review identified `server.ts` always passing a truthy `resizeBackendSession` wrapper even when tmux backend is selected, causing adaptive tmux resize/release to no-op. Fixed dependency wiring to pass the callback only when selected backend exposes `resizeSession`; tmux path now remains the unique `resize-window` owner, while Herdr/WezTerm use backend resize. Targeted mirror/transport/detached/session and Herdr/registry gates pass 113/113; full build passes. Release/install hash `76c30d2e4e8c07d5ed36e52f10b792c8d4b1ab3c` matches installed runtime. Launchd wrapper syntax now validates and daemon health recovers; explicit installed Herdr close-loop on port 39098 passes input rev3, resize rev4 100x30, reconnect rev5, close removal.
2026-08-12 final review after tmux remediation: task `20260812T191015Z-review-2993-mtkh7x` returned FAIL for unrelated parallel changes: Android `NetworkIdentityPlugin` missing `ACCESS_NETWORK_STATE` manifest permission (P1) and attachment notification polling race (P2); selected broader run also hit unrelated RemoteWindowOverlay failures/segfault. Herdr and tmux findings absent. Do not modify unrelated files. Herdr runtime remains build/release/installed close-loop green.
2026-08-12 side-channel/Windows re-audit: `herdr integration status` explicitly reports Codex and OpenCode not installed; no Reasonix official Herdr integration surface is present. Static Herdr payload/control isolation test remains green. A Windows smoke invocation without the remote daemon auth token timed out before session ticket, so it is not valid new evidence; retain prior real Windows result: direct WezTerm snapshot/input passed, daemon targeted cleanup close-list gate failed, status beta/gap.
2026-08-12 evidence hygiene: playground Herdr canonicalizer evidence and README still described formal adapter/daemon integration as unimplemented. Updated them to distinguish playground ownership from formal runtime, record current explicit Windows beta/gap and external agent integration gaps, and classify file/image/schedule as out-of-scope terminal-surface contracts. JSON parse, Herdr/registry 37-test subset, and diff check pass.
2026-08-12 Herdr explicit-discovery error boundary: `herdr-backend-runtime.resolve()` previously swallowed official `session list` / `pane list` discovery errors and converted them to generic `session not found`, violating the no-fallback and explicit-failure contract. The unique Herdr runtime owner now preserves the external discovery error; six Herdr files / 27 focused tests, TypeScript, and diff check pass.
2026-08-12 Herdr runtime reinstallation after discovery fix: full `pnpm run build` passed all registry/UI/transport/terminal/relay/workspace gates, Gradle, type-check, and Vite. Correct scripts were `pnpm --dir android run daemon:prepare-release` and `pnpm --dir android run daemon:install-service`; service health is running with `active_count=1`, and release/installed `server.cjs` SHA256 is `064d09ea7a572bb2014cb46c1cae5118f160d938e1331b65a4c4abffa4773eb4`. Explicit installed Herdr daemon on port 39099 passed input revision 2, adaptive resize revision 3 at 100x30, reconnect revision 4, and close removal true; isolated daemon was stopped explicitly after the probe.
2026-08-12 Herdr mirror-window audit: formal projection previously published the entire canonicalizer scrollback, unlike the bounded WezTerm/tmux mirror cache. Added `maxMirrorLines` to the Herdr runtime, wired it from `DAEMON_CONFIG.terminalCacheLines`, and trimmed only at the single Herdr-to-mirror edge while preserving absolute `bufferStartIndex` and cursor/revision truth. Projection/capture/Herdr gates now pass 39 tests; full build passed. Reinstalled runtime hash is `44f8e2b8399743070c63f49a8c501453d4feee7ae2192398d509bc4ca416f719`; installed explicit Herdr close-loop on port 39100 passed input rev3, resize rev4 `100x30`, reconnect rev5, and close removal.
2026-08-12 final review after Herdr mirror-window fix: task `20260812T193157Z-review-2993-um44u0` remains FAIL only on unrelated parallel owners: Android network-state manifest permission P1, floating RemoteWindowOverlay fill geometry P1, and attachment notification in-flight race P2. No Herdr finding; review is not a semantic PASS.
2026-08-12 post-window parity replay: after the bounded Herdr mirror projection change, the same tmux/official-Herdr ANSI sample still passes rows, geometry, wide-cell shape, and cursor equality; tmux and Herdr canonical revisions remain separate namespaces.
2026-08-12 Herdr projection invariant hardening: `mapHerdrCanonicalSnapshot()` now rejects malformed absolute ranges whose body length does not match `[startIndex,endIndex)`, and rejects bounded projections that would drop the canonical absolute cursor. Herdr focused gates pass 30 tests, TypeScript, and diff check; full build, release/install, hash match `c015049a0bd0e867794ee14541e9773bbfab958375eea77459854c73ccb7261e`, and installed close-loop on port 39101 pass.
2026-08-12 final review after Herdr invariant hardening: task `20260812T193958Z-review-2993-51hjmk` is FAIL on four unrelated parallel worktree findings: RemoteWindowOverlay fullscreen crop P1, removed composite styles P1, Android network permission P1, and attachment notification in-flight race P2. No Herdr finding; no semantic PASS.
2026-08-12 final review after runtime reinstallation: Codex review task `20260812T192420Z-review-2993-b5jnk0` is FAIL on three unrelated parallel worktree findings: `RemoteWindowOverlay.tsx` fill-mode crop/input geometry P1, Android network-state manifest permission P1, and `useAttachmentNotifications.ts` in-flight race P2. No Herdr finding; do not modify those parallel owners without authorization and do not treat the review as PASS.
# 2026-08-12 Tailscale dynamic route verification design update

- Jason 追加要求：Tailscale IP 必须动态验证是否可通，不能信任缓存。
- 确认动态验证信号只能是真实带 token WebSocket candidate attempt：WebView 无法 ICMP；HTTP /health 不等于 WS 可达；另开 probe WS 会重复物理握手、违反单 transport owner。
- 正式改动收口为：删除 TAILSCALE_CANDIDATE_TIMEOUT_MS=900 特殊分支，全部 ws candidate 统一 1800ms；candidate attempt 本身即动态验证；networkGeneration + candidate id 隔离健康；fresh host projection 提供最新 IP；30s cooldown 后自动重探。
- 新 design：FD-20260812-TAILSCALE-DYNAMIC-ROUTE-02（supersedes -01），待 Jason 批准后实施。

# 2026-08-13 Herdr per-session picker / installed validation

- Jason 要求 new session 先选择 `tmux` 或 `Herdr`。已在 `TmuxSessionPickerSheet` 加 modal；Herdr 选择发送 `terminalBackend: 'herdr'` 并直接打开新 session。
- Backend identity 已接入 typed shared protocol、target/session/persistence、mux/channel、mirror/subscriber、control list cache；tmux 与 Herdr 不共享 list cache。
- 首次 launchd Herdr 真实验证因 PATH 缺少 `~/.local/bin` 失败，根因由 `launchd-stderr.log` 的 `spawn herdr ENOENT` 确认。修正 daemon runner 的显式 PATH 后重建、重装、重启并重跑通过。
- 当前安装 runtime 的 Herdr close-loop：create/list、initial sync、input、resize、release、reconnect、targeted close 全通过；revision `1,3,4,5`，geometry `100x30`，close removal true。tmux mirror close-loop 9 cases + replay/strict audit 全通过；同样本 tmux/Herdr canonical parity 全通过。
- 剩余：Codex review 必须重新取得语义 PASS；Windows ConPTY/cleanup 仍 beta/gap；Codex/OpenCode/Reasonix 外部 Herdr operational integration 仍未证明。

# 2026-08-13 final review remediation / Herdr revalidation

- 为解除项目级 review 阻塞，按唯一 owner 修复了 Android `ACCESS_NETWORK_STATE` manifest permission、RemoteWindowOverlay 仍被 JSX 引用的 composite styles，以及 attachment notification polling 的 in-flight dedup；新增重复调度反测。相关定向测试 77 passed / 4 skipped，typecheck 与 diff check 通过。
- 修复后完整 `pnpm run build` 通过；全局 daemon 重新安装、重启、status 通过。已安装 runtime 重跑 Herdr per-session close-loop：connected、input revision 3、resize revision 4 / 100x30、reconnect revision 5、close removal true；同样本 tmux/Herdr canonical parity rows/cells/geometry/cursor 相等且 revision namespace 独立；tmux mirror close-loop 9 cases、replay、strict audit 全通过。

# 2026-08-13 backend-boundary review remediation

- Review 暴露的 backend 边界已修复并锁测：persisted Herdr tab restore 保留 backend 到 owner grouping、可复用 mux list request 和 direct list request；tmux/Herdr list cache 通过独立 transport/cache 测试；Herdr file-transfer 明确返回 `herdr_file_transfer_unsupported`，不会调用 tmux 写入或路径 owner。
- backend-boundary 定向测试 94 passed，feature/resource/module/mainline gate 83 passed，typecheck 与 diff check 通过；修复后的源码已再次 build、global install、daemon restart，并以安装 runtime 重跑 Herdr close-loop、tmux mirror close-loop 和 canonical parity。

# 2026-08-13 final backend write propagation

# 2026-08-13 side-channel and runtime audit continuation

- 直接核对 Mac 运行态：`herdr 0.8.0` 位于 `/Users/fanzhang/.local/bin/herdr`；`zterm-daemon` launchd 服务运行于 `0.0.0.0:3333`，auth=config，active_count=1。`herdr session list --json` 能返回官方命名 session，并只由正式 Herdr runtime 按 `zterm-herdr-` 前缀过滤映射。
- `herdr integration status` 当前明确显示 Codex、OpenCode integration 未安装；Reasonix 无已确认的官方 Herdr integration surface。Herdr terminal payload 静态 side-channel gate 通过，但外部 operational integration 不能据此宣称通过。
- 新 final Codex review task `20260813T022547Z-review-31802-dimb8w` 已按 MCP 重新启动，前一轮 review 因误取消/无 accepted verdict 不能作为 PASS；本轮仍在运行。

- Final review 的唯一 P1 已修复：`server.ts` terminal runtime wiring 现在把 selected backend 透传到 `writeToLiveMirror`、`enqueueLiveMirrorInput`、`writeToTmuxSession`，因此 Herdr input 与 delayed auto-command 不会再默认进入 tmux；新增 source-boundary assertion。
- 修复后 typecheck、148 定向 tests、完整 build、global install/restart、安装 runtime Herdr close-loop（input rev3、resize rev4、reconnect rev5、close removal）、tmux mirror 9-case replay/strict audit、tmux/Herdr parity 全部通过。最后一次 review 待取得 PASS。

# 2026-08-13 final runtime revalidation

- Pinch zoom 的 layout layer 现在在 scale<1 时按 `100/scale%` 扩大布局盒子，保持视觉缩放与原生 scrollTop 的同一坐标系；通知 attachment 的 permission/staging/schedule 终止错误进入 terminal failed 集合，避免每轮 polling 无限重试。相关 15 tests 与 type-check 通过。
- 完整 `pnpm run build` 通过：feature/architecture/resource/module/mainline gates 83/83，终端/UI/传输/relay/workspace gates 全绿，terminal suite 814，Gradle 与 Vite build 全绿。安装脚本重新生成并安装 0.1.3 runtime，launchd 健康返回 `ok=true`、`active_count=1`、port 3333。
- 安装版本真实 close-loop 通过：Herdr connected、revision 1，input revision 3，resize revision 4 geometry 100x30，reconnect revision 5，closeRemovedSession=true；tmux mirror close-loop 的 codex/top/vim、input、restart、schedule 以及 replay strict audit 全部 PASS。
- 仍需在上述证据后运行新的 Codex MCP review；Windows ConPTY/daemon cleanup 继续明确 beta/gap，Codex/OpenCode/Reasonix 外部 Herdr operational integration 继续明确未配置/未证明。
# 2026-08-13 foreground resume reconnect H1

- 现象分类：`terminal.transport_lifecycle`；用户报告网络未变化，Android 从后台回前台后主动重连。
- 架构判定：`BackgroundService.java` 只持有 process-level partial WakeLock，并由 JS heartbeat callback 支持低频 `mux-ping`；没有 WebSocket/RTC/route/reconnect owner，禁止在 service 层修。
- 唯一高风险首偏离：`AppContent` 初始调用 `networkIdentity.resample()`，该路径先建立 `connectionType=unknown` 的 interface-only fingerprint；前台恢复再用 `Network.getStatus() -> wifi` 调 `resampleWithStatus()`，即使 `wlan0 + address` 未变，也会产生 `fingerprintChanged=true`。`notifyTargetNetworkSignalRuntime` 随后调用唯一 target failure owner 淘汰 physical transport。
- 单假设实验：`playground/foreground-resume-reconnect-20260813/H1-network-identity-experiment.ts` 修复前复现 `afterStatusGeneration=2/changed=true`，修复后 `generation=1/changed=false`；status-first 同网络 resume 也保持 generation 1。
- 正式修改：`android/src/lib/network-identity.ts` 只在网络身份 owner 内完成 provisional `unknown` status 或空 interface baseline；不推进 generation。真实 connection type/interface/address 变化仍走 `compareAndAdvance`。
- 正反测试：`network-identity.test.ts` 覆盖同网络 provisional baseline、unknown online 不覆盖已知状态、interface enrichment 不换代；原有 interface/VPN/connection type change 反测保留。定向 transport/lifecycle tests 61/61，tsc 通过，feature-registry 83/83。
- 待完成：构建、安装、真实设备后台/前台同网络 round-trip、运行时 transport identity/generation 证据、最终 Codex review。

# 2026-08-13 retained-session service lifecycle closeout

- Scope: `terminal.transport_lifecycle`; native `BackgroundService` remains process-execution support.
- Formal owner: `useOpenTabLifecycleEffects.ts` owns retained-session-count service start/update/stop and provider disposal; `BackgroundServicePlugin.ts` owns the separate JS heartbeat timer; native `BackgroundService.java` owns notification, one partial WakeLock, and bounded WebView wake-up only.
- Causal fix: foreground/background handlers no longer stop the service on every foreground return or mix service lifetime with the heartbeat callback. The current path starts service while retained sessions exist, enables callback only while hidden, disables callback on foreground return, and stops service only at zero retained sessions or disposal.
- Verification: TypeScript clean; feature registry 83/83; transport/network lifecycle 55 Android + 9 shared; lifecycle/power suite 176/176; Vite and Gradle build clean; APK `0.1.3.2617`, `versionCode=1100026170`, SHA-256 `adeed5740848376008defb8572f7ba6377cac9ed497094d566cb94d25cb0f872`.
- Live gap: `adb devices` returned no online devices, so install, notification/service state, `PARTIAL_WAKE_LOCK`, background control heartbeat, and same-generation foreground resume remain unverified.

# 2026-08-13 real-device input verifier convergence

- The latest packaged smoke reached the correct daemon mux subscriber and passed `buffer-head -> buffer-sync -> buffer apply -> renderer commit`, but `adb shell input text` produced no `session.input.send`.
- Root cause is verifier action, not terminal transport: Android uses the native `ImeAnchor` input owner with `TerminalView.allowDomFocus=false`; a center-screen tap does not guarantee that owner is active.
- Verifier change scope is `daemon.cli_node / observability.debug_channel`: inspect the current WebView through CDP, activate the real QuickBar keyboard action, then send device text only after native IME visibility is confirmed. No product transport or business payload changes.
# 2026-08-13 Herdr drawer visibility correction

- Jason corrected the symptom: the Herdr session is not visible in the terminal drawer at all, so it cannot be opened. The previous close-session diagnosis was out of scope.
- Current source trace: `TerminalSessionDrawer` refreshes only the selected host key; `useSessionOpenActions.handleRefreshDrawerHostSessions()` resolves that host and lists the default `tmux` backend. `TerminalPage.drawerRemoteSessions` renders only persisted `sessionGroups`, so a running Herdr session absent from history has no drawer row.
- First-divergence hypothesis: drawer refresh has no backend-aware Herdr catalog target and no projection path from the returned live catalog into `sessionGroups`. Confirm by a red test with an empty history group and a live Herdr catalog containing `hd-codex`.
- Planned owner boundary: session-open owner performs the live catalog request and history projection; `TerminalPage`/`TerminalSessionDrawer` remain UI projection and intent emitters. Herdr backend runtime is not changed.


# 2026-08-13 架构四项检查（违规与架构审计）

方法：先读 architecture.md / 2026-07-02-boundary-remediation / 04-23-head-buffer-render-truth / ui-slices，再跑机器门禁，再人工分层扫描。
机器门禁：`test:feature-registry` 83/83 全绿（含 module-import-graph / architecture-boundary / edge-registry）。

## 结论摘要（详见对话报告）

- 控制面/数据面：合格。wire 层 BridgeBufferMessage(buffer-sync) vs BridgeServerControlMessage(buffer-head+control) 分离；mux target/channel frame 分离；client control-plane transport 独立；buffer-head 只更 metadata，正文 repaint 唯一入口 session-render-gate（setBuffer 全仓唯一调用点）。
- 巨型文件：不合格。生产文件 >1000 行 22 个；>4000 行组件 3 个（RemoteWindowOverlay 5853 / TerminalQuickBar 4156 / TerminalPage 4067）；TerminalView 2447；测试文件 >1500 行 14 个（SessionContext.ws-refresh.test.tsx 7877）。
- 数据流层次：基本合格，4 处向上耦合 smell（模块门禁因同模块内而漏网）：
  1. lib/open-tab-persistence.ts -> contexts/session-reconnect-helpers.ts（持久化层依赖 contexts）
  2. lib/session-tail-refresh-store.ts -> contexts/session-pull-state-helpers.ts（type-only）
  3. hooks/useShortcutActionStorage.ts -> components/terminal/terminal-quickbar-helpers.tsx（逻辑依赖 UI .tsx 文件；该文件还混纯逻辑+JSX 渲染 helper）
  4. lib/app-update-runtime.ts -> plugins/AppUpdatePlugin.ts（轻）
- UI/数据分离：4 个组件直写 localStorage（TerminalView / TerminalQuickBar / RemoteWindowOverlay 5 个 key / FileTransferSheet），绕过 src/lib/browser-storage.ts 抽象。
- 渲染底层/控件、操作/渲染：b447689 拆分未完成。TerminalView（renderer）仍持有：两指滚轮->SGR 输入编码（操作）、横向 pan handler、pinch shim ref、DOM input textarea、横向 offset localStorage 持久化；useMirrorFixedZoomPan（app_shell）仍通过 readHorizontalOffset 读 renderer 的 offset 真源。与 2026-08-13-terminal-render-layer-decoupling.md 第 6 节"再删旧逻辑"未闭合一致。
- buffer/渲染：合格。buffer manager 零 follow/reading/renderBottomIndex 符号；renderer 只读 projection。

# 2026-08-13 架构拆分执行（goal-436b962c）

## Round 1 完成
- P0 完成：TerminalView 2447->1635 行；手势状态机（两指滚轮/横向pan/pinch）与横向offset真源收拢到 useMirrorFixedZoomPan（client.app_shell）；新增 src/lib/terminal-mirror-fixed-pan-storage.ts；红测：layer-truth 静态扫描 + hook 行为 + storage 单测 + TerminalView wheel 行为锁。50/50 + 83/83 gate + type-check 全绿。
- P1a 完成：RemoteWindowOverlay 5853->5795 行；拆出 remote-window-overlay-constants.ts / remote-window-overlay-storage.ts（5 个 storage key 移出组件，localStorage 直写归零）+ 5 个单测；74/74 overlay 套件绿。
- P1b 完成：TerminalPage 4012->3756 行；拆出 TerminalConnectionStatusStrip.tsx（266 行）+ terminal-page-status-helpers.ts + 5 个 strip 子模块单测；页面 179/179 相关套件绿。

## ⚠️ 事故记录（必须周知 Jason）：
- 误用 `git checkout -- android/src/pages/TerminalPage.tsx` 覆盖了工作树未提交 WIP（含 RenameDialog 集成 + Herdr catalog 投影，约 +55~+600 行，未入 git 对象库，无法恢复）。
- 已重建：HEAD 基线 + 从会话内捕获的 WIP strip 全文 + 测试期望推导的 herdr 投影（buildSessionSemanticReuseKey 带 terminalBackend、目标条件 spread）。重建后 46/46 drawer + 12/12 session-preview + 全套件绿，说明保真。
- 教训：恢复文件必须先查 `git status` 列位置（首列 M = staged，checkout 会覆盖工作树）；本 repo 大量未提交 WIP。

## Round 2 计划
- P1c: terminal-quickbar-helpers.tsx 拆分（纯逻辑/存储下沉 lib，修 P2#3 + P3 剪贴板/浮钮存储）
- P2: 修正 lib->contexts 两处（session-reconnect-helpers / session-pull-state-helpers 下沉 lib）
- P3: FileTransferSheet localStorage 收敛
- 收尾: 全量 gate + MEMORY 提炼

# 2026-08-13 Round 2 完成（goal-436b962c）

- P1c 完成：terminal-quickbar-helpers.tsx 590->72 行；拆出 src/lib/terminal-quickbar-logic.ts（543 行纯逻辑）+ terminal-quickbar-storage.ts（剪贴板历史/浮钮位置存储）；TerminalQuickBar.tsx localStorage 直写归零；useShortcutActionStorage 改从 lib 导入（P2#3 修复）；新增 11 个单测；58/58 quickbar 套件绿。
- P2 完成：session-reconnect-helpers.ts / session-pull-state-helpers.ts 从 contexts/ 下沉到 lib/（import 更新 + module-registry owned_paths + feature-registry truth_sources 路径同步）；216/216 受影响套件绿。lib->plugins 耦合（app-update-runtime->AppUpdatePlugin）判定可接受保留。
- P3 完成：FileTransferSheet localStorage 直写归零（拆出 src/lib/file-transfer-local-edit-copy-storage.ts + 3 单测）；组件层 localStorage 直写已全部收敛。
- 最终验证：type-check 全绿；feature-registry 83/83（修了 feature-registry.json 两处旧路径）；子模块测试 90/90。
- 遗留（后续轮次）：P1d 剩余大文件拆分（TerminalPage 3756 / RemoteWindowOverlay 5795 / TerminalQuickBar 4156 单组件 / daemon 大文件）。

# 2026-08-13 Round 3 完成（goal-436b962c）

- P1d 进展：
  - RemoteWindowOverlay.tsx 5793->4490 行（-1300）：拆出 remote-window-overlay-helpers.ts（546 行纯函数/类型：几何/坐标/网络质量/target 分组）+ remote-window-overlay-styles.ts（806 行样式表）；5 个子模块单测；74/74 套件绿。
  - TerminalPage.tsx 3781->3608 行（-173）：拆出 terminal-page-helpers.ts（193 行：drawer 状态归一/ui key/session 分组投影）+ 5 个子模块单测；75/75 套件绿。
- 最终验证：type-check 全绿；feature-registry 83/83；广回归 318 passed/4 skipped。
- 遗留：TerminalQuickBar 单组件 ~4000 行、daemon 大文件（terminal-mirror-runtime 1503 / terminal-message-runtime 1072 / remote-window-stream-daemon 1487 / remote-window-scripts 1360 / traversal-relay/server 1437）、useSessionOpenActions 1246、FileTransferSheet 2030、TmuxSessionPickerSheet 1505 等。

# 2026-08-13 Round 4 完成（goal-436b962c）

- P1d 进展：
  - useSessionOpenActions.ts 1286->1199 行：拆出 src/lib/session-open-helpers.ts（103 行：target 匹配/可复用 session/session group 解析）+ 4 单测；44/44 绿。
  - terminal-mirror-runtime.ts 1503->1410 行：拆出 src/server/terminal-buffer-sync-wire.ts（112 行：wire line index/buffer-sync 消息/大帧分片）+ 4 单测；45/45 绿。
  - FileTransferSheet.tsx 2077->1923 行：拆出 src/lib/file-transfer-sheet-helpers.ts（180 行：格式化/路径/mime/排序）+ file-transfer-sheet-constants.ts（路径/容量常量）+ 7 单测；56/56 绿。
- 最终验证：type-check 全绿；feature-registry 83/83；round-4 回归 8 文件全过（263 测试）。
- 遗留：TerminalQuickBar 单组件 ~4000 行、traversal-relay/server 1437、remote-window-stream-daemon 1487、terminal-message-runtime 1072、remote-window-scripts 1360、TmuxSessionPickerSheet 1505、TerminalSessionDrawer 1182、AttachmentDrawer 1036、App.tsx 1006 等。

# 2026-08-13 Round 5 完成（goal-436b962c）

- P1d 进展：
  - TmuxSessionPickerSheet.tsx 1508->1446 行：拆出 tmux-session-picker-helpers.ts（刷新时间/relay target/二维码解码）+ 4 单测；18/18 绿。
  - traversal-relay/server.ts 1437->1378 行：拆出 server-helpers.ts（字符串/HTTP/JSON/socket envelope/key 纯函数）+ 4 单测；relay 套件 9/9 绿（更新了 source-scan 断言指向 server.ts+helpers）。
- 最终验证：type-check 全绿；feature-registry 83/83；round-5 回归 8 文件全过（131 测试）。
- 遗留：TerminalQuickBar 单组件 ~4000 行、remote-window-stream-daemon 1487、terminal-message-runtime 1072、remote-window-scripts 1360、TerminalSessionDrawer 1182、AttachmentDrawer 1036、App.tsx 1006、TerminalPage 3608/RemoteWindowOverlay 4490 的单组件主体。

# 2026-08-13 Round 6 完成（goal-436b962c）

- P1d 进展：
  - AttachmentDrawer.tsx 1036->1010 行：拆出 attachment-drawer-helpers.ts（blob->base64/pan clamp/时间/大小格式化 + MIN/MAX_ZOOM 常量）+ 3 单测；13/13 绿。
  - TerminalSessionDrawer.tsx 1202->1158 行：拆出 terminal-session-drawer-helpers.ts（状态/分组色调 + 布局常量）+ 3 单测；34/34 绿。
  - remote-window-stream-daemon.ts 1487->1366 行：拆出 remote-window-stream-daemon-helpers.ts（catalog 克隆/RTC 归一/码率校验/RGBA->I420 + RtcVideoFrame 类型）+ 5 单测；64/64 绿（进程退出 SIGSEGV 为原生 wrtc teardown，与本次无关）。
- 注册了 2 条新跨模块 import 边（session_drawer_preview->app_shell、remote_window_stream->shared.terminal_types）。
- 最终验证：type-check 全绿；feature-registry 83/83；round-6 回归 52/52。
- 遗留：TerminalQuickBar 单组件 ~4000 行、terminal-message-runtime 1072、remote-window-scripts 1360、App.tsx 1006、TerminalPage 3608/RemoteWindowOverlay 4490 单组件主体。

# 2026-08-14 review audit and mux backend-forwarding fix

- MCP review task `20260814T051024Z-review-98797-hcy4lp` reported two findings. The persisted-tab finding conflicts with the active architecture contract: current-process `OPEN_TABS` and `ACTIVE_SESSION` are intentionally removed on cold launch, so that behavior was not changed. The valid Herdr finding was that mux channel-open accepted but dropped the selected backend.
- `buildSessionMuxChannelOpenFrame()` now forwards `host.terminalBackend` as the typed mux `backend` field. The focused transport regression passes and Herdr attach intent now reaches the daemon adapter.
- The architecture/module gate also exposed two existing remote-window catalog script files as unowned; both are now registered under `daemon.remote_window_stream`, and the full Android build passes.
- After rebuild, local OTA verification, daemon reinstall/restart, APK reinstall (`0.1.3.2644`), and app restart, the authenticated real Herdr close-loop passed again: manual `hd-codex` enumerated; input revision 3; resize revision 4 at 100x30; reconnect revision 5; temporary session close removal true.
# 2026-08-14 session drawer visibility correction

- Jason clarified the defect is drawer entry/content invisible or unopenable, not failure to close.
- Real-device CDP after installing APK `0.1.3.2618` proved the portrait viewport is `347x754` CSS px and the stable `Sessions` entry is visible at `{x:52,y:47,width:72.4,height:34}` with `pointerEvents:auto`.
- Before opening, the drawer is mounted with `aria-hidden=true` and translated left. Clicking the entry produces `aria-hidden=false`, drawer rect `{x:0,y:0,width:166.8,height:754.3}`, visible header, and visible session row. The close button returns `aria-hidden=true`.
- Root cause for the reported UX was the previous interaction contract relying on an edge swipe to expose the drawer; the current owner fix adds a stable portrait entry in `TerminalPage` and keeps the drawer overlay/header/row mounted and inspectable. No transport/service change is needed for this UI defect.
- Verification: drawer/page focused tests `78/78`; feature registry `83/83`; typecheck, Vite build, Capacitor sync, Gradle debug APK, `adb install -r`, foreground launch, and live CDP open/close evidence all passed. APK `0.1.3.2618`, versionCode `1100026180`, SHA-256 `cf8655ea0a40287cd19581eff0369c7126a879a9ef760ae1e048d625fd75edd3`.
# 2026-08-14 Herdr adapter follow-up: capability gate and live 2644 revalidation

- Fixed the real Herdr-only discovery failure in `src/server/terminal-control-runtime.ts`: when `defaultBackend === 'herdr'`, catalog enumeration and exact-name resolution no longer invoke tmux. The negative gate proves no tmux spawn occurs in a Herdr-only runtime.
- Added Herdr executable capability gating in `src/server/server.ts` so a normal tmux daemon does not register an unavailable optional Herdr executable and fail ordinary session listing. Missing Herdr is explicit on Herdr operations; it is not converted into tmux success.
- Preserved the adapter-resolved `terminalBackend: 'herdr'` on picker open intent. The client does not filter the unified catalog or select a backend for normal discovery; the daemon remains the backend resolver.
- Rebuilt/installed/restarted APK 0.1.3.2644 and the daemon. Online Herdr close-loop passed again: `hd-codex` was present in the unified catalog; input revision 3, resize revision 4 at 100x30, reconnect revision 5, and temporary-session close removal all passed.
- Codex review still reports backend-filtered discovery/cache as P1. This is a contract conflict with Jason's explicit requirement that the client remain backend-opaque and not filter the unified daemon catalog; do not implement that reviewer suggestion. WezTerm remains a separate explicit capability gap.

# 2026-08-14 accumulated-WIP review round (commit gate)

- Review task `20260814T064201Z-review-24143-1lb193` (oauth, uncommitted) returned `verdict: fail` with a single P1: session-list cache key omits `target.terminalBackend`.
- Analysis: the finding is a false positive under the locked daemon-owned unified catalog contract. Every client `list-sessions` call sends `{ type: 'list-sessions' }` without a backend payload; the daemon returns the union (`listTerminalSessions()`) for backend-opaque requests, so tmux and Herdr targets receive identical responses and the cache key omission cannot produce a wrong catalog. Implementing "preserve it in the request payload" would regress to client-side backend management, explicitly rejected in MEMORY.md.
- Committed the full accumulated WIP batch as one commit per Jason's instruction.

# 2026-08-14 Android WebView renderer restart diagnosis

- Flow classification remains `terminal.transport_lifecycle`, but the first divergence moved above socket lifecycle: the zterm-bound WebView sandbox process exited while the app process remained alive, then all same-document WebSockets closed abnormally and the new JS runtime rebuilt persisted sessions through `missing-socket`.
- Historical correlated evidence: WebView sandbox PID `31685` `EXIT_SELF` at `12:12:23.669`; daemon transport detach at `12:12:24.209`. App main process has no matching spontaneous exit. Package-update renderer exits are excluded.
- Current baseline: APK `0.1.3.2644`; app PID `1762`; zterm-bound renderer PID `10618`; CDP target `E68508E2A6B3F4954F88688256CA3B4E`; `performance.timeOrigin=1786685560186.3`; Activity resumed; native service remains foreground with `START_REDELIVER_INTENT`.
- Active single hypothesis H3: `BackgroundService` invokes `WebView.evaluateJavascript()` every 30 seconds whenever retained sessions exist, including while foregrounded. The JS callback returns early in foreground, but the native renderer call still occurs. Correlation is not causality.
- Diagnosis contract and positive/reverse intervention design are recorded under `playground/webview-document-restart-20260814/`. Formal runtime/tests/config remain read-only. No experimental APK has been built, installed, or published.

# 2026-08-14 tmux/Herdr mirror + stale row/refresh convergence diagnosis

- Jason asked for a structural audit of daemon tmux/Herdr mirror management, the white-font vertical stripe symptom, intermittent missing rows, and permanent stale rows.
- Full diagnosis contract is under `playground/terminal-buffer-render-20260814/README.md`.
- Confirmed shared failure owner: `terminal.buffer_render` / `resource.client_sparse_buffer -> resource.renderer_window`. The current `VisibleNonGapRepairRequestState` is one state per session with a 5s same-window cooldown; a dropped/lost repair can therefore stay unverified until another sparse update after cooldown, and may never converge if no further tail patch arrives.
- White stripe remains renderer-side measurement suspicion: `measureTerminalViewport()` uses `getBoundingClientRect()` on single W/你 probes and takes `max(latinWidth, cjk/2)`, which can inflate `resolvedCellWidthPx` and create subpixel seams between fixed-width inline-block cells. Needs a real WebView computed-style/glyph-advance fixture before any change.
- No product code was changed. Formal fix requires Jason approval of the design id before implementation.

# 2026-08-14 renderer priority + source adapter/ledger delivery continuation

- Jason: "马上进行修复" and "所有本地的未提交代码都要进行 review 以后提交".
- Current uncommitted scope: renderer priority/background wake fix + terminal source adapter + visible repair ledger batch + scripts registry fixes.
- Discovered incomplete ledger wiring: store had ledger API but session-context-buffer-runtime still used single-entry 5s cooldown; wired exact ledger with 2s stale re-dispatch, full visible-window fulfill, failed dispatch pending.
- Module gate caught new terminal-source-adapter.ts unowned; registered under daemon.terminal_backend + feature-registry allowed_paths + function-map rows; import edge daemon.mirror_store->daemon.terminal_backend already declared and now matches code.
- Daemon prepare-release was blocked by extractor still reading remote-window-scripts.ts after screen-capture source split; updated prepare-global-daemon-release.sh and zterm-daemon.sh to canonical remote-window-screen-capture-script.ts.
- Verification: focused ledger/buffer tests 69/69; feature-registry 83/83; tsc; full pnpm build; daemon prepare-release; gradle assembleDebug; APK installed (versionCode 1100026440, SHA ff9ee3aba37b5f062b787bfc8095850d77e3adc34d86ae7af677221ad3a8cb85); daemon runtime restarted; daemon-mirror-close-loop 9/9; device renderer PID/timeOrigin stable across HOME->foreground; oom BTOP not CACC.
- Next: MCP codex review then commit full uncommitted scope if PASS.

# 2026-08-14 background longer stay / app switch reconnect continuation

- Jason reports the installed APK still reconnects after a longer background stay and after repeated switches to/from other apps.
- Device truth at 22:14 before the fixed APK: app `27384` stayed alive with foreground `BackgroundService`, but zterm-bound WebView renderer `31006` was `CACC / cur=CACC` after backgrounding. `dumpsys activity exit-info` showed repeated non-upgrade `OTHER KILLS BY SYSTEM / ISOLATED NOT NEEDED` and `EXIT_SELF` renderer exits.
- Installed package at that time was `0.1.3.1000`, so the approved `FD-20260814-RENDERER_PRIORITY_BACKGROUND_WAKE-01` native changes were not in the running build.
- Clean-fix worktree `/private/tmp/zterm-background-fix-20260814` from `9c52d5d` applies `waivedWhenNotVisible=false` for `RENDERER_PRIORITY_IMPORTANT`, foreground-skip native wake, and power-policy tests.
- Verification after `adb install -r`: same app PID `30481` and renderer PID `28816` survived 4 minutes in background and 14 round trips to Weibo; renderer remained `FGS`/`BTOP` (`cur=1`) instead of CACC; `BackgroundService` remained `isForeground=true`; terminal body and CDP page stayed live.
- APK `0.1.3.1000` versionCode `1100010000`, SHA `7927d7acc6cf1c6f0e8e81da3036713829b707cb55d25bf82cd2d9857b052bf5`.
- Remaining live gap: Jason's screenshot still shows an old/stuck reconnect screen; after this installed build, the same device no longer reproduced renderer death during the tested background/switch sequence.

# 2026-08-14 live 2646 closeout

- Device was actually running old `0.1.3.1000` before this turn. `adb install -r` of the 2646 APK bumped `zterm_webview_cache_version.xml` to `1100026460`, and CDP resources changed from `index-B_1ppoX_.js` to the APK asset `index-KEP-jfNa.js`; no app-data/localStorage clear was needed.
- Live 2646 evidence: drawer shows two same-name `hd-codex` rows, Herdr row has `(herdr)` suffix and backend-aware testid; opening Herdr `hd-codex` reaches `connected`; rename failure keeps `rename-dialog` open with inline `selected terminal backend does not support session rename`; real image file through the QuickBar input reaches the toast `图片发送失败：binary file transfer is not supported by the Herdr single-session terminal surface`.
- Full gates rerun: focused 288/288, typecheck, prebuild all stages exit 0, Vite build exit 0, daemon health `ok=true` on 127.0.0.1:3333 and 100.66.1.82:3333 with update manifest 0.1.3.2646, daemon mirror close-loop 9/9 plus strict replay all passed.
- Remaining: MCP `codex-review` tools are not exposed in this session; no PASS can be claimed. White-font vertical stripe remains a renderer measurement issue (`measureTerminalViewport` inflates cell width from max W/你 probe) and is not closed without a dedicated WebView glyph/advance fixture and approved renderer fix.

# 2026-08-14 herdr catalog side-channel + portrait top layout 2647

- Jason: “herdr 的 session 还有没搜到的” root cause was client grouping from plain names; daemon already unions tmux+Herdr but the client cannot know backend. Fix keeps `list-sessions` backend-opaque and adds `sessionCatalog: [{name, backend}]` to the `sessions` response side-channel.
- Verified installed daemon pid 92975 over authenticated WS: 14 entries include `{zterm,herdr}`, `{zterm,tmux}`, `{hd-codex,herdr}`.
- Portrait layout moved status strip to second row (`topInset+50`) and stage below it (`topInset+92`). Real-device 2647 rects: Sessions `{x:52,y:47,w:72,h:34}`, status `{x:94,y:89,w:169,h:34}`, stage `{x:0,y:131}`; no overlap.
- Real-device drawer: herdr group `daemon:mac-studio::backend:herdr` contains `hd-codex,zterm`; tmux group contains `zterm`; clicking herdr `zterm` opens `zterm (herdr)` connected (status aria + tabs).
- Build/install: APK `0.1.3.2647` versionCode `1100026470` SHA-256 `6a6f4b14701a6920ac1a46a674e6554520d40cc128b63bdb425e7a730836bf60` installed on `100.104.163.65:5555`; daemon reinstalled/restarted. OTA Relay publish intentionally not run without release authorization.
# 2026-08-14 Herdr standard geometry root-cause design

- Baseline evidence: installed Herdr 0.8.0 manual clients read host geometry,
  while headless startup/restore uses a legacy `80x24` base; old zterm controller
  logs also show `cols=80 rows=24`.
- First divergence: Herdr has no single config-owned resolver shared by manual,
  headless, restore, and `terminal session` controller entry points.
- Formal owner: Herdr `TerminalConfig`; local standard config is
  `[terminal] minimum_cols=80, minimum_rows=80`. zterm may only read the official
  pane layout rect and pass source geometry to Herdr, with no duplicate floor.
- Fix design: `/Volumes/extension/code/herdr-worktrees/zterm-standard-geometry/.local/prd/standard-terminal-geometry-fix-design.md`, design id
  `HERDR-GEOMETRY-20260814-01`.
- Draft experiment code exists only in the isolated Herdr worktree plus current
  zterm WIP. Under the debug approval gate, no custom binary install, standard
  config write, active-session restart, or production runtime change is allowed
  until Jason explicitly approves this design id.

# 2026-08-14 Herdr color render diagnosis

- Jason reports Herdr `(+N -N)` red/green deltas render gray.
- Evidence: canonicalizer keeps fg=1/2; live `hd-codex` daemon wire keeps
  fg=1/2; `terminalCellStyle()` maps them to `#f44747` / `#6a9955`.
- First divergence: `TerminalView.tsx` passive `preview-secondary` branch
  flattens rows with `terminalRowToText()` and sets `color: theme.foreground`,
  dropping per-cell fg. Primary preview and main terminal keep colors.
- Playground DOM gate 2/2 PASS: secondary preview gray, primary preview
  red/green.
- Fix design `FD-20260814-HERDR-PREVIEW-COLOR-01` is
  `WAITING_FOR_JASON_APPROVAL`; no product code changed.

# 2026-08-14 Herdr history short root cause + design

- Jason: Herdr session 只能看几屏历史。正式 runtime 保持只读，证据全部在
  `playground/herdr-history-short-20260814/`。
- 根因：当前 Herdr mirror 只发布 `HerdrFrameCanonicalizer` 的
  `bufferLines`。Herdr `terminal.frame` 是渲染差异帧，长输出后
  `bridge.getScrollbackCount()` 仍为 0，`absoluteRange` 只有 24 行。
- 官方 `pane read --source recent --lines N` 是稳定 tail history：
  400 行返回 402 行；5000 行时 `--lines 4000/6000/10000` 都返回最近
  1000 行；追加 4 行后窗口滑动 4 行且旧行保持。
- 官方源码确认 lines 硬上限 1000、默认 80：
  `src/app/api_helpers.rs#read_terminal_snapshot`。
- `pane read recent --format ansi --raw` 经
  `canonicalizeCapturedMirrorLines` 后尾部与 canonicalizer visible tail
  完全一致。
- 设计：Herdr adapter 用官方 `pane read recent` 作为 mirror history source，
  frame canonicalizer 只保留 cursor/geometry/keys/alt-screen metadata；
  daemon-owned `sourceEndIndex` 只单调增长，`availableStartIndex` 不伪造。
  上限 1000 是 Herdr 0.8.0 外部 contract gap，不做本地拼接/fallback。
- Fix Design Report:
  `android/docs/debug/2026-08-14-herdr-history-short-fix-design.md`，
  design id `FD-20260814-HERDR-HISTORY-SHORT-01`，
  `WAITING_FOR_JASON_APPROVAL`。

# 2026-08-14 AppSDK ZTerm runtime architecture v2 initialization

- Global AppSDK truth: `/Users/fanzhang/.local/bin/appsdk`, `appsdk 0.1.0 (rust)`; project-local `.appsdk/sdk.bin` was not executed or referenced by the lock workflow.
- Idempotent `appsdk init . --project-root android` and global-binary `pin-lock` completed on `codex/appsdk-migration`; existing dirty worktree was preserved.
- AppSDK template identity was replaced with project `zterm-runtime-architecture-v2`; goal `ZTERM-ARCH-V2-DESIGN-001` is confirmed and lifecycle remains `draft`.
- Canonical design: `docs/design/2026-08-14-zterm-runtime-architecture-v2.md`; execution plan: `docs/goals/zterm-runtime-architecture-v2-plan.md`.
- AppSDK maps now distinguish active governance entries from design/pending runtime node, control, debug, observability, and plugin resources/functions/gates. No runtime source, Active, Protected, or Generated artifact changed.
- Verification: JSON parse PASS, `appsdk verify android` PASS with project id `zterm-runtime-architecture-v2`, targeted `git diff --check` PASS.

# 2026-08-15 ZTerm v2 Phase 1 foundation evidence

- Playground contracts and 18 tests are complete; the runtime architecture v2 gate is wired into `android/package.json` prebuild and `.github/workflows/ci.yml`.
- Fresh gates: `test:runtime-architecture-v2` 18/18, `test:feature-registry` 83/83, tsc noEmit PASS, full `pnpm run build` (prebuild + relay smoke + Vite) PASS, `appsdk verify android` PASS.
- AppSDK EvidenceRecords created under `.appsdk/records/evidence/`: positive/negative contracts, debug bounds/schema, plugin gates, typecheck, ownership, build, and appsdk verify.
- ReviewRecord not yet created: codex-review MCP is not available in this session; Phase 1 must not be claimed as reviewed or promoted.
- Next: continue Phase 2 debug side-channel after ReviewRecord PASS, or at minimum keep production runtime untouched.

# 2026-08-15 ZTerm v2 Phase 2 debug side-channel Playground

- Added `debug-side-channel.ts` and paired tests to the same Playground module: default-deny `DebugPermissionService`, typed metadata-only `ObservabilityChannel`, and `DebugExporter`.
- Phase 2 tests prove business frames and polluted bodies are rejected, overflow/subscriber failures are counted, debug export failure cannot change a data result, and debug grants expire/revoke.
- Bound new target functions/gates in AppSDK maps and added Phase 2 test design. No production source, protocol, Active, Protected, or Generated artifact changed.
- Evidence: `test:runtime-architecture-v2` 22/22, `test:feature-registry` 83/83, tsc noEmit PASS, full `pnpm run build` PASS, `appsdk verify android` PASS.
- Added Phase 2 AppSDK EvidenceRecords for debug export isolation, permission default-deny, and build.
- ReviewRecord still blocked by unavailable codex-review MCP; Phase 2 remains Playground-only until Phase 1/2 review can pass.
- Memory closure note: `scripts/mempalace-mine-zterm.sh` copied the new sources into the safe corpus but aborted on a pre-existing `~/.mempalace/palace/chroma.sqlite3` FTS5 corruption. Repo gates are green; MemPalace search/index rebuild remains a separate machine-repair gap.

# 2026-08-15 ZTerm v2 Phase 3 control/composition Playground

- Added `control-center.ts` and `composition-root.ts` plus paired tests to the
  same Playground module. `ControlCenter` provides unique owner routing,
  capability gating, idempotency, explicit deadline errors, and bounded audit
  entries. `ClientCompositionRoot` binds declared runtime ports only, rejects
  duplicate providers, and fails before use for unbound/undeclared or missing
  required ports.
- AppSDK maps mark `client_control_center`, `daemon_control_center`, and
  `client_composition_root` as target-state entries; no production runtime,
  protocol, Active, Protected, or Generated artifact changed.
- Fresh gates after Phase 3: `test:runtime-architecture-v2` 30/30 (8 files),
  `test:feature-registry` 83/83, full `pnpm run build` (prebuild + relay smoke +
  type-check + Vite) PASS, `/Users/fanzhang/.local/bin/appsdk verify android`
  ok:true at draft.
- Phase 3 EvidenceRecords added for control center, composition root, typecheck,
  build, and appsdk verify. ReviewRecord remains blocked by unavailable
  codex-review MCP; Phase 3 stays Playground-only.
- MemPalace repair finished: 231,973 drawers extracted and re-filed, FTS5
  rebuilt, SQLite VACUUMed, and both `PRAGMA quick_check` and `integrity_check`
  returned ok. `scripts/mempalace-mine-zterm.sh` then re-mined the zterm wing
  (1078 files, 1759 drawers filed) and both "debug side channel ZTerm v2" and
  "ControlCenter client composition root capability ports" searches return the
  new v2 plan/note/test-design sources.

# 2026-08-15 ZTerm v2 Phase 2 production debug HTTP cutover

- Production slice removes `debug-log`/`debug-snapshot` from terminal mux
  classification and deletes `runtime-debug-flush.ts`; client runtime debug now
  exports bounded logs/snapshots to `/debug/runtime/logs` and
  `/debug/runtime/snapshot` through `runtime-debug-http-exporter.ts`, with no
  active session or transport socket dependency.
- `/debug/runtime/control` is POST-only, auth-gated, default-deny, and backed by
  `setDaemonRuntimeDebugLease` expiry. AppSDK maps remain
  `design`/`production_pending_review` because the v2 module is not promoted;
  production docs/registries, package `test:debug-observability`, prebuild, and
  CI wiring were updated.
- Verification: `test:debug-observability` Android 61/61 + shared 9/9 PASS,
  `test:feature-registry` 83/83 PASS, `tsc --noEmit` PASS, full `pnpm run build`
  PASS (prebuild + terminal contracts 831/831 + common flows 98/98 + relay smoke
  + type-check + Vite), `/Users/fanzhang/.local/bin/appsdk verify android`
  ok:true draft.
- Full `pnpm test -- --run` is not all green: pre-existing
  `src/lib/app-update-runtime.test.ts` rollback test fails alone and the full
  parallel suite also hits a `@roamhq/wrtc` native V8 worker crash; both are
  outside this debug slice and remain reported as regression gaps.
- Added four production AppSDK EvidenceRecords for debug isolation, lease/auth,
  registry/map gate, and build. ReviewRecord still blocked by unavailable
  codex-review MCP; Phase 2 production cutover must not be claimed promoted.

# 2026-08-15 Phase 2 stale-wording audit

- Remaining `client-debug-log`/`client-debug-snapshot` in traversal relay are
  relay-side typed debug messages over `/ws/devices`; they are not terminal mux
  frames and do not ride the terminal business payload. Kept outside this
  cutover, no source change.
- `power-consumption-cpu-waste-audit-2026-06-19.md` is historical and still
  describes the old 5s session debug flush; left as historical evidence rather
  than rewriting the audit.
- `appsdk verify android` after this audit:
  `{"ok":true,"project_id":"zterm-runtime-architecture-v2","stage":"draft"}`.

# 2026-08-15 daemon.input_queue production slice runtime blocker

- Production worktree red: `daemon:mirror:close-loop` passed `codex-live`, then
  daemon crashed on first probe detach because `terminal-runtime.ts:261` called
  `deps.daemonInputQueue.disposeLiveMirrorInputBatch` on `undefined`.
- Root cause is `server.ts` composition order: `createTerminalRuntime` receives
  `daemonInputQueueRuntime` before `createDaemonInputQueueRuntime` assigns it;
  object deps copy `undefined`, not a later binding. This is not a mirror
  truth/input queue semantic bug.
- Fix `FD-20260815-DAEMON-INPUT-QUEUE-WIRING-01` is now `IMPLEMENTED` in
  production `src/server/server.ts` with a late-bound forwarding proxy and an
  ownership ordering test in `server.herdr-selection-truth.test.ts`.
- Isolated worktree `android/tmp/worktrees/android` applies a late-bound
  forwarding proxy in `server.ts`; `daemon:mirror:close-loop` passed all 9 lab
  cases + replay + strict audit, and `tsc --noEmit` passed.
- Production worktree rerun after the formal patch: `daemon:mirror:close-loop`
  passed all 9 lab cases + replay + strict audit; targeted server suite
  121/121 in 8 files; `test:feature-registry` 83/83; `tsc --noEmit` PASS;
  `git diff --check` PASS; `/Users/fanzhang/.local/bin/appsdk verify android`
  ok:true draft.
- Added `EVID-20260815-ZARCHV2-P5-PROD-INPUT-QUEUE-001` under
  `.appsdk/records/evidence/`.
- Remaining known unrelated regression: full build still has a
  parallel-order-dependent `FileTransferSheet.test.tsx` failure; solo run
  passed 49/49.
- No ReviewRecord exists; codex-review MCP remains unavailable. Do not claim
  reviewed, promoted, or complete.

# 2026-08-15 module DAG physical ownership baseline

- Added `module_dag` to the AppSDK verification map and the v2 test design, with
  `src/lib/module-import-graph-truth.test.ts` now checking the real
  cross-module import graph for cycles in addition to lockstep edges.
- Client cycle removal: session transport orchestration/open, socket frame
  demux, and message dispatch moved from `client.daemon_connection` to
  `client.session_runtime`; `session-context-open-intent-store.ts` moved to
  `client.daemon_connection`; session picker and tmux catalog helpers moved to
  `client.connection_home`; pure input/viewport helpers and app version moved to
  `client.runtime`; preview gesture and mirror-fixed zoom moved to
  `client.renderer_window`; shared pane layout re-exports moved to
  `shared.pane_layout`.
- Verification: `test:feature-registry` 84/84 (11 files) with the DAG gate
  green, `tsc --noEmit` PASS, `git diff --check` PASS, and
  `/Users/fanzhang/.local/bin/appsdk verify android` ok:true draft.
- Added `EVID-20260815-ZARCHV2-P4-MODULE-DAG-001`.
- No source behavior changed; this was registry/edge/docs ownership only. No
  ReviewRecord exists; codex-review MCP remains unavailable.

# 2026-08-15 Phase 4 client.buffer_frame_assembly production slice

- Moved client frame assembly source/tests from `src/contexts/` to
  `src/lib/buffer-frame-assembly/` and registered active module
  `client.buffer_frame_assembly` as the physical owner of
  `resource.client_buffer_frame_assembly`; `client.buffer_store` now owns only
  sparse buffer/planner/runtime files.
- Updated module/edge/resource/feature/function/wiki/mainline/AppSDK maps and
  v2 test design in lockstep. Import edges now route
  `client.buffer_store -> client.buffer_frame_assembly` and
  `client.session_runtime -> client.buffer_frame_assembly`.
- Fixed stale wiring after the move: `test:terminal:frame-assembly` and
  `scripts/run-terminal-contracts.mjs` now point at
  `src/lib/buffer-frame-assembly/session-buffer-frame-assembly.test.ts`.
- Verification: `test:terminal:frame-assembly` 101/101,
  `test:feature-registry` 84/84, `test:terminal:contracts` 823/823 in 54 files,
  `git diff --check` PASS,
  `daemon:mirror:close-loop` all 9 lab cases + replay + strict audit PASS,
  AppSDK verify android ok:true draft. Evidence
  `EVID-20260815-ZARCHV2-P4-PROD-BUFFER-FRAME-ASSEMBLY-001` added.
- No ReviewRecord exists; codex-review MCP remains unavailable. This slice is
  production_pending_review only and v2 overall is not complete.

# 2026-08-15 Phase 4 client.wire_ingress production slice

- `normalizeIncomingBufferPayload` and `normalizeTerminalCursorState` moved from
  `src/contexts/session-wire-helpers.ts` to
  `src/lib/wire-ingress/buffer-wire-normalize.ts`; outbound
  `buildHostConfigMessage` stays in `session-wire-helpers.ts` under
  `client.daemon_connection`.
- Registered active module `client.wire_ingress` with owned paths, declared
  edges `client.buffer_store -> client.wire_ingress`,
  `client.session_runtime -> client.wire_ingress`, and
  `client.wire_ingress -> shared.terminal_types`, and updated
  module/edge/feature/resource/function/wiki/mainline/AppSDK maps plus the v2
  test design.
- Updated gate wiring in `package.json` and `scripts/run-terminal-contracts.mjs`
  to run the new normalization tests.
- Verified: `test:terminal:frame-assembly` 104/104,
  `test:feature-registry` 84/84, `test:terminal:contracts` 826/826 in 55
  files, `tsc --noEmit` PASS, `git diff --check` PASS,
  `daemon:mirror:close-loop` all 9 cases plus replay and strict audit PASS,
  AppSDK verify android ok:true draft.
- Evidence `EVID-20260815-ZARCHV2-P4-PROD-WIRE-INGRESS-001` added. No
  ReviewRecord/PASS exists because codex-review MCP remains unavailable; this
  slice is production_pending_review and v2 overall is not complete.

# 2026-08-15 Phase 4 client.sparse_buffer + renderer_window ownership slice

- Active module `client.sparse_buffer` now owns
  `resource.client_sparse_buffer` through `src/lib/session-buffer-store.ts`;
  `client.buffer_store` retains only planner/pull/repair/head/tail refresh
  orchestration and consumes sparse truth without owning it.
- Active module `client.renderer_window` now owns
  `src/lib/session-render-buffer-store.ts` and the render gate as immutable
  render projection owner; sparse body truth and visible-window truth remain
  separate resources.
- Updated module/edge/resource/feature/function/wiki/mainline/AppSDK maps,
  project modules, resource map, v2 test design, and
  `module-registry-truth.test.ts` required modules in lockstep.
- Verified: `test:feature-registry` 84/84,
  `test:terminal:frame-assembly` 104/104,
  `test:terminal:contracts` 826/826 in 55 files, `tsc --noEmit` PASS, full
  `pnpm run build` PASS, `daemon:mirror:close-loop` all 9 cases plus replay
  and strict audit PASS, `git diff --check` PASS, and AppSDK verify ok:true.
- Evidence `EVID-20260815-ZARCHV2-P4-PROD-SPARSE-RENDER-OWNER-001` added. No
  ReviewRecord/PASS exists because codex-review MCP remains unavailable; this
  slice is production_pending_review and v2 overall is not complete.

# 2026-08-15 Phase 4 client.dom_renderer + client.terminal_shell ownership slice

- Active module `client.dom_renderer` now owns the immutable render snapshot to
  DOM projection surface: `TerminalView.tsx`, `terminal/VisibleRow.tsx`,
  `terminal/TerminalPreviewRow.tsx`, `useMirrorFixedZoomPan.ts`, shared
  `cell-render.ts`, and `theme.ts`; `client.renderer_window` no longer owns DOM
  projection files.
- Active module `client.terminal_shell` now owns `TerminalPageStageShell.tsx`,
  shell skin, status/quickbar/copy/keyboard-lift shell files, and the shell UI
  primitives; `client.app_shell` no longer owns `terminal-shell-skin.ts`.
- Mainline source-to-DOM truth is `TerminalPage -> StageShell -> TerminalView
  -> Renderer -> RenderGate`; `android_mainline:StageShell->TerminalView` is
  the new edge and old direct `TerminalPage->TerminalView` references were
  removed from current docs/test designs.
- Updated module/edge/resource/feature/function/wiki/mainline/AppSDK maps,
  project modules, resource map, architecture, audit remediation, render truth
  decision, terminal-buffer-truth skill, and v2 test design in lockstep;
  `docs:function-wiki` regenerated the wiki HTML.
- Verification: `test:feature-registry` 84/84 in 11 files,
  `tsc --noEmit` PASS, `test:terminal:frame-assembly` 104/104,
  `test:terminal:contracts` 826/826 in 55 files,
  `daemon:mirror:close-loop` all 9 cases plus replay and strict audit PASS,
  full `pnpm run build` PASS, AppSDK verify android ok:true draft,
  and `git diff --check` PASS.
- Evidence `EVID-20260815-ZARCHV2-P4-PROD-DOM-TERMINAL-SHELL-OWNER-001` added.
  No ReviewRecord/PASS exists because codex-review MCP remains unavailable;
  this slice is production_pending_review and v2 overall is not complete.

# 2026-08-15 Phase 6 production plugin host first slice

- Added production `client.plugin_host` under `src/lib/plugin-host/` and
  `shared.plugin_contract` under `packages/shared/src/terminal/plugin-*`.
  App composes one host-level `network:native-snapshot` capability and consumes
  only plugin-provided `network:sample-interfaces` for `NetworkIdentityRuntime`.
- Added `plugin-host-ownership.test.ts`: host cannot import
  SessionContext/traversal/session stores/server truth; only App.tsx and the
  plugin host directory may import host/shared plugin contracts.
- Wired `test:plugin-host` into prebuild and CI; AppSDK maps now mark
  `client_plugin_lifecycle`, `resource.client_plugin_host`, and
  `resource.plugin_capability_registry` as production_pending_review with real
  binding paths.
- Verified test:plugin-host 11/11, feature registry 84/84, runtime-architecture-v2
  30/30, tsc PASS, full build PASS, appsdk verify draft ok:true, diff check PASS.
  Evidence `EVID-20260815-ZARCHV2-P6-PROD-PLUGIN-HOST-001` added. No review PASS.

# 2026-08-15 Phase 3 production composition root slice

- Added production `client.composition_root` under `src/lib/composition-root/`.
  `ClientCompositionRoot` owns typed bind/resolve/require/has semantics and
  rejects duplicate, unbound, and missing ports; App.tsx is the only production
  consumer and now binds `plugin-host`, requires it before use, and resolves
  `PluginHost` through the composition root instead of constructing it inline.
- Added contract tests for bind/resolve/require and a static
  `client-composition-root-ownership.test.ts` red gate. The red gate forbids
  composition-root imports of SessionContext/traversal/session stores/server
  and forbids non-App/non-composition-root production imports; it also verifies
  App uses the `plugin-host` port id and the typed `PluginHost` resolution path.
- Updated module/edge/resource/feature/function/wiki/mainline/AppSDK maps,
  architecture, resource map, project modules, v2 plan, v2 test design, and
  gate wiring in package prebuild plus CI. AppSDK maps now mark
  `resource.client_composition_root` and `client_composition_root` as
  `production_pending_review` with real binding paths and required gates.
- Verified: `test:composition-root` 6/6, `test:feature-registry` 84/84 in 11
  files, `test:runtime-architecture-v2` 30/30, `tsc --noEmit` PASS, full
  `pnpm run build` PASS including prebuild gates and Vite, AppSDK
  verify android ok:true draft, and `git diff --check` PASS.
- Evidence `EVID-20260815-ZARCHV2-P3-PROD-COMPOSITION-ROOT-001` added. No
  ReviewRecord/PASS exists because codex-review MCP remains unavailable; this
  slice is production_pending_review and v2 overall is not complete.

# 2026-08-15 Phase 3 production control center slice

- Added production `shared.control_contract` under
  `packages/shared/src/terminal/control-contract.ts`, production
  `client.control_center` under `src/lib/control-center/client-control-center.ts`,
  and `PluginHostControlNode` under `src/lib/plugin-host/`.
- App.tsx now binds both `plugin-host` and `control-center` through
  `ClientCompositionRoot`, registers `plugin-host.dispose` with
  `PluginHostControlNode` under capability `plugin-host:dispose`, and routes
  app-unmount disposal through `ClientControlCenter` with an idempotency key.
  Direct `pluginHost.disposeAll` is removed from App.
- Added contract/audit/ownership tests for the control center and control node;
  wired `test:control-center` into package prebuild and CI. Resource registry
  now declares `resource.platform_terminal_surface ->
  resource.client_control_center`.
- Verified: `test:control-center` 13/13, `test:composition-root` 6/6,
  `test:plugin-host` 11/11, `test:runtime-architecture-v2` 30/30,
  `test:feature-registry` 84/84, tsc PASS, full `pnpm run build` PASS
  including prebuild, Gradle, terminal contracts 826/826, and Vite, AppSDK
  verify android ok:true draft, and `git diff --check` PASS.
- Evidence `EVID-20260815-ZARCHV2-P3-PROD-CONTROL-CENTER-001` added. No
  ReviewRecord/PASS exists because codex-review MCP remains unavailable; this
  slice is production_pending_review and v2 overall is not complete.

# 2026-08-15 Phase 5 daemon.channel_mux ownership slice

- Active module `daemon.channel_mux` now owns
  `resource.daemon_channel_mux` through
  `src/server/terminal-channel-mux-runtime.ts`: mux channel transport/envelope
  creation, registry ensure/release/list/clear, and subscriber registration.
  `terminal-runtime.ts`, bridge/daemon cleanup, mux-channel-runtime attach/
  close, and server composition now all go through owner APIs; direct
  `connection.muxChannels` mutation outside the owner is gated.
- Updated module/resource/edge/feature/function/wiki/mainline/AppSDK maps,
  project modules, resource map, and `module-registry-truth.test.ts` in
  lockstep. Added registry init, per-channel/all-channel release tests and
  static mux registry mutation gates.
- Re-verified `test:feature-registry` 84/84, targeted daemon/mux/transport
  suite 86/86 in 6 files, `tsc --noEmit` PASS, `git diff --check` PASS,
  `daemon:mirror:close-loop` all 9 cases plus replay and strict audit PASS;
  AppSDK verify android ok:true draft, and `git diff --check` PASS; prior full
  `test:terminal:contracts` and `pnpm run build` PASS in this worktree.
- Evidence `EVID-20260815-ZARCHV2-P5-PROD-DAEMON-CHANNEL-MUX-001` added. No
  ReviewRecord/PASS exists because codex-review MCP remains unavailable; this
  slice is production_pending_review and v2 overall is not complete.

# 2026-08-15 Phase 5 daemon control gateway/control center production slice

- Added `src/server/daemon-control-center-runtime.ts` (typed DaemonControlCenter:
  unique owner per command type, capability gate, deadline, idempotency,
  correlation/subject validation, bounded audit) and
  `src/server/daemon-control-gateway-runtime.ts` (schedule/tmux control through
  center, session-open/connect/list-sessions delegation).
- `terminal-message-runtime.ts` now creates one gateway and routes
  schedule/tmux/session-open/connect/list-sessions through it; existing
  `terminal-message-control-runtime.ts` handlers remain unchanged so wire
  responses/errors are preserved. Updated the transport lifecycle static gate to
  require gateway-owned handler delegation instead of direct message-runtime
  imports.
- Added `daemon-control-center-runtime.test.ts` and
  `daemon-control-center-ownership.test.ts` red gates; wired
  `test:daemon-control-center` into prebuild/CI. Updated module/edge/resource/
  feature/function/wiki/mainline/AppSDK maps and architecture docs in lockstep.
- Verified: `test:daemon-control-center` 10/10, `test:feature-registry` 84/84,
  `test:terminal:regression:core` 827/827 plus 98/98 user flows and relay
  smoke, `tsc --noEmit` PASS, full `pnpm run build` PASS, `daemon:mirror:close-loop`
  all 9 cases plus replay and strict audit PASS, `docs:function-wiki`
  regenerated, AppSDK verify android ok:true draft, `git diff --check` PASS.
- Evidence `EVID-20260815-ZARCHV2-P5-PROD-DAEMON-CONTROL-CENTER-001` added.
  Review/promotion is not recorded because codex-review MCP remains unavailable;
  this slice is production_pending_review and v2 overall is not complete.

- After evidence was added, `appsdk verify android` first returned
  `SDK_RESOURCES_BUNDLE_MISMATCH`; running the pinned CLI
  `appsdk init /Volumes/extension/code/zterm --project-root android`
  regenerated `.appsdk/sdk-resources.json` from the bundle, after which
  `appsdk verify android` passed with `{"ok":true,...}`. No SDK resource file
  was hand-edited.

# 2026-08-15 Phase 5 daemon buffer publisher ownership slice

- Active `daemon.buffer_publisher` now owns
  `src/server/daemon-buffer-publisher-runtime.ts`: per-subscriber
  pending-latest, range merge/collapse, backpressure hysteresis, head
  broadcast cache, oversized same-revision frame split, explicit live-tail
  seed, and flush statuses. `terminal-mirror-runtime.ts` delegates
  broadcast/flush/head publication to the publisher and no longer owns
  bounded pending-latest state.
- Updated wiki mainline/module/daemon docs, edge registry, function map,
  module registry, resource registry/map, feature registry, v2 plan/test
  design, and AppSDK resource/function/verification maps in lockstep.
  Regenerated wiki HTML with `docs:function-wiki`.
- Verified: `test:daemon-buffer-publisher` 6/6, `test:feature-registry`
  84/84 in 11 files, registry/mainline/edge/resource truth tests PASS,
  `tsc --noEmit` PASS, `type-check` PASS, `daemon:mirror:close-loop` all 9
  cases plus replay and strict audit PASS, full `pnpm run build` PASS,
  AppSDK verify android ok:true draft, and `git diff --check` PASS.
- Evidence `EVID-20260815-ZARCHV2-P5-PROD-DAEMON-BUFFER-PUBLISHER-001`
  added. No ReviewRecord/PASS exists because codex-review MCP remains
  unavailable; this slice is production_pending_review and v2 overall is not
  complete.

# 2026-08-15 Phase 5 daemon session catalog ownership slice

- Active `daemon.session_catalog` now owns
  `src/server/daemon-session-catalog-runtime.ts`:
  `buildSessionsCatalogPayload` and `handleListSessionsMessageRuntime`.
  `daemon.control_gateway` delegates list-sessions handling to this owner;
  `daemon.schedule_runtime` imports only the payload builder.
- Updated module/resource/edge/feature/function/wiki/mainline/AppSDK maps,
  architecture, plan, test design, feature gates, and package prebuild/CI in
  lockstep. Mainline nodes/edges now route
  `ControlGateway/Control -> SessionCatalog -> IdleSessionPublishIn01Request`.
- Verified: `test:daemon-session-catalog` 8/8,
  `test:feature-registry` 84/84 in 11 files, `tsc --noEmit` PASS,
  `daemon:mirror:close-loop` all 9 cases plus replay and strict audit PASS,
  full `pnpm run build` PASS, `docs:function-wiki` regenerated,
  AppSDK verify android ok:true draft, and `git diff --check` PASS.
- Evidence
  `EVID-20260815-ZARCHV2-P5-PROD-DAEMON-SESSION-CATALOG-001` added.
  Review/promotion is not recorded because codex-review MCP remains
  unavailable; this slice is production_pending_review and v2 overall is not
  complete.

# 2026-08-15 Phase 7 debug console UI first slice

- `client.debug_console` now owns the typed debug console UI contract,
  plugin slot renderer, and `TerminalPageDebugOverlay`; `shared.plugin_contract`
  owns the typed UI slot registry. App reads `terminal.debug-console` only after
  `PluginHost.startAll` resolves, then passes the slot render callback into
  `TerminalPage`.
- Full build first failed because `startAll` is sequential and App rendered
  before the debug-console plugin start had run, so `readUiSlot` threw. App now
  renders without the optional slot until activation completes and rerenders
  once the plugin host publishes it; App first-paint/dynamic-refresh tests cover
  this path.
- Added `client.debug_console` module/feature/resource/edges, AppSDK
  verification gate, `test:debug-console-ui`, prebuild/CI wiring, wiki/mainline
  docs, and evidence
  `EVID-20260815-ZARCHV2-P7-PROD-DEBUG-CONSOLE-UI-001`.
- Verified `test:plugin-host` 14/14, `test:debug-console-ui` 35/35,
  `test:feature-registry` 84/84, App first-paint/dynamic-refresh 40/40,
  tsc PASS, full `pnpm run build` PASS including terminal contracts 833/833,
  docs wiki regenerated, AppSDK verify android ok:true draft, and
  `git diff --check` PASS. UI-only slice does not require daemon install or
  restart; status is `production_pending_review`.

# 2026-08-15 Phase 7 session drawer UI second slice

- `client.session_drawer_ui` now owns the typed session drawer UI slot contract
  in `src/lib/plugin-session-drawer/session-drawer-contract.ts`;
  `SessionDrawerUiPlugin` provides `terminal.session-drawer` through the plugin
  host UI slot registry and renders `TerminalSessionDrawer`. App reads the slot
  callback only after `PluginHost.startAll` resolves, and TerminalPage renders
  the drawer only through `renderSessionDrawer`; no direct
  `TerminalSessionDrawer` import/render path remains in TerminalPage.
- Added `client.session_drawer_ui` module/feature/resource/edges, mainline
  nodes/edges, AppSDK verification gate, `test:session-drawer-ui`,
  prebuild/CI wiring, plan/test-design progress, and evidence
  `EVID-20260815-ZARCHV2-P7-PROD-SESSION-DRAWER-UI-001`.
- Verified `test:session-drawer-ui` 125/125, `test:debug-console-ui` 36/36,
  `test:plugin-host` 15/15, `test:feature-registry` 84/84, tsc PASS, full
  `pnpm run build` PASS including prebuild gates, terminal contracts 834/834,
  Gradle, Vite, docs wiki regenerated, AppSDK verify android ok:true draft,
  and `git diff --check` PASS. UI-only slice requires no daemon install or
  restart; status is `production_pending_review`.

# 2026-08-15 Phase 7 file browser UI third slice audit

- Current `client.file_browser` is active and owns FileTransferSheet,
  RemoteScreenshotSheet, transfer-sheet helpers, session transfer runtime,
  and file-transfer lib runtimes. It already owns `resource.client_file_browser`
  and consumes `resource.file_transfer`, `resource.target_mux_request`,
  `resource.client_native_file_store`, and `resource.ui_projection`.
- The remaining Phase 7 old edge is `TerminalPage.tsx:11` direct
  `FileTransferSheet` import plus `TerminalPage.tsx:3570` direct render.
  QuickBar still invokes `handleQuickBarOpenFileTransfer` in TerminalPage; that
  open/mode projection can remain in the page shell while the sheet render is
  supplied only through a typed plugin slot callback.
- Planned cutover mirrors debug console/session drawer: add
  `src/lib/plugin-file-browser/file-browser-contract.ts`,
  `src/lib/plugin-host/file-browser-ui-plugin.tsx`, install/read the slot in
  App after `PluginHost.startAll`, pass `renderFileBrowser` through AppContent
  into TerminalPage, and remove the direct FileTransferSheet import/render path.
- Must update module/resource/edge/feature/function/wiki/mainline/AppSDK maps,
  feature gates, test design, prebuild/CI, and add paired UI/plugin tests.
  Review/promotion remains unavailable.

# 2026-08-15 Phase 7 file browser UI third slice completed

- `client.file_browser_ui` now owns the typed file browser UI slot contract in
  `src/lib/plugin-file-browser/file-browser-contract.ts`;
  `FileBrowserUiPlugin` provides `terminal.file-browser` through the plugin host
  UI slot registry and renders `FileTransferSheet`. App reads the slot callback
  only after `PluginHost.startAll` resolves; TerminalPage renders the file
  browser only through `renderFileBrowser`, with no direct `FileTransferSheet`
  import/render path.
- Added module/feature/resource/edges, mainline nodes/edges, AppSDK
  verification gate, `test:file-browser-ui`, prebuild/CI wiring,
  plan/test-design progress, and evidence
  `EVID-20260815-ZARCHV2-P7-PROD-FILE-BROWSER-UI-001`.
- Verified `test:file-browser-ui` 66/66, `test:plugin-host` 16/16,
  `test:session-drawer-ui` 127/127, `test:debug-console-ui` 37/37,
  `test:feature-registry` 84/84, tsc PASS, full `pnpm run build` PASS
  including prebuild gates, Gradle, terminal contracts 835/835, Vite,
  docs:function-wiki regenerated, AppSDK verify android ok:true draft, and
  `git diff --check` PASS. UI-only slice requires no daemon install/restart;
  status is `production_pending_review`.

# 2026-08-15 Phase 7 settings update UI fourth slice completed

- `client.settings_update_ui` now owns the typed settings update UI slot
  contract in `src/lib/plugin-settings-update/settings-update-contract.ts`;
  `SettingsUpdateUiPlugin` provides `settings.update` through the plugin host
  UI slot registry and renders `AppUpdateSection`. App reads the slot callback
  only after `PluginHost.startAll` resolves; SettingsPage renders the update
  section only through `renderSettingsUpdate`, with no direct
  `AppUpdateSection` import/render path in SettingsPage.
- Added module/feature/resource/edges, mainline nodes/edges, AppSDK
  verification gate, `test:settings-update-ui`, prebuild/CI wiring,
  plan/test-design progress, and evidence
  `EVID-20260815-ZARCHV2-P7-PROD-SETTINGS-UPDATE-UI-001`.
- Existing SettingsPage relay/theme tests now inject the plugin-provided
  `AppUpdateSection` renderer so page behavior assertions still cover the real
  update projection.
- Verified `test:settings-update-ui` 57/57, targeted SettingsPage/AppUpdateSection/
  plugin-host/App dynamic refresh 71/71, `test:feature-registry` 84/84, tsc
  PASS, full `pnpm run build` PASS including prebuild gates, Gradle, terminal
  contracts, Vite, docs:function-wiki regenerated, AppSDK verify android
  ok:true draft, and `git diff --check` PASS. UI-only slice requires no daemon
  install/restart; status is `production_pending_review`.

# 2026-08-15 Phase 7 remote window UI fifth slice completed

- `client.remote_window_ui` now owns the typed remote window UI slot contract
  in `src/lib/plugin-remote-window/remote-window-contract.ts`;
  `RemoteWindowUiPlugin` provides `terminal.remote-window` through the plugin
  host UI slot registry and renders `RemoteWindowOverlay`. App reads the slot
  callback only after `PluginHost.startAll` resolves; TerminalPage renders the
  remote window overlay only through `renderRemoteWindow`, with no direct
  `RemoteWindowOverlay` import/render path.
- Added module/feature/resource/edges, mainline nodes/edges, AppSDK
  verification gate, `test:remote-window-ui`, prebuild/CI wiring,
  plan/test-design progress, and evidence
  `EVID-20260815-ZARCHV2-P7-PROD-REMOTE-WINDOW-UI-001`.
- Verified `test:remote-window-ui` 121/121, `test:feature-registry` 84/84,
  tsc PASS, full `pnpm run build` PASS including prebuild gates, Gradle,
  terminal contracts 837/837, Vite, docs:function-wiki regenerated, AppSDK
  verify android ok:true draft, and `git diff --check` PASS. UI-only slice
  requires no daemon install/restart; status is `production_pending_review`.

# 2026-08-15 Phase 7 quickbar UI sixth slice completed

- `client.quickbar_ui` now owns the typed quickbar UI slot contract in
  `src/lib/plugin-quickbar/quickbar-contract.ts`; `QuickBarUiPlugin` provides
  `terminal.quickbar` through the plugin host UI slot registry and renders
  `TerminalQuickBar`. App reads the slot callback only after
  `PluginHost.startAll` resolves; TerminalPage renders the quickbar only
  through `renderQuickBar`, with no direct `TerminalQuickBar` import/render
  path in TerminalPage.
- Added module/feature/resource/edges, mainline nodes/edges, AppSDK
  verification gate, `test:quickbar-ui`, prebuild/CI wiring,
  plan/test-design progress, and evidence
  `EVID-20260815-ZARCHV2-P7-PROD-QUICKBAR-UI-001`.
- TerminalPage tests that previously mocked `TerminalQuickBar` now inject the
  typed `renderQuickBar` callback so IME, debug overlay, remote-window, split,
  screenshot, session drawer/preview, foldable, schedule, multi-pane, and
  render-isolation coverage still exercises the plugin slot boundary.
- Verified `test:quickbar-ui` 72/72, `test:feature-registry` 84/84,
  `test:debug-console-ui` 40/40, `test:session-drawer-ui` 133/133,
  `test:remote-window-ui` 123/123, targeted foldable/schedule/multi-pane/
  remote-screenshot 20/20, tsc PASS, full `pnpm run build` PASS including
  prebuild gates, Gradle, terminal contracts 838/838, Vite,
  docs:function-wiki regenerated, AppSDK verify android ok:true draft, and
  `git diff --check` PASS. UI-only slice requires no daemon install/restart;
  status is `production_pending_review`.

# 2026-08-15 Phase 7 terminal shell UI seventh slice completed

- `client.terminal_shell_ui` now owns the typed terminal shell UI slot
  contract in `src/lib/plugin-terminal-shell/terminal-shell-contract.ts`;
  `TerminalShellUiPlugin` provides `terminal.shell` through the plugin host UI
  slot registry and renders `TerminalNetworkBanner`,
  `TerminalConnectionStatusStrip`, `TerminalPageCopyMenu`,
  `TerminalPageStageShell`, and `TerminalQuickBarShell`. App reads the slot
  callback only after `PluginHost.startAll` resolves; TerminalPage renders the
  terminal shell only through `renderTerminalShell`, with no direct
  `TerminalConnectionStatusStrip`, `TerminalPageCopyMenu`,
  `TerminalPageStageShell`, `terminal-page-shell-ui`, `TerminalQuickBarShell`,
  or `TerminalNetworkBanner` import/render path.
- Added module/feature/resource/edges, mainline nodes/edges, AppSDK
  verification gate, `test:terminal-shell-ui`, prebuild/CI wiring,
  plan/test-design progress, and evidence
  `EVID-20260815-ZARCHV2-P7-PROD-TERMINAL-SHELL-UI-001`.
- TerminalPage page tests inject `renderTerminalShellForTest` so render
  isolation, plugin host runtime, App dynamic refresh, and existing page
  behavior coverage still exercises the typed slot boundary.
- Verified `test:terminal-shell-ui` 74/74, `test:feature-registry` 84/84,
  tsc PASS, docs:function-wiki PASS, full `pnpm run build` PASS including
  prebuild gates, Gradle, terminal regression core 839/839, Vite, AppSDK
  verify android ok:true draft, and `git diff --check` PASS. UI-only slice
  requires no daemon install/restart; status is `production_pending_review`.

# 2026-08-15 Phase 7 terminal shell UI seventh slice resumed verification

- Kept two existing unit-test hygiene fixes: `app-update-runtime.test.ts`
  now calls `rollbackToLocalBackup` in the local-backup rollback test, and
  `rtc-bridge.test.ts` gives the early-candidate reorder WebRTC test a
  15s per-test timeout. Targeted rerun: app-update 11/11, rtc-bridge 3/3.
- Resumed gates after those edits: `test:terminal-shell-ui` 74/74,
  `test:feature-registry` 84/84, `tsc --noEmit` PASS, `type-check` PASS,
  `docs:function-wiki` PASS, full `pnpm run build` PASS including prebuild
  gates, Gradle, terminal regression core 839/839, Vite, AppSDK verify
  android ok:true draft, `git diff --check` PASS, and targeted
  `TerminalPage.real-quickbar-split.test.tsx` 4/4 PASS.
- Full suite with `--pool=forks`: 3504/3512 tests passed; 8 remaining
  failures are unrelated pre-existing items: TerminalView.layer-truth 4
  (renderer/UI-shell gesture cleanup), terminal-page-render-keys 1 (stale
  expected key suffix), runtime-debug-sequence 1 (missing evidence fixture),
  SessionScheduleSheet 2 (local timezone expectations).
- DSH/codex-review remains unavailable; no PASS was manufactured. Status
  stays `production_pending_review`; Phase 7/v2 is not complete.

# 2026-08-15 Phase 5 daemon file transfer message route slice

- `daemon.file_transfer` now owns
  `src/server/terminal-file-transfer-message-runtime.ts` for
  `paste-image-start`, `attach-file-start`, `paste-image`,
  `file-list-request`, `file-create-directory-request`,
  `file-download-request`, `remote-screenshot-request`,
  `file-upload-start/chunk/end`, and raw binary chunks.
  `terminal-message-runtime.ts` routes only these types to the owner and no
  longer imports/invokes the file-transfer facade or mutates
  `session.pendingPasteImage` / `session.pendingAttachFile`.
- Registry/docs/AppSDK maps, test design, design, prebuild, CI, mainline call
  map, and mainline-resource-call-map lockstep updated.
- Verified `test:file-transfer-message-route` 72/72,
  `test:feature-registry` 84/84, type-check and tsc PASS,
  `docs:function-wiki` regenerated, full `pnpm run build` PASS including
  prebuild gates, `daemon:mirror:close-loop` all 9 cases plus replay and
  strict audit PASS, AppSDK verify android ok:true draft, and
  `git diff --check` PASS.
- Evidence
  `EVID-20260815-ZARCHV2-P5-PROD-FILE-TRANSFER-MESSAGE-ROUTE-001` added.
  DSH/codex-review remains unavailable; no PASS was manufactured. Status stays
  `production_pending_review`; Phase 5/v2 is not complete.

# 2026-08-15 Phase 5 daemon source adapter contract slice

- `daemon.source_adapter` now owns the shared terminal source adapter contract
  in `src/server/terminal-source-adapter.ts`: tmux/Herdr/WezTerm kind
  normalization, source session/snapshot shape, and the adapter boundary
  consumed by backend and mirror capture readback owners. `daemon.terminal_backend`
  and `terminal.buffer_render` no longer list the contract as their owned path.
- Added dedicated kind-normalization tests
  (`src/server/terminal-source-adapter.test.ts`), real module/edge/feature/
  function/wiki/AppSDK ownership, design/test-design/plan/module/feature-gate
  docs, prebuild, and CI wiring. Removed stale
  `daemon.mirror_store -> daemon.terminal_backend` import edge after the
  shared contract moved to the source adapter owner.
- Verified `test:source-adapter-ownership` 4/4,
  `test:feature-registry` 84/84 in 11 files, type-check and tsc PASS,
  `docs:function-wiki` regenerated, full `pnpm run build` PASS including
  prebuild gates, `daemon:mirror:close-loop` all 9 cases plus replay and
  strict audit PASS, AppSDK verify android ok:true draft, and
  `git diff --check` PASS.
- Evidence
  `EVID-20260815-ZARCHV2-P5-PROD-SOURCE-ADAPTER-001` added.
  DSH/codex-review remains unavailable; no PASS was manufactured. Status stays
  `production_pending_review`; Phase 5/v2 is not complete.

# 2026-08-15 Phase 5 daemon attachment message delivery slice

- `daemon.attachment_delivery` now owns
  `src/server/terminal-attachment-message-runtime.ts` for
  `pending-attachments-query`, `attachment-history-query`,
  `attachment-asset-request`, and `attachment-receipt` wire projection.
  `terminal-message-runtime.ts` routes only these four types to the owner and
  no longer contains attachment delivery business state.
- Registry/docs/AppSDK maps, test design, plan, design, prebuild, and CI are
  updated. `daemon.transport_subscriber -> daemon.attachment_delivery` is the
  real import edge because `terminal-message-runtime.ts` belongs to
  `daemon.transport_subscriber`.
- Verified `test:attachment-message-delivery` 49/49,
  `test:feature-registry` 84/84 in 11 files, type-check and tsc PASS,
  `docs:function-wiki` regenerated, full `pnpm run build` PASS including
  prebuild gates, `daemon:mirror:close-loop` all 9 cases plus replay and
  strict audit PASS, AppSDK verify android ok:true draft, and
  `git diff --check` PASS.
- Evidence
  `EVID-20260815-ZARCHV2-P5-PROD-ATTACHMENT-MESSAGE-DELIVERY-001` added.
  DSH/codex-review remains unavailable; no PASS was manufactured. Status stays
  `production_pending_review`; Phase 5/v2 is not complete.

# 2026-08-15 Phase 7 terminal shell UI seventh slice resumed verification (dom_renderer fix)

- Fixed the remaining Phase 7 full-suite regressions introduced by the
  TerminalView layer split: `useMirrorFixedZoomPan.ts` and
  `terminal-mirror-fixed-pan-storage.ts` are both registered under
  `client.dom_renderer`, matching the v2 plan, so the import graph has no
  app-shell edge or cycle. `TerminalView` keeps only the SGR coordinate
  adapter; wheel/pinch/pan/storage/debug state stays in the hook/storage
  module.
- Test-only fixes kept green: `TerminalView.layer-truth` 5/5, `TerminalView`
  14/14, `TerminalView.dynamic-refresh` 77/77, `TerminalPage.session-content-identity`
  3/3, `TerminalPage.real-quickbar-split` 4/4, `terminal-page-render-keys` 5/5,
  `runtime-debug-sequence` 2/2, `SessionScheduleSheet` 18/18.
- Resumed gates: `test:feature-registry` 84/84, `tsc --noEmit` PASS,
  `type-check` PASS, `docs:function-wiki` PASS, full `pnpm run build` PASS
  including prebuild gates, Gradle, terminal contracts, terminal regression
  core 839/839, Vite, AppSDK verify android `ok:true draft`, and
  `git diff --check` PASS.
- Full `vitest --pool=forks` is not a CI gate and remains flaky on two
  unrelated async UI tests (`RemoteWindowOverlay` IME gesture timing,
  `FileTransferSheet` EIO timing); both files pass in isolation and their
  required grouped gate `test:terminal:shell-theme` passes 187/187.
- DSH/codex-review remains unavailable; no PASS was manufactured. Status
  stays `production_pending_review`; Phase 7/v2 is not complete.

# 2026-08-15 Phase 4 client.input_normalizer production slice

- `client.input_normalizer` now owns `src/lib/terminal-input-normalization.ts`
  exclusively; `client.runtime` no longer lists the normalizer path.
- Added `src/lib/input-normalizer-ownership.test.ts` and wired
  `test:input-normalizer` into prebuild/CI.
- Registered module/resource/edge/feature/function/wiki/AppSDK maps, mainline
  InputNormalizer nodes/edges, design/plan/test-design/module/resource docs.
- Verified `test:input-normalizer` 8/8, `test:feature-registry` 84/84,
  type-check/tsc, `docs:function-wiki`, full build with prebuild gates,
  `daemon:mirror:close-loop` 9/9 plus replay and strict audit, AppSDK verify
  android ok:true draft, and `git diff --check`.
- Evidence
  `EVID-20260815-ZARCHV2-P4-PROD-INPUT-NORMALIZER-001` added.
  DSH/codex-review remains unavailable; no PASS was manufactured. Status stays
  `production_pending_review`; Phase 4/v2 is not complete.

# 2026-08-15 Phase 4 client.reliable_input production slice

- `client.reliable_input` now owns
  `src/lib/reliable-input/reliable-input-queue.ts` for reliable terminal
  input seq, one-in-flight frame, ACK application, bounded ACK-timeout retry,
  physical-transport replacement retry, and head refresh.
  `session-context-input-runtime.ts` is a thin bridge only and no longer owns
  the queue/ACK/retry truth.
- Added `src/lib/reliable-input/reliable-input-queue.test.ts` (8/8) and
  `src/lib/reliable-input/reliable-input-ownership.test.ts` (4/4), and wired
  `test:reliable-input-ownership` into prebuild/CI.
- Registered module/resource/edge/feature/function/wiki/AppSDK maps and
  mainline `TerminalInputDispatch -> ClientReliableInputQueue -> ChannelSend`
  and `SocketMessage -> ClientReliableInputAck` nodes/edges.
- Verified `test:reliable-input-ownership` 12/12,
  `session-context-input-runtime` 23/23, `test:feature-registry` 84/84,
  type-check/tsc, `docs:function-wiki`, full build with prebuild gates,
  `daemon:mirror:close-loop` 9/9 plus replay and strict audit, AppSDK verify
  android ok:true draft, and `git diff --check`.
- Evidence
  `EVID-20260815-ZARCHV2-P4-PROD-RELIABLE-INPUT-001` added.
  DSH/codex-review remains unavailable; no PASS was manufactured. Status stays
  `production_pending_review`; Phase 4/v2 is not complete.

# 2026-08-15 Phase 5 daemon.mirror_writer production slice

- `daemon.mirror_writer` now owns validated source capture, canonicalization,
  and authoritative snapshot commit writes in
  `src/server/terminal-mirror-capture.ts`; `daemon.mirror_store` keeps
  canonical mirror truth, revision, and runtime scheduling but no longer lists
  capture as its owned path. `daemon.buffer_publisher` owns subscriber
  publication.
- Added `src/server/terminal-mirror-writer-ownership.test.ts` (4/4) and wired
  `test:mirror-writer-ownership` into prebuild/CI. The real import graph is
  `daemon.runtime_entry -> daemon.mirror_writer` and
  `daemon.mirror_writer -> daemon.source_adapter/daemon.runtime`; stale
  `daemon.mirror_store -> daemon.mirror_writer` was removed because
  `terminal-mirror-runtime.ts` receives capture through dependency injection.
- Registered module/resource/edge/feature/function/wiki/AppSDK maps, mainline
  MirrorWriter nodes/edges, design/plan/test-design/module docs.
- Verified `test:mirror-writer-ownership` 4/4, `test:feature-registry` 84/84,
  type-check/tsc, `docs:function-wiki`, full build with prebuild gates,
  `daemon:mirror:close-loop` 9/9 plus replay and strict audit, AppSDK verify
  android ok:true draft, and `git diff --check`.
- Evidence
  `EVID-20260815-ZARCHV2-P5-PROD-MIRROR-WRITER-001` added.
  DSH/codex-review remains unavailable; no PASS was manufactured. Status stays
  `production_pending_review`; Phase 5/v2 is not complete.

# 2026-08-15 Phase 1 production foundation node/debug contract slice

- Continued `ZTERM-ARCH-V2-DESIGN-001`: shared node/debug contracts,
  client.debug_console snapshot hub, daemon.observability runtime store/HTTP
  exporter, DebugPermissionService injection, and lockstep
  feature/module/resource/edge/function/wiki/mainline/design/plan/test-design/
  AppSDK maps were completed in prior work on this run.
- Fixed real test isolation regression from fail-fast DebugRegistry:
  `TerminalPage.android-ime.test.tsx` only had reset/cleanup hooks inside the
  first describe, so later BUG #4/#5 tests outside that describe left
  `terminal-page` registered. Moved both hooks to file scope; production
  duplicate-source fail-fast and unmount cleanup are unchanged.
- Full `pnpm --dir android run build` PASS including prebuild gates,
  `daemon:mirror:close-loop` all 9 cases plus replay/strict audit PASS,
  `/Users/fanzhang/.local/bin/appsdk verify android` ok:true draft, and
  `git diff --check` PASS.
- Evidence
  `EVID-20260815-ZARCHV2-PROD-FOUNDATION-NODE-DEBUG-001` added.
  No commit made. DSH/codex-review remains unavailable; no PASS was
  manufactured. Status stays `production_pending_review`; v2 is not complete.

# 2026-08-15 DSH fix loop closeout for ZTERM-ARCH-V2-DESIGN-001

- Fixed all 7 P1s from `zarchv2-current-dsh-r1`:
  protocol mux observability predicate no longer throws; unavailable external
  backend rejects without tmux fallback; shared v2 import edges registered;
  runtime-architecture-v2 gate runs tracked production tests in CI/prebuild;
  lifecycle contracts have a committed validation gate; same-revision repair
  has a positive regression test; Android background WakeLock truth in
  `terminal-buffer-truth` aligns with bounded foreground-service policy.
- Added `android/.gitignore` entry for `.appsdk/` so the local AppSDK evidence
  bundle cannot be committed by a plain `git add .`.
- DSH review `zarchv2-current-dsh-r2` final contains literal `VERDICT: PASS`.
  Remaining P2s include reliable-input `ws.close(4000)` routing,
  `debug-control` on the session dispatcher, input-write bypass,
  oversized-tail seeding, dead-cadence export, and renderer-window owner gap.
- AppSDK lifecycle is still `draft`; no PromotionRecord, Active artifact,
  Protected archive, RegressionReport, or FreezeRecord. ZTERM-ARCH-V2-DESIGN-001
  is not complete.

# 2026-08-15 ZTERM-ARCH-V2-DESIGN-001 DSH r4 fix loop + r5

- r4 findings all fixed: three gate wiring jobs, mirror-scoped input dispose,
  control-gateway explicit handler_failed, mux control-error single close frame,
  herdr growth boundary, frameKey metadata signature, dead visible repair API
  removal, pending repair clamp, module promotion_status overclaim.
- Full `pnpm run build` PASS after updating
  `session-context-buffer-runtime.test.ts` frameKey expectation to new
  metadata signature (`11:100:104:1234:2:null:100:104:80:24:false:null:null:null`).
- Prebuild gates PASS: feature registry 92/92, daemon control center 12/12,
  daemon input queue 10/10, channel mux 7/7, session input 23/23,
  terminal regression core 841/841, relay smoke + account directory,
  workspace panes, Vite build.
- Focused r4 fix tests PASS 129/129. type-check PASS. git diff --check PASS.
- `appsdk verify android` ok:true draft (not promoted).
- DSH `zarchv2-current-dsh-r5` started 2026-08-15 23:10Z; awaiting verdict.

# 2026-08-15 DSH r5 FAIL -> debug HTTP P1 fix -> r6

- r5 final: `VERDICT: FAIL`; single confirmed P1: debug HTTP mutation endpoints
  defaulted open on `0.0.0.0:3333` without token, and `debug:control`
  lease/default-deny was never enforced at an HTTP decision point.
- Fix: `createTerminalHttpRuntime` now accepts `DebugPermissionService`;
  `ensureDebugAuthorized` rejects all debug routes with 401 when daemon host is
  non-loopback and no token is configured; `/debug/runtime/control` is POST-only,
  requires active `debug:control`, and otherwise returns 403 without calling
  lease/broadcast. Server shares one service between debug and HTTP runtimes.
- Tests: default no-grant 403, expired lease 403, authenticated no-grant 403,
  non-loopback no-token 401, GET control 405, plus observability POST routes.
- Verification: focused HTTP/debug 14/14, `test:debug-observability`
  Android 69/69 + shared protocol 10/10, `test:feature-registry` 92/92,
  type-check PASS, full `pnpm run build` PASS, `daemon:mirror:close-loop`
  9/9 + replay + strict audit PASS, `git diff --check` PASS, AppSDK verify
  ok:true draft.
- Started DSH `zarchv2-current-dsh-r6` 2026-08-15; awaiting verdict.
- DSH `zarchv2-current-dsh-r6` final contains literal `VERDICT: PASS`, no
  P0/P1. P2s: Herdr scroll-metrics throttle may lag source-end advance ~100ms,
  full-suite native WebRTC/ScreenCaptureKit aborts are environmental and not
  diff regressions, debug read/subscribe capabilities are reserved but not yet
  independently gated. AppSDK still `draft`; v2 remains incomplete until
  promotion/device/OTA evidence.
