# Auto Route And Daemon Release Truth

Date: 2026-07-21

## Decision

Automatic route selection is daemon-target scoped and does not ask the user to choose between LAN, UDP direct, Tailscale, or Relay. Relay control presence and endpoint-directory refresh are logically separate from the selected terminal data transport even when an implementation can reuse a physical network path. The canonical target Auto order, confirmed on 2026-09-05, is:

1. eligible same-subnet `lan` followed by a real authenticated WebSocket handshake
2. verified `udp-direct` hole punch
3. `tailscale`
4. `relay`

IPv4 and IPv6 are address families inside the UDP-direct tier, not independent
priority tiers. Same-subnet comparison only makes a LAN endpoint eligible; it
never marks the route healthy. ICMP availability is not assumed on
Android/WebView. Only the actual authenticated transport handshake records
route success. A Relay control socket's observed TCP source port is not a
reusable daemon listener and must never be published as public direct truth.

## 2026-09-11 Direct-First WebRTC and Low-Priority TURN Lock

The connection order is:

```text
LAN -> UDP direct (rtc-direct) -> Tailscale -> IPv6/IPv4 direct families -> TURN relay fallback
```

TURN relay is allowed only after LAN, UDP direct, and Tailscale have all
failed. It is implementation fallback, not UDP-hole-punch success:

- Relay WebSockets are signaling-only for `rtc-direct` (offer/answer/ICE/error).
- The RTC data channel carries terminal payload; the signaling WebSocket must
  not carry terminal frames.
- ICE configuration for `rtc-direct` is STUN-only (`turn:` converted to
  `stun:` without TURN credentials) and `iceTransportPolicy=all`.
- `buildTraversalPlan` must add `rtc-relay` after the direct tiers so TURN is
  the lowest-priority fallback.
- A UDP-direct gate must reject a nominated ICE pair whose local or remote
  candidate type is `relay`, and must verify a payload marker over the data
  channel after the selected pair is known.

Verified gate commands:

```text
pnpm run test:relay:udp-direct
ANDROID_SERIAL=... pnpm run test:relay:udp-direct:device
```

Current implementation is not yet uniform: the TypeScript traversal default is
`LAN -> RTC direct -> Tailscale -> IPv6 -> IPv4 -> RTC relay`, while the native
Android Service currently attempts `LAN -> Tailscale -> IPv6 -> IPv4` and does
not implement native WebRTC. These are implementation gaps, not alternative
design truth.

`AndroidConnectionService` is the only owner that can compare a directory LAN endpoint with Android's current interface prefixes. The generic `TraversalSocket` has no local-interface truth and therefore must not admit Relay-directory LAN endpoints; it may still open an explicitly saved private `bridgeHost`. This keeps directory discovery separate from platform reachability without discarding an explicit user target.

Manual route selection is still allowed from the terminal status strip as an explicit override intent. Manual override changes the next open/reconnect target mode; it does not rewrite the global Auto order and does not create a per-session transport model.

Terminal session isolation is application-layer mux channel truth:

```text
daemon target physical transport
  -> terminal channel by channelId/sessionId
  -> daemon subscriber
  -> tmux mirror/input truth
```

Route candidates belong to the daemon target. Session channels do not choose routes.

## Gap Found

Two gaps caused the current `terminal mux channel open timeout` failure and unstable Auto behavior:

1. The Android APK had the mux client path, but the prepared Mac daemon release artifact was stale and did not contain `mux-hello`, `mux-ready`, or `mux-channel-open` handling. Upgrading the APK alone therefore created a protocol mismatch.
2. Saved `traversalPathPriority` could override Auto ordering. That made Auto behave like a stale user route preference instead of the product default.

## Fix Contract

- `build:android` must prepare the daemon release artifact before packaging the Android update channel.
- `server.daemon-runtime-truth.test.ts` must fail if the prepared release runtime lacks terminal mux protocol strings.
- Auto mode ignores stale saved `traversalPathPriority` and uses the canonical order above.
- Relay heartbeat/directory updates affect only future route generations. They must not close or recreate an already healthy terminal transport.
- Foreground/background transitions refresh confirmed directory truth and missed terminal body data; they do not create a new transport generation while the current generation is healthy.
- Manual route override remains explicit UI intent only.

## Verification

Minimum gates for this slice:

- `src/lib/traversal/config.test.ts`
- `src/lib/traversal/route-selector.test.ts`
- `src/contexts/session-context-infra-runtime.test.ts`
- `src/server/server.daemon-runtime-truth.test.ts`
- local daemon install/restart, then live mux smoke:

```text
ws://127.0.0.1:3333
  mux-hello -> mux-ready
  mux-channel-open(zterm) -> mux-channel-opened
```

No completion claim is valid if the running daemon PID/uptime and prepared release runtime hash were not checked.

## Paired stream delivery and one installed restart owner (2026-10-04 proposal)

The source `scripts/zterm-daemon.sh` stages the dependency's prebuilt addon and writes a CLI shim referencing its worktree. The release builder already selects the compiled addon through `prepare-daemon-release-wrtc-input.mjs`, but its installed support script uses a different native capture path. The observed live runner still uses `.zterm/daemon-runtime/server.cjs` and `.zterm/bin/zterm-daemon`; its CLI references another temporary worktree. These are observed source/installed-path gaps, not an installed repair. This revision requires targeted design admission before implementation.

Use the existing `release-runtime-promotion.graph.json`: verify_digest -> promote_daemon_artifact -> install_runtime -> start_runtime. The static graph retains its existing operator/schema topology; the actual install/restart is verified by the external public CLI and process/module evidence, not inferred from the phase7 build gate. Installed runtime truth contains the version root, permanent CLI, canonical native executable and manifest provenance. Node-internal failures stop downstream work and settle with retained old runtime plus an explicit error; cleanup removes only this task's resources. Do not add a second graph or pretend new runtime operators exist.

The installed release support script is the sole live lifecycle owner. Keep `daemon:install-global` as the one existing package-install command. Replace `scripts/zterm-daemon.sh` with a thin delegate to `.zterm/releases/zterm-daemon/<package.version>/support/zterm-daemon.sh`, deriving package.version from this candidate's package.json. Every existing subcommand, including run/status/restart, uses that installed implementation; no source staging, CLI-shim writer, native compiler, launchd writer or service implementation remains in the source script. A missing installed support script produces a nonzero explicit install-first error. There is no fallback to an old source implementation. Existing package.json and start/stop wrapper callers keep their command names and consume the same delegate.

The existing generated `bin/install-global.sh` is the sole writer of the permanent CLI and canonical native executable. Alongside installing the version-root runtime/support, it creates `.zterm/bin` and copies the package native payload to `.zterm/bin/zterm-daemon` before reporting installation success. Canonical native is therefore available after global install alone, before either foreground run or service preparation. Inside release support, `NATIVE_DAEMON_BIN=$HOME/.zterm/bin/zterm-daemon` is consumed by permission preflight and every foreground/direct/launchd runner. Physically delete support `install_user_shims` and its `write_launch_agent` call: neither native payload nor permanent CLI is rewritten by service start/restart. The CLI remains pointed at installed version-root support; live server/addon paths remain in that installed root. No new native path, TCC reset, capture app bundle, supervisor or second daemon.

The release builder rejects an unset/missing manifest before removing or constructing its own release tree. All schema, pin, triple, dependency and addon digest checks remain in the existing strict stage helper, the sole addon selector; do not duplicate those checks in shell. Tampered input fails packaging before the global installer executes, so the existing live CLI, runner, native executable and PID remain untouched. A packaging failure is not an installed functional result. The previous shared `.zterm/daemon-runtime` tree is retained: this task did not create it and cannot claim cleanup ownership.

Allowed implementation: `scripts/prepare-global-daemon-release.sh`, `scripts/zterm-daemon.sh`, and directly affected `src/server/remote-screenshot-daemon-blackbox.test.ts` architecture guards (source-stage/priming and old shim-copy assertions must follow the installed template/installer owner; preserve ScreenCaptureKit/permission/single-subject/error invariants). No package-version allocation, client, helper, server lifecycle, native C++/Swift or unrelated service changes. Shell syntax, that affected explicit Vitest file, and existing strict packaging negative tests are development gates. Actual acceptance waits for the final manifest, joint author verification and helper OS handback: build/install via the existing official entry, prove canonical native is installed before foreground/service preparation, call `scripts/zterm-daemon.sh restart` exactly once after stating the short disconnect, observe a new process loading the installed server and manifest-selected addon, verify canonical native path/hash and health, then run real stream media/quality/input/stop/reentry plus client/device paths. `verify-installed-daemon.py` is only an installed identity gate; it cannot replace media/input behavior. Independent implementation review and client/daemon paired OTA remain later endpoints.
