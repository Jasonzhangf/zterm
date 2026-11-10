import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDaemonApi } from '../../src/clients/daemon-api/index.mjs'

const ADMISSION = Object.freeze({
  workspaceId: 'ws-stream',
  memberId: 'm-stream',
  machineId: 'machine-stream',
  groupPath: 'team/stream',
  expectedGeneration: 3,
  backend: 'tmux',
  stableId: 'tmux:v1:stream',
})

const encoder = new TextEncoder()

function responseFor(chunks) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
  return {
    ok: true,
    status: 200,
    body,
    json: async () => ({}),
  }
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    body: null,
    json: async () => payload,
  };
}

test('daemon API reads workspace and members from the supported tree route', async () => {
  const requested = []
  const tree = {
    workspace: { workspaceId: 'ws-tree', name: 'Tree workspace' },
    root: {
      path: 'team',
      members: [{ memberId: 'm-tree', name: 'Tree member' }],
      children: [],
    },
  }
  const api = createDaemonApi({
    baseUrl: 'http://daemon.test',
    fetchImpl: async (url) => {
      requested.push(new URL(url).pathname)
      return jsonResponse(tree)
    },
  })

  assert.deepEqual(await api.getWorkspace({ workspaceId: 'ws-tree' }), tree.workspace)
  assert.deepEqual(await api.listWorkspaceMembers({ workspaceId: 'ws-tree' }), [{
    memberId: 'm-tree',
    name: 'Tree member',
    groupPath: 'team',
  }])
  assert.deepEqual(requested, [
    '/api/workspaces/ws-tree/tree',
    '/api/workspaces/ws-tree/tree',
  ])
})

test('daemon API reports a typed error when the terminal stream ends after ready', async () => {
  let readyCalls = 0
  let error = null
  const api = createDaemonApi({
    baseUrl: 'http://daemon.test',
    fetchImpl: async () => responseFor([
      'event: ready\ndata: {"ok":true}\n\n',
    ]),
  })
  const source = api.openTerminalStream(ADMISSION, {
    onReady() {
      readyCalls += 1
    },
    onError(nextError) {
      error = nextError
    },
  })

  const deadline = Date.now() + 1000
  while (!error && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  assert.equal(readyCalls, 1)
  assert.equal(error.code, 'TERMINAL_STREAM_EOF')
  assert.equal(source.closed, true)
})

test('daemon API keeps explicit terminal stream close silent', async () => {
  let error = null
  const api = createDaemonApi({
    baseUrl: 'http://daemon.test',
    fetchImpl: async () => responseFor([]),
  })
  const source = api.openTerminalStream(ADMISSION, {
    onError(nextError) {
      error = nextError
    },
  })

  source.close()
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(error, null)
  assert.equal(source.closed, true)
})
