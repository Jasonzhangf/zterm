/goal

目标：按 `android/docs/goals/terminal-physical-boundary-closeout-plan.md` 完成 zterm terminal 主链物理边界收口、审计后半段闭环验证，并按保护规则 commit、merge 到 `main`、push。

说明：这是最终执行任务，不需要再生成新的提示词；详细方案、owner、文件、阶段、测试矩阵和 DoD 以实现文档为唯一真源。

实现文档：
`android/docs/goals/terminal-physical-boundary-closeout-plan.md`

执行位置：
`playground/tbc-closeout-0905`

执行规范：
- 从当前最新 `origin/main` 开始；保护主 checkout dirty、其他 worktree 和 `../wterm`。
- 先完成 architecture/resource/module/edge/function map 与唯一 owner 对齐，再按红测→最小实现→正反测→真实入口复测执行。
- 收口 range publisher、physical budget/fairness、backend input queue、mirror/adaptive width、renderer window、mux、frame/repair/generation/trace、control idempotency；不新增第二套真源、fallback 或 lifecycle。
- 控制面与 terminal/file/media body 物理隔离；input wire 保持 string-only；失败显式暴露。
- L0-L5 分层报告，低层证据不得冒充高层；无设备/权限/服务时保留 blocker。
- exact candidate HEAD review PASS 后才能 commit；再走 protected integration merge 到 `main`、push 和远端 receipt。

验证：
- 定向正反测试、feature/import/forbidden/type gates、`git diff --check`。
- daemon/tmux close-loop、Mac client test/type-check、适用 Android/L4/L5/packaged/device gate。
- AGY review PASS、candidate/merge/push receipt、candidate ancestry、`git branch --contains`、`git ls-remote origin refs/heads/main`。

完成标准：
- 计划中的适用阶段全部完成，缺失层级和真实 blocker 明确记录。
- 代码与 maps/docs/tests 的唯一 owner 一致，TerminalView 不再拥有 renderer window 真相。
- candidate 已 review/commit，受保护地 merge 到 `main` 并 push；最终报告包含 candidate SHA、merge/PR receipt、远端 main SHA、L0-L5 证据和剩余风险。
