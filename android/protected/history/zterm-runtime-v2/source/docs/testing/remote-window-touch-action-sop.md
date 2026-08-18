# Remote Window Touch Action SOP

Feature: `desktop.remote_window_stream`

This is the canonical touch/action gate for the Android remote-window overlay.

## Hard rules

1. Touch and pointer handling must emit action records, not raw move streams.
2. Tap/click emits one `click` action at release.
3. Unzoomed single-finger drag emits one release-time `gesture/swipe` action.
4. Zoomed fullscreen single-finger drag pans locally and must not emit remote drag.
5. Two-finger vertical movement emits one release-time `gesture/swipe` action from the midpoint path.
6. Pinch zoom is fullscreen-only, may only enlarge above fit, and must not create a minimap.
7. The remote window must never shrink below fullscreen fit.
8. All real input actions must stay action-only; no client focus prefix.
9. Stale queued real input older than 1 second must be dropped.

## Required gates

- `src/lib/remote-window-touch-action-runtime.test.ts`
- `src/components/terminal/RemoteWindowOverlay.test.tsx`
- `src/pages/TerminalPage.remote-window-overlay.test.tsx`
- `src/lib/remote-window-touch-action-sop.test.ts`

## Black-box checkpoints

1. Tap the remote video surface and confirm one click action.
2. Drag on the remote video surface and confirm one swipe action only on release.
3. Pinch in fullscreen and confirm the view enlarges, never shrinks below fit, and no minimap appears.
4. Open same-app child windows in the active video rail. Each non-active child shows a screenshot thumbnail.

## Failure signals

- Raw pointer move stream observed.
- Any minimap/viewport overlay rendered.
- Fullscreen shrink below fit.
- Missing child thumbnails.
- Any client-side focus prelude before the input action.
