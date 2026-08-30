# Remote Window 画质、流畅性与手势完整修复计划

状态：Approved for execution design

Feature ID：`desktop.remote_window_stream`

设计基线：`b943e7799fdebb6da4961668fc9a0619ac714494`

Owner modules：`daemon.remote_window_stream`、`client.remote_window_overlay`、`client.remote_window_dual_stream_switch`

适用资源：`resource.remote_window_stream`、`resource.remote_window_canvas_layout`、`resource.remote_window_focus_stream`、`resource.remote_window_overview_stream`、`resource.remote_window_overlay`、`resource.remote_window_touch_action`、`resource.remote_window_dual_stream_switch`
替代范围：本计划替代 `android/docs/goals/remote-window-stream-remediation-plan.md` 中 Phase 3 的旧 touch 目标，并要求正式实现前用新 ADR amendment 替代 `2026-08-23-remote-window-touch-gesture-arena-amendment.md` 的单指 release-time swipe 与 zoomed 单指 local-pan 语义。

## 1. 目标

一次性收口远程窗口串流的四条相互影响的主线：

1. 质量更新不再重建 ScreenCaptureKit 捕获流，也不因重复配置制造黑帧、freeze 或自激降级。
2. 用完整 profile 表达“清晰优先”和“流畅优先”，让码率、捕获分辨率、FPS、最大帧年龄、交互 burst 和 overview 预算协同工作。
3. 原始大小与放大状态都可实时操作远端内容；单指滚动不再等待抬手，放大状态不再无条件吞掉单指远端手势。
4. 连续输入、捕获转换与 Android canvas 绘制都采用 bounded/latest/coalesced 语义，优先丢弃过期中间态，绝不丢失可靠 release/key/click 语义。

默认产品偏好定为“流畅优先”。“清晰优先”保留为用户可选 profile，用于代码、终端、文档和静态 UI 阅读。

## 2. 当前基线与已验证根因

本计划只把当前源码中已确认的事实当作实现依据：

| 现状 | 当前证据 | 影响 |
| --- | --- | --- |
| floating 启动固定为 `2mbps`，`fullscreenScale` 不参与计算 | `src/lib/remote-window-video-quality.ts`、`RemoteWindowOverlayController.tsx` | 放大不会增加源细节；fullscreen 首次进入可能再发质量更新 |
| 弱样本每级码率除以 4、FPS 除以 2 | `src/lib/remote-window-video-quality.ts` | 20Mbps/60 可断崖式变成 5Mbps/30、1.25Mbps/15 |
| FPS、drop、freeze、jitter、任意非 none limitation reason 混成一个 weak 判定 | `src/lib/remote-window-video-quality.ts` | 网络、host encode、Android decode/render 被错误归为同一原因 |
| quality apply 每 lane 都先 `setParameters()`，再无条件 `updateFrameRate()` | `src/server/remote-window-quality.ts` | 仅码率变化也触碰 capture cadence |
| capture `updateFrameRate()` 发送完整 `update-config` | `src/server/remote-window-capture.ts` | 无相同配置 no-op |
| Swift `update-config` 调用 `startCapture()`；`startCapture()` 先 stop 全部 SCStream | `src/server/remote-window-screen-capture-script.ts` | 质量更新会重建 capture |
| quality 已是 focus/overview 原子 group transaction，但 daemon busy 只拒绝，没有 latest-wins queue | `src/server/remote-window-stream-daemon.ts` | 快速配置变化会产生 busy/rejected |
| client 允许不同 key 在前一请求未完成时继续发；resolved rejected 只走 accept，状态可能停在 requested | `useRemoteWindowQuality.ts`、`remote-window-quality-controller.ts` | single-flight 与拒绝恢复不完整 |
| Direct Touch 单指移动进入 `touchGestureDrag`，只在 pointerup 发一个 swipe | `src/lib/remote-window-touch-action-runtime.ts` | 原始大小滚动表现为“不动—抬手—跳动” |
| zoomed fullscreen touch pointerdown 直接进入 `localPan` | 同上 | 放大后单指滚动、拖动、长按远端语义被本地 pan 抢占 |
| 超过 1 秒的 tap/swipe/drag pointerup 被丢弃；pointercancel 不补可靠 release | 同上 | 长手势无效，远端按键存在卡住风险 |
| daemon helper 队列深度 24，所有非控制 real input 同类处理；成功输入会刷新后续同目标输入的 receive time | `src/server/remote-window-input-helper.ts` | 过期 scroll/move 可在手停后继续回放，可靠/可丢语义未分离 |
| 每个 input action 单独 requestId、JSON frame 和 result | `remote-window-touch-action-runtime.ts`、`remote-window-message-runtime.ts` | 90/120Hz pointer 流会放大序列化、helper 与回包压力 |
| focus canvas 与 overview/thumbnail canvas 都由显示 rAF 驱动 | `useRemoteWindowCompositeCanvas.ts` | 30FPS 视频可被 60/90/120Hz 重复 drawImage |
| `requestVideoFrameCallback` 已用于播放/帧诊断，但不是 canvas 绘制时钟 | `useRemoteWindowPlayback.ts` | 已有可复用 decoded-frame signal 未成为绘制真源 |
| BGRA pixel buffer 逐像素转 RGBA，完整 RGBA 走 stdout，再复制并转 I420 | daemon capture/stream sources | 1920×1080×4×30 约 249MB/s；60FPS 约 498MB/s，未计额外复制与编码 |
| latest-frame 仅在 peer media 未 ready 时覆盖 pending；运行中每帧仍同步 RGBA→I420→onFrame | `remote-window-stream-daemon.ts` | 运行期转换慢时仍可能积压旧帧 |

2026-08-30 的既有真机记录证明视频已经可见：`1518x1138`、`readyState=4`、focus canvas 有非黑像素；同一记录出现 `decoded=186`、`dropped=185`。该 drop 数是性能红旗，不单独证明网络丢包，必须与 sender、receiver、canvas paint 和 frame-age telemetry 联合判断。

## 3. 文档与治理冲突

正式改代码前必须先消除当前 contract 漂移：

1. Active ADR `2026-08-23-remote-window-touch-gesture-arena-amendment.md`：单指 release-time swipe、zoomed 单指 local pan、双指 realtime scroll。
2. `docs/testing/remote-window-touch-action-sop.md`：仍写双指 release-time swipe，与 runtime/Active ADR 冲突。
3. `docs/feature-gates.md` 和 `docs/wiki/mainline-call-map.json`：仍包含双指 release-time wording。
4. `.agents/skills/zterm-mobile-dev/SKILL.md`：部分段落是双指 realtime scroll，部分 hard gate 仍冻结旧语义。
5. `resource.remote_window_canvas_raw` 与 `resource.remote_window_canvas_encode` 仍为 `design`，不得把 ROI/native encode 当作现状实现或已生效真源。

治理收口顺序固定为：

```text
新 ADR amendment
  -> resource/module/edge registry
  -> function map
  -> mainline call map/source
  -> test design + SOP + feature gates
  -> local skill
  -> red tests
  -> runtime
```

任何 design 资源只有在真实实现、owned paths、import/call edge 和 gate 同时落地后才允许改为 `active`。

## 4. 范围与边界

### 4.1 In scope

- Android remote-window quality selector、自动质量状态机和 stats 采样。
- daemon focus/overview group quality transaction、sender parameters、capture cadence/config update。
- Direct Touch 与 Mouse Emulation gesture arena。
- remote-window continuous/reliable input scheduling、ACK/dedupe/barrier/stale policy。
- Android hidden video → visible canvas 的 decoded-frame 绘制节奏。
- ScreenCaptureKit raw frame转换链的 bounded latest-frame/backpressure。
- shared remote-window typed control contract。
- resource/function/mainline/test/skill 文档同步。
- daemon 全局安装、Android APK、真实 Mac/Android/route 验证、AGY Review、定向 commit/push。

### 4.2 Out of scope

- terminal mirror、sparse buffer、renderer、tmux width 或普通 terminal input。
- screenshot loop、terminal rows、旧视频、静态图像作为 stream fallback。
- Android 页面视觉重设计；只允许为“清晰优先/流畅优先”和显式手掌模式增加必要控制。
- 未经 Jason 单独授权的 OTA stable/public Relay 发布、用户数据清理、TCC reset 或生产 session 清理。
- 未经验证就把 `resource.remote_window_canvas_raw` / `resource.remote_window_canvas_encode` 标为 active。

### 4.3 唯一 owner

| 语义 | 唯一 owner | 允许路径 |
| --- | --- | --- |
| 用户质量偏好、stats 投影、desired/inFlight/queued/applied | `client.remote_window_overlay` | `src/lib/remote-window-video-quality.ts`、`remote-window-quality-controller.ts`、`useRemoteWindowQuality.ts` |
| stream group 预算、sender/capture transaction | `daemon.remote_window_stream` | `src/server/remote-window-quality.ts`、`remote-window-stream-daemon.ts` |
| ScreenCaptureKit config 与帧输出 | `daemon.remote_window_stream` | `remote-window-capture.ts`、`remote-window-screen-capture-script.ts` |
| touch/mouse gesture classification | `resource.remote_window_touch_action` | `remote-window-touch-action-runtime.ts` |
| React pointer wiring与本地 viewport 投影 | `client.remote_window_overlay` | `RemoteWindowOverlayController.tsx`、`useRemoteWindowViewport.ts` |
| 远端 OS action 队列和注入 | `daemon.remote_window_stream` | `remote-window-input-helper.ts`、`remote-window-input-script.ts` |
| decoded frame → canvas projection | `client.remote_window_overlay` | `useRemoteWindowCompositeCanvas.ts`、`RemoteWindowVideoContent.tsx` |

禁止 Android 计算 macOS global coordinate，禁止 daemon 持有 zoom/input mode/UI state，禁止 gesture owner 直接创建 socket，禁止质量策略触碰 terminal transport 或 receiver lifecycle。

## 5. 目标质量 contract

### 5.1 Profile 不是 Mbps preset

现有 `2/5/10/20/fullscreen` selector 要迁移为两种产品偏好和可选高级上限。profile 至少包含：

```ts
interface RemoteWindowVideoProfile {
  preference: 'quality' | 'smooth';
  maxBitrateBps: number;
  maxFrameRateFps: number;
  maxCaptureWidth: number;
  maxCaptureHeight: number;
  maxFrameAgeMs: number;
  interactionActive: boolean;
  overviewMaxBitrateBps: number;
  overviewMaxFrameRateFps: number;
}
```

该对象是 stream-local typed quality control，不是媒体业务 payload。revision、retry、busy、cooldown 和 health 只能留在 quality control resource，禁止写入媒体 frame 或借 metadata 混入业务内容。

第一版必须复用现有 quality request/result contract 做版本化扩展；不得新增同义 DTO 或在 UI/daemon 各定义一份 profile。

### 5.2 清晰优先

| 状态 | 捕获上限 | FPS | focus 最大码率 | 最大帧年龄 | 说明 |
| --- | --- | ---: | ---: | ---: | --- |
| 静止/原始大小 | 长边 1920、短边 1200 | 30 | 12–16Mbps | 150ms | 文本和 UI 边缘稳定 |
| 滚动/拖动 active | 同上 | 30 | 14–18Mbps | 120ms | 运动画面需要更高码率，不牺牲源分辨率 |
| 网络约束 L1 | 长边 1600 | 30 | 8–10Mbps | 150ms | 先小步降空间量，保住交互 FPS |
| 网络约束 L2 | 长边 1280 | 24–30 | 5–7Mbps | 180ms | 最后才降 FPS |
| host/encode 约束 | 长边 1600→1280 | 30→24 | 保持网络可承受值 | 150ms | 先减像素处理量，不把 CPU 问题伪装成弱网 |

### 5.3 流畅优先（默认）

| 状态 | 捕获上限 | FPS | focus 最大码率 | 最大帧年龄 | 说明 |
| --- | --- | ---: | ---: | ---: | --- |
| 静止 | 长边 1280–1440 | 30 | 4–6Mbps | 100ms | 手机默认低延迟基线 |
| 滚动/拖动 active | 长边 1280 | 45 | 6–8Mbps | 80ms | 允许运动中文本略软，保持响应 |
| 网络约束 L1 | 长边 960–1280 | 30–45 | 3–4Mbps | 100ms | 根据真实吞吐选择尺寸，不断崖式降 FPS |
| 网络约束 L2 | 长边 854–960 | 30 | 1.5–2.5Mbps | 120ms | 保持可操作，不回放旧帧 |
| host/decode/render 约束 | 长边 960–1280 | 30 | 3–6Mbps | 80–100ms | 先减少像素和绘制次数 |

在当前 RGBA stdout 链完成 backpressure 前，禁止把 1080p60 作为默认。流畅优先基线是 720p/1280-long-edge 45FPS；清晰优先基线是 1080p/1920-long-edge 30FPS。

### 5.4 Overview 预算

overview 不能永久拿总码率 20% 且最低 250Kbps。目标预算：

| 状态 | FPS | 最大码率 |
| --- | ---: | ---: |
| picker/切换窗口前后 1 秒 | 4–8 | 300–600Kbps |
| 普通静止 | 2 | 200–300Kbps |
| focus 正在滚动/拖动 | 0–1 | 100–150Kbps |
| 无 overview lane | 0 | 0 |

focus 与 overview 仍必须作为一个 revisioned group transaction；所有 lane 分配之和不得超过 total budget。

### 5.5 Interaction burst

以下用户事件立即进入 `interactionActive`：remote scroll、remote/local drag、pinch、window move/resize、focus switch。

- 首个事件立即请求 motion profile；相同 profile 必须 no-op。
- 最后一次事件后 600ms 才退出 interaction。
- 空间清晰度恢复需额外稳定 2 秒，避免快速抖动。
- ABR 普通调整最短间隔 4 秒；quality apply 后跳过两个 stats 样本。
- interaction 只改变 stream-local quality，不重建 peer、receiver、transport 或 capture stream。

### 5.6 Zoom 与 ROI

客户端 zoom 只放大现有像素。没有 ROI 能力时，zoom 变化不得无意义地提高码率或重启 capture。

ROI 属后续能力：

- overview 保留全局低清定位。
- focus 捕获当前可视 source ROI，维持接近 1:1 像素密度。
- pan/pinch 热路径只做本地视觉反馈；停顿 120–150ms 后提交最新 ROI。
- 只允许 latest ROI；不得逐 pointermove 排队。
- 必须通过 capability、资源 registry、坐标矩阵和 live marker gate 后才能成为 active path。
- 不允许 ROI 失败后静默切 screenshot 或旧 focus；失败必须显式保留当前 stream truth并报告 ROI update failure。

## 6. 质量控制状态机

客户端状态收敛为：

```text
appliedProfile
desiredProfile
inFlight { revision, profile }
queuedLatestProfile
cooldownSamplesRemaining
```

规则：

1. `desired == applied`：不发请求。
2. `desired == inFlight`：不发请求。
3. 已有 inFlight 且 desired 改变：只覆盖 `queuedLatestProfile`，不并发。
4. 当前请求 applied：提交 applied；若 queuedLatest 与 applied 不同，发送最新一个。
5. 当前请求 rejected：必须离开 requested；busy 只在上一 daemon transaction 真实存在时重试 queued latest，其他错误显式投影。
6. 超时：请求进入明确 rejected/timeout，不得永久停在 requested。
7. revision 单调递增；旧结果不能覆盖新 desired/applied。
8. daemon 收到新 revision 但配置值与已应用一致时，返回 `applied` + no-op 事实，只推进 revision，不触碰 sender/capture。

daemon transaction 先计算每 lane diff：

```text
bitrate changed only -> sender.setParameters
fps changed only     -> SCStream.updateConfiguration in place
size changed         -> SCStream.updateConfiguration in place
target/filter changed-> SCStream.updateContentFilter/updateConfiguration in place
no value changed     -> applied no-op
```

绝不允许 quality update 调用 stop/start SCStream。in-place update 失败时保持旧配置并返回明确失败；若 group rollback 失败，stream 必须进入明确 terminal error 并 exactly-once cleanup，禁止继续运行部分应用的质量真相。

## 7. 原因分离的自适应策略

当前一个 `weak` 布尔值要拆成四类事实，不互相重建：

| 原因 | 主要证据 | 第一调整项 | 第二调整项 |
| --- | --- | --- | --- |
| network constrained | available bitrate、packet-loss delta、jitter、持续 RTT | 码率小步 -20% | 捕获尺寸降一级 |
| host capture/encode constrained | capture/convert/encode duration、sender limitation=cpu、frame backlog | 捕获尺寸降一级 | FPS 降一级 |
| Android decode/render constrained | framesDecoded/dropped delta、canvas paint duration、frame callback age | 捕获尺寸降一级、一次一帧绘制 | FPS 降一级 |
| latency only | RTT/frame-age 高但无 loss/backlog | 丢弃过期连续态、缩短队列 | 不主动破坏清晰度 |

门限规则：

- 降级至少连续 2 个同类样本；严重 loss/backlog 可立即降一级。
- 每次只移动一个 profile level，禁止除以 4。
- 恢复需 12 秒稳定窗口，每次只恢复一级。
- cumulative counters 必须转换成 per-sample delta。
- `qualityLimitationReason !== none` 不能直接判网络弱。
- stats/control/debug 走 typed telemetry/control resource，不混入视频 frame、input action 或业务 response。

## 8. 目标手势 contract

### 8.1 Direct Touch

| 手势 | 1× 原始大小 | zoomed |
| --- | --- | --- |
| 单击 | 远端左键 click | 远端左键 click |
| 单指移动超过 8px | 实时远端 pixel scroll | 实时远端 pixel scroll |
| 按住约 250ms 后移动 | 远端可靠 drag：down → move* → up | 同左 |
| 按住约 500ms 且未移动 | 远端右键 click | 远端右键 click |
| 双指同向移动 | 实时远端 scroll | 本地平移 zoomed canvas |
| 双指开合 | 本地 pinch zoom | 本地 pinch zoom |
| 双击 | 以触点为锚放大到 2× | 恢复 1× |

该语义明确解决两个核心问题：原始大小单指滚动在移动阶段即反馈；zoomed 单指仍可操作远端内容，本地 pan 转移给双指同向移动。

### 8.2 Mouse Emulation

| 手势 | 行为 |
| --- | --- |
| 单指移动 | 远端鼠标移动 |
| 按下移动 | 远端 mouse drag |
| 单击/双击 | 远端左键 click/double click |
| 双指同向移动 | 远端滚轮 |
| 双指开合 | 本地 pinch zoom |
| 本地 pan | 显式手掌模式/toolbar 控制；不得与远端滚轮复用 |

### 8.3 Gesture arena

```text
pointerdown
  -> actionPending

first finger movement >= 8px before hold
  -> remoteScroll (latched)

hold >= 250ms then movement >= 8px
  -> remoteDrag (latched; reliable down/up)

hold >= 500ms with no movement
  -> rightClick

second pointer appears
  -> twoFingerCandidate (80–120ms / bounded move samples)
     -> anti-parallel distance change >= 8%: pinch (latched)
     -> same-direction at 1x: remoteScroll (latched)
     -> same-direction while zoomed: localPan (latched)
```

规则：

- zoomed pointerdown 不得立即决定 localPan。
- gesture 一旦提交，在本轮 pointer sequence 中不得 scroll/pinch/pan 相互跳变。
- pointerup 不再用“手势总时长 >1 秒”丢事件。
- remote drag 的 pointerup 是可靠 barrier，不受连续事件年龄限制。
- pointercancel 若已发送 down，必须生成可靠 release；pair cancel 必须结束 pinch/pan/scroll 本地状态。
- letterbox/content 之外的触点返回 null，不 clamp 成源画面边缘点击。

## 9. 输入调度与背压

### 9.1 两条语义 lane

可靠 lane，严格有序且不可丢：

- pointer down/up/cancel-release
- click/double-click/right-click
- key down/up、text commit、paste
- focus、window resize、stream focus switch barrier

连续 lane，可覆盖或合并：

- pointer move/hover
- pixel scroll
- local interaction telemetry

delivery sequence、retry、route generation、ACK state 必须位于 typed control envelope/resource；业务 action 只描述用户动作。禁止把 retry/health/debug 写入 action `metadata`，也禁止从 action payload 反推控制状态。

### 9.2 Client scheduler

- pointer move：只保留最新坐标。
- scroll：累加 deltaX/deltaY，坐标取最新。
- flush 上限：流畅优先 45Hz，清晰优先 30Hz。
- reliable barrier 前先 flush 已聚合连续态，再发送 barrier。
- reliable action 等 ACK/NACK；超时或 route generation change 才以同 sequence 重发，禁止每 tick 重发或生成新 requestId。
- input result 必须回到 scheduler owner，不再只是 diagnostics。

### 9.3 Daemon scheduler/helper

- 每目标连续队列深度最多 1–2；最新 move 覆盖旧 move，scroll delta 合并。
- 连续态最大 daemon-local age：流畅优先 80–100ms，清晰优先 150ms。
- 连续态 receive time 永不因前序 action 成功而刷新；过期直接丢弃。
- 可靠 lane 独立于连续 stale policy，按 sequence 去重并 ACK/NACK。
- down/up/key barrier 保证顺序；queue overflow 不得丢可靠 release/key/click。
- Swift helper 继续作为唯一常驻 OS injection owner，不得 per-event spawn。

## 10. Android 绘制与热路径

1. focus canvas 由 `requestVideoFrameCallback` 驱动，一张 decoded frame 只 draw 一次；缺少该能力时显式报告不支持，不保留生产 rAF 双路径。
2. overview/thumbnail 由对应视频帧回调驱动，再按 profile 限制为 0–8FPS。
3. canvas 2D context 缓存到生命周期 ref；尺寸变化时才重设 width/height。
4. pointermove 只更新 ref/DOM transform，每个 rAF 最多应用一次本地 viewport 变换；gesture end 再提交 React state。
5. `console.log`、`JSON.stringify(viewport)`、视频属性和 `getBoundingClientRect()` 只允许在显式 diagnostics gate 内执行。
6. 增加 decoded callback timestamp、paint start/end、presented frame id，计算 paint duration 和 frame age；telemetry 只进 debug/control side-channel。

## 11. Capture/convert backpressure

短期必须把运行期也改成 latest-frame：

```text
conversion idle -> process newest frame
conversion busy -> replace one pending frame
conversion done -> take current pending newest frame
```

- focus 和 overview 各自最多一个 pending frame。
- pending frame 带 capture monotonic timestamp；超过 profile maxFrameAge 直接丢。
- Swift stdout writer 不能让 sample callback 无界阻塞；输出侧也要 bounded latest，避免 Node 丢帧时 pipe 里已经堆满历史帧。
- 所有 buffer/pipe/queue 都输出 current depth、drop count、oldest age。
- 不允许通过增加 queueDepth 掩盖转换过慢。

长期 media path 决策使用实测门禁：

- 如果 bounded RGBA path 能同时达到“流畅优先 1280-long-edge/45FPS”和“清晰优先 1920-long-edge/30FPS”的 frame-age/CPU/温度验收，可以保留当前单一路径，`canvas_raw/canvas_encode` 继续保持 design。
- 如果任一 profile 不达标，必须在 `../wterm` 或当前 native owner 中实现并发布唯一 native CVPixelBuffer/WebRTC source 或 VideoToolbox 接入，随后物理删除生产 RGBA stdout 路径；禁止长期并存两条 production media path。

## 12. 坐标与 viewport

显示和输入共用一个变换真值：

```ts
interface RemoteWindowViewportTransform {
  sourceToSurface: Matrix3;
  surfaceToSource: Matrix3;
  visibleSourceRect: Rect;
  surfaceContentRect: Rect;
}
```

- renderer 只用 `sourceToSurface`。
- input 只用其逆矩阵 `surfaceToSource`。
- 1×、zoom、pan、keyboard allowance、composite focus slot 都从同一个 transform 得出。
- 触点在 `surfaceContentRect` 外时返回 null。
- fullscreen 当前 product contract 仍是远端 window resize 实现 fill、本地绘制/input 保持 aspect-fit；不得把 dead `displayMode` 参数误当成本地 cover/crop 真相。

## 13. 实施阶段

### Phase 0：冻结 contract、maps 与测试设计

1. 新增 touch/quality ADR amendment，正式替代 2026-08-23 的冲突语义。
2. 同步 SOP、feature gates、local skill。
3. 更新 resource/module/edge registry、function map、mainline call map/source。
4. 为 quality transaction、gesture lifecycle、reliable/lossy scheduler、frame-age/render 增加正反测试设计。
5. 运行 registry/import/call-map gates；未通过不得改 runtime。

### Phase 1：质量更新不重启 capture

1. 为 sender/capture lane 建 exact diff/no-op。
2. Swift 使用 `SCStream.updateConfiguration` / `updateContentFilter` 原位更新。
3. bitrate-only 只改 sender。
4. client quality controller 改 single-flight + latest-wins + rejected recovery。
5. daemon 保留 group atomicity、rollback 和 explicit terminal failure。
6. 增加 apply 后 stats cooldown。

### Phase 2：实时单指滚动和 zoom gesture arena

1. 红测反转旧的 release-time single drag 与 zoomed local-pan 默认。
2. 实现统一 pending/scroll/drag/right-click/pair arena。
3. zoomed 单指实时远端 scroll；双指同向 local pan；pinch local zoom。
4. 删除 gesture duration 1 秒限制。
5. pointercancel 生成可靠 release。
6. content 外触点不映射。

### Phase 3：连续/可靠输入 scheduler

1. 先查现有 reliable-input 函数库；只复用通用、边界匹配的能力，不复制 terminal 语义。
2. 建 typed control envelope、sequence、ACK/NACK、dedupe 和 barrier。
3. client move latest、scroll accumulate、30/45Hz flush。
4. daemon 连续队列 1–2、独立 age budget、可靠 lane 不丢。
5. 删除连续事件 receive-time refresh；保留可靠事件显式生命期。

### Phase 4：两种 profile 与原因分离 ABR

1. UI 改为清晰优先/流畅优先 + 自动调节；旧 Mbps preset 只作为 migration input/高级上限，迁移完成后物理删除死语义。
2. profile 加 capture dimensions、max frame age、interaction/overview budget。
3. stats 增加 loss、decode/render、paint/frame-age、host capture/convert/encode facts。
4. 实现 cause-specific small-step ABR、interaction burst、restore window。
5. 相同 profile 全链 no-op。

### Phase 5：绘制与媒体背压

1. focus canvas 改 decoded-frame driven。
2. overview/thumb 独立节流。
3. local transform 每帧最多一次 DOM commit。
4. daemon 与 capture output 运行期 bounded latest-frame。
5. 在受控动画 AppKit target 上测两个 profile。
6. 若不达标，进入唯一 native media path 并删除 raw production path。

### Phase 6：安装态与真实设备闭环

1. 完成全部定向测试、type-check、build、architecture gates。
2. 生成 daemon release，安装全局 daemon，service-scoped restart；证明 installed runtime SHA 与构建产物一致。
3. 运行 raw、mux、Tailscale/Relay 可达路径 live input/video probes，禁止并发同目标 stream。
4. 构建 Android APK，使用保数据覆盖安装或 OTA；禁止 uninstall/clear data。
5. 真机验证 1×/zoom、质量/流畅 profile、滚动/drag/cancel、foreground resume、cleanup。
6. 完成后才运行 AGY Review；任何 review 后代码改动必须重跑受影响验证、安装/live gate 和新 review。
7. controller PASS 后定向 commit/push；OTA stable/public Relay 发布仍需 Jason 单独授权。

## 14. 文件清单

治理与 contract：

- `android/docs/decisions/` 新 touch/quality ADR amendment
- `android/docs/resource-registry.json`
- `android/docs/module-registry.json`
- `android/docs/edge-registry.json`
- `android/docs/function-map.md`
- `android/docs/wiki/mainline-call-map.json`
- `android/docs/wiki/mainline-source.md`
- `android/docs/feature-gates.md`
- `android/docs/testing/remote-window-stream-test-design.md`
- `android/docs/testing/remote-window-touch-action-sop.md`
- `.agents/skills/zterm-mobile-dev/SKILL.md`
- `packages/shared/src/connection/protocol.ts` 及 focused contract tests

Client quality/input/render：

- `android/src/lib/remote-window-video-quality.ts`
- `android/src/lib/remote-window-quality-controller.ts`
- `android/src/components/terminal/useRemoteWindowQuality.ts`
- `android/src/lib/remote-window-touch-action-runtime.ts`
- `android/src/components/terminal/RemoteWindowOverlayController.tsx`
- `android/src/lib/remote-window-message-runtime.ts`
- `android/src/contexts/session-context-remote-window-runtime.ts`
- `android/src/components/terminal/useRemoteWindowViewport.ts`
- `android/src/components/terminal/useRemoteWindowCompositeCanvas.ts`
- `android/src/components/terminal/useRemoteWindowPlayback.ts`
- `android/src/components/terminal/RemoteWindowVideoContent.tsx`
- 对应 focused tests 与 page-level tests

Daemon quality/input/capture：

- `android/src/server/remote-window-quality.ts`
- `android/src/server/remote-window-stream-daemon.ts`
- `android/src/server/remote-window-capture.ts`
- `android/src/server/remote-window-screen-capture-script.ts`
- `android/src/server/remote-window-input-helper.ts`
- `android/src/server/remote-window-input-policy.ts`
- `android/src/server/remote-window-input-script.ts`
- 对应 daemon tests 与 live probes

不得因为文件清单存在就全量改动；每个 phase 只修改唯一 owner 所需的最小文件。

## 15. 测试矩阵

### 15.1 Quality 正反测试

| Case | 正向 | 反向 |
| --- | --- | --- |
| bitrate-only | sender 更新、capture 调用 0 次 | 不 stop/start SCStream |
| same profile | 返回 applied no-op | sender/capture 均不调用 |
| FPS change | in-place updateConfiguration | stopCapture/startCapture 0 次 |
| group failure | 已应用 lane 精确 rollback | 不返回 partial applied |
| concurrent desired | latest queued 一次 | daemon 不收到并发 busy storm |
| rejected/busy | client 离开 requested 并处理 latest | 不永久 requested、不丢最新 desired |
| stats cooldown | 两个瞬态样本不触发二次降级 | cooldown 后真实弱样本仍能降级 |
| cause split | CPU/render 压力降尺寸 | 不冒充 network weak |

### 15.2 Gesture/input 正反测试

| Case | 正向 | 反向 |
| --- | --- | --- |
| 1× 单指 scroll | move 阶段连续 bounded pixel scroll | pointerup 无 release-time swipe |
| zoomed 单指 scroll | 远端 scroll 可用 | 不进入 localPan |
| zoomed 双指 pan | 本地 canvas pan | 不发远端 scroll/pointer |
| pinch | anchor-preserving local scale | 不误投 scroll |
| hold-drag | down→move*→up | 普通 scroll 不发 pointer down |
| long press | 单次 right click | 抬手不重复 click |
| 5 秒 drag | 可靠 up 到达 | 不因 1 秒 stale 丢 up |
| pointercancel | 已 down 时可靠 release | 远端无 stuck button |
| letterbox | 返回 null | 不 clamp 到源边缘 |
| 120Hz input | 30/45Hz 以内连续 frame | reliable barrier 不被合并/丢弃 |
| stale scroll | 过期直接丢 | 手停后不继续回放 |
| ACK timeout | 同 seq 有界重发 | 不生成新 seq/重复文字或 click |

### 15.3 Render/media 正反测试

- 每个 decoded frame 最多一次 focus `drawImage`；屏幕 rAF 不重复绘同一 frame。
- overview/thumb 遵 profile FPS；interaction 中不抢 focus。
- conversion busy 只保留一个 pending latest；旧 frame age 超预算即丢。
- no-frame、invalid dimensions、conversion failure 明确 error/cleanup。
- 1920×1080@30 与 1280-long-edge@45 受控动画 marker 连续运行，无黑帧、无旧帧尾巴。

### 15.4 必跑命令类别

- focused quality/controller/hook tests
- focused touch/viewport/composite canvas/page-level tests
- remote-window daemon quality/capture/input/stream tests
- shared protocol tests
- `test:feature-registry`、module/import/edge/mainline truth gates
- type-check、canonical build、Android build
- daemon release/install/service restart/installed SHA gate
- raw + mux + Tailscale/实际 active route video/input live probes
- online Android installed-phone CDP/ADB/AppKit marker gate
- AGY Review MCP

具体命令以实现时 `package.json` 和 verification map 的当前真源为准；不得复制失效命令冒充验证。

## 16. 量化验收

| 项目 | 完成条件 |
| --- | --- |
| capture rebuild | bitrate/FPS/profile update 中 `stopCapture/startCapture` 调用均为 0 |
| no-op | 相同 profile 重复请求 sender/capture 更新均为 0 |
| quality concurrency | client 同时最多一个 inFlight，latest desired 最终 applied |
| 连续输入频率 | 120Hz pointer 输入最多产生 45 条连续 wire action/s |
| 连续队列 | client/daemon 每类连续 pending 深度 ≤2 |
| 滚动反馈 | pointermove 阶段已出现真实 AppKit scroll，不等待 pointerup |
| 长手势 | 5 秒 remote drag 仍收到可靠 pointerup |
| cancel | pointercancel 后目标无按键卡住 |
| 坐标 | 1×/2×/最大 pan 下误差 ≤2 source px 或 0.5%，letterbox 无边缘误点 |
| 流畅优先 | LAN/可控 direct route 下 1280-long-edge@45，presented frame age p95 ≤100ms |
| 清晰优先 | LAN/可控 direct route 下 1920-long-edge@30，presented frame age p95 ≤180ms，文本 marker 稳定 |
| canvas | 一张 decoded frame 最多 draw 一次 |
| overview | focus interaction 时 0–1FPS/≤150Kbps |
| 黑帧 | 质量/profile 切换无 capture restart 黑帧 |
| cleanup | stream stop 后 peer/source/track/capture child/timer/pending queue 全部 exactly-once 清理 |

延迟数值在新受控 A/B 实测通过前是设计验收目标，不得提前报告为当前实测结果。

## 17. 风险与规避

1. `SCStream.updateConfiguration` 在组合 lane 的系统行为差异：先做真实单/组合窗口 in-place probe；失败显式暴露，不回到 stop/start。
2. 可靠 input contract 扩大 wire 面：先更新 shared contract、错误链、dedupe 红测和 maps；不得 UI/daemon 各补一套。
3. 一指 scroll 与 remote drag 仲裁误判：250ms hold 与 8px movement 作为单 owner 参数，真机以慢拖、快滚、斜滑成对验证。
4. zoomed 双指 pan 改变现有习惯：toolbar 显示简短 gesture hint；不增加弹窗式教学或复杂 UI。
5. 高 FPS 放大 raw pipe 压力：resolution limit、latest-frame、frame-age 先落；达不到验收就进入唯一 native path，不提高 queue 深度。
6. 真实 route 差异：从 active profile/endpoint truth 记录 resolved route，不把 Tailscale/TURN/Relay 混称 LAN。
7. 主 tree dirty/多 worktree：所有实现按 semantic claim 在单独 clean worktree 完成；不覆盖、restore、stash 或提交他人改动。

## 18. 完成定义（DoD）

只有同时满足以下条件才算完整修复：

1. 新 contract、registry、maps、test design、SOP、skill 同步且机器 gate 通过。
2. quality apply 无 capture rebuild；client single-flight/latest-wins；cause-specific ABR 与两种 profile 生效。
3. 1× 与 zoomed 单指实时远端 scroll、zoomed 双指本地 pan、pinch、remote drag/right click/cancel 都通过正反测试和真机 AppKit marker。
4. continuous/reliable lanes、ACK/dedupe/barrier/stale policy 在弱网和 120Hz replay 下无积压尾巴、无重复、无 stuck button。
5. Android canvas decoded-frame driven；capture/convert 运行期 latest-frame；两个 profile 达到量化目标，或完成唯一 native media path 并删除旧 production raw path。
6. 受控 Mac target、installed daemon、真实 Android APK、当前 active direct/Tailscale/Relay 路径完成视频、输入、foreground resume 和 cleanup 证据。
7. AGY Review controller PASS；review 后无未复验代码改动。
8. 定向 change set commit/push，未夹带主 tree dirty 文件；未获授权时不发布 OTA stable/public Relay assets。
