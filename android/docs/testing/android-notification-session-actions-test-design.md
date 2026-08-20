# Android Notification Session Actions Test Design

## Scope

`client.android_connection_service` notification projection owns the bounded
foreground-service notification surface. It may project connected channel
identity and a target-scoped activity pulse. It must not own terminal body,
renderer, active-tab, or transport lifecycle truth.

## Positive Tests

- A mux-ready target with a `mux-channel-opened` channel projects one action
  with its stable `targetKey + channelId` identity.
- More than three connected channels project at most three actions in stable
  target/channel order; opening or closing an unrelated channel does not
  reshuffle existing identities.
- A session action uses an explicit `MainActivity` deep link containing the
  target and channel identity, and the existing session-open owner selects the
  exact open session or exact configured host.
- A stopped-session fact pulses only the matching connected action and the
  notifier emits at most one pulse for the same idle run.
- The native pulse command round-trips through typed JSON and is dispatched
  through the Android service IPC owner.

## Negative Tests

- A desired or merely opening channel is not projected as connected.
- A closed, stale, missing, or unrelated channel cannot pulse an action.
- An unknown notification target is not silently routed to the most recent
  host; it produces an explicit projection warning.
- Activity pulses do not enter terminal channel messages, mux payloads, or
  frame metadata.
- Activity/React lifecycle changes do not create, close, or reorder physical
  transports as part of notification projection.

## Required Verification

- `src/lib/android-connection-service-commands.test.ts`
- `src/plugins/AndroidConnectionServicePlugin.test.ts`
- `src/lib/session-activity-notify.test.ts`
- `src/lib/feature-registry-truth.test.ts`
- `src/lib/module-registry-truth.test.ts`
- `src/lib/edge-registry-truth.test.ts`
- `pnpm exec tsc -p tsconfig.json --noEmit --pretty false`
- Android native unit test and Java compile when a configured JDK is present.
- Installed APK notification action/deep-link smoke on an online Android
  device; source tests and compilation do not replace this device gate.
