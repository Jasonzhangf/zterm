import assert from 'node:assert/strict'
import test from 'node:test'

import { createDaemonApi } from '../../src/clients/daemon-api/index.mjs'

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function streamResponse() {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.close()
      },
    }),
    json: async () => ({}),
  }
}

test('accounts session methods use exact routes and keep V2 and accounts credentials separate', async () => {
  const calls = []
  const api = createDaemonApi({
    baseUrl: 'http://daemon.test',
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(String(url), 'http://daemon.test')
      calls.push({
        path: parsed.pathname,
        method: options.method || 'GET',
        authorization: options.headers?.authorization,
        accountsSession: options.headers?.['x-zterm-accounts-session'],
        body: options.body ? JSON.parse(options.body) : undefined,
      })
      if (parsed.pathname === '/api/auth/login') {
        return jsonResponse(200, { ok: true, csrfToken: 'csrf-fixture' })
      }
      if (parsed.pathname === '/api/accounts/login') {
        return jsonResponse(200, {
          token: 'accounts-token-fixture',
          account: { accountId: 'account-current', loginName: 'alice' },
        })
      }
      if (parsed.pathname === '/api/accounts/session') {
        return jsonResponse(200, {
          account: { accountId: 'account-current', loginName: 'alice' },
        })
      }
      if (parsed.pathname === '/api/accounts/logout') {
        return jsonResponse(200, { ok: true })
      }
      if (parsed.pathname === '/api/machines') {
        return jsonResponse(200, { machines: [], observation: null })
      }
      throw new Error(`unexpected path ${parsed.pathname}`)
    },
  })

  await api.login('v2-token-fixture')
  await api.accountsLogin({
    loginName: 'alice',
    credential: 'credential-fixture',
  })
  await api.login('v2-token-rotated')
  const session = await api.accountsSessionState()
  await api.accountsLogout()
  await api.listMachines()

  assert.deepEqual(session, {
    account: { accountId: 'account-current', loginName: 'alice' },
  })
  assert.deepEqual(calls, [
    {
      path: '/api/auth/login',
      method: 'POST',
      authorization: undefined,
      accountsSession: undefined,
      body: { token: 'v2-token-fixture' },
    },
    {
      path: '/api/accounts/login',
      method: 'POST',
      authorization: 'Bearer v2-token-fixture',
      accountsSession: undefined,
      body: { loginName: 'alice', credential: 'credential-fixture' },
    },
    {
      path: '/api/auth/login',
      method: 'POST',
      authorization: 'Bearer v2-token-fixture',
      accountsSession: 'accounts-token-fixture',
      body: { token: 'v2-token-rotated' },
    },
    {
      path: '/api/accounts/session',
      method: 'GET',
      authorization: 'Bearer v2-token-rotated',
      accountsSession: 'accounts-token-fixture',
      body: undefined,
    },
    {
      path: '/api/accounts/logout',
      method: 'POST',
      authorization: 'Bearer v2-token-rotated',
      accountsSession: 'accounts-token-fixture',
      body: undefined,
    },
    {
      path: '/api/machines',
      method: 'GET',
      authorization: 'Bearer v2-token-rotated',
      accountsSession: undefined,
      body: undefined,
    },
  ])
})

test('machine and terminal requests carry the independent accounts session header', async () => {
  const calls = []
  const machineId = 'machine-remote'
  const workspaceId = 'ws-one'
  const memberId = 'member-one'
  const admission = {
    workspaceId,
    memberId,
    machineId,
    groupPath: 'team/remote',
    expectedGeneration: 4,
    backend: 'tmux',
    stableId: 'tmux:v1:remote',
  }
  const api = createDaemonApi({
    baseUrl: 'http://daemon.test',
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(String(url), 'http://daemon.test')
      calls.push({
        path: parsed.pathname,
        method: options.method || 'GET',
        authorization: options.headers?.authorization,
        accountsSession: options.headers?.['x-zterm-accounts-session'],
      })
      if (parsed.pathname === '/api/auth/login') {
        return jsonResponse(200, { ok: true, csrfToken: 'csrf-fixture' })
      }
      if (parsed.pathname === '/api/accounts/login') {
        return jsonResponse(200, {
          token: 'accounts-token-fixture',
          account: { accountId: 'account-current', loginName: 'alice' },
        })
      }
      if (parsed.pathname === '/api/machines') {
        return jsonResponse(200, { machines: [], observation: null })
      }
      if (parsed.pathname === `/api/machines/${machineId}/connect`) {
        return jsonResponse(200, {
          connection: {
            machineId,
            generation: 1,
            path: 'direct',
            status: 'connected',
            freshness: 'fresh',
            peerIdentityVerified: true,
          },
          observation: {
            source: 'connections',
            observedAt: '2026-11-11T00:00:00.000Z',
            value: { machineId, generation: 1, status: 'connected', freshness: 'fresh' },
          },
        })
      }
      if (parsed.pathname === `/api/workspaces/${workspaceId}/members/${memberId}/runtime`) {
        return jsonResponse(200, {
          member: {
            memberId,
            workspaceId,
            groupPath: admission.groupPath,
          },
          runtime: { machineId },
          binding: {
            machineId,
            generation: admission.expectedGeneration,
            terminalTarget: {
              backend: admission.backend,
              stableId: admission.stableId,
            },
          },
        })
      }
      if (parsed.pathname === '/api/terminal/stream') {
        return streamResponse()
      }
      if (parsed.pathname === '/api/terminal/input') {
        return jsonResponse(200, { ok: true })
      }
      throw new Error(`unexpected path ${parsed.pathname}`)
    },
  })

  await api.login('v2-token-fixture')
  await api.accountsLogin({
    loginName: 'alice',
    credential: 'credential-fixture',
  })
  await api.listMachines()
  await api.connectMachine({ machineId })
  const resolved = await api.resolveTerminalAdmission(admission)
  const source = api.openTerminalStream(resolved)
  await api.sendInput(resolved, 'pwd\n')
  source.close()

  assert.deepEqual(resolved, admission)
  const authenticatedPaths = [
    '/api/machines',
    `/api/machines/${machineId}/connect`,
    `/api/workspaces/${workspaceId}/members/${memberId}/runtime`,
    '/api/terminal/stream',
    '/api/terminal/input',
  ]
  for (const path of authenticatedPaths) {
    const call = calls.find((candidate) => candidate.path === path)
    assert.ok(call, `${path} must be requested`)
    assert.equal(call.authorization, 'Bearer v2-token-fixture')
    assert.equal(call.accountsSession, 'accounts-token-fixture')
  }
})

test('accounts login failure preserves the backend typed code', async () => {
  const api = createDaemonApi({
    baseUrl: 'http://daemon.test',
    fetchImpl: async () => jsonResponse(401, {
      error: {
        code: 'INVALID_CREDENTIALS',
        owningModule: 'accounts',
        message: 'The login name or credential is invalid.',
      },
    }),
  })

  await assert.rejects(
    api.accountsLogin({ loginName: 'alice', credential: 'wrong-credential' }),
    (error) => {
      assert.equal(error.code, 'INVALID_CREDENTIALS')
      assert.equal(error.owningModule, 'accounts')
      assert.equal(error.status, 401)
      return true
    },
  )
})
