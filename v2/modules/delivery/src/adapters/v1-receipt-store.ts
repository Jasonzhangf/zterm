import {
  createAppMessagingPersistence,
  type AcceptMessageResult as PublicAcceptMessageResult,
  type AppMessagingPersistenceOptions,
  type ApplyReceiptEvidenceResult as PublicApplyReceiptEvidenceResult,
  type ReadReceiptResult as PublicReadReceiptResult,
} from "@zterm/android/app-messaging-persistence";
import type {
  DeliveryRef,
  ReceiptEvidence,
  ReceiptEvidenceResult,
} from "../domain/receipt.ts";
import { applyReceiptEvidence } from "../domain/receipt.ts";
import type {
  AcceptMessageCommand,
  AcceptMessageResult,
  ReadReceiptResult,
  ReceiptStore,
} from "../ports/receipt-store.ts";

function mapAcceptance(result: PublicAcceptMessageResult): AcceptMessageResult {
  switch (result.kind) {
    case "created":
    case "replayed":
      return { kind: result.kind, receipt: result.receipt };
    case "target-binding-stale":
      return { kind: "target-binding-stale" };
    case "conflict":
      return { kind: "conflict" };
    case "dedupe-window-expired":
      return { kind: "dedupe-window-expired" };
    case "rejected-before-write":
      return { kind: "rejected-before-write", errorRef: result.errorRef };
    case "acceptance-unknown":
      return {
        kind: "acceptance-unknown",
        errorRef: result.errorRef,
        errorChain: result.errorChain,
      };
  }
}

function mapRead(result: PublicReadReceiptResult): ReadReceiptResult {
  switch (result.kind) {
    case "found":
      return {
        kind: "found",
        observation: {
          receipt: result.observation.receipt,
          freshness: result.observation.freshness,
          observedAt: result.observation.observedAt,
        },
      };
    case "not-found":
      return { kind: "not-found" };
    case "unavailable":
      return {
        kind: "unavailable",
        errorRef: result.errorRef,
        errorChain: result.errorChain,
      };
  }
}

function mapEvidenceResult(
  result: PublicApplyReceiptEvidenceResult,
): ReceiptEvidenceResult | { kind: "not-found" } | {
  kind: "unavailable";
  errorRef: string;
  errorChain?: readonly { code: string; message: string; source?: string }[];
} {
  switch (result.kind) {
    case "applied":
    case "ignored":
    case "identity-mismatch":
    case "not-found":
      return result;
    case "unavailable":
      return {
        kind: "unavailable",
        errorRef: result.errorRef,
        errorChain: result.errorChain,
      };
  }
}

export function createV1ReceiptStore(
  options: AppMessagingPersistenceOptions,
): ReceiptStore {
  const store = createAppMessagingPersistence(options, applyReceiptEvidence);
  return {
    async acceptMessage(
      command: AcceptMessageCommand,
    ): Promise<AcceptMessageResult> {
      return mapAcceptance(await store.acceptMessage(command));
    },

    async readReceipt(ref: DeliveryRef): Promise<ReadReceiptResult> {
      return mapRead(await store.readReceipt(ref));
    },

    async applyReceiptEvidence(evidence: ReceiptEvidence) {
      return mapEvidenceResult(await store.applyReceiptEvidence(evidence));
    },
  };
}
