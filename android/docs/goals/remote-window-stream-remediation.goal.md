# Remote Window Stream 云端整改 Goal

~~~text
/goal
目标：按 android/docs/goals/remote-window-stream-remediation-plan.md 完成 remote-window 串流整改，先恢复 single/composite 启动契约，再完成模块拆分、通用 touch、focus-plus-rail 多窗口布局和 WebRTC 性能优化。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：
- android/docs/audits/2026-08-22-remote-window-stream-comprehensive-audit.md
- android/docs/goals/remote-window-stream-remediation-plan.md
- android/docs/decisions/2026-07-19-remote-window-stream-truth.md
- android/docs/decisions/2026-07-29-remote-window-canvas-pipeline.md
- android/docs/decisions/2026-08-09-remote-window-dual-stream-design.md
- android/docs/testing/remote-window-stream-test-design.md
- android/docs/testing/remote-window-canvas-pipeline-test-design.md

执行规范：
- 先修 P0：显式 single-focus / overview-plus-focus media plan；client transceiver、daemon sender、SDP、track role 必须同契约，禁止 timeout 或 screenshot/terminal fallback。
- 先查 resource/function/mainline/module/edge maps，再改唯一 owner；控制语义走 typed side-channel，不混入业务媒体 payload。
- 拆分 Session、Media、Focus、Input、Gesture、Projection owner；UI 不直接碰 RTCPeerConnection，gesture 不直接写 socket，Android 不计算 macOS global coordinate。
- Direct Touch 使用单指 click/gesture、双指 scroll/pinch、zoom 后 local pan；Mouse Emulation 使用 down/move/up；删除重复 recognizer。
- 多窗口默认 focus-plus-rail；overview video 是 thumbnail 唯一连续来源；禁止 screenshot loop、terminal buffer fallback、静默降级。
- WebRTC 先做 timing/backpressure/cleanup，再做 native compositor/VideoToolbox capability verification；ROI 不得假设存在。

验证：
- 定向 unit/protocol/native integration tests，覆盖 single/composite、track mismatch、stale/error/cleanup、touch 正反、layout generation、quality ACK。
- type-check、Android build、daemon build/package；native WebRTC 测试必须隔离进程并无 SIGSEGV。
- 安装版 daemon + Android 真机 rendered-pixel/连续帧/触控输入验证；Mac AppKit marker、ScreenCaptureKit、iTerm2/tmux、direct/Tailscale/Relay/cellular、弱网和 cleanup 验证。
- 所有验证完成后才进行架构 review/DSH Review；源码、安装版本和 evidence 必须一致。

完成标准：
- 普通 app-window 可启动并持续显示视频；composite stream 两条 track 角色正确。
- touch 行为符合 contract；focus-plus-rail 平铺和 source/canvas/input 映射稳定。
- no screenshot loop；WebRTC frame queue、质量、延迟、掉帧和资源清理有证据。
- 所有 P0/P1 关闭；剩余限制写入 evidence 和文档；未验证项不得宣称完成。
~~~
