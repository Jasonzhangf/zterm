# Copy Mode Function Map

## Feature ID
`copy-mode-longpress`

## Owner
TerminalPage.tsx → useTerminalPageCopyRuntime.ts → TerminalView.tsx → VisibleRow.tsx

## Lifecycle (copy mode)

```
1. User taps "拷贝" quickbar button
   → useTerminalPageCopyRuntime.handleQuickBarToggleCopyMode()
   → setCopySelection({ active: true, sessionId: null, ... })

2. copySelection.active = true → TerminalView.copyModeActive=true
   → TerminalView mounts host-level useEffect:
     host.addEventListener('touchstart' + 'contextmenu' + 'selectstart', capture, non-passive)
     CSS: .wterm[data-copy-mode="true"]{-webkit-touch-callout:none;user-select:none;}
   → TerminalView row-level preventDefault on pointer/touch long-press

3. User long-presses a terminal row (≥420ms without move)
   → VisibleRow → TerminalView.startCopyLongPress / startCopyLongPressTouch
   → TerminalView.onLongPressRow(sessionId, rowIndex, x, y)

4. useTerminalPageCopyRuntime.handleLongPressCopyRow(sessionId, rowIndex, x, y)
   → setCopySelection({ ...menu: { x, y, rowIndex } })

5. User taps end row
   → VisibleRow → startCopyLongPress / startCopyLongPressTouch (second row)
   → setCopySelection({ ...menu: { rowIndex: endRow } })

6. User taps "copy" button in copy menu
   → handleCopySelectedText() → writeTextToClipboard() → setCopySelection(EMPTY)

## Closing copy mode (no clipboard)
- User taps close → handleCloseCopyMenu() → setCopySelection(EMPTY)
- Tab switch → resetCopySelectionForTabChange() in useEffect([uiSessionId])
- Session disconnect → same useEffect

## State Machine

```
IDLE: copySelection.active=false
  └─ tap "拷贝" → ACTIVE

ACTIVE: copySelection.active=true, menu=null
  └─ long-press start → ACTIVE_MENU

ACTIVE_MENU: copySelection.active=true, menu={x,y,rowIndex}
  └─ long-press end row → ACTIVE_MENU (menu updates rowIndex)
  └─ tap copy → IDLE (clipboard written)
  └─ tap close / tab-switch / disconnect → IDLE
```

## Key Gates

### Gate 1: copyModeActive guard in host-level listeners
```ts
// TerminalView useEffect [copyModeActive]
if (!host || !copyModeActive) return;
// install addEventListener('touchstart'|'contextmenu'|'selectstart', capture, non-passive)
// uninstall on cleanup
```
→ ensures native menu blocked ONLY when copyModeActive=true

### Gate 2: copyModeActive guard in row handlers
```ts
// startCopyLongPress / startCopyLongPressTouch
if (!copyModeActive || !sessionId || !onLongPressRow) return;
// prevents false long-press triggers
```
→ only fires when copyModeActive=true

### Gate 3: session/epoch guard on copyRuntime effect
```ts
// useEffect([uiSessionId])
setCopySelection(current) {
  if (!current.active || !current.sessionId) return current;
  return current.sessionId === uiSessionId ? current : EMPTY;
}
```
→ resets if active copy session becomes inactive (e.g., tab switch)

### Gate 4: quickbar button visual state
```tsx
backgroundColor: copyModeActive ? 'rgba(113,164,255,0.28)' : undefined
```
→ button highlights when active

### Gate 5: row highlight state
```tsx
copyStartRowIndex === absoluteIndex → highlight green
endRowIndex === absoluteIndex → highlight blue
```

## Key Bugs Fixed

| Commit | Bug | Fix |
|--------|-----|-----|
| `7717f0d` | memo comparison always returned true → button state didn't update | Remove custom memo compare |
| `38db24f` | copy runtime scattered in TerminalPage | Extract useTerminalPageCopyRuntime.ts |
| `526e47b` | header long-press ref cleanup | Proper refs in header |
| `2ba484c` | tap didn't set start row immediately | Add onClickCapture for tap |
| `9c7e304` | Initial copy mode implementation | Full feature baseline |
| `da3d24a` | non-copy mode lost system text selection | user-select: text when !copyModeActive |

## Verification

红测文件：
- `system-copy-state-machine.test.tsx`: 7 tests
- `system-copy-longpress-regression.test.tsx`: 2 tests
- `useTerminalPageCopyRuntime.test.tsx`: runtime contract
- `terminal-copy-selection.test.ts`: pure utility tests

当前 HEAD: `8c52ef3` — copy mode state machine 完整，gates 锁住，无已知破坏性变更。
