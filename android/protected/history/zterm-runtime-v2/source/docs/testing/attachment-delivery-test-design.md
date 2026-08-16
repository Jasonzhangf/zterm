# Attachment Delivery Test Design

## Scope

Feature `daemon.attachment_delivery` owns image attachment enqueueing, durable outbox state, per-device delivery state, preview/original integrity, and 48-hour cleanup. Terminal session payloads and terminal mux channels are out of scope.

## Lifecycle

`Agent API -> atomic outbox write -> attachment-available projection -> per-device sync -> preview pull -> original pull -> device receipt -> expiry cleanup`.

The push event is only a control-plane wake-up. The durable attachment manifest and per-device delivery records are the truth used by reconnect and sync.

## Transport Message Ownership

`daemon.attachment_delivery` owns the four attachment transport-message projections in
`src/server/terminal-attachment-message-runtime.ts`:

- `pending-attachments-query` maps manifests to `pending-attachments`;
- `attachment-history-query` maps per-device delivery status to `attachment-history`;
- `attachment-asset-request` sends base64 `attachment-asset-data`;
- `attachment-receipt` calls the delivery owner and sends no success frame.

`terminal-message-runtime.ts` remains the physical receiving router but routes only these four
types to `terminal-attachment-message-runtime.ts`; it must not retain attachment delivery
business state or projection code. Invalid payloads fail explicitly with `invalid_payload`,
and query/read/ack failures keep their legacy error codes.

## Required Tests

- enqueue creates one durable attachment and one delivery record per explicit target device; broadcast uses a creation-time target snapshot
- duplicate `clientRequestId` returns the existing attachment without creating a second payload
- preview and original have independent hashes and delivery receipts
- one device acknowledging an attachment does not remove it for another device
- a missed push is recoverable from sync while the attachment is inside the 48-hour TTL
- expired attachments are no longer readable and are removed by cleanup
- invalid target, mime type, size, checksum, and path input fails explicitly
- interrupted writes do not publish a partial manifest
- transport pending/history/asset/receipt messages reach the attachment owner and preserve legacy wire semantics
- invalid attachment payloads fail before delivery-store access with `invalid_payload`
- attachment query/read/ack failures project explicit legacy error codes and never fake success
- the terminal message router has no direct attachment delivery store access or fallback route

## Verification Layers

- white-box: `src/server/attachment-delivery-runtime.test.ts`
- transport owner white-box: `src/server/terminal-attachment-message-runtime.test.ts`
- routing black-box: `src/server/terminal-message-runtime.test.ts`
- HTTP module black-box: `src/server/terminal-http-runtime.attachment.test.ts`
- required gate: `pnpm run test:attachment-message-delivery`
- project gates: `pnpm run test:feature-registry`, feature/resource/module/import/mainline truth tests and daemon server tests
- live gap: Android client control-plane auto-sync and thumbnail UI are a subsequent adjacent slice

## Non-goals

This slice does not add attachment state to terminal business payloads, does not make one global delivered flag, and does not automatically download original images on the client.

HTTP enqueue/read/receipt projection and transport-message query/asset/receipt projection are both physical `daemon.attachment_delivery` owners; no duplicate wire implementation may be reintroduced outside the owner.
