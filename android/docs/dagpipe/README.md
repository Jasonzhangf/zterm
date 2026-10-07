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

Phase 4 stream-control design candidates (2026-10-02):

- `remote-window-start.graph.json`: one start request -> first visible target
  or explicit start/cleanup failure.
- `remote-window-quality.graph.json`: one quality transaction -> real
  applied/rejected/unsupported outcome, independent from video payload.
- `remote-window-input-delivery.graph.json`: one action delivery -> ordered
  target-side result or explicit delivery failure.
- `remote-window-stop.graph.json`: one stop request -> remote/local resource
  result, retaining failures after UI exit.
- `remote-window-close.graph.json` (v0.3): one close intent -> confirm ->
  remote close request -> single settle result.
- `remote-window-binding-experiment.graph.json` (v0.6): one binding experiment
  request -> admission decision.

These four graphs are design candidates only; their named Operators are not
registered in `phase4_core.rs` or wired to runtime. Static topology validation
does not prove SDK compilation, media/input behavior, or coding admission.
See `../decisions/2026-10-02-stream-control-design.md`. The existing
`remote-window-stream-overlay` graph retains its ARC admission/parity consumer
contract; it does not demonstrate a live batch completing independent requests.

Phase 4 local mode / gesture design candidates (2026-10-04):

- `remote-window-local-display.graph.json`: one local mode/display request ->
  local projection result or explicit local failure; no remote geometry,
  profile, start, stop, or ACK wait.
- `remote-window-gesture-sequence.graph.json` (v0.2): one user gesture sequence
  -> one gesture result. After `classify_gesture_sequence`, wave 2 splits into
  two explicit nodes: `apply_local_gesture_effect` (local pan/scale only, never
  injects) and `delegate_remote_gesture_delivery` (delegates the existing
  input-delivery owner/contract; no second ACK). Both feed the single
  `settle_gesture_sequence`, which merges applied/inactive/failed/rejection-
  failed/admission-failed/cleanup-failed into one `arc.gesture_result`.

These two graphs are design candidates for project-owned TypeScript owners
(`remote-window-overlay-runtime.ts`, `useRemoteWindowViewport.ts`,
`remote-window-touch-action-runtime.ts`, `RemoteWindowOverlayController.tsx`).
Their named Operators are **not** registered Rust executors and are not wired
to runtime; `dagpipe graph validate`/`inspect` prove static topology and
syntactic bindings only. Each graph is single-input/single-output SESE and has
no cross back-edge to the video/quality/start/stop graphs; the gesture graph
keeps one external source and one result sink, and the remote branch depends on
the existing `remote-window-input-delivery` graph by delegation, not by a graph
edge or a second runtime. See the superseding
appendix in `../decisions/2026-10-02-stream-control-design.md` and the
2026-10-04 section in
`../decisions/2026-08-30-remote-window-quality-gesture-control-amendment.md`.

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

Phase 8 static graphs:

- `android-connection-service.graph.json`

Phase 9 static graphs:

- `windows-remote-access-client.graph.json`

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
- Daemon bridge defaults to `DEFAULT_MIRROR_NO_HOLE_DIFF_POLICY`: `fullResync=false`,
  `noHole=true`, `maxPendingRanges=64`, `maxPendingSpanLines=4096`,
  `maxPendingAgeMs=15000`. Production `server.ts` passes this policy explicitly to
  `mirrorPublishChangedRanges` for every mirror commit.
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
- `daemon.mirror_publish` range closure covers append, rewrite, window-shift,
  reset, and head-only through the Rust core and TS bridge parity tests.
- Mirror diff runs only after authoritative mirror capture/commit (server
  `mirrorBufferChanged`), not on `buffer-head-request` or client reads.
- The client production path still needs a non-raw-input thin bridge before
  Phase 1 is considered runtime-closed.
- `dagpipe graph validate` passes for both graphs.
- `dagpipe graph inspect` prints waves and operator bindings for both graphs.
- Runtime is wired through the DAGpipe native bridge and live daemon mirror
  routing; this phase does not by itself request OTA/APK publish.

## Native client and daemon bridge wiring

`src/lib/dagpipe-native-client.ts` exposes Capacitor-bound `runDagpipe*`
entrypoints. Production callers are wired as thin admission gates at their
owning entry points; they do not replace the legacy TypeScript runtime.

- `runDagpipeConnection`, `runDagpipeBufferManagement`,
  `runDagpipeBufferRender`, `runDagpipeInputDispatch`,
  `runDagpipePhase8Connection`: `src/lib/android-connection-service-factory.ts`
  socket bind entry. The buffer/render/input calls are documented as startup-
  only admission on that entry; they are not owner wiring for
  `client.buffer_store` / `client.renderer_window` / `client.input_runtime`.
- `runDagpipePhase2Relay`: `src/hooks/useTraversalRelayAccount.ts`.
- `runDagpipePhase3Upload`, `runDagpipePhase3Attachment`,
  `runDagpipePhase3Screenshot`: `src/contexts/session-context-transfer-runtime.ts`.
- `runDagpipePhase4RemoteWindow`: `src/contexts/session-context-interaction-runtime.ts`.
- `runDagpipePhase5ShellLifecycle`: `src/hooks/useOpenTabRestoreRuntimeSync.ts`
  cold restore path.
- `runDagpipePhase5PreviewLattice`: `src/pages/TerminalPage.tsx`.
- `runDagpipePhase6Control`, `runDagpipePhase6Composition`: `src/App.tsx`.
- `runDagpipePhase6ConfigExport`, `runDagpipePhase6ConfigImport`:
  `src/hooks/useConfigExport.ts`.
- `runDagpipePhase7Update`: `src/lib/app-update-runtime.ts`.

Daemon-owned graphs run through `src/server/dagpipe-bridge.ts`; their native
client wrapper entries are N/A on the client side by ownership:

- `runDagpipePhase2DaemonConnection` -> native bridge/plugin test parity only;
  production `daemon.session_catalog` currently uses
  `src/server/daemon-session-catalog-runtime.ts` directly without this native
  gate. This runtime is not wired as a production daemon session catalog owner.
- `runDagpipePhase3InputSchedule` -> `daemon.input_queue`
  (`src/server/daemon-input-queue-runtime.ts`).
- `runDagpipePhase3FileBrowse`, `runDagpipePhase3Download` -> `daemon.file_transfer`
  (`src/server/terminal-file-transfer-list-runtime.ts`).
- `runDagpipePhase7Release`: `scripts/prepare-global-daemon-release.sh`
  release gate after deterministic archive + sha256 verification.
- `runDagpipePhase7Debug`: `src/hooks/useRelayDeviceStream.ts` relay debug
  request gate. The native gate runs only when the client platform is native;
  the legacy bounded HTTP upload path remains read-only metadata export.

## DAGpipe 消融合并口径（2026-09-26）

详见 `2026-09-26-dagpipe-ablation-audit.md`。当前口径：

- `dagpipe.request.extract` / `dagpipe.result.collect` 是 SDK 的 SESE 管道节点，
  不是业务步骤；在 SDK 支持类型化输入声明前不消融。
- `relay-account-peer-route` 与 `android-connection-lifecycle` 的 relay 前缀
  重复。正确消融顺序是先固定 `client.relay_account.login` /
  `client.relay_account.publish_device` 为 relay 前缀唯一 owner，再让
  `android.connection_lifecycle` 消费 `arc.route_plan` / `arc.resume_plan`。
  当前候选完成后已收敛 relay 登录/发布唯一 owner；独立 relay 图仍保留，
  等待 `arc.account_directory` / `arc.validated_lease` / `arc.resume_plan`
  bridge 契约迁出后删除，不能先删图留断链。
- `android.connection_lifecycle` 现在只消费上游 route plan / resume plan；
  route plan 的候选身份契约是 `selected.candidateId`，连接建立不得再从
  endpoint 推导 targetKey。
- `android-connection-service` 不复制 `android.connection_lifecycle` 的物理
  连接/维持/恢复为第二套 truth owner；它只投影服务快照、重放意图与通知 action。
- `daemon-connection-channel-catalog` 与客户端连接图不合并，owner 边界不同。
- file-transfer / attachment / screenshot / remote-window 不是死图，当前作为
  admission gate 保留，等 parity 后再消融对应 TS 重复 owner。
