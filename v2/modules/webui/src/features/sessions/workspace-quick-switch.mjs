const escapeAttr = (value) => String(value ?? '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escapeHtml = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderWorkspaceQuickSwitch({ workspaces = [], activeWorkspaceId = null, maxVisiblePills = 3, overflowOpen = false } = {}) {
  const normalized = Array.isArray(workspaces) ? workspaces : [];
  const activeIndex = normalized.findIndex((workspace) => workspace?.workspaceId === activeWorkspaceId);
  if (activeIndex === -1 || maxVisiblePills >= normalized.length) {
    const visiblePills = normalized.slice(0, maxVisiblePills);
    const overflowWorkspaces = normalized.slice(maxVisiblePills);
    return {
      html: renderHtml({ activeWorkspaceId, visiblePills, overflowWorkspaces, overflowOpen }),
      model: { activeWorkspaceId, visiblePills, overflowWorkspaces, overflowOpen },
    };
  }
  const firstVisible = Math.max(0, activeIndex - Math.floor((maxVisiblePills - 1) / 2));
  const endExclusive = Math.min(normalized.length, firstVisible + maxVisiblePills);
  const start = Math.max(0, endExclusive - maxVisiblePills);
  const visiblePills = normalized.slice(start, endExclusive);
  const overflowWorkspaces = normalized.filter((workspace) => !visiblePills.includes(workspace));
  return {
    html: renderHtml({ activeWorkspaceId, visiblePills, overflowWorkspaces, overflowOpen }),
    model: { activeWorkspaceId, visiblePills, overflowWorkspaces, overflowOpen },
  };
}

function renderHtml({ activeWorkspaceId, visiblePills, overflowWorkspaces, overflowOpen }) {
  const pillsHtml = visiblePills.map((workspace) => {
    const name = workspace?.name || workspace?.workspaceId || 'Untitled';
    const isActive = workspace?.workspaceId === activeWorkspaceId;
    return `<button type="button" class="v2-workspace-pill ${isActive ? 'is-active' : ''}" data-action="quick-switch-workspace" data-workspace-id="${escapeAttr(workspace?.workspaceId || '')}">${escapeHtml(name)}</button>`;
  }).join('');
  const overflowButton = overflowWorkspaces.length > 0
    ? `<button type="button" class="v2-workspace-overflow-toggle" data-action="toggle-workspace-overflow">+${overflowWorkspaces.length}</button>`
    : '';
  const popover = overflowWorkspaces.length > 0 && overflowOpen
    ? `<div class="v2-workspace-overflow-popover" data-role="workspace-overflow-popover">${overflowWorkspaces.map((workspace) => `<button type="button" data-action="quick-switch-workspace" data-workspace-id="${escapeAttr(workspace?.workspaceId || '')}">${escapeHtml(workspace?.name || workspace?.workspaceId || 'Untitled')}</button>`).join('')}</div>`
    : '';
  return `<nav class="v2-workspace-quick-switch" data-component="workspace-quick-switch" data-active-workspace-id="${escapeAttr(activeWorkspaceId || '')}">${pillsHtml}${overflowButton}${popover}</nav>`;
}
