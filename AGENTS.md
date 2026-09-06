# zterm Agent Rules

## Scope
- 本仓库是 **app-level repo**，当前主线是 `android/`
- `../wterm` 是 fork runtime repo；移动端只依赖其发布后的 npm 包，不把 runtime 源码混入本仓库

## Truth Sources
- `android/docs/spec.md`：产品范围与验收
- `android/docs/architecture.md`：模块边界、数据流、ownership
- `android/docs/audits/2026-07-02-architecture-boundary-remediation.md`：架构边界整改表；定义功能块 owner、允许/禁止职责、移除/分离/保留决策、防复发 gate
- `android/docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md`：terminal server / buffer manager / renderer / UI shell 唯一真源
- `android/docs/decisions/2026-09-05-runtime-memory-truth.md`：代码核实的当前实现、用户确认的目标架构及待迁移差距；禁止把目标态冒充当前实现
- `android/docs/decisions/2026-08-07-opencode-transcript-mirror-truth.md`：opencode transcript 数据导出 / daemon 只读服务 / client 历史投影边界（独立于 mirror store；数据与控制分离；不写入 mirror/sparse buffer）
- `android/docs/dev-workflow.md`：执行顺序、验证门禁、证据要求
- `android/docs/loops/LOOP.md`：项目 recurring loop 治理入口；当前只启用 L1 report-only 初始化，不启用自动修复
- `android/docs/ui-slices.md`：页面级切片与文件 ownership
- `android/docs/daemon-mirror-test-plan.md`：daemon/tmux mirror 本地验证顺序（当前先 TUI `top` / `vim`，再手机）
- `.agents/skills/terminal-buffer-truth/SKILL.md`：terminal buffer/render/daemon mirror 门禁
- `android/task.md`：当前任务板
- `android/CACHE.md`：短期上下文
- `android/MEMORY.md`：长期经验
- `android/memory/index.md`：分层记忆索引；先读相关条目，再核对其 source_refs，L3/unreviewed 不等于运行态证明
- `android/note.md`：单 owner 项目探索与交接；并发探索使用任务独占 run notes。长期记忆与规则写入按全局授权和唯一 owner 执行
- `android/evidence/`：截图 / 命令输出 / APK / logcat

## Workspace Layout
- `android/`：当前 Android 客户端
- `mac/`：未来 macOS 客户端骨架
- `win/`：未来 Windows 客户端骨架

## Hard Rules
- 不在本仓库复制或内嵌 runtime 源码
- runtime 问题改 `../wterm`，app 问题改 `zterm`
- 先验证，后结论；无证据不宣称完成
- 每次开发 / 修复 / 重构必须先读架构真源，再读代码：
  - 先读 `android/docs/architecture.md`
  - 再读 `android/docs/audits/2026-07-02-architecture-boundary-remediation.md`
  - 再按任务域读对应 decision / feature registry / function map / skill
  - 然后才读代码定位实现点
- 改代码前必须写清楚“本次方法如何对应架构”：
  - 属于哪个功能块
  - 唯一 owner 是谁
  - 当前越界项是 **物理移除 / 分离下沉 / 显式兼容保留** 哪一类
  - allowed paths / forbidden paths 是否匹配
  - 必跑 gate 是什么
- 未完成上述架构映射前，不得直接改实现代码；禁止靠 grep 命中点直接补 patch。
- 客户端目标及迁移状态以 `android/docs/decisions/2026-09-05-runtime-memory-truth.md` 为准；旧架构文档中的 implemented/active 只描述原切片，不证明新目标完成。
- UI 解耦验收必须追踪 slot 下游实现：页面/视图只投影 snapshot 与发出 typed intent；route、session、文件 I/O、media lifecycle 由对应业务 owner 持有。单纯移除组件 import 或增加 render callback 不算业务解耦。
- terminal 链路必须先更新 docs / AGENTS / skill，再补测试，再改代码
- terminal 链路必须保持 `server / buffer manager / renderer / UI shell` 独立，禁止越层漂移
- daemon / buffer manager / renderer 都必须遵守 **读写解耦**：写侧只维护本层真相，读侧只读取当前真相；**请求不得触发上游同步策略**
- daemon 只关心 `tmux -> mirror store`，**不关心也不能关心任何客户端逻辑/状态**；client buffer manager 只关心 `daemon -> local sparse buffer + visible-range gap repair`，**不持有 renderer follow/reading/renderBottomIndex**
- daemon mirror 与正文发布分离：`daemon.mirror_store` 只维护 canonical mirror truth；per-subscriber `buffer-sync` pending/backpressure/head/frame-split 唯一 owner 是 `daemon.buffer_publisher`，mirror runtime 不得重放发布语义
- Herdr adapter 是唯一显式 history/live 分层例外：history tail truth 来自官方 `pane read --source recent --lines N`，canonical frame 只做 live visible tail overlay；该合并只能在 `herdr-backend-runtime` adapter 内完成，mirror store 不得再拆第二语义，不得把 1000 行 history 放进 33ms capture loop
- renderer 是唯一可见窗口真相：只负责 `follow / reading / renderBottomIndex / visible range`；有 gap 先画空白，占位后等 buffer patch 按行/区间重刷
- 一个带 `frameChunkCount > 1` 的 `buffer-sync` 是一个不可分割的 authoritative frame；`resource.client_buffer_frame_assembly` 是独立于 `resource.client_sparse_buffer` 的必需 per-session resource，先按 frame identity 暂存并验证 `[frameStartIndex, frameEndIndex)` 完整连续覆盖，再经唯一注册 edge 一次性 apply 和触发一次 renderer commit。frame rejection 必须保存 exact frame repair range；只有 repair 请求实际写入 wire 才把 `pending` 改为 `dispatched`，每个 revision 最多 dispatch 一次。禁止把 assembly resource 设为 optional，禁止逐 chunk 发布新旧混合 body、禁止缺 chunk 时提升 local revision、禁止旧/冲突 frame 覆盖已发布 truth
- terminal transport/session 也必须解耦：**client session / active tab / foreground-background / viewport / reconnect 心智只属于客户端**；daemon 只允许持有物理 transport、自身 mirror、自身 tmux truth；inactive tab 只停取数，不得关闭客户端 session / transport 真相；foreground/background/tab switch 不得 fresh recreate transport
- daemon transport detach/close 只释放对应 physical subscriber；最后一个 subscriber 消失时，terminal runtime 必须释放该 mirror 的 daemon-owned buffer/input/timer 资源，但不得调用 `tmux kill-session`。同一 tmux target 仍有其他 attach 时必须保留 mirror 与其他 subscriber；`bodySubscribed=false` 仍是物理连接，不触发 zero-subscriber release。
- mux 物理 transport 完成 `mux-hello` 后只允许 `TerminalMuxServerFrame` / `TerminalMuxClientFrame`：target 控制事实只能走 `mux-target-message`，session 业务只能走 `mux-channel-message` / `mux-channel-binary`。禁止任何 owner 向已协商 mux 的物理 transport 裸发 `BridgeServerMessage`；物理 sender 类型必须显式接受协议 wire-frame union，禁止 `as unknown as` 绕过类型锁。
- mux channel open 必须原子：target 控制事实发布失败时，mux lifecycle owner 必须删除 channel registry、关闭 subscriber、发送显式 `mux-channel-closed` error，并禁止进入 attach。禁止空 catch、保留未 attach 的 phantom channel、或让业务 channel 错误污染控制线。
- daemon/server 禁止持有任何客户端状态机或客户端身份真相：
  - 禁止 `logical client session`
  - 禁止 `clientSessionId` 成为 daemon 内部真源
  - 禁止 `readyTransportId / session transport token / attach-resume state machine`
  - 禁止 `active tab / foreground / background / viewport / width mode / pane` 进入 daemon 真相
  - 若 wire 上暂时存在相关字段，只允许作为**兼容入参/透传字段**，不得在 daemon 内部成为状态 owner
- 多客户端必须以 daemon 无客户端心智为前提：
  - 多个客户端/多个 transport 可以并行订阅同一 tmux mirror
  - daemon 不负责协调哪个客户端 active、不负责客户端去重、不负责客户端恢复策略
  - daemon 只维护 tmux truth、mirror truth、物理连接与基础读写接口
- terminal 宽度模式必须显式区分：
  - `adaptive-phone`
  - `mirror-fixed`
- `adaptive-phone` 必须由 daemon 唯一 adaptive width lease owner 处理：记录客户端 `{ cols, heartbeatAt }`，按 active adaptive holders 聚合最窄 cols，并只在该 owner 内执行 `resize-window -x <cols>` 让 tmux 真实重排
- adaptive lease owner 之外不得执行 `resize-window`、读写 `window-size`、写 `@zterm_adaptive_width_*`、修改 tmux option、或根据 foreground/background/viewport/UI 状态恢复/改写 tmux geometry；最后一个 adaptive holder 消失时，lease owner 必须恢复/释放本轮 tmux width ownership
- daemon 请求 tmux 重排后不得自写 mirror truth；`mirror.rows/cols/bufferStartIndex/bufferLines/cursor` 仍只能来自 tmux capture/readback
- `mirror-fixed` 下，client viewport / IME / 容器宽度变化**不得**改写 daemon mirror / tmux 宽度；renderer 只能裁切和横向平移
- `mirror-fixed` 的手势归属按 terminal decision 与 `terminal-buffer-truth`：横向 pan 生效时不得与 tab swipe 争用；没有 pan 链时不得仅因模式名禁用唯一横向交互出口
- 不提交大批 evidence / 构建物 / node_modules
- MemPalace / 本地搜索只允许代码、文档、项目记忆、local skill 等源文件；`wing=zterm` 必须通过 `scripts/mempalace-mine-zterm.sh` 生成安全语料后再 mine，禁止直接索引仓库根目录；生成物、构建物、release/update 包、evidence、缓存目录、依赖目录不得进入搜索语料或本地搜索结果

## Build Defaults
- 根目录命令应代理到 `android/`
- Android 原生工程路径：`android/native/android`
- npm 依赖真源：发布后的 `@jsonstudio/wtermmod-*`
- 新 APK 交付必须同步 OTA。构建/发布流程唯一执行入口为 `pnpm --dir android run build:android`；具体步骤、授权范围及包身份验证见 mobile skill。该入口会分配 buildNumber、构建 normal/rollback APK，并写入本地 OTA；不能把它当只读 build 检查。
- 纯审计/文档修复不 bump、不构建 APK、不发布。已授权的新版本交付需同时证明包、安装态与适用 OTA 通道；没有发布授权时先完成可审阅变更与适用检查，再报告发布缺口，不能宣称已交付。
- 设备端 OTA 检查的是 daemon 的 `~/.zterm/updates/latest.json`；手工 `adb install` 只影响单台设备，不替代 OTA 发布
