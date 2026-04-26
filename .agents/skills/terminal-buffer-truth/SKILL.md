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
4. 处理 connect / input / resize 这类基础控制

### 1.0 daemon 唯一心智

```text
tmux -> daemon mirror writer -> daemon mirror store -> read api -> client
```

- daemon **不关心客户端**
- daemon 只维护自己的 tmux mirror truth
- daemon 内部也必须 **读写解耦**
  - 写侧：`tmux -> mirror store`
  - 读侧：`mirror store -> head/range reply`
- `buffer-head-request` / `buffer-sync-request` 只是**读当前 mirror**
- **请求不得触发 tmux capture / canonical rebuild / planner**

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

## 3. renderer

renderer 只看两件事：
1. `buffer head`：内容池最新底部
2. `renderBottomIndex`：当前要显示窗口的底部

它不关心：
- transport
- daemon 策略
- buffer 拉取策略
- 输入法

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
- follow 态若只是因为 live tail refresh / pending follow realign / programmatic scroll 导致 DOM 暂时没贴底，**不得自动进入 reading**；进入 reading 只能由用户滚动手势触发

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

## 5. 反模式清单

以下一律视为错误实现：
- snapshot
- stream-mode
- planner
- viewport prefetch 第二链路
- daemon 在 `buffer-head-request / buffer-sync-request` 路径里触发 tmux capture
- daemon 根据 client 状态决定“要不要先刷新一下 mirror 再回复”
- daemon 因 subscriber 归零就销毁 mirror，导致 reconnect 后 revision / absolute head 重置
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
- hidden / non-visible tab 不得继续挂载 renderer 实例；renderer scope 必须严格等于当前 visible pane。否则 header truth 已切换但 body 仍残留旧 session DOM，Android WebView 容易出现“页头/内容对不上、像花屏”的 stale compositing。
- foreground resume 对 active tab 不能只补一发 `buffer-head-request`；若 daemon 仅 `revision` 前进而 `latestEndIndex` 不变，buffer manager 仍必须带一次性 same-end tail refresh demand，确保 `head -> sync -> body repaint` 闭环成立。

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
