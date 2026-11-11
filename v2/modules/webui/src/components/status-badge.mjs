import { escapeHtml } from './loadable.mjs';

const ALLOWED_STATES = Object.freeze([
  'online',
  'busy',
  'offline',
  'degraded',
  'stale',
  'unknown',
  'error',
]);

const TONE_BY_STATE = Object.freeze({
  online: 'positive',
  busy: 'pending',
  offline: 'muted',
  degraded: 'caution',
  stale: 'caution',
  unknown: 'muted',
  error: 'negative',
});

/**
 * Resolve the effective status from a raw state and its freshness.
 *
 * Hard rule: an `online` state observed with stale/expired freshness must never
 * be presented as healthy online. It collapses to `stale`.
 *
 * @param {unknown} rawState
 * @param {'fresh'|'stale'|'expired'|string} [freshness]
 * @returns {'online'|'busy'|'offline'|'degraded'|'stale'|'unknown'|'error'}
 */
export function normalizeStatusState(rawState, freshness = 'fresh') {
  if (!rawState) {
    return 'unknown';
  }
  const normalized = ALLOWED_STATES.includes(rawState) ? rawState : 'unknown';
  if ((freshness === 'stale' || freshness === 'expired') && normalized === 'online') {
    return 'stale';
  }
  return normalized;
}

/**
 * @param {{
 *   state?: string,
 *   freshness?: string,
 *   observedAt?: string|null,
 *   reason?: string|null,
 *   label?: string|null,
 * }} [props]
 */
export function renderStatusBadge({
  state = 'unknown',
  freshness = 'fresh',
  observedAt = null,
  reason = null,
  label = null,
} = {}) {
  const effectiveState = normalizeStatusState(state, freshness);
  const tone = TONE_BY_STATE[effectiveState] ?? 'muted';
  const isHealthyOnline = effectiveState === 'online' && freshness === 'fresh';
  const resolvedLabel = label ?? effectiveState;

  const attrs = {
    'data-component': 'status-badge',
    'data-status-state': effectiveState,
    'data-status-freshness': freshness,
    'data-healthy-online': String(isHealthyOnline),
    'data-status-tone': tone,
  };

  const titleAttr = reason ? ` title="${escapeHtml(reason)}"` : '';
  const observedAttr = observedAt ? ` data-observed-at="${escapeHtml(observedAt)}"` : '';

  const html =
    `<span class="v2-status-badge v2-status-badge--${escapeHtml(effectiveState)}"` +
    ` data-component="status-badge"` +
    ` data-status-state="${escapeHtml(effectiveState)}"` +
    ` data-status-freshness="${escapeHtml(freshness)}"` +
    ` data-healthy-online="${isHealthyOnline}"` +
    ` data-status-tone="${escapeHtml(tone)}"` +
    observedAttr +
    titleAttr +
    `>` +
    escapeHtml(resolvedLabel) +
    `</span>`;

  const model = {
    state,
    effectiveState,
    tone,
    label: resolvedLabel,
    freshness,
    observedAt,
    reason,
    isHealthyOnline,
  };

  return { html, model, attrs };
}
