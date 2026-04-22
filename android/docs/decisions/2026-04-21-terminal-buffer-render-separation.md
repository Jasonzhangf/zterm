# 2026-04-21 Terminal buffer / render / scroll 解耦重构决议

## 目标

解决 Android 终端当前两个根问题：

1. **看不到真正底部**：客户端“到底”与 daemon 真底不一致，甚至会差一个 viewport。
2. **用户回滚时仍被 live update 强制拉回底部**：buffer 接收、render 锚点、scroll 状态三者被耦合。

本决议要求：

- **只保留一个真源：daemon canonical buffer**
- **daemon 只做一件事：更新 buffer，发送 buffer**
- **client 只读 canonical buffer，不反向影响 daemon buffer**
- **render state 与 buffer state 分离**
- **scroll state 与 render state 分离**
- **cursor 也属于 canonical buffer 本身，不走第二路解释**
- **显示逻辑留在 client，但 client 只忠实渲染 buffer，不再猜 cursor**

---

## 证据

### 证据 1：到底不是真底
用户截图显示：

- App 端底部仍停在较早的一段日志
- 同一时刻 tmux 真底已经出现后续多屏内容
- 差距不是 2~3 行，而是**约 1 个 viewport**

这说明当前“scroll 到底”只是滚到了**客户端某个投影视图的底**，而不是 daemon canonical buffer 的真实 `availableEnd`。

### 证据 2：手动回滚时仍被 live update 干扰
用户已多次确认：

- 当底部持续刷新时，用户一往回滚，视图还会被自动拉回
- 当没有 live update 时，滚动相对正常

这说明当前逻辑依然把：

- buffer revision 更新
- render projection 切换
- DOM scroll 恢复

绑在同一条路径上。

### 证据 3：光标仍带本地解释痕迹
当前客户端仍存在：

- `cursorRow/cursorCol`
- `term-cursor`
- 本地在 row/cell 上额外判断是否加 cursor class

即使外观改了，也仍然是**客户端自己解释光标**，不符合“远端真源”的要求。

---

## 当前设计的核心反模式

### 反模式 A：同一组件同时拥有三种职责
`TerminalView.tsx` 当前同时负责：

1. buffer 投影切换
2. 用户滚动状态机
3. DOM scrollTop 恢复/到底

这导致任何新 buffer revision 到来，都可能触发 scroll 纠偏。

### 反模式 B：buffer truth 与 render projection 双真源
当前有：

- incomingProjection
- renderProjection
- deferredProjection
- manualScrollAnchor

虽然目的是 freeze render，但实际形成了“多个投影对象并存”。
问题不在于有没有 freeze，而在于：

- **没有把 render 锚点定义成独立的一等状态**
- 而是靠 projection 替换来模拟 render freeze

### 反模式 C：光标在 client 解释
当前 client 仍基于 `cursorRow/cursorCol` 决定哪一个 cell 加 `.term-cursor`。
这意味着：

- 宽字符/续位字符处理仍可能错
- 颜色/反色/主题差异会继续出现
- 光标不是 buffer 的一部分，而是额外的本地 overlay

### 反模式 D：delta/range/sync 是同一 buffer，但 render 逻辑没有只消费“一个绝对窗口”
虽然 payload 现在带绝对行号，但 UI 端并没有把“当前阅读锚点”定义为：

- `renderTopIndex`
- `viewportRows`
- `visibleWindow = [renderTopIndex, renderTopIndex + viewportRows)`

而是继续让 DOM scroll + projection 替换共同决定“当前看哪里”。

---

## 新设计：四层拆分

```text
Daemon canonical buffer
        ↓
Client canonical mirror buffer
        ↓
Render model (read-only, derived)
        ↓
DOM scroll container (pure view interaction)
```

### 1. Daemon canonical buffer（唯一真源）

每个 tmux session 在 daemon 只维护一个 canonical buffer：

```ts
interface CanonicalBuffer {
  availableStartIndex: number
  availableEndIndex: number
  viewportStartIndex: number
  viewportEndIndex: number
  rows: CanonicalRow[]   // contiguous, absolute-indexed window；cursor 已包含在 row cells 真相里
  revision: number
}
```

约束：

- daemon **只维护事实数据**：buffer、absolute index、viewport index
- cursor 也是 buffer 真相的一部分，不允许走第二路 metadata 再解释
- daemon **不负责 client 交互逻辑**，只发送 canonical buffer 事实
- sync / delta / range 只是这个 canonical buffer 的**不同切片发送方式**
- 不允许“最新 viewport 用一种结构，历史用另一种结构”
- 不允许 snapshots 这类第二真源继续参与渲染链路

### 2. Client canonical mirror buffer（只读镜像）

客户端只做一件事：**按绝对行号合并 daemon buffer 切片**。

它的职责只有：

- 接收 `buffer-sync | buffer-delta | buffer-range`
- 按绝对行号合并为一个 contiguous mirror window
- 更新：
  - `startIndex`
  - `endIndex`
  - `availableStartIndex`
  - `availableEndIndex`
  - `viewportStartIndex`
  - `viewportEndIndex`
  - `revision`

它**不负责**：

- 决定当前渲染看哪里
- 决定当前是否 follow
- 决定滚动到哪里
- 猜测“真正底部”是否等于 `availableEndIndex - rows`

补充约束：

- client 的 follow 底部必须优先消费 daemon 给出的 authoritative `viewportStartIndex`
- 若 authoritative viewport 晚于本地 `availableEnd - rows`，必须用 **virtual bottom padding** 表示这段尾部差值；不能把它吞掉再让用户误以为“已经到底”
- client 上报的 `viewportRows` 是**可见 pane 行数**，不是 tmux PTY 总行数；若 tmux `status=on`，daemon 在 resize PTY/tmux 时必须补上 status line 行数，否则 tmux `pane_height` 会稳定比 client 少 1 行，导致 canonical buffer 与渲染窗口持续错位
- 但 authoritative viewport 只在 **daemon rows 与 client 当前 viewportRows 一致** 时才可直接参与 client follow 贴底；若两者不一致（例如同一 tmux session 被不同 geometry 的客户端共用），client 必须回退到本地 `availableEndIndex - viewportRows`，否则会把别的 client viewport 真相错误投影成当前设备上的 blank rows
- 输入法弹起/收起只允许改变 shell/canvas 的视觉位移；IME 期间禁止把 visual viewport 变化直接提交为 daemon resize，因为那会把输入法动画误当成 terminal buffer geometry 变化

### 3. Render model（纯派生）

每个 session 单独维护：

```ts
interface RenderState {
  mode: 'follow' | 'reading'
  renderTopIndex: number
  viewportRows: number
}
```

#### follow 模式

规则：

```ts
renderTopIndex = max(buffer.availableEndIndex - viewportRows, buffer.startIndex)
```

特点：

- 新 buffer 到来时，renderTopIndex 自动跟随最新底部
- render 永远指向 canonical buffer 的真实尾部

#### reading 模式

规则：

- `renderTopIndex` 由用户手势滚动决定
- 新 buffer 到来时：**只更新 client mirror buffer，不更新 renderTopIndex**
- 所以用户看到的窗口不会动

#### 退出 reading 仅两种情况

1. 用户滚回底部
2. 用户发生输入

除此之外，任何 buffer 更新、重连、delta、range、resize 都**不能**自动退出 reading。

### 4. DOM scroll container（纯视图层）

DOM 容器只负责：

- 呈现当前 `visibleWindow`
- 把手势滚动转换成 `renderTopIndex` 变化
- 不拥有 buffer truth
- 不拥有 follow / reading 决策权

DOM scroll 不再作为“真状态”。
它只是 `renderTopIndex` 的一个表现形式。

---

## Daemon 内存边界补充

虽然 daemon 只维护 canonical buffer，但它仍要遵守运行态内存边界：

1. **mirror 不能在最后一个客户端断开后无限常驻**
   - detach/reattach 可以保留短暂 warm 状态
   - 但必须有 orphan TTL / reaper，超时后释放 PTY、bridge、buffer

2. **capture/reconcile 不能每次 flush 都新建 scratch runtime**
   - scratch terminal / wasm bridge 必须复用
   - 否则高频 flush 会把 reconcile 本身变成持续的内存/实例分配热点

---

## 光标设计（cursor 属于 canonical buffer）

### 新规则

- cursor 不是额外 metadata，也不是 client overlay 推导结果
- cursor 就是 canonical buffer 的一部分
- daemon 发什么 buffer，client 就渲染什么 buffer
- daemon / client 都不猜

### 具体做法

1. daemon 在 canonical row 中直接保留 cursor 对应 cell 的真实状态
2. sync / delta / range 发送的永远是同一种 row 结构
3. client 不再维护第二套 cursor 渲染真相，不再基于输入状态或 DOM 状态补推光标

结论：

- cursor 与普通文本一样，属于同一个 canonical buffer 真源
- client 只有一条渲染链路：渲染 buffer
---

## 关键状态机

### 用户滚动状态机

```text
follow
  └─(用户上/下滑离开底部)→ reading

reading
  ├─(用户滚回底部)→ follow
  └─(用户输入)→ follow
```

### buffer 更新状态机

```text
daemon new revision
  → client mirror merge
  → if mode=follow:
       recompute renderTopIndex to bottom
    else if mode=reading:
       keep renderTopIndex unchanged
```

### 历史加载状态机

```text
reading + near top of local mirror
  → request older range
  → merge prepend into mirror
  → keep renderTopIndex anchored to same absolute line
```

注意：

- 历史 prepend 后，用户看到的 top line 不能跳
- 必须按绝对行号恢复同一 logical line

---

## “到底”正确算法

当前最大 bug 是到底不是 daemon 真底。

### 新标准

底部必须定义为：

```ts
bottomTopIndex = max(buffer.availableEndIndex - viewportRows, buffer.startIndex)
```

不是：

- DOM `scrollHeight - clientHeight`
- 某个 projection 的最后一行
- 当前 slice 的最后一行

### follow 时

始终保证：

```ts
renderTopIndex === bottomTopIndex
```

### 用户输入时

无条件：

1. `mode = follow`
2. `renderTopIndex = bottomTopIndex`
3. 如果本地 mirror 没覆盖到底部尾窗，立即请求尾部 sync/range

---

## 重连设计

重连后也必须走同一套 canonical buffer：

1. daemon 先发送最新尾窗 sync
2. client 用同一 mirror merge 逻辑覆盖尾部窗口
3. 若用户处于 reading：
   - 保留 renderTopIndex
   - 若该 top line 已掉出 mirror，则钳制到当前最早可见位置
4. 若用户处于 follow：
   - 直接对齐到底部

禁止：

- 重连时用 snapshot 直接替代当前 render source
- 重连时切换到另一种“恢复专用结构”

---

## 文件级重构边界

### Daemon

#### `android/src/server/server.ts`
拆出：

- `canonical-buffer.ts`
  - 维护 session canonical buffer
  - 统一 sync/delta/range slice
- `canonical-buffer-types.ts`
  - 只定义 canonical buffer row / viewport range

目标：server 只做 canonical fact 的维护与发送；cursor 直接属于 canonical buffer，不承载 client 交互逻辑。

### Client store

#### `android/src/lib/terminal-buffer.ts`
只保留：

- canonical mirror merge
- absolute index contiguous window merge
- 不包含 render/follow/scroll 语义

#### 新增 `android/src/lib/terminal-render-state.ts`
只负责：

- `mode`
- `renderTopIndex`
- `viewportRows`
- bottomTopIndex 计算
- 输入/到底/手势滚动状态转换

### UI

#### `android/src/components/TerminalView.tsx`
删除：

- projection 双真源
- deferredProjection
- incomingProjection/renderProjection 这一套
- 本地 cursor 推导

保留：

- 渲染当前 visible window
- DOM 手势 → renderTopIndex
- debug overlay metrics 上报

---

## 验收标准

### A. 到底

- 连接后默认到底
- 输入后无条件到底
- 到底时 App 最后一屏与 tmux 最后一屏一致
- 不允许再差一个 viewport

### B. 回滚

- 用户一旦离开底部进入 reading
- daemon 持续刷新时，当前画面不跳
- 用户可稳定继续上下滚
- 只有到底/输入才能恢复 follow

### C. 历史

- 历史与最新使用同一 row 结构、同一颜色体系
- prepend 后不会拼错、不会错位、不会黑白分裂

### D. 光标

- 不允许 client 再自己猜 cursor
- 光标外观由 daemon 真源决定
- 宽字符/中文输入时不再出现本地错格

---

## 本决议之后的执行顺序

1. **先按本决议拆 state 和 ownership**
2. 先收口 `server canonical buffer -> client mirror buffer`
3. 再收口 `render state`
4. 最后再接 DOM scroll/gesture
5. 禁止再用补丁式方式在 `TerminalView.tsx` 继续叠加 projection / anchor / scroll hack

这份文档是接下来重构的唯一设计真源。
