# zterm Project Master Standing Goal

Status: active
Owner: Jenny, zterm project master
Updated: 2026-11-04

## Objective

Own and drive the zterm project to verified delivery. Keep every accepted P1
task moving, verify delegated evidence, integrate only validated changes,
publish only authorized artifacts, and close owned resources.

## Active Board Tasks

All project board tasks closed before 2026-11-04 are merged to `main`; open work is listed under "Current cycle (2026-11-04)":

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

Current cycle (2026-10-31):

- `udp-send-stalled-1031` (P1, Alice/android expert): close the two P1 findings
  from `udp-lan-expert-review-20261031`: bound persistent OPEN RTC
  send-rejection with a typed send-stalled observation and supervised exit, and
  produce foreground 15T rtc-direct file-bytes and terminal apply/commit
  latency evidence. Contract:
  `/Volumes/Intel/playground/zterm/.worker-runs/udp-send-stalled-1031/task.md`.
- `udp-baseline-15t-1031` (P1, Bob): baseline foreground 15T measurement on
  installed `0.1.4.3239` for the A/B comparison. Contract:
  `/Volumes/Intel/playground/zterm/.worker-runs/udp-baseline-15t-1031/task.md`.
- `cli-delivery-verify-1031` (P2, Carol): independent public-npm re-verification
  of CLI 0.1.5 / daemon 0.1.4 message and file delivery. Contract:
  `/Volumes/Intel/playground/zterm/.worker-runs/cli-delivery-verify-1031/task.md`.
  Result: PASS. Public install and local `e2e.pass`; real two-host run
  `100.66.1.82` <-> `100.93.143.20` delivered a multiline message and a
  48000-byte file with matching SHA-256, reverse message, and restart with no
  duplicate. Report:
  `/Volumes/Intel/playground/zterm/.worker-runs/cli-delivery-verify-1031/verify.md`.
- `udp-send-stalled-1031` CLOSED and merged to `origin/main` as `9437dbbe`
  (PR #198). Rework commit `f4204655` implements strict-decrease resume from
  the recorded `sendStalledBufferedBytes`. Independent review PASS with zero
  findings; Alice Android-expert confirmation PASS; PR #198 CI green; build
  `0.1.4.3242` foreground 15T manual:rtc-direct L5 acceptance PASS
  (5 MiB SHA-256 match, 512 KiB burst, terminal apply/commit p50/p95/p99,
  HOME/resume same generation, reconnectDelta=0, overflowDelta=0, route
  restored to auto). Evidence:
  `/Volumes/Intel/playground/zterm/.worker-runs/udp-send-stalled-1031/evidence/3242-15t-acceptance.json`
  and
  `/Volumes/Intel/playground/zterm/.worker-runs/udp-send-stalled-1031/review/review-udp-send-stalled-1031-rework/review.final.md`.
  Local worktree and local+remote `fix/udp-send-stalled-1031` branches removed.
- `udp-baseline-15t-1031` BLOCKED with a changed premise. The device is now
  idle (asleep, `com.zterm.android/.MainActivity` foreground) but installed
  build is `0.1.4.3242` (the fix already landed), not the required pre-fix
  `0.1.4.3239`. Capturing the pre-fix baseline would require reinstalling
  `3239`, which the task contract forbids. Disposition is pending the CEO/user:
  close the task as obsolete or re-scope the comparison. All baseline fields
  remain UNVERIFIED.
- `cli-delivery-verify-1031` (Carol): accepted and closed by master with the
  two-host and local evidence; no merge or cleanup was required.

Review ruling: `udp-lan-expert-review-20261031` (codex-review, profile oauth,
model codex-auto-review, commit `4d248997`, base `93a693d4`) returned FAIL with
two P1 findings: (1) persistent OPEN `sendText()==false` below the high
watermark can reschedule forever because the RTC branch runs before the bounded
`SEND_RETRY_MAX` branch; (2) the foreground 15T rtc-direct file-integrity and
terminal-latency acceptance is missing. The review confirmed the
non-duplication claim for route selection and remote-window budget.

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

## Current cycle (2026-11-04) — zterm V2 first seam

Open work (owner / reviewer / next_step in `collab board show`):

- `zterm-v2-terminal-milestone-e2e-1103` (P1, Jenny, integration): env recovery
  waits on r2 writer PID 49522 still running; then product seam — real V1
  login, session/target discovery, V2 pane input echo. WebUI
  `http://127.0.0.1:8801/` returns HTTP 200 but does not prove seam passed.
  Next: after writer exit, GCM offline `pnpm install --offline --frozen-lockfile`
  in `1:/workspaces/21`, verify `ws` + `esbuild`, then product seam.
- `client-rotation-recovery-impl-1103` (P1, Alice): LayerFS candidate head
  125168b3, container unit tests + type-check pass. Host GCM rebuilt
  `0.1.5.3245` (APK sha256 `d4720a3b...`), ran an isolated HOME/port daemon
  (3334) plus fake relay (19091) on `emulator-5560`. Old-token rejection and
  unchanged-token no-reconnect are PASS. The clean rerun did not yet exercise
  the intended picker path; the session-open retry loop still reconnects with
  the stale token and never adopts the rotated directory token. Verifier is
  rebuilding the harness to test the real picker `handleRefreshNow` path
  before a final FAIL/PASS. Not delivered.
- `zterm-v2-accounts-relay-wiring-1103-r1` (P1, Grace, David): accepted
  candidate 1263bd42 on LayerFS main; pending merge/combination E2E + final
  audit.
- `zterm-v2-bootstrap-r6-followup-1103` (P1, Grace, David): accepted; integrate
  onto main then record collab task integrated.
- `zterm-v2-tickets-impl-1103` (P1, Jenny, David): accepted 127b81ff; awaits
  merge onto main then record integrated.
- `zterm-v2-webui-frontend-test` (P0, Iris): delivered contract. Iris
  re-verified 127f6e57: all 8 blocking items closed PASS (U3b kept P2), plus
  4 extra measured PASS items. Conclusion moved from FAIL to PASS for the
  current candidate.
- `zterm-v2-webui-impl-1103` (P1, Frank): 127f6e57 accepted (revision 9,
  status accepted). UI rework (8 blockers) closed; evidence linked in the
  task. Frontend publish still requires the tester verdict before release.

Blocked:

- `udp-baseline-15t-1031` (P1, Bob): blocked by changed premise — installed
  build is already `0.1.4.3242` (the fix), not the required pre-fix
  `0.1.4.3239`, and reinstalling 3239 is forbidden. 15T is now reported
  online, but the task still needs a CEO disposition: close as obsolete or
  re-scope the comparison. All baseline fields remain UNVERIFIED.

Open defects: `public-release-blank-machine-audit-20261029`, `Implement zterm
V2 accounts first increment`.

Pending merges: `zterm-v2-accounts-relay-wiring-1103-r1`,
`zterm-v2-bootstrap-r6-followup-1103`, `zterm-v2-tickets-impl-1103`.

Worktree inventory (2026-11-04): 1 registered (`main`
`/Volumes/extension/code/zterm`, dirty with in-flight and other-owner edits),
no `.git/worktrees` entries, no orphan worktree dirs under
`/Volumes/Intel/playground/zterm/`; 0 closed, 1 PROTECTED_HOLD. No new
worktrees; new tasks use LayerFS task branches.

## Current cycle (2026-11-02)

- `cli-daemon-release-1102` (P1, Jenny): PR #205 merged `913ab408` and only
  bumps the daemon version source `android/package.json` to `0.1.5`. CI main
  run `41412668374` and CLI Platform run `41412668405` both green. Published
  `next` then promoted `latest` for `@jsonstudio/zterm-cli@0.1.6` and
  `@jsonstudio/zterm-daemon@0.1.5` (launcher) plus the darwin-arm64/linux-x64/
  win32-x64 `0.1.5` payloads. Isolated public-registry install verified CLI
  `0.1.6` and daemon `0.1.5` (launcher + darwin-arm64 payload native load).
  Upgraded and verified Mac Studio (CLI `0.1.6`, daemon `0.1.5`, `/app`
  bearer `101`, pid `99318`) and MacBook Air `macbookair` `100.86.84.63`
  (CLI `0.1.6`, daemon `0.1.5`, `/app` bearer `101`, pid `76062`, token
  configured). Cross-machine verified from Mac Studio: `zterm app send
  --peer macbook-air` state `received`; `send-file` remote SHA-256
  `3b817d58...` matches source.
- `udp-dual-channel-1102` (P1, Jenny board task; GCM worker in progress in
  `/Volumes/Intel/playground/zterm/udp-dual-channel-1102`): protocol
  `bulkChannel` capability and lane routing being implemented per
  `android-lan-udp-hol-plan-1031` plan (Android-expert rereview PASS); emulator
  `-5558` L5 smoke replaces the blocked 15T baseline.
- Second MacBook Air `jennys-macbook-air` `100.93.143.20`: SSH port 22 open
  but `fanzhang`/`jenny`/`jennyzhang`/`jason` all rejected publickey; daemon
  ports 3333/42233 closed. Blocked on machine-side SSH key authorization; no
  daemon install or verification performed. Original error preserved.
- Email-reset mechanism for daemon token (`m1793602192887-512`) remains
  unimplemented; not claimed complete.

## Current Verified Facts

- Release PR #194 bumps CLI to `0.1.5` and daemon to `0.1.4`; PR #195 records
  the cold-start verification. Local OTA `~/.zterm/updates/latest.json` points at
  `0.1.4.3239` (versionCode 1100032390) after the cold-start DAGpipe fix
  build. Relay public OTA is still `0.1.3.3232`; publishing `0.1.4.3242` to
  Relay remains a release action awaiting authorization.
- `main` base is now `9437dbbe` (`origin/main`), including PR #196 `8a4c9abb`,
  PR #197/#198 `udp-send-stalled-1031` fix `f4204655`, and the CLI 0.1.5 /
  daemon 0.1.4 release chain. The 15T is installed with `0.1.4.3242`
  (versionCode 1100032420).
- Worktrees: `main` plus the unmerged diagnostic branch
  `android-error-boundary-diag-20261030` (`fix/android-error-boundary-diag`,
  `c329d134`, clean, not merged). No other orphan worktree.
- Credential rotation decision still pending: the daemon `authToken`, Relay
  `signalToken`, and TURN credential that were previously exposed in old `3240`
  evidence are now redacted but have not been rotated. Rotation requires
  explicit user/CEO authorization.
- The codex-review tool (`review_start`/`review_list`) was tested and produced a
  valid PASS verdict with exit 0.
- Cold-start DAGpipe fix: installed 3238 failed `compileAllDagpipePhases`
  with missing `reconcile_body_subscription`; 3239 from `main` (PR #192,
  `4d248997`) compiles all 25 graphs `ok:true`. Verified on emulator-5558
  and on the 15T (`0.1.4.3239`): cold start, HOME/resume, and zero
  `zterm:react-error` / `页面加载失败` / missing-operator hits; screenshot shows
  Settings at 0.1.4.3239. Evidence
  `android/evidence/2026-10-31-coldstart-dagpipe-3239/` and
  `/tmp/zterm-15t-fg-3239.png`. The 15T network-transition L5 (LAN/cellular/
  Tailscale) still needs a coordinated window.
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
- Public npm `latest` now carries `@jsonstudio/zterm-cli@0.1.5` and
  `@jsonstudio/zterm-daemon@0.1.4` (plus `0.1.4` darwin-arm64/linux-x64/
  win32-x64 payloads). CLI `0.1.5` exposes `zterm app` (stream/send/send-file/
  status/ack/consume); daemon `0.1.4` serves the `/app` WebSocket gateway.
  Verified by isolated public-registry install (`zterm app --help`,
  `zterm daemon install --version 0.1.4`) and the full `app-messaging-e2e`
  against the public installed CLI (`e2e.pass`: bidirectional message, file
  byte match, restart resume, dedupe, slow-consumer, inbox cap, auth reject).
  Source CI: CLI Platform `41188327672` and main `41188327683` both green.
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
