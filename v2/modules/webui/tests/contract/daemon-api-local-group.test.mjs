import assert from 'node:assert/strict'
import test from 'node:test'
import { createDaemonApi, DaemonError } from '../../src/clients/daemon-api/index.mjs'

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function createRecorder() {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url), 'http://daemon.test')
    calls.push({
      path: parsed.pathname,
      method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : null,
    })

    if (parsed.pathname === '/api/workspaces/ws-1/groups') {
      return jsonResponse(201, {
        group: {
          groupId: 'g-1',
          workspaceId: 'ws-1',
          parentGroupId: 'g-root',
          name: 'Group One',
          path: '/Group One',
          revision: 8,
        },
      })
    }
    if (parsed.pathname === '/api/workspaces/ws-1/members') {
      return jsonResponse(201, {
        member: {
          memberId: 'm-1',
          workspaceId: 'ws-1',
          groupId: 'g-1',
          name: 'Member One',
          managerMemberId: null,
          revision: 9,
        },
      })
    }
    if (parsed.pathname === '/api/workspaces/ws-1/members/m-1/runtime' && options.method === 'POST') {
      return jsonResponse(200, {
        runtime: {
          memberId: 'm-1',
          machineId: 'mac-1',
          hostKind: 'tmux',
          agentKind: 'codex',
          launchProfileRef: 'profile-1',
        },
      })
    }
    if (parsed.pathname === '/api/workspaces/ws-1/members/m-1/runtime') {
      return jsonResponse(200, {
        member: {
          memberId: 'm-1',
          workspaceId: 'ws-1',
          groupId: 'g-1',
          groupPath: '/Group One',
          name: 'Member One',
        },
        runtime: {
          memberId: 'm-1',
          machineId: 'mac-1',
          hostKind: 'tmux',
          agentKind: 'codex',
          launchProfileRef: 'profile-1',
        },
        binding: null,
        availability: { status: 'unavailable' },
        bindingGeneration: 4,
        agentCapabilities: { start: 'unsupported', resume: 'unsupported' },
      })
    }
    if (parsed.pathname === '/api/workspaces/ws-1/members/m-1/binding') {
      return jsonResponse(200, {
        binding: {
          memberId: 'm-1',
          machineId: 'mac-1',
          sessionId: 'session-1',
          anchor: 'pane:0',
          generation: 5,
          terminalTarget: null,
        },
      })
    }
    if (parsed.pathname === '/api/workspaces/ws-1/members/m-1/restore-binding') {
      return jsonResponse(200, {
        verification: {
          restored: true,
          memberId: 'm-1',
          machineId: 'mac-1',
          sessionId: 'session-1',
          anchor: 'pane:0',
          generation: 5,
          terminalTarget: null,
          observedAt: '2026-11-11T12:00:00.000Z',
        },
      })
    }
    return jsonResponse(404, {
      error: {
        code: 'NOT_FOUND',
        owningModule: 'route',
        operationId: 'route',
        message: `No route for ${parsed.pathname}`,
      },
    })
  }
  return { fetchImpl, calls }
}

test('local group API client sends exact create, configure, bind and restore requests', async () => {
  const { fetchImpl, calls } = createRecorder()
  const api = createDaemonApi({ fetchImpl })

  const group = await api.createGroup({
    workspaceId: 'ws-1',
    name: 'Group One',
    parentGroupId: 'g-root',
    expectedRevision: 7,
  })
  const member = await api.createMember({
    workspaceId: 'ws-1',
    groupId: 'g-1',
    name: 'Member One',
    expectedRevision: 8,
  })
  const runtime = await api.configureMemberRuntime({
    workspaceId: 'ws-1',
    memberId: 'm-1',
    machineId: 'mac-1',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'profile-1',
  })
  const binding = await api.bindMemberSession({
    workspaceId: 'ws-1',
    memberId: 'm-1',
    sessionId: 'session-1',
    anchor: 'pane:0',
    expectedGeneration: 4,
  })
  const verification = await api.restoreMemberBinding({
    workspaceId: 'ws-1',
    memberId: 'm-1',
    machineId: 'mac-1',
    expectedGeneration: 5,
  })

  assert.equal(group.groupId, 'g-1')
  assert.equal(member.memberId, 'm-1')
  assert.equal(runtime.machineId, 'mac-1')
  assert.equal(binding.generation, 5)
  assert.equal(verification.restored, true)
  assert.deepEqual(calls, [
    {
      path: '/api/workspaces/ws-1/groups',
      method: 'POST',
      body: { name: 'Group One', parentGroupId: 'g-root', expectedRevision: 7 },
    },
    {
      path: '/api/workspaces/ws-1/members',
      method: 'POST',
      body: { groupId: 'g-1', name: 'Member One', expectedRevision: 8 },
    },
    {
      path: '/api/workspaces/ws-1/members/m-1/runtime',
      method: 'POST',
      body: {
        machineId: 'mac-1',
        hostKind: 'tmux',
        agentKind: 'codex',
        launchProfileRef: 'profile-1',
      },
    },
    {
      path: '/api/workspaces/ws-1/members/m-1/binding',
      method: 'POST',
      body: {
        sessionId: 'session-1',
        anchor: 'pane:0',
        expectedGeneration: 4,
      },
    },
    {
      path: '/api/workspaces/ws-1/members/m-1/restore-binding',
      method: 'POST',
      body: { machineId: 'mac-1', expectedGeneration: 5 },
    },
  ])
})

test('binding API includes only an explicit terminal target assertion', async () => {
  const { fetchImpl, calls } = createRecorder()
  const api = createDaemonApi({ fetchImpl })

  await api.bindMemberSession({
    workspaceId: 'ws-1',
    memberId: 'm-1',
    sessionId: 'session-1',
    anchor: 'pane:0',
    expectedGeneration: 4,
    terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:exact' },
  })

  assert.deepEqual(calls[0].body, {
    sessionId: 'session-1',
    anchor: 'pane:0',
    expectedGeneration: 4,
    terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:exact' },
  })
})

test('runtime projection preserves retained binding generation and unsupported capabilities', async () => {
  const { fetchImpl } = createRecorder()
  const api = createDaemonApi({ fetchImpl })

  const runtime = await api.getMemberRuntime({ workspaceId: 'ws-1', memberId: 'm-1' })

  assert.equal(runtime.binding, null)
  assert.equal(runtime.bindingGeneration, 4)
  assert.deepEqual(runtime.agentCapabilities, {
    start: 'unsupported',
    resume: 'unsupported',
  })
})

test('typed daemon errors preserve conflict details and retry disposition', async () => {
  const api = createDaemonApi({
    fetchImpl: async () => jsonResponse(409, {
      error: {
        code: 'BINDING_GENERATION_STALE',
        owningModule: 'members',
        operationId: 'members.bindSession',
        message: 'binding generation 4 != expected 3',
        cause: 'expectedGeneration mismatch',
        retryDisposition: 'refresh',
        details: { currentGeneration: 4, expectedGeneration: 3 },
      },
    }),
  })

  await assert.rejects(
    api.bindMemberSession({
      workspaceId: 'ws-1',
      memberId: 'm-1',
      sessionId: 'session-1',
      anchor: 'pane:0',
      expectedGeneration: 3,
    }),
    (error) => {
      assert.ok(error instanceof DaemonError)
      assert.equal(error.code, 'BINDING_GENERATION_STALE')
      assert.equal(error.owningModule, 'members')
      assert.equal(error.operationId, 'members.bindSession')
      assert.equal(error.status, 409)
      assert.equal(error.cause, 'expectedGeneration mismatch')
      assert.equal(error.retryDisposition, 'refresh')
      assert.deepEqual(error.details, { currentGeneration: 4, expectedGeneration: 3 })
      return true
    },
  )
})
