# DAGpipe 图审计与消融结论（2026-09-26）

状态：审计 + 决策已批准，候选 worktree 执行 relay 前缀收敛与连接生命周期边界修正。
relay 登录/发布已固定为 `client.relay_account.login` /
`client.relay_account.publish_device`；独立 relay 图仍需等待
`android.connection_lifecycle` 完整消费 `arc.route_plan` / `arc.resume_plan`
并通过 phase2 parity 后再删除。

连接生命周期已完成消融：它只消费上游 route plan / resume plan，不再在
connection lifecycle 内解析候选。`client.connection.establish_transport`
必须接收 `arc.route_plan.selected.candidateId`，不再从 endpoint 推导
targetKey。

### 独立 relay 图当前保留原因（不伪装删除）

`relay-account-peer-route.graph.json` 在本次候选仍保留，因为 phase2 bridge /
TS parity 还依赖该图输出 `arc.account_directory`、`arc.validated_lease`、
`arc.resume_plan` 契约。删除它需要先把这三个输出迁入 `android.connection_lifecycle`
或新的 relay gate graph，并同步更新 `compilePhase2`、native bridge 和 TS parity
入口；当前尚未完成该迁移，所以按“若删除必须同步全部引用”的约束保留。

## 证据基准

- 候选基线：`origin/main@bfa4f66d`。
- 当前 25 张图全部 `dagpipe graph validate` / `inspect` 通过。
- 25 张图全部被 `android/native/dagpipe/src/{core,daemon_core,phase2_core,phase3_core,phase4_core,phase5_core,phase6_core,phase7_core,phase8_core}.rs` 的
  `include_str!` 引用；删除 relay 图必须同步更新 Rust include 与
  `graphs.len() >= 25` 断言。

## 消融方法

按 `dagpipe-runtime` skill 的节点粒度规则：

- 只在节点有独立 owner、独立 ARC 契约、外部 effect、独立重试/失败边界或可独立验证
  结果时才保留为独立节点。
- 相邻、无独立契约的微转换应合并，但不得把不同 owner 的路径压成同一步。
- 同一语义在不同 graph 重复建模时，先看调用入口与输出消费，再决定合并；合并后
  仍必须保持 SESE（单输入 ARC、单输出 ARC）。

## 关键重复

| 图 | 节点 | 主要重复/重叠 |
| --- | --- | --- |
| android-connection-lifecycle | 旧版 15 | 与 relay-account-peer-route 共享登录/发布/路由/绑定 |
| relay-account-peer-route | 13 | 与 android-connection-lifecycle 共享 relay 前缀 |

重复 operator：

- `login_relay_account` / `publish_client_device` 在两图中重复。
- `dagpipe.request.extract` / `dagpipe.result.collect` 是 SDK SESE 管道节点，
  不作为业务节点消融。

## 执行计划

1. `relay-account-peer-route.graph.json` 的 login/publish 绑定
   `client.relay_account.login` / `client.relay_account.publish_device`。
2. `phase2_core.rs` 改为共享 core 的 relay operator，删除本地
   `relay.account_directory.login` / `relay.account_directory.publish_device` 双实现。
3. `android.connection_lifecycle` 改为消费 `arc.route_plan` /
   `arc.resume_plan`，移除内嵌的 login/publish/resolve 前缀节点，并物理
   删除已无图绑定的 `client.connection.resolve_routes`。
4. 同步更新 Rust/TS 测试，保留 `account_directory`、`validated_lease`、
   `resume_plan` 输出契约。
5. 保持 `android.connection_service` 不复制物理连接/维持/恢复第二套 truth owner。
6. 删除 `relay-account-peer-route.graph.json` 必须等第 3、4 步完成后执行，并同步
   更新 `include_str!`、phase2 graph list、`graphs.len()` / `compilePhase2` 断言。

## 门禁

候选 worktree 内必须通过：

```sh
cargo check --manifest-path android/native/dagpipe/Cargo.toml --offline
cargo test --manifest-path android/native/dagpipe/Cargo.toml --offline --no-default-features --lib --test phase0 --test phase2
pnpm --dir android run test:dagpipe-phase0
pnpm --dir android exec vitest run src/server/dagpipe-bridge.test.ts src/lib/dagpipe-bridge.test.ts src/lib/dagpipe-phase1-parity.test.ts src/lib/dagpipe-phase28-parity.test.ts --reporter dot
```

并在 merge 前完成独立架构 review PASS、worktree 回收与临时资源清理。
