# keyboard/IME 整体重构设计文档（V2，按当前 879 行基线）

- 日期：2026-05-24
- 状态：按当前代码现状（TerminalPage 879 行 / keyboard runtime 573 行）重新对齐
- 目标：完成 keyboard/IME 闭环收口，使 TerminalPage.tsx 成为纯编排壳

## 1. 当前真实状态

### 1.1 现状快照

| 文件 | 行数 | 状态 |
|------|------|------|
| `android/src/pages/TerminalPage.tsx` | 879 | page 持有部分 keyboard/viewport owner |
| `android/src/pages/useTerminalPageKeyboardRuntime.ts` | 573 | hook 已接收大部分 keyboard 逻辑 |
| `tsc` | — | 不绿，2 个阻断错误 |
| targeted tests | 7 files / 62 tests | 全绿 |

### 1.2 当前 tsc 阻断错误

```
src/pages/useTerminalPageKeyboardRuntime.ts(13,1):
  error TS6133: 'resolveTerminalOrientation' is declared but never read.

src/pages/useTerminalPageKeyboardRuntime.ts(547,3):
  error TS2741: Property 'landscape' is missing in return type
```

错误说明：
- hook 的 `UseTerminalPageKeyboardRuntimeResult` 类型里声明了 `landscape: boolean`
- hook 内 import 了 `resolveTerminalOrientation`
- 但 hook 内没有声明 `landscape` 变量，也没有 return 它
- `TerminalPage.tsx` 仍然自己计算 `landscape`（并用于 `layoutProfile`）

### 1.3 当前 page 与 keyboard hook 的 owner 重复

| owner | keyboard hook | page |
|-------|--------------|------|
| viewportWidth state + setter | 持有 | 持有 |
| headerTopInsetPx state + setter | 持有 | 持有 |
| updateViewportMetrics | 持有 | 持有 |
| scheduleViewportMetricsSync | 持有 | 持有 |
| viewportMetricsFrameRef | 持有 | 持有 |
| landscape | 未持有（导入后未用） | 持有 |

**判断：viewport metrics 是当前真正的双 owner 残留**，不在 keyboard/IME 闭环语义内，但当前被两处持有。

### 1.4 当前 page 剩余 keyboard/viewport owner

`TerminalPage.tsx` 第 196-211 行：
```typescript
const [viewportWidth, setViewportWidth] = useState(() => resolveWindowWidth());
const [headerTopInsetPx, setHeaderTopInsetPx] = useState(() =>
  resolveTerminalHeaderTopInsetPx(isAndroid),
);
// ...
const updateViewportMetrics = useCallback(() => { ... }, [isAndroid]);
const viewportMetricsFrameRef = useRef<number | null>(null);
const scheduleViewportMetricsSync = useCallback(() => { ... }, [...]);
```

第 518-527 行：
```typescript
const landscape = typeof window !== "undefined"
  ? resolveTerminalOrientation() === "landscape"
  : false;
const layoutProfile = useMemo(() =>
  resolveTerminalLayoutProfile({ splitVisible, topInsetPx: headerTopInsetPx, landscape }),
  [headerTopInsetPx, landscape, splitVisible],
);
```

## 2. 关键问题：landscape 的正确 owner 是谁？

### 2.1 被谁消费？

从代码看，`landscape` 的消费者是：
- `TerminalPage.tsx` 第 526 行：`resolveTerminalLayoutProfile({ ..., landscape })`
- `layoutProfile` 被 JSX 消费（决定 quickbar / chrome 布局参数）

### 2.2 keyboard runtime 需要 landscape 吗？

keyboard runtime 的职责是 IME 控制和 focus routing。`landscape` 决定的是布局方向，不决定 IME 行为。

所以 `landscape` **不属于 keyboard runtime 的语义域**。

### 2.3 正确判断

`landscape` 的唯一正确 owner 是 `TerminalPage.tsx`（page-shell 层）。

`keyboard runtime` 不应持有 `landscape`。

那上一轮尝试把 `landscape` 迁入 keyboard runtime 是方向性错误。

## 3. 正确修复方案

### 方案 A（推荐）：回退 landscape 迁移，page 保留 landscape

1. 删除 keyboard runtime 中的 `landscape` type 声明
2. 删除 keyboard runtime 中的 `resolveTerminalOrientation` 导入
3. page 继续自己算 `landscape`，用于 layoutProfile

**优点**：简单，不引入新 owner，不破坏已有稳定逻辑
**代价**：keyboard runtime 里有一个半完成状态需要清理

### 方案 B：page 改从 keyboard runtime 读取 landscape

1. 把 `landscape` 迁入 keyboard runtime（补全声明 + 返回）
2. 删除 page 中 `landscape` 计算
3. page 通过 hook 返回值读取 `landscape`

**优点**：landscape 集中管理
**缺点**：把布局方向真相注入 keyboard runtime，扩大 keyboard runtime 职责

### 方案 A vs B 的核心判断

keyboard runtime 的语义边界是 **IME/focus routing**。
`landscape` 的语义域是 **布局方向**。

方案 B 会让 keyboard runtime 承担非 IME 语义的事实，这不纯粹。
**方案 A 是唯一正确的选择**。

## 4. viewport metrics 的正确 owner

### 4.1 双重 owner 的真实情况

当前 page 和 keyboard runtime 各持有一份：

```typescript
// keyboard runtime 内部（useTerminalPageKeyboardRuntime.ts）：
const [viewportWidth, setViewportWidth] = useState(() => resolveWindowWidth());
const [headerTopInsetPx, setHeaderTopInsetPx] = useState(() =>
  resolveTerminalHeaderTopInsetPx(isAndroid),
);
const updateViewportMetrics = useCallback(() => { ... }, [isAndroid]);
const viewportMetricsFrameRef = useRef<number | null>(null);
const scheduleViewportMetricsSync = useCallback(() => { ... }, [updateViewportMetrics]);

// page 内部（TerminalPage.tsx）：
const [viewportWidth, setViewportWidth] = useState(() => resolveWindowWidth());
const [headerTopInsetPx, setHeaderTopInsetPx] = useState(() =>
  resolveTerminalHeaderTopInsetPx(isAndroid),
);
const updateViewportMetrics = useCallback(() => { ... }, [isAndroid]);
const viewportMetricsFrameRef = useRef<number | null>(null);
const scheduleViewportMetricsSync = useCallback(() => { ... }, [...]);
```

两者完全重复！

### 4.2 真实依赖链分析

viewport metrics 的消费者：

| 消费者 | 需要的值 | 当前来源 |
|--------|---------|---------|
| `TerminalStageShell` | `headerTopInsetPx` | page → StageShell prop |
| `TerminalPageCopyMenu` | `viewportWidth` + `headerTopInsetPx` | page → CopyMenu prop |
| `layoutProfile` | `headerTopInsetPx` + `landscape` | page 内 useMemo |
| `scheduleViewportMetricsSync` | 需要节流触发方 | keyboard hook + page 都有 |

viewport metrics 的来源方：

| 来源 | 触发条件 |
|------|---------|
| `visualViewport.resize` 监听 | viewport 变化 |
| `window.resize` 监听 | viewport 变化 |
| `keyboardDidShow` / `keyboardDidHide` | IME 出现/消失 |
| `ImeAnchor.keyboardState` | IME 状态变化 |

### 4.3 唯一正确 owner 判断

viewport metrics 的语义域是 **shell geometry / 页面几何测量**。
IME 的语义域是 **输入法控制和 focus routing**。

viewport metrics 和 keyboard 有交叉（keyboard show/hide 会触发 viewport resize），
但这不等于 viewport metrics 就属于 keyboard。

两种可能 owner：

**选项 1：viewport metrics 归 keyboard runtime**
- keyboard runtime 持有 viewportWidth / headerTopInsetPx
- page 通过 hook 返回值读取
- 优点：viewport 变化节流逻辑和 keyboard freeze 逻辑同 owner
- 缺点：keyboard runtime 职责扩大为"几何测量 + IME 控制"

**选项 2：viewport metrics 归独立 shell metrics hook**
- 新建 `useTerminalPageViewportMetrics.ts`
- keyboard runtime 只消费 viewportWidth / headerTopInsetPx
- 优点：职责边界更清晰
- 缺点：需要引入新文件

**推荐：选项 1（viewport metrics 归 keyboard runtime）**

理由：
- viewport resize 和 keyboard freeze 共享 `stableLayoutViewportHeightRef`
- 把它们分开会让 `stableLayoutViewportHeightRef` 成为跨 hook 共享状态，反而更乱
- keyboard runtime 已经持有 viewport metrics，只是还没和 page 断开

## 5. 完整修复方案：先闭合两个 tsc 阻断，再统一 owner

### Step 1：回退 landscape 迁移（tsc 阻断 1）

文件：`android/src/pages/useTerminalPageKeyboardRuntime.ts`

修改：
1. 删除 `resolveTerminalOrientation` 导入
2. 从 `UseTerminalPageKeyboardRuntimeResult` 接口中删除 `landscape: boolean`
3. 确保 page 继续自己算 `landscape`

### Step 2：统一 viewport metrics owner（消除 page 内重复）

修改 `TerminalPage.tsx`：

1. 删除 page 内重复的 viewport metrics state/ref/callback：
   - 删除 `const [viewportWidth, setViewportWidth] = useState(...)`
   - 删除 `const [headerTopInsetPx, setHeaderTopInsetPx] = useState(...)`
   - 删除 `const updateViewportMetrics = useCallback(...)`
   - 删除 `const viewportMetricsFrameRef = useRef(...)`
   - 删除 `const scheduleViewportMetricsSync = useCallback(...)`

2. 从 keyboard hook 的返回值读取：
   ```typescript
   const {
     viewportWidth,
     headerTopInsetPx,
     scheduleViewportMetricsSync,
     viewportMetricsFrameRef,
   } = useTerminalPageKeyboardRuntime({ ... });
   ```

3. keyboard hook 的 `updateViewportMetrics` 已经在 hook 内，但 viewport resize listener 还在 page 内

### Step 3：把 viewport resize listener effect 移入 keyboard runtime（消除 page 残留）

当前 viewport resize listener effect 在 page 内（第 362-385 行）：
```typescript
useEffect(() => {
  // ...
  window.addEventListener("resize", scheduleViewportMetricsSync);
  visualViewport?.addEventListener("resize", scheduleViewportMetricsSync);
  // ...
  return () => {
    window.removeEventListener("resize", scheduleViewportMetricsSync);
    visualViewport?.removeEventListener("resize", scheduleViewportMetricsSync);
  };
}, [isAndroid, scheduleViewportMetricsSync]);
```

这个 effect 应该移入 keyboard runtime。

keyboard runtime 需要新增一个 viewport resize effect，持有 visualViewport resize / scroll 监听。

## 6. 修复后的目标状态

### 6.1 keyboard runtime 的正确 owner

`useTerminalPageKeyboardRuntime.ts` 持有：

| 类别 | owner |
|------|-------|
| State | `terminalKeyboardRequested`、`keyboardInset`、`focusNonce`、`viewportWidth`、`headerTopInsetPx` |
| Ref | `viewportMetricsFrameRef`、`stableLayoutViewportHeightRef`、`activeSessionIdRef`、`quickBarEditorFocusedRef`、`terminalInputHandlerRef`、`pendingAndroidImeFocusTimerRef`、`androidImeFocusRouteKeyRef`、`terminalFocusRetryTimeoutsRef` |
| Callbacks | 全部 keyboard/IME/focus/viewport 相关 |
| Effects | Keyboard listener、ImeAnchor listener、viewport resize listener、viewport freeze effect、quickbar blur effect |
| 返回值 | 所有 state + derived + handlers |

### 6.2 page 的正确 owner

`TerminalPage.tsx` 只持有：

| 类别 | owner |
|------|-------|
| Props 透传 | `sessions`、`activeSession`、`quickActions` 等 TerminalPageProps |
| layoutProfile | `landscape` + `layoutProfile` useMemo |
| 壳层派生 | `terminalChromeBottomPx` |
| hooks 编排 | 调用所有 runtime hooks，组合返回值 |
| JSX 组合 | StageShell / Header / QuickBar / Overlay 等 |

### 6.3 目标行数

| 文件 | 当前行数 | 目标行数 |
|------|----------|----------|
| `TerminalPage.tsx` | 879 | ≈750（去除 viewport metrics 重复后） |
| `useTerminalPageKeyboardRuntime.ts` | 573 | ≈620（新增 viewport resize effect） |

## 7. 唯一性说明：为什么这个方案是唯一正确的

### 7.1 landscape 回退是唯一正确选择

`landscape` 属于布局方向真相，不属于 IME/focus routing 语义。
keyboard runtime 若持有 `landscape`，会承担超出其语义域的职责。
`landscape` 的唯一正确 owner 是 page-shell（用于 layoutProfile 派生）。
导入 `resolveTerminalOrientation` 但不使用它，是典型的半完成状态，必须清理。

### 7.2 viewport metrics 归 keyboard runtime 是唯一正确选择

viewport metrics 和 `stableLayoutViewportHeightRef` 在 viewport freeze 语义下不可分割。
把 viewport metrics 独立为新 hook 会制造跨 hook 共享 ref。
把 viewport metrics 留在 page 会导致 page 和 keyboard runtime 双 owner（当前就是这个问题）。
只有 viewport metrics 归 keyboard runtime，才能消除所有双 owner。

### 7.3 viewport resize listener 移入 keyboard runtime 是唯一正确选择

viewport resize listener 只有一个 producer（`window.visualViewport`）。
`scheduleViewportMetricsSync` 只有一个 consumer（更新 viewportWidth/headerTopInsetPx）。
若 effect 留在 page 而 callback 在 hook 内，effect 和 callback 分属两个 owner。
把 effect 和 callback 放在同一个 owner（keyboard runtime）才能保持真源唯一。

## 8. 迁移步骤

### Phase 0：修复 tsc 阻断（立即可做）

1. 清理 keyboard runtime 中的 `landscape` 半完成状态
   - 删除 `resolveTerminalOrientation` 导入
   - 从返回类型接口删除 `landscape: boolean`
   - 验证 `tsc` 通过

2. 验证 targeted tests 仍然全绿

### Phase 1：统一 viewport metrics owner

1. 把 page 内 viewport metrics 相关 state/ref/callback 替换为从 keyboard hook 读取
2. 删除 page 内重复实现
3. 把 viewport resize listener effect 移入 keyboard runtime
4. 验证 `tsc` 全绿
5. 验证 targeted tests 全绿
6. 删除 page 中所有 keyboard hook 未消费的 import（如旧的 viewport 相关）

### Phase 2：清理 page 残留

1. 删除 page 中所有已被 keyboard runtime 完全接管的状态
2. 确认 page 只剩 props 编排 + hooks 装配 + JSX 组合
3. 更新相关审计文档

## 9. 验证矩阵

### 9.1 tsc 门禁

```bash
pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false
```

必须全绿。

### 9.2 targeted tests

```bash
pnpm --dir android exec vitest run \
  src/pages/useTerminalPageCopyRuntime.test.tsx \
  src/pages/useTerminalPageOverlays.test.tsx \
  src/pages/terminal-page-render-keys.test.ts \
  src/pages/terminal-keyboard-lift.test.ts \
  src/pages/terminal-copy-selection.test.ts \
  src/pages/TerminalPage.android-ime.test.tsx \
  src/pages/TerminalPage.render-scope.test.tsx \
  --reporter dot
```

必须 7 files / 62 tests 全绿。

### 9.3 验收检查项

- [ ] keyboard runtime 的 `landscape` 相关半完成状态已清理
- [ ] `tsc` 全绿
- [ ] targeted tests 全绿
- [ ] page 不再同时与 keyboard runtime 持有重复的 viewportWidth / headerTopInsetPx / scheduleViewportMetricsSync
- [ ] viewport resize listener effect 已在 keyboard runtime 内部管理
- [ ] `TerminalPage.tsx` 只剩 props 编排、hooks 装配、JSX 组合
- [ ] 能清晰说明 keyboard runtime、page-shell 的 owner 划分
- [ ] 总结里给出"为什么这个划分是唯一正确的"论证

## 10. 风险

| 风险 | 规避 |
|------|------|
| viewport resize listener effect 移入 keyboard runtime 后行为变化 | keyboard runtime 内已有完整 listener 逻辑，只补上 page 侧缺失的 visualViewport scroll（非 Android）监听 |
| 把 viewport metrics 从 page 迁出后 page JSX 消费路径断裂 | 改为从 hook 返回值读取，传给 JSX prop，不改变数据流 |
| keyboard runtime 因增加 viewport resize effect 变得更大 | 接受；keyboard runtime 的职责就是持有 IME + viewport geometry 全部真相 |
| tsc 通过但 runtime 行为异常 | 必须在真实设备上做 Android IME smoke 测试（show/hide/keyboard toggle） |
