# connections-app-send-public-edge-20261107 result

Owner: Kate. Scope: `v2/modules/connections/**` implementation and tests, plus
this evidence directory. No delivery, persistence, members, or accounts source
was changed. No merge, push, PR, publish, shared service, tmux 16906, or 15T use.

## Deliverable

The smallest connections-owned public send edge that composes the existing V1
`/app` codec and a real physical transport:

- Public entry: `createConnectionManager(...).requestMessage(channel, request)`
  returns a typed `AppMessageResult` (`result` | `rejected` | `unknown`).
- Public types: `AppMessageRequest`, `AppMessageResult` in
  `v2/modules/connections/src/public/types.ts`, re-exported from `src/index.ts`.
- Physical transport: `AppWebSocketTransport` opens the authenticated,
  bearer-protected source-daemon loopback `/app` gateway, runs the
  `app-hello`/`app-ready` handshake, proves the source daemon and device
  identity, advertises the `message` channel, and correlates one
  `app-send-message` with its `app-send-result` / `app-error`.
- Codec: `createAppCodec` validates frames against the shared app protocol
  parser; no duplicate wire types were introduced.

Fixed order inside `requestMessage`: validate channel and current link →
authorize the destination selector through `AccountsAuthorizationPort` →
build and validate the exact V1 frame → write. Authorization runs before any
wire write, so a denied or unresolved destination never reaches the socket.

## Contract compliance

- Reuses shared `AppSendMessagePayload` / `AppSendResultPayload` from
  `packages/shared/src/connection/app-protocol.ts`; the wire target is the V1
  `AppTarget` (`deviceId`, `daemonHostId`, `wsUrl`, `authToken`).
- The non-secret selector `targetMachineId` is resolved by accounts and is
  never written to the wire. The public test asserts the encoded frame contains
  neither `targetMachineId` nor the target machine id.
- Source gateway identity is proven at handshake: a mismatched `daemonHostId`
  or `deviceId` fails with `peer_identity_mismatch` and writes nothing.
- Target authorization is enforced before send: an unauthorized destination
  rejects with a typed error and `sendCount === 0`.
- Post-write close, timeout, or transport failure returns `unknown` with a
  stable `errorRef`; it never fabricates a `received` success.
- Stray or mismatched frames (wrong `requestId` or `messageId`) never settle the
  request; only the exact correlation settles it.
- A duplicate still-pending `v1MessageId` is rejected with `invalid_input` and
  no second frame is written.

## Changed paths

- `v2/modules/connections/src/adapters/app-websocket.ts` (new transport +
  `buildAppGatewayUrl`, `buildAuthorizedAppTarget`, `isAppFrameTransport`)
- `v2/modules/connections/src/application/connection-manager.ts`
  (`requestMessage`, frame mapping, pending-correlation set)
- `v2/modules/connections/src/channels/dispatch.ts` (`transportOf`)
- `v2/modules/connections/src/index.ts` (public exports)
- `v2/modules/connections/src/ports/accounts-authorization.ts` (optional
  accounts-owned `deviceId`)
- `v2/modules/connections/src/public/types.ts` (public request/result types)
- `v2/modules/connections/tests/integration/app-send-entry.test.ts` (new)
- `v2/evidence/connections-app-send-public-edge-20261107/` (this directory)

## Red-first then green receipts

- Red: `red-app-send.log`. Before the change, `AppWebSocketTransport is not a
  constructor`; all 8 app-send-entry tests failed (`Tests 8 failed (8)`).
- Green (focused): `green-app-send.log`. `app-send-entry.test.ts` 8 passed.
- Green (full module): `full-suite.log`. 63 passed, 2 skipped
  (`real-daemon.test.ts` needs a live daemon), across contract, app-send-entry,
  and real-entry suites.
- Type-check: `type-check.log`, `pnpm type-check` exit 0.

## Black-box public-entry receipt

`tests/integration/app-send-entry.test.ts` drives the public entry
(`createConnectionManager` from `src/index.ts`) against an isolated real
WebSocket `/app` gateway (`node:http` + `ws` server), not a mocked transport.
Covered: authorized source + authorized target round trip with correlated
result; source gateway wrong identity; unauthorized target with zero writes;
`app-error` protocol rejection; post-write close returning `unknown`; stray and
mismatched frames ignored; duplicate pending id rejected without a second send;
request on a closed link rejected before any write.

The accounts authorization port is the module's boundary and is injected. The
receipt exercises its gate behavior including the denial path (unauthorized
target writes nothing); connections does not own accounts authorization truth.

## Review rework repair

David's scoped review verdict
(`/Volumes/extension/code/zterm/tmp/v2-webui-audit/app-send-review-20261107-verdict.md`)
found three gaps; each is fixed in this revision:

1. App-error without a message id no longer degrades to `unknown`. A real V1
   initialization failure emits `requestId` only, so the manager now accepts
   exact `requestId` with an absent-or-matching `messageId` and retains the
   typed `code`, `stage`, and message. A protocol-rejected result still does
   not authorize delivery to mark a durable rejection.
2. The adapter no longer settles a pending request from an `app-error` that
   carries a conflicting message id; it is treated as stray exactly like the
   conflicting `app-send-result` case, so the matching result that follows can
   still settle the original request.
3. After the asynchronous target authorization the manager re-checks the exact
   open channel on the current transport, not only the physical link, so a
   channel closed while the authorization was in flight refuses with a typed
   error and writes nothing.

Focused public responder cases cover each gap:
`error-absent-id` (absent id preserves `storage_error`/`admission`),
`error-stray-then-result` (conflicting id ignored, valid result settles), and
deferred authorization + `closeChannel` + resolved authorization (typed
`link_closed` refusal with zero sends, sibling channel on the same link still
usable).

Receipts: `green-rework-repair.log` (focused `app-send-entry` 11 passed) and
`type-check-rework.log` (`pnpm type-check` exit 0). Per the review, no broader
test run or two-machine prerequisite was added.

## Not done

- No integration into `delivery-production-dispatch-1107`; the persistence
  read-back (`app-messaging-readback-public-edge-20261107`) is already accepted
  and integrated on local main, so delivery only waits for this edge to be
  reviewed and integrated before producing its `resumeDispatch` consumer
  receipt.
- `real-daemon.test.ts` remains skipped (requires a live daemon).
