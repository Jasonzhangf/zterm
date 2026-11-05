// Minimal V2 typed-error shape. It mirrors the reviewed ErrorRecord contract
// (code, owningModule, operationId, cause, retryDisposition). It lives in the
// organization public contract only until v2/modules/errors ships its own
// implementation; members and routing import it through this public entry so the
// shape is defined once instead of copied per module.

export const ERROR_CODES = Object.freeze({
  VALIDATION: 'VALIDATION',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  ORGANIZATION_FORBIDDEN: 'ORGANIZATION_FORBIDDEN',
  ORGANIZATION_REVISION_STALE: 'ORGANIZATION_REVISION_STALE',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  GROUP_NOT_FOUND: 'GROUP_NOT_FOUND',
  GROUP_NAME_CONFLICT: 'GROUP_NAME_CONFLICT',
  MEMBER_NAME_CONFLICT: 'MEMBER_NAME_CONFLICT',
  GROUP_NOT_EMPTY: 'GROUP_NOT_EMPTY',
  ROOT_GROUP_PROTECTED: 'ROOT_GROUP_PROTECTED',
  MEMBER_NOT_FOUND: 'MEMBER_NOT_FOUND',
  MOUNT_NOT_FOUND: 'MOUNT_NOT_FOUND',
  MOUNT_NAME_CONFLICT: 'MOUNT_NAME_CONFLICT',
  MOUNT_CONFLICT: 'MOUNT_CONFLICT',
  MOUNT_CYCLE: 'MOUNT_CYCLE',
  STORE_PERSIST_FAILED: 'STORE_PERSIST_FAILED',
  BINDING_GENERATION_STALE: 'BINDING_GENERATION_STALE',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  ROUTE_AMBIGUOUS: 'ROUTE_AMBIGUOUS',
});

const RETRY_DISPOSITION = Object.freeze({
  VALIDATION: 'terminal',
  UNAUTHENTICATED: 'terminal',
  ORGANIZATION_FORBIDDEN: 'terminal',
  ORGANIZATION_REVISION_STALE: 'retryable',
  WORKSPACE_NOT_FOUND: 'terminal',
  GROUP_NOT_FOUND: 'terminal',
  GROUP_NAME_CONFLICT: 'terminal',
  MEMBER_NAME_CONFLICT: 'terminal',
  GROUP_NOT_EMPTY: 'terminal',
  ROOT_GROUP_PROTECTED: 'terminal',
  MEMBER_NOT_FOUND: 'terminal',
  MOUNT_NOT_FOUND: 'terminal',
  MOUNT_NAME_CONFLICT: 'terminal',
  MOUNT_CONFLICT: 'terminal',
  MOUNT_CYCLE: 'terminal',
  STORE_PERSIST_FAILED: 'retryable',
  BINDING_GENERATION_STALE: 'retryable',
  ROUTE_NOT_FOUND: 'terminal',
  ROUTE_AMBIGUOUS: 'terminal',
});

export class TypedError extends Error {
  constructor(code, message, options = {}) {
    const {
      owningModule = null,
      operationId = null,
      cause = null,
      details = null,
      retryDisposition,
    } = options;
    super(message, cause ? { cause } : undefined);
    this.name = 'TypedError';
    this.code = code;
    this.owningModule = owningModule;
    this.operationId = operationId;
    this.retryDisposition = retryDisposition ?? RETRY_DISPOSITION[code] ?? 'terminal';
    this.details = details;
  }

  toRecord() {
    return {
      code: this.code,
      owningModule: this.owningModule,
      operationId: this.operationId,
      cause: this.cause ?? null,
      retryDisposition: this.retryDisposition,
    };
  }
}

export function fail(code, message, options) {
  throw new TypedError(code, message, options);
}

export function isTypedError(value) {
  return value instanceof TypedError;
}
