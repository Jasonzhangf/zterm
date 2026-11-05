import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteBindingStore } from '../../src/public/contracts.ts'

const execFileAsync = promisify(execFile)
const CHILD = fileURLToPath(new URL('../support/restart-child.ts', import.meta.url))

interface ChildResult {
  mode: string
  state: string
  createCalls: number
  bindingId?: string
  operationRef: { workspaceId: string; actorAccountId: string; operationId: string }
}

async function runChild(args: string[]): Promise<ChildResult | undefined> {
  const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', CHILD, ...args])
  const line = stdout.trim().split('\n').pop() ?? ''
  return line ? (JSON.parse(line) as ChildResult) : undefined
}

test('a truly separate process recovers an unknown operation without re-POSTing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zterm-tickets-restart-'))
  try {
    const filePath = join(dir, 'tickets.sqlite')

    const first = await runChild(['write', filePath])
    assert.equal(first?.mode, 'write')
    assert.equal(first?.state, 'unknown')
    assert.equal(first?.createCalls, 1)
    assert.equal(first?.bindingId, undefined)

    const second = await runChild(['replay', filePath, String(1000)])
    assert.equal(second?.mode, 'replay')
    assert.equal(second?.state, 'unknown')
    assert.equal(second?.createCalls, 0)
    assert.deepEqual(second?.operationRef, {
      workspaceId: 'ws-1',
      actorAccountId: 'acct-a',
      operationId: 'op-restart-1',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a process that exits after issuing the remote POST leaves a durable pending that recovery turns unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zterm-tickets-crash-'))
  try {
    const filePath = join(dir, 'tickets.sqlite')

    // This child exits inside createTask after the POST is issued but before
    // the local state commit, exactly the crash window the contract describes.
    await runChild(['crash-after-post', filePath, String(1000)])

    const store = new SqliteBindingStore({ path: filePath })
    try {
      const durable = await store.getOperation({ workspaceId: 'ws-1', actorAccountId: 'acct-a', operationId: 'op-restart-1' })
      assert.equal(durable?.state, 'pending')
      assert.equal(durable?.externalTaskId, undefined)
    } finally {
      store.close()
    }

    const replay = await runChild(['replay', filePath, String(1000 + 30_001)])
    assert.equal(replay?.mode, 'replay')
    assert.equal(replay?.state, 'unknown')
    assert.equal(replay?.createCalls, 0)
    assert.equal(replay?.bindingId, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
