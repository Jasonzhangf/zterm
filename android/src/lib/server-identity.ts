import { getServerColorToneByKey, type ServerColorTone } from './server-color';

export type ServerIdentityInput = {
  bridgeHost?: string | null;
  bridgePort?: number | null;
  daemonHostId?: string | null;
  connectionName?: string | null;
};

export type ServerIdentityAliasMap = Map<string, { key: string; label: string } | null>;

function trimOrEmpty(value?: string | null) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripPort(host: string) {
  const trimmed = host.trim();
  if (!trimmed) {
    return '';
  }
  const ipv6Match = trimmed.match(/^\[(.+)\]:(\d+)$/);
  if (ipv6Match) {
    return ipv6Match[1];
  }
  const hostParts = trimmed.split(':');
  if (hostParts.length === 2 && /^\d+$/.test(hostParts[1])) {
    return hostParts[0];
  }
  return trimmed;
}

function stripSessionSuffix(label: string) {
  return label.split(' · ')[0]?.trim() || label.trim();
}

export function resolveServerIdentityKey(input: ServerIdentityInput) {
  const daemonHostId = trimOrEmpty(input.daemonHostId);
  if (daemonHostId) {
    return daemonHostId;
  }
  const bridgeHost = trimOrEmpty(input.bridgeHost);
  if (bridgeHost) {
    const bridgePort = typeof input.bridgePort === 'number' ? input.bridgePort : null;
    return bridgePort ? `${bridgeHost}:${bridgePort}` : bridgeHost;
  }
  const connectionName = trimOrEmpty(input.connectionName);
  if (connectionName) {
    return connectionName;
  }
  return 'unknown-server';
}

export function resolveServerDisplayName(input: ServerIdentityInput) {
  const daemonHostId = trimOrEmpty(input.daemonHostId);
  if (daemonHostId) {
    return daemonHostId;
  }
  const connectionName = trimOrEmpty(input.connectionName);
  if (connectionName) {
    return stripSessionSuffix(connectionName);
  }
  const bridgeHost = trimOrEmpty(input.bridgeHost);
  if (bridgeHost) {
    return stripPort(bridgeHost);
  }
  return 'unknown server';
}

function resolveServerEndpointKey(input: ServerIdentityInput) {
  const bridgeHost = trimOrEmpty(input.bridgeHost);
  if (!bridgeHost) {
    return '';
  }
  const host = stripPort(bridgeHost);
  const bridgePort = typeof input.bridgePort === 'number' ? input.bridgePort : null;
  return bridgePort ? `${host}:${bridgePort}` : host;
}

export function buildServerIdentityAliasMap(inputs: readonly ServerIdentityInput[]): ServerIdentityAliasMap {
  const aliases: ServerIdentityAliasMap = new Map();
  for (const input of inputs) {
    const daemonHostId = trimOrEmpty(input.daemonHostId);
    const endpointKey = resolveServerEndpointKey(input);
    if (!daemonHostId || !endpointKey) {
      continue;
    }
    const nextAlias = {
      key: daemonHostId,
      label: resolveServerDisplayName(input),
    };
    const existingAlias = aliases.get(endpointKey);
    if (existingAlias && existingAlias.key !== nextAlias.key) {
      aliases.set(endpointKey, null);
      continue;
    }
    if (existingAlias === null) {
      continue;
    }
    aliases.set(endpointKey, nextAlias);
  }
  return aliases;
}

export function resolveServerIdentity(
  input: ServerIdentityInput,
  aliases?: ServerIdentityAliasMap | null,
) {
  const endpointKey = resolveServerEndpointKey(input);
  const aliased = endpointKey ? aliases?.get(endpointKey) : null;
  if (aliased) {
    return aliased;
  }
  return {
    key: resolveServerIdentityKey(input),
    label: resolveServerDisplayName(input),
  };
}

export function getServerIdentityTone(input: ServerIdentityInput): ServerColorTone {
  return getServerColorToneByKey(resolveServerIdentityKey(input));
}
