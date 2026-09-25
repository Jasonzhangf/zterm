# DAGpipe Phase 0 Design Slice

Status: static architecture slice only. The Operators below are planned, not
registered in Rust and not executable through `pipeline_runtime` yet.

## Goal And Scope

- Model the daemon mirror-publish and control-dispatch paths before any Rust
  runtime rewrite.
- Keep Phase 0 to graph JSON + CLI validation + this design slice.
- Do not add `Cargo.toml`, do not register Operators, do not call
  `compile()`/`Runtime::run()`, and do not touch daemon runtime code.

## Identity And Roles

Project/execution identities:

- `project_id`: `zterm` (consuming project)
- `graph_id`: `daemon.mirror_publish` or `daemon.control_dispatch`
- `graph_version`: currently `0.2` / `0.1`
- `execution_id` / `attempt_id`: per-run identities supplied by the caller in
  Phase 1; retry uses a new `attempt_id`, not a graph cycle.

Roles:

- Source adapter: normalizes tmux/Herdr/WezTerm readback into a canonical
  snapshot. It does not own revision, client state, or publish state.
- Mirror writer: validates capture and commits one authoritative snapshot to
  the mirror store. It does not orchestrate graph nodes or rewrite topology.
- Mirror store: owns canonical truth, previous snapshot, and revision. It does
  not read renderer follow/reading state.
- Diff/classify: computes changed absolute ranges from previous vs current
  truth and classifies the update. It does not schedule nodes.
- Buffer publisher: turns ranges into no-hole subscriber publish plans and owns
  per-subscriber pending/backpressure. It does not capture tmux or commit
  mirror truth.
- Control gateway/center/owner: owns capability/deadline/idempotency/audit and
  routes control to owners. It does not hold mirror/transport/file bodies.
- Client consumer: receives head/body frames and owns local sparse
  buffer/renderer projection. It cannot request capture/diff on daemon.

Forbidden control:

- Operators do not receive the graph, scheduler, Runtime, or ARC store.
- No Operator or hook may mutate graph structure or retry by creating a cycle.
- Daemon roles do not own client session/active/foreground/viewport state.

## Events

Mirror-publish events:

- `source.readback_received`: producer `daemon.source_adapter`, consumer
  `daemon.mirror_writer`; emitted on successful adapter readback. Payload is
  the adapter snapshot or an explicit failure.
- `mirror.commit_succeeded`: producer `daemon.mirror_writer`, consumer
  `daemon.mirror_store`; emitted after authoritative commit. Carries canonical
  snapshot and revision lineage.
- `mirror.commit_failed`: producer `daemon.mirror_writer`, consumer mirror
  lifecycle; increments consecutive-failure state, may isolate lifecycle to
  `failed` after threshold.
- `mirror.truth_changed`: producer `daemon.mirror_store`, consumer
  `daemon.mirror_store.diff`; emitted only after truth is committed, never on
  request.
- `range.plan_changed`: producer `plan_refresh`, consumer
  `daemon.buffer_publisher.emit`; contains no-hole absolute ranges and optional
  head-only broadcast.
- `subscriber.flush_completed`: producer publisher, consumer publish state
  machine; clears pending or advances pending chunk index.

Control events:

- `control.ingress_received`: gateway receives typed control command.
- `control.authorized`: gateway authenticates and forwards command.
- `control.routed`: control center routes command to unique owner.
- `control.owner_completed`: owner returns typed result/error.

Failure/cancellation/retry:

- Capture failure and publish backpressure are explicit typed events/state,
  never swallowed.
- Retry starts a new `attempt_id`; no graph cycle is created.

## State Machines

### Mirror lifecycle

- `idle`: created but no ready mirror.
- `ready`: valid mirror truth and capture loop active.
- `flushing`: a capture/commit flush is in flight.
- `failed`: repeated source failures isolate the mirror.
- `destroyed`: terminal state; teardown/unavailable.

Transitions:

- `(idle, start/attach) -> ready`
- `(ready, flush_start) -> flushing`
- `(flushing, commit_succeeded) -> ready`
- `(ready/flushing, consecutive_failure_threshold) -> failed`
- `(ready/failed, teardown_or_unavailable) -> destroyed`

Owners/guards: mirror lifecycle owned by daemon mirror runtime; source failure
must be explicit timeout/backend error, not silent fallback.

Invalid transitions: `destroyed -> ready`, `failed -> ready` without explicit
recreate/reattach.

### Subscriber publish state

- `no-pending`: transport ready, no body sync pending.
- `pending-diff`: no-hole changed ranges queued, waiting to flush.
- `flushing`: chunks being sent.
- `backpressured`: transport high-water/low-water hysteresis active.
- `resync-required`: range count/span/age/transport-generation escalates to
  full-window resync.

Transitions:

- `(no-pending, body_changed) -> pending-diff`
- `(pending-diff, flush_slot_ready) -> flushing`
- `(pending-diff/flushing, backpressure) -> backpressured`
- `(backpressured, low_water_drained) -> flushing`
- `(pending-diff/backpressured, bounds_exceeded) -> resync-required`
- `(flushing, all_chunks_sent) -> no-pending`

Owners/guards: `daemon.buffer_publisher` owns this machine per logical
subscriber; bodySubscribed=false is still a physical connection but does not
queue live body frames.

## DAG And Data Contracts

### daemon.mirror_publish@0.2

Inputs:

- `arc.source_readback`: adapter snapshot or error.
- `arc.diff_policy`: rewrite/no-hole/resync policy for diff and plan.
- `arc.prev_mirror_snapshot`: previously committed canonical window.
- `arc.subscriber_facts`: physical subscriber ready/body-subscribed/
  backpressure facts.

Nodes:

- `normalize_capture`
- `commit_mirror`
- `apply_mirror_truth`
- `compute_changed_ranges`
- `classify_update`
- `plan_refresh`
- `emit_wire_frames`

Output:

- `arc.wire_frames`: head- or body-sync wire frames; no-hole guarantee applies
  to body frames.

### daemon.control_dispatch@0.1

Inputs: `arc.control_ingress`, `arc.capability_policy`.

Nodes: `authenticate_ingress`, `route_control`, `dispatch_owner`.

Output: `arc.control_result` with typed result/error; no terminal body truth in
control payloads.

## Node Contracts And Verification

Each node has one explainable responsibility; Phase 1 must register these
operator names/versions and verify with the SDK `compile()`.

- `daemon.source_adapter.normalize@0.1`: input `arc.source_readback`, output
  `arc.canonical_snapshot`; pure/normalization; verification compares source
  readback to canonical absolute window.
- `daemon.mirror_writer.commit@0.1`: input `arc.canonical_snapshot`, output
  `arc.mirror_revision`; commits authoritative snapshot; failure increments
  mirror lifecycle failure.
- `daemon.mirror_store.apply@0.1`: input `arc.mirror_revision`, output
  `arc.mirror_truth`; applies truth and advances revision.
- `daemon.mirror_store.diff@0.1`: inputs `arc.diff_policy`,
  `arc.prev_mirror_snapshot`, `arc.mirror_truth`; output `arc.changed_ranges`;
  policy-driven absolute range diff; no content-overlap anchoring.
- `daemon.mirror_store.classify@0.1`: inputs `arc.diff_policy`,
  `arc.prev_mirror_snapshot`, `arc.mirror_truth`, `arc.changed_ranges`; output
  `arc.update_class`; classifies append/rewrite/window-shift/reset/head-only.
- `daemon.buffer_publisher.plan@0.1`: inputs `arc.diff_policy`,
  `arc.update_class`, `arc.changed_ranges`, `arc.subscriber_facts`; output
  `arc.publish_plan`; enforces no-hole ranges and subscriber bounds.
- `daemon.buffer_publisher.emit@0.1`: input `arc.publish_plan`; output
  `arc.wire_frames`; emits head/body frames and chunk bookkeeping.
- `daemon.control_gateway.authenticate@0.1`
- `daemon.control_center.route@0.1`
- `daemon.control_owner.dispatch@0.1`

Current TS owners to preserve until wiring:

- `src/server/terminal-source-adapter.ts`
- `src/server/terminal-mirror-capture.ts`
- `src/server/terminal-mirror-runtime.ts`
- `src/server/daemon-buffer-publisher-runtime.ts`
- `src/server/canonical-buffer.ts#findChangedIndexedRanges`
- `src/server/daemon-control-gateway-runtime.ts`
- `src/server/daemon-control-center-runtime.ts`

## Trigger Conditions

- Diff runs after authoritative mirror commit, not on client read.
- First ready, forced refresh, invalid revision lineage, and explicit resync use
  full-window output.
- Range count, span, pending age, and transport backpressure promote to
  full-window resync.
- Only use DAGpipe `StateMachine` if Phase 1 wiring can prove caller-owned
  state machine consumption; Runtime does not launch graphs from transitions.

## Change Boundary

In scope, this phase:

- `android/docs/dagpipe/*`
- `android/scripts/validate-dagpipe-graphs.mjs`
- `android/package.json` `test:dagpipe-phase0` script entry

Out of scope until approval:

- `Cargo.toml`, Rust crates, `pipeline_runtime` dependency
- daemon runtime code, client runtime code, wire protocol
- prebuild/CI wiring for `dagpipe` (global CLI dependency is not tooled in CI)
- OTA/APK/release

Required evidence:

- `dagpipe graph validate` passes for both graph files.
- `dagpipe graph inspect` prints deterministic waves and operator bindings.
- `pnpm --dir android test:dagpipe-phase0` passes.
- Future Phase 1 must add SDK `compile()` contract/effect checks, Rust tests,
  black-box parity against current TS behavior, then wire only after green.

## Not A Runtime Claim

These graphs and operators are Phase 0 static contracts. They do not execute.
Do not report graph validity as daemon runtime closure.
