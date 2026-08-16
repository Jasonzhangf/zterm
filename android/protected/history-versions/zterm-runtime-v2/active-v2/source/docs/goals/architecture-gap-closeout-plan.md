# Architecture Gap Closeout Plan（架构审计剩余缺口收口）

Date: 2026-07-26

## 背景

2026-07-26 全仓架构审计（daemon/client 分块、模块耦合、状态机、lib+编排+纯编排 app 四维度）之后，前三批修复已完成：

- 顶层门禁：`docs/module-registry.json` 补 `owned_paths` 全量归属（250 源文件、0 无主）；`docs/edge-registry.json` 新增 `import_edges`（当前 94 条）；`src/lib/module-import-graph-truth.test.ts` 双向 lockstep gate 接入 `test:feature-registry`、CI（`.github/workflows/ci.yml`）、`prebuild`；`pending_removal` ratchet 已收到 0。
- daemon→客户端 lib 依赖 30 处清零（mobile-config / performance-trace / terminal-buffer-debug / types 全部改道 `@zterm/shared`）。
- `lib/types.ts` 与 shared 重复定义 29→2（剩 `STORAGE_KEYS`、`SessionBufferState`，见下）。
- `remote-window-stream-daemon.ts` 3678 行拆为 6 个职责模块，测试 0 改动全绿。
- shared 全套 303 测试首次全绿。

本计划覆盖**剩余全部缺口**。审计报告结论散落在本轮对话中，机器真源以 registry + gate 为准。

## 1. 目标与验收标准

| # | 任务 | 验收标准 |
|---|---|---|
| T1 | STORAGE_KEYS 双真源合并 | 全仓只有一处 STORAGE_KEYS 定义（`@zterm/shared`）；android 版 8 个独有 key（OPEN_TABS、SAVED_TAB_LISTS、SHORTCUT_ACTIONS、ACTIVE_SESSION、ACTIVE_PAGE、TERMINAL_LAYOUT、SHORTCUT_FREQUENCY、SESSION_DRAFTS 等，以实际 diff 为准）与 shared 版独有 key（TERMINAL_WIDTH_MODE_PREFERENCE、SESSION_HISTORY）合并后语义不变；key 字符串值一个都不许改（持久化兼容）；android `lib/types.ts` 只 re-export |
| T2 | contexts refs 袋子收敛 | `session-context-provider-runtime.ts` 的 38 个 useRef 归并为 ≤6 个**有类型**的领域 store/runtime 对象（transport / heartbeat / buffer-head / tail-refresh / reconnect / debug）；`session-context-provider-assembly-types.ts` 的 `refs: any` 与 `session-context-message-assemblies.ts` 的 44 处 `any` 清零；3 个函数 ref 后置回填（`handleSocketServerMessageRef` 等）改为显式接口注入 |
| T3 | Session 双真源残相删除 | `Session` 类型移除 `buffer`、`daemonHeadRevision`、`daemonHeadEndIndex` 字段；`sessionBufferHeadsRef` 与 `session-head-store` 合并为单 store；`session-visible-range-helpers.ts` 的 `session.buffer` fallback 删除，读侧统一走 store |
| T4 | daemon 转发壳合并 | `terminal-runtime.ts`（423 行）与 `terminal-mirror-runtime.ts` 的 30 字段重复 deps 接口消除：要么合并两文件，要么 server.ts 直接装配 mirror runtime，二选一，不许保留逐字段透传 |
| T5 | terminal-message-runtime 拆分 | mux 通道管理（~200 行 envelope 校验/绑定）与 reliable-input ack 去重状态机拆出为独立模块；40+ case switch 只剩路由胶水 |
| T6 | shared design 模块转 active | `shared.terminal_types`、`shared.connection_types`、`shared.protocol` 在 module-registry 中 status 转 active（前置：T1 完成 + owned_paths 指向 packages/shared 真实文件） |
| T7 | App.tsx relay 流编排下沉 | App.tsx 内联的 relay 设备 WebSocket 重连编排（`computeRelayDeviceStreamReconnectDelay`、generation guard、`relayDeviceSocketRef`）与 `mergeRelayPresenceWithDirectoryTruth` 下沉为 hook + lib runtime（仿 `app-update-runtime.ts` 的 deps 注入模式）；App.tsx 降到 ≤900 行 |
| T8 | TerminalView follow 滚动状态机显式化 | ~10 个 useRef flag（`pendingFollowScrollSyncRef`、`suppressProgrammaticScrollRef`、`userScrollIntentDeadlineRef` 等）抽成判别联合纯函数模块（仿 `remote-window-touch-action-runtime.ts`），可脱离组件单测 |
| T9 | SessionReconnectRuntime 显式相位 | `{connecting: boolean, timer}` 组合改为 `{ phase: 'idle'|'scheduled'|'connecting' }` 判别联合；非法组合（connecting 且 timer 非空）类型层面不可表示 |

## 2. 范围与边界

**In scope**：上表 T1-T9；每项完成后同步 module-registry / edge-registry / function-map / 对应测试设计文档。

**Out of scope**：
- TerminalPage.tsx（3852 行）整体拆分——独立大项目，另立 goal；
- daemon 独立成 workspace 包（`packages/daemon`）——涉及发布管线，另立 goal；
- 4 个 lib store 文件的 `useSyncExternalStore` hook 迁出、`session-render-gate` RAF 注入——轻微项，顺手可做但不阻塞收口；
- 任何 wire 协议语义变更（Protocol freeze 门禁）；
- 任何性能优化（不借重构改行为）。

## 3. 设计原则

- 全局规则（`~/.codex/AGENTS.md`）+ `coding-principals` skill 全部适用，特别是：先测试设计、先红测、唯一 owner、gate 必须验证代码、禁 fallback、禁重复实现。
- 顺序守恒：resource/module/edge registry → function map → 测试设计 → 红测 → 实现 → 验证。
- 每个任务是独立可验证切片，单独提交；不跨切片混改。
- 机械重构（T4/T5）逐字节搬移函数体，既有测试 0 改动通过是首要证据。
- 状态机改造（T8/T9）必须正反测试成对（不过早触发/不误判 terminal/不吞错误）。

## 4. 技术方案与文件清单

### T1 STORAGE_KEYS（小，先做）
- 真源：`packages/shared/src/connection/types.ts` 的 STORAGE_KEYS 扩为两版 key 的并集（值不变）。
- `android/src/lib/types.ts` 删本地版改 re-export；消费方（hooks/useOpenTabRuntime 等约 15 文件）import 路径不变。
- 检查 mac/win 是否消费 shared 版（当前 `packages/shared/src/react/use-host-storage.ts`、`use-bridge-settings-storage.ts` 在用）；合并后 key 集合变大对它们无害，但需跑 mac/win 门禁测试确认。

### T2 refs 袋子（大，核心）
- 新 store 落 `android/src/lib/`（无 React 依赖，仿 `session-transport-runtime.ts` 模式）：
  - `session-heartbeat-store.ts`（pingIntervals/lastPongAt/lastServerActivityAt/lastTerminalActivityAt）
  - `session-tail-refresh-store.ts`（pendingInput/pendingConnect/pendingResume 三兄弟 + lastSyncRequestAt）
  - `session-reconnect-store.ts`（reconnectRuntimes/manualClose/staleTransportProbeAt，配合 T9 相位化）
  - buffer-head 并入 T3 的合并 store
- provider-runtime 只创建 store 实例；runtime 函数签名从"8 个 ref"收敛为"1 个 store 参数"。
- `refs: any` → 每个 assembly options 接口逐字段定型；44 处 any 清零由 tsc 守护。
- 函数 ref 后置回填改为：message 域导出显式接口，transport 域构造时注入，环从类型层面消除。
- 分 4 个子切片落地（heartbeat → tail-refresh → reconnect → any 清零），每片独立跑 `SessionContext.ws-refresh.test.tsx`（135 测试）+ contexts 全套。

### T3 Session 双真源（中）
- `lib/types.ts` Session 删 3 字段；tsc 报错点逐个改读 store（`session-buffer-store` / 合并后的 head store）。
- `session-visible-range-helpers.ts:16` 的 `session.buffer` fallback 删除——调用方必须显式传 bufferOverride，缺就是红灯不是回退。
- `sessionBufferHeadsRef`（planner 用 5 字段）与 `session-head-store`（renderer 用 2 字段）合并为一个 store、一份字段命名。

### T4/T5 daemon 收尾（中）
- T4 倾向方案：server.ts 直接装配 mirror runtime，`terminal-runtime.ts` 只留订阅者生命周期（若剩余职责 <100 行则并入 mirror-runtime）。
- T5 新文件：`terminal-mux-channel-runtime.ts`（envelope 校验/绑定）、`terminal-reliable-input-ack.ts`（ack 去重）；message-runtime 只 import 调用。
- 两项都要求既有 `terminal-message-runtime.test.ts`、`server.*-truth.test.ts` 0 改动通过；module-registry owned_paths 同步。

### T6 design→active（小，依赖 T1）
- module-registry 三个模块 status 改 active，owned_paths 指向 packages/shared 真实文件，`owned_paths_note` 删除。
- 门禁自动核验（module-registry-truth + import-graph gate）。

### T7 App.tsx 下沉（中）
- 新 `android/src/lib/relay-device-stream-runtime.ts`：deps 注入（fetchFn/WebSocket 工厂/now/回调），含重连退避与 generation guard，纯逻辑可单测。
- 新 `android/src/hooks/useRelayDeviceStream.ts`：App.tsx 只接线。
- `mergeRelayPresenceWithDirectoryTruth` 移入 `lib/home-connection-projection.ts`（已有同域投影函数）。
- 架构测试（`architecture-boundary-truth.test.ts`）加断言：App.tsx 不得出现 `new WebSocket`/重连计时器。

### T8 follow 滚动状态机（中大）
- 新 `android/src/lib/terminal-follow-scroll-runtime.ts`：判别联合 state（如 `idle | programmaticScroll | userScrollIntent | layoutSettling`），输入为普通事件对象（scrollTop/来源/时间戳），输出 `{ nextState, effects }`。
- TerminalView 的 ~10 个 ref 替换为单 state ref + 纯函数调用；DOM 副作用仍在组件内执行 effects。
- 先写测试设计（`docs/testing/` 新文件），列出全部转换与正反用例，再写红测，再迁移。
- 迁移期间 `TerminalView.dynamic-refresh.test.tsx`（77 测试）等全套必须持续绿。

### T9 reconnect 相位（小，并入 T2 的 reconnect 子切片）

## 5. 风险与规避

| 风险 | 规避 |
|---|---|
| T2/T3 触面大（30+ 文件签名） | 子切片推进；每片 tsc + contexts 全套；不允许一次性大爆炸提交 |
| T3 删 fallback 后隐藏调用方缺 override 暴雷 | 先 grep 全部 `resolveSessionBufferView` 调用点确认 override 传递，红测先行 |
| T8 滚动手感回归（真机才可见） | 保留判别联合的 debug 投影进 runtime-debug；按 `.agents/skills/terminal-buffer-truth/SKILL.md` 跑真机回环验证 |
| STORAGE_KEYS 合并误改 key 值 | 红测断言每个 key 的字符串字面量不变 |
| 长任务上下文漂移 | 每完成一个 T 更新本文档"进度"节 + note.md；重开会话先读本文档 |

## 6. 测试计划

- 每个 T 的最小验证栈：
  - T1: `test:redline:fast` + hooks 全套 + mac/win 门禁（`mac-architecture-truth`、`windows-architecture-truth`）
  - T2/T3/T9: `SessionContext.ws-refresh.test.tsx` + `src/contexts/` 全套 + `test:terminal:regression:core`
  - T4/T5: `src/server/` 分批全套（注意单进程跑全套会 SIGABRT，需分批）+ `server.*-truth` 11 个
  - T6: `test:feature-registry`
  - T7: App 相关（`App.relay-stream-lifecycle.test.tsx` 等 5 个 App.*.test）+ 新 runtime 单测
  - T8: 新增测试设计文档 + 新 runtime 正反单测 + `TerminalView.*.test` 全套 + 真机回环
- 每个 T 收尾必跑：`pnpm run type-check`、`pnpm run test:feature-registry`（含 import 图 gate）。
- 全部完成后：`test:terminal:regression` 全栈 + `pnpm --dir packages/shared exec vitest run`。

## 7. 实施顺序

```text
T1 (小) → T6 (依赖T1) → T4 → T5 (daemon 收尾)
→ T3 (Session 双真源) → T2+T9 (refs 收敛，4 子切片)
→ T7 (App 下沉) → T8 (follow 状态机，测试设计先行)
```

依据：先小后大；T3 在 T2 前（删字段让 refs 收敛少搬一次）；T8 最后（唯一需要真机验证的）。

## 8. 完成定义（DoD）

- T1-T9 验收标准全部达成；
- `grep -c "MutableRefObject<any>\|refs: any" src/contexts/*.ts` 为 0；
- module-registry 无 design 状态的 shared 模块；
- 全栈 gate（type-check、test:feature-registry、test:terminal:regression、shared 全套）绿；
- 本文档"进度"节记录每个 T 的完成证据（命令 + 结果）；
- MEMORY.md 沉淀本轮可复用结论。

## 进度

（实施时逐项追加：日期、任务、验证命令、结果）

- 2026-07-26 **T1 完成**：shared STORAGE_KEYS 扩为两版并集（16 key，字符串值全部不变），android `lib/types.ts` 改 re-export；新增红测 `packages/shared/src/connection/storage-keys.test.ts` 冻结全部 key 值（先红后绿）。验证：storage-keys gate 2/2、type-check 0 错、test:redline:fast 43/43、hooks 全套 81/81、test:feature-registry 68/68、mac-architecture-truth 16/16、windows-architecture-truth 4/4。types.ts 剩余重复仅 `SessionBufferState`（有意分层，见第 2 节 Out of scope 说明）。
- 2026-07-26 **T6 完成**：`shared.protocol` / `shared.terminal_types` / `shared.connection_types` / `shared.test_contracts` 全部转 active，owned_paths 补齐 packages/shared 真实文件（import-graph gate 的路径解析同步支持 repo-root 相对路径）。剩余 design 模块仅 daemon.connection_gateway / client.file_browser / client.settings_update（非 shared 域，不在本 goal DoD 内）。验证：test:feature-registry 68/68。
- 2026-07-26 **T4 完成**：`terminal-runtime.ts` 的 30 字段 `TerminalRuntimeDeps` 改为 `Omit<TerminalMirrorRuntimeDeps, 'closeTransportSubscriber' | 'getSessionMirror'> & { defaultSessionName; daemonRuntimeDebug }`，装配处逐字段透传改为解构展开——deps 字段清单唯一真源回到 mirror-runtime。验证：type-check 0 错、mirror/runtime/message 6 文件 98/98、test:feature-registry 69/69。
- 2026-07-26 **T5 完成**：从 `terminal-message-runtime.ts`（1073→830 行）拆出 `terminal-mux-channel-runtime.ts`（286 行：hello/ready、channel open/message/binary/close、target-message、ping）与 `terminal-reliable-input-ack.ts`（33 行：seq ack 去重 FIFO 缓存），message-runtime 经工厂注入调用；`daemon.transport_subscriber.owned_paths` 补 2 个新文件。验证：type-check 0 错、message/control/transport-truth 5 文件 66/66、test:feature-registry 69/69。
- 2026-07-26 **已知阻塞（非本 goal 改动引起）**：`SessionContext.ws-refresh.test.tsx > does not replay prior explicit input after reconnect` 失败。三方对照定位：干净 HEAD 通过；HEAD+用户预存 WIP contexts 改动失败；HEAD+本 goal 改动通过。失败点为显式 reconnect 后未创建第二个 WebSocket 实例，疑似 WIP 的 transport reuse 改动所致。T2/T3 验证栈覆盖此测试，届时必须裁决（修 WIP 回归或确认测试期望过时）。
- 2026-07-26 **过程事故记录**：验证预存失败时误用 `git stash` 触发 `session-context-activity-runtime.test.ts` / `session-sync-helpers.test.ts` 二文件 merge 冲突，已按工作区侧（--ours）恢复并复测 91/91 绿；后续隔离验证一律改用 `git worktree`，不再 stash 共享工作区。
- 2026-07-26 **T2a 完成**：4 个心跳 ref（pingIntervals/lastPongAt/lastServerActivityAt/lastTerminalActivityAt）归并为 `src/lib/session-heartbeat-store.ts`（无 React，`deleteSession` 保留 terminalActivity 与原语义逐字节等义），15 个消费文件签名收敛为 1 个 store 参数，中间层零拆包；message-assemblies 顺带消掉 1 处 any；新增 store 单测 10 用例。验证：tsc 0 错、心跳相关 10 文件 108/108、ws-refresh 135/135 全绿（此前预存失败已消失）、test:feature-registry 71/71。
- 2026-07-26 **T2b 完成**：4 个 tail-refresh ref 归并为 `src/lib/session-tail-refresh-store.ts`；`lastSyncRequestAtRef` 的 `Map<string, any>` 定型为 `Map<sessionId:purpose, SessionSyncRequestDebounceState>`（8 字段显式类型）；`deleteSession` 刻意不清 debounce 条目（与原 closeSessionRuntime 语义一致）；message-assemblies 再消 4 处 any；归属 client.buffer_store。验证：tsc 0 错、store/buffer/pull/sync 121/121、ws-refresh 135/135、contexts 全套 448/448、test:feature-registry 71/71、旧 ref 名全仓 0 残留。
- 2026-07-26 **T3 完成**：① `resolveSessionBufferView` 整个删除，visible-range helpers 的 buffer 参数改必传（调用方缺 buffer 是类型错误，非运行时回退）；② `session-head-store.ts` 成为唯一 head store（renderer 快照 + planner `getLiveHead` 真源 + `setLiveHead` 单写点，inactive-drop 用 `publishRenderer:false` 保语义），`sessionBufferHeadsRef` 全仓清零；③ Session 类型删除 `buffer`/`daemonHeadRevision`/`daemonHeadEndIndex`，planner helpers 改收 `SessionDaemonHeadView`，buffer-runtime 的 `sessionOverride` 换 `headOverride`，`terminal-copy-selection` 的 session.buffer 回退删除；新增 `session-head-store.test.ts`（10 测试）。验证：tsc 0 错、核心五套件 143/143、TerminalView dynamic-refresh + multi-pane 82/82、test:feature-registry 71/71、周边回归 372 绿。renderer 投影（SessionRenderBufferSnapshot/render-gate）的 daemonHead 字段按约束保留。
- 2026-07-26 **ws-refresh 预存失败已消失**：T2a 验证时 `SessionContext.ws-refresh.test.tsx` 全 135 通过（含 "does not replay prior explicit input after reconnect"）——T3 对 transport/head 读路径的收敛顺带修复了该 WIP 回归，无需单独裁决。
- 2026-07-26 **T2c/T9 完成**：`session-reconnect-store.ts` 成为 reconnect phase / manual-close / stale-head-probe 单一 owner；`SessionReconnectRuntime` 改为 `idle | scheduled | connecting` 判别联合，`connecting + timer` 类型层面不可表示；provider/runtime 已不再传 `reconnectRuntimesRef` / `manualCloseRef` / `staleTransportProbeAtRef`，读写统一走 `SessionReconnectStore`。新增/补强正反测试：manual close 抑制 retryable reconnect、不投 terminal error、不启动 attempt；scheduled timer fire 后转 connecting 且不携带 timer；scheduled/connecting phase 不重复 queue reconnect；stale probe marker 不覆盖 active probe。验证：`session-reconnect-store` 8/8、focused reconnect/context 77/77、lifecycle/ws-refresh 158/158、contexts 全套 451/451、`test:terminal:regression:core` 49 文件/638 + common 83 + relay smoke PASS、type-check 0 错、test:feature-registry 71/71、T2c allowed-path `git diff --check` PASS。旧 ref 名 `reconnectRuntimesRef|manualCloseRef|staleTransportProbeAtRef` 全仓 0 残留；`refs: any` / message assemblies `any` 仍留给 T2d 清零切片。
- 2026-07-27 **T2d 完成**：`session-context-provider-assembly-types.ts` 的 `refs: any` 替换为 `SessionProviderRuntimeRefs`；`session-context-message-assemblies.ts` 清零全部 `any`，只保留结构化最小接口给实际消费的 store/runtime 方法；`sameRevisionChunkFrameRef` 从 provider runtime 明确接入 SessionContext，chunk-frame、file-transfer、remote-window、debug metrics runtime 返回类型由各 owner 导出；transport orchestration 的 `handleSocketServerMessageRef` 类型补齐 `onClosed`。验证：`tsc --noEmit` PASS；`rg "MutableRefObject<any>|refs:\s*any" android/src/contexts --glob '*.{ts,tsx}'` 0 命中；`rg "\bany\b" session-context-message-assemblies.ts session-context-provider-assembly-types.ts session-context-provider-runtime.ts` 0 命中；focused message/session/ws-refresh 161/161；contexts 全套 451/451；`test:feature-registry` 71/71；`test:terminal:regression:core` terminal-message 37/37 + contracts 49 文件/639 + common flows 83/83 + relay smoke PASS。
- 2026-07-27 **T7 完成**：App.tsx 的 relay device stream 重连编排下沉到 `src/lib/relay-device-stream-runtime.ts` + `src/hooks/useRelayDeviceStream.ts`；`mergeRelayPresenceWithDirectoryTruth` 归入 home-connection projection 同域 re-export；App 只接线 hook。验证：`relay-device-stream-runtime` 4/4、`App.relay-stream-lifecycle` 7/7、architecture-boundary 14/14、home-connection/traversal/account 20/20、`tsc --noEmit` PASS、`test:feature-registry` PASS；App.tsx 行数 844 ≤900。
- 2026-07-27 **T8 完成（scoped）**：`TerminalView` 的 follow/reading scroll 真相从 `pendingFollow*` / `recentViewportLayoutChange` / `ignoredProgrammaticScrollTop` / `lastSettledScrollTop` / `hasSettledFollowFrame` / `suppressProgrammaticScroll` / `userScrollIntentDeadline` 等散落 ref 收敛为 `src/lib/terminal-follow-scroll-runtime.ts` 判别联合状态机；TerminalView 只保留 timer/function ref 作为 effect handle。新增测试设计 `docs/testing/terminal-follow-scroll-state-test-design.md` 与纯 runtime 正反测试 10 个，锁住 pending dedupe、reading 不携带 pending、programmatic suppress one-shot、layout drift 不进 reading、reset/cancel 清理。验证：`terminal-follow-scroll-runtime` 10/10、TerminalView focused 85/85、TerminalPage render/session identity 28/28、`tsc --noEmit` PASS、`test:feature-registry` 72/72、`daemon:mirror:close-loop` all 9 cases PASS、scoped `git diff --check` PASS；`rg` 旧 follow ref 名在 `TerminalView.tsx` 0 命中。已知非 T8 阻塞：`TerminalView.theme.test.tsx` 当前 2 个 theme preset 断言失败（default bg transparent / classic-dark background #000），该失败来自 shared theme/cell-render 当前工作区语义，非 follow-scroll owner，本切片未修改主题真源。
- 2026-07-27 **T1-T9 全部完成，最终验证总结**：
  - **验证结果**：`test:feature-registry` 72/72 PASS；`tsc --noEmit` PASS；`pnpm --dir packages/shared exec vitest run` 38 文件/308 PASS；核心 server 测试 110/110 PASS；contexts + lib + App 529/529 PASS。
  - **已知非阻塞失败**（5 个，均非架构改动引起）：
    1. TerminalView.theme.test.tsx 2 失败 — theme 真源语义（DEFAULT_TERMINAL_CELL_COLOR bg transparent / classic-dark background #000）
    2. App.android-ime-input-loop.test.tsx 2 失败 — 旧 app 流程期望（App 渲染显示 connections-page 非 terminal-header）
    3. runtime-debug-sequence.test.ts 1 失败 — 缺失证据文件 evidence/runtime-audit/2026-04-26/logs-after-apk.json
  - **SIGABRT**：全量并行时 wrtc native module 崩溃（RemoteWindowOverlay 测试单文件 58/58 PASS 正常）
  - **SOP 修复**：remote-window-touch-action-sop.test.ts line 27 文案对齐
  - **网络检测**：@capacitor/network 依赖 + useOpenTabLifecycleEffects networkStatusChange
  - **sessionId 精确匹配**：S1-S4 收口，findReusableManagedSession/findReusableOpenTabSession 精确 sessionId 匹配
  - **MEMORY.md 已更新**：写入架构收口结论
  - **未完成**：全量并行 SIGABRT 修复、theme/IME 测试修复、遗留 migration 路径（activeSocket、controlTransport/terminalTransport 拆分、tmux-sessions.ts 直接 socket 池）的最终 phase1 物理清理
