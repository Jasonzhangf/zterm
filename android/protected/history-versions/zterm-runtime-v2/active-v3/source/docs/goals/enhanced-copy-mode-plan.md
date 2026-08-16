# Enhanced Copy Mode 实现计划（Android）

## 目标
实现“增强复制功能”：
1. 固定区原“状态”键改为“拷贝”键；
2. “状态”键移动到工具行并放在“行号”后；
3. 点击“拷贝”键进入/退出复制模式（toggle）；
4. 复制模式下第一次长按选起始行，第二次长按选结束行；
5. 从当前 session 的 tmux/render buffer 真源按行区间提取文本并写入系统剪贴板。

## 验收标准
- UI：
  - 固定区出现“拷贝”键，并支持激活高亮。
  - 工具行顺序包含“行号、状态”（状态在行号后）。
- 交互：
  - 点击“拷贝”进入复制模式；再次点击取消。
  - 第一次长按记录 start 行；第二次长按记录 end 行并触发复制。
  - 复制成功后提示并退出复制模式。
- 数据真源：
  - 复制内容来自 session buffer 真源；禁止 DOM 文本拼接冒充真源。
- 失败分支：
  - 无 active session / 无可用 buffer / clipboard 写入失败时给出明确提示并复位。

## 范围与边界
### In Scope
- `TerminalQuickBar` 按钮重排与 copy toggle。
- `TerminalPage` copy mode 状态机与两次长按流程。
- 基于 session buffer 的行区间提取与 clipboard 写入。

### Out of Scope
- tmux 原生 copy-mode 深度接入。
- 多段选区、跨 session 联合复制。
- 复杂可视化选区绘制（若现有链路无现成支持，本期不扩展）。

## 设计原则
- 真源优先：复制内容只来自 session/render buffer 真源。
- 职责边界：不改 daemon/tmux 真相，只做 client UI/交互与读取。
- 无 fallback：失败显式暴露，不做双路径补偿。

## 技术方案（文件级）
1. `android/src/components/terminal/TerminalQuickBar.tsx`
   - `topFixedActions`：`debug-overlay` 改为 `tmux-copy`（label: 拷贝）。
   - `toolRowActions`：在 `line-numbers` 后加入 `debug-overlay`（label: 状态）。
   - 新增 props：`copyModeActive`、`onToggleCopyMode`。
   - `tmux-copy` 点击触发 toggle，激活态使用现有绿色高亮规则。

2. `android/src/pages/TerminalPage.tsx`
   - 新增状态：`copyMode`（idle/pick-start/pick-end）、`copyStartRow`。
   - 将 `copyModeActive` 与 `onToggleCopyMode` 传给 `TerminalQuickBar`。
   - 接入 terminal 长按行回调：
     - pick-start：记录 start 并转 pick-end。
     - pick-end：记录 end，执行复制并 reset。
   - 复制逻辑：
     - 读取 active session 对应 buffer snapshot；
     - 提取 `[min(start,end), max(start,end)]` 行文本；
     - `navigator.clipboard.writeText()`；
     - 成功/失败均给反馈并复位状态。

3. Terminal 行命中接入（按现有组件实际路径）
   - 在当前 terminal viewport/renderer 的长按手势入口输出标准化行索引给 `TerminalPage`。
   - copy mode 外不改变既有行为。

## 风险与规避
1. 行索引映射不一致
   - 规避：统一采用 session buffer 绝对行索引契约。
2. 长按手势冲突
   - 规避：仅 copy mode 下消费长按选择，其他模式保持原逻辑。
3. 剪贴板权限失败
   - 规避：显式提示错误并 reset，避免半激活状态残留。

## 测试计划
- 组件测试（QuickBar）：
  - 按钮顺序变化（拷贝替换固定区状态；状态移动到行号后）。
  - copy mode active 高亮。
- 页面/流程测试（TerminalPage）：
  - toggle 进入/退出复制模式。
  - 两次长按触发复制。
  - start/end 反向选择区间仍正确复制。
  - clipboard 失败分支提示与复位。
- 回归：
  - 不影响键盘按钮、行号按钮、原状态面板。

## 实施步骤
1. 改 QuickBar action 配置和点击分发。
2. 在 TerminalPage 增加 copy mode 状态机并连线 QuickBar。
3. 打通 terminal 长按行号回调与复制流程。
4. 补测试并执行定向测试。
5. 真机回归验证与 evidence 记录。

## 完成定义（DoD）
- 功能满足验收标准且通过相关测试。
- 复制内容可在系统剪贴板粘贴复现。
- 无新增 fallback 分支，无职责越层。

---

## 补充章节：拷贝按钮失效补口（2026-06-07）

### 根因判定
三层追踪结论：
1. **现象**：QuickBar "拷贝"按钮点击后，copy mode 高亮正常亮起，长按行触发 menu，操作结束后 text 未写入系统剪贴板，或静默无响应。
2. **已排除**：plugin 注册（`MainActivity.onCreate` 确认 `registerPlugin(DeviceClipboardPlugin.class)`）、native端实现（`ClipboardManager.setPrimaryClip` 标准实现）、`writeTextToClipboard` 的 native/fallback 分支、QuickBar button `triggerActionSequence` 分发、`onToggleCopyMode` 功能更新、`useTerminalPageCopyRuntime` 状态机状态转移、`TerminalPageCopyMenu` 按钮事件绑定。
3. **嫌疑点 A**：`handleCopySelectedText` 中 `resolveCopySelectionBuffer` → `terminalBufferCoversRows` 判定 buffer 区间未覆盖当前行区间 → 返回 null → `terminalBufferRowsToPlainText(null,...)` 返回 "" → `if (!text) return;` → **静默无动作**。
   **嫌疑点 B**：quick bar 在 long press / scroll 场景下，`suppressActionClickRef` 或 `suppressKeyboardClickRef` 在特定时序下未清空，导致 `triggerActionSequence` 被 return 吞掉。
   **嫌疑点 C**：`copyModeActive` 状态未正确透传到 `TerminalView`，或在 split pane场景下多 session copyModeActive 互相覆盖。

### 当前 copy mode owner（已确认）
- `android/src/components/terminal/TerminalQuickBar.tsx`：`tmux-copy` action → `onToggleCopyMode` prop
- `android/src/pages/useTerminalPageCopyRuntime.ts`：状态机 + `handleCopySelectedText` / `handleCopySelectionEnd`
- `android/src/pages/terminal-copy-selection.ts`：`writeTextToClipboard`（native + fallback）+ `terminalBufferRowsToPlainText`
- `android/src/pages/TerminalPageCopyMenu.tsx`：copy menu UI +4 个按钮事件
- `android/src/pages/TerminalPageStageShell.tsx`：`copyModeActive` + `copyStartRowIndex`/`copyEndRowIndex`/`copyPreviewRowIndex` → `TerminalView`
- `android/src/components/TerminalView.tsx`：copy mode 长按手势 `startCopyLongPress` + `onLongPressRow`
- `android/native/android/app/src/main/java/com/zterm/android/DeviceClipboardPlugin.java`：native clipboard write

### 验证门禁（定向）
```bash
# 1. copy selection 相关全部红测
cd android && pnpm exec vitest run \
  src/pages/useTerminalPageCopyRuntime.test.tsx \
  src/pages/terminal-copy-selection.test.ts \
  src/components/terminal/system-copy-state-machine.test.tsx \
  src/components/terminal/system-copy-longpress-regression.test.tsx \
  --reporter dot

# 2. build
cd android && pnpm exec tsc -p tsconfig.json --noEmit --pretty false

# 3. TerminalPage 入口 smoke（vitest）
cd android && pnpm exec vitest run src/pages/TerminalPage.android-ime.test.tsx \
  --reporter dot -t "copy\|Copy\|selection" 2>&1 | tail -20
```

### 修复策略
- **真源优先**：copy 内容必须来自 session buffer；任何覆盖失败必须显式报错，不做静默 return。
- **不新增 fallback**：已确认 native plugin路径正确，只修覆盖判定路径。
- **职责边界**：只改 `useTerminalPageCopyRuntime` + `terminal-copy-selection.ts`，不改 TerminalView/TerminalPageStageShell 链路。

### 修复步骤（顺序执行）
1. 在 `terminal-copy-selection.ts` 的 `terminalBufferRowsToPlainText` 前加覆盖失败显式错误：
   - 若 `resolveCopySelectionBuffer` 返回 null，打印 `console.warn("[CopySelection] buffer does not cover rows X-Y, session: S")` 并返回 `null`触发 caller 错误处理。
2. 在 `useTerminalPageCopyRuntime.ts` 的 `handleCopySelectedText` 中：
   - 若 `text` 为空，显式调用 `logAsyncCleanupFailure` 并保留 `copySelection`（不要 reset）以便 debug overlay 显示状态。
3. 在 `handleCopySelectionEnd` 中同样加空 text 显式处理。
4. 确认 `suppressActionClickRef` / `suppressKeyboardClickRef` 在 long press 结束后会清空，必要时在 `cancelCopyLongPress` 中主动清。
5. 补红测：`handleCopySelectedText` 在 buffer 不覆盖时应调用 `logAsyncCleanupFailure`（mock console.warn 验证）。

### 完成标准（本次）
- 上述5步完成后，定向红测全绿。
- `handleCopySelectedText` 在 buffer 不覆盖时不再静默 return，而是显式 warn + 保留状态。
- 无回归：其他 QuickBar 按钮行为不变。
