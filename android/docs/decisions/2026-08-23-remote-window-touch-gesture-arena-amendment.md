# 2026-08-23 Remote-Window Touch Gesture Arena ADR Amendment

Date: 2026-08-23
Status: Superseded by `2026-08-30-remote-window-quality-gesture-control-amendment.md`
Supersedes: 2026-08-08 single-finger drag = realtime scroll in Direct Touch

## Resolution

Direct Touch single-finger drag emits one release-time `gesture/swipe` action
with start and end coordinates. It must not stream raw pointer moves, scroll
events, or mouse drag events during the gesture.

Two-finger vertical scroll remains realtime pixel scroll with `moveCursor=false`.
Two-finger pinch remains local zoom. Zoomed one-finger pan remains local-only.
Mouse Emulation keeps pointer down / move / up semantics unchanged.

All gesture recognition lives in one runtime owner
(`remote-window-touch-action-runtime.ts`). React controllers must not implement
a second long-press timer or gesture recognizer.

If a future product decision reintroduces "single-finger drag as content
scroll", it must be named `Content Scroll` in a new ADR amendment and must not
be mixed into the Direct Touch contract.

## Rationale

The 2026-07-19 truth document specified release-time gesture/swipe for
single-finger drag. The 2026-08-08 design changed it to realtime scroll without
amending the original contract. The 2026-08-22 remediation plan identified this
as a P1 conflict requiring resolution before Phase 3 Touch unification.

This amendment restores the original release-time semantic because it matches
standard remote-desktop touch behavior (RustDesk, Microsoft RD iOS): tap sends
one click, drag sends one swipe at finger lift, and two fingers handle scroll
and pinch separately.
