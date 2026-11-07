# daemon 模块设计与执行卡

状态：2026-11-02 设计交接版。Grace 的 zterm-v2-bootstrap-1103 已在工作；当前记录为工作线准备，未交付 V2 daemon 行为。

本卡是 David 的模块结构/开发/联调合同，不是已存在源码清单。正式根为 v2/modules/daemon/；Jenny 负责派具体 peer、建工作线和集成。实际进度只在[执行总表](../../zterm-v2-module-execution-index.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
daemon/
├── DESIGN.md
├── src/
│   ├── public/api：业务请求/响应协议
│   ├── application/composition-root：依赖注入
│   ├── endpoints/http：配置与查询
│   ├── endpoints/websocket：订阅和投递
│   ├── runtime/machine-instance：机器实例身份
│   ├── runtime/lifecycle：正式启动/关闭接口
└── tests/
    ├── contract/        # 当前契约的必要正反例
    └── integration/     # 本模块真实 consumer，关联联调场景
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的空文件。公开入口在 public，私有实现不能被跨模块直接引用。

组合模块、拥有机器级服务实例；账号、组织、投递等状态仍在原模块。terminal 内不得持有客户端 tab/focus/viewport。

## 公开接口、数据及错误

HTTP/WS 暴露业务端口；同一鉴权上下文到达业务 owner；版本/capability 握手不把 unsupported 当成功。

返回原 owner 错误及 operationId；不统一吞错重试；开发实例与生产实例隔离。

### 控制面组合端口（2026-11-06）

`createDaemon()` 接受显式组合依赖：`workspaceAuth`、`organization`、`members`、`routing`、
可选 `memberHostObserver` 与 `terminalCatalog`。daemon 只调用公开端口，不保存第二棵组织树或
第二份绑定。缺依赖时对应控制面路由返回显式配置错误，不回退到共享 token、fixture workspace 或裸
session 列表。

- `GET /api/workspaces` -> `organization.listWorkspaces({ token })`
- `GET /api/workspaces/:workspaceId/tree` -> `organization.queryTree`，按成员组合
  `members.queryRuntime` / `members.queryBinding` 与真实宿主观测；无绑定或失败成员保留并标
  `availability.status=unavailable`，终端目录未归属 target 只在 observation 报告；目录端口
  缺失时显式返回 `unknown`，目录失败时授权组织树仍保持可读，目录返回 `unknown` 并保留原
  typed error（`code`/`owningModule`/`operationId`/`cause`/`retryDisposition`），
  `unassignedTerminalTargets=null`；只有真正成功返回空数组时才报告 `observed` + `[]`
- `GET /api/workspaces/:workspaceId/members/:memberId/runtime` -> 先用带 token 的
  `organization.queryTree` 校验工作区与成员可见性并取得组织成员引用，再组合 members
  runtime/binding 与真实可用性；不调用无授权上下文的 organization 结构读取绕过组织授权
- `POST /api/workspaces/:workspaceId/resolve` -> `routing.resolve`

稳定 `memberId` 来自 organization，不随 `sessionId` 变化。账号身份与 workspace 授权由注入的
`workspaceAuth` 对 Bearer credential 提供服务端验证后的 AuthContext；生产 accounts-backed
授权 adapter 与账号登录 cookie 链未提供时，该配置缺口必须显式保留为 UNVERIFIED，不能用 dev
auth 冒充生产。

## 依赖与联调

- [accounts](../accounts/DESIGN.md) 的公开端口。
- [connections](../connections/DESIGN.md) 的公开端口。
- [organization](../organization/DESIGN.md) 的公开端口。
- [members](../members/DESIGN.md) 的公开端口。
- [routing](../routing/DESIGN.md) 的公开端口。
- [delivery](../delivery/DESIGN.md) 的公开端口。
- [status](../status/DESIGN.md) 的公开端口。
- [errors](../errors/DESIGN.md) 的公开端口。

对应组合增量：I0/I1/I2。链路、输入条件与退出证据见[联调计划](../../zterm-v2-integration-plan.md)。errors 是统一类型/接收端口，不因此形成业务依赖环。

## 开发顺序

I0 只组合真实终端读取/输入及错误入口；I1 接组织与绑定；I2 接远端路由；I3 接 ticket/board。薄组合层不能变成全业务实现。

每一步先有最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已明确生命周期契约不得降为后续优化。

## 验收与交回

WebUI 与 CLI 经相同业务入口得到一致结果；无效调用拒绝；一个可选 adapter 错误不终止整个服务；状态查询无需向 agent 发消息。

证据落在实际 task Workspace 的 v2/evidence/<task>/modules/daemon/，写明公开入口、输入、预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填绝对路径。可重用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力、真实入口记录和下游影响；不以单测或空骨架代替产品可用。模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

