# zterm Android Architecture

## 真源层级

1. `spec.md`：产品范围
2. `architecture.md`：模块边界
3. `docs/decisions/0001-cross-platform-layout-profile.md`：跨尺寸布局 / Mac 共享壳决策
4. `docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md`：terminal head / sparse buffer / render container 唯一真源
5. `docs/decisions/2026-04-28-terminal-transport-session-lifecycle-truth.md`：terminal client session / transport 生命周期真源（daemon 不持有客户端逻辑）
6. `docs/decisions/2026-04-22-session-schedule-timed-send.md`：per-session 定时发送 / heartbeat 调度真源
7. `docs/decisions/2026-04-28-remote-screenshot-helper-truth.md`：remote screenshot daemon 唯一真源（文件名沿用历史编号）
8. `docs/decisions/2026-07-19-remote-window-stream-truth.md`：remote window stream / iTerm2 pane coordinate / input return 真源
9. `docs/decisions/2026-08-07-opencode-transcript-mirror-truth.md`：opencode transcript 数据导出 / daemon 只读服务 / client 历史投影真源（独立于 mirror store）
10. `dev-workflow.md`：执行门禁
10. `task.md`：当前任务
11. `CACHE.md`：短期上下文
12. `MEMORY.md`：长期经验
13. `evidence/`：运行证据
14. `.agents/skills/terminal-buffer-truth/SKILL.md`：terminal buffer / render / scroll 真源规则
15. `docs/resource-registry.json` / `docs/resource-map.md`：全局资源真源与人读面
16. `docs/module-registry.json` / `docs/modules/project-modules.md`：daemon/client/shared/relay/release/observability 模块真源
17. `docs/edge-registry.json`：跨模块资源边真源
18. `docs/wiki/modules.md`：模块/边 wiki review 面

## 模块边界

跨模块长期边界先看 `docs/modules/project-modules.md`。机器门禁是 `docs/module-registry.json` 和 `docs/edge-registry.json`。任何跨 daemon/client/shared/relay/release/observability 的重构，必须先补资源、模块、边，再补 function map / mainline call map，最后改 runtime。代码级 import 边界由 `src/lib/module-import-graph-truth.test.ts` 强制：每个 src 源文件必须恰好归属一个模块（`owned_paths`），每条跨模块 import 必须命中 `edge-registry.json` 的 `import_edges`；该 gate 已接入 `test:feature-registry`、CI 与 `prebuild`。

- UI/App：页面、表单、列表、终端布局
- Layout/Presentation Shell：layout profile、pane 编排、safe-area / density token
- Storage：主机配置与运行态持久化
- Session/Transport：WebSocket、tmux bridge 会话状态
- Session/Transport 不变量：
  - `bridge target = bridgeHost + bridgePort + authToken`
  - `client session` 是客户端稳定业务对象，不是 transport
  - daemon **不关心也不能关心任何客户端逻辑/状态机**
  - daemon 不允许持有 `logical client session / clientSessionId owner / readyTransportId / active tab / foreground / background / viewport / pane`
  - `adaptive-phone` 只允许进入 daemon 的唯一 adaptive width lease owner：按物理 transport subscriber 记录 `{ cols, heartbeatAt }`，聚合 active adaptive subscribers 的最窄 cols，并只在该 owner 内请求 tmux 按宽度重排；不得把 client viewport policy 扩散成 session/mirror/client 状态
  - 除 adaptive width lease owner 外，协议兼容字段只允许作为一次性 attach 入参，不得在 daemon 内部成为长期状态真相
  - active / inactive 只影响客户端取数频率，不影响客户端 session / transport 身份
  - foreground / background / tab switch 不得成为客户端 fresh recreate transport 的理由
- Schedule/Automation：per-session 定时任务定义、下次触发时间计算、启停与结果状态
- File Transfer：`client.file_browser` 只拥有文件浏览投影、请求和有界流控；`client.runtime` 的 native storage plugin 只拥有本地文件字节；`daemon.file_transfer` 只拥有远端文件状态和累计 ACK。文件同步必须走现有 target mux/physical transport，不得新建 session 或 WebSocket。
- File Transfer UI：`client.file_browser` 同时拥有 `resource.file_browser_ui_contract`，`terminal.file-browser` UI slot 由 `FileBrowserUiPlugin` 经 plugin host 提供；App/TerminalPage 只读取 typed slot render callback，TerminalPage 不再直接 import/render `FileTransferSheet`。file transfer 的 wire/send 与 open/mode shell intent 仍由 TerminalPage 的既有 owner 传入 callback props。
- Settings Update UI：`client.settings_update` 同时拥有 `resource.settings_update_ui_contract`，`settings.update` UI slot 由 `SettingsUpdateUiPlugin` 经 plugin host 提供；App/SettingsPage 只读取 typed slot render callback，SettingsPage 不再直接 import/render `AppUpdateSection`。settings/config/update 的 hook 与 runtime 仍由既有 owner 传入 callback props。
- Remote Window UI：`client.remote_window_ui` 拥有 `resource.remote_window_ui_contract`，`terminal.remote-window` UI slot 由 `RemoteWindowUiPlugin` 经 plugin host 提供；App/TerminalPage 只读取 typed slot render callback，TerminalPage 不再直接 import/render `RemoteWindowOverlay`。remote-window 的 catalog/stream/quality/touch/session callback 仍由 TerminalPage 的既有 owner 传入 callback props。
- Quickbar UI：`client.quickbar_ui` 拥有 `resource.quickbar_ui_contract`，`terminal.quickbar` UI slot 由 `QuickBarUiPlugin` 经 plugin host 提供；App/TerminalPage 只读取 typed slot render callback，TerminalPage 不再直接 import/render `TerminalQuickBar`。quickbar 的 action/IME 输入仍由 TerminalPage 的既有 owner 经 `platform_input_channel` 传入 callback props，TerminalQuickBar 组件仍由 `client.input_runtime` 拥有其输入契约表面。
- Terminal Shell UI：`client.terminal_shell_ui` 拥有 `resource.terminal_shell_ui_contract`，`terminal.shell` UI slot 由 `TerminalShellUiPlugin` 经 plugin host 提供；App/TerminalPage 只读取 typed slot render callback，TerminalPage 不再直接 import/render `TerminalConnectionStatusStrip`、`TerminalPageCopyMenu`、`TerminalPageStageShell`、`terminal-page-shell-ui`、`TerminalQuickBarShell` 或 `TerminalNetworkBanner`。status/stage/copy/quickbar-shell 的 shell projection props 仍由 TerminalPage 的既有 owner 传入 callback props，terminal shell 组件仍由 `client.terminal_shell` 拥有其实现表面。
- 上述 UI 插件名称是 `module_id`，其资源唯一 owner 由 `docs/module-registry.json#owned_resources` 机器锁定：`resource.client_file_browser -> client.file_browser`、`resource.client_native_file_store -> client.runtime`、`resource.file_transfer -> daemon.file_transfer`、`resource.remote_window_ui_contract -> client.remote_window_ui`、`resource.quickbar_ui_contract -> client.quickbar_ui`、`resource.terminal_shell_ui_contract -> client.terminal_shell_ui`。跨端产品能力沿用 `feature_id=daemon.file_transfer`，但该 feature id 不是资源的 daemon-side module owner；不得据此把客户端文件字节或 UI 投影下放到 daemon。
- File Transfer 不变量：
  - `contracts/file-transfer-throughput.json` 是上传窗口和 native 批量上限的唯一机器真源；TypeScript 直接导入，Android Gradle 绑定为 `BuildConfig`，禁止 TS/Java 各自维护数字常量
  - wire chunk 固定 16 KiB，不以增大单帧突破 RTC DataChannel 上限
  - 上传由 `sendBoundedFileUploadChunks` 唯一维护最大 8 chunk 的 cumulative-ACK sliding window；UI 不得 per-chunk stop-and-wait，也不得无界 burst
  - daemon `file-upload-progress.chunkIndex` 表示从 0 开始连续收到的 chunk 数；重复或乱序 chunk 不得越过 gap 推进 ACK
  - 下载按原始 chunk 顺序交给 native storage；每次 native bridge 最多批量写 8 chunk，禁止逐 16 KiB bridge roundtrip 和 padded-base64 字符串直接拼接
  - 成功 truth 必须由精确 chunk count、总字节数和落盘 stat 一致共同确认；错误不得投影成 complete
- Client Mirror Buffer：只按绝对行号合并 daemon canonical buffer；只持有本地 sparse buffer / gap ranges / visible-range repair plan
- Client Mirror Buffer 不变量：
  - 窗口错 / anchor 错 / head mismatch 只影响请求规划，不影响已有 absolute-index 内容真相
  - client 不得先清空已有本地 buffer 再重拉
  - buffer manager 不持有 `follow / reading / renderBottomIndex`
  - buffer manager 只吃 daemon head + renderer 声明的 visible range
  - `buffer-head` / cursor metadata 只更新本地 metadata，不得直接驱动正文 repaint
  - **只有 `buffer-sync apply` 可以驱动正文 repaint**
- Client Render Window：唯一状态是 `follow / reading + renderBottomIndex`；`renderTopIndex` 只能由 `renderBottomIndex - viewportRows` 派生，不得成为第二真源
- Client Render Window 不变量：
  - renderer 是 visible range 唯一真相
  - gap 先空白占位，不等待补齐
  - buffer patch 到达后只按行/区间重刷，不整屏重算
  - head metadata / cursor metadata 可以被 renderer 读取，但不得成为正文 repaint 触发源
  - tab swipe / pane activate / shell gesture 不属于 renderer；renderer 只声明 viewport demand，不持有 tab navigation 手势状态机
- Client Render Width Mode：`adaptive-phone | mirror-fixed`
- Client Render Width 不变量：
  - `mirror-fixed` 下只允许裁切已有列 truth + 横向平移 renderer window
  - `mirror-fixed` 下 viewport / IME / safe-area / shell 宽度变化不得回写 daemon mirror / tmux 宽度
- `mirror-fixed` 下左右滑切 tab 仍由 shell interaction owner 负责；当前 mobile 端若没有独立 horizontal pan 手势链占用，swipe 必须保持可用，不得出现无交互出口的禁用态
- Android Shell：Capacitor、通知、后台服务
- Server：本地 Mac/PC 上的 tmux → WebSocket 桥接；只维护 tmux canonical buffer / mirror / transport connection / daemon 自身文件与调度真源，不持有任何客户端状态机
- Herdr source adapter 是唯一显式 history/live 分层例外：官方 `pane read recent` 的 tail history 与 canonical frame 的 live visible tail 只在 adapter 内合并成一个 `TerminalSourceMirrorSnapshot`；`daemon.mirror_writer` 通过 `daemon.source_adapter` 消费单一 adapter readback，禁止再拆第二语义或把 1000 行 history 放进 33ms capture loop
- Daemon Mirror Writer：`daemon.mirror_writer` 是 validated source capture 与 authoritative mirror snapshot commit write 的唯一 owner，位于 `src/server/terminal-mirror-capture.ts`；`daemon.mirror_store` 继续唯一持有 canonical mirror truth、revision 与 runtime scheduling，不得存在第二个 snapshot writer 或让 store 重新实现 capture/commit
- Server live mirror cadence 只允许由 daemon 物理事实决定：健康 subscriber 存在时保持 active capture cadence；无 subscriber、失败/backoff、capture cost 过高才允许降速。transport backpressure 只由 `daemon.buffer_publisher` 做 per-subscriber pending/flush 处理，不得拖低 mirror capture cadence。daemon 不读取 client active/visible/follow 状态，也不得用“最近无内容变化”把 ready mirror 降到 idle。
- Server daemon 启动入口：`scripts/zterm-daemon.sh`
- Screenshot Helper：运行在 macOS GUI session 的独立截图执行主体；只接受 daemon 本机 IPC 请求，不承载 tmux/session 真相
- Remote Window Stream：daemon/native side owns app/window catalog, iTerm2 pane coordinate truth, ScreenCaptureKit capture, WebRTC sender lifecycle, and remote input injection policy. Android floating/fullscreen overlay only projects picker/stream UI and emits explicit intents.
- Client Plugin Host：`client.plugin_host` 是唯一生产插件生命周期 owner，只通过 declared capabilities 向插件注入能力；`shared.plugin_contract` 只持有 manifest/capability registry 契约。App 是唯一生产组合消费点；UI/page/hook/plugin 层不得直接 import host 或共享 plugin contract，插件也不得访问 raw socket/store/backend/UI truth。Phase 6 边界与目标态见 `docs/design/2026-08-14-zterm-runtime-architecture-v2.md`。
- Client UI Plugin Slots：`terminal.debug-console`、`terminal.session-drawer`、`terminal.file-browser`、`settings.update`、`terminal.remote-window` 都通过 typed UI slot registry 提供；App 在 `PluginHost.startAll` 完成后读取 slot callback，TerminalPage/SettingsPage 只按 typed contract 消费 plugin-provided render，不直接 import 对应 sheet/overlay/drawer/update/remote-window 组件。
- Client Composition Root：`client.composition_root` 只拥有 declared runtime ports 的 bind/resolve/validate；App 通过它组合 `plugin-host` 等已声明端口，重复、未绑定、缺失端口在使用前显式失败。它不得拥有 transport/session/buffer/renderer/plugin 实现或业务 truth。
- Client Control Center：`client.control_center` 是客户端控制命令的唯一 routing/policy 边界，负责 capability/authorization、deadline、idempotency、correlation、唯一 command owner 与有界 audit；`shared.control_contract` 只持有 branded command/result/correlation/deadline/audit 契约。App 的 plugin-host dispose 必须经 control center 路由到 `PluginHostControlNode`，不得由 App 直接调用 `disposeAll`。control center 不持有 transport/session/buffer/renderer/plugin 业务 truth，也不接受 terminal/file/media body。
- Daemon Control：`daemon.control_gateway` 持有认证后的 typed control ingress 与 daemon command owner 注册；`daemon.control_center` 负责 capability/deadline/idempotency/correlation/唯一 routing 与有界 audit。schedule/tmux control 必须经 gateway -> control center -> 唯一 owner，`terminal-message-runtime.ts` 不得保留第二套 schedule/tmux 控制实现。控制层不持有 mirror/transport/file/media body，也不得把控制元数据写入业务 payload。
- Daemon Buffer Publisher：`daemon.buffer_publisher` 是 mirror 到 physical transport subscriber 的唯一正文发布边界，拥有 per-subscriber pending-latest、range merge/collapse、backpressure hysteresis、head broadcast cache、oversized contiguous same-revision frame split、trace stages 与显式 flush status；`daemon.mirror_writer` 负责 snapshot commit writes，`daemon.mirror_store` 负责 revision 与 runtime scheduling，发布只消费当前 mirror truth，不拥有 subscriber 发布状态。
- Daemon Session Catalog：`daemon.session_catalog` 是 backend session catalog 与 `list-sessions` control dispatch 的唯一 owner，通过 `src/server/daemon-session-catalog-runtime.ts` 构造 backend-qualified `sessionCatalog` rows，发布 legacy `sessions` payload 与 list-time `session-activity` facts。`daemon.control_gateway` 只能委托该 owner；`daemon.schedule_runtime` 只消费共享 catalog builder 做 republish，不拥有 catalog truth。daemon 不得让 catalog 持有 client active/session、mirror、transport subscriber、renderer 或 UI truth。

## 跨尺寸布局真源

- 唯一设计决策文档：`docs/decisions/0001-cross-platform-layout-profile.md`
- 跨尺寸布局必须由单一 layout resolver 输出 profile；page component 不得各自散落 breakpoint 真源
- 可复用单元是 **phone-sized pane**，不是“Android 页面”和“Mac 页面”各做一份
- foldable / pad / split-screen / future Mac 默认采用**一行多列 + 垂直分屏**；只改变列数、列宽和默认展开方式，不改变 `Connections / Connection Properties / Terminal` 的语义
- future Mac 复用 app-layer 页面、会话、存储和 layout policy；平台壳只补窗口、菜单、快捷键、拖拽、原生输入等能力

## UI 信息架构

### Screen 1: Connections Home

- 首页承载两个独立入口：当前进程 active Sessions、已配置且可进入的 server rows（direct/Tailscale saved Host、bridge presets、online Relay directory daemon device 投影；disconnected/stale Relay daemon records 不进入可点击 server 枚举）。
- Home 的 server row 是服务器级入口，不展示/管理 Session group、saved tab list、Relay 登录表单或单独 Relay 按钮；点击 server row 必须通过 session-open owner 直接进入 Terminal/session 主界面。
- 无 saved `sessionName` 的 server row 进入时，session-open owner 必须按同一 server owner 选择：先进入上次真实进入过且远端仍存在的 tmux session；没有历史时 live fetch 远端 tmux truth 并进入第一项；只有远端列表为空时才创建显式生成名的 clean tmux session；不得把 server display name 当 tmux session name fallback，也不得每次进入都创建新的 `zterm-*`。
- Settings 是配置入口：新增/修改 server preset、固定 relay 服务 `relay.codewhisper.cc` 的账号鉴权、更新/备份等设置均在 Settings 完成。
- Relay 是连接保障和同步增强，不是进入终端的 gate；未登录、登录失败或退出登录时，已保存 direct/Tailscale connections 与当前 active Sessions 仍必须可见可用。
- 用户只输入 relay 账号和密码；relay base URL、WS、TURN 与 signal 地址不进入用户配置面。
- Relay 登录成功后可以同步/补充所有连接候选，包括 Tailscale/local/direct endpoint，但不得删除、替换或隐藏 saved Host truth；Auto 连接顺序固定为 private LAN IPv4、Tailscale/direct websocket、WebRTC UDP direct/hole-punch、TURN Relay，并由目标级 heartbeat / route health 周期更新下一代 transport 的线路选择。
- Relay 鉴权是 account-scoped、token-per-login：同一账号允许多台 client device 与多个 daemon device 同时在线，每次登录新增独立 token，不得替换或撤销其他设备 token。普通密码修改保留已有 token；只有显式“退出所有设备”安全动作才能全局撤销。
- 首页禁止投影或管理 Session group、Session 子列表、tab 列表与 tab 保存；实时 Session 列表、切换、关闭和预览只属于 Terminal drawer / picker。
- relay 登录密码只用于当次认证，不持久化明文；持久化真相是 token、account directory 与 relay client settings。

### Screen 1A: Session Picker

- Terminal 顶部 `+` / drawer quick-new 等高级入口进入 session picker；Home 普通 server row 不停在 picker。
- 顶部先选目标 server，或手动输入 Tailscale IP / tailnet 域名
- server 输入后不自动探测；必须由用户显式点击 `Connect / Refresh`
- 列表顺序：历史连接优先、当前 tmux sessions 次之、最后才是 clean session/custom form
- tmux 列表支持 create / rename / kill / multi-select
- Terminal 顶部 `+` 长按也复用同一个 picker，直接用于 quick new tab
- 选中多个 tmux session 后可一次直接打开多个 tabs

### Screen 1B: Connection Properties

- 顶部栏：关闭 / 返回、标题
- 表单区：纵向 section 列表
- section 顺序：
  - General
  - Tmux Session
  - Connection
  - Terminal
  - Appearance
- 所有字段在手机安全区内可滚动编辑

### Screen 2: Terminal

- 顶部连接栏：返回、当前连接胶囊、加号新建
- 中部终端区：终端输出主画布
- 多 pane split 是 workspace projection：可以从单个 session 建立带编号的空 pane；空 pane 点击只打开对应 pane 的 session picker；已有 pane/tab 菜单只允许更改该 pane 的 session 或把 session 移到显式编号 pane。
- 底部快捷栏：方向键、回车、键盘切换、图片按钮
- 悬浮球快捷菜单：点击展开文本快捷输入列表，支持直接注入保存好的字符串、+添加、排序、编辑修改
- 扩展输入层：ESC/TAB/CTRL/ALT/符号/编辑/更多/命令输入条

## UI ownership

- Layout shell 负责单行多列编排、垂直分屏与 profile 到页面槽位的映射
- Layout shell 只安排 pane / tab / empty-pane projection；terminal freshness 仍由 active lane + passive visible round-robin lane 驱动，不得让多个 passive pane 在同一 tick 同时刷新形成风暴
- `Connections` 页负责连接入口与主机卡片管理
- Host form 负责新增/编辑，不直接承载终端操作
- Connection Properties 页负责连接配置编辑
- Terminal 页负责会话消费，不承载主机配置编辑
- 快捷输入层独立于系统键盘，作为移动端增强输入模块

## 数据流

```text
operation -> event -> projection
```

- operation：用户动作或控制动作
- event：已发生事实
- projection：当前 UI 视图

## 责任划分

- UI 只消费 projection，不补业务真相
- Storage 只管持久化，不管业务决策
- Session/Transport 只管连接与协议转换
- Schedule/Automation 只定义规则、nextFireAt 计算与执行结果，不直接承载 UI 展示
- Server 负责本地 tmux 真源，以及定时发送的唯一执行真源

## Home / runtime tabs 真源冻结

### 1. current tabs（当前进程打开 tabs）

- tabs 与 active Session 只在当前 app 进程内存在，不是持久化配置。
- 冷启动不得读取或恢复 `STORAGE_KEYS.OPEN_TABS`、`STORAGE_KEYS.ACTIVE_SESSION`、`STORAGE_KEYS.SAVED_TAB_LISTS`。
- 旧版本遗留的三个 key 在启动时由 migration owner 物理移除。
- 唯一业务 owner：
  - `src/hooks/useOpenTabRuntime.ts`
  - 其纯规则模块：`src/lib/open-tab-intent.ts`

硬规则：

- 当前进程的 open-tab state 是 **explicit client truth**
- runtime sessions 只能：
  - 为同 `sessionId` 的 open tab 提供 runtime transport/state
  - 在 explicit resume/switch 场景同步 runtime active id
- runtime sessions **不得 append runtime-only tabs 回 OPEN_TABS**
- runtime sessions / remote audit / semantic reuse key **不得**合并、替换、关闭、prune already-open tabs；`sessionName + daemon/bridge owner` 只能用于当前进程内显式 reopen 识别，不是 open-tab 物理身份
- open-tab 物理身份只能是 `sessionId`；用户显式关闭 tab 必须统一走 open-tab close owner，并且只更新当前进程内 open-tab truth
- `session-status closed/error/tmux_session_unavailable` 只属于 transport 事实：
  - 可触发 remote tmux audit
  - **不得**直接映射成 open-tab 物理关闭
- closed semantic tombstone（`closed-tab-reuse-keys`）只属于当前进程内 open-tab runtime truth：
  - 显式 reopen 可以清 tombstone
  - legacy storage key 必须被 migration owner 移除，不得重新写入
- `SessionContext` 不得持久化 current tabs
- `ConnectionsPage` 不得写 `OPEN_TABS`

### 2. session history（历史 server/session 选择）

- 唯一持久化真源：
  - `STORAGE_KEYS.SESSION_GROUPS`
- 唯一读写 owner：
  - `src/hooks/useSessionHistoryStorage.ts`

硬规则：

- `SESSION_GROUPS` 只代表：
  - 某个 server owner 下，用户保存/选择过哪些 tmux session names
- `SESSION_GROUPS` 不是 current tabs
- `SESSION_GROUPS` 不是 live sessions
- `SESSION_GROUPS` 不得反向生成 current tabs
- 远端 tmux truth 变化时，history 只能被 prune，不得自动 reopen tab

### 3. Home relay projection（主页 relay 投影）

- 唯一 projection owner：
  - `src/pages/ConnectionsPage.tsx`
  - `src/hooks/useTraversalRelayAccount.ts`

输入只允许来自：

- fixed relay service identity `relay.codewhisper.cc`
- relay account state
- relay account directory / online daemon devices
- saved Host storage projection
- current-process active Session projection

硬规则：

- projection 负责 fixed-domain relay 登录、online daemon device 投影、saved direct/Tailscale connection entry、current-process active Session resume entry；disconnected/stale relay records 不得成为 connectable row
- relay logged-out / error state 不得隐藏 direct/Tailscale saved Host 或 active Session entry
- relay account directory 只能增强 route/device candidates，不得成为 saved Host / Tailscale direct connection owner
- projection 不得写任何 storage
- projection 不得创建 / 关闭 session；只能发出已存在 owner 的 open/resume intent
- projection 不得决定 current tabs
- projection 不得显示或管理 Session group / saved tab list；实时 Session 列表属于 terminal drawer / picker

### 4. SessionContext 与 current tabs 的边界

- `SessionContext` 的真相仅限：
  - runtime sessions
  - active runtime session
  - live session ids
  - transport / buffer / renderer runtime

硬规则：

- `SessionContext` 不得持久化 current tabs
- `SessionContext` 不得持久化 session history
- `SessionContext` 不得在 cold start 自动从 runtime sessions bootstrap 已显式关闭的 tabs
- current tabs 是否存在，只能由 open-tab owner 决定

### 5. createSession 调用边界

- legacy cold-restore compatibility / runtime sync 的唯一 app-layer owner：
  - `src/hooks/useOpenTabRestoreRuntimeSync.ts`
- 用户显式打开 session 的唯一 app-layer owner：
  - `src/hooks/useSessionOpenActions.ts`

硬规则：

- `useOpenTabRestoreRuntimeSync.ts` 只允许做：
  - 当前进程 open-tab truth 的远端审计 / prune
  - legacy cold-restore compatibility 对应的 **local runtime shell restore**；默认 cold launch 没有 persisted tabs
  - runtime live session id remap
  - active tab truth 对齐
- `useOpenTabRestoreRuntimeSync.ts` 允许调用 `createSession`，但**仅限** `connect:false`：
  - 允许恢复本地 runtime shell / tab truth
  - **禁止**自动打开 daemon session / transport
- `createSession(connect:true)` 只能由 `useSessionOpenActions.ts` 中的**显式用户动作**触发，或显式 `Resume/Open` 动作触发
- 除上述 owner 外，其余 App / page / projection / history 模块不得直接调用 `createSession`
- `ConnectionsPage` 只发用户操作 intent，不得直接 reopen session
- `useOpenTabRuntime` 负责 current tabs truth，但不得直接批量 cold restore runtime session
- `SessionContext` 内部的 `createSession` 仅是 runtime primitive，不得自行推导“该不该 reopen 某个 tab”
- 若某个 persisted tab 绑定的 session 已关闭、已不存在、或当前没有 live runtime session 承接：
  - 允许恢复为 **local closed runtime shell**
  - 但不得在下一次启动或前后台恢复时自动 reopen daemon session

## 图片传送链路

```text
mobile file picker -> websocket paste-image -> daemon temp file
-> sips normalize to png -> macOS clipboard -> tmux input Ctrl+V
```

规则：

- client 只负责选择本地图像并上传原始字节，不自行裁剪语义
- server 负责解码/格式统一（当前统一转成 PNG）
- 剪贴板真源在本地 Mac/PC daemon，不在 mobile client
- `Ctrl+V` 发送给当前 active tmux 会话，不广播给其他 tabs

## Remote screenshot 链路

```text
Android client -> zterm-daemon -> macOS screenshot truth
               -> daemon file-download stream -> Android preview/save
```

规则：

- daemon 安装态 / 运行态是截图权限预检与截图能力的唯一执行主体
- `zterm-daemon install-service` 必须在 service bootstrap 前触发 / 验证截图权限
- daemon 直接产出截图文件并通过既有 file-download stream 回传
- daemon 不关心 Android preview/save UI
- client 只消费 `capturing / transferring / preview-ready / failed`

## Remote window stream 链路

```text
Android floating entry
  -> remote window picker projection
  -> zterm-daemon target catalog
  -> iTerm2 pane coordinate / tmux reverse lookup
  -> ScreenCaptureKit window capture + pane crop
  -> WebRTC media stream
  -> Android floating/fullscreen letterbox overlay
```

规则：

- `resource.remote_window_overlay` 只拥有 Android picker / floating overlay / fullscreen overlay / Back 缩小 / close intent 投影。
- `resource.remote_window_stream` 是 daemon/native 侧唯一真源，拥有 app/window 枚举、iTerm2 pane 枚举、坐标归一化、tmux 反查、capture、encoder/WebRTC sender、input target lease。
- Android 不计算 macOS 坐标，不读取 iTerm2 split tree，不把 terminal buffer/render 当视频真源。
- fullscreen Back 只从 fullscreen 缩小为 floating；只有 close 才释放 capture / encoder / WebRTC sender / target lease。
- 后续鼠标键盘回传必须声明 `focusPolicy` 与 `inputRoute`。普通 app 的通用 OS input 默认要求 `bring-to-focus`；`no-focus-steal` 只可用于显式声明的 terminal-specific route，例如 iTerm2 API 或 tmux input。
- 缺权限、窗口/pane 消失、坐标越界、iTerm2 API 不可用、tmux 反查失败、capture/WebRTC/input policy 失败都必须显式报错，禁止 fallback 到截图、terminal buffer、旧缓存图像或假成功。

## Session schedule / timed send 真源

### Schedule Job

- `targetSessionName`
- `payload.text`
- `payload.appendEnter`
- `rule`
- `enabled`
- `nextFireAt`
- `lastFiredAt`
- `lastResult`
- `lastError`

规则：

- daemon 是定时发送的唯一真源；Android / Mac 只做编辑和展示
- job 绑定 tmux `sessionName`，不能绑定客户端 runtime `sessionId`
- client 不允许再各自起本地 timer 做实际发送
- UI 可以显示 `bridgeHost + bridgePort + sessionName`，但实际执行 target 先以 tmux session 为准
- daemon 重启后不补历史 backlog，只计算未来下一次触发

## Terminal viewport / buffer 规则

- tmux / daemon 是 shell 排版真源；client 不负责 shell 排版
- client 连接初始化时只上报真实 geometry `cols / rows`
- keyboard / IME 只允许改变 UI shell 的位置与裁切，不属于 tmux geometry change
- pinch zoom / orientation / real container resize 才属于 geometry 变化候选
- terminal width mode 必须显式区分：
  - `adaptive-phone`：允许当前手机适配宽度路径
  - `mirror-fixed`：只读上游宽度真相；renderer 只做 horizontal crop / pan
- `adaptive-phone` 的上游宽度 owner 只能是 daemon：
  - client 只上报 latest measured cols
  - daemon 只允许按活跃 `adaptive-phone` 连接集合计算最小 cols，并在唯一 adaptive lease owner 内执行 `resize-window -x <cols>`
  - 断开连接、切回 `mirror-fixed` 或心跳过期后立即重算；最后一个 holder 消失时恢复/释放 tmux 宽度控制权
  - tmux 高度不在这条链路内，daemon 不得改写 rows
  - mirror 内容与 `mirror.rows/cols` 仍只能来自 tmux capture/readback，daemon 不得因为刚请求了 resize 就自写 mirror geometry
- viewport / geometry 变化时不允许：
  - clear terminal
  - replay `outputHistory`
  - 重建 session
  - 本地重排旧 buffer 作为真相
  - 因 IME 动画持续修改 tmux 高度
  - 在 `mirror-fixed` 下因手机 viewport 变窄而把 daemon mirror / tmux 改成更窄宽度

## Terminal horizontal pan 边界

- `mirror-fixed` 横向查看属于 renderer window horizontal pan
- `mirror-fixed` 下若未接入独立 horizontal pan 手势链，左右滑切 tab 仍需保持可用并由 shell interaction owner 独占
- 一次手势只能命中一个 shell 语义；若未来恢复 horizontal pan，必须与 tab swipe 重新做单一命中门禁，禁止并发共享
- `mirror-fixed` 当前已有 horizontal pan：只要手势能真实改变 renderer horizontal offset，renderer 必须截断父级 drawer/tab swipe；只有 offset 已到左边界且本次右滑无法继续平移时，左缘热区才可把该手势交给 drawer

## Opencode transcript 历史投影

```text
opencode 插件（opencode 进程内，数据导出）
   → ~/.zterm/opencode-mirror/<tmux-pane-id>.txt（原子写全量快照）
   → daemon 只读服务（HTTP GET /api/v1/transcript）
   → client 投影（快捷栏开关 + 虚拟历史区）
```

规则（真源：`docs/decisions/2026-08-07-opencode-transcript-mirror-truth.md`）：

- `resource.opencode_transcript` 是 daemon 侧只读数据服务：按 tmux pane id 读文件、报告 opencode pane 事实（`pane_current_command`）与文件新鲜度。纯只读、无 per-client 状态，不写 mirror store、不改 mirror head/index/revision/capture cadence、不驱动任何 tmux 操作。
- `resource.client_opencode_transcript_projection` 是 client 侧投影：快捷栏开关（client truth）+ transcript 行序列 + renderer 虚拟历史区。transcript 行**不得**写入 `resource.client_sparse_buffer`，不改变 mirror absolute index 语义。
- 数据面（opencode → 文件 → daemon 只读 → client 投影）与控制面（client 开关、daemon pane 物理事实）解耦：开关只改变 client 显示，不改变 daemon 数据产出；daemon 不因开关做任何决策。
- 开关有效条件 = daemon 报告的 pane 物理事实（真 opencode + 文件存在且新鲜）；非 opencode pane / 文件缺失 / 文件过期必须显式不可用，禁止 fallback。
- 插件是 opencode 进程内数据导出器，不 import zterm runtime；zterm runtime 不 import 插件。文件即 truth 快照（原子写），不是增量日志。
- 要求 opencode >= 1.18（1.14.x TUI 模式插件事件不可用，已实测）。

## Terminal canonical buffer ownership

```text
tmux truth
    ↓
daemon server
    ├─ session canonical buffer
    └─ replies:
         - head 在哪里
         - 请求区间的 buffer（每次回复都带 head）
                ↓
      client buffer manager
        ├─ 自己起 timer
        ├─ 定时先问 head
        ├─ 比较 local sparse buffer 与 daemon head
        ├─ 结合 renderer 声明的 visible range 计算 gap / diff
        ├─ 决定补 diff / 直接跳到当前 visible window / visible gap repair
        └─ 维护本地 1000 行 sparse sliding buffer + line/range patch
                ↓
      client sparse buffer
        └─ absolute-row immutable truth / gap ranges / visible-range repair plan
                ↓
      renderer window
        ├─ follow / reading
        ├─ renderBottomIndex
        ├─ visible range
        └─ immutable render snapshot
                ↓
      DOM renderer
        └─ TerminalView / VisibleRow / TerminalPreviewRow / mirror-fixed zoom-pan / cell render / theme
                ↓
      terminal shell
        └─ stage shell / status / quickbar assembly / copy menu / keyboard lift
                ↓
      UI shell
        └─ 容器位置 / 裁切 / IME 抬升
```

规则：

- daemon 是 tmux mirror；normal/follow 正文刷新由 daemon mirror truth commit 后经 `daemon.buffer_publisher` 主动 broadcast `buffer-sync` 驱动；reading/gap repair 才由 client 发 `buffer-sync-request` 拉取；daemon 不做客户端策略
- `buffer-head` 只允许更新 head metadata / cursor metadata / pull planner 输入；不允许作为正文 repaint 触发源
- client render gate 只允许 `buffer-sync apply -> schedule render commit`
- daemon 不得碰：
  - follow / reading
  - renderer
  - visible range
  - planner / prefetch / snapshot / fallback
  - gap 判断与客户端拉取策略
- daemon 每个 session 只维护自己的 canonical buffer；多 session = 多个并行 canonical buffer
- 任何 daemon 回复都必须带当前 head；但 daemon 不关心客户端为何请求这个区间
- client buffer manager 是独立 worker，只关心 daemon 同步，不关心渲染模式
- client buffer manager 每轮都先问 head，再结合当前 local sparse buffer 与 renderer 声明的 visible range 决定请求范围
- 若本地为空、失真或离 head 超过当前 visible window：直接请求当前 visible window 并移动本地窗口；中间不补
- 若本地仍接近 head：只补 diff
- renderer 当前窗口不连续时：只补 visible gap
- 即使本地工作窗口判断错误，也只能重算 request plan / 缺口；**不能**把已有 absolute-index 本地 buffer truth 清空成空窗
- renderer 只有 `follow / reading` 两种模式，只维护 `renderBottomIndex` 与 visible range
- renderer 不修改 buffer，不参与 transport 规划，不直接 request daemon
- 用户上滚进入 reading；重新进入 / 下滚到底 / 输入退出 reading 回 follow
- renderer 遇到 gap 先画空白占位；buffer manager 补齐后只推对应行/区间 patch，renderer 自己决定局部刷新
- `client.renderer_window` 是 renderer window 唯一 owner；`client.dom_renderer` 只把 immutable render snapshot 投影成 DOM；`client.terminal_shell` 只投影 shell 与用户 intent
- `client.dom_renderer` 不得请求 transport、修改 sparse truth 或自行决定 follow/reading/renderBottomIndex；`client.terminal_shell` 不得持有 sparse/render 真源
- `client.input_normalizer` 是 committed-text normalization 唯一 owner，只做纯文本转换（CJK/emoji/符号保留、全角标点/全角空格、IME 换行），不得持有或导入 session transport、daemon target transport、backend session、tmux、mirror 真源
- `client.reliable_input` 是 reliable terminal input queue 唯一 owner，物理真源在 `src/lib/reliable-input/reliable-input-queue.ts`；`session-context-input-runtime.ts` 只保留薄桥发送/转义入口，不得重新持有 seq/ACK/retry/queue 真源
- UI shell 只移动容器；IME 不得进入 buffer / render 真相链

## Connection / Session 真源

### Host（连接配置）

- `name`
- `bridgeHost`
- `bridgePort`
- `authToken`
- `sessionName`
- `autoCommand`
- 其余 appearance / auth / tags 字段

### Runtime Session（运行态 tab）

- `connectionName`
- `bridgeHost`
- `bridgePort`
- `authToken`
- `sessionName`
- `state`
- `auth state`(derived from target token availability)
- `title`

规则：

- `Host` 是持久化连接配置真源
- `Runtime Session` 是 tab / attach 运行态真源
- 不能再把 `bridgeHost` 和 `sessionName` 混在一个字段里
- UI 上任何“当前连接”展示都必须能恢复为 `server + session` 组合
- Server 进程启动方式也要有唯一入口：本地后台 daemon CLI，监听端口由统一配置决定（当前 `3333`）
- daemon 的 host / port / auth token 真源在 `~/.wterm/config.json -> mobile.daemon`
- client 侧按服务器维度记住 `bridgeHost + bridgePort + authToken`，并在 picker / connection form / reconnect 时复用
- 连通性探测必须显式触发；未填写 token 时禁止自动探测 / 自动重试 tmux 列表
- websocket mux 采用物理 target 级保活观测：一个 daemon target 的物理 WebSocket/RTC transport 只有一个 app-level `mux-ping` timer，logical tmux session/channel 不得各自发 heartbeat；正常周期为低频 30 秒。合法 mux frame 更新 target activity，channel 切换、foreground resume、body-subscription 变化不得新建 heartbeat 或物理 transport。只有物理 `close/error`、send 抛错、daemon 不可达，或 target health owner 明确确认物理 transport 失效，才允许进入 target 重建；单个 channel 错误只能重开该 channel。
- 核心 transport policy 的 Rust 迁移登记在 `docs/goals/terminal-transport-multiplex-refactor-plan.md#10-rust-migration-register`。`status: planned` 只表示目标态：当前 target network probe 的唯一 runtime owner 仍是 `src/contexts/session-context-target-network-probe-runtime.ts#createSessionTargetNetworkProbeRuntime`；Rust crate、parity gate、bridge 和旧 TS owner 物理删除全部完成前，禁止把计划路径声明成 active truth。
- daemon 初始化 / attach 阶段任何 `tmux capture-pane` 失败都只能记录错误并继续提供 `head + range` 能力；禁止再降级成第二套 snapshot 语义，也不允许因此让 daemon 进程退出

## 当前实现与目标差距

- 当前是“主机列表页 + 顶部按钮”，目标是“Connections 连接中心”
- 当前缺少独立的 Connection Properties 结构页
- 当前终端页的悬浮菜单语义必须是“文本 snippet 注入”，不能再把它和方向键 / Esc 这类快捷键组合混用
- 当前新增主机入口位于状态栏危险区域，目标是安全区内可点
- 当前页面结构偏网页，目标是移动端终端应用结构

## Workspace 约定

```text
android/
├── src/          # 源码
├── docs/         # 规范与流程
├── scripts/      # build / install / verify 脚手架
├── task.md       # 当前任务板
├── CACHE.md      # 短期记忆
├── MEMORY.md     # 长期记忆
├── evidence/     # 验证证据
├── native/android/ # Capacitor Android 项目
└── dist/         # 构建产物
```

## 代码 ownership 入口

页面级切片和未来文件 ownership 统一见：

- `docs/ui-slices.md`
- `docs/feature-registry.json`
- `docs/function-map.md`
- `docs/feature-gates.md`
- `docs/resource-registry.json` — global resource ownership machine truth for daemon, platform clients, terminal backends, transport, buffer/render, CLI/release, and debug surfaces
- `docs/resource-map.md` — human review surface for global resource relations, required indirect paths, and forbidden direct paths
- `docs/testing/resource-truth-test-design.md` — resource truth gate design before resource-owner code refactor
- `docs/wiki/daemon.md` — daemon runtime entry, tmux/mirror/bridge/schedule/control/ftransfer/screenshot paths
- `docs/wiki/cli.md` — bash CLI surface (`zterm-daemon.sh`), npm global install, launchd lifecycle
- `docs/wiki/mainline-source.md` — Android / daemon / CLI mainline source ownership
- `docs/wiki/mainline-call-map.json` — machine-readable mainline call map; node ids must align with wiki Mermaid ids
- `scripts/build-function-wiki.mjs` — generates `docs/wiki/generated/*.html` from mermaid blocks

任何功能改动在进入代码前，必须先按 `feature_id` 定位：

- 唯一 owner
- 允许修改路径
- 禁止修改路径
- required gates

如果某个功能没有对应 `feature_id`，不得直接改代码；必须先补 registry 和 truth gate，再进入实现。

资源关系改动必须先查 `docs/resource-registry.json` 和 `docs/resource-map.md`。`function-map.md` 只能绑定 feature-local owner 和真实 symbol，必须服从 resource registry；`mainline-call-map.json` 的每条边必须绑定 `resource_from`、`resource_to`、`via_resources`、`relation_status`。未声明资源关系不得实现，禁止用 UI / renderer / debug / release 路径绕过资源 owner。
