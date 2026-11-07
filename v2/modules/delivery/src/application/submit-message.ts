import type {
  DeliveryRef,
  DeliveryTarget,
  MessageContent,
  Receipt,
} from "../domain/receipt.ts";
import type {
  DeliveryDependencies,
  MessageDispatchResult,
  SubmissionAuthorizationResult,
  TargetResolutionResult,
} from "../ports/dependencies.ts";
import type {
  AcceptMessageCommand,
  AcceptMessageResult,
  DeliveryErrorChain,
} from "../ports/receipt-store.ts";
import type {
  SubmissionResult,
} from "../public/delivery-port.ts";
import { recordRemoteStoredEvidence } from "./dispatch-evidence.ts";
import { chainFromException } from "./error-chain.ts";

const ACCEPTANCE_UNKNOWN_EXCEPTION =
  "delivery.persistence.acceptance-unknown";
const AUTHORIZATION_SUBMISSION_UNAVAILABLE_EXCEPTION =
  "delivery.authorization.submit-unavailable";
const ROUTING_UNAVAILABLE_EXCEPTION =
  "delivery.routing.resolve-unavailable";
const DISPATCH_UNAVAILABLE_EXCEPTION =
  "delivery.dispatch.unavailable";
const V1_MESSAGE_ID_UNAVAILABLE_EXCEPTION =
  "delivery.dispatch.v1-message-id-unavailable";
const SUBJECT_REQUIRED_REF = "SUBJECT_REQUIRED";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidMessage(message: MessageContent): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof message.body === "string" &&
    (message.subject === undefined ||
      (typeof message.subject === "string" && message.subject.length > 0))
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
  if (receipt.v1MessageId !== undefined) {
    copy.v1MessageId = receipt.v1MessageId;
  }
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

function mapDispatch(
  result: Exclude<MessageDispatchResult, { readonly kind: "remote-stored" }>,
  receipt: Receipt,
): SubmissionResult {
  switch (result.kind) {
    case "unknown":
      return {
        kind: "dispatch-unknown",
        code: "DISPATCH_UNKNOWN",
        errorRef: result.errorRef,
        receipt,
        ...(result.errorChain === undefined
          ? {}
          : { errorChain: result.errorChain }),
      };
    case "unavailable":
      return {
        kind: "dispatch-unavailable",
        code: "DISPATCH_UNAVAILABLE",
        errorRef: result.errorRef,
        receipt,
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
      kind: "routing-unavailable",
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
      kind: "routing-unavailable",
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

  const accepted = mapAcceptance(result);
  if (accepted.kind !== "accepted") {
    return accepted;
  }

  if (accepted.disposition === "replayed") {
    return accepted;
  }

  if (command.message.subject === undefined) {
    return {
      kind: "dispatch-unavailable",
      code: "DISPATCH_UNAVAILABLE",
      errorRef: SUBJECT_REQUIRED_REF,
      receipt: accepted.receipt,
    };
  }

  const v1MessageId = accepted.receipt.v1MessageId;
  if (v1MessageId === undefined) {
    return {
      kind: "dispatch-unavailable",
      code: "DISPATCH_UNAVAILABLE",
      errorRef: V1_MESSAGE_ID_UNAVAILABLE_EXCEPTION,
      receipt: accepted.receipt,
    };
  }

  let dispatch: MessageDispatchResult;
  try {
    dispatch = await dependencies.dispatch.dispatchMessage({
      deliveryRef: command.deliveryRef,
      target: command.target,
      message: command.message,
      v1MessageId,
    });
  } catch (error) {
    return {
      kind: "dispatch-unavailable",
      code: "DISPATCH_UNAVAILABLE",
      errorRef: DISPATCH_UNAVAILABLE_EXCEPTION,
      receipt: accepted.receipt,
      errorChain: chainFromException("dispatch", error),
    };
  }
  if (dispatch.kind === "remote-stored") {
    const evidence = await recordRemoteStoredEvidence(
      dependencies.receiptStore,
      accepted.receipt,
      dispatch,
    );
    if (evidence.kind === "stored") {
      return {
        kind: "accepted",
        disposition: "created",
        receipt: evidence.receipt,
      };
    }
    return {
      kind: "dispatch-unknown",
      code: "DISPATCH_UNKNOWN",
      errorRef: evidence.errorRef,
      receipt: evidence.receipt,
      ...(evidence.errorChain === undefined
        ? {}
        : { errorChain: evidence.errorChain }),
    };
  }
  return mapDispatch(dispatch, accepted.receipt);
}
