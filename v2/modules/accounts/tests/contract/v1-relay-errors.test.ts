import assert from 'node:assert/strict'
import test from 'node:test'
import { AccountsError, V1RelayAdapter } from '../../src/public/contracts.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createAdapter(fetchImpl: typeof fetch): V1RelayAdapter {
  return new V1RelayAdapter({ baseUrl: 'http://relay.test', fetchImpl })
}

async function rejection(promise: Promise<unknown>): Promise<AccountsError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof AccountsError, 'expected AccountsError')
    return error
  }
  assert.fail('expected AccountsError')
}

test('V1 relay valid login maps 200 to a session', async () => {
  const adapter = createAdapter(async () =>
    jsonResponse({
      accessToken: 'token-1',
      user: { id: 'acct-1', username: 'alice' },
    }),
  )

  const session = await adapter.authenticate('alice', 'secret')
  assert.deepEqual(session, {
    accessToken: 'token-1',
    accountId: 'acct-1',
    loginName: 'alice',
  })
})

test('V1 relay login 401 remains authentication required', async () => {
  const adapter = createAdapter(async () => jsonResponse({ error: 'invalid_credentials' }, 401))
  const error = await rejection(adapter.authenticate('alice', 'wrong'))

  assert.equal(error.code, 'AUTHENTICATION_REQUIRED')
  assert.equal(error.status, 401)
})

test('V1 relay /me explicit session_revoked 403 remains session revoked', async () => {
  const adapter = createAdapter(async () =>
    jsonResponse({ error: { code: 'session_revoked', message: 'session was revoked' } }, 403),
  )
  const error = await rejection(adapter.validateSession('token-1'))

  assert.equal(error.code, 'SESSION_REVOKED')
  assert.equal(error.status, 403)
  assert.equal(error.message, 'session was revoked')
  assert.equal(error.details?.upstreamStatus, 403)
  assert.equal(error.details?.upstreamCode, 'session_revoked')
})

test('V1 relay unknown 403 preserves typed permission denial with upstream details', async () => {
  const adapter = createAdapter(async () =>
    jsonResponse({ error: { code: 'challenge_invalid', message: 'challenge is invalid' } }, 403),
  )
  const error = await rejection(adapter.validateSession('token-1'))

  assert.equal(error.code, 'RELAY_PERMISSION_DENIED')
  assert.equal(error.status, 403)
  assert.equal(error.message, 'challenge is invalid')
  assert.equal(error.details?.upstreamStatus, 403)
  assert.equal(error.details?.upstreamCode, 'challenge_invalid')
  assert.equal(error.details?.upstreamMessage, 'challenge is invalid')
})

test('V1 relay bare unknown 403 is typed permission denial, not a revoked session', async () => {
  const adapter = createAdapter(async () => jsonResponse({ error: 'forbidden' }, 403))
  const error = await rejection(adapter.validateSession('token-1'))

  assert.equal(error.code, 'RELAY_PERMISSION_DENIED')
  assert.equal(error.status, 403)
})

test('V1 relay fetch failure maps to transport error and preserves cause', async () => {
  const transportError = new Error('network unreachable')
  const adapter = createAdapter(async () => {
    throw transportError
  })
  const error = await rejection(adapter.authenticate('alice', 'secret'))

  assert.equal(error.code, 'RELAY_TRANSPORT_ERROR')
  assert.equal(error.status, 503)
  assert.equal(error.message, 'relay transport failed')
  assert.equal(error.details?.cause, 'network unreachable')
  assert.equal((error as Error & { cause?: unknown }).cause, transportError)
})

test('V1 relay upstream 500 maps to service error with upstream status', async () => {
  const adapter = createAdapter(async () => jsonResponse({ error: 'server_error' }, 500))
  const error = await rejection(adapter.authenticate('alice', 'secret'))

  assert.equal(error.code, 'RELAY_SERVICE_ERROR')
  assert.equal(error.status, 502)
  assert.equal(error.details?.upstreamStatus, 500)
})

test('V1 relay upstream 429 maps to service error with upstream status', async () => {
  const adapter = createAdapter(async () => jsonResponse({ error: 'rate_limited' }, 429))
  const error = await rejection(adapter.authenticate('alice', 'secret'))

  assert.equal(error.code, 'RELAY_SERVICE_ERROR')
  assert.equal(error.status, 429)
  assert.equal(error.details?.upstreamStatus, 429)
})

test('V1 relay bad JSON maps to protocol error and preserves parse cause', async () => {
  const parseError = new SyntaxError('bad json')
  const response = {
    status: 200,
    ok: true,
    async json() {
      throw parseError
    },
  } as unknown as Response
  const adapter = createAdapter(async () => response)
  const error = await rejection(adapter.authenticate('alice', 'secret'))

  assert.equal(error.code, 'RELAY_PROTOCOL_ERROR')
  assert.equal(error.status, 502)
  assert.equal(error.message, 'relay response was not valid JSON')
  assert.equal(error.details?.cause, 'bad json')
  assert.equal((error as Error & { cause?: unknown }).cause, parseError)
})

test('V1 relay 200 missing required session fields maps to protocol error', async () => {
  const responses = [
    jsonResponse({ user: { id: 'acct-1', username: 'alice' } }),
    jsonResponse({ accessToken: 'token-1' }),
  ]
  const adapter = createAdapter(async () => responses.shift()!)

  const loginError = await rejection(adapter.authenticate('alice', 'secret'))
  assert.equal(loginError.code, 'RELAY_PROTOCOL_ERROR')
  assert.equal(loginError.status, 502)

  const sessionError = await rejection(adapter.validateSession('token-1'))
  assert.equal(sessionError.code, 'RELAY_PROTOCOL_ERROR')
  assert.equal(sessionError.status, 502)
})

test('V1 relay malformed directory maps to protocol error', async () => {
  const responses = [
    jsonResponse({
      schemaVersion: 2,
      user: { id: 'acct-1', username: 'alice' },
      devices: [],
      updatedAt: '2026-11-03T00:00:00.000Z',
    }),
    jsonResponse({
      schemaVersion: 1,
      devices: [],
      updatedAt: '2026-11-03T00:00:00.000Z',
    }),
  ]
  const adapter = createAdapter(async () => responses.shift()!)

  const schemaError = await rejection(adapter.getDirectory('token-1'))
  assert.equal(schemaError.code, 'RELAY_PROTOCOL_ERROR')
  assert.equal(schemaError.status, 502)

  const accountError = await rejection(adapter.getDirectory('token-1'))
  assert.equal(accountError.code, 'RELAY_PROTOCOL_ERROR')
  assert.equal(accountError.status, 502)
})

  test('V1 relay directory envelope maps the real server shape', async () => {
    const adapter = createAdapter(async () =>
      jsonResponse({
        ok: true,
        user: { id: 'acct-1', username: 'alice' },
        directory: {
          schemaVersion: 1,
          user: { id: 'acct-1', username: 'alice' },
          devices: [{ deviceId: 'device-1', deviceName: 'Laptop', platform: 'macos' }],
          updatedAt: '2026-11-03T00:00:00.000Z',
        },
      }),
    )

    const directory = await adapter.getDirectory('token-1')
    assert.deepEqual(directory, {
      schemaVersion: 1,
      user: { id: 'acct-1', username: 'alice' },
      devices: [{ deviceId: 'device-1', deviceName: 'Laptop', platform: 'macos' }],
      updatedAt: '2026-11-03T00:00:00.000Z',
    })
  })

test('V1 relay register maps 201 to account info without a session', async () => {
  const adapter = createAdapter(async () =>
    jsonResponse(
      {
        ok: true,
        user: { id: 'acct-new', username: 'newuser', createdAt: '2026-11-03T00:00:00.000Z' },
      },
      201,
    ),
  )

  const registered = await adapter.register('newuser', 'secret')
  assert.deepEqual(registered, { accountId: 'acct-new', loginName: 'newuser' })
})

test('V1 relay register duplicate maps 400 to account exists', async () => {
  const adapter = createAdapter(async () =>
    jsonResponse({ ok: false, message: 'username already exists' }, 400),
  )
  const error = await rejection(adapter.register('newuser', 'secret'))

  assert.equal(error.code, 'ACCOUNT_EXISTS')
  assert.equal(error.status, 409)
})

test('V1 relay register required field maps 400 to invalid request', async () => {
  const responses = [
    jsonResponse({ ok: false, message: 'username is required' }, 400),
    jsonResponse({ ok: false, message: 'password is required' }, 400),
  ]
  const adapter = createAdapter(async () => responses.shift()!)

  const usernameError = await rejection(adapter.register('', 'secret'))
  assert.equal(usernameError.code, 'INVALID_REQUEST')
  assert.equal(usernameError.status, 400)

  const passwordError = await rejection(adapter.register('newuser', ''))
  assert.equal(passwordError.code, 'INVALID_REQUEST')
  assert.equal(passwordError.status, 400)
})

test('V1 relay register keeps 401 and 403 authorization classifications', async () => {
  const responses = [
    jsonResponse({ ok: false, message: 'unauthorized' }, 401),
    jsonResponse({ ok: false, error: { code: 'session_revoked', message: 'session was revoked' } }, 403),
  ]
  const adapter = createAdapter(async () => responses.shift()!)

  const authError = await rejection(adapter.register('newuser', 'secret'))
  assert.equal(authError.code, 'AUTHENTICATION_REQUIRED')
  assert.equal(authError.status, 401)

  const revokedError = await rejection(adapter.register('newuser', 'secret'))
  assert.equal(revokedError.code, 'SESSION_REVOKED')
  assert.equal(revokedError.status, 403)
})

test('V1 relay register keeps 429 and 500 service classifications', async () => {
  const responses = [
    jsonResponse({ ok: false, message: 'rate_limited' }, 429),
    jsonResponse({ ok: false, message: 'server_error' }, 500),
  ]
  const adapter = createAdapter(async () => responses.shift()!)

  const rateError = await rejection(adapter.register('newuser', 'secret'))
  assert.equal(rateError.code, 'RELAY_SERVICE_ERROR')
  assert.equal(rateError.status, 429)
  assert.equal(rateError.details?.upstreamStatus, 429)

  const serverError = await rejection(adapter.register('newuser', 'secret'))
  assert.equal(serverError.code, 'RELAY_SERVICE_ERROR')
  assert.equal(serverError.status, 502)
  assert.equal(serverError.details?.upstreamStatus, 500)
})

test('V1 relay register bad JSON maps to protocol error', async () => {
  const parseError = new SyntaxError('bad json')
  const response = {
    status: 200,
    ok: true,
    async json() {
      throw parseError
    },
  } as unknown as Response
  const adapter = createAdapter(async () => response)
  const error = await rejection(adapter.register('newuser', 'secret'))

  assert.equal(error.code, 'RELAY_PROTOCOL_ERROR')
  assert.equal(error.status, 502)
  assert.equal(error.message, 'relay response was not valid JSON')
  assert.equal((error as Error & { cause?: unknown }).cause, parseError)
})

test('V1 relay /me without accessToken backfills the caller token', async () => {
  const response = jsonResponse({
    ok: true,
    user: { id: 'acct-1', username: 'alice' },
  })
  const adapter = createAdapter(async () => response)

  const session = await adapter.validateSession('token-from-caller')
  assert.deepEqual(session, {
    accessToken: 'token-from-caller',
    accountId: 'acct-1',
    loginName: 'alice',
  })
})


