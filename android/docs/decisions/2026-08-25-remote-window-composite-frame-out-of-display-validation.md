# 2026-08-25 Remote Window Composite Frame Out-of-Display Validation

## Root Cause

F.6 stale target closeout missed composite window frame containment. The catalog records
window frame `{x:2694, y:873, w:1347, h:679}` from a multi-monitor Mac Studio setup
where the primary display is 3840px wide. Composite windows at x=2694+1347=4041 exceed
the display boundary, so ScreenCaptureKit `SCContentFilter(display: display, including: [window])`
throws Code=2: "display not found for frame". The user sees 20s timeout without a typed error
before the `<video>` appears.

`validateStreamTargetForCapture` only checked the focus window crop within its own
bounds; it never validated that any `compositeWindows[].windowBoundsTopLeftPx` fit inside
`target.capture.displayBoundsTopLeftPx`.

## Fix

**TS-level pre-spawn gate** (`remote-window-capture.ts`):
`validateStreamTargetForCapture` now validates that every composite window frame plus
the focus window frame is contained within `target.capture.displayBoundsTopLeftPx` before
`captureSourceFactory` is called. An out-of-display target throws
`RemoteWindowCaptureTargetOutOfDisplayError` with typed windowId/frame/display fields,
propagated through `validateScreenCaptureKitTargetWindows` and the daemon catch block as:

```
code: 'remote_window_target_out_of_display'
failureStage: 'target-validation'
```

**Swift secondary gate** (`remote-window-screen-capture-script.ts`):
`startRemoteWindowValidateProcess` now re-checks frame containment against fresh
`SCShareableContent` for every validated window ID using
`content.displays.first(where: { $0.frame.contains(window.frame) })`. Exit 6
identifies the out-of-display case; TypeScript catches it by stderr text match.

## No Fallback

This fix does not add a screenshot fallback, timeout, or alternate executable path.
Out-of-display targets fail immediately at `target-validation` with a typed error.

## Verification

- `remote-window-capture.test.ts` + `remote-window-stream-daemon.test.ts`: 86/86 PASS
- `pnpm run test:feature-registry`: 13 files / 102 PASS
- `git diff --check`: 0 warnings
- type-check fails on `App.tsx` due to an unrelated worktree symlink
  (`foregroundResamplesNetworkIdentity` from `fix/android-foreground-resume-native-network-owner`);
  this is pre-existing and outside this fix's scope.
