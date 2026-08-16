import { buildSessionSemanticOwnerKeyVariants } from './session-semantic-identity';
import type { Session, SessionGroupHistory } from './types';

function buildMissingSessionNamesByOwner(sessionGroups: SessionGroupHistory[]) {
  const missingByOwner = new Map<string, Set<string>>();

  for (const group of sessionGroups) {
    const missingNames = (group.missingSessionNames || [])
      .map((item) => item.trim())
      .filter(Boolean);
    if (missingNames.length === 0) {
      continue;
    }

    const ownerKeys = buildSessionSemanticOwnerKeyVariants({
      daemonHostId: group.daemonHostId,
      bridgeHost: group.bridgeHost,
      bridgePort: group.bridgePort,
    });
    for (const ownerKey of ownerKeys) {
      const names = missingByOwner.get(ownerKey) || new Set<string>();
      for (const sessionName of missingNames) {
        names.add(sessionName);
      }
      missingByOwner.set(ownerKey, names);
    }
  }

  return missingByOwner;
}

export function resolveSessionRemoteMissing(
  session: Pick<Session, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'remoteMissing'>,
  sessionGroups: SessionGroupHistory[],
) {
  if (session.remoteMissing) {
    return true;
  }

  const sessionName = session.sessionName.trim();
  if (!sessionName) {
    return false;
  }

  const missingByOwner = buildMissingSessionNamesByOwner(sessionGroups);
  const ownerKeys = buildSessionSemanticOwnerKeyVariants({
    daemonHostId: session.daemonHostId,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
  });
  for (const ownerKey of ownerKeys) {
    if (missingByOwner.get(ownerKey)?.has(sessionName)) {
      return true;
    }
  }
  return false;
}
