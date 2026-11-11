function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderBoardPage(state = {}, helpers = {}) {
  const {
    workspaces = [],
    workspacesLoadable = null,
    goalsLoadable = { status: 'loading', value: [], error: null },
    ticketsLoadable = { status: 'loading', value: [], error: null },
    membersLoadable = { status: 'loading', value: [], error: null },
    activeWorkspaceId = null,
    activeWorkspace = null,
    workspaceScopeError = null,
    selectedGoalId = null,
    receipts = [],
    transfers = [],
    lastError = null,
  } = state

  const resolvedWorkspace = activeWorkspace || workspaces.find((ws) => ws.workspaceId === activeWorkspaceId) || null
  const workspaceName = resolvedWorkspace?.name || activeWorkspaceId || '未选择 Workspace'
  const workspacePath = resolvedWorkspace?.path || workspaceName
  const managerName = resolvedWorkspace?.managerName
    || (membersLoadable.status === 'ready' && Array.isArray(membersLoadable.value)
      ? (membersLoadable.value.find((m) => m.role === 'primary' || /manager/i.test(String(m.role || '')))?.name || membersLoadable.value[0]?.name || 'Workspace Manager')
      : 'Workspace Manager')

  if (workspaceScopeError) {
    const errHtml = helpers.renderErrorNotice
      ? helpers.renderErrorNotice({ error: workspaceScopeError, title: `Workspace 不可访问 (${activeWorkspaceId || 'unknown'})` }).html
      : `<div class="v2-unavailable" data-error-code="${esc(workspaceScopeError.code || '')}">${esc(workspaceScopeError.message || 'Workspace unavailable')}</div>`
    const html = `
      <section class="v2-page v2-page-board" data-page="board" data-page-id="board" data-workspace-id="${esc(activeWorkspaceId || '')}" data-workspace-scope="per-workspace">
        <div class="v2-panel card" data-role="workspace-scope-error" data-workspace-id="${esc(activeWorkspaceId || '')}" data-error-code="${esc(workspaceScopeError.code || '')}">
          ${errHtml}
        </div>
      </section>
    `
    return {
      html,
      model: {
        pageId: 'board',
        activeWorkspaceId,
        workspaceScope: 'per-workspace',
        workspaceScopeError,
        goals: [],
        tickets: [],
        members: [],
        receipts,
        transfers,
        lastError: workspaceScopeError,
      },
      pageId: 'board',
    }
  }

  if (!activeWorkspaceId) {
    const unavailableErr = workspacesLoadable?.status === 'unavailable'
      ? workspacesLoadable.error
      : (goalsLoadable?.status === 'unavailable' ? goalsLoadable.error : (membersLoadable?.status === 'unavailable' ? membersLoadable.error : null))
    const errNotice = unavailableErr && helpers.renderErrorNotice
      ? helpers.renderErrorNotice({ error: unavailableErr }).html
      : ''
    const treeHtml = helpers.renderWorkspaceTree
      ? helpers.renderWorkspaceTree({
          workspacesLoadable: workspacesLoadable || { status: unavailableErr ? 'unavailable' : 'ready', value: workspaces, error: unavailableErr },
          activeWorkspaceId: null,
        }).html
      : ''
    const html = `
      <section class="v2-page v2-page-board" data-page="board" data-page-id="board" data-workspace-id="" data-workspace-scope="per-workspace">
        <div class="v2-panel card" data-role="workspace-selection-required">
          <div class="card-title-row">
            <div>
              <h1 class="v2-page-title">Manager Board（需先选择 Workspace）</h1>
              <div class="v2-page-subtitle">Manager Board 与 Goals 按单个 Workspace 隔离组织，不存在脱离 Workspace 的全局任务板。</div>
            </div>
            <button type="button" class="btn btn-primary btn-sm" data-action="navigate" data-route="workspaces">选择或创建 Workspace</button>
          </div>
          ${errNotice}
          ${treeHtml}
        </div>
      </section>
    `
    return {
      html,
      model: {
        pageId: 'board',
        activeWorkspaceId: null,
        workspaceScope: 'per-workspace',
        goals: [],
        tickets: [],
        members: [],
        receipts,
        transfers,
        lastError: unavailableErr || lastError,
      },
      pageId: 'board',
    }
  }

  const rawGoals = goalsLoadable.status === 'ready' ? (goalsLoadable.value || []) : []
  const goals = rawGoals.filter((goal) => !goal.workspaceId || goal.workspaceId === activeWorkspaceId)
  const scopedGoalsLoadable = goalsLoadable.status === 'ready'
    ? { ...goalsLoadable, value: goals }
    : goalsLoadable

  const rawTickets = ticketsLoadable.status === 'ready' ? (ticketsLoadable.value || []) : []
  const tickets = rawTickets.filter((ticket) => !ticket.workspaceId || ticket.workspaceId === activeWorkspaceId)

  const rawMembers = membersLoadable.status === 'ready' ? (membersLoadable.value || []) : []
  const members = rawMembers.filter((member) => !member.workspaceId || member.workspaceId === activeWorkspaceId)
  const scopedMembersLoadable = membersLoadable.status === 'ready'
    ? { ...membersLoadable, value: members }
    : membersLoadable

  const effectiveWorkspacesLoadable = workspacesLoadable || (
    membersLoadable.status === 'unavailable'
      ? membersLoadable
      : { status: 'ready', value: [{ workspaceId: activeWorkspaceId, name: workspaceName, memberCount: members.length }], error: null }
  )

  const treeHtml = helpers.renderWorkspaceTree
    ? helpers.renderWorkspaceTree({
        workspacesLoadable: effectiveWorkspacesLoadable,
        activeWorkspaceId,
      }).html
    : `<div class="v2-workspace-tree" data-role="workspace-tree"><div class="v2-workspace-item" data-workspace-id="${esc(activeWorkspaceId)}">${esc(workspaceName)}</div></div>`

  const statusHtml = helpers.renderMemberStatusList
    ? helpers.renderMemberStatusList({ membersLoadable: scopedMembersLoadable, selectedMemberId: null }).html
    : `<div class="v2-member-status-list" data-role="member-status-list">${members.map((m) => `<div class="v2-member-status-item" data-member-id="${esc(m.memberId)}" data-status="${esc(m.status || 'unknown')}">${esc(m.name || m.memberId)} ${esc(m.status || 'unknown')}</div>`).join('')}</div>`

  const goalsHtml = helpers.renderGoalTicketList
    ? helpers.renderGoalTicketList({ goalsLoadable: scopedGoalsLoadable, selectedGoalId }).html
    : `<div class="v2-goal-ticket-list" data-role="goal-ticket-list">${goals.map((goal) => `<div class="v2-goal-item" data-goal-id="${esc(goal.goalId)}">${esc(goal.title || goal.goalId)} ${esc(goal.status || '')}</div>`).join('')}</div>`

  const associatedTicketsHtml = tickets.length > 0
    ? `
      <div class="board-associated-tickets" data-role="board-associated-tickets" data-workspace-id="${esc(activeWorkspaceId)}">
        <div class="card-sub" style="margin-bottom:6px;">当前 Workspace 关联 Tickets（${tickets.length}）</div>
        <div class="ticket-mini-list">
          ${tickets.map((t) => `
            <div class="ticket-mini-row" data-action="open-workspace-ticket" data-workspace-id="${esc(activeWorkspaceId)}" data-ticket-id="${esc(t.ticketId)}">
              <span class="mono">${esc(t.ticketId)}</span>
              <span class="title">${esc(t.title || t.ticketId)}</span>
              <span class="badge badge-neutral">${esc(t.status || 'open')}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `
    : `<div class="card-sub" data-role="board-associated-tickets-empty">当前 Workspace (${esc(activeWorkspaceId)}) 暂无关联 Tickets</div>`

  const html = `
    <section class="v2-page v2-page-board board-shell" data-page="board" data-page-id="board" data-workspace-id="${esc(activeWorkspaceId)}" data-workspace-scope="per-workspace">
      <div class="board-header card">
        <div class="page-title-row" style="width:100%;">
          <div>
            <h1 class="v2-page-title" data-role="board-workspace-title">Manager Board · ${esc(workspaceName)}</h1>
            <div class="v2-page-subtitle" data-role="board-workspace-meta">Manager: ${esc(managerName)} · 路径: ${esc(workspacePath)} · 仅显示当前 Workspace (${esc(activeWorkspaceId)}) 的 Goals、Tickets 与成员状态</div>
          </div>
          <div class="row-actions">
            <span class="badge badge-accent" data-role="board-workspace-badge" data-workspace-id="${esc(activeWorkspaceId)}">Workspace: ${esc(activeWorkspaceId)}</span>
            <button type="button" class="btn btn-sm" data-action="navigate" data-route="tickets" data-workspace-id="${esc(activeWorkspaceId)}">查看当前工作区 Tickets (${tickets.length})</button>
          </div>
        </div>
      </div>
      <div class="board-grid">
        <div class="v2-panel card" data-role="board-goals-panel" data-workspace-id="${esc(activeWorkspaceId)}">
          <div class="card-title-row">
            <div>
              <div class="card-title">当前 Workspace Goals 与关联任务</div>
              <div class="card-sub">归属工作区：${esc(workspacePath)}（不混入其他 Workspace 的任务）</div>
            </div>
            <span class="badge badge-neutral">${goals.length} Goals</span>
          </div>
          ${goalsHtml}
          ${associatedTicketsHtml}
          <form id="board-goal-form" class="v2-form" data-role="board-goal-form" data-workspace-id="${esc(activeWorkspaceId)}" style="margin-top:10px;">
            <label class="v2-field">
              <span>在 ${esc(workspaceName)} 新建 Goal 标题</span>
              <input name="goalTitle" data-field="goal-title" placeholder="输入当前 Workspace 目标..." />
            </label>
            <div class="v2-form-actions">
              <button type="button" class="btn btn-primary btn-sm" data-action="create-workspace-goal" data-workspace-id="${esc(activeWorkspaceId)}">+ 新建当前工作区 Goal</button>
            </div>
          </form>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div class="v2-panel card" data-role="board-members-panel" data-workspace-id="${esc(activeWorkspaceId)}">
            <div class="card-title-row">
              <div>
                <div class="card-title">当前 Workspace 成员与健康状态</div>
                <div class="card-sub">在线 / 忙碌 / Stale 状态均按 ${esc(activeWorkspaceId)} 隔离</div>
              </div>
              <span class="badge badge-neutral">${members.length} 成员</span>
            </div>
            ${statusHtml}
          </div>
          <div class="v2-panel card" data-role="board-tree-panel">
            <div class="card-title-row">
              <div class="card-title">分层 Workspace 树切换</div>
            </div>
            ${treeHtml}
          </div>
        </div>
      </div>
    </section>
  `

  return {
    html,
    model: {
      pageId: 'board',
      activeWorkspaceId,
      workspaceName,
      workspacePath,
      managerName,
      workspaceScope: 'per-workspace',
      goals,
      tickets,
      members,
      receipts,
      transfers,
      lastError,
      workspaceScopeError: null,
    },
    pageId: 'board',
  }
}

export { esc }
