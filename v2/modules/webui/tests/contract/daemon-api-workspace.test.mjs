import assert from 'node:assert/strict'
import test from 'node:test'
import { createDaemonApi } from '../../src/clients/daemon-api/index.mjs'
import { createSessionController } from '../../src/controllers/session-controller.mjs'

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function createTree() {
  return {
    workspace: {
      workspaceId: 'ws-1',
      name: 'Primary',
      revision: 7,
    },
    root: {
      path: '/',
      members: [
        {
          memberId: 'm-root',
          workspaceId: 'ws-1',
          groupId: 'g-root',
          name: 'Root Member',
          managerMemberId: null,
          runtime: { machineId: 'machine-1' },
          binding: { sessionId: 'session-root', generation: 2 },
          availability: { status: 'bound', observedAt: '2026-11-10T17:00:00.000Z' },
        },
      ],
      children: [
        {
          path: '/team',
          members: [
            {
              memberId: 'm-child',
              workspaceId: 'ws-1',
              groupId: 'g-team',
              name: 'Child Member',
              managerMemberId: 'm-root',
              runtime: null,
              binding: null,
              availability: { status: 'unknown', observedAt: '2026-11-10T17:00:00.000Z' },
            },
          ],
          children: [],
        },
      ],
    },
    observation: {
      source: 'isolated-contract-test',
      observedAt: '2026-11-10T17:00:00.000Z',
      unassignedTerminalTargets: [],
    },
  }
}

function createFetchRecorder() {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url), 'http://daemon.test')
    calls.push({ path: parsed.pathname, options })

    if (parsed.pathname === '/api/auth/login') {
      return jsonResponse(200, { ok: true, csrfToken: 'csrf-1' })
    }
    if (parsed.pathname === '/api/workspaces/ws-1/tree') {
      return jsonResponse(200, createTree())
    }
    return jsonResponse(405, {
      error: {
        code: 'METHOD_NOT_ALLOWED',
        owningModule: 'route',
        operationId: 'route',
        message: `HTTP method is not allowed for ${parsed.pathname}.`,
      },
    })
  }
  return { fetchImpl, calls }
}

test('workspace snapshot uses one declared tree read and preserves composed member facts', async () => {
  const { fetchImpl, calls } = createFetchRecorder()
  const api = createDaemonApi({ fetchImpl })
  await api.login('test-token')

  const snapshot = await api.getWorkspaceSnapshot({ workspaceId: 'ws-1' })

  assert.equal(snapshot.workspace.workspaceId, 'ws-1')
  assert.deepEqual(snapshot.members.map((member) => member.memberId), ['m-root', 'm-child'])
  assert.equal(snapshot.members[0].groupPath, '/')
  assert.equal(snapshot.members[1].groupPath, '/team')
  assert.deepEqual(snapshot.members[0].runtime, { machineId: 'machine-1' })
  assert.deepEqual(snapshot.members[0].binding, { sessionId: 'session-root', generation: 2 })
  assert.equal(snapshot.members[0].availability.status, 'bound')
  assert.equal(snapshot.members[1].availability.status, 'unknown')
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/auth/login', '/api/workspaces/ws-1/tree'],
  )
})

test('SessionController reaches ready through the declared tree endpoint', async () => {
  const { fetchImpl, calls } = createFetchRecorder()
  const daemonApi = createDaemonApi({ fetchImpl })
  await daemonApi.login('test-token')
  const controller = createSessionController({ daemonApi })

  await controller.loadWorkspaceSessions('ws-1')

  const loadable = controller.getWorkspaceLoadable()
  assert.equal(loadable.status, 'ready')
  assert.equal(loadable.error, null)
  assert.equal(loadable.value.workspace.workspaceId, 'ws-1')
  assert.deepEqual(loadable.value.members.map((member) => member.memberId), ['m-root', 'm-child'])
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/auth/login', '/api/workspaces/ws-1/tree'],
  )
})

test('workspace snapshot fails closed without falling back to undeclared routes', async () => {
  const calls = []
  const api = createDaemonApi({
    fetchImpl: async (url) => {
      const parsed = new URL(String(url), 'http://daemon.test')
      calls.push(parsed.pathname)
      return jsonResponse(200, {
        workspace: { workspaceId: 'ws-1' },
        root: null,
      })
    },
  })

  await assert.rejects(api.getWorkspaceSnapshot({ workspaceId: 'ws-1' }), (error) => {
    assert.equal(error.code, 'WORKSPACE_TREE_RESPONSE_INVALID')
    return true
  })
  assert.deepEqual(calls, ['/api/workspaces/ws-1/tree'])
})

test('workspace snapshot rejects omitted workspace scope ids', async () => {
  const makeFetch = (workspaceId) => async () =>
    jsonResponse(200, {
      workspace: workspaceId ? { workspaceId, name: 'Primary' } : { name: 'Primary' },
      root: {
        path: '/',
        members: [{
          memberId: 'm-root',
          groupId: 'g-root',
          name: 'Root Member',
        }],
        children: [],
      },
    })

  await assert.rejects(
    createDaemonApi({ fetchImpl: makeFetch(null) }).getWorkspaceSnapshot({ workspaceId: 'ws-1' }),
    (error) => error.code === 'WORKSPACE_SCOPE_MISMATCH',
  )
  await assert.rejects(
    createDaemonApi({ fetchImpl: makeFetch('ws-1') }).getWorkspaceSnapshot({ workspaceId: 'ws-1' }),
    (error) => error.code === 'WORKSPACE_SCOPE_MISMATCH',
  )
})
