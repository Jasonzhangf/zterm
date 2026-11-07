# accounts 模块设计与执行卡

状态：2026-11-06 workspace authorization adapter 工作线。V2 accounts adapter
已接 V1 relay account/machine 正式端点，并新增账号授权策略与 workspace/machine
公开适配入口；代码级正反例与真实 relay 集成已验收。产品组合仍由 integration
owner 负责。

本卡是 accounts 模块的结构和联调合同。正式根为 `v2/modules/accounts/`；Jenny
负责派具体 peer、建工作线和集成。实际进度只在
[执行总表](../../docs/mvp/module-execution.md)更新，本卡保留本轮证据基线。

## 文件结构与责任

```text
accounts/
├── DESIGN.md
├── src/
│   ├── public/contracts.ts          # 公开入口与类型
│   ├── domain/accounts.ts           # 账号与 AuthContext
│   ├── domain/authorization.ts      # workspace/成员授权记录与上下文
│   ├── domain/login-sessions.ts     # 会话记录
│   ├── domain/machines.ts           # MachineRef 与状态
│   ├── application/auth-service.ts  # register/login/logout/verifySession
│   ├── application/workspace-authorization.ts # verify/bindCreatedWorkspace
│   ├── application/accounts-authorization.ts  # authorizeMachine adapter
│   ├── application/machine-service.ts # enroll/list/possession/revoke
│   ├── ports/account-directory.ts   # account-scoped directory read
│   ├── ports/account-authorization-store.ts # 授权策略持久化边界
│   ├── ports/machine-registration.ts # machine challenge/verify/revoke
│   ├── ports/relay-authority.ts     # auth authority boundary
│   ├── adapters/v1-relay.ts         # V1 relay HTTP adapter
│   └── adapters/file-account-authorization-store.ts # single-writer JSON store
└── tests/
    ├── contract/                    # 当前契约的必要正反例
    └── integration/                 # 真实 V1 relay consumer
```

目录名表达职责；扩展名与构建描述由实现语言确定。无需为了目录完整创建无消费者的
空文件。公开入口在 `public/`，私有实现不能被跨模块直接引用。

## 公开接口、数据及错误

- `AuthService.register` 委托 `POST /api/auth/register`，只返回账号身份，不签发本地
  会话。
- `AuthService.login` 委托 `POST /api/auth/login`，使用 relay 返回的 access token。
- `AuthService.verifySession` 委托 `GET /api/auth/me` 复核当前 bearer。
- `AuthService.logout` 委托 `POST /api/auth/logout`，由 relay 撤销 bearer；之后同一
  token 的复核和机器操作返回 `AUTHENTICATION_REQUIRED`。
- `createFileAccountAuthorizationStore` 提供 accounts-owned 持久授权策略的
  `getGrant` / `putGrant` / `deleteGrant`。记录以稳定 `accountId` 为主体，以稳定
  workspace/member ID 为资源；不保存密码、relay session 副本或机器 token。
- `createWorkspaceAuthorization` 的 `verify(token)` 先复核 relay session，再读取当前
  账号授权记录。无有效 session 返回 `AUTHENTICATION_REQUIRED`；无授权记录返回
  `WORKSPACE_AUTHORIZATION_REQUIRED`；上下文与 `AuthContext` 分开返回，包含
  `accountId/scopes/workspaces/members`。
- `bindCreatedWorkspace` 只允许已验证且拥有 `org:write` 与显式
  `allWorkspaces` 管理授权的账号绑定新建 workspace。它把稳定 workspace ID 写入
  accounts-owned 记录；普通账号或缺失该管理授权返回 `WORKSPACE_FORBIDDEN`，不
  自动授予全部 workspace。
- `createAccountsAuthorizationPort` 在已验证账号范围内调用
  `MachineService.listAuthorizedMachines`，只接受 canonical active machine，并从
  typed `MachineRouteSource` 取得 endpoint/settings。只有 route 与 target 的非空
  `daemonHostId` 一致时才返回 `AuthorizedMachineLink`；缺证明或身份不一致返回
  `MACHINE_IDENTITY_UNVERIFIED`。`authorizationId` 是非秘密 opaque 引用。
- `MachineService.listAuthorizedMachines` 读取账号范围内的
  `GET /api/machines`。
- `MachineService.enrollMachine` 委托 enrollment challenge/verify，并保留同设备
  proof 幂等、同设备不同 proof `MACHINE_DEVICE_CONFLICT`、跨账号
  `MACHINE_ALREADY_OWNED` 的 canonical 语义。
- `MachineService.verifyMachinePossession` 委托 possession challenge/verify，保留
  `POSSESSION_INVALID`、`MACHINE_REVOKED`、`MACHINE_NOT_FOUND`。
- `MachineService.revokeMachine` 委托 owner-only
  `POST /api/machines/:machineId/revoke`，非 owner 保持 `MACHINE_NOT_OWNED`。
- 跨账号 grant/revoke 仍显式返回 `CROSS_ACCOUNT_ACCESS_DISABLED`；V2 不新增第二
  套账号或机器真源。

401/403、404、409、429 分别映射为 typed `AccountsError`；新增 workspace
授权缺失/禁止和机器身份未证明错误分别使用
`WORKSPACE_AUTHORIZATION_REQUIRED`、`WORKSPACE_FORBIDDEN`、
`MACHINE_IDENTITY_UNVERIFIED`。adapter 保留
`upstreamStatus`、`upstreamCode`、`upstreamMessage` 和传输/解析 cause。畸形 403
响应按 `RELAY_PROTOCOL_ERROR` 处理，不伪报 session revoked。

## 依赖与联调

无业务模块硬依赖；平台/存储由声明端口注入，鉴权在公开调用边界落实。V1 relay 仍是
账号、会话、目录和机器归属的唯一权威。`connections` 只得到授权候选；浏览器不能读取
服务器验证材料。机器路由配置由 route owner 注入，accounts 只读其 identity
证明字段，不复制连接配置真源。

真实 relay 证据：
`v2/evidence/zterm-v2-accounts-relay-wiring-1103-r1/README.md`。集成测试启动隔离
V1 relay 子进程并走真实 HTTP，不用 in-process 伪 relay。

## 开发顺序

先贯通 relay 登录、目录和机器身份链；再与 connections 和 daemon 组合。每一步先有
最小真实可用能力再组合，不等待该模块所有远期功能完成。错误、权限、数据正确性与已
明确生命周期契约不得降为后续优化。

## 验收与交回

I1：合法/错误凭据；`/me` 可查询；logout 后 bearer 拒绝。I2：授权机器可见、
未授权不可见；enroll/possession/owner revoke 全链可用；跨账号 proof 冲突和撤权后
拒绝保持 canonical typed error。I3：有效 session + 显式 grant 可得到 workspace
上下文；logout/无 grant/跨账号拒绝；created workspace 只绑定有 `org:write` 的
all-workspaces 管理账号；机器身份证明缺失或 route/target 不一致拒绝。

证据落在实际 task Workspace 的
`v2/evidence/<task>/modules/accounts/` 或本任务专属证据目录，写明公开入口、输入、
预期/实际、必要反例及相关版本；不得保存秘密。目录只是目标落点，Jenny 派单时填
绝对路径。可复用有效证据，只有接口/配置/实现变化才重验受影响部分。

交回 DESIGN 与代码差异、未实现能力和真实入口记录；不以单测或空骨架代替产品可用。
模块升级只改本 owner 的存储/实现，公开契约变化先交 David 审计。

专项依据：[已有设计/证据](../../zterm-v2-relay-account-design.md)。
