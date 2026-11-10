import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPaneTerminalClient } from '../../src/clients/pane-terminal-client.mjs'

const ADMISSION = Object.freeze({
  workspaceId: 'ws-terminal',
  memberId: 'm-admitted',
  machineId: 'machine-terminal',
  groupPath: 'team/terminal',
  expectedGeneration: 7,
  backend: 'tmux',
  stableId: 'tmux:v1:admitted',
})

class FakeTerminalStream {
  static instances = []

  constructor({ onReady, onBuffer, onError } = {}) {
    this.handlers = { onReady, onBuffer, onError }
    this.closeCalls = 0
    FakeTerminalStream.instances.push(this)
  }

  emit(type, data) {
    const handler = this.handlers[`on${type[0].toUpperCase()}${type.slice(1)}`]
    handler?.(data)
    if (type === 'error') {
      this.close()
    }
  }

  close() {
    this.closeCalls += 1
  }

  static reset() {
    FakeTerminalStream.instances.length = 0
  }
}

function createMember(memberId) {
  return {
    memberId,
    name: `Member ${memberId}`,
    sessionId: `session-${memberId}`,
    stableId: ADMISSION.stableId,
  }
}

function createClient({ attachTimeoutMs = 5 } = {}) {
  FakeTerminalStream.reset()
  return createPaneTerminalClient({
    api: {
      resolveTerminalAdmission: async () => ({ ...ADMISSION }),
      openTerminalStream: (_admission, handlers) => new FakeTerminalStream(handlers),
      sendInput: async () => ({ accepted: true }),
    },
    attachTimeoutMs,
  })
}

function openStream() {
  const [source] = FakeTerminalStream.instances
  assert.ok(source, 'expected the pane client to open exactly one terminal stream')
  return source
}

async function waitForStream() {
  const deadline = Date.now() + 1000
  while (FakeTerminalStream.instances.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  return openStream()
}

test('pane client timeout keeps a recoverable pending stream', async () => {
  const client = createClient()
  const handle = await client.attachSession(createMember('m-timeout'))
  const source = openStream()

  assert.equal(handle.getSnapshot().status, 'starting')
  assert.equal(handle.getSnapshot().deliveredFrameCount, 0)
  assert.equal(handle.lastError, null)
  assert.equal(source.closeCalls, 0)

  source.emit('ready', {})
  assert.equal(handle.getSnapshot().status, 'attached')
  assert.equal(source.closeCalls, 0)
})

test('pane client accepts a real first frame after the timeout without opening a second stream', async () => {
  const client = createClient()
  const handle = await client.attachSession(createMember('m-frame'))
  const source = openStream()

  assert.equal(handle.getSnapshot().status, 'starting')
  source.emit('buffer', { ansi: 'late-frame', frame: { cols: 100, rows: 30 } })

  assert.equal(handle.getSnapshot().status, 'attached')
  assert.equal(handle.getSnapshot().deliveredFrameCount, 1)
  assert.equal(FakeTerminalStream.instances.length, 1)
  assert.equal(source.closeCalls, 0)
})

test('pane client projects a real stream error after ready and does not resurrect the handle', async () => {
  const client = createClient({ attachTimeoutMs: 1000 })
  const pendingAttach = client.attachSession(createMember('m-error'))
  const handle = client.getHandle('m-error')
  const source = await waitForStream()

  source.emit('ready', {})
  assert.strictEqual(await pendingAttach, handle)
  assert.equal(handle.getSnapshot().status, 'attached')

  source.emit('error', { code: 'TERMINAL_STREAM_FAILED', message: 'Terminal stream failed.' })
  assert.equal(handle.getSnapshot().status, 'unavailable')
  assert.equal(handle.lastError.code, 'TERMINAL_STREAM_FAILED')
  assert.equal(source.closeCalls, 1)

  source.emit('ready', {})
  source.emit('buffer', { ansi: 'after-error', frame: { cols: 80, rows: 24 } })
  assert.equal(handle.getSnapshot().status, 'unavailable')
  assert.equal(handle.getSnapshot().deliveredFrameCount, 0)
  assert.equal(source.closeCalls, 1)
})

test('pane client publishes status changes for the shell projection', async () => {
  const client = createClient({ attachTimeoutMs: 1000 })
  const statuses = []
  const unsubscribe = client.subscribeStatus((event) => statuses.push(event))
  assert.equal(typeof unsubscribe, 'function')

  const pendingAttach = client.attachSession(createMember('m-status'))
  const handle = client.getHandle('m-status')
  const source = await waitForStream()

  source.emit('ready', {})
  assert.strictEqual(await pendingAttach, handle)
  source.emit('error', { code: 'TERMINAL_STREAM_EOF', message: 'Terminal stream ended unexpectedly.' })

  assert.deepEqual(
    statuses.map(({ memberId, status }) => ({ memberId, status })),
    [
      { memberId: 'm-status', status: 'attached' },
      { memberId: 'm-status', status: 'unavailable' },
    ],
  )
  assert.equal(statuses.at(-1).error.code, 'TERMINAL_STREAM_EOF')
  unsubscribe()
})

test('pane client resolves admission before opening and retains it for input', async () => {
  const calls = {
    resolve: [],
    open: [],
    input: [],
  }
  const client = createPaneTerminalClient({
    api: {
      async resolveTerminalAdmission(member) {
        calls.resolve.push(member)
        return { ...ADMISSION }
      },
      openTerminalStream(admission, handlers) {
        calls.open.push(admission)
        const source = new FakeTerminalStream(handlers)
        handlers.onReady()
        return source
      },
      async sendInput(admission, data, options) {
        calls.input.push({ admission, data, options })
        return { accepted: true }
      },
    },
    attachTimeoutMs: 1000,
  })
  const member = createMember('m-admitted')
  const handle = await client.attachSession(member)

  assert.deepEqual(calls.resolve, [member])
  assert.deepEqual(calls.open, [ADMISSION])
  assert.equal(handle.getSnapshot().status, 'attached')

  await client.writeInput(handle, 'pwd\n')
  assert.deepEqual(calls.input, [{
    admission: ADMISSION,
    data: 'pwd\n',
    options: { raw: true },
  }])
})

test('pane client fails closed when terminal admission is null', async () => {
  let openCalls = 0
  let inputCalls = 0
  const client = createPaneTerminalClient({
    api: {
      resolveTerminalAdmission: async () => null,
      openTerminalStream() {
        openCalls += 1
      },
      async sendInput() {
        inputCalls += 1
        return { accepted: true }
      },
    },
  })
  const handle = await client.attachSession(createMember('m-unresolved'))

  assert.equal(handle.getSnapshot().status, 'unavailable')
  assert.equal(handle.lastError.code, 'TERMINAL_ADMISSION_UNRESOLVED')
  assert.equal(openCalls, 0)
  assert.equal(inputCalls, 0)
})

test('pane client fails closed when terminal admission resolution throws', async () => {
  let openCalls = 0
  let inputCalls = 0
  const client = createPaneTerminalClient({
    api: {
      async resolveTerminalAdmission() {
        throw Object.assign(new Error('control plane rejected admission'), { code: 'AUTH_FORBIDDEN' })
      },
      openTerminalStream() {
        openCalls += 1
      },
      async sendInput() {
        inputCalls += 1
        return { accepted: true }
      },
    },
  })
  const handle = await client.attachSession(createMember('m-admission-error'))

  assert.equal(handle.getSnapshot().status, 'unavailable')
  assert.equal(handle.lastError.code, 'TERMINAL_ADMISSION_UNRESOLVED')
  assert.equal(openCalls, 0)
  assert.equal(inputCalls, 0)
})
