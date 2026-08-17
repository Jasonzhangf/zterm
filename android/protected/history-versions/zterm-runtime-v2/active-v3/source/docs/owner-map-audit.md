# Owner Map 审计 + 场景矩阵 + Contract Baseline 切片排序

> 生成时间：2026-05-09
> 基于真源：architecture.md + 2026-04-23-terminal-head-buffer-render-truth.md + 2026-04-28-terminal-transport-session-lifecycle-truth.md

## 一、Owner Map 审计（13 领域）

| # | 领域 | 当前 owner 文件 | 唯一? | 问题 |
|---|------|----------------|-------|------|
| 1 | operation truth | `packages/shared/src/interaction/operation.ts` | ❌ 未接入生产 | 类型存在但无 block/orchestration dispatch；hook refs 已删除 |
| 2 | event truth | `packages/shared/src/interaction/event.ts` | ❌ 同上 | 类型存在但无 producer/consumer |
| 3 | projection truth | `packages/shared/src/interaction/projection.ts` | ⚠️ 仅 update-check | `deriveAppUpdateProjection` 有真实消费；其他投影无结构化定义 |
| 4 | open-tab truth | `useOpenTabRuntime.ts` + `open-tab-persistence.ts` + `open-tab-intent.ts` | ✅ 是（近两次修复后） | 冷启动过滤已修；显式导入清除墓碑已修 |
| 5 | active-session truth | `session-context-core.ts` reducer `SET_ACTIVE_SESSION` | ✅ 是 | session lifecycle runtime 不再持有 active 写口 |
| 6 | runtime-session truth | `session-context-core.ts` + 多处 | ⚠️ 大部分 | `handleLoadSavedTabList` 通过 `openDraftAsSession` 隐式创建 session |
| 7 | transport truth | `session-context-infra-facade-runtime.ts` + `session-context-transport-orchestration-runtime.ts` | ❌ 否 | 多文件持有 transport 状态；无统一 attach/detach lifecycle owner |
| 8 | sparse-buffer truth | `session-context-buffer-runtime.ts` + buffer-store + render-buffer-store + head-store | ❌ 否 | buffer/head/render-buffer 三个 store 分散 |
| 9 | renderer visible-range truth | `TerminalView.tsx` + provider assembly refs | ❌ 否 | visible range 分散在 TerminalView scroll handler + provider refs |
| 10 | pane/layout truth | `TerminalPage.tsx` + `usePaneLayout` + shared `layout/profile.ts` | ⚠️ Shared profile 干净，但 pane state 在 TerminalPage | 2295+ 行巨型文件持有 split/active-pane/split-ratio 等 |
| 11 | update-check truth | `app-update-runtime.ts` | ✅ 是 | projection 通过 shared 正确流转 |
| 12 | file-transfer truth | `session-context-transfer-runtime.ts` + daemon file runtime | ❌ 分裂 | 客户端有 `sendImagePasteRuntime`/`sendFileAttachRuntime` 但无生命周期 block |
| 13 | screenshot truth | `remote-screenshot-runtime.ts` | ✅ 是 | 已提取为独立 runtime block |

## 二、当前架构分层评估

### 现有分层
| 层 | 现状 | 覆盖率 |
|---|------|--------|
| shared pure functions | `packages/shared/src/` 有 connection/terminal/schedule/layout/workspace | ~15% |
| domain blocks | screenshot runtime, update-check runtime, open-tab-intent | ~10% |
| thin orchestration | ❌ 不存在 | 0% |
| Android adapters | ❌ page/hook/context 直接持有业务逻辑 | 0% |
| local harness | ❌ 所有测试依赖 React + MockWebSocket | 0% |

### 巨型文件（应拆分的目标）
| 文件 | 行数 | 应收口到 |
|------|------|----------|
| TerminalPage.tsx | 2295+ | thin orchestration + adapter |
| TerminalView.tsx | 1184+ | renderer block + adapter |
| useOpenTabRuntime.ts | 530+ | open-tab block |
| useSessionOpenActions.ts | 530+ | session-open block |
| session-context-infra-facade-runtime.ts | 463+ | infra adapter |
| session-context-provider-core-assemblies.ts | 600+ | should become a thin wiring layer |
| App.tsx | 500+ | app shell adapter |

## 三��Local Harness 场景矩阵

| # | 场景 | 输入（operation） | 预期输出（event/projection） | Harness 类型 |
|---|------|-------------------|------------------------------|-------------|
| 1 | cold start | persisted tabs + mock daemon sessions | tabs restored, active correct | headless state machine |
| 2 | open session | OPEN_SESSION op | session.created + tab.opened | headless dispatcher |
| 3 | switch tab | SWITCH_TAB op | tab.activated projection | headless dispatcher |
| 4 | foreground resume | APP_RESUME op | transport.probed, buffer.head-requested | headless + mock transport |
| 5 | input→head→sync→render | SEND_INPUT + mock daemon push | buffer.sync applied, render reflects | headless + mock ws |
| 6 | reading gap repair | SCROLL_UP + visible gap | buffer.sync-requested, gap filled | headless buffer manager |
| 7 | input exits reading | SEND_INPUT in reading mode | mode→follow, render→bottom | headless renderer |
| 8 | close tab persistence | CLOSE_TAB + restart | tab not reopened, tombstone preserved | headless storage |
| 9 | update check | CHECK_UPDATE | projection shows update | headless + mock manifest |
| 10 | file transfer lifecycle | SEND_FILE | started→progress→complete | headless + mock ws |
| 11 | screenshot lifecycle | REQUEST_SCREENSHOT | capturing→preview-ready | headless + mock daemon |
| 12 | schedule/reconnect | timer + mock daemon | schedule.fired, reconnect.attempted | headless timer mock |

## 四、Contract Baseline 切片排序

### P0: interaction contract foundation + local harness scaffold
- 定义 `Operation` / `Event` / `Projection` 为每个领域的 typed union
- 创建最小 event bus / dispatcher（shared 层）
- 创建 `local-harness/` 目录 + headless test runner
- 以 update-check 为首个 production contract slice（已有 projection）
- 场景：cold start, update check

### P1: open-tab truth consolidation
- 已基本完成（近两次提交）
- 补 local harness 场景：cold start + close tab persistence + reopen
- 确保 open-tab 操作通过 operation dispatch 而非直接 hook 调用

### P2: terminal buffer/render truth consolidation
- buffer manager 操作下沉为 shared pure functions
- renderer visible-range 提取为 domain block
- 场景：input→head→sync→render, reading gap repair, input exits reading

### P3: transport lifecycle block
- 统一 transport lifecycle runtime
- control transport + session transport 分层（按 decision doc）
- 场景：foreground resume, switch tab, reconnect

### P4: TerminalPage/View thinning
- 业务逻辑从 TerminalPage.tsx 移入 blocks
- TerminalView 变为纯 renderer adapter
- pane/layout truth 合并

## 五、硬护栏检查清单

- [ ] 无 fallback（任何实现不得有降级/兜底路径）
- [ ] 无双路径补偿（不得新旧并存）
- [ ] 无保留旧逻辑（已确认错误的实现已物理删除）
- [ ] 不通过降低刷新率伪装性能优化
- [ ] daemon 不持有客户端状态
- [ ] buffer manager 不持有 renderer state
- [ ] renderer 不驱动 transport pull
