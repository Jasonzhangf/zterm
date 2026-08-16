# TerminalPage 纯编排重构实施计划

- 日期：2026-05-24
- 基于审计：`android/docs/audits/2026-05-24-shared-blocks-orchestration-audit.md`
- 主目标：把 `android/src/pages/TerminalPage.tsx` 从巨型混合页重构为 **纯编排壳 + blocks + shared/helper leafs**，并补齐结构门禁。

## 1. 目标与验收标准

### 1.1 目标

将 `TerminalPage.tsx` 中混合存在的：

- 页面编排
- overlay/sheet 协调
- keyboard/viewport helper
- copy selection 状态机
- pane/session interaction runtime
- 各类 UI identity/render key helper

收口成清晰三层：

```text
TerminalPage orchestration shell
    ↓
page-local blocks / coordinators / runtimes
    ↓
pure helper / shared leaf modules
```

### 1.2 验收标准

1. `TerminalPage.tsx` 只保留：
   - props 编排
   - page-level hooks 装配
   - stage / overlays / sheets JSX 组合
2. `TerminalPage.tsx` 不再内含大段纯 helper、copy 状态机、keyboard lift 计算、overlay 协调细节。
3. 新抽出的模块职责一眼可辨：
   - helper 是 helper
   - runtime 是 runtime
   - orchestrator 是 orchestrator
4. 不引入 fallback / 双真源 / duplicated planner。
5. 定向测试、type-check、必要 page 回归全部通过。

## 2. 范围与边界

### 2.1 In Scope

- `android/src/pages/TerminalPage.tsx`
- 其直接内联的纯 helper / UI runtime / overlay 协调逻辑
- 与 `TerminalPage` 强耦合的 page-local hooks / leaf helpers
- 必要的测试更新
- 必要的 docs / truth gate / size gate

### 2.2 Out of Scope

- daemon / server mirror 真相重构
- `SessionContext` 大规模重新设计
- terminal renderer / buffer manager 语义改写
- UI 视觉改版
- 未被 `TerminalPage` 主热点直接阻塞的全仓命名统一

## 3. 设计原则

1. **纯编排优先**：`TerminalPage.tsx` 只做编排，不持有业务实现细节。
2. **唯一 owner**：每种真相只允许一个 owner。
3. **先 helper 后 orchestrator**：先把纯函数剥离，再拆协调层。
4. **不做假拆分**：禁止只把代码搬文件、语义仍混合。
5. **不改底层语义**：本轮目标是架构收口，不是行为改写。
6. **shared 优先原则**：满足跨端纯逻辑条件的 helper，优先评估下沉 `packages/shared`；否则放 `android/src/lib` 或 page-local helper。

## 4. 技术方案

### 4.1 目标结构

建议拆为以下几组：

#### A. pure helpers

1. `android/src/pages/terminal-page-render-keys.ts`
   - session/page/ui identity key
   - rendered sessions input epoch key

2. `android/src/pages/terminal-copy-selection.ts`
   - copy selection state types
   - selection buffer coverage
   - text projection helpers
   - clipboard payload projection

3. `android/src/pages/terminal-keyboard-lift.ts`
   - `resolveKeyboardLiftPx`
   - layout viewport height resolve
   - terminal header top inset resolve
   - 与 keyboard/viewport 纯计算相关的 helper

4. `packages/shared/src/terminal/copy-selection.ts`（仅在满足纯逻辑边界时新增）
   - `terminalCellToPlainText(cell)`
   - `terminalBufferRowsToPlainText(...)`
   - `terminalBufferCoversRows(...)`
   - 仅保留不依赖 React / DOM / Capacitor 的纯逻辑

#### B. page-local runtime/coordinator

5. `android/src/pages/useTerminalPageOverlays.ts`
   - schedule / screenshot / transfer / tab manager / debug / copy menu open-close coordination

6. `android/src/pages/useTerminalPageInteractionRuntime.ts`
   - interactive session
   - pane attach intent consume
   - session switch routing
   - quickbar/selection/pane-local interaction wiring

7. `android/src/pages/useTerminalPageCopyRuntime.ts`
   - copy selection state machine
   - long-press -> set start/end -> auto copy/manual copy
   - tab/session switch cleanup

#### C. page shell

8. `android/src/pages/TerminalPage.tsx`
   - imports above modules
   - wiring props
   - stage + overlays + sheets render

### 4.2 命名要求

- helper：`*-keys.ts` / `*-selection.ts` / `*-keyboard-lift.ts`
- runtime：`use*-Runtime.ts` 或 `use*-Overlays.ts`
- orchestration shell：`TerminalPage.tsx`
- 禁止继续引入 `*assemblies*`、`*facade-runtime*` 这类命名到 page slice

### 4.3 推荐实施顺序

1. **先 helper，后 runtime，最后 page shell**
   - 先把纯 helper 从 `TerminalPage.tsx` 物理移走
   - 再抽 copy/overlay/interaction runtime
   - 最后清理 page shell 剩余状态与 effect

2. **先保行为，再收结构**
   - 第一轮不改变行为语义，只移动 owner
   - 第二轮再做命名清理与门禁补齐

3. **按可验证单元推进**
   - 每抽一个 helper/runtime，就补对应单测
   - 不做“一口气搬空 3000 行”式高风险迁移

## 5. 文件清单

### 5.1 必改文件

- `android/src/pages/TerminalPage.tsx`
- `android/docs/audits/2026-05-24-shared-blocks-orchestration-audit.md`

### 5.2 计划新增文件

- `android/src/pages/terminal-page-render-keys.ts`
- `android/src/pages/terminal-copy-selection.ts`
- `android/src/pages/terminal-keyboard-lift.ts`
- `android/src/pages/useTerminalPageOverlays.ts`
- `android/src/pages/useTerminalPageInteractionRuntime.ts`
- `android/src/pages/useTerminalPageCopyRuntime.ts`

### 5.3 条件性新增文件

- `packages/shared/src/terminal/copy-selection.ts`
  - 只有在逻辑完全纯净、具备跨端价值时才下沉 shared

### 5.4 计划更新测试文件

- `android/src/pages/TerminalPage.render-scope.test.tsx`
- `android/src/pages/TerminalPage.multi-pane-decouple.test.tsx`
- `android/src/pages/TerminalPage.android-ime.test.tsx`
- `android/src/components/terminal/system-copy-state-machine.test.tsx`
- 新增对应 helper/runtime 单测文件

## 6. 风险与规避

| 风险 | 规避 |
|------|------|
| 抽 helper 时误带 React/DOM 依赖进入 shared | 先做纯度审计；不纯的逻辑留在 android page-local helper |
| 抽 overlay/runtime 时把状态 owner 拆散 | 先定义 owner 表，再迁移代码 |
| 表面拆文件、实际仍让 TerminalPage 内保留半套逻辑 | 每迁一块就物理删除原实现，不保留双真源 |
| 行数下降但职责仍混杂 | 审查标准不看行数 alone，必须看 owner 和职责边界 |
| TerminalPage 回归用例受影响 | 每步迁移后跑 targeted tests，再继续下一块 |

## 7. 测试计划

### 7.1 helper 单测

- render keys helper：session id / custom name / resolvedPath 变化回归
- copy selection helper：row coverage / text projection / empty buffer / reversed range
- keyboard lift helper：visual viewport shrink / no viewport / inset=0 / Android/iOS top inset

### 7.2 runtime 单测

- copy runtime：起点/终点/重设起点/自动复制/手动复制/切 tab 清理
- overlays runtime：sheet open-close / debug overlay toggle / menu close on context switch
- interaction runtime：interactive session 变更 / pane attach consume / quickbar 折叠态

### 7.3 页面定向回归

- `TerminalPage.render-scope.test.tsx`
- `TerminalPage.multi-pane-decouple.test.tsx`
- `TerminalPage.android-ime.test.tsx`
- 与 copy mode 相关的页面/组件用例

### 7.4 工程级验证

- `pnpm --dir android exec vitest run <targeted tests>`
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit`
- 如无历史红线阻塞，补 `pnpm --dir android run build` 或等价页面构建验证

## 8. 实施步骤

### Step 1：锁定 owner 与拆分蓝图

- 列出 TerminalPage 现有逻辑块清单
- 给每块指定唯一 owner：helper / runtime / overlay / shell
- 明确哪些可进 shared，哪些只能留 android page-local

### Step 2：先抽纯 helper

- 抽 render keys
- 抽 keyboard lift
- 抽 copy text projection / row coverage
- 每抽一块就补单测并删除原位置实现

### Step 3：抽 copy runtime

- 收口 copy selection state machine
- 保证 TerminalPage 不再直接管理 copy 起止/menu 状态细节
- 补 copy runtime tests

### Step 4：抽 overlay / interaction runtime

- 收口 debug overlay / tab manager / schedule / screenshot / transfer sheet
- 收口 interactive session / pane attach / quickbar interaction
- 保持 JSX 结构不改语义

### Step 5：收 page shell

- 清理残留 helper / state machine / formula
- 让 TerminalPage 只剩 props 装配、hook 调用、JSX 编排
- 审计最终行数与职责边界

### Step 6：补结构门禁

- 为 TerminalPage 体量和 owner 关系补最小 truth gate
- 如合适，增加 file-size/import gate 或审计文档补充条目

## 9. 完成定义（DoD）

1. `TerminalPage.tsx` 成为真正 page shell：
   - 只保留编排、hook 装配、JSX 组合
   - 不再内联大段 helper 与状态机
2. 抽出的 helper/runtime 有清晰 owner 与测试。
3. 不产生 fallback、双真源、重复 planner。
4. 定向测试 + type-check 通过。
5. 能在审计层面明确说明：
   - 为什么 `TerminalPage` 是纯编排壳
   - 为什么新拆分后的 owner 分配是唯一正确的

## 10. 与审计结论的对应关系

- 审计报告指出的**唯一主热点**是 `android/src/pages/TerminalPage.tsx`
- 本计划直接对应该热点，而不是泛化成全仓重构
- 这样做的唯一性在于：
  - shared 层已经存在，不是主矛盾
  - SessionContext 壳已明显薄化，不是主矛盾
  - server 入口已有 support block，不是主矛盾
  - 只有 `TerminalPage.tsx` 仍明显混合编排/逻辑/状态机，是当前最需要物理拆解的真源偏差点

## 11. TerminalPage 拆分蓝图（执行版）

### 11.1 现有职责切片

当前 `TerminalPage.tsx` 里至少混有以下职责：

1. **page shell / JSX 编排**
   - stage 结构
   - overlays / sheets 挂载
   - props 向下游分发

2. **session/ui identity helper**
   - rendered/header/runtime status key
   - input epoch key
   - tab chrome item projection

3. **copy selection 纯投影 helper**
   - row coverage
   - render buffer -> plain text
   - copy selection buffer resolve

4. **copy selection 状态机**
   - 起点 / 终点 / 候选 end
   - 自动复制 / 手动复制
   - tab/session/pane 切换清理

5. **keyboard / viewport 纯计算**
   - keyboard inset -> lift px
   - header top inset
   - layout viewport height resolve

6. **overlay coordination**
   - debug overlay
   - tab manager
   - schedule sheet
   - file transfer sheet
   - remote screenshot sheet
   - copy menu

7. **interaction runtime**
   - interactive session
   - pane attach intent apply
   - switch from chrome
   - quickbar collapse / selection wiring

### 11.2 目标 owner 分配

| 逻辑块 | 唯一 owner | 是否纯逻辑 | 是否可进 shared |
|---|---|---:|---:|
| render/session key helper | `android/src/pages/terminal-page-render-keys.ts` | 是 | 否，页面语义过强 |
| keyboard lift / header inset | `android/src/pages/terminal-keyboard-lift.ts` | 基本是 | 否，依赖 page viewport 语义 |
| copy text projection | `android/src/pages/terminal-copy-selection.ts` | 是 | 条件性可进 shared |
| copy selection 状态机 | `android/src/pages/useTerminalPageCopyRuntime.ts` | 否 | 否 |
| overlay open/close 协调 | `android/src/pages/useTerminalPageOverlays.ts` | 否 | 否 |
| pane/session interaction | `android/src/pages/useTerminalPageInteractionRuntime.ts` | 否 | 否 |
| 最终页面装配 | `android/src/pages/TerminalPage.tsx` | 否（仅编排） | 否 |

### 11.3 建议文件职责

#### A. `android/src/pages/terminal-page-render-keys.ts`

只保留以下纯函数：
- `terminalPageRenderedSessionUiKey(session)`
- `terminalPageRenderedSessionsUiKey(sessions)`
- `terminalPageHeaderSessionUiKey(session)`
- `terminalPageHeaderSessionsUiKey(sessions)`
- `terminalPageActiveRuntimeStatusKey(session)`
- `resolveSessionInputEpoch(inputResetEpochBySession, sessionId)`
- `resolveRenderedSessionsInputEpochKey(...)`
- `toTerminalTabChromeItem(session)`

**边界**：
- 不允许 import React
- 不允许读 window/document
- 不允许持有状态

#### B. `android/src/pages/terminal-keyboard-lift.ts`

只保留 keyboard / viewport 纯计算：
- `resolveKeyboardLiftPx(...)`
- `resolveLayoutViewportHeight()`
- `resolveTerminalHeaderTopInsetPx(isAndroid)`
- `resolveWindowWidth()`（若仍被 page 使用）

**边界**：
- 允许读取 viewport metrics helper
- 不允许掺入任何 overlay / copy / session 逻辑

#### C. `android/src/pages/terminal-copy-selection.ts`

只保留 copy 纯投影能力：
- `CopySelectionState`
- `EMPTY_COPY_SELECTION_STATE`
- `resolveCopySelectionBuffer(...)`
- `writeTextToClipboard(text)`
- `logAsyncCleanupFailure(scope, error)`
- `terminalBufferRowsToPlainText(...)`（若不下沉 shared）
- `terminalBufferCoversRows(...)`（若不下沉 shared）

**边界**：
- 不持有 React state
- 不感知页内 overlay 是否打开
- 不决定起点/终点状态机推进

#### D. `android/src/pages/useTerminalPageCopyRuntime.ts`

只保留 copy 状态机与动作：
- start/end/menu/preview row 的状态真相
- `onRowLongPress`
- `setCopyStart`
- `setCopyEnd`
- `copySelected`
- `resetCopySelection`
- session/tab/pane 变化时 cleanup

**边界**：
- 不做 buffer 文本投影实现
- 只调用 `terminal-copy-selection.ts` 暴露的 helper

#### E. `android/src/pages/useTerminalPageOverlays.ts`

只保留 overlay/sheet 开关与协调：
- `debugOverlayVisible`
- `debugOverlayPos`
- `tabManagerOpen`
- `scheduleOpen`
- `fileTransferOpen`
- `remoteScreenshotOpen`
- copy menu open/close（若决定放在 overlay 域）
- `scheduleComposerSeed`

**边界**：
- 不处理 session switch 业务真相
- 不处理 keyboard lift 计算
- 不实现 copy 投影逻辑

#### F. `android/src/pages/useTerminalPageInteractionRuntime.ts`

只保留 page 级 interaction 编排：
- interactive session 选择
- pane attach intent 应用
- chrome session switch route
- quickbar collapse wiring
- 与 `useTerminalWorkspace` 的粘合动作

**边界**：
- 不持有 copy 文本投影逻辑
- 不持有 overlay open/close 细节
- 不持有 render key helper

#### G. `android/src/pages/TerminalPage.tsx`

最终只保留：
- props
- page-level hooks 调用
- 结果拼装
- JSX
- 子组件本地声明（若尚未继续下沉）

**禁止保留**：
- 大段 helper
- copy 状态机
- keyboard 公式
- overlay open/close 细节
- session switch/pane attach 细节

### 11.4 推荐迁移顺序（最小风险）

#### Phase 1：纯 helper 先行
1. 抽 `terminal-page-render-keys.ts`
2. 抽 `terminal-keyboard-lift.ts`
3. 抽 `terminal-copy-selection.ts` 的纯投影部分
4. 为 1-3 补单测
5. 删除 TerminalPage 内对应实现

#### Phase 2：copy runtime 收口
1. 新建 `useTerminalPageCopyRuntime.ts`
2. 接管 copy selection 的 state + actions
3. 保持 TerminalPage JSX 不变，只改数据来源
4. 补 copy runtime tests

#### Phase 3：overlay runtime 收口
1. 新建 `useTerminalPageOverlays.ts`
2. 收 schedule/screenshot/transfer/tab-manager/debug 的 open-close
3. 若 copy menu 更适合作为 overlay 状态，也一并收口
4. 补 targeted tests

#### Phase 4：interaction runtime 收口
1. 新建 `useTerminalPageInteractionRuntime.ts`
2. 收 interactive session / pane attach / chrome switch route
3. 保持与 `useTerminalWorkspace`、`TerminalHeader`、`TerminalQuickBar` 的接口稳定
4. 补 targeted tests

#### Phase 5：page shell 审计与减重
1. 清掉残余 helper / runtime / state machine
2. 审查 `TerminalPage.tsx` 是否只剩装配
3. 记录最终体量与 owner map

### 11.5 每阶段验证门禁

#### Phase 1 后
- helper 单测通过
- TerminalPage 相关旧测试不回归
- TerminalPage 内对应 helper 已物理删除

#### Phase 2 后
- copy mode 相关页面/组件测试通过
- tab 切换 / session 切换清理行为不变

#### Phase 3 后
- 各 sheet open/close 行为保持
- debug overlay / copy menu 不串状态

#### Phase 4 后
- interactive session / pane attach / quickbar 交互不回归
- multi-pane 与 android-ime 相关 targeted tests 通过

#### Phase 5 后
- `TerminalPage.tsx` 可被认定为纯编排壳
- type-check 通过
- 定向 vitest 通过

### 11.6 不允许的反模式

1. **只搬 helper 不删原实现**
2. **把 copy runtime 一半留在 page、一半留在 hook**
3. **把 overlay state 与 interaction state 混到同一 hook**
4. **为了少文件，把 keyboard lift / render keys / copy projection 再塞回一个 utils 大包**
5. **shared 下沉时混入 DOM/Capacitor 依赖**
6. **用 page-local workaround 代替唯一 owner 收口**

### 11.7 最小首批落地建议

如果只先做一批最稳、最不易回归的动作，推荐顺序固定为：

1. `terminal-page-render-keys.ts`
2. `terminal-keyboard-lift.ts`
3. `terminal-copy-selection.ts`（只抽纯投影 helper）
4. 对应单测
5. 再进入 `useTerminalPageCopyRuntime.ts`

原因：这批动作对 JSX 结构和 runtime 行为影响最小，但能先把 TerminalPage 里最明显的纯 helper 杂质物理剥离掉。

