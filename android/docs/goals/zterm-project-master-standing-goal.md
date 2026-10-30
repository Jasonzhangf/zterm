# zterm Project Master Standing Goal

Status: active
Owner: Jenny, zterm project master
Updated: 2026-10-30

## Objective

Own and drive the zterm project to verified delivery. Keep every accepted P1
task moving, verify delegated evidence, integrate only validated changes,
publish only authorized artifacts, and close owned resources.

## Active Board Tasks

All project board tasks are closed and merged to `main`:

- `session-drawer-collab-roles-1028` (P0): merged `d0b0bf1e` (PR #178).
- `session-drawer-ux-1028` (P1): master filter delegates to the Collab
  projection, only real tmux sessions are listed, hide/restore is in-list (no
  Settings textarea), and the visual hierarchy was reworked. Merged `e156ca7a`
  (PR #182); L5 evidence `android/evidence/2026-10-29-drawer-ux-l5-3234`.
- `network-connection-diagnosis-20261028` (P1): merged `0a20d4d5`, `053578e4`
  (PR #183/#184); OTA `0.1.3.3236` published.
- `cli-cross-machine-messaging` (P1): durable, push-based cross-machine message
  and file transfer over the existing daemon connection. Merged `d570e0c7`
  (PR #185); review-10 PASS.
- `android-expert-review-1029` (P1): independent Android-expert plan + review of
  the cycle's technical rulings; VERDICT PASS.
- `public-release-blank-machine-audit-20261029` (P1): audit deliverable accepted.

Remaining gates (external resources, not code):

- A genuinely blank supported OS machine/VM from which to run
  `docs/install-from-zero.md` end-to-end, including upgrade/rollback and the
  Collab blank-machine install-order handshake.
- Physical 15T network-transition L5: build 3236 is now installed on the 15T
  (`100.104.163.65:5555`, PLZ110, Android 16; versionName 0.1.3.3236,
  versionCode 1100032360). The device was asleep with `com.zcam.app` foreground.
  The sleep/background/LAN/cellular/Tailscale transition L5 still needs a
  coordinated window, because toggling network drops adb-over-Tailscale and may
  disturb active use.

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

- `main` == `origin/main` at `8b2a93f2`; OTA `0.1.3.3236` is `stable` in
  `~/.zterm/updates/latest.json` (versionCode 1100032360, rollback 3236.1).
- Only `main` worktree remains; `/Volumes/Intel/playground/zterm` holds no
  orphan worktree (only `.worker-runs` and `.DS_Store`).
- Session drawer: master filter uses the Collab projection (no user-entered
  master), only real tmux sessions render, and hide/restore happens in-list.
  Merged `e156ca7a` (PR #182); `android-expert-review-1029` VERDICT PASS.
- Android connection recovery: target-scoped network generation retirement and
  daemon revision reset recovery merged in PR #183/#184; L5 evidence
  `android/evidence/2026-10-29-conn-recovery-l5-3236`.
- Cross-machine messaging: PR #185 merged `d570e0c7`; review-10 PASS; daemon 50,
  CLI 297/1 skip, feature-registry 106, shared app-protocol 7 tests green. Real
  two-host acceptance passed on `Macstudio-2.local` (100.66.1.82) and
  `Jennys-MacBook-Air.local` (100.93.143.20): bidirectional message and file
  with byte/SHA-256 match, and daemon-restart file resume from a persisted
  offset. Evidence:
  `/Volumes/Intel/playground/zterm/.worker-runs/cli-cross-machine-messaging/two-machine-1/run.md`.
- Public release `v0.1.3.3232`: non-draft GitHub Release with 15 verified
  assets, `verify-release-assets.mjs` 19/19; npm published and isolated-prefix
  verified for `@jsonstudio/zterm-cli@0.1.4`, `@jsonstudio/zterm-daemon@0.1.3`,
  and the darwin-arm64/linux-x64/win32-x64 payloads.
- `docs/install-from-zero.md` exists on `main` and defines the Node 22 ABI 127,
  `TMUX_TMPDIR=~/.tmux/run`, and zterm + Collab install-order contract.
- No local VM tool exists on the dev Mac (checked multipass, lima, colima, orb,
  tart, qemu, prl, virsh, UTM). Containers, CI runners, and this configured dev
  Mac are explicitly excluded as blank-machine proof.
- Therefore, genuine blank-machine install/upgrade/rollback and the Collab
  blank-machine install-order handshake remain UNVERIFIED pending an external
  blank supported OS machine/VM.

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
