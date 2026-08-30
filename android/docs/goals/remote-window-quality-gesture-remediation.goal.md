/goal
目标：完整完成 remote-window 清晰/流畅策略、手势、输入背压和帧投影修复。

说明：这是最终执行任务，不需要再写新的提示词，直接按实现文档执行。

实现文档：
android/docs/goals/remote-window-quality-gesture-remediation-plan.md

执行规范：
- 当前独立 worker 只在 `/Volumes/extension/code/zterm/playground/rwqg-0830`、`codex/rwqg-0830` 执行，不派发 sub-agent，不触碰主 tree 或其他 worktree 的 dirty 改动。
- 严格服从文档中的架构 owner、阶段顺序、正反测试和控制/业务 payload 隔离。
- 禁止 fallback、双 production path、capture stop/start 质量切换、TCC reset、broad kill、清应用数据和未授权 OTA/public Relay 发布。

验证：
- 完成源码正反测试、架构门禁、type-check、canonical/Android build。
- 完成 daemon release/install/service-scoped restart、installed identity、Mac/Android 当前实际 route A/B；随后取得 AGY Review PASS。

完成标准：
- 以 Collab task evidence、AGY Review PASS、定向 commit/push 和远端 commit 一致为完成信号。
