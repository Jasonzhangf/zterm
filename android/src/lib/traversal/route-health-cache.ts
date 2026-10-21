import {
  TraversalRouteHealthCache as SharedTraversalRouteHealthCache,
  type TraversalRouteHealthCacheOptions,
  type TraversalRouteHealthStorage,
} from '../../../../packages/shared/src/connection/traversal/route-health-cache';

export { buildTraversalRouteHealthKey } from '../../../../packages/shared/src/connection/traversal/route-health-cache';
export type {
  TraversalRouteHealthCacheOptions,
  TraversalRouteHealthScope,
  TraversalRouteHealthStorage,
} from '../../../../packages/shared/src/connection/traversal/route-health-cache';

function resolveBrowserRouteHealthStorage(): TraversalRouteHealthStorage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export class TraversalRouteHealthCache extends SharedTraversalRouteHealthCache {
  public constructor(options: TraversalRouteHealthCacheOptions = {}) {
    super({
      ...options,
      storage: options.storage === undefined ? resolveBrowserRouteHealthStorage() : options.storage,
    });
  }
}

export const defaultTraversalRouteHealthCache = new TraversalRouteHealthCache();
