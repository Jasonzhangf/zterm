# Terminal Session Group Layout

## Scope

`terminal.session_group_layout` owns the app-layer presentation framework that maps the existing terminal tab/session/pane truth into screen slots.

This feature does not own session identity, transport lifecycle, terminal buffer truth, or renderer content semantics.

## Mainline Model

```text
existing sessions + workspace panes
-> terminal layout profile
-> stage slots
-> render policy
-> TerminalPageStageShell
```

The model keeps content organization separate from final screen rendering:

- `Session` remains the connection/runtime truth.
- `workspace` remains pane/tab membership and active-pane truth.
- `layout profile` chooses the presentation mode.
- `stage slot` describes whether a pane is fully visible, partially visible, or offscreen.
- `render policy` decides whether a slot mounts live terminal content, lightweight preview, or nothing.

## Implementation Phases

### Phase 1: Phone Baseline

Goal: keep the current phone behavior stable before adding multi-container projection.

Rules:

- Do not add a multi-container projection owner yet.
- Keep drawer tab switching, one active session, and existing split behavior unchanged.
- Make the current phone layout path explicit in function map and tests.
- Preserve existing `TerminalPageStageShell` live-render behavior for visible panes.

Required gates:

- `src/lib/terminal-layout-profile.test.ts`
- `src/pages/TerminalPageStageShell.pane-stage.test.tsx`
- `src/hooks/useTerminalWorkspace.test.tsx`

### Phase 2: Layout Modes

Goal: change presentation profiles without changing session/workspace truth.

Planned modes:

- `phone-portrait-current`
- `phone-portrait-vertical-group`
- `tablet-portrait-horizontal-group`
- `tablet-landscape-workspace-group`

Rules:

- Mode resolution belongs in layout/profile helpers.
- Page components must not grow scattered breakpoints.
- `TerminalView` must not own layout mode or group navigation.

### Phase 3: Projection And Virtualization

Goal: add cross-screen session group projection after the phone baseline and layout modes are stable.

Planned owner:

- `src/lib/terminal-session-group-layout.ts` or equivalent pure resolver, added to the registry only when implemented.

Planned slot policy:

- `fully-visible`: mounts live `TerminalView`.
- `partially-visible`: mounts lightweight preview or identity surface by default.
- `offscreen`: mounts no terminal content.

Rules:

- Projection may choose which existing pane/session containers are displayed.
- Projection must not create, merge, close, or reorder session truth.
- Virtualization must not change buffer, transport, or renderer semantics.

## Forbidden Couplings

- Do not put group navigation into `TerminalView`.
- Do not turn `Session` or workspace pane membership into layout-mode-specific types.
- Do not make peek panels live by default.
- Do not use server, daemon, or buffer manager paths to compensate for UI layout behavior.

