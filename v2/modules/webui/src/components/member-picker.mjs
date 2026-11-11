import { escapeHtml } from './loadable.mjs';

/**
 * Select members for a workspace. `maxSelection === null` means unlimited
 * members per workspace, supporting 5+ peers.
 *
 * @param {{
 *   members?: Array<{ memberId: string, name?: string }>,
 *   selectedMemberIds?: string[],
 *   disabledMemberIds?: string[],
 *   maxSelection?: number|null,
 * }} [props]
 */
export function renderMemberPicker({
  members = [],
  selectedMemberIds = [],
  disabledMemberIds = [],
  maxSelection = null,
} = {}) {
  const selectedSet = new Set(selectedMemberIds ?? []);
  const disabledSet = new Set(disabledMemberIds ?? []);
  const max = maxSelection == null ? null : Number(maxSelection);

  const selectedCount = members.filter((m) => selectedSet.has(String(m.memberId))).length;
  const atMax = max !== null && selectedCount >= max;

  const items = members.map((m) => {
    const memberId = String(m.memberId);
    const selected = selectedSet.has(memberId);
    const disabled = disabledSet.has(memberId) || (atMax && !selected);
    return { memberId, name: m.name ?? '', selected, disabled, atMax };
  });

  const itemHtml = items.map((item) =>
    `<label class="v2-member-option" data-member-id="${escapeHtml(item.memberId)}" data-selected="${item.selected}" data-disabled="${item.disabled}">` +
    `<input type="checkbox" data-action="toggle-member" data-member-id="${escapeHtml(item.memberId)}"` +
    `${item.selected ? ' checked' : ''}${item.disabled ? ' disabled' : ''}>` +
    `<span class="v2-member-name" data-role="member-name">${escapeHtml(item.name)}</span>` +
    `</label>`
  ).join('');

  const attrs = {
    'data-component': 'member-picker',
    'data-selected-count': String(selectedCount),
    'data-max-selection': max == null ? '' : String(max),
    'data-at-max': String(Boolean(atMax)),
  };

  const maxAttr = max == null ? '' : ` data-max-selection="${max}"`;
  const disabledByMaxAttr = atMax ? ' data-at-max="true"' : '';

  const html =
    `<div class="v2-member-picker"` +
    ` data-component="member-picker"` +
    ` data-selected-count="${selectedCount}"` +
    `${maxAttr}` +
    `${disabledByMaxAttr}` +
    `>` +
    itemHtml +
    `</div>`;

  const model = { items, selectedCount };

  return { html, model, attrs };
}
