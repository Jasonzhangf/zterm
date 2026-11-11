import { createPropertyController } from '../controllers/property-controller.mjs'
import { createSessionController, HEALTHY_STATUSES, normalizeTypedError } from '../controllers/session-controller.mjs'
import { createDeliveryClient } from '../clients/delivery-client.mjs'
import {
  renderStatusBadge,
  renderErrorNotice,
  renderFormActions,
  renderWorkspaceTree,
  renderMemberPicker,
  renderMemberStatusList,
  renderWindowHeader,
  renderWindowFrame,
  renderPropertyPanel,
  renderGoalTicketList,
  renderTicketList,
  renderTicketDetail,
  renderDeliveryStatus,
} from '../components/index.mjs'
import {
  createLayoutStore,
  renderSplitLayout,
  renderSessionWorkbench,
  renderSessionPreviewCanvas,
  renderSessionFocusView,
  renderWorkspaceQuickSwitch,
} from '../features/sessions/index.mjs'
import {
  ROUTES,
  GLOBAL_ROUTES,
  WORKSPACE_ROUTES,
  isWorkspaceScopedRoute,
  parseNavigationTarget,
  resolveRoute,
  routeUrl,
} from './routes.mjs'
import { renderSetupPage } from '../pages/setup/index.mjs'
import { renderConnectionsPage } from '../pages/connections/index.mjs'
import { renderWorkspacesPage } from '../pages/workspaces/index.mjs'
import { renderSessionsPage } from '../pages/sessions/index.mjs'
import { renderBoardPage } from '../pages/board/index.mjs'
import { renderTicketsPage } from '../pages/tickets/index.mjs'

// The daemon ticket contract accepts only all/open/closed. The WebUI must not
// dispatch any other status, even if a stale control or programmatic caller
// supplies one. Unsupported values are ignored before touching state or wire.
const SUPPORTED_TICKET_FILTERS = Object.freeze(['all', 'open', 'closed'])

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

function newOperationId(prefix) {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function workTrackingOperationId(error) {
  return error?.operation?.operationRef?.operationId
    || error?.operationRef?.operationId
    || error?.operationId
    || null
}

function preserveWorkTrackingError(error, fallbackCode) {
  const typed = normalizeTypedError(error, fallbackCode)
  if (!error || typeof error !== 'object') return typed
  const operationId = workTrackingOperationId(error)
  if (operationId) typed.operationId = operationId
  for (const field of ['operation', 'operationRef', 'operationId', 'owningModule', 'providerStatus', 'retryDisposition']) {
    if (error[field] !== undefined) typed[field] = error[field]
  }
  return typed
}

function preserveLocalGroupError(error, fallbackCode) {
  const typed = normalizeTypedError(error, fallbackCode)
  if (!error || typeof error !== 'object') return typed
  for (const field of [
    'status',
    'cause',
    'details',
    'owningModule',
    'operationId',
    'retryDisposition',
  ]) {
    if (error[field] !== undefined) typed[field] = error[field]
  }
  return typed
}

function retainWorkTrackingOperation(entry, {
  operation = null,
  operationId,
  kind,
  ticketId = null,
  state = 'pending',
} = {}) {
  const resolvedOperationId = operation?.operationRef?.operationId || operationId
  if (!resolvedOperationId) return
  const record = {
    operationId: resolvedOperationId,
    operationRef: operation?.operationRef ?? entry.workTrackingOperations.find((item) => item.operationId === resolvedOperationId)?.operationRef ?? null,
    kind: operation?.kind ?? kind,
    ticketId: operation?.bindingId ?? ticketId,
    state: operation?.state ?? state,
    observedAt: operation?.observedAt ?? Date.now(),
    operation,
  }
  const index = entry.workTrackingOperations.findIndex((item) => item.operationId === resolvedOperationId)
  if (index === -1) entry.workTrackingOperations.push(record)
  else entry.workTrackingOperations[index] = record
}

function clearWorkTrackingOperation(entry, operationId) {
  if (!operationId) return
  entry.workTrackingOperations = entry.workTrackingOperations.filter((item) => item.operationId !== operationId)
}

function memoryStorage() {
  const values = new Map()
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      values.set(key, String(value))
    },
    removeItem(key) {
      values.delete(key)
    },
  }
}

export function isMobileUserAgent(userAgent = '') {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(String(userAgent || ''))
}

export function computeViewportMode({ width, height, userAgent = '' } = {}) {
  const w = Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : 1440
  const h = Number.isFinite(Number(height)) && Number(height) > 0 ? Number(height) : 900
  const aspect = w / h
  const mobileUa = isMobileUserAgent(userAgent)

  if (w < 960) return 'mobile'
  if (aspect < 0.85 && w < 1100) return 'mobile'
  if (mobileUa && (w < 1100 || h < 540)) return 'mobile'
  return 'desktop'
}

function daemonUnavailableError(message = 'Daemon API port is not configured.') {
  return normalizeTypedError({
    code: 'DAEMON_API_UNAVAILABLE',
    category: 'connection',
    message,
    retryable: true,
  }, 'DAEMON_API_UNAVAILABLE')
}

function terminalUnavailableError(message = 'Terminal client port is not configured.') {
  return normalizeTypedError({
    code: 'TERMINAL_CLIENT_UNAVAILABLE',
    category: 'terminal',
    message,
    retryable: true,
  }, 'TERMINAL_CLIENT_UNAVAILABLE')
}

function terminalNotLoadedError() {
  return normalizeTypedError({
    code: 'TERMINAL_NOT_LOADED',
    category: 'terminal',
    message: 'Terminal body is not loaded until this member receives focus.',
    retryable: false,
  }, 'TERMINAL_NOT_LOADED')
}

function terminalStartingError() {
  return normalizeTypedError({
    code: 'TERMINAL_FRAME_PENDING',
    category: 'terminal',
    message: 'This terminal is attached and waiting for its first frame.',
    retryable: true,
  }, 'TERMINAL_FRAME_PENDING')
}

const VISIBLE_PEER_SLOT_COUNT = 4

function workspaceSelectionRequiredError(message = 'Please select or create a workspace first.') {
  return normalizeTypedError({
    code: 'WORKSPACE_SELECTION_REQUIRED',
    category: 'validation',
    message,
    retryable: false,
  }, 'WORKSPACE_SELECTION_REQUIRED')
}

function managerSelectionRequiredError(message = 'Select a manager before loading the board.') {
  return normalizeTypedError({
    code: 'BOARD_MANAGER_REQUIRED',
    category: 'validation',
    message,
    retryable: false,
  }, 'BOARD_MANAGER_REQUIRED')
}

function validateWorkspaceScopedRecord(
  record,
  expectedWorkspaceId,
  requiredStringFields = [],
  errorCode = 'PROTOCOL_RESPONSE_INVALID',
) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw normalizeTypedError({
      code: errorCode,
      category: 'protocol',
      message: 'Backend returned a malformed record.',
      retryable: false,
    }, errorCode)
  }
  if (
    record.workspaceId !== undefined &&
    record.workspaceId !== null &&
    String(record.workspaceId) !== String(expectedWorkspaceId)
  ) {
    throw normalizeTypedError({
      code: 'WORKSPACE_SCOPE_MISMATCH',
      category: 'protocol',
      message: `Response workspaceId (${record.workspaceId}) does not match requested workspaceId (${expectedWorkspaceId}).`,
      retryable: false,
    }, 'WORKSPACE_SCOPE_MISMATCH')
  }
  for (const field of requiredStringFields) {
    if (typeof record[field] !== 'string' || record[field].trim() === '') {
      throw normalizeTypedError({
        code: errorCode,
        category: 'protocol',
        message: `Backend response is missing authoritative field "${field}".`,
        retryable: false,
      }, errorCode)
    }
  }
  return record
}

function loadingLoadable() {
  return {
    status: 'loading',
    value: null,
    observedAt: null,
    freshness: 'loading',
    error: null,
  }
}

function unavailableLoadable(error) {
  return {
    status: 'unavailable',
    value: null,
    observedAt: nowIso(),
    freshness: 'unavailable',
    error: normalizeTypedError(error, 'DAEMON_API_UNAVAILABLE'),
  }
}

function machineTypedError(error, fallbackCode = 'MACHINE_ACTION_FAILED') {
  const typed = normalizeTypedError(error, fallbackCode)
  if (!error || typeof error !== 'object') return typed
  for (const field of ['owningModule', 'operationId', 'status']) {
    if (error[field] !== undefined && error[field] !== null && error[field] !== '') {
      typed[field] = error[field]
    }
  }
  if (typeof error.category === 'string' && error.category !== '') {
    typed.category = error.category
  } else if (!typed.category || typed.category === 'session') {
    typed.category = 'machine'
  }
  return typed
}

function projectMachineConnection(connection) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) return null
  const capabilities = connection.capabilities && typeof connection.capabilities === 'object'
    ? connection.capabilities
    : {}
  const backpressure = connection.backpressure && typeof connection.backpressure === 'object'
    ? connection.backpressure
    : {}
  const projected = {
    machineId: String(connection.machineId ?? ''),
    status: String(connection.status ?? 'unavailable'),
    freshness: String(connection.freshness ?? 'unavailable'),
    observedAt: typeof connection.observedAt === 'string' ? connection.observedAt : null,
    transportKind: typeof connection.transportKind === 'string' ? connection.transportKind : null,
    path: typeof connection.path === 'string' ? connection.path : null,
    peerIdentityVerified: connection.peerIdentityVerified === true,
    peerIdentity: connection.peerIdentityVerified === true && typeof connection.peerIdentity === 'string'
      ? connection.peerIdentity
      : null,
    capabilities: {
      channelKinds: Array.isArray(capabilities.channelKinds)
        ? capabilities.channelKinds.filter((item) => typeof item === 'string')
        : [],
      transportKind: typeof capabilities.transportKind === 'string' ? capabilities.transportKind : null,
    },
    backpressure: {
      queuedBytes: Number(backpressure.queuedBytes) || 0,
      bufferedBytes: Number(backpressure.bufferedBytes) || 0,
      backpressured: backpressure.backpressured === true,
    },
  }
  if (connection.generation !== undefined && connection.generation !== null) {
    projected.generation = connection.generation
  }
  return projected
}

function projectMachineObservation(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return null
  const value = observation.value && typeof observation.value === 'object' ? observation.value : {}
  return {
    source: typeof observation.source === 'string' ? observation.source : 'connections',
    observedAt: typeof observation.observedAt === 'string' ? observation.observedAt : null,
    value: {
      machineId: typeof value.machineId === 'string' ? value.machineId : '',
      generation: value.generation ?? null,
      status: typeof value.status === 'string' ? value.status : 'unavailable',
      freshness: typeof value.freshness === 'string' ? value.freshness : 'unavailable',
      sessions: Number.isInteger(value.sessions) ? value.sessions : null,
    },
  }
}

function projectMachineSessionCatalog(sessions) {
  return sessions.map((session) => ({
    name: String(session?.name ?? ''),
    backend: String(session?.backend ?? ''),
    stableId: String(session?.stableId ?? ''),
  }))
}

function buildHelpers() {
  return {
    renderStatusBadge,
    renderErrorNotice,
    renderFormActions,
    renderWorkspaceTree,
    renderMemberPicker,
    renderMemberStatusList,
    renderWindowHeader,
    renderWindowFrame,
    renderPropertyPanel,
    renderGoalTicketList,
    renderTicketList,
    renderTicketDetail,
    renderDeliveryStatus,
    renderWorkspaceQuickSwitch,
    renderSplitLayout,
    renderSessionWorkbench,
    renderSessionPreviewCanvas,
    renderSessionFocusView,
  }
}

function resolveDeliveryPort(injectedDeliveryClient, daemonApi) {
  if (injectedDeliveryClient) return injectedDeliveryClient
  if (
    daemonApi &&
    (typeof daemonApi.submitDelivery === 'function' ||
      typeof daemonApi.sendMessage === 'function' ||
      typeof daemonApi.offerFileTransfer === 'function')
  ) {
    return createDeliveryClient({
      transport: {
        async sendMessage(payload) {
          if (typeof daemonApi.submitDelivery === 'function') return daemonApi.submitDelivery(payload)
          return daemonApi.sendMessage(payload)
        },
        async offerFileTransfer(payload) {
          if (typeof daemonApi.offerFileTransfer === 'function') return daemonApi.offerFileTransfer(payload)
          if (typeof daemonApi.submitDelivery === 'function') return daemonApi.submitDelivery(payload)
          throw normalizeTypedError({ code: 'DELIVERY_CLIENT_UNAVAILABLE', message: 'File transfer transport is not configured.' }, 'DELIVERY_CLIENT_UNAVAILABLE')
        },
      },
    })
  }
  return null
}

function isWorkspaceScopeErrorCode(code = '') {
  return (
    code === 'WORKSPACE_NOT_FOUND' ||
    code === 'AUTH_FORBIDDEN' ||
    code === 'WORKSPACE_FORBIDDEN'
  )
}

export function createWebUIApp({
  daemonApi: injectedDaemonApi = null,
  terminalClient: injectedTerminalClient = null,
  deliveryClient: injectedDeliveryClient = null,
  terminalViewportFactory = null,
  storage = null,
  initialRoute = 'sessions',
  initialHash = null,
  initialWorkspaceId = null,
  viewportWidth = null,
  viewportHeight = null,
  userAgent = null,
} = {}) {
  const resolvedWidth = typeof viewportWidth === 'number'
    ? viewportWidth
    : (typeof globalThis.innerWidth === 'number' && globalThis.innerWidth > 0 ? globalThis.innerWidth : 1440)
  const resolvedHeight = typeof viewportHeight === 'number'
    ? viewportHeight
    : (typeof globalThis.innerHeight === 'number' && globalThis.innerHeight > 0 ? globalThis.innerHeight : 900)
  const resolvedUserAgent = typeof userAgent === 'string'
    ? userAgent
    : (typeof globalThis.navigator?.userAgent === 'string' ? globalThis.navigator.userAgent : '')

  const rawLocationHash = typeof initialHash === 'string'
    ? initialHash
    : (typeof globalThis.location?.hash === 'string' && globalThis.location.hash ? globalThis.location.hash : '')
  const parsedInitial = parseNavigationTarget(rawLocationHash || initialRoute, {
    fallbackRoute: resolveRoute(initialRoute, 'sessions'),
    fallbackWorkspaceId: initialWorkspaceId,
  })

  const daemonApi = injectedDaemonApi
  const terminalClient = injectedTerminalClient
  const deliveryClient = resolveDeliveryPort(injectedDeliveryClient, daemonApi)

  const browserStorage = (typeof window !== 'undefined' && typeof document !== 'undefined' && window.localStorage && typeof window.localStorage.getItem === 'function')
    ? window.localStorage
    : null
  const backingStorage = storage ?? browserStorage ?? memoryStorage()
  const layoutStore = createLayoutStore({ storage: backingStorage })
  const propertyController = createPropertyController({ daemonApi })
  const sessionController = createSessionController({
    daemonApi,
    terminalClient,
    deliveryClient,
    terminalViewportFactory,
    layoutStore,
    accountId: 'acc-default',
  })
  const helpers = buildHelpers()

  const workspaceDataById = new Map()

  function ensureWorkspaceEntry(workspaceId) {
    const key = String(workspaceId || '')
    if (!workspaceDataById.has(key)) {
      workspaceDataById.set(key, {
        workspaceId: key,
        workspace: null,
        workspaceScopeError: null,
        lastError: null,
        transitionError: null,
        transitionPending: false,
        members: [],
        groups: [],
        membersLoadable: loadingLoadable(),
        goalsLoadable: loadingLoadable(),
        ticketsLoadable: loadingLoadable(),
        layout: null,
        selectedMemberId: null,
        ownerMemberSelected: false,
        selectedGoalId: null,
        selectedTicketId: null,
        boardLoadable: loadingLoadable(),
        workTrackingOperations: [],
        activeTicketFilter: 'all',
        openPropertyByWindow: {},
        overflowOpenByWindow: {},
        machineFilter: '',
        localGroupResults: {},
        localGroupMemberResults: {},
        localGroupPending: { group: false, member: false },
        localGroupPendingByMemberId: {},
        localGroupScopeEpoch: 0,
        receipts: [],
        transfers: [],
        requestSeq: 0,
      })
    }
    return workspaceDataById.get(key)
  }

  const state = {
    activeRoute: parsedInitial.route,
    route: parsedInitial.route,
    routeScope: isWorkspaceScopedRoute(parsedInitial.route) ? 'workspace' : 'global',
    viewportWidth: resolvedWidth,
    viewportHeight: resolvedHeight,
    userAgent: resolvedUserAgent,
    viewportMode: computeViewportMode({ width: resolvedWidth, height: resolvedHeight, userAgent: resolvedUserAgent }),
    mobileNavOpen: false,
    workspaces: [],
    workspacesLoadable: loadingLoadable(),
    activeWorkspaceId: parsedInitial.workspaceId ?? initialWorkspaceId ?? null,
    explicitRequestedWorkspaceId: parsedInitial.explicitWorkspace ? parsedInitial.workspaceId : (initialWorkspaceId ?? null),
    workspaceScopeError: null,
    members: [],
    groups: [],
    membersLoadable: loadingLoadable(),
    connectionsLoadable: loadingLoadable(),
    machineConnections: {},
    machineSessions: {},
    machineDirectoryObservation: null,
    layout: null,
    selectedMemberId: null,
    ownerMemberSelected: false,
    selectedGoalId: null,
    selectedTicketId: null,
    boardLoadable: loadingLoadable(),
    workTrackingOperations: [],
    activeTicketFilter: 'all',
    transitionPending: false,
    transitionError: null,
    ticketsLoadable: loadingLoadable(),
    goalsLoadable: loadingLoadable(),
    bootstrap: { status: 'loading', value: null, error: null },
    formPending: false,
    lastError: null,
    receipts: [],
    transfers: [],
    openPropertyByWindow: {},
    overflowOpenByWindow: {},
    workspaceOverflowOpen: false,
    propertyLoading: false,
    machineFilter: '',
    localGroupResults: {},
    localGroupMemberResults: {},
    localGroupPending: { group: false, member: false },
    localGroupPendingByMemberId: {},
    workspaceDataById,
    mountedRoot: null,
    document: null,
  }

  let initialized = false
  let suppressHashListener = false
  const listeners = new Set()

  function notify() {
    for (const listener of listeners) listener(state)
  }

  const unsubscribeTerminalStatus = typeof terminalClient?.subscribeStatus === 'function'
    ? terminalClient.subscribeStatus(() => {
        if (!state.mountedRoot) return
        syncActiveWorkspaceProjection()
        render()
        notify()
      })
    : null

  function updateLocationHash(route, workspaceId) {
    if (typeof globalThis.location !== 'undefined' && globalThis.location) {
      try {
        const nextHash = routeUrl(route, isWorkspaceScopedRoute(route) ? workspaceId : null)
        if (globalThis.location.hash !== nextHash) {
          suppressHashListener = true
          globalThis.location.hash = nextHash
          suppressHashListener = false
        }
      } catch {
        suppressHashListener = false
      }
    }
  }

  function setRoute(route, workspaceId = state.activeWorkspaceId) {
    state.activeRoute = route
    state.route = route
    state.routeScope = isWorkspaceScopedRoute(route) ? 'workspace' : 'global'
    updateLocationHash(route, workspaceId)
  }

  function syncActiveWorkspaceProjection() {
    const wsId = state.activeWorkspaceId
    if (!wsId) {
      state.workspaceScopeError = null
      state.members = []
      state.groups = []
      state.layout = null
      state.selectedMemberId = null
      state.ownerMemberSelected = false
      state.selectedGoalId = null
      state.selectedTicketId = null
      state.activeTicketFilter = 'all'
      state.transitionPending = false
      state.transitionError = null
      state.boardLoadable = loadingLoadable()
      state.workTrackingOperations = []
      state.openPropertyByWindow = {}
      state.overflowOpenByWindow = {}
      state.machineFilter = ''
      state.localGroupResults = {}
      state.localGroupMemberResults = {}
      state.localGroupPending = { group: false, member: false }
      state.localGroupPendingByMemberId = {}
      state.receipts = []
      state.transfers = []
      if (state.workspacesLoadable.status === 'unavailable') {
        const err = state.workspacesLoadable.error || daemonUnavailableError()
        state.membersLoadable = unavailableLoadable(err)
        state.goalsLoadable = unavailableLoadable(err)
        state.ticketsLoadable = unavailableLoadable(err)
        state.lastError = err
      } else {
        state.membersLoadable = { status: 'ready', value: [], observedAt: nowIso(), freshness: 'fresh', error: null }
        state.goalsLoadable = { status: 'ready', value: [], observedAt: nowIso(), freshness: 'fresh', error: null }
        state.ticketsLoadable = { status: 'ready', value: [], observedAt: nowIso(), freshness: 'fresh', error: null }
        state.lastError = null
      }
      return
    }

    const entry = ensureWorkspaceEntry(wsId)
    state.workspaceScopeError = entry.workspaceScopeError
    state.lastError = entry.lastError
    state.transitionError = entry.transitionError
    state.transitionPending = entry.transitionPending
    state.members = entry.members
    state.groups = entry.groups
    state.membersLoadable = entry.membersLoadable
    state.goalsLoadable = entry.goalsLoadable
    state.ticketsLoadable = entry.ticketsLoadable
    state.layout = entry.layout
    state.selectedMemberId = entry.selectedMemberId
    state.ownerMemberSelected = entry.ownerMemberSelected
    state.selectedGoalId = entry.selectedGoalId
    state.selectedTicketId = entry.selectedTicketId
    state.boardLoadable = entry.boardLoadable
    state.workTrackingOperations = entry.workTrackingOperations
    state.activeTicketFilter = entry.activeTicketFilter || 'all'
    state.openPropertyByWindow = entry.openPropertyByWindow
    state.overflowOpenByWindow = entry.overflowOpenByWindow
    state.machineFilter = entry.machineFilter
    state.localGroupResults = entry.localGroupResults
    state.localGroupMemberResults = entry.localGroupMemberResults
    state.localGroupPending = entry.localGroupPending
    state.localGroupPendingByMemberId = entry.localGroupPendingByMemberId
    state.receipts = entry.receipts
    state.transfers = entry.transfers
  }

  // One handle per visible pane. The visible set is the same primary + four
  // peers the desktop 1+4 workbench renders, so every rendered body owns its
  // own stream instead of only the focused member.
  function visibleMemberIdsForProjection() {
    const members = state.members || []
    const layout = state.layout
    if (members.length === 0 && !layout) return []
    const available = new Set(members.map((member) => String(member.memberId)))
    const primary = layout?.primaryMemberId || members[0]?.memberId || null
    const peers = layout?.peerMemberIds || members.slice(1).map((member) => member.memberId)
    return [...new Set([primary, ...(peers || []).slice(0, VISIBLE_PEER_SLOT_COUNT)].map(String))]
      .filter((memberId) => available.has(memberId))
  }

  function terminalBodiesForMembers(members) {
    const out = {}
    const visibleMemberIds = new Set(visibleMemberIdsForProjection())
    for (const member of members) {
      const memberId = String(member.memberId)
      const handle = sessionController.getTerminalHandle(member.memberId)
      const memberRuntimeState = sessionController.getMemberState(member.memberId)
      const isVisible = visibleMemberIds.has(memberId)
      const isAttached = Boolean(
        isVisible &&
        handle &&
        HEALTHY_STATUSES.includes(handle.status) &&
        (typeof handle.isBodyActive !== 'function' || handle.isBodyActive())
      )
      const handleError = memberRuntimeState?.lastError
        || (handle && handle.status === 'unavailable' && handle.lastError ? handle.lastError : null)
      if (isAttached) {
        const terminalSnapshot = typeof handle.getSnapshot === 'function' ? handle.getSnapshot() : null
        const frameCount = Number.isFinite(terminalSnapshot?.deliveredFrameCount)
          ? terminalSnapshot.deliveredFrameCount
          : 0
        let viewportInnerHtml = ''
        if (typeof terminalViewportFactory === 'function') {
          const rendered = terminalViewportFactory({ member, handle })
          viewportInnerHtml = typeof rendered === 'string' ? rendered : (rendered?.html || '')
        } else if (terminalViewportFactory && typeof terminalViewportFactory.renderViewport === 'function') {
          const rendered = terminalViewportFactory.renderViewport({ member, handle })
          viewportInnerHtml = typeof rendered === 'string' ? rendered : (rendered?.html || '')
        } else if (typeof handle.renderViewportHtml === 'function') {
          viewportInnerHtml = handle.renderViewportHtml(member)
        } else if (typeof handle.viewportHtml === 'string') {
          viewportInnerHtml = handle.viewportHtml
        } else {
          viewportInnerHtml = `<div class="terminal-mount-slot" data-terminal-mount="true" data-member-id="${esc(member.memberId)}" data-handle-id="${esc(handle.handleId || '')}" data-session-id="${esc(handle.sessionId || member.sessionId || '')}"></div>`
        }
        const pendingHtml = frameCount === 0
          ? `<div class="v2-terminal-pending" data-terminal-pending="true" role="status" aria-live="polite"><span>Waiting for the first terminal frame...</span><code>TERMINAL_FRAME_PENDING</code></div>`
          : ''
        out[member.memberId] = `<div class="terminal-viewport" data-terminal-body="true" data-terminal-status="attached" data-member-id="${esc(member.memberId)}" data-handle-id="${esc(handle.handleId || '')}" data-session-id="${esc(handle.sessionId || member.sessionId || '')}">${pendingHtml}${viewportInnerHtml}<div class="terminal-scroll-owner">Scroll stays inside this terminal.</div></div>`
      } else if (isVisible && terminalClient && !handleError) {
        const err = terminalStartingError()
        out[member.memberId] = `<div class="terminal-viewport" data-terminal-body="true" data-terminal-status="starting" data-member-id="${esc(member.memberId)}"><div class="v2-terminal-pending" data-terminal-pending="true" role="status" aria-live="polite"><span>Attaching this terminal and waiting for its first frame...</span><code>TERMINAL_FRAME_PENDING</code></div>${renderErrorNotice({ error: err }).html}<div class="terminal-scroll-owner">Scroll stays inside this terminal.</div></div>`
      } else {
        let err
        let terminalStatus
        if (!terminalClient) {
          err = terminalUnavailableError()
          terminalStatus = 'unavailable'
        } else if (!isVisible) {
          err = terminalNotLoadedError()
          terminalStatus = 'not-loaded'
        } else if (handleError) {
          err = handleError
          terminalStatus = 'unavailable'
        } else {
          err = terminalStartingError()
          terminalStatus = 'starting'
        }
        const noticeHtml = renderErrorNotice({ error: err }).html
        out[member.memberId] = `<div class="terminal-viewport" data-terminal-body="true" data-terminal-status="${terminalStatus}" data-member-id="${esc(member.memberId)}">${noticeHtml}<div class="terminal-scroll-owner">Scroll stays inside this terminal.</div></div>`
      }
    }
    return out
  }

  function propertyPanelsByWindow() {
    const out = {}
    for (const [windowId, isOpen] of Object.entries(state.openPropertyByWindow)) {
      if (!isOpen) continue
      const boundMemberId = propertyController.openWindowMemberMap?.get?.(windowId)
        || (windowId === 'window-primary' ? (state.layout?.primaryMemberId || state.members[0]?.memberId) : windowId.replace(/^window-(?:peer-)?/, ''))
      if (!boundMemberId) continue
      const memberState = propertyController.getMemberState(boundMemberId)
      const memberDelivery = sessionController.getMemberState(boundMemberId)
      const memberReceipts = (memberDelivery?.receipts || [])
        .filter((r) => r.receiptId || r.deliveryRef)
        .map((r) => ({
          ...r,
          deliveryRef: r.deliveryRef ?? r.receiptId ?? '',
        }))
      const memberTransfers = (state.transfers || []).filter((t) => t?.target?.memberId === boundMemberId)
      const deliveryHtml = renderDeliveryStatus({
        receipts: memberReceipts,
        transfers: memberTransfers,
        error: memberDelivery?.lastError || null,
      }).html
      const panelHtml =
        renderPropertyPanel({
          windowId,
          memberId: boundMemberId,
          propertiesLoadable: memberState.propertiesLoadable,
          draft: memberState.draft,
          saving: memberState.saving,
          saveError: memberState.saveError,
        }).html +
        `<div class="v2-member-delivery-drawer" data-role="member-delivery-status" data-member-id="${esc(boundMemberId)}">${deliveryHtml}</div>`
      out[windowId] = panelHtml
      out[`window-${boundMemberId}`] = panelHtml
      out[`window-peer-${boundMemberId}`] = panelHtml
    }
    return out
  }

  function activeWorkspaceRecord() {
    if (!state.activeWorkspaceId) return null
    const entry = workspaceDataById.get(String(state.activeWorkspaceId))
    return entry?.workspace || state.workspaces.find((ws) => ws.workspaceId === state.activeWorkspaceId) || null
  }

  function sessionsState() {
    return {
      ...state,
      workspaces: state.workspaces,
      workspacesLoadable: state.workspacesLoadable,
      activeWorkspace: activeWorkspaceRecord(),
      workspaceScopeError: state.workspaceScopeError,
      members: state.members,
      membersLoadable: state.membersLoadable,
      layout: state.layout || {
        primaryMemberId: state.members[0]?.memberId ?? null,
        peerMemberIds: state.members.slice(1).map((member) => member.memberId),
        mobileMode: 'preview',
        focusedMemberId: state.members[0]?.memberId ?? null,
        previewViewport: { zoom: 1, panX: 0, panY: 0 },
        openPropertyByWindow: state.openPropertyByWindow,
      },
      viewportMode: state.viewportMode,
      terminalBodiesByMember: terminalBodiesForMembers(state.members),
      propertyPanelsByWindow: propertyPanelsByWindow(),
      overflowOpenByWindow: state.overflowOpenByWindow,
      receipts: state.receipts,
      transfers: state.transfers,
      lastError: state.lastError,
    }
  }

  function renderPage() {
    const activeWorkspace = activeWorkspaceRecord()
    if (state.activeRoute === 'setup') {
      return renderSetupPage({
        ...state,
        bootstrap: state.bootstrap,
      }, helpers)
    }
    if (state.activeRoute === 'connections') {
      return renderConnectionsPage({
        ...state,
        machinesLoadable: state.connectionsLoadable,
        machines: state.connectionsLoadable.value || [],
        machineConnections: state.machineConnections,
        machineSessions: state.machineSessions,
      }, helpers)
    }
    if (state.activeRoute === 'workspaces') {
      return renderWorkspacesPage({
        ...state,
        workspacesLoadable: state.workspacesLoadable,
        membersLoadable: state.membersLoadable,
        groups: state.groups,
        machineFilter: state.machineFilter,
        localGroupResults: state.localGroupResults,
        localGroupMemberResults: state.localGroupMemberResults,
        localGroupPending: state.localGroupPending,
        localGroupPendingByMemberId: state.localGroupPendingByMemberId,
      }, helpers)
    }
    if (state.activeRoute === 'board') {
      return renderBoardPage({
        ...state,
        activeWorkspace,
        workspaceScopeError: state.workspaceScopeError,
        workspacesLoadable: state.workspacesLoadable,
        goalsLoadable: state.goalsLoadable,
        ticketsLoadable: state.ticketsLoadable,
        membersLoadable: state.membersLoadable,
        boardLoadable: state.boardLoadable,
        selectedGoalId: state.selectedGoalId,
      }, helpers)
    }
    if (state.activeRoute === 'tickets') {
      return renderTicketsPage({
        ...state,
        activeWorkspace,
        workspaceScopeError: state.workspaceScopeError,
        workspacesLoadable: state.workspacesLoadable,
        ticketsLoadable: state.ticketsLoadable,
        selectedTicketId: state.selectedTicketId,
        activeFilter: state.activeTicketFilter || 'all',
        transitionPending: state.transitionPending,
        transitionError: state.transitionError,
      }, helpers)
    }
    return renderSessionsPage(sessionsState(), helpers)
  }

  function buildBreadcrumbHtml() {
    const routeTitles = {
      sessions: 'Sessions 多终端工作台',
      board: 'Manager Board（当前工作区）',
      tickets: 'Tickets 任务单（当前工作区）',
      workspaces: 'Workspace 连接合并与分层治理',
      connections: '连接与机器恢复',
      setup: '初始化向导与全局配置',
    }
    const activeWs = activeWorkspaceRecord()
    const wsPath = activeWs?.path || activeWs?.name || state.activeWorkspaceId || '未选择 Workspace'
    if (isWorkspaceScopedRoute(state.activeRoute)) {
      return `<span>分层 Workspace</span><span class="sep">/</span><span data-role="breadcrumb-workspace">${esc(wsPath)}</span><span class="sep">/</span><span class="current" data-role="breadcrumb-page">${esc(routeTitles[state.activeRoute] || state.activeRoute)}</span>`
    }
    return `<span>全局连接与配置</span><span class="sep">/</span><span class="current" data-role="breadcrumb-page">${esc(routeTitles[state.activeRoute] || state.activeRoute)}</span>`
  }

  function renderShell() {
    const page = renderPage()
    const activeWs = activeWorkspaceRecord()
    const sidebarTreeHtml = renderWorkspaceTree({
      workspacesLoadable: state.workspacesLoadable,
      activeWorkspaceId: state.activeWorkspaceId,
      variant: 'sidebar',
    }).html

    const globalNavItems = [
      { route: 'workspaces', label: 'Workspace 连接合并' },
      { route: 'connections', label: '连接与机器恢复' },
      { route: 'setup', label: '初始化向导' },
    ]

    const globalNavHtml = globalNavItems.map((item) => {
      const isCurrent = state.activeRoute === item.route
      return `<button type="button" class="nav-item v2-nav-item${isCurrent ? ' active' : ''}" data-action="navigate" data-route="${item.route}" data-route-scope="global" aria-current="${isCurrent}"><span class="label">${esc(item.label)}</span></button>`
    }).join('')

    const connReady = state.connectionsLoadable.status === 'ready'
    const connStatus = state.connectionsLoadable.status
    const connDotClass = connReady ? 'dot-online' : (connStatus === 'loading' ? 'dot-busy' : 'dot-offline')
    const connLabel = connReady
      ? `${state.connectionsLoadable.value?.length ?? 0} Machines 已同步`
      : (connStatus === 'loading' ? '正在同步机器目录...' : '机器目录不可用 (Unavailable)')

    const errors = state.lastError && !state.workspaceScopeError
      ? renderErrorNotice({ error: state.lastError }).html
      : ''

    return {
      page,
      html: `
        <div class="app-shell v2-app-shell" data-component="app-shell" data-route="${esc(state.activeRoute)}" data-route-scope="${esc(state.routeScope)}" data-workspace-id="${esc(state.activeWorkspaceId || '')}" data-viewport-mode="${esc(state.viewportMode)}" data-mobile-nav-open="${state.mobileNavOpen}">
          <aside class="sidebar v2-sidebar${state.mobileNavOpen ? ' mobile-open' : ''}" id="app-sidebar" data-role="app-sidebar" data-mobile-open="${state.mobileNavOpen}">
            <div class="brand-row">
              <div class="brand-logo v2-brand"><span class="brand-mark">Z</span> Zterm <span>V2</span></div>
              <button type="button" class="btn btn-sm sidebar-sub-btn" data-action="navigate" data-route="workspaces" title="新建或挂载子工作区">+ 子层</button>
            </div>
            <div class="nav-zone" data-nav-zone="workspace-tree">
              <div class="nav-section-title">分层 Workspace</div>
              <div id="workspace-tree" data-role="sidebar-workspace-tree">${sidebarTreeHtml}</div>
            </div>
            <div class="nav-zone" data-nav-zone="global-config">
              <div class="nav-section-title">全局连接与配置</div>
              <nav class="nav-tree v2-nav" data-role="global-navigation" data-nav-scope="global">
                ${globalNavHtml}
              </nav>
            </div>
          </aside>
          <div class="main-area v2-main-area">
            <header class="top-header v2-app-header" data-role="top-header">
              <div class="header-left">
                <button type="button" class="btn btn-sm mobile-nav-toggle" id="mobile-nav-toggle-btn" data-action="toggle-mobile-nav" aria-expanded="${state.mobileNavOpen}">☰ 导航</button>
                <div class="breadcrumb" id="header-breadcrumb" data-role="header-breadcrumb">${buildBreadcrumbHtml()}</div>
              </div>
              <div class="header-right">
                <span class="conn-pill" id="header-conn-pill" data-role="header-conn-pill" data-status="${connStatus}">
                  <span class="dot ${connDotClass}"></span>
                  <span id="header-conn-label">${esc(connLabel)}</span>
                </span>
                <a class="badge badge-neutral" data-role="terminal-open-link" href="/features/terminal/index.html">终端 TUI</a>
                <span class="badge badge-neutral" data-role="header-viewport-badge" data-viewport-mode="${esc(state.viewportMode)}">${esc(state.viewportMode === 'mobile' ? `自适应窄屏 (${state.viewportWidth}×${state.viewportHeight})` : `自适应桌面 (${state.viewportWidth}×${state.viewportHeight})`)}</span>
              </div>
            </header>
            <main class="page-body v2-app-content" id="page-body">
              ${errors}
              ${page.html}
            </main>
          </div>
        </div>
      `,
    }
  }

  function mountTerminalViewportsIfNeeded() {
    if (!state.mountedRoot || typeof state.mountedRoot.querySelectorAll !== 'function') return
    const slots = state.mountedRoot.querySelectorAll('[data-terminal-mount="true"]')
    for (const slot of slots) {
      const memberId = slot.getAttribute('data-member-id')
      if (!memberId) continue
      const handle = sessionController.getTerminalHandle(memberId)
      if (!handle) continue
      if (terminalViewportFactory && typeof terminalViewportFactory.mount === 'function') {
        terminalViewportFactory.mount(slot, { memberId, handle })
      } else if (typeof handle.mount === 'function') {
        handle.mount(slot)
      }
      watchPendingFrame(slot.closest?.('.terminal-viewport'), memberId)
    }
  }

  const pendingFrameWatches = new Set()

  function clearPendingFrameWatches() {
    for (const stop of pendingFrameWatches) stop()
    pendingFrameWatches.clear()
  }

  // A stream can be attached before its first buffer frame arrives. Keep the
  // typed pending notice until the handle reports a delivered frame, and never
  // close or re-subscribe the stream from the shell.
  function watchPendingFrame(viewport, memberId) {
    if (!viewport || typeof viewport.querySelector !== 'function') return
    const notice = viewport.querySelector('[data-terminal-pending="true"]')
    if (!notice) return
    const handle = sessionController.getTerminalHandle(memberId)
    if (!handle || typeof handle.getSnapshot !== 'function') {
      notice.remove()
      return
    }
    const frameCount = () => {
      const snapshot = typeof handle.getSnapshot === 'function' ? handle.getSnapshot() : null
      return Number.isFinite(snapshot?.deliveredFrameCount) ? snapshot.deliveredFrameCount : 0
    }
    if (frameCount() > 0) {
      notice.remove()
      return
    }
    const canSubscribe = typeof handle.subscribe === 'function'
    if (!canSubscribe && typeof setInterval !== 'function') return
    let unsubscribeFrame = null
    let timer = null
    let stopped = false
    const removeWhenFrameReady = () => {
      if (!viewport.isConnected) {
        stop()
        return
      }
      if (frameCount() > 0) {
        notice.remove()
        stop()
      }
    }
    function stop() {
      if (stopped) return
      stopped = true
      unsubscribeFrame?.()
      if (timer !== null) clearInterval(timer)
      pendingFrameWatches.delete(stop)
    }
    pendingFrameWatches.add(stop)
    if (canSubscribe) {
      unsubscribeFrame = handle.subscribe(removeWhenFrameReady)
    } else {
      timer = setInterval(removeWhenFrameReady, 400)
    }
  }

  // Keep mounted renderer elements in the document at their current size while
  // the shell HTML is replaced. A detach collapses the renderer's observed box
  // to 0x0, which resets the terminal buffer geometry and loses scrollback.
  const terminalStashByMemberId = new Map()

  function stashTerminalViewports() {
    if (!state.mountedRoot || typeof state.mountedRoot.querySelectorAll !== 'function') return
    if (typeof document === 'undefined' || !document.createElement || !document.body) return
    const slots = state.mountedRoot.querySelectorAll('[data-terminal-mount="true"]')
    for (const slot of slots) {
      const memberId = slot.getAttribute('data-member-id')
      const rendererElement = slot.firstElementChild
      if (!memberId || !rendererElement) continue
      let stash = terminalStashByMemberId.get(memberId)
      if (!stash) {
        stash = document.createElement('div')
        stash.setAttribute('data-role', 'terminal-renderer-stash')
        stash.setAttribute('data-member-id', memberId)
        stash.style.position = 'fixed'
        stash.style.left = '-20000px'
        stash.style.top = '0'
        stash.style.visibility = 'hidden'
        stash.style.pointerEvents = 'none'
        document.body.appendChild(stash)
        terminalStashByMemberId.set(memberId, stash)
      }
      stash.style.width = `${Math.max(1, slot.clientWidth || rendererElement.clientWidth || 320)}px`
      stash.style.height = `${Math.max(1, slot.clientHeight || rendererElement.clientHeight || 200)}px`
      stash.appendChild(rendererElement)
    }
  }

  // The shell replaces its whole DOM on every render, which detaches the cached
  // renderer element and resets the terminal scroller. Capture follow/reading
  // before the swap and put it back after the renderer element is re-attached.
  const TERMINAL_FOLLOW_THRESHOLD_PX = 5

  function captureTerminalScrollState() {
    const snapshots = new Map()
    if (!state.mountedRoot || typeof state.mountedRoot.querySelectorAll !== 'function') return snapshots
    for (const viewport of state.mountedRoot.querySelectorAll('.terminal-viewport[data-member-id]')) {
      const memberId = viewport.getAttribute('data-member-id')
      if (!memberId) continue
      const scrollTop = Number(viewport.scrollTop) || 0
      const scrollHeight = Number(viewport.scrollHeight) || 0
      const clientHeight = Number(viewport.clientHeight) || 0
      snapshots.set(memberId, {
        scrollTop,
        atBottom: scrollHeight - scrollTop - clientHeight <= TERMINAL_FOLLOW_THRESHOLD_PX,
      })
    }
    return snapshots
  }

  function restoreTerminalScrollState(snapshots) {
    if (!snapshots || snapshots.size === 0) return
    if (!state.mountedRoot || typeof state.mountedRoot.querySelectorAll !== 'function') return
    for (const viewport of state.mountedRoot.querySelectorAll('.terminal-viewport[data-member-id]')) {
      const memberId = viewport.getAttribute('data-member-id')
      const snapshot = memberId ? snapshots.get(memberId) : null
      if (!snapshot) continue
      viewport.scrollTop = snapshot.atBottom
        ? viewport.scrollHeight
        : Math.min(snapshot.scrollTop, viewport.scrollHeight)
    }
  }

  function render() {
    const shell = renderShell()
    if (state.mountedRoot && typeof state.mountedRoot === 'object') {
      clearPendingFrameWatches()
      stashTerminalViewports()
      const scrollSnapshots = captureTerminalScrollState()
      state.mountedRoot.innerHTML = shell.html
      mountTerminalViewportsIfNeeded()
      restoreTerminalScrollState(scrollSnapshots)
    }
    return shell
  }

  async function loadWorkspaceScopedResources(workspaceId, seq) {
    const entry = ensureWorkspaceEntry(workspaceId)

    // 1. Per-workspace Tickets
    if (!daemonApi || typeof daemonApi.listTickets !== 'function') {
      if (entry.requestSeq === seq) {
        entry.ticketsLoadable = unavailableLoadable(daemonUnavailableError('Ticket service port is not configured.'))
      }
    } else {
      try {
        const tickets = await daemonApi.listTickets({
          workspaceId,
          status: entry.activeTicketFilter && entry.activeTicketFilter !== 'all' ? entry.activeTicketFilter : undefined,
        })
        if (entry.requestSeq === seq) {
          if (!Array.isArray(tickets)) {
            throw normalizeTypedError({
              code: 'TICKET_RESPONSE_INVALID',
              category: 'protocol',
              message: 'listTickets did not return an array.',
              retryable: false,
            }, 'TICKET_RESPONSE_INVALID')
          }
          const validatedList = tickets.map((item) => {
            validateWorkspaceScopedRecord(item, workspaceId, ['ticketId', 'title', 'status'], 'TICKET_RESPONSE_INVALID')
            return {
              ...item,
              workspaceId: item.workspaceId ?? workspaceId,
            }
          })
          entry.ticketsLoadable = { status: 'ready', value: validatedList, observedAt: nowIso(), freshness: 'fresh', error: null }
          if (!entry.selectedTicketId || !validatedList.some((t) => t.ticketId === entry.selectedTicketId)) {
            entry.selectedTicketId = validatedList[0]?.ticketId || null
          }
        }
      } catch (error) {
        if (entry.requestSeq === seq) {
          const typed = normalizeTypedError(error, 'TICKETS_UNAVAILABLE')
          entry.ticketsLoadable = unavailableLoadable(typed)
          entry.lastError = typed
        }
      }
    }

    // 2. Per-workspace Goals
    if (!daemonApi || typeof daemonApi.listGoals !== 'function') {
      if (entry.requestSeq === seq) {
        entry.goalsLoadable = unavailableLoadable(daemonUnavailableError('Goal board port is not configured.'))
      }
    } else {
      try {
        const goals = await daemonApi.listGoals({ workspaceId })
        if (entry.requestSeq === seq) {
          if (!Array.isArray(goals)) {
            throw normalizeTypedError({
              code: 'GOAL_RESPONSE_INVALID',
              category: 'protocol',
              message: 'listGoals did not return an array.',
              retryable: false,
            }, 'GOAL_RESPONSE_INVALID')
          }
          const validatedGoals = goals.map((item) => {
            validateWorkspaceScopedRecord(item, workspaceId, ['goalId', 'title', 'status'], 'GOAL_RESPONSE_INVALID')
            return {
              ...item,
              workspaceId: item.workspaceId ?? workspaceId,
            }
          })
          entry.goalsLoadable = { status: 'ready', value: validatedGoals, observedAt: nowIso(), freshness: 'fresh', error: null }
          if (!entry.selectedGoalId || !validatedGoals.some((g) => g.goalId === entry.selectedGoalId)) {
            entry.selectedGoalId = validatedGoals[0]?.goalId || null
          }
        }
      } catch (error) {
        if (entry.requestSeq === seq) {
          const typed = normalizeTypedError(error, 'GOALS_UNAVAILABLE')
          entry.goalsLoadable = unavailableLoadable(typed)
          entry.lastError = typed
        }
      }
    }

    // 3. Manager board. The manager must be an explicit member selection.
    if (!daemonApi || typeof daemonApi.queryManagerBoard !== 'function') {
      if (entry.requestSeq === seq) {
        entry.boardLoadable = unavailableLoadable(daemonUnavailableError('Manager board port is not configured.'))
      }
    } else if (!entry.ownerMemberSelected || !entry.selectedMemberId) {
      if (entry.requestSeq === seq) {
        entry.boardLoadable = unavailableLoadable(managerSelectionRequiredError())
      }
    } else {
      try {
        const board = await daemonApi.queryManagerBoard({
          workspaceId,
          managerId: entry.selectedMemberId,
        })
        if (entry.requestSeq === seq) {
          validateWorkspaceScopedRecord(board, workspaceId, [], 'BOARD_RESPONSE_INVALID')
          if (!Array.isArray(board.goals) || !Array.isArray(board.memberStatuses)) {
            throw normalizeTypedError({
              code: 'BOARD_RESPONSE_INVALID',
              category: 'protocol',
              message: 'queryManagerBoard did not return goal and member status arrays.',
              retryable: false,
            }, 'BOARD_RESPONSE_INVALID')
          }
          entry.boardLoadable = {
            status: 'ready',
            value: board,
            observedAt: new Date(board.observedAt).toISOString(),
            freshness: 'fresh',
            error: null,
          }
        }
      } catch (error) {
        if (entry.requestSeq === seq) {
          const typed = normalizeTypedError(error, 'BOARD_UNAVAILABLE')
          entry.boardLoadable = unavailableLoadable(typed)
          entry.lastError = typed
        }
      }
    }

    if (entry.requestSeq === seq && state.activeWorkspaceId === workspaceId) {
      syncActiveWorkspaceProjection()
      notify()
      render()
    }
  }

  function isSameLocalGroupScope(entry, scope) {
    return (
      String(entry.workspaceId) === scope.workspaceId
      && Number(entry.localGroupScopeEpoch) === scope.epoch
      && String(entry.selectedMemberId ?? '') === scope.memberId
    )
  }

  function makeLocalGroupScope(entry, memberId) {
    return {
      workspaceId: String(entry.workspaceId),
      epoch: Number(entry.localGroupScopeEpoch),
      memberId: String(memberId ?? entry.selectedMemberId ?? ''),
    }
  }

  function setMemberLocalGroupPending(entry, memberId, operation, pending) {
    if (!memberId) return
    entry.localGroupPendingByMemberId = {
      ...entry.localGroupPendingByMemberId,
      [memberId]: {
        ...entry.localGroupPendingByMemberId[memberId],
        [operation]: pending === true,
      },
    }
  }

  async function loadMemberRuntimeProjection(workspaceId, memberId) {
    if (!daemonApi || typeof daemonApi.getMemberRuntime !== 'function') return null
    const entry = ensureWorkspaceEntry(workspaceId)
    const requestSeq = entry.requestSeq
    const scope = makeLocalGroupScope(entry, memberId)
    let runtimeProjection
    try {
      runtimeProjection = await daemonApi.getMemberRuntime({ workspaceId, memberId })
    } catch {
      // A missing projection blocks typed bind/verify operations but does not
      // replace the last authoritative workspace snapshot.
      return null
    }
    if (
      entry.requestSeq !== requestSeq
      || !isSameLocalGroupScope(entry, scope)
      || state.activeWorkspaceId !== workspaceId
    ) {
      return null
    }

    const memberIndex = entry.members.findIndex((item) => item.memberId === memberId)
    if (memberIndex === -1) return null
    const current = entry.members[memberIndex]
    const projectedMember = runtimeProjection.member || current
    const updatedMember = {
      ...current,
      ...projectedMember,
      groupId: projectedMember.groupId ?? current.groupId,
      runtime: runtimeProjection.runtime ?? null,
      binding: runtimeProjection.binding ?? null,
      availability: runtimeProjection.availability ?? current.availability ?? null,
      bindingGeneration: runtimeProjection.bindingGeneration,
      agentCapabilities: runtimeProjection.agentCapabilities ?? current.agentCapabilities,
    }
    const members = entry.members.map((item) => (item.memberId === memberId ? updatedMember : item))
    entry.members = members
    if (entry.membersLoadable.status === 'ready') {
      entry.membersLoadable = { ...entry.membersLoadable, value: members }
    }
    syncActiveWorkspaceProjection()
    notify()
    render()
    return updatedMember
  }

  function ensureMachineState(machineId) {
    const id = String(machineId || '').trim()
    if (!id) return null
    if (!state.machineConnections[id]) {
      state.machineConnections[id] = {
        machineId: id,
        connection: null,
        observation: null,
        status: 'unavailable',
        freshness: 'unavailable',
        observedAt: null,
        pending: false,
        pendingAction: null,
        error: null,
      }
    }
    if (!state.machineSessions[id]) {
      state.machineSessions[id] = {
        machineId: id,
        sessions: [],
        observation: null,
        loaded: false,
        pending: false,
        error: null,
      }
    }
    return {
      connection: state.machineConnections[id],
      sessions: state.machineSessions[id],
    }
  }

  function applyMachineConnectionPayload(machineId, payload) {
    const entry = ensureMachineState(machineId)
    if (!entry) return
    const connection = projectMachineConnection(payload?.connection)
    const observation = projectMachineObservation(payload?.observation)
    const observationStatus = observation?.value?.status
    entry.connection.connection = connection
    entry.connection.observation = observation
    entry.connection.status = typeof observationStatus === 'string' ? observationStatus : 'unavailable'
    entry.connection.freshness = observation?.value?.freshness
      || connection?.freshness
      || 'unavailable'
    entry.connection.observedAt = observation?.observedAt || connection?.observedAt || nowIso()
    entry.connection.error = null
    entry.sessions.sessions = []
    entry.sessions.observation = null
    entry.sessions.loaded = false
    entry.sessions.error = null
  }

  async function loadMachines() {
    if (!daemonApi || typeof daemonApi.listMachines !== 'function') {
      state.connectionsLoadable = unavailableLoadable(
        daemonUnavailableError('Machine directory API port is not configured.'),
      )
      notify()
      render()
      return state.connectionsLoadable
    }

    state.connectionsLoadable = loadingLoadable()
    notify()
    render()

    try {
      const payload = await daemonApi.listMachines()
      if (!payload || !Array.isArray(payload.machines)) {
        throw machineTypedError({
          code: 'MACHINES_RESPONSE_INVALID',
          category: 'protocol',
          message: 'Daemon returned a malformed machine directory.',
        })
      }
      const observation = projectMachineObservation(payload.observation)
      for (const machine of payload.machines) {
        ensureMachineState(machine?.machineId)
      }
      state.machineDirectoryObservation = observation
      state.connectionsLoadable = {
        status: 'ready',
        value: payload.machines,
        observedAt: observation?.observedAt || nowIso(),
        freshness: 'fresh',
        error: null,
      }
    } catch (error) {
      state.connectionsLoadable = unavailableLoadable(machineTypedError(error, 'MACHINES_UNAVAILABLE'))
    }
    notify()
    render()
    return state.connectionsLoadable
  }

  async function runMachineConnectionAction(machineId, action) {
    const id = String(machineId || '').trim()
    if (!id) {
      return {
        ok: false,
        error: machineTypedError({
          code: 'MACHINE_ID_REQUIRED',
          category: 'validation',
          message: 'A machineId is required.',
        }, 'MACHINE_ID_REQUIRED'),
      }
    }

    const entry = ensureMachineState(id)
    if (entry.connection.pending || entry.sessions.pending) {
      return {
        ok: false,
        error: machineTypedError({
          code: 'MACHINE_ACTION_PENDING',
          category: 'conflict',
          message: 'A machine action is already pending.',
        }, 'MACHINE_ACTION_PENDING'),
      }
    }

    entry.connection.pending = true
    entry.connection.pendingAction = action
    entry.connection.error = null
    notify()
    render()

    try {
      if (action === 'connect-machine') {
        const payload = await daemonApi.connectMachine({ machineId: id })
        applyMachineConnectionPayload(id, payload)
      } else if (action === 'recover-machine') {
        const payload = await daemonApi.recoverMachine({ machineId: id })
        applyMachineConnectionPayload(id, payload)
      } else if (action === 'disconnect-machine') {
        await daemonApi.disconnectMachine({ machineId: id })
        entry.connection.connection = null
        entry.connection.observation = projectMachineObservation({
          source: 'connections',
          observedAt: nowIso(),
          value: { machineId: id, status: 'unavailable', freshness: 'unavailable' },
        })
        entry.connection.status = 'unavailable'
        entry.connection.freshness = 'unavailable'
        entry.connection.observedAt = entry.connection.observation.observedAt
        entry.connection.error = null
        entry.sessions.sessions = []
        entry.sessions.observation = null
        entry.sessions.loaded = false
        entry.sessions.error = null
      } else {
        throw machineTypedError({
          code: 'MACHINE_ACTION_UNSUPPORTED',
          category: 'validation',
          message: `Unsupported machine action ${action}.`,
        }, 'MACHINE_ACTION_UNSUPPORTED')
      }
      return {
        ok: true,
        machineId: id,
        status: entry.connection.status,
        freshness: entry.connection.freshness,
        connection: entry.connection.connection,
      }
    } catch (error) {
      const typed = machineTypedError(error, action === 'connect-machine'
        ? 'MACHINE_CONNECT_FAILED'
        : action === 'recover-machine'
          ? 'MACHINE_RECOVER_FAILED'
          : 'MACHINE_DISCONNECT_FAILED')
      entry.connection.error = typed
      return { ok: false, machineId: id, error: typed }
    } finally {
      entry.connection.pending = false
      entry.connection.pendingAction = null
      notify()
      render()
    }
  }

  async function loadMachineSessions(machineId) {
    const id = String(machineId || '').trim()
    if (!id) {
      return {
        ok: false,
        error: machineTypedError({
          code: 'MACHINE_ID_REQUIRED',
          category: 'validation',
          message: 'A machineId is required.',
        }, 'MACHINE_ID_REQUIRED'),
      }
    }

    const entry = ensureMachineState(id)
    if (entry.connection.pending || entry.sessions.pending) {
      return {
        ok: false,
        error: machineTypedError({
          code: 'MACHINE_ACTION_PENDING',
          category: 'conflict',
          message: 'A machine action is already pending.',
        }, 'MACHINE_ACTION_PENDING'),
      }
    }

    entry.sessions.pending = true
    entry.sessions.error = null
    notify()
    render()

    try {
      const payload = await daemonApi.listMachineSessions({ machineId: id })
      entry.sessions.sessions = projectMachineSessionCatalog(payload.sessions)
      entry.sessions.observation = projectMachineObservation(payload.observation)
      entry.sessions.loaded = true
      return { ok: true, machineId: id, sessions: entry.sessions.sessions }
    } catch (error) {
      const typed = machineTypedError(error, 'MACHINE_SESSIONS_FAILED')
      entry.sessions.error = typed
      return { ok: false, machineId: id, error: typed }
    } finally {
      entry.sessions.pending = false
      notify()
      render()
    }
  }

  async function loadWorkspace(workspaceId) {
    const previousWorkspaceId = state.activeWorkspaceId
    const scopeChanged = String(workspaceId || '') !== String(previousWorkspaceId || '')
    state.activeWorkspaceId = workspaceId || null
    state.workspaceOverflowOpen = false
    state.mobileNavOpen = false

    if (isWorkspaceScopedRoute(state.activeRoute)) {
      updateLocationHash(state.activeRoute, state.activeWorkspaceId)
    }

    if (!workspaceId) {
      syncActiveWorkspaceProjection()
      notify()
      render()
      return sessionController.getState()
    }

    const entry = ensureWorkspaceEntry(workspaceId)
    if (scopeChanged) {
      entry.localGroupScopeEpoch = Number(entry.localGroupScopeEpoch || 0) + 1
    }
    const seq = ++entry.requestSeq
    entry.workspaceScopeError = null
    entry.lastError = entry.transitionError || null
    if (entry.membersLoadable.status !== 'ready') {
      entry.membersLoadable = loadingLoadable()
    }
    if (entry.goalsLoadable.status !== 'ready') {
      entry.goalsLoadable = loadingLoadable()
    }
    if (entry.ticketsLoadable.status !== 'ready') {
      entry.ticketsLoadable = loadingLoadable()
    }
    if (entry.boardLoadable.status !== 'ready') {
      entry.boardLoadable = loadingLoadable()
    }

    // Immediately switch active projection to target workspace (never flash previous workspace's data)
    syncActiveWorkspaceProjection()
    notify()
    render()

    const result = await sessionController.loadWorkspaceSessions(workspaceId)
    const loadable = sessionController.getWorkspaceLoadable()

    if (entry.requestSeq !== seq) {
      return result
    }

    if (loadable.status === 'unavailable') {
      const err = loadable.error || daemonUnavailableError()
      entry.members = []
      entry.membersLoadable = { status: 'unavailable', value: null, observedAt: loadable.observedAt, freshness: 'unavailable', error: err }
      entry.goalsLoadable = unavailableLoadable(err)
      entry.ticketsLoadable = unavailableLoadable(err)
      entry.boardLoadable = unavailableLoadable(err)
      entry.lastError = err
      if (isWorkspaceScopeErrorCode(err.code)) {
        entry.workspaceScopeError = err
      }
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return result
    }

    const value = loadable.value || {}
    entry.workspace = value.workspace || state.workspaces.find((ws) => ws.workspaceId === workspaceId) || null
    if (entry.workspace) {
      state.workspaces = state.workspaces.map((workspace) => (
        String(workspace.workspaceId) === String(workspaceId)
          ? { ...workspace, ...entry.workspace }
          : workspace
      ))
      state.workspacesLoadable = {
        ...state.workspacesLoadable,
        value: state.workspaces,
        observedAt: nowIso(),
        freshness: 'fresh',
        error: null,
      }
    }
    entry.members = value.members || []
    entry.groups = Array.isArray(value.groups) ? value.groups : entry.groups
    entry.layout = value.layout || entry.layout
    entry.membersLoadable = { status: 'ready', value: entry.members, observedAt: nowIso(), freshness: 'fresh', error: null }
    entry.selectedMemberId = entry.selectedMemberId || entry.members[0]?.memberId || null

    if (state.activeWorkspaceId === workspaceId && entry.selectedMemberId) {
      await loadMemberRuntimeProjection(workspaceId, entry.selectedMemberId)
      syncActiveWorkspaceProjection()
      notify()
      render()
    }
    if (state.activeWorkspaceId === workspaceId && entry.requestSeq === seq) {
      await sessionController.attachVisibleMembers(workspaceId)
      syncActiveWorkspaceProjection()
      notify()
      render()
    }

    await loadWorkspaceScopedResources(workspaceId, seq)

    if (entry.requestSeq === seq) {
      entry.lastError = entry.lastError || sessionController.getLastOperationError()
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
    }
    return result
  }

  async function loadWorkspaces() {
    if (!daemonApi || typeof daemonApi.listWorkspaces !== 'function') {
      const typed = daemonUnavailableError()
      state.workspaces = []
      state.workspacesLoadable = unavailableLoadable(typed)
      state.lastError = typed
      return
    }
    try {
      const workspaces = await daemonApi.listWorkspaces()
      state.workspaces = Array.isArray(workspaces) ? workspaces : []
      state.workspacesLoadable = { status: 'ready', value: state.workspaces, observedAt: nowIso(), freshness: 'fresh', error: null }
      if (!state.activeWorkspaceId && !state.explicitRequestedWorkspaceId && state.workspaces.length > 0) {
        state.activeWorkspaceId = state.workspaces[0].workspaceId
      }
    } catch (error) {
      const typed = normalizeTypedError(error, 'WORKSPACES_UNAVAILABLE')
      state.workspaces = []
      state.workspacesLoadable = unavailableLoadable(typed)
      state.lastError = typed
    }
  }

  async function loadBootstrapSurface() {
    if (!daemonApi || typeof daemonApi.getBootstrap !== 'function') {
      state.bootstrap = { status: 'unavailable', value: null, error: daemonUnavailableError() }
    } else {
      try {
        const bootstrap = await daemonApi.getBootstrap()
        state.bootstrap = { status: 'ready', value: bootstrap, error: null }
      } catch (error) {
        state.bootstrap = { status: 'unavailable', value: null, error: normalizeTypedError(error, 'BOOTSTRAP_UNAVAILABLE') }
      }
    }
  }

  async function initialize() {
    if (initialized) return app
    initialized = true
    await loadWorkspaces()
    await loadBootstrapSurface()
    await loadMachines()
    await loadWorkspace(state.activeWorkspaceId)
    notify()
    render()
    return app
  }

  async function navigate(routeOrTarget, options = {}) {
    const parsed = parseNavigationTarget(routeOrTarget, {
      fallbackRoute: 'setup',
      fallbackWorkspaceId: options.workspaceId !== undefined ? options.workspaceId : state.activeWorkspaceId,
    })
    const nextRoute = parsed.route
    const requestedWorkspaceId = options.workspaceId !== undefined
      ? options.workspaceId
      : (parsed.explicitWorkspace ? parsed.workspaceId : state.activeWorkspaceId)

    state.mobileNavOpen = false

    if (isWorkspaceScopedRoute(nextRoute)) {
      if (requestedWorkspaceId !== state.activeWorkspaceId) {
        setRoute(nextRoute, requestedWorkspaceId)
        await loadWorkspace(requestedWorkspaceId)
        return app
      }
      setRoute(nextRoute, state.activeWorkspaceId)
      if (state.activeWorkspaceId) {
        const entry = ensureWorkspaceEntry(state.activeWorkspaceId)
        if (entry.membersLoadable.status === 'loading' || entry.goalsLoadable.status === 'loading' || entry.ticketsLoadable.status === 'loading') {
          await loadWorkspace(state.activeWorkspaceId)
          return app
        }
      }
      syncActiveWorkspaceProjection()
      notify()
      render()
      return app
    }

    setRoute(nextRoute, null)
    if (nextRoute === 'connections' && state.connectionsLoadable.status !== 'ready') {
      await loadMachines()
    }
    notify()
    render()
    return app
  }

  function setViewport({ width, height, userAgent: nextUserAgent } = {}) {
    if (typeof width === 'number' && width > 0) state.viewportWidth = width
    if (typeof height === 'number' && height > 0) state.viewportHeight = height
    if (typeof nextUserAgent === 'string') state.userAgent = nextUserAgent
    state.viewportMode = computeViewportMode({
      width: state.viewportWidth,
      height: state.viewportHeight,
      userAgent: state.userAgent,
    })
    if (state.viewportMode === 'desktop') {
      state.mobileNavOpen = false
    }
    notify()
    render()
  }

  async function toggleProperty(windowId, memberId) {
    const resolvedMemberId = memberId
      || (windowId === 'window-primary' ? (state.layout?.primaryMemberId || state.members[0]?.memberId) : String(windowId || '').replace(/^window-(?:peer-)?/, ''))
    const isOpen = Boolean(state.openPropertyByWindow[windowId])
    state.openPropertyByWindow[windowId] = !isOpen
    if (state.activeWorkspaceId) {
      const entry = ensureWorkspaceEntry(state.activeWorkspaceId)
      entry.openPropertyByWindow = { ...state.openPropertyByWindow }
    }
    if (state.layout) {
      state.layout.openPropertyByWindow = { ...(state.layout.openPropertyByWindow || {}), [windowId]: !isOpen }
    }
    if (!isOpen && resolvedMemberId) {
      state.propertyLoading = true
      propertyController.openWindowProperties(windowId, resolvedMemberId)
      await propertyController.loadMemberProperties(resolvedMemberId)
      state.propertyLoading = false
    } else {
      propertyController.closeWindowProperties(windowId)
    }
    notify()
    render()
  }

  async function saveProperties(memberId, patch) {
    const result = await propertyController.saveMemberProperties(memberId, patch)
    notify()
    render()
    return result
  }

  async function sendMessage(recipientMemberIdOrPayload, body, options = {}) {
    let recipientMemberId = recipientMemberIdOrPayload
    let messageBody = body
    let resolvedOptions = options
    if (recipientMemberIdOrPayload && typeof recipientMemberIdOrPayload === 'object') {
      recipientMemberId = recipientMemberIdOrPayload.recipientMemberId || recipientMemberIdOrPayload.toMemberId || recipientMemberIdOrPayload.memberId
      messageBody = recipientMemberIdOrPayload.body ?? recipientMemberIdOrPayload.text ?? ''
      resolvedOptions = recipientMemberIdOrPayload
    }
    const targetWorkspaceId = resolvedOptions.workspaceId || state.activeWorkspaceId
    const entry = targetWorkspaceId ? ensureWorkspaceEntry(targetWorkspaceId) : null
    try {
      const receipt = await sessionController.sendMemberMessage({
        workspaceId: targetWorkspaceId,
        senderMemberId: resolvedOptions.fromMemberId || (entry?.selectedMemberId || state.selectedMemberId) || (entry?.members?.[0]?.memberId || state.members[0]?.memberId),
        recipientMemberId,
        body: messageBody,
      })
      if (entry) {
        entry.receipts.push(receipt)
        entry.lastError = null
      }
      if (state.activeWorkspaceId === targetWorkspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return receipt
    } catch (error) {
      const typed = normalizeTypedError(error, 'DELIVERY_TARGET_UNKNOWN_STATE')
      if (entry) {
        entry.lastError = typed
      }
      if (state.activeWorkspaceId === targetWorkspaceId) {
        state.lastError = typed
        notify()
        render()
      }
      throw error
    }
  }

  async function sendTerminalInput(memberId, data) {
    const targetWorkspaceId = state.activeWorkspaceId
    const entry = targetWorkspaceId ? ensureWorkspaceEntry(targetWorkspaceId) : null
    try {
      const result = await sessionController.sendTerminalInput(memberId, data)
      if (entry) entry.lastError = null
      if (state.activeWorkspaceId === targetWorkspaceId) {
        state.lastError = null
        notify()
        render()
      }
      return result
    } catch (error) {
      const typed = normalizeTypedError(error, 'SESSION_TARGET_UNAVAILABLE')
      if (entry) entry.lastError = typed
      if (state.activeWorkspaceId === targetWorkspaceId) {
        state.lastError = typed
        notify()
        render()
      }
      throw error
    }
  }

  async function createOrReportTicket({
    workspaceId = state.activeWorkspaceId,
    title,
    description,
    priority = 0,
    goalId = state.selectedGoalId,
    ownerMemberId = state.ownerMemberSelected ? state.selectedMemberId : null,
  } = {}) {
    if (!workspaceId) {
      const err = workspaceSelectionRequiredError()
      state.lastError = err
      notify()
      render()
      return { ok: false, error: err }
    }
    const entry = ensureWorkspaceEntry(workspaceId)
    if (!goalId || !ownerMemberId) {
      const err = normalizeTypedError({
        code: 'TICKET_SELECTION_REQUIRED',
        category: 'validation',
        message: 'Select a goal and an owner before creating a ticket.',
        retryable: false,
      }, 'TICKET_SELECTION_REQUIRED')
      entry.lastError = err
      entry.transitionError = err
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: false, error: err }
    }
    if (!daemonApi || typeof daemonApi.createTicket !== 'function') {
      const err = daemonUnavailableError('Ticket write port is not configured.')
      entry.lastError = err
      entry.transitionError = err
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: false, error: err }
    }
    let operationId = null
    try {
      operationId = newOperationId('ticket-create')
      retainWorkTrackingOperation(entry, { operationId, kind: 'create', state: 'pending' })
      const created = await daemonApi.createTicket({
        workspaceId,
        operationId,
        goalId,
        ownerMemberId,
        category: 'requirement',
        title: String(title || ''),
        description: String(description || ''),
        priority,
      })
      validateWorkspaceScopedRecord(created, workspaceId, ['ticketId', 'title', 'status'], 'TICKET_RESPONSE_INVALID')
      if (!Array.isArray(created.allowedTransitions)) {
        throw normalizeTypedError({
          code: 'TICKET_RESPONSE_INVALID',
          category: 'protocol',
          message: 'Backend ticket response is missing authoritative allowedTransitions array.',
          retryable: false,
        }, 'TICKET_RESPONSE_INVALID')
      }
      const existing = entry.ticketsLoadable.status === 'ready' && Array.isArray(entry.ticketsLoadable.value)
        ? entry.ticketsLoadable.value
        : []
      const record = {
        ...created,
        workspaceId: created.workspaceId ?? workspaceId,
      }
      const nextList = [record, ...existing.filter((item) => item.ticketId !== record.ticketId)]
      entry.ticketsLoadable = { status: 'ready', value: nextList, observedAt: nowIso(), freshness: 'fresh', error: null }
      entry.selectedTicketId = record.ticketId
      entry.lastError = null
      entry.transitionError = null
      clearWorkTrackingOperation(entry, operationId)
      const seq = ++entry.requestSeq
      await loadWorkspaceScopedResources(workspaceId, seq)
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: true, ticket: record }
    } catch (error) {
      const typed = preserveWorkTrackingError(error, 'TICKET_REPORT_FAILED')
      const operation = typed.operation ?? null
      const operationState = operation?.state
      const failedOperationId = workTrackingOperationId(typed)
      if (operationState === 'failed' || operationState === 'superseded') {
        clearWorkTrackingOperation(entry, failedOperationId)
      } else {
        retainWorkTrackingOperation(entry, {
          operation,
          operationId: failedOperationId || operationId,
          kind: 'create',
          state: operationState === 'pending' ? 'pending' : 'unknown',
        })
      }
      entry.lastError = typed
      entry.transitionError = typed
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: false, error: typed }
    }
  }

  async function appendWorkspaceTicketReport({
    workspaceId = state.activeWorkspaceId,
    ticketId = state.selectedTicketId,
    body,
    reportKind = 'status',
    actorMemberId = state.ownerMemberSelected ? state.selectedMemberId : null,
  } = {}) {
    if (!workspaceId || !ticketId || !actorMemberId) {
      return { ok: false, error: normalizeTypedError({
        code: 'TICKET_REPORT_SELECTION_REQUIRED',
        category: 'validation',
        message: 'Select a ticket and owner before appending a report.',
        retryable: false,
      }, 'TICKET_REPORT_SELECTION_REQUIRED') }
    }
    const entry = ensureWorkspaceEntry(workspaceId)
    if (!daemonApi || typeof daemonApi.appendReport !== 'function') {
      const error = daemonUnavailableError('Ticket report port is not configured.')
      entry.lastError = error
      entry.transitionError = error
      return { ok: false, error }
    }
    let operationId = null
    try {
      operationId = newOperationId('ticket-report')
      retainWorkTrackingOperation(entry, { operationId, kind: 'appendReport', ticketId, state: 'pending' })
      const payload = await daemonApi.appendReport({
        workspaceId,
        ticketId,
        operationId,
        actorMemberId,
        reportKind,
        body: String(body || ''),
      })
      entry.lastError = null
      entry.transitionError = null
      clearWorkTrackingOperation(entry, operationId)
      const seq = ++entry.requestSeq
      await loadWorkspaceScopedResources(workspaceId, seq)
      return { ok: true, operation: payload.operation }
    } catch (error) {
      const typed = preserveWorkTrackingError(error, 'TICKET_REPORT_FAILED')
      const operation = typed.operation ?? null
      const operationState = operation?.state
      const failedOperationId = workTrackingOperationId(typed)
      if (operationState === 'failed' || operationState === 'superseded') {
        clearWorkTrackingOperation(entry, failedOperationId)
      } else {
        retainWorkTrackingOperation(entry, {
          operation,
          operationId: failedOperationId || operationId,
          kind: 'appendReport',
          ticketId,
          state: operationState === 'pending' ? 'pending' : 'unknown',
        })
      }
      entry.lastError = typed
      entry.transitionError = typed
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: false, error: typed }
    }
  }

  async function transitionWorkspaceTicket({ workspaceId = state.activeWorkspaceId, ticketId = state.selectedTicketId, transition, nextStatus } = {}) {
    const requestedTransition = transition || nextStatus
    if (!workspaceId) {
      const err = workspaceSelectionRequiredError()
      state.lastError = err
      notify()
      render()
      return { ok: false, error: err }
    }
    const entry = ensureWorkspaceEntry(workspaceId)
    if (!daemonApi || typeof daemonApi.transitionTicket !== 'function') {
      const err = daemonUnavailableError('Ticket transition port is not configured.')
      entry.lastError = err
      entry.transitionError = err
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: false, error: err }
    }
    let operationId = null
    try {
      operationId = newOperationId(`ticket-${requestedTransition || 'transition'}`)
      retainWorkTrackingOperation(entry, { operationId, kind: requestedTransition || 'transition', ticketId, state: 'pending' })
      const updated = await daemonApi.transitionTicket({
        workspaceId,
        ticketId,
        operationId,
        transition: requestedTransition,
      })
      validateWorkspaceScopedRecord(updated, workspaceId, ['ticketId', 'title', 'status'], 'TICKET_RESPONSE_INVALID')
      if (!Array.isArray(updated.allowedTransitions)) {
        throw normalizeTypedError({
          code: 'TICKET_RESPONSE_INVALID',
          category: 'protocol',
          message: 'Backend ticket transition response is missing authoritative allowedTransitions array.',
          retryable: false,
        }, 'TICKET_RESPONSE_INVALID')
      }
      if (String(updated.ticketId) !== String(ticketId)) {
        throw normalizeTypedError({
          code: 'TICKET_RESPONSE_INVALID',
          category: 'protocol',
          message: `Response ticketId (${updated.ticketId}) does not match requested ticketId (${ticketId}).`,
          retryable: false,
        }, 'TICKET_RESPONSE_INVALID')
      }
      const existing = entry.ticketsLoadable.status === 'ready' && Array.isArray(entry.ticketsLoadable.value)
        ? entry.ticketsLoadable.value
        : []
      const record = {
        ...updated,
        workspaceId: updated.workspaceId ?? workspaceId,
      }
      const nextList = existing.map((item) =>
        item.ticketId === ticketId ? { ...item, ...record } : item
      )
      entry.ticketsLoadable = { status: 'ready', value: nextList, observedAt: nowIso(), freshness: 'fresh', error: null }
      entry.lastError = null
      entry.transitionError = null
      clearWorkTrackingOperation(entry, operationId)
      const seq = ++entry.requestSeq
      await loadWorkspaceScopedResources(workspaceId, seq)
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: true, ticket: record }
    } catch (error) {
      const typed = preserveWorkTrackingError(error, 'TICKET_TRANSITION_FAILED')
      const operation = typed.operation ?? null
      const operationState = operation?.state
      const failedOperationId = workTrackingOperationId(typed)
      if (operationState === 'failed' || operationState === 'superseded') {
        clearWorkTrackingOperation(entry, failedOperationId)
      } else {
        retainWorkTrackingOperation(entry, {
          operation,
          operationId: failedOperationId || operationId,
          kind: requestedTransition || 'transition',
          ticketId,
          state: operationState === 'pending' ? 'pending' : 'unknown',
        })
      }
      entry.lastError = typed
      entry.transitionError = typed
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: false, error: typed }
    }
  }

  function explicitOwnerMemberId(workspaceId) {
    if (!workspaceId) return null
    const target = ensureWorkspaceEntry(workspaceId)
    return target.ownerMemberSelected ? target.selectedMemberId : null
  }

  async function createWorkspaceGoal({
    workspaceId = state.activeWorkspaceId,
    title,
    ownerMemberId = explicitOwnerMemberId(workspaceId),
  } = {}) {
    if (!workspaceId) {
      const err = workspaceSelectionRequiredError()
      state.lastError = err
      notify()
      render()
      return { ok: false, error: err }
    }
    const entry = ensureWorkspaceEntry(workspaceId)
    if (!daemonApi || typeof daemonApi.createGoal !== 'function') {
      const err = daemonUnavailableError('Goal write port is not configured.')
      entry.lastError = err
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: false, error: err }
    }
    try {
      if (!ownerMemberId) {
        throw normalizeTypedError({
          code: 'GOAL_OWNER_REQUIRED',
          category: 'validation',
          message: 'Select an owner before creating a goal.',
          retryable: false,
        }, 'GOAL_OWNER_REQUIRED')
      }
      const created = await daemonApi.createGoal({
        workspaceId,
        title: String(title || ''),
        ownerMemberId,
      })
      validateWorkspaceScopedRecord(created, workspaceId, ['goalId', 'title', 'status'], 'GOAL_RESPONSE_INVALID')
      const existing = entry.goalsLoadable.status === 'ready' && Array.isArray(entry.goalsLoadable.value)
        ? entry.goalsLoadable.value
        : []
      const record = {
        ...created,
        workspaceId: created.workspaceId ?? workspaceId,
      }
      entry.goalsLoadable = { status: 'ready', value: [record, ...existing.filter((g) => g.goalId !== record.goalId)], observedAt: nowIso(), freshness: 'fresh', error: null }
      entry.selectedGoalId = record.goalId
      entry.lastError = null
      const seq = ++entry.requestSeq
      await loadWorkspaceScopedResources(workspaceId, seq)
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: true, goal: record }
    } catch (error) {
      const typed = normalizeTypedError(error, 'GOAL_CREATE_FAILED')
      entry.lastError = typed
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: false, error: typed }
    }
  }

  function localGroupScopeChanged(entry, scope) {
    return (
      state.activeWorkspaceId !== scope.workspaceId
      || Number(entry.localGroupScopeEpoch) !== scope.epoch
      || (scope.memberId !== null && String(entry.selectedMemberId ?? '') !== scope.memberId)
    )
  }

  function setWorkspaceLocalGroupResult(entry, operation, result) {
    entry.localGroupResults = { ...entry.localGroupResults, [operation]: result }
  }

  function setMemberLocalGroupResult(entry, memberId, result) {
    entry.localGroupMemberResults = {
      ...entry.localGroupMemberResults,
      [memberId]: result,
    }
  }

  function organizationRevision(entry) {
    const revision = Number(entry.workspace?.revision)
    return Number.isInteger(revision) ? revision : null
  }

  async function createLocalGroupGroup(detail = {}) {
    const workspaceId = detail.workspaceId || state.activeWorkspaceId
    if (!workspaceId) {
      return { ok: false, error: workspaceSelectionRequiredError() }
    }
    if (!daemonApi || typeof daemonApi.createGroup !== 'function') {
      return { ok: false, error: daemonUnavailableError('Group creation port is not configured.') }
    }

    const entry = ensureWorkspaceEntry(workspaceId)
    const scope = { workspaceId: String(workspaceId), epoch: Number(entry.localGroupScopeEpoch), memberId: null }
    entry.localGroupPending = { ...entry.localGroupPending, group: true }
    syncActiveWorkspaceProjection()
    render()

    try {
      const expectedRevision = organizationRevision(entry)
      if (!Number.isInteger(expectedRevision)) {
        throw normalizeTypedError({
          code: 'ORGANIZATION_REVISION_UNAVAILABLE',
          category: 'validation',
          message: 'The authoritative organization revision is not loaded.',
          retryable: false,
        }, 'ORGANIZATION_REVISION_UNAVAILABLE')
      }
      const receipt = await daemonApi.createGroup({
        workspaceId,
        name: detail.name,
        parentGroupId: detail.parentGroupId ?? detail.groupParentId ?? null,
        expectedRevision,
      })
      if (!receipt || typeof receipt !== 'object' || !receipt.groupId) {
        throw normalizeTypedError({
          code: 'GROUP_RESPONSE_INVALID',
          category: 'protocol',
          message: 'Group creation did not return a stable group receipt.',
          retryable: false,
        }, 'GROUP_RESPONSE_INVALID')
      }
      if (!localGroupScopeChanged(entry, scope)) {
        setWorkspaceLocalGroupResult(entry, 'group', { status: 'success', message: 'Group created.' })
        await loadWorkspace(workspaceId)
      }
      return { ok: true, receipt }
    } catch (error) {
      const typed = preserveLocalGroupError(error, 'GROUP_CREATION_FAILED')
      if (!localGroupScopeChanged(entry, scope)) {
        setWorkspaceLocalGroupResult(entry, 'group', {
          status: 'error',
          message: typed.message,
          error: typed,
        })
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: false, error: typed }
    } finally {
      entry.localGroupPending = { ...entry.localGroupPending, group: false }
      syncActiveWorkspaceProjection()
      notify()
      render()
    }
  }

  async function createLocalGroupMember(detail = {}) {
    const workspaceId = detail.workspaceId || state.activeWorkspaceId
    if (!workspaceId) {
      return { ok: false, error: workspaceSelectionRequiredError() }
    }
    if (!daemonApi || typeof daemonApi.createMember !== 'function') {
      return { ok: false, error: daemonUnavailableError('Member creation port is not configured.') }
    }

    const entry = ensureWorkspaceEntry(workspaceId)
    const scope = { workspaceId: String(workspaceId), epoch: Number(entry.localGroupScopeEpoch), memberId: null }
    entry.localGroupPending = { ...entry.localGroupPending, member: true }
    syncActiveWorkspaceProjection()
    render()

    try {
      const expectedRevision = organizationRevision(entry)
      if (!Number.isInteger(expectedRevision)) {
        throw normalizeTypedError({
          code: 'ORGANIZATION_REVISION_UNAVAILABLE',
          category: 'validation',
          message: 'The authoritative organization revision is not loaded.',
          retryable: false,
        }, 'ORGANIZATION_REVISION_UNAVAILABLE')
      }
      const receipt = await daemonApi.createMember({
        workspaceId,
        groupId: detail.groupId || detail.memberGroupId,
        name: detail.name,
        expectedRevision,
      })
      if (!receipt || typeof receipt !== 'object' || !receipt.memberId) {
        throw normalizeTypedError({
          code: 'MEMBER_RESPONSE_INVALID',
          category: 'protocol',
          message: 'Member creation did not return a stable member receipt.',
          retryable: false,
        }, 'MEMBER_RESPONSE_INVALID')
      }
      if (!localGroupScopeChanged(entry, scope)) {
        setWorkspaceLocalGroupResult(entry, 'member', { status: 'success', message: 'Member created.' })
        await loadWorkspace(workspaceId)
      }
      return { ok: true, receipt }
    } catch (error) {
      const typed = preserveLocalGroupError(error, 'MEMBER_CREATION_FAILED')
      if (!localGroupScopeChanged(entry, scope)) {
        setWorkspaceLocalGroupResult(entry, 'member', {
          status: 'error',
          message: typed.message,
          error: typed,
        })
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: false, error: typed }
    } finally {
      entry.localGroupPending = { ...entry.localGroupPending, member: false }
      syncActiveWorkspaceProjection()
      notify()
      render()
    }
  }

  async function configureMemberRuntime(detail = {}) {
    const workspaceId = detail.workspaceId || state.activeWorkspaceId
    if (!workspaceId) {
      return { ok: false, error: workspaceSelectionRequiredError() }
    }
    if (!daemonApi || typeof daemonApi.configureMemberRuntime !== 'function') {
      return { ok: false, error: daemonUnavailableError('Runtime configuration port is not configured.') }
    }

    const entry = ensureWorkspaceEntry(workspaceId)
    const memberId = detail.memberId || entry.selectedMemberId
    if (!memberId) {
      return { ok: false, error: normalizeTypedError({
        code: 'MEMBER_SELECTION_REQUIRED',
        category: 'validation',
        message: 'Select a member before configuring its runtime.',
        retryable: false,
      }, 'MEMBER_SELECTION_REQUIRED') }
    }

    const scope = makeLocalGroupScope(entry, memberId)
    setMemberLocalGroupPending(entry, memberId, 'runtime', true)
    syncActiveWorkspaceProjection()
    notify()
    render()

    try {
      const receipt = await daemonApi.configureMemberRuntime({
        workspaceId,
        memberId,
        machineId: detail.machineId,
        hostKind: detail.hostKind,
        agentKind: detail.agentKind,
        launchProfileRef: detail.launchProfileRef,
      })
      if (!receipt || typeof receipt !== 'object' || receipt.memberId !== memberId) {
        throw normalizeTypedError({
          code: 'RUNTIME_RESPONSE_INVALID',
          category: 'protocol',
          message: 'Runtime configuration did not return the selected member receipt.',
          retryable: false,
        }, 'RUNTIME_RESPONSE_INVALID')
      }
      if (!localGroupScopeChanged(entry, scope)) {
        setMemberLocalGroupResult(entry, memberId, { status: 'success', message: 'Runtime configured.' })
        await loadWorkspace(workspaceId)
      }
      return { ok: true, receipt }
    } catch (error) {
      const typed = preserveLocalGroupError(error, 'RUNTIME_CONFIGURATION_FAILED')
      if (!localGroupScopeChanged(entry, scope)) {
        setMemberLocalGroupResult(entry, memberId, {
          status: 'error',
          message: typed.message,
          error: typed,
        })
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: false, error: typed }
    } finally {
      setMemberLocalGroupPending(entry, memberId, 'runtime', false)
      syncActiveWorkspaceProjection()
      notify()
      render()
    }
  }

  async function bindMemberSession(detail = {}) {
    const workspaceId = detail.workspaceId || state.activeWorkspaceId
    if (!workspaceId) {
      return { ok: false, error: workspaceSelectionRequiredError() }
    }
    if (!daemonApi || typeof daemonApi.bindMemberSession !== 'function') {
      return { ok: false, error: daemonUnavailableError('Session binding port is not configured.') }
    }

    const entry = ensureWorkspaceEntry(workspaceId)
    const memberId = detail.memberId || entry.selectedMemberId
    if (!memberId) {
      return { ok: false, error: normalizeTypedError({
        code: 'MEMBER_SELECTION_REQUIRED',
        category: 'validation',
        message: 'Select a member before binding a session.',
        retryable: false,
      }, 'MEMBER_SELECTION_REQUIRED') }
    }

    const scope = makeLocalGroupScope(entry, memberId)
    setMemberLocalGroupPending(entry, memberId, 'binding', true)
    syncActiveWorkspaceProjection()
    notify()
    render()

    try {
      const sessionId = String(detail.sessionId ?? '').trim()
      const anchor = String(detail.anchor ?? '').trim()
      if (sessionId === '' || anchor === '') {
        throw normalizeTypedError({
          code: 'BINDING_TARGET_REQUIRED',
          category: 'validation',
          message: 'Session ID and pane anchor are required.',
          retryable: false,
        }, 'BINDING_TARGET_REQUIRED')
      }

      const projection = await loadMemberRuntimeProjection(workspaceId, memberId)
      if (localGroupScopeChanged(entry, scope)) {
        return { ok: false, error: normalizeTypedError({
          code: 'LOCAL_GROUP_SCOPE_CHANGED',
          category: 'validation',
          message: 'The selected workspace or member changed during this request.',
          retryable: false,
        }, 'LOCAL_GROUP_SCOPE_CHANGED') }
      }
      const expectedGeneration = projection?.bindingGeneration
      if (!Number.isInteger(expectedGeneration)) {
        throw normalizeTypedError({
          code: 'BINDING_GENERATION_UNAVAILABLE',
          category: 'validation',
          message: 'The authoritative binding generation is not loaded.',
          retryable: false,
        }, 'BINDING_GENERATION_UNAVAILABLE')
      }
      const receipt = await daemonApi.bindMemberSession({
        workspaceId,
        memberId,
        sessionId,
        anchor,
        expectedGeneration,
        ...(detail.terminalTarget !== undefined ? { terminalTarget: detail.terminalTarget } : {}),
      })
      if (!receipt || typeof receipt !== 'object' || receipt.memberId !== memberId) {
        throw normalizeTypedError({
          code: 'BINDING_RESPONSE_INVALID',
          category: 'protocol',
          message: 'Session binding did not return the selected member receipt.',
          retryable: false,
        }, 'BINDING_RESPONSE_INVALID')
      }
      setMemberLocalGroupResult(entry, memberId, { status: 'success', message: 'Session bound.' })
      await loadWorkspace(workspaceId)
      return { ok: true, receipt }
    } catch (error) {
      const typed = preserveLocalGroupError(error, 'SESSION_BINDING_FAILED')
      if (!localGroupScopeChanged(entry, scope)) {
        setMemberLocalGroupResult(entry, memberId, {
          status: 'error',
          message: typed.message,
          error: typed,
        })
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: false, error: typed }
    } finally {
      setMemberLocalGroupPending(entry, memberId, 'binding', false)
      syncActiveWorkspaceProjection()
      notify()
      render()
    }
  }

  async function restoreMemberBinding(detail = {}) {
    const workspaceId = detail.workspaceId || state.activeWorkspaceId
    if (!workspaceId) {
      return { ok: false, error: workspaceSelectionRequiredError() }
    }
    if (!daemonApi || typeof daemonApi.restoreMemberBinding !== 'function') {
      return { ok: false, error: daemonUnavailableError('Binding verification port is not configured.') }
    }

    const entry = ensureWorkspaceEntry(workspaceId)
    const memberId = detail.memberId || entry.selectedMemberId
    if (!memberId) {
      return { ok: false, error: normalizeTypedError({
        code: 'MEMBER_SELECTION_REQUIRED',
        category: 'validation',
        message: 'Select a member before verifying its saved binding.',
        retryable: false,
      }, 'MEMBER_SELECTION_REQUIRED') }
    }

    const scope = makeLocalGroupScope(entry, memberId)
    setMemberLocalGroupPending(entry, memberId, 'restore', true)
    syncActiveWorkspaceProjection()
    notify()
    render()

    try {
      const projection = await loadMemberRuntimeProjection(workspaceId, memberId)
      if (localGroupScopeChanged(entry, scope)) {
        return { ok: false, error: normalizeTypedError({
          code: 'LOCAL_GROUP_SCOPE_CHANGED',
          category: 'validation',
          message: 'The selected workspace or member changed during this request.',
          retryable: false,
        }, 'LOCAL_GROUP_SCOPE_CHANGED') }
      }
      if (!projection || !Number.isInteger(projection.bindingGeneration)) {
        throw normalizeTypedError({
          code: 'BINDING_GENERATION_UNAVAILABLE',
          category: 'validation',
          message: 'The authoritative binding generation is not loaded.',
          retryable: false,
        }, 'BINDING_GENERATION_UNAVAILABLE')
      }
      const machineId = projection.runtime?.machineId
      if (typeof machineId !== 'string' || machineId === '') {
        throw normalizeTypedError({
          code: 'BINDING_MACHINE_UNAVAILABLE',
          category: 'validation',
          message: 'The authoritative runtime machine is not loaded.',
          retryable: false,
        }, 'BINDING_MACHINE_UNAVAILABLE')
      }
      const receipt = await daemonApi.restoreMemberBinding({
        workspaceId,
        memberId,
        machineId,
        expectedGeneration: projection.bindingGeneration,
      })
      if (!receipt || typeof receipt !== 'object' || receipt.restored !== true) {
        throw normalizeTypedError({
          code: 'RESTORE_RESPONSE_INVALID',
          category: 'protocol',
          message: 'Binding verification did not return a verification receipt.',
          retryable: false,
        }, 'RESTORE_RESPONSE_INVALID')
      }
      setMemberLocalGroupResult(entry, memberId, { status: 'success', message: 'Binding verified.' })
      await loadWorkspace(workspaceId)
      return { ok: true, receipt }
    } catch (error) {
      const typed = preserveLocalGroupError(error, 'BINDING_VERIFICATION_FAILED')
      if (!localGroupScopeChanged(entry, scope)) {
        setMemberLocalGroupResult(entry, memberId, {
          status: 'error',
          message: typed.message,
          error: typed,
        })
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: false, error: typed }
    } finally {
      setMemberLocalGroupPending(entry, memberId, 'restore', false)
      syncActiveWorkspaceProjection()
      notify()
      render()
    }
  }

  async function dispatchAction(action, detail = {}) {
    switch (action) {
      case 'navigate':
        return navigate(detail.route, { workspaceId: detail.workspaceId || state.activeWorkspaceId })
      case 'open-board':
        state.navigationMemberId = detail.memberId || null
        return navigate('board', { workspaceId: detail.workspaceId || state.activeWorkspaceId })
      case 'open-tickets':
        state.navigationMemberId = detail.memberId || null
        return navigate('tickets', { workspaceId: detail.workspaceId || state.activeWorkspaceId })
      case 'toggle-mobile-nav':
        state.mobileNavOpen = !state.mobileNavOpen
        notify()
        render()
        return app
      case 'quick-switch-workspace':
      case 'select-workspace': {
        const nextWsId = detail.workspaceId !== undefined ? detail.workspaceId : state.activeWorkspaceId
        state.explicitRequestedWorkspaceId = nextWsId
        await loadWorkspace(nextWsId)
        return app
      }
      case 'toggle-workspace-overflow':
        state.workspaceOverflowOpen = !state.workspaceOverflowOpen
        render()
        return app
      case 'filter-tickets': {
        const targetWsId = detail.workspaceId || state.activeWorkspaceId
        if (!targetWsId) return app
        const requestedFilter = detail.filter || detail.status || 'all'
        if (!SUPPORTED_TICKET_FILTERS.includes(requestedFilter)) return app
        const entry = ensureWorkspaceEntry(targetWsId)
        entry.activeTicketFilter = requestedFilter
        if (state.activeWorkspaceId === targetWsId) {
          state.activeTicketFilter = entry.activeTicketFilter
        }
        if (daemonApi && typeof daemonApi.listTickets === 'function') {
          const seq = ++entry.requestSeq
          await loadWorkspaceScopedResources(targetWsId, seq)
        } else {
          syncActiveWorkspaceProjection()
          notify()
          render()
        }
        return app
      }
      case 'open-workspace-ticket': {
        const targetWsId = detail.workspaceId || state.activeWorkspaceId
        if (targetWsId) {
          const entry = ensureWorkspaceEntry(targetWsId)
          entry.selectedTicketId = detail.ticketId || entry.selectedTicketId
        }
        await navigate('tickets', { workspaceId: targetWsId })
        return app
      }
      case 'create-group':
      case 'create-local-group':
        return createLocalGroupGroup({
          ...detail,
          workspaceId: detail.workspaceId || state.activeWorkspaceId,
        })
      case 'create-member':
      case 'create-local-member':
        return createLocalGroupMember({
          ...detail,
          workspaceId: detail.workspaceId || state.activeWorkspaceId,
        })
      case 'configure-member-runtime':
      case 'configure-runtime':
        return configureMemberRuntime({
          ...detail,
          workspaceId: detail.workspaceId || state.activeWorkspaceId,
          memberId: detail.memberId || state.selectedMemberId,
        })
      case 'bind-member-session':
      case 'bind-session':
        return bindMemberSession({
          ...detail,
          workspaceId: detail.workspaceId || state.activeWorkspaceId,
          memberId: detail.memberId || state.selectedMemberId,
        })
      case 'restore-member-binding':
      case 'verify-member-binding':
        return restoreMemberBinding({
          ...detail,
          workspaceId: detail.workspaceId || state.activeWorkspaceId,
          memberId: detail.memberId || state.selectedMemberId,
        })
      case 'filter-members-by-machine': {
        const filter = String(detail.machineId ?? detail.value ?? '')
        state.machineFilter = filter
        if (state.activeWorkspaceId) {
          ensureWorkspaceEntry(state.activeWorkspaceId).machineFilter = filter
        }
        syncActiveWorkspaceProjection()
        render()
        return app
      }
      case 'start-agent':
      case 'resume-agent':
        return {
          ok: false,
          error: normalizeTypedError({
            code: action === 'start-agent' ? 'AGENT_START_UNSUPPORTED' : 'AGENT_RESUME_UNSUPPORTED',
            category: 'unsupported',
            message: 'Agent start and resume are not supported by this daemon composition.',
            retryable: false,
          }, action === 'start-agent' ? 'AGENT_START_UNSUPPORTED' : 'AGENT_RESUME_UNSUPPORTED'),
        }
      case 'create-goal':
      case 'create-workspace-goal':
        return createWorkspaceGoal({
          workspaceId: detail.workspaceId || state.activeWorkspaceId,
          title: detail.title || 'Workspace Milestone Goal',
          ownerMemberId: detail.ownerMemberId,
        })
      case 'report-ticket':
      case 'create-ticket':
        return createOrReportTicket({
          workspaceId: detail.workspaceId || state.activeWorkspaceId,
          title: detail.title || 'Workspace ticket',
          description: detail.description || '',
          priority: detail.priority ?? 0,
          goalId: detail.goalId || state.selectedGoalId,
          ownerMemberId: detail.ownerMemberId || (state.ownerMemberSelected ? state.selectedMemberId : null),
        })
      case 'append-ticket-report':
        return appendWorkspaceTicketReport({
          workspaceId: detail.workspaceId || state.activeWorkspaceId,
          ticketId: detail.ticketId || state.selectedTicketId,
          body: detail.body || '',
          reportKind: detail.reportKind || 'status',
        })
      case 'transition-ticket':
        return transitionWorkspaceTicket({
          workspaceId: detail.workspaceId || state.activeWorkspaceId,
          ticketId: detail.ticketId || state.selectedTicketId,
          transition: detail.transition || detail.nextStatus || 'review',
        })
      case 'toggle-property':
        await toggleProperty(detail.windowId, detail.memberId)
        return app
      case 'save-properties':
      case 'submit-form': {
        if (detail.formId === 'workspace-group-create-form') {
          return createLocalGroupGroup({
            ...detail,
            workspaceId: detail.workspaceId || state.activeWorkspaceId,
          })
        }
        if (detail.formId === 'workspace-member-create-form') {
          return createLocalGroupMember({
            ...detail,
            workspaceId: detail.workspaceId || state.activeWorkspaceId,
          })
        }
        if (detail.formId === 'workspace-runtime-form') {
          return configureMemberRuntime({
            ...detail,
            workspaceId: detail.workspaceId || state.activeWorkspaceId,
            memberId: detail.memberId || state.selectedMemberId,
          })
        }
        if (detail.formId === 'workspace-binding-form') {
          return bindMemberSession({
            ...detail,
            workspaceId: detail.workspaceId || state.activeWorkspaceId,
            memberId: detail.memberId || state.selectedMemberId,
          })
        }
        if (detail.formId === 'ticket-report-form') {
          return createOrReportTicket({
            workspaceId: detail.workspaceId || state.activeWorkspaceId,
            title: detail.title || 'Reported ticket',
            description: detail.description || '',
            goalId: detail.goalId || state.selectedGoalId,
            ownerMemberId: detail.ownerMemberId,
            priority: detail.priority ?? 0,
          })
        }
        if (detail.formId === 'ticket-append-report-form') {
          return appendWorkspaceTicketReport({
            workspaceId: detail.workspaceId || state.activeWorkspaceId,
            ticketId: detail.ticketId || state.selectedTicketId,
            body: detail.body || '',
            reportKind: detail.reportKind || 'status',
          })
        }
        const resolvedMemberId = detail.memberId
          || (detail.windowId ? propertyController.openWindowMemberMap?.get?.(detail.windowId) : null)
          || state.selectedMemberId
          || state.members[0]?.memberId
        if (!resolvedMemberId) {
          state.lastError = daemonUnavailableError()
          render()
          return { ok: false, error: state.lastError }
        }
        const stateForMember = propertyController.getMemberState(resolvedMemberId)
        return saveProperties(resolvedMemberId, stateForMember.draft || detail.patch || {})
      }
      case 'cancel-form': {
        if (detail.windowId) {
          state.openPropertyByWindow[detail.windowId] = false
          propertyController.closeWindowProperties(detail.windowId)
        }
        render()
        return app
      }
      case 'update-property-draft':
        propertyController.updateDraft(detail.memberId, detail.patch || {})
        render()
        return app
      case 'toggle-window-overflow':
      case 'open-overflow':
        state.overflowOpenByWindow[detail.windowId] = !state.overflowOpenByWindow[detail.windowId]
        render()
        return app
      case 'apply-layout-operation': {
        const result = await sessionController.applyLayoutOperation(state.activeWorkspaceId, detail.operation || detail)
        if (result.ok) {
          state.layout = result.layout
          if (state.activeWorkspaceId) {
            ensureWorkspaceEntry(state.activeWorkspaceId).layout = result.layout
          }
          notify()
          render()
        } else {
          state.lastError = result.error
          render()
        }
        return result
      }
      case 'drag-border':
        return dispatchAction('apply-layout-operation', { kind: 'dragBorder', ...detail })
      case 'pan-zoom-preview':
        return dispatchAction('apply-layout-operation', { kind: 'panZoomPreview', ...detail })
      case 'preview-zoom-in':
        return dispatchAction('apply-layout-operation', { kind: 'panZoomPreview', zoomFactor: 1.2 })
      case 'preview-zoom-out':
        return dispatchAction('apply-layout-operation', { kind: 'panZoomPreview', zoomFactor: 0.8 })
      case 'preview-pan-up':
        return dispatchAction('apply-layout-operation', { kind: 'panZoomPreview', deltaX: 0, deltaY: -24, zoomFactor: 1 })
      case 'preview-pan-down':
        return dispatchAction('apply-layout-operation', { kind: 'panZoomPreview', deltaX: 0, deltaY: 24, zoomFactor: 1 })
      case 'preview-pan-left':
        return dispatchAction('apply-layout-operation', { kind: 'panZoomPreview', deltaX: -24, deltaY: 0, zoomFactor: 1 })
      case 'preview-pan-right':
        return dispatchAction('apply-layout-operation', { kind: 'panZoomPreview', deltaX: 24, deltaY: 0, zoomFactor: 1 })
      case 'preview-zoom-reset':
        if (state.layout) {
          state.layout.previewViewport = { zoom: 1, panX: 0, panY: 0 }
          await layoutStore.saveLayout(state.layout)
        }
        notify()
        render()
        return app
      case 'switch-mobile-mode':
        await dispatchAction('apply-layout-operation', { kind: 'switchMobileMode', mobileMode: detail.mobileMode || detail.mode || 'preview' })
        return app
      case 'focus-prev-member':
        await dispatchAction('apply-layout-operation', { kind: 'stepMobileFocus', direction: 'prev' })
        return app
      case 'focus-next-member':
        await dispatchAction('apply-layout-operation', { kind: 'stepMobileFocus', direction: 'next' })
        return app
      case 'return-to-preview':
        await dispatchAction('apply-layout-operation', { kind: 'switchMobileMode', mobileMode: 'preview' })
        return app
      case 'enter-member-focus': {
        const memberId = detail.memberId || state.members[0]?.memberId
        await dispatchAction('apply-layout-operation', { kind: 'enterMemberFocus', memberId })
        return app
      }
      case 'promote-primary': {
        const result = await dispatchAction('apply-layout-operation', { kind: 'promotePrimary', memberId: detail.memberId })
        return result
      }
      case 'remove-stale-member': {
        if (detail.memberId) {
          state.layout = await layoutStore.removeStaleMember('acc-default', state.activeWorkspaceId, detail.memberId, state.members)
          state.members = state.members.filter((m) => m.memberId !== detail.memberId)
          state.membersLoadable = { status: 'ready', value: state.members, observedAt: nowIso(), freshness: 'fresh', error: null }
          if (state.activeWorkspaceId) {
            const entry = ensureWorkspaceEntry(state.activeWorkspaceId)
            entry.layout = state.layout
            entry.members = state.members
            entry.membersLoadable = state.membersLoadable
          }
          notify()
          render()
        }
        return app
      }
      case 'send-terminal-input':
        return sendTerminalInput(detail.memberId, detail.data || '')
      case 'send-member-message':
        return sendMessage(detail.memberId || detail.recipientMemberId, detail.body || '', { workspaceId: detail.workspaceId || state.activeWorkspaceId })
      case 'select-member':
      case 'toggle-member':
        if (state.activeWorkspaceId) {
          const entry = ensureWorkspaceEntry(state.activeWorkspaceId)
          if (String(entry.selectedMemberId ?? '') !== String(detail.memberId ?? '')) {
            entry.localGroupScopeEpoch = Number(entry.localGroupScopeEpoch || 0) + 1
          }
        }
        state.selectedMemberId = detail.memberId
        state.ownerMemberSelected = true
        if (state.activeWorkspaceId) {
          const entry = ensureWorkspaceEntry(state.activeWorkspaceId)
          entry.selectedMemberId = detail.memberId
          entry.ownerMemberSelected = true
          if (detail.memberId) {
            await loadMemberRuntimeProjection(state.activeWorkspaceId, detail.memberId)
          }
          if (state.activeRoute === 'board') {
            const seq = ++entry.requestSeq
            await loadWorkspaceScopedResources(state.activeWorkspaceId, seq)
            return app
          }
        }
        render()
        return app
      case 'select-goal':
        state.selectedGoalId = detail.goalId
        if (state.activeWorkspaceId) {
          ensureWorkspaceEntry(state.activeWorkspaceId).selectedGoalId = detail.goalId
        }
        render()
        return app
      case 'select-ticket':
        state.selectedTicketId = detail.ticketId
        if (state.activeWorkspaceId) {
          ensureWorkspaceEntry(state.activeWorkspaceId).selectedTicketId = detail.ticketId
        }
        render()
        return app
      case 'connect-machine':
      case 'recover-machine':
      case 'disconnect-machine':
        return runMachineConnectionAction(detail.machineId, action)
      case 'list-machine-sessions':
        return loadMachineSessions(detail.machineId)
      case 'retry-error':
      case 'retry-form':
        state.lastError = null
        if (state.activeWorkspaceId) {
          const entry = ensureWorkspaceEntry(state.activeWorkspaceId)
          entry.lastError = null
          entry.transitionError = null
        }
        await loadWorkspaces()
        await loadBootstrapSurface()
        await loadWorkspace(state.activeWorkspaceId)
        render()
        return app
      default:
        return { ok: false, error: normalizeTypedError(new Error(`Unsupported action ${action}`), 'UI_ACTION_UNSUPPORTED') }
    }
  }

  function attachRoot(root) {
    if (!root) return
    state.mountedRoot = root
    const doc = root.ownerDocument || globalThis.document
    state.document = doc
    const win = doc?.defaultView || (typeof window !== 'undefined' ? window : null)
    if (win && typeof win.innerWidth === 'number' && win.innerWidth > 0 && viewportWidth === null) {
      state.viewportWidth = win.innerWidth
    }
    if (win && typeof win.innerHeight === 'number' && win.innerHeight > 0 && viewportHeight === null) {
      state.viewportHeight = win.innerHeight
    }
    if (win?.navigator?.userAgent && userAgent === null) {
      state.userAgent = win.navigator.userAgent
    }
    state.viewportMode = computeViewportMode({
      width: state.viewportWidth,
      height: state.viewportHeight,
      userAgent: state.userAgent,
    })

    render()
    if (!doc) return

    if (root.__ztermV2Handler) root.removeEventListener('click', root.__ztermV2Handler)
    if (root.__ztermV2InputHandler) root.removeEventListener('input', root.__ztermV2InputHandler)
    if (root.__ztermV2PointerDownHandler) root.removeEventListener('pointerdown', root.__ztermV2PointerDownHandler)
    if (win && root.__ztermV2ResizeHandler) {
      win.removeEventListener('resize', root.__ztermV2ResizeHandler)
      win.removeEventListener('orientationchange', root.__ztermV2ResizeHandler)
    }
    if (win && root.__ztermV2HashHandler) {
      win.removeEventListener('hashchange', root.__ztermV2HashHandler)
    }

    const resolveAttr = (element, attrName) => {
      const direct = element.getAttribute?.(attrName)
      if (direct != null) return direct
      const ancestor = element.closest?.(`[${attrName}]`)
      return ancestor ? ancestor.getAttribute(attrName) : null
    }

    const onClick = (event) => {
      const target = event.target?.closest?.('[data-action]')
      if (!target) return
      const action = target.getAttribute('data-action')
      const detail = {}
      for (const attr of ['windowId', 'memberId', 'workspaceId', 'route', 'ticketId', 'goalId', 'machineId', 'mode', 'mobileMode', 'formId', 'filter', 'status', 'transition']) {
        const key = attr.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)
        const value = resolveAttr(target, `data-${key}`)
        if (value != null) detail[attr] = value
      }
      if (action === 'submit-form' && detail.formId === 'ticket-report-form') {
        const formEl = target.closest?.('form') || root.querySelector?.('#ticket-report-form')
        detail.title = formEl?.querySelector?.('[name="ticketTitle"]')?.value || ''
        detail.description = formEl?.querySelector?.('[name="ticketDescription"]')?.value || ''
        detail.goalId = formEl?.querySelector?.('[name="ticketGoalId"]')?.value || ''
        detail.ownerMemberId = formEl?.querySelector?.('[name="ticketOwnerMemberId"]')?.value || ''
        detail.priority = Number(formEl?.querySelector?.('[name="ticketPriority"]')?.value || 0)
      }
      if (action === 'submit-form' && detail.formId === 'ticket-append-report-form') {
        const formEl = target.closest?.('form') || root.querySelector?.('#ticket-append-report-form')
        detail.body = formEl?.querySelector?.('[name="ticketReportBody"]')?.value || ''
        detail.reportKind = formEl?.querySelector?.('[name="ticketReportKind"]')?.value || 'status'
      }
      if (action === 'create-workspace-goal') {
        const formEl = target.closest?.('form') || root.querySelector?.('#board-goal-form')
        detail.title = formEl?.querySelector?.('[name="goalTitle"]')?.value || ''
        detail.ownerMemberId = formEl?.querySelector?.('[name="goalOwnerMemberId"]')?.value || ''
      }
      if (action === 'submit-form' && detail.formId === 'workspace-group-create-form') {
        const formEl = target.closest?.('form') || root.querySelector?.('#workspace-group-create-form')
        detail.name = formEl?.querySelector?.('[name="groupName"]')?.value || ''
        detail.parentGroupId = formEl?.querySelector?.('[name="groupParentId"]')?.value || null
      }
      if (action === 'submit-form' && detail.formId === 'workspace-member-create-form') {
        const formEl = target.closest?.('form') || root.querySelector?.('#workspace-member-create-form')
        detail.name = formEl?.querySelector?.('[name="memberName"]')?.value || ''
        detail.groupId = formEl?.querySelector?.('[name="memberGroupId"]')?.value || ''
      }
      if (action === 'submit-form' && detail.formId === 'workspace-runtime-form') {
        const formEl = target.closest?.('form') || root.querySelector?.('#workspace-runtime-form')
        detail.machineId = formEl?.querySelector?.('[name="runtimeMachineId"]')?.value || ''
        detail.hostKind = formEl?.querySelector?.('[name="runtimeHostKind"]')?.value || ''
        detail.agentKind = formEl?.querySelector?.('[name="runtimeAgentKind"]')?.value || ''
        detail.launchProfileRef = formEl?.querySelector?.('[name="runtimeLaunchProfileRef"]')?.value || ''
      }
      if (action === 'submit-form' && detail.formId === 'workspace-binding-form') {
        const formEl = target.closest?.('form') || root.querySelector?.('#workspace-binding-form')
        detail.sessionId = formEl?.querySelector?.('[name="bindingSessionId"]')?.value || ''
        detail.anchor = formEl?.querySelector?.('[name="bindingAnchor"]')?.value || ''
      }
      event.preventDefault?.()
      void dispatchAction(action, detail)
    }

    const onInput = (event) => {
      const target = event.target
      if (!target) return
      if (target.getAttribute?.('data-action') === 'filter-members-by-machine') {
        void dispatchAction('filter-members-by-machine', { value: target.value })
        return
      }
      const field = target.getAttribute?.('data-property-field') || target.getAttribute?.('data-field') || target.getAttribute?.('name')
      const memberId = resolveAttr(target, 'data-member-id')
      if (field && memberId && target.closest?.('[data-component="property-panel"]')) {
        propertyController.updateDraft(memberId, { [field]: target.value })
      }
    }

    const onPointerDown = (event) => {
      const handle = event.target?.closest?.('[data-resize-handle], [data-splitter]')
      if (!handle) return
      const startX = event.clientX
      const startY = event.clientY
      const edge = handle.getAttribute('data-resize-handle') || handle.getAttribute('data-edge') || 'e'
      const splitter = handle.getAttribute('data-splitter')
      const windowId = resolveAttr(handle, 'data-window-id') || (splitter === 'vertical-main' ? 'window-primary' : null)
      const rowIndex = Number(resolveAttr(handle, 'data-row-index') ?? 0)
      event.preventDefault?.()

      const onPointerUp = (upEvent) => {
        doc.removeEventListener('pointerup', onPointerUp)
        const deltaX = (upEvent.clientX ?? startX) - startX
        const deltaY = (upEvent.clientY ?? startY) - startY
        if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
          void dispatchAction('drag-border', {
            windowId,
            edge: splitter === 'horizontal-peer-row' ? 's' : edge,
            rowIndex,
            deltaX,
            deltaY,
            containerWidth: state.viewportWidth || 1280,
            containerHeight: state.viewportHeight || 760,
          })
        }
      }
      doc.addEventListener('pointerup', onPointerUp, { once: true })
    }

    const onWindowResize = () => {
      if (!win) return
      const nextW = typeof win.innerWidth === 'number' && win.innerWidth > 0 ? win.innerWidth : state.viewportWidth
      const nextH = typeof win.innerHeight === 'number' && win.innerHeight > 0 ? win.innerHeight : state.viewportHeight
      setViewport({
        width: nextW,
        height: nextH,
        userAgent: win.navigator?.userAgent ?? state.userAgent,
      })
    }

    const onHashChange = () => {
      if (suppressHashListener || !win?.location) return
      const parsed = parseNavigationTarget(win.location.hash, {
        fallbackRoute: state.activeRoute,
        fallbackWorkspaceId: state.activeWorkspaceId,
      })
      if (parsed.explicitWorkspace) {
        state.explicitRequestedWorkspaceId = parsed.workspaceId
      }
      void navigate(win.location.hash, {
        workspaceId: parsed.explicitWorkspace ? parsed.workspaceId : state.activeWorkspaceId,
      })
    }

    root.addEventListener('click', onClick)
    root.addEventListener('input', onInput)
    root.addEventListener('pointerdown', onPointerDown)
    root.__ztermV2Handler = onClick
    root.__ztermV2InputHandler = onInput
    root.__ztermV2PointerDownHandler = onPointerDown
    if (win) {
      win.addEventListener('resize', onWindowResize)
      win.addEventListener('orientationchange', onWindowResize)
      win.addEventListener('hashchange', onHashChange)
      root.__ztermV2ResizeHandler = onWindowResize
      root.__ztermV2HashHandler = onHashChange
    }
    if (typeof globalThis !== 'undefined') globalThis.__ZTERM_V2_WEBUI__ = app
  }

  const app = {
    state,
    ports: { daemonApi, terminalClient, deliveryClient, terminalViewportFactory, layoutStore },
    propertyController,
    sessionController,
    helpers,
    ready: null,
    render,
    renderPage: () => renderPage(),
    navigate,
    setViewport,
    dispatchAction,
    mount: attachRoot,
    getState: () => state,
    getViewModel: () => renderPage().model,
    loadWorkspace,
    loadWorkspaces,
    toggleProperty,
    saveProperties,
    sendMessage,
    sendTerminalInput,
    createOrReportTicket,
    transitionWorkspaceTicket,
    createWorkspaceGoal,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    destroy() {
      clearPendingFrameWatches()
      unsubscribeTerminalStatus?.()
      const win = state.document?.defaultView || (typeof window !== 'undefined' ? window : null)
      if (state.mountedRoot && state.document) {
        if (state.mountedRoot.__ztermV2Handler) state.mountedRoot.removeEventListener('click', state.mountedRoot.__ztermV2Handler)
        if (state.mountedRoot.__ztermV2InputHandler) state.mountedRoot.removeEventListener('input', state.mountedRoot.__ztermV2InputHandler)
        if (state.mountedRoot.__ztermV2PointerDownHandler) state.mountedRoot.removeEventListener('pointerdown', state.mountedRoot.__ztermV2PointerDownHandler)
        if (win && state.mountedRoot.__ztermV2ResizeHandler) {
          win.removeEventListener('resize', state.mountedRoot.__ztermV2ResizeHandler)
          win.removeEventListener('orientationchange', state.mountedRoot.__ztermV2ResizeHandler)
        }
        if (win && state.mountedRoot.__ztermV2HashHandler) {
          win.removeEventListener('hashchange', state.mountedRoot.__ztermV2HashHandler)
        }
      }
      for (const stash of terminalStashByMemberId.values()) {
        stash.remove()
      }
      terminalStashByMemberId.clear()
      listeners.clear()
    },
  }

  app.ready = initialize()
  return app
}

export { buildHelpers, memoryStorage, GLOBAL_ROUTES, WORKSPACE_ROUTES }
