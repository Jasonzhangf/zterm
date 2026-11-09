import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createPaneTerminalClient } from '../../src/clients/pane-terminal-client.mjs'
import { createDaemonApi } from '../../src/clients/daemon-api/index.mjs'

class FakeEventSource {
  static instances = []

  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.closeCalls = 0
    FakeEventSource.instances.push(this)
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close() {
    this.closeCalls += 1
  }

  emit(type, data) {
    const event = data === undefined ? {} : { data: JSON.stringify(data) }
    for (const listener of this.listeners.get(type) || []) {
      listener(event)
    }
  }

  static reset() {
    FakeEventSource.instances.length = 0
  }
}

const realEventSource = globalThis.EventSource

before(() => {
  globalThis.EventSource = FakeEventSource
})

after(() => {
  if (realEventSource === undefined) {
    delete globalThis.EventSource
  } else {
    globalThis.EventSource = realEventSource
  }
})

function createMember(memberId) {
  return {
    memberId,
    name: `Member ${memberId}`,
    sessionId: `session-${memberId}`,
  }
}

function createClient({ attachTimeoutMs = 5 } = {}) {
  FakeEventSource.reset()
  return createPaneTerminalClient({
    api: createDaemonApi({ baseUrl: '' }),
    attachTimeoutMs,
  })
}

function openEventSource() {
  const [source] = FakeEventSource.instances
  assert.ok(source, 'expected the pane client to open exactly one EventSource')
  return source
}

test('pane client timeout keeps a recoverable pending stream', async () => {
  const client = createClient()
  const handle = await client.attachSession(createMember('m-timeout'))
  const source = openEventSource()

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
  const source = openEventSource()

  assert.equal(handle.getSnapshot().status, 'starting')
  source.emit('buffer', { ansi: 'late-frame', frame: { cols: 100, rows: 30 } })

  assert.equal(handle.getSnapshot().status, 'attached')
  assert.equal(handle.getSnapshot().deliveredFrameCount, 1)
  assert.equal(FakeEventSource.instances.length, 1)
  assert.equal(source.closeCalls, 0)
})

test('pane client projects a real stream error after ready and does not resurrect the handle', async () => {
  const client = createClient({ attachTimeoutMs: 1000 })
  const pendingAttach = client.attachSession(createMember('m-error'))
  const handle = client.getHandle('m-error')
  const source = openEventSource()

  source.emit('ready', {})
  assert.strictEqual(await pendingAttach, handle)
  assert.equal(handle.getSnapshot().status, 'attached')

  source.emit('error', { error: { code: 'TERMINAL_STREAM_FAILED', message: 'Terminal stream failed.' } })
  assert.equal(handle.getSnapshot().status, 'unavailable')
  assert.equal(handle.lastError.code, 'TERMINAL_STREAM_FAILED')
  assert.equal(source.closeCalls, 1)

  source.emit('ready', {})
  source.emit('buffer', { ansi: 'after-error', frame: { cols: 80, rows: 24 } })
  assert.equal(handle.getSnapshot().status, 'unavailable')
  assert.equal(handle.getSnapshot().deliveredFrameCount, 0)
  assert.equal(source.closeCalls, 1)
})
