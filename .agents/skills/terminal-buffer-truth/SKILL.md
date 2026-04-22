# terminal-buffer-truth

## 适用场景
- 终端 buffer / scroll / render / cursor 相关 bug
- 出现“看不到底部”“回滚被拉回”“历史拼错”“光标错位”
- 任何想在 TerminalView 里继续补 projection / scroll hack 的时刻

## 必守规则
1. **single canonical buffer**：daemon 只维护、更新、发送一套 canonical buffer。
2. **cursor 在 buffer 里**：cursor 不是第二路 metadata 真相，不允许 daemon/client 各自猜。
3. **daemon 只做 buffer**：daemon 不承载显示逻辑，不承载客户端交互状态，不根据 UI 状态改 buffer 语义。
3.1 **daemon 是 tmux mirror，不是 input relay**：daemon 观察 tmux truth，本地输入只是写入方式之一，不是更新真源。
3.2 **server 只做两件事**：1) mirror tmux truth；2) 以 zterm 活跃 clients 的最小 geometry 通知 tmux resize。
3.3 **geometry 只看 zterm clients**：Termius、iTerm2 等外部 tmux clients 不参与 daemon geometry policy。
3.4 **daemon 不改写 tmux 内容**：daemon 只发送控制（input/attach/resize 等）并读取 truth；禁止在 daemon 侧二次改写/裁剪/重排 tmux 内容来修复显示。
4. **client 只读 mirror**：client 只按绝对行号合并 daemon buffer，不反向影响 daemon。
4.1 **历史 buffer immutable**：一旦某行进入 canonical buffer，就视为已发生事实；后续 resize 只影响新输出，不回改旧历史。
5. **render / scroll 解耦**：renderTopIndex、mode(follow/reading)、DOM scroll 是三个层次；不能混在一个组件里靠副作用凑。
6. **reading 退出条件只允许两个**：滚回底部，或用户输入。除此之外任何 live update 都不能把用户拉回底部。
7. **禁止补丁式修 TerminalView**：出现滚动/底部问题，先检查 ownership 是否错，不能继续叠加 projection、anchor、scroll hack。
8. **follow 底部优先吃 daemon viewport 真相**：client 不得只用 `availableEndIndex - rows` 猜“到底”；必须优先使用 daemon 给出的 viewport 底部事实，必要时补 virtual bottom padding。
8.1 **最后一屏先用底部指针对齐**：在 Android 当前收敛阶段，client 渲染窗口先以 daemon `viewportEndIndex` 作为唯一底部指针，再按本地 `viewportRows` 自底向上切一屏；不要同时依赖顶部指针和本地高度去双向凑。
8.2 **client / wire 不再依赖 viewportStart**：Android 本地 mirror 只保留绝对 cached window + `viewportEndIndex`；顶部指针不能再进入 client render state，也不应再作为 Android wire truth 的必要字段。
8.3 **不要再分第二种 live buffer 消息**：Android 当前 mirror 收敛阶段，live refresh 统一走 `buffer-sync`；禁止再引入 `buffer-delta` 这类第二套 live 更新语义去分叉 client merge 逻辑。
8.4 **daemon mirror 也不要固化 top pointer state**：server 内部若只是为了算当前 viewport top，应按 `availableEndIndex - rows` 临时派生；不要把顶部指针再存成第二真源状态。
8.5 **live 增量也必须自带当前 viewport**：daemon active 增量可以只发 changed-range，但 payload 至少要覆盖“changed-range ∪ 当前 viewport”；否则 client replay 虽可恢复，单条 daemon payload 仍不是自洽 mirror，TUI bottom/status line 校验会失真。
9. **daemon 要有内存边界**：orphan mirror 必须可回收；capture/reconcile 里的 scratch runtime 不能每次 flush 新建。
9.1 **daemon reconcile 不能自旋成风暴**：fallback reconcile 只能当 observer 丢通知时兜底，不能对常驻连接无脑高频抓 tmux；至少要区分 active subscribers，并对 quiet mirrors 设更长的最小 capture 间隔。
9.2 **runtime debug 回传也必须限流**：client -> daemon 的 debug 日志只能走 bounded queue + 小批量定时 flush + payload 截断；观测链本身不能制造第二场日志风暴。
10. **tmux status line 要做 viewport 补偿**：client 上报的是可见 pane 行数；若 tmux `status=on`，daemon 给 PTY/tmux 的总行数必须加上 status line 行数，否则会稳定少 1 行并导致 buffer/render 错位。
10.1 **最后一屏 oracle 要抓当前可见 screen**：凡是校验 “last screen / viewport tail / 当前底部”，本地 oracle 与 daemon authoritative capture 都应优先使用 `capture-pane -M`（必要时再配合 `-e/-N`）；不只 `top` / `vim`，attached tmux 下普通 shell 也可能因为默认 `capture-pane` 偏向历史而把正确 mirror 误判成 blank。
10.2 **动态刷新必须逐步验，不只看最终一帧**：`vim/top/external writer` 这类连续变化 case，必须把每个中间 step 的 tmux oracle、daemon payload、client mirror replay 都逐步对齐；只做 final frame replay 不能证明刷新链稳定。
11. **跨 geometry 不盲信 daemon viewport**：若 daemon payload 的 `rows` 与 client 当前 `viewportRows` 不一致，client 不得继续把 `viewportStartIndex` 当作当前渲染真底；应退回本地 `availableEndIndex - viewportRows`，否则会凭空渲染出一屏 blank rows。
12. **IME 只抬渲染不改 buffer**：输入法弹起/收起期间，允许 shell / canvas 做视觉位移，但禁止把 visual viewport 变化回灌成 daemon resize；否则 composition 期间会触发 buffer/viewport 抖动。
13. **quick bar 高度只能扣一次**：如果 terminal canvas 已经位于 quick bar 之上的剩余高度内，就不能再给 terminal content 额外加同等 `paddingBottom/inset`；否则会稳定吃掉尾部几行。
14. **键盘不改 terminal 显示高度**：软键盘弹起/收起时，terminal 容器高度保持稳定；只允许做整体视觉上抬，不能把 keyboard inset 变成 terminal 高度变化。
15. **客户端不再本地画光标**：client 只能渲染 buffer cells；任何基于 `cursorRow/cursorCol` 的额外 outline/overlay 都属于残留逻辑，必须删。
16. **geometry 只在真实尺寸变化时上报**：连接初始化必须上报当前尺寸；IME show/hide 只改容器位置，不触发 tmux resize。多 client 共享 session 时，daemon 应收敛到最小 geometry。
17. **唯一信息真源必须先冻结**：开始修 buffer/render/daemon 前，先把 tmux truth -> daemon mirror -> client mirror 的 ownership 写入 architecture/decision/skill，后续实现不得偏离。

## 推荐执行顺序
1. 先确认 daemon canonical buffer 结构
2. 先用本地 attached TUI case 验证 daemon mirror（`top` / `vim` 优先，detached shell case 只作最小链路探测）
3. 再确认 client mirror merge
4. 再确认 render state
5. 最后接 DOM scroll / gesture

## TUI-first 验证流程
1. 固定一个 tmux session 作为实验场
2. 先让 Codex/本地 PTY attach 到这个 session，跑 `vim -Nu NONE`、`top` 等真实 TUI
3. daemon probe 只负责抓 websocket payload；tmux `capture-pane + display-message` 仍是唯一 oracle
4. 只有 `top` / `vim` 稳定后，才允许进入 Android 手工 smoke
5. detached `tmux send-keys` 只能验证最小 shell 链路，不能替代 TUI 验证

## 反模式
- 在 daemon 烘焙 client 显示逻辑
- 用两个 buffer source（history vs latest / snapshot vs delta）拼 UI
- 用 DOM scrollTop 充当业务真源
- 本地根据输入法/光标状态猜终端内容
