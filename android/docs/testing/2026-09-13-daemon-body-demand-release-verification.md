# 2026-09-14 daemon session attach-lease release verification

Candidate: amended `fix/daemon-release-without-body-demand` commit under
`playground/daemon-release-body-false`; exact reviewed SHA is supplied as the
review `commit` argument for this series.

## Frozen semantics under test

- Daemon default is **release all sessions**. A session is held/attached only
  while a valid foreground attach lease is renewed.
- Foreground heartbeat = `body-subscription { subscribed:true }`; it renews
  `sessionAttachHeartbeatAt` (TTL `TERMINAL_SESSION_ATTACH_LEASE_MS` = 90s).
- Background heartbeat = `mux-ping`; it renews physical transport liveness only
  and must never renew the session attach lease or adaptive width lease.
- On lease expiry the daemon closes only the logical mux channel
  (`mux-channel-closed { code:'no_body_demand' }`), releases
  mirror/capture/adaptive width, and preserves the physical target transport.

## Gates run

- L0 static:
  - `npx tsc --noEmit -p android/tsconfig.json` passed.
  - `git diff --check` passed.
  - `pnpm --dir android run test:feature-registry` passed (104 tests).
  - Registry gates `module-registry-truth`, `edge-registry-truth`,
    `module-import-graph-truth` passed (29 tests).
- L1 focused runtime tests:
  - Server lease/transport/bridge/message suite:
    `terminal-daemon-runtime`, `terminal-bridge-runtime`,
    `terminal-message-runtime`, `terminal-session-attach-lease-runtime`,
    `server.transport-lifecycle-truth` — 72 tests passed.
  - Client lifecycle/handoff suite:
    `session-context-lifecycle`, `useOpenTabLifecycleEffects` — 35 tests passed.
  - Client integration suite `SessionContext.ws-refresh` — 139 tests passed.
  - Combined focused rerun: 10 files, 157 tests passed.
- L2 daemon/tmux real protocol loop (candidate daemon PID-scoped restart, new bundle):
  - `node android/scripts/daemon-attach-lease-smoke.mjs 3344 <token> <session> resubscribe`
    - `foreground-hold`: mirror lifecycle `ready`.
    - `background-release`: `mux-channel-closed code=no_body_demand`,
      `physicalOpen=true`.
    - `background-ping-only`: `attached=false`, `subscribers=0`,
      `physicalOpen=true`.
    - `foreground-reattach`: same transport, mirror `attached=true`.
  - `node android/scripts/daemon-attach-lease-smoke.mjs 3344 <token> <session> lease-expiry`
    - Daemon log:
      `session attach lease expired session=zterm-attach-lease-expiry subscriber=<id>`
    - `lease-expiry-release`: `attached=false`, `physicalOpen=true`.

## Explicit gaps

- No packaged APK build/install/device renderer smoke is included in this revision.
  The live proof above is a daemon protocol loop plus client unit/integration tests;
  an on-device background/foreground renderer smoke remains a device-loop gap.
- Pre-existing failures unrelated to this change (reproduced on clean `HEAD`):
  `src/contexts/session-context-infra-runtime.test.ts` (traversal candidate
  ordering) and `src/server/server.mirror-capture-truth.test.ts` (mirror geometry
  write scan). Neither is touched by this change.
