# ZTerm Cordis v2 重建执行计划

## 目标

在独立 worktree 中建立完整 v2 分支：保持 v1 当前生产版本的用户可见功能和
业务 payload 语义，改用共享 domain core、每进程 Cordis application kernel、
平台宿主、framework-neutral UI plugin ABI。Android、macOS、Windows、iOS
共享核心契约与行为测试；平台差异留在 host/adapter；终端数据面不经过 Cordis。

## 完成合同

完成定义：

1. v1 parity matrix 覆盖现有功能、入口、错误、生命周期、性能基线；
2. resource/module/function/mainline/verification maps 与真实源码一致；
3. shared core、kernel、Cordis adapter、platform host、UI plugin 边界有机器门禁；
4. Android/Mac/Windows 包装运行路径通过真实 smoke；iOS 至少通过 host contract、
   simulator/package gate，真实设备 gate 未完成前不得宣称 iOS 完成；
5. 终端、文件、视频、输入、mirror、WebRTC 等高吞吐路径保留专用 data stream；
6. 每个阶段有 Evidence、独立定向 commit、handoff/merge claim；
7. 最终 AGY Review 只能在实现、构建、安装/重启、在线样本、parity 全部通过后运行。

## 执行原则

- v1 生产分支只读对照，不在主 tree 改写。
- 每个阶段先更新 map/test design，再写红测，再实现，再验证。
- 阶段 worker 只使用自己的 clean worktree；不共享 worktree，不写另一个 worker 的 run notes。
- 一个阶段完成后，先写 evidence/handoff，再释放阶段 claim；后继阶段只能从已验证 commit 开始。
- 不做 fallback、shadow route、双 owner、静默裁剪或“先复制旧实现以后再删”。
- 代码/配置/测试边界采用逐文件 `apply_patch`；禁止脚本批量语义替换。

## 阶段与并发 claim

### Phase 0 — Baseline and governance admission

Owner claim: `zterm.v2.phase0.governance`

基础工作：锁定 v1 production commit；建立 parity catalog；补根级 resource/module/
function/mainline/verification maps、模块 registry、phase manifest、wiki review 面；
建立跨平台 CI/build 骨架。只改文档、manifest、gate scaffold，不改运行时。

并发任务（互不重叠）：

- `zterm.v2.phase0.parity.catalog`：盘点 Android/Mac/Windows 现有功能与 live gates；
- `zterm.v2.phase0.map.registry`：建立 shared/kernel/host/plugin 机器注册表；
- `zterm.v2.phase0.wiki.ci`：建立 Mermaid/HTML review 面和 CI 入口。

退出证据：clean worktree、maps parse、source ownership baseline、v1 parity catalog、
`pnpm` 根级 lint/type gate 能运行。未通过不得开 Phase 1。

### Phase 1 — Framework-neutral shared contracts

Owner claim: `zterm.v2.phase1.shared.contracts`

基础工作：提取 `@zterm/domain-core`、`@zterm/runtime-contracts`、`@zterm/ui-contract`
边界；消除 shared plugin contract 对 ReactNode 的依赖；定义 command/event/error/
snapshot/stream/plugin/UI contribution contracts；加入正反 schema gates。

并发任务：

- `zterm.v2.phase1.domain.core`：session/route/action/state/selector 纯契约；
- `zterm.v2.phase1.runtime.contracts`：control/data/debug/error/gateway/stream 契约；
- `zterm.v2.phase1.ui.contract`：surface/view-model/action/plugin manifest 契约。

依赖：Phase 0 maps。禁止 Cordis、React、平台 imports。

退出证据：shared package typecheck、schema positive/negative、payload isolation gate、
跨模块 DAG gate。

### Phase 2 — Kernel and CordisAdapter Playground evaluation

Owner claim: `zterm.v2.phase2.kernel.cordis.adapter`

基础工作：实现 framework-neutral composition kernel；在 Playground 固定 Cordis 版本，
实现唯一 `CordisAdapter`；验证 service/capability/plugin lifecycle 与异常回收；验证
Cordis 不拦截 terminal data stream。

并发任务：

- `zterm.v2.phase2.kernel.lifecycle`：composition/capability/control/observability；
- `zterm.v2.phase2.cordis.adapter`：Cordis mapping、version pin、dispose/error proof；
- `zterm.v2.phase2.stream.boundary`：gateway/data stream 与 Cordis event 反向 gate。

依赖：Phase 1。Cordis 评估失败时显式停止并修 adapter/contract；禁止另造 plugin system。

退出证据：Playground evidence、Cordis package lock、lifecycle positive/negative、hot-path
non-interception proof。仅评估通过后才能进入 Phase 3。

### Phase 3 — Platform hosts and gateways

Owner claim: `zterm.v2.phase3.platform.hosts`

基础工作：为 Android Service/WebView、iOS host、macOS Electron、Windows Electron
建立 typed `RuntimeGateway`；保留各平台 native lifecycle、权限、窗口、后台和文件/网络
owner。每个进程单独 kernel/context。

并发任务：

- `zterm.v2.phase3.android.host`：Service/WebView bridge 与 foreground lifecycle；
- `zterm.v2.phase3.desktop.hosts`：Mac/Windows main-preload-renderer gateway；
- `zterm.v2.phase3.ios.host`：iOS host contract、Capacitor/WKWebView adapter skeleton。

依赖：Phase 2。禁止跨 host 共享 Cordis object/native object。

退出证据：各 host typecheck/build、IPC codec tests、stale generation/error tests、
Android/Mac/Windows packaged smoke；iOS simulator gate。

### Phase 4 — Domain/runtime parity kernel

Owner claim: `zterm.v2.phase4.runtime.parity`

基础工作：把 v1 session/route/control/projection 行为接到 shared domain + kernel gateway；
不搬迁终端 buffer/renderer/data path。逐 feature 建立 parity oracle。

并发任务：

- `zterm.v2.phase4.session.route`：session/target/route/connection projection；
- `zterm.v2.phase4.control.error`：control center、idempotency、deadline、Error chain；
- `zterm.v2.phase4.persistence.settings`：settings/account/update projection contract。

依赖：Phase 3。每个任务只拥有自己的 feature slice 与 registry entries。

退出证据：v1/v2 exact behavior replay、positive/negative lifecycle tests、build/package。

### Phase 5 — Dedicated terminal/data-plane preservation

Owner claim: `zterm.v2.phase5.terminal.data-plane`

基础工作：接入现有 verified terminal owners：transport/session/channel、mirror、buffer
frame assembly、sparse buffer、render window、DOM renderer、reliable input、file/video
streams。Cordis 只编排生命周期，不接收 body/high-frequency stream。

并发任务：

- `zterm.v2.phase5.terminal.transport`：physical transport/channel/generation；
- `zterm.v2.phase5.terminal.buffer-render`：frame assembly/sparse/render DOM chain；
- `zterm.v2.phase5.file-media-input`：file/video/input dedicated streams and backpressure。

依赖：Phase 4。严格遵守 terminal-buffer-truth skill；完整 frame 一次 apply，缺口显式
repair，禁止请求触发上游同步策略。

退出证据：daemon mirror close-loop、source-to-DOM、input, file/media, weak-network and
reconnect live evidence；正反测试成对。

### Phase 6 — React UI adapter and plugin migration

Owner claim: `zterm.v2.phase6.ui.plugins`

基础工作：实现 `@zterm/ui-react`；将 UI surface 按插件迁移：debug、session drawer、
file browser、settings/update、remote window、quickbar、terminal shell。每次 cutover
物理删除旧直连路径。

并发任务：

- `zterm.v2.phase6.react.adapter`：React surface/view-model/action adapter；
- `zterm.v2.phase6.low-risk.plugins`：debug/session drawer/file/settings；
- `zterm.v2.phase6.terminal.plugins`：remote window/quickbar/terminal shell。

依赖：Phase 5。plugin 只能读 projection、发 action；不能 import raw runtime owner。

退出证据：UI ownership red tests、render/source DOM、IME/gesture/desktop interaction、
Android/Mac/Windows package smoke。

### Phase 7 — Cross-platform parity and iOS completion

Owner claim: `zterm.v2.phase7.platform.parity`

基础工作：补齐 iOS renderer/host、Windows real package/ConPTY、Mac packaged terminal，
统一 surface registry 与 platform layout profile；执行全功能 parity matrix。

并发任务：

- `zterm.v2.phase7.ios.device`：iOS device lifecycle/permissions/IME/terminal smoke；
- `zterm.v2.phase7.windows.live`：Windows packaged/ConPTY/transport/input smoke；
- `zterm.v2.phase7.desktop.parity`：Mac/Windows shared UI behavior and package gates。

依赖：Phase 6。未有真实设备/包装证据的 platform 维持 incomplete，不得 fallback 宣称完成。

退出证据：四平台 parity report、package hashes、live evidence、known gaps。

### Phase 8 — Cutover review and ship

Owner claim: `zterm.v2.phase8.closeout`

基础工作：主 tree 精确合并已完成 claims；运行全局 gates、安装/重启/在线旧样本；执行
AGY Review；确认无第二 owner、fallback、旧路由复活；最终 commit/push 前检查 staged scope。

并发任务：

- `zterm.v2.phase8.architecture.audit`：registry/import/call/DAG/payload audit；
- `zterm.v2.phase8.runtime.replay`：四平台 parity/live replay evidence；
- `zterm.v2.phase8.release.audit`：package/update/version/commit scope audit。

依赖：Phase 7。任何代码改动使旧 evidence/review 失效，必须重跑受影响闭环。

## 交接协议

阶段 worker 完成时必须写：

1. `.agent-collab/runs/<run_id>/evidence.jsonl`：命令、commit、输入、输出、证据路径；
2. `.agent-collab/handoff/<claim>.json`：owner、base、change set、gates、remaining risk；
3. `docs/architecture/zterm-cordis-v2-phase-manifest.json` 对应状态与 evidence 引用；
4. 只交付 clean worktree 上的精确 change set；不得把半成品同步主 tree。

主 tree 合并后重新跑受影响验证，再由独立 checker 释放 claim。claim 绑定语义，不绑定
文件；同一 feature/resource/mainline node 同时只能有一个 owner。

## 下一步

执行 Phase 0 三个并发 claim；先生成 v1 parity catalog 和机器 maps，再进入 shared
contracts。Phase 0 未通过前，不安装 Cordis、不改生产 runtime、不迁移 UI。
