# Remote-Window 同 App 多窗口组合推流（background pane）设计方案

- 日期：2026-08-08
- 状态：**APPROVED — 2026-08-08 三项决策点：同 app 全部窗口自动组合 / 平铺排布（无遮挡）/ 串流中自动增删**
- 功能块：daemon `remote-window-capture` + `remote-window-stream-daemon`；client `remote_window_overlay`；wire 协议 `@zterm/shared`
- 不涉及 terminal buffer / renderer / daemon mirror 真源

## 1. 需求（用户）

微信里点击图片会弹出新窗口（图片预览）遮挡原窗口。当前串流目标是**单个窗口**（SCContentFilter 按 `windowId` 捕获），新窗口不在画面里——**手机无法感知**。期望：**同一 app 的窗口组合成一个 background pane 排布推流，新窗口也在画面里**，且输入事件能落到对应窗口。

## 2. 现状（代码定位）

- capture：`remote-window-capture.ts` → `SCREEN_CAPTURE_KIT_FRAME_SOURCE_SWIFT`（`remote-window-scripts.ts:756`）——**单窗口** `SCContentFilter` + `SCStream`，`sourceRect` = cropRect - windowBounds，输出原始 BGRA 帧。
- 输入：client 发 `pointer/click/scroll`（normalized 画布坐标）→ daemon `remote-window-stream-daemon.ts` 校验 → swift `postMouseMove/postClickEvent/postScrollEvent`（CGEvent，全局坐标，`remote-window-scripts.ts:470+`）。
- 同 app 窗口：catalog 已枚举（`windowId`/`windowBoundsTopLeftPx`/`cropRectTopLeftPx`）；client 有 active-app-switch（手动切目标，单窗口流）。
- 协议：`RemoteWindowStreamTargetManifest`（packages/shared）描述单个窗口。

## 3. 设计

### 3.1 组合目标（composite target）

`RemoteWindowStreamTargetManifest` 增加可选字段：

```ts
compositeWindows?: Array<{
  windowId: string;
  title: string;
  windowBoundsTopLeftPx: { x: number; y: number; width: number; height: number };
  cropRectTopLeftPx: { x: number; y: number; width: number; height: number };
}>;
```

- 语义：串流目标 = 主窗口 + compositeWindows（同 app 其他窗口，如微信图片预览）。
- client 在 picker 选择 app 窗口时，若 catalog 显示同 app 有多个窗口，默认带上全部（或提供"组合/单窗口"开关）。

### 3.2 daemon capture：多窗口合成画布

- 主窗口 + 每个 composite 窗口各建一个 capture 源（复用现有 `startScreenCaptureKitFrameSource`，可并行 spawn 多个 swift 子进程，或扩展单个 swift 支持多 windowId）。
- **合成画布**：取所有窗口 `windowBoundsTopLeftPx` 的 **bounding box**（左上 min、右下 max）→ 画布尺寸 = bounding box；每个窗口在画布内的 offset = `windowBounds.x - box.x`、`windowBounds.y - box.y`（**保留真实屏幕坐标与遮挡关系**：后弹出的窗口排布位置由 z-order/窗口坐标决定，简单起见按窗口列表顺序后画覆盖先画）。
- 合成实现（swift）：每帧把各窗口帧（BGRA）按 offset 绘制到共享 `CGContext` 画布，输出合成帧（尺寸=画布）。帧同步用**最新可用帧**（每个窗口源独立到帧，合成时取最新）。
- 帧率/码率：以画布尺寸计算（可能大于单窗口，自动降码率档位）。

### 3.3 输入映射（画布坐标 → 窗口）

- client 仍发 normalized（画布坐标）→ daemon 收到后：
  1. normalized × 画布尺寸 → 画布像素坐标
  2. **窗口命中**：在哪个窗口的 `cropRect`（画布坐标内）→ 命中窗口
  3. 映射为**窗口局部坐标**（画布坐标 - 窗口 offset）
  4. 注入 CGEvent 时用**窗口在屏幕上的真实坐标**（windowBounds + 局部坐标）
- 未命中任何窗口：命中主窗口（画布内主窗口区域外忽略或按主窗口 clamp）。

### 3.4 client 变化

- **组合选择**：picker 选 app 窗口时，同 app 多窗口默认组合（后台 pane 排布）；UI 提示组合数量。
- **新窗口自动加入**：串流中 catalog 刷新发现同 app 窗口数增加（如点图片弹出预览）→ 通过 `stream-quality` 或新 `composite-windows-update` 消息把新窗口加入组合（capture 动态增删）。
- 显示：现有 receiver 不变（画布即画面，可能更宽/更高，fill/fit 逻辑已有）。
- 输入：normalized 透传（daemon 映射），client 无需知道窗口分布。

### 3.5 协议

- `RemoteWindowStreamTargetManifest.compositeWindows?`（stream-start 携带）。
- capture 信息：`RemoteWindowStreamResultPayload`/stream-started 的 `capture` 扩展画布尺寸 + 各窗口 rect（client 侧 frameSize 用画布）。
- 新增消息（可选）：`remote-window-composite-update`（运行中增删组合窗口）。

## 4. 实现范围

| 文件 | 改动 | owner |
|---|---|---|
| `packages/shared/src/connection/protocol.ts` | TargetManifest 加 compositeWindows；capture payload 扩展 | wire |
| `android/src/server/remote-window-scripts.ts` | swift 支持多窗口 capture + 画布合成 + 帧输出 | daemon capture |
| `android/src/server/remote-window-capture.ts` | 多 capture 源管理 + 合成帧装配 | daemon capture |
| `android/src/server/remote-window-stream-daemon.ts` | 组合目标校验 + 输入坐标映射（画布→窗口） | daemon 输入 |
| `android/src/components/terminal/RemoteWindowOverlay.tsx` | 组合目标选择 + 新窗口自动加入 + UI 提示 | client |
| 测试 | capture 合成坐标、输入命中映射、client 组合选择 | 同上 |

## 5. 验收标准

1. 微信点图片 → 手机画面出现图片预览窗口（组合画布，含主窗口 + 预览窗口）
2. 点击预览窗口 → Mac 上事件落在预览窗口（微信响应）
3. 新窗口弹出后自动加入组合（无需手动切）
4. 关闭预览窗口 → 自动从组合移除
5. type-check 0、daemon/capture/client 测试全绿、build:android + daemon 重建 + OTA

## 6. 待批准决策点

1. **组合窗口范围**：同 app 全部窗口自动组合（推荐），还是仅"主窗口 + 后弹出窗口"？
2. **遮挡关系**：按真实窗口坐标层叠（后弹的盖在上面，推荐），还是平铺排布（side-by-side）？
3. **动态增删**：串流中 catalog 变化自动增删组合窗口（推荐），还是固定启动时的窗口集合？
