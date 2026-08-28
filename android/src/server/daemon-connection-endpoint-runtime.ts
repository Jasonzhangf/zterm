import { isIP } from 'net';
import { networkInterfaces } from 'os';
import type { RelayEndpointCandidate } from '@zterm/shared/relay-directory';

export interface DaemonNetworkInterfaceAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

export type DaemonNetworkInterfaceMap = Record<
  string,
  DaemonNetworkInterfaceAddress[] | undefined
>;

interface DaemonPublicUdpEndpoint {
  host: string;
  port: number;
}

function parseIpv4Octets(address: string) {
  if (isIP(address) !== 4) {
    return null;
  }
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null;
}

function isTailscaleIpv4(address: string) {
  const octets = parseIpv4Octets(address);
  return Boolean(octets && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127);
}

function isPrivateLanIpv4(address: string) {
  const octets = parseIpv4Octets(address);
  if (!octets) {
    return false;
  }
  const [first, second] = octets;
  if (first === 10 || (first === 172 && second! >= 16 && second! <= 31) || (first === 192 && second === 168)) {
    return true;
  }
  return false;
}

function normalizePort(value: number) {
  if (!Number.isFinite(value)) {
    throw new Error('daemon endpoint port must be finite');
  }
  const port = Math.floor(value);
  if (port < 1 || port > 65_535) {
    throw new Error(`daemon endpoint port out of range: ${value}`);
  }
  return port;
}

function normalizePublicUdpEndpoint(input?: DaemonPublicUdpEndpoint | null) {
  if (!input) {
    return null;
  }
  const host = input.host.trim();
  if (!host || isIP(host) === 0) {
    throw new Error('daemon public UDP endpoint host must be an IP address');
  }
  return {
    host,
    port: normalizePort(input.port),
  };
}

function listInterfaceAddresses(interfaces: DaemonNetworkInterfaceMap) {
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      const family = entry.family === 4 ? 'IPv4' : entry.family === 6 ? 'IPv6' : entry.family;
      const address = entry.address.trim();
      if (entry.internal || family !== 'IPv4' || !address || address === '0.0.0.0') {
        continue;
      }
      addresses.push(address);
    }
  }
  return [...new Set(addresses)].sort((left, right) => left.localeCompare(right));
}

export function buildDaemonConnectionEndpointCandidates(options: {
  hostId: string;
  bridgePort: number;
  authToken?: string;
  now: string;
  interfaces?: DaemonNetworkInterfaceMap;
  publicUdpEndpoint?: DaemonPublicUdpEndpoint | null;
}): RelayEndpointCandidate[] {
  const hostId = options.hostId.trim();
  if (!hostId) {
    throw new Error('daemon endpoint publication requires hostId');
  }
  const bridgePort = normalizePort(options.bridgePort);
  const now = options.now.trim();
  if (!now) {
    throw new Error('daemon endpoint publication requires timestamp');
  }
  const addresses = listInterfaceAddresses(
    options.interfaces || networkInterfaces() as DaemonNetworkInterfaceMap,
  );
  const lanAddresses = addresses.filter((address) => isPrivateLanIpv4(address) && !isTailscaleIpv4(address));
  const tailscaleAddresses = addresses.filter(isTailscaleIpv4);
  const publicUdpEndpoint = normalizePublicUdpEndpoint(options.publicUdpEndpoint);
  const authToken = options.authToken?.trim() || '';
  const authFields = authToken ? { authToken } : {};

  const candidates: RelayEndpointCandidate[] = lanAddresses.map((host) => ({
    id: `lan:${host}:${bridgePort}`,
    kind: 'lan',
    host,
    port: bridgePort,
    ...authFields,
    authRequired: true,
    lastSeenAt: now,
  }));

  candidates.push(publicUdpEndpoint
    ? {
        id: `rtc-direct:${publicUdpEndpoint.host}:${publicUdpEndpoint.port}`,
        kind: 'rtc-direct',
        host: publicUdpEndpoint.host,
        port: publicUdpEndpoint.port,
        relayHostId: hostId,
        ...authFields,
        authRequired: true,
        lastSeenAt: now,
      }
    : {
        id: `rtc-direct:${hostId}`,
        kind: 'rtc-direct',
        relayHostId: hostId,
        ...authFields,
        authRequired: true,
        lastSeenAt: now,
      });

  candidates.push(...tailscaleAddresses.map((host) => ({
    id: `tailscale:${host}:${bridgePort}`,
    kind: 'tailscale' as const,
    host,
    port: bridgePort,
    ...authFields,
    authRequired: true,
    lastSeenAt: now,
  })));

  candidates.push({
    id: `relay-rtc:${hostId}`,
    kind: 'relay-rtc',
    relayHostId: hostId,
    ...authFields,
    authRequired: true,
    lastSeenAt: now,
  });

  return candidates;
}

export function resolveDaemonTailscaleUpdateManifestUrl(options: {
  bridgePort: number;
  interfaces?: DaemonNetworkInterfaceMap;
}) {
  const bridgePort = normalizePort(options.bridgePort);
  const addresses = listInterfaceAddresses(
    options.interfaces || networkInterfaces() as DaemonNetworkInterfaceMap,
  );
  const tailscaleHost = addresses.find(isTailscaleIpv4);
  return tailscaleHost ? `http://${tailscaleHost}:${bridgePort}/updates/latest.json` : '';
}
