import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountsError, AuthService, V1RelayAdapter } from '../../src/public/contracts.ts'

interface FakeAccount {
  id: string
  username: string
  password: string
  devices: Array<{ deviceId: string; deviceName: string; platform: string }>
  updatedAt: string
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createFakeRelay(accounts: FakeAccount[]) {
  const tokens = new Map<string, string>()
    const revokedTokens = new Set<string>()
  const calls: string[] = []
  let sequence = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}`)
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = JSON.parse(String(init?.body ?? '{}')) as { username?: string; password?: string }

    if (url.pathname === '/api/auth/register' && method === 'POST') {
      const username = typeof body.username === 'string' ? body.username.trim() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      if (!username) {
        return json({ ok: false, message: 'username is required' }, 400)
      }
      if (!password.trim()) {
        return json({ ok: false, message: 'password is required' }, 400)
      }
      if (accounts.some((a) => a.username === username)) {
        return json({ ok: false, message: 'username already exists' }, 400)
      }
      const account: FakeAccount = {
        id: `acct-${username}`,
        username,
        password,
        devices: [],
        updatedAt: '2026-11-03T00:00:00.000Z',
      }
      accounts.push(account)
      return json(
        { ok: true, user: { id: account.id, username: account.username, createdAt: account.updatedAt } },
        201,
      )
    }

    if (url.pathname === '/api/auth/login' && method === 'POST') {
      const account = accounts.find((a) => a.username === body.username && a.password === body.password)
      if (!account) {
        return json({ error: 'invalid_credentials' }, 401)
      }
      const token = `token-${++sequence}`
      tokens.set(token, account.id)
      return json({ accessToken: token, user: { id: account.id, username: account.username } }, 200)
    }

    const rawAuth = headers['authorization'] ?? headers['Authorization'] ?? ''
    const token = rawAuth.toLowerCase().startsWith('bearer ') ? rawAuth.slice(7) : ''
    const accountId = token.length > 0 ? tokens.get(token) : undefined
    const account = accounts.find((a) => a.id === accountId)

      if (url.pathname === "/api/auth/logout" && method === "POST") {
        if (!account || revokedTokens.has(token)) {
          return json({ ok: false, error: { code: "auth_invalid", message: "invalid access token" } }, 401)
        }
        revokedTokens.add(token)
        return json({ ok: true, user: { id: account.id } }, 200)
      }
      if (revokedTokens.has(token)) {
        return json({ ok: false, message: "unauthorized" }, 401)
      }

    if (url.pathname === '/api/auth/me' && method === 'GET') {
      if (!account) {
        return json({ ok: false, message: 'unauthorized' }, 401)
      }
      // V1 relay /me intentionally does not echo the access token back.
      return json({ ok: true, user: { id: account.id, username: account.username } }, 200)
    }

    return json({ error: 'not_found' }, 404)
  }
  return { fetchImpl, calls, tokens }
}

const NOW = Date.UTC(2026, 10, 3, 0, 0, 0)
const TTL = 60_000

function createHarness() {
  const relay = createFakeRelay([
    {
      id: 'acct-alice',
      username: 'alice',
      password: 'secret-a',
      devices: [],
      updatedAt: '2026-11-03T00:00:00.000Z',
    },
  ])
  const adapter = new V1RelayAdapter({ baseUrl: 'http://relay.test', fetchImpl: relay.fetchImpl })
  const auth = new AuthService({ authority: adapter, now: () => NOW, sessionTtlMs: TTL })
  return { adapter, auth, relay }
}

function expectError(code: AccountsError['code'], status: AccountsError['status'], message?: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AccountsError, 'expected an AccountsError')
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    if (message !== undefined) {
      assert.equal(error.message, message)
    }
    return true
  }
}

test('register creates a relay account without issuing or consuming a session token', async () => {
  const { auth, relay } = createHarness()
  const before = relay.calls.length

  const result = await auth.register({ loginName: 'newuser', credential: 'secret-new' })

  assert.deepEqual(result, { accountId: 'acct-newuser', loginName: 'newuser' })
  assert.equal(relay.calls.length, before + 1, 'register must call only POST /api/auth/register')
  assert.equal(relay.calls[before], 'POST /api/auth/register')
})

test('register duplicate username maps to ACCOUNT_EXISTS 409', async () => {
  const { auth } = createHarness()
  await assert.rejects(
    auth.register({ loginName: 'alice', credential: 'secret' }),
    expectError('ACCOUNT_EXISTS', 409, 'ACCOUNT_EXISTS'),
  )
})

test('register missing password maps to INVALID_REQUEST 400', async () => {
  const { auth } = createHarness()
  await assert.rejects(
    auth.register({ loginName: 'newuser', credential: '  ' }),
    expectError('INVALID_REQUEST', 400, 'INVALID_REQUEST'),
  )
})

test('register missing username maps to INVALID_REQUEST 400', async () => {
  const { auth } = createHarness()
  await assert.rejects(
    auth.register({ loginName: '   ', credential: 'secret' }),
    expectError('INVALID_REQUEST', 400, 'INVALID_REQUEST'),
  )
})

test('register upstream 401 maps to AUTHENTICATION_REQUIRED 401', async () => {
  const { auth } = createHarness()
  const adapter = new V1RelayAdapter({
    baseUrl: 'http://relay.test',
    fetchImpl: async () => json({ ok: false, message: 'unauthorized' }, 401),
  })
  const authWithStatus = new AuthService({ authority: adapter, now: () => NOW })

  await assert.rejects(
    authWithStatus.register({ loginName: 'newuser', credential: 'secret' }),
    expectError('AUTHENTICATION_REQUIRED', 401),
  )
})

test('register upstream unknown 403 maps to typed permission denial', async () => {
  const { auth } = createHarness()
  const adapter = new V1RelayAdapter({
    baseUrl: 'http://relay.test',
    fetchImpl: async () => json({ ok: false, message: 'forbidden' }, 403),
  })
  const authWithStatus = new AuthService({ authority: adapter, now: () => NOW })

  await assert.rejects(
    authWithStatus.register({ loginName: 'newuser', credential: 'secret' }),
    expectError('RELAY_PERMISSION_DENIED', 403),
  )
})

test('register upstream 429 maps to RELAY_SERVICE_ERROR 429', async () => {
  const { auth } = createHarness()
  const adapter = new V1RelayAdapter({
    baseUrl: 'http://relay.test',
    fetchImpl: async () => json({ ok: false, message: 'rate_limited' }, 429),
  })
  const authWithStatus = new AuthService({ authority: adapter, now: () => NOW })

  await assert.rejects(
    authWithStatus.register({ loginName: 'newuser', credential: 'secret' }),
    (error: unknown) => {
      assert.ok(error instanceof AccountsError)
      assert.equal(error.code, 'RELAY_SERVICE_ERROR')
      assert.equal(error.status, 429)
      assert.equal(error.details?.upstreamStatus, 429)
      return true
    },
  )
})

test('register upstream 500 maps to RELAY_SERVICE_ERROR 502 with upstream status', async () => {
  const { auth } = createHarness()
  const adapter = new V1RelayAdapter({
    baseUrl: 'http://relay.test',
    fetchImpl: async () => json({ ok: false, message: 'server_error' }, 500),
  })
  const authWithStatus = new AuthService({ authority: adapter, now: () => NOW })

  await assert.rejects(
    authWithStatus.register({ loginName: 'newuser', credential: 'secret' }),
    (error: unknown) => {
      assert.ok(error instanceof AccountsError)
      assert.equal(error.code, 'RELAY_SERVICE_ERROR')
      assert.equal(error.status, 502)
      assert.equal(error.details?.upstreamStatus, 500)
      return true
    },
  )
})

test('register bad JSON maps to RELAY_PROTOCOL_ERROR 502', async () => {
  const { auth } = createHarness()
  const response = {
    status: 200,
    ok: true,
    async json() {
      throw new SyntaxError('bad json')
    },
  } as unknown as Response
  const adapter = new V1RelayAdapter({ baseUrl: 'http://relay.test', fetchImpl: async () => response })
  const authWithStatus = new AuthService({ authority: adapter, now: () => NOW })

  await assert.rejects(
    authWithStatus.register({ loginName: 'newuser', credential: 'secret' }),
    expectError('RELAY_PROTOCOL_ERROR', 502),
  )
})

test('verifySession revalidates through /me and backfills the caller token as accessToken', async () => {
  const { auth, relay } = createHarness()
  const { token } = await auth.login({ loginName: 'alice', credential: 'secret-a' })
  relay.calls.length = 0

  const context = await auth.verifySession(token)

  assert.equal(context.accountId, 'acct-alice')
  assert.equal(context.sessionId, token)
  assert.deepEqual(relay.calls, ['GET /api/auth/me'])
})

test('login success issues a relay token and an active auth context', async () => {
  const { auth } = createHarness()
  const result = await auth.login({ loginName: ' alice ', credential: 'secret-a' })
  assert.ok(result.token.startsWith('token-'))
  assert.equal(result.authContext.sessionId, result.token)
  assert.equal(result.authContext.accountId, 'acct-alice')
  assert.equal(result.authContext.loginName, 'alice')
  assert.equal(result.authContext.displayName, 'alice')
  assert.equal(result.authContext.credentialState, 'active')
  assert.equal(result.authContext.issuedAt, NOW)
  assert.equal(result.authContext.expiresAt, NOW + TTL)
})

test('invalid credentials propagate authority rejection as 401', async () => {
  const { auth } = createHarness()
  await assert.rejects(
    auth.login({ loginName: 'alice', credential: 'wrong' }),
    expectError('AUTHENTICATION_REQUIRED', 401, 'AUTHENTICATION_REQUIRED'),
  )
})

test('missing, empty, and unknown tokens are rejected as authentication required', async () => {
  const { auth } = createHarness()
  await assert.rejects(auth.verifySession(''), expectError('AUTHENTICATION_REQUIRED', 401, 'AUTHENTICATION_REQUIRED'))
  await assert.rejects(
    auth.verifySession('unknown-token'),
    expectError('AUTHENTICATION_REQUIRED', 401, 'AUTHENTICATION_REQUIRED'),
  )
})

test('logout revokes the relay bearer session', async () => {
  const { auth, adapter, relay } = createHarness()
  const { token } = await auth.login({ loginName: 'alice', credential: 'secret-a' })

  const result = await auth.logout(token)
  assert.equal(result.sessionId, token)
  assert.equal(result.revokedAt, NOW)

  assert.equal(relay.calls.includes('POST /api/auth/logout'), true)
    await assert.rejects(
      auth.verifySession(token),
      expectError('AUTHENTICATION_REQUIRED', 401, 'AUTHENTICATION_REQUIRED'),
    )

  // The relay rejects the revoked bearer token.
  const stillValid = await adapter.validateSession(token).then(() => null, (error) => error)
  assert.equal(stillValid.code, 'AUTHENTICATION_REQUIRED')
})
