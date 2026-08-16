# Remote-Window 触控输入重构设计方案（待批准）

- 日期：2026-08-08
- 状态：**APPROVED — 2026-08-08 四项决策点全部采纳推荐项（触控模式默认 / 单指未放大=滚动 / 双击缩放 / 长按右键）**
- 功能块：`client.remote_window_overlay`（owner：`RemoteWindowOverlay.tsx` + `remote-window-touch-action-runtime.ts`）；daemon 注入 `remote-window-scripts.ts`；wire 协议 `@zterm/shared` `RemoteWindowInputEventPayload`
- 不涉及 terminal buffer / renderer / daemon mirror 真源

## 1. 用户报告的问题（真机复现）

1. **放大情况下双指上滚/下滚完全没有功能**
2. **单指上下移动不仅不能正常移动页面，还会被识别为 pinch 导致画面缩小**
3. **识别过程中出现"虚拟鼠标"**（远程鼠标光标跟随移动），用户认为这是错误的
4. 用户核心诉求：**鼠标模式与触控屏模式完整分开**；触控屏模式下**注入远程 action（触摸/滚动消息），不是模拟远程鼠标**；手势完整、流畅、取消识别误差

## 2. 现状根因（代码级定位）

### 2.1 现状手势模型（`remote-window-touch-action-runtime.ts` + `RemoteWindowOverlay.tsx`）

- **无模式切换**：单指 tap → `click` 事件；单指拖动 → `pointer down/move/up`（鼠标拖拽语义）；双指 → `twoFingerCandidate` → `twoFingerScroll`（注入 `scroll`）或 `pinch`（本地缩放画布）。
- **放大态（fullscreen scale > 1）**：`resolveRemoteWindowTouchPointerDownRuntime` 对 touch 单指直接进 `localPan`（本地平移画布，不注入远端）。
- **双指仲裁**（`resolveRemoteWindowTouchPairPointerMoveRuntime`）判定顺序：
  1. **pinch 优先**：`|scaleRatio-1| >= 0.4 && isPinchIntentPair`（两指在连线上反向投影）→ pinch
  2. scroll：`midpointShift >= 12px && hasCoherentTwoFingerScrollIntent` → twoFingerScroll
  3. 都不满足 → 保持 candidate
- **注入**：daemon `postScrollEvent` / `postClickEvent` / `postMouseMove`（`remote-window-scripts.ts`）——**scroll/click 注入前都先 `postMouseMove`（移动远程鼠标光标 = 用户看到的"虚拟鼠标"）**。

### 2.2 三个问题的直接根因

| 问题 | 根因 |
|---|---|
| 放大时双指滚动失效 | 放大态单指已占 `localPan`；第二指 down 进入 pair candidate 后，两指同时移动时 **pinch 判定优先**（scaleRatio 变化），或 localPan 与 pair 状态机互相覆盖 → 双指滚动几乎不可能命中 `hasCoherentTwoFingerScrollIntent` |
| 单指移动被识别为 pinch 缩小 | 单指 `localPan` 拖动中**第二指误触/轻触** → 进入 `twoFingerCandidate`；第一指继续移动 → 两指距离变化 `\|scaleRatio-1\| >= 0.4` → **提交为 pinch**（视觉 = 画面缩小）。判定不要求"两指同时按下"，也不要求第二指有自己的位移 |
| 虚拟鼠标 | 所有 scroll/click 注入都先 `postMouseMove`，远程鼠标光标被驱动移动；触控模式下没有独立的"纯 action"注入通道 |

## 3. 行业调研结论（RustDesk 源码 / 微软官方文档）

调研来源：
- RustDesk 移动端：`flutter/lib/common/widgets/remote_input.dart`、`input_model.dart`、`consts.dart`（`kOptionTouchMode="touch-mode"`）
- 微软远程桌面 iOS 官方文档：https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/clients/remote-desktop-ios

| 维度 | 行业常规做法 | 我们的现状 | Gap |
|---|---|---|---|
| 输入模式 | **显式双模式**：Mouse 模式 / Touch（Direct touch）模式，工具栏切换，per-连接持久化 | 无模式，自动混合 | **缺模式分离** |
| 触控模式注入 | 点按=click；拖动=触控/滚动 action；**不移动鼠标光标** | 拖动=pointer 鼠标拖拽；scroll/click 都 postMouseMove | **注入语义错 + 虚拟鼠标** |
| 双指滚动 | 双指上下滑=滚轮注入（RustDesk 三指/微软双指）；**与 pinch 以方向性区分** | 双指滚动判定门槛高、易被 pinch 抢占 | **仲裁弱** |
| 双指捏合 | 本地画布缩放 + 绕焦点（RustDesk onTwoFingerScaleUpdate）；缩放中焦点位移=平移 | 本地缩放（fullscreen 才启用） | 部分有 |
| 放大后画布 | 微软：Pan control（单指平移画布）；RustDesk：捏合焦点位移平移 | 单指 localPan（有） | 双指滚动与 localPan 冲突 |
| 滚动注入 | 滚轮事件（CGEvent wheel / 触控板事件） | scroll → CGEvent wheel ✓ | 已具备 |
| 手势仲裁 | Flutter gesture arena：tap/double-tap 延迟判定、long-press 与 drag 竞争、首事件缓存防跳变 | 无观察期，pinch 优先且不要求双指同时按下 | **缺观察期与方向仲裁** |

## 4. 收敛设计方案

### 4.1 双模式（核心）

工具栏加**输入模式切换**（串流锁定态 toolbar），两态：

- **触控模式（Touch，推荐默认）**：面向"手机触屏操作远程电脑"——注入 action（click / scroll），**不注入鼠标拖动、不驱动远程光标移动**。这是本次要新建/收敛的主路径。
- **鼠标模式（Mouse）**：保留现有点击/拖拽语义（单指 tap=左键、长按拖动=左键拖拽、双指=右键），模拟鼠标。与触控模式共享"放大画布"本地交互。

模式选择持久化（localStorage，per 设备），并在 toolbar 可见切换。

### 4.2 触控模式手势表（收敛、无歧义）

| 手势 | 未放大（scale=1） | 放大态（scale>1） |
|---|---|---|
| 单指 tap | 远程 click（左键） | 远程 click（左键） |
| 单指拖动 | **远程滚动**（注入 scroll，方向=手势方向） | **本地平移画布**（localPan，不注入） |
| 单指长按（>500ms 不动） | 远程右键（click right） | 远程右键 |
| 双指同向上下滑 | 远程滚动（scroll，幅度=中点位移×fraction） | **远程滚动**（scroll）——修复问题 1 |
| 双指捏合 | **本地缩放**进入放大态（绕焦点） | 本地缩放（继续放大/缩小，<1 恢复退出） |
| 双击 | 本地放大（2x，绕触点）→ 放大态 | 恢复 1.0（退出放大态） |

关键语义：
- **单指拖动 = 滚动**（未放大时）——这是与"模拟鼠标拖拽"的最大区别，也是用户诉求（触控模式注入 action 而非鼠标）。
- **放大态单指 = 平移画布**（图片查看器语义），**双指滚动 = 内容滚动**，**双指捏合 = 缩放**——三者互不冲突。
- **放大态下缩放锁定**：进入放大态后双指滚动不再触发缩放判定（除非捏合距离变化超过阈值重新仲裁——见 4.3）。

### 4.3 手势仲裁（消除识别误差）

1. **观察期**：第二指 down 后进入 `twoFingerCandidate`，**前 2~3 个 move 事件（或 ~120ms）只累计样本，不做最终判定**。
2. **方向性仲裁**（替代"pinch 优先"）：
   - **同向（scroll 意图）**：两指沿同一方向移动——用"两指连线方向"与"中点位移方向"的关系判定；中点位移 ≥ 8px 且两指距离变化 < 8% → **scroll**。
   - **反向（pinch 意图）**：两指沿连线反向移动——距离变化 ≥ 8% 且中点位移 < 8px → **pinch**。
   - 判定后**锁定手势**（scroll/pinch 不可逆，直至一指抬起）。
3. **pinch 双指约束**：pinch 只在**两指都从 down 开始参与**时启用；**单指 `localPan` 进行中第二指 down** 时，第二指需**独立位移 ≥ 8px** 才允许升级为双指手势，否则保持 localPan（修复问题 2）。
4. **阈值参数化**：`SCROLL_MIN_MIDPOINT_PX=8`、`PINCH_MIN_SCALE_RATIO=0.08`、`TWO_FINGER_OBSERVE_MS=120`、`SECOND_FINGER_INDEPENDENT_PX=8`。

### 4.4 放大态（zoomed）模型

- 放大态由"双指捏合提交"或"双击"进入；`viewport.scale > 1`。
- **放大态单指**：`localPan`（平移画布，clamp 在内容边界，已有实现保留）。
- **放大态双指**：同向滑 → scroll 注入（**修复问题 1**）；捏合 → 缩放继续（scale<1 或双击恢复 1.0 退出）。
- **单指拖动在未放大 = 滚动、放大 = 平移**的模式切换由 scale 判定，无需用户手动切换。

### 4.5 注入模型（无虚拟鼠标）

- 触控模式：
  - click 注入保留（`click` 事件，daemon 端 click 仍需要光标定位——但**不再为拖动注入连续 mouse move**）。
  - scroll 注入：**新增 `moveCursor?: boolean` 字段**（wire 协议），触控模式发 `moveCursor: false` → daemon `postScrollEvent` 不再先 `postMouseMove`（修复问题 3）；鼠标模式发 `true` 保持现状。
  - 不再有 `pointer`（mouse drag）事件从触控手势发出；`pointer` 事件仅鼠标模式/IME 兼容路径使用。
- daemon 改动（`remote-window-scripts.ts`）：`postScrollEvent` 增加 moveCursor 参数；`remote-window-stream-daemon.ts` 校验新增字段。

### 4.6 协议与数据流

- `packages/shared/src/connection/protocol.ts`：`RemoteWindowInputEventPayload.event` 的 `scroll` 分支加 `moveCursor?: boolean`（向后兼容，缺省 true）。
- daemon 校验（`remote-window-stream-daemon.ts`）同步放宽/读取该字段。
- 模式 state 挂在 `RemoteWindowOverlay`（toolbar 切换 + localStorage `zterm:remote-window:input-mode-v1`），传入 `resolveRemoteWindowTouch*Runtime`。

## 5. 实现范围（文件 + owner）

| 文件 | 改动 | owner |
|---|---|---|
| `android/src/lib/remote-window-touch-action-runtime.ts` | 模式参数（`touchMode`）、双指观察期/方向仲裁、localPan 锁定约束、阈值参数化 | client.remote_window_overlay |
| `android/src/components/terminal/RemoteWindowOverlay.tsx` | 模式 state + toolbar 切换 UI + surface handlers 传模式 + 双击缩放 | client.remote_window_overlay |
| `packages/shared/src/connection/protocol.ts` | scroll 事件加 `moveCursor?: boolean` | wire 协议 |
| `android/src/server/remote-window-stream-daemon.ts` | 校验/透传 `moveCursor` | daemon 输入 |
| `android/src/server/remote-window-scripts.ts` | `postScrollEvent` 支持不移动光标 | daemon 输入 |
| 测试 | `remote-window-touch-action-runtime.test.ts` 新增双指仲裁/模式用例；`remote-window-stream-daemon.test.ts` 补 moveCursor | 同上 |

## 6. 验收标准

1. 放大态双指上/下滑 → 远程内容滚动（真机验证）
2. 单指上下移动 → 未放大=远程滚动；放大=画布平移；**不再触发 pinch 缩小**
3. 触控模式下远程鼠标光标不随滚动/拖动移动（虚拟鼠标消失）
4. 鼠标模式行为与现状一致（回归）
5. type-check 0 error、touch-action-runtime 测试全绿、prebuild 门禁全绿、build:android + OTA

## 7. 待批准决策点

1. **默认模式**：触控模式（推荐）还是鼠标模式？
2. **未放大单指拖动 = 滚动**（推荐，触控语义）还是 = 本地无操作？
3. **双击放大/恢复**是否加入（推荐加）？
4. **长按 = 右键**是否保留（推荐保留）？
