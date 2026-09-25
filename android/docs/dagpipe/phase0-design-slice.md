# DAGpipe Phase 0 Design Slice

Status: static architecture slice. The Operators below are planned bindings.
`android-phase0-design-slice.md` holds the Android Chinese semantic design;
this file records the daemon mirror/control and shared DAGpipe phase-boundary
context.

## Goal And Scope

- Model the daemon mirror-publish and control-dispatch paths before any Rust
  runtime rewrite.
- Keep Phase 0 to graph JSON + CLI validation + design slices.
- Phase 1 registers Android and daemon Operators with the SDK `compile()`
  contract/effect checks and black-box parity before production wiring.

## Identity And Roles

Project identity: `zterm`.

Graphs:

- `daemon.mirror_publish@0.2`
- `daemon.control_dispatch@0.1`
- `android.connection_lifecycle@0.1`
- `android.buffer_management@0.1`
- `android.buffer_render@0.1`
- `android.input_dispatch@0.1`

Roles:

- `daemon.source_adapter.normalize`: canonical readback normalization.
- `daemon.mirror_writer.commit`: authoritative mirror commit.
- `daemon.mirror_store.apply`: mirror truth and revision owner.
- `daemon.mirror_store.diff`: previous vs current, policy-driven ranges.
- `daemon.mirror_store.classify`: append / rewrite / shift / reset / head-only.
- `daemon.buffer_publisher.plan`: no-hole subscriber publish plan.
- `daemon.buffer_publisher.emit`: physical wire frames.
- `daemon.control_gateway/control_center/control_owner`: control only.
- Android client roles keep Relay account, physical connection, session
  channels, per-session buffer, renderer window, and reliable input separated.

Forbidden control:

- Operators do not receive the graph, scheduler, Runtime, or ARC store.
- No Operator or hook may mutate graph structure or retry by creating a cycle.
- Daemon roles do not own client session/active/foreground/viewport state.
- Relay/peer lease does not own terminal body, channel, tmux, active tab, or UI
  truth.

## Events

Mirror-publish events:

- `source.readback_received`
- `mirror.commit_succeeded`
- `mirror.commit_failed`
- `mirror.truth_changed`
- `range.plan_changed`
- `subscriber.flush_completed`

Control events:

- `control.ingress_received`
- `control.authorized`
- `control.routed`
- `control.owner_completed`

Failure/cancellation/retry:

- Capture failure and publish backpressure are explicit typed events/state,
  never swallowed.
- Retry starts a new `attempt_id`; no graph cycle is created.

## State Machines

### Mirror lifecycle

`idle -> ready -> flushing -> ready`; repeated source failure escalates
`ready -> failed`; teardown/unavailable transitions to `destroyed`.

Invalid transitions: `destroyed -> ready`, `failed -> ready` without explicit
recreate/reattach.

### Subscriber publish state

`no-pending -> pending-diff -> flushing -> no-pending`; transport high-water
enters `backpressured`; range count / span / age / transport generation can
promote to `resync-required` and full-window resync.

### Android client state machines

See `android-phase0-design-slice.md` for:

- Relay account login
- one daemon target physical connection
- per-session logical channels
- per-session sparse buffer management
- frame assembly / repair ledger
- renderer window follow/reading
- reliable input queue

## DAG And Data Contracts

### daemon.mirror_publish@0.2

Inputs: `arc.source_readback`, `arc.diff_policy`, `arc.prev_mirror_snapshot`,
`arc.subscriber_facts`.

Nodes: `normalize_capture`, `commit_mirror`, `apply_mirror_truth`,
`compute_changed_ranges`, `classify_update`, `plan_refresh`, `emit_wire_frames`.

Output: `arc.wire_frames` with no-hole body frames.

### daemon.control_dispatch@0.1

Inputs: `arc.control_ingress`, `arc.capability_policy`.

Nodes: `authenticate_ingress`, `route_control`, `dispatch_owner`.

Output: `arc.control_result`; no terminal body truth in control payloads.

### Android graphs

See `android-phase0-design-slice.md` and the graph JSON files for node/ARC
contracts.

## Trigger Conditions

- Diff runs after authoritative mirror commit, not on client read.
- First ready, forced refresh, invalid revision lineage, and explicit resync use
  full-window output.
- Range count, span, pending age, and transport backpressure promote to
  full-window resync.
- Only use DAGpipe `StateMachine` if Phase 1 wiring can prove caller-owned
  state machine consumption; Runtime does not launch graphs from transitions.

## Change Boundary

Phase 0 scope:

- `android/docs/dagpipe/*`
- `android/scripts/validate-dagpipe-graphs.mjs`
- `android/package.json` `test:dagpipe-phase0` script entry

Phase 1 scope added:

- Rust crate `android/native/dagpipe`
- `pipeline_runtime` dependency and SDK compile checks
- black-box parity tests and thin bridge candidates

Out of scope until explicit authorization:

- OTA/APK/release
- production daemon/client restart as proof of Phase 0

Required evidence:

- `dagpipe graph validate` passes for all graph files.
- `dagpipe graph inspect` prints deterministic waves and operator bindings.
- `pnpm --dir android test:dagpipe-phase0` passes.
- Phase 1 must add SDK `compile()` contract/effect checks, Rust tests, black-box
  parity against current TS behavior, then wire only after green.

## Not A Runtime Claim

Static graph validity alone is not runtime closure. The separate cargo/parity
tests and real entry-point evidence prove the executable path.
