import { createLoading, escapeHtml, renderLoadableBoundary } from './loadable.mjs';
import { renderErrorNotice } from './error-notice.mjs';
import { renderFormActions } from './form-actions.mjs';

const FIELDS = Object.freeze([
  { key: 'role', label: 'Role', multiline: false },
  { key: 'description', label: 'Description', multiline: true },
  { key: 'cwd', label: 'Working Directory', multiline: false },
  { key: 'envSummary', label: 'Environment Summary', multiline: true },
  { key: 'connectionRef', label: 'Connection Ref', multiline: false },
  { key: 'workspaceBinding', label: 'Workspace Binding', multiline: false },
]);

/**
 * Single-window property drawer. All inputs and actions are strictly bound to
 * the originating windowId + memberId so switching members mid-edit never leaks
 * values into another window.
 *
 * @param {{
 *   windowId?: string,
 *   memberId?: string,
 *   propertiesLoadable?: object,
 *   draft?: object|null,
 *   saving?: boolean,
 *   saveError?: unknown,
 * }} [props]
 */
export function renderPropertyPanel({
  windowId = '',
  memberId = '',
  propertiesLoadable = createLoading(),
  draft = null,
  saving = false,
  saveError = null,
} = {}) {
  const resolvedLoadable = propertiesLoadable && typeof propertiesLoadable === 'object'
    ? propertiesLoadable
    : createLoading();
  const status = resolvedLoadable.status;
  let effectiveValues = null;
  const contextId = `${windowId}:${memberId}`;

  const renderReady = (value) => {
    const base = value && typeof value === 'object' ? value : {};
    effectiveValues = { ...base, ...(draft && typeof draft === 'object' ? draft : {}) };
    const formId = `property-${windowId}`;
    const fieldsHtml = FIELDS.map((f) => {
      const fieldValue = effectiveValues[f.key] ?? '';
      const escaped = escapeHtml(fieldValue);
      const bindings =
        ` data-window-id="${escapeHtml(windowId)}"` +
        ` data-member-id="${escapeHtml(memberId)}"` +
        ` name="${escapeHtml(f.key)}"`;
      const control = f.multiline
        ? `<textarea class="v2-property-input" data-field="${escapeHtml(f.key)}"${bindings} rows="3">${escaped}</textarea>`
        : `<input class="v2-property-input" type="text" data-field="${escapeHtml(f.key)}"${bindings} value="${escaped}">`;
      return `<label class="v2-property-field" data-field="${escapeHtml(f.key)}">` +
        `<span class="v2-property-label">${escapeHtml(f.label)}</span>` +
        control +
        `</label>`;
    }).join('');

    const actions = renderFormActions({
      formId,
      pending: saving === true,
      error: saveError,
      submitLabel: 'Save Properties',
      cancelLabel: 'Cancel',
    }).html;

    return `<form class="v2-property-form" data-form-id="${escapeHtml(formId)}"` +
      ` data-window-id="${escapeHtml(windowId)}" data-member-id="${escapeHtml(memberId)}">` +
      fieldsHtml +
      actions +
      `</form>`;
  };

  const renderLoading = () =>
    `<div class="v2-property-loading" data-role="property-loading" aria-label="Loading properties"></div>`;

  const renderUnavailable = (error) =>
    renderErrorNotice({ error, contextId }).html;

  const contentHtml = renderLoadableBoundary(resolvedLoadable, {
    renderReady,
    renderLoading,
    renderUnavailable,
  });

  const attrs = {
    'data-component': 'property-panel',
    'data-window-id': String(windowId),
    'data-member-id': String(memberId),
    'data-status': status,
    'data-saving': String(Boolean(saving)),
    'data-has-save-error': String(Boolean(saveError)),
  };

  const html =
    `<div class="v2-property-panel"` +
    ` data-component="property-panel"` +
    ` data-window-id="${escapeHtml(windowId)}"` +
    ` data-member-id="${escapeHtml(memberId)}"` +
    ` data-status="${status}"` +
    ` data-saving="${Boolean(saving)}"` +
    ` data-has-save-error="${Boolean(saveError)}">` +
    `<h3 class="v2-property-title" data-role="property-title">Properties</h3>` +
    contentHtml +
    `</div>`;

  const model = {
    windowId,
    memberId,
    status,
    effectiveValues,
    saving: Boolean(saving),
    saveError,
  };

  return { html, model, attrs };
}
