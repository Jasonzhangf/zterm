# Evidence: V1 app-messaging 公开持久化 facade

## Changed paths
- `android/package.json`：新增 `"exports": { "./app-messaging-persistence": "./src/server/daemon-app-messaging-public.ts" }`。
- `android/src/server/daemon-app-messaging-store.ts`：新增 `AppDeliveryRef/AppDeliveryTarget/AppDeliveryStage/AppDeliveryOutcome/AppDeliveryRecord`，`deliveryRoot` 与 `deliveryRecordPath/writeDeliveryRecord/readDeliveryRecord/listDeliveryRecords/computeDeliveryUsage/admitDeliveryRecord/removeDeliveryRecord`，复用 `runExclusive`/`atomicWriteJson`/`AppStoreError`。legacy 路径不变，`cleanupRetention` 不扫 V2。
- `android/src/server/daemon-app-messaging-public.ts`：`createAppMessagingPersistence`，公开 `AcceptMessageCommand/AcceptMessageResult/ReadReceiptResult/ReceiptStore/AppMessagingPersistence` 类型。
- `android/src/server/daemon-app-messaging-public.test.ts`：13 个契约测试（isolation/replay/conflict/stale/subject absent-vs-empty/rejected/expiry/read side-effect/restart/error cause 保留与 reporter 回指）。
- `/v2/evidence/zterm-v1-app-messaging-persistence-1103/public-consumer-blackbox.mjs`：真实 package-specifier consumer。

## Public import specifier
`@zterm/android/app-messaging-persistence`

导出：
```ts
export function createAppMessagingPersistence(options: AppMessagingPersistenceOptions): AppMessagingPersistence
export type { DeliveryRef, DeliveryTarget, AcceptMessageCommand, AcceptMessageResult, ReadReceiptResult, Receipt, ReceiptObservation, MessageContent, ReceiptStore }
```

## Exact commands and outcomes
### Red (missing-code) on workspace 2
`node /workspaces/1/node_modules/.pnpm/vitest@1.6.1_*/node_modules/vitest/vitest.mjs run src/server/daemon-app-messaging-public.test.ts --reporter dot`
Original error: `Error: Failed to load url ./daemon-app-messaging-public ... Does the file exist?`
Outcome: 1 failed suite, 0 tests.

### Green contract on workspace 59
`pnpm exec vitest run src/server/daemon-app-messaging-public.test.ts --reporter dot`：1 passed, 13 passed。

### Error cause retention blackbox
`/tmp/zterm-consumer59` 真实 package-specifier import（`@zterm/android` 链接到本分支），temp root，坏 JSON 读：`error-chain-blackbox-ok ref=delivery.read.unknown#1 chainLen=1`。公开 facade 的 `errorReporter` 收到同一 `errorRef` 与 `chain`，首帧保留实际 parse message，`unknown/unavailable` 判定不变。

### Legacy regression on workspace 3
`vitest run src/server/daemon-app-messaging-store.test.ts src/server/daemon-app-messaging-runtime.test.ts src/server/daemon-app-messaging-race.test.ts src/server/daemon-app-messaging-transport.test.ts --reporter dot`
Outcome: 4 passed files, 40 passed tests.

### Final head green on workspace 59
5 files, 53 passed tests (13 facade + 40 legacy).

### Public consumer on workspace 6
Real package-specifier import in `/tmp/zterm-consumer6/node_modules/@zterm/android` symlink to the branch, real temp root:
`node consumer.mjs` → `facade-blackbox-ok root=/tmp/zterm-v1-facade-blackbox-9ZsCq2`
Verifies created/replayed/conflict/stale/isolation/not-found/unavailable/rejected-before-write/full quota/pre-write and post-commit response-loss recovery, corrupt read → acceptance-unknown, child-process fresh reopen → found + replayed.

### Type check on workspace 59
`pnpm exec tsc --noEmit -p tsconfig.json` → 0 `error TS`.

## Public boundary reality (unchanged)
The root pnpm install does not link the private `@zterm/android` package into its own node_modules; the delivery adapter (or Jenny's integration) must add `@zterm/android` as a workspace link/dependency so `@zterm/android/app-messaging-persistence` resolves through the package `exports`. The specifier itself is real via that supported `exports` map and the consumer blackbox proves it. This is the concrete export boundary the V1 owner returns for Jenny/David integration.
