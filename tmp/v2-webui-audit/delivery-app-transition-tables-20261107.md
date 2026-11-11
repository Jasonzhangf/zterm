# Delivery /app transition tables

Owner: Emma (read-only verification, task `delivery-app-transition-tables-1107`)
Date: 2026-11-07
Status: read-only; no product source changed.

Purpose: supply the concrete request/result mapping table required by David's approved decision at `tmp/v2-webui-audit/delivery-app-contract-decision-20261107.md` before `delivery-production-dispatch-1107` implementation.

## Evidence sources

- Design prerequisite: `tmp/v2-webui-audit/delivery-app-contract-decision-20261107.md` (David, 2026-11-07)
- V1 send-surface probe: `/Volumes/Intel/playground/zterm/.worker-runs/delivery-production-dispatch-1107/v1-send-probe/result.md`
- V1 wire protocol owner: `packages/shared/src/connection/app-protocol.ts`
- V1 daemon app messaging runtime: `android/src/server/daemon-app-messaging-runtime.ts`
- V1 persistence facade: `android/src/server/daemon-app-messaging-public.ts` and `android/src/server/daemon-app-messaging-store.ts`
- V2 delivery public port/domain: `v2/modules/delivery/src/public/delivery-port.ts`, `v2/modules/delivery/src/domain/receipt.ts`, `v2/modules/delivery/src/application/submit-message.ts`
- V2 connections current surface: `v2/modules/connections/src/public/link-port.ts`, `v2/modules/connections/src/adapters/app-websocket.ts`, `v2/modules/connections/src/ports/accounts-authorization.ts`, `v2/modules/connections/OBSERVATION.md`

---

## Table 1: V2 optional subject to V1 required subject

V1 `app-send-message` payload requires `subject: string`; validation is `requiredString(payload.subject, 'subject', 'send-message')`, which rejects missing, non-string, empty, and whitespace-only values (`app-protocol.ts` `validateAppClientFrame`, `requiredString`).

V2 `MessageContent.subject` is optional (`v2/modules/delivery/src/domain/receipt.ts`), and the V2 persistence record keeps it optional (`daemon-app-messaging-public.ts` `MessageContent`, `AppDeliveryRecord.subject?`).

| V2 input | V1 wire subject | Rule | Evidence |
|---|---|---|---|
| `message.subject` present as non-empty string | same value | pass through unchanged | `app-protocol.ts` `requiredString`; V1 runtime `sameMessageContent` compares `record.subject === payload.subject` |
| `message.subject` present as empty string/whitespace | invalid | reject before send (`INVALID_INPUT`) | `validateAppClientFrame` rejects; V2 `isValidMessage` allows present-subject string but must not silently repair |
| `message.subject` absent | `APP_DEFAULT_SUBJECT` constant (new shared constant, e.g. `'(no subject)'`) | adapter fills deterministic constant at wire build time; never derives from body/requestId and never truncates | needed because V1 has no optional-subject wire form |
| `message.subject` absent, persisted record | keep absent in V2 receipt/record | default applied only at wire boundary, so `sameContent`/dedupe still compares real semantic content | `daemon-app-messaging-public.ts` `subjectOf` preserves presence |
| V1 file transfer fallback | `subject` optional in CLI; CLI uses `''` | out of scope (file transfer is a separate dependency) | `packages/cli/src/commands/app-messaging.ts` `send-file` `optionalFlag ?? ''` |

Default policy (recommended, pending owner sign-off): add one shared constant in `packages/shared/src/connection/app-protocol.ts`, export it, and have the future connections `/app` message adapter fill it only when the V2 subject is absent. Do not synthesize a semantic subject from body or peer name. This keeps the wire contract required while preserving the V2 semantic “no subject” in durable records.

---

## Table 2: V1 `app-send-result` status/stage -> V2 receipt stage/outcome

V2 durable stages: `accepted < remote-stored < host-delivered < consumed`; outcomes: `pending | confirmed | unknown | rejected | failed` (`v2/modules/delivery/src/domain/receipt.ts`). V1 response shape: `AppSendResultPayload { status, stage }` where `status` is `received | delivered | consumed | rejected | resultUnknown | unreachable | receiving`, and `stage` is `prepared | sent | received | result_unknown`.

| V1 status | V1 stage | V2 durableStage | V2 outcome | Evidence/rule |
|---|---|---|---|---|
| `received` | `received` | `remote-stored` | `confirmed` | strong evidence: target daemon persisted inbox (`daemon-app-messaging-runtime.ts` `receiveMessage` returns `received`, peer responds status `received`; V1 outbox state `received` short-circuits resend) |
| `received` | `prepared`/`sent` | `accepted` | `unknown` | transport write alone is not remote persistence; no strong evidence |
| `delivered` | `received` | `host-delivered` | `confirmed` | protocol-confirmed ack state; current send-result runtime never emits `delivered` for messages (only `received`), so implementation must not fabricate it |
| `consumed` | `received` | `consumed` | `confirmed` | protocol-confirmed consume; current runtime never emits `consumed` in send-result; must only be applied from a trusted host/consume evidence |
| `rejected` | any | keep current stage | `rejected` | target rejected inbox (content/message-id conflict, inbox full, etc.), with errorRef from `AppProtocolError.code` |
| `resultUnknown` / `unreachable` | `sent` / `result_unknown` | keep current stage | `unknown` | possible write after send; never proven unsent; David rule 6 |
| `receiving` | `prepared` | not applicable | not applicable | file-transfer-only staging; message path must not use it |
| any status | `received` + app-ack/consume confirmations | see above | see above | app-ack/consume are separate `app-status-result` frames (`daemon-app-messaging-runtime.ts` `settleLocalState`); map through existing receipt evidence owner, not a guessed `consumed` |

Existing weak evidence kinds `v1-delivered`, `app-ack`, `unverified-consumption` remain non-strong and are ignored by `applyReceiptEvidence` (`daemon-app-messaging-public.ts`, `domain/receipt.ts`). They must not raise a stage.

---

## Table 3: Authenticated remote daemon identity canonical source and owner

The wire peer identity is `AppTarget.daemonHostId` plus `deviceId` (`app-protocol.ts` `AppTarget`, `AppReadyPayload`). When a daemon opens a peer `/app` connection it sends `app-hello` with its own configured `deviceId`/`daemonHostId` and then verifies the target's `app-ready` payload matches `{deviceId, daemonHostId}` (`daemon-app-messaging-runtime.ts` `connectPeerCandidate`, lines ~490-526). The V2 connections module already carries the same concept in `AuthorizedMachineLink` (`v2/modules/connections/src/ports/accounts-authorization.ts`): `machineId`, `daemonHostId`, target/settings produced by the accounts authorization port.

| Field | Canonical source | Owner | Proof on wire |
|---|---|---|---|
| remote `daemonHostId` | accounts authorization result for the machine (`AuthorizedMachineLink.daemonHostId`), persisted from machine registration/relay endpoints | `accounts` | `app-ready.payload.daemonHostId` must equal the authorized value; mismatch rejected (`peer_identity_mismatch`) |
| remote `deviceId` | accounts machine record/device registration | `accounts` | `app-ready.payload.deviceId` must equal target `deviceId` |
| validation during handshake | `connections` adapter/runtime | `connections` | reject mismatch, never fall back to unverified identity; `LinkObservation.peerIdentityVerified` reflects proof |
| target resolution into delivery command | routing/authorization ports consumed by delivery | `delivery` (consumer only) | `DeliveryTarget.memberId/machineId/bindingGeneration`; delivery never owns or invents `daemonHostId` |

No V2 `message` channel currently exists (`v2/modules/connections/src/adapters/app-websocket.ts` is codec-only; `v1-traversal.ts` advertises terminal mux only and rejects message/file/receipt/status as unsupported), so identity verification at the `/app` message edge is not yet implemented in V2. The future `requestMessage` on the connections public port must enforce the same `app-ready` daemonHostId/deviceId check and require the current link generation before sending.

---

## Open items for owners

1. Default subject constant name/value in `packages/shared` needs David/Jenny sign-off.
2. No subject length/UTF-8 byte limit exists on the V1 wire other than non-empty string; check whether a byte budget should be shared (the 191-byte identity limit does not apply to subject).
3. Persisted V1 `messageId` allocation (UUID in accept transaction per David rule 4) is not yet in `AppDeliveryRecord`; must be added by persistence owner with `readAcceptedCommand`.
4. `connections` message channel (`requestMessage`) is not implemented; identity verification and correlation delivery depend on it.
5. `delivered`/`consumed` send-result statuses are typed but current runtime never emits them for messages; keep mapping explicit and reject fabrication.

## Changed paths

- Only this document was created: `tmp/v2-webui-audit/delivery-app-transition-tables-20261107.md`
- No product source changed; no git changes; no shared service/tmux/15T touched; no push/merge/publish/PR performed.
