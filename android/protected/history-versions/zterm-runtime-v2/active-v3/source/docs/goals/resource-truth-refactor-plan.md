# Global Resource Truth Refactor Plan

Date: 2026-07-12

## Goal

Make global zterm resource ownership reviewable and enforceable before any further terminal, daemon, platform-client, transport, or backend refactor.

The refactor starts from resource identity and resource relations across daemon, Android, Mac, Windows, terminal backends, transport, render/buffer, CLI/release, and debug surfaces. It then updates function map, mainline source, mainline call map, tests, and gates. Code changes come only after the global resource model has a machine-readable truth and failing tests.

## Acceptance Criteria

- A machine-readable resource registry exists and is the top-level truth for global zterm resources, including daemon, platform clients, terminal backends, transport, buffer/render, CLI/release, and debug side channels.
- `function-map.md` references resource ids instead of describing feature ownership in isolation.
- `docs/wiki/mainline-source.md` and `docs/wiki/mainline-call-map.json` show global resource relations and allowed `via_resources` edges across Android, Mac, Windows, daemon, and CLI lifecycles.
- Tests fail if a new direct relation bypasses the declared resource graph.
- Session switch / input / reconnect has one resource owner for active resource, target key, socket, pending open, and first head/body bootstrap on every platform client.
- Daemon resource ownership is explicit: physical transports, backend sessions, tmux/WezTerm resources, mirror stores, input queues, schedule/file/screenshot resources, runtime home, release artifacts, and debug resources each have a unique owner and forbidden relations.
- No renderer/UI/client layout path owns terminal content layout; tmux/mirror capture remains the layout truth.

## Scope

In scope:

- Global resource registry and resource relation taxonomy.
- Function map resource classification.
- Mainline source and mainline call map resource binding.
- Test design and static gates for resource ownership.
- Minimal code refactor only after docs/tests define the owner and red cases.
- Daemon, Android, Mac, Windows, terminal backend, CLI/release, update, and debug resource surfaces.

Out of scope:

- Renderer layout redesign.
- Client-side terminal content reflow.
- Daemon mirror/backend truth rewrite beyond map/gate alignment.
- Broad cleanup of unrelated dirty files.
- Releasing, building APK, or pushing unless explicitly requested after implementation gates pass.

## Resource Model

Create `android/docs/resource-registry.json` as the first machine-readable global resource truth. It lives under `android/docs/` because current project docs are rooted there, but it covers the whole repo and adjacent runtime surfaces referenced by zterm docs.

Fields:

- `resource_id`
- `resource_type`
- `identity`
- `owner_feature`
- `truth_store`
- `allowed_operations`
- `direct_relations`
- `indirect_relations`
- `via_resources`
- `forbidden_direct_relations`
- `required_gates`
- `canonical_docs`

Initial resource families:

Global / runtime resources:

- `resource.runtime_home`: user runtime home such as `~/.wterm` / `~/.zterm`, owner `daemon.runtime_entry`.
- `resource.daemon_process`: running daemon process and health endpoint, owner `daemon.runtime_entry`.
- `resource.daemon_runtime_artifact`: staged server runtime artifact, owner `daemon.cli_shell` / release owner.
- `resource.release_update_artifact`: APK/update/daemon release artifacts, owner release/update feature.
- `resource.debug_channel`: debug/log/snapshot side-channel, owner corresponding diagnostics feature; must never become business truth.

Platform client resources:

- `resource.open_tab`: persisted explicit open tab truth, owner `terminal.open_tabs`.
- `resource.active_session`: current active runtime session, owner `terminal.transport_lifecycle`.
- `resource.session_transport`: per-session physical WebSocket/socket resource, owner `terminal.transport_lifecycle`.
- `resource.transport_target`: `bridgeHost + bridgePort + authToken` target resource, owner `terminal.transport_lifecycle`.
- `resource.pending_open_intent`: `{sessionId,targetKey,openRequestId}` single-flight open intent, owner `terminal.transport_lifecycle`.
- `resource.platform_terminal_surface`: Android/Mac/Windows terminal page/workbench surface, owner platform UI feature.
- `resource.platform_input_channel`: IME/hardware keyboard/paste/file input channel, owner platform input feature.

Daemon / backend resources:

- `resource.terminal_backend`: selected backend type and backend adapter contract, owner daemon backend selection feature.
- `resource.backend_session`: backend-side terminal session identity, owner selected backend owner.
- `resource.tmux_session`: daemon-side tmux truth, owner `terminal.daemon_input` / tmux backend owner.
- `resource.wezterm_pane`: Windows WezTerm pane truth, owner `daemon.windows_wezterm_backend`.
- `resource.mirror_store`: daemon canonical mirror truth, owner `terminal.buffer_render`.
- `resource.transport_subscriber`: daemon physical transport subscriber, owner `terminal.transport_lifecycle`.
- `resource.daemon_input_queue`: daemon input receive/write queue, owner `terminal.daemon_input`.
- `resource.schedule_job`: daemon schedule job state and execution truth, owner `terminal.schedule`.
- `resource.file_transfer`: daemon file transfer state, owner `daemon.file_transfer`.
- `resource.remote_screenshot`: daemon remote screenshot request/result state, owner `terminal.remote_screenshot`.

Client buffer/render resources:

- `resource.client_sparse_buffer`: client local sparse buffer truth, owner `terminal.buffer_render`.
- `resource.renderer_window`: follow/reading/render bottom and visible demand, owner `terminal.buffer_render`.
- `resource.ui_projection`: drawer/page/session projection, owner `terminal.session_drawer` / UI projection owners.

## Required Resource Relations

Allowed direct relations:

- `runtime_home -> daemon_runtime_artifact`
- `daemon_runtime_artifact -> daemon_process`
- `daemon_process -> terminal_backend`
- `terminal_backend -> backend_session`
- `backend_session -> tmux_session`
- `backend_session -> wezterm_pane`
- `open_tab -> active_session`
- `active_session -> session_transport`
- `session_transport -> transport_target`
- `session_transport -> pending_open_intent`
- `session_transport -> transport_subscriber`
- `transport_subscriber -> mirror_store`
- `mirror_store -> tmux_session`
- `mirror_store -> wezterm_pane`
- `mirror_store -> client_sparse_buffer`
- `client_sparse_buffer -> renderer_window`
- `renderer_window -> ui_projection`
- `platform_input_channel -> session_transport`
- `daemon_input_queue -> backend_session`
- `schedule_job -> backend_session`
- `file_transfer -> backend_session`
- `remote_screenshot -> backend_session`
- `debug_channel -> resource observer only`

Required indirect relations:

- `ui_projection -> session_transport` only via `active_session`.
- `renderer_window -> tmux_session` only via `client_sparse_buffer -> mirror_store`.
- `renderer_window -> wezterm_pane` only via `client_sparse_buffer -> mirror_store`.
- `input -> tmux_session` only via `session_transport -> mirror_store/daemon message owner`.
- `input -> wezterm_pane` only via `session_transport -> mirror_store/daemon message owner`.
- `drawer select -> pending_open_intent` only via `active_session/session_transport resource owner`.
- `platform_terminal_surface -> backend_session` only via `active_session -> session_transport -> transport_subscriber -> mirror_store`.
- `release_update_artifact -> daemon_process` only via install/promote owner; runtime must consume staged deterministic artifact, not scan authoring source.

Forbidden direct relations:

- UI/drawer directly opens multiple transport sockets.
- Renderer directly changes tmux/session geometry or terminal content layout.
- Input runtime creates reconnect/open intents directly.
- Daemon stores client active tab, foreground/background, viewport, renderer state, or logical client session truth.
- Daemon mirror runtime self-writes mirror rows/cols/buffer/cursor from requested geometry instead of backend capture/readback.
- Platform clients directly mutate backend resources or daemon runtime artifacts.
- Runtime loads uncompiled authoring directories as capability truth.
- Debug/metadata/cache/config fields become request/response business payload truth.

## Documentation Changes

1. Add `android/docs/resource-registry.json`.
2. Add `android/docs/resource-map.md` as the human review surface for the registry.
3. Update `android/docs/function-map.md`:
   - add `resource_ids` column or section per feature,
   - bind request/response/error mainlines to resources,
   - mark missing code binding as `binding pending`.
4. Update `android/docs/wiki/mainline-source.md`:
   - add resource flow diagrams for Android, Mac, Windows, daemon, terminal backends, and CLI/release,
   - separate truth resources, projection resources, and debug side channels.
5. Update `android/docs/wiki/mainline-call-map.json`:
   - every edge includes `resource_from`, `resource_to`, `via_resources`, and `relation_status`.
6. Add `android/docs/testing/resource-truth-test-design.md`:
   - red/positive tests before implementation,
   - white-box, module black-box, project black-box, and known gaps.

## Gate Plan

Add or extend gates:

- `resource-registry-truth.test.ts`
  - validates schema,
  - validates unique `resource_id`,
  - validates owners exist in `feature-registry.json`,
  - validates required gates exist,
  - validates no unknown relation ids.
- `function-map-resource-truth.test.ts`
  - every critical feature has resource ids,
  - every function-map resource id exists in registry,
  - no feature-local function map invents undeclared relations.
- `mainline-resource-call-map.test.ts`
  - every mainline edge resource relation exists,
  - direct forbidden edges fail,
  - required `via_resources` are present,
  - call map node ids still match wiki/source surface.
- Boundary scans:
  - renderer/UI must not write tmux/mirror layout truth,
  - input runtime must not create reconnect/open intents,
  - daemon must not store client active/viewport/follow/debug truth as business state,
  - daemon mirror runtime must not self-write mirror content/geometry outside capture owner,
  - platform clients must not bypass transport resources to reach daemon/backend resources,
  - release/runtime must not load uncompiled authoring directories as truth.

## Implementation Sequence

1. Freeze resource taxonomy.
2. Write `resource-registry.json` and `resource-map.md`.
3. Update `function-map.md`, `mainline-source.md`, and `mainline-call-map.json`.
4. Add schema and relation gates.
5. Add test design.
6. Add failing tests for session switch/input/resource flow:
   - drawer select creates one resource intent,
   - input reads current resource socket,
   - pending open is single-flight by `{sessionId,targetKey,openRequestId}`,
   - retryable intermediate failure does not project terminal error,
   - first active resource bootstrap sends head and then body sync.
7. Add failing tests for daemon/global resource flow:
   - daemon backend selection maps to one backend session resource,
   - tmux/WezTerm capture is the only owner of mirror content/geometry,
   - daemon input queue reaches backend only through declared backend session resource,
   - debug/log/snapshot resources cannot become business payload truth,
   - runtime artifact promotion is explicit and deterministic.
8. Refactor code in the unique owner:
   - consolidate resource reads in `session-transport-runtime.ts`,
   - expose resource accessor through SessionContext,
   - make input/active/session switch consume resource truth,
   - bind daemon backend/mirror/input resources to registry owners,
   - keep renderer/layout untouched.
9. Run focused gates, typecheck, feature-registry gate, then live daemon/client/backend evidence where the changed layer requires it.
10. Distill verified lessons to `MEMORY.md` and local skill.

## Risks

- Existing dirty worktree contains unrelated changes. Stage and commit only explicit paths from this plan.
- Resource registry may expose missing owner edges across daemon/platform/backend surfaces. Mark unresolved edges as `binding pending`; do not invent symbols.
- Static gates can be over-broad. Prefer owner-path allowlists and explicit forbidden relation tests.
- Do not fix resource drift by introducing fallback paths; missing resource relation must fail loudly.
- Global scope can grow too large. Keep implementation slices resource-first and gate-first; do not refactor every resource in one code patch.

## Verification Matrix

- L0 docs/gates:
  - resource registry parse/schema test,
  - function-map resource truth test,
  - mainline resource call-map test,
  - feature registry gate.
- L1 owner tests:
  - transport resource store tests,
  - input resource tests,
  - session switch/open intent tests,
  - lifecycle explicit-resume tests.
- L1 daemon/backend owner tests:
  - backend selection resource tests,
  - mirror capture owner tests,
  - daemon input queue tests,
  - runtime artifact/promote tests.
- L2 daemon/tmux:
  - required if daemon/mirror/backend resource relations are changed.
- L2 Windows backend:
  - required when WezTerm resource relations are changed and Windows host is reachable.
- L3 client runtime:
  - Android SessionContext websocket/refresh tests,
  - Mac bridge/local terminal runtime tests,
  - Windows shell tests when Windows client exists.
- L4/L5 UI/device:
  - only after code refactor changes app behavior and a build is requested.

## Definition Of Done

- Resource registry is the top-level truth for daemon, Android, Mac, Windows, terminal backend, transport, buffer/render, CLI/release, and debug resources.
- Function map and mainline call map are resource-bound.
- Forbidden shortcut relations are enforced by tests.
- Code refactor uses the resource owner rather than scattered `activeSessionId`, direct socket, and pending maps.
- Daemon and backend code uses declared resource owners rather than mixing transport, backend session, mirror, input, and debug truth.
- No client-side terminal content layout ownership is introduced.
- Verification output states which layers are closed and which live gates remain.
