# Terminal Test Loop & Checklist

> 目的：把 terminal 线上问题收敛成固定的**本地回环**、**现场检查清单**、**提包前门禁**。  
> 本文档不定义角色语义；角色真源仍以 `docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md` 为准。

## 1. 先看结论

任何 terminal 问题，都必须先回答这 4 个问题：

1. **tmux truth 变了吗**
2. **daemon 回的 head / range 对吗**
3. **client buffer manager 有没有按绝对行号 merge**
4. **renderer 有没有把已有内容正确画出来**

如果这 4 个问题里任何一个没有证据，就不允许说“已定位”。

配套的“当前已有测试覆盖 / 缺口表”固定见：

- `docs/terminal-test-matrix.md`

---

## 2. 不变量清单

### 2.1 daemon

- daemon 只维护 tmux mirror truth
- daemon 只回答：
  - `buffer-head-request`
  - `buffer-sync-request`
- 每次回复都带当前 head
- `head/range` 请求路径**不得触发** tmux capture / mirror rebuild
- daemon **不得因为 cursor/selection/transient visual state 改写 buffer cells**
- cursor 若需要下发，必须是**独立 metadata**，不能写进 `lines[].cells[].flags`

### 2.2 client buffer manager

- 本地 buffer 以**绝对行号**为真源
- 允许 sparse
- 允许 gap
- **窗口错 / anchor 错 / head mismatch != buffer 丢失**
- buffer manager **无权**清空已有本地 absolute-index truth
- 只能：
  - 问 head
  - 请求 range
  - merge
  - 标 gap
  - 滑动窗口
  - 通知 renderer
- active / inactive 只影响取数，不影响 logical session / transport 存活
- reconnect 必须重试同一个 session identity，不得借机重建第二份 session 语义

### 2.2.1 session / transport 生命周期

- `bridge target = bridgeHost + bridgePort + authToken`
- 每个 bridge target 只允许一个长期存活的 **control transport**
- 每个 `clientSessionId` 只允许一个稳定的 **per-session transport**
- client session 是稳定业务对象
- ws / rtc transport 是可替换物理连接
- control transport 只做 auth / create / attach / resume / close
- head / range / input 只走 per-session transport，不复用到 control transport
- session attach / resume 必须复用 control transport，但不能把每个 session 的高频流量都塞回 control transport
- inactive tab 只停取数，不关 session / transport
- ws close 只说明 transport 死，不说明 session truth 作废
- daemon 端 reconnect 必须绑定回同一个 `clientSessionId`
- daemon shutdown 才是统一资源回收点；client 显式 close 是单 session 回收点

### 2.3 renderer

- renderer 只消费内容池 + 当前 render window
- follow / reading 只影响窗口，不影响 buffer truth
- 当前窗口不连续时，只能画：
  - 已有内容
  - 空白 gap 占位
- **不能**把“窗口不连续”解释成“已有内容不存在”
- `mirror-fixed` 下长行只能裁切，不能换行/重排/回写上游宽度
- `mirror-fixed` 下横向查看只改 renderer horizontal window
- `mirror-fixed` 下若当前没有独立 horizontal pan 手势链，左右滑切 tab 仍必须可用
- `adaptive-phone` 若要适配手机，最多只允许写 `cols`；不得因为手机容器高度去写 tmux rows
- `adaptive-phone` upstream width 必须由 daemon 统一计算：
  - 多连接时取最小 cols
  - 连接断开后立刻重算
  - tmux 高度不得跟随这条链路变化

### 2.4 UI shell / IME

- UI shell 只负责容器位置 / 裁切 / keyboard 抬升
- IME 不得进入 buffer / render 真相链
- terminal 内容层不要因为 shell transform / 合成层错误而被误判成 buffer 问题
- QuickBar / 快捷菜单整块 shell 区域都必须阻断非交互点击；空白区域点击不得穿透触发 ImeAnchor / terminal focus
- `keyboardInsetPx > 0` 时，QuickBar shell rows 必须整体抬升到键盘上方，不能被 IME 覆盖
- Android IME 弹起时，header 顶部 inset 必须保持稳定；`visualViewport.offsetTop` 不得把顶部空白再抬一遍
- Android connect / reconnect 不得把当前容器测得的 `cols/rows` 发给 daemon 改 tmux geometry；键盘/前后台/容器高度变化都只能改 UI shell 容器与 renderer 可见窗口
- Android runtime 后续 rows 必须冻结：初始化后不得再因为 keyboard / IME / safe-area / 前后台 / 容器高度变化改 tmux rows

---

## 3. 固定本地测试回环

顺序固定：

```text
tmux oracle
-> daemon contract
-> client buffer manager
-> renderer commit
-> Android jsdom/app loop
-> daemon close loop
-> APK 真机 smoke
```

任何 terminal 问题都要先尽量压回前 5 层，不要直接靠真机手点猜。

---

## 4. 最小自动回归组

### Group A. server contract

必须长期覆盖：

1. `buffer-head-request -> buffer-head`
2. `buffer-sync-request -> buffer-sync`
3. `buffer-sync` 只返回请求区间
4. 每次 reply 都带 `availableStartIndex / availableEndIndex / latestEndIndex / revision`
5. 不允许把 `buffer-sync-request` 变成别的 ack 语义
6. cursor 不得改写任何 buffer cell；有无 cursor 时 `lines` 必须保持同一 tmux truth

### Group B. buffer manager orchestration

必须长期覆盖：

1. cold start active tab 会主动先问 head
2. local 空窗时直接拉 head 往回三屏
3. 离 head 不远时只补 diff
4. reading 才补 gap
5. 同 endIndex 但 revision 前进时仍会触发 tail refresh
6. `buffer-head` 不会卡死 in-flight pull
7. `buffer-sync` apply 后会通知 renderer
8. **local window invalid 不得清空已有 absolute-index truth**
9. inactive tab 只停轮询，不 close transport/session
10. reconnect 仍使用同一 session identity
11. same target 下多个 session 不共享 reconnect fate
12. foreground resume 优先复用原 session transport，不 fresh recreate session

### Group C. renderer orchestration

必须长期覆盖：

1. cold start first paint
2. switch tab first paint
3. follow 收到新 head/buffer 会 commit
4. reading 上滚不会被 live update 拉回
5. 输入会退出 reading 回到底部
6. 底部继续下拉/拖动不会把已有内容画空
7. 当前窗口有 gap 时继续画已有内容 + 空白 gap 占位
8. `mirror-fixed` 长行默认左裁切，不本地重排
9. `mirror-fixed` 横向平移只移动 renderer 列窗口，不改 buffer / head
10. `mirror-fixed` 在当前未接入独立 horizontal pan 手势链时左右滑切 tab 仍可用
11. 混合 `ASCII + CJK double-width` 时，renderer 必须按实测像素列宽稳定对齐，不能因为 `1ch / 2ch` 假设导致整行错位
12. `adaptive-phone` 只在 width truth / cols 变化时上报；纯高度变化不会重复触发上游 geometry write
13. daemon 对 tmux 的 adaptive reconcile 只允许改 `cols`；任何场景都不得把 tmux `rows` 改窄/改宽

### Group D. Android IME / input loop

必须长期覆盖：

1. 英文 / 数字 / 空格 / 回车立即发出
2. quick editor blur 后 terminal 会重新接管 IME
3. 输入后 active tab 会进入 `input -> head -> sync -> render`
4. **语音输入法转文字 / 中文 commit** 不需要再补一个字符才刷新
5. 输入后不会进入“界面刷新但 terminal 再也收不到输入”的死态
6. 输入发出后、mirror 未返回前，terminal 可见内容不得先本地变化
7. 若 `latestEndIndex` 不变但 `revision` 前进，**同一个 viewport range** 也必须允许再次发 `buffer-sync-request`；旧 in-flight request 不能只按 range 覆盖新 revision
8. `buffer-head` 若已带 `cursor` metadata，client 必须立刻更新本地 cursor truth；不能丢掉后等下一次 `buffer-sync`
9. QuickBar shell 空白区域点击不会弹出 IME
10. keyboard 弹起时 QuickBar shell rows 始终可见，不被 IME 盖住
11. keyboard 弹起时 header 顶部 inset 不会突然变大，不会出现顶部空白被多算一遍
12. keyboard 弹起 / reconnect / 前后台恢复后，tmux rows 不会被 Android UI 容器高度改写
13. **长语音 commit 期间**：单次 IME `input` 回调到 `ws.send()` 的同步链不得超过一个微任务周期；同步链累计阻塞不得超过 16ms
14. **长语音 commit 期间**：`session-context-socket-runtime.startSocketHeartbeat` 在 `ws.readyState !== OPEN` 时必须显式重置 `consecutiveMisses` 和 `lastObservedServerActivityAt`
15. **长语音 commit 期间**：`session-context-input-runtime` backpressure close 后 reliable 协议路径必须有指数 backoff，禁止 close → 立即 retry 死循环
16. **长语音 commit 期间**：`session-context-input-runtime` flush 期间每次 send 后必须重读 `ws.bufferedAmount`，不允许只在函数入口读一次
17. **长语音 commit 期间**：`TerminalPage.tsx` IME `input` listener 与 `emitRemoteWindowInputEvents` 串行竞态时，remote-window overlay 中间态必须 fallback 到 terminal input 并 log warning

### Group D.1 prompt / input row parity

必须长期覆盖：

1. 输入后的 terminal 可见内容只允许由 `buffer-sync` 驱动变化
2. prompt / input row 的 `char / fg / bg / flags` 必须可回放、可比对
3. daemon cursor 不得写进 buffer；cursor truth 必须独立于 `lines`

### Group E. daemon mirror close loop

必须长期覆盖：

1. `initial-sync`
2. `local-input-echo`
3. `external-input-echo`
4. `daemon-restart-recover`
5. `top-live`
6. `vim-live`

### Group E.1 session / transport lifecycle

必须长期覆盖：

1. same `clientSessionId` reconnect 会复用 daemon logical session
2. ws close 只 detach transport，不删除 daemon logical session
3. inactive tab 不会触发 client side close / daemon side close
4. daemon shutdown 会统一回收 logical session / transport / mirror
5. same target multi-session 时，一个 session 的旧 transport 卡住不会挡住兄弟 session
6. foreground / active re-entry 复用原 session transport；若 socket 仍为 `OPEN`，只允许 request-head / ping 观测，不得因安静或 stale activity reconnect
7. `session-context-socket-runtime.startSocketHeartbeat` 在 socket 切换 / 重新 attach 后，必须显式重置 heartbeat 内部状态（`consecutiveMisses`、`lastObservedServerActivityAt`），不得让旧 socket 的 timeout 状态污染新 socket

### Group F. APK smoke

最少手工验证：

1. 冷启动进入单个 active tab，等待首屏刷新
2. 从 tab-A 切到 tab-B，等待 tab-B 首屏刷新
3. 后台恢复
4. 输入英文 / 数字 / 空格 / 回车
5. 语音输入法转文字
6. reading 连续上滚 / 下滚到底
7. daemon 重启恢复

---

## 5. 现场问题 -> 优先检查哪一层

### 5.1 初次连接几十秒不刷新

优先查：

1. active tab 是否真的进入 `head-first` 主循环
2. 有没有 `buffer-head-request`
3. 收到 head 后有没有 `buffer-sync-request`
4. 有没有首个 render commit

### 5.2 输入发出后几分钟不刷新

优先查：

1. IME/input 事件有没有真的发出
2. active ws 是否还活着
3. `sendInput -> buffer-head-request(force)` 是否发生
4. `buffer-sync -> local apply -> render commit` 是否断链

### 5.3 语音输入法转文字后不自动刷新，得再输一个字符

优先查：

1. native IME commit 事件是否到达
2. composition / commitText / finishComposingText 是否被 client 截断
3. 是否只有“下一个字符”才触发 commit

### 5.4 刷新时白屏 / 花屏 / 底部继续下拖出现错位

优先查：

1. renderer scope 是否只等于 visible pane
2. terminal shell 是否用了 transform 抬整个 scroll layer
3. 当前 frame 是否已有内容却被画空
4. 是合成层错位，还是 buffer 真没 apply
5. 是否把长行按手机宽度错误重排，导致背景/光标 span 裁切错位

### 5.5 带宽突然出现 5MB 级高峰

优先查：

1. client 是否反复触发 tail re-anchor
2. 是否错误走了大窗重拉
3. 是否仍有 snapshot / full-tail / second semantics 残留
4. `buffer-sync-request` 的 `requestStartIndex / requestEndIndex` 实际是多少

### 5.6 看起来像“正文解析错了”

优先查：

1. 这是 **terminal body** 还是 **IME/editor overlay**
2. daemon compact wire 的正文 mixed row roundtrip 是否真红
3. renderer 是否把 cursor metadata / overlay 叠进了普通 body row
4. 若只有底部编辑条错，而 body payload parity 正常，先修 IME/editor，不要回退 daemon codec

### 5.6 输入后开始刷新，但随后又无法输入

优先查：

1. IME anchor 是否失焦
2. quick editor / keyboard state / terminal focus 是否互相抢焦点
3. native input 事件是否还在发
4. active transport 是否断了却没立刻 reconnect

### 5.7 某个 session 切回来后挂住，杀 app 重进又立刻恢复

优先查：

1. 当前“connected/open”是否只是旧 socket 表象，而不是活的 transport
2. active re-entry / foreground resume 时，旧 in-flight pull bookkeeping 是否已经清掉
3. active re-entry 后是否真的出现新的 `buffer-head-request`
4. 若 head / pong / 任意 server activity 都没有推进，是否仍只在原 `OPEN` transport 上 request-head / ping 观测，而不是把安静误判为失活并重建

### 5.8 某些 tab 一切回来就重连很慢 / 某些 tab 直接挂住

优先查：

1. inactive tab 是不是被错误 close 了 session / transport
2. reconnect 是不是又在走 “new ws + new logical session” 而不是 same-session retry
3. daemon ws close 时是不是把 logical client session 直接删了
4. 同 host 多 tab 是否被错误串进同一个重连闸门，导致 active tab 被 hidden tab 阻塞

### 5.9 长语音 commit 后立即出现 “连接已断开，正在重连” banner

优先查：

1. `session-context-socket-runtime.startSocketHeartbeat` 在 `ws.readyState !== OPEN` 期间是否冻结了 `consecutiveMisses`（BUG #1）
2. `session-context-input-runtime` backpressure close 后是否进入死循环 retry（BUG #2）
3. `session-context-input-runtime` flush 期间 `bufferedAmount` 实际累积是否超出阈值但函数未感知（BUG #3）
4. main thread 是否被同步 IME commit 链阻塞超过 16ms（BUG #4）
5. remote-window overlay 中间态是否吞掉 IME input（BUG #5）

### 5.10 无串流时 UI 也卡 / 输入延迟高（性能专项）

真机判断口径：`adb shell dumpsys gfxinfo com.zterm.android` 看
`Number High input latency` 与 janky 占比；`dumpsys meminfo` 看设备剩余内存
（< 1G free 时 WebView GC 会放大 JS 热点）。

静态热点按优先级排查（每个 wire buffer-sync frame 触发一次）：

1. **P0 `session-buffer-store.commitBuffer` 必须行级复用**：禁止对全部行做
   `row.map(cell => ({...cell}))` 全量深拷贝；未变行（`row === previousRow`）
   必须复用引用（与 `session-render-buffer-store.cloneRenderBuffer` 一致）。
   前置契约：commit 的 buffer 必须来自 immutable 的 `applyBufferSyncToSessionBuffer`，
   调用方 commit 后不得原地修改任何行内容。
2. **P1 双重 `sessionBuffersEqual` 必须去重**：`session-context-buffer-runtime`
   在 commit 前已做全量比较，`commitBuffer({ skipEqualCheck: true })` 必须跳过
   store 内第二次 O(rows×cols) 比较。
3. **P1 渲染签名禁止按行引用缓存**（⚠ 曾引入后回滚）：`terminalRowRenderSignature`
   必须每帧从真实内容重算。禁止 `WeakMap<row, signature>` 按行引用缓存——
   bottom-stale 回归契约要求「行引用不变但 cell 内容（如 bg）原地变化」时
   签名必须变化并触发重绘；行引用不可变假设在 mirror 原地 mutate 路径上
   不成立，缓存会导致 vim/htop 底部状态区样式更新丢失。签名重算成本远低于
   P0/P1a 已消除的深拷贝与双重比较。

防复发 gate：性能回归测试锁定「未变行引用复用」「skipEqualCheck 行为」
「签名内容敏感（原地 mutate 必须变签名）」，任一被打破即 FAIL。

### 5.11 copy 长按选择的取消路径（左侧长按选择中间/上面/下面后无法取消）

交互契约：

1. copy 模式中已有选择高亮（起点或终点已设）或菜单弹出时，**在终端行上
   短按（pointerdown→pointerup，未达长按阈值 420ms）必须取消整个选择**
   （调 `onCopySelectionDismiss` → `handleCloseCopyMenu` → EMPTY）。
   长按（达阈值）仍然是「弹出菜单/重新选择」，二者不冲突。
2. `TerminalPageCopyMenu` 必须渲染全屏透明 backdrop（zIndex 低于菜单），
   点菜单外任意位置触发 `onClose` 取消；菜单本体 `onPointerDown`
   preventDefault+stopPropagation 防穿透。
3. 取消后必须 `keepTerminalInputFocused()` 恢复输入焦点。

防复发 gate：取消路径红测（短按取消 / backdrop 关闭 / 取消后焦点恢复）
任一被打破即 FAIL。禁止恢复「短按无反应」或「菜单只能靠关闭按钮退出」。

### 5.12 remote-window 缩小后滚动黑屏（双流切流卡死无兜底）

根因：双流模式点缩略图/窗口 tile 切 focus 进入 `overview-crop-visible` 后，
video opacity 被置 0、画面完全交给 crop canvas；而 canvas 绘制依赖
`video.readyState >= 2` 与 focus-result 消息（accepted/ready）到达，
runtime 状态机无任何超时兜底——消息因 streamId/targetId/revision 不匹配被吞
（见 MEMORY：streamTargetId 与 windowId 混用）即**永久卡在 overview-crop-visible，
video 恒 opacity 0 = 黑屏**；`handleShrink` 缩回浮窗也不重置切流状态。

修复契约：

1. **video 不再因 `overviewCropVisible` 置 opacity 0**：crop canvas 是
   绝对定位透明层，未绘制时透出 video；已绘制时覆盖放大图。video 可见性
   只由 `videoHasPlayed` 控制（2d4bdda visibility 锁可见仍保留）。
2. **切流超时兜底**：进入 `overview-crop-visible` 后 3s 未收到
   accepted/ready/error → `resetRemoteWindowDualStreamSwitch` 回
   `focus-committed`（保留 activeTargetId），video 恢复显示。
3. **`handleShrink` 重置切流状态**：缩回浮窗时强制退出
   switch-requested/overview-crop-visible/focus-updating/focus-ready/error。

防复发 gate：`remote-window-dual-stream-runtime.test.ts` 锁 reset 行为；
`RemoteWindowOverlay.test.tsx` 锁「切流中 video opacity 保持 1（canvas 透明层）」
「3s 超时回 focus-committed」「shrink 重置切流状态」，任一被打破即 FAIL。

---

## 6. 结构化日志清单

### 6.1 daemon

至少要能回答：

- current revision
- availableStartIndex
- availableEndIndex
- 本次 reply type
- 本次 range start/end
- payload 行数

### 6.2 client buffer manager

至少要有：

- `session.buffer.head.recv`
- `session.buffer.request`
- `session.buffer.sync.apply.before`
- `session.buffer.sync.apply.after`
- `session.buffer.pull.start`
- `session.buffer.pull.complete`
- `session.buffer.pull.deadlock`
- `session.buffer.truth-violation`（若代码试图 reset 已有 local truth，必须显式打出来）

### 6.3 renderer

至少要有：

- `session.render.first-paint`
- `session.render.commit`
- `session.render.mode-change`
- `session.render.follow-reset`
- `session.render.visible-gap`
- `session.render.blank-frame`
- `session.render.width-mode`
- `session.render.horizontal-window`
- `session.render.tab-swipe-disabled`

### 6.4 Android IME

至少要有：

- `ImeAnchor.show/hide/blur`
- `ImeAnchor.focus`
- `ImeAnchor.keyboardState`
- `ImeAnchor.commitText`
- `ImeAnchor.finishComposingText`
- `ImeAnchor.emitInputText`

---

## 7. 真机检查清单

每次真机现场按顺序看：

### 7.1 连接前

- 当前 app 版本号
- 当前 bridgeHost / bridgePort / authToken 真源
- 当前 active tab 是谁

### 7.2 刚连上

- overlay 的 `R / P / 上下行`
- 有没有先出现 head 再出现 pull
- 首屏是否自动出现，不靠输入触发

### 7.3 输入测试

逐项验证：

1. 英文
2. 数字
3. 空格
4. 回车
5. 中文输入法
6. **语音输入法转文字**

每项都要回答：

- 输入事件是否发出
- tmux truth 是否变化
- renderer 是否自动刷新
- 是否需要补一个字符才刷新

### 7.4 滚动测试

逐项验证：

1. follow 底部轻微上滑 -> reading
2. reading 连续上滚
3. reading 下滚到底 -> follow
4. follow 态继续下拖 / overdrag

每项都要回答：

- mode 是否正确
- render window 是否正确
- 是否花屏 / 白屏 / 抖动

---

## 8. 提包前门禁

准备 APK 前必须满足：

1. docs / skill 已更新
2. 自动回归先转绿
3. daemon close loop 通过
4. 真机 smoke 至少过一轮
5. 本轮问题已有**可重复的本地 case**

禁止：

- 先改代码再想怎么测
- 只靠用户手点找问题
- 自动回归没覆盖输入/刷新主链就继续发包

---

## 9. 本轮新增冻结口径

### 9.1 行为漂移判断口径

如果出现下面任一条，直接判定为“行为漂移”，先回真源，不要补丁：

1. client 因窗口判断错误而清空已有 local buffer truth
2. renderer 因窗口不连续而把已有内容整屏画空
3. IME 因 commit / focus 异常而要求用户“再打一个字符”才能刷新
4. follow 底部 overdrag 触发白屏 / 花屏 / 贴图错位
5. 同一问题只能靠真机随机碰，而不能被本地稳定复现

### 9.2 语音输入法专项口径

“语音输入法转文字”不是边角 case，必须视为 input 主链的一部分。

验收标准不是“最终能输进去”，而是：

- 不需要补一个字符
- 不需要重新点输入框
- 不需要切键盘模式
- 不需要等下次刷新顺带出来

只要需要这些额外动作，都算没修好。

### 9.3 长语音 commit 期间 transport 异常专项口径

“语音输入法一次性提交 100+ 字符”不是边角 case，必须视为 input + transport 主链的并行约束。

**触发特征**：用户报告 “终端提示 连接已断开，正在重连 / Tmux session unavailable” banner，但物理 socket 实际仍连；reconnect banner 出现在长语音 commit 完成后 1-5 秒内，daemon `/debug/runtime` 显示 transport subscribers list 可能在 banner 出现时已 stale。

**唯一 owner**：`terminal.transport_lifecycle`（`src/contexts/session-context-socket-runtime.ts` + `src/contexts/session-context-input-runtime.ts`）；**禁止**在 IME 入口（`TerminalPage.tsx`）做 “屏蔽 reconnect” / “fake banner” 这类补偿；**禁止** 在 renderer / buffer manager / daemon mirror owner 修正 transport 行为。

**验收标准（不能有任何一条被触发）**：

1. 长语音 commit 期间 main thread 单次 IME `input` 回调到 `ws.send()` 同步链不得超过一个微任务周期（不超过 1ms 同步执行 + 后续异步投递）；同步链累计阻塞不得超过 16ms（单帧）
2. 长语音 commit 期间，`session-context-socket-runtime.startSocketHeartbeat` 计时器在 `ws.readyState !== OPEN` 时必须显式重置 `consecutiveMisses` 和 `lastObservedServerActivityAt`；不允许依赖 “reopen 后下一轮 ping 触发” 的隐式行为
3. `session-context-input-runtime` backpressure close（`ws.close(4000, 'input backpressure')`）后，reliable 协议路径必须有指数 backoff（最小 100ms、封顶 2000ms），禁止 close → 立即 retry 死循环
4. `session-context-input-runtime` flush 期间，每次 send 后必须重读 `ws.bufferedAmount`，不允许只在函数入口读一次
5. `TerminalPage.tsx` IME `input` listener 与 `emitRemoteWindowInputEvents` 串行竞态时，若 remote-window overlay 处于 opening/closing 中间状态，必须 fallback 到 terminal input 并 log warning，不允许直接吞掉

**对应 bugs（2026-08-09 16:30 CST code review 定位）**：

- BUG #1：`session-context-socket-runtime.ts:94-128` heartbeat close 期间 miss 冻结
- BUG #2：`session-context-input-runtime.ts:256-269` reliable backpressure 无 backoff 死循环
- BUG #3：`session-context-input-runtime.ts:240-301` flush 期间不重读 bufferedAmount
- BUG #4：`TerminalPage.tsx:2640-2652` IME input listener 同步阻塞 main thread
- BUG #5：`TerminalPage.tsx:2642-2647` remote-window 与 IME input 串行竞态

**必跑回归组**：

- `pnpm --dir android run test:feature-registry`
- `pnpm --dir android exec vitest run src/contexts/session-context-socket-runtime.test.ts`
- `pnpm --dir android exec vitest run src/contexts/session-context-input-runtime.test.ts`
- `pnpm --dir android exec vitest run src/pages/TerminalPage.android-ime.test.tsx`
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm --dir android run terminal:source-dom-gate`
- L5：Android 16 真机手动按语音键说 30s 中文，复现后立刻抓 `logcat -b main,system` + `curl /debug/runtime` + zterm debug overlay 三路对齐

### 9.4 现场问题映射（5.9 长语音 commit 后立即出现 banner）

优先检查：

1. `ws.readyState !== OPEN` 期间 heartbeat 计时器状态是否被冻结（BUG #1）
2. backpressure close 后是否进入死循环 retry（BUG #2）
3. flush 期间 bufferedAmount 实际累积是否超出阈值但函数未感知（BUG #3）
4. main thread 是否被同步 IME commit 链阻塞超过 16ms（BUG #4）
5. remote-window overlay 中间态是否吞掉 IME input（BUG #5）
