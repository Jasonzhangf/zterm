# Terminal Keyboard IME Test Design

## Objective

Lock `terminal.keyboard_ime` so Android IME lift only affects the UI shell and QuickBar position, while terminal renderer, daemon mirror, and tmux geometry remain unchanged.

## Lifecycle Path

```text
ImeAnchor native explicit show policy
-> ImeAnchor / Keyboard physical keyboard state
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
- Positive transition: an overlay WebView keeps exactly one reported/occluded IME lift after the visual viewport resize event.
- Positive transition: an adjustResize WebView reclassifies to zero external lift when its layout and visual viewport settle at the keyboard top.
- Negative transition: a keyboard event arriving before the OEM viewport resize must not leave the initial overlay classification frozen for the rest of that IME-open lifecycle.
- Negative geometry: QuickBar measured height excludes external IME lift, and stage bottom remains `quickbar chrome + safe offsets + exactly one IME lift`.
- `android-ime-anchor-truth.test.ts` proves the native anchor starts with soft-input-on-focus disabled, enables it only while an explicit keyboard show intent is active, and disables it again with the anchor so physical taps cannot become a hidden fallback keyboard trigger.
- `terminal-input-normalization.test.ts` proves committed text preserves CJK/emoji/special symbols, converts terminal-oriented full-width ASCII/punctuation to half-width, and turns IME line breaks into text separators instead of `\r`.
- `ImeAnchorInputLogicTest` proves native voice-style CJK/emoji/symbol commits emit one ordered text event and keep explicit Enter on the `performEditorAction` / key path.
- `TerminalQuickBar.test.tsx` proves QuickBar reports its real chrome height while IME lift is applied outside the component.
- Negative path: `TerminalQuickBar` must not subtract `keyboardInsetPx` from measured chrome height, because `TerminalQuickBarShell.bottom` already consumes that lift.

## Module Black-Box Plan

- `TerminalPage.android-ime.test.tsx` proves stage bottom reserve equals measured QuickBar chrome + safe offset + bottom chrome lift + IME lift.
- It also proves Android native `ImeAnchor input` committed text routes CJK/emoji/special symbols to the active session without converting voice-inserted line breaks into terminal Enter.
- It also dispatches the real registered `visualViewport.resize` listener after a keyboard-first race and proves `TerminalPage` re-renders from over-lift to adjustResize geometry without a second keyboard event.
- `TerminalPage.lifecycle-cleanup.test.tsx` proves Keyboard, visualViewport, and virtualKeyboard listeners are registered and removed from their original sources.
- `TerminalPageStageShell.pane-stage.test.tsx` proves stage positioning remains owned by shell layout and does not pass IME geometry into `TerminalView` resize.

## Project Black-Box Impact

- The local gate simulates the Android field symptom where the IME is visible but the stage no longer reserves QuickBar height, producing bottom misalignment.
- The installed-phone gate must also verify explicit remote-window `KB` opens a visible Android soft keyboard from the native `ImeAnchor.show()` path; native focus plus `showSoftInput()` returning true is not sufficient if `keyboardVisible=false` and the screenshot has no keyboard.
- The fix must not change daemon, buffer manager, renderer repaint, or upstream terminal rows/cols.
- If device screenshots still show drift after this gate passes, next evidence should come from client debug snapshot values for `keyboardInset`, `terminalImeLiftPx`, `quickBarHeight`, and `terminalChromeBottomPx`.

## Known Gaps

- This test design does not replace L5 APK / real WebView visual verification.
- Automated device verification must repeat IME open/close transitions and record `KB/LIFT/SH/RESZ`; a single successful toggle is not evidence for this intermittent race.
