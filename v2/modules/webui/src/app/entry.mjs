import { createWebUIApp } from './app-shell.mjs'
import { createDaemonApi } from '../clients/daemon-api/index.mjs'
import { createPaneTerminalClient } from '../clients/pane-terminal-client.mjs'

export async function resolveProductionPorts(options = {}) {
  const hostPorts = (typeof globalThis !== 'undefined' && globalThis.__ZTERM_V2_PORTS__ && typeof globalThis.__ZTERM_V2_PORTS__ === 'object')
    ? globalThis.__ZTERM_V2_PORTS__
    : {}

  const daemonConfig = options.daemonConfig ?? hostPorts.daemonConfig ?? {}
  const daemonApi = options.daemonApi ?? hostPorts.daemonApi ?? createDaemonApi({
    baseUrl: options.daemonBaseUrl ?? hostPorts.daemonBaseUrl ?? '',
    ...daemonConfig,
  })

    const terminalClient = options.terminalClient ?? hostPorts.terminalClient
      ?? (daemonApi && typeof daemonApi.openTerminalStream === 'function'
        ? createPaneTerminalClient({ api: daemonApi })
        : null)
  const deliveryClient = options.deliveryClient ?? hostPorts.deliveryClient ?? null
  const terminalViewportFactory = options.terminalViewportFactory ?? hostPorts.terminalViewportFactory ?? null

  return {
    daemonApi,
    terminalClient,
    deliveryClient,
    terminalViewportFactory,
  }
}

export function mountWebUI(options = {}) {
  const root = options.root
    || (typeof document !== 'undefined' ? document.getElementById('app') : null)
  const hostPorts = (typeof globalThis !== 'undefined' && globalThis.__ZTERM_V2_PORTS__ && typeof globalThis.__ZTERM_V2_PORTS__ === 'object')
    ? globalThis.__ZTERM_V2_PORTS__
    : {}
  const app = createWebUIApp({
    ...hostPorts,
    ...options,
    root,
  })
  app.mount(root)
  if (typeof window !== 'undefined') window.__ZTERM_V2_WEBUI__ = app
  return app
}

export async function bootstrapWebUI(options = {}) {
  const ports = await resolveProductionPorts(options)
  return mountWebUI({
    ...ports,
    ...options,
  })
}

  async function sessionNeedsLogin(daemonApi) {
    if (!daemonApi || typeof daemonApi.sessionState !== 'function') {
      return false
    }
    try {
      const state = await daemonApi.sessionState()
      return state.configured !== false && state.authenticated !== true
    } catch {
      return false
    }
  }

  function renderLoginGate(root, daemonApi, onSuccess) {
    root.innerHTML = `
      <div class="v2-login-gate" data-role="v2-login-gate">
        <form class="card" data-role="v2-login-form">
          <h1 class="v2-page-title">Zterm V2</h1>
          <p class="card-sub">输入 V2 访问令牌以连接本机 daemon。</p>
          <label class="v2-field" for="v2-login-token">Access token
            <input id="v2-login-token" type="password" autocomplete="off" spellcheck="false" />
          </label>
          <button class="btn btn-primary" type="submit" data-role="v2-login-submit">进入</button>
          <p class="gate-error" data-role="v2-login-error" role="alert"></p>
        </form>
      </div>
    `
    const form = root.querySelector('[data-role="v2-login-form"]')
    const input = root.querySelector('#v2-login-token')
    const errorEl = root.querySelector('[data-role="v2-login-error"]')
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const token = input.value.trim()
      if (!token) {
        errorEl.textContent = 'V2_CREDENTIAL_REQUIRED'
        return
      }
      try {
        await daemonApi.login(token)
        input.value = ''
        errorEl.textContent = ''
        root.innerHTML = ''
        await onSuccess()
      } catch (error) {
        errorEl.textContent = `${error.code || 'LOGIN_FAILED'}: ${error.message || error}`
      }
    })
  }

  // Production boot: resolve real ports, gate on the V2 session, then mount the
  // shell. The gate reuses the daemon login route; the access token never leaves
  // the browser as a build parameter or a rendered attribute.
  export async function bootProductionWebUI(options = {}) {
    const ports = await resolveProductionPorts(options)
    const root = options.root
      || (typeof document !== 'undefined' ? document.getElementById('app') : null)
    if (root && (await sessionNeedsLogin(ports.daemonApi))) {
      renderLoginGate(root, ports.daemonApi, () => bootProductionWebUI(options))
      return null
    }
    return mountWebUI({
      ...ports,
      ...options,
      root,
    })
  }

  if (typeof document !== 'undefined') {
    const mount = () => {
      const root = document.getElementById('app')
      if (root && !root.__ztermV2Mounted) {
        root.__ztermV2Mounted = true
        void bootProductionWebUI({ root })
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount, { once: true })
    } else {
      mount()
    }
  }

  export { createWebUIApp }
