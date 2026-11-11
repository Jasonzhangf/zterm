function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function statusLabel(status) {
  return {
    loading: 'Checking setup...',
    ready: 'Ready',
    unavailable: 'Unavailable',
  }[status] ?? status
}

export function renderSetupPage(state = {}, helpers = {}) {
  const {
    accountName = '',
    deviceName = '',
    daemonUrl = '',
    authToken = '',
    bootstrap = { status: 'loading', value: null, error: null },
    formPending = false,
    formError = null,
  } = state

  const errorHtml = bootstrap.error
    ? (helpers.renderErrorNotice ? helpers.renderErrorNotice({ error: bootstrap.error }).html : '')
    : ''

  const bootstrapHtml = bootstrap.status === 'loading'
    ? `<div class="v2-loading" data-role="bootstrap-status" data-status="loading">${esc(statusLabel('loading'))}</div>`
    : bootstrap.status === 'unavailable'
      ? `<div class="v2-unavailable" data-role="bootstrap-status" data-status="unavailable">${esc(statusLabel('unavailable'))}</div>`
      : `<div class="v2-ready" data-role="bootstrap-status" data-status="ready">${esc(statusLabel('ready'))}</div>`

  const formActionsHtml = helpers.renderFormActions
    ? helpers.renderFormActions({
        formId: 'setup-form',
        pending: formPending,
        error: formError,
        submitLabel: 'Initialize account',
        cancelLabel: 'Cancel',
      }).html
    : ''

  const html = `
    <section class="v2-page v2-page-setup" data-page="setup" data-page-id="setup" data-route-scope="global">
      <div class="page-title-row">
        <div>
          <h1 class="v2-page-title">初始化向导与全局配置 (First-Run Setup)</h1>
          <div class="v2-page-subtitle">首次启动引导与可随时回访的全局账号、本机节点与默认工作区配置入口</div>
        </div>
      </div>
      <div class="v2-panel card">
        <div class="card-title-row">
          <div>
            <div class="card-title">步骤 1–3 · 账号身份、本机 Daemon 绑定与初始化状态</div>
            <div class="card-sub">未接通后端服务端口时诚实投影 Unavailable 状态，不伪装已连接</div>
          </div>
        </div>
        ${bootstrapHtml}
        ${errorHtml}
        <form id="setup-form" class="v2-form" data-role="setup-form" novalidate style="margin-top:10px;">
          <label class="v2-field">
            <span>Account name</span>
            <input name="accountName" data-field="account-name" value="${esc(accountName)}" autocomplete="username" />
          </label>
          <label class="v2-field">
            <span>Device name</span>
            <input name="deviceName" data-field="device-name" value="${esc(deviceName)}" autocomplete="off" />
          </label>
          <label class="v2-field">
            <span>Daemon URL</span>
            <input name="daemonUrl" data-field="daemon-url" value="${esc(daemonUrl)}" autocomplete="url" />
          </label>
          <label class="v2-field">
            <span>Auth token</span>
            <input name="authToken" type="password" data-field="auth-token" value="${esc(authToken)}" autocomplete="off" />
          </label>
          ${formActionsHtml}
        </form>
      </div>
    </section>
  `

  return {
    html,
    model: {
      pageId: 'setup',
      accountName,
      deviceName,
      daemonUrl,
      authToken,
      bootstrap,
      formPending,
      formError,
    },
    pageId: 'setup',
  }
}

export { statusLabel }
