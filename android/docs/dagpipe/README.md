# DAGpipe Phase 0 + Phase 1: Android static and Rust-core DAG governance

Scope: static DAG graphs, CLI validation, and the Android Rust-core parity
gate. Phase 0 covers graph JSON and CLI validation only. Phase 1 registers the
Android operators, compiles the approved graphs through `pipeline_runtime`,
and proves black-box parity before production wiring.

Graphs:

- `daemon-mirror-publish.graph.json` - source adapter -> mirror writer -> mirror
  store -> diff/classify -> buffer publisher plan -> wire frames
- `daemon-control-dispatch.graph.json` - control gateway -> control center ->
  owner dispatch
- `android-buffer-render.graph.json` - wire ingress -> frame assembly -> sparse
  apply / exact repair request -> renderer commit -> DOM projection
- `android-input-dispatch.graph.json` - committed-text normalization ->
  reliable input planning -> ordered physical send
- `android-connection-lifecycle.graph.json` - Relay account login ->
  device presence -> route resolution -> one daemon-target physical transport
  -> mux negotiation -> per-session channel open/subscribe -> maintain ->
  recovery plan
- `android-buffer-management.graph.json` - per-session head observation ->
  window planning -> range request dispatch -> response ingest -> sparse merge
  -> repair ledger -> render scope publication

Phase 2 static graphs:

- `relay-account-peer-route.graph.json`
- `daemon-connection-channel-catalog.graph.json`

Phase 3 static graphs:

- `daemon-input-schedule.graph.json`
- `daemon-file-transfer-browse.graph.json`
- `daemon-file-transfer-upload.graph.json`
- `daemon-file-transfer-download.graph.json`
- `daemon-attachment-delivery.graph.json`
- `terminal-remote-screenshot.graph.json`

Phase 4 static graphs:

- `remote-window-stream-overlay.graph.json`

Phase 5 static graphs:

- `android-session-shell-lifecycle.graph.json`
- `android-session-preview-lattice.graph.json`

Phase 6 static graphs:

- `android-composition-plugin.graph.json`
- `android-control-command.graph.json`
- `android-config-export.graph.json`
- `android-config-import.graph.json`

Phase 7 static graphs:

- `release-runtime-promotion.graph.json`
- `release-update-lifecycle.graph.json`
- `observability-debug.graph.json`

Validation:

```sh
pnpm --dir android test:dagpipe-phase0
```

Phase 1 gate:

```sh
pnpm --dir android test:dagpipe-phase1
```

The CLI validates acyclicity, output reachability, and syntactic operator
version bindings. It is not authoritative for project Operator resolution,
ARC schema compatibility, or effect capability checks; those remain the SDK
`compile()` gate.

Mirror update semantics captured in the DAG:

- tmux buffer growth: source window appends new rows while the authoritative
  start stays stable; changed-range diff only publishes the appended tail.
- tmux buffer rewrite: rows in an already-known absolute window change in
  place; changed-range diff publishes the no-hole contiguous span covering the
  first changed line through the last changed line.
- refresh range: `compute_changed_ranges` compares the previous canonical
  window against the committed mirror truth; `classify_update` turns that into
  append / rewrite / window-shift / reset / head-only; `plan_refresh` collapses
  pending ranges into no-hole contiguous ranges and escalates to full resync
  when range count, span, age, or backpressure thresholds require it.

Diff policy:

- `arc.diff_policy` is an explicit graph input, not hard-coded operator state.
  It configures rewrite handling for TUI apps that update older rows, max
  changed-span policy, and the full-resync thresholds.
- The default target is no-hole updates: a publish frame must cover every row
  from `startIndex` through `endIndex - 1`. Sparse holes are not sent.
- Configurable rules may decide between tail append, contiguous rewrite span,
  window-shift prefix/tail, or full-window resync.

Diff trigger conditions:

- Run only after a successful authoritative mirror commit writes new mirror
  truth.
- Do not run diff on `buffer-head-request` or client read requests.
- First ready mirror, forced attach refresh, invalid revision lineage, and
  explicit resync requests use full-window output.
- Range count / span / pending age / transport backpressure may promote the
  next flush to full-window resync.

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

Android client boundaries frozen by these graphs:

- Relay account login is account-scoped with token-per-login; it never hides
  saved direct/Tailscale entries and never owns terminal body truth.
- One stable daemon target owns one physical transport; terminal sessions are
  logical channels on that transport, not per-session sockets.
- A session channel failure must not close sibling channels on the same target.
- Physical transport heartbeat/reconnect/backoff belongs to the connection
  owner; foreground/background only changes data-refresh cadence.
- Buffer management is per-session: absolute-row truth, revision epoch, gap
  repair, and repair ledger stay isolated between sessions.
- Only `buffer-sync apply` can update local body truth and trigger a body
  render commit.
- `client.renderer_window` is the only visible-range owner; the buffer planner
  consumes declared demand but never derives follow/reading/renderBottomIndex.
- `client.buffer_frame_assembly` must assemble a chunked authoritative frame
  into one continuous no-hole payload before sparse apply.
- A visible gap emits one exact-range `buffer-sync-request`; it does not clear
  existing absolute-row truth.
- `client.input_normalizer` is pure committed-text normalization only.
- `client.reliable_input` owns ordered in-flight/ACK/retry planning and the
  only client terminal-input queue; transport lifecycle remains outside this
  graph.

Phase 1 current status:

- Rust crate `android/native/dagpipe` compiles and runs the Android graphs
  through `pipeline_runtime`.
- Black-box parity tests run through the N-API bridge and a JNI `.so`.
- The client production path still needs a non-raw-input thin bridge before
  Phase 1 is considered runtime-closed.
