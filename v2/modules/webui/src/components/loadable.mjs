// Unified read model for the V2 WebUI.
//
// Loadable<T> = loading | ready(value, observedAt, freshness) | unavailable(error)
//
// Every data read is projected into one of these three states so pages and
// components never have to infer connectivity from an empty list or a missing
// value. This module is dependency free and works in Node.js and browsers.

const ALLOWED_STATUSES = new Set(['loading', 'ready', 'unavailable']);
const ALLOWED_FRESHNESS = new Set(['fresh', 'stale', 'expired']);

/**
 * Escape a value so it can be interpolated into HTML text/attribute position.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function deriveCategory(code) {
  const normalized = String(code ?? '').toUpperCase();
  if (normalized.includes('AUTH') || normalized.includes('TOKEN') || normalized.includes('PERMISSION') || normalized.includes('FORBIDDEN')) {
    return 'auth';
  }
  if (normalized.includes('CONFLICT')) {
    return 'conflict';
  }
  if (normalized.includes('VALIDATION') || normalized.includes('INVALID') || normalized.includes('SCHEMA')) {
    return 'validation';
  }
  if (normalized.includes('TIMEOUT') || normalized.includes('TRANSPORT') || normalized.includes('RETRY') || normalized.includes('NETWORK')) {
    return 'transient';
  }
  if (normalized.includes('UNAVAILABLE') || normalized.includes('OFFLINE') || normalized.includes('NOT_FOUND')) {
    return 'unavailable';
  }
  return 'unknown';
}

/**
 * Normalize arbitrary error shapes (string, Error, typed object) into a single
 * TypedError contract: { code, category, message, retryable, details }.
 * @param {unknown} error
 * @param {string} [fallbackCode]
 */
export function normalizeTypedError(error, fallbackCode = 'WEBUI_UNAVAILABLE') {
  const base = {
    code: fallbackCode,
    category: deriveCategory(fallbackCode),
    message: 'The requested data is unavailable.',
    retryable: false,
    details: null,
  };

  if (error == null) {
    return { ...base };
  }
  if (typeof error === 'string') {
    return { ...base, message: error };
  }
  if (error instanceof Error) {
    const code = typeof error.code === 'string' && error.code ? error.code : fallbackCode;
    return {
      code,
      category: deriveCategory(code),
      message: error.message || base.message,
      retryable: error.retryable === true,
      details: error.details ?? null,
    };
  }
  if (typeof error === 'object') {
    const code = typeof error.code === 'string' && error.code ? error.code : fallbackCode;
    const category = typeof error.category === 'string' && error.category ? error.category : deriveCategory(code);
    return {
      code,
      category,
      message: typeof error.message === 'string' && error.message ? error.message : base.message,
      retryable: error.retryable === true,
      details: error.details ?? null,
    };
  }
  return { ...base };
}

/**
 * @param {Record<string, unknown>} [meta]
 */
export function createLoading(meta = {}) {
  return {
    status: 'loading',
    value: null,
    observedAt: null,
    freshness: 'loading',
    error: null,
    ...meta,
  };
}

/**
 * @param {unknown} value
 * @param {{ observedAt?: string, freshness?: 'fresh'|'stale'|'expired' }} [options]
 */
export function createReady(value, { observedAt = new Date().toISOString(), freshness = 'fresh' } = {}) {
  const safeFreshness = ALLOWED_FRESHNESS.has(freshness) ? freshness : 'fresh';
  return {
    status: 'ready',
    value,
    observedAt,
    freshness: safeFreshness,
    error: null,
  };
}

/**
 * @param {unknown} error
 * @param {{ observedAt?: string }} [options]
 */
export function createUnavailable(error, { observedAt = new Date().toISOString() } = {}) {
  return {
    status: 'unavailable',
    value: null,
    observedAt,
    freshness: 'unavailable',
    error: normalizeTypedError(error),
  };
}

/**
 * @param {unknown} candidate
 * @returns {boolean}
 */
export function isLoadable(candidate) {
  return (
    Boolean(candidate) &&
    typeof candidate === 'object' &&
    ALLOWED_STATUSES.has(candidate.status)
  );
}

/**
 * Map the value of a ready Loadable while preserving observedAt/freshness.
 * loading and unavailable pass through unchanged.
 * @template T, U
 * @param {object} loadable
 * @param {(value: T) => U} mapper
 */
export function mapLoadable(loadable, mapper) {
  if (!isLoadable(loadable)) {
    return loadable;
  }
  if (loadable.status === 'ready') {
    return { ...loadable, value: mapper(loadable.value) };
  }
  return loadable;
}

/**
 * Dispatch rendering by Loadable status.
 *
 * Each handler receives the relevant payload and the full Loadable entry so
 * callers can render observedAt/freshness alongside the value. The handler's
 * return value is returned as-is.
 *
 * @param {object} loadable
 * @param {{
 *   renderReady?: (value: unknown, loadable: object) => unknown,
 *   renderLoading?: (loadable: object) => unknown,
 *   renderUnavailable?: (error: object, loadable: object) => unknown,
 * }} handlers
 */
export function renderLoadableBoundary(loadable, { renderReady, renderLoading, renderUnavailable } = {}) {
  if (!isLoadable(loadable)) {
    return renderUnavailable ? renderUnavailable(normalizeTypedError(loadable), loadable) : '';
  }
  if (loadable.status === 'ready') {
    return renderReady ? renderReady(loadable.value, loadable) : '';
  }
  if (loadable.status === 'loading') {
    return renderLoading ? renderLoading(loadable) : '';
  }
  return renderUnavailable ? renderUnavailable(loadable.error, loadable) : '';
}
