# 2026-04-23 Terminal head / buffer manager / renderer truth

> 本文档是 terminal 链路唯一真源。若旧文档、旧实现、旧测试与本文冲突，以本文为准。

> 补充：transport / logical session 生命周期已单独冻结在  
> `docs/decisions/2026-04-28-terminal-transport-session-lifecycle-truth.md`。  
> 本文档只负责 `daemon mirror / buffer manager / renderer / UI shell` 四层内容真相。

## 决策

terminal 链路固定为四层独立模型：

```text
tmux truth
  -> daemon server
  -> client buffer manager
  -> renderer
  -> UI shell
```

### 冻结原则

1. **server 独立**：只 mirror tmux truth，只回答 head 和 range
2. **buffer manager 独立**：只管和 daemon 同步，不管渲染
3. **renderer 独立**：只管 render window，不管 buffer 拉取
4. **UI shell 独立**：只管容器位置与裁切，不管内容真相
5. **不允许 fallback / snapshot / planner / 第二语义**

---

## 1. daemon server

server 只做四件事：

1. mirror tmux buffer truth
2. 处理 `buffer-head-request`
3. 处理 `buffer-sync-request`
4. 处理 `connect / input / resize`

### 1.1 server 响应规则

- `buffer-head-request`：返回当前 head
- `buffer-sync-request`：返回请求区间 buffer
- **任何回复都带当前 head**

最小响应语义：

```ts
type BufferHead = {
  sessionId: string
  revision: number
  latestEndIndex: number
}

type BufferSyncResponse = {
  sessionId: string
  revision: number
  latestEndIndex: number
  startIndex: number
  endIndex: number
  lines: Array<{ index: number; cells: TerminalCell[] }>
}
```

### 1.2 server 明确不做

- 不做 follow / reading 判断
- 不做 request planner
- 不做 snapshot / fallback
- 不做 gap 判断
- 不做 renderer 决策
- 不做“客户端应该拉哪段”的策略
- 不因 client 断开 / 切 tab / subscriber 归零就销毁 mirror truth；mirror 的 `revision / latestEndIndex / absolute line window` 不能随着 client 生命周期重置

server 不关心客户端行为；它只是 tmux mirror。

### 1.2.1 daemon mirror 写侧补充冻结

- daemon 从 tmux 写入 mirror 时，只允许：

```text
single capture
-> canonicalize
-> mirror store
```

- 不允许把 tmux 内容拆成：
  - `history`
  - `viewport / visible rows`
  - 再本地拼接
- 这类 split 会制造第二语义，也容易在短历史场景下把尾部内容重复拼进 mirror
- daemon 可以读取 tmux 的 pane rows / cols / alternate-screen 这些**源事实**，但不能基于它们派生“显示策略”

### 1.3 daemon client-session / transport 生命周期

daemon 侧还要额外冻结一条真源：

1. **daemon client session** 是稳定逻辑对象
2. **transport(ws / rtc)** 是可替换物理连接
3. **mirror** 仍然只代表 tmux truth

关系固定为：

```text
tmux truth
  -> mirror
daemon logical client session
  -> attached transport (0..1)
```

硬规则：

- 新 transport 连接上来时，daemon 先按 `clientSessionId` 找已有 logical client session
- 找到就**重绑 transport**，不是新建第二个 logical session
- transport 断开时，只允许 **detach transport**，不得顺手删除 logical client session
- logical client session 只允许由：
  1. client 显式 `close`
  2. daemon shutdown
  3. 显式实现并写进真源的资源回收策略
    触发销毁
- 在本轮真源里，**没有**“ws 一断就删 client session”这条语义

---

## 2. client buffer manager

buffer manager 是客户端唯一 buffer worker。

### 2.1 唯一职责

- 自己起 timer
- 定时先问 head
- 比较本地 local buffer 与 daemon head
- 决定这次该请求哪段 buffer
- merge 到本地 sliding buffer
- 在 head 变化或 gap repair 完成后通知 renderer

### 2.2 本地 buffer 结构

- 客户端默认/最大维护 **1000 行** sliding buffer
- 绝对行号存储
- 允许 sparse
- 历史超出窗口后再滑走
- 单次 payload 不是“重建本地 buffer”的命令
- **已有绝对行号内容一旦进入本地 buffer truth，就不能因为窗口判断而被逻辑清空**

### 2.2.1 本地 buffer 不变量

下面几条是硬规则：

1. **窗口错不等于 buffer 作废**
2. **anchor 错不等于 buffer 作废**
3. **head 对不上不等于 buffer 作废**
4. buffer manager **没有权利**因为“当前工作窗口理解错了”，就把已有本地 buffer truth 清空、重置成空窗、假装丢失

正确语义只能是：

```text
已有 absolute-index buffer truth 继续保留
-> 重新理解当前工作窗口 / 缺口
-> 请求缺的 range
-> 按绝对行号 merge
-> 通知 renderer
```

绝不允许：

```text
窗口判断异常
-> 先把已有本地 buffer truth 清空
-> 再从空窗重拉
```

### 2.3 follow 主路径

每轮都先问 head，然后比较本地尾窗和 daemon head：

#### 情况 A：本地为空 / 失真 / 距离 head 超过 3 屏

直接：
- 请求 `head` 最新三屏
- 把本地 sliding window 移到最新尾部
- **中间缺口不补**

#### 情况 B：本地仍在 head 附近

只补 diff。

### 2.4 reading 主路径

reading 不改变 head-first 主循环。

它只是给 buffer manager 额外一个渲染需求：
- 当前 reading window 是多少
- 当前 reading window 内是否有 gap

只有 reading window 不连续时，buffer manager 才请求 gap。

### 2.5 buffer manager 明确不做

- 不关心 renderer 的 DOM / scroll / IME
- 不关心容器位置
- 不直接修改 renderer 的 mode
- 不在 follow 下因为历史 gap 去回补整段旧历史
- 不允许 snapshot / patch-middle / fallback
- 不允许因为 `local window invalid` / `anchor mismatch` / `head mismatch` 把已有本地 buffer truth 重置成空窗
- 不允许把“请求规划错误”实现成“先销毁已有本地内容再重拉”

### 2.6 active / inactive 与 transport 生命周期

buffer manager 自己还必须守住这条边界：

1. **active / inactive 只影响取数频率**
2. **不影响 session 身份**
3. **不影响 transport 身份**

固定语义：

- active tab：
  - 持续 head-first tick
  - follow 时做 tail diff / 三屏重锚
  - reading 时额外做 gap repair
- inactive tab：
  - 只是不再主动高频拉 `head/range`
  - **不是**关闭 session
  - **不是**关闭 transport
  - **不是**重建 buffer truth

reconnect 语义也固定：

- 若 transport 死了，buffer manager / session runtime 只能做 **same session identity** 的 transport retry
- 不允许把 reconnect 实现成“先删 session 语义，再创建一个新 session 假装恢复”
- reconnect bookkeeping 也必须按 **session** 隔离：
  - 不允许再做 `same host -> reconnect bucket -> activeSessionId` 的跨 session 串行门
  - 一个 session 的旧 ws / handshake 卡住，**不得**挡住同 host 其他 session 的 retry / resume / active re-entry

---

## 3. renderer

renderer 只消费本地内容池，不驱动 transport。

### 3.1 renderer 真相

renderer 只维护：
- `mode`: `follow | reading`
- `renderBottomIndex`

派生：

```text
renderTopIndex = renderBottomIndex - viewportRows
renderWindow = [renderTopIndex, renderBottomIndex)
```

### 3.2 follow

- follow 时，收到 head / buffer 更新后
- 将 `renderBottomIndex` 对齐到最新底部
- 重新从本地 buffer 取当前窗口渲染

### 3.3 reading

- 用户上滚进入 reading
- reading 时只改自己的 `renderBottomIndex`
- 取的是 reading head 往回 3 屏的渲染窗口
- buffer 更新不会自动改变滚动语义

### 3.4 reading 退出条件

只允许：
1. 重新进入
2. 下滚到底
3. 用户输入

### 3.5 renderer 明确不做

- 不直接 request daemon
- 不决定 buffer pull
- 不修改 buffer 内容
- 不因为 buffer 变化自动滚动
- 不修改 cursor 真相；cursor 颜色 / 样式 / 位置语义都不能由 Android client 自己二次生成
- 不允许把“窗口不连续”解释成“已有内容不存在”
- 当前窗口缺行时，应继续消费已有 absolute-index 内容，并把缺口显式视为 gap / blank marker，而不是把整屏当空

### 3.6 宽度模式真源

terminal 宽度语义固定为两种模式：

1. `adaptive-phone`
   - 当前手机适配模式
2. `mirror-fixed`
   - **上游宽度真相固定在 daemon mirror / tmux**
   - client viewport / safe-area / IME / renderer 容器宽度变化，**不得改写上游 mirror buffer 宽度**
   - renderer 只能消费已有绝对列 truth，并维护自己的横向渲染窗口

`mirror-fixed` 的显示规则：

- 行宽大于 viewport 时，默认只显示左侧裁切窗口
- 用户若要看右侧，只能移动 renderer 的横向窗口
- 可以通过字体缩放让同一 viewport 容纳更多列
- renderer 的**列宽真相**必须来自客户端实测的像素宽度；不能再把浏览器 `1ch / 2ch` 当终端列宽真相
- 双宽 cell 只能按 `2 * measuredCellWidthPx` 渲染；如果浏览器 fallback 字体导致 CJK glyph 宽度偏移，也必须由 renderer 的像素度量吸收，不能回写 daemon / buffer truth
- **不允许**因为手机变窄而重排旧行、重新 wrap mirror、或回写 daemon/tmux 宽度

### 3.6.1 renderer 列宽度量规则

- renderer 必须显式测量当前字体栈的：
  - 单宽 cell 像素宽度
  - 双宽 glyph 的像素占用
- 用于布局和 viewport cols 计算的统一真相为 `measuredCellWidthPx`
- 若双宽 glyph 的浏览器像素宽度大于 `2 * latinProbeWidth`，renderer 必须提升 `measuredCellWidthPx`，而不是继续信任 `ch`
- 该规则只影响 renderer 布局，不影响 daemon mirror / client buffer 的绝对列 truth

### 3.7 横向平移与 tab 手势边界

`mirror-fixed` 下固定规则：

1. 自动关闭左右滑切 tab
2. 单指横滑只用于 renderer horizontal pan
3. 一次手势只能命中“横向平移”这一条语义

这条属于 UI shell / renderer 的边界，不属于 buffer manager，更不属于 daemon

---

## 4. UI shell

UI shell 只负责：
- terminal 容器位置
- 可见区域裁切
- keyboard / IME 抬升

### 4.1 IME 规则

- IME 只移动容器，不改变内容
- IME 不影响 buffer manager 决策
- IME 不影响 renderer 内容真相
- keyboard inset 只能消费一次：**terminal stage** 负责用 `quickBarHeight + keyboardLift` 做底部裁切，**QuickBar 容器** 负责用 `bottom = keyboardLift` 整体抬到键盘上方；禁止再通过 QuickBar 内部 `padding/margin` 对同一份 inset 二次抬升
- 若 QuickBar 自己的 textarea / sheet / composer 拿到 DOM focus，只允许暂停 terminal ImeAnchor 路由；**不得**把 QuickBar overlay / floating composer 使用的 `keyboardInsetPx` 清零。也就是 terminal body 可以让出 IME，但 UI shell 仍必须继续吃同一份键盘高度真相，避免被输入法盖住
- Android terminal header 的顶部 inset 必须是 **UI shell 提供的稳定单一像素真相**；IME 弹起导致的 `visualViewport.offsetTop` 不得被二次叠加成 header top inset
- Android connect / reconnect 不得把 UI 容器当前测得的 `cols/rows` 回写给 daemon 作为 tmux geometry 真相；shell 高度变化只允许影响容器裁切，**不得**改写 tmux 宽高
- “看不到的区域不渲染”属于 renderer 的窗口绘制职责；正确做法是 renderer 根据容器可见高度只画当前窗口，而不是 UI shell / daemon 去把 tmux 变矮
- 若 Android terminal 输入走 `ImeAnchor`，则 native `EditText` 的 **editable / composing span / selection** 必须由 framework `InputConnection` 维护为单一真相；`commitText / finishComposingText` 不得跳过 `super` 直接短路，否则会出现输入法预编辑栏 caret 错位，但这仍属于 **IME truth bug**，不是 renderer truth

### 4.2 宽度模式配置入口

- 当前宽度模式配置真源在 **Settings**
- 它是 app 级全局唯一真相；不再允许 Host / Connection Properties 再保留第二份同语义配置
- 每个 active session attach / reconnect / mode toggle 都必须显式知道自己当前是：
  - `adaptive-phone`
  - `mirror-fixed`
- renderer / UI shell 只消费这个配置
- buffer manager 不关心这个配置
- daemon 也不关心 renderer 如何裁切；它只需要尊重“是否允许 client width 改写 mirror width”的协议边界

### 4.2.1 tmux geometry 写入边界

- **rows 不是 Android UI shell 的真相**
- Android runtime 后续运行期间：
  - keyboard / IME
  - safe-area
  - visualViewport
  - foreground / background
  - renderer 容器高度变化
  都**不得**继续改写 tmux rows
- 当前冻结做法：
  - tmux rows 要么只允许在首次初始化时确定一次
  - 要么直接保持上游 tmux / mirror 既有 rows
  - 之后一律不允许因为手机容器高度变化再写 rows
- `adaptive-phone` 若需要适配手机，只允许改 **width / cols**
- `mirror-fixed` 下连 **width / cols** 也不得改写上游 tmux / mirror
- server 侧 geometry 写点也必须唯一：
  - `attach` 不得接受 client rows 改写 tmux rows
  - `resize` 不得再写 rows
  - `width-mode reconcile` 只允许在 `adaptive-phone` 下改 cols
  - `mirror-fixed` 下 upstream geometry write 必须是 0

### 4.3 app lifecycle 规则

前后台、切 tab、恢复可见性，这些都属于 UI shell / app lifecycle。

它们只允许影响：

- 哪个 tab 当前 active
- 哪些 buffer tick 当前开启 / 关闭
- 哪个 terminal 容器当前可见

不允许影响：

- daemon mirror truth
- client local buffer truth
- logical client session 是否被销毁
- reconnect 是否变成“新建第二个 session”

---

## 5. 明确废止的旧实现

以下全部废止：

1. server 侧 planner / follow / reading 策略
2. stream-mode
3. snapshot / bootstrap 快照语义
4. renderer 直接触发 buffer request
5. buffer manager 直接改 renderer 状态
6. follow 下修本地历史 gap
7. 靠 fallback / 第二语义兜底
8. client width 变化直接把 daemon mirror / tmux 改成手机宽度
9. `mirror-fixed` 下左右滑切 tab 继续开启，和横向平移共享同一手势链

---

## 6. 真回环验收

必须同时看：

```text
tmux truth
-> daemon response
-> client buffer manager merge
-> renderer commit
-> Android APK 真实画面
```

最小场景：
1. 初次连接
2. 后台恢复
3. 输入英文 / 数字 / 空格 / 回车
4. reading 连续上滚
5. 输入退出 reading
6. daemon 重启恢复
