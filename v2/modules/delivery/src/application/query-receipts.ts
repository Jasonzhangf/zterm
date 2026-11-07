import type {
  DeliveryRef,
  Receipt,
  ReceiptObservation,
} from "../domain/receipt.ts";
import type {
  DeliveryDependencies,
  ReceiptQueryAuthorizationResult,
} from "../ports/dependencies.ts";
import type { QueryResult } from "../public/delivery-port.ts";
import { chainFromException } from "./error-chain.ts";

const READ_UNAVAILABLE_EXCEPTION =
  "delivery.persistence.read-unavailable";
const AUTHORIZATION_QUERY_UNAVAILABLE_EXCEPTION =
  "delivery.authorization.query-unavailable";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidDeliveryRef(ref: DeliveryRef): boolean {
  return (
    typeof ref === "object" &&
    ref !== null &&
    isNonEmptyString(ref.sourceMachineId) &&
    isNonEmptyString(ref.workspaceId) &&
    isNonEmptyString(ref.actorAccountId) &&
    isNonEmptyString(ref.requestId)
  );
}

function freezeDeliveryRef(deliveryRef: DeliveryRef): DeliveryRef {
  return Object.freeze({
    sourceMachineId: deliveryRef.sourceMachineId,
    workspaceId: deliveryRef.workspaceId,
    actorAccountId: deliveryRef.actorAccountId,
    requestId: deliveryRef.requestId,
  });
}

function freezeReceipt(receipt: Receipt): Receipt {
  const copy: {
    deliveryRef: DeliveryRef;
    target: Receipt["target"];
    durableStage: Receipt["durableStage"];
    outcome: Receipt["outcome"];
    v1MessageId?: string;
    errorRef?: string;
    observedAt: string;
  } = {
    deliveryRef: freezeDeliveryRef(receipt.deliveryRef),
    target: Object.freeze({
      memberId: receipt.target.memberId,
      machineId: receipt.target.machineId,
      bindingGeneration: receipt.target.bindingGeneration,
    }),
    durableStage: receipt.durableStage,
    outcome: receipt.outcome,
    observedAt: receipt.observedAt,
  };
  if (receipt.v1MessageId !== undefined) {
    copy.v1MessageId = receipt.v1MessageId;
  }
  if (receipt.errorRef !== undefined) {
    copy.errorRef = receipt.errorRef;
  }
  return Object.freeze(copy);
}

function freezeObservation(
  observation: ReceiptObservation & { receipt: Receipt },
): ReceiptObservation & { receipt: Receipt } {
  return Object.freeze({
    receipt: freezeReceipt(observation.receipt),
    freshness: observation.freshness,
    observedAt: observation.observedAt,
  });
}

export async function queryReceipt<AuthContext, TargetAddress>(
  dependencies: DeliveryDependencies<AuthContext, TargetAddress>,
  actor: AuthContext,
  ref: DeliveryRef,
): Promise<QueryResult> {
  if (!isValidDeliveryRef(ref)) {
    return { kind: "invalid" };
  }

  const exactRef = freezeDeliveryRef(ref);
  let authorization: ReceiptQueryAuthorizationResult;
  try {
    authorization =
      await dependencies.authorization.authorizeReceiptQuery(
        actor,
        exactRef,
      );
  } catch (error) {
    return {
      kind: "unavailable",
      errorRef: AUTHORIZATION_QUERY_UNAVAILABLE_EXCEPTION,
      errorChain: chainFromException("authorize", error),
    };
  }
  if (authorization.kind === "denied") {
    return {
      kind: "denied",
      errorRef: authorization.errorRef,
    };
  }
  if (authorization.kind === "unavailable") {
    return {
      kind: "unavailable",
      errorRef: authorization.errorRef,
    };
  }

  try {
    const result =
      await dependencies.receiptStore.readReceipt(exactRef);
    if (result.kind === "found") {
      return {
        kind: "found",
        observation: freezeObservation(result.observation),
      };
    }
    if (result.kind === "not-found") {
      return { kind: "not-found" };
    }
    return {
      kind: "unavailable",
      errorRef: result.errorRef,
      ...(result.errorChain === undefined
        ? {}
        : { errorChain: result.errorChain }),
    };
  } catch (error) {
    return {
      kind: "unavailable",
      errorRef: READ_UNAVAILABLE_EXCEPTION,
      errorChain: chainFromException("read", error),
    };
  }
}
