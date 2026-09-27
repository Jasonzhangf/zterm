# zterm DAGpipe 剩余改造计划

状态：计划提案。未提交发布，未改 runtime，未新增 Rust crate，未 bump APK/OTA。
本文件是 Phase 0 之外、剩余产品模块进入 DAGpipe 静态治理和后续运行时接线的总计划。
实施每个切片前仍按项目 `AGENTS.md` 与 `dagpipe-runtime` skill 读真源、确认 owner /
allowed / forbidden paths，再开独立 worktree。

## 1. 当前基线

已完成并验证：

- `pnpm --dir android test:dagpipe-phase0` 通过。
- 6 张图全部 `dagpipe graph validate` / `inspect` 通过：
  - `daemon-mirror-publish.graph.json`
  - `daemon-control-dispatch.graph.json`
  - `android-connection-lifecycle.graph.json`
  - `android-buffer-management.graph.json`
  - `android-buffer-render.graph.json`
  - `android-input-dispatch.graph.json`
- 已产出 `android-phase0-design-slice.md` 中文语义设计，含角色、事件、状态机、
  单/多 session、终态和非法转移。
- 已有 Android Phase 1 goal 提示词：
  `android/docs/dagpipe/android-phase1-goal.md`，用于覆盖上述 6 张图做 Rust core、
  黑盒 parity、接线、重启验证和 review/merge 授权边界；该 goal 尚未执行。

## 2. 已覆盖模块

当前 6 张图覆盖的 owner / 资源边界：

| 领域 | 覆盖模块 | 说明 |
| --- | --- | --- |
| daemon mirror | `daemon.source_adapter`, `daemon.mirror_writer`, `daemon.mirror_store`, `daemon.buffer_publisher` | 镜像捕获、提交、diff/classify、no-hole 发布 |
| daemon control | `daemon.control_gateway`, `daemon.control_center` | 控制入站鉴权、路由、owner 派发 |
| Android 连接 | `client.connection_home`, `client.daemon_connection`, `client.session_runtime`, `client.terminal_channel_mux`, `relay.account_directory`（登录投影部分） | 账号登录、设备 presence、线路解析、单目标 transport、mux、多 session 通道、维持/恢复 |
| Android buffer | `client.wire_ingress`, `client.buffer_frame_assembly`, `client.buffer_store`, `client.sparse_buffer`, `client.renderer_window`, `client.dom_renderer` | head 观察、窗口计划、range 请求、sparse merge、repair ledger、render scope |
| Android 输入 | `client.input_normalizer`, `client.reliable_input`, `client.input_runtime`（提交文本入口） | 纯文本归一、可靠队列计划、发送 |

## 3. 未覆盖模块

按 `android/docs/module-registry.json`、`android/docs/function-map.md` 和
`android/docs/modules/project-modules.md`，下列既有 owner 尚未进入 DAGpipe 静态治理：

| 分组 | 模块 / feature | 主要资源 / 契约 | 当前状态 |
| --- | --- | --- | --- |
| Relay / 路由 / daemon 通道 | `relay.account_directory`, `relay.peer_lease`, `relay.route_selection`, `daemon.connection_gateway`, `daemon.channel_mux`, `daemon.transport_subscriber`, `daemon.session_catalog`, `daemon.session_idle_detection` | `resource.relay_account_directory`, `resource.relay_peer_lease`, `resource.relay_control_connection`, `resource.daemon_connection_gateway`, `resource.daemon_channel_mux`, `resource.transport_subscriber`, `resource.daemon_session_catalog`, `resource.session_idle_facts` | Android 客户端侧连接图已有，daemon 侧 channel/session catalog / peer lease 仍需独立图 |
| Daemon 输入 / 调度 / 会话空闲 | `daemon.input_queue`, `terminal.daemon_input`, `daemon.schedule_runtime`, `terminal.schedule`, `daemon.session_idle_detection` | `resource.daemon_input_queue`, `resource.schedule_job`, `resource.session_idle_facts` | 客户端输入图只覆盖发送侧；daemon ACK/写队、调度、idle 未静态化 |
| 文件 / 截图 / 附件 | `daemon.file_transfer`, `terminal.remote_screenshot`, `daemon.attachment_delivery`, `client.file_browser`, `client.file_browser_ui` | `resource.file_transfer`, `resource.remote_screenshot`, `resource.attachment_store`, `resource.attachment_delivery`, `resource.client_file_browser`, `resource.target_mux_request` | 未进入 DAGpipe |
| Remote window | `daemon.remote_window_stream`, `client.remote_window_overlay`, `client.remote_window_dual_stream_switch`, `desktop.remote_window_stream` | `resource.remote_window_stream`, `resource.remote_window_canvas_layout`, `resource.remote_window_focus_stream`, `resource.remote_window_overview_stream`, `resource.remote_window_touch_action` | 已有详细 function map，但无 DAGpipe 图 |
| Session / shell / UI | `client.app_shell`, `client.terminal_shell`, `client.session_drawer_preview`, `terminal.session_drawer`, `terminal.session_group_layout`, `terminal.session_preview`, `terminal.workspace_panes`, `terminal.copy_mode`, `terminal.quickbar`, `terminal.keyboard_ime`, `terminal.interaction_runtime`, `terminal.shell_actions` | `resource.ui_projection`, `resource.platform_terminal_surface`, `resource.platform_input_channel`, `resource.session_preview_lattice`, `resource.session_preview_mode` | 大量 UI 面，需按业务边而非函数边建模 |
| Plugin / control / settings | `client.composition_root`, `client.control_center`, `client.plugin_host`, `client.settings_update`, `client.settings_update_ui`, `settings.config_transfer`, `connections.config_share`, `connections.history_projection`, `shared.plugin_contract`, `shared.control_contract` | `resource.client_composition_root`, `resource.client_control_center`, `resource.client_plugin_host`, `resource.runtime_node_registry`, `resource.client_settings_update`, `resource.plugin_capability_registry`, `resource.plugin_ui_slot_registry` | 未进入 DAGpipe |
| Release / update / observable | `release.runtime_home`, `release.update_artifact`, `release.daemon_artifact`, `daemon.runtime_entry`（发布入口段）, `observability.debug_channel`, `client.debug_console`, `client.observability`, `daemon.observability`, `shared.debug_contract` | `resource.runtime_home`, `resource.release_update_artifact`, `resource.daemon_runtime_artifact`, `resource.debug_channel`, `resource.observability_channel`, `resource.client_debug_hub`, `resource.daemon_debug_hub`, `resource.debug_snapshot_registry` | 未进入 DAGpipe |
| Android 连接服务 | `client.connection_service`, `client.android_connection_service`, `client.android_notification_sessions` | `resource.client_connection_service_ipc`, `resource.client_service_snapshot`, `resource.android_connection_service`, `resource.android_notification_projection` | 原生前台服务已有 owner map，但未进 DAGpipe |

## 4. 剩余改造分期

顺序原则：先静态 DAG + 中文语义设计并审批；静态通过后才做 Rust core / SDK
`compile()` / `Runtime::run()`；黑盒 parity 通过后才接线；接线后重建、重启并在
真实入口复测。每个 slice 都保留旧 TS 实现到 parity gate 通过。

### Phase 1：现有 6 张图的 Rust core 执行（已审批静态图）

- 依据 `android-phase1-goal.md`，执行 Android 与 daemon 核心 graph 的 Operator 注册、
  `compile()` 校验、black-box parity、薄 bridge 接线、重建/重启验证。
- 这是其他剩余模块运行时接线的依赖基础，因为共享编译/运行模式要先跑通。

### Phase 2：Relay / daemon 连接通道 / 会话目录

新增静态图：

- `relay-account-peer-route.graph.json`
  - 语义：登录 Relay 账号、维护账号/设备目录、解析候选线路、发放/校验 peer lease、
    恢复已绑定 daemon 目标。
  - owner：`relay.account_directory`, `relay.peer_lease`, `relay.route_selection`,
    `client.connection_home`。
  - 禁止：Relay 成为终端正文、tmux、renderer 或客户端活跃状态真源。
- `daemon-connection-channel-catalog.graph.json`
  - 语义：daemon 物理连接入站、channel registry 增删、per-subscriber body 订阅绑定、
    session catalog/list 查询、会话空闲事实发布。
  - owner：`daemon.connection_gateway`, `daemon.channel_mux`,
    `daemon.transport_subscriber`, `daemon.session_catalog`,
    `daemon.session_idle_detection`。
  - 禁止：daemon 持有 active tab、foreground/background、viewport、renderer truth；
    session catalog 不得读取客户端活跃状态决定关闭。

### Phase 3：Daemon 输入 / 调度 / 文件截图 / 附件

新增静态图：

- `daemon-input-schedule.graph.json`
  - 语义：频道输入入队、去重、ACK/NACK、写后端、时间调度任务、会话空闲发布。
  - owner：`daemon.input_queue`, `daemon.schedule_runtime`,
    `daemon.session_idle_detection`, `terminal.daemon_input`,
    `terminal.schedule`。
- `file-transfer-attachment-screenshot.graph.json`
  - 语义：文件浏览目录读取、上传分段 ACK、下载写本机、附件投递、远端截图请求 → 结果。
  - owner：`daemon.file_transfer`, `daemon.attachment_delivery`,
    `terminal.remote_screenshot`, `client.file_browser`, `client.file_browser_ui`。
  - 禁止：客户端猜测 daemon 文件系统；逐 chunk 停等；未经授权把附件回执当消费。

### Phase 4：Remote window 流

新增静态图：

- `remote-window-stream-overlay.graph.json`
  - 语义：镜像目录/流起停、布局与焦点预算、WebRTC 接收、触摸/鼠标动作、截图与质量
    控制、双流切换、浮层投影。
  - owner：`daemon.remote_window_stream`, `client.remote_window_overlay`,
    `client.remote_window_dual_stream_switch`, `desktop.remote_window_stream`。
  - 禁止：把 terminal mirror rows 当视频真相；Android overlay 直接请求 transport；
    客户端持有 daemon 捕获真源。

### Phase 5：Session / shell / preview UI 业务边

新增静态图：

- `android-session-shell-preview.graph.json`
  - 语义：打开/关闭 tab、session 预览 lattice、抽屉选择、焦点平移、group layout、
    workspace pane、copy/quickbar/IME 输入意图、shell 投影。
  - owner：`client.app_shell`, `client.session_runtime`, `client.terminal_shell`,
    `client.session_drawer_preview`, `terminal.session_group_layout`,
    `terminal.session_preview`, `terminal.workspace_panes`, `terminal.copy_mode`,
    `terminal.quickbar`, `terminal.keyboard_ime`, `terminal.shell_actions`。
  - 禁止：UI 直接开 socket、改写 buffer/renderer/transport；hidden pane 保留
    renderer 实例；preview 移动 session 或切换 active shell。

### Phase 6：Plugin / control / settings / config share

新增静态图：

- `android-control-plugin-settings.graph.json`
  - 语义：App 合成、plugin 生命周期/能力注册、控制命令路由/审计、设置与配置分享、
    connections 历史投影。
  - owner：`client.composition_root`, `client.control_center`, `client.plugin_host`,
    `client.settings_update`, `settings.config_transfer`, `connections.config_share`,
    `connections.history_projection`。
  - 禁止：plugin/control 持有 terminal body、session transport、renderer truth。

### Phase 7：Release / update / observability

新增静态图：

- `release-update-observability.graph.json`
  - 语义：构建产物校验 → runtime home 安装 → daemon artifact 解包 → 更新检查/下载/
    安装 → debug 采样/导出/清理。
  - owner：`release.update_artifact`, `release.daemon_artifact`,
    `release.runtime_home`, `observability.debug_channel`, `client.debug_console`,
    `client.observability`, `daemon.observability`。
  - 禁止：src 直接作为 runtime 执行；debug 成为业务控制真源。

### Phase 8：Android 原生连接服务 slice

新增静态图：

- `android-connection-service.graph.json`
  - 语义：前台服务 IPC、desired channel 重放、网络代际校验、通知 action 深链到
    session open、服务快照投影到 UI。
  - owner：`client.connection_service`, `client.android_connection_service`,
    `client.android_notification_sessions`。
  - 禁止：WebView/Activity 生命周期直接重连；服务快照成为终端正文/渲染真源。

## 5. 每个 Phase 的交付物与 gate

每个 phase 必须分两步，不能一步宣称完成：

1. 静态管理面（无需改 runtime）
   - `.graph.json`：中文业务语义节点/边，operator 名/版本绑定。
   - `...graph.json` 通过 `dagpipe graph validate` / `inspect`。
   - 中文设计切片：身份与角色、事件、状态机（含终态/非法转移）、DAG 与数据契约、
     变更边界、单/多 session 解释。
   - `test:dagpipe-phase0` 或扩展后的 dagpipe gate 通过。
   - 独立架构 review PASS。
2. 运行时接线面（仅在静态 gate 与独立 review PASS 后）
   - Rust/crate Operator 注册；`compile()` 校验 ARC/effect contract。
   - black-box parity 覆盖当前 TS 语义。
   - 薄 bridge 接入现有入口；旧 TS 保留到 parity gate 通过。
   - 重建、安装/重启受影响 daemon/client；实际 health/runtime 版本指向已验候选。
   - 适用设备在线时真机 smoke；无设备时明确 `L5 UNVERIFIED`。
   - 本轮新增 artifact、worktree、日志、进程清理后收口。

## 6. 跨切片不变量

- 同一 daemon 目标只维护一个物理 transport；session 是逻辑通道。
- 一个 channel 失败不得连坐同一目标上的 sibling channel。
- 每 session buffer/revision/repair/renderer scope 独立。
- daemon 不持有客户端 session/active/foreground/viewport truth。
- Renderer 不请求 transport、不小概率改写 buffer。
- Repair 未实际写 wire 不得 `dispatched`；frame 未完整无洞不得 apply。
- Relay/peer lease 不存终端正文、channel、tmux、active tab 或 UI truth。
- 发布/更新必须消费已验证 runtime artifact，不能执行 authoring source。
- debug/observability 只观测元数据，不能成为业务控制真源。

## 7. 非目标

- 本计划不授权一次性重写整个项目。
- 本计划不把静态图 or 候选构建冒充已发布/已上线。
- 不删除旧 TS 实现，直到对应 parity gate 证据存在。
- 未获发布授权前不 bump APK、不生成/发放 OTA。
- UI 层只按业务意图和投影建模，不把 React/Java 调用关系当作业务 DAG。

## 8. 消融合并前置任务（2026-09-26 已批准）

在继续新增 Phase 图前，先按 `2026-09-26-dagpipe-ablation-audit.md` 收敛已有
重复语义：

1. Phase2 relay 图已把 `client.relay_account.login` /
   `client.relay_account.publish_device` 固定为 relay 前缀唯一 owner；
   `android.connection_lifecycle` 的 relay 前缀不得再作为第二套真源。
2. `android.connection_lifecycle` 后续改为消费 `arc.route_plan` /
   `arc.resume_plan`，移除重复的登录/发布/线路解析节点；调用方先通过 relay
   gate 拿到线路计划再进入连接建立。当前候选已执行该收敛，并将
   `selected.candidateId` 作为连接建立入参契约。
3. 只有第 1、2 步完成并通过 phase2 parity 后，才允许删除
   `relay-account-peer-route.graph.json` 并更新 `include_str!` / `graphs.len()`
   断言。当前候选保留独立 relay 图，因为 phase2 bridge / TS parity 仍消费
   `account_directory` / `validated_lease` / `resume_plan` 输出契约；删除的
   前置阻断条件是先把这些输出迁入 connection lifecycle 或等价 relay gate
   graph，并同步更新 `compilePhase2` / native bridge / parity 入口。
4. `android-connection-service` 只投影服务快照、desired channel 重放、通知
   action 与 session activity，不重复实现物理连接/维持/恢复。
