# Remote Window Stream Delivery Contract

Status: active acceptance contract. This file is the delivery-condition source for the remote-window drawer repair. A claim of completion requires every applicable condition below and evidence bound to the final candidate SHA.

## User-visible acceptance

1. **Redesigned drawer UI is preserved**
   - Use the previously completed remote-window drawer layout, not the legacy three-tab/old toolbar composition.
   - Picker/list, half-sheet preview, fullscreen projection, toolbar and list spacing must match the redesigned UI.
   - Verify through an installed Android WebView screenshot and UI dump from the real user entry.

2. **Touch streaming works after target selection**
   - From the real Android entry, select a remote window.
   - The visible drawer grip expands the half-sheet to fullscreen.
   - In fullscreen, one-finger drag emits remote scroll input.
   - Two-finger scroll and pinch follow the active gesture contract.
   - Pointer down/move/up ownership is complete; no control may only display an enabled label while swallowing input.
   - Verify with emulator pointer actions plus logcat/runtime evidence containing remote-window-input events.

3. **Bitrate and quality controls work**
   - Open the real remote-window more/quality controls.
   - Bitrate/quality controls show current state and accept a user change.
   - The change sends a real stream quality update through the quality owner and reports applied/rejected state; local-only cosmetic state is insufficient.
   - Verify with installed-app UI evidence and runtime/log evidence of the quality update.

4. **No regression of existing stream behavior**
   - Preserve target picker catalog and selection.
   - Preserve fullscreen/close/back lifecycle.
   - Preserve screenshot and toolbar actions where applicable.
   - Embedded half-sheet promotion must have one owner: the drawer grip; no duplicate promotion button or video double-tap bypass.

## Delivery gates

- Candidate is based on the latest `origin/main` and developed in an external clean worktree.
- Relevant focused tests, project type-check, and applicable architecture/feature gates pass.
- Canonical Android build produces a versioned APK and OTA manifest. Record versionName, versionCode, APK path and SHA-256.
- Install the candidate on `emulator-5554` (or an online Android device), verify installed package identity, and replay the real user path.
- Store picker/list, redesigned half-sheet, fullscreen grip, touch-input, and quality-control screenshots/UI dumps/logs under `android/evidence/<task>/`.
- Independent architecture review must return PASS for the exact final candidate SHA.
- Merge only through the protected integration flow; after merge verify local and remote `main` point to the merge commit and CI checks pass.
- If any applicable condition or evidence is missing, report `INCOMPLETE` or `UNVERIFIED`; do not substitute unit tests, source inspection, old screenshots, or stale APK evidence.

## Known history and candidate selection rule

The earlier `remote-window-sheet-gesture-fix-1310` candidate (6c0f6e85) proved a narrower drawer/passive/grip contract but did not prove the redesigned quality-control surface. The prior stream-quality worktrees are relevant inputs and must be compared before any new repair:

- `/Volumes/Intel/playground/zterm/stream-quality-implementation-1003` (HEAD 5ce96c3b)
- `/Volumes/Intel/playground/zterm/stream-quality-implementation-r3-1003` (HEAD 87518158)
- related history: `6d5ef79c`, `63790137`, `2fe13aa6`, `267522e1`, `2f21caa8`, `44141511`.

Do not use the old drawer-only candidate as the sole baseline for this contract.
