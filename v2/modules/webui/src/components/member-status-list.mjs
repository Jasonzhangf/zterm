import { escapeHtml } from './loadable.mjs';
import { normalizeStatusState, renderStatusBadge } from './status-badge.mjs';

/**
 * Render member list with honest stale/removed statuses. Members removed from
 * the workspace or observed as `stale` are explicitly marked stale with a
 * "Remove Stale Slot" action button; they are never dropped silently or faked
 * as `online`.
 *
 * @param {{
 *   membersLoadable?: object,
 *   selectedMemberId?: string|null,
 * }} [props]
 */
export function renderMemberStatusList({
  membersLoadable = { status: 'loading' },
  selectedMemberId = null,
} = {}) {
  const status = membersLoadable.status;
  const selectedId = String(selectedMemberId ?? '');
  const items = [];
  const staleMemberIds = [];
  let error = null;
  let bodyHtml;

  if (status === 'loading') {
    bodyHtml =
      `<div class="v2-member-status-skeleton" data-role="member-status-loading" aria-label="Loading members"></div>`;
  } else if (status === 'unavailable') {
    error = membersLoadable.error ?? null;
    bodyHtml = `<div class="v2-member-status-error" data-role="member-status-error">${escapeHtml(error && error.message ? error.message : 'Unable to load members')}</div>`;
  } else {
    const members = Array.isArray(membersLoadable.value) ? membersLoadable.value : [];
    bodyHtml = members.map((m) => {
      const memberId = String(m.memberId ?? '');
      const rawState = m.status ?? 'unknown';
      const freshness = m.freshness ?? 'fresh';
      const removedFromWorkspace = m.removedFromWorkspace === true;
      const observedStale = rawState === 'stale';
      const stale = removedFromWorkspace || observedStale || effectiveIsStale(rawState, freshness);

      const effectiveState = stale ? 'stale' : normalizeStatusState(rawState, freshness);

      items.push({
        memberId,
        name: m.name ?? '',
        role: m.role ?? '',
        machine: m.machine ?? '',
        status: rawState,
        effectiveState,
        freshness,
        observedAt: m.observedAt ?? null,
        staleReason: m.staleReason ?? null,
        removedFromWorkspace,
        stale,
        selected: memberId === selectedId,
      });

      if (stale) {
        staleMemberIds.push(memberId);
      }

      const staleAttr = stale ? ' data-stale="true"' : '';
      const removedAttr = removedFromWorkspace ? ' data-removed-from-workspace="true"' : '';
      const selectedAttr = memberId === selectedId ? ' data-selected="true"' : '';

      const badgeHtml = renderStatusBadge({
        state: effectiveState,
        freshness,
        observedAt: m.observedAt ?? null,
        reason: stale ? m.staleReason ?? null : null,
        label: null,
      }).html;

      const removeBtn = stale
        ? `<button type="button" class="v2-remove-stale-member"` +
          ` data-action="remove-stale-member"` +
          ` data-member-id="${escapeHtml(memberId)}"` +
          `>Remove Stale Slot</button>`
        : '';

      return `<li class="v2-member-status-item" data-member-id="${escapeHtml(memberId)}"${staleAttr}${removedAttr}${selectedAttr}>` +
        `<span class="v2-member-name" data-role="member-name">${escapeHtml(m.name)}</span>` +
        `<span class="v2-member-role" data-role="member-role">${escapeHtml(m.role)}</span>` +
        `<span class="v2-member-machine" data-role="member-machine">${escapeHtml(m.machine)}</span>` +
        `<span class="v2-member-badge" data-role="member-badge">${badgeHtml}</span>` +
        removeBtn +
        `</li>`;
    }).join('');
  }

  const attrs = {
    'data-component': 'member-status-list',
    'data-status': status,
    'data-selected-member-id': selectedId,
    'data-stale-count': String(staleMemberIds.length),
  };

  const selectedAttr = selectedMemberId != null ? ` data-selected-member-id="${escapeHtml(selectedId)}"` : '';

  const html =
    `<ul class="v2-member-status-list"` +
    ` data-component="member-status-list"` +
    ` data-status="${status}"` +
    selectedAttr +
    `>` +
    bodyHtml +
    `</ul>`;

  const model = {
    status,
    selectedMemberId,
    items,
    staleMemberIds,
    error,
  };

  return { html, model, attrs };
}

function effectiveIsStale(rawState, freshness) {
  return (freshness === 'stale' || freshness === 'expired') && rawState === 'online';
}
