import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPropertyController } from '../../src/controllers/property-controller.mjs'
import { createSessionController } from '../../src/controllers/session-controller.mjs'
import { createPaneTerminalClient } from '../../src/clients/pane-terminal-client.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createMember(memberId, status = 'online', extra = {}) {
  return {
    memberId,
    name: `Member ${memberId}`,
    role: 'peer',
    machine: 'peer-mac',
    status,
    freshness: status === 'online' ? 'fresh' : 'stale',
    sessionId: `session-${memberId}`,
    removedFromWorkspace: false,
    ...extra,
  }
}

test('property-controller keeps per-window property state isolated', async () => {
  const properties = new Map([
    ['m-1', { role: 'primary', description: 'one', cwd: '/a', envSummary: 'TERM=xterm', connectionRef: 'mac1', workspaceBinding: 'ws-alpha' }],
    ['m-2', { role: 'peer', description: 'two', cwd: '/b', envSummary: 'TERM=xterm', connectionRef: 'mac2', workspaceBinding: 'ws-alpha' }],
  ])
  const daemonApi = {
    async getMemberProperties({ memberId }) {
      return properties.get(memberId) || null
    },
    async updateMemberProperties({ memberId, patch }) {
      const next = { ...properties.get(memberId), ...patch }
      properties.set(memberId, next)
      return next
    },
  }
  const controller = createPropertyController({ daemonApi })

  controller.openWindowProperties('window-1', 'm-1')
  await controller.loadMemberProperties('m-1')
  const openState = controller.getWindowPropertyState('window-1', 'm-1')
  assert.equal(openState.isOpen, true)
  assert.equal(openState.propertiesLoadable.status, 'ready')
  assert.equal(openState.draft.role, 'primary')

  const saveGate = deferred()
  daemonApi.updateMemberProperties = async ({ memberId, patch }) => {
    await saveGate.promise
    const next = { ...properties.get(memberId), ...patch }
    properties.set(memberId, next)
    return next
  }
  controller.updateDraft('m-1', { description: 'updated-one' })
  const savePromise = controller.saveMemberProperties('m-1')

  // Switch to m-2 and mutate its draft while the m-1 save is in flight.
  controller.openWindowProperties('window-2', 'm-2')
  await controller.loadMemberProperties('m-2')
  controller.updateDraft('m-2', { description: 'm2-own-draft' })

  saveGate.resolve()
  await savePromise

  assert.equal(controller.getMemberState('m-1').draft.description, 'updated-one')
  assert.equal(controller.getMemberState('m-2').draft.description, 'm2-own-draft')
  assert.equal(controller.getMemberState('m-2').saving, false)
})

test('property-controller returns typed save error without leaking to another member', async () => {
  const daemonApi = {
    async getMemberProperties() {
      return { role: 'peer', description: 'x' }
    },
    async updateMemberProperties({ memberId }) {
      if (memberId === 'm-1') throw { code: 'PROPERTY_SAVE_FAILED', message: 'save boom' }
      return { role: 'peer', description: 'y' }
    },
  }
  const controller = createPropertyController({ daemonApi })
  await controller.loadMemberProperties('m-1')
  await controller.loadMemberProperties('m-2')
  const result = await controller.saveMemberProperties('m-1', { role: 'peer' })
  assert.equal(result.ok, false)
  assert.equal(result.saveError.code, 'PROPERTY_SAVE_FAILED')
  assert.equal(controller.getMemberState('m-2').saveError, null)
})

test('property-controller surfaces DAEMON_API_UNAVAILABLE when daemonApi is missing', async () => {
  const controller = createPropertyController()
  const loaded = await controller.loadMemberProperties('m-1')
  assert.equal(loaded.propertiesLoadable.status, 'unavailable')
  assert.equal(loaded.propertiesLoadable.error.code, 'DAEMON_API_UNAVAILABLE')

  controller.updateDraft('m-1', { description: 'draft-kept' })
  const saved = await controller.saveMemberProperties('m-1')
  assert.equal(saved.ok, false)
  assert.equal(saved.saveError.code, 'DAEMON_API_UNAVAILABLE')
  assert.equal(controller.getMemberState('m-1').draft.description, 'draft-kept')
})

function makeSessionDeps({ members = [createMember('m-1'), createMember('m-2'), createMember('m-3')], membersByWorkspace = null, workspaceId = 'ws-1', authError = false, deliveryFail = false, attachGateByMemberId = null, attachFailureByMemberId = null } = {}) {
  const terminalHandles = new Map()
  const attachCalls = []
  const createCalls = []
  const disconnectCalls = []
  const suspendCalls = []
  const resumeCalls = []
  const terminalClient = {
    async attachSession(member) {
      attachCalls.push(member.memberId)
      const gate = attachGateByMemberId?.get(member.memberId)
      if (gate) await gate.promise
      if (attachFailureByMemberId?.has(member.memberId)) {
        throw { code: 'TERMINAL_ATTACH_FAILED', message: `attach failed for ${member.memberId}` }
      }
      if (terminalHandles.has(member.memberId)) return terminalHandles.get(member.memberId)
      const handle = {
        handleId: `h-${member.memberId}`,
        memberId: member.memberId,
        sessionId: member.sessionId,
        status: 'attached',
        bodyActive: true,
        deliveredFrames: 0,
        disconnectCalls: 0,
        createCalls: 0,
        suspendCalls: 0,
        resumeCalls: 0,
        writeInput(data) { this.last = data; return { ok: true } },
        isBodyActive() { return this.bodyActive },
        suspend() { this.bodyActive = false; this.suspendCalls += 1 },
        resume() { this.bodyActive = true; this.resumeCalls += 1 },
        deliverFrame() { if (this.bodyActive) this.deliveredFrames += 1 },
        getSnapshot() { return this },
      }
      terminalHandles.set(member.memberId, handle)
      return handle
    },
    async createSession(member) {
      createCalls.push(member.memberId)
      return this.attachSession(member)
    },
    async writeInput(handle, data) { return handle.writeInput(data) },
    async disconnect(handle) {
      disconnectCalls.push(handle.memberId)
      handle.disconnectCalls += 1
      handle.suspend()
      terminalHandles.delete(handle.memberId)
      return { ok: true }
    },
    async suspend(handle) { suspendCalls.push(handle.memberId); handle.suspend(); return { ok: true } },
    async resume(handle) { resumeCalls.push(handle.memberId); handle.resume(); return { ok: true } },
  }
  function createLayout(requestedWorkspaceId, memberList) {
    return {
      accountId: 'acc-default',
      workspaceId: requestedWorkspaceId,
      members: memberList,
      primaryMemberId: memberList[0]?.memberId,
      peerMemberIds: memberList.slice(1).map((member) => member.memberId),
      primaryRatio: 0.42,
      peerColumnSplitRatio: 0.5,
      peerRowHeights: {},
      windowSizes: {},
      openPropertyByWindow: {},
      mobileMode: 'preview',
      focusedMemberId: memberList[0]?.memberId,
      previewViewport: { zoom: 1, panX: 0, panY: 0 },
    }
  }
  const layouts = new Map([[workspaceId, createLayout(workspaceId, members)]])
  const layoutStore = {
    async loadLayout(_accountId, requestedWorkspaceId, memberList) {
      if (!layouts.has(requestedWorkspaceId)) layouts.set(requestedWorkspaceId, createLayout(requestedWorkspaceId, memberList))
      const layout = layouts.get(requestedWorkspaceId)
      layout.members = memberList
      return layout
    },
    async saveLayout(value) { layouts.set(value.workspaceId, value); return value },
    async updateLayout(_accountId, requestedWorkspaceId, updater) {
      const layout = layouts.get(requestedWorkspaceId) || createLayout(requestedWorkspaceId, [])
      const next = updater(layout)
      layouts.set(requestedWorkspaceId, next)
      return next
    },
  }
  const deliveryClient = {
    async submitMessage(payload) {
      if (deliveryFail) throw { code: 'DELIVERY_TRANSPORT_FAILED', message: 'down' }
      return { receiptId: `r-${payload.recipientMemberId}`, state: 'queued', target: { workspaceId: payload.workspaceId, memberId: payload.recipientMemberId }, payload }
    },
    async offerFileTransfer() { return { transferId: 't-1', state: 'offered' } },
  }
  const daemonApi = {
    async getWorkspace({ workspaceId: requestedWorkspaceId = workspaceId } = {}) {
      if (authError) throw { code: 'AUTH_INVALID_TOKEN', category: 'auth', status: 401, message: 'token' }
      return { workspaceId: requestedWorkspaceId, name: `Workspace ${requestedWorkspaceId}` }
    },
    async listWorkspaceMembers({ workspaceId: requestedWorkspaceId = workspaceId } = {}) {
      if (authError) throw { code: 'AUTH_INVALID_TOKEN', category: 'auth', status: 401, message: 'token' }
      const memberList = membersByWorkspace?.get(requestedWorkspaceId) || members
      return memberList.map((member) => ({ ...member, workspaceId: requestedWorkspaceId }))
    },
  }
  return { terminalClient, terminalHandles, attachCalls, createCalls, disconnectCalls, suspendCalls, resumeCalls, layouts, layoutStore, deliveryClient, daemonApi }
}

test('session-controller reuses healthy handles across layout operations', async () => {
  const deps = makeSessionDeps({ members: [createMember('m-1'), createMember('m-2'), createMember('m-3'), createMember('m-4'), createMember('m-5'), createMember('m-6')] })
  const controller = createSessionController({ daemonApi: deps.daemonApi, terminalClient: deps.terminalClient, deliveryClient: deps.deliveryClient, layoutStore: deps.layoutStore })
  await controller.loadWorkspaceSessions('ws-1')
  assert.equal(deps.attachCalls.length, 0)
  assert.equal(controller.getState().workspaceLoadable.status, 'ready')

  await controller.attachFocusedMember('ws-1')
  assert.deepEqual(deps.attachCalls, ['m-1'])
  assert.equal(deps.createCalls.length, 0)

  await controller.applyLayoutOperation('ws-1', { kind: 'dragBorder', windowId: 'window-m-2', edge: 'e', deltaX: 24, deltaY: 0 })
  await controller.applyLayoutOperation('ws-1', { kind: 'togglePropertyDrawer', windowId: 'window-m-2', forceOpen: true })
  assert.deepEqual(deps.attachCalls, ['m-1'])

  await controller.applyLayoutOperation('ws-1', { kind: 'stepMobileFocus', direction: 'next' })
  assert.deepEqual(deps.attachCalls, ['m-1', 'm-2'])

  const before = deps.terminalHandles.get('m-2').getSnapshot().createCalls
  await controller.applyLayoutOperation('ws-1', { kind: 'panZoomPreview', deltaX: 8, deltaY: 8, zoomFactor: 1.1 })
  await controller.applyLayoutOperation('ws-1', { kind: 'promotePrimary', memberId: 'm-3' })

  assert.deepEqual(deps.attachCalls, ['m-1', 'm-2'])
  assert.equal(deps.terminalHandles.get('m-2').getSnapshot().createCalls, before)
  assert.deepEqual(deps.disconnectCalls, [])
  assert.deepEqual(deps.suspendCalls, ['m-1', 'm-1'])
  assert.equal(deps.createCalls.length, 0)
})

test('session-controller initial load keeps terminal attach focus-bound', async () => {
  const members = [
    createMember('m-1'),
    createMember('m-2'),
    createMember('m-3'),
    createMember('m-4'),
    createMember('m-5'),
    createMember('m-6'),
  ]
  const deps = makeSessionDeps({ members })
  const controller = createSessionController({
    daemonApi: deps.daemonApi,
    terminalClient: deps.terminalClient,
    deliveryClient: deps.deliveryClient,
    layoutStore: deps.layoutStore,
  })

  await controller.loadWorkspaceSessions('ws-1')

  const loadable = controller.getWorkspaceLoadable()
  assert.equal(loadable.status, 'ready')
  assert.equal(loadable.value.members.length, 6)
  assert.equal(deps.attachCalls.length, 0, 'management plane load must not attach every member')

  await controller.attachFocusedMember('ws-1')
  assert.deepEqual(deps.attachCalls, ['m-1'])
  assert.equal(controller.terminalHandlesByMemberId.size, 1)

  await controller.applyLayoutOperation('ws-1', { kind: 'enterMemberFocus', memberId: 'm-3' })
  assert.deepEqual(deps.attachCalls, ['m-1', 'm-3'])
  assert.deepEqual(deps.suspendCalls, ['m-1'])
  assert.equal(controller.terminalHandlesByMemberId.size, 2)
  assert.equal(controller.getTerminalHandle('m-1').isBodyActive(), false)
  for (const memberId of ['m-2', 'm-4', 'm-5', 'm-6']) {
    assert.equal(controller.getTerminalHandle(memberId), null, `${memberId} must stay unattached`)
  }
  assert.equal(controller.getTerminalHandle('m-3').status, 'attached')
})

test('session-controller attaches the primary and four visible peers without opening hidden members', async () => {
  const members = [
    createMember('m-1'),
    createMember('m-2'),
    createMember('m-3'),
    createMember('m-4'),
    createMember('m-5'),
    createMember('m-6'),
  ]
  const deps = makeSessionDeps({ members })
  const controller = createSessionController({
    daemonApi: deps.daemonApi,
    terminalClient: deps.terminalClient,
    deliveryClient: deps.deliveryClient,
    layoutStore: deps.layoutStore,
  })

  await controller.loadWorkspaceSessions('ws-1')
  const visibleMemberIds = ['m-1', 'm-2', 'm-3', 'm-4', 'm-5']
  const handles = await controller.attachVisibleMembers('ws-1', visibleMemberIds)

  assert.deepEqual(deps.attachCalls, visibleMemberIds)
  assert.equal(handles.length, 5)
  assert.equal(new Set(handles.map((handle) => handle.handleId)).size, 5)
  for (const memberId of visibleMemberIds) {
    assert.equal(controller.getTerminalHandle(memberId).isBodyActive(), true)
  }
  assert.equal(controller.getTerminalHandle('m-6'), null)
})

test('session-controller focus changes reuse the visible handles without suspending peers', async () => {
  const members = [
    createMember('m-1'),
    createMember('m-2'),
    createMember('m-3'),
    createMember('m-4'),
    createMember('m-5'),
    createMember('m-6'),
  ]
  const deps = makeSessionDeps({ members })
  const controller = createSessionController({
    daemonApi: deps.daemonApi,
    terminalClient: deps.terminalClient,
    deliveryClient: deps.deliveryClient,
    layoutStore: deps.layoutStore,
  })

  await controller.loadWorkspaceSessions('ws-1')
  const visibleMemberIds = ['m-1', 'm-2', 'm-3', 'm-4', 'm-5']
  const beforeHandles = await controller.attachVisibleMembers('ws-1', visibleMemberIds)
  const attachCount = deps.attachCalls.length

  await controller.applyLayoutOperation('ws-1', { kind: 'enterMemberFocus', memberId: 'm-3' })
  const afterHandles = await controller.attachVisibleMembers('ws-1', visibleMemberIds)

  assert.equal(deps.attachCalls.length, attachCount)
  assert.deepEqual(deps.suspendCalls, [])
  assert.deepEqual(afterHandles, beforeHandles)
  assert.equal(controller.getState().workspaceLoadable.value.layout.focusedMemberId, 'm-3')
  for (const memberId of visibleMemberIds) {
    assert.equal(controller.getTerminalHandle(memberId).isBodyActive(), true)
  }
})

test('session-controller suspends handles that leave the visible set and reuses them on return', async () => {
  const members = [
    createMember('m-1'),
    createMember('m-2'),
    createMember('m-3'),
    createMember('m-4'),
    createMember('m-5'),
    createMember('m-6'),
  ]
  const deps = makeSessionDeps({ members })
  const controller = createSessionController({
    daemonApi: deps.daemonApi,
    terminalClient: deps.terminalClient,
    deliveryClient: deps.deliveryClient,
    layoutStore: deps.layoutStore,
  })

  await controller.loadWorkspaceSessions('ws-1')
  const firstHandle = (await controller.attachVisibleMembers('ws-1', ['m-1', 'm-2', 'm-3', 'm-4', 'm-5']))[0]
  await controller.attachVisibleMembers('ws-1', ['m-1', 'm-2', 'm-6'])

  assert.deepEqual(deps.suspendCalls.sort(), ['m-3', 'm-4', 'm-5'])
  assert.equal(controller.getTerminalHandle('m-3').isBodyActive(), false)
  assert.equal(controller.getTerminalHandle('m-6').isBodyActive(), true)

  const returnedHandles = await controller.attachVisibleMembers('ws-1', ['m-1', 'm-2', 'm-3', 'm-4', 'm-5'])
  assert.strictEqual(returnedHandles[0], firstHandle)
  assert.equal(controller.getTerminalHandle('m-3').isBodyActive(), true)
  assert.equal(controller.getTerminalHandle('m-6').isBodyActive(), false)
  assert.deepEqual(deps.attachCalls, ['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6'])
})

test('session-controller replaces a handle when the member target session changes', async () => {
  const members = [createMember('m-1'), createMember('m-2')]
  const deps = makeSessionDeps({ members })
  const controller = createSessionController({
    daemonApi: deps.daemonApi,
    terminalClient: deps.terminalClient,
    deliveryClient: deps.deliveryClient,
    layoutStore: deps.layoutStore,
  })

  await controller.loadWorkspaceSessions('ws-1')
  const [firstHandle] = await controller.attachVisibleMembers('ws-1', ['m-1'])
  controller.syncWorkspaceMembers('ws-1', [
    createMember('m-1', 'online', { sessionId: 'session-m-1-new' }),
    createMember('m-2'),
  ])

  const [replacementHandle] = await controller.attachVisibleMembers('ws-1', ['m-1'])

  assert.notStrictEqual(replacementHandle, firstHandle)
  assert.equal(replacementHandle.sessionId, 'session-m-1-new')
  assert.equal(firstHandle.isBodyActive(), false)
  assert.deepEqual(deps.disconnectCalls, ['m-1'])
  assert.deepEqual(deps.attachCalls, ['m-1', 'm-1'])
})

test('session-controller keeps independent visible targets attached when one target fails', async () => {
  const members = [createMember('m-1'), createMember('m-2'), createMember('m-3')]
  const deps = makeSessionDeps({
    members,
    attachFailureByMemberId: new Set(['m-2']),
  })
  const controller = createSessionController({
    daemonApi: deps.daemonApi,
    terminalClient: deps.terminalClient,
    deliveryClient: deps.deliveryClient,
    layoutStore: deps.layoutStore,
  })

  await controller.loadWorkspaceSessions('ws-1')
  const handles = await controller.attachVisibleMembers('ws-1', ['m-1', 'm-2', 'm-3'])

  assert.deepEqual(handles.map((handle) => handle.memberId), ['m-1', 'm-3'])
  assert.equal(controller.getTerminalHandle('m-1').isBodyActive(), true)
  assert.equal(controller.getTerminalHandle('m-2'), null)
  assert.equal(controller.getMemberState('m-2').lastError.code, 'TERMINAL_ATTACH_FAILED')
  assert.equal(controller.getTerminalHandle('m-3').isBodyActive(), true)
  assert.deepEqual(deps.disconnectCalls, [])
})

test('session-controller stale attach cannot overwrite current focus', async () => {
  const aliceGate = deferred()
  const bobGate = deferred()
  const members = [createMember('m-1'), createMember('m-2')]
  const deps = makeSessionDeps({
    members,
    attachGateByMemberId: new Map([
      ['m-1', aliceGate],
      ['m-2', bobGate],
    ]),
  })
  const controller = createSessionController({
    daemonApi: deps.daemonApi,
    terminalClient: deps.terminalClient,
    deliveryClient: deps.deliveryClient,
    layoutStore: deps.layoutStore,
  })

  await controller.loadWorkspaceSessions('ws-1')
  const aliceAttach = controller.attachFocusedMember('ws-1')
  const bobSwitch = controller.applyLayoutOperation('ws-1', { kind: 'enterMemberFocus', memberId: 'm-2' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  bobGate.resolve()
  await bobSwitch
  aliceGate.resolve()
  await aliceAttach

  const bobHandle = controller.getTerminalHandle('m-2')
  assert.ok(bobHandle)
  assert.equal(bobHandle.isBodyActive(), true)
  assert.equal(controller.getTerminalHandle('m-1'), null)
  assert.equal(deps.terminalHandles.get('m-1').isBodyActive(), false)
  assert.deepEqual(deps.attachCalls, ['m-1', 'm-2'])
  assert.deepEqual(deps.disconnectCalls, [])
})

test('session-controller stale workspace attach cannot become active', async () => {
  const alphaGate = deferred()
  const betaGate = deferred()
  const alphaMembers = [createMember('m-1'), createMember('m-2')]
  const betaMembers = [createMember('n-1'), createMember('n-2')]
  const deps = makeSessionDeps({
    members: alphaMembers,
    membersByWorkspace: new Map([
      ['ws-alpha', alphaMembers],
      ['ws-beta', betaMembers],
    ]),
    attachGateByMemberId: new Map([
      ['m-1', alphaGate],
      ['n-1', betaGate],
    ]),
  })
  const controller = createSessionController({
    daemonApi: deps.daemonApi,
    terminalClient: deps.terminalClient,
    deliveryClient: deps.deliveryClient,
    layoutStore: deps.layoutStore,
  })

  await controller.loadWorkspaceSessions('ws-alpha')
  const alphaAttach = controller.attachFocusedMember('ws-alpha')
  await controller.loadWorkspaceSessions('ws-beta')
  alphaGate.resolve()
  await alphaAttach

  assert.equal(controller.getTerminalHandle('m-1'), null)
  assert.equal(deps.terminalHandles.get('m-1').isBodyActive(), false)

  const betaAttach = controller.attachFocusedMember('ws-beta')
  betaGate.resolve()
  await betaAttach
  assert.equal(controller.getTerminalHandle('n-1').isBodyActive(), true)
})

test('session-controller duplicate focused attach shares one in-flight request', async () => {
  const gate = deferred()
  const deps = makeSessionDeps({
    members: [createMember('m-1'), createMember('m-2')],
    attachGateByMemberId: new Map([['m-1', gate]]),
  })
  const controller = createSessionController({
    daemonApi: deps.daemonApi,
    terminalClient: deps.terminalClient,
    deliveryClient: deps.deliveryClient,
    layoutStore: deps.layoutStore,
  })

  await controller.loadWorkspaceSessions('ws-1')
  const first = controller.attachFocusedMember('ws-1')
  const second = controller.attachFocusedMember('ws-1')
  assert.equal(deps.attachCalls.filter((memberId) => memberId === 'm-1').length, 1)

  gate.resolve()
  const [firstHandle, secondHandle] = await Promise.all([first, second])
  assert.strictEqual(firstHandle, secondHandle)
  assert.equal(controller.getTerminalHandle('m-1').isBodyActive(), true)
})

test('session-controller attach failure stays typed without fabricating a handle', async () => {
  const deps = makeSessionDeps({
    members: [createMember('m-1'), createMember('m-2')],
    attachFailureByMemberId: new Set(['m-1']),
  })
  const controller = createSessionController({
    daemonApi: deps.daemonApi,
    terminalClient: deps.terminalClient,
    deliveryClient: deps.deliveryClient,
    layoutStore: deps.layoutStore,
  })

  await controller.loadWorkspaceSessions('ws-1')
  const result = await controller.attachFocusedMember('ws-1')

  assert.equal(result, null)
  assert.equal(controller.getTerminalHandle('m-1'), null)
  assert.equal(controller.getMemberState('m-1').lastError.code, 'TERMINAL_ATTACH_FAILED')
})

test('session-controller A-B-A suspends and reuses the original handle', async () => {
  const deps = makeSessionDeps({ members: [createMember('m-1'), createMember('m-2'), createMember('m-3')] })
  const controller = createSessionController({
    daemonApi: deps.daemonApi,
    terminalClient: deps.terminalClient,
    deliveryClient: deps.deliveryClient,
    layoutStore: deps.layoutStore,
  })

  await controller.loadWorkspaceSessions('ws-1')
  const firstAlice = await controller.attachFocusedMember('ws-1')
  firstAlice.deliverFrame()
  assert.equal(firstAlice.getSnapshot().deliveredFrames, 1)

  await controller.applyLayoutOperation('ws-1', { kind: 'enterMemberFocus', memberId: 'm-2' })
  assert.equal(firstAlice.isBodyActive(), false)
  firstAlice.deliverFrame()
  assert.equal(firstAlice.getSnapshot().deliveredFrames, 1)
  assert.equal(controller.getTerminalHandle('m-2').isBodyActive(), true)

  await controller.applyLayoutOperation('ws-1', { kind: 'enterMemberFocus', memberId: 'm-1' })
  assert.strictEqual(controller.getTerminalHandle('m-1'), firstAlice)
  assert.equal(firstAlice.isBodyActive(), true)
  firstAlice.deliverFrame()
  assert.equal(firstAlice.getSnapshot().deliveredFrames, 2)
  assert.deepEqual(deps.attachCalls, ['m-1', 'm-2'])
  assert.deepEqual(deps.suspendCalls, ['m-1', 'm-2'])
  assert.deepEqual(deps.resumeCalls, ['m-1', 'm-2', 'm-1'])
  assert.deepEqual(deps.disconnectCalls, [])
})

test('pane-terminal-client suspend and resume keep one stream and one renderer handle', async () => {
  let emitBuffer = null
  let openCalls = 0
  let closeCalls = 0
  const api = {
    openTerminalStream(_target, handlers) {
      openCalls += 1
      emitBuffer = handlers.onBuffer
      handlers.onReady()
      return {
        close() {
          closeCalls += 1
        },
      }
    },
    async sendInput() {
      return { ok: true }
    },
  }
  const client = createPaneTerminalClient({ api })
  const member = createMember('m-1')
  const handle = await client.attachSession(member)

  emitBuffer({ ansi: 'first', frame: { cols: 80, rows: 24 } })
  assert.equal(handle.getSnapshot().deliveredFrameCount, 1)
  assert.equal(handle.getSnapshot().subscriptionState, 'active')

  await client.suspend(handle)
  emitBuffer({ ansi: 'inactive', frame: { cols: 80, rows: 24 } })
  assert.equal(handle.getSnapshot().deliveredFrameCount, 1)
  assert.equal(handle.getSnapshot().subscriptionState, 'suspended')

  await client.resume(handle)
  emitBuffer({ ansi: 'resumed', frame: { cols: 80, rows: 24 } })
  assert.equal(handle.getSnapshot().deliveredFrameCount, 2)
  assert.equal(handle.getSnapshot().subscriptionState, 'active')
  assert.strictEqual(await client.attachSession(member), handle)
  assert.equal(openCalls, 1)
  assert.equal(closeCalls, 0)
})

test('session-controller rejects unknown and stale target writes with typed errors', async () => {
  const members = [createMember('m-1', 'online'), createMember('m-2', 'stale'), createMember('m-3', 'unknown')]
  const deps = makeSessionDeps({ members })
  const controller = createSessionController({ daemonApi: deps.daemonApi, terminalClient: deps.terminalClient, deliveryClient: deps.deliveryClient, layoutStore: deps.layoutStore })
  await controller.loadWorkspaceSessions('ws-1')

  await assert.rejects(controller.sendMemberMessage({ workspaceId: 'ws-1', senderMemberId: 'm-1', recipientMemberId: 'm-2', body: 'hi' }), (error) => {
    assert.equal(error.code, 'DELIVERY_TARGET_UNKNOWN_STATE')
    assert.equal(error.retryable, true)
    return true
  })
  await assert.rejects(controller.sendTerminalInput('m-3', 'ls'), (error) => {
    assert.equal(error.code, 'SESSION_TARGET_UNAVAILABLE')
    return true
  })
  assert.equal(controller.getLastOperationError().code, 'SESSION_TARGET_UNAVAILABLE')
})

test('session-controller writes receipts only to the original target', async () => {
  const deps = makeSessionDeps({ members: [createMember('m-1', 'online'), createMember('m-2', 'online')] })
  const controller = createSessionController({ daemonApi: deps.daemonApi, terminalClient: deps.terminalClient, deliveryClient: deps.deliveryClient, layoutStore: deps.layoutStore })
  await controller.loadWorkspaceSessions('ws-1')
  const receipt = await controller.sendMemberMessage({ workspaceId: 'ws-1', senderMemberId: 'm-1', recipientMemberId: 'm-2', body: 'hello' })
  assert.equal(receipt.receiptId, 'r-m-2')
  assert.equal(controller.getMemberState('m-2').receipts.length, 1)
  assert.equal(controller.getMemberState('m-1').receipts.length, 0)
})

test('session-controller surfaces auth errors without demo sessions', async () => {
  const deps = makeSessionDeps({ authError: true })
  const controller = createSessionController({ daemonApi: deps.daemonApi, terminalClient: deps.terminalClient, deliveryClient: deps.deliveryClient, layoutStore: deps.layoutStore })
  await controller.loadWorkspaceSessions('ws-1')
  const loadable = controller.getWorkspaceLoadable()
  assert.equal(loadable.status, 'unavailable')
  assert.equal(loadable.error.code, 'AUTH_INVALID_TOKEN')
  assert.equal(loadable.value, null)
})

test('session-controller never fabricates fake handles or fake write success when ports are missing', async () => {
  const noDaemonController = createSessionController()
  await noDaemonController.loadWorkspaceSessions('ws-1')
  assert.equal(noDaemonController.getWorkspaceLoadable().status, 'unavailable')
  assert.equal(noDaemonController.getWorkspaceLoadable().error.code, 'DAEMON_API_UNAVAILABLE')

  const deps = makeSessionDeps({ members: [createMember('m-1', 'online')] })
  const noTerminalController = createSessionController({
    daemonApi: deps.daemonApi,
    terminalClient: null,
    deliveryClient: null,
    layoutStore: deps.layoutStore,
  })
  await noTerminalController.loadWorkspaceSessions('ws-1')
  await noTerminalController.attachFocusedMember('ws-1')
  assert.equal(noTerminalController.getTerminalHandle('m-1'), null)
  assert.equal(noTerminalController.getMemberState('m-1').lastError.code, 'TERMINAL_CLIENT_UNAVAILABLE')

  await assert.rejects(noTerminalController.sendTerminalInput('m-1', 'ls\n'), (error) => {
    assert.equal(error.code, 'TERMINAL_CLIENT_UNAVAILABLE')
    return true
  })
  await assert.rejects(noTerminalController.sendMemberMessage({
    workspaceId: 'ws-1',
    senderMemberId: 'm-1',
    recipientMemberId: 'm-1',
    body: 'hello',
  }), (error) => {
    assert.equal(error.code, 'DELIVERY_CLIENT_UNAVAILABLE')
    return true
  })
})

