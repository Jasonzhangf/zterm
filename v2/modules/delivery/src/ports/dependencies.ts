import type { DeliveryRef, DeliveryTarget } from "../domain/receipt.ts";
import type { ReceiptStore } from "./receipt-store.ts";

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
}

export interface DeliveryRoutingPort<TargetAddress> {
  resolveTarget(input: {
    readonly workspaceId: string;
    readonly targetAddress: TargetAddress;
  }): Promise<TargetResolutionResult>;
}

export interface DeliveryDependencies<AuthContext, TargetAddress> {
  readonly authorization: DeliveryAuthorizationPort<AuthContext, TargetAddress>;
  readonly routing: DeliveryRoutingPort<TargetAddress>;
  readonly receiptStore: ReceiptStore;
}
