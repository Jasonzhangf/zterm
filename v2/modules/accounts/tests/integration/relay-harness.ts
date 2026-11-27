import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

export interface RelayServer {
  baseUrl: string
  child: ChildProcess
  tempRoot: string
  output: string[]
  pid: number
  launchFailure: Promise<never>
  fetchHealth: typeof fetch
}

export interface StartRelayOptions {
  readonly entry?: string
  readonly env?: Readonly<Record<string, string>>
  readonly tempRoot?: string
  /** Test seam for exercising the double-failure path. */
  readonly removeState?: (root: string) => void
  /** Test seams for exercising synchronous and asynchronous launch failures. */
  readonly spawnChild?: typeof spawn
  readonly execPath?: string
  readonly cwd?: string
  /** Test seam for exercising the single owned readiness deadline. */
  readonly readyDeadlineMs?: number
  /** Test seam for exercising launch-failure cancellation of an active probe. */
  readonly fetchHealth?: typeof fetch
  /** Test seam for exercising an endpoint owned outside the relay child. */
  readonly port?: number
}

export interface StopRelayResult {
  readonly forced: boolean
}

const RELAY_ROOT = fileURLToPath(new URL('../../../../../android/', import.meta.url))
const DEFAULT_ENTRY = 'src/traversal-relay/server.ts'
const TSX_BIN = process.env.ACCOUNTS_TEST_TSX ?? join(RELAY_ROOT, 'node_modules', '.bin', 'tsx')
const READY_DEADLINE_MS = 15_000
const READY_PROBE_TIMEOUT_MS = 1_000
const SHUTDOWN_WAIT_MS = 3_000
const POLL_INTERVAL_MS = 100

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

function resolveTsxLoader(): string {
  const configured = process.env.ACCOUNTS_TEST_TSX_LOADER
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`ACCOUNTS_TEST_TSX_LOADER does not exist: ${configured}`)
    }
    return configured
  }
  if (!existsSync(TSX_BIN)) {
    throw new Error(
      `ACCOUNTS_TEST_TSX is not available at ${TSX_BIN}; set it to the installed tsx binary`,
    )
  }
  // ACCOUNTS_TEST_TSX names node_modules/.bin/tsx. The loader beside the
  // package keeps Node in the spawned process, so the tracked PID is the PID
  // that serves health instead of an intermediate tsx launcher.
  const loader = join(dirname(TSX_BIN), '..', 'tsx', 'dist', 'loader.mjs')
  if (!existsSync(loader)) {
    throw new Error(`tsx loader not found beside ${TSX_BIN}`)
  }
  return loader
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate relay test port')))
        return
      }
      const port = address.port
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function pollHealth(
  relay: RelayServer,
  timeoutMs = READY_DEADLINE_MS,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  let lastError = 'not attempted'
  while (performance.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('relay readiness probe aborted')
    if (hasExited(relay.child)) {
      throw new Error(
        `relay exited before readiness: exit=${relay.child.exitCode} signal=${relay.child.signalCode}`,
      )
    }
    let response: Response | undefined
    const remainingMs = deadline - performance.now()
    if (remainingMs <= 0) break
    try {
      const timeoutSignal = AbortSignal.timeout(
        Math.max(1, Math.ceil(Math.min(READY_PROBE_TIMEOUT_MS, remainingMs))),
      )
      response = await relay.fetchHealth(`${relay.baseUrl}/health`, {
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      })
    } catch (error) {
      lastError = error instanceof Error && error.cause !== undefined
        ? `${error.message}: ${message(error.cause)}`
        : message(error)
    }
    if (response) {
      if (performance.now() >= deadline) {
        lastError = 'readiness deadline reached during health probe'
        break
      }
      if (!response.ok) {
        lastError = `HTTP ${response.status}`
      } else {
        const body = await response.json() as { pid?: unknown }
        if (performance.now() >= deadline) {
          lastError = 'readiness deadline reached while decoding health body'
          break
        }
        if (typeof body.pid !== 'number') {
          throw new Error('relay health response is missing its serving pid')
        }
        if (body.pid !== relay.child.pid) {
          throw new Error(
            `relay serving pid ${body.pid} is not the tracked pid ${relay.child.pid}`,
          )
        }
        relay.pid = body.pid
        return
      }
    }
    if (signal?.aborted) throw signal.reason ?? new Error('relay readiness probe aborted')
    const sleepMs = Math.min(POLL_INTERVAL_MS, deadline - performance.now())
    if (sleepMs <= 0) break
    await sleep(sleepMs, signal)
  }
  throw new Error(`relay did not become healthy at ${relay.baseUrl}: ${lastError}`)
}

async function waitForHealth(relay: RelayServer, timeoutMs = READY_DEADLINE_MS): Promise<void> {
  const controller = new AbortController()
  const launchFailure = relay.launchFailure.catch((error) => {
    controller.abort(error)
    throw error
  })
  const health = pollHealth(relay, timeoutMs, controller.signal)
  try {
    await Promise.race([health, launchFailure])
  } catch (error) {
    controller.abort(error)
    await health.catch(() => undefined)
    throw error
  }
}

export async function startRelay(options: StartRelayOptions = {}): Promise<RelayServer> {
  const entry = options.entry ?? DEFAULT_ENTRY
  const loader = entry.endsWith('.mjs') ? undefined : resolveTsxLoader()
  const port = options.port ?? await availablePort()
  const tempRoot = options.tempRoot ?? mkdtempSync(join(tmpdir(), 'zterm-v2-accounts-relay-'))
  const output: string[] = []
  const inheritedEnv = { ...process.env }
  delete inheritedEnv.ZTERM_TURN_URL
  delete inheritedEnv.ZTERM_TURN_USERNAME
  delete inheritedEnv.ZTERM_TURN_CREDENTIAL
  let child: ChildProcess
  try {
    const args = loader ? ['--import', loader, entry] : [entry]
    child = (options.spawnChild ?? spawn)(options.execPath ?? process.execPath, args, {
      cwd: options.cwd ?? RELAY_ROOT,
      env: {
        ...inheritedEnv,
        ZTERM_TRAVERSAL_STORE_PATH: join(tempRoot, 'data', 'store.json'),
        ...options.env,
        ZTERM_TRAVERSAL_HOST: '127.0.0.1',
        ZTERM_TRAVERSAL_PORT: String(port),
        ZTERM_TRAVERSAL_BASE_PATH: '',
        ZTERM_TRAVERSAL_DATA_DIR: join(tempRoot, 'data'),
        ZTERM_TRAVERSAL_UPDATES_DIR: join(tempRoot, 'updates'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (launchError) {
    const launch = new Error(`relay child launch failed: ${message(launchError)}`, {
      cause: launchError,
    })
    try {
      ;(options.removeState ?? ((root) => rmSync(root, { recursive: true, force: true })))(tempRoot)
    } catch (cleanupError) {
      throw new AggregateError(
        [launch, cleanupError],
        `${message(launch)} Cleanup also failed: ${message(cleanupError)}`,
      )
    }
    throw launch
  }
  child.stdout?.on('data', (chunk) => output.push(String(chunk)))
  child.stderr?.on('data', (chunk) => output.push(String(chunk)))
  child.on('error', (error) => output.push(error.message))
  const launchFailure = new Promise<never>((_, reject) => child.once('error', reject))
  const relay: RelayServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    tempRoot,
    output,
    pid: child.pid ?? -1,
    launchFailure,
    fetchHealth: options.fetchHealth ?? fetch,
  }
  try {
    await waitForHealth(relay, options.readyDeadlineMs)
    console.log(`isolated relay ready: PID ${relay.pid}; ${relay.baseUrl}; ${relay.tempRoot}`)
    return relay
  } catch (startupError) {
    const startup = new Error(
      `${message(startupError)}\n${output.join('')}`,
      { cause: startupError },
    )
    try {
      await stopRelay(relay, options.removeState)
    } catch (cleanupError) {
      throw new AggregateError(
        [startup, cleanupError],
        `${message(startup)} Cleanup also failed: ${message(cleanupError)}`,
      )
    }
    throw startup
  }
}

export async function stopRelay(
  relay: RelayServer | null,
  removeState: (root: string) => void = (root) => rmSync(root, { recursive: true, force: true }),
): Promise<StopRelayResult> {
  if (!relay) return { forced: false }
  const { child, tempRoot } = relay
  let forced = false
  const launched = Number.isInteger(child.pid) && (child.pid ?? 0) > 0
  if (launched && !hasExited(child)) {
    child.kill('SIGTERM')
    if (!(await waitForExit(child, SHUTDOWN_WAIT_MS))) {
      forced = true
      child.kill('SIGKILL')
      const exited = await waitForExit(child, SHUTDOWN_WAIT_MS)
      if (!exited) {
        throw new Error(
          `relay PID ${child.pid ?? 'unknown'} did not exit after SIGKILL; preserved ${tempRoot}`,
        )
      }
    }
  }
  if (isProcessAlive(relay.pid)) {
    throw new Error(`relay serving PID ${relay.pid} is still alive; preserved ${tempRoot}`)
  }
  removeState(tempRoot)
  assert.equal(existsSync(tempRoot), false)
  console.log(
    `relay cleanup: PID ${relay.pid || 'not-started'} exited${forced ? ' after SIGKILL' : ''}; state removed`,
  )
  return { forced }
}
