# Remote Window Sender-Owned WebRTC Offer Contract

Date: 2026-08-31  
Status: Approved design; implementation pending  
Feature: `desktop.remote_window_stream`  
Owner: `daemon.remote_window_stream` (media negotiation) with
`client.remote_window_overlay` (receiver lifecycle)

## Problem and evidence

The current remote-window path is receiver-offer / daemon-answer:

```text
Android recvonly transceiver -> createOffer
  -> daemon setRemoteDescription -> addTrack -> createAnswer
```

The installed `@roamhq/wrtc@0.10.0` binding rejects `RTCRtpSender.setParameters()`
for a sender created by this `addTrack()` answerer path. The rejection occurs
for both an unchanged object returned by `getParameters()` and a fresh object
with only `maxBitrate` changed. The sender reports a transaction id, one active
encoding, `currentDirection=sendonly`, and `stopped=false`; therefore this is
not a caller-side transaction or value error.

The same binding accepts an initial `sendEncodings` list when the sender-owned
transceiver is created before the sender creates its offer. This is the only
standard WebRTC path currently evidenced for installing a bitrate/frame-rate
profile. No application code may patch the native binding or claim dynamic ABR
until the post-start `setParameters()` gate passes.

## Contract decision

Remote-window media negotiation changes to a sender-owned offer. The daemon
creates one `sendonly` transceiver per media lane with the requested initial
`sendEncodings`, creates the offer, and sends it to Android. Android creates
matching `recvonly` transceivers, applies the daemon offer, creates an answer,
and returns that answer through the existing typed control route.

The old receiver-offer / daemon-`addTrack` path is not a fallback. It is a
version-1 contract and must be physically removed after the version-2 route is
implemented and its migration gate passes. A failed v2 negotiation returns a
typed error; it never retries v1 or reports a stream as started.

## Versioned wire contract

`mediaPlanVersion` becomes `2` for this route. The business payload contains
only stream identity, target, media plan, ICE candidates, and the video profile.
Revision, retry, capability, and health facts remain in the typed control/error
chain and are not copied into SDP, video frames, or metadata.

### Start request (Android -> daemon)

```ts
interface RemoteWindowStreamStartRequestV2 {
  requestId: string;
  streamId: string;
  purpose?: RemoteWindowStreamPurpose;
  mediaPlan: RemoteWindowStreamMediaPlan;
  mediaPlanVersion: 2;
  target: RemoteWindowStreamTargetManifest;
  iceServers?: Array<Record<string, unknown>>;
  videoProfile: RemoteWindowVideoProfile;
}
```

The request has no SDP offer. The client has already declared the expected
lane count in `mediaPlan`; it does not create a local transceiver or offer.

### Started offer (daemon -> Android)

```ts
interface RemoteWindowStreamOfferV2 {
  requestId: string;
  streamId: string;
  purpose?: RemoteWindowStreamPurpose;
  mediaPlan: RemoteWindowStreamMediaPlan;
  mediaPlanVersion: 2;
  targetId: string;
  offer: RemoteWindowStreamRtcDescription;
  capture: {
    source: 'ScreenCaptureKit';
    frameWidth: number;
    frameHeight: number;
    frameRate: number;
    targetKind: 'app-window' | 'iterm2-pane';
  };
  canvasLayout?: RemoteWindowCanvasLayoutV1;
  transport: { kind: 'webrtc-video'; selectedRoute?: string };
}
```

The offer is emitted only after all lane transceivers exist and initial
`sendEncodings` have been accepted by the native binding. Capture startup may
be reported separately, but `started` is not success until the answer is
received and applied.

### Answer (Android -> daemon)

```ts
interface RemoteWindowStreamAnswerV2 {
  requestId: string;
  streamId: string;
  mediaPlanVersion: 2;
  answer: RemoteWindowStreamRtcDescription;
}
```

The answer uses a dedicated typed message, not an overloaded start request or
business input payload. The daemon accepts exactly one answer for the active
`requestId`; duplicates are idempotent and conflicting answers are explicit
errors.

### ICE ordering

- Either side may emit candidates before the remote description exists.
- Each side stores at most 32 candidates per stream and deduplicates by the
  canonical candidate fingerprint.
- Candidates are applied only after `setRemoteDescription` succeeds.
- A candidate for an unknown, closed, or superseded stream is rejected through
  the typed stream error chain.
- ICE generation is tied to `streamId` and `requestId`; an older generation
  cannot mutate the current peer.

## Sender and quality semantics

For each lane the daemon calls:

```ts
peer.addTransceiver(track, {
  direction: 'sendonly',
  streams: [laneStream],
  sendEncodings: [{
    maxBitrate: lane.maxBitrateBps,
    maxFramerate: lane.maxFrameRateFps,
  }],
});
```

The exact `sendEncodings` object is part of initial negotiation truth. The
daemon records the negotiated profile only after the answer is applied and the
sender exposes the expected encoding count and values.

Runtime quality updates have two distinct outcomes:

1. If the binding capability probe has passed for the active sender, use a
   fresh `getParameters()` result and `setParameters()` with unchanged
   encoding count/order and transaction id.
2. If the probe or update fails, return
   `remote_window_stream_quality_unsupported` with the native error chain. Do
   not retry, silently downgrade, or mark `applied`.

Capture FPS, dimensions, latest-frame age, and ScreenCaptureKit configuration
remain independently mutable. A capture-only update must not renegotiate the
peer. A sender-parameter failure must not be converted into a capture success.

## Client state machine

```text
idle
  -> start-requested
  -> offer-received
  -> answer-sent
  -> streaming
  -> stopping
  -> stopped
```

Required negative transitions:

- offer timeout -> typed `start-timeout`, terminal for that request;
- malformed/mismatched offer -> typed `offer-invalid`, peer closed;
- answer rejected -> typed `answer-rejected`, peer closed;
- stale offer/answer/ICE -> typed `generation-stale`, no state mutation;
- duplicate start/answer -> idempotent only when byte-identical, otherwise
  typed conflict;
- any failed lane -> close every lane exactly once and return one group error.

The receiver still owns Android peer lifecycle and canvas projection. It does
not own daemon offer generation, bitrate policy, capture truth, or global
coordinates.

## Daemon state machine

```text
validated
  -> lanes-created
  -> offer-created
  -> offer-published
  -> answer-accepted
  -> descriptions-applied
  -> capture-attached
  -> streaming
```

`answer-accepted` is not `streaming`. Streaming requires connected ICE,
expected lane tracks, and capture readiness. Cleanup is exactly-once for every
partial state and removes the stream generation, transceivers, capture
sources, pending ICE, and input helper ownership.

## Required implementation order

1. Add the v2 typed shared contract and message discriminants; add parser and
   validator tests before runtime changes.
2. Add daemon offer creation with one transceiver per lane and initial
   `sendEncodings`; add an answer registry keyed by `(streamId, requestId)`.
3. Change Android receiver startup to await the daemon offer, create the answer,
   and publish it through the dedicated answer route.
4. Move ICE buffering to the v2 generation owner and remove v1 offer handling.
5. Add the stock-binding gate for initial encoding, post-start dynamic
   `setParameters`, sender/receiver track delivery, and exact cleanup.
6. Remove obsolete `answer`-in-started fields and v1 code paths only after all
   v2 gates pass. No dual production path remains.

## Required verification

Positive and negative tests are paired:

- single-focus and overview-plus-focus offer/answer;
- direct and relay ICE, including early/duplicate/stale candidates;
- initial bitrate/FPS present in sender parameters;
- media tracks arrive for every required lane;
- post-start `setParameters` either applies and reads back identically or
  returns the typed unsupported error;
- malformed offer, wrong media plan, duplicate/conflicting answer,
  answer-timeout, stale generation, and partial-lane cleanup;
- no v1 retry, no silent success, no control metadata in media payload;
- feature/resource/module/edge/function/mainline registry gates;
- canonical build, Android build, installed daemon restart, real Mac route,
  real Android route, and AGY Review only after all prior gates pass.

## Non-goals

- No WebRTC source fork or native binding patch.
- No screenshot, WebSocket, or second media fallback.
- No SDP string rewriting.
- No daemon ownership of Android UI/session/zoom state.
- No claim that runtime dynamic ABR is available until the post-start gate
  produces evidence on the installed binding.
