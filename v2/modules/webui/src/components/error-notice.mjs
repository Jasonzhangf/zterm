import { escapeHtml, normalizeTypedError } from './loadable.mjs';

/**
 * Render a typed error surface with an explicit retry action when the error is
 * retryable. Retry stays a caller-supplied intent id; this component never calls
 * the network itself.
 *
 * @param {{
 *   error?: unknown,
 *   title?: string|null,
 *   onRetryAction?: string,
 *   retryAttributes?: Record<string, string|number|boolean>,
 *   forceRetry?: boolean,
 *   contextId?: string|null,
 * }} [props]
 */
export function renderErrorNotice({
  error,
  title = null,
  onRetryAction = 'retry-error',
  retryAttributes = {},
  forceRetry = false,
  contextId = null,
} = {}) {
  const typed = normalizeTypedError(error);
  const { code, category, message, details } = typed;
  const retryable = typed.retryable === true;
  const retryAttributesHtml = Object.entries(retryAttributes)
    .map(([name, value]) => ` data-${escapeHtml(name)}="${escapeHtml(value)}"`)
    .join('');

  const detailsAttr = details == null ? '' : ` data-error-details="${escapeHtml(typeof details === 'string' ? details : JSON.stringify(details))}"`;
  const contextAttr = contextId ? ` data-context-id="${escapeHtml(contextId)}"` : '';
  const titleHtml = title
    ? `<p class="v2-error-title" data-role="error-title">${escapeHtml(title)}</p>`
    : '';
  const retryHtml = retryable || forceRetry === true
    ? `<button type="button" class="v2-error-retry" data-action="${escapeHtml(onRetryAction)}"${retryAttributesHtml} data-error-code="${escapeHtml(code)}" data-context-id="${escapeHtml(contextId ?? '')}">Retry</button>`
    : '';

  const attrs = {
    'data-component': 'error-notice',
    'data-error-code': code,
    'data-error-category': category,
    'data-error-retryable': String(retryable),
  };

  const html =
    `<div class="v2-error-notice" role="alert"` +
    ` data-component="error-notice"` +
    ` data-error-code="${escapeHtml(code)}"` +
    ` data-error-category="${escapeHtml(category)}"` +
    ` data-error-retryable="${retryable}"` +
    detailsAttr +
    contextAttr +
    `>` +
    titleHtml +
    `<p class="v2-error-message" data-role="error-message">${escapeHtml(message)}</p>` +
    retryHtml +
    `</div>`;

  const model = {
    code,
    category,
    message,
    retryable,
    details: details ?? null,
    title,
    contextId,
  };

  return { html, model, attrs };
}
