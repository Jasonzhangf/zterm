# Architecture Boundary Remediation Plan

Date: 2026-07-02
Scope: Android app architecture, terminal/session ownership, daemon truth, UI projection, persistence/error handling

## Decision Table

| Block | Current problem | Action | Reason |
| --- | --- | --- | --- |
| Terminal session lifecycle | `App.tsx` directly closed/created/switched sessions for force relay / auto mode | Separated in second repair slice | Session open/close/restore is a unique owner concern, not page orchestration |
| Daemon mirror truth | daemon stored client `widthMode/adaptiveCols` in session/mirror truth and later over-corrected by forbidding adaptive tmux reflow entirely | Superseded by adaptive width lease owner in sixth repair slice and 2026-07-11 correction | daemon must not own client viewport policy, but the single adaptive lease owner must aggregate active adaptive cols, request tmux width reflow, and release baseline when leases disappear |
| Open-tab persistence | storage read/write failures are normalized into empty/default state | Separated error path in first repair slice | explicit truth failure must not become silent empty truth |
| Session drawer grouping | UI used `default` / `本机` sentinel for missing hostKey | Removed in fourth repair slice | UI component must consume resolved host identity, not invent it |
| Open-tab intent fallback | `fallbackActiveSessionId` / `fallbackSessionIds` were used inside core intent logic | Renamed to explicit policy in first repair slice | fallback semantics in core truth should not be implicit |

## Functional Blocks And Boundaries

### 1. Session Orchestration Block

Owner:
- `src/hooks/useSessionOpenActions.ts`
- `src/hooks/useOpenTabRuntime.ts`
- `src/hooks/useOpenTabRestoreRuntimeSync.ts`

Allowed:
- create/open/close/switch/resume session intent
- explicit restore of persisted open tabs
- explicit tab materialization

Forbidden:
- page component direct session lifecycle control
- hidden reopen inside UI event handlers
- semantic merge of open tabs by anything other than `sessionId`

Boundary rule:
- `App.tsx` may dispatch UI intent only.
- Any code that decides to create, close, switch, or resume a session belongs here.

### 2. Daemon Truth Block

Owner:
- `src/server/terminal-runtime.ts`
- `src/server/terminal-bridge-runtime.ts`
- `src/server/terminal-message-runtime.ts`
- `src/server/terminal-mirror-runtime.ts`
- `src/server/daemon-buffer-publisher-runtime.ts`

Allowed:
- tmux canonical buffer truth
- transport/session facts owned by daemon
- input receive/write queue
- mirror snapshot and live sync
- per-subscriber buffer-sync publication state, backpressure, head fanout, and frame split

Forbidden:
- client viewport policy outside the single adaptive width lease owner
- client foreground/background or active tab truth
- renderer follow/reading/renderBottomIndex truth
- scattered client width policy that mutates tmux session geometry, tmux options, mirror geometry, or tmux session lifecycle outside the single adaptive width lease owner

Boundary rule:
- daemon may read client intent for one request, but must not keep client policy as long-lived mirror/session truth. `adaptive-phone` wire fields may only become physical transport subscriber lease metadata `{ cols, heartbeatAt }`; only `terminal-mirror-runtime.ts` adaptive lease owner may aggregate the narrowest active cols and request tmux `resize-window -x`. It must not self-write mirror geometry/content, write `@zterm_adaptive_width_*`, or let `mirror-fixed`/foreground/background/viewport become daemon truth.
- `daemon.buffer_publisher` owns subscriber publication only. It must not capture source, commit mirror truth, or read client gap/viewport/follow policy.

### 2a. Daemon Control Block

Owner:
- `src/server/daemon-control-gateway-runtime.ts`
- `src/server/daemon-control-center-runtime.ts`
- `src/server/terminal-message-control-runtime.ts` (schedule/tmux owner adapters)

Allowed:
- authenticated typed control ingress
- capability/deadline/idempotency/correlation/unique routing/audit
- schedule and tmux control owner execution

Forbidden:
- mirror/transport/file/remote-window/renderer ownership
- control metadata or debug state inside business request/response payload
- duplicate schedule/tmux routing paths in `terminal-message-runtime.ts`
- business truth or terminal/file/media bodies inside control commands

Boundary rule:
- `daemon.control_gateway` routes legacy wire control intents to `daemon.control_center`; the control center is only a router and policy boundary, never a god object or data owner.

### 2b. Daemon Session Catalog Block

Owner:
- `src/server/daemon-session-catalog-runtime.ts`

Allowed:
- backend session enumeration and backend-qualified `sessionCatalog` rows
- `list-sessions` control dispatch with legacy `sessions` payload
- list-time `session-activity` fact publication through the idle facts owner

Forbidden:
- client active/session, open-tab, foreground, viewport, renderer, or UI truth
- mirror store, transport subscriber, buffer, or renderer ownership
- a second list-sessions/catalog construction implementation in
  `terminal-message-runtime.ts` or `terminal-message-control-runtime.ts`

Boundary rule:
- `daemon.control_gateway` delegates `list-sessions` to
  `daemon.session_catalog`; `daemon.schedule_runtime` consumes only the shared
  `buildSessionsCatalogPayload` boundary for republish. The catalog owner is a
  backend truth projection, not a client session state machine.

### 3. Client Rendering And Buffer Block

Owner:
- `src/contexts/session-context-buffer-runtime.ts`
- `src/lib/session-buffer-store.ts`
- `src/lib/session-render-gate.ts`
- `src/lib/session-render-buffer-store.ts`
- `src/components/TerminalView.tsx`
- `src/components/terminal/VisibleRow.tsx`
- `src/components/terminal/TerminalPreviewRow.tsx`
- `src/components/useMirrorFixedZoomPan.ts`
- `packages/shared/src/terminal/cell-render.ts`
- `packages/shared/src/terminal/theme.ts`
- `src/pages/TerminalPageStageShell.tsx`
- `src/pages/terminal-page-shell-ui.tsx`
- `src/pages/terminal-page-status-helpers.ts`
- `src/pages/useTerminalPageShellActionsRuntime.ts`
- `src/pages/useTerminalPageCopyRuntime.ts`
- `src/pages/terminal-copy-selection.ts`
- `src/pages/terminal-page-render-keys.ts`
- `src/pages/terminal-page-quickbar-adapters.ts`
- `src/pages/terminal-keyboard-lift.ts`
- `src/pages/TerminalPageQuickBarAssembly.tsx`
- `src/pages/TerminalPageCopyMenu.tsx`
- `src/pages/TerminalConnectionStatusStrip.tsx`
- `src/lib/terminal-shell-skin.ts`

Allowed:
- visible range repair
- local sparse buffer merge
- renderer window follow/reading/renderBottomIndex and immutable snapshot
- DOM renderer snapshot-to-DOM projection
- terminal shell stage/status/quickbar/copy/keyboard-lift projection

Forbidden:
- transport pull from renderer directly
- sparse/render truth in terminal shell
- DOM renderer request policy or follow/reading state
- daemon truth mutation
- fallback sync that hides missing buffer truth

Boundary rule:
- only buffer-sync apply may repaint body.
- `client.sparse_buffer` owns absolute-row truth; `client.renderer_window` owns visible-window truth; `client.dom_renderer` owns immutable render snapshot to DOM; `client.terminal_shell` owns shell projection and user intent only.

### 4. UI Projection Block

Owner:
- `src/pages/ConnectionsPage.tsx`
- `src/hooks/useTraversalRelayAccount.ts`
- `src/components/terminal/TerminalSessionDrawer.tsx`
- `src/components/tmux/TmuxSessionPickerSheet.tsx`

Allowed:
- fixed relay account login projection
- relay daemon-device projection
- live Session drawer / picker projection
- presentation ordering
- presentation-only sentinel for legacy data only if explicitly marked

Forbidden:
- inventing identity when upstream projection is missing
- Home Session group management
- saved tab list save/load/import/export
- creating storage truth
- session lifecycle control

Boundary rule:
- component layer consumes resolved identity; projection layer decides how legacy gaps are shown.

### 5. Persistence Truth Block

Owner:
- `src/lib/open-tab-persistence.ts`
- `src/lib/open-tab-intent.ts`
- `src/lib/open-tab-restore.ts`

Allowed:
- normalize and persist explicit tab truth
- restore persisted truth
- compare and derive close/open intent

Forbidden:
- swallowing parse/write failures into empty truth for current tabs
- implicit replacement of bad storage with default state
- fallback naming that hides owner loss

Boundary rule:
- if persistence fails, caller receives explicit error state or explicit failure result, not a fake empty truth.

## Remove / Separate / Keep

### Remove

- Remove daemon long-lived client width state.
- Remove page-layer direct session lifecycle control.
- Remove UI-layer identity invention when projection owner can resolve it.
- Remove drawer-internal `default` / `本机` host sentinel; missing host identity may only be local unscoped UI grouping and must not be sent to callbacks.

### Separate

- Separate open-tab lifecycle from page navigation.
- Separate daemon mirror truth from client viewport policy.
- Separate persistence failure from “no data”.

### Keep

- Keep current-tab explicit truth.
- Keep projection fallback only as a clearly labeled presentation compatibility path for legacy data.
- Intent fallback was renamed into explicit owner policy: `preserveActiveSessionId` and `nextActiveCandidateSessionIds`, with `architecture-boundary-truth` gate preventing old fallback names from returning to `open-tab-intent.ts`.

## How To Prevent Recurrence

1. Add hard boundary gates.
- Scan `src/server/**` for forbidden client-state symbols such as `widthMode`, `viewport`, `foreground`, `active tab`, `follow`, `reading`.
- Scan page and UI layers for direct `createSession/closeSession/switchSession` calls outside the session-open owner hooks.
- Scan core truth modules for `fallback*` names in non-presentation code.
- Scan `TerminalSessionDrawer` for `default` / `本机` host identity fallback.
- Current gate owner: `src/lib/architecture-boundary-truth.test.ts`, wired into `pnpm --dir android run test:feature-registry`.
- Width policy scan is compatibility-aware: `widthMode` may exist in attach/resize wire payload types, but must not become `widthMode` / `adaptiveCols` long-lived state. Current rule: adaptive width lease owner is the only place allowed to run `tmux resize-window -x`; all other daemon/client/UI paths must not mutate tmux width or mirror geometry.

2. Add owner-call maps.
- Each feature must list one owner module, one allowed surface, one forbidden surface, and one test gate set.
- Any new path must be registered before code is added.

3. Add red tests for the failure modes.
- daemon must not keep client policy as long-lived state
- UI must not create identity when projection is missing
- persistence failure must not become empty truth
- tab restore must not auto-reopen by fallback

4. Add explicit error propagation for truth stores.
- persistence read/write failures should return explicit failure results
- caller decides whether to show a recoverable error, but must not silently pretend success

5. Add review checklist before merge.
- Which block owns this?
- Is the change removing, separating, or keeping?
- Did it introduce fallback in core truth?
- Did it add a second owner?
- Did it add a silent failure path?

## Immediate Next Move

1. Update feature registry / function map if a boundary changes.
2. Move lifecycle control out of `App.tsx`. Done for force relay / use auto in second repair slice; owner is `src/hooks/useSessionOpenActions.ts`, guarded by `src/lib/architecture-boundary-truth.test.ts`.
3. Remove daemon client width state. Third repair slice removed `TerminalSession.widthMode`, `SessionMirror.adaptiveCols`, and direct tmux resize ownership from client width policy. Sixth repair slice supersedes the "no daemon resize" part with a narrower rule: only the adaptive width lease owner may resize tmux while adaptive transport subscribers are alive, and it must restore the captured baseline when the final lease is gone.
4. Replace silent persistence defaults with explicit failure handling. Done in first repair slice; `open-tab-persistence` now returns explicit failure/invalid states or `{ ok:false, error }`.
5. Add boundary red tests and a scanner gate. In progress; current gate covers package gate wiring, open-tab fallback names, App/page/UI lifecycle ownership, remediation doc presence, drawer host identity fallback, daemon client width policy ownership, attach correlation ownership, registry/function-map feature id lockstep, registry/feature-gates verification-map coverage, wiki/mainline-call-map machine manifest alignment, and offline generated wiki HTML.

## Repair Log

### 2026-07-02 second slice: session transport-mode rebuild

- Block: Session Orchestration Block.
- Decision: Separate.
- Removed from `App.tsx`: direct force relay / use auto lifecycle sequence `closeSession -> createSession -> switchSession`.
- Owner now: `src/hooks/useSessionOpenActions.ts`.
- Positive tests: `useSessionOpenActions.test.tsx` proves force relay and auto mode rebuild the same `sessionId` in the owner hook.
- Negative tests: missing relay token produces explicit alert and no runtime lifecycle call; `architecture-boundary-truth.test.ts` prevents force relay / use auto lifecycle code from returning to `App.tsx`.

### 2026-07-02 third slice: daemon client width policy removal

- Block: Daemon Truth Block.
- Decision: Remove. Superseded in part by the sixth slice below.
- Removed from daemon truth: `TerminalSession.widthMode`, `SessionMirror.adaptiveCols`, adaptive-width reconcile state, and tmux `resize-window` / `window-size latest` ownership driven by client width policy.
- Kept only as wire compatibility: attach / resize payload may still contain `widthMode`, but daemon treats it as non-persistent request metadata and does not store it as session or mirror truth.
- Positive tests: `terminal-mirror-runtime.test.ts` proves attach payload remains accepted and resize still schedules mirror sync.
- Negative tests: `server.transport-lifecycle-truth.test.ts` scans true owner files so `widthMode/adaptiveCols` state and tmux resize ownership cannot return; detach tests prove subscriber removal does not mutate tmux width policy.

### 2026-07-02 fourth slice: drawer host identity sentinel removal

- Block: UI Projection Block.
- Decision: Remove.
- Removed from `TerminalSessionDrawer`: drawer-internal `default` host key, `本机` host label fallback, and new-session callback propagation of fake host identity.
- Kept only as local UI grouping: unscoped sessions may share a private internal group key for rendering, but that key is not a host identity and is not passed to refresh/create callbacks.
- Owner remains: `TerminalPage` and `server-identity.ts` inject `hostKey/hostLabel`; drawer only consumes the projection.
- Positive tests: `TerminalSessionDrawer.test.tsx` proves real host groups still pass the selected host key into new-session creation.
- Negative tests: `TerminalSessionDrawer.test.tsx` proves missing hostKey calls `onOpenQuickTabPicker(undefined, ...)`, and `architecture-boundary-truth.test.ts` prevents `default` / `本机` host fallback from returning to the drawer.

### 2026-07-02 fifth slice: architecture gate hardening

- Block: Cross-block prevention gate.
- Decision: Separate into static gate.
- Added to `architecture-boundary-truth.test.ts`: package gate wiring check, page/UI direct session lifecycle primitive scan, daemon client width policy owner scan, and daemon attach correlation owner scan.
- Compatibility boundary: wire payload fields such as `TerminalAttachPayload.widthMode` remain allowed, but `TerminalSession.widthMode`, `SessionMirror.adaptiveCols`, tmux resize ownership, daemon-owned `clientSessionId`, and attach token ownership by `openRequestId` are forbidden.
- Positive tests: `test:feature-registry` proves the architecture gate itself is part of the standard registry gate.
- Negative tests: scanner fails if page/UI layers grow direct `createSession/closeSession/switchSession`, drawer host fallback returns, daemon stores client width policy, or attach correlation fields become token owner state.

### 2026-07-09 sixth slice: adaptive width lease owner

- Block: Daemon Truth Block.
- Decision: Superseded by 2026-07-11 correction. Keep physical lease metadata and make this owner the only place that may request tmux width reflow.
- The daemon must not own client viewport policy, foreground/background, active tab, renderer visible range, or a logical client session.
- Owner now: `src/server/terminal-mirror-runtime.ts` adaptive width lease functions.
- Allowed state: `TerminalTransportSubscriber.adaptiveWidthCols` and `adaptiveWidthHeartbeatAt` as physical transport subscriber lease data; `SessionMirror.adaptiveWidthAppliedCols`, `adaptiveWidthBaselineGeometry`, and `adaptiveWidthLeaseTimer` as owner-local aggregate/release metadata.
- Allowed side effect: only `resize-window -x <narrowest cols>` and final `set-window-option -u window-size` inside `applyAdaptiveTmuxWidth()` / `releaseAdaptiveTmuxWidth()`.
- Required behavior: multiple adaptive subscribers aggregate by narrowest cols; switching to `mirror-fixed`, transport detach/close, moving mirrors, invalid cols, or heartbeat expiry recomputes; final lease disappearance restores/releases tmux width ownership.
- Forbidden behavior: storing `widthMode`, `TerminalSession.widthMode`, `SessionMirror.adaptiveCols`, `requestedAdaptiveCols`, `terminalWidthMode`, foreground/background, or active tab as daemon truth; running `resize-window` outside the adaptive lease owner; writing `@zterm_adaptive_width_*`; treating `mirror-fixed` as an adaptive lease; self-writing `mirror.rows/cols` from requested cols.
- Positive tests: `terminal-mirror-runtime.test.ts` covers min-cols aggregation, resize updates, fixed release, holder disappearance re-sort, and heartbeat expiry applying/releasing tmux width.
- Negative tests: `server.transport-lifecycle-truth.test.ts` and `architecture-boundary-truth.test.ts` forbid old logical client naming, old adaptive owner names, client width mode state, scattered `resize-window`/`window-size`, `@zterm_adaptive_width_*`, and mirror geometry self-writes.

### 2026-07-02 sixth slice: registry/function-map lockstep gate

- Block: Cross-block documentation and owner-map prevention gate.
- Decision: Separate into static gate.
- Added to `feature-registry-truth.test.ts`: every machine registry `feature_id` must appear in `docs/function-map.md`, and every function-map feature row must point back to a registry `feature_id`.
- Positive tests: `test:feature-registry` proves all 27 registry features remain reviewable from the human function map.
- Negative tests: scanner fails if a new feature is added only to the JSON registry, or if a function-map row invents an unregistered feature id.

### 2026-07-02 seventh slice: feature-gates coverage lock

- Block: Cross-block verification-map prevention gate.
- Decision: Separate into static gate.
- Added to `feature-registry-truth.test.ts`: every registry `feature_id` must appear in `docs/feature-gates.md`.
- Filled missing `feature-gates.md` entries for quickbar, remote screenshot, transport lifecycle, connections projection, file transfer, daemon runtime/CLI/support/mainline, and session drawer.
- Positive tests: `test:feature-registry` proves each registered feature has a human-readable verification risk statement.
- Negative tests: scanner fails when future registry features are added without updating the verification guide.

### 2026-07-02 eighth slice: wiki mainline-call-map manifest

- Block: Wiki Review Surface / Mainline Call Map.
- Decision: Separate into machine-readable manifest and static gate.
- Added `docs/wiki/mainline-call-map.json` with `android_mainline`, `daemon_mainline`, and `cli_mainline` lifecycles. Node ids match `docs/wiki/mainline-source.md` Mermaid ids.
- Added to `function-wiki-truth.test.ts`: manifest existence, parseability, lifecycle ids, canonical docs, verification gates, node/edge endpoint validity, and owner `feature_id` lookup against the registry.
- Positive tests: `test:feature-registry` proves wiki review surfaces now have a machine-readable call-map companion.
- Negative tests: scanner fails if a lifecycle references a missing node, missing owner feature, missing canonical doc, or missing verification gate.

### 2026-07-02 ninth slice: offline generated wiki HTML

- Block: Wiki Review Surface.
- Decision: Remove external runtime dependency.
- Removed generated wiki HTML dependency on `https://cdn.jsdelivr.net/npm/mermaid...`.
- Updated `scripts/build-function-wiki.mjs` to parse the supported Mermaid flowchart subset and emit deterministic inline SVG plus the original source text.
- Added to `function-wiki-truth.test.ts`: generated HTML must contain local SVG/source and must not contain `<script`, `https://`, or `cdn.jsdelivr.net`.
- Positive tests: `test:feature-registry` proves generated wiki HTML remains present and locally viewable.
- Negative tests: scanner fails if future generated wiki HTML reintroduces CDN/script dependency.
