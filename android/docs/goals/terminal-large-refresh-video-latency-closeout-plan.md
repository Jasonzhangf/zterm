# Terminal Large Refresh And Remote Video Latency Closeout Plan

Last updated: 2026-07-24

## Objective

Close the current Android usability regression in this order:

1. P0: fix terminal render freeze when a single update exceeds one screen, such as pasting more than one screen of text into the terminal input area.
2. P1/P2: optimize remote-window video latency with area-based bitrate/FPS defaults and a measured adaptive downgrade/restore loop.
3. P3: replace multiplier-style remote-window scroll tuning with screen-proportion absolute pixel units, defaulting to one quarter of the visible remote surface.

P0 is the release gate. Do not start video tuning until the terminal large-refresh source-to-render gate exists and either reproduces the bug or proves the exact layer that fails.

## Acceptance Criteria

- Large terminal body updates larger than the visible screen do not freeze or stall the Android terminal renderer.
- The black-box gate automatically compares source truth to output truth. Manual screenshot judgment is not accepted.
- `terminal.buffer_render` remains layered: daemon mirror truth, client sparse buffer truth, render gate/store truth, and `TerminalView` DOM projection stay separated.
- `buffer-sync` body payloads cover authoritative changed spans without holes that preserve stale middle rows.
- Remote-window floating preview defaults remain low cost; fullscreen or larger displayed area derives bitrate/FPS from desktop source area and display coverage.
- Adaptive quality uses WebRTC statistics and explicit thresholds; it must downgrade on sustained congestion and restore only after stable recovery.
- Remote-window scrolling sends absolute pixel deltas derived from visible surface height, with default one quarter screen and optional direction inversion.
- APK/update routes are published only after focused gates, architecture gates, build, and live checks pass.
- If daemon code changes, the daemon release is prepared, installed, service-scoped restarted, and probed against the installed runtime.

## Scope

In scope:

- `terminal.buffer_render` large-span receive/apply/render behavior.
- Daemon buffer-sync payload span contract and mirror close-loop gates if evidence points there.
- Client sparse buffer apply, render gate, render store, and DOM projection if evidence points there.
- Remote-window quality request/runtime, daemon WebRTC sender parameter updates, and measured quality telemetry.
- Remote-window touch-action scroll delta model and tests.
- Docs/maps/skills/memory updates tied to the changed owner features.

Out of scope:

- Transport reconnect, route fallback, WebSocket rebuild, session switching policy, or daemon/client identity changes unless direct evidence proves P0 lives there.
- UI-level forced redraw, buffer clear, page refresh, reconnect, or "retry until visible" compensation.
- Replacing terminal payload semantics to hide bad source truth.
- Remote-window gesture/input/focus redesign beyond the requested scroll delta model.

## Architecture Mapping

P0 owner feature: `terminal.buffer_render`.

P0 allowed mainline:

```text
daemon buffer-sync body payload
-> client sparse buffer apply
-> session render gate projection
-> session render buffer store
-> TerminalView visible DOM rows
```

P0 forbidden paths:

- `buffer-head` as body repaint truth.
- UI redraw or reconnect as freshness truth.
- Client request triggering daemon sync policy.
- Renderer owning daemon/client buffer state.
- Session transport activity being treated as render freshness.

P1/P2 owner feature: `desktop.remote_window_stream.client.quality_request` plus daemon remote-window sender quality application.

P1/P2 allowed mainline:

```text
RemoteWindowOverlay quality intent
-> SessionContext remote-window quality runtime
-> existing active session transport
-> daemon remote-window stream owner
-> existing WebRTC sender encodings update
```

P1/P2 forbidden paths:

- Restart capture or rebuild the WebRTC/session transport merely to change quality.
- Use Android phone fullscreen alone as proof of desktop full-screen coverage.
- Add a second remote-window stream truth or hidden media fallback.

P3 owner feature: `desktop.remote_window_stream.client.touch_action`.

P3 allowed mainline:

```text
RemoteWindowOverlay local touch classification
-> remote-window-touch-action-runtime
-> focus-first remote-window input dispatch
-> daemon input owner
```

P3 forbidden paths:

- Raw touch passthrough.
- Queued stale gesture replay.
- Daemon-side guessing of client scroll intent.

## Function And Map Requirements

Before implementation:

- Re-read `android/docs/resource-map.md`.
- Re-read `android/docs/function-map.md`.
- Re-read `android/docs/wiki/mainline-call-map.json`.
- Re-read `android/docs/testing/terminal-refresh-buffer-truth-test-design.md`.
- Re-read `android/docs/testing/remote-window-stream-test-design.md`.
- Re-read `.agents/skills/terminal-buffer-truth/SKILL.md` and `.agents/skills/zterm-mobile-dev/SKILL.md`.

During implementation:

- Update resource/function/mainline/test maps only for real owner changes.
- Do not invent symbols in maps. Mark missing edges `binding pending` only when the code is not implemented yet.
- Keep feature ids searchable from changed tests and docs.

## P0 Test Design

### Required Automatic Black-Box Gate

Create or extend a gate that controls a real or controlled terminal source and automatically compares:

```text
tmux/source oracle
daemon buffer-sync payload span/ranges
client sparse buffer snapshot
render store snapshot
TerminalView DOM rows with absolute row indexes
```

Cases:

- Paste/input update larger than one visible screen.
- Two-screen and five-screen payloads.
- Fast bottom-region updates while follow mode remains at the tail.
- TUI-like fast top/body/footer refresh with more changed rows than visible height.
- Lower-revision and same-revision late payloads must drop without overwriting non-gap rows.
- Head-only metadata interleaved with body updates must not repaint body rows.

Pass condition:

- Final DOM visible rows and absolute indexes match the latest source/render truth.
- No connected-green/render-stale state is accepted as pass.
- No manual visual confirmation is required.

### Required White-Box Gates

- `buffer-sync` contract: changed range payload covers the full continuous authoritative span from first changed row to last changed row.
- Client sparse apply: large spans mutate the local buffer truth and schedule render without dropping middle rows.
- Render gate/store: large revision/body updates publish once per RAF generation and cannot be blocked by stale anti-regression logic.
- Negative gates: low revision without daemon-head reset cannot publish; same-revision stale content cannot overwrite non-gap rows.

## P1/P2 Video Latency Design

Quality model:

- Use desktop source area divided by daemon display area as the baseline coverage ratio.
- Full desktop coverage max: `20 Mbps`, `60 FPS` ceiling.
- Default realtime target: `30 FPS` where the display area and route can support it.
- Floating preview default: `2 Mbps`, low cost.
- Smaller windows derive max bitrate from area ratio; phone fullscreen does not imply desktop fullscreen.
- User-selected max is a ceiling, not a guarantee.

Adaptive loop:

- Sample `RTCPeerConnection.getStats()` for outbound/inbound stats that indicate encode pressure, frame rate, packet loss, RTT, freezes, target bitrate, and quality limitation reason.
- Downgrade progressively on sustained congestion:
  - require consecutive weak samples before leaving baseline quality;
  - reduce bitrate to half or quarter of current ceiling;
  - reduce FPS from 30 to 15, then lower if needed;
  - allow 5 FPS as a severe weak-network floor.
- Restore slowly only after a stable recovery window.
- Status should expose measured uplink/downlink and selected connection mode from existing top status truth; avoid adding layout-changing notifications.

Daemon rules:

- Quality update changes existing sender encoding fields only.
- Stream start must pass the requested max FPS into ScreenCaptureKit; regular presets start at 30 FPS and the desktop-fullscreen preset starts at 60 FPS.
- Do not restart capture, renegotiate, or rebuild transport for normal quality updates.
- Empty/unsupported sender encodings must fail explicitly for quality update, not fake success.

## P3 Scroll Semantics

- Replace multiplier presets with absolute visible-height fractions:
  - `1/8 screen`
  - `1/4 screen` default
  - `1/2 screen`
  - `1 screen`
- Compute delta pixels from the actual remote content rect visible height.
- Direction inversion flips only the sign.
- Preserve coordinate mapping and focus-first dispatch.
- One-finger zoomed fullscreen pan remains local; remote scroll is explicit two-finger scroll or wheel path.

## Verification Matrix

Minimum local gates:

- Focused P0 tests added/updated for buffer sync, sparse apply, render gate/store, and DOM source-to-target comparison.
- Focused remote-window quality tests.
- Focused remote-window touch-action scroll tests.
- `pnpm --dir android exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm --dir android run test:feature-registry`
- `git diff --check`

Required live gates:

- `pnpm --dir android run daemon:mirror:close-loop` or the current canonical mirror close-loop gate including the new large-paste/large-refresh case.
- If daemon changed: `pnpm --dir android run daemon:prepare-release`, `pnpm --dir android run daemon:install-global`, service-scoped `/Users/fanzhang/.local/bin/zterm-daemon restart`, `/health` runtime SHA/PID check, and live probe for the changed daemon owner.
- If remote-window stream/quality changed: local and Tailscale remote-window live stream probe must still see `trackSeen=true`, and quality requests must be observed without stream restart.
- If an online ADB device is attached, run installed-phone L5 WebView/DOM/source-to-target proof. If not attached, report this as an explicit gap.

Delivery gates:

- `pnpm --dir android run build:android`
- Publish APK/update manifest to local, Tailscale/daemon, and public Relay update routes.
- Download/HEAD-check every route and compare manifest/APK SHA-256.
- Commit and push all code/docs/test/skill/memory changes.

## Implementation Order

1. Lock P0 evidence before any fix: reproduce or isolate the large-refresh freeze with automatic source-to-target comparison.
2. Fix the unique P0 owner only.
3. Run P0 focused, mirror, and architecture gates.
4. Implement P1/P2 quality model and adaptive loop.
5. Run remote-window stream quality gates and live stream probes.
6. Implement P3 absolute scroll units.
7. Run touch-action/page gates.
8. Update docs/maps/skills/memory.
9. Build, publish, daemon restart if needed, commit, push.

## Definition Of Done

- P0 large-refresh freeze is fixed with automatic black-box proof.
- P1/P2/P3 are implemented only after P0 is closed.
- No fallback/reconnect/redraw workaround is introduced.
- All affected docs/maps/skills/memory are synchronized.
- APK and update routes are live and SHA-verified.
- Daemon installed runtime is verified if daemon code changed.
- Final report includes changed files, exact verification evidence, remaining live-device gaps, APK version/sha, commit hash, and push result.
