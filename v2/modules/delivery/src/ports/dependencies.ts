import type { DeliveryRef, DeliveryTarget } from "../domain/receipt.ts";
import type { MessageContent } from "../domain/receipt.ts";
import type { AcceptedCommandReader } from "./accepted-command-reader.ts";
import type { DeliveryErrorChain, ReceiptStore } from "./receipt-store.ts";

export interface TrustedDeliveryIdentity {
  readonly sourceMachineId: string;
  readonly workspaceId: string;
  readonly actorAccountId: string;
}

export type SubmissionAuthorizationResult =
  | {
      readonly kind: "allowed";
      readonly identity: TrustedDeliveryIdentity;
    }
  | { readonly kind: "denied"; readonly errorRef?: string }
  | { readonly kind: "unavailable"; readonly errorRef: string };

export type ReceiptQueryAuthorizationResult =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly errorRef?: string }
  | { readonly kind: "unavailable"; readonly errorRef: string };

export type ResumeAuthorizationResult =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly errorRef?: string }
  | { readonly kind: "unavailable"; readonly errorRef: string };

export type TargetResolutionResult =
  | { readonly kind: "resolved"; readonly target: DeliveryTarget }
  | { readonly kind: "not-found"; readonly errorRef?: string }
  | { readonly kind: "ambiguous"; readonly errorRef?: string }
  | { readonly kind: "unavailable"; readonly errorRef: string };

export interface DeliveryAuthorizationPort<AuthContext, TargetAddress> {
  authorizeSubmission(
    actor: AuthContext,
    targetAddress: TargetAddress,
  ): Promise<SubmissionAuthorizationResult>;

  authorizeReceiptQuery(
    actor: AuthContext,
    ref: DeliveryRef,
  ): Promise<ReceiptQueryAuthorizationResult>;

  /**
   * Resume is a send operation. It revalidates send/target authorization
   * against the persisted target; receipt-query permission alone is not enough.
   * Members/routing compares bindingGeneration behind this port.
   * When absent, resume returns a typed authorization-unavailable result and
   * never dispatches.
   */
  authorizeResume?(input: {
    readonly actor: AuthContext;
    readonly ref: DeliveryRef;
    readonly target: DeliveryTarget;
  }): Promise<ResumeAuthorizationResult>;
}

export interface DeliveryRoutingPort<TargetAddress> {
  resolveTarget(input: {
    readonly workspaceId: string;
    readonly targetAddress: TargetAddress;
  }): Promise<TargetResolutionResult>;
}

export interface MessageDispatchCommand {
  readonly deliveryRef: DeliveryRef;
  readonly target: DeliveryTarget;
  readonly message: MessageContent;
  /**
   * Persistence-owned V1 message identity. The wire request correlation uses
   * this stable value, not a value derived from DeliveryRef.
   */
  readonly v1MessageId: string;
}

export type MessageDispatchResult =
  /**
   * The adapter returned a protocol result that confirms the target gateway
   * stored the message. This is the only success state; a bare sent flag is
   * not accepted.
   */
  | {
      readonly kind: "remote-stored";
      readonly observedAt: string;
    }
  /**
   * A possible write happened but the outcome is unproven. It must stay
   * unknown, not unsent and not delivered.
   */
  | {
      readonly kind: "unknown";
      readonly errorRef: string;
      readonly errorChain?: DeliveryErrorChain;
    }
  /**
   * The wire returned a definitive protocol rejection. This is a failure, not
   * an inconclusive state: the stage is preserved and no confirmation is
   * invented.
   */
  | {
      readonly kind: "failed";
      readonly errorRef: string;
      readonly errorChain?: DeliveryErrorChain;
    }
  /**
   * The dispatch capability itself was unavailable before a definitive answer
   * (for example an unauthorized source gateway or a missing capability).
   */
  | {
      readonly kind: "unavailable";
      readonly errorRef: string;
      readonly errorChain?: DeliveryErrorChain;
    };

export interface MessageDispatchPort {
  dispatchMessage(command: MessageDispatchCommand): Promise<MessageDispatchResult>;
}

export interface DeliveryDependencies<AuthContext, TargetAddress> {
  readonly authorization: DeliveryAuthorizationPort<AuthContext, TargetAddress>;
  readonly routing: DeliveryRoutingPort<TargetAddress>;
  readonly dispatch: MessageDispatchPort;
  readonly receiptStore: ReceiptStore;
  readonly acceptedCommand?: AcceptedCommandReader;
}
