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
  - Multi-subscriber body release regression:
    `terminal-mirror-runtime` — 57 tests passed, including
    "releases the withdrawn subscriber channel and adaptive width while a peer
    keeps the mirror" (withdrawn subscriber's channel and adaptive lease are
    released, and the remaining peer's width wins).
  - Client lifecycle/handoff suite:
    `session-context-lifecycle`, `useOpenTabLifecycleEffects` — 35 tests passed.
  - Client integration suite `SessionContext.ws-refresh` — 139 tests passed.
  - Combined focused rerun: 10 files, 157 tests passed.
  - Candidate `9db8560a` verification rerun: focused daemon/mirror/tmux suite
    6 files, 101 tests passed; `pnpm --dir android exec tsc -p
    tsconfig.json --noEmit --pretty false` passed; Mac gate 23 files/167 tests
    and type-check passed; `pnpm --dir android run daemon:mirror:close-loop`
    passed all 9 replay/audit cases.
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
    `61d15ffb9cc9c4bbe3cdad1f21ea9539afd7100c7b915e116e0bb5474e8e534b`
    (multi-subscriber release fix) contains the attach-lease code.
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
    (`ok=true`) and `/tmp/zterm-device-attach-smoke-1789399466614/smoke.json`
    (`ok=true`, re-run after the multi-subscriber release fix).

- L5 candidate `100.66.1.82:3344` release/reattach replay (PLZ110,
  `0.1.3.2975`):
  - Foreground attach reached mirror `revision=1` with the
    `CANDIDATE_RELEASE_1789451956` marker applied and rendered.
  - After `KEYCODE_HOME`, the daemon retained one physical mux transport but
    released the logical channel: the old subscriber moved to
    `transport-detached`, `sessions.attached` and
    `mirrors.subscribers` reached `0`, and the tmux session remained alive at
    `120x40`.
  - Returning the same app process to foreground created a new mux channel on
    the candidate daemon (`fb4d43bb-49e0-485a-bd0c-81108de34509`),
    `bodySubscribed=true`, mirror `lifecycle=ready`, and a fresh full
    `buffer-sync` (`revision=1`, rows `0..39`) followed by
    `buffer-apply-done -> render-raf -> render-commit`.
  - The device UI hierarchy contained `CANDIDATE_RELEASE_1789451956` after
    reattach, proving the reattached frame reached the real Android terminal
    surface rather than only daemon-side state.
  - Evidence:
    `android/evidence/daemon-width-release-0914/background-marker.txt`,
    `background-health.json`, `background-runtime.json`,
    `background-tmux.txt`, `background-tmux-capture.txt`, `background.png`,
    and the post-reattach runtime/UI captures under the same directory.

## Explicit gaps

- Pre-existing failures unrelated to this change (reproduced on clean `HEAD`):
  `src/contexts/session-context-infra-runtime.test.ts` (traversal candidate
  ordering) and `src/server/server.mirror-capture-truth.test.ts` (mirror geometry
  write scan). Neither is touched by this change.

## Final candidate re-verification (368bd970)

The earlier L5 section above is bound to `9db8560a` / `0.1.3.2975`. It is kept as
history and does not substitute for this section. Everything below was executed
against the frozen release candidate after the adaptive-width ownership
hardening commits, in worktree
`playground/daemon-release-merge-0914` on branch
`fix/daemon-two-tier-heartbeat-0914`.

- Candidate: `368bd97043d2a891ac092766ddc91f6d292e04cd`, base `a9e6e61c`.
- Candidate daemon: isolated home `/tmp/zterm-daemon-candidate-2980/home`,
  port `3344`, pid `61496`, bundle
  `android/release-dist/zterm-daemon-0.1.3-darwin-arm64/runtime/server.cjs`
  sha256 `519b24f171af4ced6b14a5d40f59d4c869f56287ca7015f26e001615e22da33e`.
- Production daemon (`launchd com.zterm.android.zterm-daemon`, port `3333`) was
  not touched by this verification.

### L1 focused runtime gates

- `pnpm exec vitest run src/contexts/session-context-transport-runtime.test.ts
  src/contexts/session-context-transport-open-runtime.test.ts
  src/contexts/session-context-infra-facade-runtime.test.ts
  src/server/terminal-mirror-runtime.test.ts
  src/server/terminal-message-runtime.test.ts
  src/server/terminal-daemon-runtime.test.ts` -> 6 files, 174 tests passed,
  exit `0` (log `/tmp/zterm-l1-focused-368bd970.log`).
- `pnpm exec vitest run src/contexts/SessionContext.ws-refresh.test.tsx` ->
  1 file, 142 tests passed, exit `0`
  (log `/tmp/zterm-l3-wsrefresh-368bd970.log`).
- `pnpm exec tsc -p tsconfig.json --noEmit --pretty false` -> exit `0`
  (log `/tmp/zterm-typecheck-368bd970.log`).
- `pnpm --dir android run test:android-connection-service:native` ->
  `AndroidConnectionServiceTransportTest` + `assembleDebug`, `BUILD SUCCESSFUL`,
  exit `0` (log `/tmp/zterm-native-gate-368bd970.log`).

### L2 real daemon/tmux protocol loop

Evidence directory: `android/evidence/daemon-release-368bd970/` (gitignored,
contains the raw JSON/PNG/tmux captures referenced here).

- `node android/scripts/daemon-attach-lease-smoke.mjs 3344 wterm-4123456
  zterm-release-368bd970 resubscribe`
  (`l2-attach-lease-resubscribe.jsonl`): `foreground-hold lifecycle=ready
  attached=true`; `background-release closedCode=no_body_demand
  physicalOpen=true`; `background-ping-only attached=false subscribers=0
  physicalOpen=true`; `foreground-reattach physicalOpen=true attached=true`;
  `ok=true`.
- `... lease-expiry` (`l2-attach-lease-expiry.jsonl`): `foreground-hold
  lifecycle=ready`; `lease-expiry-release attached=false physicalOpen=true`;
  `ok=true` — proves the daemon self-releases on TTL expiry with no
  `body-subscription=false` and no client action.
- Adaptive width ownership (`l2-adaptive-reattach.txt`): `baseline=80x24 latest`
  -> adaptive attach `56x24 manual` -> body withdraw `80x24 latest` -> adaptive
  reattach `56x24 manual`. The tmux window returns to policy (`latest`) on
  release and the per-subscriber adaptive geometry is restored on reattach.

### L5 packaged Android device loop

- APK: `android/native/android/app/build/outputs/apk/debug/app-debug.apk`,
  `versionName=0.1.3.2980`, `versionCode=1100029800`, sha256
  `08e5513b78492bae73f5f136f0063cd19dff5c49e7e36eba4f45309df27ccb4a`.
  OTA bundle (`android/update-dist/latest.json`,
  `~/.zterm/updates/latest.json`) verified by
  `node scripts/verify-update-bundle.mjs` (all checks `true`).
- Device: PLZ110 `100.104.163.65:5555`, installed in place with
  `adb install -r`; `firstInstallTime` preserved, package reports
  `versionName=0.1.3.2980`.
- Loop (candidate daemon `3344`, session `release-gate-368bd970`, tmux baseline
  `120x40`):
  - foreground attach: daemon mirror `ready`, `transportSubscribers` has the
    device with `bodySubscribed=true`, UI renders the injected
    `FOREGROUND_RESUME_368BD970_*` marker
    (`tmux-foreground-attach.txt`, `runtime-foreground-attach.json`,
    `foreground-attach.png`).
  - background (`KEYCODE_HOME`): `mirrors=[]`, `transportSubscribers=[]`, tmux
    window restored to `120x40 window-size=latest`
    (`tmux-background-release.txt`, `runtime-background-release.json`).
  - foreground (`am start`): mirror back to `ready` with a fresh revision, device
    subscriber `bodySubscribed=true`, and the same-process WebView renders the
    marker again (`tmux-foreground-resume.txt`,
    `runtime-foreground-resume.json`, `foreground-resume.png`,
    `device-marker-after-resume.txt`).
- `candidate-meta.txt` in the same directory pins candidate SHA, APK
  version/sha256, daemon bundle sha256, device serial, and installed package
  version for this evidence set.
