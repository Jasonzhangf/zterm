# zterm-v2-tickets-impl-1103 计划与受影响 DAG

目标：在 `v2/modules/tickets/` 提供唯一 ticket 业务端口 create/get/list/appendReport/
close/reopen/confirmRemoteResult。Vikunja v2.7.1 `/api/v2` 是 ticket 内容与状态真源；
本地只保存 typed binding、operation 和权限映射。设计基线：`v2/modules/tickets/DESIGN.md`
与 R3 PASS 详细设计（不改设计）。

## 受影响 DAG（SESE）

入口：`v2/modules/tickets/src/public/contracts.ts` 公开端口。

```text
caller (board/webui/cli)
  -> TicketService.<op>(actor: VerifiedAuthContext, input)
       -> readers: hasWorkspaceAction + goalBelongsToWorkspace + member delegation
          [deny] -> TicketError(TICKET_SCOPE_FORBIDDEN | TICKET_REPORT_DELEGATION_FORBIDDEN)  (store 零调用)
       -> binding-store: getOperation(OperationRef)/createOperationIfAbsent/nextIntentVersion
          [same ref + same request] -> return existing operation (no provider call)
          [same ref + diff request] -> TicketError(OPERATION_CONFLICT)  (no provider call)
       -> credential-provider: getCredential(providerInstanceId)
       -> vikunja-v2 adapter: POST/GET/PATCH /api/v2
          [2xx+stable id]  -> local commit (binding + operation.succeeded) -> WriteResult(succeeded)
          [400/401/403/404] -> operation.failed -> TicketError(typed)
          [5xx/timeout/no body] -> operation.unknown -> TicketError(WRITE_OUTCOME_UNKNOWN)
       -> confirmRemoteResult (manual): locate by OperationRef -> reconcile authz
          -> GET candidate -> verify attribution(operation-produced)+evidenceRef
          -> operation.resolution=manually-verified, successSource=manual
```

成功终点：succeeded/fresh|stale|unavailable observation、typed error。
失败终点：TICKET_SCOPE_FORBIDDEN、PROVIDER_*、WRITE_OUTCOME_UNKNOWN、OPERATION_CONFLICT、
OPERATION_SUPERSEDED、BINDING_CONFLICT。资源终点：adapter 无本地 timer/句柄；store 为注入端口。

唯一 owner：`v2/modules/tickets`。不得 import board/webui/daemon 或 Vikunja 私有实现。
授权只来自注入的 `VerifiedAuthContext` 与公开 reader（本模块定义端口，由外部实现）。

## Gate

- 契约测试（单测，fakes）：operationRef 三元组隔离与冲突、same-ref 重放、unknown 不重发、
  进程重开查询、scope/授权拒绝且 store 零调用、Vikunja 成功/失败/超时映射、
  appendReport/close/reopen 正反例、superseded、confirmRemoteResult 规则。
- 真实 Vikunja v2.7.1 `/api/v2` 黑盒（integration，独立标注）：成功路径、403/401、
  非幂等两 POST、unknown、人工核实、top-five 排序分页、provider 不可达 stale/unavailable。

顺序：先写图（本文件）→ 红测失败证据 → 实现唯一 owner → 绿测 → 真实黑盒或 UNVERIFIED。
