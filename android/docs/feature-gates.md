# Feature Gates

`docs/feature-registry.json` is the machine-checkable feature gate matrix. This document explains how to apply it.

## Required Flow

1. Pick the `feature_id` before editing code.
2. Confirm the changed files are inside `allowed_paths` for that feature.
3. If a necessary file is not in `allowed_paths`, update the registry first and add or adjust a truth gate explaining the new owner boundary.
4. Run every `required_gates` entry for the feature.
5. For terminal transport, daemon input, buffer/render, schedule, and file transfer changes, also run the terminal regression stack required by `docs/dev-workflow.md`.

## Gate Meaning

- `owners`: unique modules that own the feature state or behavior.
- `allowed_paths`: files or directories that may change for that feature.
- `forbidden_paths`: paths that must not be used as shortcut or fallback locations.
- `required_gates`: tests or scripts that must pass before the feature can be reported complete.
- `truth_sources`: docs or skills that define the invariant behind the feature.

## No Fallback Rule

Do not use another feature owner to compensate for a broken owner. If a feature cannot be fixed inside its owner surface, update the registry and truth gates first so the ownership change is explicit and testable.

## Current High-Risk Gates

- `terminal.copy_mode`: prove copy mode has an explicit enter/exit lifecycle, Android touch long-press is routed to app copy menu instead of native system selection, and close/copy/failure paths do not leave highlighted controls behind.
- `terminal.keyboard_ime`: prove IME lift and keyboard listeners clean up without double-lift, stale listeners, hidden-input overlap, or stage-height shrink regressions; prove the terminal stage shell still lifts above the soft keyboard whenever a reported keyboard inset is non-zero, even when the quickbar DOM editor currently owns focus; when WebView viewport metrics do not expose IME occlusion (`adjustPan`-style devices), `keyboardInset` remains the only physical truth and `resolveKeyboardLiftPx` must not return zero purely because layout/visual viewport bottoms appear aligned.
- `terminal.daemon_input`: prove stale or detached input is dropped before tmux write, input wire remains string-only, connect/close attach barriers stay ordered, per-transport input lane can bypass slow non-input work without crossing attach barriers and can also bypass older in-flight input work on the same transport (no self-blocking), mirror live cadence falls back to idle without fake activity, and debug metadata exposes receive/drop/write/queue facts without terminal payload.
- `terminal.open_tabs`: prove no daemon audit, transport close, or runtime absence can physically auto-close a client tab.
- `terminal.buffer_render`: prove buffer-sync apply is the only body repaint path and revision reset does not publish empty black frames over existing content.
- `terminal.workspace_panes`: prove pane ownership is explicit, split layout does not resurrect runtime-only tabs, and PaneStage remains the split truth.
- `terminal.interaction_runtime`: prove active tab / pane routing stays isolated and pane attach/switch refuses owner-less targets.
- `terminal.shell_actions`: prove tab manager scope, quick-picker pane routing, and viewport mode updates stay in shell-actions owner.
- `terminal.schedule`: prove jobs do not leave orphan timers or store entries and daemon remains the execution truth.
