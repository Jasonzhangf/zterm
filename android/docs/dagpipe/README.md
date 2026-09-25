# DAGpipe Phase 0: static daemon DAG governance

Scope: static DAG graphs and CLI validation for the daemon-side rewrite target.
Phase 0 defined the static daemon DAG contracts without executable code.
Phase 1 adds a Rust crate at `android/native/dagpipe`, registers every Phase 0
daemon operator, compiles both daemon graphs through `pipeline_runtime`, and
loads the same operators from the daemon through a thin N-API bridge. It does
not publish an OTA update by itself.

Graphs:

- `daemon-mirror-publish.graph.json` - source adapter -> mirror writer -> mirror
  store -> diff/classify -> buffer publisher plan -> wire frames
- `daemon-control-dispatch.graph.json` - control gateway -> control center ->
  owner dispatch

Validation (requires the locally installed `dagpipe` CLI):

```sh
pnpm --dir android run test:dagpipe-phase0
```

Phase 1 gates (requires the installed `dagpipe` SDK path and a local Rust
toolchain):

```sh
pnpm --dir android run test:dagpipe-phase1
```

The Rust crate resolves `pipeline_runtime` through a repo-local
`vendor/pipeline_runtime` symlink created by `scripts/build-dagpipe-native.sh`.
Set `DAGPIPE_SDK_PATH` to override the default SDK location
(`$HOME/.local/share/dagpipe/sdk`); the build script fails explicitly when the
SDK directory is missing.

Design slice:

- See `phase0-design-slice.md` for identities, roles, events, state machines,
  node contracts, and change boundary required by the
  `dagpipe-runtime` skill.

```sh
pnpm --dir android test:dagpipe-phase0
```

The CLI validates acyclicity, output reachability, and syntactic operator
version bindings. It is not authoritative for project Operator resolution,
ARC schema compatibility, or effect capability checks; those remain the SDK
`compile()` gate and are intentionally deferred to Phase 1.

Mirror update semantics captured in the DAG:

- tmux buffer growth: source window appends new rows while the authoritative
  start stays stable; changed-range diff only publishes the appended tail.
- tmux buffer rewrite: rows in an already-known absolute window change in
  place; changed-range diff publishes the no-hole contiguous span covering the
  first changed line through the last changed line.
- refresh range: `compute_changed_ranges` compares the previous canonical
  window against the committed mirror truth; `classify_update` turns that into
  append / rewrite / window-shift / reset / head-only; `plan_refresh` collapses
  changed ranges into no-hole contiguous spans and applies subscriber pending
  bounds supplied in `arc.subscriber_facts`. Per-subscriber range count, span,
  age, and backpressure resync remain owned by `daemon.buffer_publisher`.

Diff policy:

- `arc.diff_policy` is an explicit graph input, not hard-coded operator state.
  The DAGpipe bridge parity tests use the same pending range/span/age limits
  that `daemon.buffer_publisher` enforces for subscribers.
- The default target is no-hole updates: a publish frame must cover every row
  from `startIndex` through `endIndex - 1`. Sparse holes are not sent.
- Incoming changed ranges are diff truth only: `daemon.mirror_store.diff`
  returns them unchanged, and the bridge must return exactly the ranges
  computed by `src/server/canonical-buffer.ts#findChangedIndexedRanges`.
  Subscriber pending bounds stay in `daemon.buffer_publisher`.
- The live daemon mirror range decision is routed through
  `mirrorPublishChangedRanges`/`runMirrorPublish`; the old TS
  `findChangedIndexedRanges` remains only as the parity/test source contract
  for the bridge.
- Configurable rules may decide between tail append, contiguous rewrite span,
  window-shift prefix/tail, or full-window resync.

Diff trigger conditions:

- Run only after a successful authoritative mirror commit writes new mirror
  truth.
- Do not run diff on `buffer-head-request` or client read requests.
- First ready mirror, forced attach refresh, invalid revision lineage, and
  explicit resync requests use full-window output.
- Subscriber pending range count / span / pending age / transport backpressure
  may promote the next flush to full-window resync.

State machines:

- Mirror lifecycle: `idle -> ready -> flushing -> ready`; repeated source
  failure escalates `ready -> failed`; teardown / unavailable transitions to
  `destroyed`.
- Subscriber publish: `no-pending -> pending-diff -> flushing -> no-pending`;
  transport high-water enters `backpressured`; range count / span / age /
  transport generation can promote to `resync-required` and full-window
  resync.

Roles:

- `daemon.source_adapter.normalize`: source readback -> canonical snapshot.
- `daemon.mirror_writer.commit`: validated commit to mirror store.
- `daemon.mirror_store.apply`: canonical truth + revision owner.
- `daemon.mirror_store.diff`: previous vs current, policy-driven range compute.
- `daemon.mirror_store.classify`: append / rewrite / shift / reset / head-only.
- `daemon.buffer_publisher.plan`: no-hole range plan + per-subscriber bounds.
- `daemon.buffer_publisher.emit`: physical wire frames.
- `daemon.control_gateway/control_center/control_owner`: control only, no body
  truth.

Acceptance for this phase:

- `dagpipe graph validate` passes for both graphs.
- `dagpipe graph inspect` prints waves and operator bindings for both graphs.
- Runtime is wired through the DAGpipe native bridge and live daemon mirror
  routing; this phase does not by itself request OTA/APK publish.
