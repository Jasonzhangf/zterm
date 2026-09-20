# Resource drawer gesture scopes

The resource drawer owns shell drag gestures only on its explicit handle. Files,
web, remote stream, and toolbar surfaces each bind a typed page and runtime scope
and stop pointer/touch propagation at that boundary. Nested content therefore
cannot close or expand the drawer while its own interaction is active.

The remote window keeps its own gesture runtime. This decision changes only
client pointer routing; it does not alter daemon, tmux, shell, or iTerm state.

## Handle completion across retargeted touchend (2026-09-19)

The drawer gesture runtime owns the handle drag from `touchstart` until that
same touch identifier ends or is cancelled. Android WebView may retarget the
`touchend` of a handle drag to the overlay or shell element instead of the
grip. The active drag context captured at `touchstart` is authoritative, so a
retargeted `touchend` for that identifier still completes the handle action
(`expand` on upward drag, `close` on downward drag). A gesture that started on
files, web, stream, toolbar, or backdrop content must never complete a handle
action. This preserves the half-sheet-to-fullscreen grip without letting nested
content drive the drawer.
