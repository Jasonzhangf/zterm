/**
 * Typed control-plane commands accepted by AndroidConnectionService.
 *
 * These are service IPC values, never terminal business payload or wire frame
 * metadata. The UI may change connection behavior only through these commands.
 */

export type AndroidConnectionServiceRoutePath =
  | 'lan'
  | 'tailscale'
  | 'ipv4'
  | 'ipv6'
  | 'rtc-direct'
  | 'rtc-relay';

export interface AndroidConnectionServiceManualRoutePolicy {
  mode: 'manual';
  path: AndroidConnectionServiceRoutePath;
}

export interface AndroidConnectionServiceAutoRoutePolicy {
  mode: 'auto';
}

export type AndroidConnectionServiceRoutePolicy =
  | AndroidConnectionServiceManualRoutePolicy
  | AndroidConnectionServiceAutoRoutePolicy;

export interface AndroidConnectionServiceTarget {
  targetKey: string;
  bridgeHost: string;
  bridgePort: number;
  lanHost?: string;
  authToken?: string;
  daemonHostId?: string;
  relayHostId?: string;
  tailscaleHost?: string;
  ipv6Host?: string;
  ipv4Host?: string;
  signalUrl?: string;
}

export type AndroidConnectionCommand =
  | {
      type: 'set-manual-route-policy';
      policy: AndroidConnectionServiceRoutePolicy;
    }
  | {
      type: 'bind-target';
      target: AndroidConnectionServiceTarget;
    }
  | {
      type: 'release-target';
      targetKey: string;
      reason: string;
    }
  | {
      type: 'open-channel';
      targetKey: string;
      channelId: string;
      sessionName: string;
      options?: Record<string, unknown>;
    }
  | {
      type: 'channel-message';
      targetKey: string;
      channelId: string;
      message: Record<string, unknown>;
    }
  | {
      type: 'channel-binary';
      targetKey: string;
      channelId: string;
      dataBase64: string;
    }
  | {
      type: 'close-channel';
      targetKey: string;
      channelId: string;
      reason: string;
    }
  | {
      type: 'pulse-session-notification';
      targetKey: string;
      channelId: string;
    }
  | {
      type: 'target-message';
      targetKey: string;
      requestId?: string;
      message: Record<string, unknown>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseRoutePolicy(value: unknown): AndroidConnectionServiceRoutePolicy {
  if (!isRecord(value)) {
    throw new Error('invalid Android connection service route policy');
  }
  if (value.mode === 'auto') {
    return { mode: 'auto' };
  }
  if (value.mode === 'manual') {
    const path = value.path;
    if (
      path === 'lan'
      || path === 'tailscale'
      || path === 'ipv4'
      || path === 'ipv6'
      || path === 'rtc-direct'
      || path === 'rtc-relay'
    ) {
      return { mode: 'manual', path };
    }
  }
  throw new Error('invalid Android connection service route policy');
}

function parseTarget(value: unknown): AndroidConnectionServiceTarget {
  if (!isRecord(value) || !isNonEmptyString(value.targetKey) || !isNonEmptyString(value.bridgeHost)) {
    throw new Error('invalid Android connection service target');
  }
  const bridgePort = value.bridgePort;
  if (!isFiniteNumber(bridgePort) || bridgePort <= 0 || bridgePort > 65535 || !Number.isInteger(bridgePort)) {
    throw new Error('invalid Android connection service target port');
  }
  const optionalString = (candidate: unknown) => (
    typeof candidate === 'string' && candidate.trim() ? candidate : undefined
  );
  return {
    targetKey: value.targetKey.trim(),
    bridgeHost: value.bridgeHost.trim(),
    bridgePort,
    ...(optionalString(value.lanHost) ? { lanHost: optionalString(value.lanHost) } : {}),
    ...(optionalString(value.authToken) ? { authToken: optionalString(value.authToken) } : {}),
    ...(optionalString(value.daemonHostId) ? { daemonHostId: optionalString(value.daemonHostId) } : {}),
    ...(optionalString(value.relayHostId) ? { relayHostId: optionalString(value.relayHostId) } : {}),
    ...(optionalString(value.tailscaleHost) ? { tailscaleHost: optionalString(value.tailscaleHost) } : {}),
    ...(optionalString(value.ipv6Host) ? { ipv6Host: optionalString(value.ipv6Host) } : {}),
    ...(optionalString(value.ipv4Host) ? { ipv4Host: optionalString(value.ipv4Host) } : {}),
    ...(optionalString(value.signalUrl) ? { signalUrl: optionalString(value.signalUrl) } : {}),
  };
}

export function parseAndroidConnectionCommand(value: unknown): AndroidConnectionCommand {
  if (!isRecord(value)) {
    throw new Error('invalid Android connection service command');
  }
  switch (value.type) {
    case 'set-manual-route-policy':
      return {
        type: 'set-manual-route-policy',
        policy: parseRoutePolicy(value.policy),
      };
    case 'bind-target':
      return {
        type: 'bind-target',
        target: parseTarget(value.target),
      };
    case 'release-target':
      if (!isNonEmptyString(value.targetKey) || !isNonEmptyString(value.reason)) {
        throw new Error('invalid Android connection service release target');
      }
      return {
        type: 'release-target',
        targetKey: value.targetKey.trim(),
        reason: value.reason.trim(),
      };
    case 'open-channel':
      if (!isNonEmptyString(value.targetKey) || !isNonEmptyString(value.channelId) || !isNonEmptyString(value.sessionName)) {
        throw new Error('invalid Android connection service channel open command');
      }
      return {
        type: 'open-channel',
        targetKey: value.targetKey.trim(),
        channelId: value.channelId.trim(),
        sessionName: value.sessionName.trim(),
        ...(isRecord(value.options) ? { options: value.options } : {}),
      };
    case 'channel-message':
      if (!isNonEmptyString(value.targetKey) || !isNonEmptyString(value.channelId) || !isRecord(value.message)) {
        throw new Error('invalid Android connection service channel message command');
      }
      return {
        type: 'channel-message',
        targetKey: value.targetKey.trim(),
        channelId: value.channelId.trim(),
        message: value.message,
      };
    case 'channel-binary':
      if (!isNonEmptyString(value.targetKey) || !isNonEmptyString(value.channelId) || !isNonEmptyString(value.dataBase64)) {
        throw new Error('invalid Android connection service channel binary command');
      }
      return {
        type: 'channel-binary',
        targetKey: value.targetKey.trim(),
        channelId: value.channelId.trim(),
        dataBase64: value.dataBase64,
      };
    case 'close-channel':
      if (!isNonEmptyString(value.targetKey) || !isNonEmptyString(value.channelId) || !isNonEmptyString(value.reason)) {
        throw new Error('invalid Android connection service channel close command');
      }
      return {
        type: 'close-channel',
        targetKey: value.targetKey.trim(),
        channelId: value.channelId.trim(),
        reason: value.reason.trim(),
      };
    case 'target-message':
      if (!isNonEmptyString(value.targetKey) || !isRecord(value.message)) {
        throw new Error('invalid Android connection service target message command');
      }
      return {
        type: 'target-message',
        targetKey: value.targetKey.trim(),
        ...(isNonEmptyString(value.requestId) ? { requestId: value.requestId.trim() } : {}),
        message: value.message,
      };
    case 'pulse-session-notification':
      if (!isNonEmptyString(value.targetKey) || !isNonEmptyString(value.channelId)) {
        throw new Error('invalid Android connection service notification pulse command');
      }
      return {
        type: 'pulse-session-notification',
        targetKey: value.targetKey.trim(),
        channelId: value.channelId.trim(),
      };
    default:
      throw new Error(`unsupported Android connection service command: ${String(value.type)}`);
  }
}
