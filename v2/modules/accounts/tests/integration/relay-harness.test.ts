import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { startRelay, stopRelay } from './relay-harness.ts'

const STUBBORN_ENTRY = fileURLToPath(new URL('./fixtures/stubborn-relay.ts', import.meta.url))
const DELAYED_HEALTH_ENTRY = fileURLToPath(
  new URL('./fixtures/delayed-health-relay.mjs', import.meta.url),
)

function expectProcessGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH')
}

test('relay harness tracks the serving process and removes state only after shutdown', async (t) => {
  const relay = await startRelay()
  let activeRelay: Awaited<ReturnType<typeof startRelay>> | null = relay
  t.after(async () => {
    if (activeRelay) await stopRelay(activeRelay)
  })
  assert.equal(relay.pid, relay.child.pid, 'health pid must equal the tracked serving pid')
  const result = await stopRelay(relay)
  activeRelay = null
  assert.equal(result.forced, false)
  expectProcessGone(relay.pid)
  assert.equal(existsSync(relay.tempRoot), false)
})

test('inherited relay store path cannot escape the isolated temporary root', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'zterm-relay-inherited-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const inheritedStore = join(root, 'shared-store.json')
  const original = process.env.ZTERM_TRAVERSAL_STORE_PATH
  process.env.ZTERM_TRAVERSAL_STORE_PATH = inheritedStore
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined
  try {
    relay = await startRelay()
    const registered = await fetch(`${relay.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'isolated-store', password: 'isolated-secret' }),
    })
    assert.equal(registered.status, 201)
    assert.equal(existsSync(inheritedStore), false, 'inherited store path must not receive relay state')
    assert.equal(existsSync(join(relay.tempRoot, 'data', 'store.json')), true)
    await stopRelay(relay)
    relay = undefined
  } finally {
    try {
      if (relay) await stopRelay(relay)
    } finally {
      if (original === undefined) delete process.env.ZTERM_TRAVERSAL_STORE_PATH
      else process.env.ZTERM_TRAVERSAL_STORE_PATH = original
    }
  }
})

test('inherited TURN credentials are absent from isolated authentication responses', async () => {
  const names = ['ZTERM_TURN_URL', 'ZTERM_TURN_USERNAME', 'ZTERM_TURN_CREDENTIAL'] as const
  const values = [
    'turn:inherited.example.test:3478?transport=udp',
    'inherited-turn-user',
    'inherited-turn-credential',
  ] as const
  const originals = names.map((name) => process.env[name])
  names.forEach((name, index) => { process.env[name] = values[index] })
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined
  try {
    relay = await startRelay()
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const credentials = { username: `turn-isolation-${suffix}`, password: `turn-${suffix}` }
    const registered = await fetch(`${relay.baseUrl}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
    })
    assert.equal(registered.status, 201)
    const loggedIn = await fetch(`${relay.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(credentials),
    })
    assert.equal(loggedIn.status, 200)
    const body = await loggedIn.json() as { turn?: unknown }
    assert.equal(body.turn, null, 'isolated relay must not inherit parent TURN credentials')
    await stopRelay(relay)
    relay = undefined
  } finally {
    try {
      if (relay) await stopRelay(relay)
    } finally {
      names.forEach((name, index) => {
        const original = originals[index]
        if (original === undefined) delete process.env[name]
        else process.env[name] = original
      })
    }
  }
})

test('loader resolution failure does not allocate a temporary relay root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zterm-relay-loader-failure-'))
  const originalTmpdir = process.env.TMPDIR
  const originalLoader = process.env.ACCOUNTS_TEST_TSX_LOADER
  process.env.TMPDIR = root
  process.env.ACCOUNTS_TEST_TSX_LOADER = join(root, 'missing-loader.mjs')
  try {
    await assert.rejects(startRelay(), /ACCOUNTS_TEST_TSX_LOADER does not exist/)
    assert.deepEqual(readdirSync(root), [], 'failed loader resolution must not create a temporary root')
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = originalTmpdir
    if (originalLoader === undefined) delete process.env.ACCOUNTS_TEST_TSX_LOADER
    else process.env.ACCOUNTS_TEST_TSX_LOADER = originalLoader
    rmSync(root, { recursive: true, force: true })
  }
})

test('relay startup failure keeps the startup error, clears isolated state, and preserves no process', async (t) => {
  const blockerRoot = mkdtempSync(join(tmpdir(), 'zterm-relay-setup-failure-'))
  t.after(() => rmSync(blockerRoot, { recursive: true, force: true }))
  const blocker = join(blockerRoot, 'blocker')
  writeFileSync(blocker, 'not a directory')
  const startedAt = Date.now()
  await assert.rejects(
    startRelay({ env: { ZTERM_TRAVERSAL_STORE_PATH: join(blocker, 'store.json') } }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /EEXIST|file already exists/i)
      return true
    },
  )
  assert.ok(Date.now() - startedAt < 12_000, 'startup failure must be bounded')
  assert.equal(existsSync(blocker), true, 'cleanup must not remove the external blocker path')
})

test('the owned readiness deadline stops a child that could become healthy after timeout', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'zterm-relay-readiness-timeout-'))
  const originalTmpdir = process.env.TMPDIR
  let unexpectedRelay: Awaited<ReturnType<typeof startRelay>> | null = null
  let preserveParent = false
  t.after(async () => {
    try {
      if (unexpectedRelay) await stopRelay(unexpectedRelay)
      if (!preserveParent) rmSync(parent, { recursive: true, force: true })
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = originalTmpdir
    }
  })
  process.env.TMPDIR = parent
  const startedAt = Date.now()
  const outcome = await startRelay({ readyDeadlineMs: 1 }).then(
    (relay) => ({ relay, error: undefined }),
    (error: unknown) => ({ relay: undefined, error }),
  )
  if (outcome.relay) unexpectedRelay = outcome.relay
  if (outcome.error instanceof AggregateError) preserveParent = true
  assert.ok(Date.now() - startedAt < 5_000, 'readiness timeout must remain bounded')
  assert.deepEqual(
    readdirSync(parent).filter((name) => name.startsWith('zterm-v2-accounts-relay-')),
    [],
    'readiness timeout must stop the child and remove its owned root',
  )
  if (outcome.relay) {
    await stopRelay(outcome.relay)
    unexpectedRelay = null
    assert.fail('the owned readiness deadline must not return a live relay')
  }
  assert.match(String(outcome.error), /relay did not become healthy/i)
})

test('the readiness deadline covers a matching health body decoded after expiry', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'zterm-relay-delayed-health-'))
  const tempRoot = join(parent, 'relay-root')
  const pidFile = join(parent, 'relay.pid')
  const headersFile = join(parent, 'health-headers.json')
  const stateDir = join(tempRoot, 'owned-state-dir')
  let launchedPid = -1
  const spawnChild = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args)
    launchedPid = child.pid ?? -1
    return child
  }) as typeof spawn
  let unexpectedRelay: Awaited<ReturnType<typeof startRelay>> | null = null
  let preserveParent = false
  t.after(async () => {
    if (unexpectedRelay) await stopRelay(unexpectedRelay)
    if (!preserveParent) rmSync(parent, { recursive: true, force: true })
  })
  const startedAt = Date.now()
  const outcome = await startRelay({
    entry: DELAYED_HEALTH_ENTRY,
    tempRoot,
    readyDeadlineMs: 800,
    spawnChild,
    fetchHealth: async () => {
      writeFileSync(headersFile, String(Date.now()))
      return new Response(new ReadableStream({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({
              ok: true,
              pid: launchedPid,
            })))
            controller.close()
          }, 900)
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    env: {
      ZTERM_HEALTH_PID_FILE: pidFile,
      ZTERM_HEALTH_HEADERS_FILE: headersFile,
      ZTERM_HEALTH_STATE_DIR: stateDir,
    },
  }).then(
    (relay) => ({ relay, error: undefined }),
    (error: unknown) => ({ relay: undefined, error }),
  )
  if (outcome.relay) unexpectedRelay = outcome.relay
  if (outcome.error instanceof AggregateError) preserveParent = true
  assert.ok(Date.now() - startedAt < 5_000, 'delayed health decoding must remain bounded')
  assert.ok(existsSync(headersFile), String(outcome.error))
  const headerSentAt = Number(readFileSync(headersFile, 'utf8'))
  assert.ok(
    headerSentAt >= startedAt && headerSentAt < startedAt + 800,
    'the matching health headers must arrive before the readiness deadline',
  )
  if (outcome.relay) {
    await stopRelay(outcome.relay)
    unexpectedRelay = null
    assert.fail('the matching health body after the deadline must reject startup')
  }
  assert.match(String(outcome.error), /readiness deadline|timed out|aborted/i)
  const childPid = Number(readFileSync(pidFile, 'utf8'))
  assert.ok(Number.isInteger(childPid) && childPid > 0)
  assert.equal(childPid, launchedPid, 'the probe body must identify the tracked child')
  expectProcessGone(childPid)
  assert.equal(existsSync(tempRoot), false, 'timed-out child state must be removed')
})

test('startup cleanup does not wait for an unrelated endpoint owner', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'zterm-relay-unrelated-listener-'))
  const originalTmpdir = process.env.TMPDIR
  let listener: ReturnType<typeof createServer> | undefined
  let unexpectedRelay: Awaited<ReturnType<typeof startRelay>> | null = null
  let preserveParent = false
  t.after(async () => {
    const cleanupErrors: unknown[] = []
    let relayReleased = unexpectedRelay === null
    try {
      if (unexpectedRelay) {
        await stopRelay(unexpectedRelay)
        relayReleased = true
      }
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      const activeListener = listener
      if (activeListener?.listening) {
        await new Promise<void>((resolve, reject) => {
          activeListener.close((error) => error ? reject(error) : resolve())
        })
      }
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (originalTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = originalTmpdir
    if (relayReleased && !preserveParent) rmSync(parent, { recursive: true, force: true })
    if (cleanupErrors.length === 1) throw cleanupErrors[0]
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'collision fixture cleanup failed')
    }
  })
  process.env.TMPDIR = parent
  listener = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, pid: 999_999_999 }))
  })
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  const startedAt = Date.now()
  const outcome = await startRelay({ port: address.port }).then(
    (relay) => ({ relay, error: undefined }),
    (error: unknown) => ({ relay: undefined, error }),
  )
  if (outcome.relay) unexpectedRelay = outcome.relay
  if (outcome.error instanceof AggregateError) preserveParent = true
  assert.equal(outcome.relay, undefined, 'a foreign endpoint owner must reject startup')
  assert.match(String(outcome.error), /relay exited before readiness|relay serving pid/i)
  assert.ok(Date.now() - startedAt < 5_000, 'unrelated endpoint owner must not extend startup cleanup')
  assert.deepEqual(readdirSync(parent), [], 'owned temporary state must be removed')
  assert.equal(listener.listening, true, 'cleanup must preserve the unrelated endpoint owner')
})

test('synchronous child launch failure removes its temporary root and preserves the launch cause', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'zterm-relay-sync-launch-failure-'))
  const originalTmpdir = process.env.TMPDIR
  process.env.TMPDIR = parent
  try {
    await assert.rejects(
      startRelay({
        spawnChild: () => { throw new Error('injected synchronous launch failure') },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /relay child launch failed.*injected synchronous launch failure/i)
        assert.ok(error.cause instanceof Error)
        return true
      },
    )
    assert.deepEqual(readdirSync(parent), [], 'synchronous launch failure must remove its root')
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = originalTmpdir
    rmSync(parent, { recursive: true, force: true })
  }
})

test('asynchronous child launch failure is bounded and removes its temporary root', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'zterm-relay-async-launch-failure-'))
  const originalTmpdir = process.env.TMPDIR
  let unexpectedRelay: Awaited<ReturnType<typeof startRelay>> | null = null
  let preserveParent = false
  t.after(async () => {
    try {
      if (unexpectedRelay) await stopRelay(unexpectedRelay)
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = originalTmpdir
    }
    if (!preserveParent) rmSync(parent, { recursive: true, force: true })
  })
  process.env.TMPDIR = parent
  const startedAt = Date.now()
  let releaseAbortWait = () => {}
  const abortWaitGate = new Promise<void>((resolve) => { releaseAbortWait = resolve })
  let releaseProbe = () => {}
  const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve })
  let probeStarted = false
  let probeAborted = false
  let probeAbortReason: unknown
  let signalProbeStarted = () => {}
  let signalProbeAborted = () => {}
  const probeStartedGate = new Promise<void>((resolve) => { signalProbeStarted = resolve })
  const probeAbortedGate = new Promise<void>((resolve) => { signalProbeAborted = resolve })
  const fetchHealth: typeof fetch = async (_input, init) => {
    probeStarted = true
    signalProbeStarted()
    const signal = init?.signal
    const abortObserved = new Promise<void>((resolve) => {
      const finish = () => {
        probeAborted = true
        probeAbortReason = signal?.reason
        signalProbeAborted()
        resolve()
      }
      if (signal?.aborted) finish()
      else signal?.addEventListener('abort', finish, { once: true })
    })
    await Promise.race([abortObserved, abortWaitGate])
    await probeGate
    if (probeAborted) {
      probeAborted = true
      throw signal?.reason ?? new Error('readiness probe aborted')
    }
    throw new Error('readiness probe did not abort')
  }
  let startupSettled = false
  const startup = startRelay({ execPath: join(parent, 'missing-node'), fetchHealth }).then(
    (relay) => {
      startupSettled = true
      unexpectedRelay = relay
      return { relay, error: undefined }
    },
    (error: unknown) => {
      startupSettled = true
      if (error instanceof AggregateError) preserveParent = true
      return { relay: undefined, error }
    },
  )
  let milestoneTimer: ReturnType<typeof setTimeout> | undefined
  let assertionError: unknown
  try {
    const milestone = await Promise.race([
      Promise.all([probeStartedGate, probeAbortedGate]).then(() => 'probes' as const),
      startup.then(() => 'startup' as const),
      new Promise<'timeout'>((resolve) => {
        milestoneTimer = setTimeout(() => resolve('timeout'), 2_000)
      }),
    ])
    assert.equal(milestone, 'probes', 'the bounded fixture must observe probe start and abort')
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    assert.equal(startupSettled, false, 'startup must await the active readiness probe')
  } catch (error) {
    assertionError = error
  } finally {
    if (milestoneTimer) clearTimeout(milestoneTimer)
    releaseAbortWait()
    releaseProbe()
  }
  const outcome = await startup
  if (assertionError) throw assertionError
  assert.equal(outcome.relay, undefined)
  const error = outcome.error
  assert.ok(error instanceof Error)
  assert.match(error.message, /ENOENT/i)
  assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT')
  assert.equal(probeAbortReason, error.cause, 'launch failure must be the probe abort reason')
  assert.ok(Date.now() - startedAt < 2_500, 'asynchronous launch failure must not wait for an exit timer')
  assert.equal(probeStarted, true, 'the launch-failure regression must exercise an active probe')
  assert.equal(probeAborted, true, 'child launch failure must abort the active readiness probe')
  assert.deepEqual(readdirSync(parent), [], 'asynchronous launch failure must remove its root')
})

test('relay startup failure preserves both the startup error and a cleanup error', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'zterm-relay-double-failure-'))
  let removeReached = false
  let preserveRoot = false
  let unexpectedRelay: Awaited<ReturnType<typeof startRelay>> | null = null
  t.after(async () => {
    let relayReleased = unexpectedRelay === null
    try {
      if (unexpectedRelay) {
        await stopRelay(unexpectedRelay)
        relayReleased = true
      }
    } finally {
      if (relayReleased && (removeReached || !preserveRoot)) {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })
  const outcome = await startRelay({
      tempRoot: root,
      entry: join(root, 'missing-entry.ts'),
      removeState: () => {
        removeReached = true
        throw new Error('injected cleanup failure')
      },
    }).then(
      (relay) => ({ relay, error: undefined }),
      (error: unknown) => ({ relay: undefined, error }),
    )
  if (outcome.relay) unexpectedRelay = outcome.relay
  if (outcome.error instanceof AggregateError && !removeReached) preserveRoot = true
  assert.equal(outcome.relay, undefined)
  assert.ok(outcome.error instanceof AggregateError)
  assert.match(outcome.error.message, /exited before readiness|startup/i)
  assert.match(outcome.error.message, /injected cleanup failure/i)
  assert.equal(outcome.error.errors.length, 2)
  assert.equal(removeReached, true, 'the fixture must exercise the injected root remover')
})

test('relay teardown forces the serving process down when SIGTERM is ignored', async (t) => {
  const relay = await startRelay({ entry: STUBBORN_ENTRY })
  let activeRelay: Awaited<ReturnType<typeof startRelay>> | null = relay
  t.after(async () => {
    if (activeRelay) await stopRelay(activeRelay)
  })
  assert.equal(relay.pid, relay.child.pid)
  const result = await stopRelay(relay)
  activeRelay = null
  assert.equal(result.forced, true)
  assert.equal(relay.child.signalCode, 'SIGKILL')
  expectProcessGone(relay.pid)
  assert.equal(existsSync(relay.tempRoot), false)
})
