import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPaneTerminalClient } from '../../src/clients/pane-terminal-client.mjs'

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
  }
}

function createClient({ attachTimeoutMs = 5 } = {}) {
  FakeTerminalStream.reset()
  return createPaneTerminalClient({
    api: {
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
  const source = openStream()

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
