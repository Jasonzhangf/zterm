import type {
  DeliveryRef,
  DeliveryTarget,
  MessageContent,
  Receipt,
} from "../domain/receipt.ts";
import type {
  DeliveryDependencies,
  SubmissionAuthorizationResult,
  TargetResolutionResult,
} from "../ports/dependencies.ts";
import type {
  AcceptMessageCommand,
  AcceptMessageResult,
} from "../ports/receipt-store.ts";
import type {
  SubmissionResult,
} from "../public/delivery-port.ts";
import { chainFromException } from "./error-chain.ts";

const ACCEPTANCE_UNKNOWN_EXCEPTION =
  "delivery.persistence.acceptance-unknown";
const AUTHORIZATION_SUBMISSION_UNAVAILABLE_EXCEPTION =
  "delivery.authorization.submit-unavailable";
const ROUTING_UNAVAILABLE_EXCEPTION =
  "delivery.routing.resolve-unavailable";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidMessage(message: MessageContent): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof message.body === "string" &&
    (message.subject === undefined || typeof message.subject === "string")
  );
}

function isValidTarget(target: DeliveryTarget): boolean {
  return (
    typeof target === "object" &&
    target !== null &&
    isNonEmptyString(target.memberId) &&
    isNonEmptyString(target.machineId) &&
    Number.isSafeInteger(target.bindingGeneration) &&
    target.bindingGeneration >= 0
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

function freezeDeliveryTarget(target: DeliveryTarget): DeliveryTarget {
  return Object.freeze({
    memberId: target.memberId,
    machineId: target.machineId,
    bindingGeneration: target.bindingGeneration,
  });
}

function freezeMessage(message: MessageContent): MessageContent {
  const copy: { subject?: string; body: string } = {
    body: message.body,
  };
  if (message.subject !== undefined) {
    copy.subject = message.subject;
  }
  return Object.freeze(copy);
}

function freezeReceipt(receipt: Receipt): Receipt {
  const copy: {
    deliveryRef: DeliveryRef;
    target: DeliveryTarget;
    durableStage: Receipt["durableStage"];
    outcome: Receipt["outcome"];
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

function mapAcceptance(result: AcceptMessageResult): SubmissionResult {
  switch (result.kind) {
    case "created":
    case "replayed":
      return {
        kind: "accepted",
        disposition: result.kind,
        receipt: freezeReceipt(result.receipt),
      };
    case "target-binding-stale":
      return { kind: "rejected", code: "TARGET_BINDING_STALE" };
    case "conflict":
      return { kind: "rejected", code: "DELIVERY_CONFLICT" };
    case "dedupe-window-expired":
      return {
        kind: "rejected",
        code: "DEDUPE_WINDOW_EXPIRED",
      };
    case "rejected-before-write":
      return {
        kind: "rejected",
        code: "REJECTED_BEFORE_WRITE",
        errorRef: result.errorRef,
      };
    case "acceptance-unknown":
      return {
        kind: "acceptance-unknown",
        errorRef: result.errorRef,
        ...(result.errorChain === undefined
          ? {}
          : { errorChain: result.errorChain }),
      };
  }
}

export async function submitMessage<AuthContext, TargetAddress>(
  dependencies: DeliveryDependencies<AuthContext, TargetAddress>,
  actor: AuthContext,
  targetAddress: TargetAddress,
  requestId: string,
  message: MessageContent,
): Promise<SubmissionResult> {
  if (!isNonEmptyString(requestId) || !isValidMessage(message)) {
    return { kind: "rejected", code: "INVALID_INPUT" };
  }

  let authorization: SubmissionAuthorizationResult;
  try {
    authorization =
      await dependencies.authorization.authorizeSubmission(
        actor,
        targetAddress,
      );
  } catch {
    return {
      kind: "rejected",
      code: "AUTHORIZATION_UNAVAILABLE",
      errorRef: AUTHORIZATION_SUBMISSION_UNAVAILABLE_EXCEPTION,
    };
  }
  if (authorization.kind === "denied") {
    return {
      kind: "rejected",
      code: "AUTHORIZATION_DENIED",
      errorRef: authorization.errorRef,
    };
  }
  if (authorization.kind === "unavailable") {
    return {
      kind: "rejected",
      code: "AUTHORIZATION_UNAVAILABLE",
      errorRef: authorization.errorRef,
    };
  }

  const { identity } = authorization;
  if (
    !isNonEmptyString(identity.sourceMachineId) ||
    !isNonEmptyString(identity.workspaceId) ||
    !isNonEmptyString(identity.actorAccountId)
  ) {
    return { kind: "rejected", code: "INVALID_INPUT" };
  }

  let resolution: TargetResolutionResult;
  try {
    resolution = await dependencies.routing.resolveTarget({
      workspaceId: identity.workspaceId,
      targetAddress,
    });
  } catch {
    return {
      kind: "rejected",
      code: "ROUTING_UNAVAILABLE",
      errorRef: ROUTING_UNAVAILABLE_EXCEPTION,
    };
  }
  if (resolution.kind === "not-found") {
    return {
      kind: "rejected",
      code: "TARGET_NOT_FOUND",
      errorRef: resolution.errorRef,
    };
  }
  if (resolution.kind === "ambiguous") {
    return {
      kind: "rejected",
      code: "TARGET_AMBIGUOUS",
      errorRef: resolution.errorRef,
    };
  }
  if (resolution.kind === "unavailable") {
    return {
      kind: "rejected",
      code: "ROUTING_UNAVAILABLE",
      errorRef: resolution.errorRef,
    };
  }
  if (!isValidTarget(resolution.target)) {
    return { kind: "rejected", code: "INVALID_TARGET" };
  }

  const command: AcceptMessageCommand = Object.freeze({
    deliveryRef: freezeDeliveryRef({
      sourceMachineId: identity.sourceMachineId,
      workspaceId: identity.workspaceId,
      actorAccountId: identity.actorAccountId,
      requestId,
    }),
    target: freezeDeliveryTarget(resolution.target),
    kind: "message",
    message: freezeMessage(message),
  });

  let result: AcceptMessageResult;
  try {
    result = await dependencies.receiptStore.acceptMessage(command);
  } catch (error) {
    return {
      kind: "acceptance-unknown",
      errorRef: ACCEPTANCE_UNKNOWN_EXCEPTION,
      errorChain: chainFromException("accept", error),
    };
  }
  return mapAcceptance(result);
}
