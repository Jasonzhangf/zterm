import {
  sendAndroidConnectionCommand,
} from '../plugins/AndroidConnectionServicePlugin';
import type { Host } from './types';
import { buildTransportTargetKey } from './session-transport-runtime';
import { AndroidConnectionServiceTransportSocket } from './android-connection-service-socket';
import type { AndroidConnectionServiceTarget } from './android-connection-service-commands';
import type { BridgeTransportSocket } from './traversal/types';
import { runDagpipePhase8Connection } from './dagpipe-native-client';

export function buildAndroidConnectionServiceTarget(host: Host): AndroidConnectionServiceTarget {
  return {
    targetKey: buildTransportTargetKey(host),
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    ...(host.relayEndpointCandidates?.find((candidate) => candidate.kind === 'lan' && candidate.host)?.host
      ? { lanHost: host.relayEndpointCandidates.find((candidate) => candidate.kind === 'lan' && candidate.host)?.host }
      : {}),
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
): BridgeTransportSocket {
  const target = buildAndroidConnectionServiceTarget(host);
  const socket = new AndroidConnectionServiceTransportSocket(target);
  const startup = socket.start();
  startup.then(
    async () => {
      try {
        const validated = await runDagpipePhase8Connection({
          execution_id: 'android-connection-service-bind',
          attempt_id: '1',
          inputs: {
            'arc.service_command': { type: 'bind-target', target },
            'arc.service_policy': {
              allowTransport: true,
              allowReconnect: true,
              allowNotifications: true,
              maxNotificationActions: 3,
              maxReplayChannels: 3,
            },
            'arc.network_generation_event': { generation: 'local-probe' },
            'arc.notification_action': {},
            'arc.session_activity_fact': {},
          },
        });
        if (!validated.ok) {
          socket.reportFailure('bind-target rejected by dagpipe connection service gate');
          return;
        }
        const result = await sendAndroidConnectionCommand({ type: 'bind-target', target });
        if (!result?.ok) socket.reportFailure('bind-target rejected by connection service');
      } catch (error) {
        socket.reportFailure(`bind-target rejected: ${String(error instanceof Error ? error.message : error)}`);
      }
    },
    (error) => socket.reportFailure(`connection service startup failed: ${String(error instanceof Error ? error.message : error)}`),
  );
  return socket;
}
