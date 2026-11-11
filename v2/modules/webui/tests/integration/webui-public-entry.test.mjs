import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createWebUIApp,
  memoryStorage,
  computeViewportMode,
  GLOBAL_ROUTES,
  WORKSPACE_ROUTES,
} from '../../src/app/app-shell.mjs'
import {
  ROUTES,
  parseNavigationTarget,
  resolveRoute,
  routeUrl,
} from '../../src/app/routes.mjs'
import { createDemoPorts, createDemoWebUIApp } from '../fixtures/demo-ports.mjs'
import { createDaemonApi } from '../../src/clients/daemon-api/index.mjs'
import { resolveProductionPorts } from '../../src/app/entry.mjs'
import { renderTicketList, renderTicketDetail } from '../../src/components/index.mjs'
import { renderTicketsPage } from '../../src/pages/tickets/index.mjs'

// I0 recovery: the formal production entry must resolve a real daemon API
// client instead of probing non-existent module paths and settling for null.
test('formal production entry resolves a real daemon API client without injected ports', async () => {
  const ports = await resolveProductionPorts({})
  assert.ok(ports.daemonApi, 'daemonApi must be a real client, not null')
  for (const method of ['sessionState', 'login', 'logout', 'listSessions', 'openTerminalStream', 'sendInput']) {
    assert.equal(typeof ports.daemonApi[method], 'function', `daemonApi.${method} must exist`)
  }
  assert.ok(ports.terminalClient, 'terminalClient must be a real pane client, not null')
  for (const method of ['attachSession', 'createSession', 'writeInput', 'disconnect']) {
    assert.equal(typeof ports.terminalClient[method], 'function', `terminalClient.${method} must exist`)
  }
  assert.equal(ports.terminalViewportFactory, null)
})

test('formal production entry reuses an injected daemon API and does not fabricate ports', async () => {
  const injected = createDaemonApi({ baseUrl: '' })
  const ports = await resolveProductionPorts({ daemonApi: injected })
  assert.equal(ports.daemonApi, injected)
  assert.ok(ports.terminalClient, 'terminalClient must wrap the injected daemon API')
  assert.notEqual(ports.terminalClient, injected)
  assert.equal(ports.terminalViewportFactory, null)
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('routes partition global vs workspace-scoped pages and resolve workspace deep links', () => {
  assert.deepEqual([...GLOBAL_ROUTES], ['setup', 'connections', 'workspaces'])
  assert.deepEqual([...WORKSPACE_ROUTES], ['sessions', 'board', 'tickets'])
  assert.deepEqual([...ROUTES], ['setup', 'connections', 'workspaces', 'sessions', 'board', 'tickets'])

  assert.equal(resolveRoute('#/sessions'), 'sessions')
  assert.equal(resolveRoute('/workspaces'), 'workspaces')
  assert.equal(resolveRoute('board'), 'board')
  assert.equal(resolveRoute('#/workspaces/ws-beta/tickets'), 'tickets')
  assert.equal(resolveRoute('#/workspaces/ws-gamma/board'), 'board')
  assert.equal(resolveRoute('#/unknown'), 'setup')

  assert.equal(routeUrl('tickets'), '#/tickets')
  assert.equal(routeUrl('tickets', 'ws-beta'), '#/workspaces/ws-beta/tickets')
  assert.equal(routeUrl('connections', 'ws-beta'), '#/connections')

  const parsedScoped = parseNavigationTarget('#/workspaces/ws-beta/board')
  assert.deepEqual(parsedScoped, {
    route: 'board',
    workspaceId: 'ws-beta',
    scope: 'workspace',
    explicitWorkspace: true,
  })
})

test('shell renders 3-tier sidebar navigation hierarchy, breadcrumb header, and zero manual Desktop/Mobile toggle buttons', async () => {
  const app = createDemoWebUIApp({ viewportWidth: 1440, viewportHeight: 900 })
  await app.ready

  const shell = app.render()
  assert.ok(shell.html.includes('id="app-sidebar"'))
  assert.ok(shell.html.includes('data-nav-zone="workspace-tree"'))
  assert.ok(!shell.html.includes('data-nav-zone="workspace-views"'))
  assert.ok(shell.html.includes('data-nav-zone="global-config"'))
  assert.ok(shell.html.includes('id="header-breadcrumb"'))
  assert.ok(shell.html.includes('id="mobile-nav-toggle-btn"'))
  assert.ok(!shell.html.includes('data-action="set-viewport-mode"'))
  assert.ok(!shell.html.includes('>Desktop</button>'))
  assert.ok(!shell.html.includes('>Mobile</button>'))

  // Hierarchical workspace tree depth classes
  assert.ok(shell.html.includes('data-depth="0"'))
  assert.ok(shell.html.includes('data-depth="1"'))
  assert.ok(shell.html.includes('data-depth="2"'))
})

test('auto viewport adaptation selects desktop vs mobile from UA + viewport dimensions/aspect ratio and preserves state across resize', async () => {
  assert.equal(computeViewportMode({ width: 1440, height: 900, userAgent: 'Mozilla/5.0 Macintosh' }), 'desktop')
  assert.equal(computeViewportMode({ width: 720, height: 900, userAgent: 'Mozilla/5.0 Macintosh' }), 'mobile')
  assert.equal(computeViewportMode({ width: 390, height: 844, userAgent: 'Mozilla/5.0 iPhone Mobile' }), 'mobile')
  assert.equal(computeViewportMode({ width: 844, height: 390, userAgent: 'Mozilla/5.0 iPhone Mobile' }), 'mobile')

  const app = createDemoWebUIApp({ viewportWidth: 1440, viewportHeight: 900 })
  await app.ready
  await app.navigate('sessions')
  assert.equal(app.state.viewportMode, 'desktop')

  const handleBefore = app.sessionController.getTerminalHandle('m-1')
  assert.ok(handleBefore)

  // Narrow desktop window (720x900) adapts to mobile layout without manual toggle
  app.setViewport({ width: 720, height: 900, userAgent: 'Mozilla/5.0 Macintosh' })
  assert.equal(app.state.viewportMode, 'mobile')
  assert.equal(app.state.activeWorkspaceId, 'ws-alpha')

  // Enter member focus on m-3, then resize to mobile landscape (844x390) and back to desktop wide (1440x900)
  await app.dispatchAction('enter-member-focus', { memberId: 'm-3' })
  assert.equal(app.state.layout.focusedMemberId, 'm-3')
  const handleFocused = app.sessionController.getTerminalHandle('m-3')
  assert.ok(handleFocused)
  const createCallsFocused = handleFocused.getSnapshot().createCalls
  assert.strictEqual(app.sessionController.getTerminalHandle('m-1'), handleBefore)
  assert.equal(handleBefore.getSnapshot().status, 'attached')
  assert.equal(handleBefore.getSnapshot().disconnectCalls, 0)

  app.setViewport({ width: 844, height: 390, userAgent: 'Mozilla/5.0 iPhone Mobile' })
  assert.equal(app.state.viewportMode, 'mobile')
  assert.equal(app.state.layout.focusedMemberId, 'm-3')

  app.setViewport({ width: 1440, height: 900, userAgent: 'Mozilla/5.0 Macintosh' })
  assert.equal(app.state.viewportMode, 'desktop')
  assert.equal(app.state.activeWorkspaceId, 'ws-alpha')
  assert.equal(app.state.layout.focusedMemberId, 'm-3')

  await app.dispatchAction('enter-member-focus', { memberId: 'm-1' })
  assert.equal(app.state.layout.focusedMemberId, 'm-1')
  assert.strictEqual(app.sessionController.getTerminalHandle('m-1'), handleBefore)

  const handleAfter = app.sessionController.getTerminalHandle('m-3')
  assert.equal(handleAfter, handleFocused)
  assert.equal(handleAfter.getSnapshot().createCalls, createCallsFocused)
  assert.equal(handleAfter.getSnapshot().disconnectCalls, 0)
})

test('per-workspace Board and Tickets isolate queries, filters, creation, and transitions across workspaces', async () => {
  const ports = createDemoPorts()
  const app = createDemoWebUIApp({ ...ports, viewportWidth: 1440, viewportHeight: 900 })
  await app.ready

  // 1. Alpha workspace board & tickets
  await app.navigate('board')
  let boardPage = app.renderPage()
  assert.equal(boardPage.model.activeWorkspaceId, 'ws-alpha')
  assert.ok(boardPage.html.includes('goal-alpha-webui'))
  assert.ok(!boardPage.html.includes('goal-beta-daemon'))

  await app.navigate('tickets')
  let ticketsPage = app.renderPage()
  assert.equal(ticketsPage.model.activeWorkspaceId, 'ws-alpha')
  assert.ok(ticketsPage.html.includes('T-101'))
  assert.ok(!ticketsPage.html.includes('T-201'))

  // 2. Switch to Beta workspace: only Beta goals & tickets appear
  await app.dispatchAction('select-workspace', { workspaceId: 'ws-beta' })
  ticketsPage = app.renderPage()
  assert.equal(ticketsPage.model.activeWorkspaceId, 'ws-beta')
  assert.ok(ticketsPage.html.includes('T-201'))
  assert.ok(ticketsPage.html.includes('T-202'))
  assert.ok(!ticketsPage.html.includes('T-101'))

  await app.navigate('board')
  boardPage = app.renderPage()
  assert.equal(boardPage.model.activeWorkspaceId, 'ws-beta')
  assert.ok(boardPage.html.includes('goal-beta-daemon'))
  assert.ok(!boardPage.html.includes('goal-alpha-webui'))

  // 3. Create ticket & filter tickets inside ws-beta: carries workspaceId: 'ws-beta' and does not leak to ws-alpha
  await app.navigate('tickets')
  const created = await app.dispatchAction('create-ticket', {
    workspaceId: 'ws-beta',
    title: 'Beta: New scoped ticket',
    description: 'Scoped to ws-beta only',
    ownerMemberId: 'b-1',
  })
  assert.equal(created.ok, true)
  assert.equal(created.ticket.workspaceId, 'ws-beta')
  assert.equal(ports.daemonApi.calls.createTicket.at(-1).workspaceId, 'ws-beta')

  await app.dispatchAction('filter-tickets', { workspaceId: 'ws-beta', filter: 'open' })
  assert.equal(ports.daemonApi.calls.listTickets.at(-1).workspaceId, 'ws-beta')
  assert.equal(ports.daemonApi.calls.listTickets.at(-1).status, 'open')
  ticketsPage = app.renderPage()
  assert.ok(ticketsPage.html.includes('T-201'))

  // Switch back to ws-alpha: ws-alpha tickets are untouched and filter is independent
  await app.dispatchAction('select-workspace', { workspaceId: 'ws-alpha' })
  ticketsPage = app.renderPage()
  assert.equal(ticketsPage.model.activeWorkspaceId, 'ws-alpha')
  assert.ok(ticketsPage.html.includes('T-101'))
  assert.ok(!ticketsPage.html.includes('Beta: New scoped ticket'))
})

test('ticket page zero-match filter shows an explicit empty detail and never falls back to unfiltered tickets', () => {
  const tickets = [
    { ticketId: 'T-101', workspaceId: 'ws-alpha', title: 'Alpha review ticket', status: 'review', allowedTransitions: ['close', 'reopen'] },
    { ticketId: 'T-102', workspaceId: 'ws-alpha', title: 'Alpha in-progress ticket', status: 'in-progress', allowedTransitions: ['review'] },
  ]
  const helpers = { renderTicketList, renderTicketDetail }

  const closed = renderTicketsPage({
    workspaces: [],
    activeWorkspaceId: 'ws-alpha',
    ticketsLoadable: { status: 'ready', value: tickets, error: null },
    activeFilter: 'closed',
    selectedTicketId: 'T-101',
  }, helpers)

  assert.ok(closed.html.includes('data-role="ticket-detail-empty"'), 'zero-match filter must render an explicit empty detail')
  assert.ok(!closed.html.includes('data-ticket-id="T-101"'), 'detail must not fall back to an unfiltered ticket')
  assert.ok(!closed.html.includes('data-ticket-status="unknown"'), 'detail must not emit a ghost unknown status')
  assert.ok(closed.html.includes('当前 Workspace 工单列表 (0/2)'), 'denominator must remain the full workspace count')

  const inProgress = renderTicketsPage({
    workspaces: [],
    activeWorkspaceId: 'ws-alpha',
    ticketsLoadable: { status: 'ready', value: tickets, error: null },
    activeFilter: 'in-progress',
    selectedTicketId: 'T-101',
  }, helpers)

  assert.ok(inProgress.html.includes('data-ticket-id="T-102"'), 'detail must follow the current filter')
  assert.ok(!inProgress.html.includes('data-ticket-id="T-101"'), 'detail must not retain a ticket outside the current filter')
})

test('late async response from previous workspace never overwrites currently active workspace view', async () => {
  const ports = createDemoPorts()
  const app = createDemoWebUIApp({ ...ports, viewportWidth: 1440, viewportHeight: 900 })
  await app.ready
  await app.navigate('tickets')

  const slowGammaGate = deferred()
  ports.daemonApi.setWorkspaceDelay('ws-gamma', slowGammaGate.promise)

  // Trigger switch to ws-gamma (slow), then immediately switch to ws-beta (fast)
  const slowSwitchPromise = app.loadWorkspace('ws-gamma')
  await app.loadWorkspace('ws-beta')

  assert.equal(app.state.activeWorkspaceId, 'ws-beta')
  let page = app.renderPage()
  assert.ok(page.html.includes('T-201'))
  assert.ok(!page.html.includes('T-301'))

  // Now let ws-gamma's delayed response resolve; active workspace must stay ws-beta with T-201
  ports.daemonApi.setWorkspaceDelay('ws-gamma', null)
  slowGammaGate.resolve()
  await slowSwitchPromise

  assert.equal(app.state.activeWorkspaceId, 'ws-beta')
  page = app.renderPage()
  assert.equal(page.model.activeWorkspaceId, 'ws-beta')
  assert.ok(page.html.includes('T-201'))
  assert.ok(!page.html.includes('T-301'))
})

test('deep-link restoration and invalid/forbidden workspaceId surface explicit typed error without silent fallback', async () => {
  // 1. Valid deep link restores exact workspace and page
  const validApp = createDemoWebUIApp({
    initialHash: '#/workspaces/ws-beta/tickets',
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  await validApp.ready
  assert.equal(validApp.state.activeWorkspaceId, 'ws-beta')
  assert.equal(validApp.state.activeRoute, 'tickets')
  assert.ok(validApp.renderPage().html.includes('T-201'))

  // 2. Non-existent workspaceId surfaces WORKSPACE_NOT_FOUND and never opens ws-alpha
  const missingApp = createDemoWebUIApp({
    initialHash: '#/workspaces/ws-missing-999/board',
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  await missingApp.ready
  assert.equal(missingApp.state.activeWorkspaceId, 'ws-missing-999')
  assert.equal(missingApp.state.activeRoute, 'board')
  assert.equal(missingApp.state.workspaceScopeError.code, 'WORKSPACE_NOT_FOUND')
  const missingPage = missingApp.renderPage()
  assert.ok(missingPage.html.includes('data-role="workspace-scope-error"'))
  assert.ok(missingPage.html.includes('WORKSPACE_NOT_FOUND'))
  assert.ok(!missingPage.html.includes('goal-alpha-webui'))

  // 3. Forbidden workspaceId surfaces AUTH_FORBIDDEN and never opens ws-alpha
  const ports = createDemoPorts()
  ports.daemonApi.setWorkspaceForbidden('ws-beta', true)
  const forbiddenApp = createDemoWebUIApp({
    ...ports,
    initialHash: '#/workspaces/ws-beta/tickets',
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  await forbiddenApp.ready
  assert.equal(forbiddenApp.state.activeWorkspaceId, 'ws-beta')
  assert.equal(forbiddenApp.state.workspaceScopeError.code, 'AUTH_FORBIDDEN')
  const forbiddenPage = forbiddenApp.renderPage()
  assert.ok(forbiddenPage.html.includes('data-role="workspace-scope-error"'))
  assert.ok(forbiddenPage.html.includes('AUTH_FORBIDDEN'))
  assert.ok(!forbiddenPage.html.includes('T-101'))

  // 4. Unselected workspace on Board / Tickets prompts selection without querying global tickets/goals
  const unselectedPorts = createDemoPorts()
  const unselectedApp = createDemoWebUIApp({
    ...unselectedPorts,
     viewportWidth: 1440,
    viewportHeight: 900,
  })
  await unselectedApp.ready
  const ticketCallCountBefore = unselectedPorts.daemonApi.calls.listTickets.length
  await unselectedApp.loadWorkspace(null)
  await unselectedApp.navigate('tickets')
  const unselectedTicketsPage = unselectedApp.renderPage()
  assert.ok(unselectedTicketsPage.html.includes('data-role="workspace-selection-required"'))
  assert.equal(unselectedPorts.daemonApi.calls.listTickets.length, ticketCallCountBefore)
})

test('production createWebUIApp without injected ports explicitly surfaces typed unavailable and never fakes attached handles', async () => {
  const app = createWebUIApp({ viewportWidth: 1440, viewportHeight: 900 })
  await app.ready

  assert.equal(app.ports.daemonApi, null)
  assert.equal(app.ports.terminalClient, null)
  assert.equal(app.ports.deliveryClient, null)
  assert.equal(app.state.workspaces.length, 0)
  assert.equal(app.state.workspacesLoadable.status, 'unavailable')
  assert.equal(app.state.workspacesLoadable.error.code, 'DAEMON_API_UNAVAILABLE')
  assert.equal(app.state.membersLoadable.status, 'unavailable')
  assert.equal(app.state.membersLoadable.error.code, 'DAEMON_API_UNAVAILABLE')
  assert.equal(app.sessionController.terminalHandlesByMemberId.size, 0)

  for (const route of ROUTES) {
    await app.navigate(route)
    const page = app.renderPage()
    assert.equal(page.pageId, route)
    assert.match(page.html, new RegExp(`data-page="${route}"`))
    assert.match(page.html, /DAEMON_API_UNAVAILABLE|unavailable/i)
  }

  await assert.rejects(app.sendTerminalInput('m-1', 'pwd\n'), (error) => {
    assert.equal(error.code, 'TERMINAL_CLIENT_UNAVAILABLE')
    return true
  })
})

test('production createWebUIApp with daemonApi but missing terminalClient surfaces TERMINAL_CLIENT_UNAVAILABLE per window', async () => {
  const { daemonApi } = createDemoPorts()
  const app = createWebUIApp({ daemonApi, terminalClient: null, deliveryClient: null, viewportWidth: 1440 })
  await app.ready
  await app.navigate('sessions')
  const page = app.renderPage()

  assert.equal(page.model.memberIds.length, 6)
  assert.equal(app.sessionController.terminalHandlesByMemberId.size, 0)
  assert.ok(page.html.includes('data-terminal-status="unavailable"'))
  assert.ok(page.html.includes('TERMINAL_CLIENT_UNAVAILABLE'))
  assert.ok(!page.html.includes('TERMINAL_NOT_LOADED'))
  assert.ok(!page.html.includes('data-terminal-status="attached"'))
})

test('configured terminal client attaches every visible 1+4 pane and keeps the hidden sixth out of the workbench', async () => {
  const ports = createDemoPorts()
  const app = createWebUIApp({
    daemonApi: ports.daemonApi,
    terminalClient: ports.terminalClient,
    deliveryClient: ports.deliveryClient,
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  await app.ready
  await app.navigate('sessions')

  const page = app.renderPage()
  const attachedOrStarting = (page.html.match(/data-terminal-status="(?:attached|starting)"/g) || []).length
  assert.equal(attachedOrStarting, 5)
  assert.ok(!page.html.includes('data-terminal-status="not-loaded"'))
  assert.ok(!page.html.includes('TERMINAL_NOT_LOADED'))
  const attachedBodyCount = (page.html.match(/data-terminal-body="true" data-terminal-status="(?:attached|starting)" data-member-id=/g) || []).length
  assert.equal(attachedBodyCount, 5)
  for (const memberId of ['m-1', 'm-2', 'm-3', 'm-4', 'm-5']) {
    assert.equal(Boolean(app.sessionController.getTerminalHandle(memberId)), true, `${memberId} must own a stream`)
  }
  assert.equal(app.sessionController.getTerminalHandle('m-6'), null)
  assert.ok(page.html.includes('data-role="peer-scroll-grid"'))
  assert.ok(page.html.includes('grid-template-rows:minmax(0,1fr) minmax(0,1fr)'))
  assert.ok(!page.html.includes('TERMINAL_CLIENT_UNAVAILABLE'))
  assert.ok(!page.html.includes('Terminal client port is not configured.'))
})

test('visible terminal bodies show typed pending before the first frame and never fake attached content', async () => {
  const ports = createDemoPorts()
  const app = createWebUIApp({
    daemonApi: ports.daemonApi,
    terminalClient: ports.terminalClient,
    deliveryClient: ports.deliveryClient,
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  await app.ready
  await app.navigate('sessions')

  const page = app.renderPage()
  const visibleBodyCount = (page.html.match(/data-terminal-status="(?:attached|starting)"/g) || []).length
  const pendingCount = (page.html.match(/data-terminal-pending="true"/g) || []).length

  assert.equal(visibleBodyCount, 5)
  assert.equal(pendingCount, 5)
  assert.ok(page.html.includes('TERMINAL_FRAME_PENDING'))
  assert.ok(!page.html.includes('data-terminal-status="not-loaded"'))
})

test('per-window work headers resolve member-scoped Board/Tickets counts and terminal-truth status', async () => {
  const ports = createDemoPorts()
  const app = createWebUIApp({
    daemonApi: ports.daemonApi,
    terminalClient: ports.terminalClient,
    deliveryClient: ports.deliveryClient,
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  await app.ready
  await app.navigate('sessions')

  const page = app.renderPage()
  const workStatusByMember = new Map(
    [...page.html.matchAll(/<span class="v2-window-work-status[^>]*data-member-id="([^"]+)"[^>]*>/g)]
      .map((match) => [match[1], match[0]])
  )
  assert.equal(workStatusByMember.size, 5)
  for (const memberId of ['m-1', 'm-2', 'm-3', 'm-4', 'm-5']) {
    assert.equal(Boolean(workStatusByMember.get(memberId)), true, `${memberId} must render work chips`)
  }
  assert.equal(workStatusByMember.get('m-1').includes('data-board-count="1"'), true)
  assert.equal(workStatusByMember.get('m-1').includes('data-ticket-count="1"'), true)
  assert.equal(workStatusByMember.get('m-2').includes('data-ticket-count="0"'), true)
  assert.equal(workStatusByMember.get('m-3').includes('data-board-count="0"'), true)
  assert.equal(page.html.includes('>B unavailable<'), false)
  assert.equal(page.html.includes('>T unavailable<'), false)

  const headerByMember = new Map(
    [...page.html.matchAll(/<header class="v2-window-header"[^>]*data-member-id="([^"]+)"[^>]*>[\s\S]*?<\/header>/g)]
      .map((match) => {
        const statusMatch = /data-status-state="([^"]+)"/.exec(match[0])
        return [match[1], statusMatch?.[1] ?? null]
      })
  )
  assert.equal(headerByMember.size, 5)
  for (const memberId of ['m-1', 'm-2', 'm-3', 'm-4', 'm-5']) {
    assert.equal(headerByMember.get(memberId), 'online', `${memberId} header must report the attached terminal state`)
  }
  assert.equal(headerByMember.has('m-6'), false)
})

test('webui public entry with explicit demo ports renders all pages and six workspace members', async () => {
  const app = createDemoWebUIApp({ viewportWidth: 1440, viewportHeight: 900 })
  await app.ready

  for (const route of ROUTES) {
    await app.navigate(route)
    const page = app.renderPage()
    assert.equal(page.pageId, route)
    assert.match(page.html, new RegExp(`data-page="${route}"`))
  }

  await app.navigate('sessions')
  const page = app.renderPage()
  assert.equal(page.model.memberIds.length, 6)
  assert.ok(page.model.memberIds.includes('m-1'))
  assert.ok(page.model.memberIds.includes('m-6'))
  assert.ok(page.html.includes('data-member-id="m-1"'))
  assert.ok(page.html.includes('data-member-id="m-6"'))
  assert.ok(page.html.includes('data-role="peer-scroll-grid"'))
  assert.ok(page.html.includes('data-terminal-body="true"'))
  assert.ok(page.html.includes('data-terminal-status="attached"'))
  assert.ok(page.html.includes('data-component="window-header"'))
})

test('border drag persists across reload with the same storage', async () => {
  const storage = memoryStorage()
  const app = createDemoWebUIApp({ storage, viewportWidth: 1440 })
  await app.ready
  const before = app.state.layout.primaryRatio
  await app.dispatchAction('drag-border', { windowId: 'window-primary', edge: 'e', deltaX: 60, containerWidth: 1000 })
  assert.ok(app.state.layout.primaryRatio > before)

  const reloaded = createDemoWebUIApp({ storage, viewportWidth: 1440 })
  await reloaded.ready
  assert.ok(reloaded.state.layout.primaryRatio > before)
  assert.equal(reloaded.state.layout.workspaceId, 'ws-alpha')
})

test('mobile preview and focus preserve the same 2D viewport', async () => {
  const app = createDemoWebUIApp({ viewportWidth: 390, viewportHeight: 844 })
  await app.ready
  await app.navigate('sessions')
  assert.equal(app.state.viewportMode, 'mobile')

  await app.dispatchAction('pan-zoom-preview', { deltaX: 18, deltaY: -6, zoomFactor: 1.2 })
  const viewport = { ...app.state.layout.previewViewport }
  await app.dispatchAction('enter-member-focus', { memberId: 'm-3' })
  assert.equal(app.state.layout.mobileMode, 'focus')
  assert.equal(app.state.layout.focusedMemberId, 'm-3')
  await app.dispatchAction('return-to-preview')
  assert.equal(app.state.layout.mobileMode, 'preview')
  assert.deepEqual(app.state.layout.previewViewport, viewport)
})

test('per-window property drawers stay scoped across member switches', async () => {
  const app = createDemoWebUIApp({ viewportWidth: 1440 })
  await app.ready
  await app.navigate('sessions')

  await app.toggleProperty('window-primary', 'm-1')
  await app.toggleProperty('window-m-2', 'm-2')
  const result = await app.propertyController.saveMemberProperties('m-1', { description: 'm1-description' })
  assert.equal(result.ok, true)
  assert.equal(app.propertyController.getWindowPropertyState('window-primary', 'm-1').isOpen, true)
  assert.equal(app.propertyController.getWindowPropertyState('window-m-2', 'm-2').isOpen, true)
  assert.equal(app.propertyController.getMemberState('m-2').draft.description, 'Bo member profile')
})

test('explicit auth, stale and unknown triggers surface honest errors', async () => {
  const app = createDemoWebUIApp({ viewportWidth: 1440 })
  await app.ready

  await app.triggerAuthFailure()
  assert.equal(app.state.activeRoute, 'connections')
  assert.equal(app.state.membersLoadable.status, 'unavailable')
  assert.equal(app.state.membersLoadable.error.code, 'AUTH_INVALID_TOKEN')

  const fresh = createDemoWebUIApp({ viewportWidth: 1440 })
  await fresh.ready
  await fresh.triggerStaleStatus()
  assert.equal(fresh.state.members[1].status, 'stale')
  await fresh.triggerUnknownStateWrite()
  assert.ok(fresh.state.lastError)
  assert.equal(fresh.state.lastError.code, 'DELIVERY_TARGET_UNKNOWN_STATE')
})

test('ticket and goal write paths reject missing ports, incomplete authority fields, and mismatched workspaceId without local mutation', async () => {
  const basePorts = createDemoPorts()

  // 1. Missing transitionTicket / createTicket / createGoal ports return DAEMON_API_UNAVAILABLE and do not mutate state
  const partialDaemonApi = {
    listWorkspaces: basePorts.daemonApi.listWorkspaces,
    listMembers: basePorts.daemonApi.listMembers,
    listGoals: basePorts.daemonApi.listGoals,
    listTickets: basePorts.daemonApi.listTickets,
  }
  const appMissingWritePorts = createWebUIApp({
    daemonApi: partialDaemonApi,
    terminalClient: basePorts.terminalClient,
    deliveryClient: basePorts.deliveryClient,
    viewportWidth: 1440,
  })
  await appMissingWritePorts.ready
  await appMissingWritePorts.navigate('tickets')

  const ticketsBefore = structuredClone(appMissingWritePorts.state.ticketsLoadable.value)
  const transitionRes = await appMissingWritePorts.dispatchAction('transition-ticket', {
    workspaceId: 'ws-alpha',
    ticketId: 'T-101',
    transition: 'close',
  })
  assert.equal(transitionRes.ok, false)
  assert.equal(transitionRes.error.code, 'DAEMON_API_UNAVAILABLE')
  assert.deepEqual(appMissingWritePorts.state.ticketsLoadable.value, ticketsBefore)

  const createTicketRes = await appMissingWritePorts.dispatchAction('create-ticket', {
    workspaceId: 'ws-alpha',
    title: 'Should not locally fabricate',
    goalId: 'goal-alpha-webui',
    ownerMemberId: 'm-1',
  })
  assert.equal(createTicketRes.ok, false)
  assert.equal(createTicketRes.error.code, 'DAEMON_API_UNAVAILABLE')
  assert.deepEqual(appMissingWritePorts.state.ticketsLoadable.value, ticketsBefore)

  const goalsBefore = structuredClone(appMissingWritePorts.state.goalsLoadable.value)
  const createGoalRes = await appMissingWritePorts.dispatchAction('create-goal', {
    workspaceId: 'ws-alpha',
    title: 'Should not locally fabricate goal',
    ownerMemberId: 'm-1',
  })
  assert.equal(createGoalRes.ok, false)
  assert.equal(createGoalRes.error.code, 'DAEMON_API_UNAVAILABLE')
  assert.deepEqual(appMissingWritePorts.state.goalsLoadable.value, goalsBefore)

  // 2. Incomplete authority fields or mismatched workspaceId reject with typed error and zero mutation
  let nextCreateTicketResponse = { title: 'Missing ticketId and status' }
  let nextTransitionTicketResponse = { ticketId: 'T-101', title: 'Missing allowedTransitions', status: 'in_review' }
  let nextCreateGoalResponse = { goalId: 'goal-mismatch', title: 'Wrong workspace', status: 'running', workspaceId: 'ws-beta' }

  const malformedDaemonApi = {
    ...basePorts.daemonApi,
    async createTicket() {
      return nextCreateTicketResponse
    },
    async transitionTicket() {
      return nextTransitionTicketResponse
    },
    async createGoal() {
      return nextCreateGoalResponse
    },
  }
  const appMalformed = createWebUIApp({
    daemonApi: malformedDaemonApi,
    terminalClient: basePorts.terminalClient,
    deliveryClient: basePorts.deliveryClient,
    viewportWidth: 1440,
  })
  await appMalformed.ready

  const malformedTicketsBefore = structuredClone(appMalformed.state.ticketsLoadable.value)
  const invalidCreateRes = await appMalformed.dispatchAction('create-ticket', {
    workspaceId: 'ws-alpha',
    title: 'Incomplete response test',
    goalId: 'goal-alpha-webui',
    ownerMemberId: 'm-1',
  })
  assert.equal(invalidCreateRes.ok, false)
  assert.equal(invalidCreateRes.error.code, 'TICKET_RESPONSE_INVALID')
  assert.deepEqual(appMalformed.state.ticketsLoadable.value, malformedTicketsBefore)

  const invalidTransitionRes = await appMalformed.dispatchAction('transition-ticket', {
    workspaceId: 'ws-alpha',
    ticketId: 'T-101',
    transition: 'close',
  })
  assert.equal(invalidTransitionRes.ok, false)
  assert.equal(invalidTransitionRes.error.code, 'TICKET_RESPONSE_INVALID')
  assert.deepEqual(appMalformed.state.ticketsLoadable.value, malformedTicketsBefore)

  nextCreateTicketResponse = {
    ticketId: 'T-999',
    title: 'Mismatched workspace ticket',
    status: 'accepted',
    allowedTransitions: ['rework'],
    workspaceId: 'ws-beta',
  }
  const mismatchTicketRes = await appMalformed.dispatchAction('create-ticket', {
    workspaceId: 'ws-alpha',
    title: 'Mismatched workspace ticket',
    goalId: 'goal-alpha-webui',
    ownerMemberId: 'm-1',
  })
  assert.equal(mismatchTicketRes.ok, false)
  assert.equal(mismatchTicketRes.error.code, 'WORKSPACE_SCOPE_MISMATCH')
  assert.deepEqual(appMalformed.state.ticketsLoadable.value, malformedTicketsBefore)

  const malformedGoalsBefore = structuredClone(appMalformed.state.goalsLoadable.value)
  const mismatchGoalRes = await appMalformed.dispatchAction('create-goal', {
    workspaceId: 'ws-alpha',
    title: 'Mismatched workspace goal',
    ownerMemberId: 'm-1',
  })
  assert.equal(mismatchGoalRes.ok, false)
  assert.equal(mismatchGoalRes.error.code, 'WORKSPACE_SCOPE_MISMATCH')
  assert.deepEqual(appMalformed.state.goalsLoadable.value, malformedGoalsBefore)
})

test('late write resolution or rejection from previous workspace stays isolated and never pollutes active workspace state or error banner', async () => {
  const basePorts = createDemoPorts()
  const slowCreateGate = deferred()
  const slowRejectGate = deferred()

  const customDaemonApi = {
    ...basePorts.daemonApi,
    async createTicket(payload) {
      if (payload.title === 'Delayed Alpha Ticket') {
        await slowCreateGate.promise
      }
      return basePorts.daemonApi.createTicket(payload)
    },
    async transitionTicket(payload) {
      if (payload.ticketId === 'T-101' && payload.transition === 'rework') {
        await slowRejectGate.promise
      }
      return basePorts.daemonApi.transitionTicket(payload)
    },
  }

  const app = createWebUIApp({
    daemonApi: customDaemonApi,
    terminalClient: basePorts.terminalClient,
    deliveryClient: basePorts.deliveryClient,
    viewportWidth: 1440,
  })
  await app.ready
  await app.navigate('tickets')

  // Start a slow ticket creation and a slow failing transition in ws-alpha
  const pendingCreate = app.dispatchAction('create-ticket', {
    workspaceId: 'ws-alpha',
    title: 'Delayed Alpha Ticket',
    ownerMemberId: 'm-1',
  })
  const pendingReject = app.dispatchAction('transition-ticket', {
    workspaceId: 'ws-alpha',
    ticketId: 'T-101',
    transition: 'rework',
  })

  // Switch active workspace to ws-beta before ws-alpha writes finish
  await app.dispatchAction('select-workspace', { workspaceId: 'ws-beta' })
  assert.equal(app.state.activeWorkspaceId, 'ws-beta')
  assert.equal(app.state.lastError, null)

  // Resolve slow create and let slow illegal transition reject for ws-alpha
  slowCreateGate.resolve()
  slowRejectGate.resolve()
  const [createOutcome, rejectOutcome] = await Promise.all([pendingCreate, pendingReject])
  assert.equal(createOutcome.ok, true)
  assert.equal(rejectOutcome.ok, false)
  assert.equal(rejectOutcome.error.code, 'TICKET_ILLEGAL_TRANSITION')

  // Active ws-beta state, tickets list, and lastError must remain completely untouched
  assert.equal(app.state.activeWorkspaceId, 'ws-beta')
  assert.equal(app.state.lastError, null)
  const betaPage = app.renderPage()
  assert.ok(betaPage.html.includes('T-201'))
  assert.ok(!betaPage.html.includes('Delayed Alpha Ticket'))

  // Switching back to ws-alpha shows both the created ticket and ws-alpha's scoped error
  await app.dispatchAction('select-workspace', { workspaceId: 'ws-alpha' })
  assert.equal(app.state.activeWorkspaceId, 'ws-alpha')
  assert.equal(app.state.lastError?.code, 'TICKET_ILLEGAL_TRANSITION')
  const alphaPage = app.renderPage()
  assert.ok(alphaPage.html.includes('Delayed Alpha Ticket'))
})

test('DeliveryStatus is absent from global page footers and rendered inside open member property drawer', async () => {
  const app = createDemoWebUIApp({ viewportWidth: 1440, viewportHeight: 900 })
  await app.ready

  for (const route of ['sessions', 'board', 'tickets']) {
    await app.navigate(route)
    const page = app.renderPage()
    assert.ok(!page.html.includes('data-component="delivery-status"'), `Closed drawer on ${route} must not render global delivery-status footer`)
  }

  await app.navigate('sessions')
  const receipt = await app.sendMessage({ fromMemberId: 'm-1', toMemberId: 'm-2', text: 'Scoped receipt test' })
  await app.toggleProperty('window-m-2', 'm-2')
  const sessionsWithDrawer = app.renderPage()
  assert.ok(sessionsWithDrawer.html.includes('data-role="member-delivery-status"'))
  assert.ok(sessionsWithDrawer.html.includes('data-component="delivery-status"'))
  assert.ok(sessionsWithDrawer.html.includes(receipt.receiptId))
})

