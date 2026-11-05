# Delivery: V1 app-messaging 公开持久化 facade

## Public import specifier 与 export
- Package: `@zterm/android` (private workspace package)
- Specifier: `@zterm/android/app-messaging-persistence`
- export map (`android/package.json`):
  `"./app-messaging-persistence": "./src/server/daemon-app-messaging-public.ts"`

## Exact public types
```ts
export type DeliveryRef = {
  sourceMachineId: string; workspaceId: string;
  actorAccountId: string; requestId: string;
};
export type DeliveryTarget = {
  memberId: string; machineId: string; bindingGeneration: number;
};
export type DurableStage = 'accepted' | 'remote-stored' | 'host-delivered' | 'consumed';
export type ReceiptOutcome = 'pending' | 'confirmed' | 'unknown' | 'rejected' | 'failed';
export type MessageContent = { subject?: string; body: string };
export type Receipt = {
  deliveryRef: DeliveryRef; target: DeliveryTarget;
  durableStage: DurableStage; outcome: ReceiptOutcome;
  errorRef?: string; observedAt: string;
};
export type ReceiptObservation = {
  receipt?: Receipt;
  freshness: 'fresh' | 'stale' | 'unavailable';
  observedAt: string;
};
export type AcceptMessageCommand = {
  deliveryRef: DeliveryRef; target: DeliveryTarget;
  kind: 'message'; message: MessageContent;
};
export type AcceptMessageResult =
  | { kind: 'created'; receipt: Receipt }
  | { kind: 'replayed'; receipt: Receipt }
  | { kind: 'target-binding-stale' }
  | { kind: 'conflict' }
  | { kind: 'dedupe-window-expired' }
  | { kind: 'rejected-before-write'; errorRef: string }
  | { kind: 'acceptance-unknown'; errorRef: string; errorChain: ControlErrorChain };
// ControlErrorChain 来自 @zterm/shared/terminal/control-contract，首帧 source=daemon-app-messaging-public|store，后续帧沿 cause 展开。
export type ReadReceiptResult =
  | { kind: 'found'; observation: ReceiptObservation & { receipt: Receipt } }
  | { kind: 'not-found' }
  | { kind: 'unavailable'; errorRef: string; errorChain: ControlErrorChain };
export interface ReceiptStore {
  acceptMessage(command: AcceptMessageCommand): Promise<AcceptMessageResult>;
  readReceipt(ref: DeliveryRef): Promise<ReadReceiptResult>;
}
export function createAppMessagingPersistence(options: {
  appRootDir: string; now?: () => number;
  maxInboxRecords?: number; maxInboxBytes?: number; dedupeWindowMs?: number;
}): ReceiptStore;
```

## Consumer 调用与结果
- 调用：`import { createAppMessagingPersistence } from '@zterm/android/app-messaging-persistence'`
- 真实 temp root 下 `acceptMessage` → `created`（`durableStage: accepted`, `outcome: pending`）；同 ref 同内容 → `replayed`（receipt 不变）。
- 不同内容/同 generation 不同 machine/不同 member → `conflict`；同 member 不同 generation → `target-binding-stale`；过期保留身份 → `dedupe-window-expired`。
- 跨 actor/workspace/source/requestId 各自独立；四元组精确 `found`/`not-found`/`unavailable`。
- 非法输入/配额上限 → `rejected-before-write`；损坏 JSON 读 → `acceptance-unknown`；子进程提交后退出、父进程重开 → `found` + `replayed`（post-commit response loss）。

## 隔离持久化 / 重启证据
- V2 记录在 `<appRootDir>/app-delivery/records/<source>/<workspace>/<actor>/<requestId>/record.json`；legacy 记录路径与 cleanup 不扫该空间。
- `atomicWriteJson` + `runExclusive` 复用；`admitDeliveryRecord` 复用 `computeInboxUsage` 上限。
- 真实 temp root、fresh-process reopen、子进程提交后父进程重开均见 `public-consumer-blackbox.mjs`。

## 错误原因保留
- `acceptance-unknown` / `unavailable` 现在附带 `errorChain: ControlErrorChain`（来自既有 `@zterm/shared/terminal/control-contract` owner），首帧 `code/source/message` 引用实际抛出错误，后续帧沿 `cause` 展开真实 I/O/parse 原因。
- `createAppMessagingPersistence` 接受可选 `errorReporter`，每个捕获错误上报 `{ errorRef, operation, chain }`；`errorRef` 为该次上报记录的稳定引用，下游可据 `errorRef` 向同一 reporter 取得原原因。未新建错误中心/日志真源/持久表。
- `rejected-before-write` 的固定 `invalid-command`/`inbox-full` 语义与既有契约保持不变。

## 剩余缺口
- 根 pnpm 安装未把 private `@zterm/android` 链入消费方 `node_modules`；Jenny/David 集成时需把 `@zterm/android` 作为 workspace 依赖加入 delivery adapter 的包，specifier 才可直接解析。本次黑盒用显式 workspace link 证明 export 本身可用。
- 本次只交付 V1 durable facade；V2 auth/routing/network delivery/E2E 仍由 delivery 模块与 Jenny 负责，未在此伪造。
- cross-process 并发未做文件锁；V1 daemon 单 writer + `runExclusive` 是当前序列化边界。

## 唯一 writer 边界
- 唯一持久层 owner：`DaemonAppMessagingStore`（`android/src/server/daemon-app-messaging-store.ts`）。
- 唯一公开 facade：`android/src/server/daemon-app-messaging-public.ts`。
- 本次未改 runtime wire 协议、未新建第二套 store；后续 delivery adapter 只消费公开 facade，不复制持久层。
