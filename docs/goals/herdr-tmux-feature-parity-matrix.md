# Herdr and tmux Backend Feature Parity Matrix

Date: 2026-08-28
Baseline: `51ee464801d1762615b9fb1b63d50d7337de18a9`
Worktree: `playground/cordis-v2-herdr-tmux-feature-parity-20260827`
Branch: `codex/cordis-v2-herdr-tmux-feature-parity-20260827`

Scope: enumerate differences between the Herdr source adapter and the tmux
backend as exposed through terminal mux. This task records evidence and adds
probing tests only; it does not change runtime behavior.

Sources:

- `android/src/server/herdr-backend-runtime.ts`
- `android/src/server/terminal-mux-channel-runtime.ts`
- `android/src/server/terminal-channel-mux-runtime.ts`
- `android/src/server/terminal-message-control-runtime.ts`
- `android/src/server/terminal-source-adapter.ts`
- `android/src/server/terminal-control-runtime.ts`
- `packages/shared/src/connection/protocol.ts`

Gates run:
- control probes: `terminal-message-control-runtime.schedule.test.ts` 9/9 PASS
- existing input tests: `terminal-control-runtime.input-queue.test.ts` 10/10 PASS
- existing herdr tests: `herdr-backend-runtime.test.ts` 23/23 PASS

Legend: `ok` = equivalent behavior; `gap` = behavior absent or inconsistent;
`mux-driven` = common mux envelope delegates to the selected backend.

## Matrix

| Feature | tmux | Herdr | Result | Evidence |
| --- | --- | --- | --- | --- |
| Session list | `list-sessions` returns tmux sessions | same catalog includes Herdr sessions | ok | `terminal-message-runtime.ts` list-sessions; `listTerminalSessionCatalog` unions both backends |
| Session create | `tmux-create-session` creates detached tmux session | same message with `terminalBackend: 'herdr'` calls `createDetachedTmuxSession` with backend selector | mux-driven | `terminal-message-control-runtime.ts:332`; control handler passes backend to `createDetachedTmuxSession` |
| Session close/kill | `tmux-kill-session` closes tmux session and mirror | same message with Herdr backend calls `closeDetachedTerminalSession` | ok | `terminal-message-control-runtime.ts` kill branch; Herdr close at `herdr-backend-runtime.ts:611-660` |
| Session rename | supported; `runTmux rename-session` succeeds | advertises `supportsSessionRename: false`; rename call hits `renameTmuxSession` which throws "selected terminal backend does not support session rename" | **gap** | `herdr-backend-runtime.ts:668`; `terminal-control-runtime.ts:418-439`; control handler catches as `tmux_rename_failed` at `terminal-message-control-runtime.ts:390-395` |
| Mux hello/ready | `mux-hello` -> `mux-ready` with capabilities | backend-independent | ok | `terminal-mux-channel-runtime.ts:138-156` |
| Mux channel open | requires hello; duplicate id rejected; `mux-channel-opened` | same | ok | `terminal-mux-channel-runtime.ts:163-244` |
| Mux channel close | releases subscriber and closes session | same | ok | mux runtime close branch |
| Channel text | JSON channel message unwrapped to session connection | same | ok | `mux-channel-message` branch |
| Channel binary | base64 decoded and forwarded as binary | same | ok | `mux-channel-binary` branch |
| Body sync | tmux snapshot -> mirror publisher | Herdr history/live canonical snapshot -> same mirror publisher | ok | `herdr-backend-runtime.ts:580-593`; common `TerminalSourceMirrorSnapshot` contract |
| Input write | tmux stdin write | Herdr adapter `inputText` / `input` | ok | `herdr-backend-runtime.ts:598-603` |
| Resize | tmux geometry owner | Herdr adapter `resize({cols, rows})` | ok | `herdr-backend-runtime.ts:605-611` |
| `list-sessions` target parity | yes | yes | ok | protocol `TERMINAL_MUX_TARGET_CLIENT_MESSAGE_TYPES` |
| `tmux-create-session` target parity | yes | yes via backend selector | mux-driven | control runtime create branch |
| `tmux-rename-session` target parity | yes | **no** — control handler has no early `supportsSessionRename` pre-check | **gap** | `terminal-message-control-runtime.ts:353-361`; no capability consult before calling `renameTmuxSession` |
| `tmux-kill-session` target parity | yes | yes | ok | control runtime kill branch |
| Capability advertisement | channel envelope, target messages, bounded body scheduler, reliable input v1 | identical common advertisement | ok | `buildTerminalMuxCapabilities`; `terminal-mux-channel-runtime.ts:151-154` |
| Protocol error projection | typed mux errors | identical common path | ok | invalid frame/envelope/unknown/duplicate errors |
| Backend operation error projection | typed create/rename/kill errors | **rename projected as generic `tmux_rename_failed`** instead of capability-specific rejection | **gap** | control handler catch at `terminal-message-control-runtime.ts:390-395`; rename helper throws late inside `renameTmuxSession` |
| Terminator | tmux process/session close | Herdr adapter release + server stop + bounded TERM/KILL + map deletion | ok | `herdr-backend-runtime.ts:611-660` |

## Body Sync Detail

Herdr uses a distinct authoritative history/live merge inside its adapter:

- history comes from official `pane read --source recent --lines 1000`;
- live visible rows come from canonical frames;
- overlay is allowed only while at bottom and geometry matches;
- geometry/scroll divergence suppresses overlay instead of publishing a gap;
- the common mirror writer consumes the resulting `TerminalSourceMirrorSnapshot`;
- `capabilityGaps: ['herdr-history-limit-1000']` is published explicitly.

This is implementation-specific but preserves the same downstream body-sync
contract as tmux.

## Confirmed Gaps

### Gap 1: `tmux-rename-session` accepted but not supported

`terminal-message-control-runtime.ts:353` enters the rename case unconditionally
without consulting `supportsSessionRename`. The control handler calls
`renameTmuxSession` which then throws inside the helper at
`terminal-control-runtime.ts:418-439`. The control handler catches this as the
generic `tmux_rename_failed` error code.

**Impact**: A client sending `tmux-rename-session` with `terminalBackend: 'herdr'`
gets a generic error instead of a typed `herdr_rename_unsupported` capability
rejection. The error message is "selected terminal backend does not support
session rename" but the error code is `tmux_rename_failed`.

**Source evidence**:
- `terminal-message-control-runtime.ts:353-361`: rename case does not pre-check capability
- `terminal-control-runtime.ts:421-424`: throws 'selected terminal backend does not support session rename' when `supportsSessionRename === false`
- `terminal-message-control-runtime.ts:390-395`: generic catch projects as `tmux_rename_failed`
- `herdr-backend-runtime.ts:668`: `supportsSessionRename: false`

**Fix direction** (not implemented): add early `supportsSessionRename` pre-check in
the rename case before calling `renameTmuxSession`; project as
`herdr_rename_unsupported` code.

### Gap 2: Schedule operations rejected for Herdr backend

`handleScheduleMessageRuntime` (separate function, not part of
`handleTmuxControlMessageRuntime`) rejects all schedule operations for
`session.backend === 'herdr'` with code `herdr_schedule_unsupported`. This is
intentional per `terminal-message-control-runtime.ts:216-240`.

**Source evidence**:
- `terminal-message-control-runtime.ts:216-240`: explicit `herdr_schedule_unsupported` branch
- Existing test: `terminal-message-control-runtime.schedule.test.ts` line ~120

This is a design choice, not a bug.

## Probe Tests

`android/src/server/terminal-message-control-runtime.schedule.test.ts` locks
both sides of the current rename contract: tmux rename succeeds through the
resolved tmux backend, while explicit Herdr rename reaches the backend helper
and is projected as `tmux_rename_failed`. These are probes, not runtime fixes.

## Registry Ownership

The registries describe different ownership dimensions. Module ownership below
comes from `docs/module-registry.json`; feature coverage comes from
`docs/feature-registry.json`; resource ownership comes from
`docs/resource-registry.json`.

| Source file | Owning module | Feature coverage used by this audit | Primary resource |
| --- | --- | --- | --- |
| `herdr-backend-runtime.ts` | `daemon.terminal_backend` | `daemon.herdr_backend` | `resource.herdr_terminal_session` |
| `terminal-control-runtime.ts` | `daemon.terminal_backend` | `daemon.herdr_backend` | `resource.backend_session` |
| `terminal-message-control-runtime.ts` | `daemon.schedule_runtime` | `daemon.herdr_backend` | consumes `resource.backend_session` |
| `terminal-mux-channel-runtime.ts` | `daemon.transport_subscriber` | `terminal.transport_lifecycle` | `resource.transport_subscriber` |
| `terminal-channel-mux-runtime.ts` | `daemon.channel_mux` | `terminal.transport_lifecycle` | `resource.daemon_channel_mux` |
| `terminal-source-adapter.ts` | `daemon.source_adapter` | `daemon.source_adapter` | no owned resource |

## Conclusion

Only two parity gaps between Herdr and tmux backends in the required scope:

1. **Rename gap**: `tmux-rename-session` with Herdr backend fails late inside the
   rename helper with generic `tmux_rename_failed` code (not a typed capability
   rejection). Control handler has no early `supportsSessionRename` pre-check.

2. **Error projection gap**: Herdr rename failure projects as `tmux_rename_failed`
   instead of a backend-specific code like `herdr_rename_unsupported`.

All other features (list/create/kill, mux channel lifecycle, body sync, input,
resize, common capabilities, common mux errors, termination) are implemented
equivalently for both backends.
