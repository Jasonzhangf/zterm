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

function terminalStartingError() {
  return normalizeTypedError({
    code: 'TERMINAL_FRAME_PENDING',
    category: 'terminal',
    message: 'This terminal is attached and waiting for its first frame.',
    retryable: true,
  }, 'TERMINAL_FRAME_PENDING')
}

function workspaceSelectionRequiredError(message = 'Please select or create a workspace first.') {
  return normalizeTypedError({
    code: 'WORKSPACE_SELECTION_REQUIRED',
    category: 'validation',
    message,
    retryable: false,
  }, 'WORKSPACE_SELECTION_REQUIRED')
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
        membersLoadable: loadingLoadable(),
        goalsLoadable: loadingLoadable(),
        ticketsLoadable: loadingLoadable(),
        connectionsLoadable: loadingLoadable(),
        layout: null,
        selectedMemberId: null,
        selectedGoalId: null,
        selectedTicketId: null,
        activeTicketFilter: 'all',
        openPropertyByWindow: {},
        overflowOpenByWindow: {},
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
    membersLoadable: loadingLoadable(),
    connectionsLoadable: loadingLoadable(),
    layout: null,
    selectedMemberId: null,
    selectedGoalId: null,
    selectedTicketId: null,
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
    workspaceDataById,
    mountedRoot: null,
    document: null,
  }
  sessionController.setViewportMode(state.viewportMode)

  let initialized = false
  let suppressHashListener = false
  const listeners = new Set()

  function notify() {
    for (const listener of listeners) listener(state)
  }

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
      state.layout = null
      state.selectedMemberId = null
      state.selectedGoalId = null
      state.selectedTicketId = null
      state.activeTicketFilter = 'all'
      state.transitionPending = false
      state.transitionError = null
      state.openPropertyByWindow = {}
      state.overflowOpenByWindow = {}
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
    state.membersLoadable = entry.membersLoadable
    state.goalsLoadable = entry.goalsLoadable
    state.ticketsLoadable = entry.ticketsLoadable
    if (entry.connectionsLoadable.status !== 'loading' || state.connectionsLoadable.status === 'loading') {
      state.connectionsLoadable = entry.connectionsLoadable
    }
    state.layout = entry.layout
    state.selectedMemberId = entry.selectedMemberId
    state.selectedGoalId = entry.selectedGoalId
    state.selectedTicketId = entry.selectedTicketId
    state.activeTicketFilter = entry.activeTicketFilter || 'all'
    state.openPropertyByWindow = entry.openPropertyByWindow
    state.overflowOpenByWindow = entry.overflowOpenByWindow
    state.receipts = entry.receipts
    state.transfers = entry.transfers
  }

  // Delegate to the controller's single visible-set resolver so the attach
  // path and the render projection always agree on desktop 1+4, mobile focus,
  // and mobile preview.
  function visibleMemberIdsForProjection() {
    return sessionController.getVisibleMemberIds(state.activeWorkspaceId)
  }

  // Vv: the viewport-intersecting frame set. A frame counts only when its rect
  // clipped by the viewport (and, for peer cells, by the scroll grid) is both
  // wider and taller than 4 CSS pixels.
  const VIEWPORT_MIN_VISIBLE_PX = 4
  const appliedVisibleKeyByWorkspace = new Map()

  function clippedVisibleMemberIds() {
    const root = state.mountedRoot
    if (!root || typeof root.querySelectorAll !== 'function') return []
    const win = state.document && state.document.defaultView
    const vw = Number(state.viewportWidth) || (win && win.innerWidth) || 0
    const vh = Number(state.viewportHeight) || (win && win.innerHeight) || 0
    if (!(vw > 0) || !(vh > 0)) return []
    const grid = root.querySelector('[data-role="peer-scroll-grid"]')
    const gridRect = grid && typeof grid.getBoundingClientRect === 'function' ? grid.getBoundingClientRect() : null
    const peerClip = gridRect
      ? {
        left: Math.max(0, gridRect.left),
        top: Math.max(0, gridRect.top),
        right: Math.min(vw, gridRect.right),
        bottom: Math.min(vh, gridRect.bottom),
      }
      : { left: 0, top: 0, right: vw, bottom: vh }
    const seen = new Set()
    const visible = []
    let measured = false
    for (const frame of root.querySelectorAll('[data-component="window-frame"][data-member-id]')) {
      const memberId = String(frame.getAttribute('data-member-id') || '')
      if (!memberId || seen.has(memberId)) continue
      if (typeof frame.getBoundingClientRect !== 'function') continue
      const rect = frame.getBoundingClientRect()
      if (rect.width > 0 || rect.height > 0) measured = true
      const inGrid = Boolean(frame.closest && frame.closest('[data-role="peer-scroll-grid"]'))
      const clip = inGrid ? peerClip : { left: 0, top: 0, right: vw, bottom: vh }
      const width = Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left)
      const height = Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top)
      if (width > VIEWPORT_MIN_VISIBLE_PX && height > VIEWPORT_MIN_VISIBLE_PX) {
        seen.add(memberId)
        visible.push(memberId)
      }
    }
    // No layout engine (for example a jsdom mount) reports every rect as 0x0;
    // report that as "unmeasured" so the caller keeps the layout default rather
    // than suspending every pane.
    return measured ? visible : null
  }

  // Reconcile the mounted DOM's Vv with the controller. Runs after every mount
  // and after peer-grid scroll. When the set changes the controller attaches the
  // new visible panes and suspends the rest, then this re-renders once so the
  // bodies show the settled attached/starting/detached state.
  function reconcileViewportVisibleMembers() {
    const workspaceId = state.activeWorkspaceId
    if (!workspaceId || state.activeRoute !== 'sessions') return false
    if (typeof sessionController.setVisibleMembers !== 'function') return false
    const ids = clippedVisibleMemberIds()
    if (ids === null) return false
    const key = ids.join('\u0000')
    if (appliedVisibleKeyByWorkspace.get(workspaceId) === key) return false
    appliedVisibleKeyByWorkspace.set(workspaceId, key)
    Promise.resolve(sessionController.setVisibleMembers(workspaceId, ids))
      .then(() => {
        if (state.activeWorkspaceId !== workspaceId) return
        syncActiveWorkspaceProjection()
        notify()
        render()
      })
      .catch(() => {})
    return true
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
      } else if (terminalClient && !isVisible) {
        // Intentional offscreen secondary: it holds no stream. Show a compact
        // detached state instead of a misleading generic "not loaded" error.
        out[member.memberId] = `<div class="terminal-viewport" data-terminal-body="true" data-terminal-status="detached" data-member-id="${esc(member.memberId)}"><div class="v2-terminal-detached" role="status">Detached while offscreen. Scroll this window into view to attach it.</div></div>`
      } else {
        let err
        let terminalStatus
        if (!terminalClient) {
          err = terminalUnavailableError()
          terminalStatus = 'unavailable'
        } else if (handleError) {
          err = handleError
          terminalStatus = 'unavailable'
        } else {
          err = terminalStartingError()
          terminalStatus = 'starting'
        }
        const noticeHtml = renderErrorNotice(
          handleError && terminalClient
            ? {
                error: err,
                onRetryAction: 'retry-terminal',
                retryAttributes: { 'member-id': member.memberId },
                forceRetry: true,
              }
            : { error: err },
        ).html
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
      }, helpers)
    }
    if (state.activeRoute === 'workspaces') {
      return renderWorkspacesPage({
        ...state,
        workspacesLoadable: state.workspacesLoadable,
        membersLoadable: state.membersLoadable,
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

    const connReady = state.workspacesLoadable.status === 'ready' || state.connectionsLoadable.status === 'ready'
    const connStatus = connReady ? 'online' : (state.workspacesLoadable.status === 'loading' ? 'loading' : 'unavailable')
    const connDotClass = connReady ? 'dot-online' : (connStatus === 'loading' ? 'dot-busy' : 'dot-offline')
    const connLabel = connReady
      ? `${state.workspaces.length} Workspaces 已同步`
      : (connStatus === 'loading' ? '正在同步连接...' : 'Daemon 端口未就绪 (Unavailable)')

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
    if (typeof setInterval !== 'function') return
    const timer = setInterval(() => {
      if (!viewport.isConnected) {
        stop()
        return
      }
      if (frameCount() > 0) {
        notice.remove()
        stop()
      }
    }, 400)
    function stop() {
      clearInterval(timer)
      pendingFrameWatches.delete(stop)
    }
    pendingFrameWatches.add(stop)
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
      reconcileViewportVisibleMembers()
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

    if (entry.requestSeq === seq && state.activeWorkspaceId === workspaceId) {
      syncActiveWorkspaceProjection()
      notify()
      render()
    }
  }

  async function loadWorkspace(workspaceId) {
    state.activeWorkspaceId = workspaceId || null
    if (workspaceId) appliedVisibleKeyByWorkspace.delete(workspaceId)
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
      entry.connectionsLoadable = { ...entry.membersLoadable }
      entry.goalsLoadable = unavailableLoadable(err)
      entry.ticketsLoadable = unavailableLoadable(err)
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
    entry.members = value.members || []
    entry.layout = value.layout || entry.layout
    entry.membersLoadable = { status: 'ready', value: entry.members, observedAt: nowIso(), freshness: 'fresh', error: null }
    entry.selectedMemberId = entry.selectedMemberId || entry.members[0]?.memberId || null

    if (state.activeWorkspaceId === workspaceId) {
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

    if (daemonApi && typeof daemonApi.listConnections === 'function') {
      try {
        const connections = await daemonApi.listConnections({ workspaceId })
        if (entry.requestSeq === seq) {
          entry.connectionsLoadable = { status: 'ready', value: Array.isArray(connections) ? connections : [], observedAt: nowIso(), freshness: 'fresh', error: null }
        }
      } catch (error) {
        if (entry.requestSeq === seq) {
          entry.connectionsLoadable = unavailableLoadable(error)
        }
      }
    } else if (entry.requestSeq === seq) {
      entry.connectionsLoadable = {
        status: 'ready',
        value: state.workspaces.map((workspace) => ({
          machineId: workspace.workspaceId,
          name: workspace.name,
          address: workspace.address || workspace.workspaceId,
          status: workspace.status || 'unknown',
          freshness: workspace.freshness || (workspace.status === 'online' ? 'fresh' : 'stale'),
        })),
        observedAt: nowIso(),
        freshness: 'fresh',
        error: null,
      }
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
      state.connectionsLoadable = unavailableLoadable(typed)
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
      state.connectionsLoadable = unavailableLoadable(typed)
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
    notify()
    render()
    return app
  }

  function setViewport({ width, height, userAgent: nextUserAgent } = {}) {
    const previousViewportMode = state.viewportMode
    if (typeof width === 'number' && width > 0) state.viewportWidth = width
    if (typeof height === 'number' && height > 0) state.viewportHeight = height
    if (typeof nextUserAgent === 'string') state.userAgent = nextUserAgent
    state.viewportMode = computeViewportMode({
      width: state.viewportWidth,
      height: state.viewportHeight,
      userAgent: state.userAgent,
    })
    const reconcile = sessionController.setViewportMode(state.viewportMode)
    if (state.viewportMode === 'desktop') {
      state.mobileNavOpen = false
    }
    // Project the new viewport mode immediately. Stream attach/detach runs in
    // the background: waiting for it would leave the previous mobile focus DOM
    // on screen for up to the 8s attach timeout after a resize.
    syncActiveWorkspaceProjection()
    notify()
    render()
    if (previousViewportMode !== state.viewportMode && reconcile && typeof reconcile.then === 'function') {
      return reconcile.then(() => {
        syncActiveWorkspaceProjection()
        notify()
        render()
        return app
      })
    }
    return app
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

  async function createOrReportTicket({ workspaceId = state.activeWorkspaceId, title, description, priority = 'medium' } = {}) {
    if (!workspaceId) {
      const err = workspaceSelectionRequiredError()
      state.lastError = err
      notify()
      render()
      return { ok: false, error: err }
    }
    const entry = ensureWorkspaceEntry(workspaceId)
    if (!daemonApi || (typeof daemonApi.createTicket !== 'function' && typeof daemonApi.reportTicket !== 'function')) {
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
    try {
      const fn = daemonApi.createTicket || daemonApi.reportTicket
      const created = await fn.call(daemonApi, {
        workspaceId,
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
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: true, ticket: record }
    } catch (error) {
      const typed = normalizeTypedError(error, 'TICKET_REPORT_FAILED')
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
    try {
      const updated = await daemonApi.transitionTicket({ workspaceId, ticketId, transition: requestedTransition })
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
      if (state.activeWorkspaceId === workspaceId) {
        syncActiveWorkspaceProjection()
        notify()
        render()
      }
      return { ok: true, ticket: record }
    } catch (error) {
      const typed = normalizeTypedError(error, 'TICKET_TRANSITION_FAILED')
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

  async function createWorkspaceGoal({ workspaceId = state.activeWorkspaceId, title } = {}) {
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
      const created = await daemonApi.createGoal({ workspaceId, title: String(title || '') })
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
        const entry = ensureWorkspaceEntry(targetWsId)
        entry.activeTicketFilter = detail.filter || detail.status || 'all'
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
      case 'create-goal':
      case 'create-workspace-goal':
        return createWorkspaceGoal({ workspaceId: detail.workspaceId || state.activeWorkspaceId, title: detail.title || 'Workspace Milestone Goal' })
      case 'report-ticket':
      case 'create-ticket':
        return createOrReportTicket({
          workspaceId: detail.workspaceId || state.activeWorkspaceId,
          title: detail.title || 'Workspace ticket',
          description: detail.description || '',
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
        if (detail.formId === 'ticket-report-form') {
          return createOrReportTicket({
            workspaceId: detail.workspaceId || state.activeWorkspaceId,
            title: detail.title || 'Reported ticket',
            description: detail.description || '',
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
      case 'retry-terminal': {
        if (!detail.memberId) {
          return { ok: false, error: normalizeTypedError(new Error('A member id is required to retry a terminal.'), 'TERMINAL_MEMBER_REQUIRED') }
        }
        try {
          const handle = await sessionController.retryTerminalMember(state.activeWorkspaceId, detail.memberId)
          if (!handle || !HEALTHY_STATUSES.includes(handle.status)) {
            return { ok: false, error: normalizeTypedError(new Error('The terminal stream is still unavailable.'), 'TERMINAL_STREAM_UNAVAILABLE') }
          }
          syncActiveWorkspaceProjection()
          notify()
          render()
          return { ok: true, handle }
        } catch (error) {
          const typed = normalizeTypedError(error, 'TERMINAL_RETRY_FAILED')
          state.lastError = typed
          render()
          return { ok: false, error: typed }
        }
      }
      case 'send-member-message':
        return sendMessage(detail.memberId || detail.recipientMemberId, detail.body || '', { workspaceId: detail.workspaceId || state.activeWorkspaceId })
      case 'select-member':
      case 'toggle-member':
        state.selectedMemberId = detail.memberId
        if (state.activeWorkspaceId) {
          ensureWorkspaceEntry(state.activeWorkspaceId).selectedMemberId = detail.memberId
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
    sessionController.setViewportMode(state.viewportMode)

    render()
    if (!doc) return

    if (root.__ztermV2Handler) root.removeEventListener('click', root.__ztermV2Handler)
    if (root.__ztermV2InputHandler) root.removeEventListener('input', root.__ztermV2InputHandler)
    if (root.__ztermV2PointerDownHandler) root.removeEventListener('pointerdown', root.__ztermV2PointerDownHandler)
    if (root.__ztermV2ScrollHandler) root.removeEventListener('scroll', root.__ztermV2ScrollHandler, true)
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
      for (const attr of ['windowId', 'memberId', 'workspaceId', 'route', 'ticketId', 'goalId', 'mode', 'mobileMode', 'formId', 'filter', 'status', 'transition']) {
        const key = attr.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)
        const value = resolveAttr(target, `data-${key}`)
        if (value != null) detail[attr] = value
      }
      if (action === 'submit-form' && detail.formId === 'ticket-report-form') {
        const formEl = target.closest?.('form') || root.querySelector?.('#ticket-report-form')
        detail.title = formEl?.querySelector?.('[name="ticketTitle"]')?.value || ''
        detail.description = formEl?.querySelector?.('[name="ticketDescription"]')?.value || ''
      }
      if (action === 'create-workspace-goal') {
        const formEl = target.closest?.('form') || root.querySelector?.('#board-goal-form')
        detail.title = formEl?.querySelector?.('[name="goalTitle"]')?.value || ''
      }
      event.preventDefault?.()
      void dispatchAction(action, detail)
    }

    const onInput = (event) => {
      const target = event.target
      if (!target) return
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

    // Peer-grid scroll changes which panes intersect the viewport, so the
    // visible subscription set must be reconciled on scroll (scroll does not
    // bubble, hence the capture listener on the mount root).
    const onScroll = (event) => {
      const target = event.target
      if (target && typeof target.matches === 'function' && target.matches('[data-role="peer-scroll-grid"]')) {
        reconcileViewportVisibleMembers()
      }
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
    root.addEventListener('scroll', onScroll, true)
    root.__ztermV2Handler = onClick
    root.__ztermV2InputHandler = onInput
    root.__ztermV2PointerDownHandler = onPointerDown
    root.__ztermV2ScrollHandler = onScroll
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
      const win = state.document?.defaultView || (typeof window !== 'undefined' ? window : null)
      if (state.mountedRoot && state.document) {
        if (state.mountedRoot.__ztermV2Handler) state.mountedRoot.removeEventListener('click', state.mountedRoot.__ztermV2Handler)
        if (state.mountedRoot.__ztermV2InputHandler) state.mountedRoot.removeEventListener('input', state.mountedRoot.__ztermV2InputHandler)
        if (state.mountedRoot.__ztermV2PointerDownHandler) state.mountedRoot.removeEventListener('pointerdown', state.mountedRoot.__ztermV2PointerDownHandler)
        if (state.mountedRoot.__ztermV2ScrollHandler) state.mountedRoot.removeEventListener('scroll', state.mountedRoot.__ztermV2ScrollHandler, true)
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
