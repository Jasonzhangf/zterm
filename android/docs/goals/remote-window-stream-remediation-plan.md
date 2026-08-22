# Remote Window Stream 整改工作计划

Feature ID：desktop.remote_window_stream  
目标：恢复远程串流启动，并完成 remote-window 拆分、通用 touch 交互、多窗口 focus-plus-rail 平铺和 WebRTC 媒体链路优化。  
审计依据：android/docs/audits/2026-08-22-remote-window-stream-comprehensive-audit.md

## 1. 目标与完成标准

最终必须达到：

1. 普通单窗口 app-window 可在 direct/Tailscale/Relay 路径真实启动并显示连续视频。
2. composite multi-window 使用明确 overview + focus 双流，不再发生 track 数量不匹配。
3. Android receiver、daemon answer、track role、layout generation 由 typed contract 串联。
4. UI、session、media、focus、input、gesture、projection 形成单 owner 链。
5. Direct Touch / Mouse Emulation 行为与 contract 一致。
6. 多窗口默认采用稳定 focus-plus-rail，最多 3 个小窗口 + 1 个 focus 主窗口。
7. overview video 是连续 sibling preview 的唯一来源；无 screenshot thumbnail loop。
8. WebRTC 具备 bounded frame queue、focus 优先、帧/编码/发送统计，并完成 native encoder 可行性验证。
9. Android 真机、安装版 daemon、Mac target、Relay/弱网和 cleanup 全部有证据。

## 2. 范围

### In scope

- android/src/lib/remote-window-*
- android/src/server/remote-window-*
- android/src/components/terminal/RemoteWindow*
- android/src/contexts/session-context-remote-window-runtime.ts
- packages/shared/src/connection/protocol.ts 中 remote-window typed contract
- remote-window resource/function/mainline/test design 文档
- Mac daemon native capture、compositor、WebRTC sender 相关实现
- Android APK / daemon 安装版 live verification

### Out of scope

- terminal mirror/buffer/renderer 重构
- 普通 terminal session transport 重构
- remote screenshot 产品功能本身，除删除其 live thumbnail loop 的调用外不扩大范围
- 未授权的 OTA 发布、公开 Relay 发布或用户 session 清理
- 把 terminal buffer、截图或静态缓存作为 stream fallback

## 3. 设计原则

1. 单窗口和组合窗口必须使用显式 mediaPlan，禁止 client/server 各自猜测 track 数量。
2. 控制面和视频 payload 分离；revision、generation、stage、debug、quality ACK 不能混入媒体业务 payload。
3. daemon 是 catalog、source rect、canvas layout、capture、WebRTC sender、input injection、cleanup 唯一 owner。
4. Android 只消费 typed layout、媒体和结果，不能计算 macOS global coordinate 或重建布局真相。
5. 错误显式暴露；禁止 screenshot、terminal render、旧视频或 stale layout 静默兜底。
6. 先修 P0 启动契约，再做结构拆分和性能优化；未通过前置 gate 不进入下一阶段。
7. 每个状态机都必须有 success/failure/non-terminal/already-terminal 正反测试。

## 4. 目标 contract

### 4.1 Media plan

~~~text
single-focus:
  1 video m-line
  1 video sender
  1 focus track

overview-plus-focus:
  2 video m-lines
  2 video senders
  overview role + focus role
  one streamGroupId
~~~

规则：

- single-focus：普通单窗口只等待 focus。
- overview-plus-focus：组合窗口同时等待 overview 和 focus。
- started、status、receiver binding、quality transaction 全部引用同一 media plan。
- track 数量不匹配必须返回 typed error，不能等待 timeout。

### 4.2 Touch contract

Direct Touch：

~~~text
single tap        -> one click
single drag       -> one release-time gesture/swipe
two-finger scroll -> realtime vertical pixel scroll, moveCursor=false
two-finger pinch  -> local zoom
zoomed one-finger -> local pan
~~~

Mouse Emulation：

~~~text
pointer down -> pointer down
pointer move -> realtime pointer move
pointer up   -> pointer up
~~~

一个 gesture owner 负责识别，一个 input owner 负责发送；禁止 controller 再实现第二套 long-press 或 gesture recognizer。

### 4.3 Layout contract

默认 focus-plus-rail：

~~~text
┌────────┬────────┬────────┐
│ child1 │ child2 │ child3 │
├────────┴────────┴────────┤
│          focus           │
└──────────────────────────┘
~~~

daemon layout planner 唯一输出：

- layoutGeneration
- canvasSize
- source rect
- canvas rect
- z-order
- focus rect
- stable slot identity
- dropped/invalid window diagnostics

### 4.4 Media performance contract

每个 lane 记录：

- capture timestamp
- pipe receive timestamp
- RGBA parse duration
- I420/encode duration
- queue depth
- dropped frame count
- sender/encoded/sent count
- receiver rendered count
- end-to-end latency

队列规则：

- bounded latest-frame queue
- focus lane 优先
- overview lane 可明确降帧
- 禁止无限积压
- 禁止 screenshot 请求进入连续视频路径

## 5. 实施阶段

### Phase 0：启动恢复，P0

目标：single-focus 和 overview-plus-focus 两种模式真实启动。

任务：

1. 修改 shared protocol，加入显式 media plan / track role。
2. receiver 按 media plan 创建 transceiver。
3. daemon 按同一 media plan 添加 sender。
4. 修复 app-window 普通目标错误等待 overview 的问题。
5. answer 返回前验证 sender/track 数量。
6. 增加 stage-aware error。
7. 增加 single/composite client-server integration test。
8. 增加 first-frame 和 continuous-frame gate。
9. 真实验证 direct、Tailscale、Relay 至少各一条可用路径。

必跑 gate：

- remote-window-receiver-runtime.test.ts
- remote-window-stream-daemon.test.ts
- remote-window-message-runtime.test.ts
- 新增 media plan contract test
- 新增 native peer integration test
- type-check
- Android build
- installed daemon + Android real-device startup replay

退出条件：

~~~text
single-focus:
  matching SDP
  1 video track
  first frame
  framesSent >= 3

overview-plus-focus:
  matching SDP
  2 video tracks with roles
  both first frames
  framesSent >= 3 per lane
~~~

### Phase 1：媒体生命周期和测试隔离

目标：消除 native WebRTC teardown 不稳定和启动错误不可诊断。

任务：

1. 分离纯逻辑测试和 native integration 测试。
2. 每个 native test 使用独立 peer/process 生命周期。
3. 统一 cleanup owner：capture → source → sender → peer → timer → child。
4. 给 active peer/source/capture child 建计数器。
5. 对 close、capture failure、transport failure、answer failure 做 exactly-once cleanup。
6. 记录 startup stage 和 stage duration。

退出条件：

- native corpus 单独进程重复运行无 SIGSEGV。
- 失败路径无 peer、capture child、timer、pending update 遗留。
- stop/status/close 的正反测试成对通过。

### Phase 2：owner 拆分

目标：让 UI 不再直接编排所有 remote-window 语义。

任务：

1. RemoteWindowSessionController：catalog、target lock、stream lifecycle、foreground/background。
2. RemoteWindowMediaController：peer、SDP、ICE、track binding、frame readiness、stats。
3. RemoteWindowFocusController：focus revision、overview crop、focus handoff。
4. RemoteWindowInputController：typed action、layout generation、transport result。
5. RemoteWindowGestureController：Direct Touch、Mouse Emulation、pinch、local pan。
6. RemoteWindowProjection：picker、toolbar、video surface、fullscreen、diagnostics。
7. 将 RemoteWindowOverlayController.tsx 降为组合层，不持有 peer/socket/native truth。
8. 更新 function map、mainline call map、module/edge registry 和 boundary gates。

退出条件：

- UI 不 import/construct RTCPeerConnection。
- gesture 不调用 socket sender。
- projection 不计算 macOS source coordinate。
- session owner 是唯一 stream start/stop owner。
- media owner 是唯一 peer/track owner。
- architecture/import/owner gates 全绿。

### Phase 3：touch 统一

目标：对齐通用远程桌面行为。

任务：

1. 删除单指 Direct Touch → realtime scroll 旧语义。
2. 保留双指垂直 scroll，过滤横向 drift。
3. 保留 local pinch / zoomed local pan。
4. Direct Touch 单指 drag 改为 release-time gesture/swipe。
5. Mouse Emulation 保持 down/move/up。
6. 删除 controller/runtime 双重 long-press 识别。
7. 添加 pair-to-single、cancel、stale、mode commit、nested control 反向测试。
8. live Mac marker app 验证 click、gesture、scroll、key。

退出条件：

- 单指 drag 无 raw pointer move、无 scroll。
- 双指 scroll 无 click、无 final gesture、无 cursor movement。
- pinch/local pan 无 daemon input。
- Mouse Emulation 事件顺序严格 down → move* → up。

### Phase 4：multi-window layout

目标：实现稳定 focus-plus-rail 平铺。

任务：

1. 新建纯函数 RemoteWindowLayoutPlanner。
2. 支持 single、focus-plus-rail、focus-plus-grid。
3. 默认最多 3 个 child rail + 1 个 focus。
4. 依据 stable window id、focus、explicit selection 生成稳定顺序。
5. 加入 orientation、display bounds、minimum readable size、aspect ratio。
6. 处理 minimized、zero-size、off-screen、invalid crop 为显式诊断。
7. layout generation 只在实际布局事实变化时递增。
8. client 只消费 daemon layout；删除 client-side canvas reconstruction。
9. 真实 AppKit marker windows 做 add/remove/move/resize/focus pixel oracle。

退出条件：

- 3+1 layout 视觉正确。
- 窗口刷新不会无故改变其他 slot。
- resize/focus/move 后 source/canvas/input mapping 一致。
- stale generation 被拒绝。

### Phase 5：去除 screenshot loop

目标：overview WebRTC 成为连续 sibling preview 唯一来源。

任务：

1. thumbnail 从 overview video crop 生成。
2. screenshot 仅保留显式按钮。
3. 删除自动 sibling screenshot refresh。
4. 增加 60 秒 no-screenshot-loop live gate。
5. 统计 stream/capture/screenshot/control message 数量。

退出条件：

~~~text
multi-window 60s:
  screenshotRequests == 0
  streamStartCount <= 2
  streamStopCount <= 2
  no frozen thumbnail
~~~

### Phase 6：WebRTC 媒体优化

目标：减少 CPU、复制、延迟和掉帧。

任务顺序：

1. 建立 capture→render timing trace。
2. 为 focus/overview 建 bounded latest-frame queue。
3. focus 优先，overview 可降帧。
4. 消除重复 capture 和多余 Buffer copy。
5. 验证 native compositor。
6. 验证 VideoToolbox H.264/HEVC 实际接入方式。
7. 验证 encoded frame 是否能接当前 WebRTC sender；不能则形成明确 native sender 方案。
8. ROI 只在 capability probe 成功后启用；当前 Mac/SDK ROI 不可假设可用。
9. 做 weak-network/ABR 测试，质量 ACK 与 capture cadence 一起变更并可回滚。

退出条件：

- 无无限 frame backlog。
- frame drop、capture fps、encode fps、render fps 可观测。
- focus 切换不重启 overview。
- bitrate/cadence update 不重建 peer/transport。
- 弱网降级和稳定恢复有正反证据。

### Phase 7：安装版和真实环境收口

目标：交付级闭环。

必须验证：

1. Mac generic app-window。
2. iTerm2 pane。
3. tmux-backed pane。
4. LAN/direct。
5. Tailscale。
6. Relay/cellular。
7. Screen Recording permission missing。
8. Accessibility permission missing。
9. covered/background window。
10. Android real device WebView。
11. foreground/background。
12. close/reopen。
13. native process cleanup。

交付证据：

- installed daemon identity
- installed APK identity
- SDP/ICE/track role evidence
- rendered pixel oracle
- continuous frame evidence
- touch/input marker evidence
- layout generation evidence
- quality ACK/ABR evidence
- process/RSS/CPU snapshot
- exact cleanup snapshot

## 6. 文件责任表

| 责任 | 目标 owner | 关键文件 |
| --- | --- | --- |
| media contract | shared.contract | packages/shared/src/connection/protocol.ts、android/src/lib/types.ts |
| receiver | client.remote_window_media | android/src/lib/remote-window-receiver-runtime.ts |
| message routing | client.remote_window_transport | android/src/lib/remote-window-message-runtime.ts |
| session lifecycle | client.remote_window_session | android/src/contexts/session-context-remote-window-runtime.ts、新 controller |
| projection | client.remote_window_overlay | android/src/components/terminal/RemoteWindow* |
| gesture | client.remote_window_touch_action | android/src/lib/remote-window-touch-action-runtime.ts |
| daemon facade | daemon.remote_window_stream | android/src/server/remote-window-stream-daemon.ts |
| capture | daemon.remote_window_capture | android/src/server/remote-window-capture.ts、native capture source |
| layout | daemon.remote_window_layout | android/src/server/remote-window-canvas-layout.ts、新 planner |
| quality | daemon.remote_window_quality | android/src/server/remote-window-quality.ts |
| input | daemon.remote_window_input | android/src/server/remote-window-input-policy.ts、helper |
| lifecycle cleanup | daemon.remote_window_session | android/src/server/remote-window-stream-session.ts |
| architecture docs | governance | android/docs/resource-map.md、registry、function/mainline/test design |

## 7. 验证矩阵

| 层级 | 必须证明 |
| --- | --- |
| pure unit | media plan、layout、gesture、quality、mapping |
| protocol integration | SDP m-line、track role、ICE、status/error |
| daemon native | capture、sender、continuous frames、cleanup、no SIGSEGV |
| client component | projection、toolbar、fullscreen、IME、no screenshot loop |
| architecture | owner、import edge、control/payload isolation、no fallback |
| build | type-check、Android build、daemon build/package |
| live Mac | AppKit marker、ScreenCaptureKit、input、pixel oracle |
| live Android | installed WebView video、touch、layout、foreground/background |
| network | direct、Tailscale、Relay/cellular、weak network ABR |
| cleanup | peer、capture child、ports、temporary windows、sessions |

## 8. 失败处理规则

- P0 失败：停止后续 phase，回到唯一 owner 修复。
- 同一假设连续两次被证伪：停止原路径，重新检查真实 runtime、协议和安装版本。
- 测试通过但 live gate 失败：以 live gate 为准，不宣称完成。
- review 前必须完成 build、install/restart、真实样本和 cleanup。
- 禁止通过增加 timeout、吞 error、伪造 track、截图/旧视频/terminal buffer 兜底来“修复”。
- 任何代码修复后，旧的 startup、layout、touch、WebRTC 和 live 证据全部失效，必须重跑受影响闭环。

## 9. Definition of Done

整改只有在以下条件全部满足后才算完成：

1. P0 single/composite 启动问题有 root-cause test 和真实设备证据。
2. owner 拆分落地，function/mainline/module/edge docs 与代码一致。
3. Direct Touch / Mouse Emulation contract 和正反测试一致。
4. focus-plus-rail 多窗口布局通过真实 marker pixel oracle。
5. screenshot loop 物理移除并有 no-loop evidence。
6. WebRTC timing/backpressure/quality evidence 完成。
7. direct/Tailscale/Relay/cellular 中要求的路径完成验证或明确记录外部阻塞。
8. installed daemon/APK 与验证源码一致。
9. native process、peer、capture、temporary window、test session 无遗留。
10. DSH Review 在所有前置验证完成后通过；若 DSH 明确 unavailable，按项目规则执行接管 review。
