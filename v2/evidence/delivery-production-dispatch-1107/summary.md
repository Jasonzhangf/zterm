# delivery-production-dispatch-1107 rev7 evidence

## Source revision

- Worktree: `/Volumes/Intel/playground/zterm/worktrees/delivery-production-dispatch-20261107`
- Branch: `delivery-production-dispatch-20261107`
- Candidate: branch tip (rev6 reviewed `b610b072` plus the scoped rev7
  rework); exact candidate SHA is captured by `collab task deliver`.
- Rev7 edits are committed on the candidate. No push, merge, publish,
  PR or global install was performed.
- Toolchain: node v22.22.2, tsx from `android/node_modules/.bin`.

## Changed paths

- `v2/modules/delivery/src/adapters/connections-dispatch.ts` (new)
- `v2/modules/delivery/src/public/delivery-port.ts`
- `v2/modules/delivery/src/application/resume-dispatch.ts`
- `v2/modules/delivery/src/application/submit-message.ts`
- `v2/modules/delivery/src/ports/dependencies.ts`
- `v2/modules/delivery/src/ports/receipt-store.ts`
- `v2/evidence/delivery-production-dispatch-1107/blackbox-delivery-consumer.mts`
- `v2/evidence/delivery-production-dispatch-1107/blackbox-delivery-consumer.log`
- `v2/evidence/delivery-production-dispatch-1107/summary.md`
- `result.md` (worktree root)

## Production adapter mapping

The production adapter is `createConnectionsDispatchPort`. The consumer imports
it from the delivery public surface; no inline or test-only mapping remains.

| Wire observation | Delivery result |
|---|---|
| `result` + `received` + `received` | `remote-stored` (only confirmation) |
| `result` + `delivered` / `consumed` | `unknown`, preserves stage, no invented confirmation |
| `result` + `received` + `prepared`/`sent` | `unknown`, preserves stage |
| `result` + `rejected` | `failed` with stage in error chain |
| `rejected` + `storage_error` | `unknown` with code/stage/cause |
| `rejected` + other code | `failed` with code/stage/cause |
| `unknown` (post-write loss/uncorrelated) | `unknown` with errorRef/cause |
| capability failure (omitted/empty/mismatched source) | `unavailable` |

The adapter now requires the authorized source-link machine identity from the
caller and has no unbound default. The consumer passes the real
`sourceLink.machineId`; omitted and empty identities are checked as typed
`unavailable` paths with no send. The adapter reuses the exported connections
`AppMessageRequest`/`AppMessageResult` types, so delivery owns only the mapping
and keeps no duplicate wire status/stage/error vocabulary.

## Real public consumer

`blackbox-delivery-consumer.mts` replaces the inline `startGateway` fixture with
two real isolated V1 daemon runtimes:

- source daemon local loopback `/app` gateway (bearer + identity proof),
- target daemon `/app` gateway with a real `DaemonAppMessagingStore` inbox,
- real accounts authorization port (`createAccountsAuthorizationPort`,
  `AuthService`, `MachineService`),
- real workspace authorization (`createWorkspaceAuthorization`),
- real members binding (`createMembersService` + `createBindingStore`),
- real persistence facade for accepted command/receipt.

No always-allowed authorization or fixed-target stub is used for the production
proof. Members/routing supplies `machineId`/`bindingGeneration`; `authorizeResume`
rechecks the ref scope and current generation; `DeliveryRef.sourceMachineId` is
asserted equal to the real source link. The accounts adapters are real, but
their authority/session validator and machine registry are still test
implementations; this does not claim real account login, real machine
enrollment, or two-device product readiness.

## Receipts

- `blackbox-delivery-consumer.log`: 37/37 checks.
  Run: `./android/node_modules/.bin/tsx v2/evidence/delivery-production-dispatch-1107/blackbox-delivery-consumer.mts`.
  tsx is required because the V1 runtime imports extensionless `.ts` specifiers;
  plain `node` cannot resolve them.
- `test-contract.txt`: 43/43 pass.
- `test-integration.txt`: 20/20 pass.
- `dagpipe-validate.txt`, `toolchain.txt`: candidate guard receipts unchanged
  by this rev7 edit.
- `diff-check.txt`: exit 0 for the rev7 delta.
- `diff-stat.txt`: regenerated for the rev7 delta.

## Covered contract items

- Only `received`/`received` advances to `remote-stored`.
- `delivered`/`consumed`/partial-stage confirms stay unknown with stage.
- `storage_error` and inconclusive possible-write results stay unknown with
  typed code/stage/cause.
- Definitive protocol rejection maps to failure per the approved table.
- Result-status `rejected` maps to failure with the observed stage and no
  invented error fields.
- Omitted, empty and mismatched source identities return
  `delivery.dispatch.source-mismatch` and write no send.
- Missing subject stays accepted and returns `DISPATCH_UNAVAILABLE` with
  `SUBJECT_REQUIRED` and no send.
- Real source/target V1 daemons and real target storage replace `startGateway`.
- Wrong credential, wrong workspace and stale binding are explicit refusals.
- Lost remote response then same persisted-ID resume reaches one destination
  without duplicate delivery; the already-confirmed no-send path does not
  double as that recovery proof.
