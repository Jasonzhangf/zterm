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
- Phone stage profiles keep `outerMargin`, `containerRadius`, and active pane `paneRadius` at `0`, so the terminal container reaches the physical left and right edges without a decorative gutter or rounded-corner reveal; safe-area ownership remains limited to top/bottom chrome.
- `TerminalPageStageShell.pane-stage.test.tsx` proves visible pane entries are the only mounted live terminal panes.
- `TerminalSessionDrawer.test.tsx` proves explicit top / center / bottom slot labels, long-press slot assignment, click suppression after menu open, and cancellation without mutating workspace assignment.
- `useTerminalWorkspace.test.tsx` proves workspace pane ownership remains explicit and does not resurrect runtime-only sessions.

Module black-box plan:

- Phone single active session still mounts one `TerminalView`.
- Phone single and split stages expose no left/right outer margin while desktop profiles retain their own explicit stage tokens.
- Existing visible split panes still mount live `TerminalView` instances.
- Hidden/offscreen sessions are not mounted by stage shell.
- Session-group peeks scroll into center with animation, but only the center slot remains live.

Project black-box impact:

- No daemon, buffer, transport, or renderer contract change.
- No APK user-facing behavior change intended in Phase 1.

Known gaps:

- No vertical/horizontal infinite group projection yet.
- No cross-screen mode selection yet.
- Unassigned slot placeholder styling may still need device-level polish.

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
- Prove phone portrait vertical group uses one live center terminal and explicit top/bottom slots.

Module black-box plan:

- Phone portrait keeps current behavior until explicitly switched to vertical group mode.
- Phone portrait vertical group click on a peek activates the explicit slot session without mounting that session live.
- Tablet portrait and tablet landscape modes are modeled but do not change session truth.

Known gaps:

- Tablet projection remains out of scope until Phase 3.

## Phase 3: Projection And Virtualization

Lifecycle path:

```text
workspace + sessions + layout mode + viewport
-> active session to session-group slot synchronization
-> session group viewport slots
-> render policy
-> live / preview / offscreen mount decisions
```

White-box plan:

- Pure resolver tests for fully visible, partially visible, and offscreen slots.
- `TerminalPage` active-session projection sync keeps top/center/bottom slot focus aligned with the externally active session id before `TerminalPageStageShell` receives slot props.
- Negative tests proving projection cannot create/close/merge session truth.
- Negative tests proving partially visible slots do not mount live terminal by default.
- Negative tests proving unassigned slots stay placeholders instead of auto-filling from session list order.

Module black-box plan:

- Phone portrait: vertical top/center/bottom slots.
- External active session changes in portrait must replace or focus the corresponding session-group slot and render the new session body marker through real `sessionBufferStore -> TerminalPageStageShell -> TerminalView`; the old session body marker must disappear without requiring a second tap.
- Tablet portrait: horizontal left/center/right slots.
- Tablet landscape: side peek slots plus multi-pane center workspace.

Project black-box impact:

- Live session ids must only include live slots.
- Drawer, split, and infinite group must be different layouts of the same content truth.

Known gaps:

- Real device gesture and animation validation must be added when behavior is implemented.
