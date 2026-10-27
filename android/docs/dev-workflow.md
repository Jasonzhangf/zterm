# zterm Android Dev Workflow

## 总原则

- 先确认受影响流程与唯一 owner，再写代码
- 先审计节点笔记，再验证；已确认且未失效的证据直接复用，不重复确认同一事实
- 先证据，再宣称完成
- 先确认适用契约，再继续实现；长期记忆/规则写入遵守全局授权

任务事实记入现有 run notes；项目结论由 owner 汇总到 `android/note.md`。复用有效证据，只在输入变化、出现新错或具体动作边界补查受影响事实。通用执行、Review、交付和记录方法沿全局 `coding-principals`，不在此另建流程。

## 标准流程

```text
Scope/Architecture -> Contract -> Implement -> Verify -> Review -> Authorized delivery
```

## 任务开始前

非平凡变更在现有计划中写清目标、范围、真实验收入口和未确认项。纯文档/Skill 修订直接修改并做针对性检查，不为此新建任务表或审批步骤。

Android build/test 会解析 `@zterm/shared` 的部分出口到 `packages/shared/dist`。正常 `pnpm install` 会通过 shared 的 `prepare` 生成该产物；若跳过 install 或依赖已存在，先运行 `pnpm --dir packages/shared run build`。

## 开发阶段

- 每次只做一个可验证切片
- 只改本轮需要的文件
- runtime 改动不凭编译通过结论收口
- 页面级重构先按 `docs/ui-slices.md` 切片，不跨页混改
- 改动前必须先按 `docs/feature-registry.json` 选定 `feature_id`，确认 owner、allowed paths、forbidden paths、required gates；找不到 feature registry 条目时，不得宣称功能闭环完成
- 跨模块或长期 runtime 重构按受影响关系查阅以下真源；只更新实际改变的 owner、resource、edge 或公开契约，不要求每次同步整份索引：
  - `docs/resource-registry.json`
  - `docs/module-registry.json`
  - `docs/edge-registry.json`
  - `docs/function-map.md`
  - `docs/wiki/mainline-call-map.json`
  - `docs/wiki/mainline-source.md`
  找不到唯一 module/edge owner 时，先补 registry 和 gate，不直接改 runtime。

## Feature Registry 门禁

- 功能 map 真源：
  - `docs/feature-registry.json`
  - `docs/function-map.md`
  - `docs/feature-gates.md`
  - `docs/wiki/daemon.md` — daemon runtime owner walkthrough for new features touching server
  - `docs/wiki/cli.md` — CLI command contract for new public subcommands
  - `docs/wiki/mainline-source.md` — source ownership for Android / daemon / CLI
  - `docs/wiki/modules.md` — module / edge review surface
  - `docs/wiki/mainline-call-map.json` — machine-readable mainline call map for Android / daemon / CLI wiki nodes
  - `docs/module-registry.json` — machine-readable daemon/client/shared/relay/release/observability module ownership
  - `docs/edge-registry.json` — machine-readable allowed cross-module resource edges
- import 级机器门禁：`src/lib/module-import-graph-truth.test.ts`
  - module registry `owned_paths` 必须覆盖 src 全部非测试源文件，每个文件恰好一个 owner
  - 真实 import 图的每条跨模块边必须命中 edge registry `import_edges`，双向 lockstep（代码里没有的声明边必须删除）
  - `pending_removal` 是显式违规清单，只允许减少
  - 新增源文件或新增跨模块 import 时，必须在同一变更集里补 `owned_paths` / `import_edges`，否则 gate 红
- 任何功能修复或重构必须先完成：
  1. 定位 `feature_id`
  2. 确认唯一 owner
  3. 确认变更文件位于 `allowed_paths`
  4. 若跨模块，确认 `module_id` 和 `edge_id`
  5. 补齐或运行 `required_gates`
- 若实现需要越过当前 owner 边界，先改 registry 与 truth gate，再改行为代码；禁止直接在 forbidden path 打补丁

## 设计参考使用规则

- 先冻结主参考图和次参考图，再进入实现
- 实现时优先对齐信息结构和交互结构，不先做视觉细节抛光
- 如果当前 UI 与参考图冲突，先修布局和入口结构，再修功能细节
- 参考图只约束 UI 结构，不替代功能验证

## 跨尺寸布局 / Mac 共享壳门禁

- 任何 phone / tablet / foldable / split-screen / Mac 相关布局变更，先更新 `docs/decisions/0001-cross-platform-layout-profile.md`
- 再同步受影响的 `architecture.md`、`ui-slices.md` 与门禁；执行状态写任务独占记录，长期记忆和 skill 仅在已授权且有新知识时更新，不复制同一规则
- page component 内禁止散落 breakpoint / platform 分叉真源；统一由 layout resolver 输出 profile
- 大屏实现优先复用**一行多列 + 垂直分屏**的 phone-sized pane 编排，不允许先做一套 desktop-only 页面再“反推兼容”
- future Mac 的实现也必须先沿 shared app-layer / platform shell 的边界推进，不能把 Android 页面逻辑复制一份到 `mac/`


## Protocol freeze 门禁

- terminal wire protocol 的唯一真源固定为：
  - `packages/shared/src/connection/protocol.ts`
  - `packages/shared/src/connection/types.ts`
- `android/src/lib/types.ts` 只能 re-export shared wire type；不得再本地复制 `ClientMessage / ServerMessage / HostConfigMessage / Buffer*Payload`
- 任何协议变更必须按顺序：
  1. 先更新 shared protocol/types 真源
  2. 再补 source gate / contract test
  3. 再改 daemon / client consumer
- 任何“只为性能”做的改动，不允许通过裁剪既有 payload 语义达成
- 客户端巨型文件拆分只能做 ownership 下沉，不得借拆分之机修改 wire 行为

## Terminal buffer 重构门禁

- 任何 terminal buffer / scroll / cursor 改动，先更新：
  - `docs/decisions/2026-04-23-terminal-head-buffer-render-truth.md`
  - `.agents/skills/terminal-buffer-truth/SKILL.md`
  - `docs/daemon-mirror-test-plan.md`
  - `docs/terminal-test-loop-checklist.md`
- 未完成 ownership 拆分前，禁止继续在 `TerminalView.tsx` 叠加 projection / anchor / scroll patch
- daemon 侧提交前必须证明：它只维护 session canonical truth，只回答 head / range，且每次回复都带 head；不承载显示逻辑，不承载策略，也不持有任何 client 状态机
- client 侧提交前必须证明：
  - buffer worker / renderer container / UI shell 已拆开
  - buffer worker 不持有 `follow / reading / renderBottomIndex`
  - renderer 是 visible range 唯一真相
  - gap 策略是“先空白占位，再按行/区间 patch”
  - transport 是长期复用长链接，foreground/background/tab switch 不得 fresh recreate transport

### Terminal 修复与真实验收

先核对受影响 DAG、owner 和契约，再取得失败证据、修改 owner、运行同入口回归。只更新实际改变的文档契约，不能用事后解释性测试或用户手试代替作者验证。

选择与本次失败模式相关的自动用例；完整 Android terminal 交付的场景集见下方 L5，不在每次编译前重复执行整套流程。影响 Android 真机行为时仍必须完成 L5 安装态验收；纯 CLI/daemon 变更按其正式入口验收，不能强制收集未受影响的 Android buffer/renderer 日志或重建 APK。

故障跨越的层级需有对应证据。用已有时间线、oracle 和安装态结果回答问题，不要求每层另交一份日志或在用户报告中逐项复述。无法在真实入口复现并验证的线上问题，不宣称已修复。

“白屏 / 花屏 / 输入后再也不能输 / 语音转文字后不自动刷新 / 5MB 峰值”还需执行 `docs/terminal-test-loop-checklist.md` 中受影响的专项检查，不能只用通用回归替代。

## 验证层级

### L1 Unit

- `pnpm --filter @zterm/android type-check`
- 单元测试（如有）

### L2 Function

- 浏览器主路径验证
- 结构验证可使用 portless 输出的 `*.localhost` 地址
- WebSocket/tmux 真连通验证优先使用 `pnpm --filter @zterm/android preview -- --host 127.0.0.1 --port 4173` 的 HTTP 入口，或直接使用 APK/真机
- 新增主机、保存、连接
- 检查 `Connections` 页结构是否和参考图一致
- 检查终端页顶部/底部栏是否和参考图一致
- 若涉及响应式布局，至少补 phone 单 pane + 一个单行双列或三列 profile 的结构验证

### L3 Orchestration

- 多 Tab、切换、关闭、重连

### L4 Runtime

- `pnpm --filter @zterm/android build`
- `npx cap sync android`
- 真机或模拟器安装态验证
- 检查安全区、顶部点击区、底部快捷栏可用性
- 若 Android 需要直接连 `ws://` tmux bridge，Capacitor WebView 必须允许 cleartext：`androidScheme=http` + `usesCleartextTraffic=true`

### L5 Terminal closed loop（terminal 改动必跑）

按 `docs/daemon-mirror-test-plan.md` 至少跑：

- initial connect
- cold start single tab first paint
- switch to another tab first paint
- foreground resume
- input latency
- reading scroll
- input exits reading
- daemon restart recover

并且每个 case 都要同时对齐：

- tmux truth
- daemon head/range
- client buffer
- renderer commit
- 真机画面

若本机已连 `adb` 设备，提交前额外执行：

```bash
pnpm --dir android test:android:terminal-real-device
```

该脚本会固定落盘：
- APK 安装/启动结果
- IME 前后截图与 `dumpsys input_method/window`
- WebView localStorage 导出的 bridge/session 真源
- daemon `/debug/runtime` snapshot/logs
- `input -> head -> applied -> render` 时间线

若 `adb devices -l` 为空，则只能交付 APK 与自动 gate 结果，不能宣称真机闭环完成。

## 证据要求

证据默认落本地 `evidence/<date-task>/`，不提交到 GitHub 主线。按受影响行为保留必要结果：界面用截图或 DOM，运行错误用日志，Android 安装交付记录 APK 与安装态；不为纯文档、CLI 或 daemon-only 变更生成无关 APK、截图和日志。用户反馈先说明可用结果、必要入口和剩余限制，详情链接到现有记录，不逐项重复 gate 清单。

### Terminal 失败模式证据

buffer / render / input / foreground 修复按实际失败链选择时间线或结构化日志，不要求两者重复记录同一事实。受影响用例须排除对应反例：

  - `localEndIndex > daemon.availableEndIndex`
  - `requestStartIndex == requestEndIndex`
  - `buffer-head` 误当 pull ack
  - `buffer-sync-request` 因 head-only reply 卡住 in-flight pull
  - cold start / tab switch 后 `pullHz == 0 && renderHz == 0`

## UI 结构变更的证据

只采集受影响页面和状态；键盘/快捷栏问题包含展开态。未改变的 Connections 页或终端页不重复截图。

## 响应式布局变更的附加证据

- phone 单 pane 截图
- foldable / pad / split-screen 任一**单行多列**截图
- 若改变 Mac 布局，补对应桌面窗口的布局证据
- 说明当前截图对应的 layout profile 名称，避免“看起来差不多”但真源不一致

## 记忆规则

- 任务独占 run notes：探索、假设、失败、证据与交接；`note.md` 只供单 owner 汇总，不作为并发事件池
- `CACHE.md`：本轮短期上下文
- `MEMORY.md`：可复用长期经验（只收已验证结论）
- `memory/index.md`：分层记忆入口；条目中的目标设计与实现证据分别判定
- `SKILL.md`：跨任务门禁和反模式

记录与复用方法沿全局 `coding-principals`。有明确记忆写入授权后，读目标及前序记录、去重，再写入唯一 owner；没有新知识则不写。用户要求修复 skill/规则时，只修改已确认的冲突和相关执行入口。

## skill 更新触发

以下是评估更新的触发条件，不自动授予持久化规则写入权限：

- 出现新门禁
- 出现新反模式
- 出现可复用动作
- 出现重复失败模式
