import { ERROR_CODES, fail, isTypedError } from '../../../organization/src/public/typed-error.mjs';
import { requireRecord, requireString } from '../../../organization/src/public/boundary.mjs';

const MODULE = 'routing';

// Routing adds one authorization code to the shared typed-error set. A verified
// token that lacks the resolve action scope, the target workspace, or the member
// grant is a distinct outcome from a missing or unknown token (UNAUTHENTICATED).
export const ROUTE_FORBIDDEN = 'ROUTE_FORBIDDEN';
export const ROUTE_RESOLVE_ACTION = 'routing:resolve';

// Runtime binding reader typed failures (members port). They must surface
// explicitly and never be masked as a missing target, an empty target, or a
// successful route.
export const MEMBER_RUNTIME_NOT_CONFIGURED = 'MEMBER_RUNTIME_NOT_CONFIGURED';
export const MEMBER_BINDING_NOT_FOUND = 'MEMBER_BINDING_NOT_FOUND';
export const MEMBER_BINDING_INVALID = 'MEMBER_BINDING_INVALID';

const RUNTIME_BINDING_FAILURES = new Set([
  MEMBER_RUNTIME_NOT_CONFIGURED,
  MEMBER_BINDING_NOT_FOUND,
  MEMBER_BINDING_INVALID,
]);

export function createRoutingService({ organization, members, auth }) {
  if (!organization || typeof organization.readWorkspace !== 'function') {
    throw new TypeError('routing service requires an organization reader with readWorkspace()');
  }
  if (!members || typeof members.getRuntimeBinding !== 'function') {
    throw new TypeError('routing service requires a runtime binding reader with getRuntimeBinding(memberId)');
  }
  if (!auth || typeof auth.verify !== 'function') {
    throw new TypeError('routing service requires an auth adapter with verify(token)');
  }

  // Authorization uses the verified AuthContext, never caller-supplied identity.
  // The action scope gates the operation and is fixed here to ROUTE_RESOLVE_ACTION;
  // the caller can never choose which scope authorizes a resolve. The workspace
  // allowlist isolates accounts; an optional member allowlist narrows the target.
  function assertAuthorized(context, { action, workspaceId }) {
    const scopes = Array.isArray(context?.scopes) ? context.scopes : [];
    if (!scopes.includes(action)) {
      fail(ROUTE_FORBIDDEN, `auth context lacks scope ${action}`, {
        owningModule: MODULE,
        details: { accountId: context?.accountId ?? null, action },
      });
    }
    const workspaces = context?.workspaces;
    const workspaceAllowed = workspaces === '*' || (Array.isArray(workspaces) && workspaces.includes(workspaceId));
    if (!workspaceAllowed) {
      fail(ROUTE_FORBIDDEN, `account is not authorized for workspace ${workspaceId}`, {
        owningModule: MODULE,
        details: { accountId: context?.accountId ?? null, workspaceId },
      });
    }
  }

  // `context.members` only accepts `string[]`. An absent field means no
  // member-level narrowing. An explicit array (including an empty one) must
  // contain the target memberId; an empty array rejects every member target.
  // `members === '*'` is an undeclared grant expansion and must be rejected.
  function assertMemberGrant(context, memberId) {
    const granted = context?.members;
    if (granted === '*') {
      fail(ROUTE_FORBIDDEN, `member grant "*" is not an allowed grant`, {
        owningModule: MODULE,
        details: { accountId: context?.accountId ?? null, memberId },
      });
    }
    if (Array.isArray(granted)) {
      if (!granted.includes(memberId)) {
        fail(ROUTE_FORBIDDEN, `account is not authorized for member ${memberId}`, {
          owningModule: MODULE,
          details: { accountId: context?.accountId ?? null, memberId },
        });
      }
      return;
    }
    if (granted !== undefined) {
      fail(ROUTE_FORBIDDEN, `invalid member grant: expected string[] or absent`, {
        owningModule: MODULE,
        details: { accountId: context?.accountId ?? null, memberId },
      });
    }
    // absent: no member-level narrowing
  }

  async function readRuntimeBinding(memberId) {
    return members.getRuntimeBinding(memberId);
  }

  function routeResult({ member, binding, group, organizationRevision, expectedGeneration }) {
    // members.getRuntimeBinding publishes the field as `bindingGeneration`;
    // routing must read that public name so a real members reader composes.
    const bindingGeneration = binding.bindingGeneration;
    if (expectedGeneration !== undefined && expectedGeneration !== bindingGeneration) {
      fail(ERROR_CODES.BINDING_GENERATION_STALE, `binding generation ${bindingGeneration} != expected ${expectedGeneration}`, {
        owningModule: MODULE,
        details: {
          memberId: member.memberId,
          expectedGeneration,
          currentGeneration: bindingGeneration,
        },
      });
    }
    return Object.freeze({
      memberId: member.memberId,
      machineId: binding.machineId,
      groupId: group.groupId,
      groupPath: group.path,
      organizationRevision,
      hostKind: binding.hostKind,
      agentKind: binding.agentKind,
      launchProfileRef: binding.launchProfileRef,
      bindingGeneration,
      sessionId: binding.sessionId,
      anchor: binding.anchor,
    });
  }

  // The authorized action is fixed internally. `resolve` does not accept a
  // caller-supplied action, so a token holding a different scope cannot be
  // elevated by naming that scope in the call.
  async function resolve({ token, workspaceId, address } = {}) {
    // Token -> trusted AuthContext. Authorization happens below, before any read.
    const context = await auth.verify(token);

    requireString(workspaceId, 'workspaceId', MODULE);
    requireRecord(address, 'address', MODULE);
    requireString(address.machineId, 'address.machineId', MODULE);
    requireString(address.groupPath, 'address.groupPath', MODULE);
    if (address.memberId !== undefined) requireString(address.memberId, 'address.memberId', MODULE);
    if (address.memberName !== undefined) requireString(address.memberName, 'address.memberName', MODULE);
    if (address.expectedGeneration !== undefined
        && (!Number.isInteger(address.expectedGeneration) || address.expectedGeneration < 0)) {
      fail(ERROR_CODES.VALIDATION, 'address.expectedGeneration must be a non-negative integer', { owningModule: MODULE });
    }

    // Workspace authorization runs before the first read. A cross-account target
    // cannot observe workspace contents and cannot cause any side effect.
    assertAuthorized(context, { action: ROUTE_RESOLVE_ACTION, workspaceId });

    const snapshot = await organization.readWorkspace(workspaceId);
    if (!snapshot) {
      fail(ERROR_CODES.ROUTE_NOT_FOUND, `unknown workspace ${workspaceId}`, { owningModule: MODULE });
    }
    const group = snapshot.groups.find((candidate) => candidate.path === address.groupPath);
    if (!group) {
      fail(ERROR_CODES.ROUTE_NOT_FOUND, `unknown group path ${address.groupPath}`, { owningModule: MODULE });
    }

    // Selectors stay separate: memberId matches the stable id only and memberName
    // matches the readable name only. Neither field ever matches the other, so an
    // id/name mixup cannot produce a false match.
    const groupMembers = snapshot.members.filter((member) => member.groupId === group.groupId);
    const matches = groupMembers.filter(
      (member) => (address.memberId === undefined || member.memberId === address.memberId)
        && (address.memberName === undefined || member.name === address.memberName),
    );

    if (address.memberId !== undefined || address.memberName !== undefined) {
      // Directed selection: exactly one candidate must match the selector.
      if (matches.length === 0) {
        fail(ERROR_CODES.ROUTE_NOT_FOUND, `no member at ${address.machineId}${address.groupPath}`, {
          owningModule: MODULE,
          details: {
            machineId: address.machineId,
            groupPath: address.groupPath,
            memberId: address.memberId ?? null,
            memberName: address.memberName ?? null,
          },
        });
      }
      if (matches.length > 1) {
        fail(ERROR_CODES.ROUTE_AMBIGUOUS, `${matches.length} members match ${address.machineId}${address.groupPath}`, {
          owningModule: MODULE,
          details: { matchCount: matches.length, memberIds: matches.map((member) => member.memberId).sort() },
        });
      }

      const member = matches[0];
      // Member-level grant check runs before the binding read, so an
      // unauthorized member target never observes session/anchor state.
      assertMemberGrant(context, member.memberId);

      // machineId comes from the runtime binding, never from the organization
      // member record. Organization members only locate group/name/memberId.
      const binding = await readRuntimeBinding(member.memberId);
      if (!binding || binding.machineId !== address.machineId) {
        fail(ERROR_CODES.ROUTE_NOT_FOUND, `no member at ${address.machineId}${address.groupPath}`, {
          owningModule: MODULE,
          details: {
            machineId: address.machineId,
            groupPath: address.groupPath,
            memberId: address.memberId ?? null,
            memberName: address.memberName ?? null,
          },
        });
      }

      return routeResult({
        member,
        binding,
        group,
        organizationRevision: snapshot.workspace.revision,
        expectedGeneration: address.expectedGeneration,
      });
    }

    // Machine + group scan: every authorized candidate reads its runtime
    // binding. Only successful bindings whose machineId matches are
    // candidates; reader failures are recorded in bindingFailures and never
    // treated as matches.
    //
    // No-selector scan narrows candidates by the AuthContext member grant
    // before any runtime-binding read: an empty grant rejects the whole scan,
    // a narrow grant only admits listed members, and unauthorized members are
    // neither read nor named in bindingFailures/memberIds. Directed selection
    // applies the same member bound via assertMemberGrant above.
    const granted = context?.members;
    if (granted === '*') {
      fail(ROUTE_FORBIDDEN, 'member grant "*" is not an allowed grant', {
        owningModule: MODULE,
        details: { accountId: context?.accountId ?? null },
      });
    }
    if (granted !== undefined && !Array.isArray(granted)) {
      fail(ROUTE_FORBIDDEN, 'invalid member grant: expected string[] or absent', {
        owningModule: MODULE,
        details: { accountId: context?.accountId ?? null },
      });
    }
    if (Array.isArray(granted) && granted.length === 0) {
      fail(ROUTE_FORBIDDEN, 'empty member grant rejects scan', {
        owningModule: MODULE,
        details: { accountId: context?.accountId ?? null },
      });
    }
    const authorizedMembers = Array.isArray(granted)
      ? groupMembers.filter((member) => granted.includes(member.memberId))
      : groupMembers;

    const candidates = [];
    const bindingFailures = [];
    for (const member of authorizedMembers) {
      let binding;
      try {
        binding = await members.getRuntimeBinding(member.memberId);
      } catch (error) {
        if (isTypedError(error) && RUNTIME_BINDING_FAILURES.has(error.code)) {
          bindingFailures.push({ memberId: member.memberId, code: error.code, message: error.message });
          continue;
        }
        throw error;
      }
      if (binding && binding.machineId === address.machineId) {
        candidates.push({ member, binding });
      }
    }

    if (candidates.length === 0) {
      fail(ERROR_CODES.ROUTE_NOT_FOUND, `no member at ${address.machineId}${address.groupPath}`, {
        owningModule: MODULE,
        details: {
          machineId: address.machineId,
          groupPath: address.groupPath,
          matchCount: 0,
          bindingFailures,
        },
      });
    }
    if (candidates.length > 1) {
      fail(ERROR_CODES.ROUTE_AMBIGUOUS, `${candidates.length} members match ${address.machineId}${address.groupPath}`, {
        owningModule: MODULE,
        details: {
          matchCount: candidates.length,
          memberIds: candidates.map((entry) => entry.member.memberId).sort(),
          bindingFailures,
        },
      });
    }

    const winner = candidates[0];
    return routeResult({
      member: winner.member,
      binding: winner.binding,
      group,
      organizationRevision: snapshot.workspace.revision,
      expectedGeneration: address.expectedGeneration,
    });
  }

  return Object.freeze({ resolve });
}
