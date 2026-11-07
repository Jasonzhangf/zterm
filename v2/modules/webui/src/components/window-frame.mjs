import { escapeHtml } from './loadable.mjs';
import { renderWindowHeader } from './window-header.mjs';

export const RESIZE_DIRECTIONS = Object.freeze(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

/**
 * Render the unified window container: single-line header, 8-direction border
 * resize handles (so resizing never depends on dragging the header bar),
 * terminal body slot, and optional property drawer.
 *
 * @param {object} [props]
 */
export function renderWindowFrame({
  windowId = '',
  memberId = '',
  title = '',
  status = 'unknown',
  freshness = 'fresh',
  role = '',
  machine = '',
  isPrimary = false,
  isFocused = false,
  isStale = false,
  availableWidth = 360,
  widthPx = null,
  heightPx = null,
  propertyOpen = false,
  propertyPanelHtml = '',
  bodyHtml = '',
  primaryAction = { id: 'toggle-property', label: 'Props' },
  secondaryActions = [],
  overflowOpen = false,
  workStatus = null,
  enableResizeHandles = true,
} = {}) {
  const header = renderWindowHeader({
    windowId,
    memberId,
    title,
    status,
    freshness,
    role,
    machine,
    primaryAction,
    secondaryActions,
    availableWidth,
    overflowOpen,
    workStatus,
  });

  const resizeHandlesHtml = enableResizeHandles === true
    ? RESIZE_DIRECTIONS.map((dir) =>
      `<span class="v2-resize-handle v2-resize-handle--${dir}"` +
      ` data-resize-handle="${dir}"` +
      ` data-window-id="${escapeHtml(windowId)}"` +
      ` data-member-id="${escapeHtml(memberId)}"` +
      `></span>`
    ).join('')
    : '';

  const drawerHtml = propertyOpen === true
    ? `<aside class="v2-window-property-drawer"` +
      ` data-role="window-property-drawer"` +
      ` data-window-id="${escapeHtml(windowId)}"` +
      ` data-member-id="${escapeHtml(memberId)}">` +
      propertyPanelHtml +
      `</aside>`
    : '';

  const sizeStyle = [
    widthPx != null ? `width:${Number(widthPx)}px;` : '',
    heightPx != null ? `height:${Number(heightPx)}px;` : '',
  ].join('');
  const styleAttr = sizeStyle ? ` style="${sizeStyle}"` : '';

  const attrs = {
    'data-component': 'window-frame',
    'data-window-id': String(windowId),
    'data-member-id': String(memberId),
    'data-is-primary': String(Boolean(isPrimary)),
    'data-is-focused': String(Boolean(isFocused)),
    'data-is-stale': String(Boolean(isStale)),
    'data-property-open': String(Boolean(propertyOpen)),
  };

  const html =
    `<section class="v2-window-frame"` +
    ` data-component="window-frame"` +
    ` data-window-id="${escapeHtml(windowId)}"` +
    ` data-member-id="${escapeHtml(memberId)}"` +
    ` data-is-primary="${Boolean(isPrimary)}"` +
    ` data-is-focused="${Boolean(isFocused)}"` +
    ` data-is-stale="${Boolean(isStale)}"` +
    ` data-property-open="${Boolean(propertyOpen)}"` +
    styleAttr +
    `>` +
    resizeHandlesHtml +
    header.html +
    `<div class="v2-window-body" data-role="window-body" data-terminal-body="true" data-member-id="${escapeHtml(memberId)}">${bodyHtml}</div>` +
    drawerHtml +
    `</section>`;

  const model = {
    windowId,
    memberId,
    title,
    status,
    freshness,
    isPrimary: Boolean(isPrimary),
    isFocused: Boolean(isFocused),
    isStale: Boolean(isStale),
    propertyOpen: Boolean(propertyOpen),
    availableWidth,
    widthPx,
    heightPx,
    enableResizeHandles: enableResizeHandles === true,
    resizeDirections: RESIZE_DIRECTIONS,
    header: header.model,
  };

  return { html, model, attrs };
}
