export const DEFAULT_PRIMARY_RATIO = 0.42;
export const MIN_PRIMARY_RATIO = 0.24;
export const MAX_PRIMARY_RATIO = 0.72;
export const MIN_PANE_WIDTH = 180;
export const MIN_PANE_HEIGHT = 120;
export const DEFAULT_PREVIEW_VIEWPORT = Object.freeze({
  zoom: 1,
  panX: 0,
  panY: 0,
});

const STALE_REASON = 'Member removed from workspace';
const DEFAULT_PEER_ROW_HEIGHT = 220;

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

const nowIso = () => new Date().toISOString();

const unique = (values) => [...new Set(values.filter(Boolean))];

function normalizeMember(member) {
  if (typeof member === 'string' || typeof member === 'number') {
    return {
      memberId: String(member),
      removedFromWorkspace: false,
      primary: false,
    };
  }

  if (!member || typeof member !== 'object') {
    return null;
  }

  const memberId = member.memberId ?? member.id;
  if (memberId == null || memberId === '') {
    return null;
  }

  return {
    memberId: String(memberId),
    removedFromWorkspace: member.removedFromWorkspace === true,
    primary: member.primary === true || member.isPrimary === true,
  };
}

function normalizeMembers(members) {
  return Array.isArray(members)
    ? members.map(normalizeMember).filter(Boolean)
    : [];
}

function memberIdOf(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (value && typeof value === 'object') {
    return value.memberId ?? value.id ?? null;
  }
  return null;
}

function clonePreviewViewport(viewport = DEFAULT_PREVIEW_VIEWPORT) {
  return {
    zoom: clamp(Number(viewport?.zoom ?? DEFAULT_PREVIEW_VIEWPORT.zoom), 0.5, 2.2),
    panX: Number(viewport?.panX ?? DEFAULT_PREVIEW_VIEWPORT.panX),
    panY: Number(viewport?.panY ?? DEFAULT_PREVIEW_VIEWPORT.panY),
  };
}

function cloneLayout(layout) {
  return {
    ...layout,
    peerMemberIds: [...(layout.peerMemberIds || [])],
    memberSlots: (layout.memberSlots || []).map((slot) => ({ ...slot })),
    peerRowHeights: Object.fromEntries(
      Object.entries(layout.peerRowHeights || {}).map(([key, value]) => [key, Number(value)]),
    ),
    windowSizes: Object.fromEntries(
      Object.entries(layout.windowSizes || {}).map(([key, value]) => [key, { ...value }]),
    ),
    openPropertyByWindow: { ...(layout.openPropertyByWindow || {}) },
    previewViewport: clonePreviewViewport(layout.previewViewport),
  };
}

function makeSlot(memberId, slotRole, stale = false) {
  return {
    memberId,
    slotRole,
    stale,
    staleReason: stale ? STALE_REASON : null,
  };
}

export function createDefaultSessionLayout({
  accountId = 'default',
  workspaceId = 'ws-default',
  members = [],
} = {}) {
  const normalizedMembers = normalizeMembers(members);
  const healthyMembers = normalizedMembers.filter((member) => !member.removedFromWorkspace);
  const primaryMember = healthyMembers.find((member) => member.primary)
    || healthyMembers[0]
    || normalizedMembers[0]
    || null;
  const primaryMemberId = primaryMember?.memberId || null;
  const peerMemberIds = normalizedMembers
    .map((member) => member.memberId)
    .filter((memberId) => memberId !== primaryMemberId);
  const memberSlots = normalizedMembers.map((member) => makeSlot(
    member.memberId,
    member.memberId === primaryMemberId ? 'primary' : 'peer',
    member.removedFromWorkspace,
  ));

  return {
    accountId,
    workspaceId,
    primaryMemberId,
    peerMemberIds,
    memberSlots,
    primaryRatio: DEFAULT_PRIMARY_RATIO,
    peerColumnSplitRatio: 0.5,
    peerRowHeights: {},
    windowSizes: {},
    openPropertyByWindow: {},
    mobileMode: 'focus',
    focusedMemberId: primaryMemberId,
    previewViewport: clonePreviewViewport(DEFAULT_PREVIEW_VIEWPORT),
    updatedAt: nowIso(),
  };
}

export function reconcileWorkspaceLayout(savedLayout, currentWorkspaceMembers = []) {
  const saved = savedLayout && typeof savedLayout === 'object' ? savedLayout : {};
  const currentMembers = normalizeMembers(currentWorkspaceMembers);
  const currentById = new Map(currentMembers.map((member) => [member.memberId, member]));
  const currentHealthyIds = currentMembers
    .filter((member) => !member.removedFromWorkspace)
    .map((member) => member.memberId);

  const savedSlots = Array.isArray(saved.memberSlots) ? saved.memberSlots : [];
  const legacySlots = Array.isArray(saved.slots) ? saved.slots : [];
  const savedSlotIds = savedSlots
    .map((slot) => memberIdOf(slot?.memberId ?? slot))
    .filter(Boolean);
  const legacySlotIds = legacySlots.map(memberIdOf).filter(Boolean);
  const savedPeerIds = Array.isArray(saved.peerMemberIds)
    ? saved.peerMemberIds.map(memberIdOf).filter(Boolean)
    : [];
  const savedPrimaryId = memberIdOf(saved.primaryMemberId);

  const savedIds = unique([
    ...legacySlotIds,
    ...savedSlotIds,
    savedPrimaryId,
    ...savedPeerIds,
  ]);
  const primaryCandidate = savedPrimaryId || legacySlotIds[0] || savedSlotIds[0] || currentHealthyIds[0] || null;
  const primaryMemberId = primaryCandidate && currentHealthyIds.includes(primaryCandidate)
    ? primaryCandidate
    : currentHealthyIds[0] || null;

  const peerMemberIds = [];
  const appendHealthyPeer = (memberId) => {
    if (!memberId || memberId === primaryMemberId || peerMemberIds.includes(memberId)) {
      return;
    }
    if (currentById.has(memberId) && !currentById.get(memberId).removedFromWorkspace) {
      peerMemberIds.push(memberId);
    }
  };

  for (const memberId of savedPeerIds) {
    appendHealthyPeer(memberId);
  }
  for (const slot of savedSlots) {
    if (slot?.slotRole === 'peer' || slot?.slotRole === undefined) {
      appendHealthyPeer(memberIdOf(slot?.memberId ?? slot));
    }
  }
  for (const memberId of legacySlotIds) {
    appendHealthyPeer(memberId);
  }
  for (const memberId of currentHealthyIds) {
    appendHealthyPeer(memberId);
  }

  const slotIds = unique([...savedIds, ...currentHealthyIds]);
  const memberSlots = slotIds.map((memberId) => {
    const member = currentById.get(memberId);
    const stale = !member || member.removedFromWorkspace;
    return makeSlot(
      memberId,
      memberId === primaryMemberId ? 'primary' : 'peer',
      stale,
    );
  });

  const focusedCandidate = memberIdOf(saved.focusedMemberId);
  const focusedMemberId = focusedCandidate && currentHealthyIds.includes(focusedCandidate)
    ? focusedCandidate
    : primaryMemberId || currentHealthyIds[0] || null;

  const peerRowHeights = {};
  for (const [rowIndex, height] of Object.entries(saved.peerRowHeights || {})) {
    const numericHeight = Number(height);
    if (Number.isFinite(numericHeight)) {
      peerRowHeights[rowIndex] = Math.max(MIN_PANE_HEIGHT, numericHeight);
    }
  }

  const windowSizes = {};
  for (const [windowId, size] of Object.entries(saved.windowSizes || {})) {
    const widthPx = Number(size?.widthPx);
    const heightPx = Number(size?.heightPx);
    windowSizes[windowId] = {
      widthPx: Number.isFinite(widthPx) ? Math.max(MIN_PANE_WIDTH, widthPx) : MIN_PANE_WIDTH,
      heightPx: Number.isFinite(heightPx) ? Math.max(MIN_PANE_HEIGHT, heightPx) : MIN_PANE_HEIGHT,
    };
  }

  return {
    accountId: saved.accountId ?? 'default',
    workspaceId: saved.workspaceId ?? 'ws-default',
    primaryMemberId,
    peerMemberIds,
    memberSlots,
    primaryRatio: clamp(
      Number(saved.primaryRatio ?? DEFAULT_PRIMARY_RATIO),
      MIN_PRIMARY_RATIO,
      MAX_PRIMARY_RATIO,
    ),
    peerColumnSplitRatio: clamp(
      Number(saved.peerColumnSplitRatio ?? 0.5),
      0.01,
      0.99,
    ),
    peerRowHeights,
    windowSizes,
    openPropertyByWindow: Object.fromEntries(
      Object.entries(saved.openPropertyByWindow || {}).map(([windowId, open]) => [windowId, open === true]),
    ),
    mobileMode: saved.mobileMode === 'focus' ? 'focus' : 'preview',
    focusedMemberId,
    previewViewport: clonePreviewViewport(saved.previewViewport),
    updatedAt: saved.updatedAt || nowIso(),
  };
}

export function promotePrimaryMember(layout, memberId) {
  const next = cloneLayout(layout);
  const allMemberIds = unique([
    next.primaryMemberId,
    ...(next.peerMemberIds || []),
    ...(next.memberSlots || []).map((slot) => slot.memberId),
  ]);

  if (!allMemberIds.includes(memberId)) {
    throw new Error(`Unknown memberId: ${memberId}`);
  }

  const previousPrimaryId = next.primaryMemberId;
  next.primaryMemberId = memberId;
  next.peerMemberIds = unique([
    previousPrimaryId,
    ...(next.peerMemberIds || []),
  ]).filter((id) => id && id !== memberId);
  next.memberSlots = next.memberSlots.map((slot) => ({
    ...slot,
    slotRole: slot.memberId === memberId ? 'primary' : 'peer',
  }));
  next.updatedAt = nowIso();
  return next;
}

export function removeStaleMemberSlot(layout, memberId) {
  const next = cloneLayout(layout);
  const slot = next.memberSlots.find((candidate) => candidate.memberId === memberId);
  if (!slot) {
    throw new Error(`Unknown memberId: ${memberId}`);
  }
  if (!slot.stale) {
    throw new Error('Only stale member slots can be removed');
  }

  next.memberSlots = next.memberSlots.filter((candidate) => candidate.memberId !== memberId);
  next.peerMemberIds = next.peerMemberIds.filter((candidate) => candidate !== memberId);

  if (next.primaryMemberId === memberId) {
    const healthyPeer = next.memberSlots.find((candidate) => (
      candidate.slotRole === 'peer' && !candidate.stale
    ))?.memberId || null;
    next.primaryMemberId = healthyPeer;
    next.peerMemberIds = next.peerMemberIds.filter((candidate) => candidate !== healthyPeer);
    next.memberSlots = next.memberSlots.map((candidate) => ({
      ...candidate,
      slotRole: candidate.memberId === healthyPeer ? 'primary' : 'peer',
    }));
  }

  if (next.focusedMemberId === memberId) {
    next.focusedMemberId = next.primaryMemberId || next.peerMemberIds[0] || null;
  }
  next.updatedAt = nowIso();
  return next;
}

export function toggleWindowPropertyDrawer(layout, windowId, forceOpen) {
  const next = cloneLayout(layout);
  const currentValue = next.openPropertyByWindow[windowId] === true;
  next.openPropertyByWindow[windowId] = typeof forceOpen === 'boolean'
    ? forceOpen
    : !currentValue;
  next.updatedAt = nowIso();
  return next;
}
