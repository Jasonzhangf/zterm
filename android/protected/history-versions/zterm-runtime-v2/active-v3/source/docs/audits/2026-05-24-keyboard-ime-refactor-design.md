# keyboard/IME 整体重构设计文档

- 日期：2026-05-24
- 状态：设计稿，待实施
- 目标：将 `TerminalPage.tsx` 内的 keyboard/IME 主闭环封装进 `useTerminalPageKeyboardRuntime.ts`

## 1. 当前 owner 全景（TerminalPage.tsx 1329 行中）

### 1.1 核心 state（5 个，必须同 owner）

| state | 类型 | 用途 |
|-------|------|------|
| `terminalKeyboardRequested` | `boolean` | IME 可见性真相 |
| `keyboardInset` | `number` | keyboard 高度真相 |
| `quickBarEditorFocused` | `boolean` | quickbar editor 激活真相 |
| `focusNonce` | `number` | terminal focus retry 触发器 |
| `viewportWidth` | `number` | 视口宽度（被 updateViewportMetrics 写入） |
| `headerTopInsetPx` | `number` | 顶部 inset（被 updateViewportMetrics 写入） |

### 1.2 Ref owner（7 个，必须同 owner）

| ref | 类型 | 用途 |
|-----|------|------|
| `activeSessionIdRef` | `MutableRefObject<string|null>` | 当前 active session（ImeAnchor listener 内读取） |
| `quickBarEditorFocusedRef` | `MutableRefObject<boolean>` | quickbar focus 的 mutable mirror |
| `terminalInputHandlerRef` | `MutableRefObject<typeof onTerminalInput>` | terminal input handler mutable ref |
| `pendingAndroidImeFocusTimerRef` | `MutableRefObject<number|null>` | IME focus 防抖 timer |
| `androidImeFocusRouteKeyRef` | `MutableRefObject<string|null>` | IME focus routing key 防重 |
| `terminalFocusRetryTimeoutsRef` | `MutableRefObject<number[]>` | focus retry timers |
| `stableLayoutViewportHeightRef` | `MutableRefObject<number>` | viewport freeze 语义 |
| `viewportMetricsFrameRef` | `MutableRefObject<number|null>` | viewport rAF 节流 |

### 1.3 Callback owner（5 个，互相依赖，必须同 owner）

| callback | 用途 |
|---------|------|
| `updateTerminalKeyboardRequested` | IME 可见性 setter |
| `updateKeyboardInset` | keyboard 高度 setter |
| `updateViewportMetrics` | viewport metrics setter |
| `scheduleViewportMetricsSync` | viewport rAF 节流编排 |
| `focusTerminalInput` | DOM input focus 编排 |
| `clearPendingAndroidImeFocus` | timer cancel |
| `clearTerminalFocusRetries` | retry timers cancel |
| `scheduleTerminalFocusRetries` | focus retry 编排 |
| `setAndroidEditorActive` | ImeAnchor.setEditorActive |
| `requestAndroidImeFocus` | IME focus routing 编排 |
| `restoreAndroidTerminalImeRoute` | IME routing 恢复编排 |
| `keepTerminalInputFocused` | 统一保持 focus 编排 |
| `handleToggleKeyboard` | toggle 编排 |
| `handleQuickBarEditorDomFocusChange` | DOM focus → IME state 联动 |

### 1.4 Effects（5 组，lifecycle 绑定）

| effect | 触发条件 |
|--------|---------|
| viewport metrics listener setup/teardown | `isAndroid` mount |
| keyboard show/hide listener (Keyboard.addListener) | `isAndroid` mount |
| ImeAnchor listeners (input/backspace/keyboardState) setup/teardown | `isAndroid` mount |
| focus retry on keyboard show | `terminalKeyboardRequested || keyboardInset` 变化 |
| quickbar editor blur → ImeAnchor.blur | `quickBarEditorFocused` 变化 |

### 1.5 派生属性（4 个，被 JSX 消费）

| property | 消费者 |
|----------|--------|
| `rawShellHeight` | shellHeight / viewport freeze effect |
| `keyboardViewportFreezeActive` | shellHeight |
| `shellHeight` | JSX 容器高度 |
| `effectiveKeyboardLiftPx` | JSX: TerminalStageShell / TerminalQuickBarShell |
| `terminalImeActive` | JSX: TerminalQuickBar keyboardVisible |
| `terminalImeLiftPx` | JSX: TerminalStageShell terminalImeLiftPx |
| `quickBarShellKeyboardLiftPx` | JSX: TerminalQuickBar keyboardInsetPx |

### 1.6 外部依赖（输入 props）

| prop | 用途 |
|------|------|
| `isAndroid` | 从 `Capacitor.getPlatform()` 派生，非 props |
| `onTerminalInput` | 被 `terminalInputHandlerRef` 持有 |
| `uiSessionId` | 被 `requestAndroidImeFocus` / `focusTerminalInput` 读取 |
| `onFileTransferMessage` | 仅透传，非 keyboard owner |

## 2. 不可分割的原因

### 2.1 state 三者同判

```typescript
// keyboardViewportFreezeActive 同时引用三者
const keyboardViewportFreezeActive =
  isAndroid && (terminalKeyboardRequested || keyboardInset > 0);

// restoreAndroidTerminalImeRoute 触发条件
if (!(terminalKeyboardRequested || keyboardInset > 0)) return;

// handleToggleKeyboard 条件分支
if (terminalKeyboardRequested || keyboardInset > 0) { /* hide */ }
else { /* show */ }
```

三者不能拆分：拆分任何一个都会导致另外两个的条件判断失去意义。

### 2.2 state 与 ref 不可分割

`quickBarEditorFocused` state 和 `quickBarEditorFocusedRef` ref：
- ref 的唯一目的是在 async/nested context 避免 stale
- ref 的值由 state 同步更新
- 两者必须同 owner

### 2.3 ImeAnchor listeners 与 refs 不可分割

两个 ImeAnchor listener 内持有 `activeSessionIdRef` 和 `terminalInputHandlerRef`：
- `emitToActiveSession` closure 读取 `activeSessionIdRef.current`
- 任何 ref 被迁走，listener closure 必须同步更新
- listener 生命周期绑定在 page mount 上，不能挂到其他 hook

### 2.4 focusNonce 与 render 的闭环

`focusNonce` 被 `focusTerminalInput` 递增，被 `TerminalStageShell` 消费：
- 若把 `focusNonce` 迁到 hook，`TerminalStageShell` 必须从 hook 返回值读取
- 这要求 hook 持有 `focusNonce` 和 `setFocusNonce`，且 hook 必须是 `TerminalStageShell` 的 prop 来源
- 这意味着要么 hook 持有 `focusNonce` 并通过返回值传给 StageShell，要么 StageShell 也接受一个 focusNonce prop

## 3. 目标 hook 接口设计

### 3.1 核心原则：单一 owner，不泄露 computed value

hook 接口设计的两条铁律：
1. **不通过回调泄露 computed value**：hook 内的 computed value（如 `keyboardInset`、`terminalKeyboardRequested`）直接作为返回值暴露，**不得**通过 `onXXXChange` 回调传给外部再由外部用 `useState` 重构
2. **单一 owner**：hook 持有所有 keyboard/IME 相关 state/refs/callbacks/effects，不拆分到多个 owner

如果外部组件（如 `useTerminalPageQuickBarActions`）需要 keyboard 状态：
- 从 `useTerminalPageKeyboardRuntime` 返回值直接读取
- **不得**通过父组件（page）作为中间人转发

### 3.2 Props 输入

```typescript
interface UseTerminalPageKeyboardRuntimeOptions {
  // 平台
  isAndroid: boolean;
  // 当前 active session id，用于 focus routing
  uiSessionId: string | null;
  // terminal input handler
  onTerminalInput?: (sessionId: string, data: string) => void;
  // quickbar editor 是否激活（来自 QuickBar DOM focus change）
  quickBarEditorFocused: boolean;
}
```

### 3.3 返回值

```typescript
interface UseTerminalPageKeyboardRuntimeResult {
  // === state（直接返回值，外部直接读取，不通过回调重构建）===
  terminalKeyboardRequested: boolean;
  keyboardInset: number;
  focusNonce: number;

  // === viewport metrics ===
  viewportWidth: number;
  headerTopInsetPx: number;

  // === 派生属性（hook 内 computed，外部直接消费）===
  keyboardViewportFreezeActive: boolean;
  shellHeight: number;
  rawShellHeight: number;
  effectiveKeyboardLiftPx: number;
  terminalImeActive: boolean;
  terminalImeLiftPx: number;
  quickBarShellKeyboardLiftPx: number;

  // === handlers ===
  handleToggleKeyboard: () => Promise<void>;
  handleQuickBarEditorDomFocusChange: (active: boolean) => void;
  keepTerminalInputFocused: () => void;
  restoreAndroidTerminalImeRoute: () => void;

  // === viewport metrics sync（page layout effect 调用）===
  updateViewportMetrics: () => void;
  scheduleViewportMetricsSync: () => void;
  viewportMetricsFrameRef: React.MutableRefObject<number | null>;

}
```

### 3.4 不属于本 hook 的 owner（明确排除）

以下真相**不进入** `useTerminalPageKeyboardRuntime.ts`：

- `sessionViewportModeStoreRef`：属于 shell-actions/debug overlay 消费链，不属于 keyboard/IME 真相
- `debugOverlayDragRef`：属于 debug overlay owner
- `quickBarHeight` / `quickBarCollapsed`：属于 quickbar shell owner
- `scheduleOpen` / `fileTransferOpen` / `remoteScreenshotPreview`：属于 overlay owner
- `copySelection`：属于 copy runtime owner
- `interactiveSession` / `renderedPaneSessions`：属于 interaction runtime owner

### 3.5 内部状态（hook 私有）

- `focusNonce` / `setFocusNonce`
- `terminalKeyboardRequested` / `setTerminalKeyboardRequested`
- `keyboardInset` / `setKeyboardInset`
- `viewportWidth` / `setViewportWidth`
- `headerTopInsetPx` / `setHeaderTopInsetPx`
- `activeSessionIdRef`
- `quickBarEditorFocusedRef`
- `terminalInputHandlerRef`
- `pendingAndroidImeFocusTimerRef`
- `androidImeFocusRouteKeyRef`
- `terminalFocusRetryTimeoutsRef`
- `stableLayoutViewportHeightRef`

## 4. 迁移顺序

### Phase 1：创建 hook 骨架（不接入 page）

1. 新建 `useTerminalPageKeyboardRuntime.ts`
2. 把 page 内所有 keyboard/IME state、refs、callbacks、effects 复制进去
3. 保留原有逻辑，不做任何改动
4. Hook 有**独立单测**覆盖所有 state/handler/effect 行为

### Phase 2：逐接口接入 page

按以下顺序逐个把 page 内旧 owner 替换为 hook 返回值：

1. `viewportWidth` / `headerTopInsetPx` / `scheduleViewportMetricsSync` / `viewportMetricsFrameRef`
2. `terminalKeyboardRequested` / `keyboardInset` / `updateTerminalKeyboardRequested` / `updateKeyboardInset`
3. `focusNonce` / `setFocusNonce`
4. `handleToggleKeyboard`
5. `handleQuickBarEditorDomFocusChange`
6. `keepTerminalInputFocused` / `restoreAndroidTerminalImeRoute`
7. `requestAndroidImeFocus` / `clearPendingAndroidImeFocus` / `scheduleTerminalFocusRetries` / `clearTerminalFocusRetries`
8. ImeAnchor listeners（input/backspace/keyboardState）
9. Keyboard listeners（show/hide）
10. viewport freeze effect
11. quickbar editor blur effect

每步完成后：
- `tsc --noEmit` 通过
- targeted tests 全部通过
- 物理删除 page 内对应旧实现

### Phase 3：清理 page 残留

- 删除 page 内所有 keyboard/IME 相关 state/ref/callback/effect
- 删除 page 内 `terminalKeyboardRequested`、`keyboardInset`、`focusNonce` 派生属性
- 确认 page 只剩 props 编排、hooks 装配、JSX 组合

## 5. 验证矩阵

### 5.1 hook 独立单测（必须新增）

| 测试场景 | 覆盖 |
|---------|------|
| `terminalKeyboardRequested` toggle | set → get |
| `keyboardInset` update | set → get |
| `focusNonce` increment | focusTerminalInput 调用后 nonce 变化 |
| `handleToggleKeyboard` hide path | state + ImeAnchor.hide 调用 |
| `handleToggleKeyboard` show path | state + ImeAnchor.show 调用 |
| `handleQuickBarEditorDomFocusChange` true | state + ImeAnchor.setEditorActive(true) |
| `handleQuickBarEditorDomFocusChange` false | state + ImeAnchor.blur / requestAndroidImeFocus |
| keepTerminalInputFocused quickbar active | clearTerminalFocusRetries 调用 |
| keepTerminalInputFocused Android | restoreAndroidTerminalImeRoute 调用 |
| keepTerminalInputFocused non-Android | scheduleTerminalFocusRetries 调用 |
| viewport freeze active when keyboard shown | shellHeight 冻结 |
| viewport freeze inactive when keyboard hidden | shellHeight 解冻 |
| ImeAnchor input listener emits | terminalInputHandlerRef 被调用 |
| ImeAnchor backspace listener emits | 正确数量 backspace |
| keyboardDidShow listener updates state | keyboardInset + terminalKeyboardRequested |
| keyboardDidHide listener updates state | keyboardInset=0 + terminalKeyboardRequested=false |
| `uiSessionId` change triggers refocus | requestAndroidImeFocus |
| `quickBarEditorFocused` change → ImeAnchor blur | keyboardStateListener effect |

### 5.2 页面回归测试

| 测试文件 | 覆盖 |
|---------|------|
| `TerminalPage.android-ime.test.tsx` | Android IME focus/switch/toggle |
| `TerminalPage.render-scope.test.tsx` | page render + JSX 组合 |
| `useTerminalPageCopyRuntime.test.tsx` | copy 与 keyboard 解耦 |
| `useTerminalPageOverlays.test.tsx` | overlay 与 keyboard 解耦 |
| `useTerminalPageInteractionRuntime.test.tsx` | interaction 与 keyboard 解耦 |

### 5.3 工程验证

- `pnpm --dir android exec tsc -p tsconfig.json --noEmit`
- `pnpm --dir android exec vitest run <targeted tests> --reporter dot`

## 6. 风险与规避

| 风险 | 规避 |
|------|------|
| `activeSessionIdRef` 被 ImeAnchor listener 读取，但 hook 内 `uiSessionId` 是 props | Hook 内部维护 `activeSessionIdRef`，由调用方在 `uiSessionId` 变化时同步写入 |
| `focusNonce` 被 `TerminalStageShell` 消费，需要从 hook 传出来 | Hook 返回 `focusNonce`，page 透传给 StageShell |
| `viewportMetricsFrameRef` 被 viewport listener effect 管理 | Hook 返回该 ref，effect 在 hook 内部管理 |
| `terminalInputHandlerRef` 持有 props `onTerminalInput` | Hook 接受 `onTerminalInput` 作为依赖项，通过 `useEffect` 同步更新 ref |
| lifecycle cleanup 丢失 | 每个 effect 的 cleanup 在 hook 内部完整管理，page 不感知 |
| `keyboardInset` 被 `useTerminalPageQuickBarActions` 消费 | 外部直接读取 hook 返回值，不通过 page 中转 |
| `terminalKeyboardRequested` 被 JSX 消费 | 直接从 hook 返回值读取，不通过 page 回调重构建 |

## 7. 为什么是唯一正确的设计

1. **state 必须同 owner**：5 个 state 和 7 个 refs 互相依赖，任何拆分都会制造双 owner 或循环引用。

2. **lifecycle 必须同 owner**：ImeAnchor/Keyboard listeners 的 setup/teardown 生命周期必须由持有对应 state/ref 的 owner 管理，不能分散在 page 和多个 hook。

3. **派生属性必须与 state 同 owner**：`shellHeight`、`effectiveKeyboardLiftPx`、`terminalImeLiftPx` 等派生属性由 `terminalKeyboardRequested`、`keyboardInset`、`rawShellHeight` 计算得出，这些 state 在 hook 内，所以派生属性也在 hook 内。

4. **外部依赖最小化**：hook 只依赖 `isAndroid`（平台）、`uiSessionId`（session routing）、`onTerminalInput`（input handler）、`quickBarEditorFocused`（DOM focus 结果）四个外部输入，不吞并 overlay/copy/shell-actions 等其他 owner。

5. **不误吞其他 owner**：`sessionViewportModeStoreRef`、debug overlay drag、quickbar shell height/collapse 等真相继续留在各自原 owner，不因为 keyboard 重构被错误并入。

6. **page 剩余职责**：page 在迁移后只剩 props 编排、hooks 装配、JSX 组合，符合"纯编排壳"目标。

## 8. 目标行数

| 文件 | 当前行数 | 目标行数 |
|------|----------|----------|
| `TerminalPage.tsx`（page 内 keyboard 部分） | ≈260 行 | 0（全部迁出） |
| `useTerminalPageKeyboardRuntime.ts` | 0（新建） | ≈380 行（含所有 state/refs/callbacks/effects） |
| `TerminalPage.tsx` 总计 | 1329 行 | ≈1069 行 |
