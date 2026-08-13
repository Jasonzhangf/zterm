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

### 4.1 UI shell：`useMirrorFixedZoomPan`（新 hook，只属于手势/缩放）

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
