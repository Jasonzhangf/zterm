function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderWorkspacesPage(state = {}, helpers = {}) {
  const {
    workspacesLoadable = { status: 'loading', value: [], error: null },
    activeWorkspaceId = null,
    membersLoadable = { status: 'loading', value: [], error: null },
    selectedMemberId = null,
    propertiesLoadable = null,
    draft = null,
    saving = false,
    saveError = null,
  } = state

  const workspaces = workspacesLoadable.status === 'ready' ? (workspacesLoadable.value || []) : []
  const members = membersLoadable.status === 'ready' ? (membersLoadable.value || []) : []
  const effectivePropertiesLoadable = propertiesLoadable || (membersLoadable.status === 'unavailable' ? membersLoadable : null)
  const activeWorkspace = workspaces.find((ws) => ws.workspaceId === activeWorkspaceId) || null

  const treeHtml = helpers.renderWorkspaceTree
    ? helpers.renderWorkspaceTree({
        workspacesLoadable,
        activeWorkspaceId,
        variant: 'page',
      }).html
    : `<div class="v2-workspace-tree" data-role="workspace-tree">${workspaces.map((w) => `<div class="v2-workspace-item" data-workspace-id="${esc(w.workspaceId)}" data-active="${w.workspaceId === activeWorkspaceId}">${esc(w.name || w.workspaceId)}</div>`).join('')}</div>`

  const pickerHtml = helpers.renderMemberPicker
    ? helpers.renderMemberPicker({
        members,
        selectedMemberIds: selectedMemberId ? [selectedMemberId] : [],
        maxSelection: null,
      }).html
    : `<div class="v2-member-picker" data-role="member-picker">${members.map((m) => `<button type="button" data-member-id="${esc(m.memberId)}">${esc(m.name || m.memberId)}</button>`).join('')}</div>`

  const statusHtml = helpers.renderMemberStatusList
    ? helpers.renderMemberStatusList({ membersLoadable, selectedMemberId }).html
    : `<div class="v2-member-status-list" data-role="member-status-list">${members.map((m) => `<div class="v2-member-status-item" data-member-id="${esc(m.memberId)}" data-status="${esc(m.status || 'unknown')}">${esc(m.name || m.memberId)} ${esc(m.status || 'unknown')}</div>`).join('')}</div>`

  const propertyHtml = helpers.renderPropertyPanel
    ? helpers.renderPropertyPanel({
        windowId: 'workspace-property',
        memberId: selectedMemberId ?? '',
        propertiesLoadable: effectivePropertiesLoadable,
        draft,
        saving,
        saveError,
      }).html
    : `<div class="v2-property-panel" data-role="property-panel" data-window-id="workspace-property" data-member-id="${esc(selectedMemberId ?? '')}">Property panel</div>`

  const html = `
    <section class="v2-page v2-page-workspaces" data-page="workspaces" data-page-id="workspaces" data-route-scope="global">
      <div class="page-title-row">
        <div>
          <h1 class="v2-page-title">Workspace 连接合并与分层治理</h1>
          <div class="v2-page-subtitle">分层文件夹组织树、跨连接引用合并（Mount-by-Reference，零会话复制）与成员独立属性面板</div>
        </div>
        <div class="row-actions">
          ${activeWorkspace ? `<span class="badge badge-accent">当前选中: ${esc(activeWorkspace.path || activeWorkspace.name)}</span>` : ''}
          ${activeWorkspaceId ? `<button type="button" class="btn btn-primary btn-sm" data-action="navigate" data-route="sessions" data-workspace-id="${esc(activeWorkspaceId)}">进入该工作区 Sessions</button>` : ''}
        </div>
      </div>
      <div class="v2-layout-sidebar grid-2">
        <div class="v2-panel card">
          <div class="card-title-row">
            <div>
              <div class="card-title">分层 Workspace 文件夹树</div>
              <div class="card-sub">支持无限层文件夹组织与连接引用合并</div>
            </div>
            <span class="badge badge-neutral">${workspaces.length} Workspaces</span>
          </div>
          ${treeHtml}
        </div>
        <div class="v2-panel card">
          <div class="card-title-row">
            <div>
              <div class="card-title">成员挑选器（支持 5+ 成员无上限勾选）</div>
              <div class="card-sub">将多机器会话按引用挂载至当前 Workspace</div>
            </div>
          </div>
          ${pickerHtml}
        </div>
        <div class="v2-panel card">
          <div class="card-title-row">
            <div>
              <div class="card-title">成员运行态与 Stale 诚实投影</div>
              <div class="card-sub">离线或移除成员显式标出，不伪装在线</div>
            </div>
          </div>
          ${statusHtml}
        </div>
        <div class="v2-panel card">
          <div class="card-title-row">
            <div>
              <div class="card-title">选中成员属性面板</div>
              <div class="card-sub">按 memberId 独立缓存草稿与保存状态</div>
            </div>
          </div>
          ${propertyHtml}
        </div>
      </div>
    </section>
  `

  return {
    html,
    model: {
      pageId: 'workspaces',
      activeWorkspaceId,
      selectedMemberId,
      workspaces,
      members,
      propertiesLoadable: effectivePropertiesLoadable,
      saving,
      saveError,
    },
    pageId: 'workspaces',
  }
}

export { esc }
