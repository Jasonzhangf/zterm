# AppSDK 0.1.3 active-v4 收尾实现计划

Plan ID: `GOAL-20260816-APPSDK013-ACTIVE-V4`

## 1. 目标与验收标准

目标：完成 AppSDK 0.1.3 migration 的 active-v4 收尾，使 `main` 唯一使用
`0.1.3 + active-v4`，并关闭已授权的 L5/OTA/cleanup 尾项。

验收标准：

1. active-v4 生命周期记录完整且绑定真实 clean HEAD：
   - commit/tree hash
   - artifact hash
   - public API hash
   - scope hash
   - regression report
   - promotion record
   - freeze record
   - final review record
2. `appsdk verify android` 返回 `ok:true`，且验证所用 binary 是 0.1.3 且与
   `.appsdk/sdk.lock` 匹配。
3. 聚焦回归 8 files / 297 tests / 0 skipped 全绿。
4. feature registry 92/92 全绿。
5. `pnpm run prebuild`、`pnpm run build`、`tsc --noEmit`、module/edge/DAG gates
   全绿。
6. 在干净 detached worktree 上重跑 `appsdk verify android` 仍为 PASS。
7. DSH final review 对 exact frozen/published HEAD 返回明确 PASS。
8. main 唯一使用 0.1.3 + active-v4，无 stale active-v2/0.1.2 双真源。
9. OTA/playground cleanup 等不可逆动作仅在 Jason 明确授权后执行；否则保持
   `pending_authorization` 且写入完成报告。

## 2. 当前基线

- 主仓库：`/Volumes/extension/code/zterm`
- main HEAD：`d626524`，当前仍为 AppSDK 0.1.2 + active-v2。
- migration 分支：`migration/appsdk-0.1.3-active-v4`
- migration HEAD：`150fe46`
- migration `android/.appsdk/project.json`：sdk 0.1.3，module
  `zterm-runtime-v2` stage `controlled_verified`，version_base
  `active-v4` -> `previous active-v3`。
- `android/active/lib/zterm-runtime-v2/current.json` 仍指向 active-v3：
  `sha256:a26c67f3...`。
- active-v3 记录齐全但 freeze 后 prebuild 曾失败，修复被拆到 active-v4。
- DSH source review `zarchv2-activev4-source-r2` 已 PASS；active-v4 记录被有意
  清除，尚未 freeze/publish。
- 全局 binary：`/Users/fanzhang/.local/bin/appsdk`
  - SHA：`e3c36ae25c94d0c01c81cfe084fac7de8dc577f5ba3b8f91ae18b9d0587631a5`
  - version：0.1.3
  - 与 migration branch `.appsdk/sdk.lock` 匹配：
    bundle digest `sha256:dfccab3a...`，compiler digest
    `sha256:e3c36ae2...`。
- `.agent-collab` claim 已存在：
  - run_id：`20260816T135755Z-Macstudio.local-63423-9d5e57bc0333`
  - claim：`appsdk.active_v4_promotion`
  - worktree：`playground/appsdk-active-v4-20260816T135755Z-Macstudio.local-63423-9d5e57bc0333`
  - branch：`work/appsdk-active-v4-20260816T135755Z`
  - base：`150fe46`
- 授权门禁：`.agent-collab/handoff/zterm-v2-authorization-gates.json` 当前
  `status: awaiting_jason`；freeze/publish/merge/OTA/cleanup 均不可在未授权时执行。

## 3. 范围与边界

In Scope：

- active-v4 lifecycle records：worktree、evidence、fix candidate（如产生）、
  regression、review、promotion、freeze、merge 记录。
- migration branch 与 main 的 governance、gate、CI、record 对齐。
- prebuild/build 环境依赖补齐，例如 missing evidence、release-dist、generated
  artifacts 的生成或 gate 依赖修正。
- 如确认需要，对测试 timeout 做最小、可审计调整。
- 已授权时执行 L5 real-device、OTA republish、playground cleanup。

Out of Scope：

- 不改 terminal/daemon/render/transport/session 业务语义。
- 不修改业务 payload 的 request/response/error 链。
- 不引入 fallback、silent strip、双 SDK、双真源。
- 不手工编辑 `active/lib/**`、`protected/**`、`generated/**`、
  `.appsdk/sdk.lock`。
- 不做与 AppSDK migration 无关的重构。

## 4. 设计原则

1. 只使用 SHA 与 `.appsdk/sdk.lock` 匹配的 AppSDK 0.1.3 binary；禁止执行
   `.appsdk/sdk.bin`，禁止旁路。
2. 所有 lifecycle record 必须绑定 exact source commit/tree/artifact/scope；
   禁止伪造 hash、禁止用 source PASS 代替 final PASS、禁止覆盖 DSH FAIL。
3. 代码修改前先刷新 `.agent-collab`，只在自己声明的干净 worktree 工作；禁止
   复用带未提交改动的 `.worktree-appsdk-013-v4`。
4. 所有文件修改逐文件核实后使用 `apply_patch`；禁止脚本批量替换。
5. 控制面与业务 payload 物理隔离；错误显式暴露，禁止 fallback。
6. 先红后绿；非平凡逻辑留可运行的最小检查。
7. review 后再修改任何代码/测试/构建配置，旧 PASS 立即失效，必须重跑受影响
   验证和 final review。

## 5. 技术方案与文件清单

主流程：

1. 在干净 worktree 完成全部 candidate 验证与记录绑定。
2. 使用 AppSDK 0.1.3 CLI 生成/校验 governance records，不手工改 protected
   面。
3. active-v4 达到全部 gate 后，通过 `appsdk promote-module` 官方流程晋升到
   `architecture_stable` 或项目声明的稳定 stage，再 freeze/publish。
4. DSH final review 通过后，按 Jason 授权顺序执行 merge/OTA/cleanup。

关键文件：

- `android/docs/goals/appsdk-0.1.3-active-v4-plan.md`
- `android/docs/goals/zterm-runtime-architecture-v2-plan.md`
- `android/docs/debug/2026-08-16-appsdk013-final-gate-fix-design.md`
- `android/.appsdk/rules/appsdk-project-governance.md`
- `android/.appsdk/project.json`
- `android/.appsdk/sdk.lock`
- `android/active/lib/zterm-runtime-v2/current.json`
- `.agent-collab/handoff/zterm-v2-authorization-gates.json`
- `.agent-collab/claims/appsdk.active_v4_promotion/owner.json`
- `.agent-collab/runs/<run_id>/evidence.jsonl`

允许修改路径（仅治理/gate/记录）：

- `android/docs/**`
- `android/.appsdk/**`（只允许官方 CLI 修改的生成面除外）
- `android/scripts/**` 中与 prebuild/gate 相关的修复
- `android/vitest.config.ts`（仅确认必须的 timeout/gate 配置）
- `android/src/vitest.setup.ts`（Node 26 + jsdom 下补齐 in-memory
  localStorage，避免测试环境失效）
- `android/src/components/terminal/FileTransferSheet.test.tsx`（setItem mock
  改为直接作用到测试环境的 localStorage 实例，断言不放松）
- `android/src/lib/session-render-buffer-store.test.ts`（仅 perf guard 冷启动
  warmup 稳定化，阈值 16ms 不放松）
- `.agent-collab/**`

禁止修改路径：

- `android/active/lib/**`
- `android/protected/**`
- `android/generated/**`
- `android/.appsdk/sdk.lock`
- terminal/daemon/render/transport 业务源码与测试语义

## 6. 风险与规避

| 风险 | 规避 |
| --- | --- |
| full prebuild 在 clean worktree 缺 evidence/release-dist/generated | 先对比 main 与 worktree 的生成物和 gate 依赖，补齐生成步骤，不改业务代码 |
| 5s test timeout 在完整 CI 下 flake | 先单独复跑定位；如必须，只对超大 UI/集成测试用最小 timeout 调整并记录理由 |
| session-render-buffer perf guard 在 loaded machine 冷启动超 16ms | 测量前增加 warmup iterations；仍保留 16ms 阈值，不放松业务性能断言 |
| active-v4 records 被误删/伪造 | 只由官方 CLI 绑定真实 hash；记录写入前后校验 tree 不变 |
| DSH source PASS 被误当 final PASS | final review 必须针对 frozen/published exact HEAD 重跑 |
| freeze/publish/merge/OTA/cleanup 越权 | 每次不可逆动作前读 authorization gates；仍 `awaiting_jason` 时只记 pending |
| 复用了 dirty worktree | 拒绝 `.worktree-appsdk-013-v4`，只允许 claim 中声明的干净 worktree |
| 测试/构建配置改动使旧 review 失效 | 任何 candidate 后 diff 都重新跑完整 gate 与 final review |

## 7. 测试计划

阶段 1：clean worktree baseline

- `appsdk verify android`
- 聚焦 module regression：8 files / 297 tests / 0 skipped
- feature registry：92/92

阶段 2：完整 gate

- `pnpm run prebuild`
- `pnpm run build`
- `pnpm exec tsc --noEmit`
- module registry / edge registry / DAG / ownership gates

阶段 3：生命周期与发布

- promotion record / freeze record / regression report 全部绑定 exact hash
- DSH final review：provider `opencode-go/deepseek-v4-flash`
- DSH 明确 `unavailable` 时才允许 codex-review，顺序 `oauth -> cc -> tcm`
- 已授权时：L5 real-device、OTA republish、playground cleanup evidence

阶段 4：main 合并后复验

- main 的 `sdk.lock`、CI、release workflow、records 唯一使用 0.1.3
- 合并后 detached worktree `appsdk verify android` PASS
- 无 stale active-v2/0.1.2 双真源

## 8. 实施步骤

1. 刷新 `.agent-collab`：读 active runs、claims、events、authorization gates；
   确认 kill switch 未触发。
2. 确认 claim worktree 与 `git worktree list`、HEAD、base commit 一致。
3. 确认全局 binary SHA 与 migration `.appsdk/sdk.lock` compiler digest 一致。
4. 重跑并记录完整 prebuild 失败明细：
   - `terminal-buffer-replay.evidence.test.ts`
   - `server.daemon-runtime-truth.test.ts`
   - `TerminalView.dynamic-refresh.test.tsx`
   - `tmux-window-size-semantics.test.ts`
   - `session-render-buffer-store.test.ts`
5. 对比 main worktree 的 `android/evidence/daemon-mirror`、
   `android/release-dist`、`android/evidence/real-device`，补齐生成物或修正
   gate 依赖。
6. 单独重跑失败测试，区分环境 flake、缺失生成物、真实回归。
7. 若需要，只对测试配置做最小修复并提交；禁止放宽业务断言。
8. 在 clean worktree 重跑完整 gate；失败即修复到全绿。
9. 绑定 active-v4 records，使用真实 commit/tree/artifact/public API/scope
   hash。
10. 运行 `appsdk promote-module ... --to <stable-stage>`，记录 promotion。
11. 运行 regression report、freeze record，并让 `current.json` 指向 active-v4
    artifact。
12. 对 exact frozen/published HEAD 跑 DSH final review；必须得到明确 PASS。
13. DSH PASS 后，向 Jason 汇报授权门禁；仅执行已授权的 freeze/publish/merge/
    OTA/cleanup。
14. 合并 migration 到 main，更新 main 的 CI/release/records/sdk.lock，确保唯一
    0.1.3 + active-v4。
15. 关闭或记录所有尾项，写完成报告与 MEMORY.md 提炼。

## 9. 完成定义（DoD）

- active-v4 frozen/published，`current.json` 指向 active-v4。
- active-v4 的 artifact、public API、scope、review、regression、promotion、
  freeze 记录完全一致。
- DSH final PASS 基于 exact HEAD。
- main 唯一使用 0.1.3 + active-v4。
- 无 stale active-v2/0.1.2 双真源，无未结案 DSH FAIL。
- OTA/playground 等尾项已关闭，或明确记录为 Jason `pending_authorization`。

## 10. 当前开放项

- 完整 prebuild 尚有失败，须先定位是否环境/生成物依赖或真实回归。
- `android/vitest.config.ts` 是否纳入 active-v4 candidate 尚未定案；若纳入，
  source diff 不再是纯 governance/gate 记录，必须重新走 final review。
- `freeze/publish/merge/OTA/playground cleanup` 均等待 Jason 授权。

## 11. 2026-08-16 DSH final round 2 基线

- main HEAD：`15df591f6cbc4adb02ab420b1a9d3d7ee88cc3c8`，仍是 0.1.2 +
  active-v2。
- claim worktree：
  `playground/appsdk-active-v4-20260816T135755Z-Macstudio.local-63423-9d5e57bc0333`，
  HEAD `9f653d85aa582f0e6fa5c64b80366034c863ef45`，仅追加 lifecycle records。
- DSH final `zarchv2-activev4-final-9f653d8-20260816T173500Z`：
  `VERDICT: FAIL`，P0/P1 见
  `docs/debug/2026-08-16-appsdk013-final-gate-fix-design.md` round 2。
- 本计划后续 candidate 必须先修复上述 findings，再重跑完整 gate 与 DSH final；
  发布/合并类动作仍等 Jason 授权。

## 12. 2026-08-16 DSH final round 3 基线

- main HEAD：`15df591f6cbc4adb02ab420b1a9d3d7ee88cc3c8`，仍是 0.1.2 +
  active-v2。
- claim worktree：
  `playground/appsdk-active-v4-20260816T135755Z-Macstudio.local-63423-9d5e57bc0333`，
  branch `work/appsdk-active-v4-20260816T135755Z`，HEAD
  `6ae9528`，仅追加 lifecycle records。
- DSH final `zarchv2-activev4-final-6ae9528-20260816T192400Z`：
  `VERDICT: FAIL`，P1 + P2 见
  `/Users/fanzhang/.dsh/reviews/zarchv2-activev4-final-6ae9528-20260816T192400Z/review.final.md`。
- P1：`session-render-buffer-store.ts` immutable 路径写入 source-row identity
  cache；后续同 session 非 immutable publish 可能把 live source row 别名进
  immutable snapshot。当前生产调用恒为 `immutableProjection: true`，不可达但
  未测试、未 gate。
- P2：perf guard 只测 1 行增量（80 cells），无法暴露 full-clone 回归；阈值
  16ms 不放松，需改成能证明 full rewrite 会失败的负向断言。
- P2：regression report 绑定 `519ffe2`，未列出 changed suites，实际修复 commit
  是 `6da2968`；records 必须绑定 exact HEAD 并包含 changed suites。
- P2：immutable 生产热路径每 commit 构造 identity Map 且 session 生命周期内
  不释放；cache 应只属于非 immutable source→clone 路径，或明确作用域/清理。
- 当前 worktree 有未提交临时文件 `android/src/tmp-perf-bench.test.ts`，提交前
  必须物理删除。
- authorization gates 仍 `awaiting_jason`；freeze/publish/merge/OTA/cleanup
  均不得在未授权时执行。

## 13. Round 3 修复范围与下一步

必须完成：

1. 修复 P1：immutable 路径不得写 `sourceRowClonesBySession` 或写入后立即清除；
   cache 只保留 source→clone 语义。
2. 补 mixed-mode 测试：同 session 先 immutable publish，再非 immutable publish
   同 row reference；断言 render row 与 live source row 不别名，源 row 后续原地
   mutate 不污染 snapshot。
3. 将 perf guard 切到真实生产投影路径（`immutableProjection: true`），保留
   16ms 产品阈值；删除 `tmp-perf-bench.test.ts`。
4. 重跑 changed suites、feature registry 92/92、聚焦回归 297/297、prebuild、
   build、tsc、module/registry gates。
5. `appsdk compile-module` 生成新 artifact，绑定新 artifact/public API/scope/
   contract hash 到 lifecycle records。
6. `appsdk verify .` + detached clean worktree verify PASS。
7. 对 exact 新 HEAD 重跑 DSH final（仅 DSH MCP + `opencode-go/deepseek-v4-flash`），
   必须明确 PASS；FAIL 则继续修复并重新走全部 gate。

禁止：

- 放松 16ms guard、绕过 DSH、使用 Codex review 替代 DSH、fallback、脚本批量
  替换、手改 `android/active/lib/**`、`android/protected/**`、
  `android/generated/**`、`.appsdk/sdk.lock`。
- 在 Jason 明确授权前执行 freeze/publish/merge/OTA/cleanup，或标记 Promotion/
  Freeze/Merge records 已完成。

## 14. 2026-08-16 round 3 candidate fixes

已应用修复：

- `session-render-buffer-store.ts`：source-row clone cache 只存在于非
  immutable publish 路径；cache 不写 identity、不复用 previous snapshot row，
  避免 immutable -> non-immutable live alias。immutable 生产路径不再为每个
  commit 构造 rows-length `Map`。
- `session-render-buffer-store.test.ts`：mixed-mode 反例测试覆盖 row、gap
  range、cursor 不别名；16ms perf guard 使用 `immutableProjection: true`
  测量真实生产投影路径，并保留生产 immutable 路径与非 immutable clone 路径
  的确定性 row-identity 负向断言。
- 临时文件 `android/src/tmp-perf-bench.test.ts` 已删除。

当前验证（candidate 提交前）：

- changed suites：3 files / 65 tests PASS
- feature registry：12 files / 92 tests PASS
- focused regression：8 files / 297 tests / 0 skipped PASS
- 后续还需完成 prebuild、build、tsc、AppSDK compile/verify、records 绑定与
  DSH final round 4。

## 15. 2026-08-16 round 5 DSH FAIL

- DSH final `zarchv2-activev4-final-394679c-20260816T205000Z`：
  `VERDICT: FAIL`，P1 + P2 见
  `docs/debug/2026-08-16-appsdk013-final-gate-fix-design.md` round 5。
- P1：review target 是 detached `394679c`，record rebind 只存在于未提交
  working-tree 编辑，DSH 读到 stale committed evidence。
- P2：非 immutable clone cache 对同 row reference 不重读内容就复用 clone，
  in-place 修改会发布 stale row。
- P2：`vitest.setup.ts` 只在 `window` 存在时安装 localStorage mock。
- 本 round candidate 必须：验证 clone 内容后复用、补 in-place 红测、统一
  安装 global/window storage mock，并在 clean committed HEAD（源码 + 新 records
  一起提交）重跑全部 gate 与 DSH。

## 16. 2026-08-17 main closeout 基线

- 当前 main HEAD：`91f69b2`，AppSDK migration 已合并，但 module 仍为
  `controlled_verified`，`current.json` 仍指向 active-v3。
- 直接运行固定路径 AppSDK 0.1.3 对 main 返回 `ok:true`；标准 package gate
  曾解析到 `/Users/fanzhang/.local/bin/appsdk` 的 0.1.2，并以
  `NON_CANONICAL_RECORD_CONTRACT_SET` 失败。
- 首个分歧是执行 binary 真源漂移，不是 0.1.3 contract 内容。标准 gate 必须先
  校验 PATH 所选 binary 的版本和 SHA 与 `.appsdk/sdk.lock` 完全一致，再调用
  `appsdk verify`；CI、release 和 prebuild 复用同一 gate。
- active-v4 顶层缺 Effectiveness、Merge、Promotion、Freeze records；现有 review
  绑定 `55eec27`，不能作为当前 main exact-HEAD 完成证据。
- 本轮使用独立 claim `appsdk.active_v4_governance_closeout` 和独立 clean worktree；
  原 `appsdk.active_v4_promotion` stale claim 不接管、不删除。
