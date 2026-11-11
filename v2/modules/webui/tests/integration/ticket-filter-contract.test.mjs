import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDemoPorts, createDemoWebUIApp } from '../fixtures/demo-ports.mjs'
import { renderTicketsPage, TICKET_FILTERS } from '../../src/pages/tickets/index.mjs'
import { renderTicketList, renderTicketDetail } from '../../src/components/index.mjs'

const SUPPORTED = ['all', 'open', 'closed']
const UNSUPPORTED = ['in-progress', 'blocked', 'review']

test('ticket filters expose only the daemon-supported all/open/closed contract', () => {
  assert.deepEqual(TICKET_FILTERS.map((item) => item.id), SUPPORTED)

  const page = renderTicketsPage(
    { activeWorkspaceId: 'ws-alpha', ticketsLoadable: { status: 'ready', value: [] } },
    { renderTicketList, renderTicketDetail },
  )
  const rendered = [...page.html.matchAll(/data-action="filter-tickets"[^>]*data-filter="([^"]+)"/g)]
    .map((match) => match[1])
  assert.ok(rendered.length > 0)
  for (const filter of rendered) {
    assert.ok(SUPPORTED.includes(filter), `filter ${filter} must be in the supported all/open/closed set`)
  }
  for (const unsupported of [...UNSUPPORTED, 'in_progress', 'done']) {
    assert.ok(
      !page.html.includes(`data-filter="${unsupported}"`),
      `unsupported filter ${unsupported} must not render a control`,
    )
  }
})

test('unsupported ticket filters never dispatch a listTickets request', async () => {
  const ports = createDemoPorts()
  const app = createDemoWebUIApp({ ...ports, viewportWidth: 1440, viewportHeight: 900 })
  await app.ready
  await app.navigate('tickets')
  app.renderPage()

  const callsBefore = ports.daemonApi.calls.listTickets.length
  const filterBefore = app.state.activeTicketFilter
  for (const unsupported of UNSUPPORTED) {
    await app.dispatchAction('filter-tickets', { workspaceId: 'ws-alpha', filter: unsupported })
  }
  assert.equal(ports.daemonApi.calls.listTickets.length, callsBefore, 'unsupported filters must not reach listTickets')
  assert.equal(app.state.activeTicketFilter, filterBefore, 'unsupported filters must not mutate the active filter')
})

test('supported ticket filters dispatch the matching status request', async () => {
  const ports = createDemoPorts()
  const app = createDemoWebUIApp({ ...ports, viewportWidth: 1440, viewportHeight: 900 })
  await app.ready
  await app.navigate('tickets')
  app.renderPage()

  for (const filter of ['open', 'closed', 'all']) {
    const callsBefore = ports.daemonApi.calls.listTickets.length
    await app.dispatchAction('filter-tickets', { workspaceId: 'ws-alpha', filter })
    assert.equal(ports.daemonApi.calls.listTickets.length, callsBefore + 1)
    const last = ports.daemonApi.calls.listTickets.at(-1)
    assert.equal(last.workspaceId, 'ws-alpha')
    assert.equal(last.status, filter === 'all' ? undefined : filter)
    assert.equal(app.state.activeTicketFilter, filter)
  }
})
