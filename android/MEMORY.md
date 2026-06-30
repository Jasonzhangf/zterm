# MEMORY — Long-Term Memory

## Project Overview

- 项目目标：Android 终端应用，Capacitor + @jsonstudio/wtermmod-react
- 手机端定位：纯 client
- 服务端定位：本地 Mac/PC 的 tmux → WebSocket 桥接

## Key Decisions

- [2026-06-29] 多 daemon / 多服务器 UI 的用户可见身份不能再用 `bridgeHost:bridgePort` 或 telnet/bridge 端口表示；端口只是 transport 配置，不是服务器名。统一真源是 `src/lib/server-identity.ts`：drawer 分组、session group side peek、服务器色调用同一套 server key / display name / tone；UI 层只能消费 projection，禁止各自拼端口当 label。
- [2026-06-29] zterm 多服务器身份色不能用连续 hue hash 自由漂移；紫/粉区在窄 drawer 里辨识差且视觉噪声高。`server-color.ts` 必须使用固定红/黄/蓝/绿/青/橙 palette，并用回归锁住常见服务器 key 不同色。
- [2026-06-29] Connections 入口页、terminal drawer、session group peek 必须共用 `server-identity.ts` 的同一 server key/tone。禁止 Connections 页直接按 `bridgeHost:bridgePort` 调 `server-color`，否则同一 daemon 会在入口页和抽屉显示成不同颜色。
- [2026-06-29] Terminal renderer 的 cell 宽度真源必须来自可信 glyph probe；如果 hidden probe 返回接近整屏宽，必须拒绝并回退到字体估算。单列 cell 被测成 viewport 宽会直接导致 ASCII/CJK、色块、反显区域错位。
- [2026-06-29] Android 网络从 offline/route-change 回 online 时，生命周期层必须只恢复当前 active tab transport，并复用现有 resume/audit/follow reset 主线；hidden 状态 online 不恢复，不允许扫所有 session 放大卡死风险。
- [2026-06-29] traversal route health cache 是进程级全局状态；任何会创建 `TraversalSocket` 并断言 WebSocket 实例数量/线路选择的测试，必须在 `beforeEach` 清 `defaultTraversalRouteHealthCache` 或注入隔离 cache。否则前一个用例记录的 failure/auth-failure 会让后续用例无候选路由，表现为 `MockWebSocket.instances` 期望 1 实际 0。
- [2026-06-30] `TraversalSocket` 不能在“所有候选都失败且暂无可选路由”时直接落死为永久 error；`finishFailure()` 必须继续进入 `scheduleReconnect()`，让后续网络恢复时自动重试。相关 reconnect 回归测试必须使用隔离的 route health cache，避免历史 failure 污染路由选择。
- [2026-06-30] traversal route selection 不能把 `failure/auth-failure` 提升成绝对不可选终态；当同 scope 下所有 candidate 都 unhealthy 时，selector 仍要返回“最不坏”的 candidate 让 socket 显式 probe。否则 route health cache 会把暂时性的网络恢复误判成永久无路可走，表现为杀 App 才能恢复。
- [2026-06-30] client buffer manager 不能把非连续 revision 的 sparse `buffer-sync` 当作完整 body truth 合并；如果 local revision 跳过中间帧且 payload 未覆盖完整窗口，必须拒绝写入本地 buffer 并请求 authoritative tail window。否则漏过的旧行会被 sparse diff 永久保留，表现为“大面积刷新时两行旧内容跟着 buffer 上移”。
- [2026-06-29] Android IME / keyboard lift 真源必须只有一份：`terminal-keyboard-lift.ts` 负责 viewport / lift 判断，`TerminalPage.tsx` 只能消费和 re-export，不能再复制 helper。已验证 WebView 已 resize 时 lift 必须为 0，只有 overlay 才按 stable height 计算。
- [2026-06-29] `test:terminal:contracts` 必须串行文件执行。`SessionContext.ws-refresh.test.tsx` 这类文件会 stub 全局 `WebSocket`，在 vitest 默认 file parallel 下会互相覆盖；contracts gate 需要 `--no-file-parallelism` 才能稳定区分真失败与假红。
- [2026-06-29] WezTerm 可作为 Windows TUI 观测窗口：`wezterm.exe cli spawn --new-window ... cmd /c codex` 能把 `codex` 跑进 mux pane，`wezterm.exe cli get-text --escapes` 可直接抓到当前屏幕和 ANSI 样式；`list` 用于定位 pane，`get-text --start-line -N` 可看 scrollback。此结论只覆盖“运行 + 观测”，不代表 input 已接入 daemon 真源。
- [2026-06-29] App update 弹窗按钮必须以用户眼前的显式 manifest 为安装真源：`startUpdate(manifest)` 不应再二次拉 `latest.json` 并因服务端刚发布新版而报“升级清单已变更”；二次 revalidation 只保留给无显式 target 的内部 `startUpdate()` 路径。已用正向/反向单测锁住，并发布 `0.1.3.1955` 到 `100.66.1.82:3333/updates/`，APK HTTP 200。
- [2026-06-30] Windows daemon runner 的两个高频坑已锁定：PowerShell 5.1 写 `config.json` 默认会带 BOM，daemon 读取会直接报 `Unexpected token '﻿'`；Windows Scheduled Task 运行环境也不会继承交互式 shell 的 PATH，所以 runner 不能假设 `wezterm.exe` 可见，必须显式探测并固化 WezTerm 可执行路径。后续 Windows 安装/自启动脚本默认按 no-BOM UTF-8 写配置，并把 WezTerm 路径当成安装态真源。
- [2026-06-30] Windows daemon 的连通性判断不能把“SSH/Tailscale 可达”误当成“应用端口可达”；如果 `22` 可连但 `3333` 不通，先查 Windows 侧监听/绑定/WFP/防火墙/服务暴露链路，不要再归因到 Tailnet 本身。
- [2026-06-30 superseded] UI 入口语义曾被错误收口为“Connections 主页面只进入/连接服务器 workspace，不打开 `new-connection` picker”。该结论已被现场纠正：主入口必须能新增服务器连接；只保留“Terminal drawer 底部 `New Session` 在当前选中 daemon 上创建空白 session”这一半规则。
- [2026-06-30 correction] Connections 主页面 FAB 的语义应是“新增服务器”，必须打开 `new-connection` picker；不能被收口成只进入已有 server workspace，否则用户无法新增服务器连接。Terminal drawer 底部 `New Session` 的语义仍是“在当前选中 daemon 上创建空白 session”，但 hostKey 解析必须覆盖 relay directory、saved server preset、runtime session identity，不能只依赖 relayDevices。
- [2026-06-30 correction] Terminal drawer 底部 `New Session` 不能点击后直接创建；必须先弹出创建表单，让用户确认 session 名和启动路径。启动路径默认 `~/`，用户可补齐为目标路径；确认后才调用 `tmux-create-session`，wire payload 必须携带确认后的 `cwd`。
- [2026-06-29] 多 daemon drawer 分组必须先做 endpoint alias 归一化：同一 `bridgeHost:bridgePort` 上只要任一 session 带 `daemonHostId`，其它只带 IP 的历史/open tab session 也要归入该 daemon identity；否则 UI 会把同一台机器拆成 “IP” 和 “机器名” 两组。`TerminalSessionDrawer` 只能显示注入的 `hostLabel`，禁止在 drawer 内再次从 key/label 推导名称。

- [2026-06-29] MacBook Air daemon 安装/启动的真源必须固化在 daemon 包与 service runner 内：npm postinstall / launchd runner 负责自动写 `~/.local/bin/zterm-daemon`、`~/.local/bin/wterm`，写入前先清旧 symlink/file；released runner 在读 config 前负责把旧 `~/.wterm` 迁移到 `~/.zterm`。远端验证已确认 `restart` 后服务正常、health 为 `ok: true`，且不再依赖手工修 PATH 或手工挪目录。

- [2026-06-29] ConnectionPropertiesPage 的 daemon-first 模式不能把“未映射 daemon”挡成死路：当 relay daemon 已选但没有 bridge preset 时，必须显示可编辑的 bridgeHost/authToken，让用户首次手工绑定后再保存并同步写入 `bridgeSettings.servers`；保存/Connect 都只能要求“已选 daemon + 已填 host/token”，不能再要求先有 preset。

- [2026-06-28] mobile session group 的正确语义必须拆成固定槽位和 viewport projection 两层：drawer 显示的 top / center / bottom 是用户显式分配真相，点击 peek 不得改写；stage 只按当前 focus slot 投影可见窗口。focus=top 时 viewport 为 `empty / top / center`，focus=bottom 时 viewport 为 `center / bottom / empty`，focus=center 时 viewport 等于固定槽位。focus 必须存 slot name，不能存 session id；抽屉点击 session 只替换当前 focus 槽位。禁止从已有 tab/session 列表自动补邻居做 wheel，也禁止点击后循环轮转。未指定槽位只渲染 placeholder；drawer 长按/右键的 slot menu 是唯一的槽位分配入口，且 menu 打开后必须 suppress 下一次 click，防止“打开菜单同时又切 session”的误触。
- [2026-06-28] mobile session group 的边界可见性必须和槽位 truth 分离：focus=top 时只隐藏 top 边界，focus=bottom 时只隐藏 bottom 边界，center 才显示两侧边界。这个规则已经下沉为共享 viewport projection helper，未来横向 left/right 也必须复用同一边界抽象，禁止在 UI shell 里各自再写一套 top/bottom 或 left/right 的局部 if。
- [2026-06-28] session group layout axis 的默认真源是 aspect ratio，不是设备名：`width / height <= 0.4` 的窄竖屏强制 vertical，上下滚；宽竖屏默认 horizontal，可在 Settings 切回 vertical；landscape 永远 horizontal。该设置只影响 layout projection，不改 drawer 固定槽位和 session/tab/pane 真相。
- [2026-06-28] copy mode 的 QuickBar 入口不能只依赖 `click`；Android WebView 下工具栏按钮 `click` 合成会偶发漏触发。`tmux-copy` 应由 press-owned 路径激活，但不要用固定时间窗判断同一轮触摸；现在收口为 `pointerDown/touchStart` armed、`pointerUp/touchEnd` commit、`click` fallback 的单轮去重，避免长按/慢释放把 copy mode 误切回去。长按菜单链路仍按 copy-longpress gate 验证。
- [2026-06-28] copy mode 的 QuickBar 入口在 Android WebView 下必须 press-start 立即激活；release commit 仍会漏 `pointerUp/touchEnd`，表现为按钮触达但状态浮窗 `CM OFF`。去重应由显式 press sequence 承担，后续 touch/pointer/click 只消费不二次 toggle。copy mode 行级长按也不得 `stopPropagation()`，否则父级 `TerminalTabSwipeSurface` 收不到右滑起点，session drawer 会被 copy 手势一起锁死。
- [2026-06-28] copy mode 还有一层 UI 耦合：`TerminalStageShell` 的 `ReactMemo` comparator 必须把 `copySelection` 和 `onLongPressRow` 纳入比较；否则 QuickBar 会先变蓝，但 `TerminalView.copyModeActive` 仍停在旧值，直到点开状态浮窗触发别处 state 更新才“看起来生效”。回归应直接盯 `TerminalView` 的 copy props，不要只看 QuickBar 染色。
- [2026-06-28] `BridgeSettings` 是 terminal width mode 的启动唯一真源；`useBridgeSettingsStorage` 首次 render 必须同步读取并 normalize localStorage，禁止先返回默认 `mirror-fixed` 再等 effect 异步修正，否则 restore/connect 首帧会用错宽度模式，表现为 `adaptive-phone` 只有重新 save 后才生效。
- [2026-06-27] Android 抽屉底部单按钮动作必须只保留一个语义 owner；`pointerup` / `touchend` / `click` 不要叠在同一个按钮上再加时间戳去重。`TerminalSessionDrawer` 的 `New Session` 经真机证伪不能依赖 `click` 或 `pointerup`；该按钮应由自身 `touchend` 截断父级 drawer 手势并触发 quick-tab picker。已用 `TerminalSessionDrawer` + `TerminalPage.session-drawer` 定向测试锁住。
- [2026-06-27] `TerminalSessionDrawer` 的 `New Session` 若状态浮窗显示只收到 `drawer:touchstart` 而没有 `add:*`，不能继续猜 `click/pointer/touch`，也不能直接判定遮挡；必须先用 capture target 确认命中节点。已验证有效修复是把 `New Session` 的语义 owner 从内部 button 上移到整个 footer hit surface，footer 自身作为唯一 `touchend` owner 触发 quick-tab picker，并用 `cap:start/end:<target>` 回归锁住。
- [2026-06-27] Session picker 默认不应要求人工点 `Connect`：只要有明确 `bridgeHost + authToken`，打开 sheet 就自动刷新 tmux sessions。picker row 必须把 daemon session 与已打开 tab 合并成同一行；daemon 成功枚举后，目标 owner 下未被远端报告的本地 open tab 自动以 `session-picker-remote-missing` 关闭，避免双列表和 stale tab。
- [2026-06-27] Android IME 特殊键要同时锁 `ImeAnchor backspace` 事件路径和 hardware `key` payload 路径；`KEYCODE_DEL` 必须归一为 `Backspace -> \x7f`，`KEYCODE_FORWARD_DEL` 必须归一为 `Delete -> \x1b[3~`，`Escape -> \x1b` 也要在 JS active-session 路由测试中覆盖。已用 `TerminalPage.android-ime.test.tsx` 与 native `ImeAnchorHardwareKeyMappingTest` 验证。
- [2026-06-11] multi-pane refresh 的一个明确放大器已收口：`SessionContext lifecycle` 的 active tick 只刷新 active session，visible non-active panes 走独立更慢的 passive visible tick；`buildLifecycleRefreshTargets()` 只保留 active，新增 passive visible target / schedule helper。已用 lifecycle、multi-pane-refresh、TerminalPage page tests 和 `tsc --noEmit` 验证。
- [2026-06-11] `TerminalPage` 的 interaction/live-pane orchestration 必须只有一个 owner；若 `interactiveSession / renderedPaneSessions / livePaneSessionIds / pane attach / chrome switch / swipe tab` 同时散在页面本体和 hook 中，就会形成第二份页面层语义与额外重算。当前唯一 owner 已收口到 `useTerminalPageInteractionRuntime`。
- [2026-06-12] active tab 切回后输入成功但本地刷新慢的一个真实生命周期缺口是：`resetSessionTransportPullBookkeeping()` 只清 pull state / sync debounce，不清 `pendingInputTailRefreshRef`。旧 input tail pending 会让切回后的第一笔输入失去立即 head-refresh 触发，表现成“远端先动、本地慢刷”。现在切 tab / active re-entry 的 reset 口已统一清理该 pending 输入书账。
- [2026-06-12] `build:android` 曾被 relay smoke 的固定端口 `19091/4335` 卡住，现已改成动态空闲端口分配后再注入 env；这是本机环境污染下的门禁问题，不是 relay/daemon 协议问题。修复后 `pnpm --dir android run build:android` 成功并发布 `0.1.3.1773` 到 `android/update-dist/`、`android/release-dist/` 和 `~/.wterm/updates/`，sha256 `c9a2e986715e99adda0977717b90b38e6d79541518e97c51fbdf376e17035f73`。
- [2026-06-09] client buffer 在 revision reset / 窗口失真期间不得发布空中间帧清空已有画面；若收到低 revision 且 `startIndex/endIndex` 为空、`lines=[]` 的 payload，只能记录等待，保留上一帧，直到非空或有明确范围的 `buffer-sync` 再提交 renderer，避免“先黑屏再刷新”。
- [2026-05-02] terminal 四层模型再次冻结：daemon 只管 `tmux -> mirror truth`；renderer 是 visible range 唯一真相；buffer manager 只管 local sparse buffer / gap repair，不持有 `follow / reading / renderBottomIndex`；gap 必须先空白占位，再按行/区间 patch 重刷
- [2026-05-02] terminal transport 也再次冻结：transport 必须长期复用长链接；同一 `bridge target` 只允许一个 control transport，同一 `clientSessionId` 只允许一个稳定 per-session transport；foreground/background/tab switch 只影响取数，不得 fresh recreate transport

- [2026-04-18] 先把流程真源拆成 spec / architecture / dev-workflow / task / CACHE / MEMORY / evidence
- [2026-04-18] skill 只承载跨任务可复用的动作、门禁、反模式
- [2026-04-18] runtime 改动必须走 build + sync + 安装态验证
- [2026-04-18] 本地开发入口遵循仓库 portless 规则，使用命令输出的 `*.localhost` 地址，不写死端口
- [2026-04-18] workspace 需要显式包含 `docs/decisions/` 与 `scripts/`，让流程与脚手架同层可见
- [2026-04-18] `note.md` 定位为 agent 私有工作笔记，不是项目真源；完成证据最低标准为截图、命令输出、APK 路径、必要时 logcat
- [2026-04-18] UI 实现前先冻结主参考图/次参考图；移动端结构优先级高于网页式临时布局
- [2026-04-18] connection 主线采用 `Sessions/Connections` 列表 + `Connection Properties` 五段式表单 + 终端预览卡片 + FAB 新建入口，不走网页式 host list 方案
- [2026-04-18] 页面级实现要先落 `docs/ui-slices.md`，把 App Shell、Connections、Properties、Terminal 分层，再进入代码
- [2026-04-18] 新实现 epic 使用 Beads `mobile-13`：三页式 mobile connection / terminal 架构；旧 open epic 已清理
- [2026-04-18] Connections 卡片的 preview 区不能在无 preview 时回退到 subtitle；否则会把同一连接摘要显示两次。无 preview 时应留空或改成独立占位文案。
- [2026-04-19] mobile 终端主链已从 SSH bridge 切到 tmux bridge：host/port 表示 bridge 地址，username 临时承载 tmux session 名
- [2026-04-19] Android WebView 若需要连 `ws://` 本地 bridge，不能继续使用 `androidScheme=https`；必须切到 `http` 并允许 cleartext，否则会被 secure-context / mixed-content 规则拦住
- [2026-04-19] Android 构建依赖 JDK 21；若本机装了 Homebrew `openjdk@21`，构建脚本应自动探测并导出 `JAVA_HOME`
- [2026-04-19] 连接模型不能把 server 与 tmux session 混成单一概念；必须显式支持：不同 server 上不同 session、同 server 上不同 session、必要时同 session 多客户端 attach
- [2026-04-19] 连接/会话真源要拆成 `bridgeHost + bridgePort + sessionName`，tab/卡片/终端标题必须同时展示 server 与 tmux session，避免“一个 host 字段兼做两层语义”
- [2026-04-19] 服务器启动入口要收敛成一个 daemon CLI，默认监听地址/端口由统一配置决定（当前 `0.0.0.0:3333`）；不要在验证过程中散落多个临时端口和多余 tmux session
- [2026-04-19] `bridgePort` / daemon port / daemon tmux session 名需要共用单一配置真源（当前 `src/lib/mobile-config.ts`）；UI、server、shell script、tests 不要各自写默认端口
- [2026-04-19] `New connection` 不能直接落空表单；应先进入统一 session picker：历史连接优先、tmux sessions 次之、clean session 最后。tmux 列表至少支持 list/create/rename/kill；terminal 顶部 `+` 长按复用同一个 picker 做 quick new tab
- [2026-04-19] session picker 顶部必须支持手动输入 Tailscale IP / tailnet host，并在输入后立即尝试列 tmux sessions；Tailscale 目标在 remembered servers / history 中优先展示
- [2026-04-19] tmux session 需要支持 multi-select，一次直接打开多个 tabs；适用于 New connection 与 quick-tab picker
- [2026-04-19] daemon / connection 鉴权真源使用共享 token：server 优先读 `~/.wterm/config.json -> zterm.android.daemon.authToken`，`ZTERM_AUTH_TOKEN` 只作显式 override；client 从 remembered target / host `authToken` 透传到 websocket query
- [2026-04-19] launchd 管理的 mobile daemon 不能只凭 `launchctl loaded` 判定 ready；`wterm daemon start/restart/install-service` 需要等待监听端口就绪，否则手机首连会撞空窗期误判“根本连不上”
- [2026-04-19] 悬浮球快捷菜单语义已冻结为“文本 snippet 注入”；方向键 / Esc / Backspace / 键盘切换只保留在常驻栏，自定义项默认不再预置 Ctrl 组合键
- [2026-04-19] daemon 稳定性门禁：`tmux capture-pane` 只能作为增强快照，失败时必须显式暴露错误并修真源，绝不能把整个 bridge 进程打挂
- [2026-04-19] 断线恢复门禁：client 不能只发 ping 不管 pong；必须有 `pong timeout -> 主动断开 -> host 级串行指数回退重连`，server 也要用 ws heartbeat 回收僵尸 socket
- [2026-04-19] session picker 的多选不能只靠整行高亮，必须给明确 checkbox；输入 IP 后要显式展示 bridge 测试/刷新状态、最后刷新时间和自动轮询说明，否则用户无法判断 tmux 列表是否已实时刷新
- [2026-04-19] terminal 若通过 DOM prepend 新增 scrollback 行，在“用户已离开底部”场景必须同步修正 scrollTop 锚点；否则继续输出后再回滚会出现 buffer 丢失/跳页错觉
- [2026-04-19] mobile 端不要额外开启本地 blink cursor；应只消费 bridge/buffer 提供的 cursor 位置，避免布局和字体变化时 cursor 视觉错位
- [2026-04-19] 若 terminal cursor 要忠实镜像 tmux，remote `CellData` 必须带 `width(0 continuation / 1 single / 2 double)`；client 只能按远程 cell truth 渲染，不能再按本地字符宽度猜 cursor 位置
- [2026-04-19] 多 tab terminal 不能只保留一个 active TerminalView 再靠 `outputHistory` 重放；每个 session 必须常驻自己的本地 terminal buffer，否则 tab 切换会丢 tmux 当前输入态并引发 cursor 错位
- [2026-04-19] terminal 持久化缓存不能只拼 raw output chunk；需要从本地 terminal buffer 抽取按行快照（scrollback + 当前 grid），这样不同排版/刷新路径才不会错乱
- [2026-04-19] Android 输入法真源应切到原生 `EditText` anchor：TerminalView 不再在 Android 主动 focus DOM textarea，键盘按钮只触发原生 IME；否则 WebView/textarea 会和原生输入连接抢焦点，导致输入法弹出后又被取消
- [2026-04-19] Android 上“上下滑一下整页 reload”要双层封口：前端 `html/body/#root` 关闭 body scroll + overscroll，原生 `MainActivity` 再把 Capacitor WebView `OVER_SCROLL_NEVER`；只靠 CSS 容易漏掉 WebView 级回弹/下拉刷新
- [2026-04-19] 快捷栏新增浮动按钮时必须先做占位避让，再做视觉强化；否则会遮住常驻按键。若入口要求长按拖动，仍要保留普通点击切换，拖动手势不能抢掉原有点击语义。
- [2026-04-19] terminal scrollback 不能再用“数组位置”当唯一身份；prepend/append/backfill 后 React key 会错位，必须带远程 scrollback 起始序号，按绝对序号合并/渲染，才能避免切 tab 时半屏旧半屏新。
- [2026-04-19] 真机发热排查先关掉运行态 debug overlay / 高频 setState；移动端 terminal 的调试指标必须按需开关，不能默认常驻。
- [2026-04-19] daemon buffer 真源按 tmux session mirror 维护：ws/tab 只是客户端壳，detach/reattach 不应重建 authoritative buffer，直到 tmux session 真正关闭。
- [2026-04-20] terminal 单指手势需要 axis lock：纵向滚动必须在确认纵向手势时重取当前 `scrollTop` 作为锚点，横向手势再切 tab；否则手指上滑会从旧锚点起跳，体验像“不是从当前底部开始滚”。
- [2026-04-20] 多 tab 的 hidden terminal 不能在后台继续按 `bufferUpdateKind` 推导 scroll 锚点；切回 active 时只允许两种恢复：原本贴底就贴底，原本看历史就恢复之前的 `scrollTop`。同时，scrollback/viewport 真源只能取 `remoteSnapshot`，不能再从 `bufferLines` 反推。
- [2026-04-20] 多 tab 左右跟手切换的真源应放在 `TerminalCanvas`：由 canvas 同时渲染 active + 相邻 tab，按手势 delta 做 translate，手指离开后再根据半屏阈值决定完成切换或回弹；`TerminalView` 只上报横向手势，不直接切 tab。
- [2026-04-20] mobile 发热要优先区分网络 vs CPU/IO：若流量不大但 `Chrome_IOThread` / `RenderThread` 高，占优先级最高的真源通常是“空 viewport 刷包”或“每帧 localStorage 持久化大 buffer”
- [2026-04-20] websocket reconnect / 首次 connect 完成后，active tab 必须立即恢复 **head-first** 主循环：先 `buffer-head-request`，再按本地 sparse buffer 状态决定 diff / 三屏重锚 / reading gap repair；不要再依赖第二套 active/idle 语义
- [2026-04-20] terminal 手势滚动锁应是 latch：一旦进入历史阅读态，直到真实输入发生前都不应自动恢复 bottom-follow；“滚回底部”本身不等于解锁
- [2026-04-20] scrollback 的 startIndex 必须是 mirror 生命周期内单调递增的绝对行号；client 只能持有一个连续区间，merge 出现 gap 时要丢弃断裂前缀，只保留最新连续尾段，再靠 backfill 补历史，不能把稀疏索引压成连续数组
- [2026-04-20] Connections 里的 remembered session group 真源必须按 `bridgeHost + bridgePort` 归并成“每台服务器一份选择”，不能再按“某次打开时的 session 组合”累积历史；否则会出现旧筛选残留、history-only group 无法编辑/删除
- [2026-04-20] repo 拆分边界初判：mobile 应用层应独立成 app repo；必须保留到 wterm fork 的只有 runtime 真源改动（如 `cell.width` / 宽字符渲染 / CSS 语义），其余页面/会话/存储/daemon 逻辑应留在 app 层
- [2026-04-20] `android/evidence/` 是本地证据仓，不应把整批历史截图/日志直接推到 GitHub 主线；Git 中只保留 `README.md` 说明目录与取证规则
- [2026-04-20] 跨尺寸布局真源必须统一成**一个 layout profile + pane stage**：phone / tablet / foldable / split-screen / future Mac 共用同一编排决策，页面语义不随平台分叉
- [2026-04-20] Jason 补充冻结：大屏统一效果默认应是一行多列、列与列之间垂直分屏；不要把上下堆叠多 pane 当成主方案。future Mac 也沿同一单行多列编排复用 shared app-layer
- [2026-04-23] terminal 新真源落地时，server 不能再按 client active/idle 状态主动 push buffer；唯一对外职责应收敛成 **显式 `buffer-head-request` / `buffer-sync-request` contract**，client 是否拉取由自己的 buffer worker 决策，consumer 不得把消费状态写回 producer 当长期真相。
- [2026-04-23] Android renderer 若继续暴露 `onViewportPrefetch / followViewportNonce` 这类 transport-aware 接口，会把 renderer 和 buffer worker 再次耦合回去；renderer 只保留窗口声明与 UI reset 信号，prefetch/range repair 必须留在 worker。
- [2026-04-23] Android SessionContext 若同时保留 `sendTailBootstrapBufferSyncRequest / sendFollowRefreshBufferSyncRequest / refreshSessionTail` 三套近似入口，会继续把 sync 策略散成多真源；应先合并成单一 `requestSessionBufferSync` + 单一 viewport reset 入口，再继续拆 worker/renderer。
- [2026-04-23] Terminal renderer 的 follow/read 不能只拿 DOM `scrollTop` 去纯推导：真实 DOM bottom 会短时小于逻辑 tail，导致 active follow 误判成 reading。正确边界是：buffer/render 真源仍分离，但 renderer 允许保留一个**最小 UI reading latch** 来表达“用户是否正在读历史”。
- [2026-04-20] 当 Mac 需要移植 Android 连接配置流时，优先下沉纯逻辑到 `packages/shared/connection/*` 与 `packages/shared/react/*`（Host / BridgeSettings / tmux discovery / localStorage hook），而不是在桌面端复制一套 ad hoc 表单/存储实现
- [2026-04-20] tmux session discovery 不是 live connect：桌面端如果只做 `list-sessions`，用户会看到“能找到 session 但连不上”。真正连接必须显式复用 Android 的 websocket 协议：`open ws -> send connect(payload) -> 进入 head-first loop`
- [2026-04-20] 若 `bridgeHost` 已是显式 `ws://host:port` / `wss://host:port`，shared truth 必须把这个显式 endpoint 当成 display/preset key/store port 的真源；不要再额外拼接独立 `bridgePort`，否则会制造双端口假象并污染 remembered server key
- [2026-04-20] endpoint 归一不能只修 Mac；Android 的 `bridge-settings / bridge-url / connection-target / storage hooks / Connection Properties` 也要直接复用同一个 shared truth，否则桌面和移动端会再次在显式 `ws://host:port` 场景下分叉
- [2026-04-21] Jason 明确认可当前快捷栏/按钮视觉方向：后续 mobile UI 默认沿用“简洁、闭合、分区明确”的 capsule/block 设计语言——低噪声配色、清晰边界、成组区域、按钮闭合感优先；新增页面/组件若无特殊原因，应沿这个方向统一
- [2026-04-21] 升级验证流程冻结：首次装机可用 ADB，但后续新版本默认必须走 app 内建升级链路验证（manifest -> 提示 -> 下载 -> 校验 -> 系统安装）；除非 Jason 明确要求，不再用 ADB 直接覆盖新版本
- [2026-04-21] tmux pane 真源校验：`display-message '#{history_size}'` 返回的就是 `capture-pane -S -... -E -1` 可见总行数，不要再额外 `+ pane_height`；否则 absolute index 会整体偏移，导致 viewport/buffer 拼接错位
- [2026-04-22] Jason 冻结新的 terminal render 真源：client 不再让 daemon viewport 参与最终画面决策；render 只保留绝对窗口 `[renderTopIndex, renderTopIndex + viewportRows)`，follow bottom=`availableEndIndex - viewportRows`，缺失行一律显式 blank。
- [2026-04-22] terminal 底部被吃行时先查 UI 双重扣减：若 `TerminalCanvas` 已经处在 quick bar 上方剩余高度内，就不能再把 `quickBarHeight` 作为 `visualBottomInset/paddingBottom` 传给 `TerminalView`，否则会稳定少掉尾部几行。
- [2026-04-22] Jason 冻结键盘规则：无论软键盘/输入法是否弹出，terminal 显示高度都不跟着改；只允许做 UI 视觉上抬，禁止把 keyboard inset 回灌成 terminal 高度变化、tmux resize 或 buffer/render window 高度变化。
- [2026-04-22] daemon 安装/重启前先清理 legacy `com.wterm.mobile.daemon`，并用 `ThrottleInterval` 限流；否则 launchd 会在端口冲突时持续重拉服务，放大系统负担。
- [2026-04-22] canonical bottom 必须按 `availableEndIndex` 算，不允许再被本地 slice 的 `endIndex` 截短；否则 follow 会假装已经到底，实则还差尾巴。
- [2026-04-22] tab/session 隔离门禁：Terminal callback（input / resize / viewport / focus）必须显式携带 `sessionId`，禁止在 App 层按 `activeSession` 隐式路由；tab 切换只允许改变 active/render 频率，不允许 remount 单一 TerminalView 去复用别的 session 状态。
- [2026-04-22] buffer-sync 新冻结：hidden tab 完全冻结，不收 live buffer；active tab 默认只追当前尾屏并按绝对行号连续门禁渲染，若当前/预校验窗口不连续则保持上一帧并触发补拉；只有 reading 且断裂时才向前预拉两屏高度。
- [2026-04-22] 新根因补充：follow 态若把每次 `viewportEndIndex` 推进都回发成新的 `buffer-sync-request`，会形成“server 刚推一帧 -> client 立刻再拉一帧”的请求风暴；follow 请求只应在 connect/switch/input/resize/模式切换时刷新，active live payload 默认只发 changed-range，不拼整屏 viewport。
- [2026-04-22] session 定时发送 / heartbeat 的唯一真源必须在 daemon：job 绑定 tmux `sessionName`，daemon 负责持久化、nextFireAt 和实际发送；Android / Mac 只做 calendar + alarm 风格编辑器，不允许各自维护本地调度器。
- [2026-04-22] daemon 若要复用 `packages/shared`，不能从 `@zterm/shared` 根入口 import；根入口会带上 React/CSS，Node 运行态会直接 SyntaxError。server 侧必须只 import 叶子 shared 模块（如 `schedule/next-fire.ts`）。
- [2026-04-23] schedule UI 若只消费定时规则/格式化函数，也应优先 import `packages/shared/src/schedule/*` 叶子模块；否则会把 `@zterm/shared` 根入口的 terminal-view/CSS 依赖链进来，污染静态渲染与 Node 工具链。
- [2026-04-23] session schedule 的最小真实闭环证据可以做成“临时 daemon + 临时 HOME + tmux session + websocket 协议 smoke + tmux side-effect 文件 + schedules.json 持久化”组合；相比只看 `schedule-event(triggered)`，这样能同时证明协议、执行和落盘都是真的。
- [2026-04-23] Android quick input/floating panel 若渲染在被 `transform` 抬起的 quick bar 容器下，fixed overlay/bubble/panel 不能再额外按 `keyboardInset` 计算 bottom/padding；否则会出现“输入法一弹出，面板被抬到屏幕外”的双重位移。
- [2026-04-23] 快捷按键组合算法若同时被 Android / Mac 消费，必须下沉为 shared 纯函数（组合编码、序列反解、默认 label）；平台侧只维护 token 编辑与展示，不能复制 `Ctrl + 字母` 等规则。
- [2026-04-23] foreground 恢复不要无差别重连所有 session；应先恢复 active session，其他 session 仅在本身非健康时补拉，否则 hidden tabs 也会被一并唤醒，徒增带宽且拖慢当前 tab 恢复。
- [2026-04-23] 同 host 多 session 的统一 foreground reconnect 若仍保留串行 bucket，必须先重连 active session；否则当前 tab 会被隐藏 tab 的重连排队拖住，表现成“回前台后当前页假死”。
- [2026-04-23] reconnect 成功后的 client 不能只等待服务端 live flush；应立即补一条 tail refresh request，否则 session 会先显示 `connected` 但本地 buffer 仍停在旧 revision，造成“假连接、不更新”。但 **hidden->active / foreground refresh** 不能无脑 bootstrap 整个 tail：若本地尾窗连续，应发送带本地 `revision + local window` 的 follow request；只有本地尾窗缺口/空 buffer 才 bootstrap。与此同时应补一发 `ping` + 短超时 watchdog，避免“激活了 tab 但没渲染也不重连”。
- [2026-04-23] active + follow tab 还需要保留一个低频 tail probe（follow `buffer-sync-request` + `ping` + 短 watchdog）作为 observer 漏通知的自愈链路；否则 daemon 没再主动推时，客户端会误以为“没有新尾行”，表现成只有用户输入/切 tab 后才刷新。
- [2026-04-23] runtime 远程排障真源应放在 daemon HTTP：client 只上送 bounded runtime debug entries，daemon 统一缓存并通过 `/debug/runtime` + `/debug/runtime/logs` 暴露 session/mirror 快照与最近日志；接口复用 daemon auth token，方便服务器端直接拉现场证据。
- [2026-04-23] foreground/active refresh 不能只把 SessionContext 的 sync view 改成 `follow`；`TerminalView` 自己的 `followMode/scrollTop` 也必须收到显式 reset nonce。否则会出现“恢复后展示的是旧 scroll 位置的老 buffer，只有用户输入触发 `forceFollowViewport()` 才跳到最新”的假刷新/假黑屏。
- [2026-04-23] active tab 的 terminal render 不允许在 visible/precheck window 有 gap 时继续复用上一帧；当前三屏窗口可以不连续，UI 应立即渲染最新 tail + gap marker，再对窗口内 missing ranges 发稀疏 prefetch。
- [2026-04-23] follow 态的 gap repair 真源是“当前三屏窗口内 missing ranges”，不是“从旧 stop point 连续追到最新”；active 页只补当前窗口命中的缺口，hidden/窗口外内容允许继续缺失，以控制带宽。
- [2026-04-23] terminal 主题真源要覆盖默认前景/背景 + ANSI 16 色，而不是只改背景色；theme choice 应持久化到 shared `BridgeSettings.terminalThemeId`，Settings 只负责切换 preset。
- [2026-04-23] Android / Mac 共用 terminal theme 时，preset 与颜色算法必须下沉到 shared 纯模块（如 `packages/shared/src/terminal/theme.ts`）；平台各自只消费 preset，禁止复制第二套 ANSI 映射表。
- [2026-04-23] Settings 若把 terminal theme 卡片显示成“正在使用/Active”，该点击动作就必须立即持久化到真实 `BridgeSettings.terminalThemeId`；不能只改页面 draft 再等 Save，否则切页回来会回默认主题，制造“已生效”的假状态。
- [2026-04-24] reading 滚到缓存顶部时，3 屏只是 cache window，不是滚动上限；client 要预取前两屏并显示 loading，补齐后再继续上滚，不能把顶部写死成停住
- [2026-04-24] 手势滚动要跟手，不要靠固定步长/固定屏数硬跳；buffer 回补是边界处理，不是主滚动方式
- [2026-04-23] Android 快捷输入面板的 outside-close 要走 document capture 级监听；仅靠面板外遮罩 click，在 quick bar 根节点有 pointer capture / preventDefault 时并不稳定。
- [2026-04-23] session 级定时发送入口不能挂在 tab strip/header 这种易被理解成“tab 全局动作”的位置；Android 侧应放在当前 session 的 quick input/composer 入口内，明确“对当前 session 生效”。
- [2026-04-23] 悬浮球若保存的是绝对 `left/top` 坐标，必须在 mount 和 viewport resize 时自动 re-clamp 到当前可视区；只在拖动时 clamp 会导致旋转/窗口变化后入口消失。
- [2026-04-23] 悬浮菜单与底部 shell rows 必须分层：菜单打开时可隐藏 rows，但关闭后要立刻恢复；keyboard 弹起时只上抬 rows，不要让悬浮球/菜单复用同一 transform。
- [2026-04-23] 悬浮菜单里的快捷输入列表点击语义是“立即发送并默认补 `\\r`”，不要再走“追加到 draft 再手动发送”；只有剪贴板条目才做 draft 注入。
- [2026-04-23] terminal follow 若在每次 buffer/input 事件里立刻 `host.scrollTop = bottom`，会和 onScroll / viewport emit 形成双向拉扯；要改成 rAF cadence 单向贴底，并忽略程序化 scroll 触发的 onScroll，底部才不会抖。
- [2026-04-23] terminal 顶部 tab strip 若无键盘导航需求，不要留下浏览器默认 focus ring；`tabIndex=-1 + blur + outline none` 是移动端更稳的默认态。
- [2026-04-23] 拖拽排序 UI 若在 `pointerMove` 里更新 React state、在 `pointerUp` 里立刻提交，不能只依赖 state 闭包值；必须维护一个同步 ref 作为 drag 真源，否则 release 可能读到旧 targetIndex，表现为“拖了但顺序没生效”。
- [2026-04-23] drag target 计算不能把正在拖的那一行自己也纳入候选；否则命中会持续偏向自身行，排序目标几乎不会变化。
- [2026-04-23] keyboard 关闭态不能在 quick bar 外层保留 `transform: translateY(0)`；这会让其内部 `position: fixed` 悬浮层脱离视口坐标系，直接把悬浮球/快捷面板的位置算坏。
- [2026-04-23] 快捷按键编辑器的“显示名称”若自动写入第一个 token（例如先点 `Ctrl` 就写成 `Ctrl`），会把组合键默认名污染掉；组合键的默认显示名必须来自最终 `preview`（如 `Ctrl + C`），不是来自首个 token。
- [2026-04-23] Jason 冻结新的 terminal 真源：server 按 session 只做 **30Hz head 广播 + range request 响应**，不主动 push buffer 内容；client 侧拆成 sparse buffer worker / renderer container / UI shell 三层，consumer 不得改 source。
- [2026-04-23] client buffer 真源必须允许不连续：follow 默认维护尾部 3 屏热区，reading 只在 renderer 当前窗口缺失时补缺；hidden tab 只收 head，不拉 range，不补缺口。
- [2026-04-23] `TerminalView` 里凡是 active/reset/layout/audit 都会触发的 follow 贴底动作，必须收成单一 helper，再配合纯的 scroll->mode 判定 helper；否则同一 follow 真相会在多个 effect 中分叉，后续修一个入口很容易漏另一个入口。
- [2026-04-23] client viewport worker 若已进入某个 reading window，就不要对完全相同的 viewport 再排队第二次 range request；同一 session 一旦回到 follow，必须同步清理之前排队的 reading sync，避免 stale request 白打到 daemon。
- [2026-04-23] `active tab switch` 和 `follow reset` 若都要构造 follow viewport state / bootstrap 判定，必须复用同一 helper；否则 follow rows/endIndex/cache window 很容易在两个入口长歪成两套语义。
- [2026-04-23] `connectSession` 与 reconnect bucket 可以共享 socket 握手、heartbeat、公共 server message 分发，但 `connected` 成功后的状态推进仍要保留各自分支：普通 connect 不该偷偷带入 reconnect bucket 的 side effect。
- [2026-04-23] connect / reconnect 的 `connected` 成功后若有一大段完全相同的 baseline 动作（写 connected 状态、schedule-list、active bootstrap、watchdog、connectedCount），应先收成公共 helper，再把 bucket reset / queue drain 这类额外 side effect 挂在外层。
- [2026-04-23] connect / reconnect 的 `finalizeFailure` 也应按同样方式拆：完成位、cleanup、schedule error、manual-close 终止属于公共 baseline；retry、bucket attempt、pending requeue 属于外层专属语义。
- [2026-04-23] `TerminalView` 缩 effect 面时，先抽 `viewport refresh schedule` / `current viewport emit` 这类无语义 helper；不要一上来强行合并 effect，先把重复动作单点化再说。
- [2026-04-23] `TerminalView` 里 reading viewport emit 若会在‘prepend 历史后重锚’与‘reading near edge 补拉提示’两处重复出现，也先抽本地 helper；renderer 收口优先顺序仍是动作单点化 > effect 合并。
- [2026-04-23] `TerminalView` 再往下收时，follow reset、prepend 历史锚定、near-edge reading emit 这类 viewport action 也应先名字化成 helper；名字化后更容易看出哪些 effect 只是调度层、哪些才是状态层。
- [2026-04-23] 当 `TerminalView` 里两个 effect 只是在分别守 `becameActive` 与 `viewportResetNonce` 这两种 follow reset 信号时，可以合并成一个 reset effect；前提是 session 切换时初始化 ref 的语义不变。
- [2026-04-24] `TerminalView` 里若‘当前 viewport emit’与‘reading near-edge emit’只是同一渲染阶段里的两次 emit，可合并成一个 effect，前提是 `emitViewportState` 自身已有稳定的 dedupe key。
- [2026-04-24] `TerminalView` 的 viewport refresh 调度若会被 layout/session 两类 effect 复用，就把 `sync + optional follow align` 收成单一动作，并在执行时再读取当前 reading/follow latch；不要让 scheduler callback 直接依赖 followMode，否则用户一滚动就会把无关 refresh effect 全部重新挂载。
- [2026-04-24] `TerminalView` 的“session 初始化/重置”effect 不能依赖 `authoritativeViewportEndIndex` 这类 live head；它只能由 `sessionId` 或显式 `followResetToken` 驱动，否则 reading 态会在每次尾部推进时被误重置到 follow。
- [2026-04-24] `ResizeObserver` 也是 viewport refresh 链的一部分，不要单独直连 `syncViewport()`；它应复用同一 `runViewportRefresh()` 动作，这样 real resize、layout nonce、session refresh、follow audit 才不会长成四套 refresh 口径。
- [2026-04-24] `layout refresh` 与 `session refresh` 若最终都只是“判定是否触发 refresh + 选择 timeout”，可以合并成单一 trigger effect；但 `becameActive / sessionChanged / layoutChanged` 仍要显式保留，不能为了少一个 effect 抹掉触发来源。
- [2026-04-24] 当 `TerminalView` 里剩下的 effect 已不再只是调度，而是承担 `prepend 历史后的 reading 锚定`、`当前帧 viewport signal` 这种状态语义时，先把 effect 内动作名字化，再让 effect 只做 trigger/state bridge；不要为了“继续减少 effect 数量”硬把状态语义揉坏。
- [2026-04-24] `TerminalView` / `TerminalPage` / `SessionContext` 若都在内联同一份 viewport/resize schema，应下沉到 `android/src/lib/types.ts` 做接口真源；这样后续再改 viewport 字段时，不会一边改 context 一边漏掉 renderer/test。
- [2026-04-24] renderer prop 面也要按“真实输入”审计：如果某个字段只剩作为 dependency 占位，而不再参与渲染/输入/状态语义，就应从 prop 面移除；`bufferRevision` 就是这种可以安全删除的残留。
- [2026-04-24] renderer trigger 命名也要按真实语义收口：如果 token 的作用是“把 terminal 拉回 follow”，renderer API 应直接叫 `followResetToken`；不要继续把 worker 内部的 `viewportResetNonce` 原样泄漏到 renderer prop 面。
- [2026-04-24] 若 worker/store 内部的旧命名只剩少量闭合传播点，不要长期保留 page 层映射；直接把 `viewportResetNonce` 一并统一成 `followResetToken`，让 worker/page/renderer 共用同一语义名。
- [2026-04-24] `SessionContext` 里 request payload builder 也要按“唯一构造点”收口：如果 bootstrap 只是普通 request 的少量字段覆盖，就改成单一 `buildSessionBufferSyncRequestPayload()`，不要长期并存两份 builder。
- [2026-04-24] `updateSessionViewport()` 这类 worker 入口若同时在做 normalize、判等、调度请求，后面很容易再长分叉；应把这三层拆成 helper，让入口函数只做“写状态 + 触发 demand”。
- [2026-04-24] active session 的“输入后刷新”不能靠本地回显，也不能完全被动等下一次 head；正确口径是 `sendInput()` 只发 input，同时挂 `input-tail-refresh` demand，由 client 本地 30fps head tick 在网络分级门限内主动打一条 follow `buffer-sync-request + ping`。
- [2026-04-24] “本地 30fps 刷新 head”不等于 30fps 拉 range：固定 `33ms` tick 只做 head freshness / demand 判定；真正 range 请求频率要由网络状况和配置决定（如 `minTailRefreshGapMs`、reading delay），否则又会退化成请求风暴。
- [2026-04-26] mobile-15 首屏慢的已验证根因之一：restore / foreground resume 若把 hidden tabs 一起 eager reconnect，会把 active tab 首刷排队拖死；transport gate 必须保证 cold-start / resume 时 **只允许 active tab eager connect / poke**，hidden tabs 仅在显式激活时再 reconnect，除非后续有被证实正确的 hidden low-frequency 设计。
- [2026-04-26] mobile-15 本轮收口确认：server 不再主动 push `buffer-head`，renderer 不再上送 `missingRanges` / prefetch 规划，reading gap repair 只由 buffer worker 基于本地 sparse buffer 计算；IME/layout nonce 也不得再回灌 renderer refresh。

## Patterns & Learnings

- 先定真源，再写代码，能减少反复返工
- 证据和任务分开，能避免“完成感”替代验证
- skill 应该像门禁，不像日志
- mobile 项目先冻结流程真源，再进入实现，能防止浏览器通过但 APK 未闭环的反复问题
- UI 任务先对齐信息结构与交互结构，再做视觉细节，能减少返工
- connection 入口、编辑页、终端页要拆成三条 UI 主线分别落地，避免“一个页面兼做所有事”的混乱结构
- 页面级重构时，优先把当前组件拆到 page/component ownership，再补功能细节
- 卡片上半区和下半区不能复用同一句摘要；preview 缺失时必须单独处理，否则会制造“重复显示”的错觉
- tmux bridge 输入闭环可用 `cat -v` 做最小真相验证：方向键应显示 `^[[A` 类序列，Esc 显示 `^[`，自定义组合键显示对应控制字符/文本
- daemon CLI 重启验证不能只看 `tmux has-session` / `daemon status`；还要补 `nc` 或实际 WebSocket probe，确认 socket 已真正开始监听
- scrollback 若依赖 DOM prepend/trim 历史行，必须在非底部阅读状态保 scrollTop 锚点，否则终端持续输出时会破坏回滚阅读体验
- cursor 文本切分必须按 cell/code point，而不是按 UTF-16 code unit；否则 emoji/astral 字符会把 cursor 切裂
- 多 tab terminal 的恢复真源应该是“每 tab 常驻 buffer + 本地按行 snapshot”，不是“切 tab 后 clear 再 replay 历史字符串”
- Android 软键盘问题优先排查“谁在抢 input focus”：先看 WebView / DOM textarea / native EditText 三者谁持有焦点，再决定是否改插件；只加 `showSoftInput()` 而不切断 DOM focus 往往无效
- Android WebView 的整页回弹不要只在终端容器上修；要把 body/root/WebView 三层都关掉，把滚动权限只留给 terminal buffer 容器
- 终端发热先查运行态 debug overlay / 高频 metrics setState / console spam；这些比布局本身更容易在手机上造成明显发热
- terminal 持久化不要把 `remoteSnapshot` / `outputHistory` 这种高频变化大对象每帧写进 localStorage；恢复态优先保留按行 `bufferLines`，真正的 viewport/cursor 靠 reconnect 后服务端刷新
- Electron 打包壳与交互验证要分层：`.app` 负责验证 build/package/window 可执行；细粒度表单交互更适合走浏览器 dev server（同一 renderer 代码），再回到 `.app` 验证桌面壳仍可启动
- [2026-05-03] 源码树污染冻结：`android/src/`、`packages/shared/src/`、`android/vite.config.js` 不允许出现由 TS/JSX 生成的 `.js` 产物；真源只允许 `.ts/.tsx`。已新增 `android/scripts/check-no-source-js-pollution.mjs` 并接入 `android/package.json -> type-check`。后续一旦再有 `.js` sibling 写回源码树，直接视为构建/工具链违规。
- [2026-05-04] transport stale gate 要覆盖**写侧 request**，不只覆盖 `ws.onmessage/onclose/onerror/onopen`。`buffer-head-request` / `buffer-sync-request` 若接受外部 `ws` override，必须先校验它仍等于 `readSessionTransportSocket(sessionId)`；旧 superseded socket 即使只是晚到触发 request，也会把当前 session transport 真相重新污染。
- [2026-05-06] traversal relay 产品化真源冻结：用户不应再手填 `signalUrl / turnServerUrl / turnUsername / turnCredential`。客户端唯一协议真源应是登录控制面后得到的 `relayBaseUrl + ws(devices/host/client) + turn + accessToken + device metadata`；UI 只暴露 relay 登录和 device list，不暴露协议细节。
- [2026-05-06] relay 控制面接线若要真正走 RTC relay，client target 真源必须带 `relayHostId`；`ws/client` 不是普通 signal server，而是按 `hostId` 路由到在线 daemon host。只下发 `wsClientUrl` 不带 `hostId` 仍然无法连到指定 daemon。
- [2026-05-06] transport 自动模式真源再次冻结：**只允许固定顺序** `Tailscale -> IPv6 -> IPv4 -> Relay`。这不是“fallback 系统”，只是单一连接策略；禁止再长出额外 transport 状态机、补偿分叉或第二顺序语义。

- [2026-05-09] input 丢失根因冻结：`sendInputThroughSessionTransport` 中 `hasPendingSessionTransportOpen` 为 true 时原直接 return，input 静默丢失。修复：新增 `pendingInputQueueRef` (Map<string, string[]>) 队列机制，transport pending 时入队，transport ready 后在 `finalizeSocketConnectionBaseline` 中 flush。flush 失败（ws 非 OPEN）时队列已被 delete，不产生内存泄漏。
- [2026-05-09] multi-pane 优化真源冻结：(1) `resolveStaticPaneLayout` 在 orientation change 时冻结 `baselineHeightPx`，`currentMaxSplitCount` 不再依赖 viewportHeight/IME；(2) sync debounce 33ms 防重复请求风暴，`handleBufferHeadRuntime` 收到 fresh head 时必须清除 debounce 状态否则会阻塞后续 tail entry；(3) 所有可见 pane 的 TerminalView 均 `live=true`；(4) split landscape 新增 `shellMode: floating-collapsed` 折叠快捷栏。
- [2026-05-09] 构建版本元数据门禁：`update-dist/latest.json` 的 `versionName / versionCode / buildNumber / apkUrl / sha256` 必须与 `android/.build-meta.json` 和 `android/release-dist/latest.json` 保持一致。曾出现 `undefined.1001` 错误版本，根因是构建脚本在 versionName 解析失败时回退到硬编码默认值。
- [2026-05-09] CACHE.md 体积膨胀门禁：CACHE.md 已被加入 .gitignore；项目级 CACHE.md 不应提交到 git。对话缓存只在本地保留，超过合理大小应定期清理。
- [2026-05-13] open-tab runtime switch 语义必须冻结成两类且只能在 App 层唯一桥接：`restore-sync` 只切 runtime active，不开 transport；`explicit-resume` 才允许桥接到 `resumeActiveSessionTransport`。若继续用单个布尔 `switchRuntime` 混写两类语义，会重演“cold restore 首帧误连”与“用户显式激活却不开 transport”这两种互相冲突的 bug。
- [2026-05-13] foreground refresh 的 transport 恢复真源只能留在 `SessionContext -> ensureActiveSessionFresh / buildActiveSessionRefreshPlan`；App 层旧的 `performForegroundRefresh` 若已不接运行态，必须物理删除，避免再长出第二套前台恢复语义。
- [2026-05-13] foreground false->true 不能只靠 `appForegroundActive=true` 加 active tick 被动兜底；`SessionContext lifecycle` 必须拥有唯一 `active-resume` 入口，并且对当前 active session 立刻执行 `ensureActiveSessionFresh({ source:'active-resume', forceHead:true, markResumeTail:true, allowReconnectIfUnavailable:true })`。
- [2026-05-13] reconnect gate 不能把 `timer pending` 和 `connecting ghost` 混成一个布尔 `reconnectInFlight`。若现场出现 `sessionState=reconnecting + ws=null + no pending open intent`，这不是“还在连”，而是 **stale reconnect bookkeeping**；foreground/explicit refresh 必须允许直接重启 reconnect，否则会被 `transport-unavailable` 永久卡死。
- [2026-05-13] 已验证的 tmux 高度真因：当前 `adaptive-phone` daemon 实现若走 `resize-window -x`，tmux 会自动把该 window 切到 `window-size=manual`；此后即使后续 client 更高，window/pane rows 也不会自动恢复，直到显式切回 `window-size=latest`。所以“代码没写 rows，但 session 高度一直很矮”仍然是**当前代码路径通过 tmux manual 语义间接冻高**，不是单纯历史残留。已补真实 tmux PTY 回归 `src/server/tmux-window-size-semantics.test.ts`。
- [2026-05-22] renderer 不能订阅 `SessionHeadStore`，也不能用 `daemonHeadEndIndex` 推进 follow viewport demand；daemon head 是 buffer manager/planner 的输入，renderer 的唯一内容进度真相是 buffer manager 已提交的 local render buffer tail。若 UI 层保留 `sessionHeadStore` prop 或测试里继续注入 head store，就是重复实现，必须物理移除。
- [2026-05-22] 输入路径不能把 `WebSocket.OPEN` 当作可写真相；若 activity audit 已判定 stale-open，继续 `send` 会把输入留在系统/WebSocket 缓冲，几十秒后才到 daemon，表现为“输入缓存”。唯一正确策略是：stale-open input 不发送、不排队，显式 drop 并仅重连目标 session；健康 open transport 才允许写入。
- [2026-05-22] 多 pane 唯一真源冻结：split 按钮显示条件为 `viewportWidth > baselineHeightPx * 0.7`；最大分屏数按平均分屏后单 pane 接近手机竖屏 `width / height ~= 0.42` 计算，容量算法唯一真源是 `resolveMaxSplitCount = floor(width / (baselineHeight * targetRatio))`。旧 `0.22/0.2` 宽松 minAspect、`>0.5` 阈值和 1200x900 只能二分屏期望都是过期实现，必须删除测试/实现残留。visible pane 各自 `live=true` 独立刷新；Android IME 输入只跟 `interactiveSession`/焦点 pane，不跟 runtime old active session；新建 tab 必须带显式 `paneId` 并只 attach 到目标 pane，缺失 paneId/目标 pane 不存在必须拒绝，禁止 fallback 到 active/P1。
- [2026-05-22] 横屏 QuickBar 被裁/消失的唯一根因：viewport stable height 不能跨 orientation 共享。单个 monotonic `maxStableLayoutHeightPx` 会把竖屏高度带到横屏，导致 `TerminalPage.shellHeight` 远大于真实横屏 viewport，absolute bottom QuickBar 被放到可视区外。稳定高度必须按 `portrait/landscape` 独立维护；IME 防抖只允许在同一 orientation 内保留最大 layout height。
- [2026-05-22] 多 pane 容器高度是真源：split row 与每个 pane shell 必须显式 `height: 100%`，否则 `TerminalView` 测量错误会连锁导致 visible range、viewport demand、gap repair、滚动和非焦点 pane live 刷新异常。修复必须在 pane layout ownership 层完成，禁止在 daemon/buffer manager/renderer 做 offset 或 refresh 补偿。
- [2026-05-22] QuickBar 内置快捷唯一真源是 `SHORTCUT_PRESETS`；storage 默认值不得再 seed 内置快捷，否则会出现 Paste/+/会计类按钮重复。保存的自定义快捷只作为用户覆盖/新增项，渲染时按 sequence 跨行去重。
- [2026-05-22] split tab 点击必须由 UI shell 同步 pane ownership：Header 只发 session intent，TerminalPage 是唯一桥接点；split 模式下必须先 `findPaneForSession -> switchTabInPane` 更新 pane `activeTabId`，再切全局 active session。只调用 `onSwitchSession` 会造成“tab 点了但 pane 内容不变”。
- [2026-05-22] QuickBar 分屏数量不能只按屏幕容量显示，还必须按当前 session/tab 数封顶；否则两 tab 时会显示不可用的 3 分屏。Android terminal 默认键盘请求属于 TerminalPage UI shell 状态，session 切换/进入页不得把它清成 false。
- [2026-05-22] split header 也必须保留 status-bar touch-safe 顶部保护区；不能为了横屏压缩把 tab 放到系统状态栏下沿。`terminal-layout-profile` 是唯一布局真源，split/default/single 的 header padding 都应在这里统一计算。
- [2026-05-22] QuickBar 横屏利用率真源：折叠态必须由 `TerminalPage` UI shell 持有并影响 `terminalChromeBottomPx`，`TerminalQuickBar` 只负责渲染 inline rows / floating bubble / floating panel。禁止只把按钮视觉隐藏但继续保留底部高度；折叠后 root measured height 应释放为 0，点击贴边小球再展开浮动面板。
- [2026-05-22] 文件同步权限真源：Android app 启动不得在 `MainActivity.onCreate()` 反复拉起存储权限页；文件同步页只检查权限并显式提示。Mac daemon 文件同步权限预检属于 `zterm-daemon.sh install-service`，通过一次性读写 `~/.wterm` 与 `~/Downloads/zterm` 触发/验证权限，后续同步操作不得再隐式申请权限。

## 2026-05-22 QuickBar collapse affordance
- QuickBar 折叠/展开的唯一真源在 `TerminalQuickBar`：展开态只能有一个边角 `收起` 控件，不得放入可滚动工具行；折叠态必须保留右下角小球 `展开快捷栏`，点击直接恢复 inline quick bar。
- [2026-05-23] 多 pane 非焦点刷新唯一真源在 `SessionContext lifecycle` 的 live target tick 门禁：visible pane 进入 `liveSessionIds` 后，即使 connected 且尚无 `lastServerActivityAt`，也必须允许 active tick 请求 head；否则非焦点 pane 会等到点击/激活后才刷新。禁止在 daemon/renderer 做补偿。
- [2026-05-28] Remote screenshot 权限主体唯一真源：macOS TCC 不能由 Node 进程直接触发；安装态必须生成稳定的原生 `zterm-daemon` Mach-O 作为截图主体，Node daemon 只能通过 `ZTERM_DAEMON_NATIVE ... capture-screen` 调用它。`install-service` 只在原生二进制缺失或源码更新时重建，避免每次安装被系统当成新主体反复授权；禁止恢复 helper socket / Codex Mac app / GUI helper 路径。
- [2026-05-28] Remote screenshot 传输保存真源：file-transfer 每个 chunk 是独立 base64，客户端不能直接拼接 chunk 字符串；必须逐 chunk decode 为 bytes，按 chunkIndex 合并 bytes 后重新编码成单一 base64 给 Android Filesystem.writeFile。预览使用 bytes 能成功不代表保存 payload 合法。
- [2026-05-29] `tmux_session_unavailable` 是临时不可用错误，只能走 retryable `onFailure` / reconnect，禁止映射成 `SESSION_STATUS_EVENT(type='closed')`；否则 App 的 remote open-tab audit 会把临时错误放大成 tab prune。只有明确终止语义（如当前 `tmux_session_killed` 分支）才允许进入 closed/tab close 链。

- [2026-05-29] Relay/TURN daemon 配置的唯一交付路径必须是全局发行包：`install-global.sh` 安装 `~/.local/bin/zterm-daemon`，再用 `zterm-daemon configure-relay` 写 `~/.wterm/config.json -> mobile.relay`；daemon 只读取配置，不承担账号/配置 UX。release staging 必须打包 `@roamhq/wrtc` 与当前平台 `@roamhq/wrtc-<platform>-<arch>/wrtc.node`，否则安装态 daemon 会因 RTC native module 缺失无法启动。

- [2026-05-29] `@jsonstudio/zterm-daemon@0.1.1` registry 包已确认缺 native runtime deps 与 `configure-relay`，不能作为全局安装真源；修复版必须用新 npm 版本发布（当前候选 `0.1.2`）。daemon npm tarball verify 必须检查 `runtime/node_modules/node-pty`、`runtime/node_modules/@roamhq/wrtc`、`runtime/node_modules/@roamhq/wrtc-darwin-arm64/wrtc.node` 与 `support/zterm-daemon.sh` 中的 `configure-relay`。

- [2026-05-29] `@jsonstudio/zterm-daemon@0.1.2` 已完成 registry 全局安装闭环验证：Mac Studio 与 MacBook Air 均从 npm registry 安装，使用 `zterm-daemon configure-relay --password-stdin` 配置同一测试账号，relay health 显示 `liveDaemonDevices=2`，两端强制 TURN relay-only RTC 均 data channel open 且 local candidate type=`relay`。最终证据在 `android/evidence/relay-turn/2026-05-29/20260529T042120Z-npm-registry-0.1.2-dual-daemon-rerun/summary.json`。

- 2026-05-29: Relay server first production npm release is `@jsonstudio/zterm-relay-server@0.1.3` (not 0.1.2). `0.1.2` published successfully but public `/relay/health` exposed TURN credential; unique fix was `buildHealthSnapshot -> buildHealthTurnSnapshot()` so public health only reports configured status while authenticated login still returns TURN credentials. Claw runs registry-installed `0.1.3` via `zterm-traversal-relay.service` ExecStart `/root/.nvm/versions/node/v22.22.0/bin/zterm-relay-server`; verified health redaction, smoke login, same-account `mac-studio` + `macbook-air` daemon visibility, and forced relay-only RTC with local candidate type `relay` on both hosts. Evidence: `android/evidence/relay-server-release/2026-05-29/20260529T050200Z-registry-0.1.3-claw-dual-turn-summary.json`.

## 2026-05-29 Connections relay account daemon truth
- Connections 的 server 列表真源是当前 relay account 下的 daemon devices；saved host/history/live session 只能作为该 daemon 的子 session 证据折叠进去，不能反过来用 legacy daemon id 或 bridge endpoint 生成重复父卡片。

## 2026-05-29 Connections group lifecycle and zombie daemon rule
- Relay account daemon 父列表不能展示长期离线且没有任何子 session 证据的 zombie 行；当前规则是 offline + 0 sessions + lastSeen 超过 30 分钟才从 Connections UI 过滤，短暂离线仍保留。Connections group 管理态必须有显式 `Done` 出口，`Clear` 必须同时清 selection 和 expanded state，避免用户长按/展开后卡在管理态。

## 2026-05-31 Relay reconnect optimization

- [2026-05-31] 默认 traversal path priority 已改为 `[ipv6, tailscale, ipv4, rtc-relay]`；user-selected `traversalPathPriority` 仍然最高优先。直连路径（ipv6/tailscale/ipv4）使用 WebSocket，relay 使用 WebRTC。
- [2026-05-31] `TraversalSocket` 已增加 reconnect runtime：`RECONNECT_BASE_DELAY_MS=300`，`RECONNECT_MAX_DELAY_MS=5000`，exponential backoff；成功 open 后重置 attempt，client close 取消 timer。candidate 仍按 priority 顺序重试，从 `nextIndex=0` 重新开始。
- [2026-05-31] `connectTraversalRelayDevicesStream` 已增加 `onOpen`/`onClose` 回调；App 级 relay device stream 有独立 auto-reconnect loop（`300ms → 5000ms` backoff），generation-based cancel，不改 session context。
- [2026-05-31] Direct WebRTC over ipv6/ipv4 当前不实现：`buildTraversalPlan` 的 RTC candidate 仅当 `relaySignalUrl` 存在时生成，且需要 `relayHostId` 做 peer identity；`rtc-bridge.ts` server 仅处理 relay signal websocket 上的 signaling，无 direct peer-to-peer signaling 协议。
- 证据：`android/evidence/relay-reconnect/README.md`

## 2026-06-01 Cross-platform pane/split 真源沉到 shared

- Android 多 pane 的核心算法（workspace state machine / split / activate / move tab / ratio resize / profile token / 触控 vs 指针 gesture）已沉到 `packages/shared/src/{react/pane-profile,react/pane-stage,react/pane-tabs,workspace/workspace-model}`。
- 平台差异隔离在 profile + gesture token，不在 UI 渲染逻辑：
  - `phone`: long-press 唤起 pane-menu、horizontal swipe 切 tab、divider 透明、drag-resize 禁用
  - `tablet`: long-press + right-click 皆支持、drag-resize 启用
  - `desktop`: right-click 唤起 pane-menu、ctrl+pageup/pagedown 切 tab、divider 可见 + drag handle
- `workspace-model` 新增 `setActivePane / resizePaneRatio`；`addPaneToWorkspace / removePaneFromWorkspace / moveTabBetweenPanes / setActivePane` 同源同住，pane 状态机不再有第二套实现。
- Android 端 `android/src/lib/terminal-layout-profile.ts` 仍保留作 phone-only 短期桥；后续切片把 `TerminalHeader` / `TerminalPageStageShell` 切到 shared `PaneTabs` / `PaneStage`（mobileTheme token 通过 render prop 注入或新建 android `pane-theme-adapter`）。
- Mac 端 `MacAppShell` / `ShellWorkspace` 后续切片切到 shared `PaneStage` + `PaneTabs`，可直接使用 desktop profile。
- shared 验证基线：26 test files / 235 tests pass（pre-existing 27 个 harness 错与本切片无关）。

## 2026-06-01 Mac-2 PaneStage/PaneTabs 接入 MacAppShell

- `mac/src/app/workbench.ts` 升级为 `WorkspaceState<MacWorkbenchTab>`，pane 状态机改走 shared `addPaneToWorkspace / removePaneFromWorkspace / moveTabBetweenPanes / setActivePane / resizePaneRatio`，旧 `tabs[]/activeTabId` flat 结构废弃。
- `mac/src/app/MacAppShell.tsx` 切到 `PaneStage` + `PaneTabs` 真源，desktop profile 走 `resolvePaneProfile({ platform: 'desktop' })`；新增 `MacPaneWorkbench` 组件承载 pane 内 tab 行 + terminal surface。
- `packages/shared/src/terminal/mac-terminal-view.tsx` 补上 `MacTerminalView` + `TerminalView` (compatibility alias) 包装 `@jsonstudio/wtermmod-react`，pre-existing `@zterm/shared has no exported member 'TerminalView'` 阻断解除。
- Mac 端 `pnpm type-check` 增量错：0（6 pre-existing 与本切片无关，集中在 ShellWorkspace / TerminalSlot / bridge-transport）。
- 新增 `mac/src/app/workbench.test.ts` (12 tests)，通过 copy 到 `packages/shared/src/_mac_workbench.test.ts` 跑，验证 pane 状态机全部行为正确。Mac workspace 暂未装 vitest devDep。
- `mac/tsconfig.json` 排除 `src/**/*.test.ts*` 避免 vitest types 阻断 type-check。
- 平台差异：Mac pane 行为走 desktop profile（right-click 唤 menu / ctrl-page 切 tab / drag-resize 启用 / divider 可见）。

## 2026-06-01 Mac-3 旧 tsc 错一并消除

- `packages/shared/src/terminal/mac-terminal-view.tsx` 扩 Mac 端 native render 旧 contract 全部 props (`projection / active / allowDomFocus / themeId / showAbsoluteLineNumbers / onInput / onResize / onViewportChange / onImagePaste / onWidthModeChange`)。wtermmod 只接受 `cols/rows/autoResize/theme/onData/onResize`，其它 props 在 wrapper 内 void 占位，语义真实工作属于后续切片 (mac-4 wtermmod native render 接入)。
- `mac/src/pages/ShellWorkspace.tsx` + `mac/src/pages/TerminalSlot.tsx` import 改 `@zterm/shared` 中 `MacTerminalView` (wtermmod wrapper)，不再用裸 `TerminalView` 拒收 Mac 扩展 props。
- `mac/src/lib/bridge-transport.ts` `buildHostConfig` 收口为 HostConfigMessage 真实字段 (`openRequestId / clientSessionId / sessionName / cols / rows / autoCommand`)，删除 pre-existing 多余字段 (`name / bridgeHost / bridgePort / authToken / authType / password / privateKey`)。
- bridge target 信息 (bridgeHost/bridgePort/authToken) 走 `BridgeTarget` 通过 `openBridgeConnection` URL 路径，不再走 HostConfigMessage payload。
- `openRequestId` 用 `crypto.randomUUID` 生成，确保每个 open intent 唯一。
- `mac/src/pages/ShellWorkspace.tsx` onViewportChange callback 强转 `viewState as Parameters<NonNullable<typeof runtime>["updateViewport"]>[0]`，消除 unknown → TerminalRuntimeViewState 不匹配。
- `mac/pnpm type-check` 0 错（pre-existing 6 错全清）。
- shared 26 files / 235 tests pass 保持不变。

## 2026-06-01 mobile-2.0 红测基线建立

- Android 端 4 个黑盒红测文件落地，全部跑前**会红**（mobile-2 接入后才转绿）：
  - `android/src/components/terminal/pane-android-adapter.test.ts` (11 tests)：验证 `mobileTheme → shared PaneProfile` 适配器
  - `android/src/components/terminal/TerminalHeader.pane-tabs.test.tsx` (11 tests)：验证 TerminalHeader 切到 shared PaneTabs 后期望行为
  - `android/src/components/terminal/shared-pane-tabs.test.tsx` (8 tests)：shared PaneTabs 在 Android jsdom 下真源基线（防止"接入后回归"），7/8 当前 pass；1 红暴露 shared PaneTabs plus button **缺 long-press 路径**——mobile-2 接入时需补
  - `android/src/pages/TerminalPageStageShell.pane-stage.test.tsx` (4 tests)：验证 TerminalStageShell 切到 shared PaneStage 后期望行为
- 23 个新测 7 pass / 16 fail（红测基线就位）
- 既有 android 测零回归：TerminalHeader.test.tsx 13/13 pass，TerminalPage.render-scope.test.tsx 13/13 pass，TerminalPage.multi-pane-decouple.test.tsx 6/7 pass（1 pre-existing 失败）
- shared 26/235 仍过，mac 0 错。
- mobile-2 切片需解决的红：
  1. 建 `android/src/components/terminal/pane-android-adapter.ts` 提供 `resolveAndroidPaneProfile / buildAndroidPaneTabDescriptor / splitAndroidWorkbench`
  2. shared PaneTabs plus button 加 mouseDown long-press 路径
  3. TerminalHeader 整文件切到 shared PaneTabs（保留 mobileTheme 颜色 token 通过 render prop 注入）
  4. TerminalStageShell 切到 shared PaneStage

## 2026-06-01 mobile-2.1.a pane-android-adapter 落地

- 新增 `android/src/components/terminal/pane-android-adapter.ts` (122 行)
  - `resolveAndroidPaneProfile({ splitVisible, landscape, topInsetPx })` → 等价 shared `resolvePaneProfile(phone)` + theme overlay
  - `buildAndroidPaneTabDescriptor(session)` → shared `PaneTabDescriptor` (active/customName/resolvedPath → isResolvedRelay)
  - `splitAndroidWorkbench(panes)` → shared `PaneSlotDefinition[]` (size / tabIds / activeTabId / isActive 全保真)
  - `AndroidPaneContext` 接口继承 `PaneProfile` 加 `theme: { colors: mobileTheme.colors }`
- 验证：`vitest run src/components/terminal/pane-android-adapter.test.ts` → **12/12 全绿**
- 零回归：android 全测 1203 pass / 27 fail（27 fail 全部 pre-existing 或后续切片红测），shared 26/235 pass，mac 0 tsc 错
- mobile-2.1.a 0 副作用，已是纯函数 + 零 native 依赖

## 2026-06-01 input echo after multi-tab switch

- Verified root cause: successful `sendInput` had been changed to only send the input and wait for lifecycle/heartbeat head refresh. After multi-tab switching this can delay echo because local renderer sees remote output only after a later `buffer-head` -> `buffer-sync` cascade.
- Durable rule: explicit terminal input must send payload synchronously, then request fresh head truth from a coalesced microtask only for the first unresolved input tail refresh; burst keystrokes must coalesce under `pendingInputTailRefresh` until `buffer-sync` clears it.


## 2026-06-01 multi-pane alignment lessons
- Android 多 pane UI 必须直接使用 shared `PaneTabs` / `PaneStage`，同时保留旧 Header 合约（top padding、关闭按钮 aria、relay badge button、touch-scroll 抑制）作为回归门禁。
- Mac packaged smoke 不能只看 package 成功；必须以明确 `mac/out/mac-arm64/ZTerm.app` 进程路径 + 窗口/截图/可访问树验证。生产包禁止无条件 `openDevTools`。

## 2026-06-01 iTerm2-style split correction
- “多 pane”验收不能等同于横向 flat pane 列表。Mac/iTerm2 目标必须是 split tree：leaf=pane，split node={direction: row|column, ratio, first, second}；支持任意横/竖递归分屏、局部分隔线拖拽宽高、关闭 pane 后 tree collapse。红测必须覆盖 nested split 和 horizontal divider，不能只验证 pane 数量。

## 2026-06-01 iTerm2 split-tree + build auth
- Mac production split truth is now `ShellWorkspaceState.layout` as shared split tree (`row|column`, ratio, recursive first/second). Mac callers must adapt to shared `{ tree, activePaneId }` and pass explicit `newPaneId` so layout leaf ids equal real pane ids.
- iTerm2-style split has no fixed 3-pane cap in `ShellWorkspace`; red tests must cover right split, down split, nested row+column, divider orientation, and >3 panes.
- Mac local packaging must not auto-discover signing identities. Use `CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac dir` plus `build.mac.identity=null`; otherwise electron-builder may hit Keychain authorization on every build.

## 2026-06-01 Mac terminal projection render truth
- `MacTerminalView` must actively bridge `TerminalRenderBufferProjection.lines` into wtermmod via `TerminalHandle.write`; merely mounting `@jsonstudio/wtermmod-react` with cols/rows creates a black terminal with input plumbing but no daemon content. Red tests must assert projection changes call `write()`.

## 2026-06-01 Mac render anti-regression
- Never fix Mac terminal black screen by `TerminalHandle.write` snapshotting projection text. Mac render must consume canonical `TerminalRenderBufferProjection` as DOM rows via shared renderer helpers so scrollback, colors, and live revisions remain true. Keep wtermmod only as input/resize proxy unless it can consume canonical buffer semantics directly.

## 2026-06-01 Mac render must not resize tmux
- Mac projection render must not include hidden/1px wterm proxies or call `onResize` from render geometry. Hidden autoResize can shrink tmux cols to 1 and produce vertical text. Follow Android: renderer consumes projection; tmux resize only comes from explicit viewport/width owner paths.

- 2026-06-03: zterm TURN/relay 账号问题不要误判到 sub2api。Claw 上 coturn 真源是共享 TURN 账号 `ztermturn`，应用登录账号在 `zterm-traversal-relay` store：`/var/lib/zterm-traversal-relay/store.json`。本轮重新注册 `2094423@qq.com`，密码 `welcome4zcam#`，公共入口 `https://claw.codewhisper.cc:18443/relay/`，验证 `/api/auth/login`、`/api/auth/me`、`/api/devices` 均成功。
  Tags: zterm, claw, traversal-relay, turn, account, correction, verification

## 2026-06-07 Copy mode lifecycle: full-exit on close / reset-on-success
- `handleCloseCopyMenu` 必须 `setCopySelection(EMPTY_COPY_SELECTION_STATE)` 全量重置（包括 `active=false`），仅清 `menu` 会留下 QuickBar 高亮残留。
- 复制成功后 async reset：`copyTextAndResetOnSuccess` 里 `.then(() => setCopySelection(EMPTY))`；失败则 `.catch` warn 保留状态。
- 测试矩阵：关闭菜单=全重置、中途关闭=全重置、复制成功 async reset、clipboard 失败保留 active + warn、buffer miss 保留 active + warn。
  Tags: copy-lifecycle, quickbar, regression-gate

## 2026-06-08 Input refresh after tab switch: first pending input must request head
- Explicit terminal input 不能只 mark `pendingInputTailRefresh` 后等待 heartbeat/active tick；多次 tab switch 后会出现“远端收到输入但本地不刷新”。
- 正确语义：`markPendingInputTailRefresh` 返回是否首次 pending；input payload 必须同步 send，首次 pending input 的 `requestSessionBufferHead(sessionId, ws, { force: true })` 必须移到 coalesced microtask，禁止阻塞 key event stack，后续 burst input 不重复 force head。
- Gate: `session-context-input-runtime.test.ts` 锁 input 同步 send、首次 pending 延迟到 microtask 发 head、已有 pending 不发；`SessionContext.ws-refresh.test.tsx` 锁 burst 三连 input 同 tick 无 head、随后只有 1 条 `buffer-head-request`。
  Tags: input-refresh, tab-switch, head-first, regression-gate

## 2026-06-08 QuickBar schedule lifecycle and APK 1757
- Schedule sheet 打开后必须冻结 `{ sessionId, sessionName, seedText, nonce }`；刷新/保存/删除/启停/run-now 全部使用 frozen `sessionId`，禁止切 tab 后漂移到 active session。
- Schedule 业务错误必须走专用 `schedule-error -> scheduleState.error`，socket 未连接/target session 缺失也必须显式 `loading=false + error`；禁止 silent send 后让 UI loading 卡死，也禁止把 stale job 等业务错误混进 terminal transport failure。
- QuickBar floating menu 若保留 clipboard 分支，必须有真实 `快捷/剪贴板` segmented 入口；禁止空 pill/不可达 UI。紧凑浮层默认删除说明文案、压缩 composer 高度，并把 `定时/发送` 放同一 action row。
- Gate: `TerminalPage.schedule-target.test.tsx`、`session-context-public-runtime.test.ts`、`terminal-message-control-runtime.schedule.test.ts`、QuickBar/SessionScheduleSheet tests；APK `0.1.3.1757` 已发布到 `android/update-dist/` 与 `~/.wterm/updates/`。
  Tags: quickbar, schedule-lifecycle, schedule-error, apk-delivery, regression-gate

## 2026-06-08 Daemon/client transport performance truth
- Daemon live cadence can only use daemon-owned physical facts: capture/canonicalize duration, subscriber count, transport ready/buffered bytes/send error/backpressure, and mirror failure/in-flight state. It must not consume active tab, pane layout, follow/reading, viewport, or any client UI state.
- Client render/head cadence must be session-owned: read the target session socket buffered amount and debug metrics, pass `sessionId` through render gate/lifecycle resolvers, and allow good-link 16ms fast lane while weak/backpressured links slow down.

## 2026-06-08 Android hardware keyboard and fast cadence
- Android physical keyboard events must not depend on DOM textarea focus. Native `ImeAnchor key` should send special keys and Ctrl/Alt modified keys through shared terminal keyboard resolvers directly into the active session; plain letters stay on the editable/IME text path.
- High terminal throughput is not slow-network evidence by itself. Fast runtime progress with no socket backpressure should keep 16ms cadence even when `recentPayloadBytes` is large; weak-link decisions must use RTT/backpressure/buffered bytes/progress, not payload trimming or semantic payload changes.
- Performance traces may record metadata only (timestamp, duration, bytes, line counts, ids, kind). Tests must forbid payload/text/lines/cells/content/data keys so optimization cannot be achieved by leaking or trimming terminal payload.
- Daemon mirror lab assertions over sparse `buffer-sync` must replay payload history; final sparse payload alone is not mirror truth because later prompt-only diffs can overwrite the last observed payload while an earlier diff already contained the oracle marker.
  Tags: terminal-performance, daemon-scheduler, client-cadence, trace-metadata, regression-gate
- 2026-06-09: open tab 生命周期冻结：远端 tmux session-name audit / foreground resume / connect audit / session picker refresh / cold restore / saved tab import 都不得自动关闭或过滤 open tabs。唯一允许物理关闭 tab 与 runtime session 的入口是用户显式 close；远端缺失只能记录 `app.open-tabs.remote-session-missing` 或剪裁 session group 历史，不能写 closed tombstone。
  Tags: open-tab-lifecycle, remote-audit, no-auto-close, tombstone

## 2026-06-16 IME lift: keyboardInset is the only physical truth in adjustPan mode

### Bug: viewportAlreadyResizedByIme false-positive

`d5284be` introduced `viewportAlreadyResizedByIme` heuristic that compares layout vs
visual viewport bottoms to detect `adjustResize`-style WebView. On Jason's hardware keyboard
device, WebView keeps full layout height (`innerHeight = document.clientHeight = 792`) while
`visualViewport` also reports bottom = 792 — the WebView does not expose IME occlusion in any
viewport metric. The heuristic's three abs-checks all passed, causing `resolveKeyboardLiftPx`
to return 0 even when `keyboardInset = 297`. Result: stage did not lift above the IME.

Verified-good baseline: `fb4154a` / `0defafa` had no `viewportAlreadyResizedByIme` at all.
The function was:
  if (occludedBottom <= 0) return safeReportedInset;
  return min(safeReportedInset, occludedBottom);

Jason confirmed `0.1.3.1823` (which removes the heuristic branch) **does lift correctly**.

### Rule
`resolveKeyboardLiftPx` must not return 0 purely because viewport metrics do not reflect IME
occlusion. `keyboardInset` (from Capacitor `keyboardDidShow`) is the physical truth; if
`keyboardInset > 0`, lift must be positive. A `viewportAlreadyResizedByIme`-style heuristic
may only suppress lift when **both** `layoutViewportHeight` and `currentLayoutViewportHeight`
have actually been compressed to match `visualViewportBottom` — i.e., when the WebView has
already absorbed the IME into its layout. Never add back a false-positive heuristic that
silently returns 0 when viewport metrics are stable.

### Gates locked
- `terminal.keyboard_ime` red tests in `TerminalPage.android-ime.test.tsx`:
  - "falls back to reported keyboard inset when WebView viewport metrics do not expose IME
    occlusion" → `resolveKeyboardLiftPx(320)` must return 320, not 0.
  - "keeps reported keyboard inset when layout and visual viewport bottoms are already
    aligned" → `resolveKeyboardLiftPx(320, 600)` returns 300 (cap ratio × height), not 0.
  - "keeps terminal stage shell lifted while quick bar editor owns focus and Android keyboard
    is visible" → stage `bottom: 310px` when `keyboardInset = 280`.
  - `TerminalPage.android-ime.test.tsx`: PASS 38/38
  - `tsc --noEmit`: PASS

### APK delivered
`0.1.3.1823` / `1031823` / sha256 `21d48400c53326db9fe32ebb931274254bdd9a68b3175a02c1e27fff451b3557`

## 2026-06-17 Daemon live input must batch per mirror burst writes

- Do not reintroduce per-key `tmux send-keys` serial chains for live terminal input. The verified fix replaces `liveMirrorInputChains` with `liveMirrorInputBatches`: same-mirror same-microtask string input is coalesced into one `send-keys -l -- <payload>` while stale queued items are filtered by `shouldWrite` before writing.
- Gates: `terminal-control-runtime.input-queue.test.ts` must cover burst coalescing, append-enter boundary preservation, and stale-item exclusion; `server.control-truth.test.ts` must reject the old direct `await runTmuxAsync(...payload)` implementation inside `enqueueLiveMirrorInput`.
- Verified delivery: daemon staged runtime contains `liveMirrorInputBatches`; `daemon-mirror-lab --case=local-input-echo` PASS; APK `0.1.3.1833` delivered to `~/.wterm/updates/` with sha256 `e5d111e6df53d7a586caf66ec98e6a3eda4e5e7dcee5e1424a797a1a19a0d81c`.

## 2026-06-17 Android build must prewarm Cordova plugin local resources

- If `./scripts/build-android-debug.sh` fails in full assemble at `:capacitor-cordova-android-plugins:parseDebugLocalResources` with `!directory.isDirectory()` while the same task succeeds standalone, treat it as the empty Cordova plugin resource project not being materialized before assemble consumes it.
- Standard build now runs `./gradlew :capacitor-cordova-android-plugins:parseDebugLocalResources` before `processDebugManifest assembleDebug`; do not remove this prewarm unless Gradle/AGP is upgraded and the full standard build is proven stable without it.

- [2026-06-19] daemon 性能风险修复 R3/R9/R10/R13/R1/R2/R6/R7/R8/R14 收口
  - contracts 561 PASS, daemon close-loop 8/8, daemon restart healthy
  - R3 关键：所有 close/detach/destroy 路径必须 active 清理 liveMirrorInputBatches
  - R1+R2+R14 关键：head request 走 broadcast dedup，去除 N² 风暴
  - R9 关键：flushInFlight 必须设 min 16ms 防止 capture 循环锁死
  - R10 关键：detach 不再起 0-delay sync，避免 tmux 抖动
  - R6+R7 关键：resize 250ms 节流 + 多 widthMode 不 resize tmux
  - 审计报告落盘: docs/audits/daemon-performance-multisession-audit-2026-06-18.md
  - commit f2231db

- [2026-06-19] mock 串扰：SessionContext.ws-refresh.test.tsx 加 activeFactoryCount 守卫
  - vitest --run / build 期间跨文件同时跑会触发第二 WS factory
  - 加 activeFactoryCount 抛错 + close/open 时 decrement
  - 1 commit 5b05c17；APK 1839 同步发布

## 2026-06-23 tmux socket 标准化 + daemon 启动确保 tmux server

### 已验证结论
- tmux socket 默认在 `/private/tmp/tmux-501/default`，macOS 重启后 `/private/tmp` 被清空，导致 daemon 连不上 tmux
- 修复：daemon 的 `cleanEnv()` 设 `TMUX_TMPDIR=~/.wterm/tmux/`，socket 移到持久化目录
- 修复：daemon 启动时调用 `ensureTmuxServerRunning()` 确保 tmux server 在跑
- 验证：tsc PASS，contracts 566 tests PASS，daemon restart 后 socket 在 `~/.wterm/tmux/tmux-501/default`
- daemon 自启（launchd）一直正���，不存在"daemon 不自启"的问题

## 2026-06-23 tmux socket 检测 + daemon 启动确保 tmux server

### 已验证结论
- daemon 自启（launchd）一直正常，不存在"daemon 不自启"的问题
- tmux socket 默认在 `/private/tmp/tmux-501/default`，macOS 重启后 `/private/tmp` 被清空
- **正确策略**：daemon 启动时 `ensureTmuxServerRunning()` 先检测已有 tmux server（不设 TMUX_TMPDIR）
  - 有 server → 复用现有 socket 路径，不设 TMUX_TMPDIR
  - 无 server → 创建 `~/.wterm/tmux/` 标准化路径，设 TMUX_TMPDIR
- `cleanEnv()` 根据 `detectedSocketDir` 决定是否设 `TMUX_TMPDIR`
- 验证：tsc PASS，contracts 566 tests PASS，daemon restart 后返回真实 sessions (demo-shell, routecodex)
- **反模式**：不能强制设 TMUX_TMPDIR，否则 daemon 看不到用户已有 sessions
## 2026-06-24 copy-mode 真机长按修复 — Gate 已锁定

### 根因
- Android WebView 默认 `setLongClickable(true)`，长按时系统先触发 haptic feedback + selection，JS touch 事件被吞掉。
- `TerminalView` 的 `startCopyLongPressTouch` 注册在 `onTouchStart`，但 WebView native 层已先拦截了 touch 序列，导致 420ms timer 无法启动，菜单不弹出。
- 之前的 `setOnLongClickListener(v -> true)` 虽然禁了系统菜单，但 WebView 仍触发 haptic + touch 拦截。

### 修复
- `MainActivity.java`: `wv.setLongClickable(false)` — 不再触发原生长按 haptic / 选择手柄，touch 事件完整传给 DOM。
- `terminal.copy_mode` feature 已在 `docs/function-map.md` 注册 `MainActivity.java` 为 owner。

### 验证
- `cd android && npx tsc --noEmit` PASS
- `cd android && pnpm run test:terminal:contracts` PASS (566/566)
- `./scripts/build-android-debug.sh` PASS -> `zterm-0.1.3.1885` (versionCode `1031885`)
- HTTP: `http://127.0.0.1:3333/updates/zterm-0.1.3.1885.apk` 返回 200
- Jason 现场确认：0.1.3.1885 长按菜单正常弹出 ✅

### Gate 记录
- 红测: `system-copy-state-machine.test.tsx` PASS
- 红测: `system-copy-longpress-regression.test.tsx` PASS
- 红测: `TerminalView.selection-guard.test.tsx` PASS
- 红测: `VisibleRow.selection.test.tsx` PASS
- 红测: `TerminalPage.android-ime.test.tsx` PASS
- 合约: `test:terminal:contracts` 566/566 PASS
- 真机: Jason 1885 确认 copy-mode 长按正常

### 反模式
- Android WebView `setLongClickable(true)` 会在 native 层拦截 touch 序列并触发 haptic，JS `onTouchStart` 收不到完整事件链。
- 禁用 WebView 原生长按必须用 `setLongClickable(false)`，不能只靠 `setOnLongClickListener(v -> true)`。
- copy-mode 的"禁系统菜单"应只在 DOM/React 层做（`preventDefault` + `stopPropagation`），不在 native WebView 边界全局吞事件。
- 排查顺序固定为：先看 native long-clickability，再看 DOM touch timer，最后看 React 菜单状态；`setOnLongClickListener` 只禁 ActionMode，不等于放行 JS 长按。
- 2026-06-27 已验证补强：copy 长按 delay/slop 已集中到 `terminal-copy-gesture.ts`，QuickBar shell 事件守门已集中到 `terminal-quickbar-shell-guards.ts`，copy runtime 不再输出 `[CopyTrace]` 生产 console；copy 定向 30 tests PASS，`tsc --noEmit` PASS。

## 2026-06-29 mobile session group 1946 regression

- APK `0.1.3.1946` 现场证伪：放开横屏 session group、加入 “center-only 不进 group”、调整抽屉切 session 顺序，会破坏竖屏上中下显示和上下滚动；这些不是可保留的正确修复。
- 热修恢复原则：session group stage 回到 1945 行为，`TerminalPageStageShell` 只有 `!splitVisible && !landscape && sessionGroupViewport?.slots.center` 时启用；`TerminalPage` 抽屉选择 session 保持先切 session 再按当前 focus slot 替换槽位。
- 后续再做横屏/平板左右槽位时必须另开状态机审计和真机验证，不能在竖屏基线上直接改 StageShell gate。
- Jason 现场确认 `0.1.3.1947` 比 `1946` 明显可用，竖屏显示和滚动恢复到可继续迭代的基线；后续排查应以 `1947` 为新基线，不再沿用 `1946`。

## 2026-06-29 大面积刷新后空白直到手动滚动

### 已验证根因
- 大面积文件增删会走 `commitBuffer()` 主链，而不是单纯的 `setBuffer()` 读写路径。
- 旧实现把 live buffer 引用直接存入 store，并在 `previous.buffer === buffer` 时直接短路；只要上游复用同一个 buffer 对象并原地 mutate，store 就可能不发布新 truth。
- 现场表象就是：行数/元数据在动，但正文不刷，只有用户触摸上下滚动后才重新激活刷新链。

### 修复
- `session-buffer-store.ts` 的 `commitBuffer()` 改成内容判等，不再按引用判等。
- store 内部统一存储 `cloneSessionBuffer(buffer)`，切断 caller 的 live 引用。

### 已验证
- `src/lib/session-buffer-store.test.ts`
- `src/lib/session-render-gate.test.ts`
- `src/lib/session-render-gate.tui-content.test.ts`
- `src/contexts/session-context-buffer-runtime.test.ts`
- `src/components/TerminalView.dynamic-refresh.test.tsx`
- `src/components/TerminalView.bottom-stale.test.tsx`
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` PASS
- `./android/scripts/build-android-debug.sh` PASS，产出 `0.1.3.1953`

### 防复发规则
- store / render gate / renderer 的真源必须是不可变快照，不能让 live buffer 对象跨层共享。
- 任何“滚一下就好”的空白刷新问题，优先查 buffer publish 是否被引用短路，而不是先改 scroll 行为。

## 2026-06-29 Windows WezTerm backend 初始合约

- Windows 原生 session backend 先做在 ZTerm 侧，不 fork WezTerm；WezTerm CLI 只是外部 mux/buffer source。
- 已验证 `wezterm cli --prefer-mux spawn/list/get-text --escapes` 可在 `Jason-HW-Desktop` 上产出 pane buffer 和 ANSI 样式，ZTerm adapter 可转换为 daemon-owned absolute mirror snapshot。
- `wezterm cli --prefer-mux send-text --pane-id <id> --no-paste` 已验证可通过 stdin 写入 Enter / Backspace / arrow escape / raw TUI bytes / Codex TUI text；禁止把真实输入放进 shell args。
- 已知限制：ETX/Ctrl+C 可到 raw-mode/TUI，但不能当作 Windows console control event 中断 `cmd.exe` 子进程（如 `ping -t`），不得宣称完全键盘等价。
- 冻结合约文档：`docs/decisions/2026-06-29-windows-wezterm-backend-contract.md`。
- 必跑门禁：`src/server/wezterm-backend.test.ts`、`src/server/wezterm-backend-runtime.test.ts`、`src/server/terminal-backend-selection.test.ts`、`scripts/wezterm-backend-remote-smoke.ts`、`scripts/wezterm-backend-input-smoke.ts`、`scripts/wezterm-daemon-protocol-smoke.ts`、`tsc --noEmit`。

## 2026-06-30 traversal reconnect dead-end / startup width truth

- `TraversalSocket` 不能在“所有候选都失败且暂无可选路由”时直接落死为永久 error；但 session transport 已有外层 `SessionContext` reconnect runtime owner，所以 App session/control transport 创建 `TraversalSocket` 时必须设置 `autoReconnect:false`，避免内外两层同时新建 transport。
- 单独使用的 `TraversalSocket` 默认仍可 `autoReconnect:true` 自恢复；相关 reconnect 回归测试必须覆盖默认自恢复和外层 owner 模式不自建 backend，并使用隔离 route health cache，避免历史 failure 污染路由选择。
- 首连 handshake 已再次证实会携带 `widthMode`：`SessionContext` 直接用 `BridgeSettings.terminalWidthMode` 生成 connect payload，`useBridgeSettingsStorage` 的同步首 render 保证启动即用，不需要等后续 resize 或二次保存。
- 网络 online 恢复不能只走 `resumeActiveSessionTransport` 的 stale-open probe/wait 路径；foreground `online` 必须 active-only 调 `reconnectSession(activeSessionId)`，直接重启外层 session reconnect backoff，且禁止 sweep hidden/all sessions。

## 2026-06-30 Windows daemon multi-machine baseline

- Windows daemon 已确认可从 Tailscale 直连并通过 WebSocket 协议主链工作，且 daemon auth 走 `C:\Users\huawei\.zterm\config.json -> mobile.daemon.authToken` 配置真源，不是硬编码。
- 当前可用于手机多机测试的 Tailscale IP：
  - Windows `jason-hw-desktop`: `100.75.122.121`
  - macbookair: `100.86.84.63`
- Windows daemon 对外 health/WS 监听为 `0.0.0.0:3333`，验证时应使用同一配置 token，不要把地址或 token 写死到 app 代码里。
- Windows WezTerm session 必须以持久 shell 为根进程，默认 `cmd.exe /k`；禁止把 TUI（如 `codex`）或 `cmd.exe /c ...` 作为 pane root，否则 TUI 退出会杀掉 pane，表现为手机连接断开。回归必须验证 `shell -> codex -> Ctrl+C -> shell 继续可用`。

## 2026-06-30 Connections card picker truth

- Connections 页面卡片主动作必须打开该卡片自己的 picker，不得复用 shared open path 或别的 server 的 target。
- picker 的唯一真源是当前卡片的 `bridgeHost / bridgePort / daemonHostId / authToken`，history-only group 也应进入 picker，而不是伪装成 runtime open。
- 回归门禁：同页多 server card 点击必须各自落到各自 target；edit-group picker 打开后必须对 concrete target 自动 `fetchTmuxSessions()` 并回写 `onRemoteSessionsRefreshed()`；picker/列表刷新测试要一起绿。
