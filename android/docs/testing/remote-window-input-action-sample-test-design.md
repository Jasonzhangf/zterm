# Remote-window Action / Sample Gate Design

状态：design/first-slice；本文件定义最终 gate。本轮只完成 delivery metadata、Action deadline 和 immediate no-cache sample admission，完整 lifecycle union/receiver sequence gate 仍未满足。

## Gate owner

- `client.remote_window_touch_action`: gesture classifier and monotonic sample timestamp.
- `client.remote_window_input_delivery`: deadline-bound Action lane and immediate no-cache scroll lane.
- `daemon.remote_window_input_policy`: sequence, timestamp, deadline, lifecycle validation.
- `daemon.remote_window_input_apply`: fresh-sample admission and receive-side correction.

## Required positive / negative cases

### Contract separation

- positive: recognized tap/click is one `gesture-action`, not a sample stream.
- positive: recognized scroll is `scroll-action start/update/end`, not a reliable Action queue.
- negative: a terminal buffer frame, video frame, ACK, retry, or `sentAtMs` cannot satisfy `sampledAtMs`.
- negative: Action and Sample cannot share a pending cache or flush timer.

### Deadline-bound Action

- positive: fresh Action with monotonic `sampledAtMs` and valid `deadlineMs` is admitted once and ACKed.
- negative: expired Action is explicitly rejected/dropped and never replayed.
- negative: duplicate or out-of-order Action sequence is not applied twice.
- positive: lifecycle `start/end/cancel` remains bounded and end/cancel cannot wait behind stale update.

### Continuous scroll

- positive: scroll update is attempted immediately with its sample timestamp.
- positive: receiver may use start, end, and only fresh middle updates.
- negative: stale middle updates are dropped without a queue, retry, or trajectory replay.
- negative: network recovery does not replay old scroll samples.
- positive: missing middle updates do not prevent a fresh end from closing the gesture.

### Frequency isolation

- positive: gesture sample admission/dispatch cadence changes without changing video profile or terminal buffer publisher cadence.
- positive: video FPS changes without changing gesture sample timestamps or buffer publication.
- positive: terminal buffer backpressure does not create a gesture sample backlog.

## Evidence

The implementation gate must run with:

- `src/lib/remote-window-touch-action-runtime.test.ts`
- `src/lib/remote-window-message-runtime.test.ts`
- `src/server/remote-window-input-policy.test.ts`
- `src/server/remote-window-stream-daemon.test.ts`
- `src/lib/remote-window-input-action-sample-contract.test.ts`
- resource/module/edge/function/mainline registry tests
- type-check and production build
- installed emulator or real-device remote-window route

The gate must report accepted/dropped reason, gesture id, sequence, sampled time, deadline, and queue depth as debug facts only; these facts must not enter the business Action/Sample payload.
