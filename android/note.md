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
