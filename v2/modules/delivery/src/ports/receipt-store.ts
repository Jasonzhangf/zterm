import type {
  DeliveryRef,
  DeliveryTarget,
  MessageContent,
  Receipt,
  ReceiptEvidence,
  ReceiptEvidenceResult,
  ReceiptObservation,
} from "../domain/receipt.ts";

export type DeliveryErrorFrame = {
  readonly code: string;
  readonly message: string;
  readonly source?: string;
  /**
   * Wire/protocol stage observed when the error was produced. It is carried so
   * a definitive or inconclusive send outcome never loses its stage while the
   * code and cause are preserved.
   */
  readonly stage?: string;
};

export type DeliveryErrorChain = readonly DeliveryErrorFrame[];

export interface AcceptMessageCommand {
  readonly deliveryRef: DeliveryRef;
  readonly target: DeliveryTarget;
  readonly kind: "message";
  readonly message: MessageContent;
}

export type AcceptMessageResult =
  | { readonly kind: "created"; readonly receipt: Receipt }
  | { readonly kind: "replayed"; readonly receipt: Receipt }
  | { readonly kind: "target-binding-stale" }
  | { readonly kind: "conflict" }
  | { readonly kind: "dedupe-window-expired" }
  | { readonly kind: "rejected-before-write"; readonly errorRef: string }
  | {
      readonly kind: "acceptance-unknown";
      readonly errorRef: string;
      readonly errorChain?: DeliveryErrorChain;
    };

export type ReadReceiptResult =
  | {
      readonly kind: "found";
      readonly observation: ReceiptObservation & { readonly receipt: Receipt };
    }
  | { readonly kind: "not-found" }
  | {
      readonly kind: "unavailable";
      readonly errorRef: string;
      readonly errorChain?: DeliveryErrorChain;
    };

export interface ReceiptStore {
  acceptMessage(command: AcceptMessageCommand): Promise<AcceptMessageResult>;
  readReceipt(ref: DeliveryRef): Promise<ReadReceiptResult>;
  applyReceiptEvidence(
    evidence: ReceiptEvidence,
  ): Promise<
    | ReceiptEvidenceResult
    | { readonly kind: "not-found" }
    | {
        readonly kind: "unavailable";
        readonly errorRef: string;
        readonly errorChain?: DeliveryErrorChain;
      }
  >;
}
