import { createWebUIApp } from '../../src/app/app-shell.mjs'
import { normalizeTypedError } from '../../src/controllers/session-controller.mjs'

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function nowIso() {
  return new Date().toISOString()
}

export const DEFAULT_WORKSPACES = Object.freeze([
  {
    workspaceId: 'ws-alpha',
    parentId: null,
    depth: 0,
    name: 'v2 / Alpha 总工作区',
    path: 'v2 / Alpha 总工作区',
    managerName: 'Jenny (Master)',
    memberCount: 6,
    machineCount: 3,
    unreadCount: 2,
    status: 'online',
  },
  {
    workspaceId: 'ws-beta',
    parentId: 'ws-alpha',
    depth: 1,
    name: '架构与后端组 (Beta)',
    path: 'v2 / 架构与后端组 (Beta)',
    managerName: 'David (Arch Lead)',
    memberCount: 6,
    machineCount: 2,
    unreadCount: 0,
    status: 'online',
  },
  {
    workspaceId: 'ws-gamma',
    parentId: 'ws-alpha',
    depth: 1,
    name: 'WebUI 与交互组 (Gamma)',
    path: 'v2 / WebUI 与交互组 (Gamma)',
    managerName: 'Emma (UX Lead)',
    memberCount: 3,
    machineCount: 2,
    unreadCount: 1,
    status: 'online',
  },
  {
    workspaceId: 'ws-delta',
    parentId: 'ws-gamma',
    depth: 2,
    name: '移动端终端适配子组 (Delta)',
    path: 'v2 / WebUI 与交互组 / 移动端终端适配子组 (Delta)',
    managerName: 'Grace (Mobile)',
    memberCount: 2,
    machineCount: 1,
    unreadCount: 0,
    status: 'offline',
  },
])

export function createDemoMembers(prefix, workspaceId) {
  const names = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay']
  return names.map((name, index) => ({
    memberId: `${prefix}-${index + 1}`,
    workspaceId,
    name,
    role: index === 0 ? 'primary' : 'peer',
    machine: index < 3 ? 'this-mac' : 'peer-mac',
    status: index === 2 ? 'busy' : 'online',
    freshness: 'fresh',
    sessionId: `session-${prefix}-${index + 1}`,
    removedFromWorkspace: false,
  }))
}

export function createDemoTickets(workspaceId = 'ws-alpha') {
  const byWorkspace = {
    'ws-alpha': [
      { ticketId: 'T-101', workspaceId: 'ws-alpha', title: 'Alpha: Verify session layout persistence', status: 'review', assigneeId: 'm-1', reviewerId: 'm-2', priority: 'high', description: 'Confirm border drag survives reload in Alpha workspace.', acceptanceCriteria: ['Reload keeps ratio'], deliveryEvidence: ['integration test'], allowedTransitions: ['close', 'reopen'] },
      { ticketId: 'T-102', workspaceId: 'ws-alpha', title: 'Alpha: Mobile preview to focus', status: 'in-progress', assigneeId: 'm-3', reviewerId: 'm-1', priority: 'medium', description: 'Check viewport restoration in Alpha workspace.', acceptanceCriteria: ['Preview viewport restored'], deliveryEvidence: [], allowedTransitions: ['review'] },
    ],
    'ws-beta': [
      { ticketId: 'T-201', workspaceId: 'ws-beta', title: 'Beta: Daemon mirror snapshot isolation', status: 'open', assigneeId: 'b-1', reviewerId: 'b-2', priority: 'high', description: 'Ensure Beta daemon mirror snapshot stays read-only.', acceptanceCriteria: ['Read-only snapshot'], deliveryEvidence: [], allowedTransitions: ['in-progress', 'review'] },
      { ticketId: 'T-202', workspaceId: 'ws-beta', title: 'Beta: Mux channel atomic rollback', status: 'blocked', assigneeId: 'b-2', reviewerId: 'b-1', priority: 'high', description: 'Clean up phantom channel on target control failure.', acceptanceCriteria: ['Zero phantom channels'], deliveryEvidence: [], allowedTransitions: ['in-progress', 'close'] },
      { ticketId: 'T-203', workspaceId: 'ws-beta', title: 'Beta: Adaptive width lease release', status: 'review', assigneeId: 'b-3', reviewerId: 'b-1', priority: 'medium', description: 'Release width lease when last holder detaches.', acceptanceCriteria: ['Lease released'], deliveryEvidence: ['unit test'], allowedTransitions: ['close', 'reopen'] },
    ],
    'ws-gamma': [
      { ticketId: 'T-301', workspaceId: 'ws-gamma', title: 'Gamma: Static prototype visual token alignment', status: 'in-progress', assigneeId: 'g-1', reviewerId: 'g-2', priority: 'high', description: 'Align sidebar hierarchy and forest green tokens.', acceptanceCriteria: ['Sidebar 3 zones'], deliveryEvidence: [], allowedTransitions: ['review', 'close'] },
    ],
    'ws-delta': [
      { ticketId: 'T-401', workspaceId: 'ws-delta', title: 'Delta: Portrait & narrow window auto adaptation', status: 'open', assigneeId: 'd-1', reviewerId: 'd-2', priority: 'medium', description: 'Auto-switch to 2D preview without manual buttons.', acceptanceCriteria: ['No manual Desktop/Mobile button'], deliveryEvidence: [], allowedTransitions: ['in-progress', 'review'] },
    ],
  }
  return (byWorkspace[workspaceId] || byWorkspace['ws-alpha']).map((item) => ({ ...item }))
}

export function createDemoGoals(workspaceId = 'ws-alpha') {
  const byWorkspace = {
    'ws-alpha': [
      { goalId: 'goal-alpha-webui', workspaceId: 'ws-alpha', title: 'Alpha Goal: Deliver V2 WebUI Milestone', status: 'in-progress', ownerMemberId: 'm-1', ticketCount: 2, updatedAt: nowIso() },
      { goalId: 'goal-alpha-layout', workspaceId: 'ws-alpha', title: 'Alpha Goal: Stabilize 1+4 multi-window layout', status: 'review', ownerMemberId: 'm-2', ticketCount: 1, updatedAt: nowIso() },
    ],
    'ws-beta': [
      { goalId: 'goal-beta-daemon', workspaceId: 'ws-beta', title: 'Beta Goal: Daemon & Transport Isolation', status: 'in-progress', ownerMemberId: 'b-1', ticketCount: 3, updatedAt: nowIso() },
    ],
    'ws-gamma': [
      { goalId: 'goal-gamma-ux', workspaceId: 'ws-gamma', title: 'Gamma Goal: UX Prototype Fidelity', status: 'in-progress', ownerMemberId: 'g-1', ticketCount: 1, updatedAt: nowIso() },
    ],
    'ws-delta': [
      { goalId: 'goal-delta-mobile', workspaceId: 'ws-delta', title: 'Delta Goal: Narrow Viewport Adaptation', status: 'open', ownerMemberId: 'd-1', ticketCount: 1, updatedAt: nowIso() },
    ],
  }
  return (byWorkspace[workspaceId] || byWorkspace['ws-alpha']).map((item) => ({ ...item }))
}

export function createDemoPorts() {
  const workspaces = DEFAULT_WORKSPACES.map((workspace) => ({ ...workspace }))
  const membersByWorkspace = new Map([
    ['ws-alpha', createDemoMembers('m', 'ws-alpha')],
    ['ws-beta', createDemoMembers('b', 'ws-beta')],
    ['ws-gamma', createDemoMembers('g', 'ws-gamma').slice(0, 3)],
    ['ws-delta', createDemoMembers('d', 'ws-delta').slice(0, 2)],
  ])
  const ticketsByWorkspace = new Map([
    ['ws-alpha', createDemoTickets('ws-alpha')],
    ['ws-beta', createDemoTickets('ws-beta')],
    ['ws-gamma', createDemoTickets('ws-gamma')],
    ['ws-delta', createDemoTickets('ws-delta')],
  ])
  const goalsByWorkspace = new Map([
    ['ws-alpha', createDemoGoals('ws-alpha')],
    ['ws-beta', createDemoGoals('ws-beta')],
    ['ws-gamma', createDemoGoals('ws-gamma')],
    ['ws-delta', createDemoGoals('ws-delta')],
  ])
  const propertiesByMember = new Map()
  const terminalHandles = new Map()
  const delayByWorkspace = new Map()
  const forbiddenWorkspaces = new Set()
  const calls = {
    listWorkspaces: [],
    getWorkspaceSnapshot: [],
    listTickets: [],
    createTicket: [],
    transitionTicket: [],
    listGoals: [],
    createGoal: [],
  }
  let authFailure = false
  let offline = false

  for (const members of membersByWorkspace.values()) {
    for (const member of members) {
      propertiesByMember.set(member.memberId, {
        role: member.role,
        description: `${member.name} member profile`,
        cwd: '/workspace/zterm',
        envSummary: 'TERM=xterm-256color',
        connectionRef: member.machine,
        workspaceBinding: member.workspaceId,
      })
    }
  }

  async function waitWorkspaceDelay(workspaceId) {
    const gate = delayByWorkspace.get(workspaceId)
    if (gate && typeof gate.then === 'function') {
      await gate
    }
  }

  function assertWorkspaceAccess(workspaceId) {
    if (authFailure) {
      throw { code: 'AUTH_INVALID_TOKEN', category: 'auth', status: 401, message: 'Auth token is invalid' }
    }
    if (offline) {
      throw { code: 'DAEMON_OFFLINE', category: 'connection', message: 'Daemon is offline', retryable: true }
    }
    if (!workspaceId) {
      throw { code: 'WORKSPACE_SELECTION_REQUIRED', category: 'validation', message: 'workspaceId is required' }
    }
    if (forbiddenWorkspaces.has(workspaceId)) {
      throw { code: 'AUTH_FORBIDDEN', category: 'auth', status: 403, message: `Access to workspace ${workspaceId} is forbidden` }
    }
    const workspace = workspaces.find((item) => item.workspaceId === workspaceId)
    if (!workspace) {
      throw { code: 'WORKSPACE_NOT_FOUND', category: 'not-found', status: 404, message: `Workspace ${workspaceId} not found` }
    }
    return workspace
  }

  const daemonApi = {
    calls,
    async listWorkspaces() {
      calls.listWorkspaces.push({})
      if (authFailure) throw { code: 'AUTH_INVALID_TOKEN', category: 'auth', status: 401, message: 'Auth token is invalid' }
      return workspaces.map((workspace) => ({ ...workspace }))
    },
    async getWorkspaceSnapshot({ workspaceId } = {}) {
      calls.getWorkspaceSnapshot.push({ workspaceId })
      await waitWorkspaceDelay(workspaceId)
      const workspace = assertWorkspaceAccess(workspaceId)
      const members = membersByWorkspace.get(workspaceId) || []
      return {
        workspace: { ...workspace },
        members: members.map((member) => ({ ...member })),
      }
    },
    async getMemberProperties({ memberId }) {
      if (authFailure) throw { code: 'AUTH_INVALID_TOKEN', category: 'auth', status: 401, message: 'Auth token is invalid' }
      const properties = propertiesByMember.get(memberId)
      if (!properties) throw { code: 'MEMBER_PROPERTIES_NOT_FOUND', category: 'not-found', message: 'Member properties not found' }
      return { ...properties }
    },
    async updateMemberProperties({ memberId, patch }) {
      const current = propertiesByMember.get(memberId) || {}
      const next = { ...current, ...patch }
      propertiesByMember.set(memberId, next)
      return { ...next }
    },
    async getBootstrap() {
      if (authFailure) throw { code: 'AUTH_INVALID_TOKEN', category: 'auth', status: 401, message: 'Auth token is invalid' }
      return { accountName: 'local-operator', deviceName: 'this-mac', daemonUrl: 'http://127.0.0.1:7419', configured: true }
    },
    async listTickets({ workspaceId, status } = {}) {
      calls.listTickets.push({ workspaceId, status })
      await waitWorkspaceDelay(workspaceId)
      assertWorkspaceAccess(workspaceId)
      const list = (ticketsByWorkspace.get(workspaceId) || []).map((item) => ({ ...item }))
      if (status && status !== 'all') {
        return list.filter((item) => String(item.status || '').toLowerCase() === String(status).toLowerCase())
      }
      return list
    },
    async createTicket({ workspaceId, title, description = '', priority = 'medium' } = {}) {
      calls.createTicket.push({ workspaceId, title, description, priority })
      assertWorkspaceAccess(workspaceId)
      const list = ticketsByWorkspace.get(workspaceId) || []
      const created = {
        ticketId: `T-${workspaceId.toUpperCase()}-${list.length + 1}`,
        workspaceId,
        title: String(title || 'Untitled ticket'),
        description: String(description || ''),
        status: 'open',
        priority,
        assigneeId: (membersByWorkspace.get(workspaceId) || [])[0]?.memberId || '',
        reviewerId: '',
        acceptanceCriteria: ['Scoped to ' + workspaceId],
        deliveryEvidence: [],
        allowedTransitions: ['in-progress', 'review', 'close'],
      }
      ticketsByWorkspace.set(workspaceId, [created, ...list])
      return { ...created }
    },
    async reportTicket(payload = {}) {
      return this.createTicket(payload)
    },
    async transitionTicket({ workspaceId, ticketId, transition } = {}) {
      calls.transitionTicket.push({ workspaceId, ticketId, transition })
      assertWorkspaceAccess(workspaceId)
      const list = ticketsByWorkspace.get(workspaceId) || []
      const targetTicket = list.find((item) => item.ticketId === ticketId)
      if (!targetTicket) {
        throw { code: 'TICKET_NOT_FOUND', category: 'not-found', message: `Ticket ${ticketId} not found in ${workspaceId}` }
      }
      if (Array.isArray(targetTicket.allowedTransitions) && !targetTicket.allowedTransitions.includes(transition)) {
        throw { code: 'TICKET_ILLEGAL_TRANSITION', category: 'validation', message: `Illegal transition ${transition} for ticket ${ticketId}` }
      }
      const statusMap = { close: 'closed', reopen: 'open', review: 'review', start: 'in-progress', block: 'blocked' }
      const nextStatus = statusMap[transition] || transition || 'review'
      let updated = null
      const nextList = list.map((item) => {
        if (item.ticketId === ticketId) {
          updated = { ...item, status: nextStatus, workspaceId }
          return updated
        }
        return item
      })
      ticketsByWorkspace.set(workspaceId, nextList)
      return { ...updated }
    },
    async listGoals({ workspaceId } = {}) {
      calls.listGoals.push({ workspaceId })
      await waitWorkspaceDelay(workspaceId)
      assertWorkspaceAccess(workspaceId)
      return (goalsByWorkspace.get(workspaceId) || []).map((item) => ({ ...item }))
    },
    async createGoal({ workspaceId, title } = {}) {
      calls.createGoal.push({ workspaceId, title })
      assertWorkspaceAccess(workspaceId)
      const list = goalsByWorkspace.get(workspaceId) || []
      const created = {
        goalId: `goal-${workspaceId}-${list.length + 1}`,
        workspaceId,
        title: String(title || 'Workspace Goal'),
        status: 'in-progress',
        ownerMemberId: (membersByWorkspace.get(workspaceId) || [])[0]?.memberId || '',
        ticketCount: 0,
        updatedAt: nowIso(),
      }
      goalsByWorkspace.set(workspaceId, [created, ...list])
      return { ...created }
    },
    setAuthFailure(value) {
      authFailure = Boolean(value)
    },
    setOffline(value) {
      offline = Boolean(value)
    },
    setWorkspaceForbidden(workspaceId, forbidden = true) {
      if (forbidden) forbiddenWorkspaces.add(workspaceId)
      else forbiddenWorkspaces.delete(workspaceId)
    },
    setWorkspaceDelay(workspaceId, promiseOrNull) {
      if (promiseOrNull) delayByWorkspace.set(workspaceId, promiseOrNull)
      else delayByWorkspace.delete(workspaceId)
    },
    setMemberStatus(workspaceId, memberId, status) {
      const members = membersByWorkspace.get(workspaceId) || []
      const member = members.find((entry) => entry.memberId === memberId)
      if (member) {
        member.status = status
        member.freshness = ['online', 'busy'].includes(status) ? 'fresh' : 'stale'
      }
      return members.map((entry) => ({ ...entry }))
    },
  }

  const terminalClient = {
    async attachSession(member) {
      if (terminalHandles.has(member.memberId)) return terminalHandles.get(member.memberId)
      const handle = {
        handleId: `handle-${member.memberId}`,
        memberId: member.memberId,
        sessionId: member.sessionId,
        status: 'attached',
        disconnectCalls: 0,
        createCalls: 1,
        writes: 0,
        resizeCalls: 0,
        renderViewportHtml(targetMember) {
          return `<div class="terminal-toolbar"><span>${esc(targetMember.name || targetMember.memberId)}</span><span>${esc(targetMember.status || 'unknown')}</span></div><pre>${esc(targetMember.name || targetMember.memberId)}@${esc(targetMember.machine || 'machine')}:~$\nline 1: session ready (${esc(targetMember.workspaceId || 'ws')})\nline 2: output stream\nline 3: scroll inside terminal\nline 4: without switching member\nline 5: active prompt</pre>`
        },
        getSnapshot() {
          return {
            handleId: this.handleId,
            memberId: this.memberId,
            sessionId: this.sessionId,
            status: this.status,
            disconnectCalls: this.disconnectCalls,
            createCalls: this.createCalls,
            writes: this.writes,
            resizeCalls: this.resizeCalls,
          }
        },
        writeInput(data) {
          this.writes += 1
          this.lastInput = data
          return { ok: true, handleId: this.handleId, memberId: this.memberId, echoedAt: nowIso() }
        },
        disconnect() {
          this.disconnectCalls += 1
          this.status = 'disconnected'
          return { ok: true }
        },
      }
      terminalHandles.set(member.memberId, handle)
      return handle
    },
    async createSession(member) {
      return this.attachSession(member)
    },
    async writeInput(handle, data) {
      return handle.writeInput(data)
    },
    async disconnect(handle) {
      return handle.disconnect()
    },
  }

  const deliveryClient = {
    async submitMessage(payload) {
      if (payload?.forceError) throw { code: 'DELIVERY_TRANSPORT_FAILED', category: 'delivery', message: 'Delivery transport failed', retryable: true }
      return {
        receiptId: `receipt-${payload.recipientMemberId}-${Date.now()}`,
        state: 'queued',
        durableStage: 'accepted',
        outcome: 'pending',
        target: { workspaceId: payload.workspaceId, memberId: payload.recipientMemberId },
        message: payload.body,
        observedAt: nowIso(),
      }
    },
    async offerFileTransfer(payload) {
      return {
        transferId: `transfer-${Date.now()}`,
        state: 'offered',
        fileName: payload.fileName,
        target: { workspaceId: payload.workspaceId, memberId: payload.recipientMemberId },
        observedAt: nowIso(),
      }
    },
  }

  return { daemonApi, terminalClient, deliveryClient }
}

export function createDemoWebUIApp(options = {}) {
  const demoPorts = createDemoPorts()
  const app = createWebUIApp({
    daemonApi: options.daemonApi ?? demoPorts.daemonApi,
    terminalClient: options.terminalClient ?? demoPorts.terminalClient,
    deliveryClient: options.deliveryClient ?? demoPorts.deliveryClient,
    ...options,
  })

  app.triggerAuthFailure = async function triggerAuthFailure() {
    if (typeof app.ports.daemonApi?.setAuthFailure === 'function') {
      app.ports.daemonApi.setAuthFailure(true)
    }
    await app.loadWorkspace(app.state.activeWorkspaceId || 'ws-alpha')
    await app.navigate('connections')
    return app
  }

  app.triggerStaleStatus = async function triggerStaleStatus() {
    const memberId = app.state.members[1]?.memberId || app.state.members[0]?.memberId
    if (typeof app.ports.daemonApi?.setMemberStatus === 'function' && memberId) {
      const members = app.ports.daemonApi.setMemberStatus(app.state.activeWorkspaceId, memberId, 'stale')
      app.state.members = members
      app.state.membersLoadable = { status: 'ready', value: members, observedAt: nowIso(), freshness: 'fresh', error: null }
      if (app.state.activeWorkspaceId && app.state.workspaceDataById?.has(app.state.activeWorkspaceId)) {
        const entry = app.state.workspaceDataById.get(app.state.activeWorkspaceId)
        entry.members = members
        entry.membersLoadable = app.state.membersLoadable
      }
      app.sessionController.syncWorkspaceMembers(app.state.activeWorkspaceId, members)
      if (app.state.layout) {
        app.state.layout.members = members
        app.state.layout.memberSlots = (app.state.layout.memberSlots || []).map((slot) =>
          slot.memberId === memberId ? { ...slot, stale: true, staleReason: 'Member marked stale' } : slot
        )
      }
      app.render()
    }
    return app
  }

  app.triggerUnknownStateWrite = async function triggerUnknownStateWrite() {
    const memberId = app.state.members[2]?.memberId || app.state.members[0]?.memberId
    if (typeof app.ports.daemonApi?.setMemberStatus === 'function' && memberId) {
      const members = app.ports.daemonApi.setMemberStatus(app.state.activeWorkspaceId, memberId, 'unknown')
      app.state.members = members
      app.state.membersLoadable = { status: 'ready', value: members, observedAt: nowIso(), freshness: 'fresh', error: null }
      if (app.state.activeWorkspaceId && app.state.workspaceDataById?.has(app.state.activeWorkspaceId)) {
        const entry = app.state.workspaceDataById.get(app.state.activeWorkspaceId)
        entry.members = members
        entry.membersLoadable = app.state.membersLoadable
      }
      app.sessionController.syncWorkspaceMembers(app.state.activeWorkspaceId, members)
      if (app.state.layout) app.state.layout.members = members
    }
    try {
      await app.sendMessage(memberId, 'Unknown-state probe')
    } catch (error) {
      app.state.lastError = normalizeTypedError(error, 'DELIVERY_TARGET_UNKNOWN_STATE')
      app.render()
    }
    return app
  }

  return app
}
