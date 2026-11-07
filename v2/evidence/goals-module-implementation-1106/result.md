# Goals 模块实现交付回执

## 目标与可用行为
目标：在 `v2/modules/goals` 内交付 V2 goals 模块真实能力，作为 I3 的目标→票据→Board 基础。
现已实现：
1. 公开端口 `createGoal/getGoal/listGoals/updateGoal/deleteGoal`，均按 actor/workspace 授权，返回稳定 `goalId`；
2. 持久目标层级、owner 与状态（`active/completed/archived`），更新后可重读；
3. 真实原子 JSON file store `v2/modules/goals/src/adapters/file-goal-store.mjs`，同时作为持久消费者；
4. 跨 workspace 显式拒绝，目标不泄露到其他 workspace；
5. 同父重名、非法父目标、非法 owner、自身/后代环、被票据引用的目标都明确拒绝删除；
6. `deleteGoal` 删除前检查子目标与票据引用，不产生孤票；
7. `goalBelongsToWorkspace(workspaceId, goalId)` 提供 Tickets 只读引用校验；Board 不反写目标完成状态。

## 验证命令与结果
- 红测：`node --test v2/modules/goals/tests/contract/goals.test.mjs`；未实现前因缺少 `src/public/index.mjs` 失败，已存档 `red-test.txt`。
- 语法：`node --check` 对全部 6 个 Goals 新增/修改 mjs 文件通过，已存档 `syntax-checks.txt`。
- 绿测：`node --test v2/modules/goals/tests/contract/goals.test.mjs` 5/5 通过，已存档 `green-tests.txt`。
  测试复用真实 organization 服务、真实 JSON 持久层，不使用 mock 组织或硬编码 owner。

## 改动范围
`changed-paths.txt` 中列出全部新增文件；allowed paths 只有 `v2/modules/goals/**` 与 `v2/evidence/goals-module-implementation-1106/**`。
未触碰 `accounts|organization|members|routing|tickets|board|status|daemon|webui|connections`，未触碰共享 3333/8801/8899、tmux server 16906、15T，未 restart/stop 共享服务，未 push/merge/publish/PR。

## 边界条款核对
- 公开端口在本 worktree 内可执行，返回稳定 `goalId`。
- 更新后可读回；持久文件可重开读取。
- 跨 workspace 拒绝；拒绝响应不承载调用 token。
- 没有单测或空骨架冒充可用；交付依据公开入口黑盒回执。
- 引用目标删除显式拒绝，未完成私有改写；无秘密/token/连接材料保存。
- 未增加二级治理骨架、SHA/checksum 包装或全局安装。

## 未实现能力与下游影响
- Tickets/Vikunja adapter 与 Board 真实查询投影尚未交付，不属于本合同范围。
- `references.hasTicketReference` 需要后续 tickets 模块按 Goals 引用端口实现；本合同内以持久目标真实存储和 typed reference reader 完成闭环。
- 未从票据全部关闭自动宣称目标完成；状态只由显式 `updateGoal` 变更。
- 下游可按 `goalBelongsToWorkspace` 接入 Tickets，按 `listGoals` 接入 Board。

## 状态
本合同完成；未 push/merge，由 reviewer David 另行审计与集成。
