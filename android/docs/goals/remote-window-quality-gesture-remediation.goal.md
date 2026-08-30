/goal
目标：完整修复 Android remote-window 串流的质量控制、清晰/流畅 profile、1×/zoom 手势、输入背压和视频绘制延迟，使质量切换不重启 capture，原始大小与放大状态都可实时流畅操作。

说明：这是最终执行任务，不需要再为同一任务生成新的提示词，直接按实现文档执行。

实现文档：
android/docs/goals/remote-window-quality-gesture-remediation-plan.md

执行规范：
- 继续使用已声明 worktree `/Volumes/extension/code/zterm/playground/remote-window-quality-gesture-plan-20260829` 和分支 `codex/remote-window-quality-gesture-plan-20260829`；由 master 单独执行，不派发 sub-agent，不新建或复用其他问题 worktree，不覆盖、恢复、暂存或提交主 tree 及其他 worktree 的 dirty 改动。
- 严格按 MemoryPalace → resource/module/edge registry → function map → mainline call map/source → verification map → 源码的顺序确认唯一 owner；先同步 ADR、maps、test design、SOP、feature gates 和 local skill，再写红测与 runtime。
- 质量、输入、媒体、telemetry/control 物理分层；禁止 fallback、截图/terminal buffer 冒充视频、控制语义混入业务 payload、重复实现、stop/start capture 质量切换，以及 retained legacy 双路径。
- 按设计文档 Phase 0–6 顺序完成；每个 phase 在 clean worktree 通过边界自检和定向 gate 后才能进入下一阶段。设计阈值若与真实证据冲突，只能用同 owner 的受控 A/B 数据修订文档与测试，不能凭感觉调参。
- runtime 完成后生成并安装全局 daemon，service-scoped restart，构建并保数据覆盖安装 Android APK；从 active profile/endpoint truth 验证真实 direct/Tailscale/Relay 路径。禁止 TCC reset、broad kill、卸载/清应用数据和未授权 OTA/public Relay 发布。

验证：
- 架构/registry/import/mainline gates、shared contract、quality/capture/input/gesture/render 正反测试、type-check、canonical build、Android build。
- raw + mux + 当前实际 route 的 Mac AppKit marker video/input probes；质量切换零 capture restart、120Hz 输入合并、长 drag/cancel release、1×/2×坐标、frame-age 与 canvas draw cadence 量化验证。
- installed daemon SHA/PID/uptime、在线 Android APK/CDP/ADB、foreground resume、exact cleanup 和两个 profile 的真实 A/B。
- 所有安装态/live gate 通过后运行 AGY Review MCP；controller PASS 后检查 staged 范围，定向 commit/push。review 后改代码必须重跑受影响验证、安装/live gate 和新 review。

完成标准：
- “流畅优先”成为默认，“清晰优先”可选；cause-specific ABR、小步升降、interaction burst、single-flight/latest-wins 和 no-op 生效，码率/FPS/profile 切换不 stop/start SCStream、不出现黑帧。
- 1× 与 zoomed 单指实时远端滚动；zoomed 双指本地 pan；pinch、hold-drag、右键、5 秒手势和 pointercancel 均正确；连续输入 ≤45 条/s、队列 ≤2，可靠 release/key/click 不丢不重。
- focus canvas 一张 decoded frame 最多 draw 一次；运行期 capture/convert latest-frame；流畅 profile 达到 1280-long-edge@45、p95 frame age ≤100ms，清晰 profile 达到 1920-long-edge@30、p95 ≤180ms，或按实现文档完成唯一 native media path 并物理删除旧 production raw path。
- maps/docs/tests/skill 与 active runtime 一致，真实 Mac + installed daemon + Android 设备闭环，AGY Review PASS，change set 已定向提交并推送；未获授权时不发布 OTA stable/public Relay assets。
