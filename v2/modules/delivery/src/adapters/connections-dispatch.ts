import type {
  MessageDispatchCommand,
  MessageDispatchPort,
  MessageDispatchResult,
} from "../ports/dependencies.ts";
import type { DeliveryErrorChain } from "../ports/receipt-store.ts";
import type {
  AppMessageRequest,
  AppMessageResult,
} from "../../../connections/src/index.ts";

/**
 * Delivery-owned view of the connections public awaited-send edge. The
 * consumer delegates to `ConnectionManager.requestMessage` and returns its
 * `AppMessageResult` unchanged; delivery owns only the mapping to
 * `MessageDispatchResult` and keeps no second copy of the wire vocabulary.
 */
export interface MessageSendChannel {
  sendMessage(request: AppMessageRequest): Promise<AppMessageResult>;
}

export interface ConnectionsDispatchOptions {
  /**
   * Machine identity proven by the authorized source link. It is required and
   * must equal `command.deliveryRef.sourceMachineId`. There is no unbound
   * default, so an omitted or unproven source can never dispatch.
   */
  readonly sourceMachineId: string;
  readonly now?: () => string;
}

const SOURCE_MISMATCH_REF = "delivery.dispatch.source-mismatch";
const SUBJECT_REQUIRED_REF = "SUBJECT_REQUIRED";

function frame(
  code: string,
  message: string,
  stage?: string,
): DeliveryErrorChain {
  return stage === undefined
    ? [{ code, message }]
    : [{ code, message, stage }];
}

/**
 * Approved dispatch mapping (delivery-app-transition-tables-20261107.md). Only
 * `received` + `received` proves the target gateway stored the message. Every
 * other combination keeps the prior durable stage, preserves the observed
 * `status`/`stage`/`cause`, and never invents a confirmation. A definitive
 * protocol rejection is a failure; `storage_error` and an inconclusive
 * possible write stay unknown.
 */
function mapObservation(
  observation: AppMessageResult,
  now: () => string,
): MessageDispatchResult {
  if (observation.kind === "result") {
    const { status, stage } = observation;
    if (status === "received" && stage === "received") {
      return { kind: "remote-stored", observedAt: now() };
    }
    if (status === "rejected") {
      // A send-result `rejected` status is a definitive protocol rejection.
      return {
        kind: "failed",
        errorRef: "delivery.dispatch.rejected",
        errorChain: frame("rejected", "app-send-result rejected", stage),
      };
    }
    // received(prepared/sent), delivered, consumed, resultUnknown, unreachable,
    // receiving: transport write or unconfirmed state. Keep prior stage.
    return {
      kind: "unknown",
      errorRef: `delivery.dispatch.${status}`,
      errorChain: frame(status, `app-send-result ${status}`, stage),
    };
  }
  if (observation.kind === "rejected") {
    const { code, stage, cause } = observation;
    const message = cause ?? code;
    if (code === "storage_error") {
      // The target may have written before reporting the error: stay unknown
      // and preserve the exact code/stage/cause.
      return {
        kind: "unknown",
        errorRef: observation.errorRef ?? "delivery.dispatch.storage_error",
        errorChain: frame(code, message, stage),
      };
    }
    // Definitive wire rejection follows the approved table as a failure.
    return {
      kind: "failed",
      errorRef: observation.errorRef ?? `delivery.dispatch.${code}`,
      errorChain: frame(code, message, stage),
    };
  }
  // Post-write transport loss or an uncorrelated response: possible write,
  // typed unknown, never a fabricated success.
  return {
    kind: "unknown",
    errorRef: observation.errorRef,
    ...(observation.cause === undefined
      ? {}
      : { errorChain: frame("result_unknown", observation.cause) }),
  };
}

/**
 * Minimal production-owned `MessageDispatchPort` over the connections awaited
 * send edge. The mapping table is the delivery-owned compatibility contract;
 * no test-only mapping may live outside this file.
 */
export function createConnectionsDispatchPort(
  channel: MessageSendChannel,
  options: ConnectionsDispatchOptions,
): MessageDispatchPort {
  const now = options.now ?? (() => new Date().toISOString());
  const sourceMachineId = options.sourceMachineId;
  return {
    async dispatchMessage(
      command: MessageDispatchCommand,
    ): Promise<MessageDispatchResult> {
      if (
        typeof sourceMachineId !== "string"
        || sourceMachineId.length === 0
        || sourceMachineId !== command.deliveryRef.sourceMachineId
      ) {
        return { kind: "unavailable", errorRef: SOURCE_MISMATCH_REF };
      }
      const subject = command.message.subject;
      if (typeof subject !== "string" || subject.length === 0) {
        // The application layer rejects an absent subject before dispatch; this
        // guard keeps the adapter honest if it is ever called directly.
        return {
          kind: "unavailable",
          errorRef: SUBJECT_REQUIRED_REF,
          errorChain: frame("SUBJECT_REQUIRED", "dispatch requires a non-empty subject"),
        };
      }
      const observation = await channel.sendMessage({
        v1MessageId: command.v1MessageId,
        targetMachineId: command.target.machineId,
        subject,
        body: command.message.body,
      });
      return mapObservation(observation, now);
    },
  };
}
