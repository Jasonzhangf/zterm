import { createUnavailable, escapeHtml } from './loadable.mjs';
import { renderErrorNotice } from './error-notice.mjs';

function computeDepths(workspaces) {
  const byId = new Map(workspaces.map((ws) => [String(ws.workspaceId ?? ''), ws]));
  return workspaces.map((ws) => {
    if (Number.isFinite(Number(ws.depth))) {
      return Number(ws.depth);
    }
    let depth = 0;
    let cursor = ws.parentId ? byId.get(String(ws.parentId)) : null;
    const visited = new Set([String(ws.workspaceId ?? '')]);
    while (cursor && !visited.has(String(cursor.workspaceId ?? ''))) {
      visited.add(String(cursor.workspaceId ?? ''));
      depth += 1;
      cursor = cursor.parentId ? byId.get(String(cursor.parentId)) : null;
    }
    return depth;
  });
}

export function renderWorkspaceTree({
  workspacesLoadable = createUnavailable(null),
  activeWorkspaceId = null,
  collapsedIds = [],
  variant = 'sidebar',
} = {}) {
  const status = workspacesLoadable.status;
  const collapsed = new Set(collapsedIds ?? []);
  const items = [];

  let bodyHtml;
  let error = null;

  if (status === 'loading') {
    bodyHtml =
      `<div class="v2-workspace-tree-skeleton" data-role="workspace-tree-loading" aria-label="Loading workspaces" hidden="false">Loading workspaces...</div>`;
  } else if (status === 'unavailable') {
    error = workspacesLoadable.error ?? null;
    bodyHtml = renderErrorNotice({ error, contextId: 'workspace-tree' }).html;
  } else {
    const workspaces = Array.isArray(workspacesLoadable.value) ? workspacesLoadable.value : [];
    if (workspaces.length === 0) {
      bodyHtml =
        `<p class="v2-empty" data-role="workspace-tree-empty">No workspaces</p>`;
    } else {
      const parentIds = new Set(
        workspaces
          .map((ws) => (ws.parentId ? String(ws.parentId) : null))
          .filter(Boolean),
      );
      const depths = computeDepths(workspaces);
      const nodesHtml = workspaces.map((ws, index) => {
        const workspaceId = String(ws.workspaceId ?? '');
        const active = workspaceId === activeWorkspaceId;
        const collapsedState = collapsed.has(workspaceId);
        const depth = Math.max(0, Math.min(4, depths[index] ?? 0));
        const hasChildren = parentIds.has(workspaceId);
        const memberCount = Number(ws.memberCount ?? (Array.isArray(ws.members) ? ws.members.length : 0));
        const unreadCount = Number(ws.unreadCount ?? 0);
        const machineCount = Number(
          ws.machineCount ?? (Array.isArray(ws.connectionIds) ? ws.connectionIds.length : 1),
        );
        const wsStatus = ws.status ?? 'online';
        const folderGlyph = hasChildren ? (collapsedState ? '▸ ' : '▾ ') : '▸ ';

        items.push({
          workspaceId,
          name: ws.name ?? '',
          parentId: ws.parentId ?? null,
          depth,
          path: ws.path ?? ws.name ?? workspaceId,
          managerName: ws.managerName ?? '',
          memberCount,
          machineCount,
          unreadCount,
          status: wsStatus,
          active,
          collapsed: collapsedState,
        });

        return (
          `<li class="v2-workspace-node nav-item depth-${depth}${active ? ' active' : ''}"` +
          ` data-role="workspace-node"` +
          ` data-action="select-workspace"` +
          ` data-workspace-id="${escapeHtml(workspaceId)}"` +
          ` data-parent-id="${escapeHtml(ws.parentId ?? '')}"` +
          ` data-depth="${depth}"` +
          ` data-active="${active}"` +
          ` data-collapsed="${collapsedState}"` +
          ` data-unread-count="${escapeHtml(unreadCount)}"` +
          ` role="treeitem"` +
          ` aria-selected="${active}">` +
          `<span class="v2-workspace-name label" data-role="workspace-name">${escapeHtml(folderGlyph + (ws.name ?? workspaceId))}</span>` +
          `<span class="v2-workspace-meta">` +
          `<span class="v2-workspace-count nav-pill" data-role="workspace-member-count" title="${escapeHtml(`${memberCount} members · ${machineCount} machines`)}">${escapeHtml(`${memberCount}m`)}</span>` +
          `<span class="v2-workspace-count" data-role="workspace-unread-count" hidden>${escapeHtml(unreadCount)} unread</span>` +
          `<span class="v2-workspace-status" data-role="workspace-status" hidden>${escapeHtml(wsStatus)}</span>` +
          `</span>` +
          `</li>`
        );
      }).join('');
      bodyHtml = `<ul class="v2-workspace-tree-list nav-tree" role="tree">${nodesHtml}</ul>`;
    }
  }

  const attrs = {
    'data-component': 'workspace-tree',
    'data-status': status,
    'data-variant': variant,
  };
  if (activeWorkspaceId != null) {
    attrs['data-active-workspace-id'] = String(activeWorkspaceId);
  }

  const activeAttr = activeWorkspaceId != null ? ` data-active-workspace-id="${escapeHtml(activeWorkspaceId)}"` : '';

  const html =
    `<div class="v2-workspace-tree"` +
    ` data-component="workspace-tree"` +
    ` data-status="${status}"` +
    ` data-variant="${escapeHtml(variant)}"` +
    activeAttr +
    `>` +
    bodyHtml +
    `</div>`;

  const model = {
    status,
    activeWorkspaceId,
    items,
    error,
  };

  return { html, model, attrs };
}
