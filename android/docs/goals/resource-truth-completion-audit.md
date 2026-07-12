# Global Resource Truth Completion Audit

Date: 2026-07-12

## Status

Not complete.

The global resource-truth refactor has multiple completed and pushed slices, but the full goal cannot be marked complete until the remaining platform/live gates prove the current implementation against the original global scope.

## Current Evidence

Pushed commits proving completed slices:

- `7124e81 fix: preserve transport resume truth`
- `01125bc fix: keep input on transport resource truth`
- `fc8c96e fix: bootstrap buffer body from mirror truth`
- `d32dc1e chore: add resource truth gates`
- `4307137 fix: keep daemon mirror capture-owned`
- `33f7dff fix: keep debug channel summary-only`
- `3e93f96 test: lock CLI resource truth gates`
- `e63391e docs: record CLI resource truth gate`

Current verified gates:

- Resource registry covers 25 resources, 7 required indirect relations, and 7 forbidden direct relations.
- `docs/wiki/mainline-call-map.json` has no current `binding pending` edge.
- Focused CLI/debug resource gate: `pnpm --dir android exec vitest run src/lib/resource-registry-truth.test.ts --reporter dot` passed, 1 file / 8 tests.
- Global feature/resource gates: `pnpm --dir android run test:feature-registry -- --reporter dot` passed, 7 files / 48 tests.
- Android typecheck: `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false` passed.
- Release asset verification: `pnpm --dir android exec node scripts/verify-release-assets.mjs` passed; APK `0.1.3.2069`, daemon archive sha, daemon npm tgz sha, node-pty/wrtc/support script checks all true.
- Mac client gates: `pnpm --dir mac test -- --reporter dot` passed, 22 files / 149 tests; `pnpm --dir mac run type-check` passed.
- Current Android L5 attempt: `adb connect 100.104.163.65:5555` succeeded for `PLZ110` on Android 16, but `pnpm --dir android run test:android:terminal-real-device -- --serial 100.104.163.65:5555 --apk release-dist/zterm-0.1.3.2069.apk` failed before app smoke because secure keyguard/sleeping state kept `NotificationShade` focused.
- Daemon/tmux close-loop: `pnpm --dir android run daemon:mirror:close-loop` passed all 8 cases: `codex-live`, `top-live`, `vim-live`, `initial-sync`, `local-input-echo`, `external-input-echo`, `daemon-restart-recover`, `schedule-fire`.
- MemPalace zterm re-mine/search verified CLI/release/debug resource truth is searchable.

## Requirement Audit

| requirement | current status | evidence | remaining work |
| --- | --- | --- | --- |
| resource registry is top-level global truth | complete | `android/docs/resource-registry.json`; `resource-registry-truth.test.ts` | none known |
| function map references resource ids | complete | `android/docs/function-map.md`; `function-map-resource-truth.test.ts` | none known |
| mainline source/call map bind resource relations | complete | `android/docs/wiki/mainline-source.md`; `android/docs/wiki/mainline-call-map.json`; `mainline-resource-call-map.test.ts`; no binding-pending edges found | none known |
| session switch / explicit resume / reconnect has one transport owner | complete for committed Android owner slice | commits `7124e81`, `01125bc`; focused transport/input tests from those slices; feature gates green | re-run narrower Android owner tests if later dirty worktree changes touch these files |
| first head/body bootstrap uses mirror truth | complete for committed Android owner slice | commit `fc8c96e`; buffer/runtime tests passed in that slice; daemon close-loop current pass covers initial sync and restart recovery | Android L5 app/device evidence still absent |
| daemon backend/mirror/input queue follows resource graph | complete for tmux daemon current host | commit `4307137`; current daemon close-loop 8 cases pass | Windows WezTerm remote/input smoke still blocked |
| mirror content/geometry only from backend capture/readback | complete for tmux daemon current host | `4307137`; daemon close-loop `top-live`/`vim-live`; terminal skill/MEMORY rule | Windows WezTerm live capture path still needs remote smoke |
| CLI/release deterministic artifact path | complete for static gate and current release assets | commit `3e93f96`; `verify-release-assets.mjs` OK | no packaged install/run smoke claimed in this audit |
| debug channel observe-only | complete for static/runtime debug owner gates | commit `33f7dff`; commit `3e93f96`; debug tests and resource gate | none known |
| Mac client resource scope | partial | Mac tests/type-check pass; Mac docs and memory exist | no packaged Mac app smoke in this audit |
| Windows platform/WezTerm resource scope | blocked | `tailscale status` shows `jason-hw-desktop / 100.75.122.121 / windows` offline; `tailscale ping --timeout=10s 100.75.122.121` reports `peer's node key has expired` | bring Windows host online with valid Tailscale node key, then run real WezTerm remote/input smoke |
| Android UI/app/device behavior | blocked | Android owner tests, typecheck, feature gates, daemon close-loop, release asset verify; ADB reached `100.104.163.65:5555` (`PLZ110`, Android 16) | device is secure-locked/sleeping with `NotificationShade` focused; unlock device and rerun terminal real-device smoke |
| skill/MEMORY/note sedimentation | complete for current CLI slice | commit `e63391e`; MemPalace search verified resource truth terms | keep updating for future slices |

## Blocking Conditions

Windows real smoke is currently blocked by external host state:

- target: `jason-hw-desktop`
- Tailscale IP: `100.75.122.121`
- observed state: offline, last seen 7d ago
- current ping result: `peer's node key has expired`

This blocks the requirement that Windows WezTerm backend/resource relations be proven with real remote/input smoke in the current worktree.

Android L5 real-device smoke is also not proven in this audit. Current ADB probe reached `100.104.163.65:5555` (`PLZ110`, Android 16), but `test:android:terminal-real-device` could not foreground the app because the device is secure-locked / sleeping with `NotificationShade` owning focus. Existing evidence verifies release assets and daemon/client logic gates, but does not prove a real installed Android app path.

## Next Required Work

1. Bring Windows `jason-hw-desktop` online with a valid Tailscale node key.
2. Run the Windows WezTerm remote/input smoke against the current `origin/main`.
3. Unlock the online Android device or provide an already-unlocked ADB device, then run `pnpm --dir android run test:android:terminal-real-device -- --serial <serial> --apk release-dist/zterm-0.1.3.2069.apk` and collect session switch/input/bootstrap evidence.
4. Re-run `test:feature-registry`, Android typecheck, Mac tests/type-check, release verify, and daemon close-loop after any follow-up patch.
5. Only after every row above is complete or explicitly out of scope by a new user decision, mark the active goal complete.
