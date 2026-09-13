# 2026-09-13 daemon body-demand release verification

Candidate: amended `fix/daemon-release-without-body-demand` commit under
`playground/daemon-release-body-false`; exact reviewed SHA is supplied as the
review `commit` argument for this series.

## Gates run

- L0 static/build:
  - `pnpm --dir android run build` passed.
  - Type-check, repo layout gate, feature registry, and Android prebuild suite passed inside `build`.
- L1 focused runtime tests:
  - `pnpm exec vitest run src/server/terminal-mirror-runtime.test.ts src/server/terminal-message-runtime.test.ts src/server/terminal-runtime.detached-session.test.ts src/contexts/session-context-transport-runtime.test.ts src/contexts/session-context-transport-orchestration-runtime.test.ts src/lib/android-connection-service-socket.test.ts`
  - 181 tests passed.
- L2 daemon/tmux real loop:
  - `pnpm --dir android run daemon:mirror:close-loop`
  - All 9 replay + strict audit cases passed:
    `codex-live`, `top-live`, `vim-live`, `initial-sync`, `local-input-echo`, `long-input-echo`, `external-input-echo`, `daemon-restart-recover`, `schedule-fire`.
- L5 packaged APK:
  - `pnpm --dir android run build:android` passed.
  - versionName: `0.1.3.2950`
  - versionCode: `1100029500`
  - APK: `android/native/android/app/build/outputs/apk/debug/app-debug.apk`
  - SHA-256: `276cb4d34f41fecf32d073273d243509a09c4542cd41dc904f2f7722da809770`
  - The build also prepared the local daemon update channel under `~/.zterm/updates`; Relay publication was not requested.
  - Installed on AVD `Medium_Phone_API_36.1` with `adb install -r`; install returned `Success`.
  - `dumpsys package com.zterm.android` shows `versionName=0.1.3.2950`,
    `versionCode=1100029500`, `lastUpdateTime=2026-09-14 10:38:57`.
  - `am start -n com.zterm.android/.MainActivity` launched; `mFocusedApp` shows
    `com.zterm.android/.MainActivity`, process `pidof com.zterm.android` is alive,
    and logcat showed no `FATAL`/`AndroidRuntime` crash.

## Explicit gaps

- The emulator install/launch verifies packaged APK installation and app entry, but does
  not yet automate a full end-to-end daemon/tmux body unsubscribe/resubscribe renderer
  smoke on the device. That remains a manual/future device loop gap.
