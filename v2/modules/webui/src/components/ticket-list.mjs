import { escapeHtml } from './loadable.mjs';

const FILTER_ALL = 'all';

/**
 * Ticket list with local status filtering. Status filtering is a query
 * projection only; it never mutates the ticket state machine.
 *
 * @param {{
 *   ticketsLoadable?: object,
 *   activeStatusFilter?: string,
 *   selectedTicketId?: string|null,
 * }} [props]
 */
export function renderTicketList({
  ticketsLoadable = { status: 'loading' },
  activeStatusFilter = FILTER_ALL,
  selectedTicketId = null,
} = {}) {
  const status = ticketsLoadable.status;
  const items = [];
  let error = null;
  let totalCount = 0;
  let filteredCount = 0;
  let bodyHtml;

  if (status === 'loading') {
    bodyHtml = `<div class="v2-ticket-list-skeleton" data-role="ticket-list-loading"></div>`;
  } else if (status === 'unavailable') {
    error = ticketsLoadable.error ?? null;
    bodyHtml = `<div class="v2-ticket-list-error" data-role="ticket-list-error">${escapeHtml(error && error.message ? error.message : 'Unable to load tickets')}</div>`;
  } else {
    const tickets = Array.isArray(ticketsLoadable.value) ? ticketsLoadable.value : [];
    totalCount = tickets.length;
    const filter = activeStatusFilter || FILTER_ALL;
    const filtered = filter === FILTER_ALL ? tickets : tickets.filter((t) => t.status === filter);
    filteredCount = filtered.length;

    if (filtered.length === 0) {
      bodyHtml = `<p class="v2-empty" data-role="ticket-list-empty">No tickets</p>`;
    } else {
      bodyHtml = filtered.map((t) => {
        const ticketId = String(t.ticketId ?? '');
        const selected = ticketId === String(selectedTicketId ?? '');
        items.push({
          ticketId,
          title: t.title ?? '',
          status: t.status ?? 'unknown',
          assigneeId: t.assigneeId ?? null,
          reviewerId: t.reviewerId ?? null,
          priority: t.priority ?? null,
          updatedAt: t.updatedAt ?? null,
          selected,
        });
        return `<li class="v2-ticket-item" data-ticket-id="${escapeHtml(ticketId)}" data-ticket-status="${escapeHtml(t.status ?? 'unknown')}" data-selected="${selected}">` +
          `<span class="v2-ticket-title" data-role="ticket-title">${escapeHtml(t.title)}</span>` +
          `<span class="v2-ticket-status" data-role="ticket-status">${escapeHtml(t.status ?? 'unknown')}</span>` +
          `<span class="v2-ticket-priority" data-role="ticket-priority">${escapeHtml(t.priority ?? '')}</span>` +
          `<span class="v2-ticket-assignee" data-role="ticket-assignee">${escapeHtml(t.assigneeId ?? '')}</span>` +
          `</li>`;
      }).join('');
    }
  }

  const filters = [FILTER_ALL, 'open', 'in_progress', 'review', 'done', 'blocked'];
  const filterChipsHtml = filters.map((f) => {
    const active = f === (activeStatusFilter || FILTER_ALL);
    return `<button type="button" class="v2-ticket-filter" data-action="filter-tickets" data-filter="${escapeHtml(f)}" data-active="${active}">${escapeHtml(f)}</button>`;
  }).join('');

  const attrs = {
    'data-component': 'ticket-list',
    'data-status': status,
    'data-active-status-filter': activeStatusFilter,
  };

  const html =
    `<div class="v2-ticket-list"` +
    ` data-component="ticket-list"` +
    ` data-status="${status}"` +
    ` data-active-status-filter="${escapeHtml(activeStatusFilter || FILTER_ALL)}"` +
    ` data-total-count="${totalCount}"` +
    ` data-filtered-count="${filteredCount}">` +
    `<div class="v2-ticket-filters" data-role="ticket-filters">${filterChipsHtml}</div>` +
    bodyHtml +
    `</div>`;

  const model = {
    status,
    activeStatusFilter: activeStatusFilter || FILTER_ALL,
    selectedTicketId,
    items,
    totalCount,
    filteredCount,
    error,
  };

  return { html, model, attrs };
}
