# Remote Window Touch Action SOP

Feature: `desktop.remote_window_stream`

This is the canonical touch/action gate for the Android remote-window overlay.
The current contract is the 2026-10-04 superseding appendix in
`docs/decisions/2026-10-02-stream-control-design.md`.

## Hard rules

1. Touch and pointer handling emits business action records through the one
   gesture owner; delivery sequence/retry/ACK/health stays in the typed control
   lane and never enters action metadata.
2. Tap emits one remote left click at release at 1x. A zoomed single-finger
   pointer-down does not invent a remote tap or hold.
3. One-finger movement crossing 8 px before hold commits to realtime bounded
   pixel scroll at 1x. At scale > 1.01 one finger is always a local pan, in
   touch and mouse mode alike; local pan and pinch emit zero wire. Pointer-up
   emits no swipe replay.
4. Movement after a 250 ms hold commits to reliable remote drag
   (`down -> move* -> up`) at 1x.
5. Stationary 500 ms hold at 1x emits one right click; release emits no
   duplicate. A zoomed single-finger hold emits no remote right click.
6. Two-finger same-direction motion is realtime remote scroll at 1x and
   zoomed scale. Anti-parallel distance change is local pinch zoom. Once one
   mode commits inside a pair sequence, the other cannot take over.
7. At scale > 1.01 one finger is a local pan. A second finger that joins keeps
   the already-applied local pan (including Android interleaved dispatch where
   the second finger holds still and only the first keeps moving) and takes
   over from the current projection. Two-finger-to-one derives from the
   remaining pointer: scale > 1.01 continues local pan from the remaining
   pointer's current coordinates; scale <= 1.01 restarts the remote pending
   baseline with tap suppression, and the second pointer's up never injects a
   click or a down.
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
    semantics. The scale > 1.01 single-finger local pan applies to mouse mode
    too; zoomed pan does not require a separate hand/pan control.
13. All real input actions stay action-only; no client focus prefix.
14. mode/Back/shrink/blur/lostcapture/pointercancel/pointerup all settle the
    active gesture before reset or clearing pointer state. A gesture that owns
    a remote down releases it exactly once or hands it to the existing
    input-delivery owner; delegated is not delivered. A failed release keeps
    the remaining resources and surfaces an explicit cleanup error; it builds
    no second pending/ACK, and local mode switching never waits on a remote ACK.
15. Half/fullscreen, fit/fill, orientation, and IME/surface changes only
    reproject the local viewport over the same source dimensions/ratio and
    receiver track. They emit zero automatic start/stop/quality/remote-resize
    and never wait on a remote ACK. An explicit remote resize is a separate
    user operation.

## Required gates

- `src/lib/remote-window-touch-action-runtime.test.ts`
- `src/components/terminal/RemoteWindowOverlay.test.tsx`
- `src/components/terminal/RemoteWindowOverlay.gesture-matrix.test.tsx`
- `src/pages/TerminalPage.remote-window-overlay.test.tsx`
- `src/lib/remote-window-message-runtime.test.ts`
- `src/contexts/session-context-remote-window-runtime.test.ts`
- `src/server/remote-window-input-policy.test.ts`
- `src/server/remote-window-stream-daemon.test.ts`

## Black-box checkpoints

1. Tap at 1x and confirm exactly one left click per sequence; repeat zoomed and
   confirm no remote click/down is invented.
2. Move one finger at 1x and confirm AppKit scroll markers arrive during
   pointer movement, not after pointer-up; repeat at scale > 1.01 and confirm
   the local projection pans with zero remote scroll/down.
3. Hold then drag for five seconds and confirm one reliable down and one
   reliable release. Repeat with pointer-cancel and confirm no stuck button.
4. Move two fingers together (parallel) while zoomed and confirm only realtime
   remote scroll; repeat at 1x and confirm only realtime remote scroll; move
   them anti-parallel and confirm only local pinch with zero remote scroll.
5. Pinch in fullscreen and confirm the view enlarges, never shrinks below fit,
   and emits no remote scroll/pointer action; confirm no automatic remote
   resize/start/stop accompanies half<->fullscreen or fit/fill/orientation/IME
   changes.
6. Replay 120 Hz move/scroll and confirm no more than 45 continuous wire
   actions per second, daemon queue depth at most two, and no post-stop tail.
7. Touch letterbox space and confirm no remote edge click/action is emitted.
8. Second finger joins a local pan and confirm the applied pan is preserved;
   lift one finger at scale > 1.01 and confirm local pan continues from the
   remaining pointer, and at scale <= 1.01 confirm no accidental click/down.

## Failure signals

- More than the active profile's bounded continuous action rate is observed.
- Pointer-up replays a swipe after realtime one-finger scroll.
- Scale > 1.01 single-finger movement emits remote input, or leaves the local
  projection unchanged.
- Two-finger parallel same-direction motion pans the local canvas instead of
  emitting remote scroll.
- Five-second drag or pointer-cancel omits the reliable release.
- Letterbox input is clamped to a source edge.
- Any minimap/viewport overlay rendered.
- Fullscreen shrink below fit.
- Any client-side focus prelude before the input action.
- Any automatic remote resize/start/stop/quality change on mode, fit/fill,
  orientation, IME, or surface change.
