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
  const groups = state.groups || []
  const machineFilter = state.machineFilter || ''
  const localGroupPending = state.localGroupPending || {}
  const localGroupMemberResults = state.localGroupMemberResults || {}
  const localGroupPendingByMemberId = state.localGroupPendingByMemberId || {}
  const localGroupResults = state.localGroupResults || {}
  const effectivePropertiesLoadable = propertiesLoadable || (membersLoadable.status === 'unavailable' ? membersLoadable : null)
  const activeWorkspace = workspaces.find((ws) => ws.workspaceId === activeWorkspaceId) || null
  const selectedMember = members.find((member) => member.memberId === selectedMemberId) || null
  const machineOptions = [
    ...new Set(
      members
        .map((member) => member.runtime?.machineId)
        .filter((machineId) => typeof machineId === 'string' && machineId !== ''),
    ),
  ]
  const machineFilterOptions = machineFilter && !machineOptions.includes(machineFilter)
    ? [...machineOptions, machineFilter]
    : machineOptions
  const visibleMembers = machineFilter
    ? members.filter((member) => member.runtime?.machineId === machineFilter)
    : members
  const selectedRuntime = selectedMember?.runtime || null
  const selectedBinding = selectedMember?.binding || null
  const selectedGeneration = selectedMember?.bindingGeneration
  const selectedAgentCapabilities = selectedMember?.agentCapabilities || {
    start: 'unsupported',
    resume: 'unsupported',
  }
  const selectedPending = localGroupPendingByMemberId[selectedMemberId] || {}
  const selectedResult = selectedMemberId ? localGroupMemberResults[selectedMemberId] : null
  const agentCapabilityUnsupported = (capability) => capability !== 'supported'

  const treeHtml = helpers.renderWorkspaceTree
    ? helpers.renderWorkspaceTree({
        workspacesLoadable,
        activeWorkspaceId,
        variant: 'page',
      }).html
    : `<div class="v2-workspace-tree" data-role="workspace-tree">${workspaces.map((w) => `<div class="v2-workspace-item" data-workspace-id="${esc(w.workspaceId)}" data-active="${w.workspaceId === activeWorkspaceId}">${esc(w.name || w.workspaceId)}</div>`).join('')}</div>`

  const pickerHtml = helpers.renderMemberPicker
    ? helpers.renderMemberPicker({
        members: visibleMembers,
        selectedMemberIds: selectedMemberId ? [selectedMemberId] : [],
        maxSelection: null,
      }).html
    : `<div class="v2-member-picker" data-role="member-picker">${visibleMembers.map((m) => `<button type="button" data-member-id="${esc(m.memberId)}">${esc(m.name || m.memberId)}</button>`).join('')}</div>`

  const statusHtml = helpers.renderMemberStatusList
    ? helpers.renderMemberStatusList({
        membersLoadable: { ...membersLoadable, value: visibleMembers },
        selectedMemberId,
      }).html
    : `<div class="v2-member-status-list" data-role="member-status-list">${visibleMembers.map((m) => `<div class="v2-member-status-item" data-member-id="${esc(m.memberId)}" data-status="${esc(m.status || 'unknown')}">${esc(m.name || m.memberId)} ${esc(m.status || 'unknown')}</div>`).join('')}</div>`

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

  const groupOptionsHtml = groups.map((group) => (
    `<option value="${esc(group.groupId)}">${esc(group.name || group.groupId)}</option>`
  )).join('')
  const groupFormHtml = `
    <form class="v2-local-group-form" id="workspace-group-create-form" data-form-id="workspace-group-create-form" data-workspace-id="${esc(activeWorkspaceId ?? '')}">
      <label class="v2-form-field"><span>Group name</span><input name="groupName" autocomplete="off"></label>
      <label class="v2-form-field"><span>Parent group</span><select name="groupParentId">${groupOptionsHtml}</select></label>
      <button type="submit" class="btn btn-sm btn-primary" data-action="submit-form" data-form-id="workspace-group-create-form" data-pending="${localGroupPending.group === true}"${localGroupPending.group === true ? ' disabled' : ''}>Create Group</button>
    </form>
  `
  const memberFormHtml = `
    <form class="v2-local-group-form" id="workspace-member-create-form" data-form-id="workspace-member-create-form" data-workspace-id="${esc(activeWorkspaceId ?? '')}">
      <label class="v2-form-field"><span>Group</span><select name="memberGroupId">${groupOptionsHtml}</select></label>
      <label class="v2-form-field"><span>Member name</span><input name="memberName" autocomplete="off"></label>
      <button type="submit" class="btn btn-sm btn-primary" data-action="submit-form" data-form-id="workspace-member-create-form" data-pending="${localGroupPending.member === true}"${localGroupPending.member === true ? ' disabled' : ''}>Create Member</button>
    </form>
  `
  const runtimeFormHtml = selectedMember ? `
    <form class="v2-local-group-form" id="workspace-runtime-form" data-form-id="workspace-runtime-form" data-workspace-id="${esc(activeWorkspaceId)}" data-member-id="${esc(selectedMember.memberId)}">
      <div class="v2-form-grid">
        <label class="v2-form-field"><span>Machine ID</span><input name="runtimeMachineId" value="${esc(selectedRuntime?.machineId ?? '')}" autocomplete="off"></label>
        <label class="v2-form-field"><span>Host kind</span><input name="runtimeHostKind" value="${esc(selectedRuntime?.hostKind ?? 'tmux')}" autocomplete="off"></label>
        <label class="v2-form-field"><span>Agent kind</span><input name="runtimeAgentKind" value="${esc(selectedRuntime?.agentKind ?? '')}" autocomplete="off"></label>
        <label class="v2-form-field"><span>Launch profile reference</span><input name="runtimeLaunchProfileRef" value="${esc(selectedRuntime?.launchProfileRef ?? '')}" autocomplete="off"></label>
      </div>
      <button type="submit" class="btn btn-sm btn-primary" data-action="submit-form" data-form-id="workspace-runtime-form" data-pending="${selectedPending.runtime === true}"${selectedPending.runtime === true ? ' disabled' : ''}>Configure Runtime</button>
    </form>
  ` : ''
  const bindingFormHtml = selectedMember ? `
    <form class="v2-local-group-form" id="workspace-binding-form" data-form-id="workspace-binding-form" data-workspace-id="${esc(activeWorkspaceId)}" data-member-id="${esc(selectedMember.memberId)}">
      <div class="v2-form-grid">
        <label class="v2-form-field"><span>Session ID</span><input name="bindingSessionId" value="${esc(selectedBinding?.sessionId ?? '')}" autocomplete="off"></label>
        <label class="v2-form-field"><span>Pane anchor</span><input name="bindingAnchor" value="${esc(selectedBinding?.anchor ?? '')}" autocomplete="off"></label>
      </div>
      <div class="v2-form-meta">Current binding generation: ${esc(selectedGeneration ?? 'Not loaded')}</div>
      <button type="submit" class="btn btn-sm btn-primary" data-action="submit-form" data-form-id="workspace-binding-form" data-pending="${selectedPending.binding === true}"${selectedPending.binding === true ? ' disabled' : ''}>Bind Existing Session</button>
      <button type="button" class="btn btn-sm" data-action="restore-member-binding" data-workspace-id="${esc(activeWorkspaceId)}" data-member-id="${esc(selectedMember.memberId)}" data-pending="${selectedPending.restore === true}"${selectedPending.restore === true ? ' disabled' : ''}>Verify Saved Binding</button>
    </form>
  ` : ''
  const resultHtml = selectedMember ? `
    <div class="v2-local-group-result" data-role="local-group-result" data-result-member-id="${esc(selectedMember.memberId)}" data-result-status="${esc(selectedResult?.status ?? 'empty')}">
      ${selectedResult?.status === 'success' ? esc(selectedResult.message) : ''}
      ${selectedResult?.error ? `<span class="v2-error-code">${esc(selectedResult.error.code)}</span> <span>${esc(selectedResult.error.message)}</span>` : ''}
      ${selectedResult ? '' : 'No local group operation result.'}
    </div>
  ` : ''
  const workspaceResultParts = [
    ['Group', localGroupResults.group],
    ['Member', localGroupResults.member],
  ].filter(([, result]) => result).map(([label, result]) => (
    `<span>${esc(label)}: ${result.error ? `<code>${esc(result.error.code)}</code> ` : ''}${esc(result.message)}</span>`
  ))
  const workspaceResultHtml = workspaceResultParts.length > 0
    ? `<div class="v2-local-group-result" data-role="local-group-workspace-result">${workspaceResultParts.join(' ')}</div>`
    : ''
  const agentControlsHtml = selectedMember ? `
    <div class="v2-agent-controls" data-role="agent-capabilities" data-member-id="${esc(selectedMember.memberId)}">
      <button type="button" data-action="start-agent" data-agent-capability="start" data-capability="${esc(selectedAgentCapabilities.start ?? 'unsupported')}"${agentCapabilityUnsupported(selectedAgentCapabilities.start) ? ' disabled' : ''}>Start Agent</button>
      <button type="button" data-action="resume-agent" data-agent-capability="resume" data-capability="${esc(selectedAgentCapabilities.resume ?? 'unsupported')}"${agentCapabilityUnsupported(selectedAgentCapabilities.resume) ? ' disabled' : ''}>Resume Agent</button>
      <span class="v2-capability-reason">Agent start and resume are unsupported by this daemon composition.</span>
    </div>
  ` : ''
  const machineFilterHtml = `
    <div class="v2-machine-filter" data-role="machine-filter">
      <label class="v2-form-field"><span>Machine</span>
        <input name="machineFilter" data-action="filter-members-by-machine" value="${esc(machineFilter)}" list="workspace-machine-options" autocomplete="off">
      </label>
      <datalist id="workspace-machine-options">${machineFilterOptions.map((machineId) => `<option value="${esc(machineId)}"></option>`).join('')}</datalist>
    </div>
  `

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
          ${machineFilterHtml}
        </div>
        <div class="v2-panel card">
          <div class="card-title-row">
            <div>
              <div class="card-title">Local Group Configuration</div>
              <div class="card-sub">Create structure, configure runtimes, and bind existing sessions</div>
            </div>
            <span class="badge badge-neutral">Revision ${esc(activeWorkspace?.revision ?? 'unknown')}</span>
          </div>
          ${workspaceResultHtml}
          ${groupFormHtml}
          ${memberFormHtml}
          ${runtimeFormHtml}
          ${bindingFormHtml}
          ${agentControlsHtml}
          ${resultHtml}
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
      groups,
      machineFilter,
      machineOptions,
      selectedMember,
      selectedRuntime,
      selectedBinding,
      selectedGeneration,
      selectedAgentCapabilities,
      localGroupMemberResults,
      localGroupPendingByMemberId,
      localGroupPending,
      localGroupResults,
      propertiesLoadable: effectivePropertiesLoadable,
      saving,
      saveError,
    },
    pageId: 'workspaces',
  }
}

export { esc }
