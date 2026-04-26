# Daemon Mirror Test Plan

## 目标

先在本地证明这条链路成立：

```text
tmux truth
-> daemon mirror
-> websocket payload
```

手机只做最后人工 smoke，不作为真源验证环境。

在 daemon / client local mirror 闭环之后，还必须补一层 Android 运行态闭环：

```text
ws message
-> SessionContext reducer
-> activeSession selection
-> TerminalCanvas / TerminalView render
```

这层要用本地 mock websocket + jsdom 动态测试做，不等手机人工点。

最终提交前，还必须补齐**真实安装态闭环**：

```text
tmux truth
-> daemon head / range
-> client buffer worker
-> renderer commit
-> Android APK 真机画面
```

这条链必须证明：

1. tmux truth 真的变了
2. daemon 真的只发 head / requested range
3. client buffer worker 真的按 authoritative bounds 更新
4. renderer 真的 commit 到正确窗口
5. 真机画面真的跟上

禁止只拿其中任意一层当“修好”。

## 唯一 oracle

本地测试里，tmux 本身就是唯一 oracle。

每个 case 都只用这两类 tmux 原语取真相：

1. buffer truth
   - 历史 / canonical scrollback：`tmux capture-pane -p -e -N -t <pane> ...`
   - 当前最后一屏 / visible viewport：`tmux capture-pane -p -M -e -N -t <pane> ...`
2. cursor / pane metrics truth
   - `tmux display-message -p -t <session> '#{cursor_x} #{cursor_y} #{cursor_flag} #{pane_width} #{pane_height} #{history_size} #{alternate_on} #{pane_current_command}'`

说明：
- `last-screen-equal` / `viewport-bottom-equal` 这类断言，一律以当前可见 screen 为准，优先抓 `capture-pane -M`
- 即使是普通 shell，在 attached tmux client 下默认 `capture-pane` 也可能偏向历史而不是当前 visible viewport，导致把正确 mirror 误判成 blank
- `top` / `vim` 这类 TUI 更必须抓当前可见 screen；默认 `capture-pane` 可能只看到 scrollback/普通 screen，误判成 blank

禁止：
- 用手机画面当真相
- 用 daemon 自己的 debug 字段替代 tmux oracle

## 真实测试回环门禁

任何 buffer / render / input / foreground / reading 修复，必须经过下面 5 层回环，缺一层都不算完成：

### Loop 1. tmux oracle

- `tmux capture-pane`
- `tmux display-message`

回答：

- 当前 authoritative head / tail 是多少
- 最后一屏内容是什么
- 输入后 tmux 是否立刻变化

### Loop 2. daemon runtime

- `/debug/runtime`
- `/debug/runtime/logs`

回答：

- daemon 当前 `availableStartIndex / availableEndIndex / revision`
- 本次回复是 `buffer-head` 还是 `buffer-sync`
- `buffer-sync` 实际回了哪个 range
- 是否出现异常大 payload / 高频重复回复

### Loop 3. client buffer worker

必须打结构化日志，至少覆盖：

- `session.buffer.head.recv`
- `session.buffer.window.invalid`
- `session.buffer.request.plan`
- `session.buffer.sync.apply.before`
- `session.buffer.sync.apply.after`
- `session.buffer.pull.start/complete/cancel`
- `session.buffer.pull.deadlock`

回答：

- 本地 `start/end/revision` 是多少
- daemon authoritative bounds 是多少
- 是否判定 local window invalid
- 发出的 request range 是否正确
- `buffer-head` 是否被误当成 `tail-refresh` ack
- in-flight pull 是否被正确完成或清理
- cold start / tab switch 后是否出现 `pullHz == 0`

### Loop 4. renderer commit

必须能证明：

- follow 收到新 tail 后真的 commit
- reading 只重绘当前窗口，不自动跳底
- 输入后显式回 follow 并 commit 到底部

建议日志：

- `session.render.commit`
- `session.render.mode-change`
- `session.render.follow-reset`
- `session.render.first-paint`

必须额外回答：

- cold start / tab switch 后是否出现首个 render commit
- 是否出现 `renderHz == 0`

### Loop 5. Android APK 真机

必须跑真实安装包，不允许只看浏览器/JSDOM：

- 初次连接
- 冷启动进入单个 active tab，等待首屏刷新
- 进入一个 tab 后切换到另一个 tab，等待首屏刷新
- 后台恢复
- 输入英文/数字/空格/回车
- reading 连续上滚
- 输入退出 reading
- daemon 重启恢复

只有 5 层都对齐，才允许宣称修复成立。

## 自动回归编排要求

本地必须把“复现 -> 修复 -> 验证”沉淀成固定自动回归，不允许只做一次性人工排查。

### 必须长期保留的回归组

1. **server contract**
   - `buffer-head-request` -> `buffer-head`
   - `buffer-sync-request` -> `buffer-sync`
   - 每次 reply 都带 head
   - 不允许 `buffer-sync-request` 降级成别的 ack 语义

2. **buffer manager orchestration**
   - head-first tick
   - far-from-head 直接拉最新三屏
   - follow 只补 diff，不补 gap
   - reading 才补 gap
   - head-only / empty sync 不得卡死 in-flight pull
   - cold start active tab 时必须主动发出 first head request
   - tab switch 到新 active tab 时必须主动发出 first head request

3. **renderer orchestration**
   - follow 收到 head/buffer 更新后 commit
   - reading 不自动跳底
   - input 退出 reading 后回到底部

4. **daemon mirror close loop**
   - `codex-live`
   - `top-live`
   - `vim-live`
   - `initial-sync`
   - `local-input-echo`
   - `external-input-echo`

5. **APK smoke**
   - 安装态初次连接
   - 安装态冷启动进入单 tab，等待首屏刷新
   - 安装态进入一个 tab 后切到另一个 tab，等待首屏刷新
   - 安装态输入与刷新
   - 安装态恢复连接

### 编译前门禁

每次准备出 APK 前，至少自动执行前 1-4 组。

只有：

```text
unit/contract green
and orchestration green
and daemon mirror close loop green
```

才允许进入 APK build / 真机 smoke。

## Android 首屏刷新专项门禁

这两个场景必须单独建自动回归，不能被一般 input/reconnect case 代替：

### case A. cold-start-single-tab-first-paint

```text
冷启动
-> 进入一个 active tab
-> 本地 buffer 初始为空
-> 不输入
-> 等待首个 head / range / render commit
```

必须证明：

- client 主动发出 `buffer-head-request`
- 收到 head 后主动发出 `buffer-sync-request`
- renderer 出现首个 commit
- 不是等输入后才刷新

### case B. switch-to-another-tab-first-paint

```text
已进入 tab-A
-> 切换到 tab-B
-> tab-B 成为新的 active tab
-> 不输入
-> 等待 tab-B 首个 head / range / render commit
```

必须证明：

- tab-B 激活后主动发出 `buffer-head-request`
- tab-B 首屏能自己刷新
- 不是靠输入、resize、再次切换才刷新

## 固定实验 session

- 永远只使用一个固定名字的 tmux session：
  - `zterm_mirror_lab`
- 不为每个 case 新建额外 session
- 每个 case 开始前：
  - 先检查这个 session 是否存在
  - 存在则 reset / clear / 复用
- 每个 case 结束后：
  - 关闭或重置这个 session

## 实验角色

### 1. tmux fixture

职责：
- 创建/复用 `zterm_mirror_lab`
- 设定固定窗口尺寸
- 固定 status on/off
- 固定 window-size policy
- 清理历史，保证每次 case 起点一致

### 2. writer

两类输入源都必须覆盖：

#### A. daemon writer
- 通过 daemon websocket `input`
- 模拟 zterm 自己输入

#### B. external writer
- 通过外部 shell / tmux 客户端写入
- 模拟 Termius / iTerm2 / 其他 tmux client 的输入

### 3. daemon probe

一个本地 websocket client，只负责抓：
- `buffer-sync`
- `buffer-range`
- revision
- start/end
- viewportEndIndex
- lines

它不做 UI，不做 render，只做抓包和落盘。

### 4. comparator

每个动作后同时采样：
- tmux oracle
- daemon mirror payload

然后做结构化比较。

## 测试分层

### Layer 0: attached TUI cases（当前最高优先级）

先证明 daemon mirror 能跟住真实 TUI：

#### case 0. top-live
- Codex/本地 PTY attach 到固定 tmux session
- 在 pane 内启动 `top`
- 验证 daemon payload 能持续跟住 tmux oracle

#### case 0.1 vim-live
- Codex/本地 PTY attach 到固定 tmux session
- 启动 `vim -Nu NONE`
- 做**多步动态编辑**，至少覆盖：
  - 初始化空屏
  - 造出超过一屏的内容并落到底部
  - 回到顶部修改首行
  - 回到底部修改尾行 / 追加新行
  - 退出回 shell
- 每一步都要验证 daemon payload 与 tmux oracle 收敛
- 每一步都要重放 client local mirror，不能只看最终一帧

规则：
- 这层通过前，不进入 Android smoke
- detached `send-keys` 只作链路探测，不代替 TUI 验证

### Layer 1: shell command cases

再用标准 shell 命令验证 mirror 基本正确：

#### case 1. initial-sync
- attach daemon
- 抓 tmux oracle
- 抓 daemon sync
- 验证最后一屏一致

#### case 2. local-input-echo
- 通过 daemon websocket 输入：
  - `printf 'hello-daemon\\n'`
- 验证 daemon 输出收敛到 tmux truth

#### case 3. external-input-echo
- 通过外部 `tmux send-keys` 或 iTerm2 写入：
  - `printf 'hello-external\\n'`
- 验证 daemon 不经过本地 input 也能感知变化

#### case 4. multiline-output
- 执行：
  - `seq 1 80`
- 验证 scrollback / viewport bottom / tail window 是否一致

#### case 5. resize-min-geometry
- 接两个 zterm probe client
- 一大一小
- 验证 daemon 选择最小 geometry
- 然后再输出新内容
- 验证：
  - 老历史不变
  - 新内容按新 geometry 进入新行

### Layer 2: tty / continuous-refresh cases

在 shell case 稳定后，再测连续变化：

#### case 6. tty-top
- 在固定 session 中运行 `top`
- 观察 daemon 是否持续感知和刷新
- 验证 viewport tail 是否持续收敛

#### case 7. tty-watch
- 运行：
  - `watch -n 1 date`
  - 或等价持续刷新命令
- 验证 control-mode 通知驱动链是否稳定

#### case 8. mixed-writer-under-tty
- 一个外部 writer
- 一个 daemon writer
- pane 内部同时有持续刷新程序
- 验证 daemon 不丢、不乱、不停滞

### Layer 3: manual smoke

只有 Layer 1/2 全通过，才进入人工测试：
- zterm Android 手工连接
- 看 render 是否正确
- 看输入后是否刷新
- 看外部 client 输入是否同步

### Layer R: Android runtime dynamic tests（必须先于 manual smoke）

本地必须额外通过：

1. `SessionProvider + mock WebSocket`
   - 连续 `buffer-sync` 推进时，active session buffer 必须连续刷新
   - stale / 低 revision 的旧 sync 不能覆盖新状态
2. `TerminalCanvas / TerminalView`
   - 同一 session 连续 revision 更新时，顶部/底部/追加内容都要正确渲染
   - 本地输入框只能上报 input，不能本地改 buffer/画面

### Layer S: Real-device closed loop（提交前必跑）

下面 6 个 case 必须真实跑在 Android APK 上，并同时抓 tmux / daemon / client log：

#### case S1. initial-connect-tail
- 新开 app / 新连 session
- 期望：
  - 不追历史
  - 直接请求最新三屏
  - render 立刻落到底部

#### case S2. foreground-resume
- app 切后台，再切回前台
- 期望：
  - 主动恢复 active transport
  - 主动问 head
  - 若 local window 失真，直接重锚最新尾窗
  - 不需要靠输入/发图才恢复

#### case S3. input-latency
- 分别输入：英文、数字、空格、回车
- 期望：
  - `sendInput -> tmux change -> daemon head -> buffer-sync -> render commit`
    这条链都看得到
  - 体感必须立即，不接受“几十秒后出现”

#### case S4. reading-scroll
- 上滚一屏，再继续上滚第二屏
- 期望：
  - reading 状态保持
  - 不自动往下拉
  - 只有 gap repair 时短 loading

#### case S5. input-exit-reading
- reading 中输入
- 期望：
  - 显式退出 reading
  - render 立刻到底部
  - 新输入所在尾部立即可见

#### case S6. daemon-restart-recover
- 保持客户端打开，重启 daemon
- 期望：
  - reconnect 后主动 head sync
  - local stale window 被判 invalid
  - follow 请求直接改成最新尾窗
  - 不再出现 stale local tail 继续请求

## 比较规则

每个 case 必须输出以下断言结果：

### assert 1. last-screen-equal
```text
daemon last screen == tmux last screen
```

### assert 2. viewport-bottom-equal
```text
daemon viewportEndIndex == tmux available end
```

### assert 3. cursor-equal
- 如果 cursor 烙进 buffer：
  - daemon 最后一屏的 cursor 反显位置必须对应 tmux cursor

### assert 4. external-change-detected
- external writer 写入后：
  - daemon revision 必须前进
  - daemon payload 必须变化
  - 最终必须收敛到 tmux truth

### assert 5. history-immutable
- resize 前已经进入 canonical buffer 的历史行 hash 不变

### assert 6. no-impossible-local-window
- client log 中禁止出现：
  - `localEndIndex > daemon.availableEndIndex`
  - `localStartIndex > daemon.availableEndIndex`
  - `bufferTailEndIndex > daemon.availableEndIndex`

### assert 7. no-zero-width-follow-request
- follow 请求禁止出现：
  - `requestStartIndex == requestEndIndex`

### assert 8. head-is-not-pull-ack
- `buffer-head` 只能更新 authoritative truth
- 不能单独清掉 `tail-refresh` in-flight
- pull 完成必须由对应 `buffer-sync` 证明

### assert 9. input-visible-latency
- `sendInput -> renderer commit` 必须在现场日志里可追踪
- 若 tmux 已变化但 renderer 未 commit，判失败

## 证据输出

每个 case 落盘到：

```text
android/evidence/daemon-mirror/<date>/<case-name>/
```

至少包含：
- `tmux-capture.txt`
- `tmux-metrics.txt`
- `daemon-payload.json`
- `client-buffer-log.json`
- `client-render-log.json`
- `comparison.json`
- `summary.txt`

若是 Android APK 真机 case，还必须补：

- `apk-version.txt`
- `logcat.txt`（或 client runtime log 导出）
- `timeline.txt`（按事件顺序列出 input/head/request/sync/render 时间）

## 开发顺序

### Step 1
先做最小本地 harness：
- session fixture
- daemon probe
- oracle capture
- compare

### Step 2
先跑 Layer 0 attached TUI cases（`top` / `vim`）

### Step 3
再跑 Layer 1 shell command cases

### Step 4
再跑 Layer 2 tty / continuous-refresh cases

### Step 5
再跑 Layer R Android runtime dynamic tests

### Step 6
最后跑 Layer S real-device closed loop

只有 Step 1-6 全过，才允许进入“准备提交/推送”。

### Step 5
最后才上手机做人工 smoke

## 当前实现建议

建议先做两个脚本：

1. `android/scripts/daemon-mirror-lab.ts`
   - 单 case 手工实验入口

2. `android/scripts/client-mirror-replay.ts`
   - 读取 `probe-history.json + tmux-capture.txt + tmux-metrics.txt`
   - 本地重放 client mirror + render window
   - 不只校验最终一帧，还要按 `step-results.json` 校验每个动态 step
   - 证明 `tmux -> daemon -> client mirror -> render` 闭环

3. `android/scripts/daemon-mirror-regression.ts`
   - 批量回归入口

当前可直接用：

```bash
pnpm daemon:mirror:close-loop
```

它会顺序执行：
- `daemon:mirror:lab:current -- --case=all`
- 对当天每个 case 自动执行 `daemon:mirror:replay`

## 门禁

以下任一未通过，不允许发 APK，不允许上真机判定真相：

- initial-sync
- local-input-echo
- external-input-echo
- multiline-output
- resize-min-geometry
- tty-top
