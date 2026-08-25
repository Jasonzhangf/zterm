# zterm 全链路稳定性修复计划

日期：2026-08-25

## 1. 目标与验收标准

### 主目标

把 zterm 修复为一个可持续运行的终端客户端：物理连接由后台 Android Service 独立管理，UI 只是投影和意图入口；Direct、Tailscale、UDP/WebRTC、Relay/TURN、mux channel、buffer、渲染、文件/图片传输、session 生命周期、登录同步和升级发布均有唯一真源、完整重试/恢复和可验证生命周期。

### 用户可见验收标准

1. App 从前台进入后台再回来，健康连接不重连、不切路由、不重建物理 socket；只有真实网络代际、认证、线路或服务端故障才切换。
2. 同一 daemon target 的多个 session 共用一条物理连接；切换 session 只切换 mux channel，不重新连接物理层。
3. 杀 session 时先判断是否为当前 session；当前 session 必须先切到默认/下一可用 session，再停止 channel/输入/订阅，最后执行 daemon kill。超时或失败只影响该 session，不污染其他 session、target 或全局 reconnect。
4. 抽屉中的 session 枚举去重、排序稳定、进入抽屉不触发重排版或重排序；后台可以整理数据，但前台只消费快照。
5. 连接错误、关闭、杀 session、传图失败等全部使用 zterm 自有主题对话框和图标动画；不得出现系统错误弹窗、原生默认配色或无上下文错误窗口。
6. 大面积 buffer 更新不会黑屏、白屏、卡住或依赖手动滚动触发刷新；任何缺口都会显示明确占位并自动按绝对行号修复，不能把“收到请求”当成“已更新”。
7. 图片/文件传输在断线、丢 chunk、超时和切路由后可按 ACK、chunk identity、revision、offset 续传；不重复写入、不丢数据、不把中间失败投影成最终失败，不成功不清除待发送数据。
8. UDP/WebRTC/Relay 真实可用并有独立证据；Direct、Tailscale、UDP direct、TURN Relay 的候选、信令、ICE、DataChannel、mux-ready、channel-ready 全部受 generation 和阶段门禁保护。线路不可用时显式报真实原因，不能伪装成已连接。
9. 登录成功后自动同步账号下确认在线的 daemon/device 到当前手机；已登录状态不再显示账号密码输入；升级后登录态和 daemon 目录主动恢复并进入首页投影，不要求用户手动触发。
10. 通知栏使用 zterm logo，小方块/有边框的稳定 session action，点击进入准确 session；某个 session 产生通知时只闪动对应 action，不影响其他 action。
11. Settings 一级入口精简分组，不平铺内部配置；所有卡片和表单按设备宽度动态布局，不能硬编码固定窄宽。
12. logo、splash、通知图标、前后台恢复界面保持原始比例和主题一致，不拉伸、不出现系统默认 logo。
13. 发布时 `versionName`、`versionCode`、APK metadata、rollback APK、`latest.json`、OTA bundle 和实际安装版本完全一致；升级路径可被真实设备消费。

### 工程验收标准

- 每个功能只有一个 owner；代码、resource map、module registry、edge registry、function map、mainline call map、verification map 和 wiki 节点一致。
- 控制面、错误链、调试/观测和业务 payload 物理隔离。
- 正向与反向测试成对覆盖：success、failure、non-terminal、already-terminal、stale generation、duplicate、timeout。
- 通过定向测试、架构门禁、类型检查、Android 构建、daemon 安装重启、真实设备/模拟器在线回环和 OTA 验证后，才可提交和发布。

## 2. 范围与边界

### In Scope

- Android `AndroidConnectionService` 的 target physical transport、mux、heartbeat、network generation、route policy、reconnect/backoff、desired state、snapshot/event IPC。
- Direct/Tailscale WebSocket、UDP/WebRTC direct、Relay signaling、TURN relay-only、ICE restart、candidate race 和 route health。
- client session/channel open/close/kill/switch 生命周期与抽屉投影。
- daemon channel/mirror/buffer publisher、client frame assembly/sparse buffer/renderer window。
- 图片和文件可靠传输、ACK、重传、断点续传、背压和资源预算。
- 登录态、account directory、daemon/device 同步、首页投影。
- Settings 信息架构、主题对话框、logo/通知、响应式宽度、前后台视觉恢复。
- remote-window daemon stream 的连接恢复、帧连续性、输入错误投影和资源清理。
- 版本治理、APK、rollback、OTA、安装态和升级路径。

### Out of Scope

- 不复制或内嵌 `../wterm` runtime 源码；runtime 真源问题改 fork runtime 并消费已发布 npm 包。
- 不用 screenshot、旧视频、临时 WebSocket、第二套 buffer、第二套 reconnect 或 silent fallback 掩盖正式链路缺陷。
- 不修改 DNS、网关、系统路由、TCC 或系统权限记录。
- 不删除、回滚或覆盖现有 dirty 改动；无关 dirty 文件必须保持原样并从提交范围排除。
- 不把 UI active tab、foreground/background、viewport、renderer 状态写入 daemon 真相。

## 3. 当前缺陷基线

以下是已由当前代码/记录确认或必须完成审计的缺陷，不得把已有“独立 slice”状态当成完成：

### 连接与后台生命周期

- Android Service 已成为 WebSocket/mux 的主要物理 owner，但 native Android 路径仍对 `RTC_DIRECT` / `RTC_RELAY` 显式报 `webrtc-not-supported`；`build.gradle` 尚无 Android WebRTC 依赖，UDP/Relay 仍是未完成独立 slice。
- foreground/background、Activity/WebView 重建、网络代际变化、route/auth generation、旧 callback、channel replay 和 reconnect 的隔离必须以 Service 内 generation fence 统一验证。
- `route-health-cache` 最近收敛为约 1 秒 cooldown；所有 selector/health 测试和文档必须与该真源一致，不能让过期 quarantine 阻塞下一次真实线路选择。
- candidate `onopen` 不能作为最终 winner；至少要通过 mux-ready，用户可用路径还要通过 channel-ready。
- RTC disconnected 的 ICE restart 必须完成 `restartIce -> createOffer({iceRestart:true}) -> setLocalDescription -> signaling offer/answer`；不能只调用 `restartIce`。
- heartbeat 健康必须由有效 pong/server activity 更新，不能由 timer tick 或 send attempt 更新。
- WakeLock 必须是有界的网络恢复临时资源，不能永久持有。

### Session/mux/抽屉

- 同 target 多 session 必须一条物理 transport、多条独立 channel；channel 错误不得 teardown target，target 错误才可重建物理连接。
- close/kill 必须是显式状态机：当前 session 切换/停止/关闭 channel/daemon kill 顺序固定，timeout 进入该 session 的终态，不得修改其他 channel 或 target reconnect truth。
- session catalog 必须按稳定 backend/daemon/session identity 去重；顺序只在后台快照构建时确定，进入抽屉不重新 layout/re-sort。
- 抽屉错误、kill timeout、连接错误必须走 typed Error chain 和 zterm themed dialog，不得调用系统 Alert/Error dialog。

### Buffer、渲染、传输

- `buffer-sync` 多 chunk 必须作为一个不可分割 authoritative frame，连续覆盖校验成功后一次性 apply；缺 chunk、旧 revision、冲突 frame 必须显式拒绝并记录精确 repair range。
- publisher 每个 chunk 必须获得显式 send result；transport 关闭、generation 过期或 backpressure 时不能静默丢弃，更不能清理 pending。
- 大刷新必须保持 canonical absolute range、local sparse buffer 和 renderer visible range 分离；gap 先占位，repair 成功后按区间 commit，不得通过整屏清空造成黑屏。
- splitter、publisher、frame assembly 必须具备 per-frame、per-session、per-target、global memory/backpressure 预算。
- 图片/文件传输必须由可靠队列和 daemon ACK owner 管理；duplicate chunk 只重复 ACK，不二次写入；冲突、乱序、断线、重连和 end-before-complete 必须显式失败或续传。

### 登录、同步、通知和 UI

- Relay/account login 成功后必须主动刷新 account directory，并将已确认在线 daemon 投影给每个已登录设备；UI 登录态改变后不能继续渲染账号密码编辑态。
- Home 只显示服务器级入口，Settings 负责配置；Session group、live session、session drawer 不能平铺到一级页面。
- notification 只消费 service/channel facts，不拥有 transport/session truth；只展示 mux-open 且仍有效的 session action。
- logo/splash/icon 使用 `assets/logo.png` 的比例和主题真源，不允许 Android 默认图标或拉伸资源。

## 4. 目标架构

```text
Android Foreground Service
  DesiredStateJournal
  NetworkMonitor / networkGeneration
  TargetConnectionRegistry
    RouteResolver + candidate race
    Native WebSocket / Native WebRTC / Relay-TURN
    mux handshake + target heartbeat
    reconnect/backoff + generation fence
  ChannelRegistry + reliable input
  bounded transport spool / image-file transfer
            |
            | typed Binder/WebMessage snapshot + event + command
            v
Activity / WebView / React
  active tab + drawer + viewport + renderer + UI projection
```

### 唯一 owner

- `resource.android_connection_service`：Service 生命周期、target physical transport、route/auth/network/transport generation、mux、heartbeat、reconnect、desired target/channel state。
- `resource.daemon_target_transport`：daemon target 物理 transport 与 target route identity；不拥有 UI/session body。
- `resource.terminal_channel` / `resource.daemon_channel_mux`：channel identity、open/close/replay、subscriber 生命周期。
- `resource.client_buffer_frame_assembly`：chunk frame identity、连续覆盖、拒绝和 repair range。
- `resource.client_sparse_buffer`：绝对行号本地 buffer。
- `resource.renderer_window` / `client.dom_renderer`：visible window、gap placeholder、render commit。
- `resource.daemon_buffer_publisher`：per-subscriber pending、backpressure、chunk send result、revision publish。
- `resource.file_transfer`：chunk ACK、重传、断点、完整性。
- `resource.relay_account_directory`：account token/device/daemon directory 投影。
- `resource.session_drawer_ui_contract`：抽屉展示和主题对话框投影；不拥有 session/transport。
- `resource.release_update_artifact`：版本、APK、rollback、OTA manifest、hash 和安装态证明。

任何实现若需要增加 owner 或跨越上述边界，先改 registry、call map 和 gate，不能直接补 runtime。

## 5. 技术方案

### A. 连接与恢复

1. 建立不可变 `TransportGeneration`，至少包含 `serviceEpoch`、`networkGeneration`、`routeGeneration`、`credentialGeneration`、`transportGeneration`、`channelGeneration`。
2. 所有 socket、RTC peer、DataChannel、timer、pong、close、channel-opened、buffer frame 和 callback 先校验 generation；旧事件直接丢弃，不得改当前 truth。
3. target-level 只有一条当前物理连接；session 切换只改变 channel projection。
4. winner 阶段固定为 `TRANSPORT_OPEN -> MUX_READY -> CHANNEL_READY`；raw socket open 不得关闭仍可能成功的候选。
5. Android native 实现 UDP/WebRTC direct 与 Relay/TURN，包含 signaling、offer/answer、ICE candidate、DataChannel、selected pair、reconnect、close、route health 和 mux framing；WebSocket、WebRTC、Relay 共用同一 target/channel lifecycle，不新增平行 session owner。
6. 默认网络 callback 负责 networkGeneration；网络变化立即淘汰旧 generation 并为 retained targets 启动新候选。
7. route/auth 变化立即关闭不匹配 socket；route health 只记录达到 mux-ready/channel-ready 的成功，TTL 和失败 quarantine 由唯一 cache owner 管理。
8. heartbeat 只由有效 pong/server activity 更新健康；连续 miss、超时、网络变化进入 typed reconnect state；重试为有界快速阶段后低频恢复，不能永久“手动重连”终态。
9. foreground/background/Activity/WebView 生命周期只 bind/unbind observer；不 reconnect、不 probe、不 route-switch、不 schedule heartbeat。
10. 所有关闭路径必须有 cleanup proof：socket、peer、signal socket、timer、WakeLock、channel registry、subscriber、pending queue 均归零或进入明确 retained state。

### B. Session / drawer / error

1. 定义 `CLOSED -> STOPPING -> DETACHING -> KILLING -> CLOSED` 以及 `OPEN/RECOVERING/ERROR` 的 typed channel lifecycle。
2. 当前 session kill 前先切默认/下一可用 session；切换不重建 target transport。
3. stop/disconnect 完成后才 kill；kill timeout 只产生该 channel 的 error fact，其他 channel 保持可用。
4. catalog 按稳定 identity 去重；排序和分组在后台 catalog owner 完成，drawer open 只读不可变 snapshot。
5. 所有连接、close、kill 错误进入统一 typed error projector，由 zterm themed modal/toast 展示；系统对话框和裸错误字符串物理删除。

### C. Buffer/render/transport

1. 先按 `docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md` 和 `.agents/skills/terminal-buffer-truth/SKILL.md` 更新测试设计和 gate，再改实现。
2. 统一 frame identity：`target/channel/revision/frameStart/frameEnd/chunkIndex/chunkCount`；assembly 只在连续覆盖完整后一次 apply。
3. publisher 每 chunk 返回 `sent/not-open/stale-generation/backpressured/error`；非 sent 保留 authoritative pending，并按精确 range 重新请求。
4. buffer manager 不清空旧内容；renderer gap 先画主题背景占位，patch 到达后按绝对行号 commit；head/cursor metadata 不直接触发正文 repaint。
5. 重写 O(n²) splitter 为增量 byte accounting；减少 JSON/base64 热路径；能证明协议兼容后再启用 binary frame/capability，不能先改变语义。
6. 加入 global/per-target/per-session/per-frame budget 和 latest-head/range merge 队列语义；控制、可靠输入、正文、head、诊断分开管理。
7. 加入大刷新、快速 TUI、空闲、gap、daemon restart、hidden/active、foreground resume 的端到端 trace：`source -> mirror -> publisher -> assembly -> sparse -> renderer commit`。

### D. 图片/文件可靠传输

1. 固定 chunk identity、upload/download id、offset、length、content hash、revision 和 ACK。
2. sender 只在明确 ACK 后推进/清除；timeout 重发同一 chunk identity；切换 transport 后从 durable pending checkpoint 继续。
3. receiver 对 duplicate 幂等 ACK，对冲突/乱序/超限显式拒绝；end 只有在精确 chunk count、byte count、hash、落盘 stat 一致时成功。
4. 图片发送与终端 mux 共用 target physical transport，但不新建 session/socket；传输控制走 typed side-channel，业务图片字节不能混入控制 metadata。
5. UI 只显示 stable progress/final result；内部瞬时 retry 不弹系统错误窗口，最终失败使用主题化错误投影并保留可诊断 code。

### E. 登录同步、通知、设置、视觉与发布

1. login success 触发唯一 directory sync owner；account token、device identity、daemon rows、endpoint generation 进入 snapshot/event chain。
2. logged-in projection 移除账号密码输入；logout/expired token 才回到登录态。
3. Settings 入口按 General/Connection/Terminal/Appearance/Account/Update 等分组；宽度由共享 responsive layout resolver 决定，禁止设备固定 px。
4. notification action identity 绑定 `targetKey + channelId`；只投影 mux-open channel，点击发 exact deep link，活动 pulse 只命中对应 session。
5. 资源生成统一从 `assets/logo.png` 派生并做多密度比例校验；前后台 surface、splash、通知和 launcher 逐像素/尺寸验证。
6. 版本只由 canonical bump 工具生成；构建后必须运行 rollback APK、update bundle prepare、update bundle verify，并检查 manifest/APK/aapt/OTA endpoint/安装态一致。

## 6. 文件与文档清单

### 必须先查/同步的架构真源

- `android/docs/resource-map.md`
- `android/docs/resource-registry.json`
- `android/docs/module-registry.json`
- `android/docs/edge-registry.json`
- `android/docs/function-map.md`
- `android/docs/wiki/mainline-call-map.json`
- `android/docs/wiki/mainline-source.md`
- `android/docs/feature-registry.json`
- `android/docs/feature-gates.md`
- `android/docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md`
- `android/docs/decisions/2026-04-28-terminal-transport-session-lifecycle-truth.md`
- `android/docs/dev-workflow.md`
- `.agents/skills/terminal-buffer-truth/SKILL.md`

### 代码 owner 范围

- Android service/plugin/commands/snapshot/network lifecycle。
- traversal socket、route selector/health、RTC bridge、native WebRTC signaling。
- mux/channel/session open-close/kill and drawer projection。
- daemon buffer publisher/frame splitter/transport send result。
- client frame assembly/sparse buffer/renderer commit。
- file/image transfer client + daemon ACK/resume。
- relay account directory/login projection and server sync.
- notification service/deep link, themed error projector, settings responsive layout, logo/splash.
- release scripts, version/metadata checks, OTA bundle and install verifier.

每个具体改动前必须在 feature registry 绑定 `feature_id`、唯一 owner、allowed paths、forbidden paths、required gates；不存在条目时先补 registry 和 gate。

## 7. 风险与规避

| 风险 | 规避 |
| --- | --- |
| native WebRTC 引入后出现第二套 transport/session 真相 | 复用 Service target/channel lifecycle；WebRTC 只实现 `TransportBackend`，不直接接 UI |
| raw socket open 过早关闭健康候选 | winner 只在 mux-ready/channel-ready 确认 |
| 旧 callback 覆盖新连接 | 所有异步事件强制 generation fence |
| 大刷新再次黑屏 | atomic frame assembly + sparse patch + renderer gap placeholder；不清空旧 buffer |
| 重试导致重复写入或 pending 丢失 | ACK/identity/hash 幂等和“成功后才清 pending” |
| session kill 影响其他 session | channel-scoped state machine；target teardown 只由 target owner |
| 登录目录刷新污染业务 payload | directory typed control/event side-channel |
| UI 通过重连掩盖健康状态 | health 只由 pong/server activity；UI 不得启动 reconnect |
| OTA 版本错配 | canonical bump 后由同一 release command 生成 APK、rollback、latest.json，并做 hash/installed proof |
| dirty main 混入无关代码 | clean owner worktree、精确 merge、cached stat/name-status 锁范围 |

## 8. 测试与验证矩阵

### 自动测试

- traversal/socket/route-health/route-selector/RTC bridge：candidate race、ICE restart、TTL、VPN/network generation、stale callback、mux-ready timeout、cleanup。
- Android service unit/instrumentation：background/foreground、Activity destroy/recreate、network switch、target reuse、channel replay、heartbeat、backoff、WakeLock、notification action。
- session/drawer：dedupe、stable ordering、current-session switch-before-kill、stop-before-kill、timeout isolation、themed error projection。
- buffer/render：large refresh、frame gap、duplicate/old/conflict frame、backpressure、send result、visible gap repair、no black frame、daemon restart。
- file/image：duplicate ACK、lost chunk、timeout retry、resume after route switch、hash/length/stat, end-before-complete。
- login/directory/settings/update/logo：login projection, multi-device sync, logged-in UI, responsive widths, aspect ratio, metadata and OTA consistency。

### 真实回环

1. tmux source truth。
2. daemon installed runtime logs and mirror/head/range.
3. client service generation/channel/ACK logs.
4. renderer commit and visible DOM/pixel evidence.
5. Android emulator or real device installed APK.
6. Direct/Tailscale positive route.
7. UDP/WebRTC direct positive route with selected candidate type.
8. TURN relay-only positive route with selected `relay` candidate.
9. Wi-Fi/VPN/network transition and app background/foreground.
10. daemon restart, session close/kill, image interruption/resume.

没有真实设备、真实 daemon、真实 UDP/TURN 或真实 OTA 证据时，只能报告对应 gate 未完成，不得宣称全部修复。

### 构建与交付

```text
type-check
-> feature/resource/module/edge/function/mainline gates
-> focused tests
-> terminal local regression
-> daemon build/install/restart
-> Android build
-> APK install/upgrade
-> online device and OTA verification
-> AGY Review PASS
-> exact commit
-> push origin/main
```

AGY Review 只能在实现、测试、构建、安装/重启、在线真实样本全部完成后执行；review FAIL 必须修复并重新完成受影响验证。

## 9. 实施步骤

1. 建立本轮 run、读取 MemoryPalace 和所有 registry/map；锁定每个子问题的 owner、resource、edge、gate，禁止直接在 dirty main 跨模块补丁。
2. 先补齐红测和 test design：连接生命周期、session kill isolation、buffer hole/black screen、image resume、login sync、OTA identity。
3. 收敛 Android Service 为唯一 target physical owner，完成 generation fence、网络 callback、heartbeat、candidate stage 和 lifecycle cleanup。
4. 完成 native UDP/WebRTC direct、Relay signaling、TURN relay-only，并以真实 selected candidate 和 mux/channel-ready 作为证据。
5. 收敛 session/channel close/kill/drawer/error projection，验证失败隔离和不重排进入行为。
6. 收敛 publisher/frame assembly/sparse/renderer，完成大刷新、背压、断线补洞和连续回环。
7. 收敛图片/文件 ACK、重传、断点续传和完整性验证。
8. 收敛登录态、account directory、daemon 同步、通知 session actions、Settings 信息架构、主题和 logo。
9. 完成版本 bump、APK、rollback、OTA bundle、manifest/hash/安装态对齐。
10. 在主 tree 做精确 merge 后重新跑主 tree 验证、在线安装/重启/真实回环，再执行 AGY Review、提交并推送 `main`。
11. 将已验证根因、证据、剩余风险写入 `android/note.md`、`android/MEMORY.md` 和对应 local skill；未完成项不得标成完成。

## 10. 完成定义（DoD）

- 所有上面列出的用户可见验收标准均有对应自动测试和至少一个真实证据。
- Direct、Tailscale、UDP/WebRTC、TURN Relay 的状态和限制真实可见；不存在“连接看似成功但无 mux/channel/data”的假成功。
- UI 生命周期不会破坏后台物理连接；session/channel 失败不会拖垮其他 session/target。
- buffer、图片和文件传输在丢包、断线、重连、切路由后不丢数据、不制造黑屏、不清除未确认 pending。
- 登录态、daemon 目录、通知、设置和主题投影与真实状态一致。
- APK、rollback APK、metadata、OTA manifest、远端 latest.json、实际安装版本的 versionName/versionCode/hash 一致。
- 主 tree 与 `origin/main` 的最终 commit 一致；review 结果为 PASS；所有无关 dirty 文件保留且未进入提交。
- 若任何 required gate 因外部设备、网络、权限或依赖不可用而未完成，最终状态必须是 `blocked/incomplete`，不能用源码测试代替结论。

## 11. 2026-08-25 Route / UDP Recovery Slice

### 已完成

- `test:traversal` 进入 prebuild gate；`socket`、`route-health-cache`、`route-selector`、`config` 共 68/68 PASS。
- route failure quarantine 从 30 秒收敛为 1 秒；selector/health 时间断言同步。
- WebRTC disconnected 现在执行完整 ICE restart offer signaling，而不是只调用 `restartIce()`。
- relay signal close/error 改为 30 秒 stale grace；新 init 可复用 peer，超时才关闭。
- TraversalSocket 增加可选 mux-ready confirmation：raw open 不再立即 settle winner；5 秒无确认释放 runner-up。当前默认关闭，待上层接入后启用。
- Android capability fingerprint 只在 VPN overlay 出现/消失时 retire target；普通带宽/metered 变化不再打断健康连接。
- network recovery WakeLock timeout 改为 `MAX_BACKOFF + heartbeat budget + 5s`。
- build 2731 APK / rollback APK / OTA bundle verify 全绿；emulator 安装 `0.1.3.2731 / 1100027310`。
- AGY Review task `agy-zterm-route-udp-recovery-20260825T214500Z` verdict `pass`，零 P0/P1。

### 本 slice 未完成

- Android native UDP/WebRTC direct 和 TURN Relay 仍未实现；native service 对 RTC candidates 仍显式 unsupported。
- `confirmTransportReady()` 尚未由 session/mux runtime 调用；candidate winner 的 mux-ready 门禁仍处于 opt-in。
- 未做真实网络切换、VPN on/off、TURN relay-only 的在线恢复样本。

### 2026-08-25 confirmTransportReady wiring

- `confirmTransportReady()` 从 opt-in 死代码变为活跃：`createClientDaemonTraversalSocket` 现在默认传 `requireOpenConfirmation: true`；mux-ready 处理后调用 `ws.confirmTransportReady?.()`。
- 效果：TraversalSocket 的 raw onopen 不再立即 settle winner；等 mux-ready 到达后才确认，5 秒超时释放 runner-up。防止"socket 打开但协议层失败"的线路被过早选为胜者并关闭更健康的候选。
- 验证：transport-runtime 24/24（2 新增正反测试）、socket 31/31、type-check PASS。commit `a43e9be5` 已推送到 origin/main。

### 2026-08-25 当前基线（继续执行前必读）

`main` / `origin/main` HEAD 为 `2d4fe633`，工作区仅保留 `android/.build-meta.json`（buildNumber 2732，可发布态）和本计划文档。此前修复已并入 main：

- `9f685e3d`：route health TTL 收敛、ICE restart signaling、relay signal stale grace、VPN fingerprint diff、WakeLock timeout、test:traversal prebuild gate。
- `a43e9be5`：`confirmTransportReady()` 接入 session runtime，mux-ready 后确认候选 winner。
- `2d4fe633`：移除 `createClientDaemonTraversalSocket` 无条件 `requireOpenConfirmation`；确认机制保留为显式 opt-in，防止无竞速单候选场景延迟 onopen。

当前已构建安装 `0.1.3.2732` / `1100027320`，rollback APK 与 OTA bundle 18/18 校验通过，prebuild / type-check / feature-registry 全绿。

剩余主缺口（本计划的真正剩余任务，不是重新实现已完成的 confirm-ready wiring）：

1. Android native UDP/WebRTC direct 与 TURN relay-only 未集成：`AndroidConnectionService` 对 RTC candidates 仍显式 unsupported，`stream-webrtc-android` 依赖已验证可解析但未接入 `TransportBackend`。
2. 后台 Service 化后的 generation fence、network callback、channel replay、heartbeat/backoff、desired state、snapshot/event IPC 仍需按计划统一收口；当前以 JS/traversal 层为主。
3. session close/kill、drawer 去重/稳定排序、themed error projection 已有多处修复，但需按 typed lifecycle 完整收口并验证失败隔离。
4. buffer/publisher/renderer 的大刷新、原子 frame、gap repair、send result、预算仍需完成，不能把已有独立修复当成完成。
5. 图片/文件可靠传输、断点续传、ACK owner 仍需完整闭环。
6. 登录后 account directory 多设备同步、通知 session tiles、Settings 响应式、logo/主题资产仍需按验收完成。
7. 版本/APK/rollback/OTA/安装态对齐必须由 canonical release 链路产出，每次 bump 后同步升级通道。
8. 真实回环仍缺：网络切换、VPN on/off、TURN relay-only、daemon restart、kill/timeout、buffer hole/black screen、图片中断续传、OTA 升级消费。
