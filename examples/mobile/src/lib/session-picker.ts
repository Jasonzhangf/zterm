import type { BridgeServerPreset } from './bridge-settings';
import { DEFAULT_BRIDGE_PORT } from './mobile-config';
import { isLikelyTailscaleHost } from './network-target';
import type { Host, Session } from './types';

export interface BridgeTarget {
  bridgeHost: string;
  bridgePort: number;
  authToken?: string;
}

export type HostDraft = Omit<Host, 'id' | 'createdAt'>;

export function normalizeBridgeTarget(target?: Partial<BridgeTarget> | null): BridgeTarget {
  return {
    bridgeHost: target?.bridgeHost?.trim() || '',
    bridgePort: target?.bridgePort || DEFAULT_BRIDGE_PORT,
    authToken: target?.authToken?.trim() || '',
  };
}

export function buildPreferredTarget(
  presets: BridgeServerPreset[],
  fallbackTarget?: Partial<BridgeTarget> | null,
  activeSession?: Pick<Session, 'bridgeHost' | 'bridgePort'> | null,
): BridgeTarget {
  if (activeSession?.bridgeHost?.trim()) {
    return normalizeBridgeTarget(activeSession);
  }

  if (fallbackTarget?.bridgeHost?.trim()) {
    return normalizeBridgeTarget(fallbackTarget);
  }

  if (presets[0]) {
    return normalizeBridgeTarget({
      bridgeHost: presets[0].targetHost,
      bridgePort: presets[0].targetPort,
      authToken: presets[0].authToken,
    });
  }

  return normalizeBridgeTarget(fallbackTarget);
}

export function sortHostsForPicker(hosts: Host[], target?: Partial<BridgeTarget> | null) {
  const bridgeHost = target?.bridgeHost?.trim();
  const bridgePort = target?.bridgePort || DEFAULT_BRIDGE_PORT;

  return [...hosts].sort((a, b) => {
    const aTarget = a.bridgeHost === bridgeHost && a.bridgePort === bridgePort ? 1 : 0;
    const bTarget = b.bridgeHost === bridgeHost && b.bridgePort === bridgePort ? 1 : 0;
    if (aTarget !== bTarget) {
      return bTarget - aTarget;
    }
    const aTailscale = isLikelyTailscaleHost(a.bridgeHost) ? 1 : 0;
    const bTailscale = isLikelyTailscaleHost(b.bridgeHost) ? 1 : 0;
    if (aTailscale != bTailscale) {
      return bTailscale - aTailscale;
    }
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    return (b.lastConnected || b.createdAt) - (a.lastConnected || a.createdAt);
  });
}

export function findMatchingHost(hosts: Host[], target: BridgeTarget, sessionName: string) {
  return hosts.find(
    (host) =>
      host.bridgeHost === target.bridgeHost &&
      host.bridgePort === target.bridgePort &&
      host.sessionName.trim() === sessionName.trim(),
  );
}

function uniqueTags(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

export function buildDraftFromTmuxSession(
  hosts: Host[],
  presets: BridgeServerPreset[],
  target: BridgeTarget,
  sessionName: string,
): HostDraft {
  const existing = findMatchingHost(hosts, target, sessionName);
  if (existing) {
    return {
      name: existing.name,
      bridgeHost: existing.bridgeHost,
      bridgePort: existing.bridgePort,
      sessionName: existing.sessionName,
      authToken: existing.authToken,
      authType: existing.authType,
      password: existing.password,
      privateKey: existing.privateKey,
      autoCommand: existing.autoCommand,
      tags: [...existing.tags],
      pinned: existing.pinned,
      lastConnected: existing.lastConnected,
    };
  }

  const preset = presets.find((item) => item.targetHost === target.bridgeHost && item.targetPort === target.bridgePort);
  const serverLabel = preset?.name?.trim() || target.bridgeHost;

  return {
    name: `${serverLabel} · ${sessionName}`,
    bridgeHost: target.bridgeHost,
    bridgePort: target.bridgePort,
    sessionName,
    authToken: target.authToken || preset?.authToken || '',
    authType: 'password',
    password: undefined,
    privateKey: undefined,
    autoCommand: '',
    tags: uniqueTags(['tmux', sessionName, serverLabel, isLikelyTailscaleHost(target.bridgeHost) ? 'tailscale' : 'lan']),
    pinned: false,
    lastConnected: undefined,
  };
}

export function buildCleanDraft(target: BridgeTarget): HostDraft {
  return {
    name: '',
    bridgeHost: target.bridgeHost,
    bridgePort: target.bridgePort,
    sessionName: '',
    authToken: target.authToken || '',
    authType: 'password',
    password: undefined,
    privateKey: undefined,
    autoCommand: '',
    tags: [isLikelyTailscaleHost(target.bridgeHost) ? 'tailscale' : 'lan', 'tmux'],
    pinned: false,
    lastConnected: undefined,
  };
}

export function buildTransientHostFromDraft(draft: HostDraft): Host {
  return {
    ...draft,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
}
