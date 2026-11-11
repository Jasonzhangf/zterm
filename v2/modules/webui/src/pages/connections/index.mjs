function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function badge(helpers, state, freshness = 'fresh', label = null) {
  const result = helpers.renderStatusBadge
    ? helpers.renderStatusBadge({ state, freshness, label })
    : { html: `<span class="v2-status-badge" data-status-state="${esc(state)}">${esc(label ?? state)}</span>`, model: {} }
  return result.html
}

function connectionBadge(helpers, status, freshness) {
  const displayState = status === 'connected'
    ? 'online'
    : status === 'unavailable'
      ? 'offline'
      : status
  return badge(helpers, displayState, freshness, status)
}

function renderMachineError(helpers, error, title, machineId) {
  if (!error) return ''
  const notice = helpers.renderErrorNotice
    ? helpers.renderErrorNotice({ error, title }).html
    : `<div class="v2-error-notice">${esc(error.message || error.code || 'Machine action failed')}</div>`
  return `
    <div class="v2-machine-error"
      data-machine-id="${esc(machineId)}"
      data-error-code="${esc(error.code)}"
      data-owning-module="${esc(error.owningModule || '')}"
      data-operation-id="${esc(error.operationId || '')}">
      ${notice}
    </div>
  `
}

function actionButton({ action, machineId, label, disabled = false, pending = false }) {
  return `
    <button type="button" class="btn btn-sm v2-machine-action"
      data-action="${esc(action)}"
      data-machine-id="${esc(machineId)}"
      data-pending="${pending ? 'true' : 'false'}"
      ${disabled ? 'disabled' : ''}>${esc(label)}</button>
  `
}

function machineActions(machineId, connectionState, sessionState, connected) {
  const status = String(connectionState.status || 'unavailable')
  const freshness = String(connectionState.freshness || 'unavailable')
  const pending = connectionState.pending === true || sessionState.pending === true
  const pendingAction = connectionState.pendingAction || null
  const stale = status === 'stale' || status === 'error' || freshness === 'stale' || freshness === 'expired'
  const controls = []

  if (!connected && !stale) {
    controls.push(actionButton({
      action: 'connect-machine',
      machineId,
      label: pendingAction === 'connect-machine' ? 'Connecting...' : 'Connect',
      disabled: pending,
      pending: pendingAction === 'connect-machine',
    }))
  }

  if (connected || stale) {
    controls.push(actionButton({
      action: 'recover-machine',
      machineId,
      label: pendingAction === 'recover-machine' ? 'Recovering...' : 'Recover',
      disabled: pending,
      pending: pendingAction === 'recover-machine',
    }))
  }

  if (connected) {
    controls.push(actionButton({
      action: 'disconnect-machine',
      machineId,
      label: pendingAction === 'disconnect-machine' ? 'Disconnecting...' : 'Disconnect',
      disabled: pending,
      pending: pendingAction === 'disconnect-machine',
    }))
    controls.push(actionButton({
      action: 'list-machine-sessions',
      machineId,
      label: sessionState.pending ? 'Loading sessions...' : 'Load sessions',
      disabled: pending,
      pending: sessionState.pending === true,
    }))
  }

  return controls.length > 0
    ? `<div class="v2-machine-actions" data-role="machine-actions">${controls.join('')}</div>`
    : ''
}

function renderConnectionObservation(connectionState) {
  const connection = connectionState.connection
  const observation = connectionState.observation
  const value = observation?.value || {}
  const generation = value.generation ?? connection?.generation
  const observedAt = connectionState.observedAt || observation?.observedAt || connection?.observedAt
  const path = connection?.path
  const transportKind = connection?.transportKind
  const peerIdentity = connection?.peerIdentityVerified === true ? connection.peerIdentity : null

  return `
    <div class="v2-machine-observation" data-role="machine-observation">
      <span data-role="machine-connection-state">${esc(connectionState.status || 'unavailable')}</span>
      <span data-role="machine-connection-freshness">${esc(connectionState.freshness || 'unavailable')}</span>
      ${observedAt ? `<span data-role="machine-observation-time">${esc(observedAt)}</span>` : ''}
      ${generation !== undefined && generation !== null ? `<span data-role="machine-generation">generation ${esc(generation)}</span>` : ''}
      ${path ? `<span data-role="machine-path">${esc(path)}</span>` : ''}
      ${transportKind ? `<span data-role="machine-transport">${esc(transportKind)}</span>` : ''}
      ${peerIdentity ? `<span data-role="machine-peer-identity">${esc(peerIdentity)}</span>` : ''}
    </div>
  `
}

function renderSessionCatalog(machineId, sessionState) {
  if (!sessionState.loaded) return ''
  if (sessionState.sessions.length === 0) {
    return `
      <div class="v2-machine-sessions-empty" data-role="machine-sessions-empty" data-machine-id="${esc(machineId)}">
        No sessions reported for this machine.
      </div>
    `
  }
  return `
    <ul class="v2-machine-session-list" data-role="machine-sessions-list" data-machine-id="${esc(machineId)}">
      ${sessionState.sessions.map((session) => `
        <li class="v2-machine-session"
          data-session-name="${esc(session.name)}"
          data-session-backend="${esc(session.backend)}"
          data-session-stable-id="${esc(session.stableId)}">
          <span class="v2-machine-session-name">${esc(session.name || session.stableId)}</span>
          <span class="v2-machine-session-meta">${esc(session.backend)} · ${esc(session.stableId)}</span>
        </li>
      `).join('')}
    </ul>
  `
}

export function renderConnectionsPage(state = {}, helpers = {}) {
  const {
    machinesLoadable = { status: 'loading', value: null, error: null },
    machineConnections = {},
    machineSessions = {},
  } = state

  const machines = machinesLoadable.status === 'ready' && Array.isArray(machinesLoadable.value)
    ? machinesLoadable.value
    : []

  const itemsHtml = machines.map((machine) => {
    const machineId = String(machine?.machineId ?? '')
    const connectionState = machineConnections[machineId] || {
      status: 'unavailable',
      freshness: 'unavailable',
      pending: false,
      pendingAction: null,
      error: null,
      connection: null,
      observation: null,
    }
    const sessionState = machineSessions[machineId] || {
      sessions: [],
      loaded: false,
      pending: false,
      error: null,
    }
    const connectionStatus = String(connectionState.status || 'unavailable')
    const connectionFreshness = String(connectionState.freshness || 'unavailable')
    const connected = connectionStatus === 'connected'

    return `
      <li class="v2-machine-row"
        data-machine-id="${esc(machineId)}"
        data-machine-registration-status="${esc(machine?.status || 'unknown')}"
        data-machine-connection-state="${esc(connectionStatus)}"
        data-machine-connection-freshness="${esc(connectionFreshness)}">
        <div class="v2-machine-main">
          <div>
            <div class="v2-machine-name">${esc(machine?.displayName || machineId)}</div>
            <div class="v2-machine-id">${esc(machineId)}</div>
          </div>
          <div class="v2-machine-registration">
            <span class="badge badge-neutral" data-role="machine-registration-status">Registered: ${esc(machine?.status || 'unknown')}</span>
            ${machine?.createdAt ? `<span class="v2-machine-created-at">${esc(machine.createdAt)}</span>` : ''}
          </div>
        </div>
        <div class="v2-machine-connection-summary">
          <div class="v2-machine-connection-badge">${connectionBadge(helpers, connectionStatus, connectionFreshness)}</div>
          ${renderConnectionObservation(connectionState)}
        </div>
        ${machineActions(machineId, connectionState, sessionState, connected)}
        ${renderMachineError(helpers, connectionState.error, 'Connection action failed', machineId)}
        ${renderMachineError(helpers, sessionState.error, 'Session catalog failed', machineId)}
        ${renderSessionCatalog(machineId, sessionState)}
      </li>
    `
  }).join('')

  let loadableHtml
  if (machinesLoadable.status === 'loading') {
    loadableHtml = '<div class="v2-loading" data-role="connections-loading">Loading machines...</div>'
  } else if (machinesLoadable.status === 'unavailable') {
    loadableHtml = helpers.renderErrorNotice
      ? helpers.renderErrorNotice({ error: machinesLoadable.error, title: 'Machine directory unavailable' }).html
      : '<div class="v2-unavailable">Machine directory unavailable</div>'
  } else if (machines.length === 0) {
    loadableHtml = '<div class="v2-empty" data-role="connections-empty">No authorized machines were reported.</div>'
  } else {
    loadableHtml = `<ul class="v2-machine-list" data-role="connections-list">${itemsHtml}</ul>`
  }

  const html = `
    <section class="v2-page v2-page-connections" data-page="connections" data-page-id="connections" data-route-scope="global">
      <div class="page-title-row">
        <div>
          <h1 class="v2-page-title">连接与机器恢复 (Connections &amp; Hosts)</h1>
          <div class="v2-page-subtitle">当前账号已授权的机器目录、独立连接状态与 session catalog</div>
        </div>
      </div>
      <div class="v2-panel card">
        <div class="card-title-row">
          <div>
            <div class="card-title">已授权机器</div>
            <div class="card-sub">机器登记、连接事实和 session catalog 分开显示</div>
          </div>
          <span class="badge badge-neutral">${machines.length} 节点</span>
        </div>
        ${loadableHtml}
      </div>
    </section>
  `

  return {
    html,
    model: {
      pageId: 'connections',
      machinesLoadable,
      machines,
      machineConnections,
      machineSessions,
    },
    pageId: 'connections',
  }
}

export { badge }
