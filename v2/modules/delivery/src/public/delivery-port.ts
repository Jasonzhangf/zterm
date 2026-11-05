import { queryReceipt } from "../application/query-receipts.ts";
import { submitMessage } from "../application/submit-message.ts";
import type {
  DeliveryDependencies,
} from "../ports/dependencies.ts";
import type {
  DeliveryRef,
  DeliveryTarget,
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
  DeliveryAuthorizationPort,
  DeliveryDependencies,
  DeliveryRoutingPort,
  ReceiptQueryAuthorizationResult,
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
  | "TARGET_BINDING_STALE"
  | "DELIVERY_CONFLICT"
  | "DEDUPE_WINDOW_EXPIRED"
  | "REJECTED_BEFORE_WRITE";

export type SubmissionResult =
  | {
      readonly kind: "accepted";
      readonly disposition: "created" | "replayed";
      readonly receipt: Receipt;
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
  };
}
