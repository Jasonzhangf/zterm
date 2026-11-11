function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const TICKET_FILTERS = Object.freeze([
  { id: 'all', label: '全部' },
  { id: 'open', label: '待处理' },
  { id: 'in-progress', label: '进行中' },
  { id: 'blocked', label: '阻塞' },
  { id: 'review', label: '待审查' },
  { id: 'closed', label: '已关闭' },
])

export function renderTicketsPage(state = {}, helpers = {}) {
  const {
    workspaces = [],
    workspacesLoadable = null,
    activeWorkspaceId = null,
    activeWorkspace = null,
    workspaceScopeError = null,
    ticketsLoadable = { status: 'loading', value: [], error: null },
    goalsLoadable = { status: 'loading', value: [], error: null },
    membersLoadable = { status: 'loading', value: [], error: null },
    selectedTicketId = null,
    selectedGoalId = null,
    selectedMemberId = null,
    ownerMemberSelected = false,
    activeFilter = 'all',
    transitionPending = false,
    transitionError = null,
    receipts = [],
    transfers = [],
    lastError = null,
  } = state

  const resolvedWorkspace = activeWorkspace || workspaces.find((ws) => ws.workspaceId === activeWorkspaceId) || null
  const workspaceName = resolvedWorkspace?.name || activeWorkspaceId || '未选择 Workspace'
  const workspacePath = resolvedWorkspace?.path || workspaceName

  if (workspaceScopeError) {
    const errHtml = helpers.renderErrorNotice
      ? helpers.renderErrorNotice({ error: workspaceScopeError, title: `Workspace 不可访问 (${activeWorkspaceId || 'unknown'})` }).html
      : `<div class="v2-unavailable" data-error-code="${esc(workspaceScopeError.code || '')}">${esc(workspaceScopeError.message || 'Workspace unavailable')}</div>`
    const html = `
      <section class="v2-page v2-page-tickets" data-page="tickets" data-page-id="tickets" data-workspace-id="${esc(activeWorkspaceId || '')}" data-workspace-scope="per-workspace">
        <div class="v2-panel card" data-role="workspace-scope-error" data-workspace-id="${esc(activeWorkspaceId || '')}" data-error-code="${esc(workspaceScopeError.code || '')}">
          ${errHtml}
        </div>
      </section>
    `
    return {
      html,
      model: {
        pageId: 'tickets',
        activeWorkspaceId,
        workspaceScope: 'per-workspace',
        workspaceScopeError,
        selectedTicketId: null,
        activeFilter,
        tickets: [],
        selectedTicket: null,
        transitionPending,
        transitionError,
        receipts,
        transfers,
        lastError: workspaceScopeError,
      },
      pageId: 'tickets',
    }
  }

  if (!activeWorkspaceId) {
    const unavailableErr = workspacesLoadable?.status === 'unavailable'
      ? workspacesLoadable.error
      : (ticketsLoadable?.status === 'unavailable' ? ticketsLoadable.error : null)
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
      <section class="v2-page v2-page-tickets" data-page="tickets" data-page-id="tickets" data-workspace-id="" data-workspace-scope="per-workspace">
        <div class="v2-panel card" data-role="workspace-selection-required">
          <div class="card-title-row">
            <div>
              <h1 class="v2-page-title">Tickets（需先选择 Workspace）</h1>
              <div class="v2-page-subtitle">Tickets 严格按所选 Workspace 隔离查询与汇报，不拉取脱离 Workspace 的全局工单。</div>
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
        pageId: 'tickets',
        activeWorkspaceId: null,
        workspaceScope: 'per-workspace',
        selectedTicketId: null,
        activeFilter,
        tickets: [],
        selectedTicket: null,
        transitionPending,
        transitionError,
        receipts,
        transfers,
        lastError: unavailableErr || lastError,
      },
      pageId: 'tickets',
    }
  }

  const rawTickets = ticketsLoadable.status === 'ready' ? (ticketsLoadable.value || []) : []
  const scopedTickets = rawTickets.filter((ticket) => !ticket.workspaceId || ticket.workspaceId === activeWorkspaceId)
  const scopedTicketsLoadable = ticketsLoadable.status === 'ready'
    ? { ...ticketsLoadable, value: scopedTickets }
    : ticketsLoadable

  const filteredTickets = activeFilter === 'all'
    ? scopedTickets
    : scopedTickets.filter((ticket) => String(ticket.status || '').toLowerCase() === activeFilter)

  const listHtml = helpers.renderTicketList
    ? helpers.renderTicketList({
        ticketsLoadable: scopedTicketsLoadable,
        activeStatusFilter: activeFilter,
        selectedTicketId,
      }).html
    : `<div class="v2-ticket-list" data-role="ticket-list">${filteredTickets.map((ticket) => `<div class="v2-ticket-item" data-ticket-id="${esc(ticket.ticketId)}" data-workspace-id="${esc(activeWorkspaceId)}" data-ticket-status="${esc(ticket.status || '')}">${esc(ticket.title || ticket.ticketId)} ${esc(ticket.status || '')}</div>`).join('')}</div>`

  const selectedTicket = filteredTickets.find((ticket) => ticket.ticketId === selectedTicketId)
    || filteredTickets[0]
    || null
  const detailLoadable = selectedTicket
    ? { status: 'ready', value: selectedTicket, error: null }
    : (scopedTicketsLoadable.status === 'unavailable' ? scopedTicketsLoadable : (scopedTicketsLoadable.status === 'loading' ? { status: 'loading', value: null, error: null } : { status: 'ready', value: null, error: null }))
  const detailHtml = helpers.renderTicketDetail
    ? helpers.renderTicketDetail({
        ticketLoadable: detailLoadable,
        transitionPending,
        transitionError,
      }).html
    : `<div class="v2-ticket-detail" data-role="ticket-detail" data-ticket-id="${esc(selectedTicket?.ticketId ?? '')}">${selectedTicket ? esc(selectedTicket.description || selectedTicket.title || '') : 'No ticket selected'}</div>`

  const goalOptions = goalsLoadable.status === 'ready' && Array.isArray(goalsLoadable.value)
    ? goalsLoadable.value
    : []
  const memberOptions = membersLoadable.status === 'ready' && Array.isArray(membersLoadable.value)
    ? membersLoadable.value
    : []
  const goalSelectHtml = goalOptions.map((goal) => {
    const goalId = String(goal.goalId ?? '')
    return `<option value="${esc(goalId)}"${goalId === String(selectedGoalId ?? '') ? ' selected' : ''}>${esc(goal.title ?? goal.name ?? goalId)}</option>`
  }).join('')
  const ownerSelectHtml = memberOptions.map((member) => {
    const memberId = String(member.memberId ?? '')
    return `<option value="${esc(memberId)}"${ownerMemberSelected && memberId === String(selectedMemberId ?? '') ? ' selected' : ''}>${esc(member.name ?? memberId)}</option>`
  }).join('')

  const errorHtml = lastError
    ? (helpers.renderErrorNotice ? helpers.renderErrorNotice({ error: lastError }).html : '')
    : ''

  const formHtml = helpers.renderFormActions
    ? helpers.renderFormActions({
        formId: 'ticket-report-form',
        pending: transitionPending,
        error: transitionError,
        submitLabel: `在 ${workspaceName} 提报 Ticket`,
        cancelLabel: '取消',
      }).html
    : ''
  const appendReportHtml = selectedTicket && helpers.renderFormActions
    ? helpers.renderFormActions({
        formId: 'ticket-append-report-form',
        pending: transitionPending,
        error: transitionError,
        submitLabel: `为 ${selectedTicket.ticketId} 追加 Report`,
        cancelLabel: '取消',
      }).html
    : ''

  const filterBarHtml = TICKET_FILTERS.map((item) => `
    <button
      type="button"
      class="btn btn-sm${activeFilter === item.id ? ' btn-primary' : ''}"
      data-action="filter-tickets"
      data-filter="${esc(item.id)}"
      data-workspace-id="${esc(activeWorkspaceId)}"
      aria-pressed="${activeFilter === item.id}"
    >${esc(item.label)}</button>
  `).join('')

  const html = `
    <section class="v2-page v2-page-tickets" data-page="tickets" data-page-id="tickets" data-workspace-id="${esc(activeWorkspaceId)}" data-workspace-scope="per-workspace">
      <div class="page-title-row">
        <div>
          <h1 class="v2-page-title" data-role="tickets-workspace-title">Tickets · ${esc(workspaceName)}</h1>
          <div class="v2-page-subtitle" data-role="tickets-workspace-meta">当前工作区 (${esc(workspacePath)}) 任务单、阻塞汇报、完成提交与 Review 闭环（Per-Workspace 范围: ${esc(activeWorkspaceId)}）</div>
        </div>
        <div class="row-actions" data-role="ticket-filter-bar" data-workspace-id="${esc(activeWorkspaceId)}">
          <span class="badge badge-accent" data-role="tickets-workspace-badge" data-workspace-id="${esc(activeWorkspaceId)}">Workspace: ${esc(activeWorkspaceId)}</span>
          ${filterBarHtml}
        </div>
      </div>
      ${errorHtml}
      <div class="v2-ticket-layout tickets-layout">
        <div class="v2-panel card" data-role="tickets-list-panel" data-workspace-id="${esc(activeWorkspaceId)}">
          <div class="card-title-row">
            <div>
              <div class="card-title">当前 Workspace 工单列表 (${filteredTickets.length}/${scopedTickets.length})</div>
              <div class="card-sub">仅展示 ${esc(workspaceName)} (${esc(activeWorkspaceId)}) 下的 Tickets</div>
            </div>
          </div>
          ${listHtml}
        </div>
        <div class="v2-panel card" data-role="tickets-detail-panel" data-workspace-id="${esc(activeWorkspaceId)}">
          ${detailHtml}
        </div>
      </div>
      <form id="ticket-report-form" class="v2-form card" data-role="ticket-report-form" data-workspace-id="${esc(activeWorkspaceId)}">
        <div class="card-title-row" style="grid-column:1 / -1;margin-bottom:2px;">
          <div class="card-title">在当前工作区 (${esc(workspaceName)}) 新建 / 汇报 Ticket</div>
          <span class="badge badge-neutral" data-role="ticket-form-workspace-id">${esc(activeWorkspaceId)}</span>
        </div>
        <label class="v2-field"><span>Ticket 标题</span><input name="ticketTitle" data-field="ticket-title" placeholder="输入工单标题..." /></label>
        <label class="v2-field"><span>描述与验收条件</span><textarea name="ticketDescription" data-field="ticket-description" placeholder="说明进度、阻塞或验收证据..."></textarea></label>
        <label class="v2-field"><span>目标</span><select name="ticketGoalId" data-field="ticket-goal-id">${goalSelectHtml}</select></label>
        <label class="v2-field"><span>Zterm Owner</span><select name="ticketOwnerMemberId" data-field="ticket-owner-member-id">${ownerSelectHtml}</select></label>
        <label class="v2-field"><span>优先级</span><input name="ticketPriority" data-field="ticket-priority" type="number" value="0" /></label>
        ${formHtml}
      </form>
      ${selectedTicket ? `
        <form id="ticket-append-report-form" class="v2-form card" data-role="ticket-append-report-form" data-workspace-id="${esc(activeWorkspaceId)}" data-ticket-id="${esc(selectedTicket.ticketId)}">
          <label class="v2-field"><span>Report 类型</span>
            <select name="ticketReportKind" data-field="ticket-report-kind">
              <option value="status">status</option>
              <option value="result">result</option>
              <option value="blocker">blocker</option>
              <option value="note">note</option>
            </select>
          </label>
          <label class="v2-field"><span>Report 内容</span><textarea name="ticketReportBody" data-field="ticket-report-body"></textarea></label>
          ${appendReportHtml}
        </form>
      ` : ''}
    </section>
  `

  return {
    html,
    model: {
      pageId: 'tickets',
      activeWorkspaceId,
      workspaceName,
      workspacePath,
      workspaceScope: 'per-workspace',
      selectedTicketId: selectedTicket?.ticketId ?? selectedTicketId,
      activeFilter,
      tickets: scopedTickets,
      filteredTickets,
      selectedTicket,
      transitionPending,
      transitionError,
      receipts,
      transfers,
      lastError,
      workspaceScopeError: null,
    },
    pageId: 'tickets',
  }
}

export { esc, TICKET_FILTERS }
