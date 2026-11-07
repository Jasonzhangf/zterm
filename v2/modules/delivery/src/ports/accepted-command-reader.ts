import type {
  AcceptMessageCommand,
  DeliveryErrorChain,
} from "./receipt-store.ts";
import type { DeliveryRef } from "../domain/receipt.ts";

/**
 * The persisted accepted command. It is the immutable source of content and
 * target for a resume, so resume never edits the original message.
 */
export type AcceptedCommand = AcceptMessageCommand & {
  /**
   * Persistence-owned V1 message identity. It is required for a real resume
   * because wire correlation must stay stable across retry/restart. It is
   * never derived from DeliveryRef.
   */
  readonly v1MessageId: string;
};

export type ReadAcceptedCommandResult =
  | { readonly kind: "found"; readonly command: AcceptedCommand }
  | { readonly kind: "not-found"; readonly errorRef?: string }
  | {
      readonly kind: "unavailable";
      readonly errorRef: string;
      readonly errorChain?: DeliveryErrorChain;
    };

/**
 * Public persistence-facade edge that reads back an accepted command.
 * The V1 persistence facade owns this operation; delivery only consumes it.
 */
export interface AcceptedCommandReader {
  readAcceptedCommand(ref: DeliveryRef): Promise<ReadAcceptedCommandResult>;
}
