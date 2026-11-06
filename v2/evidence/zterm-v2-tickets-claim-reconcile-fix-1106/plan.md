# tickets provider-scoped comment claim readback fix

目标：修复 `SqliteBindingStore.comment_claims.ref_key` 的持久化读回，
让同一数字 comment id 在不同 provider instance 下可独立认领和查询，并保持旧候选数据库可用。

## 受影响 DAG（复用 zterm-v2-tickets-impl-1103）

```text
appendReport/confirmRemoteResult
  -> TicketService
       -> BindingStorePort.claimComment(ref, bindingId, externalCommentId, next)
       -> SqliteBindingStore
            -> comment_claims(provider_instance_id, external_comment_id, ref_key)
       -> BindingStorePort.getOperationByExternalComment(providerInstanceId, externalCommentId)
            -> operations(ref_key) exact readback
       -> operation or undefined
```

成功终点：`claimComment.ok=true` 后，`getOperationByExternalComment` 返回同一 OperationRef。
失败终点：无 claim 或 claim 指向不存在的 operation 时返回 `undefined`；同一 provider 下重复 comment
仍返回冲突。

唯一 owner：`v2/modules/tickets/src/adapters/sqlite-binding-store.ts`。

当前缺口：`comment_claims.ref_key` 使用含 NUL 的 `operationRefKey`。SQLite 保留写入字节，但
Node `node:sqlite` 读 `TEXT` 时在第一个 NUL 截断，claim 读回只得到 workspace 前缀，随后
`operations` 精确查询失败。该缺口属于持久化编码/读回，不改变 DAG 拓扑。

Gate：`tests/contract/comment-provider-scope.test.ts` 先红后绿，随后完整
`node --test tests/contract/*.test.ts`。
