# Terminal Keyboard IME Test Design

## Objective

Lock `terminal.keyboard_ime` so Android IME lift only affects the UI shell and QuickBar position, while terminal renderer, daemon mirror, and tmux geometry remain unchanged.

## Lifecycle Path

```text
ImeAnchor / Keyboard physical keyboard state
-> TerminalPage keyboardInset + stable shell viewport
-> resolveKeyboardLiftPx
-> TerminalPage stage bottom and QuickBar shell bottom
-> TerminalQuickBar measured chrome height
-> TerminalPageStageShell container reserve
```

Mainline call ids:

- `android_mainline:App->TerminalPage`
- `android_mainline:TerminalPage->QuickBar`
- `android_mainline:TerminalPage->StageShell`
- `android_mainline:TerminalPage->TerminalView`

Owner feature: `terminal.keyboard_ime`.

## White-Box Plan

- `terminal-keyboard-lift.test.ts` covers keyboard lift normalization, capped overlay lift, already-resized WebView detection, Android header inset stability, and foldable/landscape bottom chrome lift.
- `TerminalQuickBar.test.tsx` proves QuickBar reports its real chrome height while IME lift is applied outside the component.
- Negative path: `TerminalQuickBar` must not subtract `keyboardInsetPx` from measured chrome height, because `TerminalQuickBarShell.bottom` already consumes that lift.

## Module Black-Box Plan

- `TerminalPage.android-ime.test.tsx` proves stage bottom reserve equals measured QuickBar chrome + safe offset + bottom chrome lift + IME lift.
- `TerminalPage.lifecycle-cleanup.test.tsx` proves Keyboard, visualViewport, and virtualKeyboard listeners are registered and removed from their original sources.
- `TerminalPageStageShell.pane-stage.test.tsx` proves stage positioning remains owned by shell layout and does not pass IME geometry into `TerminalView` resize.

## Project Black-Box Impact

- The local gate simulates the Android field symptom where the IME is visible but the stage no longer reserves QuickBar height, producing bottom misalignment.
- The fix must not change daemon, buffer manager, renderer repaint, or upstream terminal rows/cols.
- If device screenshots still show drift after this gate passes, next evidence should come from client debug snapshot values for `keyboardInset`, `terminalImeLiftPx`, `quickBarHeight`, and `terminalChromeBottomPx`.

## Known Gaps

- This test design does not replace L5 APK / real WebView visual verification.
- It does not validate OEM-specific IME animation timing frame-by-frame; it locks the steady-state geometry contract after keyboard state settles.
