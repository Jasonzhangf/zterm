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

function machineError(status: number, code: string, message: string) {
  return createAdapter(async () =>
    jsonResponse({ ok: false, error: { code, message } }, status),
  )
}

test('machine relay 403 codes remain canonical typed rejections', async () => {
  const cases = [
    ['machine_not_owned', 'MACHINE_NOT_OWNED', 'machine is not owned by this account'],
    ['machine_revoked', 'MACHINE_REVOKED', 'machine is revoked'],
    ['possession_invalid', 'POSSESSION_INVALID', 'device proof is invalid'],
  ] as const

  for (const [upstreamCode, code, message] of cases) {
    const error = await rejection(
      machineError(403, upstreamCode, message).revokeMachine('token-1', 'machine-1'),
    )
    assert.equal(error.code, code)
    assert.equal(error.status, 403)
    assert.equal(error.message, message)
    assert.equal(error.details?.upstreamStatus, 403)
    assert.equal(error.details?.upstreamCode, upstreamCode)
    assert.equal(error.details?.upstreamMessage, message)
  }
})

test('machine relay canonical 409 codes remain typed conflicts', async () => {
  const cases = [
    ['machine_already_owned', 'MACHINE_ALREADY_OWNED', 'proof already owned'],
    ['machine_device_conflict', 'MACHINE_DEVICE_CONFLICT', 'device already enrolled'],
  ] as const

  for (const [upstreamCode, code, message] of cases) {
    const error = await rejection(
      machineError(409, upstreamCode, message).revokeMachine('token-1', 'machine-1'),
    )
    assert.equal(error.code, code)
    assert.equal(error.status, 409)
    assert.equal(error.message, message)
    assert.equal(error.details?.upstreamStatus, 409)
    assert.equal(error.details?.upstreamCode, upstreamCode)
  }
})

test('machine relay 404 machine_not_found remains a typed missing machine', async () => {
  const error = await rejection(
    machineError(404, 'machine_not_found', 'machine was not found')
      .revokeMachine('token-1', 'machine-1'),
  )
  assert.equal(error.code, 'MACHINE_NOT_FOUND')
  assert.equal(error.status, 404)
  assert.equal(error.message, 'machine was not found')
  assert.equal(error.details?.upstreamCode, 'machine_not_found')
})

test('machine relay unreadable 403 is a protocol error, not a revoked session', async () => {
  const parseError = new SyntaxError('bad json')
  const response = {
    status: 403,
    ok: false,
    async json() {
      throw parseError
    },
  } as unknown as Response
  const adapter = createAdapter(async () => response)
  const error = await rejection(adapter.revokeMachine('token-1', 'machine-1'))

  assert.equal(error.code, 'RELAY_PROTOCOL_ERROR')
  assert.equal(error.status, 502)
  assert.equal(error.message, 'relay response was not valid JSON')
  assert.equal(error.details?.upstreamStatus, 403)
})

test('machine list reads canonical summaries and keeps legacy device refs separate', async () => {
  const requests: Array<{ path: string; method: string; authorization: string }> = []
  const adapter = createAdapter(async (input, init) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    requests.push({
      path: url.pathname,
      method: init?.method ?? 'GET',
      authorization: headers.authorization ?? '',
    })
    return jsonResponse({
      ok: true,
      machines: [{
        machineId: 'mach-1',
        ownerAccountId: 'acct-a',
        deviceId: 'legacy-device-1',
        displayName: 'Laptop',
        status: 'active',
        createdAt: '2026-11-03T00:00:00.000Z',
      }],
    })
  })

  const machines = await adapter.listMachines('bearer-a')
  assert.deepEqual(machines, [{
    machineId: 'mach-1',
    ownerAccountId: 'acct-a',
    legacyDeviceId: 'legacy-device-1',
    displayName: 'Laptop',
    status: 'active',
    createdAt: '2026-11-03T00:00:00.000Z',
  }])
  assert.deepEqual(requests, [{
    path: '/api/machines',
    method: 'GET',
    authorization: 'bearer bearer-a',
  }])
})

test('machine list preserves unknown 403 as typed permission denial', async () => {
  const error = await rejection(
    machineError(403, 'challenge_invalid', 'challenge is invalid').listMachines('token-1'),
  )
  assert.equal(error.code, 'RELAY_PERMISSION_DENIED')
  assert.equal(error.status, 403)
  assert.equal(error.message, 'challenge is invalid')
  assert.equal(error.details?.upstreamStatus, 403)
  assert.equal(error.details?.upstreamCode, 'challenge_invalid')
  assert.equal(error.details?.upstreamMessage, 'challenge is invalid')
})

test('machine list missing endpoint preserves upstream status as service error', async () => {
  const error = await rejection(
    machineError(404, 'route_not_found', 'route not found').listMachines('token-1'),
  )
  assert.equal(error.code, 'RELAY_SERVICE_ERROR')
  assert.equal(error.status, 502)
  assert.equal(error.details?.upstreamStatus, 404)
  assert.equal(error.details?.upstreamCode, 'route_not_found')
})

test('machine list invalid response shape is a protocol error', async () => {
  const adapter = createAdapter(async () => jsonResponse({ ok: true }))
  const error = await rejection(adapter.listMachines('token-1'))
  assert.equal(error.code, 'RELAY_PROTOCOL_ERROR')
  assert.equal(error.status, 502)
})

test('machine adapter forwards bearer authority and canonical request bodies', async () => {
  const requests: Array<{ path: string; method: string; authorization: string; body: Record<string, unknown> }> = []
  const adapter = createAdapter(async (input, init) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    requests.push({
      path: url.pathname,
      method: init?.method ?? 'GET',
      authorization: headers.authorization ?? '',
      body,
    })

    if (url.pathname === '/api/machines/enroll/challenge') {
      return jsonResponse({ ok: true, requestId: 'enroll-request', challenge: 'enroll-challenge' })
    }
    if (url.pathname === '/api/machines/enroll/verify') {
      return jsonResponse({ ok: true, machineId: 'mach-enrolled', ownerAccountId: 'acct-a' })
    }
    if (url.pathname === '/api/machines/possession/challenge') {
      return jsonResponse({ ok: true, requestId: 'possession-request', challenge: 'possession-challenge' })
    }
    if (url.pathname === '/api/machines/possession/verify') {
      return jsonResponse({ ok: true, machineId: 'mach-enrolled', ownerAccountId: 'acct-a' })
    }
    if (url.pathname === '/api/machines/mach%2Fone/revoke') {
      return jsonResponse({ ok: true, machineId: 'mach/one', status: 'revoked' })
    }
    return jsonResponse({ ok: false, error: { code: 'machine_not_found', message: 'missing' } }, 404)
  })

  assert.deepEqual(
    await adapter.enroll('bearer-a', { deviceId: 'device-a', deviceToken: 'proof-a' }, ' Laptop A '),
    { machineId: 'mach-enrolled', ownerAccountId: 'acct-a' },
  )
  assert.deepEqual(
    await adapter.verifyPossession('bearer-a', 'mach/one', 'proof-a'),
    { machineId: 'mach-enrolled', ownerAccountId: 'acct-a' },
  )
  assert.deepEqual(
    await adapter.revokeMachine('bearer-a', 'mach/one'),
    { machineId: 'mach/one', status: 'revoked' },
  )

  assert.deepEqual(requests, [
    {
      path: '/api/machines/enroll/challenge',
      method: 'POST',
      authorization: 'bearer bearer-a',
      body: { deviceId: 'device-a' },
    },
    {
      path: '/api/machines/enroll/verify',
      method: 'POST',
      authorization: 'bearer bearer-a',
      body: {
        requestId: 'enroll-request',
        challenge: 'enroll-challenge',
        deviceToken: 'proof-a',
        displayName: 'Laptop A',
      },
    },
    {
      path: '/api/machines/possession/challenge',
      method: 'POST',
      authorization: 'bearer bearer-a',
      body: { machineId: 'mach/one' },
    },
    {
      path: '/api/machines/possession/verify',
      method: 'POST',
      authorization: 'bearer bearer-a',
      body: {
        requestId: 'possession-request',
        challenge: 'possession-challenge',
        deviceToken: 'proof-a',
      },
    },
    {
      path: '/api/machines/mach%2Fone/revoke',
      method: 'POST',
      authorization: 'bearer bearer-a',
      body: {},
    },
  ])
})
