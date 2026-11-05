export class TypedError extends Error {
  constructor({ code, owningModule, operationId, cause, message }) {
    super(message || code);
    this.name = "TypedError";
    this.code = code;
    this.owningModule = owningModule;
    this.operationId = operationId;
    this.cause = cause;
  }

  toJSON() {
    return {
      code: this.code,
      owningModule: this.owningModule,
      operationId: this.operationId,
      cause: normalizeCause(this.cause),
      message: this.message,
    };
  }
}

export function createTypedError({ code, owningModule, operationId, cause, message }) {
  return new TypedError({ code, owningModule, operationId, cause, message });
}

export function asTypedError(error, fallback) {
  if (error instanceof TypedError) {
    return error;
  }

  return createTypedError({
    code: fallback.code,
    owningModule: fallback.owningModule,
    operationId: fallback.operationId,
    cause: normalizeCause(error),
    message: fallback.message,
  });
}

function normalizeCause(cause) {
  if (cause === undefined || cause === null) {
    return null;
  }
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === "string") {
    return cause;
  }
  return cause;
}
