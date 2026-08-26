# terminal 渲染层解耦审计：buffer manager / renderer / UI shell 三层责任拆分

日期：2026-08-13
状态：方向性审计，不含代码改动

## 1. 为什么必须拆层

用户真机反馈（2607/2608 反复出现，2608 更严重）：
- 缩放后显示的 buffer 行号/内容错误；
- 缩放态下只能回滚一屏；
- IME 弹出再收起后，屏幕下半区出现未补数据的黑区，触摸一次才恢复。

这些症状在现有代码里反复横跳、修复无法收敛，根因不是某个公式错了，而是
`TerminalView.tsx` 一个组件同时承担了 `UI shell（手势/缩放/IME 坐标）` 与
`renderer（follow/reading/renderBottomIndex/行号映射）` 两层职责，
两层的状态互相覆盖、互相补偿，任何单点修复都会在另一条路径上复现。

## 2. 真源层级（docs/architecture.md + terminal-buffer-truth skill）

```
tmux truth
  -> daemon server
  -> client buffer manager      （local sparse buffer / gap ranges / repair plan）
  -> renderer                   （唯一状态：follow / reading + renderBottomIndex；renderTopIndex = renderBottomIndex - viewportRows）
  -> UI shell                   （手势、IME、容器坐标、视觉缩放；不持有 buffer 行号）
```

冻结规则：
- renderer 不持有手势/IME/容器位置状态；
- UI shell 不持有 buffer 行号/滚动映射；
- `viewportRows` 只能由容器几何派生，单一写入来源；
- `scrollTop` 是 renderer 滚动唯一真源；
- 视觉缩放（scale）不得改变 buffer 几何 / 行号映射 / scrollTop 坐标系。

## 3. 现状 vs 目标（TerminalView.tsx）

| 职责 | 真源 owner | 现状 | 问题 |
|---|---|---|---|
| 手势状态机（two-finger wheel / horizontal pan / pinch） | UI shell | TerminalView 内部 ref | 与 renderer 同组件，互相读 ref |
| 视觉缩放 | UI shell | `gridEl.style.zoom`（布局级）+ `mirrorFixedVerticalOffsetPx` translateY | CSS zoom 改变布局几何；translateY 接管纵向滚动 |
| 滚动↔行号映射 | renderer | `layoutRowHeightPx = rowHeight × zoom` | renderer 混入缩放后行高，滚动坐标分叉 |
| 单屏行数 | renderer | `viewportRows` 被缩放代码 `setViewportRows` 直接改 | 两个来源抢一个 state（measure vs zoom） |
| follow guard / reading | renderer | 与手势代码同组件 | guard 用错坐标系后把 scrollTop 拉回 anchor（只能回滚一屏） |

## 4. 目标拆分

### 4.1 视觉手势层：`useMirrorFixedZoomPan`（新 hook，只属于手势/缩放）

> v2 归属修订：这里说的“UI shell”是 `TerminalView` 之上的视觉手势层，v2
> Phase 4 将它收进 `client.dom_renderer`；它不是 `client.app_shell` 页面 shell。

- 输入：容器 ref、宽度模式、copyMode、reserveRightEdgeSwipe。
- 输出：手势处理器（onTouchStart/Move/End）与一个只读视觉参数 `visualScale`。
- **职责**：
  - pinch 计算目标 scale，clamp 到 `[minScale, 1]`；
  - 只修改一个**独立视觉层容器**的 `transform: scale(s)`；
  - 单指纵向手势不做任何事（不 preventDefault、不改变 scrollTop、不 translateY）——交给原生滚动；
  - 单指横向只做既有 horizontal pan（视觉层 translateX）。
- **禁止**：
  - 不读/不写 `viewportRows`、`renderBottomIndex`、`scrollTop`、`scrollHeight`；
  - 不调用 `setViewportRows`、不改变 `rowHeightPx` 映射；
  - 不使用 CSS `zoom`（布局级），不写 `gridEl.style.zoom`。

### 4.2 renderer：`TerminalView`（只保留渲染投影）

- 唯一状态：`follow / reading + renderBottomIndex`（`readingMode`、`renderBottomIndex`）；
- `viewportRows` 只由 `commitMeasuredViewportState`（容器几何 measure）写入，单一来源；
- `scrollTop ↔ 行号映射` 只用原始 `rowHeightPx`，**永不乘 zoom**；
- `renderTopIndex = renderBottomIndex - viewportRows` 派生，不设第二真源；
- follow guard / reading 判定只用原生坐标；
- 视觉缩放容器是 renderer 之上的**独立 DOM 层**（`term-render-scale-layer`），renderer 不知道它的存在。

### 4.3 buffer manager（现有 session-render-buffer-store，不改）

- 只吃 renderer 声明的 visible range，做 gap repair；不持有 follow/reading。

## 5. 验收指标（真机）

1. pinch 缩小后：buffer 行号连续（`renderTopIndex = renderBottomIndex - viewportRows`），内容正确；
2. 缩放态单指纵向滚动：可回滚超过一屏，滚动范围与未缩放一致（scrollTop 坐标系不变）；
3. IME 弹出再收起：下半区不出现未补数据黑区，无需触摸即可恢复；
4. pinch 回 1：完全复原，scrollTop 与行号不变。

## 6. 实施顺序

1. 先抽 `useMirrorFixedZoomPan`（UI shell 手势+缩放，只改视觉层）；
2. 再删 TerminalView 中 CSS zoom / layoutRowHeightPx / translateY / pinchScrollTopRef 逻辑；
3. 补红测锁行号连续与 scrollTop 映射不变；
4. 定向测试 + tsc + 架构门禁；
5. 构建 APK 发布并装机验证（L5）。

## 7. 遗留

- 2608（38754c8）已回退为 b2f0f86（2607.1 行为）作为稳定基线；
- 本审计不承诺"缩放下多行显示"功能，只承诺"缩放不破坏 buffer 行号连续性"；
- 若后续要"缩小显示更多行"，必须单独设计 renderer 的 viewportRows 与视觉 scale 之间的显式投影，不允许 UI shell 直接 setState。

---

# 8. 第二阶段 closeout（2026-08-13 架构审计后实施）

> 触发：架构四项检查（巨型文件 / 层次耦合 / UI-数据分离 / 控制-数据面）发现 b447689 只完成第一步：
> `TerminalView.tsx` 仍持有两指滚轮状态机、横向 pan 状态机、pinch shim（mirrorFixedScaleRef/applyPinchScale/pinchRef）、
> 横向 offset 真源与 localStorage 直写。本阶段把这些全部收拢到 UI shell 层。

## 8.1 目标分工（owner 表）

| 职责 | 唯一 owner | 位置 | 允许 | 禁止 |
|---|---|---|---|---|
| 两指滚轮手势状态机（wheel vs pinch 仲裁） | DOM renderer 视觉手势层 | `src/components/useMirrorFixedZoomPan.ts`（client.dom_renderer） | 用 `decideTwoFingerWheel` 纯函数、持有手势 ref 状态 | 读/写 renderer 行号、scrollTop、viewportRows |
| 两指滚轮→SGR 坐标映射 | renderer 投影适配 | `TerminalView` 内 `onWheelStep` adapter | 用 renderer cell metrics（cellWidthPx/rowHeightPx/rect）把 client 坐标映射为 col/row，调 `encodeTerminalSgrMouseWheel` 后经既有 `onInput` 边界发送 | 持有手势状态机、累积 delta、做 wheel/pinch 判定 |
| mirror-fixed 横向 pan 状态机 | DOM renderer 视觉手势层 | `useMirrorFixedZoomPan` | 手势识别 + `event.preventDefault/stopPropagation` 语义（drawer 边缘热区） | 修改 buffer/行号/scrollTop |
| 横向 offset 真源 | DOM renderer 视觉手势层 | `useMirrorFixedZoomPan`（state）+ `src/lib/terminal-mirror-fixed-pan-storage.ts`（持久化，client.dom_renderer） | 唯一持有 offset 值；clamp 由 renderer 传入的 `maxHorizontalOffsetPx`；变更写 storage | renderer/其他组件直写 localStorage |
| pinch 视觉缩放 | DOM renderer 视觉手势层 | `useMirrorFixedZoomPan`（scaleLayerRef transform） | 只写 `.term-render-scale-layer` transform | CSS zoom、改布局几何、写 viewportRows |
| 缩放/平移后的视觉应用 | DOM renderer 视觉层 | `.term-render-scale-layer` + `.term-grid` translateX（值来自 hook 返回） | 纯视觉 transform | 改变 buffer 几何/scrollTop 坐标系 |

## 8.2 数据流（拆分后）

```text
touch events (wterm container)
  -> useMirrorFixedZoomPan (UI shell)
       |- pinch -> scale-layer transform: scale(s)          [视觉]
       |- pan   -> horizontalOffsetPx (state + storage)    [真源在 shell]
       |            `- TerminalView grid translateX(offset) [视觉应用]
       `- wheel step -> onWheelStep({direction,steps,clientX,clientY})
            -> TerminalView adapter（cell metrics 投影）
                 -> encodeTerminalSgrMouseWheel -> onInput -> input owner
```

## 8.3 硬规则（gate 语义）

- `TerminalView.tsx` 禁止出现：`localStorage`、`twoFingerWheelRef`、`handleTwoFingerWheelTouch*`、`handleMirrorFixedTouch*`、
  `applyPinchScale`、`computeNextPinchScale`、`pinchRef`、`mirrorFixedScaleRef`、`mirrorFixedHorizontalOffsetRef`、
  `commitMirrorFixedHorizontalOffset`、`readStoredHorizontalOffset`、`writeStoredHorizontalOffset`。
- `useMirrorFixedZoomPan.ts` 禁止出现：`renderBottomIndex`、`scrollTop`、`viewportRows`、`setViewportRows`、`rowHeightPx`、`buffer`。
- 静态扫描 gate：`src/components/TerminalView.layer-truth.test.ts`（并入 `test:feature-registry` 同批运行）。
- 行为红测：`useMirrorFixedZoomPan.test.tsx`（wheel 步进回调、pan offset 真源、clamp、storage restore）、
  `terminal-mirror-fixed-pan-storage.test.ts`（读写/坏 JSON/clamp）、`TerminalView.test.tsx`（两指滚轮→onInput SGR 序列行为锁定）。
- 既有行为锁：TerminalView pinch 测试（.term-render-scale-layer transform）、TerminalPage.session-content-identity pinch 测试必须保持全绿。

## 8.4 边界兼容

- `TerminalView` 对外导出面不变：`TerminalView`（memo 组件）+ `terminalRowRenderSignature`。
- `useMirrorFixedZoomPan` 选项调整：新增 `minScale / maxHorizontalOffsetPx / drawerEdgeSwipeStartPx / rightEdgeReservePx / onWheelStep`，
  移除 `readHorizontalOffset / onHorizontalOffsetChange / applyVisualScale`（offset 真源内聚到 hook），`visualScale / horizontalOffsetPx` 只读返回。
- 模块归属：`src/components/useMirrorFixedZoomPan.ts` 与 `src/lib/terminal-mirror-fixed-pan-storage.ts` 注册到 `client.dom_renderer`（module-registry owned_paths）。
  hook 新增依赖 `two-finger-wheel-decision / two-finger-wheel-debug-store`（client.renderer_window）走既有声明边 `client.dom_renderer -> client.renderer_window`。

## 8.5 必跑 gate

1. `pnpm --dir android run test:feature-registry`（含新 layer-truth 静态扫描）
2. `vitest run src/components/TerminalView.test.tsx src/components/useMirrorFixedZoomPan.test.tsx src/lib/terminal-mirror-fixed-pan-storage.test.ts`
3. `vitest run src/pages/TerminalPage.session-content-identity.test.tsx src/pages/TerminalPage.render-scope.test.tsx`
4. `pnpm --dir android run type-check`

## 9. Pinch canvas projection closeout（2026-08-26，取代 §4/§8 的 transform-only 方案）

Android WebView 的 L5 复测证明：mirror-fixed 缩小若用 `transform: scale()` 只缩位图，
原生滚动坐标系、布局高度与可见 buffer 行数分叉，仍会画出越界黑区。现行冻结方案改为：

- `useMirrorFixedZoomPan` 是独立 canvas 视觉层的唯一 owner：pinch 只写
  `.term-render-scale-layer` 的 CSS `zoom`，并在进入/退出缩放态时做原生
  `scrollTop` handoff；它不持有 buffer 行号、`viewportRows` 或 follow 真相。
- `TerminalView` 是缩放后 renderer 投影的唯一 owner：在 paint 前按
  `clientHeight / (rowHeightPx * visualScale)` 派生 `viewportRows`，用同一
  visual row height 计算 render frame 和 padding。该投影不改 tmux/daemon geometry。
- 缩放态纵向位置使用非正 `translateY`；renderer 的正 `scrollTop` 映射为负
  translation，单指平移不得越过顶部或底部边界。恢复 scale=1 时由 hook 还原
  原生 `scrollTop`。

因此 §4.1/§8 中“hook 禁止触碰 scrollTop / 禁止 CSS zoom”的规则被本节取代；
“hook 不持有 viewportRows / renderBottomIndex / rowHeightPx / buffer truth”仍然生效。
