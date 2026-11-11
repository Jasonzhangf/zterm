import type { DeliveryRef, Receipt } from "../domain/receipt.ts";
import type { ReadAcceptedCommandResult } from "../ports/accepted-command-reader.ts";
import type {
  DeliveryDependencies,
  MessageDispatchResult,
  ResumeAuthorizationResult,
} from "../ports/dependencies.ts";
import type { ReadReceiptResult } from "../ports/receipt-store.ts";
import type { ResumeResult } from "../public/delivery-port.ts";
import { recordRemoteStoredEvidence } from "./dispatch-evidence.ts";
import { chainFromException } from "./error-chain.ts";

const RESUME_UNAVAILABLE_EXCEPTION = "delivery.resume.unavailable";
const RESUME_READER_UNAVAILABLE_EXCEPTION =
  "delivery.resume.accepted-command-unavailable";
const RESUME_REF_AUTHORIZATION_UNAVAILABLE_EXCEPTION =
  "delivery.authorization.ref-unavailable";
const RESUME_SEND_AUTHORIZATION_UNAVAILABLE_EXCEPTION =
  "delivery.authorization.resume-unavailable";
const V1_MESSAGE_ID_UNAVAILABLE_EXCEPTION =
  "delivery.resume.v1-message-id-unavailable";
const DISPATCH_UNAVAILABLE_EXCEPTION = "delivery.dispatch.unavailable";
const SUBJECT_REQUIRED_REF = "SUBJECT_REQUIRED";

function isRemoteStoredOrHigher(receipt: Receipt): boolean {
  return (
    receipt.durableStage === "remote-stored" ||
    receipt.durableStage === "host-delivered" ||
    receipt.durableStage === "consumed"
  );
}

/**
 * Resume is a send operation, not a read. It revalidates send/target
 * authorization against the persisted target, dispatches the immutable
 * accepted command again, and only treats durable remote-stored-or-higher
 * evidence as already dispatched.
 */
export async function resumeDispatch<AuthContext, TargetAddress>(
  dependencies: DeliveryDependencies<AuthContext, TargetAddress>,
  actor: AuthContext,
  ref: DeliveryRef,
): Promise<ResumeResult> {
  const reader = dependencies.acceptedCommand;
  if (reader === undefined) {
    return {
      kind: "resume-unavailable",
      code: "RESUME_UNAVAILABLE",
      errorRef: RESUME_READER_UNAVAILABLE_EXCEPTION,
    };
  }

  // Resume never reads content before the caller is authorized for this ref.
  // Query permission alone does not authorize a send; authorizeResume below
  // re-checks send/target scope against the persisted target.
  try {
    const access = await dependencies.authorization.authorizeReceiptQuery(
      actor,
      ref,
    );
    if (access.kind === "denied") {
      return {
        kind: "rejected",
        code: "AUTHORIZATION_DENIED",
        errorRef: access.errorRef,
      };
    }
    if (access.kind === "unavailable") {
      return {
        kind: "rejected",
        code: "AUTHORIZATION_UNAVAILABLE",
        errorRef: access.errorRef,
      };
    }
  } catch {
    return {
      kind: "rejected",
      code: "AUTHORIZATION_UNAVAILABLE",
      errorRef: RESUME_REF_AUTHORIZATION_UNAVAILABLE_EXCEPTION,
    };
  }

  let read: ReadAcceptedCommandResult;
  try {
    read = await reader.readAcceptedCommand(ref);
  } catch (error) {
    return {
      kind: "resume-unavailable",
      code: "RESUME_UNAVAILABLE",
      errorRef: RESUME_UNAVAILABLE_EXCEPTION,
      errorChain: chainFromException("read", error),
    };
  }
  if (read.kind === "not-found") {
    return {
      kind: "rejected",
      code: "DELIVERY_NOT_FOUND",
      errorRef: read.errorRef,
    };
  }
  if (read.kind === "unavailable") {
    return {
      kind: "resume-unavailable",
      code: "RESUME_UNAVAILABLE",
      errorRef: read.errorRef,
      ...(read.errorChain === undefined ? {} : { errorChain: read.errorChain }),
    };
  }

  const command = read.command;

  let authorization: ResumeAuthorizationResult;
  try {
    if (dependencies.authorization.authorizeResume === undefined) {
      return {
        kind: "resume-unavailable",
        code: "RESUME_UNAVAILABLE",
        errorRef: RESUME_SEND_AUTHORIZATION_UNAVAILABLE_EXCEPTION,
      };
    }
    authorization = await dependencies.authorization.authorizeResume({
      actor,
      ref,
      target: command.target,
    });
  } catch {
    return {
      kind: "rejected",
      code: "AUTHORIZATION_UNAVAILABLE",
      errorRef: RESUME_SEND_AUTHORIZATION_UNAVAILABLE_EXCEPTION,
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

  if (command.message.subject === undefined) {
    return {
      kind: "dispatch-unavailable",
      code: "DISPATCH_UNAVAILABLE",
      errorRef: SUBJECT_REQUIRED_REF,
    };
  }

  const { v1MessageId } = command;
  if (typeof v1MessageId !== "string" || v1MessageId.length === 0) {
    return {
      kind: "resume-unavailable",
      code: "RESUME_UNAVAILABLE",
      errorRef: V1_MESSAGE_ID_UNAVAILABLE_EXCEPTION,
    };
  }

  let receiptResult: ReadReceiptResult;
  try {
    receiptResult = await dependencies.receiptStore.readReceipt(ref);
  } catch (error) {
    return {
      kind: "resume-unavailable",
      code: "RESUME_UNAVAILABLE",
      errorRef: RESUME_UNAVAILABLE_EXCEPTION,
      errorChain: chainFromException("read", error),
    };
  }
  if (receiptResult.kind === "not-found") {
    return { kind: "rejected", code: "DELIVERY_NOT_FOUND" };
  }
  if (receiptResult.kind === "unavailable") {
    return {
      kind: "resume-unavailable",
      code: "RESUME_UNAVAILABLE",
      errorRef: receiptResult.errorRef,
      ...(receiptResult.errorChain === undefined
        ? {}
        : { errorChain: receiptResult.errorChain }),
    };
  }
  const receipt = receiptResult.observation.receipt;

  if (isRemoteStoredOrHigher(receipt)) {
    return { kind: "already-dispatched", receipt };
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
      receipt,
      errorChain: chainFromException("dispatch", error),
    };
  }
  switch (dispatch.kind) {
    case "remote-stored": {
      const evidence = await recordRemoteStoredEvidence(
        dependencies.receiptStore,
        receipt,
        dispatch,
      );
      if (evidence.kind === "stored") {
        return { kind: "resumed", receipt: evidence.receipt };
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
    case "unknown":
      return {
        kind: "dispatch-unknown",
        code: "DISPATCH_UNKNOWN",
        errorRef: dispatch.errorRef,
        receipt,
        ...(dispatch.errorChain === undefined
          ? {}
          : { errorChain: dispatch.errorChain }),
      };
    case "failed":
      return {
        kind: "dispatch-failed",
        code: "DISPATCH_FAILED",
        errorRef: dispatch.errorRef,
        receipt,
        ...(dispatch.errorChain === undefined
          ? {}
          : { errorChain: dispatch.errorChain }),
      };
    case "unavailable":
      return {
        kind: "dispatch-unavailable",
        code: "DISPATCH_UNAVAILABLE",
        errorRef: dispatch.errorRef,
        receipt,
        ...(dispatch.errorChain === undefined
          ? {}
          : { errorChain: dispatch.errorChain }),
      };
  }
}
