# V2 正式根与模块结构决策

David，2026-11-02（用户时区）。用户已明确由总设计师决定项目结构。本决定取代前述“正式根等待用户/CEO 在新仓库与旧仓库之间裁决”的待定项。Jenny 审收后负责执行；本文交付设计，不宣称目录、工作线或治理已建立。

## 1. 决定

采用现有 Git 仓库 Jasonzhangf/zterm 内的独立 `v2/` 产品根。不新建远端仓库，不创建另一条长期 Git main，不把 V2 放进 android/ 或旧 runtime-v2。V1 与 V2 共享 Git 历史和集成主线，产品源码、设计、构建、协议边界与发布入口分别独立。

| 对象 | 确定位置/标识 | 状态 |
| --- | --- | --- |
| Git 远端 | https://github.com/Jasonzhangf/zterm.git | 当前实查，沿用 |
| LayerFS 项目标识 | zterm | 沿用现有配置，不建第二个同仓 Store |
| master Git 基线 | /Volumes/extension/layerfs/zterm/main | 已存在，当前 git status 无改动；禁止当开发目录 |
| 基线中的 V2 产品根 | /Volumes/extension/layerfs/zterm/main/v2 | 目标落点，尚未创建 |
| 日常仓库投影中的 V2 根 | /Volumes/extension/code/zterm/v2 | 集成后自然出现；当前树有 V1 dirty，不在此直接落源码 |
| 执行工作根 | Jenny 分配的独占 LayerFS Workspace 内 /v2 | 实际 mount 路径由正式入口返回，不虚构路径 |
| V2 需求/治理作用域 | v2/.appsdk；产品名 zterm-v2 | 目标作用域，由 Jenny 验证工具支持并建立，不覆盖 Android 治理 |
| 项目 Skill | v2/.agents/skills/zterm-v2-architecture/SKILL.md | 待正式迁入，通过 v2/AGENTS.md 路由加载 |

产品名 zterm-v2 与 LayerFS 仓库项目名 zterm 是不同层次。Collab 执行协调继续使用现有 zterm 项目，不因新产品目录重复注册 peer、改变 daemon 或 tmux 生命周期。AppSDK 的实际初始化能力如不支持所述子产品作用域，Jenny 应返回工具原错，由架构调整映射；不能覆盖旧治理或伪称纳管完成。

## 2. 取舍

| 候选 | 结论与理由 |
| --- | --- |
| 同仓 v2/ 独立产品根 | 选用。V1 复用 owner 与 V2 consumer 可在一批变更中审计；既有远端、Git owner 和 LayerFS 标识可复用；独立模块不要求独立仓库 |
| 新建 zterm-v2 远端仓库 | 暂不选。首期需额外建立远端、版本化公共包和跨仓依赖发布，当前没有独立团队/许可/发布需求证明该成本必要 |
| android/v2 或覆盖旧主树 | 不选。会混淆 Android runtime-v2 与新产品，耦合旧客户端构建和治理 |
| 长期 V2 Git 分支/另一独立 main | 不选。容易形成两套共享基础代码和长周期合流；任务隔离使用 LayerFS 分支即可 |

未来若需要独立仓库，可从 v2/ 边界迁出并将 V1 公共能力先正式发布；不是首期预建第二套结构的理由。

## 3. 唯一目录结构

```text
zterm/
├── android/ mac/ win/ packages/   # 现有 V1 owner，保持归属
└── v2/
    ├── AGENTS.md                  # V2 作用域与 Skill 路由
    ├── README.md                  # 产品入口与当前交付状态
    ├── .appsdk/                   # V2 需求/接口治理，Jenny 建立
    ├── .agents/skills/zterm-v2-architecture/SKILL.md
    ├── docs/
    │   ├── architecture.md
    │   ├── decisions/             # 含本正式根决策
    │   ├── interfaces/            # 跨模块合同
    │   ├── mvp/                   # 范围、执行和组合验收
    │   └── ux/                    # 规范、静态 HTML、审计
    └── modules/
        ├── accounts/
        ├── connections/
        ├── daemon/
        ├── host-adapters/
        ├── agent-adapters/
        ├── webui/
        ├── android/
        ├── macos/
        ├── windows/
        ├── linux/
        ├── cli/
        ├── organization/
        ├── goals/
        ├── tickets/
        ├── board/
        ├── members/
        ├── delivery/
        ├── routing/
        ├── terminal/
        ├── status/
        ├── errors/
        └── upgrades/
```

每个物理模块的共同结构为 `DESIGN.md`、`src/`、`tests/`。DESIGN 列需求、事实 owner、公开端口、私有存储、允许依赖、错误与升级兼容、真实入口验收。实现及构建描述按该模块语言落地，不强制各平台一种语言。未进入首轮的平台和 upgrades 先有明确设计归属，按执行计划创建源码；不以空目录冒充已实现。

不另造无 owner 的 shared 全能模块。公开协议由相应 owner 导出，consumer 仅引用公开契约。daemon 是组合入口，不包含 accounts/connections 的第二份实现。每模块 DAG/gate 随模块归属；跨模块组合图属于产品 docs 下明确位置，由 Jenny 的 AppSDK 映射引用，不复制 Android 旧图当 V2 新行为。

## 4. V1 复用与兼容

- 首期通过已声明公开 API 或发布包复用 V1 relay、连接、terminal；需要抽取时改 V1 唯一 owner，在同批中验证 V1 和 V2 两个消费者。禁止 import android 内部实现作为永久快捷路径。
- wterm 继续以发布包消费；不复制 runtime 源码到 v2/。
- 账号迁移不随目录初始化执行。V1 用户 ID/密码验证兼容、旧 token 与 daemon authToken 的转换沿 accounts 专项设计；禁止重建账号库或隐式清除凭据。
- 新旧协议在边界协商版本/能力，未知能力显式 unsupported。V1 /app 尚未接通完整穿透链，不可因同仓复用声称 V2 已跨机可用。
- v2 使用独立构建入口与产物名。根目录现有 Android 默认命令保持；不能新增 v2 后让 V1 CLI、OTA 或启动入口静默改道。平台模块复用基础能力，不复制路由或账号实现。
- 布局与组织配置使用 V2 声明命名空间；静态 HTML localStorage 只是演示，不迁作生产组织真源。

## 5. Jenny 执行顺序与真实条件

当前实查：zterm Git 基线存在且干净；主工作树存在 V1 未提交修改；现有 LayerFS 配置位于 ~/.config/layerfs/projects/zterm.env，项目 zterm，Store 路径指向 colima-layerfs 宿主 Docker volume。`colima status --profile layerfs` 返回 `colima [profile=layerfs] is not running`。未启动服务、未检查或宣称运行镜像/Store 可用。

1. 审收本决策，更新 plan/acceptance 中“根待裁决”为“根已定，运行环境待准备”。不再向用户索要目录选型。
2. 沿现有 LayerFS 正式入口核实并准备运行条件；daemon/VM 生命周期由对应 owner 按实际授权处理。本文件不授权重启生产服务。运行环境未就绪只停工作线执行，不停设计。
3. 用干净 Git 基线同步现有 zterm LayerFS main，再建立独占 V2 bootstrap task branch；禁止写 master 基线目录、dirty 主树，禁止退回新 Git worktree。
4. 在 task Workspace 内建立 v2/ 设计骨架，迁入权威设计、Skill 和 AGENTS 路由。模块源代码由相应执行合同推进。Git 元数据仍由 Jenny 唯一管理。
5. 在 v2 产品作用域准备 AppSDK 材料，按实际工具准入建立；DAGpipe 按真实对象流绑定。归档前文档检查不冒充运行 gate；不能伪造 prepare 确认。
6. 修正所有本地链接，记录唯一维护路径；必要本地检查后按 LayerFS publish/Git 集成流程交付。未集成前不要声称正式源码已存在。

## 6. 设计材料迁入映射

当前交接包根为本文件目录。以下是目标路径，不是已迁移证明：

| 当前文件 | v2 内唯一维护位置 |
| --- | --- |
| zterm-v2-root-decision.md | docs/decisions/product-root.md |
| zterm-v2-architecture-draft.md | docs/architecture.md |
| zterm-v2-foundation-modules.md | docs/module-boundaries.md |
| zterm-v2-mvp-interface-contracts.md | docs/interfaces/mvp-contracts.md |
| zterm-v2-mvp-handoff.md | docs/mvp/scope-and-handoff.md |
| zterm-v2-relay-account-design.md | modules/accounts/DESIGN.md |
| zterm-v2-ticket-design.md | modules/tickets/DESIGN.md |
| zterm-v2-ux-design.md / prototype.html / ux 审计 | docs/ux/ 对应文件 |
| skills/zterm-v2-architecture/SKILL.md | .agents/skills/zterm-v2-architecture/SKILL.md |

Emma 活动中的大屏修订由她交回后再迁，不能复制一份继续并行编辑。Jenny 原执行 plan/acceptance 纳入 docs/mvp，保持她为执行计划 owner。旧交接包留作历史证据并停止维护，迁入回执应给出正式唯一入口。没有要求删除历史证据或其他人目录。

## 7. 不可逆或破坏性动作

本决定本身及新增独立目录不要求破坏性动作。不需要删除 V1、重写 Git 历史、新建公开远端、迁移生产账号、替换 daemon 或终止 tmux。

若后续提出这些动作，分别列明目标、影响、回退和必要明确授权；不能引用本结构决策代替授权。常规已授权的 task branch、设计迁入和正常集成按现有流程执行，不追加用户目录确认。

## 8. 设计一致性依据

- [基础模块](../module-boundaries.md)
- [接口合同](../interfaces/mvp-contracts.md)
- [MVP 范围](../mvp/scope-and-handoff.md)
- 分包 R2 审计

本次无产品运行路径变化，不新建业务 DAG；正式实现的对象流仍由 Jenny 落图与绑定 gate。
