import { escapeHtml } from './loadable.mjs';

/**
 * Goal ticket list for the Board page. Each goal links to its own tickets via
 * a business query; this component never filters across the whole system.
 *
 * @param {{
 *   goalsLoadable?: object,
 *   selectedGoalId?: string|null,
 * }} [props]
 */
export function renderGoalTicketList({
  goalsLoadable = { status: 'loading' },
  selectedGoalId = null,
} = {}) {
  const status = goalsLoadable.status;
  const items = [];
  let error = null;
  let bodyHtml;

  if (status === 'loading') {
    bodyHtml = `<div class="v2-goal-ticket-skeleton" data-role="goal-ticket-loading"></div>`;
  } else if (status === 'unavailable') {
    error = goalsLoadable.error ?? null;
    bodyHtml = `<div class="v2-goal-ticket-error" data-role="goal-ticket-error">${escapeHtml(error && error.message ? error.message : 'Unable to load goals')}</div>`;
  } else {
    const goals = Array.isArray(goalsLoadable.value) ? goalsLoadable.value : [];
    if (goals.length === 0) {
      bodyHtml = `<p class="v2-empty" data-role="goal-ticket-empty">No goals</p>`;
    } else {
      bodyHtml = goals.map((g) => {
        const goalId = String(g.goalId ?? '');
        const selected = goalId === String(selectedGoalId ?? '');
        const tickets = Array.isArray(g.tickets) ? g.tickets : [];
        const ticketFreshness = String(g.ticketFreshness ?? 'unknown');
        const ticketError = g.ticketErrorRef
          ? `<div class="v2-goal-ticket-error" data-role="goal-ticket-error">${escapeHtml(g.ticketErrorRef.message || g.ticketErrorRef.code || 'Ticket section unavailable')}</div>`
          : '';
        const ticketRows = tickets.length > 0
          ? tickets.map((t) => `<li class="v2-goal-ticket-row" data-ticket-id="${escapeHtml(String(t.ticketId ?? ''))}" data-ticket-status="${escapeHtml(String(t.status ?? 'unknown'))}">` +
              `<span class="v2-ticket-title" data-role="ticket-title">${escapeHtml(t.title ?? t.ticketId ?? '')}</span>` +
              `<span class="v2-ticket-status" data-role="ticket-status">${escapeHtml(t.status ?? 'unknown')}</span>` +
              `<span class="v2-ticket-priority" data-role="ticket-priority">${escapeHtml(t.priority ?? '')}</span>` +
            '</li>').join('')
          : '<li class="v2-goal-ticket-row-empty" data-role="goal-ticket-empty">No tickets in this slice</li>';
        items.push({
          goalId,
          title: g.title ?? '',
          status: g.status ?? 'unknown',
          ownerMemberId: g.ownerMemberId ?? null,
          ticketCount: tickets.length,
          ticketFreshness,
          updatedAt: g.updatedAt ?? null,
          selected,
        });
        return `<li class="v2-goal-ticket-item" data-goal-id="${escapeHtml(goalId)}" data-selected="${selected}" data-goal-status="${escapeHtml(g.status ?? 'unknown')}" data-ticket-freshness="${escapeHtml(ticketFreshness)}">` +
          `<span class="v2-goal-title" data-role="goal-title">${escapeHtml(g.title)}</span>` +
          `<span class="v2-goal-status" data-role="goal-status">${escapeHtml(g.status ?? 'unknown')}</span>` +
          `<span class="v2-goal-ticket-count" data-role="goal-ticket-count">${escapeHtml(g.ticketCount ?? 0)}</span>` +
          `<ul class="v2-goal-ticket-rows" data-role="goal-ticket-rows">${ticketRows}</ul>` +
          ticketError +
          `</li>`;
      }).join('');
    }
  }

  const attrs = {
    'data-component': 'goal-ticket-list',
    'data-status': status,
  };
  if (selectedGoalId != null) {
    attrs['data-selected-goal-id'] = String(selectedGoalId);
  }

  const selectedAttr = selectedGoalId != null ? ` data-selected-goal-id="${escapeHtml(selectedGoalId)}"` : '';

  const html =
    `<ul class="v2-goal-ticket-list"` +
    ` data-component="goal-ticket-list"` +
    ` data-status="${status}"` +
    selectedAttr +
    `>` +
    bodyHtml +
    `</ul>`;

  const model = { status, selectedGoalId, items, error };

  return { html, model, attrs };
}
