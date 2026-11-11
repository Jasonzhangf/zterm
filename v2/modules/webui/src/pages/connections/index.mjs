function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function badge(helpers, state, freshness = 'fresh') {
  const result = helpers.renderStatusBadge
    ? helpers.renderStatusBadge({ state, freshness })
    : { html: `<span class="v2-status-badge" data-status-state="${esc(state)}">${esc(state)}</span>`, model: {} }
  return result.html
}

export function renderConnectionsPage(state = {}, helpers = {}) {
  const {
    machinesLoadable = { status: 'loading', value: null, error: null },
    connectionError = null,
    machines = [],
    formPending = false,
  } = state

  const items = machinesLoadable.status === 'ready' ? (machinesLoadable.value ?? machines) : machines
  const itemsHtml = items.map((machine) => {
    const status = machine.status || 'unknown'
    const freshness = machine.freshness || (status === 'online' ? 'fresh' : 'stale')
    return `
      <li class="v2-machine-row" data-machine-id="${esc(machine.machineId)}" data-machine-status="${esc(status)}">
        <div class="v2-machine-name">${esc(machine.name || machine.machineId)}</div>
        <div class="v2-machine-address">${esc(machine.address || '')}</div>
        <div class="v2-machine-badge">${badge(helpers, status, freshness)}</div>
      </li>
    `
  }).join('')

  const loadableHtml = machinesLoadable.status === 'loading'
    ? '<div class="v2-loading" data-role="connections-loading">Loading connections...</div>'
    : machinesLoadable.status === 'unavailable'
      ? (helpers.renderErrorNotice
          ? helpers.renderErrorNotice({ error: machinesLoadable.error, title: 'Connections unavailable' }).html
          : `<div class="v2-unavailable">Connections unavailable</div>`)
      : `<ul class="v2-machine-list" data-role="connections-list">${itemsHtml}</ul>`

  const formActionsHtml = helpers.renderFormActions
    ? helpers.renderFormActions({
        formId: 'connections-form',
        pending: formPending,
        error: connectionError,
        submitLabel: 'Add connection',
        cancelLabel: 'Cancel',
      }).html
    : ''

  const html = `
    <section class="v2-page v2-page-connections" data-page="connections" data-page-id="connections" data-route-scope="global">
      <div class="page-title-row">
        <div>
          <h1 class="v2-page-title">连接与机器恢复 (Connections &amp; Hosts)</h1>
          <div class="v2-page-subtitle">全局账号下已授权的本机与远端机器、SSH/Tunnel 通道健康度与断线恢复入口</div>
        </div>
      </div>
      <div class="grid-2">
        <div class="v2-panel card">
          <div class="card-title-row">
            <div>
              <div class="card-title">已注册机器与连接节点</div>
              <div class="card-sub">实时反映各机器在线、忙碌、Stale 与离线状态</div>
            </div>
            <span class="badge badge-neutral">${items.length} 节点</span>
          </div>
          ${loadableHtml}
        </div>
        <form id="connections-form" class="v2-form card" data-role="connections-form" novalidate>
          <div class="card-title-row" style="grid-column:1 / -1;">
            <div>
              <div class="card-title">接入新机器 / 恢复远端连接</div>
              <div class="card-sub">输入远端 Daemon 地址与授权 Token 建立连接</div>
            </div>
          </div>
          <label class="v2-field">
            <span>Machine address</span>
            <input name="machineAddress" data-field="machine-address" placeholder="ssh://dev@10.0.4.18:22 或 http://127.0.0.1:7419" />
          </label>
          <label class="v2-field">
            <span>Connection token</span>
            <input name="connectionToken" type="password" data-field="connection-token" placeholder="zt_conn_..." />
          </label>
          ${formActionsHtml}
        </form>
      </div>
    </section>
  `

  return {
    html,
    model: {
      pageId: 'connections',
      machinesLoadable,
      machines: items,
      connectionError,
      formPending,
    },
    pageId: 'connections',
  }
}

export { badge }
