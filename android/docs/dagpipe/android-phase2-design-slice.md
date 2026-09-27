# Android DAGpipe Phase2 设计切片

状态：静态治理设计稿已通过 graph validate/inspect，Rust core 已实现
`phase2_core` 的 Operator 注册与 black-box 测试；尚未接入 daemon/client 真实
入口，也未切换旧 TS 实现。

## 范围

Phase2 覆盖 Relay 账号/设备目录/线路解析/peer lease/恢复已绑定目标，以及
daemon 物理连接入站、channel registry、subscriber 绑定、session catalog 与
idle facts。

## 角色与身份

- `relay.account_directory`：Relay 账号登录与设备目录投影，不保存终端正文、
  tmux、channel、active tab 或 UI truth。
- `relay.peer_lease`：发放与校验 peer lease；lease 只绑定设备/daemon 目标，
  不保存终端正文或 UI 活跃状态。
- `relay.route_selection`：候选线路解析与优先级选择，只消费账号目录与设备
  presence。
- `client.connection_home`：把已绑定目标恢复为客户端的连接意图，不拥有
  daemon 的内部状态。
- `daemon.connection_gateway`：物理连接入站与鉴权边界。
- `daemon.channel_mux`：同一物理连接上的逻辑 channel 注册表与开闭。
- `daemon.transport_subscriber`：per-subscriber body 订阅绑定与资源释放。
- `daemon.session_catalog`：daemon 已知 session 目录列表，不读取客户端
  active/foreground/viewport truth。
- `daemon.session_idle_detection`：发布会话空闲事实，不得决定客户端 UI。

## 事件

- `relay.account_peer_route`：login → publish_device → project_account_directory
  → resolve_candidate_routes → issue_peer_lease → validate_peer_lease →
  bind_daemon_target → resume_bound_target。
- `daemon.connection_channel_catalog`：入站连接 → 鉴权/建立 channel →
  注册 subscriber/body 订阅 → session catalog/list 查询 → 会话空闲事实发布。

## 状态机

Relay 登录：

- `anonymous/offline` → `logging-in` → `logged-in` 或 `login-failed`。
- 任何未通过服务端鉴权的结果不得投影为 `logged-in`。
- 失效/过期 lease 必须显式失败，不得静默复用或伪造成功。

物理连接：

- `awaiting-connect` → `connecting` → `established`。
- `established` 上可开/关多个逻辑 channel。
- 最后一个 subscriber 消失时释放对应 daemon-owned mirror 资源，但不 kill
  tmux session；同一目标仍有其他 attach 时保留 mirror 与 subscriber。

## 单 session 与多 sessions

- 单 session：一条物理 transport 对应一个逻辑 channel，body 订阅、buffer、
  repair 只作用于该 session。
- 多 sessions：同一 daemon 目标只维护一条物理连接，多 session 以逻辑 channel
  隔离；一个 channel 失败不得连坐同目标的 sibling channel。

## 终态与非法转移

- `login-failed`、`lease-expired`、`channel-closed`、`transport-detached` 是
  显式终态/失败终点。
- 禁止从 `login-failed` 或 `lease-expired` 直接跳到 `logged-in`/`bound`。
- 禁止 daemon 读取客户端 active tab/foreground/viewport 决定关闭 session
  channel；禁止客户端从 service 快照重建终端正文/渲染真源。

## 连接维护与 buffer 角色边界

连接建立/维持/恢复归客户端连接服务与 daemon 网关共同闭合，但两者职责分层：

- 客户端连接服务负责建立、心跳、恢复代际、单/多 session 需求投影；每次物理失败都
  产生新代际，旧代际事件不得再影响当前快照。
- daemon 网关只负责物理 transport 入站、mux 协商、channel registry 与 body
  订阅绑定；不持有 active/foreground/viewport、逻辑 client session 或
  renderer 可见窗口。
- 单个 session 对应一条逻辑 channel；多个 session 共享同一物理 transport。
  一个 channel 关闭只释放该 channel 的 body 订阅、pending 请求与 buffer 资源，
  不关闭 sibling channel，也不 kill tmux session。

Android buffer 管理与渲染角色保持独立：

- buffer 管理按 session 维护 sparse truth、revision epoch、repair ledger；
  renderer 只声明可见范围，不发起 transport。
- 只有完整、连续、无洞 frame 可以被 sparse apply 并触发正文 repaint；frame
  拒绝时保留 exact repair range，未实际写入 wire 前始终保持 `pending`。
- inactive/tab switch/foreground-background 不销毁 buffer truth，也不关闭
  transport；session 显式关闭或物理 transport 销毁时才释放对应 buffer/body
  订阅资源。

## 数据契约

- `resource.relay_account_directory`
- `resource.relay_peer_lease`
- `resource.relay_control_connection`
- `resource.daemon_connection_gateway`
- `resource.daemon_channel_mux`
- `resource.transport_subscriber`
- `resource.daemon_session_catalog`
- `resource.session_idle_facts`

## 验收

- 两张 graph 通过 `dagpipe graph validate/inspect`。
- 扩展后的 dagpipe gate 全部通过。
- 独立架构 review 对静态设计 PASS 后，才进入 Rust Operator/parity/接线。
- 接线前旧 TS 实现保留；parity 通过后再切换薄 bridge 为 active path。
