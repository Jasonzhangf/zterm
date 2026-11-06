# Zterm V2 基础模块分类与设计思路

状态：架构设计稿，非实现。MVP 范围见 zterm-v2-mvp-handoff.md。David 负责架构与审计；Jenny 负责向可用 peer 分派执行、AppSDK/DAGpipe 治理、正式工作线与集成。

## 1. 分类依据

按“谁拥有哪一类事实、公开什么能力、依赖谁”划分模块，不按网页菜单或 agent 产品名划分整个系统。以下是逻辑边界，不要求每个目录都有独立进程或微服务。现有 V1、Collab 实现通过公开边界复用，正式抽取前验证消费者与错误语义。

### 用户确认的物理模块边界（本轮新增）

账号系统、连接系统、daemon、宿主与 agent 适配、Web UI、各平台客户端必须分别有独立目录、独立设计文件和独立源代码。此前只有 apps/modules/adapters 分类的目录草图不足以表达这一要求，以下结构取代其物理目录建议。宿主与 agent 按不同职责分别成模块；Android/macOS/Windows/Linux 分别成模块。模块独立不等于重复实现基础能力或强制独立微服务。

```text
zterm/v2/
├── modules/
│   ├── accounts/          # relay 账号、认证、注册、机器授权
│   ├── connections/       # 机器目录连接接口、路由、穿透、通道与流控
│   ├── daemon/            # 本机服务组合、API、统一投递与运行管理入口
│   ├── host-adapters/     # tmux、DSH gateway、Codex Desktop bridge
│   ├── agent-adapters/    # Codex、Claude Code、AGY；后续 ACP 会话适配
│   ├── webui/             # Web 视图、workspace 导航、多窗格与画布
│   ├── android/           # Android 客户端及平台能力
│   ├── macos/             # macOS 客户端及平台能力
│   ├── windows/           # Windows 客户端及平台能力
│   ├── linux/             # Linux 客户端及平台能力
│   ├── cli/               # CLI 公开入口
│   ├── organization/      # workspace/group/成员组织
│   ├── goals/
│   ├── tickets/
│   ├── board/
│   ├── members/            # 当前绑定、启动/恢复业务
│   ├── delivery/           # 投递与回执
│   ├── routing/            # 组织名称解析
│   ├── terminal/          # V1 终端基础能力的消费边界
│   ├── status/
│   ├── errors/
│   └── upgrades/
└── docs/                  # 系统总览、跨模块依赖与公共决策
```

每个模块采用同一最小结构：

```text
<module>/
├── DESIGN.md              # 本模块需求、owner、接口、数据、错误与升级边界
├── src/                   # 唯一实现；公开入口与私有实现区分
└── tests/                 # 本模块真实契约与必要行为测试
```

构建/包描述文件按选定语言增加，不预定所有平台使用一种语言。模块专属 DAG/gate 描述随模块文档归属保存，AppSDK 项目级 maps 引用实际路径；不为每模块复制整套 AppSDK 项目。共享协议在实际 owner 的公开接口中定义，避免逐渐形成无归属的 shared 巨型包。跨模块只能依赖公开契约，不能直接 import 私有实现或写对方存储。

accounts 的服务器实现与 CLI/Web 账号客户端通过协议分离，不能把服务器凭据验证代码打包给浏览器。connections 提供平台端口；Android/桌面模块实现必要 native backend，不各写路由策略。daemon 组合已有模块，不再内嵌另一份 accounts/connections/adapters。

本轮只确认物理归属与设计落点；正式根及独占工作线未就绪，源码与构建骨架须按既定 UX/MVP 审计顺序由 GCM 落地。不得用空目录或拷贝 V1 代码宣称模块已实现。

正式根现已选定为现有 zterm 仓库内 v2/；见 [根目录决策](decisions/product-root.md)。目录选型不再等待用户决定；LayerFS 执行条件及 Jenny 实际建立工作线仍需落实。

## 2. 基础层与业务层

| 层 | 模块 | 唯一责任 | 不能拥有 |
| --- | --- | --- | --- |
| 账号与信任 | relay identity | 账号、注册、认证凭据、登录会话、撤销 | agent 会话、tmux、ticket、终端正文 |
| 机器登记与授权 | relay directory/access | 机器归属、daemon 身份、公示端点、在线观测、机器访问授权 | workspace 内部完整组织树、成员忙闲判断 |
| 连接与穿透 | machine-link | 按授权解析机器、选择路径、建立并维护物理连接 | 成员角色、ticket 完成、宿主 session |
| 逻辑通道 | channels | 在健康链路上承载控制/状态/通知/终端/文件，处理各通道背压 | 对正文推断权限、重复身份注册 |
| 成员身份与绑定 | member-binding | 稳定成员到当前机器、宿主、会话和 anchor 的关联 | 机器登录凭据、终端缓冲 |
| 统一投递 | delivery | daemon 受理、路由、交给宿主、回执和结果查询 | ticket 业务状态、按屏幕内容判完成 |
| 宿主适配 | host-adapters | tmux / DSH / Codex Desktop 的正式投递和状态接口 | 自己实现 NAT 穿透、统一捏造 busy/idle |
| agent 会话适配 | agent-adapters | Codex / Claude Code / AGY 的实际会话与恢复能力，后续 ACP | 组织层级、机器通信、账号权限策略 |
| 状态查询 | status | 组合各 owner 的有来源、有新鲜度状态并订阅变化 | 第二份身份/投递/任务状态机 |
| 组织业务 | organization | workspace、group 层级、成员归属、连接/合并关系 | 机器物理连接、agent 生命周期内部实现 |
| 工作业务 | goals / tickets / board | 目标、统一追踪载体及 manager 查询视图 | IM 成功即任务完成、board 重存 ticket |
| 终端数据 | terminal | 复用 V1 source/mirror/publisher/buffer/renderer 边界 | 组织和 agent 心智进入 mirror |
| 客户端视图 | workspace-navigation / session-layout | 可见 workspace、主窗格、网格、焦点、手机画布与布局保存 | 改变 manager/peer 角色、关闭后台成员 |
| 横向基础 | errors / upgrades / configuration | 统一错误入口、独立组件升级、声明配置 | 吞错、隐式 fallback、替业务 owner 决策 |

## 3. 三类身份必须分开

1. Account：谁有权管理或使用资源。由 relay identity 管理。
2. Machine/Daemon：请求到达哪个运行节点、当前连接是否有效。由机器登记和 machine-link 管理。
3. Member/Agent session：哪个组织成员、其当前执行会话在哪里。成员稳定身份与临时 session/anchor 分开，由组织和绑定 owner 管理。

同一个账号可以使用多台机器；一台机器可以授权给不同账号；一个 group 可以跨机器。后两者是建议模型，访问授权规则需核实 V1 与用户确认，不能从“同账号可见”推导为“所有账号可用”。

## 4. 正式依赖方向

```text
CLI / Web / manager 编排
    → 目标、ticket、组织等公开业务能力
    → daemon 统一投递 / 状态入口
    → 成员名称解析与当前绑定
    → 同机宿主适配，或 machine-link → 远端 daemon → 宿主适配
    → agent 会话能力

machine-link
    → relay 账号与机器目录的授权查询
    → V1 路由、信令、直连/转发和通道能力

Web sessions 视图
    → layout owner
    → terminal 公开端口
    → V1 buffer / renderer / 数据链路
```

relay 不需要在读取终端时参与每一个数据帧；必须参与哪些授权、目录或信令步骤由现有路径与新契约决定。所有成员投递仍由 daemon 统一受理。直连数据通道不绕过账号和目标 daemon 的授权。

## 5. 账号与业务权限的两道边界

relay 只证明账号身份及能否到达/使用目标机器；目标 daemon 验证该账号是否能操作对应 workspace、成员、ticket 或终端。两个边界不能互相冒充：能列到机器不等于可向所有成员输入。可以使用同一认证基础，但资源授权仍由明确资源 owner 执行。

权限必须通过 typed 授权事实传递，不放在 ticket 正文或从 manager 名字推断。主界面配置权限时，调用各自授权 owner，不由前端合成允许结果。

## 6. AppSDK 与 DAGpipe 的职责

AppSDK 纳管已确认需求、逻辑模块/资源 owner、公开接口与其验证关联。提案单独标明，不能因写入架构稿就升级为用户已确认需求。正式根尚未建立，当前文档不是已完成 AppSDK 初始化。

DAGpipe 以业务对象流管理图和 gate 关系：账号注册、登录/注销、机器登记/撤销、目录授权、连接建立、成员投递、成员状态、会话恢复分别由入口到结果闭合。静态 validate/inspect 仅证明拓扑和绑定语法；实际 operator、输入输出 schema、允许副作用和黑盒行为必须在实现时验收。

现有讨论图在 foundation-run/member-delivery.graph.json 与 member-status.graph.json，均使用 design-unbound operator；不得作为产品 PASS。源码文本匹配、哈希包装、冻结链不进入日常 gate。

## 7. 分层骨架落地顺序（不是 MVP 派单）

先确认账号与机器信任模型 → 明确机器通信/通道契约 → 明确成员绑定与宿主能力 → 明确统一投递及状态语义 → 接入组织/目标/ticket → 接入 Web 多窗格。每层只依赖已确认的下层契约；接口未知只停受影响部分。

按用户最新明确的 MVP 范围准备执行包。相关 UX 和 MVP 方案审计通过后由 Jenny 派发实现。正式代码目录使用 Jenny 提供的独占工作线，不能写 V1 dirty 主树或把旧 Android runtime-v2 的治理记录当成新 V2 骨架。

## 8. 可独立演进的具体方式

- daemon、CLI、Web 可以分别发布；与对端协商协议版本和能力。
- 宿主/agent adaptor 依赖稳定接口，可单独升级，不复制通信底座。
- 传输后端可以调整 V1 复用结构，但不改变投递完成和状态含义。
- 模块私有存储由自身迁移，不允许其他模块直接改表。数据库物理拆分不作为首期前提。
- 兼容适配放在边界，保留一个业务 owner；退役条件明确，不长期维护两套同义链路。
- 动态热替换和无停机升级尚未确认，不作为当前设计承诺。
