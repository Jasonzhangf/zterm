import { queryReceipt } from "../application/query-receipts.ts";
import { resumeDispatch } from "../application/resume-dispatch.ts";
import { submitMessage } from "../application/submit-message.ts";
import type {
  DeliveryDependencies,
} from "../ports/dependencies.ts";
import type {
  DeliveryRef,
  MessageContent,
  Receipt,
  ReceiptObservation,
} from "../domain/receipt.ts";
import type { DeliveryErrorChain } from "../ports/receipt-store.ts";

export type {
  DeliveryRef,
  DeliveryTarget,
  DurableStage,
  MessageContent,
  Receipt,
  ReceiptEvidence,
  ReceiptEvidenceResult,
  ReceiptObservation,
  ReceiptOutcome,
} from "../domain/receipt.ts";
export type {
  AcceptMessageCommand,
  AcceptMessageResult,
  DeliveryErrorChain,
  DeliveryErrorFrame,
  ReadReceiptResult,
  ReceiptStore,
} from "../ports/receipt-store.ts";
export type {
  AcceptedCommand,
  AcceptedCommandReader,
  ReadAcceptedCommandResult,
} from "../ports/accepted-command-reader.ts";
export type {
  DeliveryAuthorizationPort,
  DeliveryDependencies,
  DeliveryRoutingPort,
  MessageDispatchCommand,
  MessageDispatchPort,
  MessageDispatchResult,
  ReceiptQueryAuthorizationResult,
  ResumeAuthorizationResult,
  SubmissionAuthorizationResult,
  TargetResolutionResult,
  TrustedDeliveryIdentity,
} from "../ports/dependencies.ts";

export type DeliveryErrorCode =
  | "INVALID_INPUT"
  | "INVALID_TARGET"
  | "AUTHORIZATION_DENIED"
  | "AUTHORIZATION_UNAVAILABLE"
  | "TARGET_NOT_FOUND"
  | "TARGET_AMBIGUOUS"
  | "ROUTING_UNAVAILABLE"
  | "DELIVERY_NOT_FOUND"
  | "TARGET_BINDING_STALE"
  | "DELIVERY_CONFLICT"
  | "DEDUPE_WINDOW_EXPIRED"
  | "REJECTED_BEFORE_WRITE"
  | "DISPATCH_UNAVAILABLE"
  | "DISPATCH_UNKNOWN"
  | "RESUME_UNAVAILABLE";

export type SubmissionResult =
  | {
      readonly kind: "accepted";
      readonly disposition: "created" | "replayed";
      readonly receipt: Receipt;
    }
  | {
      readonly kind: "routing-unavailable";
      readonly code: "ROUTING_UNAVAILABLE";
      readonly errorRef: string;
    }
  | {
      readonly kind: "dispatch-unavailable";
      readonly code: "DISPATCH_UNAVAILABLE";
      readonly errorRef: string;
      readonly receipt: Receipt;
      readonly errorChain?: DeliveryErrorChain;
    }
  | {
      readonly kind: "dispatch-unknown";
      readonly code: "DISPATCH_UNKNOWN";
      readonly errorRef: string;
      readonly receipt: Receipt;
      readonly errorChain?: DeliveryErrorChain;
    }
  | {
      readonly kind: "rejected";
      readonly code: DeliveryErrorCode;
      readonly errorRef?: string;
    }
  | {
      readonly kind: "acceptance-unknown";
      readonly errorRef: string;
      readonly errorChain?: DeliveryErrorChain;
    };

export type QueryResult =
  | {
      readonly kind: "found";
      readonly observation: ReceiptObservation & {
        readonly receipt: Receipt;
      };
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "denied"; readonly errorRef?: string }
  | { readonly kind: "invalid"; readonly errorRef?: string }
  | {
      readonly kind: "unavailable";
      readonly errorRef: string;
      readonly errorChain?: DeliveryErrorChain;
    };

export type ResumeResult =
  | {
      readonly kind: "resumed";
      readonly receipt: Receipt;
    }
  | {
      readonly kind: "already-dispatched";
      readonly receipt: Receipt;
    }
  | {
      readonly kind: "dispatch-unavailable";
      readonly code: "DISPATCH_UNAVAILABLE";
      readonly errorRef: string;
      readonly receipt?: Receipt;
      readonly errorChain?: DeliveryErrorChain;
    }
  | {
      readonly kind: "dispatch-unknown";
      readonly code: "DISPATCH_UNKNOWN";
      readonly errorRef: string;
      readonly receipt: Receipt;
      readonly errorChain?: DeliveryErrorChain;
    }
  | {
      readonly kind: "resume-unavailable";
      readonly code: "RESUME_UNAVAILABLE";
      readonly errorRef: string;
      readonly errorChain?: DeliveryErrorChain;
    }
  | {
      readonly kind: "rejected";
      readonly code: DeliveryErrorCode;
      readonly errorRef?: string;
    };

export interface DeliveryPort<AuthContext, TargetAddress = unknown> {
  submitMessage(
    actor: AuthContext,
    targetAddress: TargetAddress,
    requestId: string,
    message: MessageContent,
  ): Promise<SubmissionResult>;

  queryReceipt(
    actor: AuthContext,
    ref: DeliveryRef,
  ): Promise<QueryResult>;

  resumeDispatch(
    actor: AuthContext,
    ref: DeliveryRef,
  ): Promise<ResumeResult>;
}

export function createDeliveryPort<AuthContext, TargetAddress = unknown>(
  dependencies: DeliveryDependencies<AuthContext, TargetAddress>,
): DeliveryPort<AuthContext, TargetAddress> {
  return {
    submitMessage: (actor, targetAddress, requestId, message) =>
      submitMessage(
        dependencies,
        actor,
        targetAddress,
        requestId,
        message,
      ),
    queryReceipt: (actor, ref) =>
      queryReceipt(dependencies, actor, ref),
    resumeDispatch: (actor, ref) =>
      resumeDispatch(dependencies, actor, ref),
  };
}
