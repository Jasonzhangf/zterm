# Fix Design: Android Rename UI And QuickBar Editor Entry

- Design ID: `FD-20260811-ANDROID-RENAME-QUICKBAR-01`
- Status: implemented, tested, and live-verified
- Base: `2564c474039e57ad2f5339ce554c78948853d11c`

## Scope

1. Replace every user-facing `window.prompt` rename interaction with one app-owned rename sheet.
2. Restore the two row-local QuickBar entries that open the existing custom shortcut editor.

## Root Cause

- Rename: title/session rename callers directly invoke the Android WebView native prompt projection. The business callbacks are correct; the visual owner is missing.
- QuickBar: commit `13978ca` removed `topShortcutEditorEntry` and `bottomShortcutEditorEntry` rendering while leaving `openShortcutEditor`, editor state/forms, and `shortcut-editor*` action dispatch intact. The only missing part is the visible entry.

## Architecture

- Rename owner: `mainline_source.android` / `client.app_shell`; rename sheet is UI projection only and calls the existing rename callbacks.
- QuickBar owner: `terminal.quickbar`; restore both row-local entries inside `TerminalQuickBar.tsx` only.
- Allowed: terminal UI components and their tests.
- Forbidden: daemon, transport, buffer, renderer, tmux truth, shared connection payloads.

## Minimal Change

- Add one reusable controlled rename sheet under `src/components/terminal/` using existing shell tokens, text input, cancel/confirm actions, focus, keyboard submit, and validation.
- Replace the four current prompt call sites without changing rename payloads or owners.
- Restore `shortcut-editor-top` after row 1 shortcuts and `shortcut-editor-bottom` after row 2 shortcuts. Landscape keeps both in the merged shortcut row. Both call the existing `openShortcutEditor` path; the tool row contains neither entry. Do not add another editor implementation.

## Verification

- Positive: open rename from terminal header, tab manager, tmux picker, and session action; submit changes the same existing owner callback.
- Negative: cancel/blank input does not rename; neither QuickBar editor entry sends terminal input, and neither is projected into the tool row.
- Gates: focused component tests, `TerminalQuickBar.test.tsx`, `TerminalPage.real-quickbar-split.test.tsx`, type-check, feature registry gates, Android build, OTA publication, installed-device UI replay, then codex-review PASS.

## Test Design

- Lifecycle: closed -> open with target/current value -> edit -> submit or cancel -> closed; reopening must reset to the new target value.
- White box: empty trimmed value cannot submit; Enter submits; Escape and backdrop cancel; async callback ownership remains in the caller.
- Module black box: each rename caller opens the shared dialog and receives only the submitted string; no caller invokes `window.prompt`.
- Project black box: both restored row-local QuickBar entries open the existing shortcut editor and do not send a terminal sequence.
- Known gap before L5: jsdom cannot prove Android IME focus or final WebView geometry, so installed-device interaction and screenshots are required.
