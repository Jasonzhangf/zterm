import type { Receipt, ReceiptEvidence } from "../domain/receipt.ts";
import type {
  MessageDispatchResult,
} from "../ports/dependencies.ts";
import type {
  DeliveryErrorChain,
  ReceiptStore,
} from "../ports/receipt-store.ts";
import { chainFromException } from "./error-chain.ts";

const DISPATCH_EVIDENCE_INVALID_EXCEPTION =
  "delivery.dispatch.evidence-invalid";
const DISPATCH_EVIDENCE_IDENTITY_MISMATCH_EXCEPTION =
  "delivery.dispatch.evidence-identity-mismatch";
const DISPATCH_EVIDENCE_NOT_FOUND_EXCEPTION =
  "delivery.dispatch.evidence-receipt-not-found";
const DISPATCH_EVIDENCE_UNAVAILABLE_EXCEPTION =
  "delivery.dispatch.evidence-unavailable";

export type RecordDispatchEvidenceResult =
  | { readonly kind: "stored"; readonly receipt: Receipt }
  | {
      readonly kind: "unknown";
      readonly receipt: Receipt;
      readonly errorRef: string;
      readonly errorChain?: DeliveryErrorChain;
    };

export async function recordRemoteStoredEvidence(
  receiptStore: ReceiptStore,
  receipt: Receipt,
  dispatch: Extract<MessageDispatchResult, { readonly kind: "remote-stored" }>,
): Promise<RecordDispatchEvidenceResult> {
  if (dispatch.observedAt.length === 0) {
    return {
      kind: "unknown",
      receipt,
      errorRef: DISPATCH_EVIDENCE_INVALID_EXCEPTION,
    };
  }

  const evidence: ReceiptEvidence = {
    kind: "remote-stored",
    deliveryRef: receipt.deliveryRef,
    target: receipt.target,
    observedAt: dispatch.observedAt,
  };

  let result: Awaited<ReturnType<ReceiptStore["applyReceiptEvidence"]>>;
  try {
    result = await receiptStore.applyReceiptEvidence(evidence);
  } catch (error) {
    return {
      kind: "unknown",
      receipt,
      errorRef: DISPATCH_EVIDENCE_UNAVAILABLE_EXCEPTION,
      errorChain: chainFromException("apply-evidence", error),
    };
  }

  switch (result.kind) {
    case "applied":
    case "ignored":
      return { kind: "stored", receipt: result.receipt };
    case "identity-mismatch":
      return {
        kind: "unknown",
        receipt,
        errorRef: DISPATCH_EVIDENCE_IDENTITY_MISMATCH_EXCEPTION,
      };
    case "not-found":
      return {
        kind: "unknown",
        receipt,
        errorRef: DISPATCH_EVIDENCE_NOT_FOUND_EXCEPTION,
      };
    case "unavailable":
      return {
        kind: "unknown",
        receipt,
        errorRef: result.errorRef,
        ...(result.errorChain === undefined
          ? {}
          : { errorChain: result.errorChain }),
      };
  }
}
