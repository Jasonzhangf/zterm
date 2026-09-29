import {
  sendAndroidConnectionCommand,
} from '../plugins/AndroidConnectionServicePlugin';
import type { Host } from './types';
import { buildTransportTargetKey } from './session-transport-runtime';
import { AndroidConnectionServiceTransportSocket } from './android-connection-service-socket';
import type { AndroidConnectionServiceTarget } from './android-connection-service-commands';
import type { BridgeSettings } from './bridge-settings';
import type { BridgeTransportSocket } from './traversal/types';
import { isPrivateLanIpv4Host, parseEndpointHost } from './network-target';
import {
  runDagpipeBufferManagement,
  runDagpipeBufferRender,
  runDagpipeConnection,
  runDagpipeInputDispatch,
  runDagpipePhase8Connection,
} from './dagpipe-native-client';

export type AndroidConnectionServiceTraversalSettings = Pick<
  BridgeSettings,
  'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'traversalRelay'
>;

export function buildAndroidConnectionServiceTarget(
  host: Host,
  settings?: AndroidConnectionServiceTraversalSettings,
): AndroidConnectionServiceTarget {
  const turnUrl = settings?.traversalRelay?.turnUrl?.trim() || settings?.turnServerUrl?.trim() || '';
  const turnUsername = settings?.traversalRelay?.turnUsername?.trim() || settings?.turnUsername?.trim() || '';
  const turnCredential = settings?.traversalRelay?.turnCredential || settings?.turnCredential || '';
  const signalUrl = host.signalUrl?.trim()
    || settings?.traversalRelay?.wsClientUrl?.trim()
    || settings?.signalUrl?.trim()
    || '';
  const signalFromRelay = Boolean(settings?.traversalRelay?.wsClientUrl?.trim())
    && !host.signalUrl?.trim();
  const signalToken = signalFromRelay
    ? settings?.traversalRelay?.accessToken?.trim() || ''
    : '';
  const relayDeviceId = host.relayDeviceId?.trim()
    || settings?.traversalRelay?.deviceId?.trim()
    || '';
  const directoryLanHost = host.relayEndpointCandidates
    ?.find((candidate) => candidate.kind === 'lan' && candidate.host)?.host;
  const bridgeLanHost = isPrivateLanIpv4Host(parseEndpointHost(host.bridgeHost))
    ? host.bridgeHost
    : '';
  return {
    targetKey: buildTransportTargetKey(host),
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    ...((directoryLanHost || bridgeLanHost)
      ? { lanHost: directoryLanHost || bridgeLanHost }
      : {}),
    ...(host.authToken ? { authToken: host.authToken } : {}),
    ...(host.daemonHostId ? { daemonHostId: host.daemonHostId } : {}),
    ...(host.relayHostId ? { relayHostId: host.relayHostId } : {}),
    ...(host.tailscaleHost ? { tailscaleHost: host.tailscaleHost } : {}),
    ...(host.ipv6Host ? { ipv6Host: host.ipv6Host } : {}),
    ...(host.ipv4Host ? { ipv4Host: host.ipv4Host } : {}),
    ...(signalUrl ? { signalUrl } : {}),
    ...(signalToken ? { signalToken } : {}),
    ...(signalFromRelay ? { signalUrlFromRelay: true } : {}),
    ...(relayDeviceId ? { relayDeviceId } : {}),
    ...(turnUrl ? { turnUrl } : {}),
    ...(turnUsername ? { turnUsername } : {}),
    ...(turnCredential ? { turnCredential } : {}),
  };
}

export function openAndroidConnectionServiceTransportSocket(
  host: Host,
  settings?: AndroidConnectionServiceTraversalSettings,
): BridgeTransportSocket {
  const target = buildAndroidConnectionServiceTarget(host, settings);
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
              'arc.route_plan': {
                selected: {
                  candidateId: target.targetKey,
                  id: target.targetKey,
                  path: host.relayHostId ? 'Relay' : 'LAN',
                  endpoint: `${host.bridgeHost}:${host.bridgePort}`,
                },
              },
              'arc.resume_plan': {
                targetKey: target.targetKey,
                state: 'ready',
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
