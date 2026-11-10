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

function createScopedRuntime(overrides = {}) {
  return {
    member: {
      memberId: 'm-scoped',
      workspaceId: 'ws-scoped',
      groupId: 'g-scoped',
      groupPath: '/acme/team',
      name: 'Scoped Member',
      managerMemberId: null,
      ...overrides.member,
    },
    runtime: {
      memberId: 'm-scoped',
      machineId: 'machine-scoped',
      hostKind: 'tmux',
      agentKind: 'codex',
      ...overrides.runtime,
    },
    binding: {
      machineId: 'machine-scoped',
      sessionId: 'session-scoped',
      generation: 4,
      terminalTarget: {
        backend: 'tmux',
        stableId: 'tmux:v1:scoped',
      },
      ...overrides.binding,
    },
    availability: {
      status: 'bound',
      observedAt: '2026-11-10T17:00:00.000Z',
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

test('terminal admission reads one scoped member runtime and preserves its identity', async () => {
  const calls = []
  const api = createDaemonApi({
    fetchImpl: async (url) => {
      const parsed = new URL(String(url), 'http://daemon.test')
      calls.push(parsed.pathname)
      if (parsed.pathname === '/api/workspaces/ws-scoped/members/m-scoped/runtime') {
        return jsonResponse(200, createScopedRuntime())
      }
      return jsonResponse(405, { error: { code: 'METHOD_NOT_ALLOWED' } })
    },
  })

  const admission = await api.resolveTerminalAdmission({
    workspaceId: 'ws-scoped',
    memberId: 'm-scoped',
    groupPath: '/acme/team',
    binding: { terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:scoped' } },
  })

  assert.deepEqual(admission, {
    workspaceId: 'ws-scoped',
    memberId: 'm-scoped',
    machineId: 'machine-scoped',
    groupPath: '/acme/team',
    expectedGeneration: 4,
    backend: 'tmux',
    stableId: 'tmux:v1:scoped',
  })
  assert.deepEqual(calls, ['/api/workspaces/ws-scoped/members/m-scoped/runtime'])
})

test('terminal admission fails closed when the runtime member omits or mismatches group path', async () => {
  const runtimes = [
    createScopedRuntime({ member: { groupPath: undefined } }),
    createScopedRuntime({ member: { groupPath: '/other/team' } }),
  ]

  let runtimeIndex = 0
  const api = createDaemonApi({
    fetchImpl: async (url) => {
      const parsed = new URL(String(url), 'http://daemon.test')
      if (parsed.pathname === '/api/workspaces/ws-scoped/members/m-scoped/runtime') {
        return jsonResponse(200, runtimes[runtimeIndex++])
      }
      return jsonResponse(405, { error: { code: 'METHOD_NOT_ALLOWED' } })
    },
  })

  for (let index = 0; index < 2; index += 1) {
    const admission = await api.resolveTerminalAdmission({
      workspaceId: 'ws-scoped',
      memberId: 'm-scoped',
      groupPath: '/acme/team',
      binding: { terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:scoped' } },
    })

    assert.equal(admission, null)
  }
})

test('terminal admission never resolves a shared stable id through another workspace', async () => {
  const calls = []
  const api = createDaemonApi({
    fetchImpl: async (url) => {
      const parsed = new URL(String(url), 'http://daemon.test')
      calls.push(parsed.pathname)
      if (parsed.pathname === '/api/workspaces') {
        return jsonResponse(200, {
          workspaces: [
            { workspaceId: 'ws-other' },
            { workspaceId: 'ws-scoped' },
          ],
        })
      }
      if (parsed.pathname === '/api/workspaces/ws-other/tree') {
        return jsonResponse(200, {
          workspace: { workspaceId: 'ws-other' },
          root: {
            path: '/other',
            members: [{
              memberId: 'm-other',
              workspaceId: 'ws-other',
              groupId: 'g-other',
              name: 'Other Member',
            }],
            children: [],
          },
        })
      }
      if (parsed.pathname === '/api/workspaces/ws-other/members/m-other/runtime') {
        return jsonResponse(200, createScopedRuntime({
          member: {
            memberId: 'm-other',
            workspaceId: 'ws-other',
            groupId: 'g-other',
            groupPath: '/other',
            name: 'Other Member',
          },
          runtime: { memberId: 'm-other', machineId: 'machine-other' },
          binding: {
            machineId: 'machine-other',
            terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:scoped' },
          },
        }))
      }
      if (parsed.pathname === '/api/workspaces/ws-scoped/members/m-scoped/runtime') {
        return jsonResponse(200, createScopedRuntime())
      }
      return jsonResponse(405, { error: { code: 'METHOD_NOT_ALLOWED' } })
    },
  })

  const admission = await api.resolveTerminalAdmission({
    workspaceId: 'ws-scoped',
    memberId: 'm-scoped',
    binding: { terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:scoped' } },
  })

  assert.equal(admission.workspaceId, 'ws-scoped')
  assert.equal(admission.memberId, 'm-scoped')
  assert.deepEqual(calls, ['/api/workspaces/ws-scoped/members/m-scoped/runtime'])
})

test('terminal admission rejects a member runtime outside the requested identity', async () => {
  const cases = [
    { member: { memberId: 'm-other' } },
    { member: { memberId: undefined } },
    { member: { workspaceId: 'ws-other' } },
  ]

  for (const overrides of cases) {
    const api = createDaemonApi({
      fetchImpl: async (url) => {
        const parsed = new URL(String(url), 'http://daemon.test')
        if (parsed.pathname === '/api/workspaces/ws-scoped/members/m-scoped/runtime') {
          return jsonResponse(200, createScopedRuntime(overrides))
        }
        return jsonResponse(405, { error: { code: 'METHOD_NOT_ALLOWED' } })
      },
    })

    await assert.rejects(
      api.resolveTerminalAdmission({
        workspaceId: 'ws-scoped',
        memberId: 'm-scoped',
        binding: { terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:scoped' } },
      }),
      (error) => {
        assert.equal(error.code, 'WORKSPACE_SCOPE_MISMATCH')
        return true
      },
    )
  }
})

test('terminal admission fails closed on a requested terminal target mismatch', async () => {
  const runtimes = [
    createScopedRuntime(),
    createScopedRuntime({ binding: { terminalTarget: null } }),
  ]
  const sessions = [
    { binding: { terminalTarget: { backend: 'wterm', stableId: 'tmux:v1:scoped' } } },
    { binding: { terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:different' } } },
  ]

  for (const runtime of runtimes) {
    for (const session of sessions) {
      const calls = []
      const api = createDaemonApi({
        fetchImpl: async (url) => {
          const parsed = new URL(String(url), 'http://daemon.test')
          calls.push(parsed.pathname)
          if (parsed.pathname === '/api/workspaces/ws-scoped/members/m-scoped/runtime') {
            return jsonResponse(200, runtime)
          }
          return jsonResponse(405, { error: { code: 'METHOD_NOT_ALLOWED' } })
        },
      })

      const admission = await api.resolveTerminalAdmission({
        workspaceId: 'ws-scoped',
        memberId: 'm-scoped',
        ...session,
      })

      assert.equal(admission, null)
      assert.deepEqual(calls, ['/api/workspaces/ws-scoped/members/m-scoped/runtime'])
    }
  }
})

test('terminal admission fails closed when runtime and binding machines differ', async () => {
  const api = createDaemonApi({
    fetchImpl: async (url) => {
      const parsed = new URL(String(url), 'http://daemon.test')
      if (parsed.pathname === '/api/workspaces/ws-scoped/members/m-scoped/runtime') {
        return jsonResponse(200, createScopedRuntime({
          binding: { machineId: 'machine-other' },
        }))
      }
      return jsonResponse(405, { error: { code: 'METHOD_NOT_ALLOWED' } })
    },
  })

  assert.equal(await api.resolveTerminalAdmission({
    workspaceId: 'ws-scoped',
    memberId: 'm-scoped',
    binding: { terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:scoped' } },
  }), null)
})

test('terminal admission fails closed before runtime reads when the requested target identity is incomplete', async () => {
  const sessions = [
    { workspaceId: 'ws-scoped', memberId: 'm-scoped', stableId: 'tmux:v1:scoped' },
    { workspaceId: 'ws-scoped', memberId: 'm-scoped', backend: 'tmux' },
    {
      workspaceId: 'ws-scoped',
      memberId: 'm-scoped',
      binding: { terminalTarget: { backend: 'tmux' } },
    },
  ]

  for (const session of sessions) {
    const calls = []
    const api = createDaemonApi({
      fetchImpl: async (url) => {
        const parsed = new URL(String(url), 'http://daemon.test')
        calls.push(parsed.pathname)
        return jsonResponse(200, createScopedRuntime())
      },
    })

    assert.equal(await api.resolveTerminalAdmission(session), null)
    assert.deepEqual(calls, [])
  }
})

test('terminal admission fails closed before runtime reads when scope ids are missing', async () => {
  const sessions = [
    {},
    { workspaceId: 'ws-scoped' },
    { memberId: 'm-scoped' },
    { workspaceId: '', memberId: 'm-scoped' },
    { workspaceId: 'ws-scoped', memberId: '' },
  ]

  for (const session of sessions) {
    const calls = []
    const api = createDaemonApi({
      fetchImpl: async (url) => {
        const parsed = new URL(String(url), 'http://daemon.test')
        calls.push(parsed.pathname)
        return jsonResponse(200, createScopedRuntime())
      },
    })

    assert.equal(await api.resolveTerminalAdmission(session), null)
    assert.deepEqual(calls, [])
  }
})
