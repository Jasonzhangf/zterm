/goal
目标：完成 AppSDK 0.1.3 执行真源与 zterm active-v4 治理收尾，从 controlled_verified 推进到可验证稳定生命周期；当前候选 HEAD 为 5197b38，base 为 91f69b2。

说明：这是最终执行任务，不需要再为同一任务生成新的提示词，直接按实现文档执行。

实现文档：
- android/docs/goals/appsdk-0.1.3-active-v4-plan.md
- android/docs/debug/2026-08-16-appsdk013-final-gate-fix-design.md

执行规范：
- 先核对 exact HEAD、maps、AppSDK records、.agent-collab claim 与授权门禁；证据只绑定最终 committed HEAD。
- 只使用与 sdk.lock 匹配的 AppSDK 0.1.3 官方 CLI；禁手工改 active/protected/generated/sdk.lock。
- 不做 fallback、双真源或输出层补偿；review 后任何变更都使旧 PASS 失效，必须重跑受影响验证与 DSH。
- DSH 固定使用 opencode-go/deepseek-v4-flash，必须对 clean committed exact final HEAD 明确 PASS；FAIL 不能当作 unavailable 绕过。
- 未获授权不执行 merge/freeze/publish/OTA/cleanup；只记录 pending_authorization。

验证：
- AppSDK direct verify、clean detached verify、binary/sdk.lock SHA
- focused regression、feature registry、tsc、prebuild/build、架构 gates
- record graph 完整且 artifact/current pointer/source hash 一致
- 安装、重启及在线真实样本验证后执行 DSH Review

完成标准：
- main 唯一使用 AppSDK 0.1.3 + active-v4，无 stale 双真源
- active-v4 通过官方生命周期，真实 artifact/current pointer/完整 record graph 一致
- exact final HEAD 的全部 gates、在线验证和 DSH Review 均 PASS
- 未授权动作明确 pending，不把 controlled_verified 误报为已完成
