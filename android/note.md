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
