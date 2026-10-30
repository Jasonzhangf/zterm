import {
  sendAndroidConnectionCommand,
} from '../plugins/AndroidConnectionServicePlugin';
import type { Host } from './types';
import { buildTransportTargetKey } from './session-transport-runtime';
import { AndroidConnectionServiceTransportSocket } from './android-connection-service-socket';
import type { AndroidConnectionServiceTarget } from './android-connection-service-commands';
import type { AndroidConnectionServiceSnapshot } from './android-connection-service-snapshot';
import type { BridgeSettings } from './bridge-settings';
import {
  defaultClientControlDirectoryRuntime,
  mergeHostWithClientControlDirectory,
} from './client-control-directory-runtime';
import type { BridgeTransportSocket } from './traversal/types';
import { isLikelyTailscaleHost, isPrivateLanIpv4Host, parseEndpointHost } from './network-target';
import {
  runDagpipeBufferManagement,
  runDagpipeBufferRender,
  runDagpipeConnection,
  runDagpipeInputDispatch,
  runDagpipePhase8Connection,
} from './dagpipe-native-client';

export type AndroidConnectionServiceTraversalSettings = Partial<Pick<
  BridgeSettings,
  'signalUrl' | 'turnServerUrl' | 'turnUsername' | 'turnCredential' | 'traversalRelay'
>>;

export function buildAndroidConnectionServiceTarget(
  rawHost: Host,
  settings?: AndroidConnectionServiceTraversalSettings,
): AndroidConnectionServiceTarget {
  const host = mergeHostWithClientControlDirectory(
    rawHost,
    defaultClientControlDirectoryRuntime,
  );
  const confirmedRelaySettings = defaultClientControlDirectoryRuntime.readRelaySettings();
  const traversalRelay = settings?.traversalRelay || confirmedRelaySettings || undefined;
  const turnUrl = traversalRelay?.turnUrl?.trim() || settings?.turnServerUrl?.trim() || '';
  const turnUsername = traversalRelay?.turnUsername?.trim() || settings?.turnUsername?.trim() || '';
  const turnCredential = traversalRelay?.turnCredential || settings?.turnCredential || '';
  const signalUrl = host.signalUrl?.trim()
    || traversalRelay?.wsClientUrl?.trim()
    || settings?.signalUrl?.trim()
    || '';
  const signalFromRelay = Boolean(traversalRelay?.wsClientUrl?.trim())
    && !host.signalUrl?.trim();
  const signalToken = signalFromRelay
    ? traversalRelay?.accessToken?.trim() || ''
    : '';
  const relayDeviceId = traversalRelay?.deviceId?.trim()
    || host.relayDeviceId?.trim()
    || '';
  const directoryLanHosts = (host.relayEndpointCandidates || [])
    .filter((candidate) => candidate.kind === 'lan' && candidate.host?.trim())
    .map((candidate) => candidate.host!.trim());
  const bridgeLanHost = isPrivateLanIpv4Host(parseEndpointHost(host.bridgeHost))
    ? host.bridgeHost.trim()
    : '';
  const lanHosts = [...new Set([
    ...directoryLanHosts,
    ...(bridgeLanHost ? [bridgeLanHost] : []),
  ])];
  const directoryLanHost = lanHosts[0] || '';
  const directoryTailscaleHost = host.relayEndpointCandidates
    ?.find((candidate) => candidate.kind === 'tailscale' && candidate.host?.trim())?.host?.trim() || '';
  const directoryIpv6Host = host.relayEndpointCandidates
    ?.find((candidate) => candidate.kind === 'ipv6' && candidate.host?.trim())?.host?.trim() || '';
  const directoryIpv4Host = host.relayEndpointCandidates
    ?.find((candidate) => candidate.kind === 'ipv4' && candidate.host?.trim())?.host?.trim() || '';
  const tailscaleHost = host.tailscaleHost?.trim() || directoryTailscaleHost;
  const ipv6Host = host.ipv6Host?.trim() || directoryIpv6Host;
  const ipv4Host = host.ipv4Host?.trim() || directoryIpv4Host;
  return {
    targetKey: buildTransportTargetKey(host),
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    ...((directoryLanHost || bridgeLanHost)
      ? { lanHost: directoryLanHost || bridgeLanHost }
      : {}),
    ...(lanHosts.length > 0 ? { lanHosts } : {}),
    ...(host.authToken ? { authToken: host.authToken } : {}),
    ...(host.daemonHostId ? { daemonHostId: host.daemonHostId } : {}),
    ...(host.relayHostId ? { relayHostId: host.relayHostId } : {}),
    ...(tailscaleHost ? { tailscaleHost } : {}),
    ...(ipv6Host ? { ipv6Host } : {}),
    ...(ipv4Host ? { ipv4Host } : {}),
    ...(signalUrl ? { signalUrl } : {}),
    ...(signalToken ? { signalToken } : {}),
    ...(signalFromRelay ? { signalUrlFromRelay: true } : {}),
    ...(relayDeviceId ? { relayDeviceId } : {}),
    ...(turnUrl ? { turnUrl } : {}),
    ...(turnUsername ? { turnUsername } : {}),
    ...(turnCredential ? { turnCredential } : {}),
  };
}

export type AndroidConnectionServiceSocketOpenMode = 'bind' | 'reattach';

export function openAndroidConnectionServiceTransportSocket(
  host: Host,
  settings?: AndroidConnectionServiceTraversalSettings,
  openOptions?: { mode?: AndroidConnectionServiceSocketOpenMode },
): BridgeTransportSocket {
  const target = buildAndroidConnectionServiceTarget(host, settings);
  const socket = new AndroidConnectionServiceTransportSocket(target);
  const mode: AndroidConnectionServiceSocketOpenMode = openOptions?.mode === 'reattach'
    ? 'reattach'
    : 'bind';
  const startup = socket.start();
  startup.then(
    async (snapshot) => {
      try {
        // Reattach-only opens re-project an already-bound native target. The
        // native service remains the transport owner, so resume must not send a
        // fresh `bind-target` that would create a new generation. Only bind when
        // the native service explicitly reports no live target for this key; a
        // snapshot read failure is never treated as "no target".
        if (mode === 'reattach' && !shouldBindAfterReattach(snapshot, target.targetKey)) {
          return;
        }
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
                  path: resolveRoutePlanPath(host),
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
                pathPriority: ['LAN', 'Tailscale', 'IPv6', 'IPv4', 'Relay'],
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

export function resolveRoutePlanPath(host: Host): 'LAN' | 'Tailscale' | 'IPv6' | 'IPv4' {
  const bridge = host.bridgeHost?.trim() || '';
  if (isLikelyTailscaleHost(bridge)) {
    return 'Tailscale';
  }
  if (isPrivateLanIpv4Host(parseEndpointHost(bridge))) {
    return 'LAN';
  }
  if (bridge.includes(':') && !bridge.includes('.')) {
    return 'IPv6';
  }
  return 'IPv4';
}

/**
 * Decide whether a reattach-only open must still send `bind-target`. A resume
 * that finds the native target still present (OPEN / connecting / backoff /
 * any state with a target) must reuse the existing native generation and must
 * NOT issue a fresh bind that would create a new one. The native owner owns
 * binding and reconnection, so JS never binds on resume.
 *
 * Only a snapshot whose target no longer matches this key (the native service
 * explicitly holds no such target) proceeds with bind. A null/unknown snapshot
 * never does, so a read failure is never treated as "no target".
 */
function shouldBindAfterReattach(
  snapshot: AndroidConnectionServiceSnapshot | null,
  targetKey: string,
): boolean {
  if (!snapshot) {
    // Unknown: a snapshot read failure is not evidence that the target is
    // gone. Never fall back to a fresh bind from an unknown state.
    return false;
  }
  if (snapshot.target?.targetKey !== targetKey) {
    return true;
  }
  return false;
}
