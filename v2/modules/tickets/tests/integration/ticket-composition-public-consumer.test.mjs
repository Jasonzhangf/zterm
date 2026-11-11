import assert from 'node:assert/strict'
import test from 'node:test'

const contracts = await import('../../src/public/contracts.ts')

test('tickets public contract exposes the composition adapter used by the daemon and goals', () => {
  assert.equal(typeof contracts.createTicketComposition, 'function')
})

test('ticket composition reader denies by default and does not infer delegation', async (t) => {
  assert.equal(typeof contracts.createTicketComposition, 'function')
  let resolverInput
  const composition = contracts.createTicketComposition({
    storeFile: ':memory:',
    providerInstances: [],
    workspaceProviders: [],
    credentialProvider: { async getCredential() { return { token: 'unused' } } },
    vikunjaClient: {
      async createTask() { throw new Error('not used') },
      async getTask() { throw new Error('not used') },
      async updateTask() { throw new Error('not used') },
      async createComment() { throw new Error('not used') },
      async listComments() { throw new Error('not used') },
      async listTasks() { throw new Error('not used') },
    },
    accountReader: {
      async readAuthorization() {
        return { accountId: 'account-1', scopes: ['tickets:read'], workspaces: ['ws-1'] };
      },
    },
    organization: {
      async getMember(memberId) {
        return memberId === 'member-1' ? { memberId, workspaceId: 'ws-1' } : null;
      },
    },
    goals: {
      async goalBelongsToWorkspace(workspaceId, goalId) {
        return workspaceId === 'ws-1' && goalId === 'goal-1';
      },
    },
    actorResolver: {
      async resolve(input) {
        resolverInput = input
        return { sessionId: 'session-1', accountId: 'account-1', memberId: 'member-1', credentialState: 'active' };
      },
    },
  });
  t.after(() => composition.closeStore())

  const actor = await composition.resolveActor({ token: 'token-1', account: { accountId: 'account-1' }, workspaceId: 'ws-1' });
  assert.deepEqual(resolverInput, { token: 'token-1', workspaceId: 'ws-1' });
  assert.equal(actor.memberId, 'member-1');
  assert.equal(await composition.readers.hasWorkspaceAction({ actor, workspaceId: 'ws-1', action: 'ticket.read' }), true);
  assert.equal(await composition.readers.hasWorkspaceAction({ actor, workspaceId: 'ws-1', action: 'ticket.create' }), false);
  assert.equal(await composition.readers.actorOwnsMember(actor, 'member-1'), true);
  assert.equal(await composition.readers.actorOwnsMember(actor, 'member-2'), false);
  assert.equal(await composition.readers.hasReportDelegation({ actor, workspaceId: 'ws-1', goalId: 'goal-1', actorMemberId: 'member-2' }), false);
})

test('ticket composition rejects a binding reached through another workspace path before provider read', async () => {
  let readCalls = 0
  const composition = contracts.createTicketComposition({
    storeFile: ':memory:',
    providerInstances: [{ providerInstanceId: 'vk-1', baseUrl: 'http://127.0.0.1/vikunja', credentialRef: 'vk-cred' }],
    workspaceProviders: [{ workspaceId: 'ws-1', providerInstanceId: 'vk-1', externalProjectId: 9, authority: 'fixture' }],
    credentialProvider: { async getCredential() { return { token: 'provider-token' } } },
    vikunjaClient: {
      async createTask() {
        return {
          kind: 'success',
          status: 201,
          value: { id: 501, title: 'Scoped ticket', description: '', priority: 1, done: false, project_id: 9 },
        };
      },
      async getTask() {
        readCalls += 1;
        throw new Error('provider read must not happen for a mismatched path');
      },
      async updateTask() { throw new Error('not used') },
      async createComment() { throw new Error('not used') },
      async listComments() { throw new Error('not used') },
      async listTasks() { throw new Error('not used') },
    },
    accountReader: {
      async readAuthorization() {
        return {
          accountId: 'account-1',
          scopes: ['tickets:create', 'tickets:read', 'tickets:state:write', 'tickets:report'],
          workspaces: ['ws-1', 'ws-2'],
        };
      },
    },
    organization: {
      async getMember(memberId) {
        if (memberId === 'member-1') return { memberId, workspaceId: 'ws-1' };
        if (memberId === 'member-2') return { memberId, workspaceId: 'ws-2' };
        return null;
      },
    },
    goals: {
      async goalBelongsToWorkspace(workspaceId, goalId) {
        return workspaceId === 'ws-1' && goalId === 'goal-1';
      },
    },
    actorResolver: {
      async resolve({ workspaceId }) {
        return {
          sessionId: 'session-1',
          accountId: 'account-1',
          memberId: workspaceId === 'ws-1' ? 'member-1' : 'member-2',
          credentialState: 'active',
        };
      },
    },
  })

  try {
    const actor = await composition.resolveActor({ token: 'token-1', account: { accountId: 'account-1' }, workspaceId: 'ws-1' })
    const created = await composition.create(actor, {
      operationId: 'op-create-scoped',
      workspaceId: 'ws-1',
      goalId: 'goal-1',
      ownerMemberId: 'member-1',
      category: 'requirement',
      title: 'Scoped ticket',
      description: '',
      priority: 1,
    })
    assert.equal(created.operation.state, 'succeeded')
    assert.ok(created.binding?.bindingId)

    await assert.rejects(
      () => composition.getInWorkspace(actor, 'ws-2', created.binding.bindingId),
      (error) => error.code === 'TICKET_SCOPE_FORBIDDEN',
    )
    assert.equal(readCalls, 0)
  } finally {
    composition.closeStore()
  }
})
