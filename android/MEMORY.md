# MEMORY — Long-Term Memory

## Project Overview

- 项目目标：Android 终端应用，Capacitor + @jsonstudio/wtermmod-react
- 手机端定位：纯 client
- 服务端定位：本地 Mac/PC 的 tmux → WebSocket 桥接

## Key Decisions

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
- [2026-04-19] daemon 稳定性门禁：`tmux capture-pane` 只能作为增强快照，失败时必须 fallback，绝不能把整个 bridge 进程打挂
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
- [2026-04-20] websocket reconnect 的 onopen 也必须显式同步 `stream-mode`；否则 active session 会短暂留在 idle/backfill 频率，肉眼看起来像秒级延迟
- [2026-04-20] terminal 手势滚动锁应是 latch：一旦进入历史阅读态，直到真实输入发生前都不应自动恢复 bottom-follow；“滚回底部”本身不等于解锁
- [2026-04-20] scrollback 的 startIndex 必须是 mirror 生命周期内单调递增的绝对行号；client 只能持有一个连续区间，merge 出现 gap 时要丢弃断裂前缀，只保留最新连续尾段，再靠 backfill 补历史，不能把稀疏索引压成连续数组
- [2026-04-20] Connections 里的 remembered session group 真源必须按 `bridgeHost + bridgePort` 归并成“每台服务器一份选择”，不能再按“某次打开时的 session 组合”累积历史；否则会出现旧筛选残留、history-only group 无法编辑/删除
- [2026-04-20] repo 拆分边界初判：mobile 应用层应独立成 app repo；必须保留到 wterm fork 的只有 runtime 真源改动（如 `cell.width` / 宽字符渲染 / CSS 语义），其余页面/会话/存储/daemon 逻辑应留在 app 层
- [2026-04-20] `android/evidence/` 是本地证据仓，不应把整批历史截图/日志直接推到 GitHub 主线；Git 中只保留 `README.md` 说明目录与取证规则
- [2026-04-20] 跨尺寸布局真源必须统一成**一个 layout profile + pane stage**：phone / tablet / foldable / split-screen / future Mac 共用同一编排决策，页面语义不随平台分叉
- [2026-04-20] Jason 补充冻结：大屏统一效果默认应是一行多列、列与列之间垂直分屏；不要把上下堆叠多 pane 当成主方案。future Mac 也沿同一单行多列编排复用 shared app-layer
- [2026-04-20] 当 Mac 需要移植 Android 连接配置流时，优先下沉纯逻辑到 `packages/shared/connection/*` 与 `packages/shared/react/*`（Host / BridgeSettings / tmux discovery / localStorage hook），而不是在桌面端复制一套 ad hoc 表单/存储实现
- [2026-04-20] tmux session discovery 不是 live connect：桌面端如果只做 `list-sessions`，用户会看到“能找到 session 但连不上”。真正连接必须显式复用 Android 的 websocket 协议：`open ws -> send connect(payload) -> send stream-mode(active)`
- [2026-04-20] 若 `bridgeHost` 已是显式 `ws://host:port` / `wss://host:port`，shared truth 必须把这个显式 endpoint 当成 display/preset key/store port 的真源；不要再额外拼接独立 `bridgePort`，否则会制造双端口假象并污染 remembered server key
- [2026-04-20] endpoint 归一不能只修 Mac；Android 的 `bridge-settings / bridge-url / connection-target / storage hooks / Connection Properties` 也要直接复用同一个 shared truth，否则桌面和移动端会再次在显式 `ws://host:port` 场景下分叉
- [2026-04-21] Jason 明确认可当前快捷栏/按钮视觉方向：后续 mobile UI 默认沿用“简洁、闭合、分区明确”的 capsule/block 设计语言——低噪声配色、清晰边界、成组区域、按钮闭合感优先；新增页面/组件若无特殊原因，应沿这个方向统一
- [2026-04-21] 升级验证流程冻结：首次装机可用 ADB，但后续新版本默认必须走 app 内建升级链路验证（manifest -> 提示 -> 下载 -> 校验 -> 系统安装）；除非 Jason 明确要求，不再用 ADB 直接覆盖新版本

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
