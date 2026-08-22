# Remote Window Stream 综合审计

日期：2026-08-22  
范围：Android remote-window overlay、daemon capture、WebRTC media、touch/input、multi-window canvas/layout、生命周期和验证链路  
基线：b47e9f72 refactor(remote-window): split streaming owners  
审计类型：只读代码、架构文档、测试与本地命令审计；本次未修改产品代码。

## 1. 结论

当前串流不能启动，首要根因不是网络，而是 client/server 的媒体轨道契约不一致：Android 对普通 app-window 等待 focus + overview 两条视频轨道，daemon 对普通单窗口只发送 focus 一条轨道。receiver 因此一直等待第二条轨道，直到 25 秒超时清理。

同时存在四类结构性问题：

1. remote-window 已做模块拆分，但 RemoteWindowOverlayController 仍有 3,078 行，生命周期、WebRTC、focus handoff、手势、输入、截图、布局投影和 UI 编排仍高度耦合。
2. touch 行为和最新设计不一致：代码把 Direct Touch 单指拖动识别成 realtime scroll；最新 contract 要求双指 scroll/pinch、单指 click/gesture、zoom 后单指 local pan。
3. 多窗口布局当前只是固定 1920×1080 横向串接，不是稳定的 focus-plus-rail / “3 小 1 大”布局，也没有完整处理窗口排序、最小可读尺寸、屏幕方向、窗口变化和布局代际。
4. WebRTC 仍走 ScreenCaptureKit RGBA stdout → Node Buffer → I420 conversion → RTCVideoSource，并且组合流叠加 screenshot thumbnail 请求，存在 CPU、内存复制、capture 竞争和帧背压风险。

当前不能宣称“串流可用”。本地纯逻辑 targeted tests 通过，但真实 Android WebView、安装版 daemon、Relay/蜂窝路径、连续视频帧和输入回放仍未闭环。

## 2. 证据基线

### 2.1 启动失败直接证据

Android receiver：

- 普通 app-window 也设置 needsOverview = true：android/src/lib/remote-window-receiver-runtime.ts:238-240
- needsOverview 时添加第二个 recvonly video transceiver：android/src/lib/remote-window-receiver-runtime.ts:257-260
- waitForRequiredTracks 要求 focus 和 overview 都到达：android/src/lib/remote-window-receiver-runtime.ts:145-162
- track 超时为 25 秒：android/src/lib/remote-window-receiver-runtime.ts:19

daemon：

- 普通 stream 只创建一个 video source/sender：android/src/server/remote-window-stream-daemon.ts:475-485
- overview sender/capture 只在 compositeWindows 非空时创建：android/src/server/remote-window-stream-daemon.ts:558-565、594-628

实际路径：

~~~
Android 创建 2 recvonly transceiver
  -> daemon 只添加 1 sendonly video track
  -> Android 等待第二个 overview track
  -> 25 秒 receiver timeout
  -> cleanup
  -> UI 显示视频流启动失败
~~~

### 2.2 本地验证结果

执行：

~~~
pnpm --dir android exec vitest run \
  src/lib/remote-window-receiver-runtime.test.ts \
  src/lib/remote-window-touch-action-runtime.test.ts \
  src/server/remote-window-canvas-layout.test.ts \
  src/lib/remote-window-boundary-truth.test.ts \
  --reporter dot
~~~

结果：4 files passed，38 tests passed。

包含 daemon WebRTC native 测试的组合命令先通过测试输出，随后 Vitest 进程被 @roamhq/wrtc native teardown 以 SIGSEGV 终止。该结果不能作为完整绿灯；需要单独进程、fork/single-fork 或独立 integration runner 验证 native peer 生命周期。

### 2.3 代码规模

| 文件 | 行数 | 风险 |
| --- | ---: | --- |
| android/src/components/terminal/RemoteWindowOverlayController.tsx | 3,078 | UI、生命周期、媒体、输入、手势、质量、截图、布局集中编排 |
| android/src/lib/remote-window-touch-action-runtime.ts | 1,557 | 手势状态机、坐标转换、scroll/pinch、事件构建和 dispatch 混合 |
| android/src/server/remote-window-stream-daemon.ts | 1,045 | daemon facade 仍承担 capture、peer、quality、layout、input、cleanup |
| android/src/lib/remote-window-message-runtime.ts | 655 | catalog、stream、ICE、status、quality request/response 集中 |
| android/src/server/remote-window-capture.ts | 495 | native child、binary frame、capture update、cleanup 混合 |

## 3. 问题清单

### P0-1：single/composite track contract 不一致

症状：普通 app-window 永远等待 overview track。  
根因：client 根据 videoTarget.kind 判断双流，daemon 根据 compositeWindows 判断双流。两端没有共享 typed stream mode。  
影响：所有普通 app-window stream 启动阻断。  
整改：增加显式 streamMode / mediaPlan contract。推荐：single app-window = focus-only；composite app-window = overview + focus。client transceiver 数量、daemon sender 数量、track role、started payload 必须由同一个 mode 决定。  
禁止：把 focus track 伪装为 overview、延长 timeout、截图兜底、terminal buffer 兜底。

### P0-2：没有真实两端 SDP/track integration gate

现有测试分别验证 receiver、daemon 和 message runtime，没有验证 Android offer 与 daemon answer 的 m-line 数量、方向、track role 和第一帧一致。  
整改：增加 single/composite 两组真实 peer integration test；同时验证 SDP、track count、first frame、连续至少 3 帧和 stop cleanup。

### P1-1：启动阶段过长且错误信息不具备阶段语义

daemon 在返回 started 前串行执行 target validation、peer 创建、capture startup、helper warm、overview capture、answer、bitrate apply。client timeout、capture timeout、receiver track timeout 叠加后，用户只能看到模糊 timeout。  
整改：引入 typed startup stage：validating、peer-ready、capture-starting、capture-ready、answer-ready、track-negotiating、streaming；错误必须包含 stage 和 cause。

### P1-2：WebRTC native teardown 会 SIGSEGV

daemon 测试组合运行时出现 @roamhq/wrtc native SIGSEGV。  
整改：native integration tests 单进程隔离；严格停止 capture/source/sender/peer/timer；增加 active peer、source、child process 计数和 afterAll assertion。纯逻辑测试与 native media 测试分离。

### P1-3：OverlayController 仍是超级编排器

RemoteWindowOverlayController.tsx 同时拥有 stream lifecycle、WebRTC playback、focus switch、touch recognizer、input dispatch、quality、screenshot、fullscreen、IME、catalog 和 UI。拆分后的 hook 仍通过大量 refs 共享隐式状态。  
整改：形成 Session、Media、Focus、Input、Gesture、Projection 六个 owner；跨 owner 只传 typed intent/result，不传 peer、socket、DOM ref 或可变隐式状态。

### P1-4：Direct Touch 语义与最新 contract 冲突

当前代码在 touchMode 下把单指触控拖动转成 realtime scroll；最新设计要求双指 scroll/pinch，单指 tap/click 或 release-time gesture，zoom 后单指 local pan。controller 和 runtime 还共同参与 long-press/gesture 仲裁。  
整改：只保留一个 gesture recognizer owner；Direct Touch 与 Mouse Emulation 分开；增加正反测试，锁住不误触发 click、scroll、pointer drag、pinch 和 stale action。

### P1-5：多窗口布局不是 focus-plus-rail

android/src/server/remote-window-canvas-layout.ts 固定 1920×1080，所有窗口从 x=0 横向排列，按数组顺序串接，没有“3 小 1 大”、稳定 slot、最小可读尺寸、方向和屏幕覆盖处理。  
整改：新建纯函数 RemoteWindowLayoutPlanner，默认 focus-plus-rail，最多 3 个 sibling 小窗口，focus 占据主区域；输出 canvas size、source rect、canvas rect、z-order、focus rect、generation 和 diagnostics。

### P1-6：client screenshot thumbnail loop 与 WebRTC canvas 真相冲突

RemoteWindowOverlayController 和相关测试仍会为 sibling thumbnail 调用 remote screenshot。canvas pipeline contract 明确禁止 screenshot refresh loop 作为连续媒体源。  
整改：overview video 直接生成 thumbnails；screenshot 只保留显式按钮；加入 60 秒 no-screenshot-loop gate。

### P1-7：RGBA stdout → I420 conversion 复制链路重

当前路径是 ScreenCaptureKit 输出 RGBA，经 stdout/Buffer/Uint8Array 后逐帧 rgbaToI420，再推给 RTCVideoSource。focus+overview 还可能启动两套 capture。  
整改顺序：先建立 timing/backpressure 证据，再做 bounded latest-frame queue、focus 优先、overview 可降帧、重复 capture 消除，最后验证 native compositor/VideoToolbox encoded path。ROI 只能在 capability probe 成功后启用。

### P1-8：source/canvas/video 三套坐标缺真实矩阵证明

代码已将 layout generation 纳入 composite input，但缺少真实 marker window 对四角、边界、aspect-fit、zoom、resize、stale generation 的端到端验证。  
整改：daemon 唯一负责 source/canvas mapping；Android 只消费 layout；用真实 AppKit marker window 验证映射和 stale rejection。

### P2-1：文档、registry、test design 状态不一致

single/composite 双流规则、Direct Touch 规则、canvas raw/encode 资源状态存在冲突。  
整改：先统一 active contract，再同步 decision、resource registry、function map、mainline call map、test design；design 状态不得当作 active 实现。

### P2-2：运行态闭环尚未完成

未完成 Android 真机 rendered-pixel、installed daemon identity、Relay/cellular ICE、iTerm2 pane video/input、连续帧、进程 cleanup 和弱网质量证据。  
整改：所有整改必须以真实安装版本、真实 daemon、真实设备和真实 target replay 收口。

## 4. 架构目标

~~~
RemoteWindowFeatureRoot
├── RemoteWindowSessionController
│   ├── catalog
│   ├── target lock
│   ├── stream lifecycle
│   └── foreground/background
├── RemoteWindowMediaController
│   ├── peer / SDP / ICE
│   ├── track-role binding
│   ├── frame readiness
│   └── stats
├── RemoteWindowFocusController
│   ├── focus revision
│   ├── overview crop
│   └── focus handoff
├── RemoteWindowInputController
│   ├── typed action dispatch
│   ├── layout generation
│   └── daemon result
├── RemoteWindowGestureController
│   ├── Direct Touch
│   ├── Mouse Emulation
│   ├── pinch
│   └── local pan
└── RemoteWindowProjection
    ├── picker
    ├── toolbar
    ├── video surface
    ├── fullscreen
    └── diagnostics
~~~

唯一控制链：

~~~
Projection -> intent
Gesture -> action record
Input -> session transport
Media -> WebRTC peer
Session -> lifecycle
Daemon -> catalog/layout/capture/input/cleanup truth
~~~

禁止：UI 直接操作 RTCPeerConnection、gesture 直接写 socket、Android 重算 macOS global coordinate、daemon facade 重新实现 layout、screenshot 作为视频流隐式补偿。

## 5. 审计后的最终判定

当前状态：不可交付。

阻断项：

1. P0 single/composite track mismatch。
2. 无真实 client/server startup integration gate。
3. native WebRTC test teardown 不稳定。
4. 无 Android installed/live rendered-pixel proof。

非阻断但必须在同一整改中收口：

1. owner 拆分。
2. touch contract 统一。
3. focus-plus-rail 布局。
4. screenshot loop 删除。
5. frame queue / encode / WebRTC timing 优化。

完成前不得对外宣称“串流已恢复”“WebRTC 已优化”或“多窗口平铺已完成”。
