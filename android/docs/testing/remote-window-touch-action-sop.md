# Remote Window Touch Action SOP

Feature: `desktop.remote_window_stream`

This is the canonical touch/action gate for the Android remote-window overlay.

## Hard rules

1. Touch and pointer handling emits business action records through the one
   gesture owner; delivery sequence/retry/ACK/health stays in the typed control
   lane and never enters action metadata.
2. Tap emits one remote left click at release at both 1x and zoomed scale.
3. One-finger movement crossing 8 px before hold commits to realtime bounded
   pixel scroll at both 1x and zoomed scale; pointer-up emits no swipe replay.
4. Movement after a 250 ms hold commits to reliable remote drag
   (`down -> move* -> up`) at both 1x and zoomed scale.
5. Unzoomed stationary 500 ms hold emits one right click; release emits no duplicate. Zoomed stationary 500 ms single-finger hold promotes to one reliable left-button drag; zoomed tap/movement remains local-only.
6. Two-finger same-direction motion is realtime remote scroll at 1x and local
   canvas pan while zoomed. Anti-parallel distance change is local pinch zoom.
7. Zoomed pointer-down does not pre-commit local pan. Gesture modes latch once
   selected and do not oscillate inside one pointer sequence.
8. Double tap toggles 1x/2x. The remote window never shrinks below fit and no
   minimap or viewport overlay is introduced.
9. A five-second gesture remains valid. Reliable pointer-up and cancel-release
   are not subject to continuous-input age limits.
10. A touch outside the rendered content rect resolves to no source point; it
    is never clamped to the closest source edge.
11. Continuous move/scroll is coalesced to at most 45 Hz in smooth mode or
    30 Hz in quality mode. Reliable click/down/up/key/barrier records are never
    merged or discarded by continuous queue pressure.
12. Mouse Emulation keeps remote pointer move/down/up/drag and two-finger wheel
    semantics. Local pan requires the explicit hand/pan control.
13. All real input actions stay action-only; no client focus prefix.

## Required gates

- `src/lib/remote-window-touch-action-runtime.test.ts`
- `src/components/terminal/RemoteWindowOverlay.test.tsx`
- `src/pages/TerminalPage.remote-window-overlay.test.tsx`
- `src/lib/remote-window-touch-action-sop.test.ts`
- `src/lib/remote-window-message-runtime.test.ts`
- `src/contexts/session-context-remote-window-runtime.test.ts`
- `src/server/remote-window-input-policy.test.ts`
- `src/server/remote-window-stream-daemon.test.ts`

## Black-box checkpoints

1. Tap at 1x and 2x and confirm exactly one left click per sequence.
2. Move one finger at 1x and 2x and confirm AppKit scroll markers arrive during
   pointer movement, not after pointer-up.
3. Hold then drag for five seconds and confirm one reliable down and one
   reliable release. Repeat with pointer-cancel and confirm no stuck button.
4. Move two fingers together while zoomed and confirm only local canvas pan;
   repeat at 1x and confirm only realtime remote scroll.
5. Pinch in fullscreen and confirm the view enlarges, never shrinks below fit,
   and emits no remote scroll/pointer action.
6. Replay 120 Hz move/scroll and confirm no more than 45 continuous wire
   actions per second, daemon queue depth at most two, and no post-stop tail.
7. Touch letterbox space and confirm no remote edge click/action is emitted.

## Failure signals

- More than the active profile's bounded continuous action rate is observed.
- Pointer-up replays a swipe after realtime one-finger scroll.
- Zoomed one-finger movement enters local pan or stops remote scrolling.
- Zoomed two-finger local pan emits a remote action.
- Five-second drag or pointer-cancel omits the reliable release.
- Letterbox input is clamped to a source edge.
- Any minimap/viewport overlay rendered.
- Fullscreen shrink below fit.
- Any client-side focus prelude before the input action.
