# Session Idle/Stopped Detection — Daemon-Side Design

Date: 2026-07-30
Status: `design-rev2` → `pending-implementation`

## Context

Jason wants a daemon-side "stopped/stale tmux session" detector and to surface the list over the existing control channel so the app can notify the user:

1. Daemon classifies a tmux session as "stopped" when its screen has not updated for ~10 seconds.
2. The list is sent (piggy-back) at each target heartbeat tick and at attach/connect time.
3. App shows a notification so the user can tell whether a tmux job finished or hung.

## Architecture Gate

### Hard constraints (must hold)

- Daemon **must not own client notification truth**; it only surfaces idle facts.
- `resource.ui_projection` / `resource.active_session` / `resource.open_tab` must not be daemon truth.
- Idle/stopped facts must stay scope = "server-observed mirror update liveness", not become daemon business policy.
- No `pkill` / `killall` / `kill $(...)` / `xargs kill`.
- `MIRROR_LIVE_SYNC_IDLE_MS` (120ms, used for live-tail cadence gating) must **not** be aliased for notifications; a separate `SESSION_IDLE_STOPPED_THRESHOLD_MS = 10_000` is introduced so tail-sync tuning cannot drift notification semantics.

### Forbidden paths

- `src/components/TerminalView.tsx` — renderer only, cannot own idle facts.
- `src/pages/TerminalPage.tsx` — page shell, cannot own daemon-side activity detection.
- `src/contexts/session-context-tmux-management-runtime.ts` — tmux list/create/kill owner, not idle detection.
- Any client notification owner — daemon only surfaces facts; app owns presentation.

---

## Existing Primitives to Reuse

### `mirror.lastLiveActivityAt`

- Location: `android/src/server/terminal-mirror-runtime.ts` lines 845, 1404
- Updated when canonical buffer sync captures a change (`hasLiveActivity = true`) or when `handleInput` records input activity.
- Initial value: `0` (line 529)
- Mirror state types in `terminal-runtime-types.ts` already track `revision`, `lastFlushStartedAt`, `lastFlushCompletedAt`, `lastLiveActivityAt`, `lastHeadBroadcastAt`.

### Existing control-channel

- `terminal-message-control-runtime.ts` handles `list-sessions` → `sessions` via `handleListSessionsMessageRuntime`.
- `terminal-mux-channel-runtime.ts` carries target-scoped control over the multiplexed socket via `mux-target-message`.
- `terminal-daemon-runtime.ts#startHeartbeatLoop` is per physical transport, not per tmux session.

### Wire contract

**Wire shape: independent message type, no modification to `sessions` payload.**

`packages/shared/src/connection/protocol.ts`:
  - `TerminalMuxTargetServerMessageType` gains `session-activity`
  - `sessions` payload remains `{ sessions: string[] }` — unchanged for backward compatibility

---

## Design Decision

### 1. Wire shape

**Add an independent `session-activity` message type; `sessions` payload stays unchanged.**

```typescript
// Independent message (new)
{ type: 'session-activity'; payload: { activities: SessionActivity[] } }

// SessionActivity interface
interface SessionActivity {
  name: string;              // tmux session name
  lastLiveActivityAt: number; // unix ms, from mirror.lastLiveActivityAt
  stopped: boolean;          // now - lastLiveActivityAt >= SESSION_IDLE_STOPPED_THRESHOLD_MS
}
```

Rationale: independent type means old clients silently ignore it (switch default → no-op); no risk to existing `sessions` consumers. `sessions` payload is never modified.

### 2. Trigger placement

**Piggy-back on the existing mux heartbeat tick** (60s class interval) via `terminal-daemon-runtime.ts#startHeartbeatLoop`.

The heartbeat loop already iterates over all connections and their bound subscribers. We extend it to also walk all mirrors, classify each by `lastLiveActivityAt`, and send `sessions` with activity data to each open physical transport.

Rationale: reusing the heartbeat tick avoids a second timer. A stopped session is reported at most once per heartbeat interval — fine for "job finished" notifications.

### 2.1 Control/data plane envelope invariant

Once a physical terminal transport has completed `mux-hello`, every frame on
that transport must be a `TerminalMuxServerFrame`.

- Target-level control facts such as `sessions` and `session-activity` use
  `mux-target-message`.
- Session-bound terminal business messages use `mux-channel-message`.
- Legacy/pre-mux transports continue to receive the raw bridge message.
- A target control publisher must never write raw `session-activity` to a
  mux-negotiated physical transport.
- If attach-time target control publication fails after channel registration,
  the mux lifecycle owner removes the channel, closes the subscriber, emits
  `mux-channel-closed` with `session_activity_failed`, and does not start attach.

The invariant is owned by `terminal-session-activity-runtime.ts` for this
feature. Heartbeat and attach/list orchestration call that publisher and do not
construct their own wire envelopes.

### 3. Constant

```typescript
const SESSION_IDLE_STOPPED_THRESHOLD_MS = 10_000; // 10 seconds
```

Must not alias `MIRROR_LIVE_SYNC_IDLE_MS = 120` (live-tail cadence).

### 4. Attach-time send

On `mux-channel-open` / `mux-channel-opened`, the daemon sends a `sessions` message with activity data for **all** active mirrors on that target, not just the opening channel. This gives the client a fresh snapshot at connect time.

### 5. App-side (out of scope for daemon slice)

The app receives the enriched `sessions` message, extracts `sessionActivity[]`, and shows notifications for newly-stopped sessions (transitions `stopped: false → true`). Notification truth stays client-owned; daemon only surfaces facts.

---

## Ownership Map

| What | Owner | File |
|---|---|---|
| Idle threshold constant | `daemon.session_idle_detection` | `terminal-mirror-runtime.ts` |
| Idle classification logic | `daemon.session_idle_detection` | `terminal-session-activity-runtime.ts` (new) |
| Heartbeat-time broadcast | `terminal.transport_lifecycle` | `terminal-daemon-runtime.ts` |
| Wire type `SessionActivity` | `terminal.transport_lifecycle` | `packages/shared/src/connection/protocol.ts` |
| `sessions` enrichment | `daemon.session_idle_detection` | `terminal-message-control-runtime.ts` |

---

## Resource Registry Additions

New resource: `resource.session_idle_facts`
- `owner_feature`: `daemon.session_idle_detection`
- `identity`: "Daemon-derived tmux session idle/stopped facts derived from mirror activity timestamps; not client notification truth"
- `allowed_operations`: `derive_from_mirror`, `publish_to_transport`
- `direct_relations`: `resource.mirror_store`
- `forbidden_direct_relations`: `resource.ui_projection`, `resource.active_session`, `resource.open_tab`

New edges:
- `edge.daemon.mirror_store_to_session_idle_facts` — `mirror_store → session_idle_facts` (direct, `daemon.mirror_store → daemon.session_idle_detection`)
- `edge.daemon.session_idle_facts_to_daemon_target_transport` — `session_idle_facts → daemon_target_transport` (via existing `sessions` control message)

---

## Function Map Additions

New row: `daemon.session_idle_detection`

Files:
- `android/src/lib/terminal-session-activity-runtime.ts` (new — idle classification)
- `android/src/server/terminal-daemon-runtime.ts` (heartbeat broadcast extension)
- `android/src/server/terminal-message-control-runtime.ts` (sessions enrichment)
- `packages/shared/src/connection/protocol.ts` (SessionActivity type)

Allowed: attach/connect flow, heartbeat loop, mirror activity timestamps.
Forbidden: renderer, UI projection, open-tab truth, notification display.

---

## Mainline Call Map Nodes/Edges

New daemon_mainline nodes:
- `IdleActivityClassifier` — idle/stopped classification from mirror timestamps
- `IdleSessionBroadcast` — sessions-with-activity broadcast at heartbeat tick

New edges:
- `daemon_mainline:IdleActivityClassifier → IdleSessionBroadcast` (via `mirror.lastLiveActivityAt`)
- `daemon_mainline:HeartbeatLoop → IdleSessionBroadcast`

---

## Negative Cases

1. **No mirror for a tmux session** — sessions that have no mirror (never attached) are not included in `sessionActivity`; they still appear in `sessions` as plain names.
2. **Activity resumes after stopped** — when `lastLiveActivityAt` moves forward, `stopped` becomes `false`. The app handles the transition.
3. **Multiple mirrors same session** — not possible; mirror key is unique per tmux session name.
4. **No subscriber** — idle classification still runs; it is daemon-side liveness only.
5. **Heartbeat fails** — the heartbeat loop already has error handling; idle broadcast failure is silent.

---

## Verification Plan

### L0 — Static gate
- `pnpm --dir android run test:feature-registry -- --reporter dot`
- JSON parse of updated `resource-registry.json`, `edge-registry.json`, `function-map.md`, `mainline-call-map.json`
- TypeScript `tsc --noEmit`

### L1 — Unit tests
- `terminal-session-activity-runtime.test.ts`: idle classification positive/negative, threshold boundary, resume from stopped
- `terminal-session-activity-runtime.test.ts`: raw legacy publication, mux target-envelope publication, and negative no-raw/no-channel publication
- `terminal-message-runtime.test.ts`: list/open target-control replies remain valid mux server frames
- `terminal-daemon-runtime.test.ts`: heartbeat sends a target envelope on mux connections and a raw control message only on legacy connections
- `server.daemon-runtime-truth.test.ts`: heartbeat loop idle broadcast coverage

### L2 — Daemon close-loop
- `pnpm --dir android run daemon:mirror:close-loop`

### L5 — Live daemon smoke (manual)
- Start `vim` in a tmux session, verify `stopped: false`
- Wait 15 seconds without activity, verify `stopped: true` in next heartbeat
- Type something in vim, verify `stopped: false` in subsequent heartbeat
