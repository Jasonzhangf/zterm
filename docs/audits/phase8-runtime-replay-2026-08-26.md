# Phase 8 Runtime Replay Audit

Date: 2026-08-26
Auditor: pane-5
Run: 20260826T233500Z-Macstudio-pane5-replay
Baseline: d5d8516531994566d06d6338033b8a91e3b58228

## Verdict

`BLOCKED`: package-level replay and static gates pass, but the required
four-platform live parity gate is not complete. This report must not be used
as release or AGY-review evidence for Phase 8 closeout.

## Replayed Gates

| Area | Evidence | Result |
| --- | --- | --- |
| Registry / architecture | Map registry, governance, parity catalog, diff check | PASS |
| Kernel lifecycle / control error | `packages/kernel` lifecycle and Cordis tests, 15/15 | PASS |
| Transport / buffer / file-media | `packages/stream-boundary` tests, 25/25 | PASS |
| Session route / persistence replay | `packages/shared` domain tests, 27/27 | PASS |
| Desktop IPC / stale generation | `packages/desktop-gateway` tests, 9/9 | PASS |
| React surface projection | `packages/ui-react` tests, 3/3 | PASS |
| Android low-risk plugin ownership | `android` tests, 24/24 | PASS |
| Mac / Windows static host surface | Mac and Windows type-check | PASS |
| Windows package-local suite | Windows tests, 30/30 | PASS |
| iOS contract surface | `packages/ios-host`, 22/22; device contract 11/11; negative 6/6 | PASS, contract only |

The parity catalog is valid with 75 features: Android 57, macOS 13, and
Windows 8. It contains no iOS platform feature coverage, so the catalog does
not independently prove an iOS runtime replay.

## Blocking Gaps

1. `zterm.v2.phase7.ios.native` is still `working`. The repository has no
   completed native iOS target, simulator smoke, device lifecycle smoke, IME
   smoke, or terminal live replay. `packages/ios-host` tests are typed
   contract tests only.
2. The Windows handoff records a successful local package and daemon start,
   but remote daemon smoke remains blocked by Tailscale TCP/3333 firewall,
   stale WezTerm pane state, daemon persistence rights, and missing
   `icon.ico`. The Mac desktop handoff also records an unavailable packaged
   CDP smoke. These are not equivalent to real packaged terminal parity.
3. The Phase 8 architecture audit identifies nine active runtime gates that
   are not wired into the `cordis-v2-governance` CI job: IPC codec, stale
   generation, session-route replay, persistence replay, terminal transport,
   terminal buffer render, file-media input, Android low-risk plugin ownership,
   and desktop packaged parity. This violates the required CI/build-chain gate
   rule.

## Status Evidence

- `d5d85165` is both local `main` and `origin/main`; no undeclared dirty files
  were present at audit time.
- Phase 0 through 6 are `complete`.
- Phase 7 lists desktop parity, iOS device contracts, and Windows live as
  delivered claims but remains `active` because its live gates are unresolved.
- Phase 8 remains `blocked-on-phase-7`.

## Required Before Closeout

1. Finish the iOS native task and record simulator or device terminal evidence.
2. Resolve the Windows and Mac packaged-live blockers, then replay their
   terminal transport, buffer render, lifecycle, control error, and persistence
   paths.
3. Wire all active runtime gates into CI or the build chain, and verify the
   resulting CI job.
4. Rerun this audit against the resulting `origin/main`, then run AGY review
   only after all live evidence is available.

## T5 Reconciliation Checkpoint (2026-08-27)

T1/T3 provide current Mac evidence on the merged baseline: split-tree arity,
type-check, packaged terminal sequence/TUI/large-reading replay, signature,
launch exit, and cleanup passed; T3 AGY review returned PASS with no findings.
T2 provides current Android package/OTA/emulator evidence, with the worktree APK
2758 distinguished from the installed emulator 2760. T4 confirms Android/Mac CI
gate wiring. These results supersede the historical Mac packaged and Android/Mac
CI portions above; the global verdict remains `BLOCKED` because Windows and iOS
live parity are deferred/incomplete.
