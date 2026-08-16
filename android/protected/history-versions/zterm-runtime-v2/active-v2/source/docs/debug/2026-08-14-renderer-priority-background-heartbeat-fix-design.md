# Fix Design: WebView Renderer Cached Kill + Foreground BackgroundService Wake

- Design ID: `FD-20260814-RENDERER_PRIORITY_BACKGROUND_WAKE-01`
- Status: approved for implementation by Jason ("马上进行修复")
- Base: `9c52d5d`
- Added: 2026-08-14

## Scope

- Feature/module: `terminal.transport_lifecycle` / `mainline_source.android` / `client.app_shell`
- Native owner: `MainActivity.java`, `BackgroundService.java`
- Test owner: `android-power-policy.test.ts`
- Allowed paths: the three files above plus this design and project notes
- Forbidden paths: daemon transport, session reconnect policy, buffer/renderer, route health, network config

## Confirmed Evidence

- App main process stays alive while its WebView renderer exits: app PID `1762` remains active; zterm-bound renderer PID `10618` is classified as `CACC / curProcState=17 / oom cur=900`.
- `dumpsys activity exit-info` contains repeated non-upgrade renderer exits:
  - `2026-08-14 12:12:23.669 pid=31685 reason=EXIT_SELF`
  - `2026-08-14 13:05:55 pid=30379 reason=OTHER KILLS BY SYSTEM / ISOLATED NOT NEEDED`
  - plus multiple earlier `EXIT_SELF / ISOLATED NOT NEEDED` records.
- `MainActivity` currently calls
  `setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true)`.
  The second argument means the priority is waived whenever WebView is not
  visible. On this device the renderer is therefore allowed to become a cached
  `900` process even while the app has a foreground service and a resumed
  Activity.
- `BackgroundService` currently calls `evaluateJavascript()` unconditionally
  every 30 seconds whenever retained sessions exist, including while the app is
  foreground. The JS callback returns early when not backgrounded, but the
  native renderer call still runs and is unnecessary foreground renderer
  pressure.

## Root Cause

The first divergence for the recurring reconnect is above socket lifecycle:
the zterm-bound WebView renderer process is allowed to be cached and is
repeatedly exited/collected by Android/WebView, after which every WebSocket in
that document dies with `code=1006`, the persisted session materializes, and
reconnect is the correct reaction. `missing-socket` and `tick-blocked-by-reconnect`
are downstream facts, not the cause.

## Formal Fix

1. `MainActivity.java`
   - Keep `WebView.RENDERER_PRIORITY_IMPORTANT`.
   - Change `waivedWhenNotVisible` from `true` to `false`, so Android must not
     demote this WebView renderer to cached solely because it is not visible.
   - Add a native shell-only foreground marker (`activityInForeground`), set in
     `onStart`/`onStop`. This is platform visibility state, not session,
     transport, or daemon truth.
2. `BackgroundService.java`
   - In the heartbeat wake runnable, skip `evaluateJavascript()` while
     `MainActivity.isActivityInForeground()` is true.
   - Keep the foreground service, notification, `PARTIAL_WAKE_LOCK`, and
     background wake cadence unchanged.
3. `android-power-policy.test.ts`
   - Lock the renderer policy to not waive visibility.
   - Lock the native wake to foreground-skip.

## Test Design

- Positive: MainActivity keeps `RENDERER_PRIORITY_IMPORTANT` and passes
  `false` for waived-when-not-visible.
- Positive: BackgroundService only calls `evaluateJavascript()` when the
  Activity is not foreground.
- Negative: no transport reconnect code, heartbeat threshold, route health,
  daemon, buffer, renderer, or network policy is changed.

## Live Verification

1. Build and install a new debug APK without data wipe.
2. `dumpsys activity oom` must show the zterm-bound WebView renderer no longer
   `CACC / 900` while zterm is foreground; expected `IMPORTANT`/non-cached.
3. Repeated HOME -> foreground rounds must keep the same renderer PID, CDP
   target, and `performance.timeOrigin`.
4. No same-document three-socket `code=1006` burst and no daemon transport
   close tied to renderer exit while the Activity is only briefly backgrounded.
5. Real retained session returns to foreground with physical transport
   unchanged and terminal body refreshable.

## Debounce Decision

No reconnect debounce is added in this design. Existing reconnect already
dedupes with `reconnectStore`, exponential backoff, and
`tick-blocked-by-reconnect`. The observed reconnect follows genuine renderer
death; adding a debounce on top would delay real recovery or mask the first
divergence. If live verification still shows reconnect while the same physical
socket is OPEN and the renderer is stable, a separate Fix Design must record
that evidence before changing reconnect policy.
