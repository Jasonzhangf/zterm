# Android DAGpipe 整体实现 Goal

```text
/goal
目标：按 android/docs/dagpipe/remaining-modules-plan.md 和 android/docs/dagpipe/android-remaining-plan.html 完成整体 DAGpipe 改造：先跑通已审批核心 Rust core，再按 Phase2-8 逐切片完成静态 DAG、中文语义设计、SDK compile()、黑盒 parity、薄 bridge 接线、重建重启验证和独立 review。不得停留在源码、静态图或候选证据。

范围与约束：
- 依据：remaining-modules-plan.md、android-remaining-plan.html、android-phase0-design-slice.md、android-phase1-goal.md、dagpipe-runtime skill、module/function/resource maps。
- 必须从最新 origin/main 建独立 clean worktree；保留既有 dirty 工作区，不覆盖他人变更，不 revert/reset/checkout 清理他人文件。
- Phase1 先执行已审批 6 张图的 Rust core：Operator 注册、compile() 合同/effect 校验、black-box parity、薄 bridge、重建/重启验证；这是后续切片的依赖基础。
- Phase2-8 每个切片必须先完成静态治理（graph JSON + 中文语义设计切片 + dagpipe graph validate/inspect + 独立 review PASS），再进入 Rust core/parity/接线；禁止把静态图通过冒充 runtime 接线。
- 允许改动：新增 Rust crate 与 pipeline_runtime 绝对路径依赖；按各 Phase 图注册对应 Operators；增加状态机、角色、终态/释放边界；补黑盒 parity 测试；接线为薄 bridge 到现有 daemon/client；影响 daemon/client 时重建并重启受影响 runtime。
- 禁止：改 wire protocol 语义；在 parity gate 通过前删除旧 TS 实现；静默 fallback；双路径补偿；把控制真源写入 payload；未经授权发布 APK/OTA/merge/push；用候选 APK 或源码测试冒充 L5 设备验收。
- 遵守跨切片不变量：同一 daemon 目标一条物理连接，多 session 为逻辑通道；每 session buffer/revision/repair 独立；只有完整无洞 frame 可 sparse apply 并触发 render；repair 未写 wire 不 dispatched；inactive 不关 transport 不清 buffer；hidden pane 不保留 renderer 实例；daemon 不持有客户端活跃/foreground/viewport truth；Relay/peer lease 不存终端正文、channel、tmux、active tab 或 UI truth；release/update 必须消费已验证 runtime artifact；debug 只观测元数据。

Phase 顺序：
1. Phase1：核心 6 图 Rust core 执行。
2. Phase2：Relay/daemon 连接通道/会话目录（relay-account-peer-route、daemon-connection-channel-catalog）。
3. Phase3：Daemon 输入/调度/文件截图/附件（daemon-input-schedule、file-transfer-attachment-screenshot）。
4. Phase4：Remote window 流（remote-window-stream-overlay）。
5. Phase5：Session/shell/preview UI 业务边（android-session-shell-preview）。
6. Phase6：Plugin/control/settings/config share（android-control-plugin-settings）。
7. Phase7：Release/update/observability（release-update-observability）。
8. Phase8：Android 原生连接服务（android-connection-service）。

每个 Phase 交付：
- 静态治理面：中文业务语义 .graph.json；dagpipe graph validate/inspect 通过；中文设计切片含身份/角色、事件、状态机（终态/非法转移）、DAG/数据契约、变更边界、单/多 session 解释；扩展测试:dagpipe gate 通过；独立 review PASS。
- 运行时接线面：Rust/crate Operator 注册；compile() 校验 ARC/effect contract；黑盒 parity 覆盖当前 TS 语义；薄 bridge 接入现有入口并保留旧 TS 至 parity 通过；重建、安装/重启受影响 daemon/client，health/runtime 版本指向已验候选；适用设备在线时真机 smoke，无设备时明确 L5 UNVERIFIED。

验收证据：
- 所有新增 graph validate/inspect 通过；扩展后的 dagpipe gate 通过；Phase0 原有 6 图继续通过。
- cargo check --offline 和 cargo test 通过；compile() 对每个 Phase Operator 能解析并校验 ARC/effect 契约。
- 每个 Operator 有黑盒 parity 测试，覆盖：连接建立/恢复、单/多 session 通道隔离、buffer frame 原子 apply、repair ledger、render scope、输入可靠队列、daemon channel/catalog、input/schedule/file/attachment/screenshot、remote window、preview/shell、plugin/control/settings、release/update/observability、Android 原生连接服务。
- 接线后实际入口复测；受影响 daemon/client 重建并重启，health 与 runtime 版本证据绑定已验候选 SHA。
- 独立架构 review 在每一切片运行时面完成前取得 PASS；merge 前复查 origin/main，若有新提交则更新候选并重跑受影响验证与 review；merge/push 记录 candidate SHA、merge SHA、push 回执。
- 清理本轮新增临时 worktree、日志、forward、进程和 artifact；不得删除既有资源或他人进程。
```
