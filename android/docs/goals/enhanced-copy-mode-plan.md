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
