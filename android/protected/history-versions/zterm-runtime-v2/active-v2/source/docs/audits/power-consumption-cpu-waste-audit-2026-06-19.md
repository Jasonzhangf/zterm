# 费电 / 废 CPU 操作审计

- 审计对象：客户端代码（Android WebView / React SPA）
- 审计范围：timer / interval / RAF / observer / useEffect 排布
- 审计方法：grep 全部 setInterval/setTimeout/useEffect/ResizeObserver，逐层评估是否进入背景 / 是否清理、是否可合并

## 1. 真源数据

### 1.1 timer/interval 汇总（daemon 不归客户端费电，不展开）

| 文件 | 类型 | 用途 | cadence | 背景挂起？ | 风险 |
|---|---|---|---|---|---|
| `session-context-lifecycle.ts:243` | setInterval 500ms | 刷新 session debug metrics store | 500ms | 否（但仅 foreground 时写 ref，不压 DOM） | L（仅写 ref，不触发重渲染） |
| `session-context-lifecycle.ts:327` | setTimeout 链 | active tick refresh 链（head poll） | 16ms–66ms 动态 | foreground 才跑 | **M** |
| `session-context-lifecycle.ts:395` | setTimeout 链 | passive visible tick（非 active split 刷新） | 100ms–240ms | foreground 才跑 | L |
| `session-context-lifecycle.ts:218` | useEffect 无 deps | foreground resume → ensureActiveSessionFresh | 单次 | N/A | L |
| `session-context-socket-runtime.ts:84` | setInterval | session WS heartbeat ping | 30s | 否 | L（30s 一次） |
| `TmuxSessionPickerSheet.tsx:126` | setInterval 1000ms | clock tick（秒级刷新） | 1s | 仅当 picker open | **M**（打开 picker 时持续每秒 React setState） |
| `TerminalQuickBar.tsx:570` | setInterval | repeat long press interval | 可变 | 仅当 long press active | L |
| `useWebSocket.ts:57` | setInterval | 30s WS ping | 30s | 否 | L |
| `TerminalQuickBar.tsx:1032` | RAF | reset scroll | 单次 | N/A | L |
| `TerminalPage.tsx:1258` | RAF | viewport metrics 收集 | 每帧 | 否，但仅 runViewportRefresh 时 | **H** — 见 2.1 |

### 1.2 useEffect 链汇总（仅风险项）

| 文件 | 数量 | 最重 deps 链 | 风险 |
|---|---|---|---|
| `TerminalPage.tsx` | **72 个 useEffect** | `terminalWidthMode`, `sessions.length`, `uiSession`, `keyboardInset`, `splitVisible`, `shellHeight` 等高频变量 | **H** — 见 2.2 |
| `TerminalView.tsx` | 11 个 useEffect + 1 useLayoutEffect | `renderGeometryRevision`, `rowHeightPx`, `viewportClientHeightPx` 等 | **H** — 见 2.3 |
| `TerminalQuickBar.tsx` | ~30 个 useEffect | 每个切换/动画/输入 | **M** |
| `session-context-lifecycle.ts` | 12 个 useEffect | 全部有 clean/dedup | M |

### 1.3 ResizeObserver

| 文件 | 用途 | 清理 |
|---|---|---|
| `TerminalView.tsx:1196` | ResizeObserver → runViewportRefresh | ✅ useEffect unmount |
| `TerminalQuickBar.tsx:1538` | ResizeObserver → syncHeight | ✅ useEffect unmount |

### 1.4 资源泄漏风险

| 问题 | 风险 | 证据 |
|---|---|---|
| `registerClientDebugSnapshotSource` 注册永不移除 | **L** — source 注册后全局 map 永远保留，不对 DOM 产生副效果 | 每个组件 mount 时注册，unmount 时 unregister（已实现） |
| `snapshotSources` 无上限检查 | **L** — 当前只有 2 个注册源 | 不影响 CPU |
| `debug-log`/`debug-snapshot` 频繁 flush | **M** — cadence 由 `clientRuntimeDebugFlushIntervalMs` 控制，默认 5000ms | 5s 一次 flush，只传 ref 数据，不触发重渲染 |

## 2. 高风险分析

### 2.1 【P0】 `TerminalView` ResizeObserver + RAF 链 → 每帧重算

```ts
// TerminalView.tsx:1196
const observer = new ResizeObserver(() => runViewportRefreshRef.current());
observer.observe(host);
```

每次 resize 会触发 `runViewportRefresh`，其内调 `requestAnimationFrame`（`TerminalPage.tsx:1258`）收集 viewport 指标。问题：
- 分屏模式、键盘弹起、横竖屏切换时每帧会重算布局，`useMemo` 计算量大的场景下（如 `effectiveBufferEndIndex`, `followDemandAnchorEndIndex`, `renderGeometryRevision`）CPU 高。
- **修复方向**：RAF 内增加 `skipStaleFrame` 节流；分屏 mode 下扩大节流窗口。

**真机表现**：分屏 4 pane 时 4 个 `TerminalView` 各自有一个 `ResizeObserver`/RAF 链，合计每帧 4x 重算。

### 2.2 【P0】 `TerminalPage.tsx` 72 个 useEffect → 依赖链耦合导致链式重渲染

**问题根因**：
- 核心状态 `terminalWidthMode`, `keyboardInset`, `shellHeight`, `splitVisible` 等高频变化 → 依赖它们的 useEffect 全部触发。
- 其中最大的一个是 `registerClientDebugSnapshotSource`（L2242），dep 列表 27 项 → 每次其中任一项变化时全部 snapshot source 重建。
- `saveCurrentTabList` / `exportCurrentTabList` 虽不是 useEffect，但被保存按钮调用，不影响主循环。

**影响面**：每次键盘 inset 变化 → `shellHeight` 变化 → 几十个 useEffect 入队 → 链式 re-render → 主线程阻塞 → 输入延迟、掉帧、费电。

**修复方向**：
1. `registerClientDebugSnapshotSource` 改为只存 ref → 不触发 unmount/remount。
2. 高频 deps（`keyboardInset`, `shellHeight`）拆到独立 Ref 不做 useEffect key。
3. 分栏（splitVisible）场景减少 deps 链联动。

### 2.3 【P1】`TerminalView` 10+ useEffect 跟随 `renderGeometryRevision` 重跑

`renderGeometryRevision` 每次 viewport / buffer 变化时自增 → 依赖它的 `reconcileViewportAfterBufferShift`, `emitRenderDemandSignalsForCurrentFrame`, `syncScrollHostToRenderBottom` 三个 useEffect 都会触发。

在分屏刷新期间（buffer 每秒多帧变化），`renderGeometryRevision` 变化率 ~10–30/s → 每帧触发一次清理和重建。

**修复方向**：`renderGeometryRevision` 改在 RAF 内 diff，不在 useEffect dep 链内扩散。

### 2.4 【P2】`session-context-lifecycle` active tick chain 无退场 cancel

`active tick` 链（L327）每 tick 结束后 `scheduleNext()` 永远重新 setTimeout，即使已到背景页或退到后台。
- 当前代码在 `foregroundActiveRef` 为 false 时跳过 `ensureActiveSessionFresh` 但仍在 `scheduleNext()`。
- 这意味着**背景时仍保持 16ms 级 setTimeout 循环**，每秒 ~60 次空 tick。

**证据**：`scheduleNext()` 在 `!foregroundActiveRef` 分支直接 return，但实际代码路径是：

```ts
if (!options.refs.foregroundActiveRef.current) {
  scheduleNext();  // ← 空循环
  return;
}
```

**修复方向**：`foregroundActiveRef` 为 false 时，下一次定时器放大到 1000ms，不让 CPU 跑空。

### 2.5 【P2】`TmuxSessionPickerSheet` 1s setInterval → 永远在 React state

每打开 picker 一次，就起一个 1s setInterval 触发 `setClockTick`。picker 关闭时已清理（✅ `return () => window.clearInterval(timer)`），但若多 pane 同时打开多个 picker… 当前无叠加场景。

不影响。

### 2.6 【P2】`client-debug-snapshot` 每 5s 全量 snapshot 收集

`collectClientDebugSnapshot()` 内 for-of 迭代 `snapshotSources.entries()`。2 个 source（app-shell, terminal-page），不重。每 5s 挂到 `sessionDebugMetricsStoreRef` 不做同步 IO。

**影响**：极小。但 `terminal-page` source 的 producer 内计算大量 UI 状态（shellHeight, keyboardInset 等）——这些是读 React 状态，不写，不触发 re-render。

## 3. 分层修复优先级

| 优先级 | 问题 | 影响 | 修复方向 |
|---|---|---|---|
| **P0** | `TerminalPage` 72 useEffect + 27-dep snapshot chain | 链式 re-render → 费电（触摸屏响应延迟） | snapshot source 改为 ref；高频 deps 剥离 |
| **P0** | `TerminalView` × N pane 各自 ResizeObserver/RAF 每帧 4× 重算 | 分屏模式 CPU 高 → 掉帧、发热 | RAF 节流 + skipStaleFrame |
| **P1** | `renderGeometryRevision` 作为 3 个 useEffect dep → 每帧触发清理 | 主线程抖动 | 改为 RAF 内 diff |
| **P2** | 背景时 active tick 链仍保持 16ms setTimeout 循环 | CPU 白跑→ 费电 | foreground 为 false 时延时到 1000ms |
| **P3** | `TmuxSessionPickerSheet` 1s setInterval | picker 打开时每秒 setState | 无需修改（已清理） |
| **P3** | `sessionDebugMetricsStoreRef` 500ms refresh | 只写 ref 不渲染 | 无需修改 |

## 4. 与 daemon 费电的边界

- daemon `setInterval heartbeat` = 30s（✓ 低`)
- daemon `setInterval memoryGuard` = 30s（✓ 低）
- daemon `liveSyncTimer` = 33ms–120ms（mirror 规格内）
- daemon 费电主要来自 capture/canonicalize（由 R9 0-delay lane 放大）—— 这是全审计的首个 P0

**结论：客户端费电主因是 TerminalPage 的 useEffect 风暴 + TerminalView 的 RAF/ResizeObserver 分屏不节流 + 背景时 tick 链空跑。daemon 费电主因是 liveSyncTimer 0-delay fast lane。**

## 5. 审计结论

| 类别 | 条目 | 主责任人 | 影响范围 |
|---|---|---|---|
| 客户端 | P0 useEffect 风暴 | TerminalPage.tsx | 全部连接用户 |
| 客户端 | P0 分屏 4× RAF 链 | TerminalView.tsx | 分屏用户 |
| 客户端 | P2 背景空跑 tick | session-context-lifecycle.ts | 后台活跃用户 |
| daemon | P0 0-delay fast lane（另见 daemon audit R9） | terminal-performance-scheduler.ts | 全部连接用户 |
| daemon | P0 head 请求 N²（另见 R1+R2） | terminal-mirror-runtime.ts + server.ts | 多 pane / 多 sub 用户 |
