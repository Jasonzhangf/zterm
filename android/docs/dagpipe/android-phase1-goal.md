# Android DAGpipe Phase1 Goal

```text
/goal
目标：按已审批的 Android DAGpipe Phase0 四张静态图完成 Rust core 实现、黑盒测试、接线并重启验证；不得停留在源码或候选证据。

范围与约束：
- 依据：android/docs/dagpipe/android-phase0-design-slice.md、android/docs/dagpipe/README.md、android/docs/dagpipe/android-dag-approval.html、dagpipe-runtime skill。
- 必须从最新 origin/main 建独立 clean worktree；保留既有 dirty 工作区，不覆盖他人变更。
- 允许改动：新增 Rust crate 与 Cargo.toml pipeline_runtime 绝对路径依赖；注册 android.connection_lifecycle、android.buffer_management、android.buffer_render、android.input_dispatch 对应 Operators；按 Phase0 设计切片完成状态机、角色、终态/释放边界；增加 SDK compile() 合同/effect 检查；补黑盒 parity 测试；接线为薄 bridge 到现有 Android client；影响 daemon/client 时重建并重启受影响 runtime。
- 禁止：改 daemon runtime 与 wire protocol；在 parity gate 通过前删除旧 TS 实现；静默 fallback；把静态图通过冒充 runtime 接线；未经授权发布 APK/OTA/merge/push。
- 保留 Android 现有架构边界：一个 daemon 目标一条物理连接，多 session 为逻辑通道；每 session buffer/revision/repair 独立；只有完整无洞 frame 可 sparse apply 并触发 render；repair 未写 wire 不 dispatched；inactive 不关 transport 不清 buffer；hidden pane 不保留 renderer 实例。

验收：
- dagpipe graph validate / inspect 通过全部 6 张图；pnpm --dir android test:dagpipe-phase0 通过。
- Rust crate cargo check --offline、cargo test 通过；compile() 对每个 Phase0 Operator 能解析并校验 ARC/effect 契约。
- 为每个 Operator 提供黑盒 parity 测试，证明输入输出与当前 TS 语义一致；覆盖连接建立/恢复、单 session/多 session 通道隔离、buffer frame 原子 apply、repair ledger、render scope、输入可靠队列。
- 接线后实际入口复测：现有 Android client 经薄 bridge 走 Rust core，旧 TS 实现保留至 parity gate 通过；daemon/client 重建并重启后 health/runtime 版本证据指向已验候选。
- 有在线 Android 设备时安装/启动/真机 smoke；无设备时明确 L5 缺口，不以候选 APK 或源码测试冒充设备验收。
- 独立架构 review 取得 PASS 后才允许 merge；merge 前复查 origin/main，若变化则更新候选并重跑受影响验证；merge/push 证据记录 candidate SHA、merge SHA、push 回执。
- 清理本轮新增临时 worktree、日志、forward、进程和 artifact；不得删除既有资源或他人进程。
```
