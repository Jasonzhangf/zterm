import { randomUUID } from 'node:crypto';
import {
  APP_ACKED_RETENTION_MS,
  APP_MAX_MESSAGE_BYTES,
  APP_MAX_PATH_IDENTITY_BYTES,
} from '@zterm/shared/app-protocol';
import {
  appendControlErrorChain,
  createControlErrorChain,
  type ControlErrorChain,
} from '@zterm/shared/terminal/control-contract';
import {
  AppStoreError,
  DaemonAppMessagingStore,
  type AppDeliveryOutcome,
  type AppDeliveryRecord,
  type AppDeliveryRef,
  type AppDeliveryStage,
  type AppDeliveryTarget,
} from './daemon-app-messaging-store.ts';

export type DeliveryRef = AppDeliveryRef;
export type DeliveryTarget = AppDeliveryTarget;
export type DurableStage = AppDeliveryStage;
export type ReceiptOutcome = AppDeliveryOutcome;

export type MessageContent = {
  readonly subject?: string;
  readonly body: string;
};

export type Receipt = {
  readonly deliveryRef: DeliveryRef;
  readonly target: DeliveryTarget;
  readonly durableStage: DurableStage;
  readonly outcome: ReceiptOutcome;
  readonly v1MessageId?: string;
  readonly errorRef?: string;
  readonly observedAt: string;
};

export type ReceiptObservation = {
  readonly receipt?: Receipt;
  readonly freshness: 'fresh' | 'stale' | 'unavailable';
  readonly observedAt: string;
};

export type AcceptMessageCommand = {
  readonly deliveryRef: DeliveryRef;
  readonly target: DeliveryTarget;
  readonly kind: 'message';
  readonly message: MessageContent;
};

export type AcceptedCommand = AcceptMessageCommand & {
  readonly v1MessageId: string;
};

export type ReadAcceptedCommandResult =
  | { readonly kind: 'found'; readonly command: AcceptedCommand }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid-input'; readonly errorRef: string }
  | {
      readonly kind: 'unavailable';
      readonly errorRef: string;
      readonly errorChain: ControlErrorChain;
    };

export type AcceptMessageResult =
  | { readonly kind: 'created'; readonly receipt: Receipt }
  | { readonly kind: 'replayed'; readonly receipt: Receipt }
  | { readonly kind: 'target-binding-stale' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'dedupe-window-expired' }
  | { readonly kind: 'rejected-before-write'; readonly errorRef: string }
  | {
      readonly kind: 'acceptance-unknown';
      readonly errorRef: string;
      readonly errorChain: ControlErrorChain;
    };

export type ReadReceiptResult =
  | {
      readonly kind: 'found';
      readonly observation: ReceiptObservation & { readonly receipt: Receipt };
    }
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'unavailable';
      readonly errorRef: string;
      readonly errorChain: ControlErrorChain;
    };

export type ReceiptEvidenceKind =
  | 'remote-stored'
  | 'host-delivered'
  | 'consumed'
  | 'unknown'
  | 'rejected'
  | 'failed'
  | 'v1-delivered'
  | 'app-ack'
  | 'unverified-consumption';

export type ReceiptEvidence = Readonly<
  {
    deliveryRef: DeliveryRef;
    target: DeliveryTarget;
    observedAt: string;
  } & (
    | { kind: 'remote-stored' | 'host-delivered' | 'consumed' }
    | { kind: 'unknown' | 'rejected' | 'failed'; errorRef: string }
    | {
        kind: 'v1-delivered' | 'app-ack' | 'unverified-consumption';
      }
  )
>;

export type ApplyReceiptEvidenceResult =
  | { readonly kind: 'applied'; readonly receipt: Receipt }
  | { readonly kind: 'ignored'; readonly receipt: Receipt }
  | { readonly kind: 'identity-mismatch' }
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'unavailable';
      readonly errorRef: string;
      readonly errorChain: ControlErrorChain;
    };

export type ReceiptEvidenceTransitionResult =
  | { readonly kind: 'applied'; readonly receipt: Receipt }
  | { readonly kind: 'ignored'; readonly receipt: Receipt }
  | { readonly kind: 'identity-mismatch' };

export type ReceiptEvidenceTransition = (
  receipt: Receipt,
  evidence: ReceiptEvidence,
) => ReceiptEvidenceTransitionResult;

export interface ReceiptStore {
  acceptMessage(command: AcceptMessageCommand): Promise<AcceptMessageResult>;
  readReceipt(ref: DeliveryRef): Promise<ReadReceiptResult>;
  readAcceptedCommand(ref: DeliveryRef): Promise<ReadAcceptedCommandResult>;
  applyReceiptEvidence(evidence: ReceiptEvidence): Promise<ApplyReceiptEvidenceResult>;
}

export type AppMessagingErrorOperation = 'accept' | 'read' | 'apply-evidence';

export type AppMessagingErrorReport = {
  readonly errorRef: string;
  readonly operation: AppMessagingErrorOperation;
  readonly chain: ControlErrorChain;
};

export type AppMessagingErrorReporter = (report: AppMessagingErrorReport) => void;

export type AppMessagingPersistenceOptions = {
  appRootDir: string;
  now?: () => number;
  maxInboxRecords?: number;
  maxInboxBytes?: number;
  dedupeWindowMs?: number;
  errorReporter?: AppMessagingErrorReporter;
};

const UTF8 = new TextEncoder();

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIdentitySegment(value: unknown): value is string {
  return isNonEmptyString(value) && UTF8.encode(value).length <= APP_MAX_PATH_IDENTITY_BYTES;
}

function isValidDeliveryRef(ref: DeliveryRef | undefined): ref is DeliveryRef {
  return typeof ref === 'object'
    && ref !== null
    && isIdentitySegment(ref.sourceMachineId)
    && isIdentitySegment(ref.workspaceId)
    && isIdentitySegment(ref.actorAccountId)
    && isIdentitySegment(ref.requestId);
}

function isValidDeliveryTarget(target: DeliveryTarget | undefined): target is DeliveryTarget {
  return typeof target === 'object'
    && target !== null
    && isNonEmptyString(target.memberId)
    && isNonEmptyString(target.machineId)
    && Number.isSafeInteger(target.bindingGeneration)
    && target.bindingGeneration >= 0;
}

function subjectOf(value: { subject?: string }): { present: boolean; value?: string } {
  if (Object.prototype.hasOwnProperty.call(value, 'subject') && value.subject !== undefined) {
    return { present: true, value: value.subject };
  }
  return { present: false };
}

function isValidMessage(message: MessageContent | undefined): message is MessageContent {
  if (typeof message !== 'object' || message === null) return false;
  if (typeof message.body !== 'string') return false;
  if (UTF8.encode(message.body).length > APP_MAX_MESSAGE_BYTES) return false;
  const subject = subjectOf(message);
  if (subject.present && typeof subject.value !== 'string') return false;
  return true;
}

function isValidEvidenceKind(kind: unknown): kind is ReceiptEvidenceKind {
  return kind === 'remote-stored'
    || kind === 'host-delivered'
    || kind === 'consumed'
    || kind === 'unknown'
    || kind === 'rejected'
    || kind === 'failed'
    || kind === 'v1-delivered'
    || kind === 'app-ack'
    || kind === 'unverified-consumption';
}

function freezeDeliveryRef(ref: DeliveryRef): DeliveryRef {
  return Object.freeze({
    sourceMachineId: ref.sourceMachineId,
    workspaceId: ref.workspaceId,
    actorAccountId: ref.actorAccountId,
    requestId: ref.requestId,
  });
}

function freezeDeliveryTarget(target: DeliveryTarget): DeliveryTarget {
  return Object.freeze({
    memberId: target.memberId,
    machineId: target.machineId,
    bindingGeneration: target.bindingGeneration,
  });
}

function freezeReceipt(receipt: Receipt): Receipt {
  const copy: {
    deliveryRef: DeliveryRef;
    target: DeliveryTarget;
    durableStage: DurableStage;
    outcome: ReceiptOutcome;
    v1MessageId?: string;
    errorRef?: string;
    observedAt: string;
  } = {
    deliveryRef: freezeDeliveryRef(receipt.deliveryRef),
    target: freezeDeliveryTarget(receipt.target),
    durableStage: receipt.durableStage,
    outcome: receipt.outcome,
    observedAt: receipt.observedAt,
  };
  if (receipt.v1MessageId !== undefined) copy.v1MessageId = receipt.v1MessageId;
  if (receipt.errorRef !== undefined) copy.errorRef = receipt.errorRef;
  return Object.freeze(copy);
}

function receiptOf(record: AppDeliveryRecord): Receipt {
  return freezeReceipt({
    deliveryRef: record.deliveryRef,
    target: record.target,
    durableStage: record.durableStage,
    outcome: record.outcome,
    ...(record.v1MessageId === undefined ? {} : { v1MessageId: record.v1MessageId }),
    ...(record.errorRef === undefined ? {} : { errorRef: record.errorRef }),
    observedAt: record.observedAt,
  });
}

function sameContent(record: AppDeliveryRecord, message: MessageContent): boolean {
  if (record.body !== message.body) return false;
  const recordSubject = subjectOf(record);
  const messageSubject = subjectOf(message);
  if (recordSubject.present !== messageSubject.present) return false;
  if (recordSubject.present && recordSubject.value !== messageSubject.value) return false;
  return true;
}

function sameDeliveryRef(left: DeliveryRef, right: DeliveryRef): boolean {
  return left.sourceMachineId === right.sourceMachineId
    && left.workspaceId === right.workspaceId
    && left.actorAccountId === right.actorAccountId
    && left.requestId === right.requestId;
}

function sameDeliveryTarget(left: DeliveryTarget, right: DeliveryTarget): boolean {
  return left.memberId === right.memberId
    && left.machineId === right.machineId
    && left.bindingGeneration === right.bindingGeneration;
}

function causeFrames(cause: unknown): readonly { code: string; message: string; source: string }[] {
  const frames: { code: string; message: string; source: string }[] = [];
  let current: unknown = cause;
  let previous: unknown = undefined;
  let depth = 0;
  while (current !== undefined && current !== null && current !== previous && depth < 8) {
    previous = current;
    depth += 1;
    const record = current as { message?: unknown; code?: unknown; cause?: unknown };
    const message = typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : String(current);
    const code = typeof record.code === 'string' && record.code.length > 0
      ? record.code
      : `cause-${depth}`;
    frames.push({ code, message, source: 'cause' });
    current = record.cause;
  }
  return frames;
}

function errorChainOf(kind: AppMessagingErrorOperation, error: unknown): ControlErrorChain {
  const record = (error === null || error === undefined
    ? { message: String(error) }
    : error) as { message?: unknown; cause?: unknown };
  const message = typeof record.message === 'string' && record.message.length > 0
    ? record.message
    : String(error);
  const baseCode = error instanceof AppStoreError ? error.code : 'unknown';
  const source = error instanceof AppStoreError
    ? 'daemon-app-messaging-store'
    : 'daemon-app-messaging-public';
  let chain = createControlErrorChain(`delivery.${kind}.${baseCode}`, message, source);
  for (const frame of causeFrames(record.cause)) {
    chain = appendControlErrorChain(chain, frame.code, frame.message, frame.source);
  }
  return chain;
}

export function createAppMessagingPersistence(
  options: AppMessagingPersistenceOptions,
  transitionReceiptEvidence: ReceiptEvidenceTransition,
): ReceiptStore {
  const store = new DaemonAppMessagingStore({
    appRootDir: options.appRootDir,
    ...(options.maxInboxRecords === undefined ? {} : { maxInboxRecords: options.maxInboxRecords }),
    ...(options.maxInboxBytes === undefined ? {} : { maxInboxBytes: options.maxInboxBytes }),
  });
  const now = options.now ?? Date.now;
  const dedupeWindowMs = options.dedupeWindowMs ?? APP_ACKED_RETENTION_MS;
  const errorReporter = options.errorReporter;
  let errorOccurrence = 0;

  const nowIso = () => new Date(now()).toISOString();

  function reportError(
    operation: AppMessagingErrorOperation,
    chain: ControlErrorChain,
  ): string {
    errorOccurrence += 1;
    const errorRef = `${chain[0].code}#${errorOccurrence}`;
    errorReporter?.({ errorRef, operation, chain });
    return errorRef;
  }

  function isExpired(record: AppDeliveryRecord): boolean {
    const acceptedAt = Date.parse(record.acceptedAt);
    return !Number.isFinite(acceptedAt) || now() - acceptedAt >= dedupeWindowMs;
  }

  return {
    async acceptMessage(command) {
      if (
        !isValidDeliveryRef(command?.deliveryRef)
        || !isValidDeliveryTarget(command?.target)
        || command?.kind !== 'message'
        || !isValidMessage(command?.message)
      ) {
        return { kind: 'rejected-before-write', errorRef: 'delivery.accept.invalid-command' };
      }

      const ref = freezeDeliveryRef(command.deliveryRef);
      const target = freezeDeliveryTarget(command.target);
      const subject = subjectOf(command.message);
      const message: MessageContent = subject.present
        ? { subject: subject.value, body: command.message.body }
        : { body: command.message.body };

      try {
        return await store.runExclusive(async () => {
          const existing = await store.readDeliveryRecord(ref);
          if (existing) {
            if (isExpired(existing)) return { kind: 'dedupe-window-expired' };
            if (existing.target.memberId !== target.memberId) return { kind: 'conflict' };
            if (existing.target.bindingGeneration !== target.bindingGeneration) {
              return { kind: 'target-binding-stale' };
            }
            if (existing.target.machineId !== target.machineId) return { kind: 'conflict' };
            if (!sameContent(existing, message)) return { kind: 'conflict' };
            return { kind: 'replayed', receipt: receiptOf(existing) };
          }

          const acceptedAt = nowIso();
          const record: AppDeliveryRecord = {
            schemaVersion: 2,
            deliveryRef: ref,
            target,
            kind: 'message',
            v1MessageId: randomUUID(),
            ...(subject.present ? { subject: subject.value } : {}),
            body: message.body,
            durableStage: 'accepted',
            outcome: 'pending',
            acceptedAt,
            observedAt: acceptedAt,
          };

          try {
            await store.admitDeliveryRecord(record, UTF8.encode(record.body).length);
          } catch (error) {
            if (error instanceof AppStoreError && error.code === 'inbox_full') {
              return { kind: 'rejected-before-write', errorRef: 'delivery.accept.inbox-full' };
            }
            throw error;
          }
          return { kind: 'created', receipt: receiptOf(record) };
        });
      } catch (error) {
        const chain = errorChainOf('accept', error);
        return { kind: 'acceptance-unknown', errorRef: reportError('accept', chain), errorChain: chain };
      }
    },

    async readReceipt(ref) {
      if (!isValidDeliveryRef(ref)) {
        return {
          kind: 'unavailable',
          errorRef: 'delivery.read.invalid-ref',
          errorChain: createControlErrorChain('delivery.read.invalid-ref', 'delivery ref is invalid', 'daemon-app-messaging-public'),
        };
      }
      try {
        const record = await store.readDeliveryRecord(freezeDeliveryRef(ref));
        if (record === null) return { kind: 'not-found' };
        return {
          kind: 'found',
          observation: {
            receipt: receiptOf(record),
            freshness: 'fresh',
            observedAt: nowIso(),
          },
        };
      } catch (error) {
        const chain = errorChainOf('read', error);
        return { kind: 'unavailable', errorRef: reportError('read', chain), errorChain: chain };
      }
    },

    async readAcceptedCommand(ref) {
      if (!isValidDeliveryRef(ref)) {
        return { kind: 'invalid-input', errorRef: 'delivery.read.invalid-ref' };
      }
      try {
        const record = await store.readDeliveryRecord(freezeDeliveryRef(ref));
        if (record === null) return { kind: 'not-found' };
        if (record.v1MessageId === undefined) {
          const chain = errorChainOf(
            'read',
            new AppStoreError('storage_inconsistent', 'accepted command is missing v1MessageId'),
          );
          return { kind: 'unavailable', errorRef: reportError('read', chain), errorChain: chain };
        }
        return {
          kind: 'found',
          command: Object.freeze({
            deliveryRef: freezeDeliveryRef(record.deliveryRef),
            target: freezeDeliveryTarget(record.target),
            kind: 'message',
            message: Object.freeze({
              ...(record.subject === undefined ? {} : { subject: record.subject }),
              body: record.body,
            }),
            v1MessageId: record.v1MessageId,
          }),
        };
      } catch (error) {
        const chain = errorChainOf('read', error);
        return { kind: 'unavailable', errorRef: reportError('read', chain), errorChain: chain };
      }
    },

    async applyReceiptEvidence(evidence) {
      if (
        typeof evidence !== 'object'
        || evidence === null
        || !isValidEvidenceKind(evidence.kind)
        || !isValidDeliveryRef(evidence.deliveryRef)
        || !isValidDeliveryTarget(evidence.target)
        || !isNonEmptyString(evidence.observedAt)
        || ('errorRef' in evidence && !isNonEmptyString(evidence.errorRef))
      ) {
        return { kind: 'identity-mismatch' };
      }

      const ref = freezeDeliveryRef(evidence.deliveryRef);
      const target = freezeDeliveryTarget(evidence.target);

      try {
        return await store.runExclusive(async () => {
          const current = await store.readDeliveryRecord(ref);
          const located = current === null
            ? await store.findDeliveryRecordByRequestId(ref.requestId)
            : current;
          if (located === null) return { kind: 'not-found' } as const;
          if (
            !sameDeliveryRef(located.deliveryRef, ref)
            || !sameDeliveryTarget(located.target, target)
          ) {
            return { kind: 'identity-mismatch' } as const;
          }

          const receipt = receiptOf(located);
          const result = transitionReceiptEvidence(receipt, {
            ...evidence,
            deliveryRef: ref,
            target,
          });

          if (result.kind === 'identity-mismatch') return { kind: 'identity-mismatch' } as const;
          if (result.kind === 'ignored') return { kind: 'ignored', receipt } as const;

          const { receipt: next } = result;
          const updated: AppDeliveryRecord = {
            schemaVersion: 2,
            deliveryRef: located.deliveryRef,
            target: located.target,
            kind: 'message',
            ...(located.v1MessageId === undefined ? {} : { v1MessageId: located.v1MessageId }),
            ...(located.subject === undefined ? {} : { subject: located.subject }),
            body: located.body,
            durableStage: next.durableStage,
            outcome: next.outcome,
            observedAt: next.observedAt,
            ...(next.errorRef === undefined ? {} : { errorRef: next.errorRef }),
            acceptedAt: located.acceptedAt,
          };
          if (next.errorRef === undefined && 'errorRef' in updated) delete updated.errorRef;
          await store.writeDeliveryRecord(updated);
          return { kind: 'applied', receipt: next };
        });
      } catch (error) {
        const chain = errorChainOf('apply-evidence', error);
        return { kind: 'unavailable', errorRef: reportError('apply-evidence', chain), errorChain: chain };
      }
    },
  };
}
