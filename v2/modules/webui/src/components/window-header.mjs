import { escapeHtml } from './loadable.mjs';
import { renderStatusBadge } from './status-badge.mjs';

const CHAR_WIDTH = 6;
const CHIP_PADDING = 12;
const BUTTON_PADDING = 20;
const STATUS_WIDTH = 56;
const PRIMARY_WIDTH = 52;
const CONTAINER_PADDING = 12;
const WORK_STATUS_COMPACT_WIDTH = 512;
const MIN_TITLE_WIDTH_PX = 40;

function normalizeActions(actions = []) {
  return actions.map((a) => {
    if (typeof a === 'string') {
      return { id: a, label: a };
    }
    return {
      id: String(a?.id ?? ''),
      label: String(a?.label ?? a?.id ?? ''),
      workspaceId: a?.workspaceId != null ? String(a.workspaceId) : undefined,
      memberId: a?.memberId != null ? String(a.memberId) : undefined,
    };
  });
}

function normalizeWorkStatus(workStatus = null) {
  if (!workStatus || typeof workStatus !== 'object' || !workStatus.memberId) return null;
  return {
    workspaceId: String(workStatus.workspaceId ?? ''),
    memberId: String(workStatus.memberId),
    state: String(workStatus.state ?? 'loading'),
    boardState: String(workStatus.boardState ?? 'loading'),
    boardCount: Number.isFinite(workStatus.boardCount) ? workStatus.boardCount : null,
    ticketState: String(workStatus.ticketState ?? 'loading'),
    ticketCount: Number.isFinite(workStatus.ticketCount) ? workStatus.ticketCount : null,
  };
}

function buildWorkChip({ noun, shortNoun, state, count }) {
  // An unreachable work source must read as explicit unavailable. A bare
  // "?" looked like a broken placeholder instead of a truthful state.
  const value = state === 'unavailable' ? 'unavailable' : (state === 'loading' ? '...' : String(count ?? 0));
  return {
    state,
    count: state === 'ready' || state === 'empty' ? Number(count ?? 0) : null,
    full: `${noun} ${value}`,
    compact: `${shortNoun} ${value}`,
  };
}

function buildWorkStatusView(workStatus, compact) {
  if (!workStatus) return null;
  const board = buildWorkChip({ noun: 'Board', shortNoun: 'B', state: workStatus.boardState, count: workStatus.boardCount });
  const tickets = buildWorkChip({ noun: 'Tickets', shortNoun: 'T', state: workStatus.ticketState, count: workStatus.ticketCount });
  return {
    ...workStatus,
    compact,
    board,
    tickets,
    boardText: compact ? board.compact : board.full,
    ticketText: compact ? tickets.compact : tickets.full,
  };
}

function estimateWorkStatusWidth(view) {
  if (!view) return 0;
  return (view.boardText.length + view.ticketText.length) * CHAR_WIDTH + CHIP_PADDING * 2 + 4;
}

function renderWorkStatusHtml(view) {
  if (!view) return '';
  const chipTitle = (chip, noun) => {
    if (chip.state === 'loading') return `${noun}: loading`;
    if (chip.state === 'unavailable') return `${noun}: unavailable`;
    return `${noun}: ${chip.count} active`;
  };
  const chipHtml = (chip, noun, source, role) =>
    `<span class="v2-window-work-chip"` +
    ` data-role="${role}"` +
    ` data-source="${source}"` +
    ` data-state="${escapeHtml(chip.state)}"` +
    `${chip.count != null ? ` data-count="${chip.count}"` : ''}` +
    ` title="${escapeHtml(chipTitle(chip, noun))}">` +
    escapeHtml(source === 'board' ? view.boardText : view.ticketText) +
    `</span>`;
  const boardCountAttr = view.board.count != null ? ` data-board-count="${view.board.count}"` : '';
  const ticketCountAttr = view.tickets.count != null ? ` data-ticket-count="${view.tickets.count}"` : '';
  return `<span class="v2-window-work-status${view.compact ? ' v2-window-work-status--compact' : ''}"` +
    ` data-role="window-work-status"` +
    ` data-workspace-id="${escapeHtml(view.workspaceId)}"` +
    ` data-member-id="${escapeHtml(view.memberId)}"` +
    ` data-state="${escapeHtml(view.state)}"` +
    ` data-board-state="${escapeHtml(view.board.state)}"` +
    ` data-ticket-state="${escapeHtml(view.tickets.state)}"` +
    boardCountAttr +
    ticketCountAttr +
    `>` +
    chipHtml(view.board, 'Board', 'board', 'window-board-status') +
    chipHtml(view.tickets, 'Tickets', 'tickets', 'window-ticket-status') +
    `</span>`;
}

/**
 * Compute the single-line header layout with narrow-width priority.
 *
 * Hard contract:
 * - The header is always single line with `heightPx === 28` (<= 32px).
 * - `title + status + primaryAction` are always visible.
 * - `availableWidth < 260`: hide `machine` from the inline row and move all
 *   secondary actions into the overflow menu.
 * - `availableWidth < 200`: hide `role` from the inline row (into overflow
 *   details) and truncate `title` so estimated inline width <= availableWidth.
 * - `availableWidth >= 320`: keep up to 1 inline secondary action.
 * - `availableWidth >= 440`: keep all secondary actions inline.
 *
 * @param {object} [props]
 */
export function computeWindowHeaderLayout({
  windowId = '',
  memberId = '',
  title = '',
  status = 'unknown',
  freshness = 'fresh',
  role = '',
  machine = '',
  primaryAction = { id: 'toggle-property', label: 'Props' },
  secondaryActions = [],
  availableWidth = 360,
  overflowOpen = false,
  workStatus = null,
} = {}) {
  const width = Number.isFinite(Number(availableWidth)) ? Number(availableWidth) : 360;
  const primary = {
    id: String(primaryAction?.id ?? 'toggle-property'),
    label: String(primaryAction?.label ?? 'Props'),
  };
  const secondary = normalizeActions(secondaryActions);
  const workStatusView = buildWorkStatusView(normalizeWorkStatus(workStatus), width < WORK_STATUS_COMPACT_WIDTH);
  const workStatusWidth = estimateWorkStatusWidth(workStatusView);

  // Reserve a readable title before adding secondary chrome. Role, machine and
  // inline secondary actions degrade into the overflow menu instead of
  // collapsing the title to zero width.
  const baseReserved = STATUS_WIDTH + PRIMARY_WIDTH + CONTAINER_PADDING + workStatusWidth + MIN_TITLE_WIDTH_PX;
  let remaining = width - baseReserved;

  const roleWidth = role ? role.length * CHAR_WIDTH + CHIP_PADDING : 0;
  const showRole = roleWidth > 0 && remaining >= roleWidth;
  if (showRole) remaining -= roleWidth;

  const machineWidth = machine ? machine.length * CHAR_WIDTH + CHIP_PADDING : 0;
  const showMachine = machineWidth > 0 && remaining >= machineWidth;
  if (showMachine) remaining -= machineWidth;

  const inlineSecondaryActions = [];
  const overflowActions = [];
  for (const action of secondary) {
    const actionWidth = action.label.length * CHAR_WIDTH + BUTTON_PADDING;
    if (remaining >= actionWidth && inlineSecondaryActions.length < 2) {
      inlineSecondaryActions.push(action);
      remaining -= actionWidth;
    } else {
      overflowActions.push(action);
    }
  }
  const hasOverflowMenu = overflowActions.length > 0;

  const reserved =
    STATUS_WIDTH +
    PRIMARY_WIDTH +
    CONTAINER_PADDING +
    workStatusWidth +
    (showRole ? roleWidth : 0) +
    (showMachine ? machineWidth : 0) +
    inlineSecondaryActions.reduce((sum, a) => sum + a.label.length * CHAR_WIDTH + BUTTON_PADDING, 0);

  const titleEstimatedWidth = title.length * CHAR_WIDTH;
  const titleMaxWidthPx = Math.max(MIN_TITLE_WIDTH_PX, width - reserved);
  const estimatedInlineWidth =
    reserved + Math.min(titleEstimatedWidth, titleMaxWidthPx);

  return {
    windowId,
    memberId,
    title,
    status,
    freshness,
    singleLine: true,
    heightPx: 28,
    maxHeightPx: 32,
    whiteSpace: 'nowrap',
    primaryAction: primary,
    primaryActionVisible: true,
    secondaryActions: secondary,
    inlineSecondaryActions,
    overflowActions,
    hasOverflowMenu,
    overflowOpen,
    showRole,
    showMachine,
    showStatus: true,
    role,
    machine,
    workStatus: workStatusView,
    titleEstimatedWidth,
    titleMaxWidthPx,
    estimatedInlineWidth,
    availableWidth: width,
  };
}

/**
 * @param {object} [props] Same props accepted by computeWindowHeaderLayout.
 */
export function renderWindowHeader(props = {}) {
  const layout = computeWindowHeaderLayout(props);
  const badge = renderStatusBadge({
    state: layout.status,
    freshness: layout.freshness,
    observedAt: null,
    reason: null,
  });

  const titleStyle = `max-width:${layout.titleMaxWidthPx}px;min-width:40px;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;

  const roleHtml = layout.showRole && layout.role
    ? `<span class="v2-window-role" data-role="window-role">${escapeHtml(layout.role)}</span>`
    : '';
  const machineHtml = layout.showMachine && layout.machine
    ? `<span class="v2-window-machine" data-role="window-machine">${escapeHtml(layout.machine)}</span>`
    : '';
  const workStatusHtml = renderWorkStatusHtml(layout.workStatus);
  const inlineActionsHtml = layout.inlineSecondaryActions.map((a) =>
    `<button type="button" class="v2-window-secondary-action" data-action="${escapeHtml(a.id)}" data-window-id="${escapeHtml(layout.windowId)}" data-member-id="${escapeHtml(a.memberId ?? layout.memberId)}"${a.workspaceId != null ? ` data-workspace-id="${escapeHtml(a.workspaceId)}"` : ''}>${escapeHtml(a.label)}</button>`
  ).join('');
  const primaryHtml =
    `<button type="button" class="v2-window-primary-action"` +
    ` data-role="window-primary-action"` +
    ` data-action="${escapeHtml(layout.primaryAction.id)}"` +
    ` data-window-id="${escapeHtml(layout.windowId)}"` +
    ` data-member-id="${escapeHtml(layout.memberId)}">` +
    escapeHtml(layout.primaryAction.label) +
    `</button>`;
  const overflowTriggerHtml = layout.hasOverflowMenu
    ? `<button type="button" class="v2-window-overflow-trigger" data-role="window-overflow-trigger" data-action="toggle-window-overflow" data-window-id="${escapeHtml(layout.windowId)}" data-member-id="${escapeHtml(layout.memberId)}" aria-expanded="${layout.overflowOpen}">&#8943;</button>`
    : '';

  const overflowMenuHtml = layout.overflowOpen && layout.hasOverflowMenu
    ? `<div class="v2-window-overflow-menu" data-role="window-overflow-menu" data-window-id="${escapeHtml(layout.windowId)}" hidden="false">` +
      layout.overflowActions.map((a) =>
        `<button type="button" class="v2-window-overflow-action" data-action="${escapeHtml(a.id)}" data-window-id="${escapeHtml(layout.windowId)}" data-member-id="${escapeHtml(a.memberId ?? layout.memberId)}"${a.workspaceId != null ? ` data-workspace-id="${escapeHtml(a.workspaceId)}"` : ''}>${escapeHtml(a.label)}</button>`
      ).join('') +
      (!layout.showRole && layout.role
        ? `<span class="v2-window-overflow-role" data-role="window-overflow-role">${escapeHtml(layout.role)}</span>`
        : '') +
      (!layout.showMachine && layout.machine
        ? `<span class="v2-window-overflow-machine" data-role="window-overflow-machine">${escapeHtml(layout.machine)}</span>`
        : '') +
      `</div>`
    : '';

  const attrs = {
    'data-component': 'window-header',
    'data-window-id': String(layout.windowId),
    'data-member-id': String(layout.memberId),
    'data-single-line': 'true',
    'data-overflow-open': String(layout.overflowOpen),
  };

  const overflowStyle = layout.overflowOpen ? 'overflow:visible;' : 'overflow:hidden;';

  const html =
    `<header class="v2-window-header"` +
    ` data-component="window-header"` +
    ` data-window-id="${escapeHtml(layout.windowId)}"` +
    ` data-member-id="${escapeHtml(layout.memberId)}"` +
    ` data-single-line="true"` +
    ` data-overflow-open="${layout.overflowOpen}"` +
    ` style="height:28px;max-height:32px;display:flex;align-items:center;${overflowStyle}white-space:nowrap;">` +
    `<span class="v2-window-title" data-role="window-title" style="${titleStyle}">${escapeHtml(layout.title)}</span>` +
    `<span class="v2-window-status" data-role="window-status">${badge.html}</span>` +
    workStatusHtml +
    roleHtml +
    machineHtml +
    inlineActionsHtml +
    primaryHtml +
    overflowTriggerHtml +
    overflowMenuHtml +
    `</header>`;

  const model = { ...layout };

  return { html, model, attrs };
}
