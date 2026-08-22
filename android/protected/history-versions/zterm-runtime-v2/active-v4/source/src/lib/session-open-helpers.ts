/**
 * session-open 纯 helper 子模块（client.session_runtime）。
 * 从 useSessionOpenActions.ts 拆出：target 匹配 / 可复用 session 解析 / session group 解析。
 */
import { DEFAULT_BRIDGE_PORT } from './mobile-config';
import { resolveRelayDaemonCanonicalHostId } from './relay-account-directory';
import { sessionSemanticOwnersMatch } from './session-semantic-identity';
import type { Session, SessionGroupHistory, TraversalRelayDeviceSnapshot } from './types';
import type { BridgeTarget } from './session-picker';

export function buildGeneratedSessionName() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  return `zterm-${stamp}`;
}

export function normalizeEndpointKey(host?: string | null, port?: number | null) {
  const normalizedHost = host?.trim();
  if (!normalizedHost) {
    return '';
  }
  return `${normalizedHost}:${port || DEFAULT_BRIDGE_PORT}`;
}

export function normalizeDaemonKey(input: Pick<BridgeTarget, 'daemonHostId' | 'relayHostId'> | Pick<Session, 'daemonHostId'>) {
  return ('relayHostId' in input ? input.relayHostId?.trim() : '')
    || input.daemonHostId?.trim()
    || '';
}

export function sessionMatchesOpenTarget(
  session: Session,
  target: BridgeTarget,
  sessionName: string,
  matchBackend = true,
) {
  if (session.state === 'closed') {
    return false;
  }
  if (matchBackend && (session.terminalBackend || 'tmux') !== (target.terminalBackend || 'tmux')) {
    return false;
  }
  if (sessionName && session.sessionName.trim() !== sessionName) {
    return false;
  }
  const targetDaemonKey = normalizeDaemonKey(target);
  const sessionDaemonKey = normalizeDaemonKey(session);
  if (targetDaemonKey && sessionDaemonKey && targetDaemonKey === sessionDaemonKey) {
    return true;
  }
  const targetEndpointKey = normalizeEndpointKey(target.bridgeHost, target.bridgePort);
  const sessionEndpointKey = normalizeEndpointKey(session.bridgeHost, session.bridgePort);
  return Boolean(targetEndpointKey && sessionEndpointKey && targetEndpointKey === sessionEndpointKey);
}

export function resolveReusableOpenSessionForTarget(
  sessions: Session[],
  target: BridgeTarget,
  sessionName: string,
  prioritySessionIds: Array<string | null | undefined>,
  matchBackend = true,
) {
  const matches = sessions.filter((session) => sessionMatchesOpenTarget(session, target, sessionName, matchBackend));
  if (matches.length === 0) {
    return null;
  }
  for (const prioritySessionId of prioritySessionIds) {
    const normalizedPrioritySessionId = prioritySessionId?.trim();
    if (!normalizedPrioritySessionId) {
      continue;
    }
    const matched = matches.find((session) => session.id === normalizedPrioritySessionId);
    if (matched) {
      return matched;
    }
  }
  return [...matches].sort((left, right) => {
    const stateScore = (session: Session) => (session.state === 'connected' ? 2 : session.state === 'connecting' ? 1 : 0);
    const scoreDelta = stateScore(right) - stateScore(left);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return (right.createdAt || 0) - (left.createdAt || 0);
  })[0] || null;
}

export function resolveSessionGroupForTarget(
  sessionGroups: SessionGroupHistory[],
  target: Pick<BridgeTarget, 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'relayHostId' | 'authToken'> & { terminalBackend?: 'tmux' | 'herdr' },
  relayDevices: TraversalRelayDeviceSnapshot[] = [],
) {
  const canonicalTargetDaemonHostId = resolveRelayDaemonCanonicalHostId({
    daemonHostId: target.daemonHostId,
    relayHostId: target.relayHostId,
    authToken: target.authToken,
    bridgeHost: target.bridgeHost,
    bridgePort: target.bridgePort,
  }, relayDevices) || target.daemonHostId || target.relayHostId;
  return sessionGroups.find((group) => (
    (group.terminalBackend || 'tmux') === (target.terminalBackend || 'tmux')
    && sessionSemanticOwnersMatch(
      {
        ...group,
        daemonHostId: resolveRelayDaemonCanonicalHostId({
          daemonHostId: group.daemonHostId,
          authToken: group.authToken,
          bridgeHost: group.bridgeHost,
          bridgePort: group.bridgePort,
        }, relayDevices) || group.daemonHostId,
      },
      {
        bridgeHost: target.bridgeHost,
        bridgePort: target.bridgePort,
        daemonHostId: canonicalTargetDaemonHostId,
      },
    )
  )) || null;
}
