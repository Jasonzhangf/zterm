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
[2026-05-07] connections stale bridge-history duplicate card fix
- 继续审计“已关闭/不存在的旧 session/server 又回来”时，新打到一条真 bug：`buildConnectionsServerGroups()` 会把 bridge-only stale history group 独立保留成一张卡，即使同 session 已存在 daemon-owned saved host truth；结果用户看到第二张旧 server 卡，误感知为“旧 tab/session 又回来了”。
- 本轮只在投影 owner `connections-server-groups.ts` 修复：bridge-only history group 入场前，若可唯一命中已有 daemon-owned host group 且其已覆盖该组全部 sessionNames，则直接并入该 daemon group，不再新建 bridge stale group。
- 新回归：
  1. `connections-server-groups.test.ts`：stale bridge-only history 不得生成第二张卡
  2. `ConnectionsPage.test.tsx`：页面只显示 daemon card，不显示 stale bridge card
  3. `useSessionHistoryStorage.test.ts`：显式 delete group 持久化删除继续保绿，确认问题不在 SESSION_GROUPS 删除本身
- 相关总回归：`connections-server-groups + ConnectionsPage + useSessionHistoryStorage + App.dynamic-refresh` 共 99 绿。
[2026-05-07] persisted-tab restore stale host-id fallback fix
- 继续审计“旧 session/server 又回来、saved tab 首次打开连旧地址”的链路时，新打到真 bug：`resolveHostForPersistedOpenTab()` 只先按 `hostId` 命中；一旦旧 host id 已被替换/删除，就直接退回 persisted tab 自身旧 endpoint/token，不会按 daemon/session 语义匹配当前 fresh host truth。
- 后果：saved tab restore / saved tab import / cold restore 可能继续连 stale bridge endpoint 或 stale auth token，用户感知为旧 session/server 又回来，或第一次打开连不上。
- 本轮只在 owner `open-tab-persistence.ts` 修复：`host.id` 未命中时，继续按 `persistedOpenTabsSemanticallyMatch(host, tab)` 选当前 semantic host truth，再回退到 tab 自身字段。
- 新回归：`open-tab-persistence.test.ts` 钉死 hostId 丢失但 daemon/session 语义仍相同的场景必须命中新 host，而不是退回旧 persisted endpoint。
- 相关回归：`open-tab-persistence + session-picker + useSessionOpenActions + App.dynamic-refresh` 共 88 绿。

[2026-05-07] bottom prompt not repainting during live output root cause fixed
- 现场现象“上面继续刷新、下面输入行不刷，补一个空格才恢复”这轮确认不在 quick-input 浮层，也不在 daemon diff；唯一真 bug 在 client pull-state 去重判定。
- 根因：`requestSessionBufferSyncRuntime()` 对 in-flight `tail-refresh` 的“完全重复请求”判定只比较了 `knownRevision/local window/request window`，没把 `targetHeadRevision` 纳入；结果同一 local snapshot + 同一 follow window 下，只要 daemon head revision 继续增长，新的 same-window tail refresh 会被误判为重复并吞掉。
- 后果：输入已发出、`buffer-head` 也到了，但客户端不再补发新的 same-window `buffer-sync-request`，因此正文底部 prompt 行更新会卡住，直到后续别的输入/事件把 local snapshot 改掉才恢复。
- 本轮只在唯一 owner 收口：`doesSessionPullStateMatchExactLocalSnapshot()` 新增 `targetHeadRevision` 比较，`requestSessionBufferSyncRuntime()` 传入当前 authoritative daemon head revision；老 revision 的 in-flight pull 不再阻塞新 revision 的 same-window tail refresh。
- 已补/复跑回归：
  1. `session-sync-helpers.test.ts`：same-window exact match 只对同一 daemon head revision 成立
  2. `session-context-buffer-runtime.test.ts`：daemon head revision 前进时必须重发 same-window tail refresh
  3. `SessionContext.ws-refresh.test.tsx`：same-end/same-window follow 刷新链继续保绿
  4. `App.android-ime-input-loop.test.tsx`：Android IME 输入闭环保绿
[2026-05-07] tab-switch queued input not flushing on first connect root cause fixed
- 现场现象：切到另一个 tab 后，如果该 session 的 transport 还没完成首次 handshake，用户先输入，后面即使该 tab 变成 connected，也容易出现“无法输入/输入没反应”。
- 真 bug 不在 daemon，也不在 tab active 真相；唯一 owner 在 client transport-open connected effects。
- 根因：`buildTransportOpenConnectedEffectPlan()` 之前只对 `debugScope='reconnect'` 返回 `flushPendingInputQueue=true`，而首次 `connect` 返回 false。
- 后果：tab switch 后对尚未首连完成的 session 产生的 queued input，会在首次 connected 时漏 flush；只有后续再次输入/重连才可能恢复。
- 修复：只改 `session-sync-helpers.ts` 的 connected-effect plan，让首次 `connect` 与 `reconnect` 一样在 connected 后 flush pending input queue；不改 daemon，不加 fallback。
- 新回归：`SessionContext.ws-refresh.test.tsx` 新增“tab switch input before first connect completes -> connected 后必须 flush queued input + force head request”。
- 相关回归：`SessionContext.ws-refresh + App.android-ime-input-loop + TerminalPage.android-ime` 共 134 绿；`tsc --noEmit` 通过。

[NOTE] 2026-05-07 多session输入延迟/首刷慢初查：确认 client 在 socket onmessage 层仍会对 inactive tab 的 live buffer-sync 做完整 JSON.parse + summarize + normalize/apply 入口调用，真正 drop 发生在更下游 applyIncomingBufferSyncRuntime。已将 inactive gate 前移到 handleSocketServerMessageRuntime 的 buffer-sync case，在 inactive 时直接跳过 summarize/settle/apply，避免 hidden tabs 线性吃 live payload 解析成本；补 socket-message runtime 红测。
[NOTE] 2026-05-07 进一步收口：仅在 socket-message 层 drop inactive buffer-sync 仍会先发生 JSON.parse，hidden tab 多时仍吃大 payload parse 成本。已把 inactive live buffer gate 再前移到 session transport onmessage：先用轻量正则提取 type，若为 buffer-sync 且 session 非 active/live，则直接 pre-parse drop；保留 recordRxBytes 与其余消息正常解析。split pane 继续通过 active || liveSessionIds 判定放行。
[2026-05-07] architecture audit: non-single-truth checkpoint
- 已确认最明确的架构违规 #1：daemon 仍持有客户端 width 语义。证据：`terminal-runtime-types.ts` 中 `TerminalSession.widthMode`、`SessionMirror.adaptiveCols`；`terminal-mirror-runtime.ts` 在 `attachTmux/handleResize/reconcileMirrorAdaptiveWidth` 内长期存储并依据 `adaptive-phone` 改写 tmux window 宽度。这违反“daemon 不持有客户端 widthMode / viewport 心智”的硬规则。
- 已确认最明确的架构违规 #2：open-tab 状态写入口仍然分散。物理持久化最终主要收口到 `useOpenTabRuntime.persistExplicitOpenTabs()`，但业务状态变更决策散落在 `useOpenTabSessionActions`、`useSessionOpenActions`、`useOpenTabRestoreRuntimeSync`，这些 hook 直接调用 `persistOpenTabIntentState()` / `persistAndSwitchExplicitOpenTabs()`；当前仍不是单一 operation owner。
- 已确认高风险重复 owner：active session 语义同时存在于 `SessionContext.state.activeSessionId` 与 open-tab runtime (`openTabState.activeSessionId + pendingTerminalActiveSwitch`) 两层。证据：open-tab runtime `requestRuntimeActiveSessionSwitch()` 最终调用 `switchSession()`；session runtime/orchestration 多处 `setActiveSessionSync()`；restore/switch/close 路径都会同时碰 active tab 与 runtime active。
- 已确认中风险残留：render commit helper 仍有二义性入口。真实 wiring 由 `session-render-gate -> provider-runtime(recordRenderCommit)` 驱动，但 `session-context-pull-runtime.ts` 仍暴露 `recordSessionRenderCommit()` helper，属于残留第二接线口，后续容易再被误接。
- 已确认 connections/history 与 current tabs 已基本分层：`useSessionHistoryStorage` 是 `SESSION_GROUPS` 唯一持久化 owner；`connections-server-groups.ts` 是投影 owner；`App.tsx` 传给 ConnectionsPage 的 `sessions` 已改为 explicit `terminalSessions`。当前“旧 server/session 又回来”的剩余风险更偏向 history 投影时机/远端 prune 边界，而不是 current tabs 持久化第二真源。
- 已确认 close tab/session 已部分收口但仍多 source：用户关闭、SESSION_STATUS_EVENT(closed)、remote audit prune 都会进入 `applyClosedOpenTabIntent()`；这比以前好，但 close orchestration 仍和 runtime close/page switch/draft clear 混在一起，建议下一步提升成单一 close operation owner。
- 已确认多处 silent failure 仍违反规范：`open-tab-persistence.ts` 存在裸 `catch {}`；`traversal-relay/server.ts`、`zterm-rtc-remote-verify.ts`、`useTraversalRelayAccount.ts` 等仍有 `catch {}` 或 ignore-cleanup 型吞错；主链 UI/runtime 还存在大量 warn-only cleanup。需按主链优先级逐步物理消灭。
[2026-05-07] zterm-1.1 daemon width semantics de-cliented
- 已物理移除 daemon terminal core 内的客户端 width 语义 owner：`TerminalSession.widthMode`、`SessionMirror.adaptiveCols`、`terminal-mirror-runtime.reconcileMirrorAdaptiveWidth()`、`handleResize()` 全部删除。
- 当前 daemon attach 只消费物理 `cols/rows`：`attachTmux()` 在 mirror boot 前只写 mirror 初始几何；后续不再按 subscriber/client width mode 聚合并改写 tmux window。
- `rg -n "widthMode|adaptiveCols|TerminalWidthMode|reconcileMirrorAdaptiveWidth|handleResize\\(" android/src/server` 已为空；说明 server 侧该 owner 链已物理消灭。
- 回归证据：
  1. `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` 通过
  2. `vitest run src/server/terminal-mirror-runtime.test.ts src/server/terminal-runtime.detached-session.test.ts src/server/terminal-message-runtime.test.ts src/server/server.transport-lifecycle-truth.test.ts src/server/terminal-mirror-capture.test.ts` = 39/39 绿
- 下一步：更新 architecture/decision/skill 文档，把“daemon 只认 cols/rows、width mode 只属于 client”冻结为书面真源，然后推进 zterm-1.2 open-tab 单一 owner 收口。
[2026-05-07] zterm-1.2 open-tab write-surface narrowed to runtime owner API
- 已完成第一轮收口：外部 hook / App 不再直接持有通用 `persistOpenTabIntentState`；`useOpenTabRuntime` 对外改为 `applyOpenTabState(nextState, {fallbackActiveSessionId?, switchRuntime?})`，由 runtime owner 决定仅持久化还是持久化+runtime active switch。
- `useOpenTabSessionActions`、`useOpenTabRestoreRuntimeSync`、`useSessionOpenActions` 已改为只调 `applyOpenTabState` 或 `requestRuntimeActiveSessionSwitch`，不再直接调用通用 persist 写口。
- 当前剩余 grep 命中 `persistAndSwitchExplicitOpenTabs` 只在 `useOpenTabRuntime` 内部（owner 自身）作为实现细节存在；外部模块 direct write 口已收掉。
- 验证：
  1. `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` 通过
  2. `vitest run src/hooks/useSessionOpenActions.test.tsx src/App.dynamic-refresh.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx` = 192/192 绿
- 剩余不足：这还是“runtime owner API 收口”，尚未把 open-tab operation/event/reducer 彻底模块化；但已经先物理消除了外部多处直接写 persisted truth 的问题。
[2026-05-07] zterm-1.3 active session owner narrowed
- 已完成第一轮 active truth 收口：`OpenTabRuntimeRefs.activeSessionIdRef` 现在代表 **open-tab active truth**；新增 `runtimeActiveSessionIdRef` 仅代表 SessionContext runtime active truth。
- `terminalActiveSession` 选择顺序已改为：pending target -> openTabState.activeSessionId -> runtimeActiveSessionId -> fallback first terminal tab；避免 runtime active 反向覆盖 tab owner。
- `requestRuntimeActiveSessionSwitch()` 的 pending switch 比较已改为基于 `runtimeActiveSessionIdRef`，不再错误读取 tab active ref。
- `useOpenTabLifecycleEffects` / `useOpenTabSessionActions` 的 close path 现在显式使用 `runtimeActiveSessionIdRef` 作为 runtime close/fallback 依据；`useTerminalShellActions` 继续使用 `activeSessionIdRef`（tab owner）判断“发送前是否需要切 tab”，语义已分离。
- 验证：
  1. `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` 通过
  2. `vitest run src/hooks/useSessionOpenActions.test.tsx src/App.dynamic-refresh.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx src/pages/TerminalPage.tab-isolation.test.tsx` = 198/198 绿
- 剩余不足：SessionContext 内部仍有 `setActiveSessionSync` 作为 runtime 真相推进，这本来就是 runtime owner；当前收口重点是外层业务层不再混用 runtime active 与 tab active，已完成第一轮。
[2026-05-07] zterm-1.4 render commit single-entry closeout
- 已物理删除 `session-context-pull-runtime.ts` 中残留 `recordSessionRenderCommit()` helper；render commit 现在只允许从 `session-render-gate` flush 链进入 provider debug metrics 注入。
- 验证：`tsc --noEmit` 通过；`vitest run src/lib/session-render-gate.test.ts src/App.dynamic-refresh.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx` 绿。
- 结论：pull/runtime 不再保留第二接线口，render commit 来源收口到 gate 主链。

[2026-05-07] zterm-1.5 silent failure cleanup first pass
- 已先清主链/近主链裸吞错：
  1. `open-tab-persistence.readPersistedClosedTabReuseKeys()` 从裸 `catch {}` 改为显式 `console.error`
  2. `useTraversalRelayAccount` 卸载时关闭 relay devices stream 失败不再静默吞，改为显式日志
  3. `traversal-relay-client` 基础 URL 归一化失败不再静默；已导出统一 `normalizeTraversalRelayBaseUrl()` 并显式日志
  4. `terminal-file-transfer-list-runtime` 中 `stat` 失败、remote screenshot 临时文件清理失败都改为显式日志，不再 silently skip/ignore cleanup
- 已补回归：
  - `open-tab-persistence.test.ts`
  - `traversal-relay-client.test.ts`
  - `useTraversalRelayAccount.test.tsx`
  - `server.file-transfer-truth.test.ts`
- 本轮验证：`tsc --noEmit` 通过；上述 4 组 vitest = 18/18 绿。
- 剩余热点：transport/infra runtime 内仍有少量“探测式 parse / URL 组装”catch，需要继续区分“合法分支探测”与“真吞错”后再收口，避免误伤 plain-text input / pong fast-path。
[2026-05-07] zterm-1.6 owner boundary freeze: current tabs vs history vs connections projection
- 已重新审计三层 owner：
  1. current tabs = `OPEN_TABS + ACTIVE_SESSION`，唯一 storage owner 为 `open-tab-persistence.ts`，唯一业务 owner 为 `useOpenTabRuntime + open-tab-intent`
  2. session history = `SESSION_GROUPS`，唯一 storage owner 为 `useSessionHistoryStorage.ts`
  3. connections projection = `connections-server-groups.ts`，只读组装 server cards，不得写 storage / runtime
- 同时确认 `SessionContext` 只持有 runtime sessions / active runtime / transport-buffer-render runtime；不持有 current tabs/history storage truth。
- 已补 source-gate：`src/lib/open-tab-history-truth.test.ts`，钉死 storage owner 与 projection read-only 边界，防止以后再把旧 session/tab 逻辑串回多处实现。
[2026-05-07] zterm-1.6 reopen chain audit
- 继续追“旧 tab / 旧 session 自动回来”的真实 reopen 链，代码层已确认 app-layer 生产 `createSession(...)` 入口只剩两条：
  1. `useOpenTabRestoreRuntimeSync.ts`：cold restore / auto restore persisted OPEN_TABS
  2. `useSessionOpenActions.ts`：用户显式打开单个 session/group/saved-tab-list
- 其余模块（`useOpenTabRuntime` / `useSessionHistoryStorage` / `ConnectionsPage` / `connections-server-groups`）不应直接 createSession；已补 source gate 钉死该边界。
- 结论：后续若仍出现“旧 tab 自动回来”，重点不再是 createSession 多入口，而是 restore/audit 时机或 persisted truth 本身是否被错误保留。
[2026-05-07] tombstone clear owner narrowed
- 继续审计 reopen 链后，确认 `closed-tab-reuse-keys` 清理不应散落在显式打开各分支；本轮已抽回 `open-tab-persistence.clearClosedTabReuseKeysForOwner()`，统一按 semantic owner variants 清 tombstone。
- 规则冻结：
  1. 显式 reopen / saved-tab import 可以清 tombstone
  2. cold restore 不得偷偷清 tombstone
- 当前 `useSessionOpenActions.openDraftAsSession()` 已改为只调该单点 helper；后续如果再需要清 tombstone，必须复用这一 owner。
[2026-05-07] zterm-1.6 cold-restore tombstone gate frozen
- 已在 `open-tab-history-truth.test.ts` 增加 source gate：cold restore (`useOpenTabRestoreRuntimeSync.ts`) 必须对 tombstone 只读，不得调用 `persistClosedTabReuseKeys` / `clearClosedTabReuseKeysForOwner` / 直接 delete tombstone。
- 显式 open (`useSessionOpenActions.ts`) 仍是唯一允许清 tombstone 的 app-layer 路径，且必须同时保留 tombstone persist write 语义。
- 验证：`vitest run src/lib/open-tab-history-truth.test.ts` 5/5 绿；`tsc --noEmit` 通过。
[2026-05-07] quick-tab current-tabs owner fixed to OPEN_TABS truth
- 继续审计“已有 tab 管理不准/像是又恢复”的链路时，确认 `App.tsx -> TmuxSessionPickerSheet` 的 `openTabs` 之前错误地取自 `terminalSessions`（runtime connected projection），不是 `openTabState.tabs`（OPEN_TABS truth）。
- 后果：runtime 尚未连上、或某个 persisted tab 当前没有 live session 时，quick-tab 会错误地显示“没有这个 tab”，造成用户以为关闭/持久化失效。
- 修复：`TmuxSessionPickerSheet.openTabs` 改为只读 `openTabState.tabs`，`activeTabId` 改为 `openTabState.activeSessionId`；不再从 runtime `terminalSessions` 投影已有 tab 管理视图。
- 回归：`App.dynamic-refresh.test.tsx` 新增“runtime 未连上时 quick-tab 仍显示 persisted OPEN_TABS truth”；`vitest -t quick-tab current-tabs` 绿，`tsc --noEmit` 通过。
[2026-05-07] foreground-resume owner narrowed to App lifecycle
- 继续排查“后台返回前台卡住 / 前台能刷但不能输”时，确认 foreground resume 之前存在双实现：
  1. App `useOpenTabLifecycleEffects` 调 `resumeActiveSessionTransport(activeSessionId)`
  2. SessionContext `useSessionContextLifecycle` 在 `appForegroundActive` 翻回 true 时又自行触发一次 `ensureActiveSessionFresh(source='active-resume')`
- 这违反 single-owner：前后台生命周期应由 App owner 发起一次 restore，SessionContext 只消费 `appForegroundActive` 作为前台真相，并继续自己的 `active-reentry / active-tick`。
- 修复：删除 `session-context-lifecycle.ts` 内部 foreground->active-resume 重复触发，只保留 `foregroundActiveRef` 更新；App lifecycle 继续作为唯一 active-resume owner。
- 验证：
  1. `vitest run src/App.dynamic-refresh.test.tsx -t "foreground resume|foreground truth|delegates disconnected active-tab foreground resume|does not reconnect hidden unhealthy tabs during foreground resume"` 9/9 绿
  2. `vitest run src/contexts/SessionContext.ws-refresh.test.tsx -t "refreshes head on explicit active resume|does not double-request head when tab switch is immediately followed by explicit foreground resume|flushes queued input after first connect when tab switch input happens before that session handshake completes|reuses the active open websocket on foreground resume before any reconnect decision"` 4/4 绿
  3. `tsc --noEmit` 通过

## 2026-05-07 input target truth
- 现象：前台可见 tab 已切换，但 SessionContext runtime active 还没切过去时，显式输入会被 queue 且不触发 reconnect / stale probe，表现为“界面能刷但不能输 / 要很久后才恢复”。
- 收口：`sendInputThroughSessionTransport` 现在把“用户显式输入目标 session”视为输入链唯一真源；queued input reconnect 与 stale-open probe 不再依赖 runtime active 指针是否已经同步。runtime active 仅保留 debug 观测，不再决定显式输入是否重连。
- 证据：新增 `src/contexts/session-context-input-runtime.test.ts` 两个 gate；并回归 `SessionContext.ws-refresh.test.tsx` 中 queued input / foreground resume 相关用例。

## 2026-05-07 foreground resume refresh target truth
- 现象：UI 已切到新 tab / 新 pane，前后台恢复时 App 会把该 tab 作为显式恢复目标，但 SessionContext runtime active 可能尚未同步，导致 `active-resume` 被判成非 refresh target，恢复后会出现卡住、能刷不能输、必须再次交互才恢复。
- 收口：`ensureActiveSessionFreshRuntime` 里仅对 `active-resume` 引入显式恢复目标语义；foreground resume 的目标 session 直接视为 refresh target，不再等待 runtime active 指针追平。`active-tick` 仍严格只服务 runtime active/live，不扩大 owner。
- 证据：新增 `src/contexts/session-context-activity-runtime.test.ts` 两个 gate，并回归 `App.dynamic-refresh.test.tsx` / `SessionContext.ws-refresh.test.tsx` 的 foreground resume 用例。
[2026-05-07] render truth closeout first pass: buffer-head must drive render, render cadence must not be network-throttled
- 继续排查“P 高频但 R=0、前台恢复后要靠输入才刷新、切 tab / 多 pane 时首帧久不渲染”后，确认 client 还有两处错误 owner：
  1. `resolveTerminalRefreshCadence()` 把 `renderCommitMs` 和网络 profile 绑在一起，3g/2g 会把 render 人为拖到 66/120ms；这不符合“性能优化不能靠降低渲染帧率”的硬规则。
  2. `handleBufferHeadRuntime()` 只更新 live head / cursor truth，但在“仅 head 变更”或“仅 cursor 变更”时不触发 `scheduleSessionRenderCommit()`；结果 debug 里会出现 P 在动但 R=0，屏幕要等后续 buffer-sync 或输入事件才被重画。
- 本轮只在唯一 owner 收口：
  1. `mobile-config.ts` 里把 `renderCommitMs` 固定为 33ms，只让 head/pull cadence 随网络变化，render cadence 不再跟 network profile 走。
  2. `handleBufferHeadRuntime()` 新增 `renderCommitNeeded`，只要 cursor/body/head 任一 truth 更新成功，就由这一处统一触发 render gate commit；不改 daemon，不加 fallback，不引入第二渲染入口。
- 对应红绿测试已同步改写：
  1. `mobile-config.test.ts` 改为断言 3g/2g/saveData 下 `renderCommitMs` 仍为 33
  2. `session-context-buffer-runtime.test.ts` 改为断言 buffer-head metadata/cursor 变化都会 schedule render commit

[2026-05-07] multipane workspace truth recovery
- 已确认当前分支为 main。
- 已确认当前 main 的 Android 终端页退回旧双分屏状态，真实多分屏真源在 backup/dace81c-shell-return。
- 本轮按单一真源收口：先恢复 packages/shared workspace-model，再恢复 android workspace-persistence + useTerminalWorkspace，随后把 TerminalQuickBar / TerminalPage 接回 pane-first workspace。

[2026-05-07] multipane workspace truth recovery closeout
- 已确认当前分支为 main。
- 已把 TerminalPage.tab-isolation 测试从 legacy split layout 真源迁移到 pane-first workspace 真源。
- 当前 workspace 持久化真源是 STORAGE_KEYS.TERMINAL_LAYOUT -> { panes, activePaneId }；legacy splitEnabled/splitSecondarySessionId 仅保留迁移兼容。
- 回归已通过：tsc --noEmit；TerminalHeader / TerminalPage.render-scope / TerminalPage.tab-isolation。
[2026-05-07] multipane visible refresh owner tightened
- 用户新冻结：visible pane 不是二等公民；除输入焦点外，visible pane 必须与 active pane 同级刷新/connect/reconnect。
- 本轮将 owner 收口到 `session-context-lifecycle.ts`：
  1. 新进入 `liveSessionIds` 的 pane 立即触发 `active-reentry + forceHead + allowReconnectIfUnavailable`
  2. `active-tick` 对 active/live 统一 `allowReconnectIfUnavailable: true`
- 这样不改 daemon，不新增 split 专用状态机，只把“可见即 live refresh target”落实在客户端单点 owner。

[2026-05-07] split width + quickbar bottom truth closeout
- 现场根因确认：4 分屏宽度不一致不是 renderer 问题，而是 workspace pane size 在 1->2->3->4 扩容时沿用了历史比例；最终形成类似 1/8,1/8,1/4,1/2 的错误宽度分布。
- 收口：pane 数量变化的唯一真源改为 `distributeEvenPaneSizes(...)`；仅保留 `normalizePaneSizes(...)` 用于纯比例归一，不再用于 split count 变化路径。
- 同轮修正：TerminalPage 底部 quick bar shell 不再额外加 14px 偏移，避免快捷栏悬空浪费底部空间。

[2026-05-07] terminal split layout / visible pane 收口
- 现状确认：TerminalHeader / TerminalPage / workspace 三处都在各自维护 split 布局参数（padding/gap/radius/back-button 尺寸/outer margin），导致现场“改了但看起来没变”。
- 现状确认：visible pane 刷新链已做 lifecycle 第一刀，但 split 下新开 pane 的 quick-tab 打开链路仍未显式把 pane 绑定意图一路传到 open action，属于高风险阻断点。
- 本刀目标：1）新增唯一 `terminal-layout-profile`；2）Header/Stage 只消费 profile；3）补 split quick-open -> pane attach 真链路测试。


[2026-05-07] split layout / P1 串屏 审计
- 现场 P0 仍有两件事：1) split layout 没收口；2) 可见 split pane 存在错误 buffer 闪到 P1。
- 代码审计结论（第一轮）：
  1. `TerminalPage.tsx` split 渲染当前 pane shell `key={pane.id}`，pane 内 active session 变化时可能复用同一个 `TerminalView` 实例；这与“P1 短暂闪入别的 pane 内容”高度吻合，需补红灯测试验证。
  2. `useTerminalWorkspace` / `workspace-persistence` 当前对 pane `size` 仍保留历史比例；但 Android 当前没有 pane 宽度手动调整能力，说明 `size` 在 split 布局上仍有第二真源（历史持久化比例），不是纯粹由当前 pane 数决定。需要收口成单一真相。
- 当前执行顺序：先补 split render-isolation / layout 恢复红灯测试，再修改 `TerminalPage` key 与 workspace pane-size normalize。

## 2026-05-07 pane-target / tab-menu / bottom-occlusion audit
- 1535 真机新增 P0：1) 非 P1 新开 session 总落到 P1；2) 长按 tab 菜单仍是 primary/secondary 旧语义；3) terminal 底部/输入框被 quick bar 遮挡；4) 仍有偶发错刷 buffer，第二根因待继续补红灯。
- 已确认：paneId 在 TerminalPage -> App/useSessionOpenActions 丢失；TerminalHeader 长按菜单仍硬编码 primary/secondary；bottom 需审 quickBar measured height 与 stage bottom 扣减链。

## 2026-05-08 多 tab 切换卡顿 / 输入排队延迟审计（只读）

### 现象
- 多 tab / 多 pane 后切换明显卡顿。
- 输入已发出，但回显晚很多拍，表现为排队延迟。
- 现场常见指标：`P` 高频但 `R` 低或为 0，说明 pull / head 活跃但 render commit 没及时形成稳定可见刷新。

### 已核对真源
- `SessionContextLifecycle` 当前 active tick 目标 = `activeSessionId + liveSessionIds` 全量并集。
- `TerminalView` 当前 `refreshActive = live ?? active`，所以 visible pane 都会继续参与 refresh / viewport / follow 链。
- `sendInputThroughSessionTransport()` 在每次 input 后都会立即 `requestSessionBufferHead(..., { force: true })`。
- `handleBufferHeadRuntime()` 对 cursor/head 变化会 `scheduleSessionRenderCommit()`，即使正文 body 尚未拿到新的 `buffer-sync apply`。
- `createSessionRenderGate()` 统一 33ms gate，输入场景和普通刷新场景未分级。

### 初步根因候选（按优先级）
1. **active tick 扫描范围过宽**
   - 位置：`android/src/contexts/session-context-lifecycle.ts`
   - 现在每个 tick 都遍历 `active + live`。
   - 在 split / 多 tab 下，visible pane 越多，head probe / stale probe / reconnect gate 越密。
   - 这会直接和 active pane 的 input/refresh 竞争主线程与 transport 调度。

2. **输入回显链路过长**
   - 位置：`android/src/contexts/session-context-input-runtime.ts`
   - 当前链路：`input -> force buffer-head-request -> 等 head -> buffer-sync -> render gate flush`。
   - 用户看到的是：输入其实发出去了，但本地第一时间没有形成 render commit。

3. **head/cursor metadata 触发 render commit，放大无效渲染**
   - 位置：`android/src/contexts/session-context-buffer-runtime.ts`
   - 当前 cursor/head metadata 变化会 `scheduleSessionRenderCommit()`。
   - 这和文档里“只有 buffer-sync apply 可以驱动正文 repaint”的目标不完全一致，会造成大量 metadata-only commit。

4. **render gate 对交互场景没有优先级**
   - 位置：`android/src/lib/session-render-gate.ts`
   - 当前统一 33ms gate；若前面已积压多 session head/pull，再叠一层 gate，active pane 回显就会肉眼变慢。

### 架构判断
- 目前主要问题不在 daemon 持有客户端状态；更像是 **client 端 refresh / head / render 调度过宽、过长、过多次**。
- 优化方向应保持：
  - daemon 继续只管 tmux mirror truth
  - client buffer manager 只管 daemon -> sparse buffer
  - renderer 只消费 render buffer
- 不应靠降刷新率掩盖，应收窄错误调度与重复 commit。

### 建议的最小修复方向
1. active tick 分层：`interactive active` 与 `visible live` 不同 cadence / 不同 probe 权重。
2. 输入路径去掉“每次 input 都强制 head 请求”的依赖，优先走已有 live push / sync 结果，必要时只做更轻量 probe。
3. metadata-only（cursor/head）禁止触发正文 render commit，只更新 head/cursor store。
4. render gate 分级：交互回显优先于普通后台刷新。
- 2026-05-08 split 首帧白屏追踪：定位到 live pane 的首个 buffer-sync 可能在 `TerminalPage -> onLiveSessionIdsChange -> SessionContext.setLiveSessionIds` 生效前，被 `isSessionTransportActive` / `buffer-sync.preparse-inactive-drop` / `session.buffer.sync.inactive-drop` 提前丢弃；唯一修复方向应收口为统一“首帧 bootstrap 可接收 live buffer”判定，避免 socket/runtime 多处各自判断。
- 2026-05-08 偶发错误帧再恢复：根因进一步收敛到 `session-render-gate.ts` 的 render snapshot 边界。旧实现把 `SessionBufferState.lines/gapRanges/cursor` 直接按引用投给 render snapshot，并且在 `liveBuffer` 引用未变时复用旧 `projectedBuffer`；若 live buffer 在下一次 patch/merge 时复用同一 row/object 再被写入，renderer 会短暂读到被污染的中间态。已收口：render gate 每次 commit 都产出独立 immutable render snapshot（clone lines/gapRanges/cursor），并补两条红灯测试覆盖“同一 live buffer 对象提交后被 mutate”与“row 对象复用后被下一次 patch 改写”。
- 2026-05-08 Android 键盘偶发抬起过高：根因收敛到 `TerminalPage.resolveKeyboardLiftPx()` 同时混用了 `reportedKeyboardInset` 与 `window.innerHeight / visualViewport.height`。Android 某些 WebView 上 `innerHeight` 本身已经随 IME 缩过一次，此时再按 `visualViewport` 推 occludedBottom 会形成第二次收缩，导致 quick bar / terminal 整体抬高过头。已收口：layout viewport 高度改为单点取 `max(innerHeight, documentElement.clientHeight, visualViewportBottom)`，只允许对 `reportedKeyboardInset` 做一次上限裁切，不再让“已被缩过的 innerHeight”成为第二份真源。已补红灯测试覆盖 `innerHeight 已缩小但 clientHeight 仍是布局真值` 的 case。

[2026-05-08] IME 抬高异常现场继续追踪（Jason 真机）
- 最新截图：键盘弹出后 terminal 可视区被整体压成极小高度，说明这次不只是 quick bar 抬高数值误差，而是 stage 可用高度/底部 inset/keyboard lift 其中至少两个量被同时扣减。
- 下一刀只允许检查唯一真源链：reportedKeyboardInset -> resolveKeyboardLiftPx -> terminal stage bottom padding / composer offset；禁止再引入第二套 viewport/IME 补偿。

[2026-05-08] 新现场：1542 已装后，仍需并行追两件事
- 1) 平板键盘抬起现场需要继续核对是否还有第二份高度真源未收口；截图已显示并非所有设备复现，疑似设备特定 WebView/viewport 行为差异。
- 2) 应用内升级检测到包但安装阶段 timeout，优先查客户端升级安装链路与 adb/logcat 现场，不先猜测。

[2026-05-08] 设备目标纠正
- Jason 明确纠正：当前要排查的真实设备不是 `100.127.23.27:1234`，而是 `100.93.14.124` 对应机器。
- 后续所有 adb/logcat/安装与 IME 现场结论必须绑定这台设备，避免把另一台设备的现象错当成当前现场。

[2026-05-08] client debug snapshot 真源补口
- 已把 IME/layout 现场与 app-update stage 收口到同一条 `registerClientDebugSnapshotSource -> collectClientDebugSnapshot -> active session WS debug-snapshot` 链，避免再开第二条 debug transport。
- 升级安装现场后续只看 `app-shell` snapshot 的 `appUpdateStage/runtimeVersionCode/latestManifest*/availableManifest*`；键盘抬高现场只看 `terminal-page` snapshot 的 `keyboardInset/effectiveKeyboardLiftPx/shellHeight/layoutViewportHeight/terminalChromeBottomPx/layoutProfile`。

[2026-05-08] head request owner 收口审计（本轮）
- 已确认重复 owner 主要来自两处：
  1) `handleSocketConnectedBaselineRuntime()` 在 connected 后无条件按 `buildConnectedHeadRefreshPlan(...).shouldRequestHead` 立刻 `requestSessionBufferHead(..., force:true)`。
  2) `useSessionContextLifecycle()` 的 `active-reentry` / foreground `active-resume` 会在同一会话刚连上或刚切入时再次走 `ensureActiveSessionFreshRuntime()`。
- 当前 `ensureActiveSessionFreshRuntime()` 只对 `active-resume` 做了“最近有 active-reentry 则跳过 forced head”的门禁，但 connected baseline 自己没有感知最近 reentry/resume，因此 connect + reentry/resume 仍可能双发。
- 结论：head request 的唯一 owner 应收口为 `ensureActiveSessionFreshRuntime()`；connected baseline 只负责 transport connected/schedule-list/pending-tail 标记，不再主动抢 head owner。例外只保留 queued input reconnect 场景，由 reconnect 后 flush input 触发同一条 active freshness 闭环，而不是 baseline 再单独发一枪。

[2026-05-08] 多机输入队列语义收口（进行中）
- Jason 新要求：多机同时连接时，不接受“输入排队后延迟补发”；这种 client 侧队列语义没有意义。
- 收口目标：client input 只允许两种结果：
  1) 当前 open transport 立即发送；
  2) transport 不可用则显式 debug + reconnect，但**不缓存、不重放旧输入**。
- 本轮实现策略：先保持 `pendingInputQueueRef/flushPendingInputQueueRef` 结构兼容，避免误伤 transport/open wiring；但 flush 改成 no-op 清空，不再 replay。下一轮可继续物理删除 ref 与 wiring。
- connected baseline / active-resume 重复 head 第一刀已收口：新增 `lastConnectedBaselineAtRef` 作为 client 内 head-owner 观测真相。当前策略：connected baseline 仍可发首帧 forced head，但若用户/前台在同一 `headTickMs` 内立刻触发 explicit resume，则 `ensureActiveSessionFreshRuntime()` 跳过第二发 forced head，避免 connect+resume 双发。该真相只属于 client refresh owner，不进入 daemon。
- 多机输入队列残留第二刀已完成：`pendingInputQueueRef / flushPendingInputQueueRef / connect-open flush replay` 已从 client wiring 中物理删除；现在输入链唯一语义是 `open transport -> send` 或 `transport unavailable -> reconnect`。旧输入不缓存、不重放。

[2026-05-08] client refresh/input 真源收口（本轮完成）
- 先修了一个明确装配缺口：`SessionContext.tsx` 没把 `lastConnectedBaselineAtRef` 从 provider runtime 解构并下传，导致 `ensureActiveSessionFreshRuntime()` 在 ws-refresh 路径直接读到 `undefined.current`。现已收口到唯一装配点，避免 runtime/test 分叉。
- 输入链真源已重新冻结为：`explicit input -> markPendingInputTailRefresh -> send input -> forced buffer-head-request(force:true)`；不再依赖别处“补一枪” head。这样 active input / stale-open input probe / burst input coalesce / input-exit-reading / older-tail-finish-catch-up 这些场景都回到单一路径。
- `active-resume` 与 `connected baseline` 的 duplicate-head 门禁继续收细：
  - 不再用 `lastConnectedBaselineAtRef < headTickMs` 粗暴吞掉所有 explicit resume；那会误伤“用户明确 resume 也必须立刻 fresh head”的 case。
  - 新增 client-only `connectedBaselineBurstGuardRef`：仅在 `handleSocketConnectedBaselineRuntime()` 的同一事件轮次内，允许 suppress 一次紧随其后的 explicit resume head；microtask 结束即清除。
  - 这样同时满足两条约束：
    1. `connected -> immediate resume same turn` 不双发 head
    2. `connected settled later -> explicit resume inside head throttle window` 仍必须 fresh head
- 这轮没有把任何 client 状态机塞回 daemon；所有新增真相都留在 client refresh owner 内部，符合“daemon 不管理客户端状态”硬约束。
- 回归证据：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/session-context-activity-runtime.test.ts src/contexts/SessionContext.ws-refresh.test.tsx --reporter dot`
  - 结果：2 files / 115 tests 全绿

[2026-05-08] active-tick 调度降噪（本轮）
- 现状确认：`useSessionContextLifecycle()` 之前每个 `headTickMs(33ms)` 都会对 `activeSessionId + liveSessionIds` 全量执行 `ensureActiveSessionFresh()`；虽然大多数健康 connected session 最终会在 `tick-live-refresh-owned-by-daemon` 分支早退，但多 pane 下仍然有高频 JS 调度/Map 读写/runtimeDebug 判定开销。
- 本轮收口：新增 `shouldScheduleActiveTickRefresh()`，active-tick 只对以下 session 触发：
  1. 非 `connected`（如 connecting/reconnecting/closed）
  2. `connected` 但 `lastServerActivityAt` 已静默超过 `headStalePingMs`
- 结果：健康的 active/live pane 不再每 33ms 白跑 `ensureActiveSessionFresh()`；只在真正需要 stale probe / reconnect 恢复时才进入 active-tick 链。
- 这刀没有改变 visible pane 必须和 active pane 一样“可刷新”的产品语义；只是把“健康期间的空转调度”从 client 主线程拿掉。
- 回归证据：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/session-context-lifecycle.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx src/App.dynamic-refresh.test.tsx src/components/TerminalView.dynamic-refresh.test.tsx --reporter dot`
  - 结果：4 files / 244 tests 全绿

[2026-05-08] render/body 真源继续收口（本轮完成）
- 现象：多 tab / 多 pane 下，`P` 频繁但 `R` 偶尔低或为 0；审计发现 client 侧 `buffer-head` 的 daemon head metadata 变化也会走 `scheduleSessionRenderCommit()`，从而让 TerminalView 在 body 未变化时仍收到 render snapshot 变更，触发 follow/viewport/realign 链重算。
- 真源修复：
  1. `handleBufferHeadRuntime()` 不再因为 `sessionHeadStore.setHead()` 成功而调度 body render commit；head metadata 现在只进 `sessionHeadStore`。
  2. `TerminalView` 新增独立 `sessionHeadStore` 订阅；`followDemandAnchorEndIndex` 的 head 语义改为：正文 body 继续只读 render buffer，daemon head metadata 单独从 head store 读取。这样保住“head 推进能驱动 follow demand”，但不再通过 body render store 唤醒整棵 renderer。
  3. cursor / cursorKeysApp 仍留在 render snapshot，因为它们确实影响可见 cursor 与键盘方向键编码，不属于纯 metadata-only noop。
- 收口后语义：
  - `buffer-sync apply` = 正文 body repaint owner
  - `buffer-head head-metadata` = head store owner
  - `TerminalView` = body snapshot + head snapshot 双输入，但两者职责不再混写
- 回归证据：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/session-context-buffer-runtime.test.ts src/contexts/session-context-lifecycle.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx src/App.dynamic-refresh.test.tsx src/components/TerminalView.dynamic-refresh.test.tsx src/pages/TerminalPage.render-scope.test.tsx --reporter dot`
    - 6 files / 264 tests 全绿
  - `pnpm --dir android exec vitest run src/lib/session-render-gate.test.ts src/App.first-paint.test.tsx src/App.first-paint.real-terminal.test.tsx --reporter dot`
    - 3 files / 18 tests 全绿
- 当前判断：这刀已经物理切掉一条 metadata-only -> body repaint 的错误路径，是继续追“多 tab 切换卡顿”的正确方向。下一刀重点应继续盯 `TerminalView` 自身 follow/realign/layout effect 是否仍有 body 未变时的多余重排。

[2026-05-08] TerminalView head-only render 再收一刀（本轮完成）
- 上一刀虽然已经切掉 `buffer-head -> renderStore body snapshot`，但 `TerminalView` 仍通过 React render 直接订阅 `sessionHeadStore`，意味着 head-only 推进仍会让整棵 `TerminalView` 顶层函数重跑一遍，继续触发一批 derived 计算。
- 本轮继续收口：
  1. 删掉 `useSessionHeadSnapshot()` 的 React render 订阅。
  2. `TerminalView` 保留 body 只订阅 `sessionRenderBufferStore`。
  3. head-only 路径改成 `sessionHeadStore.subscribe(sessionId, pushFollowDemandFromHead)` 的 imperative subscription，只在 `follow + active/live + 非 reading` 情况下发送新的 viewport demand；不触发 body render、不触发 follow realign。
  4. `daemonHead*` 的最新值只放 ref，不再成为 React render 输入。
- 新增红灯回归：`does not realign follow scroll when only daemon head metadata advances without a body repaint`
  - 证明：head-only 推进后 viewportEndIndex 会从 80 -> 120，但 DOM scrollTop 不会再被多写一次，也不会 body repaint。
- 回归证据：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/components/TerminalView.dynamic-refresh.test.tsx src/App.first-paint.real-terminal.test.tsx src/pages/TerminalPage.render-scope.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx --reporter dot`
    - 4 files / 184 tests 全绿
  - `pnpm --dir android exec vitest run src/App.dynamic-refresh.test.tsx src/contexts/session-context-buffer-runtime.test.ts src/contexts/session-context-lifecycle.test.tsx src/lib/session-render-gate.test.ts --reporter dot`
    - 4 files / 94 tests 全绿
- 当前判断：client 侧 head-only 更新已经连续两刀从“body render 参与者”降为“只更新 follow demand 的轻量信号”。下一步若还卡，重点应下到 `TerminalPage` 多 pane / 多 tab 场景下是否仍有非 active/live pane 的 header/chrome 级联重渲，或者 TerminalView 的 layout/ResizeObserver 路径仍然过于积极。


[2026-05-08] 多 tab / 多 pane 卡顿真因收敛（本轮）
- 现象：切 tab / 多 pane 后 P 高频、R 低、输入回显慢。
- 真因：`TerminalPage.handleTerminalViewportChange()` 先收到 renderer 的 `TerminalViewportState(mode=follow|reading)`，但又把它降格成普通 `TerminalVisibleRange` 回灌给 App/SessionContext，导致 `updateSessionViewportRuntime()` 看不到 `mode=follow`，把 follow 态也当成 reading-repair 触发 `buffer-sync-request`。visible pane 越多，误拉取越多。
- 唯一修复方向：App 只消费 `TerminalViewportState` 这条链；`mode` 不得在 page shell 层丢失。若仍需可见行号/窗口观测，只能作为纯观测派生，不能再成为第二条 worker 入口。


[2026-05-08] 三机同时卡顿 / 输入慢 / 多 pane 卡 第一刀止血（本轮）
- 现象：三台设备同时连上后，输入明显排队，多 pane 刷新发卡；daemon `/health` 现场 heapUsed 一度 220MB+，`/debug/runtime` 汇总里 client debug entries 顶到 2000，最新 scope 常见 `runtime.debug.drop-summary`。
- 真因 1（已确认）：`App.tsx` 在 relay device stream 建立后，无论是否有远程调试请求，都会每 1500ms 固定 `sendTraversalRelayClientDebugLogs(limit=60)`；这条链会把开启过的 runtime debug 日志常驻上传到 relay 侧，三机同时在线时形成持续 JSON 序列化 / 发送 / 聚合压力。
- 真因 2（更关键，已确认）：`session-render-gate.ts` 的 `session.render-gate.flush.inspect` 与 `session-context-buffer-runtime.ts` 的 `session.buffer.apply.inspect`，虽然最终要经过 `runtimeDebug(...)` 门禁，但**重 payload 的 summarize 工作发生在调用前**；也就是 debug 一旦开启，这两处会在正常渲染/补丁热路径里频繁先构造 `liveBuffer/localBuffer/nextBuffer/projected` 摘要，再决定是否入队，直接拖慢输入与多 pane。
- 真源修复：
  1. 删除 `App.tsx` 中 relay device stream 的周期性 debug log upload；现在 relay debug 只在显式 `client-debug-request` 时返回 snapshot/log，不再常驻后台推送。
  2. `runtime-debug.ts` 新增 `shouldCollectRuntimeDebugScope()` 与 `runtimeDebugPrechecked()`；重型 inspect scope（`session.buffer.apply.inspect` / `session.render-gate.flush.inspect`）先做开关+采样判定，再决定是否构造 payload，避免“门禁在后、重活先做”的错误路径。
  3. inspect scope 单独提频控到 1500ms，保留排障能力，但不允许热路径每帧都建大对象。
  4. 顺手删掉 `sendTraversalRelayClientDebugLogs()` 内部再次 `runtimeDebug('relay.debug.logs.sent')` 的自反馈，避免 debug 上传再反向制造 debug。
- IME 相关补口：`terminal-quickbar-helpers.tsx` 之前还在用 `window.innerHeight` 作为 overlay 高度真源；现改为统一复用 `resolveTerminalViewportMetrics()`，避免 tablet 上 `innerHeight` 已被 IME 缩过后再次重复扣减，造成 overlay / quick bar 抬高过多。
- 回归证据：
  - `pnpm --dir android exec vitest run src/lib/runtime-debug.test.ts src/lib/runtime-debug-flush.test.ts src/components/terminal/TerminalQuickBar.test.tsx src/pages/TerminalPage.android-ime.test.tsx src/components/TerminalView.dynamic-refresh.test.tsx src/contexts/SessionContext.ws-refresh.test.tsx --reporter dot`
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - 结果：6 files / 234 tests 全绿。
- 结论：这刀是纯 client 侧止血，不把任何客户端状态塞回 daemon，符合“daemon 不管理客户端状态”的硬约束。下一步若真机仍卡，优先继续查 `TerminalView` / `TerminalPage` 的多 pane 可见 renderer 是否还有多余 reflow，而不是再回头怀疑 daemon mirror 主链。
- [2026-05-08] IME debug overlay task: need expose viewport raw metrics + keyboard lift chain in local TerminalDebugOverlay so Jason can screenshot problematic devices. Root suspicion: keyboardInset has 3 competing sources (ImeAnchor / Keyboard / virtualKeyboard), and layoutHeight may already shrink on some Android WebViews causing double-lift.
- [2026-05-08] New signal from Jason: devices with wrong IME lift also cannot left/right swipe tabs, while devices with correct IME lift can. Suspect shared root in viewport/gesture path (pointer capture / resize / overlay hit area / axis lock), not just wrong bottom inset.
- [2026-05-08] Screenshot proof from same problematic device: no-IME state reports stable IH/CH/VVH/SH=615; IME-open state collapses IH/CH/VVH/SH to 328 while K/TI=303. Confirms root cause is WebView/layout viewport itself shrinking on IME, not wrong keyboard height. Fix: freeze Android shellHeight to last stable pre-IME layout height while keyboard is active.
- [2026-05-08] Jason reports latest multi-pane tablet build still broken: input latency rises for all panes, back button hidden in split mode, refresh slow and stale/wrong buffer in visible panes. Need audit visible-pane live set -> SessionContext refresh/pull gating -> renderer, and remove splitVisible coupling from back button truth.

## 2026-05-08 multi-pane refresh / render owner audit
- 已确认本轮未提交改动只涉及两块：1) split 下 back button 永远显示；2) foreground resume owner 从 App 层 `resumeActiveSessionTransport` 收回 SessionContext lifecycle。
- `TerminalPage` 当前多 pane 真源：`visiblePaneEntries -> renderedPaneSessions -> onLiveSessionIdsChange(livePaneSessionIds)`；理论上 visible pane 都会进入 SessionContext live refresh target。
- `TerminalView` 当前 refresh gate = `live ?? active`，所以 visible non-interactive pane 理论上也会触发 viewport demand / render commit，不是天然只刷 P1。
- 继续重点审：`renderTerminal(session, active)` 的传参与 `allowDomFocus/onActivateInput/focusNonce` 是否把 active-pane 语义和 visible-pane render 语义混在一起；以及 pane/session 映射切换时是否出现旧 activeSession 回调短暂污染新 pane。
- 新怀疑方向：`TerminalPage` / `TerminalHeader` / `workspace persistence` 之间仍有 pane-local owner 不完整，尤其是 pane 激活、tab manager 打开目标 pane、以及 focus/query active input 仍偏向全局 activeSession，可能导致多 pane 首帧/输入/刷新节奏串位。

[2026-05-08] multi-pane 白屏 / 只刷 P1 真因收敛（本轮）
- 继续审计后确认一个明确的 client-only 架构漏洞：`scheduleReconnectRuntime()` 的 auto-reconnect owner 仍只看 `sessionId === activeSessionId`，完全忽略 `liveSessionIds`。
- 结果：split / visible non-active pane 一旦 transport 出错或被动 close，会被判成 inactive 而停止重连；因为 visible pane 本身又仍在 live 集合里，UI 继续把它当作应显示 pane，于是真机现场表现就是“P1 正常，其余 pane 白屏/不刷新，点到 active 才可能恢复”。
- 唯一正确 owner：client refresh / reconnect 真相必须是 `activeSessionId ∪ liveSessionIds`。daemon 不参与；非 visible tab 才允许停取数/停重连，visible pane 不是二等公民。
- 下一刀：把 reconnect gate 从 `active-only` 收口为 `active-or-live`，补单测与 ws refresh 回归。

[2026-05-08] visible pane stale tick owner 继续收口（本轮）
- 继续追 `P1 正常、P2-P4 极慢/白屏` 时，又确认一条旧真源残留：`buildActiveSessionRefreshPlan()` 在 `source=active-tick && ws=OPEN` 时默认判成 `tick-live-refresh-owned-by-daemon`，直接 skip。
- 这已经与当前真源冲突：现在 daemon 不管理客户端可见 pane；visible pane 的 stale refresh owner 必须留在 client lifecycle。上层 lifecycle 明明已经按 `activeSessionId ∪ liveSessionIds` 选中 refresh target，但 plan 层又把 open transport 的 live pane head probe 吞掉，于是 visible non-active pane 在“连接还开着但长时间没有新 activity”时不会主动恢复。
- 本轮修复：删掉 `tick-live-refresh-owned-by-daemon` 分支；active-tick 对 open transport 一律走 `request-head(resetPullBookkeeping=false)`。由于 lifecycle 外层本来就只在 stale 条件满足时才调 `ensureActiveSessionFresh`，所以不会变成高频乱拉，只是把 stale visible pane 拉回 client 唯一 owner。

[2026-05-08] TerminalView 错帧先闪后恢复 尝试一刀失败（已回退）
- 尝试把 `reconcileViewportAfterBufferShift()` 从 `useEffect` 前移到 `useLayoutEffect`，想避免“先错一帧再恢复”的 paint 时序。
- 回归结果不成立：`TerminalView.dynamic-refresh.test.tsx` 直接炸 18 个 case，典型现象是初始 follow scroll 无法对齐到底部（大量期望 `scrollTop=952` 实际变成 `0`）。说明这条 reconcile 不能简单整体前移，否则会破坏 TerminalView 现有的初始 follow / reading scroll owner。
- 已物理回退。下一步继续查更窄的错误 owner，不再把整条 buffer-shift reconcile 粗暴前移。

[2026-05-08] visible non-active pane 首屏/首批 live buffer 被错误丢弃真因（本轮）
- 继续沿 visible pane -> transport/message -> buffer apply 审计后，确认一条真实链路漏传：
  - `createSessionMessageOrchestrationRuntime()` 调 `handleSocketServerMessageOrchestrationRuntime()` 时，漏传了 `shouldAcceptSessionLiveBuffer`
  - 结果运行时 `handleSocketServerMessageRuntime()` 会退回 `isSessionTransportActive(sessionId)` 判定
  - 对于 split 场景里“pane 已可见，但 liveSessionIds 还没完成 settle”的短窗口，visible non-active pane 的 bootstrap `buffer-sync` 会被当成 inactive-drop 丢掉
- 现场后果：P1 正常，P2-P4 在首屏/切 pane 后更容易白屏、慢首帧，必须等后续 head/tick/reconnect 才可能补回来。
- 本轮修复：把 `shouldAcceptSessionLiveBuffer` 从 message orchestration 明确透传到 socket-message runtime，恢复唯一 gate = `shouldAcceptSessionLiveBufferRuntime()`。
- 回归证据：
  - `pnpm --dir android exec vitest run src/contexts/session-context-message-orchestration-runtime.test.ts src/contexts/session-context-socket-message-runtime.test.ts src/contexts/session-context-transport-runtime.test.ts src/contexts/session-sync-helpers.test.ts src/contexts/session-context-activity-runtime.test.ts src/contexts/session-context-session-runtime.test.ts src/contexts/session-context-lifecycle.test.tsx --reporter dot`
  - 7 files / 78 tests 全绿
- 新增红灯：`session-context-message-orchestration-runtime.test.ts`
  - 锁定“visible non-active pane 在 live ids 未 settle 前，message orchestration 不得把 shouldAccept gate 丢失”。

[2026-05-08] debug overlay 收口（本轮）
- Jason 要求：1) 去掉为 IME 抬高排查临时加的那批 debug 字段；2) debug 浮窗默认关闭。
- 本轮收口：
  - `TerminalDebugOverlay` 删除 viewport/IME 专项观测项：IH/CH/VVH/VVT/VVB/K/Lift/TI/QI/SH/Btm/WM/Req/QF/TA。
  - overlay 保留最小状态观测：render mode / status / A / ↑ / ↓ / R / P / 版本。
  - `debugOverlayVisible` 默认值改为 `false`。
- 这样避免继续把一次性 IME 排障临时观测常驻到主界面真相里。

## 2026-05-08 wrong-buffer-frame audit
- user report: 大面积更新时偶发瞬间刷错 buffer，随后恢复；先收口 width-mode 中间态到可编译，再补复现测试追真源。

- 继续闭环：补跑 first-paint / ws-refresh / real-terminal / daemon-mirror-close-loop，之后构建 APK。

[2026-05-08] daemon resize truth decision（本轮）
- 当前 build 唯一阻塞是 `server.transport-lifecycle-truth.test.ts` 与 daemon `case 'resize'` 冲突。
- 结合 truth doc/skill 冻结后，决定收口为：**attach/connect geometry 是唯一上游 geometry ingress；runtime resize 不再进入 daemon。**
- 这样可消除 daemon 对 client width mode / viewport 变化的长期心智；Android 运行期容器/IME/viewport 变化只属于 renderer/UI shell 本地裁切。
- 下一步：先物理删除 daemon resize handler 与相关测试旧语义，再跑 contracts/build；client live resize 发包链随后一并剪断或置空，避免继续产生死语义。

[2026-05-08] project减法审计结论（本轮）
- 一级收口对象确定为 3 个：1) renderer 双实现（shared TerminalView vs android TerminalView）2) session-sync-helpers 巨型杂物间 3) open-tab 与 workspace owner 边界混写。
- 这三刀优先级高于继续修零散 UI bug，因为它们分别对应：重复实现、纯函数污染、owner 错位，是当前复杂度和回归风险的主源头。
- 下一步先建 beads epic + task board，后续按 renderer -> helpers -> open-tab/workspace 顺序逐刀物理删除错误实现。

[2026-05-08] renderer 双实现第一刀收口（进行中）
- 已确认 `packages/shared/src/react/terminal-view.tsx` 与 `android/src/components/TerminalView.tsx` 物理重复了一整套 terminal cell 颜色/块字符渲染语义：`normalizeCell / safeCodePointToString / colorToCSS / parseCssColorToRgb / mixCssColors / resolveColors / resolveDimmedForeground / isBlockShadeCodePoint / buildBlockBackground / isSolidBlockBackground`。
- 这不是“相似实现”，而是 renderer 语义真源重复；已经导致 Android 侧修颜色后 shared/mac 仍可能继续漂移。
- 第一刀唯一正确收口：把“terminal cell 视觉语义”下沉到 `packages/shared/src/terminal/*` 单一模块，Android 与 shared TerminalView 共同消费；保留各自 viewport/DOM/interaction 差异，删除重复的颜色/块字符逻辑实现。

[2026-05-08] session-sync-helpers 第二刀大块拆分（进行中）
- 已把原 `session-sync-helpers.ts` 中三块非 buffer/planner 真相物理拆出：
  1. `session-transport-open-helpers.ts`：open-intent / connect-reconnect updates / active refresh plan
  2. `session-wire-helpers.ts`：incoming buffer payload normalize / cursor normalize / host config wire
  3. `session-reconnect-helpers.ts`：managed session reuse / reconnect target ordering / auto-reconnect gate
- 当前 `session-sync-helpers.ts` 已从 1331 行降到 721 行，开始收回到 buffer/pull/visible-range/planner 域。
- 这刀的唯一正确方向不是继续在巨型 helper 里加 region comments，而是先按真相域物理切文件，再把调用点切到对应 owner；否则 shared functions + block + orchestration 分层永远不成立。

[2026-05-08] open-tab / workspace owner 第三刀（进行中）
- 已确认唯一越权点在 `useTerminalWorkspace.ts -> syncWorkspaceWithSessions()`：它会根据 runtime `sessions` 自动补 `missingSessions` 到 pane tabs，这违反了 open-tab truth 冻结（workspace 只能决定 pane placement，不能决定 tab existence）。
- 本轮已物理删除 `missingSessions -> append tabs` 路径，并新增 workspace 回归锁定“不复活 runtime-only session”。
- 正确边界：
  - open-tab owner 决定某个 session/tab 是否存在
  - workspace owner 只允许 prune 不存在的 tab，并决定现存 tab 放在哪个 pane

[2026-05-08] session-sync-helpers 第四刀完成（visible-range / buffer-planner / pull-state 真源分离）
- 已将原 `session-sync-helpers.ts` 剩余 721 行继续物理拆成 3 个单一真源模块：
  1. `session-visible-range-helpers.ts`：`SessionVisibleRangeState`、normalize/default/equality、viewportRows/endIndex 真相
  2. `session-buffer-planner-helpers.ts`：`SessionBufferHeadState`、local-window 判定、available-bounds、follow/reading planner、buffer-sync request payload
  3. `session-pull-state-helpers.ts`：`SessionPullPurpose/States`、pull settle / cover / exact-snapshot / clear
- 生产调用点已切走：`session-context-public/buffer/infra/pull/activity/lifecycle/provider/*`、`BufferSyncEngine`、`open-tab-persistence` 不再直接依赖 `session-sync-helpers.ts` 作为杂物间真源；当前 `session-sync-helpers.ts` 只剩薄 re-export 兼容层，生产 rg 已无直接依赖，只保留测试聚合入口。
- 这刀的唯一正确修改点是原 `session-sync-helpers.ts` 本身：问题不是个别 helper 内容错，而是 buffer planner / visible range / pull bookkeeping 三类真相被揉在同一文件里，导致 orchestrator 可以继续跨域偷用。只有把 owner 物理拆开并让调用点直连新模块，才能真正建立 shared function + block + orchestration 的边界。
- 验证：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/session-sync-helpers.test.ts src/contexts/session-context-buffer-runtime.test.ts src/contexts/session-context-activity-runtime.test.ts src/contexts/session-context-session-runtime.test.ts src/contexts/session-context-transport-runtime.test.ts src/contexts/session-context-message-orchestration-runtime.test.ts --reporter dot` => `6 files / 81 tests passed`

[2026-05-08] open-tab 第五刀收口（switch/persist orchestration 单入口）
- 继续审计后确认剩余的 owner 泄漏不是 storage 第二写口，而是 child hooks 仍在拿 `requestRuntimeActiveSessionSwitch` / `persistAndSwitchExplicitOpenTabsRef` 这类半公开编排口，导致 tab switch / saved-tab import / cold restore 仍有多处“先持久化再切 runtime”的重复路径。
- 本轮收口：
  1. `useOpenTabSessionActions` 不再直接调 `requestRuntimeActiveSessionSwitch()`，统一改走 `applyOpenTabState(..., { switchRuntime: true })`
  2. `useOpenTabRestoreRuntimeSync` 恢复 active tab 时不再单独调 runtime switch helper，统一改走 `applyOpenTabState(..., { switchRuntime: true })`
  3. `useSessionOpenActions.handleLoadSavedTabList()` 删除对 `persistAndSwitchExplicitOpenTabsRef` 的依赖，saved-tab batch import 统一也走 `applyOpenTabState(..., { switchRuntime: true })`
  4. `OpenTabRuntimeRefs` 物理删除 `persistAndSwitchExplicitOpenTabsRef`
- 当前 open-tab 真相边界进一步冻结：
  - storage owner：`persistOpenTabsState()`
  - app/runtime orchestration owner：`applyOpenTabState()`
  - child hooks 只声明 intent，不再持有额外 switch/persist 专用旁路。
- 这刀的唯一正确修改点是 open-tab orchestration surface 本身，而不是再去补单个页面 case。因为真正问题是 child hook 拿到了不该拿的“编排捷径”，只改调用结果不改 surface，重复实现会继续长出来。
- 验证：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/hooks/useSessionOpenActions.test.tsx src/lib/open-tab-history-truth.test.ts src/App.dynamic-refresh.test.tsx -t 'saved tab|open-tab|runtime tab switching owned by applyOpenTabState|persists explicit empty OPEN_TABS|does not reappend runtime-only sessions|does not bootstrap runtime sessions into tabs|persists closed tabs immediately and does not restore them on next launch|quick-tab current-tabs' --reporter dot` => `3 files / 20 passed`

[2026-05-08] session-sync-helpers 聚合层物理删除完成
- 继续收口后，`rg session-sync-helpers android/src` 已只剩测试文件；本轮把 `session-sync-helpers.test.ts` 也切到 owner 模块，随后物理删除 `src/contexts/session-sync-helpers.ts`。
- 结果：源码侧不再存在 `session-sync-helpers` 这个巨型聚合/兼容层，所有生产代码与测试都直接依赖各自 owner：
  - transport-open
  - reconnect
  - wire
  - visible-range
  - buffer-planner
  - pull-state
- 这是唯一正确的最终收口，因为只要聚合层还留在源码树里，即使当前 rg=0，后续也极易被继续当成“方便导入点”重新长出跨域依赖。物理删除才真正满足“重复/错误设计必须删除，而不是闲置”。
- 验证：
  - `rg -n "session-sync-helpers" android/src -g'*.ts' -g'*.tsx'` => no matches
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/contexts/session-sync-helpers.test.ts src/contexts/session-context-buffer-runtime.test.ts src/contexts/session-context-activity-runtime.test.ts src/contexts/session-context-session-runtime.test.ts src/contexts/session-context-transport-runtime.test.ts src/contexts/session-context-message-orchestration-runtime.test.ts src/hooks/useSessionOpenActions.test.tsx src/lib/open-tab-history-truth.test.ts --reporter dot` => `8 files / 99 tests passed`

[2026-05-08] active truth 第六刀收口（移除 open-tab active ref / pending switch 中间态）
- 继续审计后确认 `useOpenTabRuntime` 里还残留两份不必要的 active-side owner：
  1. `activeSessionIdRef`：只是 `openTabState.activeSessionId` 的镜像 ref
  2. `pendingTerminalActiveSwitch`：试图在 runtime active 未切到目标前临时覆盖 terminalActiveSession
- 这两者都不是独立真相，只会制造“open-tab active / runtime active / pending target”三层并行心智。
- 本轮收口：
  - 物理删除 `OpenTabRuntimeRefs.activeSessionIdRef`
  - 物理删除 `pendingTerminalActiveSwitch` state/ref 及其 begin/clear/settle effect
  - `terminalActiveSession` 只允许按单一优先级求值：`openTabState.activeSessionId -> runtimeActiveSessionId -> first terminalSession`
  - `useOpenTabSessionActions`、`useOpenTabLifecycleEffects`、`useTerminalShellActions` 改为直接读取 `openTabStateRef.current.activeSessionId`
- 当前 active 边界进一步冻结：
  - explicit tab focus truth = `openTabState.activeSessionId`
  - runtime transport focus truth = `SessionContext.state.activeSessionId`
  - renderer/UI shell 读取 explicit truth 决定当前 tab/pane；若 runtime 未同步，允许短暂显示旧 body，但不再引入第三份 pending 真相做补偿。
- 为什么这是唯一正确修改点：问题不在某个切 tab case，而在于 open-tab runtime 自己又发明了 `pending target` 这份第三真相。只要它存在，active 对齐问题就会永远变成三方仲裁。正确做法只能是把 active 真相重新压回两层：explicit client truth 与 runtime truth；删除第三层。
- 验证：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/hooks/useSessionOpenActions.test.tsx src/lib/open-tab-history-truth.test.ts src/App.dynamic-refresh.test.tsx src/hooks/useTerminalWorkspace.test.tsx -t 'active|switch|saved tab|runtime tab switching owned by applyOpenTabState|restored latest active|foreground resume|quick-tab current-tabs|split pane owner as the single truth' --reporter dot` => `4 files / 37 passed`

[2026-05-08] active truth 第七刀收口（禁止 runtime active 反向改写 explicit active）
- 继续审计后确认还残留一条错误语义：`deriveRuntimeOpenTabSyncDecision()` 在 `restoredTabsHandled=true` 后，仍允许 `runtimeActiveSessionId` 反向 merge 改写 `openTabState.activeSessionId`。
- 这违反当前冻结：explicit tab focus truth 属于 open-tab owner；runtime active 只表示 SessionContext transport/runtime 当前对齐到哪里，不能倒灌成 explicit truth。
- 本轮收口：
  1. 删除 `deriveRuntimeOpenTabSyncDecision()` 中 `restoredTabsHandled=true` 时的 `runtimeActiveSessionId -> merge activeSessionId` 分支
  2. 删除已无调用的 `resolveRuntimeActiveSessionIdForOpenTabs()`
  3. 回归测试改为钉死：restore settled 之后，runtime active 不得 backwrite explicit active
- 当前 active 合法方向只剩：
  - explicit active -> 若 runtime 未对齐，则产出 `switch` 决策去驱动 runtime
  - runtime session metadata -> 允许 semantic remap/rewrite existing tab id
  - runtime active 本身 **不得**反向覆盖 explicit active
- 为什么这是唯一正确修改点：问题不在 restore 某一帧，而在 `deriveRuntimeOpenTabSyncDecision()` 这个 active 协调 owner 把读侧 projection（runtime active）误当成写侧真相。只改 UI 或只改 App 调用都只是掩盖；必须删掉 owner 层的反写分支，才能从根上禁止 runtime 倒灌 explicit truth。
- 验证：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/lib/open-tab-intent.test.ts src/App.dynamic-refresh.test.tsx src/lib/open-tab-history-truth.test.ts -t 'does not let runtime active session backwrite explicit open-tab active truth after restore settles|keeps the normalized persisted active tab truth and rewrites runtime active session to match it when runtime sessions already exist|renders the persisted open-tab active session as terminal body truth even when runtime active session still points to another tab|persists active tab switch immediately from terminal UI intent' --reporter dot` => `2 files passed / 4 tests`

[2026-05-08] runtime active / session-context 审计（进行中）
- 下一刀按已冻结 open-tab truth 继续查 `SessionContext` runtime 是否仍有越权 active 写入。
- 重点文件：`session-context-session-runtime.ts`、`session-context-session-orchestration-runtime.ts`、`session-context-core.ts`、`session-context-infra-runtime.ts`。
- 审计目标：runtime create/reuse/connect 只能维护 runtime transport truth，不能主动抢 explicit open-tab active focus；若必须切 runtime active，必须能指向唯一调用入口。

[2026-05-08] open-tab -> runtime active bypass 审计结论（待收口）
- 虽然 `useOpenTabRuntime` 已把 runtime switch 收口到 `applyOpenTabState(..., { switchRuntime: true })`，但生产侧还残留两条旁路：
  1. `useSessionOpenActions.openDraftAsSession()` 通过 `createSession(..., { activate: true })` 直接让 SessionContext 抢 runtime active
  2. `useOpenTabRestoreRuntimeSync` 恢复 persisted tabs 时，对 active tab 也直接 `createSession(..., { activate: true })`
- 这两条路径的问题不是“效果错”，而是 active orchestration owner 错：它们把 runtime create 当成 tab focus switch。
- 唯一正确收口：open-tab/open-restore 创建 runtime session 一律 `activate: false`；真正的焦点切换只允许通过 `applyOpenTabState(..., { switchRuntime: true })` 发生。

## 2026-05-08 21:39 active truth audit补口
- 现象：open-tab explicit/runtime active 双真源收口后，仍存在“inactive create 也会偷偷变 active”的第三入口，导致 restore/bootstrap 后 active 选择被 runtime create 默认首个 session 污染。
- 真源定位：`src/contexts/session-context-core.ts` 的 `CREATE_SESSION` reducer 在 `activate=false` 且 `state.activeSessionId=null` 时仍执行 `state.activeSessionId || action.session.id`，把 runtime create 误升级为 active owner。
- 为什么这是唯一修改点：active 污染不是 UI、restore plan、switch 编排问题，而是 runtime session state reducer 自身把“创建 session”错误实现成“声明 active”。只改 reducer 才能全局切断所有 create 调用路径的越权；若在调用方补丁，会留下新的旁路。
- 处理：`CREATE_SESSION` 仅在 `activate=true` 时写 `activeSessionId`；inactive create 只追加 session，不得声明 active，也不得生成默认 live session。
- 证据：`src/contexts/session-context-core.test.ts` 新增两条回归；`src/App.dynamic-refresh.test.tsx` 相关 persisted-open-tabs / stale-getter / empty-open-tabs 回归保持通过。

# 2026-05-08 /goal 分析：owner map 审计 + P0 重构切片排序

## 范围
- 只读审计，不改代码。
- 对齐真源：`android/docs/architecture.md`、`2026-04-23-terminal-head-buffer-render-truth.md`、`2026-04-28-terminal-transport-session-lifecycle-truth.md`、`android/task.md`、`android/CACHE.md`、`android/MEMORY.md`、`android/note.md`、`.agents/skills/terminal-buffer-truth/SKILL.md`。
- 本轮目标：完成 owner map，明确重复写口 / 旁路 / 错误存活实现，给出 P0/P1/P2 排序；未进入设计/修改。

## 1. owner map

### 1.1 open-tab truth
- 唯一业务 owner：`android/src/hooks/useOpenTabRuntime.ts`
- 唯一持久化 owner：`android/src/lib/open-tab-persistence.ts`
- 纯规则 owner：`android/src/lib/open-tab-intent.ts`
- 编排入口：
  - restore / runtime sync：`android/src/hooks/useOpenTabRestoreRuntimeSync.ts`
  - 用户显式打开：`android/src/hooks/useSessionOpenActions.ts`
  - tab 交互：`android/src/hooks/useOpenTabSessionActions.ts`

结论：`OPEN_TABS / ACTIVE_SESSION` 的 explicit truth 基本收口到 open-tab runtime，其他入口应只是 orchestration，不应再长出第二 owner。

### 1.2 active session truth
- explicit active truth owner：`useOpenTabRuntime.ts` 的 `openTabState.activeSessionId`
- runtime active truth owner：`SessionContext` reducer `android/src/contexts/session-context-core.ts`

已确认风险：runtime primitive 仍然可能越权推进 active truth。
- `connectSessionRuntime()` 内：`if (options.activate) options.setActiveSessionSync(options.sessionId);`
- `createSessionRuntime()` 内：existing session reuse 分支在 `shouldActivate` 条件下仍会 `setActiveSessionSync(existingSession.id)`
- `switchSession()` 目前已纯化，只剩 `setActiveSessionSync(sessionId)`，这条本身没问题；问题是 create/connect primitive 仍可能暗中抢 active。

结论：这是当前最明确的 P0 双 owner 风险区。

### 1.3 runtime session truth
- 唯一 owner：`SessionContext` reducer + runtime family
  - reducer 真源：`android/src/contexts/session-context-core.ts`
  - create/connect/close/reconnect 编排：
    - `android/src/contexts/session-context-session-runtime.ts`
    - `android/src/contexts/session-context-session-orchestration-runtime.ts`

结论：runtime session truth 相对清晰，但 orchestration 太厚，create/connect/close/reconnect/retry/schedule 混在一起，后续要 block 化。

### 1.4 transport truth
- 当前 owner：`SessionContext` transport runtime family + `createSessionTransportRuntimeStore()`
  - runtime store：`android/src/lib/session-transport-runtime.ts`
  - accessors/glue：`android/src/contexts/session-context-transport-runtime.ts`
  - open intent / control-session transport 编排：
    - `android/src/contexts/session-context-transport-open-runtime.ts`
    - `android/src/contexts/session-context-transport-lifecycle-runtime.ts`
    - `android/src/contexts/session-context-transport-orchestration-runtime.ts`
- provider 装配 owner：`android/src/contexts/session-context-provider-core-assemblies.ts`

已确认：transport truth 没有漂到 page/UI；但 transport 编排仍读取 `stateRef.current.activeSessionId` / `liveSessionIds` 决定 live buffer 接收与 preparse drop，这部分是 transport->buffer gate，不是 owner；后续需继续确认是否可以再薄化。

兼容残留：
- `handleControlTransportMessage()` 仍支持 legacy `clientSessionId` 匹配 `session-ticket`
- `sessionTransportToken` 仍在 client runtime 中短期持有，当前看是 attach-only 兼容材料，不应上浮成业务真相

结论：transport owner 基本单一，但模块边界不够薄，且兼容字段残留需继续物理清除。

### 1.5 local sparse buffer truth
- 唯一 owner：`android/src/contexts/session-context-buffer-runtime.ts`
- shared/pure helpers：
  - `android/src/lib/terminal-buffer/*`
  - `session-buffer-planner-helpers.ts`
  - `session-pull-state-helpers.ts`
  - `session-visible-range-helpers.ts`
- message glue：`android/src/contexts/session-context-buffer-message-runtime.ts`

现状：buffer truth 基本正确地集中在 buffer runtime；但 `buffer-message-runtime` 多数只是 passthrough/wrapper，疑似可收口的薄中间层，需要在设计阶段判定是否冗余。

### 1.6 renderer visible range truth
- 当前 owner：`android/src/components/TerminalView.tsx`

现状：owner 单一，但文件过厚，混了：
- render body
- viewport measure
- visible range emit
- follow/reading
- cursor overlay
- DOM/input/focus
- swipe/tab/width mode

结论：visible range truth 虽集中，但 renderer orchestration 明显过厚，是 P0 后续切片。

### 1.7 pane/layout truth
- 当前业务 owner：`android/src/hooks/useTerminalWorkspace.ts`
- shared pure helpers：`@zterm/shared` workspace helpers
- persistence：`android/src/lib/workspace-persistence.ts`
- layout profile：`android/src/lib/terminal-layout-profile.ts`

结论：这是当前最接近理想结构的一块。shared 已经承担纯规则，hook 作为 owner 也合理。问题主要在 `TerminalPage.tsx` 还承担过多 shell glue。

### 1.8 quickbar truth
- 当前 owner：`android/src/components/terminal/TerminalQuickBar.tsx`
- 文件长度：2764 行

现状：把 quick action / shortcut / clipboard / floating bubble / drag / editor / toast / keyboard toggle / file/image/screenshot / split controls / measured height 全混在一起。

结论：不是单一职责 owner，而是巨型壳；应拆成多个 block + 薄 shell。

### 1.9 relay auth/device truth
- 持久化 / auth / device truth owner：`android/src/traversal-relay/store.ts`
- debug truth：`android/src/traversal-relay/client-debug-store.ts`
- transport/http glue：`android/src/traversal-relay/server.ts`

结论：`store.ts` 相对干净；`server.ts` 混了 auth page / HTTP route / token extract / device presence / ws relay / debug API，是明确的 P1 block split 候选。

## 2. 当前重复写口 / 旁路 / 错误存活实现

### 2.1 active truth 双 owner 风险（最高优先级）
证据：
- `session-context-session-runtime.ts`:
  - `connectSessionRuntime()` 在 `activate=true` 时直接 `setActiveSessionSync(sessionId)`
  - `createSessionRuntime()` 在 existing session reuse 分支里也可能 `setActiveSessionSync(existingSession.id)`

为什么危险：
- explicit active truth 已在 open-tab runtime
- runtime primitive 再持有 activate 语义，就会造成 create/connect 抢 active、restore/bootstrap 期间 active 被 runtime 反写

### 2.2 open-tab 虽已收口，但仍有多个 orchestration 入口写 `applyOpenTabState`
- `useSessionOpenActions.ts`
- `useOpenTabRestoreRuntimeSync.ts`
- `useOpenTabSessionActions.ts`

这本身未必错误，但必须在设计中明确：它们只能发 intent / orchestration，不能变成新的 owner。

### 2.3 `session-context-buffer-message-runtime.ts` 可能是冗余 facade
- 当前大量函数只是包装转发到 buffer runtime
- 若没有独立 assembly 价值，应在后续收口时物理删除，避免多一层含糊语义

### 2.4 `TerminalView.tsx` / `TerminalPage.tsx` / `TerminalQuickBar.tsx` 都是厚 orchestration
- `TerminalView.tsx`：renderer truth owner 过厚
- `TerminalPage.tsx`：pane/shell/keyboard/quickbar/sheet glue 过厚
- `TerminalQuickBar.tsx`：巨型壳，不符合 shared + blocks + thin orchestration

### 2.5 transport 兼容残留仍在
- legacy `clientSessionId` 匹配 `session-ticket`
- `sessionTransportToken` 短期 runtime 持有

这两者当前可视为兼容层材料，但后续应继续物理收口，避免再次向 daemon/client 真相扩散。

## 3. shared / block / orchestration 归属建议

### 3.1 应继续下沉到 shared 的 pure functions
1. open-tab normalize / dedupe / active resolve
2. session create/connect arbitration pure rules
3. transport open-intent / wire payload normalize
4. terminal viewport / pane geometry / IME offset 纯计算
5. renderer row diff / segment / style / gap marker 纯计算
6. quickbar action layout / shortcut normalization / double-tap rule
7. relay URL / target / auth normalization

### 3.2 应形成 block 的模块
1. open-tab block
2. active/runtime arbitration block
3. session runtime block
4. transport runtime block
5. buffer sync block
6. renderer viewport block
7. quickbar block
8. relay auth/device block

### 3.3 orchestration 应保留的薄壳
1. `SessionContext.tsx`：provider glue
2. `TerminalPage.tsx`：page shell + pane composition
3. `TerminalView.tsx`：DOM/input shell（拆薄后）
4. relay `server.ts`：route/socket glue

## 4. P0 / P1 / P2 切片排序

### P0-1 active/open-tab/runtime arbitration 收口（第一刀）
涉及：
- `src/hooks/useOpenTabRuntime.ts`
- `src/hooks/useOpenTabRestoreRuntimeSync.ts`
- `src/hooks/useSessionOpenActions.ts`
- `src/contexts/session-context-core.ts`
- `src/contexts/session-context-session-runtime.ts`
- `src/contexts/session-context-session-orchestration-runtime.ts`

为什么是第一刀：
- 这是当前最明确的双 owner 风险区
- 直接影响：active 错乱、open-tab 复活、create/connect 抢焦点、输入/刷新感知错位
- 不先收这条，后续 buffer/render 优化会继续被错误焦点语义污染

### P0-2 buffer/runtime/message facade 收口
涉及：
- `src/contexts/session-context-buffer-runtime.ts`
- `src/contexts/session-context-buffer-message-runtime.ts`
- `src/contexts/session-context-public-runtime.ts`

为什么第二刀：
- buffer truth 已较清晰，但 message facade 可能是多余层
- 不先理干净，renderer 很难继续变薄

### P0-3 TerminalView renderer truth 变薄
涉及：
- `src/components/TerminalView.tsx`
- shared render helpers

为什么第三刀：
- renderer visible truth 虽集中，但 orchestration 太厚
- 直接影响刷新稳定性、错误帧、输入/渲染互斥与性能

### P0-4 TerminalPage shell orchestration 变薄
涉及：
- `src/pages/TerminalPage.tsx`
- `src/hooks/useTerminalWorkspace.ts`
- quickbar/sheet shell glue

为什么第四刀：
- page 壳太厚，阻碍 pane/layout/keyboard/quickbar 的清晰边界
- 但必须在 active/buffer/renderer 之后做，否则只是搬代码不收真相

### P1
1. `TerminalQuickBar.tsx` block 化
2. `traversal-relay/server.ts` 拆成 auth/http + device presence + ws signaling + debug route

### P2
1. shared pure helpers 持续下沉
2. UI shell 继续瘦身
3. 大文件 ≤500 行清单逐轮清理

## 5. 当前结论
- owner map 已基本清晰。
- 当前最危险的不是 relay，不是 quickbar，而是 **active/open-tab/runtime arbitration**。
- 在这条链没收口前，不应该进入 buffer/render 大改。
- 下一轮应进入**设计阶段**，只设计 P0-1：
  - 明确 active truth 唯一 owner
  - runtime primitive 只负责 session existence / transport open，不再抢 active
  - old activate bypass 物理删除
  - 补 reducer / runtime / open-tab 回归


# 2026-05-08 /goal 设计阶段：P0-1 active/open-tab/runtime arbitration 收口方案

## 设计目标
本轮只设计一个主线真相：
- **active/open-tab/runtime arbitration**

成功标准：
1. `open-tab active truth` 成为唯一业务 owner
2. runtime primitive 不再拥有 `activate => 抢 active` 语义
3. `SessionContext.create/connect` 只负责 session existence + transport open，不再承担 tab 焦点业务语义
4. restore / explicit open / tab switch 统一由 open-tab orchestration 决定是否切 runtime active
5. 不引入 fallback，不保留双路径补偿

## 1. 现状链路（问题图）

当前 active 语义至少有两条写链：

### 链 A：显式 open-tab truth（正确方向）
- `useSessionOpenActions.ts`
  - 先 `createSession(... activate: false)`
  - 再 `applyOpenTabState(..., { switchRuntime: true })`
- `useOpenTabRuntime.ts`
  - `persistExplicitOpenTabs(...)`
  - `requestRuntimeActiveSessionSwitch(nextState.activeSessionId)`
  - `switchSession(nextActiveSessionId)`

这是正确链：
```text
user/restore intent
-> open-tab state truth
-> persist
-> request runtime active switch
-> SessionContext.switchSession()
```

### 链 B：runtime primitive 抢 active（错误方向）
- `session-context-session-runtime.ts`
  - `connectSessionRuntime()`：`activate=true` 时直接 `setActiveSessionSync(sessionId)`
  - `createSessionRuntime()`：reuse existing session 时 `shouldActivate` 直接 `setActiveSessionSync(existingSession.id)`
  - 新建 session 时 `createSessionSync(session, shouldActivate)`，最终 reducer `CREATE_SESSION` 也会写 active

这是错误链：
```text
create/connect primitive
-> runtime active mutation
-> activeSessionId changed
```

两条链同时存在时，App 层 explicit truth 与 runtime truth 会互相抢写。

## 2. 唯一 owner 设计

### 2.1 owner 冻结

#### open-tab active truth
唯一业务 owner：
- `useOpenTabRuntime.ts`

唯一含义：
- 当前 terminal 页显式打开了哪些 tabs
- 当前显式激活的是哪个 tab/session

#### runtime active truth
唯一运行时投影 owner：
- `SessionContext.activeSessionId`

唯一含义：
- 当前哪个 runtime session 正在被客户端 runtime 视为 active session

#### 两者关系
- `open-tab active truth` 是**业务真相**
- `runtime active truth` 是**执行投影**
- runtime active 只能由 open-tab orchestration 显式驱动同步
- runtime primitive 不得反向决定 open-tab active

换言之：
```text
open-tab truth -> runtime active projection
```
而不允许：
```text
runtime create/connect -> active truth owner
```

## 3. shared / block / orchestration 分层设计

### 3.1 shared pure functions
本刀新增/收口的 pure logic 应包括：
1. `shouldRuntimeSwitchAfterOpenTabStateChange(prevState, nextState, runtimeActiveSessionId)`
2. `resolveSessionCreateIntentActivation(...)`
3. `resolveSessionReuseIntentActivation(...)`
4. `resolveRestoreOpenTabRuntimeSwitch(...)`

要求：
- 不依赖 React
- 不依赖 context/page
- 只吃 plain data，输出 plain decision

### 3.2 block 层
本刀应形成两个稳定 block：
1. **open-tab block**
   - owner：explicit tabs + explicit active
   - 输入：user intent / restore intent / runtime sync result
   - 输出：persisted open-tab state + runtime switch request

2. **session runtime block**
   - owner：session existence / transport lifecycle
   - 输入：create/connect/close/reconnect primitive
   - 输出：runtime session state / transport intent
   - 不输出 active business truth

### 3.3 orchestration 层
保留：
- `useSessionOpenActions.ts`
- `useOpenTabRestoreRuntimeSync.ts`
- `useOpenTabRuntime.ts`
- `SessionContext.switchSession()`

不保留：
- `createSessionRuntime/connectSessionRuntime` 中的 active owner 语义
- `CREATE_SESSION` 把“业务激活”塞给 runtime primitive 的语义

## 4. 旧逻辑物理删除方案

### 4.1 删除 runtime primitive 的 active 抢写
必须物理删除：
1. `connectSessionRuntime()` 内 `if (activate) setActiveSessionSync(...)`
2. `createSessionRuntime()` reuse 分支内 `if (shouldActivate) setActiveSessionSync(...)`
3. `createSessionSync(session, shouldActivate)` 这种把业务 activate 直接下沉给 runtime reducer 的接口语义

### 4.2 createSession / connectSession 接口语义改造
把：
- `activate: boolean`

改成更窄的 runtime 语义，例如：
- `openTransport: boolean`
- 或 `connect: boolean`

原则：
- runtime primitive 只能知道“要不要连 transport”
- 不得知道“这是不是业务 active tab”

### 4.3 reducer 语义收口
`CREATE_SESSION` 不再承担业务 active 决策。
两种允许设计：

#### 方案 A（更推荐）
- `CREATE_SESSION` 永远不写 active
- active 只能由 `SET_ACTIVE_SESSION` 改

#### 方案 B
- `CREATE_SESSION` 仅支持 runtime bootstrap 特例，App 层业务 create 一律传 `activate=false`

本项目更适合 **方案 A**，因为最符合“单一 active 写口”。

## 5. 具体调用链改造设计

### 5.1 用户显式开 tab
保持：
- `useSessionOpenActions`：`createSession(... activate:false/connect:...)`
- `applyOpenTabState(... switchRuntime:true)`

最终链路：
```text
user open
-> create runtime session (inactive business-wise)
-> update explicit open-tab truth
-> persist
-> request runtime switch
-> switchSession()
```

### 5.2 restore persisted tabs
保持：
- `useOpenTabRestoreRuntimeSync` 中 restore 创建 session 时 `activate:false`
- restore 完成后，如存在 explicit active，则统一 `applyOpenTabState(... switchRuntime:true)`

### 5.3 runtime reuse existing session
改造后：
- `createSessionRuntime()` 只返回 existing sessionId
- 不得顺手 `setActiveSessionSync(existingSession.id)`
- 若上层要激活，必须由 open-tab orchestration 在 `applyOpenTabState(... switchRuntime:true)` 后切换

### 5.4 connect/reconnect
改造后：
- `connectSessionRuntime()` 只负责 transport prime/open
- 不得再碰 `activeSessionId`
- reconnect 也不得顺手抢 active

## 6. 测试设计

### 6.1 必补单测 / 定向回归

#### open-tab / active truth
1. `useSessionOpenActions`：显式打开 tab 后，active 切换只通过 `applyOpenTabState(...switchRuntime:true)` 发生
2. `useOpenTabRestoreRuntimeSync`：restore 期间 runtime create 不得偷写 active；最终 active 只由 explicit active 决定
3. `open-tab-intent`：runtime active 不得反写 explicit active

#### SessionContext / runtime
4. `createSessionRuntime` reuse existing session 时，不得再直接 `setActiveSessionSync`
5. `connectSessionRuntime` connect 时，不得再直接 `setActiveSessionSync`
6. `CREATE_SESSION` reducer 不得再承担业务激活语义（若采用方案 A，则直接钉死）
7. `switchSession()` 仍是 runtime active 的唯一入口

#### 回归防线
8. 不存在“runtime-only session 反向复活 open-tab”
9. 不存在“runtime create 偷偷抢 active”
10. restore 后 active 焦点与 persisted `ACTIVE_SESSION` 一致

### 6.2 本轮门禁
至少要跑：
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm --dir android exec vitest run` 针对：
  - `src/lib/open-tab-intent.test.ts`
  - `src/hooks/useSessionOpenActions.test.tsx`
  - `src/lib/open-tab-history-truth.test.ts`
  - `src/contexts/session-context-core.test.ts`
  - `src/contexts/session-context-session-runtime.test.ts`
  - 必要时 `src/contexts/SessionContext.ws-refresh.test.tsx` 定向子集

## 7. 为什么这是唯一正确修改点

因为当前问题不是“切换太慢”本身，也不是“UI 逻辑太厚”本身，而是：
- active 这个业务真相同时存在 App 层 explicit owner 和 runtime primitive owner
- runtime primitive 越权写 active，会持续污染：
  - open-tab restore
  - create/reuse session
  - connect/reconnect
  - tab 焦点
  - active refresh / input target

如果不先删除这条越权写口：
- 后续 buffer/render/page 优化只是在错误真相上修表象
- 任何“修刷新/修输入/修切 tab”都会继续被错误 active 语义重新破坏

所以本刀是唯一正确的第一刀。

## 8. 下一轮修改切口（严格最小切口）
下一轮只改：
- `session-context-session-runtime.ts`
- `session-context-session-orchestration-runtime.ts`
- `session-context-core.ts`
- 如有必要：`session-context-infra-facade-runtime.ts` 的签名
- 以及最小配套测试

明确不碰：
- buffer manager
- renderer
- TerminalPage / TerminalView
- relay
- quickbar



## 2026-05-09 未提交代码审计（当前工作区）

- `git diff` 仅存在 5 个未提交项：
  - `CACHE.md`
  - `android/.build-meta.json`
  - `android/release-dist/zterm-daemon-0.1.1-darwin-arm64.tar.gz`
  - `android/release-dist/zterm-daemon-0.1.1-darwin-arm64.tar.gz.sha256`
  - `android/release-dist/zterm-daemon-0.1.1-darwin-arm64/runtime/server.cjs`
- 结论：当前未提交代码**不是** P0-1 active/open-tab/runtime arbitration 半拆源码；P0-1 源码已经在主干源码中闭环存在，关键证据：
  - `session-context-core.ts` 的 `CREATE_SESSION` 已不再写 active
  - `createSessionRuntime()` reuse existing session 时不再抢写 active
  - `connectSessionRuntime()` 不再直接 `setActiveSessionSync(...)`
- 当前脏工作区主要是一次**未收口的 daemon release 打包**：
  - `release-dist/.../runtime/server.cjs` 内容对应源码中已存在的 server 侧能力（stable daemonHostId、changed-ranges buffer sync、cursorKeysApp、truecolor 修正）
  - 但源码本身未 dirty，说明这是构建/打包产物差异，不是新的真源改动
- 风险判断：
  - `CACHE.md` 属于会话/缓存污染，不能作为功能提交内容
  - `build-meta + release-dist` 目前缺少“这次为什么要发版”的闭环证据，暂不应直接提交
- 下一步唯一主线：
  1. 先清理/隔离这批 release 脏变更（尤其 `CACHE.md`）
  2. 再从当前真源代码继续 P0/P1 审计，而不是误以为还在修 P0-1 半拆
  3. 优先审计 session/tab 唯一真源与 open-tab/runtime owner 边界是否还有旁路

## 2026-05-09 buffer facade / TerminalView renderer owner map 审计

- 目标真源对齐：
  - `docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md` 已冻结：
    - daemon 只管 mirror/read api
    - buffer manager 只管本地 sparse buffer / request plan / merge
    - renderer 只管 visible range / follow-reading / renderBottomIndex
    - UI shell 只管容器、裁切、事件
- 当前代码与 prompt 的一个关键偏差：
  - `android/src/contexts/session-context-buffer-message-runtime.ts` **已不存在**
  - 当前仍存活的冗余 facade 是 `android/src/contexts/session-context-message-orchestration-runtime.ts`
  - 它内部仍在做：
    - `requestSessionBufferSyncRuntime(...)` 包装
    - `requestSessionBufferHeadRuntime(...)` 包装
    - `handleBufferHeadRuntime(...)` 包装
    - `applyIncomingBufferSyncRuntime(...)` 包装
  - 然后再把这些 wrapper 注入 `handleSocketServerMessageRuntime(...)`
- 当前 buffer-message 调用链 owner map：
  - `SessionContext provider core assemblies`
    -> `createSessionMessageOrchestrationRuntime(...)`
    -> local wrapper `applyIncomingBufferSync / handleBufferHead / requestSessionBuffer*`
    -> `session-context-buffer-runtime.ts`
  - 结论：buffer runtime 的唯一正确 owner 已经是 `session-context-buffer-runtime.ts`；
    `session-context-message-orchestration-runtime.ts` 对 buffer 部分只剩一层转发，没有独立业务真相，属于冗余 facade。
- 现状第二处架构问题：
  - `android/src/components/TerminalView.tsx` 仍有大量 renderer 纯逻辑内嵌：
    - `VisibleRow`
    - renderRows absolute-index/gap/discontinuous 计算
    - gap 占位视觉
    - cursor 列覆盖选择
    - 行号样式映射
  - 虽然 cell-level style / measure / scroll guard 已部分下沉到 `packages/shared/src/terminal/renderer.ts`
    ，但 row-level render model 仍在 Android component 内，不满足 thin orchestration。
- 现状第三处重复实现：
  - `packages/shared/src/react/terminal-view.tsx` 仍保留第二套 terminal row/cell render 逻辑
  - repo 内当前未发现活引用，但它仍是公开导出路径 `./react/terminal-view`
  - 若继续放任，shared react terminal-view 与 android TerminalView 将继续各自演化为两套 renderer 语义
- 本轮最小收口计划冻结：
  1. 删除 `session-context-message-orchestration-runtime.ts` 这层 buffer/message facade，
     在 `session-context-provider-core-assemblies.ts` 里直接装配：
     - `requestSessionBufferSyncRuntime`
     - `requestSessionBufferHeadRuntime`
     - `handleBufferHeadRuntime`
     - `applyIncomingBufferSyncRuntime`
     - `handleSocketServerMessageRuntime`
     - `handleSocketConnectedBaselineRuntime`
     - `finalizeSocketFailureBaselineRuntime`
  2. 将 `packages/shared/src/terminal/renderer.ts` 收口成目录模块：
     - `packages/shared/src/terminal/renderer/index.ts`
     - `packages/shared/src/terminal/renderer/row.ts`
     - `packages/shared/src/terminal/renderer/cursor.ts`
  3. 纯渲染逻辑下沉目标：
     - row/cell style mapping
     - gap row model
     - discontinuous line marker
     - cursor column / overlay metadata
     - double-width char helper
  4. `TerminalView.tsx` 保留：
     - DOM refs
     - viewport measure
     - scroll / touch / input 事件绑定
     - visible range emit
  5. 本轮明确不碰：
     - `TerminalPage.tsx`
     - `TerminalQuickBar.tsx`
     - relay / daemon


## 2026-05-09 TerminalView renderer orchestration 第二刀

- 继续对照 goal 成功标准审计：
  - `session-context-message-orchestration-runtime.ts` 已删除，buffer/message facade 不再存活。
  - `TerminalView.tsx` 仍未达到 thin shell：剩余残胶集中在 follow scroll sync、viewport relayout guard、follow/read reconcile 三组 renderer orchestration helper。
- 本轮唯一收口点：
  - 新增 `packages/shared/src/terminal/renderer/follow.ts`
  - 将以下 renderer orchestration 纯逻辑下沉到 shared：
    - `markTerminalFollowViewportRealignOnLayoutDrift`
    - `queueTerminalFollowScrollSync`
    - `cancelTerminalFollowScrollSync`
    - `flushTerminalFollowScrollSync`
    - `clearTerminalRecentViewportLayoutChange`
    - `handleTerminalFollowModeScrollGuards`
    - `alignTerminalRenderBottomToFollow`
    - `reconcileTerminalViewportAfterBufferShift`
- Android `TerminalView.tsx` 当前变化：
  - 上述 follow/read/guard/reconcile 逻辑已改为调用 shared pure helpers
  - 组件内已删除对应重复实现，不再在 page/component 内保留第二份同语义逻辑
- 当前仍未完全达到终态：
  - `commitMeasuredViewportState`
  - `emitWidthModeSignalIfNeeded`
  - `scheduleViewportResizeCommit`
  - `syncViewport`
  仍在 `TerminalView.tsx`，说明 shell 还没瘦到“只剩 DOM refs / 事件 / measure / emit”的最小形态
- 已验证：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/components/TerminalView.theme.test.tsx src/components/TerminalView.dynamic-refresh.test.tsx --reporter dot`
  - `pnpm dlx vitest run packages/shared/src/terminal/renderer.test.ts --reporter dot`
  - 结果：
    - Android TerminalView tests: `69 passed`
    - shared renderer tests: `13 passed`
    - tsc: green
- 结论：本轮继续削掉了一层 renderer orchestration 残胶，但 goal 还不能宣称完成；下一刀应继续收口 viewport measure / width-mode signal / resize commit 相关 helper，直到 `TerminalView` 只剩薄编排壳。

## 2026-05-09 P0-3 multi-pane 审计报告

### 1. 布局动态漂移根因
- `useTerminalWorkspace.ts:214-218`：每次 render 都调用 `resolveMaxSplitCount(viewportWidth, viewportHeight, 0.22, maxSplitCount)`。
- `viewportWidth` 来自 `TerminalPage.tsx:983`，会随窗口 resize、键盘弹起等事件更新。
- `resolveMaxSplitCount` 在 `workspace-model.ts:204` 中每次调用都重新计算 `Math.floor(safeWidth / (safeHeight * minAspect))`。
- 当键盘弹起时 `viewportHeight` 变小，导致 `currentMaxSplitCount` 从 4 降为 3 或 2，触发 `useEffect:230-266` 强制合并 pane，然后再拆分回来，造成 3.5→2.5 屏跳变。
- **根本问题**：分屏数量应由横竖屏方向决定，不应随 IME 高度变化。`viewportHeight` 变化不应影响 pane 数量。

### 2. multi-pane 刷新行为
- `TerminalView.tsx:232`：`refreshActive = live ?? active`，其中 `live` 在 `TerminalPage.tsx:580` 硬编码为 `true`。所以所有 visible pane 的 TerminalView 组件内 `refreshActive` 均为 `true`。
- 这意味着渲染循环不会因 inactive pane 而停止。非 active pane 理论上应该持续刷新。
- 但用户报告"非 P1 的 pane 白屏"，说明问题可能在 buffer sync 分发层：head/sync 请求可能只在 active session 上发送。
- 当前 `session-context-buffer-runtime.ts` 没有多 pane 订阅概念，head refresh 和 buffer sync 是针对单个 session 的；如果 TerminalPage 只为 active session 发起请求，其余 pane 将收不到数据。

### 3. head 请求缺乏去重
- 同一 session 出现在 2 个 pane 时，每个 TerminalView 各自触发 head request，daemon 收到 2 次相同请求，浪费带宽。
- 当前无去重机制。

### 4. UI 浪费空间
- `terminal-layout-profile.ts` 的 splitVisible 布局 header 仍保留 back 按钮 + 多行 tab，在横屏设备上浪费约 80-100px。
- 工具栏在分屏时仍占据底部 2 行空间（约 100px），没有折叠或浮窗化。

### 5. 现有测试状况
- 无 multi-pane 专用测试。
- 现有 949 个测试需保持全部通过。


## 2026-05-09 TerminalView renderer orchestration 第三刀（viewport/resize/width-mode）

- 继续对照 goal 审计：上一轮 follow/read/guard 已下沉，但 `TerminalView.tsx` 仍残留 viewport/resize/width-mode 决策逻辑，未达到 thin orchestration shell。
- 本轮新增 `packages/shared/src/terminal/renderer/viewport.ts`，下沉纯决策：
  - `buildTerminalMeasuredViewportState`
  - `hasTerminalViewportLayoutChanged`
  - `resolveTerminalWidthModeSignal`
  - `resolveTerminalResizeCommitPlan`
- `TerminalView.tsx` 当前变化：
  - `commitMeasuredViewportState` 改为消费 shared state builder
  - `emitWidthModeSignalIfNeeded` 改为消费 shared width-mode signal resolver
  - `scheduleViewportResizeCommit` 改为消费 shared resize commit plan resolver
  - `syncViewport` 的 layout-drift 判定改为消费 shared helper
- 这刀的意义：
  - viewport/resize/width-mode 的判断规则不再散落在 React component 内
  - `TerminalView` 继续朝“只剩 refs / event bind / effect wiring / DOM measure / emit”靠拢
- 已验证：
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
  - `pnpm --dir android exec vitest run src/components/TerminalView.theme.test.tsx src/components/TerminalView.dynamic-refresh.test.tsx --reporter dot`
  - `pnpm dlx vitest run packages/shared/src/terminal/renderer.test.ts --reporter dot`
  - 结果：
    - Android TerminalView tests: `69 passed`
    - shared renderer tests: `16 passed`
    - tsc: green
- 当前状态：
  - facade 删除：已完成
  - row/cursor/follow/viewport 纯逻辑下沉：已完成
  - 仍待最终审计 `TerminalView` 是否还剩超出 thin orchestration shell 的真相逻辑；若没有，即可进入本 goal 完成审计。

## 2026-05-09 multi-pane 布局静态化设计（第 2 步）

- 本轮只做 layout owner 收口，不扩散到 buffer/runtime/TerminalPage。
- 当前双语义问题：
  1. `resolveMaxSplitCount(viewportWidth, viewportHeight, ...)` 每次 render 按即时高宽重算 pane 上限。
  2. `useEffect(currentMaxSplitCount)` 会在 IME 改变 `viewportHeight` 后强制 merge pane。
- 正确 owner：
  - `workspace-model.ts` 提供单一 pure truth：`resolveStaticPaneLayout(...)`
  - `useTerminalWorkspace.ts` 只保存 `layoutSnapshot`，仅在显式布局源变化时更新
- 本轮冻结语义：
  1. pane 数量上限只由 `viewportWidth + landscape/portrait orientation + hardCap` 决定
  2. IME / resize 导致的纯高度变化不得降低 split count
  3. 已有 pane size 只在显式 `setSplitCount/toggleSplit/attach/close` 或 layout bucket 真正变化时重分配
- 计划最小切口：
  1. shared 新增 `resolveStaticPaneLayout`
  2. `useTerminalWorkspace` 用 `layoutSnapshotRef/state` 保存 `maxSplitCount + paneSizes`
  3. 删除对 `viewportHeight` 的即时重算依赖，改成 orientation + width 主导
  4. 补 shared + hook 定向测试：验证高度变化不会把 4 pane 压回 2/3 pane

## 2026-05-09 multi-pane 布局静态化验证

- 已实现：`resolveStaticPaneLayout(previousLayout)`，同 orientation 下冻结 baselineHeight，IME 仅改即时高度，不改 split capacity。
- 已实现：`useTerminalWorkspace` 改为 layout snapshot truth；只有 `layoutSourceKey` 真变化时才更新 snapshot。
- 已验证：
  - `pnpm dlx vitest run packages/shared/src/workspace/workspace-model.test.ts --reporter dot` -> 4 passed
  - `pnpm --dir android exec vitest run src/hooks/useTerminalWorkspace.test.tsx --reporter dot` -> 4 passed
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` -> green
- 当前结论：4 pane 在 IME-style 高度缩小时不再被 layout owner 压回 2/3 pane；下一步进入 visible pane subscriptions / head-sync 去重。

## 2026-05-09 multi-pane UI shell 瘦身（第 4 步进行中）

- 当前唯一修改点收口到 `terminal-layout-profile.ts`：
  - 新增 `mode: single-pane | split-default | split-landscape`
  - split + landscape 不再沿用普通 split profile，改走独立紧凑 profile
- 当前冻结：
  1. header 压缩规则只允许从 layout profile 取，不允许在 `TerminalPage/TerminalHeader` 散写尺寸
  2. `split-landscape` 下 header 垂直占用明显缩小（outerPadding/tabMinHeight/paneScrollerMinHeight/backButtonSize 全部下调）
  3. page/header 通过 `resolveTerminalOrientation()` 只读消费 landscape truth，不在本轮引入第二套方向状态机
- 当前尚未完成：
  - QuickBar 默认折叠/浮窗化策略还未接入 profile owner
  - pane active/idle 边框细节后续继续收

## 2026-05-09 multi-pane refresh / head 去重强证据补齐（本轮提交）

- 本轮没有再改 daemon / relay / login；只补 client multi-pane goal 的真实链路证据与现有收口代码提交。
- 已确认本轮 owner 仍然单一：
  - layout truth -> `terminal-layout-profile.ts` / shared workspace model
  - visible pane refresh truth -> `SessionContext lifecycle + activity runtime`
  - sync debounce truth -> `requestSessionBufferSyncRuntime(...)`
- 新增/补强证据：
  1. `SessionContext.ws-refresh.test.tsx`
     - `active tick refreshes a stale visible non-active pane...`
     - `active tick keeps stale visible panes refreshing after interactive active tab switches away`
     - `active tick deduplicates duplicate live-pane references for the same session in the real SessionContext loop`
  2. 这些测试直接钉死：
     - non-active 但 visible 的 pane 在 stale 后仍会收到 head 请求
     - active 切换后，旧 visible pane 不会停止 active-tick refresh
     - 同一 session 即使在 live pane 引用里重复出现，真实 SessionContext loop 也只发 1 次 head request
- 已跑验证：
  - `pnpm --dir android exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx -t "active tick refreshes a stale visible non-active pane without requiring it to become interactive active|active tick keeps stale visible panes refreshing after interactive active tab switches away|active tick deduplicates duplicate live-pane references for the same session in the real SessionContext loop" --reporter dot`
  - `pnpm --dir android exec vitest run src/contexts/multi-pane-refresh.test.ts src/contexts/session-context-buffer-runtime.test.ts src/contexts/session-context-lifecycle.test.tsx src/hooks/useTerminalWorkspace.test.tsx src/lib/terminal-layout-profile.test.ts src/components/terminal/TerminalHeader.test.tsx --reporter dot`
  - `pnpm dlx vitest run packages/shared/src/workspace/pane-layout.test.ts packages/shared/src/workspace/workspace-model.test.ts --reporter dot`
  - `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- 当前仍未收口项：
  - quickbar 默认折叠/浮窗策略还没接到唯一 owner，不能宣称本 goal 已完整完成
  - 但 multi-pane 的 layout 静态化 + visible pane refresh 真实链路 + head/sync 去重证据已经可以形成本轮干净提交
