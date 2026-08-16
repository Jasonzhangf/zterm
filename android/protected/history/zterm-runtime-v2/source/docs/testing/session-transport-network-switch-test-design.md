# Session Transport Network-Switch Test Design

## Architecture Binding

- Feature: `terminal.transport_lifecycle`
- Resources: `resource.platform_network_signal`, `resource.daemon_target_transport`
- Unique health owner: `src/contexts/session-context-target-network-probe-runtime.ts`
- Mainline chain: `android_mainline:PlatformNetworkSignal->OpenTabNetworkBinding` -> `android_mainline:OpenTabNetworkBinding->AppNetworkBinding` -> `android_mainline:AppNetworkBinding->SessionContextNetworkFacade` -> `android_mainline:SessionContextNetworkFacade->SessionProviderNetworkBinding` -> `android_mainline:SessionProviderNetworkBinding->SessionPublicFacadeBinding` -> `android_mainline:SessionPublicFacadeBinding->SessionProviderCoreBinding` -> `android_mainline:SessionProviderCoreBinding->TargetNetworkSignalOrchestration` -> `android_mainline:TargetNetworkSignalOrchestration->TargetTransportAccessors` -> `android_mainline:TargetTransportAccessors->TargetTransportStoreEnumeration` -> `android_mainline:TargetTransportStoreEnumeration->TargetNetworkProbeDispatch` -> `android_mainline:TargetNetworkProbeDispatch->TargetNetworkProbe`
- Recovery return: `TransportHealth -> SessionRuntime -> TransportReusePlan -> TransportOpen`
- Allowed behavior: retain the logical session and cached buffer while replacing only a stale physical WebSocket.
- Forbidden behavior: UI/page reconnect loops, daemon client-network state, fallback endpoints, parallel replacement sockets, or treating `readyState === OPEN` as sufficient health truth.

## Lifecycle Contract

1. A mux target transport owns one heartbeat timer keyed by `targetKey`; logical tmux sessions/channels do not own heartbeat timers.
2. Normal target keepalive is low-frequency (30 seconds). Session switch, channel open, foreground resume, and body-subscription changes do not start another heartbeat.
3. Every valid mux server frame refreshes target physical activity; `mux-pong` also refreshes pong truth. Activity is recorded under the physical target key, not the anchor session id.
4. The target health owner may finalize one physical socket generation only after its configured consecutive health policy is exhausted; the target failure fanout then preserves logical session/channel ids and routes recovery through the existing reconnect owner.
5. The existing reconnect owner replaces only that physical target socket while retaining logical session/channel ids, active-session truth, and local buffers.
6. A valid target frame resets the consecutive-miss count. A `CONNECTING` socket is retained without probe traffic or failure submission; `CLOSING`/`CLOSED` becomes `TargetNetworkProbeError03TerminalSocketState` and enters the single target failure router. A channel error must not poison the target heartbeat or rebuild the physical socket.
7. App visibility and platform network availability are independent resources. A network callback cannot write foreground/background truth, stop body subscription, or stop foreground freshness timers.
8. A platform network-generation signal starts at most one bounded probe for each affected daemon target and exact physical socket generation. Capacitor/window network signals carry observed connectivity metadata; foreground-resume carries generation only and must not invent endpoint reachability. Any valid mux server frame proves that generation healthy.
9. Probe success retains the exact socket and all channels. A single bounded probe timeout is inconclusive and only clears the pending probe; it must not retire an `OPEN` transport. Physical failure remains owned by terminal socket state, synchronous send failure, or the three-consecutive-miss heartbeat policy. Late frames from an actually retired generation are ignored.
10. Android Activity backgrounding must leave WebView timers running. While at least one retained Session exists, a native foreground service keeps the process schedulable with one partial WakeLock; it cannot create, close, replace, or evaluate control/data transports. The service lifecycle is retained-session-owned and independent from the background heartbeat callback: entering background enables only the callback, foreground return disables only the callback, and the final retained Session/provider disposal stops the service.
11. The five-minute background handoff deadline applies only to high-volume terminal body demand. It cannot stop native process protection, close a transport, or schedule reconnect. Returning to foreground or closing the final retained Session stops the native execution service and releases its WakeLock without touching the existing WebSocket/RTC generation. Android force-stop remains terminal and is not bypassed.
12. Relay account login does not redefine saved direct/Tailscale target ownership. A persisted daemon id without Relay endpoint/signaling/WebRTC evidence opens through the explicit direct endpoint and does not wait for control-directory confirmation.

## White-Box Gates

Positive:

- Two logical sessions sharing one target create exactly one heartbeat timer.
- Healthy target transport sends one `mux-ping` per 60-second-class tick.
- Any valid target activity between ticks resets the physical miss counter.
- Three consecutive target health misses call the physical failure owner exactly once.
- Stale failure enters the existing reconnect owner and preserves logical session state.
- A connected or disconnected platform network event leaves foreground truth unchanged and sends one `mux-ping` for one target even when six logical channels share it.
- Foreground entry sends the target-level generation signal even when no tab/session is active; the independent session-audit decision may still skip.
- One platform event enumerates every current daemon-target transport generation, including targets with no active tab; two targets produce two probes while six channels on one target still produce one.
- A valid frame during the bounded probe keeps the same socket and route generation.
- A synchronous probe send failure returns `send-failed` and enters `TerminalTransportError01TargetFailure`; it cannot be projected as `started`.
- Probe timeout retires the exact socket once and schedules one target rebuild through the existing failure owner.
- A retained physical target with zero logical sessions is still probed; failure retires that exact idle generation without inventing a logical session or reconnect job.
- The target socket listener validates inbound activity by `targetKey + exact socket`, not by the session that originally opened it; deleting the last logical session followed by a valid `mux-pong` keeps the idle target generation alive.
- Heartbeat and network-generation probes both serialize through the shared `buildTerminalMuxPing` contract builder.
- Probe construction rejects a missing, non-finite, fractional, non-positive, or unsafe-integer timeout and rejects a missing/non-callable clock; the runtime cannot default, round, or clamp owner configuration. The shared mux-ping builder likewise rejects negative, fractional, non-finite, or unsafe-integer timestamps instead of repairing wire payloads.
- Activity `onStop` leaves shutdown to the JavaScript lifecycle owner; foreground service stop occurs only after the UI lifecycle owner receives a foreground/resume signal.
- The service acquires exactly one non-reference-counted partial WakeLock, remains active past the body-handoff deadline, and releases it in `onDestroy`.

Negative:

- One or two misses cannot fail or close the physical transport.
- A busy terminal stream on any logical channel refreshes target health without requiring a per-session heartbeat.
- Repeated timer ticks after terminal failure cannot finalize the same physical socket generation again.
- `CLOSING` or `CLOSED` sockets cannot send ping or create a second reconnect path.
- A logical channel close/open does not create another physical heartbeat timer.
- An ordinary route failure enters a short circuit-breaker cooldown, then becomes probe-eligible again without an app restart.
- An authentication failure remains quarantined for the full route-health TTL and cannot be mistaken for a transient network failure.
- One `TraversalSocket` generation attempts each candidate at most once even after a candidate becomes probe-eligible in the shared cache.
- Network events cannot call the session resume/reconnect API, cannot alter body-subscription truth, and cannot create per-session heartbeat or reconnect work.
- Active-session/open-tab truth cannot scope the platform signal; inactive daemon targets remain part of the same target-owner probe pass.
- Repeated network events while one target probe is pending cannot send another probe or schedule another rebuild.
- A foreground/network generation probe timeout cannot retire an `OPEN` target or schedule reconnect; the normal consecutive-miss heartbeat remains the failure owner.
- A late frame from a superseded socket cannot settle the current generation's probe.
- Background entry never calls `WebView.pauseTimers()`, `WebView.onPause()`, or a transport close/reconnect API.
- The native service does not request battery-optimization bypass and contains no socket, RTC, route, session, or control-directory implementation.

## Module Black-Box Gate

Replay an OPEN WebSocket whose server frames stop while its target IP remains reachable. Advance three heartbeat ticks, prove one retryable failure, one pending open intent, one replacement socket, unchanged session id/buffer, and rejection of late frames from the superseded socket.

Replay an OPEN physical route that then fails before `mux-ready` or channel-ready. The target failure owner must report the protocol failure into route health, remove that exact physical generation from target truth, close it once, and schedule exactly one target rebuild. The replacement route plan must not continue treating the failed route as a recent success. Multiple logical channels must not multiply retirement or reconnect calls.

Replay a transient Tailscale failure while Relay metadata remains available. During the short cooldown the failed route is unavailable to the next physical generation; after cooldown the same Tailscale endpoint must be probed again without clearing process state. A five-minute ordinary-failure blacklist is forbidden. The shared health cache may retain successful-route history for five minutes, but ordinary connectivity failures and authentication failures require different expiry policies.

Negative: if the failed physical socket is already `CLOSING` or `CLOSED`, the owner still records route failure and rebuilds recoverable channels, but must not call `close()` again. A target failure must not close or recreate any control/directory socket.

Replay a false or transient `NetworkStatus.connected` value while `document.visibilityState` and Capacitor App state remain active. Foreground truth, refresh timers, and body subscriptions must remain active. This is a red gate because platform network status is a probe signal, not endpoint reachability or app-lifecycle truth.

## Real-Device Black-Box Gate

1. Connect the current APK to the Mac Studio daemon through its Tailscale IP and run a continuously changing TUI.
2. Capture client session id, daemon tmux target, buffer head, physical transport id, and Android network id.
3. Disable Wi-Fi while cellular remains validated. Independently prove `http://100.66.1.82:3333/health` is reachable from the phone.
4. Without killing the app, switching session, or reopening the page, prove output resumes through one replacement physical WebSocket within 10 seconds.
5. Prove logical session id and tmux target are unchanged, buffer head is monotonic, input echoes, and no stale socket event overwrites the replacement.
6. Repeat cellular-to-Wi-Fi.
7. Send the app to background for two minutes while a tmux counter changes. Prove the same physical transport generation remains open, then foreground the app and prove the latest body arrives without a replacement socket.
8. Keep the app backgrounded for ten minutes. Prove the foreground-service notification stays visible, the process WakeLock remains held, and control/target heartbeats continue while body/video subscriptions remain disabled.

## Known Gap Rule

Unit tests, type-check, build, and local WebSocket simulation do not close the network-switch bug. Completion requires the real-device two-direction gate above on the newly built APK.
