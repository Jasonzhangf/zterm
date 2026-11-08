import { renderDefaultWindowFrame } from './split-layout.mjs';

export const DESKTOP_PEER_SLOTS = 4;

const MAIN_GUTTER_PX = 8;
const PEER_GUTTER_PX = 6;
const GRID_GAP_PX = 8;
const SWITCHER_HEIGHT_PX = 30;

const escapeAttr = (value) => String(value ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function memberName(memberId, membersById) {
  const member = membersById && typeof membersById === 'object' ? membersById[memberId] : undefined;
  if (member && typeof member === 'object') {
    return member.name || member.displayName || memberId;
  }
  if (typeof member === 'string') {
    return member;
  }
  return memberId || '';
}

function memberStatus(memberId, membersById) {
  const member = membersById && typeof membersById === 'object' ? membersById[memberId] : undefined;
  if (member && typeof member === 'object') {
    return member.status || '';
  }
  return '';
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function selectVisiblePeerIds(peerMemberIds = [], slotCount = DESKTOP_PEER_SLOTS) {
  return [...peerMemberIds].slice(0, Math.max(1, slotCount));
}

export function renderSessionWorkbench({
  layout,
  membersById = {},
  terminalBodiesByMember = {},
  propertyPanelsByWindow = {},
  containerWidth = 1280,
  containerHeight = 760,
  renderFrame = null,
} = {}) {
  if (!layout) {
    throw new Error('layout is required');
  }

  const width = Math.max(320, Number(containerWidth) || 1280);
  const height = Math.max(320, Number(containerHeight) || 760);
  const primaryRatio = clamp(layout.primaryRatio ?? 0.42, 0.24, 0.72);
  const peerMemberIds = layout.peerMemberIds || [];
  const primaryMemberId = layout.primaryMemberId || '';
  const renderFrameFn = typeof renderFrame === 'function' ? renderFrame : renderDefaultWindowFrame;

  const usableWidth = Math.max(320, width - MAIN_GUTTER_PX - PEER_GUTTER_PX);
  const primaryWidthPx = Math.round(usableWidth * primaryRatio);
  const peerAreaWidthPx = usableWidth - primaryWidthPx;
  const peerColRatio = clamp(layout.peerColumnSplitRatio ?? 0.5, 0.01, 0.99);
  const peerCol0WidthPx = Math.round((peerAreaWidthPx - GRID_GAP_PX) * peerColRatio);
  const peerCol1WidthPx = Math.max(0, peerAreaWidthPx - GRID_GAP_PX - peerCol0WidthPx);
  const gridHeightPx = Math.max(240, height - SWITCHER_HEIGHT_PX - GRID_GAP_PX);
  const peerRowHeightPx = Math.floor((gridHeightPx - GRID_GAP_PX) / 2);

  const primaryWindowId = 'window-primary';
  const primaryHtml = renderFrameFn({
    windowId: primaryWindowId,
    memberId: primaryMemberId,
    title: memberName(primaryMemberId, membersById) || 'Primary',
    status: memberStatus(primaryMemberId, membersById),
    primary: true,
    isPrimary: true,
    availableWidth: primaryWidthPx,
    terminalBodyHtml: terminalBodiesByMember[primaryMemberId] || '',
    bodyHtml: terminalBodiesByMember[primaryMemberId] || '',
    propertyPanelHtml: propertyPanelsByWindow[primaryWindowId] || '',
    propertyOpen: layout.openPropertyByWindow?.[primaryWindowId] === true,
  });

  const visiblePeerIds = selectVisiblePeerIds(peerMemberIds);
  const hiddenPeerIds = peerMemberIds.slice(visiblePeerIds.length);
  const peerWindows = [];
  const peerCells = visiblePeerIds.map((memberId, index) => {
    const colIndex = index % 2;
    const rowIndex = Math.floor(index / 2);
    const widthPx = colIndex === 0 ? peerCol0WidthPx : peerCol1WidthPx;
    const windowId = `window-peer-${memberId}`;
    const altWindowId = `window-${memberId}`;
    const propertyOpen = layout.openPropertyByWindow?.[windowId] === true
      || layout.openPropertyByWindow?.[altWindowId] === true;
    const propertyPanelHtml = propertyPanelsByWindow[windowId] || propertyPanelsByWindow[altWindowId] || '';
    peerWindows.push({
      windowId,
      memberId,
      slotRole: 'peer',
      rowIndex,
      colIndex,
      widthPx,
      heightPx: peerRowHeightPx,
    });
    const frameHtml = renderFrameFn({
      windowId,
      memberId,
      title: memberName(memberId, membersById) || memberId,
      status: memberStatus(memberId, membersById),
      primary: false,
      isPrimary: false,
      availableWidth: widthPx,
      terminalBodyHtml: terminalBodiesByMember[memberId] || '',
      bodyHtml: terminalBodiesByMember[memberId] || '',
      propertyPanelHtml,
      propertyOpen,
      resizeHandles: ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'],
    });
    return `<div class="v2-peer-window-cell" data-row-index="${rowIndex}" data-col-index="${colIndex}" data-member-id="${escapeAttr(memberId)}" style="min-width:0;min-height:0;overflow:hidden">${frameHtml}</div>`;
  }).join('');

  const switcherMembers = [primaryMemberId, ...peerMemberIds].filter(Boolean);
  const switcherHtml = switcherMembers.length > 1
    ? `<div class="v2-member-switcher" data-role="member-switcher" aria-label="Switch primary window">
        <span class="v2-member-switcher-label">Windows</span>
        ${switcherMembers.map((memberId) => {
          const isCurrent = memberId === primaryMemberId;
          return `<button type="button" class="v2-member-switch${isCurrent ? ' is-current' : ''}" data-action="promote-primary" data-member-id="${escapeAttr(memberId)}" aria-pressed="${isCurrent}">${escapeAttr(memberName(memberId, membersById) || memberId)}</button>`;
        }).join('')}
      </div>`
    : '';

  const html = [
    `<div class="v2-split-layout" data-component="split-layout" data-primary-ratio="${primaryRatio}" data-peer-col-ratio="${peerColRatio}" data-visible-peer-count="${visiblePeerIds.length}" data-hidden-peer-count="${hiddenPeerIds.length}" style="display:flex;width:100%;height:100%;min-height:0;min-width:0">`,
    `  <div class="v2-split-pane v2-split-pane-primary" data-role="primary-pane" data-window-id="${primaryWindowId}" data-member-id="${escapeAttr(primaryMemberId)}" style="flex:0 0 calc((100% - ${MAIN_GUTTER_PX + PEER_GUTTER_PX}px) * ${primaryRatio});height:100%;min-width:0;min-height:0">${primaryHtml}</div>`,
    `  <div class="v2-split-gutter v2-split-gutter-vertical" data-splitter="vertical-main" data-edge="e" role="separator" aria-orientation="vertical" style="width:${MAIN_GUTTER_PX}px;flex:0 0 ${MAIN_GUTTER_PX}px;height:100%"></div>`,
    `  <div class="v2-split-pane v2-split-pane-peer-area" data-role="peer-area" style="flex:1 1 auto;height:100%;min-width:0;min-height:0;display:flex;flex-direction:column">`,
    `    ${switcherHtml}`,
    `    <div class="v2-peer-window-grid" data-role="peer-scroll-grid" data-visible-peer-count="${visiblePeerIds.length}" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:${GRID_GAP_PX}px;flex:1 1 auto;min-height:0;min-width:0;overflow:hidden">${peerCells}</div>`,
    `  </div>`,
    `  <div class="v2-split-gutter v2-split-gutter-peer-col" data-splitter="vertical-peer-col" data-edge="e" role="separator" aria-orientation="vertical" style="width:${PEER_GUTTER_PX}px;flex:0 0 ${PEER_GUTTER_PX}px;height:100%"></div>`,
    `</div>`,
  ].join('\n');

  return {
    html,
    model: {
      primaryWindowId,
      primaryMemberId,
      peerWindows,
      visiblePeerIds,
      hiddenPeerIds,
      totalMemberCount: 1 + peerMemberIds.length,
      rightGridScrollable: false,
      primaryRatio,
      peerColumnSplitRatio: peerColRatio,
      primaryWidthPx,
      peerAreaWidthPx,
      peerCol0WidthPx,
      peerCol1WidthPx,
      peerRowHeightPx,
      switcherHeightPx: SWITCHER_HEIGHT_PX,
      containerWidth: width,
      containerHeight: height,
    },
  };
}
