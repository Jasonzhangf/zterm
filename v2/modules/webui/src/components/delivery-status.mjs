import { escapeHtml } from './loadable.mjs';
import { renderErrorNotice } from './error-notice.mjs';

export const MESSAGE_RECEIPT_STATES = Object.freeze(['queued', 'sent', 'delivered', 'consumed', 'failed', 'expired']);
export const FILE_TRANSFER_STATES = Object.freeze(['offered', 'accepted', 'transferring', 'completed', 'failed', 'cancelled']);

const FAILURE_STATES = new Set(['failed', 'expired', 'cancelled']);
const ACTIVE_TRANSFER_STATES = new Set(['offered', 'accepted', 'transferring']);

/**
 * Render message delivery receipts and file transfer state/progress bars.
 * Explicit failure reasons are surfaced for failed/expired/cancelled states,
 * with retry/cancel actions only when the underlying capability allows them.
 *
 * @param {{
 *   receipts?: Array<object>,
 *   transfers?: Array<object>,
 *   error?: unknown,
 * }} [props]
 */
export function renderDeliveryStatus({
  receipts = [],
  transfers = [],
  error = null,
} = {}) {
  const receiptList = Array.isArray(receipts) ? receipts : [];
  const transferList = Array.isArray(transfers) ? transfers : [];
  const hasFailures = receiptList.some((r) => FAILURE_STATES.has(r.state)) ||
    transferList.some((t) => FAILURE_STATES.has(t.state));
  const activeTransferCount = transferList.filter((t) => ACTIVE_TRANSFER_STATES.has(t.state)).length;

  const receiptHtml = receiptList.length > 0
    ? `<ul class="v2-receipt-list" data-role="receipt-list">` +
      receiptList.map((r) => {
        const state = r.state ?? 'unknown';
        const failed = FAILURE_STATES.has(state);
        const reasonHtml = failed && (r.error || r.reason)
          ? `<span class="v2-receipt-reason" data-role="receipt-reason">${escapeHtml(r.error || r.reason)}</span>`
          : '';
        const retryHtml = r.retryable === true
          ? `<button type="button" class="v2-receipt-retry" data-action="retry-delivery" data-delivery-ref="${escapeHtml(r.deliveryRef ?? '')}">Retry</button>`
          : '';
        return `<li class="v2-receipt-item" data-role="receipt-item" data-delivery-ref="${escapeHtml(r.deliveryRef ?? '')}" data-receipt-state="${escapeHtml(state)}" data-failed="${failed}">` +
          `<span class="v2-receipt-state" data-role="receipt-state">${escapeHtml(state)}</span>` +
          reasonHtml +
          retryHtml +
          `</li>`;
      }).join('') +
      `</ul>`
    : `<p class="v2-empty" data-role="receipt-empty">No delivery receipts</p>`;

  const transferHtml = transferList.length > 0
    ? `<ul class="v2-transfer-list" data-role="transfer-list">` +
      transferList.map((t) => {
        const state = t.state ?? 'unknown';
        const total = Number(t.totalBytes ?? 0);
        const done = Number(t.bytesTransferred ?? 0);
        const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
        const failed = FAILURE_STATES.has(state);
        const active = ACTIVE_TRANSFER_STATES.has(state);
        const reasonHtml = failed && (t.error || t.reason)
          ? `<span class="v2-transfer-reason" data-role="transfer-reason">${escapeHtml(t.error || t.reason)}</span>`
          : '';
        const cancelHtml = active
          ? `<button type="button" class="v2-transfer-cancel" data-action="cancel-transfer" data-delivery-ref="${escapeHtml(t.deliveryRef ?? '')}">Cancel</button>`
          : '';
        const retryHtml = (state === 'failed') && t.retryable === true
          ? `<button type="button" class="v2-transfer-retry" data-action="retry-delivery" data-delivery-ref="${escapeHtml(t.deliveryRef ?? '')}">Retry</button>`
          : '';
        return `<li class="v2-transfer-item" data-role="transfer-item" data-delivery-ref="${escapeHtml(t.deliveryRef ?? '')}" data-transfer-state="${escapeHtml(state)}" data-failed="${failed}">` +
          `<span class="v2-transfer-name" data-role="transfer-name">${escapeHtml(t.fileName ?? '')}</span>` +
          `<span class="v2-transfer-state" data-role="transfer-state">${escapeHtml(state)}</span>` +
          `<span class="v2-transfer-progress" data-role="transfer-progress" data-progress="${percent}" data-bytes-transferred="${done}" data-total-bytes="${total}">` +
          `<span class="v2-transfer-bar" style="width:${percent}%"></span>` +
          `</span>` +
          `<span class="v2-transfer-bytes" data-role="transfer-bytes">${done}/${total}</span>` +
          reasonHtml +
          cancelHtml +
          retryHtml +
          `</li>`;
      }).join('') +
      `</ul>`
    : `<p class="v2-empty" data-role="transfer-empty">No file transfers</p>`;

  const errorHtml = error ? renderErrorNotice({ error }).html : '';

  const attrs = {
    'data-component': 'delivery-status',
    'data-has-failures': String(hasFailures),
    'data-active-transfer-count': String(activeTransferCount),
  };

  const html =
    `<div class="v2-delivery-status"` +
    ` data-component="delivery-status"` +
    ` data-has-failures="${hasFailures}"` +
    ` data-active-transfer-count="${activeTransferCount}">` +
    `<section class="v2-delivery-receipts" data-role="delivery-receipts"><h3>Message Delivery</h3>${receiptHtml}</section>` +
    `<section class="v2-delivery-transfers" data-role="delivery-transfers"><h3>File Transfers</h3>${transferHtml}</section>` +
    errorHtml +
    `</div>`;

  const model = {
    receipts: receiptList,
    transfers: transferList,
    hasFailures,
    activeTransferCount,
    error: error ?? null,
  };

  return { html, model, attrs };
}
