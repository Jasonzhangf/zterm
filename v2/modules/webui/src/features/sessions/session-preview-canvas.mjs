import { DEFAULT_PREVIEW_VIEWPORT } from '../../state/session-layout.mjs';
import { renderDefaultWindowFrame } from './split-layout.mjs';

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const escapeAttr = (value) => String(value ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function shouldHijackTerminalGesture(targetDescriptor = {}) {
  if (targetDescriptor.insideTerminalBody === true) {
    return false;
  }
  if (targetDescriptor.dataset?.terminalBody === 'true') {
    return false;
  }
  if (targetDescriptor.closestTerminalViewport === true) {
    return false;
  }
  return true;
}

export function applyPreviewGesture(viewport = DEFAULT_PREVIEW_VIEWPORT, { type = 'pan', deltaX = 0, deltaY = 0, zoomFactor = 1, targetDescriptor = {} } = {}) {
  if (!shouldHijackTerminalGesture(targetDescriptor)) {
    return viewport;
  }
  const current = {
    zoom: viewport?.zoom ?? DEFAULT_PREVIEW_VIEWPORT.zoom,
    panX: viewport?.panX ?? DEFAULT_PREVIEW_VIEWPORT.panX,
    panY: viewport?.panY ?? DEFAULT_PREVIEW_VIEWPORT.panY,
  };
  if (type === 'pan') {
    return { ...current, panX: current.panX + deltaX, panY: current.panY + deltaY };
  }
  if (type === 'zoom') {
    return { ...current, zoom: clamp(current.zoom * zoomFactor, 0.5, 2.2) };
  }
  if (type === 'reset') {
    return { zoom: 1, panX: 0, panY: 0 };
  }
  return { ...current };
}

function orderedMemberIds(layout) {
  return [layout?.primaryMemberId, ...(layout?.peerMemberIds || [])].filter(Boolean);
}

export function renderSessionPreviewCanvas({ layout, membersById = {}, terminalBodiesByMember = {}, propertyPanelsByWindow = {}, renderFrame = null } = {}) {
  if (!layout) {
    throw new Error('layout is required');
  }
  const viewport = {
    zoom: layout.previewViewport?.zoom ?? DEFAULT_PREVIEW_VIEWPORT.zoom,
    panX: layout.previewViewport?.panX ?? DEFAULT_PREVIEW_VIEWPORT.panX,
    panY: layout.previewViewport?.panY ?? DEFAULT_PREVIEW_VIEWPORT.panY,
  };
  const renderFrameFn = typeof renderFrame === 'function' ? renderFrame : renderDefaultWindowFrame;
  const windows = orderedMemberIds(layout).map((memberId) => {
    const member = membersById[memberId] && typeof membersById[memberId] === 'object' ? membersById[memberId] : {};
    const windowId = memberId === layout.primaryMemberId ? 'window-primary' : `window-peer-${memberId}`;
    const frameHtml = renderFrameFn({
      windowId,
      memberId,
      title: member.name || member.displayName || memberId,
      status: member.status || '',
      primary: memberId === layout.primaryMemberId,
      widthPx: memberId === layout.primaryMemberId ? 340 : 260,
      heightPx: memberId === layout.primaryMemberId ? 240 : 180,
      terminalBodyHtml: terminalBodiesByMember[memberId] || '',
      propertyPanelHtml: propertyPanelsByWindow[windowId] || '',
      propertyOpen: layout.openPropertyByWindow?.[windowId] === true,
    });
    return { windowId, memberId, isPrimary: memberId === layout.primaryMemberId, html: frameHtml };
  });
  const frameHtml = windows.map((window) => `<div class="v2-preview-window" data-member-id="${escapeAttr(window.memberId)}">${window.html}<button type="button" data-action="enter-member-focus" data-member-id="${escapeAttr(window.memberId)}">Enter Focus</button></div>`).join('');
  const html = [
    `<div class="v2-session-preview-canvas" data-component="session-preview-canvas" data-zoom="${viewport.zoom}" data-pan-x="${viewport.panX}" data-pan-y="${viewport.panY}" style="position:relative;overflow:hidden">`,
    `  <div class="v2-preview-controls">`,
    `    <button type="button" data-action="preview-zoom-out">-</button>`,
    `    <button type="button" data-action="preview-zoom-in">+</button>`,
    `    <button type="button" data-action="preview-zoom-reset">Reset</button>`,
    `    <button type="button" data-action="preview-pan-up">Up</button>`,
    `    <button type="button" data-action="preview-pan-down">Down</button>`,
    `    <button type="button" data-action="preview-pan-left">Left</button>`,
    `    <button type="button" data-action="preview-pan-right">Right</button>`,
    `  </div>`,
    `  <div class="v2-preview-stage" style="transform:translate(${viewport.panX}px,${viewport.panY}px) scale(${viewport.zoom});transform-origin:top left">${frameHtml}</div>`,
    `</div>`,
  ].join('\n');
  return {
    html,
    model: {
      viewport,
      memberIds: windows.map((window) => window.memberId),
      windows: windows.map(({ html: frame, ...window }) => window),
      zoomControls: ['preview-zoom-in', 'preview-zoom-out', 'preview-zoom-reset'],
      panControls: ['preview-pan-up', 'preview-pan-down', 'preview-pan-left', 'preview-pan-right'],
    },
  };
}
