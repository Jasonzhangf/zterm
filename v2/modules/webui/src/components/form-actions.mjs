import { renderErrorNotice } from './error-notice.mjs';

/**
 * Submit / cancel / retry action row for a form. When pending, submit is
 * disabled to prevent duplicate submissions. When an error is present, an
 * inline ErrorNotice is embedded so the failure surface stays in one place.
 *
 * @param {{
 *   formId?: string,
 *   pending?: boolean,
 *   disabled?: boolean,
 *   error?: unknown,
 *   submitLabel?: string,
 *   cancelLabel?: string,
 *   retryLabel?: string,
 * }} [props]
 */
export function renderFormActions({
  formId = 'form',
  pending = false,
  disabled = false,
  error = null,
  submitLabel = 'Save',
  cancelLabel = 'Cancel',
  retryLabel = 'Retry',
} = {}) {
  const hasError = Boolean(error);
  const submitDisabled = pending === true || disabled === true;
  const pendingAttr = pending === true ? 'true' : 'false';

  const submitHtml =
    `<button type="submit" class="v2-form-submit"` +
    ` data-action="submit-form"` +
    ` data-form-id="${escapeId(formId)}"` +
    ` data-pending="${pendingAttr}"` +
    `${submitDisabled ? ' disabled' : ''}>` +
    escapeText(submitLabel) +
    `</button>`;

  const cancelHtml =
    `<button type="button" class="v2-form-cancel"` +
    ` data-action="cancel-form"` +
    ` data-form-id="${escapeId(formId)}"${disabled === true ? ' disabled' : ''}>` +
    escapeText(cancelLabel) +
    `</button>`;

  const retryHtml = hasError
    ? `<button type="button" class="v2-form-retry"` +
      ` data-action="retry-form"` +
      ` data-form-id="${escapeId(formId)}">${escapeText(retryLabel)}</button>`
    : '';

  const errorHtml = hasError ? renderErrorNotice({ error }).html : '';

  const attrs = {
    'data-component': 'form-actions',
    'data-form-id': formId,
    'data-pending': pendingAttr,
    'data-submit-disabled': String(submitDisabled),
    'data-has-error': String(hasError),
  };

  const html =
    `<div class="v2-form-actions"` +
    ` data-component="form-actions"` +
    ` data-form-id="${escapeId(formId)}"` +
    ` data-pending="${pendingAttr}"` +
    ` data-submit-disabled="${submitDisabled}"` +
    ` data-has-error="${hasError}">` +
    submitHtml +
    cancelHtml +
    retryHtml +
    errorHtml +
    `</div>`;

  const model = {
    formId,
    pending: pending === true,
    submitDisabled,
    hasError,
    error: hasError ? error : null,
    submitLabel,
    cancelLabel,
    retryLabel,
  };

  return { html, model, attrs };
}

function escapeId(value) {
  return String(value ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
