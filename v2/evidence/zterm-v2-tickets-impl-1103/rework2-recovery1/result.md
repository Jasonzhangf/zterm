# zterm-v2-tickets-impl-1103 R2 recovery-2 result

任务 ID: zterm-v2-tickets-impl-1103
分支: zterm-v2-tickets-impl-1103
证据提交 head: 12595d51e7a27788054cae6de7eca9821acb8d278b356d60d4da54a0ae4f29ee27
最终 head: 本 result.md 提交后的 branch head，见交回回执
基线 head: 12cb233802672989ae01af0d7a0bfcec96dd58bc2961c6d6cc912799330843b8a2

## 已完成范围
只在 `v2/modules/tickets/**` 与 `v2/evidence/zterm-v2-tickets-impl-1103/rework2-recovery1/**` 做改动；未改动 main、board、webui、daemon、accounts、organization、members、routing、delivery；未 push/PR/merge；未全局安装；未重启共享 daemon；未触碰 tmux server。

## 两项接缝改动
1. 评论唯一性 provider-scoped：移除了对 `external_comment_id` 的全局 `operations_comment_unique` 唯一索引，沿 `comment_claims(providerInstanceId, externalCommentId)` 保证同 provider 不重复归属；不新增第二套 claim 表；兼容已有候选数据库重开，重开后删除遗留全局索引。
2. 持久 pending 租约失效后可手工核实：在既有 operation owner 增加 `BindingStorePort.recoverExpiredPending(ref, now)`，仅在 `executionLeaseUntil <= now` 且当前状态为 `pending` 时把 `pending -> unknown`，`errorCode=WRITE_OUTCOME_UNKNOWN`，不 POST、不猜成功、不抢占有效 lease、不改写 succeeded/failed 记录；`create`、`appendReport` 与状态回放读取已有 operation 时会先做恢复；`confirmRemoteResult` 仍只接受 `unknown`，并在租约有效时拒绝手工确认。

## 关键 diff（仅受影响模块）
- `v2/modules/tickets/src/ports/binding-store.ts`：新增 `recoverExpiredPending(ref, now)` 接口。
- `v2/modules/tickets/src/adapters/sqlite-binding-store.ts`：实现恢复逻辑；去掉全局 comment 唯一索引，保留 provider-scoped `comment_claims`。
- `v2/modules/tickets/src/adapters/in-memory-binding-store.ts`：同步 provider-scoped claim 与恢复接口。
- `v2/modules/tickets/src/application/ticket-service.ts`：对 create/appendReport/状态回放已有 operation 读取前调用恢复；租约有效时仍不抢占；已成功记录不改写。
- `v2/modules/tickets/tests/contract/comment-provider-scope.test.ts`：跨 provider 同数字 comment id 各自提交并可查；同 provider 同 id 被第二 operation 占用时报 `BINDING_CONFLICT`；重开候选数据库后删除 `operations_comment_unique`。
- `v2/modules/tickets/tests/contract/pending-recovery.test.ts`：有效 lease 不恢复；过期 pending 变 `unknown`；已成功记录不改写；stale create/replay 不 POST，可手工 confirm；appendReport stale 不 POST。
- `v2/modules/tickets/tests/contract/restart-new-process.test.ts` + `tests/support/restart-child.ts`：真实独立子进程在 POST 后退出，后续进程同 OperationRef 回放为 `unknown` 且 `createCalls=0`。
- `v2/modules/tickets/tests/support/harness.ts`：`SpyBindingStore` 转发 `recoverExpiredPending` 并计入 `STORE_METHODS`。

## 验收结果
- 聚焦两条接缝：11/11，先红后绿，原始证据 `rework2-recovery1/green-focused.txt`。
- 完整 tickets 契约套件：58/58 全绿，原始证据 `rework2-recovery1/green-contract.txt`。
- 独立新进程“持久 pending 后进程退出”：2/2 全绿，原始证据 `rework2-recovery1/restart-new-process.txt`。
- 原真实 Vikunja v2.7.1 `/api/v2` blackbox 复跑：2/2 全绿，原始证据 `rework2-recovery1/integration-real-recovery1.txt`；`/info` HTTP 200，版本 v2.7.1；项目 A id 40；凭证仅进程环境，未回显/未落盘；证据目录无 token/JWT 明文（`secret-scan.txt`：`NO SECRET PATTERNS`）。
- 原先失败记录保留，未覆盖：`rework2-recovery1/red-pre-impl.txt`、`recovery-1/`、`recovery-2/worker-task.md`、`events.jsonl`、`stderr.log`。

## 未覆盖/保留项
- 不需要也不应加远端 exactly-once；远端旧 PATCH fencing 没有证据时仍保持 unknown。
- 未重开已关闭的 8 项 R2 finding；未重做模块；未顺手改其他模块。
- 未 push/PR/merge；未全局安装；未重启共享 daemon；未触碰 tmux server。
- Workspace `5:/workspaces/32` 将在本次提交后卸载；卸载前没有未提交的 branch 写入。若需要持久化，交由 Jenny/Git owner 按交付合同进一步合并推送。

## 交回状态
写入已停止；结果仅交给 Jenny 验收，再由 David review。不自行 review、merge、push 或开启下一个目标。
