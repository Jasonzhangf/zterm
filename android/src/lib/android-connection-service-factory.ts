import {
  sendAndroidConnectionCommand,
} from '../plugins/AndroidConnectionServicePlugin';
import type { Host } from './types';
import { buildTransportTargetKey } from './session-transport-runtime';
import { AndroidConnectionServiceTransportSocket } from './android-connection-service-socket';
import type { AndroidConnectionServiceTarget } from './android-connection-service-commands';
import type { BridgeTransportSocket } from './traversal/types';
import {
  runDagpipeBufferManagement,
  runDagpipeBufferRender,
  runDagpipeConnection,
  runDagpipeInputDispatch,
  runDagpipePhase8Connection,
} from './dagpipe-native-client';

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
        // Connection-service startup-only admission gates. They are not owner
        // wiring for client.buffer_store / client.renderer_window /
        // client.input_runtime; those graphs keep their owning runtime entries.
        const admissionGates = await Promise.all([
          runDagpipeConnection({
            execution_id: 'android-connection-lifecycle',
            attempt_id: '1',
            inputs: {
              'arc.account_credentials': {
                accountId: host.daemonHostId || host.relayHostId || 'client',
                authToken: host.authToken || '',
              },
              'arc.relay_settings': {
                relayEnabled: Boolean(host.relayHostId || host.relayEndpointCandidates?.length),
              },
              'arc.target_candidates': {
                candidates: [{
                  id: target.targetKey,
                  path: host.relayHostId ? 'Relay' : 'LAN',
                  endpoint: `${host.bridgeHost}:${host.bridgePort}`,
                }],
              },
              'arc.session_demand_set': {
                sessions: [{
                  sessionId: host.sessionName || 'default',
                  sessionName: host.sessionName || 'default',
                  mode: 'active',
                }],
              },
              'arc.connection_policy': {
                pathPriority: ['LAN', 'UDP direct', 'Tailscale', 'Relay'],
                expectedGeneration: 1,
              },
            },
          }),
          runDagpipeBufferManagement({
            execution_id: 'android-buffer-management',
            attempt_id: '1',
            inputs: {
              'arc.daemon_head_facts': {
                sessions: [{
                  sessionId: host.sessionName || 'default',
                  revision: 0,
                  latestEndIndex: 0,
                }],
              },
              'arc.session_buffer_demand': {
                sessions: [{
                  sessionId: host.sessionName || 'default',
                  mode: 'active',
                  viewportRows: 24,
                }],
              },
              'arc.local_buffer_state': {
                sessions: [{
                  sessionId: host.sessionName || 'default',
                  revision: 0,
                  startIndex: 0,
                  endIndex: 0,
                  gapRanges: [],
                }],
              },
              'arc.buffer_policy': { cacheLines: 100 },
            },
          }),
          runDagpipeBufferRender({
            execution_id: 'android-buffer-render',
            attempt_id: '1',
            inputs: {
              'arc.daemon_wire_frame': {
                revision: 0,
                startIndex: 0,
                endIndex: 0,
                rows: 24,
                cols: 80,
                lines: [],
                cursor: null,
                cursorKeysApp: false,
              },
              'arc.visible_range_demand': { startIndex: 0, endIndex: 0 },
              'arc.local_sparse_state': {
                revision: 0,
                startIndex: 0,
                endIndex: 0,
                gapRanges: [],
              },
              'arc.buffer_policy': {},
            },
          }),
          runDagpipeInputDispatch({
            execution_id: 'android-input-dispatch',
            attempt_id: '1',
            inputs: {
              'arc.committed_text': { text: '' },
              'arc.input_policy': { chunkBytes: 64, maxInFlight: 8 },
              'arc.transport_facts': { state: 'not-ready', bufferedBytes: 0 },
            },
          }),
        ]);
        for (const admission of admissionGates) {
          if (!admission.ok) {
            socket.reportFailure(`dagpipe client admission rejected: ${admission.error}`);
            return;
          }
        }
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
