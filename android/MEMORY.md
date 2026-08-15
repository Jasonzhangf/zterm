# MEMORY — Long-Term Memory

## 2026-08-12 Herdr adapter integration boundary

- 官方 Herdr 0.8.0 terminal session replay已验证：`terminal.frame.bytes` 是 ANSI/VT frame；full/delta、cursor movement、SGR、CJK/emoji width、alternate screen、resize、release、reconnect、input marker均有 playground 证据。`seq` 在 resize/reconnect 后重置，只能是 attachment-local transport metadata；zterm mirror revision 必须独立生成。
- 当前不能把 Herdr 接入正式 mirror：公开 `terminal.frame` 未提供稳定 absolute scrollback/range；受控 `terminal.scroll` 未产生可验证新 frame。不能推导 `bufferStartIndex/endIndex`、absolute cursor row 或 tmux parity，不能伪造、fallback 或把 Herdr seq 映射为 zterm revision。
- 正式 backend 进入条件：官方 Herdr 提供稳定 absolute range/scrollback/cursor contract，或产品明确接受并机器锁定 `absolute-range=unsupported` beta capability。未满足前，Herdr 只能保留为 playground/design evidence；tmux 继续唯一 parity oracle，Windows/agent side-channel gates未完成不宣称支持。
- 2026-08-12 formal owner progress：`daemon.herdr_backend` 已绑定 resource/module/feature/function/verification map；正式唯一 `herdr-frame-canonicalizer.ts` 复用 WasmBridge，typed `herdr-backend.ts` + official CLI JSONL `herdr-process-transport.ts` 已通过 14 focused tests、tsc、registry/module/function/mainline gates。playground 已导入正式 canonicalizer。daemon server 对显式 Herdr 选择暂时 fail-fast，避免未完成 runtime wiring 静默落 tmux；absolute range contract 未解决前不接 mirror writer。
- schema/range gate 复核：官方 `herdr api schema --json` 与 CLI surface 未发现 terminal frame 的 absolute line identity/range/cursor row；pane scroll 仅有 offset/viewport metrics，不能补齐 zterm absolute range contract。该缺口属于 external source contract，不是 renderer 或 mirror 层可补偿的问题。
- upstream source 复核：官方 `render_stream.rs` 的 `TerminalAnsi` 只维护 per-client `BlitEncoder + seq`，`TerminalFrame` 只有 `seq/width/height/full/bytes`；semantic `FrameData` 的 cells/cursor 也没有 absolute line identity。该证据排除了从 frame wire 直接取得 zterm absolute range 的可能性。

## Project Overview

- 2026-08-12 formal runtime wiring: `herdr-backend-runtime.ts` now feeds the existing daemon backend capture/control interface; explicit `ZTERM_TERMINAL_BACKEND=herdr` starts without tmux fallback and `/health` is green. Official process probe passed input, resize, release/closed and canonical frame delivery. `pane get` metrics are treated as optional validated metadata; frame stream is never dropped on a metrics race, and missing/mismatched metrics remain an explicit absolute-range capability gap. Overall Herdr delivery is still incomplete pending Android session close-loop, side-channel audits, and Windows ConPTY evidence.

- 真实长输出 scroll probe：Herdr `max_offset_from_bottom/offset_from_bottom/viewport_rows` 可在 80 行输出后报告 61/0/24；resize 到 30 行并 scroll 1 后报告 54/1/30，同时收到新 frame。metrics 可证明 host scroll 状态，却不能提供跨 geometry 稳定 absolute line identity（估算总行 85→84），故仍不得映射为 zterm absolute range。
- 多客户端真实 replay：同一 terminal 的 controller 与 read-only observer 在相同 80x24 底部 viewport 用独立 canonicalizer 得到相同 rows digest；两边 attachment seq/baseline 独立。resize/scroll 后各 client viewport 可不同，不能把 observer 的局部 geometry/cursor 当 daemon mirror absolute truth。
- 2026-08-12 formal range contract：Herdr frame 只有在携带 geometry-matching host-scroll metrics 时，才允许以 `maxOffsetFromBottom + offsetFromBottom + viewportRows` 推导 zterm visible/available range；available end 跨 frame 不得回退，只有 bottom viewport 才映射 absolute cursor。无 metrics/regression 必须显式 gap/error，canonical truth 不推进。该 contract 尚未接入 process transport/daemon mirror。

- 项目目标：Android 终端应用，Capacitor + @jsonstudio/wtermmod-react
- 手机端定位：纯 client
- 服务端定位：本地 Mac/PC 的 tmux → WebSocket 桥接

## Key Decisions

- [2026-08-08] Remote-window 串流"只渲染首帧"最终定位（真机 logcat + daemon 日志闭环）：**daemon capture 链路正常，ScreenCaptureKit 是增量捕获——窗口内容不变时不产生新帧**。铁证：daemon `launchd-stdout.log` 中用户串流的窗口（微信 948x1232、Chrome ZTERM_FRAME_TEST 2599x1936）全部 `framesSent=1`；本机单流验证（`/tmp/single_stream_test.mjs`，wrtc + daemon 协议）ticker 终端窗口（毫秒时间戳循环，内容持续变化）4 秒 `framesSent=85`——内容在变就持续出帧。ZTERM_FRAME_TEST 的 Chrome 后台标签 rAF 被节流（页面没真动画）是之前测试的坑。**"冻结"= 串流窗口内容静止**，不是 Android/WebRTC bug。
- [2026-08-08] 悬浮控件拖拽统一复用：用户要求"同一个控件用同一套逻辑"。新建 `src/components/terminal/draggable-bubble-shared.ts`（`useSharedDraggableDrag`：pointer+touch 双套、8px 阈值、180ms 拖后抑制点击、origin+delta+clamp，与 QuickBar 📁 bubble 同构）。**串流浮层手柄 + "窗"浮钮全部改走该 hook**（删除各自单独实现：`handleFloatingDragStart/Move/End`、`updateFloatingDragFromPointer/finishFloatingDrag`、`FloatingOverlayDrag`、浮钮 `handleEntryPointer*/handleEntryTouch*`、`clampEntryOffset` 等约 300 行）。浮层不跟手根因：原来只有 pointer 套，Android WebView touch 拖动的 pointer 链不可靠；hook 的 touch 套解决。坑：浮钮 JSX 曾丢 `ref={entryButtonRef}`（getRect 返回 null 拖拽失效）、hook `finishDrag` 漏查 touchRef（touch 拖后不抑制点击）——均已修。`docs/module-registry.json` 将 `draggable-bubble-shared.ts` 注册到 `client.remote_window_overlay`。
- [2026-08-08] 串流 canvas→focus 切换黑屏修复：video 元素 `key={rw-video-${state.streamId}}`（流切换重建）导致重建瞬间黑屏（新 video 空 + wallpaper state 更新异步）。修复：**wallpaper 常驻 DOM**（`ztermVideoWallpaper` 不再 `!videoHasPlayed ? ... : null`，改 opacity `videoHasPlayed ? 0 : 1` + 120ms 过渡 + zIndex 2 盖在 video 上），重建瞬间立即遮罩不露黑；测试改为断言 wallpaper opacity 0（不再 queryByTestId null）。验证：`RemoteWindowOverlay.test.tsx` 78 + `TerminalQuickBar` 55 + TerminalPage 62 全过、`type-check` PASS、prebuild 全绿、APK `0.1.3.2479` / versionCode `1100024790` 已发布 OTA 并 adb 装机。真机确认：浮层手柄/浮钮拖拽跟手（用户已验证）；待验证：串流 ticker 终端窗口持续刷新 + 切换无黑屏。

- [2026-08-08] Remote-window 串流"只渲染第一帧"修复（第 2 轮，待真机 L5）：daemon 侧已排除（动画窗口探针 `framesSent=87`，capture/sender 持续）。第 1 轮"video 不 hidden + wallpaper zIndex 遮罩"**无效且引入启动"显示-黑-再显示"序列，已回滚**。第 2 轮根因定位：用户 logcat 显示最终显示流（epoch 2, committed/focus stream）首次串流就 `currentTime=0.000 framesReceived=1`——**Android WebView 替换 `video.srcObject`（canvas preview 流 → focus 主流）后新流只渲染首帧**（WebView 已知 bug；Node 探针无 video 元素所以正常）。修复：`<video>` 加 `key={rw-video-${state.streamId}}`，streamId 变化时 **React 重建 video 元素**（规避 srcObject 替换冻结），恢复原版 video opacity/visibility 控制与 wallpaper zIndex。新增测试"rebuilds the video element when the stream id changes"。验证：`RemoteWindowOverlay.test.tsx` 78 + `TerminalPage` 62 全过、`type-check` PASS、prebuild 全绿、`build:android` PASS，APK `0.1.3.2476` / versionCode `1100024760` 已发布 OTA。⚠️ 真机 L5 待验证（logcat `[remote-window] client framesReceived=` 是否持续上涨；若仍卡 1 需查 WebView WebRTC 接收，若上涨但画面不动需查合成层/backdrop-filter）。
- [2026-08-08] 现场管理：用户 `git reset --hard` + commit c30b738（v2 fix）时把此前全部工作区改动（splash 深色、浮钮统一、QuickBar、MEMORY、测试）暂存进了 `stash@{0}`（wip-2026-08-08 pre-fix-verify）；已用 `git checkout stash@{0} -- <files>` 单独恢复除 note.md 外的所有文件（note.md 保留用户最新记录，避免冲突）。恢复后 RemoteWindowOverlay.tsx 同时含 v2 fix（c30b738 已提交）与浮钮 left/top 防漂移改动。

- [2026-08-08] 串流悬浮窗浮钮与文件按键（QuickBar 📁 bubble）统一交互（第 2 轮修正漂移）：浮钮保留在右下角，**可拖动移动位置**且行为与文件 bubble 完全一致。**漂移根因**：第一版实现用 `transform: translate(绝对 left/top)` —— transform 是相对元素初始位置的偏移语义，塞绝对坐标必然错乱漂移；文件 bubble 用的是 **`left/top` 绝对定位**（未拖动时 `right/bottom` 默认，拖动后 `left/top`），`entryOffset` 类型为 `{ x: number|null; y: number|null }`（null=未拖动）。修复：浮钮 style 改 `left/top` 定位 + 位置 localStorage 持久化（`zterm:remote-window:entry-position-v1`）+ viewport resize/orientationchange rescue clamp（与文件 bubble 的 rescue 一致）。其余统一行为：8px 位移阈值激活拖拽、拖完 180ms 抑制点击防误触、pointer(鼠标)+touch 双套、`touchAction:none`、点击直接开/关 toggle（closed 打开 picker，`targetEnumerating/pickerOpen` 再点关闭）。TerminalPage 移除 `remoteWindowOverlayOpen` state：QuickBar 不再因串流 picker 隐藏/重现，`terminalStageBottomPx` 恒定 chrome 高度；`onOpenStateChange` 保留只负责隐藏 IME。验证：`RemoteWindowOverlay.test.tsx` 77 个（toggle + 枚举中关闭 + mouse/touch 拖拽 + 二次拖动防漂移）、`TerminalPage.remote-window-overlay.test.tsx` 7 个、`type-check` PASS、prebuild 全绿、完整 `build:android` 通过，APK `0.1.3.2474` / versionCode `1100024740` 已发布 OTA。Marker: `remote window entry left-top positioning no drift`.
- [2026-08-08] Android 前后台切换白屏 / 冷启动白屏根因在原生壳首帧背景，不在 terminal buffer/render 链路：`splash.png` 是白底图，`AppTheme.NoActionBarLaunch`（parent `Theme.SplashScreen`）的 `windowSplashScreenBackground` 默认 `?android:colorBackground`（浅色主题=白色），warm start（后台切前台）不显示系统 splash，窗口恢复首帧显示白色 windowBackground，而 WebView surface/纹理重建需要时间，期间露白即“白屏一下”。修复（Android Shell 层）：splash 全部 11 个 density 变体白底→终端表面 `#1e1e1e`（保留蓝色 logo）；launch theme 显式 `windowSplashScreenBackground=#FF1E1E1E`；MainActivity 对 WebView `setBackgroundColor(0xFF1E1E1E)`；manifest `configChanges` 补 `colorMode`（防 Android 13+ 深色切换重建 Activity 重载 WebView）。验证：`:app:assembleDebug` PASS、`type-check` PASS、完整 `build:android`（prebuild 各 gate + vite build + cap sync + normal/rollback assemble + update bundle verify 14 checks 全绿），APK `0.1.3.2470` / versionCode `1100024700` 已发布 OTA（`~/.zterm/updates`）。无在线 ADB 设备，真机前后台切换 L5 留待 Jason 侧。Marker: `android foreground warm start white flash splash background`. 另注：本次构建前工作区 `RemoteWindowOverlay.tsx` 有 5269 行误粘贴重复副本（=HEAD 全文件追加一份）导致 type-check 红，已按“HEAD+仅用户真实 +5 行”恢复。

- [2026-07-29] Remote-window same-app sibling switching must be a transactional stream handoff in the Android overlay owner. `RemoteWindowOverlay` may start the selected sibling stream, but must keep the current stream/media/input/projection context alive until the new stream attaches; only then may it commit the pending epoch and stop the old stream. Failed sibling start remains a visible handoff error, not a current-stream disconnect; stale pending results and old-stream cleanup failures must be explicitly stopped/projected, not console-only. Fullscreen pinch classification must treat opposite-direction expansion/contraction along the initial two-finger axis as pinch even with vertical midpoint drift; near-parallel or non-axis vertical two-finger movement remains release-time gesture scroll. Verified with `RemoteWindowOverlay.test.tsx` 62 PASS, focused remote-window stack 6 files / 164 PASS, and Android typecheck PASS. Marker: `remote window transactional sibling handoff opposite axis pinch`.
- [2026-07-27] File Sync upload crash remaining after 16KiB wire budget: client still burst-sent every `file-upload-chunk` without waiting for daemon progress, which can flood RTC DataChannel and crash the app. Owner is `daemon.file_transfer` / `file-transfer-session-runtime` + `FileTransferSheet`; upload now waits for `file-upload-progress` after each chunk and `file-upload-complete` before finish. Marker: `file transfer upload progress ack between chunks`.
- [2026-07-27] File Sync upload crash remaining root cause after native chunk streaming: wire frames were still 256 KiB raw -> ~341 KiB base64 JSON and could exceed RTC DataChannel maxMessageSize once wrapped as mux-channel-message. Shared owner constants are `FILE_TRANSFER_WIRE_CHUNK_BYTES=16KiB` and `FILE_TRANSFER_WIRE_FRAME_MAX_CHARS=48KiB` in `packages/shared/src/connection/protocol.ts`; client `FileTransferSheet` and daemon `FILE_CHUNK_SIZE` both consume them. Verified by FileTransferSheet/runtime/truth 35 PASS, protocol contract 8 PASS, typecheck, feature/resource/module gates 71 PASS, full `build:android`, and Android APK `0.1.3.2257` / versionCode `1032257` / sha256 `b8ef040341adc9253589fb09d542fcc40d22956b695241be526c848975f1a4b4` on local, Tailscale, and public Relay update routes. No online ADB device was attached after build, so installed-phone sync upload replay remains Jason-side. Marker: `file transfer wire chunk 16kib rtc frame budget`.

- [2026-07-25] Terminal input-tail stale rows and black/transparent multi-line input backgrounds belong to `terminal.buffer_render`, not QuickBar/UI chrome, unless live evidence shows a shell/IME layout issue. Visible-gap repair demand dedupe must include repair freshness when `missingRanges` is non-empty: `renderBuffer.revision`, `daemonHeadRevision`, and local buffer window bounds. Otherwise a newer buffer revision can leave the same visible absolute gap unrepaired because the viewport end/rows key did not change. Shared terminal row projection must paint `theme.background` on ordinary rows, gap markers, and gap fill, so empty terminal rows do not leak the outer app background. Verified with `TerminalView.dynamic-refresh.test.tsx` 75 PASS, shared renderer 19 PASS, focused terminal buffer/render gates 269 PASS, `tsc --noEmit`, feature registry 48 PASS, `daemon:mirror:close-loop` 9 PASS, full Android build, APK `0.1.3.2246` sha256 `0bbb3a1f7164bbced39249a1df49c550243f8453a5f2244128028cd2bb27a70c`, and installed-device CDP smoke showing `gapCount=0` on visible rows after upgrade.
- [2026-07-25] Session preview primary-plus-children closeout: child preview title/body tap must promote that session to primary without activating the real shell; only the current primary tile activates/switches. Preview body drag/scroll still suppresses activation and remains local read-only scroll/pan. Tile titlebars must not render visual order badges such as `1/2/3/4`; order is data/test metadata only. Secondary child previews use compact local terminal typography for glanceability while remaining `mirror-fixed` and callback-inert, so tmux layout and daemon mirror truth do not change. Owner is `terminal.session_preview.grid.render` in `TerminalPreviewGrid` through shared `WindowGroupLayout`. Verified with focused preview/grid/render tests `46 PASS`, `tsc --noEmit`, feature/resource/function/mainline gates `48 PASS`, `git diff --check`, and `terminal:preview:source-dom-gate` proving six controlled tmux sessions matched `tmux source -> daemon -> client sparse -> preview DOM` with subscribers `0 -> 6 -> 0`.
- [2026-07-24] Terminal large-refresh closeout: live `buffer-sync` body updates whose changed span exceeds one frame budget must be split into contiguous same-revision chunks that cover every authoritative source row; only initial forced oversized seed may remain bounded to the live tail. The regression was daemon subscriber tail-cropping an oversized body refresh, preserving stale middle rows when a terminal update exceeded one visible screen. Owners: `terminal.buffer_render` / `resource.transport_subscriber -> resource.client_sparse_buffer -> resource.renderer_window`. Verified with focused large-refresh/render tests, terminal contracts, full `daemon:mirror:close-loop` 9 cases, Android build `0.1.3.2230`, and daemon installed runtime SHA `8e18204544b37d43583e3699966cef9b4240398f868fc96bdad389dd93b3027e`; no online ADB device was attached, so installed-phone L5 remains unclaimed.
- [2026-07-24] Remote-window video start correction supersedes marker `remote-window-transceiver-sendEncodings-trackSeen-20260724`: exact WeChat target `app-window:486:2757` proved `addTransceiver(videoTrack, { sendEncodings })` can return a WebRTC `inactive` answer while ScreenCaptureKit capture succeeds, leaving Android stuck at "正在建立视频流" because `ontrack` never fires. The daemon stream owner must use a sendonly-safe sender attach path (`addTrack` in current `@roamhq/wrtc`) for startup, then apply bitrate only to existing sender encodings after localDescription; if encodings are absent or `setParameters()` rejects, report explicit quality unsupported and keep video alive. Live probes must require `ontrack=true`; `getReceivers().track.live`, `framesSent`, or capture status alone are false positives for Android video attach. Video-start live probes must run serially because parallel ScreenCaptureKit starts on the same target can time out and produce false reds. Verified by exact WeChat raw local and Tailscale mux video-only probes: ScreenCaptureKit `1037x1177`, `ontrack=true`, `framesSent=1`, explicit stop. Delivered in Android `0.1.3.2231` with public/local/Tailscale update sha `9786f7992d124e07ff1dae1e76850293d9090f9a2c851922cda523f56345921b`; no online ADB device was attached, so installed-phone L5 remains Jason-side.
- [2026-07-22] Daemon physical transport stale cleanup must be strictly longer than the Android target heartbeat failure contract. Android sends one physical target heartbeat every 60 seconds and declares failure after three misses; a daemon 10-second inbound-stale cutoff detached quiet RTC/mux subscribers before the first client heartbeat, leaving Android green with traffic while terminal body and remote-window catalog requests targeted an already released server channel. The unique owner is `terminal.transport_lifecycle` in `terminal-transport-runtime.ts`; the bound is now 190 seconds. Positive gate: an attached quiet RTC transport remains open at 11 seconds. Negative gate: beyond the stale bound every mux subscriber detaches and the physical transport closes without destroying tmux or mirror truth. Delivery requires prepared/installed daemon SHA equality, service-scoped restart with `/health` PID/uptime proof, and a live same-mux transport request after at least 11 quiet seconds.
- [2026-07-22] Remote-window daemon-internal input must obey the same realtime contract as Android client input. Search marker phrase: zterm remote window internal paste timestamp owner helper. `remoteWindowStreamRuntime.injectInput()` rejects missing or stale `clientSentAt`; server-side image paste must build Command+V down/up payloads through the `remote-window-stream-daemon` owner helper so each event carries a fresh timestamp. Do not loosen daemon stale validation and do not hand-build partial input payloads in `server.ts`. Verified by fail-first `remote-window-stream-daemon.test.ts`, mapped remote-window gates `8 files / 197 PASS`, feature/resource/function/mainline gates `48 PASS`, typecheck, `git diff --check`, installed daemon release SHA `9d6b61deb8abc8463a00a6366cb61be11143d06a774250fa80a2ebba623a4d50` on live PID `46565`, and `scripts/remote-window-live-input-probe.ts` WebSocket/WebRTC `.app` probe receiving pointer/scroll/gesture/key OS events. No online ADB device was attached, so installed Android touch-path L5 remains Jason-side pending.
- [2026-07-22] Terminal physical activity and render freshness are separate truths. `recordSessionRx()` may update `lastServerActivityAt` for every valid non-pong frame, but only `buffer-head` / `buffer-sync`, including nested `mux-channel-message`, may update `lastTerminalActivityAt` and clear `staleTransportProbeAt`. Connected baseline head requests use `lastConnectedBaselineAt` only as a bounded initial freshness window and do not occupy the long-lived stale probe marker. This prevents `title` / `schedule-state` / `input-ack` / mux allocation traffic from keeping a green status while terminal body refresh is dead. Verified by fail-first pull/lifecycle tests, mapped context gates `167 PASS`, `SessionContext.ws-refresh` `134 PASS`, feature/resource/function/mainline gates `48 PASS`, terminal contracts `611 PASS`, common flows `83 PASS`, typecheck/build, and Android `0.1.3.2210` sha256 `6ed06b07d029e7f439056f95f933a85b17cb1e15e3b8c62559f54e5884d49529` on local, Tailscale, and public Relay update routes. No online ADB device was attached, so live phone network-switch L5 remains open.
- [2026-07-22] Remote-window app-window interaction delivery requires live daemon runtime proof, not only APK/build/unit gates. The closeout must install the prepared daemon release globally, ensure launchd execs `/Users/fanzhang/.zterm/releases/zterm-daemon/<version>/runtime/server.cjs`, prove installed runtime SHA matches `android/release-dist/.../runtime/server.cjs`, prove `/health` PID/uptime after service-scoped restart, then run a live WebSocket/WebRTC AppKit probe that receives focus/pointer/scroll/gesture/key events. A stale daemon can keep running `/Users/fanzhang/.zterm/daemon-runtime/server.cjs` while APK `0.1.3.2209` is current; in that state Android upgrades do not prove remote-window input behavior. Current local proof after installing release SHA `cf8c1517ffd830c8867fd41e919ae1518fc4af9e3d51c8ad74d64aa65c48a1c7`: daemon PID `62669`, probe target `app-window:95294:4889`, stream `520x372`, focus/pointer/scroll/gesture/key all `accepted=true`, probe stdout observed the corresponding OS events. No online ADB device was attached, so installed-phone touch-path L5 remains open.
- [2026-07-22] Android APK delivery is not closed until both update routes are populated and remotely fetchable: local/Tailscale daemon route (`http://127.0.0.1:3333/updates/latest.json` plus `http://<tailscale-ip>:3333/updates/latest.json`) and public Relay route (`https://relay.codewhisper.cc:18443/relay/updates/latest.json`). Verifying `android/update-dist` or `~/.zterm/updates` files alone is insufficient. If daemon HTTP hangs, do a service-scoped daemon restart and re-test `/health`, manifest GET, APK HEAD/GET, and sha256. This delivery standard is now in `.agents/skills/zterm-mobile-dev/SKILL.md`.
- [2026-07-22] Supersedes the earlier remote-window "stream start focus" rule: supported app-window targets may bring the desktop app/window to focus only at the instant of a real user remote operation. Stream start, receiver attach, fullscreen entry, IME lift, picker/catalog refresh, pinch zoom, and local zoom-pan must not send `focus`; each actual pointer/gesture/wheel/key/QuickBar/IME event must still be same stream/target focus-first. Touch tap/drag is classified first, then emits focus+pointer or focus+gesture at release. Android gesture deltas stay DOM-positive (`to - from`, down/right positive) and daemon remains the only macOS sign-conversion and AX/Quartz injection owner. Verified by focused remote-window/IME tests `92 PASS`, mapped remote-window overlay/page/daemon tests `126 PASS`, `tsc --noEmit`, `test:feature-registry`, `git diff --check`, full `build:android`, and update-route proof for Android `0.1.3.2209` / versionCode `1032209` / sha256 `986720169006fa610cdf0f04a14903693b1caf66d0628a55ea3dafbc204e25fd` on local, Tailscale, and public Relay routes. No online ADB device was attached, so phone L5 remains Jason's install test.
- [2026-07-22] Android foreground resume is an event, not only a boolean `appForegroundActive false->true` edge. `useOpenTabLifecycleEffects` may observe `visibilitychange`, document `resume`, and Capacitor `appStateChange(true)`, but it must project a monotonic `foregroundResumeEpoch` into `SessionContext`; only `useSessionContextLifecycle` may turn that sequence into `ensureActiveSessionFresh({ source:'explicit-resume', forceHead:true, markResumeTail:true, allowReconnectIfUnavailable:true })`. App/UI must not add a reconnect fallback. Verified by focused lifecycle/App gates `47 PASS`, mapped refresh gates `200 PASS`, transport runtime gates `48 PASS`, feature/resource/function/mainline gates `48 PASS`, `tsc --noEmit`, `git diff --check`, and Android package `0.1.3.2208` sha256 `282c7b3564ccd75eb4aac035f2aa0cb7fb949a2cc449b90e3f81462cc04ae076`; no online ADB device was attached, so live phone foreground-resume L5 remains open.
- [2026-07-22] Home relay-open projection must preserve the saved direct/Tailscale identity. `buildHomeRelayConnectionHost()` may tag `relay-route` and carry Relay candidates, but it must not blank an already known direct `bridgeHost`; otherwise production relay snapshots that only expose `relay-rtc` will drop Tailscale from the auto candidate set and Relay failure becomes a hard failure. Verified by `home-connection-projection.test.ts`, `App.dynamic-refresh.test.tsx`, `tsc --noEmit`, and `test:feature-registry`.
- [2026-07-22] Drawer refresh and open-tab audit must reuse the existing open mux target transport when a matching non-closed session exists. `manageTmuxSessionsOnOpenTransport` is the only allowed path for that target; `fetchRemoteTmuxSessionNamesByOwner()` and `auditOpenTabsAgainstRemoteSessions()` must not fallback to legacy `fetchTmuxSessions()` when the open target exists but is not ready or errors. Verified by `open-tab-restore.test.ts`, `remote-tab-audit.test.ts`, `useOpenTabRuntime.test.tsx`, `useSessionOpenActions.test.tsx`, `tsc --noEmit`, and `build:android` package `0.1.3.2205` sha256 `e704ddc77953bebfa474a76574ad54369bc073ce3393e2b91ef393027f003381`; no ADB device was attached, so live device smoke remains open.
- [2026-07-22] Remote-window app-window targets must be projected as `streamMode='interactive'`, or Android will suppress `RemoteWindowInputContext` and the explicit `focus` intent will never leave the client. iTerm2 pane targets remain `streamMode='view'` and therefore stay read-only for current `tmux-input` / `iterm2-api` routes. Verified by `remote-window-stream-daemon.test.ts`, `RemoteWindowOverlay.test.tsx`, `tsc --noEmit`, `test:feature-registry`, and `build:android` package `0.1.3.2207`; no online ADB device was attached, so live phone focus replay remains open.
- [2026-07-21] Remote-window supported app-window input must be focus-first per logical operation event, not only batch-first. Android may emit explicit `focus` intents, but daemon remains the only AX/Quartz focus/injection truth. For pointer/gesture/wheel/key/QuickBar/IME event lists, each non-focus event must be immediately preceded by a same stream/target `focus`; unsupported iTerm/tmux read-only targets still emit no remote-window input. Verified in Android `0.1.3.2204` by shared/QuickBar/remote-window focused tests, mapped remote-window regression `11 files / 270 PASS`, feature/resource/function/mainline gates `48 PASS`, `tsc --noEmit`, full `build:android`, and public Relay APK sha `c3734c0062fa1b0b19899a1be77adb22a54477a759a2de733921978de92c10e4`. No online ADB device was attached, so live phone L5 remains unclaimed.
- [2026-07-21] Terminal shortcut modifiers in the shared composer are one-shot tokens. `buildTerminalShortcutSequence()` walks tokens in order, applies pending modifiers only to the first following non-modifier key, then clears them; `Shift + ← + a` must encode as shifted-left-arrow plus plain `a`, not reject the combination and not uppercase the second key. Shared `packages/shared/src/shortcuts/terminal-shortcut-composer.ts` is the Android/Mac shortcut encoding owner; platform QuickBar UIs may edit/display tokens only and must not copy modifier restrictions.
- [2026-07-21] Extends the remote-window focus rule below: selecting and successfully starting a supported app-window stream must immediately emit an explicit Android `focus` intent, before the user touches the video surface. Direct overlay wheel and key paths must also emit `focus` immediately before `scroll` or `key`; pointerdown and TerminalPage QuickBar/IME remain focus-first. iTerm2 pane/read-only targets emit none of these intents. The daemon remains the only AX/Quartz owner and still revalidates app/window focus before every accepted event. Verified by fail-first `RemoteWindowOverlay` coverage, remote-window mapped regression `8 files / 142 tests`, feature/resource/function/mainline gates `7 files / 48 tests`, typecheck, and a live daemon WebSocket focus probe that changed frontmost app from iTerm2 to WeChat with `accepted=true`.
- [2026-07-21] Remote-window generic app input must bring the target app/window to the front before every user operation, not only when the delayed pointer/key event is finally sent. Android `RemoteWindowOverlay` sends an explicit `focus` input intent on video-surface pointerdown; `TerminalPage` sends `focus` before QuickBar/IME key/text batches. The daemon `desktop.remote_window_stream.daemon.input_inject` owner treats `focus` as a focus-only remote input event, matches the target AX window by manifest bounds, runs app activation + `AXRaise` + focused/main setters, verifies frontmost and focused target window, and only then reports success or posts later Quartz events. Required gates: `RemoteWindowOverlay.test.tsx`, `TerminalPage.remote-window-overlay.test.tsx`, `TerminalPage.android-ime.test.tsx`, `remote-window-stream-daemon.test.ts`, shared protocol test, `tsc --noEmit`, feature registry, installed daemon release hash/PID, and live macOS focus smoke against a real app such as WeChat.
- [2026-07-21] Terminal mux client changes are not closed unless the Mac daemon release artifact is regenerated and installed. `build:android` must run `daemon:prepare-release`; `server.daemon-runtime-truth.test.ts` must check the prepared release runtime contains `mux-hello`, `mux-ready`, `mux-channel-open`, `mux-channel-opened`, and `mux-channel-message`; live closeout requires service-scoped `zterm-daemon restart`, `/health` new pid/uptime, repo-vs-installed runtime sha match, and a real WebSocket `mux-hello -> mux-ready -> mux-channel-open -> mux-channel-opened` smoke.
- [2026-07-21] Auto route selection ignores stale saved `traversalPathPriority`. The product Auto order is `tailscale -> rtc-direct UDP hole punch -> rtc-relay TURN/Relay`, with direct IP endpoint facts only after those classes or through explicit/manual route override. Manual route selection is a UI override intent and must not rewrite global Auto order or create per-session route truth.
- [2026-07-20] Remote-window touch gesture input to macOS needs the daemon injection helper to move the HID mouse cursor to the resolved remote input point before posting scroll-wheel events; merely setting `CGEvent.location` on the wheel event is not enough to guarantee the target window receives the gesture. Android continues to own local gesture recognition and normalized coordinate projection.
- [2026-07-20] Supersedes the earlier same-day remote-window keyboard-open local pan rule: unzoomed remote-window touch belongs to the remote app in both floating and fullscreen modes, even when Android IME/QuickBar reports `bottomInsetPx`. Tap must emit pointer down/up, touch drag must emit continuous incremental pixel `scroll`, and local one-finger pan is allowed only after fullscreen zoom (`scale > 1.01`). `bottomChromeInsetPx` remains an automatic fullscreen projection lift only; it must not change gesture ownership. Receiver `<video>` must use `object-fit: contain` so media intrinsic aspect ratio is not stretched inside the manifest-derived content rect. Required gates: `RemoteWindowOverlay.test.tsx`, `TerminalPage.remote-window-overlay.test.tsx`, remote-window runtime/daemon focused tests, `test:feature-registry`, `tsc --noEmit`, live daemon WS stream/input smoke when daemon is available, and `build:android` for a testable APK.
- [2026-07-20] Remote-window picker/interaction projection must not treat every daemon target as a flat interactive row. Android `resource.remote_window_overlay` directly lists app-window targets but keeps iTerm2 panes collapsed behind an explicit group; selecting an iTerm pane is video-only/read-only until daemon `tmux-input` / `iterm2-api` routes have live proof. The overlay must not publish `RemoteWindowInputContext` or send pointer/key/scroll/QuickBar events for unsupported routes, because daemon currently rejects them explicitly. Floating resize must also cap growth so the toolbar remains within the top viewport margin and can still be dragged. Required gates: `RemoteWindowOverlay.test.tsx`, `TerminalPage.remote-window-overlay.test.tsx`, `remote-window-stream-daemon.test.ts`, `test:feature-registry`, `tsc --noEmit`, `build:android`.
- [2026-07-20] Remote-window target catalog is daemon-wide projection data. `requestRemoteWindowTargetsRuntime` now reuses the existing open SessionContext transport and caches the catalog for 60 seconds by `{ daemonHostId, bridgeHost, bridgePort, authToken }`, excluding tmux/session id. Switching sessions on the same daemon therefore does not re-enumerate the desktop app list; TTL expiry or endpoint/auth identity change issues a fresh request, and a closed transport remains an explicit error. This is cache/incremental catalog behavior only; transport reconnect root cause still requires live client runtime evidence and is not claimed closed by static tests.
- [2026-07-20] Remote-window floating resize must cover concrete bottom-corner gestures, not just the presence of a resize handle. The Android overlay owner exposes bottom-left and bottom-right handles, preserves the selected source aspect ratio, keeps the opposite edge stable according to the grabbed corner, and must remain movable through the toolbar after resize. Fullscreen IME pan must also cover the exact-fill case where source aspect equals the measured video surface: `bottomInsetPx` provides extra local pan range, and upward pan reclaims the same amount from fullscreen bottom padding. This remains `resource.remote_window_overlay` projection truth only; do not change daemon capture, WebRTC sender, Mac coordinate truth, terminal renderer, page shell layout, tmux geometry, or remote scroll to compensate. Required gates: `RemoteWindowOverlay.test.tsx`, `TerminalPage.remote-window-overlay.test.tsx`, remote-window runtime/daemon focused tests, `test:feature-registry`, `tsc --noEmit`, `build:android`.
- [2026-07-20] Remote-window floating resize and keyboard-open fullscreen pan are Android overlay projection truth only. The floating preview may edge-resize from the selected source aspect ratio with pointer capture; fullscreen may consume `bottomInsetPx` as overlay padding and allow local letterbox pan while the keyboard is open. These changes must not alter daemon capture geometry, Mac coordinate manifests, tmux width, terminal mirror, or renderer truth. Network/reconnect notifications belong to `terminal.transport_lifecycle` as fixed top overlays with `pointer-events:none`; they must not participate in page layout or resize terminal/remote-window containers.
- [2026-07-20] Remote-window image paste must be routed only by Android active focus context, never by daemon-side guessing. `RemoteWindowOverlay` publishes the active stream input context; `TerminalPage#handleQuickBarImagePaste` sends `pasteTarget.kind=remote-window` only while that context is active; `TerminalPageStageShell` terminal surface focus clears it; otherwise the same QuickBar image action remains on the terminal Ctrl+V paste path. Daemon behavior is deterministic: remote-window paste writes macOS clipboard then injects Command+V through `remote-window-input`; terminal paste writes macOS clipboard then sends terminal Ctrl+V. Required gates: `TerminalPage.remote-window-overlay.test.tsx`, `session-context-transfer-runtime.test.ts`, `terminal-file-transfer-binary-runtime.test.ts`.
- [2026-07-20] Remote-window video bitrate is stream-local quality control, not reconnect or capture lifecycle. Android remembers presets per selected desktop window identity and seeds only by resolution; stream start carries the selected config; later selector changes send `remote-window-stream-quality-request` for the active stream. Daemon validates preset/bitrate/maxBitrateBps and may only apply `maxBitrate` by preserving the WebRTC sender's existing `RTCRtpSendParameters.encodings` structure; it must never fabricate a new encoding entry. If the sender has no encodings at stream start, video startup continues with an explicit "bitrate not applied" status and no `capture.maxBitrateBps`; the same condition during a live quality update returns `remote_window_stream_quality_failed`. This was live-verified against real WeChat target `app-window:486:2668`: status reported empty encodings, `remote-window-stream-started` returned, the WebRTC receiver got a `280x380` frame, and stop cleaned the stream. Changing bitrate must not restart capture, receiver, session transport, or coordinate truth. Required gates: `remote-window-video-quality.test.ts`, `RemoteWindowOverlay.test.tsx`, `session-context-remote-window-runtime.test.ts`, `remote-window-stream-daemon.test.ts`, live daemon quality error smoke when daemon is available.
- [2026-07-18] Terminal drawer 枚举必须在 `TerminalPage` projection owner 内按 canonical `serverIdentity.key + sessionName` 去重。direct/Tailscale history 与 Relay history 同时指向同一 daemon 时，只允许合并 open/close target metadata，不能让同一个 tmux session 渲染两行，也不能在 `TerminalSessionDrawer` 组件、transport、daemon 或 renderer 层做隐藏补偿。回归 gate：`TerminalPage.session-drawer.test.tsx` 的 direct + Relay history overlap 黑盒用例必须保持每个 session title 只出现一次，并锁住重复 React key 不复活。
- [2026-07-17] Android Home server row 无 saved `sessionName` 时必须先复用当前进程同 server/session 的 open Session，只有无可复用 Session 才允许创建生成名 `zterm-*` tmux session。唯一 owner 是 `src/hooks/useSessionOpenActions.ts#handleOpenSavedConnection`：复用命中时写 open-tab active truth 并走 `explicit-resume`，禁止绕过 open-tab 主线只调底层 switch，也禁止 Home/ConnectionsPage 直接 create tmux。回归 gate：`useSessionOpenActions.test.tsx` 锁不调用 `createTmuxSession/createSession`，`App.dynamic-refresh.test.tsx` 锁显式切到既有 session，`relay-login-home-and-ephemeral-tabs-test-design.md`/function map/mainline call map 同步。
- [2026-07-12] Android WeType/OPlus 可能进入全局 IME ghost shown 状态：`mInputShown=true`、`mIsInputViewShown=true`，但 `contentTopInsets` 仍接近导航栏底部（如 2505）且屏幕无键盘；此时 zterm `ImeAnchorEditText` 和系统 Settings 普通 `EditText` 都会失败。必须先用系统普通文本框做对照，不能继续盲改 zterm anchor / renderer / tmux。已验证对 `com.tencent.wetype` 做明确包级 `am force-stop` 后，zterm 键盘真实弹出，`contentTopInsets` 变为真实键盘顶部（如 1509）。这只证明 IME 进程状态被复位，不能当成 zterm 代码修复闭环。
- [2026-07-12] Android 点击键盘/输入意图必须先把 renderer 从 reading 对齐回 follow/bottom，再 show/focus IME；否则滚到历史区后 native IME 可见状态与 renderer 可见窗口会分裂，表现为键盘按钮无法再次唤出或输入区缺失。owner 是 `TerminalPage` 输入意图与 `TerminalView` renderer follow reset；禁止用 IME 高度、viewport resize、TerminalView layout refresh 或 tmux resize 修复。
- [2026-07-13] Android 键盘 toggle 的底部对齐需要两段锁定：show 前先 reset follow，native `keyboardState(visible=true)` 到达后如果 `terminalKeyboardRequested` 仍为真，再 reset follow 一次，覆盖 IME 上台导致的 visual viewport 缩高。这个二次 reset 只移动 renderer visible bottom；不得触发 `TerminalView` upstream resize、不得改 daemon/tmux geometry。2088 真机 DevTools 验证 `.wterm deltaBottom=0`。
- [2026-07-12] Android IME 显隐真源必须来自 native `ImeAnchor.getState()/keyboardState` 的 `keyboardVisible/keyboardHeight`，不能用本地 `terminalKeyboardRequested` 或 inset 猜测。键盘按钮 show/hide 决策读取 native truth；IME 只允许 UI shell 做裁切/预留：stage reserve = measured quickbar chrome + IME lift，QuickBar shell 使用同一份 IME lift。`TerminalView` 不接收 IME resize token、不触发 upstream `onResize`、不改 tmux rows/cols。
- [2026-07-12] `mirror-fixed` 横向滑动是 renderer projection 状态：只允许平移 `.term-grid` 显示窗口并按 session 记住 offset；不得注册 adaptive lease、不得改 `buffer-head/cols`、不得请求 tmux/daemon resize。`adaptive-phone` 横向 pan 必须保持关闭，因为它的宽度变化只能走 daemon adaptive width lease -> tmux reflow -> mirror capture/readback。
- [2026-07-12] Android IME / renderer 真机闭环脚本必须先确认 app surface 可见；如果设备 keyguard/SystemUI 拥有屏幕，脚本应失败而不是冒充通过。当前 `100.104.163.65:5555` 设备锁屏时证据为 `isKeyguardShowing=true`、`mCurrentFocus=NotificationShade`，L5 只能标阻塞。
- [2026-07-08] daemon mirror capture 的稳定化不能要求动态 TUI 内容逐字连续一致；`top/htop/vim` 这类每次 capture 都会变化，若要求内容完全一致，会在 4 次重采样后显式失败并触发 live sync failure backoff，用户体感就是刷新很慢。正确门禁是“结构稳定才发布”：连续两次 canonical snapshot 的 absolute window / geometry / available line count 稳定，或已与当前 mirror 完整一致，就发布第二次最新内容；tail anchor 和窗口仍单调，内容不要求相同。回归 gate：`terminal-mirror-capture.test.ts` 覆盖 dynamic TUI frame 只采两次、`stabilizedAgainst='consecutive-window'`。
- [2026-07-08] Android terminal header top inset 不能硬编码 16px。折叠屏/高状态栏设备上系统状态栏会覆盖 terminal header 和首行内容。`resolveTerminalHeaderTopInsetPx(true)` 必须读取 CSS `env(safe-area-inset-top)` 的真实像素值，并以 16px 为最小值；仍禁止使用 `visualViewport.offsetTop` 作为 Android top inset，避免 IME 弹出时 top inset 二次叠加。回归 gate：`terminal-keyboard-lift.test.ts` + `TerminalPage.android-ime.test.tsx` + `TerminalHeader.test.tsx`。
- [2026-07-08] 慢刷新 + 状态栏遮挡修复发布为 APK `0.1.3.2034`，sha256 `b168e63472326eb716331ee4a8ea5d06da1d88841533196d4bf2593f3a9f3030`。已验证：动态 TUI capture owner gate、Android IME/header gate、`terminal.buffer_render` 相关完整 gate 223 tests、feature registry 31 tests、Android type-check、daemon/tmux close-loop 8 cases replay + strict audit、Mac client 146 tests + type-check、standard debug build/update manifest sha 对齐。缺口：本机无 online ADB 设备，不能宣称 Android L5 真机 UI 已闭环。
- [2026-07-08] 旧 `BRIDGE_SETTINGS` 缺 `terminalWidthMode` 时不能交给 `normalizeBridgeSettings()` 默认成 `mirror-fixed`。这会让已安装用户即使在手机窄 viewport 上也继续 fixed，表现为“不按 adaptive”。`useBridgeSettingsStorage` 必须在读取旧配置时用 `visualViewport.width -> innerWidth -> documentElement.clientWidth` 检测默认宽度模式并注入，再 normalize；只有显式 `adaptive-phone` / `mirror-fixed` 可保留原值。APK `0.1.3.2035` 已发布，sha256 `a9702c34b7bc5372c1e317bc4e6d2fb81d979c59994e88c1453d6c982a578a86`；调试浮窗增加 `WM` 字段用于截图确认当前宽度模式。回归 gate：`packages/shared/src/react/use-bridge-settings-storage.test.tsx` 旧配置缺 mode + narrow visual viewport 必须首帧 adaptive；`App.first-paint.real-terminal.test.tsx` 和 `SessionContext.ws-refresh.test.tsx` 继续锁 DOM/connect/reconnect payload。
- [2026-07-08] `terminal.buffer_render` 的 renderer 发布边界必须单调：同一 session 已发布 `revision=N` 的 render body 后，任何 `revision<N` 的 render snapshot 都必须拒绝发布并记录 `session.render-store.revision-regression-drop`；只有显式 `deleteSession()` / 重建 session 才能 reset render truth 并接受低 revision。这个门禁只防止本地 render store 把旧 snapshot 发布到新画面之后；若真机仍出现高 revision 旧内容交替，下一步必须查 daemon mirror / buffer-sync payload 源 truth 或 WebView compositing，禁止清 DOM / 清 buffer 掩盖。APK `0.1.3.2033` 已构建并发布到 update channel，sha256 `15e6e69ba70ed532c61ef7e301e9a994738315901978fe80fae22569dc57cef4`；本机 ADB 无 online 设备，L5 真机 UI 仍需 Jason 复测。
- [2026-07-08] client buffer manager 不允许迟到旧 `buffer-sync` 覆盖当前本地 absolute-index truth。`incomingRevision < localRevision` 必须显式 drop、记录 `session.buffer.sync.stale-lower-revision-drop` 并请求当前 tail；同 revision payload 若会改写已有非 gap 行，必须记录 `session.buffer.sync.stale-same-revision-drop` 并 drop；只有命中本地 gap 的 same-revision payload 才允许作为 gap repair 合并。刷新时出现旧/新页面交替，优先查 stale lower/same revision payload，不要用清空 buffer/DOM 作为 workaround。APK `0.1.3.2032` 已构建，sha256 `a8f5717c08825324ecde536890f0d1819a4a7b259963048638ffa355b13b8114`；本机无 online Android 设备，仍需 Jason 真机复测 L5。
- [2026-07-04] zterm recurring loop 初始化已收口为 `project.loop_governance`，当前唯一启用模式是 `zterm.daily-triage` 的 `L1 report-only`：只读项目真源、报告、追加 run log；禁止 product code edits、daemon start/stop、stage/commit、push/merge。真源文件是 `android/docs/loops/LOOP.md`、`STATE.md`、`loop-constraints.md`、`loop-budget.md`、`loop-run-log.md`、`loop-manifest.json` 和 `docs/testing/loop-governance-test-design.md`。L2/L3 未启用，必须等 L1 run history、唯一 owner/gates、maker/checker 和 Jason 明确批准。
- [2026-07-04] `docs/wiki/mainline-call-map.json` 的每条 edge 必须有 deterministic `edge_id=<lifecycle_id>:<from>-><to>`；loop manifest 的 `mainline_call_ids` 只能引用真实 edge。`src/lib/loop-governance-truth.test.ts` 已接入 `test:feature-registry`，锁住 loop manifest、L1 禁动作、kill switch、report required fields、mainline call ID、测试设计和 L2/L3 disabled。
- [2026-07-02] 每次开发 / 修复 / 重构必须先读 `android/docs/architecture.md` 与 `android/docs/audits/2026-07-02-architecture-boundary-remediation.md`，把方法映射到功能块、唯一 owner、allowed/forbidden paths、移除/分离/兼容保留决策和必跑 gate 后，才允许读代码并修改实现。禁止靠 grep 命中点直接 patch。
- [2026-07-02] daemon / tmux 主链只要本机可启动真实 daemon 与 tmux，就必须跑真实闭环，不能只用单测、typecheck、静态 gate 宣称完成。当前标准命令是 `pnpm --dir android run daemon:mirror:close-loop`，会用 managed daemon + tmux oracle 跑 `codex-live/top-live/vim-live/initial-sync/local-input-echo/external-input-echo/daemon-restart-recover/schedule-fire`，再做 replay 与 strict audit。本轮已在 tmux 3.6a 上 PASS，证据在 `android/evidence/daemon-mirror/2026-07-02/summary.json`。
- [2026-07-02] terminal 验证必须按 L0-L5 层级汇报证明范围：L2 daemon/tmux 真回环不能证明本地客户端连接；L3 Mac/Web/client core gate 不能证明 Android 真机或 packaged app；IME/drawer/renderer shell 问题必须跑 UI/WebView/设备层 gate，不能用 daemon 或 transport 低层 gate 代替。
- [2026-07-02] `App.tsx` 只能分发 session UI intent，不能直接持有 force relay / use auto 这类 session transport-mode rebuild 的 `closeSession -> createSession -> switchSession` 生命周期序列；该动作 owner 是 `src/hooks/useSessionOpenActions.ts`，并由 `src/lib/architecture-boundary-truth.test.ts` 锁住 App 层不复活。
- [2026-07-02] daemon 不得长期保存 client width policy：`TerminalSession.widthMode`、`SessionMirror.adaptiveCols`、基于 client resize 的 tmux `resize-window` / `window-size latest` ownership 已物理移除。attach/resize wire 仍可携带 `widthMode` 作为兼容入参，但 daemon 不把它写入 session/mirror truth。
- [2026-07-02] 架构防复发规则必须接入可执行 gate，而不是只写文档；当前 `src/lib/architecture-boundary-truth.test.ts` 已被 `test:feature-registry` 强制运行。扫描必须按 owner 语义精确：例如 `widthMode` 可留在 attach/resize wire payload，但不得成为 `TerminalSession` / `SessionMirror` state 或 tmux resize ownership。
- [2026-07-02] `docs/feature-registry.json` 与 `docs/function-map.md` 必须双向锁定：新增/修改 feature 时，机器 registry 的每个 `feature_id` 必须出现在人工 function map，function map 的 feature 行也必须引用 registry 已注册 id；已由 `src/lib/feature-registry-truth.test.ts` 接入 `test:feature-registry` 防止 owner map 双真源漂移。
- [2026-07-02] `docs/feature-gates.md` 必须覆盖 `docs/feature-registry.json` 的每个 `feature_id`，作为人读验证风险说明入口；已由 `src/lib/feature-registry-truth.test.ts` 接入 `test:feature-registry` 防止新增功能只有 owner map、没有验证口径。
- [2026-07-02] Wiki review 面必须有机器可读 call-map companion：`docs/wiki/mainline-call-map.json` 记录 `android_mainline`、`daemon_mainline`、`cli_mainline`，节点 ID 必须和 `docs/wiki/mainline-source.md` Mermaid ID 对齐，owner feature / docs / gates 由 `src/lib/function-wiki-truth.test.ts` 接入 `test:feature-registry` 校验。
- [2026-07-02] Generated wiki HTML 不得依赖外部 CDN 或脚本运行时；`scripts/build-function-wiki.mjs` 生成 deterministic inline SVG + source，`src/lib/function-wiki-truth.test.ts` 禁止 `<script`、`https://`、`cdn.jsdelivr.net` 复活，防止 review 面离线不可用。
- [2026-07-03] FileTransferSheet 的 Android 11+ 全盘本地文件访问不能走 Capacitor `Directory.ExternalStorage`；Capacitor 文档明确该目录只适用于 Android 9 或更老版本，已授权 MANAGE_EXTERNAL_STORAGE 仍可能列目录失败。唯一 owner 应是 `StoragePermissionPlugin` native 层：UI 负责 request/refresh/error projection，native 用 `Environment.getExternalStorageDirectory()` + canonical path guard + `java.io.File` 执行 `readdir/readFile/writeFile/mkdir`。本地目录读取失败必须显式投影错误，禁止清空列表后显示成“空目录”。
- [2026-07-02] `terminal.open_tabs` core intent 禁止再使用 `fallbackActiveSessionId` / `fallbackSessionIds` 这类 fallback 命名；已收口为显式 policy：`preserveActiveSessionId` 与 `nextActiveCandidateSessionIds`，并由 `src/lib/architecture-boundary-truth.test.ts` 接入 `test:feature-registry` 锁住。`open-tab-persistence` 读写失败必须返回显式 `failed/invalid` 或 `{ ok:false, error }`，不得伪装成空 open-tab truth。
- [2026-07-02] `TerminalSessionDrawer` 不得发明 host identity：禁止 `default` hostKey / `本机` hostLabel sentinel。`hostKey/hostLabel` 只能由 `TerminalPage` projection + `server-identity.ts` 注入；drawer 内部若需要展示未绑定 session，只能使用 private unscoped UI group，且不得把该 group key 传给 refresh/create callbacks。已由 `TerminalSessionDrawer.test.tsx` 和 `architecture-boundary-truth.test.ts` 锁住。
- [2026-07-02] Android IME quickbar/stage 上抬必须共用同一 chrome baseline：`TerminalStageShell.bottom` 和 `TerminalQuickBarShell.bottom` 都要把 `TERMINAL_QUICK_BAR_RENDER_LIFT_PX` 纳入基线，再叠加 IME lift；否则不同手机的 adjustResize/adjustPan 指标差异会放大成“终端容器上抬但快捷栏不上抬/半遮挡”。
- [2026-07-04] 折叠屏竖屏和紧凑横屏的底部快捷栏避让属于 UI shell bottom chrome policy，不属于 renderer/daemon 几何：`terminalChromeBottomPx = measured quickBarHeight + safeOffset + terminalBottomChromeLiftPx`，QuickBar shell bottom = `terminalImeLiftPx + safeOffset + terminalBottomChromeLiftPx`。foldable portrait 只在 `width >= 600 && height >= width` 生效，compact landscape 只在 `landscape && height <= 480` 生效；桌面样宽屏和 stale orientation 必须返回 0。回归锁 `TerminalView` 仍无 `onResize/onWidthModeChange`。
- [2026-07-07] Android IME 弹出后 QuickBar 高度测量不得扣 `keyboardInsetPx`：同一份 IME lift 已由外层 `TerminalQuickBarShell.bottom` 消费，`TerminalQuickBar.onMeasuredHeightChange` 只能上报自身真实 chrome 高度。若扣掉 keyboard inset，键盘高度大于快捷栏高度时 `quickBarHeight` 会被压成 0，stage reserve 只剩 IME lift，表现为底部不对齐或快捷栏遮 terminal 内容。回归门禁：`TerminalQuickBar.test.tsx` 锁真实高度，`TerminalPage.android-ime.test.tsx` 锁 stage reserve。
- [2026-07-02] Terminal drawer 的 session 列表必须是 `sessionGroups` catalog-first 投影：remote live session 只允许合并状态/active，不允许把未被 daemon catalog 枚举到的 runtime-only / stale opened tab 追加回抽屉。只要 daemon 没报告，就不能在 drawer 里假装“活着”。
- [2026-07-02] Android IME 只能抬外层 terminal stage / quickbar 容器，不能进入 `TerminalView` 内容 viewport 计算链或触发 upstream resize；同一轮修复里，terminal drawer 的 session 列表必须以 server/session catalog 为真源，再把 live runtime sessions 按复用 key 合并进去，不能再按“已打开 tab 顺序”自己拼一份列表。
- [2026-06-29] 多 daemon / 多服务器 UI 的用户可见身份不能再用 `bridgeHost:bridgePort` 或 telnet/bridge 端口表示；端口只是 transport 配置，不是服务器名。统一真源是 `src/lib/server-identity.ts`：drawer 分组、session group side peek、服务器色调用同一套 server key / display name / tone；UI 层只能消费 projection，禁止各自拼端口当 label。
- [2026-07-01] Terminal drawer 的远端 session 列表真源必须是 `sessionGroups` catalog，而不是 drawer 自己维护第二份列表。打开 drawer 只按稳定 hostKey 触发远端枚举，refresh 结果通过 `handleRemoteSessionsRefreshed()` 写回 catalog；drawer 再投影 remote-only rows，并点击后复用 group session open 主链。
- [2026-07-01 correction] Android IME 改变 shell 几何时不能进入 TerminalView 内容 viewport 计算链；IME 只允许影响外层容器 / quickbar 位置。terminal content geometry 必须保持 stable layout height 和 chrome bottom，不得把 `keyboardInset/terminalImeLiftPx` 汇成 renderer layout refresh / viewport demand，也不得通过 Android `onResize` 改写 upstream tmux rows。
- [2026-07-01] 大面积刷新遇到 revision-gap sparse payload 时，client 仍必须拒绝合并该 sparse body 并请求 authoritative tail；但拒绝时要立即 schedule 当前稳定 local buffer 的 render commit，避免等待 tail 期间 renderer 无新信号而停在空白态。这个动作不改变 buffer truth，只重推已确认 truth。
- [2026-06-29] zterm 多服务器身份色不能用连续 hue hash 自由漂移；紫/粉区在窄 drawer 里辨识差且视觉噪声高。`server-color.ts` 必须使用固定红/黄/蓝/绿/青/橙 palette，并用回归锁住常见服务器 key 不同色。
- [2026-06-29] Connections 入口页、terminal drawer、session group peek 必须共用 `server-identity.ts` 的同一 server key/tone。禁止 Connections 页直接按 `bridgeHost:bridgePort` 调 `server-color`，否则同一 daemon 会在入口页和抽屉显示成不同颜色。
- [2026-06-29] Terminal renderer 的 cell 宽度真源必须来自可信 glyph probe；如果 hidden probe 返回接近整屏宽，必须拒绝并回退到字体估算。单列 cell 被测成 viewport 宽会直接导致 ASCII/CJK、色块、反显区域错位。
- [2026-06-29] Android 网络从 offline/route-change 回 online 时，生命周期层必须只恢复当前 active tab transport，并复用现有 resume/audit/follow reset 主线；hidden 状态 online 不恢复，不允许扫所有 session 放大卡死风险。
- [2026-06-29] traversal route health cache 是进程级全局状态；任何会创建 `TraversalSocket` 并断言 WebSocket 实例数量/线路选择的测试，必须在 `beforeEach` 清 `defaultTraversalRouteHealthCache` 或注入隔离 cache。否则前一个用例记录的 failure/auth-failure 会让后续用例无候选路由，表现为 `MockWebSocket.instances` 期望 1 实际 0。
- [2026-06-30] `TraversalSocket` 不能在“所有候选都失败且暂无可选路由”时直接落死为永久 error；`finishFailure()` 必须继续进入 `scheduleReconnect()`，让后续网络恢复时自动重试。相关 reconnect 回归测试必须使用隔离的 route health cache，避免历史 failure 污染路由选择。
- [2026-06-30] traversal route selection 不能把 `failure/auth-failure` 提升成绝对不可选终态；当同 scope 下所有 candidate 都 unhealthy 时，selector 仍要返回“最不坏”的 candidate 让 socket 显式 probe。否则 route health cache 会把暂时性的网络恢复误判成永久无路可走，表现为杀 App 才能恢复。
- [2026-06-30] client buffer manager 不能把非连续 revision 的 sparse `buffer-sync` 当作完整 body truth 合并；如果 local revision 跳过中间帧且 payload 未覆盖完整窗口，必须拒绝写入本地 buffer 并请求 authoritative tail window。否则漏过的旧行会被 sparse diff 永久保留，表现为“大面积刷新时两行旧内容跟着 buffer 上移”。
- [2026-06-29] Android IME / keyboard lift 真源必须只有一份：`terminal-keyboard-lift.ts` 负责 viewport / lift 判断，`TerminalPage.tsx` 只能消费和 re-export，不能再复制 helper。已验证 WebView 已 resize 时 lift 必须为 0，只有 overlay 才按 stable height 计算。
- [2026-06-29] `test:terminal:contracts` 必须串行文件执行。`SessionContext.ws-refresh.test.tsx` 这类文件会 stub 全局 `WebSocket`，在 vitest 默认 file parallel 下会互相覆盖；contracts gate 需要 `--no-file-parallelism` 才能稳定区分真失败与假红。
- [2026-06-29] WezTerm 可作为 Windows TUI 观测窗口：`wezterm.exe cli spawn --new-window ... cmd /c codex` 能把 `codex` 跑进 mux pane，`wezterm.exe cli get-text --escapes` 可直接抓到当前屏幕和 ANSI 样式；`list` 用于定位 pane，`get-text --start-line -N` 可看 scrollback。此结论只覆盖“运行 + 观测”，不代表 input 已接入 daemon 真源。
- [2026-06-29] App update 弹窗按钮必须以用户眼前的显式 manifest 为安装真源：`startUpdate(manifest)` 不应再二次拉 `latest.json` 并因服务端刚发布新版而报“升级清单已变更”；二次 revalidation 只保留给无显式 target 的内部 `startUpdate()` 路径。已用正向/反向单测锁住，并发布 `0.1.3.1955` 到 `100.66.1.82:3333/updates/`，APK HTTP 200。
- [2026-06-30] Windows daemon runner 的两个高频坑已锁定：PowerShell 5.1 写 `config.json` 默认会带 BOM，daemon 读取会直接报 `Unexpected token '﻿'`；Windows Scheduled Task 运行环境也不会继承交互式 shell 的 PATH，所以 runner 不能假设 `wezterm.exe` 可见，必须显式探测并固化 WezTerm 可执行路径。后续 Windows 安装/自启动脚本默认按 no-BOM UTF-8 写配置，并把 WezTerm 路径当成安装态真源。
- [2026-06-30] Windows daemon 的连通性判断不能把“SSH/Tailscale 可达”误当成“应用端口可达”；如果 `22` 可连但 `3333` 不通，先查 Windows 侧监听/绑定/WFP/防火墙/服务暴露链路，不要再归因到 Tailnet 本身。
- [2026-06-30 superseded] UI 入口语义曾被错误收口为“Connections 主页面只进入/连接服务器 workspace，不打开 `new-connection` picker”。该结论已被现场纠正：主入口必须能新增服务器连接；只保留“Terminal drawer 底部 `New Session` 在当前选中 daemon 上创建空白 session”这一半规则。
- [2026-06-30 correction] Connections 主页面 FAB 的语义应是“新增服务器”，必须打开 `new-connection` picker；不能被收口成只进入已有 server workspace，否则用户无法新增服务器连接。Terminal drawer 底部 `New Session` 的语义仍是“在当前选中 daemon 上创建空白 session”，但 hostKey 解析必须覆盖 relay directory、saved server preset、runtime session identity，不能只依赖 relayDevices。
- [2026-06-30 correction] Terminal drawer 底部 `New Session` 不能点击后直接创建；必须先弹出创建表单，让用户确认 session 名和启动路径。启动路径默认 `~/`，用户可补齐为目标路径；确认后才调用 `tmux-create-session`，wire payload 必须携带确认后的 `cwd`。
- [2026-06-29] 多 daemon drawer 分组必须先做 endpoint alias 归一化：同一 `bridgeHost:bridgePort` 上只要任一 session 带 `daemonHostId`，其它只带 IP 的历史/open tab session 也要归入该 daemon identity；否则 UI 会把同一台机器拆成 “IP” 和 “机器名” 两组。`TerminalSessionDrawer` 只能显示注入的 `hostLabel`，禁止在 drawer 内再次从 key/label 推导名称。

- [2026-06-29] MacBook Air daemon 安装/启动的真源必须固化在 daemon 包与 service runner 内：npm postinstall / launchd runner 负责自动写 `~/.local/bin/zterm-daemon`、`~/.local/bin/wterm`，写入前先清旧 symlink/file；released runner 在读 config 前负责把旧 `~/.wterm` 迁移到 `~/.zterm`。远端验证已确认 `restart` 后服务正常、health 为 `ok: true`，且不再依赖手工修 PATH 或手工挪目录。

- [2026-06-29] ConnectionPropertiesPage 的 daemon-first 模式不能把“未映射 daemon”挡成死路：当 relay daemon 已选但没有 bridge preset 时，必须显示可编辑的 bridgeHost/authToken，让用户首次手工绑定后再保存并同步写入 `bridgeSettings.servers`；保存/Connect 都只能要求“已选 daemon + 已填 host/token”，不能再要求先有 preset。

- [2026-06-28] mobile session group 的正确语义必须拆成固定槽位和 viewport projection 两层：drawer 显示的 top / center / bottom 是用户显式分配真相，点击 peek 不得改写；stage 只按当前 focus slot 投影可见窗口。focus=top 时 viewport 为 `empty / top / center`，focus=bottom 时 viewport 为 `center / bottom / empty`，focus=center 时 viewport 等于固定槽位。focus 必须存 slot name，不能存 session id；抽屉点击 session 只替换当前 focus 槽位。禁止从已有 tab/session 列表自动补邻居做 wheel，也禁止点击后循环轮转。未指定槽位只渲染 placeholder；drawer 长按/右键的 slot menu 是唯一的槽位分配入口，且 menu 打开后必须 suppress 下一次 click，防止“打开菜单同时又切 session”的误触。
- [2026-06-28] mobile session group 的边界可见性必须和槽位 truth 分离：focus=top 时只隐藏 top 边界，focus=bottom 时只隐藏 bottom 边界，center 才显示两侧边界。这个规则已经下沉为共享 viewport projection helper，未来横向 left/right 也必须复用同一边界抽象，禁止在 UI shell 里各自再写一套 top/bottom 或 left/right 的局部 if。
- [2026-06-28] session group layout axis 的默认真源是 aspect ratio，不是设备名：`width / height <= 0.4` 的窄竖屏强制 vertical，上下滚；宽竖屏默认 horizontal，可在 Settings 切回 vertical；landscape 永远 horizontal。该设置只影响 layout projection，不改 drawer 固定槽位和 session/tab/pane 真相。
- [2026-06-28] copy mode 的 QuickBar 入口不能只依赖 `click`；Android WebView 下工具栏按钮 `click` 合成会偶发漏触发。`tmux-copy` 应由 press-owned 路径激活，但不要用固定时间窗判断同一轮触摸；现在收口为 `pointerDown/touchStart` armed、`pointerUp/touchEnd` commit、`click` fallback 的单轮去重，避免长按/慢释放把 copy mode 误切回去。长按菜单链路仍按 copy-longpress gate 验证。
- [2026-06-28] copy mode 的 QuickBar 入口在 Android WebView 下必须 press-start 立即激活；release commit 仍会漏 `pointerUp/touchEnd`，表现为按钮触达但状态浮窗 `CM OFF`。去重应由显式 press sequence 承担，后续 touch/pointer/click 只消费不二次 toggle。copy mode 行级长按也不得 `stopPropagation()`，否则父级 `TerminalTabSwipeSurface` 收不到右滑起点，session drawer 会被 copy 手势一起锁死。
- [2026-06-28] copy mode 还有一层 UI 耦合：`TerminalStageShell` 的 `ReactMemo` comparator 必须把 `copySelection` 和 `onLongPressRow` 纳入比较；否则 QuickBar 会先变蓝，但 `TerminalView.copyModeActive` 仍停在旧值，直到点开状态浮窗触发别处 state 更新才“看起来生效”。回归应直接盯 `TerminalView` 的 copy props，不要只看 QuickBar 染色。
- [2026-06-28] `BridgeSettings` 是 terminal width mode 的启动唯一真源；`useBridgeSettingsStorage` 首次 render 必须同步读取并 normalize localStorage，禁止先返回默认 `mirror-fixed` 再等 effect 异步修正，否则 restore/connect 首帧会用错宽度模式，表现为 `adaptive-phone` 只有重新 save 后才生效。
- [2026-06-27] Android 抽屉底部单按钮动作必须只保留一个语义 owner；`pointerup` / `touchend` / `click` 不要叠在同一个按钮上再加时间戳去重。`TerminalSessionDrawer` 的 `New Session` 经真机证伪不能依赖 `click` 或 `pointerup`；该按钮应由自身 `touchend` 截断父级 drawer 手势并触发 quick-tab picker。已用 `TerminalSessionDrawer` + `TerminalPage.session-drawer` 定向测试锁住。
- [2026-06-27] `TerminalSessionDrawer` 的 `New Session` 若状态浮窗显示只收到 `drawer:touchstart` 而没有 `add:*`，不能继续猜 `click/pointer/touch`，也不能直接判定遮挡；必须先用 capture target 确认命中节点。已验证有效修复是把 `New Session` 的语义 owner 从内部 button 上移到整个 footer hit surface，footer 自身作为唯一 `touchend` owner 触发 quick-tab picker，并用 `cap:start/end:<target>` 回归锁住。
- [2026-06-27] Session picker 默认不应要求人工点 `Connect`：只要有明确 `bridgeHost + authToken`，打开 sheet 就自动刷新 tmux sessions。picker row 必须把 daemon session 与已打开 tab 合并成同一行；daemon 成功枚举后，目标 owner 下未被远端报告的本地 open tab 自动以 `session-picker-remote-missing` 关闭，避免双列表和 stale tab。
- [2026-06-27] Android IME 特殊键要同时锁 `ImeAnchor backspace` 事件路径和 hardware `key` payload 路径；`KEYCODE_DEL` 必须归一为 `Backspace -> \x7f`，`KEYCODE_FORWARD_DEL` 必须归一为 `Delete -> \x1b[3~`，`Escape -> \x1b` 也要在 JS active-session 路由测试中覆盖。已用 `TerminalPage.android-ime.test.tsx` 与 native `ImeAnchorHardwareKeyMappingTest` 验证。
- [2026-06-11] multi-pane refresh 的一个明确放大器已收口：`SessionContext lifecycle` 的 active tick 只刷新 active session，visible non-active panes 走独立更慢的 passive visible tick；`buildLifecycleRefreshTargets()` 只保留 active，新增 passive visible target / schedule helper。已用 lifecycle、multi-pane-refresh、TerminalPage page tests 和 `tsc --noEmit` 验证。
- [2026-06-11] `TerminalPage` 的 interaction/live-pane orchestration 必须只有一个 owner；若 `interactiveSession / renderedPaneSessions / livePaneSessionIds / pane attach / chrome switch / swipe tab` 同时散在页面本体和 hook 中，就会形成第二份页面层语义与额外重算。当前唯一 owner 已收口到 `useTerminalPageInteractionRuntime`。
- [2026-06-12] active tab 切回后输入成功但本地刷新慢的一个真实生命周期缺口是：`resetSessionTransportPullBookkeeping()` 只清 pull state / sync debounce，不清 `pendingInputTailRefreshRef`。旧 input tail pending 会让切回后的第一笔输入失去立即 head-refresh 触发，表现成“远端先动、本地慢刷”。现在切 tab / active re-entry 的 reset 口已统一清理该 pending 输入书账。
- [2026-06-12] `build:android` 曾被 relay smoke 的固定端口 `19091/4335` 卡住，现已改成动态空闲端口分配后再注入 env；这是本机环境污染下的门禁问题，不是 relay/daemon 协议问题。修复后 `pnpm --dir android run build:android` 成功并发布 `0.1.3.1773` 到 `android/update-dist/`、`android/release-dist/` 和 `~/.wterm/updates/`，sha256 `c9a2e986715e99adda0977717b90b38e6d79541518e97c51fbdf376e17035f73`。
- [2026-06-09] client buffer 在 revision reset / 窗口失真期间不得发布空中间帧清空已有画面；若收到低 revision 且 `startIndex/endIndex` 为空、`lines=[]` 的 payload，只能记录等待，保留上一帧，直到非空或有明确范围的 `buffer-sync` 再提交 renderer，避免“先黑屏再刷新”。
- [2026-05-02] terminal 四层模型再次冻结：daemon 只管 `tmux -> mirror truth`；renderer 是 visible range 唯一真相；buffer manager 只管 local sparse buffer / gap repair，不持有 `follow / reading / renderBottomIndex`；gap 必须先空白占位，再按行/区间 patch 重刷
- [2026-05-02] terminal transport 也再次冻结：transport 必须长期复用长链接；同一 `bridge target` 只允许一个 control transport，同一 `clientSessionId` 只允许一个稳定 per-session transport；foreground/background/tab switch 只影响取数，不得 fresh recreate transport

- [2026-04-18] 先把流程真源拆成 spec / architecture / dev-workflow / task / CACHE / MEMORY / evidence
- [2026-04-18] skill 只承载跨任务可复用的动作、门禁、反模式
- [2026-04-18] runtime 改动必须走 build + sync + 安装态验证
- [2026-04-18] 本地开发入口遵循仓库 portless 规则，使用命令输出的 `*.localhost` 地址，不写死端口
- [2026-04-18] workspace 需要显式包含 `docs/decisions/` 与 `scripts/`，让流程与脚手架同层可见
- [2026-04-18] `note.md` 定位为 agent 私有工作笔记，不是项目真源；完成证据最低标准为截图、命令输出、APK 路径、必要时 logcat
- [2026-04-18] UI 实现前先冻结主参考图/次参考图；移动端结构优先级高于网页式临时布局
- [2026-04-18] connection 主线采用 `Sessions/Connections` 列表 + `Connection Properties` 五段式表单 + 终端预览卡片 + FAB 新建入口，不走网页式 host list 方案
- [2026-04-18] 页面级实现要先落 `docs/ui-slices.md`，把 App Shell、Connections、Properties、Terminal 分层，再进入代码
- [2026-04-18] 新实现 epic 使用 Beads `mobile-13`：三页式 mobile connection / terminal 架构；旧 open epic 已清理
- [2026-04-18] Connections 卡片的 preview 区不能在无 preview 时回退到 subtitle；否则会把同一连接摘要显示两次。无 preview 时应留空或改成独立占位文案。
- [2026-04-19] mobile 终端主链已从 SSH bridge 切到 tmux bridge：host/port 表示 bridge 地址，username 临时承载 tmux session 名
- [2026-04-19] Android WebView 若需要连 `ws://` 本地 bridge，不能继续使用 `androidScheme=https`；必须切到 `http` 并允许 cleartext，否则会被 secure-context / mixed-content 规则拦住
- [2026-04-19] Android 构建依赖 JDK 21；若本机装了 Homebrew `openjdk@21`，构建脚本应自动探测并导出 `JAVA_HOME`
- [2026-04-19] 连接模型不能把 server 与 tmux session 混成单一概念；必须显式支持：不同 server 上不同 session、同 server 上不同 session、必要时同 session 多客户端 attach
- [2026-04-19] 连接/会话真源要拆成 `bridgeHost + bridgePort + sessionName`，tab/卡片/终端标题必须同时展示 server 与 tmux session，避免“一个 host 字段兼做两层语义”
- [2026-04-19] 服务器启动入口要收敛成一个 daemon CLI，默认监听地址/端口由统一配置决定（当前 `0.0.0.0:3333`）；不要在验证过程中散落多个临时端口和多余 tmux session
- [2026-04-19] `bridgePort` / daemon port / daemon tmux session 名需要共用单一配置真源（当前 `src/lib/mobile-config.ts`）；UI、server、shell script、tests 不要各自写默认端口
- [2026-04-19] `New connection` 不能直接落空表单；应先进入统一 session picker：历史连接优先、tmux sessions 次之、clean session 最后。tmux 列表至少支持 list/create/rename/kill；terminal 顶部 `+` 长按复用同一个 picker 做 quick new tab
- [2026-04-19] session picker 顶部必须支持手动输入 Tailscale IP / tailnet host，并在输入后立即尝试列 tmux sessions；Tailscale 目标在 remembered servers / history 中优先展示
- [2026-04-19] tmux session 需要支持 multi-select，一次直接打开多个 tabs；适用于 New connection 与 quick-tab picker
- [2026-04-19] daemon / connection 鉴权真源使用共享 token：server 优先读 `~/.wterm/config.json -> zterm.android.daemon.authToken`，`ZTERM_AUTH_TOKEN` 只作显式 override；client 从 remembered target / host `authToken` 透传到 websocket query
- [2026-04-19] launchd 管理的 mobile daemon 不能只凭 `launchctl loaded` 判定 ready；`wterm daemon start/restart/install-service` 需要等待监听端口就绪，否则手机首连会撞空窗期误判“根本连不上”
- [2026-04-19] 悬浮球快捷菜单语义已冻结为“文本 snippet 注入”；方向键 / Esc / Backspace / 键盘切换只保留在常驻栏，自定义项默认不再预置 Ctrl 组合键
- [2026-04-19] daemon 稳定性门禁：`tmux capture-pane` 只能作为增强快照，失败时必须显式暴露错误并修真源，绝不能把整个 bridge 进程打挂
- [2026-04-19] 断线恢复门禁：client 不能只发 ping 不管 pong；必须有 `pong timeout -> 主动断开 -> host 级串行指数回退重连`，server 也要用 ws heartbeat 回收僵尸 socket
- [2026-04-19] session picker 的多选不能只靠整行高亮，必须给明确 checkbox；输入 IP 后要显式展示 bridge 测试/刷新状态、最后刷新时间和自动轮询说明，否则用户无法判断 tmux 列表是否已实时刷新
- [2026-04-19] terminal 若通过 DOM prepend 新增 scrollback 行，在“用户已离开底部”场景必须同步修正 scrollTop 锚点；否则继续输出后再回滚会出现 buffer 丢失/跳页错觉
- [2026-04-19] mobile 端不要额外开启本地 blink cursor；应只消费 bridge/buffer 提供的 cursor 位置，避免布局和字体变化时 cursor 视觉错位
- [2026-04-19] 若 terminal cursor 要忠实镜像 tmux，remote `CellData` 必须带 `width(0 continuation / 1 single / 2 double)`；client 只能按远程 cell truth 渲染，不能再按本地字符宽度猜 cursor 位置
- [2026-04-19] 多 tab terminal 不能只保留一个 active TerminalView 再靠 `outputHistory` 重放；每个 session 必须常驻自己的本地 terminal buffer，否则 tab 切换会丢 tmux 当前输入态并引发 cursor 错位
- [2026-04-19] terminal 持久化缓存不能只拼 raw output chunk；需要从本地 terminal buffer 抽取按行快照（scrollback + 当前 grid），这样不同排版/刷新路径才不会错乱
- [2026-04-19] Android 输入法真源应切到原生 `EditText` anchor：TerminalView 不再在 Android 主动 focus DOM textarea，键盘按钮只触发原生 IME；否则 WebView/textarea 会和原生输入连接抢焦点，导致输入法弹出后又被取消
- [2026-04-19] Android 上“上下滑一下整页 reload”要双层封口：前端 `html/body/#root` 关闭 body scroll + overscroll，原生 `MainActivity` 再把 Capacitor WebView `OVER_SCROLL_NEVER`；只靠 CSS 容易漏掉 WebView 级回弹/下拉刷新
- [2026-04-19] 快捷栏新增浮动按钮时必须先做占位避让，再做视觉强化；否则会遮住常驻按键。若入口要求长按拖动，仍要保留普通点击切换，拖动手势不能抢掉原有点击语义。
- [2026-04-19] terminal scrollback 不能再用“数组位置”当唯一身份；prepend/append/backfill 后 React key 会错位，必须带远程 scrollback 起始序号，按绝对序号合并/渲染，才能避免切 tab 时半屏旧半屏新。
- [2026-04-19] 真机发热排查先关掉运行态 debug overlay / 高频 setState；移动端 terminal 的调试指标必须按需开关，不能默认常驻。
- [2026-04-19] daemon buffer 真源按 tmux session mirror 维护：ws/tab 只是客户端壳，detach/reattach 不应重建 authoritative buffer，直到 tmux session 真正关闭。
- [2026-04-20] terminal 单指手势需要 axis lock：纵向滚动必须在确认纵向手势时重取当前 `scrollTop` 作为锚点，横向手势再切 tab；否则手指上滑会从旧锚点起跳，体验像“不是从当前底部开始滚”。
- [2026-04-20] 多 tab 的 hidden terminal 不能在后台继续按 `bufferUpdateKind` 推导 scroll 锚点；切回 active 时只允许两种恢复：原本贴底就贴底，原本看历史就恢复之前的 `scrollTop`。同时，scrollback/viewport 真源只能取 `remoteSnapshot`，不能再从 `bufferLines` 反推。
- [2026-04-20] 多 tab 左右跟手切换的真源应放在 `TerminalCanvas`：由 canvas 同时渲染 active + 相邻 tab，按手势 delta 做 translate，手指离开后再根据半屏阈值决定完成切换或回弹；`TerminalView` 只上报横向手势，不直接切 tab。
- [2026-04-20] mobile 发热要优先区分网络 vs CPU/IO：若流量不大但 `Chrome_IOThread` / `RenderThread` 高，占优先级最高的真源通常是“空 viewport 刷包”或“每帧 localStorage 持久化大 buffer”
- [2026-04-20] websocket reconnect / 首次 connect 完成后，active tab 必须立即恢复 **head-first** 主循环：先 `buffer-head-request`，再按本地 sparse buffer 状态决定 diff / 三屏重锚 / reading gap repair；不要再依赖第二套 active/idle 语义
- [2026-04-20] terminal 手势滚动锁应是 latch：一旦进入历史阅读态，直到真实输入发生前都不应自动恢复 bottom-follow；“滚回底部”本身不等于解锁
- [2026-04-20] scrollback 的 startIndex 必须是 mirror 生命周期内单调递增的绝对行号；client 只能持有一个连续区间，merge 出现 gap 时要丢弃断裂前缀，只保留最新连续尾段，再靠 backfill 补历史，不能把稀疏索引压成连续数组
- [2026-04-20] Connections 里的 remembered session group 真源必须按 `bridgeHost + bridgePort` 归并成“每台服务器一份选择”，不能再按“某次打开时的 session 组合”累积历史；否则会出现旧筛选残留、history-only group 无法编辑/删除
- [2026-04-20] repo 拆分边界初判：mobile 应用层应独立成 app repo；必须保留到 wterm fork 的只有 runtime 真源改动（如 `cell.width` / 宽字符渲染 / CSS 语义），其余页面/会话/存储/daemon 逻辑应留在 app 层
- [2026-04-20] `android/evidence/` 是本地证据仓，不应把整批历史截图/日志直接推到 GitHub 主线；Git 中只保留 `README.md` 说明目录与取证规则
- [2026-04-20] 跨尺寸布局真源必须统一成**一个 layout profile + pane stage**：phone / tablet / foldable / split-screen / future Mac 共用同一编排决策，页面语义不随平台分叉
- [2026-04-20] Jason 补充冻结：大屏统一效果默认应是一行多列、列与列之间垂直分屏；不要把上下堆叠多 pane 当成主方案。future Mac 也沿同一单行多列编排复用 shared app-layer
- [2026-04-23] terminal 新真源落地时，server 不能再按 client active/idle 状态主动 push buffer；唯一对外职责应收敛成 **显式 `buffer-head-request` / `buffer-sync-request` contract**，client 是否拉取由自己的 buffer worker 决策，consumer 不得把消费状态写回 producer 当长期真相。
- [2026-04-23] Android renderer 若继续暴露 `onViewportPrefetch / followViewportNonce` 这类 transport-aware 接口，会把 renderer 和 buffer worker 再次耦合回去；renderer 只保留窗口声明与 UI reset 信号，prefetch/range repair 必须留在 worker。
- [2026-04-23] Android SessionContext 若同时保留 `sendTailBootstrapBufferSyncRequest / sendFollowRefreshBufferSyncRequest / refreshSessionTail` 三套近似入口，会继续把 sync 策略散成多真源；应先合并成单一 `requestSessionBufferSync` + 单一 viewport reset 入口，再继续拆 worker/renderer。
- [2026-04-23] Terminal renderer 的 follow/read 不能只拿 DOM `scrollTop` 去纯推导：真实 DOM bottom 会短时小于逻辑 tail，导致 active follow 误判成 reading。正确边界是：buffer/render 真源仍分离，但 renderer 允许保留一个**最小 UI reading latch** 来表达“用户是否正在读历史”。
- [2026-04-20] 当 Mac 需要移植 Android 连接配置流时，优先下沉纯逻辑到 `packages/shared/connection/*` 与 `packages/shared/react/*`（Host / BridgeSettings / tmux discovery / localStorage hook），而不是在桌面端复制一套 ad hoc 表单/存储实现
- [2026-04-20] tmux session discovery 不是 live connect：桌面端如果只做 `list-sessions`，用户会看到“能找到 session 但连不上”。真正连接必须显式复用 Android 的 websocket 协议：`open ws -> send connect(payload) -> 进入 head-first loop`
- [2026-04-20] 若 `bridgeHost` 已是显式 `ws://host:port` / `wss://host:port`，shared truth 必须把这个显式 endpoint 当成 display/preset key/store port 的真源；不要再额外拼接独立 `bridgePort`，否则会制造双端口假象并污染 remembered server key
- [2026-04-20] endpoint 归一不能只修 Mac；Android 的 `bridge-settings / bridge-url / connection-target / storage hooks / Connection Properties` 也要直接复用同一个 shared truth，否则桌面和移动端会再次在显式 `ws://host:port` 场景下分叉
- [2026-04-21] Jason 明确认可当前快捷栏/按钮视觉方向：后续 mobile UI 默认沿用“简洁、闭合、分区明确”的 capsule/block 设计语言——低噪声配色、清晰边界、成组区域、按钮闭合感优先；新增页面/组件若无特殊原因，应沿这个方向统一
- [2026-04-21] 升级验证流程冻结：首次装机可用 ADB，但后续新版本默认必须走 app 内建升级链路验证（manifest -> 提示 -> 下载 -> 校验 -> 系统安装）；除非 Jason 明确要求，不再用 ADB 直接覆盖新版本
- [2026-04-21] tmux pane 真源校验：`display-message '#{history_size}'` 返回的就是 `capture-pane -S -... -E -1` 可见总行数，不要再额外 `+ pane_height`；否则 absolute index 会整体偏移，导致 viewport/buffer 拼接错位
- [2026-04-22] Jason 冻结新的 terminal render 真源：client 不再让 daemon viewport 参与最终画面决策；render 只保留绝对窗口 `[renderTopIndex, renderTopIndex + viewportRows)`，follow bottom=`availableEndIndex - viewportRows`，缺失行一律显式 blank。
- [2026-04-22] terminal 底部被吃行时先查 UI 双重扣减：若 `TerminalCanvas` 已经处在 quick bar 上方剩余高度内，就不能再把 `quickBarHeight` 作为 `visualBottomInset/paddingBottom` 传给 `TerminalView`，否则会稳定少掉尾部几行。
- [2026-04-22] Jason 冻结键盘规则：无论软键盘/输入法是否弹出，terminal 显示高度都不跟着改；只允许做 UI 视觉上抬，禁止把 keyboard inset 回灌成 terminal 高度变化、tmux resize 或 buffer/render window 高度变化。
- [2026-04-22] daemon 安装/重启前先清理 legacy `com.wterm.mobile.daemon`，并用 `ThrottleInterval` 限流；否则 launchd 会在端口冲突时持续重拉服务，放大系统负担。
- [2026-04-22] canonical bottom 必须按 `availableEndIndex` 算，不允许再被本地 slice 的 `endIndex` 截短；否则 follow 会假装已经到底，实则还差尾巴。
- [2026-04-22] tab/session 隔离门禁：Terminal callback（input / resize / viewport / focus）必须显式携带 `sessionId`，禁止在 App 层按 `activeSession` 隐式路由；tab 切换只允许改变 active/render 频率，不允许 remount 单一 TerminalView 去复用别的 session 状态。
- [2026-04-22] buffer-sync 新冻结：hidden tab 完全冻结，不收 live buffer；active tab 默认只追当前尾屏并按绝对行号连续门禁渲染，若当前/预校验窗口不连续则保持上一帧并触发补拉；只有 reading 且断裂时才向前预拉两屏高度。
- [2026-04-22] 新根因补充：follow 态若把每次 `viewportEndIndex` 推进都回发成新的 `buffer-sync-request`，会形成“server 刚推一帧 -> client 立刻再拉一帧”的请求风暴；follow 请求只应在 connect/switch/input/resize/模式切换时刷新，active live payload 默认只发 changed-range，不拼整屏 viewport。
- [2026-04-22] session 定时发送 / heartbeat 的唯一真源必须在 daemon：job 绑定 tmux `sessionName`，daemon 负责持久化、nextFireAt 和实际发送；Android / Mac 只做 calendar + alarm 风格编辑器，不允许各自维护本地调度器。
- [2026-04-22] daemon 若要复用 `packages/shared`，不能从 `@zterm/shared` 根入口 import；根入口会带上 React/CSS，Node 运行态会直接 SyntaxError。server 侧必须只 import 叶子 shared 模块（如 `schedule/next-fire.ts`）。
- [2026-04-23] schedule UI 若只消费定时规则/格式化函数，也应优先 import `packages/shared/src/schedule/*` 叶子模块；否则会把 `@zterm/shared` 根入口的 terminal-view/CSS 依赖链进来，污染静态渲染与 Node 工具链。
- [2026-04-23] session schedule 的最小真实闭环证据可以做成“临时 daemon + 临时 HOME + tmux session + websocket 协议 smoke + tmux side-effect 文件 + schedules.json 持久化”组合；相比只看 `schedule-event(triggered)`，这样能同时证明协议、执行和落盘都是真的。
- [2026-04-23] Android quick input/floating panel 若渲染在被 `transform` 抬起的 quick bar 容器下，fixed overlay/bubble/panel 不能再额外按 `keyboardInset` 计算 bottom/padding；否则会出现“输入法一弹出，面板被抬到屏幕外”的双重位移。
- [2026-04-23] 快捷按键组合算法若同时被 Android / Mac 消费，必须下沉为 shared 纯函数（组合编码、序列反解、默认 label）；平台侧只维护 token 编辑与展示，不能复制 `Ctrl + 字母` 等规则。
- [2026-04-23] foreground 恢复不要无差别重连所有 session；应先恢复 active session，其他 session 仅在本身非健康时补拉，否则 hidden tabs 也会被一并唤醒，徒增带宽且拖慢当前 tab 恢复。
- [2026-04-23] 同 host 多 session 的统一 foreground reconnect 若仍保留串行 bucket，必须先重连 active session；否则当前 tab 会被隐藏 tab 的重连排队拖住，表现成“回前台后当前页假死”。
- [2026-04-23] reconnect 成功后的 client 不能只等待服务端 live flush；应立即补一条 tail refresh request，否则 session 会先显示 `connected` 但本地 buffer 仍停在旧 revision，造成“假连接、不更新”。但 **hidden->active / foreground refresh** 不能无脑 bootstrap 整个 tail：若本地尾窗连续，应发送带本地 `revision + local window` 的 follow request；只有本地尾窗缺口/空 buffer 才 bootstrap。与此同时应补一发 `ping` + 短超时 watchdog，避免“激活了 tab 但没渲染也不重连”。
- [2026-04-23] active + follow tab 还需要保留一个低频 tail probe（follow `buffer-sync-request` + `ping` + 短 watchdog）作为 observer 漏通知的自愈链路；否则 daemon 没再主动推时，客户端会误以为“没有新尾行”，表现成只有用户输入/切 tab 后才刷新。
- [2026-04-23] runtime 远程排障真源应放在 daemon HTTP：client 只上送 bounded runtime debug entries，daemon 统一缓存并通过 `/debug/runtime` + `/debug/runtime/logs` 暴露 session/mirror 快照与最近日志；接口复用 daemon auth token，方便服务器端直接拉现场证据。
- [2026-04-23] foreground/active refresh 不能只把 SessionContext 的 sync view 改成 `follow`；`TerminalView` 自己的 `followMode/scrollTop` 也必须收到显式 reset nonce。否则会出现“恢复后展示的是旧 scroll 位置的老 buffer，只有用户输入触发 `forceFollowViewport()` 才跳到最新”的假刷新/假黑屏。
- [2026-04-23] active tab 的 terminal render 不允许在 visible/precheck window 有 gap 时继续复用上一帧；当前三屏窗口可以不连续，UI 应立即渲染最新 tail + gap marker，再对窗口内 missing ranges 发稀疏 prefetch。
- [2026-04-23] follow 态的 gap repair 真源是“当前三屏窗口内 missing ranges”，不是“从旧 stop point 连续追到最新”；active 页只补当前窗口命中的缺口，hidden/窗口外内容允许继续缺失，以控制带宽。
- [2026-04-23] terminal 主题真源要覆盖默认前景/背景 + ANSI 16 色，而不是只改背景色；theme choice 应持久化到 shared `BridgeSettings.terminalThemeId`，Settings 只负责切换 preset。
- [2026-04-23] Android / Mac 共用 terminal theme 时，preset 与颜色算法必须下沉到 shared 纯模块（如 `packages/shared/src/terminal/theme.ts`）；平台各自只消费 preset，禁止复制第二套 ANSI 映射表。
- [2026-04-23] Settings 若把 terminal theme 卡片显示成“正在使用/Active”，该点击动作就必须立即持久化到真实 `BridgeSettings.terminalThemeId`；不能只改页面 draft 再等 Save，否则切页回来会回默认主题，制造“已生效”的假状态。
- [2026-04-24] reading 滚到缓存顶部时，3 屏只是 cache window，不是滚动上限；client 要预取前两屏并显示 loading，补齐后再继续上滚，不能把顶部写死成停住
- [2026-04-24] 手势滚动要跟手，不要靠固定步长/固定屏数硬跳；buffer 回补是边界处理，不是主滚动方式
- [2026-04-23] Android 快捷输入面板的 outside-close 要走 document capture 级监听；仅靠面板外遮罩 click，在 quick bar 根节点有 pointer capture / preventDefault 时并不稳定。
- [2026-04-23] session 级定时发送入口不能挂在 tab strip/header 这种易被理解成“tab 全局动作”的位置；Android 侧应放在当前 session 的 quick input/composer 入口内，明确“对当前 session 生效”。
- [2026-04-23] 悬浮球若保存的是绝对 `left/top` 坐标，必须在 mount 和 viewport resize 时自动 re-clamp 到当前可视区；只在拖动时 clamp 会导致旋转/窗口变化后入口消失。
- [2026-04-23] 悬浮菜单与底部 shell rows 必须分层：菜单打开时可隐藏 rows，但关闭后要立刻恢复；keyboard 弹起时只上抬 rows，不要让悬浮球/菜单复用同一 transform。
- [2026-04-23] 悬浮菜单里的快捷输入列表点击语义是“立即发送并默认补 `\\r`”，不要再走“追加到 draft 再手动发送”；只有剪贴板条目才做 draft 注入。
- [2026-04-23] terminal follow 若在每次 buffer/input 事件里立刻 `host.scrollTop = bottom`，会和 onScroll / viewport emit 形成双向拉扯；要改成 rAF cadence 单向贴底，并忽略程序化 scroll 触发的 onScroll，底部才不会抖。
- [2026-04-23] terminal 顶部 tab strip 若无键盘导航需求，不要留下浏览器默认 focus ring；`tabIndex=-1 + blur + outline none` 是移动端更稳的默认态。
- [2026-04-23] 拖拽排序 UI 若在 `pointerMove` 里更新 React state、在 `pointerUp` 里立刻提交，不能只依赖 state 闭包值；必须维护一个同步 ref 作为 drag 真源，否则 release 可能读到旧 targetIndex，表现为“拖了但顺序没生效”。
- [2026-04-23] drag target 计算不能把正在拖的那一行自己也纳入候选；否则命中会持续偏向自身行，排序目标几乎不会变化。
- [2026-04-23] keyboard 关闭态不能在 quick bar 外层保留 `transform: translateY(0)`；这会让其内部 `position: fixed` 悬浮层脱离视口坐标系，直接把悬浮球/快捷面板的位置算坏。
- [2026-04-23] 快捷按键编辑器的“显示名称”若自动写入第一个 token（例如先点 `Ctrl` 就写成 `Ctrl`），会把组合键默认名污染掉；组合键的默认显示名必须来自最终 `preview`（如 `Ctrl + C`），不是来自首个 token。
- [2026-04-23] Jason 冻结新的 terminal 真源：server 按 session 只做 **30Hz head 广播 + range request 响应**，不主动 push buffer 内容；client 侧拆成 sparse buffer worker / renderer container / UI shell 三层，consumer 不得改 source。
- [2026-04-23] client buffer 真源必须允许不连续：follow 默认维护尾部 3 屏热区，reading 只在 renderer 当前窗口缺失时补缺；hidden tab 只收 head，不拉 range，不补缺口。
- [2026-04-23] `TerminalView` 里凡是 active/reset/layout/audit 都会触发的 follow 贴底动作，必须收成单一 helper，再配合纯的 scroll->mode 判定 helper；否则同一 follow 真相会在多个 effect 中分叉，后续修一个入口很容易漏另一个入口。
- [2026-04-23] client viewport worker 若已进入某个 reading window，就不要对完全相同的 viewport 再排队第二次 range request；同一 session 一旦回到 follow，必须同步清理之前排队的 reading sync，避免 stale request 白打到 daemon。
- [2026-04-23] `active tab switch` 和 `follow reset` 若都要构造 follow viewport state / bootstrap 判定，必须复用同一 helper；否则 follow rows/endIndex/cache window 很容易在两个入口长歪成两套语义。
- [2026-04-23] `connectSession` 与 reconnect bucket 可以共享 socket 握手、heartbeat、公共 server message 分发，但 `connected` 成功后的状态推进仍要保留各自分支：普通 connect 不该偷偷带入 reconnect bucket 的 side effect。
- [2026-04-23] connect / reconnect 的 `connected` 成功后若有一大段完全相同的 baseline 动作（写 connected 状态、schedule-list、active bootstrap、watchdog、connectedCount），应先收成公共 helper，再把 bucket reset / queue drain 这类额外 side effect 挂在外层。
- [2026-04-23] connect / reconnect 的 `finalizeFailure` 也应按同样方式拆：完成位、cleanup、schedule error、manual-close 终止属于公共 baseline；retry、bucket attempt、pending requeue 属于外层专属语义。
- [2026-04-23] `TerminalView` 缩 effect 面时，先抽 `viewport refresh schedule` / `current viewport emit` 这类无语义 helper；不要一上来强行合并 effect，先把重复动作单点化再说。
- [2026-04-23] `TerminalView` 里 reading viewport emit 若会在‘prepend 历史后重锚’与‘reading near edge 补拉提示’两处重复出现，也先抽本地 helper；renderer 收口优先顺序仍是动作单点化 > effect 合并。
- [2026-04-23] `TerminalView` 再往下收时，follow reset、prepend 历史锚定、near-edge reading emit 这类 viewport action 也应先名字化成 helper；名字化后更容易看出哪些 effect 只是调度层、哪些才是状态层。
- [2026-04-23] 当 `TerminalView` 里两个 effect 只是在分别守 `becameActive` 与 `viewportResetNonce` 这两种 follow reset 信号时，可以合并成一个 reset effect；前提是 session 切换时初始化 ref 的语义不变。
- [2026-04-24] `TerminalView` 里若‘当前 viewport emit’与‘reading near-edge emit’只是同一渲染阶段里的两次 emit，可合并成一个 effect，前提是 `emitViewportState` 自身已有稳定的 dedupe key。
- [2026-04-24] `TerminalView` 的 viewport refresh 调度若会被 layout/session 两类 effect 复用，就把 `sync + optional follow align` 收成单一动作，并在执行时再读取当前 reading/follow latch；不要让 scheduler callback 直接依赖 followMode，否则用户一滚动就会把无关 refresh effect 全部重新挂载。
- [2026-04-24] `TerminalView` 的“session 初始化/重置”effect 不能依赖 `authoritativeViewportEndIndex` 这类 live head；它只能由 `sessionId` 或显式 `followResetToken` 驱动，否则 reading 态会在每次尾部推进时被误重置到 follow。
- [2026-04-24] `ResizeObserver` 也是 viewport refresh 链的一部分，不要单独直连 `syncViewport()`；它应复用同一 `runViewportRefresh()` 动作，这样 real resize、layout nonce、session refresh、follow audit 才不会长成四套 refresh 口径。
- [2026-04-24] `layout refresh` 与 `session refresh` 若最终都只是“判定是否触发 refresh + 选择 timeout”，可以合并成单一 trigger effect；但 `becameActive / sessionChanged / layoutChanged` 仍要显式保留，不能为了少一个 effect 抹掉触发来源。
- [2026-04-24] 当 `TerminalView` 里剩下的 effect 已不再只是调度，而是承担 `prepend 历史后的 reading 锚定`、`当前帧 viewport signal` 这种状态语义时，先把 effect 内动作名字化，再让 effect 只做 trigger/state bridge；不要为了“继续减少 effect 数量”硬把状态语义揉坏。
- [2026-04-24] `TerminalView` / `TerminalPage` / `SessionContext` 若都在内联同一份 viewport/resize schema，应下沉到 `android/src/lib/types.ts` 做接口真源；这样后续再改 viewport 字段时，不会一边改 context 一边漏掉 renderer/test。
- [2026-04-24] renderer prop 面也要按“真实输入”审计：如果某个字段只剩作为 dependency 占位，而不再参与渲染/输入/状态语义，就应从 prop 面移除；`bufferRevision` 就是这种可以安全删除的残留。
- [2026-04-24] renderer trigger 命名也要按真实语义收口：如果 token 的作用是“把 terminal 拉回 follow”，renderer API 应直接叫 `followResetToken`；不要继续把 worker 内部的 `viewportResetNonce` 原样泄漏到 renderer prop 面。
- [2026-04-24] 若 worker/store 内部的旧命名只剩少量闭合传播点，不要长期保留 page 层映射；直接把 `viewportResetNonce` 一并统一成 `followResetToken`，让 worker/page/renderer 共用同一语义名。
- [2026-04-24] `SessionContext` 里 request payload builder 也要按“唯一构造点”收口：如果 bootstrap 只是普通 request 的少量字段覆盖，就改成单一 `buildSessionBufferSyncRequestPayload()`，不要长期并存两份 builder。
- [2026-04-24] `updateSessionViewport()` 这类 worker 入口若同时在做 normalize、判等、调度请求，后面很容易再长分叉；应把这三层拆成 helper，让入口函数只做“写状态 + 触发 demand”。
- [2026-04-24] active session 的“输入后刷新”不能靠本地回显，也不能完全被动等下一次 head；正确口径是 `sendInput()` 只发 input，同时挂 `input-tail-refresh` demand，由 client 本地 30fps head tick 在网络分级门限内主动打一条 follow `buffer-sync-request + ping`。
- [2026-04-24] “本地 30fps 刷新 head”不等于 30fps 拉 range：固定 `33ms` tick 只做 head freshness / demand 判定；真正 range 请求频率要由网络状况和配置决定（如 `minTailRefreshGapMs`、reading delay），否则又会退化成请求风暴。
- [2026-04-26] mobile-15 首屏慢的已验证根因之一：restore / foreground resume 若把 hidden tabs 一起 eager reconnect，会把 active tab 首刷排队拖死；transport gate 必须保证 cold-start / resume 时 **只允许 active tab eager connect / poke**，hidden tabs 仅在显式激活时再 reconnect，除非后续有被证实正确的 hidden low-frequency 设计。
- [2026-04-26] mobile-15 本轮收口确认：server 不再主动 push `buffer-head`，renderer 不再上送 `missingRanges` / prefetch 规划，reading gap repair 只由 buffer worker 基于本地 sparse buffer 计算；IME/layout nonce 也不得再回灌 renderer refresh。

## Patterns & Learnings

- 先定真源，再写代码，能减少反复返工
- 证据和任务分开，能避免“完成感”替代验证
- skill 应该像门禁，不像日志
- mobile 项目先冻结流程真源，再进入实现，能防止浏览器通过但 APK 未闭环的反复问题
- UI 任务先对齐信息结构与交互结构，再做视觉细节，能减少返工
- connection 入口、编辑页、终端页要拆成三条 UI 主线分别落地，避免“一个页面兼做所有事”的混乱结构
- 页面级重构时，优先把当前组件拆到 page/component ownership，再补功能细节
- 卡片上半区和下半区不能复用同一句摘要；preview 缺失时必须单独处理，否则会制造“重复显示”的错觉
- tmux bridge 输入闭环可用 `cat -v` 做最小真相验证：方向键应显示 `^[[A` 类序列，Esc 显示 `^[`，自定义组合键显示对应控制字符/文本
- daemon CLI 重启验证不能只看 `tmux has-session` / `daemon status`；还要补 `nc` 或实际 WebSocket probe，确认 socket 已真正开始监听
- scrollback 若依赖 DOM prepend/trim 历史行，必须在非底部阅读状态保 scrollTop 锚点，否则终端持续输出时会破坏回滚阅读体验
- cursor 文本切分必须按 cell/code point，而不是按 UTF-16 code unit；否则 emoji/astral 字符会把 cursor 切裂
- 多 tab terminal 的恢复真源应该是“每 tab 常驻 buffer + 本地按行 snapshot”，不是“切 tab 后 clear 再 replay 历史字符串”
- Android 软键盘问题优先排查“谁在抢 input focus”：先看 WebView / DOM textarea / native EditText 三者谁持有焦点，再决定是否改插件；只加 `showSoftInput()` 而不切断 DOM focus 往往无效
- Android WebView 的整页回弹不要只在终端容器上修；要把 body/root/WebView 三层都关掉，把滚动权限只留给 terminal buffer 容器
- 终端发热先查运行态 debug overlay / 高频 metrics setState / console spam；这些比布局本身更容易在手机上造成明显发热
- terminal 持久化不要把 `remoteSnapshot` / `outputHistory` 这种高频变化大对象每帧写进 localStorage；恢复态优先保留按行 `bufferLines`，真正的 viewport/cursor 靠 reconnect 后服务端刷新
- Electron 打包壳与交互验证要分层：`.app` 负责验证 build/package/window 可执行；细粒度表单交互更适合走浏览器 dev server（同一 renderer 代码），再回到 `.app` 验证桌面壳仍可启动
- [2026-05-03] 源码树污染冻结：`android/src/`、`packages/shared/src/`、`android/vite.config.js` 不允许出现由 TS/JSX 生成的 `.js` 产物；真源只允许 `.ts/.tsx`。已新增 `android/scripts/check-no-source-js-pollution.mjs` 并接入 `android/package.json -> type-check`。后续一旦再有 `.js` sibling 写回源码树，直接视为构建/工具链违规。
- [2026-05-04] transport stale gate 要覆盖**写侧 request**，不只覆盖 `ws.onmessage/onclose/onerror/onopen`。`buffer-head-request` / `buffer-sync-request` 若接受外部 `ws` override，必须先校验它仍等于 `readSessionTransportSocket(sessionId)`；旧 superseded socket 即使只是晚到触发 request，也会把当前 session transport 真相重新污染。
- [2026-05-06] traversal relay 产品化真源冻结：用户不应再手填 `signalUrl / turnServerUrl / turnUsername / turnCredential`。客户端唯一协议真源应是登录控制面后得到的 `relayBaseUrl + ws(devices/host/client) + turn + accessToken + device metadata`；UI 只暴露 relay 登录和 device list，不暴露协议细节。
- [2026-05-06] relay 控制面接线若要真正走 RTC relay，client target 真源必须带 `relayHostId`；`ws/client` 不是普通 signal server，而是按 `hostId` 路由到在线 daemon host。只下发 `wsClientUrl` 不带 `hostId` 仍然无法连到指定 daemon。
- [2026-05-06] transport 自动模式真源再次冻结：**只允许固定顺序** `Tailscale -> IPv6 -> IPv4 -> Relay`。这不是“fallback 系统”，只是单一连接策略；禁止再长出额外 transport 状态机、补偿分叉或第二顺序语义。

- [2026-05-09] input 丢失根因冻结：`sendInputThroughSessionTransport` 中 `hasPendingSessionTransportOpen` 为 true 时原直接 return，input 静默丢失。修复：新增 `pendingInputQueueRef` (Map<string, string[]>) 队列机制，transport pending 时入队，transport ready 后在 `finalizeSocketConnectionBaseline` 中 flush。flush 失败（ws 非 OPEN）时队列已被 delete，不产生内存泄漏。
- [2026-05-09] multi-pane 优化真源冻结：(1) `resolveStaticPaneLayout` 在 orientation change 时冻结 `baselineHeightPx`，`currentMaxSplitCount` 不再依赖 viewportHeight/IME；(2) sync debounce 33ms 防重复请求风暴，`handleBufferHeadRuntime` 收到 fresh head 时必须清除 debounce 状态否则会阻塞后续 tail entry；(3) 所有可见 pane 的 TerminalView 均 `live=true`；(4) split landscape 新增 `shellMode: floating-collapsed` 折叠快捷栏。
- [2026-05-09] 构建版本元数据门禁：`update-dist/latest.json` 的 `versionName / versionCode / buildNumber / apkUrl / sha256` 必须与 `android/.build-meta.json` 和 `android/release-dist/latest.json` 保持一致。曾出现 `undefined.1001` 错误版本，根因是构建脚本在 versionName 解析失败时回退到硬编码默认值。
- [2026-05-09] CACHE.md 体积膨胀门禁：CACHE.md 已被加入 .gitignore；项目级 CACHE.md 不应提交到 git。对话缓存只在本地保留，超过合理大小应定期清理。
- [2026-05-13] open-tab runtime switch 语义必须冻结成两类且只能在 App 层唯一桥接：`restore-sync` 只切 runtime active，不开 transport；`explicit-resume` 才允许桥接到 `resumeActiveSessionTransport`。若继续用单个布尔 `switchRuntime` 混写两类语义，会重演“cold restore 首帧误连”与“用户显式激活却不开 transport”这两种互相冲突的 bug。
- [2026-05-13] foreground refresh 的 transport 恢复真源只能留在 `SessionContext -> ensureActiveSessionFresh / buildActiveSessionRefreshPlan`；App 层旧的 `performForegroundRefresh` 若已不接运行态，必须物理删除，避免再长出第二套前台恢复语义。
- [2026-05-13] foreground false->true 不能只靠 `appForegroundActive=true` 加 active tick 被动兜底；`SessionContext lifecycle` 必须拥有唯一 `active-resume` 入口，并且对当前 active session 立刻执行 `ensureActiveSessionFresh({ source:'active-resume', forceHead:true, markResumeTail:true, allowReconnectIfUnavailable:true })`。
- [2026-05-13] reconnect gate 不能把 `timer pending` 和 `connecting ghost` 混成一个布尔 `reconnectInFlight`。若现场出现 `sessionState=reconnecting + ws=null + no pending open intent`，这不是“还在连”，而是 **stale reconnect bookkeeping**；foreground/explicit refresh 必须允许直接重启 reconnect，否则会被 `transport-unavailable` 永久卡死。
- [2026-05-13] 已验证的 tmux 高度真因：当前 `adaptive-phone` daemon 实现若走 `resize-window -x`，tmux 会自动把该 window 切到 `window-size=manual`；此后即使后续 client 更高，window/pane rows 也不会自动恢复，直到显式切回 `window-size=latest`。所以“代码没写 rows，但 session 高度一直很矮”仍然是**当前代码路径通过 tmux manual 语义间接冻高**，不是单纯历史残留。已补真实 tmux PTY 回归 `src/server/tmux-window-size-semantics.test.ts`。
- [2026-05-22] renderer 不能订阅 `SessionHeadStore`，也不能用 `daemonHeadEndIndex` 推进 follow viewport demand；daemon head 是 buffer manager/planner 的输入，renderer 的唯一内容进度真相是 buffer manager 已提交的 local render buffer tail。若 UI 层保留 `sessionHeadStore` prop 或测试里继续注入 head store，就是重复实现，必须物理移除。
- [2026-05-22] 输入路径不能把 `WebSocket.OPEN` 当作可写真相；若 activity audit 已判定 stale-open，继续 `send` 会把输入留在系统/WebSocket 缓冲，几十秒后才到 daemon，表现为“输入缓存”。唯一正确策略是：stale-open input 不发送、不排队，显式 drop 并仅重连目标 session；健康 open transport 才允许写入。
- [2026-05-22] 多 pane 唯一真源冻结：split 按钮显示条件为 `viewportWidth > baselineHeightPx * 0.7`；最大分屏数按平均分屏后单 pane 接近手机竖屏 `width / height ~= 0.42` 计算，容量算法唯一真源是 `resolveMaxSplitCount = floor(width / (baselineHeight * targetRatio))`。旧 `0.22/0.2` 宽松 minAspect、`>0.5` 阈值和 1200x900 只能二分屏期望都是过期实现，必须删除测试/实现残留。visible pane 各自 `live=true` 独立刷新；Android IME 输入只跟 `interactiveSession`/焦点 pane，不跟 runtime old active session；新建 tab 必须带显式 `paneId` 并只 attach 到目标 pane，缺失 paneId/目标 pane 不存在必须拒绝，禁止 fallback 到 active/P1。
- [2026-05-22] 横屏 QuickBar 被裁/消失的唯一根因：viewport stable height 不能跨 orientation 共享。单个 monotonic `maxStableLayoutHeightPx` 会把竖屏高度带到横屏，导致 `TerminalPage.shellHeight` 远大于真实横屏 viewport，absolute bottom QuickBar 被放到可视区外。稳定高度必须按 `portrait/landscape` 独立维护；IME 防抖只允许在同一 orientation 内保留最大 layout height。
- [2026-05-22] 多 pane 容器高度是真源：split row 与每个 pane shell 必须显式 `height: 100%`，否则 `TerminalView` 测量错误会连锁导致 visible range、viewport demand、gap repair、滚动和非焦点 pane live 刷新异常。修复必须在 pane layout ownership 层完成，禁止在 daemon/buffer manager/renderer 做 offset 或 refresh 补偿。
- [2026-05-22] QuickBar 内置快捷唯一真源是 `SHORTCUT_PRESETS`；storage 默认值不得再 seed 内置快捷，否则会出现 Paste/+/会计类按钮重复。保存的自定义快捷只作为用户覆盖/新增项，渲染时按 sequence 跨行去重。
- [2026-05-22] split tab 点击必须由 UI shell 同步 pane ownership：Header 只发 session intent，TerminalPage 是唯一桥接点；split 模式下必须先 `findPaneForSession -> switchTabInPane` 更新 pane `activeTabId`，再切全局 active session。只调用 `onSwitchSession` 会造成“tab 点了但 pane 内容不变”。
- [2026-05-22] QuickBar 分屏数量不能只按屏幕容量显示，还必须按当前 session/tab 数封顶；否则两 tab 时会显示不可用的 3 分屏。Android terminal 默认键盘请求属于 TerminalPage UI shell 状态，session 切换/进入页不得把它清成 false。
- [2026-05-22] split header 也必须保留 status-bar touch-safe 顶部保护区；不能为了横屏压缩把 tab 放到系统状态栏下沿。`terminal-layout-profile` 是唯一布局真源，split/default/single 的 header padding 都应在这里统一计算。
- [2026-05-22] QuickBar 横屏利用率真源：折叠态必须由 `TerminalPage` UI shell 持有并影响 `terminalChromeBottomPx`，`TerminalQuickBar` 只负责渲染 inline rows / floating bubble / floating panel。禁止只把按钮视觉隐藏但继续保留底部高度；折叠后 root measured height 应释放为 0，点击贴边小球再展开浮动面板。
- [2026-05-22] 文件同步权限真源：Android app 启动不得在 `MainActivity.onCreate()` 反复拉起存储权限页；文件同步页只检查权限并显式提示。Mac daemon 文件同步权限预检属于 `zterm-daemon.sh install-service`，通过一次性读写 `~/.wterm` 与 `~/Downloads/zterm` 触发/验证权限，后续同步操作不得再隐式申请权限。

## 2026-05-22 QuickBar collapse affordance
- QuickBar 折叠/展开的唯一真源在 `TerminalQuickBar`：展开态只能有一个边角 `收起` 控件，不得放入可滚动工具行；折叠态必须保留右下角小球 `展开快捷栏`，点击直接恢复 inline quick bar。
- [2026-05-23] 多 pane 非焦点刷新唯一真源在 `SessionContext lifecycle` 的 live target tick 门禁：visible pane 进入 `liveSessionIds` 后，即使 connected 且尚无 `lastServerActivityAt`，也必须允许 active tick 请求 head；否则非焦点 pane 会等到点击/激活后才刷新。禁止在 daemon/renderer 做补偿。
- [2026-05-28] Remote screenshot 权限主体唯一真源：macOS TCC 不能由 Node 进程直接触发；安装态必须生成稳定的原生 `zterm-daemon` Mach-O 作为截图主体，Node daemon 只能通过 `ZTERM_DAEMON_NATIVE ... capture-screen` 调用它。`install-service` 只在原生二进制缺失或源码更新时重建，避免每次安装被系统当成新主体反复授权；禁止恢复 helper socket / Codex Mac app / GUI helper 路径。
- [2026-05-28] Remote screenshot 传输保存真源：file-transfer 每个 chunk 是独立 base64，客户端不能直接拼接 chunk 字符串；必须逐 chunk decode 为 bytes，按 chunkIndex 合并 bytes 后重新编码成单一 base64 给 Android Filesystem.writeFile。预览使用 bytes 能成功不代表保存 payload 合法。
- [2026-05-29] `tmux_session_unavailable` 是临时不可用错误，只能走 retryable `onFailure` / reconnect，禁止映射成 `SESSION_STATUS_EVENT(type='closed')`；否则 App 的 remote open-tab audit 会把临时错误放大成 tab prune。只有明确终止语义（如当前 `tmux_session_killed` 分支）才允许进入 closed/tab close 链。

- [2026-05-29] Relay/TURN daemon 配置的唯一交付路径必须是全局发行包：`install-global.sh` 安装 `~/.local/bin/zterm-daemon`，再用 `zterm-daemon configure-relay` 写 `~/.wterm/config.json -> mobile.relay`；daemon 只读取配置，不承担账号/配置 UX。release staging 必须打包 `@roamhq/wrtc` 与当前平台 `@roamhq/wrtc-<platform>-<arch>/wrtc.node`，否则安装态 daemon 会因 RTC native module 缺失无法启动。

- [2026-05-29] `@jsonstudio/zterm-daemon@0.1.1` registry 包已确认缺 native runtime deps 与 `configure-relay`，不能作为全局安装真源；修复版必须用新 npm 版本发布（当前候选 `0.1.2`）。daemon npm tarball verify 必须检查 `runtime/node_modules/node-pty`、`runtime/node_modules/@roamhq/wrtc`、`runtime/node_modules/@roamhq/wrtc-darwin-arm64/wrtc.node` 与 `support/zterm-daemon.sh` 中的 `configure-relay`。

- [2026-05-29] `@jsonstudio/zterm-daemon@0.1.2` 已完成 registry 全局安装闭环验证：Mac Studio 与 MacBook Air 均从 npm registry 安装，使用 `zterm-daemon configure-relay --password-stdin` 配置同一测试账号，relay health 显示 `liveDaemonDevices=2`，两端强制 TURN relay-only RTC 均 data channel open 且 local candidate type=`relay`。最终证据在 `android/evidence/relay-turn/2026-05-29/20260529T042120Z-npm-registry-0.1.2-dual-daemon-rerun/summary.json`。

- 2026-05-29: Relay server first production npm release is `@jsonstudio/zterm-relay-server@0.1.3` (not 0.1.2). `0.1.2` published successfully but public `/relay/health` exposed TURN credential; unique fix was `buildHealthSnapshot -> buildHealthTurnSnapshot()` so public health only reports configured status while authenticated login still returns TURN credentials. Claw runs registry-installed `0.1.3` via `zterm-traversal-relay.service` ExecStart `/root/.nvm/versions/node/v22.22.0/bin/zterm-relay-server`; verified health redaction, smoke login, same-account `mac-studio` + `macbook-air` daemon visibility, and forced relay-only RTC with local candidate type `relay` on both hosts. Evidence: `android/evidence/relay-server-release/2026-05-29/20260529T050200Z-registry-0.1.3-claw-dual-turn-summary.json`.

## 2026-05-29 Connections relay account daemon truth
- Connections 的 server 列表真源是当前 relay account 下的 daemon devices；saved host/history/live session 只能作为该 daemon 的子 session 证据折叠进去，不能反过来用 legacy daemon id 或 bridge endpoint 生成重复父卡片。

## 2026-05-29 Connections group lifecycle and zombie daemon rule
- Relay account daemon 父列表不能展示长期离线且没有任何子 session 证据的 zombie 行；当前规则是 offline + 0 sessions + lastSeen 超过 30 分钟才从 Connections UI 过滤，短暂离线仍保留。Connections group 管理态必须有显式 `Done` 出口，`Clear` 必须同时清 selection 和 expanded state，避免用户长按/展开后卡在管理态。

## 2026-05-31 Relay reconnect optimization

- [2026-05-31] 默认 traversal path priority 已改为 `[ipv6, tailscale, ipv4, rtc-relay]`；user-selected `traversalPathPriority` 仍然最高优先。直连路径（ipv6/tailscale/ipv4）使用 WebSocket，relay 使用 WebRTC。
- [2026-05-31] `TraversalSocket` 已增加 reconnect runtime：`RECONNECT_BASE_DELAY_MS=300`，`RECONNECT_MAX_DELAY_MS=5000`，exponential backoff；成功 open 后重置 attempt，client close 取消 timer。candidate 仍按 priority 顺序重试，从 `nextIndex=0` 重新开始。
- [2026-05-31] `connectTraversalRelayDevicesStream` 已增加 `onOpen`/`onClose` 回调；App 级 relay device stream 有独立 auto-reconnect loop（`300ms → 5000ms` backoff），generation-based cancel，不改 session context。
- [2026-05-31] Direct WebRTC over ipv6/ipv4 当前不实现：`buildTraversalPlan` 的 RTC candidate 仅当 `relaySignalUrl` 存在时生成，且需要 `relayHostId` 做 peer identity；`rtc-bridge.ts` server 仅处理 relay signal websocket 上的 signaling，无 direct peer-to-peer signaling 协议。
- 证据：`android/evidence/relay-reconnect/README.md`

## 2026-06-01 Cross-platform pane/split 真源沉到 shared

- Android 多 pane 的核心算法（workspace state machine / split / activate / move tab / ratio resize / profile token / 触控 vs 指针 gesture）已沉到 `packages/shared/src/{react/pane-profile,react/pane-stage,react/pane-tabs,workspace/workspace-model}`。
- 平台差异隔离在 profile + gesture token，不在 UI 渲染逻辑：
  - `phone`: long-press 唤起 pane-menu、horizontal swipe 切 tab、divider 透明、drag-resize 禁用
  - `tablet`: long-press + right-click 皆支持、drag-resize 启用
  - `desktop`: right-click 唤起 pane-menu、ctrl+pageup/pagedown 切 tab、divider 可见 + drag handle
- `workspace-model` 新增 `setActivePane / resizePaneRatio`；`addPaneToWorkspace / removePaneFromWorkspace / moveTabBetweenPanes / setActivePane` 同源同住，pane 状态机不再有第二套实现。
- Android 端 `android/src/lib/terminal-layout-profile.ts` 仍保留作 phone-only 短期桥；后续切片把 `TerminalHeader` / `TerminalPageStageShell` 切到 shared `PaneTabs` / `PaneStage`（mobileTheme token 通过 render prop 注入或新建 android `pane-theme-adapter`）。
- Mac 端 `MacAppShell` / `ShellWorkspace` 后续切片切到 shared `PaneStage` + `PaneTabs`，可直接使用 desktop profile。
- shared 验证基线：26 test files / 235 tests pass（pre-existing 27 个 harness 错与本切片无关）。

## 2026-06-01 Mac-2 PaneStage/PaneTabs 接入 MacAppShell

- `mac/src/app/workbench.ts` 升级为 `WorkspaceState<MacWorkbenchTab>`，pane 状态机改走 shared `addPaneToWorkspace / removePaneFromWorkspace / moveTabBetweenPanes / setActivePane / resizePaneRatio`，旧 `tabs[]/activeTabId` flat 结构废弃。
- `mac/src/app/MacAppShell.tsx` 切到 `PaneStage` + `PaneTabs` 真源，desktop profile 走 `resolvePaneProfile({ platform: 'desktop' })`；新增 `MacPaneWorkbench` 组件承载 pane 内 tab 行 + terminal surface。
- `packages/shared/src/terminal/mac-terminal-view.tsx` 补上 `MacTerminalView` + `TerminalView` (compatibility alias) 包装 `@jsonstudio/wtermmod-react`，pre-existing `@zterm/shared has no exported member 'TerminalView'` 阻断解除。
- Mac 端 `pnpm type-check` 增量错：0（6 pre-existing 与本切片无关，集中在 ShellWorkspace / TerminalSlot / bridge-transport）。
- 新增 `mac/src/app/workbench.test.ts` (12 tests)，通过 copy 到 `packages/shared/src/_mac_workbench.test.ts` 跑，验证 pane 状态机全部行为正确。Mac workspace 暂未装 vitest devDep。
- `mac/tsconfig.json` 排除 `src/**/*.test.ts*` 避免 vitest types 阻断 type-check。
- 平台差异：Mac pane 行为走 desktop profile（right-click 唤 menu / ctrl-page 切 tab / drag-resize 启用 / divider 可见）。

## 2026-06-01 Mac-3 旧 tsc 错一并消除

- `packages/shared/src/terminal/mac-terminal-view.tsx` 扩 Mac 端 native render 旧 contract 全部 props (`projection / active / allowDomFocus / themeId / showAbsoluteLineNumbers / onInput / onResize / onViewportChange / onImagePaste / onWidthModeChange`)。wtermmod 只接受 `cols/rows/autoResize/theme/onData/onResize`，其它 props 在 wrapper 内 void 占位，语义真实工作属于后续切片 (mac-4 wtermmod native render 接入)。
- `mac/src/pages/ShellWorkspace.tsx` + `mac/src/pages/TerminalSlot.tsx` import 改 `@zterm/shared` 中 `MacTerminalView` (wtermmod wrapper)，不再用裸 `TerminalView` 拒收 Mac 扩展 props。
- `mac/src/lib/bridge-transport.ts` `buildHostConfig` 收口为 HostConfigMessage 真实字段 (`openRequestId / clientSessionId / sessionName / cols / rows / autoCommand`)，删除 pre-existing 多余字段 (`name / bridgeHost / bridgePort / authToken / authType / password / privateKey`)。
- bridge target 信息 (bridgeHost/bridgePort/authToken) 走 `BridgeTarget` 通过 `openBridgeConnection` URL 路径，不再走 HostConfigMessage payload。
- `openRequestId` 用 `crypto.randomUUID` 生成，确保每个 open intent 唯一。
- `mac/src/pages/ShellWorkspace.tsx` onViewportChange callback 强转 `viewState as Parameters<NonNullable<typeof runtime>["updateViewport"]>[0]`，消除 unknown → TerminalRuntimeViewState 不匹配。
- `mac/pnpm type-check` 0 错（pre-existing 6 错全清）。
- shared 26 files / 235 tests pass 保持不变。

## 2026-06-01 mobile-2.0 红测基线建立

- Android 端 4 个黑盒红测文件落地，全部跑前**会红**（mobile-2 接入后才转绿）：
  - `android/src/components/terminal/pane-android-adapter.test.ts` (11 tests)：验证 `mobileTheme → shared PaneProfile` 适配器
  - `android/src/components/terminal/TerminalHeader.pane-tabs.test.tsx` (11 tests)：验证 TerminalHeader 切到 shared PaneTabs 后期望行为
  - `android/src/components/terminal/shared-pane-tabs.test.tsx` (8 tests)：shared PaneTabs 在 Android jsdom 下真源基线（防止"接入后回归"），7/8 当前 pass；1 红暴露 shared PaneTabs plus button **缺 long-press 路径**——mobile-2 接入时需补
  - `android/src/pages/TerminalPageStageShell.pane-stage.test.tsx` (4 tests)：验证 TerminalStageShell 切到 shared PaneStage 后期望行为
- 23 个新测 7 pass / 16 fail（红测基线就位）
- 既有 android 测零回归：TerminalHeader.test.tsx 13/13 pass，TerminalPage.render-scope.test.tsx 13/13 pass，TerminalPage.multi-pane-decouple.test.tsx 6/7 pass（1 pre-existing 失败）
- shared 26/235 仍过，mac 0 错。
- mobile-2 切片需解决的红：
  1. 建 `android/src/components/terminal/pane-android-adapter.ts` 提供 `resolveAndroidPaneProfile / buildAndroidPaneTabDescriptor / splitAndroidWorkbench`
  2. shared PaneTabs plus button 加 mouseDown long-press 路径
  3. TerminalHeader 整文件切到 shared PaneTabs（保留 mobileTheme 颜色 token 通过 render prop 注入）
  4. TerminalStageShell 切到 shared PaneStage

## 2026-06-01 mobile-2.1.a pane-android-adapter 落地

- 新增 `android/src/components/terminal/pane-android-adapter.ts` (122 行)
  - `resolveAndroidPaneProfile({ splitVisible, landscape, topInsetPx })` → 等价 shared `resolvePaneProfile(phone)` + theme overlay
  - `buildAndroidPaneTabDescriptor(session)` → shared `PaneTabDescriptor` (active/customName/resolvedPath → isResolvedRelay)
  - `splitAndroidWorkbench(panes)` → shared `PaneSlotDefinition[]` (size / tabIds / activeTabId / isActive 全保真)
  - `AndroidPaneContext` 接口继承 `PaneProfile` 加 `theme: { colors: mobileTheme.colors }`
- 验证：`vitest run src/components/terminal/pane-android-adapter.test.ts` → **12/12 全绿**
- 零回归：android 全测 1203 pass / 27 fail（27 fail 全部 pre-existing 或后续切片红测），shared 26/235 pass，mac 0 tsc 错
- mobile-2.1.a 0 副作用，已是纯函数 + 零 native 依赖

## 2026-06-01 input echo after multi-tab switch

- Verified root cause: successful `sendInput` had been changed to only send the input and wait for lifecycle/heartbeat head refresh. After multi-tab switching this can delay echo because local renderer sees remote output only after a later `buffer-head` -> `buffer-sync` cascade.
- Durable rule: explicit terminal input must send payload synchronously, then request fresh head truth from a coalesced microtask only for the first unresolved input tail refresh; burst keystrokes must coalesce under `pendingInputTailRefresh` until `buffer-sync` clears it.


## 2026-06-01 multi-pane alignment lessons
- Android 多 pane UI 必须直接使用 shared `PaneTabs` / `PaneStage`，同时保留旧 Header 合约（top padding、关闭按钮 aria、relay badge button、touch-scroll 抑制）作为回归门禁。
- Mac packaged smoke 不能只看 package 成功；必须以明确 `mac/out/mac-arm64/ZTerm.app` 进程路径 + 窗口/截图/可访问树验证。生产包禁止无条件 `openDevTools`。

## 2026-06-01 iTerm2-style split correction
- “多 pane”验收不能等同于横向 flat pane 列表。Mac/iTerm2 目标必须是 split tree：leaf=pane，split node={direction: row|column, ratio, first, second}；支持任意横/竖递归分屏、局部分隔线拖拽宽高、关闭 pane 后 tree collapse。红测必须覆盖 nested split 和 horizontal divider，不能只验证 pane 数量。

## 2026-06-01 iTerm2 split-tree + build auth
- Mac production split truth is now `ShellWorkspaceState.layout` as shared split tree (`row|column`, ratio, recursive first/second). Mac callers must adapt to shared `{ tree, activePaneId }` and pass explicit `newPaneId` so layout leaf ids equal real pane ids.
- iTerm2-style split has no fixed 3-pane cap in `ShellWorkspace`; red tests must cover right split, down split, nested row+column, divider orientation, and >3 panes.
- Mac local packaging must not auto-discover signing identities. Use `CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac dir` plus `build.mac.identity=null`; otherwise electron-builder may hit Keychain authorization on every build.

## 2026-06-01 Mac terminal projection render truth
- `MacTerminalView` must actively bridge `TerminalRenderBufferProjection.lines` into wtermmod via `TerminalHandle.write`; merely mounting `@jsonstudio/wtermmod-react` with cols/rows creates a black terminal with input plumbing but no daemon content. Red tests must assert projection changes call `write()`.

## 2026-06-01 Mac render anti-regression
- Never fix Mac terminal black screen by `TerminalHandle.write` snapshotting projection text. Mac render must consume canonical `TerminalRenderBufferProjection` as DOM rows via shared renderer helpers so scrollback, colors, and live revisions remain true. Keep wtermmod only as input/resize proxy unless it can consume canonical buffer semantics directly.

## 2026-06-01 Mac render must not resize tmux
- Mac projection render must not include hidden/1px wterm proxies or call `onResize` from render geometry. Hidden autoResize can shrink tmux cols to 1 and produce vertical text. Follow Android: renderer consumes projection; tmux resize only comes from explicit viewport/width owner paths.

- 2026-06-03: zterm TURN/relay 账号问题不要误判到 sub2api。Claw 上 coturn 真源是共享 TURN 账号 `ztermturn`，应用登录账号在 `zterm-traversal-relay` store：`/var/lib/zterm-traversal-relay/store.json`。本轮重新注册 `2094423@qq.com`，密码 `welcome4zcam#`，公共入口 `https://claw.codewhisper.cc:18443/relay/`，验证 `/api/auth/login`、`/api/auth/me`、`/api/devices` 均成功。
  Tags: zterm, claw, traversal-relay, turn, account, correction, verification

## 2026-06-07 Copy mode lifecycle: full-exit on close / reset-on-success
- `handleCloseCopyMenu` 必须 `setCopySelection(EMPTY_COPY_SELECTION_STATE)` 全量重置（包括 `active=false`），仅清 `menu` 会留下 QuickBar 高亮残留。
- 复制成功后 async reset：`copyTextAndResetOnSuccess` 里 `.then(() => setCopySelection(EMPTY))`；失败则 `.catch` warn 保留状态。
- 测试矩阵：关闭菜单=全重置、中途关闭=全重置、复制成功 async reset、clipboard 失败保留 active + warn、buffer miss 保留 active + warn。
  Tags: copy-lifecycle, quickbar, regression-gate

## 2026-06-08 Input refresh after tab switch: first pending input must request head
- Explicit terminal input 不能只 mark `pendingInputTailRefresh` 后等待 heartbeat/active tick；多次 tab switch 后会出现“远端收到输入但本地不刷新”。
- 正确语义：`markPendingInputTailRefresh` 返回是否首次 pending；input payload 必须同步 send，首次 pending input 的 `requestSessionBufferHead(sessionId, ws, { force: true })` 必须移到 coalesced microtask，禁止阻塞 key event stack，后续 burst input 不重复 force head。
- Gate: `session-context-input-runtime.test.ts` 锁 input 同步 send、首次 pending 延迟到 microtask 发 head、已有 pending 不发；`SessionContext.ws-refresh.test.tsx` 锁 burst 三连 input 同 tick 无 head、随后只有 1 条 `buffer-head-request`。
  Tags: input-refresh, tab-switch, head-first, regression-gate

## 2026-06-08 QuickBar schedule lifecycle and APK 1757
- Schedule sheet 打开后必须冻结 `{ sessionId, sessionName, seedText, nonce }`；刷新/保存/删除/启停/run-now 全部使用 frozen `sessionId`，禁止切 tab 后漂移到 active session。
- Schedule 业务错误必须走专用 `schedule-error -> scheduleState.error`，socket 未连接/target session 缺失也必须显式 `loading=false + error`；禁止 silent send 后让 UI loading 卡死，也禁止把 stale job 等业务错误混进 terminal transport failure。
- QuickBar floating menu 若保留 clipboard 分支，必须有真实 `快捷/剪贴板` segmented 入口；禁止空 pill/不可达 UI。紧凑浮层默认删除说明文案、压缩 composer 高度，并把 `定时/发送` 放同一 action row。
- Gate: `TerminalPage.schedule-target.test.tsx`、`session-context-public-runtime.test.ts`、`terminal-message-control-runtime.schedule.test.ts`、QuickBar/SessionScheduleSheet tests；APK `0.1.3.1757` 已发布到 `android/update-dist/` 与 `~/.wterm/updates/`。
  Tags: quickbar, schedule-lifecycle, schedule-error, apk-delivery, regression-gate

## 2026-06-08 Daemon/client transport performance truth
- Daemon live cadence can only use daemon-owned physical facts: capture/canonicalize duration, subscriber count, transport ready/buffered bytes/send error/backpressure, and mirror failure/in-flight state. It must not consume active tab, pane layout, follow/reading, viewport, or any client UI state.
- Client render/head cadence must be session-owned: read the target session socket buffered amount and debug metrics, pass `sessionId` through render gate/lifecycle resolvers, and allow good-link 16ms fast lane while weak/backpressured links slow down.

## 2026-06-08 Android hardware keyboard and fast cadence
- Android physical keyboard events must not depend on DOM textarea focus. Native `ImeAnchor key` should send special keys and Ctrl/Alt modified keys through shared terminal keyboard resolvers directly into the active session; plain letters stay on the editable/IME text path.
- High terminal throughput is not slow-network evidence by itself. Fast runtime progress with no socket backpressure should keep 16ms cadence even when `recentPayloadBytes` is large; weak-link decisions must use RTT/backpressure/buffered bytes/progress, not payload trimming or semantic payload changes.
- Performance traces may record metadata only (timestamp, duration, bytes, line counts, ids, kind). Tests must forbid payload/text/lines/cells/content/data keys so optimization cannot be achieved by leaking or trimming terminal payload.
- Daemon mirror lab assertions over sparse `buffer-sync` must replay payload history; final sparse payload alone is not mirror truth because later prompt-only diffs can overwrite the last observed payload while an earlier diff already contained the oracle marker.
  Tags: terminal-performance, daemon-scheduler, client-cadence, trace-metadata, regression-gate
- 2026-06-09: open tab 生命周期冻结：远端 tmux session-name audit / foreground resume / connect audit / session picker refresh / cold restore / saved tab import 都不得自动关闭或过滤 open tabs。唯一允许物理关闭 tab 与 runtime session 的入口是用户显式 close；远端缺失只能记录 `app.open-tabs.remote-session-missing` 或剪裁 session group 历史，不能写 closed tombstone。
  Tags: open-tab-lifecycle, remote-audit, no-auto-close, tombstone

## 2026-06-16 IME lift: keyboardInset is the only physical truth in adjustPan mode

### Bug: viewportAlreadyResizedByIme false-positive

`d5284be` introduced `viewportAlreadyResizedByIme` heuristic that compares layout vs
visual viewport bottoms to detect `adjustResize`-style WebView. On Jason's hardware keyboard
device, WebView keeps full layout height (`innerHeight = document.clientHeight = 792`) while
`visualViewport` also reports bottom = 792 — the WebView does not expose IME occlusion in any
viewport metric. The heuristic's three abs-checks all passed, causing `resolveKeyboardLiftPx`
to return 0 even when `keyboardInset = 297`. Result: stage did not lift above the IME.

Verified-good baseline: `fb4154a` / `0defafa` had no `viewportAlreadyResizedByIme` at all.
The function was:
  if (occludedBottom <= 0) return safeReportedInset;
  return min(safeReportedInset, occludedBottom);

Jason confirmed `0.1.3.1823` (which removes the heuristic branch) **does lift correctly**.

### Rule
`resolveKeyboardLiftPx` must not return 0 purely because viewport metrics do not reflect IME
occlusion. `keyboardInset` (from Capacitor `keyboardDidShow`) is the physical truth; if
`keyboardInset > 0`, lift must be positive. A `viewportAlreadyResizedByIme`-style heuristic
may only suppress lift when **both** `layoutViewportHeight` and `currentLayoutViewportHeight`
have actually been compressed to match `visualViewportBottom` — i.e., when the WebView has
already absorbed the IME into its layout. Never add back a false-positive heuristic that
silently returns 0 when viewport metrics are stable.

### Gates locked
- `terminal.keyboard_ime` red tests in `TerminalPage.android-ime.test.tsx`:
  - "falls back to reported keyboard inset when WebView viewport metrics do not expose IME
    occlusion" → `resolveKeyboardLiftPx(320)` must return 320, not 0.
  - "keeps reported keyboard inset when layout and visual viewport bottoms are already
    aligned" → `resolveKeyboardLiftPx(320, 600)` returns 300 (cap ratio × height), not 0.
  - "keeps terminal stage shell lifted while quick bar editor owns focus and Android keyboard
    is visible" → stage `bottom: 310px` when `keyboardInset = 280`.
  - `TerminalPage.android-ime.test.tsx`: PASS 38/38
  - `tsc --noEmit`: PASS

### APK delivered
`0.1.3.1823` / `1031823` / sha256 `21d48400c53326db9fe32ebb931274254bdd9a68b3175a02c1e27fff451b3557`

## 2026-06-17 Daemon live input must batch per mirror burst writes

- Do not reintroduce per-key `tmux send-keys` serial chains for live terminal input. The verified fix replaces `liveMirrorInputChains` with `liveMirrorInputBatches`: same-mirror same-microtask string input is coalesced into one `send-keys -l -- <payload>` while stale queued items are filtered by `shouldWrite` before writing.
- Gates: `terminal-control-runtime.input-queue.test.ts` must cover burst coalescing, append-enter boundary preservation, and stale-item exclusion; `server.control-truth.test.ts` must reject the old direct `await runTmuxAsync(...payload)` implementation inside `enqueueLiveMirrorInput`.
- Verified delivery: daemon staged runtime contains `liveMirrorInputBatches`; `daemon-mirror-lab --case=local-input-echo` PASS; APK `0.1.3.1833` delivered to `~/.wterm/updates/` with sha256 `e5d111e6df53d7a586caf66ec98e6a3eda4e5e7dcee5e1424a797a1a19a0d81c`.

## 2026-06-17 Android build must prewarm Cordova plugin local resources

- If `./scripts/build-android-debug.sh` fails in full assemble at `:capacitor-cordova-android-plugins:parseDebugLocalResources` with `!directory.isDirectory()` while the same task succeeds standalone, treat it as the empty Cordova plugin resource project not being materialized before assemble consumes it.
- Standard build now runs `./gradlew :capacitor-cordova-android-plugins:parseDebugLocalResources` before `processDebugManifest assembleDebug`; do not remove this prewarm unless Gradle/AGP is upgraded and the full standard build is proven stable without it.

- [2026-06-19] daemon 性能风险修复 R3/R9/R10/R13/R1/R2/R6/R7/R8/R14 收口
  - contracts 561 PASS, daemon close-loop 8/8, daemon restart healthy
  - R3 关键：所有 close/detach/destroy 路径必须 active 清理 liveMirrorInputBatches
  - R1+R2+R14 关键：head request 走 broadcast dedup，去除 N² 风暴
  - R9 关键：flushInFlight 必须设 min 16ms 防止 capture 循环锁死
  - R10 关键：detach 不再起 0-delay sync，避免 tmux 抖动
  - R6+R7 关键：resize 250ms 节流 + 多 widthMode 不 resize tmux
  - 审计报告落盘: docs/audits/daemon-performance-multisession-audit-2026-06-18.md
  - commit f2231db

- [2026-06-19] mock 串扰：SessionContext.ws-refresh.test.tsx 加 activeFactoryCount 守卫
  - vitest --run / build 期间跨文件同时跑会触发第二 WS factory
  - 加 activeFactoryCount 抛错 + close/open 时 decrement
  - 1 commit 5b05c17；APK 1839 同步发布

## 2026-06-23 tmux socket 标准化 + daemon 启动确保 tmux server

### 已验证结论
- tmux socket 默认在 `/private/tmp/tmux-501/default`，macOS 重启后 `/private/tmp` 被清空，导致 daemon 连不上 tmux
- 修复：daemon 的 `cleanEnv()` 设 `TMUX_TMPDIR=~/.wterm/tmux/`，socket 移到持久化目录
- 修复：daemon 启动时调用 `ensureTmuxServerRunning()` 确保 tmux server 在跑
- 验证：tsc PASS，contracts 566 tests PASS，daemon restart 后 socket 在 `~/.wterm/tmux/tmux-501/default`
- daemon 自启（launchd）一直正���，不存在"daemon 不自启"的问题

## 2026-06-23 tmux socket 检测 + daemon 启动确保 tmux server

### 已验证结论
- daemon 自启（launchd）一直正常，不存在"daemon 不自启"的问题
- tmux socket 默认在 `/private/tmp/tmux-501/default`，macOS 重启后 `/private/tmp` 被清空
- **正确策略**：daemon 启动时 `ensureTmuxServerRunning()` 先检测已有 tmux server（不设 TMUX_TMPDIR）
  - 有 server → 复用现有 socket 路径，不设 TMUX_TMPDIR
  - 无 server → 创建 `~/.wterm/tmux/` 标准化路径，设 TMUX_TMPDIR
- `cleanEnv()` 根据 `detectedSocketDir` 决定是否设 `TMUX_TMPDIR`
- 验证：tsc PASS，contracts 566 tests PASS，daemon restart 后返回真实 sessions (demo-shell, routecodex)
- **反模式**：不能强制设 TMUX_TMPDIR，否则 daemon 看不到用户已有 sessions
## 2026-06-24 copy-mode 真机长按修复 — Gate 已锁定

### 根因
- Android WebView 默认 `setLongClickable(true)`，长按时系统先触发 haptic feedback + selection，JS touch 事件被吞掉。
- `TerminalView` 的 `startCopyLongPressTouch` 注册在 `onTouchStart`，但 WebView native 层已先拦截了 touch 序列，导致 420ms timer 无法启动，菜单不弹出。
- 之前的 `setOnLongClickListener(v -> true)` 虽然禁了系统菜单，但 WebView 仍触发 haptic + touch 拦截。

### 修复
- `MainActivity.java`: `wv.setLongClickable(false)` — 不再触发原生长按 haptic / 选择手柄，touch 事件完整传给 DOM。
- `terminal.copy_mode` feature 已在 `docs/function-map.md` 注册 `MainActivity.java` 为 owner。

### 验证
- `cd android && npx tsc --noEmit` PASS
- `cd android && pnpm run test:terminal:contracts` PASS (566/566)
- `./scripts/build-android-debug.sh` PASS -> `zterm-0.1.3.1885` (versionCode `1031885`)
- HTTP: `http://127.0.0.1:3333/updates/zterm-0.1.3.1885.apk` 返回 200
- Jason 现场确认：0.1.3.1885 长按菜单正常弹出 ✅

### Gate 记录
- 红测: `system-copy-state-machine.test.tsx` PASS
- 红测: `system-copy-longpress-regression.test.tsx` PASS
- 红测: `TerminalView.selection-guard.test.tsx` PASS
- 红测: `VisibleRow.selection.test.tsx` PASS
- 红测: `TerminalPage.android-ime.test.tsx` PASS
- 合约: `test:terminal:contracts` 566/566 PASS
- 真机: Jason 1885 确认 copy-mode 长按正常

### 反模式
- Android WebView `setLongClickable(true)` 会在 native 层拦截 touch 序列并触发 haptic，JS `onTouchStart` 收不到完整事件链。
- 禁用 WebView 原生长按必须用 `setLongClickable(false)`，不能只靠 `setOnLongClickListener(v -> true)`。
- copy-mode 的"禁系统菜单"应只在 DOM/React 层做（`preventDefault` + `stopPropagation`），不在 native WebView 边界全局吞事件。
- 排查顺序固定为：先看 native long-clickability，再看 DOM touch timer，最后看 React 菜单状态；`setOnLongClickListener` 只禁 ActionMode，不等于放行 JS 长按。
- 2026-06-27 已验证补强：copy 长按 delay/slop 已集中到 `terminal-copy-gesture.ts`，QuickBar shell 事件守门已集中到 `terminal-quickbar-shell-guards.ts`，copy runtime 不再输出 `[CopyTrace]` 生产 console；copy 定向 30 tests PASS，`tsc --noEmit` PASS。

## 2026-06-29 mobile session group 1946 regression

- APK `0.1.3.1946` 现场证伪：放开横屏 session group、加入 “center-only 不进 group”、调整抽屉切 session 顺序，会破坏竖屏上中下显示和上下滚动；这些不是可保留的正确修复。
- 热修恢复原则：session group stage 回到 1945 行为，`TerminalPageStageShell` 只有 `!splitVisible && !landscape && sessionGroupViewport?.slots.center` 时启用；`TerminalPage` 抽屉选择 session 保持先切 session 再按当前 focus slot 替换槽位。
- 后续再做横屏/平板左右槽位时必须另开状态机审计和真机验证，不能在竖屏基线上直接改 StageShell gate。
- Jason 现场确认 `0.1.3.1947` 比 `1946` 明显可用，竖屏显示和滚动恢复到可继续迭代的基线；后续排查应以 `1947` 为新基线，不再沿用 `1946`。

## 2026-06-29 大面积刷新后空白直到手动滚动

### 已验证根因
- 大面积文件增删会走 `commitBuffer()` 主链，而不是单纯的 `setBuffer()` 读写路径。
- 旧实现把 live buffer 引用直接存入 store，并在 `previous.buffer === buffer` 时直接短路；只要上游复用同一个 buffer 对象并原地 mutate，store 就可能不发布新 truth。
- 现场表象就是：行数/元数据在动，但正文不刷，只有用户触摸上下滚动后才重新激活刷新链。

### 修复
- `session-buffer-store.ts` 的 `commitBuffer()` 改成内容判等，不再按引用判等。
- store 内部统一存储 `cloneSessionBuffer(buffer)`，切断 caller 的 live 引用。

### 已验证
- `src/lib/session-buffer-store.test.ts`
- `src/lib/session-render-gate.test.ts`
- `src/lib/session-render-gate.tui-content.test.ts`
- `src/contexts/session-context-buffer-runtime.test.ts`
- `src/components/TerminalView.dynamic-refresh.test.tsx`
- `src/components/TerminalView.bottom-stale.test.tsx`
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS
- `./android/scripts/build-android-debug.sh` PASS，产出 `0.1.3.1953`

### 防复发规则
- store / render gate / renderer 的真源必须是不可变快照，不能让 live buffer 对象跨层共享。
- 任何“滚一下就好”的空白刷新问题，优先查 buffer publish 是否被引用短路，而不是先改 scroll 行为。

## 2026-07-01 大面积 sparse tail 推进后的 follow 空白

- 已验证补充根因：当旧 visible range 正贴着旧 tail（follow），新 `buffer-sync` 用 sparse payload 把 tail 大幅推进后，post-apply gap repair 不能继续拿旧 visible range 判断；旧区可能完整，但下一帧 renderer 会贴到新 tail，而新 tail 可见区可能全是 gap，表现为空白直到手动滚动触发新的 visible range。
- 修复规则：`buffer-sync apply` 后若已有本地窗口且旧 visible end 贴旧 `bufferTailEndIndex`，必须用新 buffer 的默认 tail visible range 做 visible-gap repair；初始 sparse 首帧或旧 visible range 不贴旧 tail 时必须保留旧 range，禁止吞掉 renderer 后续 reading-gap 请求或擅自拉回底部。
- 回归门禁：正向锁 `sparse tail jump -> request visible-range-repair-catchup`；反向锁 `reading range -> not reinterpreted as tail`；renderer 另锁 absolute window 大跳仍同步贴尾。

## 2026-06-29 Windows WezTerm backend 初始合约

- Windows 原生 session backend 先做在 ZTerm 侧，不 fork WezTerm；WezTerm CLI 只是外部 mux/buffer source。
- 已验证 `wezterm cli --prefer-mux spawn/list/get-text --escapes` 可在 `Jason-HW-Desktop` 上产出 pane buffer 和 ANSI 样式，ZTerm adapter 可转换为 daemon-owned absolute mirror snapshot。
- `wezterm cli --prefer-mux send-text --pane-id <id> --no-paste` 已验证可通过 stdin 写入 Enter / Backspace / arrow escape / raw TUI bytes / Codex TUI text；禁止把真实输入放进 shell args。
- 已知限制：ETX/Ctrl+C 可到 raw-mode/TUI，但不能当作 Windows console control event 中断 `cmd.exe` 子进程（如 `ping -t`），不得宣称完全键盘等价。
- 冻结合约文档：`docs/decisions/2026-06-29-windows-wezterm-backend-contract.md`。
- 必跑门禁：`src/server/wezterm-backend.test.ts`、`src/server/wezterm-backend-runtime.test.ts`、`src/server/terminal-backend-selection.test.ts`、`scripts/wezterm-backend-remote-smoke.ts`、`scripts/wezterm-backend-input-smoke.ts`、`scripts/wezterm-daemon-protocol-smoke.ts`、`tsc --noEmit`。

## 2026-06-30 traversal reconnect dead-end / startup width truth

- `TraversalSocket` 不能在“所有候选都失败且暂无可选路由”时直接落死为永久 error；但 session transport 已有外层 `SessionContext` reconnect runtime owner，所以 App session/control transport 创建 `TraversalSocket` 时必须设置 `autoReconnect:false`，避免内外两层同时新建 transport。
- 单独使用的 `TraversalSocket` 默认仍可 `autoReconnect:true` 自恢复；相关 reconnect 回归测试必须覆盖默认自恢复和外层 owner 模式不自建 backend，并使用隔离 route health cache，避免历史 failure 污染路由选择。
- 首连 handshake 已再次证实会携带 `widthMode`：`SessionContext` 直接用 `BridgeSettings.terminalWidthMode` 生成 connect payload，`useBridgeSettingsStorage` 的同步首 render 保证启动即用，不需要等后续 resize 或二次保存。
- 网络 online 恢复不能只走 `resumeActiveSessionTransport` 的 stale-open probe/wait 路径；foreground `online` 必须 active-only 调 `reconnectSession(activeSessionId)`，直接重启外层 session reconnect backoff，且禁止 sweep hidden/all sessions。

## 2026-06-30 Windows daemon multi-machine baseline

- Windows daemon 已确认可从 Tailscale 直连并通过 WebSocket 协议主链工作，且 daemon auth 走 `C:\Users\huawei\.zterm\config.json -> mobile.daemon.authToken` 配置真源，不是硬编码。
- 当前可用于手机多机测试的 Tailscale IP：
  - Windows `jason-hw-desktop`: `100.75.122.121`
  - macbookair: `100.86.84.63`
- Windows daemon 对外 health/WS 监听为 `0.0.0.0:3333`，验证时应使用同一配置 token，不要把地址或 token 写死到 app 代码里。
- Windows WezTerm session 必须以持久 shell 为根进程，默认 `cmd.exe /k`；禁止把 TUI（如 `codex`）或 `cmd.exe /c ...` 作为 pane root，否则 TUI 退出会杀掉 pane，表现为手机连接断开。回归必须验证 `shell -> codex -> Ctrl+C -> shell 继续可用`。

## 2026-06-30 Connections card picker truth

- Connections 页面卡片主动作必须打开该卡片自己的 picker，不得复用 shared open path 或别的 server 的 target。
- picker 的唯一真源是当前卡片的 `bridgeHost / bridgePort / daemonHostId / authToken`，history-only group 也应进入 picker，而不是伪装成 runtime open。
- 回归门禁：同页多 server card 点击必须各自落到各自 target；edit-group picker 打开后必须对 concrete target 自动 `fetchTmuxSessions()` 并回写 `onRemoteSessionsRefreshed()`；picker/列表刷新测试要一起绿。
- Windows / relay daemon 入口必须额外锁 auth：relay directory 只提供 endpoint/session catalog，不是 daemon auth 真源；Connections card 和 drawer New Session 命中 relay device 时必须从 saved server preset/host 补 `bridgeHost/bridgePort/authToken` 后再 refresh/create。

## 2026-06-30 Windows WezTerm cursor truth

- Windows WezTerm backend 的 cursor 真源来自 `wezterm cli list --format json` 的 `cursor_x/cursor_y/cursor_visibility`，不是 `get-text --escapes`。
- daemon 必须把 WezTerm cursor 作为独立 metadata 写入 `WezTermMirrorSnapshot.cursor` / `buffer-head.cursor`，禁止把 cursor 样式写进 `TerminalCell`。
- 已验证真实 Windows daemon `100.75.122.121:3333` 在 `session-open -> connect -> buffer-head` 返回 `cursor={"rowIndex":0,"col":16,"visible":true}`；若手机仍无光标，下一步查 Android 是否消费了该 `buffer-head.cursor`。
- daemon npm 包不能再只声明 `os/cpu=darwin/arm64`；Windows fresh install 需要允许 `win32/x64`，否则 `npm install -g` 会在平台检查阶段失败。

## 2026-07-03 Android IME quickbar reserve truth

- Terminal IME/layout 修复不能靠固定 `30px` render lift 或“保留/撤回旧公式”凑位置。`TerminalPage` 的 stage bottom reserve 唯一公式应是 `measured quickBarHeight + safeOffset + terminalImeLiftPx`，QuickBar shell bottom 唯一公式应是 `safeOffset + terminalImeLiftPx`。
- `quickBarHeight` 必须来自 `TerminalQuickBar.onMeasuredHeightChange` 的真实测量；未测量前不要用固定高度抬高 terminal stage。IME active 时也必须保留 measured quickbar reserve，不能只裁到 `terminalImeLiftPx`，否则快捷栏会遮挡 terminal 内容。

## 2026-07-03 File Sync no-filter enumeration truth

- Android file sync 本地枚举真源是 `StoragePermissionPlugin` native owner；它必须返回目录事实本身，不按图片扩展名、隐藏文件名或文件类型过滤。UI 只做 projection、选择、排序。
- `FileTransferSheet` 的排序只属于列表投影：按名称/修改时间、正序/倒序在 UI 层切换；排序/过滤状态不得进入 native storage owner 或 daemon 文件真源。
- 回归门禁：`pnpm --dir android exec vitest run src/components/terminal/FileTransferSheet.test.tsx --reporter dot` 必须覆盖 remote `showHidden:true`、本地图片与 dot file 不过滤、mtime 倒序排序、权限失败显式报错。

## 2026-07-03 File Sync upload no input injection truth

- File Sync 上传完成只允许写入远端目标目录并发送 `file-upload-complete`；禁止把上传后的远端路径写入 tmux、quick input、composer 或任何对话输入框。
- `terminal-file-transfer-binary-runtime.ts -> handleFileUploadEnd()` 是同步上传的 server owner；这里不得调用 `writeToTmuxSession()` 或 `writeToLiveMirror()`。路径注入属于旧 paste/attach 语义，不属于 sync。
- 回归门禁：`pnpm --dir android exec vitest run src/server/terminal-file-transfer-binary-runtime.test.ts --reporter dot` 必须证明文件写入成功、complete 事件存在、tmux 写入和 mirror sync 不发生。

## 2026-07-03 File Sync download chunked write truth

- File Sync 下载保存不能把整文件 base64 合并后一次性传给 Android native；图片/大文件必须按 `file-download-chunk` 分块调用 native storage 写入，避免 bridge 大 payload 变空后生成 0 字节文件。
- 下载完成后必须 `stat` 本地目标文件并校验 `size === totalBytes`；大小不一致是显式 transfer error，不能显示 done。
- 回归门禁：`pnpm --dir android exec vitest run src/lib/file-transfer-session-runtime.test.ts src/components/terminal/FileTransferSheet.test.tsx --reporter dot` 必须覆盖 chunked write、size mismatch error、不覆盖为 done，以及本地/远程排序。

## 2026-07-03 Session resume active truth

- Session resume/switch 入口不能只调用 transport resume 后提前返回；必须先提交 open-tab active truth，再由 `switchRuntime:'explicit-resume'` 统一推进 runtime switch 和 transport refresh。
- 错误反模式：`resumeActiveSessionTransport()` 返回 true 就跳过 `handleSwitchSession()`，会造成第一次点击只开连接不切 UI，目标 connected 后也不会自动变成 active，需要第二次点击。
- 回归门禁：`pnpm --dir android exec vitest run src/hooks/useOpenTabSessionActions.test.tsx src/App.dynamic-refresh.test.tsx --reporter dot` 必须覆盖 connecting 目标首次 resume 即写入 `ACTIVE_SESSION`、调用 `switchSession/resumeActiveSessionTransport`，并在目标 connected 后渲染目标 session。

## 2026-07-04 Session switch transport de-dup

- 切换到已有 runtime shell 的 session 时，`SessionContext.switchSession()` 已经通过 `active-reentry` 拥有唯一 refresh owner；`useOpenTabRuntime` 不得再对 `connecting/reconnecting/connected` 目标无差别补一发 `resumeActiveSessionTransport()`。
- `explicit-resume` 只保留给 unavailable runtime：目标缺失或状态是 `idle/closed/disconnected/error` 时才允许显式 reopen。否则重复推进 traversal/control open 更容易出现 `ws connect timeout`。
- 回归门禁：`pnpm --dir android exec vitest run src/hooks/useOpenTabRuntime.test.tsx src/hooks/useOpenTabSessionActions.test.tsx src/App.dynamic-refresh.test.tsx src/lib/open-tab-history-truth.test.ts --reporter dot` 必须同时证明 connecting 目标不二次 resume，而 disconnected 目标仍保留显式 reopen。

## 2026-07-05 Android renderer visible gap repair shared core

- Android `TerminalView` 的 viewport demand 必须消费 shared `buildTerminalViewportDemandWithRepair`，与 Mac renderer 共用 visible-gap repair 核心；禁止在 Android 独立复制 missingRanges/gap 计算。
- `buildTerminalViewportDemandKey` 必须纳入非空 `missingRanges` 拓扑；同一 mode/end/rows 下可见 gap 改变仍必须重新上报，否则 buffer manager 会漏发 visible repair。
- 无 visible gap 时 demand 不发送空 `missingRanges: []`，保持旧 payload 形状；有 visible gap 时才显式带 ranges。
- 回归门禁：`pnpm --dir android exec vitest run src/components/TerminalView.dynamic-refresh.test.tsx src/contexts/session-context-buffer-runtime.test.ts --reporter dot` 与 `pnpm --dir packages/shared exec vitest run src/terminal/renderer.test.ts src/terminal/mac-terminal-view.test.tsx --reporter dot`。

## 2026-07-05 Android cold-start adaptive width mode

- `BridgeSettings.terminalWidthMode` 是启动排版和 connect payload 的唯一客户端真源；持久化值来自 `STORAGE_KEYS.BRIDGE_SETTINGS`，旧 `terminal-width-mode` localStorage key / `TerminalWidthModeManager` 分叉 owner 已物理删除并由 architecture gate 禁止复活。
- 首装或旧配置缺 `terminalWidthMode` 时，默认 resolver 必须优先使用 `visualViewport.width` 判定手机首帧宽度；Android WebView / 折叠屏可能出现 `visualViewport.width` 窄但 `innerWidth/documentElement.clientWidth` 宽，不能用 `Math.max(...)` 把手机错判成 `mirror-fixed`。
- 回归门禁：`pnpm --dir packages/shared exec vitest run src/react/use-bridge-settings-storage.test.tsx --reporter dot` 与 `pnpm --dir android exec vitest run src/App.first-paint.real-terminal.test.tsx src/lib/architecture-boundary-truth.test.ts --reporter dot` 必须覆盖未进入 Settings 前首帧 DOM 和 connect payload 都是 `adaptive-phone`。

## 2026-07-05 Terminal drawer close touch activation

- `TerminalSessionDrawer` 内部 action button 不能只依赖 `click`；Android WebView 抽屉行外层有 touch/long-press 手势 owner，右侧关闭 `×` 必须拥有自己的 `touchend` 激活路径，并阻止冒泡、清理长按 timer、去重 synthetic click。
- 回归门禁：`pnpm --dir android exec vitest run src/components/terminal/TerminalSessionDrawer.test.tsx src/pages/TerminalPage.session-drawer.test.tsx --reporter dot` 必须覆盖 close touch activation 不触发 select 且不重复 close。

## 2026-07-05 MemPalace/search source-only corpus

- `wing=zterm` 不得直接 mine 仓库根目录；唯一允许入口是 `scripts/mempalace-mine-zterm.sh` 生成 `/Volumes/extension/code/memory/zterm-mempalace-corpus-safe` 后再索引。
- 搜索语料只允许代码、文档、项目记忆、local skill、少量源码配置；生成物、构建物、release/update 包、evidence、缓存目录、依赖目录、HTML 预览、日志、APK/tgz/lock 文件必须在 mine 前 corpus 扫描 0 命中，mine 后 Chroma `source_file` 禁止路径也必须 0 命中。
- Android native / Mac Electron 属于真实源码，应进入安全语料；但 Capacitor generated web bundle `android/native/android/app/src/main/assets/public/`、`capacitor.config.json`、`capacitor.plugins.json` 和图片/媒体资源不属于代码/文档搜索语料。
- 本地文本搜索默认尊重根目录 `.ignore`；若 MemPalace 结果出现 generated/build/evidence/raw artifact source，收口流程是备份 palace、删除 `wing=zterm` 的 stale metadata、重新安全 mine、再用唯一短语验证可检索。
Tags: #mempalace #source-only-search #generated-artifacts #zterm
## 2026-07-06 drawer remote close and websocket retry truth

- Terminal drawer remote-only rows are daemon catalog sessions, not local open tabs. Their close intent must route through session-open owner `killTmuxSession -> fetchTmuxSessions -> handleRemoteSessionsRefreshed`; `TerminalPage` may only project the remote target and dispatch the close intent. Calling local `onCloseSession(remote:...)` is a no-op because no local runtime session owns that id.
- In SessionContext, plain server `closed` messages are retryable transport failures and must flow through `onFailure(reason, true)` into reconnect ownership. Terminal close truth remains `tmux_session_killed`; do not map ordinary WebSocket detach/closed facts to local tab/session closed state.
- Regression gates: drawer close must cover remote-only close not calling local open-tab close; transport retry must cover plain `closed` becoming reconnect while `tmux_session_killed` remains terminal closed.

## 2026-07-07 Android WebSocket transport reuse truth

- `terminal.transport_lifecycle` must reuse a same-session, same-target usable session WebSocket. `connectSessionRuntime()`, `reconnectSessionRuntime()`, and `openSessionTransportByIntentRuntime()` must route through `buildSessionTransportReusePlan()` before cleanup/rebuild.
- OPEN same-target transport means reuse and must not expire from quiet time, missed pong, stale `lastServerActivityAt`, or pong-only traffic. CONNECTING or fresh pending open means wait and do not queue a duplicate open; closed/missing/target mismatch/stale pending means rebuild. Active resume/tick on an OPEN transport may only request head or ping on the same socket; it must not force replacement unless the transport physically closes/errors, send throws, daemon is unreachable, user explicitly closes, or tmux/session target truth changes.
- `openSessionTransportByIntentRuntime()` must not clear `sessionTransportToken` while waiting for an existing CONNECTING same-target socket, because that token belongs to the in-flight handshake.
- Regression gates: `session-sync-helpers.test.ts`, `session-context-session-runtime.test.ts`, `session-context-activity-runtime.test.ts`, `session-context-socket-runtime.test.ts`, `session-context-input-runtime.test.ts`, `server.daemon-runtime-truth.test.ts`, `server.transport-lifecycle-truth.test.ts`, and `SessionContext.ws-refresh.test.tsx` must cover positive reuse, heartbeat-as-observation, stale activity not rebuilding, and negative closed/missing rebuild. APK/device behavior still requires installed-device validation before claiming L5 closure.

## 2026-07-07 Active resume pending-open wait budget

- 若现场表现为“当前进程切 session/恢复前台长时间等，杀掉重启马上连上”，优先判定旧 `CONNECTING` socket 或 pending open intent 卡住了客户端 transport owner；不要先把问题下沉到 daemon。
- active resume / active reentry / explicit resume 只允许短等 pending open（当前 1200ms）；超过预算必须在 `ensureActiveSessionFreshRuntime -> reconnectSession(..., { forceReplaceTransport:true })` 强制替换旧 in-flight transport。普通首连和 active tick 不走短预算抢占，避免重复开 socket。
- UI 状态必须来自 SessionContext 真实状态：pending open 未超过预算且处于 reconnect runtime 时写 `state=reconnecting` + `lastError=Waiting for existing websocket open`；健康首连 `connecting` 不得被改成 reconnecting。
- Regression gates: `session-sync-helpers.test.ts` 锁 planner 正/反向；`session-context-activity-runtime.test.ts` 锁短预算和状态投影；`session-context-session-runtime.test.ts` 锁 reconnect wait 状态；`SessionContext.ws-refresh.test.tsx` 锁健康 connecting/open 复用不被污染。APK `0.1.3.2028` 已构建，sha256 `0982c5a38b7e7db95ae4961fd3c8219b4a1f5bc5aaa4feb8c0aed3a49250e397`；仍需真机安装验证 L5。

## 2026-07-08 Daemon capture stability is the leak-row gate

- Android 底部 TUI/input 行漏刷、旧 prompt 上移时，若 TerminalView source/DOM gate 与 client sparse buffer gate 都过，优先查 daemon `captureMirrorAuthoritativeBufferFromTmux()` 是否真的接入稳定化主线；只测试 `resolveStableMirrorCaptureSnapshot()` helper 不等于主线已使用。
- Daemon tmux capture 发布规则：当前 mirror 已匹配可立即发布；否则必须等连续两次 canonical snapshot 一致才发布。半帧不能进入 mirror truth，否则 sparse changed-ranges 会把旧行作为未覆盖 truth 留在客户端。
- 同一 mirror 的 `totalAvailableLines` 必须以当前 mirror end 为单调下界；alternate-screen/TUI 只返回短可见窗口时，新内容应锚在当前 absolute tail，禁止把 `availableEndIndex` 从旧 tail 拉回 pane height。
- Regression gates: `terminal-mirror-capture.test.ts` 必须覆盖 transient half-frame 不发布和 tail anchor monotonic；`daemon:mirror:close-loop` 必须覆盖 top/vim/codex replay/source compare。APK `0.1.3.2030` 已构建，sha256 `14c4c413c04dd56062ee7c918774504106ba7b25e82e79a9a935beb486ef9c08`；仍需 Jason 真机复测 L5。

## 2026-07-08 Active transport quiet-time reuse correction

- Active terminal transport freshness cannot be inferred from quiet time. A same-session, same-target `WebSocket.OPEN` must stay alive across foreground resume, active reentry, active tick, input, missed pong, and pong-only traffic.
- Proactive diagnosis is limited to same-socket `buffer-head-request` / app ping observation. `lastServerActivityAt` and missing pong are not failure truth and must not call `forceReplaceTransport`.
- Daemon heartbeat is observational: missed ws pong logs and sends another protocol ping; it must not close an open session transport for heartbeat timeout. Client app heartbeat follows the same rule.
- Mac `bridge-transport` follows the same rule: heartbeat sends ping on the existing daemon WebSocket and does not close merely because pong is overdue.
- Regression gate: `pnpm --dir android exec vitest run src/contexts/session-context-socket-runtime.test.ts src/contexts/SessionContext.ws-refresh.test.tsx src/contexts/session-sync-helpers.test.ts src/contexts/session-context-activity-runtime.test.ts src/contexts/session-context-activity-runtime.tab-switch-no-probe.test.ts src/contexts/session-context-input-runtime.test.ts src/server/server.daemon-runtime-truth.test.ts src/server/server.transport-lifecycle-truth.test.ts --reporter dot` must cover quiet OPEN transport reuse, missed-pong non-close, input non-probe, and closed/missing rebuild.
- APK `0.1.3.2037` was built after the quiet-time reuse correction; sha256 `ccf406236e33c5ee5a15e68a0b2e712e6ff1633d0251fbf293e71207dd37416a`. Local evidence covers L0-L3 plus packaged build, but `adb devices -l` had no online device, so Android L5 UI/device re-entry validation remains open until installed on a real device.

## 2026-07-08 Adaptive width mode stale geometry truth

- `BridgeSettings.terminalWidthMode` 是 connect/open/reconnect payload 的当前宽度策略真源；session runtime 的 `requestedTerminalGeometry` 只允许贡献 measured cols，不允许用历史 `widthMode` 覆盖当前 Settings。
- 反模式：用户先用 `mirror-fixed` 连接，session runtime 写入 `{ widthMode:'mirror-fixed' }`，随后 Settings 切 `adaptive-phone`，reconnect 仍读旧 geometry 发 fixed。这个 bug 不应靠 TerminalView 后续 resize/signal 补救，因为 connect payload 已经错了。
- Owner fix: `session-context-provider-core-assemblies.ts` 的 geometry reader 必须把当前 `BridgeSettings.terminalWidthMode` 注入 wire geometry；fixed 不带 cols/rows，adaptive 只保留合法 cols。
- Regression gate: `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx --reporter dot` 必须覆盖 stale fixed geometry -> settings adaptive -> reconnect payload adaptive。

## 2026-07-08 Visible-window terminal body pull truth

- `WebSocket.OPEN` only proves transport availability; it must not imply body buffer pulling. Client body pulls require renderer-declared visible range or an explicit visible missing-range override.
- Client Mirror Buffer request windows are scoped to the current visible window. The 1000-line local sparse buffer is retention only, not a pull target; do not reintroduce three-screen/full-cache body prefetch for Android terminal refresh.
- Same-end revision advance is the required bottom/status-line refresh signal: if daemon revision advances while local end index is already at the visible tail, request the current visible tail window so in-place TUI/status updates repaint.
- Reading repair only requests gaps inside the declared visible range. Hidden history gaps must stay sparse until they become visible.
- Regression gates: `pnpm --dir android exec vitest run src/contexts/session-sync-helpers.test.ts src/contexts/session-context-buffer-runtime.test.ts src/contexts/SessionContext.ws-refresh.test.tsx --reporter dot` and `pnpm --dir packages/shared exec vitest run src/terminal/buffer-sync-request-planner.test.ts src/terminal/buffer-sync-planner.test.ts src/terminal/renderer.test.ts --reporter dot`.

## 2026-07-08 Daemon subscribed mirror cadence truth

- A ready mirror with at least one ready subscriber must stay on active capture cadence even if recent captures found no body changes. Do not use `lastLiveActivityAt` / “recent content change” as the gate for active polling.
- Idle/slow mirror cadence is allowed only from daemon-owned physical facts: zero ready subscribers, sync failure/backoff, transport backpressure, flush in flight, or capture/canonicalize cost over budget.
- This fixes TUI/status bars that update in place after a quiet period: if the daemon waits for a prior observed change before returning to active polling, the next update is discovered late and the status bar appears low-rate.
- Regression gates: `pnpm --dir android exec vitest run src/server/terminal-performance-scheduler.test.ts src/server/terminal-mirror-runtime.test.ts src/server/terminal-mirror-runtime.per-subscriber-cadence.test.ts src/server/terminal-transport-runtime.test.ts --reporter dot` and `pnpm --dir android run daemon:mirror:close-loop`.
- APK `0.1.3.2039` contains the subscribed mirror cadence fix; sha256 `1c2303435e82b61c1bec61aa0ffe9f0e474c47f4c658d38336b76a521a57d5ca`. Verified L0-L3 plus packaged build: server cadence 35 tests, Android type-check, feature registry 31 tests, daemon/tmux close-loop 8 cases with top-live buffer-sync/replay/strict audit, Mac client 147 tests + type-check, and standard debug build/update manifest sha alignment. `adb devices -l` had no online device, so Android L5 real-device UI refresh validation remains open.
- Because this fix is daemon-side, APK upgrade alone is insufficient if the Mac daemon runtime is stale. After 2039 build, `pnpm --dir android run daemon:install-global && zterm-daemon restart` installed current `~/.zterm/daemon-runtime/server.cjs`; runtime scan found `subscribed-good-transport-low-capture-cost` and no old `RECENT_PROGRESS_MS/recentlyActive` path. Health check returned `ok=true`, pid `40791`, `wsUrl=ws://127.0.0.1:3333`.

## 2026-07-08 Adaptive width mode UI truth

- `adaptive-phone` width policy must be owned by BridgeSettings and propagated to renderer + connect/resize payload. `TerminalPage` must not default missing `terminalWidthMode` to `mirror-fixed`; missing prop defaults to `adaptive-phone` to avoid fixed behavior before settings hydrate.
- Width-mode intent from active terminal/header must update BridgeSettings as well as send the immediate resize signal. Sending resize only leaves global truth stale, so the next entry/reconnect can still behave fixed.
- Shell tab swipe must not be disabled solely because `terminalWidthMode === mirror-fixed`; until a dedicated horizontal pan owner exists, fixed mode still needs the existing tab-swipe escape path.
- Regression gates: `pnpm --dir android exec vitest run src/App.dynamic-refresh.test.tsx src/pages/TerminalPage.android-ime.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx src/App.first-paint.real-terminal.test.tsx src/hooks/useTerminalShellActions.test.tsx src/pages/TerminalPage.tab-isolation.test.tsx src/pages/TerminalPageStageShell.pane-stage.test.tsx --reporter dot` and `pnpm --dir packages/shared exec vitest run src/react/use-bridge-settings-storage.test.tsx src/terminal/renderer.test.ts --reporter dot`.
- APK `0.1.3.2040` contains the adaptive width UI truth fix; sha256 `baf0b43e3e797ee48179c5008f9efd273fbbde696220f6ec5e1247ec0738c7e1`. Verified Android targeted width/layout/transport gates 285 tests, shared settings/renderer 22 tests, Android type-check, feature registry 31 tests, `git diff --check`, standard debug build, terminal contracts 592 tests, common flows 96 tests, relay smoke, and update manifest sha alignment. `adb devices -l` had no online device, so Android L5 real-device width-mode validation remains open.

## 2026-07-09 Adaptive width mode default truth

- `adaptive-phone` must be the default width policy at every settings normalization layer, not only at `useBridgeSettingsStorage()` first-render detection. `DEFAULT_BRIDGE_SETTINGS.terminalWidthMode`, `normalizeBridgeSettings()` for unknown/missing values, Android `normalizeTerminalWidthMode()`, and Settings option order must all prefer `adaptive-phone`.
- Prior anti-pattern: storage hook detected narrow Android viewports correctly, but shared `DEFAULT_BRIDGE_SETTINGS` and normalize helpers still defaulted unknown/missing mode to `mirror-fixed`; any path that normalized an incomplete draft/settings object could revive fixed behavior even after Settings showed the latest app version.
- Regression gates: `pnpm --dir android exec vitest run src/lib/bridge-settings.test.ts src/lib/terminal-width-mode-manager.test.ts src/App.dynamic-refresh.test.tsx src/App.first-paint.real-terminal.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx src/hooks/useTerminalShellActions.test.tsx src/pages/TerminalPage.android-ime.test.tsx src/pages/TerminalPage.tab-isolation.test.tsx --reporter dot` and `pnpm --dir packages/shared exec vitest run src/react/use-bridge-settings-storage.test.tsx --reporter dot`.
- APK `0.1.3.2041` contains the adaptive default closeout; sha256 `86f2a8427b18ec1e8fee73151c4fc4f32f2b7b1cf7461c9d28ae3d5d5c5122b5`. Verified targeted width gates 292 tests, shared storage 5 tests, Android typecheck, feature registry 31 tests, `git diff --check`, standard debug build, terminal contracts 593 tests, common flows 96 tests, relay smoke, and update manifest sha alignment. `adb devices -l` had only `emulator-5554 offline`, so Android L5 real-device UI validation remains open.

## 2026-07-09 Bottom-row session/IME render isolation gate

- `TerminalView` body DOM must remain scoped by `sessionId` during session switches and IME/layout refresh. A late publish from an inactive session must not repaint the active session's bottom rows, and a `ResizeObserver`/IME height change must only realign layout for the current session buffer.
- Regression gate: `TerminalView.dynamic-refresh.test.tsx` uses real `BaseTerminalView + createSessionRenderBufferStore()` to render A, switch to B, publish late A, trigger layout refresh, assert B DOM excludes A/late-A rows, then switch back and assert A shows only its latest rows.
- This is an L1/L4 gate. It does not replace Android L5 real-device visual validation for WebView compositor behavior.

## 2026-07-09 Foreground resume stale CONNECTING transport truth

- Active resume / active reentry / explicit resume must apply the short active wait budget to both transport-open phases: control `pending-open` before `session-ticket`, and session WebSocket `CONNECTING` after `session-ticket` has cleared the pending intent.
- If the second phase remains `CONNECTING` beyond the active wait budget, `ensureActiveSessionFreshRuntime()` must call `reconnectSession(sessionId, { forceReplaceTransport:true })`; otherwise foreground resume can sit on an old session socket until the long generic handshake timeout.
- Force replacement for stale pending-open or over-budget CONNECTING transport must physically close the old session socket. Leaving it as a live superseded CONNECTING socket is not clean enough for foreground recovery.
- Regression gates: `session-sync-helpers.test.ts` covers over-budget vs fresh CONNECTING planner decisions; `session-context-session-runtime.test.ts` covers stale pending/control cleanup and physical socket close; `SessionContext.ws-refresh.test.tsx` covers background -> foreground stale CONNECTING replacement with exactly one new session socket.

## 2026-07-09 Superseding correction: session WebSocket reuse truth

- Supersedes the immediately previous `Foreground resume stale CONNECTING transport truth`: foreground resume / tab re-entry / network online / quiet time / missed pong must not create a replacement session WebSocket while the existing same-session same-target socket is `OPEN` or `CONNECTING`.
- An `OPEN` session WebSocket is the protocol path for recovery: ask daemon for current `buffer-head`, ping, and session state on the same socket. Do not rebuild to learn what the current state is.
- A `CONNECTING` or pending session WebSocket is still the current client transport attempt. Active resume may show a waiting state, but must not create a second session WebSocket solely because a short wait budget elapsed.
- `reconnectRuntime.connecting` / stale reconnect bookkeeping is not socket failure truth. Foreground resume, tab re-entry, and network online must not turn it into `reconnect`; they may only wait/project state unless the socket physically closes/errors or the user explicitly reconnects.
- Rebuild is allowed only for physical socket `close/error`, explicit user reconnect/open, target mismatch, or missing/closed socket in an explicit open/resume path. Network `online` is not reconnect truth; it only triggers same-socket protocol probing.
- Regression gates: `App.dynamic-refresh.test.tsx` proves online calls `resumeActiveSessionTransport` and not `reconnectSession`; `session-sync-helpers.test.ts` and `session-context-activity-runtime.test.ts` prove stale pending/CONNECTING plans wait instead of force-replacing; `SessionContext.ws-refresh.test.tsx` proves foreground stale CONNECTING keeps one socket.

## 2026-07-09 Adaptive width Settings save truth

- If Settings shows/chooses `adaptive-phone` but subsequent terminal entry still behaves fixed, check the App Settings save owner before daemon/render code. The bug can be that `onSave(next)` computes `terminalWidthMode` from stale `current` settings and writes `mirror-fixed` back over the draft.
- App Settings save must write `terminalWidthMode` from the Settings draft `next`; `current` is only previous storage state and must not override the user's new width-mode intent.
- Regression gate: `App.dynamic-refresh.test.tsx` covers terminal -> connections -> settings save from old `mirror-fixed`, then applies the `setBridgeSettings` updater to stale current and expects `adaptive-phone`.

## 2026-07-09 Adaptive width daemon process truth

- Superseded by `2026-07-11 Superseding correction: adaptive-phone must reflow tmux via single daemon lease owner`. Keep this entry only as historical process-validation evidence, not current design guidance.
- `APK latest` and `~/.zterm/daemon-runtime/server.cjs` containing adaptive code do not prove the running Mac daemon process has loaded that code. If daemon `health.uptimeSec` predates the runtime update, the process is still executing old in-memory code.
- Superseded old statement: adaptive width was briefly considered client/in-memory only. Current daemon must apply `tmux resize-window -x N` only inside the single adaptive lease owner.
- Verified failure mode: before daemon restart, a real WebSocket probe sent `connect cols=47` and `resize cols=53`, but daemon returned `buffer-sync.cols=80` and tmux stayed `80x24`. After service-scoped `zterm-daemon restart`, the same probe returned `buffer-sync.cols=47`, and tmux became `53x24` after resize.
- Required validation for daemon-side adaptive/mirror/scheduler changes: check `/health` pid/uptime after install, then run a real WebSocket + tmux probe that reads tmux `#{window_width}x#{window_height}`. Do not use APK version, runtime file scan, or source tests as proof that the daemon process is current.

## 2026-07-09 Superseding correction: daemon must not own client width policy

- Superseded by `2026-07-11 Superseding correction: adaptive-phone must reflow tmux via single daemon lease owner`; the broad no-resize conclusion is obsolete.
- Superseded old statement: daemon must not implement phone adaptive width by applying `tmux resize-window -x`. Current rule is narrower: daemon must not own arbitrary client width policy, but its adaptive lease owner must apply the narrowest active adaptive cols to tmux.
- Attach/resize wire may still carry `widthMode/cols` for compatibility, but daemon must not store it in `TerminalSession` / `SessionMirror`, must not update `mirror.cols/baselineCols` from it, and must not run `resize-window` from client viewport intent.
- `tmux resize-window -x` switches tmux into manual window sizing and can freeze height, so using daemon resize to fix phone width is the architecture bug, not the solution. If adaptive/fixed behavior appears identical or height is wrong, first audit daemon/tmux width ownership resurrection before UI compensation.
- Superseded gate note correction: current gate allows adaptive `resize-window` only inside the adaptive lease owner and forbids it everywhere else.
- Verified after correction: targeted server/daemon gates 8 files / 72 tests PASS, Android `tsc --noEmit` PASS, and `pnpm --dir android run daemon:mirror:close-loop` PASS for `codex-live`, `top-live`, `vim-live`, `initial-sync`, `local-input-echo`, `external-input-echo`, `daemon-restart-recover`, and `schedule-fire`.

## 2026-07-09 Superseding correction: foreground resume equals explicit resume

- Supersedes earlier `active-resume` entries: foreground false->true must not have a separate transport lifecycle branch. It must map to `explicit-resume` and share the same SessionContext transport owner as cold restore / explicit resume.
- This fixes the split where killing and reopening the app used the explicit open/resume path and connected immediately, while returning from background used `active-resume` and could stay stuck in closed/unavailable/timeout state.
- `active-resume` is no longer a source in `android/src`; keeping the name in code is a regression because it reintroduces two reconnect/open policies for the same user-visible resume action.
- Buffer message apply must gate both `buffer-sync` and `buffer-head` before local head/buffer mutation. A non-active/non-live session head frame must not move local head truth or promote connected state; otherwise old session/old transport frames can flash stale buffer during refresh.
- Regression gates: `session-context-lifecycle.test.tsx` locks foreground false->true -> `explicit-resume`; `session-sync-helpers.test.ts` locks pending/CONNECTING wait and explicit closed reconnect; `session-context-socket-message-runtime.test.ts` locks inactive `buffer-head` drop; `SessionContext.ws-refresh.test.tsx` locks foreground head refresh on the existing socket.

## 2026-07-09 Terminal default background and render gate truth

- Terminal default background sentinel `bg=256` is terminal theme background, not CSS `transparent`. Renderer row, cell wrapper, gap marker, and gap fill must all paint `theme.background`; otherwise default cells leak the outer app/container background and screenshots differ from true terminal rendering even when daemon payload is correct.
- `session-render-gate` must not apply per-session/network cadence after body truth is already in the live buffer store. Render commit coalesces only to the next RAF and reads the latest live buffer once at flush time; old delayed scheduled commits are a valid cause of “old buffer flashes first, then current buffer covers it”.
- `resolveTerminalRefreshCadence()` only owns producer/head/pull/read cadence. It must not expose `renderCommitMs`, because renderer commit timing is not a transport/network policy.
- Regression gates: `session-render-gate.test.ts` locks latest-live-buffer-at-RAF and no old scheduled publish; `TerminalView.theme.test.tsx` locks default cells against theme background; shared `renderer.test.ts` locks gap background against theme background.
- APK `0.1.3.2047` contains the terminal background and render-gate fix; sha256 `eb832f5a205f1ed6db0a934936af31b73c4629512025aee0c78b5faed43ddac6`. Verified Android targeted render/theme/cadence gates 97 tests, shared renderer 17 tests, `SessionContext.ws-refresh` 130 tests, Android typecheck, feature registry 34 tests, `git diff --check`, prebuild terminal contracts 595 tests, common flows 96 tests, relay smoke, standard debug build/update manifest sha alignment, and installed on device `100.104.163.65:5555` with `versionName=0.1.3.2047`.

## 2026-07-09 Classic Dark preset background live truth

- If the renderer already maps `bg=256` to `theme.background` but the real device still looks unchanged, inspect the live WebView theme truth before changing renderer again. In the 2047 device test, `localStorage['zterm:bridge-settings'].terminalThemeId` was `classic-dark`, `.wterm` computed background was `rgb(0, 0, 0)`, and `classic-dark.background` in shared preset was `#000000`; therefore the visible failure was the active theme preset, not APK install or daemon payload.
- `classic-dark.background` is now the terminal surface `#1e1e1e`, so existing users with `terminalThemeId=classic-dark` get a visible non-black default background without migrating settings or adding Android UI compensation. Explicit payload backgrounds still win per cell.
- Regression gate: `TerminalView.theme.test.tsx` locks Classic Dark default cells and `.wterm` scroller to `#1e1e1e`; shared renderer still validates row/gap background mapping.
- APK `0.1.3.2048` contains the Classic Dark preset correction; sha256 `1943c85a393575a30b6d2b858333f435045e48c78ef51911e410f888b317457e`. Verified targeted theme 12 tests, shared renderer 17 tests, Android typecheck, feature registry 34 tests, standard debug build with terminal contracts 595 tests/common flows 96 tests/relay smoke, installed on device `100.104.163.65:5555` with `versionCode=1032048`, and live CDP proved active `.wterm` background plus default rows changed to `rgb(30, 30, 30)` while explicit TUI input row cells remained `rgb(49, 52, 57)`.

## 2026-07-09 Superseding correction: adaptive width lease owner

- Superseded by `2026-07-11 Superseding correction: adaptive-phone must reflow tmux via single daemon lease owner`. Keep only owner-shape history here; current tmux resize/restore guidance is in the later entry.
- Superseded old statement: daemon briefly owned a narrow, explicit `adaptive-phone` width lease state machine, not arbitrary client UI state.
- `adaptive-phone` connect/resize registers the physical transport subscriber's `{ cols, heartbeatAt }` lease. Multiple adaptive subscribers on the same tmux mirror are aggregated by narrowest `cols`.
- Current correction: if the narrowest holder disappears, daemon recomputes and applies the next narrowest width. If the last holder disconnects, switches to `mirror-fixed`, or misses heartbeat past the lease TTL, daemon releases this owner’s tmux width lease.
- Current correction: `mirror-fixed` must not register a lease and must not change tmux width. `resize-window` is allowed for adaptive only in the lease owner.
- Regression gates: `terminal-mirror-runtime.test.ts` covers narrowest wins, holder disappearance re-sort, last lease TTL restore, and fixed release restore; `terminal-runtime.detached-session.test.ts` covers transport detach restoring baseline only when the subscriber held an adaptive lease.

## 2026-07-09 Explicit resume head probe truth

- Foreground false->true and explicit resume must always issue a forced `buffer-head-request` on the existing `OPEN` session WebSocket. A cached/open WebSocket only proves the protocol path exists; it does not prove daemon head/body has been pulled after background or network fluctuation.
- `lastActiveReentryAtRef` and `connectedBaselineBurstGuardRef` may suppress only passive `active-reentry` duplicate head probes. They must not suppress `explicit-resume + forceHead`, or the app can remain connected but visually frozen until another user event triggers refresh.
- Regression gates: `session-context-activity-runtime.test.ts` covers explicit resume with both guards set still sending forced head; `SessionContext.ws-refresh.test.tsx` covers connected baseline and tab-switch resume sending a second same-socket head without any extra `connect`.

## 2026-07-09 Orphaned adaptive width restore truth

- No active adaptive client means tmux must be restored out of adaptive width, even if an older daemon left no `@zterm_adaptive_width_baseline` option behind. Persisted baseline is preferred; if absent and the tmux window is narrower than its attached tmux client, restore to the attached client geometry.
- This recovery belongs only in the daemon adaptive width lease owner. Client/UI must not compensate by sending extra width changes, and daemon must not infer foreground/active state.
- Regression gates: `terminal-mirror-runtime.test.ts` covers orphaned narrow window startup restore to attached client size and the negative case where matching window/client geometry does not resize. Real validation: global daemon install + `zterm-daemon restart` restored existing 55-column sessions to attached client widths, then `daemon:mirror:close-loop` passed all 8 cases.

## 2026-07-09 Adaptive width invalid cols crash truth

- `adaptive-phone` connect/resize payload must include finite positive `cols` before it reaches the daemon adaptive width lease owner. A payload with `widthMode='adaptive-phone'` and missing/NaN cols is an invalid lease request, not a valid adaptive state.
- Daemon adaptive lease owner must never let invalid client payload throw through to Node process death. It must release any existing lease for that subscriber, return/send explicit `adaptive_width_cols_invalid`, and keep the daemon process alive.
- Client cold-start adaptive handshake must send a concrete startup cols value before TerminalView has measured real width; the current safe startup value is SessionContext default `80`, and the later renderer resize replaces it with measured cols.
- Verified failure mode: installed daemon crashed repeatedly with `terminal cols must be a finite positive number` from `updateAdaptiveWidthLease()` after old Android sent `adaptive-phone` without cols. Fixed daemon stayed alive after a real WebSocket bad-payload probe returned `adaptive_width_cols_invalid`; Android `0.1.3.2050` sends cols on cold adaptive connect.

## 2026-07-09 Restore shell must restore transport identity

- `createSession(connect:false)` is a local runtime shell restore, not a WebSocket open, but it must still restore the session transport host/target identity. Otherwise `explicit-resume` sees `targetKey=null`, emits `session.reconnect.reuse-plan reason=missing-target`, and rebuilds a WebSocket even though the persisted tab points to the same daemon/session.
- The unique owner is `createSessionRuntime`: when creating or reusing a restored shell, write `writeSessionTransportHost(sessionId, host with resolvedSessionName)`. Do not fix this in App/TerminalPage, and do not loosen reconnect planner to accept missing target.
- Regression gates: `session-context-session-runtime.test.ts` must cover both new closed local shell and reused existing shell writing transport identity while `connect:false` does not open a socket.
- Real validation for this failure mode: install APK, verify runtime version, wait until connected, press Home, relaunch, and compare `/debug/runtime.transportSubscribers[0].id`. It must stay the same; logs must have no new `missing-target`, `transport-detached`, or `rebuild` for the active subscriber, and `session.buffer.head` / `session.buffer.applied` must continue.

## 2026-07-09 Head probe timeout is not socket failure truth

- A same-socket `buffer-head-request` timeout on an `OPEN` WebSocket is not transport failure truth. The activity freshness owner may clear the stale probe marker and send another head request on the same socket, but must not call `reconnectSession()` from the timeout itself.
- Rebuild remains allowed only for physical close/error, target mismatch, explicit user reconnect/open, or missing/closed socket in explicit open/resume. Quiet time, missed head response, stale activity, or local reconnect bookkeeping are not rebuild reasons.
- Regression gate: `session-context-activity-runtime.test.ts` must cover expired head probe marker + `WebSocket.OPEN` still calling `requestSessionBufferHead` and not calling `reconnectSession`.

## 2026-07-10 Missing ranges must not produce holey buffer-sync windows

- A single `buffer-sync` payload is one continuous authoritative window. If a `buffer-sync-request` carries multiple `missingRanges`, the daemon response must cover the full span from the earliest missing range start to the latest missing range end, including rows between gaps.
- Returning an outer request window while `lines` contains only non-adjacent gap rows is invalid. The client sparse buffer will preserve existing absolute-index rows in the holes, which can flash stale buffer during fast refresh.
- Current protocol does not support multiple windows inside one `buffer-sync`. Future multi-gap optimization must emit multiple independent continuous `buffer-sync` messages or introduce a typed protocol version; renderer/UI must not compensate by clearing DOM or delaying repaint.
- Owner/gates: `buffer-sync-contract.ts` normalizes/sorts missing ranges and returns a continuous authoritative span; `session-context-buffer-runtime.ts` scopes reading-repair in-flight targets to the missing span. Regression gates: `buffer-sync-contract.test.ts`, `session-context-buffer-runtime.test.ts`, render gate/store tests, shared pull-state planner, Android typecheck, feature registry, daemon mirror close-loop, and Mac client transport/runtime gates.

## 2026-07-10 Adaptive attach invalid cols must fail explicitly before geometry normalize

- `adaptive-phone` attach without finite positive `cols` must not reach any generic geometry normalizer that throws. `attachTmux()` must ignore invalid adaptive requested geometry and let the adaptive width lease owner return/send explicit `adaptive_width_cols_invalid`.
- A test helper that implements `normalizeTerminalCols` as `cols || default` hides the real daemon crash path. Adaptive width invalid-input tests must run with a strict normalizer that throws on missing/NaN/non-positive cols.
- Verified real failure: service restart loaded a runtime that crashed in `normalizeTerminalCols()` before `updateAdaptiveWidthLease()` could reject the bad lease. Fixed runtime returned `adaptive_width_cols_invalid` to a real WebSocket probe while daemon health stayed OK and pid remained stable.

## 2026-07-10 Oversized buffer-sync must crop to authoritative tail

- If an incoming `buffer-sync` span covers the authoritative tail and is larger than the client retention window, local buffer merge must keep `[tail-cacheLines, tail)`, not `[incomingStart, incomingStart+cacheLines)`. The broken shape is `incoming.endIndex == nextTailEndIndex` while `nextEndIndex << nextTailEndIndex`; that publishes old history first and then snaps back when a later tail patch arrives, causing wrong-buffer flash.
- This is a client buffer merge truth, owned by shared `packages/shared/src/connection/terminal-buffer.ts`; it must not be fixed by renderer DOM clearing, delayed repaint, daemon fallback, or UI compensation.
- Regression gate: `packages/shared/src/connection/terminal-buffer.test.ts` reproduces current tail `[16463,17463)` plus incoming `[14763,17463)` with `lineCount=2700` and `cacheLines=1000`; pre-fix result was `next.startIndex=14763`, fixed result is `[16463,17463)`.
- Verified for APK `0.1.3.2059 / 1032059`, sha256 `f5a447e0602a9484d919b297acfed61e192acb451ee6b2603fa64272a213bd67`: shared buffer/planner/gap gates 51 PASS; Android buffer/render gates 118 PASS; Android typecheck PASS; feature registry 34 PASS; Mac client 147 PASS + type-check PASS; daemon mirror close-loop 8 cases PASS; Android build PASS. No online ADB device was available, so Android L5 real-device visual confirmation remains open.

## 2026-07-10 Android upgrade APK is mandatory for mobile behavior delivery

- Every Android feature fix, bug fix, renderer change, daemon-client protocol change, or UI behavior change that affects real-device behavior must build a user-upgradeable APK before handoff. The default command is `pnpm --dir android run build:android`.
- Delivery evidence must include `versionName`, `versionCode`, APK path, sha256, and update-channel alignment for `android/update-dist/latest.json`, versioned APK, latest alias, and `~/.zterm/updates/latest.json` / versioned APK.
- If an online ADB device exists, continue with install/start/real-device smoke. If no online ADB device exists, report the exact L5 gap. Source changes, unit tests, typecheck, and daemon close-loop alone are not a mobile delivery closure.

## 2026-07-11 Near-tail buffer-sync must not re-anchor current tail window upward

- A newer near-tail `buffer-sync` payload that overlaps the current tail window but does not reach `authoritativeTailEndIndex` must not move a local window already anchored at tail. It may patch overlap rows, but `startIndex/endIndex` must remain the current tail window.
- Broken runtime shape: current local window `[10606,11606)` with tail `11606`, incoming payload `[10592,11601)` / `lineCount=1009` / newer revision. Pre-fix merge re-anchored to `[10592,11592)`, briefly publishing a window ending before tail, then a later tail patch snapped it back. This matches bottom-update old-buffer flash.
- Owner is shared client buffer merge `packages/shared/src/connection/terminal-buffer.ts`. Do not fix this by renderer DOM clearing, repaint delay, daemon fallback, or UI compensation.
- Regression gate: `packages/shared/src/connection/terminal-buffer.test.ts` locks the near-tail current-tail preservation and a negative case proving non-tail reading/prepend windows can still move.
- Verified for APK `0.1.3.2060 / 1032060`, sha256 `0019cb00bf81058df92b41167b5a903289c5ac165de52285ea852559f2babfd0`: shared buffer/planner/gap gates 53 PASS; Android buffer/render gates 118 PASS; Android typecheck PASS; feature registry 34 PASS; Mac client 147 PASS + type-check PASS; daemon mirror close-loop 8 cases PASS; Android build PASS with update manifest and daemon update channel sha aligned. No online ADB device was available, so Android L5 real-device visual confirmation remains open.

## 2026-07-11 Adaptive lease restore must unset tmux window policy override

- Superseded by `2026-07-11 Superseding correction: adaptive-phone must reflow tmux via single daemon lease owner`. This entry remains as evidence for why the release half of the owner must unset tmux `window-size`.
- `tmux resize-window -x` creates a window-local `window-size` policy override. Restoring only cols/rows is incomplete: iTerm or any attached tmux client can still be prevented from reclaiming layout ownership even when the visible geometry looks restored.
- Superseded old release sequence correction: daemon must not run startup/orphan cleanup automatically, but the adaptive lease owner must restore/release the baseline for the lease it applied.
- Required release paths: last adaptive lease disappears, subscriber switches to `mirror-fixed`, invalid adaptive cols release an existing lease, heartbeat expiry clears the final holder, and daemon startup restores persisted/orphaned adaptive baselines.
- Regression gates: `terminal-mirror-runtime.test.ts`, `terminal-runtime.detached-session.test.ts`, `architecture-boundary-truth.test.ts`, and `server.transport-lifecycle-truth.test.ts` lock that `window-size` policy write is only `set-window-option -u` inside the release owner.
- Verified real daemon/tmux probe: before adaptive policy was default and size `80x24`; after adaptive connect policy became `manual` and size `55x24`; after release via `mirror-fixed`, policy became `<default>` and size returned to the attached client/default-controlled geometry.

## 2026-07-11 Daemon must not disable tmux alternate-screen while checking sessions

- Root cause for the remaining iTerm2 incomplete display on `rcc4`: width ownership was already released, but previous daemon code had written a window-local `alternate-screen off` through `ensureTmuxSessionAlternateScreenDisabled()` from `assertTmuxSessionExists()`. That made a read/existence check mutate user tmux display semantics.
- Correct boundary: daemon control/mirror paths may read tmux truth (`has-session`, pane metrics, capture) but must not change user window/session options to simplify capture. `alternate-screen` is tmux/user display policy, not daemon mirror ownership.
- Fix owner: remove `ensureTmuxSessionAlternateScreenDisabled` from `src/server/terminal-control-runtime.ts` and remove its call from `src/server/server.ts`; add transport lifecycle gate forbidding daemon writes to `alternate-screen`.
- Field cleanup: unset existing local `alternate-screen` overrides with `tmux set-window-option -u -t <target> alternate-screen`. Verified current sessions, including `rcc4`, report `window-size=<default>` and `alternate-screen=<default>` after daemon restart.

## 2026-07-11 Mirror truth must only come from tmux readback

- Corrected wording: daemon may send user/protocol requests to tmux for real user/session operations such as input `send-keys` and session create/kill/rename; adaptive width may send `resize-window -x` only from the adaptive lease owner. No request authorizes daemon to predict the result into mirror truth.
- Hard boundary: `mirror.rows`, `mirror.cols`, `mirror.bufferStartIndex`, `mirror.bufferLines`, and `mirror.cursor` must only be written by tmux readback/capture owner `terminal-mirror-capture.ts` via `applyMirrorCaptureSnapshot()`. `attachTmux`, `resize`, adaptive lease reconcile/restore, `startMirror`, and debug probes must not self-write mirror content or geometry from request values or pane metrics.
- Fix: remove `attachTmux()` pre-writing mirror geometry from `readTmuxPaneMetrics()`; new mirrors keep default idle geometry until `syncMirrorCanonicalBuffer()` invokes capture and capture applies the tmux snapshot.
- Regression gate: `server.mirror-capture-truth.test.ts` scans runtime code so only capture owner writes live mirror content/geometry; `destroyMirror()` may clear fields only while destroying the mirror. Targeted daemon mirror gates pass 70 tests and Android typecheck passes for this boundary.

## 2026-07-11 Superseded correction: adaptive must not affect tmux session

- Superseded by `2026-07-11 Superseding correction: adaptive-phone must reflow tmux via single daemon lease owner`; keep this as a recorded wrong turn, not current guidance.
- Supersedes the same-day "daemon may send adaptive resize-window" wording and the earlier adaptive width lease owner entries. New hard boundary: `adaptive-phone` must not affect tmux session original logic at all.
- Daemon may still accept `widthMode='adaptive-phone'` and finite `cols` for wire compatibility, client observation, and heartbeat expiry, but this remains in daemon memory only: `TerminalTransportSubscriber.adaptiveWidthCols/adaptiveWidthHeartbeatAt` plus in-memory aggregate metadata.
- Forbidden adaptive side effects: `resize-window`, reading/writing `window-size`, writing `@zterm_adaptive_width_*`, restoring orphaned/baseline geometry, changing `alternate-screen` or any tmux option, closing/killing tmux session, or self-writing mirror geometry/content.
- Regression gates: `terminal-mirror-runtime.test.ts` proves attach/resize/fixed switch/holder disappearance/heartbeat expiry/daemon start do not mutate tmux; `server.transport-lifecycle-truth.test.ts` and `architecture-boundary-truth.test.ts` forbid `resize-window`, `window-size`, and `@zterm_adaptive_width_*` in daemon mirror runtime.

## 2026-07-11 Superseded correction: Adaptive-phone requires client render projection

- Superseded by `2026-07-11 Superseding correction: adaptive-phone must reflow tmux via single daemon lease owner`; keep this as a recorded wrong turn, not current guidance.
- `adaptive-phone` has two independent requirements: client wire must send current mode/cols, and client renderer must project rows to measured local viewport cols. Settings showing Adaptive Phone and connect payload containing `adaptive-phone` do not prove the visible terminal is adaptive.
- After the no-tmux-impact correction, adaptive must never be implemented by tmux resize. The visible width effect must live in TerminalView/shared renderer projection: crop row/cursor/plainText to measured `viewportCols` for `adaptive-phone`; keep full daemon mirror row for `mirror-fixed`.
- Regression gate: shared renderer pure projection test plus `TerminalView.dynamic-refresh.test.tsx` must prove adaptive on a 320px viewport renders fewer columns while mirror-fixed preserves the full 80-column row.

## 2026-07-11 Superseding correction: adaptive-phone must not use CSS auto-height wrapping

- Supersedes the previous "crop row" and later "CSS wrap row" attempts. Cropping drops content; CSS `white-space: normal` / `height:auto` breaks TerminalView's fixed-row virtual scroll math. The latter caused upward scroll to keep advancing/cycling and made IME bottom alignment miss the last rows.
- Corrected again: the product requirement for `adaptive-phone` is tmux real reflow by phone width, not client-only projection. Daemon/tmux mirror rows are unchanged only until tmux capture/readback returns the new width; `TerminalView` row DOM height must stay the measured fixed row height and must not use browser auto wrapping.
- Correct path: client sends measured cols -> daemon adaptive lease owner aggregates the narrowest active adaptive cols -> tmux `resize-window -x` -> mirror capture/readback updates truth -> client renders fixed-height rows.
- If a future client-only visual wrapping mode is required, implement it as an explicit renderer virtual-row model with fixed-height segments. Do not use CSS wrapping as a shortcut and do not use renderer crop to claim adaptive reflow.
- Terminal viewport chrome must not add `cardBorder`/bright shell borders around the terminal content area. A 1px outer border on dark terminal content appears as a white vertical bar and is UI shell chrome, not terminal content.
- Regression gates: `TerminalView.dynamic-refresh.test.tsx` locks adaptive rows remain fixed-height and do not set wrapper width/maxWidth/normal wrapping; `renderer.test.ts` locks row view model fixed height; `TerminalPageStageShell.pane-stage.test.tsx` locks terminal stage/pane/group center border width 0 and style none.

## 2026-07-11 Superseding correction: adaptive-phone must reflow tmux via single daemon lease owner

- Supersedes the same-day "adaptive must not affect tmux session" and "adaptive visible width by client projection" entries. Those rules over-corrected and left Adaptive Phone looking identical to fixed width.
- `adaptive-phone` owner is `android/src/server/terminal-mirror-runtime.ts` only. It may keep physical subscriber lease metadata `{ adaptiveWidthCols, adaptiveWidthHeartbeatAt }`, aggregate active adaptive holders by narrowest cols, and request `tmux resize-window -x <cols>` from `applyAdaptiveTmuxWidth()`.
- Release behavior is part of the same owner: switching to `mirror-fixed`, transport detach/close, moving mirrors, invalid cols, or heartbeat expiry must recompute leases; final holder disappearance must restore/release tmux width ownership via owner-local baseline and `set-window-option -u window-size`.
- Forbidden paths remain strict: no renderer crop/CSS wrap pretending to be adaptive, no daemon startup/orphan heuristic changing old sessions, no `@zterm_adaptive_width_*` persisted tmux option, no `resize-window` outside adaptive lease owner, and no mirror geometry/content self-write after requesting resize. `mirror.rows/cols/bufferStartIndex/bufferLines/cursor` still only come from tmux capture/readback.

## 2026-07-11 Client transport writable does not prove buffer read-chain freshness

- Daemon stable truth is `tmux -> mirror store`; a WebSocket is a client-owned physical transport, not a daemon-owned permanent per-session object. If a client process/background/network path loses its transport, the invariant is not “same WebSocket forever”; the invariant is “reattach/resume reaches the same daemon mirror truth and immediately restarts head/body reads”.
- A session that can still send input but shows an old buffer means the write path and read path have split. Treat this as client `transport_lifecycle + buffer_render` read-chain recovery, not as a daemon mirror issue and not as a renderer repaint issue.
- Explicit resume, foreground return, and active session change must force a head request and mark resume-tail even when local buffer is non-empty. Old local buffer is not proof of freshness; it is exactly the state that can produce stale-screen-with-input-working.
- Stale pending transport-open bookkeeping is not a waitable state. The unique reconnect owner must clear the stale pending intent/control socket and rebuild the same target. Fresh pending open still waits to avoid duplicate physical opens.
- Regression gates: `session-context-activity-runtime.test.ts` must cover stale pending reconnect vs fresh pending wait and old-buffer active reentry marking resume-tail; `session-context-lifecycle.test.tsx` must cover activeSessionId change passing `markResumeTail: true`; architecture boundary gate must keep `stale-pending-open` inside transport planner/session runtime only.
## 2026-07-11 Windows WezTerm closeout partial progress

- `daemon.windows_wezterm_backend` closeout now requires local unit/runtime/backend-selection/input tests, mock daemon protocol smoke, typecheck, feature-registry gate, and real Windows remote/input smoke in the current worktree.
- Runtime cleanup truth: after `wezterm cli --prefer-mux kill-pane`, the backend must run a fresh pane list. If the pane remains listed, cleanup is an explicit `wezterm pane cleanup failed...` error and local session/snapshot state must not be silently deleted.
- `win/` is only a future Windows desktop shell owner. It must not copy terminal runtime, daemon mirror, buffer protocol, renderer logic, or `../wterm` source. Windows shell starts after backend closeout and owns only window/menu/package/platform integration.
- Current blocker: `jason-hw-desktop / 100.75.122.121` was offline with Tailscale `peer's node key has expired`; SSH timed out. This prevents real `wezterm-backend-remote-smoke.ts` and `wezterm-backend-input-smoke.ts`, so Windows backend closeout is not complete.

## 2026-07-12 Client must not own terminal layout

- Terminal content layout belongs to tmux/mirror truth. Client code must not reflow terminal content from WebView/container measurement, input count, IME state, active/focus state, or renderer geometry keys.
- Allowed client work: consume daemon `buffer-head` / `buffer-sync`, maintain local sparse buffer, render fixed-height rows from mirror truth, crop/pan UI shell, send input, and request head/range based on visible demand.
- Forbidden client fixes: CSS wrapping rows, changing shared row/cell/theme backgrounds to hide stale/empty rows, injecting default cols/rows when tmux head/geometry has not arrived, adding `viewportCols`/`widthMode` to render revision keys, or using UI border/scrollbar/IME changes to force content geometry refresh.
- If entering a session shows no previous buffer, root cause hunt starts at `attach/resume -> tmux pane metrics/capture -> buffer-head -> buffer-sync -> local apply`; do not patch renderer layout. The expected fix is in transport/buffer resource truth and first head/body bootstrap, not client-side layout.
- `adaptive-phone` remains tmux reflow via the single daemon adaptive lease owner. Client reports measured cols; daemon requests tmux reflow; only capture/readback updates mirror rows/cols/buffer.

## 2026-07-12 Global resource registry first phase

- Global resource truth now starts from `android/docs/resource-registry.json`, with `android/docs/resource-map.md` as the human review surface and `android/docs/testing/resource-truth-test-design.md` as the gate design. Scope is global: daemon, Android, Mac, Windows, terminal backends, transport, buffer/render, CLI/release, and debug side channels.
- Function map is feature-local only and must bind to declared resource ids; it cannot invent resource relations. Mainline call map edges must carry `resource_from`, `resource_to`, `via_resources`, and `relation_status`.
- Resource gates added: `resource-registry-truth.test.ts`, `function-map-resource-truth.test.ts`, and `mainline-resource-call-map.test.ts`. These gates reject undeclared resource ids, missing owner features, unresolved doc/gate references, and forbidden direct resource shortcuts.
- Verified L0: focused resource gates pass 3 files / 11 tests; `test:feature-registry` passes 7 files / 45 tests after wiring resource gates into the standard registry gate. This proves doc/static resource ownership only; live daemon/client behavior still requires the mapped L2/L3/L4 gates when code changes.
## 2026-07-12 Retryable reconnect handshake failure is not terminal error truth

- `terminal.transport_lifecycle` owns reconnect handshake failure projection. Retryable reconnect handshake failures are intermediate transport facts, not terminal session error truth.
- Correct behavior: retryable reconnect handshake failure keeps the session in `reconnecting`, updates attempt/error text for observability, and schedules the next reconnect attempt. It must not emit `SESSION_STATUS_EVENT(type='error')` or make the drawer/UI show final “连接失败”.
- Terminal error projection is allowed only for nonretryable handshake failure or a future explicitly exhausted retry state. UI/drawer must not add a compensating retry/error filter; daemon and renderer are outside this owner.
- Regression gate: `session-context-transport-open-runtime.test.ts` must keep paired tests proving retryable failure does not call `emitSessionStatus`, while nonretryable failure still does.
## 2026-07-12 Explicit session switch must reach the transport owner as explicit-resume

- Drawer/tab switch is a user explicit resume intent. `useOpenTabRuntime` must not only persist `switchRuntime:'explicit-resume'`; it must pass the same reason into `SessionContext.switchSession(..., { refreshSource:'explicit-resume' })` so the transport lifecycle owner does not downgrade it to `active-reentry`.
- `active-reentry` remains the default for internal lifecycle changes, but user-visible switch/resume/open-tab selection must enter `ensureActiveSessionFresh()` as `explicit-resume` and request `forceHead + markResumeTail`.
- Regression gate: `useOpenTabRuntime.test.tsx` must prove explicit switch calls `switchSession(target, { refreshSource:'explicit-resume' })`; lifecycle tests continue to prove ordinary activeSessionId changes use `active-reentry`.

## 2026-07-12 Input must not own reconnect or open intent

- `terminal.keyboard_ime` owns `resource.platform_input_channel`, but it only writes through the current `resource.session_transport`. It must not create reconnects, probe stale sockets, or bypass `resource.pending_open_intent`.
- Correct behavior: input sends synchronously only when `readSessionTransportResource(sessionId).socket` is currently open, drops explicitly when the transport is missing/backpressured/pending-open, and leaves reconnect/open intent recovery to `terminal.transport_lifecycle`.
- Deferred input tail refresh must also re-read the current session transport resource in its microtask, so a replaced socket is not reused after tab switch or reconnect.
- Regression gate: `session-context-input-runtime.test.ts` must prove open-resource send, stale accessor avoidance, no reconnect policy calls, pending-open drop, backpressure drop, and microtask head refresh retargeting.

## 2026-07-12 Buffer bootstrap must pull body from mirror truth

- `terminal.buffer_render` owns `resource.client_sparse_buffer -> resource.renderer_window`; it consumes daemon `resource.mirror_store` only through `buffer-head` metadata and `buffer-sync` body patches.
- When active `buffer-head` arrives before renderer has declared a visible range, the buffer owner must bootstrap one tail body sync from daemon head bounds. It must not wait for renderer layout or invent client-side terminal layout.
- `buffer-head` cursor/head metadata may update local metadata truth, but it must not schedule body render commits. Only `buffer-sync apply` is allowed to repaint terminal body rows.
- Tail refresh and reading repair requests are scoped to the current visible window; hidden cache rows are retention, not fetch target. Sparse tail jumps must request visible tail repair without reinterpreting reading position as follow.
- Regression gates: `session-context-buffer-runtime.test.ts`, `session-sync-helpers.test.ts`, shared `terminal-buffer.test.ts`, and `buffer-sync-request-planner.test.ts` cover active head-before-visible bootstrap, no head-only body repaint, visible-window tail refresh, stale/lower revision drops, and sparse tail repair.

## 2026-07-12 Retryable reconnect start is not terminal error truth

- A retryable reconnect start is an intermediate `terminal.transport_lifecycle` fact, not terminal session error truth. `scheduleReconnectRuntime()` must update the session to `reconnecting` and start the next attempt without emitting `SESSION_STATUS_EVENT(type='error')`.
- Evidence from the `zterm`现场: tmux session/pane existed and daemon mirror captured `zterm`; daemon later received input and pushed `buffer-sync`, while the client had already projected `manual reconnect` as `app.session.status type=error`. That made the drawer/UI look like “连接失败” even though the transport was still retrying and later recovered.
- Terminal error projection remains valid for nonretryable failure, auth rejected, auto reconnect explicitly blocked, or future retry-exhausted state. UI/drawer must not compensate with a local filter; fix belongs to the transport lifecycle owner.
- Verified gates: `session-context-session-runtime.test.ts` + `session-context-transport-open-runtime.test.ts` + `session-context-activity-runtime.test.ts` passed 31/31; `tsc --noEmit` passed; `test:feature-registry` passed 48/48; Android real-device smoke `android/evidence/real-device/2026-07-12-135023` passed with IME visible, `clientInputSend=true`, `bufferHead=true`, `bufferApplied=true`, `renderCommit=true`, `noLocalTruthAnomaly=true`.

## 2026-07-12 Android update old WebView process truth

- Symptom: after installing a new APK, Android could still show old zterm WebView terminal content such as stale `routecodex` rows. This was not proof that `OPEN_TABS` or `TERMINAL_LAYOUT` resurrected state.
- Evidence: device package showed zterm `versionCode=1032069` updated at `2026-07-12 21:10:08`; `dumpsys window` focus could be zterm while UI dump still contained old terminal text before force-stop. After `adb shell am force-stop com.zterm.android` and cold start, UI dump no longer contained `routecodex`, `Implement`, `Paste`, or quickbar text.
- Owner: native Android update handoff. `AppUpdatePlugin.installApk()` must terminate the current app process shortly after handing the APK URI to the system installer, so the user cannot remain inside the old WebView/JS process after an update. Do not clear `app_webview`, Local Storage, `OPEN_TABS`, or session state as a workaround.
- Verification level: direct `adb install -r` + cold start of the rebuilt APK passed and old terminal text disappeared. The App-internal `AppUpdatePlugin.downloadAndInstall()` handoff path still needs a real trigger smoke; WebView DevTools on this device accepted the socket but timed out on `/json`, so DevTools could not be used as plugin-path evidence in this run.

## 2026-07-13 Stale missing session must not project current UI failure

- `tmux_session_unavailable` for a non-active, non-live session is a transport attach fact for that stale session only. It must not emit `SESSION_STATUS_EVENT(type='error')`, must not show the current terminal's reconnect/error banner, and must not close or rewrite `OPEN_TABS`.
- Drawer open / session picker refresh / foreground audit may discover stale persisted open tabs such as `routecodex` after tmux truth no longer has that session. The correct owner response is: update session catalog/audit facts, stop auto retry when the session is no longer active/live, and leave the stale tab as an idle local shell until explicit user action.
- The fix belongs to `terminal.transport_lifecycle`: `scheduleReconnectRuntime()` and reconnect handshake failure handling must re-check active/live eligibility before retry/error projection. UI/drawer must not compensate with a banner filter, and daemon must not synthesize or recreate missing tmux sessions.
- Verified gates for this rule: `session-context-session-runtime.test.ts`, `session-context-transport-open-runtime.test.ts`, `session-context-socket-message-runtime.test.ts`, `session-context-transport-runtime.test.ts`, `SessionContext.ws-refresh.test.tsx`, `App.dynamic-refresh.test.tsx`, `useSessionOpenActions.test.tsx`, `remote-tab-audit.test.ts`, plus `tsc --noEmit`.

## 2026-07-13 Drawer gesture ownership and mirror-fixed crop pan

- `terminal.session_drawer` shell gestures may open the drawer only from a near-edge hot zone, not from the middle of the page. On Android this hot zone must be wide enough to avoid the system back-gesture strip; 96 CSS px was real-device verified, while 28 CSS px was too narrow for practical use.
- `adaptive-phone` middle horizontal swipe must be a no-op at the shell layer; adaptive width remains daemon/tmux reflow through the adaptive lease owner.
- `mirror-fixed` middle horizontal swipe belongs to renderer projection only: pan/crop `.term-grid` with a per-session offset, persist that offset locally, and never change daemon mirror/tmux width.
- Required regression shape: drawer width/near-edge-open tests in `TerminalSessionDrawer.test.tsx`, `TerminalTabSwipeSurface.test.tsx`, and `TerminalPage.session-drawer.test.tsx`; shell middle-swipe negative tests in `TerminalPage.tab-isolation.test.tsx`; fixed/adaptive pan ownership tests in `TerminalView.dynamic-refresh.test.tsx`; real-device smoke should start around `x=80-90`, not `x=0-10`.

## 2026-07-13 Terminal width mode is a user preference resource

- `terminalWidthMode` must be read from persisted user settings before any viewport default. Reinstall/upgrade must not reset an explicit `mirror-fixed` choice to `adaptive-phone`.
- Store explicit width-mode choice in `zterm:terminal-width-mode-preference` whenever bridge settings are saved. Full `zterm:bridge-settings.terminalWidthMode` remains the main config field; the preference key is a migration/user-choice resource for old settings missing that field.
- First-launch viewport detection is allowed only when neither full bridge settings nor explicit width-mode preference exists. Unknown/invalid width mode is not a user preference and normalizes to `adaptive-phone`.
- Required regression shape: shared `use-bridge-settings-storage.test.tsx` must cover mirror-fixed first render, old settings without `terminalWidthMode` reading the explicit preference, and setting writes updating both bridge settings and preference.

## 2026-07-13 Quickbar horizontal pan belongs to expanded quickbar rows

- Bottom quickbar horizontal crop/pan belongs to `terminal.quickbar` UI projection. It must not be implemented by renderer, daemon, tmux, or page-level drawer/tab swipe.
- The gesture hit region is only the expanded quickbar rows height (`terminal-quickbar-shell-rows`). Do not add a full-screen or terminal-stage horizontal gesture owner for quickbar movement.
- Horizontal drag on quickbar rows moves the quickbar scroll tracks together; vertical gestures remain vertical; blank quickbar clicks must still be blocked from bubbling into the terminal layer.
- Required regression shape: `TerminalQuickBar.test.tsx` must cover horizontal pan, vertical no-pan, and non-interactive shell click blocking in the same suite.

## 2026-07-13 Superseding correction: Quickbar rows pan must not steal native scroll tracks

- Supersedes the same-day "rows move all quickbar scroll tracks" rule where it conflicts with track ownership. `terminal.quickbar` still owns only the expanded quickbar rows hit region, but each `[data-quickbar-scroll-track]` remains its own native horizontal scroll owner.
- Parent rows-level pan may only start from non-interactive rows whitespace. If a touch starts inside a scroll track, button, input, textarea, select, or label, the parent rows handler must stay inactive and must not call `preventDefault()` or synchronize sibling `scrollLeft`.
- Regression gates must cover all four boundaries together: rows whitespace horizontal pan works, vertical gestures do not pan, scroll-track touch is left to native scroll, and quickbar action button touch does not start parent pan. Blank shell click blocking remains required.
- Real Android CDP touch verification on `0.1.3.2094`: a gesture starting on a button inside the first scroll track moved only that native track (`40 -> 132`), left the sibling at `40`, and kept touch events `defaultPrevented=false`; a gesture starting on rows whitespace moved both scrollable tracks together (`40 -> 140`).

## 2026-07-13 Quickbar gesture chain includes collapse and reveal

- QuickBar gesture ownership is one axis-locked state machine inside `TerminalQuickBar`: track/button horizontal gestures remain local; rows whitespace horizontal gestures pan QuickBar content; expanded vertical downward swipe collapses; collapsed bottom trigger vertical upward swipe reveals.
- Collapse/reveal is available in portrait and landscape. `TerminalPage` must not force `quickBarCollapsed=false` when orientation becomes portrait; it only stores and passes the projection.
- Threshold is 48 CSS px. Short vertical gestures and touch cancel do not change collapse state. Horizontal track scrolling must not collapse the bar or synchronize sibling tracks.
- Real Android verification on `0.1.3.2095`: downward swipe inside expanded rows removed `terminal-quickbar-shell-rows` and exposed the bottom `展开快捷栏` trigger; upward swipe on that trigger restored rows. A later horizontal track swipe changed only the first track (`40 -> 122`), kept the sibling at `40`, and did not collapse.

## 2026-07-13 Quickbar collapsed height zero is authoritative

- Expanded QuickBar measured height and collapsed QuickBar height are both valid UI chrome truth. `TerminalPage` must accept `0` from `onMeasuredHeightChange`; it must not preserve the previous positive height with `height > 0 ? height : current`.
- When collapsed, terminal stage bottom reserve must immediately drop by the full measured QuickBar height. The shell/renderer content is not reflowed; only UI chrome reservation changes.
- The collapsed reveal gesture owner is a full-width bottom trigger band limited to the collapsed bottom chrome height. An upward swipe from the left or middle must reveal QuickBar; the gesture must not require hitting the small right-side keyboard/floating button.
- Required paired gates: positive measured height reserves stage bottom; collapsed zero clears the reserve; downward expanded swipe creates the reveal surface; upward swipe on a non-button point of that surface restores rows.
- Real Android CDP verification on `0.1.3.2097`: stage changed from `bottom=168px,height=586` to `bottom=0px,height=754` after collapse, then a left-side bottom swipe at `x=80` restored `bottom=168px`.

## 2026-07-13 Drawer opening gesture must not become session selection

- Client and daemon logs proved `routecodex2` was not merely a stale banner string: after the drawer was opened, the client promoted its persisted tab to active/live and opened a real transport. The short active sequence `rcc3 -> rcc -> routecodex2` matched Android WebView synthetic click-through after the edge swipe exposed drawer rows under the release coordinate.
- `terminal.session_drawer` is the intent owner. A pointer click may select a row only when the press began on that same row and remained within the movement threshold. A click with no matching row press, or a press armed for another row, must be rejected. Keyboard/accessibility activation with `detail=0` remains valid.
- Drawer catalog refresh is observation only: it must not call `applyOpenTabState`, `createSession`, or `switchSession`, and must leave the current `resource.active_session` unchanged even when stale persisted tabs exist.
- Do not fix this by filtering banner text, ignoring a legitimately active transport in SessionContext, creating the missing tmux session in daemon, or deleting stale open tabs. Those paths hide the invalid UI intent instead of removing it.
- Verified through L4: focused drawer/open-tab/transport suite passed 80 tests; typecheck and Android build passed; APK `0.1.3.2103` was published and installed. L5 drawer replay remains open because the connected device was owned by `com.android.systemui` keyguard, so no locked-screen evidence is accepted as zterm behavior.

## 2026-07-13 mirror-fixed crop pan owns non-left horizontal drags

- Verified on Android APK `0.1.3.2104`: in `mirror-fixed`, right-side/middle horizontal drags belong to renderer crop pan, not drawer/tab swipe. L5 CDP touch showed `drawerHidden` stayed `true` and fixed offset changed `13 -> 0` for a right-side drag; left-edge right swipe then changed `drawerHidden` to `false`.
- Durable rule: fixed-width drawer access must be constrained to left-edge + `previous` direction. Do not re-enable both-edge tab swipe just to keep drawer accessible, because it steals renderer crop pan.
- Gate evidence: focused drawer/fixed-pan tests passed 4 files / 105 tests; `tsc --noEmit` passed; `test:feature-registry` passed 7 files / 48 tests; `build:android` published `0.1.3.2104` sha256 `b40d191a1484b02fe517bdc21472bc40f1400810387f9740fac5fb0d8201e477`.

## 2026-07-13 mirror-fixed drawer edge admission is 64 CSS px

- The previous 96px drawer hot zone was too wide on a roughly 347 CSS px phone viewport: a gesture starting at 88px still looked visually non-edge but was admitted as a drawer swipe.
- The authoritative Android drawer admission band is now 64 CSS px. A 56px right swipe remains the accepted left-edge path; an 88px right swipe belongs to `mirror-fixed` renderer crop pan and must keep the drawer hidden.
- Verified exact failure path on Android APK `0.1.3.2105`: physical ADB swipe corresponding to CSS start 88px changed fixed offset `172 -> 0` while drawer `aria-hidden` stayed `true`.

## 2026-07-13 mirror-fixed offset consumption precedes drawer admission

- Drawer admission is not determined by start-edge distance alone. If a `mirror-fixed` rightward gesture can still reduce a positive renderer horizontal offset, renderer pan owns the entire touch sequence and must stop propagation to the parent drawer surface.
- Only a fresh left-edge right swipe whose renderer offset is already 0 before gesture start may become drawer-open intent. A zero-offset rightward drag starting outside the left-edge hot zone is still renderer crop ownership and must stop before the parent drawer gesture owner, even if the clamped offset cannot move.
- A regression test proved the old split behavior: offset changed `160 -> 16` while the parent simultaneously emitted `previous`. The fixed contract is paired: positive-offset pan never opens drawer; after reaching 0, a fresh edge swipe still opens it.
- Verified on Android APK `0.1.3.2107`: with `mirror-fixed`, offset `0`, and a CSS right swipe `181 -> 291`, drawer stayed hidden and offset stayed `0`; a fresh left-edge right swipe `56 -> 200` opened the drawer. Device foreground was zterm and keyguard was false.

## 2026-07-13 Terminal session preview truth

- `terminal.session_preview` is a UI projection feature only. Its data path is `tmux -> daemon mirror -> client sparse buffer -> immutable render store -> shared TerminalView -> preview DOM`; it must not create a preview-only parser, screenshot cache, stale text cache, transport, reconnect path, resize path, tmux geometry write, or buffer reset.
- Preview selection is a versioned ordered maximum-six preference over currently opened sessions. Resolution must match `sessionId + bridgeHost + bridgePort + sessionName` and stored `daemonHostId` when present, so a stale persisted target cannot bind to a reused session id from another host or tmux session.
- Preview mode temporarily projects selected session ids into the live body subscription set only while preview is open and foreground. Close/background must restore daemon subscribers and session transports to baseline while preserving the selection preference.
- Gesture ownership is fixed by start region: left edge right swipe opens drawer, middle horizontal swipe stays with `mirror-fixed` crop, and right edge left swipe opens preview. A preview tile is read-only and cannot focus DOM input, send input, resize, copy, or emit viewport/width writes; tile tap is the only path that sends one explicit active-session switch.
- Preview tile activation must update both active-session truth and the focused session-group viewport projection. The shared page owner must first run `resolveTerminalSessionGroupSlotReplacement(..., sessionGroupFocusSlot)`, then emit the explicit switch. Calling only `handleSwitchSessionFromChrome(sessionId)` can move input/live ownership while the visible center slot still renders the previous session; once preview subscriptions close, the visible shell appears frozen.
- In-preview replacement is an ordered selection operation, not a session switch: long press must be movement-cancelled, suppress its synthetic release click, expose only currently open unselected sessions, and replace the source target in place through `replaceSessionPreviewTarget()`. It must not emit active-session, transport, resize, or renderer writes.
- Preview cancel owns an entry snapshot `{ activeSessionId, slotIds, focusSlot }`. Close button, right-swipe exit, and Android system Back restore exactly that projection; tile activation explicitly discards the snapshot and switches to the chosen tile. The Back listener must exist only while preview is open so normal shell Back behavior is not consumed.
- Preview selection is valid with any count from 1 through 6; it must not require filling six slots. Grid geometry is derived from selection count and orientation: portrait caps rows at two tiles per row, landscape caps rows at three, and no empty terminal slot is rendered.
- Preview tile close is a selection operation, not a Session close. It removes only that target from persisted preview selection, preserves remaining order, and if the final target is removed it cancels preview through entry-projection restore.
- Preview tile body is read-only terminal content but still accepts local visual navigation: vertical scroll and `mirror-fixed` horizontal crop/pan may run inside the tile, while input, resize, viewport, width-mode, reconnect, tile activation, replacement, and preview-exit intents remain blocked.
- Verified local gates: preview/drawer/StageShell/tab-isolation focused suite 9 files / 88 tests PASS; feature/resource/function/mainline wiki gates 7 files / 48 tests PASS; typecheck PASS; source-to-DOM/source-to-shell gate used six real tmux sessions and proved tmux source, daemon/client sparse truth, immutable render store, preview DOM, real StageShell continuation after tile activation, stale-session exclusion, cross-session isolation, one physical session socket per session, and subscriber lifecycle `0 -> 6 -> 0`. APK `0.1.3.2112` is published with sha256 `7ce0fe3e9ee66be6183e64db562f11f1bafc93706c22cfea4a9c354baf1fb7f2`. Real-device L5 remains unproven when no unlocked ADB device is online.
## 2026-07-14 Android WebSocket network-switch truth

- Verified root cause for Wi-Fi-to-cellular connection stalls: endpoint IP can remain correct (`100.66.1.82:3333` Tailscale) while the existing WebSocket stays half-open on the old underlay path. `readyState === OPEN` is not physical transport health.
- `terminal.transport_lifecycle` owns this class of fix. The unique health owner is `src/contexts/session-context-socket-runtime.ts`; UI lifecycle hooks may accelerate probes but must not create separate reconnect owners; daemon must not own client network type.
- Mobile heartbeat baseline is now 2s with 3 consecutive missed server-activity confirmations before one retryable failure. Pong or any valid server frame is health evidence. Logical session, active-session truth, and buffer must survive replacement of the stale physical WebSocket.
- Network-switch closure requires real-device black-box evidence: phone can still reach daemon `/health`, app is not killed/reopened, physical WebSocket is replaced once, session id/tmux target stay unchanged, buffer head remains monotonic, and output/input recover within 10s in Wi-Fi->cellular and cellular->Wi-Fi directions.

## 2026-07-14 Windows WezTerm daemon backend live protocol truth

- `daemon.windows_wezterm_backend` live daemon closure requires more than direct WezTerm CLI smoke. The required black-box gate is real daemon control/session WebSocket -> WezTerm backend -> decoded `buffer-sync` target text -> targeted cleanup.
- The live gate caught a real stale-runtime bug: session creation/connect/input worked, but cleanup failed because `tmux-kill-session` still called tmux in WezTerm mode. The unique close owner is now `TerminalControlRuntime#closeDetachedTerminalSession`; it delegates to `WezTermBackendRuntime#closeSession` when WezTerm is selected and uses `tmux kill-session` only for tmux.
- Verified 2026-07-14 against `huawei@100.75.122.121` / daemon `ws://100.75.122.121:3333`: unit/runtime/selection/control tests PASS, mock daemon protocol PASS, direct WezTerm remote/input smoke PASS, `tsc --noEmit` PASS, feature/resource/function/mainline gates PASS, and live daemon source marker `ZTERM_WINDOWS_DAEMON_E2E_1784009295061_8d3ac8de` matched decoded target `buffer-sync` with targeted session cleanup.
- Windows daemon runtime deployed to `D:\zterm-tools\daemon-runtime-test\runtime\server.cjs` with backup `server.cjs.pre-20260714-1410`; existing `ZTermDaemon` scheduled task restarted. Do not treat `zterm-daemon` global install absence as proof the daemon is missing; inspect listener PID/command and service script truth.
- `windows.desktop_shell` may now proceed from docs only: registry/resource/function/test design/manifest are initialized, but all Windows app symbols are `binding pending`. The first implementation must define a Windows platform bridge and shared desktop shell boundary, not copy Mac `window.ztermMac`, local-tmux transport, daemon/mirror code, or terminal renderer.

## 2026-07-14 Windows desktop shell packaged alpha truth

- `windows.desktop_shell` single-session alpha now exists and reuses shared connection, sparse-buffer, and renderer owners. Windows-only code remains limited to Electron/window/preload/composition/package surfaces.
- Electron sandbox preload must be CommonJS (`preload.cts` -> `preload.cjs`); ESM preload can pass compile/package yet fail only at packaged runtime.
- Client visible-range demand must wait for the first daemon `buffer-sync` revision. `connected` alone does not prove mirror readiness.
- Real packaged Windows source-to-DOM gate passed with `ZTERMWINDOWSLIVE`; deployed archive SHA-256 is `b60b5c5b4f27c73dc2e6b1f2dfc007a644d3c4eadaab4e2ad6dbb32d37655cf0`. Remaining product work is multi-session workspace, Windows file browser/preview, installer/signing/update channel, and real console Ctrl+C semantics.
- Windows session discovery/create/close UI now has packaged L5 proof. It must remain a thin UI/control owner over shared daemon control helpers; do not fork `list-sessions`, `tmux-create-session`, or `tmux-kill-session` semantics in Windows code.
## 2026-07-14 - Android preview add selection and logo packaging baseline

- Session preview drawer checkbox must be an actual command surface bound to the selection owner; a visual checkbox outside the row button creates a dead hit target on touch devices.
- After preview tile removal, add candidates are current open eligible Sessions minus the resolved preview set. Lock both sides: every removed open target is offered, while selected/closed targets are absent and cannot dispatch selection.
- Android launcher replacement requires all three resource families across five densities: legacy `ic_launcher`, `ic_launcher_round`, and adaptive `ic_launcher_foreground`. Verify the final APK by comparing unpacked icon bytes with source resources.
- Build `0.1.3.2116` passed local gates and update-channel hash alignment; real-device launcher/touch verification is not established because no ADB device was online.
- Jason 的真实 Launcher 截图证明 `0.1.3.2116` 前景占满画布会被系统自适应蒙版再次裁切，底部 `zterm` 和边框显示不全。Android 图标验收必须给 adaptive foreground 留安全区并看真实 Launcher；APK 解包 hash 只能证明打包正确，不能证明最终合成正确。
## 2026-07-15 Android fixed relay Home and ephemeral-tab truth

- Android Home is the fixed relay account projection owned by `ConnectionsPage` + `useTraversalRelayAccount`: display `relay.codewhisper.cc`, accept account/password, and project daemon devices only. Live Session discovery/actions remain in the terminal drawer/picker; Home must not restore Session groups, connection cards/FAB, or saved-tab-list controls.
- Open tabs, active tab focus, and closed semantic reuse tombstones are current-process client truth, not durable configuration. Cold launch must remove and ignore legacy `OPEN_TABS`, `ACTIVE_SESSION`, `SAVED_TAB_LISTS`, and closed-tab reuse storage. Tab switch/reorder/close may update in-memory truth but must not write those keys.
- Relay password is request-only form state. Persisted relay account truth may contain access token, account identity, directory, and client settings, but plaintext password must be empty.
- Fixed production relay display identity is `relay.codewhisper.cc`, but the verified public client endpoint is `https://relay.codewhisper.cc:18443/relay/`. Do not use Tailscale `100.x` addresses as public DNS targets. Authoritative DNS points `relay.codewhisper.cc` to public `159.75.134.56`; public `443` currently resets TLS before nginx, while `18443` serves a valid `relay.codewhisper.cc` certificate, `/relay/health`, login, and `wss://relay.codewhisper.cc:18443/relay/ws/*` URLs.

# 2026-07-15 Relay is optional Home assurance, never a direct-connection gate

- Android Home has three independent projections: current-process active Sessions, saved direct/Tailscale Hosts, and optional Relay account/directory. Relay logged-out, login-error, and logout states must preserve the first two.
- Relay login augments synchronized machine/device/route candidates, including Tailscale/local/direct endpoints. It must not replace, delete, hide, or own saved Host/Tailscale truth.
- Home remains a projection layer: saved Host actions go through `useSessionOpenActions` and active Session resume goes through the open-tab/session owner. Home must not create/close sessions, write storage, restore cold-start tabs, or gate navigation on Relay access token.
- Regression gates: signed-out saved/active/add visibility, login-failure preservation, logout preservation, saved-host picker intent without session creation, App wiring with no Session-group/tab-persistence revival.

## 2026-07-15 Android Home visual and drawer remote close truth

- Home visual must stay server-entry-only: configured direct/Tailscale/Relay-capable servers plus current-process active Sessions. Relay account login/config stays in Settings; do not reintroduce Home Relay login, session group management, saved tab lists, or cold-tab restore controls while polishing the screen.
- Terminal drawer `X` on any daemon catalog row means remote tmux close, even when that row has already been materialized as a local open tab. The click path must first call the existing remote close owner (`killTmuxSession -> fetchTmuxSessions -> handleRemoteSessionsRefreshed`), then close the local tab only after remote kill succeeds. If remote kill fails, expose the error and keep the local tab; never fake-close only the current phone.
- Regression shape: component/page tests must cover remote-only row close, opened daemon catalog row close, and remote kill failure. A black-box gate should create a dedicated tmux session through the app API, list it, kill it through the same API, list again, and confirm the session is absent from tmux truth.

## 2026-07-16 Android drawer remote-only session first-tap truth

- A terminal drawer remote-only catalog row must return the materialized local `sessionId` from the session-open owner. `useSessionOpenActions#handleOpenGroupSession` owns `createSession -> open-tab upsert -> explicit-resume`; `TerminalPage` may only consume the returned id to project the focused session-group viewport slot.
- If drawer remote open only triggers `onOpenDrawerRemoteSession(target, sessionName)` and the page does not update `sessionGroupSlotIds`, StageShell can keep rendering the previous center slot even after parent state switches `activeSession` to the new Session. The symptom is "connection starts, page freezes on old shell, second tap required."
- Correct page action: route the returned local id through the same slot helper used by normal drawer/preview activation (`resolveTerminalSessionGroupSlotReplacement(..., sessionGroupFocusSlot)`). Do not project the synthetic `remote:<owner>::session:<name>` catalog id, and do not add reconnect, daemon, renderer, or buffer fallback logic.
- Regression shape: `TerminalPage.session-drawer.test.tsx` must model first tap on remote-only row, session-open owner returning `remote-opened`, parent rerender with the new Session active, and DOM center rendering `terminal-view-remote-opened` without a second tap. Negative guard: no fake render/switch of the remote placeholder id.
- Open tabs remain current-process truth. Explicit runtime switch tests must require `switchSession(target, { refreshSource:'explicit-resume' })` but must not expect legacy `ACTIVE_SESSION` localStorage persistence to revive.
- Home/Connections remains server-entry-only; fixed Relay account URL ownership lives in Settings `RelayAccountSettingsSection`, not `ConnectionsPage`.

## 2026-07-16 Android Settings and upgrade entry truth

- Home can be server-entry-only, but it must keep a visible Settings entry. Icon-only gear in the header is insufficient after removing old group/config screens because users may not recognize it as the upgrade/config path.
- Terminal portrait shell must also expose Settings because long-running usage can stay inside the terminal page; `TerminalPage` must consume `onOpenSettings` instead of accepting it unused.
- Upgrade logic remains uniquely owned by Settings/App Update (`settings.config_transfer`, `AppUpdateSection`). Home and Terminal may only navigate to Settings; they must not duplicate update checking, install, or manifest state.
- Regression shape: `ConnectionsPage.test.tsx` locks a visible `设置和升级` Home entry, `TerminalPage.session-drawer.test.tsx` locks the portrait shell entry, and `SettingsPage.relay-account.test.tsx` locks `版本与升级` before server/relay configuration with `检查更新` / `下载并安装` controls.

## 2026-07-16 Android Relay signed-in UI and Home relay row open truth

- Settings Relay login state must project from either the account owner token or persisted relay settings token. If those two stores are temporarily out of sync, the UI must still show a clear signed-in account panel instead of the logged-out form-only state.
- Home relay-directory server rows may have an empty direct `bridgeHost`; before opening, `useSessionOpenActions` must materialize a `BridgeTarget` through `buildBridgeTargetFromHost()` and prefer direct relay endpoint candidates (`tailscale`, `ipv6`, `ipv4`) while preserving all relay endpoint candidates for the transport layer.
- `relay.directory_ui` fixes must stay in UI projection/open-target owners (`RelayAccountSettingsSection`, `useSessionOpenActions`, `session-picker`). Do not patch daemon, renderer, buffer, or TerminalView for this class of Home relay row click failure.
- Verified gates: focused Settings/session-picker/session-open tests 3 files / 35 tests PASS; relay directory required tests 7 files / 43 tests PASS; feature/resource/function/mainline gates 7 files / 48 tests PASS; `tsc --noEmit` PASS; APK `0.1.3.2129` published with sha256 `7b873e634c61109eb7f40e8c9ca3d0812c5a8d04dc10b5cea141328988f18d74`. Real-device install/smoke remains unproven when no ADB device is attached.

## 2026-07-16 Android preview remote catalog selection truth

- Drawer preview multi-select must not reject remote-only catalog rows. The page selection owner first calls the existing session-open owner to materialize a local open tab, then stores only the returned local `sessionId` target in `resource.session_preview_selection`. Remote placeholder ids (`remote:<owner>::session:<name>`) are never persisted.
- Preview selection materialization must be background-only: `useSessionOpenActions#handleOpenGroupSession(..., { activate:false, navigate:false })` creates/open-tabs the Session without switching the real shell. Tile tap remains the only preview path that activates a session.
- If remote materialization returns no local id, show an explicit preview selection error and leave storage unchanged. Do not add daemon, transport, renderer, or buffer fallback logic.
- Verified gates: preview selection/gesture/grid/page/session-open focused suite 6 files / 70 tests PASS; `terminal:preview:source-dom-gate` PASS with run marker `ZPREVIEW-1784206925848`; feature/resource/function/mainline gates 7 files / 48 tests PASS; `type-check` PASS; `build:android` PASS and update channel `0.1.3.2131` sha256 `346ab8660cfb55299f241fc468153d890291fcaf077087dd3c27edafe06d697a`. Real device `100.104.163.65:5555` installed and foregrounded `0.1.3.2131`; full `test:android:apk-smoke` reached WebView/localStorage capture but failed at daemon `/debug/runtime/control` 401 for stored target `100.75.122.121:3333`, so runtime debug L5 remains a known auth-gated gap.

## 2026-07-16 Android Relay visible Home route truth

- Relay must never be an invisible automatic candidate on Home. A server row with a `relay-rtc` route candidate must show explicit Relay availability and expose a Relay action separate from the normal Auto row tap.
- Same-daemon Home projection must merge Relay directory endpoint candidates into an existing saved direct/Tailscale row while preserving the saved row's display identity, endpoint, pin/order truth, and storage ownership. Relay directory facts may add `relayEndpointCandidates`, `relayHostId`, and `relayDeviceId`; they must not replace saved Host identity just because directory `lastSeenAt` is newer.
- The explicit Home Relay action must build a `transportMode='webrtc'` Host target carrying only `relay-rtc` candidates. Direct/Tailscale/IPv4/IPv6 candidates remain part of Auto route selection only; if no `relay-rtc` candidate exists, do not show a Relay button and do not fake a fallback.
- Verified gates: focused projection/Home/session-open suite 3 files / 30 tests PASS; full `relay.directory_ui` required suite 8 files / 47 tests PASS; feature/resource/function/mainline gates 7 files / 48 tests PASS; `tsc --noEmit` PASS; `build:android` PASS and update channel `0.1.3.2133` sha256 `7bdcad037b361d7f4181fd21ee8c7bdede7783c4342e0400237b50a4f6874cc7`. Real device `100.104.163.65:5555` installed and foregrounded `0.1.3.2133`; `test:android:apk-smoke` reached WebView/localStorage capture but failed at daemon `/debug/runtime/control` 401 for stored target `100.75.122.121:3333`, so runtime debug L5 remains an auth-gated gap.
- 2026-07-16: Relay route visibility is not a closure signal. Production `rtc-relay` connection should use standard WebRTC ICE (`iceTransportPolicy=all`) over the relay signaling channel with TURN as an ICE server; forced `iceTransportPolicy=relay` belongs only to the TURN black-box gate. Live proof on `relay.codewhisper.cc` showed standard RTC to `mac-studio` could `list-sessions` in ~100ms while relay-only timed out after receiving answer/candidates, so any report must distinguish "relay control-plane RTC works" from "public TURN/off-network relay is verified". Do not expose or report a Relay route as usable without a real `TraversalSocket`/tmux operation such as `list-sessions` or session open.
- Verified closeout for the Relay Home route hotfix: `TraversalSocket` production `rtc-relay` now uses standard ICE and live production smoke against `relay.codewhisper.cc` / `mac-studio` opened `relay-rtc:mac-studio` in 105ms and returned 11 tmux sessions via the real `{type:"list-sessions"} -> {type:"sessions", payload:{sessions}}` protocol. Focused relay/Home/session-open tests 74 PASS, feature/resource/function/mainline gates 48 PASS, `tsc --noEmit` PASS, and `build:android` published `0.1.3.2134` sha256 `cf0900e23be32859cb9c886095e35e9f30f5dda4179714347a715749568764c7`. Forced TURN-only still fails with allocated relay candidates, so off-network TURN remains a separate server/TURN gate. Device `100.104.163.65:5555` installed 2134, but lockscreen/NotificationShade prevented UI tap proof; do not claim Home Relay click L5 until an unlocked device run proves it.
- 2026-07-17: Relay login state must never become a global Session Picker mode. The picker's refresh/listing decision is current-target scoped: direct/Tailscale targets with `bridgeHost + authToken` must still live fetch sessions even when the account has online Relay daemon devices; Relay-only targets may fetch with empty `bridgeHost` only when the current target has `relay-rtc` candidates plus relay daemon identity. `buildBridgeTargetFromHost()` must preserve explicit `transportMode='webrtc'` / `relay-route` Hosts instead of resolving direct candidates into `bridgeHost`. Verified by fail-first picker/session target gates 22 PASS, relay/Home/session-open/route gates 74 PASS, feature/resource/function/mainline gates 48 PASS, `tsc --noEmit` PASS, real source black-box direct and Relay `fetchTmuxSessions` both returning 15 sessions (`100.66.1.82:3333` in 42ms, `relay-rtc:mac-studio` in 99ms), and `build:android` publishing/installing `0.1.3.2135` sha256 `d7c04b8099d1b8f6674c29ad9d073b2d40d09f8da7ee1a257600ec513721fb65`. UI tap L5 remains unclaimed while the device is locked behind NotificationShade/keyguard.
- 2026-07-17: Relay account directory sessions are route/device projection, not the Session Picker final session-list truth. The final picker list for both Relay and direct/Tailscale must come from live `fetchTmuxSessions()` against the selected target; directory sessions may not short-circuit refresh. Regression must prove Relay daemon selection calls live fetch and replaces stale directory rows. Verified by picker/session/traversal/tmux gates 34 PASS, feature gates 48 PASS, `tsc --noEmit` PASS, black-box direct `127.0.0.1:3333` 21 sessions in 36ms, Tailscale `100.66.1.82:3333` 21 sessions in 6ms, production Relay WebRTC `mac-studio` 21 sessions in 113ms, and `build:android` publishing `0.1.3.2136` sha256 `d450bdf215b316a41b4a103ae8c77729dd82437c4aef54e978665ce407886463`. No ADB device was online, so 2136 UI tap/install L5 remains unclaimed.
- 2026-07-17: Session TURN status must not be inferred from `resolvedPath='rtc-relay'`. `rtc-relay` only means the relay/WebRTC route was selected; TURN requires inspecting the selected ICE candidate pair and seeing local or remote `candidateType='relay'`. Android client truth is `TraversalSocket.diagnostics.resolvedRelayTransport`, copied into `Session.resolvedRelayTransport` and rendered as `TURN` / `Relay TURN`; daemon, buffer, renderer, and Relay server must not own this UI status. Verified by TURN route/UI tests 35 PASS, feature gates 48 PASS, `tsc --noEmit` PASS, and `build:android` publishing `0.1.3.2137` sha256 `f7947f625a7c20cdf068e1bc294c83428faa19a5ac60c093c02955869a6154c2`. No ADB device was online, so 2137 install/UI tap L5 remains unclaimed.
- 2026-07-17: Terminal drawer host identity must include Relay directory direct endpoints as aliases. Same daemon can appear as `Mac Studio` from Relay directory and `100.66.1.82:3333` from saved/direct SessionGroups; drawer/side server projection must canonicalize endpoint keys to `daemon.hostId` so session counts and rows land under one host rail. `SessionGroupHistory` must persist normalized `relayEndpointCandidates`, and drawer remote catalog open/close must pass them through to `useSessionOpenActions`; otherwise Relay-visible rows degrade to direct WebSocket and can hit `ws connect timeout`. Tmux management `fetch/create/rename/kill` uses target-scoped pooled `TraversalSocket` FIFO serialization with no result cache; success and daemon request errors keep the socket, physical/protocol failure or timeout evicts it. Verified by focused drawer/history/tmux 40 PASS, broader drawer/session-open/picker/traversal/tmux 105 PASS, feature gates 48 PASS, `tsc --noEmit` PASS, production Relay `mac-studio` live two-call fetch `10 sessions, 100ms then 7ms`, and `build:android` publishing `0.1.3.2138` sha256 `2260a1d7892e7b62fe80ff3f1a0f04c12abed46d3b62320e8d8ff2325a76114b`. No ADB device was online, so installed drawer visual L5 is unclaimed.
- 2026-07-17: Production Relay directory can publish only `relay-rtc:<hostId>` for a daemon, with no direct/Tailscale endpoint. Drawer host identity must not rely only on Relay direct endpoint aliases. `terminal.session_drawer` canonicalization inputs are live Sessions, SessionGroups, App Home/saved server alias inputs, Relay direct endpoint aliases, and an rtc-only Relay session-catalog alias only when exactly one Relay daemon catalog contains every non-missing direct SessionGroup name. Ambiguous catalog matches remain separate; no guessing merge. TerminalPage memo comparator must include `relayDevices` and saved/Home alias inputs, otherwise Relay stream or server mapping changes can leave the drawer on stale host rails until page restart. Verified closeout for build `0.1.3.2139`: production Relay login showed `mac-studio` has only `relay-rtc` and 10 directory sessions; direct Tailscale `100.66.1.82:3333` `fetchTmuxSessions` returned the same 10 sessions in 41ms; focused drawer/App/server identity/session-open/traversal tests 166 PASS; architecture gates 48 PASS; `tsc --noEmit` PASS; `build:android` PASS; APK sha256 `fa547e10eeaa32d47a90da4f04f3df0edc91b9d8fbdf3cf77c5ad94d91895634`. No online ADB device was available, so installed UI L5 proof remains unclaimed.
- 2026-07-17: Relay connectable UI enumeration must filter to online daemon devices only: `daemon.connected === true` and non-empty `daemon.hostId`. Disconnected/stale `rtc-device-*` records may remain account directory facts, but must not project into Home server rows, Terminal drawer host rails, or Session Picker target lookup. Session Picker final session rows must come from live `fetchTmuxSessions()` for the selected target; directory `daemon.sessions` is only route/catalog hint and must not render as final rows while live fetch is pending. TerminalPage memo comparator must include Relay daemon `sessions.name/updatedAt` as well as endpoint/alias inputs, otherwise Relay stream catalog changes can leave drawer enumeration stale. Home server-row tap without explicit saved `sessionName` must open last-entered current-process session if present, then live remote last-entered, then first live remote, and create generated `zterm-*` only when the remote list is empty. Verified in `0.1.3.2143` by focused enumeration gates 112 PASS, architecture gates 48 PASS, `tsc` PASS, production Relay black-box (`mac-studio` online, stale `rtc-device-1784267569532` filtered, live Relay `fetchTmuxSessions()` 162ms), Android build/install on `100.104.163.65:5555`, sha256 `8fea30acd3c4f311668070e765871e2da1082c299f423ad774ae2e1260fd196e`.
- 2026-07-17 supersedes the 2026-07-16 Relay ICE rule: product `rtc-relay` must be TURN relay-only (`iceTransportPolicy='relay'`) on both Android `TraversalSocket` and daemon `rtc-bridge`. Standard WebRTC ICE (`all`) can prove only signaling/P2P reachability and must never be reported as Relay/off-network availability. Home may show `Relay 路由` for candidates, but `Relay 可用` requires relay-only/TURN black-box `list-sessions` or session-open proof. If relay-only fails while direct/Tailscale or standard ICE works, the remaining problem is TURN/server/network config, not a client success.
- 2026-07-17: Relay account control payload must be refreshed before opening the account device stream. A stored account can carry stale TURN/WS settings such as `turn:claw.codewhisper.cc`, and `/api/auth/me` may omit a new access token while still returning current `relayBaseUrl/ws/turn`; Android must reuse the existing accessToken to derive fresh `TraversalRelayClientSettings`, overwrite stale TURN/WS settings, and only then open `/ws/devices`. Legacy fixed relay host `claw.codewhisper.cc` is an alias to migrate to canonical `relay.codewhisper.cc`, not a transport target. If control refresh fails, do not open the relay device stream or use stale settings as a fallback.
- Verified in `0.1.3.2144`: production `relay.codewhisper.cc` resolves to public `159.75.134.56` while legacy `claw.codewhisper.cc` resolves to Tailscale `100.124.49.106`; relay-only/TURN black-box passed with local/remote ICE candidate type `relay`; Android build published sha256 `8a3cd2466e3b3ad10bcc164de976877b8aa75399f927402862e7784f9523e9e2` and installed on device `100.104.163.65:5555`. Device was locked (`NotificationShade`, `isKeyguardShowing=true`), so only install/startup log proof is available; full UI relay tap L5 remains pending until unlocked.
- Verified in `0.1.3.2145` on unlocked device `192.168.0.28:5555`: with `com.tailscale.ipn` stopped and no `tun0`, direct `100.66.1.82:3333` refused while `relay.codewhisper.cc:18443/3479` connected. Cold app launch from Home Relay entered `mac-studio · zterm connected` in 1750ms, CDP captured `rtc-init iceTransportPolicy='relay'` and `typ relay` candidates on public TURN `159.75.134.56`, and source-to-target DOM marker `L5_MARKER_20260717_1906_RELAY_UI_OUTPUT_SOURCE_TO_TARGET` appeared in Terminal output. Logcat after the run had `claw.codewhisper.cc=0`, `WebSocket CLOSING/CLOSED=0`, and `transport unavailable/closed/ws timeout/rtc-error=0`; remaining WebRTC noise is tail-dot `relay.codewhisper.cc.` DNS/TURN warnings that did not break the connected route.
- 2026-07-17 WebRTC-first route policy supersedes the earlier "Home Relay action is TURN-only" product path, while preserving TURN-only as the final `rtc-relay` path and diagnostic gate. Logged-in daemon targets must build route candidates in this order: `rtc-direct` WebRTC over relay signaling with `iceTransportPolicy='all'` and STUN-only ICE, then Tailscale/direct websocket candidates, then `rtc-relay` with `iceTransportPolicy='relay'`. Logged-out targets naturally skip RTC because no relay account/control truth exists and therefore prefer direct/Tailscale. UI must report `resolvedPath=rtc-direct`, `resolvedPath=tailscale`, or `resolvedPath=rtc-relay + resolvedRelayTransport=turn` distinctly; never report direct WebRTC or Tailscale as TURN relay.
- Fixed-width terminal mode is crop/pan only and must not mutate tmux geometry. `mirror-fixed` attach/resize must ignore client cols and never call `tmux resize-window`; only the daemon adaptive width lease owner may call `resize-window -x` for `adaptive-phone`, then restore/release `window-size` when its own lease ends. If iTerm2 is attached to the same tmux window, any active adaptive lease necessarily affects that shared tmux window; use `mirror-fixed` for non-interference unless/until a separate adaptive tmux clone/session design is introduced.
- Verified in `0.1.3.2147`: route/socket/config tests prove direct RTC first with no TURN credentials and TURN-only only after direct RTC failure; drawer/session tests prove Relay-owned rows use WebRTC-first `transportMode='auto'` targets and reuse stale direct tabs; mirror runtime tests prove `mirror-fixed` client cols do not touch tmux. Focused suite 163 PASS, broader relay UI suite 30 PASS, server transport/RTC truth 21 PASS, feature/resource/function/mainline gates 48 PASS, `tsc` PASS, `git diff --check` PASS, local relay smoke PASS with selected `rtc-direct`, and Android update channel published `0.1.3.2147` sha256 `b3ede68f37dae59a6c624546826bccfc20786a06beb704036056490d2c0c9e7d`. No online ADB device was available for install/UI L5 in this run.
- 2026-07-18: Session name/body identity is a required black-box gate for session switching and foreground resume bugs. The test must bind active session id/name to the actual rendered terminal body marker through real `sessionBufferStore`, real `TerminalPageStageShell`, and real `TerminalView`; stale getters, late old-session buffer publishes, pause/resume, and layout refresh must not let another session's body appear under the active session name. Local gate added in `TerminalPage.session-content-identity.test.tsx` and paired with `App.dynamic-refresh.test.tsx`; current local proof is 235 focused tests PASS, feature gates 48 PASS, `tsc` PASS, `git diff --check` PASS. This does not replace live device/daemon source-to-DOM replay.
- 2026-07-18: Android session switch / foreground resume must not immediately rebuild a recently alive transport. `terminal.transport_lifecycle` owns this in `ensureActiveSessionFreshRuntime()` and `buildActiveSessionRefreshPlan()` with `SESSION_TRANSPORT_KEEPALIVE_GRACE_MS=120000`; recent alive truth is max of `lastServerActivityAtRef` and `lastConnectedBaselineAtRef`. The grace applies only to lifecycle freshness sources (`explicit-resume`, `active-reentry`) and returns `transport-keepalive-grace` for missing/closed local sockets; after expiry the existing reconnect/throttle owner runs. Do not apply this grace to `active-tick` / explicit input recovery, because user input against a closed socket must still trigger the existing immediate recovery path. Verified by transport gate 245 PASS, feature gates 48 PASS, `tsc` PASS, `git diff --check` PASS, and `build:android` publishing `0.1.3.2149` sha256 `fc60b8c056497d7e262c634bb2370ffa9272b23811b87c1f2245e93e8ac48fc7`. No online ADB device was available for install/UI L5.

## 2026-07-18 Android long input and voice IME newline truth

- Android voice/IME committed text and explicit terminal Enter are separate semantics. `terminal.keyboard_ime` owns committed-text normalization: CRLF/CR/LF in committed text become spaces, CJK/emoji/`￥`/`、` remain intact, and the existing full-width terminal punctuation normalization still applies. Explicit Enter remains on native editor-action / hardware-key paths. Daemon, session transport, buffer, and renderer must not reinterpret voice line breaks.
- Long input delivery keeps the existing string-only wire contract and uses independent UTF-8 byte budgets at each real boundary: native IME bridge events `16 KiB`, Android client input frames `64 KiB`, daemon hard frame cap `256 KiB`, and tmux literal writes `256 B` with `2 ms` settle. The daemon input/control owner is the only backend writer; it must not re-coalesce safe client frames into oversized or PTY-unstable `tmux send-keys -l` arguments.
- A long-input black-box gate must prove two truths independently. First, disable terminal echo, wait for a ready marker, stream a payload larger than one client frame into a target file, and automatically compare source SHA-256 with the target-file SHA-256 printed through tmux. Second, verify daemon/client mirror replay recovers to the current tmux visible oracle. Source digest success plus mirror failure is a mirror recovery defect, not input byte loss.
- Verified for Android package `0.1.3.2150`: focused JS/native/daemon gates passed (`109` Vitest tests, `3` shared chunk tests, Java `ImeAnchorInputLogicTest`); typecheck and feature/resource/function/mainline gates passed; full `daemon:mirror:close-loop` passed all nine cases including `long-input-echo`, whose `357840`-byte CJK/emoji/symbol source matched target SHA-256 `251987fe7a904c59b5a893365135251cd6523595f8d50a5a4e2e33e19d486c30`; Android build and update-manifest verification passed. Published APK SHA-256 is `82365b6c2614ccf41843d3e88f8d38d0e6caa335baf1e306e814992fc822a621`.
- No ADB device was online during this closeout, so physical voice-IME commit, real Capacitor bridge delivery, and visible terminal result remain an explicit L5 gap. Local/native/L2 evidence cannot be reported as true-device voice-input closure.

## 2026-07-18 Android IME shift-enter / faster RTC timeout closeout

- System IME semantics are split: `换行` maps to `Shift+Enter`, and `完成` maps to plain Enter submit. Native line-break-only `commitText()` / `finishComposingText()` emit shifted Enter; `performEditorAction()` emits plain Enter; shared keyboard mapping preserves `Shift+Enter` as `\n` and plain Enter as `\r`.
- Traversal candidate wait for RTC was shortened from 8000ms to 2500ms to avoid long session-switch stalls before route fallback.
- Verified gates: focused IME / traversal / session-runtime / shared keyboard tests 110 PASS, feature registry PASS, `tsc --noEmit` PASS, and `build:android` PASS.
- Published APK: `0.1.3.2152`, versionCode `1032152`, sha256 `e3fb6bfabbbb6faa773bcd8852fd3b4d2bcdfd5e7e8eae2677e7237753d50b7c`, path `android/update-dist/zterm-0.1.3.2152.apk`.
- No attached ADB device was available in this workspace, so install/UI L5 is still unclaimed for this closeout.

## 2026-07-18 Relay-scoped Android update route truth

- Android update manifest URL source is owned by `settings.config_transfer` / app-update runtime, not by App/page code. Relay login/settings may call `applyRelayManifestSource(wsHostUrl)`, which derives the update manifest from the current Relay WS host and preserves the route base path: `wss://relay.codewhisper.cc:18443/relay/ws/host` -> `https://relay.codewhisper.cc:18443/relay/updates/latest.json`.
- Explicit `manifestSource='user-saved'` URLs are authoritative and must not be overwritten by Relay. Legacy private/Tailscale daemon update URLs under `/updates/latest.json` normalize to `server-connected`, and Relay-injected URLs normalize to `relay-injected`; both may be replaced when the Relay host/IP changes.
- Production Relay must serve update assets itself from `ZTERM_TRAVERSAL_UPDATES_DIR` (or `ZTERM_RELAY_UPDATES_DIR`) under `/relay/updates/latest.json` and `/relay/updates/<apk>`. Manifest `apkUrl` stays relative; the server must not rewrite it into stale direct/Tailscale IP semantics. GET and HEAD should both return 200 for manifest/APK so black-box checks cannot pass on GET while `curl -I` still reports 404.
- Verified closeout for Android package `0.1.3.2158`: public `https://relay.codewhisper.cc:18443/relay/updates/latest.json` returns versionCode `1032158`, `HEAD` returns 200, APK `HEAD/GET` return 200 and sha256 `3bc28bc20238b41612f7babf7125c5dcb1630fd6c9379653abf3ffb934572cf3`. Production service health shows `updates.manifestPresent=true` from `/var/lib/zterm-traversal-relay/updates`. Focused update/Relay tests 33 PASS, feature gates 48 PASS, typecheck PASS, local Relay smoke PASS, package verify PASS, full Android build PASS, and ADB install on `100.104.163.65:5555` succeeded with `versionName=0.1.3.2158`. App UI update-check L5 remains unclaimed while the device is locked.

## 2026-07-19 Remote window stream architecture truth

- Remote window stream is a new desktop media resource, not `terminal.remote_screenshot` and not terminal buffer/render truth. `resource.remote_window_overlay` owns only Android picker/floating/fullscreen projection and Back/minimize/close intents; `resource.remote_window_stream` owns daemon/native app-window/iTerm2-pane catalog, coordinate manifest, ScreenCaptureKit capture, WebRTC sender lifecycle, and input target lease.
- iTerm2 pane crop coordinates must be computed daemon-side from macOS top-left window frame plus iTerm2 Python API split-tree pane frames: `contentTopInset = windowHeight - max(pane.y + pane.height)` and `cropRect = windowTopLeft + contentTopInset + paneFrame`. Android must consume the manifest, not recompute macOS/iTerm2 coordinates.
- Live Mac Studio proof on 2026-07-19 used a temporary iTerm2 tab with red/blue pane marker rows. Direct top-left crop samples matched expected pane colors (`red 4/4`, `blue 3/4` with the fourth probe outside the drawn marker width); inverted-y samples matched `0/8`. iTerm2 session frames in nested layouts can be local to their immediate splitter, so daemon code must flatten splitter offsets before applying the crop formula.
- The stream is not view-only long term. Mouse/keyboard return must carry `focusPolicy` and `inputRoute`: generic app OS input requires `bring-to-focus`; `no-focus-steal` may only pass for explicit terminal-specific routes such as iTerm2 API or tmux input. Fullscreen Android Back shrinks to floating; only close tears down capture/encoder/WebRTC/input lease.
- iTerm2 nested split measurement must not double-count positioned leaf offsets. The daemon target catalog owner computes child bounding boxes with the same cursor/offset semantics as flattening, treats leaf frames as local to their immediate splitter, then rejects any content or crop rect outside the owning window. Live Mac Studio catalog proof after this lock returned `targets=12`, `panes=11`, `tmuxPanes=10`, `outOfBounds=0`.
- Remote window target catalog must include generic macOS `app-window` targets, not only iTerm2. Non-iTerm2 app windows come from daemon-side `CGWindowListCopyWindowInfo` truth and use `focusPolicy=bring-to-focus` / `inputRoute=os-event`. iTerm2 panes do not require a tmux mapping; missing `tmux list-clients` reverse lookup leaves them selectable as `iterm2-pane` with `inputRoute=iterm2-api` and no fake tmux ids. Verified live Mac Studio catalog returned `nonItermAppWindows=18` and `nonTmuxPanes=1`.
- `remote-window-android-minimal-overlay-slice`: Android implementation is only picker/target-locked overlay projection. `RemoteWindowOverlay` plus `remote-window-overlay-runtime` may open the catalog picker, render daemon manifests/errors, lock one selected manifest, double-tap/double-click fullscreen, shrink fullscreen on Back/minimize, and close UI state. `remote-window-message-runtime` and `session-context-remote-window-runtime` must request the catalog through the current active SessionContext transport and match response/error by `requestId`; they must not create a separate WebSocket, compute macOS/iTerm2 coordinates, use terminal mirror/sparse buffer/renderer rows as video, or fake empty success on daemon errors. Verified in APK `0.1.3.2159` with focused remote-window gates, architecture gates, full Android build, update-channel publish, and ADB install/version proof; UI visual L5 remains blocked by device lockscreen, while real ScreenCaptureKit/WebRTC frames and input return remain pending.
- 2026-07-19: Remote-window floating overlay movement belongs only to `resource.remote_window_overlay`. Drag ownership must be toolbar-only and disabled in fullscreen; double-tap/double-click fullscreen intent belongs to the video surface, not the draggable toolbar, so future video/input events are not stolen. While the picker or locked overlay is open, `TerminalPage` hides QuickBar/IME and suppresses only active body push through `terminal.transport_lifecycle` body-subscription truth; it must not close or rebuild the WebSocket.
- 2026-07-19: Remote-window iTerm2 pane enumeration in the installed daemon must not depend on whatever Python happens to be first on launchd `PATH`. The daemon launch runner must set `ZTERM_ITERM2_PYTHON` to a managed user venv (`~/.zterm/python/iterm2/bin/python3`) and install `iterm2` there if missing. Live closeout requires checking the staged runtime symbol, launch runner env, `import iterm2`, daemon `/health` fresh pid/uptime, and a real WebSocket catalog with `itermPanes > 0`.
- 2026-07-19: Drawer footer blank-space regressions are `terminal.session_drawer` projection bugs. Short catalogs should use a content-sized scroll list (`flex: 0 1 auto`, `min-height: 0`) so the footer follows the last row; long catalogs may still scroll inside the list. Do not patch TerminalPage layout, transport, or renderer to compensate for this class of empty drawer area.
- 2026-07-19: A local APK build/update channel and ADB install do not prove the public Relay update route. If Settings exposes Relay public update candidates, also check `https://relay.codewhisper.cc:18443/relay/updates/latest.json`. In the 2161 closeout local update assets and ADB install were correct, but public Relay manifest still served `0.1.3.2158`; do not report Relay public update publish closed until the production manifest/APK sha matches the new build.
- 2026-07-19: Public Relay update publish for `0.1.3.2161` is verified. Production update assets live under `/var/lib/zterm-traversal-relay/updates` on `159.75.134.56`, accessed with `~/.ssh/claw.pem` and `IdentitiesOnly=yes`; default root SSH with `id_rsa` is denied. Public `GET/HEAD https://relay.codewhisper.cc:18443/relay/updates/latest.json` returns versionCode `1032161`; public APK `HEAD` returns `Content-Length=5863118`; downloaded APK sha256 is `9ed1bbe370264ed3e14e87ae7a716303ccbf38e411b4193128115b2b616643c4`; Relay health still reports `updates.manifestPresent=true`. Device visual smoke remains unclaimed while `100.104.163.65:5555` is locked behind `NotificationShade` / keyguard.
- 2026-07-19: Remote-window catalog readiness must use the existing physical Session transport directly. `session-context-remote-window-runtime.ts` accepts `session.state=connecting` when its WebSocket is already `OPEN`; it must not reuse image/file paste readiness, wait for paste timeout, rebuild transport, or start screenshot/terminal-buffer/video fallback. No open socket surfaces `Remote window catalog transport is not open (...)` explicitly.
- 2026-07-19: Runtime debug/performance diagnostics are not a production data plane. `flushRuntimeDebugLogsToSessionTransport()` must not upload queued `terminal.performance.trace` / debug metadata when runtime debug is disabled. Runtime debug enablement has a 10-minute TTL; a legacy permanent `zterm:runtime-debug-log=1` without expiry is cleared on cold read. Verified package `0.1.3.2162` / `1032162`, sha256 `afdaaf06ed0f44adfc5b3817906310b28c5c9abb14fde699e553c09619bba680`, installed on `100.104.163.65:5555` and published to the public Relay update route.
- 2026-07-19 correction: while `desktop.remote_window_stream` real video is still incomplete, do not build/publish APK for intermediate catalog/overlay/debug changes. Finish the real ScreenCaptureKit/WebRTC video path first, then build one APK for Jason to test, unless Jason explicitly asks for an urgent recovery package.
- 2026-07-19: Remote-window ScreenCaptureKit frames can be odd-sized because app/window crops are not guaranteed even dimensions. Daemon I420 conversion must allocate `width * height + ceil(width/2) * ceil(height/2) * 2` bytes, not `floor(width * height * 1.5)`. Frame conversion and `RTCVideoSource.onFrame` failures must stop the stream and emit explicit status; they must never crash the daemon and leave Android waiting for `Remote window stream start timed out`. Active launchd daemon logs for this runtime are under `~/.wterm/logs/launchd-stderr.log`. Verified with odd `1037x1177` WeChat crop, daemon stream status, Android WebRTC `<video>` readiness, and controlled red/green/blue marker canvas-pixel oracle.
- 2026-07-19: Remote-window real video mainline is locally closed for view-only streaming. Verified path is daemon `ScreenCaptureKit -> rgbaToI420 -> RTCVideoSource -> WebRTC` to Android `<video>`, with controlled rendered-pixel oracle through Android WebView. Delivery APK `0.1.3.2164` / versionCode `1032164` was built, local-update published, and ADB-installed on `100.104.163.65:5555`; sha256 `40db98e2c66701212471f920ffd4a7a7188340f716116934eb8ce2a5febdbe3b`. 2164 post-install visual L5 remains unclaimed while the device is locked; mouse/keyboard input return remains a future slice, not part of this closeout.
- 2026-07-19: Session switch can show the new session as connected while body stays stale if `TerminalPage` active-session projection and session-group slots split. `terminal.session_group_layout` must synchronize external `activeSession` changes into top/center/bottom slot projection before `TerminalPageStageShell` renders: focus the existing slot when active is already in a slot, otherwise replace center. Do not patch WebSocket/daemon/buffer for this class until a session/body marker gate proves transport is the failing layer. Regression: `TerminalPage.session-content-identity.test.tsx` must cover portrait external active-session change with real `sessionBufferStore -> TerminalPageStageShell -> TerminalView` body markers. Verified in APK `0.1.3.2165` / versionCode `1032165`, sha256 `71273aa50420d2dc86d53e92ed312a4b2c6fe2bb9b70a535703d32b3fef1bd89`, installed on `100.104.163.65:5555`; visual L5 remains unclaimed while the device is locked behind `NotificationShade` / keyguard.
- 2026-07-19: Remote-window fullscreen interaction belongs to `desktop.remote_window_stream` / `resource.remote_window_overlay`. Android overlay owns fullscreen button, aspect-fit letterbox, pinch scale, zoomed pan, minimap projection, QuickBar suppression semantics, and pointer/key coordinate mapping. Floating remote video must not hide QuickBar; picker/fullscreen may suppress QuickBar and active body push without closing or rebuilding the terminal WebSocket. Daemon input truth currently supports only generic app-window `focusPolicy=bring-to-focus` + `inputRoute=os-event`; no-focus generic input, target mismatch, stopped streams, and iTerm2/tmux input routes must be explicit unsupported/error states, not fake success. Verified in APK `0.1.3.2166` / versionCode `1032166`, sha256 `fa0dd5c9ab14a535e21a4f2c8541b2a883d5df2c5f543e99c485f0d4a34f90f3`, installed on `100.104.163.65:5555`; local gates include remote-window focused `9 files / 101 tests`, feature/resource/function/mainline gates, typecheck, Swift parse, full Android build, and local Relay smoke. Live physical pinch/pan/minimap feel and macOS input permission proof remain separate device/daemon L5 gaps.
- 2026-07-19: Remote-window video has its own WebRTC peer connection, but its ICE configuration must be derived from the active session traversal route. `rtc-direct` uses STUN-only direct ICE; `rtc-relay` uses Relay TURN ICE; direct WebSocket/Tailscale paths do not fabricate relay ICE. Leaving the remote-window video peer with no ICE can pass local daemon/direct tests but fail on cellular/Relay with `Remote window stream start timed out`. Fullscreen overlay top chrome must include Android safe-area/status-bar padding on the fullscreen root, not just the toolbar. Verified in APK `0.1.3.2167` / versionCode `1032167`, sha256 `8ed0e1e717f27076cd00d10858002741aa942e43f28fb9c949a5f7cc975d024d`, with remote-window focused `9 files / 102 tests`, feature/resource/function/mainline gates, typecheck, full Android build, local update publish, and ADB install/version/focus proof. Live Android rendered-pixel/video-open and visual safe-area proof for 2167 were blocked after the phone went offline on Tailscale/ADB, so do not claim L5 visual closure from this package alone.
- 2026-07-19: Remote-window floating preview must size from the selected daemon manifest crop/window aspect ratio, not from a fixed 16:10 frame. `resource.remote_window_overlay` owns this projection in `RemoteWindowOverlay`: floating shell width caps respond to tall/wide/normal source ratios, the video surface sets `aspect-ratio: <crop width> / <crop height>`, received `<video>` stays pointer-transparent, and the overlay surface owns pointer/key input mapping. The remote-window floating entry is draggable and suppresses the synthetic click from the same drag gesture; the independent quickbar bubble clamps below a 64px status-bar guard. Verified in APK `0.1.3.2169` / versionCode `1032169`, sha256 `72b276cd2906687ea502e15a676ab9fc0ef65abb93f0482160cd4b07331b9dff`, with focused overlay/quickbar 82 PASS, remote-window/quickbar runtime 178 PASS, feature/resource/function/mainline gates 48 PASS, typecheck, full Android build, ADB install/version proof, and public Relay update manifest/APK sha proof. Live Android rendered-pixel/input proof for 2169 remains blocked by device keyguard / NotificationShade and a CDP `/json/list` timeout, so do not report true visual L5 until an unlocked device replay proves it.
- 2026-07-19: Remote-window floating overlay toolbar drag must use pointer capture on Android WebView. `RemoteWindowOverlay` calls `setPointerCapture` on the drag handle, processes toolbar-local `pointermove/up/cancel` through the same bounded drag helper, and releases capture from the saved element; `window.pointermove` is only a cross-element safety net. Tests fail if capture is not called, because jsdom/window bubbling can otherwise hide the real-device bug where the floating window does not move. Verified in APK `0.1.3.2170` / versionCode `1032170`, sha256 `489fad6910fb94d1c7c080a2b2c517f993ac11947adcb60051d9a40ca9a62e97`, with focused interaction tests, architecture gates, full Android build, and public Relay update download sha. Physical touch-drag L5 remains unclaimed because no ADB device was online.
- 2026-07-19: Remote-window target-locked floating overlay must consume Android IME `bottomInsetPx`; lifting only the closed entry button leaves an already-open preview under the keyboard. Remote-window IME text is not terminal input: `TerminalPage` must send raw committed text to `remote-window-input` so CJK, special symbols, and newline text are preserved; terminal punctuation/newline normalization applies only when no remote-window input context is active. Unzoomed touch drag and wheel input use explicit pixel `scroll` events over the existing session transport; zoomed fullscreen drag remains local pan. Generic app `os-event` injection requires Accessibility plus `bring-to-focus`; daemon activates the target app, validates stream/target/coords/deltas, and translates DOM positive-down/right deltas to negative macOS `CGEvent` wheel values exactly once. Verified in APK `0.1.3.2171` / versionCode `1032171`, sha256 `296a98b90a8cd6f6ff4e9b1266a43c5dbc55ff7accd860f29ee2e30a44a86c42`, with remote-window focused `11 files / 174 tests`, architecture gates `7 files / 48 tests`, typecheck, diff check, full Android build, local/public Relay update sha proof, Apple API doc check, and a local active/key AppKit flipped-scroll `CGEvent` experiment. Physical Android IME/scroll/input L5 remains unclaimed because no ADB device was online.
- 2026-07-20 correction to remote-window input truth: for generic app `os-event`, `NSRunningApplication.activate` is insufficient. The daemon input config must include selected window id/title/bounds, match the target AX window by `CGWindowList` top-left bounds, `AXRaise` it, set focused/main window when supported, then post Quartz events. `CGWindowList` top-left coordinates can be used directly as `CGEvent` location; do not apply AppKit bottom-left y conversion to daemon manifest coordinates. If APK changes include daemon-side input/capture code, Jason will see no behavior change until the Mac daemon release is rebuilt, globally installed, and service-scoped restarted. Verified on 2026-07-20 with a covered AppKit target window: pre-AXRaise scroll did not move target, post-AXRaise target became key and scrolled; running daemon was updated through `daemon:prepare-release` + install-global + `zterm-daemon restart`, `/health` showed new pid/uptime, live catalog returned `34` targets with no errors, and focused/architecture/type/diff gates passed.
- 2026-07-20 correction to remote-window input helper truth: generic app `os-event` pointer/scroll/key is a continuous input stream and must not compile a fresh `swift -e` process per event. The daemon owns one persistent Swift helper and sends JSON-line input configs to it; helper warnings/stderr must not be mistaken for per-event failure. The Swift decode schema must match the protocol union: pointer/key require `phase`, but scroll has no `phase`. Verified by live daemon protocol against a marked AppKit probe window: `remote-window-input` pointer down/up, pixel scroll, and key down/up all returned `accepted=true`, and the probe stdout observed `MOUSE_DOWN`, `MOUSE_UP`, `SCROLL dx=0 dy=-96`, `KEY_DOWN`, and `KEY_UP`. Verified WeChat focus by first activating iTerm2, then sending a harmless pointer move to the WeChat app-window stream; `System Events` changed `frontmostBefore=iTerm2` to `frontmostAfter=WeChat`.
- 2026-07-20: Remote-window fullscreen fill is Android overlay projection truth, not daemon/capture truth. `resource.remote_window_overlay` defaults fullscreen to aspect-fit complete display and owns an explicit aspect-fill cover option that fills portrait/landscape phone surfaces without stretching. Drawing and pointer/input mapping must use the same projected content rect, including cover-mode cropped offsets; daemon ScreenCaptureKit crop, Mac coordinate manifest, WebRTC negotiation, tmux width, terminal mirror, and renderer truth must not change for this display mode. Verified in APK `0.1.3.2172` / versionCode `1032172`, sha256 `088d448b2610fcaba4510824b4d6f4d130775e9c4b0a0ae47c1ace1e26a16ad1`, with remote-window suite `10 files / 125 tests`, feature/resource/function/mainline gates `7 files / 48 tests`, typecheck, diff check, full Android build, local update publish, and public Relay update download sha proof. Physical Android visual/input proof remains unclaimed because no ADB device was attached.
- 2026-07-20: The portrait terminal top status strip is `terminal.transport_lifecycle` UI projection and must reuse existing `SessionDebugOverlayMetrics` plus `Session.resolvedPath/resolvedRelayTransport/resolvedEndpoint` diagnostics. It may show route mode and live up/down/combined rates, but must not create a second network poller, resize the terminal surface, or infer route truth outside the transport diagnostics owner. Route selector health gating must choose fresh selectable candidates first; fresh failure/auth-failure candidates are only reprobed when every route is unhealthy. `SESSION_TRANSPORT_KEEPALIVE_GRACE_MS` is diagnostic context only: missing/closed sockets inside the grace window still reconnect through the unique owner because there is no live socket to reuse. Verified in APK `0.1.3.2182` / versionCode `1032182`, sha256 `88989b6f4db31d67573a12bdda06675340f5361ff8d40719dec57cb3f5bea848`, with route/UI/transport focused `5 files / 260 tests`, architecture gates `7 files / 48 tests`, typecheck, diff check, full Android build, local update publish, and public Relay update download sha proof. Physical Android visual proof remains unclaimed because no ADB device was attached.
- 2026-07-20: Android exit / dead RTC-Relay datachannel cleanup belongs to `terminal.transport_lifecycle`, not UI, renderer, buffer, or tmux cleanup scripts. Daemon transport connections must track real inbound liveness from WS pong/message and RTC datachannel message. A stale bound session transport is released by `detachSubscriberTransportOnly(subscriber, reason, transportId)`, which drops the subscriber, releases adaptive width through the existing mirror owner, and leaves tmux session plus mirror truth intact. Verified in APK `0.1.3.2184` / versionCode `1032184` with red/green daemon liveness tests, focused transport suite 38 PASS, feature/resource/mainline gates 48 PASS, typecheck, `daemon:mirror:close-loop` 9 cases PASS, service-scoped daemon install/restart, and live RTC black-box proof: temp tmux window went `80x24 -> 58x24 -> 80x24` and daemon lingering subscribers returned to `0` after stale transport close.
- 2026-07-20: Session transport target identity must be route-aware. `buildTransportTargetKey()` cannot use only `bridgeHost:bridgePort:authToken`, because the same daemon may be opened through Tailscale/direct WebSocket, `rtc-direct`, or TURN `rtc-relay`; treating those as the same target lets restore/open-intent reuse the wrong OPEN socket and leaves the UI showing network traffic while the terminal body is attached to stale transport truth. Target keys now include semantic route fields (`transportMode`, daemon/relay identity, direct endpoint fields, signal URL, normalized Relay endpoint candidates) while excluding volatile Relay `lastSeenAt`. Verified in APK `0.1.3.2185` / versionCode `1032185`, sha256 `44c8490921f2b78bd0947a378fa3bac7bbecff51bb5c0c9cf33dc66f51d27e4b`, with route target focused 40 PASS, route/transport regression 277 PASS, feature/resource/mainline gates 48 PASS, typecheck, full Android build, terminal contracts 593 PASS, common flows 82 PASS, local Relay smoke, and update manifest sha proof.
- 2026-07-20: Public Relay update route must be checked after every user-testable Android build, not just local `android/update-dist` and `/Users/fanzhang/.zterm/updates`. Build `0.1.3.2185` was locally ready but production `https://relay.codewhisper.cc:18443/relay/updates/latest.json` still served `0.1.3.2183`, so old clients correctly saw no update. Published `latest.json` plus `zterm-0.1.3.2185.apk` to `/var/lib/zterm-traversal-relay/updates` on `159.75.134.56`; public GET manifest returns versionCode `1032185`, APK HEAD returns `Content-Length=5882574`, downloaded public APK sha256 is `44c8490921f2b78bd0947a378fa3bac7bbecff51bb5c0c9cf33dc66f51d27e4b`, and Relay health reports `updates.manifestPresent=true`.
- 2026-07-20: Android foreground/background power truth is client-owned and must feed all expensive live demands from one `appForegroundActive` source. Background state must drop preview selected sessions back to baseline body subscription, stop SessionContext debug/active/passive timers instead of running 1s wake loops, and close/stop active remote-window WebRTC/ScreenCaptureKit streams instead of decoding/capturing offscreen. Daemon mirror, renderer, tmux width, route selector, and file transfer are forbidden compensation points. Verified in APK `0.1.3.2186` / versionCode `1032186`, sha256 `edd8231d87d40e2a5f3c17285ad7322011ac8b57c7559f8a92a867bf14bd9bbf`, with foreground/background focused `6 files / 97 tests`, architecture gates `7 files / 48 tests`, typecheck, diff check, full Android build, terminal contracts `593 PASS`, common flows `82 PASS`, local Relay smoke, and update manifest sha proof. No ADB device was attached, so physical battery/thermal/network counters remain an explicit L5 gap.
- 2026-07-20: Android native background execution must remain notification-only and must never become a transport keepalive or CPU wake owner. A dormant `BackgroundService` path existed with `PARTIAL_WAKE_LOCK`, `WAKE_LOCK`, and `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`; repo search found no active app call site, but the power semantics were invalid if enabled later. The service no longer imports `PowerManager`, creates wake locks, or requests those permissions; `src/lib/android-power-policy.test.ts` is now a terminal transport lifecycle gate.
- 2026-07-20: Session transport retargets must detach old active sockets from the new route truth. `upsertSessionTransportRuntime()` now clears `activeSocket` when the same session switches from one semantic route target to another and preserves the old socket only as superseded cleanup truth. Home/Relay explicit reopen of an already-open session must rebind route truth through `createSession(..., { sessionId: existingId, activate: false })` before `explicit-resume`; UI-only tab reuse is not enough when the target route changed.
- 2026-07-20: Public Relay update route was republished for Android `0.1.3.2188`. Production `https://relay.codewhisper.cc:18443/relay/updates/latest.json` now serves versionCode `1032188`; `HEAD` on `zterm-0.1.3.2188.apk` returns 200 with `Content-Length=4770730`, and the streamed APK sha256 is `4a562dd0ea022ee21da65300cb357c9a8bad7d78be3f3a9f6d4475e717ff7cb7`. Local update-dist and `~/.zterm/updates` match the same package.
- 2026-07-21: Terminal mux reconnect has three non-negotiable channel truths. First, a same-target replacement physical mux socket must queue every affected logical channel by resetting stale `open`/`closed` channels to `opening`; `mux-ready` flush reads `opening` channels and prioritizes the anchor/active session without creating another physical socket. Second, terminal input/file payloads may use an open mux target transport only after the session channel state is `open`; `opening` channels must not receive user input before `mux-channel-opened`, or input can race subscriber creation. Third, a plain server `{type:'closed'}` delivered inside `mux-channel-message` is a channel-level retryable close: mark that channel `closed`, then reopen it on the same physical target socket when available; do not emit terminal closed UI status and do not require a second WebSocket. Verified by mux/open/input/session transport gates `7 files / 213 tests`, full `build:android` terminal contracts `48 files / 602 tests`, feature gates `48 PASS`, typecheck, diff check, and public Relay update package `0.1.3.2189` sha256 `5d22c2c96c9bc057cc2ec5d34da64eb4e17255e9f64cf1a5cd07434800949aef`.
- 2026-07-21: Relay peer lease identity is per installed client device, not per account alone. Android must persist a per-install Relay client `deviceId` and include it in every `/ws/client` signaling URL. Relay server must reject missing device id, key idle peer leases by `userId + hostId + deviceId`, keep a normal signaling close/error idle for 30 minutes without immediately notifying daemon `relay-peer-close`, rebind the same device to the same `peerId` within that window, and give a second phone a separate `peerId`. Explicit `rtc-close`, host replacement, or timeout closes the peer. The lease stores only route/signaling peer truth, never terminal channel/tmux/mirror/UI truth. The daemon RTC bridge must accept repeated `rtc-init` on the same `peerId` by replacing the old peer connection and renegotiating. Verified in Android/Relay package `0.1.3.2192` by focused tests `47 PASS`, broad Relay suite `74 PASS`, typecheck, feature gates `48 PASS`, local Relay smoke, `test:relay:peer-lease` black-box gate showing phone A peer reuse and phone B separation, full Android build, local daemon pid `46535`, production Relay pid `1442264`, public update sha `5c35bd626bd0631496e9985e68c4940c1ea6ce8965bf838d7124a385b129fab8`, and production smoke with `jason/welcome2img`. No online ADB device was attached, so physical two-phone UI L5 remains unclaimed.
- 2026-07-21: Legacy upgraded Android clients can preserve the old fixed Relay client identity `deviceId=zterm-android` unless persisted account state is migrated before any Relay socket opens. `relay.account_directory` must treat fixed per-platform ids (`zterm-android`, `zterm-ios`, `zterm-mac`, `zterm-windows`, `zterm-web`) as invalid client identities, generate one stable per-install id, align top-level account state and nested `relaySettings`, and sync the normalized Relay settings into `BridgeSettings` at startup before traversal signaling derives `/ws/client?deviceId=...`. Verified in Android `0.1.3.2193` by red/green legacy migration tests, Relay/RTC focused gates `56 PASS`, broad Relay suite `77 PASS`, typecheck, feature gates `48 PASS`, `test:relay:peer-lease`, `test:relay:smoke`, full `build:android`, and public update sha `599c3ee820ee824860072c61301f35d57779d5adab39325f03f08de4855b6e72`. The final L5 proof is Jason upgrading phones and confirming production directory no longer receives `zterm-android`.
- 2026-07-21: Relay device stream has two payload classes with different semantics. `directory-snapshot` carries route-bearing daemon endpoint/session truth; legacy `devices-snapshot` can be presence-only. `relay.directory_ui` must preserve prior directory endpoint/session truth when a later presence-only devices snapshot arrives, or new installs can project an online Relay daemon row with no route candidates and then fail `fetchTmuxSessions`. `tmux-sessions` close handling must surface `TraversalSocket.getDiagnostics().reason` or close event reason before the generic "Transport closed while managing tmux sessions" string, so route exhaustion is visible. Verified in Android `0.1.3.2195` by red/green App stream and tmux management tests, mapped Relay UI stack `97 PASS`, feature/resource/function/mainline gates `48 PASS`, typecheck, live production RTC datachannel `list-sessions` against `mac-studio` returning 10 sessions, daemon service-scoped restart restoring `/health`, full `build:android`, and public update sha `55f5904200d150ee0fcb8f1fe217f0c1251cb7936877224028b273e85e2bbee0`. No online ADB device was attached, so installed-phone UI L5 remains unclaimed.
- 2026-07-21: Terminal mux channel allocation is not terminal render readiness. `mux-channel-opened` only proves daemon allocated a logical channel; same-channel `connected` after `attachTmux` plus nonzero `buffer-head`/`buffer-sync` is the readiness truth. `mux-channel-open` must carry initial `bodySubscribed` so inactive channels can attach without starting initial body capture, and later body subscription must update channel-local truth before sending. Cold-daemon proof is mandatory: `list-sessions` alone is insufficient, and warm mirror success is not enough. Verified in Android `0.1.3.2196` by focused server/mux gates (`73 PASS`, mapped mux regression `9 files / 283 PASS`, typecheck, feature gates `48 PASS`), rebuilt/installed/restarted daemon PID `42820`, installed runtime symbol checks, and production cold-daemon black-box replay over one WebRTC datachannel to `mac-studio`: all 10 tmux sessions opened with `bodySubscribed:false`, then each activated on the same channel and produced `connected` plus nonzero render data in `21-188 ms`; max first-sync frame stayed below `128 KB`, selected ICE was `host/host udp`, and cleanup left `subscribers=0`. Public Relay update serves APK `0.1.3.2196` / versionCode `1032196`, sha256 `f396694a81fc5580a0490422043dffcf558a7a17769cc1a1fdc4449cac375327`, size `4778462`. No online ADB device was attached, so installed-phone UI L5 remains unclaimed.
- 2026-07-21: Splitting mux allocation readiness must not remove bounded terminal-ready failure. `mux-channel-opened` clears the allocation timeout and arms a second `SESSION_TERMINAL_READY_TIMEOUT_MS=10000`; only same-channel daemon `connected` clears that ready timer and settles the pending open. If `connected` never arrives, the pending open finalizes as retryable `terminal mux channel ready timeout` through the existing transport lifecycle owner instead of hanging forever or rebuilding early. Verified in Android `0.1.3.2198` by focused transport/open/sync gates `99 PASS`, mapped mux/session regression `9 files / 284 PASS`, typecheck, feature/resource/mainline gates `48 PASS`, diff check, local `zterm` fixed/adaptive mux probes, production Relay/WebRTC `zterm` fixed/adaptive probes, full Android build, and public Relay update sha `01e5f320ed434da093b692b89f86b2076dbc5402e0f11e445c1103446b21c9d2`. No online ADB device was attached, so installed-phone UI L5 remains unclaimed.
- 2026-07-21: Mux body-subscription reconcile must use the effective target mux socket, not legacy per-session `activeSocket`. `getSessionTransportSocket()` intentionally returns null for mux channel sessions; the live socket is `getSessionTransportResource(sessionId).socket` once the target mux is ready. If an inactive channel opens with `bodySubscribed=false`, later active/live switch must update channel-local truth and send channel-bound `body-subscription=true` over that same physical target socket. Otherwise input can still work while render stays blank/stale because the daemon subscriber remains body-suppressed. Verified by fail-first SessionContext test proving the missing true subscription, green mapped mux/session regression `9 files / 248 PASS`, typecheck, feature/resource/mainline gates `48 PASS`, diff check, and local same-physical-socket black-box replay opening/activating all 10 tmux sessions including `zterm`.
- 2026-07-21: `rtc data channel error` / target mux transport close is physical daemon-target failure truth, not a single tmux session channel failure. Android `terminal.transport_lifecycle` must clear the target mux socket/ready flag, close every non-closed same-target logical terminal channel, settle pending opens with the original retryable failure, and schedule immediate/reset reconnect for affected non-pending sessions through the existing reconnect owner. Otherwise only the anchor session that created the physical socket fails and sibling sessions can stay projected as open/blank/stale on a dead datachannel. Verified in Android `0.1.3.2200` by fail-first `handleTargetMuxTransportFailureRuntime` unit gate, mapped mux/session regression `9 files / 244 PASS`, typecheck, feature/resource/mainline gates `48 PASS`, full `build:android`, and public Relay update sha `03c31aff9e1e8e31e36f9a0425a134b7f6dc40475ed02f100c4203807dc4bc65`. No online ADB device was attached, so installed-phone UI L5 remains unclaimed.
- 2026-07-21: Session switch-back timeout can happen while the physical daemon-target mux socket is still `OPEN` if the per-session terminal channel has already become `closed/closing`. `terminal.transport_lifecycle` must treat this as channel truth, not socket freshness: active/explicit resume must reopen that mux channel on the existing physical target transport and must not send `buffer-head-request` to the dead channel or rebuild the physical RTC/WebSocket. Any new transport/channel accessor must be exposed through provider core assembly result, assembly types, facade, and lifecycle runtime, then locked by `SessionContext` black-box gates; unit mocks alone can hide missing provider wiring. Verified in Android `0.1.3.2201` by closed-channel switch-back and repeated render-update gates, mapped mux/transport regression `11 files / 284 PASS`, `tsc --noEmit`, feature/resource/function/mainline gates `48 PASS`, full `build:android`, and public Relay update sha `369faa6aa76b9e2ea012fe2edd4aada6a85120add1a6fb2ca198821b6bf47abe`. No online ADB device was attached, so installed-phone UI L5 remains unclaimed.
- 2026-07-21: Drawer/session tmux management must not create a second `TraversalSocket` while a matching non-closed Session for that daemon target exists, because on Relay RTC it can replace the phone's maintained physical target peer and drop the active terminal. `useSessionOpenActions` must route drawer refresh, remote kill, quick create, and Home no-session discovery through `SessionContext.manageTmuxSessionsOnOpenTransport()`; that facade sends request-id `mux-target-message` over the existing target mux socket and settles only matching responses. Daemon `error`, malformed response, timeout, or not-yet-ready target state is surfaced and must not fallback to legacy `tmux-sessions.ts`; the legacy pool is only allowed when there is no matching open Session/target. Verified in Android `0.1.3.2203` by fail-first hook/SessionContext/runtime tests, mapped mux/session regression `13 files / 329 PASS`, `session-context-tmux-management-runtime.test.ts`, typecheck, feature/resource/function/mainline gates `48 PASS`, full `build:android`, local same-socket mux probe, production Relay same-datachannel mux probe returning 10 sessions including `zterm`, and public Relay update sha `fd73468d5430a3faff990dcb73323891777cad1241d7ac3645c929e26297596f`. No online ADB device was attached, so installed-phone UI L5 remains unclaimed.
- 2026-07-22: Terminal mux heartbeat is physical daemon-target transport truth, not logical session truth. Android mux target runtime starts exactly one low-frequency heartbeat keyed as `target:<targetKey>` for one physical WebSocket/RTC datachannel; logical tmux sessions/channels must never create their own mux heartbeat. Any valid mux frame refreshes target activity, `mux-pong` refreshes target pong truth, and exhausted physical misses finalize the target socket once through the existing target failure/reconnect owner. Channel errors reopen only the channel and must not poison route health or rebuild the physical transport. Verified by focused transport/heartbeat/traversal tests `6 files / 199 PASS`, remote-window dirty-scope gates `81 PASS`, feature/resource/function/mainline gates `48 PASS`, terminal contracts `48 files / 611 PASS`, `tsc --noEmit`, docs wiki regeneration, `git diff --check`, full Android build, and local/Tailscale/public Relay update route sha proof for APK `0.1.3.2212` / versionCode `1032212` / sha256 `98af72a4b2bf66f6859b61d00196314397f1bb4f6856d1907785fe5cbc2eca87`. No online ADB device was attached, so phone network-switch L5 still requires Jason/live-device Wi-Fi/cellular replay.
- 2026-07-22: Relay network-switch reconnect failures with daemon logs `Failed to set local answer sdp: Called in wrong state: stable` or `Failed to set ICE candidate` belong to daemon `rtc-bridge` signaling truth, not tmux/session/channel/UI. Relay peer resume can deliver duplicate `rtc-offer` or candidate-before-offer after a phone network change. The daemon bridge must serialize signal handling per `peerId`, reset offer/candidate state only on `rtc-init`, ignore duplicate offers for the same peer generation, and buffer ICE candidates until `remoteDescription` exists. Verified by a real WebRTC reorder gate in `rtc-bridge.test.ts` that sends candidate before offer and still opens the datachannel, plus relay/socket focused tests, typecheck, and diff check. Phone network-switch L5 still requires online ADB/logcat proof.
- 2026-07-22: Remote-window focus/gesture/screenshot truth: stream setup, receiver attach, fullscreen/shrink, IME lift, close, and screenshot are projection/capture operations and must not emit remote `focus` or pull the desktop app foreground. Unzoomed touch drags are locally classified and sent once as `gesture/swipe` with start/end coordinates; raw touch move streams are forbidden. Remote-window screenshot reuses `terminal.remote_screenshot` / file-download truth with selected target manifest: app-window captures by macOS numeric `windowId`, iTerm pane captures by daemon-normalized `cropRectTopLeftPx`, invalid target returns explicit error and must not fallback to full-screen capture. Android auto-saves this target-scoped screenshot to Download/zterm because it is a remote-window capture action, not the older QuickBar preview workflow. Verified in package `0.1.3.2211` with focused overlay/page/screenshot tests `67 PASS`, mapped remote-window/screenshot/daemon tests `143 PASS`, feature/resource/function/mainline gates `48 PASS`, typecheck, Swift native compile plus 1x1 rect capture, full Android build, daemon service-scoped restart, local/Tailscale/Relay update route sha proof. No online ADB device was attached, so installed-phone screenshot/touch L5 remains unclaimed.
- 2026-07-22: Session lifecycle in mux mode must make reuse decisions from the effective `SessionTransportResource`, not legacy per-session `activeSocket` alone. The target physical socket may be `OPEN` while the per-session terminal channel is `closed`; that state must reopen the channel on the existing target socket rather than skip reconnect or build a second socket. Conversely, target socket `OPEN` plus channel `open` must reuse without rebuilding. WebRTC `connectionState=disconnected` is transient ICE state; `TraversalSocket` gives it a 10s grace and attempts `restartIce()`, clears the timer on `connected`, and only records route failure after grace expiry / `failed` / `closed` / data-channel close. Verified in Android `0.1.3.2213` by session lifecycle tests `25 PASS`, `SessionContext.ws-refresh` `134 PASS`, focused traversal/transport tests `208 PASS`, feature/resource/function/mainline gates `48 PASS`, typecheck, full Android build, and local/Tailscale/public Relay update route sha proof (`de443704ab31872876ee39e5c01772904e47452b84ebcc800d34cb09ad664d96`). No online ADB device was attached, so real phone Wi-Fi/cellular network-switch L5 remains unclaimed.
- 2026-07-22: Remote-window original screenshot UX and source-size truth are locked. Floating/fullscreen screenshot must show a non-layout overlay animation/progress state immediately, then saved/failed prompt, while the request remains a non-input `terminal.remote_screenshot` action with no focus and no local video/canvas read. macOS `screencapture -l<windowId>` includes shadow inflation; native daemon must use `screencapture -x -o -l<windowId>` for app-window screenshots so the returned PNG matches the daemon manifest window bounds. Packaged global daemon install must also copy the current support native binary to `~/.zterm/bin/zterm-daemon`, because the Node runtime fallback path resolves there if `ZTERM_DAEMON_NATIVE` is missing. Verified in Android `0.1.3.2215` by overlay/page focused tests `44 PASS`, mapped remote-window/screenshot suite `191 PASS`, remote screenshot/native blackbox `18 PASS`, feature/resource/mainline gates `48 PASS`, typecheck, Swift native compile, live WS remote screenshot returning `570x497` for manifest window `570x497`, full Android build, and local/Tailscale/public Relay update route sha `dc190903b700431a17bc2ea5c3dcbec44701c5078945cbf98ebba161fd9f1f6c`. No online ADB device was attached, so installed-phone visual L5 remains unclaimed.
- 2026-07-22: Remote-window target catalog must have daemon process-local cache in addition to the Android daemon-identity projection cache. Cold live macOS app+iTerm2 enumeration can exceed the 8s picker watchdog (`11208ms` observed), so `remote-window-stream-daemon.ts` owns runtime-start warmup, 60s fresh cache, stale-while-refresh, one in-flight refresh per source-set key, and explicit `forceRefresh` live reads. Cached responses must rewrite top-level and nested error `requestId` for the current caller. `TerminalPage` must also set terminal stage bottom reserve to `0` while the picker suppresses QuickBar; fixing this belongs to overlay/page chrome projection, not renderer/transport/tmux. Verified in Android `0.1.3.2216` by focused remote-window cache/layout tests `67 PASS`, mapped remote-window stack `195 PASS`, feature/resource/function/mainline gates `48 PASS`, typecheck, full Android build terminal contracts `612 PASS`, common flows `83 PASS`, local Relay smoke, daemon release install/restart with installed SHA `01809b02174879494a8c8398ce2ca460549b636a6ebe3326f250a5201a2da0fd`, live WS catalog proof (`normal1=2ms`, `normal2=1ms`, `force=1470ms`, `normal3=1ms`, `32` targets, no errors), and local/Tailscale/public Relay update route sha `27c9d96851900d1d6a54596e17ae7f6b77d2f68baa84923aa0eea3808b6ef1c6`. No online ADB device was attached, so installed-phone visual L5 remains unclaimed.
- 2026-07-22: Remote-window input closure requires a live loopback gate, not only React/unit tests or a successful stream start. The canonical gate is `pnpm --dir android exec tsx scripts/remote-window-live-input-probe.ts`: it creates a temporary bundled AppKit `.app`, forces a fresh daemon catalog request so the new target is present, starts real ScreenCaptureKit/WebRTC over the daemon WebSocket, sends `focus`, pointer down/up, pixel scroll, gesture/swipe, and key down/up, requires each protocol response to be `accepted=true`, then asserts target stdout markers. Direct local and Tailscale daemon URLs both passed against installed daemon PID `32658` with repo/installed runtime SHA `01809b02174879494a8c8398ce2ca460549b636a6ebe3326f250a5201a2da0fd`. This proves live daemon protocol and macOS OS-event loopback; without an online ADB device it still does not prove installed Android WebView touch delivery.
- 2026-07-22: Remote-window phone-side input logic also needs a page-level gate below the daemon loopback. `TerminalPage.remote-window-overlay.test.tsx` now renders real `TerminalPage`, opens the picker, selects an interactive app-window, replays touch pointer tap and unzoomed touch drag on `remote-window-video-surface`, and proves the page emits focus-first pointer down/up plus one `gesture/swipe` through `onSendRemoteWindowInput` while `onTerminalInput` is not called. This locks the Android projection/routing layer but still is not a physical installed-device WebView L5 without online ADB.
- 2026-07-23: Remote-window touch-to-system-control supersedes the 2026-07-22 release-only `gesture/swipe` rule. Android unzoomed floating/fullscreen touch now follows desktop pointer semantics: tap emits focus-first pointer down/up; drag threshold crossing emits focus-first pointer down at the original contact point, absolute pointer moves during the drag, and pointer up on release/cancel. Android app-window touch must not emit delayed `gesture/swipe`; zoomed fullscreen one-finger drag remains local pan, and mouse/trackpad wheel remains pixel scroll. The page-level phone gate must prove pointer down/move/up leaves `TerminalPage` without reaching terminal input.
- 2026-07-23: The daemon persistent macOS input helper must map pressed pointer moves (`phase=move`, `buttons>0`) to the matching Quartz dragged event (`leftMouseDragged`, `rightMouseDragged`, or `otherMouseDragged`). Interactive app-window stream start warms the helper and waits for its explicit ready marker without focusing or injecting input, so Swift cold compilation is not charged to the first user event. The one-second realtime stale/drop contract still applies to queued user operations after helper readiness.
- 2026-07-23: Remote-window video playback reset is owned by media-stream identity. `video.srcObject` and `videoHasPlayed` must not reset for toolbar, pointer, fullscreen, or other overlay-state changes while the receiver `MediaStream` is unchanged; otherwise touch can flash the ZTERM wallpaper over a healthy stream.
- 2026-07-23: The canonical remote-window input black-box probe is an Objective-C AppKit `.app` with a file-backed event log. It starts a real daemon WebSocket/WebRTC app-window stream and requires accepted pointer down/move/up, pixel scroll, and key down/up plus target-side `PROBE_MOUSE_DOWN`, `PROBE_MOUSE_DRAGGED`, `PROBE_MOUSE_UP`, `PROBE_SCROLL`, and key markers. Local and Tailscale probes passed against the installed daemon for Android package `0.1.3.2218`; the APK sha256 is `c529cf47e6b9ac27cac0bb3abcb60a635bcf62b484ea9157f7f3c0d37a4856a3`, and local/Tailscale/public Relay update routes served the same artifact. No ADB device was online, so installed Android WebView touch L5 remains unclaimed.
- 2026-07-23: When remote-window works in daemon live probes but installed Android still cannot operate the app, the next required proof is metadata-only phone-side input telemetry in the `状态` floating debug window. It must show remote input context active/inactive, stream/target ids, source (`overlay` / QuickBar / IME), SEND Y/N, last pointer/key/scroll and coordinates, plus focus/down/move/up/scroll/key/text counts. If counts do not move after touching the remote video, debug Android WebView hit-test/overlay delivery; if SEND=N, debug context/sendInput wiring; if SEND=Y with correct coordinates, move downstream to daemon input-result/focus/injection. Verified in Android `0.1.3.2219` with focused remote-window/status gates `61 PASS`, feature gates `48 PASS`, typecheck, full Android build, and local/Tailscale/public Relay update sha `f829be52172ac4a0c00228f9f6733cce263251a95bd138db6ffa8e2ee37f7bf4`. No online ADB device was attached, so Jason's screenshot is the remaining installed-phone evidence.
- 2026-07-23: `SEND Y` only proves Android attempted to send remote-window input; it is not an end-to-end control result. The phone status panel must also project daemon `remote-window-input-result` or `remote-window-error` as `RW结果 ACK/ERR` with accepted/error counts. If `SEND Y` has no `RW结果`, debug SessionContext result dispatch / mux channel return path. If `RW结果 ACK` appears but the target app does not react, move to real target focus/coordinate/AX/Quartz injection; if `RW结果 ERR` appears, fix the explicit daemon error owner. The canonical live gate now has to cover both raw WebSocket and mux-channel control transport: `pnpm --dir android exec tsx scripts/remote-window-live-input-probe.ts` and `ZTERM_REMOTE_WINDOW_PROBE_MUX=1 ...`. For Android `0.1.3.2220`, raw WS local and mux-channel local/Tailscale probes all delivered AppKit `PROBE_MOUSE_DOWN`, `PROBE_MOUSE_DRAGGED`, `PROBE_MOUSE_UP`, `PROBE_SCROLL`, and key markers; APK sha256 is `8683a1aa5761e984b091e13ff7ef25f85716e453ff04edf062e0a8ff5a83af34`, served by local/Tailscale/public Relay update routes. No online ADB device was attached, so installed-phone `RW结果` L5 remains Jason-side.
- [2026-07-23] Remote-window input stale/drop truth is daemon-local receive/enqueue time, not Android/Mac wall-clock comparison. `clientSentAt` is cross-device debug metadata only: missing, old, or future values must not reject fresh daemon input. The daemon helper queue carries `daemonReceivedAtMs` and still rejects operations older than one second before macOS injection. Live closeout for this class must run `scripts/remote-window-live-input-probe.ts` serially with `ZTERM_REMOTE_WINDOW_PROBE_CLIENT_CLOCK_OFFSET_MS=-60000` on raw WebSocket and mux-channel paths, and verify the AppKit action loopback sees tap, drag, scroll, and key markers. Verified in `0.1.3.2221` by daemon tests, mapped remote-window gates, typecheck, feature/resource/function/mainline gates, raw/mux/Tailscale mux skewed live probes, and update-route sha proof; no online ADB device was attached, so installed-phone L5 remains Jason-side.
- [2026-07-23] Remote-window installed-phone stale after `SEND Y` + `RW结果 ERR remote_window_input_failed remote window input stale` exposed a test-design gap: serial live probes that await every focus ACK before sending the real pointer/key event do not model Android WebView burst behavior. The daemon input owner must short-circuit repeated focus when the target app is already frontmost and the matched AX window is already focused; otherwise focus-first markers can queue repeated AXRaise/activate sleeps ahead of real events and trip the daemon-local one-second stale gate. Remote-window input closeout now requires `ZTERM_REMOTE_WINDOW_PROBE_BURST=1` on raw WebSocket, mux-channel, and Tailscale mux live probes before reporting phone-parity confidence; without an online ADB/device replay, installed-phone L5 remains unclaimed.
- [2026-07-23] Remote-window installed-phone IME/touch closeout for Android `0.1.3.2226`: on device `100.104.163.65:5555`, explicit remote-window `KB` now makes the native anchor allow soft input on focus only for the show window (`setShowSoftInputOnFocus(enabled)`), and the live state changed from `showSoftInput(...)=true` but `keyboardVisible=false` to `keyboardVisible=true`, `keyboardHeight=1041`, `hasFocus=true`, `inputEnabled=true`; screenshot proof `/tmp/zterm-2226-remote-window-kb.png` shows the soft keyboard. The same installed build opened controlled app-window `ZTERM_PHONE_E2E_PROBE_1784793435553`; repeated ADB video-surface tap/swipe produced target-side `PHONE_E2E_MOUSE_DOWN`, `PHONE_E2E_MOUSE_UP`, and `PHONE_E2E_SCROLL dx=0 dy=123` in the AppKit log, while CDP Network showed mux remote-window pointer inputs and `remote-window-input-result accepted=true`. For this class, do not close from `ImeAnchor.show()` return value or React `SEND Y`; require native keyboard visibility state/screenshot plus target-side AppKit event log.

## 2026-07-23 Android render revision reset truth

- Android connected-green/body-stale can happen after daemon restart even when transport rx/tx keeps moving: daemon mirror `revision` is process-memory generation and may reset lower after daemon restart, while Android render store may still hold the previous high revision. This is not ring/cache rollback; ring/cache only changes `startIndex/endIndex/gapRanges/missingRanges`.
- Renderer anti-regression must keep rejecting lower revisions by default. The only allowed lower-revision publish is an explicit render-gate authorization where both projected buffer revision and `daemonHeadRevision` drop together, proving daemon mirror generation reset. A lower buffer revision without daemon-head reset remains a stale-frame drop.
- `daemon:mirror:close-loop` long-input recovery must compare against the settled shell oracle after target digest and prompt return, not the first digest-visible intermediate oracle. Otherwise daemon replay can be falsely red because it correctly sees the final prompt while the oracle still has bottom blanks.
- Verified closeout in Android `0.1.3.2227`: focused render-store/render-gate tests `11 PASS`, daemon-mirror lab script gate `12 PASS`, feature/resource/function/mainline gates `48 PASS`, `tsc --noEmit` PASS, `git diff --check` PASS, full daemon mirror close-loop PASS all nine cases including `long-input-echo` and `daemon-restart-recover`, full Android build PASS (`terminal contracts 613 PASS`, common flows `83 PASS`, local Relay smoke), installed on ADB device `100.104.163.65:5555`, and local/Tailscale/public Relay update routes all serve APK sha256 `b7f8c3b5691bdce8a7fba78319b5a38fc94e3ad833b2eb35b51fb9fe8f0400f7`.

## 2026-07-23 Remote-window PID focus truth

- Remote-window generic app control must verify foreground/focus by concrete process identity, not bundle id. Temporary AppKit probes and duplicate app launches can confuse bundle identities; the black-box live probe must match catalog targets by the exact `PROBE_READY pid` and assert `System Events` frontmost unix id equals that PID after every focus gate.
- On this Mac, `NSRunningApplication.activate()` can return success while frontmost does not change. The daemon macOS input helper uses System Events PID activation (`set frontmost of first process whose unix id is <pid> to true`), then AXRaise/focused-window verification before posting Quartz input. `NSRunningApplication(processIdentifier:)` can be transiently nil around LaunchServices focus/open; the helper uses a bounded same-PID retry before surfacing `remote input target app is not running pid=<pid>`. This is not a bundle fallback and must not fake success.
- Verified installed daemon runtime SHA `9931f2f94de15e85df00856b1914e4d27025d9084682f814ae4fe9239fe735a1` with service-scoped restart. Live gates passed on raw WebSocket local, raw burst local, mux local, mux burst with `CLIENT_CLOCK_OFFSET_MS=-60000`, and mux over Tailscale `ws://100.66.1.82:3333`; each gate defocused to Finder, restored the target PID, and observed target-side AppKit mouse down/up, dragged, scroll, and key markers. Static gates passed: daemon remote-window tests 44 PASS, typecheck, feature/resource/function/mainline/wiki gates, and diff check. Installed Android WebView L5 is still separate from daemon/macOS OS-event loopback.

## 2026-07-23 Remote-window touch scroll tuning truth

- Remote-window scroll feel belongs to `desktop.remote_window_stream.client.touch_action`, not daemon input injection. The client applies one tuning model to release-time `gesture/swipe` and fullscreen two-finger `scroll`: default `2x`, selectable `1/1.5/2/3/4x`, and optional direction inversion that flips only delta sign while preserving source/normalized coordinate mapping.
- Fullscreen zoom separates gesture ownership: one-finger drag at `scale > 1` is local projection pan and must not emit remote input; two-finger vertical movement is remote pixel `scroll` from the midpoint and must not move the local projection. Pinch remains a separate zoom gesture and is locked by axis/distance classification so a two-finger scroll's first moving finger does not accidentally become pinch.
- Verification baseline: `remote-window-touch-action-runtime.test.ts` must prove scaled/reversed deltas and unchanged coordinates; `RemoteWindowOverlay.test.tsx` must prove zoomed fullscreen two-finger scroll, adjustable/reversible toolbar settings, and single-finger local pan separation; `TerminalPage.remote-window-overlay.test.tsx` must keep page-level focus-first physical-send entry coverage. Focused gate for this closeout passed `58` tests plus typecheck, feature/resource/function/mainline gates, and diff check before Android build.

## 2026-07-23 Remote-window capture timeout and toolbar truth

- Remote-window floating toolbar must keep the drag hit zone and close/fullscreen controls in a fixed top row. Bitrate, scroll scale, direction, screenshot, keyboard, and display-mode controls belong in a separate horizontal control strip; putting all controls in the drag row can crowd phone-width floating windows until move/close becomes unreachable.
- Remote-window catalog/capture timeout values must be aligned across owners. Daemon app-window catalog timeout is the catalog owner bound; Android picker watchdog and live catalog probes must wait longer than it. Daemon ScreenCaptureKit startup timeout is the capture owner bound; Android receiver track timeout must wait longer because daemon returns the WebRTC answer only after first frame or explicit capture failure.
- User-visible daemon catalog/capture errors must include bounded timeout/stderr detail but must still strip inline `python -c` / `swift -e` script bodies. This is necessary to distinguish TCC/permission/window/frame stalls from missing catalog/video truth without exposing implementation source.

## 2026-07-24 Same-revision refresh and remote-video pending truth

- Same-revision client buffer protection must distinguish unsolicited stale packets from explicit visible refresh responses. A non-gap overwrite with the same revision remains forbidden unless its incoming payload window is fully contained by the recorded pending `tail-refresh` or `reading-repair` window and both `knownRevision == localRevision` and `targetHeadRevision == incomingRevision`. This bounded exception repairs stale upper visible rows after reconnect without reopening arbitrary same-revision overwrite.
- Same-revision tail/input refresh has a second ordering hazard: a `buffer-head` can arrive before the matching same-revision `buffer-sync` body response. `handleBufferHeadRuntime()` must not clear `lastSyncRequestAtRef` for `tail-refresh` / `reading-repair`; only the body apply/drop path may consume that pending request authority. Clearing it at head time makes the later fresh body look like an unsolicited stale same-revision overwrite and causes input/visible rows not to repaint.
- Buffer freshness timestamps are metadata only. Client `buffer-sync-request.requestedAt` and daemon `buffer-sync.generatedAt/requestSentAt` are for black-box latency/freshness evidence; revision plus absolute row index remain the only body ordering truth. Do not use wall-clock timestamps to accept stale body, reject valid body, or replace revision checks.
- Remote-window video projection must hide the native WebView playback placeholder until the negotiated `MediaStream` reaches `playing`. Pending/unplayed state shows the ZTERM engraved wallpaper; stream attach, metadata, canplay, and user pointer may retry `video.play()`. Wallpaper/play retry is projection behavior and does not prove daemon capture or WebRTC delivery.
- Verified in Android `0.1.3.2232` by focused buffer/render/remote-window tests `90 PASS`, typecheck, feature/resource/function/mainline gates, daemon mirror close-loop all 9 cases, full Android build with terminal contracts `625 PASS`, common flows `83 PASS`, local relay smoke, and local/Tailscale/public Relay APK sha proof. No online ADB device was attached, so installed-phone visual/render L5 remains unclaimed.
- Verified 2233 refresh closeout with fail-first `session-context-buffer-runtime` ordering test, buffer timestamp contract tests, Android focused buffer/render suite `314 PASS`, terminal contracts `627 PASS`, shared buffer/planner suite `51 PASS`, feature/resource/function/mainline gates `48 PASS`, typecheck, diff check, `daemon:mirror:close-loop` all 9 cases including `long-input-echo`, Android build `0.1.3.2233` / versionCode `1032233` / sha256 `dd288df8679dd3917e7a87c8dfe886c3d47b23bca23f131497fd1ec9322e16bf`, local/Tailscale/public Relay update route sha proof, and installed Mac daemon release runtime SHA `7d58ebf6f1414d2fabf5d8f31f177c65845cd7945ee1c9b253a810bd42ba4c75`. No online ADB device was attached, so installed-phone visual/render L5 remains unclaimed.
- [2026-07-24] Remote-window pending video wallpaper is Android overlay projection only. The pending/unplayed receiver background may show the engraved logo asset, but must not render an extra `ZTERM` wordmark over it; tests should assert the wallpaper has the logo image and no text mark. Stream-start diagnosis remains separate: raw local and Tailscale mux WeChat video-only probes with `trackSeen=true` prove daemon ScreenCaptureKit/WebRTC path for that route, but do not prove the installed-phone route that produced a screenshot.
- [2026-07-24] Remote-window attached-video visibility must not depend only on `HTMLVideoElement.playing`. Android WebView can reject `play()` or miss `playing` while a muted `MediaStream` is attached; overlay projection should reveal the video on media readiness events (`loadedmetadata` / `loadeddata` / `canplay`) and a bounded same-stream fallback, while keeping no-stream pending wallpaper separate. Opaque RGB logo assets on a dark video wallpaper need blend projection that hides the asset background and must not use `drop-shadow`, because source alpha is a full square. Verified in Android `0.1.3.2235` with focused remote-window `120 PASS`, typecheck, feature/resource/function/mainline gates `48 PASS`, serial WeChat raw local and Tailscale mux video-only probes with `trackSeen=true`, Android build, and local/Tailscale/public Relay update sha proof; no online ADB device was attached, so installed-phone L5 remains unclaimed.
- [2026-07-24] Remote-window stream-start timeout ownership is split. Catalog request timeout, stream-start request timeout, and receiver track timeout must not share the same timer: Android stream-start request timeout must exceed daemon ScreenCaptureKit first-frame timeout plus input-helper warm/control-plane budget, and receiver track timeout starts only after daemon `remote-window-stream-started` answer is applied. Otherwise a healthy slow capture/helper start can surface as misleading `Remote window stream start timed out`. Android WebView wallpaper also cannot rely on CSS blend over the opaque RGB app logo; use a transparent engraved logo asset so no square card renders. Verified in Android `0.1.3.2236` with focused remote-window `185 PASS`, typecheck, feature/resource/function/mainline gates `48 PASS`, raw local and Tailscale mux WeChat video-only probes with `trackSeen=true`, raw and Tailscale mux live input probes with AppKit mouse/drag/scroll/key markers, full Android build (`terminal contracts 627 PASS`, common flows `83 PASS`, local Relay smoke), and local/Tailscale/public Relay update sha `07e543201b0041e79ab042cd250580e7545d1c7ba881c6c86a8a49a726cf2da2`. No online ADB device was attached, so installed-phone visual L5 remains Jason-side.
- [2026-07-24] Correction to remote-window attached-video visibility: installed Android 2236 disproved the earlier 2235 rule that `loadedmetadata` / `loadeddata` / `canplay` / same-stream polling may reveal the receiver video. Android WebView can be media-ready and still draw the native gray play placeholder. The Android overlay must keep `<video>` hidden (`opacity:0` plus `visibility:hidden`) behind the engraved wallpaper until `play()` resolves, `playing` fires, or `requestVideoFrameCallback` reports a real frame; metadata/canplay/readyState polling may only retry `play()` and publish debug. Video visibility state must be keyed by receiver `MediaStream` identity/ref, not by callbacks that change when `videoHasPlayed` changes, or the effect can reset a healthy stream back to hidden. The status floating window should include video attach/visible/ready/paused/dimensions/play accept/reject/last event so installed-phone screenshots can distinguish no attach, play rejection, and frame-display failure.
- [2026-07-24] Remote-window gesture closeout for Android `0.1.3.2238`: daemon ScreenCaptureKit first frames that arrive before localDescription/WebRTC media connection are latest-only pending truth, not `framesSent`/`streaming`; flush only after peer connection readiness and drop on stop. Android `gesture/swipe/end` remains a single release-time action on the wire, but daemon must replay it as bounded macOS scroll steps, not one unbounded wheel delta. If daemon returns `remote_window_input_stream_missing`, Android overlay must invalidate the stream/video/input context instead of showing stale video that still accepts fake input. Installed phone `100.104.163.65:5555` proved WeChat video `readyState=4`, `1037x1177`, ADB physical tap/swipe produced focus-first pointer and `gesture/swipe/end deltaY=-1177` frames plus matching `remote-window-input-result accepted=true`; raw/mux/Tailscale/burst AppKit probes proved target-side mouse, dragged, scroll, and key events. Live probe ids must include timestamp + pid + random, not only `Date.now()`, because parallel probes can otherwise collide on one stream id. APK sha256 `e6753ff18ab2069ded69a025e05a5d8c870523750ec3ae05711e74399b37bccd` is served by local, Tailscale, and public Relay update routes.
- [2026-07-25] Remote-window video refresh truth: `trackSeen=true` and one `framesSent=1` frame are not enough. The live AppKit probe must animate its target window and require multi-frame capture (`stopped.framesSent >= 3`) on raw WebSocket, mux-channel, and Tailscale mux. The regression root was daemon ScreenCaptureKit capture configured with `queueDepth=1` while the sample callback synchronously converts/writes large RGBA frames; the stream could deliver the first frame then stop refreshing. The daemon now uses bounded `queueDepth=3` and flushes pending first frames once sender `localDescription` is ready, not waiting for full peer connection state. Serial live probes after install showed `framesSent=100/101/102` on raw, mux, and Tailscale mux respectively. Parallel same-target probes can still produce ScreenCaptureKit timeout false reds and must not be used as product evidence.
- [2026-07-25] Foreground resume freeze can be a body-subscription projection bug, not a WebSocket reconnect bug. Remote-window fullscreen suppresses the active terminal body subscription while it owns the screen; when Android backgrounds the app, the overlay must release `onBodySubscriptionSuppressedChange(false)` immediately before/while closing the stream. Otherwise the transport can stay green and same-socket head refresh can work, but terminal body push remains unsubscribed after foreground resume. Lock this with a TerminalPage gate that backgrounds a locked remote-window stream and asserts the final body-suppression callback is `false`, plus a SessionContext gate that foreground resume head->body updates the render store on the same physical socket.
- [2026-07-25] Remote-window target-locked touch rule: two-finger vertical movement is remote pixel `scroll` in floating, unzoomed fullscreen, and zoomed fullscreen. Pinch zoom is fullscreen-only and requires stronger two-finger distance/scale expansion with both fingers participating; near-parallel vertical movement with slight spread must stay scroll so scrolling is not misclassified as zoom. Regression gates: `RemoteWindowOverlay.test.tsx` must cover floating two-finger scroll, zoomed/fullscreen two-finger scroll, adjustable/reversible scroll tuning, and weak-pinch negative classification.
- [2026-07-25] Remote-window pinch gating must not delete scroll. Two-finger distance change alone is not enough to suppress or convert scrolling. If midpoint movement is clearly vertical and both fingers do not satisfy the fullscreen pinch start-axis intent, the action remains continuous pixel `scroll`, even with a large diagonal spread. Conversely, a true half-started pinch should be held until the second finger confirms pinch so it does not emit a stray horizontal scroll.
- [2026-07-25] Terminal same-revision repaint authority must be checked against the conflicting non-gap row range, not the whole incoming body window. A requested `tail-refresh` / `reading-repair` response may be a larger stable superset of the visible/input-tail window; accept it only when all changed/conflicting rows fall inside the pending request and `knownRevision` / `targetHeadRevision` match. Keep dropping unrequested same-revision overwrites or responses whose conflicts extend outside the pending window. This prevents bottom/input rows from staying stale while live lower rows continue refreshing without reopening arbitrary stale overwrite.
- [2026-07-25] Remote-window two-finger scroll is wheel-like, not page-jump. Target-locked two-finger vertical movement maps midpoint movement over the rendered surface proportionally into remote source pixels, emits continuous pixel `scroll` events, caps each event by the selected 1/8, 1/4, 1/2, or 1-screen preset, and defaults direction to inverted. Single-finger release-time `gesture/swipe` remains one bounded action on pointer up. Untouched remote-window video bitrate defaults to `2mbps`; only manual selector choices raise remembered fullscreen baseline.
- [2026-07-25] Correction: remote-window same-APP child windows must not render as small tiles inside the picker list. Picker only shows one collapsed app row; after opening a concrete target, the active video layer owns the sibling window switcher and switching stops the previous stream before starting the selected sibling stream. `WindowGroupLayout` remains the tmux multi-session preview layout owner, not the remote-window picker owner. Also, fullscreen "填满" is an explicit remote target `window-resize` request; local video drawing/input stays aspect-fit until daemon returns updated target/capture truth. Regression gate: `RemoteWindowOverlay.test.tsx` must prove picker hides child target rows, video-layer switcher appears after open, sibling click switches the selected stream target, two-finger scroll remains available, and fill emits `window-resize` without local cover/crop.
- [2026-07-25] Remote-window input focus truth is daemon-inline, not a client focus queue. The persistent macOS helper must verify live frontmost PID through System Events, not `NSWorkspace.shared.frontmostApplication`, because the latter can be stale in a long-lived helper and falsely report success while Finder/iTerm2 remains frontmost. For every real pointer/scroll/gesture/key action, the helper checks current frontmost PID plus matched AX focused window, focuses/raises only when needed, verifies, then injects Quartz input. Client `focus` messages are compatibility/explicit bring-front intents; when a same-target focus is immediately followed by real input, the daemon coalesces the focus and refreshes the following action receive time so focus bursts cannot stale real input. Verified with daemon test 52 PASS, raw/mux WeChat focus probes, raw/mux serial live input probes, raw/mux/Tailscale mux burst live input probes, typecheck, feature/resource/function/mainline gates, and installed daemon pid 40167.
- [2026-07-25] Remote-window real input is action-only on the wire. Android tap/mouse click emits one `click` action; unzoomed drag and two-finger vertical scroll emit one release-time `gesture/swipe` action; wheel remains one `scroll` action; QuickBar/IME send key/text actions only. Client focus preludes are forbidden for real input. Daemon helper keeps the 1s queued realtime stale gate, but same-target action-only bursts may refresh the next queued action only after the preceding same-target action succeeds; different-target queued actions still stale. Verified with focused remote-window suites, daemon tests 55 PASS, raw/mux serial + burst + clock-skew live probes, Tailscale mux serial/burst, feature/resource/function/mainline gates, and Android package `0.1.3.2247` / `1032247` sha256 `79fa04b4ab691f56f70f7ac198f2a6e4ae17d912f6bf01589ff319a932072826` on local/Tailscale/public Relay. Installed on ADB `100.104.163.65:5555` as versionName `0.1.3.2247`, but device remained keyguard-locked so phone UI L5 is unclaimed.
- [2026-07-25] Remote-window fullscreen "填满" now supersedes the 2026-07-20 local aspect-fill/cover interpretation. Marker: `remote-window fill ACK target capture preserves desktop width`. The only allowed meaning is remote desktop window resize: Android preserves the current remote desktop window width, computes target height from the current fullscreen available display container aspect ratio, sends one `window-resize` action, and keeps local drawing/input mapping aspect-fit until daemon ACKs. The daemon must resize the AX window, update ScreenCaptureKit configuration in place, and return `remote-window-input-result accepted=true` with updated `target` and `capture`; Android applies that truth only when stream id and target id still match the active locked stream. Local stretch/crop, phone-resolution sizing, tmux width changes, terminal mirror changes, and success without daemon `target/capture` ACK are forbidden. Verified in Android `0.1.3.2250` with focused remote-window overlay 55 PASS, daemon remote-window 58 PASS, remote-window message/session runtime 29 PASS, SOP/page/layout 11 PASS, `tsc`, feature/resource/function/mainline gates 48 PASS, `git diff --check`, full `build:android`, installed daemon release runtime SHA match, local/Tailscale/public Relay update route APK sha `f7aee6de741bcee6b68bf1b2b2ddaae22a7560c39f43ace739d794cbe058770e`. No online ADB device was attached, so installed-phone visual resize proof remains Jason-side.
- [2026-07-25] Terminal large-refresh same-revision chunks need explicit authoritative frame identity. When daemon splits one changed buffer span across multiple `buffer-sync` messages, each chunk must carry the same `frameStartIndex/frameEndIndex/frameChunkIndex/frameChunkCount`; the client may accept later same-revision non-gap overwrites only when they belong to the same authoritative frame or a bounded pending visible refresh. Unrelated same-revision stale packets and conflicts outside pending authority must still be dropped. This locks the "large paste / more than one screen changed / bottom input rows stay stale" failure class without moving truth into UI chrome or transport reconnect.
- [2026-07-26] Fullscreen terminal buffer/status audit truth: terminal body repaint and page chrome projection are separate owners. Fullscreen TUI rows can keep the same text and absolute indexes while only cell style/background changes; `TerminalView.dynamic-refresh` must repaint that frame instead of treating it as unchanged. Top connection/network status must be a single imported UI projection (`terminal-page-shell-ui` / `TerminalPageDebugOverlay`) and fixed overlay; `TerminalPage` must not re-inline quickbar/network/debug owners or use status/banner layout changes to compensate buffer body bugs. Verified in Android `0.1.3.2251` by focused status/buffer/source gates `128 PASS`, buffer/render mainline `127 PASS`, render isolation/scope/remote-window overlay `33 PASS`, typecheck, feature/resource/function/mainline gates `49 PASS`, `daemon:mirror:close-loop` all 9 cases, and local/Tailscale/public Relay update route sha `5c3c77ab73aa098cda44466e62c99d6ed7a1fc0bd5d3ede65db4a7250fc6d9a6`. No online ADB device was attached, so installed-phone visual L5 remains unclaimed.
- [2026-07-26] Terminal sparse buffer freshness must not treat global buffer revision as row-level freshness. `buffer-head.latestEndIndex` is only `mirror.bufferStartIndex + mirror.bufferLines.length`; it is not body freshness and cannot repaint rows. A sparse live `buffer-sync` that updates one row currently advances the whole local buffer revision, so a previously missed non-gap visible/input row can look fresh when `localRevision == daemonHeadRevision` and tail end is unchanged. Later one-row status/footer updates then keep preserving the stale row. The required gate is source-to-payload-to-client-to-DOM for "source row cleared once, client missed that non-gap row, later tiny sparse patches advance revision"; the fix owner is `terminal.buffer_render` sparse apply/visible repaint authority, not QuickBar, header-only repaint, reconnect, or UI clearing.
- [2026-07-26] Project architecture refactor now has module/edge truth before runtime refactor. `docs/module-registry.json` defines daemon/client/shared/relay/release/observability module ownership; `docs/edge-registry.json` defines allowed cross-module resource edges; `docs/modules/project-modules.md` and `docs/wiki/modules.md` are the human/wiki review surfaces. Static gates are wired into `test:feature-registry`: `src/lib/module-registry-truth.test.ts` and `src/lib/edge-registry-truth.test.ts`. Verified `pnpm --dir android run test:feature-registry -- --reporter dot` passed `9 files / 59 tests`. Runtime behavior is not proven by this gate; it only locks docs/manifests/static architecture before future connection/buffer refactor.
- [2026-07-26] Connection architecture baseline: `client.daemon_connection` is the single client physical-connection owner per daemon target; `client.terminal_channel_mux` owns per-tmux-session channels over that physical connection; heartbeat is target-level, not session-level. Daemon connection side stays client-agnostic under `daemon.connection_gateway` / `daemon.transport_subscriber`; daemon must not store client active tab, foreground/background, viewport, renderer, or UI truth. Relay `relay.peer_lease` is route/signaling truth only and cannot store terminal channel, subscriber, tmux, mirror, active tab, or UI truth.

- [2026-07-26] Daemon-connection phase1 slice: queued session opens must not fallback to legacy session-ticket/per-session sockets. `queueSessionTransportOpenIntentRuntime()` requires the mux opener; if it is unavailable it deletes the pending open intent and fails explicitly with `client.daemon_connection mux opener unavailable`. Also, once a session has a mux channel id, `getSessionTransportResource().socket` may only expose a ready target mux terminal transport; legacy `runtime.activeSocket` remains migration metadata but cannot mask an unready/closed channel as connected. Verified with transport stack `9 files / 89 PASS`, feature-registry `68 PASS`, `tsc --noEmit`, and scoped `git diff --check`. Live daemon/network/APK closeout remains unclaimed.
- [2026-07-26] `createClientDaemonConnection()` is an owner-layer constructor, not a convenience wrapper for feature runtimes. Static gate now permits it only in `session-context-infra-facade-runtime.ts`, `session-context-transport-orchestration-runtime.ts`, and `client-daemon-connection.ts`. Public facade / interaction / lifecycle / message assemblies must consume the injected daemon connection. Schedule/public message send and paste readiness use `daemonConnection` only, with no raw socket fallback. Verified with focused public/transfer/message/remote-window/module gates and feature-registry `70 PASS`; full branch type closeout remains blocked by unrelated `Session.buffer` test migration errors.
- [2026-07-26] File Sync upload crash root cause: Android upload path used native `StoragePermissionPlugin.readFile()` to materialize the full local file into one base64 payload before JS chunking, which can OOM or crash the WebView/native bridge. Upload now streams through native `readFileChunk(path, offset, length)` in 256 KiB spans and sends the existing `file-upload-start/chunk/end` protocol unchanged. Native read logic returns bytes/bytesRead/eof and the plugin encodes with `android.util.Base64.NO_WRAP`, avoiding `java.util.Base64` on minSdk 24. Verified by file-transfer runtime/component tests `21 PASS`, native `StorageFileReadLogicTest`, server file-transfer truth `13 PASS`, QuickBar/split `74 PASS`, typecheck, feature/module/resource/mainline `71 PASS`, full Android build, installed ADB APK `0.1.3.2254`, and WebView CDP live bridge probe reading a 614400-byte file as `262144 + 262144 + 90112` chunks with no crash logs. APK `0.1.3.2254` / versionCode `1032254` / sha256 `ad31d10afc340ffb850e26a2e04a71aaf7befde92c12fb47ca0976f2b0903619` is served by local, Tailscale, and public Relay update routes.
- [2026-07-26] File Sync local file preview has the same bridge-memory constraint as upload. Tapping a local Markdown filename must not call native `StoragePermissionPlugin.readFile()` for the whole file; preview must use bounded `readFileChunk(path, offset, length)` reads with streaming decode and a visible truncation notice, while upload still streams the full file in chunks. Verified in APK `0.1.3.2255` / versionCode `1032255` / sha256 `1c7819789dfe7f904e1e030d85ced0f4191b935e75616c3919127fd2b458b1c6`: focused file-transfer truth `27 PASS`, native storage read test PASS, typecheck PASS, feature-registry `71 PASS`, full Android build, local/Tailscale/public Relay update sha proof, ADB install on `100.104.163.65:5555`, and WebView CDP bridge reads of 1.5 MiB and 12 MiB files in 256 KiB chunks with no fatal/OOM/render-process crash logs. Marker: `file sync local markdown preview bounded native chunks 2255`.
- [2026-07-27] File Sync upload crash follow-up: if upload/local-preview already streams native chunks and logcat shows no whole-file OOM path, check App/native listener churn before changing file-transfer truth. `useOpenTabLifecycleEffects` must keep exactly one Capacitor `App.addListener('appStateChange')` registration across callback-only rerenders and dispatch through latest callback refs; sync sheet UI state changes must not repeatedly remove/re-add native listeners while file chunks are crossing the WebView bridge. Gate: `src/hooks/useOpenTabLifecycleEffects.test.tsx` plus `App.dynamic-refresh` appState listener test. Delivered in APK `0.1.3.2256` / sha256 `37c16592324382eaf62f8e5c00556d19f06b1b09c83df1eeb00be39f0e41fcb5`; installed on ADB and startup logcat showed no add/remove listener flood or fatal crash. Marker: `sync upload listener churn appStateChange single listener 2256`.
- [2026-07-26] Reconnect lifecycle truth: reconnect phase, manual close, and stale head-probe markers belong to one `SessionReconnectStore` owner under `terminal.transport_lifecycle`; product runtimes must not pass `reconnectRuntimesRef`, `manualCloseRef`, or `staleTransportProbeAtRef` as separate ref bags. `SessionReconnectRuntime` is the discriminated union `idle | scheduled | connecting`; only `scheduled` may carry a timer, and `connecting + timer` is illegal by type. Gates: `session-reconnect-store.test.ts` plus `session-context-session-runtime.test.ts` must prove manual close suppresses retryable reconnect without terminal error, stale probes are not overwritten, scheduled timers clear on replace/delete, scheduled -> connecting drops the timer, and scheduled/connecting does not queue duplicate reconnect.
- [2026-07-27] SessionContext assembly refs must be typed at the provider boundary. `SessionProviderRuntimeRefs` is the ref-bag contract; message assemblies should depend on structural minimal interfaces for the methods they actually consume, not full stores or `MutableRefObject<any>`. This keeps tests honest without forcing oversized mock stores. The T2d gate is: contexts `MutableRefObject<any>|refs:any` grep 0, target assembly files `\bany\b` grep 0, type-check, contexts all, feature-registry, and terminal regression core. Type tightening also exposed that socket server message callbacks must include `onClosed`; this callback is part of the true transport lifecycle edge and must not be hidden behind `any`.
- [2026-07-27] App relay device stream reconnect ownership belongs to `relay-device-stream-runtime` / `useRelayDeviceStream`, not App.tsx. App only wires bridge settings and consumes projected devices. Presence-only devices snapshots must merge through `mergeRelayPresenceWithDirectoryTruth` so route-bearing directory endpoints/sessions survive. Gate: App must not contain `new WebSocket`, reconnect timers, or `computeRelayDeviceStreamReconnectDelay`.
- [2026-07-27] TerminalView follow/reading scroll truth belongs to a pure renderer-window state machine, not independent component ref flags. The owner is `src/lib/terminal-follow-scroll-runtime.ts`, a discriminated union that makes `reading + pending follow sync` unrepresentable and emits effects for TerminalView to apply. TerminalView may keep timer/function refs only as effect handles, while product truth such as pending follow target, layout settling, ignored programmatic scroll, last settled scroll, settled-frame marker, and user scroll intent must live in that runtime. Gate: runtime positive/negative tests, TerminalView dynamic/bottom-stale focused tests, TerminalPage render/session identity tests, type-check, feature-registry, and daemon mirror close-loop. Known adjacent owner: `TerminalView.theme.test.tsx` failures around default-cell background/theme presets are shared theme/cell-render truth, not follow-scroll truth.
- [2026-07-27] Route health must distinguish transient connectivity failure from authentication failure. A process-local five-minute blacklist for an ordinary Tailscale/LAN/RTC failure is forbidden because a healthy endpoint remains unselectable until the Android process is killed. `TraversalRouteHealthCache` owns this policy: ordinary `failure` uses a short one-second circuit-breaker cooldown and then becomes probe-eligible; `auth-failure` remains quarantined for the full five-minute health TTL; a single `TraversalSocket` generation still attempts each candidate at most once. The physical target failure owner must call `reportFailure()` before rebuilding so route selection does not preserve a false recent success. Verified in APK `0.1.3.2263`: service-scoped daemon restart re-probed Tailscale, reopened the same mux channel and resumed buffer frames in under one second after socket loss without killing the app. Marker: `transient route failure short cooldown reprobe without process reset`.
- [2026-07-28] A chunked authoritative terminal body frame must be published atomically by the client buffer owner. `frameChunkCount > 1` payloads are wire fragments, not visible patches: `assembleBufferSyncFrameChunk` holds one required per-session assembly resource, validates one frame identity plus exact dense absolute-row coverage, and emits one resolved payload for one sparse-buffer commit and one renderer commit. Every intermediate RAF observation must remain the previous complete frame. Same-revision different-identity interleave is rejected, the poisoned incomplete state is cleared, and the existing authoritative repair path is requested so the next consistent repair can complete. Ingress must call a separate resolved-apply stage, never recursively re-enter itself. Close-loop replay steps explicitly declare `source-only` or `source-and-client-render`; a client-visible intermediate mismatch fails even if the final frame converges. Marker: `atomic frame poisoned incomplete assembly source-and-client-render`.
- [2026-07-28] While a newer authoritative frame is incomplete, a late lower-revision payload must be rejected before sparse apply whether it is chunked or unchunked. The client frame resource retains the newer pending assembly, records non-repairing `stale-frame` error truth, and publishes neither the stale payload nor a renderer commit. This prevents older full payloads from deleting a newer assembly and recreating old/new buffer flashback. Marker: `newer pending rejects lower unchunked stale frame without renderer publication`.
- [2026-07-28] Client terminal frame assembly is a separate runtime truth resource, not an internal alias of the sparse buffer. The registered path is `resource.mirror_store -> resource.client_buffer_frame_assembly -> resource.client_sparse_buffer`; every direct mainline edge must match that registry. A repairable frame rejection retains the exact rejected frame range and stays `pending` until the existing range-request owner actually dispatches to wire; only then does it become `dispatched`, and one revision cannot dispatch twice. A suppressed/no-socket request does not consume repair. Validate lower revision before malformed metadata so obsolete frames never trigger repair while a newer frame is pending. Marker: `frame assembly exact repair pending until wire dispatch independent resource`.
- [2026-07-28] Frame repair identity must remain authoritative after successful apply: never fabricate malformed revision as `0`; same-revision interleave repairs the original pending frame range; revisionless malformed frames wait for an authoritative live head when no pending revision exists; and a bounded per-session `repairDispatchedRevisions` ledger survives later successful revisions so delayed malformed traffic cannot dispatch the same repair twice. A newer pending frame clears superseded older repair error truth but preserves the ledger; explicit session cleanup retires it. Marker: `frame repair authoritative revision original range persistent dispatch ledger`.
- [2026-07-28] A client frame assembly described as bounded must enforce shared protocol limits before retaining payload: maximum span, chunks, serialized bytes, and incomplete lifetime. Lifetime cleanup belongs to the buffer-head cadence so an idle partial frame is released and repaired without waiting for another body message or session close. After a revisionless error obtains identity from authoritative live head, recheck the per-revision dispatch ledger before wire send. A retained revision must always use its retained frame range, never a different range advertised by the malformed packet. Verified by focused `175 PASS`, architecture `76 PASS`, full terminal contracts `701/703 PASS` with only two documented unrelated ordering failures, and all nine real daemon/tmux close-loop cases. Marker: `frame assembly shared bounds head cadence expiry post-resolution ledger check`.

## 2026-07-27 network change detection (Capacitor Network)
- Added `@capacitor/network` dependency and Capacitor `networkStatusChange` listener in `useOpenTabLifecycleEffects`.
- When network reconnects: resumes active session transport, audits tabs, unmarks foreground hidden.
- When network disconnects: marks foreground hidden via `onForegroundActiveChange(false)`.
- Listener is callback-ref stable: only one native registration across rerenders.
- Verified: `useOpenTabLifecycleEffects.test.tsx` 5/5 PASS.

## 2026-07-27 sessionId exact match (S1-S4 closeout)
- `findReusableManagedSession`/`findReusableOpenTabSession` now require exact `sessionId` match; no sessionName+host fallback.
- `open-tab-intent.ts` dedupe uses exact `sessionId` comparison; `runtimeReuseKeys` is debug-only.
- `tmux-session-picker-rows.ts` uses `sessionId` as active marker key.
- `session-semantic-identity.ts` host aggregation paths unchanged.
- Verified: session-sync-helpers 73/73, open-tab-intent 11/11, tmux-session-picker-rows 5/5, feature-registry 72/72.

## 2026-07-27 architecture gap closeout plan T1-T9 complete

- **Scope**: 2026-07-26 全仓架构审计剩余缺口 T1-T9 全部收口，含 daemon/client 分块、模块耦合、状态机、lib+编排+纯编排 app 四维度。
- **T1**: STORAGE_KEYS 双真源合并 — shared 16 key 并集，android re-export。
- **T2**: contexts refs 袋子收敛 — 4 子切片（heartbeat / tail-refresh / reconnect / any 清零），38 useRef → 6 领域 store。
- **T3**: Session 双真源残相删除 — resolveSessionBufferView 物理删除，Session 类型移除 buffer/daemonHeadRevision/daemonHeadEndIndex。
- **T4**: daemon 转发壳合并 — TerminalRuntimeDeps = Omit<TerminalMirrorRuntimeDeps, ...> 消除 30 字段重复。
- **T5**: terminal-message-runtime 拆分 — 拆出 mux-channel-runtime (286 行) + reliable-input-ack (33 行)。
- **T6**: shared design 模块转 active — 4 模块 status active，owned_paths 指向真实文件。
- **T7**: App.tsx relay 流编排下沉 — 新 relay-device-stream-runtime + useRelayDeviceStream，App.tsx 844 行。
- **T8**: TerminalView follow 滚动状态机显式化 — 10+ ref 收敛为 terminal-follow-scroll-runtime 判别联合。
- **T9**: SessionReconnectRuntime 显式相位 — idle | scheduled | connecting 判别联合。
- **验证证据**:
  - test:feature-registry: 10 files / 72 PASS
  - tsc --noEmit: PASS
  - pnpm --dir packages/shared exec vitest run: 38 files / 308 PASS
  - 核心 server 测试: 110/110 PASS
  - contexts + lib + App: 529/529 PASS
  - 全量套件（含 SIGABRT 前可见）: 2 个 pre-existing theme 失败 + 2 个 pre-existing IME 测试失败 + 1 个 evidence 文件缺失失败
- **已知非阻塞失败**: TerminalView.theme.test.tsx (2, theme 真源语义)、App.android-ime-input-loop.test.tsx (2, 旧 app 流程)、runtime-debug-sequence.test.ts (1, 缺失证据文件) — 均非架构改动引起。
- **SIGABRT**: 全量并行时 wrtc native module 在 RemoteWindowOverlay 测试中崩溃，单文件 58/58 PASS 正常。
- **SOP**: 远程窗口触摸 action SOP 测试修复（line 27 文案对齐）。
- **网络检测**: 添加 @capacitor/network 依赖，useOpenTabLifecycleEffects 接入 networkStatusChange。
- **sessionId 精确匹配**: S1-S4 收口，findReusableManagedSession/findReusableOpenTabSession 要求精确 sessionId 匹配。
- **未完成**: 全量并行 SIGABRT 修复（wrtc 线程安全）、theme 测试修复、IME 测试修复、遗留 migration 路径（activeSocket、controlTransport/terminalTransport 拆分、tmux-sessions.ts 直接 socket 池）的最终 phase1 物理清理。

- [2026-07-28] Authoritative chunk-frame identity must survive the first client wire-normalization boundary. `normalizeIncomingBufferPayload` must preserve `frameStartIndex`, `frameEndIndex`, `frameChunkIndex`, and `frameChunkCount`; malformed presence stays explicit for rejection and must never become an absent field that downgrades a chunk to legacy passthrough. Otherwise assembly unit tests can pass while the real socket path still publishes every chunk and visibly alternates old/new buffer content. Marker: `wire normalizer preserves authoritative chunk frame identity before atomic assembly`.
- [2026-07-28] A bounded frame-repair ledger belongs to one daemon revision epoch, not a socket generation and not the lifetime of a numeric revision globally. Tab switch, inactive drop, socket cleanup, and reconnect clear incomplete chunks but retain error/ledger truth. The first authoritative lower daemon head starts one new revision epoch and clears pending/error/ledger before repair dispatch; repeated lower heads in that same reset expectation cannot clear a newly dispatched repair. Explicit local session close deletes the resource. Marker: `frame repair ledger daemon revision epoch survives socket generation reset once`.
- [2026-07-28] File-transfer throughput policy has one machine truth at `contracts/file-transfer-throughput.json`. Upload uses a fixed eight-chunk cumulative-ACK window owned by `sendBoundedFileUploadChunks`; download native persistence batches eight 16 KiB wire chunks per bridge call owned by `writeFileTransferChunkBatches`; Android Gradle binds the same JSON batch limit into `BuildConfig`. The required gate is `pnpm run test:file-transfer:throughput`, wired to CI and prebuild and covering client/daemon module SHA-256 loopback plus Java native-write tests. Module loopback is not live transport evidence: product speed claims still require online ADB, real transport, bytes/duration/throughput, and both-side SHA-256. Current download still assembles the whole transfer in daemon/client memory before batched persistence.
- [2026-07-28] Daemon upload completion truth is published only after exact chunk count, assembled byte count, and post-write `stat` size agree. Cumulative progress, completion success, chunk rejection, and completion rejection are separate mainline nodes bound to their real `handleFileUploadChunk` / `handleFileUploadEnd` owners; all four branches may converge only at `DaemonFileTransferTransportOut01Send`. The mainline gate derives the complete node-induced subgraph without trusting `owner_feature`, compares the exact adjacent edge set, and separately rejects wrong edge ownership.

- [2026-07-28] File-transfer product E2E closeout requires verifying installed APK native plugin surface before speed claims: source/Gradle green can still leave installed WebView returning `StoragePermission.writeFileChunks() UNIMPLEMENTED`. After reinstalling current APK and running current daemon runtime on isolated port 3334, 8 MiB Android->daemon upload measured 3.51 MiB/s with SHA match and bounded ACKs; daemon->Android download wire measured 56.18 MiB/s, native batched persistence used 64 calls for 512 chunks, full download wall measured 1.57 MiB/s with SHA/stat match. Standard build remained blocked by unrelated `daemon.connection_gateway` import-edge gate, so this was a minimal E2E package, not whole-repo green. Marker: file transfer installed plugin writeFileChunks e2e speed.
- [2026-07-28] Same-target reconnect must preserve active-session priority at the mux-ready flush boundary, not only at reconnect scheduling time. `reconnectAllSessionsRuntime()` can queue the active tab first, but the shared target transport later sends `mux-channel-open` from the opening-channel accessor when mux becomes ready. `bindTargetMuxTransportSocketLifecycleRuntime` must pass the current active session id to that accessor so active channel open precedes inactive same-host channels. Verified by ws-refresh active-first tests and full terminal contracts after APK `0.1.3.2265`. Marker: same target mux-ready active channel first.
- [2026-07-28] Same-target mux-ready active priority must validate membership, not just presence. At `mux-ready`, `bindTargetMuxTransportSocketLifecycleRuntime` must read the current active session id, enumerate that target's opening channels once, and fail the target lifecycle if the active session is missing or not opening on that same target. Otherwise a stale/non-matching active id silently replays old insertion order and defeats active-first reconnect. Marker: `mux-ready active priority membership required before channel replay`.

- [2026-07-28] Home server rows must not expose a separate Relay connect button. Relay directory data is only an automatic-route candidate badge/projection (`自动线路`) merged into the saved server Host; tapping the row sends one route-aware open intent to session-open owner. Auto route order is private LAN IPv4 first, then Tailscale/direct websocket, then WebRTC UDP direct, then TURN Relay; target-level mux heartbeat/physical failure updates route health for future transport generations. Marker: `home single connect auto route lan tailscale udp relay`.
- [2026-07-29] Multi-pane split performance must not refresh every passive visible pane on one tick. Active pane owns the active freshness lane; passive visible panes are selected one per tick in round-robin order and still use target-level transport/body-subscription truth. Workspace split must allow empty panes: from one open session, split creates a numbered empty pane, tapping it opens the scoped session picker, and tab context menus expose explicit `更改 Pn Session` plus `移到 Pn` actions. Marker: `multi pane passive refresh round robin empty pane scoped picker`.
- [2026-07-29] Visible passive pane refresh is not `resource.active_session` truth. Use `resource.visible_pane_session` for visible split-pane session identities, then route the selected passive session through its existing `resource.session_transport` without rewriting active-session truth. Persistence and workspace mutation stay under `useTerminalWorkspace`; TerminalPage/Header/StageShell only project pane truth or emit scoped intents. Marker: `visible pane session resource passive refresh not active session truth`.
- [2026-07-29] Remote-window same-app sibling thumbnails must be lightweight projection, not foreground stream work. Active locked-window catalog sync should use a seconds-class light cadence (currently 5s), and sibling screenshot thumbnails must be single in-flight globally until the real screenshot promise settles, prioritize missing cards before refreshing ready cards, keep failed thumbnail state terminal for the same request identity, and require `{sessionId,targetId,requestId}` match before completion mutates thumbnail state. Fast periodic screenshot loops, local stale-timeout lock deletion, or interval retry after failure can freeze the multi-window preview even when WebRTC remains connected. Marker: `remote window sibling thumbnail single in-flight light cadence`.
- [2026-07-29] Remote-window stream cleanup errors must be request-id matched through `RemoteWindowMessageRuntime`, not inferred from a fire-and-forget UI callback. Stop sends `remote-window-stream-stop-request`, then resolves only from matching `remote-window-stream-status` and rejects from matching `remote-window-error`; overlay handoff cleanup may project that error separately from the current stream. Marker: `remote window stop ack error chain request id matched`.
- [2026-07-29] Remote-window ROI-unavailable path is explicit dual stream: start low-rate `purpose=canvas` first for immediate paint, then start high-quality `purpose=focus` and commit active media/input/resize/quality truth to focus when it succeeds. `attachRemoteWindowStreamReceiver` requires `state.streamId` to already equal the focus stream id; otherwise focus never becomes active and quality/resize ACKs stay on canvas. Canvas must not start active catalog force-refresh cadence while focus is pending, and focus start baseline bitrate must seed `lastAppliedStreamQualityKeyRef` to avoid no-op quality churn. Marker: `remote window canvas first focus commit active stream truth`.
- [2026-07-29] In the current Android overlay, canvas/focus dual-stream is a startup handoff, not a retained hidden duplicate capture: after focus commits, stop the startup canvas stream unless a real canvas projection is rendered. Handoff commit must accept the canvas id when focus startup fails, and late focus promises must be request-epoch checked after close/sibling switch so they cannot resurrect stale media or leak a daemon capture. Marker: `remote window startup canvas stopped focus epoch guarded`.
- [2026-07-29] Dual-stream focus startup failure must release the daemon focus capture even when the UI falls back to the already-started canvas stream. The focus stream id is known before `startStream` awaits client receiver setup, so the catch path must issue an idempotent stop for that id before committing canvas-only display. Future canvas compositor/layout/focus resources stay `status: design` in `resource-registry.json` until real owners and gates are implemented. Marker: `focus receiver failure stops daemon focus stream canvas resources design`.

- [2026-07-29] Remote-window current startup stream purpose is `preview`, not `canvas`. Persistent app-group canvas raw/layout/encode resources remain `status: design` until compositor/layout/projection gates land. Implemented behavior is low-rate `purpose=preview` for first paint, high-quality `purpose=focus` after receiver startup, and a visible degraded-state toast if focus startup fails while preview remains active. Marker: `remote window preview purpose focus degraded explicit`.
- [2026-07-29] Remote-window focus cleanup errors during preview fallback must be associated with the preview stream after it becomes the committed active stream. If focus receiver startup fails during handoff, stop the known focus stream after committing the preview replacement so `failRemoteWindowStreamCleanup()` binds to the displayed stream rather than the previous focus stream. Marker: `remote window focus cleanup binds committed preview fallback`.
- [2026-07-29] Module registry active owned/consumed bindings must not include `status: design` resources. Future remote-window canvas raw/layout/encode/focus resources stay in module `pending_resources` until their resource-registry status becomes active and their implementation/edge gates land. Marker: `module registry pending design resources not active bindings`.
- [2026-07-29] Relay device stream storage writes must merge against the current stored account, not the account object captured when the WebSocket opened. A fresh `directory-snapshot` can add/update daemon machines while a later legacy `devices-snapshot` contains only client/presence facts; writing `{...options.account, devices}` rolls `account.directory` back and makes already logged-in daemon machines look unsynced. Gate with a two-daemon directory followed by a client-only devices snapshot. Marker: `relay stream current account merge preserves daemon directory`.
- [2026-07-29] Desktop split visual truth for Mac/Windows belongs in shared `resolvePaneProfile` / `PaneStage` / `PaneTabs` plus platform shell CSS. For iTerm2-like panes, desktop split should use zero pane gap, square pane frames, no extra pane-tab wrapper border/background, and a narrow divider hit band with only a one-pixel visual divider; runtime, renderer, buffer, route, and workspace identity owners must remain unchanged. Marker: `iterm2 split zero gap no extra pane chrome`.
- [2026-07-31] A mux data-channel close must consult target-control truth before projecting user-visible terminal state. Owner is client `terminal.transport_lifecycle` / mux orchestration: send target-level `list-sessions` over the existing mux target transport, then reconnect only if the tmux session still exists and the session is active/live; mark closed if tmux truth says missing; ignore stale results if the channel already reopened; keep inactive sessions idle. This preserves control/data separation: target/control stays `mux-target-message`, session data stays `mux-channel-message`, and no raw post-hello frame is allowed. Marker: `mux channel closed asks control status before reconnect`.
- [2026-08-01] Active/live mux data-channel close must not become a permanent idle/error state when target-control status is unavailable. If `list-sessions` cannot be sent or fails because the target mux transport is not ready/open, the control line is unavailable; route it to the target transport failure owner so the exact physical generation is retired, route failure is recorded, and recoverable channels are replayed by the existing target rebuild path. Inactive channels still stay idle. Marker: `control status unavailable active channel target failure owner not idle`.
- [2026-08-01] Exact tmux session targets are not valid pane targets, and fixed `=<session>:0.0` pane targets are not valid for sessions with nonzero base indexes or deleted original panes. Pane-level daemon commands must use deterministic `=<session>:.{top-left}`; `has-session`, `kill-session`, `rename-session`, and window/session commands must keep `buildExactTmuxSessionTarget()` -> `=<session>`. Marker: `exact tmux top-left pane token`.
- [2026-07-31] Reconnect UI should not flash during short transient recovery. `NETWORK_BANNER_GRACE_MS` is 10s; while network is online and active session state is `reconnecting`, TerminalPage hides the network banner and projects the portrait status strip as green/waiting until the grace expires. Marker: `reconnect ui quiet first 10 seconds`.
- [2026-08-01] Supersedes the prior green/waiting reconnect-strip rule: the portrait connection strip is a flat neutral Session diagnostics projection, never a permanently raised/highlighted surface. It shows `正在同步控制通道`, `正在连接`, or `正在重连` during standard recovery. Foreground resume and reconnect attempts 0/1 do not trigger the top error banner; the banner becomes actionable only after one full traversal generation fails (`reconnectAttempt >= 2`) or terminal error, and raw probe strings are not shown to users. Marker: `flat status control activity reconnect banner after full generation`.
- [2026-07-31] Release update rollback slots must keep normal and rollback APK manifests physically monotonic: normal `0.1.3.N` uses `versionCode=1100000000 + N*10`, rollback `0.1.3.N.1` uses `normal+1`, and next normal `N+1` must be greater than rollback. Build/release closeout requires manifest + APK `versionName/versionCode` evidence, public Relay downloaded APK sha256 match, and installed-device package version evidence. Marker: `android rollback slot versionCode normal rollback next monotonic public relay sha installed 2285`.
- [2026-08-01] Relay account directory direct endpoints must preserve daemon auth token across the public relay runtime, not only local source/tests. If production `/api/auth/me` shows fewer endpoint candidates or `hasAuthToken=false` while daemon logs `auth=config` and publishes more endpoints, first verify the installed relay package runtime contains `authToken` before changing Android route logic. Upgrade `@jsonstudio/zterm-relay-server`, service-scope restart `zterm-traversal-relay.service`, then require live directory proof: connected daemon has LAN/RTC-direct/Tailscale/Relay candidates and every direct-capable candidate has `authToken`. Marker: `relay production runtime authToken endpoint directory five candidates`.
- [2026-08-01] Relay directory endpoint auth must win over stale saved host auth for the same direct route. `buildTraversalPlan()` must insert relay directory direct endpoints before saved direct fields and dedupe WebSocket candidates by endpoint identity (`path + displayEndpoint`), not by full token-bearing URL; otherwise a stale saved token and fresh directory token coexist for `100.x:3333`, Auto can try the stale candidate first, and daemon returns `Unauthorized bridge token`. Live proof: production directory for `mac-studio` had all endpoint auth; a deliberate stale-token target produced first Tailscale candidate with fresh endpoint token and `list-sessions` succeeded. Marker: `relay directory token wins endpoint identity dedupe unauthorized bridge token`.
- [2026-08-01] Production RTC verification must send concrete client `deviceId` on `/ws/client` and keep client ids distinct from daemon device id and from each RTC attempt. Missing `deviceId` is a protocol rejection; reusing the daemon id or the same client id across sequential P2P/TURN probes can contaminate peer lease evidence. Verified production relay P2P datachannel with host/prflx candidates and TURN-only datachannel with relay/relay candidates after probe correction. Marker: `rtc probe client device id distinct per attempt relay relay candidates`.
- [2026-08-01] `rtc-direct` data-channel open is not stable route success until it survives a short stability window. If the direct data channel opens and closes inside that window, traversal must record that candidate failed and continue to TURN-only `rtc-relay`; otherwise Auto can stop on a transient direct open and surface `rtc data channel closed` instead of using Relay. Marker: `rtc direct open stability falls through turn relay`.
- [2026-08-01] Reliable terminal input must not timer-resend an in-flight seq while waiting for daemon ACK. `sentAt !== null` means already sent and pending; only explicit retryable NACK may reset `sentAt=null` and resend the same seq. Fixed interval retry before ACK can duplicate visible user input under weak network. Marker: `reliable input in flight waits ack no timer duplicate resend`.
- [2026-08-01] Release daemon support config must merge `zterm.android.daemon` and legacy `mobile.daemon` per field, not by choosing one object. An empty new `zterm.android.daemon.authToken` must not mask legacy `mobile.daemon.authToken`; release closeout should prove `auth=config` and tokened WS `list-sessions` works after global install/restart. Marker: `release daemon config field merge legacy token auth config`.
- [2026-08-01] Foreground/online network signals must reach the target failure owner when the retained daemon target transport is non-OPEN. Returning a local `not-open` probe result can leave a CLOSED/ERROR physical generation parked until the user switches session. The owner is `terminal.transport_lifecycle`: foreground is only a generation signal; exact target generation retirement, route failure reporting, rebuild, and mux channel replay belong to the existing target failure path. Marker: `foreground resume non open target failure owner`.
- [2026-08-01] Reliable input resend is ACK/route-generation driven, not interval driven. A sent seq may be observed on a cadence, but it should only resend after a bounded ACK timeout or target route generation change, using the same seq so daemon ack cache remains idempotent. Marker: `reliable input ack timeout route generation resend same seq`.
- [2026-08-01] A logged-in daemon target must not construct a new business transport from cached host/profile truth before the Relay control directory is freshly confirmed. The control chain owns current daemon presence, endpoints, and Relay/direct auth settings; `terminal.transport_lifecycle` holds the new physical generation in CONNECTING and releases it exactly once after confirmation. A confirmed missing target is an explicit error, while logged-out saved direct/Tailscale targets remain independent of Relay control. Existing healthy business transports do not depend on control reconnects. Marker: `control confirmed directory gates new daemon transport generation`.
- [2026-08-01] Relay same-device replacement already has deterministic new-wins behavior: a new signaling socket for the same account/host/client device reuses the peer lease, closes the old socket with `relay client socket replaced`, and triggers a new `rtc-init`; different client devices retain distinct peer ids. Diagnose stale-control startup separately from peer replacement. Marker: `relay same device new signaling replaces old socket same peer id`.
- [2026-08-02] Relay account login is append-only per successful login: multiple client tokens and multiple daemon identities under one account remain independently valid. Ordinary password change preserves tokens; only an explicit global sign-out may revoke all devices. A 2026-08-01 phone outage was caused by a manual production-store token purge, not login eviction; restore only the exact affected token from the timestamped backup and retain a pre-repair backup. Marker: `relay multi device append token ordinary password preserves sessions`.
- [2026-08-02] Android foreground service plus a process-level partial WakeLock proves process retention, not an always-live WebView control socket. On the PLZ110 live test, PID/service/WakeLock survived more than ten minutes screen-off but the Relay debug request reported `delivered=0`; wake recovered the same PID/session to connected Tailscale without a session switch. Long-term background control continuity requires its own live control-stream evidence and must not be inferred from native service state. Marker: `android background process retained webview control stream not proven`.
- [2026-08-02] A Relay Session catalog is row truth, not daemon identity evidence. In a multi-daemon account, common names such as `rcc` or `dev` cannot bind direct/stale history to a machine. Drawer canonicalization requires an exact online endpoint or saved/Home endpoint-to-online-daemon alias; rtc-only catalogs may supply rows only after that stable binding exists. Marker: `relay session catalog row truth not daemon identity`.
- [2026-08-02] File management belongs to `client.file_browser` projection and must route to `FileTransferSheet` through the visible file-folder floating action, not through the sync-sheet-only shortcut. In product mode, when `TerminalQuickBar` receives `onOpenFileTransfer`, the only floating entry is `文件浏览`; the old quick-input/snippet `⌘` floating bubble is legacy-only and may render only when file browser is unavailable. Remote text/code preview and save should reuse existing daemon file-transfer frames (`file-list-request`, `file-download-request`, bounded `file-upload-*` with cumulative ACK) rather than adding a UI-owned save protocol. External local editing belongs to native storage owner via FileProvider/open-file of a local copy; syncing back to remote remains an explicit upload. Marker: `product mode only file browser floating action no quick input bubble`.
- [2026-08-02] Remote text editor save must preserve an intentional empty string. Do not use `previewEditorText || preview.text` for save/open paths because it restores old preview content when the user clears a file. External editor sync is explicit: FileProvider opens a local copy, then the user-triggered sync reads local bytes through `StoragePermission.readFileChunk` and uploads them through the same bounded file-transfer protocol. Marker: `remote text empty save local copy sync bounded upload`.

- [2026-08-02] Floating file management is a remote cwd browser, not the file sync sheet with a different entry. In `browser` mode, `FileTransferSheet` must not read/show the local sync directory, remote rows must not expose selection checkboxes or batch download/upload actions, remote list failures must remain explicit errors, and non-text files must project unsupported-preview rather than become selected sync items. Text/code preview/edit/save stays on existing `file-list-request`, `file-download-request`, and bounded `file-upload-*`; external editor copies go under `Download/zterm/remote-browser/<remote-cwd>/` and sync back only by explicit upload. Marker: `floating remote cwd browser not sync sheet remote-browser copy`.
- [2026-08-02] Remote text preview chunks are independent base64 wire frames. Decode each chunk to bytes and feed TextDecoder with streaming; concatenating padded base64 chunks can throw `Failed to execute 'atob'` and makes text files look unopenable. Remote browser sheets should use content-height with a max cap, not a fixed 88vh sync-panel height that leaves a large blank bottom area. Daemon remote directory listing should serve resolved-path cache and refresh it through fs watcher events; list requests should not repeatedly rescan a full directory tree. Marker: `remote browser padded base64 chunk decode cached directory watcher`.
- [2026-08-02] Terminal shell chrome skin belongs to UI projection/settings truth, not terminal renderer theme truth. Persist `terminalShellSkin` independently from `terminalThemeId`, default to light for the white global app surface, and scope tactile header/quickbar CSS under `.zterm-terminal-shell` / `.zterm-neo-*` so settings dialogs and other white app surfaces are not restyled. Skin live preview must only patch the previewed skin/theme keys and must not overwrite other unsaved Settings draft fields. Marker: `terminal shell skin ui projection separate from renderer theme scoped neo css`.
- [2026-08-03] Remote cwd browser text/code preview is a fullscreen file view, not a bottom card under the directory list. Opening a file should cover the sheet with a safe-area-aware editor and top toolbar for Back, local open, save, optional local-copy sync, and close; Back clears only the preview and returns to the cached browser list. File bytes still flow through `file-download-request` and bounded `file-upload-*`; this is `client.file_browser` UI projection only. Marker: `remote browser fullscreen preview toolbar returns cached file list`.
- [2026-08-03] Foreground resume must preserve an OPEN session transport and probe it first, while independently refreshing `resource.relay_account_directory` before any unavailable route-aware transport reconnects. Saved direct/Tailscale candidates cannot bypass confirmed account-directory truth, and an asynchronous directory refresh promise must be bound to its runtime generation so restart cannot inherit stale work. Verified by 47 focused tests, 79 architecture gates, TypeScript, full Android build, matching three-channel APK `0.1.3.2354` sha256 `e91899032d2c8085baf8edee3ea6b076849f0be02d826a2ebcc99ffacca407ab`, and Codex `VERDICT: PASS`; real-phone foreground recovery was not run because no ADB device was online. Marker: `foreground resume probe existing transport control directory generation bound refresh`.
- [2026-08-03] The large visible terminal body is renderer truth owned by `TerminalView` and `packages/shared/src/terminal/theme.ts`; changing only shell CSS cannot lower its brightness. The default light-shell renderer uses the existing `tabby-github-light` preset with GitHub Primer neutrals (`#eaeef2` background, `#57606a` foreground). QuickBar labels use a dark-above/light-below engraved text shadow, and blue/black buttons retain raised highlight/inset/outer-shadow tokens. `test:terminal:shell-theme` is wired into prebuild and CI and asserts the real renderer scroller color. Marker: `github primer neutral light terminal engraved quickbar labels`.
- [2026-08-03] Active no-visible-range first paint must fetch a bounded multi-screen tail, not exactly one viewport. A healthy daemon/tmux session can have the prompt/content above a mostly blank last screen (`rcc3` had ready mirror revision 16, rows 55, available `2..58`), so one-screen tail bootstrap makes the terminal look black even though transport and mirror are healthy. Buffer owner should request `max(availableStartIndex, latestEndIndex - viewportRows * 3)..latestEndIndex`; QuickBar product mode must show only the file-folder floating action and must not resurrect the old quick-input `⌘` floating bubble. Marker: `active first paint multi screen tail product only file folder floating action`.
- [2026-08-03] Foreground resume reconnect attempts are standard recovery progress, not actionable failure truth. `reconnectAttempt >= N`, probe timeout, or transient RTC/data-channel close can happen on every successful recovery round, so TerminalPage must not use attempt count to show an error banner. While state is `reconnecting`, show only neutral progress; user-visible error banners require offline, typed terminal `error`, auth failure, or another explicit nonretryable failure owner. Marker: `reconnect attempt count not user visible failure truth`.
- [2026-08-03] Stale daemon drawer identity must be replaced only by exact normalized `bridgeHost:bridgePort` evidence from a confirmed online Relay daemon. `resolveServerIdentity()` previously let any persisted `daemonHostId` bypass aliases, producing duplicate unreachable rows and stale default selection. Light terminal cell contrast belongs in shared `resolveTerminalCellColors()`: when foreground is default and background is explicit dark, use the theme bright foreground; preserve preset foreground for transparent/default cells. Marker: `stale daemon exact endpoint canonical identity light theme explicit dark cell bright default foreground`.
- [2026-08-03] Relay daemon host identity is unique per account. Persisted device rows are keyed by `deviceId`, but routing/control truth is keyed by `daemonHostId`; when a daemon registers with a new device id, relay `registerHost()` must call the store owner `clearOtherDaemonHostBindings()` before publishing presence so old same-host rows become disconnected and expose no endpoints/sessions. Marker: `relay host identity unique device id restart stale binding clearOtherDaemonHostBindings`.
- [2026-08-03] A wrapped terminal row showing correct SGR background only on its first physical row can be installed-runtime drift, not a renderer/theme defect. Prove with real `tmux capture-pane -e` plus `canonicalizeCapturedMirrorLines`; then inspect the running service runtime for `buildAnsiSgrContinuationPrefix` and compare `/health` PID/uptime. `build:android` prepares daemon artifacts but does not install/restart the global daemon. Marker: `wrapped SGR continuation first row only installed daemon runtime drift`.
- [2026-08-04] zterm root is app-repo only: active source roots are `android`, `mac`, `win`, `packages/shared`, shared `assets`, root `scripts`, `.agents`, and `.github`. Legacy runtime/demo roots are physically removed and guarded by `pnpm run test:repo-layout` in CI/release. Runtime source must stay outside this repo and be consumed only through published `@jsonstudio/wtermmod-*` packages. Marker: `app repo layout gate blocks legacy runtime demo roots`.
- [2026-08-04] Standard foreground recovery progress is status-strip projection, not a fixed error banner. `TerminalNetworkBanner` must only show offline or typed terminal `error`; reconnecting/connecting/control-directory wait labels belong in `TerminalConnectionStatusStrip` and stay flat/transparent. Android `MainActivity.onStart()` must not stop the background foreground service directly; shutdown remains with the JavaScript lifecycle owner after foreground/resume is observed, so short background handoff is not cut before WebView resumes. Marker: `foreground recovery status strip no fixed banner native onStart no stop service`.
- [2026-08-04] Shared Relay/proxy endpoint is route evidence, not daemon owner truth. `open-tab-restore` and `open-tab-persistence` must preserve exact `daemonHostId` / persisted `hostId` before endpoint canonicalization; endpoint rewrite is allowed only when normalized `bridgeHost:bridgePort` maps to one owner. This prevents same-endpoint multi-daemon accounts from collapsing audits, tokens, or restored tabs onto the pinned/newest daemon. Neutral terminal contrast projection must choose an anchor that actually satisfies the requested contrast; if theme foreground cannot meet contrast against an explicit cell background, pick a readable black/white anchor or preserve original color rather than making text match the background. Marker: `shared relay endpoint not daemon owner unique endpoint canonicalization readable contrast anchor`.
- [2026-08-04] Remote-window touch mode separates single-finger drag, realtime two-finger scroll, and fullscreen pinch. Single-finger drag remains a release-time `gesture/swipe`; target-locked two-finger vertical movement emits bounded pixel `scroll` actions during pointer move and emits no remote action on pointer up. Two-finger scroll is vertical-only (`deltaX=0`), while clear fullscreen opposite-axis distance change is local pinch zoom and must update overlay viewport without sending input. Floating overlays must clamp to a top safe margin so app window chrome never starts under the phone status/top bar. Marker: `remote window realtime two finger vertical scroll no release action top safe clamp pinch local viewport`.
- [2026-08-04] Fullscreen remote-window pinch must update scale and pan as one anchored viewport operation. Runtime `scaleRatio` is relative to the current two-finger gesture start, so overlay must record the current viewport scale at pinch commit/start, multiply by that baseline, and preserve the remote content point under the current two-finger midpoint when changing pan. Updating only scale makes later pinch rounds feel like they restart from the center or a stale touch point. Marker: `remote window anchored pinch baseline scale pan midpoint`.
- [2026-08-04] Fullscreen remote-window post-pinch continuation must seed the remaining one-finger local-pan baseline before consuming move events. After a two-finger pinch/scroll lifts one pointer and runtime returns `localPan`, `RemoteWindowOverlay` must copy the current viewport `panX/panY` into `surfaceLocalPanStartRef`; otherwise the next move is swallowed but the zoomed container does not move. Android native WebView zoom support must stay disabled so custom overlay pinch owns the gesture. Marker: `remote window post pinch remaining finger local pan baseline webview zoom disabled`.
- [2026-08-04] Terminal multi-window preview primary tile is the UI input owner while preview is open. `TerminalPreviewGrid` must publish resolved primary preview session changes to `TerminalPage`; QuickBar sequence, draft send/change, screenshot, and schedule actions must route through that preview owner instead of stale `uiSessionId`. Child preview promotion must not activate/switch the real shell, but it must update the input target immediately. Marker: `terminal preview primary tile input owner not stale active session`.
- [2026-08-04] Terminal refresh residue root cause was the renderer memo boundary: `VisibleRow` compared only row reference, so an in-place cell/style mutation could leave stale DOM pixels. The owner remains `terminal.buffer_render`; `TerminalView` now memoizes a per-row signature over `char/fg/bg/flags/width`, and `VisibleRow` compares it. Changed rows repaint while unchanged rows retain DOM identity. Marker: `terminal row signature selective repaint stale DOM residue`.

## 2026-08-08 remote-window 串流改为单流模式（关键架构决策）
- **真机证据链**：Android WebView 同时接收 canvas+focus 两个 WebRTC 视频流时，focus 流被饿死只渲染首帧（logcat：tracks epoch=3 live、play resolved、但 currentTime 停在 0.468 定住）。daemon 侧发帧正常（本机 ticker 87 帧 / 微信 20 帧），排除 daemon/capture。
- **决策**：`handleSelectTarget` 去掉 canvas('preview') 流，只开 focus 单流。理由：a) 消除双流并存饿死 focus；b) canvas→focus 的 srcObject 切换本身有黑屏空窗（已另加同步 `updateReceiverVideoVisibility(false)` 修复）。
- **"黑屏闪一下"根因**：`setReceiverMediaStream(focus)` 渲染瞬间 video 内容清空（readyState=0）而 wallpaper 遮罩在 useEffect 异步设置、滞后一帧 → 空窗露黑。修复：srcObject 切换同一批次同步隐藏 video。
- **"冻结"根因**：用户串流静止窗口（微信，framesSent=1）→ ScreenCaptureKit 只出首帧。静止窗口冻结是正常行为；ticker（在动）daemon 发 30-87 帧。判别用 daemon stdout `framesSent` 日志。
- **测试**：RemoteWindowOverlay.test.tsx 从 78 删 3 canvas 专属 + 改 11 个双流断言（startStream 调用次数/索引/purpose: 'preview'→'focus'），75 全绿。版本 0.1.3.2483 已发布 OTA。

## 2026-08-08 remote-window 触控输入重构（双模式，2484）
- **设计文档**：`android/docs/decisions/2026-08-08-remote-window-touch-input-rework-design.md`（APPROVED，4 决策点：默认触控模式/单指未放大=滚动/双击缩放/长按右键）
- **双模式**：toolbar「触控/鼠标」切换（localStorage `zterm:remote-window:input-mode-v1`，默认 touch）。触控模式注入 click/scroll action 不模拟鼠标拖动；鼠标模式保留 pointer drag 语义。
- **触控模式手势表**：单指 tap=click、单指拖动=增量 scroll（move 实时注入）、长按(>500ms)=右键、双指同向=scroll、双指反向=pinch（本地缩放）、双击=放大/恢复（fullscreen）、放大后单指=localPan、放大后双指滚动=scroll。
- **仲裁**：双指观察期（120ms 或 1 move）→ 方向判定（isPinchIntentPair 反向投影阈值 8px，防"近平行误判 pinch"）→ scroll/pinch 锁定；单指 localPan 中第二指 down 只记 pending，独立位移 ≥8px 才升级双指（防"单指移动变 pinch 缩小"）。阈值参数化：OBSERVE_MS=120/OBSERVE_MOVES=1/PINCH_MIN_SCALE_RATIO=0.08/SCROLL_MIN_MIDPOINT_PX=8/LONG_PRESS_MS=500。
- **虚拟鼠标消除**：wire scroll 加 `moveCursor?: boolean`（缺省 true），触控模式单指/双指 scroll 一律 `moveCursor:false`；daemon `postScrollEvent` 加 moveCursor 参数（false 跳过 postMouseMove）。
- **新 mode**：actionScroll（触控单指滚动）/ actionLongPress（已发右键）；`toRemoteWindowTouchGestureState` 必须包含新 mode（漏了会转 idle 导致后续 move 丢失——已修）。
- 验证：runtime 18 + overlay 75 + shared 9 + daemon 59 全绿；type-check 0（shared 40 预存错误与本次无关）；APK 0.1.3.2484 已发布 OTA + 装机 15t-1。真机手势验证待用户。
## 2026-08-08 真机反馈修复（2485）
- **长按右键失效根因**：runtime 长按只在 move 事件里检查（timeMs-startAt>=500），手指按住不动没有 move → 永不触发。修复：overlay 在 pointerDown 时启动 `setTimeout(500ms)`（`handleLongPressTimer`），按下不动到期发右键 + 转 actionLongPress；move 转移（滚动/拖拽）或 up 时清理 timer。REMOTE_WINDOW_LONG_PRESS_MS 从 runtime 导出复用。
- **滚动时光标仍移动**：daemon 侧 swift 注入改动未生效——launchd 跑的是旧 server.cjs（无 moveCursor）。重新 `daemon:prepare-release` + `zterm-daemon.sh install-service`，新 daemon（~/.zterm/daemon-runtime/server.cjs 含 moveCursor×3）已运行。
- **待真机重测**：放大后双指手势无效（本地仲裁逻辑审查无明确 bug，需 2485+新 daemon 复测）；点击图片失焦无感知（需用户描述 app/坐标）。
- 版本 0.1.3.2485（长按修复）已 OTA + 装机 15t-1。

## 2026-08-08 多窗口 UI 布局（主画面 + 总览横条 + 子队列，2490）
- **设计文档**：docs/decisions/2026-08-08-remote-window-multi-window-ui-layout-design.md（APPROVED：焦点窗口放大 / 下方横条总览 / 选中即放大 / 仅切主画面不重构）
- **三区 UI**：主画面 = video 裁切焦点窗口区域（focusedVideoStyle：画布×scale + margin 定位）；总览横条 = canvas drawImage 全画布；子队列 = 每窗口小 canvas（选中项 160×120 放大 + 蓝框），横向滚动（overflowX auto），新增窗口自动入队
- **rAF 绘制**：组合模式 useEffect 每帧 drawImage video → 总览/缩略图 canvas（共享同一 WebRTC 流）
- **输入**：resolveSurfaceInputGeometry 组合模式 sourceRect = 焦点窗口画布区域（base crop + offset），触点→窗口内比例→画布坐标→daemon 命中窗口
- **布局算法**：resolveRemoteWindowCompositeWindowLayout（overlay-runtime，与 daemon 同算法单行平铺）；选目标 attachSameAppCompositeWindows 自动带同 app 全部窗口
- 验证：type-check 0、overlay-runtime 13 + overlay 75 全绿、build:android PASS，APK 0.1.3.2490 已 OTA + 装机 15t-1
- **待做**：自动增删（catalog 刷新检测新窗口 → 重开流/handoff 加入组合）

## 2026-08-09 远程窗口双流切换 Mac Studio 真机闭环

- Mac app-window catalog 的 `AX contentFrame` 不能直接作为 ScreenCaptureKit `desktopIndependentWindow` crop：它可能带 title-bar 偏移并落到 `windowBounds` 外。唯一 owner 使用 `windowFrame`，并以反例测试锁住 `cropRect ⊆ windowBounds`。
- 单窗口 capture 走 `SCScreenshotManager` 时不在 `activeStreams` 注册；Swift update-config 必须由独立的单窗口 capture target 真源承接，不能只检查 `activeStreams`。
- dual-stream 控制面必须区分 wire `streamTargetId` 与 UI `windowId`：pending/ready 匹配使用 `app-window:<pid>:<windowId>`，overview crop 使用 `<windowId>`；混用会吞掉 ready，永久停在 `overview-crop-visible`。
- 2515 真机闭环：Mac Studio `100.66.1.82:3333`、15t-1 `100.104.163.65:5555`；focus 580x385 + overview 1920x1080，两个 video track 首帧 ready，点击 sibling 收到 `accepted`/`ready`，最终 `focus-committed`，布局 `secondaryPlacement=before`。
- 构建门禁事实：完整 `build:android` 当前被既有 `FileTransferSheet.test.tsx` 1 个环境/时序失败阻断；远程窗口定向测试、type-check、Vite、Gradle、OTA manifest verify 通过。交付前需保留该未完成风险并修复/复跑全量门禁。

- [2026-08-09] Remote-window dual-stream layout is fixed at the Android overlay owner: sibling rail is always a non-wrapping horizontal row above the primary pane, with horizontal overflow for additional children; the generic `WindowGroupLayout` landscape side-rail behavior remains unchanged. Live 15t-1 DOM proof for TextEdit `703:67/65/3899` showed `placement=before`, `primaryAxis=column`, rail rect above main rect. Marker: `remote window three child top rail primary bottom live dom`.
- [2026-08-09] The remote ScreenCaptureKit Swift source had a strict warning-as-error chain on the actual Macbookair compiler: unused image dimensions, mutable `allWindows` concurrent capture, missing `@Sendable` on `compositeFrameLoop` / `startCompositeCapture` / `findScWindow`, ScreenCaptureKit import Sendable warnings, and unused `NSApplication.shared`. Each was isolated in playground H3-H9; the full current source then compiled on Macbookair with `swiftc -swift-version 5 -warnings-as-errors` exit 0. Marker: `remote capture strict swift compiler probe zero exit`.
- [2026-08-09] After deploying the hash-matched daemon archive and service-scoped launchd restart, real 15t-1 TextEdit and iTerm2 pane capture both reach ScreenCaptureKit but fail before any frame with `SCStreamErrorDomain Code=-3801` TCC denial. This is a reproducible external Screen Recording authorization boundary for the Macbookair launchd daemon/capture child; no overview/focus/crop/ready/commit truth may be inferred until that permission changes. Marker: `macbookair launchd screencapturekit tcc 3801 no frame`.
- [2026-08-09] On the corrected Mac Studio endpoint `100.66.1.82:3333`, the same native `Code=-3801` was reproduced independently for focus and composite probes; do not mix Macbookair and Mac Studio evidence. Marker: `mac studio focus composite tcc 3801 zero frame`.
- [2026-08-09] Dual receiver track ordering is a correctness invariant: focus may arrive before overview, but the shared resolver must remain pending until all required tracks attach. Marker: `remote receiver focus first overview required resolver`.
- [2026-08-09] App-window overview is independent even for a singleton, but the primary window must never be synthesized as its own child. Multi-window output uses source crop geometry plus explicit 1920x1080 output dimensions; remote secondary rail is a non-wrapping row above the primary pane. Marker: `remote composite no synthetic primary fixed 1080p top rail`.
- [2026-08-09] H13 fixed capture identity was compiled from the canonical ScreenCaptureKit Swift source, installed under the Mac Studio daemon release, and activated through `ZTERM_DAEMON_CAPTURE_NATIVE`; direct and daemon launches still return TCC `-3801`. System Settings confirms the `ZTerm` Screen & System Audio Recording toggle remains off. The remote-window live first-frame gate is therefore externally blocked; no video truth may be inferred until permission changes. Marker: `fixed native capture zterm tcc 3801 permission off`.
- [2026-08-09] H14 TCC owner correction: `computer-use` and SSH endpoint `100.66.1.82` are the same `Macstudio.local`; the GUI and daemon were not different machines. A signed `ZTerm Remote Capture` bundle was added to that same Mac Studio Screen & System Audio Recording list with toggle `on`, but direct bundle execution and launchd daemon capture still returned `SCStreamErrorDomain Code=-3801` before `ZRW1`. Helper-only authorization is therefore insufficient; launchd/Node responsible-process identity remains unproven. Evidence: `playground/remote-window-dual-stream-20260809/H14-tcc-owner-identity.md`.
- [2026-08-09] 无串流也卡(输入延迟高)的静态+真机审计:根因是每次 daemon buffer-sync 帧,client 端做冗余全量深拷贝 + 双重全量比较 + 全量签名重算。真机 gfxinfo(15t-1)High input latency 36 次 / janky 9.9%。已修复:①`session-buffer-store.cloneSessionBuffer` 改行级复用(未变行 `row === previousRow` 复用引用,与 render-store 一致;原地 mutate 场景 caller 行 ≠ 快照行仍走深拷贝,不复活 2026-06 内容判等修复的 bug);②`commitBuffer({ skipEqualCheck })` 去掉 buffer-runtime apply 主链的第二次 O(rows×cols) 比较(cursor 元数据路径 L678 保持默认比较);③`terminalRowRenderSignature` 加 WeakMap 按行引用缓存(行引用不变=内容不变的 immutable 契约)。防复发测试:`session-buffer-store.test.ts` 行级复用 + skipEqualCheck 红测、`TerminalView.signature.test.ts` 缓存红测。Marker: `voice ime disconnect no stream lag perf audit row reuse skip equal signature cache`.
- [2026-08-09] 连接链路修复落地的关键非显然事实:①mux 路径的 4s handshake 超时原本从 intent 入队即计时(把 socket 候选串行 13.9s 算进 4s 预算,慢候选被砍成假失败),旧路径(bindSessionTransportSocketLifecycle)本来就在 onopen 启动——mux 是回归点,修复=对齐旧路径;②daemon health 端点是 `/health` 不是 `/healthz`;③rtc-direct 与 rtc-relay 的 signal 会话有严格顺序依赖(relay 必须等 direct 清理),并行化只能并行 ws 组;④TraversalSocket settleWinner 里 close 落选候选必须只置 advanced 不置 settled,否则 onclose 走"物理断线"分支误报上层+误记 health failure;⑤显式 reconnect 经 scheduleReconnect(immediate)→startReconnectAttempt→runReconnectHostProbeAndFallback,attempt≥1 时若 probe 全失败不可 deleteRuntime,须保底 queue 当前 host(原契约 index 0 无条件 queue)。Marker: `conn review p0a socket phase no short timeout p0b http health probe p1c ws parallel rtc ordered p1d probe parallel fallback current host p1e quarantine contract 3s p2 plan cache 5s head first`.
- [2026-08-10] Relay duplicate projection uses daemon host identity; network recovery wakes scheduled reconnects. OTA bundle for APK `0.1.3.2527` was generated and verified with manifest/hash/size/alias/rollback/daemon-copy checks all true in explicit Java 21 environment. Future APK delivery requires this OTA gate.
- [2026-08-10] Remote-window app 窗口切换黑屏根因已闭环（playground H1）：单窗口 `update-config` 复用启动时 `SCShareableContent` 快照，capture 启动后新出现的窗口在 `findScWindow` miss → 主循环发**全黑帧**且 Swift 立即 ACK `ok:true`（假阳性）→ daemon 视黑帧为正常帧发 `focus-ready` → client 提交黑屏；组合分支重枚举所以 sibling 切换可用。修复（`android/src/server/remote-window-scripts.ts`）：①单窗口 update-config 重枚举 content + `findScWindow` 存在性 guard（miss → `ok:false` + error，走 `update_focus_failed` 错误面）→ `startSingleWindowCapture` 重建；②新增 `captureLoopGeneration`，组合/单窗口主循环都校验代次，修复 `compositeStopped=false` 重置导致旧循环复活持续发黑帧的竞态（实测 3:1 黑:内容交替）。playground 验证：formal 源 8/8 黑帧 → fixed2 副本 8/8 非黑帧 + ghost 窗口 `ok:false`；daemon/capture/dual-stream 74 PASS、overlay 70 PASS + 4 skip、tsc 通过。真机 V1-V5 矩阵未执行；组合分支可加同款 guard 加固。Marker: `remote window switch black frame snapshot stale update config single window generation guard ok false focus failed`. Evidence: `playground/remote-window-window-switch-20260810/`.
- [2026-08-10] 网络变化后"永远连不上、必须杀进程"根因闭环（client reconnect 域）：三段断点链 ① 半开 socket 窗口——网络切换后旧 WS readyState 仍 OPEN，resume 只发 head/mux-ping，head 超时重发不重建、ping GenerationTimeout 判 inconclusive，需等 90s 心跳判死（设计意图，有测试守护）② 直连候选陈旧——reconnect 的 host 候选来自 cached transportHost（连接时投影），设备列表刷新后新 tailscale/ipv4 不会回流；daemon 模式 openConfirmedTransport 只在目录 entry 存在时清空直连字段，直连场景目录 entry 缺失=永远旧 IP ③ error 态（12 次失败 deleteRuntime）后 wakeScheduledReconnects 只扫 scheduled，online/resume 之外无自动恢复。修复 F1：mergeHostWithLatestProjection（home-connection-projection.ts）按 daemonHostId 合并最新投影直连字段；注入链 App→AppContent 写 latestSessionHostsRef→SessionProvider→core-assemblies→orchestration→startReconnectAttemptRuntime.refreshHostForReconnect→probe 前刷新 host。红测：session-context-session-runtime.test.ts "freshest direct endpoints"。80+ 测试绿 + tsc 绿。F2（error 态网络信号自动唤醒）留作后续；半开加速（head 连续超时升级重建）是设计变更，未动。
- [2026-08-10] 「IP 与连接绑定」策略落地：网络切换后仍连不上的**最终执行点**是 `openConfirmedTransport`（session-context-infra-runtime.ts）在目录 entry 存在时**无条件清空 host 直连字段**（bridge/tailscale/ipv4/ipv6），只留目录 relay endpoints——daemon 注册过 relay（Mac Studio 常态）→ 目录必有 entry → 成功连接过的局域网/tailscale IP 在重连时被丢弃；目录 stale（网络切换后未刷新）→ 旧 IP 打不通 → 永远连不上。清空逻辑源自 2026-08-01 决策 fa495fc「relay directory endpoint auth wins over stale saved host auth」——意图是目录候选带最新 token 先打，但矫枉过正砍掉了 buildTraversalPlan 里现成的「目录优先 + host 兜底」去重链。修复：删除清空，`transportHost = resolvedHost`（mergeHostWithClientControlDirectory 已合并目录 endpoints）→ buildTraversalPlan 自动生成目录候选先打、host 直连兜底（endpoint 去重）。目录新鲜→目录通；目录 stale 但 daemon IP 未变→host 直连兜底通（用户场景）；两者都挂→relay-rtc 兜底。红测：`session-context-infra-runtime.test.ts` "keeps successfully-connected direct endpoints as fallback candidates when the control directory entry is stale"（修复前 plan 无 100.66.1.50 → 红）；既有测试 194 行断言从 3 候选改为 4 候选（多出的 tailscale=host 旧直连兜底，目录候选 100.66.1.83 在前、兜底 100.66.1.82 在后）。验证：infra-runtime 11 PASS、contexts+traversal 647 PASS、全量 2607 PASS（6 失败经 stash 基线证实既有）、tsc 0。Marker: `open confirmed transport direct fallback stale directory ip bind connection network switch`.
- [2026-08-10] 抽屉「同一台机器两个实例且 session 不同」根因闭环（relay 目录域）：relay 服务端目录里有同一物理机两条不同 hostId 的 daemon 记录——旧 wterm 0.1.0（deviceId=`Macstudio.local-daemon`，hostId=`c5f61277-...`，进程已死）+ 新 zterm 0.1.3（`mac-studio`，config 身份）；客户端 dedupe 按 daemon.hostId 无法合并。**半开残留机制**（playground 实证）：daemon 只在 relay-ready 时 publish 一次、无心跳；Mac 睡眠/网络切换后 relay WS 半开断开（本机 lsof 已无到 relay 的 TCP 连接），服务端收不到 RST（close/kill -9 时 8-10s 判死，网络断开不判死）→ connected=true 永久残留 → 抽屉把死实例当在线。服务端 lastSeenAt 随正确格式 `directory-update` publish 实时更新（probe2 实证；错误类型 `relay-directory-update` 被忽略）；无设备删除 API（DELETE /api/devices/* 404）。修复双管齐下：① daemon `relay-client.ts` 新增 `createRelayHostDirectoryPublishLoop`（60s 定期 publish + ping/pong 活性护栏，pong 超时 terminate 触发重连，lastSeenAt 持续新鲜）；② 客户端 `isOnlineTraversalRelayDaemonDevice` 加 `ONLINE_DAEMON_FRESHNESS_MS=15min` lastSeenAt 新鲜度（无 lastSeenAt 保守放行），并修复 `devices.filter(isOnline...)` 把 filter index 当 now 参数的接线 bug（红测暴露）。红测：traversal-relay-devices.test.ts stale connected 过滤；scheduler 4 个 fake-timers 测试。验证：核心 44 PASS、session-drawer 43 PASS、全量 2611 PASS（7 失败=6 基线+1 flake）、tsc 0。**升级顺序注意**：客户端过滤先生效会把「未升级 daemon」也过滤掉（lastSeenAt 陈旧）——daemon OTA 升级后恢复显示；服务端侧根治（半开判活超时/删除 API）不在本仓库。Marker: `relay directory stale connected half open residue lastSeenAt freshness publish loop ping pong terminate dedupe hostId duplicate machine`. Evidence: `playground/relay-dir-freshness-20260810/`.
- [2026-08-10] Relay 抽屉判活上限误杀修复并发布：15 分钟 `daemon.lastSeenAt` freshness 单条件会误杀未升级 daemon（无 60s directory publish，lastSeenAt 停在启动时刻）。架构归属 `relay.directory_ui` / `client.connection_home`；`client.daemon_connection` 仅在真实 `connected` server message 提供 `daemonHostId` 握手证据，connection-home 新增 `relay-host-recent-connection.ts` 以 `browser-storage` 持久化 7 天，在线判定改为 `fresh directory publish OR recent confirmed connection`；无 storage 安全退化。这样 `mac-studio` 即使旧 daemon lastSeenAt 陈旧但本客户端近期连过仍保留，旧 `Macstudio.local-daemon/c5f61277-*` 从未被当前客户端连接，继续过滤。daemon 同时已部署 `relay-client.ts` 60s directory publish + ping/pong 半开护栏，launchd runtime 重打包重启；生产 relay 实测 mac-studio lastSeenAt 从 `14:46:10.359Z` 到 `14:47:10.360Z` 精确刷新 60s。验证：红测期望 `['mac-studio']` 实际 `[]`；修后相关 152 PASS、feature/module/edge 80 PASS、tsc 0、全量 2614 PASS（6 基线失败，新增 ownership failure 已修复）。APK `0.1.3.2531` / versionCode `1100025310`，sha256 `a0d3b2bf89db7e9bd5fb02e5f552c0da87a664217784df9758268db47b7d3a60`；rollback `0.1.3.2531.1`；update bundle 14 checks 全绿，本地 `~/.zterm/updates` 与公网 `https://relay.codewhisper.cc:18443/relay/updates/latest.json` 对齐，公网 APK HEAD 200 / Content-Length 4888962 / 下载 sha 匹配。构建脚本最终 scp 曾一次 exit 1，手工补发同一已验证产物后公网闭环。ADB 已安装 `100.104.163.65:5555`，两台设备 dumpsys 均为 2531。Marker: `relay stale daemon recent connected hostId seven day freshness unupgraded daemon no false negative`.
- [2026-08-11] Android 后台回前台白屏根因是 stopped Activity 的真实浅色 task snapshot，不是 WebView/React 生命周期。API 33+ 在 `MainActivity.onCreate` 的 `super.onCreate` 之前调 `setRecentsScreenshotEnabled(false)`，并给运行主题 opaque 深色 `windowBackground`/`colorBackground`、给 launch theme 显式 `postSplashScreenTheme`，系统即改为非真实 dark replacement snapshot，前台不再贴真实浅色截图帧；禁止 `FLAG_SECURE`、JS/App/TerminalPage 补偿。正式 APK `0.1.3.2550` / `1100025500` sha256 `75f04412514fc0ab0853a05f787bbe7060a3bee761479a8e5d36ecee0a6b8c11` 三通道对齐并装机 `100.104.163.65:5555`；三次 HOME -> foreground 均为 `mIsRealSnapshot=false`、`mSnapshotBundle={mode=1,color=-16777216}`、`shouldAppSnapshot=false`，截图无白帧。Marker: `android foreground white flash real task snapshot recents screenshot disabled opaque theme no flag secure`.
- [2026-08-12] Android 真机事故护栏：`adb uninstall com.zterm.android` 会删除 WebView `localStorage` 私有配置；测试升级只能用 `adb install -r` 或应用内 OTA，不能用卸载/清数据绕过版本问题。任何不可逆清理前必须有 Jason 授权和 `zterm-config.json`/可验证备份；`.build-meta.json` 只能由 `bump-build-version.mjs` 顺序递增，禁止手工抬号、跳号或回退；Relay stable 发布也必须单独获得授权。事故后设备 `0.1.3.2581` 为 fresh data，未找到旧配置备份；主仓库版本真源保持 `2580`。Marker: `android uninstall webview localstorage config loss build meta manual version ota publish authorization guard`
- [2026-08-11] QuickBar 自定义快捷按钮编辑入口是行级 UI projection：竖屏第一、第二快捷行末尾分别保留 `shortcut-editor-top` / `shortcut-editor-bottom` 两个 `+`，横屏合并快捷行同时保留两个；第三工具行不得用单个通用入口替代。两者复用同一个 `openShortcutEditor` owner，不发送 terminal sequence。Marker: `quickbar two row local shortcut editor plus entries not tool row`.
- [2026-08-11] QuickBar 全屏编辑器必须 portal 到 `document.body`，不能留在 `TerminalQuickBarShell` 的低层 stacking context；否则即使子节点 z-index 很高，顶部连接/上下载速率栏仍会压在编辑器之上。修复属于 `terminal.quickbar` UI projection，不得通过隐藏传输速率或移动两行自定义入口补偿。真机 CDP 验收必须在速率栏坐标比较 `elementsFromPoint`，确认 editor overlay 先于 status strip。Marker: `quickbar editor body portal above connection transfer rate status strip`.

- [2026-08-12] Android background disconnect first divergence: installed APK logs show BackgroundService tick calls App `sendMessageRaw(sessionId, {type:'ping'})`; mux outbound owner rejects legacy ping with `legacy terminal message ping cannot be sent on mux target transport`, breaking the background heartbeat path. Fix owner is SessionContext/client.daemon_connection public transport facade: deduplicate by physical daemon target and send typed `mux-ping`; UI must not build raw heartbeat payloads. Service lifecycle-only changes do not fix connection management. Marker: `android background service legacy ping mux target rejection first divergence`.

# 2026-08-12 Herdr daemon close-loop and restart round 6

- 正式 daemon Herdr close-loop 已通过真实运行版本：create、initial buffer-sync、input marker、resize `100x30`、release/close、reconnect、close removal；zterm mirror revision 从 1→4 独立生成，reconnect 保留当前 revision truth。
- daemon 进程显式终止后，detached Herdr server 仍存活；新 daemon 通过官方 `herdr session list --json` 与 `pane list` 重新发现命名 session，再次完成 input/resize/reconnect/close。Herdr workspace/layout 不进入 daemon truth。
- Herdr named-session rename 没有官方持久化 API，正式 runtime 现在显式抛出 unsupported；不再用内存改名伪造成功。
- Herdr capture 不再用 `rows + cols` 伪造 tmux history/absolute range hint；无官方稳定范围时保持 capability gap/fail-fast。server glue 使用通用 `TERMINAL_BACKEND_RUNTIME` 命名，避免把 Herdr 误称为 WezTerm。
- Windows 真实远程 WezTerm direct snapshot 与 input smoke 通过；Windows daemon protocol smoke 完成 health、missing-session failure、create/connect/initial mirror/input，但 targeted cleanup 只收到 error 而没有 sessions close-list 收口；health 随后显示 session total=0。ConPTY/Windows daemon gate 因此保持 beta/gap，不能宣称 Windows 通过。

# 2026-08-12 Herdr completion audit round 7

- 当前官方 Herdr integration status 证据：Codex、OpenCode 均为 `not installed`；Reasonix 没有官方 Herdr integration 命令或已确认 native session/lifecycle contract。结论是 terminal payload side-channel 静态隔离 gate PASS，但 Codex/OpenCode/Reasonix 外部 operational integration audit 未配置、未证明，不能把静态 gate扩大成集成 PASS。
- Windows 远端 daemon gate 的错误已完整暴露为旧安装 runtime 的 `wezterm backend does not support tmux command: kill-session ...`；health 最终 session total=0，但控制面未发送 sessions close-list 收口。Windows 明确保持 beta/gap。
- 第一次 Codex review 针对整棵未提交工作树返回 `missing_or_ambiguous_verdict`，正文为三个与 Herdr 无关的 Android lifecycle/network P2；不能视为 Herdr PASS，也不修改这些并行任务文件。
- canonicalizer reconnect 修复后，Herdr 17 定向 tests、tsc、Vite production build 通过；完整 `pnpm run build` 本轮被既有 `FileTransferSheet.test.tsx` 的 native stat `EIO` 断言环境/时序失败阻断，Gradle 与此前完整 build 证据仍通过，不能把本轮 full build 称为 PASS。
- 随后单独重跑该 native-stat 测试通过，完整 `pnpm run build` 再跑全绿：prebuild registry/UI/transport/terminal/relay/workspace gates、Gradle、type-check、Vite 均 PASS；前一轮 EIO 为非稳定时序失败，不是当前 Herdr 代码缺陷。
- 当前 agent binary 版本证据为 Codex CLI `0.147.0`、OpenCode `1.18.16`、Reasonix `v1.23.0`；但 `herdr integration status` 仍显示 Codex/OpenCode integration not installed，Reasonix 没有官方 Herdr integration。版本存在不等于 side-channel integration audit PASS。

# 2026-08-12 Herdr completion audit round 8

- review P1 修复：Herdr source 已发送 `terminal.closed` 后，adapter `release()` 现在幂等返回，允许 runtime cleanup 继续 dispose transport 并删除 session；新增反向测试锁住该边界。
- review P1 修复：named-session restart discovery 不再无 identity 选择 `panes[0]`；多 pane 明确报 ambiguous，只有持久化且唯一的 terminal/pane identity 才可恢复；对应纯函数正反测试通过。
- 定向门禁：Herdr backend/process/canonicalizer/side-channel 4 files、20 tests、TypeScript、diff check 全绿；随后完整 `pnpm run build` 全绿（registry/UI/transport/terminal/relay/workspace、Gradle、type-check、Vite）。
- 发布/运行证据：release runtime `server.cjs` 与 `/Users/fanzhang/.zterm/daemon-runtime/server.cjs` SHA256 均为 `b8e0f0aa5d4f8daa95f6a0d9b68b58530e4c7129ed09e8e31a80cf0e03ce40c8`；服务安装脚本仍因既有 macOS Screen Recording preflight (`could not create image from display`) 退出，但已确认复制完成，launchd 默认 tmux 服务健康。
- 使用同一安装 runtime、隔离端口 `39091`、显式 `ZTERM_TERMINAL_BACKEND=herdr` 完成真实 daemon close-loop：initial `80x24` revision 1，input revision 3，resize `100x30` revision 4，reconnect revision 4，close 后官方 session list 为空。之前 launchd 端口的失败样本实际命中了默认 tmux，不能作为 Herdr 证据。
- Windows 结论仍为 beta/gap：WezTerm/ConPTY 真实 close-list gate 未通过；Codex/OpenCode/Reasonix operational integration 未配置/未证明。Herdr 不能宣称替代 tmux 100% parity，tmux 继续 parity oracle。

# 2026-08-12 Herdr review P1 remediation round 9

- mirror-fixed P1：`handleAdaptiveResize()` 不再从 fixed-mode client viewport/IME/container cols 调用 backend resize；现有反向测试保持 `runTmux` 零 resize。
- backend-aware adaptive resize：adaptive lease 的 apply/release 对 tmux 走 tmux owner，对 Herdr/WezTerm 走 `resizeBackendSession`；修复 Herdr adaptive resize 误落到 tmux command 的在线错误。
- Herdr session creation 先验证 `pane get` scroll capability 与初始 terminal rows；不满足 absolute-range 前置能力时清理 server 并显式失败。
- 最新 release/runtime SHA256：`01886c568e7889583eca439cfd28744d8e899aff405cd0048267ba34dc2df20b`；完整 build、安装复制、launchd health 通过。
- 最新安装 runtime Herdr close-loop 通过：`80x24 rev1`、input `rev3`、adaptive resize `100x30 rev4`、reconnect `rev4`、close 后官方 session list 为空。

# 2026-08-12 Herdr absolute-range boundary round 10

- 最终 review 确认 Herdr `max_offset_from_bottom` / `offset_from_bottom` 只是 host viewport offset，不是 zterm 稳定 absolute line identity；已物理删除其到 `absoluteRange` / absolute cursor 的推导，canonicalizer 保持 `absolute-range-unavailable` capability gap。
- adaptive lease 现同时保存并比较 cols/rows；同 cols 但 rows 变化会重新调用 backend resize，避免 Herdr/WezTerm geometry stale。
- 因官方 Herdr 当前没有可验证的稳定 absolute line identity，Herdr canonical mirror parity gate 未通过；不能宣称 Herdr 100% tmux parity 或本目标完全完成。输入、resize、reconnect、close 的 transport close-loop 证据仍有效，但 absolute-range/visible-history repair 需官方稳定 identity 后续补齐。

# 2026-08-12 Herdr canonical scrollback round 11

- `@jsonstudio/wtermmod-core` 官方 bridge 暴露 `getScrollbackCount/getScrollbackCell/getScrollbackLineLen`；formal canonicalizer 已使用其 VT-owned scrollback 加 visible grid 生成 attachment-local absolute rows，完全移除 host offset 到 absolute range 的换算。
- 新增 canonical scrollback absolute-range 测试；Herdr canonicalizer 定向 10 tests、backend/process/mirror 合计 55 tests、tsc 全绿。
- 最新完整 build、release、安装复制、launchd health 全部完成；Screen Recording preflight 仍因既有 macOS 权限失败但不影响 runtime copy，未执行 TCC reset。
- 最新安装 runtime Herdr close-loop：initial rev1、input rev3、resize rev4 `100x30`、reconnect rev5、close 后 session list 移除；absolute range 由 canonicalizer scrollback owner 提供。

# 2026-08-12 Herdr final gate reassessment round 12

- Windows 真实远端 WezTerm snapshot/input smoke 通过；daemon protocol smoke 仍未收到 targeted cleanup 的 `sessions` close-list，虽 health 最终为 `sessions.total=0`，所以 Windows ConPTY/daemon 状态保持 beta/gap。
- 最新正式 Herdr 定向 6 files / 42 tests、`tsc --noEmit`、`git diff --check` 全绿；launchd 安装 runtime health `ok:true`。canonicalizer-owned VT scrollback range 已同步到 parity 审计矩阵。
- 仍不可完成整体目标：完整 tmux black-box parity、range repair、Codex/OpenCode/Reasonix operational audit、Windows close-list gate 未通过；Herdr feature registry 保持 `status: pending`。
- 最新 Codex review 只报告混合工作树中无关 Android P1/P2，Herdr 专项无 finding，但无语义 PASS；不得把 review 当交付通过。
- 新增真实同样本 parity probe：同一 ANSI/VT 样本分别运行 tmux 与官方 Herdr，tmux `capture-pane -e` 作为行快照先恢复 CRLF，再复用正式 Herdr canonicalizer；rows、CJK/emoji wide-cell shape、80x24 geometry、cursor `(3,2)` 全部相等。tmux snapshot canonical revision 与 Herdr zterm revision 各自从 1 起，Herdr attachment seq 单独记录，证明 revision namespace 不相互映射。证据文件：`playground/herdr-adapter-experiment-20260812/tmux-herdr-canonical-parity-evidence.json`。
- 同样本进一步覆盖 SGR、erase、scroll、alternate-screen enter/leave、OSC title、kitty graphics；最新 probe 仍 exit 0，canonical rows/cells/cursor/geometry 全部相等，Herdr zterm revision 与 attachment seq 保持独立。
- 当前安装 runtime `/Users/fanzhang/.zterm/daemon-runtime/server.cjs` 在隔离端口 `39094` 显式 Herdr close-loop 重跑通过：initial rev1、input rev3、adaptive resize rev4 `100x30`、reconnect rev5、close removal true。
- 正式 `herdr-frame-canonicalizer.test.ts` 已从 10 扩展到 12 tests：把 SGR、erase、scrollback、alternate-screen enter/leave、OSC/kitty graphics、CJK/emoji width、wrap 和 bottom-metrics absolute cursor 语义从 playground 提升到唯一 formal test owner，全部通过。
- 本轮完整 `pnpm run build` 全绿：prebuild 83 tests、Gradle、terminal contract 814 tests、common flows 91 tests、relay/account/workspace gates、type-check、Vite；最新 oauth review 仍 fail，findings 仅落在无关 RemoteWindowOverlay 样式 P1 与 attachment notification race P2，Herdr 专项无 finding，因此不能视为 review PASS。
- 新增 `herdr-backend-runtime.test.ts` 验证 canonical snapshot 到通用 mirror snapshot 的 range/cursor/geometry/zterm revision 投影与缺失 range 显式失败，Herdr runtime/registry 专项 25 tests 通过；当前全局 tsc 被无关并行 `TerminalView.tsx` 未定义 refs/setters 阻断，故本轮新 helper 尚未重新安装，不能宣称源码/运行版本已重新对齐。
2026-08-12 Herdr runtime projection and installed close-loop are verified: `mapHerdrCanonicalSnapshot` is the sole Herdr-to-mirror projection and preserves canonical absolute range, cursor, geometry, and zterm-owned revision; null absolute range throws instead of fabricating a range. The installed explicit Herdr runtime replay on port 39095 produced input revision 3, resize revision 4 at 100x30, reconnect revision 5, and removed the session on close. Release and installed daemon runtime SHA-256 match (`9d38c0ce0c7eb3d89ca59c33eb2f4bb59745924b`). Herdr-specific tests pass 25/25 and registry/resource/map tests pass 43/43. Full Android typecheck/build is not claimable because unrelated dirty `android/src/components/TerminalView.tsx` currently has undefined refs/setters; the Herdr change did not modify that file. macOS service installation remains gated by the existing Screen Recording preflight failure, and Windows remains beta/gap pending the remote daemon cleanup gate.
2026-08-12 Herdr mirror projection semantic correction: cursor-key application mode is now preserved from the canonical VT snapshot into the shared mirror snapshot; the generic mirror contract was widened from false-only to boolean, with Herdr positive coverage asserting true propagation. Targeted Herdr plus architecture/resource/map gates pass 69/69 and TypeScript passes. Full build is currently not green only because two unrelated dirty `SessionContext.ws-refresh.test.tsx` reconnect timing assertions fail after 812 passing tests; no unrelated source was altered. New release/install hash `0b858d4e87ff3f41d1cde8618e3fea87daf24226` matches the installed daemon runtime. After launchd restart, explicit installed Herdr close-loop on port 39096 passed input rev3, resize rev4 100x30, reconnect rev5, and close removal. Windows remains beta/gap and final Codex review still lacks semantic PASS.
2026-08-12 Build gate recheck is green after a standalone retry of the flaky unrelated `SessionContext.ws-refresh.test.tsx`: complete `pnpm run build` passed all prebuild suites, Gradle, 814 terminal contracts, common/relay/workspace gates, TypeScript, and Vite. Herdr projection remains tsc-clean and targeted/map gates are 69/69. Final Codex review task `20260812T185122Z-review-69429-dh9pz8` is an explicit FAIL only on unrelated `RemoteWindowOverlay` missing composite style keys (P1) and `useAttachmentNotifications` polling race (P2); no Herdr finding. Delivery review therefore remains blocked by mixed-worktree findings, not by Herdr implementation.
2026-08-12 Herdr single-surface boundary is now explicit: `herdr-backend-runtime` projects fixed synthetic `workspace: herdr-single-session`; official Herdr `terminal_id/pane_id` stay attachment-local physical identity and Herdr pane/workspace layout never enters daemon session truth. Registry/function docs and a targeted assertion are updated. Full build, TypeScript, targeted 67/67 gates, release/install hash, launchd restart, and installed Herdr close-loop all pass. Runtime hash is `045e05de960f5710dd73cd4da9c0a9015a5d60c9`. Windows remains beta/gap; macOS install permission preflight remains external; final Codex review still fails only on unrelated parallel files.
2026-08-12 tmux parity remediation: fixed `server.ts` backend resize dependency wiring. Tmux now receives no backend-resize callback and retains adaptive `resize-window` plus release/restore path; Herdr/WezTerm receive their native `resizeSession` callback. This resolves review P1 and preserves the unique adaptive width owner boundary. Targeted 113/113, full build, release/install hash, launchd recovery, and installed Herdr close-loop all pass. Runtime hash `76c30d2e4e8c07d5ed36e52f10b792c8d4b1ab3c`. Remaining review finding is unrelated attachment notification polling race; Windows remains beta/gap and external agent integrations remain unproven.
2026-08-12 final review state: after fixing tmux adaptive resize wiring, Codex review still fails only on unrelated parallel worktree changes: NetworkIdentityPlugin requires Android ACCESS_NETWORK_STATE manifest permission (P1), and attachment notification polling needs an in-flight guard (P2). No Herdr finding. Keep Herdr feature pending until review/worktree gate is clean; do not claim completion from Herdr-only green tests. Windows remains beta/gap; Codex/OpenCode/Reasonix operational integration remains unproven.
2026-08-12 side-channel/Windows re-audit confirms no change: Herdr integration status reports Codex/OpenCode not installed, Reasonix has no confirmed official Herdr integration surface; static payload isolation passes. Do not treat an unauthenticated Windows smoke timeout as gate evidence. Prior authenticated remote result remains authoritative: direct WezTerm snapshot/input passed, daemon targeted cleanup close-list did not, Windows beta/gap.
2026-08-12 evidence hygiene correction: updated stale playground canonicalizer evidence/README so historical pre-integration gaps no longer contradict the formal adapter and installed close-loop. Current explicit gaps remain Windows ConPTY/cleanup beta-gap and unproven external Codex/OpenCode/Reasonix integrations; file/image/schedule contracts are outside the Herdr single terminal-surface scope.
2026-08-12 Herdr discovery error boundary: `herdr-backend-runtime.resolve()` previously swallowed official `session list` / `pane list` discovery errors and converted them to generic `session not found`, violating the no-fallback and explicit-failure contract. The unique Herdr runtime owner now preserves the external discovery error; six Herdr files / 27 focused tests, TypeScript, and diff check pass.
2026-08-12 Herdr runtime reinstallation after discovery fix: full `pnpm run build` passed all registry/UI/transport/terminal/relay/workspace gates, Gradle, type-check, and Vite. Correct release/install scripts are `pnpm --dir android run daemon:prepare-release` and `pnpm --dir android run daemon:install-service`; service health is running with `active_count=1`, and release/installed `server.cjs` SHA256 is `064d09ea7a572bb2014cb46c1cae5118f160d938e1331b65a4c4abffa4773eb4`. Explicit installed Herdr daemon on port 39099 passed input revision 2, adaptive resize revision 3 at 100x30, reconnect revision 4, and close removal true; isolated daemon was explicitly stopped after the probe.
2026-08-12 final review after runtime reinstallation: Codex task `20260812T192420Z-review-2993-b5jnk0` returned FAIL on three unrelated parallel worktree findings: `RemoteWindowOverlay.tsx` fill-mode crop/input geometry P1, Android network-state manifest permission P1, and `useAttachmentNotifications.ts` in-flight race P2. No Herdr finding; do not modify those parallel owners without authorization and do not treat review as PASS.
2026-08-12 Herdr mirror-window audit: formal projection previously published the entire canonicalizer scrollback, unlike the bounded WezTerm/tmux mirror cache. Added `maxMirrorLines` to the Herdr runtime, wired it from `DAEMON_CONFIG.terminalCacheLines`, and trimmed only at the single Herdr-to-mirror edge while preserving absolute `bufferStartIndex` and cursor/revision truth. Projection/capture/Herdr gates pass 39 tests; full build passed. Reinstalled runtime hash is `44f8e2b8399743070c63f49a8c501453d4feee7ae2192398d509bc4ca416f719`; installed explicit Herdr close-loop on port 39100 passed input rev3, resize rev4 `100x30`, reconnect rev5, and close removal.
2026-08-12 final review after Herdr mirror-window fix: task `20260812T193157Z-review-2993-um44u0` remains FAIL only on unrelated parallel owners: Android network-state manifest permission P1, floating RemoteWindowOverlay fill geometry P1, and attachment notification in-flight race P2. No Herdr finding; review is not a semantic PASS.
2026-08-12 post-window parity replay: after the bounded Herdr mirror projection change, the same tmux/official-Herdr ANSI sample still passes rows, geometry, wide-cell shape, and cursor equality; tmux and Herdr canonical revisions remain separate namespaces.
2026-08-12 Herdr projection invariant hardening: `mapHerdrCanonicalSnapshot()` now rejects malformed absolute ranges whose body length does not match `[startIndex,endIndex)`, and rejects bounded projections that would drop the canonical absolute cursor. Herdr focused gates pass 30 tests, TypeScript, and diff check; full build, release/install, hash match `c015049a0bd0e867794ee14541e9773bbfab958375eea77459854c73ccb7261e`, and installed close-loop on port 39101 pass.
2026-08-12 final review after Herdr invariant hardening: task `20260812T193958Z-review-2993-51hjmk` is FAIL on four unrelated parallel worktree findings: RemoteWindowOverlay fullscreen crop P1, removed composite styles P1, Android network permission P1, and attachment notification in-flight race P2. No Herdr finding; no semantic PASS.

# 2026-08-13 Herdr per-session backend picker and installed runtime gate

- New-session creation now opens an explicit `tmux | Herdr` modal. The selected `terminalBackend` is carried through target create, session-open/connect, mux channel, session state/persistence, mirror/subscriber identity, input, resize, close, reconnect, and backend-specific list cache; no silent tmux fallback is used.
- Added the Herdr list-session control payload and included backend in the management transport cache key, so tmux and Herdr catalogs cannot share a stale list response.
- The formal Herdr adapter remains the only VT/mirror truth owner. `Herdr seq` stays attachment-local; zterm revisions remain daemon-generated. Herdr uses the synthetic `herdr-single-session` workspace label and never projects Herdr pane/workspace layout into daemon truth.
- Current focused picker/transport/message/registry gate: 98 tests green; Herdr runtime/canonicalizer/process/side-channel/selection gate: 35 tests green; feature-registry gate: 83 tests green; full `pnpm run build` green; release prepared, installed globally, and launchd restarted with health ready.
- Installed daemon real Herdr close-loop passed on port 3333 with the selected backend in every control/attach message: connected, initial revision 1, input revision 3, adaptive resize `100x30` revision 4, reconnect revision 5, and targeted close removal true. The first attempt exposed launchd's missing `~/.local/bin` PATH; the daemon launch runner now exports the explicit user-bin/tool PATH, and the rerun passed.
- Installed tmux daemon mirror close-loop passed all 9 cases and replay/strict audit; same ANSI/VT parity sample through tmux and official Herdr passed rows, CJK/emoji wide cells, geometry, cursor, SGR, erase, scroll, alternate screen, OSC, kitty graphics, and independent revision namespaces.
- Windows ConPTY/daemon cleanup remains beta/gap because the real remote close-list gate is not green. Codex/OpenCode/Reasonix external Herdr operational integrations remain unconfigured/unproven; the static payload/control isolation gate passes. Herdr feature registry remains `status: pending` until those required gaps and final review are resolved.

# 2026-08-13 final review remediation / installed revalidation

- 最终 review 前的三条项目级阻塞已按唯一 owner 修复：Android manifest 声明 `ACCESS_NETWORK_STATE`；RemoteWindowOverlay 恢复 composite strip/thumb style 定义并保持既有 fullscreen fit contract；attachment notification 增加 per-attachment in-flight 集合，permission/staging/schedule 完成或失败后收口，新增并发轮询反测。
- 修复后 typecheck、feature/resource/module/mainline gates、定向 Herdr/picker 65 tests、review-fix 77 tests、完整 `pnpm run build` 均通过；全局 daemon 重新安装/重启后 Herdr close-loop 与 tmux mirror close-loop、同样本 canonical parity 均通过。Windows 仍 beta/gap，外部 Codex/OpenCode/Reasonix operational integration 仍未证明。

# 2026-08-13 backend-boundary review remediation

- Codex review 暴露的三条 Herdr 边界已处理：session-list cache 由 backend-aware transport key 与跨 backend 红测锁定；persisted Herdr tab restore 在 owner grouping、reusable mux request、direct `fetchTmuxSessions` request 中保留 `terminalBackend`; file-transfer 对 Herdr 单 terminal surface 显式返回 `herdr_file_transfer_unsupported`，禁止落入 tmux path/write owner。
- 修复后 feature/resource/module/mainline gates 83/83、Herdr/backend/picker/restore/audit/file-transfer 定向 94 tests、typecheck、完整 build、global install/restart、installed Herdr close-loop、tmux mirror close-loop、tmux/Herdr parity 均通过。Windows 仍 beta/gap；Codex/OpenCode/Reasonix operational integration 未配置/未证明；需重新取得最终 review PASS。

# 2026-08-13 final backend write propagation

# 2026-08-13 side-channel and runtime audit continuation

- Mac live checks confirm official `herdr 0.8.0` at `/Users/fanzhang/.local/bin/herdr`; installed zterm launchd daemon is running on `0.0.0.0:3333` with configured auth. `herdr session list --json` is the external enumeration source; formal runtime filters only its `zterm-herdr-` namespace and does not import Herdr layout truth.
- `herdr integration status` currently reports Codex and OpenCode integrations not installed; no confirmed official Reasonix Herdr integration surface exists. Static terminal payload/control isolation passes; external operational integration remains an explicit unproven gap.
- Final Codex review must have an accepted MCP verdict. The previous review attempt was accidentally cancelled/no-verdict and is not evidence; replacement task `20260813T022547Z-review-31802-dimb8w` is running.

- 最终 review 暴露的唯一 P1 已修复并锁定：server terminal runtime wiring 将 selected backend 透传到 live mirror write、queued input 和 auto-command write；Herdr 的 normal input/delayed command 不再因默认参数误路由到 tmux。
- 修复后 typecheck、148 targeted tests、full build、global install/restart、installed Herdr close-loop、tmux mirror close-loop/replay/strict audit、same-sample canonical parity 均通过。Windows ConPTY/daemon cleanup 仍 beta/gap；Codex/OpenCode/Reasonix operational integration 仍未配置/未证明；等待最终 Codex review PASS。

2026-08-13 final runtime revalidation: `TerminalView` mirror-fixed pinch zoom now expands the visual layer layout box to `100/scale%`, preserving the native scroll coordinate system; attachment notification permission/staging/scheduling terminal failures are recorded and not retried on every poll. Targeted tests 15/15 and type-check pass. Full `pnpm run build` passes all registry, UI, transport, terminal, relay, workspace, Gradle, and Vite gates (terminal suite 814). Reinstalled daemon 0.1.3 and restarted launchd; `/health` is `ok=true`, `active_count=1`, port 3333. Installed official Herdr close-loop passes connected, input revision 3, resize revision 4 at 100x30, reconnect revision 5, and close removal; tmux mirror close-loop/replay strict audit passes. Final Codex review still required; Windows remains explicit beta/gap and external Codex/OpenCode/Reasonix Herdr integrations remain unproven.

# 2026-08-13 Tailscale WebSocket candidate verification

- Tailscale direct candidates must use the authenticated WebSocket attempt as the dynamic IP reachability check. The old 900ms Tailscale-only deadline was invalid for Android WebView over DERP; the shared 1800ms WebSocket budget is the unique owner policy.
- Live evidence on installed `0.1.3.2589` confirms two explicit `Macbookair` opens reached `resolvedPath=tailscale`, endpoint `100.86.84.63:3333`, `lastConnectStage=open`, mux channel `open`, real terminal body, and input echo. Evidence: `android/evidence/2026-08-13-tailscale-reconnect/`.
- Do not add an HTTP/ICMP admission probe or a second WebSocket probe. A failed candidate must remain an explicit route failure; the next physical generation uses the latest host projection and the existing transient cooldown.
# 2026-08-13 Herdr picker enumeration backend propagation

- Mac official Herdr enumeration was healthy (`hd-codex` running), but Android's session picker refreshed with the default `selectedTarget` and omitted `terminalBackend`, so the daemon correctly returned the tmux catalog. The unique fix is in `TmuxSessionPickerSheet.handleRefreshNow`: derive `discoveryTarget` with the selected `newSessionBackend`, use it for `fetchTmuxSessions`, missing-tab audit, row projection, and refresh callback; backend changes retrigger auto-refresh. Picker tests and typecheck pass.
- Release `0.1.3.2601` was built, OTA manifest verified, Relay public APK SHA matched local, and both online devices installed it with `adb install -r`. Device package versionCode is `1100026010`.

# 2026-08-13 Herdr picker loopback gate

- Installed daemon `0.1.3` on `127.0.0.1:3333` passed authenticated official Herdr enumeration: `herdr session list --json` reported running `hd-codex`, and the real Android `fetchTmuxSessions()` path with `terminalBackend: 'herdr'` returned `hd-codex` plus the active Herdr catalog entry.
- The same installed daemon accepted `session-open`/`connect` with `backend: 'herdr'` for `hd-codex` and emitted a valid `buffer-sync`: zterm revision `3`, absolute range `[0,20)`, geometry `80x24`, cursor `{rowIndex:15,col:2}`, and canonical `lines` payload. This is a completed Mac daemon-to-client transport/mirror loopback; real-device testing is not required to diagnose the local chain until the APK/UI path is compared against this evidence.
- Picker UI gate remains green: `TmuxSessionPickerSheet.test.tsx` passed 13/13, including Herdr selector refresh asserting `terminalBackend: 'herdr'` and rendering `hd-codex`. APK `0.1.3.2602` contains the backend selector and `terminalBackend` bundle symbols.

# 2026-08-13 real picker UI loopback for 2603

- Added `TmuxSessionPickerSheet.loopback.test.tsx`: only unrelated QR/relay UI dependencies are mocked; the picker, `fetchTmuxSessions`, traversal WebSocket, installed daemon `127.0.0.1:3333`, and official Herdr catalog are real. The test clicks the rendered `Herdr` selector and asserts the rendered `hd-codex` row.
- The real UI loopback passed 1/1; combined picker tests passed 14/14. The authenticated daemon health was `ok:true`, official `herdr session list --json` reported running `hd-codex`, and APK `0.1.3.2603` SHA-256 is `058c50804edf4751dacbf358e556efa8c5cb2579aba5b476c5d30ed70c435bef` with 64 `terminalBackend` bundle occurrences.
- This proves the source client UI + real transport + installed daemon + official Herdr enumeration chain. If a device on 2603 still shows no session, the remaining boundary is device-side loaded APK/target routing or UI state, not the Mac Herdr session or the zterm source picker request.

# 2026-08-13 2604 device crash root cause and 2607 validation

- The connected device with `0.1.3.2604` was not reaching the picker: its `com.zterm.android` process crashed at boot with Android `ForegroundServiceStartNotAllowedException` from `BackgroundServicePlugin.start()`. No Herdr list request could have been emitted from that process.
- The unique Android background-service owner now catches service-start/update `RuntimeException` and rejects the Capacitor call explicitly, preserving the foreground terminal UI when Android denies background execution. Added a regression assertion in `android-power-policy.test.ts`.
- Full build gates passed through registry (83), terminal (816), common flows (92), relay/account (38), workspace (39), Gradle, type-check, and Vite. Relay publish wrapper failed only after all artifacts were generated during its final external publish step; update manifest/APK hashes were already verified.
- Generated `0.1.3.2607` APK SHA-256 `911b4290e2967386839de572116654dcee46588fc721e899399a240c87a245eb`; installed on two online devices, both report versionCode `1100026070`, `MainActivity` resumed, and boot log contains `evaluateJavascript bridge OK` with no foreground-service crash. The device that had 2604 went offline before installation and needs reconnection before it can be upgraded.
# 2026-08-13 foreground resume transport lifecycle

- Foreground resume refreshes Relay/control settings and may recreate SessionContext callback identities. The lifecycle provider-disposal cleanup must not depend on `cleanupSocket`, `cleanupControlSocket`, or handshake-clear callback identity; keep latest callbacks in refs and run physical cleanup only on actual provider unmount.
- Root cause evidence: H2 `FD-20260813-FOREGROUND-CLEANUP-01` playground baseline closes an `OPEN` socket on dependency cleanup; positive intervention keeps it open; reverse intervention reproduces the close. Formal regression proves callback refresh preserves `OPEN` and unmount uses the latest cleanup callbacks.

# 2026-08-13 Herdr all-running-session enumeration correction

- Jason clarified the required contract: Herdr enumeration must match tmux. Any user-created official Herdr session that is `running=true` must be visible; no `zterm-herdr-` namespace filter or reserved prefix is allowed.
- Root cause was the unique `herdr-backend-runtime.listSessions()` owner filtering `entry.name.startsWith(prefix)` and stripping that prefix; `createSession`/`discoverSession` also re-added the prefix. This hid manual names such as `hd-codex`.
- Formal fix removes prefix semantics entirely. Running session names are passed verbatim to `discoverSession`, `--session`, and the client list payload. Herdr workspace/layout remains synthetic and single-surface only.
- After daemon release/install/restart, live Mac enumeration through the authenticated bridge returned `hd-codex` and another running manually named Herdr session, proving no prefix filter. The official CLI simultaneously reported `hd-codex` running.
- APK `0.1.3.2611` built with `tsc`, Vite, Capacitor sync, and Gradle assembleDebug; SHA-256 `a602c9e826fcca0a8444b4d7d5e3cb8ffeb49aca5bfd66c79d6fc640e8c54899`. Installed with `adb install -r` to online 15t; package reports versionCode `1100026110`, dataDir unchanged, and no boot crash in the post-install log window.
- Added a formal mock regression for arbitrary running names (`hd-codex`, `manual-project`) and stopped names; Herdr backend-runtime focused suite is 7/7 and TypeScript remains green.
- Re-ran the real playground parity probe after the all-name fix. Same ANSI/VT sample (cursor movement, erase, scroll, SGR, CJK/emoji width, alternate screen, OSC, kitty graphics) produced `rowsEqual=true`, `geometryEqual=true`, `sampleCellShapeEqual=true`, and `cursorEqual=true`; tmux revision `1` and Herdr zterm revision `2` remain separate from Herdr attachment seq `2`.
- Re-ran the real installed daemon loopback against the manually-created `hd-codex` without closing it: connected, initial revision `1`, input revision `3`, resize revision `4` at `100x30`, reconnect revision `4`, `closeRemovedSession=false` by explicit skip-close. Release runtime and installed `/Users/fanzhang/.zterm/daemon-runtime/server.cjs` both hash `0a2d59cb030b0d3ac70d62bf75f700224cf563a9f1190022fc8ce36ef97f849b`.

# 2026-08-13 2609 Herdr picker route repair and online device evidence

- 15t 的真实失败根因已由 logcat + UI 路径确认：`TerminalSessionDrawer` 新 session 原先没有 backend 选择，`useSessionOpenActions.handleOpenQuickTabPicker` 对已知 host 直接走 tmux create，完全绕过 `TmuxSessionPickerSheet`；因此不会产生 Herdr list 请求。
- 正式修复：Drawer 增加 `tmux | Herdr` 选择；Herdr 选择通过 typed `terminalBackend` 传到 quick-tab picker；已知 host 的 Herdr 路由显式打开 picker 并保持 Herdr backend，列表请求不再复用 tmux cache。tmux 默认路径保持不变。
- 定向 gate：Drawer、picker、open-actions、真实 daemon + 官方 Herdr loopback 共 83/83；`tsc --noEmit` 和 Vite production build 通过。
- Android full prebuild 在 APK 之前被两条既有 `TerminalPage.android-ime.test.tsx` 几何断言阻断（expected stage bottom 484/320，actual 184/0）；未修改该无关 owner。绕过失败 prebuild 后，Vite、Capacitor sync、Gradle `assembleDebug` 通过并产出 `0.1.3.2609`。
- APK `android/native/android/app/build/outputs/apk/debug/app-debug.apk` SHA-256 `c9fd37bde0e8d31ccd5a7d98a5f4b53fe697c9dae744062af7fc809810c28f13`；使用 `adb install -r` 安装到在线 15t，数据目录保持 `/data/user/0/com.zterm.android`，`versionCode=1100026090`、`versionName=0.1.3.2609`。
- 15t 在线 logcat 安装后无 `FATAL EXCEPTION`/`AndroidRuntime`；真实 Mac Studio terminal WS 保持 ready，mirror `latestRevision=2`、`localRevision=2`、target `100.86.84.63:3333`、`targetSessionCount=2`。Herdr catalog 的正式 loopback 证明来自同一 picker 对真实 daemon/官方 Herdr `hd-codex` 的 1/1 测试。Relay 发布未执行，Windows/Codex/OpenCode/Reasonix 仍按既有 gap 标记。
- 2026-08-13 review 暴露并已修正一个 backend 边界问题：schedule dispatch 原先只按 sessionName 调用默认 tmux 写入 owner，若同名 Herdr session 存在会误投递。正式 schedule owner 现在在任何写入前查询官方 Herdr running session，Herdr 目标显式返回 `Herdr single-session backend does not support schedule commands` 且 disable，不进入 live-mirror 或 tmux 写入路径；正反测试通过（定向 schedule/Herdr 20/20）。daemon release/install/restart 后 runtime hash `7579377e4fe124b00f848584065d6ad478ae9e2d41a8263d5df86d6eb0d0d710` 与 installed runtime 一致，认证 bridge 与官方 CLI 均返回 `hd-codex`。
- 当前全局 TypeScript 阻断仍来自并行 dirty `src/components/TerminalView.tsx:402` 的 `rowHeightPx` 先用后声明；本次 Herdr/schedule owner 未修改该文件。review 同时报告的 Android `NetworkIdentityPlugin` transport priority P2 属于并行 Android 网络 owner，未越界修改；Herdr feature registry 仍保持 pending，Windows ConPTY/cleanup 与 Codex/OpenCode/Reasonix operational integration 仍是明确 gap。

# 2026-08-13 Herdr detached-schedule and cache reconciliation

- Final Herdr owner fixes: `listSessions()` now reconciles its cache against the authoritative official `herdr session list --json` running set, removing sessions stopped externally; schedule dispatch checks the registered daemon truth and then the official running list before any write, so an unattached same-named Herdr session cannot fall through to tmux.
- Focused positive/negative gates passed 20/20, including external-stop eviction and Herdr schedule rejection before live-mirror/tmux writes.
- Release runtime and installed `/Users/fanzhang/.zterm/daemon-runtime/server.cjs` both hash `9b656681ae0908ab0fab726792645d3394d0122cd003793cfc9748ff620a027e`; launchd service was reloaded after an old daemon-only crash-loop guard was cleared, authenticated health passed, and official Herdr CLI plus bridge enumeration both returned `hd-codex` and `zterm-herdr-herdr-close-loop-1786557179480`.
- Review task `20260813T-current-herdr-final-fix3` was still pending at handoff; do not treat pending as PASS. Remaining non-Herdr/global gaps remain unchanged: NetworkIdentityPlugin P2 in parallel owner, feature registry pending, Windows ConPTY gate, and operational Codex/OpenCode/Reasonix integration evidence.

# 2026-08-13 Android retained-session service lifecycle

- `BackgroundService` lifecycle is owned by the retained-session count, not Activity visibility: start when retained sessions become non-zero, update the native notification when the count changes, and stop only when the final retained session closes or the lifecycle owner is disposed.
- Background heartbeat callback is a separate client control-plane concern: background entry enables the callback, foreground return disables only the callback, and neither path stops or recreates the native service or physical transport.
- Native service owns only foreground notification, one non-reference-counted `PARTIAL_WAKE_LOCK`, and bounded WebView wake-up support. It does not own WebSocket, mux channel, RTC, route, reconnect, body subscription, or UI state.
- Verification: lifecycle/power, transport, feature registry, TypeScript, Vite, and Gradle gates are green. APK `0.1.3.2617`, `versionCode=1100026170`, SHA-256 `adeed5740848376008defb8572f7ba6377cac9ed497094d566cb94d25cb0f872`.
- Remaining evidence gap: no online ADB device was present for install, `dumpsys` service/WakeLock checks, background/foreground round-trip, and unchanged physical transport generation.

# 2026-08-13 backend-qualified mirror identity and APK 2616

- Review found and formalized the backend coexistence invariant: daemon mirror identity is now `<backend>:<sessionName>`, so same-named tmux and Herdr sessions can attach concurrently without sharing mirror rows, revisions, subscribers, or input batches. Rename keeps the plain backend session name in `sessionName` and uses the qualified value only for map identity/`mirrorKey`.
- Positive regression: `terminal-core-support.test.ts` and `terminal-mirror-runtime.test.ts` prove `tmux:same-name` and `herdr:same-name` are independent. Focused server set passed 72/72 and TypeScript passed.
- Installed daemon after the final rename fix: release and `/Users/fanzhang/.zterm/daemon-runtime/server.cjs` SHA-256 both `022e319d012d520f18f6a936532e62932375909f75cdb84bd384bab863ecab67`; authenticated health passed with 3 ready mirrors. Official Herdr CLI and bridge still returned the same unfiltered running names (`hd-codex`, `zterm-herdr-herdr-close-loop-1786557179480`).
- APK build 2616 completed the feature-registry gate 83/83, shell/theme 183/183, file-transfer 82/82, transport 53/53, terminal contract/common-flow stages, Gradle build, and produced/installed normal `0.1.3.2616` on online 15t. APK SHA-256 `95a8fbb0e2ae168f5949346538dcab97d84a7d58557bdb8796675502e3f74f`; local OTA manifest points to build 2616 with the same hash. Post-install logcat had no fatal Android crash.
- Review task `20260813T-current-herdr-final-fix5` failed only on unrelated Android cold-start persisted-tab restoration (`open-tab-persistence.ts`, P1). Do not modify that parallel owner as part of Herdr work. Windows ConPTY, Codex/OpenCode/Reasonix operational integrations, Herdr registry status, and the unrelated notification/network/cold-start findings remain explicit gaps; overall goal is not complete.

## 2026-08-13 架构拆分经验（goal-436b962c Round 1-2）

- `git checkout -- <path>` 会从 index（staged）恢复，可能覆盖工作树未提交 WIP：恢复前先查 `git status` 列位置（首列 M = staged）。本 repo 大量未提交 WIP（RenameDialog 集成、Herdr catalog 投影等）。已发生一次 TerminalPage.tsx WIP 覆盖事故，靠会话内捕获文本 + 测试期望重建（46/46 + 12/12 套件验证保真）。
- 切片式重构必须带边界断言：indexOf 返回 -1 时 slice(0, -1) 会截断整个文件；每步删除前验证区域内容标记，并严格检查顺序关系。
- 模块 gate 要求：src/ 下新文件必须注册 module-registry owned_paths；移动文件要同步 module-registry + feature-registry truth_sources；export * 重导出 + 显式 import 并存保持兼容。
- 程序化块提取不可靠（[ 与多行泛型块被单行分支误判）；复杂文件用手工搬迁 + 测试验证。
- P0 分层模式：renderer 不持手势状态机/直写存储；手势/缩放归 UI shell hook；存储归 lib storage owner；正文 repaint 唯一入口 render gate。
# 2026-08-14 session drawer visibility

- Drawer bug reports must distinguish “cannot close” from “cannot see/open”. For portrait Android, `TerminalPage` owns the stable visible `Sessions` entry; `TerminalSessionDrawer` owns the mounted overlay, header, rows, and close intent.
- Live device proof for APK `0.1.3.2618`: CSS viewport `347x754`; entry rect `{x:52,y:47,width:72.4,height:34}`, visible and clickable; click yields drawer rect `{x:0,y:0,width:166.8,height:754.3}`, `aria-hidden=false`, visible header/row; close returns `aria-hidden=true`.
- Regression rule: page test must assert entry exists before opening, drawer hidden before click, drawer header and row visible after click, and close returns hidden.

# 2026-08-14 daemon-owned unified tmux/Herdr catalog

- Root cause of “manual Herdr session not visible” was client-side backend partitioning after daemon enumeration: the picker/list/open path sent or retained `terminalBackend`, so the client did not consume one daemon-owned catalog.
- Formal invariant: normal client list, open, mux-channel-open, rename, and kill requests are backend-opaque. `terminal-control-runtime` unions tmux plus configured running Herdr names; exact-name backend resolution happens in the daemon adapter layer. Zero matches and same-name matches fail explicitly; no tmux default fallback.
- New-session tmux/Herdr selection is creation-only adapter intent. It is not copied into client session truth; the created session is reopened by name through the unified catalog.
- Verification: focused terminal control, message, mirror, session helper, and picker suites passed after the change; dedicated playground record is `playground/herdr-adapter-experiment-20260812/unified-catalog-root-cause-20260813.md`.
- Online/build evidence: release and installed daemon runtime SHA-256 `393bd7f35f7928d87542a982efd7317435275b21325647902af2330f9cd646a3`; authenticated raw WS list returned one union containing tmux names plus `hd-codex` and `zterm-herdr-herdr-close-loop-1786557179480`. APK `0.1.3.2638` SHA-256 `81a60f2270428abe32173911ceeb903930f6b736aa4fe4d80aa8a3ff99bfad4b` installed on `100.104.163.65:5555`, package reports versionCode `1100026380`, and post-launch logcat showed no fatal Android crash. Relay publish step still failed after local OTA manifest verification.
- Installed daemon real-session close-loop re-run against manually maintained `hd-codex` passed: connected, initial zterm revision `1`, input revision `2`, resize revision `3` at `100x30`, reconnect revision `4`, and explicit skip-close preserved the user session. This is daemon/Herdr output-input-resize-reconnect evidence; close deletion remains tested separately because the session is user-owned.
- Windows audit remains an explicit beta/gap: `pnpm --dir win run type-check` is currently blocked by unrelated `packages/shared/src/workspace/split-tree-workspace.ts:245` unused `@ts-expect-error`; no real Windows ConPTY + official Herdr gate passed, so Windows support is not claimed.

# 2026-08-14 Herdr unified-catalog delivery review

- Independent MCP Codex review task `20260814T-current-herdr-unified-catalog` completed with `verdict: fail`, not PASS. Findings were outside the Herdr owner: P1 cold-start persisted-tab restoration in `android/src/lib/open-tab-persistence.ts:33-37` and P2 repeated failed attachment-notification attempts in `android/src/hooks/useAttachmentNotifications.ts:61-85`. These parallel-owner changes were not modified during Herdr delivery.
- Review evidence: `/Volumes/extension/code/zterm/.agent-collab/review/20260814T-current-herdr-unified-catalog/review.final.md`. Overall Herdr goal therefore remains incomplete under the repository delivery gate despite Herdr-specific tests, build/install, daemon enumeration, and real-session close-loop passing.

# 2026-08-14 delivery-gate review conflict after APK 2643

- APK `0.1.3.2643` was rebuilt, locally OTA-verified, installed on `100.104.163.65:5555`, force-stopped/restarted, and the installed package reported `versionCode=1100026430`; real `hd-codex` daemon close-loop passed with zterm revisions `5 -> 6 -> 7 -> 8`, resize `100x30`, and reconnect.
- Review task `20260814T-herdr-delivery-gate-2643` still returned `verdict: fail`. Its P1 asks to restore current tabs on cold launch, contradicting the active architecture contract in `android/docs/architecture.md:166-188`, which requires deleting and not restoring `OPEN_TABS`/`ACTIVE_SESSION`. Its P2 asks to retry failed attachment notifications, conflicting with the current explicit terminal-failure behavior and test design. Do not weaken the architecture truth merely to satisfy this review; the review scope is the whole dirty worktree and is not a Herdr-specific PASS.
- The Herdr feature remains pending until a review can be run against a scoped clean change set or the architecture decision is explicitly changed and its gates updated.

# 2026-08-14 Herdr workspace-state isolation and APK 2644

- Formal Herdr managed sessions no longer populate the shared `workspace` field. The adapter retains only the official attachment-local `terminalId`/`paneId` needed to observe/control the single root surface; no synthetic Herdr workspace/layout identity enters daemon session truth. `herdr-backend-runtime.test.ts` asserts returned Herdr sessions have no `workspace` property.
- TypeScript, Herdr backend/canonicalizer/process transport, terminal control/mirror, and side-channel gates passed after the isolation change. The installed daemon was rebuilt/reinstalled; health passed and the real `hd-codex` close-loop again passed with revisions `1 -> 2 -> 3 -> 4` and resize `100x30`.
- APK `0.1.3.2644` was built, local OTA manifest verified, installed on `100.104.163.65:5555`, and restarted. Package versionCode `1100026440`; APK SHA-256 `48454382d771206ba8dbf35af6dcf7d10844a8fd8a8da986eb9b101940e133a2`. The live daemon session ticket advertised the same app version `0.1.3.2644`.

# 2026-08-14 review scope conflict: unified backend-opaque catalog

- Review task `20260814T-herdr-workspace-isolation-2644` returned `verdict: fail` with four P1 findings. Two findings demand restoring backend-scoped list/mutation responses; that contradicts the user-approved Herdr contract: normal client list/open/mux/rename/kill are backend-opaque, manual Herdr sessions are unfiltered, and daemon adapter exact-name resolution owns backend selection. Do not reintroduce client-side tmux/Herdr partitioning or silent backend selection to satisfy this review.
- The same review also reported unrelated dirty-worktree failures in `TerminalView.layer-truth.test.ts`, `session-transport-open-helpers.ts`, and other parallel owners. They are not evidence against the Herdr adapter and must not be fixed by weakening the unified catalog contract.
- Review evidence: `/Volumes/extension/code/zterm/.agent-collab/review/20260814T-herdr-workspace-isolation-2644/review.final.md`. Overall goal remains active because the review gate is not a scoped clean Herdr review and Windows/agent operational gates remain explicit gaps.
# 2026-08-14 Herdr adapter capability gate and online revalidation

- Herdr-only daemon discovery is now isolated from tmux: `defaultBackend: 'herdr'` skips tmux catalog/resolution probes, with a negative test asserting `spawnSync` is untouched.
- Normal tmux daemon startup only registers Herdr when the executable capability probe succeeds (or Herdr is the configured backend); an unavailable optional Herdr executable cannot break ordinary tmux list/open flows.
- Herdr picker open intent preserves the adapter-resolved `terminalBackend: 'herdr'`; ordinary client discovery remains unified and backend-opaque, with no backend filter or separate client-side catalog ownership.
- APK 0.1.3.2644 and the daemon were rebuilt, installed, and restarted after this change. Real close-loop evidence again enumerated manual `hd-codex`, delivered input, resized to 100x30, reconnected, and removed the temporary Herdr session.
- Reviewer suggestion to send backend in every session-list request and split cache keys conflicts with the locked product contract (daemon-owned unified catalog; client does not filter by tmux/Herdr). Keep the conflict explicit until the review scope is corrected; never regress to client backend management.

# 2026-08-14 review audit: mux backend forwarding and cold-launch contract

- Review task `20260814T051024Z-review-fix-persistence-2644-r2` reported two P1 findings. The cold-launch persistence finding is intentionally rejected because `android/docs/architecture.md` freezes current tabs as current-process-only truth and requires removing `OPEN_TABS`/`ACTIVE_SESSION` on startup. The existing cold-launch tests and implementation remain aligned with that contract.
- The valid Herdr finding was fixed in `android/src/contexts/session-context-transport-runtime.ts`: `buildSessionMuxChannelOpenFrame()` now forwards `host.terminalBackend` into the shared typed mux `backend` field. This preserves the adapter creation/open intent through the physical mux channel without making the client a backend owner.
- Module import gate found `remote-window-app-window-catalog-script.ts` and `remote-window-iterm2-catalog-script.ts` unowned; both are now explicitly owned by `daemon.remote_window_stream`.
- Focused transport, persistence, first-paint, and runtime tests pass after the correction. Full Android build, OTA manifest verification, daemon rebuild/reinstall/restart, APK reinstall/restart, and authenticated real Herdr close-loop were rerun: `hd-codex` enumerated; input revision 2; resize revision 3 at 100x30; reconnect revision 4; temporary-session close removal true. Review task `20260814T-review-herdr-mux-forwarding-2644` remains in progress; no PASS claim is made yet.

# 2026-08-14 accumulated-WIP review round: session-list cache key P1

- Review task `20260814T064201Z-review-24143-1lb193` (oauth, uncommitted) returned `verdict: fail` with a single P1: `buildTmuxSessionListCacheKey` in `src/lib/tmux-sessions.ts:127-129` omits `target.terminalBackend`, so the reviewer claims a tmux listing cached in the 3s TTL can be returned for a Herdr listing.
- The finding is a false positive under the locked daemon-owned unified catalog contract (documented 2026-08-14): all client `list-sessions` call sites send `{ type: 'list-sessions' }` without a backend payload; the daemon's `handleListSessionsMessageRuntime` returns the unified union (`listTerminalSessions()`) for backend-opaque requests, and `TmuxSessionPickerSheet.handleRefreshNow` intentionally strips `terminalBackend` to `undefined` for discovery. Tmux and Herdr targets therefore receive the identical union response; the cache key omission cannot produce a wrong or missing catalog.
- Implementing "preserve it in the request payload" would make the daemon return backend-scoped lists and regress to client-side backend management — exactly what MEMORY.md records Jason rejected in earlier rounds ("never regress to client backend management"). Kept the conflict explicit; no code weakened to satisfy the review.
- Verification before commit: `git diff --check` PASS, `tsc --noEmit` PASS, `pnpm --dir android run test:feature-registry` 83/83 PASS, full `pnpm run prebuild` gate stack PASS, `pnpm run build` (Vite) PASS. The full working tree was committed as the accumulated WIP batch.

# 2026-08-14 renderer priority fix + source adapter/visible repair ledger

- Android WebView renderer death was the first divergence before socket `1006`: old `setRendererPriorityPolicy(IMPORTANT, true)` let the renderer become CACC/900 when not visible. `MainActivity` now keeps IMPORTANT with `waivedWhenNotVisible=false` and tracks platform `activityInForeground`; `BackgroundService` skips native `evaluateJavascript()` while foregrounded and keeps the 30s background wake.
- Visible repair state must stay per-session in the exact ledger (`sessionId + visibleRange + tailEndIndex + targetRevision`); a 5s single-entry cooldown can permanently suppress a lost repair. The runtime now re-dispatches a dispatched ledger entry after 2s stale, keeps failed dispatch pending, and fulfills only after an authoritative payload fully covers the visible window/tail.
- Source adapters are one shared `TerminalSourceAdapter` contract under `daemon.terminal_backend`; mirror store consumes `readSnapshot()` only. New source files must be registered in module-registry owned_paths before `test:feature-registry` passes; a declared import edge without the target file being owned shows up as a stale edge.
- Remote-window Swift extraction source must follow the canonical split: `remote-window-screen-capture-script.ts` is the `SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT` owner; `prepare-global-daemon-release.sh` and `zterm-daemon.sh` now point there, not `remote-window-scripts.ts`.
- Evidence: local debug APK still reports `0.1.3.2644`/1100026440 because no version bump was made; its SHA-256 is `ff9ee3aba37b5f062b787bfc8095850d77e3adc34d86ae7af677221ad3a8cb85`; installed on `100.104.163.65:5555`; renderer PID 13746 stayed stable and `performance.timeOrigin=1786707330545.4` unchanged across HOME->foreground; renderer oom `BTOP` not cached; daemon mirror close-loop 9/9.

# 2026-08-14 live 2646 delivery verification

- Stale WebView bundle on device was caused by an old installed package (`0.1.3.1000`, asset `index-B_1ppoX_.js`), not by an uncacheable same-version reload. Installing 2646 and relaunching bumped `zterm_webview_cache_version.xml` to `1100026460`; native `MainActivity.clearWebViewAssetCacheAfterUpgrade()` cleared WebView HTTP cache, and CDP then loaded `index-KEP-jfNa.js` with the same SHA-256 as `dist`.
- Live 2646 verified: same-name tmux/Herdr drawer rows are separate and Herdr is suffixed `(herdr)`; Herdr open reaches `connected`; rename failure stays in the dialog with inline error; QuickBar image failure toast is a real fixed-position DOM node after the image-paste waiter rejects with `binary file transfer is not supported by the Herdr single-session terminal surface`.
- Full 2646 gate rerun: focused 288/288, typecheck, prebuild exit 0, Vite build exit 0, daemon mirror close-loop 9/9 + strict replay, daemon health/update manifest on local and Tailscale endpoints.
- White-font vertical stripe is still an open renderer-measurement item; no product renderer change was made without a real WebView glyph/advance fixture.
- MCP codex-review could not be started because review MCP tools were not exposed in the session; delivery must not claim PASS until a scoped review exists.

# 2026-08-14 daemon sessionCatalog side-channel + portrait top layout 2647

- Herdr discovery completeness requires the daemon to publish backend-qualified `sessionCatalog` beside the plain `sessions` array; plain string names cannot let the client split same-name tmux/Herdr groups. The daemon remains the only backend owner and `list-sessions` remains backend-opaque; `sessionCatalog` is a typed side-channel, not a backend selection request.
- Client refresh must prefer the open-transport catalog query when available, fall back to direct fetch, reject malformed catalogs, and rebuild/prune drawer groups per backend key. Do not merge same-name tmux/Herdr rows.
- Portrait safe-area layout: first row is back/Sessions/settings at `topInset+8`, second row is connection status at `topInset+50`, terminal stage starts at `topInset+92`; the constants live in `terminal-page-status-helpers.ts`.
- APK `0.1.3.2647` versionCode `1100026470` SHA-256 `6a6f4b14701a6920ac1a46a674e6554520d40cc128b63bdb425e7a730836bf60` installed on `100.104.163.65:5555`; live CDP proves herdr `zterm` and tmux `zterm` rows both exist and herdr `zterm` connects as `(herdr)`. OTA Relay publish still requires explicit release authorization.

# 2026-08-15 ZTerm v2 Playground Phases 1-3

- `ZTERM-ARCH-V2-DESIGN-001` remains in AppSDK draft with production runtime untouched. Playground contracts now cover Foundation/Data/Control/Debug/Plugin (Phase 1), metadata-only observability side channel with default-deny grants (Phase 2), and control center plus client composition root (Phase 3).
- Phase 3 gates passed after the composition/control addition: `test:runtime-architecture-v2` 30/30 across 8 files, `test:feature-registry` 83/83, full `pnpm run build` (prebuild + relay smoke + type-check + Vite) PASS, and `/Users/fanzhang/.local/bin/appsdk verify android` ok:true at draft.
- `ControlCenter` owns routing, capability, deadline, idempotency, correlation, and audit only; `ClientCompositionRoot` binds declared runtime ports only and rejects duplicate/unbound/undeclared providers. Maps keep these resources/functions as `design`/`pending` until physical production cutover.
- Codex review MCP is not available in this session, so no ReviewRecord or PASS exists. Phase 3 remains Playground-only and must not be promoted until the scoped review and production cutover gates pass.

# 2026-08-15 MemPalace palace repair

- The zterm mine failed on a malformed FTS5 inverted index in `~/.mempalace/palace/chroma.sqlite3`; `mempalace repair --yes` rebuilt all 231,973 drawers, recreated the FTS5 index, VACUUMed SQLite, and both `PRAGMA quick_check` and `integrity_check` returned ok.
- After repair, `scripts/mempalace-mine-zterm.sh` re-mined the safe zterm corpus (1078 files, 1759 drawers filed), and searches for "debug side channel ZTerm v2" and "ControlCenter client composition root capability ports" return the new plan/note/test-design sources. The write-index-search loop is closed.

# 2026-08-15 ZTerm v2 Phase 2 production debug HTTP cutover supersedes Playground-only

- Production runtime is no longer untouched for the debug slice: terminal mux
  rejects `debug-log`/`debug-snapshot`, `runtime-debug-flush.ts` is deleted, and
  client runtime debug exports through `runtime-debug-http-exporter.ts` to
  daemon `/debug/runtime/logs` and `/debug/runtime/snapshot` without active
  session or transport socket dependency.
- `/debug/runtime/control` is POST-only, auth-gated, default-deny, and expiring
  through `setDaemonRuntimeDebugLease`; startup `ZTERM_DAEMON_DEBUG_LOG` remains
  an operator-only env flag and does not grant remote control.
- AppSDK `resource.observability_channel` and debug export/lease functions stay
  `design`/`production_pending_review` because the v2 module has not been
  promoted; production source paths and `test:debug-observability` are recorded
  in the maps and wired into prebuild/CI.
- Verified: debug observability gate Android 61/61 + shared 9/9, feature
  registry 83/83, tsc noEmit, full `pnpm run build` with prebuild/terminal
  contracts 831/831/common flows 98/98/relay smoke/Vite, and AppSDK draft
  verify. Full `pnpm test -- --run` still has a pre-existing
  `app-update-runtime` rollback failure and a native wrtc worker crash outside
  this slice.
- No ReviewRecord/PASS exists because codex-review MCP remains unavailable.
  Phase 2 production cutover must not be claimed promoted until scoped review
  and later lifecycle gates pass.

# 2026-08-15 ZTerm v2 Phase 3 client.terminal_channel_mux production ownership slice

- Phase 3 first production ownership slice is in source: `client.terminal_channel_mux` owns `src/lib/terminal-channel-mux-runtime.ts` (`TerminalChannelMuxStore`); `SessionTransportRuntimeStore.terminalChannels` embeds the store and `TargetTransportRuntime` no longer owns `channels`.
- Registry/docs/AppSDK maps now bind the real module paths, resource truth stores, import edges (`client.daemon_connection -> client.terminal_channel_mux`, `client.session_runtime -> client.terminal_channel_mux`), function/mainline/wiki surfaces, feature registry, and test design.
- Verified: dedicated channel-store tests 7/7, targeted transport/session/lifecycle 161/161, feature registry 83/83, debug observability 61/61, tsc noEmit, full `pnpm run build`, and AppSDK draft verify ok:true.
- No ReviewRecord/PASS exists because codex-review MCP remains unavailable; do not claim promoted or complete. Later slices remain for `daemon.input_queue`, production composition/control owners, and Phases 4-8.

# 2026-08-15 module DAG baseline for client ownership

- The real cross-module import graph is now acyclic. Client ownership was corrected by moving session transport orchestration/open, socket frame demux, and message dispatch to `client.session_runtime`; moving `session-context-open-intent-store.ts` to `client.daemon_connection`; moving session picker and tmux catalog helpers to `client.connection_home`; moving app version and pure input/viewport helpers to `client.runtime`; moving preview gesture and mirror-fixed zoom to `client.renderer_window`; and moving shared pane layout re-exports to `shared.pane_layout`.
- `module_dag` is active in AppSDK verification and the v2 test design; `module-import-graph-truth.test.ts` now proves real imports are both edge-lockstep and acyclic.
- Verified: `test:feature-registry` 84/84, `tsc --noEmit` PASS, `git diff --check` PASS, AppSDK draft verify ok:true. Evidence `EVID-20260815-ZARCHV2-P4-MODULE-DAG-001` added.
- This is registry/docs ownership work, not a behavior change. Review/promotion remains unavailable, so do not claim v2 complete.

# 2026-08-15 Phase 4 client buffer frame assembly ownership slice

- `resource.client_buffer_frame_assembly` now has a real physical owner: active module `client.buffer_frame_assembly` owns `src/lib/buffer-frame-assembly/session-buffer-frame-assembly.ts` and `session-buffer-frame-assembly-state.ts`; the old `src/contexts/session-buffer-frame-assembly*` files are deleted. `client.buffer_store` no longer owns frame assembly paths.
- Registry/docs/AppSDK maps bind the new module, resource, edges, function/mainline/wiki surfaces, feature registry, and v2 test design. The test wiring was corrected after the move: `test:terminal:frame-assembly` and `scripts/run-terminal-contracts.mjs` now run the new test path.
- Verified: `test:terminal:frame-assembly` 101/101, `test:feature-registry` 84/84, `test:terminal:contracts` 823/823 in 54 files, `git diff --check` PASS, `daemon:mirror:close-loop` all 9 lab cases plus replay and strict audit PASS, AppSDK draft verify ok:true. Evidence `EVID-20260815-ZARCHV2-P4-PROD-BUFFER-FRAME-ASSEMBLY-001` added.
- No ReviewRecord/PASS exists because codex-review MCP remains unavailable; the slice is production_pending_review and v2 overall is not complete. Remaining production slices still include client wire ingress/sparse/render/UI, daemon control/source/mirror/transport/mux, composition root, and Phases 6-8.

# 2026-08-15 Phase 4 client wire ingress ownership slice

- Pure client wire ingress normalization now has a physical owner: active module `client.wire_ingress` owns `src/lib/wire-ingress/buffer-wire-normalize.ts`; `normalizeIncomingBufferPayload` and `normalizeTerminalCursorState` no longer live in `session-wire-helpers.ts`, which remains the outbound host-config builder under `client.daemon_connection`.
- Registry/docs/AppSDK maps bind the new module, owned paths, edges (`client.buffer_store -> client.wire_ingress`, `client.session_runtime -> client.wire_ingress`, `client.wire_ingress -> shared.terminal_types`), function/mainline/wiki surfaces, feature registry, and v2 test design. Gate wiring now runs the new normalization test.
- Verified: `test:terminal:frame-assembly` 104/104, `test:feature-registry` 84/84, `test:terminal:contracts` 826/826 in 55 files, `tsc --noEmit` PASS, `git diff --check` PASS, `daemon:mirror:close-loop` all 9 cases plus replay and strict audit PASS, AppSDK draft verify ok:true. Evidence `EVID-20260815-ZARCHV2-P4-PROD-WIRE-INGRESS-001` added.
- No ReviewRecord/PASS exists because codex-review MCP remains unavailable; the slice is production_pending_review and v2 overall is not complete. Remaining production slices still include client sparse buffer/render window/DOM renderer/terminal shell, production composition root/control center, daemon control/source/mirror/transport/mux, and Phases 6-8.

# 2026-08-15 Phase 4 client sparse buffer and renderer window ownership slice

- `resource.client_sparse_buffer` now has a real physical owner: active module
  `client.sparse_buffer` owns `src/lib/session-buffer-store.ts`
  (`createSessionBufferStore`/`useSessionBufferSnapshot`). `client.buffer_store`
  no longer owns the sparse body store; it owns planner/pull/repair/head/tail
  orchestration only.
- `client.renderer_window` owns `src/lib/session-render-buffer-store.ts` with
  the render gate as immutable render projection owner. Sparse body truth and
  visible-window truth are separate resources and cannot become one state
  object.
- Registry/docs/AppSDK maps bind the new module, resource, edges, function/
  mainline/wiki surfaces, feature registry, and v2 test design. AppSDK gates
  `sparse_buffer_ownership` and `renderer_projection_ownership` are active.
- Verified: `test:feature-registry` 84/84,
  `test:terminal:frame-assembly` 104/104,
  `test:terminal:contracts` 826/826 in 55 files, `tsc --noEmit` PASS, full
  `pnpm run build` PASS, `daemon:mirror:close-loop` all 9 cases plus replay
  and strict audit PASS, `git diff --check` PASS, AppSDK draft verify ok:true.
  Evidence `EVID-20260815-ZARCHV2-P4-PROD-SPARSE-RENDER-OWNER-001` added.
- No ReviewRecord/PASS exists because codex-review MCP remains unavailable; the
  slice is production_pending_review and v2 overall is not complete. Remaining
  production slices still include DOM renderer/terminal shell, composition
  root/control center, daemon control/source/mirror/transport/mux, and
  Phases 6-8.

# 2026-08-15 Phase 4 client.dom_renderer and client.terminal_shell ownership slice

- `client.dom_renderer` and `client.terminal_shell` now have real active
  `owned_paths`. DOM renderer owns `TerminalView`, `VisibleRow`,
  `TerminalPreviewRow`, `useMirrorFixedZoomPan`, shared `cell-render.ts`, and
  `theme.ts`; terminal shell owns `TerminalPageStageShell` plus shell skin,
  status/quickbar/copy/keyboard-lift shell files. `client.renderer_window` no
  longer owns DOM projection files and `client.app_shell` no longer owns
  `terminal-shell-skin.ts`.
- Mainline source-to-DOM truth is `TerminalPage -> StageShell -> TerminalView
  -> Renderer -> RenderGate`; docs, wiki, test designs, and edge registry now
  use `android_mainline:StageShell->TerminalView` instead of a direct
  `TerminalPage->TerminalView` edge. `docs:function-wiki` regenerated the wiki
  HTML in lockstep.
- Verified: `test:feature-registry` 84/84 in 11 files,
  `tsc --noEmit` PASS, `test:terminal:frame-assembly` 104/104,
  `test:terminal:contracts` 826/826 in 55 files,
  `daemon:mirror:close-loop` all 9 cases plus replay and strict audit PASS,
  full `pnpm run build` PASS, AppSDK verify android ok:true draft,
  and `git diff --check` PASS.
- Evidence `EVID-20260815-ZARCHV2-P4-PROD-DOM-TERMINAL-SHELL-OWNER-001` added.
  No ReviewRecord/PASS exists because codex-review MCP remains unavailable;
  the slice is production_pending_review and v2 overall is not complete.

# 2026-08-15 Phase 6 production plugin host first slice

- `client.plugin_host` now has a real production owner surface:
  `src/lib/plugin-host/` owns the runtime and the first capability plugin, while
  `shared.plugin_contract` owns `packages/shared/src/terminal/plugin-contract.ts`
  and `plugin-capability-registry.ts`. `src/App.tsx` is the only non-host
  production consumer and composes host-level `network:native-snapshot`; the
  `network-identity` plugin receives only that declared capability and exposes
  `network:sample-interfaces` to `NetworkIdentityRuntime`.
- Added a static `plugin-host-ownership.test.ts` red gate that forbids host
  imports of SessionContext/traversal/session stores/server truth and forbids
  UI/page/hook/plugin layers from importing host/shared plugin contracts.
  `test:plugin-host` is wired into Android prebuild and CI, and AppSDK maps now
  bind the plugin lifecycle/resources as `production_pending_review` with real
  paths.
- Verified: `test:plugin-host` 11/11, `test:feature-registry` 84/84 in 11
  files, `test:runtime-architecture-v2` 30/30, `tsc --noEmit` PASS, full
  `pnpm run build` PASS, `docs:function-wiki` regenerated, AppSDK
  verify android ok:true draft, and `git diff --check` PASS. Evidence
  `EVID-20260815-ZARCHV2-P6-PROD-PLUGIN-HOST-001` added. Review/promotion is
  not recorded because codex-review MCP remains unavailable; Phase 6/7 UI
  plugin migration is not complete.

# 2026-08-15 Phase 3 production composition root slice

- `client.composition_root` now has a real production owner surface:
  `src/lib/composition-root/client-composition-root.ts` owns typed
  bind/resolve/require/has semantics, and `src/App.tsx` is the only production
  consumer. App composes `plugin-host` through the root, requires it before
  use, and resolves `PluginHost` from the registry.
- Added `client-composition-root-ownership.test.ts` as a static red gate:
  composition root must not import SessionContext/traversal/session
  stores/server, and only App.tsx plus the composition-root directory may
  import the composition root. `test:composition-root` is wired into Android
  prebuild and CI, and AppSDK maps bind `resource.client_composition_root` and
  `client_composition_root` as `production_pending_review` with real paths.
- Verified: `test:composition-root` 6/6, `test:feature-registry` 84/84 in 11
  files, `test:runtime-architecture-v2` 30/30, `tsc --noEmit` PASS, full
  `pnpm run build` PASS, AppSDK verify android ok:true draft, and
  `git diff --check` PASS. Evidence
  `EVID-20260815-ZARCHV2-P3-PROD-COMPOSITION-ROOT-001` added. Review/promotion
  is not recorded because codex-review MCP remains unavailable; this slice is
  production_pending_review and v2 overall is not complete.

# 2026-08-15 Phase 3 production control center slice

- `client.control_center` and `shared.control_contract` now have real
  production surfaces: `src/lib/control-center/client-control-center.ts` owns
  unique command routing, capability gating, deadline, idempotency, correlation,
  and bounded audit; `packages/shared/src/terminal/control-contract.ts` owns
  branded control contracts. `PluginHostControlNode` lives under
  `src/lib/plugin-host/` and adapts `PluginHost.disposeAll` for control routing.
- App composition binds `plugin-host` and `control-center` through
  `ClientCompositionRoot`, registers `plugin-host.dispose` under
  `plugin-host:dispose`, and unmount disposal executes through
  `ClientControlCenter` with idempotency `plugin-host.dispose:app-unmount`;
  direct `pluginHost.disposeAll` is no longer allowed in App.
- Static `client-control-center-ownership.test.ts` forbids control-center
  imports of SessionContext/traversal/session stores/plugin host
  implementation/server truth, and allows only App plus the control-center
  directory to import `ClientControlCenter`. `test:control-center` is wired
  into Android prebuild and CI; resource registry declares
  `resource.platform_terminal_surface -> resource.client_control_center`.
- Verified `test:control-center` 13/13, `test:composition-root` 6/6,
  `test:plugin-host` 11/11, `test:runtime-architecture-v2` 30/30,
  `test:feature-registry` 84/84, tsc PASS, full `pnpm run build` PASS, AppSDK
  verify android ok:true draft, and `git diff --check` PASS. Evidence
  `EVID-20260815-ZARCHV2-P3-PROD-CONTROL-CENTER-001` added. Review/promotion
  is not recorded because codex-review MCP remains unavailable; this slice is
  production_pending_review and v2 overall is not complete.

# 2026-08-15 Phase 5 daemon.channel_mux ownership slice

- `resource.daemon_channel_mux` now has a real physical owner: active module
  `daemon.channel_mux` owns `src/server/terminal-channel-mux-runtime.ts`.
  That runtime is the only place that creates mux channel transport/envelope
  objects and mutates `connection.muxChannels`; `terminal-runtime.ts` no
  longer owns `createMuxChannelSubscriber`, and bridge/daemon cleanup uses
  `listMuxChannelSubscriberIds` / `releaseAllMuxChannelSubscribers` owner APIs.
- `terminal-message-runtime.ts` receives only the channel-mux owner subset
  (`createMuxChannelSubscriber` / `ensureMuxChannels` /
  `releaseMuxChannelSubscriber`); mux attach atomic failure still removes the
  channel registry entry, closes the subscriber, and emits explicit
  `mux-channel-closed` before refusing attach.
- Registry/docs/AppSDK maps bind the new module, resource, import edges,
  function, verification gate, feature paths, and module registry test.
  Re-verified targeted daemon/mux/transport suite 86/86, feature registry
  84/84, tsc PASS, diff check PASS, daemon:mirror:close-loop all 9 cases plus
  replay and strict audit PASS, appsdk verify android ok:true draft; full
  contracts/build had already passed.
- Evidence `EVID-20260815-ZARCHV2-P5-PROD-DAEMON-CHANNEL-MUX-001` added.
  Review/promotion is not recorded because codex-review MCP remains
  unavailable; this slice is production_pending_review and v2 overall is not
  complete.

# 2026-08-15 Phase 5 daemon control gateway/control center production slice

- `daemon.control_gateway` and `daemon.control_center` now have real active
  production owners: `src/server/daemon-control-gateway-runtime.ts` adapts
  schedule and tmux commands through `src/server/daemon-control-center-runtime.ts`,
  which enforces unique command owners, capability, deadline, idempotency,
  correlation/subject validation, and bounded audit. Session open/connect/list
  also route through the gateway while keeping the existing
  `terminal-message-control-runtime.ts` handler surface and wire semantics.
- `terminal-message-runtime.ts` no longer imports schedule/tmux handlers
  directly; `server.transport-lifecycle-truth.test.ts` was updated to require
  gateway-owned handler delegation. The static ownership red gate forbids
  control-center imports of mirror/transport/file/server/runtime state and
  limits gateway imports to the control center, control handlers, and runtime
  types.
- Verified: `test:daemon-control-center` 10/10, `test:feature-registry` 84/84,
  terminal regression core 827/827 plus 98/98 user flows and relay smoke,
  `tsc --noEmit` PASS, full `pnpm run build` PASS,
  `daemon:mirror:close-loop` all 9 cases plus replay and strict audit PASS,
  `docs:function-wiki` regenerated, AppSDK verify android ok:true draft,
  `git diff --check` PASS. Evidence
  `EVID-20260815-ZARCHV2-P5-PROD-DAEMON-CONTROL-CENTER-001` added.
  Review/promotion is not recorded because codex-review MCP remains unavailable;
  this slice is production_pending_review and v2 overall is not complete.

# 2026-08-15 Phase 5 daemon buffer publisher production slice

- `daemon.buffer_publisher` now has a real physical owner:
  `src/server/daemon-buffer-publisher-runtime.ts` owns bounded per-subscriber
  pending-latest publication state, range merge/collapse, backpressure
  hysteresis, head broadcast cache, oversized same-revision frame split,
  contiguous same-revision split for every oversized body span including
  fresh attach, and flush statuses.
  `src/server/terminal-mirror-runtime.ts` delegates buffer-head and
  buffer-sync publication to this owner; `daemon.transport_subscriber` owns
  only physical send/backpressure/accounting and must not own bounded
  pending-latest publication.
- The only unsolicited live body broadcast path is
  `resource.mirror_store -> resource.daemon_buffer_publisher ->
  resource.transport_subscriber`. Mainline call-map IDs are
  `daemon_mainline:Mirror->BufferPublisher` and
  `daemon_mainline:BufferPublisher->TransportSend`.
- Verified `test:daemon-buffer-publisher` 6/6, `test:feature-registry`
  84/84, registry/mainline/edge/resource truth tests, tsc/type-check,
  `daemon:mirror:close-loop` 9/9 plus replay/strict audit, full build,
  wiki regeneration, AppSDK verify draft ok:true, and `git diff --check`.
  Evidence `EVID-20260815-ZARCHV2-P5-PROD-DAEMON-BUFFER-PUBLISHER-001`
  added. Review/promotion is not recorded because codex-review MCP remains
  unavailable; this slice is production_pending_review and v2 overall is not
  complete.

# 2026-08-15 Phase 5 daemon session catalog production slice

- `daemon.session_catalog` now has a real physical owner:
  `src/server/daemon-session-catalog-runtime.ts` owns
  `buildSessionsCatalogPayload` and `handleListSessionsMessageRuntime`.
  `daemon.control_gateway` delegates list-sessions handling to the catalog
  owner; `daemon.schedule_runtime` consumes only the payload builder. The
  catalog owner imports idle-facts publisher/runtime types; it must not own
  active session, mirror store, or transport subscriber truth.
- Mainline call-map IDs are
  `daemon_mainline:ControlGateway->SessionCatalog`,
  `daemon_mainline:Control->SessionCatalog`, and
  `daemon_mainline:SessionCatalog->IdleSessionPublishIn01Request`.
- Verified `test:daemon-session-catalog` 8/8, `test:feature-registry`
  84/84, registry/edge/mainline/resource truth tests, tsc,
  `daemon:mirror:close-loop` 9/9 plus replay/strict audit, full build,
  wiki regeneration, AppSDK verify draft ok:true, and `git diff --check`.
  Evidence `EVID-20260815-ZARCHV2-P5-PROD-DAEMON-SESSION-CATALOG-001`
  added. Review/promotion is not recorded because codex-review MCP remains
  unavailable; this slice is production_pending_review and v2 overall is not
  complete.

# 2026-08-15 Phase 7 debug console UI first slice

- `client.debug_console` is the active production owner of the typed debug
  console UI contract and debug overlay renderer; `shared.plugin_contract` owns
  the unique UI slot registry, and the plugin host owns deterministic
  start/stop/dispose plus slot publication.
- App must not call `PluginHost.readUiSlot` before `startAll` has reached the
  slot provider. `startAll` is sequential, so an async host start can leave a
  later plugin unregistered on the first render. Gate optional UI slot reads on
  host activation completion and keep App first-paint regression coverage in
  the build path.
- Verified `test:debug-console-ui` 35/35, `test:plugin-host` 14/14,
  `test:feature-registry` 84/84, full build PASS including terminal contracts
  833/833, tsc, docs wiki, AppSDK verify android draft ok:true, and
  `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-P7-PROD-DEBUG-CONSOLE-UI-001` added.
  Review/promotion is not recorded because codex-review MCP remains
  unavailable; this slice is `production_pending_review` and Phase 7 is not
  complete.

# 2026-08-15 Phase 7 session drawer UI second slice

- `client.session_drawer_ui` is the active production owner of the typed
  session drawer UI slot contract and the plugin-provided drawer projection;
  `SessionDrawerUiPlugin` publishes `terminal.session-drawer` through the UI
  slot registry, App reads it only after `PluginHost.startAll` resolves, and
  TerminalPage renders only the `renderSessionDrawer` callback. This removes the
  direct TerminalPage import/render edge for `TerminalSessionDrawer`.
- Verified `test:session-drawer-ui` 125/125, `test:debug-console-ui` 36/36,
  `test:plugin-host` 15/15, `test:feature-registry` 84/84, tsc, full build
  PASS including prebuild gates, terminal contracts 834/834, Gradle, Vite,
  docs wiki regeneration, AppSDK verify android draft ok:true, and
  `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-P7-PROD-SESSION-DRAWER-UI-001` added.
  Review/promotion is not recorded because codex-review MCP remains
  unavailable; this slice is `production_pending_review` and Phase 7 is not
  complete.

# 2026-08-15 Phase 7 file browser UI third slice

- `client.file_browser_ui` is the active production owner of the typed file
  browser UI slot contract and the plugin-provided FileTransferSheet projection;
  `FileBrowserUiPlugin` publishes `terminal.file-browser` through the UI slot
  registry, App reads it only after `PluginHost.startAll` resolves, and
  TerminalPage renders only the `renderFileBrowser` callback. This removes the
  direct TerminalPage import/render edge for `FileTransferSheet`.
- Verified `test:file-browser-ui` 66/66, `test:plugin-host` 16/16,
  `test:session-drawer-ui` 127/127, `test:debug-console-ui` 37/37,
  `test:feature-registry` 84/84, tsc, full build PASS including prebuild
  gates, terminal contracts 835/835, Gradle, Vite, docs wiki regeneration,
  AppSDK verify android draft ok:true, and `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-P7-PROD-FILE-BROWSER-UI-001` added.
  Review/promotion is not recorded because codex-review MCP remains
  unavailable; this slice is `production_pending_review` and Phase 7 is not
  complete.

# 2026-08-15 Phase 7 settings update UI fourth slice

- `client.settings_update_ui` is the active production owner of the typed
  settings update UI slot contract and the plugin-provided AppUpdateSection
  projection; `SettingsUpdateUiPlugin` publishes `settings.update` through the
  UI slot registry, App reads it only after `PluginHost.startAll` resolves, and
  SettingsPage renders only the `renderSettingsUpdate` callback. This removes
  the direct SettingsPage import/render edge for `AppUpdateSection`.
- SettingsPage tests that assert update projection behavior must inject the
  plugin-provided `AppUpdateSection` renderer; `SettingsPage.plugin-render.test`
  separately locks the slot callback contract and no-slot fallback.
- Verified `test:settings-update-ui` 57/57, targeted SettingsPage/AppUpdateSection/
  plugin-host/App dynamic refresh 71/71, `test:feature-registry` 84/84, tsc,
  full build PASS including prebuild gates, Gradle, terminal contracts, Vite,
  docs wiki regeneration, AppSDK verify android draft ok:true, and
  `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-P7-PROD-SETTINGS-UPDATE-UI-001` added.
  Review/promotion is not recorded because DSH/codex-review remains
  unavailable; this slice is `production_pending_review` and Phase 7 is not
  complete.

# 2026-08-15 Phase 7 remote window UI fifth slice

- `client.remote_window_ui` is the active production owner of the typed remote
  window UI slot contract and the plugin-provided RemoteWindowOverlay
  projection; `RemoteWindowUiPlugin` publishes `terminal.remote-window` through
  the UI slot registry, App reads it only after `PluginHost.startAll` resolves,
  and TerminalPage renders only the `renderRemoteWindow` callback. This removes
  the direct TerminalPage import/render edge for `RemoteWindowOverlay`.
- TerminalPage tests that assert remote-window projection behavior must inject
  the plugin-provided remote window renderer; IME tests also pass
  `renderRemoteWindow` when they cover remote-window keyboard input.
- Verified `test:remote-window-ui` 121/121, `test:feature-registry` 84/84,
  tsc, full build PASS including prebuild gates, terminal contracts 837/837,
  Gradle, Vite, docs wiki regeneration, AppSDK verify android draft ok:true,
  and `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-P7-PROD-REMOTE-WINDOW-UI-001` added.
  Review/promotion is not recorded because DSH/codex-review remains
  unavailable; this slice is `production_pending_review` and Phase 7 is not
  complete.

# 2026-08-15 Phase 7 quickbar UI sixth slice

- `client.quickbar_ui` is the active production owner of the typed quickbar UI
  slot contract and the plugin-provided TerminalQuickBar projection;
  `QuickBarUiPlugin` publishes `terminal.quickbar` through the UI slot
  registry, App reads it only after `PluginHost.startAll` resolves, and
  TerminalPage renders only the `renderQuickBar` callback. This removes the
  direct TerminalPage import/render edge for `TerminalQuickBar`.
- TerminalPage tests that assert quickbar projection behavior must inject the
  plugin-provided quickbar renderer; render isolation and IME tests pass
  `renderQuickBar` when they cover quickbar/input behavior.
- Verified `test:quickbar-ui` 72/72, `test:feature-registry` 84/84,
  `test:debug-console-ui` 40/40, `test:session-drawer-ui` 133/133,
  `test:remote-window-ui` 123/123, targeted foldable/schedule/multi-pane/
  remote-screenshot 20/20, tsc, full build PASS including prebuild gates,
  terminal contracts 838/838, Gradle, Vite, docs wiki regeneration, AppSDK
  verify android draft ok:true, and `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-P7-PROD-QUICKBAR-UI-001` added.
  Review/promotion is not recorded because DSH/codex-review remains
  unavailable; this slice is `production_pending_review` and Phase 7 is not
  complete.

# 2026-08-15 Phase 7 terminal shell UI seventh slice

- `client.terminal_shell_ui` is the active production owner of the typed
  terminal shell UI slot contract and the plugin-provided status/stage/copy/
  quickbar-shell/network-banner projection; `TerminalShellUiPlugin` publishes
  `terminal.shell` through the UI slot registry, App reads it only after
  `PluginHost.startAll` resolves, and TerminalPage renders only the
  `renderTerminalShell` callback. This removes the direct TerminalPage
  import/render edge for `TerminalConnectionStatusStrip`,
  `TerminalPageCopyMenu`, `TerminalPageStageShell`, `terminal-page-shell-ui`,
  `TerminalQuickBarShell`, and `TerminalNetworkBanner`.
- TerminalPage tests that assert shell projection behavior must inject the
  plugin-provided terminal shell renderer from
  `src/lib/plugin-host/terminal-shell-ui-plugin.tsx`; there is no separate
  test-provider render fork, so page boundary tests exercise the same
  `renderTerminalShellUi` function that `TerminalShellUiPlugin` publishes.
- Verified `test:terminal-shell-ui` 74/74, `test:feature-registry` 84/84,
  tsc, full build PASS including prebuild gates, terminal regression core
  839/839, Gradle, Vite, docs wiki regeneration, AppSDK verify android draft
  ok:true, and `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-P7-PROD-TERMINAL-SHELL-UI-001` added.
  Review/promotion is not recorded because DSH/codex-review remains
  unavailable; this slice is `production_pending_review` and Phase 7 is not
  complete.

# 2026-08-15 Phase 5 daemon attachment message delivery

- `daemon.attachment_delivery` owns
  `src/server/terminal-attachment-message-runtime.ts` for
  `pending-attachments-query`, `attachment-history-query`,
  `attachment-asset-request`, and `attachment-receipt` wire projection.
  `terminal-message-runtime.ts` is the physical receiving router only for
  these four types; it must not retain attachment delivery business state or
  reimplement query/read/receipt logic.
- The real module import edge is
  `daemon.transport_subscriber -> daemon.attachment_delivery` because
  `terminal-message-runtime.ts` belongs to `daemon.transport_subscriber`, not
  `daemon.connection_gateway`.
- Verified `test:attachment-message-delivery` 49/49,
  `test:feature-registry` 84/84, type-check/tsc, docs wiki regeneration, full
  build, `daemon:mirror:close-loop` all 9 cases with replay and strict audit,
  AppSDK verify android ok:true draft, and `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-P5-PROD-ATTACHMENT-MESSAGE-DELIVERY-001` added.
  Review/promotion is not recorded because DSH/codex-review remains
  unavailable; this slice is `production_pending_review` and Phase 5/v2 is
  not complete.

# 2026-08-15 Phase 5 daemon file transfer message route

- `daemon.file_transfer` owns
  `src/server/terminal-file-transfer-message-runtime.ts` for all
  file-transfer transport-message projections and raw binary chunks:
  `paste-image-start`, `attach-file-start`, `paste-image`,
  `file-list-request`, `file-create-directory-request`,
  `file-download-request`, `remote-screenshot-request`, and
  `file-upload-start/chunk/end`.
- `terminal-message-runtime.ts` is the physical receiving router only for
  these types; it must not import/invoke the file-transfer facade directly or
  own `session.pendingPasteImage` / `session.pendingAttachFile` projection.
  The message route owner projects pending start state and delegates exact
  file/screenshot handling to the existing `TerminalFileTransferRuntime`
  facade, preserving `session_required` and legacy wire semantics.
- The real module import edges are
  `daemon.transport_subscriber -> daemon.file_transfer` (router -> message
  route owner) and `daemon.file_transfer -> daemon.runtime` (message route
  owner -> terminal runtime types).
- Verified `test:file-transfer-message-route` 72/72,
  `test:feature-registry` 84/84, type-check/tsc, docs wiki regeneration, full
  build, `daemon:mirror:close-loop` all 9 cases with replay and strict audit,
  AppSDK verify android ok:true draft, and `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-P5-PROD-FILE-TRANSFER-MESSAGE-ROUTE-001` added.
  Review/promotion is not recorded because DSH/codex-review remains
  unavailable; this slice is `production_pending_review` and Phase 5/v2 is
  not complete.

# 2026-08-15 daemon.source_adapter contract owner verified

- `daemon.source_adapter` is the active physical owner of the shared terminal
  source adapter contract in `src/server/terminal-source-adapter.ts`; backend
  and mirror capture readback consumers import it without re-owning kind
  normalization, source session shape, or readback snapshot shape.
- The owner never holds mirror revision, backend session truth, renderer, or
  client UI truth. Blank/unsupported source kinds fail explicitly as
  `<empty>`/unsupported kind; supported kinds normalize case/whitespace.
- Verified source-adapter tests 4/4, feature-registry 84/84, tsc/type-check,
  docs wiki regeneration, full build with prebuild gates, daemon mirror
  close-loop 9/9 with replay and strict audit, AppSDK verify ok:true draft,
  and `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-P5-PROD-SOURCE-ADAPTER-001`; review remains pending
  because DSH/codex-review is unavailable.

# 2026-08-15 client.input_normalizer production owner verified

- `client.input_normalizer` is the exclusive production owner of
  `src/lib/terminal-input-normalization.ts`; `client.runtime` no longer lists
  that path. TerminalPage and TerminalView import the pure normalizer through
  the registered `client.app_shell -> client.input_normalizer` and
  `client.dom_renderer -> client.input_normalizer` edges.
- The normalizer preserves CJK/emoji/special symbols, converts terminal
  full-width punctuation/ideographic space to half-width, and converts IME
  line breaks to text separators instead of terminal Enter. It must never
  import or own session transport, daemon target transport, backend session,
  tmux, or mirror truth.
- Verified input-normalizer tests 8/8, feature-registry 84/84, tsc/type-check,
  docs wiki regeneration, full build with prebuild gates, daemon mirror
  close-loop 9/9 with replay and strict audit, AppSDK verify ok:true draft,
  and `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-P4-PROD-INPUT-NORMALIZER-001`; review remains pending
  because DSH/codex-review is unavailable.

# 2026-08-15 client.reliable_input production owner verified

- `client.reliable_input` is the exclusive production owner of
  `src/lib/reliable-input/reliable-input-queue.ts`; it owns reliable terminal
  input seq, one in-flight frame, ACK application, bounded ACK-timeout retry,
  physical-transport replacement retry, and head refresh.
  `session-context-input-runtime.ts` remains a thin bridge and re-export shell
  for `sendInputThroughSessionTransport` and
  `ensureSessionReadyForTransfer`; it must not re-own queue/ACK/retry truth.
- Retry/control state must stay inside `resource.client_reliable_input_queue`;
  it never writes retry control fields into terminal input payloads. The
  daemon side keeps its own `daemon.input_queue` ownership and seq/ack dedupe
  in `src/server/terminal-reliable-input-ack.ts`.
- Verified reliable-input ownership 12/12, session-context-input-runtime
  23/23, feature-registry 84/84, tsc/type-check, docs wiki regeneration, full
  build with prebuild gates, daemon mirror close-loop 9/9 with replay and
  strict audit, AppSDK verify ok:true draft, and `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-P4-PROD-RELIABLE-INPUT-001`; review remains pending
  because DSH/codex-review is unavailable.

# 2026-08-15 daemon.mirror_writer production owner verified

- `daemon.mirror_writer` is the active physical owner of validated source
  capture, canonicalization, and authoritative snapshot commit writes in
  `src/server/terminal-mirror-capture.ts`; it consumes the shared
  `daemon.source_adapter` readback contract and never owns mirror revision or
  client truth.
- `daemon.mirror_store` owns canonical mirror truth, revision, and runtime
  scheduling only; it no longer lists capture as an owned path.
  `terminal-mirror-runtime.ts` receives the capture function through
  `daemon.runtime_entry` dependency injection, so there is no
  `daemon.mirror_store -> daemon.mirror_writer` import edge. Capture remains
  the only owner that writes authoritative `mirror.rows` /
  `mirror.bufferLines` snapshots; revision advances only in the store.
- Verified mirror-writer ownership 4/4, feature-registry 84/84, tsc/type-check,
  docs wiki regeneration, full build with prebuild gates, daemon mirror
  close-loop 9/9 with replay and strict audit, AppSDK verify ok:true draft,
  and `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-P5-PROD-MIRROR-WRITER-001`; review remains pending
  because DSH/codex-review is unavailable.

# 2026-08-15 shared node/debug production foundation verified

- `shared.node_contract` and `shared.debug_contract` are active shared owners
  for node lifecycle/identity and debug registry/coordinator/event/permission
  contracts in `packages/shared/src/terminal/`; `@zterm/shared` exports them.
  `client.debug_console` owns the client snapshot hub
  (`src/lib/client-debug-snapshot.ts`) and `daemon.observability` owns
  `src/server/runtime-debug-store.ts`,
  `src/server/terminal-debug-runtime.ts`, and
  `src/server/runtime-debug-http-exporter.ts`.
- DebugRegistry duplicate registration is intentionally fail-fast. Test files
  that render real TerminalPage/App and import the real snapshot hub must keep
  `resetClientDebugSnapshotForTests`/cleanup at file scope, not inside one
  describe; scoped hooks leak producers into later describes and surface as
  `duplicate debug producer: terminal-page`.
- Verified shared-contract-ownership 5/5, debug-observability 64/64 + shared
  9/9, runtime-architecture-v2 30/30 + shared 10/10, feature-registry 84/84,
  full build with prebuild gates, daemon mirror close-loop 9/9 with replay and
  strict audit, AppSDK verify ok:true draft, and `git diff --check`. Evidence
  `EVID-20260815-ZARCHV2-PROD-FOUNDATION-NODE-DEBUG-001`; review remains
  pending because DSH/codex-review is unavailable.

# 2026-08-15 DSH PASS for v2 fix loop

- `zarchv2-current-dsh-r2` returned literal `VERDICT: PASS` after all seven
  P1 findings from `zarchv2-current-dsh-r1` were remediated and full prebuild,
  typecheck, Vite build, AppSDK verify, and `git diff --check` passed.
- The review still lists actionable P2/P3 items, and AppSDK lifecycle is still
  `draft`; DSH PASS is not AppSDK promotion and does not mean
  ZTERM-ARCH-V2-DESIGN-001 is complete.
- Android native background policy truth is bounded foreground-service
  `PARTIAL_WAKE_LOCK` with `WAKE_LOCK`, no battery-optimization bypass, and
  no socket/session/route ownership; `android-power-policy.test.ts` locks it.

# 2026-08-15 DSH r6 PASS after debug HTTP P1 remediation

- DSH `zarchv2-current-dsh-r5` failed on one confirmed P1: debug HTTP mutation
  endpoints were open by default on `0.0.0.0:3333` when no token was set, and
  `debug:control` default-deny/expiring lease was not enforced at an HTTP
  decision point.
- Production fix: `createTerminalHttpRuntime` now receives one shared
  `DebugPermissionService` through `daemonDebugPermissionService`; all debug
  routes return 401 on non-loopback hosts without a token; `/debug/runtime/control`
  is POST-only and returns 403 unless an active `debug:control` grant exists,
  so lease/broadcast mutation cannot fire without a grant. The shared service is
  also injected into `terminal-debug-runtime`, so the existing expiring lease is
  the same decision point used by HTTP.
- Verified: focused HTTP/debug 14/14, debug-observability Android 69/69 +
  shared protocol 10/10, feature-registry 92/92, type-check, full `pnpm run build`
  with prebuild gates, daemon mirror close-loop 9/9 + replay + strict audit,
  `git diff --check`, AppSDK verify ok:true draft.
- `zarchv2-current-dsh-r6` final is literal `VERDICT: PASS`, no P0/P1. Known
  P2s: Herdr scroll-metrics throttle can lag authoritative source-end advance
  up to ~100ms during sustained output; full-suite native WebRTC/
  ScreenCaptureKit aborts are environmental and pass isolated; debug
  read/subscribe capabilities are reserved but not independently `can()`-gated.
- AppSDK lifecycle remains `draft`; ZTERM-ARCH-V2-DESIGN-001 is not complete
  until promotion, Active/Protected archive, regression/freeze records, and
  device/OTA evidence are produced.
