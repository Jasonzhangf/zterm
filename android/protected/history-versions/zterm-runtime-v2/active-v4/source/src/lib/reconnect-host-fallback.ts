/**
 * Enumerate the connection candidate endpoints for a Host, in priority order.
 * Each entry is an object describing one transport candidate the client can try.
 *
 * Priority (high -> low):
 *   1. bridgeHost (the host the session was originally connected through)
 *   2. tailscaleHost
 *   3. ipv4Host / ipv6Host
 *   4. relayEndpointCandidates (relay fallback)
 *
 * The list intentionally does NOT include derived / merged endpoints so the
 * caller can compare candidate keys against the previously-successful one to
 * detect a stale host.
 */
import type { Host } from '@zterm/shared';

export type ReconnectHostCandidate = {
  /** Stable identity (used to diff against the current session host). */
  candidateKey: string;
  bridgeHost: string;
  bridgePort: number;
  /** Free-form label for debug logs / overlay. */
  label: string;
  /** True when this candidate came from a relay endpoint entry. */
  isRelay: boolean;
};

export function enumerateHostCandidates(host: Host): ReconnectHostCandidate[] {
  const out: ReconnectHostCandidate[] = [];
  const port = Math.max(1, Math.floor(host.bridgePort || 3333));
  const seen = new Set<string>();

  const push = (
    bridgeHost: string | null | undefined,
    label: string,
    isRelay: boolean,
  ) => {
    const trimmed = typeof bridgeHost === 'string' ? bridgeHost.trim() : '';
    if (!trimmed) {
      return;
    }
    const key = `${trimmed.toLowerCase()}:${port}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push({
      candidateKey: key,
      bridgeHost: trimmed,
      bridgePort: port,
      label,
      isRelay,
    });
  };

  push(host.bridgeHost, 'bridge', false);
  push(host.tailscaleHost, 'tailscale', false);
  push(host.ipv4Host, 'ipv4', false);
  push(host.ipv6Host, 'ipv6', false);

  for (const candidate of host.relayEndpointCandidates || []) {
    if ('host' in candidate && candidate.host) {
      const relayPort = Number.isFinite(candidate.port)
        ? Math.max(1, Math.floor(candidate.port || port))
        : port;
      const key = `${candidate.host.toLowerCase()}:${relayPort}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({
        candidateKey: key,
        bridgeHost: candidate.host,
        bridgePort: relayPort,
        label: `relay:${candidate.kind}`,
        isRelay: true,
      });
    }
  }

  return out;
}

export function buildReconnectHostFallback(
  host: Host,
): { candidates: ReconnectHostCandidate[]; currentIndex: number } {
  const candidates = enumerateHostCandidates(host);
  if (candidates.length === 0) {
    return { candidates: [], currentIndex: -1 };
  }
  const currentKey = `${host.bridgeHost.trim().toLowerCase()}:${Math.max(1, Math.floor(host.bridgePort || 3333))}`;
  const idx = candidates.findIndex((c) => c.candidateKey === currentKey);
  return { candidates, currentIndex: idx === -1 ? 0 : idx };
}

export function pickNextReconnectCandidate(
  host: Host,
): ReconnectHostCandidate | null {
  const { candidates } = buildReconnectHostFallback(host);
  return candidates.length > 0 ? candidates[0] : null;
}
