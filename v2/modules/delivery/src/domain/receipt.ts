export type DurableStage =
  | "accepted"
  | "remote-stored"
  | "host-delivered"
  | "consumed";

export type ReceiptOutcome =
  | "pending"
  | "confirmed"
  | "unknown"
  | "rejected"
  | "failed";

export interface DeliveryRef {
  readonly sourceMachineId: string;
  readonly workspaceId: string;
  readonly actorAccountId: string;
  readonly requestId: string;
}

export interface DeliveryTarget {
  readonly memberId: string;
  readonly machineId: string;
  readonly bindingGeneration: number;
}

export interface MessageContent {
  readonly subject?: string;
  readonly body: string;
}

export interface Receipt {
  readonly deliveryRef: DeliveryRef;
  readonly target: DeliveryTarget;
  readonly durableStage: DurableStage;
  readonly outcome: ReceiptOutcome;
  readonly errorRef?: string;
  readonly observedAt: string;
}

export interface ReceiptObservation {
  readonly receipt?: Receipt;
  readonly freshness: "fresh" | "stale" | "unavailable";
  readonly observedAt: string;
}

export type ReceiptEvidence = Readonly<
  {
    deliveryRef: DeliveryRef;
    target: DeliveryTarget;
    observedAt: string;
  } & (
    | { kind: "remote-stored" | "host-delivered" | "consumed" }
    | { kind: "unknown" | "rejected" | "failed"; errorRef: string }
    | {
        kind: "v1-delivered" | "app-ack" | "unverified-consumption";
      }
  )
>;

export type ReceiptEvidenceResult =
  | { readonly kind: "applied"; readonly receipt: Receipt }
  | { readonly kind: "ignored"; readonly receipt: Receipt }
  | { readonly kind: "identity-mismatch" };

const stageRank: Readonly<Record<DurableStage, number>> = Object.freeze({
  accepted: 0,
  "remote-stored": 1,
  "host-delivered": 2,
  consumed: 3,
});

function requireNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`${name} must be a non-empty string`);
  }
}

function assertDeliveryRef(deliveryRef: DeliveryRef): void {
  requireNonEmptyString(deliveryRef.sourceMachineId, "sourceMachineId");
  requireNonEmptyString(deliveryRef.workspaceId, "workspaceId");
  requireNonEmptyString(deliveryRef.actorAccountId, "actorAccountId");
  requireNonEmptyString(deliveryRef.requestId, "requestId");
}

function assertDeliveryTarget(target: DeliveryTarget): void {
  requireNonEmptyString(target.memberId, "memberId");
  requireNonEmptyString(target.machineId, "machineId");
  if (
    !Number.isSafeInteger(target.bindingGeneration) ||
    target.bindingGeneration < 0
  ) {
    throw new RangeError(
      "bindingGeneration must be a nonnegative safe integer",
    );
  }
}

function freezeDeliveryRef(deliveryRef: DeliveryRef): DeliveryRef {
  assertDeliveryRef(deliveryRef);
  return Object.freeze({
    sourceMachineId: deliveryRef.sourceMachineId,
    workspaceId: deliveryRef.workspaceId,
    actorAccountId: deliveryRef.actorAccountId,
    requestId: deliveryRef.requestId,
  });
}

function freezeDeliveryTarget(target: DeliveryTarget): DeliveryTarget {
  assertDeliveryTarget(target);
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
    errorRef?: string;
    observedAt: string;
  } = {
    deliveryRef: freezeDeliveryRef(receipt.deliveryRef),
    target: freezeDeliveryTarget(receipt.target),
    durableStage: receipt.durableStage,
    outcome: receipt.outcome,
    observedAt: receipt.observedAt,
  };
  if (receipt.errorRef !== undefined) {
    copy.errorRef = receipt.errorRef;
  }
  return Object.freeze(copy);
}

function sameDeliveryRef(left: DeliveryRef, right: DeliveryRef): boolean {
  return (
    left.sourceMachineId === right.sourceMachineId &&
    left.workspaceId === right.workspaceId &&
    left.actorAccountId === right.actorAccountId &&
    left.requestId === right.requestId
  );
}

function sameDeliveryTarget(
  left: DeliveryTarget,
  right: DeliveryTarget,
): boolean {
  return (
    left.memberId === right.memberId &&
    left.machineId === right.machineId &&
    left.bindingGeneration === right.bindingGeneration
  );
}

function isStrongEvidence(
  evidence: ReceiptEvidence,
): evidence is ReceiptEvidence & {
  kind: "remote-stored" | "host-delivered" | "consumed";
} {
  return (
    evidence.kind === "remote-stored" ||
    evidence.kind === "host-delivered" ||
    evidence.kind === "consumed"
  );
}

export function createAcceptedReceipt(
  deliveryRef: DeliveryRef,
  target: DeliveryTarget,
  observedAt: string,
): Receipt {
  requireNonEmptyString(observedAt, "observedAt");
  return freezeReceipt({
    deliveryRef,
    target,
    durableStage: "accepted",
    outcome: "pending",
    observedAt,
  });
}

export function applyReceiptEvidence(
  receipt: Receipt,
  evidence: ReceiptEvidence,
): ReceiptEvidenceResult {
  if (
    !sameDeliveryRef(receipt.deliveryRef, evidence.deliveryRef) ||
    !sameDeliveryTarget(receipt.target, evidence.target)
  ) {
    return { kind: "identity-mismatch" };
  }

  if (isStrongEvidence(evidence)) {
    if (stageRank[evidence.kind] <= stageRank[receipt.durableStage]) {
      return { kind: "ignored", receipt };
    }
    return {
      kind: "applied",
      receipt: freezeReceipt({
        deliveryRef: receipt.deliveryRef,
        target: receipt.target,
        durableStage: evidence.kind,
        outcome: "confirmed",
        observedAt: evidence.observedAt,
      }),
    };
  }

  if (
    evidence.kind === "unknown" ||
    evidence.kind === "rejected" ||
    evidence.kind === "failed"
  ) {
    return {
      kind: "applied",
      receipt: freezeReceipt({
        deliveryRef: receipt.deliveryRef,
        target: receipt.target,
        durableStage: receipt.durableStage,
        outcome: evidence.kind,
        errorRef: evidence.errorRef,
        observedAt: evidence.observedAt,
      }),
    };
  }

  return { kind: "ignored", receipt };
}
