import { renderDefaultWindowFrame } from './split-layout.mjs';

const escapeAttr = (value) => String(value ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function getOrderedSessionMembers(layout) {
  return [layout?.primaryMemberId, ...(layout?.peerMemberIds || [])].filter(Boolean);
}

export function stepFocusedMember(layout, direction = 'next', { targetDescriptor = {} } = {}) {
  const orderedMembers = getOrderedSessionMembers(layout);
  if (targetDescriptor.insideTerminalBody === true) {
    return {
      ...layout,
      switched: false,
      previousMemberId: null,
      orderedMembers,
    };
  }
  const isNext = direction === 'next' || direction === 'down';
  const isPrevious = direction === 'prev' || direction === 'up';
  if (!isNext && !isPrevious) {
    throw new Error(`Unsupported focus direction: ${direction}`);
  }
  if (orderedMembers.length === 0) {
    return {
      ...layout,
      focusedMemberId: null,
      mobileMode: 'preview',
      switched: false,
      previousMemberId: null,
      orderedMembers,
    };
  }
  const currentIndex = Math.max(0, orderedMembers.indexOf(layout.focusedMemberId));
  const step = isNext ? 1 : -1;
  const nextIndex = (currentIndex + step + orderedMembers.length) % orderedMembers.length;
  const focusedMemberId = orderedMembers[nextIndex];
  return {
    ...layout,
    mobileMode: 'focus',
    focusedMemberId,
    switched: focusedMemberId !== layout.focusedMemberId,
    previousMemberId: layout.focusedMemberId || null,
    orderedMembers,
  };
}

export function enterMemberFocus(layout, memberId) {
  const orderedMembers = getOrderedSessionMembers(layout);
  if (!orderedMembers.includes(memberId)) {
    throw new Error(`Unknown memberId: ${memberId}`);
  }
  return {
    ...layout,
    mobileMode: 'focus',
    focusedMemberId: memberId,
  };
}

export function exitMemberFocusToPreview(layout) {
  return {
    ...layout,
    mobileMode: 'preview',
  };
}

export function renderSessionFocusView({ layout, membersById = {}, terminalBodiesByMember = {}, propertyPanelsByWindow = {}, renderFrame = null } = {}) {
  if (!layout) {
    throw new Error('layout is required');
  }
  const orderedMembers = getOrderedSessionMembers(layout);
  const focusedMemberId = layout.focusedMemberId || orderedMembers[0] || null;
  const index = focusedMemberId ? orderedMembers.indexOf(focusedMemberId) : -1;
  const total = orderedMembers.length;
  let frameHtml = '';
  if (focusedMemberId) {
    const member = membersById[focusedMemberId] && typeof membersById[focusedMemberId] === 'object' ? membersById[focusedMemberId] : {};
    const windowId = focusedMemberId === layout.primaryMemberId ? 'window-primary' : `window-peer-${focusedMemberId}`;
    const renderFrameFn = typeof renderFrame === 'function' ? renderFrame : renderDefaultWindowFrame;
    frameHtml = renderFrameFn({
      windowId,
      memberId: focusedMemberId,
      title: member.name || member.displayName || focusedMemberId,
      status: member.status || '',
      primary: focusedMemberId === layout.primaryMemberId,
      terminalBodyHtml: terminalBodiesByMember[focusedMemberId] || '',
      propertyPanelHtml: propertyPanelsByWindow[windowId] || '',
      propertyOpen: layout.openPropertyByWindow?.[windowId] === true,
    });
  }
  const arrowUp = '\u2191';
  const arrowDown = '\u2193';
  const twoD = '\u229A';
  const html = [
    `<div class="v2-session-focus-view" data-component="session-focus-view" data-focused-member-id="${escapeAttr(focusedMemberId || '')}">`,
    `  <div class="v2-focus-switch-bar">`,
    `    <button type="button" data-action="focus-prev-member">${arrowUp} Prev Member</button>`,
    `    <span data-role="focus-member-indicator">${index >= 0 ? index + 1 : 0} / ${total}</span>`,
    `    <button type="button" data-action="focus-next-member">${arrowDown} Next Member</button>`,
    `  </div>`,
    `  <div class="v2-focus-window" data-member-id="${escapeAttr(focusedMemberId || '')}">${frameHtml}</div>`,
    `  <button type="button" data-action="return-to-preview">${twoD} 2D Preview</button>`,
    `</div>`,
  ].join('\n');
  return {
    html,
    model: {
      focusedMemberId,
      index,
      total,
      mobileMode: layout.mobileMode,
      orderedMembers,
      previewViewport: { ...(layout.previewViewport || { zoom: 1, panX: 0, panY: 0 }) },
    },
  };
}
