import type { TraversalResolvedPath } from './types';

export const DEFAULT_TRAVERSAL_PATH_PRIORITY: TraversalResolvedPath[] = [
  'lan',
  'tailscale',
  'ipv6',
  'ipv4',
  'rtc-relay',
  'rtc-direct',
];

export function normalizeTraversalPathPriority(input: unknown): TraversalResolvedPath[] {
  const seen = new Set<TraversalResolvedPath>();
  const next: TraversalResolvedPath[] = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (
        item === 'lan'
        || item === 'tailscale'
        || item === 'ipv4'
        || item === 'ipv6'
        || item === 'rtc-direct'
        || item === 'rtc-relay'
      ) {
        if (!seen.has(item)) {
          seen.add(item);
          next.push(item);
        }
      }
    }
  }
  for (const item of DEFAULT_TRAVERSAL_PATH_PRIORITY) {
    if (!seen.has(item)) {
      seen.add(item);
      next.push(item);
    }
  }
  return next;
}
