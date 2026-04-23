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

## Epic-006 terminal head / sparse buffer / render container 重做

- [x] T1 冻结 terminal 新真源文档（session head / sparse buffer / renderer / UI shell）
- [x] T2 审计旧 daemon/client/render 链路，列出保留/删除清单
- [x] T3 重做 server：30Hz head 广播 + range request 响应
- [ ] T4 重做 client buffer worker：sparse absolute-index buffer + working-set diff
- [ ] T5 重做 renderer container：bottom-relative render window，纯消费
- [ ] T6 重做 UI shell：keyboard / crop / container presentation only
- [ ] T7 回归验证：hidden/follow/reading/IME/foreground
- [ ] T8 renderer 继续收敛：统一 follow 对齐 helper / reading 判定 helper，缩小 TerminalView 本地状态面

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
- 2026-04-23 Epic-006 进度：旧 server 主动 push / stream-mode 链已删除；daemon 现仅做 `buffer-head` 广播与 range request 响应；Android SessionContext 已最小接入 head 驱动请求，后续继续清理 renderer / viewport prefetch 旧链
- 2026-04-23 Epic-006 追加进度：Android `TerminalView` / `TerminalPage` / `App` 已去掉 `viewport prefetch` 入口；renderer reset 信号已从 `followViewportNonce` 收窄成 `viewportResetNonce`
- 2026-04-23 Epic-006 再追加：Android SessionContext 已把 bootstrap / normal follow sync 合并成单一 `requestSessionBufferSync`，App foreground 恢复口径也已切到 `resetSessionViewportToFollow`
- 2026-04-23 Epic-006 再再追加：`TerminalView` 已把本地 follow 命名收敛成更清晰的 `readingMode` UI latch；验证结论是“follow 不能只靠 DOM `scrollTop` 纯推导”，否则会被 DOM bottom/逻辑 tail 偏差打坏
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
- 2026-04-23 Mac 已按 Android 收口快捷键组合算法：组合编码/解码/默认 label 统一下沉到 `packages/shared/src/shortcuts/terminal-shortcut-composer.ts`，Android QuickBar 直接复用，Mac 补本地 re-export 入口并完成 type-check/build/package；Android 新 APK 已投放 `~/.wterm/updates/zterm-0.1.1.1140.apk`
- 2026-04-23 Android 前后台恢复“假死 / 显示已连接但不更新”已修正三处：foreground 恢复优先只拉 active session、其余只拉非健康 session 以压低无效带宽；`reconnectAllSessions()` 在同 host 串行 bucket 中也会把 active session 放到队首；重连成功后立刻补 bootstrap `buffer-sync-request`，避免 reconnect 后只变 `connected` 但画面仍停在旧 revision；新 APK 已投放 `~/.wterm/updates/zterm-0.1.1.1142.apk`
- 2026-04-23 Android active tab buffer 刷新再补两处：`TerminalView` 不再因 visible gap 继续冻结上一帧；active/follow 态若当前三屏窗口有缺口，会只按窗口内 `missingRanges` 发 sparse prefetch，不再从旧 stop point 连续追最新；回归证据在 `android/evidence/2026-04-23-active-tab-gap-refresh/`，新 APK 已投放 `~/.wterm/updates/zterm-0.1.1.1143.apk`
- 2026-04-23 terminal 主题已落地：新增 shared terminal theme 真源（默认前景/背景 + ANSI 16 色 preset），Android Settings 可切换 `Classic Dark / Tabby Relaxed / iTerm2 Light Background / Gruvbox Dark / Catppuccin Mocha`；Android 本地 TerminalView 与 Mac shared TerminalView 共用同一主题口径；证据目录 `android/evidence/2026-04-23-terminal-themes/`、`mac/evidence/2026-04-23-terminal-themes/`，Android 新 APK 已投放 `~/.wterm/updates/zterm-0.1.1.1147.apk`
- 2026-04-23 terminal 主题持久化语义已修正：Settings 里点击主题卡片会立即写入 `BridgeSettings.terminalThemeId`，不再依赖顶部 Save；修复“卡片显示正在使用但切出去再回来恢复默认主题”的假激活问题；回归证据在 `android/evidence/2026-04-23-terminal-theme-persist/`，Android 新 APK 已投放 `~/.wterm/updates/zterm-0.1.1.1153.apk`
- 2026-04-23 Epic-006 renderer 再收一轮：`TerminalView` 已把重复的 follow 贴底动作收成单一 `alignViewportToFollow()`，scroll 判定收成纯 helper `resolveViewportModeFromScroll()`；`TerminalView.dynamic-refresh` + `SessionContext.ws-refresh` + `App.dynamic-refresh` 共 35 tests 通过，`pnpm exec tsc --noEmit` 通过。
- 2026-04-23 Epic-006 session worker 再收一轮：`updateSessionViewport()` 已对相同 reading viewport 去重，并在 `reading -> follow` 时清理排队中的 reading sync，避免多发/误发 `buffer-sync-request`；相关动态回归现为 37 tests 通过。
- 2026-04-23 Epic-006 request/build 边界再收一轮：follow viewport state 与 bootstrap 决策已收成单点 helper，`active switch` 与 `follow reset` 复用同一口径，避免 follow 构造逻辑再次分叉；动态回归保持 37 tests 通过。
- 2026-04-23 Epic-006 transport 再收一轮：`connectSession` / `drainReconnectBucket` 的公共 socket 握手、heartbeat、server message 分发已抽成共享 helper，保留各自的 connected 语义分支；动态回归保持 37 tests 通过。
- 2026-04-23 Epic-006 connected-success 再收一轮：普通 connect / reconnect 在 `connected` 后共享同一份 baseline 状态推进（connected state、schedule-list、active bootstrap、watchdog、connectedCount），各自只保留额外 side effect；动态回归保持 37 tests 通过。
- 2026-04-23 Epic-006 failure-path 再收一轮：普通 connect / reconnect 的 `finalizeFailure` 已共享同一份 baseline（完成位、cleanup、schedule error、manual-close 终止），各自只保留 retry/bucket 专属推进；动态回归保持 37 tests 通过。
- 2026-04-23 Epic-006 renderer effect 面再收一轮：`TerminalView` 已把 viewport refresh 调度收成 `scheduleViewportRefresh()`，当前 viewport emit 收成 `emitCurrentViewportState()`；仍保持原有刷新语义，动态回归保持 37 tests 通过。
- 2026-04-23 Epic-006 renderer reading-emit 再收一轮：`TerminalView` 已把 reading viewport emit 收成 `emitReadingViewportState()`，历史 prepend 与 near-edge reading 两处共用同一入口；动态回归保持 37 tests 通过。
- 2026-04-23 Epic-006 renderer viewport-actions 再收一轮：`TerminalView` 已把 follow reset、prepend 历史锚定、near-edge reading emit 分别收成 `resetViewportToFollow()` / `anchorReadingViewportAfterPrepend()` / `emitReadingViewportIfNearEdge()`；动态回归保持 37 tests 通过。
- 2026-04-23 Epic-006 renderer reset-signal 再收一轮：`TerminalView` 已把 becameActive 与 `viewportResetNonce` 的 follow reset 信号并入同一个 effect，只保留一处 reset 判定；动态回归保持 37 tests 通过。
- 2026-04-24 Epic-006 renderer emit-effect 再收一轮：`TerminalView` 已把当前 viewport emit 与 reading near-edge emit 合并到同一个 effect，继续依赖 emit 去重 key 保持原语义；动态回归保持 37 tests 通过。
- 2026-04-24 Epic-006 renderer refresh-schedule 再收一轮：`TerminalView` 已把 layout/session refresh 与 follow audit 共用同一个 `runViewportRefresh()` 动作；refresh 调度不再因为 follow/reading 切换而重新建 callback，避免滚动状态翻转时重复重排 refresh 计时器；`tsc --noEmit` + 37 个动态回归通过。
- 2026-04-24 Epic-006 renderer resize-observer 再收一轮：`ResizeObserver` 回调已不再直连 `syncViewport()`，而是复用同一个 `runViewportRefresh({ alignFollow: true })` 动作；新增 reading-resize 回归，验证 resize refresh 不会把 reading 态强行拉回 follow；`tsc --noEmit` + 动态回归现为 38 tests 通过。
- 2026-04-24 Epic-006 renderer refresh-effect 再收一轮：`layout refresh` 与 `session refresh` 两个 effect 已合并成单一 trigger effect，通过 `becameActive/sessionChanged/layoutChanged` 判定触发原因，再统一调 `scheduleViewportRefresh()`；保留 `48ms(layout)` / `120ms(active|session)` 差异，不再维护两处平行 refresh effect；`tsc --noEmit` + 38 个动态回归通过。
- 2026-04-24 Epic-006 renderer state-actions 再收一轮：`prepend/follow` 与 `viewport emit` 两个剩余状态 effect 已先收成 `reconcileViewportAfterBufferShift()` / `emitViewportSignalsForCurrentFrame()` 动作，再由 effect 只做触发；新增 reading + prepend 历史锚定回归，验证 `bufferStartIndex` 向前扩展时会按行高补偿 scrollTop；`tsc --noEmit` + 动态回归现为 39 tests 通过。
- 2026-04-24 Epic-006 renderer/context interface 再收一轮：`TerminalViewportState` / `TerminalViewportSize` / `TerminalResizeHandler` / `TerminalViewportChangeHandler` 已下沉到 `android/src/lib/types.ts`，`TerminalView` / `TerminalPage` / `SessionContext` / tab-isolation test 不再各自内联 viewport/resize shape；`tsc --noEmit` + 41 个动态回归通过。
- 2026-04-24 Epic-006 renderer prop-face 再收一轮：`bufferRevision` 已从 `TerminalView` prop 面移除；renderer 不再把 revision 当输入，只保留真正必要的 `bufferViewportEndIndex / cursorKeysApp / viewportResetNonce`；`tsc --noEmit` + 41 个动态回归通过。
- 2026-04-24 Epic-006 renderer trigger 命名再收一轮：`TerminalView` renderer API 已把 `viewportResetNonce` 改成更语义化的 `followResetToken`，并在 `lib/types.ts` 下沉 `TerminalFollowResetToken`；Session store 仍保留 `session.viewportResetNonce` 作为内部状态名，通过 `TerminalPage` 做一次映射；`tsc --noEmit` + 41 个动态回归通过。
- 2026-04-24 Epic-006 follow-reset 真源再收一轮：`Session` / `SessionContext` 内部状态名也已从 `viewportResetNonce` 统一改成 `followResetToken`，renderer/page/context 现在共用同一语义名；`tsc --noEmit` + 41 个动态回归通过。
- 2026-04-24 Epic-006 request-builder 再收一轮：`SessionContext` 已把普通 `buffer-sync-request` 与 follow bootstrap 的 payload 构造统一到单一 `buildSessionBufferSyncRequestPayload()` helper，bootstrap 只通过 `forceBootstrap + modeOverride='follow'` 覆盖差异；`tsc --noEmit` + 41 个动态回归通过。
- 2026-04-24 Epic-006 viewport-demand 再收一轮：`SessionContext` 已把 viewport state 归一化 / 判等 / active demand 调度收成 `normalizeSessionSyncViewState()` / `sessionSyncViewStatesEqual()` / `applyActiveSessionViewportDemand()`；`updateSessionViewport()` 现只做“写状态 + 触发 demand”。`tsc --noEmit` + 41 个动态回归通过。
- 2026-04-24 Android 测试包已更新：`pnpm build:android` 成功，生成 `android/update-dist/zterm-0.1.1.1171.apk`，并已投放到 `~/.wterm/updates/zterm-0.1.1.1171.apk`；manifest `latest.json` 同步更新，`sha256=99866d892500e804e1d353c96a9d3c7baf077ae27ab7d72e04898280d99ad6b5`。
- 2026-04-24 Epic-006 buffer cadence 再收一轮：`SessionContext` 已补 active session 的本地 `33ms` head cadence；`sendInput()` 不做本地回显，但会挂 `input-tail-refresh` demand 并主动触发 follow `buffer-sync-request + ping`；真正 tail / reading 请求频率改由 `resolveTerminalRefreshCadence()` 按网络状况决定。`tsc --noEmit` + `TerminalView/App/SessionContext/TerminalPage` 动态回归现为 42 tests 通过。
