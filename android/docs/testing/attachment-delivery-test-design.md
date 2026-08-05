# Attachment Delivery Test Design

## Scope

Feature `daemon.attachment_delivery` owns image attachment enqueueing, durable outbox state, per-device delivery state, preview/original integrity, and 48-hour cleanup. Terminal session payloads and terminal mux channels are out of scope.

## Lifecycle

`Agent API -> atomic outbox write -> attachment-available projection -> per-device sync -> preview pull -> original pull -> device receipt -> expiry cleanup`.

The push event is only a control-plane wake-up. The durable attachment manifest and per-device delivery records are the truth used by reconnect and sync.

## Required Tests

- enqueue creates one durable attachment and one delivery record per explicit target device; broadcast uses a creation-time target snapshot
- duplicate `clientRequestId` returns the existing attachment without creating a second payload
- preview and original have independent hashes and delivery receipts
- one device acknowledging an attachment does not remove it for another device
- a missed push is recoverable from sync while the attachment is inside the 48-hour TTL
- expired attachments are no longer readable and are removed by cleanup
- invalid target, mime type, size, checksum, and path input fails explicitly
- interrupted writes do not publish a partial manifest

## Verification Layers

- white-box: `src/server/attachment-delivery-runtime.test.ts`
- HTTP module black-box: `src/server/terminal-http-runtime.attachment.test.ts`
- project gates: feature/resource/module/import/mainline truth tests and daemon server tests
- live gap: Android client control-plane auto-sync and thumbnail UI are a subsequent adjacent slice

## Non-goals

This slice does not add attachment state to terminal business payloads, does not make one global delivered flag, and does not automatically download original images on the client.
