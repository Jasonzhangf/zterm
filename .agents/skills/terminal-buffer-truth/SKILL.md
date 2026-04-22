# terminal-buffer-truth

## 适用场景
- 终端 buffer / scroll / render / cursor 相关 bug
- 出现“看不到底部”“回滚被拉回”“历史拼错”“光标错位”
- 任何想在 TerminalView 里继续补 projection / scroll hack 的时刻

## 必守规则
1. **single canonical buffer**：daemon 只维护、更新、发送一套 canonical buffer。
2. **cursor 在 buffer 里**：cursor 不是第二路 metadata 真相，不允许 daemon/client 各自猜。
3. **daemon 只做 buffer**：daemon 不承载显示逻辑，不承载客户端交互状态，不根据 UI 状态改 buffer 语义。
4. **client 只读 mirror**：client 只按绝对行号合并 daemon buffer，不反向影响 daemon。
5. **render / scroll 解耦**：renderTopIndex、mode(follow/reading)、DOM scroll 是三个层次；不能混在一个组件里靠副作用凑。
6. **reading 退出条件只允许两个**：滚回底部，或用户输入。除此之外任何 live update 都不能把用户拉回底部。
7. **禁止补丁式修 TerminalView**：出现滚动/底部问题，先检查 ownership 是否错，不能继续叠加 projection、anchor、scroll hack。
8. **follow 底部优先吃 daemon viewport 真相**：client 不得只用 `availableEndIndex - rows` 猜“到底”；必须优先使用 authoritative `viewportStartIndex`，必要时补 virtual bottom padding。
9. **daemon 要有内存边界**：orphan mirror 必须可回收；capture/reconcile 里的 scratch runtime 不能每次 flush 新建。
10. **tmux status line 要做 viewport 补偿**：client 上报的是可见 pane 行数；若 tmux `status=on`，daemon 给 PTY/tmux 的总行数必须加上 status line 行数，否则会稳定少 1 行并导致 buffer/render 错位。
11. **跨 geometry 不盲信 daemon viewport**：若 daemon payload 的 `rows` 与 client 当前 `viewportRows` 不一致，client 不得继续把 `viewportStartIndex` 当作当前渲染真底；应退回本地 `availableEndIndex - viewportRows`，否则会凭空渲染出一屏 blank rows。
12. **IME 只抬渲染不改 buffer**：输入法弹起/收起期间，允许 shell / canvas 做视觉位移，但禁止把 visual viewport 变化回灌成 daemon resize；否则 composition 期间会触发 buffer/viewport 抖动。
13. **quick bar 高度只能扣一次**：如果 terminal canvas 已经位于 quick bar 之上的剩余高度内，就不能再给 terminal content 额外加同等 `paddingBottom/inset`；否则会稳定吃掉尾部几行。
14. **键盘不改 terminal 显示高度**：软键盘弹起/收起时，terminal 容器高度保持稳定；只允许做整体视觉上抬，不能把 keyboard inset 变成 terminal 高度变化。

## 推荐执行顺序
1. 先确认 daemon canonical buffer 结构
2. 再确认 client mirror merge
3. 再确认 render state
4. 最后接 DOM scroll / gesture

## 反模式
- 在 daemon 烘焙 client 显示逻辑
- 用两个 buffer source（history vs latest / snapshot vs delta）拼 UI
- 用 DOM scrollTop 充当业务真源
- 本地根据输入法/光标状态猜终端内容
