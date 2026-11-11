# Goals 最小 SESE 图

现有 `v2/docs/dagpipe/graphs` 中没有 Goals 图。本合同不新增项目级图文件，因为
Goals 本次只闭合本地同步文件存储的单一对象流；该图段是受影响设计基线。

```text
ARC.goal_request（actor token + workspaceId + goal command）
  -> G1 验证 actor（accounts verify）
  -> G2 检查 goals scope 与 workspace access
  -> G3 按命令读取当前 goal truth（create/get/list/update/delete/trusted reader）
  -> G4 在 Goals owner 内校验父目标、owner member、同父名称、层级环、子目标与引用
  -> G5 单 writer 原子提交或只读返回
  -> ARC.goal_result（稳定 goal / 列表 / typed success / typed rejection / typed failure）
```

节点与 owner：

| 节点 | 唯一 owner | 输入 | 输出 |
| --- | --- | --- | --- |
| G1 验证 actor | accounts public auth port | opaque token | AuthContext |
| G2 scope/workspace | goals application | AuthContext + workspaceId | allowed 或 GOAL_FORBIDDEN |
| G3 goal truth | goals file store | current JSON state | current goal records |
| G4 goal invariants | goals domain/application | candidate fields + organization public reader + ticket-reference port | accepted mutation 或 typed rejection |
| G5 commit | goals file store | accepted state | atomic persisted success 或 STORE_PERSIST_FAILED |

闭合规则：

- 外部入口只有 `ARC.goal_request`。
- `GOAL_FORBIDDEN`、`GOAL_NOT_FOUND`、`GOAL_NAME_CONFLICT`、`GOAL_PARENT_INVALID`、
  `GOAL_OWNER_INVALID`、`GOAL_NOT_EMPTY` 与 `GOAL_REFERENCED` 均从 G4 进入统一
  `ARC.goal_result` 拒绝终点。
- `STORE_PERSIST_FAILED` 与 `GOAL_REFERENCE_UNAVAILABLE` 进入统一 `ARC.goal_result`
  失败终点；失败发生在提交前时没有业务副作用。
- 成功写入返回从已提交 store 生成的 goal；读取与列表不改变状态。
- `unknown` 不适用：本地同步 store 没有“请求已发出但结果未确认”的远端写入；
  reference reader 不可用会显式失败，不能降级删除。
- Tickets 只通过 Goals 的 trusted reader `goalBelongsToWorkspace(workspaceId, goalId)`
  读取目标归属；Board 不在本模块写入目标完成状态。
