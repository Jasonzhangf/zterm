# Optimization: 客户端 useEffect 风暴 & 费电优化

## 目标
将 TerminalPage 72 个 useEffect 的链式重渲染降低 60%+，分屏模式 4× RAF 每帧重算降低到 1× 节流版，背景空跑 tick 消除。

## 当前证据
- TerminalPage 72 useEffect，最大一个 dep 列表 27 项（registerClientDebugSnapshotSource）
- keyboardInset/shellHeight/splitVisible 高频变化时 ~20+ useEffect 排队
- 分屏 4 pane = 4 个 ResizeObserver + 4 个 RAF 每帧互不干扰
- foreground: false 时 tick 链仍 16ms setTimeout 空转

## 改动清单

### Change 1: snapshot source 改为 ref 驱动（P0）
文件：`TerminalPage.tsx` L2242
- 当前：`useEffect(() => registerClientDebugSnapshotSource('terminal-page', producer), [27 deps])`
- 改后：ref 存储 producer，source 注册/注销时只传 ref；producer 内读 ref.current
- 效果：keyboardInset/shellHeight 变化不再触发 useEffect 重建

### Change 2: 高频 deps 剥离到 ref（P0）
文件：`TerminalPage.tsx`
- 识别 `keyboardInset`, `shellHeight`, `splitVisible`, `landscape` 为高频 deps
- 放到 useRef 中同步，useEffect 不再依赖这些
- useEffect 依赖列表缩减 50%+

### Change 3: RAF 节流 + skipStaleFrame（P0）
文件：`TerminalView.tsx` L1196 + `TerminalPage.tsx` L1258
- ResizeObserver 回调中增加 `requestAnimationFrame` dedup token：
  ```ts
  if (rafTokenRef.current) return;
  rafTokenRef.current = requestAnimationFrame(() => {
    rafTokenRef.current = null;
    runViewportRefreshRef.current();
  });
  ```
- 分屏模式下额外将节流窗口从 0 放大到 32ms（允许 30fps 极限）
- 效果：4 pane × 0→1 pane × 节流

### Change 4: renderGeometryRevision 改为 RAF diff（P1）
文件：`TerminalView.tsx`
- 当前三个 useEffect 依赖 `renderGeometryRevision` → 每帧触发清理重建
- 改：这三个 effect 改为在 RAF 内检查 ref 是否变化，变化了再执行
- `renderGeometryRevision` 不再作为 useEffect dep

### Change 5: 背景空跑 tick 降频（P2）
文件：`session-context-lifecycle.ts`
- 当前在 `foregroundActiveRef` 为 false 时 `scheduleNext()` 无限循环
- 改：foreground=false 时 nextDelay = 1000ms
- 效果：背景 CPU 从 60tick/s → 1tick/s

## 验证门禁
- `TerminalPage.render-scope.test.tsx`：模拟 keyboardInset 变化，useEffect 调用次数减少 ≥60%
- `session-context-lifecycle.test.tsx`：foreground=false 时 setTimeout delay ≥ 900ms
- `TerminalView.test.tsx`：分屏模式下 RAF 调用 ≤ 30fps
- 人工热度测试（100.127.23.27 装 APK 后感知发热/掉帧）

## 风险
- RAF 节流可能让首次分屏渲染稍有延迟（16ms → 32ms）
- `registerClientDebugSnapshotSource` 改为 ref 后 state 可能在 snapshot flush 时稍旧（~1 frame）

## DoD
- [ ] Change 1-5 全部 apply_patch
- [ ] `tsc --noEmit` PASS
- [ ] contracts PASS
- [ ] 定向 useEffect 调用计数测试 PASS
- [ ] APK 交付到升级路径
- [ ] commit/push
