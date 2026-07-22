---
name: zterm-mobile-dev
description: "zterm Android 客户端开发工作流 - 基于 Capacitor + @jsonstudio/wtermmod-react，含完整开发闭环"
---

# zterm-mobile Dev Skill

## 项目概要

- **目标**: zterm Android 客户端，通过 Tailscale 访问本地 Mac/PC
- **技术栈**: Capacitor + React + @jsonstudio/wtermmod-react (WASM 终端)
- **服务端**: WebSocket → tmux 桥接（本地 Mac/PC 运行）
- **核心功能**: 多 terminal Tab、主机管理、后台保活、WebDAV 同步

---

## 一、必读文档顺序

每次开发前必须按顺序阅读：

```
1. ~/.codex/AGENTS.md               → 全局入口、硬护栏
2. ~/.codex/USER.md                 → 用户偏好（称呼 Jason）
3. coding-principals/SKILL.md       → 开发方法论
4. android/docs/spec.md     → 项目范围与验收
5. android/docs/architecture.md → 模块边界与数据流
6. android/docs/decisions/0001-cross-platform-layout-profile.md → 跨尺寸布局 / Mac 共享壳决策
7. android/docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md → terminal head / sparse buffer / render / UI 真源
8. android/docs/dev-workflow.md → 执行门禁与验证
9. android/task.md          → 当前任务板
10. android/docs/ui-slices.md → 页面切片与 ownership
11. 本 SKILL.md                     → 项目约束、可复用门禁
```

---

## 二、项目特有约束

### 2.1 禁止修改的代码
- 不直接把 runtime 源码复制进 zterm
- runtime 发布包的真源在 `../wterm`，需要改底层时去 fork repo 改
- 不修改 `mac/`、`win/` 下其他客户端骨架
- 不在 app repo 内复制 runtime 源码；runtime 变更改 `../wterm`
- skill / 文档 / AGENTS 真源以 `zterm` 命名，不再沿用 `wterm-mobile-*` 旧命名
- 只复用，只扩展

### 2.2 真源分工
- `spec.md`：产品范围与验收
- `architecture.md`：模块边界、数据流、ownership
- `docs/decisions/0001-cross-platform-layout-profile.md`：跨尺寸布局 / Mac 共享壳唯一决策
- `dev-workflow.md`：执行顺序、验证门禁、证据要求
- `ui-slices.md`：页面级切片与文件 ownership
- `task.md`：当前任务状态
- `CACHE.md`：本轮短期上下文
- `MEMORY.md`：长期可复用经验
- `evidence/`：截图、日志、APK、真机证据
  - 说明：`android/evidence/` 是本地证据仓，默认不进 Git 主线；Git 中只保留目录说明文件

### 2.2.1 Android 交付包硬门禁
- 每次 Android 功能修复 / bug 修复 / renderer / daemon-client 协议 / UI 行为改动，只要需要 Jason 复测或会影响真机行为，完成前必须构建可升级 APK 包。
- 例外：`desktop.remote_window_stream` 的视频主链尚未完成时，不为中间态 catalog / overlay shell / debug 诊断改动反复构建 APK；先完成真实远程视频（ScreenCaptureKit/WebRTC frame stream 可见）并通过对应 gates，再构建 APK 给 Jason 测。除非 Jason 明确要求止血包或升级恢复包，否则不要在远程视频完成前编包。
- 默认命令：`pnpm --dir android run build:android`。
- 构建结果必须进入升级通道：`android/update-dist/latest.json`、`android/update-dist/zterm-<version>.apk`、`android/update-dist/zterm-latest-debug.apk`、`~/.zterm/updates/latest.json`、`~/.zterm/updates/zterm-<version>.apk` sha/version 对齐。
- Android 交付闭环必须同时覆盖 **Tailscale daemon update route** 和 **public Relay update route**：构建后不仅要有本地文件，还必须验证 `http://127.0.0.1:3333/updates/latest.json`、`http://$(tailscale ip -4):3333/updates/latest.json`、`https://relay.codewhisper.cc:18443/relay/updates/latest.json` 都返回新版本；三个通道的 APK 下载 sha256 必须等于 manifest `sha256`。如果 127/Tailscale `/health` 或 `/updates/latest.json` 超时，先做 service-scoped `zterm-daemon restart` 后重测，禁止只说文件已复制。
- 汇报时必须给出 `versionName`、`versionCode`、APK 路径和 sha256；不能只说测试通过。
- 若本机有在线 ADB 设备，构建后继续安装 / 启动 / 真机 smoke；若没有在线设备，必须明确写出 “APK 已构建发布，但 L5 真机复测缺口是无 online ADB 设备”。
- 禁止把源码修复、单测、typecheck、daemon close-loop 当成可供 Jason 复测的交付物；没有升级 APK，就不算移动端交付闭环。
- Relay 场景下升级地址必须跟随当前 Relay 公网路由：`App` 只能把 `traversalRelay.wsHostUrl` 交给 `app-update-runtime`，由唯一 owner 派生 `/relay/updates/latest.json`。显式 `user-saved` manifest 不覆盖；旧私网/Tailscale `server-connected` 或旧 `relay-injected` URL 可被当前 Relay URL 替换。Relay server 必须通过 `ZTERM_TRAVERSAL_UPDATES_DIR` / `ZTERM_RELAY_UPDATES_DIR` 服务 `/relay/updates/latest.json` 和 `/relay/updates/<apk>`，且 public GET/HEAD + APK sha256 都验证通过；只在客户端改 URL 而生产 Relay 不服务更新包不算闭环。
- 发布 public Relay update assets 时，生产机访问使用 `ssh/scp -i ~/.ssh/claw.pem -o IdentitiesOnly=yes root@159.75.134.56`，目标目录是 `/var/lib/zterm-traversal-relay/updates`；只上传 `latest.json` 与对应版本 APK，通常不需要重启 `zterm-traversal-relay.service`。完成后必须从公网重新 `GET/HEAD https://relay.codewhisper.cc:18443/relay/updates/latest.json` 与版本 APK，并下载 APK 比对 sha256；服务器本机文件存在不等于公网升级通道闭环。
- 替换 Android App Logo 时，以仓库根 `assets/logo.png` 为源，同时生成 `ic_launcher`、`ic_launcher_round`、`ic_launcher_foreground` 的 mdpi/hdpi/xhdpi/xxhdpi/xxxhdpi 资源。Adaptive foreground 必须按 Launcher 二次蒙版预留安全区，默认前景不超过画布 80%，背景色与 Logo 外围一致；构建后既要从 APK 解包核对 legacy/adaptive hash，也要看真实 Launcher 截图，包内字节一致不能证明最终图标未被裁切。

### 2.2.2 Remote-window 输入 / 粘贴 / 码率规则
- Remote-window image paste 的路由真源只能是 Android active focus context：remote-window context active 才允许发送 `pasteTarget.kind=remote-window`；terminal surface focus 必须清掉 context；否则同一 QuickBar image action 保持 terminal Ctrl+V paste path。daemon 不猜焦点，不按 app title/window list 自行决定投递目标。
- Remote-window 粘贴执行必须复用 file-transfer paste-image owner 写 macOS clipboard；remote-window target 只追加 Command+V 注入，terminal target 只追加 terminal Ctrl+V。禁止新增第二套图片上传或 clipboard 流水线。
- Remote-window 视频码率是 stream-local quality control：start 携带当前 preset，后续 selector 发送 `remote-window-stream-quality-request`；daemon 只在 stream owner 内校验并应用 WebRTC sender `maxBitrate`。应用码率时只能保留并修改 sender 现有 `RTCRtpSendParameters.encodings`，禁止在空 encodings 时伪造新 encoding；启动阶段没有可改 encoding 时显式报告码率未应用但不阻断视频，运行中切码率则返回显式失败。禁止用码率切换重启 capture、receiver、session transport 或改坐标真源。
- Remote-window 网络自适应只允许修改 stream-local quality：客户端根据 Network Information 的 `saveData/effectiveType/downlink/rtt` 计算不高于用户选择的 effective preset，并把预置帧率一起发送；`2mbps/5mbps/10mbps+` 分别锁定 `5/8/12 FPS`。它不得重建 WebSocket、ScreenCaptureKit、WebRTC receiver 或改变用户记忆的 preset。若实际网络状态变化，质量更新仍走当前 stream 的 quality request。
- Remote-window app catalog 是 daemon-wide cache，不是 tmux/session truth。`requestRemoteWindowTargetsRuntime` 必须复用当前打开的 SessionContext WebSocket，并用 `{ daemonHostId, bridgeHost, bridgePort, authToken }` 作为 cache key；同 daemon 切 session 在 TTL 内不得重复发送完整 app enumeration。TTL 到期只刷新一次；closed transport 不能被缓存伪装为可用。
- Remote-window picker 的 Android overlay 可以持有当前 active session 的上一份 catalog projection，用于 reopen / stale refresh / force refresh 时先显示旧 rows；daemon-wide cache 真源仍只在 SessionContext catalog owner。手动刷新必须显式传 `{ forceRefresh: true }` 绕过 TTL，但不能把 picker blank 成大 loading 面板。
- Remote-window 有效码率必须区分预览、手机 fullscreen 投影、电脑端窗口面积：floating preview 固定请求 `2mbps`；手机 fullscreen 只是 Android 显示投影，不能自动提升到 20Mbps；未手动选择时按 daemon manifest 的 `capture.displayBoundsTopLeftPx` 与选中 crop/window 面积比例分档，只有接近电脑端显示器全屏才是 `fullscreen`/20Mbps。selector 显示/记忆和 floating preview 的低码率请求是两层语义，禁止通过重启 stream 实现码率变化。
- Remote-window picker 默认只直接列 app-window；iTerm2 panes 必须折叠到一个可展开组里，避免和普通 app 窗口混在一个长列表。daemon catalog 仍返回完整 targets，折叠只是 Android overlay projection。
- Remote-window input context 只允许发布给已验证支持的 app-window `bring-to-focus + os-event` target。当前 `tmux-input` / `iterm2-api` iTerm pane 路线必须显示只读并禁止发送 pointer/scroll/gesture/key/QuickBar input；不要把 daemon 会拒绝的路线伪装成可操作。
- Remote-window floating resize 必须是 Android overlay projection：至少覆盖左下角和右下角拖拽，按 selected source aspect ratio 等比缩放，右下角扩缩时保持左边稳定并移动右边，左下角扩缩时保持右边稳定，并且放大时要 cap 到 toolbar 仍在 viewport 顶部安全边界内。测试不能只证明“有一个 handle”。
- Remote-window unzoomed fullscreen / floating 的单指触控默认属于远端输入：点击发 pointer，拖动在本地识别后于 release 发一个 `gesture/swipe` 命令给 daemon，由 daemon 模拟同等手势；mouse/trackpad wheel 才保持 pixel scroll。即使 `bottomInsetPx` 存在也不得被本地容器 pan 抢走。`bottomChromeInsetPx` 只负责键盘打开时的自动初始上抬，`scale > 1` 后单指拖动才属于本地 zoom pan；不得通过改 terminal renderer、daemon capture 或隐藏本地 pan 补偿远端输入。
- Remote-window 支持的 app-window 非 `focus` 用户输入必须按“操作瞬间 focus-first”发送：pointer / gesture / wheel / key / QuickBar / IME 的每一个真实事件前都要紧邻同 stream/target 的 `focus` intent。stream start、视频 attach、fullscreen 进入、IME 上抬、picker/catalog 刷新、pinch zoom、本地 zoom-pan 都不是远端操作，不得发送 focus。只在 stream start、pointerdown 或 batch 开头 focus 不够；daemon 仍是唯一 AX/Quartz focus+input owner，Android 只能发 intent。unsupported iTerm/tmux read-only 目标仍不得发布 input context 或发送 focus/input。
- Remote-window 截屏是 target-scoped capture，不是输入事件：浮窗和 fullscreen 的截图按钮必须把 selected target manifest 交给现有 `terminal.remote_screenshot` / file-download owner，daemon 只能按 macOS `windowId` 或已归一化 `cropRectTopLeftPx` capture，Android 收到原始分辨率 PNG 后自动保存到本地 Download/zterm；截图路径不得发送 `focus`、不得拉前台、不得读取本地 video/canvas surface、不得新增第二套截图/文件传输 pipeline，非法 target 必须显式 error，禁止 fallback 成全屏截图。UI 必须有非布局型 overlay 动画/进度与保存/失败提示，不能只在工具栏下方放一行弱状态。
- macOS app-window 原始截图必须用 native daemon 的 `screencapture -x -o -l<windowId>`，否则 `-l` 默认会包含窗口阴影导致 PNG 大于 daemon manifest bounds。更新 packaged global daemon 时必须同时验证 `android/release-dist/.../support/zterm-daemon`、`~/.zterm/releases/.../support/zterm-daemon`、`~/.zterm/bin/zterm-daemon` 三者 sha 对齐；`~/.zterm/bin/zterm-daemon` 是 Node runtime 缺少 `ZTERM_DAEMON_NATIVE` 时的 fallback 路径，不能残留旧二进制。
- 相关改动最小 gate：`RemoteWindowOverlay.test.tsx`、`TerminalPage.remote-window-overlay.test.tsx`、`session-context-remote-window-runtime.test.ts`、`session-context-transfer-runtime.test.ts`、`terminal-file-transfer-binary-runtime.test.ts`、`remote-window-stream-daemon.test.ts`、`terminal-message-runtime.test.ts`、`remote-window-video-quality.test.ts`、`tsc --noEmit`、`test:feature-registry`。daemon 可用时追加 live WS 显式错误/成功 smoke。

### 2.3 旧文档处理
- `android/note.md` 是 agent 自己看的工作台，不是主真源
- 探索过程里的高信号发现、假设、踩坑和回归锁定要写进去；不要把完整流程说明塞进 note

### 2.4 不在本项目范围
- screen 集成（用户自行管理）
- Tailscale 客户端集成（用户已有 Tailscale App）
- 密钥导入/生成（后续扩展）
- 数据加密存储（后续扩展）
- 生物识别解锁（后续扩展）

### 2.5 服务端位置
- WebSocket 服务端必须运行在本地 Mac/PC（不是手机）
- 手机端纯客户端角色

### 2.6 UI 参考图规则
- UI 开发前先冻结主参考图与次参考图
- 先对齐信息结构和交互结构，再做视觉细节
- 当前项目的主 UI 主线是：`Connections` 页 + 终端页，不是网页式主机列表页
- Jason 当前已明确认可的视觉真方向：**简洁、闭合、分区明确的 capsule/block UI**。后续按钮、快捷栏、卡片、面板默认优先使用低噪声配色 + 清晰边界 + 成组区域 + 闭合块状设计，除非该页面有明确反例需求。

### 2.7 页面级切片规则
- 页面级重构先看 `docs/ui-slices.md`
- App Shell、Connections、Connection Properties、Terminal 必须分层
- 不跨页混改；先壳后功能，先 ownership 后细节

### 2.8 卡片与预览区规则
- Connections 卡片的 preview 区在没有真实 preview 时，不要回退渲染 subtitle
- preview 和摘要信息必须分层：上半区负责 preview / 占位，下半区负责 title / subtitle / action
- 否则同一 host 摘要会在卡片内重复出现，容易被误判成渲染 bug

### 2.9 连接模型拆分规则
- mobile 的连接真源必须显式区分 `bridgeHost / bridgePort / sessionName`；禁止再用 `host/username` 混装 server 与 tmux session 语义
- Android Home 必须把三类入口独立投影：current-process active Sessions、saved direct/Tailscale Hosts、optional Relay account/directory。Relay 未登录、登录失败或退出登录不得隐藏、禁用或删除前两类；Relay directory 只补 route/device candidates，不得成为 saved Host/Tailscale truth owner。
- Android Home 的 Relay 路由必须显式可见：同 daemon 的 saved direct/Tailscale row 要合并 Relay directory `relayEndpointCandidates/relayHostId/relayDeviceId`，但保留 saved row 身份和显示端点；有 `relay-rtc` 时显示 Relay route 入口。Relay action 构造 `transportMode='auto'` 的 route-aware Host 交给 session-open owner，默认顺序必须是 `private LAN IPv4 -> Tailscale/direct websocket -> WebRTC direct/hole-punch -> rtc-relay(TURN)`；Relay 是最终中继，不是默认首选。禁止让 Relay directory 替换 saved Host truth，也禁止把 TURN-only 成功冒充 UDP/P2P 成功。
- Relay directory 投影到 Home / drawer / picker target 时只允许 online daemon device：`daemon.connected=true` 且 `daemon.hostId` 非空。`rtc-device-*`、client-only、disconnected/stale daemon records 即使携带旧 endpoint/session snapshots，也只能作为 account directory fact，禁止出现在 connectable server rows、drawer host rail 或 target lookup。
- Relay 登录态不能成为 Session Picker 的全局模式开关：即使账号下有在线 daemon，直接 Tailscale/bridge target 仍必须能输入、选择 saved server、用 `bridgeHost + authToken` live fetch sessions。只有当前 target 自身带 `relay-rtc` candidates / relay identity 时，才允许按 Relay target 处理；显式 `transportMode='webrtc'` / `relay-route` target 禁止在 `buildBridgeTargetFromHost()` 中自动解析 direct endpoint 填入 `bridgeHost`。
- Relay directory 的 direct endpoints 也是 daemon identity alias：drawer host rail / side peek / server identity projection 必须把 `100.x:3333`、IPv4/IPv6/wsUrl direct rows canonicalize 到同一 `daemon.hostId`，否则同一 daemon 会显示成“名字 0 sessions + IP 有 sessions”。alias 只能用于 UI 分组身份，不能替代 transport route truth。
- 生产 Relay directory 可能只发布 `relay-rtc:<hostId>`，没有 Tailscale/direct endpoint。修 drawer duplicate host 时不能只看 endpoint alias；必须同时验证 saved/Home server alias input，以及 rtc-only directory session catalog 的唯一匹配路径。只有一个 Relay daemon catalog 完整包含该 direct SessionGroup 的非 missing session 名称时才可 canonicalize；多个 daemon 都匹配时保持分离并显式暴露，禁止猜测合并。
- Terminal drawer 里以 Relay daemon `hostKey` 触发的 refresh / quick-new / remote catalog open 必须构造显式 `transportMode='auto'` 的 route-aware target：private LAN/direct IPv4 先试，Tailscale/direct websocket 其次，`rtc-direct` 使用 relay signaling + STUN-only ICE，`rtc-relay` TURN-only 最后兜底。验证必须证明 LAN/Tailscale 先于 WebRTC/TURN 被尝试；Tailscale 断开时再证明 WebRTC direct 或 TURN/Relay `list-sessions` / session open 可通。
- Terminal drawer catalog 若命中已打开的旧 direct/Tailscale session，也不能直接 `switchSession` 绕过 route owner；当 online Relay catalog 唯一 owns 该 daemon 时，点击该 row 必须继续走 session-open owner，用 route-aware target 复用并升级现有 session transport truth，禁止生成第二个同 tmux open tab。
- 如果同一个 session 因 direct/Tailscale 与 Relay route 切换而重新打开，session-open owner 必须先用当前 route-aware Host 重新 `createSession(..., { sessionId: existingId, activate: false })`，再做 explicit-resume；只切 open-tab/UI 但不重绑 transport truth 视为假修复。
- Terminal drawer 枚举必须在 `TerminalPage` canonical projection owner 内去重：direct/Tailscale history、Relay history、rtc-only catalog alias 若最终 resolve 到同一 daemon host rail，则同一 `serverIdentity.key + sessionName` 只能渲染一行；只允许合并 route/close/open target metadata。禁止在 `TerminalSessionDrawer` 组件里靠视觉过滤，禁止让 transport/daemon 参与 UI 去重。
- TerminalPage 是 memoized 组件；任何影响 drawer host identity / session enumeration 的输入（`relayDevices.daemon.endpoints`、`relayDevices.daemon.sessions`、saved/Home alias inputs）都必须进入 comparator 的 UI key。Relay device UI key 必须包含 session name / updatedAt，禁止只比较 endpoint/connected，否则 Relay stream 只更新 session catalog 时 drawer 会继续显示旧 host rail 或旧 session count。
- `SessionGroupHistory` 必须保留 normalized `relayEndpointCandidates`。drawer catalog open/close 和 session-open owner 之间要透传这些候选，否则从 drawer 点 remote-only session 会退化成 direct `bridgeHost/bridgePort` WebSocket，现场表现为 Relay 行可见但打开时报 `ws connect timeout`。
- Android Home 改版为 server-entry-only 时，仍必须保留**显式可见**的设置/升级入口；不要只留无文字齿轮或把入口藏在 Relay/login 语境里。Terminal 竖屏 shell 也必须有 Settings 入口，因为用户可能长期停留在终端页。升级实现仍只属于 Settings 的 App Update owner，Home/Terminal 只能发 open-settings intent，不新增第二套升级逻辑。
- Home 点击 saved Host 必须把 intent 交给 `useSessionOpenActions` 的 session-open 主线直接进入 Terminal；点击 active Session 必须走 open-tab/session owner resume。禁止 Home 直接 create/close session、写 Host storage、恢复 cold-start tabs，或用 Relay access token 做导航 gate。
- Home server row 无 saved `sessionName` 时不能直接创建 `zterm-*`。`useSessionOpenActions.handleOpenSavedConnection` 必须按 server owner 先用 last-entered history 命中当前进程 open Session；否则 live fetch tmux truth，优先进入仍存在的 last-entered session，没有历史则进入第一条远端 session；只有远端列表为空才创建 generated clean session。测试必须证明正常远端有 session 时 `createTmuxSession` 不调用。
- terminal header / live session / tab 文案必须能直接看出 `server + session` 组合，否则多 server / 多 tmux session 场景会失真
- 若 `bridgeHost` 已显式写成 `ws://host:port` / `wss://host:port`，Android / Mac / shared storage 都必须把这个 endpoint 当成 display / preset id / effective port 的唯一真源；表单也要同步把 `Bridge Port` 刷成同一个端口，禁止出现双端口假象
- 若用户在 `bridgeHost` 直接输入原始 `host:port`（如 `100.127.23.27:40807`），shared endpoint 真源也必须当场拆成 `bridgeHost=100.127.23.27` 与 `bridgePort=40807`；禁止再把它和独立 `bridgePort` 二次拼接成非法 ws URL

### 2.10 daemon 收敛规则
- server 侧启动入口要收敛成单一 daemon CLI，默认监听地址/端口由统一配置真源决定（当前 `0.0.0.0:3333`）
- relay/account 配置必须走全局发行包入口：先 `install-global.sh` 安装/升级 `~/.local/bin/zterm-daemon`，再用 `zterm-daemon configure-relay` 写 `~/.wterm/config.json -> mobile.relay`；daemon 只读取配置，不承载账号 UX，禁止把手工改散落配置当成最终交付。
- daemon 全局安装的稳定入口必须由包内脚本自固化：npm postinstall / service runner 要自动生成 `~/.local/bin/zterm-daemon` 与 `~/.local/bin/wterm`，写入前先清旧 symlink/file，released runner 读 config 前要迁移旧 `~/.wterm -> ~/.zterm`。如果只靠手工修 PATH、手工挪目录或改已安装文件，视为未修真源。
- relay account directory 发布必须来自 daemon truth：`relay-ready` 后由 daemon relay host client 发布 `directory-update`，session catalog 只能来自 tmux 枚举；枚举失败必须显式报错，禁止把失败伪造成空 sessions 的成功目录。
- relay smoke / 真实链路里 client device 与 daemon device 必须使用不同 `deviceId`；复用同一 id 会让 client metadata 覆盖 daemon directory identity，造成 account directory 假状态。
- Relay WebRTC signaling peer lease 必须按 `account + hostId + concrete client deviceId` 独立维护。Android 每安装实例生成并持久化自己的 relay client `deviceId`，`/ws/client` 必须携带它；Relay server 缺 deviceId 要显式拒绝，不能把匿名客户端合并或共享。普通 signaling socket close 只让该 device peer idle 30 分钟，不立刻通知 daemon close；同 device 30 分钟内重连复用 peerId 并重新 `rtc-init` 协商，不同手机必须得到不同 peerId。超过 30 分钟、host 替换或显式 `rtc-close` 才关闭 peer。验证 gate 是 `pnpm --dir android run test:relay:peer-lease`，并且不能把 terminal channel/tmux/mirror/UI truth 放进 lease。
- Android Relay client identity migration 必须在打开任何 Relay socket 前完成：旧安装持久化的固定 id（如 `zterm-android`）视为无效，必须迁移成稳定 per-install id，并同步 top-level account、nested `relaySettings`、startup `BridgeSettings`。否则升级后的两台手机仍会用同一个 `/ws/client?deviceId=zterm-android` 抢同一 peer lease。验证至少覆盖 legacy id 持久迁移、device stream URL/meta 使用迁移后 id、显式非 legacy id 不被覆盖、startup BridgeSettings 同步。
- Relay 网络切换后若 daemon 日志出现 `Failed to set local answer sdp: Called in wrong state: stable` 或 `Failed to set ICE candidate`，先查 `rtc-bridge` 信令顺序，不要去 UI/renderer/tmux 补偿。daemon RTC bridge 必须按 `peerId` 串行处理 relay signals；同一 `rtc-init` generation 只接受一次 offer；candidate 早于 offer/remoteDescription 时先缓冲，等 offer 应用后再 addIceCandidate。回归 gate 至少要有真实 WebRTC reorder 测试：candidate-before-offer 仍能打开 datachannel，且 duplicate offer 不触发 `stable` state error。
- Android relay account directory 的 client 真源是 `account.directory`；旧 `TraversalRelayDeviceSnapshot[]` 只能作为现有 UI 的 adapter projection，禁止在 Connections / Picker / Settings 各自从 legacy devices 反向补 endpoint/session 目录语义。
- Relay 登录态的默认 route 策略是 fast-path-first，不是 WebRTC 优先也不是 TURN-only：同一 daemon target 必须按 `private LAN IPv4 -> Tailscale/direct websocket -> rtc-direct(WebRTC hole-punch) -> rtc-relay(TURN)` 排序。`rtc-direct` 使用 `iceTransportPolicy=all` 且不得携带 TURN credentials；`rtc-relay` 使用 `iceTransportPolicy=relay` 且只在 LAN/Tailscale/WebRTC direct 都失败/不可用后承担中继。运行中 socket 因心跳/物理关闭失败时必须把当前 route 记入 health cache，让下一次尝试换路。验证时要分别报告 `resolvedPath=ipv4/tailscale/rtc-direct` 或 `resolvedPath=rtc-relay + resolvedRelayTransport=turn`，禁止把 Tailscale/局域网直连冒充 Relay，也禁止把 TURN-only 成功说成 UDP 打洞成功。
- WebRTC `connectionState=disconnected` 只能视为 transient ICE interruption，不能立刻投成 route failure；先在 `TraversalSocket` 内给 10s grace 并尝试 `restartIce()`，恢复到 `connected` 必须继续复用同一 data channel。只有 grace 超时、`failed/closed`、或 data channel 实际 close 才能记录 route failure / rebuild target transport。
- terminal 输入协议必须按 capability 分叉：旧 daemon 未声明 `connected.capabilities.reliableInput.version=1` 时继续 string-only；新 daemon 声明后，client 发送 `{version, seq, data, sentAt, attempt}`，daemon ack/dedupe，retryable `input_stale_transport/session_required` nack 不出队并同 seq 重发，`input_invalid/input_too_large` 才停止。daemon 永远不能把 object payload 写成 `[object Object]`。
- Relay account device stream 打开前必须先刷新 `/api/auth/me` 控制面真源并覆盖本地 `TraversalRelayClientSettings`；旧固定域名 `claw.codewhisper.cc` 只能作为历史别名迁移到 `relay.codewhisper.cc`，不得继续用于 TURN/WS。刷新失败时禁止打开 `/ws/devices` 或继续使用 stale TURN/WS 配置冒充 Relay 可用。
- Relay account device stream 必须区分 `directory-snapshot` 和 legacy `devices-snapshot`：directory 才携带 route-bearing daemon endpoints / tmux session catalog；devices snapshot 可能只是在线 presence。`App` 收到后续 endpointless devices snapshot 时只能更新 presence，不得清掉已收到的 directory endpoints/sessions，否则 Home/session-open 会拿到无 route candidates 的 daemon row 并弹 `Transport closed while managing tmux sessions`。回归 gate：`App.relay-stream-lifecycle.test.tsx` 需要先投递 directory，再投递 endpointless devices，断言 `useSessionOpenActions` 仍拿到 `relay-rtc:<hostId>` endpoint 和 session catalog。
- RTC signaling 收到 `rtc-error` 或 signaling socket 关闭后，client 侧 ICE candidate 回调必须检查 WebSocket `readyState` 后再发送，并主动收口 peer/signaling；禁止让异步 ICE candidate 往 CLOSING/CLOSED socket 继续 `send()`，否则用户会看到误导性的 `WebSocket is already in CLOSING or CLOSED state`。
- 发行包验证必须覆盖 native runtime 依赖：TURN/RTC 需要 `@roamhq/wrtc` 与当前平台 `@roamhq/wrtc-<platform>-<arch>/wrtc.node` 随 release staging 打包；只在源码环境通过不代表全局安装可启动。
- 验证过程中产生的临时 tmux session 需要及时清掉，只保留一个明确实验 session，避免把测试垃圾当成真实 session 列表
- `bridgePort` / daemon 端口 / daemon tmux session 名必须共用同一配置真源；不要在 UI、server、shell script、文案里散落硬编码
- daemon restart/status 只证明 tmux session 存在，不等于 socket 已 ready；验证时至少补一次端口监听检查或真实 WebSocket probe
- daemon 的唯一职责是 **维护 tmux truth mirror**；它不关心 client 本地 buffer、follow/reading、首屏、gap、渲染窗口
- daemon 内部必须 **writer / store / reader 解耦**：
  - writer：tmux sync / input / resize / live tick 更新 mirror
  - store：维护 canonical buffer、absolute line index、revision、available range
  - reader：`buffer-head-request` / `buffer-sync-request` 只读取当前 mirror store
- **禁止 read request 触发 write path**：任何 `head/range` 请求都不得 `await` tmux capture / canonical rebuild
- terminal 排版真源在 daemon / tmux；client 只上报 viewport(`cols / rows`) 并渲染镜像，不能在 keyboard 显隐 / pinch / rotate 时自行 replay buffer
- `wterm daemon start/restart/install-service` 不能只看 launchd loaded；必须至少等到 daemon 端口真正监听，再允许回报 ready，避免手机首连撞启动窗口
- websocket mux bridge 的 heartbeat 只能由 `resource.daemon_target_transport` 持有：同一 daemon target 只有一个低频（60 秒级）`mux-ping` timer，logical tmux session/channel 禁止各自发 heartbeat。合法 mux frame / `mux-pong` 更新 physical target activity；channel switch、foreground resume、body-subscription 不得创建第二个 timer 或第二条 WebSocket。只有 physical close/error/send failure 或 target health owner 确认 physical transport 失效才进入 target reconnect；单 channel error 只重开 channel。
- websocket reconnect / 首次 connect 完成后，active tab 必须立刻恢复 **head-first** 主循环（先 `buffer-head-request`，再按本地 buffer 状态决定 diff / 三屏重锚 / reading gap repair）；不能再依赖第二套 active/idle 语义
- scrollback 若通过 DOM prepend/trim 历史行，client 在“未贴底”时必须保 scrollTop 锚点；否则持续输出后回滚会像 buffer 丢失
- 手势滚动进入历史阅读态后，scroll lock 要做成 latch，直到真实输入发生才允许恢复 bottom-follow；不能靠“回到底部”自动解锁
- terminal 单指手势要先做 axis lock：竖向滚动在“确认纵向手势的那一刻”重取 `startScrollTop`，横向手势再切 tab；否则会出现“不是从当前底部开始滚”的跳变
- 多 tab terminal 在 hidden → active 切换时，不能拿 hidden 期间最后一次 `bufferUpdateKind` 去重算滚动锚点；inactive tab 应冻结 scroll/layout 推导，切回后只按“贴底/保留原 scrollTop”恢复
- mobile 光标不要额外开本地 blink 动画；只消费 bridge/buffer 的 cursor 位置，避免字体/viewport 变化后出现视觉错位
- 若要让 mobile 光标忠实镜像 tmux，`CellData` 真源必须包含 `width(0/1/2)`：client 只能按远程 cell 宽度/continuation 渲染 cursor，不能再按本地字符宽度猜位置
- 多 tab terminal 不允许只保留一个 active TerminalView 再靠 `outputHistory` replay；每个 session 必须常驻自己的 terminal 实例和本地 buffer
- terminal 持久化缓存不允许只拼 raw output chunk；应从本地 **absolute-index sliding buffer state** 按行持久化
- daemon 的初次 canonical capture 不能静默失败；capture 出错必须显式报错/记证据，但 daemon 仍只保留 `head + range` 读接口，不补第二份语义
- daemon 的 buffer 真源必须按 **tmux session mirror** 维护：一个 websocket/tab 只是客户端，不得拥有自己的 authoritative buffer；客户端 detach/reattach 不能重建 session 镜像
- 2026-05-06 新冻结：daemon 正常模式负责 **持续 mirror capture + live push**；mirror body unchanged 发 `buffer-head/info`，mirror body changed 发 `buffer-sync diff`。client 正常模式被动吃 push；只有 `resume / reconnect / stale probe` 才主动 `buffer-head-request`，只有 `reading gap repair` 才主动 `buffer-sync-request`
- 2026-04-23 新冻结：client buffer 必须是 **sparse absolute-index buffer**，允许不连续；worker 不为“完整性”主动补洞，只围绕当前工作集补缺：follow 维护尾部 3 屏热区，reading 只补当前窗口
- 2026-04-23 新冻结：renderer 只按 latest bottom-relative window 消费 buffer；UI shell 只负责容器位置/裁切；IME/keyboard 不得进入 buffer/render truth 链
- runtime 远程排障接口应收敛到 daemon HTTP：client 侧 runtime debug 只负责上送有界日志队列，daemon 侧统一缓存并通过 `/debug/runtime`、`/debug/runtime/logs` 暴露现场快照；接口复用 daemon auth token，便于服务器端直接拉取现场证据
- Node/daemon 侧若要复用 `packages/shared`，只允许 import **叶子模块**（如 `schedule/next-fire.ts`、`connection/types.ts`）；禁止从 `@zterm/shared` 根入口取模块，因为根入口会连带 React/CSS，直接把 daemon 运行时打崩
- 悬浮球快捷菜单的语义是“文本 snippet 注入”；方向键 / Esc / Tab / Backspace 属于常驻快捷栏，不要和自定义 snippet 共用同一概念模型
- session 级“定时发送”入口不要挂在 tab strip / header 这种易被理解成全局 tab 动作的位置；Android 侧优先放在当前 session 的 quick input/composer 入口里
- 悬浮球若持久化的是绝对拖拽坐标，mount / viewport resize 时必须自动 re-clamp 到可视区；不能只在拖动瞬间 clamp，否则旋转/尺寸变化后用户会丢入口
- 悬浮菜单打开时可以隐藏底部 shell rows，但关闭后必须立刻恢复；keyboard 弹起时只上抬 shell rows，本体悬浮球/面板不要跟着复用同一 transform
- 悬浮菜单内的快捷输入列表点击语义是“立即发送 snippet”，默认补 `\r` 执行；只有剪贴板注入才追加到 draft，不要混成同一路径
- terminal follow 态不要在每次 buffer/input 到来时直接同步硬改 `scrollTop`；应合并成单向 cadence（如 rAF）贴底，并屏蔽程序化 scroll 反向触发 onScroll，避免底部抖动/拉扯
- `TerminalView` 的 follow 对齐若会被 active/reset/layout/audit 多个入口复用，必须先收成单一 helper；scrollTop -> follow/reading 判定也要保持纯 helper，避免同一真相在多个 effect 里分叉
- `updateSessionViewport()` 这类 worker 入口必须对完全相同的 reading viewport 去重；若从 reading 切回 follow，要同步清掉已排队的 reading sync，不要让旧 request 在 follow 态晚到
- follow viewport state / bootstrap 这类 transport 决策若会被 `active switch`、`follow reset` 等多个入口复用，必须先收成单点 helper；不要让同一 follow 真相在两个分支各算一遍
- `connectSession` / reconnect 若重复的是 socket 握手、heartbeat、公共 message switch，就抽 transport helper；但 `connected` 后的状态推进、bucket 排队、副作用仍保留在各自分支，不要为了去重把两条链混成一条
- 若 connect / reconnect 在 `connected` 后共享的是同一份 baseline 推进（connected state、schedule-list、active bootstrap、watchdog、connectedCount），可以再抽一层公共 helper；但 bucket reset / pending input drain / retry 队列推进仍留在各自外层
- `finalizeFailure` 若共享的是完成位、cleanup、schedule error、manual-close 终止，也可以再抽一层 failure baseline；但 retry、bucket attempt、pending requeue 仍留在各自外层
- `TerminalView` 缩 effect 面时，若重复的是 viewport refresh 调度或当前 viewport emit，先抽本地 helper（如 `scheduleViewportRefresh` / `emitCurrentViewportState`）；先单点化动作，再决定是否减少 effect 数量
- 同理，reading viewport emit 若在 prepend 历史重锚和 near-edge reading 两处重复，也先抽本地 helper（如 `emitReadingViewportState`）；renderer 收口先做动作单点化，不急着硬合并 effect
- follow reset、prepend 历史锚定、near-edge reading emit 这类 viewport action 若还散在 effect 里，也继续抽本地 action helper（如 `resetViewportToFollow` / `anchorReadingViewportAfterPrepend` / `emitReadingViewportIfNearEdge`）；先把动作名字化，再看 effect 是否还能继续收
- 若 `becameActive` 与 `viewportResetNonce` 最终都只是在触发同一 follow reset 动作，可以继续并成一个 reset effect；但要保住 session 切换时 ref 初始化的语义，不要把 reset 信号提前吃掉
- 同理，若‘当前 viewport emit’与‘reading near-edge emit’只是同一阶段里的两次 emit，也可并成一个 effect；前提是 `emitViewportState` 的 dedupe key 仍能兜住重复发送
- tab strip / shell header 不要保留浏览器默认 focus ring；移动端若无键盘导航需求，容器与 tab 按钮默认 `tabIndex=-1 + blur + outline none`
- 拖拽排序类交互若在 `pointerMove` 更新 React state、`pointerUp` 立即提交，必须用 ref 同步保存最新 dragState；release 不能只读 state 闭包，否则会出现“拖了但顺序没生效”
- keyboard 关闭态不要在 quick bar / bottom overlay 外层保留空 `transform`（如 `translateY(0)`）；这会让内部 `position: fixed` 的悬浮球/面板改绑到容器坐标系，导致入口“消失”
- 快捷按键编辑器里，组合键默认名必须来自最终组合 preview，而不是第一个被点击的 modifier token；否则 `Ctrl + C` 会被错误保存成 `Ctrl`
- Android / Mac 若都要消费快捷按键组合规则，编码/反解/默认 label 必须下沉到 shared 纯函数；平台 UI 只保留 token 编辑与展示，禁止再复制一份组合算法
- 快捷按键 modifier 是 one-shot 语义：`buildTerminalShortcutSequence()` 按 token 顺序消费 pending modifier，只修饰后面的第一个目标键，然后清空；例如 `Shift + ← + a` 编码为 `\x1b[1;2D` + `a`。不要恢复“有 modifier 只能一个目标键”的限制，也不要让平台 UI 自己实现 Shift/方向键规则。
- Android WebView 若出现“sheet/表单看起来不能滚”，先不要凭截图猜高度；应先附着 `webview_devtools_remote_<pid>` 给目标滚动容器打 `touchstart/touchmove/scrollTop` probe，并用 `adb logcat` 验证 `defaultPrevented` 与 `scrollTop` 是否真实变化，再决定改事件捕获还是布局
- Android IME / viewport / keyboard lift 计算只能有一个 helper 真源；页面层不得复制 `resolveKeyboardLiftPx` / viewport height 逻辑。若键盘弹起后出现 gap、内容缺失或 quickbar 错位，先确认 WebView 是 overlay 还是 adjustResize：已 resize 时用当前 viewport height 且 lift=0，overlay 时才用 stable height + lift。
- IME 高度事件可能先于 OEM `visualViewport.resize` 到达；viewport listener 必须把 current layout height 写入 React UI-shell state，不能只更新 width/top inset。否则后续纯高度 resize 不触发 render，会把首帧 overlay lift 冻结成偶发过度上抬。红测必须按 keyboard-first -> layout/visual resize -> adjustResize zero-lift 顺序重放。
- Android IME 容器上台只允许 UI shell 消费：`TerminalPage` 计算 `terminalStageBottomPx = terminalChromeBottomPx + terminalImeLiftPx`，QuickBar shell 用同一个 `terminalImeLiftPx` 上台；`TerminalView` 不接收 IME layout token、不触发 Android upstream `onResize`、不把 keyboard 高度写回 daemon/tmux。
- Android Terminal quickbar 预留只能来自真实测量：`terminalChromeBottomPx = measured quickBarHeight + safeOffset`，`terminalStageBottomPx = terminalChromeBottomPx + terminalImeLiftPx`，QuickBar shell bottom = `safeOffset + terminalImeLiftPx`。禁止为了 IME 或默认态位置引入固定 `render lift`；也禁止 IME active 时只裁到 `terminalImeLiftPx` 而不预留 measured quickbar 高度，否则会遮挡终端内容。
- QuickBar 自身测量不能扣 `keyboardInsetPx`：IME lift 已由外层 `TerminalQuickBarShell.bottom` 消费，`TerminalQuickBar.onMeasuredHeightChange` 只能上报真实 chrome 高度。否则键盘高度大于快捷栏时会把 `quickBarHeight` 压成 0，stage reserve 丢掉 QuickBar 高度。
- 折叠屏竖屏 / 紧凑横屏底部快捷栏避让也必须归 `terminal-keyboard-lift.ts` helper；TerminalPage 只能消费 `terminalBottomChromeLiftPx` 并同时加到 stage reserve 与 QuickBar shell bottom。foldable portrait 必须同时满足宽屏和 `height >= width`，compact landscape 必须限制 `height <= 480`；禁止让桌面样宽屏或 stale orientation 获得 mobile bottom lift。
- foreground 恢复不要无差别重连所有 session；默认先恢复 active session，其余只补非健康 session，避免 hidden tabs 被一起拉起放大带宽
- foreground reconnect 若对同 host 多 session 走串行 bucket，必须把 active session 排在第一位；reconnect 成功后要立刻补一条 tail refresh request，但 **hidden->active / foreground refresh 不要无脑 bootstrap 整个 tail**：本地尾窗连续时只发带本地 revision/window 的 follow request，只有尾窗缺口或空 buffer 才 bootstrap；同时补一发 `ping` 做短超时 watchdog，避免“切回 tab 还是旧画面却迟迟不重连”
- foreground / explicit resume 的 `forceHead` 不能被 active-reentry 去重 guard 吃掉：`lastActiveReentryAtRef`、`connectedBaselineBurstGuardRef` 只能抑制 passive `active-reentry` 重复 head；`explicit-resume + forceHead` 必须在同一 OPEN WebSocket 上发送 `buffer-head-request`，否则会出现“连接还在但后台返回/网络波动后界面不刷新”。
- 2026-05-13 新冻结：open-tab runtime switch 必须永远拆成两条语义：
  - `restore-sync` = 只恢复 local shell / active runtime，不开 transport
  - `explicit-resume` = 用户显式激活后才允许 `resumeActiveSessionTransport`
  - 若 UI 只是把 active tab 切对了，就宣称 connected，这是假状态；transport freshness 真源只能留在 `SessionContext`
- `createSession(connect:false)` 虽然不打开 WebSocket，但必须恢复 session transport host / target identity；否则前后台返回或 persisted tab resume 会出现 `targetKey=null -> missing-target -> reconnect`，把同一 daemon/session 错误重建成新 WebSocket。这个修复只能放在 `createSessionRuntime` / SessionContext transport owner，禁止在 App/TerminalPage 用 reconnect 补偿，也禁止让 reconnect planner 对 missing target 做宽松 fallback。
- 相关回归至少保留三条：
  - cold restore 不自动打开 daemon transport
  - explicit tab switch 触发 `explicit-resume`
  - foreground/active refresh 不得在 App 层长出第二套 transport reopen 语义
  - restored local shell 必须写入 transport identity；Home->返回后 `/debug/runtime.transportSubscribers[0].id` 不应变化，日志不得新增 `missing-target` / `transport-detached` / `rebuild`
- 历史教训：`adaptive-phone` 通过 tmux `resize-window -x` 收窄宽度会自动切 `window-size=manual`，并可能把高度冻结在进入 manual 时的值；当前产品要求仍必须让 tmux 按最窄手机宽度重排，因此 resize 只能集中在 daemon adaptive lease owner，并且最后一个 lease 消失必须恢复 baseline + `set-window-option -u window-size` 释放 tmux 宽度控制权。要验证这点，必须跑真实 tmux PTY 回归，而不是只看源码里有没有 `-y`。
- active + follow tab 不能只赌 tmux observer push；必须保留一个**低频 tail probe**（follow delta request + ping + 短 watchdog）作为漏通知自愈链路，否则会出现“终端实际在更新，但 UI 只有等本地输入/切换后才动”的假静止
- same-socket `buffer-head-request` 超时不是 WebSocket 失败真相；只要 session socket 仍是 `OPEN`，activity/foreground owner 只能清 stale probe marker 并在同一 socket 继续请求 head，禁止调用 `reconnectSession()` 重建。
- active transport freshness 不能等长 heartbeat timeout；active tab 若几秒内没有 server activity，`SessionContext` 必须先发 `buffer-head-request` probe。短等无响应只能继续同 socket probe / 显式暴露等待状态；除物理 close/error、target mismatch、missing/closed socket 的显式 open/resume 外，禁止强制替换 socket。UI 不得自行判断 timeout / 直接重连。
- physical transport activity 与 terminal render freshness 必须分开：任意有效 frame 可更新 `lastServerActivityAt`，但只有 `buffer-head` / `buffer-sync`（含 mux channel 内嵌消息）能更新 `lastTerminalActivityAt` 并清 pending head probe。`title`、`schedule-state`、`input-ack`、`mux-channel-opened`、diagnostics 不能让绿色连接状态掩盖正文停刷。connected baseline head 只提供一个 `lastConnectedBaselineAt` 有界 freshness 窗口，不占长期 stale probe；窗口到期后 active tick 必须在同一 socket 继续 probe。
- daemon physical transport stale cleanup 必须严格晚于 Android target heartbeat 失败 contract。当前 Android 是 60 秒一个 target heartbeat、连续 3 次 miss 才判物理失败，因此 daemon bound 不能短于 180 秒，当前取 190 秒；10 秒 cleanup 会在首个 client heartbeat 前释放 subscriber，制造“手机绿色连接且有流量，但正文和 remote-window catalog 都不刷新”的分裂真相。遇到该症状先对照 daemon `/health` 的 sessions/subscribers 与 `stale inbound heartbeat` 日志，禁止在 UI、renderer 或 catalog 层补 reconnect。daemon-side transport lifecycle 交付必须完成 prepared/installed runtime SHA 对齐、service-scoped restart、`/health` PID/uptime，以及同一 quiet mux transport 静默 11 秒后仍能发 target/catalog request 的 live smoke。
- terminal mux refactor 下，物理 WebSocket 与 session channel 是两层真相：reconnect/open 只能为同 target 创建一个 physical mux socket，并把所有待恢复 session channel 显式置为 `opening` 等 `mux-ready` flush；flush 需要 active/anchor channel 优先，但不得靠新建第二个 socket 实现优先级。用户 input/file payload 只能在该 session channel `open` 后发送；`opening` 状态即使 physical socket 已 `OPEN` 也不能写用户输入。`mux-channel-message` 内的普通 `{type:'closed'}` 是 channel retryable close，先标该 channel `closed` 再在同 physical socket 上重发 `mux-channel-open`，不要投 UI terminal closed，也不要恢复旧 per-session socket 断言。
- terminal mux channel readiness 不能用 `mux-channel-opened` 判断。`mux-channel-opened` 只是 daemon 分配逻辑 channel；真正可渲染必须等同 channel `connected`，再拿到非零 `buffer-head` 或 `buffer-sync`。`mux-channel-opened` 只能清掉 channel allocation timeout，并必须立刻重挂 bounded terminal-ready timeout；如果同 channel `connected` 没回来，要显式 retryable failure，禁止 pending open 挂死。`mux-channel-open` 必须带初始 `bodySubscribed`，inactive channel 可 attach 但不触发初始 body capture；active 时再发 channel-bound `body-subscription true + buffer-head-request`。mux 模式下 body-subscription reconcile 必须通过 `readSessionTransportResource(sessionId).socket` / target mux socket 发送，不能读 legacy `readSessionTransportSocket()`；后者在 mux channel 下应为 null，否则会出现“输入能发、画面不刷新”的假连接。修这类 bug 的黑盒 gate 必须是冷 daemon、一条 physical WebRTC/WS mux transport、枚举出的每个 tmux session 逐个 open/activate/render 对比；`list-sessions` 和 warm mirror 成功都不能算闭环。
- drawer refresh / quick create / remote kill 这类 tmux management 不允许在已有匹配 Session/target transport 时新开 legacy `TraversalSocket`。必须先通过 `SessionContext.manageTmuxSessionsOnOpenTransport()` 在既有 target mux physical socket 上发 `mux-target-message`；只要存在匹配的非 closed Session，就算 mux 尚未 ready 也不能 fallback 到第二条管理 socket，必须显式等待/报错。只有完全没有匹配 open Session/target 时，才允许走 legacy `tmux-sessions.ts` 管理连接。
- terminal mux / transport accessor 新增时，不能只在 unit mock 或 facade 参数里接线；必须从 `useSessionProviderCoreAssemblies()` result、assembly types、facade、lifecycle runtime 全链路暴露，并用 `SessionContext` 级黑盒 gate 证明真实 provider 能读到该 truth。否则会出现 mock 测试绿但实际链路读到 `null`，例如 physical socket 仍 `OPEN`、terminal channel 已 `closed`，切回时继续向死 channel 发 head 并最终 timeout。
- `rtc data channel error` / `terminal mux transport closed` 是 physical target failure，不是某个 tmux session 的 channel error。Android 必须在 `terminal.transport_lifecycle` owner 中把同 target 下所有 logical channel 一起标 closed：pending open 走原 retryable failure，非 pending session 走 immediate/reset reconnect；同时清 target mux socket/ready。禁止只让创建 physical socket 的 anchor session fail，否则会出现“同一条连接里有些 session 好、有些 session data channel error/空屏”的分裂投影。
- daemon 初始 buffer sync 不能发送无限全量大帧。若第一次 live sync 超过有界阈值，必须降成当前 live tail payload，让 renderer 先拿到可用尾窗；这属于 daemon mirror reader 输出有界化，不允许改 tmux truth、client renderer 或 route fallback 补偿。
- 若 Android 端启用新的 terminal mux 协议，Mac daemon release artifact 也必须同步包含 `mux-hello` / `mux-ready` / `mux-channel-open`。只跑 `build:android` 但没有重新 `daemon:prepare-release` 会导致 APK 新、daemon 旧，现场表现为 `terminal mux channel open timeout`。修复顺序：`daemon:prepare-release` -> install-global -> service-scoped restart -> `/health` 新 PID/uptime -> live mux smoke。
- Auto route selection 不再消费旧的 saved `traversalPathPriority`。默认顺序是 `Tailscale/direct websocket -> WebRTC UDP direct -> TURN/Relay`；用户只在状态条里做显式 manual override，manual override 不改全局 Auto order，也不让 session 拥有 route truth。
- 若 daemon 代码已更新但 `~/.wterm/daemon-runtime/server.cjs` 仍残留旧符号（如 `scheduleMirrorFlush`、旧 planner/active-push 逻辑）或 `/debug/runtime` 仍 404，先判定为 **staged runtime 未切新**；必要时本地执行 `prepare-global-daemon-release.sh`，覆盖 `~/.wterm/daemon-runtime/` 后只对 `com.zterm.android.zterm-daemon` 做单服务 `launchctl bootstrap/kickstart`
- buffer manager 不允许直接把 renderer 切回 follow；它只能更新本地 buffer/head 并通知 renderer。renderer 只允许因 **重新进入 / 下滚到底 / 用户输入** 退出 reading
- Android renderer 新冻结：唯一状态是 `renderBottomIndex`；`renderTopIndex` 只能派生，reading/follow 都只改 bottom pointer，renderer 不得参与 buffer 生产或把 producer bottom 写回 source
- active tab 的 follow 三屏窗口允许存在 gap；`TerminalView` 不能因 visible/precheck window 不连续而冻结上一帧，必须先渲染最新 tail + 空白 gap 占位；**follow 态禁止 prefetch/request 补洞**，只等 live tail 或显式切到 reading
- active 页的 gap repair 只针对 reading 态当前三屏窗口命中的缺口；不要从旧 stop point 连续追到最新，窗口外内容允许保持不连续以控制带宽
- reading 贴近缓存顶部时，3 屏只是 cache window，不是滚动上限；要先预取前两屏并显示 loading，再继续上滚，不能把顶部卡成固定三屏
- client 本地 cache window 必须围绕当前 reading viewport 动态移动；禁止 trim 时永远只保最新 tail，否则向前补到的历史会被立刻愚蠢扔掉
- terminal 主题切换的真源是“默认前景/背景 + ANSI 16 色 preset”，不是只换容器背景；主题 id 应持久化到 shared `BridgeSettings`，Settings 只做 preset 选择
- Android / Mac 若都要支持 terminal 主题，preset 与颜色算法必须下沉到 shared 纯模块，平台 TerminalView 只消费同一份 preset，避免 ANSI 映射再次分叉
- 若 Settings UI 把主题卡片标成“正在使用/Active”，点击卡片就必须立即写入真实持久化存储；不能只停留在本页 draft，否则用户切出去再回来会恢复默认主题，属于典型假状态
- `BridgeSettings` 里的 `terminalWidthMode` 是启动排版唯一真源；storage hook 首次 render 必须同步读取 localStorage 并 normalize，禁止先返回默认 `mirror-fixed` 再等 effect 修正，否则 restore/connect 首帧会按错误宽度模式连接。
- Settings 保存 `terminalWidthMode` 时必须以 Settings draft `next` 为真源写回 `BridgeSettings`；禁止用旧 `current` 计算后只取 `.terminalWidthMode`，否则用户从 fixed 点 adaptive 后保存仍会被旧 fixed 覆盖。
- 首装或旧配置缺 `terminalWidthMode` 时，默认模式判定必须优先用 `visualViewport.width`；Android WebView / 折叠屏可能首帧 visual viewport 窄但 layout viewport 宽，禁止用 `Math.max(innerWidth, documentElement.clientWidth, visualViewport.width)` 把手机错判成 `mirror-fixed`。
- 旧 `terminal-width-mode` localStorage key / `TerminalWidthModeManager` 属于分叉真源；不得恢复。宽度模式只允许经 `STORAGE_KEYS.BRIDGE_SETTINGS -> BridgeSettings.terminalWidthMode -> TerminalPage/SessionContext`。
- Session runtime 里的 `requestedTerminalGeometry` 只允许保存 measured cols 事实，不允许把历史 `widthMode` 反过来覆盖当前 `BridgeSettings.terminalWidthMode`。connect/reconnect/open payload 的 width policy 必须以当前 BridgeSettings 为准；否则用户从 fixed 切到 adaptive 后，旧 session geometry 会继续发 `mirror-fixed`。
- adaptive width 问题不能只查 Android APK：`APK latest`、`latest.json`、`~/.zterm/daemon-runtime/server.cjs` 含新代码，都不证明运行中的 Mac daemon 已加载新 runtime。涉及 daemon-side adaptive/mirror/scheduler 修复时，必须看 `/health` 的 `pid/uptimeSec` 是否是更新后的进程，并跑真实 WebSocket + tmux probe：发送 `connect/resize widthMode=adaptive-phone cols=N` 后，用 tmux `#{window_width}x#{window_height}` 验证列数不因 adaptive 改变。若 daemon uptime 早于 runtime 更新，先做 service-scoped `zterm-daemon restart`，禁止把手机端继续改成补偿路径。
- `adaptive-phone` 没有 active 客户端时必须释放本轮 adaptive lease 对 tmux 的宽度控制权：先按 owner 捕获的 baseline 恢复宽度，再 `set-window-option -u window-size`。禁止 daemon-start 用 orphan heuristic 自动改用户 session；只有当前 owner 持有过 lease 才能释放本轮 lease。
- `adaptive-phone` 不得写 `@zterm_adaptive_width_*` 持久 option；baseline 只能是 runtime 内存 metadata。若旧 daemon 已留下历史 override，先报告现场事实，除非本轮 adaptive owner 正在释放自己创建的 lease，否则不要在启动时自动清理。
- daemon 不能为了移动端 mirror 修改用户 tmux 的 `alternate-screen`。`assertTmuxSessionExists()` 只能 `has-session`；control/capture runtime 禁止 `set-option -t <session> alternate-screen off`。如果 iTerm2/TUI 显示不全但 `window-size=<default>`，要继续查 `alternate-screen` local override；正确修复是删除 daemon 副作用并 unset 历史 local option，不是在客户端补偿。
- daemon 可以请求 tmux 执行真实用户操作（例如 input、create/kill/rename session）；`adaptive-phone` 也只能由 daemon adaptive lease owner 请求 tmux 改变宽度。移动端调试时禁止把“客户端 cols=N”直接当成“mirror cols=N”；必须等 daemon capture / tmux pane metrics 主线回写 mirror truth，且 gate 禁止 attach/resize/startMirror 自写 `mirror.rows/cols/bufferStartIndex/bufferLines/cursor`。
- `adaptive-phone` 可见宽度要求是 tmux 真实重排，不是客户端 renderer 本地投影：Settings / BridgeSettings / connect payload 显示 adaptive 只证明配置和 wire，不证明 tmux 已按手机宽度重排。禁止用 renderer crop 冒充 adaptive；也禁止在现有 fixed-row virtual scroll 上用 CSS `white-space: normal` / `height:auto` / wrapper width 做浏览器自换行，这会破坏 `scrollTop -> row index` 映射，表现为上滚循环、buffer 反复和 IME 后底部不可见。正确路径是 client 上报 measured cols -> daemon adaptive lease owner 聚合最窄 cols -> tmux `resize-window -x` -> mirror capture/readback -> client 渲染。
- 终端 viewport 周围不能画 `cardBorder` / 亮色 shell border；深色 terminal 左侧 1px 外框会被用户看到为白条。白条排查顺序：先查 stage/pane/group center border，再查 `.wterm` 内部 scrollbar，再查 DOM input/focus ring；禁止改 daemon/buffer/tmux 补 UI chrome 问题。
- `adaptive-phone` wire payload 必须带有限正数 `cols` 才能进入 daemon adaptive width lease owner；缺 cols / NaN / 0 是协议错误，不是可用 lease。daemon 必须显式返回 `adaptive_width_cols_invalid` 并保持进程存活，禁止让 `normalizeTerminalCols()` 的异常穿透杀掉 Node。client 冷启动尚未测量真实宽度时，先发送 SessionContext 默认启动列数，后续 TerminalView resize 再覆盖为真实列数；禁止发送 `widthMode='adaptive-phone'` 但 `cols=undefined` 的半语义 payload。
- daemon live diff 的 `buffer-sync` wire payload 必须覆盖首个 changed range 到最后 changed range 之间的完整连续 authoritative span；禁止只发送不相邻变更行并让 client 保留中间旧行，否则快速 TUI 输出会出现旧 buffer 闪回。若需要降带宽，必须先设计多 range wire contract 和 client apply 红测，不能把有洞 payload 伪装成完整窗口。
- 若当前 repo 是 fork runtime 真源，发布 npm 时必须直接发布 **本 fork 源码编译产物**；禁止通过 wrapper / alias / “套一层别人已发布包” 来冒充 fork 发布，这会破坏后续升级与维护链路

### 2.10.1 Remote window video hard gates
- `desktop.remote_window_stream` 的视频真源只允许来自 daemon/native `ScreenCaptureKit -> WebRTC`。Android `<video>` 只能消费 negotiated `MediaStream`；禁止用 screenshot loop、terminal mirror、client sparse buffer、static/mock receiver 冒充视频。
- ScreenCaptureKit crop frame 可能是奇数宽高。daemon `I420` buffer 必须按 `width * height + ceil(width/2) * ceil(height/2) * 2` 分配；禁止用 `floor(width * height * 1.5)`。此类错误会让 `@roamhq/wrtc` 抛 byteLength 异常并杀掉 daemon，Android 现场表现为 `Remote window stream start timed out`。
- `capture onFrame -> rgbaToI420 -> RTCVideoSource.onFrame` 必须包在 stream owner 的错误收口内：失败时 stop capture、stop track、close peer、发 explicit stopped/error status，禁止异常穿透到 launchd 进程。
- 视频闭环不能只看 catalog、单测或 `<video>.readyState`。最低黑盒 gate 是受控 AppKit/窗口 marker 通过 Android WebView canvas 采样到预期颜色；同时确认 daemon `/health` PID 没变、stream stop 后 capture 子进程清理干净。
- daemon 运行日志路径以 launchd plist 为准；当前全局服务 stderr/stdout 在 `~/.wterm/logs/launchd-stderr.log` / `launchd-stdout.log`，不要只看旧 `~/.zterm/logs`。
- remote-window catalog 的 partial source error 不是阻塞弹窗：只要 targets 非空，picker 不显示 iTerm2/source partial error 条；只在无可选目标或顶层失败时显式显示错误。
- remote-window floating stream 不隐藏 QuickBar；只有 picker 和 fullscreen 抑制 QuickBar/IME/body-subscription。浮动预览必须按所选 manifest 的窗口/裁切 aspect ratio 定尺寸并允许边缘 resize 保持该 aspect ratio，不能固定 16:10；入口悬浮标可拖动且同一拖拽手势不能合成点击打开 picker，Android WebView 下必须支持长按先进入拖动语义再移动；若父级裁切导致入口只能移动几像素，入口坐标必须切到 fixed/viewport owner；浮窗本体拖动只属于 toolbar，必须 `setPointerCapture/releasePointerCapture` 并处理 toolbar-local `pointermove/up/cancel`，不能只依赖 `window.pointermove`；fullscreen 必须有显式按钮、Back/minimize 回浮窗、pinch zoom、zoom 后单指 pan、右上 minimap。
- remote-window fullscreen display mode 只属于 Android overlay projection：默认 aspect-fit 完整显示；aspect-fill 必须是等比 cover/crop 充满横竖屏 phone surface，不可拉伸变形。绘制和 pointer/input mapping 必须共用同一个 projected content rect，禁止为了填满屏幕去改 daemon capture geometry、Mac coordinate manifest、WebRTC negotiation、tmux width、terminal mirror 或 renderer。
- remote-window 视频是独立 WebRTC peer connection，但 ICE 配置必须从当前 session traversal route 派生：`rtc-direct` 用 STUN-only direct ICE，`rtc-relay` 用 Relay TURN ICE。5G/Relay 下禁止让 remote-window video 用空 ICE 启动，也禁止失败后假装截图/terminal buffer 视频成功。
- remote-window 输入回传必须走 `remote-window-input` 显式协议和 daemon `injectInput` owner；Android 只按 manifest crop 归一化 pointer/key intent，不能在 UI 做 macOS 坐标真源或假注入成功。
- remote-window target-locked 浮窗必须消费 Android IME 的 `bottomInsetPx`，不能只抬入口悬浮标；fullscreen 继续只服从 safe-area。远程 IME committed text 保持原始 CJK/特殊字符/换行，不走 terminal punctuation/newline normalization。
- remote-window fullscreen 在 IME 打开时也要消费 `bottomInsetPx` 作为 overlay padding，并允许本地 letterbox pan 避开键盘遮挡；这只是 Android projection，不得改变 page shell layout、daemon capture/crop、Mac 坐标、tmux 宽度或 terminal renderer。
- remote-window 未放大全屏和浮窗中的单指拖动语义是远端 `gesture/swipe`，Android 只发送一次识别后的 gesture 命令；只有 fullscreen `scale > 1` 时单指拖动属于本地 pan。mouse/trackpad wheel 仍是 pixel scroll。协议 delta 保持 DOM 正向（down/right 为正），daemon `CGEvent` 注入层唯一取反为 macOS wheel 值，禁止 Android 和 daemon 双重取反。
- generic app `os-event` 输入必须有 Accessibility 权限并使用 `bring-to-focus`；只 `NSRunningApplication.activate` 不够，尤其是微信/被遮挡窗口。只有真实用户操作瞬间才允许发 explicit `focus` intent：pointer / gesture / wheel / key / QuickBar / IME 事件必须紧邻 focus-first；stream start、视频 attach、fullscreen、IME lift、pinch/local pan 不得抢焦点。iTerm2 pane/read-only target 禁止发送这些 intent。daemon input config 必须带目标 `windowId/title/bounds`，按 `CGWindowList` bounds 匹配 AX window，执行 `AXRaise` / focused window，验证 frontmost + focused 后再发 Quartz pointer/scroll/gesture/key event。`CGWindowList` top-left 坐标可直接用于 `CGEvent` location，禁止再用 AppKit bottom-left 转换。`no-focus-steal + os-event` 必须显式报错，不能宣称输入成功；验证应使用“目标窗口被 cover window 遮住，未 AXRaise 不动，AXRaise 后真实滚动”的黑盒。
- generic app `os-event` 输入不能每个事件启动一次 `swift -e`；点击、滚动、gesture、键盘是连续流，daemon 必须用唯一常驻 Swift helper。Swift schema 必须匹配 wire union：scroll 没有 `phase`，gesture 要求 `phase=end`，pointer/key 才要求 `phase`。黑盒必须通过运行中 daemon WebSocket 启动真实 app-window stream，对受控 AppKit 窗口发送 pointer/scroll/gesture/key 并读取目标 stdout，再把 iTerm2 切前台后用 harmless pointer move 验证 WeChat 可被 AXRaise 到前台。
- remote-window 截屏交付最低 gate：Android overlay/button 测试证明点击截图不发送 `remote-window-input`；TerminalPage 测试证明 selected target manifest 进入 `remote-screenshot-request` 并自动落盘；daemon file-transfer 测试证明 app-window 走 `--window-id`、iTerm pane 走 `--rect`、非法 target 不 fallback；native Swift 至少编译并通过 1x1 rect capture；若 daemon 已运行，必须 service-scoped restart 后验证 installed native 支持 `--window-id/--rect`。
- remote-window / daemon-side 代码改动后，APK 版本号变化不代表 Mac daemon 已加载新输入逻辑。必须 `daemon:prepare-release` -> 安装 release 包内 `install-global.sh` 或等价 global release -> `~/.local/bin/zterm-daemon install-service` / service-scoped restart -> `/health` 新 PID/uptime -> launchd runner 确认 exec `/Users/fanzhang/.zterm/releases/zterm-daemon/<version>/runtime/server.cjs` 而不是旧 `~/.zterm/daemon-runtime/server.cjs` -> installed runtime SHA 等于 `android/release-dist/.../runtime/server.cjs` -> live catalog/input smoke。否则 Jason 升级 APK 会看到“没有任何变化”。
- remote-window 输入交付的最低 live gate 是运行中 daemon WebSocket/WebRTC 对受控 AppKit 探针窗口启动 app-window stream，发送 focus、pointer down/up、scroll、gesture、key down/up，既要看到 `remote-window-input-result accepted=true`，也要从目标进程 stdout 观察到对应 OS 事件。固定入口是 `pnpm --dir android exec tsx scripts/remote-window-live-input-probe.ts`；probe 必须创建临时 `.app` bundle，避免 unbundled Swift 脚本没有 bundle id 导致 focus 结果偶发失真。没有这个 gate，只能说单测/构建通过，不能说本地交互验证完成。
- daemon 内部调用 `remoteWindowStreamRuntime.injectInput()` 也必须满足与 Android client 相同的实时输入 contract：每个 payload 都要有新鲜 `clientSentAt`。典型路径是 remote-window image paste 写 macOS clipboard 后注入 Command+V；时间戳构造必须放在 `remote-window-stream-daemon` owner helper，禁止 `server.ts` 胶水层手拼缺字段 payload，也禁止放宽 daemon stale 校验来掩盖内部调用错误。

### 2.11 Drawer / sheet 交互收口
- 抽屉底部这类单按钮动作只保留一个语义 owner，不要在同一按钮上同时挂 `pointerup` / `touchend` / `click` 再加时间戳去重。
- `touch` / `pointer` 只适合手势关闭、拖拽、滑动判定；如果按钮点击在真机上失效，先收敛成单一语义路径，再补回 regression test。
- Android WebView 会在一次 touch 序列结束后合成 `click`，如果 drawer/sheet 在 release 后才出现在手指下面，这个合成 click 可能命中新出现的 row。任何 row selection 都必须要求 press ownership 从同一 row 内开始；没有 matching row press 的 pointer click 必须丢弃。keyboard/accessibility `detail=0` 仍允许。
- 抽屉 remote-only catalog row 的点击不是普通 local row switch：session-open owner 必须返回 materialized local `sessionId`，TerminalPage 只消费这个 id 去更新 focused session-group viewport slot；禁止把 `remote:<owner>::session:<name>` placeholder 当 active truth，也禁止在 drawer/UI 里新增重连或 transport fallback。回归要模拟 first tap -> owner returns id -> parent rerender with active Session -> center `TerminalView` 直接渲染新 session，不需要第二次点击。
- 抽屉预览多选里的 remote-only catalog row 也必须走同一 materialize 主线，但要以 background mode 打开：`handleOpenGroupSession(..., { activate:false, navigate:false })`。预览 selection storage 只存返回的本地 `sessionId` target；打开失败显式报错，不存 `remote:<owner>::session:<name>` placeholder，不切真实 shell。
- `mirror-fixed` 下 renderer 横向裁切平移优先于 shell 抽屉/tab 手势：非左侧热区（包括右侧与中间）的横向拖动都归 `TerminalView` crop pan；外层 drawer swipe 只允许左侧热区 + `previous` 方向。禁止因为 fixed 模式需要抽屉入口而重新启用左右两侧 tab swipe。
- `mirror-fixed` 的手势优先级不能只看起点热区：若当前 horizontal offset 大于 0，右滑仍能真实回移 renderer，`TerminalView` 必须消费并 `stopPropagation()` 整次横滑；只有 offset 在手势开始前已为 0，左缘右滑才允许交给 drawer。反模式是子级只 `preventDefault()` 但让父级 `touchend` 继续解析成 `previous`。
- Android drawer 左侧热区当前固定为 64 CSS px：56px 是允许的边缘样本，88px 必须归 `mirror-fixed` crop pan。96px 在约 347px 宽的手机 viewport 上过宽，会把视觉上已经离开左边缘的右滑误判成抽屉。改热区时必须保留 56px 正向 + 88px 反向成对 gate，并用真机确认非边缘右滑同时满足 `drawer hidden` 与 fixed offset 变化。
- 抽屉打开、catalog refresh、foreground audit 发现 stale persisted tab 时，不得把 stale tab 提升 active 或 materialize transport；只能更新 catalog/audit truth。若看到缺失 session 错误污染当前界面，先查 `open_tab -> active_session` 是否被 UI 合成 click 推进，再查 transport error projection。
- Android WebView 的 `TerminalSessionDrawer` 底部 `New Session` 例外：真机不能依赖 `click` 或 `pointerup`；用按钮自身单一 `touchend` owner，并 `stopPropagation()` 截断父级 drawer 手势。
- Android WebView 的 `TerminalSessionDrawer` row 内关闭 `×` 也必须有自身 `touchend` 激活路径；父 row 有 touch/long-press 手势时，close button 要 `stopPropagation()`、清长按 timer、去重 synthetic click，测试必须覆盖 touch close 不触发 select。
- 若状态浮窗只出现 `drawer:touchstart` 而没有 `add:*`，不要继续猜 `click/pointer/touch`，也不要直接下“遮挡”结论；先加 `cap:start/end:<target>` 确认真实命中节点。`TerminalSessionDrawer` 底部 `New Session` 的语义 owner 应放在整个 footer hit surface，而不是只放在内部可视 button 上。

### 2.12 Android IME 特殊键门禁
- Android 输入法特殊键必须同时覆盖两条路径：`ImeAnchor backspace` 事件路径，以及 `ImeAnchor key` payload 路径。
- native keyCode 必须显式归一：`KEYCODE_DEL -> Backspace`、`KEYCODE_FORWARD_DEL -> Delete`、`KEYCODE_ESCAPE -> Escape`；JS 层再统一映射到终端序列并路由到当前 active session。

### 2.13 Android WeType / OPlus IME ghost shown 排障
- 触发信号：zterm `ImeAnchor` 日志显示 `showSoftInput(...)=true`、`onCreateInputConnection()` 命中，`dumpsys input_method` 显示 `mServedView=ImeAnchorEditText`、`mInputShown=true`、`mIsInputViewShown=true`，但截图无键盘且 `contentTopInsets` 仍接近屏幕底部 / 导航栏（例如 `2505`）。
- 判断动作：立即用同一台设备、同一默认 IME，在系统 Settings 搜索框这类普通 `EditText` 做对照。若普通文本框也显示 `mInputShown=true / mIsInputViewShown=true` 但无键盘，先判定为 IME 进程全局 ghost shown，不再继续改 zterm anchor / renderer / tmux。
- 恢复动作：允许使用明确包级命令 `adb shell am force-stop com.tencent.wetype` 复位 WeType；这是单包复位，不是 broad kill。复位后重新点击 zterm 键盘按钮，必须用截图和 `dumpsys input_method` 验证真实键盘窗口展开，`contentTopInsets` 应变成真实键盘顶部（例如 `1509`）。
- 反模式：不要把 `mInputShown=true` 当成视觉闭环；不要用 `toggleSoftInput()`、重复 guard、renderer reflow、tmux resize、IME 高度猜测或 WebView 清缓存去补偿 WeType ghost 状态。
- 回归测试不能只测中文/文本提交；至少锁 `Escape / Backspace / Delete / Ctrl+C`。

### 2.14 Android IME 显隐与底部对齐
- 不主动拉起 IME：terminal mount、terminal tap、session switch、quick editor blur 都不得调用 native show；只有 QuickBar 键盘按钮是 show/hide intent owner。
- QuickBar 键盘按钮是严格 toggle：按下前先读取 native `ImeAnchor.getState().keyboardVisible`；visible 时 hide，不 visible 时 show。不要用本地 requested flag 或 `keyboardInset` 猜测显隐。
- toggle show 前必须先把 active renderer 从 reading 对齐回 follow/bottom，再延迟调用 `ImeAnchor.show()`；native `keyboardState(visible=true)` 到达后，如果本次是 terminal keyboard request，也要再做一次 follow/bottom realign，覆盖 IME 上台导致的 visual viewport 缩高。否则滚到历史区后键盘上台会裁切到旧 viewport，表现为输入区/底部缺失。
- IME 只允许 UI shell 做裁切/预留：stage reserve = measured QuickBar chrome + IME lift，QuickBar shell 用同一份 IME lift；`TerminalView` 不接收 IME layout token、不触发 upstream resize、不改 daemon/tmux geometry。
- native `ImeAnchorEditText` 必须保持可服务输入法的真实 rect，但 cursor 不可见；若截图出现额外蓝色/灰色 native 光标，先查 anchor `setCursorVisible(false)`。

---

### 2.15 Session Picker 统一入口规则
- `New connection` 入口必须先进入 session picker：先列历史连接，再列当前 tmux sessions，最后才是 clean session / full form
- session picker 顶部必须支持手动输入 Tailscale IP / token，并在输入后立即尝试拉 tmux sessions
- session picker 打开时若已有明确 `bridgeHost + authToken`，必须自动刷新 tmux sessions；不要要求每次人工点击 `Connect`
- tmux session 列表需要支持最小 CRUD（list/create/rename/kill）以及 multi-select 直接开多个 tabs
- terminal 顶部 `+` 的长按必须复用同一个 session picker，用于 quick new tab；普通点击再回 Connections
- quick-tab picker 只允许一份 session row projection：daemon tmux session 顺序为主，open tab 状态贴在同一行；daemon refresh 未返回但仍在 OPEN_TABS 的本地 tab 只能追加为 not-reported row，不得隐藏或自动关闭。
- session picker 的 row projection 现在对所有模式都必须合并 open tab，不只 quick-tab；daemon 成功枚举后目标 owner 下未被报告的本地 open tab 应显式关闭，避免双列表和 stale tab。
- OPEN_TABS 已打开 tab 不得按 semantic reuse key 自动合并/替换/删除；同名 tmux session 的 runtime duplicate 只能作为 transport fact，不能顶替 persisted open tab 的 `sessionId`。saved tab list 导入可做 import-only semantic 去重。
- Terminal drawer 不能维护第二份远端 session 列表；打开抽屉时按稳定 hostKey 触发 `fetchTmuxSessions()`，结果必须回写同一个 `sessionGroups` catalog，再由 drawer 投影 remote-only rows。禁止让 drawer effect 依赖整个投影列表，否则 catalog 更新会反复触发枚举。
- 抽屉 / session picker 的远端刷新只允许更新 session catalog / audit fact，不得把 stale persisted open tab 自动推进 transport reconnect，也不得把非 active、非 live 的 `tmux_session_unavailable` 投影成全局错误 banner。`routecodex` 这类本地 OPEN_TABS 中的过期 session，若 tmux truth 已不存在，只能表现为缺失事实或 idle closed shell，不能影响当前 session。

### 2.14 Bridge Auth 规则
- daemon / websocket bridge 必须支持共享 token 鉴权；server 真源优先为 `~/.wterm/config.json -> mobile.daemon.authToken`，`WTERM_MOBILE_AUTH_TOKEN` 只作为显式 override
- client 的 remembered server / host / picker target 都要携带 `authToken`，并在 websocket 连接阶段透传
- 验证时必须补一条“无 token 失败 / 正确 token 成功”的证据

### 2.15 跨尺寸布局统一规则
- phone / tablet / foldable / split-screen / future Mac 只允许共享**一套** layout profile 真源；禁止在 `ConnectionsPage` / `ConnectionPropertiesPage` / `TerminalPage` 各自散落 breakpoint
- 大屏效果优先通过 **单行多列 + 垂直分屏** 的 phone-sized pane 编排获得统一体验；不要先做 desktop-only 页面再回头兼容 mobile
- future Mac 复用 shared app-layer 的页面、会话、存储和 layout primitives；平台壳只补窗口 / 菜单 / 快捷键 / 原生输入差异
- 触发信号：一旦需求里出现 pad / foldable / split-screen / Mac / 多 pane / 多 active tab，就先回到 `0001-cross-platform-layout-profile.md` 冻结设计，再进入实现
- Jason 当前新增冻结：统一布局默认是一行多列，不以上下堆叠多 pane 作为主方案
- 桌面 packaged/dev 验证若需要重开 `ZTerm.app`，必须先退出旧实例，再打开新实例；不要直接 `open -n` 叠多个 app 进程污染证据
- 若参考 Tabby 一类桌面终端，借用的是紧凑 chrome / 顶部状态 tab strip / 左侧 profile rail / 右侧 inspector 的壳层组织；tab strip 至少要承载真实 target / inspector 状态，不能只是静态装饰
- 若桌面端继续推进多 tab，当前最小真边界应优先写成 `single runtime · multi tabs`：可以维护多个 open target tab，但同一时刻只允许一个 live websocket/runtime；不要把“可切换 tabs”误报成“并发多 live sessions”
- Jason 新冻结：桌面右侧不要先做抽屉；应收成“固定左 rail + 右侧按比例切 multiple vertical panes”的 split workspace，优先给 `1 / 2 / 3` preset，风格靠近 iTerm2/Tabby，但不要上来做自由拖拽
- 新冻结：mobile session group 必须拆成两份真相：抽屉显示的 `top / center / bottom` 是用户显式分配的固定槽位，点击 peek 不得改写；stage 只基于当前 focus slot 计算 viewport projection。focus=top 时 viewport 为 `empty / top / center`，focus=bottom 时 viewport 为 `center / bottom / empty`，focus=center 时 viewport 等于固定槽位。focus 必须存 slot name，不能存 session id。抽屉点击 session 只替换当前 focus 槽位：focus=bottom 替换 bottom，focus=top 替换 top，focus=center 替换 center。禁止自动从 session 列表补邻居成 wheel，也禁止点击后循环轮转三槽位。抽屉长按/右键是唯一的槽位分配入口，打开 slot menu 后必须 suppress 下一次 click，避免菜单和 session 激活同时发生。
- mobile session group 的边界可见性必须走共享 projection helper：竖向 top/center/bottom 与未来横向 left/center/right 都先映射到 `before/center/after` 边界模型。focus 在 before/top 边界时隐藏 before/top peek；focus 在 after/bottom 边界时隐藏 after/bottom peek；center 才显示两侧。UI shell 只消费 projection，不得自己补 top/bottom 或 left/right 局部判断。
- 1946 现场证伪：不要在未完成完整状态机审计前改 `TerminalPageStageShell` 的 sessionGroupVisible 条件、不要加 “center-only 不进 group”、不要让横屏强行进入 horizontal group、不要调整抽屉选择 session 的切换顺序；这些会破坏竖屏上中下显示和上下滚动。竖屏恢复包必须回到 1945 行为：`!splitVisible && !landscape && center` 才走当前 mobile group stage。
- session group layout axis 默认按 aspect ratio：窄竖屏（当前阈值 `width / height <= 0.4`）强制 vertical，上下滚；宽竖屏默认 horizontal，但 Settings 可切 vertical；landscape 永远 horizontal。这个设置只影响 layout projection，禁止改写 drawer 固定槽位、session/tab/pane 真相。
- 看到“切换 session 后状态已 connected，但真实 shell 画面不刷新/仍是旧内容”时，先跑 `TerminalPage.session-content-identity.test.tsx` 的 session/body marker 门禁，确认 `activeSession -> session-group slot -> TerminalPageStageShell -> TerminalView` 同源；不要先改 WebSocket。外部 active session 改变时，如果 active 已在 top/center/bottom slot，就 focus 该 slot；如果不在任何 slot，就替换 center。禁止让 `resolveTerminalSessionGroupSlotIds()` 只在旧 center 缺失时才 fallback 到新 active。
- 横向 session group side peek 的身份显示必须避开 status bar / 返回按钮：不要把 session 名贴顶部；应放在中部安全区，session 名和 host 至少允许两行，以保证窄侧边仍能识别目标。
- 多 daemon / 多服务器 UI 身份必须走 `src/lib/server-identity.ts`：用户可见 label 优先是 connection/daemon 名，颜色也按同一 server key；禁止在 drawer、side peek、tab 文案里把 `bridgeHost:bridgePort` 或 telnet/bridge 端口当服务器名。
- 如果 Relay directory 和 direct/Tailscale 历史同时存在，`server-identity` alias 输入必须同时来自 live sessions、session groups、Relay daemon endpoints；只从 live sessions 建 alias 会漏掉“目录里有 daemon，历史 group 用 IP”的常见路径。
- 多服务器身份色必须走 `src/lib/server-color.ts` 的固定红/黄/蓝/绿/青/橙 palette；禁止连续 hue hash 漂到紫/粉区，常见服务器 key 需要测试锁住不同色。
- traversal route health cache 是进程级全局状态；会创建 `TraversalSocket` 或断言 WebSocket 实例/线路选择的测试必须在 `beforeEach` 清 `defaultTraversalRouteHealthCache`，否则前一用例记录的坏线路会让后续用例不创建 socket，表现为 `MockWebSocket.instances` 为 0。

### 2.16 File Sync 枚举与排序边界
- Android 11+ 本地文件同步必须走 native storage owner；`FileTransferSheet` 只消费 `StoragePermissionPlugin` 返回的目录事实，不得在 UI 或 native 枚举层按扩展名、图片类型、隐藏文件名做过滤。
- 文件排序只属于 UI projection：按名称/修改时间、正序/倒序可以在列表投影层切换；不得把排序/过滤状态写回本地 storage owner 或 daemon 文件真源。
- 远端文件列表若协议仍带 `showHidden`，客户端必须请求完整列表；禁止用默认隐藏文件过滤制造“目录成功但文件消失”的假状态。
- File Sync 的上传语义只负责把本地文件写入远端目标目录并回报 `file-upload-complete`；禁止把上传后的远端路径写入 tmux、quick input、composer 或任何对话输入框。
- File Sync 下载保存不得把整文件 base64 合并后一次性跨 JS/native bridge 写盘；必须按 `file-download-chunk` 分块写入 native storage，并在完成后用 `stat` 校验本地字节数等于远端 `totalBytes`，失败必须显式进入 transfer error。
- Session resume/switch 入口必须先提交 open-tab active truth，再由同一 `switchRuntime: 'explicit-resume'` 推进 transport；禁止 `resumeActiveSessionTransport()` 成功后提前 return，否则首次点击只开连接不切 UI，必须二次点击才可见。

### 2.17 Loop Governance 初始化规则
- 项目 recurring loop 的唯一入口是 `android/docs/loops/LOOP.md`，机器真源是 `android/docs/loops/loop-manifest.json`。
- 当前只允许 `zterm.daily-triage` 以 `L1 report-only` 运行：只读项目真源、报告、追加 run log；禁止 product code edits、daemon start/stop、stage/commit、push/merge。
- loop 发现项必须绑定 `feature_id`、owner、required gate 和 `mainline_call_id`；`mainline_call_id` 必须反查到 `docs/wiki/mainline-call-map.json` 的真实 `edge_id`。
- 升级到 L2 前必须先有多次 L1 低误报 run history、唯一 owner、required gates、maker/checker 分离和 Jason 明确批准；L3 unattended 默认关闭。
- 任何 loop governance 变更必须跑 `pnpm --dir android run test:feature-registry -- --reporter dot`，其中 `src/lib/loop-governance-truth.test.ts` 会锁住 L1 禁动作、kill switch、manifest 和 mainline call ID。

## 三、开发闭环流程

### 3.0 测试闭环分层规则

Android / daemon / shared / Mac 任一 terminal 主链改动，都必须按影响面选择验证层级，不能用低层 gate 冒充高层完成。

#### L0 架构与静态 gate
- 证明：feature owner、function map、类型、禁止路径扫描没有明显破坏。
- 不证明：真实 daemon/tmux/client/UI 可用。
- 常用命令：`pnpm --dir android run test:feature-registry -- --reporter dot`、`pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`。

#### L1 Android client 单元/集成 gate
- 证明：open-tab restore/resume、SessionContext transport、buffer worker、TerminalPage/TerminalView 局部语义正确。
- 不证明：真实 daemon/tmux 或真机 WebView 已闭环。
- 要求：涉及状态机、retry、timeout、错误投影、IME、renderer 可见窗口时，必须有正向和反向测试。

#### L2 daemon/tmux 真回环
- 证明：当前 daemon 能真实启动，tmux oracle 与 daemon mirror/client replay 一致。
- 默认命令：`pnpm --dir android run daemon:mirror:close-loop`。
- 不证明：本地客户端入口一定连得上。

#### L3 本地客户端核心连接 gate
- 证明：仓库内本地 client transport/runtime 能连。若 Mac client 可用，必须跑 Mac gate，不能只用 daemon probe。
- 默认命令：`pnpm --dir mac test -- --reporter dot` 与 `pnpm --dir mac run type-check`。
- 覆盖面：remote daemon `bridge-transport`、local tmux `local-tmux-transport`、`terminal-runtime`、workbench active target。
- 不证明：Android 真机或 Mac packaged app 运行态已经正常。

#### L4 Android UI / WebView gate
- 证明：TerminalPage、IME、drawer、pane、renderer shell 在 Android/WebView 语义下成立。
- 若问题是键盘、容器上抬、输入法特殊键、touch、drawer、可视窗口，不能只跑 L2/L3。

#### L5 APK / 真机 / 发布态 gate
- 证明：真实安装态和用户路径可用。
- 需要 APK smoke、真实设备、daemon debug、截图/logcat/evidence 中至少与本轮问题相关的证据。

汇报要求：
- 必须列出已跑到哪一层，以及没跑到的层级为什么不在本轮范围。
- 不能把“daemon/tmux 真回环通过”写成本地客户端正常。
- 不能把“Mac client 核心测试通过”写成 Android 真机正常。

### 3.1 流程图

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│ 1.规划  │───▶│ 2.开发  │───▶│ 3.测试  │───▶│ 4.提交  │───▶│ 5.沉淀  │
└─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘
     │              │              │              │              │
     ▼              ▼              ▼              ▼              ▼
 更新task/CACHE 读skill        运行验证       Git commit    更新skill
 定义成功       最小切片       证据记录       检查清单      经验沉淀
```

### 3.2 Phase 1: 规划阶段

**目标**: 明确任务范围、定义成功标准、冻结边界

#### 规划输出模板

每次任务开始前，必须先更新 `android/task.md` 和 `android/CACHE.md`：

```markdown
## Task-XXX
- 目标：
- 成功标准：
- 验证入口：
- 范围：
- 不在范围：
- 风险：
- 证据输出位置：
```

#### 进入开发前的冻结检查

| 检查项 | 必须确认 |
|--------|---------|
| 成功标准是否可验证？ | ✅ |
| 验证入口是否明确？ | ✅ |
| 是否有唯一真源？ | ✅ |
| 是否只改本轮切片？ | ✅ |

### 3.3 Phase 2: 开发阶段

**目标**: 最小切片实现，每步可验证

#### 开发顺序（Foundation Modules）

```
1. Config Module        → Host/Session 类型定义、存储方式
2. Provider/Adapter     → WebSocket 消息协议
3. Minimal Debug Entry  → 最小 UI 可见
4. Observability        → 状态变更 event
5. Testing/Harness      → 验证入口
6. Build/Install        → Capacitor 配置
```

#### 最小切片规则

```
最小切片 = 1个文件 + 1个功能 + 1次验证

示例：
- 切片1: 创建 src/lib/types.ts → 定义 Host 类型 → tsc 编译通过
- 切片2: 创建 src/hooks/useHostStorage.ts → localStorage 存取 → 浏览器验证
- 切片3: 创建 src/components/HostList.tsx → 显示主机列表 → 浏览器查看
```

#### 禁止事项

| 禁止 | 原因 |
|------|------|
| 一次改多个文件 | 违反最小切片原则 |
| 添加未请求的功能 | 违反 Simplicity First |
| 重构未要求的代码 | 违反 Surgical Changes |
| 修改 @wterm 核心包 | 项目约束 |

### 3.4 Phase 3: 测试阶段

**目标**: 四层验证，证据记录

#### 四层验证框架

| 层级 | 验证内容 | 验证方式 |
|------|---------|---------|
| **L1: Unit** | 纯函数、类型、状态机 | `tsc --noEmit` + vitest |
| **L2: Function** | 模块主路径功能 | 浏览器手动验证 |
| **L3: Orchestration** | 跨模块推进、多 Tab | 多场景手动验证 |
| **L4: Runtime** | Android 运行态 | 模拟器/真机验证 |

#### 远程 runtime 调试闭环（必须记住）

当出现下面这类问题时，优先走 daemon 远程调试接口，而不是只靠猜：

- active tab 假活 / 不主动刷新 / 只有输入后才刷新
- 底部缺行 / prompt 漂移 / 键盘弹出后才正常
- reconnect 看起来 connected，但 buffer 不推进
- 想确认当前 client session / mirror / lastBufferSyncRequest 到底是什么

**唯一真源入口：**

- `GET /debug/runtime`
  - 返回 daemon health + clientSessions + mirrors + clientDebug summary
- `GET /debug/runtime/logs`
  - 返回最近 client runtime debug entries，可按 `sessionId / tmuxSessionName / scope` 过滤
- `GET /debug/runtime/control?enabled=1`
  - 远程打开 client runtime debug

**鉴权规则：**

- 统一复用 daemon auth token
- query 参数：`?token=<auth>`
- 或 HTTP header：`Authorization: Bearer <auth>`

**优先用脚本，不手搓 curl：**

```bash
cd android
pnpm daemon:runtime:remote snapshot --host 100.x.x.x --port 3333 --token <auth>
pnpm daemon:runtime:remote logs --host 100.x.x.x --port 3333 --token <auth> --limit 200
pnpm daemon:runtime:remote enable --host 100.x.x.x --port 3333 --token <auth> --reason ime-refresh-debug
pnpm daemon:runtime:remote logs --host 100.x.x.x --port 3333 --token <auth> --sessionId <session-id> --scope follow
```

**现场排障最小顺序：**

1. 先拉 runtime state（命令子名仍是 `snapshot`，语义是 runtime 状态快照，不是 terminal buffer 快照链路）
   - 看 `clientSessions[].state/lastBufferSyncRequest/lastHeadRequestAt`
   - 看 `mirrors[].revision/bufferStartIndex/bufferEndIndex/lastFlushCompletedAt`
2. 若日志不够，再 `enable`
3. 在手机上复现一次
4. 立刻 `logs`
5. 只根据 runtime state + logs 下结论，不靠主观猜

**针对当前两类高频问题的看法：**

- “输入一下就恢复”  
  先看：
  - active session 是否真的在跑 head-first 主循环（`lastHeadRequestAt` 是否持续推进）
  - `lastBufferSyncRequest.mode` 是否仍在 `follow`
  - mirror revision 是否在涨、但 client logs 没 follow sync

- “键盘弹出就正常，不弹就不正常”  
  先看：
  - layout/viewport 相关日志是否只在 keyboard change 后出现
  - follow viewport sync 是否漏了无键盘场景
  - runtime state 里的 last request rows / viewportEndIndex 是否与当前真实底部一致

#### 验证入口定义

```bash
# L1: Unit 验证
pnpm --filter @wterm/mobile type-check
pnpm --filter @wterm/mobile test  # vitest 单元测试（如脚本存在）

# L2: Function 验证（本地开发）
pnpm --filter @wterm/mobile dev
# 结构验证：浏览器访问 portless 输出的 *.localhost 地址
# 真连通验证：pnpm --filter @wterm/mobile preview -- --host 127.0.0.1 --port 4173
# 手动操作：添加主机 → 连接 bridge → 验证终端显示

# L3: Orchestration 验证
# 多 Tab 操作：新建 Tab1 → 新建 Tab2 → 切换 → 关闭

# L4: Runtime Smoke（Android）
pnpm --filter @wterm/mobile build
npx cap sync android     # 同步到 Android
npx cap run android      # 启动模拟器/真机
```

#### 标准 APK 构建与发布流程（zterm Android，必须遵循）

> 适用场景：需要给 Jason 交付可安装升级包、必须进入 update/release 渠道。

```bash
cd android
./scripts/build-android-debug.sh
```

该命令是唯一标准入口，内部顺序固定：

1. `pnpm build`
   - 包含 prebuild 门禁：`test:terminal:regression`
2. `npx cap sync android`
3. `native/android/gradlew assembleDebug`
4. `node ./scripts/prepare-update-bundle.mjs <app-debug.apk>`

**发布目标目录（必须检查）：**

- `android/update-dist/`
- `android/release-dist/`
- `~/.wterm/updates`

**构建完成后最低验收（缺一不可）：**

1. `update-dist/latest.json` 存在且字段完整：
   - `versionName`
   - `versionCode`
   - `apkUrl`
   - `sha256`
   - `size`
2. `release-dist/latest.json` 与 `update-dist/latest.json` 的 `versionCode/sha256/size` 一致。
3. `update-dist/<apkUrl>` 文件存在，且 `sha256` 与 manifest 一致。
4. 报告中必须给出：
   - APK 绝对路径
   - versionName/versionCode
   - sha256
   - 是否通过标准门禁（regression + type-check + gradle）

**禁止事项：**

- 禁止跳过 `build-android-debug.sh` 直接手工拷贝 APK 冒充发布。
- 禁止只说“构建成功”但不核对 `latest.json` 与实际 APK hash。
- 禁止使用旧版本 APK 复用旧 manifest。

#### 证据记录模板

每次验证后在 `android/evidence/<date-task>/` 保存：

- 截图
- 命令输出
- APK 路径
- 必要时 logcat / console

#### 完成证据最低标准

- 截图
- 命令输出
- APK 路径
- 必要时 logcat

### 3.5 Phase 4: 提交阶段

**目标**: 清晰的 commit，检查清单

#### Git Commit 规范

```bash
# Commit message 格式
<type>: <subject>

<body>

# type 范围
feat:     新功能
fix:      修复
refactor: 重构（仅限请求的重构）
docs:     文档更新
test:     测试添加/修改
chore:    配置/构建变更

# 示例
feat: 添加 HostList 组件和 useHostStorage hook

- 创建 src/lib/types.ts 定义 Host 类型
- 创建 src/hooks/useHostStorage.ts 实现本地存储
- 创建 src/components/HostList.tsx 显示主机列表

验证: pnpm --filter @wterm/mobile dev → 浏览器访问 → 添加主机成功
```

#### 提交前检查清单

| 检查项 | 命令 |
|--------|------|
| 类型检查通过 | `pnpm --filter @wterm/mobile type-check` |
| 无未使用代码 | 手动检查 |
| task.md 已更新 | `git diff android/task.md` |
| CACHE/MEMORY 是否需要更新 | 检查是否有新约束 |
| SKILL.md 是否需要更新 | 检查是否有新门禁 |

### 3.6 Phase 5: 经验沉淀

**目标**: 新约束/经验写入 Skill

#### Skill 更新时机

| 触发条件 | 更新内容 |
|---------|---------|
| 发现新的项目约束 | 写入 "禁止事项" |
| 发现新的验证入口 | 写入 "验证入口" |
| 发现反模式/坑 | 写入 "常见问题" |
| 发现可复用模式 | 写入 "最佳实践" |

### 3.7 回归验证（下次启动）

每次开发前执行：

```bash
# 1. 检查上次提交状态
git log --oneline -5

# 2. 运行基础验证
pnpm --filter @wterm/mobile type-check

# 3. 本地启动验证
pnpm --filter @wterm/mobile dev

# 4. 如有 Android 项目
cd examples/mobile && npx cap run android --livereload
```

---

## 四、完整功能规格

### 4.1 主机管理

| 字段 | 说明 |
|------|------|
| id | UUID |
| name | 显示名称 |
| bridgeHost | IP 或 Tailscale 域名 |
| bridgePort | bridge 端口（默认由统一配置决定，当前 3333） |
| sessionName | tmux session 名 |
| authType | password / key |
| password/privateKey | 凭据（暂不加密） |
| tags | 分组标签（数组） |
| pinned | 是否置顶首页 |
| lastConnected | 最后连接时间戳 |
| autoCommand | 连接后自动执行的命令 |

- **分组/标签**: 支持（如"工作服务器"、"个人服务器"）
- **搜索/过滤**: 不需要
- **备注/描述**: 不需要

### 4.2 虚拟键盘工具栏

| 功能 | 说明 |
|------|------|
| 位置 | 底部，手机键盘上方 |
| 基础按键 | Ctrl, Alt, Tab, ESC, 方向键 |
| 扩展按键 | F1-F12（电脑键盘模式全显示） |
| 自定义组合键 | 支持（如 Ctrl+C, Ctrl+D），可增删 |
| 预设模板 | 默认提供 Ctrl+C/D/Z |
| 拖拽排序 | 支持 |
| 存储 | 用户配置文件 + WebDAV 导入导出 |

### 4.3 应用启动行为

| 功能 | 说明 |
|------|------|
| 自动连接 | 启动时自动连接上次活跃 Session |
| Tab 状态恢复 | 保存上次关闭时的 Tab 状态 |
| 快速重连 | 一键连接最近 3 个主机 |
| 自动命令 | 主机级别默认 + 连接时可临时覆盖 |
| 命令历史 | 每个 Tab 保存 host+autoCommand，WebDAV 同步 |

### 4.4 Tab 栏设计

| 功能 | 说明 |
|------|------|
| 位置 | 顶部 |
| 显示内容 | 动态标题（来自 tmux / shell 标题），可手动重命名 |
| 重命名持久化 | 支持 |
| 最大 Tab 数 | 10 |

### 4.5 后台保活

| 功能 | 说明 |
|------|------|
| 通知栏 | 显示每个 Tab 连接状态 |
| 自动重连 | 网络恢复后自动重连 |
| 重连次数 | 可配置，默认 3 次 |
| 心跳间隔 | 30 秒 |

### 4.6 Session 历史

| 功能 | 说明 |
|------|------|
| Tab 状态保存 | 上次关闭时的 Tab 配置 |
| Session 快照 | 保存完整终端输出历史 |

### 4.7 网络状态提示

| 功能 | 说明 |
|------|------|
| 断开提示 | Toast 提示网络断开 |
| 错误详情 | 显示具体错误（认证失败、超时、网络不可达） |

### 4.8 Android 特有功能

| 功能 | 说明 |
|------|------|
| 横屏模式 | 支持，终端尺寸自动调整 |
| 外接键盘 | 支持 USB/蓝牙键盘 |
| 分享功能 | 分享终端输出/命令 |

### 4.9 数据同步

| 功能 | 说明 |
|------|------|
| 配置导入导出 | WebDAV 支持 |
| 快捷键配置 | WebDAV 同步 |
| 命令历史 | WebDAV 同步 |

---

## 五、WebSocket 消息协议

### 客户端 → 服务端

```typescript
type ClientMessage =
  | { type: 'connect', payload: HostConfig }
  | { type: 'input', payload: string }
  | { type: 'resize', payload: { cols: number, rows: number } }
  | { type: 'ping' }
  | { type: 'close' }
```

### 服务端 → 客户端

```typescript
type ServerMessage =
  | { type: 'connected', payload: { sessionId: string } }
  | { type: 'data', payload: string }
  | { type: 'error', payload: { message: string } }
  | { type: 'title', payload: string }
  | { type: 'closed', payload: { reason: string } }
  | { type: 'pong' }
```

---

## 六、状态机定义

```
idle → connecting → connected → closed
            ↓           ↓
          error      reconnecting → connected
```

```typescript
interface Host {
  id: string;
  name: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  authType: 'password' | 'key';
  password?: string;
  privateKey?: string;
  tags: string[];
  pinned: boolean;
  lastConnected?: number;
  autoCommand?: string;
}

interface Session {
  id: string;
  hostId: string;
  connectionName: string;
  bridgeHost: string;
  bridgePort: number;
  sessionName: string;
  title: string;
  ws: WebSocket | null;
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'closed';
  hasUnread: boolean;
  customName?: string;  // 用户重命名的名称
}
```

---

## 七、文件夹结构

```
android/
├── docs/                       # spec / architecture / workflow
├── evidence/                   # 截图 / 日志 / APK / 真机证据
├── task.md                     # 当前任务板
├── CACHE.md                    # 短期上下文
├── MEMORY.md                   # 长期经验
├── android/                    # npx cap add android 生成
├── src/
│   ├── components/
│   │   ├── TerminalTabs.tsx    # 顶部 Tab 栏
│   │   ├── TerminalView.tsx    # 单个终端视图
│   │   ├── HostList.tsx        # 主机列表页
│   │   ├── HostForm.tsx        # 添加/编辑主机表单
│   │   ├── QuickActions.tsx    # 快捷键工具栏
│   │   └── ConnectionBar.tsx   # 连接状态栏
│   ├── hooks/
│   │   ├── useSession...       # session / bridge 状态管理
│   │   ├── useHostStorage.ts   # 主机配置存储
│   │   ├── useKeepAlive.ts     # 后台保活
│   │   └── useQuickActions.ts  # 快捷键管理
│   ├── contexts/
│   │   └── SessionContext.tsx  # 多会话状态管理
│   ├── lib/
│   │   ├── types.ts            # Host, Session 类型
│   │   ├── websocket.ts        # WebSocket 协议
│   │   ├── storage.ts          # localStorage 封装
│   │   └── webdav.ts           # WebDAV 同步
│   ├── server/
│   │   └── server.ts           # WebSocket → tmux 桥接
│   ├── App.tsx
│   └── main.tsx
├── capacitor.config.ts
├── package.json
└── note.md                      # 历史记录（非主真源）
```

---

## 八、复用代码来源

| 需求 | 来源 | 复用方式 |
|------|------|---------|
| WebSocket tmux 桥接 | `android/src/server/server.ts` | 当前真源 |
| PTY 本地连接 | `examples/local/server.ts` | 参考 resize 协议 |
| 终端渲染 | `@jsonstudio/wtermmod-react` | npm install |
| WebSocket Transport | `@jsonstudio/wtermmod-core` | npm install |

---

## 九、常见问题（按需更新）

### 问题: WebSocket 连接超时
- **触发信号**: 网络不稳定或 Tailscale 未连接
- **解决方案**: 检查 Tailscale 状态，重连逻辑自动触发
- **边界条件**: 最多重试 3 次（可配置）

### 模式: transport 自动连接顺序必须固定
- **真源**: 自动模式只允许 `Tailscale -> IPv6 -> IPv4 -> Relay`
- **动作**: 先试 Tailscale，再试 IPv6，再试 IPv4，最后才进 Relay；不要再额外发明 “fallback/补偿/第二套 transport 顺序”
- **边界**: Relay 是最后一段显式路径，不是伪 direct，不允许再把 relay 阶段标回别的 resolvedPath

### 问题: Android APK 能打开但连不上本地 tmux bridge
- **触发信号**: terminal 一直停在 idle / connecting，bridge 是 `ws://`，Capacitor WebView 运行在 `https`
- **真源**: `androidScheme=https` 会把移动端带到 secure context，`ws://` bridge 会被 mixed-content / cleartext 规则卡住
- **解决方案**: `capacitor.config.ts` 使用 `androidScheme=http`，AndroidManifest 打开 `usesCleartextTraffic=true`
- **验证**: HTTP 入口或 APK 中连接成功后，header 进入 `Connected`，bridge 日志出现 session create/close

### 问题: Android 输入法弹出后又消失 / 键盘按钮无效
- **触发信号**: 点快捷栏键盘按钮无反应，或 logcat 出现 `ImeTracker ... onCancelled`
- **真源**: WebView 内 DOM textarea 与原生 `EditText` anchor 在抢 input focus；只调用 `showSoftInput()` 不够
- **解决方案**: Android 上 terminal 不再主动 focus DOM textarea；键盘按钮只走原生 `ImeAnchor`；必要时先 clear WebView focus，再由原生 `EditText` 请求焦点并 `showSoftInput`
- **验证**: logcat 中 `ImeAnchor show()/showSoftInput()` 命中，点击键盘按钮后系统 IME 实际弹出且中文输入可提交到 tmux

### 问题: Android 悬浮快捷输入里语音转文字失效 / ImeAnchor 抢走输入
- **触发信号**: terminal 中文输入恢复了，但打开悬浮 quick input / editor 后，语音转文字不再落到 textarea，反而把 terminal 或 header 焦点搞乱
- **真源**: 把 Android 全部输入都切到 `ImeAnchor` 以后，没有给 quick input/editor 这类 DOM textarea 留独立输入通道；terminal IME 与 quick input DOM focus 没有分层
- **解决方案**: terminal live input 继续走 `ImeAnchor`；quick input / editor / 浮层 textarea 获得 DOM focus 时，立即 suspend terminal IME、停止把 anchor 输入路由回 session；浮层展开时同时隐藏底部 shell quick rows，避免双入口叠加
- **验证**: quick input textarea 可正常语音转文字；此时 terminal 不再收到 anchor 输入；关闭/失焦后 terminal 再恢复自己的输入链

### 问题: Android terminal 语音输入按钮弹得出但不上 shell
- **触发信号**: 键盘已弹出、麦克风能开始录，但结果不提交到 shell，尤其是拼音/语音这种 composition 完成链
- **真源**: `ImeAnchor` 不能把输入字段伪装成 password/no-suggestions 真空场；否则语音/组合输入完成链可能只走 composing/finish，不走普通 `commitText`
- **解决方案**: `ImeAnchor` 输入类型保持普通 text multiline，不再用 password/no-suggestions 组合硬压；同时在 `InputConnection` 补 `finishComposingText` 收口，确保最终文本会 emit 到 terminal
- **验证**: 中文拼音提交、语音转文字提交都能直接落到 shell，不依赖 DOM terminal textarea

### 模式: Android 前后台恢复不要只信 WebView lifecycle
- **适用场景**: 回到前台后 UI 还显示 connected，但实际上 websocket 已假活、不再刷新
- **动作**: 前端同时监听 `visibilitychange/resume/focus` 与 Capacitor `App.appStateChange`；进入前台时强制 sweep `reconnectAllSessions()`，不要只等 heartbeat 自己超时

### 问题: 手机上下滑导致整页 reload / 回弹
- **触发信号**: 竖向滑动 shell 时，整个页面像被重新加载或出现 WebView 级下拉回弹
- **真源**: body/root 仍可滚动，或 Capacitor WebView 自身 overscroll 未关
- **解决方案**: `html/body/#root` 固定为 `overflow:hidden + overscroll-behavior:none`，只让 terminal buffer 容器滚动；`MainActivity` 再把 WebView 设为 `OVER_SCROLL_NEVER`
- **验证**: 竖向滑动只滚 terminal buffer，不触发整页回弹/重载

### 问题: 快捷输入面板点外面关不掉 / 键盘弹出后面板被抬太高
- **触发信号**: 悬浮球打开的 quick input 面板无法靠点击空白区关闭，或输入法弹出后面板主体被抬到屏幕外
- **真源**: quick bar 根节点会拦 pointer；同时 quick overlay 若挂在已 `transform` 抬起的 quick bar 容器下，再按 `keyboardInset` 计算 `bottom/padding` 会发生双重位移
- **解决方案**: outside-close 走 document capture 级监听；quick input / editor / floating panel 这类 fixed overlay 不再二次叠加 `keyboardInset`
- **验证**: 点击面板外空白区应立即关闭；弹出输入法后面板主输入区和按钮区仍保持可见

### 问题: Android bottom sheet 在输入法弹出后“看起来滑了但完全滚不动”
- **触发信号**: 快捷输入设置 / 快捷键设置页触摸事件能收到，但 `scrollTop` 始终不变，尤其是真机 WebView + DOM input 聚焦后
- **真源**: sheet 还在按 `100dvh` 定高，键盘把 `visualViewport` 压小后容器仍认为自己没有 overflow，最终出现 `scrollHeight == clientHeight`
- **解决方案**: 先用 WebView devtools probe 证明不是 `preventDefault`；随后用 `visualViewport.height + offsetTop` 计算可见底，用 `layoutHeight - visibleBottom` 作为 bottom inset 抬升 sheet，不能只改 scroll 容器
- **验证**: 键盘弹出后 editor sheet 高度应小于 layout viewport，且 `scrollHeight > clientHeight`，真机 swipe 后 `scrollTop` 能增长

### 问题: 快捷键列表切到“添加快捷键”后内容从中段开始 / 看起来越界
- **触发信号**: 列表页先滚过，再点 `+ 添加组合键` 或编辑项进入 form，首屏不是从顶部开始，顶部内容像被吞掉；同时悬浮球可能压在表单右侧
- **真源**: list / form 复用同一个 `shortcut-editor-scroll`，mode 切换时继承了旧 `scrollTop`；此外 full-screen editor 打开时 floating bubble 没隐藏
- **解决方案**: `shortcutEditorMode / shortcutEditorOpen / editingShortcutId` 变化时，通过 ref + rAF 把滚动容器重置到 `scrollTop=0`；editor 打开期间隐藏 floating bubble
- **验证**: 人工先把列表滚出非零位置，再进 form；form 首屏应从顶部字段开始，`scrollTop=0`，且不再看到悬浮球覆盖

---

## 十、最佳实践（按需更新）

### 模式: 最小切片开发
- **适用场景**: 所有功能开发
- **示例**: 先 types.ts → 再 useHostStorage.ts → 再 HostList.tsx

### 模式: cat -v 输入真相验证
- **适用场景**: 终端快捷键、特殊字符、自定义组合键验证
- **动作**: autoCommand 进入 `cat -v`，然后点击方向键 / Esc / 自定义快捷键
- **验收**: 终端必须直接显示 `^[[A`、`^[`、`^A` 或自定义文本，证明字节序列真实进入 tmux

### 模式: Tab 跟手切换分层
- **适用场景**: 多 tab 终端左右滑动切换
- **动作**: `TerminalView` 只做 axis lock 与横向手势 delta 上报；`TerminalCanvas` 统一负责相邻 tab 预览、跟手位移、半屏阈值、回弹/完成动画与最终切 tab
- **反模式**: 在单个 terminal view 内直接切 tab，会把手势判定、scroll 锚点和切换时序耦死，容易回归“瞬切/错位/滚动锚点跳变”

### 模式: viewport refresh 调度只依赖动作，不依赖 followMode
- **适用场景**: 收敛 `TerminalView` 的 layout refresh / session refresh / follow audit
- **动作**: 先把 `syncViewport + 可选 follow 对齐` 收成单一 `runViewportRefresh()` 动作；scheduler/effect 只调这个动作，是否 follow 在执行时通过当前 latch/ref 判断
- **反模式**: 让 `scheduleViewportRefresh()` 直接依赖 `followMode`，会导致 reading/follow 切换时把无关 refresh effect 全部重新建一遍

### 模式: ResizeObserver 不走第二套 refresh 口径
- **适用场景**: terminal 容器真实尺寸变化、横竖屏/分屏/键盘相关布局变化
- **动作**: `ResizeObserver` 回调直接复用统一的 `runViewportRefresh()`，不要单独调用 `syncViewport()`
- **反模式**: layout/session/audit 走统一 refresh 动作，但真实 resize 另走 `syncViewport()`；这样 follow 对齐逻辑会再次分叉

### 模式: refresh effect 能并时并成 trigger effect
- **适用场景**: `TerminalView` 里多个 effect 最终都只是在“判定某个 trigger 是否值得 schedule refresh”
- **动作**: 保留显式 trigger 判定（如 `becameActive / sessionChanged / layoutChanged`），把 refresh 调度并到单一 effect；timeout 差异继续按 trigger 决定
- **反模式**: 为了少一个 effect 直接抹平触发来源，或把 layout/session 时序差异删掉

### 模式: 状态 effect 先动作名字化，不硬并
- **适用场景**: `TerminalView` 剩下的 effect 已经承载 reading 锚定、viewport signal 这类真实状态语义
- **动作**: 先把 effect 内动作抽成具名 helper（如 `reconcileViewportAfterBufferShift()`、`emitViewportSignalsForCurrentFrame()`），再让 effect 只做 trigger/state bridge
- **反模式**: 只为了压 effect 数量，把 prepend 锚定、viewport signal 这种状态语义强行并进别的 refresh effect

### 模式: renderer/page/context 共享接口类型下沉到 lib/types
- **适用场景**: `TerminalView`、`TerminalPage`、`SessionContext`、相关测试都在重复声明 viewport/resize callback 的 shape
- **动作**: 把共享 schema 与 handler 签名下沉到 `android/src/lib/types.ts`，其余层只 import 使用
- **反模式**: 到处内联 `{ mode, viewportEndIndex, viewportRows }` 或 `(sessionId, cols, rows)`，后续改字段时四处漂移

### 模式: renderer prop 面按“真实输入”裁剪
- **适用场景**: 审计 `TerminalView` 之类 renderer component 的 props
- **动作**: 区分哪些 prop 真正参与渲染/输入/状态机，哪些只是历史 dependency 残留；后者直接移除
- **反模式**: prop 只剩 effect dependency 占位，却继续从 page/context/test 一路透传

### 模式: renderer trigger 用语义名，不泄漏 worker 内部命名
- **适用场景**: `SessionContext` / worker 内部状态名带实现细节，但 renderer 只关心触发语义
- **动作**: 在 renderer API 层改成语义名（如 `followResetToken`），由 page/context 做一次最小映射
- **反模式**: 把 `viewportResetNonce` 这种 worker 侧命名直接透传到 renderer prop，污染 consumer 心智

### 模式: 小传播面的旧命名直接全链统一
- **适用场景**: 旧字段名在 worker/store/page/renderer 之间只有少量闭合传播点
- **动作**: 如果已确认是单条主链，就不要长期保留映射层；直接全链统一成语义名
- **反模式**: 明知传播面很小，还让 page 层长期做“旧名 -> 新名”翻译

### 模式: request payload builder 只留一个真源
- **适用场景**: `SessionContext` 里普通 request 与 bootstrap request 只有少量字段差异
- **动作**: 把共同部分收成单一 builder，用显式 options 覆盖差异（如 `forceBootstrap`、`modeOverride`）
- **反模式**: 长期维护两份几乎一样的 payload builder，后续改字段容易一边改了另一边漏掉

### 模式: viewport demand 入口只保留“写状态 + 触发”
- **适用场景**: `updateSessionViewport()` 一类 worker 入口逐渐长出 normalize / 判等 / request scheduling 多重职责
- **动作**: 拆成 normalize helper、equal helper、active-demand helper；入口函数只负责更新 view state 并触发 demand
- **反模式**: 让入口函数长期同时处理数据归一化、去重、请求时序，后续 reading/follow 分叉会继续长回去

### 模式: active 输入后不做本地回显，但必须立刻挂 tail refresh demand
- **适用场景**: shell 输入后用户抱怨“没刷新”，但协议仍要求 server canonical buffer 是唯一真源
- **动作**: `sendInput()` 只发送 input，不本地改 buffer；同时给 active session 标记 `input-tail-refresh` demand，由 client 本地 30fps head cadence 在 `minTailRefreshGapMs` 门限下主动发 follow `buffer-sync-request + ping`
- **反模式**: 1) 为了“更快”做本地假回显 2) 完全被动等下一次 server head 才刷新 3) 每个输入字符都直接打一条 range request，退化成请求风暴

### 模式: daemon live push，client 只做显式补洞
- **适用场景**: 用户要求正常模式 daemon push、client 被动收最新正文；只有 reading/gap 才主动取数
- **动作**: daemon ready mirror 维持固定 cadence live capture；body 变更发 `buffer-sync diff`，纯 metadata 变更发 `buffer-head/info`。client 正常模式不再高频主动问 head；只在 `resume / reconnect / stale probe` 发 `buffer-head-request`，只在 reading gap repair 发 `buffer-sync-request`
- **反模式**: 1) client 常态 33ms 主动轮询 head 2) `buffer-head-request` 反向触发 daemon capture 3) 把 reading repair 和正常 live 主链混成一条

### 模式: foreground 恢复 owner 只能在 SessionContext lifecycle
- **触发信号**: 现场出现“回到前台 timeout、不重连、杀进程才恢复”，且 App 侧只是在切 `appForegroundActive`
- **动作**: App 只提供 foreground truth 和单调 `foregroundResumeEpoch` 事件；真正的 transport 恢复必须由 `SessionContext lifecycle` 对每个去重后的 foreground resume 事件唯一触发 `explicit-resume`，和冷启动恢复共用同一 transport owner
- **反模式**: 只监听 `appForegroundActive false->true` 布尔边、指望 active tick 被动兜底，或在 App/page 层再长一套 reconnect fallback

### 模式: session switch / foreground resume 要有短保活窗口
- **触发信号**: 用户短时间切 session、切后台回来，UI 每次都进入 reconnect / 新建 WebSocket，体验上比杀进程重进更慢
- **动作**: 在 `terminal.transport_lifecycle` owner 内用 recent alive truth（`lastServerActivityAtRef` / `lastConnectedBaselineAtRef`）给 `explicit-resume` / `active-reentry` 加短 keepalive grace；窗口内 missing/closed local socket 只返回 `transport-keepalive-grace`，超过窗口再走现有 reconnect/throttle owner
- **边界**: 这个 grace 只属于 lifecycle freshness，不属于 `active-tick` 或显式 input recovery；用户输入撞到 closed socket 仍必须走现有即时恢复路径
- **反模式**: 为了解决频繁重连在 App/TerminalPage 加延迟、把 daemon 改成记客户端 foreground、或让输入路径也等待保活窗口

### 模式: mux session 生命周期必须联合读取 target socket 与 channel
- **触发信号**: 同 daemon 的物理 mux socket 仍是 `OPEN`，但切 session / 回前台仍重建连接，或 channel 已关闭却被误判为可复用而一直不刷新。
- **动作**: connect/create/reconnect 决策统一读取 `SessionTransportResource`：target socket `OPEN` 且 terminal channel `open` 才复用；channel `opening` 视为正在打开；channel `closing/closed` 必须在原 target socket 上重开 channel。
- **反模式**: 只读 legacy `runtime.activeSocket`；只看 target socket `OPEN` 就跳过 channel reopen；为关闭的 channel 新建第二条 physical socket。
- **验证**: unit 正反成对锁住 open-channel reuse 与 closed-channel reopen，再跑 `SessionContext.ws-refresh` 黑盒证明同一 physical socket 上关闭 inactive channel 后切回会发新的 `mux-channel-open`。

### 模式: reconnect / offline 通知只做顶层悬浮投影
- **触发信号**: 网络状态条出现或消失时，terminal、QuickBar、remote-window video 发生上下跳动、重新测量或 resize
- **动作**: 状态 truth 仍由 `terminal.transport_lifecycle` owner 提供；页面只渲染 `position: fixed`、高 z-index、`pointer-events: none` 的顶层通知 overlay
- **边界**: 通知不得进入 flex/grid 正常流、不得占 margin/height、不得改变 page shell / terminal stage / remote-window container 尺寸，也不得借 UI 状态触发 reconnect
- **反模式**: 把 banner 当普通 page row 插入布局，或在每个页面复制一套网络状态判断

### 模式: stale reconnect bookkeeping 必须允许重启 reconnect
- **触发信号**: runtime/logs 出现 `sessionState=reconnecting + ws=null + no pending open intent`
- **动作**: 判定为 reconnect bookkeeping 卡死；foreground/explicit refresh 必须允许直接重启 reconnect
- **反模式**: 把 `reconnectInFlight` 当单一真相，导致 `transport-unavailable` 永久 skip

### 模式: 移动端发热先看 CPU/IO 真源
- **触发信号**: 手机明显发热，但网络流量不大
- **动作**: 先抓 `adb shell dumpsys cpuinfo`、`top -H -p <pid>`、`dumpsys gfxinfo`；重点看 `Chrome_IOThread` / `RenderThread` / `Slow issue draw commands`
- **高频真源**: 1) server 端空刷 viewport（例如把 `cursor.visible` 当变化条件导致每 96ms 发包） 2) client 端每帧 `localStorage.setItem(JSON.stringify(buffer/state))` 3) 全量 scrollback DOM + 常驻 blur

### 模式: Electron 桌面壳验证分层
- **适用场景**: future Mac / Win 壳移植 Android app-layer 流程
- **动作**: `.app` 只验证 build/package/window/stage 可执行；表单交互与回显优先走浏览器 dev server（同一 renderer 代码）做细粒度验证，再回到桌面壳做 smoke

### 模式: tmux discovery 不等于 live connect
- **触发信号**: UI 能列出 tmux sessions，但用户仍反馈“无法连接”
- **动作**: 检查客户端是否真的走了 Android 同构协议：`ws open -> send connect(payload) -> recv connected -> send buffer-head-request`；仅有 `list-sessions` 只能证明 bridge 可达，不能证明 session 已 attach

### 模式: 远程截图保存必须按 bytes 真源合并
- **触发信号**: 手机端截图预览能显示，但保存到下载失败，Android 报 `The supplied data is not valid base64 content.`
- **红测方法**: 先写黑盒回归证明多 chunk padding 不能直接拼接，例如 chunk bytes `[0xff] -> /w==`、`[0xee] -> 7g==`；错误拼接是 `/w==7g==`，正确结果必须是合并 bytes `[0xff, 0xee]` 后重新编码的 `/+4=`
- **动作**: 客户端按 `chunkIndex` 逐 chunk `atob` 解码为 `Uint8Array`，合并 bytes 后重新 `btoa` 生成唯一 `dataBase64`；预览可继续使用 `dataBytes`，保存必须消费重新编码后的完整 base64
- **UI 回归**: 同时覆盖保存失败后状态必须恢复到 `preview-ready`，`丢弃/关闭` 能退出 sheet；不要只验证预览成功
- **反模式**: 1) 直接 `ordered.join('')` 拼接每块 base64 2) 把真实 payload 裁成单 chunk 规避问题 3) 只改 UI alert/按钮状态而不修传输 payload 真源

### 模式: Android 11+ 本地文件同步必须走 native storage owner
- **触发信号**: FileTransferSheet 已授权存储权限，但 `/storage/emulated/0/Download` 仍显示空目录或读取失败。
- **真源**: Capacitor `Directory.ExternalStorage` 文档只保证 Android 9 或更老版本；Android 11+ 全盘文件访问即使有 MANAGE_EXTERNAL_STORAGE，也不能把 Capacitor Filesystem 当 owner。
- **动作**: 本地全盘文件访问统一走 `StoragePermissionPlugin` native 层，由 native 用 `Environment.getExternalStorageDirectory()` + canonical path guard + `java.io.File` 执行 `readdir/readFile/writeFile/mkdir`；UI 只负责权限 request、focus/visibility refresh、错误投影。
- **反模式**: 在 React 层继续调 `Filesystem.readdir({ directory: Directory.ExternalStorage })`，或把异常清空成“空目录”。

### 模式: 悬浮球拖动与点击分离
- **适用场景**: terminal 悬浮球 / 浮动入口既要支持点按开关，又要支持拖动 reposition
- **动作**: 用 `pointer/touch move threshold` 区分 click 和 drag；超过阈值后进入拖动态并 suppress click，位置持久化到 localStorage
- **反模式**: 只靠长按进入拖动，或拖动完成后未 suppress click，都会导致“拖不动”或“拖完又误开菜单”

### 模式: Connections 账号 daemon 是父列表真源
- **触发信号**: 用户要求同一账号下所有 daemon 设备统一显示，或页面出现 legacy daemon id / bridge endpoint 重复父卡片
- **动作**: 父行只从 relay account devices / device stream 建立；saved host、history group、live session 只能折叠成该 daemon 的子 session，legacy daemon id 必须 canonicalize 到 account daemon hostId
- **反模式**: 用 host/history/live session 反向生成父服务器列表，导致同一账号设备被拆成多张乱序卡片

### 模式: Connections group 生命周期必须可退出
- **触发信号**: 长按/展开 server group 后出现 `All/None/Manage/Clear/Open checked`，用户反馈不能退出或键盘遮挡操作
- **动作**: 管理态必须有显式 `Done`；`Clear` 要同时清 selection 和 expanded state；action row 必须 wrap，避免窄屏/键盘下横向溢出
- **反模式**: 只清 selection 不收起 expanded group，或把 Vault/占位入口静默路由回当前页让用户以为点击失效

### 模式: Connections 卡片点击进入，按钮才打开
- **触发信号**: 用户反馈“到了 group 卡片页面点击不会进入 group”或 `Open` 在 history-only/0-session 卡片上空转
- **动作**: card body tap 只负责 enter/expand group；`Open/Enter` 按钮才负责打开/恢复 session；不可打开的 group 显示 `Details` 并展开，禁止死 `Open`
- **反模式**: 让卡片 body 和 action button 共用一个 callback，导致点击卡片直接打开或空转而不能进入 group

### 模式: Relay directory 不是 daemon auth 真源
- **触发信号**: Windows / relay daemon 能在 Mac 上 list/create，但 Android picker 刷新或 drawer New Session 失败、旧 session 仍报 unavailable
- **动作**: Connections card、drawer hostKey、picker relay device target 必须用 saved server preset/host 补齐 `bridgeHost / bridgePort / authToken` 后再 `fetchTmuxSessions()` / `createTmuxSession()`；directory 只提供 endpoint/session catalog
- **反模式**: 只拿 relay directory 的 endpoint candidates 当完整 bridge target，会漏 daemon auth token，导致刷新/新建看似“没反应”

### 模式: drawer 手势归近边热区，fixed 裁切归 renderer
- **触发信号**: 用户要求抽屉只从边缘滑出，或固定宽度下左右滑动调整显示区域。
- **资源归属**: drawer/tab shell gesture 属于 `terminal.session_drawer`；`mirror-fixed` 横向裁切属于 `terminal.buffer_render` renderer projection；adaptive 宽度属于 daemon adaptive width lease owner。
- **动作**:
  1. Shell swipe start 必须限制在屏幕近边热区内；中间横滑不得开 drawer、不得切 tab。`mirror-fixed` 的 drawer 入口只允许左侧 64 CSS px + 向右 `previous` 手势：`x=56` 是正向样本，`x=88` 必须归 renderer crop pan。Android 不要把热区收成 0-几 px 贴边，系统返回手势会抢。
  2. `adaptive-phone` 中间横滑保持 no-op，不做客户端裁切，不抢 daemon/tmux reflow。
  3. `mirror-fixed` 中间横滑只移动 `.term-grid` projection offset，并按 session 持久化；不得 resize tmux、不得改 daemon mirror rows/cols。
- **验证**: 跑 `TerminalTabSwipeSurface.test.tsx`、`TerminalPage.session-drawer.test.tsx`、`TerminalPage.tab-isolation.test.tsx`、`TerminalSessionDrawer.test.tsx`、`TerminalView.dynamic-refresh.test.tsx`；真机用 DevTools/截图证明近边热区打开 drawer、点击 drawer row 能切 session、middle swipe 不打开 drawer、mirror-fixed offset 变化并持久化。
- **反模式**: 用页面中部横滑同时承担 drawer/tab 和 fixed crop；把抽屉入口限制到 Android 系统返回手势会吃掉的贴边窄条；adaptive 下做 CSS 平移冒充宽度适配；为 fixed pan 改 daemon/tmux geometry。

### 模式: session 快捷预览只复用 terminal 真源
- **触发信号**: 需要同时查看多个已打开 terminal session，或实现右缘滑入的 2x3/3x2 预览。
- **资源归属**: `terminal.session_preview` owns selection/mode/grid projection；terminal body truth 仍属于 daemon mirror、client sparse buffer、render store 和 shared `TerminalView`；transport/reconnect/resize owner 不变。
- **动作**:
  1. 抽屉多选只能选择当前已打开 session，数量是 1-6，不要求选满 6 个；持久化 identity 必须包含 `sessionId + bridgeHost + bridgePort + sessionName`，有 `daemonHostId` 时恢复也要匹配。
  2. 右缘左滑进入 preview；左缘右滑仍归 drawer，中间横滑仍归 `mirror-fixed` crop。同一 touch sequence 只能有一个 owner。
  3. Preview tile 复用 `TerminalView` read-only surface：不传 input/resize/viewport callbacks，不 focus DOM，不 copy，不 IME，不改 width mode，不 reconnect。
  4. Preview 打开时把 selected ids 临时 union 到 live body subscription；关闭、后台、退出后恢复 baseline，只保留 selection preference。
  5. Tile 点击只走唯一 page owner：先把目标 session 投进当前 focused session-group slot，再发一次 explicit active-session switch，然后退出 preview；进入/退出 preview 不改变 active session。
  6. Preview grid 是 count/orientation projection：竖屏每行最多 2 个，横屏每行最多 3 个，只创建所需行数；禁固定铺满 2x3/3x2 空槽。
  7. Tile 长按只进入 replacement menu：菜单候选必须是当前 open 且未选中的 session；替换保持原顺序并持久化，不切 active session。长按或明显移动必须抑制 release click，避免替换菜单和 tile activation 同时发生。
  8. Tile 右上角关闭只移除该 preview target，不关闭 Session/transport；移除最后一个 target 时走 preview cancel restore。
  9. Preview body 允许本地只读上下滚动与 `mirror-fixed` 横向 crop/pan；这些手势不得冒泡成 tile activation、replacement、preview exit、input、resize、viewport 或 width-mode 写。
  10. Preview entry 捕获 active session + session-group slots/focus；关闭按钮、右滑、Android system Back 都是 cancel，恢复该 entry projection。Tile activation 丢弃 entry snapshot，不得被 cancel restore 覆盖。Back listener 只在 preview open 时注册。
- **验证**: 白盒 selection/gesture/live-set 正反测试；组件黑盒验证 drawer 普通/多选隔离和 2x3/3x2；source-to-DOM/source-to-shell gate 自动比较 tmux capture、daemon buffer-sync、client sparse buffer、render store、preview DOM 和真实 StageShell DOM，并验证 subscribers `baseline -> +selected -> baseline`。
- **反模式**: 用截图或 cached text 做预览；为 preview 新开 WebSocket/tmux session；在 tile 内启用输入或 resize；用 UI filter 掩盖 stale session id；用人工看截图代替 source/target 自动对比。
- **反模式补充**: 只调用 `handleSwitchSessionFromChrome(sessionId)` 不更新 session-group viewport projection；这会让输入/live owner 与可见 shell owner 分裂。

### 模式: terminal width mode 是用户偏好资源
- **触发信号**: 用户设置过 `mirror-fixed`，升级/重装/冷启动后变回 `adaptive-phone`。
- **资源归属**: `terminalWidthMode` 属于 client settings/user preference resource，不属于 renderer、daemon、tmux。viewport 检测只用于首次安装没有偏好时的默认值。
- **动作**:
  1. 先读完整 `zterm:bridge-settings.terminalWidthMode`。
  2. 如果旧配置缺字段，再读显式偏好 key `zterm:terminal-width-mode-preference`。
  3. 两者都没有时才按 viewport 选择首次默认。
  4. 用户在 Settings 或 terminal header 切 mode 时，同步写 bridge settings 和 explicit preference key。
- **验证**: storage hook 测试必须覆盖 `mirror-fixed` 首屏读取、旧配置缺字段读取 preference、设置变更写双 key；真机升级验证必须在 WebView 可见且 `isKeyguardShowing=false` 时读 DOM/localStorage，不得用锁屏 invisible WebView 结果当闭环。
- **反模式**: 重装后用 viewport 默认覆盖用户偏好；只测 adaptive 默认不测 fixed 持久化；把 invalid/unknown mode 当作显式 fixed。

### 模式: quickbar 横向裁切只属于展开 rows 高度
- **触发信号**: 下方快捷栏内容宽于屏幕，用户要求像 fixed mirror 一样左右滑动选择显示区域。
- **资源归属**: `terminal.quickbar` owns bottom shortcut bar pan/crop. Renderer `mirror-fixed` pan 只管 terminal body；drawer/tab shell swipe 只管 session shell；daemon/tmux 不参与。
- **动作**:
  1. 横滑 touch owner 可放在 `terminal-quickbar-shell-rows`，但触发区域只等于快捷栏展开后的真实高度。
  2. `data-quickbar-scroll-track` 是自身 native horizontal scroll owner；touch 从 scroll track 内开始时，父级 rows 不得 `preventDefault()`，不得同步改其它 track 的 `scrollLeft`。
  3. button/input/label 等交互控件是自己的点击/输入 owner；touch 从这些控件开始时，父级 rows 不得启动 pan。
  4. 只有从 rows 非交互空白区域开始的横向手势，才允许在横向锁定后同步移动 quickbar scroll tracks；纵向手势不 pan。
  5. 不要把 shell rows 标成全局 pointer allow；只允许 touch pan surface，否则空白 click 会冒泡到 terminal。
- **验证**: `TerminalQuickBar.test.tsx` 同时覆盖 rows 空白 horizontal pan、vertical no-pan、scroll-track native-owner no-steal、button no-steal、blank shell click still blocked；真机验证必须在 unlocked foreground WebView 上测下方快捷栏 track 原生滚动和空白区域 pan，不用锁屏 invisible WebView 代替。
- **反模式**: 在 TerminalView / page stage 上吃快捷栏横滑；把 quickbar 手势热区扩大到终端内容区域；父级 rows 对 scroll track touch 调 `preventDefault()`；为了横滑破坏按钮点击或 shell click blocking。

### 模式: quickbar collapse/reveal 与内部滚动共用 axis lock
- **触发信号**: QuickBar 内部 track 可以横向滚动，但用户无法再用手势收起或唤出整个 QuickBar。
- **资源归属**: `TerminalQuickBar` 是 collapse/reveal 唯一手势 owner；`TerminalPage` 只持有 `quickBarCollapsed` projection。renderer、drawer、daemon、tmux 不参与。
- **动作**:
  1. Expanded rows 的 touch state 同时记录 axis、start/last point、是否允许 rows horizontal pan。
  2. 横向从 scroll track/button 开始：交给 track/button，不同步 sibling，不 collapse。
  3. 横向从 rows 空白开始：只做 QuickBar 内容 pan，不 collapse。
  4. 纵向向下超过 48px：`onCollapsedChange(true)`；短纵滑和 touch cancel 不改变状态。
  5. Collapsed bottom trigger 向上超过 48px：`onCollapsedChange(false)`；普通 tap 仍可展开。
  6. Portrait/landscape 都必须允许 collapse；禁止页面 effect 因 orientation 把用户刚收起的 QuickBar 强制展开。
- **验证**: `TerminalQuickBar.test.tsx` 正反覆盖 vertical collapse/upward reveal/horizontal no-collapse/short no-collapse；`TerminalPage.foldable-display-change.test.tsx` 覆盖 portrait collapse persistence；真机 CDP 必须完成 expanded -> collapsed -> revealed，并复测 track 横滑只动当前 track。
- **反模式**: 只保留收起按钮/悬浮按钮而丢失手势；让 vertical collapse 抢走 track horizontal native scroll；在 portrait 下自动清 `quickBarCollapsed`。

### 模式: quickbar 折叠高度 0 必须穿透到 stage reserve
- **触发信号**: QuickBar rows 已经消失，但 terminal 下方仍留着展开态同样高度的空白，shell 没有向下填满。
- **资源归属**: `TerminalQuickBar` 生产真实 chrome measured height；`TerminalPage` 只消费该高度计算 stage bottom reserve。renderer/tmux/daemon 不参与。
- **动作**:
  1. Expanded 时上报真实正高度；collapsed 时显式上报 `0`。
  2. 页面 consumer 必须接受 `0`，只做 `Math.max(0, height)` 归一；禁止用 `height > 0 ? height : current` 保留 stale positive height。
  3. Collapsed reveal surface 覆盖整个底部触发带，宽度为全屏，高度只限 collapsed bottom chrome；左侧/中间上滑也必须恢复。
  4. reveal surface 内的小键盘按钮保留自己的 toggle 语义，但不能成为唯一召回热区。
- **验证**: 页面级正反测试先锁 positive height reserve，再锁 zero clears reserve；真机 CDP 记录 expanded/collapsed/revealed 三态的 `terminal-stage-shell.style.bottom` 和 rect，高度必须随 0 reserve 释放并恢复。
- **反模式**: 把 0 当成无效测量；只隐藏 rows 不清 stage reserve；只给右侧小按钮挂 reveal 手势；为修空白去改 renderer 行布局或 tmux geometry。

---

Inspired by coding-principals skill.

---

### 问题: pnpm install 速度极慢或卡住
- **触发信号**: 下载进度长期停滞（如 next@33MB 只下载 1MB），resolved 卡在 55 左右
- **真源**: npm registry 官方源在中国网络下速度极慢（~5KB/s）
- **解决方案**: 
  1. 切换到 npmmirror: `pnpm config set registry https://registry.npmmirror.com`
  2. 若已有安装进程卡住，只允许用明确 PID 结束该进程；再执行 `pnpm install --no-frozen-lockfile`
- **验证**: 切换后 resolved 应快速达到 1400+，packages 应显示 +1293
- **恢复**: 安装完成后可恢复官方源: `pnpm config set registry https://registry.npmjs.org`

---

## 原型页面经验（2026-04-18）

### 交互设计要点
- 顶部说明文字不是按钮，只显示当前状态
- 快捷栏按钮实现真实交互（点击切换状态）
- 快捷键编辑界面使用全屏覆盖（z-index: 200）
- 终端高度自适应：根据键盘状态动态计算
  - 快捷键盘展开：180px
  - 系统键盘显示：280px
  - 无键盘：320px

### 最佳实践
- 使用 CSS transition 实现平滑高度变化
- Session 切换面板使用 position: absolute + z-index: 100
- 编辑界面使用 position: fixed 全屏覆盖

## 经验精华（2026-06-08）
## 经验精华（2026-06-26）— Copy Mode 长按菜单

### 根因
copy mode 长按菜单退化原因是 TerminalView 中加了宿主级触摸拦截
（capture-phase touchstart/pointerdown preventDefault）。copy mode active
时阻止 WebView 处理触摸事件，但 Android 手势系统因此把长按事件吃掉，
表现是有震动反馈但 JS 菜单不弹出。

### 修复
- TerminalView.tsx：移除 preventNativeCopyGestureDefault
  （pointerDownCapture 拦截）和 preventNativeCallout（host touchstart 拦截）。
  copy mode 现在只保留 contextmenu 和 selectstart 抑制。
- TerminalPageStageShell.tsx：修复 JSX 缩进断裂，onLongPressRow/splitVisible
  之前在 pane-stage 渲染时落到非元素节点上，部分 session 收不到 copy props。
- 新增端到端红测 copy-longpress-e2e.test.tsx（7 条），覆盖
  touchstart→420ms→menu 全路径。

### 调试手段
debug overlay 现在显示 MU（菜单位置）和 CE（结束行），长按后看 MU
是 null 还是有坐标，能直接判定定时器是否到达 copy runtime。

### 反模式
- 禁止在 copy mode 下再加 host-level touchstart/pointerdown preventDefault 拦截。
- JS 长按的 onTouchStart 和 onPointerDown 同时存在是安全的，系统只会调度一个。
- 任何 copy mode 手势链路修改，必须先跑 copy-longpress-e2e.test.tsx 全量红测。
  这 7 条测试锁住"未激活不启动→激活后 420ms 触发→移动取消→menu 状态设置→菜单渲染"。

### 经验精华（2026-06-27）— Copy shell boundary
- QuickBar shell 只应守自己的交互按钮与输入控件，不能把 shell 级 capture 做成 terminal row 手势政策。
- copy long-press 的 delay / slop 要集中到纯 helper；runtime 只做选择状态，UI shell 只做自己的事件守门。
- 再次出现“JS 菜单不弹 / 系统长按抢先”时，先查 shell capture 边界，再查 TerminalView 的 long-press timer，最后才看 state machine。
- 再次出现“copy mode 偶发没激活”时，先查 QuickBar `tmux-copy` 入口是否仍是 press-owned；该入口不能只依赖 `click`，必须用 `pointerDown` 激活、`touchEnd` fallback，并对同轮 pointer/touch/click 去重。
- 如果 press 后慢释放会把 copy mode 误切回去，说明还在用时间窗判定同轮事件；`tmux-copy` 应改成 armed / commit 两段式，press 只 armed，release 才 commit，click 只作 fallback。
- 真机若显示 `CM OFF` 且点击 `拷贝` 不进入 copy mode，不能把入口放在 release commit；Android WebView 仍可能漏 `pointerUp/touchEnd`。`tmux-copy` 必须 press-start 立即触发，用显式 press sequence 消费后续 touch/pointer/click，禁止二次 toggle。
- copy mode 行级长按不能 `stopPropagation()`；否则父级 `TerminalTabSwipeSurface` 收不到右滑起点，表现为 copy 状态下 session drawer 右滑也失效。
- 如果按钮已经变 active 但 `TerminalView` 里的 copy mode 仍旧不变，先查 `TerminalStageShell` 的 `ReactMemo` comparator 是否漏了 `copySelection` / `onLongPressRow`；不要继续只修 QuickBar。

### 经验精华（2026-06-29）— daemon-first 首次绑定
- relay 已登录时，daemon-first 只能把“已映射 preset”当快捷路径，不能把“未映射 daemon”的首次手工绑定藏掉。
- 当 selected daemon 没有 bridge preset 时，必须直接显示可编辑的 bridgeHost/authToken，并允许 Connect / Save 以“已选 daemon + 已填 host/token”完成首次绑定，再同步写入 server preset 真源。
- 再次出现“保存后退出但 Connections 没新增服务器”时，先查是不是 form 层把首次绑定入口挡死了，而不是先怀疑存储层。
## Android WebSocket Underlay Switch

- Trigger: user reports Wi-Fi works but cellular / network switch stalls, while killing and reopening the app reconnects immediately.
- First prove the layer split: configured target IP/port, phone-to-daemon `/health` reachability on the new underlay, daemon listener, and client WebSocket/runtime state. Do not call it an endpoint problem if Tailscale IP stays reachable.
- Treat `WebSocket.OPEN` as insufficient health truth. A socket can remain OPEN while bound to a dead Wi-Fi underlay. Health requires recent pong or any valid server frame.
- Unique owner: `terminal.transport_lifecycle` via `src/contexts/session-context-socket-runtime.ts`. Do not add UI page reconnect loops, daemon client-network state, fallback endpoints, or per-screen WebSocket rebuild logic.
- Mobile default: mux target heartbeat is one timer per physical daemon target, normal interval 60s class; target health activity is keyed by target identity, not session id. After the configured consecutive physical-health policy is exhausted, finalize that target socket once as retryable failure and let the existing reconnect owner replace only the physical transport while preserving logical session/channel ids, active-session truth, and buffers. Never add a heartbeat per logical session.
- Required black-box gate before claiming closure: installed APK on real device, live TUI session, Wi-Fi-to-cellular and cellular-to-Wi-Fi switch, phone `/health` still reachable, one replacement physical WebSocket, unchanged session/tmux target, monotonic buffer head, input/output recovery within 10s.
