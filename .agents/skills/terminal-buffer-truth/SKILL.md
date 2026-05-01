---
name: terminal-buffer-truth
description: "terminal buffer / render / daemon mirror 真源与门禁"
---

# terminal-buffer-truth

## 适用场景
- terminal buffer / render / scroll / input 延迟问题
- 出现“初次连接慢、输入不刷新、reading 拉不动、回到底部不 follow、带宽异常”
- 任何想在 server / buffer manager / renderer 之间加补丁、fallback、第二语义的时候

## 冻结角色边界

```text
tmux truth
  -> daemon server
  -> client buffer manager
  -> renderer
  -> UI shell
```

四层只允许单向依赖，禁止越层漂移。

## 1. daemon server

server 是独立层，只做：

1. mirror tmux truth
2. 回 `buffer-head-request`
3. 回 `buffer-sync-request`
4. 处理 session attach / input / file / schedule / tmux 基础控制

### 1.0 daemon 唯一心智

```text
tmux -> daemon mirror writer -> daemon mirror store -> read api -> client
```

- daemon **不关心客户端**
- daemon 只维护自己的 tmux mirror truth
- daemon 内部也必须 **读写解耦**
  - 写侧：`tmux -> mirror store`
  - 读侧：`mirror store -> head/range reply`
- mirror 写侧也不得再拆第二语义：
  - 不允许 `history capture + visible capture + concat`
  - 只允许 **single-capture -> canonicalize -> mirror store**
- `buffer-head-request` / `buffer-sync-request` 只是**读当前 mirror**
- **请求不得触发 tmux capture / canonical rebuild / planner**
- daemon **不得改写 buffer cells 本身**
  - 包括但不限于：cursor paint、reverse 注入、样式补丁、局部重写
  - 若需要传 cursor truth，必须走**独立元数据**，不能写回 `lines[].cells[].flags`
- 文件传输这类 session 元数据也一样：远端默认目录必须来自 daemon 读取 tmux 当前 `pane_current_path`；client 不得拿 `process.env.HOME` / 本地 env 冒充远端 cwd

硬规则：
- server 不做 follow / reading 策略
- server 不做 renderer 策略
- server 不做 planner / prefetch / snapshot / fallback
- server 不替客户端判断 gap，不替客户端决定该拉哪段
- server 不关心 client 本地 buffer 是否为空、是否 gap、是否 follow/reading、是否首屏
- server 不允许在 `head/range` 请求路径里“先同步 tmux 再回复”
- **每次回复都带当前 head**，避免客户端额外猜
- mirror 生命周期也必须独立：
  - client 断开 / 切 tab / 暂时没有 subscriber，不得销毁 mirror truth 再重建
  - 否则 reconnect 后出现 `revision -> 1` / `latestEndIndex` 回退，不是 tmux 变了，而是 daemon 自己把 absolute truth 丢了
- daemon client session 和 transport 也必须独立：
  - logical client session 是稳定对象
  - ws/rtc transport 是可替换物理连接
  - transport 断开只允许 detach transport，不允许顺手删 logical client session
  - reconnect 必须按同一个 `clientSessionId` 重新绑定，不是新建第二份 session 语义
- daemon 不允许保留 client 风格状态机：
  - 不允许 `session.state`
  - 不允许 `mirror.state`
  - 不允许 `terminalWidthMode / requestedAdaptiveCols`
  - 不允许把 `resize / terminal-width-mode` 做成 daemon 内部状态推进入口
- daemon terminal core 的**代码组织**也必须收口：
  - `server.ts` 只保留 transport/http glue
  - session lifecycle / mirror lifecycle / live sync / attach / input orchestration 必须下沉到独立 terminal core 模块
  - file list / mkdir / download / upload / remote screenshot / attach-file binary / paste-image binary 也必须下沉到独立 runtime
  - 禁止一边说“daemon 不关心客户端”，一边把 terminal core 业务散落回 `server.ts`

## 2. client buffer manager

buffer manager 是独立 worker，不归 daemon、不归 renderer。

它的唯一职责：
1. 自己起 timer
2. 定时先问 head
3. 自己比较 local buffer 和 daemon head
4. 自己决定请求哪段 buffer
5. head 变了或 gap 补齐了，就通知 renderer

### 2.1 本地 buffer 真相
- 本地维护一个 sliding buffer，客户端默认/最大保留 **1000 行**
- 按绝对行号存储
- 可以是 sparse，不要求永远连续
- 历史超出窗口后滑走，但**不是单次 payload 来了就把本地历史裁掉**
- **已有 absolute-index 内容不能因为窗口判断错误而被逻辑清空**
- **同 revision 的迟到旧 payload 不得把本地窗口重新锚回更老的位置**
  - 它只允许 patch 当前 1000 行窗口内的 absolute-index truth
  - 不允许因为晚到的 prepend / reading repair 响应，把 follow 中已经稳定的 tail window 拖回去

### 2.1.1 本地 buffer 不变量

- `local window invalid` 只说明“当前工作窗口理解错了”，**不说明已有 buffer truth 作废**
- `anchor mismatch` / `head mismatch` 也一样；它们只影响下一次 request plan，不影响已有 absolute-index 内容的存在性
- buffer manager **没有权利**把已有本地 buffer 先 reset 成空窗再重拉
- 正确动作只能是：保留已有内容 -> 计算缺口/新窗口 -> 请求 range -> merge -> 通知 renderer

### 2.2 follow 路径
每次 tick：
1. 先问 head
2. 比较本地尾部与 daemon head
3. 若本地为空、失真，或离 head **超过 3 屏**：
   - 直接请求 **head 往回 3 屏**
   - 移动本地 sliding window 到最新尾部
   - **中间缺口不补**
4. 若离 head 不远：
   - 只补 diff

补充冻结：
- **三屏请求窗口** 和 **1000 行本地缓存上限** 是两个独立真相，禁止再用同一个 `cacheLines` 语义混写两者

### 2.3 reading 路径
- reading 不改变 buffer manager 的 head-first 主循环
- 只是额外多一个输入：renderer 当前 reading window
- 若 reading window 三屏内不连续，buffer manager 才请求 gap
- **gap repair 只属于 reading**

### 2.4 禁止事项
- renderer 不能直接触发 transport pull
- buffer manager 不能替 renderer 改 mode
- 不能因为本地历史有 gap，就在 follow 下回补整段历史
- 不能把 snapshot / patch-middle / fallback 再塞回来
- 不能把 `local window invalid` / `anchor mismatch` / `head mismatch` 实现成“先清空已有本地 buffer 再重拉”
- buffer manager 也必须 **读写解耦**：
  - 写侧：同步 daemon -> 更新本地 sparse buffer
  - 读侧：renderer 只消费当前本地 buffer
- buffer manager 不关心 renderer 如何滚动、如何绘制、如何布局
- same-revision merge 也必须遵守“tail 优先稳定”：
  - 若当前本地窗口已经贴着 authoritative tail，且迟到 payload 只覆盖更老的历史、不推进 tail
  - 那么它只能补当前窗口内已有 absolute-index 行，**不得**回拖 `startIndex/endIndex`
- `buffer-sync` 的 in-flight / pull bookkeeping 只是 **transport bookkeeping**，不是 buffer truth；active tab 重新进入、resume、reconnect 时不得让旧 bookkeeping 永久挡住新的 head-first 请求链
- session transport 的**活性真相**不能只看 `session.state === connected` 或 `WebSocket.readyState === OPEN`；active tab 恢复 / 重新进入时，若没有新的 head / range / pong 进展，就必须判定旧 transport 已失活并重建
- transport topology 也必须冻结：
  - `bridge target = bridgeHost + bridgePort + authToken`
  - 每个 bridge target 只允许一个长期存活的 **control transport**
  - 每个 `clientSessionId` 只允许一个稳定的 **per-session transport**
  - control transport 只做 auth / create / attach / resume / close 等低频控制
  - head / range / input 等高频流量只走 per-session transport，不得全部塞进 control transport
  - session attach / resume 必须复用 control transport，但 session data 仍各自独立
  - auth 也只属于 control transport；只要 control transport 没断，就不应重复 auth
  - target runtime 生命周期也必须独立：最后一个 session 离开后，若 control transport 还活着，target runtime 仍保留；只有 `0 session + no control transport` 才允许删除
  - session transport token 也必须是**每个 clientSessionId 独立真相**：同一 session 只允许一个当前有效 ticket；retarget/close 后旧 ticket 必须失效
- active / inactive 只影响“是否继续取数”，不影响 logical session / transport 身份：
  - inactive tab 不主动高频拉 head/range
  - 但**不是**关闭 session
  - 也**不是**关闭 transport
- reconnect 只能是 **same session identity retry**；不能通过“cleanup old socket -> 当成 brand-new session connect”重建第二份 session 语义
- reconnect bookkeeping 也必须按 **session** 隔离：
  - 不允许再做 `same host -> reconnect bucket -> activeSessionId` 的跨 session 串行门
  - 一个 session 的旧 ws / handshake 卡住，**不得**挡住同 host 其他 session

## 3. renderer

renderer 只看两件事：
1. `buffer head`：内容池最新底部
2. `renderBottomIndex`：当前要显示窗口的底部

它不关心：
- transport
- daemon 策略
- buffer 拉取策略
- 输入法

### 3.0 宽度模式真源

renderer 还必须显式区分两种宽度模式：

1. `adaptive-phone`
   - 当前配置真源在 **Settings**
   - 允许手机适配宽度，但最多只允许改 `cols`
   - Android runtime 后续不允许因为 keyboard / IME / safe-area / 容器高度变化继续改 tmux rows
2. `mirror-fixed`
   - daemon mirror / tmux 宽度保持上游真相
   - client viewport、IME、safe-area、容器宽度、字体缩放，**不得**改写 mirror 宽度
   - renderer 只能：
     - 读取原始列 truth
     - 对当前 viewport 做横向裁切
     - 维护自己的 horizontal render window
   - **cell 宽度真相必须来自客户端实测的像素宽度**，不能再把 `1ch / 2ch` 当终端列宽真相
   - 双宽 cell 只能按 `2 * measuredCellWidthPx` 渲染；浏览器 fallback 字体的 `ch` 不是 tmux 列宽真相
   - 若 buffer 行宽大于 viewport：
     - 默认显示左侧窗口
     - 用户横向平移 renderer window 看右侧
     - **不允许**本地重排、换行、回写上游宽度
  - **cursor 也是上游 truth**
    - Android client / renderer **不得自行改 cursor 样式、颜色、位置语义**
    - 但 cursor truth 也**不得通过改写 buffer cell** 来传递
    - 正确做法只能是：daemon 单独回 cursor metadata；renderer 按 metadata 做 overlay / highlight
    - buffer lines 只承载 tmux 原始 cell truth

### 3.1 follow
- follow 只是在收到 head / buffer 更新后
- 把 `renderBottomIndex` 对齐到最新底部
- 然后从本地内容池取当前窗口来画

### 3.2 reading
- 用户上滚立即进入 reading
- reading 时只改自己的 `renderBottomIndex`
- 申请的是“reading head 往回 3 屏”的渲染窗口
- buffer 更新只会让 renderer 重绘当前窗口，**不会自动滚动**
- 即使当前窗口不连续，renderer 也只能把缺口画成 gap / blank marker；不能把已有 absolute-index 内容当成不存在
- gap 行的显示规则也冻结为：
  - **先显示空背景占位，不等待补齐**
  - 补齐后只替换对应 absolute-index 行
  - 相邻 absolute line number 若不连续，当前行号必须显式高亮（debug 下优先红标）
- follow 态若只是因为 live tail refresh / pending follow realign / programmatic scroll 导致 DOM 暂时没贴底，**不得自动进入 reading**；进入 reading 只能由用户滚动手势触发
- follow 态若只是因为 **IME 弹起 / viewport 高度变化 / UI shell relayout** 触发 DOM scroll，**也不得自动进入 reading**
  - viewport relayout 只允许触发 follow realign
  - 不允许把“布局导致的 scrollTop 变化”误判成“用户回滚”

### 3.3 reading 退出条件
只允许三种：
1. 重新进入
2. 下滚到底部
3. 用户输入

除此之外，live update / 补 gap / 尾部推进，都不能把用户拉回 follow。

## 4. UI shell

UI 只负责容器位置与裁切：
- terminal 容器放在哪里
- keyboard / IME 弹起后容器怎么上抬
- 终端可见区域是多少

硬规则：
- IME 只移动容器，不改变内容
- renderer 只在容器里画，不关心输入法
- keyboard / IME 不得回灌成 buffer / render 真相
- `状态浮窗` 与 `绝对行号` 都属于 UI shell observability，但必须 **解耦**
  - `状态浮窗` 只负责连接/刷新/模式观测
  - `绝对行号` 必须由独立显式开关控制，不能再隐式绑定到状态浮窗
- Android 顶部 header inset 只允许来自 **UI shell 的单一稳定像素真相**；IME 弹起导致的 `visualViewport.offsetTop` 不得再被当成第二份 top inset 叠到 header 上
- Android connect / reconnect **不得**把 UI 容器测得的 `cols/rows` 当成 tmux viewport 真相带给 daemon；容器变窄/变矮、IME 弹起、safe-area、前后台恢复，都只能影响 shell 裁切与 renderer 可见窗口
- tmux rows 也必须单独冻结：
  - Android runtime 后续运行期间，keyboard / IME / safe-area / 容器高度变化 **不得**继续改 rows
  - 最多只允许初始化阶段确定一次 rows；更稳妥的实现是直接保持上游 tmux rows，不再由 Android 改写
  - `adaptive-phone` 若需要适配手机，最多只改 `cols`
  - server 的 `attach / resize / width-mode reconcile` 也不得再写第二份 rows；rows 真相只能来自上游 tmux / mirror baseline
- “看不到的地方不画”属于 **renderer 绘制窗口** 真相，不属于 UI shell / buffer manager / daemon；UI shell 只能改容器位置与可见高度，不能借机改 tmux geometry
- QuickBar / 快捷菜单属于 UI shell；**整块 shell 区域** 都必须吃掉非交互点击，不能让空白点击穿透到底层 terminal/ImeAnchor 把 IME 弹出来
- QuickBar 壳布局必须是 **三栏**：前两栏保持老样式（左侧固定六键区两行 + 右侧两行滚动快捷区），第三栏恢复工具栏
- QuickBar 固定布局还要守住：
  - 左侧固定六键区必须是：`状态 / ↑ / 键盘` 与 `← / ↓ / →`
  - `状态` 只替换老附件位；`↑` 与 `键盘` 保持老位置
  - 文件/图片/同步/截图 这四个工具入口要作为 **第三栏工具栏** 显式可见
  - 工具栏只能有这一份；悬浮菜单里不得再重复渲染 文件/图片/同步/截图
  - 固定六键区宽度必须能完整容纳 `状态 / 键盘` 文案，不能裁切、顶出或超界
- 只有 QuickBar 内显式 editor / input / button 等交互控件允许接管焦点；普通 shell 容器点击必须被阻断在 UI shell 层
- 若 `keyboardInsetPx > 0`，QuickBar 必须作为**整体容器**抬升到键盘上方；同一份 keyboard inset 只能消费一次：`terminal stage.bottom = quickBarHeight + keyboardLift`，`quickbar shell.bottom = keyboardLift`，禁止再用 QuickBar 内部 `padding/margin` 对同一份 inset 二次抬升
- remote screenshot 也属于 UI shell / session control 闭环：
  - UI 必须能区分 `capturing -> transferring -> preview-ready`
  - `capturing` / `transferring` 都必须有**显式失败边界**；不允许无限 spinner
  - 客户端**不得**在收到远程截图后直接自动落盘并宣称成功
  - 正确动作是：先预览，再由用户显式 `save` / `discard`
  - QuickBar 工具语义也必须固定：
    - `文件` = 本地文件选择并上传到当前 session
    - `图片` = 本地图片选择并上传到当前 session
    - `同步` = 打开远程文件同步页 / FileTransferSheet
    - `截图` = 远端截图预览流
- session schedule 也必须保持 daemon 单真源：
  - `maxRuns=0` 表示无限次，默认 `3`
  - `firedCount / endAt / stop condition` 只能由 daemon 维护；client 只编辑和展示
- 若为了审计 buffer/render 真相新增 debug UI：
  - 只能做 **观测**：如绝对行号、当前 `follow / reading` 模式、拉取/刷新状态
  - debug UI 不得反向驱动 buffer manager / renderer / daemon 行为
- active tab 持久化也属于 app-shell truth：
  - `ACTIVE_SESSION` 是最后激活 tab 的唯一持久化真相
  - **每次 tab 激活都必须立即写回 `ACTIVE_SESSION`**
  - 冷启动 / 恢复只允许按 `ACTIVE_SESSION` 恢复 active tab，`ACTIVE_PAGE` 只决定页面种类，不得反向覆盖
- 若 QuickBar 自己的 textarea / sheet 抢到 DOM focus，只允许暂停 terminal ImeAnchor 路由；**不得**把 QuickBar overlay / floating composer 使用的 `keyboardInsetPx` 清零，否则会被输入法盖住
- Android terminal 原生输入若走 `ImeAnchor`，则 **ImeAnchor editable / composing / selection 必须是单一真相**；组合输入期间不得一边让 IME 持有 composing state，一边又由插件自行清空/改写 editable 造成第二语义
- `ImeAnchor` 的 `InputConnection` 也必须服从这条真相：`commitText / finishComposingText` 不能跳过 `super` 直接短路返回；否则 framework editable/selection 不更新，真机会出现 **输入法底部预编辑光标错位 / caret 乱飞**
- `mirror-fixed` 下，UI shell 若启用横向查看：
  - 自动关闭左右滑切 tab
  - 单指横滑只服务于 renderer horizontal pan
  - 不允许一次手势里同时尝试切 tab 与横向平移

## 5. 反模式清单

以下一律视为错误实现：
- snapshot
- stream-mode
- planner
- viewport prefetch 第二链路
- `ws close -> daemon delete logical client session`
- `inactive tab -> close session / close transport`
- `reconnect -> new client session semantics`
- daemon 在 `buffer-head-request / buffer-sync-request` 路径里触发 tmux capture
- daemon 根据 client 状态决定“要不要先刷新一下 mirror 再回复”
- daemon 因 subscriber 归零就销毁 mirror，导致 reconnect 后 revision / absolute head 重置
- daemon 把 cursor / selection / transient visual state 直接写进 buffer cells
- client viewport 变窄就改写 daemon mirror / tmux 宽度
- `mirror-fixed` 下把长行本地重排成手机宽度
- `mirror-fixed` 下还保留左右滑切 tab，和横向平移发生手势冲突
- renderer 直接 request buffer
- buffer manager 直接改 renderer follow/reading
- follow 下因为历史 gap 去回补整段旧历史
- `local window invalid -> empty local buffer -> full reanchor`
- `anchor mismatch -> clear local truth`
- `head mismatch -> treat local content as lost`
- 初次连接或恢复连接时，两三 K 两三 K 慢慢追历史
- 任何 fallback / 降级 / 第二语义

## 6. 必须遵守的开发顺序

```text
先落 docs / AGENTS / skill
-> 再补测试
-> 再改代码
-> 再跑真实回环
```

顺序错了，视为没按真源做。

其中测试与检查清单真源固定为：

- `android/docs/daemon-mirror-test-plan.md`
- `android/docs/terminal-test-loop-checklist.md`

## 7. 必跑真回环

```text
tmux truth
-> daemon log
-> client buffer manager log
-> renderer commit log
-> Android APK 真实画面
```

最少覆盖：
1. 初次连接
2. 冷启动进入单个 active tab，等待首屏刷新
3. 进入一个 tab 后切换到另一个 active tab，等待首屏刷新
4. 后台恢复
5. 输入英文 / 数字 / 空格 / 回车
6. reading 连续上滚
7. 输入退出 reading
8. daemon 重启恢复
9. prompt / input row style parity
   - 输入发出后、`buffer-sync` 前，terminal 可见内容不得本地直接变化
   - `buffer-sync` 到达后，renderer 只回显 payload，不得自己再造 prompt/cursor 第二语义
10. same-session transport retry
11. inactive tab stops polling but does not close session/transport
12. same target multi-session stays isolated without shared reconnect fate
13. foreground resume reuses the original session transport before any fresh reconnect
   - prompt / input row 必须可比对 `char / fg / bg / flags`
   - daemon 若回 cursor，必须是**独立 cursor metadata**；`lines` 不得因 cursor 改变

## 7.1 必须沉淀成自动回归

上述 case 不能只靠人工重试。

必须把问题收敛成：

```text
可复现的本地 case
-> 可失败的自动测试
-> 修复后稳定转绿
-> 纳入每次编译前回归
```

只要某个 terminal 线上问题还不能被本地自动 case 复现，就不允许说“根因已收敛”。

最低自动回归覆盖：
- server contract：head / range reply 语义
- buffer manager：head-first / far jump / reading gap / in-flight closeout
- renderer：follow commit / reading hold / input reset follow
- daemon mirror close loop：`top` / `vim` / input echo
- Android 首屏：cold start single tab / switch to another tab 的 first paint

新增门禁精华：
- cold-start / foreground resume 的 transport gate 必须优先 active tab；若 hidden tabs 跟着一起 eager reconnect，active tab 的首屏会被排队拖慢。除非已有被验证的 hidden low-frequency 设计，否则 hidden tab 默认只保留 runtime shell，等显式激活再 reconnect。
- 若现场 `buffer-sync` 下行长期几百 KB/s 甚至 MB/s，先直接抓 daemon 回包；若仍返回 legacy `lines[].cells[]` 而不是 compact `i/t/w/s`，优先查 **daemon service staged runtime 没更新**，尤其是 `start/restart` 只重启 launchd 但没重建 `~/.wterm/daemon-runtime/server.cjs`。
- daemon service 管理也必须遵守唯一真源：`start/restart` 必须重建当前 staged runtime；服务异常必须显式失败，**不能 fallback 回 tmux session** 掩盖旧 runtime/旧语义。
- 本地 `daemon mirror close-loop` 必须使用**隔离测试端口**；禁止复用用户常驻 service 端口（如 3333），否则脚本会误连现场 daemon，出现“自动回归假绿 / 假红”。
- `daemon mirror close-loop` 的 client replay harness 也必须服从 **revision reset 真相**：daemon 重启后若 revision 回到更小值，回放时必须先 reset local buffer 再 apply；否则会把回环假红误报成 daemon/client 主链故障。
- hidden / non-visible tab 不得继续挂载 renderer 实例；renderer scope 必须严格等于当前 visible pane。否则 header truth 已切换但 body 仍残留旧 session DOM，Android WebView 容易出现“页头/内容对不上、像花屏”的 stale compositing。
- renderer scope 回归测试不能只断言 “inactive renderer 还在但 data-active=false”；必须直接断言 **hidden renderer 不在 DOM**，否则会把 DOM 覆盖类问题测成假绿。
- foreground resume 对 active tab 不能只补一发 `buffer-head-request`；若 daemon 仅 `revision` 前进而 `latestEndIndex` 不变，buffer manager 仍必须带一次性 same-end tail refresh demand，确保 `head -> sync -> body repaint` 闭环成立。
- App foreground resume 的真相只能是：**先 probe/resume 当前 active transport，再决定是否 reconnect**；App 不得再按 UI `session.state` 先分叉，否则会把“label stale but transport alive”误杀成重连。
- 若 App 首帧就已经持有现存 `sessions[]`，也必须立刻持久化 `OPEN_TABS / ACTIVE_SESSION`；不能因为“这次不是 restore 分支”就跳过首次回写，否则下次冷启动恢复会拿到陈旧 tab 真相。
- 若现场是**输入区文本对了、但样式和 tmux 不同**，先不要怀疑 local echo。先用回环证明：terminal 可见内容是否只在 `buffer-sync` 后变化；若是，再直接比 **daemon payload 的 prompt/input row `char/fg/bg/flags`**。
- “输入区 / 光标”专项必须至少有一条**红灯门禁**：daemon cursor paint 不得给普通 prompt cell 注入 synthetic reverse style；若这里错，后续任何 IME/renderer 修修补补都会继续假修。
- 若现场出现 **`buffer-sync` 明明持续收到，但 `localRevision/localEndIndex` 长时间不前进、client 反复请求同一 3 屏窗口**，优先查 **client 侧 incoming `buffer-sync` apply 阶段**；收到即更新本地 buffer truth，不要再叠微任务批处理/延迟 flush 第二语义。
- Android terminal header 的顶部 inset 必须由 **UI shell 提供单一像素真相**；Header 自己不得再额外叠 `env(safe-area-inset-top)` 做第二份 safe-area 计算。
- terminal 冷启动 / 恢复 tab 时，**最后 active tab 真相只能来自 `ACTIVE_SESSION`**；`ACTIVE_PAGE.focusSessionId` 只描述页面焦点，不得反向覆盖已恢复的 active session。
- foreground resume / tab re-entry 时，若 active session 的 `ws.readyState === OPEN`，**不得仅因后台静默一段时间就直接重连**；必须先 probe 并复用现有 transport，只有 probe 超时/close/error 后才允许 reconnect。
- transport/session 生命周期若要改，先问自己有没有违反这四条：
  1. 是否又把 per-session ws 当成 transport 真相
  2. 是否又让 reconnect 走 `cleanup old socket -> fresh connect`
  3. 是否又让 inactive tab 关闭 session / transport
  4. 是否又让 daemon 因 ws close / grace timeout 回收 logical session
- 若真机出现**大块灰条/花屏/光标样式乱飞**，优先查 **compact wire 的 default color sentinel** 是否和 `TerminalCell` 真相一致；当前 app/runtime 里的默认前景/背景是 `256/256`，不能在 compact encode/decode 里偷偷改成 ANSI `15/0`。
- 若真机出现**光标颜色不对 / 光标像普通反显文本 / 光标样式污染邻格**，先查 **Android client 是否越权改了 cursor 样式**；renderer 只能回显 payload，不能再造第二套 cursor 视觉语义。
- 若现场看起来像“正文解析错了”，先把 **terminal body** 与 **IME/editor overlay** 分开审；底部灰条/编辑条不属于 daemon buffer truth，不能直接当成 compact wire 正文错误。
- compact wire 的正文门禁必须覆盖 **ANSI + CJK + reverse + bg span + 中间空格**；只有 body parity 红灯以后，才允许改 contract/renderer，禁止凭截图先回退 codec。
- 若现场是“点击快捷栏空白区弹出输入法 / 键盘起来后快捷栏被盖住”，先判 **UI shell/QuickBar**，不要误把它当成 renderer 或 buffer 问题；必须先补 shell 区域阻断与 keyboard lift 的红灯测试。

## 8. 现场判断口径

看到这些现象，优先判对应层：
- 初次连接慢慢追历史：buffer manager 错
- 输入发出去几分钟不刷新：buffer manager / renderer 通知链错
- reading 一滚就被拉回：renderer mode 错
- 带宽异常大：仍有 snapshot / 整窗重拉 / payload 误裁
- keyboard 影响内容或行数：UI shell 越层
- 收到 head 以后长期不再拉新 buffer：优先查 buffer manager 的 in-flight pull 是否死锁
- `pullHz == 0 && renderHz == 0`：优先查 active tab 首次激活后是否根本没进入 head-first 主循环
- foreground / cold-start 后 active tab 长时间 `connecting` 且 hidden tabs 同时在连：优先查 active-only transport gate 是否被破坏
- Android 若 `ImeAnchor` 已经产生日志，但 client 侧出现 `session.input.queue` 且长期无刷新：先判定为 **active transport 已死**，不是 IME 问题；active tab 在 `resume / switch / input` 这三个动作上，只要发现没有 live ws，就必须立即 reconnect，不能只排队等下一次偶然恢复
- 用户现场若给的是 **ADB device 地址**，不要误判成 daemon 地址；先从 Android WebView localStorage 真源读取当前 `bridgeHost / bridgePort / authToken`，再去打 `/health`、`/debug/runtime`、WebSocket probe
- 若怀疑“是 daemon 慢”，必须补一个 **independent direct daemon probe**：临时 tmux session 上测 `connect -> head -> input -> head change`；如果 direct probe 是几十毫秒，而现场 session 仍是几十秒，就先把 generic daemon 基线排除，转查现场 session / IME / active transport 链路
- 若真机现场出现 `session.buffer.request` 已发出、daemon direct probe 也能直接拿到非空 range，但 APK 仍首屏空白/`R=0`，优先判定为 **client 侧 `buffer-sync -> local apply -> renderer commit` 断链**；先补本地结构化证据，不要再回头怪 daemon
- 若现场出现“本地窗口判断错后直接白屏/大包重拉”，优先判定为 **client 侧越权清空已有 absolute-index buffer truth**；这不是 daemon 问题，也不是 buffer 真丢了，而是 client 把“窗口规划错误”实现成了“truth reset”
- 若 Android 真机出现“未点键盘却前台自动弹 IME”或 IME 在九宫格/QWERTY 间异常切换，优先查 `ImeAnchor` 的 stale show/focus 状态是否跨前后台遗留；**只有显式 keyboard action 才允许 show IME**
- 若现场表现为“**语音/CJK commit 已经发生，但要再补一个字符才刷新**”，优先查两件事：
  1. **same-end 新 revision** 是否被旧的 in-flight tail-refresh 误判成“已覆盖”；同窗同 range 但 `targetHeadRevision` 变了，必须允许重发
  2. `buffer-head.cursor` 是否被 client 丢弃；head 已经带来的 cursor metadata 必须立刻进入本地 truth，不能等下一次 buffer-sync 才纠正高亮/光标
