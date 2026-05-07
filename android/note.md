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
- 2026-05-03 当前继续收口：`ACTIVE_PAGE.kind=terminal` 只允许作为 terminal page 投影，不允许独立漂移成第二份 active 真相；terminal 页的 tab 焦点统一收敛到 `ACTIVE_SESSION`。

## 2026-05-03 active/page focus truth matrix closeout
- 已补测试钉死：`ACTIVE_SESSION` 是 active tab 唯一真源，`ACTIVE_PAGE` 只表达 terminal 页面是否可见。
- 已验证 3 条关键链路都一致：saved-tabs import、下一次冷恢复 restore、foreground resume；三者都只允许 `ACTIVE_SESSION` 驱动 tab 焦点。
- 当前实现无需新增写口；App 层继续只允许通过 `persistExplicitOpenTabs(...)` / `persistAndSwitchExplicitOpenTabs(...)` 落盘 active/open-tabs，页面层只负责 terminal page 可见性。

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
  - route restore 只做 `ensureTerminalPageVisible()`
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

[2026-05-04] P1 第十刀（进行中）
- 目标：继续缩 `TerminalView.tsx`，收口 DOM input pipeline；保持协议/行为不变，只把 composition / flush / beforeinput / keydown 动作名字化，effect 只保留 listener mount/unmount。
- 原因：当前 input effect 同时混合 composing 状态、flush 定时器、特键映射、focus 回贴，属于 renderer 内剩余最厚的重复语义块之一。
- 成功标准：`TerminalView` 输入链路只有单一 helper 入口；现有 terminal 定向回归保持全绿。

[2026-05-05] P1 下一刀（进行中）
- 目标：继续缩 `TerminalView.tsx`，收口 follow scroll sync；把 target 计算、programmatic scroll mark、settled state commit 从 `syncScrollHostToRenderBottom` 中拆出，保持行为不变。
- 成功标准：follow scroll sync 只有单一 orchestration；现有 terminal 定向回归保持全绿。

[2026-05-05] P1 再下一刀（进行中）
- 目标：继续缩 `TerminalView.tsx`，收口 `handleFollowModeScrollGuards`；把 layout-change / pending-follow / ignored-programmatic-scroll 三类 guard 动作名字化，保持行为不变。
- 成功标准：follow scroll guard 只剩 orchestration；现有 terminal 定向回归保持全绿。

[2026-05-05] P1 再下一刀（进行中）
- 目标：继续缩 `TerminalView.tsx`，收口 `alignRenderBottomToFollow` 周边 trigger；把 follow reset / viewport refresh 的判定逻辑从 component effect 中下沉成独立 helper，保持行为不变。
- 成功标准：follow trigger effect 只做 trigger bridge；现有 terminal 定向回归保持全绿。

[2026-05-05] P1 再下一刀（进行中）
- 目标：继续缩 `TerminalView.tsx`，收口 session switch init/reset effect；把 session 切换时的 reading/follow/renderBottom/reset-reported-viewport 重置动作下沉成单一 helper，保持行为不变。
- 成功标准：session switch effect 只做 trigger bridge；现有 terminal 定向回归保持全绿。

[2026-05-05] 架构违规 closeout 第一刀
- 已确认并收口两处明确违规：
  1. `remote-screenshot-runtime.ts` 的 chunk decode 失败不再允许“caller can still use concatenated base64”式 fallback；现在直接显式抛错。
  2. `TerminalPage.tsx -> persistRemoteScreenshotCapture()` 的 `Filesystem.mkdir(...)` 不再空吞；仅对“目录已存在”类错误放行，其余显式失败。
- 验证：
  - `src/lib/remote-screenshot-runtime.test.ts`
  - `src/pages/TerminalPage.remote-screenshot.test.tsx`
  - `tsc --noEmit`
  全部转绿。

[2026-05-05] 颜色链路新证据
- 直接用 `WasmBridge` 验证：
  - `48;5;22` / `48;5;52` 背景色解析正常
  - `48:5:22` / `48:5:52` 原样喂给 parser 时背景色丢失（退回 256 sentinel）
- 当前 `mirror-line-canonicalizer.ts` 只针对 colon-style `38/48/58` + `mode=2|5` 做了分隔符归一化，但现场仍需继续确认 tmux capture 实际串是否落在这条 normalize 漏网边界。
- 下一步：补红测锁定 colon-style 256 background capture 串的规范化边界，再修 parser normalize。

[2026-05-05] 架构违规 closeout 第二刀：客户端 terminal-buffer 第二真源已物理收口
- 已确认客户端之前同时存在两份 terminal buffer / compact decode 真源：
  1. `android/src/lib/terminal-buffer.ts`
  2. `packages/shared/src/connection/terminal-buffer.ts`
- 违规点：Android 本地实现还直接从 `../server/buffer-sync-contract` 拿 compact decode，导致 client buffer 链路与 shared 真源分叉，颜色/compact wire 问题无法保证唯一实现。
- 收口：
  - `android/src/lib/terminal-buffer.ts` 改为纯 re-export thin wrapper，全部转发到 `@zterm/shared/terminal-buffer`
  - `android/src/lib/terminal-buffer-replay.ts` 同样改为纯 re-export
- 验证：
  - `src/lib/terminal-buffer.test.ts`
  - `src/contexts/session-context-buffer-runtime.test.ts`
  - `src/contexts/SessionContext.ws-refresh.test.tsx`
  - `src/components/TerminalView.dynamic-refresh.test.tsx`
  - `tsc --noEmit`
  全绿。

## 2026-05-05 open-tab 真源排查
- 现象：关闭 tab 后仍会恢复，且会出现重复 tab。
- 初判：`upsertOpenTabIntentSession()` 只按 sessionId 去重，未按 persisted reuseKey 语义替换旧 tab，违背 open-tab 唯一真源。
- 计划：先补红测锁定 reuseKey duplicate / close-reopen 场景，再只改纯函数层，最后跑最小回归。

- 新证据：Android/WebView 下 `color-mix(...)` 是 block/shade 背景发灰的重要风险点；已改为 JS 直接混色并输出固定 `rgb(...)`，避免浏览器 CSS 特性差异。


[2026-05-05] App active-tab 正文真源收口
- 现象：tab strip / ACTIVE_SESSION 已指向新 tab，但正文仍可能继续显示 runtime 旧 active session 的 buffer，导致“active tab 和正文串线”。
- 根因：`App.tsx` 之前把 persisted open-tab active 永久放在 runtime active 前面，能修恢复期串线，但会打坏运行期 active 切换；同时 `deriveRuntimeOpenTabSyncDecision()` 在 restore 之后仍会持续把 runtime active 反向改回 persisted active。
- 收口：
  1. `App.tsx` 新增 `pendingTerminalActiveSwitch`，只在 restore / 显式切 tab / draft 触发切 tab 的短窗口里允许正文临时优先 pending target。
  2. runtime `state.activeSessionId` 一旦追平，或 runtime 已经切到别的 tab，立即清掉 pending gate，运行期正文重新只跟 runtime active。
  3. `open-tab-intent.ts` 新冻结：`restoredTabsHandled=true` 后，不再产出 `switch` 强推 persisted active；若 runtime active 已变化且仍在 OPEN_TABS 内，则把 persisted active merge 改写到 runtime active。
- 验证：
  - `pnpm --dir android exec vitest run src/lib/open-tab-intent.test.ts src/App.dynamic-refresh.test.tsx src/App.first-paint.test.tsx --reporter verbose`
  - 关键门禁：
    - `follows state activeSession switch even when stale getter still points to previous session`
    - `renders the persisted open-tab active session as terminal body truth even when runtime active session still points to another tab`
    - `keeps the normalized persisted active tab truth and rewrites runtime active session to match it when runtime sessions already exist`

[2026-05-05] TerminalView block/shade dim 背景灰化根因
- 现象：tmux 里红/绿块状背景在 Android 上仍可能发灰，尤其是 block/shade glyph + dim 场景。
- 根因：`TerminalView.cellStyle()` 在 block/shade glyph 路径里把 `renderedForeground`（dim 后前景）传给 `buildBlockBackground()`；这会把本应保持原始红/绿 truth 的填充背景一起洗灰。
- 修复：block/shade glyph 的背景填充改回使用 `colors.fg` 原始前景真相；dim 只作用于普通文本前景，不再改写 block/shade 背景 truth。shared `packages/shared/src/react/terminal-view.tsx` 同步收口，避免第二实现。
- 验证：
  - `pnpm --dir android exec vitest run src/components/TerminalView.theme.test.tsx src/server/mirror-line-canonicalizer.test.ts src/lib/open-tab-intent.test.ts src/App.dynamic-refresh.test.tsx src/App.first-paint.test.tsx --reporter verbose`
  - 新增门禁：`keeps dimmed block and shade glyph backgrounds on the original red/green truth instead of mixing them to gray`

[2026-05-05] TerminalView blank-until-touch closeout:
- 现象：refresh / relayout / tail refresh 后偶发进入空白帧，用户 touch/scroll 一次才恢复。
- 真因：renderer follow 链路已更新 render rows，但 DOM scrollTop 偶发停在超过真实 DOM bottom 的 overscrolled blank frame；原恢复链路部分依赖后续 scroll/touch 事件触发 guard。
- 修复：`TerminalView.tsx` 新增 layout-phase follow 自修复；在 follow 态提交后若检测到 `scrollTop > scrollHeight - clientHeight` 或仍有 `pendingFollowViewportRealign`，立即 `syncScrollHostToRenderBottom(...)`，不再等待用户交互。
- 新 gate：`repairs an overscrolled follow frame on refresh without waiting for a user touch event`。


[2026-05-05] Mac remote screenshot sign/TCC reality check
- Android remote-screenshot UI/runtime race 已收口；TerminalView follow/reading 空白花屏相关门禁已绿。
- Mac helper 已从 daemon 直截屏收口为 GUI helper 唯一执行主体，并进一步把 helper 截图真相改为 `screencapture`，不再依赖 `desktopCapturer` 作为截图执行路径。
- 实测结论：
  1. `/Applications/ZTerm.app` 在 electron-builder 未拿到正式可用 identity 时只能生成 adhoc 包；
  2. 手工 `codesign --force --deep --sign - /Applications/ZTerm.app` 后可恢复 `Identifier=com.zterm.mac` 的干净 adhoc 包；
  3. TCC reset 后 `kTCCServiceScreenCapture/com.zterm.mac` 记录可被清空；
  4. 但无论 LaunchAgent 还是 direct helper，helper 内执行 `/usr/sbin/screencapture -x ...` 都返回 `could not create image from display`；
  5. 本地自造 code-sign cert 虽能 import，但 `security find-identity -p codesigning` 仍是 0 valid identities，说明当前机器不存在可用于稳定签名/TCC 闭环的有效 code-sign identity。
- 冻结结论：当前 Mac 截图剩余 blocker 是 **安装态签名/TCC 身份链**，不是 daemon/helper 业务逻辑；继续改业务代码不能闭环。

- 追加验证：已用临时 keychain + 本地自签 `ZTerm Local Code Signing` 成功给 `/Applications/ZTerm.app` 做完整 `codesign --force --deep`，并通过 `codesign --verify --deep --strict`。
- 追加验证：helper 增加最小可见窗口后，仍然无法触发 `kTCCServiceScreenCapture/com.zterm.mac` 新记录；`tccutil reset ScreenCapture com.zterm.mac` 后数据库保持空，helper 内 `screencapture` 仍返回 `could not create image from display`。
- 冻结结论更新：剩余 blocker 不仅是“业务代码/无签名”，而是 **当前机器上的自签 app identity 仍不足以进入 macOS Screen Recording 可授权链**；后续必须接正式可授权签名身份或采用系统级已授权宿主执行截图。
- Jason 2026-05-05 tab restore 新审计:
  - 长按 tab 当前仍带 double-tap rename / long-press menu 旧语义，owner 在 `TerminalHeader.tsx`；本轮收口为“tab 不再触发编辑/重命名菜单”，pane move 若保留只走 split pane menu。
  - persisted tab 仍可能在 cold restore 时直接 `createSession(...)` 复活；缺少“restore 前确认远端 tmux session 仍存在”的唯一门禁。
  - 修复方向: 1) `TerminalHeader` 删除 rename/edit 手势；2) 新增 restore 过滤 helper，按 bridge target 拉 tmux session 列表，过滤不存在 session 后再 restore，并把过滤结果回写 `OPEN_TABS/ACTIVE_SESSION`。

[2026-05-05] build / shared import pollution / open-tab truth closeout
- 已确认本轮 `build:android` 阻塞真因是 **Node close-loop 脚本被 shared 根入口的前端 export 污染**，不是 daemon 业务逻辑：
  - `packages/shared/src/index.ts` 之前 re-export `./react/terminal-view`
  - `react/terminal-view.tsx` 会 import `@jsonstudio/wtermmod-react/css`
  - server/script 侧一旦 import `@zterm/shared` 根入口，`tsx` Node 环境会被 `.css` 直接打死
- 本轮已收口：
  1. `packages/shared/src/index.ts` 删除 `react/terminal-view` 根 re-export
  2. `android/src/lib/types.ts` / `src/server/mirror-line-canonicalizer.ts` 改走 shared 子路径真源
  3. `daemon-mirror-close-loop` 实跑通过，`build:android` 已重新打通
- 当前 open-tab/session 持久化审计结论：
  - `OPEN_TABS / ACTIVE_SESSION` 的生产写口已收口为：
    - 底层：`persistOpenTabsState()`
    - App 编排：`persistExplicitOpenTabs()` / `persistAndSwitchExplicitOpenTabs()`
  - 生产代码没有第二处直接写 `OPEN_TABS / ACTIVE_SESSION`
  - `ACTIVE_PAGE` 只表达页面，不是第二 active 真源
- Header 交互进一步物理收口：
  - `TerminalHeader` 上已删除废弃的 `onRenameSession` 第二入口
  - header 现在只负责：`switch / close / split pane menu`
  - tab rename 真源只剩 `TabManagerSheet`

[2026-05-05] 局部重复/先错后正继续定位
- 已排除 render gate 同步直刷；当前 gate 已变为 next-frame merge flush，不再是实时直刷。
- Android TerminalView 当前按 absoluteIndex 做 row key，renderRows 直接来自 renderBuffer snapshot；若出现局部重复，更可能是 buffer snapshot 中间态已重复，或 follow/scroll pre-paint 对齐仍有单帧错位。
- 下一步：先补 shared terminal-buffer + ws-refresh 链路的“局部重复中间态”回归，优先证伪/证实 merge 层；若测试无法复现，再回到 Android TerminalView 的 pre-paint scroll/padding 协调做单点实验。

[2026-05-05] daemon mirror continuity 真源重做
- 按 Jason 要求停止继续在 continuity overlap 上补条件，改为一次性收口：mirror absolute window 只认 tmux authoritative start/end。
- 已物理删除 `resolveContinuousMirrorCaptureWindow()` 的内容重叠推断语义；当前改为 `resolveAuthoritativeMirrorCaptureWindow()`，直接使用 `computedStartIndex + canonicalized nextLines` 写 mirror store。
- 新冻结：重复文本/overlap 只允许作为 debug 线索，不得参与 daemon mirror 写侧真相。否则会把旧 prefix 错绑到新的 absolute index，表现成局部重复/先错后正。

[2026-05-05] daemon mirror stable publish freeze
- 为解决“短暂错帧再恢复”，mirror writer 进一步收口为 **连续一致才发布**：
  - 单次 tmux capture canonical snapshot 若与当前 mirror 已一致，可直接接受；
  - 否则必须继续 capture，直到连续两次 canonical snapshot 一致，才允许写入 mirror store；
  - 上限内始终不稳定则显式报错，禁止把半刷新帧直接发布给 client。
- 本轮验证：
  - `src/server/terminal-mirror-capture.test.ts` 新增 3 条稳定帧门禁
  - `pnpm --dir android run daemon:mirror:close-loop` 继续全绿（codex/top/vim/重连/schedule）
  - `TerminalView.dynamic-refresh` / `SessionContext.ws-refresh` / `test:terminal:contracts` 全绿
- Jason 2026-05-06 新冻结: tab/session 语义身份必须只认 `daemon identity + tmux sessionName`；WS/RTC/Tailscale/TURN 只是 transport path，不得进入 tab/session 复用真源。连接页/新建 tab 流程改为 daemon-first：先选在线 daemon，再列该 daemon 下的 tmux sessions。
- Jason 2026-05-06 新收口:
  - `ACTIVE_PAGE` 不再承载任何 tab/session 焦点字段；页面只表达 page kind。
  - saved-tab import / restore 里原 `focusSessionId` 语义也统一收口为 `activeSessionId`，避免页面焦点和 tab 焦点再长第二套语言。
  - App 层新建/复活 tab 的 owner 也已审清：只允许 `useOpenTabRestoreRuntimeSync`（冷恢复）与 `useSessionOpenActions`（用户显式打开/导入 saved tab list）两处调用 `createSession(...)`；`sessionGroups / sessionHistory / ConnectionsPage` 仅提供候选视图，不得自动开 tab。
- [2026-05-06] render gate 第三刀冻结：
  - `buffer-head` / cursor metadata 只更新 metadata / planner 输入
  - **正文 repaint 唯一触发源 = `buffer-sync apply`**
  - client `handleBufferHeadRuntime()` 不得再因 `headChanged/cursorChanged` 直接 `scheduleSessionRenderCommit`
  - 后续若 renderer 还需要实时消费 head/cursor，只能走 metadata truth，不能再借正文 render gate 偷跑

- 2026-05-06 审计更正：`liveSessionIds` 并非未接线；`TerminalPage -> onLiveSessionIdsChange -> App.setLiveSessionIds -> SessionContext` 已存在生产链路。当前 refresh 主问题更像是 active/live refresh plan 与 head/pull 节流链路耦合错误，而不是 pane live ids 根本没设置。
- 2026-05-06 当前主查方向：1) `buildActiveSessionRefreshPlan + ensureActiveSessionFreshRuntime` 是否让 OPEN 但无有效 buffer 进展的 session 长时间 skip；2) `lastHeadRequestAt / lastServerActivityAt` 是否把“已请求但未完成”误当成新鲜进展；3) open-tab 持久化是否还有 saved-tab/import/runtime merge 旁路把已关闭 tab 再写回。
[2026-05-07] dynamic cadence + daemon mirror live sync 部署验证
- 先完成文档/skill/代码边界核对；确认本轮改动集中在 client cadence + render gate + daemon mirror live sync，未引入新的 fallback 运行路径。
- 已跑变更相关自动测试：mobile-config / session-render-gate / terminal-mirror-runtime / terminal-runtime.detached-session / terminal-mirror-capture / terminal-message-runtime，共 32 tests passed。
- 下一步：重启单服务 `com.zterm.android.zterm-daemon`，验证 /health 与 /debug/runtime，确认 staging runtime 已切到最新代码。

- 2026-05-07 当前任务: 收口 remote session truth audit。目标: connect 成功 / picker refresh / foreground resume 三个入口都走 useOpenTabRuntime.auditOpenTabsAgainstRemoteSessions 单一 owner；session 列表 refresh 与 open-tab prune 共线，避免已关闭/不存在 session 被重新打开。

- 2026-05-07 继续审计: 目标是物理确认 open-tab/session 持久化与恢复的所有写口/恢复口，找出为何仍可能复活已关闭或不存在 session。重点检查 OPEN_TABS/ACTIVE_SESSION 写口、restore/bootstrap/runtime-merge、session group/saved tab 导入、远端 session list refresh。

[session-list-audit] pending fix: ConnectionsPage session row source should be history when sessionGroup row has no host; hosts must not create rows directly.

[session-list-audit] next: inspect SESSION_GROUPS / OPEN_TABS / host save-update / runtime merge for ghost session resurrection and duplicate server rows.

[session-list-audit] finding: sessionGroups are only pruned on picker refresh; foreground/connections-page truth can still resurrect stale saved sessions via local group history.

[session-list-audit] next: trace stale tab/session resurrection from recordSessionGroupOpen / recordSessionOpen / upsertHost / restore / runtime merge writeback.

[session-list-audit] next focus: audit recordSessionGroupOpen / recordSessionOpen / upsertHost persistence timing; distinguish explicit save vs temporary open.

[session-list-audit] next focus: audit HOSTS persistence truth; distinguish explicit saved connection vs temporary runtime-open host.
[2026-05-07] session-list-audit HOSTS truth closeout
- 已确认最后一条明显污染链：`useSessionOpenActions.openDraftAsSession()` 之前会无条件 `upsertHost(buildTransientHostFromDraft(...))`，导致“临时开 tab / restore saved tab / open group”都会永久写入 `HOSTS`。
- 本轮已物理切断：`openDraftAsSession()` 改为只构造 transient `sessionHost` 供 runtime session + OPEN_TABS 使用，不再写 `HOSTS`。
- 冻结语义：
  1. `HOSTS` 只允许由连接管理页显式保存/编辑 owner 写入；
  2. `SESSION_GROUPS` 只允许用户显式保存 selection；
  3. `OPEN_TABS` 只允许显式打开/restore/runtime merge 写入；
  4. 远端 tmux truth 继续作为 `OPEN_TABS + SESSION_GROUPS` prune 单一依据。
- 已跑回归：`useSessionOpenActions/useSessionHistoryStorage/ConnectionsPage/App.dynamic-refresh` 共 76 tests passed。
[2026-05-07] open-tab persistence audit closeout (current checkpoint)
- 生产代码中 `OPEN_TABS / ACTIVE_SESSION` 的物理真源目前已收口为一套：
  - 读取：`readPersistedOpenTabsState()` / `readPersistedActiveSessionId()`
  - 写入：`persistOpenTabsState()`，唯一由 `useOpenTabRuntime.persistExplicitOpenTabs()` 驱动
- 生产侧 session 创建也已确认只剩两处：
  1. `useSessionOpenActions.openDraftAsSession()` —— 用户显式打开
  2. `useOpenTabRestoreRuntimeSync()` —— persisted tab restore
- 已补回归：persisted tab restore **不依赖 HOSTS**；即使 `HOSTS` 不存在对应连接，只要 `OPEN_TABS` 有 truth，仍可正常恢复。
- 当前剩余重点不再是多处写口，而是继续盯 `restore/bootstrap/runtime-merge` 判定边界，确认没有 case 把已显式关闭 tab 重新并回 `OPEN_TABS`。
[2026-05-07] cold-start session-group prune closeout
- 新发现边界：此前 `SESSION_GROUPS` 的远端 truth prune 只会在 connect / foreground resume / picker refresh 触发；若冷启动进入 Connections 页且没有 open tabs/runtime sessions，stale group 仍可能先被看见。
- 本轮已收口到同一条 audit：`useOpenTabRuntime` mount 后若 `tabs=0 && sessions=0 && sessionGroups>0`，直接走已有 `auditOpenTabsAgainstRemoteSessions('connect')`；没有新开第二套 prune 逻辑。
- 已补回归：cold launch + sessionGroups only 会立刻按远端 tmux truth prune；foreground resume case 同时保持成立。
[2026-05-07] cold-start stale OPEN_TABS + SESSION_GROUPS boundary
- 又补到一层边界：若冷启动时本地同时残留 stale `OPEN_TABS` 与 stale `SESSION_GROUPS`，restore 可能先把 `OPEN_TABS` 清空；cold-start group audit 必须继续在清空后补跑，不能因为初始 boot 时 `openTabStateRef.current.tabs.length > 0` 而永久错过。
- 已修正：cold-start group audit 的门禁改看实时 `openTabState.tabs.length`，而不是初始 ref 快照；这样 remote restore 清空 stale tabs 后，同一 effect 仍会继续对残留 groups 做远端 truth prune。
- 已补回归：`stale OPEN_TABS -> restore clears -> stale SESSION_GROUPS still pruned`。

[2026-05-07] session-list audit continue
- tombstone 冷启动回归已转绿：`persists closed semantic reuse tombstones so a closed duplicate tab still stays dead after cold launch`。
- 下一步继续审 `restore / bootstrap / runtime-merge / session list` 是否仍有复活旧 tab/session/server 的旁路写口，重点检查 OPEN_TABS / ACTIVE_SESSION / SESSION_GROUPS / HOSTS 的单一 owner 是否被绕开。

[2026-05-07] connections projection owner next slice
- 发现 `ConnectionsPage` 仍在页面层直接混合 `hosts + sessionGroups + liveSessions` 组装 `serverGroups`，这使页面层继续承担 session/server 列表投影 owner。
- 下一步：抽成独立 projection helper（唯一列表投影真源），页面只消费投影；不改持久化语义，只收口 owner。

[2026-05-07] sessionHistory dead-truth audit
- 现状只读确认中：`sessionHistory / recordSessionOpen / SESSION_HISTORY` 看起来已无任何生产消费方，只剩 open 时写入。
- 若确认生产侧没有读取 owner，将物理删除这套死语义，避免继续保留第二真源和无用持久化。

[2026-05-07] sessionHistory physical removal closeout
- 已确认 `sessionHistory / recordSessionOpen / SESSION_HISTORY` 是只写不读的死语义。
- 本轮已物理删除生产实现、类型与测试 mock；`useSessionHistoryStorage` 现在只承载 `SESSION_GROUPS`。
- 回归：`session-history/open-actions/connections/app-first-paint/dynamic-refresh/android-ime` 共 90 tests passed。

[2026-05-07] picker target truth audit
- 确认存在重复 owner：`TmuxSessionPickerSheet` 本地 `normalizeTarget / resolveRelayDeviceBridgeTarget` 与 `session-picker.ts` / `ConnectionPropertiesPage` 的 daemon-first target 映射语义重复。
- 下一步：把 target normalize + relay-device -> bridge target 映射统一抽回 `session-picker.ts`，picker / connection-properties 共用，消除第二实现。

[2026-05-07] picker target truth closeout
- 已把 `relay-device -> bridge target` 映射统一收口到 `session-picker.ts -> resolveRelayDeviceBridgeTarget()`。
- `TmuxSessionPickerSheet` 删除本地重复实现；`ConnectionPropertiesPage` 改为共用同一 helper。
- 回归：`session-picker / connection-properties / open-actions / connections` 共 26 tests passed。

[2026-05-07] remembered-server display projection closeout
- 已把 bridge preset 的排序 + daemon/bridge/target/auth 展示投影统一抽到 `bridge-server-presets-view.ts`。
- `RememberedServersSection / TmuxSessionPickerSheet / ConnectionPropertiesPage` 改为共用，不再三处各自拼装显示语义。
- 回归：`bridge-server-presets-view / bridge-settings / session-picker / connection-properties / connections` 共 35 tests passed。

[2026-05-07] sortedHosts leakage closeout
- 已确认 `sortedHosts` 原先从 `useSessionOpenActions` 泄漏到 `ConnectionsPage`，把 picker target 排序状态错误带入了连接页。
- 本轮已切断：`ConnectionsPage` 改回消费原始 `hosts` 真相；`sortedHosts` 只保留在 picker 私有范围。
- 回归：`connections / open-actions / dynamic-refresh / connection-properties` 共 82 tests passed。

[2026-05-07] resurrect-risk final sweep
- 当前继续审 `close -> tombstone -> restore remap -> runtime merge` 的未覆盖分支，目标是找出仍可能让已关闭/已不存在 tab 复活的极端边界。
- 优先策略：先查单测空洞，再补红测，再只在唯一 owner 处修。
[2026-05-07] resurrect-risk audit continue
- 已复核 `OPEN_TABS/ACTIVE_SESSION` 生产写口：仍只见 `useOpenTabRuntime.persistExplicitOpenTabs() -> persistOpenTabsState()`；页面层/Connections/picker 没发现新的直接写口。
- 已复核 close owner：`handleCloseSession` / `SESSION_STATUS_EVENT(closed)` / remote audit prune 三条入口最终都收口到 `applyClosedOpenTabIntent()`。
- 当前继续怀疑的边界不是“多处写口”，而是 `close -> tombstone -> 用户显式 reopen / restore remap / runtime merge` 的顺序交错；尤其要确认显式 reopen 时是否会清掉旧的 closed session id / reuse key，避免 reopen 后仍被 runtime merge 或 cold restore 异常压制/改写。
- 下一步：直接补红测覆盖 explicit reopen after close / same sessionId reopen / semantic duplicate reopen；若红，再只改唯一 owner（优先 `useSessionOpenActions` / `useOpenTabRuntime`）。
[2026-05-07] resurrect-risk fix #1 confirmed
- 真实问题确认：`useSessionOpenActions.openDraftAsSession()` 在显式 reopen 时只从内存删除 `closedOpenTabReuseKeysRef`，但没有把 tombstone 删除结果持久化回 `zterm:closed-tab-reuse-keys`。
- 后果：当前会话里 reopen 看起来正常，但冷启动后 storage 里旧 tombstone 还在，runtime merge / cold launch 仍会把这个语义 tab 当成“已关闭”，形成 reopen 后再次被压死的边界。
- 修复：在唯一 reopen owner `openDraftAsSession()` 内，当显式 reopen 删除 reuse key 成功时，立即 `persistClosedTabReuseKeys(...)` 回写。
- 验证：
  - `useSessionOpenActions.test.tsx` 新增 `persists reopened semantic tab tombstone removal so cold launch no longer keeps it dead`
  - 回归 1：`open-tab-intent/open-tab-restore/useSessionOpenActions/App.dynamic-refresh` => 95 passed
  - 回归 2：`open-tab-persistence/App.first-paint/App.first-paint.real-terminal/ConnectionsPage` => 22 passed
[2026-05-07] resurrect-risk fix #2 confirmed
- 继续沿同一 reopen 语义补到 saved-tab import 链：saved-tab import 本质上也是显式 reopen，必须共用 `openDraftAsSession()` 去清内存 + 持久化 tombstone。
- 已补验证：
  1. `useSessionOpenActions.test.tsx`：saved tab import 显式 reopen 同样会清掉 `zterm:closed-tab-reuse-keys`
  2. `App.dynamic-refresh.test.tsx`：daemon-owned saved tab import 清 tombstone 后，下一次 cold launch 仍能正常 restore，不会再次被“已关闭”压死
- 回归：`App.dynamic-refresh + useSessionOpenActions` => 71 passed。
- 当前阶段未再发现新的生产写口；下一步继续只读扫 `restore remap / runtime merge / remote prune later reappear` 是否还有未覆盖交错。
[2026-05-07] resurrect-risk next suspect
- 当前新怀疑点：close / reopen 的 tombstone 只处理单个 reuse key，但语义 identity 本身支持 daemon owner + bridge owner 两种 variant。若关闭时只落 daemon key，后续 bridge-only runtime / restore 仍可能绕过；反之亦然。
- 计划：把 close / reopen 两侧都改成 variants 全收口，并补纯函数 + hook 回归，仍只改唯一 owner。
[2026-05-07] resurrect-risk fix #3 confirmed
- 真问题确认：之前 close / reopen 只处理单个 reuse key，但 session 语义 owner 实际支持 daemon-owned 与 bridge-owned variants。若只写/删单 key，另一种 shape 仍可能漏掉，导致 close 后 later reappear 或 reopen 后 cold restore 被另一条 variant 干扰。
- 本轮收口：
  1. `deriveCloseOpenTabIntent()` 现在同时产出 `closedReuseKeyVariants`
  2. `useOpenTabRuntime.applyClosedOpenTabIntent()` 关闭时把全部 variants 一次写入 tombstone storage
  3. `useSessionOpenActions.openDraftAsSession()` reopen 时删除全部 variants，再持久化回写
- 新回归：
  - `open-tab-intent.test.ts` 新增 daemon-owned close variants 断言
  - `useSessionOpenActions.test.tsx` 新增 reopen clears all semantic reuse-key variants
- 回归：`open-tab-intent / open-tab-restore / useSessionOpenActions / App.dynamic-refresh` => 99 passed。
[2026-05-07] resurrect-risk daemon->bridge prune regression covered
- 新补集成回归：daemon-owned tab 被 remote audit prune 后，bridge-only semantic duplicate later reappear 也必须保持 hidden。
- 结果已绿：说明上一轮 tombstone variants 收口不只是纸面正确，确实覆盖 daemon->bridge cross-shape later reappear。
- 下一步继续只读审 restore remap 是否还有 cross-shape / remap 顺序空洞。
[2026-05-07] resurrect-risk likely real bug
- `deriveCloseOpenTabIntent()` 当前 `closedReuseKeySource = targetTab || targetSession`，意味着若 persisted tab 还是 bridge-only，但当前 runtime reused session 已经带 daemonHostId，则 close variants 可能只来自旧 tab，漏掉 daemon variant。
- 后果：关闭这种“bridge persisted -> daemon runtime”语义 tab 后，daemon-owned later reappear 仍可能绕过 tombstone。
- 处理策略：只改 pure owner `deriveCloseOpenTabIntent()`，把 targetTab + targetSession 的 reuse-key variants 做 union；再补单测。
[2026-05-07] restore-remap cross-shape checkpoint
- 新补集成回归：daemon-owned persisted tab 在 cold restore 时，如果 `createSession(sessionId=stale)` 最终复用成 bridge-only live session id，也必须正确 remap OPEN_TABS/ACTIVE_SESSION 并 switch 到新 id。
- 结果已绿：说明当前 `resolveHostForPersistedOpenTab + createSession remap + resolveRestoredOpenTabIntentState` 这一段至少对 daemon->bridge reused-live-id 场景没有空洞。
- 当前剩余重点继续压缩到更细的顺序交错：restore remap 后若同轮又进 runtime merge / connect audit，是否还有 race 会把 remap 后的 truth 改回旧值。
[2026-05-07] restore-remap -> runtime-connect race checkpoint
- 新补集成回归：cold restore 把 daemon-owned stale tab remap 到 live bridge session id 后，若下一拍 runtime session 立刻以 `connected` 进入，且 runtime active 仍短暂挂着旧 stale id，也不能把 `OPEN_TABS / ACTIVE_SESSION` 改回旧值。
- 结果已绿：`useOpenTabRestoreRuntimeSync` 当前 remap 持久化 + 后续 `deriveRuntimeOpenTabSyncDecision` / connect audit 的顺序，在这条最危险交错上没有发现回魂旧 id 的问题。
- 下一步继续只读查是否还有别的生产入口直接按旧 `sessionId` 落盘/切 active；若没有，这块可以暂时从“修代码”降级为“继续补边界回归”。


[2026-05-07] open-tab/session truth audit checkpoint #2
- 已全仓复核 `OPEN_TABS / ACTIVE_SESSION` 物理写口：生产代码仍只看到 `useOpenTabRuntime.persistExplicitOpenTabs() -> persistOpenTabsState()` 一条；`persistActiveSessionId()` 没有新的旁路调用。
- 已全仓复核 client 侧 direct session owner：`createSession` 只剩 `useSessionOpenActions.openDraftAsSession()` 与 `useOpenTabRestoreRuntimeSync()`；`switchSession` 只剩 `requestRuntimeActiveSessionSwitch()` 这条 open-tab 编排出口；`closeSession` 只剩 `applyClosedOpenTabIntent(... closeRuntimeSession=true)` 收口。
- 新确认：`handleLoadSavedTabList()` 虽然内部逐个 `openDraftAsSession()`，但最终仍由 `persistAndSwitchExplicitOpenTabs(openedTabs, activeSessionId)` 用 batch truth 覆盖收口；当前未发现新的 saved-tab import 第二写口。
- 当前更像剩余风险的不是 OPEN_TABS/ACTIVE_SESSION 第二写口，而是 `SESSION_GROUPS` 的远端 prune 触发时机与 remote fetch 失败/漏触发窗口：它不会直接写 OPEN_TABS，但可能造成“Connections 页面里旧 group/server 又出现”的感知问题。
- 下一步：继续把“用户感知的旧 tab/session/server 回来”拆成两个维度分别钉死：
  1. terminal open tabs/active truth（当前基本收口）
  2. connections page server/session-group projection truth（继续查 prune 触发边界）
[2026-05-07] connections projection stale-endpoint fix
- 新打到纯函数红测：同一 `daemonHostId` 下，若 `hosts` 里残留旧 bridge endpoint，而较新的 `SESSION_GROUPS`/live truth 已经切到新 endpoint，`buildConnectionsServerGroups()` 之前会继续保留旧 `bridgeHost/bridgePort`，导致 Connections 卡片点开仍走旧地址，用户感知成“旧 server 又回来了”。
- 已只在投影 owner `connections-server-groups.ts` 修复：daemon-owned group 在 merge 后必须允许较新的 daemon endpoint 覆盖旧 host endpoint；不改 OPEN_TABS/ACTIVE_SESSION 持久化语义。
- 新回归：
  1. `connections-server-groups.test.ts`：daemon owner 优先新 session-group endpoint
  2. `ConnectionsPage.test.tsx`：点击 Open 时实际传给 `onOpenServerGroups` 的 target 必须是新 endpoint，不是旧 host endpoint
[2026-05-07] connections projection stale-auth fix
- 继续打到同类真 bug：即使 daemon-owned card 已经改成新 endpoint，`authToken` 之前仍会沿用 stale host token，导致点开同一张 server card 实际还拿旧 token 连接。
- 已继续只在同一投影 owner `connections-server-groups.ts` 修复：daemon-owned merge 时，`authToken` 与 `bridgeHost/bridgePort` 一样，必须允许更新鲜的 daemon truth 覆盖 stale host truth。
- 新回归：
  1. `connections-server-groups.test.ts`：daemon owner 优先新 auth token
  2. `ConnectionsPage.test.tsx`：点击 Open 时传出的 `authToken` 必须是新 token，不是旧 host token
[2026-05-07] connections projection daemon-id upgrade fix
- 又打到一条更根的真 bug：bridge-only group 一旦后来被 daemon truth 合并，`buildConnectionsServerGroups()` 之前虽然会补上 `daemonHostId`，但 `group.id` 仍停留在旧 bridge key，导致 daemon-first owner 没完全升级。
- 风险：后续 expanded state / selectedSessionsByGroup / 事件路由 仍可能挂在旧 bridge id 上，给 UI 层留下“同一张卡其实还是旧对象”的隐患。
- 已只在同一投影 owner 修复：当 daemon truth 到来且命中已有 bridge group 时，立即把 `group.id` 升级成 daemon key，并同步重写该 group 下所有 `session entry.id`。
- 新回归：`connections-server-groups.test.ts` 钉死 bridge->daemon 合并后 group id 必须升级成 daemon key。
[2026-05-07] connections projection row-host target match fix
- 继续打到 row 级真 bug：同一 daemon owner + 同一 sessionName 下，如果 `hosts` 里同时残留 stale/fresh 两个 saved host，旧实现只按 `pinned/lastConnected` 选 `entry.host`，不看当前 group 已经收口后的 daemon target，结果会把 stale host 留给行级 `Edit/Del` 与名称展示。
- 已只在 `connections-server-groups.ts` 收口：saved host 候选优先级现在先看“是否匹配当前 group 的 daemonHostId + bridgeHost/bridgePort + authToken 真相”，匹配者优先；只有同样匹配/同样不匹配时才退回 pinned/lastConnected。
- 新回归：
  1. `connections-server-groups.test.ts`：row host 必须选 fresh matching host
  2. `ConnectionsPage.test.tsx`：行级 Edit 必须拿到 fresh host，而不是 stale host
[2026-05-07] connections projection row-host order invariance fix
- 又打到一条顺序型真 bug：即使 row-host 选择规则已经知道要优先匹配当前 group 真相，但若 `hosts` 列表里 fresh host 先出现、stale host 后出现，早期 `hostsBySessionName` 仍可能先被 stale winner 污染；后续 group target 修正后，row entry 继续抱着 stale host。
- 最终收口方式：不要依赖中间 `hostsBySessionName` winner 作为唯一依据；在 `buildConnectionsServerGroups()` finalize 阶段，按最终 group 真相对每个 session row 从全部 `hosts` 重新筛选并选优一次，确保结果对 host 输入顺序不敏感。
- 新回归：`connections-server-groups.test.ts` 钉死“fresh host 先、stale host 后”时 row-host 仍必须稳定选择 fresh host。
[2026-05-07] connections page group-id remap fix
- 页面状态层又打到真 bug：当同一张 server card 从 bridge key 升级成 daemon key 后，`ConnectionsPage` 里的 `expandedGroupIds` / `selectedSessionsByGroup` 仍挂在旧 bridge id，导致已展开状态和已选 session 直接丢失。
- 本轮只在页面状态层修：基于 `sessionSemanticOwnersMatch()` 对上一帧与当前帧 `serverGroups` 做 owner 级 remap，把 expanded ids 与 selectedSessionsByGroup 从旧 bridge key 迁到新 daemon key；不改 projection owner，也不改持久化层。
- 新回归：`ConnectionsPage.test.tsx` 钉死 bridge->daemon 升级 rerender 后，展开态与 selection 不得丢失。

[2026-05-07] quick-tab first-open + Android halfwidth audit
- 现场目标：1) + 菜单首开 session 首次 connecting/RP=0；2) Android 输入默认半角英文标点
- 初步定位：
  1. quick-tab buildPreferredTarget 已带 active session auth/daemon truth，但 buildDraftFromTmuxSession 若命中 existing host，会直接复用 existing host 全量字段（含旧 transportMode / 旧 relay binding / 旧 endpoint），可能导致第一次 open 用的是 stale host truth，而 picker 当前 target truth 只用于 list-sessions，不用于 open。
  2. Android 实机主输入链可能并不走 TerminalView DOM textarea，而走 TerminalPage Android IME bridge；因此半角问题 owner 很可能在 Android IME payload 归一化，而不是 DOM textarea attrs。
- 下一步：继续读 Android IME bridge/runtime，补红测后只改唯一 owner。

[2026-05-07] close-tab stale current-tabs audit start
- Current Tabs 真源已确认: App.tsx openTabs <- terminalSessions <- openTabState.tabs。
- 当前怀疑不在 close pure function，而在 UI 关闭后 picker/current list 未按最新 openTabState 重投影，或 reopen/restore 路径把旧项补回。
- 下一步: 补 quick-tab UI 红测，直接点 Current Tabs 的 ×，断言 UI 列表与 OPEN_TABS 同步减少且冷启动不恢复。

[2026-05-07] close-tab stale list root cause confirmed
- 真 bug 不在 close pure function；Current Tabs(openTabState->terminalSessions) 本身关闭后是对的。
- 真正的“关闭后列表还是旧的”第二真源在 App->ConnectionsPage：之前传的是全量 runtime sessions，而不是 explicit open-tab truth。
- 结果：OPEN_TABS 已删，但退出到 connections 页时仍可按 runtime sessions 看到旧 tab，形成“关不掉/又回来”的用户感知。
- 本轮只改唯一 owner：App.tsx 传给 ConnectionsPage 的 sessions 改为 terminalSessions；补集成回归钉死 close 后 connections 只看显式 open tabs。

[2026-05-07] close-tab list follow-up
- 已补双回归：1) close 后 connections 只看 explicit open tabs；2) quick-tab Current Tabs 关闭后立即减少。
- 目前 sessionGroups 语义确认是 server/session selection history，不是 current tabs truth；若用户继续把 connections 页里的 history 感知成旧 tab，需要下一步收 UI 文案或交互边界。

[2026-05-07] connections/history wording split
- 继续收口用户感知边界：ConnectionsPage / session history 层展示 server/session 历史，不是 current tabs。
- 本轮不改逻辑，只把该层所有用户可见文案里的 tab/tabs 改成 session/sessions，避免与 explicit open-tab truth 混淆。

[2026-05-07] remote history audit stale-target root cause confirmed
- 红测已确认：daemon-owned sessionGroup remote audit 之前直接使用 history 内旧 bridgeHost/bridgePort/authToken 去 fetch tmux sessions。
- 后果：同一 daemon 的 endpoint/token 更新后，history prune 仍打到旧 target，旧 session history 可能长期残留。
- 收口方向：只在 open-tab-restore 远端 owner target 解析层升级为 host-aware，按 ownerKey 选择 fresh host truth；useOpenTabRuntime 只透传 hostsRef.current。

[2026-05-07] history prune timing audit
- 现状审计：remote audit 触发点只有 connect / cold-start(no tabs, only groups) / foreground resume / picker refresh。
- 缺口怀疑：用户关闭 tab 回到 ConnectionsPage 时，本身不会触发 history audit；因此 history-only stale sessions 可能继续停留直到下次 resume/connect。
- 已补场景测试：return-to-connections 是否应立即 re-audit history。

[2026-05-07] history prune timing fixed
- 红测确认：return-to-connections 之前不会触发 history audit。
- 本轮只在 App page navigation owner 增加 handleOpenConnectionsPageWithAudit()：进入 ConnectionsPage 即显式触发 auditOpenTabsAgainstRemoteSessions(connections-page-open)。
- 不改 transport/session/runtime ownership，不新增 fallback。
[2026-05-07] connections-page-open history audit verification
- 已复跑新增场景：进入 ConnectionsPage 会显式触发 `auditOpenTabsAgainstRemoteSessions('connections-page-open')`，history-only stale sessions 不再等到 resume/connect 才 prune。
- 中途红测并非生产 bug：`App.dynamic-refresh` 该场景的 live runtime session fixture 漏了 `daemonHostId`，导致第一次 prune 来自 bridge-only current tab，第二次才是 daemon-owned history group；已只修测试夹具，不改生产 owner。
- 回归结果：`App.dynamic-refresh + ConnectionsPage + useSessionHistoryStorage + open-tab-restore` 共 93 绿。
