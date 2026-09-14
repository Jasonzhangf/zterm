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

- L5 packaged Android device smoke (PLZ110, `100.104.163.65:5555`):
  - `pnpm --dir android run build:android` produced
    `android/native/android/app/build/outputs/apk/debug/app-debug.apk`,
    `versionName=0.1.3.2967`, `versionCode=1100029670`,
    `sha256=583e8610c7bf8318157f17bc7e0d158ef8484620222bf861337ef1f5f000759e`;
    the update bundle was
    published to `~/.zterm/updates/latest.json` and verified by
    `scripts/verify-update-bundle.mjs` (all checks `true`).
  - `adb -s 100.104.163.65:5555 install -r <apk>` -> `Success`; installed
    package reports `versionName=0.1.3.2967`.
  - Candidate daemon deployed through `android/scripts/zterm-daemon.sh restart`
    (launchd `com.zterm.android.zterm-daemon`); staged
    `~/.zterm/daemon-runtime/server.cjs` sha256
    `1c1632a07a6f53e21ffcca965d7944e495160b347c81810b850d43d239d83936`
    matches the release-dist bundle and contains the attach-lease code.
  - Device attach -> background -> foreground loop observed against
    `/debug/runtime`:
    - foreground: device subscriber `bodySubscribed=true` (origin
      `http://100.66.1.82:3333`), mirror `lifecycle=ready`;
    - background (`KEYCODE_HOME`): device subscriber disappeared from
      `transportSubscribers`; daemon logged
      `session attach lease expired session=AAA-body-demand-gate`;
    - foreground (`am start`): device subscriber returned with
      `bodySubscribed=true` on the same tmux session.
    - The device physical websocket was torn down by the client (`code=1006`,
      client-initiated), not by daemon attach-lease release; daemon release
      keeps the physical transport open in the daemon-only protocol loop.
  - Evidence: `/tmp/zterm-device-attach-smoke-1789397019358/smoke.json`
    (`ok=true`).

## Explicit gaps

- The L5 device smoke proves the daemon-side attach lease and device
  background/foreground lifecycle. It does not add a new renderer screenshot
  assertion for the reattached frame; renderer body truth is covered by the L1
  client integration suites above.
- Pre-existing failures unrelated to this change (reproduced on clean `HEAD`):
  `src/contexts/session-context-infra-runtime.test.ts` (traversal candidate
  ordering) and `src/server/server.mirror-capture-truth.test.ts` (mirror geometry
  write scan). Neither is touched by this change.
