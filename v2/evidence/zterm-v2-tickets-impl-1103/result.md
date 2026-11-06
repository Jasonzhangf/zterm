# zterm-v2-tickets-impl-1103 David R2 定向返工收口

目标：在 `v2/modules/tickets/**` 修复 David 列出的 8 项 finding，并给出可重复的契约与真实 Vikunja v2.7.1 黑盒证据。执行者只写 LayerFS branch `zterm-v2-tickets-impl-1103`，未 push / PR / merge / 全局安装 / 重启共享 daemon / 触碰 tmux server。

## 实现与 finding 对应

| Finding | 实现 | 证据 |
| --- | --- | --- |
| 1 持久化 | `src/adapters/sqlite-binding-store.ts` 接入正式 SQLite binding/operation/intent store；create 的 binding + operation 在同一 SQLite 事务原子提交；`commitWriteSuccess` 在事务内完成 binding 写入与 operation 更新。真正新进程按同 operationRef 读取持久 unknown，不重发 provider 写入。 | contract `persistence.test.ts`；`restart-new-process-final.txt`；`integration-real-final.txt` |
| 2 稳定唯一 binding ID | SQLite `binding_seq` 单调序列在 store 内分配；`bindings.external_key` 为 UNIQUE，`putBinding`/`commitWriteSuccess` 原子冲突拒绝；旧 JSON `ticket-store.ts` 已物理移除。 | contract `persistence.test.ts` `two services...unique binding IDs`；`operation-ref.test.ts` |
| 3 provider 路由固定 | binding/operation 固定 `providerInstanceId`；get/appendReport/close/reopen/confirmRemoteResult 按固定实例解析 baseUrl 与凭据；原实例不可用返回 `PROVIDER_UNAVAILABLE`。 | contract `provider-routing.test.ts`：same task ID 两 provider 隔离、mapping 变更不重定向、缺实例显式 unavailable |
| 4 状态并发 | `beginStateOperation` 只 supersede 旧的 close/reopen；per-binding `intentVersion` 分配并在 `commitWriteSuccess` 做当前 intent CAS；旧在途 close/reopen 不能覆盖新 intent；unknown appendReport 不被状态操作 supersede。 | contract `state-concurrency.test.ts`；`state-intent.test.ts` |
| 5 listPendingWrites scope | service 先校验当前 `ticket.read` scope，再读取 store；撤权返回 `TICKET_SCOPE_FORBIDDEN` 且 store 零读取。 | contract `scope-confirm.test.ts` |
| 6 confirmRemoteResult | 只处理 unknown operation；create 候选 task 必须属于 operation 固定 provider project；appendReport comment 不能被其他 operation 重复认领；人工成功标 `successSource=manual`。 | contract `scope-confirm.test.ts`；`ticket-service.test.ts` |
| 7 top5 cursor | `listForGoalTopFive` 先按 goal 过滤再稳定排序（priority desc、externalTaskId asc、bindingId asc），候选 >5 时返回 `nextCursor` 且 `list` 可翻页取完。 | contract `topfive-cursor.test.ts`；`list-pagination.test.ts` |
| 8 cause 保留 | `TicketError` 保留原始 transport cause，`errorRef.cause` 在固定 code 后仍可读到原原因，不新建第二错误中心。 | contract `ticket-service.test.ts` transport failure/cause；`errors.ts` |

## 测试结果

- 契约：`cd v2/modules/tickets && node --test tests/contract/*.test.ts`，48/48 PASS。原始输出 `green-contract-final-48.txt`。
- 真正新进程恢复：`node --test tests/contract/restart-new-process.test.ts`，1/1 PASS。原始输出 `restart-new-process-final.txt`。
- 真实 Vikunja v2.7.1 黑盒：容器 `zterm-vikunja-tickets-1103c` 宿主 `127.0.0.1:12745`，workspace 经 `http://host.docker.internal:12745/api/v2`（HTTP 200）；注册两个新用户取 JWT，为 A 建 project，注入 `VIKUNJA_BASE/VIKUNJA_TOKEN/VIKUNJA_TOKEN_B/VIKUNJA_PROJECT_A/VIKUNJA_PROJECT_B` 后 `node --test tests/integration/vikunja-real.test.ts`，2/2 PASS。凭证只存在该进程环境，未写入任何文件。原始输出 `integration-real-final.txt`。

## 未实现 / UNVERIFIED

- 真实请求超时后远端副作用核实、旧超时 PATCH 迟到后的 provider 最终状态：本地 unknown/CAS 已实现，但没有远端 fencing，不承诺 exactly-once。
- board/WebUI 与 tickets 的真实组合调用、真实 workspace/goal/member reader 组合、project-scoped list endpoint 选型：不在本模块范围。
- 生产 Vikunja 部署、凭据轮换、HA、多主写入、SQLite 文件损坏恢复、备份与迁移：不在本候选范围。
- 已成功 ID 后本地事务提交前的进程崩溃恢复：当前保持 unknown 并经人工核实，不自动补成功。

## 未执行

未 push / PR / merge / 全局安装 / 重启共享 daemon / 触碰 tmux server。commit 到 LayerFS branch 后交 Jenny 验收，由 David review。
