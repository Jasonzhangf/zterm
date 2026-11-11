export const DEFAULT_PEER_ROW_HEIGHT = 220;
export const SPLIT_GUTTER_WIDTH_PX = 8;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const escapeAttr = (value) => String(value ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function cloneLayout(layout) {
  return {
    ...layout,
    peerMemberIds: [...(layout.peerMemberIds || [])],
    memberSlots: (layout.memberSlots || []).map((slot) => ({ ...slot })),
    peerRowHeights: Object.fromEntries(Object.entries(layout.peerRowHeights || {}).map(([key, value]) => [key, Number(value)])),
    windowSizes: Object.fromEntries(Object.entries(layout.windowSizes || {}).map(([key, value]) => [key, { ...value }])),
    openPropertyByWindow: { ...(layout.openPropertyByWindow || {}) },
    previewViewport: { zoom: layout.previewViewport?.zoom ?? 1, panX: layout.previewViewport?.panX ?? 0, panY: layout.previewViewport?.panY ?? 0 },
  };
}
function defaultWindowSize({ windowId, layout, containerWidth, containerHeight }) {
  const existing = layout.windowSizes?.[windowId];
  const defaultWidth = windowId === 'window-primary' ? Math.round((layout.primaryRatio ?? 0.42) * containerWidth) : 180;
  const defaultHeight = windowId === 'window-primary' ? containerHeight : 240;
  return {
    widthPx: Number.isFinite(existing?.widthPx) ? Math.max(180, existing.widthPx) : defaultWidth,
    heightPx: Number.isFinite(existing?.heightPx) ? Math.max(120, existing.heightPx) : defaultHeight,
  };
}
function peerRatioBounds(layout, containerWidth) {
  const primaryRatio = clamp(layout.primaryRatio ?? 0.42, 0.24, 0.72);
  const peerAreaWidth = containerWidth * (1 - primaryRatio);
  if (!Number.isFinite(peerAreaWidth) || peerAreaWidth <= 2 * 180) {
    return { min: 0.5, max: 0.5, peerAreaWidth };
  }
  return { min: 180 / peerAreaWidth, max: 1 - 180 / peerAreaWidth, peerAreaWidth };
}
function primaryRatioBounds(containerWidth) {
  return {
    min: Math.max(0.24, 180 / containerWidth),
    max: Math.min(0.72, (containerWidth - 2 * 180) / containerWidth),
  };
}
export function applyBorderDrag(layout = {}, { kind = 'vertical-main', windowId = null, edge = 'e', deltaX = 0, deltaY = 0, rowIndex = 0, containerWidth = 1280, containerHeight = 760 } = {}) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    throw new RangeError('containerWidth must be positive');
  }
  if (!Number.isFinite(containerHeight) || containerHeight <= 0) {
    throw new RangeError('containerHeight must be positive');
  }
  const next = cloneLayout(layout);
  const { min: minPrimaryRatio, max: maxPrimaryRatio } = primaryRatioBounds(containerWidth);
  const clampPrimaryRatio = (value) => clamp(value, minPrimaryRatio, maxPrimaryRatio);
  if (kind === 'vertical-main' || (kind !== 'window-border' && windowId === 'window-primary' && edge === 'e')) {
    let dragDeltaX = edge === 'w' ? -deltaX : deltaX;
    let newRatio = next.primaryRatio + dragDeltaX / containerWidth;
    newRatio = clampPrimaryRatio(newRatio);
    next.primaryRatio = newRatio;
    return next;
  }
  if (kind === 'vertical-peer-col' || (kind !== 'window-border' && windowId && (edge === 'e' || edge === 'w'))) {
    const { min: minColRatio, max: maxColRatio, peerAreaWidth } = peerRatioBounds(next, containerWidth);
    let dragDeltaX = edge === 'w' ? -deltaX : deltaX;
    let newColRatio = next.peerColumnSplitRatio;
    if (Number.isFinite(peerAreaWidth) && peerAreaWidth > 2 * 180 && minColRatio <= maxColRatio) {
      newColRatio = clamp(next.peerColumnSplitRatio + dragDeltaX / peerAreaWidth, minColRatio, maxColRatio);
    }
    next.peerColumnSplitRatio = newColRatio;
    return next;
  }
  if (kind === 'horizontal-peer-row' || (kind !== 'window-border' && windowId && (edge === 's' || edge === 'n'))) {
    const rowKey = String(rowIndex ?? 0);
    const currentHeight = Number.isFinite(next.peerRowHeights?.[rowKey]) ? next.peerRowHeights[rowKey] : DEFAULT_PEER_ROW_HEIGHT;
    const newHeight = edge === 'n' ? currentHeight - deltaY : currentHeight + deltaY;
    next.peerRowHeights[rowKey] = Math.max(120, newHeight);
    return next;
  }
  if (kind === 'window-border' && windowId) {
    const size = defaultWindowSize({ windowId, layout: next, containerWidth, containerHeight });
    let newWidth = size.widthPx;
    let newHeight = size.heightPx;
    switch (edge) {
      case 'e': newWidth += deltaX; break;
      case 'w': newWidth -= deltaX; break;
      case 's': newHeight += deltaY; break;
      case 'n': newHeight -= deltaY; break;
      case 'ne': newWidth += deltaX; newHeight -= deltaY; break;
      case 'nw': newWidth -= deltaX; newHeight -= deltaY; break;
      case 'se': newWidth += deltaX; newHeight += deltaY; break;
      case 'sw': newWidth -= deltaX; newHeight += deltaY; break;
    }
    newWidth = Math.max(180, newWidth);
    newHeight = Math.max(120, newHeight);
    next.windowSizes[windowId] = { widthPx: newWidth, heightPx: newHeight };
    const peerAreaWidth = containerWidth * (1 - next.primaryRatio);
    const horizontalEdge = ['e', 'w', 'ne', 'nw', 'se', 'sw'].includes(edge);
    const verticalEdge = ['s', 'n', 'ne', 'nw', 'se', 'sw'].includes(edge);
    if (windowId === 'window-primary' && horizontalEdge) {
      const dragDeltaX = ['e', 'ne', 'se'].includes(edge) ? deltaX : -deltaX;
      const bounds = primaryRatioBounds(containerWidth);
      next.primaryRatio = clamp(next.primaryRatio + dragDeltaX / containerWidth, bounds.min, bounds.max);
    }
    if (windowId !== 'window-primary' && horizontalEdge) {
      const dragDeltaX = ['e', 'ne', 'se'].includes(edge) ? deltaX : -deltaX;
      const { min: minColRatio, max: maxColRatio } = peerRatioBounds(next, containerWidth);
      if (peerAreaWidth > 2 * 180 && minColRatio <= maxColRatio) {
        next.peerColumnSplitRatio = clamp(next.peerColumnSplitRatio + dragDeltaX / peerAreaWidth, minColRatio, maxColRatio);
      }
    }
    if (windowId !== 'window-primary' && verticalEdge) {
      const rowKey = String(rowIndex ?? 0);
      const heightChange = ['s', 'ne', 'se'].includes(edge) ? deltaY : -deltaY;
      next.peerRowHeights[rowKey] = Math.max(120, size.heightPx + heightChange);
    }
    return next;
  }
  return next;
}
export function renderDefaultWindowFrame({ windowId = 'window-unknown', memberId = '', title = '', status = '', primary = false, widthPx = 320, heightPx = 240, terminalBodyHtml = '', propertyPanelHtml = '', propertyOpen = false, resizeHandles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] } = {}) {
  const handlesHtml = resizeHandles.map((direction) => `<div class="v2-resize-handle v2-resize-handle-${escapeHtml(direction)}" data-resize-handle="${escapeHtml(direction)}" data-window-id="${escapeAttr(windowId)}" data-member-id="${escapeAttr(memberId)}"></div>`).join('');
  return [
    `<div class="v2-window-frame" data-component="window-frame" data-window-id="${escapeAttr(windowId)}" data-member-id="${escapeAttr(memberId)}" data-primary="${primary}" style="width:${Math.round(widthPx)}px;height:${Math.round(heightPx)}px">`,
    `  <div class="v2-window-header" data-component="window-header" data-window-id="${escapeAttr(windowId)}" data-member-id="${escapeAttr(memberId)}" style="height:32px">`,
    `    <span class="v2-window-title" data-role="window-title">${escapeHtml(title)}</span>`,
    `    <span class="v2-window-status" data-role="window-status">${escapeHtml(status)}</span>`,
    `    <div class="v2-window-actions"></div>`,
    `  </div>`,
    `  <div class="v2-terminal-body" data-terminal-body="true" data-window-id="${escapeAttr(windowId)}" data-member-id="${escapeAttr(memberId)}" style="width:${Math.round(widthPx)}px;height:${Math.round(heightPx - 32)}px">${escapeHtml(terminalBodyHtml)}</div>`,
    `  <div class="v2-window-resize-handles" data-window-id="${escapeAttr(windowId)}" data-member-id="${escapeAttr(memberId)}" data-resize-handle="n|s|e|w|ne|nw|se|sw">${handlesHtml}</div>`,
    `  <div class="v2-window-property-drawer" data-role="window-property-drawer" data-window-id="${escapeAttr(windowId)}" data-member-id="${escapeAttr(memberId)}" ${propertyOpen ? '' : 'hidden'}>${escapeHtml(propertyPanelHtml)}</div>`,
    `</div>`,
  ].join('\n');
}
export function renderSplitLayout({ layout, primaryHtml = '', peerGridHtml = '', containerWidth = 1280, containerHeight = 760 } = {}) {
  if (!layout) {
    throw new Error('layout is required');
  }
  const primaryRatio = clamp(layout.primaryRatio ?? 0.42, 0.24, 0.72);
  const primaryWidthPx = Math.round(primaryRatio * containerWidth);
  const peerAreaWidthPx = containerWidth - primaryWidthPx;
  const peerColRatio = clamp(layout.peerColumnSplitRatio ?? 0.5, 0.01, 0.99);
  const peerCol0WidthPx = Math.round(peerAreaWidthPx * peerColRatio);
  const peerCol1WidthPx = peerAreaWidthPx - peerCol0WidthPx;
  const html = [
    `<div class="v2-split-layout" data-component="split-layout" data-primary-ratio="${primaryRatio}" data-peer-col-ratio="${peerColRatio}" style="display:flex;width:${containerWidth}px;height:${containerHeight}px">`,
    `  <div class="v2-split-pane v2-split-pane-primary" data-component="window-frame" data-window-id="window-primary" data-member-id="${escapeAttr(layout.primaryMemberId || '')}" style="width:${primaryWidthPx}px;height:${containerHeight}px">${primaryHtml}</div>`,
    `  <div class="v2-split-gutter v2-split-gutter-vertical" data-splitter="vertical-main" data-edge="e" role="separator" aria-orientation="vertical" style="width:${SPLIT_GUTTER_WIDTH_PX}px;height:${containerHeight}px"></div>`,
    `  <div class="v2-split-pane v2-split-pane-peer-area" style="width:${peerAreaWidthPx}px;height:${containerHeight}px">`,
    `    <div class="v2-split-gutter v2-split-gutter-peer-col" data-splitter="vertical-peer-col" data-edge="w" role="separator" aria-orientation="vertical" style="width:${SPLIT_GUTTER_WIDTH_PX}px;height:${containerHeight}px"></div>`,
    `    <div class="v2-split-pane v2-split-pane-peer-col0" style="width:${peerCol0WidthPx}px;height:${containerHeight}px">${peerGridHtml}</div>`,
    `    <div class="v2-split-gutter v2-split-gutter-peer-col" data-splitter="vertical-peer-col" data-edge="e" role="separator" aria-orientation="vertical" style="width:${SPLIT_GUTTER_WIDTH_PX}px;height:${containerHeight}px"></div>`,
    `    <div class="v2-split-pane v2-split-pane-peer-col1" style="width:${peerCol1WidthPx}px;height:${containerHeight}px"></div>`,
    `  </div>`,
    `</div>`,
  ].join('\n');
  return {
    html,
    model: {
      primaryWidthPx,
      peerAreaWidthPx,
      peerCol0WidthPx,
      peerCol1WidthPx,
      gutterWidthPx: SPLIT_GUTTER_WIDTH_PX,
      containerWidth,
      containerHeight,
      primaryRatio,
      peerColumnSplitRatio: peerColRatio,
    },
  };
}
