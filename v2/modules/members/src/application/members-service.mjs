import { ERROR_CODES, fail } from '../../../organization/src/public/typed-error.mjs';
import { requireString } from '../../../organization/src/public/boundary.mjs';

const MODULE = 'members';

const READ_SCOPE = 'members:read';
const WRITE_SCOPE = 'members:write';

// Members-only error codes. The shared typed-error shape comes from the
// organization public contract; code names owned by this module stay here.
export const MEMBER_ERROR_CODES = Object.freeze({
  MEMBER_FORBIDDEN_SCOPE: 'MEMBER_FORBIDDEN_SCOPE',
  MEMBER_FORBIDDEN_WORKSPACE: 'MEMBER_FORBIDDEN_WORKSPACE',
  MEMBER_FORBIDDEN_MEMBER: 'MEMBER_FORBIDDEN_MEMBER',
  MEMBER_RUNTIME_NOT_CONFIGURED: 'MEMBER_RUNTIME_NOT_CONFIGURED',
  MEMBER_BINDING_NOT_FOUND: 'MEMBER_BINDING_NOT_FOUND',
  MEMBER_BINDING_INVALID: 'MEMBER_BINDING_INVALID',
  BINDING_HOST_UNAVAILABLE: 'BINDING_HOST_UNAVAILABLE',
  BINDING_HOST_IDENTITY_UNAVAILABLE: 'BINDING_HOST_IDENTITY_UNAVAILABLE',
  BINDING_HOST_MISMATCH: 'BINDING_HOST_MISMATCH',
});

export function createMembersService({ store, auth, organization, hostProbe = null }) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') {
    throw new TypeError('members service requires a store with read() and update()');
  }
  if (!auth || typeof auth.verify !== 'function') {
    throw new TypeError('members service requires an auth adapter with verify(token)');
  }
  if (!organization || typeof organization.getMember !== 'function') {
    throw new TypeError('members service requires an organization reader with getMember()');
  }

  // AuthContext is trusted material from the auth adapter; the caller never
  // supplies identity directly. Every public action takes the context first and
  // checks the action scope plus the target member's workspace before any
  // members store read or mutation.
  async function authorize(token, scope) {
    const context = await auth.verify(token);
    if (!context || !Array.isArray(context.scopes) || !context.scopes.includes(scope)) {
      fail(MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_SCOPE, `missing required scope ${scope}`, {
        owningModule: MODULE,
        details: { requiredScope: scope },
      });
    }
    return context;
  }

  function assertWorkspaceAllowed(context, workspaceId) {
    const allowed = context.workspaces;
    if (allowed === '*') return;
    if (Array.isArray(allowed) && allowed.includes(workspaceId)) return;
    fail(MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_WORKSPACE, `workspace ${workspaceId} is not in the granted scope`, {
      owningModule: MODULE,
      details: { workspaceId },
    });
  }

  // AuthContext.members 是成员级 allowlist。缺省继承 workspace 授权；
  // 显式 string[] 只允许列出的 memberId；空数组或畸形值拒绝而非扩大权限。
  // '*' 是畸形值，不是全成员授权。
  function assertMemberAllowed(context, memberId) {
    const granted = context.members;
    if (granted === undefined) return;
    if (Array.isArray(granted) && granted.includes(memberId)) return;
    fail(MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_MEMBER, `member ${memberId} is not in the granted member allowlist`, {
      owningModule: MODULE,
      details: { memberId, requiredGrant: 'members.allowlist' },
    });
  }

  // Reads structure and existence only. The members module never copies the
  // organization tree; memberId and workspaceId are structural references.
  async function requireMember(memberId) {
    const member = await organization.getMember(memberId);
    if (!member) {
      fail(ERROR_CODES.MEMBER_NOT_FOUND, `unknown member ${memberId}`, { owningModule: MODULE });
    }
    return member;
  }

  function requireHostProbe() {
    if (!hostProbe || typeof hostProbe.probe !== 'function') {
      throw new TypeError('members service requires a hostProbe with probe() to verify host identity');
    }
    return hostProbe;
  }

  async function configureRuntime({ token, memberId, machineId, hostKind, agentKind, launchProfileRef } = {}) {
    const context = await authorize(token, WRITE_SCOPE);
    requireString(memberId, 'memberId', MODULE);
    requireString(machineId, 'machineId', MODULE);
    requireString(hostKind, 'hostKind', MODULE);
    requireString(agentKind, 'agentKind', MODULE);
    requireString(launchProfileRef, 'launchProfileRef', MODULE);
    const member = await requireMember(memberId);
    assertWorkspaceAllowed(context, member.workspaceId);
    assertMemberAllowed(context, memberId);

    return store.update((state) => {
      // Runtime identity is owned by members. Any identity change invalidates
      // the recorded binding in the same store mutation, so a later reader can
      // never pair a new machine/host/agent/profile with an old generation/session.
      // The per-member generation counter is preserved on purpose so an
      // invalidated generation can never be reissued.
      const previous = state.runtimeConfigs[memberId];
      const identityChanged = previous && (
        previous.machineId !== machineId ||
        previous.hostKind !== hostKind ||
        previous.agentKind !== agentKind ||
        previous.launchProfileRef !== launchProfileRef
      );
      if (identityChanged) {
        delete state.bindings[memberId];
      }
      const runtime = { memberId, machineId, hostKind, agentKind, launchProfileRef };
      state.runtimeConfigs[memberId] = runtime;
      return { ...runtime };
    });
  }

  async function queryRuntime({ token, memberId } = {}) {
    const context = await authorize(token, READ_SCOPE);
    requireString(memberId, 'memberId', MODULE);
    const member = await requireMember(memberId);
    assertWorkspaceAllowed(context, member.workspaceId);
    assertMemberAllowed(context, memberId);
    const state = await store.read();
    const runtime = state.runtimeConfigs[memberId];
    return runtime ? { ...runtime } : null;
  }

  async function bindSession({ token, memberId, sessionId, anchor, expectedGeneration } = {}) {
    const context = await authorize(token, WRITE_SCOPE);
    requireString(memberId, 'memberId', MODULE);
    requireString(sessionId, 'sessionId', MODULE);
    requireString(anchor, 'anchor', MODULE);
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 0) {
      fail(ERROR_CODES.VALIDATION, 'expectedGeneration must be a non-negative integer', { owningModule: MODULE });
    }
    const member = await requireMember(memberId);
    assertWorkspaceAllowed(context, member.workspaceId);
    assertMemberAllowed(context, memberId);

    return store.update((state) => {
      const runtime = readRuntime(state, memberId);
      const currentGeneration = state.generations[memberId] ?? 0;
      if (expectedGeneration !== currentGeneration) {
        fail(ERROR_CODES.BINDING_GENERATION_STALE, `binding generation ${currentGeneration} != expected ${expectedGeneration}`, {
          owningModule: MODULE,
          details: { memberId, expectedGeneration, currentGeneration },
        });
      }
      const binding = {
        memberId,
        machineId: runtime.machineId,
        sessionId,
        anchor,
        generation: currentGeneration + 1,
      };
      state.bindings[memberId] = binding;
      state.generations[memberId] = binding.generation;
      return { ...binding };
    });
  }

  async function queryBinding({ token, memberId } = {}) {
    const context = await authorize(token, READ_SCOPE);
    requireString(memberId, 'memberId', MODULE);
    const member = await requireMember(memberId);
    assertWorkspaceAllowed(context, member.workspaceId);
    assertMemberAllowed(context, memberId);
    const state = await store.read();
    const binding = state.bindings[memberId];
    return binding ? { ...binding } : null;
  }

  function readRuntime(state, memberId) {
    const runtime = state.runtimeConfigs[memberId];
    if (!runtime) {
      fail(MEMBER_ERROR_CODES.MEMBER_RUNTIME_NOT_CONFIGURED, `member ${memberId} has no runtime configuration`, {
        owningModule: MODULE,
      });
    }
    return runtime;
  }

  function requireBinding(state, memberId, action) {
    const binding = state.bindings[memberId];
    if (!binding) {
      fail(MEMBER_ERROR_CODES.MEMBER_BINDING_NOT_FOUND, `member ${memberId} has no binding to ${action}`, {
        owningModule: MODULE,
      });
    }
    return binding;
  }

  function requireConsistentBinding(state, memberId, action) {
    const runtime = readRuntime(state, memberId);
    const binding = requireBinding(state, memberId, action);
    if (binding.machineId !== runtime.machineId) {
      fail(MEMBER_ERROR_CODES.MEMBER_BINDING_INVALID, `member ${memberId} binding belongs to another machine`, {
        owningModule: MODULE,
        details: { memberId, configuredMachineId: runtime.machineId, bindingMachineId: binding.machineId ?? null },
      });
    }
    return { runtime, binding };
  }

  async function observeHost(runtime, binding) {
    const probe = requireHostProbe();
    let observation;
    try {
      observation = await probe.probe({
        memberId: runtime.memberId,
        machineId: runtime.machineId,
        sessionId: binding.sessionId,
        anchor: binding.anchor,
      });
    } catch (error) {
      fail(MEMBER_ERROR_CODES.BINDING_HOST_UNAVAILABLE, 'host probe failed', {
        owningModule: MODULE,
        cause: error,
        retryDisposition: 'retryable',
        details: { memberId: runtime.memberId },
      });
    }
    if (!observation || observation.available !== true) {
      fail(MEMBER_ERROR_CODES.BINDING_HOST_UNAVAILABLE, 'host session/anchor is not reachable', {
        owningModule: MODULE,
        retryDisposition: 'retryable',
        details: { memberId: runtime.memberId, sessionId: binding.sessionId, anchor: binding.anchor },
      });
    }
    if (observation.anchorPresent === false) {
      fail(MEMBER_ERROR_CODES.BINDING_HOST_UNAVAILABLE, 'host anchor is gone', {
        owningModule: MODULE,
        retryDisposition: 'retryable',
        details: { memberId: runtime.memberId, anchor: binding.anchor },
      });
    }
    if (observation.machineId === null || observation.machineId === undefined) {
      fail(MEMBER_ERROR_CODES.BINDING_HOST_IDENTITY_UNAVAILABLE, 'host adapter did not report an authoritative machine identity', {
        owningModule: MODULE,
        details: { memberId: runtime.memberId, requiredPort: 'hostProbe.machineId' },
      });
    }
    if (observation.machineId !== runtime.machineId) {
      fail(MEMBER_ERROR_CODES.BINDING_HOST_MISMATCH, `host machine ${observation.machineId} != configured ${runtime.machineId}`, {
        owningModule: MODULE,
        details: { memberId: runtime.memberId, configuredMachineId: runtime.machineId, observedMachineId: observation.machineId },
      });
    }
    return observation;
  }

  async function verifyHost({ token, memberId } = {}) {
    const context = await authorize(token, READ_SCOPE);
    requireString(memberId, 'memberId', MODULE);
    const member = await requireMember(memberId);
    assertWorkspaceAllowed(context, member.workspaceId);
    assertMemberAllowed(context, memberId);
    const state = await store.read();
    const { runtime, binding } = requireConsistentBinding(state, memberId, 'verify');
    const observation = await observeHost(runtime, binding);
    return {
      verified: true,
      memberId,
      machineId: runtime.machineId,
      sessionId: binding.sessionId,
      anchor: binding.anchor,
      generation: binding.generation,
      observedAt: observation.observedAt,
    };
  }

  async function restoreBinding({ token, memberId } = {}) {
    const context = await authorize(token, WRITE_SCOPE);
    requireString(memberId, 'memberId', MODULE);
    const member = await requireMember(memberId);
    assertWorkspaceAllowed(context, member.workspaceId);
    assertMemberAllowed(context, memberId);
    const state = await store.read();
    const { runtime, binding } = requireConsistentBinding(state, memberId, 'restore');
    // Restore re-verifies the recorded host; it never starts a process itself.
    const observation = await observeHost(runtime, binding);
    return {
      restored: true,
      memberId,
      machineId: runtime.machineId,
      sessionId: binding.sessionId,
      anchor: binding.anchor,
      generation: binding.generation,
      observedAt: observation.observedAt,
    };
  }

  // Read port for routing; the composing caller already authenticated and applies
  // its own scope/workspace checks. This is not a public user action.
  async function getBinding(memberId) {
    const state = await store.read();
    const binding = state.bindings[memberId];
    return binding ? { ...binding } : null;
  }

  // Consistent runtime reader for routing. It returns the configured machine and
  // the binding generation for the same member only when the recorded binding
  // still belongs to the configured machine. A missing runtime or an invalid
  // binding is an explicit typed rejection; it never returns a null generation
  // that a caller could treat as a usable target.
  async function getRuntimeBinding(memberId) {
    const state = await store.read();
    const runtime = state.runtimeConfigs[memberId];
    if (!runtime) {
      fail(MEMBER_ERROR_CODES.MEMBER_RUNTIME_NOT_CONFIGURED, `member ${memberId} has no runtime configuration`, {
        owningModule: MODULE,
        details: { memberId },
      });
    }
    const binding = state.bindings[memberId];
    if (!binding) {
      fail(MEMBER_ERROR_CODES.MEMBER_BINDING_NOT_FOUND, `member ${memberId} has no binding`, {
        owningModule: MODULE,
        details: { memberId },
      });
    }
    if (binding.machineId !== runtime.machineId) {
      fail(MEMBER_ERROR_CODES.MEMBER_BINDING_INVALID, `member ${memberId} binding belongs to another machine`, {
        owningModule: MODULE,
        details: { memberId, configuredMachineId: runtime.machineId, bindingMachineId: binding.machineId ?? null },
      });
    }
    return {
      memberId,
      machineId: runtime.machineId,
      hostKind: runtime.hostKind,
      agentKind: runtime.agentKind,
      launchProfileRef: runtime.launchProfileRef,
      bindingGeneration: binding.generation,
      sessionId: binding.sessionId,
      anchor: binding.anchor,
    };
  }

  return Object.freeze({
    configureRuntime,
    queryRuntime,
    verifyHost,
    restoreBinding,
    bindSession,
    queryBinding,
    getBinding,
    getRuntimeBinding,
  });
}


