# Auto Route And Daemon Release Truth

Date: 2026-07-21

## Decision

Automatic route selection is daemon-target scoped and does not ask the user to choose between LAN, Tailscale, public direct, or Relay/TURN. Relay control presence and endpoint-directory refresh are logically separate from the selected terminal data transport even when an implementation can reuse a physical network path. The canonical Auto order is:

1. eligible same-subnet `lan` followed by a real authenticated WebSocket handshake
2. `tailscale`
3. verified public direct transport (`ipv4` / `ipv6` WebSocket or `rtc-direct` UDP hole punch)
4. `rtc-relay` TURN/Relay

Same-subnet comparison only makes a LAN endpoint eligible; it never marks the route healthy. ICMP availability is not assumed on Android/WebView. Only the actual authenticated transport handshake records route success. A Relay control socket's observed TCP source port is not a reusable daemon listener and must never be published as public direct truth.

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
