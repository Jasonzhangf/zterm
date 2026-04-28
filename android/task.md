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

### 对应 Beads Epic

- `mobile-15`: terminal 真源重构：daemon / buffer manager / renderer / UI shell 解耦实现

- [x] T1 冻结 terminal 新真源文档（server / buffer manager / renderer / UI shell）
- [x] T2 审计旧 daemon/client/render 链路，列出保留/删除清单
- [x] T3 重做 server：只回答 `buffer-head-request` / `buffer-sync-request`，每次回复都带 head，删除策略逻辑（`mobile-15.2`）
- [x] T4 重做 client buffer manager：独立 timer、head-first、1000 行 sliding sparse buffer、三屏重锚 / diff / reading gap repair（`mobile-15.3`）
- [x] T5 重做 renderer container：`follow / reading + renderBottomIndex`，纯消费本地内容池（`mobile-15.4`）
- [x] T6 重做 UI shell：keyboard / crop / container presentation only（`mobile-15.5`）
- [x] T7 真实回归验证：initial / resume / input / reading / daemon-restart（`mobile-15.8`）
- [x] T8 删除剩余错误实现：planner / stream-mode / snapshot / renderer→buffer pull / fallback（`mobile-15.6`）
- [x] T9 建立 terminal 本地自动回归闭环：问题可复现、测试先失败、修复后转绿、纳入每次 build 前门禁（`mobile-15.1`）
- [x] T10 补 Android 首屏专项回归：cold start single tab first paint / switch to another tab first paint（`mobile-15.7`）

### Epic-006 当前实现进度（2026-04-26）

- `mobile-15.1` 已落地：
  - `test:terminal:contracts` 已纳入
    - `App.dynamic-refresh.test.tsx`
    - `App.first-paint.test.tsx`
    - `App.first-paint.real-terminal.test.tsx`
    - `SessionContext.ws-refresh.test.tsx`
    - `TerminalView.dynamic-refresh.test.tsx`
  - `prebuild -> test:terminal:regression` 继续作为 build 前门禁
- `mobile-15.3` 已收一轮关键行为：
  - restore persisted tabs 时，**只允许 active tab eager connect**
  - hidden tabs 仅恢复 tab/runtime shell，不在 cold-start 时并发建连
  - foreground resume 只 poke / reconnect active tab，不再扫 hidden tabs
  - active tab 若当前是 `closed/error`，在显式激活后再 reconnect
- `mobile-15.2` / `mobile-15.3` / `mobile-15.4` / `mobile-15.5` / `mobile-15.6` 已完成本轮收口：
  - server 不再主动 push `buffer-head`，connect / live sync 路径只维护 mirror truth 与基础 connected/title/schedule-state
  - buffer manager 改为 worker 自己算 reading gap repair；follow 只做 head-first tail diff / 三屏重锚
  - renderer 已删除 gap/prefetch 规划、`missingRanges` 生成、`viewportLayoutNonce` 耦合
  - UI shell 已切断 IME/layout nonce -> renderer refresh 回灌
  - runtime/src 范围内已清掉旧 `stream-mode` / planner / renderer->buffer pull / fallback 语义
- `mobile-15.7` 已补齐首屏专项回归：
  - cold start single active tab：不输入也能 head -> sync -> first paint
  - switch to another tab：切换后由新 active tab 自主 connect -> head -> sync -> first paint
- `mobile-15.8` 已有最新证据：
  - daemon strict audit：`evidence/daemon-mirror/2026-04-26/strict-audit.json`
  - APK smoke：`evidence/android-apk-smoke/2026-04-26-093453`
  - runtime audit / logs：`evidence/runtime-audit/2026-04-26/`
  - terminal regression：`pnpm run test:terminal:regression`
  - relay smoke：`pnpm run test:relay:smoke`
  - type-check：`pnpm type-check`

### Epic-006 后续加固项（不阻塞 mobile-15 主链收口）

- [ ] mobile-15.9 真机 closeout：收敛 `head -> buffer-sync -> local apply -> renderer commit` 断链（当前 1258 现场表现为 `session.buffer.request` 后无 `buffer-sync/render` 证据，首屏空白但 daemon direct probe 正常）
- [x] mobile-15.9a renderer scope closeout：`TerminalPage` 只挂 visible pane renderer，禁止 hidden session DOM 覆盖 active body（1277）
- [ ] mobile-15.10 Android IME closeout：修正 `ImeAnchor` 的 stale show / 前台自动弹键盘 / 异常九宫格态，保证只有显式点键盘按钮才 show，且输入后必须进入 `input -> head -> buffer-sync -> render` 闭环
- [ ] mobile-15.25 Android ImeAnchor composing truth closeout：`ImeAnchorEditText` 的 editable/composing/selection 必须单一真相；中文/九键输入期间不得提前 emit delta 或主动 clear editable，避免 caret 错位导致终端不可用
  - 2026-04-27 已完成第一轮收口：
    - 新增 `ImeAnchorInputLogic` + `ImeAnchorInputLogicTest`
    - `ImeAnchorPlugin` 已切到 commit-only composing 路径
    - 1276 APK 已构建并安装
  - 2026-04-27 现场新增根因：
    - `InputConnection.commitText / finishComposingText` 直接短路返回、没让 framework 更新 editable/selection，会导致输入法底部预编辑栏 cursor/caret 错位
  - 待真机继续专项确认：
    - 九键中文 caret 是否回正
    - 语音转文字后是否仍能立即继续输入
- [ ] mobile-15.11 buffer store closeout：把 client 本地 buffer trim 真相从“3 屏”改回“1000 行 sliding window”，请求窗口仍保持三屏，不再混用
- [ ] mobile-15.12 daemon mirror lifecycle closeout：daemon mirror 不能再跟 subscriber 生命周期绑定；当前 `orphan destroy -> mirror recreate` 会把 `revision/latestEndIndex` 重置，破坏 daemon 绝对行号真相并触发 client revision-reset 链路
- [ ] mobile-15.13 daemon client-session bookkeeping closeout：`destroyMirror()` 当前会把 subscriber 标成 `closed` 但不 `sessions.delete()`，现场 `/health` 已出现 `170 total / 1 connected`
- [ ] mobile-15.14 terminal 测试矩阵 closeout：把 checklist 映射到现有自动测试与缺口，固定补测顺序（voice/CJK commit、follow overdrag blank-frame、buffer truth reset violation、payload inflation）
- [ ] mobile-15.15 renderer follow-state closeout：live tail refresh / pending follow realign 不得把底部 follow 自动打进 reading；先补本地回归，再修 renderer 状态机
- [ ] mobile-15.16 active re-entry pull-state closeout：切 tab / resume 后旧 in-flight `buffer-sync` bookkeeping 不得卡死 session；active re-entry 必须回到 head-first 主循环，但不得清空本地 buffer truth
- [ ] mobile-15.17 reconnect bucket closeout：同 host reconnect 若 socket open 但 handshake 不完成，bucket 不能永远占住 `activeSessionId`；必须显式超时失败并释放后续 session 重连机会
- [ ] mobile-15.18 UI shell closeout：顶部 terminal header 必须避开 Android 状态栏；键盘弹出时只能做底部裁切/缩高，不允许整页 `translateY` 上抬后再掉回
  - 2026-04-27 新增冻结：keyboard inset 只能消费一次；`terminal-stage` 用 `quickBarHeight + keyboardLift` 裁切，`TerminalQuickBar` 外层 shell 用 `bottom = keyboardLift` 整体抬升，禁止 QuickBar 内部再用 `paddingBottom = keyboardInsetPx` 形成二次上抬
- [ ] mobile-15.19 daemon service staging closeout：`zterm-daemon.sh` 的 `start/restart` 必须重建当前 staged runtime，禁止继续启动旧 `~/.wterm/daemon-runtime/server.cjs`；并补门禁保证 `buffer-sync` 返回 compact wire，服务异常不得 fallback 到 tmux session
- [ ] mobile-15.20 daemon close-loop isolation closeout：`daemon-mirror-lab` 必须使用隔离测试端口，不能复用用户常驻 service 端口；否则 close-loop 会误连现场 daemon，门禁结论失真
- [ ] mobile-15.21 client buffer-sync apply closeout：补 compact-wire incoming apply 回归；若已收到 `buffer-sync`，本地 buffer truth 必须立刻推进，禁止微任务批处理把 follow 尾窗卡成重复请求同一三屏
- [ ] mobile-15.22 terminal header inset closeout：Header 顶部 inset 改成 UI shell 单一真相，删除 Header 内部二次 safe-area 叠加，补 Android 顶部点击区回归
- [ ] mobile-15.23 tab restore truth closeout：冷启动 / 恢复时最后 active tab 只允许由 `ACTIVE_SESSION` 决定；`ACTIVE_PAGE.focusSessionId` 不得把已恢复的 active tab 覆盖回旧值
  - 新冻结：**任何 tab 激活事件都必须立即持久化 `ACTIVE_SESSION`**；下次启动只能按这份真相恢复最后激活 tab，不允许再从别的 UI 状态反推。
- [ ] mobile-15.24 compact default-color sentinel closeout：compact wire encode/decode 必须和 `TerminalCell` 默认 `fg/bg=256` 对齐；补 roundtrip 回归，解决灰条/花屏/cursor 样式污染
- [ ] mobile-15.26 mirror width mode truth closeout：冻结 `adaptive-phone | mirror-fixed`；`mirror-fixed` 下 client viewport / IME / container width 变化不得改写 daemon mirror / tmux 宽度
- [ ] mobile-15.26a Settings width-mode truth closeout：`terminalWidthMode` 真源迁到 Settings，全局唯一；删除 Host / Connection Properties 第二语义
- [ ] mobile-15.26b tmux rows freeze closeout：Android runtime 后续不再改 tmux rows；`adaptive-phone` 最多只改 width / cols
- [ ] mobile-15.27 renderer horizontal crop / pan closeout：`mirror-fixed` 下长行默认左裁切，renderer 只维护 horizontal render window，不换行、不重排、不改 buffer truth
- [ ] mobile-15.28 mirror-fixed gesture closeout：`mirror-fixed` 开启后自动关闭左右滑切 tab；单指横滑只服务于 renderer horizontal pan
- [ ] mobile-15.29 renderer cursor echo closeout：Android client 不得自行改 cursor 样式；renderer 只能回显 payload。补 renderer theme / follow 场景回归，防止再引入客户端 cursor 第二语义
- [ ] mobile-15.30 renderer measured-cell-width closeout：renderer 列宽改成客户端实测像素真相，删除 `1ch / 2ch` 作为终端列宽语义；补 mixed ASCII/CJK 对齐回归
- [ ] mobile-15.31 active transport liveness closeout：session 活性判定不能只看 `connected/open`；active re-entry / resume 若无新的 head/range/pong 进展，必须判旧 transport 失活并重建，补“切 tab 挂住、重进秒好”回归
- [ ] mobile-15.32 transport/session lifecycle closeout：client session 与 ws/rtc transport 解耦；inactive tab 只停取数，不关闭 session/transport；daemon 侧 reconnect 复用同一 `clientSessionId` logical session，并补 shutdown 统一回收回归
  - 冻结真源：`docs/decisions/2026-04-28-terminal-transport-session-lifecycle-truth.md`
  - 第一轮关闭顺序：
    1. client 引入 `bridge target -> control transport` 单一真相
    2. 每个 `clientSessionId` 保持自己独立的 stable session transport；高频 head/range/input 不复用到 control transport
    3. session attach / resume 通过 control transport 协调，但仍绑定同一个 `clientSessionId`
    4. inactive tab 只停 head/range pull，不关 session / transport
    5. daemon transport close 只 detach transport；logical session 只允许 explicit close / daemon shutdown 回收
    6. 自动回归覆盖 same target multi-session / foreground resume / active re-entry / daemon transport re-attach
  - 2026-04-28 当前补口：
    - App 恢复链保持 `resume-first` 真相，并把对应 App regression expectation 收口
    - App 首帧已有 session 时立即持久化 `OPEN_TABS / ACTIVE_SESSION`，补“现存 tab 自动恢复真相”红测
    - 继续收 `SessionContext` 内 transport truth：`wsRefs / supersededWsRefs / sessionHostRef -> runtime store`
- [ ] mobile-15.33 renderer transient follow-frame closeout：live refresh / shell relayout 时不得先花屏/白屏再靠输入自愈；先补红测，再修 `TerminalView` follow 实时对齐
- [ ] mobile-15.34 QuickBar 老布局回归 closeout：壳体改成三栏，前两栏保持老布局（左侧固定六键 `状态/↑/键盘 + ←/↓/→` + 右侧两行快捷滚动区），第三栏恢复文件/图片/同步/截图工具栏；工具栏不得重复；固定按钮不得超界
- [ ] mobile-15.35 QuickBar keyboard-lift + session-schedule entry closeout：QuickBar editor 聚焦时 UI shell 仍消费 keyboard inset；定时列表入口不再依赖本地草稿，任何 attach 到同一 session 的客户端都可打开当前任务列表并 CRUD
- [ ] mobile-15.36 remote screenshot preview closeout：截图必须显式暴露 `capturing -> transferring -> preview-ready -> save/discard` 单一路径；客户端不得再自动落盘后假装成功。
- [ ] mobile-15.37 remote screenshot fail-fast closeout：`capturing / transferring` 必须有显式失败边界，daemon 和 client 任一端卡住都必须回错误，不允许无限等待。
  - 2026-04-28 新证据：本机 daemon probe 已稳定复现 `capturing -> file-download-error(could not create image from display)`；交互 shell 直接 `screencapture` 正常
  - 2026-04-28 新增上下文对照：daemon bootstrap / `launchctl bsexec` 都失败；shell 直接跑、shell 里 `launchctl asuser` 成功
  - 当前收口顺序冻结：
    1. 先补 UI 红测：失败后必须停在显式 failed，不得继续 spinner / 假 loading
    2. daemon 错误文案改成 launchd 上下文真相，不再误报 GUI/Aqua
    3. 下一轮补“可截图 helper / 非 launchd 负责进程”执行链
- [ ] mobile-15.45 remote screenshot helper closeout：截图能力拆成独立 GUI helper，daemon 只转发请求/回传文件
  - 冻结真源：`docs/decisions/2026-04-28-remote-screenshot-helper-truth.md`
  - 第一版闭环：
    1. daemon 走 Unix socket helper client，不再直接 `screencapture`
    2. mac GUI helper 常驻监听并执行截图
    3. 本机 ws probe 必须真拿到 `file-download-complete`
    4. 自动回归覆盖 helper success / helper unavailable / helper failed
  - 2026-04-28 当前进度：1/2/3/4 已在开发态 + service 安装态跑通
    - helper/client/UI 自动回归：10 tests passed
    - service script 回归：`src/server/daemon-service-script.test.ts` 4 tests passed
    - 本机证据：launchd service restart 后继续拿到 `capturing -> transferring -> file-download-complete`
    - 剩余只是不做 fallback 的产品化启动方式（例如 helper 安装/显式启动入口），不是主链正确性问题
- [ ] mobile-15.45a remote screenshot helper productized startup closeout：helper 需要独立安装/自启动/状态入口
  - 第一版冻结：
    1. `mac/scripts/zterm-screenshot-helper.sh` 提供 `install-service/start/stop/restart/status/uninstall-service`
    2. helper LaunchAgent 拉起 Electron `--screenshot-helper`
    3. helper-only 模式保留明确 app 身份与退出入口，不做黑盒后台进程
    4. helper 未运行时仍只回显式错误，不加 fallback
- [ ] mobile-15.38 QuickBar tool semantic closeout：`文件=文件上传`、`图片=图片上传`、`同步=远程文件同步页`、`截图=远端截图`，不得再错绑到 settings/file-transfer
- [ ] mobile-15.39 session schedule count/window closeout：定时任务新增 `次数上限 + 终止时间`；`maxRuns=0` 表示无限次，默认 `3` 次；daemon 维护 `firedCount / nextFireAt / stop condition`，client 只编辑和展示
- [ ] mobile-15.40 terminal debug truth overlay closeout：沿用 QuickBar `状态` 按钮开关 debug；开启后 renderer 左侧显示每行绝对行号，状态悬浮窗显示当前 `follow / reading` 模式；只做观测，不改 buffer / daemon / renderer 真相
- [ ] mobile-15.41 renderer gap-visible debug closeout：reading/follow 窗口内若 absolute rows 不连续，直接把 gap 画成空背景占位，不等待补齐；debug 绝对行号在相邻不连续时红标
- [ ] mobile-15.42 same-revision stale-prepend closeout：同 revision 的迟到旧 `buffer-sync` 不得把本地 1000 行窗口从 tail follow 态拖回更老历史；只能 patch 当前窗口内 absolute-index truth，先补红测再修 `terminal-buffer`
- [ ] mobile-15.43 follow-ime-relayout closeout：IME 弹起 / viewport 高度变化 / UI shell relayout 触发的 DOM scroll 不得把 follow 误判成 reading；先补“keyboard + live update + bottom input line”红测，再修 renderer
  - 2026-04-28 已验证根因：`pendingFollowViewportRealignRef` 在真实 scroll 到达前被 `syncScrollHostToRenderBottom()` 提前清掉，导致 relayout/live-refresh scroll 被错当成用户回滚
  - 下一步固定顺序：补“快速吐字 / 绝对行号剧烈变化仍保持 follow”红测 -> 收 follow realign 单一路径 -> 全量 renderer 回归
  - 2026-04-28 第一轮收口已落地：`TerminalView` 对**非首屏** viewport relayout 新增 `recentViewportLayoutChange` guard；相关 2 条 renderer 红测已转绿
- [ ] mobile-15.44 debug-line-number-toggle closeout：绝对行号开关从 `状态浮窗` 解耦，放到第三行工具栏显式入口；`状态` 只管浮窗，`行号` 只管 line-number gutter

- 若继续发新 APK，补 `foreground / reading / input` 真机专项证据
- 单独审 daemon `health.sessions.total` bookkeeping 偏大问题

## 当前状态

- 2026-04-25 terminal 真源已重新冻结：`server / buffer manager / renderer / UI shell` 四层独立
- 2026-04-25 已更新 active truth docs：`AGENTS.md`、`architecture.md`、`dev-workflow.md`、`task.md`、`CACHE.md`、terminal skill、terminal truth decision
- 2026-04-25 当前实现目标已收口：
  - server 只回答 head / range，每次回复都带 head
  - buffer manager 总是先问 head，再决定 diff / 三屏重锚 / reading gap repair
  - renderer 只维护 `follow / reading + renderBottomIndex`
  - UI shell 只负责容器位置与裁切
- 当前下一步：先把 cold-start / tab-switch 首屏不刷新收敛成自动复现 case，再继续修实现
- 当前新增冻结：terminal width mode 分成 `adaptive-phone | mirror-fixed`
- 当前新增冻结：`mirror-fixed` 下只允许 renderer crop/pan，不允许 client width 回写 daemon mirror / tmux
- 当前新增冻结：`mirror-fixed` 开启后自动关闭左右滑切 tab
- 当前已解决的一层根因：
  - 旧实现会在 restore / foreground resume 时把 hidden tabs 一起抢连，拖慢 active tab 首刷
  - 当前已改成 active-only eager connect / active-only foreground resume
- 当前 blocker：
  - daemon `health.sessions.total` bookkeeping 仍偏大，需单独审计，但它已不再是 active 首刷慢的主因
  - daemon 仍保留 subscriber 驱动的 mirror 生命周期；`fin` 现场已出现 reconnect 后 `revision 2484 -> 1`、`latestEndIndex 63755 -> 50238` 的 mirror truth reset，和“daemon 只维护 tmux mirror 真相、不受 client 生命周期影响”的冻结设计冲突
  - transport / session 仍未彻底解耦：
    - client 仍是 `sessionId -> wsRefs` 单层真相，没有 `control transport + per-session transport` 分层
    - client reconnect 仍是 `cleanup old socket -> new ws -> fresh connect`
    - transport open 后仍重新发 `connect`
    - daemon 侧虽然已有 `logical session != transport` 雏形，但 ws close 后仍保留 grace close 语义，不符合“只 detach transport”的冻结设计

## Epic-007 Mac ↔ Phone 双向文件传输

### 对应 Beads Epic

- `mobile-16`: 双面板文件传输（远程 daemon FS ↔ 手机本地 FS）

### T1 协议层

- [ ] types.ts 新增 `FileEntry`、file-transfer 消息类型（client → daemon: file-list-request, file-download-request, file-upload-start/chunk/end; daemon → client: file-list-response, file-download-chunk/complete, file-upload-progress/complete）

### T2 Daemon handler

- [ ] server.ts 新增 `handleFileListRequest` / `handleFileDownloadRequest` / `handleFileUploadChunk`
- [x] daemon 通过 `tmux display-message -p '#{pane_current_path}'` 获取 session CWD 作为远程默认路径

### T3 客户端依赖

- [ ] 安装 `@capacitor/filesystem` + `npx cap sync`

### T4 客户端 UI

- [ ] 新建 `FileTransferSheet.tsx`：上=远程文件面板，下=本地文件面板，中间方向按钮，底部传输进度

### T5 集成

- [ ] TerminalQuickBar 浮动菜单新增「文件传输」入口
- [ ] TerminalPage 挂载 FileTransferSheet
- [ ] SessionContext 新增 file-transfer WS 消息路由

### T6 测试

- [ ] file-transfer-protocol.test.ts（消息序列化、chunk 分块、FileEntry）
- [ ] FileTransferSheet.test.tsx（UI 渲染、目录导航、文件勾选）
- [ ] daemon close-loop 集成测试（file-list / download / upload 真实 FS）
- [ ] type-check + regression gate

### 实施顺序

1. types.ts 协议层
2. server.ts daemon handler
3. 安装 @capacitor/filesystem
4. FileTransferSheet.tsx UI
5. QuickBar 入口 + TerminalPage 挂载 + SessionContext 路由
6. 测试 + type-check + build
