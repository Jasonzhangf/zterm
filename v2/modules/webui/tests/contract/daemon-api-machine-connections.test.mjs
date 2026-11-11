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

function connected(machineId, generation = 1) {
  return {
    machineId,
    generation,
    path: 'direct',
    status: 'connected',
    freshness: 'fresh',
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
  }
}

function observation(machineId, generation = 1) {
  return {
    source: 'connections',
    observedAt: '2026-11-11T00:00:00.000Z',
    value: {
      machineId,
      generation,
      status: 'connected',
      freshness: 'fresh',
    },
  }
}

test('machine connection client uses exact encoded routes, methods, and bearer auth', async () => {
  const calls = []
  const machineId = 'machine/one 2'
  const encodedMachineId = 'machine%2Fone%202'

  const api = createDaemonApi({
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(String(url), 'http://daemon.test')
      calls.push({
        path: parsed.pathname,
        method: options.method || 'GET',
        authorization: options.headers?.authorization,
      })

      if (parsed.pathname === '/api/auth/login') {
        return jsonResponse(200, { ok: true, csrfToken: 'csrf-1' })
      }
      if (parsed.pathname === '/api/machines') {
        return jsonResponse(200, {
          machines: [{ machineId, displayName: 'Remote Mac', status: 'active' }],
          observation: { source: 'accounts', observedAt: '2026-11-11T00:00:00.000Z', value: { machines: 1 } },
        })
      }
      if (parsed.pathname === `/api/machines/${encodedMachineId}/connect`) {
        return jsonResponse(200, { connection: connected(machineId), observation: observation(machineId) })
      }
      if (parsed.pathname === `/api/machines/${encodedMachineId}/connection`) {
        return jsonResponse(200, {
          connection: connected(machineId),
          status: 'connected',
          observation: observation(machineId),
        })
      }
      if (parsed.pathname === `/api/machines/${encodedMachineId}/recover`) {
        return jsonResponse(200, { connection: connected(machineId, 2), observation: observation(machineId, 2) })
      }
      if (parsed.pathname === `/api/machines/${encodedMachineId}/disconnect`) {
        return jsonResponse(200, {
          disconnected: true,
          machineId,
          connection: null,
          status: 'unavailable',
          observation: {
            source: 'connections',
            observedAt: '2026-11-11T00:00:00.000Z',
            value: { machineId, status: 'unavailable', freshness: 'unavailable' },
          },
        })
      }
      if (parsed.pathname === `/api/machines/${encodedMachineId}/sessions`) {
        return jsonResponse(200, {
          sessions: [{ name: 'remote-shell', backend: 'tmux', stableId: 'tmux:v1:remote' }],
          observation: { source: 'connections', observedAt: '2026-11-11T00:00:00.000Z', value: { machineId, generation: 1, sessions: 1 } },
        })
      }
      throw new Error(`unexpected path ${parsed.pathname}`)
    },
  })

  await api.login('test-token')
  const directory = await api.listMachines()
  const connect = await api.connectMachine({ machineId })
  const current = await api.getMachineConnection({ machineId })
  const recover = await api.recoverMachine({ machineId })
  const disconnected = await api.disconnectMachine({ machineId })
  const sessions = await api.listMachineSessions({ machineId })

  assert.equal(directory.machines[0].machineId, machineId)
  assert.equal(connect.connection.machineId, machineId)
  assert.equal(current.connection.machineId, machineId)
  assert.equal(recover.connection.generation, 2)
  assert.equal(disconnected.disconnected, true)
  assert.equal(sessions.sessions[0].stableId, 'tmux:v1:remote')
  assert.deepEqual(
    calls.map((call) => [call.method, call.path]),
    [
      ['POST', '/api/auth/login'],
      ['GET', '/api/machines'],
      ['POST', `/api/machines/${encodedMachineId}/connect`],
      ['GET', `/api/machines/${encodedMachineId}/connection`],
      ['POST', `/api/machines/${encodedMachineId}/recover`],
      ['POST', `/api/machines/${encodedMachineId}/disconnect`],
      ['GET', `/api/machines/${encodedMachineId}/sessions`],
    ],
  )
  assert.equal(calls[0].authorization, undefined)
  for (const call of calls.slice(1)) {
    assert.equal(call.authorization, 'Bearer test-token')
  }
})

test('machine connection client rejects malformed responses with typed errors', async () => {
  const responses = new Map([
    ['/api/machines', { machines: null }],
    ['/api/machines/machine-a/connect', { connection: { machineId: 'machine-b' }, observation: observation('machine-b') }],
    ['/api/machines/machine-a/connection', { connection: 'not-an-object' }],
    ['/api/machines/machine-a/recover', { connection: { machineId: 'machine-b' }, observation: observation('machine-b') }],
    ['/api/machines/machine-a/disconnect', { disconnected: true, machineId: 'machine-b' }],
    ['/api/machines/machine-a/sessions', { sessions: null }],
  ])
  const api = createDaemonApi({
    fetchImpl: async (url) => {
      const parsed = new URL(String(url), 'http://daemon.test')
      return jsonResponse(200, responses.get(parsed.pathname))
    },
  })

  await assert.rejects(api.listMachines(), (error) => {
    assert.equal(error.code, 'MACHINES_RESPONSE_INVALID')
    return true
  })
  await assert.rejects(api.connectMachine({ machineId: 'machine-a' }), (error) => {
    assert.equal(error.code, 'MACHINE_CONNECTION_RESPONSE_INVALID')
    return true
  })
  await assert.rejects(api.getMachineConnection({ machineId: 'machine-a' }), (error) => {
    assert.equal(error.code, 'MACHINE_CONNECTION_RESPONSE_INVALID')
    return true
  })
  await assert.rejects(api.recoverMachine({ machineId: 'machine-a' }), (error) => {
    assert.equal(error.code, 'MACHINE_CONNECTION_RESPONSE_INVALID')
    return true
  })
  await assert.rejects(api.disconnectMachine({ machineId: 'machine-a' }), (error) => {
    assert.equal(error.code, 'MACHINE_DISCONNECT_RESPONSE_INVALID')
    return true
  })
  await assert.rejects(api.listMachineSessions({ machineId: 'machine-a' }), (error) => {
    assert.equal(error.code, 'MACHINE_SESSIONS_RESPONSE_INVALID')
    return true
  })
})
