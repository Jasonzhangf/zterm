# keyboard/IME 主闭环 Closeout 审计

- 日期：2026-05-24
- 审计对象：`android/src/pages/TerminalPage.tsx` 内的 keyboard/IME 区块

## 1. 已知事实

本轮用 Python 枚举了 TerminalPage 中所有 keyboard/IME 相关 owner 的引用关系，得到如下依赖图。

### 核心 state owner

| state | 引用数 | 核心语义 |
|-------|--------|---------|
| `terminalKeyboardRequested` | 16 | IME 可见性真相 |
| `keyboardInset` | 19 | keyboard 高度真相 |
| `quickBarEditorFocused` | 20 | quickbar editor 激活真相 |
| `focusNonce` | 2 | terminal focus retry 触发器 |

### Ref owner

| ref | 引用数 | 核心语义 |
|-----|--------|---------|
| `activeSessionIdRef` | 5 | 当前活动 session，用于 IME routing |
| `quickBarEditorFocusedRef` | 9 | quickbar focus 的 mutable mirror |
| `terminalInputHandlerRef` | 3 | terminal input handler 的 mutable ref |
| `pendingAndroidImeFocusTimerRef` | 6 | IME focus 防抖 timer |
| `androidImeFocusRouteKeyRef` | 5 | IME focus routing key 防重 |
| `terminalFocusRetryTimeoutsRef` | 5 | focus retry timers |
| `stableLayoutViewportHeightRef` | 5 | viewport freeze 语义 |

### Callback owner（5 个互相依赖）

| callback | 引用数 | 核心语义 |
|---------|--------|---------|
| `updateTerminalKeyboardRequested` | 12 | IME 可见性 setter |
| `updateKeyboardInset` | 6 | keyboard 高度 setter |
| `requestAndroidImeFocus` | 9 | IME focus routing 编排 |
| `restoreAndroidTerminalImeRoute` | 5 | IME routing 恢复编排 |
| `keepTerminalInputFocused` | 3 | 统一保持 focus 编排 |

### 跨闭环 callback

| callback | 引用数 | 备注 |
|---------|--------|------|
| `setAndroidEditorActive` | 5 | 调用 ImeAnchor.setEditorActive |
| `handleToggleKeyboard` | 3 | toggle 编排，调用 ImeAnchor.hide/show |
| `handleQuickBarEditorDomFocusChange` | 3 | DOM focus → IME state 联动 |
| `focusTerminalInput` | 5 | DOM input focus 编排 |
| `updateViewportMetrics` | 5 | viewport resize 编排 |
| `scheduleViewportMetricsSync` | 8 | viewport rAF 节流编排 |

### 计算属性

| property | 引用数 | 核心语义 |
|----------|--------|---------|
| `keyboardViewportFreezeActive` | 4 | viewport freeze 判定 |
| `shellHeight` | 5 | terminal 可用高度 |
| `rawShellHeight` | 7 | viewport 原始高度 |

## 2. 依赖闭环证据

### 2.1 核心状态互相触发闭环

```
terminalKeyboardRequested <-> keyboardInset
         ↓                    ↓
requestAndroidImeFocus <-> updateKeyboardInset
         ↓                    ↓
updateTerminalKeyboardRequested <-> keyboardStateListener (ImeAnchor)
         ↓
restoreAndroidTerminalImeRoute -> keepTerminalInputFocused
```

这三个 state 同时出现在同一个条件判断中：
- `keyboardViewportFreezeActive = isAndroid && (terminalKeyboardRequested || keyboardInset > 0)`
- `restoreAndroidImeRoute` 的触发条件：`!(terminalKeyboardRequested || keyboardInset > 0)`
- `requestAndroidImeFocus` 的早期返回条件：`quickBarEditorFocusedRef.current`
- `handleToggleKeyboard` 的分支条件：`terminalKeyboardRequested || keyboardInset > 0`

### 2.2 quickBarEditorFocused 交叉依赖

`quickBarEditorFocused` state 和 `quickBarEditorFocusedRef` ref 互相缠绕：
- ref 的唯一目的是避免在 async/nested context 中读 stale state
- 但 ref 的值由 `quickBarEditorFocused` state 同步更新
- 这意味着 ref 和 state 必须同属于同一个 owner

### 2.3 activeSessionIdRef 的双向流动

- 写入：`activeSessionIdRef.current = interactiveSession?.id || null`
- 读取：`emitToActiveSession`（在 ImeAnchor listener 中）
- 这说明这个 ref 必须留在持有 `interactiveSession` 真相的 owner 内部

## 3. 可切 / 不可切分类

### 3.1 绝对不可切（核心闭环）

以下 owner 彼此互相引用，形成不可拆解的闭环：

1. **`terminalKeyboardRequested ↔ keyboardInset ↔ quickBarEditorFocused`**
   - 三者同时决定 `keyboardViewportFreezeActive`
   - 任何一个被迁走，其余两者仍会在同一条件判断中出现

2. **`pendingAndroidImeFocusTimerRef ↔ requestAndroidImeFocus ↔ restoreAndroidTerminalImeRoute`**
   - timer ref 只在 `requestAndroidImeFocus` 内被写入
   - 但 timer cancel 逻辑在 `restoreAndroidTerminalImeRoute` 内
   - 形成单向但不可分割的语义链

3. **`activeSessionIdRef ↔ terminalInputHandlerRef ↔ ImeAnchor listeners`**
   - 两个 ref 都在 ImeAnchor listener 闭包内被读取
   - 任何 ref 被迁走，listener 闭包必须同步更新
   - listener 本身不可外抽（因为它持有 `emitToActiveSession` 这个跨模块调用）

### 3.2 外围可切但收益低

| 可切目标 | 切出条件 | 收益 |
|---------|---------|------|
| `updateViewportMetrics` + `scheduleViewportMetricsSync` | 依赖 `viewportWidth` / `headerTopInsetPx` state，可迁出但页面仍需这两个 state | 低（只是改名转发） |
| `updateTerminalKeyboardRequested` | 只写 state，可迁出但 state 仍需留在闭环内 | 极低 |
| `updateKeyboardInset` | 同上 | 极低 |
| `setAndroidEditorActive` | 只调用 `ImeAnchor.setEditorActive`，可单独抽成 ImeAnchor wrapper，但会被 ImeAnchor listener effect 内联调用 | 低 |

### 3.3 可以切但不改变闭环本质

- `focusNonce`：可以移入独立 hook，但 `focusNonce` 只被 `focusTerminalInput` 写入、`TerminalStageShell` 读取
- 如果 `TerminalStageShell` 已经外抽，继续把 `focusNonce` 迁入主闭环外会更干净
- 但这不是降低主闭环复杂度，只是把主文件里的一个 state 移走

## 4. 唯一正确 Closeout 顺序

基于上述分析，当前 keyboard/IME 闭环不存在可独立验证、安全拆出、不制造双 owner 的小切片。

唯一正确的 closeout 路线图只有两条：

### 方案 A：暂缓，等自然切片出现

接受当前主闭环，继续从其他方向（viewport shell-height、page-level JSX）压缩主文件。

**前提**：主文件已从 ~2500 行压到 1371 行，剩余大部分是 keyboard 闭环，这不是失败而是架构现实。

### 方案 B：一次性大重构

把整个 keyboard/IME 区块一次性封装进一个新的 hook，例如 `useTerminalPageKeyboardRuntime.ts`。

**关键风险**：
- 需要把 5 个 state (`terminalKeyboardRequested`, `keyboardInset`, `quickBarEditorFocused`, `focusNonce`, 以及 `viewportWidth`/`headerTopInsetPx` 的部分)
- 需要把 7 个 refs 全部迁入 hook
- 需要把 5+ 个 effects 全部迁入 hook
- 需要 hook 持有 `ImeAnchor.addListener` / `Keyboard.addListener` 的生命周期
- 需要 hook 持有 `activeSessionIdRef` / `terminalInputHandlerRef`（跨模块依赖）

如果走这条路，验证门槛是：
1. 新 hook 有独立的单测
2. Android IME 回归测试全绿
3. `TerminalPage` 只持有 props 透传和 JSX 组合

**但这条路的收益是：可以把主文件再压掉约 300 行**

## 5. 当前唯一正确判断

**keyboard/IME 主闭环当前没有安全小切片可独立验证地拆出。**

证据：
- 核心 state 三者互相依赖
- `quickBarEditorFocused` state 和 ref 不可分割
- ImeAnchor listener 内持有 `activeSessionIdRef` 和 `terminalInputHandlerRef`
- 所有 effects 共享相同的 deps 数组

唯一值得做的小优化是：
- 把 `updateViewportMetrics` + `scheduleViewportMetricsSync` 这组 viewport resize 编排迁出
- 但这不会改变闭环体量，只是换个文件放

## 6. 结论

当前主文件剩余 owner 中，keyboard/IME 闭环是唯一未解决的真正 owner 热点。

这不是"还没想好怎么拆"，而是"当前没有可安全验证的小切片边界"。

**建议的下一步**：先验收当前 1371 行的架构，认定 keyboard/IME 闭环是最后一个需要专门闭包的 owner热点，然后在后续专门安排一轮大重构，而不是继续用小切片方式碎片化推进。
