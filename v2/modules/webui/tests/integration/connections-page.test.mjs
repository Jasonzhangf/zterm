import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { createWebUIApp } from '../../src/app/app-shell.mjs'

const MACHINE_REMOTE = 'machine-remote'
const MACHINE_LOCAL = 'machine-local'

function machine(machineId, displayName) {
  return {
    machineId,
    ownerAccountId: 'account-current',
    displayName,
    status: 'active',
    createdAt: '2026-11-11T00:00:00.000Z',
  }
}

function connectionObservation(machineId, { generation = 1, status = 'connected', freshness = 'fresh' } = {}) {
  return {
    source: 'connections',
    observedAt: '2026-11-11T00:00:00.000Z',
    value: {
      machineId,
      generation,
      status,
      freshness,
    },
  }
}

function connectionPayload(machineId, { generation = 1, status = 'connected', freshness = 'fresh' } = {}) {
  return {
    connection: {
      machineId,
      generation,
      path: 'direct',
      status,
      freshness,
      observedAt: '2026-11-11T00:00:00.000Z',
      transportKind: 'websocket',
      peerIdentity: `daemon-${machineId}`,
      peerIdentityVerified: true,
      capabilities: {
        channelKinds: ['terminal'],
        transportKind: 'websocket',
      },
      backpressure: {
        queuedBytes: 0,
        bufferedBytes: 0,
        backpressured: false,
      },
    },
    observation: connectionObservation(machineId, { generation, status, freshness }),
  }
}

function createMachineHarness(overrides = {}) {
  const machines = overrides.machines ?? [
    machine(MACHINE_REMOTE, 'Remote Mac'),
    machine(MACHINE_LOCAL, 'Local Mac'),
  ]
  const workspaces = overrides.workspaces ?? []
  const calls = {
    listWorkspaces: [],
    getWorkspaceSnapshot: [],
    accountsSessionState: [],
    accountsLogin: [],
    accountsLogout: [],
    listMachines: [],
    connectMachine: [],
    getMachineConnection: [],
    recoverMachine: [],
    disconnectMachine: [],
    listMachineSessions: [],
  }
  const generationByMachine = new Map()
  let accountsSignedIn = overrides.accountsSignedIn !== false
  const account = {
    accountId: 'account-current',
    loginName: 'alice',
  }

  function nextGeneration(machineId) {
    const next = (generationByMachine.get(machineId) || 0) + 1
    generationByMachine.set(machineId, next)
    return next
  }

  const daemonApi = {
    calls,
    async accountsSessionState() {
      calls.accountsSessionState.push({})
      if (overrides.accountsSessionError) {
        throw overrides.accountsSessionError
      }
      if (!accountsSignedIn) {
        throw {
          code: 'AUTHENTICATION_REQUIRED',
          owningModule: 'accounts',
          message: 'An accounts session is required.',
        }
      }
      return { account }
    },
    async accountsLogin({ loginName, credential } = {}) {
      calls.accountsLogin.push({ loginName, credential })
      if (overrides.accountsLoginError) {
        throw overrides.accountsLoginError
      }
      accountsSignedIn = true
      return { token: 'accounts-token-fixture', account }
    },
    async accountsLogout() {
      calls.accountsLogout.push({})
      accountsSignedIn = false
      return { ok: true }
    },
    async listWorkspaces() {
      calls.listWorkspaces.push({})
      if (overrides.listWorkspacesError) {
        throw overrides.listWorkspacesError
      }
      return workspaces
    },
    async getBootstrap() {
      return { configured: true }
    },
    async getWorkspaceSnapshot({ workspaceId } = {}) {
      calls.getWorkspaceSnapshot.push({ workspaceId })
      return {
        workspace: { workspaceId, name: 'Workspace' },
        members: [],
      }
    },
    async listMachines() {
      calls.listMachines.push({})
      if (overrides.listMachinesError) {
        throw overrides.listMachinesError
      }
      return {
        machines,
        observation: {
          source: 'accounts',
          observedAt: '2026-11-11T00:00:00.000Z',
          value: { machines: machines.length },
        },
      }
    },
    async connectMachine({ machineId } = {}) {
      calls.connectMachine.push({ machineId })
      const defaultResult = () => connectionPayload(machineId, { generation: nextGeneration(machineId) })
      if (typeof overrides.connectMachine === 'function') {
        return overrides.connectMachine(machineId, defaultResult)
      }
      return defaultResult()
    },
    async getMachineConnection({ machineId } = {}) {
      calls.getMachineConnection.push({ machineId })
      return connectionPayload(machineId, { generation: generationByMachine.get(machineId) || 1 })
    },
    async recoverMachine({ machineId } = {}) {
      calls.recoverMachine.push({ machineId })
      const defaultResult = () => connectionPayload(machineId, { generation: nextGeneration(machineId) })
      if (typeof overrides.recoverMachine === 'function') {
        return overrides.recoverMachine(machineId, defaultResult)
      }
      return defaultResult()
    },
    async disconnectMachine({ machineId } = {}) {
      calls.disconnectMachine.push({ machineId })
      generationByMachine.delete(machineId)
      return {
        disconnected: true,
        machineId,
        connection: null,
        status: 'unavailable',
        observation: connectionObservation(machineId, { generation: null, status: 'unavailable', freshness: 'unavailable' }),
      }
    },
    async listMachineSessions({ machineId } = {}) {
      calls.listMachineSessions.push({ machineId })
      if (typeof overrides.listMachineSessions === 'function') {
        return overrides.listMachineSessions(machineId)
      }
      return {
        sessions: [{ name: 'remote-shell', backend: 'tmux', stableId: 'tmux:v1:remote-shell' }],
        observation: {
          source: 'connections',
          observedAt: '2026-11-11T00:00:00.000Z',
          value: { machineId, generation: generationByMachine.get(machineId) || 1, sessions: 1 },
        },
      }
    },
  }

  return { daemonApi, machines, workspaces, calls }
}

function createMachineApp(harness, options = {}) {
  return createWebUIApp({
    daemonApi: harness.daemonApi,
    initialRoute: 'connections',
    initialWorkspaceId: options.initialWorkspaceId ?? null,
    viewportWidth: 1440,
    viewportHeight: 900,
  })
}

test('connections loads the real machine directory and never projects workspaces as machines', async () => {
  const harness = createMachineHarness({
    workspaces: [{ workspaceId: 'ws-alpha', name: 'Workspace Alpha', status: 'online' }],
  })
  const app = createMachineApp(harness, { initialWorkspaceId: 'ws-alpha' })
  await app.ready

  assert.equal(harness.calls.listMachines.length, 1)
  assert.deepEqual(
    app.state.connectionsLoadable.value.map((item) => item.machineId),
    [MACHINE_REMOTE, MACHINE_LOCAL],
  )
  assert.equal(typeof app.ports.daemonApi.listConnections, 'undefined')

  const page = app.renderPage()
  assert.ok(page.html.includes(MACHINE_REMOTE))
  assert.ok(page.html.includes('Remote Mac'))
  assert.ok(!page.html.includes('ws-alpha'))
  assert.ok(!page.html.includes('data-field="machine-address"'))
  assert.ok(!page.html.includes('data-field="connection-token"'))
  assert.ok(!page.html.includes('Add connection'))
  assert.ok(page.html.includes('data-action="connect-machine"'))
  assert.ok(page.html.includes('data-machine-connection-state="unavailable"'))
  assert.ok(!page.html.includes('data-machine-connection-state="connected"'))
})

test('connections requires an accounts session before requesting the machine directory', async () => {
  const harness = createMachineHarness({ accountsSignedIn: false })
  const app = createMachineApp(harness)
  await app.ready

  assert.equal(harness.calls.accountsSessionState.length, 1)
  assert.equal(harness.calls.listMachines.length, 0)
  assert.equal(app.state.accountsSession.status, 'unauthenticated')
  const page = app.renderPage()
  assert.ok(page.html.includes('data-role="accounts-login-form"'))
  assert.ok(page.html.includes('name="loginName"'))
  assert.ok(page.html.includes('name="credential"'))
  assert.ok(page.html.includes('type="password"'))
  assert.ok(!page.html.includes('data-field="machine-address"'))
  assert.ok(!page.html.includes('data-field="connection-token"'))
  assert.ok(!page.html.includes(MACHINE_REMOTE))
})

test('accounts login loads one machine directory and logout clears all machine state', async () => {
  const harness = createMachineHarness({ accountsSignedIn: false })
  const app = createMachineApp(harness)
  await app.ready

  const login = await app.dispatchAction('submit-form', {
    formId: 'accounts-login-form',
    loginName: 'alice',
    credential: 'credential-fixture',
  })
  assert.equal(login.ok, true)
  assert.deepEqual(harness.calls.accountsLogin, [{
    loginName: 'alice',
    credential: 'credential-fixture',
  }])
  assert.equal(harness.calls.listMachines.length, 1)
  assert.equal(app.state.accountsSession.status, 'authenticated')
  assert.deepEqual(app.state.accountsSession.account, {
    accountId: 'account-current',
    loginName: 'alice',
  })
  assert.ok(app.renderPage().html.includes('data-role="accounts-session"'))
  assert.ok(app.renderPage().html.includes('data-action="connect-machine"'))
  assert.ok(app.renderPage().html.includes(MACHINE_REMOTE))

  await app.dispatchAction('connect-machine', { machineId: MACHINE_REMOTE })
  await app.dispatchAction('list-machine-sessions', { machineId: MACHINE_REMOTE })
  assert.equal(app.state.machineConnections[MACHINE_REMOTE].status, 'connected')
  assert.ok(app.state.machineSessions[MACHINE_REMOTE].sessions.length > 0)

  const logout = await app.dispatchAction('logout-accounts')
  assert.equal(logout.ok, true)
  assert.equal(harness.calls.accountsLogout.length, 1)
  assert.equal(app.state.accountsSession.status, 'unauthenticated')
  assert.equal(app.state.connectionsLoadable.value, null)
  assert.deepEqual(app.state.machineConnections, {})
  assert.deepEqual(app.state.machineSessions, {})
  assert.ok(app.renderPage().html.includes('data-role="accounts-login-form"'))
  assert.ok(!app.renderPage().html.includes(MACHINE_REMOTE))
})

test('the mounted connections login form submits the typed accounts credential', async () => {
  const harness = createMachineHarness({ accountsSignedIn: false })
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/connections',
  })
  const app = createMachineApp(harness)
  await app.ready
  app.mount(dom.window.document.querySelector('#root'))

  const root = dom.window.document.querySelector('#root')
  const form = root.querySelector('[data-role="accounts-login-form"]')
  form.querySelector('[name="loginName"]').value = 'alice'
  form.querySelector('[name="credential"]').value = 'credential-fixture'

  const loggedIn = new Promise((resolve) => {
    const unsubscribe = app.subscribe(() => {
      if (
        app.state.accountsSession.status !== 'authenticated'
        || app.state.connectionsLoadable.status !== 'ready'
      ) return
      unsubscribe()
      resolve()
    })
  })
  form.querySelector('button[data-form-id="accounts-login-form"]').click()
  await loggedIn

  assert.deepEqual(harness.calls.accountsLogin, [{
    loginName: 'alice',
    credential: 'credential-fixture',
  }])
  assert.equal(harness.calls.listMachines.length, 1)
  assert.ok(root.querySelector('[data-role="accounts-session"]'))
  assert.ok(root.querySelector('[data-action="connect-machine"]'))
  assert.ok(!root.innerHTML.includes('accounts-token-fixture'))
  app.destroy()
  dom.window.close()
})

test('accounts login errors remain typed and never request machines', async () => {
  const harness = createMachineHarness({
    accountsSignedIn: false,
    accountsLoginError: {
      code: 'INVALID_CREDENTIALS',
      owningModule: 'accounts',
      message: 'The login name or credential is invalid.',
    },
  })
  const app = createMachineApp(harness)
  await app.ready

  const login = await app.dispatchAction('submit-form', {
    formId: 'accounts-login-form',
    loginName: 'alice',
    credential: 'wrong-credential',
  })
  assert.equal(login.ok, false)
  assert.equal(login.error.code, 'INVALID_CREDENTIALS')
  assert.equal(login.error.owningModule, 'accounts')
  assert.equal(app.state.accountsSession.status, 'error')
  assert.equal(app.state.accountsSession.error.code, 'INVALID_CREDENTIALS')
  assert.equal(harness.calls.listMachines.length, 0)
  const page = app.renderPage()
  assert.ok(page.html.includes('INVALID_CREDENTIALS'))
  assert.ok(page.html.includes('data-owning-module="accounts"'))
})

test('workspace load failure does not pollute the machine directory', async () => {
  const harness = createMachineHarness({
    listWorkspacesError: { code: 'WORKSPACES_UNAVAILABLE', message: 'Workspace service failed.' },
  })
  const app = createMachineApp(harness)
  await app.ready

  assert.equal(app.state.workspacesLoadable.status, 'unavailable')
  assert.equal(app.state.connectionsLoadable.status, 'ready')
  assert.deepEqual(
    app.state.connectionsLoadable.value.map((item) => item.machineId),
    [MACHINE_REMOTE, MACHINE_LOCAL],
  )
  assert.ok(app.renderPage().html.includes('Remote Mac'))
})

test('connect, sessions, recover, and disconnect stay bounded to one machine', async () => {
  const harness = createMachineHarness()
  const app = createMachineApp(harness)
  await app.ready

  assert.equal(harness.calls.listMachineSessions.length, 0)

  const connected = await app.dispatchAction('connect-machine', { machineId: MACHINE_REMOTE })
  assert.equal(connected.ok, true)
  assert.equal(app.state.machineConnections[MACHINE_REMOTE].status, 'connected')
  assert.equal(app.state.machineConnections[MACHINE_LOCAL].status, 'unavailable')
  assert.equal(harness.calls.listMachineSessions.length, 0)
  assert.ok(app.renderPage().html.includes('data-action="disconnect-machine"'))

  const sessions = await app.dispatchAction('list-machine-sessions', { machineId: MACHINE_REMOTE })
  assert.equal(sessions.ok, true)
  assert.deepEqual(harness.calls.listMachineSessions.map((call) => call.machineId), [MACHINE_REMOTE])
  assert.equal(app.state.machineSessions[MACHINE_REMOTE].sessions[0].stableId, 'tmux:v1:remote-shell')
  assert.equal(app.state.machineSessions[MACHINE_LOCAL].sessions.length, 0)

  const recovered = await app.dispatchAction('recover-machine', { machineId: MACHINE_REMOTE })
  assert.equal(recovered.ok, true)
  assert.equal(app.state.machineConnections[MACHINE_REMOTE].connection.generation, 2)
  assert.equal(app.state.machineSessions[MACHINE_REMOTE].sessions.length, 0)

  await app.dispatchAction('connect-machine', { machineId: MACHINE_LOCAL })
  const localGeneration = app.state.machineConnections[MACHINE_LOCAL].connection.generation

  const disconnected = await app.dispatchAction('disconnect-machine', { machineId: MACHINE_REMOTE })
  assert.equal(disconnected.ok, true)
  assert.equal(app.state.machineConnections[MACHINE_REMOTE].status, 'unavailable')
  assert.equal(app.state.machineConnections[MACHINE_REMOTE].connection, null)
  assert.equal(app.state.machineSessions[MACHINE_REMOTE].sessions.length, 0)
  assert.equal(app.state.machineConnections[MACHINE_LOCAL].status, 'connected')
  assert.equal(app.state.machineConnections[MACHINE_LOCAL].connection.generation, localGeneration)
})

test('a failed machine action preserves typed ownership and does not affect another machine', async () => {
  const failure = {
    code: 'MACHINE_AUTHORIZATION_REVOKED',
    owningModule: 'accounts',
    operationId: 'machine.connect',
    message: 'The machine authorization is no longer active.',
  }
  const harness = createMachineHarness({
    connectMachine(machineId, defaultResult) {
      if (machineId === MACHINE_LOCAL) {
        throw failure
      }
      return defaultResult()
    },
  })
  const app = createMachineApp(harness)
  await app.ready

  await app.dispatchAction('connect-machine', { machineId: MACHINE_REMOTE })
  const failed = await app.dispatchAction('connect-machine', { machineId: MACHINE_LOCAL })

  assert.equal(failed.ok, false)
  assert.equal(app.state.machineConnections[MACHINE_REMOTE].status, 'connected')
  assert.equal(app.state.machineConnections[MACHINE_LOCAL].status, 'unavailable')
  assert.deepEqual(
    {
      code: app.state.machineConnections[MACHINE_LOCAL].error.code,
      owningModule: app.state.machineConnections[MACHINE_LOCAL].error.owningModule,
      operationId: app.state.machineConnections[MACHINE_LOCAL].error.operationId,
    },
    {
      code: failure.code,
      owningModule: failure.owningModule,
      operationId: failure.operationId,
    },
  )

  const page = app.renderPage()
  assert.ok(page.html.includes(failure.code))
  assert.ok(page.html.includes('data-owning-module="accounts"'))
  assert.ok(page.html.includes('data-operation-id="machine.connect"'))
})

test('a connect response cannot become connected without a connected observation', async () => {
  const harness = createMachineHarness({
    connectMachine(machineId) {
      return {
        connection: {
          machineId,
          generation: 9,
          status: 'connected',
          freshness: 'fresh',
        },
        observation: connectionObservation(machineId, {
          generation: 9,
          status: 'stale',
          freshness: 'fresh',
        }),
      }
    },
  })
  const app = createMachineApp(harness)
  await app.ready

  const result = await app.dispatchAction('connect-machine', { machineId: MACHINE_REMOTE })

  assert.equal(result.ok, true)
  assert.equal(result.status, 'stale')
  assert.equal(app.state.machineConnections[MACHINE_REMOTE].status, 'stale')
  assert.ok(app.renderPage().html.includes('data-machine-connection-state="stale"'))
  assert.ok(!app.renderPage().html.includes('data-action="disconnect-machine"'))
})
