import type {
  DeliveryErrorChain,
  DeliveryErrorFrame,
} from "../ports/receipt-store.ts";

export type DeliveryOperation =
  | "accept"
  | "read"
  | "authorize"
  | "dispatch"
  | "apply-evidence";

const MAX_CAUSE_DEPTH = 8;
const DEFAULT_SOURCE: Readonly<Record<DeliveryOperation, string>> = {
  accept: "delivery-receipt-store",
  read: "delivery-receipt-store",
  authorize: "delivery-authorization",
  dispatch: "delivery-message-dispatch",
  "apply-evidence": "delivery-receipt-store",
};
const CAUSE_SOURCE = "cause";

function messageOf(value: unknown): string {
  const record = value as { readonly message?: unknown } | null;
  if (record != null && typeof record.message === "string" && record.message.length > 0) {
    return record.message;
  }
  return String(value);
}

function codeOf(value: unknown, fallback: string): string {
  const record = value as { readonly code?: unknown } | null;
  if (record != null && typeof record.code === "string" && record.code.length > 0) {
    return record.code;
  }
  return fallback;
}

function sourceOf(value: unknown, fallback: string): string {
  const record = value as { readonly source?: unknown } | null;
  if (record != null && typeof record.source === "string" && record.source.length > 0) {
    return record.source;
  }
  return fallback;
}

function causeOf(value: unknown): unknown {
  const record = value as { readonly cause?: unknown } | null;
  return record == null ? undefined : record.cause;
}

export function chainFromException(
  operation: DeliveryOperation,
  error: unknown,
): DeliveryErrorChain {
  const frames: DeliveryErrorFrame[] = [
    {
      code: `delivery.${operation}.${codeOf(error, "unknown")}`,
      message: messageOf(error),
      source: sourceOf(error, DEFAULT_SOURCE[operation]),
    },
  ];

  let current = causeOf(error);
  let previous: unknown;
  let depth = 1;
  while (
    current !== undefined &&
    current !== null &&
    current !== previous &&
    depth <= MAX_CAUSE_DEPTH
  ) {
    frames.push({
      code: codeOf(current, `cause-${depth}`),
      message: messageOf(current),
      source: sourceOf(current, CAUSE_SOURCE),
    });
    previous = current;
    current = causeOf(current);
    depth += 1;
  }

  return frames;
}
