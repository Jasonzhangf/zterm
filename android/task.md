# zterm Android Task Board

## Epic-001 基础真源冻结

- [x] T1 拆分 spec / architecture / dev-workflow
- [x] T2 建立 task / CACHE / MEMORY 真源
- [x] T3 建立 evidence 目录约定
- [x] T4 将 skill 切到新文档结构
- [x] T5 建立 scripts / decisions 基础脚手架

## Epic-002 运行态主链路

### 对应 Beads Epic

- `mobile-13`: 实现三页式 mobile connection / terminal 架构，并切到 tmux bridge 主链

- [x] T1 冻结 `Connections` / `Sessions` 页结构（顶部栏 / 卡片 / 预览 / FAB）
- [x] T2 冻结 `Connection Properties` 页结构（General / Tmux Session / Connection / Terminal / Appearance）
- [x] T3 冻结终端页结构（顶部连接栏 / 终端区 / 底部快捷栏）
- [ ] T4 解决 Android safe-area / 顶部交互区
- [ ] T5 修正主机新增闭环（入口 / 表单 / 保存 / 卡片回显）
- [ ] T6 修正 session / websocket / tmux bridge 闭环
- [ ] T7 真机安装态验证

### Epic-002 切片顺序

- [ ] S-A1 App Shell 拆页
- [x] S-A2 定义 page state
- [x] S-B1 Connections 结构页
- [x] S-C1 Properties 结构页
- [x] S-D1 Terminal 结构页
- [ ] S-C2 迁移 HostForm 字段到 Properties
- [x] S-C3 Properties ↔ Connections 往返
- [x] S-B2 host 数据接到 card list
- [ ] S-E1 safe-area closeout
- [ ] S-E2 host create/save closeout
- [x] S-B3 card -> terminal
- [ ] S-D2 扩展键盘层
- [ ] S-D3 session 状态接到 terminal header
- [ ] S-E3 websocket/session closeout
- [ ] S-E4 真机 closeout
- [ ] S-E5 多 server / 多 tmux session tab 闭环（不同 server 不同 session、同 server 不同 session、同 session 多客户端 attach）
- [x] S-E6 daemon CLI 配置化端口 + 服务器记忆/自动 session 列表闭环
- [ ] S-E7 New connection / quick tab 统一 session picker（历史连接优先 + tmux list + CRUD + clean session）
- [ ] S-E8 Tailscale IP 优先 + daemon auth token + tmux multi-select tabs

## Epic-003 后续功能

- [ ] WebDAV 同步
- [ ] 后台保活完善
- [ ] 快捷键盘与快捷栏
- [ ] 悬浮球预输入编辑器（输入框 / 快捷列表 / 剪贴板 / 发送 / 加入）
- [ ] Tab 长按重排、双击重命名
- [ ] 应用内升级闭环（server manifest / version compare / checksum / Android install prompt / 忽略策略）
- [ ] 响应式排版分层（手机 / 平板 / 折叠屏 / 分屏 / 多 active tab）→ 已提升为 Epic-004

## Epic-004 跨尺寸布局与 Mac 共享壳

### 对应 Beads Epic

- `mobile-14`: 统一跨尺寸布局与 Mac 共享壳

- [x] T1 冻结唯一 layout profile 决策文档（`docs/decisions/0001-cross-platform-layout-profile.md`）
- [x] T2 更新 `spec / architecture / dev-workflow / ui-slices / SKILL`
- [x] T3 建立 task board / CACHE / MEMORY 的统一口径
- [x] T4 抽 layout profile resolver + pane stage 真正进入代码（`mobile-14.1`）
- [ ] T5 验证 phone / tablet / foldable / split-screen / future Mac 的布局切换口径（`mobile-14.3`）
- [ ] T6 基于 shared pane stage 推进 future Mac 壳（`mobile-14.2` / `mobile-14.3`）
- [x] T7 构建 Mac 最小可执行包（`mobile-14.4`）
- [x] T8 把 Android 连接配置流程移植到 Mac（shared connection model / storage / details form）

## Epic-005 per-session 定时发送 / heartbeat

- [x] T1 冻结定时发送设计真源（`docs/decisions/2026-04-22-session-schedule-timed-send.md`）
- [x] T2 下沉 shared schedule types / next-fire 计算与协议扩展
- [x] T3 daemon 落地 schedule store / engine / dispatch
- [x] T4 Android terminal schedule sheet（calendar + alarm UI）
- [x] T5 Mac terminal schedule sheet（calendar + alarm UI）
- [x] T6 rename / kill / offline / daemon restart 边界 closeout
- [x] T7 daemon + Android + Mac 联调验证与证据补齐

## 当前状态

- 2026-04-20 当前切片：Connections 页按 server IP 聚合，支持 group 长按展开、多选 session、跨 group 同时打开
- 基础流程已开始冻结
- 业务实现暂停在“先定真源”阶段
- 进入下一步前先确认文档结构和 skill 口径一致
- UI 参考图已审阅，下一步按 `Connections/Sessions`、`Connection Properties`、终端页三条主线切片
- 页面级切片与文件 ownership 已冻结到 `docs/ui-slices.md`
- Web 结构证据已补齐：Connections / Connection Properties / Terminal 三页截图与 build/type-check 日志已入 `evidence/2026-04-18-mobile-13-shell/`
- `ConnectionCard` 的无 preview 重复显示问题已修正，并补充到 skill / MEMORY / CACHE
- 2026-04-19 已完成 tmux bridge 浏览器 HTTP 入口验证：中文/ANSI 渲染、方向键、Esc、自定义快捷输入都已通过 `cat -v` 闭环
- 2026-04-19 Android 构建闭环已恢复：`build:android` 现在自动探测 Homebrew `openjdk@21`
- 2026-04-19 新需求冻结：tab 体系必须支持“不同 server 上不同 tmux session”以及“同一个 server 上不同 tmux session”
- 2026-04-19 连接模型已开始显式拆分为 `bridgeHost / bridgePort / sessionName`，用于区分 server 与 tmux session
- 2026-04-19 新要求冻结：服务器启动入口统一为本地后台 daemon CLI，默认端口由统一配置决定（当前 `3333`）
- 2026-04-19 已建立 `src/lib/mobile-config.ts` 作为 bridge/daemon 端口真源；server、UI、tests、shell script 共用该配置
- 2026-04-19 已完成 daemon per-session mirror 重构并做 ws smoke 验证：`wterm-verify-a` / `wterm-verify-b` 两个 tmux session 可分别取回 scrollback，A session 重连后可继续看到后续输出
- 2026-04-19 新规则开始落地：New connection 先进入统一 session picker，优先显示历史连接 + 当前 tmux sessions，并支持 create/rename/kill；terminal 顶部 + 长按进入 quick-tab picker
- 当前剩余 blocker：设备安装更新包时被系统拒绝，需要 Jason 在手机上确认安装权限后再做 APK 真机回归
- 2026-04-20 当前重点：active tab 不能退化成 idle backfill 频率；reconnect 路径的 websocket onopen 也必须同步 `stream-mode=active|idle`，否则 active 也会出现秒级延迟
- 2026-04-20 当前重点：手势滚动一旦进入历史阅读态，必须保持锁定到输入发生为止；不能在 buffer 更新/重渲染时被拉回底部
- 2026-04-20 当前重点：scrollback/buffer 要改成“绝对行号 + 最新连续尾段”模型；带 gap 的旧 buffer 不能再被压扁拼接，否则会同时破坏补历史和阅读锚点
- 2026-04-20 新需求进入队列：悬浮球内加入预输入编辑器（输入框 + 快捷列表 + 剪贴板 + 发送/加号），以及 tab 长按重排 / 双击改名
- 2026-04-21 新需求进入队列：应用内升级；唯一真源应是服务器 manifest，客户端只做版本比较 / 下载校验 / 调起系统安装，不做第二套版本真相；提醒策略必须支持「跳过当前版本」与「一直忽略直到用户手动检查」
- 2026-04-20 已创建 `mobile-14` / `mobile-14.1` / `mobile-14.2` / `mobile-14.3`：跨尺寸布局 / Mac 共享壳真源统一完成；Jason 已补充冻结为“默认一行多列 + 垂直分屏”
- 2026-04-20 已创建 `mobile-14.4`：Mac 先做最小可执行包（Electron + Vite + React），先打通 build/package/window/stage 再逐步接功能
- 2026-04-20 `mobile-14.1` 已完成：shared layout resolver + PaneStage 已抽到 `packages/shared/`
- 2026-04-20 `mobile-14.4` 已完成：`/Volumes/extension/code/zterm/mac/out/mac-arm64/ZTerm.app` 可启动，已验证 shared pane stage 和真实 page slot
- 2026-04-20 `mobile-14.2` 已完成当前目标：Android 的 Host / BridgeSettings / tmux session discovery / localStorage 真源已下沉到 `packages/shared/`，Mac 已接入真实 Connections / Details / Terminal 编排；浏览器验证已确认“填表 -> Save -> 列表/Terminal/Remembered Servers 回显”
- 2026-04-20 `mobile-14.3` 当前已推进到 Mac live render：shared websocket `connect + stream-mode(active)`、terminal buffer reducer、shared TerminalView 都已接入；浏览器 mock bridge 已看到 `connected + snapshot` 文本
- 2026-04-20 shared bridge endpoint 已归一：`bridgeHost` 若显式带 `ws://host:port`，display / preset id / stored effective port 都以显式 URL 为真源，避免 `ws://127.0.0.1:4333:3334333` 这类双端口假象
- 2026-04-20 packaged `ZTerm.app` 已按单实例规则复验：先 quit 旧实例，再 open 新包；窗口已显示最新标题 `Shared connection flow + live terminal render`
- 2026-04-20 Android 连接配置 endpoint 也已回收至 shared 真源：`bridge-settings / bridge-url / connection-target / useHostStorage / useBridgeSettingsStorage` 现在直接复用 `@zterm/shared`，Connection Properties 输入 `ws://host:port` 时会同步刷新 `Bridge Port`
- 2026-04-20 Mac 壳层已开始按 Tabby 官方特征收口：紧凑顶部 chrome、tab strip、左侧 profile rail、terminal-first 主画布都已落到 packaged `.app`；但布局真源仍保持 shared 的单行多列 + 垂直分屏
- 2026-04-20 Mac 2-col 壳层继续收口：顶部 tab strip 已从静态文案改为真实 target / inspector 状态 tabs，并可直接切 `Terminal ↔ Inspector`；右侧 Details 也已改成 inspector summary + compact form
- 2026-04-20 Mac shell 已进入最小真实 open tabs：saved target 可开成 tab、`+` 可进入 new connection tab、tab 可关闭；当前真边界明确为 `single runtime · multi tabs`
- 2026-04-20 Mac 壳层排版已做第一轮 terminal-first 收口：列宽不再等分，Terminal 主列明显更宽；顶部 chrome / shell tabs / terminal 内二级 tabs 已压缩
- 2026-04-20 Jason 新冻结：右侧不是固定抽屉，而是可选比例的 vertical split workspace（类似 iTerm2）；当前 packaged `.app` 已补最小 preset：`1 / 2 / 3` 分列
- 2026-04-22 新需求已冻结成文档：session 定时发送 / heartbeat 采用 daemon 单一调度真源，按 tmux `sessionName` 绑定；Android / Mac 只提供 calendar + alarm 风格编辑器
- 2026-04-22 Epic-005 当前代码已落地：shared schedule types / next-fire、daemon schedule engine、Android schedule sheet、Mac schedule modal 均已接入；已通过 android/mac type-check + android vite build + mac build + schedule engine smoke
- 2026-04-23 Epic-005 已完成证据闭环：`android/evidence/2026-04-22-session-schedule/` 已补 type-check/build、schedule logic smoke、真实 daemon websocket smoke（含 schedule store 持久化 + tmux 执行 side effect）；`mac/evidence/2026-04-22-session-schedule/` 已补 type-check/build/package 与静态 schedule modal HTML preview
- 2026-04-23 Android terminal 输入层已补一轮交互收口：快捷输入面板支持外点关闭 + 显式关闭按钮；定时发送入口已并入预输入区右侧；悬浮球改成直接拖动；floating overlay 不再叠加 keyboard inset 导致面板抬升过高；验证证据已落到 `android/evidence/2026-04-23-quick-input-ui/`
- 2026-04-23 Android terminal 输入层第二轮修正已落地：tab 长按阈值已增大；tab header 的定时入口已移除，仅保留 quick input 右侧 session 级入口；悬浮球持久化坐标会在 mount/resize 自动回收进可视区
- 2026-04-23 Tab manager 拖拽排序不生效已修正：拖拽目标计算已排除当前拖动行，release 提交改为读取 ref 同步的最新 dragState；已补 `TabManagerSheet.test.tsx` 回归并完成 Android 构建/升级目录投放
- 2026-04-23 悬浮球“消失”根因已确认并修正：`TerminalPage` 的 quick bar 包裹层在 keyboard 关闭时不再保留 `transform: translateY(0)`，避免 fixed 悬浮层错误绑定到容器坐标系
- 2026-04-23 快捷按键组合默认名已修正：`Ctrl` 等 modifier 不再提前占用 label；未手填名称时，保存自动使用组合 preview（如 `Ctrl + C`）；已补 `TerminalQuickBar.test.tsx` 回归并完成 Android 构建/升级目录投放
