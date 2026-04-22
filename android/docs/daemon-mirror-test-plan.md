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

## 证据输出

每个 case 落盘到：

```text
android/evidence/daemon-mirror/<date>/<case-name>/
```

至少包含：
- `tmux-capture.txt`
- `tmux-metrics.txt`
- `daemon-payload.json`
- `comparison.json`
- `summary.txt`

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
