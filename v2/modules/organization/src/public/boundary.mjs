// Shared public-boundary validation helpers. Inputs are validated here before any
// store read or mutation. Each caller passes its owning module so typed errors keep
// the correct ErrorRecord owner.

import { ERROR_CODES, fail } from './typed-error.mjs';

export function requireString(value, field, owningModule) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(ERROR_CODES.VALIDATION, `${field} must be a non-empty string`, { owningModule });
  }
  return value;
}

export function requireRecord(value, field, owningModule) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(ERROR_CODES.VALIDATION, `${field} must be an object`, { owningModule });
  }
  return value;
}
