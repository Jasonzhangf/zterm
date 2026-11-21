const HEALTHY_STATUSES = Object.freeze(['attached', 'ready', 'online'])
const WRITE_BLOCKED_STATUSES = Object.freeze([
  'unknown',
  'stale',
  'offline',
  'unavailable',
])
const VISIBLE_PEER_SLOT_COUNT = 4

function nowIso() {
  return new Date().toISOString()
}

function normalizeTypedError(error, fallbackCode = 'SESSION_UNAVAILABLE') {
  if (error && typeof error === 'object') {
    return {
      code: String(error.code || fallbackCode),
      category: String(error.category || 'session'),
      message: String(error.message || 'Session operation is unavailable'),
      retryable: error.retryable === true,
      details: error.details ?? null,
    }
  }
  return {
    code: fallbackCode,
    category: 'session',
    message: String(error || 'Session operation is unavailable'),
    retryable: false,
    details: null,
  }
}

function isAuthError(error) {
  if (!error || typeof error !== 'object') return false
  const code = String(error.code || '')
  const category = String(error.category || '')
  const status = String(error.status || '')
  return (
    code === 'AUTH_INVALID_TOKEN' ||
    status === '401' ||
    category === 'auth' ||
    /auth/i.test(code) ||
    /401/i.test(String(error.message || ''))
  )
}

function defaultLayoutStore() {
  const layouts = new Map()
  return {
    async loadLayout(accountId, workspaceId, members) {
      const key = `${accountId}::${workspaceId}`
      let layout = layouts.get(key)
      if (!layout) {
        layout = {
          accountId,
          workspaceId,
          members,
          primaryMemberId: members[0]?.memberId ?? null,
          peerMemberIds: members.slice(1).map((m) => m.memberId),
          mobileMode: 'preview',
          focusedMemberId: members[0]?.memberId ?? null,
          previewViewport: { zoom: 1, panX: 0, panY: 0 },
          windowSizes: {},
          openPropertyByWindow: {},
        }
        layouts.set(key, layout)
      }
      return layout
    },
    async saveLayout(layout) {
      const key = `${layout.accountId}::${layout.workspaceId}`
      layouts.set(key, layout)
      return layout
    },
    async updateLayout(accountId, workspaceId, updater) {
      const key = `${accountId}::${workspaceId}`
      const layout = layouts.get(key) || { accountId, workspaceId, members: [] }
      const next = updater(layout)
      layouts.set(key, next)
      return next
    },
  }
}

export function createSessionController({
  daemonApi = null,
  terminalClient = null,
  deliveryClient = null,
  terminalViewportFactory = null,
  layoutStore = null,
  accountId = 'acc-default',
} = {}) {
  const tc = terminalClient
  const dc = deliveryClient
  const ls = layoutStore ?? defaultLayoutStore()

  const terminalHandlesByMemberId = new Map()
  const terminalViewportsByWindowId = new Map()
  const memberStatesByMemberId = new Map()
  const operationReceiptsByTarget = new Map() // `${workspaceId}::${recipientMemberId}` -> receipt
  let workspaceLoadable = { status: 'loading', value: null, observedAt: null, freshness: 'loading', error: null }
  let layoutByWorkspace = new Map()
  let lastOperationError = null
  let activeWorkspaceId = null
  const attachRequestsByWorkspaceId = new Map()
  // Focus-bound attach and visible-set attach are both legitimate callers.
  // Remember the active strategy so a focus layout change replays the same
  // strategy instead of silently switching between the two.
  const attachModeByWorkspaceId = new Map()

  function isHealthyMember(member) {
    if (!member) return false
    const handle = terminalHandlesByMemberId.get(member.memberId)
    if (handle && HEALTHY_STATUSES.includes(handle.status)) return true
    return HEALTHY_STATUSES.includes(member.status)
  }

  function isWriteBlocked(member) {
    if (!member) return true
    if (WRITE_BLOCKED_STATUSES.includes(member.status)) return true
    const handle = terminalHandlesByMemberId.get(member.memberId)
    if (handle && !HEALTHY_STATUSES.includes(handle.status)) return true
    return false
  }

  function memberState(memberId) {
    if (!memberStatesByMemberId.has(memberId)) memberStatesByMemberId.set(memberId, { memberId, receipts: [], errors: [] })
    return memberStatesByMemberId.get(memberId)
  }

  function typedMemberState(memberId) {
    const s = memberState(memberId)
    return {
      memberId,
      receipts: [...s.receipts],
      errors: [...s.errors],
      lastError: s.errors[s.errors.length - 1] ?? null,
    }
  }

  function snapshot() {
    return {
      accountId,
      workspaceLoadable,
      terminalHandlesByMemberId: [...terminalHandlesByMemberId.entries()].map(([memberId, handle]) => [
        memberId,
        handle.getSnapshot ? handle.getSnapshot() : { memberId, handleId: handle.handleId, sessionId: handle.sessionId, status: handle.status },
      ]),
      memberStates: [...memberStatesByMemberId.entries()].map(([memberId]) => typedMemberState(memberId)),
      lastOperationError,
    }
  }

  function setWorkspaceLoadable(value, error) {
    workspaceLoadable = {
      status: error ? 'unavailable' : value ? 'ready' : 'loading',
      value,
      error: error ? normalizeTypedError(error) : null,
      observedAt: nowIso(),
      freshness: error ? 'unavailable' : value ? 'fresh' : 'loading',
    }
  }

  async function loadWorkspaceSessions(workspaceId) {
    activeWorkspaceId = workspaceId
    setWorkspaceLoadable(null)
    lastOperationError = null

    for (const handle of terminalHandlesByMemberId.values()) {
      if (handle.workspaceId && handle.workspaceId !== workspaceId) {
        await suspendTerminalHandle(handle)
      }
    }

    if (
      !daemonApi ||
      typeof daemonApi.getWorkspaceSnapshot !== 'function'
    ) {
      const typedError = normalizeTypedError({
        code: 'DAEMON_API_UNAVAILABLE',
        category: 'connection',
        message: 'Daemon API port is not configured.',
        retryable: true,
      }, 'DAEMON_API_UNAVAILABLE')
      lastOperationError = typedError
      setWorkspaceLoadable(null, typedError)
      return snapshot()
    }

    let workspace
    let members
    let groups

    try {
      const workspaceSnapshot = await daemonApi.getWorkspaceSnapshot({ workspaceId })
      workspace = workspaceSnapshot.workspace
      members = workspaceSnapshot.members
      groups = workspaceSnapshot.groups
    } catch (error) {
      if (isAuthError(error)) {
        setWorkspaceLoadable(null, error)
      } else {
        setWorkspaceLoadable(null, error)
      }
      return snapshot()
    }

    const memberArray = Array.isArray(members) ? members : []
    let layout
    try {
      layout = await ls.loadLayout(accountId, workspaceId, memberArray)
    } catch {
      layout = {
        accountId,
        workspaceId,
        members: memberArray,
        primaryMemberId: memberArray[0]?.memberId ?? null,
        peerMemberIds: memberArray.slice(1).map((m) => m.memberId),
        mobileMode: 'preview',
        focusedMemberId: memberArray[0]?.memberId ?? null,
        previewViewport: { zoom: 1, panX: 0, panY: 0 },
        windowSizes: {},
        openPropertyByWindow: {},
      }
    }

    layout.members = memberArray
    layoutByWorkspace.set(workspaceId, layout)
    setWorkspaceLoadable({
      workspace,
      members: memberArray,
      groups: Array.isArray(groups) ? groups : [],
      layout,
    })

    return snapshot()
  }

  function defaultFocusedMemberId(layout, members) {
    if (layout && layout.focusedMemberId && members.some((member) => member.memberId === layout.focusedMemberId)) {
      return layout.focusedMemberId
    }
    return layout?.primaryMemberId || members[0]?.memberId || null
  }

  function currentFocusedMemberId(workspaceId) {
    const layout = layoutByWorkspace.get(workspaceId)
    return defaultFocusedMemberId(layout, layout?.members || [])
  }

  async function suspendTerminalHandle(handle) {
    if (!handle || !tc || typeof tc.suspend !== 'function') return
    try {
      await tc.suspend(handle)
    } catch (error) {
      const typedError = normalizeTypedError(error, 'TERMINAL_SUSPEND_FAILED')
      lastOperationError = typedError
      const s = memberState(handle.memberId)
      s.errors.push({ ...typedError, operation: 'suspendTerminalHandle', observedAt: nowIso() })
    }
  }

  async function resumeTerminalHandle(handle) {
    if (!handle || !tc || typeof tc.resume !== 'function') return
    try {
      await tc.resume(handle)
    } catch (error) {
      const typedError = normalizeTypedError(error, 'TERMINAL_RESUME_FAILED')
      lastOperationError = typedError
      const s = memberState(handle.memberId)
      s.errors.push({ ...typedError, operation: 'resumeTerminalHandle', observedAt: nowIso() })
    }
  }

  async function disconnectTerminalHandle(handle) {
    if (!handle || !tc || typeof tc.disconnect !== 'function') return
    try {
      await tc.disconnect(handle)
    } catch (error) {
      const typedError = normalizeTypedError(error, 'TERMINAL_DISCONNECT_FAILED')
      lastOperationError = typedError
      const s = memberState(handle.memberId)
      s.errors.push({ ...typedError, operation: 'disconnectTerminalHandle', observedAt: nowIso() })
    }
  }

  function handleMatchesMemberTarget(handle, member) {
    if (!handle || !member) return false
    const expectedSessionId = String(member.sessionId || member.name || '')
    if (String(handle.sessionId || '') !== expectedSessionId) return false
    if (handle.workspaceId && member.workspaceId && handle.workspaceId !== member.workspaceId) {
      return false
    }
    return true
  }

  async function ensureTerminalHandle(member, ownership = null) {
    const memberId = member.memberId
    let existing = terminalHandlesByMemberId.get(memberId)
    if (existing && !handleMatchesMemberTarget(existing, member)) {
      await disconnectTerminalHandle(existing)
      terminalHandlesByMemberId.delete(memberId)
      existing = null
    }
    if (existing && HEALTHY_STATUSES.includes(existing.status)) {
      if (ownership && !ownership()) {
        await suspendTerminalHandle(existing)
        return null
      }
      return existing
    }

    const blocked = WRITE_BLOCKED_STATUSES.includes(member.status)
    if (blocked && !existing) {
      return null
    }

    if (!tc || typeof tc.attachSession !== 'function') {
      const typedError = normalizeTypedError({
        code: 'TERMINAL_CLIENT_UNAVAILABLE',
        category: 'terminal',
        message: 'Terminal client port is not configured.',
        retryable: true,
      }, 'TERMINAL_CLIENT_UNAVAILABLE')
      lastOperationError = typedError
      const s = memberState(memberId)
      s.errors.push({ ...typedError, operation: 'ensureTerminalHandle', observedAt: nowIso() })
      return null
    }

    let handle
    try {
      handle = await tc.attachSession(member)
    } catch (error) {
      if (typeof tc.createSession === 'function') {
        try {
          handle = await tc.createSession(member)
        } catch (createError) {
          const typedError = normalizeTypedError(createError, 'TERMINAL_ATTACH_FAILED')
          lastOperationError = typedError
          const s = memberState(memberId)
          s.errors.push({ ...typedError, operation: 'ensureTerminalHandle', observedAt: nowIso() })
          throw typedError
        }
      } else {
        const typedError = normalizeTypedError(error, 'TERMINAL_ATTACH_FAILED')
        lastOperationError = typedError
        const s = memberState(memberId)
        s.errors.push({ ...typedError, operation: 'ensureTerminalHandle', observedAt: nowIso() })
        throw typedError
      }
    }

    if (ownership && !ownership()) {
      await suspendTerminalHandle(handle)
      return null
    }

    if (!handle || typeof handle !== 'object') {
      const typedError = normalizeTypedError({
        code: 'TERMINAL_HANDLE_INVALID',
        category: 'terminal',
        message: 'Terminal client did not return a valid session handle.',
        retryable: true,
      }, 'TERMINAL_HANDLE_INVALID')
      lastOperationError = typedError
      const s = memberState(memberId)
      s.errors.push({ ...typedError, operation: 'ensureTerminalHandle', observedAt: nowIso() })
      return null
    }

    handle.memberId = memberId
    handle.workspaceId = ownership?.workspaceId || member.workspaceId || null
    terminalHandlesByMemberId.set(memberId, handle)
    return handle
  }

  async function suspendInactiveTerminalHandles(workspaceId, activeMemberId) {
    const handles = [...terminalHandlesByMemberId.values()].filter((handle) =>
      handle.memberId !== activeMemberId || (handle.workspaceId && handle.workspaceId !== workspaceId)
    )

    for (const handle of handles) {
      await suspendTerminalHandle(handle)
    }
  }

  function resolveVisibleMemberIds(workspaceId, requestedMemberIds = null) {
    const layout = layoutByWorkspace.get(workspaceId)
    const members = layout?.members || []
    if (!layout) return []
    const available = new Set(members.map((member) => String(member.memberId)))
    const requested = Array.isArray(requestedMemberIds)
      ? requestedMemberIds
      : [
          layout.primaryMemberId,
          ...(layout.peerMemberIds || []).slice(0, VISIBLE_PEER_SLOT_COUNT),
        ]
    return [...new Set(requested.map(String).filter((memberId) => available.has(memberId)))]
  }

  async function attachMembers(workspaceId, requestedMemberIds = null, { resumeInactive = true } = {}) {
    const layout = layoutByWorkspace.get(workspaceId)
    const members = layout?.members || []
    const visibleMemberIds = resolveVisibleMemberIds(workspaceId, requestedMemberIds)
    if (visibleMemberIds.length === 0) {
      for (const handle of terminalHandlesByMemberId.values()) {
        await suspendTerminalHandle(handle)
      }
      return []
    }

    const requestKey = visibleMemberIds.join('\u0000')
    const pendingRequest = attachRequestsByWorkspaceId.get(workspaceId)
    if (pendingRequest && pendingRequest.requestKey === requestKey && pendingRequest.promise) {
      return pendingRequest.promise
    }

    const visibleMemberIdSet = new Set(visibleMemberIds)
    const request = { workspaceId, visibleMemberIds, requestKey, promise: null }
    const isCurrentRequest = () =>
      attachRequestsByWorkspaceId.get(workspaceId) === request &&
      activeWorkspaceId === workspaceId
    const ownsMember = (memberId) =>
      isCurrentRequest() && visibleMemberIdSet.has(memberId)
    attachRequestsByWorkspaceId.set(workspaceId, request)
    request.promise = (async () => {
      const attached = await Promise.all(visibleMemberIds.map(async (memberId) => {
        const member = members.find((candidate) => String(candidate.memberId) === memberId)
        if (!member) return null
        try {
          return await ensureTerminalHandle(member, () => ownsMember(memberId))
        } catch {
          return null
        }
      }))
      if (!isCurrentRequest()) return []

      const handles = new Map()
      for (const handle of attached) {
        if (handle) handles.set(String(handle.memberId), handle)
      }

      for (const [memberId, handle] of terminalHandlesByMemberId.entries()) {
        if (!visibleMemberIdSet.has(String(memberId))) {
          await suspendTerminalHandle(handle)
        }
      }

      const activeHandles = []
      for (const memberId of visibleMemberIds) {
        const handle = handles.get(memberId) || terminalHandlesByMemberId.get(memberId)
        if (!handle) continue
        const isActive = typeof handle.isBodyActive === 'function' ? handle.isBodyActive() : true
        if (!isActive && resumeInactive) await resumeTerminalHandle(handle)
        activeHandles.push(handle)
      }
      return activeHandles
    })()

    try {
      return await request.promise
    } finally {
      if (attachRequestsByWorkspaceId.get(workspaceId) === request) {
        attachRequestsByWorkspaceId.delete(workspaceId)
      }
    }
  }

  async function attachVisibleMembers(workspaceId, requestedMemberIds = null) {
    const visibleMemberIds = resolveVisibleMemberIds(workspaceId, requestedMemberIds)
    attachModeByWorkspaceId.set(workspaceId, { kind: 'visible', memberIds: visibleMemberIds })
    return attachMembers(workspaceId, visibleMemberIds)
  }

  async function attachFocusedMember(workspaceId) {
    const layout = layoutByWorkspace.get(workspaceId)
    const members = layout?.members || []
    const memberId = defaultFocusedMemberId(layout, members)
    if (!memberId) return null
    if (layout && layout.focusedMemberId !== memberId) {
      layout.focusedMemberId = memberId
    }
    attachModeByWorkspaceId.set(workspaceId, { kind: 'focused', memberId })
    // Focused attach owns the focused handle's activation. Passing
    // resumeInactive=false keeps attachMembers from resuming it a second time
    // before the explicit focus resume below.
    const handles = await attachMembers(workspaceId, [memberId], { resumeInactive: false })
    const handle = handles[0] || null
    // Focus is an explicit intent: re-assert the focused body even when a
    // freshly attached renderer already reports itself active.
    if (handle) await resumeTerminalHandle(handle)
    return handle
  }

  async function applyLayoutOperation(workspaceId, operation) {
    const layout = layoutByWorkspace.get(workspaceId)
    if (!layout) {
      return { ok: false, error: normalizeTypedError(new Error(`Unknown workspace ${workspaceId}`), 'LAYOUT_UNKNOWN') }
    }

    const kind = operation.kind
    if (kind === 'dragBorder') {
      const { edge, deltaX = 0, deltaY = 0, windowId, rowIndex = 0, containerWidth = 1280 } = operation
      if (windowId === 'window-primary' && (edge === 'e' || edge === 'w')) {
        const ratio = Number(layout.primaryRatio ?? 0.42) + deltaX / containerWidth
        layout.primaryRatio = Math.min(0.72, Math.max(0.24, ratio))
      } else if (windowId && (edge === 'e' || edge === 'w')) {
        layout.windowSizes = layout.windowSizes || {}
        const current = layout.windowSizes[windowId] || { widthPx: 360, heightPx: 300 }
        layout.windowSizes[windowId] = {
          widthPx: Math.max(180, current.widthPx + deltaX),
          heightPx: Math.max(120, current.heightPx + deltaY),
        }
      } else if (edge === 'e') {
        const ratio = Number(layout.primaryRatio ?? 0.42) + deltaX / containerWidth
        layout.primaryRatio = Math.min(0.72, Math.max(0.24, ratio))
      } else if (edge === 's' || edge === 'n') {
        layout.peerRowHeights = layout.peerRowHeights || {}
        layout.peerRowHeights[rowIndex] = Math.max(120, (layout.peerRowHeights[rowIndex] || 220) + deltaY)
      }
    } else if (kind === 'togglePropertyDrawer') {
      const { windowId, forceOpen } = operation
      layout.openPropertyByWindow = layout.openPropertyByWindow || {}
      layout.openPropertyByWindow[windowId] = forceOpen !== undefined ? forceOpen : !layout.openPropertyByWindow[windowId]
    } else if (kind === 'switchMobileMode') {
      layout.mobileMode = operation.mobileMode === 'focus' ? 'focus' : 'preview'
    } else if (kind === 'enterMemberFocus') {
      layout.mobileMode = 'focus'
      if (operation.memberId) {
        layout.focusedMemberId = operation.memberId
      }
    } else if (kind === 'stepMobileFocus') {
      const direction = operation.direction === 'prev' ? 'prev' : 'next'
      const members = [layout.primaryMemberId, ...layout.peerMemberIds].filter(Boolean)
      if (members.length) {
        const currentIndex = members.indexOf(layout.focusedMemberId ?? members[0])
        let next = direction === 'next' ? currentIndex + 1 : currentIndex - 1
        if (next < 0) next = members.length - 1
        if (next >= members.length) next = 0
        layout.focusedMemberId = members[next]
        layout.mobileMode = 'focus'
      }
    } else if (kind === 'panZoomPreview') {
      layout.previewViewport = layout.previewViewport || { zoom: 1, panX: 0, panY: 0 }
      const { deltaX = 0, deltaY = 0, zoomFactor = 1 } = operation
      layout.previewViewport.panX += deltaX
      layout.previewViewport.panY += deltaY
      layout.previewViewport.zoom = Math.min(2.2, Math.max(0.5, layout.previewViewport.zoom * zoomFactor))
    } else if (kind === 'promotePrimary') {
      const { memberId } = operation
      const members = [layout.primaryMemberId, ...layout.peerMemberIds].filter(Boolean)
      const index = members.indexOf(memberId)
      if (index > 0) {
        members.splice(index, 1)
        layout.primaryMemberId = memberId
        layout.peerMemberIds = members
        if (!layout.focusedMemberId || layout.focusedMemberId === memberId) layout.focusedMemberId = memberId
      }
    } else if (kind === 'quickSwitchWorkspace') {
      layout.activeWorkspaceId = operation.workspaceId
      layoutByWorkspace.delete(workspaceId)
    } else {
      return { ok: false, error: normalizeTypedError(new Error(`Unknown layout operation ${kind}`), 'LAYOUT_OPERATION_UNKNOWN') }
    }

    try {
      await ls.saveLayout(layout)
    } catch (error) {
      return { ok: false, error: normalizeTypedError(error, 'LAYOUT_SAVE_FAILED') }
    }

    if (kind === 'enterMemberFocus' || kind === 'stepMobileFocus' || kind === 'promotePrimary') {
      const mode = attachModeByWorkspaceId.get(workspaceId)
      if (mode?.kind === 'focused') {
        await attachFocusedMember(workspaceId)
      } else if (mode?.kind === 'visible') {
        await attachVisibleMembers(workspaceId, mode.memberIds)
      }
    }

    return { ok: true, layout }
  }

  async function sendTerminalInput(memberId, data) {
    if (!tc || typeof tc.writeInput !== 'function') {
      const typedError = normalizeTypedError({
        code: 'TERMINAL_CLIENT_UNAVAILABLE',
        category: 'terminal',
        message: 'Terminal client port is not configured.',
        retryable: true,
      }, 'TERMINAL_CLIENT_UNAVAILABLE')
      lastOperationError = typedError
      const s = memberState(memberId)
      s.errors.push({ ...typedError, operation: 'sendTerminalInput', observedAt: nowIso() })
      throw typedError
    }

    const member = memberStatesByMemberId.get(memberId) ?? { memberId, status: 'unknown' }
    const daemonMember = getMemberRecord(memberId)
    const target = daemonMember || member
    if (isWriteBlocked(target)) {
      const typedError = normalizeTypedError(null, 'SESSION_TARGET_UNAVAILABLE')
      typedError.retryable = true
      lastOperationError = typedError
      const s = memberState(memberId)
      s.errors.push({ ...typedError, operation: 'sendTerminalInput', observedAt: nowIso() })
      throw typedError
    }
    const handle = terminalHandlesByMemberId.get(memberId)
    if (!handle) {
      const typedError = normalizeTypedError(null, 'SESSION_TARGET_UNAVAILABLE')
      typedError.retryable = true
      lastOperationError = typedError
      const s = memberState(memberId)
      s.errors.push({ ...typedError, operation: 'sendTerminalInput', observedAt: nowIso() })
      throw typedError
    }
    lastOperationError = null
    return tc.writeInput(handle, data).then((result) => {
      const s = memberState(memberId)
      s.receipts.push({ operation: 'sendTerminalInput', result, observedAt: nowIso() })
      return result
    })
  }

  async function sendMemberMessage({ workspaceId, senderMemberId, recipientMemberId, body } = {}) {
    const targetKey = `${workspaceId}::${recipientMemberId}`
    const daemonMember = getMemberRecord(recipientMemberId)
    const targetState = memberState(recipientMemberId)
    targetState.lastTarget = { workspaceId, recipientMemberId, senderMemberId, body, observedAt: nowIso() }

    if (!daemonMember || isWriteBlocked(daemonMember)) {
      const typedError = normalizeTypedError(null, 'DELIVERY_TARGET_UNKNOWN_STATE')
      typedError.retryable = true
      lastOperationError = typedError
      targetState.errors.push({ ...typedError, operation: 'sendMemberMessage', targetKey, observedAt: nowIso() })
      throw typedError
    }

    if (!dc || typeof dc.submitMessage !== 'function') {
      const typedError = normalizeTypedError({
        code: 'DELIVERY_CLIENT_UNAVAILABLE',
        category: 'delivery',
        message: 'Delivery client port is not configured.',
        retryable: true,
      }, 'DELIVERY_CLIENT_UNAVAILABLE')
      lastOperationError = typedError
      targetState.errors.push({ ...typedError, operation: 'sendMemberMessage', targetKey, observedAt: nowIso() })
      throw typedError
    }

    const handle = terminalHandlesByMemberId.get(recipientMemberId)
    if (handle && !HEALTHY_STATUSES.includes(handle.status)) {
      const typedError = normalizeTypedError(null, 'SESSION_TARGET_UNAVAILABLE')
      typedError.retryable = true
      lastOperationError = typedError
      targetState.errors.push({ ...typedError, operation: 'sendMemberMessage', targetKey, observedAt: nowIso() })
      throw typedError
    }

    const intent = { workspaceId, senderMemberId, recipientMemberId, body, sentAt: nowIso() }
    try {
      const receipt = await dc.submitMessage(intent)
      const stored = { ...receipt, targetKey, intent }
      operationReceiptsByTarget.set(targetKey, stored)
      targetState.receipts.push(stored)
      lastOperationError = null
      return stored
    } catch (error) {
      const typedError = normalizeTypedError(error, 'DELIVERY_TARGET_UNKNOWN_STATE')
      typedError.retryable = true
      lastOperationError = typedError
      targetState.errors.push({ ...typedError, operation: 'sendMemberMessage', targetKey, observedAt: nowIso() })
      throw typedError
    }
  }

  async function offerFileTransfer({ workspaceId, senderMemberId, recipientMemberId, fileName, totalBytes, mimeType } = {}) {
    const targetKey = `${workspaceId}::${recipientMemberId}`
    const daemonMember = getMemberRecord(recipientMemberId)
    const targetState = memberState(recipientMemberId)
    targetState.lastTarget = { workspaceId, recipientMemberId, senderMemberId, fileName, totalBytes, observedAt: nowIso() }

    if (!daemonMember || isWriteBlocked(daemonMember)) {
      const typedError = normalizeTypedError(null, 'DELIVERY_TARGET_UNKNOWN_STATE')
      typedError.retryable = true
      lastOperationError = typedError
      targetState.errors.push({ ...typedError, operation: 'offerFileTransfer', targetKey, observedAt: nowIso() })
      throw typedError
    }

    if (!dc || typeof dc.offerFileTransfer !== 'function') {
      const typedError = normalizeTypedError({
        code: 'DELIVERY_CLIENT_UNAVAILABLE',
        category: 'delivery',
        message: 'Delivery client port is not configured.',
        retryable: true,
      }, 'DELIVERY_CLIENT_UNAVAILABLE')
      lastOperationError = typedError
      targetState.errors.push({ ...typedError, operation: 'offerFileTransfer', targetKey, observedAt: nowIso() })
      throw typedError
    }

    try {
      const receipt = await dc.offerFileTransfer({ workspaceId, senderMemberId, recipientMemberId, fileName, totalBytes, mimeType, offeredAt: nowIso() })
      const stored = { ...receipt, targetKey }
      operationReceiptsByTarget.set(targetKey, stored)
      targetState.receipts.push(stored)
      lastOperationError = null
      return stored
    } catch (error) {
      const typedError = normalizeTypedError(error, 'DELIVERY_TARGET_UNKNOWN_STATE')
      typedError.retryable = true
      lastOperationError = typedError
      targetState.errors.push({ ...typedError, operation: 'offerFileTransfer', targetKey, observedAt: nowIso() })
      throw typedError
    }
  }

  async function saveProperty(memberId, patch) {
    const daemonMember = getMemberRecord(memberId)
    const targetState = memberState(memberId)
    if (!daemonMember || isWriteBlocked(daemonMember)) {
      const typedError = normalizeTypedError(null, 'SESSION_TARGET_UNAVAILABLE')
      typedError.retryable = true
      lastOperationError = typedError
      targetState.errors.push({ ...typedError, operation: 'saveProperty', memberId, observedAt: nowIso() })
      throw typedError
    }
    if (!daemonApi || typeof daemonApi.updateMemberProperties !== 'function') {
      const typedError = normalizeTypedError({
        code: 'DAEMON_API_UNAVAILABLE',
        category: 'connection',
        message: 'Daemon API port is not configured.',
        retryable: true,
      }, 'DAEMON_API_UNAVAILABLE')
      lastOperationError = typedError
      targetState.errors.push({ ...typedError, operation: 'saveProperty', memberId, observedAt: nowIso() })
      throw typedError
    }
    const saved = await daemonApi.updateMemberProperties({ memberId, patch })
    lastOperationError = null
    return { ok: true, memberId, patch: saved ?? patch, savedAt: nowIso() }
  }

  function dragBorder(workspaceId, detail = {}) {
    return applyLayoutOperation(workspaceId, { kind: 'dragBorder', ...detail })
  }

  function togglePropertyDrawer(workspaceId, detail = {}) {
    return applyLayoutOperation(workspaceId, { kind: 'togglePropertyDrawer', ...detail })
  }

  function switchMobileMode(workspaceId, detail = {}) {
    return applyLayoutOperation(workspaceId, { kind: 'switchMobileMode', ...detail })
  }

  function stepMobileFocus(workspaceId, detail = {}) {
    return applyLayoutOperation(workspaceId, { kind: 'stepMobileFocus', ...detail })
  }

  function panZoomPreview(workspaceId, detail = {}) {
    return applyLayoutOperation(workspaceId, { kind: 'panZoomPreview', ...detail })
  }

  function promotePrimary(workspaceId, detail = {}) {
    return applyLayoutOperation(workspaceId, { kind: 'promotePrimary', ...detail })
  }

  function quickSwitchWorkspace(workspaceId, detail = {}) {
    return applyLayoutOperation(workspaceId, { kind: 'quickSwitchWorkspace', ...detail })
  }

  function getMemberRecord(memberId) {
    const layout = [...layoutByWorkspace.values()].find((l) =>
      (l.members || []).some((m) => m.memberId === memberId)
    )
    if (layout) return (layout.members || []).find((m) => m.memberId === memberId) ?? null
    return null
  }

  function syncWorkspaceMembers(workspaceId, members = []) {
    const layout = layoutByWorkspace.get(workspaceId)
    if (layout) {
      layout.members = members
    }
    return layout
  }

  return {
    accountId,
    terminalClient: tc,
    deliveryClient: dc,
    terminalViewportFactory,
    layoutStore: ls,
    terminalHandlesByMemberId,
    terminalViewportsByWindowId,
    loadWorkspaceSessions,
    ensureTerminalHandle,
    attachFocusedMember,
    attachVisibleMembers,
    applyLayoutOperation,
    syncWorkspaceMembers,
    dragBorder,
    togglePropertyDrawer,
    switchMobileMode,
    stepMobileFocus,
    panZoomPreview,
    promotePrimary,
    quickSwitchWorkspace,
    sendTerminalInput,
    sendMemberMessage,
    offerFileTransfer,
    saveProperty,
    getState: snapshot,
    getWorkspaceLoadable: () => workspaceLoadable,
    getTerminalHandle: (memberId) => terminalHandlesByMemberId.get(memberId) ?? null,
    getMemberState: typedMemberState,
    getLastOperationError: () => lastOperationError,
    get workspaceLoadable() { return workspaceLoadable },
    get lastOperationError() { return lastOperationError },
  }
}

export { HEALTHY_STATUSES, WRITE_BLOCKED_STATUSES, normalizeTypedError }

