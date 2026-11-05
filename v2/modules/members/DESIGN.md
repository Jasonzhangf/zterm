# members 模块设计与执行卡

状态：2026-11-03 members 独立修订 R1。运行配置归属、AuthContext 授权、宿主核验与恢复契约已更新；V2 管理能力仍未整体验收。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/members/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../docs/mvp/module-execution.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
members/
├── DESIGN.md
├── src/
│   ├── public/              # 公开入口：service、store
│   ├── application/         # 授权、运行配置、绑定、宿主核验
│   └── adapters/            # 原子 JSON store
└── tests/
    ├── members.test.mjs     # 正反例与纯测试替身
    └── support/             # members 测试自有受信 auth 与 tmux session probe
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

拥有成员运行配置、当前会话绑定、宿主核验与恢复操作；组织归属只引用 organization，不在这里创建第二棵树。

## 公开接口、数据及错误

- `configureRuntime` / `queryRuntime`：members 独占的运行配置记录，以 `memberId` 为键持久化到 members 自己的 store，字段为 `machineId`、`hostKind`、`agentKind`、`launchProfileRef`。organization 只保留 `memberId`/`name`/`groupId`/`workspaceId` 等结构引用；organization 侧运行字段移除是跨 owner 项，交 Jenny/Frank 处理。绑定记录绑定到 `runtime.machineId`；修改 `machineId`/`hostKind`/`agentKind`/`launchProfileRef` 任一身份字段会在同一个 store mutation 中删除旧绑定，禁止新身份配旧 generation/session。per-member generation 计数与绑定保存在同一 store 并单调递增，失效后重绑与回 A 均不会复用旧代。
- `bindSession` / `queryBinding` / `getBinding`：当前会话绑定与 CAS generation。`getBinding` 是 routing 组合读端口，由调用方完成认证。
- `getRuntimeBinding(memberId)`：routing 消费的一致公开 reader。按 `memberId` 返回 `{ machineId, hostKind, agentKind, launchProfileRef, bindingGeneration, sessionId, anchor }`，仅当绑定仍属于当前配置机器时成功。缺配置返回 `MEMBER_RUNTIME_NOT_CONFIGURED`；无绑定返回 `MEMBER_BINDING_NOT_FOUND`；绑定属于另一机器返回 `MEMBER_BINDING_INVALID`。routing 不得再用 organization 旧 `machineId` 拼新机器旧绑定。
- `verifyHost` / `restoreBinding`：注入 host probe，比较运行配置 `machineId` 与宿主实测事实。宿主不可用返回 `BINDING_HOST_UNAVAILABLE`；权威机器身份缺失返回 `BINDING_HOST_IDENTITY_UNAVAILABLE`；`restoreBinding` 只重新核验持久绑定，不自动启动进程。

授权：每个公开动作先取受信 AuthContext（`accountId`、`scopes`、`workspaces`、`members`），再校验 `members:read` / `members:write` scope、目标 member 所在 workspace 与 member allowlist。`members` 缺省继承 workspace 授权；显式 string[] 为精确 allowlist，空数组或畸形值拒绝（不支持 `'*'` 扩权）。未授权在任何 members store 读写或 host probe 前拒绝。`getRuntimeBinding` 是 routing 内部读端口，仅要求组合方已鉴权。`createDevVerifiedAuth` 不产出 `workspaces`；members 测试使用模块内受信 auth 替身，不建生产账号库。

错误：复用 organization 的 typed-error 形状；members 自有 code 见公开入口 `MEMBER_ERROR_CODES`。CAS 旧代仍返回 `BINDING_GENERATION_STALE`。

## 依赖与联调

- [organization](../organization/DESIGN.md) 的公开 reader，仅取结构与成员存在性校验。
- 注入 host probe；权威机器身份必须来自未来 host-adapters 公开 probe，members 不直接读 `@zterm_machine_id` 或自设 option。members 测试自有 tmux probe 只证明真实 session/anchor 存在，`machineId` 固定为 `null`；该缺口以 `BINDING_HOST_IDENTITY_UNAVAILABLE` 显式暴露。

对应组合增量：I1/I2。链路、输入条件与退出证据见[联调计划](../../docs/mvp/scope-and-handoff.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

先绑定既有真实 session；再显式配置运行记录与宿主核验；与 routing/delivery 联调换代。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

成员名字不变、session 更新后定位更新；旧代请求被拒；宿主身份不匹配或不可用显式拒绝；恢复失败可查，其他成员不受影响。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/members/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。
