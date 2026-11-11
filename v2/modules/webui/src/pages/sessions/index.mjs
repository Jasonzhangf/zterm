import {
  renderWindowFrame as defaultRenderWindowFrame,
  renderErrorNotice as defaultRenderErrorNotice,
  renderWorkspaceTree as defaultRenderWorkspaceTree,
} from '../../components/index.mjs'
import {
  renderSessionWorkbench as defaultRenderSessionWorkbench,
  renderSessionPreviewCanvas as defaultRenderSessionPreviewCanvas,
  renderSessionFocusView as defaultRenderSessionFocusView,
  renderWorkspaceQuickSwitch as defaultRenderWorkspaceQuickSwitch,
} from '../../features/sessions/index.mjs'

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function statusText(member) {
  if (!member) return 'unknown'
  return member.status || 'unknown'
}

function memberById(members, memberId) {
  return (members || []).find((member) => member.memberId === memberId) || null
}

function loadableItems(loadable) {
  return loadable && loadable.status === 'ready' && Array.isArray(loadable.value) ? loadable.value : []
}

function loadableState(loadable) {
  if (!loadable || loadable.status === 'loading') return 'loading'
  return loadable.status === 'ready' ? 'ready' : 'unavailable'
}

// Truthful per-window projection: only rows bound to the window's own memberId
// inside the active workspace are counted. Missing data stays loading or
// unavailable; a loaded member with no rows stays an explicit empty.
function projectMemberWorkStatus({ memberId, workspaceId, goalsLoadable, ticketsLoadable }) {
  const boardState = loadableState(goalsLoadable)
  const ticketState = loadableState(ticketsLoadable)
  const boardCount = boardState === 'ready'
    ? loadableItems(goalsLoadable).filter((goal) => String(goal.ownerMemberId ?? '') === memberId).length
    : null
  const ticketCount = ticketState === 'ready'
    ? loadableItems(ticketsLoadable).filter((ticket) => String(ticket.assigneeId ?? '') === memberId).length
    : null
  const state = boardState === 'unavailable' && ticketState === 'unavailable'
    ? 'unavailable'
    : (boardState === 'loading' || ticketState === 'loading' ? 'loading' : 'ready')
  return {
    workspaceId,
    memberId,
    state,
    boardState: boardCount === 0 ? 'empty' : boardState,
    boardCount,
    ticketState: ticketCount === 0 ? 'empty' : ticketState,
    ticketCount,
  }
}

function fallbackWindowFrame({
  windowId,
  memberId,
  title,
  member,
  isPrimary = false,
  isFocused = false,
  propertyOpen = false,
  bodyHtml = '',
  overflowOpen = false,
  availableWidth = 360,
}) {
  const status = statusText(member)
  const secondary = isPrimary
    ? [{ id: 'hide-window', label: 'Hide' }]
    : [{ id: 'promote-primary', label: 'Primary' }, { id: 'enter-member-focus', label: 'Focus' }]
  return defaultRenderWindowFrame({
    windowId,
    memberId,
    title: title || memberId,
    status,
    freshness: member?.freshness || 'fresh',
    role: member?.role || '',
    machine: member?.machine || '',
    isPrimary,
    isFocused,
    isStale: status === 'stale' || member?.removedFromWorkspace === true,
    availableWidth,
    propertyOpen,
    propertyPanelHtml: `Properties for ${esc(memberId)}`,
    bodyHtml,
    secondaryActions: secondary,
    overflowOpen,
  }).html
}

function terminalBody(member, terminalBodiesByMember, renderErrorNoticeFn = defaultRenderErrorNotice) {
  const body = terminalBodiesByMember?.[member.memberId]
  if (body) return body
  const unavailableHtml = renderErrorNoticeFn({
    error: {
      code: 'TERMINAL_CLIENT_UNAVAILABLE',
      category: 'terminal',
      message: 'Terminal session handle is not attached.',
      retryable: true,
    },
  }).html
  return `<div class="terminal-viewport" data-terminal-body="true" data-terminal-status="unavailable" data-member-id="${esc(member.memberId)}">${unavailableHtml}<div class="terminal-scroll-owner">Scroll stays inside this terminal.</div></div>`
}

// The window header must report the pane's own session state, not the V1
// member's connection status. A body that never loaded must not read online.
function terminalStatusState(bodyHtml, member) {
  const raw = /data-terminal-status="([^"]+)"/.exec(String(bodyHtml || ''))?.[1] || ''
  if (raw === 'attached') return 'online'
  if (raw === 'starting') return 'busy'
  if (raw === 'unavailable') return 'error'
  if (raw === 'not-loaded') return 'unknown'
  return statusText(member)
}

export function renderSessionsPage(state = {}, helpers = {}) {
  const {
    workspaces = [],
    workspacesLoadable = null,
    activeWorkspaceId = null,
    activeWorkspace = null,
    workspaceScopeError = null,
    members = [],
    membersLoadable = null,
    layout = {},
    viewportMode = 'desktop',
    viewportWidth = 1280,
    viewportHeight = 760,
    terminalBodiesByMember = {},
    propertyPanelsByWindow = {},
    overflowOpenByWindow = {},
    workspaceOverflowOpen = false,
    receipts = [],
    transfers = [],
    lastError = null,
    goalsLoadable = null,
    ticketsLoadable = null,
  } = state

  const primaryId = layout.primaryMemberId ?? members[0]?.memberId ?? null
  const peerIds = layout.peerMemberIds ?? members.slice(1).map((member) => member.memberId)
  const orderedIds = [primaryId, ...peerIds].filter(Boolean)
  const focusedId = layout.focusedMemberId ?? primaryId
  const previewViewport = layout.previewViewport ?? { zoom: 1, panX: 0, panY: 0 }

  const renderQuickSwitchFn = helpers.renderWorkspaceQuickSwitch || defaultRenderWorkspaceQuickSwitch
  const quickSwitchHtml = renderQuickSwitchFn({
    workspaces,
    activeWorkspaceId,
    maxVisiblePills: 3,
    overflowOpen: workspaceOverflowOpen,
  }).html

  const renderWindowFrameFn = helpers.renderWindowFrame || defaultRenderWindowFrame
  const renderWorkbenchFn = helpers.renderSessionWorkbench || defaultRenderSessionWorkbench
  const renderPreviewFn = helpers.renderSessionPreviewCanvas || defaultRenderSessionPreviewCanvas
  const renderFocusFn = helpers.renderSessionFocusView || defaultRenderSessionFocusView
  const renderErrorNoticeFn = helpers.renderErrorNotice || defaultRenderErrorNotice
  const renderWorkspaceTreeFn = helpers.renderWorkspaceTree || defaultRenderWorkspaceTree

  function frameFor(memberOrProps, opts = {}) {
    const isPropsObj = memberOrProps && typeof memberOrProps === 'object'
    const memberId = isPropsObj ? memberOrProps.memberId : memberOrProps
    const isPrimary = isPropsObj ? Boolean(memberOrProps.primary || memberOrProps.isPrimary) : Boolean(opts.isPrimary)
    const isFocused = isPropsObj ? Boolean(memberOrProps.isFocused) : Boolean(opts.isFocused)
    const member = memberById(members, memberId)
    if (!member) return ''
    const windowId = isPrimary ? 'window-primary' : (isPropsObj && memberOrProps.windowId ? memberOrProps.windowId : `window-${memberId}`)
    const altWindowId = `window-${memberId}`
    const peerWindowId = `window-peer-${memberId}`
    const openMap = layout.openPropertyByWindow || {}
    const propertyOpen = Boolean(
      (isPropsObj && memberOrProps.propertyOpen) ||
      openMap[windowId] ||
      openMap[altWindowId] ||
      openMap[peerWindowId] ||
      propertyPanelsByWindow[windowId] ||
      propertyPanelsByWindow[altWindowId] ||
      propertyPanelsByWindow[peerWindowId]
    )
    const propertyPanelHtml =
      (isPropsObj && memberOrProps.propertyPanelHtml) ||
      propertyPanelsByWindow[windowId] ||
      propertyPanelsByWindow[altWindowId] ||
      propertyPanelsByWindow[peerWindowId] ||
      `<div data-role="property-panel" data-window-id="${esc(windowId)}" data-member-id="${esc(memberId)}">Properties for ${esc(memberId)}</div>`
    const overflowOpen = Boolean(
      overflowOpenByWindow[windowId] ||
      overflowOpenByWindow[altWindowId] ||
      overflowOpenByWindow[peerWindowId]
    )
    const widthPx = isPropsObj && Number.isFinite(memberOrProps.widthPx)
      ? memberOrProps.widthPx
      : null
    const heightPx = isPropsObj && Number.isFinite(memberOrProps.heightPx)
      ? memberOrProps.heightPx
      : null
    const availableWidth = isPropsObj && Number.isFinite(memberOrProps.availableWidth)
      ? memberOrProps.availableWidth
      : (widthPx ?? (isPrimary ? 480 : 320))
    const workspaceActions = activeWorkspaceId
      ? [
          { id: 'open-board', label: 'Board', workspaceId: activeWorkspaceId, memberId },
          { id: 'open-tickets', label: 'Tickets', workspaceId: activeWorkspaceId, memberId },
        ]
      : []
    const workStatus = activeWorkspaceId
      ? projectMemberWorkStatus({ memberId, workspaceId: activeWorkspaceId, goalsLoadable, ticketsLoadable })
      : null
    const bodyHtml = (isPropsObj && (memberOrProps.bodyHtml || memberOrProps.terminalBodyHtml))
      || terminalBody(member, terminalBodiesByMember, renderErrorNoticeFn)
    const secondaryActions = [
      ...(isPrimary
        ? [{ id: 'hide-window', label: 'Hide' }]
        : [{ id: 'promote-primary', label: 'Primary' }, { id: 'enter-member-focus', label: 'Focus' }]),
      ...workspaceActions,
    ]
    return renderWindowFrameFn({
      windowId,
      memberId,
      title: member.name || memberId,
      status: terminalStatusState(bodyHtml, member),
      freshness: member.freshness || 'fresh',
      role: member.role || '',
      machine: member.machine || '',
      isPrimary,
      isFocused,
      isStale: member.status === 'stale' || member.removedFromWorkspace === true,
      availableWidth,
      widthPx,
      heightPx,
      propertyOpen,
      propertyPanelHtml,
      bodyHtml,
      secondaryActions,
      overflowOpen,
      workStatus,
    }).html
  }

  const membersById = Object.fromEntries(members.map((member) => [member.memberId, member]))
  const resolvedWorkspace = activeWorkspace || workspaces.find((ws) => ws.workspaceId === activeWorkspaceId) || null
  const workspacePathText = resolvedWorkspace?.path || resolvedWorkspace?.name || activeWorkspaceId || '未选择 Workspace'

  let contentHtml = ''
  if (workspaceScopeError) {
    contentHtml = `<div class="v2-sessions-unavailable card" data-role="workspace-scope-error" data-workspace-id="${esc(activeWorkspaceId || '')}" data-error-code="${esc(workspaceScopeError.code || '')}">${renderErrorNoticeFn({ error: workspaceScopeError, title: `Workspace 不可访问 (${activeWorkspaceId || 'unknown'})` }).html}</div>`
  } else if (!activeWorkspaceId) {
    if (workspacesLoadable && workspacesLoadable.status === 'unavailable') {
      contentHtml = `<div class="v2-sessions-unavailable card" data-role="sessions-unavailable" data-status="unavailable">${renderErrorNoticeFn({ error: workspacesLoadable.error }).html}</div>`
    } else if (membersLoadable && membersLoadable.status === 'unavailable') {
      contentHtml = `<div class="v2-sessions-unavailable card" data-role="sessions-unavailable" data-status="unavailable">${renderErrorNoticeFn({ error: membersLoadable.error }).html}</div>`
    } else {
      const treeHtml = renderWorkspaceTreeFn({
        workspacesLoadable: workspacesLoadable || { status: 'ready', value: workspaces, error: null },
        activeWorkspaceId: null,
      }).html
      contentHtml = `
        <div class="v2-panel card" data-role="workspace-selection-required">
          <div class="card-title-row">
            <div>
              <div class="card-title">请先选择或创建 Workspace</div>
              <div class="card-sub">Sessions 工作台按所选 Workspace 隔离运行，不跨工作区混排终端。</div>
            </div>
            <button type="button" class="btn btn-primary btn-sm" data-action="navigate" data-route="workspaces">管理 / 新建 Workspace</button>
          </div>
          ${treeHtml}
        </div>
      `
    }
  } else if (membersLoadable && membersLoadable.status === 'unavailable' && members.length === 0) {
    contentHtml = `<div class="v2-sessions-unavailable card" data-role="sessions-unavailable" data-status="unavailable">${renderErrorNoticeFn({ error: membersLoadable.error }).html}</div>`
  } else if (membersLoadable && membersLoadable.status === 'loading' && members.length === 0) {
    contentHtml = `<div class="v2-loading card" data-role="sessions-loading" data-workspace-id="${esc(activeWorkspaceId)}">正在加载工作区 ${esc(workspacePathText)} 的终端会话...</div>`
  } else if (viewportMode === 'mobile' && layout.mobileMode === 'focus') {
    contentHtml = renderFocusFn({
      layout,
      membersById,
      terminalBodiesByMember,
      propertyPanelsByWindow,
      renderFrame: frameFor,
      availableWidth: Math.max(0, Number(viewportWidth || 0) - 16),
    }).html
  } else if (viewportMode === 'mobile') {
    contentHtml = renderPreviewFn({
      layout,
      membersById,
      terminalBodiesByMember,
      propertyPanelsByWindow,
      renderFrame: frameFor,
    }).html
  } else {
    contentHtml = renderWorkbenchFn({
      layout,
      membersById,
      terminalBodiesByMember,
      propertyPanelsByWindow,
      containerWidth: Math.max(640, Number(viewportWidth || 1280) - 248),
      containerHeight: Math.max(480, Number(viewportHeight || 760) - 100),
      renderFrame: frameFor,
    }).html
  }

  const mobileModeControls = viewportMode === 'mobile'
    ? `
      <div class="v2-mobile-mode-bar" data-role="mobile-mode-bar">
        <button type="button" class="btn btn-sm${(layout.mobileMode || 'preview') === 'preview' ? ' btn-primary' : ''}" data-action="switch-mobile-mode" data-mobile-mode="preview" aria-pressed="${(layout.mobileMode || 'preview') === 'preview'}">2D 预览画布</button>
        <button type="button" class="btn btn-sm${layout.mobileMode === 'focus' ? ' btn-primary' : ''}" data-action="switch-mobile-mode" data-mobile-mode="focus" aria-pressed="${layout.mobileMode === 'focus'}">单窗口专注</button>
      </div>
    `
    : ''

  const html = `
    <section class="v2-page v2-page-sessions sessions-shell" data-page="sessions" data-page-id="sessions" data-workspace-id="${esc(activeWorkspaceId || '')}" data-viewport-mode="${esc(viewportMode)}">
      <div class="v2-sessions-topbar sessions-toolbar">
        ${quickSwitchHtml}
        <span class="badge badge-neutral" data-role="active-workspace-path">${esc(workspacePathText)}</span>
        ${mobileModeControls}
        <div class="v2-viewport-mode" data-role="viewport-mode-indicator">${esc(viewportMode === 'desktop' ? 'desktop 1+4 workbench' : `mobile ${layout.mobileMode || 'preview'}`)}</div>
      </div>
      <div class="sessions-stage">
        ${contentHtml}
      </div>
    </section>
  `

  return {
    html,
    model: {
      pageId: 'sessions',
      activeWorkspaceId,
      workspacePath: workspacePathText,
      viewportMode,
      mobileMode: layout.mobileMode ?? 'preview',
      primaryMemberId: primaryId,
      peerMemberIds: peerIds,
      memberIds: orderedIds,
      focusedMemberId: focusedId,
      previewViewport,
      receipts,
      transfers,
      lastError,
      workspaceScopeError,
    },
    pageId: 'sessions',
  }
}

export { fallbackWindowFrame, terminalBody, terminalStatusState }
