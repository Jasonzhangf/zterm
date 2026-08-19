import {
  sendAndroidConnectionCommand,
} from '../plugins/AndroidConnectionServicePlugin';
import type { Host } from './types';
import { buildTransportTargetKey } from './session-transport-runtime';
import { AndroidConnectionServiceTransportSocket } from './android-connection-service-socket';
import type { AndroidConnectionServiceTarget } from './android-connection-service-commands';
import type { BridgeTransportSocket } from './traversal/types';

export function buildAndroidConnectionServiceTarget(host: Host): AndroidConnectionServiceTarget {
  return {
    targetKey: buildTransportTargetKey(host),
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    ...(host.authToken ? { authToken: host.authToken } : {}),
    ...(host.daemonHostId ? { daemonHostId: host.daemonHostId } : {}),
    ...(host.relayHostId ? { relayHostId: host.relayHostId } : {}),
    ...(host.tailscaleHost ? { tailscaleHost: host.tailscaleHost } : {}),
    ...(host.ipv6Host ? { ipv6Host: host.ipv6Host } : {}),
    ...(host.ipv4Host ? { ipv4Host: host.ipv4Host } : {}),
    ...(host.signalUrl ? { signalUrl: host.signalUrl } : {}),
  };
}

export function openAndroidConnectionServiceTransportSocket(
  host: Host,
  sessionName: string,
): BridgeTransportSocket {
  const target = buildAndroidConnectionServiceTarget(host);
  const socket = new AndroidConnectionServiceTransportSocket(target, sessionName);
  void socket.start().then(() => sendAndroidConnectionCommand({
    type: 'bind-target',
    target,
  }));
  return socket;
}
