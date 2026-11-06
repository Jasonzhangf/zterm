import assert from 'node:assert/strict'
import { AuthService, MachineService, V1RelayAdapter } from '../../modules/accounts/src/public/contracts.ts'

const baseUrl = (process.env.ZTERM_REAL_RELAY_BASE_URL || 'http://172.17.0.1:19334').replace(/\/+$/, '')
const loginName = `real-relay-${process.pid}-${Date.now()}`
const credential = 'real-secret'

const adapter = new V1RelayAdapter({ baseUrl })
const auth = new AuthService({ authority: adapter, now: () => Date.now(), sessionTtlMs: 60000 })
const machines = new MachineService({
  directory: adapter,
  machineReg: adapter,
  verifySession: (token) => auth.verifySession(token),
  now: () => Date.now(),
})

try {
  const registered = await auth.register({ loginName, credential })
  assert.ok(registered.accountId.length > 0)
  assert.equal(registered.loginName, loginName)

  await assert.rejects(
    auth.register({ loginName, credential: 'other' }),
    (error) => error?.code === 'ACCOUNT_EXISTS' && error?.status === 409,
  )

  const login = await auth.login({ loginName, credential })
  assert.ok(login.token.length > 0)
  assert.equal(login.authContext.accountId, registered.accountId)

  const verified = await auth.verifySession(login.token)
  assert.equal(verified.accountId, registered.accountId)
  assert.equal(verified.sessionId, login.token)

  const list = await machines.listAuthorizedMachines(login.token)
  assert.ok(Array.isArray(list))
  assert.equal(list.length, 0)

  console.log(`relay-real-compose-ok base=${baseUrl} account=${registered.accountId} register->login->verifySession->list`)
} finally {
  // The server process is owned by the outer host shell and is stopped by its
  // explicit PID; this consumer never starts or kills it.
}
