# quickbar props/type 契约审计

- 日期：2026-05-24
- 审计对象：`TerminalPage.tsx` → `TerminalQuickBar` props 契约
- 目标：明确各 props 的 owner 与 type 归属，为 `TerminalPageQuickBarAssembly` 抽取提供可实施的接口真源

## 1. 当前 props 全景

### 1.1 TerminalQuickBar 定义的 props（来自 `TerminalQuickBar.tsx` 第 78-110 行）

| prop | type | 备注 |
|------|------|------|
| `activeSessionId` | `string\|null` | quickbar input session |
| `quickActions` | `QuickAction[]` | |
| `shortcutActions` | `TerminalShortcutAction[]` | |
| `onSendSequence` | `(sequence: string) => void` | **无 sessionId 参数** |
| `onImagePaste` | `(sessionId, file) => ...` | |
| `onFileAttach` | `(sessionId, file) => ...` | |
| `keyboardVisible` | `boolean` | |
| `keyboardInsetPx` | `number` | |
| `onToggleKeyboard` | `() => void` | |
| `onQuickActionsChange` | `(actions) => void` | |
| `onShortcutActionsChange` | `(actions) => void` | |
| `sessionDraft` | `string` | |
| `onSessionDraftChange` | `(value: string) => void` | **无 sessionId 参数** |
| `onSessionDraftSend` | `(value: string) => void` | **无 sessionId 参数** |
| `onOpenScheduleComposer` | `(text: string) => void` | **有 text 参数** |
| `splitAvailable` | `boolean` | |
| `splitVisible` | `boolean` | |
| `shellMode` | `"inline" \| "floating-collapsed"` | **与 page 传入的 `"adaptive-phone" \| "mirror-fixed"` 不兼容** |
| `collapseAvailable` | `boolean` | |
| `collapsed` | `boolean` | |
| `onCollapsedChange` | `(v: boolean) => void` | |
| `currentSplitCount` | `number` | |
| `splitCountOptions` | `number[]` | |
| `onSetSplitCount` | `(n: number) => void` | |
| `onToggleSplitLayout` | `() => void` | |
| `onCycleSplitPane` | `() => void` | |
| `onEditorDomFocusChange` | `(active: boolean) => void` | |
| `onMeasuredHeightChange` | `(height: number) => void` | |
| `onOpenFileTransfer` | `(mode?: "sync") => void` | **有 mode 参数** |
| `onToggleDebugOverlay` | `() => void` | |
| `debugOverlayVisible` | `boolean` | |
| `onToggleAbsoluteLineNumbers` | `() => void` | |
| `copyDebugLabel` | `string` | |
| `copyModeActive` | `boolean` | |
| `onToggleCopyMode` | `() => void` | |
| `remoteScreenshotStatus` | `"idle"\|"capturing"\|...` | **与 `resolveRemoteScreenshotQuickBarStatus` 返回值 `RemoteScreenshotStatusPayload \| null` 不兼容** |
| `shortcutSmartSort` | `boolean` | |
| `shortcutFrequencyMap` | `Record<string,number>` | |
| `onShortcutUse` | `(shortcutId: string) => void` | |

### 1.2 TerminalPage 传入的实际 props（第 570-615 行）

| prop | page 传入值 | 实际类型 |
|------|------------|----------|
| `onSendSequence` | `handleQuickBarSendSequence` | `(sequence: string) => void`（来自 `useTerminalPageQuickBarActions`） |
| `onSessionDraftChange` | `handleQuickBarSessionDraftChange` | `(value: string) => void`（来自 `useTerminalPageQuickBarActions`，无 sessionId） |
| `onSessionDraftSend` | `handleQuickBarSessionDraftSend` | 同上 |
| `onOpenScheduleComposer` | `handleQuickBarOpenScheduleComposer` | 来自 `useTerminalPageOverlays` |
| `shellMode` | `layoutProfile.quickBar.shellMode` | `"adaptive-phone" \| "mirror-fixed"` |
| `remoteScreenshotStatus` | `resolveRemoteScreenshotQuickBarStatus(remoteScreenshotPreview)` | `RemoteScreenshotStatusPayload \| null` |
| `onOpenFileTransfer` | `handleQuickBarOpenFileTransfer` | 来自 `useTerminalPageOverlays`，调用时无参数 |

## 2. 已发现的 type 冲突

### 冲突 1：`shellMode` literal type 不匹配

- `TerminalQuickBar` 定义：`"inline" | "floating-collapsed"`
- `TerminalPage` 传入：`layoutProfile.quickBar.shellMode` → 实际值是 `"adaptive-phone" | "mirror-fixed"`

**根因**：`layoutProfile` 来自 `resolveTerminalLayoutProfile`，该函数返回的 `shellMode` 与 `TerminalQuickBar` 定义的 `shellMode` 来自不同语义体系：
- `TerminalQuickBar` 的 `shellMode` 描述的是 quickbar 自身的布局模式（`inline`=嵌入、`floating-collapsed`=悬浮折叠）
- `layoutProfile.quickBar.shellMode` 描述的是终端布局风格（`adaptive-phone`=自适应、`mirror-fixed`=镜像固定）

两者含义不同，不能直接等价映射。

**影响**：若抽取 `TerminalPageQuickBarAssembly`，需要在 page 或 assembly 层做 `shellMode` 的语义转换（`"adaptive-phone"` → `"inline"`，`"mirror-fixed"` → `"floating-collapsed"`），而不是直接透传。

### 冲突 2：`remoteScreenshotStatus` type 不匹配

- `TerminalQuickBar` 定义：`"idle"|"capturing"|"transferring"|"preview-ready"|"saving"|"failed"`
- `TerminalPage` 传入：`resolveRemoteScreenshotQuickBarStatus(remoteScreenshotPreview)` → 返回 `RemoteScreenshotStatusPayload | null`

**根因**：`resolveRemoteScreenshotQuickBarStatus` 返回的是 `RemoteScreenshotStatusPayload`（含 `{phase, progress}` 等结构），而 `TerminalQuickBar` 只定义了字面量 string union。

**影响**：`TerminalQuickBar` 实际上只使用了 `remoteScreenshotStatus?.phase`（通过 `getRemoteScreenshotStatusLabel` 等），所以 page 需要提取 `.phase` 再传入 assembly。

### 冲突 3：`onSendSequence` / `onSessionDraftChange` / `onSessionDraftSend` 签名

- `TerminalQuickBar` 定义：不带 `sessionId` 参数
- `TerminalPage` 实际 handler（来自 `useTerminalPageQuickBarActions`）：内部闭包捕获 `uiSessionId`，所以透传时不需要 sessionId 参数

**结论**：这不是冲突，是正确的设计——`TerminalQuickBar` 本身不需要知道 sessionId，由 handler 在内部捕获。但 `useTerminalPageQuickBarActions` 的 handler 签名需要与 `TerminalQuickBar` props 匹配。

### 冲突 4：`onOpenScheduleComposer` / `onOpenFileTransfer` 参数

- `TerminalQuickBar` 定义：`onOpenScheduleComposer?: (text: string) => void`（有 text 参数）
- `TerminalPage` 传入：`handleQuickBarOpenScheduleComposer`（来自 `useTerminalPageOverlays`，无参数调用）

**根因**：`TerminalQuickBar` 在某些场景（shortcut composer）会传 `text` 参数，但 `TerminalPage` 使用的 `handleQuickBarOpenScheduleComposer` 只处理来自 quickbar 常规按钮的触发，不带参数。

**结论**：assembly 需要兼容两种调用模式。

## 3. props owner 归属分析

### 3.1 page-shell owner props（应留在 page 层，不可外抽）

| prop | owner | 原因 |
|------|-------|------|
| `activeSessionId` | page-shell | 来自 `useTerminalPageInteractionRuntime` 的 `uiSessionId` |
| `sessionDraft` | page-shell | 来自 `props.sessionDraft` |
| `quickActions` | page-shell | 来自 `props.quickActions` |
| `shortcutActions` | page-shell | 来自 `props.shortcutActions` |
| `splitAvailable` | page-shell | 来自 `useTerminalWorkspace` 的 `splitAvailable` |
| `splitVisible` | page-shell | 来自 `useTerminalWorkspace` 的 `splitVisible` |
| `currentSplitCount` | page-shell | `workspacePanes.length` |
| `shortcutSmartSort` | page-shell | 来自 props |
| `shortcutFrequencyMap` | page-shell | 来自 props |
| `copyDebugLabel` | page-shell | page 内 computed string |

### 3.2 keyboard-runtime derived props（来自 `useTerminalPageKeyboardRuntime`）

| prop | source | 说明 |
|------|--------|------|
| `keyboardVisible` | `terminalImeActive && effectiveKeyboardLiftPx > 0` | keyboard runtime 派生 |
| `keyboardInsetPx` | `quickBarShellKeyboardLiftPx` | keyboard runtime 派生 |
| `onToggleKeyboard` | `handleToggleKeyboard` | keyboard runtime handler |
| `onEditorDomFocusChange` | `handleQuickBarEditorDomFocusChange` | keyboard runtime handler |

### 3.3 quickbar-actions derived props（来自 `useTerminalPageQuickBarActions`）

| prop | source | 说明 |
|------|--------|------|
| `onSendSequence` | `handleQuickBarSendSequence` | quickbar-actions handler |
| `onSessionDraftChange` | `handleQuickBarSessionDraftChange` | quickbar-actions handler |
| `onSessionDraftSend` | `handleQuickBarSessionDraftSend` | quickbar-actions handler |
| `onMeasuredHeightChange` | `handleQuickBarMeasuredHeightChange` | quickbar-actions handler |

### 3.4 overlay-runtime derived props（来自 `useTerminalPageOverlays`）

| prop | source | 说明 |
|------|--------|------|
| `onOpenScheduleComposer` | `handleQuickBarOpenScheduleComposer` | overlay runtime handler |
| `onOpenFileTransfer` | `handleQuickBarOpenFileTransfer` | overlay runtime handler |
| `onToggleDebugOverlay` | `handleQuickBarToggleDebugOverlay` | overlay runtime handler |
| `onToggleAbsoluteLineNumbers` | `handleQuickBarToggleAbsoluteLineNumbers` | overlay runtime handler |
| `onRequestRemoteScreenshot` | `handleQuickBarRequestRemoteScreenshot` | overlay runtime handler |
| `debugOverlayVisible` | `debugOverlayVisible` | overlay runtime state |
| `remoteScreenshotStatus` | `resolveRemoteScreenshotQuickBarStatus(remoteScreenshotPreview)` | overlay runtime 派生，需提取 `.phase` |

### 3.5 copy-runtime derived props（来自 `useTerminalPageCopyRuntime`）

| prop | source | 说明 |
|------|--------|------|
| `copyModeActive` | `copySelection.active` | copy runtime state |
| `onToggleCopyMode` | `handleQuickBarToggleCopyMode` | copy runtime handler |

### 3.6 shell/layout derived props

| prop | source | 说明 |
|------|--------|------|
| `shellMode` | `layoutProfile.quickBar.shellMode` | 需要语义转换（`"adaptive-phone"` → `"inline"`，`"mirror-fixed"` → `"floating-collapsed"`） |
| `splitCountOptions` | `Array.from({length: availableSplitCount}, (_,i) => i+1)` | page 层 computed |

### 3.7 layout profile derived

| prop | source | 说明 |
|------|--------|------|
| `collapseAvailable` | `true`（硬编码） | |
| `collapsed` | `quickBarCollapsed`（page state） | |
| `onCollapsedChange` | `setQuickBarCollapsed`（page state setter） | |
| `onSetSplitCount` | `setSplitCount`（来自 `useTerminalWorkspace`） | |
| `onToggleSplitLayout` | `toggleSplit`（来自 `useTerminalWorkspace`） | |
| `onCycleSplitPane` | `cycleSecondaryPane`（来自 `useTerminalWorkspace`） | |
| `absoluteLineNumbersVisible` | `absoluteLineNumbersVisible`（来自 `useTerminalPageOverlays`） | |

## 4. 契约冲突的解决方案

### 4.1 `shellMode` 语义转换

```typescript
// assembly 层做语义转换
function resolveQuickBarShellMode(profileShellMode: "adaptive-phone" | "mirror-fixed"): "inline" | "floating-collapsed" {
  return profileShellMode === "adaptive-phone" ? "inline" : "floating-collapsed";
}
```

### 4.2 `remoteScreenshotStatus` 提取 phase

```typescript
// assembly 层提取 phase
const screenshotPhase = remoteScreenshotPreview?.phase ?? null;
<... remoteScreenshotStatus={screenshotPhase} ...>
```

### 4.3 `onOpenScheduleComposer` 适配

`useTerminalPageOverlays` 返回的 `handleQuickBarOpenScheduleComposer` 不带参数，而 `TerminalQuickBar` 期望 `(text: string) => void`。

解决方案：assembly 层包装一层：

```typescript
const wrappedOpenScheduleComposer = (text?: string) => {
  // text 来自 TerminalQuickBar shortcut composer（当前 page 不使用该场景）
  // page 当前只用无参调用
  handleQuickBarOpenScheduleComposer();
};
```

### 4.4 `onOpenFileTransfer` 适配

同上，assembly 层包装：

```typescript
const wrappedOpenFileTransfer = (mode?: "sync") => {
  handleQuickBarOpenFileTransfer();
};
```

## 5. 建议的 `TerminalPageQuickBarAssembly` 接口

```typescript
export interface TerminalPageQuickBarAssemblyProps {
  // page-shell owner
  activeSessionId: string | null;
  quickActions: QuickAction[];
  shortcutActions: TerminalShortcutAction[];
  sessionDraft: string;
  splitAvailable: boolean;
  splitVisible: boolean;
  currentSplitCount: number;
  splitCountOptions: number[];
  shortcutSmartSort?: boolean;
  shortcutFrequencyMap?: Record<string, number>;
  copyDebugLabel: string;

  // keyboard runtime derived
  keyboardVisible: boolean;
  keyboardInsetPx: number;
  onToggleKeyboard: () => void;
  onEditorDomFocusChange: (active: boolean) => void;

  // quickbar-actions derived
  onSendSequence: (sequence: string) => void;
  onSessionDraftChange: (value: string) => void;
  onSessionDraftSend: (value: string) => void;
  onMeasuredHeightChange: (height: number) => void;

  // overlay runtime derived
  onOpenScheduleComposer: (text?: string) => void;
  onOpenFileTransfer: (mode?: "sync") => void;
  onToggleDebugOverlay: () => void;
  onToggleAbsoluteLineNumbers: () => void;
  onRequestRemoteScreenshot: () => void;
  debugOverlayVisible: boolean;
  remoteScreenshotStatusPhase: "idle" | "capturing" | "transferring" | "preview-ready" | "saving" | "failed" | null;

  // copy runtime derived
  copyModeActive: boolean;
  onToggleCopyMode: () => void;

  // workspace derived
  shellMode: "inline" | "floating-collapsed";
  collapseAvailable: boolean;
  collapsed: boolean;
  onCollapsedChange: (v: boolean) => void;
  onSetSplitCount: (n: number) => void;
  onToggleSplitLayout: () => void;
  onCycleSplitPane: () => void;

  // layout
  absoluteLineNumbersVisible: boolean;

  // optional
  onShortcutUse?: (shortcutId: string) => void;
}
```

## 6. 为什么需要契约审计后才能抽取

1. **类型不兼容不可绕过**：TS 不允许 `string` union type 直接赋值不兼容的 literal union。若不先解决 `shellMode` / `remoteScreenshotStatus` 的 type 冲突，assembly 抽出来也会因为 TypeScript 报错而无法通过编译。

2. **`TerminalQuickBar` 的 props 定义本身就是旧契约**：它内部的 `shellMode` 语义与 `layoutProfile` 返回的语义已经不一致，说明这不是 page 层的问题，而是 `TerminalQuickBar` 自己的 type 定义需要更新。

3. **正确的抽取顺序**：
   1. 更新 `TerminalQuickBar` 的 `shellMode` type 定义（或在 assembly 层做语义转换）
   2. 更新 `TerminalQuickBar` 的 `remoteScreenshotStatus` type 定义（或在 assembly 层提取 `.phase`）
   3. 确认各 handler 的签名是否需要 adapter wrapper
   4. 再抽取 `TerminalPageQuickBarAssembly`

4. **本轮尝试失败的原因**：上轮直接抽取时没有先解决类型冲突，导致 TS 报错，只能回退。契约审计完成后，可以带着正确的类型接口再迁移。

## 7. 下一步

在解决上述 type 冲突后，按以下顺序实施 `TerminalPageQuickBarAssembly` 抽取：

1. 更新 `TerminalQuickBar` props type（或在 assembly 层做 adapter）
2. 创建 `TerminalPageQuickBarAssembly.tsx`
3. 接入 `TerminalPage.tsx`
4. 物理删除 `quickBarNode` useMemo 块
5. 跑 tsc + targeted tests 验证
