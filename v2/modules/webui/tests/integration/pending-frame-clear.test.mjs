import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWebUIApp } from '../../src/app/app-shell.mjs'
import { createPaneTerminalClient } from '../../src/clients/pane-terminal-client.mjs'
import { createDemoPorts } from '../fixtures/demo-ports.mjs'

const VISIBLE_MEMBER_IDS = ['m-1', 'm-2', 'm-3', 'm-4', 'm-5']

function createPendingFrameDom() {
  const notices = new Map()
  const viewports = new Map()
  const slots = new Map()

  for (const memberId of VISIBLE_MEMBER_IDS) {
    const notice = {
      isConnected: true,
      removed: false,
      remove() {
        this.removed = true
        this.isConnected = false
      },
    }
    const viewport = {
      isConnected: true,
      getAttribute(name) {
        return name === 'data-member-id' ? memberId : null
      },
      querySelector(selector) {
        return selector === '[data-terminal-pending="true"]' && !notice.removed ? notice : null
      },
      scrollTop: 0,
      scrollHeight: 100,
      clientHeight: 100,
    }
    const slot = {
      clientHeight: 100,
      clientWidth: 100,
      firstElementChild: null,
      getAttribute(name) {
        return name === 'data-member-id' ? memberId : null
      },
      closest(selector) {
        return selector === '.terminal-viewport' ? viewport : null
      },
    }
    notices.set(memberId, notice)
    viewports.set(memberId, viewport)
    slots.set(memberId, slot)
  }

  const root = {
    innerHTML: '',
    ownerDocument: null,
    querySelectorAll(selector) {
      if (selector === '[data-terminal-mount="true"]') return [...slots.values()]
      if (selector === '.terminal-viewport[data-member-id]') return [...viewports.values()]
      return []
    },
  }

  return {
    root,
    notices,
    viewports,
    disconnect() {
      for (const viewport of viewports.values()) viewport.isConnected = false
      for (const notice of notices.values()) notice.isConnected = false
    },
  }
}

function createFrameHarness() {
  const streams = new Map()
  const api = {
    async resolveTerminalAdmission(member) {
      return {
        workspaceId: member.workspaceId,
        memberId: member.memberId,
        machineId: member.machine,
        groupPath: '/WebUI Visible Delivery/team',
        expectedGeneration: 1,
        backend: 'tmux',
        stableId: `tmux:v1:${member.memberId}`,
      }
    },
    openTerminalStream(admission, handlers) {
      streams.set(admission.memberId, handlers)
      handlers.onReady()
      return {
        close() {},
      }
    },
    async sendInput() {
      return { accepted: true }
    },
  }
  return {
    streams,
    terminalClient: createPaneTerminalClient({ api }),
  }
}

test('real first frame clears the pending notice immediately while a frameless attach keeps it', async (t) => {
  const { daemonApi } = createDemoPorts()
  const { streams, terminalClient } = createFrameHarness()
  const dom = createPendingFrameDom()
  const terminalViewportFactory = ({ member }) =>
    `<div data-terminal-mount="true" data-member-id="${member.memberId}"></div>`
  terminalViewportFactory.mount = () => {}

  const app = createWebUIApp({
    daemonApi,
    terminalClient,
    terminalViewportFactory,
    viewportWidth: 1440,
    viewportHeight: 900,
  })
  t.after(() => {
    dom.disconnect()
    app.destroy()
  })

  await app.ready
  await app.navigate('sessions')
  app.mount(dom.root)

  const handle = app.sessionController.getTerminalHandle('m-1')
  const notice = dom.notices.get('m-1')
  assert.ok(handle)
  assert.ok(notice)
  assert.equal(handle.getSnapshot().deliveredFrameCount, 0)
  assert.equal(notice.removed, false)

  streams.get('m-1').onBuffer({
    ansi: 'first visible frame',
    frame: { cols: 80, rows: 24 },
  })

  assert.equal(handle.getSnapshot().deliveredFrameCount, 1)
  assert.equal(notice.removed, true)
})
