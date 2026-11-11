import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalSelection } from '../../src/clients/terminal-client/selection.mjs'

function deferred() {
  let resolve
  const promise = new Promise((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function admission(target) {
  return { target }
}

test('terminal selection keeps the final target when two admissions resolve out of order', async () => {
  const first = deferred()
  const second = deferred()
  const opened = []
  const closed = []
  let visibleTarget = null
  let inputAdmission = null

  const selection = createTerminalSelection({
    resolveAdmission: (target) => target.name === 'A' ? first.promise : second.promise,
    openStream: (nextAdmission) => {
      opened.push(nextAdmission.target)
      return { close: () => closed.push(nextAdmission.target) }
    },
  })

  const firstSelection = selection.select({ name: 'A' }, {
    onAdmission: (nextAdmission) => {
      visibleTarget = 'A'
      inputAdmission = nextAdmission
    },
  })
  const finalSelection = selection.select({ name: 'B' }, {
    onAdmission: (nextAdmission) => {
      visibleTarget = 'B'
      inputAdmission = nextAdmission
    },
  })

  second.resolve(admission('B'))
  const finalResult = await finalSelection
  first.resolve(admission('A'))
  const staleResult = await firstSelection

  assert.equal(staleResult, null)
  assert.deepEqual(opened, ['B'])
  assert.deepEqual(closed, [])
  assert.equal(finalResult.admission.target, 'B')
  assert.equal(visibleTarget, 'B')
  assert.equal(inputAdmission.target, 'B')
  assert.equal(selection.getAdmission().target, 'B')
})

test('a new selection closes the previous active stream before resolving', async () => {
  const first = deferred()
  const second = deferred()
  const opened = []
  const closed = []

  const selection = createTerminalSelection({
    resolveAdmission: (target) => target.name === 'A' ? first.promise : second.promise,
    openStream: (nextAdmission) => {
      opened.push(nextAdmission.target)
      return { close: () => closed.push(nextAdmission.target) }
    },
  })

  first.resolve(admission('A'))
  await selection.select({ name: 'A' })
  assert.deepEqual(opened, ['A'])

  const secondSelection = selection.select({ name: 'B' })
  assert.deepEqual(closed, ['A'])

  second.resolve(admission('B'))
  await secondSelection
  assert.deepEqual(opened, ['A', 'B'])
  assert.equal(selection.getAdmission().target, 'B')
})
