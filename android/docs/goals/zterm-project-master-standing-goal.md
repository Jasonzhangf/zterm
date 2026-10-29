# zterm Project Master Standing Goal

Status: active
Owner: Jenny, zterm project master
Updated: 2026-10-29

## Objective

Own and drive the zterm project to verified delivery. Keep every accepted P1
task moving, verify delegated evidence, integrate only validated changes,
publish only authorized artifacts, and close owned resources.

## Active Board Tasks

- `network-connection-diagnosis-20261028`: diagnose and fix Android connection
  reconnect, cache/repair, foreground recovery, and background-keepalive defects.
- `cli-cross-machine-messaging`: deliver durable, push-based cross-machine zterm
  message and file transfer over the existing daemon connection.
- `public-release-blank-machine-audit-20261029`: audit and publish a real
  clean-machine installation path, including Collab/AppSDK dependencies.

## Required Operating Rules

- Keep the project `project-patrol` subscription armed at the 25-minute target.
- Re-arm a consumed goal deadline before ending a scheduling turn while active
  work remains.
- Inspect open P0/P1 work, worker evidence, worktrees, stale resources, and
  task-scope cancellation on every patrol.
- Prefer a consenting peer for a long-horizon scope. Dispatch bounded
  one-shot execution or observation to an independent GCM worker when needed.
- Preserve dirty, active, shared, or unknown resources.
- Report only substantive project progress or verified blockers to the CEO.

## Current Verified Facts

- OTA build 3232 is published on the public Relay and installed on 15T and
  emulator-5554. Build 3231 is installed on emulator-5556.
- Channel identity agrees for 3232: local daemon `127.0.0.1:3333`, Tailscale
  `100.66.1.82:3333` and the public Relay directory all serve versionCode
  1100032320 with sha256 `ccf4f4d1…a4c84`; 15T lastUpdateTime 2026-10-29
  08:42:31 and emulator-5554 lastUpdateTime 2026-10-28 17:42:14.
- Emulator-5554 on 3232 survived three screen-off/on cycles with an unchanged
  app pid and a live `AndroidConnectionService` foreground record; the captured
  logcat slice holds no FATAL/SIGABRT/tombstone line. This is emulator evidence
  only.
- Emulator-5554 on 3232 also survived three airplane-mode enable/disable cycles
  with a live terminal session: pid unchanged, no FATAL/SIGABRT/tombstone, and
  the session resumed streaming new output after each cut.
- 15T on 3232 kept pid 28051 and `AndroidConnectionService isForeground=true`
  after being pushed to background by another app; `/data/tombstones` holds no
  entry newer than 2026-07-30, so 3231's RTC SIGABRT did not recur in this
  window.
- Build 3231 produced repeatable native RTC SIGABRT tombstones: a destroyed
  peer-connection mutex was touched from the signaling thread.
- Build 3232 moves to a process-shared PeerConnectionFactory and appears to
  target the same lifecycle defect. Real-device sleep/background proof is still
  missing: the 15T was in active user use, so no scripted screen-off/LAN/cellular
  transition run was performed. 3232 is not yet accepted as the completed
  Android fix.
- Repair/retry behavior can emit empty-window buffer requests in bursts.
  Global network generation fencing can retire healthy targets.
- GitHub currently exposes old Android releases; a current public install path
  has not yet been proven from a genuinely blank supported machine.

## Acceptance

### Android Connection

- Corrected DAG and gates define one physical connection owner per daemon target.
- A target-scoped network generation retires only affected physical transports.
- Empty or unknown-head repair requests are bounded and settled by authoritative
  local range coverage, not by request revision alone.
- The installed APK survives repeated sleep/background, LAN, cellular, and
  Tailscale transitions without native crashes or healthy-target teardown.
- The final artifact, installed build, and OTA channel identity agree.

### Cross-Machine Messaging

- Two real daemons pass durable message and file transfer, push replay, restart
  persistence, bounded admission, and monotonic acknowledgement tests.
- The public installed CLI entry is used for acceptance, not an unchecked source
  checkout.

### Clean-Machine Public Release

- A genuinely blank supported OS installs dependencies and public artifacts
  using only the published guide.
- Installed CLI, daemon, native dependencies, service lifecycle, and applicable
  upgrade/rollback paths pass.
- Collab/AppSDK installation order, version compatibility, and two-project
  interoperability are coordinated and evidenced.
- The GitHub release, notes, assets, and guide point to the accepted release.

## Authority And Boundaries

- User authorized this public release and routine project delivery actions in
  the existing approved scope.
- Do not use a container, repository checkout, local tarball, or already
  configured development Mac as proof of a blank-machine install.
- Do not modify or reset the current user machine to manufacture a blank state.
- The Android diagnosis task remains read-only until its contract is updated
  with implementation and device-test authorization.
- Do not mix the cross-machine delivery implementation with the Android
  connection repair.

## Evidence

- Board tasks and revisions in Collab are the task truth.
- Run notes and worker artifacts retain the original failure samples and commands.
- Final completion requires source, test, real-entry, installed artifact,
  delivery, and cleanup evidence as applicable.
