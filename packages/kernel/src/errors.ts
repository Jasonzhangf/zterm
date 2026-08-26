export class KernelContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'KernelContractError';
  }
}

export function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new KernelContractError('invalid_identifier', `${field} must be non-empty`);
  }
  return normalized;
}
