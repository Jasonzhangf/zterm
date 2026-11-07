import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createDemoWebUIApp } from '../fixtures/demo-ports.mjs'

async function mountApp(root) {
  const app = createDemoWebUIApp({ viewportWidth: 390, viewportHeight: 844 })
  await app.ready
  app.mount(root)
  await app.navigate('sessions')
  await app.dispatchAction('apply-layout-operation', {
    kind: 'switchMobileMode',
    mobileMode: 'focus',
  })
  return app
}

function domProjection(document) {
  const page = document.querySelector('[data-page="sessions"]')
  const frames = [...document.querySelectorAll('[data-component="window-frame"]')]
  return {
    shellViewportMode: document.querySelector('[data-component="app-shell"]')?.getAttribute('data-viewport-mode'),
    pageViewportMode: page?.getAttribute('data-viewport-mode'),
    indicator: document.querySelector('[data-role="viewport-mode-indicator"]')?.textContent?.trim(),
    hasMobileModeBar: Boolean(document.querySelector('[data-role="mobile-mode-bar"]')),
    visibleFrameCount: frames.length,
    windowIds: frames.map((frame) => frame.getAttribute('data-window-id')),
  }
}

test('real window resize re-renders the mounted projection without a manual render', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>')
  const root = dom.window.document.getElementById('app')
  const app = await mountApp(root)

  assert.equal(app.state.viewportMode, 'mobile')
  assert.deepEqual(domProjection(dom.window.document), {
    shellViewportMode: 'mobile',
    pageViewportMode: 'mobile',
    indicator: 'mobile focus',
    hasMobileModeBar: true,
    visibleFrameCount: 1,
    windowIds: ['window-primary'],
  })

  const focused = app.state.members[0].memberId
  const handle = app.sessionController.getTerminalHandle(focused)
  assert.ok(handle)

  dom.window.innerWidth = 1440
  dom.window.innerHeight = 900
  dom.window.dispatchEvent(new dom.window.Event('resize'))
  assert.deepEqual(domProjection(dom.window.document), {
    shellViewportMode: 'desktop',
    pageViewportMode: 'desktop',
    indicator: 'desktop 1+4 workbench',
    hasMobileModeBar: false,
    visibleFrameCount: 6,
    windowIds: ['window-primary', 'window-peer-m-2', 'window-peer-m-3', 'window-peer-m-4', 'window-peer-m-5', 'window-peer-m-6'],
  })
  assert.equal(app.sessionController.getTerminalHandle(focused), handle)

  dom.window.innerWidth = 390
  dom.window.innerHeight = 844
  dom.window.dispatchEvent(new dom.window.Event('resize'))
  assert.deepEqual(domProjection(dom.window.document), {
    shellViewportMode: 'mobile',
    pageViewportMode: 'mobile',
    indicator: 'mobile focus',
    hasMobileModeBar: true,
    visibleFrameCount: 1,
    windowIds: ['window-primary'],
  })
  assert.equal(app.sessionController.getTerminalHandle(focused), handle)
  assert.equal(handle.isBodyActive(), true)
})

test('mobile preview and focus switch re-render the mounted preview surface', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>')
  const app = await mountApp(dom.window.document.getElementById('app'))

  await app.dispatchAction('switch-mobile-mode', { mobileMode: 'preview' })
  const preview = domProjection(dom.window.document)
  assert.equal(preview.pageViewportMode, 'mobile')
  assert.equal(preview.indicator, 'mobile preview')
  assert.ok(dom.window.document.querySelector('[data-component="session-preview-canvas"]'))
  assert.ok(preview.visibleFrameCount > 1)

  const focused = app.state.members[2].memberId
  await app.dispatchAction('enter-member-focus', { memberId: focused })
  const focus = domProjection(dom.window.document)
  assert.equal(focus.pageViewportMode, 'mobile')
  assert.equal(focus.indicator, 'mobile focus')
  assert.equal(focus.visibleFrameCount, 1)
  assert.equal(dom.window.document.querySelectorAll('[data-component="session-preview-canvas"]').length, 0)
  assert.equal(app.sessionController.getTerminalHandle(focused).isBodyActive(), true)
})

test('a typed unavailable member failure keeps an independent focused target active', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>')
  const app = await mountApp(dom.window.document.getElementById('app'))
  const focused = app.state.members[0].memberId
  const failed = app.state.members[1].memberId

  app.ports.daemonApi.setMemberStatus(app.state.activeWorkspaceId, failed, 'unavailable')
  await assert.rejects(
    () => app.sendTerminalInput(failed, 'x'),
    (error) => error?.code === 'SESSION_TARGET_UNAVAILABLE',
  )

  assert.equal(app.sessionController.getTerminalHandle(focused).isBodyActive(), true)
})

test('a typed terminal stream failure exposes a target retry and recovers its visible handle', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>')
  const root = dom.window.document.getElementById('app')
  const app = createDemoWebUIApp({ viewportWidth: 1440, viewportHeight: 900 })
  await app.ready
  app.mount(root)
  await app.navigate('sessions')

  const failedMemberId = app.state.members[1].memberId
  const failedHandle = app.sessionController.getTerminalHandle(failedMemberId)
  assert.ok(failedHandle)
  failedHandle.status = 'unavailable'
  failedHandle.lastError = {
    code: 'TERMINAL_STREAM_UNAVAILABLE',
    category: 'terminal',
    message: 'Terminal stream is unavailable.',
    retryable: false,
  }
  failedHandle.bodyActive = false
  app.render()

  const retry = dom.window.document.querySelector(
    `[data-action="retry-terminal"][data-member-id="${failedMemberId}"]`,
  )
  assert.ok(retry, 'the failed terminal pane must expose a target-scoped retry control')
  await app.dispatchAction('retry-terminal', { memberId: failedMemberId })

  const recoveredHandle = app.sessionController.getTerminalHandle(failedMemberId)
  assert.equal(recoveredHandle.status, 'attached')
  assert.equal(recoveredHandle.isBodyActive(), true)
  const body = dom.window.document.querySelector(
    `.terminal-viewport[data-terminal-body="true"][data-member-id="${failedMemberId}"]`,
  )
  assert.equal(body?.getAttribute('data-terminal-status'), 'attached')
})
