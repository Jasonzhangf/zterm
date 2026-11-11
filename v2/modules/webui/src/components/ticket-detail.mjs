import { escapeHtml } from './loadable.mjs';
import { renderErrorNotice } from './error-notice.mjs';

function normalizeTransition(transition) {
  if (typeof transition === 'string') {
    return { to: transition, label: transition };
  }
  return {
    to: String(transition?.to ?? transition?.status ?? ''),
    label: String(transition?.label ?? transition?.to ?? transition?.status ?? ''),
  };
}

/**
 * Ticket detail with explicit transition actions. Invalid transition errors are
 * surfaced through ErrorNotice; the component never invents a done state.
 *
 * @param {{
 *   ticketLoadable?: object,
 *   transitionPending?: boolean,
 *   transitionError?: unknown,
 * }} [props]
 */
export function renderTicketDetail({
  ticketLoadable = { status: 'loading' },
  transitionPending = false,
  transitionError = null,
} = {}) {
  const status = ticketLoadable.status;
  const pending = transitionPending === true;
  const transitionErrorHtml = transitionError ? renderErrorNotice({ error: transitionError }).html : '';
  let ticket = null;
  let allowedTransitions = [];
  let bodyHtml;

  if (status === 'loading') {
    bodyHtml = `<div class="v2-ticket-detail-skeleton" data-role="ticket-detail-loading"></div>`;
  } else if (status === 'unavailable') {
    bodyHtml = renderErrorNotice({ error: ticketLoadable.error }).html;
  } else if (status === 'ready' && (!ticketLoadable.value || typeof ticketLoadable.value !== 'object' || ticketLoadable.value.ticketId == null)) {
    bodyHtml = `<div class="v2-ticket-detail-empty" data-role="ticket-detail-empty">当前筛选下无匹配工单</div>`;
  } else {
    ticket = ticketLoadable.value && typeof ticketLoadable.value === 'object' ? ticketLoadable.value : {};
    allowedTransitions = Array.isArray(ticket.allowedTransitions)
      ? ticket.allowedTransitions.map(normalizeTransition)
      : [];

    const transitionsHtml = allowedTransitions.length > 0
      ? `<div class="v2-ticket-transitions" data-role="ticket-transitions">` +
        allowedTransitions.map((t) =>
          `<button type="button" class="v2-ticket-transition"` +
          ` data-action="transition-ticket"` +
          ` data-transition-to="${escapeHtml(t.to)}"` +
          `${pending ? ' disabled' : ''}>${escapeHtml(t.label)}</button>`
        ).join('') +
        `</div>`
      : '';

    const list = (value) => {
      if (Array.isArray(value)) {
        return `<ul data-role="ticket-list-value">` + value.map((v) => `<li>${escapeHtml(typeof v === 'string' ? v : JSON.stringify(v))}</li>`).join('') + `</ul>`;
      }
      return `<p data-role="ticket-text-value">${escapeHtml(value ?? '')}</p>`;
    };

    bodyHtml =
      `<article class="v2-ticket-detail-card" data-ticket-id="${escapeHtml(ticket.ticketId ?? '')}" data-ticket-status="${escapeHtml(ticket.status ?? 'unknown')}">` +
      `<h2 class="v2-ticket-title" data-role="ticket-title">${escapeHtml(ticket.title ?? '')}</h2>` +
      `<span class="v2-ticket-status" data-role="ticket-status">${escapeHtml(ticket.status ?? 'unknown')}</span>` +
      `<p class="v2-ticket-description" data-role="ticket-description">${escapeHtml(ticket.description ?? '')}</p>` +
      `<dl class="v2-ticket-meta">` +
      `<dt>Assignee</dt><dd data-role="ticket-assignee">${escapeHtml(ticket.assigneeId ?? '')}</dd>` +
      `<dt>Reviewer</dt><dd data-role="ticket-reviewer">${escapeHtml(ticket.reviewerId ?? '')}</dd>` +
      `</dl>` +
      `<section data-role="ticket-acceptance"><h3>Acceptance Criteria</h3>${list(ticket.acceptanceCriteria)}</section>` +
      `<section data-role="ticket-evidence"><h3>Delivery Evidence</h3>${list(ticket.deliveryEvidence)}</section>` +
      `<section data-role="ticket-review-notes"><h3>Review Notes</h3>${list(ticket.reviewNotes)}</section>` +
      transitionsHtml +
      transitionErrorHtml +
      `</article>`;
  }

  const attrs = {
    'data-component': 'ticket-detail',
    'data-status': status,
    'data-transition-pending': String(pending),
    'data-has-transition-error': String(Boolean(transitionError)),
  };

  const html =
    `<div class="v2-ticket-detail"` +
    ` data-component="ticket-detail"` +
    ` data-status="${status}"` +
    ` data-transition-pending="${pending}"` +
    ` data-has-transition-error="${Boolean(transitionError)}">` +
    bodyHtml +
    `</div>`;

  const model = {
    status,
    ticket,
    allowedTransitions,
    transitionPending: pending,
    transitionError: transitionError ?? null,
  };

  return { html, model, attrs };
}
