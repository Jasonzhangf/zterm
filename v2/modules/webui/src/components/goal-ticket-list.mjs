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
        items.push({
          goalId,
          title: g.title ?? '',
          status: g.status ?? 'unknown',
          ownerMemberId: g.ownerMemberId ?? null,
          ticketCount: Number(g.ticketCount ?? 0),
          updatedAt: g.updatedAt ?? null,
          selected,
        });
        return `<li class="v2-goal-ticket-item" data-goal-id="${escapeHtml(goalId)}" data-selected="${selected}" data-goal-status="${escapeHtml(g.status ?? 'unknown')}">` +
          `<span class="v2-goal-title" data-role="goal-title">${escapeHtml(g.title)}</span>` +
          `<span class="v2-goal-status" data-role="goal-status">${escapeHtml(g.status ?? 'unknown')}</span>` +
          `<span class="v2-goal-ticket-count" data-role="goal-ticket-count">${escapeHtml(g.ticketCount ?? 0)}</span>` +
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
