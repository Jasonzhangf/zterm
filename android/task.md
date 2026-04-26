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
- [ ] mobile-15.10 Android IME closeout：修正 `ImeAnchor` 的 stale show / 前台自动弹键盘 / 异常九宫格态，保证只有显式点键盘按钮才 show，且输入后必须进入 `input -> head -> buffer-sync -> render` 闭环
- [ ] mobile-15.11 buffer store closeout：把 client 本地 buffer trim 真相从“3 屏”改回“1000 行 sliding window”，请求窗口仍保持三屏，不再混用
- [ ] mobile-15.12 daemon mirror lifecycle closeout：daemon mirror 不能再跟 subscriber 生命周期绑定；当前 `orphan destroy -> mirror recreate` 会把 `revision/latestEndIndex` 重置，破坏 daemon 绝对行号真相并触发 client revision-reset 链路
- [ ] mobile-15.13 daemon client-session bookkeeping closeout：`destroyMirror()` 当前会把 subscriber 标成 `closed` 但不 `sessions.delete()`，现场 `/health` 已出现 `170 total / 1 connected`
- [ ] mobile-15.14 terminal 测试矩阵 closeout：把 checklist 映射到现有自动测试与缺口，固定补测顺序（voice/CJK commit、follow overdrag blank-frame、buffer truth reset violation、payload inflation）
- [ ] mobile-15.15 renderer follow-state closeout：live tail refresh / pending follow realign 不得把底部 follow 自动打进 reading；先补本地回归，再修 renderer 状态机

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
- 当前已解决的一层根因：
  - 旧实现会在 restore / foreground resume 时把 hidden tabs 一起抢连，拖慢 active tab 首刷
  - 当前已改成 active-only eager connect / active-only foreground resume
- 当前 blocker：
  - daemon `health.sessions.total` bookkeeping 仍偏大，需单独审计，但它已不再是 active 首刷慢的主因
  - daemon 仍保留 subscriber 驱动的 mirror 生命周期；`fin` 现场已出现 reconnect 后 `revision 2484 -> 1`、`latestEndIndex 63755 -> 50238` 的 mirror truth reset，和“daemon 只维护 tmux mirror 真相、不受 client 生命周期影响”的冻结设计冲突
