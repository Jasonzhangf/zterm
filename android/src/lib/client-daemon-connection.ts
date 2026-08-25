import type { BridgeSettings } from './bridge-settings';
import type { ClientMessage } from './types';
import type { Host } from './types';
import type { SessionTransportResource } from './session-transport-runtime';
import { TraversalSocket } from './traversal/socket';
import type { BridgeTransportSocket, TraversalTargetSource } from './traversal/types';
import type { TraversalRouteHealthScope } from './traversal/route-health-cache';
import type { SessionTargetNetworkProbeFailure } from '../contexts/session-context-target-network-probe-runtime';

export interface ClientDaemonConnectionSocketFactoryOptions {
  overrideUrl?: string;
  autoReconnect?: boolean;
  /** Route-health isolation scope. Passing the client network generation here
   *  keeps WiFi/cellular/Tailscale route truth in separate buckets. */
  routeHealthScope?: TraversalRouteHealthScope;
}

export function createClientDaemonTraversalSocket(
  target: TraversalTargetSource,
  settings: Pick<BridgeSettings, 'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'transportMode' | 'traversalRelay'>,
  options: ClientDaemonConnectionSocketFactoryOptions = {},
) {
  return new TraversalSocket(target, settings, {
    overrideUrl: options.overrideUrl,
    autoReconnect: options.autoReconnect === true,
    requireOpenConfirmation: true,
    routeHealthScope: options.routeHealthScope,
  });
}

export interface ClientDaemonConnection {
  readSessionResource(sessionId: string): SessionTransportResource;
  readSessionSocket(sessionId: string): BridgeTransportSocket | null;
  readSessionTargetSocket?: (sessionId: string) => BridgeTransportSocket | null;
  readOpenSessionSocket(sessionId: string, purpose: string): BridgeTransportSocket;
  openSessionTargetTransport?: (options: ClientDaemonConnectionOpenTargetTransportOptions) => BridgeTransportSocket;
  sendSessionMessage(sessionId: string, message: ClientMessage): boolean;
  sendSessionRaw(sessionId: string, message: unknown): boolean;
  reportTargetNetworkProbeError?: (failure: SessionTargetNetworkProbeFailure) => void;
  readTargetNetworkProbeError?: () => SessionTargetNetworkProbeFailure | null;
  acknowledgeTargetNetworkProbeError?: (failure?: SessionTargetNetworkProbeFailure) => boolean;
}

export interface ClientDaemonConnectionOpenTargetTransportOptions {
  sessionId: string;
  host: Host;
  debugScope: 'connect' | 'reconnect';
  finalizeFailure: (message: string, retryable: boolean) => void;
}

function formatSocketReadyState(ws: BridgeTransportSocket | null) {
  if (!ws) {
    return 'missing';
  }
  switch (ws.readyState) {
    case 0:
      return 'connecting';
    case 1:
      return 'open';
    case 2:
      return 'closing';
    case 3:
      return 'closed';
    default:
      return `unknown:${ws.readyState}`;
  }
}

export function createClientDaemonConnection(options: {
  readSessionTransportResource: (sessionId: string) => SessionTransportResource;
  readTargetTerminalSocket?: (targetKey: string) => BridgeTransportSocket | null;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  openSessionTargetTransport?: (options: ClientDaemonConnectionOpenTargetTransportOptions) => BridgeTransportSocket;
  onTargetNetworkProbeError?: (failure: SessionTargetNetworkProbeFailure) => void;
}): ClientDaemonConnection {
  let targetNetworkProbeError: SessionTargetNetworkProbeFailure | null = null;
  const readSessionResource = (sessionId: string) => options.readSessionTransportResource(sessionId);
  const readSessionSocket = (sessionId: string) => readSessionResource(sessionId).socket || null;
  const readSessionTargetSocket = (sessionId: string) => readSessionResource(sessionId).terminalSocket || null;

  const readOpenSessionSocket = (sessionId: string, purpose: string) => {
    const resource = readSessionResource(sessionId);
    const ws = resource.socket || null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      return ws;
    }
    throw new Error(`${purpose} requires an open daemon connection (socket=${formatSocketReadyState(ws)}, target=${resource.targetKey || 'missing'}, channel=${resource.channel?.state || 'missing'})`);
  };

  const sendSessionRaw = (sessionId: string, message: unknown) => {
    const ws = readSessionSocket(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    options.sendSocketPayload(sessionId, ws, JSON.stringify(message));
    return true;
  };

  return {
    readSessionResource,
    readSessionSocket,
    readSessionTargetSocket,
    readOpenSessionSocket,
    openSessionTargetTransport: (openOptions) => {
      if (!options.openSessionTargetTransport) {
        throw new Error('client.daemon_connection target transport opener is unavailable');
      }
      const currentTargetSocket = readSessionTargetSocket(openOptions.sessionId);
      if (
        currentTargetSocket
        && (currentTargetSocket.readyState === WebSocket.OPEN || currentTargetSocket.readyState === WebSocket.CONNECTING)
      ) {
        return currentTargetSocket;
      }
      const resource = readSessionResource(openOptions.sessionId);
      const targetKey = resource.targetKey;
      if (targetKey) {
        const targetSocket = options.readTargetTerminalSocket?.(targetKey) || null;
        if (
          targetSocket
          && targetSocket.transportOwnership === 'service'
          && (targetSocket.readyState === WebSocket.OPEN || targetSocket.readyState === WebSocket.CONNECTING)
        ) {
          return targetSocket;
        }
      }
      return options.openSessionTargetTransport(openOptions);
    },
    sendSessionRaw,
    sendSessionMessage: sendSessionRaw as ClientDaemonConnection['sendSessionMessage'],
    reportTargetNetworkProbeError: (failure) => {
      targetNetworkProbeError = failure;
      options.onTargetNetworkProbeError?.(failure);
    },
    readTargetNetworkProbeError: () => targetNetworkProbeError,
    acknowledgeTargetNetworkProbeError: (failure) => {
      if (!targetNetworkProbeError || (failure && failure !== targetNetworkProbeError)) {
        return false;
      }
      targetNetworkProbeError = null;
      return true;
    },
  };
}
