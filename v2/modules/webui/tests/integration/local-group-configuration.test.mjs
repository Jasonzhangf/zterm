import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { createWebUIApp } from '../../src/app/app-shell.mjs'
import { createDemoPorts } from '../fixtures/demo-ports.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function typedError(code, message, details = null) {
  return {
    code,
    category: 'conflict',
    status: 409,
    message,
    retryable: false,
    retryDisposition: 'refresh',
    details,
  }
}

function createLocalGroupPorts() {
  const ports = createDemoPorts()
  const daemonApi = ports.daemonApi
  const baseGetWorkspaceSnapshot = daemonApi.getWorkspaceSnapshot.bind(daemonApi)
  const localGroupCalls = {
    createGroup: [],
    createMember: [],
    configureMemberRuntime: [],
    bindMemberSession: [],
    restoreMemberBinding: [],
    getMemberRuntime: [],
  }
  const groupsByWorkspace = new Map([
    ['ws-alpha', [
      { groupId: 'g-root', workspaceId: 'ws-alpha', parentGroupId: null, name: 'Alpha', path: '/Alpha' },
    ]],
    ['ws-beta', [
      { groupId: 'g-beta', workspaceId: 'ws-beta', parentGroupId: null, name: 'Beta', path: '/Beta' },
    ]],
  ])
  const revisionByWorkspace = new Map([
    ['ws-alpha', 7],
    ['ws-beta', 11],
  ])
  const runtimeByMember = new Map([
    ['m-1', {
      memberId: 'm-1',
      machineId: 'this-mac',
      hostKind: 'tmux',
      agentKind: 'codex',
      launchProfileRef: 'profile-alpha',
    }],
    ['m-2', {
      memberId: 'm-2',
      machineId: 'peer-mac',
      hostKind: 'tmux',
      agentKind: 'codex',
      launchProfileRef: 'profile-beta',
    }],
  ])
  const bindingByMember = new Map([
    ['m-1', {
      memberId: 'm-1',
      machineId: 'this-mac',
      sessionId: 'session-alpha',
      anchor: 'pane:0',
      generation: 2,
      terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:alpha' },
    }],
  ])
  const generationByMember = new Map([['m-1', 2], ['m-2', 3]])
  const runtimeGateByMember = new Map()

  function memberRuntime(workspaceId, memberId) {
    const runtime = runtimeByMember.get(memberId) || null
    const binding = bindingByMember.get(memberId) || null
    return {
      member: {
        memberId,
        workspaceId,
        groupId: groupsByWorkspace.get(workspaceId)?.[0]?.groupId ?? null,
        groupPath: groupsByWorkspace.get(workspaceId)?.[0]?.path ?? '/',
        name: memberId === 'm-1' ? 'Ada' : (memberId === 'm-2' ? 'Bo' : memberId),
      },
      runtime,
      binding,
      bindingGeneration: generationByMember.get(memberId) ?? 0,
      agentCapabilities: { start: 'unsupported', resume: 'unsupported' },
      availability: { status: binding ? 'bound' : 'unconfigured', observedAt: '2026-11-11T12:00:00.000Z' },
    }
  }

  daemonApi.getWorkspaceSnapshot = async (options = {}) => {
    daemonApi.calls.getWorkspaceSnapshot.push({ workspaceId: options.workspaceId })
    const snapshot = await baseGetWorkspaceSnapshot(options)
    const workspaceId = options.workspaceId
    return {
      ...snapshot,
      workspace: {
        ...snapshot.workspace,
        revision: revisionByWorkspace.get(workspaceId) ?? 0,
        rootGroupId: groupsByWorkspace.get(workspaceId)?.[0]?.groupId ?? null,
      },
      groups: (groupsByWorkspace.get(workspaceId) || []).map((group) => ({ ...group })),
      members: snapshot.members.map((member) => ({
        ...member,
        groupId: groupsByWorkspace.get(workspaceId)?.[0]?.groupId ?? null,
        runtime: runtimeByMember.get(member.memberId) || null,
        binding: bindingByMember.get(member.memberId) || null,
        bindingGeneration: generationByMember.get(member.memberId) ?? 0,
        agentCapabilities: { start: 'unsupported', resume: 'unsupported' },
      })),
    }
  }

  daemonApi.createGroup = async (input) => {
    localGroupCalls.createGroup.push({ ...input })
    const currentRevision = revisionByWorkspace.get(input.workspaceId)
    if (input.expectedRevision !== currentRevision) {
      throw typedError('ORGANIZATION_REVISION_STALE', 'workspace revision changed', {
        expectedRevision: input.expectedRevision,
        currentRevision,
      })
    }
    const group = {
      groupId: 'g-new',
      workspaceId: input.workspaceId,
      parentGroupId: input.parentGroupId,
      name: input.name,
      path: '/Alpha/Local Group',
      revision: currentRevision + 1,
    }
    groupsByWorkspace.set(input.workspaceId, [...groupsByWorkspace.get(input.workspaceId), group])
    revisionByWorkspace.set(input.workspaceId, group.revision)
    return group
  }

  daemonApi.createMember = async (input) => {
    localGroupCalls.createMember.push({ ...input })
    const currentRevision = revisionByWorkspace.get(input.workspaceId)
    if (input.expectedRevision !== currentRevision) {
      throw typedError('ORGANIZATION_REVISION_STALE', 'workspace revision changed', {
        expectedRevision: input.expectedRevision,
        currentRevision,
      })
    }
    const memberId = 'm-new'
    const member = {
      memberId,
      workspaceId: input.workspaceId,
      groupId: input.groupId,
      name: input.name,
      managerMemberId: null,
      revision: currentRevision + 1,
    }
    const original = daemonApi.getWorkspaceSnapshot
    daemonApi.getWorkspaceSnapshot = async (options = {}) => {
      const snapshot = await original(options)
      if (options.workspaceId !== input.workspaceId) return snapshot
      return {
        ...snapshot,
        members: [
          ...snapshot.members.filter((item) => item.memberId !== member.memberId),
          { ...member, groupPath: '/Alpha/Local Group', status: 'unknown', machine: '' },
        ],
      }
    }
    revisionByWorkspace.set(input.workspaceId, member.revision)
    return member
  }

  daemonApi.getMemberRuntime = async ({ workspaceId, memberId } = {}) => {
    localGroupCalls.getMemberRuntime.push({ workspaceId, memberId })
    return memberRuntime(workspaceId, memberId)
  }

  daemonApi.configureMemberRuntime = async (input) => {
    localGroupCalls.configureMemberRuntime.push({ ...input })
    const gate = runtimeGateByMember.get(input.memberId)
    if (gate) await gate.promise
    const runtime = {
      memberId: input.memberId,
      machineId: input.machineId,
      hostKind: input.hostKind,
      agentKind: input.agentKind,
      launchProfileRef: input.launchProfileRef,
    }
    runtimeByMember.set(input.memberId, runtime)
    bindingByMember.delete(input.memberId)
    return runtime
  }

  daemonApi.bindMemberSession = async (input) => {
    localGroupCalls.bindMemberSession.push({ ...input })
    const currentGeneration = generationByMember.get(input.memberId) ?? 0
    if (input.expectedGeneration !== currentGeneration) {
      throw typedError('BINDING_GENERATION_STALE', 'binding generation changed', {
        currentGeneration,
        expectedGeneration: input.expectedGeneration,
      })
    }
    const runtime = runtimeByMember.get(input.memberId)
    const binding = {
      memberId: input.memberId,
      machineId: runtime.machineId,
      sessionId: input.sessionId,
      anchor: input.anchor,
      generation: currentGeneration + 1,
      terminalTarget: { backend: 'tmux', stableId: 'tmux:v1:observed' },
    }
    bindingByMember.set(input.memberId, binding)
    generationByMember.set(input.memberId, binding.generation)
    return binding
  }

  daemonApi.restoreMemberBinding = async (input) => {
    localGroupCalls.restoreMemberBinding.push({ ...input })
    const binding = bindingByMember.get(input.memberId)
    if (!binding) throw typedError('BINDING_NOT_FOUND', 'binding not found')
    if (input.expectedGeneration !== binding.generation) {
      throw typedError('BINDING_GENERATION_STALE', 'binding generation changed', {
        currentGeneration: binding.generation,
        expectedGeneration: input.expectedGeneration,
      })
    }
    return {
      restored: true,
      memberId: binding.memberId,
      machineId: binding.machineId,
      sessionId: binding.sessionId,
      anchor: binding.anchor,
      generation: binding.generation,
      terminalTarget: binding.terminalTarget,
      observedAt: '2026-11-11T12:01:00.000Z',
    }
  }

  return {
    ...ports,
    localGroupCalls,
    setRuntimeGate(memberId, gate) {
      if (gate) runtimeGateByMember.set(memberId, gate)
      else runtimeGateByMember.delete(memberId)
    },
  }
}

test('Workspace page renders local group forms, machine scope, and disabled unsupported agent controls', async () => {
  const ports = createLocalGroupPorts()
  const app = createWebUIApp({
    daemonApi: ports.daemonApi,
    terminalClient: ports.terminalClient,
    deliveryClient: ports.deliveryClient,
    initialRoute: 'workspaces',
    initialWorkspaceId: 'ws-alpha',
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  await app.ready

  const page = app.renderPage()
  assert.ok(page.html.includes('data-form-id="workspace-group-create-form"'))
  assert.ok(page.html.includes('data-form-id="workspace-member-create-form"'))
  assert.ok(page.html.includes('data-form-id="workspace-runtime-form"'))
  assert.ok(page.html.includes('data-form-id="workspace-binding-form"'))
  assert.ok(page.html.includes('data-action="restore-member-binding"'))
  assert.ok(page.html.includes('data-action="filter-members-by-machine"'))
  assert.ok(page.html.includes('data-agent-capability="resume"'))
  assert.match(page.html, /data-agent-capability="resume"[^>]*disabled/)
})

test('workspace group selects use the loaded snapshot and the created option through the mounted UI', async () => {
  const ports = createLocalGroupPorts()
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/#/workspaces',
  })
  const app = createWebUIApp({
    daemonApi: ports.daemonApi,
    terminalClient: ports.terminalClient,
    deliveryClient: ports.deliveryClient,
    initialRoute: 'workspaces',
    initialWorkspaceId: 'ws-alpha',
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  await app.ready
  app.mount(dom.window.document.querySelector('#root'))

  const root = dom.window.document.querySelector('#root')
  const selectOptions = (name) => [...root.querySelectorAll(`select[name="${name}"] option`)].map((option) => ({
    value: option.value,
    label: option.textContent,
  }))
  const expectedInitialOptions = [{ value: 'g-root', label: 'Alpha' }]

  assert.deepEqual(selectOptions('groupParentId'), expectedInitialOptions)
  assert.deepEqual(selectOptions('memberGroupId'), expectedInitialOptions)

  const groupForm = root.querySelector('#workspace-group-create-form')
  groupForm.querySelector('[name="groupName"]').value = 'Local Group'
  assert.equal(groupForm.querySelector('[name="groupParentId"]').value, 'g-root')

  const groupCreated = new Promise((resolve) => {
    const unsubscribe = app.subscribe(() => {
      if (!app.state.groups.some((group) => group.groupId === 'g-new')) return
      unsubscribe()
      resolve()
    })
  })
  groupForm.querySelector('button[data-form-id="workspace-group-create-form"]').click()
  await groupCreated

  const expectedCreatedOptions = [
    { value: 'g-root', label: 'Alpha' },
    { value: 'g-new', label: 'Local Group' },
  ]
  assert.deepEqual(selectOptions('groupParentId'), expectedCreatedOptions)
  assert.deepEqual(selectOptions('memberGroupId'), expectedCreatedOptions)

  const memberForm = root.querySelector('#workspace-member-create-form')
  const selectedGroupOption = memberForm.querySelector('[name="memberGroupId"] option[value="g-new"]')
  memberForm.querySelector('[name="memberGroupId"]').value = selectedGroupOption.value
  memberForm.querySelector('[name="memberName"]').value = 'Local Member'

  const memberCreated = new Promise((resolve) => {
    const unsubscribe = app.subscribe(() => {
      if (app.state.localGroupResults.member?.status !== 'success') return
      unsubscribe()
      resolve(ports.localGroupCalls.createMember[0])
    })
  })
  memberForm.querySelector('button[data-form-id="workspace-member-create-form"]').click()
  const memberInput = await memberCreated

  assert.equal(memberInput.groupId, 'g-new')
  assert.equal(memberInput.name, 'Local Member')
  app.destroy()
  dom.window.close()
})

test('local group intents refresh authoritative revisions and use retained binding generations', async () => {
  const ports = createLocalGroupPorts()
  const app = createWebUIApp({
    daemonApi: ports.daemonApi,
    terminalClient: ports.terminalClient,
    deliveryClient: ports.deliveryClient,
    initialRoute: 'workspaces',
    initialWorkspaceId: 'ws-alpha',
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  await app.ready
  const snapshotCallsBefore = ports.daemonApi.calls.getWorkspaceSnapshot.length

  const groupResult = await app.dispatchAction('create-group', {
    workspaceId: 'ws-alpha',
    name: 'Local Group',
    parentGroupId: 'g-root',
  })
  assert.equal(groupResult.ok, true)
  assert.deepEqual(ports.localGroupCalls.createGroup[0], {
    workspaceId: 'ws-alpha',
    name: 'Local Group',
    parentGroupId: 'g-root',
    expectedRevision: 7,
  })
  assert.ok(ports.daemonApi.calls.getWorkspaceSnapshot.length > snapshotCallsBefore)

  const memberResult = await app.dispatchAction('create-member', {
    workspaceId: 'ws-alpha',
    groupId: 'g-new',
    name: 'Local Member',
  })
  assert.equal(memberResult.ok, true)
  assert.equal(ports.localGroupCalls.createMember[0].expectedRevision, 8)

  await app.dispatchAction('select-member', {
    workspaceId: 'ws-alpha',
    memberId: 'm-new',
  })

  const runtimeResult = await app.dispatchAction('configure-member-runtime', {
    workspaceId: 'ws-alpha',
    memberId: 'm-new',
    machineId: 'machine-new',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'profile-new',
  })
  assert.equal(runtimeResult.ok, true)
  assert.deepEqual(
    ports.localGroupCalls.configureMemberRuntime[0],
    {
      workspaceId: 'ws-alpha',
      memberId: 'm-new',
      machineId: 'machine-new',
      hostKind: 'tmux',
      agentKind: 'codex',
      launchProfileRef: 'profile-new',
    },
  )

  const bindResult = await app.dispatchAction('bind-member-session', {
    workspaceId: 'ws-alpha',
    memberId: 'm-new',
    sessionId: 'owned-session',
    anchor: 'pane:3',
  })
  assert.equal(bindResult.ok, true)
  assert.equal(ports.localGroupCalls.bindMemberSession[0].expectedGeneration, 0)
  assert.equal(ports.localGroupCalls.bindMemberSession[0].terminalTarget, undefined)

  const verifyResult = await app.dispatchAction('restore-member-binding', {
    workspaceId: 'ws-alpha',
    memberId: 'm-new',
  })
  assert.equal(verifyResult.ok, true)
  assert.deepEqual(ports.localGroupCalls.restoreMemberBinding[0], {
    workspaceId: 'ws-alpha',
    memberId: 'm-new',
    machineId: 'machine-new',
    expectedGeneration: 1,
  })

  const page = app.renderPage()
  assert.ok(page.html.includes('Binding verified'))
  assert.ok(!page.html.includes('Agent resumed'))
})

test('local group write refreshes the visible workspace revision', async () => {
  const ports = createLocalGroupPorts()
  const app = createWebUIApp({
    daemonApi: ports.daemonApi,
    terminalClient: ports.terminalClient,
    deliveryClient: ports.deliveryClient,
    initialRoute: 'workspaces',
    initialWorkspaceId: 'ws-alpha',
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  await app.ready

  assert.ok(!app.renderPage().html.includes('Revision 8'))

  const result = await app.dispatchAction('create-group', {
    workspaceId: 'ws-alpha',
    name: 'Revision Refresh Group',
    parentGroupId: 'g-root',
  })

  assert.equal(result.ok, true)
  const page = app.renderPage()
  assert.equal(app.state.workspaces.find((workspace) => workspace.workspaceId === 'ws-alpha')?.revision, 8)
  assert.ok(page.html.includes('Revision 8'))
  app.destroy()
})

test('typed local group conflicts stay on the affected member and are not retried', async () => {
  const ports = createLocalGroupPorts()
  const originalBind = ports.daemonApi.bindMemberSession
  let bindCalls = 0
  ports.daemonApi.bindMemberSession = async (input) => {
    bindCalls += 1
    await originalBind(input)
    throw typedError('BINDING_GENERATION_STALE', 'binding generation changed', {
      currentGeneration: 7,
      expectedGeneration: input.expectedGeneration,
    })
  }
  const app = createWebUIApp({
    daemonApi: ports.daemonApi,
    terminalClient: ports.terminalClient,
    deliveryClient: ports.deliveryClient,
    initialRoute: 'workspaces',
    initialWorkspaceId: 'ws-alpha',
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  await app.ready

  const result = await app.dispatchAction('bind-member-session', {
    workspaceId: 'ws-alpha',
    memberId: 'm-1',
    sessionId: 'owned-session',
    anchor: 'pane:1',
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'BINDING_GENERATION_STALE')
  assert.equal(bindCalls, 1)
  assert.equal(app.state.localGroupMemberResults['m-1'].error.code, 'BINDING_GENERATION_STALE')
  const page = app.renderPage()
  assert.ok(page.html.includes('BINDING_GENERATION_STALE'))
  assert.ok(page.html.includes('data-result-member-id="m-1"'))
})

test('late local group responses are discarded after member or workspace scope changes', async () => {
  const ports = createLocalGroupPorts()
  const app = createWebUIApp({
    daemonApi: ports.daemonApi,
    terminalClient: ports.terminalClient,
    deliveryClient: ports.deliveryClient,
    initialRoute: 'workspaces',
    initialWorkspaceId: 'ws-alpha',
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  await app.ready

  const memberGate = deferred()
  ports.setRuntimeGate('m-1', memberGate)
  const pendingMemberWrite = app.dispatchAction('configure-member-runtime', {
    workspaceId: 'ws-alpha',
    memberId: 'm-1',
    machineId: 'late-machine',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'late-profile',
  })
  await app.dispatchAction('select-member', {
    workspaceId: 'ws-alpha',
    memberId: 'm-2',
  })
  memberGate.resolve()
  const memberResult = await pendingMemberWrite
  assert.equal(memberResult.ok, true)
  assert.equal(app.state.localGroupMemberResults['m-1'], undefined)
  assert.equal(app.state.selectedMemberId, 'm-2')

  const workspaceGate = deferred()
  ports.setRuntimeGate('m-1', workspaceGate)
  const pendingWorkspaceWrite = app.dispatchAction('configure-member-runtime', {
    workspaceId: 'ws-alpha',
    memberId: 'm-1',
    machineId: 'late-workspace-machine',
    hostKind: 'tmux',
    agentKind: 'codex',
    launchProfileRef: 'late-workspace-profile',
  })
  await app.loadWorkspace('ws-beta')
  workspaceGate.resolve()
  await pendingWorkspaceWrite

  assert.equal(app.state.activeWorkspaceId, 'ws-beta')
  assert.equal(app.state.localGroupMemberResults['m-1'], undefined)
})
