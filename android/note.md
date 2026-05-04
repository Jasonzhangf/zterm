# note
- Jason 2026-04-25 新冻结:
  - server 的唯一职责：mirror tmux truth，回答 head 和 ranges
  - server 不得碰：策略、渲染、follow、reading、patch 规划
  - 多 session = 多个并行 canonical buffer；server 不替 client 规划行为
  - client buffer worker 只做：定时问 head、按需请求区间 buffer
  - renderer 只做：follow / reading、维护 renderBottomIndex、消费 buffer
- 目标: client 不持有 session 真源；render 只吃 daemon mirror + absolute rows
- 假设: 仍有 Android 本地恢复/渲染残留导致旧 session 或错误 viewport 被重用
- 验证入口: rg 残留字段 + SessionContext/Terminal* 代码审计 + build/test
- 新确认: 当前 TerminalPage 只挂 activeSession 的 TerminalView，违背“tab=session 常驻隔离”规则；切 tab 实际是在 remount 单一 view
- 新确认: App/Session 层的 input/resize/viewport 仍以 activeSession 作为隐式目标，而不是显式 sessionId；这会让切 tab 过程中旧 view 的异步回调污染新 session
- 修复方向: 1) callback 全改显式 sessionId；2) TerminalPage 常驻每个 tab 的 TerminalView，仅 active 控制可见/刷新频率；3) focus/query 也改按 sessionId 定位 active textarea
- Jason 2026-04-22 新冻结: hidden tab 完全冻结，不收 live buffer；切到 active 再单次同步
- Jason 2026-04-22 新冻结: active tab live 只追尾部最新连续区间，默认本地累计拼接，不做全窗口全量刷新
- Jason 2026-04-22 新冻结: reading 态只有在本地连续区间断裂时才向前预拉，窗口=两屏高度
- Jason 2026-04-22 新冻结: buffer/store/render 禁止 row 级深拷贝；只保留引用 + absolute indices + gap metadata
- Jason 2026-04-24 新冻结: refresh 与 scroll 必须解耦；Android 界面刷新是 buffer 的消费者，只读取当前 mirror / render window，不直接参与 buffer 生产或 merge
- Jason 2026-04-24 新冻结: scroll 属于 UI/render 状态机，不属于 buffer 状态；用户一旦向上回滚即进入 reading 模式，live buffer 更新不能反向改写当前滚动意图
- Jason 2026-04-24 新冻结: reading/follow 的切换只更新 renderer 的 `renderBottomIndex`（底部指针），再由 renderer 按当前 viewport 重算 render window 并刷新界面；禁止把该指针写回 buffer worker 真源
- Jason 2026-04-24 新冻结: buffer update -> renderer refresh -> DOM/UI scroll 三层单向；刷新只消费 buffer 结果，滚动只驱动 renderer 底部指针与界面重绘，二者都不反向耦合 buffer 维护
- Jason 2026-04-24 调查: tmux 最近多次崩溃，先确认 daemon 是否会通过 attach/resize/input/reconcile 高频控制影响 tmux 稳定性
- Jason 2026-04-24 假设: 若 daemon 存在高频 resize、重复 attach、observer/reconcile 风暴，可能诱发 tmux 卡死或异常退出；需用代码路径 + 本地日志双证据确认
- Jason 2026-04-24 验证入口: daemon 源码/脚本审计 + tmux/daemon 日志 + 当前系统 tmux server/client 进程状态
- Jason 2026-04-24 结论: daemon 确实会直接影响 tmux；它不仅 `send-keys/resize/new-session`，还会以 `tmux -CC attach-session -f ignore-size,read-only` 作为 control observer 挂到 tmux 上
- Jason 2026-04-24 证据: `tmux-2026-04-23-070736.ips` 的 crash coalition=`com.zterm.android.daemon`、responsibleProc=`node`，栈顶是 `control_write -> control_notify_session_created`
- Jason 2026-04-24 证据: `tmux-2026-04-24-104638.ips` 同一 crash 栈但 coalition=`com.googlecode.iterm2`；说明问题不一定 daemon 独有，但 control-mode attach 路径会触发 tmux 崩溃面
- Jason 2026-04-24 新判断: 当前代码没有固定 resize 定时风暴；resize 只在 attach/geometry 变化时触发，但 observer 通知 + 补偿式 reconcile 会持续 capture tmux，busy mirror 下频率很高
- Jason 2026-04-24 新假设: tmux 不是被普通 refresh/resize 打死，而是“分屏新增改动”让新 pane/新 client 创建额外 tmux client（尤其 control-mode attach），直接触发 tmux `session_created` crash 面
- Jason 2026-04-24 新冻结: split 只是显示/渲染端变化；两个分屏只是两个独立 tab/pane 的 UI 编排，不得触发新的 tmux client、副 attach、daemon mirror 重建或 session 级副作用
- Jason 2026-04-24 新冻结: daemon 对 tmux 的非用户显式动作必须收敛为只读获取；split/refresh/reading/follow/render 相关流程禁止修改 tmux 状态
- Jason 2026-04-24 新冻结: 禁止任何自动 kill tmux session/server 的实现；关闭 tab / 切 split / pane 回收 只能回收本地 client/runtime，不得回收 tmux session
- Jason 2026-04-24 新冻结: 高频打 tmux 不允许；tmux 只能按需获取，不能把 UI cadence / refresh cadence / split 编排直接投射成 tmux 调用频率
- Jason 2026-04-24 新冻结: `tmux kill-session` 只能存在于用户显式 kill 请求入口；禁止抽成可被 split/close/recycle/cleanup 复用的通用 helper
- Jason 2026-04-24 新冻结: 多 session 允许并存访问，但同一时刻只有 active session 允许高频 diff；inactive session 只能低频获取（目标 1s 一次）
- Jason 2026-04-24 新冻结: client buffer 先命中 daemon mirror；命中后不再回打 tmux。切 active session 后也仍然只允许一个 30fps 级高频 buffer 链路
- Jason 2026-04-24 新冻结: daemon 频率必须受 client 实际消费频率约束；网络/客户端降频后，daemon 也必须同步降频，避免无意义高频 capture/broadcast
- Jason 2026-04-24 新冻结: daemon 不再使用 `tmux -CC attach-session ... read-only` control observer；tmux 外部变化统一靠 mirror 自身的 active/idle cadence capture 检测，避免新增第二个 tmux client 崩溃面
- Jason 2026-04-24 新冻结: active/idle cadence 由 client 显式上报；daemon 只按 session subscriber 聚合后的 cadence 调度 capture，不再保留全局 33ms head 广播 / 补偿式 reconcile 定时器
- Jason 2026-04-24 新冻结: remote daemon / client 活跃刷新链禁止 snapshot/整窗初始化请求；client 只做 head 查询与显式区间请求，daemon 只回答 head 与 ranges，不允许整窗快照语义
- Jason 2026-04-28 remote screenshot 新复现:
  - 直接用本机 ws probe 打 daemon：`connected -> remote-screenshot-status(capturing) -> file-download-error(could not create image from display)`
  - 同一台机器交互 shell 里 `screencapture -x /tmp/...png` 成功
  - 新对照：
    - shell 里 `launchctl asuser $(id -u) screencapture` 成功
    - daemon bootstrap 里 `launchctl bsexec <daemon-pid> screencapture` 失败
  - 推断：不是 `screencapture` 二进制缺失，也不是机器无屏；而是 **launchd job 的负责进程/运行上下文** 不能直接截图，单纯改 `Aqua/Interactive` 还不够
  - 还缺：client 失败态现在只会 close preview + alert，用户体感像“还在 loading”；要改成显式 failed sheet
- Jason 2026-04-28 remote screenshot 新冻结:
  - 不能再让 daemon 直接截图
  - 必须增加一个运行在 GUI session 的 screenshot helper app/process
  - daemon 只做 request/response bridge + file stream
- Jason 2026-04-24 traversal close-loop 新目标: 本地先完成“独立 traversal relay 模块”闭环，再做一键部署到 Claw，随后验证 register/login 与 rtc relay
- 新根因确认: 当前已落地的 `/signal` 仍挂在目标 daemon 本身，只适用于“已能直达 daemon”的场景；对真正 NAT/内网目标无效，因为 signaling 本身先被直连阻断
- 修复方向: 新增独立 relay service（账户 + signaling broker + TURN 配置下发），daemon 改为主动出站注册到 relay service；client 通过 relay service 转发 SDP/ICE，WebRTC 仍只做链路层
- 部署约束: Claw 当前 `3478/udp` 已被 `derper` 占用，coturn 不能复用该端口；需选非冲突 TURN 监听端口并避免影响现有 sing-box/nginx 栈

- Jason 2026-04-28 remote screenshot helper 实证:
  - `pnpm --dir mac helper:dev` 已能起本机 GUI helper，socket=`~/.wterm/run/remote-screenshot-helper.sock`
  - 直连 socket probe 收到 `capture-started -> capture-completed`，并产出 `~/.wterm/tmp-helper-proof.png`
  - 前台 daemon + ws probe 收到 `capturing -> transferring -> file-download-complete(totalBytes=7056377)`
  - 新发现独立安装态问题：`./android/scripts/zterm-daemon.sh restart` 仍会在 `launchctl bootstrap` 失败，说明 helper 主链闭环已通，但 service 安装/重启链还没闭

- Jason 2026-04-28 launchd restart 根因收敛:
  - `./android/scripts/zterm-daemon.sh restart` 里的 `Bootstrap failed: 5: Input/output error` 不是 helper 不工作
  - 实际是 `launchctl bootout` 后旧 service 还没从 gui domain 移除，脚本就立刻 `bootstrap`，触发 launchd 时序竞争
  - 证据：`log show` 只看到 `service inactive -> removing service`；手工稍后 bootstrap 成功；补等待后 restart/remote-screenshot 闭环转绿
- Jason 2026-04-28 helper 产品化启动冻结:
  - screenshot helper 现在功能链已通，但仍靠 `pnpm --dir mac helper:dev`
  - 下一步要补 helper 自己的 LaunchAgent/service 脚本与显式状态入口
  - daemon 不得代为拉起 helper；helper 未运行仍然必须显式失败
- Jason 2026-04-28 transport/session 审计结论:
  - 用户要求的唯一模型是：**bridge target 一个 base ws 长连，client session 稳定，inactive 只停取数，不关 session/transport**
  - 当前 client 活代码并不是这样：
    - `SessionContext` 仍是 `sessionId -> wsRefs`
    - `connectSession()` / `reconnectSession()` 都会先 `cleanupSocket(..., true)`
    - transport open 后仍重新发 `connect`
  - `TraversalSocket` 本身没有 host 级 singleton / reconnect bucket；“同 host 多 session 串挂”主因不在 traversal layer
  - daemon 活代码已具备 `logical session != transport` 雏形：
    - `adoptLogicalClientSession()` 会按 `clientSessionId` 重绑 transport
    - `ws.on('close')` 对 logical-bound session 走 `detachClientSessionTransportOnly()`
  - 但 daemon 仍保留 `60s grace -> closeLogicalClientSession()`，这和“只允许 explicit close / daemon shutdown 回收 logical session”的冻结设计冲突
- Jason 2026-04-28 transport/session 本轮 closeout 约束:
  - App foreground resume 必须统一走：`resumeActiveSessionTransport(active) -> failed 才 reconnect(active)`
  - 这里不能再按 UI `session.state` 先分叉，否则会把“label stale but transport alive”的情况误杀成 reconnect
  - App 若首帧已持有现存 sessions，也必须立即把 `OPEN_TABS / ACTIVE_SESSION` 回写到 localStorage；否则冷启动恢复真相会滞后一个渲染周期，测试与现场都会丢 active tab
  - 下一步结构收口：把 `SessionContext` 里的 `wsRefs / supersededWsRefs / sessionHostRef` 合并成单一 transport runtime store
  - 目标不是补新语义，而是把“session -> target -> active/superseded transport” 的真实 ownership 从散乱 Map 收到一处，给后续 control transport / per-session transport 分层打底
  - 继续要求：`controlTransport` 先只作为 target runtime 显式真相，不提前承接 head/range/input；避免角色越层漂移
  - 2026-04-28 当前新增收口：`target runtime` 只允许在 `0 session + no control transport` 时删除；最后一个 session 离开但 control transport 还活着时，target truth 不能被顺手清空
  - 2026-04-28 当前继续收口：`SessionContext` 里 connect / reconnect 的 websocket onopen/onmessage/onerror/onclose 已共用同一条 lifecycle helper，避免两份 transport 编排继续漂移
  - daemon transport lifecycle gate 已补进 contracts：ws/rtc close/error 对 logical-bound session 只能 detach transport，不能回退成隐式 close logical session
  - 2026-04-28 当前再向前一刀：`session transport token` 已明确冻结成 per-session truth
    - daemon: `session-transport-ticket.ts` 保证同一 `clientSessionId` 只有一个当前有效 ticket
    - client runtime: `sessionTransportToken` 不属于 target，也不属于 socket，而属于 session runtime；retarget 时必须清空
- Jason 2026-04-28 P0 silent failure audit & remote screenshot fix:
  - 全局审计完成，13 处 silent catch 定位，7 处 P0 已修复为 console.error/warn 暴露
  - 远程截图卡死根因：daemon 侧正常（ws probe 全链路验证通过），问题在 Android 客户端
    - `buildRemoteScreenshotCapture()` 将 27 个 base64 chunk 拼成 ~6.9MB 巨串
    - `TerminalPage` 做 `atob(6.9MB)` → Android WebView 上此操作挂住（内存/性能限制）
    - 修复：逐 chunk atob 解码为 Uint8Array 后合并，TerminalPage 优先用 `capture.dataBytes`
  - Fallback 代码逻辑已全部清除（只剩一处排序注释 `// fallback to manual order`，不是代码逻辑）
  - 架构风险确认待后续处理：
    - SessionContext.tsx 3230行需拆分（buffer-sync / transport / render-demand）
    - 5路 reconnectSession 并行触发需收敛为单一入口
    - cleanupSocket 先杀再建与 stable transport 设计冲突
    - 60s grace timer 与 explicit-only close 设计冲突
- Jason 2026-04-28 文件传输功能依然无反应：
  - 需要端到端排查：客户端发送是否到 daemon、daemon 处理逻辑、文件实际传输

[2026-05-02] tab close root cause
- 现象：真机顶部 active tab 的 × 看起来“无法关闭”。
- 验证：TerminalHeader 现有实现是 1600ms 内二次点击确认，不是单击关闭；组件测试与 open-tab 持久化测试均通过，说明更像交互语义错误而非 close 链路断裂。
- 决策：保持关闭真源仍在 App/SessionContext；仅移除 Header 隐藏式二次确认，恢复为单击关闭，避免用户感知为失效。

[2026-05-02] mobile-16.12 width-mode manager first cut
- 目标：先做不阻塞主链的 `mobile-16.12`，把 width-mode 散落逻辑收成单一模块，不碰 transport/buffer 主链。
- 已做：
  - 新增 `src/lib/terminal-width-mode-manager.ts`
  - 收口 width-mode options / normalize / bridge-settings update / daemon payload builder
  - `SettingsPage.tsx` 与 `SessionContext.tsx` 已切到 manager
- 验证：
  - width-mode + settings + mirror-geometry 相关 22 tests passed
- 现状：
  - 整仓 tsc 仍被现有 `src/lib/buffer/BufferSyncEngine.ts` 半成品阻塞，非本刀新问题

- 2026-05-03 mobile-16.13 调试记录：
  - 现象：`viewport-reading-gap` 不发 repair，或 `reading -> follow` 前多发一条 repair。
  - 真因 1：`daemonHeadEndIndex=0` 被当作 authoritative known head，visible repair window 被错误截空。
  - 真因 2：无 authoritative head 时，新的 follow viewport 会在 `requestSessionBufferSync` 中 supersede 已在途 reading-repair，导致测试边界来回摆。
  - 收口：helper 恢复 reading repair 的 request-window 缺口判定；SessionContext 只在 authoritative head 已知时允许 reading-repair supersede。

- 2026-05-03 mobile-16.14 第一刀：
  - 目标：继续缩小 `SessionContext`，优先抽不碰 daemon/session 主链的 runtime。
  - 选择：先抽 `remote screenshot runtime`，因为它只负责 requestId、timeout、chunk aggregation、promise settle，不持有 terminal buffer/render/transport 真相。
  - 已做：新增 `src/lib/remote-screenshot-runtime.ts` + 单测；`SessionContext` 改为纯接线。
  - 验证：remote screenshot 自测 4/4；原 `SessionContext.ws-refresh` 截图两测保绿。

- 2026-05-03 mobile-16.14 第二刀：
  - 目标：继续移除 `SessionContext` 中 file/screenshot message 分发重复逻辑。
  - 已做：新增 `src/lib/file-transfer-message-runtime.ts`，把 listener registry、message classify、screenshot hook 调用、listener error isolate 收到一个 runtime。
  - 效果：`SessionContext` 的 server message switch 对 file transfer 只剩单入口 dispatch。

- 2026-05-03 mobile-16.14 第三刀调试记录：
  - 目标：继续缩 `SessionContext.tsx`，优先抽 transport runtime，不碰 buffer/render 真相。
  - 已做：新增 `src/contexts/session-context-transport-runtime.ts`，收口 transport accessor、control socket cleanup/open/message、session socket open/bind。
  - 新踩中的坑：若直接 `const { ... } = createSessionContextTransportAccessors(...)` 放在 render 里，每次 render 都产出新函数，导致一串 `useCallback/useEffect` 依赖活循环，vitest 直接挂死。
  - 收口：改为 `const transportAccessorsRef = useRef(createSessionContextTransportAccessors(...)); const { ... } = transportAccessorsRef.current;`，保证 accessor identity 稳定。
  - 结果：`SessionContext.ws-refresh.test.tsx` 全量 93/93 恢复；`App.dynamic-refresh` 与 `TerminalPage.render-scope` 仍绿。

[2026-05-03] TerminalPage lifecycle audit: listener cleanup currently removes from current window.visualViewport / navigator.virtualKeyboard object instead of captured registration instance; add lifecycle cleanup regression before changing implementation.


[2026-05-03] SessionContext stale-open transport audit: confirmed one real bug and one false-red. Real bug: session transport `pong` was incorrectly counted as `lastServerActivityAt`, which kept stale-open WS falsely healthy and blocked reconnect escalation. Fixed by excluding `pong` from `recordSessionRx()` on session transport and never recording control-transport traffic as session activity. False-red: the new `pong-only` stale transport test originally timed out because it used `waitFor(...)` under fake timers before the first buffer-sync paint settled; converted it to explicit microtask flush + synchronous assertion, then verified reconnect path deterministically (control socket opens + second session socket created).

[2026-05-03] Verified gates after stale-open transport fix:
- `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx -t 'does not let pong-only traffic keep a stalled active transport healthy forever|does not treat pong as a head-refresh ack and avoids duplicate input refresh requests|does not stack multiple active-tick loops across provider rerenders|uses App-provided foreground truth instead of directly reading document visibility for active tick refresh' --reporter dot`
- `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx src/pages/TerminalPage.lifecycle-cleanup.test.tsx src/pages/TerminalPage.android-ime.test.tsx src/pages/TerminalPage.render-isolation.test.tsx src/pages/TerminalPage.render-scope.test.tsx src/components/terminal/TerminalHeader.test.tsx src/components/terminal/TabManagerSheet.test.tsx --reporter dot`
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
All green locally. Next focus stays on remaining real-world slowness after app resume / multi-tab switching; likely still inside client SessionContext refresh scheduling, not daemon protocol.


[2026-05-03] Tab-switch lag audit: found duplicated active-session refresh trigger in client SessionContext. `switchSession()` both set active session and immediately called `ensureActiveSessionFresh(active-reentry)`, while the dedicated `useEffect([state.activeSessionId])` also called the same active-reentry path on the same switch. This doubled head refresh / reconnect decision work on every tab switch. Fixed by keeping `switchSession()` pure (`setActiveSessionSync` only) and leaving active-reentry refresh solely to the activeSessionId effect as the unique truth.
- Jason 2026-05-03 新确认: daemon 侧 `findChangedIndexedRanges()` 已支持“已有 absolute row 内容变化”，不是只看新增尾行；本轮真实缺口在 client same-end revision advance 请求窗口过小。
- Jason 2026-05-03 新冻结: 当 `buffer-head` 出现 `revision` 增长但 `latestEndIndex` 不增长时，follow 路径必须重拉完整 follow request window（三屏），不能只拉当前可视一屏，否则已有行改写会漏补。

[2026-05-03] open-tab / active-session 唯一真源审计
- 现状核查：`OPEN_TABS / ACTIVE_SESSION` 生产写口已基本收敛到 `android/src/App.tsx -> persistExplicitOpenTabs()` 与 `android/src/lib/open-tab-persistence.ts`。
- 已确认唯一例外：`handleSwitchSession()` 仍直接 `persistActiveSessionId()`，形成“active-only 持久化”和“tabs+active 一起持久化”两条写路径。
- 决策：把 tab 激活也并入 `persistExplicitOpenTabs()`，让 App 层所有 open-tab/active-session 持久化都走同一 orchestration 写口；`open-tab-persistence.ts` 只保留底层存取 helper。
- 额外审计：`persistSessionIntentState()` 当前无生产调用，属于历史残留 helper；本刀先不删，避免扩大写面，后续等 tab/session 收口结束后再清理。
- 2026-05-03 当前继续收口：`android/src/lib/open-tab-persistence.ts` 中无生产调用的 `persistSessionIntentState()` 已删除，避免 tab/session intent 持久化 helper 再长出第二个半公开写口。
- 2026-05-03 当前继续收口：`ACTIVE_PAGE.kind=terminal.focusSessionId` 只允许作为 terminal page 投影，不允许独立漂移成第二份 active 真相；新增 App effect，在 terminal 页下强制把 page focus 收敛到 `state.activeSessionId`。

## 2026-05-03 active/page focus truth matrix closeout
- 已补测试钉死：`ACTIVE_SESSION` 是 active tab 唯一真源，`ACTIVE_PAGE.kind=terminal.focusSessionId` 只是 terminal 页面投影。
- 已验证 3 条关键链路都一致：saved-tabs import、下一次冷恢复 restore、foreground resume；三者都要求 `ACTIVE_PAGE.focusSessionId === ACTIVE_SESSION`。
- 当前实现无需新增写口；App 层继续只允许通过 `persistExplicitOpenTabs(...)` / `persistAndSwitchExplicitOpenTabs(...)` 落盘 active/open-tabs，terminal page focus 仅随 `state.activeSessionId` 单向收敛。

## 2026-05-03 open-tabs explicit truth freeze
- 已确认 reopen 根因：`mergeRuntimeSessionsIntoOpenTabIntentState()` 以前会把 persisted `OPEN_TABS` 里不存在、但 runtime 仍活着的 session 重新 append 回 tabs，导致“已关闭 tab 下次启动又自动打开”。
- 现冻结：一旦 `OPEN_TABS` 已存在，它就是 explicit client truth；runtime 只允许做 **语义重复 tab 的 live sessionId 替换 / 元数据刷新**，不允许 append runtime-only tabs。
- bootstrap from runtime 仅允许发生在“根本没有 persisted OPEN_TABS 真相”时；显式空数组 `OPEN_TABS=[]` 和显式非空数组都禁止 runtime 补开。

## 2026-05-03 tab close single-entry closeout
- 已确认 App 之前存在两条重复 tab-close 落盘路径：UI close 与 `SESSION_STATUS_EVENT(type=closed)` 各自直接调用 `closeOpenTabIntentSession(...) + persistExplicitOpenTabs(...)`，且 event 路径闭包读取的是旧 `state.sessions / activeSessionId`。
- 现已收口到 `applyClosedOpenTabIntent(...)`：UI close 与 remote closed 都走同一 helper，并强制读取 refs 上的最新 runtime truth，避免 stale closure 导致 active/focus/tab 残留错误。
- 额外补上 runtime disappearance sweep：当 persisted open tab 对应 session 已真实从 runtime state 消失时，自动按同一 close truth 收口并持久化；但该 sweep 只允许在 `state.sessions.length > 0` 且 restore 已完成后执行，禁止误伤 cold restore。

## 2026-05-03 active-reentry / active-resume head de-dup closeout
- 现象：同一 session 上，tab switch 触发 `active-reentry` 后，若前台恢复/显式 resume 紧跟着再次触发 `active-resume`，客户端会在同一 throttle 窗口内重复发第二次 `buffer-head-request`，表现为切 tab / 恢复时重复调度、卡顿。
- 真因：`SessionContext` 的 active freshness 语义缺少“同一 session 的刚发生 reentry”记忆；`active-resume(forceHead)` 与 `active-reentry(forceHead)` 都会命中同一 request-head 分支，但没有单一去重门禁。
- 收口：在 `session-context-activity-runtime` 内引入唯一去重门禁：仅当 `source=active-resume`、`forceHead=true`、transport 仍 open、且同 session 最近一次 `active-reentry` 发生在 `headTickMs` 窗口内时，跳过第二次强制 head；resume 语义仍保留 `pendingResumeTailRefresh`，普通 explicit resume 语义不变。
- 生命周期补齐：`lastActiveReentryAtRef` 只属于客户端 SessionContext runtime；close session 时同步清理，禁止残留为第二真源。
- 验证：定向 6 条 ws-refresh 用例 + App/open-tab 回归 + tsc 全绿；其中新增测试钉死“switch -> immediate resume”只允许一条 `buffer-head-request`。

## 2026-05-03 tab switch卡顿页面层真因（非分屏 renderer 过量挂载）
- 现象：多开几个 tab 后，切换越来越卡；杀掉 app 重进立即恢复。
- 真因：`TerminalPage` 在 `splitVisible=false` 时仍把 `sessions` 全量映射成 `TerminalView`，只是靠 `visibility:hidden/pointer-events:none` 隐藏 inactive tab。这样每个 hidden tab 仍保留 renderer 实例、store 订阅、布局测量与 DOM/input 生命周期，tab 一多后切换成本线性上升。
- 收口：非分屏时 `renderedPaneSessions` 只允许挂载 `[activeSession]`；inactive tab 的长期真相继续留在 SessionContext/buffer/transport，不再让 UI renderer 常驻。split 模式仍只挂当前可见 pane sessions。
- 验证：`TerminalPage.render-scope.test.tsx` 已改为钉死“非分屏仅挂 active renderer，切 tab 后卸载旧 renderer 并挂新 renderer”；相关 App/SessionContext active truth 定向回归继续为绿。

## 2026-05-04 daemon / client 架构违规只读审计（唯一真源 / 重复实现 / 静默失败 / fallback）
- 范围：`android/src/server/*` + `android/src/lib/*` + `android/src/App.tsx` 相关 open-tab/session truth。
- 已确认客户端 open-tab/active-session 写口当前基本已收敛：
  - App 层唯一编排写口：`persistExplicitOpenTabs(...)` / `persistAndSwitchExplicitOpenTabs(...)`
  - 底层存储 helper：`persistOpenTabsState(...)`
  - `persistActiveSessionId(...)` 现仅被 `persistOpenTabsState(...)` 内部调用，不再有第二生产写口。
- 已确认 server 仍有 3 个高风险违规点：
  1. `terminal-mirror-runtime.ts` 仍用 `mirrorHasAttachedTransportSubscriber()` 决定 live sync 生命周期；`scheduleMirrorLiveSync()` 在无 attached subscriber 时直接 `stopMirrorLiveSync()`，违反“mirror truth 独立于 client attach/detach”冻结。
  2. `mirror-geometry.ts` 仍保留 `resolveMirrorSubscriberGeometry(...)`，按 subscriber `widthMode/requestedCols` 反推 mirror geometry，违反“daemon 不持有客户端 viewport/width mode 语义”。当前 rg 未见活调用，但属于高风险残留真相入口。
  3. `terminal-message-runtime.ts` 对 `buffer-head-request` / `buffer-sync-request` 在 `!mirror || lifecycle!==ready` 时直接 `break`，属于静默失败；客户端会看到不刷新但无错误。
- 已确认 server 仍有 2 个中风险协议兼容残留：
  1. `terminal-attach-token-runtime.ts` 仍以 `Map<token, clientSessionId>` 持有 attach token owner；虽然 docs 允许 attach-only wire material，但 daemon 仍认 `clientSessionId` 做 token ownership，后续应继续收口到 one-shot attach proof，不进入长期业务真相。
  2. `terminal-message-control-runtime.ts` 仍沿用 `session-ticket/sessionTransportToken + clientSessionId` 握手材料；当前注释已声明 compatibility-only，但实现上仍需防止再向 daemon 内部扩散。
- 已确认客户端/辅助 runtime 静默失败点：
  1. `remote-screenshot-runtime.ts`：chunk `atob` 失败被空 catch 吞掉，并注释“caller can still use concatenated base64”；这就是明确 fallback 语义，违反 hard guard。
  2. `terminal-file-transfer-list-runtime.ts`：单个 entry `statSync` 失败直接跳过；cleanup `unlinkSync` 失败直接 ignore，属于 silent partial failure。
  3. `TerminalPage.tsx`：保存远程截图时 `Filesystem.mkdir(...)` 空 catch；如果不是“目录已存在”而是权限/路径错误，会静默吞掉。
  4. `session-context-infra-runtime.ts`：`buildTraversalSocketForHostRuntime()` 里 URL parse 失败直接回退到原始 `wsUrl`，这是兼容性 fallback，需确认是否符合当前“禁止 fallback”基线。
- 已确认非问题/已显式暴露点：
  - `file-transfer-message-runtime.ts` 的 listener error 不是静默失败：生产装配 `session-context-provider-runtime.ts:96-98` 已统一 `console.error`。
  - `open-tab-persistence.ts` 里的 fallback* 命名当前是“恢复时补字段”的 helper 参数，不是运行时双路径补偿；暂不算违规。
- 下一步建议优先级：
  1. 先删/停用 server `subscriber-driven liveSync lifecycle`。
  2. 再删/封存 `resolveMirrorSubscriberGeometry(...)` 与相关旧测试，确保 daemon 不再保留 client width truth 入口。
  3. 将 `buffer-head-request` / `buffer-sync-request` 的 silent break 改成显式 error。
  4. 移除 `remote-screenshot-runtime.ts` / `TerminalPage.tsx` / `terminal-file-transfer-list-runtime.ts` 的空 catch / ignore / fallback。

## 2026-05-04 mobile-18.1 / mobile-15.12 closeout
- 已删除 `terminal-mirror-runtime.ts` 中 `mirrorHasAttachedTransportSubscriber(...)` 门禁。
- `scheduleMirrorLiveSync(...)` 现在只受 `mirror.lifecycle === ready` 控制；subscriber/transport 是否存在不再停止 live sync。
- 回归测试已同步改写：
  - 旧断言“无 attached transport 时停止 recurring live sync”已改为“仍继续 recurring live sync”。
  - ready mirror 被新 session 复用时，live sync 不依赖重新 attach 才恢复，而是持续推进。
- 当前验证：
  - `src/server/terminal-mirror-runtime.test.ts`
  - `src/server/mirror-lifecycle.test.ts`
  - `src/server/server.transport-lifecycle-truth.test.ts`
  - 共 22 tests passed

## 2026-05-04 daemon transport truth 第二刀
- 决策：daemon 允许持有的“连接观测”只属于 transport/connection，不属于 logical session。
- 已收口：
  - `ClientSession` 删除 `requestOrigin / wsAlive / connectedSent`
  - `connectedSent / requestOrigin` 改挂 `session.transport`
  - heartbeat `wsAlive` 继续只挂 `DaemonTransportConnection`
  - debug/http snapshot 改从 transport/connection 读取，不再把连接状态写进 session 真相
  - 删除 `resolveMirrorSubscriberGeometry()` 与对应测试，切断 daemon 保留 subscriber-width 语义入口
- 预期收益：
  - session 真相更纯，只剩 tmux attach/file transfer 必要字段
  - daemon 不再把客户端 transport 观测偷渡成 session 状态

## 2026-05-04 daemon 残留物理清除第三刀
- 已确认并删除：
  - `terminal-message-runtime.ts` 里的 `case 'resize'`
  - `terminal-message-runtime.ts` 里的 `case 'terminal-width-mode'`
  - 这两个旧协议入口在 daemon 内已无任何必要语义，继续留空壳也算残留
- 已继续收口 attach token：
  - `terminal-attach-token-runtime.ts` 从 `Map<token, clientSessionId>` 改成 `Set<token>`
  - daemon 不再以 `clientSessionId` 做 token owner
  - `sessionTransportToken` 现在只是 one-shot opaque attach proof
- 保留但明确边界：
  - `session-open / session-ticket / clientSessionId` 仍是现行客户端活协议，当前不能物理删除
  - 但 server 内已经不再把 `clientSessionId` 提升成 daemon-owned ownership truth
- 这刀的结果是：daemon mirror canonical sync 生命周期已从 client attach/subscriber 语义解耦，符合“daemon 只维护 tmux truth”的冻结设计。

## 2026-05-04 daemon 去客户端化第四刀
- 已完成：
  1. shared wire `HostConfigMessage` 从 `clientSessionId` 收口为 `openRequestId`
  2. wire 上已删除 `bridgeHost / bridgePort / authToken / authType / password / privateKey / terminalWidthMode / name`
  3. daemon server 内 `ClientSession / ClientSessionTransport / getClientMirror / closeLogicalClientSession / shutdownClientSessions` 命名已清成 terminal/bound session 语义
- 冻结口径：
  - `openRequestId` = client-local open intent correlation only
  - `sessionTransportToken` = daemon one-shot opaque attach proof
  - daemon 只认 transport / mirror / bound terminal session fact
- 当前验证：
  - `pnpm exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm exec vitest run src/server/terminal-mirror-runtime.test.ts src/server/terminal-message-runtime.test.ts src/server/terminal-runtime.detached-session.test.ts src/server/mirror-geometry.test.ts src/server/server.transport-lifecycle-truth.test.ts src/server/server.daemon-runtime-truth.test.ts src/server/server.http-truth.test.ts --reporter dot`
  - `rg -n \"ClientSession|ClientSessionTransport|closeLogicalClientSession|getClientMirror|shutdownClientSessions|logical client session\" android/src/server` => empty

## 2026-05-04 client handshake truth 收口
- 已完成：
  1. client 侧 `openRequestId` 不再偷用稳定 `sessionId`
  2. 每次 connect/reconnect open intent 都生成新的 one-shot `openRequestId`
  3. `pendingSessionTransportOpenIntentsRef` 仍以 `sessionId` 为本地 stable owner，但握手匹配改按 `openRequestId` 查找
- 结果：
  - `sessionId` = client stable business identity
  - `openRequestId` = one-shot open intent correlation
  - 这两个真相已在客户端拆开，不再混写
- 当前验证：
  - `pnpm exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm exec vitest run src/contexts/session-sync-helpers.test.ts src/contexts/SessionContext.ws-refresh.test.tsx src/server/server.transport-lifecycle-truth.test.ts --reporter dot`
  - 结果：`158 tests passed`

## 2026-05-04 mobile-18.3 closeout
- `terminal-message-runtime.ts` 已删除 `buffer-head-request` / `buffer-sync-request` 的 silent break。
- 当 session 已绑定但 mirror 缺失或非 ready 时，现在统一回 `type=error, code=session_not_ready`。
- 新增 `src/server/terminal-message-runtime.test.ts`，钉死 not-ready 必须显式报错。
- 当前验证：`terminal-message-runtime.test.ts + server.transport-lifecycle-truth.test.ts + server.core-support-truth.test.ts` 共 20 tests passed。

## 2026-05-04 mobile-18.3 closeout
- `terminal-message-runtime.ts` 已删除 `buffer-head-request` / `buffer-sync-request` 的 silent break。
- 当 session 已绑定但 mirror 缺失或非 ready 时，现在统一回 `type=error, code=session_not_ready`。
- 新增 `src/server/terminal-message-runtime.test.ts`，钉死 not-ready 必须显式报错。
- 当前验证：`terminal-message-runtime.test.ts + server.transport-lifecycle-truth.test.ts + server.core-support-truth.test.ts` 共 20 tests passed。

## 2026-05-04 active-only ws-refresh closeout
- 现象：SessionContext.ws-refresh.test.tsx 7 条失败，全部断言 inactive session 预热 revision。
- 已验证真源：inactive session 不再 apply buffer/head/render；测试需改为 switch active 后再 head-first 建立 local truth。
- 决策：只改测试，不改生产逻辑。

## 2026-05-04 pending open intent 单一真源收口
- 已完成：
  1. 新增 `src/contexts/session-context-open-intent-store.ts`
  2. 统一 `get/set/delete/has/findByRequestId`
  3. `session-context-infra-runtime.ts / session-runtime.ts / socket-message-runtime.ts / transport-open-runtime.ts / transport-runtime.ts` 不再散落直接操作 pending-open `Map`
- 冻结口径：
  - `sessionId` 仍是 client stable owner
  - `openRequestId` 只做 one-shot handshake correlation
  - pending-open store 只允许通过 helper 读写
- 当前验证：
  - `pnpm exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm exec vitest run src/contexts/session-context-open-intent-store.test.ts src/contexts/session-sync-helpers.test.ts src/contexts/SessionContext.ws-refresh.test.tsx src/server/server.transport-lifecycle-truth.test.ts --reporter dot`
  - 结果：`161 tests passed`

## 2026-05-04 foreground resume owner 收口
- 现象：`App.tsx` 在前台恢复时，先调用 `resumeActiveSessionTransport()`，若返回 false 又额外自己调用 `reconnectSession()`。
- 结论：这与 `SessionContext -> ensureActiveSessionFresh(... allowReconnectIfUnavailable=true)` 重复 owner，前台恢复的 reconnect 决策不该再由 App 兜底。
- 已修改：
  - `lib/app-foreground-refresh.ts` 只保留“把前台恢复委托给 SessionContext transport truth”
  - 删除 App 层 `reconnectSession` fallback
- 结果：
  - foreground resume 的 refresh / reconnect owner 重新收回 SessionContext 单点
  - App 只负责 lifecycle signal，不再二次实现 transport 决策

## 2026-05-04 active session restore owner 收口
- 现象：`App.tsx` 里存在两处冷启动/恢复时的 active session 推进路径：
  1. open-tab restore effect 负责按 persisted OPEN_TABS / ACTIVE_SESSION 恢复 runtime active tab
  2. route restore effect 也会再次 `switchSession(targetSessionId)`
- 结论：route restore 不该再拥有 active session 决策；它只该负责页面 focus。
- 已修改：
  - `App.tsx` route restore effect 删除 `switchSession(targetSessionId)`
  - active session restore 继续只由 open-tab/session restore 链负责
  - route restore 只做 `ensureTerminalPageFocus(targetSessionId)`
- 当前验证：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/App.dynamic-refresh.test.tsx src/App.first-paint.test.tsx src/App.first-paint.real-terminal.test.tsx --reporter dot`
  - 结果：`3 files passed / 46 tests passed`

## 2026-05-04 server closed -> tab close 单一路径收口
- 现象：server 下发 `type='closed'` 后，client 虽然开始走 `SESSION_STATUS_EVENT(closed)`，但同一个 ws 后续 `onclose` 仍会掉进 `finalizeFailure -> reconnect/error`，形成第二条 owner。
- 根因：`closed` 语义与 transport failure 没有物理隔离；socket lifecycle 仍保留 failure 回调。
- 已修改：
  - `session-context-socket-message-runtime.ts`：收到 `closed` 后先物理清空当前 session socket 的 `onopen/onmessage/onerror/onclose`，再 emit closed。
  - `session-context-transport-open-runtime.ts`：session transport open runtime 补齐 `onClosed` 透传，保证 closed 走单一路径。
  - `App.tsx`：`SESSION_STATUS_EVENT(type='closed')` 现在直接走 `applyClosedOpenTabIntent(... closeRuntimeSession=true, clearDraft=true)`，不再只删 persisted tab。
- 回归：
  - `tsc --noEmit` 通过
  - `SessionContext.ws-refresh.test.tsx` 新增真实 ws `type='closed'` 回归：关闭事件只发一次，不再因随后 socket close 二次落回 reconnect
  - `App.dynamic-refresh.test.tsx` 补断言：远端 closed 后会同步 close runtime session 并持久化移除 tab

## 2026-05-04 SessionProvider facade 引用稳定化（切 tab 卡顿排查第一刀）
- 现象：TerminalPage 已做 `React.memo`，但只要上层传入的 handler 引用在每次 SessionContext state/buffer 更新后变化，memo 仍会失效，切 tab / 多 pane 下会把 TerminalPage shell 和子树一起带着重算。
- 结论：SessionProvider assembly/facade 返回对象必须稳定；不能每次 render 直接返回新对象，否则 App -> TerminalPage props equality 会被函数引用击穿。
- 已修改：
  - `session-context-provider-assemblies.ts`：对合并后的 assemblies 返回值加 `useMemo`
  - `session-context-provider-facade-assemblies.ts`：对 facade 返回值加 `useMemo`，稳定 `switchSession / setLiveSessionIds / sendInput / updateSessionViewport / resumeActiveSessionTransport` 等引用
- 新回归：
  - `SessionContext.ws-refresh.test.tsx` 新增引用稳定性测试：websocket connected + buffer-sync 后，上述公开方法引用保持不变
  - `TerminalPage.render-isolation/render-scope/tab-isolation` 全部转绿，证明没破坏现有 shell/render 隔离

## 2026-05-04 daemon 握手兼容止血
- 现象：daemon health 正常、websocket transport 能创建后立刻关闭，但 `sessions.total/attached/ready` 始终为 0；客户端表现为“连不上 / handshake timeout”。
- 真因：最近把 attach correlation 从 `clientSessionId` 收口为 `openRequestId`，但已安装客户端仍按旧 wire 读取 `session-ticket/session-open-failed` 里的 `clientSessionId`；结果 transport 能到 daemon，但本地 open intent 匹配不上，attach 中断。
- 已收口：
  1. daemon `session-ticket` 回显 `openRequestId` 的同时继续兼容回显 `clientSessionId`
  2. daemon `session-open-failed` 同样兼容回显 `clientSessionId`
  3. client control-message matcher 优先按 `openRequestId`，兼容回退按 `clientSessionId`
- 冻结规则：
  - `openRequestId` 仍是新协议唯一 owner
  - `clientSessionId` 只允许留在 wire 兼容层做旧安装态恢复，不得重新进入 daemon token owner / attach owner 真相
- 当前验证：
  - `pnpm --dir android exec vitest run src/contexts/session-context-transport-runtime.test.ts src/server/terminal-message-runtime.test.ts`
  - 真实 ws smoke：旧握手可收到 `session-ticket{ openRequestId, clientSessionId, sessionTransportToken }`
  - `bash android/scripts/zterm-daemon.sh restart`
  - `curl http://127.0.0.1:3333/health` 正常


- 2026-05-04 当前闭环：先钉死 active-tick / active-reentry / liveSessionIds 对同一 session 的重复 head 调度；若红灯失败，只在 SessionContext 调度唯一 owner 处修。

- 2026-05-04 继续收卡顿：已物理删除 TerminalStageShell 对 livePaneSessionIds 的无效依赖；live set 变化不再白白打穿 terminal shell 渲染。下一步查 TerminalView 自身 props/effect fanout。

[2026-05-04] Tab-switch lag hot-path closeout (client renderer)
- 已确认并先收掉一条明确客户端热路径：`TerminalView` 之前每次 render 都按 `for (dataOffset = 0; dataOffset < bufferLines.length; dataOffset++)` 全量扫描整段 buffer，再按 viewport 过滤；tab 多、buffer 长时，inactive/active 切换会反复付出 O(total-buffer-lines) 成本。
- 收口：`renderRows` 改为先根据 `renderStartOffset/renderEndOffset/leadingBlankRows` 直接算出可见 data offset 窗口，只遍历当前窗口 + overscan，不再全量扫描全部 `bufferLines`。
- 当前验证：`TerminalView.dynamic-refresh`、`TerminalPage.render-*`、`tab-isolation`、`App.dynamic-refresh`、`SessionContext.ws-refresh`、`tsc` 均绿。下一步继续真机构建验证切 tab 卡顿是否显著下降，并继续查 active flip 时是否仍有 effect fanout。

[2026-05-04] Tab-switch lag hot-path closeout (visible row cursor fanout)
- 已确认 `TerminalView` 第二条客户端热路径：`VisibleRow` 之前每行都接收同一个 `renderBuffer.cursor` 对象，光标/输入变化会让当前可见窗口所有行都参与 comparator 判定与重新渲染候选。
- 收口：`VisibleRow` 改为只接收本行 `cursorColumn`（命中行为列号，否则 -1），不再把整份 cursor 对象向下广播；这样 cursor 移动只影响命中行，避免整屏 row fanout。
- 验证：`TerminalView.theme` / `TerminalView.dynamic-refresh` / `TerminalPage.render-scope` / `App.dynamic-refresh` / `SessionContext.ws-refresh` / `tsc` 全绿。

[2026-05-04] Tab-switch lag hot-path closeout (buffer-head no-op render wakeup)
- 已确认 `session-context-buffer-runtime` 存在一条真实白唤醒：`handleBufferHeadRuntime()` 里即使 `sessionHeadStore.setHead(...)` 返回 false（head 未变化）且 cursor 未变化，仍然无条件 `scheduleSessionRenderCommit(sessionId)`。
- 收口：只在 `headChanged === true` 时才因 head 变化触发 render commit；cursor/本地 buffer 变化仍走各自已有 commit 路径。
- 验证：新增 red test 钉死“重复相同 buffer-head 不应 schedule render commit”；`session-context-buffer-runtime` / `SessionContext.ws-refresh` / `TerminalView.dynamic-refresh` / `App.dynamic-refresh` / `tsc` 全绿。

[2026-05-04] TerminalView resize observer lifecycle closeout
- 现象：`TerminalView.dynamic-refresh` 新增红灯在整组回归里失败；observer 数量仍是 1，但实例 identity 改变，说明 viewport 更新后 observer 被重建。
- 真因：`ResizeObserver` effect 依赖 `runViewportRefresh -> syncViewport`，而 `syncViewport` 又依赖 `viewportRows / viewportClientHeightPx` 等自更新状态；observer tick 改 state 后 effect cleanup + recreate。
- 收口：新增 `runViewportRefreshRef`，observer effect 改成只在 host mount 时绑定；回调通过 ref 调最新 viewport refresh，切断 observer 生命周期与 viewport state 自变的耦合。
- 验证：
  - `pnpm --dir android exec vitest run src/components/TerminalView.dynamic-refresh.test.tsx src/contexts/session-context-buffer-runtime.test.ts src/App.dynamic-refresh.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx --reporter dot`
  - 4 files passed / 206 tests passed

## 2026-05-04 OPEN_TABS 冷恢复 remap 真源收口
- 现象：persisted tabs 冷恢复时，如果 `createSession()` 复用了已有 runtime session 并返回了新的 sessionId，`App.tsx` 之前只会修正 **active tab** 的 persisted `sessionId`；其余非 active tabs 仍残留 stale id。
- 后果：
  - 后续关闭/切换/恢复时会拿 stale sessionId 继续参与持久化与 focus 决策
  - 用户表现为“已经关闭的 tab 下次又回来”或“tab/session 对不上”
- 已修改：
  - 冷恢复阶段改为收集 `oldSessionId -> restoredSessionId` 全量 remap
  - 若任一 persisted tab 被 remap，则 **整份 OPEN_TABS** 一次性重写
  - active tab 只是在这份全量 remap 后再决定 switch，不再单独补丁式改 active 一条
- 冻结规则：
  - OPEN_TABS 持久化是真正唯一 owner
  - runtime restore 只允许产出一份完整 remap 结果回写
  - 禁止“只修 active tab，其余 tabs 留脏 sessionId”
- 当前验证：
  - `pnpm --dir android exec vitest run src/App.dynamic-refresh.test.tsx`
  - 新增回归：`rewrites all restored persisted tab session ids when cold restore remaps stale ids, not only the active tab`
  - 结果：`42 tests passed`
