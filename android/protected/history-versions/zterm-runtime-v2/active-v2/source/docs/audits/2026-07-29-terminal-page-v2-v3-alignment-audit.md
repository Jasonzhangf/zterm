# TerminalPage v2/v3 对齐审计

- 日期：2026-07-29
- 范围：`TerminalPage.tsx`、page-local runtime、workspace split、v2/v3/v4 审计文档
- 基线：
  - `android/docs/audits/2026-05-24-shared-blocks-orchestration-audit-v2.md`
  - `android/docs/audits/2026-05-24-shared-blocks-orchestration-audit-v3.md`
  - `android/docs/audits/2026-05-24-shared-blocks-orchestration-audit-v4.md`

## 结论

当前代码不能按 v3 口径宣称 `TerminalPage` 已完成 interaction runtime 收口。v3 的方向仍正确，但当前实现已经与 v3 的完成声明重新偏离：

1. `useTerminalPageInteractionRuntime.ts` 是孤立 owner，没有被任何产品代码调用。
2. `useTerminalPageShellActionsRuntime.ts` 已存在并有单测，但同样没有接入产品代码。
3. `TerminalPage.tsx` 仍直接持有 swipe、pane activate、chrome session switch、quick-tab/tab-manager、viewport change 等 coordinator。
4. v2/v3 的 targeted gate 当前不全绿。
5. workspace split 的一个测试与最新 empty-pane 产品语义相反，属于 stale red test。

## 证据

### 体量

当前行数：

```text
android/src/pages/TerminalPage.tsx                      3849
android/src/pages/useTerminalPageInteractionRuntime.ts    237
android/src/pages/useTerminalPageShellActionsRuntime.ts    90
android/src/pages/useTerminalPageCopyRuntime.ts           197
android/src/pages/useTerminalPageOverlays.ts              233
android/src/hooks/useTerminalWorkspace.ts                 693
```

对比 v3：

```text
TerminalPage.tsx v3 记录：2586 行
TerminalPage.tsx 当前：3849 行
```

这不等于所有新增代码都错误，但说明“纯编排壳”目标距离更远，不能沿用 v3 的接近完成口径。

### 产品调用绑定

`rg "useTerminalPageInteractionRuntime\(" android/src` 只有定义文件命中：

```text
android/src/pages/useTerminalPageInteractionRuntime.ts:51:export function useTerminalPageInteractionRuntime(
```

`rg "useTerminalPageShellActionsRuntime\(" android/src` 只有定义和单测命中：

```text
android/src/pages/useTerminalPageShellActionsRuntime.ts:23:export function useTerminalPageShellActionsRuntime(
android/src/pages/useTerminalPageShellActionsRuntime.test.tsx:14:...
android/src/pages/useTerminalPageShellActionsRuntime.test.tsx:44:...
```

说明两份 runtime 当前不是产品主线 owner，只是未接入的实现/测试孤岛。

### TerminalPage 仍持有的重复 owner

`TerminalPage.tsx` 当前仍直接持有：

- `handleSwipeTab`：`android/src/pages/TerminalPage.tsx:2179`
- `activatePaneAndSession`：`android/src/pages/TerminalPage.tsx:2948`
- `handleSwitchSessionFromChrome`：`android/src/pages/TerminalPage.tsx:2973`
- `handleOpenQuickTabPickerForPane`：`android/src/pages/TerminalPage.tsx:3295`
- `handleOpenTabManager`：`android/src/pages/TerminalPage.tsx:3327`
- `handleTerminalViewportChange`：`android/src/pages/TerminalPage.tsx:3335`

这些能力在 v3/v4 的目标中分别应归到 interaction runtime、workspace owner 或 shell-actions runtime。当前是 page 与 runtime 双真源/孤岛并存。

### 验证结果

命令 1：

```bash
pnpm --dir android run type-check
```

结果：PASS。

命令 2：

```bash
pnpm --dir android exec vitest run \
  src/pages/useTerminalPageCopyRuntime.test.tsx \
  src/pages/useTerminalPageOverlays.test.tsx \
  src/pages/useTerminalPageShellActionsRuntime.test.tsx \
  src/pages/terminal-page-render-keys.test.ts \
  src/pages/terminal-keyboard-lift.test.ts \
  src/pages/terminal-copy-selection.test.ts \
  src/pages/TerminalPage.android-ime.test.tsx \
  src/pages/TerminalPage.render-scope.test.tsx \
  --reporter dot
```

结果：FAIL，`108 PASS / 1 FAIL`。

失败点：

```text
src/pages/terminal-page-render-keys.test.ts
expected key without ICE fields, received key with trailing selectedIcePair fields.
```

命令 3：

```bash
pnpm --dir android exec vitest run \
  src/hooks/useTerminalWorkspace.test.tsx \
  src/hooks/useTerminalWorkspace.split-pane.test.tsx \
  src/lib/workspace-persistence.test.ts \
  src/pages/useTerminalPageShellActionsRuntime.test.tsx \
  --reporter dot
```

结果：FAIL，`24 PASS / 1 FAIL`。

失败点：

```text
src/hooks/useTerminalWorkspace.split-pane.test.tsx
case 名称写着 "new pane gets no session"，但断言仍期望新 pane 拥有 s1。
```

这和 2026-07-29 最新多 pane 规则冲突：单 session split 允许生成编号明确的 empty pane，empty pane 点击再打开 scoped session picker。

## Findings

### P0：v3 的 interaction runtime 完成声明当前不成立

`useTerminalPageInteractionRuntime.ts` 定义了 `interactiveSession / renderedPaneSessions / handleSwipeTabRaw / handleSwitchSessionFromChromeRaw`，但产品代码没有调用它；`TerminalPage.tsx` 继续直接实现同一组语义。当前状态不是 v3 说的“interaction runtime 已完成”，而是 runtime 孤岛 + page 重复 owner。

风险：
- 后续修 swipe/tab/session 切换时容易改到 page，runtime 测试仍绿但产品不变。
- feature/function map 指向 runtime 文件会给审计造成假安全感。

唯一修复方向：
- 先把 `useTerminalPageInteractionRuntime` 接回 `TerminalPage.tsx` 产品主线。
- 接入后物理删除 page 内重复 `handleSwipeTab` / `handleSwitchSessionFromChrome` / live pane derived state owner。
- 增加 gate：function map 不能只验证文件存在，必须验证产品 call-site 真实调用 owner。

### P0：shell-actions runtime 已实现但未接入，v4 的立即改进项停在孤岛状态

`useTerminalPageShellActionsRuntime.ts` 已实现 `handleOpenQuickTabPickerForPane / handleOpenTabManager / handleTerminalViewportChange`，但 `TerminalPage.tsx` 仍持有三者的 page-local 实现。当前与 v4 的“继续清 page-local coordinator”目标相反。

风险：
- 单测只证明孤立 hook 行为，不证明产品行为。
- viewport-mode coordinator 与 tab manager open 时序仍留在 page，纯编排壳目标没有推进。

唯一修复方向：
- 接入 `useTerminalPageShellActionsRuntime`。
- 保留 drawer debug 增量时，要把 debug event 作为显式 shell-action 输入/输出，不要让 page 重新长出第二套 open handler。

### P1：workspace pane activation owner 双写

`useTerminalWorkspace.ts` 已暴露 `activatePaneAndSession`，但 `TerminalPage.tsx` 又定义同名 page-local owner。pane activation 本质是 workspace truth 变更，应归 `useTerminalWorkspace`。

风险：
- workspace 单测验证的 owner 可能不是产品实际调用路径。
- split pane session 激活容易出现 workspace active pane 与 runtime active session 非原子对齐。

唯一修复方向：
- 让 `TerminalPage.tsx` 消费 `workspaceRuntime.activatePaneAndSession`。
- page 只做必要的 debug projection，不直接计算目标 tab/session 切换。

### P1：v2/v3 targeted gate 已失效

v3 声称 targeted suite 绿，但当前同类门禁已经 red。两个 red 点性质不同：

- `terminal-page-render-keys.test.ts` 是测试期望未随 selected ICE pair key 扩展更新。
- `useTerminalWorkspace.split-pane.test.tsx` 是 stale product expectation，已经与 empty-pane 规则冲突。

唯一修复方向：
- 先修红测语义，而不是只改产品代码。
- 把 empty pane case 改成显式断言新 pane `tabs=[]` / `activeTabId=''`，并保留点击 empty pane 打开 scoped picker 的 UI gate。

### P2：审计文档 v4 已过期

v4 记录 `TerminalPage.tsx` 为 2541 行，并称已接近目标；当前 3849 行，且多出 session preview、remote drawer、multi-pane 等新 coordinator。v4 不能再作为现状口径，只能作为历史参考。

唯一修复方向：
- 后续继续推进前，以本审计作为当前基线。
- 新增或修改 feature 时同步更新 function map/call map，防止 “doc 指向孤岛 runtime” 再次发生。

## 当前正确下一步

1. 修 gate 口径：更新两个 stale tests，让 red 代表真实架构问题。
2. 接入 `useTerminalPageInteractionRuntime`，删除 page 内重复 swipe/session switch owner。
3. 接入或删除 `useTerminalPageShellActionsRuntime`；如果接入，必须同时迁走 quick-tab/tab-manager/viewport handlers。
4. 把 pane activation 消费统一到 `useTerminalWorkspace.activatePaneAndSession`。
5. 补机器门禁：runtime owner 文件必须被产品主线引用，function map 不能只校验文件存在。

## 本轮未做

- 未改产品代码。
- 未修测试。
- 未跑 APK / L5，因为本轮是架构审计，不是 Android 交付包。
- MemoryPalace 仍不可用：`scripts/mempalace-mine-zterm.sh` 失败于缺失 pipx interpreter，本轮没有 re-mine 证据。
