# 2026-04-22 Terminal daemon truth / client mirror reset

> **已废止 / superseded**：本页中关于 “zterm clients min geometry -> tmux resize” 的旧宽度策略，已被
> `2026-04-23-terminal-head-buffer-render-truth.md` 覆盖。
>
> 当前唯一真源补充为：
> - `adaptive-phone`
> - `mirror-fixed`
>
> 尤其是：
> - `mirror-fixed` 下，client viewport / IME / container width 不得改写 daemon mirror / tmux 宽度
> - 横向查看属于 renderer crop/pan，不属于 daemon geometry policy

## 决策

Android 终端链路收敛到一个更硬的模型：

```text
tmux truth
    ↓
daemon tmux mirror (唯一真源)
    ├─ canonical line buffer
    ├─ canonical cursor/view bottom
    └─ zterm clients min geometry -> tmux resize
                  ↓
        client mirror buffer (绝对行号镜像)
                  ↓
 render window = [viewportEndIndex - localViewportRows, viewportEndIndex)
                  ↓
      render container position (IME / quick bar 只抬容器)
```

核心要求：

1. **daemon 是 tmux 的 mirror，且是唯一真源**
   - 只观察 tmux truth
   - 只维护 canonical line buffer / cursor truth / viewport bottom truth
   - 只按 zterm 已连接 clients 的最小 geometry 通知 tmux resize
   - 不把 Termius/iTerm 等外部 tmux clients 的尺寸纳入 geometry policy
   - 不改写 tmux 内容本身；daemon 只发送控制，不在 daemon 侧二次改写/裁剪/重排 tmux 内容
   - 不做客户端显示推导
2. **client 不排版、不重算 shell 内容**
   - 不本地造光标
   - 不本地猜“最后一屏”
   - 不把 IME/keyboard 变化回灌成 buffer 语义
3. **客户端渲染先只做一件事**
   - 拿 daemon 给的 `viewportEndIndex` 作为底部指针
   - 用本地 `viewportRows` 从底部往上切一屏
   - 缺失行显式 blank，不再靠 start/end 双向凑
4. **IME 只影响容器位置**
   - 不改 tmux 高度
   - 不改 buffer
   - 不改 viewport 真相
5. **tmux geometry**
   - client 连接初始化上报尺寸
   - daemon 对多 client 选择最小 geometry
   - 只有真实 geometry 变化才允许 resize
   - IME show/hide 不属于 geometry change
6. **历史 buffer 不可回写**
   - 已经进入 canonical buffer 的行视为已发生事实
   - 后续 tmux resize 只影响新输出，不允许回写/重排旧历史

---

## 这次审计确认的当前差异

### 差异 1：server 仍有双光标通道

当前 `src/server/server.ts` 里仍然同时存在：

- `paintCursorIntoViewport(...)`：把 cursor 烘焙进 viewport row cells
- `cursorRow/cursorCol/cursorVisible`：再发一条 metadata 通道

结论：
- daemon 侧仍有**双光标真相残留**
- 只要 client 继续吃 metadata，就还会重回双真源

### 差异 2：client 仍把 viewport 起止成对解释

当前 `src/components/TerminalView.tsx` 之前的做法是：

- 同时依赖 `viewportStartIndex`
- 同时依赖 `viewportEndIndex`
- 再和本地 measured rows 混合推导显示窗口

结论：
- 这会把“底部指针”与“本地屏幕高度”耦在一起
- 常见结果就是：底部对上了，但顶部仍差几行/一屏

### 差异 3：client 曾经本地画假光标

当前 Android 客户端曾用 `cursorRow/cursorCol` 在 cell 上额外画 outline。

结论：
- 这不是 buffer 渲染，而是本地 overlay
- 不符合“只渲染 buffer 光标”的要求

### 差异 4：daemon 还没有完成多 client 最小 geometry 收敛

当前 server 仍是收到 resize 就直接 `resizeConnectedMirror(...)`。

结论：
- 还没有实现“多 client 取最小 geometry”
- 这部分属于下一刀 daemon 收敛项

---

## 本轮先冻结的最小实现

### A. 渲染窗口

客户端当前只保留：

```ts
renderBottomIndex = daemon.viewportEndIndex
renderTopIndex = max(availableStartIndex, renderBottomIndex - localViewportRows)
visibleWindow = [renderTopIndex, renderBottomIndex)
```

规则：
- 先保证“正确最后一屏”
- 不先讨论 reading/follow 状态机
- 不先讨论复杂滚动
- 不再拿 `viewportStartIndex` 和本地高度双向凑结果

### B. 光标

当前客户端只渲染 buffer cells：
- 不再用 `cursorRow/cursorCol` 画本地 outline
- 光标显示以 daemon 提供的 canonical row cells 为准

### C. 输入法

输入法 show/hide：
- 只改 render container 的视觉位置
- 不改 tmux geometry
- 不改 buffer
- 不改 viewport truth

### D. server 职责边界

server 只允许做两件事：

1. mirror tmux truth
2. 用 zterm 活跃 clients 的最小 geometry 改 tmux

除此之外都不属于 server 职责：
- 不做 client render 推导
- 不做本地假 cursor
- 不做 input-driven truth
- 不做 resize 后旧历史重排真相
- 不做 tmux 内容语义改写

---

## 下一步清理顺序

1. **server 清双光标残留**
   - 保留 buffer 内 cursor truth
   - 把 metadata cursor 从渲染链路里彻底移出
2. **server 收敛 geometry policy**
   - 为每个 client 记录 geometry
   - mirror/tmux 取最小 cols/rows
   - 仅在有效最小 geometry 变化时 resize
3. **client 清理旧阅读/滚动残留**
   - 去掉无效 follow/gesture/debug 残留
   - 保证渲染只依赖绝对窗口
4. **最后再补 reading/scroll**
   - 在“最后一屏准确”之后再补滚动状态机

---

## 成功标准

### 当前切片成功标准

必须同时满足：

1. tmux 真最后一屏正确
2. daemon 发出的 viewport bottom 指针正确
3. Android 客户端显示的最后一屏与 daemon/tmux 一致
4. IME 弹出/收起只上抬画面，不触发 tmux 高度变化
5. client 不再渲染本地假光标

### 验证证据

- `pnpm type-check`
- Android build 通过
- debug overlay 中：
  - `renderBottomIndex == viewportBottomIndex`
  - `localWindowEndIndex` 与 buffer 尾部对齐
- 真机截图对比 tmux / daemon buffer / Android render
