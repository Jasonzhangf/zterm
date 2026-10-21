import type {
  TraversalIceCandidateInit,
  TraversalIceCandidateLike,
  TraversalPlatform,
  TraversalRtcConfiguration,
  TraversalPeerConnectionLike,
  TraversalSessionDescriptionInit,
  TraversalSessionDescriptionLike,
  TraversalWebSocketLike,
} from '../../../../packages/shared/src/connection/traversal/types';

function requireBrowserGlobal<T>(name: string): T {
  const value = (globalThis as Record<string, unknown>)[name];
  if (!value) {
    throw new Error(`${name} is unavailable on this platform`);
  }
  return value as T;
}

export function createBrowserTraversalPlatform(): TraversalPlatform {
  return {
    createWebSocket: (url) => new (requireBrowserGlobal<new (url: string) => TraversalWebSocketLike>('WebSocket'))(url),
    createPeerConnection: (config: TraversalRtcConfiguration) => new (
      requireBrowserGlobal<new (config: TraversalRtcConfiguration) => TraversalPeerConnectionLike>('RTCPeerConnection')
    )(config),
    createSessionDescription: (init: TraversalSessionDescriptionInit) => new (
      requireBrowserGlobal<new (init: TraversalSessionDescriptionInit) => TraversalSessionDescriptionLike>('RTCSessionDescription')
    )(init),
    createIceCandidate: (init: TraversalIceCandidateInit) => new (
      requireBrowserGlobal<new (init: TraversalIceCandidateInit) => TraversalIceCandidateLike>('RTCIceCandidate')
    )(init),
    timers: {
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  };
}
