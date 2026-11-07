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

test('pane client suspend closes the body stream and resume reopens a fresh stream', async () => {
  const client = createClient({ attachTimeoutMs: 1000 })
  const handle = await client.attachSession(createMember('m-suspend'))
  const first = openEventSource()
  first.emit('ready', {})

  assert.equal(handle.isBodyActive(), true)
  assert.equal(first.closeCalls, 0)

  await client.suspend(handle)
  assert.equal(handle.isBodyActive(), false)
  assert.equal(first.closeCalls, 1)
  assert.equal(FakeEventSource.instances.length, 1)

  await client.resume(handle)
  assert.equal(handle.isBodyActive(), true)
  assert.equal(FakeEventSource.instances.length, 2)
  const second = FakeEventSource.instances[1]
  assert.notStrictEqual(second, first)
  second.emit('ready', {})
  assert.equal(handle.getSnapshot().status, 'attached')
})

test('pane client retry after a stream error opens one fresh stream and ignores late callbacks', async () => {
  const client = createClient({ attachTimeoutMs: 1000 })
  const handle = await client.attachSession(createMember('m-error-retry'))
  const first = FakeEventSource.instances[0]
  first.emit('ready', {})
  first.emit('error', { error: { code: 'TERMINAL_STREAM_FAILED', message: 'Terminal stream failed.' } })
  assert.equal(handle.getSnapshot().status, 'unavailable')
  assert.equal(FakeEventSource.instances.length, 1)

  const retry = client.attachSession(createMember('m-error-retry'))
  assert.equal(FakeEventSource.instances.length, 2)
  const second = FakeEventSource.instances[1]
  second.emit('ready', {})
  assert.strictEqual(await retry, handle)
  assert.equal(handle.getSnapshot().status, 'attached')

  second.emit('error', { error: { code: 'TERMINAL_STREAM_FAILED', message: 'Terminal stream failed again.' } })
  assert.equal(handle.getSnapshot().status, 'unavailable')
  assert.equal(FakeEventSource.instances.length, 2)

  await client.resume(handle)
  assert.equal(FakeEventSource.instances.length, 3)
  const third = FakeEventSource.instances[2]
  third.emit('buffer', { ansi: 'fresh-frame', frame: { cols: 100, rows: 30 } })
  assert.equal(handle.getSnapshot().status, 'attached')
  assert.equal(handle.getSnapshot().deliveredFrameCount, 1)

  first.emit('ready', {})
  first.emit('buffer', { ansi: 'stale-first', frame: { cols: 100, rows: 30 } })
  second.emit('ready', {})
  second.emit('buffer', { ansi: 'stale-second', frame: { cols: 100, rows: 30 } })
  assert.equal(handle.getSnapshot().status, 'attached')
  assert.equal(handle.getSnapshot().deliveredFrameCount, 1)
})

test('pane client ignores late callbacks from a suspended stream generation', async () => {
  const client = createClient({ attachTimeoutMs: 1000 })
  const handle = await client.attachSession(createMember('m-late-suspend'))
  const first = openEventSource()
  first.emit('ready', {})
  const frames = []
  handle.subscribe((frame) => frames.push(frame))

  await client.suspend(handle)
  assert.equal(handle.getSnapshot().subscriptionState, 'suspended')

  first.emit('ready', {})
  first.emit('buffer', { ansi: 'stale-frame', frame: { cols: 100, rows: 30 } })
  assert.equal(handle.getSnapshot().subscriptionState, 'suspended')
  assert.equal(handle.getSnapshot().deliveredFrameCount, 0)
  assert.equal(frames.length, 0)

  await client.resume(handle)
  assert.equal(FakeEventSource.instances.length, 2)
  const second = FakeEventSource.instances[1]
  second.emit('buffer', { ansi: 'fresh-frame', frame: { cols: 80, rows: 24 } })

  assert.equal(handle.getSnapshot().subscriptionState, 'active')
  assert.equal(handle.getSnapshot().deliveredFrameCount, 1)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].ansi, 'fresh-frame')
})
