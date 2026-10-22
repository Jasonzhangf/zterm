import {
  TraversalRouteHealthCache,
  type TraversalRouteHealthScope,
} from '../../shared/src/connection/traversal/route-health-cache';
import {
  TraversalSocket,
  type TraversalSocketOptions,
} from '../../shared/src/connection/traversal/socket';
import { createNodeWebSocket } from './node-websocket';
import type {
  TraversalIceCandidateInit,
  TraversalIceCandidateLike,
  TraversalPeerConnectionLike,
  TraversalPlatform,
  TraversalRtcConfiguration,
  TraversalSessionDescriptionInit,
  TraversalSessionDescriptionLike,
  TraversalSettingsSource,
  TraversalTargetSource,
  TraversalTimerPort,
} from '../../shared/src/connection/traversal/types';

export interface NodeTraversalDependencies {
  WebSocket: new (url: string) => unknown;
  RTCPeerConnection: new (config: TraversalRtcConfiguration) => unknown;
  RTCSessionDescription: new (init: TraversalSessionDescriptionInit) => unknown;
  RTCIceCandidate: new (init: TraversalIceCandidateInit) => unknown;
}

export interface NodeTraversalFactoryOptions extends NodeTraversalDependencies {
  routeHealthCache?: TraversalRouteHealthCache;
  timers?: TraversalTimerPort;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type NodeTraversalSocketOptions = DistributiveOmit<
  TraversalSocketOptions,
  'platform' | 'routeHealthCache'
>;

export interface NodeTraversalFactory {
  platform: TraversalPlatform;
  routeHealthCache: TraversalRouteHealthCache;
  createSocket(
    target: TraversalTargetSource,
    settings: TraversalSettingsSource,
    options?: NodeTraversalSocketOptions & {
      routeHealthCache?: Pick<TraversalRouteHealthCache, 'get' | 'recordSuccess' | 'recordFailure'>;
      routeHealthScope?: TraversalRouteHealthScope;
    },
  ): TraversalSocket;
}

function createNodeTimerPort(): TraversalTimerPort {
  return {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export function createNodeTraversalFactory(options: NodeTraversalFactoryOptions): NodeTraversalFactory {
  const timers = options.timers || createNodeTimerPort();
  const platform: TraversalPlatform = {
    createWebSocket: (url) => createNodeWebSocket(new options.WebSocket(url)),
    createPeerConnection: (config) => new options.RTCPeerConnection(config) as TraversalPeerConnectionLike,
    createSessionDescription: (init) =>
      new options.RTCSessionDescription(init) as TraversalSessionDescriptionLike,
    createIceCandidate: (init) => new options.RTCIceCandidate(init) as TraversalIceCandidateLike,
    timers,
  };
  const routeHealthCache = options.routeHealthCache || new TraversalRouteHealthCache({ storage: null });

  return {
    platform,
    routeHealthCache,
    createSocket: (target, settings, socketOptions = {}) => {
      const traversalOptions: TraversalSocketOptions = {
        ...socketOptions,
        platform,
        routeHealthCache: socketOptions.routeHealthCache || routeHealthCache,
      };
      return new TraversalSocket(target, settings, traversalOptions);
    },
  };
}
