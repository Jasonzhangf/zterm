# Terminal Session Group Layout Test Design

## Objective

Lock the staged implementation of `terminal.session_group_layout` before behavior code changes.

## Phase 1: Phone Baseline

Lifecycle path:

```text
sessions + workspace panes
-> current terminal layout profile
-> TerminalPageStageShell slots
-> visible TerminalView instances
```

White-box plan:

- `terminal-layout-profile.test.ts` keeps current single-pane and split profile tokens stable.
- `TerminalPageStageShell.pane-stage.test.tsx` proves visible pane entries are the only mounted live terminal panes.
- `useTerminalWorkspace.test.tsx` proves workspace pane ownership remains explicit and does not resurrect runtime-only sessions.

Module black-box plan:

- Phone single active session still mounts one `TerminalView`.
- Existing visible split panes still mount live `TerminalView` instances.
- Hidden/offscreen sessions are not mounted by stage shell.

Project black-box impact:

- No daemon, buffer, transport, or renderer contract change.
- No APK user-facing behavior change intended in Phase 1.

Known gaps:

- No vertical/horizontal infinite group projection yet.
- No peek preview renderer yet.
- No cross-screen mode selection yet.

## Phase 2: Layout Modes

Lifecycle path:

```text
viewport + split state
-> terminal layout mode
-> stage presentation profile
```

White-box plan:

- Add pure tests for mode selection.
- Prove page code consumes mode output instead of local breakpoints.

Module black-box plan:

- Phone portrait keeps current behavior until explicitly switched to vertical group mode.
- Tablet portrait and tablet landscape modes are modeled but do not change session truth.

Known gaps:

- Actual multi-slot projection remains out of scope until Phase 3.

## Phase 3: Projection And Virtualization

Lifecycle path:

```text
workspace + sessions + layout mode + viewport
-> session group viewport slots
-> render policy
-> live / preview / offscreen mount decisions
```

White-box plan:

- Pure resolver tests for fully visible, partially visible, and offscreen slots.
- Negative tests proving projection cannot create/close/merge session truth.
- Negative tests proving partially visible slots do not mount live terminal by default.

Module black-box plan:

- Phone portrait: vertical before/center/after slots.
- Tablet portrait: horizontal before/center/after slots.
- Tablet landscape: side peek slots plus multi-pane center workspace.

Project black-box impact:

- Live session ids must only include live slots.
- Drawer, split, and infinite group must be different layouts of the same content truth.

Known gaps:

- Real device gesture and animation validation must be added when behavior is implemented.

